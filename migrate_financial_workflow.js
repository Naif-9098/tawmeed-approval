require('dotenv').config();
const fs = require('fs');
const path = require('path');
const db = require('./db');

async function main() {
  console.log('⏳ تطبيق ترحيل تصحيح دورة التحويل للمحاسبة والصرف (migration_financial_workflow.sql) ...');
  const sql = fs.readFileSync(path.join(__dirname, 'migration_financial_workflow.sql'), 'utf8');
  await db.query(sql);
  console.log('✅ تم تطبيق الترحيل بنجاح — لم يُحذف أو يُفقد أي بيانات حالية.');
  await db.pool.end();
}

main().catch(e => {
  console.error('❌ فشل تطبيق الترحيل:', e);
  process.exit(1);
});
