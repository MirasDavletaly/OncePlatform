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

test('layouts: numbered headings, a table read column by column, "since 2023 — director", a signature', () => {
  const p = parse(`ПЕРСОНАЛЬНОЕ ПОРТФОЛИО
ИВАНОВ ПЁТР ПЕТРОВИЧ
1985 г.р.
Женат.
Республика Казахстан, Караганда
Контактная информация: ____________________
Электронная почта: ivanov@example.com
Телефон: +77010000000
Специализация:
• Инженерные изыскания
• Мониторинг деформаций

1. ПРОФЕССИОНАЛЬНАЯ ЦЕЛЬ
Геодезический контроль строительства.

2. ПРОФЕССИОНАЛЬНЫЙ ПРОФИЛЬ
Специалист в области инженерной геодезии.

3. ОСНОВНЫЕ ПРОФЕССИОНАЛЬНЫЕ КОМПЕТЕНЦИИ
• AutoCAD и Civil 3D
• Высокоточное нивелирование.

4. ПРОЕКТЫ
В течение профессиональной деятельности руководил работами на объектах
различного назначения.
ТЭЦ-2 города Альфа
Наблюдения за осадками фундаментов зданий и
оборудования.
Аэропорт Бета
Нивелирование оснований резервуаров.

5. ПРОФЕССИОНАЛЬНЫЙ ПУТЬ
Период

Организация

Должность / направление

10.2005 – 03.2006
09.2006 – 11.2011
01.2012 – 09.2012

ТОО СП «Альфастрой»
ТОО «Бетастрой»
ТОО «Гамма»

Геодезист
Ведущий геодезист
Инженерные изыскания
Самостоятельная профессиональная
деятельность
Прораб

С 12.2012 –
09.2019 – 05.2020

ИП «Иванов П.П.»
ТОО «Дельта»

6. РУКОВОДЯЩАЯ ДЕЯТЕЛЬНОСТЬ
С 2023 года — директор ТОО «Эпсилон».
Основные направления управленческой деятельности:
• Организация производственных процессов.

ПЁТР ПЕТРОВИЧ ИВАНОВ
Республика Казахстан
Электронная почта: ivanov@example.com
Телефон: +77010000000
`);
  assert.equal(p.basics.name, 'ИВАНОВ ПЁТР ПЕТРОВИЧ');
  assert.equal(p.basics.label, 'Инженерные изыскания');
  assert.match(p.basics.summary, /Геодезический контроль.*Специалист в области/);
  const jobs = p.work.map((w) => [w.position, w.name, w.startDate, w.endDate]).sort((a, b) => a[2].localeCompare(b[2]));
  assert.deepEqual(jobs, [
    ['Геодезист', 'Альфастрой', '2005-10', '2006-03'],
    ['Ведущий геодезист', 'Бетастрой', '2006-09', '2011-11'],
    ['Инженерные изыскания', 'Гамма', '2012-01', '2012-09'],
    ['Самостоятельная профессиональная деятельность', 'Иванов П.П.', '2012-12', null],
    ['Прораб', 'Дельта', '2019-09', '2020-05'],
    ['Директор', 'Эпсилон', '2023-01', null],
  ]);
  // positions: one for "Ведущий геодезист" and "Геодезист" (the title held longest), no self-employment
  const pos = p.meta.positions.map((x) => x.title);
  assert.deepEqual(pos.slice(0, 2), ['Ведущий геодезист', 'Директор'], JSON.stringify(p.meta.positions));
  assert.ok(!pos.some((x) => /Самостоятельная|^Геодезист$/.test(x)), pos.join(', '));
  assert.equal(p.meta.positions[0].years, 5.6); // 10.2005-03.2006 and 09.2006-11.2011 together
  const director = p.work.find((w) => w.name === 'Эпсилон');
  assert.equal(director.position, 'Директор');
  assert.match(director.summary, /Организация производственных процессов/);
  assert.doesNotMatch(director.summary, /ИВАНОВ|example\.com|7701/);
  assert.deepEqual(p.projects.map((x) => [x.name, x.summary]), [
    ['ТЭЦ-2 города Альфа', 'Наблюдения за осадками фундаментов зданий и оборудования.'],
    ['Аэропорт Бета', 'Нивелирование оснований резервуаров.'],
  ]);
  assert.ok(p.skills.some((s) => /AutoCAD/.test(s.name)), JSON.stringify(p.skills));
  assert.ok(!JSON.stringify(p).includes('1985'), 'the birth year is personal data');
  // what the line under the name may be instead of a title: an address or a sentence
  for (const bad of ['РК, Атырауская обл.', 'ЗКО, Бурлинский р-н, г.Аксай', 'Опыт работы в строительстве жилых и промышленных объектов более десяти лет.']) assert.ok(badLabel(bad, null), bad);
  assert.ok(!badLabel('Начальник районных электросетей', null));
  // "2015-2017 гг. Company. Title;": the year word out, the company and the title apart, no place in the title
  const q = parse(`ИВАНОВ ИВАН ИВАНОВИЧ

ОПЫТ РАБОТЫ
2015-2017 гг. ОГПК Альфа п.Бета. Слесарь-сварщик;
2018-2020 гг. ТОО «Гамма» монтажник трубопроводов;
2021-2023 гг. «Дельта» Аксай Трубомонтажник;
2024-2025 гг. ТОО «Эпсилон» г. Актау «Месторождение» слесарь по монтажу трубопроводов;
`);
  assert.deepEqual(q.work.map((w) => [w.position, w.name]).sort((a, b) => a[0].localeCompare(b[0])), [
    ['монтажник трубопроводов', 'Гамма'],
    ['слесарь по монтажу трубопроводов', 'Эпсилон'],
    ['Слесарь-сварщик', 'ОГПК Альфа п.Бета'],
    ['Трубомонтажник', 'Дельта'],
  ]);
  assert.deepEqual(parse('Ivan Petrov\n\nWORK EXPERIENCE\n2015 - 2018 Sr. Engineer, Alpha LLP\n').work.map((w) => w.position), ['Sr. Engineer']);
  assert.equal(parse('Ivan Petrov\n\nWORK EXPERIENCE\n2021 - 2025 Bachelor of Technology (B. Tech) — Mechanical Engineering\n').work[0]?.position?.startsWith('Tech)'), false);
});

