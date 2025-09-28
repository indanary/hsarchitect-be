// routes/projectImages.js
const express = require("express")
const sharp = require("sharp")
const Busboy = require("busboy")
const {pool} = require("../db")
const {requireAdmin} = require("../middleware/requireAdmin")
const {
	bucket,
	objectKeyForProject,
	toPublicFileUrl,
	toPublicTransformedUrl, // NEW
} = require("../storage/supabase")

const r = express.Router()

// be conservative on memory/CPU
sharp.cache(false)
sharp.concurrency(1)

/** stream upload to Supabase Storage via REST */
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
		body, // Readable stream (sharp pipeline)
		duplex: "half", // required by Node fetch for streaming bodies
	})
	if (!resp.ok) {
		const text = await resp.text().catch(() => "")
		throw new Error(`Supabase upload failed (${resp.status}): ${text}`)
	}
}

/* ========== ADMIN: IMAGES (manage) ========== */
r.use(requireAdmin)

/** POST /projects/admin/:id/images  (multipart: files[]) — streaming, one size only */
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
			file.resume() // skip non-images
			return
		}
		fileCount++

		const base = objectKeyForProject(projectId, filename)
		const key1600 = `${base}@1600w.webp`

		// one pipeline → 1600w webp
		const s1600 = sharp()
			.rotate()
			.resize({width: 1600, withoutEnlargement: true})
			.webp({quality: 78})

		// begin streaming
		file.pipe(s1600)

		const task = uploadStreamToSupabase({
			bucket,
			key: key1600,
			body: s1600,
			contentType: "image/webp",
			upsert: false,
		}).then(() => {
			rows.push([projectId, key1600, null, 0])
			uploaded.push({
				file_path: key1600,
				file_url: toPublicFileUrl(key1600),
				// 800 thumb generated on the fly — no second encode/upload
				thumb_url: toPublicTransformedUrl(key1600, {width: 800}),
			})
		})

		tasks.push(task)
	})

	bb.on("error", (err) => {
		console.error("busboy error:", err)
		res.status(500).json({error: "upload_failed"})
	})

	bb.on("finish", async () => {
		if (!fileCount)
			return res.status(400).json({error: "no files uploaded"})
		try {
			// ensure strict sequentiality if needed by awaiting per task; currently each file runs alone anyway
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

	// only one object exists now; removing an 800 key is harmless if missing
	if (img && img.file_path) {
		const key1600 = img.file_path
		const key800 = key1600.replace(/@(\d+)w\.webp$/, "@800w.webp")
		await fetch(
			`${process.env.SUPABASE_URL.replace(
				/\/+$/,
				"",
			)}/storage/v1/object/${encodeURIComponent(bucket)}`,
			{
				method: "DELETE",
				headers: {
					Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
					"Content-Type": "application/json",
				},
				body: JSON.stringify({prefixes: [key1600, key800]}),
			},
		).catch(() => {})
	}

	res.status(204).end()
})

module.exports = r
