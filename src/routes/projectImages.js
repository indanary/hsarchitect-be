// routes/projectImages.js
const express = require("express")
const sharp = require("sharp")
const Busboy = require("busboy")
const {pool} = require("../db")
const {requireAdmin} = require("../middleware/requireAdmin")
const {
	supabaseAdmin, // kept for deletes
	bucket,
	objectKeyForProject,
	toPublicFileUrl,
} = require("../storage/supabase")

const r = express.Router()

// Reduce sharp RAM/CPU spikes (safe defaults for 512 MB instances)
sharp.cache(false)
sharp.concurrency(1)

/** helper to turn "projects/2/123-foo@1600w.webp" -> "...@800w.webp" */
function variantKeyFromMain(mainKey, width) {
	return mainKey.replace(/@(\d+)w\.webp$/, `@${width}w.webp`)
}

/** stream upload to Supabase Storage via REST (no Buffers, no disk) */
async function uploadStreamToSupabase({
	bucket,
	key,
	body,
	contentType = "application/octet-stream",
	upsert = false,
}) {
	const base = process.env.SUPABASE_URL
	const token = process.env.SUPABASE_SERVICE_ROLE_KEY
	if (!base || !token)
		throw new Error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY")

	const url = `${base.replace(
		/\/+$/,
		"",
	)}/storage/v1/object/${encodeURIComponent(bucket)}/${key}`

	const resp = await fetch(url, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${token}`,
			"Content-Type": contentType,
			"x-upsert": upsert ? "true" : "false",
			"Cache-Control": "31536000, immutable",
		},
		body, // Node stream (sharp pipeline)
		duplex: "half", // <-- REQUIRED for streaming bodies in Node.js fetch
	})

	if (!resp.ok) {
		const text = await resp.text().catch(() => "")
		throw new Error(`Supabase upload failed (${resp.status}): ${text}`)
	}
}

/* ========== ADMIN: IMAGES (manage) ========== */
r.use(requireAdmin)

/** POST /projects/admin/:id/images  (multipart: files[]) — streaming, zero-copy */
r.post("/admin/:id/images", async (req, res) => {
	const projectId = Number(req.params.id)
	if (!projectId) return res.status(400).json({error: "invalid id"})

	const rows = []
	const uploaded = []
	let fileCount = 0
	const tasks = []

	let bb
	try {
		bb = Busboy({
			headers: req.headers,
			limits: {files: 10, fileSize: 10 * 1024 * 1024},
		})
	} catch {
		bb = new Busboy({
			headers: req.headers,
			limits: {files: 10, fileSize: 10 * 1024 * 1024},
		})
	}

	bb.on("file", (_name, file, info) => {
		const {filename, mimeType} = info || {}
		if (!mimeType || !/^image\//i.test(mimeType)) {
			file.resume() // skip non-images safely
			return
		}
		fileCount++

		const base = objectKeyForProject(projectId, filename)
		const key1600 = `${base}@1600w.webp`
		const key800 = `${base}@800w.webp`

		// one input -> two output streams
		const src = sharp().rotate() // respects EXIF
		const s1600 = src
			.clone()
			.resize({width: 1600, withoutEnlargement: true})
			.webp({quality: 78})
		const s800 = src
			.clone()
			.resize({width: 800, withoutEnlargement: true})
			.webp({quality: 78})

		// start feeding data
		file.pipe(src)

		// kick off uploads (stream -> REST)
		const put1600 = uploadStreamToSupabase({
			bucket,
			key: key1600,
			body: s1600,
			contentType: "image/webp",
			upsert: false,
		})

		const put800 = uploadStreamToSupabase({
			bucket,
			key: key800,
			body: s800,
			contentType: "image/webp",
			upsert: false,
		})

		const task = Promise.all([put1600, put800]).then(() => {
			rows.push([projectId, key1600, null, 0]) // keep 1600 as "main" in DB
			uploaded.push({
				file_path: key1600,
				file_url: toPublicFileUrl(key1600),
				thumb_url: toPublicFileUrl(key800),
			})
		})

		tasks.push(task)
	})

	bb.on("field", () => {
		/* ignore optional fields for now */
	})

	bb.on("error", (err) => {
		console.error("busboy error:", err)
		res.status(500).json({error: "upload_failed"})
	})

	bb.on("finish", async () => {
		if (!fileCount)
			return res.status(400).json({error: "no files uploaded"})
		try {
			await Promise.all(tasks)
			await pool.query(
				`INSERT INTO project_images (project_id, file_path, alt, sort_order) VALUES ?`,
				[rows],
			)
			res.status(201).json(uploaded)
		} catch (e) {
			console.error("upload optimize error:", e)
			res.status(500).json({error: "upload_failed"})
		}
	})

	req.pipe(bb)
})

/** PATCH /projects/admin/:id/images/:imageId  (alt, sort_order) */
r.patch("/admin/:id/images/:imageId", async (req, res) => {
	const projectId = Number(req.params.id)
	const imageId = Number(req.params.imageId)
	if (!projectId || !imageId)
		return res.status(400).json({error: "invalid id"})

	const sets = []
	const params = []
	if (Object.prototype.hasOwnProperty.call(req.body, "alt")) {
		sets.push("alt = ?")
		params.push(
			req.body.alt == null ? null : String(req.body.alt).trim() || null,
		)
	}
	if (Object.prototype.hasOwnProperty.call(req.body, "sort_order")) {
		sets.push("sort_order = ?")
		params.push(Number(req.body.sort_order) || 0)
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

/** DELETE /projects/admin/:id/images/:imageId */
r.delete("/admin/:id/images/:imageId", async (req, res) => {
	const projectId = Number(req.params.id)
	const imageId = Number(req.params.imageId)
	if (!projectId || !imageId)
		return res.status(400).json({error: "invalid id"})

	// read current key
	const [[img]] = await pool.query(
		`SELECT file_path FROM project_images WHERE project_id = ? AND id = ? LIMIT 1`,
		[projectId, imageId],
	)

	// delete DB row
	const [result] = await pool.execute(
		`DELETE FROM project_images WHERE project_id = ? AND id = ?`,
		[projectId, imageId],
	)
	if (result.affectedRows === 0)
		return res.status(404).json({error: "not found"})

	// delete objects from storage (ignore errors)
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
