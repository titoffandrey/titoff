'use strict';
/*
 * Значки посетителя: устройство, операционная система, браузер и флаг страны.
 *
 * Нужны в двух местах — в строке заказа («откуда зашёл») и в метрике, — поэтому
 * лежат отдельным модулем. Требовать отсюда lib/render.js нельзя: render сам
 * подключает этот файл, и вышел бы цикл. Поэтому наружу отдаётся только
 * безопасная разметка без пользовательского текста: подписи собирает и
 * экранирует вызывающий (`clientMarks()` в lib/render.js).
 *
 * Холст 24×24 и волосяная обводка 1.5 — тот же вес штриха, что у глифов
 * характеристик и блока доверия на витрине. Единственный залитый глиф — яблоко:
 * это настоящая марка Apple, ту же самую берёт заголовок первого экрана
 * (`APPLE_MARK` в lib/render.js собирается из `APPLE_PATH` ниже).
 */

// Оригинальный глиф Apple — один на всю систему: и заголовок витрины, и значок
// операционной системы в панелях.
const APPLE_PATH = '<path d="m13.0729 17.6825a3.61 3.61 0 0 0 -1.7248 3.0365 3.5132 3.5132 0 0 0 2.1379 3.2223 8.394 8.394 0 0 1 -1.0948 2.2618c-.6816.9812-1.3943 1.9623-2.4787 1.9623s-1.3633-.63-2.613-.63c-1.2187 0-1.6524.6507-2.644.6507s-1.6833-.9089-2.4787-2.0243a9.7842 9.7842 0 0 1 -1.6628-5.2776c0-3.0984 2.014-4.7405 3.9969-4.7405 1.0535 0 1.9314.6919 2.5924.6919.63 0 1.6112-.7333 2.8092-.7333a3.7579 3.7579 0 0 1 3.1604 1.5802zm-3.7284-2.8918a3.5615 3.5615 0 0 0 .8469-2.22 1.5353 1.5353 0 0 0 -.0311-.32 3.5686 3.5686 0 0 0 -2.3445 1.2084 3.4629 3.4629 0 0 0 -.8779 2.1585 1.419 1.419 0 0 0 .0311.2892 1.1657 1.1657 0 0 0 .2169.0207 3.0935 3.0935 0 0 0 2.1586-1.1368z"/>';

