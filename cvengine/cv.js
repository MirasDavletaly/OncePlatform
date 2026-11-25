// OncePlatform CV engine: the rules engine of the CV matching demo (T-2026-0068: parse.js, skills.js, gen.js; the
// OncePlatform additions in parse.js are marked) plus projects, places of work, education level, suggested positions
// and matching of candidates against the key-personnel roles of a tender.
// Runs on the server only (node cli.mjs), so CVs and profiles never leave it.
import { FAMILY, LEVEL_RANK, fold, headingOf, nearProf, normTitle, parseResume, relevantMonths, sameProf, totalMonths } from './parse.js';
import { SKILL_DICT, buildMatcher } from './skills.js';
import { PROFS } from './gen.js';
import { CITIES, COUNTRIES, cityId, geoMeta, locate } from './geo.js';

const matcher = buildMatcher(SKILL_DICT);
const protect = new Set(Object.entries(SKILL_DICT).flatMap(([k, v]) => [k, ...v.syn]).map((s) => s.toLowerCase()));
const skillByName = new Map(Object.entries(SKILL_DICT).flatMap(([k, v]) => [k, ...v.syn].map((s) => [s.toLowerCase(), k])));

export const LANGUAGES = ['kk', 'ru', 'en', 'de', 'tr', 'ko', 'uz', 'zh', 'fr'];
export const LEVELS = ['A1', 'A2', 'B1', 'B2', 'C1', 'C2', 'fluent', 'native'];
const YM = /^\d{4}-(0[1-9]|1[0-2])$/;

// A skill written by a person (requirement or manual edit) in the dictionary's canonical form, or null when the
// dictionary does not know it.
export function canonSkill(raw) {
  const s = String(raw ?? '').trim();
  if (!s) return null;
  const direct = skillByName.get(s.toLowerCase());
  if (direct) return direct;
  const found = [...matcher(s)];
  return found.length === 1 ? found[0] : null;
}

// Personal data that must never be scored or stored (birth date, gender, marital status, nationality):
// only the fact that it was present is kept.
function stripSensitive(p) {
  p.meta.sensitiveDetected = Object.keys(p.meta.sensitive || {});
  delete p.meta.sensitive;
  return p;
}

