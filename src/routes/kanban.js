const express = require('express');
const { query } = require('../db/pool');
const { authenticate } = require('../middleware/auth');

const router = express.Router();

const STATUSES = ['new', 'contacted', 'interested', 'not_interested', 'converted', 'lost'];

// GET /api/kanban  — returns leads grouped by status column
router.get('/', authenticate, async (req, res, next) => {
  try {
    const { assigned_to } = req.query;
    const params = [];
    let where = '';

    if (req.user.role === 'employee') {
      where = 'WHERE l.assigned_to = $1';
      params.push(req.user.id);
    } else if (assigned_to) {
      where = 'WHERE l.assigned_to = $1';
      params.push(assigned_to);
    }

    const result = await query(`
      SELECT
        l.id, l.full_name, l.email, l.company, l.job_title,
        l.source, l.status, l.priority, l.tags,
        l.linkedin_url, l.profile_image, l.assigned_to,
        l.created_at, l.contacted_at,
        u.name AS assigned_to_name,
        (SELECT COUNT(*) FROM lead_notes n WHERE n.lead_id = l.id) AS note_count
      FROM leads l
      LEFT JOIN users u ON l.assigned_to = u.id
      ${where}
      ORDER BY l.priority DESC, l.created_at DESC
    `, params);

    // Group into columns
    const columns = STATUSES.reduce((acc, s) => {
      acc[s] = { status: s, leads: [], count: 0 };
      return acc;
    }, {});

    result.rows.forEach(lead => {
      if (columns[lead.status]) {
        columns[lead.status].leads.push(lead);
        columns[lead.status].count++;
      }
    });

    res.json({ columns: Object.values(columns) });
  } catch (err) { next(err); }
});

// GET /api/kanban/stats  — summary counts per status
router.get('/stats', authenticate, async (req, res, next) => {
  try {
    const params = [];
    let where = '';

    if (req.user.role === 'employee') {
      where = 'WHERE assigned_to = $1';
      params.push(req.user.id);
    }

    const result = await query(`
      SELECT status, COUNT(*) AS count
      FROM leads
      ${where}
      GROUP BY status
    `, params);

    const stats = STATUSES.reduce((acc, s) => { acc[s] = 0; return acc; }, {});
    result.rows.forEach(r => { stats[r.status] = parseInt(r.count); });

    res.json({ stats, total: Object.values(stats).reduce((a, b) => a + b, 0) });
  } catch (err) { next(err); }
});

module.exports = router;