// glyph — содержимое svg; box — свой viewBox, если холст не 24×24;
// fill — глиф залитый, а не обводкой.
const ICONS = {
  /* ---- устройства ---- */
  desktop: { glyph: '<rect x="2.6" y="4.2" width="18.8" height="12.4" rx="2.1"/><path d="M8.8 20.2h6.4M12 16.6v3.6" stroke-linecap="round"/>' },
  phone: { glyph: '<rect x="7.1" y="2.4" width="9.8" height="19.2" rx="2.4"/><path d="M10.8 5.2h2.4M10.6 19h2.8" stroke-linecap="round"/>' },
  tablet: { glyph: '<rect x="4.6" y="2.4" width="14.8" height="19.2" rx="2.2"/><path d="M10.8 18.9h2.4" stroke-linecap="round"/>' },
  bot: { glyph: '<rect x="3.7" y="7.6" width="16.6" height="12.1" rx="3.4"/><path d="M12 3.9v3.7" stroke-linecap="round"/><circle cx="12" cy="2.9" r="1.2"/><path d="M9.2 12.6v1.8M14.8 12.6v1.8" stroke-linecap="round"/>' },

  /* ---- операционные системы ---- */
  apple: { box: '0.26 12 13.48 16.44', fill: true, glyph: APPLE_PATH },
  // Купол с антеннами и двумя глазами — силуэт робота Android.
  android: { glyph: '<path d="M4.9 18.4a7.1 7.1 0 0 1 14.2 0z" stroke-linejoin="round"/><path d="M7.6 8.6 6 5.9M16.4 8.6 18 5.9" stroke-linecap="round"/><circle cx="9.5" cy="14.1" r=".95" fill="currentColor" stroke="none"/><circle cx="14.5" cy="14.1" r=".95" fill="currentColor" stroke="none"/>' },
  windows: { glyph: '<rect x="3.4" y="3.4" width="7.4" height="7.4" rx=".7"/><rect x="13.2" y="3.4" width="7.4" height="7.4" rx=".7"/><rect x="3.4" y="13.2" width="7.4" height="7.4" rx=".7"/><rect x="13.2" y="13.2" width="7.4" height="7.4" rx=".7"/>' },
  // Терминал: пингвина волосяной линией не нарисовать, а окно с приглашением
  // ввода читается как Linux сразу.
  linux: { glyph: '<rect x="2.6" y="4.3" width="18.8" height="15.4" rx="2.2"/><path d="M6.9 9.7l2.7 2.6-2.7 2.6M12.6 15.3h4.5" stroke-linecap="round" stroke-linejoin="round"/>' },

  /* ---- браузеры ---- */
  chrome: { glyph: '<circle cx="12" cy="12" r="9.2"/><circle cx="12" cy="12" r="3.6"/><path d="M15.6 12h5.6M10.2 10.1 4.6 6.5M10.2 13.9 6.9 20.4" stroke-linecap="round"/>' },
  safari: { glyph: '<circle cx="12" cy="12" r="9.2"/><path d="M16.1 7.9 10.7 10.7 7.9 16.1 13.3 13.3z" stroke-linejoin="round"/>' },
  firefox: { glyph: '<circle cx="12" cy="12" r="9.2"/><path d="M17 7.7c-2.9-1.5-6.5-.4-8 2.5-1.2 2.3-.3 5.1 2 6.2 1.8 1 4-.2 4.9-1.9.7-1.4.1-3.1-1.3-3.8" stroke-linecap="round"/>' },
  edge: { glyph: '<circle cx="12" cy="12" r="9.2"/><path d="M4.2 14.6c1.8 1.2 4.5 1.7 7.3 1.1 3.5-.7 5.8-3 5.5-5.3-.3-2.3-3-3.7-6-3.3-2.6.4-4.7 2.1-5.1 4.2" stroke-linecap="round"/>' },
  opera: { glyph: '<circle cx="12" cy="12" r="9.2"/><ellipse cx="12" cy="12" rx="4" ry="7.4"/>' },
  // «Я» внутри круга: рисовать фирменную букву кривыми — заведомо мимо, а
  // системным шрифтом она узнаётся с первого взгляда.
  yandex: { glyph: '<circle cx="12" cy="12" r="9.2"/><text x="12" y="16.6" text-anchor="middle" font-family="-apple-system,Segoe UI,Roboto,sans-serif" font-size="12.5" font-weight="700" fill="currentColor" stroke="none">Я</text>' },
  telegram: { glyph: '<path d="M21.2 4.4 2.9 11.5c-.7.3-.7.8 0 1l4.6 1.4 1.7 5.3c.2.6.5.7.9.3l2.5-2.4 4.8 3.6c.6.4 1 .2 1.2-.5l3-14.1c.2-.9-.3-1.3-1.4-.7z" stroke-linejoin="round"/><path d="M7.5 13.9 18 7.2l-7.6 7.3-.3 3.6" stroke-linejoin="round"/>' },

  /* ---- источники перехода ---- */
  // Стрелка, входящая в окно: набрали адрес или пришли из закладок.
  direct: { glyph: '<path d="M13.8 3.9h4.3c1.1 0 2 .9 2 2v12.2c0 1.1-.9 2-2 2h-4.3" stroke-linecap="round"/><path d="M3.9 12h10.3M10.7 8.4 14.3 12l-3.6 3.6" stroke-linecap="round" stroke-linejoin="round"/>' },
  link: { glyph: '<path d="M10.3 13.7a3.9 3.9 0 0 0 5.6 0l2.5-2.5a3.9 3.9 0 1 0-5.5-5.5l-1.3 1.3" stroke-linecap="round"/><path d="M13.7 10.3a3.9 3.9 0 0 0-5.6 0l-2.5 2.5a3.9 3.9 0 1 0 5.5 5.5l1.3-1.3" stroke-linecap="round"/>' },
  search: { glyph: '<circle cx="10.8" cy="10.8" r="6.3"/><path d="m15.5 15.5 4.6 4.6" stroke-linecap="round"/>' },
  // Буква в круге — тем же приёмом, что «Я» у Яндекса: рисовать чужой логотип
  // кривыми заведомо мимо, а буква узнаётся сразу.
  google: { glyph: '<circle cx="12" cy="12" r="9.2"/><text x="12" y="16.4" text-anchor="middle" font-family="-apple-system,Segoe UI,Roboto,sans-serif" font-size="12" font-weight="700" fill="currentColor" stroke="none">G</text>' },
  vk: { glyph: '<rect x="3" y="3" width="18" height="18" rx="5.2"/><text x="12" y="15.9" text-anchor="middle" font-family="-apple-system,Segoe UI,Roboto,sans-serif" font-size="8.4" font-weight="700" fill="currentColor" stroke="none">VK</text>' },

  /* ---- страницы витрины ---- */
  home: { glyph: '<path d="M3.9 10.6 12 4.1l8.1 6.5v9.4h-5.3v-5.3H9.2V20H3.9z" stroke-linejoin="round"/>' },
  bag: { glyph: '<path d="M5.6 7.9h12.8l1 12.1H4.6z" stroke-linejoin="round"/><path d="M8.9 10V6.7a3.1 3.1 0 0 1 6.2 0V10" stroke-linecap="round"/>' },
  tag: { glyph: '<path d="M4.2 4.2h7.3l8.3 8.3-7.3 7.3-8.3-8.3z" stroke-linejoin="round"/><circle cx="8.2" cy="8.2" r="1.4"/>' },
  doc: { glyph: '<path d="M6.3 3.7h7.1l4.3 4.3v12.3H6.3z" stroke-linejoin="round"/><path d="M13.4 3.7V8h4.3M9.1 12.5h5.8M9.1 15.9h5.8" stroke-linecap="round"/>' },

  /* ---- значки сводки ---- */
  // Кардиограмма: «сейчас на сайте» — единственное число метрики, которое живёт
  // прямо в эту секунду.
  activity: { glyph: '<path d="M3.2 12h3.5l2.4-6.2 4 12.4 2.5-6.9 1.7 3.1h3.5" stroke-linecap="round" stroke-linejoin="round"/>' },
  users: { glyph: '<circle cx="9.4" cy="8.4" r="3.5"/><path d="M3.4 19.6c0-3.3 2.7-5.6 6-5.6s6 2.3 6 5.6" stroke-linecap="round"/><path d="M16.4 5.6a3.3 3.3 0 0 1 0 6.4M17.6 14.4c1.9.7 3.1 2.5 3.1 5" stroke-linecap="round"/>' },
  eye: { glyph: '<path d="M2.7 12S6.1 6 12 6s9.3 6 9.3 6-3.4 6-9.3 6-9.3-6-9.3-6z" stroke-linejoin="round"/><circle cx="12" cy="12" r="3"/>' },
  clock: { glyph: '<circle cx="12" cy="12" r="8.8"/><path d="M12 6.8V12l3.4 2.1" stroke-linecap="round"/>' },
  pin: { glyph: '<path d="M12 21c0-.1 6.3-5.9 6.3-10.3a6.3 6.3 0 1 0-12.6 0C5.7 15.1 12 20.9 12 21z" stroke-linejoin="round"/><circle cx="12" cy="10.5" r="2.5"/>' },
  // Календарь стоит на кнопке периода в метрике — там же, где он у Trends.
  calendar: { glyph: '<rect x="3.4" y="5.2" width="17.2" height="15.4" rx="2.4"/><path d="M3.4 9.8h17.2M8.2 3.4v3.6M15.8 3.4v3.6" stroke-linecap="round"/>' },

  /* ---- запасной глиф: земной шар ---- */
  globe: { glyph: '<circle cx="12" cy="12" r="9.2"/><path d="M12 2.8c2.5 2.5 3.9 5.8 3.9 9.2S14.5 18.7 12 21.2c-2.5-2.5-3.9-5.8-3.9-9.2S9.5 5.3 12 2.8z"/><path d="M3 12h18" stroke-linecap="round"/>' }
};

