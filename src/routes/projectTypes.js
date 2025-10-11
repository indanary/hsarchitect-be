const express = require("express")
const {pool} = require("../db")
const {requireAdmin} = require("../middleware/requireAdmin")

const r = express.Router()

/** ===================== PUBLIC ===================== */
/**
 * GET /project-types/public
 * Returns: [{ id, project_type }]
 */
r.get("/public", async (req, res) => {
	try {
		const [rows] = await pool.execute(
			"SELECT id, project_type FROM project_types ORDER BY id ASC",
		)
		res.json(rows)
	} catch (err) {
		console.error("GET /project-types/public error:", err)
		res.status(500).json({error: "internal_error"})
	}
})

// all endpoints here require admin
r.use(requireAdmin)

/**
 * GET /admin/project-types
 * Optional query: q (substring search)
 */
r.get("/", async (req, res) => {
	const q = (req.query.q || "").toString().trim()
	let sql = "SELECT id, project_type FROM project_types"
	let params = []
	if (q) {
		sql += " WHERE project_type LIKE ?"
		params.push(`%${q}%`)
	}
	sql += " ORDER BY project_type ASC"

	const [rows] = await pool.execute(sql, params)
	res.json(rows)
})

/**
 * POST /admin/project-types
 * body: { project_type: string }
 */
r.post("/", async (req, res) => {
	const project_type = (req.body?.project_type || "").toString().trim()
	if (!project_type)
		return res.status(400).json({error: "project_type is required"})

	try {
		const [result] = await pool.execute(
			"INSERT INTO project_types (project_type) VALUES (?)",
			[project_type],
		)
		res.status(201).json({id: result.insertId, project_type})
	} catch (e) {
		if (e && e.code === "ER_DUP_ENTRY") {
			return res.status(409).json({error: "project_type already exists"})
		}
		throw e
	}
})

/**
 * PATCH /admin/project-types/:id
 * body: { project_type?: string }
 */
r.patch("/:id", async (req, res) => {
	const id = Number(req.params.id)
	if (!Number.isInteger(id))
		return res.status(400).json({error: "invalid id"})

	const project_type = req.body?.project_type
	if (project_type === undefined)
		return res.status(400).json({error: "nothing to update"})

	const value = project_type.toString().trim()
	if (!value)
		return res.status(400).json({error: "project_type cannot be empty"})

	try {
		const [result] = await pool.execute(
			"UPDATE project_types SET project_type = ? WHERE id = ?",
			[value, id],
		)
		if (result.affectedRows === 0)
			return res.status(404).json({error: "not found"})
		res.status(204).end()
	} catch (e) {
		if (e && e.code === "ER_DUP_ENTRY") {
			return res.status(409).json({error: "project_type already exists"})
		}
		throw e
	}
})

/**
 * DELETE /admin/project-types/:id
 */
r.delete("/:id", async (req, res) => {
	const id = Number(req.params.id)
	if (!Number.isInteger(id)) {
		return res.status(400).json({error: "invalid id"})
	}

	try {
		// Fast existence check: stop early if any project uses this type
		const [rows] = await pool.execute(
			"SELECT 1 FROM projects WHERE project_type_id = ? LIMIT 1",
			[id],
		)
		if (rows.length > 0) {
			return res.status(409).json({
				error: "Cannot Delete: Project Type is used by existing Project",
			})
		}

		const [result] = await pool.execute(
			"DELETE FROM project_types WHERE id = ?",
			[id],
		)

		if (result.affectedRows === 0) {
			return res.status(404).json({error: "not found"})
		}

		return res.status(204).end()
	} catch (err) {
		if (err && err.code === "ER_ROW_IS_REFERENCED_2") {
			return res.status(409).json({
				error: "cannot delete: project type is used by existing projects",
			})
		}
		console.error(err)
		return res.status(500).json({error: "internal error"})
	}
})

module.exports = r
