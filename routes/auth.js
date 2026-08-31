const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const db = require('../db');
const { logAction } = require('../audit');

router.get('/login', (req, res) => {
  if (req.session.user) return res.redirect('/orders');
  res.render('login', { error: null });
});

router.post('/login', async (req, res) => {
  const { email, password } = req.body;
  try {
    const result = await db.query('SELECT * FROM users WHERE email = $1 AND active = true', [email]);
    const user = result.rows[0];
    if (!user) {
      return res.render('login', { error: 'البريد الإلكتروني أو كلمة المرور غير صحيحة.' });
    }
    const ok = await bcrypt.compare(password, user.password_hash);
    if (!ok) {
      return res.render('login', { error: 'البريد الإلكتروني أو كلمة المرور غير صحيحة.' });
    }
    req.session.user = {
      id: user.id, name: user.name, email: user.email,
      role: user.role, jobTitle: user.job_title, can_approve: user.can_approve,
    };
    await db.query('UPDATE users SET last_login_at = now() WHERE id = $1', [user.id]);
    await logAction({ action: 'تسجيل دخول', actorId: user.id, actorName: user.name });
    res.redirect('/orders');
  } catch (e) {
    console.error(e);
    res.render('login', { error: 'تعذر الاتصال بقاعدة البيانات. حاول لاحقًا.' });
  }
});

router.post('/logout', (req, res) => {
  const user = req.session.user;
  req.session.destroy(() => {
    res.redirect('/login');
  });
  if (user) logAction({ action: 'تسجيل خروج', actorId: user.id, actorName: user.name }).catch(() => {});
});

module.exports = router;
