const express = require('express');
const router = express.Router();
const db = require('../db');
const { requireLogin, requirePermission } = require('../middleware/auth');
const { logAction } = require('../audit');
const { canAccessProject } = require('../projectAccess');
const { isManager, seesAllProjects, canApprove, canCreateCertificates, canRequestTransferFor, canConfirmPayment } = require('../permissions');
const { getSetting } = require('../settings');

const STATUS_LABELS = {
  draft: 'مسودة',
  pending_review: 'بانتظار المراجعة',
  approved: 'معتمد',
  rejected: 'مرفوض',
  returned_for_edit: 'معاد للتعديل',
};
const FINANCIAL_STATUS_LABELS = {
  not_sent: 'لم يُحوَّل للمحاسبة',
  sent_to_accounting: 'بانتظار الصرف',
  paid: 'تم الصرف',
};
const PAY_METHOD_LABELS = { cash: 'نقدًا', transfer: 'تحويل', retention: 'ضمان أعمال' };
const PAYMENT_METHOD_LABELS = { bank_transfer: 'تحويل بنكي', cash: 'نقدي', cheque: 'شيك', other: 'أخرى' };

router.use(requireLogin);

/* ---------------- Helpers ---------------- */

async function getOrderWithProject(orderId) {
  return (await db.query(
    `SELECT o.*, p.name AS project_name_rel, p.code AS project_code
     FROM orders o LEFT JOIN projects p ON p.id = o.project_id WHERE o.id = $1`,
    [orderId]
  )).rows[0];
}

function canViewOrderForCert(user, order) {
  if (seesAllProjects(user)) return true;
  return order.created_by === user.id;
}

async function getCertFull(certId) {
  const cert = (await db.query('SELECT * FROM payment_certificates WHERE id = $1', [certId])).rows[0];
  if (!cert) return null;
  const order = await getOrderWithProject(cert.order_id);
  const items = (await db.query('SELECT * FROM payment_certificate_items WHERE certificate_id = $1 ORDER BY seq', [certId])).rows;
  const creator = (await db.query('SELECT name, job_title FROM users WHERE id = $1', [cert.created_by])).rows[0];
  return { cert, order, items, creator };
}

/** مجموع المستخلصات "المحتسبة فعليًا" لأمر معيّن — أي مستخلص معتمد (بغض النظر عن حالة الصرف) */
async function getSpentForOrder(orderId, excludeCertId) {
  const params = [orderId];
  let extra = '';
  if (excludeCertId) { params.push(excludeCertId); extra = ` AND id != $${params.length}`; }
  const r = await db.query(
    `SELECT COALESCE(SUM(grand_total),0) AS spent FROM payment_certificates
     WHERE order_id = $1 AND status = 'approved' ${extra}`,
    params
  );
  return Number(r.rows[0].spent);
}

function canEditCert(cert, user) {
  if (!cert || !user) return false;
  if (!(cert.status === 'draft' || cert.status === 'returned_for_edit')) return false;
  if (isManager(user)) return true;
  if (user.role === 'technical_office') return true;
  return cert.created_by === user.id;
}

async function recalcAndSaveItems(client, certId, b) {
  const descs = [].concat(b.item_desc || []);
  const amounts = [].concat(b.item_amount || []);
  await client.query('DELETE FROM payment_certificate_items WHERE certificate_id = $1', [certId]);
  let subtotal = 0;
  for (let i = 0; i < descs.length; i++) {
    if (!descs[i] || !descs[i].trim()) continue;
    const amount = parseFloat(amounts[i]) || 0;
    subtotal += amount;
    await client.query(
      `INSERT INTO payment_certificate_items (certificate_id, seq, description, amount) VALUES ($1,$2,$3,$4)`,
      [certId, i + 1, descs[i], amount]
    );
  }
  const discount = parseFloat(b.discount) || 0;
  const vatRate = parseFloat(b.vat_rate) || 0;
  const afterDiscount = subtotal - discount;
  const vatAmount = afterDiscount * vatRate / 100;
  const grand = afterDiscount + vatAmount;
  await client.query(
    `UPDATE payment_certificates SET subtotal=$1, discount=$2, vat_rate=$3, after_discount=$4, vat_amount=$5, grand_total=$6, updated_at=now()
     WHERE id=$7`,
    [subtotal, discount, vatRate, afterDiscount, vatAmount, grand, certId]
  );
  return { subtotal, discount, afterDiscount, vatAmount, grand };
}

