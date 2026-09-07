require('dotenv').config();
const express = require('express');
const session = require('express-session');
const pgSession = require('connect-pg-simple')(session);
const path = require('path');
const db = require('./db');
const { injectUser } = require('./middleware/auth');

const app = express();

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.set('trust proxy', 1);

app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.use(session({
  store: new pgSession({ pool: db.pool, createTableIfMissing: true }),
  secret: process.env.SESSION_SECRET || 'dev-secret-change-me',
  resave: false,
  saveUninitialized: false,
  cookie: {
    maxAge: 1000 * 60 * 60 * 8, // 8 ساعات
    secure: process.env.NODE_ENV === 'production' && process.env.DISABLE_SECURE_COOKIE !== 'true',
  },
}));

app.use(injectUser);

// المسارات
app.use('/', require('./routes/auth'));
app.use('/projects', require('./routes/projects'));
app.use('/orders', require('./routes/orders'));
app.use('/approvals', require('./routes/approvals'));
app.use('/admin', require('./routes/admin'));
app.use('/verify', require('./routes/verify'));
app.use('/', require('./routes/certificates'));
app.use('/', require('./routes/workItems'));
app.use('/', require('./routes/accounting'));

app.get('/', (req, res) => {
  if (!req.session.user) return res.redirect('/login');
  return res.redirect('/orders');
});

// صفحة 404
app.use((req, res) => {
  res.status(404).render('error', {
    title: 'الصفحة غير موجودة',
    message: 'الرابط الذي طلبته غير موجود.',
    user: req.session.user || null,
  });
});

// معالج أخطاء عام
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).render('error', {
    title: 'حدث خطأ',
    message: 'حدث خطأ غير متوقع في النظام. حاول مرة أخرى.',
    user: req.session.user || null,
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ نظام أوامر التعميد يعمل على المنفذ ${PORT}`);
});
