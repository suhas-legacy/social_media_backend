const express  = require('express');
const multer   = require('multer');
const { parse } = require('csv-parse/sync');
const { query, getClient } = require('../db/pool');
const { authenticate, requireAdmin } = require('../middleware/auth');
const { distributeLeads } = require('../utils/assignLeads');

const router  = express.Router();
const upload  = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

// ─── GET /api/leads  (filtered, paginated) ──────────────────────────────────
router.get('/', authenticate, async (req, res, next) => {
  try {
    const {
      status, source, search, page = 1, limit = 50, assigned_to
    } = req.query;

    const conditions = [];
    const params     = [];
    let   p          = 1;

    // Employees only see their leads
    if (req.user.role === 'employee') {
      conditions.push(`l.assigned_to = $${p++}`);
      params.push(req.user.id);
    } else if (assigned_to) {
      conditions.push(`l.assigned_to = $${p++}`);
      params.push(assigned_to);
    }

    if (status)  { conditions.push(`l.status = $${p++}`);  params.push(status);  }
    if (source)  { conditions.push(`l.source = $${p++}`);  params.push(source);  }
    if (search)  {
      conditions.push(`(
        l.full_name ILIKE $${p} OR l.email ILIKE $${p} OR l.company ILIKE $${p}
      )`);
      params.push(`%${search}%`);
      p++;
    }

    const where  = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const offset = (parseInt(page) - 1) * parseInt(limit);

    const sql = `
      SELECT
        l.*,
        u.name  AS assigned_to_name,
        u.email AS assigned_to_email
      FROM leads l
      LEFT JOIN users u ON l.assigned_to = u.id
      ${where}
      ORDER BY l.created_at DESC
      LIMIT $${p++} OFFSET $${p++}
    `;
    params.push(parseInt(limit), offset);

    const countSql = `SELECT COUNT(*) FROM leads l ${where}`;
    const [rows, total] = await Promise.all([
      query(sql, params),
      query(countSql, params.slice(0, p - 3))
    ]);

    res.json({
      leads: rows.rows,
      total: parseInt(total.rows[0].count),
      page:  parseInt(page),
      pages: Math.ceil(parseInt(total.rows[0].count) / parseInt(limit))
    });
  } catch (err) { next(err); }
});

// ─── GET /api/leads/:id ──────────────────────────────────────────────────────
router.get('/:id', authenticate, async (req, res, next) => {
  try {
    const result = await query(`
      SELECT l.*, u.name AS assigned_to_name
      FROM leads l
      LEFT JOIN users u ON l.assigned_to = u.id
      WHERE l.id = $1
    `, [req.params.id]);

    if (!result.rows.length) return res.status(404).json({ error: 'Lead not found' });

    // Employees can only see their own leads
    const lead = result.rows[0];
    if (req.user.role === 'employee' && lead.assigned_to !== req.user.id) {
      return res.status(403).json({ error: 'Access denied' });
    }

    const notes = await query(`
      SELECT n.*, u.name AS author_name
      FROM lead_notes n
      JOIN users u ON n.author_id = u.id
      WHERE n.lead_id = $1
      ORDER BY n.created_at DESC
    `, [req.params.id]);

    const history = await query(`
      SELECT h.*, u.name AS changed_by_name
      FROM lead_status_history h
      LEFT JOIN users u ON h.changed_by = u.id
      WHERE h.lead_id = $1
      ORDER BY h.changed_at DESC
    `, [req.params.id]);

    res.json({ lead, notes: notes.rows, history: history.rows });
  } catch (err) { next(err); }
});

