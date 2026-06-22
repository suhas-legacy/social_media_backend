const express = require('express');
const bcrypt  = require('bcryptjs');
const { query } = require('../db/pool');
const { authenticate, requireAdmin } = require('../middleware/auth');

const router = express.Router();

// GET /api/employees  — list all employees (admin only)
router.get('/', authenticate, requireAdmin, async (req, res, next) => {
  try {
    const result = await query(`
      SELECT
        u.id, u.name, u.email, u.role, u.is_active, u.created_at,
        COUNT(l.id) FILTER (WHERE l.status = 'new')        AS new_count,
        COUNT(l.id) FILTER (WHERE l.status = 'contacted')  AS contacted_count,
        COUNT(l.id) FILTER (WHERE l.status = 'converted')  AS converted_count,
        COUNT(l.id)                                         AS total_assigned
      FROM users u
      LEFT JOIN leads l ON l.assigned_to = u.id
      WHERE u.role = 'employee'
      GROUP BY u.id
      ORDER BY u.name
    `);
    res.json({ employees: result.rows });
  } catch (err) { next(err); }
});

// POST /api/employees  — create employee
router.post('/', authenticate, requireAdmin, async (req, res, next) => {
  try {
    const { name, email, password } = req.body;
    if (!name || !email || !password) return res.status(400).json({ error: 'All fields required' });

    const hash = await bcrypt.hash(password, 10);
    const result = await query(`
      INSERT INTO users (name, email, password_hash, role)
      VALUES ($1, $2, $3, 'employee')
      RETURNING id, name, email, role, created_at
    `, [name, email.toLowerCase().trim(), hash]);

    res.status(201).json({ employee: result.rows[0] });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Email already exists' });
    next(err);
  }
});

// PATCH /api/employees/:id/toggle  — activate/deactivate
router.patch('/:id/toggle', authenticate, requireAdmin, async (req, res, next) => {
  try {
    const result = await query(`
      UPDATE users SET is_active = NOT is_active WHERE id = $1
      RETURNING id, name, is_active
    `, [req.params.id]);
    res.json({ employee: result.rows[0] });
  } catch (err) { next(err); }
});

module.exports = router;
