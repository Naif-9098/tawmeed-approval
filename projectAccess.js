const db = require('./db');
const { seesAllProjects } = require('./permissions');

/**
 * يحدد قائمة معرّفات المشاريع (project ids) التي يُسمح للمستخدم برؤيتها.
 * إرجاع null يعني "بلا قيود" (يرى الجميع).
 *
 * الأدوار الجديدة (projects_manager, technical_office, accountant, admin):
 *   وصول كامل لكل المشاريع دائمًا.
 * site_officer:
 *   فقط المشاريع المُسندة إليه صراحةً عبر project_access — لا يوجد
 *   افتراضي "مفتوح"، القيد إلزامي دائمًا.
 * الأدوار القديمة (employee, approver) تحتفظ بسلوكها الأصلي تمامًا:
 *   مشروع بلا أي صف في project_access يُعتبر "مفتوحًا" لهم.
 */
async function getAccessibleProjectIds(user) {
  if (seesAllProjects(user)) return null;

  if (user.role === 'site_officer') {
    const r = await db.query('SELECT project_id FROM project_access WHERE user_id = $1', [user.id]);
    return r.rows.map(x => x.project_id);
  }

  // سلوك الأدوار القديمة (employee, approver) — بدون تغيير
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
  if (!projectId) return true; // أوامر قديمة بلا مشروع تبقى كما كانت
  if (seesAllProjects(user)) return true;

  if (user.role === 'site_officer') {
    const granted = await db.query(
      'SELECT 1 FROM project_access WHERE project_id = $1 AND user_id = $2',
      [projectId, user.id]
    );
    return granted.rows.length > 0;
  }

  // سلوك الأدوار القديمة (employee, approver) — بدون تغيير
  const restricted = await db.query('SELECT 1 FROM project_access WHERE project_id = $1 LIMIT 1', [projectId]);
  if (restricted.rows.length === 0) return true;
  const granted = await db.query(
    'SELECT 1 FROM project_access WHERE project_id = $1 AND user_id = $2',
    [projectId, user.id]
  );
  return granted.rows.length > 0;
}

module.exports = { getAccessibleProjectIds, canAccessProject };
