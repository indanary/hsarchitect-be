const express = require("express")
const {pool} = require("../db")
const {requireAdmin} = require("../middleware/requireAdmin")

const r = express.Router()

const TYPES = new Set(["profile", "philosophy", "achievement"])
const isValidType = (t) => typeof t === "string" && TYPES.has(t)

// ========== PUBLIC READ ==========
/** GET /studio/:type  -> { id, type, description } or 404 */
r.get("/:type", async (req, res) => {
	const type = String(req.params.type || "").toLowerCase()
	if (!isValidType(type)) return res.status(400).json({error: "invalid type"})

	const [rows] = await pool.execute(
		"SELECT id, type, description FROM studio WHERE type = ? LIMIT 1",
		[type],
	)
	const row = rows[0]
	if (!row) return res.status(404).json({error: "not found"})
	res.json(row)
})

// ========== ADMIN (UPSERT/EDIT/DELETE) ==========
r.use(requireAdmin)

/** PUT /studio/admin/:type  body: { description }  (create or update) */
r.put("/admin/:type", async (req, res) => {
	const type = String(req.params.type || "").toLowerCase()
	if (!isValidType(type)) return res.status(400).json({error: "invalid type"})

	const description = req.body?.description ?? null // HTML string (sanitize when rendering on FE)

	// upsert
	await pool.execute(
		`INSERT INTO studio (type, description)
     VALUES (?, ?)
     ON DUPLICATE KEY UPDATE description = VALUES(description), updated_at = CURRENT_TIMESTAMP`,
		[type, description],
	)

	// return current value
	const [rows] = await pool.execute(
		"SELECT id, type, description FROM studio WHERE type = ? LIMIT 1",
		[type],
	)
	res.status(200).json(rows[0])
})

/** PATCH /studio/admin/:type  body: { description } (partial) */
r.patch("/admin/:type", async (req, res) => {
	const type = String(req.params.type || "").toLowerCase()
	if (!isValidType(type)) return res.status(400).json({error: "invalid type"})

	if (!Object.prototype.hasOwnProperty.call(req.body, "description")) {
		return res.status(400).json({error: "nothing to update"})
	}
	const description = req.body.description ?? null

	const [result] = await pool.execute(
		"UPDATE studio SET description = ? WHERE type = ?",
		[description, type],
	)
	if (result.affectedRows === 0)
		return res.status(404).json({error: "not found"})
	res.status(204).end()
})

/** DELETE /studio/admin/:type  (rarely needed, but provided) */
r.delete("/admin/:type", async (req, res) => {
	const type = String(req.params.type || "").toLowerCase()
	if (!isValidType(type)) return res.status(400).json({error: "invalid type"})

	const [result] = await pool.execute("DELETE FROM studio WHERE type = ?", [
		type,
	])
	if (result.affectedRows === 0)
		return res.status(404).json({error: "not found"})
	res.status(204).end()
})

module.exports = r
