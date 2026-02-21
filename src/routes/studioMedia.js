// routes/studioMedia.js
const express = require("express")
const sharp = require("sharp")
const Busboy = require("busboy")
const {requireAdmin} = require("../middleware/requireAdmin")
const {
	supabaseAdmin,
	bucket,
	toPublicFileUrl,
	toPublicTransformedUrl,
} = require("../storage/supabase")

const r = express.Router()

const MAX_FILE_SIZE = Number(process.env.UPLOAD_MAX_BYTES || 20 * 1024 * 1024)

sharp.cache(false)
sharp.concurrency(0)

r.use(requireAdmin)

/**
 * POST /studio-media/upload
 */
r.post("/upload", async (req, res) => {
	let uploaded = null
	const errors = []
	const tasks = []

	const bb = Busboy({
		headers: req.headers,
		limits: {
			fileSize: MAX_FILE_SIZE,
			files: 1,
		},
	})

	bb.on("file", (_field, file, info = {}) => {
		const {filename = "file", mimeType = ""} = info

		if (!mimeType.startsWith("image/")) {
			errors.push({filename, error: "unsupported file type"})
			file.resume()
			return
		}

		const chunks = []

		file.on("data", (c) => chunks.push(c))

		file.on("limit", () => {
			errors.push({filename, error: "file too large"})
		})

		const task = new Promise((resolve) => {
			file.on("end", async () => {
				try {
					const buffer = Buffer.concat(chunks)

					const outBuf = await sharp(buffer)
						.rotate()
						.resize({width: 1600, withoutEnlargement: true})
						.webp({quality: 78})
						.toBuffer()

					const uniqueName = `${Date.now()}-${Math.random()
						.toString(36)
						.slice(2)}-${filename}`

					const key = `studio/${uniqueName}@1600w.webp`

					const {error} = await supabaseAdmin.storage
						.from(bucket)
						.upload(key, outBuf, {
							contentType: "image/webp",
							upsert: false,
						})

					if (error) {
						errors.push({filename, error: error.message})
					} else {
						uploaded = {
							url: toPublicFileUrl(key),
							thumb_url: toPublicTransformedUrl(key, {
								width: 800,
							}),
						}
					}
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
	})

	bb.on("finish", async () => {
		await Promise.all(tasks) // 🔥 critical fix

		if (!uploaded) {
			return res.status(400).json({
				error: "upload_failed",
				details: errors,
			})
		}

		res.status(201).json({
			data: [uploaded],
			errors: errors.length ? errors : undefined,
		})
	})

	req.pipe(bb)
})

module.exports = r
