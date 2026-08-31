-- ============================================================
-- ترحيل إضافي (Migration) — نظام الأدوار الجديد
-- PROJECTS_MANAGER / SITE_OFFICER / TECHNICAL_OFFICE / ACCOUNTANT
-- آمن تمامًا: لا يحذف أي جدول أو مستخدم أو مشروع أو أمر تعميد.
-- الأدوار القديمة (employee, approver, admin) تبقى تعمل كما كانت
-- تمامًا؛ هذا الترحيل يضيف الأدوار الجديدة بجانبها فقط.
-- ============================================================

-- ١) توسيع قائمة الأدوار المسموحة في عمود users.role
--    (نجد اسم القيد الحالي ديناميكيًا لضمان عمل هذا بغض النظر
--    عن الاسم الذي أعطته Postgres تلقائيًا).
DO $$
DECLARE con_name text;
BEGIN
  SELECT conname INTO con_name
  FROM pg_constraint
  WHERE conrelid = 'users'::regclass
    AND contype = 'c'
    AND pg_get_constraintdef(oid) ILIKE '%role%';
  IF con_name IS NOT NULL THEN
    EXECUTE format('ALTER TABLE users DROP CONSTRAINT %I', con_name);
  END IF;
END $$;

ALTER TABLE users ADD CONSTRAINT users_role_check
  CHECK (role IN ('employee','approver','admin','projects_manager','site_officer','technical_office','accountant'));

-- ٢) صلاحية الاعتماد (Permission) منفصلة عن الدور (Role).
--    المستخدمون بدور 'approver' الحاليون يحصلون عليها تلقائيًا
--    حتى لا ينكسر نظام الاعتماد الحالي.
ALTER TABLE users ADD COLUMN IF NOT EXISTS can_approve BOOLEAN NOT NULL DEFAULT false;
UPDATE users SET can_approve = true WHERE role = 'approver' AND can_approve = false;

-- ٣) آخر تسجيل دخول (مطلوب في صفحة إدارة المستخدمين الجديدة).
ALTER TABLE users ADD COLUMN IF NOT EXISTS last_login_at TIMESTAMP;

-- ٤) السجلات المالية — وظيفة "تحويل للمحاسبة / الصرف".
--    سجل مستقل تمامًا، لا يغيّر أي بيانات في أمر التعميد نفسه.
CREATE TABLE IF NOT EXISTS financial_records (
  id              SERIAL PRIMARY KEY,
  order_id        INT NOT NULL REFERENCES orders(id),
  accountant_id   INT NOT NULL REFERENCES users(id),
  status          TEXT NOT NULL DEFAULT 'transferred'
                    CHECK (status IN ('transferred','completed')),
  notes           TEXT,
  transferred_at  TIMESTAMP NOT NULL DEFAULT now(),
  updated_at      TIMESTAMP NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_financial_records_order ON financial_records(order_id);

-- ملاحظة: جدول project_access الموجود مسبقًا (من ترحيل المشاريع)
-- يُعاد استخدامه هنا أيضًا كآلية ربط User↔Project لمسؤولي المواقع
-- (SITE_OFFICER)، فهو بالفعل مبني على User ID + Project ID.
