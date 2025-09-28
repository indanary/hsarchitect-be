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
	toPublicTransformedUrl, // ensure this is exported in storage/supabase.js
} = require("../storage/supabase")

const r = express.Router()

// Configurable max upload size (bytes). Default 20MB.
// You can set UPLOAD_MAX_BYTES in your Render env if needed.
const MAX_FILE_SIZE = Number(process.env.UPLOAD_MAX_BYTES || 20 * 1024 * 1024)

// Be conservative on resources
sharp.cache(false)
sharp.concurrency(1)

/** Stream upload to Supabase Storage via REST */
async function uploadStreamToSupabase({
	bucket,
	key,
	body,
	contentType = "application/octet-stream",
	upsert = false,
	signal,
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
		duplex: "half", // required for streaming bodies in Node fetch
		signal,
	})
	if (!resp.ok) {
		const text = await resp.text().catch(() => "")
		throw new Error(`Supabase upload failed (${resp.status}): ${text}`)
	}
}

/* ========== ADMIN: IMAGES (manage) ========== */
r.use(requireAdmin)

/** POST /projects/admin/:id/images  (multipart: files[]) — streaming, one size only (1600w) */
r.post("/admin/:id/images", async (req, res) => {
	const projectId = Number(req.params.id)
	if (!projectId) return res.status(400).json({error: "invalid id"})

	const rows = []
	const uploaded = []
	const tasks = []
	let fileCount = 0
	let hadLimitError = false
	const perFileErrors = []

	let bb
	try {
		bb = Busboy({
			headers: req.headers,
			limits: {files: 10, fileSize: MAX_FILE_SIZE},
		})
	} catch {
		bb = new Busboy({
			headers: req.headers,
			limits: {files: 10, fileSize: MAX_FILE_SIZE},
		})
	}

	bb.on("file", (_name, file, info) => {
		const {filename, mimeType} = info || {}
		if (!mimeType || !/^image\//i.test(mimeType)) {
			file.resume() // skip non-images
			return
		}
		fileCount++

		// Build keys
		const base = objectKeyForProject(projectId, filename)
		const key1600 = `${base}@1600w.webp`

		// Pipeline: source -> (rotate, resize->1600, webp)
		const s1600 = sharp({sequentialRead: true})
			.rotate()
			.resize({width: 1600, withoutEnlargement: true})
			.webp({quality: 78})

		// Abortable upload
		const ac = new AbortController()
		const put1600 = uploadStreamToSupabase({
			bucket,
			key: key1600,
			body: s1600,
			contentType: "image/webp",
			upsert: false,
			signal: ac.signal,
		})

		// Wire error/limit handling
		file.on("limit", () => {
			hadLimitError = true
			const err = new Error("file_too_large")
			perFileErrors.push({
				filename,
				code: "FILE_TOO_LARGE",
				message: `File exceeded ${MAX_FILE_SIZE} bytes`,
			})
			// Stop the pipeline & outgoing fetch
			try {
				s1600.destroy(err)
			} catch {}
			try {
				ac.abort(err)
			} catch {}
			file.resume() // drain remaining input safely
		})

		file.on("error", (err) => {
			perFileErrors.push({
				filename,
				code: "FILE_STREAM_ERROR",
				message: String(err?.message || err),
			})
			try {
				s1600.destroy(err)
			} catch {}
			try {
				ac.abort(err)
			} catch {}
		})

		s1600.on("error", (err) => {
			// Common case: truncated JPEG -> VipsJpeg: premature end...
			perFileErrors.push({
				filename,
				code: "IMAGE_PROCESS_ERROR",
				message: String(err?.message || err),
			})
			try {
				ac.abort(err)
			} catch {}
		})

		// Start streaming
		file.pipe(s1600)

		const task = put1600
			.then(() => {
				// Only record success if we didn't trip errors for this file
				// (If aborted, promise rejects and will be caught below)
				rows.push([projectId, key1600, null, 0])
				uploaded.push({
					file_path: key1600,
					file_url: toPublicFileUrl(key1600),
					// 800w thumbnail is generated on-the-fly (no second encode)
					thumb_url: toPublicTransformedUrl(key1600, {width: 800}),
				})
			})
			.catch((err) => {
				// Already recorded a per-file error above; ensure we note it if not
				if (!perFileErrors.find((e) => e.filename === filename)) {
					perFileErrors.push({
						filename,
						code: "UPLOAD_ERROR",
						message: String(err?.message || err),
					})
				}
			})

		tasks.push(task)
	})

	bb.on("error", (err) => {
		return res
			.status(500)
			.json({error: "upload_failed", detail: String(err?.message || err)})
	})

	bb.on("finish", async () => {
		if (!fileCount)
			return res.status(400).json({error: "no files uploaded"})

		try {
			await Promise.all(tasks)

			// If any file exceeded the size limit, return 413 and do NOT insert
			if (hadLimitError) {
				return res.status(413).json({
					error: "file_too_large",
					max_bytes: MAX_FILE_SIZE,
					files: perFileErrors,
				})
			}

			// If there were other per-file errors and none succeeded, surface them
			if (uploaded.length === 0 && perFileErrors.length) {
				return res
					.status(400)
					.json({error: "upload_failed", files: perFileErrors})
			}

			// Insert only successful ones
			if (rows.length) {
				await pool.query(
					`INSERT INTO project_images (project_id, file_path, alt, sort_order) VALUES ?`,
					[rows],
				)
			}

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
