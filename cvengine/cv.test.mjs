// node --test cvengine/  (also run in the Docker build)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { badLabel, canonSkill, cleanLabel, fixCertificates, fixEducation, fixJobs, match, meta, parse, refresh, unfragment } from './cv.js';
import { dataset } from './gen.js';

// layouts misread on real CVs, reproduced with fictional companies
test('layout fixes: companies, places and duties as job titles, schools as jobs', () => {
  const job = (position, name, startDate = '2020-01', endDate = '2021-01') => ({ position, name, startDate, endDate });
  const p = { meta: { totalMonths: 0 }, education: [], work: [
    job('ТОО “Альфа Технолоджис”', null),
    job('Delta Group', 'Maintenance Engineer'),
    job('Kappa - Karachaganak field', '«KEP EPC Project»'),
    job('ЗКО, Аксай', 'ТОО Сигма'),
    job('Омега', 'ТОО'),
    job('• Maintained transformer power supply systems and switchgear.', null),
    job('Electrical Engineer', 'АО Бета'),
    job('North Technical University', 'Uralsk', '2016-09', '2020-06'),
    job('Facilities Manager, Gamma Company', null),
    job(null, 'School-Lyceum No. 5'),
    job('• Omega Catering – Angola   : Offshore Camp Manager.', null),
    job('Aksai Technical College', null),
  ] };
  fixJobs(p);
  const rows = p.work.map((w) => [w.position, w.name]);
  assert.deepEqual(rows, [
    [null, 'ТОО “Альфа Технолоджис”'],
    ['Maintenance Engineer', 'Delta Group'],
    [null, 'Kappa - Karachaganak field, «KEP EPC Project»'],
    [null, 'ТОО Сигма'],
    [null, 'ТОО «Омега»'],
    [null, null],
    ['Electrical Engineer', 'АО Бета'],
    ['Facilities Manager', 'Gamma Company'],
    [null, 'School-Lyceum No. 5'], // an employer that is a school stays a job
    ['Offshore Camp Manager', 'Omega Catering'],
    ['Aksai Technical College', null], // a school with nothing next to it: no reason to call it education
  ]);
  assert.deepEqual(p.education, [{ institution: 'North Technical University', area: null, endDate: '2020' }]);
  assert.equal(p.meta.totalMonths, 12, 'the years at school (2016-2020) are no experience');
});

test('the job title line is no heading, date, address, personal data or name (it goes out anonymised)', () => {
  for (const bad of ['Resume', 'Сводка навыков', 'Ноябрь 2024 —', 'Kazakhstan, West Kazakhstan, Aksay city, Abay street, 12', 'Aksai, West Kazakhstan',
    'Male, born on 3 March 1990', 'JOHN Q. PUBLIC JR.', 'ivan@example.com', 'г. Аксай, ул. Абая, 12']) assert.ok(badLabel(bad, null), bad);
  assert.ok(badLabel('Иванов Иван', 'Иванов Иван'));
  assert.ok(badLabel('•', null) && badLabel('', null));
  assert.equal(cleanLabel('Position Applied: Millwright Fitter'), 'Millwright Fitter');
  assert.equal(cleanLabel('Желаемая должность: Трубомонтажник'), 'Трубомонтажник');
  assert.equal(parse('Иван Петров\nObjective: Hydrotest Operator\n\nОПЫТ РАБОТЫ\n01.2020 - 12.2023\nТОО «Альфа»\nОператор\n', false).basics.label, 'Hydrotest Operator');
  for (const good of ['Project Manager', 'PIPE FITTER', 'City Planner', 'Инженер-электрик', 'HSE ADVISOR', 'Senior Civil Engineer | Construction & Project Management'])
    assert.ok(!badLabel(good, 'Иванов Иван'), good);
  // the latest position takes the place of a bad title line
  const p = parse('JOHN Q. PUBLIC JR.\nMale, born on 3 March 1990\n\nWORK EXPERIENCE\n03.2019 - present\nPipe Fitter\nAlpha LLP\nPiping installation and hydrotests.\n', false);
  assert.equal(p.basics.label, 'Pipe Fitter');
});

