// permissions.js — كل قرار صلاحية في النظام يمر من هنا.
// -----------------------------------------------------------------------------
// لم تعد الصلاحيات مربوطة بأسماء الأدوار. كل دالة تفحص صلاحية محددة من السجل
// (permission_registry.js) ضمن «الصلاحيات الفعلية» للمستخدم، والتي يحمّلها
// middleware/auth.js من قاعدة البيانات في كل طلب (القالب الوظيفي + الاستثناءات).
// أسماء الدوال بقيت كما هي حتى لا تتغيّر نقاط استخدامها في المسارات.
//
// الصلاحية تحدد «ماذا»، وإسناد المشاريع (projectAccess.js) يحدد «أين»،
// والملكية (created_by) تحدد «على بيانات من» — الثلاثة تعمل معاً.

const REG = require('./permission_registry');

// الصلاحيات الفعلية مرفقة بكائن المستخدم كخاصية غير قابلة للحفظ في الجلسة
function has(user, key) {
  return !!(user && user.perms && typeof user.perms.has === 'function' && user.perms.has(key));
}
const any = (user, keys) => keys.some((k) => has(user, k));

// ---------------- المشاريع ----------------
const seesAllProjects = (u) => has(u, 'PROJECT_VIEW_ALL');
const seesOpenProjects = (u) => has(u, 'PROJECT_VIEW_OPEN');
const canCreateProject = (u) => has(u, 'PROJECT_CREATE');
const canEditProject = (u) => has(u, 'PROJECT_EDIT');
const canArchiveProject = (u) => has(u, 'PROJECT_ARCHIVE');
const canAssignProjectUsers = (u) => has(u, 'PROJECT_ASSIGN_USERS');
// لإظهار أدوات إدارة المشروع في الواجهة: أي صلاحية إدارية على المشاريع
const canManageProjects = (u) => any(u, ['PROJECT_CREATE', 'PROJECT_EDIT', 'PROJECT_ARCHIVE', 'PROJECT_ASSIGN_USERS']);

// ---------------- أوامر التعميد ----------------
const canViewAllOrders = (u) => has(u, 'ORDER_VIEW_ALL');
const canViewProjectOrders = (u) => has(u, 'ORDER_VIEW_ALL') || has(u, 'ORDER_VIEW_PROJECT');
// داخل صفحة المشروع: هل يرى أوامره فقط؟
const ownOrdersOnly = (u) => !canViewProjectOrders(u);
const canListAllOrders = (u) => has(u, 'ORDER_LIST_ALL');
const canCreateOrders = (u) => has(u, 'ORDER_CREATE');
const canEditOwnOrders = (u) => has(u, 'ORDER_EDIT_OWN');
const canEditAllOrders = (u) => has(u, 'ORDER_EDIT_ALL');
const canMoveOrders = (u) => has(u, 'ORDER_MOVE');
const canAssignApprover = (u) => has(u, 'ORDER_ASSIGN_APPROVER');
function canRequestTransferFor(user, createdByUserId) {
  return has(user, 'ORDER_SEND_TO_ACCOUNTING_ALL') || (has(user, 'ORDER_SEND_TO_ACCOUNTING_OWN') && !!user && user.id === createdByUserId);
}

// ---------------- الاعتماد ----------------
const canApproveOrders = (u) => any(u, ['ORDER_APPROVE', 'ORDER_REJECT', 'ORDER_RETURN']);
const canApproveAnyOrder = (u) => has(u, 'ORDER_APPROVE_ANY');
// الاسم القديم: الدخول لقسم «طلبات الاعتماد»
const canApprove = canApproveOrders;

// ---------------- المستخلصات ----------------
const canViewAllCertificates = (u) => has(u, 'CERTIFICATE_VIEW_ALL');
const canCreateCertificates = (u) => has(u, 'CERTIFICATE_CREATE');
const canEditOwnCertificates = (u) => has(u, 'CERTIFICATE_EDIT_OWN');
const canEditAllCertificates = (u) => has(u, 'CERTIFICATE_EDIT_ALL');
const canReviewCertificates = (u) => any(u, ['CERTIFICATE_APPROVE', 'CERTIFICATE_REJECT', 'CERTIFICATE_RETURN']);
function canRequestCertTransferFor(user, createdByUserId) {
  return has(user, 'CERTIFICATE_SEND_TO_ACCOUNTING_ALL') || (has(user, 'CERTIFICATE_SEND_TO_ACCOUNTING_OWN') && !!user && user.id === createdByUserId);
}

// ---------------- المحاسبة ----------------
const canViewAccountingRequests = (u) => has(u, 'ACCOUNTING_VIEW');
const canConfirmPayment = (u) => has(u, 'ACCOUNTING_MARK_PAID');
const canTransferFinancial = canConfirmPayment;

// ---------------- مكتبة البنود ----------------
const canAccessWorkItemsLibrary = (u) => has(u, 'WORK_ITEMS_LIBRARY_VIEW');
const canAddWorkItem = (u) => has(u, 'WORK_ITEMS_ADD');
const canEditWorkItem = (u) => has(u, 'WORK_ITEMS_EDIT');
const canManageWorkItems = (u) => has(u, 'WORK_ITEMS_TOGGLE');

// ---------------- المستخدمون والإعدادات ----------------
const canManageUsers = (u) => has(u, 'USERS_MANAGE');
const canManagePermissions = (u) => has(u, 'PERMISSIONS_MANAGE');
const canManageSettings = (u) => has(u, 'SETTINGS_MANAGE');
const canViewAuditLog = (u) => has(u, 'AUDIT_LOG_VIEW');

// اسم القالب الوظيفي يأتي من قاعدة البيانات (user.roleName)؛ هذا احتياطي فقط
const ROLE_LABELS = Object.fromEntries(REG.SYSTEM_ROLES.map((r) => [r.code, r.name]));
function roleLabel(role, user) { return (user && user.roleName) || ROLE_LABELS[role] || role; }

module.exports = {
  has, ROLE_LABELS, roleLabel,
  seesAllProjects, seesOpenProjects, canCreateProject, canEditProject, canArchiveProject, canAssignProjectUsers, canManageProjects,
  canViewAllOrders, canViewProjectOrders, ownOrdersOnly, canListAllOrders, canCreateOrders, canEditOwnOrders, canEditAllOrders,
  canMoveOrders, canAssignApprover, canRequestTransferFor,
  canApprove, canApproveOrders, canApproveAnyOrder,
  canViewAllCertificates, canCreateCertificates, canEditOwnCertificates, canEditAllCertificates, canReviewCertificates, canRequestCertTransferFor,
  canViewAccountingRequests, canConfirmPayment, canTransferFinancial,
  canAccessWorkItemsLibrary, canAddWorkItem, canEditWorkItem, canManageWorkItems,
  canManageUsers, canManagePermissions, canManageSettings, canViewAuditLog,
};
