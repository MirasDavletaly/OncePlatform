// Diplomas and certificates of candidates: what the document is, who issued it, to whom and when (rules over the text
// layer or the OCR text), whose candidate it is (the holder's name against the names in the CV database, Latin and
// Cyrillic spellings and Russian/Kazakh case endings tolerated), and how it enters the candidate's profile.
// Runs on the server only, like the rest of the engine: the documents are personal data.
import { lev } from './parse.js';
import { DEGREES, degreeOf } from './cv.js';

const lines = (text) => String(text || '').split(/\n/).map((l) => l.replace(/\s+/g, ' ').trim()).filter(Boolean);

// ------------------------------------------------------------------ names: one skeleton for Latin and Cyrillic spellings
const CYR = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z', и: 'i', й: 'i', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o',
  п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'kh', ц: 'ts', ч: 'ch', ш: 'sh', щ: 'sh', ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu',
  я: 'ya', ә: 'a', ғ: 'g', қ: 'k', ң: 'n', ө: 'o', ұ: 'u', ү: 'u', һ: 'h', і: 'i',
};
// "Ахметову", "Akhmetov" and "Ahmetov" share the skeleton "ahmetov…"; "Жанар" = "Zhanar", "Юлия" = "Yulia".
export function skeleton(word) {
  let s = [...String(word).toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')].map((c) => CYR[c] ?? c).join('');
  s = s.replace(/[^a-z]/g, '').replace(/ye/g, 'e').replace(/kh/g, 'h').replace(/d?zh|dj/g, 'j').replace(/shch|sch|sh/g, 's')
    .replace(/ch|tz|ts/g, 'C').replace(/c/g, 'k').replace(/C/g, 'c').replace(/ph/g, 'f').replace(/q/g, 'k').replace(/w/g, 'v')
    .replace(/x/g, 'ks').replace(/y/g, 'i');
  return s.replace(/(.)\1+/g, '$1');
}
const tokens = (name) => String(name || '').split(/[\s,.-]+/).map(skeleton).filter((t) => t.length >= 2);

// Russian and Kazakh case endings of names after the skeleton: Арману, Ахметовой, Марии, Сергею, Арманға, Болатұлына
const END = /^(?:u|iu|e|i|a|ia|oi|ei|om|em|im|ga|ge|ka|ke|na|ne|ina|ine)$/;
const withEnding = (s, l) =>
  (s.length >= 3 && l.startsWith(s) && END.test(l.slice(s.length))) ||
  (s.length >= 4 && /[aeiou]$/.test(s) && l.startsWith(s.slice(0, -1)) && END.test(l.slice(s.length - 1)));
// the same name word, allowing a case ending and one OCR slip in long words (Марат is not Мария, Нур is not Нурлан)
export function sameWord(a, b) {
  if (a === b) return true;
  if (withEnding(a, b) || withEnding(b, a)) return true;
  return Math.min(a.length, b.length) >= 5 && Math.abs(a.length - b.length) <= 1 && lev(a, b) <= 1;
}

// how many words of the candidate's name the text has (each text word used once)
function nameHits(cand, words) {
  const free = [...words];
  let hits = 0;
  for (const c of cand) {
    const i = free.findIndex((w) => sameWord(c, w));
    if (i >= 0) { hits += 1; free.splice(i, 1); }
  }
  return hits;
}

// ------------------------------------------------------------------ what the document says
const NAME_WORD = /^[\p{Lu}][\p{L}'’]+(?:-[\p{L}'’]+)?$/u;
const NOT_NAME = /^(?:certificate|certification|diploma|сертификат|диплом|куәлік|удостоверение|свидетельство|project|management|professional|university|университет|institute|институт|has|have|for|the|of|and|in|is|on|успешно|прош[её]л|прошла|окончил|окончила|по|за|в|и|степени|degree|bachelor|master|бакалавр|магистр)$/iu;

// the holder's name at the start of s: 2-4 capitalised words ("ARMAN AKHMETOV", "Ахметову Арману Болатовичу");
// OCR noise inside and around the words goes first ("— Karim. N;asser-Haddad" → "Karim Nasser-Haddad")
function nameAt(s) {
  const out = [];
  const clean = String(s || '').replace(/(?<=\p{L})[;:·•|_~`^'’](?=\p{L})/gu, '').replace(/[«»"“”:,;.·•|_~`^]/g, ' ').replace(/^[^\p{L}]+/u, '');
  for (const w of clean.trim().split(/\s+/)) {
    if (!NAME_WORD.test(w) || NOT_NAME.test(w)) break;
    out.push(w);
    if (out.length === 4) break;
  }
  return out.length >= 2 ? out.join(' ') : null;
}