test('layouts: a personal data table read by columns, "Career Summary" over jobs, dates with days, courses', () => {
  const p = parse(`Personal Information
Last name
First name
Nationality
Date of Birth
Address
Contact details

E-mail
EDUCATION
\tPetrov
Ivan
Kazakh
05.10.1985
Uralsk city, West Kazakhstan
+7 -700- 000 -00 -00
+7- 701 -000- 00- 00 Whats App ivan.petrov@example.com
Higher education
ALPHAUNI Bachelor. specialization Management.

Professional Profile

Experienced project manager in pre-commissioning projects.
Good mechanical aptitude

Key Skills
Nitrogen purging
Hydrostatic test

Career Summary
\tOil flushing
Bolting

01.01.2025 – 01.02.2025  Alpha Quest Company, Project Engineer for Beta Gas project in Karabatan.

Hydro test, Pigging, Drying of 16" Pipe Lines.

August 2024 – 2024 November – Company Gamma zavod, Project Engineer (Nitrogen Purge) for Delta Company.

Preparation of Test packs for purging with Nitrogen.

01.12.2022 – 2024 February- Epsilon Alliance - Project Manager

 Managing of projects at the Karachaganak field for hydraulic testing.

04.10.2019 – 01.09.2022 Zeta Oil Field Services

Project Manager/ Engineering
Managing Turn Around projects at the KTL plant.

2017 – 2019
Eta Services Central Asia
Project Manager / Project Engineer
Project engineer during KTL plant turn around 2017.

Professional Experience Continued…

2003 – 2007
Theta Services Company Middle East Limited,  Karachaganak Aksai

Nitrogen Operator 2
Functioned as Nitrogen Pump operator.

EDUCATION & TRAINING

Education

Courses attended

PRO101 Process Nitrogen 1, July,05
BOSIET with EBS, course date: March-2024, expiry date: March-2028

Additional

Languages
Kazakh-Native
Russian: Fluent
English:  Above average
`);
  assert.equal(p.basics.name, 'Petrov Ivan');
  assert.ok(!JSON.stringify(p).includes('1985'), 'the birth date is personal data');
  assert.deepEqual(p.education.map((e) => [e.institution, e.area, e.degree]), [['ALPHAUNI', 'Management', 'bachelor']]);
  assert.ok(p.certificates.some((c) => /^BOSIET/.test(c.name)) && p.certificates.some((c) => /^PRO101/.test(c.name)), JSON.stringify(p.certificates));
  assert.ok(!p.certificates.some((c) => /^Additional$/.test(c.name)));
  const jobs = [...p.work].sort((a, b) => a.startDate.localeCompare(b.startDate));
  const want = [
    ['2003-01', '2007-12', /^Nitrogen Operator 2$/, /^Theta Services Company Middle East Limited/],
    ['2017-01', '2019-12', /^Project Manager \/ Project Engineer$/, /^Eta Services Central Asia$/],
    ['2019-10', '2022-09', /^Project Manager\/ Engineering$/, /^Zeta Oil Field Services$/],
    ['2022-12', '2024-02', /^Project Manager$/, /^Epsilon Alliance$/],
    ['2024-08', '2024-11', /^Project Engineer \(Nitrogen Purge\)/, /Gamma zavod/],
    ['2025-01', '2025-02', /^Project Engineer for Beta Gas project/, /^Alpha Quest Company$/],
  ];
  assert.equal(jobs.length, want.length, JSON.stringify(jobs.map((w) => [w.startDate, w.position, w.name])));
  jobs.forEach((w, i) => {
    const [s, e, pos, co] = want[i];
    assert.ok(w.startDate === s && w.endDate === e && pos.test(w.position || '') && co.test(w.name || ''), JSON.stringify([w.startDate, w.endDate, w.position, w.name]));
  });
  assert.match(jobs[2].summary || '', /^Managing Turn Around/);
  // a bullet with the company, a dash, the place and the title: the bullet rule first
  const b = parse('Ivan Petrov\n\nWORK EXPERIENCE\n2003 – 2007\n• ESS / Compass Group – Nigeria/Sudan : Area Camps Manager.\nRan the camps.\n').work[0];
  assert.deepEqual([b.position, b.name], ['Area Camps Manager', 'ESS / Compass Group']);
});

