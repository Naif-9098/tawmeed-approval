-- ============================================================
-- نظام أوامر التعميد + نظام الاعتماد الإلكتروني
-- مخطط قاعدة البيانات (PostgreSQL)
-- ============================================================

CREATE TABLE IF NOT EXISTS users (
  id             SERIAL PRIMARY KEY,
  name           TEXT NOT NULL,
  email          TEXT UNIQUE NOT NULL,
  password_hash  TEXT NOT NULL,
  role           TEXT NOT NULL CHECK (role IN ('employee','approver','admin')),
  job_title      TEXT,
  active         BOOLEAN NOT NULL DEFAULT true,
  created_at     TIMESTAMP NOT NULL DEFAULT now()
);

-- إعدادات مستويات الاعتماد — قابلة للتوسعة مستقبلاً لأكثر من مستوى
-- (level_number يحدد الترتيب، active يتحكم هل هذا المستوى مُفعّل حاليًا أم لا)
CREATE TABLE IF NOT EXISTS approval_levels_config (
  id            SERIAL PRIMARY KEY,
  level_number  INT NOT NULL UNIQUE,
  level_name    TEXT NOT NULL,
  required_role TEXT NOT NULL DEFAULT 'approver',
  active        BOOLEAN NOT NULL DEFAULT true
);

CREATE TABLE IF NOT EXISTS orders (
  id                 SERIAL PRIMARY KEY,
  order_no           TEXT NOT NULL,
  public_token       TEXT UNIQUE NOT NULL,
  status             TEXT NOT NULL DEFAULT 'draft'
                        CHECK (status IN ('draft','pending_approval','approved','rejected','returned_for_edit')),
  scope              TEXT,
  code               TEXT,
  project_name       TEXT,
  phone              TEXT,
  project_manager    TEXT,
  contractor_name    TEXT,
  order_date         DATE,
  obligations_text   TEXT,
  vat_rate           NUMERIC DEFAULT 15,
  subtotal           NUMERIC DEFAULT 0,
  vat_amount         NUMERIC DEFAULT 0,
  grand_total        NUMERIC DEFAULT 0,
  created_by         INT NOT NULL REFERENCES users(id),
  current_level      INT NOT NULL DEFAULT 1,
  final_approved_by  INT REFERENCES users(id),
  final_approved_by_name  TEXT,
  final_approved_by_title TEXT,
  final_approved_at  TIMESTAMP,
  created_at         TIMESTAMP NOT NULL DEFAULT now(),
  updated_at         TIMESTAMP NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS order_items (
  id           SERIAL PRIMARY KEY,
  order_id     INT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  seq          INT NOT NULL,
  description  TEXT NOT NULL,
  qty          NUMERIC DEFAULT 0,
  unit         TEXT,
  unit_price   NUMERIC DEFAULT 0,
  total        NUMERIC DEFAULT 0
);

CREATE TABLE IF NOT EXISTS order_payments (
  id           SERIAL PRIMARY KEY,
  order_id     INT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  seq          INT NOT NULL,
  description  TEXT,
  pct          NUMERIC DEFAULT 0,
  value        NUMERIC DEFAULT 0
);

-- خطوة اعتماد واحدة لكل مستوى لكل أمر — الأساس الذي يسمح مستقبلاً
-- بإضافة أكثر من مستوى اعتماد بدون تغيير هيكل قاعدة البيانات
CREATE TABLE IF NOT EXISTS order_approval_steps (
  id              SERIAL PRIMARY KEY,
  order_id        INT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  level_number    INT NOT NULL,
  level_name      TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'pending'
                     CHECK (status IN ('pending','approved','rejected','returned')),
  acted_by        INT REFERENCES users(id),
  acted_by_name   TEXT,
  acted_by_title  TEXT,
  acted_at        TIMESTAMP,
  note            TEXT,
  created_at      TIMESTAMP NOT NULL DEFAULT now()
);

-- سجل العمليات (Audit Log) — إضافة فقط، لا تعديل ولا حذف من داخل التطبيق
CREATE TABLE IF NOT EXISTS audit_log (
  id          SERIAL PRIMARY KEY,
  order_id    INT REFERENCES orders(id) ON DELETE CASCADE,
  action      TEXT NOT NULL,
  actor_id    INT REFERENCES users(id),
  actor_name  TEXT NOT NULL,
  details     TEXT,
  created_at  TIMESTAMP NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
CREATE INDEX IF NOT EXISTS idx_orders_created_by ON orders(created_by);
CREATE INDEX IF NOT EXISTS idx_audit_order ON audit_log(order_id);
CREATE INDEX IF NOT EXISTS idx_steps_order ON order_approval_steps(order_id);

-- مستوى اعتماد افتراضي واحد (يمكن لاحقًا إضافة مستويات أخرى من لوحة الإدارة)
INSERT INTO approval_levels_config (level_number, level_name, required_role, active)
VALUES (1, 'معتمد أوامر التعميد', 'approver', true)
ON CONFLICT (level_number) DO NOTHING;
