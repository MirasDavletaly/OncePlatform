// node --test cvengine/cert.test.mjs  (also run in the Docker build). Synthetic documents only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { applyDocuments, cleanOrg, readDocument, samePerson, sameWord, skeleton } from './cert.js';
import { refresh } from './cv.js';

const PEOPLE = [
  { id: 'c1', name: 'Ахметов Арман Болатович' },
  { id: 'c2', name: 'Нурланова Айгерим' },
  { id: 'c3', name: 'Seitov Yerlan' },
  { id: 'c4', name: 'Смаилова Динара Кайратовна' },
  { id: 'c5', name: 'Ким Марат' },
];

const PMI = `PROJECT MANAGEMENT INSTITUTE
hereby certifies that
Arman Akhmetov
has been formally evaluated for demonstrated experience, knowledge and performance in achieving an organizational
objective through defining and overseeing projects and resources and is hereby bestowed the global credential
Project Management Professional
PMP®
Certification Number: 2318841
Certification Date: 12 March 2021
Expiration Date: 11 March 2027`;

const DIPLOMA = `ҚАЗАҚСТАН РЕСПУБЛИКАСЫ
ДИПЛОМ
бакалавра
ЖБ-Б № 0123456
Настоящий диплом выдан
Нурлановой Айгерим Серикқызы
в том, что она в 2015 году окончила полный курс
Евразийского национального университета имени Л.Н. Гумилева
по образовательной программе «5В070300 – Информационные системы»
и решением Государственной аттестационной комиссии от 20 июня 2015 года
ей присуждена степень бакалавра техники и технологий
Дата выдачи 30.06.2015`;

const COURSE = `ТОО «Учебный центр Профи»
СЕРТИФИКАТ
№ 4512
Настоящий сертификат подтверждает, что
Сеитов Ерлан Маратович
успешно прошёл обучение по программе «Управление ИТ-проектами по стандарту PMBOK»
в объёме 40 академических часов
г. Астана, 15 ноября 2022 г.`;

const COURSERA = `Jun 12, 2023
Arman Akhmetov
has successfully completed
Google Data Analytics
an online non-credit course authorized by Google and offered through Coursera
Verify at coursera.org/verify/ABC123XYZ`;

const AWS = `CERTIFICATE OF ACHIEVEMENT
DINARA SMAILOVA
AWS Certified Solutions Architect – Associate
Issued: 2024-02-01   Expires: 2027-02-01
Validation Number: 8XK2PQ`;

// a legalised diploma as OCR reads it: stamp pages first, noise in the logo line and in the name, the date in words
const LEGALISED = `This is to certify that the signature appearing above/overleaf is the signature of
a Certifying Officer of Nicosia
District Officer Nicosia
12 JUL 2011
No. 2734/11
Seen at the Embassy of Lebanon
13 JUL 2011
This document is legalized in the Diplomatic mission № 312 2018
Decree of the Ministry of justice of Lebanon No 1197 on 31/10/2003.
Sans aucune responsabilite du contenu of
2 NORTHGATE UNIVERSITY
hereby confers upon-
Karim. N;asser-Haddad
the degree
Bachelor of Science
in ClVﬂ Engineering
with all the Honours and DlStlnCthTIS belonging to
the School of Engineering and Applied Sciences
The Degree awarded is validated with the
seal of Northgate University and the
Given h}thi'cosia: Cyprus on the twenty third day of June,
" of the year two thousand and eleven
Dean of the School of
Engineering and Applied Sciences
Serial No. 5/2/4/218.2011`;

test('legalised diploma read by OCR: holder, university, programme, date in words, serial number', () => {
  const r = readDocument(LEGALISED, [...PEOPLE, { id: 'k', name: 'Karim Nasser Haddad' }]);
  assert.equal(r.info.kind, 'diploma');
  assert.equal(r.info.holder, 'Karim Nasser-Haddad');
  assert.equal(r.info.institution, 'Northgate University');
  assert.equal(r.info.area, 'Civil Engineering');
  assert.equal(r.info.degree, 'bachelor');
  assert.equal(r.info.date, '2011-06-23');
  assert.equal(r.info.number, '5/2/4/218.2011');
  assert.deepEqual(r.match, { id: 'k', by: 'holder' });
  assert.equal(cleanOrg('ТОО «КАЗМУНАЙГАЗ СЕРВИС»'), 'ТОО «Казмунайгаз Сервис»');
  assert.equal(cleanOrg('‚„„мемлекеттік техникалық университетінің. —'), 'мемлекеттік техникалық университетінің');
  assert.equal(readDocument('CERTIFICATE\nThis is to certify that\nArman Akhmetov\nNEBOSH International General Certificate in Occupational Health and Safety', PEOPLE).info.title, 'NEBOSH International General Certificate');
});

