const express = require("express")
const path = require("path")
const fs = require("fs")
const fsp = fs.promises
const {pool} = require("../db")
const {requireAdmin} = require("../middleware/requireAdmin")
const {toPublicFileUrl, toPublicTransformedUrl} = require("../storage/supabase")
const {queueRebuild} = require("../utils/rebuild")

const r = express.Router()

/* ========== HELPERS ========== */
function toInt(v, fallback = null) {
	const n = Number(v)
	return Number.isFinite(n) ? n : fallback
}
function trimOrNull(v) {
	if (v === undefined || v === null) return null
	const s = String(v).trim()
	return s.length ? s : null
}
// turn "projects/2/123-foo@1600w.webp" -> "...@800w.webp"
function variantKeyFromMain(mainKey, width) {
	return mainKey.replace(/@(\d+)w\.webp$/, `@${width}w.webp`)
}

/* ========== PUBLIC READS (optional) ========== */

// GET /projects/public
r.get("/public", async (req, res) => {
	const qRaw = (req.query.q ?? "").toString().trim()
	const q = qRaw.length ? `%${qRaw}%` : null

	const projectTypeId = req.query.project_type_id
		? String(req.query.project_type_id)
		: null

	const cond = []
	const params = []

	if (q) {
		cond.push(`LOWER(p.title) LIKE LOWER(?)`)
		params.push(q)
	}

	if (projectTypeId) {
		cond.push(`p.project_type_id = ?`)
		params.push(projectTypeId)
	}

	const where = cond.length ? `WHERE ${cond.join(" AND ")}` : ""

	const sql = `
    WITH ranked_images AS (
  SELECT
    pi.project_id,
    pi.file_path AS cover_file_path,
    ROW_NUMBER() OVER (
      PARTITION BY pi.project_id
      ORDER BY pi.sort_order ASC, pi.id ASC
    ) AS rn
  FROM project_images pi
),
media_union AS (
  -- legacy images
  SELECT
    pi.project_id,
    pi.id,
    CAST('image' AS CHAR CHARACTER SET utf8mb4) COLLATE utf8mb4_unicode_ci AS type,
    pi.file_path COLLATE utf8mb4_unicode_ci AS file_path,
    pi.alt COLLATE utf8mb4_unicode_ci AS alt,
    NULL AS thumb_path,
    NULL AS mime_type,
    NULL AS duration,
    pi.sort_order
  FROM project_images pi

  UNION ALL

  -- new media (images + videos)
  SELECT
    pm.project_id,
    pm.id,
    CAST(pm.type AS CHAR CHARACTER SET utf8mb4) COLLATE utf8mb4_unicode_ci AS type,
    pm.file_path COLLATE utf8mb4_unicode_ci AS file_path,
    pm.alt COLLATE utf8mb4_unicode_ci AS alt,
    pm.thumb_path COLLATE utf8mb4_unicode_ci AS thumb_path,
    pm.mime_type COLLATE utf8mb4_unicode_ci AS mime_type,
    pm.duration,
    pm.sort_order
  FROM project_media pm
),
media_ordered AS (
  SELECT *
  FROM media_union
  ORDER BY sort_order ASC, id ASC
)
SELECT
  p.id,
  p.title,
  p.location,
  p.project_type_id,
  p.scope,
  p.year,
  p.status,
  p.area,

  MAX(ri.cover_file_path) AS cover_file_path,

  JSON_ARRAYAGG(
    JSON_OBJECT(
      'id', mo.id,
      'type', mo.type,
      'file_path', mo.file_path,
      'alt', mo.alt,
      'thumb_path', mo.thumb_path,
      'mime_type', mo.mime_type,
      'duration', mo.duration,
      'sort_order', mo.sort_order
    )
  ) AS media
FROM projects p
LEFT JOIN ranked_images ri
  ON ri.project_id = p.id AND ri.rn = 1
LEFT JOIN media_ordered mo
  ON mo.project_id = p.id
${where}
GROUP BY p.id
ORDER BY p.created_at DESC
LIMIT 100
  `

	try {
		const [rows] = await pool.execute(sql, params)

		const data = rows.map((r) => {
			const media = Array.isArray(r.media)
				? r.media.map((m) => ({
						id: m.id,
						type: m.type,
						sort_order: m.sort_order,
						mime_type: m.mime_type,
						duration: m.duration,
						alt: m.alt ?? null,
						url: m.file_path ? toPublicFileUrl(m.file_path) : null,
						thumb_url: m.thumb_path
							? toPublicFileUrl(m.thumb_path)
							: m.file_path
							? toPublicFileUrl(m.file_path)
							: null,
				  }))
				: []

			return {
				id: r.id,
				title: r.title,
				location: r.location,
				project_type_id: r.project_type_id,
				scope: r.scope,
				year: r.year,
				status: r.status,
				area: r.area,

				// legacy cover
				cover_url: r.cover_file_path
					? toPublicFileUrl(r.cover_file_path)
					: null,

				// unified media
				media,
			}
		})

		res.json(data)
	} catch (err) {
		console.error("GET /projects/public error:", err)
		res.status(500).json({error: "internal_error"})
	}
})

