// Countries and cities of work experience: recognised in CV text (ru/kk/en, Russian case endings), stored as a country
// code and a city id; labels for the UI come from meta(). A Kazakh legal form (ТОО, ЖШС, РГП...) without a place
// gives Kazakhstan, marked as inferred.
import { fold } from './parse.js';

export const COUNTRIES = {
  KZ: { en: 'Kazakhstan', ru: 'Казахстан', names: ['Казахстан', 'Қазақстан', 'Kazakhstan', 'Республика Казахстан', 'РК'] },
  RU: { en: 'Russia', ru: 'Россия', names: ['Россия', 'Ресей', 'Russia', 'Российская Федерация', 'РФ', 'Russian Federation'] },
  UZ: { en: 'Uzbekistan', ru: 'Узбекистан', names: ['Узбекистан', 'Өзбекстан', 'Uzbekistan'] },
  KG: { en: 'Kyrgyzstan', ru: 'Кыргызстан', names: ['Кыргызстан', 'Киргизия', 'Қырғызстан', 'Kyrgyzstan'] },
  TJ: { en: 'Tajikistan', ru: 'Таджикистан', names: ['Таджикистан', 'Тәжікстан', 'Tajikistan'] },
  TM: { en: 'Turkmenistan', ru: 'Туркменистан', names: ['Туркменистан', 'Түрікменстан', 'Turkmenistan'] },
  AZ: { en: 'Azerbaijan', ru: 'Азербайджан', names: ['Азербайджан', 'Әзірбайжан', 'Azerbaijan'] },
  GE: { en: 'Georgia', ru: 'Грузия', names: ['Грузия', 'Грузия', 'Georgia'] },
  AM: { en: 'Armenia', ru: 'Армения', names: ['Армения', 'Armenia'] },
  BY: { en: 'Belarus', ru: 'Беларусь', names: ['Беларусь', 'Белоруссия', 'Belarus'] },
  UA: { en: 'Ukraine', ru: 'Украина', names: ['Украина', 'Украина', 'Ukraine'] },
  TR: { en: 'Turkey', ru: 'Турция', names: ['Турция', 'Түркия', 'Turkey', 'Türkiye'] },
  AE: { en: 'United Arab Emirates', ru: 'ОАЭ', names: ['ОАЭ', 'Объединённые Арабские Эмираты', 'БАӘ', 'UAE', 'United Arab Emirates'] },
  CN: { en: 'China', ru: 'Китай', names: ['Китай', 'Қытай', 'China'] },
  KR: { en: 'South Korea', ru: 'Южная Корея', names: ['Южная Корея', 'Корея', 'Оңтүстік Корея', 'South Korea', 'Korea'] },
  DE: { en: 'Germany', ru: 'Германия', names: ['Германия', 'Германия', 'Germany'] },
  GB: { en: 'United Kingdom', ru: 'Великобритания', names: ['Великобритания', 'Англия', 'Ұлыбритания', 'United Kingdom', 'UK', 'England'] },
  US: { en: 'USA', ru: 'США', names: ['США', 'АҚШ', 'USA', 'United States'] },
  PL: { en: 'Poland', ru: 'Польша', names: ['Польша', 'Польша', 'Poland'] },
  NL: { en: 'Netherlands', ru: 'Нидерланды', names: ['Нидерланды', 'Голландия', 'Netherlands'] },
  SG: { en: 'Singapore', ru: 'Сингапур', names: ['Сингапур', 'Singapore'] },
  IN: { en: 'India', ru: 'Индия', names: ['Индия', 'Үндістан', 'India'] },
};

