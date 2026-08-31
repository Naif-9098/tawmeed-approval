const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');
const QRCode = require('qrcode');
const db = require('../db');
const { requireLogin, requirePermission } = require('../middleware/auth');
const { logAction } = require('../audit');
const { canAccessProject } = require('../projectAccess');
const { isManager, seesAllProjects, ownOrdersOnly, canCreateOrders, canTransferFinancial, canApprove } = require('../permissions');

const STATUS_LABELS = {
  draft: 'مسودة',
  pending_approval: 'بانتظار الاعتماد',
  approved: 'معتمد',
  rejected: 'مرفوض',
  returned_for_edit: 'معاد للتعديل',
};

const CERT_STATUS_LABELS = {
  draft: 'مسودة',
  pending_review: 'بانتظار المراجعة',
  approved: 'معتمد',
  rejected: 'مرفوض',
  returned_for_edit: 'معاد للتعديل',
  transferred: 'محول للمحاسبة',
  paid: 'تم الصرف',
};

async function getOrderFull(orderId) {
  const orderRes = await db.query(
    `SELECT o.*, p.name AS project_name_rel, p.code AS project_code
     FROM orders o LEFT JOIN projects p ON p.id = o.project_id WHERE o.id = $1`,
    [orderId]
  );
  const order = orderRes.rows[0];
  if (!order) return null;
  const items = (await db.query('SELECT * FROM order_items WHERE order_id = $1 ORDER BY seq', [orderId])).rows;
  const payments = (await db.query('SELECT * FROM order_payments WHERE order_id = $1 ORDER BY seq', [orderId])).rows;
  const steps = (await db.query('SELECT * FROM order_approval_steps WHERE order_id = $1 ORDER BY level_number', [orderId])).rows;
  const audit = (await db.query('SELECT * FROM audit_log WHERE order_id = $1 ORDER BY created_at ASC', [orderId])).rows;
  const creator = (await db.query('SELECT name, job_title FROM users WHERE id = $1', [order.created_by])).rows[0];
  const assignedApprover = order.assigned_approver_id
    ? (await db.query('SELECT id, name FROM users WHERE id = $1', [order.assigned_approver_id])).rows[0]
    : null;
  const financial = (await db.query(
    `SELECT f.*, u.name AS accountant_name FROM financial_records f JOIN users u ON u.id = f.accountant_id
     WHERE f.order_id = $1 ORDER BY f.transferred_at DESC LIMIT 1`,
    [orderId]
  )).rows[0] || null;
  return { order, items, payments, steps, audit, creator, assignedApprover, financial };
}

/** من يمكنه عرض هذا الأمر؟ */
function canViewOrder(user, order) {
  if (seesAllProjects(user)) return true; // admin, projects_manager, technical_office, accountant
  if (order.created_by === user.id) return true;
  // معتمد مسموح له بمراجعة هذا الأمر (مُسنَد إليه تحديدًا، أو غير مُسنَد لأحد بعد)
  if (canApprove(user) && (!order.assigned_approver_id || order.assigned_approver_id === user.id)) return true;
  return false;
}

/** من يمكنه تعديل هذا الأمر (بحسب حالته)؟ */
function canEdit(order, user) {
  if (!order || !user) return false;
  if (!(order.status === 'draft' || order.status === 'returned_for_edit')) return false;
  if (isManager(user)) return true;
  if (user.role === 'technical_office') return true; // مسموح له بتعديل أي أمر قابل للتعديل
  return order.created_by === user.id;
}

/** من يمكنه إرسال هذا الأمر للاعتماد؟ (نفس منطق التعديل تقريبًا) */
function canSubmit(order, user) {
  if (!order || !user) return false;
  if (order.status !== 'draft' && order.status !== 'returned_for_edit') return false;
  if (isManager(user)) return true;
  if (user.role === 'technical_office') return true;
  return order.created_by === user.id;
}

router.use(requireLogin);

