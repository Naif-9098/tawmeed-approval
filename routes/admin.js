const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const db = require('../db');
const { requireLogin, requirePermission } = require('../middleware/auth');
const { logAction } = require('../audit');
const P = require('../permissions');
const { canManageUsers, canManagePermissions, canManageSettings, canViewAuditLog, canListAllOrders, roleLabel } = P;
const engine = require('../permission_engine');
const { getSetting, setSetting } = require('../settings');

// لا حارس واحد لكل القسم بعد الآن: كل مسار محمي بصلاحيته المحددة.
router.use(requireLogin);

// صلاحيات «الاعتماد» التي كان يمثلها علم can_approve القديم (أوامر + مستخلصات)
const APPROVAL_KEYS = ['ORDER_APPROVE', 'ORDER_REJECT', 'ORDER_RETURN', 'CERTIFICATE_APPROVE', 'CERTIFICATE_REJECT', 'CERTIFICATE_RETURN'];
const SENSITIVE_TEMPLATE_KEYS = ['PERMISSIONS_MANAGE', 'USERS_MANAGE'];

// القوالب الوظيفية من قاعدة البيانات (القوالب الأساسية = الأدوار الحالية + أي قوالب جديدة)
async function roleOptions() {
  return (await db.query(
    `SELECT code AS value, name AS label,
            EXISTS (SELECT 1 FROM role_permissions rp WHERE rp.role_code = code AND rp.perm_key = 'PROJECT_VIEW_ALL') AS sees_all
       FROM permission_roles ORDER BY is_system DESC, name`)).rows;
}
async function roleNames() {
  const m = {}; (await roleOptions()).forEach((r) => (m[r.value] = r.label)); return m;
}
function failPage(res, e) {
  return res.status(e.status || 500).render('error', { title: 'لم يتم الحفظ', message: e.status ? e.message : 'تعذّر تنفيذ العملية.' });
}
async function renderUsers(res, error) {
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
  const approvers = new Set((await engine.usersWithPermission(db, 'ORDER_APPROVE')).map((u) => u.id));
  users.forEach((u) => (u.effective_approve = approvers.has(u.id)));
  const allProjects = (await db.query(`SELECT id, name, code FROM projects WHERE status != 'archived' ORDER BY name`)).rows;
  const names = await roleNames();
  res.render('admin/users', {
    users, error, roleOptions: await roleOptions(), roleLabel: (r) => names[r] || roleLabel(r),
    assignmentsByUser, allProjects,
  });
}

/* -------- إدارة المستخدمين -------- */
router.get('/users', requirePermission(canManageUsers), async (req, res) => {
  await renderUsers(res, null);
});

router.post('/users/new', requirePermission(canManageUsers), async (req, res) => {
  const { name, email, password, role, job_title } = req.body;
  const admin = req.session.user;
  const projectIds = [].concat(req.body.project_ids || []);
  const template = (await db.query('SELECT code, name FROM permission_roles WHERE code = $1', [role])).rows[0];
  if (!template) return renderUsers(res.status(400), 'القالب الوظيفي المختار غير موجود.');
  const tplKeys = (await db.query('SELECT perm_key FROM role_permissions WHERE role_code = $1', [role])).rows.map((r) => r.perm_key);
  // منع تصعيد الصلاحيات: من لا يملك «إدارة الصلاحيات» لا ينشئ حساباً بقالب يدير المستخدمين/الصلاحيات
  if (!canManagePermissions(admin) && tplKeys.some((k) => SENSITIVE_TEMPLATE_KEYS.includes(k))) {
    return renderUsers(res.status(403), 'إنشاء حساب بهذا القالب يتطلب صلاحية «إدارة الصلاحيات والقوالب الوظيفية».');
  }
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    const hash = await bcrypt.hash(password, 10);
    const canApproveFlag = tplKeys.includes('ORDER_APPROVE'); // عمود توافق فقط — مطابق لصلاحيات القالب
    const result = await client.query(
      `INSERT INTO users (name, email, password_hash, role, job_title, can_approve) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
      [name, email, hash, role, job_title || null, canApproveFlag]
    );
    const newUserId = result.rows[0].id;
    // إسناد مشاريع عند الإنشاء: متاح لأي قالب لا يرى كل المشاريع (مثل مسؤول الموقع)
    if (!tplKeys.includes('PROJECT_VIEW_ALL') && projectIds.length > 0) {
      for (const pid of projectIds) {
        await client.query(`INSERT INTO project_access (project_id, user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [pid, newUserId]);
      }
    }
    await client.query('COMMIT');
    await logAction({ action: 'تم إنشاء مستخدم جديد', actorId: admin.id, actorName: admin.name, details: `المستخدم: ${name} (${email}) — القالب الوظيفي: ${template.name}` });
    res.redirect('/admin/users');
  } catch (e) {
    await client.query('ROLLBACK');
    console.error(e);
    await renderUsers(res, 'تعذر إنشاء المستخدم — تأكد أن البريد الإلكتروني غير مستخدم من قبل.');
  } finally {
    client.release();
  }
});

