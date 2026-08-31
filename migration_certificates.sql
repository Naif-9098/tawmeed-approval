-- ============================================================
-- ترحيل إضافي (Migration) — نظام المستخلصات (Payment Certificates)
-- آمن تمامًا: لا يحذف أي جدول أو مشروع أو أمر تعميد أو مستخدم.
-- كل مستخلص مرتبط إلزاميًا بأمر تعميد عبر order_id.
-- ============================================================

CREATE TABLE IF NOT EXISTS payment_certificates (
  id                        SERIAL PRIMARY KEY,
  order_id                  INT NOT NULL REFERENCES orders(id),
  cert_seq                  INT NOT NULL,               -- 1, 2, 3... ضمن نفس أمر التعميد
  cert_no                   TEXT NOT NULL,               -- مثال: MSF-021-PC-01
  status                    TEXT NOT NULL DEFAULT 'draft'
                               CHECK (status IN ('draft','pending_review','approved','rejected','returned_for_edit','transferred','paid')),
  cert_date                 DATE,
  payment_method            TEXT CHECK (payment_method IN ('cash','transfer','retention')), -- نقدًا / تحويل / ضمان أعمال
  discount                  NUMERIC NOT NULL DEFAULT 0,
  vat_rate                  NUMERIC NOT NULL DEFAULT 15,
  subtotal                  NUMERIC NOT NULL DEFAULT 0,  -- مجموع صفوف الدفعات
  after_discount             NUMERIC NOT NULL DEFAULT 0,
  vat_amount                 NUMERIC NOT NULL DEFAULT 0,
  grand_total                NUMERIC NOT NULL DEFAULT 0,
  notes                      TEXT,
  created_by                 INT NOT NULL REFERENCES users(id),
  final_approved_by          INT REFERENCES users(id),
  final_approved_by_name     TEXT,
  final_approved_by_title    TEXT,
  final_approved_at          TIMESTAMP,
  transferred_by_name        TEXT,
  transferred_at             TIMESTAMP,
  paid_at                    TIMESTAMP,
  created_at                 TIMESTAMP NOT NULL DEFAULT now(),
  updated_at                 TIMESTAMP NOT NULL DEFAULT now(),
  UNIQUE(order_id, cert_seq)
);

-- صفوف دفعات كل مستخلص (منظمة، وليست نصًا واحدًا غير منظم)
CREATE TABLE IF NOT EXISTS payment_certificate_items (
  id               SERIAL PRIMARY KEY,
  certificate_id   INT NOT NULL REFERENCES payment_certificates(id) ON DELETE CASCADE,
  seq              INT NOT NULL,
  description      TEXT,
  amount           NUMERIC NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_pc_order ON payment_certificates(order_id);
CREATE INDEX IF NOT EXISTS idx_pc_status ON payment_certificates(status);
CREATE INDEX IF NOT EXISTS idx_pc_items_cert ON payment_certificate_items(certificate_id);

-- إعدادات عامة بسيطة (Key/Value) — تُستخدم الآن لنسبة الضريبة الافتراضية
-- للمستخلصات الجديدة، وقابلة للتوسعة مستقبلًا لأي إعداد آخر بدون تعديل الجدول.
CREATE TABLE IF NOT EXISTS system_settings (
  key    TEXT PRIMARY KEY,
  value  TEXT NOT NULL
);
INSERT INTO system_settings (key, value) VALUES ('default_cert_vat_rate', '15')
  ON CONFLICT (key) DO NOTHING;
