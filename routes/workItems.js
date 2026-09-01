const express = require('express');
const router = express.Router();
const db = require('../db');
const { requireLogin, requirePermission } = require('../middleware/auth');
const { logAction } = require('../audit');
const { canManageWorkItems, canAddWorkItem, canEditWorkItem, canAccessWorkItemsLibrary } = require('../permissions');
const { normalizeAr, buildSearchText } = require('../workItemsUtil');

router.use(requireLogin);

/** يرتب مرشحين حسب قوة التطابق مع الاستعلام (أقل = أفضل)، ثم عدد الاستخدام كمرجّح إضافي. */
function scoreItem(item, qNorm) {
  const descNorm = normalizeAr(item.description);
  const catNorm = normalizeAr((item.category_name || '') + ' ' + (item.subcategory_name || ''));
  const kwNorm = normalizeAr((item.keywords || '') + ' ' + (item.aliases || ''));

  let base = null;
  if (descNorm === qNorm) base = 0;
  else if (descNorm.startsWith(qNorm)) base = 1;
  else if (descNorm.includes(qNorm)) base = 2;
  else if (kwNorm.includes(qNorm)) base = 3;
  else if (catNorm.includes(qNorm)) base = 4;
  if (base === null) return null;

  // مرجّح بسيط لعدد الاستخدام حتى لا يطغى على قوة التطابق نفسها
  const usageAdjust = 1 / (1 + Math.log(1 + (item.usage_count || 0)));
  return base + usageAdjust * 0.5;
}

/* -------- بحث فوري (Autocomplete API) -------- */
router.get('/api/work-items/search', async (req, res) => {
  const q = (req.query.q || '').trim();
  if (!q) return res.json([]);
  const qNorm = normalizeAr(q);

  const rows = (await db.query(`
    SELECT w.*, mc.name AS category_name, sc.name AS subcategory_name
    FROM work_items w
    LEFT JOIN work_item_categories mc ON mc.id = w.category_id
    LEFT JOIN work_item_categories sc ON sc.id = w.subcategory_id
    WHERE w.active = true AND w.search_text ILIKE '%' || $1 || '%'
    LIMIT 400
  `, [qNorm])).rows;

  const scored = rows
    .map(r => ({ r, s: scoreItem(r, qNorm) }))
    .filter(x => x.s !== null)
    .sort((a, b) => a.s - b.s)
    .slice(0, 15)
    .map(x => x.r);

  res.json(scored.map(r => ({
    id: r.id, description: r.description, unit: r.default_unit,
    category: r.category_name, subcategory: r.subcategory_name,
  })));
});

/* -------- المستخدمة مؤخرًا (للمستخدم الحالي) -------- */
router.get('/api/work-items/recent', async (req, res) => {
  const rows = (await db.query(`
    SELECT DISTINCT ON (w.id) w.id, w.description, w.default_unit AS unit, ru.used_at
    FROM work_item_recent_usage ru
    JOIN work_items w ON w.id = ru.work_item_id AND w.active = true
    WHERE ru.user_id = $1
    ORDER BY w.id, ru.used_at DESC
  `, [req.session.user.id])).rows;
  rows.sort((a, b) => new Date(b.used_at) - new Date(a.used_at));
  res.json(rows.slice(0, 6));
});

/* -------- الأكثر استخدامًا (عامة لكل الشركة) -------- */
router.get('/api/work-items/popular', async (req, res) => {
  const rows = (await db.query(`
    SELECT id, description, default_unit AS unit FROM work_items
    WHERE active = true AND usage_count > 0
    ORDER BY usage_count DESC LIMIT 6
  `)).rows;
  res.json(rows);
});

/* -------- تسجيل استخدام بند (عند اختياره فعليًا في أمر تعميد) -------- */
router.post('/api/work-items/:id/use', async (req, res) => {
  const user = req.session.user;
  const itemId = req.params.id;
  await db.query('UPDATE work_items SET usage_count = usage_count + 1 WHERE id = $1', [itemId]);
  await db.query('INSERT INTO work_item_recent_usage (user_id, work_item_id) VALUES ($1,$2)', [user.id, itemId]);
  res.json({ ok: true });
});

