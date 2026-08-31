const express = require('express');
const router = express.Router();
const db = require('../db');

const STATUS_LABELS = {
  draft: 'مسودة',
  pending_approval: 'بانتظار الاعتماد',
  approved: 'معتمد',
  rejected: 'مرفوض',
  returned_for_edit: 'معاد للتعديل',
};

// صفحة عامة — لا تتطلب تسجيل دخول، ولا تعرض إلا الحد الأدنى من المعلومات
router.get('/:token', async (req, res) => {
  const result = await db.query('SELECT * FROM orders WHERE public_token = $1', [req.params.token]);
  const order = result.rows[0];

  if (!order || order.status !== 'approved') {
    return res.render('verify', { found: false, order: null, statusLabels: STATUS_LABELS });
  }

  res.render('verify', {
    found: true,
    order: {
      order_no: order.order_no,
      project_name: order.project_name,
      contractor_name: order.contractor_name,
      grand_total: order.grand_total,
      status: order.status,
      final_approved_by_name: order.final_approved_by_name,
      final_approved_at: order.final_approved_at,
    },
    statusLabels: STATUS_LABELS,
  });
});

module.exports = router;
