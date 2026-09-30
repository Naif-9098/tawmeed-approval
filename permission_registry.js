// permission_registry.js — سجلّ الصلاحيات المركزي لنظام أوامر التعميد
// -----------------------------------------------------------------------------
// كل قرار صلاحية كان مكتوباً سابقاً كشرط على الدور (isManager / role === '...')
// أصبح هنا صلاحية مستقلة باسم ثابت، واسم عربي واضح للإداري، ووحدة، وعلامة «حساسة».
//
// legacy(r, a): تعيد true إن كان الدور r (مع علم الاعتماد القديم a = can_approve)
// يملك هذه القدرة في النظام قبل هذا التحديث — منقولة حرفياً من permissions.js القديم.
// تُستخدم فقط لبناء القوالب الافتراضية وللترحيل، فيبقى سلوك كل مستخدم كما هو تماماً.
//
// إضافة وحدة مستقبلية (العقود، أوامر التغيير، المشتريات...) = إضافة عناصر هنا فقط؛
// صفحة الصلاحيات والمحرّك يقرآن السجل تلقائياً. لا يوجد هنا أي اسم شخص.

const MGR = (r) => r === 'admin' || r === 'projects_manager';
const SEES_ALL = (r) => MGR(r) || r === 'technical_office' || r === 'accountant';
const OWN_ONLY = (r) => r === 'site_officer' || r === 'employee';
const APPROVE = (r, a) => MGR(r) || !!a;

const MODULES = [
  { id: 'projects', label: 'المشاريع' },
  { id: 'orders', label: 'أوامر التعميد' },
  { id: 'approvals', label: 'الاعتماد' },
  { id: 'certificates', label: 'المستخلصات' },
  { id: 'accounting', label: 'المحاسبة والصرف' },
  { id: 'workitems', label: 'مكتبة بنود الأعمال' },
  { id: 'admin', label: 'المستخدمون والإعدادات' },
];