test('layouts without jobs before: one word per line, a job on one line', () => {
  // the shape of a real CV: "Full Name: X", a key-value header, then "YYYY-YYYY - Company - Title" lines
  const oneLine = `Full Name: Ivan Petrov
Position: Pipe Fitter
Date of Birth: 01.02.1985
WORK EXPERIENCE
2019-2023 - Alpha Construction LLP - Pipe Fitter
2015-2019 - Beta Oil Services - Pipe Fitter Assistant
2012-2015 – Gamma Group Kazakhstan
Welder
2010 по 2012 - Delta Ltd
PROFESSIONAL SKILLS
Pipe installation, hydrotests`;
  const p = parse(oneLine, false);
  assert.deepEqual(p.work.map((w) => [w.position, w.name, w.startDate, w.endDate]), [
    ['Pipe Fitter', 'Alpha Construction LLP', '2019-01', '2023-12'],
    ['Pipe Fitter Assistant', 'Beta Oil Services', '2015-01', '2019-12'],
    ['Welder', 'Gamma Group Kazakhstan', '2012-01', '2015-12'],
    [null, 'Delta Ltd', '2010-01', '2012-12'],
  ]);
  assert.ok(p.meta.totalYears >= 13, `experience counted: ${p.meta.totalYears}`);
  // one word per line comes back together
  const words = `Иванов Иван\nТрубомонтажник\n\nОПЫТ РАБОТЫ\n01.2019 - по настоящее время\nТОО «Альфа»\nТрубомонтажник\nМонтаж технологических трубопроводов.\n`
    .split('\n').flatMap((l) => (/^\d/.test(l) || /^ОПЫТ/.test(l) ? [l] : l.split(' '))).join('\n') + '\n' + Array(15).fill('слово').join('\n');
  const joined = unfragment(words).split('\n');
  assert.ok(joined.includes('01.2019 - по настоящее время') && joined.includes('Иванов Иван Трубомонтажник'), joined.slice(0, 5).join(' | '));
  const q = parse(words, false);
  assert.equal(q.work.length, 1);
  assert.equal(q.work[0].startDate, '2019-01');
});

test('layout fixes: levels of education, years and specialties in the institution', () => {
  const p = { education: [
    { institution: 'Высшее', area: null, endDate: '2012' },
    { institution: 'Среднее специальное (учебное заведение не указано)', area: 'Трубомонтажник', endDate: null },
    { institution: 'Higher', area: 'Kazakh National Technical University', endDate: '2010' },
    { institution: '2016. West Plains Agrarian University. Specialty: Accounting', area: null, endDate: null },
    { institution: 'Secondary School named after Abai', area: null, endDate: '2008' },
  ] };
  fixEducation(p);
  assert.deepEqual(p.education.map((e) => [e.institution, e.area, e.degree ?? null, e.endDate]), [
    ['', null, 'higher', '2012'],
    ['', 'Трубомонтажник', 'college', null],
    ['Kazakh National Technical University', null, 'higher', '2010'],
    ['West Plains Agrarian University', 'Accounting', null, '2016'],
    ['Secondary School named after Abai', null, null, '2008'],
  ]);
  // an entry with the level only survives a manual edit
  assert.equal(refresh({ education: [{ institution: '', degree: 'higher', endDate: '2012' }] }).education.length, 1);
});

test('layout fixes: certificates without bullets, dated by year lines, wrapped lines joined', () => {
  const p = { certificates: ['•', '2022', 'Аккредитованный энергоаудитор', '2019', 'центр подготовки ТОО «Каспий»',
    'ТОО «Каспий», сертификаты безопасности «работы на высоте», «работы в замкнутом', 'пространстве»', 'kpo bv H2S', 'работа на высоте']
    .map((name) => ({ name, date: null })) };
  fixCertificates(p);
  assert.deepEqual(p.certificates.map((c) => [c.name, c.date, c.issuer ?? null]), [
    ['Аккредитованный энергоаудитор', '2022', null],
    ['ТОО «Каспий», сертификаты безопасности «работы на высоте», «работы в замкнутом пространстве»', '2019', 'центр подготовки ТОО «Каспий»'],
    ['kpo bv H2S', '2019', 'центр подготовки ТОО «Каспий»'],
    ['работа на высоте', '2019', 'центр подготовки ТОО «Каспий»'],
  ]);
});

