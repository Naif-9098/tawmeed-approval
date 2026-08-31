const express = require('express');
const router = express.Router();
const db = require('../db');
const { requireLogin, requireRole } = require('../middleware/auth');
const { logAction } = require('../audit');
const { getAccessibleProjectIds, canAccessProject } = require('../projectAccess');

const PROJECT_STATUS_LABELS = {
  active: 'نشط', stopped: 'متوقف', completed: 'مكتمل', archived: 'مؤرشف',
};
const ORDER_STATUS_LABELS = {
  draft: 'مسودة', pending_approval: 'بانتظار الاعتماد', approved: 'معتمد',
  rejected: 'مرفوض', returned_for_edit: 'معاد للتعديل',
};

router.use(requireLogin);

async function approversList() {
  return (await db.query(
    `SELECT id, name FROM users WHERE role IN ('approver','admin') AND active = true ORDER BY name`
  )).rows;
}

/* -------- قائمة المشاريع (Cards) -------- */
router.get('/', async (req, res) => {
  const user = req.session.user;
  const ids = await getAccessibleProjectIds(user);
  const params = [];
  let where = '1=1';
  if (ids !== null) {
    params.push(ids);
    where += ` AND p.id = ANY($${params.length})`;
  }
  const rows = (await db.query(`
    SELECT p.*,
      (SELECT COUNT(*) FROM orders o WHERE o.project_id = p.id) AS order_count,
      (SELECT COALESCE(SUM(o.grand_total),0) FROM orders o WHERE o.project_id = p.id) AS total_value,
      (SELECT COUNT(*) FROM orders o WHERE o.project_id = p.id AND o.status = 'pending_approval') AS pending_count
    FROM projects p
    WHERE ${where}
    ORDER BY (p.status = 'archived'), p.created_at DESC
  `, params)).rows;
  res.render('projects/list', { projects: rows, statusLabels: PROJECT_STATUS_LABELS });
});

/* -------- إنشاء مشروع (مدير النظام فقط) -------- */
router.get('/new', requireRole('admin'), async (req, res) => {
  res.render('projects/form', { project: null, mode: 'new', error: null, approvers: await approversList() });
});

router.post('/new', requireRole('admin'), async (req, res) => {
  const user = req.session.user;
  const b = req.body;
  try {
    const result = await db.query(`
      INSERT INTO projects (name, code, client_name, location, project_manager, start_date, end_date, status, notes, responsible_approver_id, created_by)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id
    `, [b.name, b.code, b.client_name, b.location, b.project_manager, b.start_date || null, b.end_date || null,
        b.status || 'active', b.notes, b.responsible_approver_id || null, user.id]);
    const projectId = result.rows[0].id;
    await logAction({ action: 'تم إنشاء مشروع جديد', actorId: user.id, actorName: user.name, details: `المشروع: ${b.name} (${b.code})` });
    res.redirect(`/projects/${projectId}`);
  } catch (e) {
    console.error(e);
    res.render('projects/form', {
      project: null, mode: 'new',
      error: 'تعذر إنشاء المشروع — تأكد أن كود المشروع غير مستخدم من قبل، وأن كل الحقول المطلوبة معبأة.',
      approvers: await approversList(),
    });
  }
});

/* -------- تعديل مشروع (مدير النظام فقط) -------- */
router.get('/:id/edit', requireRole('admin'), async (req, res) => {
  const project = (await db.query('SELECT * FROM projects WHERE id=$1', [req.params.id])).rows[0];
  if (!project) return res.status(404).render('error', { title: 'غير موجود', message: 'المشروع غير موجود.' });
  res.render('projects/form', { project, mode: 'edit', error: null, approvers: await approversList() });
});

router.post('/:id/edit', requireRole('admin'), async (req, res) => {
  const user = req.session.user;
  const b = req.body;
  try {
    await db.query(`
      UPDATE projects SET name=$1, code=$2, client_name=$3, location=$4, project_manager=$5,
        start_date=$6, end_date=$7, status=$8, notes=$9, responsible_approver_id=$10, updated_at=now()
      WHERE id=$11
    `, [b.name, b.code, b.client_name, b.location, b.project_manager, b.start_date || null, b.end_date || null,
        b.status, b.notes, b.responsible_approver_id || null, req.params.id]);
    await logAction({ action: 'تم تعديل بيانات المشروع', actorId: user.id, actorName: user.name, details: `المشروع: ${b.name} (${b.code})` });
    res.redirect(`/projects/${req.params.id}`);
  } catch (e) {
    console.error(e);
    const project = (await db.query('SELECT * FROM projects WHERE id=$1', [req.params.id])).rows[0];
    res.render('projects/form', {
      project, mode: 'edit', error: 'تعذر حفظ التعديلات — تأكد أن كود المشروع غير مستخدم من قبل مشروع آخر.',
      approvers: await approversList(),
    });
  }
});

