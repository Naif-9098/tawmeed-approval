const express = require('express');
const router = express.Router();
const db = require('../db');
const { requireLogin, requirePermission } = require('../middleware/auth');
const { logAction } = require('../audit');
const { getAccessibleProjectIds, canAccessProject } = require('../projectAccess');
const { isManager, canApprove } = require('../permissions');

const STATUS_LABELS = {
  draft: 'مسودة',
  pending_approval: 'بانتظار الاعتماد',
  approved: 'معتمد',
  rejected: 'مرفوض',
  returned_for_edit: 'معاد للتعديل',
};

router.use(requireLogin);
// الدخول لقسم الاعتماد بالكامل يتطلب صلاحية الاعتماد (Permission)،
// وهي منفصلة عن الدور الوظيفي — مدير المشاريع يدخلها دائمًا أيضًا.
router.use(requirePermission(canApprove));

/* -------- طلبات الاعتماد: أوامر تنتظر موافقة المستخدم الحالي فقط -------- */
router.get('/', async (req, res) => {
  const user = req.session.user;
  const ids = await getAccessibleProjectIds(user); // null = بلا قيود (مدير المشاريع)

  const params = [user.id];
  let projectFilter = '';
  if (ids !== null) {
    params.push(ids);
    projectFilter = ` AND (o.project_id IS NULL OR o.project_id = ANY($${params.length}))`;
  }
  let managerBypass = '';
  if (isManager(user)) {
    // مدير المشاريع يرى كل الطلبات بلا قيد إسناد
    managerBypass = ' OR true';
  }

  const rows = (await db.query(
    `SELECT o.*, u.name AS creator_name, s.level_name, s.level_number, p.name AS project_name_rel, p.code AS project_code
     FROM orders o
     JOIN users u ON u.id = o.created_by
     JOIN order_approval_steps s ON s.order_id = o.id AND s.level_number = o.current_level AND s.status='pending'
     LEFT JOIN projects p ON p.id = o.project_id
     WHERE o.status = 'pending_approval'
       AND (o.assigned_approver_id IS NULL OR o.assigned_approver_id = $1 ${managerBypass})
       ${projectFilter}
     ORDER BY o.updated_at ASC`,
    params
  )).rows;
  res.render('approvals/list', { orders: rows });
});

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
  const creator = (await db.query('SELECT name, job_title FROM users WHERE id = $1', [order.created_by])).rows[0];
  return { order, items, payments, steps, creator };
}

/** تحقق: هل يُسمح لهذا المستخدم بمراجعة/الرد على هذا الأمر تحديدًا؟ */
async function checkApproverAllowed(order, user) {
  if (isManager(user)) return true;
  if (order.assigned_approver_id && order.assigned_approver_id !== user.id) return false;
  return canAccessProject(user, order.project_id);
}

/* -------- تفاصيل أمر التعميد لغرض الاعتماد -------- */
router.get('/:id', async (req, res) => {
  const data = await getOrderFull(req.params.id);
  if (!data) return res.status(404).render('error', { title: 'غير موجود', message: 'أمر التعميد غير موجود.' });
  const user = req.session.user;
  if (!(await checkApproverAllowed(data.order, user))) {
    return res.status(403).render('error', { title: 'غير مصرح', message: 'هذا الأمر مُسنَد لمعتمد آخر أو خارج نطاق صلاحيتك.' });
  }
  res.render('approvals/detail', { ...data, statusLabels: STATUS_LABELS });
});

async function currentStep(orderId, order) {
  const res = await db.query(
    `SELECT * FROM order_approval_steps WHERE order_id=$1 AND level_number=$2 AND status='pending'`,
    [orderId, order.current_level]
  );
  return res.rows[0];
}

/* -------- اعتماد -------- */
router.post('/:id/approve', async (req, res) => {
  const orderId = req.params.id;
  const user = req.session.user;
  const orderRes = await db.query('SELECT * FROM orders WHERE id=$1', [orderId]);
  const order = orderRes.rows[0];
  if (!order || order.status !== 'pending_approval') {
    return res.status(400).render('error', { title: 'غير ممكن', message: 'هذا الأمر لم يعد بانتظار الاعتماد.' });
  }
  if (!(await checkApproverAllowed(order, user))) {
    return res.status(403).render('error', { title: 'غير مصرح', message: 'هذا الأمر مُسنَد لمعتمد آخر أو خارج نطاق صلاحيتك.' });
  }
  const step = await currentStep(orderId, order);
  if (!step) return res.status(400).render('error', { title: 'خطأ', message: 'تعذر إيجاد خطوة الاعتماد الحالية.' });

  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `UPDATE order_approval_steps SET status='approved', acted_by=$1, acted_by_name=$2, acted_by_title=$3, acted_at=now()
       WHERE id=$4`,
      [user.id, user.name, user.jobTitle || '', step.id]
    );

    const nextLevelRes = await client.query(
      `SELECT * FROM approval_levels_config WHERE active=true AND level_number > $1 ORDER BY level_number ASC LIMIT 1`,
      [order.current_level]
    );
    if (nextLevelRes.rows.length > 0) {
      const next = nextLevelRes.rows[0];
      await client.query(`UPDATE orders SET current_level=$1, updated_at=now() WHERE id=$2`, [next.level_number, orderId]);
      await client.query('COMMIT');
      await logAction({ orderId, action: `تم الاعتماد (مستوى: ${step.level_name})`, actorId: user.id, actorName: user.name,
        details: `انتقل الأمر إلى مستوى الاعتماد التالي: ${next.level_name}` });
    } else {
      await client.query(
        `UPDATE orders SET status='approved', final_approved_by=$1, final_approved_by_name=$2,
          final_approved_by_title=$3, final_approved_at=now(), updated_at=now() WHERE id=$4`,
        [user.id, user.name, user.jobTitle || '', orderId]
      );
      await client.query('COMMIT');
      await logAction({ orderId, action: 'تم الاعتماد النهائي', actorId: user.id, actorName: user.name });
    }
    res.redirect('/approvals');
  } catch (e) {
    await client.query('ROLLBACK');
    console.error(e);
    res.status(500).render('error', { title: 'خطأ', message: 'تعذر تنفيذ الاعتماد.' });
  } finally {
    client.release();
  }
});

