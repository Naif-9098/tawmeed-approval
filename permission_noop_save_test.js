// permission_noop_save_test.js — حفظ صفحة المستخدم دون أي تعديل يجب ألا يغيّر صلاحية واحدة.
// يشغّل parseForm و scopeValue الحقيقيتين من routes/permissions.js على كل دور × علم الاعتماد × استثناءات.
const fs = require('fs');
const REG = require('./permission_registry'), E = require('./permission_engine');
const src = fs.readFileSync(__dirname + '/routes/permissions.js', 'utf8');
// استخراج تعريف كامل بمطابقة الأقواس (من أول «{» بعد بداية التعريف حتى قوسه المقابل)
const grab = (start) => {
  const i = src.indexOf(start); if (i < 0) throw new Error('missing ' + start);
  let k = src.indexOf('{', src.indexOf('=>', i) > -1 && src.indexOf('=>', i) < src.indexOf('{', i) + 3 ? src.indexOf('=>', i) : i), d = 0;
  for (; k < src.length; k++) { if (src[k] === '{') d++; else if (src[k] === '}') { d--; if (!d) break; } }
  return src.slice(i, k + 1) + ';';
};
const scopeOfSrc = grab('const scopeOf = '), scopeValueSrc = grab('const scopeValue = ');
const parseSrc = grab('async function parseForm(');
let current; // المستخدم تحت الاختبار
const repoRO = () => ({ getRole: async (c) => ({ code: c }), getRoleKeys: async (c) => REG.legacyKeys(c, c === 'approver') });
const engine = { describeUser: async () => current, computeEffective: E.computeEffective };
// eslint-disable-next-line no-new-func
const mod = new Function('REG', 'engine', 'repoRO', scopeOfSrc + '\nconst SCOPE_OF = scopeOf();\n' + scopeValueSrc + '\n' + parseSrc + '\nreturn { parseForm, scopeValue, SCOPE_OF };')(REG, engine, repoRO);
let n = 0, bad = 0;
(async () => {
  const extras = [[[], []], [['ORDER_MOVE'], []], [[], ['ORDER_CREATE']], [['ACCOUNTING_MARK_PAID', 'ORDER_EDIT_ALL'], ['WORK_ITEMS_EDIT']]];
  for (const r of REG.SYSTEM_ROLES) for (const flag of [false, true]) for (const [xa, xd] of extras) {
    const inh = REG.legacyKeys(r.code, r.code === 'approver');
    const ov = E.overridesFor(new Set(REG.legacyKeys(r.code, flag)), inh);
    const allow = [...new Set([...ov.allow, ...xa.filter((k) => !inh.includes(k))])].filter((k) => !xd.includes(k));
    const deny = [...new Set([...ov.deny, ...xd.filter((k) => inh.includes(k))])];
    const eff = E.computeEffective(inh, allow, deny);
    current = { user: { id: 1, role: r.code }, inherited: inh, allow, deny, effective: [...eff] };
    // جسم النموذج كما تعرضه الصفحة بلا أي تعديل
    const body = { role: r.code };
    REG.PERMISSIONS.forEach((p) => { if (!mod.SCOPE_OF[p.key]) body['p_' + p.key] = deny.includes(p.key) ? 'deny' : allow.includes(p.key) ? 'allow' : 'default'; });
    Object.keys(REG.SCOPES).forEach((sid) => (body['scope_' + sid] = mod.scopeValue(sid, eff)));
    const out = await mod.parseForm(1, body);
    n++;
    if (!E.sameSet(out.after, eff)) { bad++; console.log('✗', r.code, flag, JSON.stringify([xa, xd]), 'قبل', [...eff].filter((k) => !out.after.has(k)), 'بعد', [...out.after].filter((k) => !eff.has(k))); }
  }
  console.log('حفظ بلا تعديل: ' + n + ' حالة | تغيّرت صلاحيات في: ' + bad);
  process.exit(bad ? 1 : 0);
})();
