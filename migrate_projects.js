require('dotenv').config();
const fs = require('fs');
const path = require('path');
const db = require('./db');

async function main() {
  console.log('⏳ تطبيق ترحيل نظام المشاريع (migration_projects.sql) ...');
  const sql = fs.readFileSync(path.join(__dirname, 'migration_projects.sql'), 'utf8');
  await db.query(sql);
  console.log('✅ تم تطبيق الترحيل بنجاح — لم يُحذف أو يُغيَّر أي شيء من بياناتك الحالية.');
  await db.pool.end();
}

main().catch(e => {
  console.error('❌ فشل تطبيق الترحيل:', e);
  process.exit(1);
});
