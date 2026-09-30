// permission_equivalence_test.js — يثبت أن صلاحيات كل مستخدم بعد الترحيل مطابقة تماماً لما قبله.
// يستخرج دوال القرار الفعلية من ملفات المسارات **الأصلية** (قبل التحديث) و**الجديدة**، ويشغّل كلاً
// منها مع permissions.js الخاص بها، ثم يقارن كل قرار في كل تركيبة ممكنة.
// التشغيل: node permission_equivalence_test.js <مجلد النسخة الأصلية>
const fs = require('fs'), path = require('path'), Module = require('module');
const ORIG = path.resolve(process.argv[2] || '../tw_original');
const NEW = __dirname;
const REG = require('./permission_registry');
const engine = require('./permission_engine');

// ---- قاعدة بيانات وهمية لـ projectAccess (مشاريع + قوائم وصول) ----
const DB = { projects: [1, 2, 3], access: [{ project_id: 2, user_id: 10 }, { project_id: 3, user_id: 99 }] }; // 1 مفتوح، 2 مسند لـ10، 3 مقيّد لغيره
const fakeDb = { async query(sql, p) {
  if (/FROM project_access WHERE user_id/.test(sql)) return { rows: DB.access.filter((a) => a.user_id === p[0]) };
  if (/NOT EXISTS \(SELECT 1 FROM project_access pa WHERE pa.project_id = p.id\)/.test(sql)) return { rows: DB.projects.filter((id) => !DB.access.some((a) => a.project_id === id)).map((id) => ({ id })) };
  if (/project_id = \$1 AND user_id = \$2/.test(sql)) return { rows: DB.access.filter((a) => a.project_id === p[0] && a.user_id === p[1]) };
  if (/project_id = \$1 LIMIT 1/.test(sql)) return { rows: DB.access.filter((a) => a.project_id === p[0]).slice(0, 1) };
  throw new Error('fakeDb: ' + sql.slice(0, 60));
} };
function loadFrom(root, rel) {
  const file = path.join(root, rel);
  const origLoad = Module._load;
  Module._load = function (req, parent, ...r) { if ((req === './db' || req === '../db') && parent && parent.filename.startsWith(root)) return fakeDb; return origLoad.call(this, req, parent, ...r); };
  delete require.cache[require.resolve(file)];
  try { return require(file); } finally { Module._load = origLoad; }
}
// استخراج دالة من ملف مسار بالاسم (نفس الكود المنشور حرفياً)
function extractFn(src, name) {
  const i = src.indexOf('function ' + name + '(');
  if (i < 0) throw new Error('missing ' + name);
  let j = src.indexOf('{', i), depth = 0, k = j;
  for (; k < src.length; k++) { if (src[k] === '{') depth++; else if (src[k] === '}') { depth--; if (!depth) break; } }
  return src.slice(i, k + 1);
}
function buildRouteFns(root, P) {
  const o = fs.readFileSync(path.join(root, 'routes/orders.js'), 'utf8');
  const c = fs.readFileSync(path.join(root, 'routes/certificates.js'), 'utf8');
  const names = Object.keys(P).filter((k) => typeof P[k] === 'function');
  const body = ['canViewOrder', 'canEdit', 'canSubmit'].map((n) => extractFn(o, n)).join('\n') + '\n' + ['canViewOrderForCert', 'canEditCert'].map((n) => extractFn(c, n)).join('\n');
  // eslint-disable-next-line no-new-func
  return new Function(...names, body + '\nreturn { canViewOrder, canEdit, canSubmit, canViewOrderForCert, canEditCert };')(...names.map((n) => P[n]));
}

const OLD_P = loadFrom(ORIG, 'permissions.js');
const NEW_P = loadFrom(NEW, 'permissions.js');
const OLD_PA = loadFrom(ORIG, 'projectAccess.js');
const NEW_PA = loadFrom(NEW, 'projectAccess.js');
const OLD_R = buildRouteFns(ORIG, OLD_P);
const NEW_R = buildRouteFns(NEW, NEW_P);

