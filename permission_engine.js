// permission_engine.js — محرّك الصلاحيات المرن لنظام أوامر التعميد
// -----------------------------------------------------------------------------
// الصلاحيات الفعلية = (صلاحيات القالب الوظيفي ∪ الاستثناءات المسموحة) − الممنوعة
// «الممنوع» يتغلّب دائماً. القالب الوظيفي = قيمة users.role الحالية نفسها.
//
// تُحمَّل الصلاحيات من قاعدة البيانات في **كل طلب** (middleware/auth.js)، فأي تعديل
// يُطبَّق فوراً في الخادم دون إعادة تسجيل دخول. الحماية تبقى في الخادم دائماً.
//
// الترحيل (init) آمن: جداول جديدة فقط، لا حذف لأي مستخدم/مشروع/أمر/مستخلص. كل
// مستخدم يبقى على دوره (قالبه)، وأي فرق عن القالب (مثل علم can_approve القديم) يُحفظ
// كاستثناء — فالفعلي بعد الترحيل = السابق تماماً، ويُتحقَّق من ذلك لكل مستخدم.

const REG = require('./permission_registry');

// ============================ منطق صافٍ ============================
function computeEffective(roleKeys, allow, deny) {
  const out = new Set();
  (roleKeys || []).forEach((k) => REG.isKnown(k) && out.add(k));
  (allow || []).forEach((k) => REG.isKnown(k) && out.add(k));
  (deny || []).forEach((k) => out.delete(k));
  return out;
}
function overridesFor(desired, roleKeys) {
  const want = new Set([...desired].filter(REG.isKnown)), base = new Set((roleKeys || []).filter(REG.isKnown));
  return { allow: REG.KEYS.filter((k) => want.has(k) && !base.has(k)), deny: REG.KEYS.filter((k) => !want.has(k) && base.has(k)) };
}
function sameSet(a, b) { if (a.size !== b.size) return false; for (const k of a) if (!b.has(k)) return false; return true; }
function err(status, msg) { const e = new Error(msg); e.status = status; return e; }
function cleanKeys(list) {
  const out = [];
  for (const k of Array.isArray(list) ? list : (list ? [list] : [])) {
    if (!REG.isKnown(String(k))) throw err(400, 'صلاحية غير معروفة: ' + k);
    if (!out.includes(String(k))) out.push(String(k));
  }
  return out;
}
const label = (k) => (REG.BY_KEY[k] ? REG.BY_KEY[k].label : k);

// ============================ عمليات (repo) ============================
async function stateOf(repo, userId) {
  const u = await repo.getUser(userId);
  if (!u) return null;
  const roleKeys = await repo.getRoleKeys(u.role);
  const { allow, deny } = await repo.getOverrides(userId);
  return { user: u, roleKeys, allow, deny, effective: computeEffective(roleKeys, allow, deny) };
}

async function guard(repo, actor, changedUserIds) {
  if ((await repo.countHolders(REG.MANAGE_KEY)) < 1) throw err(409, 'لا يمكن تنفيذ التغيير: يجب أن يبقى حساب مفعّل واحد على الأقل يملك «إدارة الصلاحيات والقوالب الوظيفية».');
  if (actor && actor.id && changedUserIds.includes(actor.id)) {
    const me = await stateOf(repo, actor.id);
    if (!me.effective.has(REG.MANAGE_KEY)) throw err(409, 'لا يمكنك سحب صلاحية «إدارة الصلاحيات» من حسابك أنت.');
  }
}

function diffLines(before, after) {
  const out = [];
  for (const k of REG.KEYS) if (before.has(k) !== after.has(k)) out.push({ key: k, from: before.has(k), to: after.has(k) });
  return out;
}
async function auditChanges(repo, actor, subject, changes, extra) {
  const lines = changes.map((c) => (c.to ? 'منح' : 'سحب') + ': ' + label(c.key) + ' (' + c.key + ') — من «' + (c.from ? 'مسموح' : 'غير مسموح') + '» إلى «' + (c.to ? 'مسموح' : 'غير مسموح') + '»');
  if (extra) lines.unshift(extra);
  if (!lines.length) return;
  await repo.audit(actor, 'تعديل صلاحيات: ' + subject, lines.join('\n'));
}

