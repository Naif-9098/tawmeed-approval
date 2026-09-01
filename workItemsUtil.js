/** تطبيع نص عربي لأغراض البحث: إزالة التشكيل، توحيد الألف/التاء المربوطة/الياء. */
function normalizeAr(s) {
  if (!s) return '';
  return String(s)
    .replace(/[\u064B-\u0652\u0670\u0640]/g, '') // تشكيل + تطويل
    .replace(/[إأآا]/g, 'ا')
    .replace(/ى/g, 'ي')
    .replace(/ة/g, 'ه')
    .replace(/[ؤئ]/g, 'ء')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/** يبني نص البحث المطبَّع الذي يُخزَّن مع كل بند (وصف + كلمات مفتاحية + أسماء بديلة + تصنيفات). */
function buildSearchText({ description, keywords, aliases, categoryName, subcategoryName }) {
  return normalizeAr([description, keywords, aliases, categoryName, subcategoryName].filter(Boolean).join(' '));
}

module.exports = { normalizeAr, buildSearchText };
