const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const db = require('../db');
const { requireLogin, requirePermission } = require('../middleware/auth');
const { logAction } = require('../audit');
const { isManager, canManageUsers, roleLabel } = require('../permissions');
const { getSetting, setSetting } = require('../settings');

router.use(requireLogin);
router.use(requirePermission(canManageUsers));

const ROLE_OPTIONS = [
  { value: 'projects_manager', label: 'مدير المشاريع' },
  { value: 'site_officer', label: 'مسؤول الموقع' },
  { value: 'technical_office', label: 'المكتب الفني' },
  { value: 'accountant', label: 'المحاسب' },
  { value: 'employee', label: 'موظف (نظام قديم)' },
  { value: 'approver', label: 'معتمد (نظام قديم)' },
  { value: 'admin', label: 'مدير النظام (نظام قديم)' },
];

/* -------- إدارة المستخدمين -------- */
router.get('/users', async (req, res) => {
  const users = (await db.query(
    `SELECT id, name, email, role, job_title, active, can_approve, created_at, last_login_at FROM users ORDER BY created_at DESC`
  )).rows;
  const assignmentsRes = await db.query(
    `SELECT pa.user_id, p.name AS project_name FROM project_access pa JOIN projects p ON p.id = pa.project_id ORDER BY p.name`
  );
  const assignmentsByUser = {};
  assignmentsRes.rows.forEach(r => {
    if (!assignmentsByUser[r.user_id]) assignmentsByUser[r.user_id] = [];
    assignmentsByUser[r.user_id].push(r.project_name);
  });
  const allProjects = (await db.query(`SELECT id, name, code FROM projects WHERE status != 'archived' ORDER BY name`)).rows;
  res.render('admin/users', { users, error: null, roleOptions: ROLE_OPTIONS, roleLabel, assignmentsByUser, allProjects });
});

router.post('/users/new', async (req, res) => {
  const { name, email, password, role, job_title } = req.body;
  const admin = req.session.user;
  const projectIds = [].concat(req.body.project_ids || []);
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    const hash = await bcrypt.hash(password, 10);
    const canApproveFlag = role === 'approver'; // توافقًا مع النظام القديم فقط؛ يمكن تعديلها لاحقًا من الجدول
    const result = await client.query(
      `INSERT INTO users (name, email, password_hash, role, job_title, can_approve) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
      [name, email, hash, role, job_title || null, canApproveFlag]
    );
    const newUserId = result.rows[0].id;
    if (role === 'site_officer' && projectIds.length > 0) {
      for (const pid of projectIds) {
        await client.query(`INSERT INTO project_access (project_id, user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [pid, newUserId]);
      }
    }
    await client.query('COMMIT');
    await logAction({ action: 'تم إنشاء مستخدم جديد', actorId: admin.id, actorName: admin.name, details: `المستخدم: ${name} (${email}) — الدور: ${roleLabel(role)}` });
    res.redirect('/admin/users');
  } catch (e) {
    await client.query('ROLLBACK');
    console.error(e);
    const users = (await db.query('SELECT id, name, email, role, job_title, active, can_approve, created_at, last_login_at FROM users ORDER BY created_at DESC')).rows;
    const allProjects = (await db.query(`SELECT id, name, code FROM projects WHERE status != 'archived' ORDER BY name`)).rows;
    res.render('admin/users', { users, error: 'تعذر إنشاء المستخدم — تأكد أن البريد الإلكتروني غير مستخدم من قبل.', roleOptions: ROLE_OPTIONS, roleLabel, assignmentsByUser: {}, allProjects });
  } finally {
    client.release();
  }
});

