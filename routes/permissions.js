// routes/permissions.js — «الإعدادات والصلاحيات»
// كل المسارات خلف PERMISSIONS_MANAGE (تحقق في الخادم). لا يُحفظ أي تغيير عند النقر:
// «حفظ التغييرات» يعرض صفحة مراجعة بملخص التغييرات، ثم التأكيد يطبّقها في معاملة واحدة.
const express = require('express');
const router = express.Router();
const db = require('../db');
const { requireLogin, requirePermission } = require('../middleware/auth');
const { canManagePermissions } = require('../permissions');
const REG = require('../permission_registry');
const engine = require('../permission_engine');

router.use(requireLogin);
router.use(requirePermission(canManagePermissions));

const repoRO = () => engine.makeRepo((t, p) => db.query(t, p));
const fail = (res, e) => res.status(e.status || 500).render('error', { title: 'لم يتم الحفظ', message: e.status ? e.message : 'تعذّر تنفيذ العملية.' });
const scopeOf = (keys) => { // المفتاح ← مجموعة النطاق التي ينتمي إليها
  const m = {}; Object.entries(REG.SCOPES).forEach(([id, s]) => s.options.forEach((o) => o.keys.forEach((k) => (m[k] = id)))); return m;
};
const SCOPE_OF = scopeOf();
// الخيار الحالي للنطاق = الخيار الذي تطابق مفاتيحه الصلاحيات الفعلية تماماً؛ وإن لم يطابق أي خيار
// (استثناءات يدوية جزئية) نعرض أعلى خيار يملكه كاملاً — مع علامة partial حتى لا يُحفظ شيء دون قصد.
const scopeValue = (sid, eff) => {
  const opts = REG.SCOPES[sid].options, all = [...new Set(opts.flatMap((o) => o.keys))];
  const held = all.filter((k) => eff.has(k)).sort().join();
  const exact = opts.find((o) => [...o.keys].sort().join() === held);
  if (exact) return exact.value;
  let v = opts[0].value; opts.forEach((o) => { if (o.keys.every((k) => eff.has(k))) v = o.value; }); return v;
};
const common = () => ({ REG, SCOPE_OF });

// ---------------- المستخدمون ----------------
router.get('/', async (req, res) => {
  const m = await engine.matrix(repoRO());
  res.render('permissions/index', { ...common(), tab: 'users', users: m.users, roles: m.roles });
});

router.get('/users/:id', async (req, res) => {
  const d = await engine.describeUser(repoRO(), parseInt(req.params.id, 10));
  if (!d) return res.status(404).render('error', { title: 'غير موجود', message: 'المستخدم غير موجود.' });
  const roles = await repoRO().listRoles();
  const roleKeys = {}; for (const r of roles) roleKeys[r.code] = await repoRO().getRoleKeys(r.code);
  const others = (await repoRO().listUsers()).filter((u) => u.id !== d.user.id);
  const eff = new Set(d.effective);
  const scopes = {}; Object.keys(REG.SCOPES).forEach((sid) => (scopes[sid] = scopeValue(sid, eff)));
  res.render('permissions/user', { ...common(), tab: 'users', d, roles, roleKeys, others, scopes, saved: req.query.saved || null });
});

// يبني الاستثناءات من النموذج: الصلاحيات العادية (افتراضي/سماح/منع) + قوائم النطاق (المطلوب فعلياً)
async function parseForm(userId, body) {
  const d = await engine.describeUser(repoRO(), userId);
  if (!d) { const e = new Error('المستخدم غير موجود'); e.status = 404; throw e; }
  const roleCode = String(body.role || d.user.role);
  if (!(await repoRO().getRole(roleCode))) { const e = new Error('القالب الوظيفي غير موجود'); e.status = 400; throw e; }
  const base = new Set(await repoRO().getRoleKeys(roleCode));
  const allow = [], deny = [];
  for (const p of REG.PERMISSIONS) {
    if (SCOPE_OF[p.key]) continue;
    const v = body['p_' + p.key];
    if (v === 'allow') allow.push(p.key); else if (v === 'deny') deny.push(p.key);
  }
  for (const [sid, s] of Object.entries(REG.SCOPES)) {
    const opt = s.options.find((o) => o.value === body['scope_' + sid]) || null;
    if (!opt) continue;
    const want = new Set(opt.keys);
    s.options.flatMap((o) => o.keys).filter((k, i, a) => a.indexOf(k) === i).forEach((k) => {
      if (want.has(k) && !base.has(k)) allow.push(k);
      if (!want.has(k) && base.has(k)) deny.push(k);
    });
  }
  const after = engine.computeEffective([...base], allow, deny);
  return { d, roleCode, allow, deny, after };
}

