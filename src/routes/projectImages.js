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
	let fatalError = false
	const perFileErrors = []

	// Track all controllers & sharp instances so we can abort everything
	const controllers = []
	const transformers = []

	function abortAll(err) {
		fatalError = true
		for (const t of transformers) {
			try {
				t.destroy(err)
			} catch {}
		}
		for (const c of controllers) {
			try {
				c.abort(err)
			} catch {}
		}
	}

	let bb
	try {
		bb = Busboy({
			headers: req.headers,
			limits: {files: 3, fileSize: MAX_FILE_SIZE}, // <= tightened
		})
	} catch {
		bb = new Busboy({
			headers: req.headers,
			limits: {files: 3, fileSize: MAX_FILE_SIZE},
		})
	}

	bb.on("file", (_name, file, info) => {
		const {filename, mimeType} = info || {}

		if (fatalError) {
			// We already decided to fail the whole batch, just drain
			file.resume()
			return
		}

		if (!mimeType || !/^image\//i.test(mimeType)) {
			file.resume()
			return
		}

		fileCount++

		const base = objectKeyForProject(projectId, filename)
		const key1600 = `${base}@1600w.webp`

		// Faster sharp config: use fastShrinkOnLoad, reasonable quality/effort
		const s1600 = sharp({sequentialRead: true})
			.rotate()
			.resize({
				width: 1600,
				withoutEnlargement: true,
				fit: "inside",
				fastShrinkOnLoad: true,
			})
			.webp({quality: 78, effort: 4})

		transformers.push(s1600)

		const ac = new AbortController()
		controllers.push(ac)

		const put1600 = uploadStreamToSupabase({
			bucket,
			key: key1600,
			body: s1600,
			contentType: "image/webp",
			upsert: false,
			signal: ac.signal,
		})

		file.on("limit", () => {
			hadLimitError = true
			const err = new Error("file_too_large")
			perFileErrors.push({
				filename,
				code: "FILE_TOO_LARGE",
				message: `File exceeded ${MAX_FILE_SIZE} bytes`,
			})
			abortAll(err) // <= abort everything
			file.resume()
		})

		file.on("error", (err) => {
			perFileErrors.push({
				filename,
				code: "FILE_STREAM_ERROR",
				message: String(err?.message || err),
			})
			abortAll(err)
		})

		s1600.on("error", (err) => {
			perFileErrors.push({
				filename,
				code: "IMAGE_PROCESS_ERROR",
				message: String(err?.message || err),
			})
			abortAll(err)
		})

		file.pipe(s1600)

		const task = put1600
			.then(() => {
				if (fatalError) return // we already decided to fail whole batch
				rows.push([projectId, key1600, null, 0])
				uploaded.push({
					file_path: key1600,
					file_url: toPublicFileUrl(key1600),
					thumb_url: toPublicTransformedUrl(key1600, {width: 800}),
				})
			})
			.catch((err) => {
				// Already recorded in perFileErrors usually
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
		abortAll(err)
		return res
			.status(500)
			.json({error: "upload_failed", detail: String(err?.message || err)})
	})

	bb.on("finish", async () => {
		if (!fileCount) {
			return res.status(400).json({error: "no files uploaded"})
		}

		try {
			await Promise.all(tasks)

			// If we had a file size limit error, fail the whole batch
			if (hadLimitError) {
				// Optional: delete any already-uploaded objects here.
				return res.status(413).json({
					error: "file_too_large",
					max_bytes: MAX_FILE_SIZE,
					files: perFileErrors,
				})
			}

			// If everything failed
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
