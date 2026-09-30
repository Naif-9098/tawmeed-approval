// permission_engine_test.js — عمليات المحرّك + الـmiddleware الحقيقي (injectUser/requirePermission)
// فوق قاعدة بيانات في الذاكرة. التشغيل: node permission_engine_test.js
const assert = require('assert'), Module = require('module'), path = require('path');
const REG = require('./permission_registry');
const E = require('./permission_engine');

// ---------------- حالة في الذاكرة ----------------
let S;
function reset() {
  S = { users: [], roles: {}, roleKeys: {}, overrides: {}, audit: [], seq: 0 };
  REG.SYSTEM_ROLES.forEach((r) => { S.roles[r.code] = { code: r.code, name: r.name, description: '', is_system: true }; S.roleKeys[r.code] = REG.legacyKeys(r.code, r.code === 'approver'); });
  const add = (id, name, role, can_approve) => S.users.push({ id, name, email: name + '@x', role, active: true, can_approve });
  add(1, 'سعود', 'projects_manager', false); add(2, 'عمر', 'technical_office', false); add(3, 'عبدالرؤوف', 'technical_office', true);
  add(4, 'مسؤول موقع', 'site_officer', false); add(5, 'المحاسب', 'accountant', false);
}
const effOf = (u) => { const o = S.overrides[u.id] || { allow: [], deny: [] }; return E.computeEffective(S.roleKeys[u.role] || [], o.allow, o.deny); };
const repo = {
  async listUsers() { return S.users.map((u) => ({ ...u })); },
  async getUser(id) { const u = S.users.find((x) => x.id === id); return u ? { ...u } : null; },
  async setUserRole(id, code) { S.users.find((x) => x.id === id).role = code; },
  async setActive(id, a) { S.users.find((x) => x.id === id).active = !!a; },
  async getOverrides(id) { const o = S.overrides[id] || { allow: [], deny: [] }; return { allow: [...o.allow], deny: [...o.deny] }; },
  async replaceOverrides(id, allow, deny) { S.overrides[id] = { allow: [...allow], deny: [...deny] }; },
  async countHolders(key) { return S.users.filter((u) => u.active && effOf(u).has(key)).length; },
  async syncLegacyFlags(id, eff) { S.users.find((x) => x.id === id).can_approve = eff.has('ORDER_APPROVE'); },
  async listRoles() { return Object.values(S.roles); },
  async getRole(code) { return S.roles[code] ? { ...S.roles[code] } : null; },
  async roleNameExists(n) { return Object.values(S.roles).some((r) => r.name === n); },
  async insertRole({ name, description }) { const code = 'custom_' + ++S.seq; S.roles[code] = { code, name, description, is_system: false }; return code; },
  async updateRole(code, v) { Object.assign(S.roles[code], v); },
  async deleteRole(code) { delete S.roles[code]; delete S.roleKeys[code]; },
  async getRoleKeys(code) { return [...(S.roleKeys[code] || [])]; },
  async setRoleKeys(code, keys) { S.roleKeys[code] = [...keys]; },
  async usersWithRole(code) { return S.users.filter((u) => u.role === code).map((u) => ({ id: u.id, name: u.name })); },
  async audit(actor, action, details) { S.audit.push({ actor: actor && actor.name, action, details }); },
};
async function tx(fn) { const snap = JSON.stringify(S); try { return await fn(repo); } catch (e) { S = JSON.parse(snap); throw e; } }
const ADMIN = { id: 1, name: 'سعود' };

// ---------------- db وهمي للـmiddleware الحقيقي (loadUserPermissions) ----------------
const fakeDb = { async query(sql, p) {
  if (/FROM users WHERE id = \$1/.test(sql)) { const u = S.users.find((x) => x.id === p[0]); return { rows: u ? [{ ...u, job_title: null }] : [] }; }
  if (/FROM role_permissions WHERE role_code/.test(sql)) return { rows: (S.roleKeys[p[0]] || []).map((k) => ({ perm_key: k })) };
  if (/FROM permission_roles WHERE code/.test(sql)) return { rows: S.roles[p[0]] ? [{ name: S.roles[p[0]].name }] : [] };
  if (/FROM user_permission_overrides WHERE user_id/.test(sql)) { const o = S.overrides[p[0]] || { allow: [], deny: [] }; return { rows: o.allow.map((k) => ({ perm_key: k, effect: 'allow' })).concat(o.deny.map((k) => ({ perm_key: k, effect: 'deny' }))) }; }
  throw new Error('fakeDb: ' + sql.slice(0, 60));
} };
const origLoad = Module._load;
Module._load = function (req, parent, ...r) { if (req === '../db' && parent && /middleware[\\/]auth\.js$/.test(parent.filename)) return fakeDb; return origLoad.call(this, req, parent, ...r); };
const { injectUser, requirePermission } = require('./middleware/auth');
const P = require('./permissions');
function request(session, guard) {
  return new Promise((resolve, reject) => {
    const req = { session: { user: session, destroy: (cb) => cb() } };
    const res = { locals: {}, status(c) { this.code = c; return this; }, render() { resolve(this.code || 200); }, redirect(to) { resolve('redirect:' + to); } };
    injectUser(req, res, (err) => { if (err) return reject(err); guard(req, res, () => resolve(200)); });
  });
}

