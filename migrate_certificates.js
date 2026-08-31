require('dotenv').config();
const fs = require('fs');
const path = require('path');
const db = require('./db');

async function main() {
  console.log('⏳ تطبيق ترحيل نظام المستخلصات (migration_certificates.sql) ...');
  const sql = fs.readFileSync(path.join(__dirname, 'migration_certificates.sql'), 'utf8');
  await db.query(sql);
  console.log('✅ تم تطبيق الترحيل بنجاح — لا شيء من بياناتك الحالية تأثر.');
  await db.pool.end();
}

main().catch(e => {
  console.error('❌ فشل تطبيق الترحيل:', e);
  process.exit(1);
});