// a trilingual Kazakh diploma as OCR reads it (fictional person): Kazakh part noisy, Russian part clean
const TRILINGUAL = `Абай атындағы Батыс Қазақстан
‚„„„мемлекеттк техникалык университетнн. —
(жоғары оқу орнының толық атауы)
Сейтов Ерлан
мамандығы бойынша |
(мамандықтың атауы)
Электр энергетикасы
БАКАЛАВРЫ
академиялық дәрежесі берілді
Западно-Казахстанского государственного
технического университета им. Абая
(полное наименование высшего учебного заведения)
присуждена академическая степень
БАКАЛАВР
по специальности Электроэнергетика
State Technical University
(full name of higher education institution)
onferred upon—.__ s
Seitov Yerlan
the degree of Bachelor in Electrical Power Engineering
2012 года`;

const VISA = `МӘРТЕСІ / ENTRIES АЯҚТАЛУ
MULTIPLE 26.01.2027
БЕРІЛГЕН ЖЕРІ / PLACE OF ISSUE
БЕРІЛГЕН КҮНІ / DATE OF ISSUE
27.01.2026
ТЕГІ - АТЫ / NAME
SEITOV YERLAN
VMKAZSEITOV<<YERLAN<<<<<<<<<<<<`;

test('trilingual diploma: the clean Russian institution and specialty; a visa is no diploma', () => {
  const r = readDocument(TRILINGUAL, PEOPLE);
  assert.equal(r.info.kind, 'diploma');
  assert.equal(r.info.institution, 'Западно-Казахстанского государственного технического университета им. Абая');
  assert.equal(r.info.area, 'Электроэнергетика');
  assert.equal(r.info.degree, 'bachelor');
  assert.equal(r.match?.id, 'c3');
  const v = readDocument(VISA, PEOPLE);
  assert.deepEqual([v.info.kind, v.info.title, v.info.date, v.info.expires], ['id', 'Visa', '2026-01-27', '2027-01-26']);
  assert.equal(v.match?.id, 'c3');
  // identity papers never become certificates in the profile
  assert.deepEqual(applyDocuments({ certificates: [] }, [{ id: 'v', ...v.info }]).certificates, []);
});

test('names: Latin and Cyrillic spellings, case endings, no false friends', () => {
  assert.equal(skeleton('Akhmetov'), skeleton('Ахметов'));
  assert.equal(skeleton('Zhanar'), skeleton('Жанар'));
  assert.equal(skeleton('Yerlan'), skeleton('Ерлан'));
  assert.equal(skeleton('Yulia'), skeleton('Юлия'));
  for (const [a, b] of [['Арман', 'Арману'], ['Ахметова', 'Ахметовой'], ['Мария', 'Марии'], ['Сергей', 'Сергею'], ['Арман', 'Арманға'], ['Болатұлы', 'Болатұлына']]) {
    assert.ok(sameWord(skeleton(a), skeleton(b)), `${a} = ${b}`);
  }
  for (const [a, b] of [['Марат', 'Мария'], ['Нур', 'Нурлан'], ['Азат', 'Азамат'], ['Асан', 'Асель']]) {
    assert.ok(!sameWord(skeleton(a), skeleton(b)), `${a} ≠ ${b}`);
  }
});

test('PMI certificate: holder in Latin, candidate in Cyrillic', () => {
  const r = readDocument(PMI, PEOPLE);
  assert.equal(r.info.kind, 'certificate');
  assert.equal(r.info.holder, 'Arman Akhmetov');
  assert.equal(r.info.title, 'Project Management Professional (PMP)');
  assert.equal(r.info.issuer, 'Project Management Institute (PMI)');
  assert.equal(r.info.date, '2021-03-12');
  assert.equal(r.info.expires, '2027-03-11');
  assert.equal(r.info.number, '2318841');
  assert.deepEqual(r.match, { id: 'c1', by: 'holder' });
});

test('diploma: holder in the dative, institution, programme, degree', () => {
  const r = readDocument(DIPLOMA, PEOPLE);
  assert.equal(r.info.kind, 'diploma');
  assert.equal(r.info.holder, 'Нурлановой Айгерим Серикқызы');
  assert.equal(r.info.degree, 'bachelor');
  assert.match(r.info.institution, /Евразийского национального университета имени Л\.Н\. Гумилева/);
  assert.equal(r.info.area, '5В070300 – Информационные системы');
  assert.equal(r.info.date, '2015-06-30'); // the issue date, not the commission's
  assert.deepEqual(r.match, { id: 'c2', by: 'holder' });
});

