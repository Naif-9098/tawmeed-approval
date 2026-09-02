-- ============================================================
-- ترحيل إضافي (Migration) — تصحيح دورة "التحويل للمحاسبة والصرف"
-- آمن تمامًا: لا يحذف أي جدول أو مشروع أو أمر تعميد أو مستخلص
-- أو مستخدم. الترحيل يفصل "الحالة المالية" عن "حالة الاعتماد"
-- بشكل نظيف، ويهاجر أي بيانات قديمة كانت مختلطة بينهما بأمان.
-- ============================================================

-- ============ ١) أوامر التعميد: أعمدة الحالة المالية ============
ALTER TABLE orders ADD COLUMN IF NOT EXISTS financial_status TEXT NOT NULL DEFAULT 'not_sent'
  CHECK (financial_status IN ('not_sent','sent_to_accounting','paid'));
ALTER TABLE orders ADD COLUMN IF NOT EXISTS financial_requested_by INT REFERENCES users(id);
ALTER TABLE orders ADD COLUMN IF NOT EXISTS financial_requested_by_name TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS financial_requested_at TIMESTAMP;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS financial_paid_by INT REFERENCES users(id);
ALTER TABLE orders ADD COLUMN IF NOT EXISTS financial_paid_by_name TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS financial_paid_at TIMESTAMP;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS payment_amount NUMERIC;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS payment_date DATE;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS payment_method TEXT CHECK (payment_method IN ('bank_transfer','cash','cheque','other'));
ALTER TABLE orders ADD COLUMN IF NOT EXISTS payment_reference TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS payment_notes TEXT;

-- ملاحظة: جدول financial_records القديم (من التجربة الأولى الخاطئة) يبقى
-- كما هو دون حذف (قد يحتوي بيانات تجريبية سابقة)، لكن النظام لم يعد يقرأ
-- منه أو يكتب إليه بعد الآن — الأعمدة الجديدة أعلاه هي المرجع الوحيد الآن.

-- ============ ٢) المستخلصات: نفس الأعمدة + تصحيح الخلط القديم ============
ALTER TABLE payment_certificates ADD COLUMN IF NOT EXISTS financial_status TEXT NOT NULL DEFAULT 'not_sent'
  CHECK (financial_status IN ('not_sent','sent_to_accounting','paid'));
ALTER TABLE payment_certificates ADD COLUMN IF NOT EXISTS financial_requested_by INT REFERENCES users(id);
ALTER TABLE payment_certificates ADD COLUMN IF NOT EXISTS financial_requested_by_name TEXT;
ALTER TABLE payment_certificates ADD COLUMN IF NOT EXISTS financial_requested_at TIMESTAMP;
ALTER TABLE payment_certificates ADD COLUMN IF NOT EXISTS financial_paid_by INT REFERENCES users(id);
ALTER TABLE payment_certificates ADD COLUMN IF NOT EXISTS financial_paid_by_name TEXT;
ALTER TABLE payment_certificates ADD COLUMN IF NOT EXISTS financial_paid_at TIMESTAMP;
ALTER TABLE payment_certificates ADD COLUMN IF NOT EXISTS payment_amount NUMERIC;
ALTER TABLE payment_certificates ADD COLUMN IF NOT EXISTS payment_date DATE;
ALTER TABLE payment_certificates ADD COLUMN IF NOT EXISTS payout_method TEXT CHECK (payout_method IN ('bank_transfer','cash','cheque','other'));
ALTER TABLE payment_certificates ADD COLUMN IF NOT EXISTS payment_reference TEXT;
ALTER TABLE payment_certificates ADD COLUMN IF NOT EXISTS payment_notes TEXT;

-- المستخلصات القديمة كانت تخزن الحالة المالية داخل عمود الاعتماد نفسه
-- (status = 'transferred' أو 'paid'). ننقل هذه البيانات بأمان للأعمدة
-- الجديدة، ونعيد عمود الاعتماد لقيمته الصحيحة 'approved' لأي مستخلص
-- كان بإحدى هاتين الحالتين (فهو بالضرورة كان معتمدًا أصلًا).
UPDATE payment_certificates
SET financial_status = 'paid', financial_paid_at = COALESCE(paid_at, updated_at), status = 'approved'
WHERE status = 'paid';

UPDATE payment_certificates
SET financial_status = 'sent_to_accounting', financial_requested_at = COALESCE(transferred_at, updated_at), status = 'approved'
WHERE status = 'transferred';

-- الآن نُضيّق قيد عمود status ليعكس فقط حالات الاعتماد الصحيحة
DO $$
DECLARE con_name text;
BEGIN
  SELECT conname INTO con_name
  FROM pg_constraint
  WHERE conrelid = 'payment_certificates'::regclass
    AND contype = 'c'
    AND pg_get_constraintdef(oid) ILIKE '%status%'
    AND pg_get_constraintdef(oid) ILIKE '%draft%';
  IF con_name IS NOT NULL THEN
    EXECUTE format('ALTER TABLE payment_certificates DROP CONSTRAINT %I', con_name);
  END IF;
END $$;

ALTER TABLE payment_certificates ADD CONSTRAINT payment_certificates_status_check
  CHECK (status IN ('draft','pending_review','approved','rejected','returned_for_edit'));

CREATE INDEX IF NOT EXISTS idx_orders_financial_status ON orders(financial_status);
CREATE INDEX IF NOT EXISTS idx_pc_financial_status ON payment_certificates(financial_status);