test('layouts: a form with labelled fields (start/end date, company name, position, job duties)', () => {
  const p = parse(`Ivan Petrov Ivanovich
E-mail: ivan@example.com
Mobile phone: 87010000000
Date of birth: 01.01.1990
Citizenship: Kazakhstan
City: Atyrau, Atyrau region
Education and qualification_______________________________________________
Start date: 01.09.2008 End date: 01.06.2012
Institution name: Alpha State University
Country: Kazakhstan
Degree: Bachelor
Specialty: Electrical Engineering
Qualification: Engineer
Additional info:
Work experience_______________________________________________
Start date: 01.03.2015 End date: 01.12.2018
Company name: ТОО "Альфа"
Position: Электрик
Job Duties: Монтаж электрооборудования.
Additional info: -
Start date: 01.01.2019 Up to present End date: -
Company name: ТОО "Бета"
Position: Мастер электрик
Job Duties: Руководство бригадой.
Additional info: -
Language skills_____________________________________________
English: Basic
Kazakh: Fluent
`);
  assert.equal(p.basics.name, 'Ivan Petrov Ivanovich');
  assert.deepEqual(p.education.map((e) => [e.institution, e.area, e.degree, e.endDate]), [['Alpha State University', 'Electrical Engineering', 'bachelor', '2012']]);
  assert.deepEqual(p.work.map((w) => [w.position, w.name, w.startDate, w.endDate]).sort((a, b) => a[2].localeCompare(b[2])), [
    ['Электрик', 'Альфа', '2015-03', '2018-12'],
    ['Мастер электрик', 'Бета', '2019-01', null],
  ]);
  assert.match(p.work.find((w) => w.name === 'Альфа').summary, /^Монтаж/);
  assert.deepEqual(p.languages.map((l) => l.language).sort(), ['en', 'kk']);
  // the label on its line and the value on the next
  const pairs = parse(`Ivan Petrov
WORK EXPERIENCE
Job title
HR Specialist
Period
01.12.2022-01.05.2024
company
Alpha Services Limited LLP, Atyrau
job duties
- Hiring of staff;
- Keeping records.
Job title
Logistics Specialist
Period
01.05.2024-present
company
Beta Systems LLP, Aksai
job duties
- Shipping of cargo.
`);
  assert.deepEqual(pairs.work.map((w) => [w.position, w.name, w.startDate, w.endDate]).sort((a, b) => a[2].localeCompare(b[2])), [
    ['HR Specialist', 'Alpha Services Limited LLP', '2022-12', '2024-05'],
    ['Logistics Specialist', 'Beta Systems LLP', '2024-05', null],
  ]);
  assert.deepEqual(pairs.work.map((w) => w.location?.city).sort(), ['aksai', 'atyrau']); // the town stays as the location
  // the company above "Position" / its value; a name in capitals with the title in small letters
  const pos = parse('Ivan Petrov\nWork Experience\n2021 – present\nJSC"Alpha Stroy" (Pipelines zone 5)\nAtyrau\nPosition\nOperator, Hydrotesting\nHydrotests of pipelines.\n');
  assert.deepEqual(pos.work.map((w) => [w.position, w.name]), [['Operator, Hydrotesting', 'JSC"Alpha Stroy" (Pipelines zone 5)']]);
  const caps = parse('Иван Петров\nОпыт работы\n2010 – 2016 Ventis Engineering трубомонтажник\n2016 – 2018 ДельтаКарьер трубомонтажник\n');
  assert.deepEqual(caps.work.map((w) => [w.position, w.name]).sort((a, b) => (a[1] < b[1] ? -1 : 1)), [['трубомонтажник', 'Ventis Engineering'], ['трубомонтажник', 'ДельтаКарьер']]);
  // a stacked header under the period: company, town and country, then the title (wrapped)
  const stacked = parse('Petar Novak\nCAREER HISTORY\nApr 2011 – July 2011\nOmega\nKazan, Russian\nFederation\nConstruction\nSupervisor\nResponsibilities/Tasks: site supervision.\nOct 2010 – Apr 2011\nSigma Works\nKazan, Russian\nFederation\nChief Engineer\nOil terminal project.\n');
  assert.deepEqual(stacked.work.map((w) => [w.position, w.name]), [['Construction Supervisor', 'Omega'], ['Chief Engineer', 'Sigma Works']]);
  const stacked2 = parse('Petar Novak\nCAREER HISTORY\nApr 2010 – May 2010\nSigma, Novy Urengoy, Rus.\nGas plant,\nRussian Federation\nChief Engineer\nMar 2007 – Oct 2007\nAlpha, Kazan,\nphone lines, etc.\nResponsibilities/Tasks: Chief Engineer reporting to Project Manager.\nApr 1999 – Jun 1999\nZeta, Novi Sad,\nSerbia, Chief Engineer\nRefinery in Novi Sad, Serbia\n');
  assert.deepEqual(stacked2.work.map((w) => [w.position, w.name]), [['Chief Engineer', 'Sigma'], [null, 'Alpha'], ['Chief Engineer', 'Zeta']]);
  // the period repeated under the header, a sentence before the company, the title over a company without a legal form
  const repeated = parse('Ivan Petrov\nProfessional experience\nJuly 2025 - present\nWide professional experience with key clients and partners driven by\nlarge projects.\n“Alpha Beta Gamma” LLP, Astana, Kazakhstan\nProject management support.\nNov 2017 – Sep 2019\nLead Project Engineer\nDelta Group, Atyrau, Kazakhstan\nNovember 2017 – September 2019\nDesign reviews.\nJun 2009 - Jul 2011\nProject Manager\nOmega Sigma Company, Aktau, Kazakhstan\nConstruction of a plant.\n');
  assert.deepEqual(repeated.work.map((w) => [w.startDate, w.position, w.name]), [
    ['2025-07', null, 'Alpha Beta Gamma'], ['2017-11', 'Lead Project Engineer', 'Delta Group'], ['2009-06', 'Project Manager', 'Omega Sigma Company']]);
  // the place and the quoted company on one line, the title under it with a full stop; "Location:" and "Profession:"
  const located = parse('Ivan Petrov\nWork experience\nSeptember 2006 – May 2007\nAtyrau region, Tengiz, “Alpha – Beta” JSC.\nConstruction of a gas plant\nHSE Engineer.\nResponsibility:\nSafety briefings.\nFebruary 1999 – May 2000\nLocation: Omega field, “AB-Gamma” LLP.\nProfession: Carpenter\n');
  assert.deepEqual(located.work.map((w) => [w.position, w.name]), [['HSE Engineer', 'Alpha – Beta'], ['Carpenter', 'AB-Gamma']]);
  // "MM-YYYY" dates, "period – Company" with the title on the next line, the town after the company
  const hyph = parse('Ivan Petrov\nWork Experience:\n09-2024 - present – AB CD.E Group - Atyrau\nSite Manager\n01-2020 - 08-2024 - Kappa\nRigger Grade 5\n05-2008 – 06-2010 – Omega Sigma LLP\nPump Operator Grade.\nLanguage:\nKazakh (native)\n');
  assert.deepEqual(hyph.work.map((w) => [w.startDate, w.endDate, w.position, w.name]), [
    ['2024-09', null, 'Site Manager', 'AB CD.E Group'], ['2020-01', '2024-08', 'Rigger Grade 5', 'Kappa'], ['2008-05', '2010-06', 'Pump Operator Grade', 'Omega Sigma']]);
  // education on two lines without a year
  const eduPair = parse('Petar Novak\nEDUCATION\nUniversity of Alpha, Novi Sad\nBachelor of Civil Engineering\nLANGUAGES\nEnglish: fluent\n');
  assert.deepEqual(eduPair.education.map((e) => [e.institution, e.area, e.degree ?? null]).slice(0, 1), [['University of Alpha, Novi Sad', 'Civil Engineering', 'bachelor']]);
  // a company glued in front of the title
  const glued = parse('Иван Петров\nОпыт работы\n06.2023-02.2024 Северный филиал АО ДЕЛЬТА Трубомонтажник 4-го разряда\n06.2026-08.2026 КРМА Электромонтажник 4-го разряда\n01.2015-01.2016 QXSE Instrument Equipment (Lead Field Service Engineer)\n');
  assert.deepEqual(glued.work.map((w) => [w.position, w.name]), [
    ['Трубомонтажник 4-го разряда', 'Северный филиал АО ДЕЛЬТА'],
    ['Электромонтажник 4-го разряда', 'КРМА'],
    ['QXSE Instrument Equipment (Lead Field Service Engineer)', null],
  ]);
  // a quote right after the period starts the company
  const q = parse('Иван Петров\nОпыт работы:\n05.2015-06.2017 г. ТОО «Альфа» монтажник;\n07.2019-11.2019 г. «Омега» Аксай Трубомонтажник;\n');
  assert.equal(q.work.length, 2, JSON.stringify(q.work.map((w) => [w.startDate, w.position, w.name])));
  // one job only is a job too
  const one = parse('Ivan Petrov\nWork experience______\nStart date: 01.09.2019 Up to present End date: -\nCompany name: АО "Гамма"\nPosition: Инженер\nJob Duties: Проектирование.\n');
  assert.deepEqual(one.work.map((w) => [w.position, w.name, w.startDate, w.endDate]), [['Инженер', 'Гамма', '2019-09', null]]);
});