// ─── POST /api/leads/upload  (Admin only, CSV or JSON) ──────────────────────
router.post('/upload', authenticate, requireAdmin, upload.single('file'), async (req, res, next) => {
  const client = await getClient();
  try {
    await client.query('BEGIN');

    const { employee_ids, source_platform = 'other', assign_equally = 'true' } = req.body;
    const employeeIds = JSON.parse(employee_ids || '[]');

    let rawLeads = [];

    if (req.file) {
      const content = req.file.buffer.toString('utf8');
      if (req.file.originalname.endsWith('.csv')) {
        rawLeads = parse(content, { columns: true, skip_empty_lines: true, trim: true });
      } else {
        rawLeads = JSON.parse(content);
      }
    } else if (req.body.leads_json) {
      rawLeads = JSON.parse(req.body.leads_json);  // direct JSON payload (Apify webhook)
    }

    if (!rawLeads.length) return res.status(400).json({ error: 'No leads found in upload' });

    // Create batch record
    const batchResult = await client.query(`
      INSERT INTO upload_batches (uploaded_by, file_name, source_platform, total_leads, assigned_to)
      VALUES ($1, $2, $3, $4, $5)
      RETURNING id
    `, [
      req.user.id,
      req.file?.originalname || 'api_upload',
      source_platform,
      rawLeads.length,
      employeeIds
    ]);

    const batchId = batchResult.rows[0].id;

    // Insert leads (without assignment yet)
    const insertedIds = [];
    for (const lead of rawLeads) {
      const r = await client.query(`
        INSERT INTO leads (
          batch_id, full_name, email, phone, company, job_title,
          location, website, linkedin_url, profile_image,
          source, source_url, apify_run_id, raw_data, status
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'new')
        RETURNING id
      `, [
        batchId,
        lead.full_name || lead.name || (lead.firstName && lead.lastName ? lead.firstName + ' ' + lead.lastName : lead.firstName || lead.lastName || null),
        lead.email || (lead.emails && lead.emails[0] ? lead.emails[0].email : null) || null,
        lead.phone || lead.phoneNumber || null,
        lead.company || lead.organization || (lead.currentPosition && lead.currentPosition[0] ? lead.currentPosition[0].companyName : null) || null,
        lead.job_title || lead.title || lead.headline || (lead.currentPosition && lead.currentPosition[0] ? lead.currentPosition[0].position : null) || null,
        lead.location && typeof lead.location === 'object' ? lead.location.linkedinText || lead.location.parsed?.text || null : lead.location || lead.city || null,
        lead.website || (lead.companyWebsites && lead.companyWebsites[0] ? lead.companyWebsites[0] : null) || null,
        lead.linkedin_url || lead.linkedinUrl || lead.profileUrl || null,
        lead.profile_image || (lead.profilePicture && lead.profilePicture.url ? lead.profilePicture.url : null) || lead.photo || null,
        source_platform,
        lead.source_url || lead.url || lead.linkedinUrl || null,
        lead.apify_run_id || null,
        JSON.stringify(lead)
      ]);
      insertedIds.push(r.rows[0].id);
    }

    // Assign leads equally if employees selected
    if (employeeIds.length && assign_equally === 'true') {
      const assignments = distributeLeads(insertedIds, employeeIds);
      for (const { employeeId, leads: leadBatch } of assignments) {
        if (!leadBatch.length) continue;
        // Use unnest for bulk update
        await client.query(`
          UPDATE leads
          SET assigned_to = $1
          WHERE id = ANY($2::uuid[])
        `, [employeeId, leadBatch]);
      }
    }

    await client.query('COMMIT');

    res.json({
      message: `${insertedIds.length} leads uploaded and assigned successfully`,
      batch_id: batchId,
      total: insertedIds.length,
      assigned_to: employeeIds
    });
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally {
    client.release();
  }
});

// ─── PATCH /api/leads/:id/status ────────────────────────────────────────────
router.patch('/:id/status', authenticate, async (req, res, next) => {
  const client = await getClient();
  try {
    await client.query('BEGIN');
    const { status } = req.body;

    const existing = await client.query('SELECT * FROM leads WHERE id = $1', [req.params.id]);
    if (!existing.rows.length) return res.status(404).json({ error: 'Lead not found' });

    const lead = existing.rows[0];
    if (req.user.role === 'employee' && lead.assigned_to !== req.user.id) {
      return res.status(403).json({ error: 'Access denied' });
    }

    // Extra timestamp fields
    const extras = {};
    if (status === 'contacted')  extras.contacted_at = 'NOW()';
    if (status === 'converted')  extras.converted_at = 'NOW()';

    const extraSql = Object.keys(extras).map(k => `, ${k} = ${extras[k]}`).join('');
    await client.query(
      `UPDATE leads SET status = $1 ${extraSql} WHERE id = $2`,
      [status, req.params.id]
    );

    await client.query(`
      INSERT INTO lead_status_history (lead_id, changed_by, from_status, to_status)
      VALUES ($1, $2, $3, $4)
    `, [req.params.id, req.user.id, lead.status, status]);

    await client.query('COMMIT');
    res.json({ message: 'Status updated', from: lead.status, to: status });
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally {
    client.release();
  }
});

// ─── POST /api/leads/:id/notes ───────────────────────────────────────────────
router.post('/:id/notes', authenticate, async (req, res, next) => {
  try {
    const { note } = req.body;
    if (!note?.trim()) return res.status(400).json({ error: 'Note cannot be empty' });

    const result = await query(`
      INSERT INTO lead_notes (lead_id, author_id, note)
      VALUES ($1, $2, $3)
      RETURNING *, (SELECT name FROM users WHERE id = $2) AS author_name
    `, [req.params.id, req.user.id, note.trim()]);

    res.status(201).json({ note: result.rows[0] });
  } catch (err) { next(err); }
});

// ─── PATCH /api/leads/:id/assign  (Admin only) ──────────────────────────────
router.patch('/:id/assign', authenticate, requireAdmin, async (req, res, next) => {
  try {
    const { employee_id } = req.body;
    // Set to null if reassignment employee_id is empty or null, otherwise to employee_id
    const assignedVal = employee_id || null;
    await query('UPDATE leads SET assigned_to = $1 WHERE id = $2', [assignedVal, req.params.id]);
    res.json({ message: 'Lead reassigned successfully' });
  } catch (err) { next(err); }
});

module.exports = router;