const CV = `Ахметов Арман Серикович
Руководитель проектов
Астана · +7 701 123 45 67 · arman.akhmetov@example.com
Дата рождения: 01.02.1985

ОПЫТ РАБОТЫ
03.2019 - по настоящее время
ТОО «Нурсофт»
Руководитель проектов
Внедрение Jira и Confluence, Scrum, управление рисками.
01.2014 - 02.2019
ТОО «Дала Диджитал»
Бизнес-аналитик
BPMN, UML, SQL.

ОБРАЗОВАНИЕ
2007 - Технический университет Сарыарки, Информационные системы

ЯЗЫКИ
Казахский - родной
Английский - B2

СЕРТИФИКАТЫ
Project Management Professional (PMP) (2020)
`;

test('parse: profile without sensitive data', () => {
  const p = parse(CV);
  assert.equal(p.basics.name, 'Ахметов Арман Серикович');
  assert.equal(p.basics.email, 'arman.akhmetov@example.com');
  assert.equal(p.work.length, 2);
  assert.equal(p.work[0].prof, 'pm');
  assert.ok(p.meta.totalYears >= 12);
  assert.ok(p.skills.some((s) => s.name === 'Jira'));
  assert.equal(p.meta.sensitive, undefined);
  assert.deepEqual(p.meta.sensitiveDetected, ['birthDate']);
  assert.ok(!JSON.stringify(p).includes('01.02.1985'));
});

test('canonSkill maps synonyms and leaves unknown skills alone', () => {
  assert.equal(canonSkill('postgres'), 'PostgreSQL');
  assert.equal(canonSkill('Камунда') === null || typeof canonSkill('Камунда') === 'string', true);
  assert.equal(canonSkill('SAP ABAP'), null);
});

test('match: reasons, hard requirements and order', () => {
  const pm = { id: 'a', profile: parse(CV) };
  const junior = { id: 'b', profile: parse(CV.replace('01.2014 - 02.2019', '01.2025 - 02.2025').replace('03.2019', '03.2025').replace(/СЕРТИФИКАТЫ[\s\S]*$/, '')) };
  const role = { title: 'Project manager', profession: 'pm', min_years: 5, skills_must: ['Jira', 'Scrum', 'SAP ABAP'],
    certificates: ['PMP'], languages: [{ language: 'en', level: 'B2' }, { language: 'ru', level: 'C1' }] };
  const [{ results }] = match([role], [junior, pm]);
  assert.deepEqual(results.map((r) => r.id), ['a', 'b']);
  const a = results[0];
  assert.deepEqual(a.fails, []);
  assert.deepEqual(a.why.mustMet, ['Jira', 'Scrum']);
  assert.deepEqual(a.why.mustMissing, ['SAP ABAP']);
  assert.deepEqual(a.why.certMet, ['PMP']);
  assert.equal(a.why.languages[0].ok, true);
  assert.equal(a.why.languages[1].inferred, true); // Russian CV, Russian not listed
  assert.ok(a.score > 70 && a.score < 100);
  assert.deepEqual(results[1].fails.sort(), ['cert', 'exp']);
});

test('refresh recomputes professions and experience after an edit', () => {
  const p = parse(CV);
  p.work[1].position = 'Python-разработчик';
  p.work.push({ name: 'X', position: 'DevOps-инженер', startDate: 'bad', endDate: null });
  p.skills.push({ name: 'кубернетес' });
  const r = refresh(p);
  assert.equal(r.work[1].prof, 'python');
  assert.equal(r.work[2].startDate, null);
  assert.ok(r.skills.some((s) => s.name === 'Kubernetes'));
  assert.equal(r.meta.title.prof, 'pm');
});

test('synthetic CVs of the demo dataset rank by profession', () => {
  const data = dataset(60).map((x) => ({ id: x.truth.id, prof: x.truth.prof, profile: parse(x.text, x.ocr != null) }));
  const [{ results }] = match([{ profession: 'devops', min_years: 1, skills_must: ['Docker', 'Kubernetes'] }], data);
  const n = data.filter((d) => d.prof === 'devops').length;
  const top = results.slice(0, n).map((r) => data.find((d) => d.id === r.id).prof);
  assert.ok(n >= 2 && top.every((p) => p === 'devops'), top.join(','));
});