const results = [];
async function t(name, fn) { try { reset(); E.invalidateRoles(); await fn(); results.push(['PASS', name]); } catch (e) { results.push(['FAIL', name + ' — ' + e.message]); } }

(async () => {
  await t('ترحيل: كل مستخدم يحتفظ بصلاحياته، وعبدالرؤوف (مكتب فني + علم اعتماد) يحصل على صلاحيات الاعتماد كاستثناء', async () => {
    await tx((r) => E.seedUsers(r));
    for (const u of S.users) assert.deepStrictEqual([...effOf(u)].sort(), REG.legacyKeys(u.role, u.can_approve).sort());
    assert.deepStrictEqual(S.overrides[3].allow.sort(), ['CERTIFICATE_APPROVE', 'CERTIFICATE_REJECT', 'CERTIFICATE_RETURN', 'ORDER_APPROVE', 'ORDER_REJECT', 'ORDER_RETURN']);
    assert.deepStrictEqual(S.overrides[2], { allow: [], deny: [] });
  });

  await t('نقل أمر (ORDER_MOVE): 403 ← منح ← مسموح ← سحب ← 403 — بنفس الجلسة دون إعادة دخول', async () => {
    await tx((r) => E.seedUsers(r));
    const session = { id: 2, name: 'عمر', role: 'technical_office' };
    const guard = requirePermission(P.canMoveOrders);
    assert.strictEqual(await request(session, guard), 403);
    await tx((r) => E.saveUser(r, { userId: 2, allow: ['ORDER_MOVE'], deny: [] }, ADMIN));
    assert.strictEqual(await request(session, guard), 200);
    const s3 = { id: 3, name: 'عبدالرؤوف', role: 'technical_office' };
    assert.strictEqual(await request(s3, guard), 403, 'زميله في نفس القالب لم يتأثر');
    await tx((r) => E.saveUser(r, { userId: 2, allow: [], deny: [] }, ADMIN));
    assert.strictEqual(await request(session, guard), 403);
    assert.ok(!Object.keys(session).includes('perms'), 'الصلاحيات لا تُحفظ في الجلسة');
  });

  await t('المنع يتغلّب على القالب: منع ACCOUNTING_MARK_PAID عن المحاسب → 403 على تسجيل الصرف', async () => {
    const acc = { id: 5, name: 'المحاسب', role: 'accountant' };
    const guard = requirePermission(P.canConfirmPayment);
    assert.strictEqual(await request(acc, guard), 200);
    await tx((r) => E.saveUser(r, { userId: 5, allow: [], deny: ['ACCOUNTING_MARK_PAID'] }, ADMIN));
    assert.strictEqual(await request(acc, guard), 403);
    const d = await E.describeUser(repo, 5);
    assert.ok(d.inherited.includes('ACCOUNTING_MARK_PAID') && d.deny.includes('ACCOUNTING_MARK_PAID') && !d.effective.includes('ACCOUNTING_MARK_PAID'));
  });

  await t('تعديل قالب «المكتب الفني» يُطبَّق فوراً على كل حامليه مع بقاء استثناءاتهم', async () => {
    await tx((r) => E.seedUsers(r));
    await tx((r) => E.saveRole(r, { code: 'technical_office', keys: [...S.roleKeys.technical_office, 'ORDER_MOVE'] }, ADMIN));
    assert.strictEqual(await request({ id: 2, name: 'عمر', role: 'technical_office' }, requirePermission(P.canMoveOrders)), 200);
    assert.strictEqual(await request({ id: 3, name: 'x', role: 'technical_office' }, requirePermission(P.canMoveOrders)), 200);
    assert.ok(effOf(S.users[2]).has('ORDER_APPROVE'), 'استثناء الاعتماد باقٍ');
  });

  await t('تغيير القالب يتبع صلاحيات القالب الجديد، وزر «صلاحية الاعتماد» يمنح/يسحب الست معاً', async () => {
    await tx((r) => E.setRole(r, 4, 'technical_office', ADMIN));
    assert.ok(effOf(S.users[3]).has('ORDER_EDIT_ALL'));
    await tx((r) => E.setGroup(r, 4, ['ORDER_APPROVE', 'ORDER_REJECT', 'ORDER_RETURN', 'CERTIFICATE_APPROVE', 'CERTIFICATE_REJECT', 'CERTIFICATE_RETURN'], true, ADMIN));
    assert.ok(effOf(S.users[3]).has('CERTIFICATE_RETURN') && S.users[3].can_approve === true, 'عمود التوافق can_approve مُزامَن');
    await tx((r) => E.setGroup(r, 4, ['ORDER_APPROVE', 'ORDER_REJECT', 'ORDER_RETURN', 'CERTIFICATE_APPROVE', 'CERTIFICATE_REJECT', 'CERTIFICATE_RETURN'], false, ADMIN));
    assert.ok(!effOf(S.users[3]).has('ORDER_APPROVE') && S.users[3].can_approve === false);
  });

  await t('منع قفل النظام: لا يمكن سحب إدارة الصلاحيات من آخر من يملكها — تراجع كامل', async () => {
    const before = JSON.stringify(S);
    await assert.rejects(tx((r) => E.saveUser(r, { userId: 1, allow: [], deny: ['PERMISSIONS_MANAGE'] }, { id: 99, name: 'x' })), /حساب مفعّل واحد على الأقل/);
    await assert.rejects(tx((r) => E.setRole(r, 1, 'site_officer', { id: 99, name: 'x' })), /حساب مفعّل واحد على الأقل/);
    assert.strictEqual(JSON.stringify(S), before);
  });

  await t('لا يسحب المدير «إدارة الصلاحيات» من نفسه حتى مع وجود مدير آخر', async () => {
    await tx((r) => E.setRole(r, 2, 'projects_manager', ADMIN));
    await assert.rejects(tx((r) => E.saveUser(r, { userId: 1, allow: [], deny: ['PERMISSIONS_MANAGE'] }, ADMIN)), /من حسابك أنت/);
    await tx((r) => E.saveUser(r, { userId: 1, allow: [], deny: ['PERMISSIONS_MANAGE'] }, { id: 2, name: 'عمر' }));
    assert.ok(!effOf(S.users[0]).has('PERMISSIONS_MANAGE'));
  });

  await t('حساب معطّل: جلسته تنتهي فوراً عند الطلب التالي', async () => {
    S.users[4].active = false;
    assert.strictEqual(await request({ id: 5, name: 'المحاسب', role: 'accountant' }, requirePermission(P.canConfirmPayment)), 'redirect:/login');
  });

  await t('مدخلات غير صالحة تُرفض 400 بلا أي تغيير', async () => {
    const before = JSON.stringify(S);
    await assert.rejects(tx((r) => E.saveUser(r, { userId: 4, allow: ['HACK'], deny: [] }, ADMIN)), (e) => e.status === 400);
    await assert.rejects(tx((r) => E.saveUser(r, { userId: 4, allow: ['ORDER_MOVE'], deny: ['ORDER_MOVE'] }, ADMIN)), (e) => e.status === 400);
    await assert.rejects(tx((r) => E.setRole(r, 4, 'no_such_role', ADMIN)), (e) => e.status === 400);
    assert.strictEqual(JSON.stringify(S), before);
  });

  await t('قوالب: إنشاء من صلاحيات مستخدم، نسخ الصلاحيات، حذف غير المستخدم فقط، ومنع حذف الأساسية', async () => {
    const { code } = await tx((r) => E.createRole(r, { name: 'مهندس مشتريات', fromUserId: 3 }, ADMIN));
    assert.deepStrictEqual(S.roleKeys[code].sort(), [...effOf(S.users[2])].sort());
    await tx((r) => E.cloneFromUser(r, 4, 3, ADMIN));
    assert.deepStrictEqual([...effOf(S.users[3])].sort(), [...effOf(S.users[2])].sort());
    await assert.rejects(tx((r) => E.deleteRole(r, 'site_officer', ADMIN)), (e) => e.status === 409);
    await tx((r) => E.setRole(r, 4, code, ADMIN));
    await assert.rejects(tx((r) => E.deleteRole(r, code, ADMIN)), (e) => e.status === 409);
    await tx((r) => E.setRole(r, 4, 'site_officer', ADMIN));
    await tx((r) => E.deleteRole(r, code, ADMIN));
    assert.ok(!S.roles[code]);
  });

  await t('سجل العمليات: المنفّذ + المستخدم + الصلاحية + القيمة القديمة والجديدة', async () => {
    await tx((r) => E.saveUser(r, { userId: 2, allow: ['ORDER_MOVE'], deny: [] }, ADMIN));
    const a = S.audit.find((x) => x.action.includes('عمر'));
    assert.ok(a && a.actor === 'سعود' && a.details.includes('ORDER_MOVE') && a.details.includes('من «غير مسموح» إلى «مسموح»'));
  });

  Module._load = origLoad;
  results.forEach((r) => console.log(r[0] + '  ' + r[1]));
  const f = results.filter((r) => r[0] === 'FAIL').length;
  console.log('\n' + (results.length - f) + '/' + results.length + ' passed');
  process.exit(f ? 1 : 0);
})();
