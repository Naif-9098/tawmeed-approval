const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const db = require('../db');
const { requireLogin, requireRole } = require('../middleware/auth');
const { logAction } = require('../audit');

router.use(requireLogin);
router.use(requireRole('admin'));

/* -------- إدارة المستخدمين -------- */
router.get('/users', async (req, res) => {
  const users = (await db.query('SELECT id, name, email, role, job_title, active, created_at FROM users ORDER BY created_at DESC')).rows;
  res.render('admin/users', { users, error: null });
});

router.post('/users/new', async (req, res) => {
  const { name, email, password, role, job_title } = req.body;
  const admin = req.session.user;
  try {
    const hash = await bcrypt.hash(password, 10);
    await db.query(
      `INSERT INTO users (name, email, password_hash, role, job_title) VALUES ($1,$2,$3,$4,$5)`,
      [name, email, hash, role, job_title || null]
    );
    await logAction({ action: 'تم إنشاء مستخدم جديد', actorId: admin.id, actorName: admin.name, details: `المستخدم: ${name} (${email}) — الدور: ${role}` });
    res.redirect('/admin/users');
  } catch (e) {
    console.error(e);
    const users = (await db.query('SELECT id, name, email, role, job_title, active, created_at FROM users ORDER BY created_at DESC')).rows;
    res.render('admin/users', { users, error: 'تعذر إنشاء المستخدم — تأكد أن البريد الإلكتروني غير مستخدم من قبل.' });
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

/* -------- جميع أوامر التعميد -------- */
router.get('/orders', async (req, res) => {
  const STATUS_LABELS = {
    draft: 'مسودة', pending_approval: 'بانتظار الاعتماد', approved: 'معتمد',
    rejected: 'مرفوض', returned_for_edit: 'معاد للتعديل',
  };
  const rows = (await db.query(
    `SELECT o.*, u.name AS creator_name FROM orders o JOIN users u ON u.id=o.created_by ORDER BY o.created_at DESC`
  )).rows;
  res.render('admin/orders', { orders: rows, statusLabels: STATUS_LABELS });
});

/* -------- سجل العمليات — للعرض فقط، لا يوجد أي مسار للتعديل أو الحذف -------- */
router.get('/audit-log', async (req, res) => {
  const rows = (await db.query(
    `SELECT a.*, o.order_no FROM audit_log a LEFT JOIN orders o ON o.id = a.order_id ORDER BY a.created_at DESC LIMIT 500`
  )).rows;
  res.render('admin/audit', { logs: rows });
});

/* -------- إعدادات مستويات الاعتماد -------- */
router.get('/settings', async (req, res) => {
  const levels = (await db.query('SELECT * FROM approval_levels_config ORDER BY level_number')).rows;
  res.render('admin/settings', { levels, error: null });
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