router.post('/users/:id/review', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const { d, roleCode, allow, deny, after } = await parseForm(id, req.body);
    const before = new Set(d.effective);
    const changes = REG.PERMISSIONS.filter((p) => before.has(p.key) !== after.has(p.key)).map((p) => ({ p, to: after.has(p.key) }));
    const newRole = await repoRO().getRole(roleCode);
    const oldRole = await repoRO().getRole(d.user.role);
    res.render('permissions/review', {
      ...common(), tab: 'users', d, changes, roleChanged: roleCode !== d.user.role, newRole, oldRole, roleCode, allow, deny,
      dangerGrants: changes.filter((c) => c.to && c.p.danger),
    });
  } catch (e) { fail(res, e); }
});

router.post('/users/:id/save', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const list = (v) => (v ? String(v).split(',').filter(Boolean) : []);
  try {
    await engine.tx(db, (repo) => engine.saveUser(repo, { userId: id, roleCode: String(req.body.role), allow: list(req.body.allow), deny: list(req.body.deny) }, req.session.user));
    res.redirect('/permissions/users/' + id + '?saved=1');
  } catch (e) { fail(res, e); }
});

router.post('/users/:id/reset', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  try { await engine.tx(db, (repo) => engine.resetToRole(repo, id, req.session.user)); res.redirect('/permissions/users/' + id + '?saved=reset'); }
  catch (e) { fail(res, e); }
});

router.post('/users/:id/clone', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  try { await engine.tx(db, (repo) => engine.cloneFromUser(repo, id, parseInt(req.body.source_id, 10), req.session.user)); res.redirect('/permissions/users/' + id + '?saved=clone'); }
  catch (e) { fail(res, e); }
});

router.post('/users/:id/save-as-role', async (req, res) => {
  try {
    const { code } = await engine.tx(db, (repo) => engine.createRole(repo, { name: req.body.name, fromUserId: parseInt(req.params.id, 10) }, req.session.user));
    res.redirect('/permissions/roles/' + code + '?saved=created');
  } catch (e) { fail(res, e); }
});

// ---------------- المصفوفة ----------------
router.get('/matrix', async (req, res) => {
  const m = await engine.matrix(repoRO());
  res.render('permissions/matrix', { ...common(), tab: 'matrix', users: m.users, roles: m.roles });
});

// ---------------- القوالب الوظيفية ----------------
router.get('/roles', async (req, res) => {
  const m = await engine.matrix(repoRO());
  res.render('permissions/roles', { ...common(), tab: 'roles', roles: m.roles, role: null });
});
router.get('/roles/:code', async (req, res) => {
  const m = await engine.matrix(repoRO());
  const role = m.roles.find((r) => r.code === req.params.code);
  if (!role) return res.status(404).render('error', { title: 'غير موجود', message: 'القالب الوظيفي غير موجود.' });
  res.render('permissions/roles', { ...common(), tab: 'roles', roles: m.roles, role, saved: req.query.saved });
});
router.post('/roles/new', async (req, res) => {
  try { const { code } = await engine.tx(db, (repo) => engine.createRole(repo, { name: req.body.name, keys: [] }, req.session.user)); res.redirect('/permissions/roles/' + code); }
  catch (e) { fail(res, e); }
});
router.post('/roles/:code/review', async (req, res) => {
  const m = await engine.matrix(repoRO());
  const role = m.roles.find((r) => r.code === req.params.code);
  if (!role) return res.status(404).render('error', { title: 'غير موجود', message: 'القالب الوظيفي غير موجود.' });
  const keys = REG.KEYS.filter((k) => req.body['k_' + k] === 'on');
  const before = new Set(role.keys), after = new Set(keys);
  const changes = REG.PERMISSIONS.filter((p) => before.has(p.key) !== after.has(p.key)).map((p) => ({ p, to: after.has(p.key) }));
  res.render('permissions/role_review', { ...common(), tab: 'roles', role, keys, name: String(req.body.name || role.name), description: String(req.body.description || ''), changes, dangerGrants: changes.filter((c) => c.to && c.p.danger) });
});
router.post('/roles/:code/save', async (req, res) => {
  try {
    await engine.tx(db, (repo) => engine.saveRole(repo, { code: req.params.code, name: req.body.name, description: req.body.description, keys: String(req.body.keys || '').split(',').filter(Boolean) }, req.session.user));
    res.redirect('/permissions/roles/' + req.params.code + '?saved=1');
  } catch (e) { fail(res, e); }
});
router.post('/roles/:code/delete', async (req, res) => {
  try { await engine.tx(db, (repo) => engine.deleteRole(repo, req.params.code, req.session.user)); res.redirect('/permissions/roles'); }
  catch (e) { fail(res, e); }
});

// ---------------- سجل تغييرات الصلاحيات ----------------
router.get('/audit', async (req, res) => {
  const rows = (await db.query(
    `SELECT * FROM audit_log
      WHERE action LIKE 'تعديل صلاحيات%' OR action LIKE '%قالب وظيفي%' OR action LIKE 'ترحيل نظام الصلاحيات%'
         OR action IN ('تم تعطيل مستخدم','تم تفعيل مستخدم','تم إنشاء مستخدم جديد')
      ORDER BY created_at DESC LIMIT 400`)).rows;
  res.render('permissions/audit', { ...common(), tab: 'audit', rows });
});

module.exports = router;
