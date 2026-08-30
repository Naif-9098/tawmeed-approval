const { Pool } = require('pg');

if (!process.env.DATABASE_URL) {
  console.error('⚠️  لم يتم ضبط DATABASE_URL. أضف قاعدة بيانات Postgres في Railway، أو اضبط ملف .env محليًا.');
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL && process.env.DATABASE_URL.includes('railway')
    ? { rejectUnauthorized: false }
    : (process.env.PGSSL === 'true' ? { rejectUnauthorized: false } : false),
});

module.exports = {
  query: (text, params) => pool.query(text, params),
  pool,
};