// ------------------------------------------------------------------ education level, positions, countries
// secondary: school; higher: "Высшее" without the degree
export const DEGREES = ['secondary', 'college', 'higher', 'bachelor', 'specialist', 'master', 'mba', 'phd'];
const DEGREE_RE = [
  ['phd', /(?<![\p{L}])(?:phd|ph\.d|кандидат\s+\p{L}+\s+наук|доктор\s+\p{L}+\s+наук|доктор\s+философии|докторантура|ғылым\s+кандидаты)/iu],
  ['mba', /(?<![\p{L}])e?mba(?![\p{L}])/iu],
  ['master', /(?<![\p{L}])(?:магистр\p{L}*|магистратура|master'?s?|m\.?sc|msc)(?![\p{L}])/iu],
  ['bachelor', /(?<![\p{L}])(?:бакалавр\p{L}*|bachelor'?s?|b\.?sc|bsc)(?![\p{L}])/iu],
  ['specialist', /(?<![\p{L}])(?:специалист|специалитет|инженер\p{L}*|дипломированный)(?![\p{L}])/iu],
  ['college', /(?<![\p{L}])(?:колледж\p{L}*|техникум\p{L}*|college)(?![\p{L}])/iu],
];
export const degreeOf = (e) => DEGREE_RE.find(([, re]) => re.test(`${e.institution || ''} ${e.area || ''}`))?.[0] || null;

const r1 = (x) => Math.round(x * 10) / 10;
const levelOf = (years) => (years >= 5 ? 'senior' : years >= 2 ? 'middle' : 'junior');
const workPeriods = (p) => (p.work || []).map((w) => ({ start: w.startDate, end: w.endDate, prof: w.prof, approx: !!w.approx }));

// Positions the candidate could take (up to four): professions of the (IT) taxonomy backed by real experience in them
// or by most of their skills, then the job titles the candidate actually held, with the years in each - the only
// suggestion for professions outside the taxonomy (an asset data engineer is not a "data analyst").
export function positions(p) {
  const work = workPeriods(p);
  const has = new Set((p.skills || []).map((s) => s.name));
  const tax = Object.entries(PROFS)
    .map(([id, P]) => {
      const months = relevantMonths(work, id, 0.5);
      const exact = totalMonths(work.filter((w) => !w.approx && sameProf(w.prof, id)));
      const skill = (P.core.filter((x) => has.has(x)).length * 2 + P.extra.filter((x) => has.has(x)).length) / (P.core.length * 2 + P.extra.length);
      return { prof: id, years: r1(months / 12), skillMatch: Math.round(skill * 100) / 100, exact, score: Math.min(1, months / 60) * 0.6 + skill * 0.4 };
    })
    .filter((x) => x.exact >= 6 || x.skillMatch >= 0.4 || (x.years >= 0.5 && x.skillMatch >= 0.25))
    .sort((a, b) => b.score - a.score)
    .slice(0, 3)
    .map(({ score, exact, ...x }) => ({ ...x, level: levelOf(x.years) }));
  const held = new Map();
  for (const w of p.work || []) {
    const title = String(w.position || '').trim();
    if (!title || title.length > 80 || tax.some((x) => x.prof === w.prof)) continue;
    const key = fold(title);
    if (!held.has(key)) held.set(key, { title, periods: [] });
    held.get(key).periods.push({ start: w.startDate, end: w.endDate });
  }
  const own = [...held.values()]
    .map(({ title, periods }) => ({ title, years: r1(totalMonths(periods) / 12) }))
    .sort((a, b) => b.years - a.years)
    .map((x) => ({ ...x, level: levelOf(x.years) }));
  return [...tax, ...own].slice(0, 4);
}

// Years of experience per country of work (overlapping jobs counted once).
function countries(p) {
  const by = {};
  for (const w of p.work || []) if (w.location?.country) (by[w.location.country] ||= []).push({ start: w.startDate, end: w.endDate });
  return Object.entries(by).map(([country, periods]) => ({ country, years: r1(totalMonths(periods) / 12) })).sort((a, b) => b.years - a.years);
}

function cleanLocation(l) {
  if (!l || typeof l !== 'object') return null;
  const city = l.city ? String(l.city).trim().slice(0, 80) : null;
  const id = city ? cityId(city) : null;
  if (id) return { country: CITIES[id].country, city: id };
  const country = COUNTRIES[l.country] ? l.country : null;
  return country || city ? { country, city, ...(l.inferred && !city ? { inferred: true } : {}) } : null;
}

// Fields derived from the rest of the profile.
function enrich(p) {
  const home = locate([p.basics?.location?.city]);
  if (p.basics?.location) p.basics.location.country = home?.country || null;
  for (const e of p.education || []) if (!DEGREES.includes(e.degree)) e.degree = degreeOf(e);
  // years with one decimal, like the years per country (13.7 in Kazakhstan next to 13.5 in total looked wrong)
  if (typeof p.meta.totalMonths === 'number') p.meta.totalYears = r1(p.meta.totalMonths / 12);
  p.meta.countries = countries(p);
  p.meta.positions = positions(p);
  return p;
}

// A raw skill from the CV in the dictionary's form when it is the same skill ("MS Excel" → Excel), else as written.
function rawSkill(s) {
  const direct = skillByName.get(s.toLowerCase());
  if (direct) return direct;
  const found = [...matcher(s)];
  return found.length === 1 && s.split(/\s+/).length <= 2 && fold(s).includes(fold(found[0])) ? found[0] : s;
}

const isPlace = (s) => { const l = locate([s]); return !!l && !l.inferred && fold(s).split(/\s+/).length <= 3; };
const INSTITUTION = /universit|университет|institut|институт|academy|академ|college|колледж|school|школ|lyceum|лице/iu;

// ------------------------------------------------------------------ layouts the generic parser misreads (seen on real CVs)
const LEGAL_FORMS = '(?:ТОО|АО|ООО|НАО|ИП|ГККП|КГП|ГКП|РГП|РГКП|КГУ|ГУ|LLP|LLC|Ltd\\.?|Inc\\.?|GmbH|JSC|PJSC|PLC|Co\\.)';
const LEGAL = new RegExp(`(?:^|[\\s«"“(])${LEGAL_FORMS}(?=$|[\\s»"”),.])`, 'u');
const LEGAL_ONLY = new RegExp(`^${LEGAL_FORMS}$`, 'u');
const ORG_END = /(?:Group|Holding|Company|Corporation|Corp\.?|Industries|Industrial Park|Bank|Банк|Холдинг|Корпорация|Завод|Комбинат)\s*$/iu;
const FIELD_END = /(?:field|месторождени\p{L}*|кен\s+орны)\s*$/iu;
const TITLE_WORD = /engineer|manager|specialist|technician|operator|director|lead|head|analyst|developer|coordinator|supervisor|foreman|inspector|consultant|officer|assistant|electrician|mechanic|welder|fitter|driver|accountant|economist|lawyer|teacher|lecturer|designer|architect|administrator|advis[eo]r|planner|controller|superintendent|scheduler|estimator|surveyor|draftsman|rigger|scaffolder|painter|technologist|executive|programmer|tester|инженер|менеджер|специалист|техник|оператор|директор|руководител|начальник|аналитик|разработчик|координатор|мастер|прораб|инспектор|консультант|ассистент|электрик|электромонт|слесар|сварщик|монтажник|водител|бухгалтер|экономист|юрист|преподавател|учител|дизайнер|архитектор|администратор|геодезист|сметчик|технолог|маман|басшы/iu;
const isCompany = (s) => !!s && (LEGAL.test(s) || ORG_END.test(s) || FIELD_END.test(s));
const isTitle = (s) => !!s && TITLE_WORD.test(s);
// "• Maintained transformer power supply systems." is a duty, not a job title
const isDuty = (s) => /^[•▪●·*\-–—]/.test(s) || (s.split(/\s+/).length >= 7 && /[.;]$/.test(s));

// The company in the place of the job title ("ТОО «Альфа»", "Sicim - Karachaganak field"), duties as titles, and the
// education the parser took for jobs ("KAZIITU University, Uralsk 2021-2025") - the last one inflated the experience.
// "ЗКО, Аксай": a region and a city in the place of the job title
const REGION = /^(?:[ЗСВЮ]КО|[NSEW]KO|.+\sобл(?:асть|\.)?|.+\sregion|.+\sоблысы)$/iu;

export function fixJobs(p) {
  const work = [];
  for (const w of p.work) {
    const before = w.position;
    // "• Universal Sodexho – Angola : Offshore Camp Manager." - the company and the title behind a bullet
    const bullet = /^[•▪●·*]\s*(.+)$/u.exec(w.position || '');
    if (bullet) {
      const [left, right] = bullet[1].split(/\s+:\s*|:\s+/u);
      const title = right && right.replace(/[.\s]+$/u, '').trim();
      if (title && isTitle(title)) [w.position, w.name] = [title.slice(0, 120), w.name || left.split(/\s+[–—-]\s+/u)[0].trim() || null];
    }
    if (w.position && isDuty(w.position)) w.position = null;
    const parts = (w.position || '').split(/\s*,\s*/);
    if (w.position && parts.length <= 3 && parts.some((x) => REGION.test(x)) && parts.every((x) => REGION.test(x) || isPlace(x) || /^\p{Lu}[\p{Ll}-]+$/u.test(x))) {
      w.location ||= locate([w.position]);
      w.position = null;
    }
    // "Топан" + "ТОО": the company split in two
    if (w.position && LEGAL_ONLY.test((w.name || '').trim())) [w.position, w.name] = [null, `${w.name} «${w.position}»`];
    if (w.position && isCompany(w.position) && !isCompany(w.name)) {
      // "Facilities Manager, Alpha Company": the title and the company in one line - split, keep the title
      const split = isTitle(w.position) && w.position.split(/\s*(?:,|\s[–—-]\s|\sat\s|\s\|\s|@)\s*/u);
      const title = split && split.find((x) => isTitle(x) && !isCompany(x));
      if (title) [w.position, w.name] = [title, w.name || split.filter((x) => x !== title).join(', ') || null];
      else if (isTitle(w.position)) { /* a title that merely ends like a company name: leave it */ }
      else if (isTitle(w.name)) [w.position, w.name] = [w.name, w.position];
      else [w.position, w.name] = [null, w.name ? `${w.position}, ${w.name}` : w.position];
    }
    // "KAZIITU University" | "Uralsk", 2021-2025: a school in the place of the title next to a place (a school with no
    // title and nothing else may as well be an employer)
    const nextToPlace = !!w.name && (isPlace(w.name) || /village|city|город|ауыл|село|^\p{Lu}[\p{Ll}-]+$/iu.test(w.name));
    if (w.position && INSTITUTION.test(w.position) && !isTitle(w.position) && !isTitle(w.name) && nextToPlace) {
      p.education.push({ institution: w.position, area: null, endDate: (w.endDate || w.startDate || '').slice(0, 4) || null });
      continue;
    }
    if (w.position !== before) {
      const nt = normTitle(w.position);
      Object.assign(w, { prof: nt?.approx ? null : nt?.prof || null, sen: nt?.sen ?? null });
    }
    work.push(w);
  }
  if (work.length !== p.work.length) {
    p.work = work;
    p.meta.totalMonths = totalMonths(work.map((w) => ({ start: w.startDate, end: w.endDate })));
  }
}

// "Высшее", "Среднее специальное", "Higher" in the place of the institution: that is the level of education
const EDU_LEVELS = [
  ['college', /^(?:среднее[\s-]+(?:специальное|профессиональное|техническое)(?:\s+образование)?|техническое\s+и\s+профессиональное|vocational(?:\s+education)?|техникалық\s+және\s+кәсіптік|арнаулы\s+орта)$/iu],
  ['secondary', /^(?:среднее(?:\s+(?:общее|полное))?(?:\s+образование)?|общее\s+среднее|secondary(?:\s+(?:education|school))?|high\s+school|орта(?:\s+білім)?)$/iu],
  ['higher', /^(?:(?:неполное\s+)?высшее(?:\s+(?:образование|профессиональное|техническое))?|higher(?:\s+education)?|university\s+degree|жоғары(?:\s+білім)?)$/iu],
];
const eduLevelOf = (s) => {
  const t = String(s || '').slice(0, 300).replace(/\([^()]*\)/g, '').replace(/[.,:;\s]+$/, '').trim();
  return EDU_LEVELS.find(([, re]) => re.test(t))?.[0] || null;
};
const SPECIALTY = /[.,;]\s*(?:specialty|speciality|major|faculty|специальность|факультет|мамандығы)\s*:?\s*/iu;
export function fixEducation(p) {
  for (const e of p.education) {
    // "2016. West Kazakhstan University. Specialty: Accounting"
    const year = String(e.institution || '').match(/^((?:19|20)\d{2})\s*[.,:–—-]\s*/);
    if (year) [e.institution, e.endDate] = [e.institution.slice(year[0].length), e.endDate || year[1]];
    const sp = String(e.institution || '').split(SPECIALTY);
    if (sp.length === 2 && sp[1]) [e.institution, e.area] = [sp[0].trim(), e.area || sp[1].replace(/[.\s]+$/, '').trim()];
    const level = eduLevelOf(e.institution);
    if (!level) continue;
    e.degree = degreeOf({ institution: e.area }) || level;
    if (e.area && INSTITUTION.test(e.area)) [e.institution, e.area] = [e.area, null];
    else e.institution = '';
  }
}

// Certificates: bullets and blank lines out; a year on its own line dates the certificates under it; a wrapped line
// (lower case) continues the previous one; "центр подготовки …" before a certificate is its issuer.
const PROVIDER = /центр\s+(?:подготовки|обучения|дополнительного)|учебн\p{L}*\s+центр|training\s+cent(?:er|re)/iu;
const CERT_WORD = /сертификат|certificate|certified|удостоверени|допуск|курс|course|паспорт|license|лицензи/iu;
// The job title line must be a job title: not a heading ("Resume", "Сводка навыков"), a date ("Ноябрь 2024 —"), an
// address ("Aksay city, Abay street, 12"), personal data ("Male, born on 3 March 1990") or the name itself
// ("JUAN P. DELA CRUZ JR.") - the title goes out anonymised, so these were leaks.
const NOT_A_TITLE = /^(?:resume|résumé|cv|curriculum\s+vitae|резюме|түйіндеме|сводка\s+навыков|summary\s+of\s+skills|personal\s+(?:information|details))$/iu;
const PERSONAL = /born|birth|рожд|туған|\bmale\b|\bfemale\b|мужской|женский|gender|nationality|married|single|@|\d{7,}/iu;
// (?<!\p{L}) instead of \b: \b does not see Cyrillic letters
const ADDRESS = /street|\bst\.|avenue|\bave\.|улица|(?<!\p{L})ул\.|проспект|(?<!\p{L})пр-т|көшесі|микрорайон|(?<!\p{L})мкр|apartment|(?<!\p{L})кв\.|(?<!\p{L})г\.\s*\p{Lu}|\bcity\b|\bregion\b|област|облысы|(?<!\p{L})обл(?:\.|(?!\p{L}))|(?<!\p{L})р-н(?!\p{L})|район|ауданы/iu;
const DATE_LINE = /^(?:\p{L}+\.?\s+)?(?:19|20)\d{2}\s*(?:[-–—]\s*(?:\p{L}+\.?\s+)?(?:(?:19|20)\d{2}|present|по\s+н\.?\s*в\.?|по\s+настоящее\s+время)?)?$/iu;
// "Position Applied: Millwright Fitter", "Objective: Hydrotest Operator" → the title itself
export const cleanLabel = (s) => (s ? String(s).replace(/^(?:position\s+applied(?:\s+for)?|applied\s+position|objective|desired\s+position|position|желаемая\s+должность|должность|позиция|лауазымы)\s*[:\-–]\s*/iu, '').trim() || null : s);
export function badLabel(label, name) {
  const s = String(label || '').trim();
  if ((s.match(/\p{L}/gu) || []).length < 3) return true;
  if (/[.!?]$/.test(s) && s.split(/\s+/).length > 6) return true; // a sentence is no job title
  if (headingOf(s) || NOT_A_TITLE.test(s) || PERSONAL.test(s) || DATE_LINE.test(s)) return true;
  if (ADDRESS.test(s) && (!isTitle(s) || /\d/.test(s))) return true; // "City Planner" is a title, "Abay street, 12" is not
  const parts = s.split(/\s*,\s*/);
  const place = (x) => isPlace(x) || REGION.test(x);
  if (parts.every(place) || (parts.length <= 3 && parts.some(place) && parts.every((x) => place(x) || /^\p{Lu}[\p{Ll}-]+$/u.test(x)))) return true;
  if (name && fold(s).includes(fold(name))) return true;
  // a name in capitals with an initial or a suffix: "JUAN P. DELA CRUZ JR."
  return !isTitle(s) && s === s.toUpperCase() && /(?:^|\s)\p{Lu}\.(?:\s|$)|\s(?:JR|SR|II|III)\.?$/u.test(s);
}

const count = (s, re) => (s.match(re) || []).length;
const openQuote = (s) => count(s, /«/g) > count(s, /»/g) || count(s, /“/g) > count(s, /”/g) || count(s, /"/g) % 2 === 1;
export function fixCertificates(p) {
  const out = [];
  let year = null;
  let block = 0;
  let issuer = null;
  let last = ''; // the last line as written: a long one, or one cut off after "в", "and", a comma or an open quote, goes on
  for (const c of p.certificates) {
    const name = String(c.name || '').replace(/^[•▪●·*\-–—\s]+/u, '').trim();
    if (!/\p{L}{2}/u.test(name)) {
      if (/^(?:19|20)\d{2}$/.test(name)) [year, block, issuer] = [name, out.length, null];
      continue;
    }
    const prev = out.length > block ? out[out.length - 1] : null;
    const unfinished = prev && (last.length >= 60 || openQuote(prev.name) || /(?:\s(?:в|и|по|на|с|к|для|of|and|in|for|the|&)|[,(-])$/iu.test(last));
    last = name;
    if (unfinished && /^\p{Ll}/u.test(name)) { prev.name = `${prev.name} ${name}`.slice(0, 240); continue; }
    if (PROVIDER.test(name) && !CERT_WORD.test(name)) { issuer = name; continue; }
    out.push({ ...c, name: name.slice(0, 240), date: c.date || year, ...(issuer ? { issuer } : {}) });
  }
  p.certificates = out;
}

// Some PDFs come out one word per line (every word its own text object): the parser then sees no dates and no
// titles. Such text is put back into lines: a new line before a heading, a date or a bullet, and after a full stop.
const DATE_W = '(?:\\d{1,2}[./])?(?:19|20)\\d{2}';
const PERIOD_ONLY = new RegExp(`^${DATE_W}\\s*[-–—]\\s*(?:${DATE_W}|по\\s+настоящее\\s+время|по\\s+н\\.?\\s*в\\.?|present|now|қазіргі\\s+уақытқа\\s+дейін)$`, 'iu');
export function unfragment(text) {
  const ls = text.split('\n').map((l) => l.trim()).filter(Boolean);
  if (ls.length < 20 || ls.filter((l) => !/\s/.test(l)).length / ls.length < 0.6) return text;
  const out = [];
  let cur = '';
  const flush = () => { if (cur) out.push(cur); cur = ''; };
  for (const l of ls) {
    if (headingOf(l)) { flush(); out.push(l); continue; }
    const startsDate = new RegExp(`^${DATE_W}(?!\\d)`).test(l) && !/[-–—]\s*$/.test(cur);
    if (startsDate || /^[•▪●·*]/u.test(l) || /[.;!?:]$/.test(cur) || PERIOD_ONLY.test(cur)) flush();
    cur = cur ? `${cur} ${l}` : l;
  }
  flush();
  // such text also glues years to words and to each other: "»2015г", "с20152016" → "» 2015 г", "с 2015 - 2016"
  return out.map((l) => l
    .replace(/(?<!\d)((?:19|20)\d{2})((?:19|20)\d{2})(?!\d)/g, '$1 - $2')
    .replace(/(?<=[\p{L}»"”)])((?:19|20)\d{2})(?!\d)/gu, ' $1')
    .replace(/(?<!\d)((?:19|20)\d{2})(?=\p{L})/gu, '$1 ')).join('\n');
}

// "2019-2023 - Alpha LLP - Pipe Fitter": a job on one line under the experience heading, the layout the parser does not
// know; used when it found no job at all.
const ONE_LINE_JOB = /^((?:\d{1,2}[./])?(?:19|20)\d{2})\s*(?:[-–—]|to|по|до)\s*((?:\d{1,2}[./])?(?:19|20)\d{2}|present|now|current|по\s+н\.?\s*в\.?|по\s+настоящее\s+время|настоящее\s+время|қазіргі\s+уақытқа\s+дейін)?\s*(?:[-–—:|,]\s*)?(.*)$/iu;
const ym = (s, end) => {
  if (!s || !/\d/.test(s)) return null; // present
  const m = s.match(/^(?:(\d{1,2})[./])?((?:19|20)\d{2})$/);
  return m ? `${m[2]}-${String(m[1] || (end ? 12 : 1)).padStart(2, '0')}` : null;
};
export function oneLineJobs(text) {
  const ls = text.split('\n').map((l) => l.trim()).filter(Boolean);
  const start = ls.findIndex((l) => headingOf(l) === 'exp');
  const jobs = [];
  for (let i = start + 1; start >= 0 && i < ls.length; i += 1) {
    if (headingOf(ls[i])) break;
    const m = ONE_LINE_JOB.exec(ls[i]);
    if (!m) {
      const last = jobs[jobs.length - 1];
      if (last && !last.position && isTitle(ls[i]) && ls[i].split(/\s+/).length <= 6) last.position = ls[i];
      continue;
    }
    const parts = m[3].split(/\s+[-–—]\s+|\s*\|\s*/u).map((x) => x.trim()).filter(Boolean);
    const position = parts.find((x) => isTitle(x)) || null;
    jobs.push({ name: parts.filter((x) => x !== position).join(', ') || null, position, startDate: ym(m[1], false), endDate: ym(m[2], true), src: parts });
  }
  return jobs.filter((j) => j.startDate);
}

export function parse(text, ocr = false) {
  const src = unfragment(String(text || ''));
  const p = stripSensitive(parseResume(src, { matcher, protect, ocr }));
  // the one-line layout when the parser found no job, or jobs that are mostly broken (years in the title, no start)
  const alt = oneLineJobs(src);
  const broken = p.work.filter((w) => !w.startDate || /(?:19|20)\d{2}/.test(`${w.position || ''} ${w.name || ''}`)).length;
  if (alt.length && (!p.work.length || (alt.length >= p.work.length && broken * 2 >= p.work.length))) {
    p.work = alt.map((j) => {
      const nt = normTitle(j.position);
      return { ...j, prof: nt?.approx ? null : nt?.prof || null, sen: nt?.sen ?? null };
    });
    p.meta.totalMonths = totalMonths(p.work.map((w) => ({ start: w.startDate, end: w.endDate })));
  }
  for (const w of p.work) {
    w.location = locate(w.src || []);
    // a job title outside the IT dictionary ("Электромонтажник") went into the description: a short line with a
    // profession word and no full stop is the title
    if (!w.position) {
      const t = (w.src || []).map((l) => String(l).trim()).find((l) => isTitle(l) && l.split(/\s+/).length <= 6 && !/[.;:]$/.test(l) && !isCompany(l) && l !== w.name);
      if (t) {
        w.position = t;
        if (w.summary?.startsWith(t)) w.summary = w.summary.slice(t.length).trim() || undefined;
        const nt = normTitle(t);
        Object.assign(w, { prof: nt?.approx ? null : nt?.prof || null, sen: nt?.sen ?? null });
      }
    }
    delete w.src;
    // "Asset Data Specialist, Dubai, UAE" → "Asset Data Specialist"; a position that is only a city is no position
    const parts = String(w.position || '').split(/\s*,\s*/).filter(Boolean);
    while (parts.length && isPlace(parts[parts.length - 1])) parts.pop();
    if (parts.join(', ') !== (w.position || '')) {
      w.position = parts.join(', ') || null;
      const nt = normTitle(w.position);
      Object.assign(w, { prof: nt?.approx ? null : nt?.prof || null, sen: nt?.sen ?? null });
    }
  }
  fixJobs(p);
  fixEducation(p);
  fixCertificates(p);
  const label = cleanLabel(p.basics.label);
  if (badLabel(label, p.basics.name)) [p.basics.label, p.meta.title] = [null, null]; // the latest position takes its place below
  else if (label !== p.basics.label) {
    p.basics.label = label;
    const t = normTitle(label);
    p.meta.title = t?.approx ? nearProf(t, new Set(p.skills.map((s) => s.name))) : t;
  }
  // skills listed in the CV that the dictionary does not know (non-IT professions)
  const names = new Map(p.skills.map((s) => [s.name.toLowerCase(), s.name]));
  for (const raw of p.skillsRaw || []) {
    const s = rawSkill(raw);
    if (!names.has(s.toLowerCase()) && names.size < 80) names.set(s.toLowerCase(), s);
  }
  delete p.skillsRaw;
  p.skills = [...names.values()].sort((a, b) => a.localeCompare(b)).map((name) => ({ name }));
  // no job title in the header: the latest position
  if (!p.basics.label && p.work[0]?.position) {
    p.basics.label = p.work[0].position;
    const t = normTitle(p.basics.label);
    p.meta.title = t?.approx ? nearProf(t, new Set(names.values())) : t;
  }
  // "Bachelor of Science in Petroleum Engineering, Satbayev University" → institution, field of study
  for (const e of p.education) {
    if (degreeOf({ institution: e.institution }) && e.area && INSTITUTION.test(e.area) && !INSTITUTION.test(e.institution)) {
      [e.institution, e.area] = [e.area, e.institution];
    }
  }
  return enrich(p);
}

// Recomputes the derived fields after a manual edit: canonical skills, professions of the job titles,
// total experience.
export function refresh(p0) {
  const p = structuredClone(p0);
  p.basics = { name: null, label: null, email: null, phone: null, ...p.basics, location: { city: null, cityId: null, ...p.basics?.location } };
  p.meta = { warnings: [], ...p.meta };
  // doc: the attached diploma or certificate that confirms the entry (fromDoc: the entry exists only because of it)
  const docMark = (x) => (typeof x.doc === 'string' && x.doc ? { doc: x.doc.slice(0, 36), ...(x.fromDoc ? { fromDoc: true } : {}) } : {});
  // an entry may have only the level ("Высшее", 2012) when the CV names no institution
  p.education = (p.education || []).filter((e) => e && (String(e.institution || '').trim() || DEGREES.includes(e.degree)))
    .map((e) => ({ institution: e.institution || '', area: e.area || null, endDate: e.endDate || null, degree: DEGREES.includes(e.degree) ? e.degree : null, ...docMark(e) }));
  p.projects = (p.projects || []).filter((x) => x && String(x.name || '').trim()).slice(0, 50).map((x) => ({
    name: String(x.name).trim().slice(0, 200), role: x.role || null, customer: x.customer || null,
    startDate: YM.test(x.startDate || '') ? x.startDate : null, endDate: YM.test(x.endDate || '') ? x.endDate : null, summary: x.summary || undefined,
  }));
  p.languages = (p.languages || []).filter((l) => l && l.language);
  p.certificates = (p.certificates || []).filter((c) => c && String(c.name || '').trim())
    .map((c) => ({ name: c.name, date: c.date || null, ...(c.issuer ? { issuer: String(c.issuer).slice(0, 160) } : {}), ...docMark(c) }));
  const names = new Set();
  for (const s of p.skills || []) {
    const raw = String(s?.name ?? s ?? '').trim();
    if (raw) names.add(canonSkill(raw) || raw);
  }
  p.skills = [...names].sort().map((name) => ({ name }));
  const have = new Set(names);
  p.work = (p.work || []).map((w) => {
    const job = { name: w.name || null, position: w.position || null, startDate: YM.test(w.startDate || '') ? w.startDate : null,
      endDate: YM.test(w.endDate || '') ? w.endDate : null, summary: w.summary || undefined, location: cleanLocation(w.location) };
    const nt = normTitle(job.position);
    const r = nt?.approx ? nearProf(nt, have) : nt;
    Object.assign(job, { prof: r?.prof || null, sen: r?.sen ?? null });
    if (r?.approx) Object.assign(job, { approx: r.approx, why: { bySkills: r.bySkills, skills: r.skills } });
    return job;
  });
  const t = normTitle(p.basics.label);
  p.meta.title = t?.approx ? nearProf(t, have) : t;
  p.meta.totalMonths = totalMonths(p.work.map((w) => ({ start: w.startDate, end: w.endDate })));
  p.meta.totalYears = Math.round(p.meta.totalMonths / 6) / 2;
  return enrich(p);
}

// ------------------------------------------------------------------ matching against tender roles
// Weights of the criteria a role actually states; criteria the role does not mention do not count.
export const WEIGHTS = { must: 40, exp: 25, cert: 15, title: 10, lang: 5, nice: 5 };

const haystack = (p) => fold([p.basics?.label, p.basics?.summary, ...(p.skills || []).map((s) => s.name), ...(p.certificates || []).map((c) => c.name),
  ...(p.work || []).flatMap((w) => [w.position, w.summary]), ...(p.education || []).map((e) => e.area),
  ...(p.projects || []).flatMap((x) => [x.name, x.role, x.summary])].filter(Boolean).join('\n'));

function hasSkill(req, skills, hay) {
  const c = canonSkill(req);
  if (c) return skills.has(c);
  const f = fold(req);
  return f.length > 1 && hay.includes(f);
}

// "PMP" matches "Project Management Professional (PMP)" and the other way round; the CV text is the fallback.
function hasCert(req, certs, hay) {
  const f = fold(req);
  const abbr = [...String(req).matchAll(/\(([^)]+)\)/g)].map((m) => fold(m[1]));
  const keys = [f, ...abbr].filter((k) => k.length >= 2);
  for (const c of certs) {
    const fc = fold(c.name || '');
    const cAbbr = [...String(c.name || '').matchAll(/\(([^)]+)\)/g)].map((m) => fold(m[1]));
    if (keys.some((k) => fc.includes(k) || cAbbr.includes(k) || (fc.length >= 3 && k.includes(fc)))) return true;
  }
  return keys.some((k) => k.length >= 3 && hay.includes(k));
}

function langStatus(need, p) {
  const l = (p.languages || []).find((x) => x.language === need.language);
  let have = l?.fluency || null;
  let inferred = false;
  // a CV written in the language shows a working command of it even when the CV does not list it
  if (!have && p.meta?.lang === need.language) { have = 'fluent'; inferred = true; }
  const needRank = LEVEL_RANK[need.level] || 1;
  const haveRank = LEVEL_RANK[have] || 0;
  return { language: need.language, need: need.level || null, have, inferred, listed: !!l, ok: haveRank >= needRank };
}

export function scoreRole(role, p) {
  const skills = new Set((p.skills || []).map((s) => s.name));
  const hay = haystack(p);
  const must = role.skills_must || [];
  const nice = role.skills_nice || [];
  const certs = role.certificates || [];
  const langs = role.languages || [];
  const minYears = Number(role.min_years) || 0;
  const prof = PROFS[role.profession] ? role.profession : null;

  const mustMet = must.filter((s) => hasSkill(s, skills, hay));
  const niceMet = nice.filter((s) => hasSkill(s, skills, hay));
  const certMet = certs.filter((c) => hasCert(c, p.certificates || [], hay));
  const work = (p.work || []).map((w) => ({ start: w.startDate, end: w.endDate, prof: w.prof, approx: !!w.approx }));
  const total = (p.meta?.totalMonths ?? totalMonths(work)) / 12;
  const years = prof ? relevantMonths(work, prof, 0.5) / 12 : total;
  const tt = p.meta?.title?.prof ? p.meta.title : (p.work || []).find((w) => w.prof) || null;
  const tp = tt?.prof || null;
  const titleMatch = prof ? (sameProf(tp, prof) ? 1 : tp && FAMILY[tp] === FAMILY[prof] ? 0.5 : 0) * (tt?.approx ? 0.5 : 1) : null;
  const langRes = langs.map((l) => langStatus(l, p));

  const s = {};
  if (must.length) s.must = mustMet.length / must.length;
  if (nice.length) s.nice = niceMet.length / nice.length;
  if (certs.length) s.cert = certMet.length / certs.length;
  if (minYears > 0 || prof) {
    const base = Math.max(1, minYears);
    s.exp = Math.min(1, years / base) * 0.8 + Math.min(1, years / Math.max(2, base * 2)) * 0.2;
  }
  if (prof) s.title = titleMatch;
  if (langs.length) s.lang = langRes.reduce((a, r) => a + (r.ok ? 1 : r.listed && !r.have ? 0.5 : 0), 0) / langs.length;
  const parts = {};
  let got = 0;
  let max = 0;
  for (const [k, v] of Object.entries(s)) {
    parts[k] = Math.round(WEIGHTS[k] * v * 10) / 10;
    got += WEIGHTS[k] * v;
    max += WEIGHTS[k];
  }
  const score = max ? Math.round((got * 100) / max) : 0;

  // hard requirements: the candidate stays in the list, with the reason, below the eligible ones
  const fails = [];
  if (minYears > 0 && years + 1e-9 < minYears) fails.push('exp');
  if (certMet.length < certs.length) fails.push('cert');
  if (langRes.some((r) => !r.ok && r.have)) fails.push('lang');
  const r1 = (x) => Math.round(x * 10) / 10;
  return {
    score, parts, fails,
    why: {
      mustMet, mustMissing: must.filter((x) => !mustMet.includes(x)), niceMet, niceMissing: nice.filter((x) => !niceMet.includes(x)),
      certMet, certMissing: certs.filter((x) => !certMet.includes(x)), years: r1(years), totalYears: r1(total), minYears,
      profession: tp, titleMatch, titleApprox: !!tt?.approx, languages: langRes,
    },
  };
}

export function match(roles, candidates) {
  return (roles || []).map((role) => {
    const results = (candidates || []).filter((c) => c && c.profile).map((c) => ({ id: c.id, ...scoreRole(role, c.profile) }));
    results.sort((a, b) => (a.fails.length > 0) - (b.fails.length > 0) || b.score - a.score);
    return { results };
  });
}

export function meta() {
  return {
    professions: Object.entries(PROFS).map(([id, v]) => ({ id, en: v.t.en, ru: v.t.ru })),
    skills: Object.keys(SKILL_DICT).sort((a, b) => a.localeCompare(b)),
    languages: LANGUAGES,
    levels: LEVELS,
    degrees: DEGREES,
    ...geoMeta(),
  };
}