/* -------- قائمة الأوامر (أوامري) -------- */
router.get('/', async (req, res) => {
  const user = req.session.user;
  let rows;
  if (isManager(user)) {
    rows = (await db.query(
      `SELECT o.*, u.name AS creator_name, p.name AS project_name_rel, p.code AS project_code
       FROM orders o JOIN users u ON u.id = o.created_by LEFT JOIN projects p ON p.id = o.project_id
       ORDER BY o.created_at DESC`
    )).rows;
  } else {
    rows = (await db.query(
      `SELECT o.*, u.name AS creator_name, p.name AS project_name_rel, p.code AS project_code
       FROM orders o JOIN users u ON u.id = o.created_by LEFT JOIN projects p ON p.id = o.project_id
       WHERE o.created_by = $1 ORDER BY o.created_at DESC`,
      [user.id]
    )).rows;
  }
  res.render('orders/list', { orders: rows, statusLabels: STATUS_LABELS });
});

/* -------- إنشاء أمر جديد (مستقل، بدون مشروع — للتوافق القديم) -------- */
router.get('/new', requirePermission(canCreateOrders), (req, res) => {
  res.render('orders/form', { order: null, items: [], payments: [], mode: 'new', error: null, project: null });
});

router.post('/new', requirePermission(canCreateOrders), async (req, res) => {
  const user = req.session.user;
  const b = req.body;
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');

    let projectId = null;
    let projectOrderNo = null;
    let projectNameForOrder = b.project_name;
    let assignedApproverId = null;

    if (b.project_id) {
      projectId = parseInt(b.project_id, 10);
      const projRes = await client.query('SELECT * FROM projects WHERE id = $1 FOR UPDATE', [projectId]);
      const project = projRes.rows[0];
      if (!project) throw Object.assign(new Error('project not found'), { code: 'PROJECT_NOT_FOUND' });
      if (project.status === 'archived') throw Object.assign(new Error('project archived'), { code: 'PROJECT_ARCHIVED' });
      if (!(await canAccessProject(user, projectId))) throw Object.assign(new Error('no access'), { code: 'NO_ACCESS' });

      const nextSeq = project.last_order_seq + 1;
      await client.query('UPDATE projects SET last_order_seq = $1, updated_at = now() WHERE id = $2', [nextSeq, projectId]);
      projectOrderNo = `${project.code}-${String(nextSeq).padStart(3, '0')}`;
      projectNameForOrder = project.name;
      assignedApproverId = project.responsible_approver_id || null;
    }

    const orderNo = 'Z-' + Date.now().toString().slice(-8);
    const publicToken = uuidv4();
    const orderRes = await client.query(
      `INSERT INTO orders (order_no, project_id, project_order_no, assigned_approver_id, public_token, status,
        scope, code, project_name, phone, project_manager, contractor_name, order_date, obligations_text, vat_rate, created_by)
       VALUES ($1,$2,$3,$4,$5,'draft',$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING id`,
      [orderNo, projectId, projectOrderNo, assignedApproverId, publicToken, b.scope, b.code, projectNameForOrder,
       b.phone, b.project_manager, b.contractor_name, b.order_date || null, b.obligations_text, b.vat_rate || 15, user.id]
    );
    const orderId = orderRes.rows[0].id;
    await saveItemsAndPayments(client, orderId, b);
    await client.query('COMMIT');
    await logAction({
      orderId, action: 'تم إنشاء الأمر', actorId: user.id, actorName: user.name,
      details: projectId ? `ضمن المشروع: ${projectNameForOrder} (${projectOrderNo})` : null,
    });
    res.redirect(`/orders/${orderId}`);
  } catch (e) {
    await client.query('ROLLBACK');
    console.error(e);
    let msg = 'حدث خطأ أثناء الحفظ.';
    if (e.code === 'PROJECT_NOT_FOUND') msg = 'المشروع المحدد غير موجود.';
    if (e.code === 'PROJECT_ARCHIVED') msg = 'لا يمكن إنشاء أوامر داخل مشروع مؤرشف.';
    if (e.code === 'NO_ACCESS') msg = 'ليست لديك صلاحية الوصول لهذا المشروع.';
    res.render('orders/form', { order: null, items: [], payments: [], mode: 'new', error: msg, project: null });
  } finally {
    client.release();
  }
});

