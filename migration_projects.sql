-- ============================================================
-- ترحيل إضافي (Migration) — نظام المشاريع
-- آمن تمامًا: كله CREATE/ALTER ... IF NOT EXISTS، لا يحذف ولا
-- يعيد إنشاء أي جدول أو بيانات موجودة حاليًا.
-- شغّل هذا الملف مرة واحدة إضافة إلى schema.sql الأصلي
-- (تشغيله أكثر من مرة آمن أيضًا، كل الأوامر idempotent).
-- ============================================================

CREATE TABLE IF NOT EXISTS projects (
  id                       SERIAL PRIMARY KEY,
  name                     TEXT NOT NULL,
  code                     TEXT NOT NULL UNIQUE,
  client_name              TEXT,
  location                 TEXT,
  project_manager          TEXT,
  start_date               DATE,
  end_date                 DATE,
  status                   TEXT NOT NULL DEFAULT 'active'
                              CHECK (status IN ('active','stopped','completed','archived')),
  notes                    TEXT,
  responsible_approver_id  INT REFERENCES users(id),
  last_order_seq           INT NOT NULL DEFAULT 0,
  created_by               INT REFERENCES users(id),
  created_at                TIMESTAMP NOT NULL DEFAULT now(),
  updated_at                TIMESTAMP NOT NULL DEFAULT now()
);

-- صلاحيات وصول اختيارية على مستوى المشروع.
-- إذا لم يكن للمشروع أي صف هنا => يُعتبر "مفتوحًا" (يراه كل من له صلاحية أصلاً).
-- إذا أُضيف له صف واحد فأكثر => يقتصر الوصول على المذكورين + مدير النظام.
CREATE TABLE IF NOT EXISTS project_access (
  id          SERIAL PRIMARY KEY,
  project_id  INT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id     INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  TIMESTAMP NOT NULL DEFAULT now(),
  UNIQUE(project_id, user_id)
);

-- ربط أوامر التعميد بالمشاريع — أعمدة إضافية قابلة أن تكون فارغة
-- حتى لا تتأثر الأوامر القديمة الموجودة حاليًا إطلاقًا.
ALTER TABLE orders ADD COLUMN IF NOT EXISTS project_id INT REFERENCES projects(id);
ALTER TABLE orders ADD COLUMN IF NOT EXISTS project_order_no TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS assigned_approver_id INT REFERENCES users(id);

CREATE INDEX IF NOT EXISTS idx_orders_project ON orders(project_id);
CREATE INDEX IF NOT EXISTS idx_orders_assigned_approver ON orders(assigned_approver_id);
CREATE INDEX IF NOT EXISTS idx_project_access_project ON project_access(project_id);
CREATE INDEX IF NOT EXISTS idx_project_access_user ON project_access(user_id);
CREATE INDEX IF NOT EXISTS idx_projects_status ON projects(status);