// scope: صلاحيات تُعرض معاً كقائمة نطاق واحدة في الواجهة (مثل «مشاهدة الأوامر: أوامره / المشروع / الكل»)
const PERMISSIONS = [
  // ---------------- المشاريع ----------------
  { key: 'PROJECT_VIEW_ALL', module: 'projects', label: 'مشاهدة جميع المشاريع', hint: 'بدونها يرى المستخدم المشاريع المسندة إليه فقط', legacy: (r) => SEES_ALL(r) },
  { key: 'PROJECT_VIEW_OPEN', module: 'projects', label: 'مشاهدة المشاريع المفتوحة (بلا قائمة وصول)', hint: 'سلوك الأدوار القديمة (موظف / معتمد)', legacy: (r) => !SEES_ALL(r) && r !== 'site_officer' },
  { key: 'PROJECT_CREATE', module: 'projects', label: 'إنشاء مشروع', legacy: MGR },
  { key: 'PROJECT_EDIT', module: 'projects', label: 'تعديل بيانات المشروع', legacy: MGR },
  { key: 'PROJECT_ARCHIVE', module: 'projects', label: 'أرشفة المشروع وإعادة تفعيله', legacy: MGR },
  { key: 'PROJECT_ASSIGN_USERS', module: 'projects', label: 'إدارة صلاحيات الوصول للمشروع وإسناد المستخدمين', legacy: MGR },

  // ---------------- أوامر التعميد ----------------
  { key: 'ORDER_VIEW_ALL', module: 'orders', label: 'مشاهدة جميع أوامر التعميد', scope: 'order_view', legacy: (r) => SEES_ALL(r) },
  { key: 'ORDER_VIEW_PROJECT', module: 'orders', label: 'مشاهدة أوامر المشاريع المتاحة له', scope: 'order_view', legacy: (r) => !OWN_ONLY(r) }, // «الكل» يتضمن «المشروع» (نفس السلوك: الفحص = الكل أو المشروع)
  { key: 'ORDER_LIST_ALL', module: 'orders', label: 'قائمة «كل الأوامر» من جميع المشاريع', legacy: MGR },
  { key: 'ORDER_CREATE', module: 'orders', label: 'إنشاء أمر تعميد', legacy: (r) => r !== 'accountant' },
  { key: 'ORDER_EDIT_OWN', module: 'orders', label: 'تعديل أوامره وإرسالها للاعتماد', scope: 'order_edit', legacy: () => true },
  { key: 'ORDER_EDIT_ALL', module: 'orders', label: 'تعديل أي أمر قابل للتعديل وإرساله للاعتماد', scope: 'order_edit', legacy: (r) => MGR(r) || r === 'technical_office' },
  { key: 'ORDER_MOVE', module: 'orders', label: 'نقل أمر إلى مشروع آخر', legacy: MGR },
  { key: 'ORDER_ASSIGN_APPROVER', module: 'orders', label: 'تعيين / تغيير المعتمد المسؤول عن الأمر', legacy: MGR },
  { key: 'ORDER_SEND_TO_ACCOUNTING_OWN', module: 'orders', label: 'تحويل أوامره المعتمدة للمحاسبة', scope: 'order_acc', legacy: () => true },
  { key: 'ORDER_SEND_TO_ACCOUNTING_ALL', module: 'orders', label: 'تحويل أي أمر معتمد للمحاسبة', scope: 'order_acc', legacy: MGR },

  // ---------------- الاعتماد ----------------
  { key: 'ORDER_APPROVE', module: 'approvals', label: 'اعتماد أوامر التعميد', danger: true, legacy: APPROVE },
  { key: 'ORDER_REJECT', module: 'approvals', label: 'رفض أوامر التعميد', legacy: APPROVE },
  { key: 'ORDER_RETURN', module: 'approvals', label: 'إعادة أوامر التعميد للتعديل', legacy: APPROVE },
  { key: 'ORDER_APPROVE_ANY', module: 'approvals', label: 'مراجعة واعتماد أي أمر بغض النظر عن المعتمد المسند والمشروع', danger: true, legacy: MGR },
  { key: 'CERTIFICATE_APPROVE', module: 'approvals', label: 'اعتماد المستخلصات', danger: true, legacy: APPROVE },
  { key: 'CERTIFICATE_REJECT', module: 'approvals', label: 'رفض المستخلصات', legacy: APPROVE },
  { key: 'CERTIFICATE_RETURN', module: 'approvals', label: 'إعادة المستخلصات للتعديل', legacy: APPROVE },

  // ---------------- المستخلصات ----------------
  { key: 'CERTIFICATE_VIEW_ALL', module: 'certificates', label: 'مشاهدة جميع المستخلصات', hint: 'بدونها يرى مستخلصات أوامره فقط', legacy: (r) => SEES_ALL(r) },
  { key: 'CERTIFICATE_CREATE', module: 'certificates', label: 'إنشاء مستخلص', legacy: (r) => r !== 'accountant' },
  { key: 'CERTIFICATE_EDIT_OWN', module: 'certificates', label: 'تعديل مستخلصاته وإرسالها للمراجعة', scope: 'cert_edit', legacy: () => true },
  { key: 'CERTIFICATE_EDIT_ALL', module: 'certificates', label: 'تعديل أي مستخلص قابل للتعديل', scope: 'cert_edit', legacy: (r) => MGR(r) || r === 'technical_office' },
  { key: 'CERTIFICATE_SEND_TO_ACCOUNTING_OWN', module: 'certificates', label: 'تحويل مستخلصاته المعتمدة للمحاسبة', scope: 'cert_acc', legacy: () => true },
  { key: 'CERTIFICATE_SEND_TO_ACCOUNTING_ALL', module: 'certificates', label: 'تحويل أي مستخلص معتمد للمحاسبة', scope: 'cert_acc', legacy: MGR },

  // ---------------- المحاسبة ----------------
  { key: 'ACCOUNTING_VIEW', module: 'accounting', label: 'صفحة طلبات الصرف', legacy: (r) => r === 'accountant' || MGR(r) },
  { key: 'ACCOUNTING_MARK_PAID', module: 'accounting', label: 'تسجيل «تم الصرف»', danger: true, legacy: (r) => r === 'accountant' },

  // ---------------- مكتبة بنود الأعمال ----------------
  { key: 'WORK_ITEMS_LIBRARY_VIEW', module: 'workitems', label: 'فتح صفحة مكتبة بنود الأعمال', legacy: (r) => MGR(r) || r === 'technical_office' },
  { key: 'WORK_ITEMS_ADD', module: 'workitems', label: 'إضافة بند جديد للمكتبة', legacy: (r) => MGR(r) || r === 'technical_office' },
  { key: 'WORK_ITEMS_EDIT', module: 'workitems', label: 'تعديل وصف / وحدة بند', legacy: (r) => MGR(r) || r === 'technical_office' },
  { key: 'WORK_ITEMS_TOGGLE', module: 'workitems', label: 'تفعيل / تعطيل بند', legacy: MGR },

  // ---------------- المستخدمون والإعدادات (حساسة) ----------------
  { key: 'USERS_MANAGE', module: 'admin', label: 'إدارة المستخدمين (إنشاء، تفعيل/تعطيل، إسناد مشاريع)', danger: true, legacy: MGR },
  { key: 'PERMISSIONS_MANAGE', module: 'admin', label: 'إدارة الصلاحيات والقوالب الوظيفية', danger: true, legacy: MGR },
  { key: 'SETTINGS_MANAGE', module: 'admin', label: 'إعدادات الاعتماد والضريبة', danger: true, legacy: MGR },
  { key: 'AUDIT_LOG_VIEW', module: 'admin', label: 'مشاهدة سجل العمليات', legacy: MGR },
];