/** GET /projects/public/:id (published project + ordered media) */
r.get("/public/:id", async (req, res) => {
	const id = toInt(req.params.id)
	if (!id) return res.status(400).json({error: "invalid id"})

	// 1) fetch project
	const [rows] = await pool.execute(
		`SELECT id, title, location, description, project_type_id, scope, year, status, area
     FROM projects
     WHERE id = ?
     LIMIT 1`,
		[id],
	)
	const project = rows[0]
	if (!project) return res.status(404).json({error: "not found"})

	// 2) fetch the project type label
	let project_type = null
	if (project.project_type_id) {
		const [types] = await pool.execute(
			`SELECT project_type FROM project_types WHERE id = ? LIMIT 1`,
			[project.project_type_id],
		)
		project_type = types[0]?.project_type || null
	}

	// 3) legacy images (KEEP for backward compatibility)
	const [imgs] = await pool.execute(
		`SELECT id, file_path, alt, sort_order
     FROM project_images
     WHERE project_id = ?
     ORDER BY sort_order ASC, id ASC`,
		[id],
	)

	const images = imgs.map((img) => {
		const file_url = img.file_path ? toPublicFileUrl(img.file_path) : null
		return {
			...img,
			file_url,
			thumb_url: file_url,
		}
	})

	// 4) unified media (images + videos)
	const [mediaRows] = await pool.execute(
		`
    SELECT
      pm.id,
      pm.type,
      pm.file_path,
      pm.alt,
      pm.thumb_path,
      pm.mime_type,
      pm.duration,
      pm.sort_order
    FROM project_media pm
    WHERE pm.project_id = ?
    ORDER BY pm.sort_order ASC, pm.id ASC
  `,
		[id],
	)

	const media = mediaRows.map((m) => ({
		id: m.id,
		type: m.type,
		sort_order: m.sort_order,
		mime_type: m.mime_type,
		duration: m.duration,
		alt: m.alt ?? null,
		url: m.file_path ? toPublicFileUrl(m.file_path) : null,
		thumb_url: m.thumb_path
			? toPublicFileUrl(m.thumb_path)
			: m.file_path
			? toPublicFileUrl(m.file_path)
			: null,
	}))

	// 5) derive cover from FIRST media item (image OR video poster)
	const cover = media[0]?.thumb_url || images[0]?.thumb_url || null

	// 6) respond (NON-BREAKING)
	res.json({
		...project,
		project_type,

		// legacy (unchanged)
		images,
		cover_url: cover,
		cover_thumb_url: cover,
		cover,

		// new unified media
		media,
	})
})

/* ========== ADMIN (protected) ========== */
r.use(requireAdmin)

/** GET /admin/projects (list with optional filters) */
r.get("/admin", async (req, res) => {
	const q = trimOrNull(req.query.q)
	const status = trimOrNull(req.query.status)
	const typeId = toInt(req.query.project_type_id)

	let sql = `SELECT id, title, location, project_type_id, scope, year, status, area
             FROM projects`
	const cond = []
	const params = []
	if (q) {
		cond.push(`(title LIKE ? OR location LIKE ? OR scope LIKE ?)`)
		params.push(`%${q}%`, `%${q}%`, `%${q}%`)
	}
	if (status) {
		cond.push(`status = ?`)
		params.push(status)
	}
	if (typeId) {
		cond.push(`project_type_id = ?`)
		params.push(typeId)
	}
	if (cond.length) sql += " WHERE " + cond.join(" AND ")
	sql += " ORDER BY created_at DESC LIMIT 200"

	const [rows] = await pool.execute(sql, params)
	res.json(rows)
})

