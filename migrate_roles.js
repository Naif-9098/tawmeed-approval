require('dotenv').config();
const fs = require('fs');
const path = require('path');
const db = require('./db');

async function main() {
  console.log('⏳ تطبيق ترحيل نظام الأدوار الجديد (migration_roles.sql) ...');
  const sql = fs.readFileSync(path.join(__dirname, 'migration_roles.sql'), 'utf8');
  await db.query(sql);
  console.log('✅ تم تطبيق الترحيل بنجاح — الأدوار والمستخدمون والمشاريع والأوامر الحالية لم تتأثر.');
  await db.pool.end();
}

main().catch(e => {
  console.error('❌ فشل تطبيق الترحيل:', e);
  process.exit(1);
});
