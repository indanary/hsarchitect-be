// routes/projectImages.js
const express = require("express")
const sharp = require("sharp")
const Busboy = require("busboy")
const {pool} = require("../db")
const {requireAdmin} = require("../middleware/requireAdmin")
const {
	supabaseAdmin,
	bucket,
	objectKeyForProject,
	toPublicFileUrl,
	toPublicTransformedUrl,
} = require("../storage/supabase")

const r = express.Router()

// Configurable max upload size (bytes). Default 20MB.
// You can set UPLOAD_MAX_BYTES in env if needed.
const MAX_FILE_SIZE = Number(process.env.UPLOAD_MAX_BYTES || 20 * 1024 * 1024)
const MAX_FILES = 3

// Be conservative on resources
sharp.cache(false)
sharp.concurrency(1)

/* ========== ADMIN: IMAGES (manage) ========== */
r.use(requireAdmin)

/**
 * POST /projects/admin/:id/images
 * multipart: files[]
 * - up to 3 files
 * - each <= 20MB
 * - processed to 1600w webp
 */
r.post("/admin/:id/images", async (req, res) => {
	const projectId = Number(req.params.id)
	if (!projectId) return res.status(400).json({error: "invalid id"})

	let fileCount = 0
	const uploaded = []
	const rows = []
	const errors = []
	const tasks = []

	let bb
	try {
		bb = Busboy({
			headers: req.headers,
			limits: {
				fileSize: MAX_FILE_SIZE,
				files: MAX_FILES,
			},
		})
	} catch {
		bb = new Busboy({
			headers: req.headers,
			limits: {
				fileSize: MAX_FILE_SIZE,
				files: MAX_FILES,
			},
		})
	}

	bb.on("file", (fieldName, file, info = {}) => {
		const {filename = "file", mimeType = ""} = info
		fileCount++

		// Reject non-images
		if (!mimeType.startsWith("image/")) {
			file.resume()
			errors.push({filename, error: "not an image"})
			return
		}

		const chunks = []

		file.on("data", (chunk) => {
			chunks.push(chunk)
		})

		file.on("limit", () => {
			errors.push({
				filename,
				error: `file too large (max ${MAX_FILE_SIZE} bytes)`,
			})
			file.resume()
		})

		// Track async work via a task promise
		const task = new Promise((resolve) => {
			file.on("end", async () => {
				try {
					if (chunks.length === 0) {
						errors.push({filename, error: "empty file"})
						return resolve()
					}

					const buffer = Buffer.concat(chunks)

					// Process with sharp to 1600w WEBP
					const outBuf = await sharp(buffer)
						.rotate()
						.resize({width: 1600, withoutEnlargement: true})
						.webp({quality: 78})
						.toBuffer()

					// Generate key using your existing helper
					const baseKey = objectKeyForProject(projectId, filename)
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

					// Record DB row + response payload
					rows.push([projectId, key1600, null, 0])
					uploaded.push({
						file_path: key1600,
						file_url: toPublicFileUrl(key1600),
						// 800w thumbnail generated on-the-fly via transform
						thumb_url: toPublicTransformedUrl(key1600, {
							width: 800,
						}),
					})
				} catch (err) {
					errors.push({filename, error: String(err?.message || err)})
				} finally {
					resolve()
				}
			})

			file.on("error", (err) => {
				errors.push({filename, error: String(err?.message || err)})
				resolve()
			})
		})

		tasks.push(task)
	})

	bb.on("error", (err) => {
		console.error("Busboy error:", err)
		return res
			.status(500)
			.json({error: "upload_failed", detail: String(err?.message || err)})
	})

	bb.on("finish", async () => {
		if (!fileCount) {
			return res.status(400).json({error: "no files uploaded"})
		}

		try {
			// Wait for all file processing + upload tasks
			await Promise.all(tasks)

			// Insert only successfully uploaded images
			if (rows.length) {
				await pool.query(
					`INSERT INTO project_images (project_id, file_path, alt, sort_order)
           VALUES ?`,
					[rows],
				)
			}

			if (uploaded.length === 0) {
				return res.status(400).json({
					error: "upload_failed",
					details: errors,
				})
			}

			return res.status(201).json({
				uploaded,
				errors: errors.length ? errors : undefined,
			})
		} catch (e) {
			console.error("upload optimize error:", e)
			return res.status(500).json({error: "upload_failed"})
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
		`UPDATE project_images
     SET ${sets.join(", ")}
     WHERE project_id = ? AND id = ?`,
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

	// delete object(s) from storage (ignore errors)
	if (img && img.file_path) {
		const key1600 = img.file_path
		const key800 = key1600.replace(/@(\d+)w\.webp$/, "@800w.webp")

		try {
			await supabaseAdmin.storage.from(bucket).remove([key1600, key800])
		} catch {
			// ignore delete errors
		}
	}

	res.status(204).end()
})

module.exports = r
