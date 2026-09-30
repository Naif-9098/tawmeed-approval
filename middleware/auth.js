const P = require('../permissions');
const engine = require('../permission_engine');
const db = require('../db');

function requireLogin(req, res, next) {
  if (!req.session.user) {
    return res.redirect('/login');
  }
  next();
}

function forbidden(req, res) {
  return res.status(403).render('error', {
    title: 'غير مصرح',
    message: 'ليست لديك الصلاحية للوصول إلى هذه الصفحة.',
    user: req.session.user,
  });
}

// يبقى للتوافق فقط — لا يستخدمه أي مسار بعد التحديث (الصلاحيات لم تعد مربوطة بأسماء الأدوار).
function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.session.user) return res.redirect('/login');
    if (!roles.includes(req.session.user.role)) return forbidden(req, res);
    next();
  };
}

// تحقق حقيقي في الخادم: requirePermission(دالة من permissions.js) — مثال: requirePermission(P.canConfirmPayment).
// أي طلب مباشر (رابط/API/أدوات المطوّر) بلا الصلاحية الفعلية يُرفض 403 قبل تنفيذ أي منطق.
function requirePermission(checkFn) {
  return (req, res, next) => {
    if (!req.session.user) return res.redirect('/login');
    if (!checkFn(req.session.user)) return forbidden(req, res);
    next();
  };
}

// يحمّل الصلاحيات الفعلية من قاعدة البيانات في **كل طلب** (القالب الوظيفي + الاستثناءات)،
// فأي تعديل على صلاحيات مستخدم أو قالبه يُطبَّق فوراً في الخادم دون إعادة تسجيل دخول.
// تُرفق بكائن المستخدم كخاصية غير قابلة للتعداد: لا تُحفظ في مخزن الجلسات أبداً.
async function injectUser(req, res, next) {
  try {
    const sess = req.session.user || null;
    if (sess) {
      const loaded = await engine.loadUserPermissions(db, sess.id);
      if (!loaded || !loaded.user.active) {
        // حساب محذوف أو معطّل: تنتهي جلسته فوراً بدل أن تبقى صالحة حتى الخروج.
        return req.session.destroy(() => res.redirect('/login'));
      }
      sess.role = loaded.user.role;
      sess.name = loaded.user.name;
      Object.defineProperty(sess, 'perms', { value: loaded.keys, enumerable: false, configurable: true, writable: true });
      Object.defineProperty(sess, 'roleName', { value: loaded.roleName, enumerable: false, configurable: true, writable: true });
    }
    res.locals.currentUser = sess;
    res.locals.currentPath = req.originalUrl || req.path || '';
    const u = sess;
    res.locals.perm = u ? {
      has: (k) => P.has(u, k),
      canApprove: P.canApproveOrders(u),
      canCreateOrders: P.canCreateOrders(u),
      canManageProjects: P.canManageProjects(u),
      canCreateProject: P.canCreateProject(u),
      canListAllOrders: P.canListAllOrders(u),
      canManageUsers: P.canManageUsers(u),
      canManagePermissions: P.canManagePermissions(u),
      canManageSettings: P.canManageSettings(u),
      canViewAuditLog: P.canViewAuditLog(u),
      canMoveOrders: P.canMoveOrders(u),
      canAssignApprover: P.canAssignApprover(u),
      canAccessWorkItemsLibrary: P.canAccessWorkItemsLibrary(u),
      canViewAccountingRequests: P.canViewAccountingRequests(u),
      canTransferFinancial: P.canConfirmPayment(u),
      roleLabel: P.roleLabel(u.role, u),
      // توافق مع القوالب القديمة: «أدوات مدير النظام» في صفحة الأمر = نقل الأمر أو تعيين المعتمد
      isManager: P.canMoveOrders(u) || P.canAssignApprover(u),
    } : {};
    next();
  } catch (e) {
    next(e);
  }
}

module.exports = { requireLogin, requireRole, requirePermission, injectUser };