/* -------- إضافة بند جديد للمكتبة (مدير المشاريع أو المكتب الفني) -------- */
router.post('/api/work-items/new', requirePermission(canAddWorkItem), async (req, res) => {
  const user = req.session.user;
  const b = req.body;
  if (!b.description || !b.default_unit || !b.main_category) {
    return res.status(400).json({ error: 'الوصف والوحدة والتصنيف الرئيسي مطلوبة.' });
  }
  try {
    let mainRes = await db.query('SELECT id FROM work_item_categories WHERE name=$1 AND parent_id IS NULL', [b.main_category]);
    let mainId = mainRes.rows[0] ? mainRes.rows[0].id
      : (await db.query('INSERT INTO work_item_categories (name, parent_id) VALUES ($1,NULL) RETURNING id', [b.main_category])).rows[0].id;

    let subId = null;
    if (b.subcategory) {
      let subRes = await db.query('SELECT id FROM work_item_categories WHERE name=$1 AND parent_id=$2', [b.subcategory, mainId]);
      subId = subRes.rows[0] ? subRes.rows[0].id
        : (await db.query('INSERT INTO work_item_categories (name, parent_id) VALUES ($1,$2) RETURNING id', [b.subcategory, mainId])).rows[0].id;
    }

    const searchText = buildSearchText({
      description: b.description, keywords: b.keywords, aliases: b.aliases,
      categoryName: b.main_category, subcategoryName: b.subcategory,
    });
    const countRes = await db.query('SELECT COUNT(*) AS c FROM work_items');
    const itemCode = 'WI-' + String(parseInt(countRes.rows[0].c, 10) + 1).padStart(5, '0');

    const result = await db.query(
      `INSERT INTO work_items (item_code, description, category_id, subcategory_id, default_unit, keywords, aliases, search_text, active, is_custom, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,true,true,$9) RETURNING id, description, default_unit`,
      [itemCode, b.description, mainId, subId, b.default_unit, b.keywords || '', b.aliases || '', searchText, user.id]
    );
    await logAction({ action: 'إضافة بند جديد لمكتبة الأعمال', actorId: user.id, actorName: user.name, details: `البند: ${b.description}` });
    res.json({ ok: true, item: result.rows[0] });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'تعذر إضافة البند.' });
  }
});

/* -------- صفحة إدارة المكتبة الكاملة (مدير المشاريع فقط) -------- */
router.get('/work-items', requirePermission(canAccessWorkItemsLibrary), async (req, res) => {
  const params = [];
  let filter = '';
  if (req.query.q) {
    params.push(`%${normalizeAr(req.query.q)}%`);
    filter += ` AND w.search_text ILIKE $${params.length}`;
  }
  if (req.query.category_id) {
    params.push(req.query.category_id);
    filter += ` AND (w.category_id = $${params.length} OR w.subcategory_id = $${params.length})`;
  }
  if (req.query.status === 'inactive') filter += ` AND w.active = false`;
  else if (req.query.status !== 'all') filter += ` AND w.active = true`;

  const rows = (await db.query(`
    SELECT w.*, mc.name AS category_name, sc.name AS subcategory_name
    FROM work_items w
    LEFT JOIN work_item_categories mc ON mc.id = w.category_id
    LEFT JOIN work_item_categories sc ON sc.id = w.subcategory_id
    WHERE 1=1 ${filter}
    ORDER BY w.usage_count DESC, mc.name, w.description
    LIMIT 500
  `, params)).rows;

  const mainCats = (await db.query('SELECT id, name FROM work_item_categories WHERE parent_id IS NULL ORDER BY name')).rows;
  const totalRes = await db.query('SELECT COUNT(*) AS c FROM work_items WHERE active = true');

  res.render('work-items/index', { items: rows, mainCats, q: req.query, totalActive: totalRes.rows[0].c, canToggle: canManageWorkItems(req.session.user) });
});

/* -------- تعديل بند (مدير المشاريع أو المكتب الفني) / تفعيل وتعطيل (مدير المشاريع فقط) -------- */
router.post('/work-items/:id/edit', requirePermission(canEditWorkItem), async (req, res) => {
  const user = req.session.user;
  const b = req.body;
  const item = (await db.query('SELECT * FROM work_items WHERE id=$1', [req.params.id])).rows[0];
  if (!item) return res.redirect('/work-items');

  const catNameRes = await db.query('SELECT name FROM work_item_categories WHERE id = $1', [item.category_id]);
  const subNameRes = await db.query('SELECT name FROM work_item_categories WHERE id = $1', [item.subcategory_id]);
  const searchText = buildSearchText({
    description: b.description, keywords: b.keywords, aliases: b.aliases,
    categoryName: catNameRes.rows[0] ? catNameRes.rows[0].name : '',
    subcategoryName: subNameRes.rows[0] ? subNameRes.rows[0].name : '',
  });

  await db.query(
    `UPDATE work_items SET description=$1, default_unit=$2, keywords=$3, aliases=$4, search_text=$5, updated_at=now() WHERE id=$6`,
    [b.description, b.default_unit, b.keywords || '', b.aliases || '', searchText, req.params.id]
  );
  await logAction({ action: 'تعديل بند في مكتبة الأعمال', actorId: user.id, actorName: user.name, details: `البند: ${b.description}` });
  res.redirect('/work-items' + (req.query.back || ''));
});

router.post('/work-items/:id/toggle', requirePermission(canManageWorkItems), async (req, res) => {
  const user = req.session.user;
  const item = (await db.query('SELECT * FROM work_items WHERE id=$1', [req.params.id])).rows[0];
  if (!item) return res.redirect('/work-items');
  await db.query('UPDATE work_items SET active = NOT active, updated_at = now() WHERE id=$1', [req.params.id]);
  await logAction({
    action: item.active ? 'تعطيل بند في مكتبة الأعمال' : 'تفعيل بند في مكتبة الأعمال',
    actorId: user.id, actorName: user.name, details: `البند: ${item.description}`,
  });
  res.redirect('/work-items');
});

module.exports = router;
