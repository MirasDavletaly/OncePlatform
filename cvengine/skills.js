// Справочник навыков с синонимами (п. 4.2 ТЗ): одна запись - каноническое название и варианты написания.
// Хранится в конфигурации; в демо его можно дополнить в разделе «Справочник навыков» без изменения кода.
export const SKILL_DICT = {
  Python: { cat: 'lang', syn: ['Python3', 'Питон', 'Python 3'] },
  Java: { cat: 'lang', syn: ['Джава', 'Java SE', 'Java EE'] },
  JavaScript: { cat: 'lang', syn: ['JS', 'ECMAScript', 'Javascript', 'ES6'] },
  TypeScript: { cat: 'lang', syn: ['TS'] },
  Go: { cat: 'lang', syn: ['Golang'] },
  Kotlin: { cat: 'lang', syn: [] },
  Swift: { cat: 'lang', syn: [] },
  Dart: { cat: 'lang', syn: [] },
  SQL: { cat: 'data', syn: ['T-SQL', 'PL/SQL', 'язык SQL'] },
  Bash: { cat: 'ops', syn: ['Shell', 'shell-скрипты', 'bash-скрипты'] },
  Django: { cat: 'fw', syn: ['DRF'] },
  FastAPI: { cat: 'fw', syn: ['Fast API'] },
  'Spring Boot': { cat: 'fw', syn: ['SpringBoot', 'Spring'] },
  Hibernate: { cat: 'fw', syn: ['JPA/Hibernate'] },
  React: { cat: 'fw', syn: ['ReactJS', 'React.js'] },
  'Vue.js': { cat: 'fw', syn: ['Vue', 'VueJS', 'Vue 3'] },
  'Next.js': { cat: 'fw', syn: ['NextJS'] },
  Redux: { cat: 'fw', syn: ['Redux Toolkit'] },
  'Node.js': { cat: 'fw', syn: ['NodeJS', 'Node'] },
  HTML: { cat: 'fw', syn: ['HTML5'] },
  CSS: { cat: 'fw', syn: ['CSS3', 'SCSS'] },
  Webpack: { cat: 'fw', syn: [] },
  Jest: { cat: 'qa', syn: [] },
  Flutter: { cat: 'fw', syn: [] },
  Android: { cat: 'fw', syn: ['Android SDK'] },
  iOS: { cat: 'fw', syn: ['iOS SDK'] },
  Firebase: { cat: 'fw', syn: [] },
  PostgreSQL: { cat: 'data', syn: ['Postgres', 'PgSQL', 'Постгрес'] },
  Oracle: { cat: 'data', syn: ['Oracle DB'] },
  MySQL: { cat: 'data', syn: ['MariaDB'] },
  Redis: { cat: 'data', syn: [] },
  ClickHouse: { cat: 'data', syn: ['Clickhouse'] },
  Kafka: { cat: 'data', syn: ['Apache Kafka'] },
  Celery: { cat: 'fw', syn: [] },
  'REST API': { cat: 'fw', syn: ['REST', 'RESTful', 'RESTful API'] },
  Microservices: { cat: 'fw', syn: ['микросервисы', 'микросервисная архитектура', 'микросервистер'] },
  Docker: { cat: 'ops', syn: ['Докер', 'docker-compose'] },
  Kubernetes: { cat: 'ops', syn: ['k8s', 'K8S', 'Кубернетес'] },
  Terraform: { cat: 'ops', syn: [] },
  Ansible: { cat: 'ops', syn: [] },
  'GitLab CI': { cat: 'ops', syn: ['Gitlab-CI'] },
  Jenkins: { cat: 'ops', syn: [] },
  'CI/CD': { cat: 'ops', syn: ['CICD', 'continuous integration'] },
  AWS: { cat: 'ops', syn: ['Amazon Web Services'] },
  Prometheus: { cat: 'ops', syn: [] },
  Grafana: { cat: 'ops', syn: [] },
  Nginx: { cat: 'ops', syn: [] },
  Helm: { cat: 'ops', syn: [] },
  Linux: { cat: 'ops', syn: ['Линукс', 'Ubuntu', 'CentOS'] },
  Git: { cat: 'ops', syn: ['GitHub'] },
  'Windows Server': { cat: 'ops', syn: [] },
  'Active Directory': { cat: 'ops', syn: ['AD DS'] },
  Networking: { cat: 'ops', syn: ['компьютерные сети', 'TCP/IP', 'желілер'] },
  Monitoring: { cat: 'ops', syn: ['мониторинг', 'мониторинг систем'] },
  ITIL: { cat: 'ops', syn: [] },
  Maven: { cat: 'fw', syn: [] },
  JUnit: { cat: 'qa', syn: [] },
  pytest: { cat: 'qa', syn: ['PyTest'] },
  Selenium: { cat: 'qa', syn: ['Selenium WebDriver'] },
  Playwright: { cat: 'qa', syn: [] },
  Postman: { cat: 'qa', syn: [] },
  JMeter: { cat: 'qa', syn: ['Apache JMeter'] },
  TestRail: { cat: 'qa', syn: [] },
  'API testing': { cat: 'qa', syn: ['тестирование API', 'API тестілеу'] },
  'Test design': { cat: 'qa', syn: ['тест-дизайн', 'тест дизайн'] },
  'Regression testing': { cat: 'qa', syn: ['регрессионное тестирование'] },
  'Mobile testing': { cat: 'qa', syn: ['тестирование мобильных приложений'] },
  Jira: { cat: 'tool', syn: ['Джира', 'Atlassian Jira'] },
  Confluence: { cat: 'tool', syn: [] },
  Pandas: { cat: 'data', syn: [] },
  'Power BI': { cat: 'data', syn: ['PowerBI'] },
  Tableau: { cat: 'data', syn: [] },
  Excel: { cat: 'data', syn: ['MS Excel', 'Эксель'] },
  Statistics: { cat: 'data', syn: ['статистика', 'математическая статистика'] },
  'A/B testing': { cat: 'data', syn: ['A/B-тесты', 'АБ-тестирование', 'A/B тестілеу'] },
  Airflow: { cat: 'data', syn: ['Apache Airflow'] },
  PyTorch: { cat: 'ml', syn: ['Torch'] },
  'scikit-learn': { cat: 'ml', syn: ['sklearn'] },
  NLP: { cat: 'ml', syn: ['обработка естественного языка'] },
  LLM: { cat: 'ml', syn: ['большие языковые модели', 'large language models'] },
  'Computer vision': { cat: 'ml', syn: ['компьютерное зрение'] },
  MLflow: { cat: 'ml', syn: [] },
  BPMN: { cat: 'ba', syn: ['BPMN 2.0'] },
  UML: { cat: 'ba', syn: [] },
  'Requirements analysis': { cat: 'ba', syn: ['анализ требований', 'сбор требований', 'талаптарды талдау'] },
  'User stories': { cat: 'ba', syn: ['пользовательские истории'] },
  Camunda: { cat: 'ba', syn: [] },
  Scrum: { cat: 'pm', syn: [] },
  Agile: { cat: 'pm', syn: [] },
  Kanban: { cat: 'pm', syn: [] },
  'Risk management': { cat: 'pm', syn: ['управление рисками', 'тәуекелдерді басқару'] },
  Budgeting: { cat: 'pm', syn: ['бюджетирование'] },
  'Performance tuning': { cat: 'data', syn: ['оптимизация запросов', 'тюнинг производительности'] },
  Backup: { cat: 'data', syn: ['резервное копирование', 'сақтық көшірме'] },
  Replication: { cat: 'data', syn: ['репликация'] },
};

