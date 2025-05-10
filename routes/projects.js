import express from "express"
import {pool} from "../db.js"

const router = express.Router()

// Get all projects with categories
router.get("/", async (req, res) => {
	const [projects] = await pool.query(`
    SELECT 
      p.id, p.title, p.description, p.image_url, p.created_url,
      GROUP_CONCAT(c.name) AS categories
    FROM projects p
    LEFT JOIN project_categories pc ON p.id = pc.project_id
    LEFT JOIN categories c ON pc.category_id = c.id
    GROUP BY p.id
  `)
	res.json(projects)
})

// GET project by ID (with categories)
router.get("/:id", async (req, res) => {
	const {id} = req.params

	try {
		const [[project]] = await pool.query(
			`SELECT id, title, description, image_url, created_url
       FROM projects
       WHERE id = ?`,
			[id],
		)

		if (!project) {
			return res.status(404).json({error: "Project not found"})
		}

		const [categories] = await pool.query(
			`SELECT c.id, c.name
       FROM categories c
       JOIN project_categories pc ON c.id = pc.category_id
       WHERE pc.project_id = ?`,
			[id],
		)

		res.json({...project, categories})
	} catch (err) {
		res.status(500).json({error: "Server error"})
	}
})

// Create a new project
router.post("/", async (req, res) => {
	const {title, description, image_url, created_url, category_ids} = req.body
	const [result] = await pool.query(
		"INSERT INTO projects (title, description, image_url, created_url) VALUES (?, ?, ?, ?)",
		[title, description, image_url, created_url],
	)
	const projectId = result.insertId

	if (Array.isArray(category_ids) && category_ids.length > 0) {
		const values = category_ids.map((cid) => [projectId, cid])
		await pool.query(
			"INSERT INTO project_categories (project_id, category_id) VALUES ?",
			[values],
		)
	}

	res.status(201).json({id: projectId})
})

// DELETE project by ID
router.delete("/:id", async (req, res) => {
	const {id} = req.params

	try {
		// First delete from join table to prevent FK constraint error
		await pool.query(
			"DELETE FROM project_categories WHERE project_id = ?",
			[id],
		)
		// Then delete from projects table
		const [result] = await pool.query("DELETE FROM projects WHERE id = ?", [
			id,
		])

		if (result.affectedRows === 0) {
			return res.status(404).json({error: "Project not found"})
		}

		res.json({message: "Project deleted successfully"})
	} catch (err) {
		res.status(500).json({error: "Server error"})
	}
})

// UPDATE project by ID
router.put("/:id", async (req, res) => {
	const {id} = req.params
	const {title, description, image_url, created_url, category_ids} = req.body

	try {
		// Update project
		const [result] = await pool.query(
			`UPDATE projects
       SET title = ?, description = ?, image_url = ?, created_url = ?
       WHERE id = ?`,
			[title, description, image_url, created_url, id],
		)

		// Update categories
		if (Array.isArray(category_ids)) {
			// Remove old categories
			await pool.query(
				"DELETE FROM project_categories WHERE project_id = ?",
				[id],
			)
			// Add new ones
			if (category_ids.length > 0) {
				const values = category_ids.map((cid) => [id, cid])
				await pool.query(
					"INSERT INTO project_categories (project_id, category_id) VALUES ?",
					[values],
				)
			}
		}

		if (result.affectedRows === 0) {
			return res.status(404).json({error: "Project not found"})
		}

		res.json({message: "Project updated successfully"})
	} catch (err) {
		res.status(500).json({error: "Server error"})
	}
})

export default router