/* -------- أرشفة / إعادة تفعيل (مدير النظام فقط) -------- */
router.post('/:id/archive', requireRole('admin'), async (req, res) => {
  const user = req.session.user;
  const project = (await db.query('SELECT * FROM projects WHERE id=$1', [req.params.id])).rows[0];
  await db.query(`UPDATE projects SET status='archived', updated_at=now() WHERE id=$1`, [req.params.id]);
  await logAction({ action: 'تمت أرشفة المشروع', actorId: user.id, actorName: user.name, details: project ? `${project.name} (${project.code})` : req.params.id });
  res.redirect(`/projects/${req.params.id}`);
});

router.post('/:id/activate', requireRole('admin'), async (req, res) => {
  const user = req.session.user;
  const project = (await db.query('SELECT * FROM projects WHERE id=$1', [req.params.id])).rows[0];
  await db.query(`UPDATE projects SET status='active', updated_at=now() WHERE id=$1`, [req.params.id]);
  await logAction({ action: 'تمت إعادة تفعيل المشروع', actorId: user.id, actorName: user.name, details: project ? `${project.name} (${project.code})` : req.params.id });
  res.redirect(`/projects/${req.params.id}`);
});

/* -------- إدارة صلاحيات الوصول للمشروع (مدير النظام فقط) -------- */
router.get('/:id/access', requireRole('admin'), async (req, res) => {
  const project = (await db.query('SELECT * FROM projects WHERE id=$1', [req.params.id])).rows[0];
  if (!project) return res.status(404).render('error', { title: 'غير موجود', message: 'المشروع غير موجود.' });
  const granted = (await db.query(
    `SELECT u.id, u.name, u.role FROM project_access pa JOIN users u ON u.id = pa.user_id WHERE pa.project_id = $1 ORDER BY u.name`,
    [req.params.id]
  )).rows;
  const allUsers = (await db.query(`SELECT id, name, role FROM users WHERE active = true ORDER BY name`)).rows;
  res.render('projects/access', { project, granted, allUsers });
});