// تفعيل/تعطيل حساب — مع حارس منع القفل: لا تعطيل للحساب نفسه ولا لآخر من يدير الصلاحيات.
router.post('/users/:id/toggle', requirePermission(canManageUsers), async (req, res) => {
  const admin = req.session.user;
  const id = parseInt(req.params.id, 10);
  const target = (await db.query('SELECT * FROM users WHERE id=$1', [id])).rows[0];
  if (!target) return res.redirect('/admin/users');
  if (target.active && id === admin.id) return failPage(res, { status: 409, message: 'لا يمكنك تعطيل حسابك أنت.' });
  try {
    await engine.tx(db, async (repo) => {
      const st = await engine.stateOf(repo, id);
      await repo.audit(admin, target.active ? 'تم تعطيل مستخدم' : 'تم تفعيل مستخدم', 'المستخدم: ' + target.name);
      await repo.setActive(id, !target.active);
      if (target.active && st.effective.has('PERMISSIONS_MANAGE') && (await repo.countHolders('PERMISSIONS_MANAGE')) < 1) {
        const e = new Error('لا يمكن تعطيل آخر حساب مفعّل يملك «إدارة الصلاحيات».'); e.status = 409; throw e;
      }
    });
    res.redirect('/admin/users');
  } catch (e) { failPage(res, e); }
});

// تغيير القالب الوظيفي = تغيير صلاحيات ← يتطلب «إدارة الصلاحيات» (مع حارس منع القفل)
router.post('/users/:id/role', requirePermission(canManagePermissions), async (req, res) => {
  try {
    await engine.tx(db, (repo) => engine.setRole(repo, parseInt(req.params.id, 10), String(req.body.role || ''), req.session.user));
    res.redirect('/admin/users');
  } catch (e) { failPage(res, e); }
});

// زر «صلاحية الاعتماد» القديم: يمنح/يسحب صلاحيات الاعتماد الست كاستثناء على القالب
router.post('/users/:id/can-approve/toggle', requirePermission(canManagePermissions), async (req, res) => {
  const id = parseInt(req.params.id, 10);
  try {
    await engine.tx(db, async (repo) => {
      const st = await engine.stateOf(repo, id);
      if (!st) { const e = new Error('المستخدم غير موجود'); e.status = 404; throw e; }
      return engine.setGroup(repo, id, APPROVAL_KEYS, !st.effective.has('ORDER_APPROVE'), req.session.user);
    });
    res.redirect('/admin/users');
  } catch (e) { failPage(res, e); }
});

/* -------- إدارة المشاريع المسندة لمستخدم (لمسؤولي المواقع بشكل أساسي) -------- */
router.get('/users/:id/projects', requirePermission(canManageUsers), async (req, res) => {
  const target = (await db.query('SELECT * FROM users WHERE id=$1', [req.params.id])).rows[0];
  if (!target) return res.status(404).render('error', { title: 'غير موجود', message: 'المستخدم غير موجود.' });
  const granted = (await db.query(
    `SELECT p.id, p.name, p.code FROM project_access pa JOIN projects p ON p.id = pa.project_id WHERE pa.user_id = $1 ORDER BY p.name`,
    [req.params.id]
  )).rows;
  const allProjects = (await db.query(`SELECT id, name, code FROM projects WHERE status != 'archived' ORDER BY name`)).rows;
  const tp = await engine.loadUserPermissions(db, target.id);
  const targetScope = tp && tp.keys.has('PROJECT_VIEW_ALL') ? 'all' : (tp && tp.keys.has('PROJECT_VIEW_OPEN') ? 'open' : 'assigned');
  res.render('admin/user_projects', { target, granted, allProjects, targetScope });
});

