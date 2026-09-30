const db = require('./db');
const { seesAllProjects, seesOpenProjects } = require('./permissions');

/**
 * «أين» يستطيع المستخدم العمل؟ — يكمل الصلاحيات («ماذا») والملكية («على بيانات من»).
 *
 * PROJECT_VIEW_ALL  : كل المشاريع (null = بلا قيود).
 * PROJECT_VIEW_OPEN : المشاريع المسندة إليه + المشاريع «المفتوحة» التي لا قائمة وصول لها
 *                     (سلوك الأدوار القديمة: موظف / معتمد — كما كان تماماً).
 * بدون أيٍّ منهما   : المشاريع المسندة إليه صراحةً عبر project_access فقط (مسؤول الموقع).
 */
async function getAccessibleProjectIds(user) {
  if (seesAllProjects(user)) return null;
  const grantedRes = await db.query('SELECT project_id FROM project_access WHERE user_id = $1', [user.id]);
  const ids = new Set(grantedRes.rows.map((r) => r.project_id));
  if (seesOpenProjects(user)) {
    const openRes = await db.query(`
      SELECT p.id FROM projects p
      WHERE NOT EXISTS (SELECT 1 FROM project_access pa WHERE pa.project_id = p.id)
    `);
    openRes.rows.forEach((r) => ids.add(r.id));
  }
  return Array.from(ids);
}

/** تحقق نقطي: هل يستطيع هذا المستخدم الوصول لمشروع بعينه؟ */
async function canAccessProject(user, projectId) {
  if (!projectId) return true; // أوامر قديمة بلا مشروع تبقى كما كانت
  if (seesAllProjects(user)) return true;
  const granted = await db.query('SELECT 1 FROM project_access WHERE project_id = $1 AND user_id = $2', [projectId, user.id]);
  if (granted.rows.length > 0) return true;
  if (!seesOpenProjects(user)) return false;
  const restricted = await db.query('SELECT 1 FROM project_access WHERE project_id = $1 LIMIT 1', [projectId]);
  return restricted.rows.length === 0;
}

module.exports = { getAccessibleProjectIds, canAccessProject };