const CV2 = `Иванов Сергей
Руководитель проектов
Алматы · sergey@example.com

ОПЫТ РАБОТЫ
03.2020 - по настоящее время
ТОО «Нурсофт», Астана
Руководитель проектов
Внедрение ERP в филиалах в Шымкенте.
01.2017 - 02.2020
АО «Дала Диджитал»
Бизнес-аналитик
Moscow, Russia. BPMN, UML.
06.2015 - 12.2016
ТОО «Кайнар Софт»
Аналитик данных
SQL, отчетность.

ПРОЕКТЫ
Внедрение ERP для АО «Казпочта»
01.2021 - 12.2022
Роль: руководитель проекта
Заказчик: АО «Казпочта»
Миграция 40 филиалов на Jira и Confluence.
Портал госуслуг
2019 - 2020
Роль: аналитик

ОБРАЗОВАНИЕ
2015 - Университет Степного края, Информационные системы, бакалавр
2017 - Каспийский университет, магистр
`;

test('parse: projects, places of work, education level, countries, positions', () => {
  const p = parse(CV2);
  assert.deepEqual(p.projects.map((x) => [x.name, x.role, x.customer, x.startDate, x.endDate]), [
    ['Внедрение ERP для АО «Казпочта»', 'руководитель проекта', 'АО «Казпочта»', '2021-01', '2022-12'],
    ['Портал госуслуг', 'аналитик', null, '2019-01', '2020-12'],
  ]);
  assert.equal(p.projects[0].summary, 'Миграция 40 филиалов на Jira и Confluence.');
  assert.equal(p.work.length, 3, 'project periods must not become jobs');
  assert.deepEqual(p.work.map((w) => w.location), [{ country: 'KZ', city: 'astana' }, { country: 'RU', city: 'moscow' }, { country: 'KZ', city: null, inferred: true }]);
  assert.ok(p.work.every((w) => !('src' in w)));
  assert.equal(p.basics.location.country, 'KZ');
  assert.deepEqual(p.education.map((e) => e.degree), ['bachelor', 'master']);
  assert.equal(p.meta.countries[0].country, 'KZ');
  assert.equal(p.meta.countries[1].country, 'RU');
  assert.equal(p.meta.positions[0].prof, 'pm');
  assert.ok(['middle', 'senior'].includes(p.meta.positions[0].level));
});

test('projects without periods: one per line, year in brackets', async () => {
  const { parseProjects } = await import('./parse.js');
  const out = parseProjects(['• Чат-бот для акимата (2023)', 'обработка обращений граждан', '• BI-отчетность для министерства']);
  assert.deepEqual(out.map((x) => [x.name, x.endDate, x.summary]), [
    ['Чат-бот для акимата', '2023-12', 'обработка обращений граждан'],
    ['BI-отчетность для министерства', null, undefined],
  ]);
});

test('refresh keeps manual places and degrees, maps typed city names', () => {
  const p = parse(CV2);
  p.work[2].location = { country: null, city: 'Караганда' };
  p.work[1].location = { country: 'UZ', city: 'Самарканд-2' };
  p.education[0].degree = 'master';
  p.projects.push({ name: '  ', role: 'x' });
  const r = refresh(p);
  assert.deepEqual(r.work[2].location, { country: 'KZ', city: 'karaganda' });
  assert.deepEqual(r.work[1].location, { country: 'UZ', city: 'Самарканд-2' });
  assert.equal(r.education[0].degree, 'master');
  assert.equal(r.projects.length, 2);
  assert.ok(r.meta.countries.some((c) => c.country === 'UZ'));
});