router.post('/users/:id/projects/add', requirePermission(canManageUsers), async (req, res) => {
  const admin = req.session.user;
  const target = (await db.query('SELECT * FROM users WHERE id=$1', [req.params.id])).rows[0];
  if (req.body.project_id && target) {
    await db.query(`INSERT INTO project_access (project_id, user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [req.body.project_id, req.params.id]);
    await logAction({ action: 'إسناد مشروع لمستخدم', actorId: admin.id, actorName: admin.name, details: `المستخدم: ${target.name}, Project ID: ${req.body.project_id}` });
  }
  res.redirect(`/admin/users/${req.params.id}/projects`);
});

router.post('/users/:id/projects/:projectId/remove', requirePermission(canManageUsers), async (req, res) => {
  const admin = req.session.user;
  const target = (await db.query('SELECT * FROM users WHERE id=$1', [req.params.id])).rows[0];
  await db.query(`DELETE FROM project_access WHERE project_id=$1 AND user_id=$2`, [req.params.projectId, req.params.id]);
  await logAction({ action: 'إزالة إسناد مشروع من مستخدم', actorId: admin.id, actorName: admin.name, details: target ? `المستخدم: ${target.name}, Project ID: ${req.params.projectId}` : null });
  res.redirect(`/admin/users/${req.params.id}/projects`);
});

/* -------- جميع أوامر التعميد (من جميع المشاريع) -------- */
router.get('/orders', requirePermission(canListAllOrders), async (req, res) => {
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
router.get('/audit-log', requirePermission(canViewAuditLog), async (req, res) => {
  const rows = (await db.query(
    `SELECT a.*, o.order_no FROM audit_log a LEFT JOIN orders o ON o.id = a.order_id ORDER BY a.created_at DESC LIMIT 500`
  )).rows;
  res.render('admin/audit', { logs: rows });
});

/* -------- إعدادات مستويات الاعتماد + نسبة ضريبة المستخلصات الافتراضية -------- */
router.get('/settings', requirePermission(canManageSettings), async (req, res) => {
  const levels = (await db.query('SELECT * FROM approval_levels_config ORDER BY level_number')).rows;
  const defaultCertVat = await getSetting('default_cert_vat_rate', '15');
  res.render('admin/settings', { levels, error: null, defaultCertVat });
});

router.post('/settings/cert-vat', requirePermission(canManageSettings), async (req, res) => {
  const admin = req.session.user;
  await setSetting('default_cert_vat_rate', req.body.default_cert_vat_rate || '15');
  await logAction({ action: 'تعديل نسبة الضريبة الافتراضية للمستخلصات', actorId: admin.id, actorName: admin.name, details: `القيمة الجديدة: ${req.body.default_cert_vat_rate}%` });
  res.redirect('/admin/settings');
});

router.post('/settings/levels/new', requirePermission(canManageSettings), async (req, res) => {
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

router.post('/settings/levels/:id/toggle', requirePermission(canManageSettings), async (req, res) => {
  const admin = req.session.user;
  const lvl = (await db.query('SELECT * FROM approval_levels_config WHERE id=$1', [req.params.id])).rows[0];
  if (lvl) {
    await db.query('UPDATE approval_levels_config SET active = NOT active WHERE id=$1', [req.params.id]);
    await logAction({ action: lvl.active ? 'تعطيل مستوى اعتماد' : 'تفعيل مستوى اعتماد', actorId: admin.id, actorName: admin.name, details: lvl.level_name });
  }
  res.redirect('/admin/settings');
});

module.exports = router;