/* ---------------- إنشاء مستخلص من داخل أمر تعميد ---------------- */
router.post('/orders/:orderId/certificates/new', requirePermission(canCreateCertificates), async (req, res) => {
  const user = req.session.user;
  const orderId = req.params.orderId;
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    const orderRes = await client.query('SELECT * FROM orders WHERE id = $1 FOR UPDATE', [orderId]);
    const order = orderRes.rows[0];
    if (!order) throw new Error('order not found');
    if (!canViewOrderForCert(user, order)) throw Object.assign(new Error('no access'), { code: 'NO_ACCESS' });
    if (order.project_id && !(await canAccessProject(user, order.project_id))) throw Object.assign(new Error('no project access'), { code: 'NO_ACCESS' });

    const countRes = await client.query('SELECT COUNT(*) AS c FROM payment_certificates WHERE order_id = $1', [orderId]);
    const seq = parseInt(countRes.rows[0].c, 10) + 1;
    const prefix = order.project_order_no || order.order_no;
    const certNo = `${prefix}-PC-${String(seq).padStart(2, '0')}`;
    const defaultVat = parseFloat(await getSetting('default_cert_vat_rate', '15')) || 15;

    const result = await client.query(
      `INSERT INTO payment_certificates (order_id, cert_seq, cert_no, status, cert_date, vat_rate, created_by)
       VALUES ($1,$2,$3,'draft',CURRENT_DATE,$4,$5) RETURNING id`,
      [orderId, seq, certNo, defaultVat, user.id]
    );
    const certId = result.rows[0].id;
    await client.query('COMMIT');
    await logAction({
      orderId, action: 'تم إنشاء مستخلص', actorId: user.id, actorName: user.name,
      details: `رقم المستخلص: ${certNo}`,
    });
    res.redirect(`/certificates/${certId}/edit`);
  } catch (e) {
    await client.query('ROLLBACK');
    console.error(e);
    res.status(e.code === 'NO_ACCESS' ? 403 : 500).render('error', {
      title: e.code === 'NO_ACCESS' ? 'غير مصرح' : 'خطأ',
      message: e.code === 'NO_ACCESS' ? 'ليست لديك صلاحية إنشاء مستخلص لهذا الأمر.' : 'تعذر إنشاء المستخلص.',
    });
  } finally {
    client.release();
  }
});

/* ---------------- عرض مستخلص ---------------- */
router.get('/certificates/:id', async (req, res) => {
  const data = await getCertFull(req.params.id);
  if (!data) return res.status(404).render('error', { title: 'غير موجود', message: 'المستخلص غير موجود.' });
  const user = req.session.user;
  if (!canViewOrderForCert(user, data.order)) {
    return res.status(403).render('error', { title: 'غير مصرح', message: 'لا يمكنك عرض هذا المستخلص.' });
  }
  const spent = await getSpentForOrder(data.order.id, data.cert.id);
  const remaining = Number(data.order.grand_total) - spent;
  const audit = (await db.query(
    `SELECT * FROM audit_log WHERE order_id = $1 AND details ILIKE '%' || $2 || '%' ORDER BY created_at ASC`,
    [data.order.id, data.cert.cert_no]
  )).rows;
  res.render('certificates/view', {
    ...data, statusLabels: STATUS_LABELS, financialStatusLabels: FINANCIAL_STATUS_LABELS,
    paymentMethodLabels: PAYMENT_METHOD_LABELS, payMethodLabels: PAY_METHOD_LABELS,
    canEdit: canEditCert(data.cert, user), canApprove: canApprove(user),
    canRequestTransfer: canRequestTransferFor(user, data.cert.created_by),
    canConfirmPayment: canConfirmPayment(user), spent, remaining, audit,
  });
});

