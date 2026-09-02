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

// من يطلب "تحويل للمحاسبة" لمستند بعينه؟ منشئ المستند نفسه (Ownership)، أو مدير المشاريع
// (وصول كامل كالمعتاد). المحاسب مستثنى دائمًا — فهو الجهة المستقبلة للطلب وليس المرسلة.
function canRequestTransferFor(user, createdByUserId) {
  return isManager(user) || user.id === createdByUserId;
}

// من يؤكد "تم الصرف" فعليًا؟ المحاسب فقط.
function canConfirmPayment(user) {
  return user.role === 'accountant';
}

// من يرى صفحة "طلبات الصرف" الإدارية؟ المحاسب (يستقبل الطلبات) ومدير المشاريع (إشراف).
function canViewAccountingRequests(user) {
  return user.role === 'accountant' || isManager(user);
}

function canCreateCertificates(user) {
  return user.role !== 'accountant';
}

function canManageWorkItems(user) {
  return isManager(user);
}

function canAddWorkItem(user) {
  return isManager(user) || user.role === 'technical_office';
}

// تعديل وصف/وحدة بند موجود (تصحيح أخطاء إملائية مثلًا) — نفس صلاحية الإضافة حاليًا،
// لكنها دالة منفصلة عمدًا حتى يمكن توسيعها أو تضييقها لاحقًا دون المساس بالإضافة.
function canEditWorkItem(user) {
  return isManager(user) || user.role === 'technical_office';
}

// من يرى صفحة "مكتبة بنود الأعمال" الكاملة؟ (تفعيل/تعطيل يبقى حصرًا لمدير المشاريع داخل الصفحة نفسها)
function canAccessWorkItemsLibrary(user) {
  return isManager(user) || user.role === 'technical_office';
}

function roleLabel(role) {
  return ROLE_LABELS[role] || role;
}

module.exports = {
  ROLE_LABELS, isManager, seesAllProjects, ownOrdersOnly,
  canCreateOrders, canManageUsers, canManageProjects, canApprove,
  canTransferFinancial, canRequestTransferFor, canConfirmPayment, canViewAccountingRequests,
  canCreateCertificates, canManageWorkItems, canAddWorkItem,
  canEditWorkItem, canAccessWorkItemsLibrary, roleLabel,
};
