// Разбор резюме в структурированный профиль (JSON Resume с расширениями), п. 4.1 ТЗ.
// Работает на тексте документа: текстовый слой PDF, текст DOCX или результат OCR скана/фото.
// Этапы: исправление типичных ошибок OCR → поиск разделов → контакты и заголовок → периоды работы →
// образование, языки, сертификаты → навыки по справочнику синонимов → стаж.
// Пол, дата рождения, семейное положение и фото распознаются только для того, чтобы исключить их из оценки.
import { CITIES, PROFS, ymToN } from './gen.js';

// текущий месяц по времени Астаны (UTC+5) на момент разбора: открытый период («по настоящее время», «н.в.», «present»)
// считается до него. Синтетический набор генератора построен от своего месяца (NOW_YM в gen.js), разбор от него не зависит.
export const nowYm = () => { const d = new Date(Date.now() + 5 * 3600000); return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`; };

// ------------------------------------------------------------------ строки и сравнение
const FOLD = { ә: 'а', ғ: 'г', қ: 'к', ң: 'н', ө: 'о', ұ: 'у', ү: 'у', һ: 'х', і: 'и', i: 'и', ё: 'е', й: 'и', щ: 'ш' };
export const fold = (s) => s.toLowerCase().replace(/[әғқңөұүһіiёйщ]/g, (c) => FOLD[c] || c).replace(/\s+/g, ' ').trim();
export function lev(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    const cur = [i];
    for (let j = 1; j <= b.length; j += 1) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[b.length];
}
export const sim = (a, b) => { const x = fold(a); const y = fold(b); const m = Math.max(x.length, y.length); return m ? 1 - lev(x, y) / m : 1; };

// ------------------------------------------------------------------ исправление ошибок OCR
// латинские и кириллические буквы одинакового начертания, цифры внутри слов (Т00 → ТОО, k8s не трогаем)
const LAT2CYR = { a: 'а', e: 'е', o: 'о', p: 'р', c: 'с', x: 'х', y: 'у', A: 'А', B: 'В', E: 'Е', K: 'К', M: 'М', H: 'Н', O: 'О', P: 'Р', C: 'С', T: 'Т', X: 'Х' };
const CYR2LAT = Object.fromEntries(Object.entries(LAT2CYR).map(([l, c]) => [c, l]));
const DIG_CYR = { 0: 'О', 8: 'В', 5: 'S' };
const DIG_LAT = { 0: 'O', 1: 'l', 8: 'B', 5: 'S' };
const CYR = /[А-Яа-яЁёӘәҒғҚқҢңӨөҰұҮүҺһІі]/g;
const LAT = /[A-Za-z]/g;
export function fixOcr(text, protect) {
  return text.replace(/[\p{L}\p{N}][\p{L}\p{N}/+#.-]*/gu, (tok) => {
    if (protect && protect.has(tok.toLowerCase())) return tok;
    if (/^[ABCАВС8][12]$/.test(tok)) return tok.replace(/^[8В]/, 'B').replace(/^А/, 'A').replace(/^С/, 'C');
    const nc = (tok.match(CYR) || []).length;
    const nl = (tok.match(LAT) || []).length;
    let out = tok;
    if (nc && nl) out = nc >= nl ? out.replace(/[aeopcxyABEKMHOPCTX]/g, (ch) => LAT2CYR[ch]) : out.replace(/[аеорсхуАВЕКМНОРСТХ]/g, (ch) => CYR2LAT[ch] || ch);
    if ((nc + nl) >= 1 && /\d/.test(out) && /^[^\d]*\p{L}/u.test(out) && !/^\p{L}+\d+$/u.test(out)) {
      const cyr = nc >= nl;
      out = out.replace(/(?<=\p{L})[0158](?=\p{L})|(?<=\p{L})0+(?=\P{N}|$)|^0(?=\p{L})/gu, (d) => d.split('').map((x) => (cyr ? DIG_CYR : DIG_LAT)[x] || x).join(''));
    }
    return out;
  });
}

// ------------------------------------------------------------------ словари разметки
const HEAD = {
  exp: ['Опыт работы', 'Профессиональный опыт', 'Трудовая деятельность', 'Места работы', 'Жұмыс тәжірибесі', 'Тәжірибе', 'Кәсіби тәжірибе', 'Еңбек жолы', 'Experience', 'Work experience', 'Professional experience', 'Employment history',
    'Профессиональный путь', 'Трудовой путь', 'Руководящая деятельность'],
  edu: ['Образование', 'Білімі', 'Білім', 'Education'],
  skills: ['Навыки', 'Ключевые навыки', 'Профессиональные навыки', 'Технические навыки', 'Стек технологий', 'Дағдылар', 'Кәсіби дағдылар', 'Негізгі дағдылар', 'Skills', 'Key skills', 'Technical skills', 'Professional skills', 'Core skills', 'Tech stack',
    'Skills & Expertise', 'Skills and Expertise', 'Core Competencies', 'Key Competencies', 'Areas of Expertise', 'Компетенции', 'Ключевые компетенции',
    'Сводка навыков', 'Summary of Skills', 'Skills Summary', 'Профессиональные компетенции', 'Основные профессиональные компетенции'],
  langs: ['Языки', 'Знание языков', 'Владение языками', 'Иностранные языки', 'Тілдер', 'Тілдерді білуі', 'Тіл білу', 'Languages', 'Language skills'],
  certs: ['Сертификаты', 'Курсы и сертификаты', 'Повышение квалификации', 'Повышение квалификации, курсы', 'Курсы', 'Сертификаттар', 'Курстар', 'Certifications', 'Certificates', 'Courses and certificates', 'Licenses and certifications',
    'Training', 'Trainings', 'Training & Certifications', 'Certifications & Training', 'Professional Training', 'Courses', 'Licenses', 'Тренинги'],
  // OncePlatform: sections nobody scores (awards, hobbies...): their lines used to land in the certificates
  other: ['Awards', 'Awards & Recognitions', 'Awards and Recognitions', 'Achievements', 'Honors', 'Награды', 'Достижения', 'Марапаттар', 'Жетістіктер',
    'Hobbies', 'Interests', 'Хобби', 'Интересы', 'References', 'Additional information', 'Дополнительная информация', 'Personal information',
    'Personal details', 'Личные данные', 'Личная информация'],
  // OncePlatform: краткое описание кандидата (раньше заголовок «Professional Summary» становился именем или должностью)
  summary: ['Professional Summary', 'Summary', 'Career Summary', 'Executive Summary', 'Profile', 'Professional Profile', 'About me', 'About', 'Objective', 'Career Objective', 'О себе', 'Обо мне', 'Кратко о себе', 'Профиль', 'Цель', 'Краткая информация', 'Өзім туралы', 'Кәсіби профиль',
    'Профессиональный профиль', 'Профессиональная цель'],
  // OncePlatform: проекты, которые вел кандидат (раньше их строки попадали в предыдущий раздел)
  projects: ['Проекты', 'Ключевые проекты', 'Реализованные проекты', 'Основные проекты', 'Опыт участия в проектах', 'Проектный опыт', 'Участие в проектах', 'Жобалар', 'Жобалық тәжірибе', 'Негізгі жобалар', 'Projects', 'Key projects', 'Project experience', 'Selected projects'],
};
const HEAD_LIST = Object.entries(HEAD).flatMap(([k, arr]) => arr.map((h) => [k, fold(h)]));
// стаж: «4 года 9 месяцев», «7 лет», «2 жыл 3 ай», «3 years 2 months», «(11 мес.)»
const DUR_UNIT = '(?:год|года|лет|г\\.|жыл|ай|мес\\.?|месяц|месяца|месяцев|years?|yrs?\\.?|months?|mos?\\.?)(?![\\p{L}])';
const DUR = `(?:более\\s+|over\\s+)?\\d{1,2}\\s*${DUR_UNIT}(?:\\s*(?:и|and|,)?\\s*\\d{1,2}\\s*${DUR_UNIT})?`;
export const DURATION = new RegExp(`^\\(?${DUR}\\)?$`, 'iu');
// заголовок раздела со стажем: «Опыт работы - 9 лет 3 месяца», «Work experience (5 years)»
const HEAD_DUR = new RegExp(`\\s*(?:[-\\u2013\\u2014:,]\\s*|\\(\\s*)${DUR}\\s*\\)?\\s*$`, 'iu');
// кэш: заголовки и должности повторяются от резюме к резюме
const memo = (fn, size = 6000) => { const m = new Map(); return (x) => { if (m.has(x)) return m.get(x); const v = fn(x); if (m.size > size) m.clear(); m.set(x, v); return v; }; };
export const headingOf = memo((line) => {
  // a heading is short; on a long line the trailing-run regexes below backtrack quadratically
  if (line.length > 100) return null;
  // OncePlatform: numbered headings - «5. ПРОФЕССИОНАЛЬНЫЙ ПУТЬ», «II. Education»
  const s = line.replace(/^(?:\d{1,2}|[IVX]{1,4})[.)]\s+/, '').replace(HEAD_DUR, '').replace(/[:.\s]+$/, '').trim();
  if (!s || s.length > 40 || /\d|@/.test(s) || s.split(/\s+/).length > 4) return null;
  const f = fold(s);
  let best = null;
  for (const [k, h] of HEAD_LIST) {
    if (Math.abs(f.length - h.length) > Math.max(1, Math.floor(h.length * 0.2))) continue;
    const d = lev(f, h);
    const ok = d === 0 || (h.length >= 6 && d <= Math.max(1, Math.floor(h.length * 0.2)));
    if (ok && (!best || d < best.d)) best = { k, d };
  }
  return best ? best.k : null;
});

const LABELS = {
  city: ['Город', 'Қала', 'City', 'Location', 'Город проживания'],
  phone: ['Телефон', 'Тел', 'Phone', 'Mobile'],
  email: ['E-mail', 'Email', 'Почта'],
  birth: ['Дата рождения', 'Туған күні', 'Date of birth', 'Birth date', 'Возраст', 'Age'],
  gender: ['Пол', 'Жынысы', 'Gender', 'Sex'],
  marital: ['Семейное положение', 'Отбасылық жағдайы', 'Marital status'],
  nat: ['Национальность', 'Ұлты', 'Nationality'],
};
const labelOf = (line) => {
  const m = line.match(/^([^:]{2,28}):\s*(.*)$/);
  if (!m) return null;
  const f = fold(m[1]);
  for (const [k, arr] of Object.entries(LABELS)) for (const a of arr) { const fa = fold(a); if (f === fa || (fa.length >= 5 && lev(f, fa) <= 2)) return { k, v: m[2].trim() }; }
  return null;
};

// «Мужчина, 35 лет, родился 17 апреля 1991» (hh.ru): пол и возраст строкой без подписи
const GENDER_LINE = /^(?:мужчина|женщина|male|female|ер|әйел)\s*,\s*\d{1,2}\s*(?:лет|год|года|жас|жаста|years?)(?![\p{L}])/iu;
// OncePlatform: «1980 г.р.», «12.03.1985 года рождения» и «Женат.» строкой без подписи
const BIRTH_LINE = /^(?:\d{1,2}\.\d{1,2}\.)?(?:19|20)\d{2}\s*(?:г\.?\s*р\.?|года?\s+рождения|ж\.\s*т\.?)$/iu;
const MARITAL_LINE = /^(?:женат|замужем|холост|не\s+женат|не\s+замужем|разведена?|married|single|divorced)\.?$/iu;
// «Желаемая должность и зарплата» (hh.ru), OncePlatform: «Специализация:» - должность в следующей строке
const WANTED = /^(?:желаемая должность|desired (?:position|job)|қалаған лауазым|специализация|speciali[sz]ation)/iu;
// OncePlatform: заголовок документа над именем - не имя и не должность
const DOC_TITLE = /^(?:персональное\s+портфолио|портфолио|резюме|түйіндеме|curriculum\s+vitae|cv|resume|résumé|personal\s+portfolio)$/iu;
export const isSensitiveLine = (l) => { const lb = labelOf(l); return (!!lb && ['birth', 'gender', 'marital', 'nat'].includes(lb.k)) || GENDER_LINE.test(l) || BIRTH_LINE.test(l) || MARITAL_LINE.test(l); };

const MONTHS = {
  ru: ['январь', 'февраль', 'март', 'апрель', 'май', 'июнь', 'июль', 'август', 'сентябрь', 'октябрь', 'ноябрь', 'декабрь'],
  ruGen: ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'], // «с мая 2017»
  kk: ['қаңтар', 'ақпан', 'наурыз', 'сәуір', 'мамыр', 'маусым', 'шілде', 'тамыз', 'қыркүйек', 'қазан', 'қараша', 'желтоқсан'],
  en: ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'],
};
const MONTH_LIST = Object.values(MONTHS).flatMap((arr) => arr.map((m, i) => [fold(m), i + 1]));
const monthOf = (w) => {
  const f = fold(w).replace(/\.$/, '');
  if (f.length < 3) return null;
  let best = null;
  for (const [m, i] of MONTH_LIST) {
    const cut = m.slice(0, Math.max(3, f.length));
    const d = f.length <= 4 && m.startsWith(f) ? 0 : lev(f, m.length > f.length + 1 ? cut : m);
    if (d <= (f.length >= 5 ? 1 : 0) && (!best || d < best.d)) best = { i, d };
  }
  return best ? best.i : null;
};
const PRESENT = ['настоящее время', 'по настоящее время', 'н.в.', 'н. в.', 'н/в', 'наст. время', 'настоящего времени', 'сей день', 'сегодня', 'қазіргі уақытқа дейін', 'қазіргі уақыт', 'қазірге дейін', 'осы уақытқа дейін', 'қазір', 'present', 'now', 'current', 'currently', 'till now', 'to date'].map(fold);
const isPresent = (s) => { const f = fold(s).replace(/^(по|до|up to|to|till|until)\s+/, ''); return PRESENT.some((p) => f === p || (p.length > 6 && lev(f, p) <= 2)); };

// дата: 03.2021 · 03/2021 · 2021-03 · март 2021 · марта 2021 г. · Mar 2021 · 2021 ж. наурыз · 2021 (только год)
// период: «03.2021 - 05.2023» (дефис, короткое или длинное тире), «с мая 2017 по февраль 2021», «Ақпан 2022  қазіргі уақыт»
// (тире потеряно в текстовом слое PDF), «01/2022 - по н.в.», «2018 - 2021»
const W = '[\\p{L}.]{3,12}';
const DASH = '[-\\u2013\\u2014]';
const DATE_SRC = `(?:\\d{2}[./]\\d{4}|\\d{4}-\\d{2}|${W}\\s\\d{4}(?:\\s?г\\.)?|\\d{4}\\s?ж\\.?\\s?${W}|(?:19[5-9]\\d|20[0-4]\\d)(?![\\d.]))`;
const PRES_SRC = '(?:настоящее\\s+время|настоящего\\s+времени|наст\\.\\s?время|н\\.\\s?в\\.?|н\\/в|сей\\s+день|сегодня|қазіргі\\s+уақытқа\\s+дейін|қазіргі\\s+уақыт|қазірге\\s+дейін|осы\\s+уақытқа\\s+дейін|қазір|present|now|currently|current|till\\s+now|to\\s+date)';
const TO = '(?:по|до|up\\s+to|to|until|till)'; // «October 1999 up to May 2005»
const RANGE = new RegExp(`(?:(?:^|\\s)(?:с|from|since)\\s+)?(${DATE_SRC})(?:\\s*${DASH}\\s*(${DATE_SRC}|(?:${TO}\\s+)?${PRES_SRC}|[\\p{L}. ]{2,26}?)|\\s+(?:${TO}\\s+)?(${DATE_SRC}|${PRES_SRC}))(?=\\s*[)|,(]|\\s*$)`, 'iu');
// период на двух строках (формат hh.ru): «Март 2022» или «Февраль 2019 -», в следующей строке «настоящее время» или дата
const START_ONLY = new RegExp(`^(?:(?:с|from|since)\\s+)?${DATE_SRC}\\s*${DASH}?$`, 'iu');
const END_ONLY = new RegExp(`^(?:${DASH}\\s*)?(?:${TO}\\s+)?(?:${DATE_SRC}|${PRES_SRC})$`, 'iu');
// OncePlatform: «February,2021», «December-2023», «JANUARY, 2007», «September 8, 2007» → «February 2021» (месяц и год
// через пробел - этот вид парсер знает)
const MONTH_YEAR = /(?<!\p{L})(\p{L}{3,9})\.?(?:\s*\d{1,2}(?:st|nd|rd|th)?)?\s*[,.-]?\s*((?:19|20)\d{2})(?!\d)/gu;
const monthYears = (l) => l.replace(MONTH_YEAR, (all, w, y) => (monthOf(w) ? `${w} ${y}` : all));
// OncePlatform: период с месяцем словом в начале строки и сразу должность («Sept 2020 – Present Contracts Manager») -
// разделитель после периода (числовые «2014-2019 ТОО … монтажник» разбирает oneLineJobs в cv.js)
const LEAD_RANGE = new RegExp(`^(${W}\\s\\d{4}\\s*${DASH}\\s*(?:${DATE_SRC}|(?:${TO}\\s+)?${PRES_SRC}))\\s+(?=(\\p{L}))`, 'iu');
// должность - с заглавной буквы («Present date, …» - не должность)
const leadRange = (l) => l.replace(LEAD_RANGE, (all, r, c) => (monthOf(r.split(/\s/)[0]) && c !== c.toLowerCase() ? `${r} | ` : all));
// первая строка ячейки дат в таблице (hh.ru): «Март 2022 -», «03.2021 - 05.2023», «2017» - для порядка чтения PDF
export const periodStart = (l) => START_ONLY.test(l) || RANGE.test(l);
const joinRanges = (ls) => {
  const out = [];
  for (let i = 0; i < ls.length; i += 1) {
    if (ls[i + 1] && START_ONLY.test(ls[i]) && END_ONLY.test(ls[i + 1])) { out.push(`${ls[i].replace(new RegExp(`\\s*${DASH}$`), '')} - ${ls[i + 1].replace(new RegExp(`^${DASH}\\s*`), '')}`); i += 1; } else out.push(ls[i]);
  }
  return out;
};
// годы в разделе «Образование»
const YEARS = /(?<![\d.])(?:19|20)\d{2}(?![\d.])/g;
const YEAR_DASH_END = new RegExp(`(?:19|20)\\d{2}\\s*${DASH}$`);
const YEAR_START = /^(?:19|20)\d{2}(?![\d.])/;
export function parseDate(s0, end = false) {
  const s = s0.replace(/\s?г\.$/u, '').trim();
  let m = s.match(/^(\d{2})[./](\d{4})$/);
  if (m) { const mo = Number(m[1]); return mo >= 1 && mo <= 12 ? `${m[2]}-${m[1]}` : null; }
  m = s.match(/^(\d{4})-(\d{2})$/);
  if (m) { const mo = Number(m[2]); return mo >= 1 && mo <= 12 ? `${m[1]}-${m[2]}` : null; }
  m = s.match(/^([\p{L}.]{3,12})\s(\d{4})$/u);
  if (m) { const mo = monthOf(m[1]); return mo ? `${m[2]}-${String(mo).padStart(2, '0')}` : null; }
  m = s.match(/^(\d{4})\s?ж\.?\s?([\p{L}.]{3,12})$/u);
  if (m) { const mo = monthOf(m[2]); return mo ? `${m[1]}-${String(mo).padStart(2, '0')}` : null; }
  // только год: начало - январь, окончание - декабрь, но не позже текущего месяца
  m = s.match(/^((?:19|20)\d{2})$/);
  if (m) { const now = nowYm(); return end ? (`${m[1]}-12` > now ? now : `${m[1]}-12`) : `${m[1]}-01`; }
  return null;
}

// организация: ТОО «…», ЖШС «…», «…» ЖШС, … LLP, АО «…»
const COMPANY = [
  // bounded runs and a word start: on a CV line of thousands of «"» or capitals the unbounded forms backtracked for
  // seconds (the text comes from whoever uploads the file)
  /(?:ТОО|АО|ИП|ГУ|РГП|ЖШС|АҚ|ЖК)(?:\s+СП)?\s*[«"]([^»"«\n]{1,150})[»"]/u, // OncePlatform: «ТОО СП «…»» (совместное предприятие)
  /[«"]([^»"«\n]{1,150})[»"]\s*(?:ЖШС|АҚ|ЖК)/u,
  /(?<![\w'&.-])([A-Z][\w'&.-]{0,40}(?:\s[A-Z][\w'&.-]{0,40}){0,4})\s+(?:LLP|LLC|JSC|Ltd\.?|Inc\.?)(?![\p{L}])/u,
];
const splitCompany = (s) => {
  for (const re of COMPANY) {
    const m = s.match(re);
    if (m) {
      const rest = (s.slice(0, m.index) + s.slice(m.index + m[0].length)).replace(/^[\s,|;()-]+|[\s,|;()-]+$/g, '').replace(/\s*[,|]\s*[,|]\s*/g, ', ').trim();
      return { company: m[1].trim(), companyRaw: m[0].trim(), rest };
    }
  }
  const parts = s.split(/\s*[|,]\s*/).filter(Boolean);
  return parts.length >= 2 ? { company: parts[1], companyRaw: parts[1], rest: parts[0] } : { company: null, companyRaw: null, rest: s.trim() };
};
const hasCompany = (s) => COMPANY.some((re) => re.test(s));
const POS_LABEL = /^(?:должность|позиция|лауазымы|лауазым|position|job title|title|role)\s*:\s*(.+)$/iu;
const BULLET = /^[-•*·▪●\u2013\u2014]/u;
const DUR_ANY = new RegExp(`\\(?${DUR}\\)?`, 'giu');
// должность из строки места работы: без организации, скобок, стажа и города в конце
// («Senior Engineer, Qarjy Online LLP (Almaty)» → «Senior Engineer»; «ЖШС «…» (отрасль), Астана» → пусто)
const posOf = (s, sc) => {
  const x = (sc?.companyRaw ? s.replace(sc.companyRaw, ' ') : s).replace(/\([^)]*\)?/g, ' ').replace(DUR_ANY, ' ');
  const parts = x.split(/\s*[,|]\s*/).map((p) => p.replace(/^[\s;:-]+|[\s;:-]+$/g, '').trim()).filter(Boolean);
  while (parts.length && parts[parts.length - 1].split(' ').length <= 2 && cityOf(parts[parts.length - 1]) != null) parts.pop();
  return parts.join(', ');
};
// место работы из одной строки: с организационно-правовой формой - как posOf, без нее - «должность, организация»
const placeOf = (s) => {
  const sc = splitCompany(s);
  return { company: sc.company, position: hasCompany(s) ? posOf(s, sc) : sc.rest };
};

// ------------------------------------------------------------------ должности (таксономия)
const SEN_WORDS = [
  [0, ['младший', 'junior', 'кіші', 'стажер', 'intern', 'trainee']],
  [2, ['ведущий', 'старший', 'senior', 'lead', 'аға', 'главный', 'principal']],
];
const TITLES = [];
for (const [prof, P] of Object.entries(PROFS)) for (const L of ['ru', 'kk', 'en']) TITLES.push([prof, fold(P.t[L]), L]);
TITLES.push(['qa_manual', fold('QA-инженер'), 'ru'], ['qa_manual', fold('Manual QA Engineer'), 'en'], ['frontend', fold('Front-end developer'), 'en'], ['analyst', fold('Data analyst'), 'en'], ['ml', fold('Data Scientist'), 'en'], ['pm', fold('Менеджер проектов'), 'ru']);
// «Backend Developer» и «Frontend Developer», «Ruby-» и «Java-разработчик» отличаются одним словом, поэтому нечеткое
// сравнение всей строки их путает. Направление разработки определяют ключевые слова: фронтенд - только frontend, front-end,
// фронтенд, React, Vue, Angular; бэкенд - backend, back-end, бэкенд, server-side, серверный разработчик, Go, .NET, C#, PHP,
// Node.js. Python и Java - свои профессии (специализации бэкенда, см. SPEC), только при слове Python или Java в должности.
// Слово направления действует в короткой строке или со словом «разработчик», «инженер» и т. п., технология - только с таким
// словом; строка с другой профессией (QA, аналитик, DevOps, мобильный...) направлением не считается: «QA Engineer (Backend)».
const ROLE_RE = /(?:^|[^\p{L}])(?:developer|engineer|programmer|dev(?![\p{L}])|разработчи|программист|инженер|әз[іi]рлеуш[іi]|бағдарламашы)/u;
const OTHER_RE = /(?:^|[^\p{L}])(?:qa|test\p{L}*|тест\p{L}*|analyst|аналит\p{L}*|devops|design\p{L}*|дизайн\p{L}*|manager|менеджер|admin\p{L}*|администратор|support|поддержк\p{L}*|mobile|мобил\p{L}*|ios|android|data|ml)(?![\p{L}])/u;
const FRONT_DIR = /(?:^|[^\p{L}])(?:front[\s-]?end|фронт[\s-]?[еэ]нд)/u;
const BACK_DIR = /(?:^|[^\p{L}])(?:back[\s-]?end|б[эе]к[\s-]?[еэ]нд|server[\s-]?side|серверн\p{L}*\s+(?:разработ|программ)|(?:разработ|программ)\p{L}*\s+серверн)/u;
const FRONT_TECH = /(?:^|[^\p{L}])(?:react|vue|angular)(?:\.?js)?(?![\p{L}])(?![\s-]?native)/u;
const BACK_TECH = /(?:^|[^\p{L}])(?:golang|go|c#|php|node(?:\.?js)?)(?![\p{L}])|\.net(?![\p{L}])/u;
const PY_RE = /(?:^|[^\p{L}])python(?![\p{L}])/u;
const JAVA_RE = /(?:^|[^\p{L}])java(?![\p{L}])/u;
// после OCR латинские буквы слова бывают кириллическими («Frоntеnd», «МL»), поэтому слова ищутся и в латинской записи
const LOOK = Object.fromEntries([...'авекмнорстух'].map((c, i) => [c, 'abekmhopctyx'[i]]));
const lat = (x) => x.replace(/[авекмнорстух]/g, (c) => LOOK[c]);
const keys = (raw) => { const low = String(raw).toLowerCase(); return `${low} / ${lat(low)}`; };
// слово с допуском на ошибку OCR («Frotend», «Pyhon»)
const near = (w, t) => { const k = t.length < 3 ? 0 : Math.max(1, Math.floor(t.length / 5)); return w === t || (Math.abs(w.length - t.length) <= k && lev(w, t) <= k) || (t.length >= 4 && w.endsWith(t)); };
const hasWord = (s, ws) => s.split(/[^\p{L}]+/u).some((w) => ws.some((t) => near(w, t)));
// нечеткое совпадение всей строки засчитывается, только если в ней есть слова, которыми профессия отличается от других:
// «Python», «QA», «Frontend» (без «разработчик», «инженер» и т. п.); «Backend» - не «Frontend», «Data» - не «QA», «JavaScript» - не «Java»
const ROLE_WORDS = /(?:developer|engиneer|programmer|разработчик|программист|инженер|азирлеуши|багдарламашы)\p{L}*/gu;
const words = (x) => lat(fold(x).replace(ROLE_WORDS, ' ')).split(/[^\p{L}\p{N}#]+/u).filter(Boolean);
const TITLE_WORDS = TITLES.map(([prof, t]) => [prof, words(t)]);
export const fuzzyOk = (raw, prof) => { const ws = words(raw); return TITLE_WORDS.some(([p, tw]) => p === prof && tw.every((t) => ws.some((w) => near(w, t)))); };
function sideOf(raw) {
  const s = keys(raw);
  if (OTHER_RE.test(s)) return null;
  const role = ROLE_RE.test(s);
  if (String(raw).replace(/\([^)]*\)/g, ' ').trim().split(/\s+/).length > (role ? 5 : 3)) return null;
  const f = FRONT_DIR.test(s) || hasWord(s, ['frontend', 'фронтенд']);
  const b = BACK_DIR.test(s) || hasWord(s, ['backend']);
  if (f || b) return f === b ? null : f ? 'front' : 'back'; // оба направления - fullstack
  if (!role) return null;
  const ft = FRONT_TECH.test(s); const bt = BACK_TECH.test(s);
  return ft === bt ? null : ft ? 'front' : 'back';
}
// Должности вне таксономии (13 профессий генератора и бэкенд). Мобильные платформы - это мобильный разработчик
// таксономии (как демо-вакансии «Flutter-разработчик», «Android-разработчик»). Остальные известные должности получают
// ближайшую профессию с пометкой «приблизительно» и причиной: [ключ причины, проверка, ближайшая профессия или несколько -
// тогда выбор по навыкам резюме]. Общая должность без направления («Программист», «Software Engineer») - по навыкам.
// (сравнение на свернутом тексте fold: латинская i там - кириллическая и.)
// Только для строк, похожих на должность (до 6 слов, без «Подпись: », адреса сайта и точки в конце): строки описания,
// города и отрасли сюда не попадают. Должности, которые не похожи ни на одну из них (продажи, бухгалтерия), остаются
// без профессии.
const MOBILE_RE = /(?:^|[^\p{L}])(?:android|ios|flutter|swift|мобильн\p{L}*|mobile)(?![\p{L}])/u;
const C1 = '(?:^|[^\\p{L}\\d])1\\s?[сc](?![\\p{L}])';
export const NEAR = [
  ['rn', /react[\s-]?native|xamarin|ionic|cordova|кроссплатформ|cross[\s-]?platform/u, ['mobile']],
  ['1cba', new RegExp(`${C1}.*(?:аналит|консульт|analyst|consultant)|(?:аналит|консульт|analyst|consultant).*${C1}`, 'u'), ['ba']],
  ['1c', new RegExp(`${C1}|битрикс|bitrix`, 'u'), ['backend']],
  ['data', /data[\s-]?engineer|инженер\p{L}*\s+(?:по\s+)?данн|дата[\s-]?инженер|деректер\s+инженер|big[\s-]?data|(?:^|[^\p{L}])(?:etl|dwh|hadoop|spark)(?![\p{L}])|data\s+(?:warehouse|platform|pipeline)|хранилищ\p{L}*\s+данн/u, ['analyst']],
  ['bi', /(?:^|[^\p{L}])(?:bi|power\s?bi|tableau|qlik)(?![\p{L}])/u, ['analyst']],
  ['sysan', /систем\p{L}*\s+аналит|system\p{L}*\s+analyst|аналитик\p{L}*\s+требован|requirements\s+analyst/u, ['ba']],
  ['product', /product\s+(?:manager|owner)|продакт|владел\p{L}*\s+продукт|scrum[\s-]?master|скрам|delivery\s+manager|agile[\s-]?coach/u, ['pm']],
  ['sre', /(?:^|[^\p{L}])(?:sre|devsecops|mlops)(?![\p{L}])|site\s+reliability|platform\s+engineer|cloud\s+engineer|инфраструктур/u, ['devops']],
  ['admin', /систем\p{L}*\s+администратор|сисадмин|sys[\s-]?admin|system\p{L}*\s+administrator|жүйелік\s+әкімші|сетев\p{L}*\s+(?:инженер|администратор)|network\s+(?:engineer|administrator)|help[\s-]?desk|service[\s-]?desk|(?:^|[^\p{L}])(?:ит|it)[\s-]специалист/u, ['support', 'devops']],
  ['ml', /(?:^|[^\p{L}])(?:ai|nlp|ии)(?![\p{L}])|machine\s+learning|deep\s+learning|computer\s+vision|машинн\p{L}*\s+обучен|data\s+scien/u, ['ml']],
  ['qaauto', /sdet|автотест|test\s+automation|automation\s+(?:qa|test)|нагрузочн|load\s+test|performance\s+test/u, ['qa_auto']],
  ['qalead', /(?:^|[^\p{L}])(?:qa|test)[\s-]?(?:lead|manager)|руковод\p{L}*\s+(?:отдела\s+)?тестирован|тест[\s-]?лид/u, ['qa_manual']],
  ['db', /(?:database|sql|pl\/sql|t-sql|oracle)\s+developer|разработчик\p{L}*\s+(?:баз\p{L}*\s+данных|бд|sql)/u, ['dba']],
  ['fullstack', /full[\s-]?stack|фулл?[\s-]?стек/u, ['frontend', 'backend', 'python', 'java']],
  ['web', /web[\s-]?(?:developer|programmer|разработчик|программист)|веб[\s-]?(?:разработчик|программист)|web[\s-]?master|вебмастер/u, ['frontend', 'backend', 'python', 'java']],
];
// причина приблизительной профессии (показывается в профиле, при загрузке и в JSON Resume)
export const NEAR_WHY = {
  rn: { ru: 'кроссплатформенная мобильная разработка (React Native)', kk: 'кросс-платформалы мобильді әзірлеу (React Native)', en: 'cross-platform mobile development (React Native)' },
  '1cba': { ru: 'учетные процессы на 1С: анализ и настройка', kk: '1С есеп процестері: талдау және баптау', en: 'accounting processes in 1C: analysis and set-up' },
  '1c': { ru: 'разработка на платформе 1С: серверная логика и базы данных', kk: '1С платформасында әзірлеу: серверлік логика және дерекқорлар', en: 'development on the 1C platform: server-side logic and databases' },
  data: { ru: 'направление «данные»: ETL, хранилища, пайплайны', kk: '«деректер» бағыты: ETL, қоймалар, пайплайндар', en: 'data direction: ETL, warehouses, pipelines' },
  bi: { ru: 'BI-отчетность и анализ данных', kk: 'BI есептілігі және деректерді талдау', en: 'BI reporting and data analysis' },
  sysan: { ru: 'системный анализ: требования и процессы', kk: 'жүйелік талдау: талаптар мен процестер', en: 'systems analysis: requirements and processes' },
  product: { ru: 'управление продуктом и командой', kk: 'өнімді және команданы басқару', en: 'product and team management' },
  sre: { ru: 'инфраструктура и эксплуатация сервисов', kk: 'инфрақұрылым және қызметтерді пайдалану', en: 'infrastructure and service operations' },
  admin: { ru: 'администрирование и поддержка ИТ-инфраструктуры', kk: 'АТ инфрақұрылымын әкімшілендіру және қолдау', en: 'IT infrastructure administration and support' },
  ml: { ru: 'машинное обучение и ИИ', kk: 'машиналық оқыту және ЖИ', en: 'machine learning and AI' },
  qaauto: { ru: 'автоматизация и нагрузочное тестирование', kk: 'тестілеуді автоматтандыру және жүктемелік тестілеу', en: 'test automation and load testing' },
  qalead: { ru: 'руководство тестированием', kk: 'тестілеуді басқару', en: 'test management' },
  db: { ru: 'разработка баз данных', kk: 'дерекқорларды әзірлеу', en: 'database development' },
  fullstack: { ru: 'фронтенд и бэкенд', kk: 'фронтенд және бэкенд', en: 'frontend and backend' },
  web: { ru: 'веб-разработка', kk: 'веб-әзірлеу', en: 'web development' },
  dev: { ru: 'разработка без указанного направления', kk: 'бағыты көрсетілмеген әзірлеу', en: 'development without a stated direction' },
};
const GENERIC = /^(?:software (?:eng[iи]neer|developer)|developer|programmer|программист|разработчик(?: (?:по|программного обеспечения))?|инженер[ -]программист|багдарламашы|азирлеуши)$/u;
const DEV = ['backend', 'python', 'java', 'frontend', 'mobile', 'ml'];
const titleLike = (raw) => {
  const x = String(raw).replace(/\([^)]*\)/g, ' ').replace(/\s+/g, ' ').trim();
  return x.length > 1 && x.length <= 60 && x.split(' ').length <= 6 && !/:\s|@|www\.|https?:|[a-z0-9-]{2,}\.(?:kz|ru|com|org|net|io|me|example)(?![a-z])|[.!?;]$/iu.test(x);
};
export const normTitle = memo((raw) => {
  if (!raw) return null;
  const side = sideOf(raw);
  let s = fold(raw).replace(/[()]/g, ' ').replace(/\s+/g, ' ').trim();
  let sen = 1;
  for (const [lv, words] of SEN_WORDS) for (const w of words) { const fw = fold(w); const first = s.split(' ')[0]; if (first === fw || (fw.length >= 6 && lev(first, fw) <= 1)) { sen = lv; s = s.slice(first.length).trim(); } }
  if (side === 'back') { const k = keys(raw); return { prof: PY_RE.test(k) ? 'python' : JAVA_RE.test(k) ? 'java' : 'backend', sen, conf: 0.9 }; }
  let best = null;
  for (const [prof, t] of TITLES) {
    const mx = Math.max(s.length, t.length);
    if (Math.abs(s.length - t.length) / mx > 0.3) continue;
    const d = lev(s, t) / mx;
    if (!best || d < best.d) best = { prof, d };
  }
  if (side === 'front') return { prof: 'frontend', sen, conf: best && best.prof === 'frontend' && best.d <= 0.3 ? Math.round((1 - best.d) * 100) / 100 : 0.9 };
  if (best && best.d <= 0.3 && fuzzyOk(raw, best.prof)) return { prof: best.prof, sen, conf: Math.round((1 - best.d) * 100) / 100 };
  if (titleLike(raw)) {
    const k = keys(raw);
    if (ROLE_RE.test(k) && MOBILE_RE.test(k)) return { prof: 'mobile', sen, conf: 0.9 };
    const hit = NEAR.find(([, re]) => re.test(k));
    if (hit) return { prof: hit[2][0], sen, conf: 0.5, approx: hit[0], cands: hit[2] };
    if (GENERIC.test(s)) return { prof: DEV[0], sen, conf: 0.4, approx: 'dev', cands: DEV };
  }
  return { prof: null, sen, conf: 0 };
});
// приблизительная профессия: из кандидатов - с наибольшим пересечением навыков резюме и профиля профессии
// (основные навыки - 2 балла, дополнительные - 1), при равенстве - первая; skills - общие навыки для пояснения
export function nearProf(nt, have) {
  if (!nt?.approx) return nt;
  const pts = (p) => PROFS[p].core.filter((x) => have.has(x)).length * 2 + PROFS[p].extra.filter((x) => have.has(x)).length;
  let prof = nt.cands[0]; let bs = -1;
  for (const p of nt.cands) { const v = pts(p); if (v > bs) { bs = v; prof = p; } }
  return { prof, sen: nt.sen, conf: nt.conf, approx: nt.approx, bySkills: nt.cands.length > 1, skills: [...PROFS[prof].core, ...PROFS[prof].extra].filter((x) => have.has(x)).slice(0, 3) };
}
export const FAMILY = { python: 'dev', java: 'dev', backend: 'dev', frontend: 'dev', mobile: 'dev', ml: 'dev', qa_auto: 'qa', qa_manual: 'qa', devops: 'ops', dba: 'ops', support: 'ops', analyst: 'an', ba: 'an', pm: 'pm' };
// Python- и Java-разработчики - тоже бэкенд: для вакансии с профилем «Backend» их опыт и должность засчитываются полностью
export const SPEC = { python: 'backend', java: 'backend' };
export const sameProf = (p, prof) => !!p && (p === prof || SPEC[p] === prof);

// ------------------------------------------------------------------ языки
const LANGS = {
  kk: ['Казахский', 'Қазақ тілі', 'Қазақша', 'Kazakh', 'Казахский язык'],
  ru: ['Русский', 'Орыс тілі', 'Russian', 'Русский язык'],
  en: ['Английский', 'Ағылшын тілі', 'English', 'Английский язык'],
  de: ['Немецкий', 'Неміс тілі', 'German'],
  tr: ['Турецкий', 'Түрік тілі', 'Turkish'],
  ko: ['Корейский', 'Корей тілі', 'Korean'],
  uz: ['Узбекский', 'Өзбек тілі', 'Uzbek'],
  zh: ['Китайский', 'Қытай тілі', 'Chinese'],
  fr: ['Французский', 'Француз тілі', 'French'],
};
// уровни словами по шкале hh.ru и CEFR: «Начальный» A1, «Элементарный» A2, «Средний» B1, «Средне-продвинутый» B2,
// «Продвинутый» C1, «В совершенстве» C2; составные выражения проверяются раньше коротких («средне-продвинутый» до «продвинутый»)
const LEVEL_WORDS = [
  ['native', ['родной', 'ана тілі', 'native', 'mother tongue']],
  ['B2', ['средне-продвинутый', 'выше среднего', 'upper-intermediate', 'upper intermediate', 'жоғары орта', 'орташадан жоғары']],
  ['A2', ['pre-intermediate', 'элементарный', 'elementary', 'базовый', 'базовые знания', 'базалық', 'қарапайым']],
  ['C2', ['в совершенстве', 'proficient', 'proficiency']],
  ['C1', ['продвинутый', 'advanced', 'жетік']],
  ['fluent', ['свободно', 'свободный', 'еркін', 'fluent']],
  ['B1', ['средний', 'intermediate', 'разговорный', 'conversational', 'орта']],
  ['A1', ['начальный', 'beginner', 'бастапқы']],
];
const LANG_LIST = Object.entries(LANGS).flatMap(([code, arr]) => arr.map((a) => [code, fold(a)]));
const LEVEL_LIST = LEVEL_WORDS.map(([lv, arr]) => [lv, arr.map(fold)]);
const langOf = (s) => {
  const f = fold(s);
  let best = null;
  for (const [code, fa] of LANG_LIST) { if (Math.abs(f.length - fa.length) > 2) continue; const d = lev(f, fa); if (d <= 2 && (!best || d < best.d)) best = { code, d }; }
  return best?.code || null;
};
const levelOf = (s) => {
  const m = s.match(/(?<![\p{L}])([ABCАВС8])\s?([12])(?![\p{L}\d])/u);
  if (m) return `${{ А: 'A', В: 'B', С: 'C', 8: 'B' }[m[1]] || m[1]}${m[2]}`;
  const f = fold(s);
  for (const [lv, arr] of LEVEL_LIST) for (const fa of arr) if (f.includes(fa) || (fa.length >= 5 && Math.abs(f.length - fa.length) <= 2 && lev(f, fa) <= 2)) return lv;
  return null;
};
export const LEVEL_RANK = { A1: 1, A2: 2, B1: 3, B2: 4, C1: 5, C2: 6, fluent: 5, native: 7 };

// ------------------------------------------------------------------ города
const CITY_ALIASES = [...CITIES.flatMap((c, i) => ['ru', 'kk', 'en'].map((L) => [fold(c[L]), i])), [fold('Нур-Султан'), 0], [fold('Alma-Ata'), 1], [fold('Qaraghandy'), 3], [fold('Aqtobe'), 4]];
export function cityOf(s) {
  for (const w of s.split(/[\s,·|:;()]+/)) {
    const f = fold(w);
    if (f.length < 4) continue;
    for (const [c, i] of CITY_ALIASES) if (f === c || (c.length >= 6 && lev(f, c) <= 1)) return i;
  }
  return null;
}

// ------------------------------------------------------------------ стаж: объединение периодов
// открытый период (end = null) - до текущего месяца на момент расчета, а не до месяца генератора
export function totalMonths(periods) {
  const now = ymToN(nowYm());
  const iv = periods.filter((p) => p.start).map((p) => [ymToN(p.start), p.end ? ymToN(p.end) : now]).filter(([a, b]) => b >= a).sort((x, y) => x[0] - y[0]);
  let sum = 0; let cur = null;
  for (const [a, b] of iv) {
    if (!cur || a > cur[1]) { if (cur) sum += cur[1] - cur[0]; cur = [a, b]; } else cur[1] = Math.max(cur[1], b);
  }
  if (cur) sum += cur[1] - cur[0];
  return sum;
}
// опыт в профессии вакансии полностью, в той же группе профессий - наполовину; в должности с приблизительной
// профессией - с весом near (по умолчанию 0,5) и только для самой этой профессии
export function relevantMonths(work, prof, near = 0.5) {
  const exact = work.filter((w) => !w.approx);
  const same = totalMonths(exact.filter((w) => sameProf(w.prof, prof)));
  const fam = totalMonths(exact.filter((w) => w.prof && !sameProf(w.prof, prof) && FAMILY[w.prof] === FAMILY[prof]));
  const approx = totalMonths(work.filter((w) => w.approx && sameProf(w.prof, prof)));
  return same + fam * 0.5 + approx * near;
}

// ------------------------------------------------------------------ основной разбор
// bounded parts and a start that is no letter of the address: run over the whole text, the unbounded form took 34 s
// on 160 000 letters in a row
const EMAIL = /(?<![\p{L}\d._%+-])[\p{L}\d._%+-]{1,64}@[\p{L}\d-]{1,63}(?:\.[\p{L}\d-]{1,63}){0,8}\.[a-z]{2,24}/iu;
const PHONE = /(?:\+?\s?[78])[\s(-]*(\d{3})[\s)-]*(\d{3})[\s-]*(\d{2})[\s-]*(\d{2})(?!\d)/;

export function detectLang(text) {
  const kk = (text.match(/[әғқңөұүһі]/gi) || []).length;
  const cyr = (text.match(CYR) || []).length;
  const lat = (text.match(LAT) || []).length;
  if (kk > 12 || /жұмыс|тәжірибе|дағды|білім/i.test(text)) return cyr > lat * 0.6 ? 'kk' : 'mix';
  if (cyr > lat * 1.6) return 'ru';
  if (lat > cyr * 4) return 'en';
  return 'mix';
}

const ROLE_L = /^(?:роль(?:\s+в\s+проекте)?|рөлі|role)\s*[:-]\s*(.+)$/iu;
const CUST_L = /^(?:заказчик|клиент|тапсырыс\s+беруші|customer|client)\s*[:-]\s*(.+)$/iu;
const NAME_L = /^(?:проект|название(?:\s+проекта)?|жоба|project(?:\s+name)?)\s*[:-]\s*(.+)$/iu;
const YEAR_TAIL = /\s*\((?:[^)]*?\s)?((?:19|20)\d{2})\)\s*$/;
const clean = (l) => l.replace(BULLET, '').trim();
// paragraphs of a project list without periods (a line in lower case goes on), when at least two of them are a name
// followed by its description: «ТЭЦ-2» / «Наблюдения за осадками …» / «… оборудования.»; otherwise null
const namedProjects = (pl) => {
  const ps = [];
  for (const l of pl) if (ps.length && !BULLET.test(l) && /^\p{Ll}/u.test(l)) ps[ps.length - 1] += ` ${l}`; else ps.push(l);
  const end = (x) => /[.;]$/.test(x || '');
  return ps.filter((x, i) => !end(x) && !BULLET.test(x) && !NAME_L.test(x) && end(ps[i + 1])).length >= 2 ? ps : null;
};
export function parseProjects(pl) {
  const out = [];
  const nameBefore = pl.length > 1 && !RANGE.test(pl[0]) && RANGE.test(pl[1]);
  const fields = (cur, l) => {
    const r = l.match(ROLE_L); const c = l.match(CUST_L); const n = l.match(NAME_L);
    if (r) cur.role = r[1].trim(); else if (c) cur.customer = c[1].trim(); else if (n) cur.name = n[1].trim();
    return !!(r || c || n);
  };
  let cur = null;
  if (pl.some((l) => RANGE.test(l))) {
    for (let i = 0; i < pl.length; i += 1) {
      const l = pl[i];
      const m = l.match(RANGE);
      if (m) {
        const endRaw = (m[2] ?? m[3] ?? '').trim();
        const rest = clean(l.slice(0, m.index) + l.slice(m.index + m[0].length)).replace(/^[\s|,:;()–—-]+|[\s|,:;()–—-]+$/g, '');
        let name = /\p{L}/u.test(rest) ? rest : null;
        if (!name && nameBefore && i > 0 && !RANGE.test(pl[i - 1])) name = clean(pl[i - 1]);
        cur = { name, role: null, customer: null, startDate: parseDate(m[1].trim()), endDate: isPresent(endRaw) ? null : parseDate(endRaw, true), summary: [] };
        out.push(cur);
        continue;
      }
      if (nameBefore && RANGE.test(pl[i + 1] || '')) continue; // название следующего проекта
      if (!cur) { cur = { name: clean(l), role: null, customer: null, startDate: null, endDate: null, summary: [] }; out.push(cur); continue; }
      if (fields(cur, l)) continue;
      if (!cur.name) cur.name = clean(l); else cur.summary.push(clean(l));
    }
  } else if (namedProjects(pl)) {
    // OncePlatform: the name of a project without a full stop and its description under it ending with one; text
    // before the first name is an introduction
    for (const x of namedProjects(pl)) {
      if (/[.;]$/.test(x)) { cur?.summary.push(x); continue; }
      cur = { name: clean(x.replace(YEAR_TAIL, '')), role: null, customer: null, startDate: null, endDate: null, summary: [] };
      out.push(cur);
    }
  } else {
    for (const l of pl) {
      if (cur && fields(cur, l)) continue;
      if (cur && !BULLET.test(l) && /^[\p{Ll}]/u.test(l)) { cur.summary.push(l); continue; }
      const y = l.match(YEAR_TAIL);
      cur = { name: clean(l.replace(YEAR_TAIL, '')), role: null, customer: null, startDate: null, endDate: y ? parseDate(y[1], true) : null, summary: [] };
      out.push(cur);
    }
  }
  return out.filter((p) => p.name).slice(0, 30).map((p) => ({ ...p, name: p.name.slice(0, 200), summary: p.summary.join(' ') || undefined }));
}

// текст строки периода без периода, стажа, пустых скобок и вложенного периода («Engineer (Feb 2013 to July 2020)»)
const restOf = (l, m = l.match(RANGE)) => {
  if (!m) return '';
  const r = (l.slice(0, m.index) + l.slice(m.index + m[0].length)).replace(/\(([^()]*)\)/g, (all, x) => (RANGE.test(x) ? ' ' : all)).replace(DUR_ANY, ' ')
    .replace(/\(\s*\)|\(\s*$|^\s*\)/g, ' ').replace(/\s*\|\s*\|?\s*$/, '').replace(/^[\s|,]+|[\s|,]+$/g, '').replace(/\s+/g, ' ').trim();
  return /\p{L}/u.test(r) ? r : '';
};

// место работы; приблизительная профессия уточняется по навыкам ниже
const mkJob = (place, start, end, desc, src) => {
  const position = place?.position || null;
  const nt = normTitle(position);
  const job = { name: place?.company || null, position, startDate: start, endDate: end, summary: desc.join(' ') || undefined, prof: nt?.prof || null, sen: nt?.sen ?? null };
  if (nt?.approx) job.near = nt;
  job.src = src; // OncePlatform: строки этого места работы - по ним cv.js находит город и страну
  return job;
};

// OncePlatform: места работы записями с подписями полей - «Position : / Duration : / Company : / Country :» столбцом и
// значения под ними в том же порядке, или «Position: …» строками. Повтор подписи начинает следующую запись. Берутся
// только записи с подписанным периодом: без подписи периода - обычный разбор («Должность: …» под периодом, как на hh.ru).
const FIELD = /^(position|designation|job\s+title|duration|period|dates?|company|employer|organi[sz]ation|country|location|должность|период|компания|организация|страна)\s*:\s*(.*)$/iu;
const FIELD_KIND = [['pos', /^(?:position|designation|job\s+title|должность)$/iu], ['period', /^(?:duration|period|dates?|период)$/iu], ['company', /^(?:company|employer|organi[sz]ation|компания|организация)$/iu]];
const fieldOf = (l) => {
  const m = FIELD.exec(l);
  return m && { kind: FIELD_KIND.find(([, re]) => re.test(m[1]))?.[0] || 'other', label: m[1], value: m[2].trim() };
};
function labelledJobs(ex) {
  const ls = [];
  for (let i = 0; i < ex.length; i += 1) {
    let k = i;
    while (k < ex.length && fieldOf(ex[k])?.value === '') k += 1;
    let v = k;
    while (v < ex.length && v - k < k - i && !fieldOf(ex[v])) v += 1;
    if (k - i >= 2 && v > k) {
      for (let j = 0; j < v - k; j += 1) ls.push(`${fieldOf(ex[i + j]).label}: ${ex[k + j]}`);
      i = v - 1;
    } else if (k - i >= 2) {
      // a run of labels without values: kept as it is, in one step (line by line it was quadratic)
      ls.push(...ex.slice(i, k));
      i = k - 1;
    } else ls.push(ex[i]);
  }
  const recs = [];
  let cur = null;
  for (const l of ls) {
    const f = fieldOf(l);
    if (f?.value && (!cur || f.kind in cur.f)) { cur = { f: {}, desc: [], src: [] }; recs.push(cur); }
    if (!cur) continue;
    cur.src.push(f?.value || l);
    if (f?.value) cur.f[f.kind] = f.value;
    else if (!f) cur.desc.push(l);
  }
  const jobs = [];
  for (const r of recs) {
    const m = (r.f.period || '').match(RANGE);
    const start = m && parseDate(m[1].trim());
    if (!start) continue;
    const endRaw = (m[2] ?? m[3] ?? '').trim();
    jobs.push(mkJob({ company: r.f.company, position: r.f.pos }, start, isPresent(endRaw) ? null : parseDate(endRaw, true), r.desc, r.src));
  }
  return jobs.length >= 2 ? jobs : [];
}

// OncePlatform: a table of jobs read column by column (pdftotext of a Word or Writer table): all the periods, then all
// the companies, then all the titles, in blocks per page. Taken only when there are as many companies as periods;
// titles only when their count agrees too (a line in lower case continues the title above).
const periodOnly = (l) => { const m = l.match(RANGE); return (!!m && !restOf(l, m)) || START_ONLY.test(l); };
const START_DATE = new RegExp(DATE_SRC, 'iu');
function columnJobs(ex) {
  const first = ex.findIndex((l, i) => periodOnly(l) && periodOnly(ex[i + 1] || ''));
  if (first < 0) return null;
  const cell = (l) => periodOnly(l) || (!RANGE.test(l) && !BULLET.test(l) && !/[.;:!?]$/.test(l) && (hasCompany(l) || l.split(/\s+/).length <= 6));
  let end = first;
  while (end < ex.length && cell(ex[end])) end += 1;
  const zone = ex.slice(first, end);
  const periods = zone.filter(periodOnly);
  const companies = zone.filter((l) => !periodOnly(l) && hasCompany(l));
  const titles = [];
  for (const l of zone) {
    if (periodOnly(l) || hasCompany(l)) continue;
    if (titles.length && /^\p{Ll}/u.test(l)) titles[titles.length - 1] += ` ${l}`; else titles.push(l);
  }
  if (companies.length !== periods.length) return null;
  const jobs = periods.map((l, i) => {
    const m = l.match(RANGE);
    const endRaw = m ? (m[2] ?? m[3] ?? '').trim() : '';
    const position = titles.length === periods.length ? titles[i] : null;
    return mkJob({ company: splitCompany(companies[i]).company, position }, parseDate((m ? m[1] : l.match(START_DATE)[0]).trim()),
      m && !isPresent(endRaw) ? parseDate(endRaw, true) : null, [], [l, companies[i], position].filter(Boolean));
  });
  return { jobs, from: first, to: end };
}
// OncePlatform: «С 2023 года — директор ТОО «…»» - место работы с этого года по настоящее время
const SINCE = /^(?:с|since|from)\s+((?:19|20)\d{2})\s*(?:года|г\.|year)?\s*[—–-]\s*(.+?)\.?$/iu;
const sinceLine = (l) => { const m = SINCE.exec(l); return m && hasCompany(m[2]) ? `${m[1]} - настоящее время | ${m[2].charAt(0).toUpperCase()}${m[2].slice(1)}` : l; };
const wordKey = (x) => fold(x).split(/[^\p{L}]+/u).filter(Boolean).sort().join(' ');

export function parseResume(text0, { matcher, protect, ocr = false } = {}) {
  const t0 = typeof performance !== 'undefined' ? performance.now() : Date.now();
  // глифы без кода Unicode в текстовом слое PDF (область частного использования: потерянные тире, скобки, маркеры списка) - пробел
  const text = (ocr ? fixOcr(text0, protect) : text0).replace(/[-]/gu, ' ');
  const lines = text.split(/\r?\n/).map((l) => l.replace(/\s+/g, ' ').trim());
  // разделы
  const sec = { head: [] };
  let cur = 'head';
  const found = [];
  for (const l of lines) {
    const h = headingOf(l);
    // повторный заголовок продолжает свой раздел: «Ключевые навыки» … «Навыки» (hh.ru)
    if (h) { cur = h; if (!sec[h]) { sec[h] = []; found.push(h); } continue; }
    if (l) (sec[cur] = sec[cur] || []).push(l);
  }
  const out = { basics: { name: null, label: null, email: null, phone: null, location: { city: null, cityId: null } }, work: [], education: [], skills: [], languages: [], certificates: [], projects: [], meta: { lang: detectLang(text), sections: found, warnings: [], sensitive: {}, ocrFixed: ocr } };
  const B = out.basics;
  // заголовок и контакты
  const headLines = sec.head;
  const em = text.match(EMAIL);
  if (em) {
    let e = em[0].toLowerCase();
    const [loc, dom] = e.split('@');
    e = `${loc.replace(/(?<=\p{L})1(?=\p{L})/gu, 'l')}@${dom}`;
    B.email = e;
  }
  const ph = text.match(PHONE);
  if (ph) B.phone = `+7 ${ph[1]} ${ph[2]} ${ph[3]} ${ph[4]}`;
  const plain = [];
  for (const l of headLines) {
    const lb = labelOf(l);
    if (lb) {
      if (lb.k === 'city') { const c = cityOf(lb.v); B.location.cityId = c; B.location.city = c != null ? CITIES[c].ru : lb.v; }
      else if (lb.k === 'birth') out.meta.sensitive.birthDate = lb.v;
      else if (lb.k === 'gender') out.meta.sensitive.gender = lb.v;
      else if (lb.k === 'marital') out.meta.sensitive.marital = lb.v;
      else if (lb.k === 'nat') out.meta.sensitive.nationality = lb.v;
      continue;
    }
    if (GENDER_LINE.test(l)) { const [g, age] = l.split(/\s*,\s*/); out.meta.sensitive.gender = g; out.meta.sensitive.birthDate = age; continue; }
    if (BIRTH_LINE.test(l)) { out.meta.sensitive.birthDate = l; continue; }
    if (MARITAL_LINE.test(l)) { out.meta.sensitive.marital = l; continue; }
    if (EMAIL.test(l) || PHONE.test(l)) { if (B.location.cityId == null) { const c = cityOf(l); if (c != null) { B.location.cityId = c; B.location.city = CITIES[c].ru; } } continue; }
    plain.push(l);
  }
  // OncePlatform: инициалы («Aigerim K. Nurlanova»), до четырех слов и «Jr.» в конце; без такой строки - первая строка
  // одним словом заглавными («IVANPETROV»: пробел потерян в PDF), если это не должность. Заголовок документа
  // («ПЕРСОНАЛЬНОЕ ПОРТФОЛИО») - не имя.
  let nameIdx = plain.findIndex((l) => /^[\p{Lu}][\p{L}'-]+(?:\s(?:\p{Lu}\.|[\p{Lu}][\p{L}'-]+)){1,3}(?:,?\s(?:Jr|JR|Sr|SR|II|III|IV)\.?)?$/u.test(l) && !normTitle(l)?.prof && !DOC_TITLE.test(l));
  if (nameIdx < 0 && /^\p{Lu}{6,30}$/u.test(plain[0] || '') && !normTitle(plain[0])?.prof && !/^(?:RESUME|CURRICULUM|PROFILE|РЕЗЮМЕ)$|(?:ER|OR|IST|IAN|ANT|MAN|ИК|ЕР|ОР)$/u.test(plain[0])) nameIdx = 0;
  if (nameIdx >= 0) B.name = plain[nameIdx];
  else out.meta.warnings.push('name');
  const wi = plain.findIndex((l) => WANTED.test(l));
  const labelLine = (wi >= 0 && plain[wi + 1]) || plain.find((l, i) => i !== nameIdx && normTitle(l)?.prof) || plain.find((l, i) => i !== nameIdx && !l.includes(':')) || plain.find((l, i) => i !== nameIdx);
  if (labelLine) { B.label = labelLine.replace(BULLET, '').trim(); out.meta.title = normTitle(B.label); }
  if (B.location.cityId == null) { for (const l of headLines) { const c = cityOf(l); if (c != null) { B.location.cityId = c; B.location.city = CITIES[c].ru; break; } } }
  // опыт работы
  // период на двух строках склеивается; строки стажа («4 года 9 месяцев») пропускаются и не становятся
  // ни организацией, ни должностью
  // OncePlatform: contacts and the name again (a signature at the end) are no part of a section
  const nameKey = B.name && wordKey(B.name);
  for (const k of Object.keys(sec)) if (k !== 'head') sec[k] = sec[k].filter((l) => !EMAIL.test(l) && !PHONE.test(l) && !/_{4,}/.test(l) && !(nameKey && wordKey(l) === nameKey));
  let ex = joinRanges((sec.exp || []).map((l) => sinceLine(leadRange(monthYears(l))))).filter((l) => !DURATION.test(l));
  const recs = labelledJobs(ex);
  out.work.push(...recs);
  const cols = recs.length ? null : columnJobs(ex);
  if (cols) { out.work.push(...cols.jobs); ex = [...ex.slice(0, cols.from), ...ex.slice(cols.to)]; }
  // «Position, Company LLP (City)» над строкой периода: так устроено все резюме, если перед первым периодом
  // стоит строка с организацией, а сразу после него организации и «Должность: …» нет
  // (строка организации прямо перед следующим периодом - это уже следующее место работы)
  const r0 = ex.findIndex((l) => RANGE.test(l));
  const hdrAfter = (k) => !!ex[k] && !RANGE.test(ex[k]) && (hasCompany(ex[k]) || POS_LABEL.test(ex[k])) && !RANGE.test(ex[k + 1] || '');
  // OncePlatform: шапка перед периодом и без известной орг.-правовой формы («Lead, North Caspian Operating Company B.V.,
  // Atyrau»): после периода сразу пункты описания, конец раздела или шапка следующего места работы с его периодом
  // OncePlatform: или «Title, Company, Country» строкой над каждым периодом (без орг.-правовой формы)
  const oneLineHdr = (l) => !!l && !RANGE.test(l) && !BULLET.test(l) && !/[.;:!?]$/.test(l) && l.split(/\s+/).length <= 12 && /[,|]/.test(l);
  const periods = ex.flatMap((l, i) => (RANGE.test(l) ? [i] : []));
  const before = r0 > 0 && !RANGE.test(ex[r0 - 1]) && !RANGE.test(ex[r0 + 1] || '') &&
    ((hasCompany(ex[r0 - 1]) && !hdrAfter(r0 + 1) && !hdrAfter(r0 + 2)) || !ex[r0 + 1] || BULLET.test(ex[r0 + 1]) || RANGE.test(ex[r0 + 2] || '') ||
      (periods.length >= 2 && periods.every((k) => oneLineHdr(ex[k - 1]))));
  // строка должности над строкой организации («Asset Data Engineer» / «Caspian Energy Services LLP, Atyrau» / период)
  const titleLine = (l) => !!l && !RANGE.test(l) && !BULLET.test(l) && !/[.;:!?]$/.test(l) && l.split(/\s+/).length <= 7 && !hasCompany(l) && !DURATION.test(l);
  const titleAbove = (i) => (before && i >= 2 && hasCompany(ex[i - 1]) && titleLine(ex[i - 2]) ? ex[i - 2] : null);
  // OncePlatform: организация строкой над «period Title» («Alpha LLP» / «Sept 2020 – Present | Contracts Manager»), если
  // под периодом организации нет
  const coBelow = (k) => !!ex[k + 1] && !RANGE.test(ex[k + 1]) && hasCompany(ex[k + 1]);
  const coAbove = (k) => k > 0 && !!ex[k] && hasCompany(ex[k - 1]) && !RANGE.test(ex[k - 1]) && !!restOf(ex[k]) && !hasCompany(restOf(ex[k])) && !coBelow(k);
  for (let i = 0; i < ex.length; i += 1) {
    if (recs.length) break; // записи с подписями полей уже дали места работы
    const m = ex[i].match(RANGE);
    if (!m) continue;
    const start = parseDate(m[1].trim());
    const endRaw = (m[2] ?? m[3] ?? '').trim();
    const end = isPresent(endRaw) ? null : parseDate(endRaw, true);
    if (!start || (end === null && !isPresent(endRaw))) { out.meta.warnings.push(`date:${ex[i]}`); }
    const rest = restOf(ex[i], m);
    let place = rest ? placeOf(rest) : null;
    let descFrom = i + 1;
    const lead = [];
    if (place && !place.company && coBelow(i)) {
      // OncePlatform: «Title | period», организация следующей строкой («Alpha LLP», «Beta LLP — project, City»)
      const sc = splitCompany(ex[i + 1]);
      place.company = sc.company;
      if (/\p{L}/u.test(sc.rest)) lead.push(sc.rest.replace(/^[\s–—-]+/u, ''));
      descFrom = i + 2;
    } else if (place && !place.company && coAbove(i)) {
      place.company = splitCompany(ex[i - 1]).company;
    } else if (!rest && before) {
      if (i > 0 && !RANGE.test(ex[i - 1])) place = placeOf(ex[i - 1]);
      const above = titleAbove(i);
      if (above && place && (!place.position || place.position.split(/\s+/).length <= 2) && !normTitle(place.position)?.prof) place.position = above;
    } else if (!rest) {
      // строки места работы после периода: «Должность» и «ТОО «…»», «ЖШС «…»» и «Лауазымы: …»,
      // «ТОО «…»» / город / отрасль / должность (hh.ru)
      const near = [];
      for (let j = i + 1; j < ex.length && j <= i + 5 && !RANGE.test(ex[j]) && !BULLET.test(ex[j]); j += 1) near.push(j);
      const jc = near.find((j) => hasCompany(ex[j]));
      const jl = near.find((j) => POS_LABEL.test(ex[j]));
      if (jc != null || jl != null) {
        const first = Math.min(...[jc, jl].filter((x) => x != null));
        const jp = near[0] < first ? near[0] : null; // должность строкой перед организацией
        const jt = jl == null && jp == null ? near.find((j) => j > first && normTitle(ex[j])?.prof) : undefined; // hh.ru
        const sc = jc != null ? splitCompany(ex[jc]) : { company: null };
        const position = (jl != null ? ex[jl].match(POS_LABEL)[1].trim() : '') || (jp != null ? posOf(ex[jp]) : '') || (jc != null ? posOf(ex[jc], sc) : '') || (jt != null ? posOf(ex[jt]) : '');
        place = { company: sc.company, position };
        descFrom = Math.max(...[jc, jl, jp, jt].filter((x) => x != null)) + 1;
      } else if (ex[i + 1] && !RANGE.test(ex[i + 1])) { place = placeOf(ex[i + 1]); descFrom = i + 2; }
    }
    const desc = lead;
    for (let j = descFrom; j < ex.length && !RANGE.test(ex[j]) && !(before && RANGE.test(ex[j + 1] || '')) && !(RANGE.test(ex[j + 2] || '') && titleAbove(j + 2) === ex[j]) && !coAbove(j + 1); j += 1) desc.push(ex[j]);
    // строки этого места работы: шапка, период, описание
    let k = i + 1;
    while (k < ex.length && !RANGE.test(ex[k])) k += 1;
    if ((before || coAbove(k)) && k < ex.length) k -= 1;
    const from = (before && i > 0 && !RANGE.test(ex[i - 1])) || coAbove(i) ? i - 1 : i;
    out.work.push(mkJob(place, start, end, desc, ex.slice(from, Math.max(from + 1, k))));
  }
  // образование: год окончания - последний год строки («2017 - Университет», «2016-2020 жж. Университет»,
  // «University, Almaty, 2014 - 2018», «…, 2016 -» / «2018»); год отдельной строкой - название в следующей (hh.ru)
  const ed = (sec.edu || []).map((l) => l.replace(/(?<!\d)((?:19|20)\d{2})((?:19|20)\d{2})(?!\d)/g, '$1 $2')); // «20102014»: тире потеряно
  for (let i = 0; i < ed.length; i += 1) {
    let l = ed[i];
    if (YEAR_DASH_END.test(l) && YEAR_START.test(ed[i + 1] || '')) { l = `${l} ${ed[i + 1]}`; i += 1; }
    const ys = l.match(YEARS);
    if (!ys) continue;
    let txt = l.replace(YEARS, ' ').replace(/(?<![\p{L}])(?:жж?|гг?)\.(?![\p{L}])/gu, ' ').replace(/\s+/g, ' ').replace(new RegExp(`\\s*${DASH}\\s*(?=,|$)`, 'g'), '').replace(/^[\s,|;:()\-\u2013\u2014]+|[\s,|;:()\-\u2013\u2014]+$/g, '').trim();
    if (!txt && ed[i + 1] && !ed[i + 1].match(YEARS)) { txt = ed[i + 1]; i += 1; }
    const parts = txt.split(/,\s*/).filter(Boolean);
    while (parts.length > 1 && parts[parts.length - 1].split(' ').length <= 2 && cityOf(parts[parts.length - 1]) != null) parts.pop(); // город в конце
    const [inst = '', ...area] = parts;
    out.education.push({ institution: inst.trim(), area: area.join(', ').trim() || null, endDate: ys[ys.length - 1] });
  }
  // языки
  for (const l of sec.langs || []) {
    const [a, b = ''] = l.split(/\s*[-\u2013\u2014:]\s*|\s+\(/);
    // «Казахский  Родной»: разделитель потерян - язык по первым словам строки
    const code = langOf(a) || langOf(a.split(' ').slice(0, 2).join(' ')) || langOf(a.split(' ')[0]);
    if (!code) continue;
    out.languages.push({ language: code, fluency: levelOf(b) || levelOf(l) });
  }
  // сертификаты
  for (const l of sec.certs || []) {
    const m = l.match(/^(.+?)\s*\((\d{4})\)\s*$/);
    out.certificates.push({ name: (m ? m[1] : l).trim(), date: m ? m[2] : null });
  }
  // OncePlatform: проекты. С периодами: «03.2021 - 05.2022 Название» или период строкой (название в той же строке, в
  // следующей или в строке перед периодом), затем «Роль: …», «Заказчик: …» и описание. Без периодов - каждая строка
  // (пункт списка) - проект, год в скобках в конце - год окончания; строка со строчной буквы продолжает описание.
  out.projects = parseProjects(joinRanges(sec.projects || []).filter((l) => !DURATION.test(l)));
  // навыки: по всему документу, кроме заголовка с личными данными
  const body = [...(sec.exp || []), ...(sec.skills || []), ...(sec.certs || []), ...(sec.edu || []), ...(sec.projects || []), ...(sec.summary || []), out.basics.label || ''].join('\n');
  const sk = matcher ? matcher(body) : new Set();
  out.skills = [...sk].sort().map((name) => ({ name }));
  // OncePlatform: краткое описание; пункты раздела «Навыки» как есть (словарь знает только ИТ-навыки) - cv.js сводит их
  // со словарными: «Operations Readiness; SAP PM; MS Excel», «Tools: Maximo, CMMS»
  if (sec.summary?.length) out.basics.summary = sec.summary.join(' ').slice(0, 2000);
  // после OCR пункты слишком шумные («TyeScript», «8PMN»): для сканов - только словарные навыки
  out.skillsRaw = [];
  for (const l of ocr ? [] : sec.skills || []) {
    const c = l.indexOf(':');
    const v = c > 0 && c < 30 ? l.slice(c + 1) : l;
    for (const part of v.split(/\s*[,;•·|▪●]\s*|\.\s+|\s+[–—-]\s+/u)) {
      const s = part.replace(BULLET, '').replace(/[.\s]+$/, '').trim();
      if (s.length < 2 || s.length > 60 || !/\p{L}/u.test(s) || s.split(/\s+/).length > 6) continue;
      // «Английский - B2» в разделе навыков, заголовки; OncePlatform: «Продвинутый уровень AutoCAD и Civil 3D» - навык
      if (langOf(s) || (levelOf(s) && s.split(/\s+/).length <= 2) || headingOf(s)) continue;
      out.skillsRaw.push(s);
    }
  }
  // должности вне таксономии: ближайшая профессия (при нескольких кандидатах - по навыкам), пометка approx и причина
  const have = new Set(sk);
  if (out.meta.title?.approx) out.meta.title = nearProf(out.meta.title, have);
  for (const w of out.work) {
    if (!w.near) continue;
    const r = nearProf(w.near, have);
    delete w.near;
    Object.assign(w, { prof: r.prof, approx: r.approx, why: { bySkills: r.bySkills, skills: r.skills } });
  }
  // стаж
  out.meta.totalMonths = totalMonths(out.work.map((w) => ({ start: w.startDate, end: w.endDate })));
  out.meta.totalYears = Math.round(out.meta.totalMonths / 6) / 2;
  if (!out.work.length) out.meta.warnings.push('work');
  if (!B.email && !B.phone) out.meta.warnings.push('contacts');
  const t1 = typeof performance !== 'undefined' ? performance.now() : Date.now();
  out.meta.ms = Math.round((t1 - t0) * 100) / 100;
  return out;
}