/* ---------------- تعديل مستخلص ---------------- */
router.get('/certificates/:id/edit', async (req, res) => {
  const data = await getCertFull(req.params.id);
  if (!data) return res.status(404).render('error', { title: 'غير موجود', message: 'المستخلص غير موجود.' });
  const user = req.session.user;
  if (!canEditCert(data.cert, user)) {
    return res.status(403).render('error', { title: 'غير مصرح', message: 'لا يمكن تعديل هذا المستخلص في حالته الحالية.' });
  }
  res.render('certificates/form', { ...data, error: null, payMethodLabels: PAY_METHOD_LABELS });
});

router.post('/certificates/:id/edit', async (req, res) => {
  const certId = req.params.id;
  const user = req.session.user;
  const cert = (await db.query('SELECT * FROM payment_certificates WHERE id = $1', [certId])).rows[0];
  if (!cert || !canEditCert(cert, user)) {
    return res.status(403).render('error', { title: 'غير مصرح', message: 'لا يمكن تعديل هذا المستخلص في حالته الحالية.' });
  }
  const order = await getOrderWithProject(cert.order_id);
  const b = req.body;
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `UPDATE payment_certificates SET cert_date=$1, payment_method=$2, notes=$3, updated_at=now() WHERE id=$4`,
      [b.cert_date || null, b.payment_method || null, b.notes || null, certId]
    );
    const totals = await recalcAndSaveItems(client, certId, b);

    const spent = await getSpentForOrder(cert.order_id, certId);
    const remaining = Number(order.grand_total) - spent;
    if (totals.grand > remaining) {
      throw Object.assign(new Error('exceeds remaining'), { code: 'EXCEEDS_REMAINING' });
    }

    await client.query('COMMIT');
    await logAction({ orderId: cert.order_id, action: 'تم تعديل المستخلص', actorId: user.id, actorName: user.name, details: `رقم المستخلص: ${cert.cert_no}` });
    res.redirect(`/certificates/${certId}`);
  } catch (e) {
    await client.query('ROLLBACK');
    console.error(e);
    const items = (await db.query('SELECT * FROM payment_certificate_items WHERE certificate_id = $1 ORDER BY seq', [certId])).rows;
    const creator = (await db.query('SELECT name, job_title FROM users WHERE id = $1', [cert.created_by])).rows[0];
    const msg = e.code === 'EXCEEDS_REMAINING'
      ? 'قيمة المستخلص تتجاوز المبلغ المتبقي من أمر التعميد.'
      : 'تعذر حفظ التعديلات.';
    res.render('certificates/form', { cert, order, items, creator, error: msg, payMethodLabels: PAY_METHOD_LABELS });
  } finally {
    client.release();
  }
});

/* ---------------- إرسال للمراجعة ---------------- */
router.post('/certificates/:id/submit', async (req, res) => {
  const user = req.session.user;
  const certId = req.params.id;
  const cert = (await db.query('SELECT * FROM payment_certificates WHERE id = $1', [certId])).rows[0];
  if (!cert || !canEditCert(cert, user)) {
    return res.status(403).render('error', { title: 'غير مصرح', message: 'لا يمكنك إرسال هذا المستخلص في حالته الحالية.' });
  }
  await db.query(`UPDATE payment_certificates SET status='pending_review', updated_at=now() WHERE id=$1`, [certId]);
  await logAction({ orderId: cert.order_id, action: 'تم إرسال المستخلص للمراجعة', actorId: user.id, actorName: user.name, details: `رقم المستخلص: ${cert.cert_no}` });
  res.redirect(`/certificates/${certId}`);
});

