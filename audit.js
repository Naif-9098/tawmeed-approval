const db = require('./db');

/**
 * يسجّل حدثًا في سجل العمليات (Audit Log).
 * هذا هو المسار الوحيد للكتابة في السجل داخل كل التطبيق —
 * لا يوجد أي route يسمح بتعديل أو حذف صف من audit_log،
 * وبالتالي فالسجل يبقى إضافة-فقط (append-only) من واجهة النظام.
 */
async function logAction({ orderId = null, action, actorId = null, actorName, details = null }) {
  await db.query(
    `INSERT INTO audit_log (order_id, action, actor_id, actor_name, details)
     VALUES ($1, $2, $3, $4, $5)`,
    [orderId, action, actorId, actorName, details]
  );
}

module.exports = { logAction };