// حفظ صلاحيات مستخدم: القالب (اختياري) + الاستثناءات — كلها أو لا شيء (داخل معاملة).
async function saveUser(repo, { userId, roleCode, allow, deny }, actor) {
  const st = await stateOf(repo, userId);
  if (!st) throw err(404, 'المستخدم غير موجود');
  const a = cleanKeys(allow), d = cleanKeys(deny);
  const both = a.filter((k) => d.includes(k));
  if (both.length) throw err(400, 'لا يمكن أن تكون الصلاحية مسموحة وممنوعة معاً: ' + both.map(label).join('، '));
  let roleNote = null;
  if (roleCode !== undefined && roleCode !== st.user.role) {
    const role = await repo.getRole(roleCode);
    if (!role) throw err(400, 'القالب الوظيفي غير موجود');
    const old = await repo.getRole(st.user.role);
    await repo.setUserRole(userId, roleCode);
    roleNote = 'القالب الوظيفي: «' + (old ? old.name : st.user.role) + '» ← «' + role.name + '»';
  }
  await repo.replaceOverrides(userId, a, d);
  const after = (await stateOf(repo, userId)).effective;
  await guard(repo, actor, [userId]);
  await repo.syncLegacyFlags(userId, after);
  const changes = diffLines(st.effective, after);
  await auditChanges(repo, actor, st.user.name, changes, roleNote);
  return { changed: changes.length, effective: [...after] };
}

// تغيير القالب مع الإبقاء على الفعلي كما هو (يُستخدم من شاشة المستخدمين القديمة: تغيير الدور)
// — لا، شاشة المستخدمين تغيّر القالب فعلاً: الفعلي يصبح صلاحيات القالب الجديد + نفس الاستثناءات.
async function setRole(repo, userId, roleCode, actor) {
  const st = await stateOf(repo, userId);
  if (!st) throw err(404, 'المستخدم غير موجود');
  return saveUser(repo, { userId, roleCode, allow: st.allow, deny: st.deny }, actor);
}

// تفعيل/إلغاء مجموعة صلاحيات دفعة واحدة (مثل زر «صلاحية الاعتماد» في شاشة المستخدمين)
async function setGroup(repo, userId, keys, on, actor) {
  const st = await stateOf(repo, userId);
  if (!st) throw err(404, 'المستخدم غير موجود');
  const want = new Set(st.effective);
  cleanKeys(keys).forEach((k) => (on ? want.add(k) : want.delete(k)));
  const ov = overridesFor(want, st.roleKeys);
  return saveUser(repo, { userId, allow: ov.allow, deny: ov.deny }, actor);
}

async function resetToRole(repo, userId, actor) { return saveUser(repo, { userId, allow: [], deny: [] }, actor); }

async function cloneFromUser(repo, targetId, sourceId, actor) {
  if (targetId === sourceId) throw err(400, 'لا يمكن النسخ من نفس المستخدم');
  const src = await stateOf(repo, sourceId);
  if (!src) throw err(404, 'المستخدم المصدر غير موجود');
  const ov = overridesFor(src.effective, src.roleKeys);
  return saveUser(repo, { userId: targetId, roleCode: src.user.role, allow: ov.allow, deny: ov.deny }, actor);
}

async function saveRole(repo, { code, name, description, keys }, actor) {
  const role = await repo.getRole(code);
  if (!role) throw err(404, 'القالب الوظيفي غير موجود');
  const newKeys = cleanKeys(keys);
  const holders = await repo.usersWithRole(code);
  const before = new Map();
  for (const u of holders) before.set(u.id, (await stateOf(repo, u.id)).effective);
  const oldKeys = new Set(await repo.getRoleKeys(code));
  const newName = String(name || role.name).trim() || role.name;
  await repo.updateRole(code, { name: newName, description: description !== undefined ? String(description) : role.description });
  await repo.setRoleKeys(code, newKeys);
  const ids = holders.map((u) => u.id);
  await guard(repo, actor, ids);
  for (const u of holders) await repo.syncLegacyFlags(u.id, (await stateOf(repo, u.id)).effective);
  await auditChanges(repo, actor, 'القالب «' + newName + '» (يؤثر على ' + holders.length + ' مستخدم)', diffLines(oldKeys, new Set(newKeys)), newName !== role.name ? 'الاسم: «' + role.name + '» ← «' + newName + '»' : null);
  return { affected: holders.length };
}

