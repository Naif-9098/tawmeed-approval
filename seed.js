require('dotenv').config();
const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');
const db = require('./db');

async function main() {
  console.log('⏳ إنشاء الجداول (schema.sql) ...');
  const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  await db.query(schema);
  console.log('✅ تم إنشاء الجداول.');

  const demoUsers = [
    { name: 'أحمد الموظف', email: 'employee@example.com', password: 'Employee@123', role: 'employee', job_title: 'منسق مشاريع' },
    { name: 'محمد المعتمد', email: 'approver@example.com', password: 'Approver@123', role: 'approver', job_title: 'مدير المشروع' },
    { name: 'مدير النظام', email: 'admin@example.com', password: 'Admin@123', role: 'admin', job_title: 'مدير النظام' },
  ];

  for (const u of demoUsers) {
    const exists = (await db.query('SELECT id FROM users WHERE email=$1', [u.email])).rows[0];
    if (exists) {
      console.log(`↷ المستخدم ${u.email} موجود مسبقًا — تم تخطيه.`);
      continue;
    }
    const hash = await bcrypt.hash(u.password, 10);
    await db.query(
      `INSERT INTO users (name, email, password_hash, role, job_title) VALUES ($1,$2,$3,$4,$5)`,
      [u.name, u.email, hash, u.role, u.job_title]
    );
    console.log(`✅ تم إنشاء المستخدم: ${u.email} — الدور: ${u.role}`);
  }

  console.log('\n===== بيانات الدخول التجريبية =====');
  demoUsers.forEach(u => console.log(`${u.role.padEnd(10)} | ${u.email.padEnd(24)} | ${u.password}`));
  console.log('====================================\n⚠️  غيّر كلمات المرور هذه فور أول استخدام حقيقي.\n');

  await db.pool.end();
}

main().catch(e => {
  console.error('❌ فشل التهيئة:', e);
  process.exit(1);
});