router.post('/users/:id/toggle', async (req, res) => {
  const admin = req.session.user;
  const target = (await db.query('SELECT * FROM users WHERE id=$1', [req.params.id])).rows[0];
  if (!target) return res.redirect('/admin/users');
  await db.query('UPDATE users SET active = NOT active WHERE id=$1', [req.params.id]);
  await logAction({ action: target.active ? 'تم تعطيل مستخدم' : 'تم تفعيل مستخدم', actorId: admin.id, actorName: admin.name, details: `المستخدم: ${target.name}` });
  res.redirect('/admin/users');
});

router.post('/users/:id/role', async (req, res) => {
  const admin = req.session.user;
  const newRole = req.body.role;
  const target = (await db.query('SELECT * FROM users WHERE id=$1', [req.params.id])).rows[0];
  if (!target) return res.redirect('/admin/users');
  await db.query('UPDATE users SET role = $1 WHERE id=$2', [newRole, req.params.id]);
  await logAction({
    action: 'تغيير دور مستخدم', actorId: admin.id, actorName: admin.name,
    details: `المستخدم: ${target.name} — من ${roleLabel(target.role)} إلى ${roleLabel(newRole)}`,
  });
  res.redirect('/admin/users');
});

router.post('/users/:id/can-approve/toggle', async (req, res) => {
  const admin = req.session.user;
  const target = (await db.query('SELECT * FROM users WHERE id=$1', [req.params.id])).rows[0];
  if (!target) return res.redirect('/admin/users');
  await db.query('UPDATE users SET can_approve = NOT can_approve WHERE id=$1', [req.params.id]);
  await logAction({
    action: target.can_approve ? 'إزالة صلاحية الاعتماد' : 'منح صلاحية الاعتماد',
    actorId: admin.id, actorName: admin.name, details: `المستخدم: ${target.name}`,
  });
  res.redirect('/admin/users');
});

/* -------- إدارة المشاريع المسندة لمستخدم (لمسؤولي المواقع بشكل أساسي) -------- */
router.get('/users/:id/projects', async (req, res) => {
  const target = (await db.query('SELECT * FROM users WHERE id=$1', [req.params.id])).rows[0];
  if (!target) return res.status(404).render('error', { title: 'غير موجود', message: 'المستخدم غير موجود.' });
  const granted = (await db.query(
    `SELECT p.id, p.name, p.code FROM project_access pa JOIN projects p ON p.id = pa.project_id WHERE pa.user_id = $1 ORDER BY p.name`,
    [req.params.id]
  )).rows;
  const allProjects = (await db.query(`SELECT id, name, code FROM projects WHERE status != 'archived' ORDER BY name`)).rows;
  res.render('admin/user_projects', { target, granted, allProjects });
});