// قوائم النطاق: تُعرض كقائمة منسدلة واحدة؛ كل قيمة = مجموعة المفاتيح المفعّلة
const SCOPES = {
  order_view: { label: 'مشاهدة أوامر التعميد', options: [
    { value: 'OWN', label: 'أوامره فقط', keys: [] },
    { value: 'PROJECT', label: 'أوامر مشاريعه', keys: ['ORDER_VIEW_PROJECT'] },
    { value: 'ALL', label: 'جميع الأوامر', keys: ['ORDER_VIEW_ALL', 'ORDER_VIEW_PROJECT'] } ] },
  order_edit: { label: 'تعديل أوامر التعميد', options: [
    { value: 'NONE', label: 'لا شيء', keys: [] },
    { value: 'OWN', label: 'أوامره فقط', keys: ['ORDER_EDIT_OWN'] },
    { value: 'ALL', label: 'أي أمر', keys: ['ORDER_EDIT_OWN', 'ORDER_EDIT_ALL'] } ] },
  order_acc: { label: 'تحويل الأوامر للمحاسبة', options: [
    { value: 'NONE', label: 'لا شيء', keys: [] },
    { value: 'OWN', label: 'أوامره فقط', keys: ['ORDER_SEND_TO_ACCOUNTING_OWN'] },
    { value: 'ALL', label: 'أي أمر', keys: ['ORDER_SEND_TO_ACCOUNTING_OWN', 'ORDER_SEND_TO_ACCOUNTING_ALL'] } ] },
  cert_edit: { label: 'تعديل المستخلصات', options: [
    { value: 'NONE', label: 'لا شيء', keys: [] },
    { value: 'OWN', label: 'مستخلصاته فقط', keys: ['CERTIFICATE_EDIT_OWN'] },
    { value: 'ALL', label: 'أي مستخلص', keys: ['CERTIFICATE_EDIT_OWN', 'CERTIFICATE_EDIT_ALL'] } ] },
  cert_acc: { label: 'تحويل المستخلصات للمحاسبة', options: [
    { value: 'NONE', label: 'لا شيء', keys: [] },
    { value: 'OWN', label: 'مستخلصاته فقط', keys: ['CERTIFICATE_SEND_TO_ACCOUNTING_OWN'] },
    { value: 'ALL', label: 'أي مستخلص', keys: ['CERTIFICATE_SEND_TO_ACCOUNTING_OWN', 'CERTIFICATE_SEND_TO_ACCOUNTING_ALL'] } ] },
};

// القوالب الوظيفية الافتراضية = الأدوار الحالية نفسها (نفس الرموز المخزّنة في users.role)
const SYSTEM_ROLES = [
  { code: 'projects_manager', name: 'مدير المشاريع' },
  { code: 'site_officer', name: 'مسؤول الموقع' },
  { code: 'technical_office', name: 'المكتب الفني' },
  { code: 'accountant', name: 'المحاسب' },
  { code: 'admin', name: 'مدير النظام (قديم)' },
  { code: 'approver', name: 'معتمد (قديم)' },
  { code: 'employee', name: 'موظف (قديم)' },
];

const KEYS = PERMISSIONS.map((p) => p.key);
const BY_KEY = Object.fromEntries(PERMISSIONS.map((p) => [p.key, p]));
const MANAGE_KEY = 'PERMISSIONS_MANAGE';

(function selfCheck() {
  const seen = new Set(), mods = new Set(MODULES.map((m) => m.id));
  for (const p of PERMISSIONS) {
    if (seen.has(p.key)) throw new Error('permission_registry: duplicate ' + p.key);
    seen.add(p.key);
    if (!mods.has(p.module)) throw new Error('permission_registry: bad module ' + p.key);
    if (typeof p.legacy !== 'function') throw new Error('permission_registry: missing legacy ' + p.key);
  }
  for (const s of Object.values(SCOPES)) for (const o of s.options) for (const k of o.keys) if (!seen.has(k)) throw new Error('scope key ' + k);
  // كل دور قديم يجب أن يطابق خياراً واحداً من كل قائمة نطاق تماماً — وإلا ستعرض الواجهة نطاقاً خاطئاً
  const ROLES_ = ['admin','projects_manager','site_officer','technical_office','accountant','employee','approver'];
  for (const [sid, sc] of Object.entries(SCOPES)) for (const r of ROLES_) for (const a of [false, true]) {
    const all = [...new Set(sc.options.flatMap((o) => o.keys))];
    const held = all.filter((k) => PERMISSIONS.find((p) => p.key === k).legacy(r, a)).sort().join();
    if (!sc.options.some((o) => [...o.keys].sort().join() === held)) throw new Error('scope ' + sid + ' inconsistent for role ' + r);
  }
})();

function isKnown(k) { return Object.prototype.hasOwnProperty.call(BY_KEY, k); }

// صلاحيات دور قديم كما كانت تماماً قبل التحديث (مع علم الاعتماد القديم)
function legacyKeys(role, canApprove) {
  return KEYS.filter((k) => BY_KEY[k].legacy(role, canApprove));
}

module.exports = { MODULES, PERMISSIONS, SCOPES, SYSTEM_ROLES, KEYS, BY_KEY, MANAGE_KEY, isKnown, legacyKeys };
