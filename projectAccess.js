const db = require('./db');

/**
 * يحدد قائمة معرّفات المشاريع (project ids) التي يُسمح للمستخدم برؤيتها.
 * إرجاع null يعني "بلا قيود" (مدير النظام يرى كل شيء).
 * المشروع الذي لا يملك أي صف في project_access يُعتبر "مفتوحًا" لكل من له صلاحية أصلاً.
 */
async function getAccessibleProjectIds(user) {
  if (user.role === 'admin') return null;
  const openRes = await db.query(`
    SELECT p.id FROM projects p
    WHERE NOT EXISTS (SELECT 1 FROM project_access pa WHERE pa.project_id = p.id)
  `);
  const grantedRes = await db.query('SELECT project_id FROM project_access WHERE user_id = $1', [user.id]);
  const ids = new Set([
    ...openRes.rows.map(r => r.id),
    ...grantedRes.rows.map(r => r.project_id),
  ]);
  return Array.from(ids);
}

/** تحقق نقطي: هل يستطيع هذا المستخدم الوصول لمشروع بعينه؟ */
async function canAccessProject(user, projectId) {
  if (!projectId) return true; // أوامر قديمة بلا مشروع تبقى كما كانت (لا قيد جديد عليها)
  if (user.role === 'admin') return true;
  const restricted = await db.query('SELECT 1 FROM project_access WHERE project_id = $1 LIMIT 1', [projectId]);
  if (restricted.rows.length === 0) return true; // مشروع مفتوح، لا قيود مُعرَّفة عليه
  const granted = await db.query(
    'SELECT 1 FROM project_access WHERE project_id = $1 AND user_id = $2',
    [projectId, user.id]
  );
  return granted.rows.length > 0;
}

module.exports = { getAccessibleProjectIds, canAccessProject };