router.post('/users/:id/projects/add', async (req, res) => {
  const admin = req.session.user;
  const target = (await db.query('SELECT * FROM users WHERE id=$1', [req.params.id])).rows[0];
  if (req.body.project_id && target) {
    await db.query(`INSERT INTO project_access (project_id, user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [req.body.project_id, req.params.id]);
    await logAction({ action: 'إسناد مشروع لمستخدم', actorId: admin.id, actorName: admin.name, details: `المستخدم: ${target.name}, Project ID: ${req.body.project_id}` });
  }
  res.redirect(`/admin/users/${req.params.id}/projects`);
});

router.post('/users/:id/projects/:projectId/remove', async (req, res) => {
  const admin = req.session.user;
  const target = (await db.query('SELECT * FROM users WHERE id=$1', [req.params.id])).rows[0];
  await db.query(`DELETE FROM project_access WHERE project_id=$1 AND user_id=$2`, [req.params.projectId, req.params.id]);
  await logAction({ action: 'إزالة إسناد مشروع من مستخدم', actorId: admin.id, actorName: admin.name, details: target ? `المستخدم: ${target.name}, Project ID: ${req.params.projectId}` : null });
  res.redirect(`/admin/users/${req.params.id}/projects`);
});

/* -------- جميع أوامر التعميد (من جميع المشاريع) -------- */
router.get('/orders', async (req, res) => {
  const STATUS_LABELS = {
    draft: 'مسودة', pending_approval: 'بانتظار الاعتماد', approved: 'معتمد',
    rejected: 'مرفوض', returned_for_edit: 'معاد للتعديل',
  };
  const params = [];
  let filter = '';
  if (req.query.project_id) { params.push(req.query.project_id); filter += ` AND o.project_id = $${params.length}`; }
  if (req.query.status) { params.push(req.query.status); filter += ` AND o.status = $${params.length}`; }
  if (req.query.q) {
    params.push(`%${req.query.q}%`);
    filter += ` AND (o.scope ILIKE $${params.length} OR o.order_no ILIKE $${params.length} OR o.project_order_no ILIKE $${params.length} OR o.contractor_name ILIKE $${params.length})`;
  }
  const rows = (await db.query(
    `SELECT o.*, u.name AS creator_name, p.name AS project_name_rel, p.code AS project_code
     FROM orders o JOIN users u ON u.id = o.created_by LEFT JOIN projects p ON p.id = o.project_id
     WHERE 1=1 ${filter}
     ORDER BY o.created_at DESC`,
    params
  )).rows;
  const projects = (await db.query('SELECT id, name, code FROM projects ORDER BY name')).rows;
  res.render('admin/orders', { orders: rows, statusLabels: STATUS_LABELS, projects, q: req.query });
});

/* -------- سجل العمليات — للعرض فقط، لا يوجد أي مسار للتعديل أو الحذف -------- */
router.get('/audit-log', async (req, res) => {
  const rows = (await db.query(
    `SELECT a.*, o.order_no FROM audit_log a LEFT JOIN orders o ON o.id = a.order_id ORDER BY a.created_at DESC LIMIT 500`
  )).rows;
  res.render('admin/audit', { logs: rows });
});

/* -------- إعدادات مستويات الاعتماد + نسبة ضريبة المستخلصات الافتراضية -------- */
router.get('/settings', async (req, res) => {
  const levels = (await db.query('SELECT * FROM approval_levels_config ORDER BY level_number')).rows;
  const defaultCertVat = await getSetting('default_cert_vat_rate', '15');
  res.render('admin/settings', { levels, error: null, defaultCertVat });
});

router.post('/settings/cert-vat', async (req, res) => {
  const admin = req.session.user;
  await setSetting('default_cert_vat_rate', req.body.default_cert_vat_rate || '15');
  await logAction({ action: 'تعديل نسبة الضريبة الافتراضية للمستخلصات', actorId: admin.id, actorName: admin.name, details: `القيمة الجديدة: ${req.body.default_cert_vat_rate}%` });
  res.redirect('/admin/settings');
});

router.post('/settings/levels/new', async (req, res) => {
  const admin = req.session.user;
  const { level_number, level_name, required_role } = req.body;
  try {
    await db.query(
      `INSERT INTO approval_levels_config (level_number, level_name, required_role, active) VALUES ($1,$2,$3,true)`,
      [parseInt(level_number, 10), level_name, required_role || 'approver']
    );
    await logAction({ action: 'إضافة مستوى اعتماد', actorId: admin.id, actorName: admin.name, details: `المستوى ${level_number}: ${level_name}` });
  } catch (e) {
    console.error(e);
  }
  res.redirect('/admin/settings');
});

router.post('/settings/levels/:id/toggle', async (req, res) => {
  const admin = req.session.user;
  const lvl = (await db.query('SELECT * FROM approval_levels_config WHERE id=$1', [req.params.id])).rows[0];
  if (lvl) {
    await db.query('UPDATE approval_levels_config SET active = NOT active WHERE id=$1', [req.params.id]);
    await logAction({ action: lvl.active ? 'تعطيل مستوى اعتماد' : 'تفعيل مستوى اعتماد', actorId: admin.id, actorName: admin.name, details: lvl.level_name });
  }
  res.redirect('/admin/settings');
});

module.exports = router;
