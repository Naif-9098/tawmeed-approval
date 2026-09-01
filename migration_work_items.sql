-- ============================================================
-- ترحيل إضافي (Migration) — مكتبة بنود وأوصاف الأعمال
-- آمن تمامًا: لا يحذف أي جدول أو مشروع أو أمر تعميد أو مستخلص
-- أو مستخدم. لا علاقة له بجداول أوامر التعميد — البند المختار
-- يُنسخ كنص عادي داخل order_items كما كان يعمل من قبل بالضبط،
-- فلا يتأثر أي أمر قديم أو جديد حتى لو تغيّر البند لاحقًا في المكتبة.
-- ============================================================

CREATE TABLE IF NOT EXISTS work_item_categories (
  id         SERIAL PRIMARY KEY,
  name       TEXT NOT NULL,
  parent_id  INT REFERENCES work_item_categories(id),
  UNIQUE(name, parent_id)
);

CREATE TABLE IF NOT EXISTS work_items (
  id               SERIAL PRIMARY KEY,
  item_code        TEXT UNIQUE,
  description      TEXT NOT NULL,
  category_id      INT REFERENCES work_item_categories(id),
  subcategory_id   INT REFERENCES work_item_categories(id),
  default_unit     TEXT NOT NULL,
  keywords         TEXT,           -- كلمات مفتاحية، مفصولة بمسافة
  aliases          TEXT,           -- أسماء بديلة، مفصولة بمسافة
  search_text      TEXT,           -- نص مُطبَّع (بدون تشكيل/فروقات إملائية) لكل ما سبق — يُستخدم في البحث
  active           BOOLEAN NOT NULL DEFAULT true,
  is_custom        BOOLEAN NOT NULL DEFAULT false,
  usage_count      INT NOT NULL DEFAULT 0,
  created_by       INT REFERENCES users(id),
  created_at       TIMESTAMP NOT NULL DEFAULT now(),
  updated_at       TIMESTAMP NOT NULL DEFAULT now()
);

-- آخر مرة استخدم فيها كل مستخدم كل بند — لقسم "المستخدمة مؤخرًا"
CREATE TABLE IF NOT EXISTS work_item_recent_usage (
  id            SERIAL PRIMARY KEY,
  user_id       INT NOT NULL REFERENCES users(id),
  work_item_id  INT NOT NULL REFERENCES work_items(id),
  used_at       TIMESTAMP NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_work_items_active ON work_items(active);
CREATE INDEX IF NOT EXISTS idx_work_items_category ON work_items(category_id);
CREATE INDEX IF NOT EXISTS idx_work_items_search_text ON work_items(search_text);
CREATE INDEX IF NOT EXISTS idx_recent_usage_user ON work_item_recent_usage(user_id, used_at DESC);
CREATE INDEX IF NOT EXISTS idx_recent_usage_item ON work_item_recent_usage(work_item_id);