test('layouts: inline headings, name labels, a contact line with the name, a headline, jobs without a heading', () => {
  const inline = parse(`Резюме
Ф.И.О: Иванов Иван Иванович
Дата рождения: 01.01.1985г
Образование: Средне-специальное.
Опыт работы: 2010-2015 г. – монтажник АО «Альфа-Строй»
2015-2018 г. – ТОО «Бета Сервис» слесарь
Знание языков: казахский – родной
русский – свободно
`);
  assert.equal(inline.basics.name, 'Иванов Иван Иванович');
  assert.deepEqual(inline.work.map((w) => [w.position, w.name, w.startDate]).sort((a, b) => a[2].localeCompare(b[2])), [
    ['монтажник', 'Альфа-Строй', '2010-01'],
    ['слесарь', 'Бета Сервис', '2015-01'],
  ]);
  assert.deepEqual(inline.languages.map((l) => l.language).sort(), ['kk', 'ru']);

  const applied = parse('Position Applied: Pipe Fitter\nName: Ivan Petrov\nAddress: Atyrau City\nTel. No. / Mob. No.: +7 701 000 0000\nDate of Birth: 01-Jan-1990\n');
  assert.deepEqual([applied.basics.name, applied.basics.label], ['Ivan Petrov', 'Pipe Fitter']);
  const info = parse('CURRICULUM VITAE\nAtyrau City, Kazakhstan\nPERSONAL INFORMATION:\nName: Ivan A. Petrov\nNationality: Kazakh\n');
  assert.equal(info.basics.name, 'Ivan A. Petrov');
  const pipes = parse('Ivan Petrov | Atyrau, Kazakhstan | +7 701 000 0000 | ivan@example.com\nProfessional Summary\nEngineer with 10 years of experience.\n');
  assert.equal(pipes.basics.name, 'Ivan Petrov');
  const headline = parse('IVAN PETROV, B.SC MECHANICAL ENGINEER FROM SPLIT, CROATIA\nEDUCATION\nUniversity of Split\n');
  assert.equal(headline.basics.name, 'IVAN PETROV');
  assert.match(headline.basics.label || '', /^MECHANICAL ENGINEER$/i);
  const column = parse('Личные данные\nФ.И.О.:\nДата рождения:\nНациональность:\nПетров Пётр Петрович\n01.01.2000\nказах\nОбразование\n2018-2022\nАльфа Университет\n');
  assert.equal(column.basics.name, 'Петров Пётр Петрович');

  const hh = parse(`Иванов Иван
+7 (701) 0000000
ivan@example.com
Ноябрь 2024 —
настоящее время
1 год 1 месяц
ТОО Альфа
специалист по закупкам
Закупки материалов.
Январь 2021 —
Март 2024
3 года 3 месяца
ТОО Бета Сервис
Мастер участка
Руководство работами.
`);
  assert.deepEqual(hh.work.map((w) => [w.position, w.name, w.startDate, w.endDate]).sort((a, b) => a[2].localeCompare(b[2])), [
    ['Мастер участка', 'ТОО Бета Сервис', '2021-01', '2024-03'],
    ['специалист по закупкам', 'ТОО Альфа', '2024-11', null],
  ]);
});

