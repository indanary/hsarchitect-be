const express = require("express")
const path = require("path")
const fs = require("fs")
const fsp = fs.promises
const multer = require("multer")
const {pool} = require("../db")
const {requireAdmin} = require("../middleware/requireAdmin")
const {uploadMemory} = require("../storage/multerMemory")
const {
	supabaseAdmin,
	bucket,
	objectKeyForProject,
	toPublicFileUrl,
} = require("../storage/supabase")
const sharp = require("sharp")

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
function toPublicUrl(filePath) {
	if (!filePath) return null
	return `${process.env.PUBLIC_BASE_URL}${filePath}`
}
// helper to generate base key (no extension)
function baseKey(projectId, originalName) {
	const name = (originalName || "image")
		.replace(/\.[^.]+$/, "")
		.replace(/\s+/g, "-")
	return `projects/${projectId}/${Date.now()}-${name}`
}
// turn "projects/2/123-foo@1600w.webp" -> "...@800w.webp"
function variantKeyFromMain(mainKey, width) {
	return mainKey.replace(/@(\d+)w\.webp$/, `@${width}w.webp`)
}

/* ========== PUBLIC READS (optional) ========== */

// GET /projects/public
r.get("/public", async (req, res) => {
	const typeId = Number.isFinite(+req.query.project_type_id)
		? +req.query.project_type_id
		: null
	const qRaw = (req.query.q ?? "").toString().trim()
	const q = qRaw.length ? `%${qRaw}%` : null

	const cond = []
	const params = []

	if (typeId) {
		cond.push(`p.project_type_id = ?`)
		params.push(typeId)
	}
	if (q) {
		cond.push(`(p.title LIKE ? OR p.location LIKE ? OR p.scope LIKE ?)`)
		params.push(q, q, q)
	}

	const where = cond.length ? `WHERE ${cond.join(" AND ")}` : ""

	const sql = `
    WITH ranked_images AS (
      SELECT
        pi.project_id,
        pi.id        AS cover_image_id,
        pi.file_path AS cover_file_path,
        pi.alt       AS cover_alt,
        ROW_NUMBER() OVER (
          PARTITION BY pi.project_id
          ORDER BY pi.sort_order ASC, pi.id ASC
        ) AS rn
      FROM project_images pi
    )
    SELECT
      p.id, p.title, p.location, p.project_type_id, p.scope, p.year, p.status, p.area,
      ri.cover_image_id, ri.cover_file_path, ri.cover_alt
    FROM projects p
    LEFT JOIN ranked_images ri
      ON ri.project_id = p.id AND ri.rn = 1
    ${where}
    ORDER BY p.created_at DESC
    LIMIT 100
  `

	try {
		const [rows] = await pool.execute(sql, params)

		const data = rows.map((r) => ({
			...r,
			// CHANGE: use Supabase public URL from object key
			cover_url: r.cover_file_path
				? toPublicFileUrl(r.cover_file_path)
				: null,
		}))

		res.json(data)
	} catch (err) {
		console.error("GET /projects/public error:", err)
		res.status(500).json({error: "internal_error"})
	}
})