function has(key) { return Object.prototype.hasOwnProperty.call(ICONS, String(key || '')); }

// Разметка одного значка. Ничего пользовательского внутрь не попадает: имя
// глифа сверяется со списком, подпись рисует вызывающий рядом.
function icon(key, className) {
  const g = ICONS[String(key || '')] || ICONS.globe;
  const cls = 'cico' + (className ? ' ' + String(className).replace(/[^a-z0-9 _-]/gi, '') : '');
  const paint = g.fill ? 'fill="currentColor"' : 'fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"';
  return `<svg class="${cls}" viewBox="${g.box || '0 0 24 24'}" ${paint} aria-hidden="true" focusable="false">${g.glyph}</svg>`;
}

function deviceKey(device, model) {
  const s = String(device || '') + ' ' + String(model || '');
  if (/робот|\bbot\b|crawler|spider/i.test(s)) return 'bot';
  if (/планшет|ipad|tablet/i.test(s)) return 'tablet';
  if (/телефон|iphone|ipod|phone|mobile/i.test(s)) return 'phone';
  return 'desktop';
}

function osKey(os) {
  const s = String(os || '');
  if (/ios|mac|ipad|iphone|watchos/i.test(s)) return 'apple';
  if (/android/i.test(s)) return 'android';
  if (/windows/i.test(s)) return 'windows';
  if (/linux|ubuntu|debian|chrome os|cros/i.test(s)) return 'linux';
  return 'globe';
}