/* ---------------- اعتماد / رفض / إعادة للتعديل ---------------- */
router.post('/certificates/:id/approve', requirePermission(canApprove), async (req, res) => {
  const user = req.session.user;
  const certId = req.params.id;
  const cert = (await db.query('SELECT * FROM payment_certificates WHERE id = $1', [certId])).rows[0];
  if (!cert || cert.status !== 'pending_review') {
    return res.status(400).render('error', { title: 'غير ممكن', message: 'هذا المستخلص لم يعد بانتظار المراجعة.' });
  }
  await db.query(
    `UPDATE payment_certificates SET status='approved', final_approved_by=$1, final_approved_by_name=$2,
      final_approved_by_title=$3, final_approved_at=now(), updated_at=now() WHERE id=$4`,
    [user.id, user.name, user.jobTitle || '', certId]
  );
  await logAction({ orderId: cert.order_id, action: 'تم اعتماد المستخلص', actorId: user.id, actorName: user.name, details: `رقم المستخلص: ${cert.cert_no}` });
  res.redirect(`/certificates/${certId}`);
});

router.post('/certificates/:id/reject', requirePermission(canApprove), async (req, res) => {
  const user = req.session.user;
  const certId = req.params.id;
  const reason = (req.body.reason || '').trim();
  if (!reason) return res.status(400).render('error', { title: 'مطلوب سبب', message: 'يجب كتابة سبب الرفض.' });
  const cert = (await db.query('SELECT * FROM payment_certificates WHERE id = $1', [certId])).rows[0];
  if (!cert || cert.status !== 'pending_review') {
    return res.status(400).render('error', { title: 'غير ممكن', message: 'هذا المستخلص لم يعد بانتظار المراجعة.' });
  }
  await db.query(`UPDATE payment_certificates SET status='rejected', updated_at=now() WHERE id=$1`, [certId]);
  await logAction({ orderId: cert.order_id, action: 'تم رفض المستخلص', actorId: user.id, actorName: user.name, details: `رقم المستخلص: ${cert.cert_no} — السبب: ${reason}` });
  res.redirect(`/certificates/${certId}`);
});

router.post('/certificates/:id/return', requirePermission(canApprove), async (req, res) => {
  const user = req.session.user;
  const certId = req.params.id;
  const note = (req.body.note || '').trim();
  if (!note) return res.status(400).render('error', { title: 'مطلوب ملاحظة', message: 'يجب كتابة ملاحظة توضح المطلوب تعديله.' });
  const cert = (await db.query('SELECT * FROM payment_certificates WHERE id = $1', [certId])).rows[0];
  if (!cert || cert.status !== 'pending_review') {
    return res.status(400).render('error', { title: 'غير ممكن', message: 'هذا المستخلص لم يعد بانتظار المراجعة.' });
  }
  await db.query(`UPDATE payment_certificates SET status='returned_for_edit', updated_at=now() WHERE id=$1`, [certId]);
  await logAction({ orderId: cert.order_id, action: 'تمت إعادة المستخلص للتعديل', actorId: user.id, actorName: user.name, details: `رقم المستخلص: ${cert.cert_no} — الملاحظة: ${note}` });
  res.redirect(`/certificates/${certId}`);
});