test('layouts: "WORK HISTORY", a heading split over two lines, dates with underscores, "г." after dates', () => {
  const p = parse(`JOHN SMITH
PROFESSIONAL
SUMMARY
Engineer with 20 years of experience in projects.
WORK HISTORY
PROJECT MANAGER & TECHNICAL DIRECTOR
JUNE 2024 _Present _-1
ALPHA ENGINEERING LLC
SERBIA
• Led engineering projects.
SITE ENGINEER
MARCH 2019 _ MAY 2024
GAMMA CONSTRUCTION LLC
• Supervised works.
`);
  assert.match(p.basics.summary || '', /^Engineer with 20 years/);
  assert.deepEqual(p.work.map((w) => [w.position, w.name, w.startDate, w.endDate]).sort((a, b) => a[2].localeCompare(b[2])), [
    ['SITE ENGINEER', 'GAMMA CONSTRUCTION', '2019-03', '2024-05'],
    ['PROJECT MANAGER & TECHNICAL DIRECTOR', 'ALPHA ENGINEERING', '2024-06', null],
  ]);
  // the end of a wrapped sentence is no heading; two months of one year; "LTD." with its stop
  const h = parse(`JOHN SMITH
WORK HISTORY
PROJECT MANAGER
JUNE 2024 _Present _-1
ALPHA ENGINEERING LLC
• Managed engineering
projects.
SITE MANAGER
FEB-DEC 2023
BETA BUILD LTD.
• Ran the site.
HEAD OF QUALITY
OCT 2021-JAN 2023
GAMMA WORKS LTD.
• Quality control.
`);
  assert.deepEqual(h.work.map((w) => [w.position, w.startDate, w.endDate]).sort((a, b) => a[1].localeCompare(b[1])), [
    ['HEAD OF QUALITY', '2021-10', '2023-01'],
    ['SITE MANAGER', '2023-02', '2023-12'],
    ['PROJECT MANAGER', '2024-06', null],
  ]);
  const g = parse('Иванов Иван\nОпыт работы\n01.02.2010-03.04.2015 г. ТОО «Альфа Строй»\nДолжность: Слесарь по ремонту\n05.2015-06.2018 г. ТОО «Бета»\nДолжность: Мастер\n');
  assert.deepEqual(g.work.map((w) => [w.position, w.name, w.startDate, w.endDate]), [
    ['Слесарь по ремонту', 'Альфа Строй', '2010-02', '2015-04'],
    ['Мастер', 'Бета', '2015-05', '2018-06'],
  ]);
});

