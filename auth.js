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

// يجعل بيانات المستخدم متاحة تلقائيًا لكل القوالب (views) دون تمريرها يدويًا في كل مرة
function injectUser(req, res, next) {
  res.locals.currentUser = req.session.user || null;
  next();
}

module.exports = { requireLogin, requireRole, injectUser };
