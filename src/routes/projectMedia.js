// routes/projectMedia.js
const express = require("express")
const sharp = require("sharp")
const Busboy = require("busboy")
const {PassThrough} = require("stream")
const {pool} = require("../db")
const {requireAdmin} = require("../middleware/requireAdmin")
const {
	supabaseAdmin,
	bucket,
	objectKeyForProject,
	toPublicFileUrl,
	toPublicTransformedUrl,
} = require("../storage/supabase")
const {queueRebuild} = require("../utils/rebuild")

const r = express.Router()

const MAX_FILE_SIZE = Number(process.env.UPLOAD_MAX_BYTES || 20 * 1024 * 1024)
const MAX_FILES = 3

sharp.cache(false)
sharp.concurrency(0)

r.use(requireAdmin)

/**
 * POST /projects/admin/:id/media
 */
r.post("/admin/:id/media", async (req, res) => {
	const projectId = Number(req.params.id)
	if (!projectId) return res.status(400).json({error: "invalid id"})

	let fileCount = 0
	let clientAborted = false

	const uploaded = []
	const errors = []
	const rows = []
	const tasks = []

	req.on("aborted", () => (clientAborted = true))
	req.on("close", () => (clientAborted = true))

	const bb = Busboy({
		headers: req.headers,
		limits: {
			fileSize: MAX_FILE_SIZE,
			files: MAX_FILES,
		},
	})

	bb.on("file", (_field, file, info = {}) => {
		const {filename = "file", mimeType = ""} = info
		fileCount++

		/* ================= IMAGE ================= */
		if (mimeType.startsWith("image/")) {
			const chunks = []

			file.on("data", (c) => chunks.push(c))
			file.on("limit", () =>
				errors.push({filename, error: "file too large"}),
			)

			const task = new Promise((resolve) => {
				file.on("end", async () => {
					if (clientAborted) return resolve()

					try {
						const buffer = Buffer.concat(chunks)

						const outBuf = await sharp(buffer)
							.rotate()
							.resize({width: 1600, withoutEnlargement: true})
							.webp({quality: 78})
							.toBuffer()

						const baseKey = objectKeyForProject(
							projectId,
							`images/${filename}`,
						)
						const key1600 = `${baseKey}@1600w.webp`

						const {error} = await supabaseAdmin.storage
							.from(bucket)
							.upload(key1600, outBuf, {
								contentType: "image/webp",
								upsert: false,
							})

						if (error) {
							errors.push({filename, error: error.message})
							return resolve()
						}

						rows.push([
							projectId,
							"image",
							key1600, // file_path
							null, // alt
							key1600, // thumb_path
							"image/webp",
							null,
							0,
						])

						uploaded.push({
							type: "image",
							file_url: toPublicFileUrl(key1600),
							thumb_url: toPublicTransformedUrl(key1600, {
								width: 800,
							}),
						})
					} catch (err) {
						errors.push({
							filename,
							error: String(err.message || err),
						})
					}

					resolve()
				})
			})

			tasks.push(task)
			return
		}

		/* ================= VIDEO ================= */
		if (mimeType === "video/mp4") {
			const chunks = []

			file.on("data", (c) => chunks.push(c))
			file.on("limit", () =>
				errors.push({filename, error: "file too large"}),
			)

			const task = new Promise((resolve) => {
				file.on("end", async () => {
					if (clientAborted) return resolve()

					try {
						const buffer = Buffer.concat(chunks)

						const baseKey = objectKeyForProject(
							projectId,
							`videos/${filename}`,
						)

						const {error} = await supabaseAdmin.storage
							.from(bucket)
							.upload(baseKey, buffer, {
								contentType: mimeType,
								upsert: false,
							})

						if (error) {
							errors.push({filename, error: error.message})
							return resolve()
						}

						rows.push([
							projectId,
							"video",
							baseKey,
							null,
							null,
							mimeType,
							null,
							0,
						])

						uploaded.push({
							type: "video",
							file_url: toPublicFileUrl(baseKey),
							thumb_url: null,
						})
					} catch (err) {
						errors.push({
							filename,
							error: String(err.message || err),
						})
					}

					resolve()
				})
			})

			tasks.push(task)
			return
		}

		errors.push({filename, error: "unsupported file type"})
		file.resume()
	})

	bb.on("finish", async () => {
		if (!fileCount)
			return res.status(400).json({error: "no files uploaded"})

		if (clientAborted) return res.status(499).end()

		try {
			await Promise.all(tasks)

			if (!uploaded.length) {
				return res.status(400).json({
					error: "upload_failed",
					details: errors,
				})
			}

			res.status(201).json({
				uploaded,
				errors: errors.length ? errors : undefined,
			})

			setImmediate(async () => {
				try {
					if (rows.length) {
						await pool.query(
							`INSERT INTO project_media
               (project_id, type, file_path, alt, thumb_path, mime_type, duration, sort_order)
               VALUES ?`,
							[rows],
						)
					}
					queueRebuild(projectId)
				} catch (err) {
					console.error("post-upload task failed:", err)
				}
			})
		} catch (err) {
			console.error("media upload error:", err)
			res.status(500).json({error: "upload_failed"})
		}
	})

	req.pipe(bb)
})

/** PATCH /projects/admin/:id/media/:mediaId (alt, sort_order) */
r.patch("/admin/:id/media/:mediaId", async (req, res) => {
	const projectId = Number(req.params.id)
	const mediaId = Number(req.params.mediaId)

	if (!projectId || !mediaId) {
		return res.status(400).json({error: "invalid id"})
	}

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

	if (!sets.length) {
		return res.status(400).json({error: "nothing to update"})
	}

	params.push(projectId, mediaId)

	const [result] = await pool.execute(
		`UPDATE project_media
     SET ${sets.join(", ")}
     WHERE project_id = ? AND id = ?`,
		params,
	)

	if (result.affectedRows === 0) {
		return res.status(404).json({error: "not found"})
	}

	queueRebuild(projectId)
	res.status(204).end()
})

/** DELETE /projects/admin/:id/media/:mediaId */
r.delete("/admin/:id/media/:mediaId", async (req, res) => {
	const projectId = Number(req.params.id)
	const mediaId = Number(req.params.mediaId)

	if (!projectId || !mediaId) {
		return res.status(400).json({error: "invalid id"})
	}

	const [[media]] = await pool.query(
		`SELECT file_path, thumb_path
     FROM project_media
     WHERE project_id = ? AND id = ?
     LIMIT 1`,
		[projectId, mediaId],
	)

	if (!media) {
		return res.status(404).json({error: "not found"})
	}

	await pool.execute(
		`DELETE FROM project_media WHERE project_id = ? AND id = ?`,
		[projectId, mediaId],
	)

	const keys = []
	if (media.file_path) keys.push(media.file_path)
	if (media.thumb_path) keys.push(media.thumb_path)

	if (keys.length) {
		try {
			await supabaseAdmin.storage.from(bucket).remove(keys)
		} catch {}
	}

	queueRebuild(projectId)
	res.status(204).end()
})

module.exports = r
