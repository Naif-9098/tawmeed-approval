const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');
const QRCode = require('qrcode');
const db = require('../db');
const { requireLogin } = require('../middleware/auth');
const { logAction } = require('../audit');

const STATUS_LABELS = {
  draft: 'مسودة',
  pending_approval: 'بانتظار الاعتماد',
  approved: 'معتمد',
  rejected: 'مرفوض',
  returned_for_edit: 'معاد للتعديل',
};

async function getOrderFull(orderId) {
  const orderRes = await db.query('SELECT * FROM orders WHERE id = $1', [orderId]);
  const order = orderRes.rows[0];
  if (!order) return null;
  const items = (await db.query('SELECT * FROM order_items WHERE order_id = $1 ORDER BY seq', [orderId])).rows;
  const payments = (await db.query('SELECT * FROM order_payments WHERE order_id = $1 ORDER BY seq', [orderId])).rows;
  const steps = (await db.query('SELECT * FROM order_approval_steps WHERE order_id = $1 ORDER BY level_number', [orderId])).rows;
  const audit = (await db.query('SELECT * FROM audit_log WHERE order_id = $1 ORDER BY created_at ASC', [orderId])).rows;
  const creator = (await db.query('SELECT name, job_title FROM users WHERE id = $1', [order.created_by])).rows[0];
  return { order, items, payments, steps, audit, creator };
}

function canEdit(order, user) {
  if (!order || !user) return false;
  if (order.created_by !== user.id && user.role !== 'admin') return false;
  return order.status === 'draft' || order.status === 'returned_for_edit';
}

router.use(requireLogin);

/* -------- قائمة الأوامر -------- */
router.get('/', async (req, res) => {
  const user = req.session.user;
  let rows;
  if (user.role === 'admin') {
    rows = (await db.query('SELECT o.*, u.name AS creator_name FROM orders o JOIN users u ON u.id = o.created_by ORDER BY o.created_at DESC')).rows;
  } else {
    rows = (await db.query('SELECT o.*, u.name AS creator_name FROM orders o JOIN users u ON u.id = o.created_by WHERE o.created_by = $1 ORDER BY o.created_at DESC', [user.id])).rows;
  }
  res.render('orders/list', { orders: rows, statusLabels: STATUS_LABELS });
});

/* -------- إنشاء أمر جديد -------- */
router.get('/new', (req, res) => {
  res.render('orders/form', { order: null, items: [], payments: [], mode: 'new', error: null });
});

router.post('/new', async (req, res) => {
  const user = req.session.user;
  const b = req.body;
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    const orderNo = 'Z-' + Date.now().toString().slice(-8);
    const publicToken = uuidv4();
    const orderRes = await client.query(
      `INSERT INTO orders (order_no, public_token, status, scope, code, project_name, phone, project_manager,
        contractor_name, order_date, obligations_text, vat_rate, created_by)
       VALUES ($1,$2,'draft',$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`,
      [orderNo, publicToken, b.scope, b.code, b.project_name, b.phone, b.project_manager,
       b.contractor_name, b.order_date || null, b.obligations_text, b.vat_rate || 15, user.id]
    );
    const orderId = orderRes.rows[0].id;
    await saveItemsAndPayments(client, orderId, b);
    await client.query('COMMIT');
    await logAction({ orderId, action: 'تم إنشاء الأمر', actorId: user.id, actorName: user.name });
    res.redirect(`/orders/${orderId}`);
  } catch (e) {
    await client.query('ROLLBACK');
    console.error(e);
    res.render('orders/form', { order: null, items: [], payments: [], mode: 'new', error: 'حدث خطأ أثناء الحفظ.' });
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
  if (data.order.created_by !== user.id && user.role !== 'admin') {
    return res.status(403).render('error', { title: 'غير مصرح', message: 'لا يمكنك عرض هذا الأمر.' });
  }
  res.render('orders/view', {
    ...data, statusLabels: STATUS_LABELS, canEdit: canEdit(data.order, user),
  });
});

router.get('/:id/edit', async (req, res) => {
  const data = await getOrderFull(req.params.id);
  if (!data) return res.status(404).render('error', { title: 'غير موجود', message: 'أمر التعميد غير موجود.' });
  const user = req.session.user;
  if (!canEdit(data.order, user)) {
    return res.status(403).render('error', { title: 'غير مصرح', message: 'لا يمكن تعديل هذا الأمر في حالته الحالية.' });
  }
  res.render('orders/form', { order: data.order, items: data.items, payments: data.payments, mode: 'edit', error: null });
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
    await client.query(
      `UPDATE orders SET scope=$1, code=$2, project_name=$3, phone=$4, project_manager=$5,
        contractor_name=$6, order_date=$7, obligations_text=$8, updated_at=now() WHERE id=$9`,
      [b.scope, b.code, b.project_name, b.phone, b.project_manager, b.contractor_name,
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
  if (!order || (order.created_by !== user.id && user.role !== 'admin')) {
    return res.status(403).render('error', { title: 'غير مصرح', message: 'لا يمكنك إرسال هذا الأمر.' });
  }
  if (order.status !== 'draft' && order.status !== 'returned_for_edit') {
    return res.status(400).render('error', { title: 'غير ممكن', message: 'لا يمكن إرسال هذا الأمر في حالته الحالية.' });
  }

  const levels = (await db.query('SELECT * FROM approval_levels_config WHERE active = true ORDER BY level_number')).rows;
  if (levels.length === 0) {
    return res.status(400).render('error', { title: 'خطأ إعداد', message: 'لا يوجد مستوى اعتماد مُفعّل في إعدادات النظام. تواصل مع مدير النظام.' });
  }

  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    // إعادة تهيئة خطوات الاعتماد من مستوى 1 (يشمل حالة إعادة الإرسال بعد "معاد للتعديل")
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

/* -------- عرض قابل للطباعة / تصدير PDF عبر المتصفح -------- */
router.get('/:id/print', async (req, res) => {
  const data = await getOrderFull(req.params.id);
  if (!data) return res.status(404).render('error', { title: 'غير موجود', message: 'أمر التعميد غير موجود.' });
  const user = req.session.user;
  if (data.order.created_by !== user.id && user.role !== 'admin' && user.role !== 'approver') {
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