test('training centre certificate in Russian, candidate in Latin', () => {
  const r = readDocument(COURSE, PEOPLE);
  assert.equal(r.info.holder, 'Сеитов Ерлан Маратович');
  assert.equal(r.info.title, 'Управление ИТ-проектами по стандарту PMBOK');
  assert.equal(r.info.issuer, 'ТОО «Учебный центр Профи»');
  assert.equal(r.info.number, '4512');
  assert.equal(r.info.date, '2022-11-15');
  assert.deepEqual(r.match, { id: 'c3', by: 'holder' });
  // the programme on the next line (as OCR splits it): without the quotes
  assert.equal(readDocument(COURSE.replace('программе «', 'программе\n«'), PEOPLE).info.title, 'Управление ИТ-проектами по стандарту PMBOK');
});

test('online course: the name above "has successfully completed"', () => {
  const r = readDocument(COURSERA, PEOPLE);
  assert.equal(r.info.holder, 'Arman Akhmetov');
  assert.equal(r.info.title, 'Google Data Analytics');
  assert.equal(r.info.issuer, 'Google');
  assert.equal(r.info.date, '2023-06-12');
  assert.equal(r.match.id, 'c1');
});

test('no holder phrase: the candidate named anywhere in the text', () => {
  const r = readDocument(AWS, PEOPLE);
  assert.equal(r.info.title, 'AWS Certified Solutions Architect – Associate');
  assert.equal(r.info.issuer, 'Amazon Web Services');
  assert.equal(r.info.date, '2024-02-01');
  assert.equal(r.info.expires, '2027-02-01');
  assert.equal(r.info.number, '8XK2PQ');
  assert.deepEqual(r.match, { id: 'c4', by: 'text' });
});

test('ambiguous or unknown holder: suggestions only', () => {
  const twins = [{ id: 'a', name: 'Akhmetov Arman' }, { id: 'b', name: 'Ахметов Арман Серикович' }];
  const tie = readDocument(PMI, twins);
  assert.equal(tie.match, null);
  assert.deepEqual(tie.suggestions.map((s) => s.id).sort(), ['a', 'b']);
  // the patronymic decides
  const full = readDocument('Настоящий сертификат выдан\nАхметову Арману Болатовичу\nITIL 4 Foundation', [...twins, PEOPLE[0]]);
  assert.equal(full.info.title, 'ITIL 4 Foundation');
  assert.deepEqual(full.match, { id: 'c1', by: 'holder' });
  const nobody = readDocument(PMI, [{ id: 'x', name: 'Иванов Иван' }]);
  assert.equal(nobody.match, null);
  assert.deepEqual(nobody.suggestions, []);
  // the surname alone is a hint, not a match
  const initial = readDocument('CERTIFICATE\nSMAGULOVA V.\nITIL 4 Foundation\nPeopleCert', [{ id: 'v', name: 'Смагулова Виктория' }, { id: 'n', name: 'Ким Нина' }]);
  assert.equal(initial.match, null);
  assert.deepEqual(initial.suggestions, [{ id: 'v', hits: 1 }]);
  // a second candidate sharing one name word does not make a sure match ambiguous
  assert.deepEqual(readDocument(PMI, [...PEOPLE, { id: 'x', name: 'Arman Seitkali' }]).match, { id: 'c1', by: 'holder' });
});

