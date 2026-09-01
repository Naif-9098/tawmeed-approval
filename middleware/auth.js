const { isManager, canApprove, canCreateOrders, canManageUsers, canManageProjects, canTransferFinancial, canAccessWorkItemsLibrary, roleLabel } = require('../permissions');

function requireLogin(req, res, next) {
  if (!req.session.user) {
    return res.redirect('/login');
  }
  next();
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.session.user) return res.redirect('/login');
    if (!roles.includes(req.session.user.role)) {
      return res.status(403).render('error', {
        title: 'غير مصرح',
        message: 'ليست لديك الصلاحية للوصول إلى هذه الصفحة.',
        user: req.session.user,
      });
    }
    next();
  };
}

// يتحقق من صلاحية معتمدة على منطق (Permission) وليس فقط قائمة أدوار ثابتة —
// مثال: requirePermission(isManager) أو requirePermission(canApprove).
function requirePermission(checkFn) {
  return (req, res, next) => {
    if (!req.session.user) return res.redirect('/login');
    if (!checkFn(req.session.user)) {
      return res.status(403).render('error', {
        title: 'غير مصرح',
        message: 'ليست لديك الصلاحية للوصول إلى هذه الصفحة.',
        user: req.session.user,
      });
    }
    next();
  };
}

// يجعل بيانات المستخدم وحسابات الصلاحيات الجاهزة متاحة تلقائيًا لكل
// القوالب (views) دون تمريرها يدويًا في كل مرة.
function injectUser(req, res, next) {
  const user = req.session.user || null;
  res.locals.currentUser = user;
  res.locals.perm = user ? {
    isManager: isManager(user),
    canApprove: canApprove(user),
    canCreateOrders: canCreateOrders(user),
    canManageUsers: canManageUsers(user),
    canManageProjects: canManageProjects(user),
    canTransferFinancial: canTransferFinancial(user),
    canAccessWorkItemsLibrary: canAccessWorkItemsLibrary(user),
    roleLabel: roleLabel(user.role),
  } : {};
  next();
}

module.exports = { requireLogin, requireRole, requirePermission, injectUser };