// حُرّاس المسارات: الحارس القديم ← الحارس الجديد (نفس المسار)
const ov = OLD_P, nv = NEW_P;
const GUARDS = [
  ['/orders/new', ov.canCreateOrders, nv.canCreateOrders],
  ['/orders list: كل الأوامر في «أوامري»', ov.isManager, nv.canListAllOrders],
  ['/orders/:id/move', ov.isManager, nv.canMoveOrders],
  ['/orders/:id/assign-approver', ov.isManager, nv.canAssignApprover],
  ['/orders/:id/confirm-payment', ov.canConfirmPayment, nv.canConfirmPayment],
  ['/approvals (دخول القسم)', ov.canApprove, nv.canApprove],
  ['/approvals/:id/approve', ov.canApprove, (u) => nv.has(u, 'ORDER_APPROVE')],
  ['/approvals/:id/reject', ov.canApprove, (u) => nv.has(u, 'ORDER_REJECT')],
  ['/approvals/:id/return', ov.canApprove, (u) => nv.has(u, 'ORDER_RETURN')],
  ['/approvals: تجاوز الإسناد والمشروع', ov.isManager, nv.canApproveAnyOrder],
  ['/certificates/new', ov.canCreateCertificates, nv.canCreateCertificates],
  ['/certificates/:id/approve', ov.canApprove, (u) => nv.has(u, 'CERTIFICATE_APPROVE')],
  ['/certificates/:id/reject', ov.canApprove, (u) => nv.has(u, 'CERTIFICATE_REJECT')],
  ['/certificates/:id/return', ov.canApprove, (u) => nv.has(u, 'CERTIFICATE_RETURN')],
  ['/certificates/:id/confirm-payment', ov.canConfirmPayment, nv.canConfirmPayment],
  ['/accounting', ov.canViewAccountingRequests, nv.canViewAccountingRequests],
  ['/projects/new', ov.canManageProjects, nv.canCreateProject],
  ['/projects/:id/edit', ov.canManageProjects, nv.canEditProject],
  ['/projects/:id/archive|activate', ov.canManageProjects, nv.canArchiveProject],
  ['/projects/:id/access*', ov.canManageProjects, nv.canAssignProjectUsers],
  ['/projects/:id/orders/new (غير المحاسب)', (u) => u.role !== 'accountant', nv.canCreateOrders],
  ['/projects/:id: أوامره فقط', ov.ownOrdersOnly, nv.ownOrdersOnly],
  ['/work-items (الصفحة)', ov.canAccessWorkItemsLibrary, nv.canAccessWorkItemsLibrary],
  ['/api/work-items/new', ov.canAddWorkItem, nv.canAddWorkItem],
  ['/work-items/:id/edit', ov.canEditWorkItem, nv.canEditWorkItem],
  ['/work-items/:id/toggle', ov.canManageWorkItems, nv.canManageWorkItems],
  ['/admin/users*', ov.canManageUsers, nv.canManageUsers],
  ['/admin/users/:id/role', ov.canManageUsers, nv.canManagePermissions],
  ['/admin/users/:id/can-approve/toggle', ov.canManageUsers, nv.canManagePermissions],
  ['/admin/orders', ov.canManageUsers, nv.canListAllOrders],
  ['/admin/audit-log', ov.canManageUsers, nv.canViewAuditLog],
  ['/admin/settings*', ov.canManageUsers, nv.canManageSettings],
  ['قسم الصلاحيات الجديد (كان: /admin)', ov.canManageUsers, nv.canManagePermissions],
];

const ROLES = REG.SYSTEM_ROLES.map((r) => r.code);
let checks = 0; const fails = [];
function eq(label, a, b) { checks++; if (a !== b) fails.push(label + ' → قديم=' + a + ' جديد=' + b); }