// phrases after which the name follows ("This is to certify that", "настоящим удостоверяется, что", "выдан")
const BEFORE_NAME = [
  /(?:hereby\s+)?certif(?:y|ies)\s+that\s*:?/i,
  /(?:is\s+)?(?:hereby\s+)?(?:awarded|presented|granted|issued|c?onferred|c?onfers?|bestows?|bestowed)\s+(?:up)?(?:to|on)\s*[:\-–]?/i,
  /this\s+is\s+to\s+confirm\s+that/i,
  /(?:настоящ(?:ий|ее|ая|им)\s+)?(?:сертификат|диплом|удостоверение|свидетельство)?\s*(?:подтверждает|удостоверяет|свидетельствует)\s*,?\s*что/i,
  /(?:удостоверяется|подтверждается|настоящим\s+подтверждается)\s*,?\s*что/i,
  /(?:сертификат|диплом|удостоверение|свидетельство)\s+выдан[оа]?\s*:?/i,
  /^выдан[оа]?\s*:?/i,
  /(?:награжда|вруча)ется\s*:?/i,
  /^осы\s+(?:сертификат|диплом|куәлік)\s*/i,
];
// phrases the name precedes ("Arman Akhmetov / has successfully completed", "Ахметов Арман / успешно прошёл");
// \b does not work with Cyrillic in JS, hence (?!\p{L})
const VERB = '(?:прош[её]л|прошла|окончил|окончила|завершил|завершила|освоил|освоила|сдал|сдала)(?!\\p{L})';
const AFTER_NAME = new RegExp(`^(?:has|have)\\s+(?:successfully\\s+)?(?:completed|passed|achieved|earned|fulfilled|demonstrated|been)|^successfully\\s+completed|^(?:успешно\\s+)?${VERB}|берілді|^is\\s+(?:hereby\\s+)?(?:recognized|awarded)`, 'iu');
const AFTER_INLINE = new RegExp(`\\s(?:has|have)\\s+(?:successfully\\s+)?(?:completed|passed|achieved|earned|been)(?!\\p{L})|\\s(?:успешно\\s+)?${VERB}`, 'iu');

export function holderOf(ls) {
  for (let i = 0; i < ls.length; i += 1) {
    const l = ls[i];
    for (const re of BEFORE_NAME) {
      const m = l.match(re);
      if (!m) continue;
      const rest = l.slice(m.index + m[0].length).trim();
      // the name on the next line when the rest of this one is only noise ("conferred upon—.__ s")
      const name = nameAt(rest) || ((rest.match(/\p{L}/gu) || []).length < 3 ? nameAt(ls[i + 1]) : null);
      if (name) return name;
    }
    if (i > 0 && AFTER_NAME.test(l) && ls[i - 1].split(' ').length <= 5) {
      const name = nameAt(ls[i - 1]);
      if (name) return name;
    }
    const m = l.match(AFTER_INLINE);
    if (m && m.index > 0 && l.slice(0, m.index).split(' ').length <= 4) {
      const name = nameAt(l.slice(0, m.index));
      if (name) return name;
    }
  }
  return null;
}

