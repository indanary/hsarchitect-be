import express from 'express';
import { pool } from '../db.js';

const router = express.Router();

// Get all categories
router.get('/', async (req, res) => {
  const [rows] = await pool.query('SELECT * FROM categories');
  res.json(rows);
});

// Create a category
router.post('/', async (req, res) => {
  const { name } = req.body;
  const [result] = await pool.query('INSERT INTO categories (name) VALUES (?)', [name]);
  res.status(201).json({ id: result.insertId });
});

// DELETE category by ID (with usage check)
router.delete('/:id', async (req, res) => {
  const { id } = req.params;

  try {
    // Check if the category is used in any project
    const [[usage]] = await pool.query(
      'SELECT COUNT(*) AS count FROM project_categories WHERE category_id = ?',
      [id]
    );

    if (usage.count > 0) {
      return res.status(400).json({
        error: 'Cannot delete category — it is still assigned to one or more projects.',
      });
    }

    // Proceed to delete the category
    const [result] = await pool.query('DELETE FROM categories WHERE id = ?', [id]);

    if (result.affectedRows === 0) {
      return res.status(404).json({ error: 'Category not found' });
    }

    res.json({ message: 'Category deleted successfully' });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

export default router;
