// وحدة صلاحيات مركزية للأدوار الجديدة.
// الأدوار القديمة (employee, approver, admin) تحتفظ بسلوكها الأصلي
// في كل مكان في النظام؛ هذه الوحدة تضيف فقط منطق الأدوار الأربعة الجديدة.

const ROLE_LABELS = {
  employee: 'موظف',
  approver: 'معتمد',
  admin: 'مدير النظام',
  projects_manager: 'مدير المشاريع',
  site_officer: 'مسؤول الموقع',
  technical_office: 'المكتب الفني',
  accountant: 'المحاسب',
};

// PROJECTS_MANAGER لديه وصول كامل، ونعامل admin القديم كمكافئ له
// (حتى لا تفقد حسابات مدير النظام الحالية أي صلاحية أثناء الترحيل).
function isManager(user) {
  return user.role === 'admin' || user.role === 'projects_manager';
}

// من يرى كل المشاريع دون قيد وصول لكل واحد منها؟
function seesAllProjects(user) {
  return isManager(user) || user.role === 'technical_office' || user.role === 'accountant';
}

// من يجب أن يرى أوامره الخاصة فقط (بدون أي استثناء)؟
function ownOrdersOnly(user) {
  return user.role === 'site_officer' || user.role === 'employee';
}

function canCreateOrders(user) {
  return user.role !== 'accountant';
}

function canManageUsers(user) {
  return isManager(user);
}

function canManageProjects(user) {
  return isManager(user);
}

// صلاحية الاعتماد Permission مستقلة عن الدور Role.
function canApprove(user) {
  return isManager(user) || !!user.can_approve;
}

function canTransferFinancial(user) {
  return user.role === 'accountant';
}

function roleLabel(role) {
  return ROLE_LABELS[role] || role;
}

module.exports = {
  ROLE_LABELS, isManager, seesAllProjects, ownOrdersOnly,
  canCreateOrders, canManageUsers, canManageProjects, canApprove,
  canTransferFinancial, roleLabel,
};