/* ---------------- تحويل للمحاسبة (منشئ المستخلص أو مدير المشاريع — وليس المحاسب) ---------------- */
router.post('/certificates/:id/request-transfer', async (req, res) => {
  const user = req.session.user;
  const certId = req.params.id;
  const cert = (await db.query('SELECT * FROM payment_certificates WHERE id = $1', [certId])).rows[0];
  if (!cert) return res.status(404).render('error', { title: 'غير موجود', message: 'المستخلص غير موجود.' });
  if (!canRequestTransferFor(user, cert.created_by)) {
    return res.status(403).render('error', { title: 'غير مصرح', message: 'لا يمكنك تحويل مستخلص لم تُنشئه أنت.' });
  }
  if (cert.status !== 'approved') {
    return res.status(400).render('error', { title: 'غير ممكن', message: 'لا يمكن التحويل للمحاسبة إلا لمستخلص معتمد.' });
  }
  if (cert.financial_status !== 'not_sent') {
    return res.status(400).render('error', { title: 'غير ممكن', message: 'تم تحويل هذا المستخلص للمحاسبة بالفعل.' });
  }
  await db.query(
    `UPDATE payment_certificates SET financial_status='sent_to_accounting',
      financial_requested_by=$1, financial_requested_by_name=$2, financial_requested_at=now(), updated_at=now()
     WHERE id=$3`,
    [user.id, user.name, certId]
  );
  await logAction({ orderId: cert.order_id, action: 'تم تحويل المستخلص للمحاسبة', actorId: user.id, actorName: user.name, details: `رقم المستخلص: ${cert.cert_no}` });
  res.redirect(`/certificates/${certId}`);
});

/* ---------------- تم الصرف (المحاسب فقط) ---------------- */
router.post('/certificates/:id/confirm-payment', requirePermission(canConfirmPayment), async (req, res) => {
  const user = req.session.user;
  const certId = req.params.id;
  const cert = (await db.query('SELECT * FROM payment_certificates WHERE id = $1', [certId])).rows[0];
  if (!cert) return res.status(404).render('error', { title: 'غير موجود', message: 'المستخلص غير موجود.' });
  if (cert.financial_status !== 'sent_to_accounting') {
    return res.status(400).render('error', { title: 'غير ممكن', message: 'لا يمكن تسجيل الصرف إلا لمستخلص محوّل للمحاسبة وبانتظار الصرف — وقد يكون صُرف بالفعل.' });
  }
  const b = req.body;
  await db.query(
    `UPDATE payment_certificates SET financial_status='paid',
      financial_paid_by=$1, financial_paid_by_name=$2, financial_paid_at=now(),
      payment_amount=$3, payment_date=$4, payout_method=$5, payment_reference=$6, payment_notes=$7,
      updated_at=now()
     WHERE id=$8 AND financial_status='sent_to_accounting'`,
    [user.id, user.name, parseFloat(b.payment_amount) || cert.grand_total, b.payment_date || null,
     b.payout_method || null, b.payment_reference || null, b.payment_notes || null, certId]
  );
  await logAction({
    orderId: cert.order_id, action: 'تم صرف المستخلص', actorId: user.id, actorName: user.name,
    details: `رقم المستخلص: ${cert.cert_no} — المبلغ: ${b.payment_amount || cert.grand_total} — الطريقة: ${b.payout_method || '—'}${b.payment_reference ? ' — مرجع: ' + b.payment_reference : ''}`,
  });
  res.redirect(`/certificates/${certId}`);
});

/* ---------------- طباعة / PDF ---------------- */
router.get('/certificates/:id/print', async (req, res) => {
  const data = await getCertFull(req.params.id);
  if (!data) return res.status(404).render('error', { title: 'غير موجود', message: 'المستخلص غير موجود.' });
  const user = req.session.user;
  if (!canViewOrderForCert(user, data.order)) {
    return res.status(403).render('error', { title: 'غير مصرح', message: 'لا يمكنك عرض هذا المستخلص.' });
  }
  const spent = await getSpentForOrder(data.order.id, data.cert.id);
  const remaining = Number(data.order.grand_total) - spent;
  res.render('certificates/print', {
    ...data, statusLabels: STATUS_LABELS, financialStatusLabels: FINANCIAL_STATUS_LABELS,
    payMethodLabels: PAY_METHOD_LABELS, spent, remaining,
  });
});

module.exports = router;
