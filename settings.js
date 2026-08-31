const db = require('./db');

async function getSetting(key, fallback) {
  const r = await db.query('SELECT value FROM system_settings WHERE key = $1', [key]);
  return r.rows[0] ? r.rows[0].value : fallback;
}

async function setSetting(key, value) {
  await db.query(
    `INSERT INTO system_settings (key, value) VALUES ($1,$2)
     ON CONFLICT (key) DO UPDATE SET value = $2`,
    [key, String(value)]
  );
}

module.exports = { getSetting, setSetting };