test('layouts: company over title over period, the period at the end of the line, "CO" companies', () => {
  const p = parse(`John Smith
WORK EXPERIENCE
Alpha Build LLP
Engineer Technician
June 2024 – Present
• Supervised site works.
• Prepared reports.
Beta Energy LLP
Site Engineer
September 2023 – May 2024
• Field inspections.
`);
  assert.deepEqual(p.work.map((w) => [w.position, w.name, w.startDate, w.endDate]), [
    ['Engineer Technician', 'Alpha Build', '2024-06', null],
    ['Site Engineer', 'Beta Energy', '2023-09', '2024-05'],
  ]);
  const co = parse(`John Smith
PROFESSIONAL EXPERIENCE
ARABIAN COMPANY FOR WATER CO
Lead Mechanical Engineer | September 2024 - Present
- Led the mechanical works.
GAMMA CONTRACTING CO
Mechanical Engineer | September 2021 - September 2024
- Installed pumps.
`);
  assert.deepEqual(co.work.map((w) => [w.position, w.name, w.startDate]), [
    ['Lead Mechanical Engineer', 'ARABIAN COMPANY FOR WATER', '2024-09'],
    ['Mechanical Engineer', 'GAMMA CONTRACTING', '2021-09'],
  ]);
  // the period at the end of the company line, "г" without its stop
  const ocr = parse(`Иван Петров
Трудовая деятельность: ТОО "Альфа Строй Сервис" г.Атырау 2009-2015г
Должность: Монтажник технологических трубопроводов.
Основные обязанности: Монтаж трубопроводов.
АО «Бетамонтаж» г.Актау 2015-2016г
Должность:Монтажник ТТ.
Компания: «Гамма Строй К2» 2016г-2017г Атырау
Должность:Монтажник ТТ.
`);
  assert.deepEqual(ocr.work.map((w) => [w.startDate, w.endDate]), [['2009-01', '2015-12'], ['2015-01', '2016-12'], ['2016-01', '2017-12']]);
  assert.ok(ocr.work.every((w) => /^Монтажник/.test(w.position || '') && w.name), JSON.stringify(ocr.work.map((w) => [w.position, w.name])));
  const end = parse(`Иван Петров
ОПЫТ РАБОТЫ
Альфа Софт — Python-разработчик Октябрь 2025 — настоящее время · 9 месяцев
Разработка сервисов.
Бета Групп — Аналитик данных Июль 2023 — Октябрь 2025 · 2 года 3 месяца
Отчёты и дашборды.
`);
  assert.deepEqual(end.work.map((w) => [w.startDate, w.endDate]), [['2025-10', null], ['2023-07', '2025-10']]);
  assert.ok(end.work.every((w) => w.position && w.name), JSON.stringify(end.work.map((w) => [w.position, w.name])));
});

test('cli answers JSON on stdout', () => {
  const cli = fileURLToPath(new URL('./cli.mjs', import.meta.url));
  const out = JSON.parse(execFileSync(process.execPath, [cli], { input: JSON.stringify({ op: 'meta' }) }).toString());
  assert.equal(out.professions.length, meta().professions.length);
  assert.ok(out.skills.includes('Python'));
});