router.post('/:id/access/add', requireRole('admin'), async (req, res) => {
  const user = req.session.user;
  if (req.body.user_id) {
    await db.query(`INSERT INTO project_access (project_id, user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [req.params.id, req.body.user_id]);
    await logAction({ action: 'منح صلاحية وصول لمشروع', actorId: user.id, actorName: user.name, details: `Project ID: ${req.params.id}, User ID: ${req.body.user_id}` });
  }
  res.redirect(`/projects/${req.params.id}/access`);
});

router.post('/:id/access/:userId/remove', requireRole('admin'), async (req, res) => {
  const user = req.session.user;
  await db.query(`DELETE FROM project_access WHERE project_id=$1 AND user_id=$2`, [req.params.id, req.params.userId]);
  await logAction({ action: 'إزالة صلاحية وصول لمشروع', actorId: user.id, actorName: user.name, details: `Project ID: ${req.params.id}, User ID: ${req.params.userId}` });
  res.redirect(`/projects/${req.params.id}/access`);
});

/* -------- إنشاء أمر تعميد داخل المشروع (يعرض نفس نموذج الأمر مع سياق المشروع) -------- */
router.get('/:id/orders/new', async (req, res) => {
  const user = req.session.user;
  const project = (await db.query('SELECT * FROM projects WHERE id=$1', [req.params.id])).rows[0];
  if (!project) return res.status(404).render('error', { title: 'غير موجود', message: 'المشروع غير موجود.' });
  if (!(await canAccessProject(user, project.id))) {
    return res.status(403).render('error', { title: 'غير مصرح', message: 'ليست لديك صلاحية الوصول لهذا المشروع.' });
  }
  if (project.status === 'archived') {
    return res.status(400).render('error', { title: 'مشروع مؤرشف', message: 'لا يمكن إنشاء أوامر جديدة داخل مشروع مؤرشف. أعد تفعيله أولاً من صفحة المشروع.' });
  }
  res.render('orders/form', { order: null, items: [], payments: [], mode: 'new', error: null, project });
});

/* -------- صفحة المشروع (نظرة عامة / الأوامر / بانتظار الاعتماد / المعتمدة / المرفوضة / الملفات / سجل النشاط) -------- */
router.get('/:id', async (req, res) => {
  const user = req.session.user;
  const projectId = req.params.id;
  const project = (await db.query('SELECT * FROM projects WHERE id=$1', [projectId])).rows[0];
  if (!project) return res.status(404).render('error', { title: 'غير موجود', message: 'المشروع غير موجود.' });
  if (!(await canAccessProject(user, projectId))) {
    return res.status(403).render('error', { title: 'غير مصرح', message: 'ليست لديك صلاحية الوصول لهذا المشروع.' });
  }

  const tab = ['overview', 'orders', 'pending', 'approved', 'rejected', 'files', 'activity'].includes(req.query.tab)
    ? req.query.tab : 'overview';

  const stats = (await db.query(`
    SELECT
      COUNT(*) AS order_count,
      COALESCE(SUM(grand_total),0) AS total_value,
      COALESCE(SUM(grand_total) FILTER (WHERE status='approved'),0) AS approved_value,
      COALESCE(SUM(grand_total) FILTER (WHERE status='pending_approval'),0) AS pending_value,
      COUNT(*) FILTER (WHERE status='rejected') AS rejected_count
    FROM orders WHERE project_id = $1
  `, [projectId])).rows[0];

  const recentOrders = (await db.query(`
    SELECT o.*, u.name AS creator_name FROM orders o JOIN users u ON u.id = o.created_by
    WHERE o.project_id = $1 ORDER BY o.created_at DESC LIMIT 5
  `, [projectId])).rows;

  let orders = [];
  if (['orders', 'pending', 'approved', 'rejected'].includes(tab)) {
    const params = [projectId];
    let statusFilter = '';
    if (tab === 'pending') statusFilter = `AND o.status = 'pending_approval'`;
    if (tab === 'approved') statusFilter = `AND o.status = 'approved'`;
    if (tab === 'rejected') statusFilter = `AND o.status = 'rejected'`;

    let searchFilter = '';
    if (req.query.q) {
      params.push(`%${req.query.q}%`);
      const p = params.length;
      searchFilter = ` AND (o.scope ILIKE $${p} OR o.project_order_no ILIKE $${p} OR o.order_no ILIKE $${p}
        OR o.contractor_name ILIKE $${p} OR EXISTS (SELECT 1 FROM order_items oi WHERE oi.order_id = o.id AND oi.description ILIKE $${p}))`;
    }
    let extraFilter = '';
    if (req.query.status) { params.push(req.query.status); extraFilter += ` AND o.status = $${params.length}`; }
    if (req.query.contractor) { params.push(`%${req.query.contractor}%`); extraFilter += ` AND o.contractor_name ILIKE $${params.length}`; }
    if (req.query.creator) { params.push(req.query.creator); extraFilter += ` AND o.created_by = $${params.length}`; }
    if (req.query.approver) { params.push(req.query.approver); extraFilter += ` AND o.assigned_approver_id = $${params.length}`; }
    if (req.query.date_from) { params.push(req.query.date_from); extraFilter += ` AND o.order_date >= $${params.length}`; }
    if (req.query.date_to) { params.push(req.query.date_to); extraFilter += ` AND o.order_date <= $${params.length}`; }

    orders = (await db.query(`
      SELECT o.*, u.name AS creator_name, au.name AS approver_name
      FROM orders o
      JOIN users u ON u.id = o.created_by
      LEFT JOIN users au ON au.id = o.assigned_approver_id
      WHERE o.project_id = $1 ${statusFilter} ${searchFilter} ${extraFilter}
      ORDER BY o.created_at DESC
    `, params)).rows;
  }

  let activity = [];
  if (tab === 'activity') {
    activity = (await db.query(`
      SELECT a.* FROM audit_log a
      WHERE a.order_id IN (SELECT id FROM orders WHERE project_id = $1)
      ORDER BY a.created_at DESC LIMIT 300
    `, [projectId])).rows;
  }

  const creators = (await db.query(
    `SELECT DISTINCT u.id, u.name FROM orders o JOIN users u ON u.id = o.created_by WHERE o.project_id = $1 ORDER BY u.name`,
    [projectId]
  )).rows;

  res.render('projects/view', {
    project, tab, stats, recentOrders, orders, activity, creators,
    approversList: await approversList(),
    statusLabels: PROJECT_STATUS_LABELS, orderStatusLabels: ORDER_STATUS_LABELS,
    q: req.query,
    canManage: user.role === 'admin',
  });
});

module.exports = router;