test('profile: documents confirm entries, add missing ones and are removed again', () => {
  const p0 = refresh({ certificates: [{ name: 'PMP', date: '2021' }], education: [{ institution: 'ЕНУ им. Гумилева', endDate: '2015' }] });
  const docs = [
    { id: 'd1', kind: 'certificate', title: 'Project Management Professional (PMP)', issuer: 'Project Management Institute (PMI)', date: '2021-03-12' },
    { id: 'd2', kind: 'certificate', title: 'ITIL 4 Foundation', issuer: 'PeopleCert', date: '2022-05-01' },
    { id: 'd3', kind: 'diploma', institution: 'Евразийский национальный университет', area: 'Информационные системы', degree: 'bachelor', date: '2015-06-30' },
  ];
  const p = applyDocuments(p0, docs);
  assert.deepEqual(p.certificates, [
    { name: 'PMP', date: '2021', issuer: 'Project Management Institute (PMI)', doc: 'd1' },
    { name: 'ITIL 4 Foundation', date: '2022', issuer: 'PeopleCert', doc: 'd2', fromDoc: true },
  ]);
  assert.equal(p.education.length, 2);
  assert.deepEqual(p.education[1], { institution: 'Евразийский национальный университет', area: 'Информационные системы', endDate: '2015', degree: 'bachelor', doc: 'd3', fromDoc: true });
  // a manual edit keeps the marks
  assert.deepEqual(refresh(p).certificates, p.certificates);
  // applying again changes nothing; without the documents the CV's own entries stay, unmarked
  assert.deepEqual(applyDocuments(p, docs), p);
  const back = applyDocuments(p, []);
  assert.deepEqual(back.certificates, [{ name: 'PMP', date: '2021', issuer: 'Project Management Institute (PMI)' }]);
  assert.equal(back.education.length, 1);
  assert.equal(applyDocuments(null, [docs[1]]).certificates[0].name, 'ITIL 4 Foundation');
  // the same certification under the CV's shorter name is confirmed, not added twice
  const istqb = applyDocuments({ certificates: [{ name: 'ISTQB Foundation Level', date: null }] },
    [{ id: 'd4', kind: 'certificate', title: 'ISTQB Certified Tester Foundation Level', issuer: 'ISTQB', date: '2024-03-18' }]);
  assert.deepEqual(istqb.certificates, [{ name: 'ISTQB Foundation Level', date: '2024', issuer: 'ISTQB', doc: 'd4' }]);
  // two copies of one certificate: one entry; when the first copy goes, the second one confirms it
  const copies = [docs[1], { ...docs[1], id: 'd2b' }];
  const twice = applyDocuments({ certificates: [] }, copies);
  assert.equal(twice.certificates.length, 1);
  assert.equal(applyDocuments(twice, [copies[1]]).certificates[0].doc, 'd2b');
});

test('copies of one paper share a key', () => {
  const a = readDocument(PMI, PEOPLE).info.key;
  assert.equal(a, readDocument(PMI.replace('2318841', '9999999'), PEOPLE).info.key);
  assert.equal(a, readDocument('CERTIFICATE\nPMP\nArman Akhmetov', PEOPLE).info.key); // PMP = Project Management Professional
  assert.notEqual(a, readDocument(AWS, PEOPLE).info.key);
  assert.match(readDocument(DIPLOMA, PEOPLE).info.key, /^d:bachelor:/);
  assert.equal(readDocument('CERTIFICATE\nThis is to certify that\nArman Akhmetov\nTraining Centre LLP', PEOPLE).info.key, null);
});

test('the same person uploaded again', () => {
  const base = [
    { id: 'a', name: 'Ахметов Арман Болатович', email: 'arman@example.com', phone: '+7 701 111 22 33' },
    { id: 'b', name: 'Нурланова Айгерим', email: null, phone: null },
    { id: 'c', name: 'Ким Марат Ильич', email: 'kim@example.com', phone: null },
  ];
  const p = (name, email = null, phone = null) => ({ basics: { name, email, phone } });
  assert.deepEqual(samePerson(p('Arman Akhmetov'), base), { id: 'a', by: 'name' });
  assert.deepEqual(samePerson(p('Кто-то Другой', 'ARMAN@example.com'), base), { id: 'a', by: 'contact' });
  assert.deepEqual(samePerson(p('X Y', null, '8 (701) 111-22-33'), base), { id: 'a', by: 'contact' });
  assert.deepEqual(samePerson(p('Aigerim Nurlanova', 'new@example.com'), base), { id: 'b', by: 'name' });
  assert.equal(samePerson(p('Ахметов Арман Серикович'), base), null, 'another patronymic is another person');
  assert.equal(samePerson(p('Ким Марат', 'other@example.com'), base), null, 'the only contact both have differs');
  assert.equal(samePerson(p('Ахметов Ерлан'), base), null);
  assert.equal(samePerson(p(null), base), null);
});

test('CLI: document and documents ops', () => {
  const cli = fileURLToPath(new URL('./cli.mjs', import.meta.url));
  const run = (req) => JSON.parse(execFileSync(process.execPath, [cli], { input: JSON.stringify(req) }).toString());
  const r = run({ op: 'document', text: COURSE, candidates: PEOPLE });
  assert.equal(r.match.id, 'c3');
  const p = run({ op: 'documents', profile: { certificates: [] }, docs: [{ id: 'd', kind: 'certificate', ...r.info }] }).profile;
  assert.equal(p.certificates[0].doc, 'd');
});