/* Источник перехода. В метрике это либо наши собственные подписи («Прямой
 * заход», «Внутренний переход»), либо голый домен — по нему и опознаём. Чужой
 * домен без правила остаётся ссылкой: «пришли с какого-то сайта» — это и есть
 * правда о нём. */
function sourceKey(source) {
  const s = String(source || '').toLowerCase();
  if (!s || /прямой/.test(s)) return 'direct';
  if (/внутренн/.test(s)) return 'link';
  if (/yandex|ya\.ru|яндекс/.test(s)) return 'yandex';
  if (/google|googleusercontent/.test(s)) return 'google';
  if (/t\.me|telegram/.test(s)) return 'telegram';
  if (/vk\.com|vk\.ru|vkontakte/.test(s)) return 'vk';
  if (/bing|duckduckgo|rambler|mail\.ru|search|поиск/.test(s)) return 'search';
  return 'link';
}

// Страница витрины: главная, оформление, карточка товара или правовой документ.
function pageKey(path) {
  const p = String(path || '');
  if (p === '/' || /^\/\?/.test(p)) return 'home';
  if (/^\/checkout|^\/pay\//.test(p)) return 'bag';
  if (/^\/product\//.test(p)) return 'tag';
  return 'doc';
}

function browserKey(browser) {
  const s = String(browser || '');
  if (/яндекс|yandex/i.test(s)) return 'yandex';
  if (/telegram/i.test(s)) return 'telegram';
  if (/edge/i.test(s)) return 'edge';
  if (/opera|opr/i.test(s)) return 'opera';
  if (/firefox/i.test(s)) return 'firefox';
  if (/chrome|chromium/i.test(s)) return 'chrome';
  if (/safari/i.test(s)) return 'safari';
  return 'globe';
}

/*
 * Флаг страны.
 *
 * Рисуется эмодзи из пары региональных индикаторов, а не картинкой: двести
 * флагов в SVG в репозиторий не положишь, а внешние адреса запрещены CSP. На
 * macOS и iOS это настоящий флаг; там, где системного набора флагов нет
 * (Windows), останутся две буквы кода страны — тоже понятная подпись.
 *
 * Код приходит либо от геосервиса (`countryCode`), либо от заголовка
 * `CF-IPCountry`. У заказов и карточек, записанных до появления этого поля,
 * есть только название страны по-русски — для них таблица ниже.
 */
const CODES = {
  RU: ['россия', 'российская федерация', 'russia', 'russian federation'],
  BY: ['беларусь', 'белоруссия', 'belarus'],
  KZ: ['казахстан', 'kazakhstan'],
  UA: ['украина', 'ukraine'],
  UZ: ['узбекистан', 'uzbekistan'],
  KG: ['киргизия', 'кыргызстан', 'kyrgyzstan'],
  TJ: ['таджикистан', 'tajikistan'],
  TM: ['туркмения', 'туркменистан', 'turkmenistan'],
  AZ: ['азербайджан', 'azerbaijan'],
  AM: ['армения', 'armenia'],
  GE: ['грузия', 'georgia'],
  MD: ['молдавия', 'молдова', 'moldova'],
  LV: ['латвия', 'latvia'], LT: ['литва', 'lithuania'], EE: ['эстония', 'estonia'],
  PL: ['польша', 'poland'], DE: ['германия', 'germany'], NL: ['нидерланды', 'netherlands'],
  FR: ['франция', 'france'], GB: ['великобритания', 'соединенное королевство', 'united kingdom'],
  US: ['сша', 'соединенные штаты', 'соединенные штаты америки', 'united states', 'united states of america'],
  CA: ['канада', 'canada'], TR: ['турция', 'turkey', 'turkiye'],
  AE: ['оаэ', 'объединенные арабские эмираты', 'united arab emirates'],
  IL: ['израиль', 'israel'], CY: ['кипр', 'cyprus'], CZ: ['чехия', 'czechia', 'czech republic'],
  SK: ['словакия', 'slovakia'], SI: ['словения', 'slovenia'], RS: ['сербия', 'serbia'],
  HR: ['хорватия', 'croatia'], BG: ['болгария', 'bulgaria'], RO: ['румыния', 'romania'],
  HU: ['венгрия', 'hungary'], GR: ['греция', 'greece'], IT: ['италия', 'italy'],
  ES: ['испания', 'spain'], PT: ['португалия', 'portugal'], CH: ['швейцария', 'switzerland'],
  AT: ['австрия', 'austria'], BE: ['бельгия', 'belgium'], SE: ['швеция', 'sweden'],
  NO: ['норвегия', 'norway'], DK: ['дания', 'denmark'], FI: ['финляндия', 'finland'],
  IE: ['ирландия', 'ireland'], IS: ['исландия', 'iceland'], LU: ['люксембург', 'luxembourg'],
  MT: ['мальта', 'malta'], ME: ['черногория', 'montenegro'], MK: ['северная македония', 'north macedonia'],
  AL: ['албания', 'albania'], BA: ['босния и герцеговина', 'bosnia and herzegovina'],
  CN: ['китай', 'china'], JP: ['япония', 'japan'], KR: ['южная корея', 'республика корея', 'south korea'],
  IN: ['индия', 'india'], TH: ['таиланд', 'thailand'], VN: ['вьетнам', 'vietnam'],
  ID: ['индонезия', 'indonesia'], MY: ['малайзия', 'malaysia'], SG: ['сингапур', 'singapore'],
  HK: ['гонконг', 'hong kong'], TW: ['тайвань', 'taiwan'], PH: ['филиппины', 'philippines'],
  MN: ['монголия', 'mongolia'], AU: ['австралия', 'australia'], NZ: ['новая зеландия', 'new zealand'],
  BR: ['бразилия', 'brazil'], AR: ['аргентина', 'argentina'], MX: ['мексика', 'mexico'],
  CL: ['чили', 'chile'], EG: ['египет', 'egypt'], ZA: ['юар', 'южная африка', 'south africa'],
  MA: ['марокко', 'morocco'], TN: ['тунис', 'tunisia'], DZ: ['алжир', 'algeria'],
  SA: ['саудовская аравия', 'saudi arabia'], QA: ['катар', 'qatar'], KW: ['кувейт', 'kuwait'],
  IR: ['иран', 'iran'], IQ: ['ирак', 'iraq'], PK: ['пакистан', 'pakistan'],
  BD: ['бангладеш', 'bangladesh'], LK: ['шри-ланка', 'sri lanka'], NP: ['непал', 'nepal'],
  SY: ['сирия', 'syria'], JO: ['иордания', 'jordan'], LB: ['ливан', 'lebanon'],
  NG: ['нигерия', 'nigeria'], KE: ['кения', 'kenya'], ET: ['эфиопия', 'ethiopia']
};

const BY_NAME = {};
for (const [code, names] of Object.entries(CODES)) for (const name of names) BY_NAME[name] = code;

function normalizeName(value) {
  return String(value || '').toLowerCase().replace(/ё/g, 'е').replace(/[«»"'().,]/g, ' ').replace(/\s+/g, ' ').trim();
}

// Двухбуквенный код страны: сначала явное поле, потом название по таблице.
function countryCode(country, code) {
  const raw = String(code || '').trim().toUpperCase();
  if (/^[A-Z]{2}$/.test(raw)) return raw;
  const name = normalizeName(country);
  if (/^[a-z]{2}$/.test(name)) return name.toUpperCase();
  return BY_NAME[name] || '';
}

function flag(country, code) {
  const iso = countryCode(country, code);
  if (!iso) return '';
  return String.fromCodePoint(...[...iso].map(ch => 0x1f1e6 + ch.charCodeAt(0) - 65));
}

/* Русское название страны по коду — обратная сторона той же таблицы.
 *
 * Нужно локальной базе городов (`lib/geoip.js`): в ней страны записаны кодом, а
 * панель русская. Вторая такая таблица разошлась бы с этой на первой правке, а
 * расхождение видно только глазами: у одной страны был бы флаг, а у другой имя.
 * Первое имя в списке и есть русское — остальные там ради поиска по написанию.
 */
const NAMES = {};
for (const [code, names] of Object.entries(CODES)) {
  const name = names[0];
  // Аббревиатуры пишутся целиком заглавными: «Сша» и «Оаэ» читаются как опечатка.
  // Их в списке ровно три, и все они короче четырёх букв.
  NAMES[code] = name.length <= 3 ? name.toUpperCase() : name.replace(/^./, ch => ch.toUpperCase());
}
function countryName(code) {
  const iso = String(code || '').trim().toUpperCase();
  return /^[A-Z]{2}$/.test(iso) ? (NAMES[iso] || '') : '';
}

module.exports = { icon, has, deviceKey, osKey, browserKey, sourceKey, pageKey, flag, countryCode, countryName, APPLE_PATH };