/** GET /admin/projects/:id (detail including images + media) */
r.get("/admin/:id", async (req, res) => {
	const id = toInt(req.params.id)
	if (!id) return res.status(400).json({error: "invalid id"})

	// 1) fetch project
	const [rows] = await pool.execute(
		`SELECT id, title, location, description, project_type_id, scope, year, status, area
     FROM projects
     WHERE id = ?
     LIMIT 1`,
		[id],
	)
	const project = rows[0]
	if (!project) return res.status(404).json({error: "not found"})

	// 2) legacy images (KEEP for backward compatibility)
	const [imgs] = await pool.execute(
		`SELECT id, file_path, alt, sort_order
     FROM project_images
     WHERE project_id = ?
     ORDER BY sort_order ASC, id ASC`,
		[id],
	)

	project.images = imgs.map((img) => ({
		...img,
		file_url: img.file_path ? toPublicFileUrl(img.file_path) : null,
		thumb_url: img.file_path ? toPublicFileUrl(img.file_path) : null,
	}))

	// 3) unified media (images + videos)
	const [mediaRows] = await pool.execute(
		`
    SELECT
      id,
      type,
      file_path,
      alt,
      thumb_path,
      mime_type,
      duration,
      sort_order
    FROM project_media
    WHERE project_id = ?
    ORDER BY sort_order ASC, id ASC
  `,
		[id],
	)

	project.media = mediaRows.map((m) => ({
		id: m.id,
		type: m.type,
		sort_order: m.sort_order,
		mime_type: m.mime_type,
		duration: m.duration,
		alt: m.alt ?? null,
		file_url: m.file_path ? toPublicFileUrl(m.file_path) : null,
		thumb_url: m.thumb_path
			? toPublicFileUrl(m.thumb_path)
			: m.file_path
			? toPublicFileUrl(m.file_path)
			: null,
	}))

	// 4) respond
	res.json(project)
})

/** POST /admin/projects  (create) */
r.post("/admin", async (req, res) => {
	const {
		title,
		location,
		description, // HTML string (store as is, sanitize on FE render)
		project_type_id, // pass number (FK)
		scope,
		year,
		status, // 'draft' | 'published'
		area,
	} = req.body || {}

	if (!title || !String(title).trim()) {
		return res.status(400).json({error: "title is required"})
	}

	const [result] = await pool.execute(
		`INSERT INTO projects (title, location, description, project_type_id, scope, year, status, area)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
		[
			trimOrNull(title),
			trimOrNull(location),
			trimOrNull(description),
			toInt(project_type_id),
			trimOrNull(scope),
			toInt(year),
			trimOrNull(status) || "-",
			trimOrNull(area),
		],
	)

	queueRebuild(result.insertId)

	res.status(201).json({id: result.insertId})
})

/** PATCH /admin/projects/:id (update any fields) */
r.patch("/admin/:id", async (req, res) => {
	const id = toInt(req.params.id)
	if (!id) return res.status(400).json({error: "invalid id"})

	const allowed = [
		"title",
		"location",
		"description",
		"project_type_id",
		"scope",
		"year",
		"status",
		"area",
	]
	const sets = []
	const params = []

	for (const key of allowed) {
		if (Object.prototype.hasOwnProperty.call(req.body, key)) {
			if (key === "project_type_id" || key === "year") {
				sets.push(`${key} = ?`)
				params.push(toInt(req.body[key]))
			} else {
				sets.push(`${key} = ?`)
				params.push(trimOrNull(req.body[key]))
			}
		}
	}

	if (!sets.length) return res.status(400).json({error: "nothing to update"})

	const sql = `UPDATE projects SET ${sets.join(", ")} WHERE id = ?`
	params.push(id)

	const [result] = await pool.execute(sql, params)
	if (result.affectedRows === 0)
		return res.status(404).json({error: "not found"})

	queueRebuild(id)

	res.status(204).end()
})

/** DELETE /admin/projects/:id (also deletes images via FK cascade) */
r.delete("/admin/:id", async (req, res) => {
	const id = toInt(req.params.id)
	if (!id) return res.status(400).json({error: "invalid id"})

	// Optional: remove files from disk as well
	const [imgs] = await pool.execute(
		`SELECT file_path FROM project_images WHERE project_id = ?`,
		[id],
	)
	const [result] = await pool.execute(`DELETE FROM projects WHERE id = ?`, [
		id,
	])

	if (result.affectedRows === 0)
		return res.status(404).json({error: "not found"})

	// Cleanup files (ignore errors)
	for (const row of imgs) {
		const abs = path.join(
			__dirname,
			"..",
			"..",
			row.file_path.replace(/^\//, ""),
		)
		fsp.unlink(abs).catch(() => {})
	}

	queueRebuild(id)

	res.status(204).end()
})

module.exports = r
