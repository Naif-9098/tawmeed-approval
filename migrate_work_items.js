require('dotenv').config();
const fs = require('fs');
const path = require('path');
const db = require('./db');
const { buildSearchText } = require('./workItemsUtil');

const { CATEGORY_TREE } = require('./seed_data/categories');
const { ITEMS_0_ORIGINAL } = require('./seed_data/items_0_original208');
const { ITEMS_1 } = require('./seed_data/items_1');
const { ITEMS_2 } = require('./seed_data/items_2');
const { ITEMS_3 } = require('./seed_data/items_3');
const { ITEMS_4 } = require('./seed_data/items_4');
const { ITEMS_5 } = require('./seed_data/items_5');
const { ITEMS_6 } = require('./seed_data/items_6');

async function main() {
  console.log('⏳ تطبيق ترحيل مكتبة بنود الأعمال (migration_work_items.sql) ...');
  const sql = fs.readFileSync(path.join(__dirname, 'migration_work_items.sql'), 'utf8');
  await db.query(sql);
  console.log('✅ تم إنشاء الجداول.');

  // ---------- 1) إدخال التصنيفات (رئيسي + فرعي) ----------
  console.log('⏳ إدخال التصنيفات...');
  const categoryIds = {}; // "الرئيسي" -> id ، "الرئيسي > الفرعي" -> id
  for (const group of CATEGORY_TREE) {
    let mainRes = await db.query('SELECT id FROM work_item_categories WHERE name=$1 AND parent_id IS NULL', [group.name]);
    let mainId;
    if (mainRes.rows[0]) {
      mainId = mainRes.rows[0].id;
    } else {
      const ins = await db.query('INSERT INTO work_item_categories (name, parent_id) VALUES ($1, NULL) RETURNING id', [group.name]);
      mainId = ins.rows[0].id;
    }
    categoryIds[group.name] = mainId;
    for (const subName of group.subs) {
      let subRes = await db.query('SELECT id FROM work_item_categories WHERE name=$1 AND parent_id=$2', [subName, mainId]);
      let subId;
      if (subRes.rows[0]) {
        subId = subRes.rows[0].id;
      } else {
        const ins = await db.query('INSERT INTO work_item_categories (name, parent_id) VALUES ($1,$2) RETURNING id', [subName, mainId]);
        subId = ins.rows[0].id;
      }
      categoryIds[`${group.name} > ${subName}`] = subId;
    }
  }
  console.log(`✅ تم إدخال ${CATEGORY_TREE.length} تصنيفًا رئيسيًا وتصنيفاتها الفرعية.`);

  // للبنود القديمة (من المكتبة الأصلية) لا نملك دائمًا تصنيفًا فرعيًا مضمون التسجيل
  // مسبقًا بنفس الاسم تحت نفس الرئيسي؛ الدالة التالية تتأكد من وجوده أو تنشئه.
  async function ensureSub(mainName, subName) {
    const key = `${mainName} > ${subName}`;
    if (categoryIds[key]) return categoryIds[key];
    const mainId = categoryIds[mainName];
    const ins = await db.query(
      'INSERT INTO work_item_categories (name, parent_id) VALUES ($1,$2) ON CONFLICT (name, parent_id) DO UPDATE SET name=EXCLUDED.name RETURNING id',
      [subName, mainId]
    );
    categoryIds[key] = ins.rows[0].id;
    return ins.rows[0].id;
  }

  // ---------- 2) تجميع كل البنود من كل المصادر مع إزالة التكرار الحرفي ----------
  // المكتبة الأصلية (208) أولًا، ثم التوسعة — أي وصف مطابق حرفيًا لبند سابق يُتجاهل.
  const allRaw = [];
  for (const [main, sub, desc, unit] of ITEMS_0_ORIGINAL) {
    allRaw.push({ main, sub, desc, unit, keywords: '', aliases: '' });
  }
  const expansionSets = [
    ['الأعمال التمهيدية وتجهيز الموقع', ITEMS_1.filter(i => ['الرفع المساحي','الحفر','الردم','الدك','نقل وترحيل المخلفات','الهدم والإزالة','تجهيزات الموقع المؤقتة'].includes(i[0]))],
    ['الخرسانة وحديد التسليح', ITEMS_1.filter(i => !['الرفع المساحي','الحفر','الردم','الدك','نقل وترحيل المخلفات','الهدم والإزالة','تجهيزات الموقع المؤقتة'].includes(i[0]))],
    ['المباني والبلوك واللياسة', ITEMS_2.slice(0, 20)],
    ['العزل ومعالجة الرطوبة', ITEMS_2.slice(20)],
    ['التشطيبات - الأرضيات والحوائط', ITEMS_3.filter(i => ['السيراميك','البورسلان','البلاط','الرخام','الجرانيت','الحجر','الأرضيات الخاصة','الإيبوكسي','الوزرات'].includes(i[0]))],
    ['الدهانات', ITEMS_3.filter(i => ['الدهانات الداخلية','الدهانات الخارجية','الدهانات الخاصة','تجهيز الأسطح قبل الدهان'].includes(i[0]))],
    ['الجبس والأسقف المستعارة', ITEMS_4.filter(i => ['الجبس بورد','الأسقف المستعارة','القواطع الجبسية','الديكورات الجبسية'].includes(i[0]))],
    ['الأبواب والنوافذ والألمنيوم والزجاج', ITEMS_4.filter(i => ['الأبواب الخشبية','الأبواب المعدنية','أبواب الألمنيوم','الأبواب الزجاجية','الأبواب المقاومة للحريق','الشبابيك','الألمنيوم','الزجاج والواجهات الزجاجية'].includes(i[0]))],
    ['النجارة والحدادة والأعمال المعدنية', ITEMS_4.filter(i => ['النجارة','الحدادة','الدرابزين والسلالم المعدنية','المظلات','الأسوار والبوابات','المطابخ والخزائن'].includes(i[0]))],
    ['السباكة والصرف الصحي', ITEMS_5.filter(i => ['الأدوات الصحية','شبكات المياه','شبكات الصرف الصحي','تصريف مياه الأمطار','الخزانات','المضخات'].includes(i[0]))],
    ['الكهرباء', ITEMS_5.filter(i => ['الكابلات والأسلاك','المواسير الكهربائية','اللوحات والقواطع الكهربائية','المفاتيح والأفياش','الإنارة','التأريض'].includes(i[0]))],
    ['أنظمة التيار الخفيف', ITEMS_5.filter(i => ['الشبكات والبيانات','الهاتف','كاميرات المراقبة CCTV','أنظمة الدخول والتحكم','أنظمة الإنذار'].includes(i[0]))],
    ['مكافحة الحريق', ITEMS_5.filter(i => ['إنذار الحريق','الرشاشات','خراطيم وطفايات الحريق'].includes(i[0]))],
    ['التكييف والتهوية', ITEMS_6.filter(i => ['مجاري الهواء Duct','وحدات التكييف','الأعمال الميكانيكية'].includes(i[0]))],
    ['الطرق والأرصفة', ITEMS_6.filter(i => ['الأسفلت','الإنترلوك','البردورات','المواقف'].includes(i[0]))],
    ['تنسيق المواقع والزراعة', ITEMS_6.filter(i => ['الزراعة','شبكات الري'].includes(i[0]))],
    ['الواجهات والأعمال الخارجية', ITEMS_6.filter(i => ['الواجهات','اللوحات والإرشادات'].includes(i[0]))],
    ['النظافة والصيانة والتسليم', ITEMS_6.filter(i => ['النظافة','الصيانة والإصلاحات','الترميم','الاختبارات والتشغيل','التسليم'].includes(i[0]))],
  ];
  for (const [main, arr] of expansionSets) {
    for (const [sub, desc, unit, keywords, aliases] of arr) {
      allRaw.push({ main, sub, desc, unit, keywords: keywords || '', aliases: aliases || '' });
    }
  }

  // إزالة التكرار الحرفي (نفس الوصف حرفيًا) — يبقى أول ظهور فقط
  const seenDesc = new Set();
  const finalItems = [];
  for (const it of allRaw) {
    if (seenDesc.has(it.desc)) continue;
    seenDesc.add(it.desc);
    finalItems.push(it);
  }
  console.log(`ℹ️  إجمالي البنود قبل إزالة التكرار: ${allRaw.length} — بعد إزالة التكرار الحرفي: ${finalItems.length}`);

  // ---------- 3) إدخال البنود (idempotent: تجاهل ما هو موجود مسبقًا بنفس الوصف) ----------
  let inserted = 0, skipped = 0;
  for (const it of finalItems) {
    const exists = await db.query('SELECT id FROM work_items WHERE description = $1', [it.desc]);
    if (exists.rows[0]) { skipped++; continue; }

    const subId = await ensureSub(it.main, it.sub);
    const mainId = categoryIds[it.main];
    const searchText = buildSearchText({
      description: it.desc, keywords: it.keywords, aliases: it.aliases,
      categoryName: it.main, subcategoryName: it.sub,
    });
    const itemCode = 'WI-' + String(inserted + skipped + 1).padStart(5, '0');

    await db.query(
      `INSERT INTO work_items (item_code, description, category_id, subcategory_id, default_unit, keywords, aliases, search_text, active, is_custom)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,true,false)`,
      [itemCode, it.desc, mainId, subId, it.unit, it.keywords, it.aliases, searchText]
    );
    inserted++;
  }

  const totalRes = await db.query('SELECT COUNT(*) AS c FROM work_items');
  console.log(`✅ تم إدخال ${inserted} بندًا جديدًا (تم تجاوز ${skipped} بندًا موجودًا مسبقًا من تشغيل سابق).`);
  console.log(`📊 إجمالي عدد البنود الآن في المكتبة: ${totalRes.rows[0].c}`);
  console.log('✅ لم تتأثر أي مشاريع أو أوامر تعميد أو مستخلصات أو مستخدمين أو صلاحيات.');

  await db.pool.end();
}

main().catch(e => {
  console.error('❌ فشل تطبيق الترحيل/الإدخال:', e);
  process.exit(1);
});