// [id, country, en, ru, ...other spellings]
const CITY_LIST = [
  ['astana', 'KZ', 'Astana', 'Астана', 'Нур-Султан', 'Нурсултан', 'Nur-Sultan', 'Nursultan'],
  ['almaty', 'KZ', 'Almaty', 'Алматы', 'Алма-Ата', 'Alma-Ata'],
  ['shymkent', 'KZ', 'Shymkent', 'Шымкент', 'Чимкент'],
  ['karaganda', 'KZ', 'Karaganda', 'Караганда', 'Қарағанды', 'Qaraghandy', 'Karagandy'],
  ['aktobe', 'KZ', 'Aktobe', 'Актобе', 'Ақтөбе', 'Aqtobe'],
  ['pavlodar', 'KZ', 'Pavlodar', 'Павлодар'],
  ['atyrau', 'KZ', 'Atyrau', 'Атырау'],
  ['aktau', 'KZ', 'Aktau', 'Актау', 'Ақтау', 'Aqtau'],
  ['oskemen', 'KZ', 'Oskemen', 'Усть-Каменогорск', 'Өскемен', 'Ust-Kamenogorsk'],
  ['semey', 'KZ', 'Semey', 'Семей', 'Семипалатинск'],
  ['kostanay', 'KZ', 'Kostanay', 'Костанай', 'Қостанай', 'Qostanay'],
  ['kyzylorda', 'KZ', 'Kyzylorda', 'Кызылорда', 'Қызылорда', 'Qyzylorda'],
  ['taraz', 'KZ', 'Taraz', 'Тараз'],
  ['oral', 'KZ', 'Oral', 'Уральск', 'Орал', 'Uralsk'],
  ['petropavl', 'KZ', 'Petropavl', 'Петропавловск', 'Петропавл'],
  ['turkistan', 'KZ', 'Turkistan', 'Туркестан', 'Түркістан'],
  ['kokshetau', 'KZ', 'Kokshetau', 'Кокшетау', 'Көкшетау'],
  ['taldykorgan', 'KZ', 'Taldykorgan', 'Талдыкорган', 'Талдықорған'],
  ['ekibastuz', 'KZ', 'Ekibastuz', 'Экибастуз', 'Екібастұз'],
  ['zhezkazgan', 'KZ', 'Zhezkazgan', 'Жезказган', 'Жезқазған'],
  ['temirtau', 'KZ', 'Temirtau', 'Темиртау', 'Теміртау'],
  ['moscow', 'RU', 'Moscow', 'Москва', 'Мәскеу'],
  ['spb', 'RU', 'Saint Petersburg', 'Санкт-Петербург', 'Петербург', 'St. Petersburg', 'St Petersburg'],
  ['novosibirsk', 'RU', 'Novosibirsk', 'Новосибирск'],
  ['yekaterinburg', 'RU', 'Yekaterinburg', 'Екатеринбург'],
  ['kazan', 'RU', 'Kazan', 'Казань'],
  ['omsk', 'RU', 'Omsk', 'Омск'],
  ['tashkent', 'UZ', 'Tashkent', 'Ташкент', 'Тошкент'],
  ['samarkand', 'UZ', 'Samarkand', 'Самарканд'],
  ['bishkek', 'KG', 'Bishkek', 'Бишкек'],
  ['dushanbe', 'TJ', 'Dushanbe', 'Душанбе'],
  ['baku', 'AZ', 'Baku', 'Баку'],
  ['tbilisi', 'GE', 'Tbilisi', 'Тбилиси'],
  ['minsk', 'BY', 'Minsk', 'Минск'],
  ['kyiv', 'UA', 'Kyiv', 'Киев', 'Київ', 'Kiev'],
  ['istanbul', 'TR', 'Istanbul', 'Стамбул', 'Ыстамбұл'],
  ['ankara', 'TR', 'Ankara', 'Анкара'],
  ['dubai', 'AE', 'Dubai', 'Дубай'],
  ['abudhabi', 'AE', 'Abu Dhabi', 'Абу-Даби'],
  ['beijing', 'CN', 'Beijing', 'Пекин'],
  ['shanghai', 'CN', 'Shanghai', 'Шанхай'],
  ['seoul', 'KR', 'Seoul', 'Сеул'],
  ['berlin', 'DE', 'Berlin', 'Берлин'],
  ['london', 'GB', 'London', 'Лондон'],
  ['newyork', 'US', 'New York', 'Нью-Йорк'],
  ['warsaw', 'PL', 'Warsaw', 'Варшава'],
  ['amsterdam', 'NL', 'Amsterdam', 'Амстердам'],
];
export const CITIES = Object.fromEntries(CITY_LIST.map(([id, country, en, ru]) => [id, { country, en, ru }]));

// Russian case endings: «в Астане», «в Москве», «в Казахстане», «Шымкенте»
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const variant = (f) => (/[а-яё]$/.test(f) ? (/[ая]$/.test(f) ? `${esc(f.slice(0, -1))}[аеиуыяю]` : `${esc(f)}(?:е|а|у|ом)?`) : esc(f));
const ENTRIES = [
  ...CITY_LIST.flatMap(([id, country, ...names]) => names.map((n) => [fold(n), { city: id, country }])),
  ...Object.entries(COUNTRIES).flatMap(([code, c]) => c.names.map((n) => [fold(n), { city: null, country: code }])),
].sort((a, b) => b[0].length - a[0].length);
const PLACE_RE = new RegExp(`(?<![\\p{L}])(${ENTRIES.map(([f]) => variant(f)).join('|')})(?![\\p{L}])`, 'gu');
const KZ_FORM = /(?<![\p{L}])(?:ТОО|ЖШС|РГП|РГКП|ГКП|КГП|КГУ|НАО|АҚ|РМК)(?![\p{L}])/u;
const ABBR = new Set(['рк', 'рф', 'uk', 'usa', 'uae', 'оаэ', 'сша', 'акш', 'баэ']); // abbreviations count only in capitals

function lookup(token) {
  for (const [f, v] of ENTRIES) if (new RegExp(`^${variant(f)}$`, 'u').test(token)) return v;
  return null;
}

// First city in the lines wins (its country too); otherwise the first country; otherwise a Kazakh legal form.
export function locate(lines) {
  let country = null;
  for (const raw of lines) {
    const line = String(raw || '');
    const f = fold(line);
    for (const m of f.matchAll(PLACE_RE)) {
      if (ABBR.has(m[1]) && !new RegExp(`(?<![\\p{L}])${m[1].toUpperCase()}(?![\\p{L}])`, 'u').test(line)) continue;
      const v = lookup(m[1]);
      if (v?.city) return { country: v.country, city: v.city };
      if (v && !country) country = v.country;
    }
  }
  if (country) return { country, city: null };
  if (lines.some((l) => KZ_FORM.test(String(l || '')))) return { country: 'KZ', city: null, inferred: true };
  return null;
}

// City id from a name typed by a person ("Астана", "astana", "Нур-Султан"), or null.
export function cityId(name) {
  const raw = String(name || '').trim();
  if (CITIES[raw]) return raw;
  const f = fold(raw);
  if (!f) return null;
  const v = lookup(f);
  return v?.city || null;
}

export function geoMeta() {
  return {
    countries: Object.entries(COUNTRIES).map(([code, c]) => ({ code, en: c.en, ru: c.ru })),
    cities: Object.entries(CITIES).map(([id, c]) => ({ id, country: c.country, en: c.en, ru: c.ru })),
  };
}