async function saveItemsAndPayments(client, orderId, b) {
  const descs = [].concat(b.item_desc || []);
  const qtys = [].concat(b.item_qty || []);
  const units = [].concat(b.item_unit || []);
  const prices = [].concat(b.item_price || []);
  await client.query('DELETE FROM order_items WHERE order_id = $1', [orderId]);
  let subtotal = 0;
  for (let i = 0; i < descs.length; i++) {
    if (!descs[i] || !descs[i].trim()) continue;
    const qty = parseFloat(qtys[i]) || 0;
    const price = parseFloat(prices[i]) || 0;
    const total = qty * price;
    subtotal += total;
    await client.query(
      `INSERT INTO order_items (order_id, seq, description, qty, unit, unit_price, total)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [orderId, i + 1, descs[i], qty, units[i] || '', price, total]
    );
  }
  const vatRate = parseFloat(b.vat_rate) || 15;
  const vatAmount = subtotal * vatRate / 100;
  const grand = subtotal + vatAmount;

  const payDescs = [].concat(b.pay_desc || []);
  const payPcts = [].concat(b.pay_pct || []);
  await client.query('DELETE FROM order_payments WHERE order_id = $1', [orderId]);
  for (let i = 0; i < payDescs.length; i++) {
    if (!payDescs[i] || !payDescs[i].trim()) continue;
    const pct = parseFloat(payPcts[i]) || 0;
    const value = grand * pct / 100;
    await client.query(
      `INSERT INTO order_payments (order_id, seq, description, pct, value) VALUES ($1,$2,$3,$4,$5)`,
      [orderId, i + 1, payDescs[i], pct, value]
    );
  }

  await client.query(
    `UPDATE orders SET subtotal=$1, vat_amount=$2, grand_total=$3, vat_rate=$4, updated_at=now() WHERE id=$5`,
    [subtotal, vatAmount, grand, vatRate, orderId]
  );
}

/* -------- عرض / تعديل أمر -------- */
router.get('/:id', async (req, res) => {
  const data = await getOrderFull(req.params.id);
  if (!data) return res.status(404).render('error', { title: 'غير موجود', message: 'أمر التعميد غير موجود.' });
  const user = req.session.user;
  if (!canViewOrder(user, data.order)) {
    return res.status(403).render('error', { title: 'غير مصرح', message: 'لا يمكنك عرض هذا الأمر.' });
  }
  let allProjects = [];
  let approversList = [];
  if (isManager(user)) {
    allProjects = (await db.query(`SELECT id, name, code FROM projects WHERE status != 'archived' ORDER BY name`)).rows;
    approversList = (await db.query(`SELECT id, name FROM users WHERE can_approve = true AND active = true ORDER BY name`)).rows;
  }
  const certificates = (await db.query(
    `SELECT * FROM payment_certificates WHERE order_id = $1 ORDER BY cert_seq`, [data.order.id]
  )).rows;
  const certsSpent = certificates
    .filter(c => ['approved', 'transferred', 'paid'].includes(c.status))
    .reduce((sum, c) => sum + Number(c.grand_total), 0);
  const certsRemaining = Number(data.order.grand_total) - certsSpent;
  res.render('orders/view', {
    ...data, statusLabels: STATUS_LABELS, canEdit: canEdit(data.order, user), allProjects, approversList,
    canTransferFinancial: canTransferFinancial(user), isManager: isManager(user),
    certificates, certsSpent, certsRemaining,
    certStatusLabels: CERT_STATUS_LABELS, canCreateCert: canViewOrder(user, data.order) && user.role !== 'accountant',
  });
});

router.get('/:id/edit', async (req, res) => {
  const data = await getOrderFull(req.params.id);
  if (!data) return res.status(404).render('error', { title: 'غير موجود', message: 'أمر التعميد غير موجود.' });
  const user = req.session.user;
  if (!canEdit(data.order, user)) {
    return res.status(403).render('error', { title: 'غير مصرح', message: 'لا يمكن تعديل هذا الأمر في حالته الحالية.' });
  }
  const project = data.order.project_id
    ? (await db.query('SELECT * FROM projects WHERE id = $1', [data.order.project_id])).rows[0]
    : null;
  res.render('orders/form', { order: data.order, items: data.items, payments: data.payments, mode: 'edit', error: null, project });
});

router.post('/:id/edit', async (req, res) => {
  const orderId = req.params.id;
  const user = req.session.user;
  const orderRes = await db.query('SELECT * FROM orders WHERE id=$1', [orderId]);
  const order = orderRes.rows[0];
  if (!order || !canEdit(order, user)) {
    return res.status(403).render('error', { title: 'غير مصرح', message: 'لا يمكن تعديل هذا الأمر في حالته الحالية.' });
  }
  const b = req.body;
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    const projectNameForOrder = order.project_id ? order.project_name : b.project_name;
    await client.query(
      `UPDATE orders SET scope=$1, code=$2, project_name=$3, phone=$4, project_manager=$5,
        contractor_name=$6, order_date=$7, obligations_text=$8, updated_at=now() WHERE id=$9`,
      [b.scope, b.code, projectNameForOrder, b.phone, b.project_manager, b.contractor_name,
       b.order_date || null, b.obligations_text, orderId]
    );
    await saveItemsAndPayments(client, orderId, b);
    await client.query('COMMIT');
    await logAction({ orderId, action: 'تم تعديل الأمر', actorId: user.id, actorName: user.name });
    res.redirect(`/orders/${orderId}`);
  } catch (e) {
    await client.query('ROLLBACK');
    console.error(e);
    res.status(500).render('error', { title: 'خطأ', message: 'تعذر حفظ التعديلات.' });
  } finally {
    client.release();
  }
});

/* -------- إرسال للاعتماد -------- */
router.post('/:id/submit', async (req, res) => {
  const orderId = req.params.id;
  const user = req.session.user;
  const orderRes = await db.query('SELECT * FROM orders WHERE id=$1', [orderId]);
  const order = orderRes.rows[0];
  if (!order || !canSubmit(order, user)) {
    return res.status(403).render('error', { title: 'غير مصرح', message: 'لا يمكنك إرسال هذا الأمر في حالته الحالية.' });
  }

  const levels = (await db.query('SELECT * FROM approval_levels_config WHERE active = true ORDER BY level_number')).rows;
  if (levels.length === 0) {
    return res.status(400).render('error', { title: 'خطأ إعداد', message: 'لا يوجد مستوى اعتماد مُفعّل في إعدادات النظام. تواصل مع مدير المشاريع.' });
  }

  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM order_approval_steps WHERE order_id = $1', [orderId]);
    for (const lvl of levels) {
      await client.query(
        `INSERT INTO order_approval_steps (order_id, level_number, level_name, status)
         VALUES ($1,$2,$3,'pending')`,
        [orderId, lvl.level_number, lvl.level_name]
      );
    }
    await client.query(
      `UPDATE orders SET status='pending_approval', current_level=$1, updated_at=now() WHERE id=$2`,
      [levels[0].level_number, orderId]
    );
    await client.query('COMMIT');
    await logAction({ orderId, action: 'تم إرساله للاعتماد', actorId: user.id, actorName: user.name });
    res.redirect(`/orders/${orderId}`);
  } catch (e) {
    await client.query('ROLLBACK');
    console.error(e);
    res.status(500).render('error', { title: 'خطأ', message: 'تعذر إرسال الأمر للاعتماد.' });
  } finally {
    client.release();
  }
});

/* -------- نقل أمر لمشروع آخر (مدير المشاريع فقط) -------- */
router.post('/:id/move', requirePermission(isManager), async (req, res) => {
  const user = req.session.user;
  const orderId = req.params.id;
  const newProjectId = parseInt(req.body.project_id, 10);
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    const orderRes = await client.query('SELECT * FROM orders WHERE id = $1', [orderId]);
    const order = orderRes.rows[0];
    if (!order) throw new Error('order not found');
    const projRes = await client.query('SELECT * FROM projects WHERE id = $1 FOR UPDATE', [newProjectId]);
    const project = projRes.rows[0];
    if (!project) throw new Error('project not found');
    const oldLabel = order.project_order_no || order.order_no;
    const nextSeq = project.last_order_seq + 1;
    await client.query('UPDATE projects SET last_order_seq = $1, updated_at = now() WHERE id = $2', [nextSeq, newProjectId]);
    const newOrderNo = `${project.code}-${String(nextSeq).padStart(3, '0')}`;
    await client.query(
      `UPDATE orders SET project_id=$1, project_order_no=$2, project_name=$3, updated_at=now() WHERE id=$4`,
      [newProjectId, newOrderNo, project.name, orderId]
    );
    await client.query('COMMIT');
    await logAction({
      orderId, action: 'تم نقل الأمر لمشروع آخر', actorId: user.id, actorName: user.name,
      details: `من: ${oldLabel} — إلى مشروع: ${project.name} (${project.code}) — الرقم الجديد: ${newOrderNo}`,
    });
    res.redirect(`/orders/${orderId}`);
  } catch (e) {
    await client.query('ROLLBACK');
    console.error(e);
    res.status(400).render('error', { title: 'خطأ', message: 'تعذر نقل الأمر إلى المشروع المحدد.' });
  } finally {
    client.release();
  }
});

/* -------- تعيين / تغيير المعتمد المسؤول عن أمر معين (مدير المشاريع فقط) -------- */
router.post('/:id/assign-approver', requirePermission(isManager), async (req, res) => {
  const user = req.session.user;
  const approverId = req.body.approver_id || null;
  await db.query('UPDATE orders SET assigned_approver_id = $1, updated_at = now() WHERE id = $2', [approverId, req.params.id]);
  let approverName = 'بدون تحديد';
  if (approverId) {
    const r = await db.query('SELECT name FROM users WHERE id = $1', [approverId]);
    if (r.rows[0]) approverName = r.rows[0].name;
  }
  await logAction({
    orderId: req.params.id, action: 'تعيين المعتمد المسؤول عن الأمر', actorId: user.id, actorName: user.name,
    details: `المعتمد: ${approverName}`,
  });
  res.redirect(`/orders/${req.params.id}`);
});

/* -------- تحويل للمحاسبة / الصرف (المحاسب فقط، وفقط لأمر معتمد) -------- */
router.post('/:id/transfer', requirePermission(canTransferFinancial), async (req, res) => {
  const user = req.session.user;
  const orderId = req.params.id;
  const order = (await db.query('SELECT * FROM orders WHERE id=$1', [orderId])).rows[0];
  if (!order) return res.status(404).render('error', { title: 'غير موجود', message: 'أمر التعميد غير موجود.' });
  if (order.status !== 'approved') {
    return res.status(400).render('error', { title: 'غير ممكن', message: 'لا يمكن التحويل للمحاسبة إلا لأمر معتمد.' });
  }
  await db.query(
    `INSERT INTO financial_records (order_id, accountant_id, notes, status) VALUES ($1,$2,$3,'transferred')`,
    [orderId, user.id, req.body.notes || null]
  );
  await logAction({
    orderId, action: 'تم التحويل للمحاسبة / الصرف', actorId: user.id, actorName: user.name,
    details: req.body.notes ? `ملاحظات: ${req.body.notes}` : null,
  });
  res.redirect(`/orders/${orderId}`);
});

/* -------- عرض قابل للطباعة / تصدير PDF عبر المتصفح -------- */
router.get('/:id/print', async (req, res) => {
  const data = await getOrderFull(req.params.id);
  if (!data) return res.status(404).render('error', { title: 'غير موجود', message: 'أمر التعميد غير موجود.' });
  const user = req.session.user;
  if (!canViewOrder(user, data.order)) {
    return res.status(403).render('error', { title: 'غير مصرح', message: 'لا يمكنك عرض هذا الأمر.' });
  }
  let qrDataUrl = null;
  if (data.order.status === 'approved') {
    const verifyUrl = `${process.env.BASE_URL || 'http://localhost:3000'}/verify/${data.order.public_token}`;
    qrDataUrl = await QRCode.toDataURL(verifyUrl, { margin: 1, width: 160 });
  }
  res.render('orders/print', { ...data, statusLabels: STATUS_LABELS, qrDataUrl });
});

module.exports = router;
