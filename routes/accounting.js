const express = require('express');
const router = express.Router();
const db = require('../db');
const { requireLogin, requirePermission } = require('../middleware/auth');
const { canViewAccountingRequests } = require('../permissions');

const FINANCIAL_STATUS_LABELS = {
  not_sent: 'لم يُحوَّل للمحاسبة', sent_to_accounting: 'بانتظار الصرف', paid: 'تم الصرف',
};

router.use(requireLogin);
router.use(requirePermission(canViewAccountingRequests));

/* -------- طلبات الصرف: أوامر التعميد + المستخلصات المحوّلة للمحاسبة -------- */
router.get('/accounting', async (req, res) => {
  const statusFilter = req.query.status || 'sent_to_accounting'; // الافتراضي: بانتظار الصرف فقط
  const params = [];
  let statusSql = '';
  if (statusFilter !== 'all') {
    params.push(statusFilter);
    statusSql = `$${params.length}`;
  }

  let qSql = '';
  if (req.query.q) {
    params.push(`%${req.query.q}%`);
    qSql = params.length;
  }

  const buildWhere = (isOrder) => {
    const parts = [];
    if (statusFilter !== 'all') parts.push(`${isOrder ? 'o' : 'c'}.financial_status = ${statusSql}`);
    else parts.push(`${isOrder ? 'o' : 'c'}.financial_status != 'not_sent'`);
    if (qSql) {
      parts.push(isOrder
        ? `(o.project_order_no ILIKE $${qSql} OR o.order_no ILIKE $${qSql} OR o.contractor_name ILIKE $${qSql} OR o.scope ILIKE $${qSql})`
        : `(c.cert_no ILIKE $${qSql} OR o.project_order_no ILIKE $${qSql} OR o.order_no ILIKE $${qSql} OR o.contractor_name ILIKE $${qSql})`);
    }
    return parts.join(' AND ');
  };

  const rows = (await db.query(`
    SELECT 'order' AS doc_type, o.id, o.project_order_no, o.order_no, NULL::text AS cert_no,
      o.contractor_name, o.scope AS description, o.grand_total AS amount,
      o.financial_status, o.financial_requested_by_name, o.financial_requested_at,
      o.financial_paid_by_name, o.financial_paid_at, p.name AS project_name
    FROM orders o LEFT JOIN projects p ON p.id = o.project_id
    WHERE ${buildWhere(true)}

    UNION ALL

    SELECT 'certificate' AS doc_type, c.id, o.project_order_no, o.order_no, c.cert_no,
      o.contractor_name, NULL AS description, c.grand_total AS amount,
      c.financial_status, c.financial_requested_by_name, c.financial_requested_at,
      c.financial_paid_by_name, c.financial_paid_at, p.name AS project_name
    FROM payment_certificates c
    JOIN orders o ON o.id = c.order_id
    LEFT JOIN projects p ON p.id = o.project_id
    WHERE ${buildWhere(false)}

    ORDER BY financial_requested_at DESC NULLS LAST
    LIMIT 300
  `, params)).rows;

  res.render('accounting/index', { rows, financialStatusLabels: FINANCIAL_STATUS_LABELS, q: req.query, statusFilter });
});

module.exports = router;