async function createRole(repo, { name, description, keys, fromUserId }, actor) {
  const n = String(name || '').trim();
  if (n.length < 2) throw err(400, 'اسم القالب مطلوب');
  if (await repo.roleNameExists(n)) throw err(409, 'يوجد قالب بنفس الاسم');
  let k = cleanKeys(keys);
  if (fromUserId) { const s = await stateOf(repo, fromUserId); if (s) k = [...s.effective]; }
  const code = await repo.insertRole({ name: n, description: description || '' });
  await repo.setRoleKeys(code, k);
  await repo.audit(actor, 'إنشاء قالب وظيفي: ' + n, k.length + ' صلاحية' + (fromUserId ? ' (منسوخة من مستخدم)' : ''));
  return { code };
}

async function deleteRole(repo, code, actor) {
  const role = await repo.getRole(code);
  if (!role) throw err(404, 'القالب الوظيفي غير موجود');
  if (role.is_system) throw err(409, 'لا يمكن حذف القوالب الأساسية للنظام — يمكن تعديلها فقط.');
  const holders = await repo.usersWithRole(code);
  if (holders.length) throw err(409, 'لا يمكن حذف قالب مسند إلى ' + holders.length + ' مستخدم.');
  await repo.deleteRole(code);
  await repo.audit(actor, 'حذف قالب وظيفي: ' + role.name, 'لم يكن مسنداً لأي مستخدم');
}

async function describeUser(repo, userId) {
  const st = await stateOf(repo, userId);
  if (!st) return null;
  const role = await repo.getRole(st.user.role);
  return { user: st.user, role, inherited: st.roleKeys, allow: st.allow, deny: st.deny, effective: [...st.effective] };
}

async function matrix(repo) {
  const users = await repo.listUsers(), roles = await repo.listRoles();
  const rows = [];
  for (const u of users) { const st = await stateOf(repo, u.id); rows.push({ ...u, inherited: st.roleKeys, allow: st.allow, deny: st.deny, effective: [...st.effective] }); }
  const out = [];
  for (const r of roles) out.push({ ...r, keys: await repo.getRoleKeys(r.code), userCount: (await repo.usersWithRole(r.code)).length });
  return { users: rows, roles: out };
}

// الترحيل الأوّلي: القالب = الدور الحالي، والفرق (مثل can_approve) = استثناءات، مع تحقق لكل مستخدم.
async function seedUsers(repo) {
  let n = 0;
  for (const u of await repo.listUsers()) {
    const legacy = new Set(REG.legacyKeys(u.role, u.can_approve));
    const roleKeys = await repo.getRoleKeys(u.role);
    const ov = overridesFor(legacy, roleKeys);
    await repo.replaceOverrides(u.id, ov.allow, ov.deny);
    if (!sameSet((await stateOf(repo, u.id)).effective, legacy)) throw new Error('permission migration: mismatch for user ' + u.id + ' — aborted, nothing changed');
    n++;
  }
  return n;
}