// issuers: [display name, pattern]; universities and colleges are taken from the text itself
const ISSUERS = [
  ['Project Management Institute (PMI)', /project management institute|\bPMI\b/i],
  ['PeopleCert', /peoplecert/i], ['AXELOS', /axelos/i], ['APMG International', /\bapmg\b/i], ['IPMA', /\bIPMA\b/],
  ['Scrum.org', /scrum\.org/i], ['Scrum Alliance', /scrum alliance/i], ['ISTQB', /\bistqb\b/i], ['IIBA', /\bIIBA\b|international institute of business analysis/i],
  ['Amazon Web Services', /amazon web services|\bAWS\b/], ['Microsoft', /microsoft/i], ['Google', /\bgoogle\b/i], ['Oracle', /\boracle\b/i],
  ['Cisco', /\bcisco\b/i], ['Red Hat', /red\s?hat/i], ['The Linux Foundation', /linux foundation/i], ['CNCF', /\bCNCF\b|cloud native computing foundation/i],
  ['VMware', /vmware/i], ['Huawei', /huawei/i], ['IBM', /\bIBM\b/], ['SAP', /\bSAP\b/], ['Salesforce', /salesforce/i], ['Atlassian', /atlassian/i],
  ['HashiCorp', /hashicorp/i], ['Databricks', /databricks/i], ['Snowflake', /snowflake/i], ['Fortinet', /fortinet/i], ['Palo Alto Networks', /palo alto networks/i],
  ['ISACA', /\bisaca\b/i], ['(ISC)²', /\(isc\)|\bisc2\b|isc²/i], ['CompTIA', /comptia/i], ['EC-Council', /ec-council/i], ['OffSec', /offensive security|\boffsec\b/i],
  ['Kaspersky', /kaspersky|касперск/i], ['The Open Group', /the open group/i], ['1С', /фирм[аы]\s*[«"]?1С|\b1С:/i],
  ['Coursera', /coursera/i], ['Udemy', /udemy/i], ['edX', /\bedx\b/i], ['LinkedIn Learning', /linkedin learning/i], ['Stepik', /stepik/i],
  ['Astana Hub', /astana hub/i], ['British Council', /british council/i], ['ETS', /\bTOEFL\b|educational testing service/], ['Cambridge English', /cambridge (?:assessment )?english/i],
];
// "академических часов" is no academy
const INSTITUTION = /universit|университет|institut|институт|academy|академи(?:я|и|ю|ей|ясы)(?!\p{L})|college|колледж|school of|школа\s+бизнеса|высшая\s+школа|техникум|lyceum/iu;
const ORG = /(?:^|\s)(?:ТОО|АО|ООО|НАО|ЧУ|РГП|LLP|LLC|Ltd\.?|Inc\.?|GmbH)\s*[«"“]?[^»"”\n]{2,60}[»"”]?/u;

// known certifications: [title, pattern]
const CERTS = [
  ['Project Management Professional (PMP)', /project management professional|\bPMP\b/i], ['Certified Associate in Project Management (CAPM)', /\bCAPM\b|certified associate in project management/i],
  ['PMI Agile Certified Practitioner (PMI-ACP)', /PMI-ACP|agile certified practitioner/i], ['Program Management Professional (PgMP)', /\bPgMP\b|program management professional/i],
  ['PMI Risk Management Professional (PMI-RMP)', /PMI-RMP|risk management professional/i],
  ['ITIL 4 Foundation', /ITIL\s*(?:®|4)?[^\n]{0,20}foundation/i], ['ITIL', /\bITIL\b/],
  ['PRINCE2 Practitioner', /PRINCE2[^\n]{0,25}practitioner/i], ['PRINCE2 Foundation', /PRINCE2[^\n]{0,25}foundation/i], ['PRINCE2', /PRINCE2/i],
  ['Professional Scrum Master (PSM)', /professional scrum master|\bPSM\s*I*\b/i], ['Professional Scrum Product Owner (PSPO)', /professional scrum product owner|\bPSPO\b/i],
  ['Certified ScrumMaster (CSM)', /certified scrum\s?master|\bCSM\b/i],
  ['CISSP', /\bCISSP\b|certified information systems security professional/i], ['CISA', /\bCISA\b|certified information systems auditor/i],
  ['CISM', /\bCISM\b|certified information security manager/i], ['CRISC', /\bCRISC\b/], ['CGEIT', /\bCGEIT\b/],
  ['Certified Ethical Hacker (CEH)', /certified ethical hacker|\bCEH\b/i], ['OSCP', /\bOSCP\b|offensive security certified professional/i],
  ['CompTIA Security+', /security\+/i], ['CompTIA Network+', /network\+/i],
  ['CCIE', /\bCCIE\b/], ['CCNP', /\bCCNP\b|cisco certified network professional/i], ['CCNA', /\bCCNA\b|cisco certified network associate/i],
  ['Certified Kubernetes Administrator (CKA)', /certified kubernetes administrator|\bCKA\b/i], ['Certified Kubernetes Application Developer (CKAD)', /certified kubernetes application developer|\bCKAD\b/i],
  ['RHCE', /\bRHCE\b|red hat certified engineer/i], ['RHCSA', /\bRHCSA\b|red hat certified system administrator/i],
  ['ISTQB Certified Tester Foundation Level', /istqb[^\n]{0,80}foundation|certified tester[^\n]{0,30}foundation/i],
  ['CBAP', /\bCBAP\b|certified business analysis professional/i], ['CCBA', /\bCCBA\b/], ['ECBA', /\bECBA\b/], ['TOGAF', /togaf/i],
  ['IELTS', /\bIELTS\b/], ['TOEFL', /\bTOEFL\b/],
  // health, safety and oil & gas: the team's construction and field candidates
  ['NEBOSH International General Certificate', /NEBOSH[^\n]{0,40}(?:international\s+)?general\s+certificate|NEBOSH\s+IG/i], ['NEBOSH', /\bNEBOSH\b/i],
  ['IOSH Managing Safely', /IOSH[^\n]{0,20}managing\s+safe/i], ['IOSH', /\bIOSH\b/], ['OSHA 30-Hour', /OSHA[^\n]{0,15}30/i], ['OSHA', /\bOSHA\b/],
  ['BOSIET', /\bBOSIET\b/i], ['H2S', /\bH2S\b/i], ['First Aid', /first\s+aid/i], ['ISO 9001', /ISO\s*9001/i], ['ISO 14001', /ISO\s*14001/i],
  ['ISO 45001', /ISO\s*45001/i], ['Primavera P6', /primavera/i], ['HACCP', /\bHACCP\b/],
  ['Допуск по электробезопасности', /групп\p{L}*\s+(?:допуска\s+)?(?:по\s+)?электробезопасност|электробезопасност/iu],
  ['Промышленная безопасность', /промышленн\p{L}*\s+безопасност/iu], ['Охрана труда', /охран\p{L}*\s+труда/iu],
  ['Пожарно-технический минимум', /пожарно-техническ/iu], ['Работы на высоте', /работ\p{L}*\s+на\s+высоте/iu], ['Энергоаудит', /энергоаудит/iu],
];

function titleOf(ls, text) {
  const aws = text.match(/AWS\s+Certified\s+([A-Za-z][A-Za-z \-–]{2,60}?(?:Associate|Professional|Specialty|Practitioner))/i);
  if (aws) return `AWS Certified ${aws[1].replace(/\s+/g, ' ').trim()}`;
  const ms = text.match(/Microsoft\s+Certified\s*:\s*([^\n]{3,80})/i);
  if (ms) return `Microsoft Certified: ${ms[1].trim()}`;
  const gcp = text.match(/(?:Google Cloud Certified\s*[-–:]?\s*)?(Professional Cloud (?:Architect|Developer|DevOps Engineer|Data Engineer|Security Engineer|Network Engineer)|Associate Cloud Engineer)/i);
  if (gcp) return `Google Cloud ${gcp[1]}`;
  const oracle = text.match(/Oracle Certified (?:Professional|Associate|Master)[^\n]{0,60}/i);
  if (oracle) return oracle[0].trim();
  for (const [title, re] of CERTS) if (re.test(text)) return title;
  // "has successfully completed the course «...»", "успешно прошёл(а) обучение по программе «...»"
  for (let i = 0; i < ls.length; i += 1) {
    const m = ls[i].match(/(?:successfully\s+completed|has\s+completed|completion\s+of|прош[её]л(?:а)?|окончил(?:а)?|завершил(?:а)?|освоил(?:а)?)\s*(?:the\s+)?(?:обучение|курсы?|программу|course|program(?:me)?|training)?(?:\s+повышения\s+квалификации)?\s*(?:по\s+(?:курсу|программе|теме|направлению))?\s*[:«"“]?\s*([^»"”]*)/i);
    if (m) {
      const t = clean(m[1]) || clean(ls[i + 1]);
      if (t && !AFTER_NAME.test(t)) return t;
    }
  }
  const quoted = text.match(/[«"“]([^»"”\n]{5,150})[»"”]/);
  return quoted ? clean(quoted[1]) : null;
}
// cut first: the trailing-run regex is quadratic on a line of thousands of dots (a title is at most 160 characters)
const clean = (s) => { const t = String(s || '').slice(0, 400).replace(/^[\s:–«"“-]+|[\s.,;:–»"”-]+$/g, ''); return t.length >= 3 && t.length <= 160 && /\p{L}{3}/u.test(t) ? t : null; };

function issuerOf(ls, text) {
  for (const [name, re] of ISSUERS) if (re.test(text)) return name;
  const org = text.match(ORG); // a training centre names itself with its legal form
  return org ? cleanOrg(org[0]) : institutionOf(ls);
}

// "2 NORTHGATE UNIVERSITY" (a logo read by OCR) → "Northgate University"; "‚„„мемлекеттік … —" → the words only
export function cleanOrg(s) {
  let t = String(s || '').replace(/^(?:[^\p{L}]+|\p{L}\s+(?=\p{Lu}{3,}))+/u, '').replace(/[\s.,;:–—\-|_]+$/u, '').replace(/\s+/g, ' ').trim();
  // ALL CAPS → Title Case; abbreviations and legal forms (up to 3 letters: ТОО, АО, LLP) stay as they are
  if (/\p{Lu}{4,}/u.test(t) && !/\p{Ll}/u.test(t)) {
    t = t.split(' ').map((w) => (w.replace(/[^\p{L}]/gu, '').length <= 3 ? w : w.toLowerCase().replace(/\p{L}/u, (c) => c.toUpperCase()))).join(' ');
  }
  return t || null;
}

// form hints under the lines of a diploma: "(полное наименование высшего учебного заведения)", "(full name of …)"
const HINT = /^\(.*\)?$|^\(?(?:полное\s+наименование|full\s+name|жоғары\s+оқу|фамилия|name\s+of)/iu;
// a word read in one script ("Serikbayev", "университета"); OCR noise mixes them ("р. Serikbayev")
const mixedWords = (s) => (s.match(/\p{L}+/gu) || []).filter((w) => /\p{Script=Latin}/u.test(w) && /\p{Script=Cyrillic}/u.test(w)).length +
  (s.match(/(?:^|\s)\p{Script=Cyrillic}\.?\s+\p{Script=Latin}|\p{Script=Latin}\s+\p{Script=Cyrillic}\.?(?:\s|$)/gu) || []).length;

function institutionOf(ls) {
  const found = [];
  ls.forEach((l, i) => {
    if (!INSTITUTION.test(l) || l.length > 160 || /certif|сертифик/i.test(l) || HINT.test(l)) return;
    // a name broken over two lines: "Восточно-Казахстанского государственного" / "технического университета им. Д.Серикбаева"
    const prev = ls[i - 1] || '';
    const joined = prev && !INSTITUTION.test(prev) && !HINT.test(prev) && prev.length <= 60 && /\p{L}{4}/u.test(prev) &&
      (/^\p{Ll}/u.test(l.replace(/^[^\p{L}]+/u, '')) || /(?:ого|его|ский|ская|ный|ная|атындағы|\sof|\sand|&)$/iu.test(prev));
    const next = ls[i + 1] || '';
    const tail = /^(?:имени|им\.|named after)/i.test(next) ? ` ${next}` : '';
    // both readings compete: the previous line may as well be the end of another page
    found.push({ name: cleanOrg(l + tail), i });
    if (joined) found.push({ name: cleanOrg(`${prev} ${l}${tail}`), i });
  });
  if (!found.length) return null;
  found.splice(50); // a real document names a few institutions; thousands of "University" lines are no document
  // a university beats one of its schools; the name that recurs ("NORTHGATE UNIVERSITY" … "the seal of Northgate
  // University") beats a stamp read once; then a clean reading beats a noisy one, a fuller name a shorter one
  const text = ` ${fold(ls.join(' '))} `;
  const counted = new Map(); // the sort compares each name many times: count it once
  const times = (s) => {
    const k = fold(s || '');
    if (!counted.has(k)) counted.set(k, k ? text.split(` ${k} `).length - 1 : 0);
    return counted.get(k);
  };
  const main = (s) => (MAIN_INSTITUTION.test(s || '') ? 1 : 0);
  found.sort((a, b) => main(b.name) - main(a.name) || times(b.name) - times(a.name) || mixedWords(a.name) - mixedWords(b.name) ||
    (b.name || '').length - (a.name || '').length || a.i - b.i);
  return found[0].name;
}
const MAIN_INSTITUTION = /universit|университет|institut|институт|academy|академи|college|колледж|lyceum|лицей/iu;

// words of fields of study, to repair OCR noise in them ("ClVfl Engineering" → "Civil Engineering")
const FIELD_WORDS = ['Civil', 'Mechanical', 'Electrical', 'Electronic', 'Engineering', 'Science', 'Sciences', 'Information', 'Systems',
  'Computer', 'Software', 'Petroleum', 'Chemical', 'Construction', 'Architecture', 'Economics', 'Management', 'Business', 'Administration',
  'Finance', 'Accounting', 'Mathematics', 'Physics', 'Chemistry', 'Geology', 'Mining', 'Industrial', 'Environmental', 'Technology',
  'Applied', 'Energy', 'Power', 'Automation', 'Transport', 'Logistics', 'Marketing', 'Design', 'Structural', 'Telecommunications',
  'Instrumentation', 'Control'];
// only words that look broken (a capital inside: "ClVfl", "DlStlnCthTIS") are repaired, and only to a close field word
function fixOcrWords(s) {
  return s.replace(/\p{L}+/gu, (w) => {
    if (!/^\p{L}\p{Ll}*\p{Lu}/u.test(w) || w.length < 4) return w;
    const lw = w.toLowerCase();
    const best = FIELD_WORDS.map((f) => [f, lev(lw, f.toLowerCase())]).filter(([f]) => Math.abs(f.length - w.length) <= 1).sort((a, b) => a[1] - b[1])[0];
    return best && best[1] <= (w.length >= 5 ? 2 : 1) ? best[0] : w;
  });
}

const AREA = /(?:по\s+специальности|по\s+образовательной\s+программе|по\s+направлению(?:\s+подготовки)?|специальность|мамандығы|білім\s+беру\s+бағдарламасы|in\s+the\s+field\s+of|speciality|specialty|major(?:\s+in)?|degree\s+in|(?:bachelor|master)\s+of\s+(?:science|arts|engineering)\s+in)\s*[:«"“]?\s*([^»"”\n]{3,120})/giu;
// the first usable one: in Kazakh the name comes before "мамандығы бойынша", so "бойынша |" is no specialty
function areaOf(text) {
  for (const m of text.matchAll(AREA)) {
    const v = clean(fixOcrWords(m[1].replace(/^[«"“]/, '')));
    if (v && !/^бойынша|атауы|наименование|name\s+of/iu.test(v) && !HINT.test(v)) return v;
  }
  return null;
}

// identity papers (a visa, a passport) are no diplomas: they never enter the profile
const ID_PAPER = /<<<|\bVISA\b|ВИЗА|\bPASSPORT\s*(?:N|No|№)|ПАСПОРТ\s*№|PLACE\s+OF\s+ISSUE|ҚОЛДАНЫЛУ\s+МЕРЗІМІ|УДОСТОВЕРЕНИЕ\s+ЛИЧНОСТИ|ЖЕКЕ\s+КУӘЛІК/iu;
// a visa: says so, has entries or an inviting organisation, or its machine-readable line starts with V
const VISA_SIGNS = /\bVISA\b|ВИЗА|\bENTRIES\b|INVITING\s+ORGANI[SZ]ATION|ШАҚЫРҒАН\s+МЕКЕМЕ|^V[A-Z<][A-Z<]{3}/mu;
const idTitle = (all) => (VISA_SIGNS.test(all) ? 'Visa' : /УДОСТОВЕРЕНИЕ\s+ЛИЧНОСТИ|ЖЕКЕ\s+КУӘЛІК|ID\s+CARD/iu.test(all) ? 'Identity card' : 'Passport');

// ------------------------------------------------------------------ dates and numbers
const MONTHS = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
  январ: 1, феврал: 2, март: 3, апрел: 4, мая: 5, май: 5, июн: 6, июл: 7, август: 8, сентябр: 9, октябр: 10, ноябр: 11, декабр: 12,
  қаңтар: 1, ақпан: 2, наурыз: 3, сәуір: 4, мамыр: 5, маусым: 6, шілде: 7, тамыз: 8, қыркүйек: 9, қазан: 10, қараша: 11, желтоқсан: 12,
};
const monthOf = (w) => { const s = w.toLowerCase(); const k = Object.keys(MONTHS).find((m) => s.startsWith(m)); return k ? MONTHS[k] : 0; };
const MW = '([A-Za-zА-Яа-яӘәҒғҚқҢңӨөҰұҮүҺһІі]{3,10})\\.?';
const DATE_RES = [
  [/(\d{1,2})[./](\d{1,2})[./](\d{4})/g, (m) => [m[3], m[2], m[1]]],
  [/(\d{4})-(\d{2})-(\d{2})/g, (m) => [m[1], m[2], m[3]]],
  [new RegExp(`${MW}\\s+(\\d{1,2}),?\\s+(\\d{4})`, 'g'), (m) => [m[3], monthOf(m[1]), m[2]]],
  [new RegExp(`(\\d{1,2})\\s+${MW}\\s+(\\d{4})`, 'g'), (m) => [m[3], monthOf(m[2]), m[1]]],
  [new RegExp(`(\\d{4})\\s*ж(?:ылғы|\\.)?\\s*(\\d{1,2})\\s+${MW}`, 'g'), (m) => [m[1], monthOf(m[3]), m[2]]],
  [new RegExp(`${MW}\\s+(\\d{4})`, 'g'), (m) => [m[2], monthOf(m[1]), 0]],
];
const pad = (n) => String(n).padStart(2, '0');

// dates written in words on diplomas: "on the twenty third day of June, of the year two thousand and eleven"
const UNITS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen',
  'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen'];
const ORDS = ['first', 'second', 'third', 'fourth', 'fifth', 'sixth', 'seventh', 'eighth', 'ninth', 'tenth', 'eleventh', 'twelfth',
  'thirteenth', 'fourteenth', 'fifteenth', 'sixteenth', 'seventeenth', 'eighteenth', 'nineteenth'];
const TENS = { twenty: 20, twentieth: 20, thirty: 30, thirtieth: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 };
function wordNumber(s) {
  let n = 0;
  for (const w of s.toLowerCase().split(/[\s-]+/).filter((x) => x && x !== 'and')) {
    if (w in TENS) n += TENS[w];
    else if (ORDS.includes(w)) n += ORDS.indexOf(w) + 1;
    else if (UNITS.includes(w)) n += UNITS.indexOf(w);
    else return NaN;
  }
  return n;
}
function yearWords(s) {
  const t = s.toLowerCase().replace(/-/g, ' ').replace(/\s+/g, ' ').trim();
  let m = t.match(/^two thousand(?: and)?\s*(.*)$/);
  if (m) return 2000 + (m[1] ? wordNumber(m[1]) : 0);
  m = t.match(/^nineteen(?: hundred(?: and)?)? (.+)$/);
  return m ? 1900 + wordNumber(m[1]) : NaN;
}
const NUM_WORD = '(?:and|hundred|thousand|zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety)';
// between the words OCR may leave line breaks and stray quotes ("June,\n" of the year"); "year" may come out as noise
const GAP = '[\\s"\'“”.,:;-]+';
const WORD_DATE = new RegExp(`((?:(?:twenty|thirty)[\\s-]+)?(?:${ORDS.join('|')}|twentieth|thirtieth))${GAP}day${GAP}of${GAP}([A-Za-z]{3,9})${GAP}(?:in${GAP})?(?:of${GAP})?(?:the${GAP})?(?:\\S{2,6}${GAP})?((?:two\\s+thousand|nineteen)(?:[\\s-]+${NUM_WORD})*)`, 'gi');

function datesOf(text) {
  const now = new Date().getFullYear();
  const out = [];
  for (const m of text.matchAll(WORD_DATE)) {
    const d = wordNumber(m[1]);
    const mo = monthOf(m[2]);
    const y = yearWords(m[3]);
    if (d >= 1 && d <= 31 && mo && y >= 1950 && y <= now) {
      out.push({ value: `${y}-${pad(mo)}-${pad(d)}`, at: m.index, end: m.index + m[0].length, expiry: false, issue: true });
    }
  }
  for (const [re, f] of DATE_RES) {
    for (const m of text.matchAll(re)) {
      const [y, mo, d] = f(m).map(Number);
      if (y < 1970 || y > now + 15 || !(mo >= 1 && mo <= 12) || d > 31 || out.some((x) => x.at <= m.index && m.index < x.end)) continue;
      const before = text.slice(Math.max(0, m.index - 40), m.index);
      out.push({ value: d ? `${y}-${pad(mo)}-${pad(d)}` : `${y}-${pad(mo)}`, at: m.index, end: m.index + m[0].length,
        expiry: /(?:valid\s+(?:until|through|thru)|expir\p{L}*|действител\p{L}*\s+до|срок\s+действия|жарамды)[^\n]*$/iu.test(before),
        issue: /(?:дата\s+выдачи|date\s+of\s+issue|issued(?:\s+on)?|certification\s+date|берілген\s+күні)\s*:?\s*$/iu.test(before) });
    }
  }
  if (!out.length) {
    const y = [...text.matchAll(/(?<!\d)(19[89]\d|20\d\d)(?!\d)/g)].map((m) => Number(m[1])).filter((n) => n <= now);
    if (y.length) out.push({ value: String(Math.max(...y)), at: 0, end: 0, expiry: false });
  }
  return out.sort((a, b) => a.at - b.at);
}

// "Credential ID 2318841", "Serial No. 5/2/4/218.2011", "№ 0123456"; the number has a digit ("Nov 2021" is no number).
// A labelled number (serial, certificate, registration…) beats the numbers of legalisation stamps.
const NUMBER = '((?:[A-ZА-ЯӘҒҚҢӨҰҮҺІ]{1,4}(?:-[A-ZА-ЯӘҒҚҢӨҰҮҺІ]{1,3})?[-\\s]?)?\\d[\\dA-Z/.\\-]{3,30})';
const LABELLED_NUMBER = new RegExp(`(?:serial|diploma|certificate|certification|credential|registration|licen[cs]e|диплом\\p{L}*|сертификат\\p{L}*|удостоверени\\p{L}*|регистрационн\\p{L}*|тіркеу)\\s*(?:№|No\\.?|Number|ID|#)?\\s*[:.]?\\s*${NUMBER}`, 'iu');
const ANY_NUMBER = new RegExp(`(?:\\b(?:ID|No|Number)\\b\\.?|№|#)\\s*[:.]?\\s*${NUMBER}`, 'iu');
function numberOf(text) {
  const m = text.match(LABELLED_NUMBER) || text.match(ANY_NUMBER);
  return m ? m[1].trim().replace(/[./-]+$/, '') : null;
}

// a diploma says so, or names the degree it confers ("confers upon … the degree Bachelor of Science")
const DIPLOMA = /диплом|diploma|the\s+degree|degree\s+of\s+(?:bachelor|master|doctor)|bachelor\s+of|master\s+of|confers?\s+upon|академическ\p{L}*\s+степен|присуждена\s+(?:академическая\s+)?степень|дәрежесі\s+берілді/iu;
// the degree conferred: next to "the degree" / "степень", else anywhere in the text
function degreeNear(all) {
  const m = all.match(/(?:the\s+degree|degree\s+of|степен\p{L}*|квалификаци\p{L}*|дәреже\p{L}*)[^\n]*\n?[^\n]*/iu);
  return (m && degreeOf({ institution: m[0] })) || degreeOf({ institution: all }) || null;
}

// ------------------------------------------------------------------ the document and its holder
// candidates: [{id, name}]; the result names the holder's candidate only when exactly one fits best.
export function readDocument(text, candidates = []) {
  const ls = lines(String(text || '').replace(/[ﬀ-ﬆ]/g, (c) => c.normalize('NFKC'))); // OCR ligatures: ﬂ → fl
  const all = ls.join('\n');
  if (ID_PAPER.test(all)) {
    // dates of a visa: issued the earliest, valid until the latest
    const ds = datesOf(all).map((d) => d.value).sort();
    const info = { kind: 'id', holder: null, title: idTitle(all), issuer: null, date: ds[0] || null, expires: ds.length > 1 ? ds[ds.length - 1] : null, number: null };
    info.key = `i:${info.title.toLowerCase()}`; // a new visa replaces the old one
    return { info, ...whose(null, ls, candidates) };
  }
  const kind = DIPLOMA.test(all) && !/^(?:certificate|сертификат)/i.test(ls[0] || '') ? 'diploma' : 'certificate';
  const dates = datesOf(all);
  const issued = dates.find((d) => d.issue) || dates.find((d) => !d.expiry); // "Дата выдачи" beats the commission's date
  const info = {
    kind,
    holder: holderOf(ls),
    title: kind === 'certificate' ? titleOf(ls, all) : null,
    issuer: kind === 'certificate' ? issuerOf(ls, all) : institutionOf(ls) || issuerOf(ls, all),
    date: issued?.value || null,
    expires: dates.find((d) => d.expiry)?.value || null,
    number: numberOf(all),
  };
  if (kind === 'diploma') {
    info.area = areaOf(all);
    info.degree = degreeNear(all);
    info.institution = info.issuer;
  }
  info.key = docKey(info);
  return { info, ...whose(info.holder, ls, candidates) };
}

// Two documents of one candidate with the same key are copies of one paper: the newer one replaces the older.
// No title (or no institution) - no key: such documents never replace anything.
function docKey(info) {
  if (info.kind === 'diploma') return info.institution ? `d:${info.degree || ''}:${fold(info.institution).slice(0, 60)}` : null;
  return info.title ? `c:${fold(canonCert(info.title) || info.title)}` : null;
}

// ------------------------------------------------------------------ the same person uploaded again
const emailOf = (s) => String(s || '').trim().toLowerCase() || null;
const phoneOf = (s) => { const d = String(s || '').replace(/\D/g, ''); return d.length >= 10 ? d.slice(-10) : null; };

// The candidate a newly parsed CV belongs to: the same e-mail or phone, else the whole same name (a patronymic only
// one of them has is fine, a different one is not) of exactly one candidate, unless every contact both have differs.
// candidates: [{id, name, email, phone}]
export function samePerson(profile, candidates) {
  const b = profile?.basics || {};
  const email = emailOf(b.email);
  const phone = phoneOf(b.phone);
  const cs = candidates.map((c) => ({ ...c, email: emailOf(c.email), phone: phoneOf(c.phone) }));
  const byContact = cs.find((c) => (email && c.email === email) || (phone && c.phone === phone));
  if (byContact) return { id: byContact.id, by: 'contact' };
  const own = tokens(b.name);
  if (own.length < 2) return null;
  const differs = (c) => {
    const pairs = [[email, c.email], [phone, c.phone]].filter(([x, y]) => x && y);
    return pairs.length > 0 && pairs.every(([x, y]) => x !== y);
  };
  const scored = rank([own], cs.filter((c) => !differs(c)));
  const top = scored[0];
  const whole = top && top.hits >= 2 && top.hits >= Math.min(own.length, top.of);
  return whole && (scored.length === 1 || scored[1].hits < top.hits) ? { id: top.id, by: 'name' } : null;
}

// Candidates named by the texts, most name words first (one word is only a hint: "Smagulova V.").
function rank(texts, candidates) {
  return candidates
    .map((c) => {
      const cand = tokens(c.name);
      const hits = cand.length >= 2 ? Math.max(0, ...texts.map((w) => nameHits(cand, w))) : 0;
      return { id: c.id, hits, of: cand.length };
    })
    .filter((x) => x.hits >= 1)
    .sort((a, b) => b.hits - a.hits || a.of - b.of);
}

// The holder's candidate: by the holder's name when it was found, else by any line naming a candidate. Sure only when
// two name words at least (surname and first name) fit and one candidate fits best ("Ахметову Арману Болатовичу" picks
// Ахметов Арман Болатович over Ахметов Арман Серикович).
export function whose(holder, ls, candidates) {
  const strong = (list) => list.some((x) => x.hits >= 2);
  let by = 'holder';
  let scored = holder ? rank([tokens(holder)], candidates) : [];
  if (!strong(scored)) {
    const byText = rank(ls.flatMap((l, i) => [tokens(l), tokens(`${l} ${ls[i + 1] || ''}`)]), candidates);
    if (strong(byText) || !scored.length) { by = 'text'; scored = byText; }
  }
  const top = scored[0];
  const sure = top?.hits >= 2 && (scored.length === 1 || scored[1].hits < top.hits);
  return { match: sure ? { id: top.id, by } : null, suggestions: scored.slice(0, 5).map(({ id, hits }) => ({ id, hits })) };
}

// ------------------------------------------------------------------ the profile
const fold = (s) => String(s || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
const year = (d) => (d ? String(d).slice(0, 4) : null);

// one certification under two names: "ISTQB Foundation Level" in the CV, "ISTQB Certified Tester Foundation Level" on paper
const canonCert = (s) => CERTS.find(([, re]) => re.test(s))?.[0] || null;
function sameCert(a, b) {
  const x = fold(a);
  const y = fold(b);
  if (!x || !y) return false;
  if (canonCert(a) && canonCert(a) === canonCert(b)) return true;
  const abbr = (s) => [...String(s).matchAll(/\(([^)]+)\)/g)].map((m) => fold(m[1]));
  return x === y || x.includes(y) || y.includes(x) || abbr(a).includes(y) || abbr(b).includes(x) || abbr(a).some((k) => abbr(b).includes(k));
}

// Marks the profile entries confirmed by the documents (adding the ones the CV does not list) and drops the marks and
// the entries of documents that are no longer attached. docs: [{id, kind, title, issuer, date, institution, area, degree}]
export function applyDocuments(profile, docs) {
  const p = structuredClone(profile && typeof profile === 'object' ? profile : {});
  const ids = new Set(docs.map((d) => d.id));
  const keep = (x) => !(x.fromDoc && !ids.has(x.doc));
  const unmark = (x) => { if (x.doc && !ids.has(x.doc)) { delete x.doc; delete x.fromDoc; } return x; };
  p.certificates = (p.certificates || []).filter(keep).map(unmark);
  p.education = (p.education || []).filter(keep).map(unmark);
  // an entry already confirmed by another document (two copies of one certificate) stays as it is
  const mine = (x, d) => !x.doc || x.doc === d.id;
  for (const d of docs) {
    if (d.kind === 'diploma') {
      const inst = d.institution || d.issuer;
      const e = p.education.find((x) => x.doc === d.id) || p.education.find((x) => inst && (sameCert(x.institution, inst) || (d.degree && x.degree === d.degree && year(x.endDate) === year(d.date))));
      if (!e) p.education.push({ institution: inst || '—', area: d.area || null, endDate: year(d.date), degree: DEGREES.includes(d.degree) ? d.degree : null, doc: d.id, fromDoc: true });
      else if (mine(e, d)) Object.assign(e, { doc: d.id, area: e.area || d.area || null, degree: e.degree || d.degree || null, endDate: e.endDate || year(d.date) });
    } else if (d.kind === 'certificate') { // identity papers stay files only
      const name = d.title || d.issuer;
      if (!name) continue;
      const c = p.certificates.find((x) => x.doc === d.id) || p.certificates.find((x) => sameCert(x.name, name));
      if (!c) p.certificates.push({ name, date: year(d.date), issuer: d.issuer || null, doc: d.id, fromDoc: true });
      else if (mine(c, d)) Object.assign(c, { doc: d.id, issuer: c.issuer || d.issuer || null, date: c.date || year(d.date) });
    }
  }
  return p; // only certificates and education change: nothing derived from them needs recomputing
}