// International layouts seen in real uploads (fictional people): summary heading, title / company / period,
// header with an unknown legal form before the period, non-IT skills, degree before the institution.
const CV3 = `TEMIRLAN IBRAYEV
Astana, Kazakhstan | +7 701 111 22 33 | t.ibrayev@example.com

PROFESSIONAL SUMMARY
Operations readiness and asset data specialist with 5 years in oil and gas projects in Kazakhstan.

WORK EXPERIENCE
Asset Data Engineer
Caspian Energy Services LLP, Atyrau
03/2021 – Present
• Built the asset register and maintenance data in SAP PM for 3 plants.
Operations Readiness Coordinator
Steppe Oil LLP, Aktau
01/2019 – 02/2021
• Prepared operating procedures and spare parts lists.

EDUCATION
Bachelor of Science in Petroleum Engineering, Satbayev University, 2018

KEY SKILLS
Operations Readiness; Asset Data Management; SAP PM; Maximo; CMMS
Commissioning, HSE, MS Excel
`;
const CV4 = `Aigerim K. Nurlanova
Professional Summary
Operations Readiness and Asset Data lead with 10 years of experience in LNG and refining projects.

Professional Experience
Operations Readiness Lead, North Caspian Operating Company B.V., Atyrau, Kazakhstan
06/2018 – Present
Asset Data Specialist, Gulf Refining LLC, Dubai, UAE
05/2016 – 05/2018

Skills
Operations Readiness, Asset Data, Maximo, SAP PM
`;

test('international layouts: summary heading is not a name or title, title/company/period, non-IT skills', () => {
  const a = parse(CV3);
  assert.equal(a.basics.name, 'TEMIRLAN IBRAYEV');
  assert.equal(a.basics.label, 'Asset Data Engineer');
  assert.match(a.basics.summary, /^Operations readiness/);
  assert.deepEqual(a.work.map((w) => [w.position, w.name, w.location?.city]), [
    ['Asset Data Engineer', 'Caspian Energy Services', 'atyrau'], ['Operations Readiness Coordinator', 'Steppe Oil', 'aktau']]);
  assert.ok(!a.work[0].summary.includes('Operations Readiness Coordinator'));
  for (const s of ['Operations Readiness', 'SAP PM', 'Maximo', 'Excel']) assert.ok(a.skills.some((x) => x.name === s), s);
  assert.ok(!a.skills.some((x) => x.name === 'MS Excel'));
  assert.deepEqual([a.education[0].institution, a.education[0].degree], ['Satbayev University', 'bachelor']);
  assert.deepEqual(a.meta.positions.map((x) => x.title), ['Asset Data Engineer', 'Operations Readiness Coordinator']);

  const b = parse(CV4);
  assert.equal(b.basics.name, 'Aigerim K. Nurlanova');
  assert.equal(b.basics.label, 'Operations Readiness Lead');
  assert.deepEqual(b.work.map((w) => [w.position, w.location?.country]), [['Operations Readiness Lead', 'KZ'], ['Asset Data Specialist', 'AE']]);
  assert.deepEqual(b.meta.countries.map((c) => c.country), ['KZ', 'AE']);
});

// the shapes of real CVs that "Parse again" misread, with fictional people and companies
test('layouts: "Title, Company, Country" above each period, dates like "February,2021" and "SEPTEMBER8, 2007"', () => {
  const p = parse(`ARMANSEITOV
+7 701 000 00 00
arman@example.com
EXPERIENCE
ELECTRICAL ENGINEER, Alpha Business Park, UAE
March 2023 – March 2024
Handle the MEP works,Projects and DLP in Alpha business park
FACILITIES ENGINEER, BETA VENTURES, PAKISTAN
February,2021–December-2023
 Visit construction sites to observe conditions.
 Ensure that technicians are trained
Project Engineer, GAMMA MIDDLE EAST
MARCH 2017–DECEMBER 2020
DELTA INVESTMENT AUTHORITY,UAE
Monitor and supervise contractors.
ELECTRICAL FOREMAN, OMEGA CONTRACTORS, SAUDIARABIA
JANUARY, 2007–SEPTEMBER8, 2007
Installation of floodlight towers.
EDUCATION
Diploma of Associate Engineer (2006)
`);
  assert.equal(p.basics.name, 'ARMANSEITOV', 'a name glued into one word is the name');
  assert.equal(p.basics.label, 'ELECTRICAL ENGINEER');
  assert.deepEqual(p.work.map((w) => [w.position, w.name, w.startDate, w.endDate]), [
    ['ELECTRICAL ENGINEER', 'Alpha Business Park', '2023-03', '2024-03'],
    ['FACILITIES ENGINEER', 'BETA VENTURES', '2021-02', '2023-12'],
    ['Project Engineer', 'GAMMA MIDDLE EAST', '2017-03', '2020-12'],
    ['ELECTRICAL FOREMAN', 'OMEGA CONTRACTORS', '2007-01', '2007-09'],
  ]);
  assert.ok(!p.work[0].summary.includes('FACILITIES'), p.work[0].summary);
  assert.match(p.work[2].summary, /^DELTA INVESTMENT AUTHORITY/);
});