export const CATS = {
  lang: { ru: 'Языки программирования', kk: 'Бағдарламалау тілдері', en: 'Programming languages' },
  fw: { ru: 'Фреймворки и платформы', kk: 'Фреймворктер мен платформалар', en: 'Frameworks and platforms' },
  data: { ru: 'Данные и СУБД', kk: 'Деректер және ДҚБЖ', en: 'Data and databases' },
  ops: { ru: 'Инфраструктура и DevOps', kk: 'Инфрақұрылым және DevOps', en: 'Infrastructure and DevOps' },
  qa: { ru: 'Тестирование', kk: 'Тестілеу', en: 'Testing' },
  tool: { ru: 'Инструменты', kk: 'Құралдар', en: 'Tools' },
  ml: { ru: 'Машинное обучение', kk: 'Машиналық оқыту', en: 'Machine learning' },
  ba: { ru: 'Анализ', kk: 'Талдау', en: 'Analysis' },
  pm: { ru: 'Управление', kk: 'Басқару', en: 'Management' },
};

// поиск навыков в тексте: самые длинные варианты первыми, границы слова - Unicode.
// К кириллическим вариантам допускаются падежные окончания: «на Питоне», «в Докере», «Джирой».
const RU_END = '(?:ами|ах|ом|ой|ов|ею|а|у|е|ы|и)?';
const RU_VEND = '(?:ами|ам|ах|ой|ою|ей|ов|а|я|ы|и|е|у|ю)';
const stripEnd = (x) => x.replace(/(ами|ам|ах|ом|ой|ою|ей|ов|ею|а|я|у|ю|е|ы|и)$/u, '');
const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
const vowelEndS = (s) => /[а-яё]{3}[аяыие]$/i.test(s);
export const variantPattern = (s) => (vowelEndS(s) ? escRe(s.slice(0, -1)) + RU_VEND : escRe(s) + (/[а-яё]$/i.test(s) && s.length >= 4 ? RU_END : ''));
export function buildMatcher(dict) {
  const entries = [];
  for (const [canon, v] of Object.entries(dict)) {
    for (const s of [canon, ...(v.syn || [])]) entries.push([s, canon]);
  }
  entries.sort((a, b) => b[0].length - a[0].length);
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
  const map = new Map(entries.map(([s, c]) => [s.toLowerCase(), c]));
  // «Джира» → «Джирой», «микросервисы» → «микросервисами»: основа без конечной гласной + окончание
  const vowelEnd = (s) => /[а-яё]{3}[аяыие]$/i.test(s);
  for (const [s, c] of entries) if (vowelEnd(s) && !map.has(s.slice(0, -1).toLowerCase())) map.set(s.slice(0, -1).toLowerCase(), c);
  const alt = ([s]) => (vowelEnd(s) ? esc(s.slice(0, -1)) + RU_VEND : esc(s) + (/[а-яё]$/i.test(s) && s.length >= 4 ? RU_END : ''));
  // короткие обозначения (JS, TS, Go, Node, Excel, Swift) - с учетом регистра, чтобы не ловить обычные слова
  const ci = entries.filter(([s]) => s.length > 5);
  const cs = entries.filter(([s]) => s.length <= 5);
  const mk = (list, flags) => new RegExp(`(?<![\\p{L}\\p{N}+#.])(${list.map(alt).join('|')})(?![\\p{L}\\p{N}+#])`, flags);
  const reCi = mk(ci, 'giu');
  const reCs = mk(cs, 'gu');
  return (text) => {
    const found = new Set();
    for (const re of [reCi, reCs]) {
      for (const m of text.matchAll(re)) {
        const k = m[1].toLowerCase();
        const c = map.get(k) || map.get(stripEnd(k));
        if (c) found.add(c);
      }
    }
    return found;
  };
}