/* -------- رفض -------- */
router.post('/:id/reject', async (req, res) => {
  const orderId = req.params.id;
  const user = req.session.user;
  const reason = (req.body.reason || '').trim();
  if (!reason) {
    return res.status(400).render('error', { title: 'مطلوب سبب', message: 'يجب كتابة سبب الرفض.' });
  }
  const orderRes = await db.query('SELECT * FROM orders WHERE id=$1', [orderId]);
  const order = orderRes.rows[0];
  if (!order || order.status !== 'pending_approval') {
    return res.status(400).render('error', { title: 'غير ممكن', message: 'هذا الأمر لم يعد بانتظار الاعتماد.' });
  }
  if (!(await checkApproverAllowed(order, user))) {
    return res.status(403).render('error', { title: 'غير مصرح', message: 'هذا الأمر مُسنَد لمعتمد آخر أو خارج نطاق صلاحيتك.' });
  }
  const step = await currentStep(orderId, order);
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    if (step) {
      await client.query(
        `UPDATE order_approval_steps SET status='rejected', acted_by=$1, acted_by_name=$2, acted_by_title=$3, acted_at=now(), note=$4
         WHERE id=$5`,
        [user.id, user.name, user.jobTitle || '', reason, step.id]
      );
    }
    await client.query(`UPDATE orders SET status='rejected', updated_at=now() WHERE id=$1`, [orderId]);
    await client.query('COMMIT');
    await logAction({ orderId, action: 'تم الرفض', actorId: user.id, actorName: user.name, details: `السبب: ${reason}` });
    res.redirect('/approvals');
  } catch (e) {
    await client.query('ROLLBACK');
    console.error(e);
    res.status(500).render('error', { title: 'خطأ', message: 'تعذر تنفيذ الرفض.' });
  } finally {
    client.release();
  }
});

/* -------- إعادة للتعديل -------- */
router.post('/:id/return', async (req, res) => {
  const orderId = req.params.id;
  const user = req.session.user;
  const note = (req.body.note || '').trim();
  if (!note) {
    return res.status(400).render('error', { title: 'مطلوب ملاحظة', message: 'يجب كتابة ملاحظة توضح المطلوب تعديله.' });
  }
  const orderRes = await db.query('SELECT * FROM orders WHERE id=$1', [orderId]);
  const order = orderRes.rows[0];
  if (!order || order.status !== 'pending_approval') {
    return res.status(400).render('error', { title: 'غير ممكن', message: 'هذا الأمر لم يعد بانتظار الاعتماد.' });
  }
  if (!(await checkApproverAllowed(order, user))) {
    return res.status(403).render('error', { title: 'غير مصرح', message: 'هذا الأمر مُسنَد لمعتمد آخر أو خارج نطاق صلاحيتك.' });
  }
  const step = await currentStep(orderId, order);
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    if (step) {
      await client.query(
        `UPDATE order_approval_steps SET status='returned', acted_by=$1, acted_by_name=$2, acted_by_title=$3, acted_at=now(), note=$4
         WHERE id=$5`,
        [user.id, user.name, user.jobTitle || '', note, step.id]
      );
    }
    await client.query(`UPDATE orders SET status='returned_for_edit', updated_at=now() WHERE id=$1`, [orderId]);
    await client.query('COMMIT');
    await logAction({ orderId, action: 'تمت إعادته للتعديل', actorId: user.id, actorName: user.name, details: `الملاحظة: ${note}` });
    res.redirect('/approvals');
  } catch (e) {
    await client.query('ROLLBACK');
    console.error(e);
    res.status(500).render('error', { title: 'خطأ', message: 'تعذر تنفيذ الإعادة للتعديل.' });
  } finally {
    client.release();
  }
});

module.exports = router;