test('layouts: field labels in a column ("Position : / Duration : / Company : / Country :"), "up to present"', () => {
  const p = parse(`JUAN P. DELA CRUZ JR.
123 Rizal St., Makati City
WORK EXPERIENCE
Position :
Duration :
Company :
Country :
Senior Buyer (MRO/Projects – Supply & Logistics)
November 2019 up to present
Alpha Gas Company LLP
Aksai, Kazakhstan
Position :
Duration :
Company :
Country :
Procurement (Project) Engineer
October 2012 up to May 2019
Beta Contractors Inc.
Saudi Arabia
Review purchase requisitions and issue requests for quotation.
`);
  assert.equal(p.basics.name, 'JUAN P. DELA CRUZ JR.', 'the name with "Jr." is the name, not the job title');
  assert.equal(p.basics.label, 'Senior Buyer (MRO/Projects – Supply & Logistics)');
  assert.deepEqual(p.work.map((w) => [w.position, w.name, w.startDate, w.endDate]), [
    ['Senior Buyer (MRO/Projects – Supply & Logistics)', 'Alpha Gas Company LLP', '2019-11', null],
    ['Procurement (Project) Engineer', 'Beta Contractors Inc.', '2012-10', '2019-05'],
  ]);
  assert.match(p.work[1].summary, /^Review purchase/);
});

test('layouts: "Title | period" with the company on the next line', () => {
  const p = parse(`Ivan Petrov
Instrumentation & Control (I&C) Technician / Engineer
WORK EXPERIENCE
Self-Employed (Sole Proprietor) | January 2023 — Present
Own business — service provider for residential facilities
Instrumentation & Control (I&C) Engineer / Service Engineer | 2016 — December 2022
Alpha Service LLP
Maintenance and adjustment of control instruments
Foreman / Technician | 2014 — 2016
Beta Engineering LLP — ADP commissioning project, Astana
Participated in commissioning works
`);
  assert.deepEqual(p.work.map((w) => [w.position, w.name, w.startDate, w.endDate]), [
    ['Self-Employed (Sole Proprietor)', null, '2023-01', null],
    ['Instrumentation & Control (I&C) Engineer / Service Engineer', 'Alpha Service', '2016-01', '2022-12'],
    ['Foreman / Technician', 'Beta Engineering', '2014-01', '2016-12'],
  ]);
  assert.match(p.work[1].summary, /^Maintenance/);
  assert.match(p.work[2].summary, /^ADP commissioning project, Astana Participated/);
  // the company above "period Title", dates with days, a period of a role in brackets
  const q = parse(`Ivan Petrov
EMPLOYMENT HISTORY
Alpha Contractors LLP
Sept. 15, 2020 – Present Contracts & Procurement Manager
Astana, Kazakhstan
Managed subcontracts.
Beta Construction Ltd.
Aug. 15, 2007 – July 9, 2020 Subcontracts Engineer/Quantity Surveyor (Feb. 2013 to July 2020)
Prepared tenders.
`);
  assert.deepEqual(q.work.map((w) => [w.position, w.name, w.startDate, w.endDate]), [
    ['Contracts & Procurement Manager', 'Alpha Contractors', '2020-09', null],
    ['Subcontracts Engineer/Quantity Surveyor', 'Beta Construction', '2007-08', '2020-07'],
  ]);
  assert.ok(!q.work[0].summary.includes('Beta'), q.work[0].summary);
});

test('cli answers JSON on stdout', () => {
  const cli = fileURLToPath(new URL('./cli.mjs', import.meta.url));
  const out = JSON.parse(execFileSync(process.execPath, [cli], { input: JSON.stringify({ op: 'meta' }) }).toString());
  assert.equal(out.professions.length, meta().professions.length);
  assert.ok(out.skills.includes('Python'));
});