(async () => {
  for (const role of ROLES) for (const flag of [false, true]) {
    const tag = role + (flag ? '+اعتماد' : '');
    const oldU = { id: 10, role, can_approve: flag };
    const newU = { id: 10, role, can_approve: flag };
    Object.defineProperty(newU, 'perms', { value: new Set(REG.legacyKeys(role, flag)), enumerable: false });
    for (const [name, o, n] of GUARDS) eq(tag + ' | ' + name, !!o(oldU), !!n(newU));
    // تحويل للمحاسبة: أوامره / أوامر غيره (أوامر + مستخلصات)
    for (const owner of [10, 20]) {
      eq(tag + ' | تحويل أمر للمحاسبة owner=' + owner, !!ov.canRequestTransferFor(oldU, owner), !!nv.canRequestTransferFor(newU, owner));
      eq(tag + ' | تحويل مستخلص للمحاسبة owner=' + owner, !!ov.canRequestTransferFor(oldU, owner), !!nv.canRequestCertTransferFor(newU, owner));
    }
    // قرارات المسارات الفعلية على أوامر ومستخلصات بكل الحالات
    for (const created_by of [10, 20]) for (const status of ['draft', 'returned_for_edit', 'pending_approval', 'approved']) for (const assigned_approver_id of [null, 10, 30]) {
      const order = { created_by, status, assigned_approver_id }; const s = tag + ' | owner=' + created_by + ' ' + status + ' approver=' + assigned_approver_id;
      eq(s + ' canViewOrder', !!OLD_R.canViewOrder(oldU, order), !!NEW_R.canViewOrder(newU, order));
      eq(s + ' canEdit', !!OLD_R.canEdit(order, oldU), !!NEW_R.canEdit(order, newU));
      eq(s + ' canSubmit', !!OLD_R.canSubmit(order, oldU), !!NEW_R.canSubmit(order, newU));
      eq(s + ' canViewOrderForCert', !!OLD_R.canViewOrderForCert(oldU, order), !!NEW_R.canViewOrderForCert(newU, order));
      const cstatus = status === 'pending_approval' ? 'pending_review' : status;
      eq(s + ' canEditCert', !!OLD_R.canEditCert({ created_by, status: cstatus }, oldU), !!NEW_R.canEditCert({ created_by, status: cstatus }, newU));
      // زر «إنشاء مستخلص» في صفحة الأمر
      eq(s + ' canCreateCert', !!(OLD_R.canViewOrder(oldU, order) && role !== 'accountant'), !!(NEW_R.canViewOrder(newU, order) && nv.canCreateCertificates(newU)));
    }
    // الوصول للمشاريع (أين): مفتوح / مسند / مقيّد لغيره / أمر بلا مشروع
    const a = await OLD_PA.getAccessibleProjectIds(oldU), b = await NEW_PA.getAccessibleProjectIds(newU);
    eq(tag + ' | المشاريع المتاحة', JSON.stringify(a && [...a].sort()), JSON.stringify(b && [...b].sort()));
    for (const pid of [null, 1, 2, 3]) eq(tag + ' | canAccessProject ' + pid, await OLD_PA.canAccessProject(oldU, pid), await NEW_PA.canAccessProject(newU, pid));
  }

  // الترحيل: القالب + الاستثناءات المحسوبة = legacyKeys لكل مستخدم فعلي (بما فيهم من تغيّر علم اعتماده)
  const users = []; let uid = 0;
  for (const role of ROLES) for (const flag of [false, true]) users.push({ id: ++uid, name: 'u' + uid, role, can_approve: flag, active: true });
  const roleKeys = {}; REG.SYSTEM_ROLES.forEach((r) => (roleKeys[r.code] = REG.legacyKeys(r.code, r.code === 'approver')));
  const overrides = {};
  const repo = {
    async listUsers() { return users; }, async getUser(id) { return users.find((u) => u.id === id) || null; },
    async getRoleKeys(code) { return roleKeys[code] || []; },
    async getOverrides(id) { const o = overrides[id] || { allow: [], deny: [] }; return o; },
    async replaceOverrides(id, allow, deny) { overrides[id] = { allow, deny }; },
  };
  await engine.seedUsers(repo);
  for (const u of users) {
    const eff = engine.computeEffective(roleKeys[u.role], overrides[u.id].allow, overrides[u.id].deny);
    eq('ترحيل ' + u.role + (u.can_approve ? '+اعتماد' : ''), JSON.stringify([...eff].sort()), JSON.stringify(REG.legacyKeys(u.role, u.can_approve).sort()));
  }
  const withOverrides = users.filter((u) => overrides[u.id].allow.length || overrides[u.id].deny.length).map((u) => u.role + (u.can_approve ? '+اعتماد' : '') + ' ← ' + (overrides[u.id].allow.length ? 'سماح: ' + overrides[u.id].allow.join(',') : '') + (overrides[u.id].deny.length ? 'منع: ' + overrides[u.id].deny.join(',') : ''));

  console.log('التحققات: ' + checks + ' | الاختلافات: ' + fails.length);
  fails.slice(0, 40).forEach((f) => console.log('  ✗ ' + f));
  console.log('\nمن سيحصل على استثناءات بعد الترحيل (فرق عن قالب دوره):');
  withOverrides.forEach((x) => console.log('  • ' + x));
  process.exit(fails.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