// ============================ repo حقيقي (PostgreSQL) ============================
function makeRepo(q) { // q = دالة query(text, params) — عميل معاملة أو db.query
  return {
    async listUsers() { return (await q('SELECT id, name, email, role, active, can_approve FROM users ORDER BY name')).rows; },
    async getUser(id) { return (await q('SELECT id, name, email, role, active, can_approve FROM users WHERE id = $1', [id])).rows[0] || null; },
    async setUserRole(id, code) { await q('UPDATE users SET role = $1 WHERE id = $2', [code, id]); },
    async setActive(id, active) { await q('UPDATE users SET active = $1 WHERE id = $2', [!!active, id]); },
    async getOverrides(id) {
      const r = await q('SELECT perm_key, effect FROM user_permission_overrides WHERE user_id = $1', [id]);
      return { allow: r.rows.filter((x) => x.effect === 'allow').map((x) => x.perm_key), deny: r.rows.filter((x) => x.effect === 'deny').map((x) => x.perm_key) };
    },
    async replaceOverrides(id, allow, deny) {
      await q('DELETE FROM user_permission_overrides WHERE user_id = $1', [id]);
      for (const k of allow) await q("INSERT INTO user_permission_overrides (user_id, perm_key, effect) VALUES ($1,$2,'allow')", [id, k]);
      for (const k of deny) await q("INSERT INTO user_permission_overrides (user_id, perm_key, effect) VALUES ($1,$2,'deny')", [id, k]);
    },
    async countHolders(key) {
      const r = await q(
        `SELECT COUNT(*)::int n FROM users u WHERE u.active = true AND
           ( EXISTS (SELECT 1 FROM role_permissions rp WHERE rp.role_code = u.role AND rp.perm_key = $1)
             OR EXISTS (SELECT 1 FROM user_permission_overrides o WHERE o.user_id = u.id AND o.perm_key = $1 AND o.effect = 'allow') )
           AND NOT EXISTS (SELECT 1 FROM user_permission_overrides o WHERE o.user_id = u.id AND o.perm_key = $1 AND o.effect = 'deny')`, [key]);
      return r.rows[0].n;
    },
    // عمود can_approve القديم يُبقى متطابقاً مع «اعتماد أوامر التعميد» الفعلية (توافق فقط؛ لا يُقرأ للتحقق)
    async syncLegacyFlags(id, eff) { await q('UPDATE users SET can_approve = $1 WHERE id = $2', [eff.has('ORDER_APPROVE'), id]); },
    async listRoles() { return (await q('SELECT code, name, description, is_system FROM permission_roles ORDER BY is_system DESC, name')).rows; },
    async getRole(code) { return (await q('SELECT code, name, description, is_system FROM permission_roles WHERE code = $1', [code])).rows[0] || null; },
    async roleNameExists(n) { return !!(await q('SELECT 1 FROM permission_roles WHERE lower(name) = lower($1)', [n])).rows[0]; },
    async insertRole({ name, description }) {
      const code = 'custom_' + Date.now().toString(36) + Math.floor(Math.random() * 1e4).toString(36);
      await q('INSERT INTO permission_roles (code, name, description, is_system) VALUES ($1,$2,$3,false)', [code, name, description]);
      return code;
    },
    async updateRole(code, { name, description }) { await q('UPDATE permission_roles SET name = $1, description = $2, updated_at = now() WHERE code = $3', [name, description, code]); },
    async deleteRole(code) { await q('DELETE FROM permission_roles WHERE code = $1 AND is_system = false', [code]); },
    async getRoleKeys(code) { return (await q('SELECT perm_key FROM role_permissions WHERE role_code = $1', [code])).rows.map((r) => r.perm_key); },
    async setRoleKeys(code, keys) {
      await q('DELETE FROM role_permissions WHERE role_code = $1', [code]);
      for (const k of keys) await q('INSERT INTO role_permissions (role_code, perm_key) VALUES ($1,$2)', [code, k]);
    },
    async usersWithRole(code) { return (await q('SELECT id, name FROM users WHERE role = $1 ORDER BY name', [code])).rows; },
    // يُكتب في سجل العمليات الموجود نفسه (audit_log — إضافة فقط)
    async audit(actor, action, details) {
      await q('INSERT INTO audit_log (order_id, action, actor_id, actor_name, details) VALUES (NULL, $1, $2, $3, $4)', [action, actor && actor.id || null, actor && actor.name || 'النظام', details || null]);
    },
  };
}

// ============================ التحميل في كل طلب ============================
// ذاكرة مؤقتة لصلاحيات القوالب فقط (تُمسح فور أي تعديل على قالب). الاستثناءات وحالة
// المستخدم تُقرأ من قاعدة البيانات في كل طلب، فالتغيير يُطبَّق فوراً.
const roleCache = new Map();
function invalidateRoles() { roleCache.clear(); }
async function loadUserPermissions(db, userId) {
  const r = await db.query('SELECT id, name, role, active, job_title FROM users WHERE id = $1', [userId]);
  const u = r.rows[0];
  if (!u) return null;
  let rk = roleCache.get(u.role);
  if (!rk) {
    const rr = await db.query('SELECT perm_key FROM role_permissions WHERE role_code = $1', [u.role]);
    const nm = await db.query('SELECT name FROM permission_roles WHERE code = $1', [u.role]);
    rk = { keys: rr.rows.map((x) => x.perm_key), name: nm.rows[0] ? nm.rows[0].name : u.role };
    roleCache.set(u.role, rk);
  }
  const ov = await db.query('SELECT perm_key, effect FROM user_permission_overrides WHERE user_id = $1', [userId]);
  const eff = computeEffective(rk.keys, ov.rows.filter((x) => x.effect === 'allow').map((x) => x.perm_key), ov.rows.filter((x) => x.effect === 'deny').map((x) => x.perm_key));
  return { user: u, roleName: rk.name, keys: eff };
}