/** GET /public/projects/:id (published project + ordered images) */
r.get("/public/:id", async (req, res) => {
	const id = toInt(req.params.id)
	if (!id) return res.status(400).json({error: "invalid id"})

	// 1) fetch project (only published)
	const [rows] = await pool.execute(
		`SELECT id, title, location, description, project_type_id, scope, year, status, area
     FROM projects
     WHERE id = ?
     LIMIT 1`,
		[id],
	)
	const project = rows[0]
	if (!project) return res.status(404).json({error: "not found"})

	// 2) fetch ordered images
	const [imgs] = await pool.execute(
		`SELECT id, file_path, alt, sort_order
     FROM project_images
     WHERE project_id = ?
     ORDER BY sort_order ASC, id ASC`,
		[id],
	)

	// 3) map to include absolute URL for direct rendering on FE
	const images = imgs.map((img) => {
		const file_url = img.file_path ? toPublicFileUrl(img.file_path) : null
		const thumb_url = img.file_path
			? toPublicFileUrl(variantKeyFromMain(img.file_path, 800))
			: null
		return {...img, file_url, thumb_url}
	})

	// 4) respond
	res.json({
		...project,
		images, // array of { id, file_path, file_url, alt, sort_order }
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

/** GET /admin/projects/:id (detail including images) */
r.get("/admin/:id", async (req, res) => {
	const id = toInt(req.params.id)
	if (!id) return res.status(400).json({error: "invalid id"})

	const [rows] = await pool.execute(
		`SELECT id, title, location, description, project_type_id, scope, year, status, area
     FROM projects WHERE id = ? LIMIT 1`,
		[id],
	)
	const project = rows[0]
	if (!project) return res.status(404).json({error: "not found"})

	const [imgs] = await pool.execute(
		`SELECT id, file_path, alt, sort_order FROM project_images WHERE project_id = ? ORDER BY sort_order ASC, id ASC`,
		[id],
	)
	project.images = imgs.map((img) => ({
		...img,
		file_url: img.file_path ? toPublicFileUrl(img.file_path) : null,
	}))
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
			trimOrNull(status) || "draft",
			trimOrNull(area),
		],
	)

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

	res.status(204).end()
})

/* ========== IMAGE UPLOADS ========== */

/** Multer setup (store in /uploads/projects/<projectId>/) */
// const storage = multer.diskStorage({
// 	destination: async (req, file, cb) => {
// 		const projectId = toInt(req.params.id)
// 		const dest = path.join(
// 			__dirname,
// 			"..",
// 			"..",
// 			"uploads",
// 			"projects",
// 			String(projectId),
// 		)
// 		await fsp.mkdir(dest, {recursive: true})
// 		cb(null, dest)
// 	},
// 	filename: (_req, file, cb) => {
// 		// add timestamp prefix to avoid collisions
// 		const ext = path.extname(file.originalname)
// 		const base = path.basename(file.originalname, ext).replace(/\s+/g, "-")
// 		cb(null, `${Date.now()}-${base}${ext}`)
// 	},
// })
// const upload = multer({storage})

/** POST /admin/projects/:id/images  (multipart form: files[]; alt?, sort_order?) */
r.post(
	"/admin/:id/images",
	uploadMemory.array("files", 10),
	async (req, res) => {
		const projectId = toInt(req.params.id)
		if (!projectId) return res.status(400).json({error: "invalid id"})
		if (!req.files?.length)
			return res.status(400).json({error: "no files uploaded"})

		try {
			const rows = []
			const uploaded = [] // for response (with URLs)

			for (const f of req.files) {
				const base = baseKey(projectId, f.originalname)

				// 1) Generate 1600w WEBP (detail)
				const buf1600 = await sharp(f.buffer)
					.rotate() // respect EXIF orientation
					.resize({width: 1600, withoutEnlargement: true})
					.webp({quality: 78})
					.toBuffer()

				const key1600 = `${base}@1600w.webp`
				const up1 = await supabaseAdmin.storage
					.from(bucket)
					.upload(key1600, buf1600, {
						contentType: "image/webp",
						cacheControl: "31536000, immutable",
						upsert: false,
					})
				if (up1.error) throw up1.error

				// 2) Generate 800w WEBP (thumb/grid)
				const buf800 = await sharp(f.buffer)
					.rotate()
					.resize({width: 800, withoutEnlargement: true})
					.webp({quality: 78})
					.toBuffer()

				const key800 = `${base}@800w.webp`
				const up2 = await supabaseAdmin.storage
					.from(bucket)
					.upload(key800, buf800, {
						contentType: "image/webp",
						cacheControl: "31536000, immutable",
						upsert: false,
					})
				if (up2.error) throw up2.error

				// Store only the main (1600w) in DB — schema unchanged
				rows.push([projectId, key1600, null, 0])

				uploaded.push({
					file_path: key1600,
					file_url: toPublicFileUrl(key1600),
					thumb_url: toPublicFileUrl(key800), // not stored in DB, handy for FE
				})
			}

			await pool.query(
				`INSERT INTO project_images (project_id, file_path, alt, sort_order) VALUES ?`,
				[rows],
			)

			res.status(201).json(uploaded)
		} catch (e) {
			console.error("upload optimize error:", e)
			res.status(500).json({error: "upload_failed"})
		}
	},
)

/** PATCH /admin/projects/:id/images/:imageId  (alt, sort_order) */
r.patch("/admin/:id/images/:imageId", async (req, res) => {
	const projectId = toInt(req.params.id)
	const imageId = toInt(req.params.imageId)
	if (!projectId || !imageId)
		return res.status(400).json({error: "invalid id"})

	const sets = []
	const params = []
	if (Object.prototype.hasOwnProperty.call(req.body, "alt")) {
		sets.push("alt = ?")
		params.push(trimOrNull(req.body.alt))
	}
	if (Object.prototype.hasOwnProperty.call(req.body, "sort_order")) {
		sets.push("sort_order = ?")
		params.push(toInt(req.body.sort_order, 0))
	}
	if (!sets.length) return res.status(400).json({error: "nothing to update"})

	params.push(projectId, imageId)
	const [result] = await pool.execute(
		`UPDATE project_images SET ${sets.join(
			", ",
		)} WHERE project_id = ? AND id = ?`,
		params,
	)
	if (result.affectedRows === 0)
		return res.status(404).json({error: "not found"})
	res.status(204).end()
})

/** DELETE /admin/projects/:id/images/:imageId  (remove from DB and storage) */
r.delete("/admin/:id/images/:imageId", async (req, res) => {
	const projectId = toInt(req.params.id)
	const imageId = toInt(req.params.imageId)
	if (!projectId || !imageId)
		return res.status(400).json({error: "invalid id"})

	// 1) read current key
	const [[img]] = await pool.query(
		`SELECT file_path FROM project_images WHERE project_id = ? AND id = ? LIMIT 1`,
		[projectId, imageId],
	)

	// 2) delete DB row
	const [result] = await pool.execute(
		`DELETE FROM project_images WHERE project_id = ? AND id = ?`,
		[projectId, imageId],
	)
	if (result.affectedRows === 0)
		return res.status(404).json({error: "not found"})

	// 3) delete object from Supabase (ignore errors)
	if (img && img.file_path) {
		const key1600 = img.file_path
		const key800 = variantKeyFromMain(key1600, 800)
		await supabaseAdmin.storage
			.from(bucket)
			.remove([key1600, key800])
			.catch(() => {})
	}

	res.status(204).end()
})

module.exports = r
