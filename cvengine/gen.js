// Генератор синтетических резюме и вакансий (п. 3.3 ТЗ). Все имена, контакты, организации и вузы вымышлены.
// Генерация детерминированная (seed): один и тот же набор у всех, кто открывает демо.
// Для каждого резюме хранится «истина» (эталонная разметка) и текст документа на одном из трёх языков;
// для сканов и фотографий - текст после OCR с типичными ошибками распознавания.
import { SKILL_DICT, buildMatcher } from './skills.js';

const findSkills = buildMatcher(SKILL_DICT);

export function rng(seed) {
  let a = seed >>> 0;
  return () => { a += 0x6d2b79f5; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const pick = (r, a) => a[Math.floor(r() * a.length)];
const shuffle = (r, a) => { const b = [...a]; for (let i = b.length - 1; i > 0; i -= 1) { const j = Math.floor(r() * (i + 1)); [b[i], b[j]] = [b[j], b[i]]; } return b; };

export const NOW_YM = '2026-11';
export const ymToN = (ym) => { const [y, m] = ym.split('-').map(Number); return y * 12 + (m - 1); };
const nToYm = (n) => `${Math.floor(n / 12)}-${String((n % 12) + 1).padStart(2, '0')}`;

// ------------------------------------------------------------------ профессии
export const PROFS = {
  python: { t: { ru: 'Python-разработчик', kk: 'Python-әзірлеуші', en: 'Python Developer' }, core: ['Python', 'Django', 'FastAPI', 'PostgreSQL', 'Docker', 'REST API', 'Git', 'SQL'], extra: ['Redis', 'Celery', 'Kafka', 'Linux', 'AWS', 'pytest', 'Kubernetes'], certs: [] },
  java: { t: { ru: 'Java-разработчик', kk: 'Java-әзірлеуші', en: 'Java Developer' }, core: ['Java', 'Spring Boot', 'Hibernate', 'PostgreSQL', 'SQL', 'Git', 'Maven', 'REST API'], extra: ['Kafka', 'Oracle', 'Docker', 'Kubernetes', 'Microservices', 'JUnit'], certs: ['Oracle Certified Professional, Java SE'] },
  frontend: { t: { ru: 'Frontend-разработчик', kk: 'Frontend-әзірлеуші', en: 'Frontend Developer' }, core: ['JavaScript', 'TypeScript', 'React', 'HTML', 'CSS', 'Git'], extra: ['Redux', 'Vue.js', 'Next.js', 'Webpack', 'Jest', 'Node.js'], certs: [] },
  qa_auto: { t: { ru: 'QA-инженер по автоматизации', kk: 'Автоматтандыру бойынша QA-инженер', en: 'QA Automation Engineer' }, core: ['Selenium', 'Playwright', 'Python', 'pytest', 'Postman', 'SQL', 'API testing'], extra: ['Java', 'JMeter', 'CI/CD', 'Jira', 'Git', 'Docker'], certs: ['ISTQB Foundation Level'] },
  qa_manual: { t: { ru: 'Тестировщик', kk: 'Тестілеуші', en: 'QA Engineer' }, core: ['Test design', 'Jira', 'Postman', 'SQL', 'API testing', 'Regression testing'], extra: ['TestRail', 'Mobile testing', 'Confluence', 'JMeter'], certs: ['ISTQB Foundation Level'] },
  devops: { t: { ru: 'DevOps-инженер', kk: 'DevOps-инженер', en: 'DevOps Engineer' }, core: ['Linux', 'Docker', 'Kubernetes', 'Terraform', 'Ansible', 'GitLab CI', 'Bash'], extra: ['AWS', 'Prometheus', 'Grafana', 'Helm', 'Nginx', 'Jenkins', 'Python'], certs: ['Certified Kubernetes Administrator (CKA)', 'AWS Certified Solutions Architect - Associate'] },
  analyst: { t: { ru: 'Аналитик данных', kk: 'Деректер талдаушысы', en: 'Data Analyst' }, core: ['SQL', 'Python', 'Pandas', 'Power BI', 'Excel', 'Statistics'], extra: ['Tableau', 'ClickHouse', 'A/B testing', 'Airflow'], certs: ['Microsoft Certified: Power BI Data Analyst'] },
  ba: { t: { ru: 'Бизнес-аналитик', kk: 'Бизнес-талдаушы', en: 'Business Analyst' }, core: ['Requirements analysis', 'BPMN', 'UML', 'SQL', 'Jira', 'Confluence'], extra: ['User stories', 'Camunda', 'REST API'], certs: ['IIBA ECBA'] },
  support: { t: { ru: 'Инженер технической поддержки', kk: 'Техникалық қолдау инженері', en: 'Technical Support Engineer' }, core: ['Linux', 'SQL', 'Jira', 'ITIL', 'Networking'], extra: ['Windows Server', 'Active Directory', 'Bash', 'Monitoring'], certs: ['ITIL 4 Foundation'] },
  mobile: { t: { ru: 'Мобильный разработчик', kk: 'Мобильді әзірлеуші', en: 'Mobile Developer' }, core: ['Flutter', 'Dart', 'Kotlin', 'Android', 'REST API', 'Git'], extra: ['Swift', 'iOS', 'Firebase'], certs: [] },
  ml: { t: { ru: 'ML-инженер', kk: 'ML-инженер', en: 'Machine Learning Engineer' }, core: ['Python', 'PyTorch', 'scikit-learn', 'Pandas', 'SQL', 'Docker'], extra: ['NLP', 'LLM', 'Computer vision', 'MLflow'], certs: [] },
  pm: { t: { ru: 'Руководитель проектов', kk: 'Жоба жетекшісі', en: 'Project Manager' }, core: ['Scrum', 'Agile', 'Jira', 'Confluence', 'Risk management'], extra: ['Kanban', 'Budgeting'], certs: ['Project Management Professional (PMP)'] },
  dba: { t: { ru: 'Администратор баз данных', kk: 'Дерекқор әкімшісі', en: 'Database Administrator' }, core: ['PostgreSQL', 'SQL', 'Performance tuning', 'Backup', 'Replication', 'Linux'], extra: ['Oracle', 'Bash', 'MySQL'], certs: [] },
  // бэкенд без языка или на Go, .NET, PHP, Node.js (Python и Java - свои профессии); в генераторе не участвует (нет в PROF_W)
  backend: { t: { ru: 'Backend-разработчик', kk: 'Backend-әзірлеуші', en: 'Backend Developer' }, core: ['Go', 'REST API', 'Microservices', 'PostgreSQL', 'Docker', 'SQL', 'Git'], extra: ['Kafka', 'Redis', 'Kubernetes'], certs: [] },
};
// доля профессий в базе резюме (сколько откликов обычно приходит на ИТ-вакансии)
const PROF_W = { python: 11, java: 9, frontend: 11, qa_auto: 8, qa_manual: 8, devops: 9, analyst: 8, ba: 6, support: 8, mobile: 7, ml: 5, pm: 5, dba: 5 };
const wpick = (r, w) => { const tot = Object.values(w).reduce((a, b) => a + b, 0); let x = r() * tot; for (const [k, v] of Object.entries(w)) { x -= v; if (x < 0) return k; } return Object.keys(w)[0]; };
const SENIOR = { ru: ['Младший ', '', 'Ведущий '], kk: ['Кіші ', '', 'Аға '], en: ['Junior ', '', 'Senior '] };

// ------------------------------------------------------------------ имена и организации (вымышленные)
const FIRST_M = ['Арман', 'Ерлан', 'Данияр', 'Нурлан', 'Тимур', 'Алексей', 'Дмитрий', 'Сергей', 'Марат', 'Азамат', 'Олжас', 'Бауыржан', 'Руслан', 'Иван', 'Максим', 'Ерасыл', 'Санжар', 'Артем'];
const FIRST_F = ['Айгерим', 'Дана', 'Асель', 'Салтанат', 'Мадина', 'Алина', 'Екатерина', 'Анна', 'Жанна', 'Гульнара', 'Камила', 'Динара', 'Ольга', 'Мария', 'Аружан', 'Томирис', 'Виктория', 'Ажар'];
const LAST = [['Ахметов', 'Ахметова'], ['Сериков', 'Серикова'], ['Касымов', 'Касымова'], ['Иванов', 'Иванова'], ['Ким', 'Ким'], ['Нурланов', 'Нурланова'], ['Жумабеков', 'Жумабекова'], ['Петров', 'Петрова'], ['Абдрахманов', 'Абдрахманова'], ['Омаров', 'Омарова'], ['Смагулов', 'Смагулова'], ['Тлеубаев', 'Тлеубаева'], ['Беков', 'Бекова'], ['Садыков', 'Садыкова'], ['Ли', 'Ли'], ['Кузнецов', 'Кузнецова'], ['Есенов', 'Есенова'], ['Мухамедов', 'Мухамедова']];
const TR = { а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z', и: 'i', й: 'y', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'kh', ц: 'ts', ч: 'ch', ш: 'sh', щ: 'sch', ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya', ә: 'a', ғ: 'g', қ: 'k', ң: 'n', ө: 'o', ұ: 'u', ү: 'u', һ: 'h', і: 'i' };
export const translit = (s) => s.split('').map((ch) => { const l = ch.toLowerCase(); const t = TR[l]; if (t === undefined) return ch; return ch === l ? t : t.charAt(0).toUpperCase() + t.slice(1); }).join('');
const COMP = ['Нурсофт', 'Дала Диджитал', 'Тенгри Дата', 'Алтын Код', 'Шыгыс Тех', 'Жетысу Инфо', 'Сарыарка Системс', 'Каспий Девелопмент', 'Байтерек Лабс', 'Кайнар Софт', 'Есиль Солюшнс', 'Арай Технолоджис', 'Бирлик Дата', 'Аспан Девелопмент', 'Тумар Финтех', 'Акжол Логистик', 'Самал Ритейл', 'Жулдыз Телеком', 'Кемел Банк Сервис', 'Орда Консалтинг'];
const UNI = [
  { ru: 'Технический университет Сарыарки', kk: 'Сарыарқа техникалық университеті', en: 'Saryarka Technical University' },
  { ru: 'Каспийский университет цифровых технологий', kk: 'Каспий цифрлық технологиялар университеті', en: 'Caspian University of Digital Technologies' },
  { ru: 'Университет Степного края', kk: 'Дала өлкесі университеті', en: 'Steppe Region University' },
  { ru: 'Северный политехнический университет', kk: 'Солтүстік политехникалық университеті', en: 'Northern Polytechnic University' },
  { ru: 'Международный университет «Алтын Орда»', kk: '«Алтын Орда» халықаралық университеті', en: 'Altyn Orda International University' },
];
const AREA = [
  { ru: 'Информационные системы', kk: 'Ақпараттық жүйелер', en: 'Information Systems' },
  { ru: 'Вычислительная техника и программное обеспечение', kk: 'Есептеу техникасы және бағдарламалық қамтамасыз ету', en: 'Computer Engineering and Software' },
  { ru: 'Прикладная математика', kk: 'Қолданбалы математика', en: 'Applied Mathematics' },
  { ru: 'Экономика', kk: 'Экономика', en: 'Economics' },
];
export const CITIES = [
  { ru: 'Астана', kk: 'Астана', en: 'Astana' }, { ru: 'Алматы', kk: 'Алматы', en: 'Almaty' }, { ru: 'Шымкент', kk: 'Шымкент', en: 'Shymkent' },
  { ru: 'Караганда', kk: 'Қарағанды', en: 'Karaganda' }, { ru: 'Актобе', kk: 'Ақтөбе', en: 'Aktobe' }, { ru: 'Павлодар', kk: 'Павлодар', en: 'Pavlodar' },
];
const CITY_W = [0.34, 0.3, 0.1, 0.1, 0.08, 0.08];
const LANG_NAMES = {
  kk: { ru: 'Казахский', kk: 'Қазақ тілі', en: 'Kazakh' },
  ru: { ru: 'Русский', kk: 'Орыс тілі', en: 'Russian' },
  en: { ru: 'Английский', kk: 'Ағылшын тілі', en: 'English' },
};
const LEVELS = {
  native: { ru: 'родной', kk: 'ана тілі', en: 'native' },
  fluent: { ru: 'свободно', kk: 'еркін', en: 'fluent' },
};
const MONTHS = {
  ru: ['январь', 'февраль', 'март', 'апрель', 'май', 'июнь', 'июль', 'август', 'сентябрь', 'октябрь', 'ноябрь', 'декабрь'],
  kk: ['қаңтар', 'ақпан', 'наурыз', 'сәуір', 'мамыр', 'маусым', 'шілде', 'тамыз', 'қыркүйек', 'қазан', 'қараша', 'желтоқсан'],
  en: ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'],
};
const PRESENT = { ru: ['настоящее время', 'н.в.', 'по настоящее время'], kk: ['қазіргі уақытқа дейін', 'қазір'], en: ['present', 'now'] };
const H = {
  ru: { exp: ['ОПЫТ РАБОТЫ', 'Опыт работы'], edu: ['ОБРАЗОВАНИЕ', 'Образование'], skills: ['НАВЫКИ', 'Ключевые навыки'], langs: ['ЯЗЫКИ', 'Знание языков'], certs: ['СЕРТИФИКАТЫ', 'Сертификаты'], city: 'Город', phone: 'Телефон', email: 'E-mail', birth: 'Дата рождения', gender: 'Пол', male: 'мужской', female: 'женский', marital: 'Семейное положение', married: ['женат', 'замужем'], single: ['холост', 'не замужем'] },
  kk: { exp: ['ЖҰМЫС ТӘЖІРИБЕСІ', 'Жұмыс тәжірибесі'], edu: ['БІЛІМІ', 'Білімі'], skills: ['ДАҒДЫЛАР', 'Кәсіби дағдылар'], langs: ['ТІЛДЕР', 'Тілдерді білуі'], certs: ['СЕРТИФИКАТТАР', 'Сертификаттар'], city: 'Қала', phone: 'Телефон', email: 'E-mail', birth: 'Туған күні', gender: 'Жынысы', male: 'ер', female: 'әйел', marital: 'Отбасылық жағдайы', married: ['үйленген', 'тұрмыста'], single: ['бойдақ', 'тұрмыс құрмаған'] },
  en: { exp: ['EXPERIENCE', 'Work experience'], edu: ['EDUCATION', 'Education'], skills: ['SKILLS', 'Key skills'], langs: ['LANGUAGES', 'Languages'], certs: ['CERTIFICATIONS', 'Certificates'], city: 'City', phone: 'Phone', email: 'Email', birth: 'Date of birth', gender: 'Gender', male: 'male', female: 'female', marital: 'Marital status', married: ['married', 'married'], single: ['single', 'single'] },
};
const DESC = {
  ru: [(a, b) => `Разработка и сопровождение решений с использованием ${a} и ${b}.`, (a, b) => `Задачи: ${a}, ${b}, участие в код-ревью и планировании.`, (a, b) => `Внедрение ${a}, настройка ${b}, документирование.`],
  kk: [(a, b) => `${a} және ${b} қолдана отырып шешімдерді әзірлеу және сүйемелдеу.`, (a, b) => `Міндеттер: ${a}, ${b}, код-ревьюге қатысу.`, (a, b) => `${a} енгізу, ${b} баптау, құжаттау.`],
  en: [(a, b) => `Built and maintained solutions using ${a} and ${b}.`, (a, b) => `Responsibilities: ${a}, ${b}, code reviews and sprint planning.`, (a, b) => `Introduced ${a}, configured ${b}, wrote documentation.`],
};
const LEGAL = { ru: (c) => `ТОО «${c}»`, kk: (c) => `«${c}» ЖШС`, en: (c) => `${translit(c)} LLP` };

// ------------------------------------------------------------------ один кандидат (истина)
export function makeTruth(r, i, forceProf) {
  const gender = r() < 0.48 ? 'f' : 'm';
  const first = pick(r, gender === 'f' ? FIRST_F : FIRST_M);
  const lastPair = pick(r, LAST);
  const last = gender === 'f' ? lastPair[1] : lastPair[0];
  const prof = forceProf || wpick(r, PROF_W);
  const P = PROFS[prof];
  let x = r(); let ci = 0; while (x > CITY_W[ci] && ci < CITY_W.length - 1) { x -= CITY_W[ci]; ci += 1; }
  const docLang = (() => { const y = r(); return y < 0.45 ? 'ru' : y < 0.7 ? 'en' : y < 0.88 ? 'kk' : 'mix'; })();
  const format = (() => { const y = r(); return y < 0.4 ? 'pdf' : y < 0.76 ? 'docx' : y < 0.9 ? 'scan' : 'photo'; })();
  const years = Math.round((0.5 + r() * r() * 12) * 2) / 2;
  const birthYear = 2026 - 21 - Math.round(years) - Math.floor(r() * 8);
  // работа: от недавнего к раннему
  const jobs = [];
  let end = r() < 0.85 ? null : ymToN(NOW_YM) - 1 - Math.floor(r() * 5);
  let left = Math.max(6, Math.round(years * 12));
  let cursor = end ?? ymToN(NOW_YM);
  const nJobs = Math.min(4, 1 + Math.floor(left / 30) + (r() < 0.3 ? 1 : 0));
  const switched = r() < 0.18 && nJobs > 1; // ранняя работа в другой профессии
  const comps = shuffle(r, COMP);
  for (let k = 0; k < nJobs && left > 0; k += 1) {
    const dur = k === nJobs - 1 ? left : Math.max(6, Math.round(left / (nJobs - k) * (0.7 + r() * 0.6)));
    const start = cursor - dur;
    const jprof = switched && k === nJobs - 1 ? pick(r, ['support', 'qa_manual', 'analyst']) : prof;
    const sen = k === 0 && years >= 6 ? 2 : k === nJobs - 1 && years < 3 ? 0 : 1;
    const senF = ['pm', 'ba'].includes(jprof) && sen === 0 ? 1 : sen; // «младший руководитель проектов» в резюме не пишут
    jobs.push({ company: comps[k], prof: jprof, sen: senF, start: nToYm(start), end: k === 0 && end === null ? null : nToYm(cursor) });
    left -= dur; cursor = start - Math.floor(r() * 3);
    if (k === 0) end = 0;
  }
  const skills = new Set(shuffle(r, P.core).slice(0, Math.max(3, Math.round(P.core.length * (0.68 + r() * 0.32)))));
  for (const s of shuffle(r, P.extra).slice(0, Math.floor(r() * 4))) skills.add(s);
  if (switched) for (const s of shuffle(r, PROFS[jobs[jobs.length - 1].prof].core).slice(0, 2)) skills.add(s);
  const enLevel = pick(r, ['A2', 'B1', 'B1', 'B2', 'B2', 'C1']);
  const native = r() < 0.65 ? 'kk' : 'ru';
  const langs = [{ lang: native, level: 'native' }, { lang: native === 'kk' ? 'ru' : 'kk', level: native === 'kk' ? 'fluent' : pick(r, ['A2', 'B1', 'B2', 'fluent']) }, { lang: 'en', level: enLevel }];
  const certs = P.certs.length && r() < 0.35 ? [{ name: pick(r, P.certs), year: 2026 - Math.floor(r() * 5) }] : [];
  // навык, названный в должности или сертификате, у кандидата есть (Python-разработчик знает Python)
  if (prof === 'python') skills.add('Python');
  if (prof === 'java') skills.add('Java');
  for (const c of certs) for (const s of findSkills(c.name)) skills.add(s);
  const uni = Math.floor(r() * UNI.length);
  const edu = [{ uni, area: Math.floor(r() * AREA.length), year: Math.min(2026, birthYear + 22) }];
  return {
    id: `C${String(i + 1).padStart(4, '0')}`, gender, first, last, prof, city: ci, docLang, format, years,
    birth: `${birthYear}-${String(1 + Math.floor(r() * 12)).padStart(2, '0')}-${String(1 + Math.floor(r() * 28)).padStart(2, '0')}`,
    married: r() < 0.5, photo: r() < 0.3, showSensitive: r() < 0.45, layout: Math.floor(r() * 3), nameOrder: r() < 0.5 ? 0 : 1,
    phone: `+7 7${pick(r, ['01', '02', '05', '07', '47', '71', '77'])} 555 ${String(Math.floor(r() * 100)).padStart(2, '0')} ${String(Math.floor(r() * 100)).padStart(2, '0')}`,
    jobs, skills: [...skills], langs, certs, edu, synSeed: Math.floor(r() * 1e9),
  };
}

// ------------------------------------------------------------------ текст документа
const surface = (r, s) => { const syn = SKILL_DICT[s]?.syn || []; return syn.length && r() < 0.35 ? pick(r, syn) : s; };
// «Младший тестировщик», но «Младший Python-разработчик»: после приставки слово со строчной, если это не аббревиатура
export const position = (j, L) => {
  const pre = ['pm', 'ba'].includes(j.prof) && j.sen === 0 ? '' : SENIOR[L][j.sen];
  const title = PROFS[j.prof].t[L];
  if (!pre || L === 'en') return pre + title;
  return pre + (/^[А-ЯЁӘҒҚҢӨҰҮҺІ][а-яёәғқңөұүһі]/.test(title) ? title.charAt(0).toLowerCase() + title.slice(1) : title);
};
export const fullName = (t, L) => { const f = L === 'en' ? translit(t.first) : t.first; const l = L === 'en' ? translit(t.last) : t.last; return t.nameOrder ? `${l} ${f}` : `${f} ${l}`; };
export const emailOf = (t) => `${translit(t.first).toLowerCase()}.${translit(t.last).toLowerCase()}${Number(t.id.slice(1)) % 7 === 0 ? Number(t.id.slice(1)) % 100 : ''}@example.com`;
const fmtDate = (ym, L, style) => {
  if (!ym) return null;
  const [y, m] = ym.split('-').map(Number);
  if (style === 0) return `${String(m).padStart(2, '0')}.${y}`;
  if (style === 1) return L === 'kk' ? `${y} ж. ${MONTHS.kk[m - 1]}` : `${MONTHS[L][m - 1]} ${y}`;
  return `${y}-${String(m).padStart(2, '0')}`;
};

export function renderCV(t, opts = {}) {
  const r = rng(t.synSeed);
  const L0 = t.docLang === 'mix' ? 'ru' : t.docLang; // язык заголовков
  const LP = t.docLang === 'mix' ? 'en' : L0; // язык должностей и описаний
  const h = H[L0];
  const hv = r() < 0.5 ? 0 : 1;
  const ds = Math.floor(r() * 3);
  const lines = [];
  const name = fullName(t, L0 === 'en' ? 'en' : 'ru');
  const title = position({ prof: t.prof, sen: t.jobs[0]?.sen ?? 1 }, LP);
  const city = CITIES[t.city][L0];
  lines.push(name, title);
  if (t.layout === 1) lines.push(`${city} · ${t.phone} · ${emailOf(t)}`);
  else { lines.push(`${h.city}: ${city}`, `${h.phone}: ${t.phone}`, `${h.email}: ${emailOf(t)}`); }
  if (t.showSensitive) {
    const [y, m, d] = t.birth.split('-');
    lines.push(`${h.birth}: ${d}.${m}.${y}`, `${h.gender}: ${t.gender === 'f' ? h.female : h.male}`, `${h.marital}: ${t.married ? h.married[t.gender === 'f' ? 1 : 0] : h.single[t.gender === 'f' ? 1 : 0]}`);
  }
  lines.push('', h.exp[hv]);
  const skillList = [...t.skills];
  t.jobs.forEach((j, k) => {
    const s = fmtDate(j.start, LP === 'kk' ? 'kk' : LP, ds);
    const e = j.end ? fmtDate(j.end, LP === 'kk' ? 'kk' : LP, ds) : pick(r, PRESENT[L0]);
    const pos = position(j, LP);
    const comp = LEGAL[LP](j.company);
    if (t.layout === 0) lines.push(`${s} - ${e}`, `${pos}, ${comp}`);
    else if (t.layout === 1) lines.push(`${pos} | ${comp} | ${s} - ${e}`);
    else lines.push(`${comp}, ${pos} (${s} - ${e})`);
    const own = j.prof === t.prof ? skillList : PROFS[j.prof].core.filter((x) => t.skills.includes(x));
    const a = own[(k * 2) % Math.max(1, own.length)];
    const b = own[(k * 2 + 1) % Math.max(1, own.length)];
    if (a && b && a !== b) lines.push(pick(r, DESC[LP])(surface(r, a), surface(r, b)));
    lines.push('');
  });
  lines.push(h.edu[hv]);
  for (const e of t.edu) lines.push(`${e.year} - ${UNI[e.uni][L0]}, ${AREA[e.area][L0]}`);
  lines.push('', h.skills[hv]);
  const sk = shuffle(r, skillList).map((x) => surface(r, x));
  lines.push(t.layout === 1 ? sk.map((x) => `• ${x}`).join(' ') : sk.join(', '));
  lines.push('', h.langs[hv]);
  for (const l of t.langs) lines.push(`${LANG_NAMES[l.lang][L0]} - ${LEVELS[l.level] ? LEVELS[l.level][L0] : l.level}`);
  if (t.certs.length) { lines.push('', h.certs[hv]); for (const c of t.certs) lines.push(`${c.name} (${c.year})`); }
  return lines.join('\n');
}

// ошибки OCR: похожие символы, потеря казахских букв, пропуски
const CONF = { О: '0', о: 'о', l: '1', I: 'l', е: 'e', а: 'a', с: 'c', р: 'p', ә: 'а', ұ: 'у', қ: 'к', ң: 'н', ғ: 'г', ө: 'о', ү: 'у', і: 'i', ш: 'щ', ',': '.', 'и': 'н', B: '8', S: '5' };
export function ocrNoise(text, p, seed) {
  const r = rng(seed);
  let out = '';
  for (const ch of text) {
    const x = r();
    if (ch !== '\n' && x < p * 0.15) continue; // пропуск символа
    if (CONF[ch] && x < p) { out += CONF[ch]; continue; }
    out += ch;
  }
  return out;
}

// ------------------------------------------------------------------ набор данных
let CACHE = null;
export function dataset(n = 1000) {
  if (CACHE && CACHE.length === n) return CACHE;
  const r = rng(20261104);
  const out = [];
  for (let i = 0; i < n; i += 1) {
    const t = makeTruth(r, i);
    const text = renderCV(t);
    const doc = t.format === 'scan' ? { text: ocrNoise(text, 0.018, t.synSeed + 1), ocr: 0.9 + ((t.synSeed % 60) / 1000) } : t.format === 'photo' ? { text: ocrNoise(text, 0.035, t.synSeed + 2), ocr: 0.82 + ((t.synSeed % 70) / 1000) } : { text, ocr: null };
    out.push({ truth: t, clean: text, ...doc });
  }
  CACHE = out;
  return out;
}

// вариант резюме для проверки на предвзятость: другое имя, пол, возраст, семейное положение, фото
export function biasVariant(t, k) {
  const r = rng(t.synSeed + 77 + k);
  const gender = t.gender === 'f' ? 'm' : 'f';
  const first = pick(r, gender === 'f' ? FIRST_F : FIRST_M);
  const lastPair = pick(r, LAST);
  const y = Number(t.birth.slice(0, 4)) + (r() < 0.5 ? -9 : 9);
  return { ...t, gender, first, last: gender === 'f' ? lastPair[1] : lastPair[0], birth: `${y}${t.birth.slice(4)}`, married: !t.married, photo: !t.photo, showSensitive: true };
}

// ------------------------------------------------------------------ вакансии
const V = (id, prof, title, must, nice, minYears, lang, city, fmt) => ({ id, prof, title, must, nice, minYears, lang, city, fmt });
export const VACANCIES = [
  V('V01', 'python', { ru: 'Python-разработчик (backend)', kk: 'Python-әзірлеуші (backend)', en: 'Python Developer (backend)' }, ['Python', 'Django', 'PostgreSQL', 'Docker'], ['Redis', 'Celery', 'Kafka'], 3, null, [0], 'hybrid'),
  V('V02', 'java', { ru: 'Java-разработчик', kk: 'Java-әзірлеуші', en: 'Java Developer' }, ['Java', 'Spring Boot', 'SQL'], ['Kafka', 'Microservices', 'Docker'], 3, null, [1], 'office'),
  V('V03', 'frontend', { ru: 'Frontend-разработчик (React)', kk: 'Frontend-әзірлеуші (React)', en: 'Frontend Developer (React)' }, ['JavaScript', 'TypeScript', 'React'], ['Redux', 'Next.js', 'Jest'], 2, { lang: 'en', level: 'B1' }, null, 'remote'),
  V('V04', 'qa_auto', { ru: 'QA-инженер по автоматизации', kk: 'Автоматтандыру бойынша QA-инженер', en: 'QA Automation Engineer' }, ['Python', 'pytest', 'API testing'], ['Playwright', 'Selenium', 'CI/CD'], 2, null, [0], 'hybrid'),
  V('V05', 'qa_manual', { ru: 'Тестировщик (ручное тестирование)', kk: 'Тестілеуші (қолмен тестілеу)', en: 'QA Engineer (manual)' }, ['Test design', 'Jira', 'API testing'], ['Postman', 'SQL', 'Mobile testing'], 1, null, [2, 0], 'office'),
  V('V06', 'devops', { ru: 'DevOps-инженер', kk: 'DevOps-инженер', en: 'DevOps Engineer' }, ['Linux', 'Docker', 'Kubernetes'], ['GitLab CI', 'Terraform', 'Ansible', 'Prometheus'], 3, null, [1, 0], 'hybrid'),
  V('V07', 'analyst', { ru: 'Аналитик данных', kk: 'Деректер талдаушысы', en: 'Data Analyst' }, ['SQL', 'Python', 'Power BI'], ['Pandas', 'Statistics', 'A/B testing'], 2, null, [0], 'office'),
  V('V08', 'ba', { ru: 'Бизнес-аналитик', kk: 'Бизнес-талдаушы', en: 'Business Analyst' }, ['Requirements analysis', 'BPMN', 'SQL'], ['UML', 'Confluence', 'User stories'], 2, { lang: 'kk', level: 'fluent' }, [0, 1], 'hybrid'),
  V('V09', 'support', { ru: 'Инженер технической поддержки (L2)', kk: 'Техникалық қолдау инженері (L2)', en: 'Technical Support Engineer (L2)' }, ['Linux', 'SQL', 'ITIL'], ['Networking', 'Bash'], 1, null, [3, 0], 'office'),
  V('V10', 'mobile', { ru: 'Flutter-разработчик', kk: 'Flutter-әзірлеуші', en: 'Flutter Developer' }, ['Flutter', 'Dart', 'REST API'], ['Firebase', 'Kotlin', 'Swift'], 2, null, null, 'remote'),
  V('V11', 'ml', { ru: 'ML-инженер', kk: 'ML-инженер', en: 'Machine Learning Engineer' }, ['Python', 'PyTorch', 'SQL'], ['NLP', 'LLM', 'MLflow'], 2, { lang: 'en', level: 'B2' }, [1, 0], 'hybrid'),
  V('V12', 'pm', { ru: 'Руководитель ИТ-проектов', kk: 'АТ жобаларының жетекшісі', en: 'IT Project Manager' }, ['Scrum', 'Jira', 'Risk management'], ['Kanban', 'Budgeting', 'Confluence'], 4, null, [0], 'office'),
  V('V13', 'dba', { ru: 'Администратор PostgreSQL', kk: 'PostgreSQL әкімшісі', en: 'PostgreSQL Administrator' }, ['PostgreSQL', 'Replication', 'Backup'], ['Performance tuning', 'Bash'], 3, null, [0, 1], 'office'),
  V('V14', 'python', { ru: 'Senior Python-разработчик', kk: 'Аға Python-әзірлеуші', en: 'Senior Python Developer' }, ['Python', 'FastAPI', 'PostgreSQL', 'Kafka'], ['Kubernetes', 'Redis', 'AWS'], 5, { lang: 'en', level: 'B2' }, [1], 'hybrid'),
  V('V15', 'frontend', { ru: 'Frontend-разработчик (Vue)', kk: 'Frontend-әзірлеуші (Vue)', en: 'Frontend Developer (Vue)' }, ['JavaScript', 'Vue.js', 'CSS'], ['TypeScript', 'Webpack'], 1, null, [0], 'office'),
  V('V16', 'qa_manual', { ru: 'Младший тестировщик', kk: 'Кіші тестілеуші', en: 'Junior QA Engineer' }, ['Test design', 'Jira'], ['SQL', 'Postman'], 0, null, null, 'remote'),
  V('V17', 'devops', { ru: 'SRE / Kubernetes-инженер', kk: 'SRE / Kubernetes-инженер', en: 'SRE / Kubernetes Engineer' }, ['Kubernetes', 'Helm', 'Prometheus'], ['Grafana', 'Terraform', 'AWS'], 4, null, null, 'remote'),
  V('V18', 'analyst', { ru: 'BI-аналитик (Power BI)', kk: 'BI-талдаушы (Power BI)', en: 'BI Analyst (Power BI)' }, ['Power BI', 'SQL', 'Excel'], ['ClickHouse', 'Tableau'], 2, null, [1], 'hybrid'),
  V('V19', 'mobile', { ru: 'Android-разработчик (Kotlin)', kk: 'Android-әзірлеуші (Kotlin)', en: 'Android Developer (Kotlin)' }, ['Kotlin', 'Android', 'REST API'], ['Firebase', 'Git'], 2, null, [0], 'office'),
  V('V20', 'support', { ru: 'Специалист поддержки первой линии', kk: 'Бірінші желі қолдау маманы', en: 'First-line Support Specialist' }, ['Jira', 'Networking'], ['ITIL', 'Linux'], 0, { lang: 'kk', level: 'fluent' }, [0], 'office'),
];

export const CITY_LIST = CITIES;
export const UNIS = UNI;
export const AREAS = AREA;
export const LANG_LABEL = LANG_NAMES;