// من يملك صلاحية معيّنة فعلياً (لقوائم «المعتمد المسؤول» مثلاً)
async function usersWithPermission(db, key) {
  const r = await db.query(
    `SELECT u.id, u.name FROM users u WHERE u.active = true AND
       ( EXISTS (SELECT 1 FROM role_permissions rp WHERE rp.role_code = u.role AND rp.perm_key = $1)
         OR EXISTS (SELECT 1 FROM user_permission_overrides o WHERE o.user_id = u.id AND o.perm_key = $1 AND o.effect = 'allow') )
       AND NOT EXISTS (SELECT 1 FROM user_permission_overrides o WHERE o.user_id = u.id AND o.perm_key = $1 AND o.effect = 'deny')
     ORDER BY u.name`, [key]);
  return r.rows;
}

// ============================ الترحيل عند الإقلاع (Safe Migration) ============================
const SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS permission_roles (
    code TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
    is_system BOOLEAN NOT NULL DEFAULT false,
    created_at TIMESTAMP NOT NULL DEFAULT now(), updated_at TIMESTAMP NOT NULL DEFAULT now());
  CREATE TABLE IF NOT EXISTS role_permissions (
    role_code TEXT NOT NULL REFERENCES permission_roles(code) ON UPDATE CASCADE ON DELETE CASCADE,
    perm_key TEXT NOT NULL, PRIMARY KEY (role_code, perm_key));
  CREATE TABLE IF NOT EXISTS user_permission_overrides (
    user_id INT NOT NULL REFERENCES users(id), perm_key TEXT NOT NULL,
    effect TEXT NOT NULL CHECK (effect IN ('allow','deny')), updated_at TIMESTAMP NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, perm_key));
  CREATE TABLE IF NOT EXISTS system_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
`;
const SEED_FLAG = 'permissions_engine_seeded_v1';

async function init(db) {
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(SCHEMA_SQL);
    const q = (t, p) => client.query(t, p);
    const repo = makeRepo(q);
    // القوالب الأساسية = الأدوار الحالية، بصلاحياتها كما كانت تماماً (لا تُعاد كتابتها إن وُجدت)
    for (const r of REG.SYSTEM_ROLES) {
      const exists = await q('SELECT 1 FROM permission_roles WHERE code = $1', [r.code]);
      if (!exists.rows[0]) {
        await q('INSERT INTO permission_roles (code, name, is_system) VALUES ($1,$2,true)', [r.code, r.name]);
        await repo.setRoleKeys(r.code, REG.legacyKeys(r.code, r.code === 'approver'));
      }
    }
    const flag = await q('SELECT value FROM system_settings WHERE key = $1', [SEED_FLAG]);
    if (!flag.rows[0]) {
      const n = await seedUsers(repo);
      // الدور لم يعد قائمة ثابتة في الكود: يشير إلى قالب موجود (يسمح بقوالب جديدة من الواجهة).
      await q('ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check');
      const fk = await q("SELECT 1 FROM pg_constraint WHERE conname = 'users_role_template_fk'");
      if (!fk.rows[0]) await q('ALTER TABLE users ADD CONSTRAINT users_role_template_fk FOREIGN KEY (role) REFERENCES permission_roles(code) ON UPDATE CASCADE');
      await q('INSERT INTO system_settings (key, value) VALUES ($1, $2)', [SEED_FLAG, new Date().toISOString()]);
      await repo.audit(null, 'ترحيل نظام الصلاحيات المرن', n + ' مستخدم — صلاحيات كل مستخدم محفوظة كما كانت تماماً');
      console.log('[permissions] migration done: ' + n + ' users, permissions preserved exactly');
    }
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
  invalidateRoles();
}

// تنفيذ عملية كتابة داخل معاملة واحدة
async function tx(db, fn) {
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    const out = await fn(makeRepo((t, p) => client.query(t, p)));
    await client.query('COMMIT');
    invalidateRoles();
    return out;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

module.exports = {
  computeEffective, overridesFor, sameSet,
  stateOf, saveUser, setRole, setGroup, resetToRole, cloneFromUser, saveRole, createRole, deleteRole, describeUser, matrix, seedUsers,
  makeRepo, init, tx, loadUserPermissions, usersWithPermission, invalidateRoles,
};
