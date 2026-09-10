'use strict';
/*
 * ПОЛНЫЙ КАТАЛОГ УСТРОЙСТВ APPLE — единственный источник правды.
 * Состав линейки, цвета, объёмы памяти и характеристики сняты с apple.com (июль 2026).
 * Цены — ориентир российского рынка на июль 2026 (серый импорт), правятся в админке.
 *
 * Формат товара:
 *   colors   = [{ name, hex }]                  — цвета корпуса
 *   storages = [{ label, add }]                 — вариант конфигурации, add = доплата к price
 *                                                 (первый вариант всегда add: 0)
 *   specs    = 'Ключ: значение' по одной в строке — из ключа автоматически подбирается иконка
 */

const DAY = 86400000;
const now = Date.now();

/* ------------------------------- палитры ------------------------------- */
const C = {
  silver: { name: 'Серебристый', hex: '#e3e4e6' },
  spaceBlack: { name: 'Космический чёрный', hex: '#35353a' },
  spaceGray: { name: 'Серый космос', hex: '#7d7e80' },
  starlight: { name: 'Сияющая звезда', hex: '#e8e0d0' },
  midnight: { name: 'Полуночный', hex: '#2e3641' },
  black: { name: 'Чёрный', hex: '#1f2020' },
  white: { name: 'Белый', hex: '#f5f5f0' },
  blue: { name: 'Синий', hex: '#7f95b8' },
  purple: { name: 'Фиолетовый', hex: '#b7add0' },
  pink: { name: 'Розовый', hex: '#f2d4d8' },
  yellow: { name: 'Жёлтый', hex: '#efe6c4' }
};

// Цвета новинок сняты с ОФИЦИАЛЬНЫХ ОБРАЗЦОВ Apple (`<имя>_SW_COLOR` у Scene7)
// тем же скриптом `scripts/apple-swatch-color.js`, что и чехлы с ремешками, —
// подобранный по названию оттенок всегда мимо: «Glacier» и «Night Sky» на глаз
// не угадать.
const IPHONE_DUO = [
  { name: 'Звёздно-белый', hex: '#eae9e9' },
  { name: 'Ночное небо', hex: '#394452' }
];
const IPHONE_18_PRO = [
  { name: 'Бордовый', hex: '#4d1821' },
  { name: 'Ледниковый', hex: '#e8f2ff' },
  C.silver,
  { name: 'Чёрный', hex: '#3c3c3c' }
];
const IPHONE_17_PRO = [
  { name: 'Космический оранжевый', hex: '#c2571f' },
  { name: 'Глубокий синий', hex: '#1f3a5f' },
  C.silver
];
const IPHONE_AIR = [
  { name: 'Небесно-голубой', hex: '#a9c4de' },
  { name: 'Светлое золото', hex: '#e6d3b3' },
  { name: 'Облачно-белый', hex: '#f2f1ee' },
  { name: 'Космический чёрный', hex: '#2b2b2e' }
];
const IPHONE_17 = [
  { name: 'Лавандовый', hex: '#cfc4e3' },
  { name: 'Шалфейный', hex: '#cfd8c4' },
  { name: 'Туманно-синий', hex: '#c2d4e0' },
  C.white, C.black
];
const IPHONE_17E = [{ name: 'Нежно-розовый', hex: '#f0d3d6' }, C.white, C.black];
// iPhone 16 и 16 Plus — одна палитра, как у Apple.
const IPHONE_16 = [
  { name: 'Ультрамарин', hex: '#4b5ac4' },
  { name: 'Бирюзовый', hex: '#a7c8c4' },
  C.pink, C.white, C.black
];
const IPHONE_16_PRO = [
  { name: 'Песочный титан', hex: '#b8a189' },
  { name: 'Натуральный титан', hex: '#c0b9ae' },
  { name: 'Белый титан', hex: '#f2f1ec' },
  { name: 'Чёрный титан', hex: '#3b3b3d' }
];
const IPHONE_16E = [C.white, C.black];
// У iPhone 15 и 15 Plus цвет запечён в стекло — оттенки бледнее, чем у 16-го.
const IPHONE_15 = [
  { name: 'Чёрный', hex: '#3c3c3b' },
  { name: 'Синий', hex: '#d5dfe0' },
  { name: 'Зелёный', hex: '#d0dbd0' },
  { name: 'Жёлтый', hex: '#ece7cd' },
  { name: 'Розовый', hex: '#ecd9d8' }
];
const IPHONE_15_PRO = [
  { name: 'Натуральный титан', hex: '#bfb8ad' },
  { name: 'Синий титан', hex: '#5b6b7d' },
  { name: 'Белый титан', hex: '#f2f1ee' },
  { name: 'Чёрный титан', hex: '#3d3c3a' }
];

const MB_NEO = [
  C.silver,
  { name: 'Румяный', hex: '#f0d8d4' },
  { name: 'Цитрусовый', hex: '#f2e2a8' },
  { name: 'Индиго', hex: '#3f4a7a' }
];
const MB_AIR = [{ name: 'Небесно-голубой', hex: '#b9cbd9' }, C.silver, C.starlight, C.midnight];
const MB_PRO = [C.spaceBlack, C.silver];
const IMAC = [
  C.blue, C.purple, C.pink,
  { name: 'Оранжевый', hex: '#e8a87c' },
  C.yellow,
  { name: 'Зелёный', hex: '#a8c4a0' },
  C.silver
];

const IPAD_PRO = [C.spaceBlack, C.silver];
const IPAD_AIR = [C.spaceGray, C.blue, C.purple, C.starlight];
const IPAD_11 = [C.blue, C.pink, C.yellow, C.silver];

// Series 12 у Apple продаётся в трёх материалах, и палитра у каждого своя:
// алюминий — четыре матовых цвета, титан и керамика — по два полированных.
// У полированных образец Apple рисует двухтонным (зеркало ловит и свет, и тень),
// поэтому медиана по всему кружку у «Night Blue» давала серый — там взята
// медиана тёмной половины, то есть самого цвета. Остальные замерены как есть.
const W12_ALU = [
  { name: 'Чёрный', hex: '#433f3e' },
  { name: 'Тёмная бронза', hex: '#58473c' },
  { name: 'Светлое золото', hex: '#a79482' },
  { name: 'Серый космос', hex: '#8b8887' }
];
const W12_TITAN = [
  { name: 'Натуральный титан', hex: '#cec8c1' },
  { name: 'Сияющее золото', hex: '#efe0bb' }
];
const W12_CERAMIC = [
  { name: 'Ночной синий', hex: '#2a3040' },
  { name: 'Жемчужно-белый', hex: '#e6dfda' }
];
const W_ULTRA4 = [
  { name: 'Натуральный титан', hex: '#e0d5ca' },
  { name: 'Чёрный титан', hex: '#363433' }
];

const W_ALU = [
  { name: 'Серый космос', hex: '#6f7073' },
  C.silver,
  { name: 'Розовое золото', hex: '#e5c0b4' },
  { name: 'Глянцевый чёрный', hex: '#1c1c1e' }
];
const W_TITAN = [
  { name: 'Натуральный титан', hex: '#cfc9c0' },
  { name: 'Золотой титан', hex: '#d4b483' },
  { name: 'Сланцевый титан', hex: '#4a4a4d' }
];
// У Series 10 палитра алюминия своя: вместо серого космоса — реактивный чёрный.
const W_S10 = [
  { name: 'Реактивный чёрный', hex: '#1c1c1e' },
  { name: 'Розовое золото', hex: '#e5c0b4' },
  C.silver
];

const HOMEPOD_MINI = [
  { name: 'Белый', hex: '#f2f1ee' },
  C.blue,
  { name: 'Оранжевый', hex: '#e8853c' },
  C.yellow,
  C.midnight
];

/* -------- ремешки часов --------
   Коллекции, цвета и размеры сверены с данными выбора на apple.com/shop/buy-watch
   (Ultra 3 и Series 11). add — доплата к цене часов, ₽ (ориентир рынка РФ). */
const SOLO_SIZES = [1, 2, 3, 4, 5, 6, 7, 8, 9].map(n => ({ label: String(n) }));
const SML = [{ label: 'S' }, { label: 'M' }, { label: 'L' }];
const SPORT_SIZES = [{ label: 'S/M' }, { label: 'M/L' }];
const ONE_SIZE = [{ label: 'Один размер' }];

const NIKE_COLORS = [
  { name: 'Midnight Black', hex: '#1c1c1e' },
  { name: 'Alpenglow Pink', hex: '#e88ba0' },
  { name: 'Blue Ribbon', hex: '#2b5fd0' },
  { name: 'Veiled Grey', hex: '#9a9a9e' },
  { name: 'Volt Splash', hex: '#d7f04a' }
];
const withAdd = (list, add) => list.map(o => Object.assign({ add }, o));

const BANDS = {
  ultra: [
    { name: 'Trail Loop', sizes: SPORT_SIZES, options: [
      { name: 'Black/Charcoal', hex: '#3a3a3c', add: 0 },
      { name: 'Blue/Bright Blue', hex: '#2f5fa8', add: 0 },
      { name: 'Green/Neon', hex: '#5b7a3a', add: 0 }
    ] },
    { name: 'Alpine Loop', sizes: SML, options: [
      { name: 'Black', hex: '#26262a', add: 0 },
      { name: 'Light Blue', hex: '#9dc0dc', add: 0 },
      { name: 'Terra Cotta', hex: '#b4552d', add: 0 }
    ] },
    { name: 'Ocean Band', sizes: ONE_SIZE, options: [
      { name: 'Black', hex: '#1c1c1e', add: 0 },
      { name: 'Anchor Blue', hex: '#2c4260', add: 0 },
      { name: 'Neon Green', hex: '#7ed321', add: 0 }
    ] },
    // у Apple титановый миланский подбирается в цвет корпуса
    { name: 'Titanium Milanese Loop', sizes: SML, options: [
      { name: 'Natural', hex: '#cfc9c0', add: 25000, forColor: 'Натуральный титан' },
      { name: 'Black', hex: '#2b2b2e', add: 25000, forColor: 'Чёрный титан' }
    ] }
  ],
  series: [
    { name: 'Sport Band', sizes: SPORT_SIZES, options: [
      { name: 'Black', hex: '#1c1c1e', add: 0 },
      { name: 'Starlight', hex: '#e8e0d0', add: 0 },
      { name: 'Stone Gray', hex: '#8b8a86', add: 0 },
      { name: 'Anchor Blue', hex: '#2c4260', add: 0 },
      { name: 'Light Blush', hex: '#f0d9d5', add: 0 },
      { name: 'Soft Pink', hex: '#eab7c0', add: 0 },
      { name: 'Clementine', hex: '#e8622a', add: 0 },
      { name: 'Bright Guava', hex: '#e8677d', add: 0 }
    ] },
    { name: 'Sport Loop', sizes: ONE_SIZE, options: [
      { name: 'Dark Gray', hex: '#4a4a4d', add: 0 },
      { name: 'Forest', hex: '#37503f', add: 0 },
      { name: 'Blue Mist', hex: '#a8c3d9', add: 0 },
      { name: 'Cantaloupe', hex: '#f0a05a', add: 0 },
      { name: 'Bright Guava', hex: '#e8677d', add: 0 },
      { name: 'Anchor Blue', hex: '#2c4260', add: 0 }
    ] },
    { name: 'Solo Loop', sizes: SOLO_SIZES, options: [
      { name: 'Black', hex: '#232326', add: 0 },
      { name: 'Anchor Blue', hex: '#2c4260', add: 0 },
      { name: 'Green Gray', hex: '#7d8b78', add: 0 },
      { name: 'Light Blush', hex: '#f0d9d5', add: 0 },
      { name: 'Neon Yellow', hex: '#e4f04a', add: 0 }
    ] },
    { name: 'Braided Solo Loop', sizes: SOLO_SIZES, options: [
      { name: 'Midnight', hex: '#2e3641', add: 4000 },
      { name: 'Anchor Blue', hex: '#2c4260', add: 4000 },
      { name: 'Green Gray', hex: '#7d8b78', add: 4000 },
      { name: 'Neon Yellow', hex: '#e4f04a', add: 4000 },
      { name: 'Turmeric', hex: '#d99a2b', add: 4000 }
    ] },
    { name: 'Nike Sport Band', sizes: SPORT_SIZES, options: withAdd(NIKE_COLORS, 0) },
    { name: 'Nike Sport Loop', sizes: ONE_SIZE, options: withAdd(NIKE_COLORS, 0) },
    { name: 'Milanese Loop', sizes: SML, options: [
      // Стальной миланский ремешок Apple разрешает сочетать и с алюминиевым
      // корпусом. Привязка к названиям титана прятала весь ряд у Series 10/11.
      { name: 'Natural', hex: '#d6d6d8', add: 7000 },
      { name: 'Gold', hex: '#d4b483', add: 7000 },
      { name: 'Slate', hex: '#5a5a5f', add: 7000 }
    ] }
  ],
  // у титановых Series 11 к тем же ремешкам добавляются браслеты и кожаные
  seriesTitan: [
    { name: 'Link Bracelet', sizes: ONE_SIZE, options: [
      { name: 'Natural', hex: '#d6d6d8', add: 30000, forColor: 'Натуральный титан' },
      { name: 'Gold', hex: '#d4b483', add: 30000, forColor: 'Золотой титан' },
      { name: 'Slate', hex: '#5a5a5f', add: 30000, forColor: 'Сланцевый титан' }
    ] },
    { name: 'Magnetic Link', sizes: SPORT_SIZES, options: [
      { name: 'Caramel', hex: '#a9764a', add: 9000 },
      { name: 'Sage Gray', hex: '#8e9384', add: 9000 },
      { name: 'Navy', hex: '#2b3550', add: 9000 }
    ] },
    { name: 'Modern Buckle', sizes: SML, options: [
      { name: 'Caramel', hex: '#a9764a', add: 12000 },
      { name: 'Sage Gray', hex: '#8e9384', add: 12000 },
      { name: 'Midnight Purple', hex: '#4a3a54', add: 12000 }
    ] }
  ],
  /* Набор Series 12 снят с buy-watch/apple-watch (сентябрь 2026): 10 коллекций,
     53 вариации. Цвета замерены по официальным образцам `_SW_COLOR`, но КОЛЬЦОМ,
     а не по всему кружку: у Nike Sport Band в центре образца лежит контрастная
     плашка, и медиана по всей плашке давала цвет дырки, а не ремешка. Берётся
     освещённая часть материала (верхние квартили яркости) — у стального
     миланского иначе выходит тень между звеньями, то есть «серебро» цвета кофе.

     Доплаты разнесены ПО АНАЛОГИИ с Series 11 (плетёный 4000, миланский 7000,
     магнитный 9000, Modern Buckle 12000, браслет 30000): цен на ремешки Apple
     на странице не отдаёт, и их нужно сверить с прайсом поставщика.

     Из 53 вариаций в набор не взята одна — Pride Edition: витрина российская, и
     радужный ремешок на ней создаёт магазину правовой риск, а не выбор. Решение
     владельца, а не техническое: вернуть его — это две строки. */
  series12: [
    { name: 'Sport Band', sizes: SPORT_SIZES, options: [
      { name: 'Black', hex: '#404040', add: 0 },
      { name: 'Burgundy', hex: '#52343c', add: 0 },
      { name: 'Olive', hex: '#8c8064', add: 0 },
      { name: 'Navy Blue', hex: '#4a4f56', add: 0 },
      { name: 'Wildflower Blue', hex: '#7895be', add: 0 },
      { name: 'Magenta', hex: '#a24389', add: 0 },
      { name: 'Sand', hex: '#d5cebe', add: 0 },
      { name: 'Pale Succulent', hex: '#d7d7bd', add: 0 }
    ] },
    { name: 'Sport Loop', sizes: ONE_SIZE, options: [
      { name: 'Burgundy', hex: '#5c4150', add: 0 },
      { name: 'Burgundy Plaid', hex: '#6e4f58', add: 0 },
      { name: 'Olive', hex: '#8f7d61', add: 0 },
      { name: 'Magenta', hex: '#9f746d', add: 0 },
      { name: 'Light Umber Plaid', hex: '#a0815d', add: 0 },
      { name: 'Chambray Blue', hex: '#aea099', add: 0 },
      { name: 'Limestone', hex: '#d2c7b9', add: 0 },
      { name: 'Black Unity', hex: '#514e46', add: 0 }
    ] },
    { name: 'Solo Loop', sizes: SOLO_SIZES, options: [
      { name: 'Black', hex: '#4f5151', add: 0 },
      { name: 'Burgundy', hex: '#62474e', add: 0 },
      { name: 'Olive', hex: '#908467', add: 0 },
      { name: 'Navy Blue', hex: '#4d5159', add: 0 },
      { name: 'Wildflower Blue', hex: '#7895be', add: 0 }
    ] },
    { name: 'Braided Solo Loop', sizes: SOLO_SIZES, options: [
      { name: 'Black', hex: '#353033', add: 4000 },
      { name: 'Burgundy', hex: '#613140', add: 4000 },
      { name: 'Olive', hex: '#958668', add: 4000 },
      { name: 'Navy Blue', hex: '#3f4250', add: 4000 },
      { name: 'Wildflower Blue', hex: '#8ea7d5', add: 4000 },
      { name: 'Magenta', hex: '#942694', add: 4000 },
      { name: 'Black Unity', hex: '#5d4238', add: 4000 }
    ] },
    { name: 'Nike Sport Band', sizes: SPORT_SIZES, options: [
      { name: 'After Dark Black', hex: '#464544', add: 0 },
      { name: 'Pavement Grey', hex: '#938b87', add: 0 },
      { name: 'Chalk Calm', hex: '#cecfcd', add: 0 },
      { name: 'Essential White', hex: '#d1d9bb', add: 0 },
      { name: 'Green Spark', hex: '#afd0a4', add: 0 }
    ] },
    { name: 'Nike Sport Loop', sizes: ONE_SIZE, options: [
      { name: 'After Dark Black', hex: '#5c5854', add: 0 },
      { name: 'Pavement Grey', hex: '#cfc9c6', add: 0 },
      { name: 'Chalk Calm', hex: '#ece7d5', add: 0 },
      { name: 'Essential White', hex: '#e4e5df', add: 0 },
      { name: 'Green Spark', hex: '#c1f2bd', add: 0 }
    ] },
    { name: 'Milanese Loop', sizes: SML, options: [
      { name: 'Natural', hex: '#bcb2a7', add: 7000 },
      { name: 'Radiant Gold', hex: '#ba9f79', add: 7000 },
      { name: 'Dark Bronze', hex: '#706053', add: 7000 }
    ] }
  ],
  // Титану и керамике добавляются кожаные и магнитные — как у Series 11, где
  // магнитная застёжка и Modern Buckle идут сверх общего набора. Сама
  // buy-страница про такое ограничение молчит: галерея Apple рисует ЛЮБУЮ пару
  // «корпус + ремешок» (проверено на выгрузке — у Series 11 тоже 52 из 52),
  // поэтому по картинкам совместимость не определить, и разделение взято
  // прежнее, каталожное.
  series12Steel: [
    { name: 'Magnetic Link', sizes: SPORT_SIZES, options: [
      { name: 'Midnight', hex: '#5f5c61', add: 9000 },
      { name: 'Burgundy', hex: '#60444c', add: 9000 },
      { name: 'Wildflower Blue', hex: '#7a8db5', add: 9000 },
      { name: 'Camel', hex: '#a4896b', add: 9000 }
    ] },
    { name: 'Modern Buckle', sizes: SML, options: [
      { name: 'Navy Blue', hex: '#5b585a', add: 12000 },
      { name: 'Mulberry', hex: '#865f76', add: 12000 },
      { name: 'Sage', hex: '#aba189', add: 12000 },
      { name: 'Camel', hex: '#bea381', add: 12000 }
    ] }
  ],
  // Браслет Apple подбирает в цвет титанового корпуса — отсюда forColor, как у
  // титанового миланского у Ultra.
  series12Link: [
    { name: 'Link Bracelet', sizes: ONE_SIZE, options: [
      { name: 'Natural', hex: '#aaa199', add: 30000, forColor: 'Натуральный титан' },
      { name: 'Radiant Gold', hex: '#b9a183', add: 30000, forColor: 'Сияющее золото' }
    ] }
  ],
  ultra4: [
    { name: 'Trail Loop', sizes: SPORT_SIZES, options: [
      { name: 'Dark Umber', hex: '#68544e', add: 0 },
      { name: 'Burgundy', hex: '#674344', add: 0 },
      { name: 'Sand', hex: '#c0a78e', add: 0 }
    ] },
    { name: 'Alpine Loop', sizes: SML, options: [
      { name: 'Dark Olive', hex: '#6a614f', add: 0 },
      { name: 'Burgundy', hex: '#694740', add: 0 },
      { name: 'Desert', hex: '#92795d', add: 0 }
    ] },
    { name: 'Ocean Band', sizes: ONE_SIZE, options: [
      { name: 'Translucent Black', hex: '#61615e', add: 0 },
      { name: 'Translucent Kelp', hex: '#908665', add: 0 },
      { name: 'Translucent Gray', hex: '#acaaa1', add: 0 }
    ] },
    { name: 'Titanium Milanese Loop', sizes: SML, options: [
      { name: 'Natural', hex: '#a79c90', add: 25000, forColor: 'Натуральный титан' },
      { name: 'Black', hex: '#5b5656', add: 25000, forColor: 'Чёрный титан' }
    ] }
  ],
  se: [
    { name: 'Sport Band', sizes: SPORT_SIZES, options: [
      { name: 'Black', hex: '#1c1c1e', add: 0 },
      { name: 'Starlight', hex: '#e8e0d0', add: 0 },
      { name: 'Anchor Blue', hex: '#2c4260', add: 0 },
      { name: 'Light Blush', hex: '#f0d9d5', add: 0 },
      { name: 'Bright Guava', hex: '#e8677d', add: 0 }
    ] },
    { name: 'Sport Loop', sizes: ONE_SIZE, options: [
      { name: 'Dark Gray', hex: '#4a4a4d', add: 0 },
      { name: 'Blue Mist', hex: '#a8c3d9', add: 0 },
      { name: 'Cantaloupe', hex: '#f0a05a', add: 0 },
      { name: 'Bright Guava', hex: '#e8677d', add: 0 }
    ] },
    { name: 'Solo Loop', sizes: SOLO_SIZES, options: [
      { name: 'Black', hex: '#232326', add: 0 },
      { name: 'Anchor Blue', hex: '#2c4260', add: 0 },
      { name: 'Neon Yellow', hex: '#e4f04a', add: 0 }
    ] },
    { name: 'Nike Sport Band', sizes: SPORT_SIZES, options: withAdd(NIKE_COLORS, 0) },
    { name: 'Nike Sport Loop', sizes: ONE_SIZE, options: withAdd(NIKE_COLORS, 0) }
  ],
  // Набор снят с buy-watch/apple-watch-hermes (август 2026) и идёт в порядке Apple.
  // Прежний список (Torsade, Kilim «Bleu Saphir», Grand H в Noir и Gold) — прошлое
  // поколение: у Apple этих вариаций нет вовсе, совпадала ровно одна из шести.
  // Цвета кружков взяты из самих апловских образцов (центр плашки), а не подобраны
  // на глаз. Доплаты разнесены ПО АНАЛОГИИ с прежними: металл 26 000, резина 18 000,
  // ткань 0 — их нужно сверить с прайсом поставщика.
  hermes: [
    { name: 'Grand H Fin', sizes: SML, options: [
      { name: 'Satiné', hex: '#9d9c9a', add: 26000 }
    ] },
    { name: 'Grand H', sizes: SML, options: [
      { name: 'Satiné', hex: '#7f7c7b', add: 26000 }
    ] },
    { name: 'Faubourg Party', sizes: SML, options: [
      { name: 'Bleu Nuit', hex: '#3d3d4d', add: 0 }
    ] },
    { name: 'Toile H Single Tour', sizes: SML, options: [
      { name: 'Gold/Écru', hex: '#c29f89', add: 0 }
    ] },
    { name: 'Toile H Double Jeu', sizes: SML, options: [
      { name: 'Noir/Écru', hex: '#5f5f60', add: 0 },
      { name: 'Écru/Écru', hex: '#d2bdb2', add: 0 }
    ] },
    { name: 'Néo Tricot', sizes: SML, options: [
      { name: 'Bleu Gris', hex: '#58626a', add: 0 },
      { name: 'Argile', hex: '#c0aa95', add: 0 },
      { name: 'Bleu Nuit', hex: '#35323f', add: 0 },
      { name: 'Capucine', hex: '#bc2e26', add: 0 }
    ] },
    { name: 'Kilim Single Tour', sizes: SML, options: [
      { name: 'Grège', hex: '#ebdcad', add: 18000 },
      { name: 'Jaune', hex: '#ffd050', add: 18000 },
      { name: 'Blanc', hex: '#f1f0ee', add: 18000 },
      { name: 'Noir', hex: '#424242', add: 18000 },
      { name: 'Orange', hex: '#ec7836', add: 18000 }
    ] }
  ]
};

/* -------- типовые наборы памяти (add — доплата к базовой цене, ₽) -------- */
const ST = {
  ph256: [{ label: '256 ГБ', add: 0 }, { label: '512 ГБ', add: 12000 }, { label: '1 ТБ', add: 30000 }],
  ph256s: [{ label: '256 ГБ', add: 0 }, { label: '512 ГБ', add: 12000 }],
  // Пять iPhone переведены на прайс поставщика (см. «Прайс поставщика» ниже):
  // доплата за память посчитана по его же ценам, и общая сетка ST.ph* им больше
  // не подходит — у поставщика шаг за память заметно меньше типового.
  // Новинки сентября 2026 прайсом поставщика ещё не приходили, поэтому и цена,
  // и шаги за память посчитаны от долларовых Apple по курсу 90 ₽/$ минус 25 % —
  // той самой скидке, по которой в прайсах идут телефоны и часы (см. «Цены»).
  // Шаг у 18 Pro, Pro Max и Duo один и тот же: $200 / $600 / $1200 к базовой.
  ph18: [{ label: '256 ГБ', add: 0 }, { label: '512 ГБ', add: 11500 }, { label: '1 ТБ', add: 34400 }, { label: '2 ТБ', add: 68900 }],
  ph17pm: [{ label: '256 ГБ', add: 0 }, { label: '512 ГБ', add: 11500 }, { label: '1 ТБ', add: 22500 }, { label: '2 ТБ', add: 32000 }],
  ph17p: [{ label: '256 ГБ', add: 0 }, { label: '512 ГБ', add: 12000 }, { label: '1 ТБ', add: 20500 }],
  ph17air: [{ label: '256 ГБ', add: 0 }, { label: '512 ГБ', add: 5000 }, { label: '1 ТБ', add: 9500 }],
  ph17: [{ label: '256 ГБ', add: 0 }, { label: '512 ГБ', add: 9500 }],
  ph16: [{ label: '128 ГБ', add: 0 }, { label: '256 ГБ', add: 5500 }, { label: '512 ГБ', add: 14500 }],
  // Линейка 15 пришла прайсом по каждому объёму отдельно, и шаги там свои у
  // каждой модели: у 15 переход со 128 на 256 ГБ дороже, чем потом с 256 на 512,
  // а у 15 Plus 512 ГБ дешевле 256 ГБ. Это не опечатка, а живой остаток склада.
  ph15: [{ label: '128 ГБ', add: 0 }, { label: '256 ГБ', add: 15750 }, { label: '512 ГБ', add: 16500 }],
  ph15plus: [{ label: '128 ГБ', add: 0 }, { label: '256 ГБ', add: 3000 }, { label: '512 ГБ', add: 2250 }],
  ph15pro: [{ label: '128 ГБ', add: 0 }, { label: '256 ГБ', add: 750 }, { label: '512 ГБ', add: 8250 }, { label: '1 ТБ', add: 19500 }],
  ph15pm: [{ label: '256 ГБ', add: 0 }, { label: '512 ГБ', add: 7500 }, { label: '1 ТБ', add: 11250 }],
  ph128: [{ label: '128 ГБ', add: 0 }, { label: '256 ГБ', add: 7000 }, { label: '512 ГБ', add: 19000 }],
  ph128p: [{ label: '128 ГБ', add: 0 }, { label: '256 ГБ', add: 7000 }, { label: '512 ГБ', add: 19000 }, { label: '1 ТБ', add: 37000 }],
  pad128: [{ label: '128 ГБ', add: 0 }, { label: '256 ГБ', add: 8000 }, { label: '512 ГБ', add: 20000 }],
  padAir: [{ label: '128 ГБ', add: 0 }, { label: '256 ГБ', add: 9000 }, { label: '512 ГБ', add: 27000 }, { label: '1 ТБ', add: 54000 }],
  pad256: [{ label: '256 ГБ', add: 0 }, { label: '512 ГБ', add: 15000 }, { label: '1 ТБ', add: 40000 }, { label: '2 ТБ', add: 80000 }],
  neo: [{ label: '256 ГБ · Magic Keyboard', add: 0 }, { label: '512 ГБ · клавиатура с Touch ID', add: 9000 }],
  mac256: [{ label: '256 ГБ', add: 0 }, { label: '512 ГБ', add: 18000 }, { label: '1 ТБ', add: 40000 }, { label: '2 ТБ', add: 80000 }],
  mac512: [{ label: '512 ГБ', add: 0 }, { label: '1 ТБ', add: 22000 }, { label: '2 ТБ', add: 62000 }, { label: '4 ТБ', add: 130000 }],
  // Накопители Mac по apple.com (август 2026). Доплаты — долларовые Apple по
  // курсу 90 ₽/$. Часть объёмов идёт только со своим чипом, отсюда forChoice.
  air13: [{ label: '512 ГБ', add: 0 }, { label: '1 ТБ', add: 18000 }, { label: '2 ТБ', add: 54000 }, { label: '4 ТБ', add: 108000 }],
  air15: [{ label: '512 ГБ', add: 0 }, { label: '1 ТБ', add: 18000 }, { label: '2 ТБ', add: 54000 }, { label: '4 ТБ', add: 108000 }],
  pro14: [
    { label: '1 ТБ', add: 0, forChoice: { 'Чип': ['M5, 10 ядер CPU', 'M5 Pro, 15 ядер CPU', 'M5 Pro, 18 ядер CPU'] } },
    { label: '2 ТБ', add: 36000 },
    { label: '4 ТБ', add: 90000 },
    { label: '8 ТБ', add: 198000, forChoice: { 'Чип': ['M5 Max, 32 ядра GPU', 'M5 Max, 40 ядер GPU'] } }
  ],
  pro16: [
    { label: '1 ТБ', add: 0, forChoice: { 'Чип': ['M5 Pro, 18 ядер CPU'] } },
    { label: '2 ТБ', add: 36000 },
    { label: '4 ТБ', add: 90000 },
    { label: '8 ТБ', add: 198000, forChoice: { 'Чип': ['M5 Max, 32 ядра GPU', 'M5 Max, 40 ядер GPU'] } }
  ],
  imac: [
    { label: '256 ГБ', add: 0 }, { label: '512 ГБ', add: 18000 }, { label: '1 ТБ', add: 45000 },
    { label: '2 ТБ', add: 90000, forChoice: { 'Порты и сеть': ['4 порта Thunderbolt и Gigabit Ethernet'] } }
  ],
  mini: [
    { label: '256 ГБ', add: 0, forChoice: { 'Чип': ['M4, 10 ядер CPU'] } },
    { label: '512 ГБ', add: 18000 },
    { label: '1 ТБ', add: 36000 },
    { label: '2 ТБ', add: 72000 },
    { label: '4 ТБ', add: 126000, forChoice: { 'Чип': ['M4 Pro, 12 ядер CPU', 'M4 Pro, 14 ядер CPU'] } },
    { label: '8 ТБ', add: 234000, forChoice: { 'Чип': ['M4 Pro, 12 ядер CPU', 'M4 Pro, 14 ядер CPU'] } }
  ],
  studio: [
    { label: '512 ГБ', add: 0, forChoice: { 'Чип': ['M4 Max, 14 ядер CPU', 'M4 Max, 16 ядер CPU'] } },
    { label: '1 ТБ', add: 18000 }, { label: '2 ТБ', add: 54000 },
    { label: '4 ТБ', add: 108000 }, { label: '8 ТБ', add: 216000 },
    { label: '16 ТБ', add: 432000, forChoice: { 'Чип': ['M3 Ultra, 28 ядер CPU', 'M3 Ultra, 32 ядра CPU'] } }
  ],
  watch42: [{ label: '42 мм', add: 0 }, { label: '46 мм', add: 4000 }],
  watch40: [{ label: '40 мм', add: 0 }, { label: '44 мм', add: 3000 }],
  // У Series 10 и 11 обе диагонали пришли прайсом по отдельности, и разница
  // между ними там куда меньше типовых 4000 ₽.
  watch42s10: [{ label: '42 мм', add: 0 }, { label: '46 мм', add: 750 }],
  watch42s11: [{ label: '42 мм', add: 0 }, { label: '46 мм', add: 1500 }],
  // У Series 12 разница между диагоналями та же во всех трёх материалах — $50.
  watch42s12: [{ label: '42 мм', add: 0 }, { label: '46 мм', add: 2900 }],
  vision: [{ label: '256 ГБ', add: 0 }, { label: '512 ГБ', add: 25000 }, { label: '1 ТБ', add: 50000 }],
  tv: [{ label: '64 ГБ', add: 0 }, { label: '128 ГБ', add: 3000 }]
};

/* -------- дополнительные характеристики --------
   Группы выбора с buy-страниц apple.com: покрытие дисплея, связь, подставка,
   блок питания. У каждой группы свой обязательный выбор со своей доплатой (₽),
   а forStorage ограничивает значение частью конфигураций — как у Apple, где
   нанотекстурное стекло iPad Pro бывает только на 1 ТБ и 2 ТБ. */
const OPT = {
  // «Connectivity. Choose how you'll stay connected.»
  cellular: (add) => ({
    name: 'Связь', hint: 'Выберите, как оставаться на связи',
    values: [{ label: 'Wi-Fi', add: 0 }, { label: 'Wi-Fi + Cellular', add }]
  }),
  // «Display glass. Choose which glass is best for you.»
  glass: (add, forStorage) => ({
    name: 'Покрытие дисплея', hint: 'Выберите, какое стекло вам подходит',
    values: [
      { label: 'Стандартное стекло', add: 0 },
      { label: 'Нанотекстурное стекло', add, forStorage: forStorage || [] }
    ]
  }),
  // Подставка монитора: у Apple это третий обязательный выбор наравне со стеклом
  stand: (height) => ({
    name: 'Подставка', hint: 'Выберите, как монитор будет стоять или крепиться',
    values: [
      { label: 'Наклон', add: 0 },
      { label: 'Наклон и регулировка высоты', add: height },
      { label: 'Крепление VESA', add: 0 }
    ]
  }),
  watchCellular: (add) => ({
    name: 'Связь', hint: 'Звонки и данные без телефона рядом — по желанию',
    values: [{ label: 'GPS', add: 0 }, { label: 'GPS + Cellular', add }]
  }),
  // Единственная группа не с buy-страницы Apple: у Apple версия зависит от
  // страны продажи, а у нас в одной витрине лежат обе. В моделях для США лотка
  // для SIM нет вообще, они на сером рынке дешевле — поэтому база тут «Только
  // eSIM», а доплата выводит на версию с лотком. Physical SIM есть у всех
  // iPhone, кроме Air: он eSIM-only во всех странах, и выбора там нет.
  sim: (add) => ({
    name: 'SIM-карта', hint: 'В версии для США лотка для SIM-карты нет',
    values: [{ label: 'Только eSIM', add: 0 }, { label: 'eSIM + физическая SIM', add }]
  }),
  // «Chip. Choose your chip.» — у Mac это первый выбор на buy-странице.
  chip: (pairs) => ({
    name: 'Чип', hint: 'Больше ядер — быстрее рендер, сборка и обработка видео',
    values: pairs.map(([label, add]) => ({ label, add }))
  }),
  // «Memory. Choose your unified memory.» Метка несёт слово «ОЗУ», потому что в
  // названии заявки значения идут через запятую и без имён групп: рядом с «512 ГБ»
  // накопителя голое «32 ГБ» не отличить от него же.
  ram: (pairs) => ({
    name: 'Оперативная память', hint: 'Объединённая память Apple silicon: чем больше, тем больше задач разом',
    values: pairs.map(([label, add, forChoice]) => forChoice
      ? { label: label + ' ОЗУ', add, forChoice }
      : { label: label + ' ОЗУ', add })
  })
};

/* -------- конфигурации Mac --------
   Сверено с apple.com/shop/buy-mac (август 2026). Состав снят с конфигуратора,
   доплаты — долларовые Apple по курсу 90 ₽/$ ($200 → 18 000 ₽); базовые цены
   товаров свои, серого рынка.

   Главное: **у Apple объём памяти и потолок накопителя зависят от чипа.**
   M5 Pro — это 24/48/64 ГБ и 1–4 ТБ; M5 Max с 32-ядерным GPU — ровно 36 ГБ;
   M5 Max с 40-ядерным — 48/64/128 ГБ, и только с ним бывает 8 ТБ. Поэтому у
   значений стоит `forChoice` — «доступно при таком выборе в группе «Чип»».
   Без него витрина собирала бы то, чего Apple не продаёт. */
const forChip = (...names) => ({ 'Чип': names });

// В 13" Air 10-ядерный GPU стоит $100 только с базовыми 16 ГБ / 512 ГБ, но
// включается без отдельной доплаты при 24+ ГБ или 1+ ТБ. Объединяем чип и ОЗУ
// в один выбор: иначе две независимые доплаты складывались и завышали цену.
const PERF_AIR13 = {
  name: 'Чип и оперативная память', hint: '10-ядерный GPU включён с 24 ГБ памяти или накопителем от 1 ТБ',
  values: [
    { label: 'M5, 8 ядер GPU, 16 ГБ ОЗУ', add: 0, forStorage: ['512 ГБ'] },
    { label: 'M5, 10 ядер GPU, 16 ГБ ОЗУ', add: 9000, forStorage: ['512 ГБ'] },
    { label: 'M5, 10 ядер GPU, 16 ГБ ОЗУ · включено с 1 ТБ+', add: 0, forStorage: ['1 ТБ', '2 ТБ', '4 ТБ'] },
    { label: 'M5, 10 ядер GPU, 24 ГБ ОЗУ', add: 18000 },
    { label: 'M5, 10 ядер GPU, 32 ГБ ОЗУ', add: 36000 }
  ]
};
const RAM_AIR15 = OPT.ram([['16 ГБ', 0], ['24 ГБ', 18000], ['32 ГБ', 36000]]);

// MacBook Pro 14": M5 → M5 Pro (15 и 18 ядер CPU) → M5 Max. 16": M5 Pro → M5 Max
// (32 и 40 ядер GPU). Доплаты за чип — разница базовых цен Apple по тому же курсу.
const CHIP_PRO14 = OPT.chip([
  ['M5, 10 ядер CPU', 0],
  // В доплате за чип не повторяем обязательные ОЗУ/SSD: они считаются своими
  // рядами ниже. Сумма минимальной сборки каждого чипа совпадает с Apple.
  ['M5 Pro, 15 ядер CPU', 27000],
  ['M5 Pro, 18 ядер CPU', 45000],
  ['M5 Max, 32 ядра GPU', 90000],
  ['M5 Max, 40 ядер GPU', 126000]
]);
const RAM_PRO14 = OPT.ram([
  ['16 ГБ', 0, forChip('M5, 10 ядер CPU')],
  ['24 ГБ', 18000, forChip('M5, 10 ядер CPU', 'M5 Pro, 15 ядер CPU', 'M5 Pro, 18 ядер CPU')],
  ['32 ГБ', 36000, forChip('M5, 10 ядер CPU')],
  ['36 ГБ', 45000, forChip('M5 Max, 32 ядра GPU')],
  ['48 ГБ', 54000, forChip('M5 Pro, 15 ядер CPU', 'M5 Pro, 18 ядер CPU', 'M5 Max, 40 ядер GPU')],
  ['64 ГБ', 72000, forChip('M5 Pro, 18 ядер CPU', 'M5 Max, 40 ядер GPU')],
  ['128 ГБ', 144000, forChip('M5 Max, 40 ядер GPU')]
]);
const CHIP_PRO16 = OPT.chip([
  ['M5 Pro, 18 ядер CPU', 0],
  ['M5 Max, 32 ядра GPU', 27000],
  ['M5 Max, 40 ядер GPU', 90000]
]);
const RAM_PRO16 = OPT.ram([
  ['24 ГБ', 0, forChip('M5 Pro, 18 ядер CPU')],
  ['36 ГБ', 45000, forChip('M5 Max, 32 ядра GPU')],
  ['48 ГБ', 36000, forChip('M5 Pro, 18 ядер CPU', 'M5 Max, 40 ядер GPU')],
  ['64 ГБ', 54000, forChip('M5 Pro, 18 ядер CPU', 'M5 Max, 40 ядер GPU')],
  ['128 ГБ', 126000, forChip('M5 Max, 40 ядер GPU')]
]);

// Десктопы. iMac и Mac mini — всё ещё M4, Mac Studio — M4 Max и M3 Ultra.
const forPorts = (...names) => ({ 'Порты и сеть': names });
const RAM_IMAC = OPT.ram([
  ['16 ГБ', 0], ['24 ГБ', 18000],
  ['32 ГБ', 36000, forPorts('4 порта Thunderbolt и Gigabit Ethernet')]
]);
const CHIP_MINI = OPT.chip([
  ['M4, 10 ядер CPU', 0],
  ['M4 Pro, 12 ядер CPU', 36000],
  ['M4 Pro, 14 ядер CPU', 54000]
]);
const RAM_MINI = OPT.ram([
  ['16 ГБ', 0, forChip('M4, 10 ядер CPU')],
  ['24 ГБ', 18000, forChip('M4, 10 ядер CPU', 'M4 Pro, 12 ядер CPU', 'M4 Pro, 14 ядер CPU')],
  ['32 ГБ', 36000, forChip('M4, 10 ядер CPU')],
  ['48 ГБ', 54000, forChip('M4 Pro, 12 ядер CPU', 'M4 Pro, 14 ядер CPU')],
  ['64 ГБ', 72000, forChip('M4 Pro, 12 ядер CPU', 'M4 Pro, 14 ядер CPU')]
]);
const CHIP_STUDIO = OPT.chip([
  ['M4 Max, 14 ядер CPU', 0],
  ['M4 Max, 16 ядер CPU', 27000],
  ['M3 Ultra, 28 ядер CPU', 72000],
  ['M3 Ultra, 32 ядра CPU', 207000]
]);
const RAM_STUDIO = OPT.ram([
  ['36 ГБ', 0, forChip('M4 Max, 14 ядер CPU')],
  ['48 ГБ', 18000, forChip('M4 Max, 16 ядер CPU')],
  ['64 ГБ', 54000, forChip('M4 Max, 16 ядер CPU')],
  ['128 ГБ', 126000, forChip('M4 Max, 16 ядер CPU')],
  ['96 ГБ', 90000, forChip('M3 Ultra, 28 ядер CPU', 'M3 Ultra, 32 ядра CPU')],
  ['256 ГБ', 306000, forChip('M3 Ultra, 32 ядра CPU')],
  ['512 ГБ', 720000, forChip('M3 Ultra, 32 ядра CPU')]
]);

// Группы, которые встречаются у одного-двух товаров, — отдельными константами
const POWER_AIR = {
  name: 'Блок питания', hint: 'Выберите зарядное устройство в комплекте',
  values: [
    { label: '40 Вт Dynamic Power (до 60 Вт)', add: 0 },
    { label: '35 Вт с двумя портами', add: 1800 },
    { label: '70 Вт быстрая зарядка', add: 1800 }
  ]
};
const POWER_PRO14 = {
  name: 'Блок питания', hint: 'Выберите зарядное устройство в комплекте',
  values: [
    { label: '70 Вт USB-C', add: 0, forChoice: forChip('M5, 10 ядер CPU', 'M5 Pro, 15 ядер CPU') },
    { label: '96 Вт быстрая зарядка', add: 1800, forChoice: forChip('M5, 10 ядер CPU', 'M5 Pro, 15 ядер CPU') },
    { label: '96 Вт · в комплекте', add: 0, forChoice: forChip('M5 Pro, 18 ядер CPU', 'M5 Max, 32 ядра GPU', 'M5 Max, 40 ядер GPU') }
  ]
};
const IMAC_GLASS = {
  name: 'Покрытие дисплея', hint: 'Выберите, какое стекло вам подходит',
  values: [
    { label: 'Стандартное стекло', add: 0 },
    { label: 'Нанотекстурное стекло', add: 18000, forChoice: forPorts('4 порта Thunderbolt и Gigabit Ethernet') }
  ]
};
const IMAC_PORTS = {
  name: 'Порты и сеть', hint: 'Выберите набор портов на задней панели',
  values: [
    { label: '2 порта Thunderbolt', add: 0 },
    { label: '4 порта Thunderbolt и Gigabit Ethernet', add: 18000 }
  ]
};
const IMAC_KEYBOARD = {
  name: 'Клавиатура', hint: 'Выберите Magic Keyboard в комплекте',
  values: [
    { label: 'Magic Keyboard с Touch ID', add: 0 },
    { label: 'Magic Keyboard с Touch ID и цифровым блоком', add: 7990 }
  ]
};
const MINI_ETHERNET = {
  name: 'Сеть', hint: 'Выберите скорость проводного подключения',
  values: [{ label: 'Gigabit Ethernet', add: 0 }, { label: '10 Гбит Ethernet', add: 9000 }]
};
// Две версии AirPods 4 и два комплекта AirTag живут одной карточкой: у Apple
// это тоже один товар с выбором, а не соседние позиции в каталоге. Доплата
// выводит на цену второй версии: у AirPods 4 это цена версии с шумоподавлением
// из прайса поставщика, у AirTag — прежние 11 990 ₽ за набор.
const AIRPODS_4_ANC = {
  name: 'Версия', hint: 'Выберите, нужно ли активное шумоподавление',
  values: [
    { label: 'Без шумоподавления', add: 0 },
    { label: 'С шумоподавлением', add: 2250 }
  ]
};
// У AirPods 5 шумоподавление есть в обеих версиях, а различает их ФУТЛЯР: во
// второй он с беспроводной зарядкой и динамиком для поиска, к нему добавлен
// сенсор нажатия с проведением по громкости, и наушники в нём живут дольше
// (5 ч против 4 ч на одном заряде). У Apple это один товар с выбором — значит и
// у нас одна карточка, как у AirPods 4.
const AIRPODS_5_CASE = {
  name: 'Футляр', hint: 'Беспроводная зарядка, динамик для поиска и час автономности сверху',
  values: [
    { label: 'Зарядный футляр USB-C', add: 0 },
    { label: 'Футляр с беспроводной зарядкой', add: 1150 }
  ]
};
const AIRTAG_PACK = {
  name: 'Комплект', hint: 'Одна метка или набор из четырёх — выгоднее, чем по одной',
  values: [
    { label: '1 шт.', add: 0 },
    { label: '4 шт.', add: 8500 }
  ]
};
const ZEISS_INSERTS = {
  name: 'Оптические вставки ZEISS', hint: 'Нужны, если вы носите очки',
  values: [
    { label: 'Не нужны', add: 0 },
    { label: 'Для чтения', add: 9990 },
    { label: 'По рецепту', add: 16990 }
  ]
};

/* ================= Чехлы и защита для iPhone: цвета ==================
 * ЦВЕТА СНЯТЫ С ОФИЦИАЛЬНЫХ ОБРАЗЦОВ APPLE (`<артикул>_SW_COLOR` у Scene7)
 * скриптом `scripts/apple-swatch-color.js`. Подобрать «Терракотовый», «Пурпурный
 * туман» или «Барвинок» на глаз нельзя, а кружок цвета — первое, по чему
 * покупатель выбирает чехол. Тот же приём, что у ремешков Hermès.
 * Правишь цвет — перемеряй, а не подкручивай число: у Apple это конкретный
 * оттенок конкретного изделия.
 */
const CC = {
  productred: { name: '(PRODUCT)RED', hex: '#d52e36' },
  anchorblue: { name: 'Якорный синий', hex: '#5f6b75' },
  aquamarine: { name: 'Аквамарин', hex: '#d2e5d7' },
  black: { name: 'Чёрный', hex: '#535353' },
  blue: { name: 'Синий', hex: '#444b55' },
  brightguava: { name: 'Яркая гуава', hex: '#fd747a' },
  chalkpink: { name: 'Меловой розовый', hex: '#f7d9d4' },
  clay: { name: 'Глиняный', hex: '#8d8478' },
  denim: { name: 'Джинсовый', hex: '#4d5b6d' },
  electriclavender: { name: 'Лавандовый', hex: '#e192c7' },
  frost: { name: 'Морозный', hex: '#f6f7f6' },
  fuchsia: { name: 'Фуксия', hex: '#b04778' },
  green: { name: 'Зелёный', hex: '#70735a' },
  lakegreen: { name: 'Зелёное озеро', hex: '#516463' },
  lightblue: { name: 'Голубой', hex: '#b6bfc7' },
  lightgray: { name: 'Светло-серый', hex: '#cbccca' },
  lightmoss: { name: 'Светлый мох', hex: '#8b9973' },
  lightpink: { name: 'Светло-розовый', hex: '#fbe6e2' },
  midnight: { name: 'Полуночный', hex: '#3c4654' },
  neonyellow: { name: 'Неоновый жёлтый', hex: '#eff69a' },
  orange: { name: 'Оранжевый', hex: '#ff7d4b' },
  peony: { name: 'Пион', hex: '#fc89c2' },
  periwinkle: { name: 'Барвинок', hex: '#7887c1' },
  plum: { name: 'Слива', hex: '#533e4e' },
  purple: { name: 'Фиолетовый', hex: '#5b5361' },
  purplefog: { name: 'Пурпурный туман', hex: '#665e77' },
  shadow: { name: 'Тёмно-серый', hex: '#6f7170' },
  sienna: { name: 'Сиена', hex: '#905a47' },
  softpink: { name: 'Нежно-розовый', hex: '#fde6e2' },
  starfruit: { name: 'Карамбола', hex: '#eedf50' },
  stonegray: { name: 'Серый камень', hex: '#6c6a66' },
  stormblue: { name: 'Штормовой синий', hex: '#4f5865' },
  tan: { name: 'Песочный', hex: '#c2b9ae' },
  tangerine: { name: 'Мандарин', hex: '#fd7968' },
  terracotta: { name: 'Терракотовый', hex: '#b7674a' },
  ultramarine: { name: 'Ультрамарин', hex: '#475195' },
  vanilla: { name: 'Ванильный', hex: '#fff1de' },
  white: { name: 'Белый', hex: '#f7f7f7' },
  winterblue: { name: 'Зимний синий', hex: '#7996b5' }
};
const cc = (...keys) => keys.map(k => CC[k]);

/* ============== Чехлы и защита для iPhone: сами карточки ==============
 * У Apple каждая расцветка — отдельный товар со своей страницей, а у нас это
 * ОДНА карточка с выбором цвета: снимки привязаны к цвету (`imageColors`), как
 * у часов с ремешками. Иначе каталог получил бы сто тридцать две почти
 * одинаковые карточки, между которыми покупателю нечего выбирать.
 *
 * Тексты у всех моделей одинаковы — меняется только имя модели, поэтому
 * карточки собираются фабриками. Сорок три копии одного описания разъехались бы
 * на первой же правке, а увидеть это можно только глазами.
 *
 * Категория своя, «Чехлы и защита»: в «Аксессуарах» лежат кабели и адаптеры, и
 * вперемешку с полусотней чехлов раздел перестал бы читаться.
 */
const CASE_CAT = 'Чехлы и защита';
const CASE = {
  // Силиконовый с MagSafe — основной чехол Apple.
  silicone: (id, model, colors, price, day) => ({
    id, name: `Силиконовый чехол для ${model} с MagSafe`, category: CASE_CAT,
    price, inStock: true,
    shortDesc: 'Мягкий силикон снаружи, микрофибра внутри, магниты MagSafe.',
    description: `Чехол Apple для ${model}: снаружи шелковистый силикон (45 % переработанного материала), внутри мягкая подкладка из микрофибры. Работает с Camera Control — в чехол вклеено сапфировое стекло с проводящим слоем, поэтому кнопка чувствует движения пальца как обычно. Встроенные магниты точно совпадают с магнитами ${model}: зарядка MagSafe и Qi2 на 25 Вт идёт прямо через чехол. Две точки крепления держат ремешок Crossbody Strap, если носить телефон через плечо.`,
    specs: `Материал: силикон, 45 % переработанного, внутри микрофибра\nКрепление: кольцо MagSafe по кругу\nЗарядка: MagSafe и Qi2 до 25 Вт, не снимая чехла\nУправление: работает с Camera Control\nРемешок: две точки крепления для Crossbody Strap\nПрочность: тысячи часов испытаний на царапины и удары`,
    colors, storages: [], images: [], createdAt: now - day * DAY
  }),
  // У iPhone 16e чехол без MagSafe и без Camera Control — у самой модели их нет.
  siliconePlain: (id, model, colors, price, day) => ({
    id, name: `Силиконовый чехол для ${model}`, category: CASE_CAT,
    price, inStock: true,
    shortDesc: 'Мягкий силикон снаружи и микрофибра внутри.',
    description: `Чехол Apple для ${model}: снаружи шелковистый силикон (55 % переработанного материала), внутри мягкая подкладка из микрофибры. Как и любой чехол Apple, проходит тысячи часов испытаний — на царапины, падения и износ.`,
    specs: `Материал: силикон, 55 % переработанного, внутри микрофибра\nПрочность: тысячи часов испытаний на царапины и удары\nПосадка: точно по корпусу, кнопки закрыты чехлом`,
    colors, storages: [], images: [], createdAt: now - day * DAY
  }),
  // TechWoven — тканый, дороже силиконового на десять долларов у Apple.
  techwoven: (id, model, colors, price, day) => ({
    id, name: `Тканый чехол TechWoven для ${model} с MagSafe`, category: CASE_CAT,
    price, inStock: true,
    shortDesc: 'Ткань с объёмным плетением, алюминиевые кнопки, MagSafe.',
    description: `Чехол Apple из фирменной технической ткани: разноцветные нити сотканы на жаккардовом станке, поэтому у поверхности есть объём и глубина цвета. Ткань — 100 % переработанный полиэстер, боковины покрыты слегка шероховатым TPU для хвата, кнопки сделаны из анодированного алюминия и нажимаются чётко. Магниты совпадают с магнитами ${model}, зарядка MagSafe и Qi2 работает через чехол, а две точки крепления держат ремешок Crossbody Strap.`,
    specs: `Материал: техническая ткань, 100 % переработанный полиэстер\nОтделка: боковины из TPU, кнопки из анодированного алюминия\nКрепление: кольцо MagSafe по кругу\nЗарядка: MagSafe и Qi2 до 25 Вт, не снимая чехла\nУправление: работает с Camera Control\nРемешок: две точки крепления для Crossbody Strap`,
    colors, storages: [], images: [], createdAt: now - day * DAY
  }),
  // Прозрачный — цвета у него нет вовсе, поэтому и списка цветов не принимает.
  clear: (id, model, price, day) => ({
    id, name: `Прозрачный чехол для ${model} с MagSafe`, category: CASE_CAT,
    price, inStock: true,
    shortDesc: 'Показывает цвет телефона и не желтеет со временем.',
    description: `Тонкий и лёгкий чехол Apple, который не прячет цвет ${model}: оптически прозрачный поликарбонат с гибкими вставками, покрытие снаружи и внутри защищает от царапин, а материалы подобраны так, чтобы чехол не желтел со временем. Работает с Camera Control через сапфировое стекло с проводящим слоем, а магниты MagSafe видны сквозь заднюю стенку и совпадают с магнитами телефона.`,
    specs: `Материал: прозрачный поликарбонат с гибкими вставками\nСтойкость: слой от царапин снаружи и внутри, не желтеет со временем\nКрепление: кольцо MagSafe по кругу\nЗарядка: MagSafe и Qi2 до 25 Вт, не снимая чехла\nУправление: работает с Camera Control`,
    colors: [], storages: [], images: [], createdAt: now - day * DAY
  }),
  // Чехол под iPhone Air: он тоньше остальных, поэтому и описание про толщину.
  airCase: (id, model, colors, price, day) => ({
    id, name: `Чехол для ${model} с MagSafe`, category: CASE_CAT,
    price, inStock: true,
    shortDesc: 'Ультратонкий полупрозрачный чехол под сам iPhone Air.',
    description: `Чехол сделан под тонкий корпус ${model}: задняя панель всего 0,9 мм, усилена поликарбонатной рамкой. Внутри лёгкая матовость, снаружи глянец; кнопки нажимаются коротко и чётко. Работает с Camera Control, держит зарядку MagSafe и Qi2 через чехол, а две точки крепления рассчитаны на ремешок Crossbody Strap.`,
    specs: `Толщина: задняя панель 0,9 мм\nМатериал: полупрозрачный пластик с поликарбонатной рамкой\nКрепление: кольцо MagSafe по кругу\nЗарядка: MagSafe и Qi2 до 25 Вт, не снимая чехла\nУправление: работает с Camera Control\nРемешок: две точки крепления для Crossbody Strap`,
    colors, storages: [], images: [], createdAt: now - day * DAY
  }),
  // Бампер: рамка по краям, спинка открыта — MagSafe у него своего нет.
  bumper: (id, model, colors, price, day) => ({
    id, name: `Бампер для ${model}`, category: CASE_CAT,
    price, inStock: true,
    shortDesc: 'Рамка по краям корпуса — спинка телефона остаётся открытой.',
    description: `Тонкая рамка из усиленного поликарбоната закрывает грани ${model} и оставляет заднюю панель на виду — видно, какой телефон тонкий. Кнопки нажимаются чётко, Camera Control работает через сапфировое стекло с проводящим слоем, а две точки крепления держат ремешок Crossbody Strap.`,
    specs: `Материал: усиленный поликарбонат\nРазмер: тонкая рамка по периметру, спинка открыта\nУправление: работает с Camera Control\nРемешок: две точки крепления для Crossbody Strap`,
    colors, storages: [], images: [], createdAt: now - day * DAY
  }),
  // Стекло Belkin. Это НЕ товар Apple: гарантию по нему даёт производитель,
  // и в названии карточки бренд стоит прямо — покупатель должен это видеть.
  glass: (id, model, price, day) => ({
    id, name: `Защитное стекло Belkin UltraGlass 2 для ${model}`, category: CASE_CAT,
    price, inStock: true,
    shortDesc: 'Литий-алюмосиликатное стекло 0,29 мм с рамкой для наклейки.',
    description: `Стекло для ${model} из литий-алюмосиликата, закалённое двойным ионным обменом: до 25 раз прочнее обычного защитного стекла и выдерживает падение с высоты до 2,2 м. Толщина 0,29 мм, поэтому экран отзывается на касания как без стекла. В коробке рамка Easy Align — с ней стекло клеится ровно с первого раза, — салфетка и стикер для пыли.`,
    specs: `Материал: литий-алюмосиликатное стекло\nТолщина: 0,29 мм\nПрочность: до 25× прочнее обычного стекла, испытание с высоты 2,2 м\nЭкран: полное покрытие, совместимо с Dynamic Island\nПокрытие: устойчиво к царапинам и отпечаткам`,
    colors: [], storages: [], images: [], createdAt: now - day * DAY
  }),
  glassPrivacy: (id, model, price, day) => ({
    id, name: `Защитное стекло Belkin UltraGlass 2 Privacy для ${model}`, category: CASE_CAT,
    price, inStock: true,
    shortDesc: 'То же стекло, но с фильтром: экран виден только владельцу.',
    description: `Стекло для ${model} с фильтром приватности: соседу сбоку экран кажется тёмным, а вам виден как обычно. Основа та же — литий-алюмосиликат двойной закалки, до 25 раз прочнее обычного защитного стекла, падение с высоты до 2,2 м, толщина 0,29 мм. В коробке рамка Easy Align, салфетка и стикер для пыли.`,
    specs: `Экран: фильтр приватности, содержимое видно только вам\nМатериал: литий-алюмосиликатное стекло\nТолщина: 0,29 мм\nПрочность: до 25× прочнее обычного стекла, испытание с высоты 2,2 м\nПокрытие: устойчиво к царапинам и отпечаткам`,
    colors: [], storages: [], images: [], createdAt: now - day * DAY
  })
};

/* --------------------------- Прайс поставщика ---------------------------
 * У iPhone 17 Pro Max, 17 Pro, Air, 17 и 16 цены пришли прайс-листом (eSIM и
 * SIM+eSIM, по цветам и объёмам) и поставлены со скидкой 30 % от него.
 * Цвет у нас цену не меняет, поэтому за базу взята самая дешёвая расцветка
 * объёма — витрина показывает цену «от». Доплата за память — разница между
 * объёмами в том же прайсе, доплата за физическую SIM — средняя по объёмам
 * (в прайсе она гуляет от 400 до 20 000 ₽ и одним числом не задаётся).
 * Старая цена и цена по акции сдвинуты пропорционально, чтобы процент скидки
 * на витрине остался прежним.
 * ---------------------------------------------------------------------- */
const products = [

  /* ============================== iPhone ============================== */
  {
    /* НОВИНКИ СЕНТЯБРЯ 2026 — iPhone Duo, iPhone 18 Pro и 18 Pro Max.
       Состав, цвета, объёмы и характеристики сняты с buy-страниц apple.com
       10 сентября 2026; фотографии — оттуда же (`apple-photos/`).

       inStock: false у всех трёх НЕ ошибка: на 10 сентября ни одна из моделей
       ещё не вышла — 18 Pro уходит в предзаказ 12-го, Duo продаётся с 23 октября.
       Магазин работает по предоплате, и «в наличии» на телефоне, которого нет ни
       у кого в мире, — это обещание, которого не сдержать. Карточка при этом
       живая: характеристики, фото и цену видно, кнопка гаснет. Появился товар —
       снимается одно слово. */
    id: 'iphone-duo', name: 'iPhone Duo', category: 'iPhone',
    price: 114690, discountPercent: 15, inStock: false,
    shortDesc: 'Складной: экран 7.6", A20 Pro, титановая петля.',
    description: 'Первый складной iPhone: раскрытый экран 7.6 дюйма с нанотекстурой — самый большой в линейке, внешний 5.4 дюйма для быстрых дел не раскрывая. Титановая рама и крышка петли, чип A20 Pro, двойная камера 48 Мп и фронтальная камера под экраном.',
    specs: 'Экран: 7.6" Super Retina XDR, складной, нанотекстура, ProMotion 120 Гц\nВнешний экран: 5.4" Super Retina XDR, Always-On, Dynamic Island\nЧип: A20 Pro, 7-ядерный GPU, двойной 16-ядерный Neural Engine\nКамеры: 48 Мп Dual Fusion + 48 Мп СШУ\nФронталка: 12 Мп Center Stage, под экраном\nАвтономность: до 44 ч видео на внешнем экране, до 31 ч на внутреннем\nПамять: от 256 ГБ до 2 ТБ\nКорпус: титановая рама и крышка петли\nЗащита: IP68\nCamera Control: быстрый доступ к съёмке\nВидео: Dolby Vision 4K120, Smart Take, Duo Preview\nРазъём: USB-C\nСвязь: 5G, Wi-Fi 7\nСистема: iOS 26 с Apple Intelligence',
    colors: IPHONE_DUO, storages: ST.ph18,
    options: [OPT.sim(5000)],
    images: [], createdAt: now - 0.05 * DAY
  },
  {
    id: 'iphone-18-pro-max', name: 'iPhone 18 Pro Max', category: 'iPhone',
    price: 74530, discountPercent: 15, inStock: false,
    shortDesc: 'A20 Pro, переменная диафрагма, 6.9", до 45 ч видео.',
    description: 'Самая большая и самая автономная модель линейки: 6.9 дюйма, до 45 часов видео и чип A20 Pro с 7-ядерным GPU. Тройная система камер 48 Мп, где главная получила переменную диафрагму от ƒ/1.48 до ƒ/4.0, и фронтальная камера 18 Мп Center Stage.',
    specs: 'Экран: 6.9" Super Retina XDR, ProMotion 120 Гц, Always-On\nЧип: A20 Pro, 7-ядерный GPU, двойной 16-ядерный Neural Engine\nКамеры: 48 Мп Fusion + 48 Мп СШУ + 48 Мп теле, Pro-режимы\nДиафрагма: переменная, ƒ/1.48, ƒ/1.8, ƒ/2.8 и ƒ/4.0\nФронталка: 18 Мп Center Stage\nАвтономность: до 45 ч видео\nПамять: от 256 ГБ до 2 ТБ\nКорпус: алюминиевый унибоди, Ceramic Shield 2\nЗащита: IP68\nКнопки: Действие\nCamera Control: быстрый доступ к съёмке\nВидео: Dolby Vision 4K120, кинематографические эффекты\nРазъём: USB-C 3 (10 Гбит/с)\nСвязь: 5G, Wi-Fi 7\nСистема: iOS 26 с Apple Intelligence',
    colors: IPHONE_18_PRO, storages: ST.ph18,
    options: [OPT.sim(5000)],
    images: [], createdAt: now - 0.06 * DAY
  },
  {
    id: 'iphone-18-pro', name: 'iPhone 18 Pro', category: 'iPhone',
    price: 68790, discountPercent: 15, inStock: false,
    shortDesc: 'A20 Pro, переменная диафрагма, 6.3".',
    description: 'Вся мощь Pro в корпусе 6.3 дюйма. Чип A20 Pro, тройная система камер 48 Мп с переменной диафрагмой у главной, фронтальная камера 18 Мп Center Stage и цельный алюминиевый корпус.',
    specs: 'Экран: 6.3" Super Retina XDR, ProMotion 120 Гц, Always-On\nЧип: A20 Pro, 7-ядерный GPU, двойной 16-ядерный Neural Engine\nКамеры: 48 Мп Fusion + 48 Мп СШУ + 48 Мп теле, Pro-режимы\nДиафрагма: переменная, ƒ/1.48, ƒ/1.8, ƒ/2.8 и ƒ/4.0\nФронталка: 18 Мп Center Stage\nАвтономность: до 45 ч видео\nПамять: от 256 ГБ до 2 ТБ\nКорпус: алюминиевый унибоди, Ceramic Shield 2\nЗащита: IP68\nКнопки: Действие\nCamera Control: быстрый доступ к съёмке\nВидео: Dolby Vision 4K120, кинематографические эффекты\nРазъём: USB-C 3 (10 Гбит/с)\nСвязь: 5G, Wi-Fi 7\nСистема: iOS 26 с Apple Intelligence',
    colors: IPHONE_18_PRO, storages: ST.ph18,
    options: [OPT.sim(5000)],
    images: [], createdAt: now - 0.07 * DAY
  },
  {
    id: 'iphone-17-pro-max', name: 'iPhone 17 Pro Max', category: 'iPhone',
    price: 67990, discountPercent: 15, inStock: true,
    shortDesc: 'A19 Pro, три камеры 48 Мп, 6.9", до 39 ч видео.',
    description: 'Самый мощный iPhone. Чип A19 Pro с 6-ядерным GPU и паровой камерой охлаждения, три камеры по 48 Мп с 8-кратным оптическим зумом и рекордная автономность — до 39 часов видео. Цельный корпус из кованого алюминия, Ceramic Shield 2 спереди и Ceramic Shield сзади.',
    specs: 'Экран: 6.9" Super Retina XDR, ProMotion 120 Гц, до 3000 нит\nЧип: A19 Pro, 6-ядерный GPU\nКамеры: 48 Мп Fusion + 48 Мп СШУ + 48 Мп теле, зум 8×\nФронталка: 18 Мп Center Stage\nАвтономность: до 39 ч видео\nПамять: от 256 ГБ до 2 ТБ\nМатериал: кованый алюминий, Ceramic Shield 2\nЗащита: IP68\nКнопки: Действие\nCamera Control: быстрый доступ к съёмке\nРазъём: USB-C 3 (10 Гбит/с)\nСвязь: 5G, Wi-Fi 7\nСистема: iOS 26 с Apple Intelligence',
    colors: IPHONE_17_PRO, storages: ST.ph17pm,
    options: [OPT.sim(8500)],
    images: [], createdAt: now - 0.2 * DAY
  },
  {
    id: 'iphone-17-pro', name: 'iPhone 17 Pro', category: 'iPhone',
    price: 66990, discountPercent: 15, inStock: true,
    shortDesc: 'A19 Pro, три камеры 48 Мп, 6.3".',
    description: 'Вся мощь Pro в компактном корпусе 6.3". Чип A19 Pro, тройная система камер 48 Мп с оптическим зумом 8×, до 33 часов видео и корпус из кованого алюминия.',
    specs: 'Экран: 6.3" Super Retina XDR, ProMotion 120 Гц, до 3000 нит\nЧип: A19 Pro, 6-ядерный GPU\nКамеры: 48 Мп Fusion + 48 Мп СШУ + 48 Мп теле, зум 8×\nФронталка: 18 Мп Center Stage\nАвтономность: до 33 ч видео\nПамять: от 256 ГБ до 1 ТБ\nМатериал: кованый алюминий, Ceramic Shield 2\nЗащита: IP68\nКнопки: Действие\nCamera Control: быстрый доступ к съёмке\nРазъём: USB-C 3 (10 Гбит/с)\nСвязь: 5G, Wi-Fi 7\nСистема: iOS 26 с Apple Intelligence',
    colors: IPHONE_17_PRO, storages: ST.ph17p,
    options: [OPT.sim(3500)],
    images: [], createdAt: now - 0.3 * DAY
  },
  {
    id: 'iphone-air', name: 'iPhone Air', category: 'iPhone',
    price: 50990, inStock: true,
    shortDesc: 'Самый тонкий iPhone: A19 Pro, титан, 6.5".',
    description: 'Самый тонкий iPhone в истории — и при этом с производительностью Pro. Титановый корпус, чип A19 Pro, камера 48 Мп Fusion и фронтальная камера Center Stage 18 Мп.',
    specs: 'Экран: 6.5" Super Retina XDR, ProMotion 120 Гц\nЧип: A19 Pro\nКамера: 48 Мп Fusion Main, зум 2×\nФронталка: 18 Мп Center Stage\nАвтономность: до 27 ч видео\nПамять: от 256 ГБ до 1 ТБ\nМатериал: титан, Ceramic Shield 2\nЗащита: IP68\nТолщина: 5.6 мм\nКнопки: Действие\nCamera Control: быстрый доступ к съёмке\nРазъём: USB-C\nСвязь: 5G, eSIM\nСистема: iOS 26 с Apple Intelligence',
    colors: IPHONE_AIR, storages: ST.ph17air,
    images: [], createdAt: now - 0.4 * DAY
  },
  {
    id: 'iphone-17', name: 'iPhone 17', category: 'iPhone',
    price: 51990, discountPercent: 15, inStock: true,
    shortDesc: 'A19, ProMotion 120 Гц, две камеры 48 Мп.',
    description: 'Впервые в базовой модели — ProMotion 120 Гц и стартовая память 256 ГБ. Чип A19, две камеры по 48 Мп, до 30 часов видео и Ceramic Shield 2 с втрое лучшей стойкостью к царапинам.',
    specs: 'Экран: 6.3" Super Retina XDR, ProMotion 120 Гц\nЧип: A19, 5-ядерный GPU\nКамеры: 48 Мп Dual Fusion + 48 Мп СШУ\nФронталка: 18 Мп Center Stage\nАвтономность: до 30 ч видео\nПамять: 256 или 512 ГБ\nМатериал: алюминий, Ceramic Shield 2\nЗащита: IP68\nКнопки: Действие\nCamera Control: быстрый доступ к съёмке\nРазъём: USB-C\nСвязь: 5G, Wi-Fi 7\nСистема: iOS 26 с Apple Intelligence',
    colors: IPHONE_17, storages: ST.ph17,
    options: [OPT.sim(1500)],
    images: [], createdAt: now - 0.5 * DAY
  },
  {
    id: 'iphone-17e', name: 'iPhone 17e', category: 'iPhone',
    price: 54990, discountPercent: 15, inStock: true,
    shortDesc: 'A19, камера 48 Мп, 6.1" — доступный iPhone.',
    description: 'Максимум возможностей за минимальные деньги: чип A19 с поддержкой Apple Intelligence, камера 48 Мп Fusion с 2-кратным оптическим зумом, кнопка «Действие» и стартовая память 256 ГБ.',
    specs: 'Экран: 6.1" Super Retina XDR\nЧип: A19\nКамера: 48 Мп Fusion Main, зум 2×\nФронталка: 12 Мп TrueDepth\nАвтономность: до 26 ч видео\nПамять: 256 или 512 ГБ\nМатериал: алюминий, Ceramic Shield 2\nЗащита: IP68\nКнопки: Действие\nРазъём: USB-C\nСвязь: 5G\nСистема: iOS 26 с Apple Intelligence',
    colors: IPHONE_17E, storages: ST.ph256s,
    options: [OPT.sim(3000)],
    images: [], createdAt: now - 0.6 * DAY
  },
  {
    id: 'iphone-16-pro-max', name: 'iPhone 16 Pro Max', category: 'iPhone',
    price: 76990, discountPercent: 15, inStock: true,
    shortDesc: 'A18 Pro, титан, 6.9", зум 5×, до 33 ч видео.',
    description: 'Флагман прошлого поколения по цене без переплаты за новизну. Титановый корпус 6.9", чип A18 Pro, тройная камера с 48 Мп Fusion и 5-кратным тетрапризменным зумом, съёмка 4K120 в Dolby Vision и до 33 часов видео.',
    specs: 'Экран: 6.9" Super Retina XDR, ProMotion 120 Гц, до 2000 нит\nЧип: A18 Pro, 6-ядерный GPU\nКамеры: 48 Мп Fusion + 48 Мп СШУ + 12 Мп теле, зум 5×\nФронталка: 12 Мп TrueDepth\nАвтономность: до 33 ч видео\nПамять: от 256 ГБ до 1 ТБ\nМатериал: титан, Ceramic Shield\nЗащита: IP68\nКнопки: Действие\nCamera Control: быстрый доступ к съёмке\nРазъём: USB-C 3 (10 Гбит/с)\nСвязь: 5G, Wi-Fi 7\nСистема: iOS 26 с Apple Intelligence',
    colors: IPHONE_16_PRO, storages: ST.ph256,
    options: [OPT.sim(5000)],
    images: [], createdAt: now - 0.9 * DAY
  },
  {
    id: 'iphone-16-pro', name: 'iPhone 16 Pro', category: 'iPhone',
    price: 68990, discountPercent: 15, inStock: true,
    shortDesc: 'A18 Pro, титан, 6.3", зум 5×.',
    description: 'Компактный Pro в титановом корпусе: чип A18 Pro, три камеры с 48 Мп Fusion и 5-кратным зумом, кнопка Camera Control и до 27 часов видео.',
    specs: 'Экран: 6.3" Super Retina XDR, ProMotion 120 Гц, до 2000 нит\nЧип: A18 Pro, 6-ядерный GPU\nКамеры: 48 Мп Fusion + 48 Мп СШУ + 12 Мп теле, зум 5×\nФронталка: 12 Мп TrueDepth\nАвтономность: до 27 ч видео\nПамять: от 128 ГБ до 1 ТБ\nМатериал: титан, Ceramic Shield\nЗащита: IP68\nКнопки: Действие\nCamera Control: быстрый доступ к съёмке\nРазъём: USB-C 3 (10 Гбит/с)\nСвязь: 5G, Wi-Fi 7\nСистема: iOS 26 с Apple Intelligence',
    colors: IPHONE_16_PRO, storages: ST.ph128p,
    options: [OPT.sim(5000)],
    images: [], createdAt: now - 0.95 * DAY
  },
  {
    id: 'iphone-16-plus', name: 'iPhone 16 Plus', category: 'iPhone',
    price: 63990, discountPercent: 15, inStock: true,
    shortDesc: 'A18, большой экран 6.7", до 27 ч видео.',
    description: 'Тот же iPhone 16, но с экраном 6.7" и самой большой батареей в линейке — до 27 часов видео. Чип A18 с Apple Intelligence, камера 48 Мп Fusion и кнопка Camera Control.',
    specs: 'Экран: 6.7" Super Retina XDR\nЧип: A18\nКамеры: 48 Мп Fusion + 12 Мп СШУ\nФронталка: 12 Мп TrueDepth\nАвтономность: до 27 ч видео\nПамять: от 128 до 512 ГБ\nМатериал: алюминий, Ceramic Shield\nЗащита: IP68\nКнопки: Действие\nCamera Control: быстрый доступ к съёмке\nРазъём: USB-C\nСвязь: 5G, Wi-Fi 7\nСистема: iOS 26 с Apple Intelligence',
    colors: IPHONE_16, storages: ST.ph128,
    options: [OPT.sim(4000)],
    images: [], createdAt: now - 0.98 * DAY
  },
  {
    id: 'iphone-16', name: 'iPhone 16', category: 'iPhone',
    price: 41990, discountPercent: 15, inStock: true,
    shortDesc: 'A18, две камеры, пять цветов.',
    description: 'Проверенный флагман прошлого поколения по сниженной цене. Чип A18 с поддержкой Apple Intelligence, камера 48 Мп Fusion, кнопка Camera Control и прочный корпус из алюминия.',
    specs: 'Экран: 6.1" Super Retina XDR\nЧип: A18\nКамеры: 48 Мп Fusion + 12 Мп СШУ\nФронталка: 12 Мп TrueDepth\nАвтономность: до 22 ч видео\nПамять: от 128 до 512 ГБ\nМатериал: алюминий, Ceramic Shield\nЗащита: IP68\nКнопки: Действие\nCamera Control: быстрый доступ к съёмке\nРазъём: USB-C\nСвязь: 5G, Wi-Fi 7\nСистема: iOS 26 с Apple Intelligence',
    colors: IPHONE_16, storages: ST.ph16,
    options: [OPT.sim(2000)],
    images: [], createdAt: now - 1 * DAY
  },
  {
    id: 'iphone-16e', name: 'iPhone 16e', category: 'iPhone',
    price: 41990, discountPercent: 15, inStock: true,
    shortDesc: 'A18, камера 48 Мп, до 26 ч видео — вход в линейку.',
    description: 'Самый доступный iPhone с Apple Intelligence. Чип A18, камера 48 Мп Fusion с 2-кратным оптическим зумом, кнопка «Действие» и собственный модем Apple C1, с которым автономность выросла до 26 часов видео.',
    specs: 'Экран: 6.1" Super Retina XDR\nЧип: A18\nКамера: 48 Мп Fusion Main, зум 2×\nФронталка: 12 Мп TrueDepth\nАвтономность: до 26 ч видео\nПамять: от 128 до 512 ГБ\nМатериал: алюминий, Ceramic Shield\nЗащита: IP68\nКнопки: Действие\nРазъём: USB-C\nСвязь: 5G, модем Apple C1\nСистема: iOS 26 с Apple Intelligence',
    colors: IPHONE_16E, storages: ST.ph128,
    options: [OPT.sim(3000)],
    images: [], createdAt: now - 1.1 * DAY
  },
  {
    id: 'iphone-15-pro-max', name: 'iPhone 15 Pro Max', category: 'iPhone',
    price: 41250, discountPercent: 15, inStock: true,
    shortDesc: 'A17 Pro, титан, 6.7", зум 5×, до 29 ч видео.',
    description: 'Первый iPhone из титана и первый с 5-кратным тетрапризменным зумом. Чип A17 Pro, кнопка «Действие» вместо переключателя звука, разъём USB-C и до 29 часов видео.',
    specs: 'Экран: 6.7" Super Retina XDR, ProMotion 120 Гц, до 2000 нит\nЧип: A17 Pro, 6-ядерный GPU\nКамеры: 48 Мп Main + 12 Мп СШУ + 12 Мп теле, зум 5×\nФронталка: 12 Мп TrueDepth\nАвтономность: до 29 ч видео\nПамять: от 256 ГБ до 1 ТБ\nМатериал: титан, Ceramic Shield\nЗащита: IP68\nКнопки: Действие\nРазъём: USB-C 3 (10 Гбит/с)\nСвязь: 5G, Wi-Fi 6E\nСистема: iOS 26',
    colors: IPHONE_15_PRO, storages: ST.ph15pm,
    options: [OPT.sim(5000)],
    images: [], createdAt: now - 1.2 * DAY
  },
  {
    id: 'iphone-15-pro', name: 'iPhone 15 Pro', category: 'iPhone',
    price: 33000, discountPercent: 15, inStock: true,
    shortDesc: 'A17 Pro, титан, 6.1", кнопка «Действие».',
    description: 'Самый лёгкий Pro за счёт титанового корпуса: 187 граммов. Чип A17 Pro, три камеры с 48 Мп Main и 3-кратным зумом, кнопка «Действие» и USB-C со скоростью до 10 Гбит/с.',
    specs: 'Экран: 6.1" Super Retina XDR, ProMotion 120 Гц, до 2000 нит\nЧип: A17 Pro, 6-ядерный GPU\nКамеры: 48 Мп Main + 12 Мп СШУ + 12 Мп теле, зум 3×\nФронталка: 12 Мп TrueDepth\nАвтономность: до 23 ч видео\nПамять: от 128 ГБ до 1 ТБ\nМатериал: титан, Ceramic Shield\nЗащита: IP68\nКнопки: Действие\nРазъём: USB-C 3 (10 Гбит/с)\nСвязь: 5G, Wi-Fi 6E\nСистема: iOS 26',
    colors: IPHONE_15_PRO, storages: ST.ph15pro,
    options: [OPT.sim(5000)],
    images: [], createdAt: now - 1.25 * DAY
  },
  {
    id: 'iphone-15-plus', name: 'iPhone 15 Plus', category: 'iPhone',
    price: 42000, discountPercent: 15, inStock: true,
    shortDesc: 'A16 Bionic, 6.7", камера 48 Мп, до 26 ч видео.',
    description: 'Большой экран 6.7" и запас автономности на два дня спокойного пользования. Камера 48 Мп с 2-кратным зумом без потери качества, Dynamic Island и разъём USB-C.',
    specs: 'Экран: 6.7" Super Retina XDR, Dynamic Island\nЧип: A16 Bionic\nКамеры: 48 Мп Main + 12 Мп СШУ, зум 2×\nФронталка: 12 Мп TrueDepth\nАвтономность: до 26 ч видео\nПамять: от 128 до 512 ГБ\nМатериал: алюминий, Ceramic Shield\nЗащита: IP68\nРазъём: USB-C\nСвязь: 5G, Wi-Fi 6\nСистема: iOS 26',
    colors: IPHONE_15, storages: ST.ph15plus,
    options: [OPT.sim(4000)],
    images: [], createdAt: now - 1.3 * DAY
  },
  {
    id: 'iphone-15', name: 'iPhone 15', category: 'iPhone',
    price: 26500, discountPercent: 15, inStock: true,
    shortDesc: 'A16 Bionic, 6.1", камера 48 Мп, Dynamic Island.',
    description: 'Первый iPhone с USB-C и цветом, запечённым в само стекло. Камера 48 Мп с 2-кратным зумом, Dynamic Island и чип A16 Bionic — рабочая лошадка, которая ещё долго будет получать обновления.',
    specs: 'Экран: 6.1" Super Retina XDR, Dynamic Island\nЧип: A16 Bionic\nКамеры: 48 Мп Main + 12 Мп СШУ, зум 2×\nФронталка: 12 Мп TrueDepth\nАвтономность: до 20 ч видео\nПамять: от 128 до 512 ГБ\nМатериал: алюминий, Ceramic Shield\nЗащита: IP68\nРазъём: USB-C\nСвязь: 5G, Wi-Fi 6\nСистема: iOS 26',
    colors: IPHONE_15, storages: ST.ph15,
    options: [OPT.sim(4000)],
    images: [], createdAt: now - 1.35 * DAY
  },

  /* =============================== Mac =============================== */
  {
    id: 'macbook-neo', name: 'MacBook Neo', category: 'Mac',
    price: 69990, inStock: true,
    shortDesc: 'Самый доступный MacBook: 13", лёгкий, четыре цвета.',
    description: 'Магия Mac по удивительной цене. Лёгкий 13-дюймовый ноутбук в четырёх ярких цветах, тоньше половины дюйма, с поддержкой Apple Intelligence и целым днём автономной работы.',
    specs: 'Экран: 13.0" Liquid Retina, 500 нит\nЧип: Apple A18 Pro, 6-ядерный CPU, 5-ядерный GPU\nОЗУ: 8 ГБ\nПамять: 256 или 512 ГБ SSD\nАвтономность: до 16 ч видео\nПорты: USB 3 (USB-C), USB 2 (USB-C), аудиоразъём\nЗарядка: 20 Вт USB-C\nКлавиатура: Magic Keyboard; Touch ID в версии 512 ГБ\nГотов к ИИ: Apple Intelligence в macOS 26',
    colors: MB_NEO, storages: ST.neo,
    options: [],
    images: [], createdAt: now - 0.7 * DAY
  },
  {
    id: 'macbook-air-13-m5', name: 'MacBook Air 13" (M5)', category: 'Mac',
    price: 119990, discountPercent: 15, inStock: true,
    shortDesc: 'M5, 13.6", до 18 часов работы, 1.24 кг.',
    description: 'Тонкий, быстрый, мощный и портативный. Чип M5 с 10-ядерным CPU, безвентиляторная конструкция, до 18 часов автономной работы и вес всего 1.24 кг.',
    specs: 'Экран: 13.6" Liquid Retina, 500 нит\nЧип: Apple M5, 10-ядерный CPU\nОЗУ: 16 ГБ (до 32 ГБ)\nПамять: от 512 ГБ SSD\nАвтономность: до 18 ч\nВес: 1.24 кг\nПорты: 2× Thunderbolt 4, MagSafe 3, аудиоразъём\nКамера: 12 Мп Center Stage\nАудио: 4 динамика, Spatial Audio\nСвязь: Wi-Fi 7, Bluetooth 6\nГотов к ИИ: Apple Intelligence в macOS 26',
    colors: MB_AIR, storages: ST.air13,
    options: [PERF_AIR13, POWER_AIR],
    images: [], createdAt: now - 0.8 * DAY
  },
  {
    id: 'macbook-air-15-m5', name: 'MacBook Air 15" (M5)', category: 'Mac',
    price: 139990, discountPercent: 15, inStock: true,
    shortDesc: 'M5, большой экран 15.3", шесть динамиков.',
    description: 'Всё то же, что в 13-дюймовом Air, но с большим экраном 15.3" и системой из шести динамиков. Идеально, когда нужен простор для работы и кино.',
    specs: 'Экран: 15.3" Liquid Retina, 500 нит\nЧип: Apple M5, 10-ядерный CPU\nОЗУ: 16 ГБ (до 32 ГБ)\nПамять: от 512 ГБ SSD\nАвтономность: до 18 ч\nВес: 1.51 кг\nПорты: 2× Thunderbolt 4, MagSafe 3, аудиоразъём\nКамера: 12 Мп Center Stage\nАудио: 6 динамиков, Spatial Audio\nСвязь: Wi-Fi 7, Bluetooth 6\nГотов к ИИ: Apple Intelligence в macOS 26',
    colors: MB_AIR, storages: ST.air15,
    options: [RAM_AIR15, POWER_AIR],
    images: [], createdAt: now - 0.9 * DAY
  },
  {
    id: 'macbook-pro-14-m5', name: 'MacBook Pro 14" (M5)', category: 'Mac',
    price: 189990, discountPercent: 15, inStock: true,
    shortDesc: 'M5 / M5 Pro / M5 Max, Liquid Retina XDR 120 Гц.',
    description: 'Самый продвинутый ноутбук Mac для требовательных задач. Чипы M5, M5 Pro или M5 Max, дисплей Liquid Retina XDR с ProMotion 120 Гц, Thunderbolt 5 и до 24 часов автономной работы.',
    specs: 'Экран: 14.2" Liquid Retina XDR, 120 Гц, 1600 нит\nЧип: Apple M5 (до M5 Max)\nОЗУ: 16 ГБ (до 128 ГБ)\nПамять: от 1 ТБ SSD\nАвтономность: до 24 ч\nВес: 1.55 кг\nПорты: 3× Thunderbolt 5, HDMI, SDXC, MagSafe 3\nКамера: 12 Мп Center Stage\nАудио: 6 динамиков, 3 микрофона студийного качества\nСвязь: Wi-Fi 7, Bluetooth 6\nГотов к ИИ: Apple Intelligence в macOS 26',
    colors: MB_PRO, storages: ST.pro14,
    options: [CHIP_PRO14, RAM_PRO14, OPT.glass(13500), POWER_PRO14],
    images: [], createdAt: now - 1.1 * DAY
  },
  {
    id: 'macbook-pro-16-m5-pro', name: 'MacBook Pro 16" (M5 Pro)', category: 'Mac',
    price: 279990, discountPercent: 15, inStock: true,
    shortDesc: 'M5 Pro / M5 Max, 16.2" XDR, до 26 часов.',
    description: 'Максимальный экран и максимальная производительность. Чипы M5 Pro и M5 Max, до 128 ГБ объединённой памяти, четыре порта Thunderbolt 5 и самая долгая автономность среди ноутбуков Mac.',
    specs: 'Экран: 16.2" Liquid Retina XDR, 120 Гц, 1600 нит\nЧип: Apple M5 Pro (до M5 Max)\nОЗУ: 24 ГБ (до 128 ГБ)\nПамять: от 1 ТБ SSD\nАвтономность: до 26 ч\nВес: 2.14 кг\nПорты: 4× Thunderbolt 5, HDMI, SDXC, MagSafe 3\nКамера: 12 Мп Center Stage\nАудио: 6 динамиков, Spatial Audio\nСвязь: Wi-Fi 7, Bluetooth 6\nГотов к ИИ: Apple Intelligence в macOS 26',
    colors: MB_PRO, storages: ST.pro16,
    options: [CHIP_PRO16, RAM_PRO16, OPT.glass(13500)],
    images: [], createdAt: now - 1.2 * DAY
  },
  {
    id: 'imac-m5', name: 'iMac 24" (M4)', category: 'Mac',
    price: 139990, inStock: true,
    shortDesc: 'Моноблок 24" 4.5K, семь цветов, M4.',
    description: 'Моноблок для творчества и работы: дисплей 24" Retina 4.5K, чип M4, камера Center Stage 12 Мп и подобранные в цвет Magic Keyboard и Magic Mouse в комплекте.',
    specs: 'Экран: 24" Retina 4.5K, 500 нит\nЧип: Apple M4, 8 или 10 ядер GPU\nОЗУ: 16 ГБ (до 32 ГБ)\nПамять: от 256 ГБ SSD\nКамера: 12 Мп Center Stage с Desk View\nАудио: 6 динамиков, Spatial Audio\nПорты: 2× Thunderbolt 4, 2× USB-C\nКлавиатура: Magic Keyboard в цвет корпуса\nСвязь: Wi-Fi 7, Bluetooth 6\nГотов к ИИ: Apple Intelligence в macOS 26',
    colors: IMAC, storages: ST.imac,
    options: [RAM_IMAC, IMAC_GLASS, IMAC_PORTS, IMAC_KEYBOARD],
    images: [], createdAt: now - 1.3 * DAY
  },
  {
    id: 'mac-mini-m5', name: 'Mac mini (M4)', category: 'Mac',
    price: 74990, discountPercent: 15, inStock: true,
    shortDesc: 'Самый компактный Mac: M4 или M4 Pro, 12.7 см.',
    description: 'Самый маленький и доступный десктоп Mac. Чип M4 или M4 Pro, корпус 12.7 × 12.7 см, порты Thunderbolt спереди и сзади — подключается к любому монитору и клавиатуре.',
    specs: 'Чип: Apple M4 (опция M4 Pro)\nОЗУ: 16 ГБ (до 64 ГБ)\nПамять: от 256 ГБ SSD\nПорты: 2× Thunderbolt 4 спереди, 3× Thunderbolt сзади, HDMI, Ethernet\nРазмер: 12.7 × 12.7 × 5 см\nАудио: аудиоразъём 3.5 мм\nСвязь: Wi-Fi 7, Bluetooth 6\nПитание: встроенный блок питания',
    colors: [C.silver], storages: ST.mini,
    options: [CHIP_MINI, RAM_MINI, MINI_ETHERNET],
    images: [], createdAt: now - 1.4 * DAY
  },
  {
    id: 'mac-studio-m5-max', name: 'Mac Studio (M4 Max)', category: 'Mac',
    price: 239990, inStock: true,
    shortDesc: 'M4 Max / M3 Ultra, Thunderbolt 5, 10 Гбит Ethernet.',
    description: 'Настольная станция для профессионалов: чипы M4 Max и M3 Ultra, до 512 ГБ объединённой памяти, четыре порта Thunderbolt 5 и Ethernet 10 Гбит/с в компактном корпусе.',
    specs: 'Чип: Apple M4 Max (опция M3 Ultra)\nОЗУ: 36 ГБ (до 512 ГБ)\nПамять: от 512 ГБ SSD; M3 Ultra — от 1 ТБ\nПорты: 4× Thunderbolt 5, 2× USB-A, HDMI, SDXC, Ethernet 10 Гбит/с\nРазмер: 19.7 × 19.7 × 9.5 см\nАудио: аудиоразъём для наушников высокого сопротивления\nСвязь: Wi-Fi 7, Bluetooth 6\nГотов к ИИ: Apple Intelligence в macOS 26',
    colors: [C.silver], storages: ST.studio,
    options: [CHIP_STUDIO, RAM_STUDIO],
    images: [], createdAt: now - 1.5 * DAY
  },
  {
    id: 'studio-display', name: 'Studio Display', category: 'Mac',
    price: 159990, inStock: true,
    shortDesc: 'Монитор 27" 5K Retina с камерой и динамиками.',
    description: 'Монитор 27" Retina 5K, созданный для Mac: 600 нит, широкий цвет P3, True Tone, камера Center Stage 12 Мп, три микрофона и шесть динамиков с поддержкой Spatial Audio.',
    specs: 'Экран: 27" Retina 5K, 600 нит, P3\nКамера: 12 Мп Center Stage\nАудио: 6 динамиков, Spatial Audio, 3 микрофона\nПорты: Thunderbolt 3, 3× USB-C\nПоддержка: подставка с наклоном (опция — регулировка высоты)\nПокрытие: стандартное или нанотекстурное',
    colors: [C.silver], storages: [],
    options: [OPT.glass(29990), OPT.stand(39990)],
    images: [], createdAt: now - 1.6 * DAY
  },
  {
    id: 'studio-display-xdr', name: 'Studio Display XDR', category: 'Mac',
    price: 289990, inStock: true,
    shortDesc: 'Монитор 27" 5K XDR, mini-LED, 120 Гц.',
    description: 'Профессиональный монитор 27" Retina 5K XDR с подсветкой mini-LED: 1000 нит SDR и 2000 нит пиковой яркости HDR, частота 120 Гц и охват Adobe RGB для точной работы с цветом.',
    specs: 'Экран: 27" Retina 5K XDR, mini-LED\nЯркость: 1000 нит SDR, 2000 нит HDR\nЧастота: 120 Гц адаптивная\nЦвет: P3 и Adobe RGB\nКамера: 12 Мп Center Stage\nАудио: 6 динамиков, Spatial Audio\nПорты: Thunderbolt 5, 3× USB-C\nПокрытие: стандартное или нанотекстурное',
    colors: [C.silver], storages: [],
    options: [OPT.glass(44990), OPT.stand(59990)],
    images: [], createdAt: now - 1.7 * DAY
  },

  /* =============================== iPad =============================== */
  {
    id: 'ipad-pro-13-m5', name: 'iPad Pro 13" (M5)', category: 'iPad',
    price: 134990, discountPercent: 15, inStock: true,
    shortDesc: 'M5, Ultra Retina XDR OLED 13", Thunderbolt.',
    description: 'Самый мощный iPad. Чип M5, тандемный OLED-дисплей Ultra Retina XDR, толщина корпуса 5.1 мм, Thunderbolt и поддержка Apple Pencil Pro с Magic Keyboard.',
    specs: 'Экран: 13" Ultra Retina XDR OLED, ProMotion 120 Гц\nЧип: Apple M5\nОЗУ: 12 ГБ\nПамять: от 256 ГБ до 2 ТБ\nКамера: 12 Мп + LiDAR\nФронталка: 12 Мп Center Stage\nАвтономность: до 10 ч\nТолщина: 5.1 мм\nРазъём: USB-C с Thunderbolt / USB 4\nПоддержка: Apple Pencil Pro, Magic Keyboard\nСвязь: Wi-Fi 7, 5G (опция)\nApple Intelligence: тексты, Genmoji, обновлённая Siri',
    colors: IPAD_PRO, storages: ST.pad256,
    // Нанотекстура — только на 1 ТБ и 2 ТБ, как на apple.com/shop/buy-ipad
    options: [OPT.glass(15000, ['1 ТБ', '2 ТБ']), OPT.cellular(20000)],
    images: [], createdAt: now - 1.8 * DAY
  },
  {
    id: 'ipad-pro-11-m5', name: 'iPad Pro 11" (M5)', category: 'iPad',
    price: 104990, discountPercent: 15, inStock: true,
    shortDesc: 'M5, OLED 11", 5.3 мм, Apple Pencil Pro.',
    description: 'Компактный iPad Pro с чипом M5 и тандемным OLED-дисплеем Ultra Retina XDR. Толщина всего 5.3 мм при полной производительности Pro.',
    specs: 'Экран: 11" Ultra Retina XDR OLED, ProMotion 120 Гц\nЧип: Apple M5\nОЗУ: 12 ГБ\nПамять: от 256 ГБ до 2 ТБ\nКамера: 12 Мп + LiDAR\nФронталка: 12 Мп Center Stage\nАвтономность: до 10 ч\nТолщина: 5.3 мм\nРазъём: USB-C с Thunderbolt / USB 4\nПоддержка: Apple Pencil Pro, Magic Keyboard\nСвязь: Wi-Fi 7, 5G (опция)\nApple Intelligence: тексты, Genmoji, обновлённая Siri',
    colors: IPAD_PRO, storages: ST.pad256,
    options: [OPT.glass(15000, ['1 ТБ', '2 ТБ']), OPT.cellular(20000)],
    images: [], createdAt: now - 1.9 * DAY
  },
  {
    id: 'ipad-air-13-m4', name: 'iPad Air 13" (M4)', category: 'iPad',
    price: 79990, discountPercent: 15, inStock: true,
    shortDesc: 'M4, большой экран 13", четыре цвета.',
    description: 'Серьёзная производительность в тонком и легком корпусе. Чип M4, дисплей Liquid Retina 13", поддержка Apple Pencil Pro и клавиатуры Magic Keyboard.',
    specs: 'Экран: 13" Liquid Retina, 600 нит\nЧип: Apple M4\nОЗУ: 8 ГБ\nПамять: от 128 ГБ до 1 ТБ\nКамера: 12 Мп\nФронталка: 12 Мп Center Stage\nАвтономность: до 10 ч\nВес: 618 г\nРазъём: USB-C\nПоддержка: Apple Pencil Pro, Magic Keyboard\nСвязь: Wi-Fi 6E, 5G (опция)\nApple Intelligence: тексты, Genmoji, обновлённая Siri',
    colors: IPAD_AIR, storages: ST.padAir,
    options: [OPT.cellular(15000)],
    images: [], createdAt: now - 2 * DAY
  },
  {
    id: 'ipad-air-11-m4', name: 'iPad Air 11" (M4)', category: 'iPad',
    price: 55990, discountPercent: 15, inStock: true,
    shortDesc: 'M4, 11", лёгкий и универсальный.',
    description: 'Универсальный iPad для учёбы, работы и творчества: чип M4, дисплей Liquid Retina 11", поддержка Apple Pencil Pro и Apple Intelligence.',
    specs: 'Экран: 11" Liquid Retina, 500 нит\nЧип: Apple M4\nОЗУ: 8 ГБ\nПамять: от 128 ГБ до 1 ТБ\nКамера: 12 Мп\nФронталка: 12 Мп Center Stage\nАвтономность: до 10 ч\nВес: 460 г\nРазъём: USB-C\nПоддержка: Apple Pencil Pro, Magic Keyboard\nСвязь: Wi-Fi 6E, 5G (опция)\nApple Intelligence: тексты, Genmoji, обновлённая Siri',
    colors: IPAD_AIR, storages: ST.padAir,
    options: [OPT.cellular(15000)],
    images: [], createdAt: now - 2.1 * DAY
  },
  {
    id: 'ipad-a16', name: 'iPad (A16)', category: 'iPad',
    price: 34990, discountPercent: 15, inStock: true,
    shortDesc: 'A16, 11", четыре цвета — самый доступный iPad.',
    description: 'Красочный iPad для повседневных дел. Чип A16, дисплей Liquid Retina 11", поддержка Apple Pencil (USB-C) и целый день автономной работы.',
    specs: 'Экран: 11" Liquid Retina, 500 нит\nЧип: Apple A16\nПамять: от 128 до 512 ГБ\nКамера: 12 Мп\nФронталка: 12 Мп Center Stage\nАвтономность: до 10 ч\nВес: 477 г\nРазъём: USB-C\nПоддержка: Apple Pencil (USB-C)\nСвязь: Wi-Fi 6, 5G (опция)',
    colors: IPAD_11, storages: ST.pad128,
    options: [OPT.cellular(12000)],
    images: [], createdAt: now - 2.2 * DAY
  },
  {
    id: 'ipad-mini-a17-pro', name: 'iPad mini (A17 Pro)', category: 'iPad',
    price: 49990, discountPercent: 15, inStock: true,
    shortDesc: 'A17 Pro, 8.3" — весь iPad в кармане.',
    description: 'Полноценный iPad в ультрапортативном формате. Чип A17 Pro с поддержкой Apple Intelligence, дисплей 8.3" и поддержка Apple Pencil Pro.',
    specs: 'Экран: 8.3" Liquid Retina, 500 нит\nЧип: Apple A17 Pro\nПамять: от 128 до 512 ГБ\nКамера: 12 Мп\nФронталка: 12 Мп Center Stage\nАвтономность: до 10 ч\nВес: 293 г\nРазъём: USB-C\nПоддержка: Apple Pencil Pro\nСвязь: Wi-Fi 6E, 5G (опция)\nApple Intelligence: тексты, Genmoji, обновлённая Siri',
    colors: IPAD_AIR, storages: ST.pad128,
    options: [OPT.cellular(15000)],
    images: [], createdAt: now - 2.3 * DAY
  },

  /* =========================== Apple Watch =========================== */
  /* Series 12 — ОДНА buy-страница и ТРИ карточки, как это уже сделано у
     Series 11: у материалов свои цвета, своя цена и свой набор ремешков, а
     выбор материала на витрине — это выбор товара, а не вариации.
     Керамика у Apple появилась впервые; титан и керамика идут только с
     Cellular, поэтому группы «Связь» у них нет вовсе.
     Продажи с 18 сентября 2026 — отсюда inStock: false (см. iPhone выше). */
  {
    id: 'watch-series-12-alu', name: 'Apple Watch Series 12 (алюминий)', category: 'Apple Watch',
    price: 22890, discountPercent: 15, inStock: false,
    shortDesc: 'Экран LTPO3 до 2000 нит, гипертония, оценка сна.',
    description: 'Часы, которые следят за здоровьем всерьёз: уведомления о признаках гипертонии, оценка качества сна и апноэ, ЭКГ и кислород в крови, приложение «Показатели» с пульсом, дыханием и температурой. Экран Always-On до 2000 нит, до 24 часов работы и связь 5G.',
    specs: 'Корпус: алюминий 42 или 46 мм\nЭкран: Always-On Retina, до 2000 нит, широкоугольный OLED LTPO3\nЧип: S11 SiP, жесты взмахом и двойным нажатием\nАвтономность: до 24 ч, до 38 ч в экономном режиме\nНавигация: GPS L1\nЗащита: WR50, IP6X\nВода: плавание и снорклинг, глубиномер до 6 м\nДатчики: Vitals — пульс, дыхание, температура, сон\nЗдоровье: уведомления о гипертонии, ЭКГ, кислород в крови\nСон: оценка сна и уведомления об апноэ\nБезопасность: Emergency SOS, Fall Detection, Crash Detection\nСвязь: 5G (опция), Wi-Fi, Bluetooth\nЗарядка: быстрая, до 80 % за 30 минут\nСистема: watchOS 26 с Apple Intelligence',
    colors: W12_ALU, storages: ST.watch42s12,
    bands: BANDS.series12,
    // алюминиевые Series 12 продаются в двух версиях: GPS и GPS + Cellular
    options: [OPT.watchCellular(5700)],
    images: [], createdAt: now - 2.34 * DAY
  },
  {
    id: 'watch-series-12-titan', name: 'Apple Watch Series 12 (титан)', category: 'Apple Watch',
    price: 40110, discountPercent: 15, inStock: false,
    shortDesc: 'Полированный титан, браслет, 5G в базе.',
    description: 'Series 12 в полированном титановом корпусе: те же функции здоровья, что у алюминия, плюс премиальный материал, стальные и кожаные ремешки и связь 5G с самого начала — версии без Cellular у титана нет.',
    specs: 'Корпус: титан 42 или 46 мм, сапфировое стекло\nЭкран: Always-On Retina, до 2000 нит, широкоугольный OLED LTPO3\nЧип: S11 SiP, жесты взмахом и двойным нажатием\nАвтономность: до 24 ч, до 38 ч в экономном режиме\nНавигация: GPS L1\nЗащита: WR50, IP6X\nВода: плавание и снорклинг, глубиномер до 6 м\nДатчики: Vitals — пульс, дыхание, температура, сон\nЗдоровье: уведомления о гипертонии, ЭКГ, кислород в крови\nСон: оценка сна и уведомления об апноэ\nБезопасность: Emergency SOS, Fall Detection, Crash Detection\nСвязь: 5G, Wi-Fi, Bluetooth\nЗарядка: быстрая, до 80 % за 30 минут\nСистема: watchOS 26 с Apple Intelligence',
    colors: W12_TITAN, storages: ST.watch42s12,
    bands: BANDS.series12.concat(BANDS.series12Steel, BANDS.series12Link),
    images: [], createdAt: now - 2.35 * DAY
  },
  {
    id: 'watch-series-12-ceramic', name: 'Apple Watch Series 12 (керамика)', category: 'Apple Watch',
    price: 51580, discountPercent: 15, inStock: false,
    shortDesc: 'Керамический корпус — впервые в линейке, 5G в базе.',
    description: 'Впервые в Apple Watch — корпус из полированной керамики: не царапается, не тускнеет и не холодит руку, как металл. Внутри те же Series 12: гипертония, оценка сна, ЭКГ и кислород в крови, экран до 2000 нит и связь 5G.',
    specs: 'Корпус: керамика 42 или 46 мм, сапфировое стекло\nЭкран: Always-On Retina, до 2000 нит, широкоугольный OLED LTPO3\nЧип: S11 SiP, жесты взмахом и двойным нажатием\nАвтономность: до 24 ч, до 38 ч в экономном режиме\nНавигация: GPS L1\nЗащита: WR50, IP6X\nВода: плавание и снорклинг, глубиномер до 6 м\nДатчики: Vitals — пульс, дыхание, температура, сон\nЗдоровье: уведомления о гипертонии, ЭКГ, кислород в крови\nСон: оценка сна и уведомления об апноэ\nБезопасность: Emergency SOS, Fall Detection, Crash Detection\nСвязь: 5G, Wi-Fi, Bluetooth\nЗарядка: быстрая, до 80 % за 30 минут\nСистема: watchOS 26 с Apple Intelligence',
    colors: W12_CERAMIC, storages: ST.watch42s12,
    bands: BANDS.series12.concat(BANDS.series12Steel),
    images: [], createdAt: now - 2.36 * DAY
  },
  {
    id: 'watch-ultra-4', name: 'Apple Watch Ultra 4', category: 'Apple Watch',
    price: 45840, discountPercent: 15, inStock: false,
    shortDesc: 'Титан 49 мм, спутник, до 50 часов, WR100.',
    description: 'Часы для спорта и приключений: титановый корпус 49 мм, самый яркий экран Apple Watch — до 3000 нит, спутниковая связь и экстренный вызов SOS без сотовой сети. До 50 часов работы и до 84 часов в экономном режиме, погружения до 40 метров и сирена на 86 децибел.',
    specs: 'Корпус: титан 49 мм\nЭкран: Always-On Retina, до 3000 нит, широкоугольный OLED LTPO3\nЧип: S11 SiP, жесты взмахом и двойным нажатием\nАвтономность: до 50 ч, до 84 ч в экономном режиме\nНавигация: двухчастотный GPS\nСпутник: экстренный вызов SOS через спутник\nЗащита: WR100, IP6X, MIL-STD 810H\nВода: плавание, снорклинг и дайвинг, глубиномер до 40 м\nДатчики: Vitals — пульс, дыхание, температура, сон\nЗдоровье: уведомления о гипертонии, ЭКГ, кислород в крови\nСон: оценка сна и уведомления об апноэ\nБезопасность: Emergency SOS, сирена 86 дБ, Fall Detection\nСвязь: 5G, Wi-Fi, Bluetooth\nЗарядка: быстрая, до 80 % за 45 минут\nСистема: watchOS 26 с Apple Intelligence',
    colors: W_ULTRA4, storages: [],
    bands: BANDS.ultra4,
    images: [], createdAt: now - 2.37 * DAY
  },
  {
    id: 'watch-series-11-alu', name: 'Apple Watch Series 11 (алюминий)', category: 'Apple Watch',
    price: 23250, discountPercent: 15, inStock: true,
    shortDesc: 'Уведомления о гипертонии, оценка сна, 5G.',
    description: 'Лучший способ следить за здоровьем: уведомления о признаках гипертонии, оценка качества сна, ЭКГ и кислород в крови. Экран в 2 раза устойчивее к царапинам, до 24 часов работы и связь 5G.',
    specs: 'Корпус: алюминий 42 или 46 мм\nЭкран: Always-On Retina, до 2000 нит\nЧип: S11 SiP\nАвтономность: до 24 ч\nНавигация: GPS\nЗащита: WR50, IP6X\nДатчики: Vitals — пульс, дыхание, температура, сон\nЗдоровье: уведомления о гипертонии\nСон: оценка сна и отслеживание фаз\nБезопасность: Emergency SOS, Fall Detection, Crash Detection\nСвязь: 5G (опция), Wi-Fi, Bluetooth 6\nЗарядка: быстрая, USB-C',
    colors: W_ALU, storages: ST.watch42s11,
    bands: BANDS.series,
    // алюминиевые Series 11 продаются в двух версиях: GPS и GPS + Cellular
    options: [OPT.watchCellular(9000)],
    images: [], createdAt: now - 2.4 * DAY
  },
  {
    id: 'watch-series-11-titan', name: 'Apple Watch Series 11 (титан)', category: 'Apple Watch',
    price: 72990, inStock: true,
    shortDesc: 'Титановый корпус, сапфировое стекло, 5G.',
    description: 'Series 11 в полированном титановом корпусе с сапфировым стеклом. Все функции здоровья флагманских часов и премиальные материалы в трёх оттенках.',
    specs: 'Корпус: титан 42 или 46 мм, сапфировое стекло\nЭкран: Always-On Retina, до 2000 нит\nЧип: S11 SiP\nАвтономность: до 24 ч\nНавигация: GPS\nЗащита: WR50, IP6X\nДатчики: Vitals — пульс, ЭКГ, кислород в крови, температура\nЗдоровье: уведомления о гипертонии\nСон: оценка сна и отслеживание фаз\nБезопасность: Emergency SOS, Fall Detection, Crash Detection\nСвязь: 5G, Wi-Fi, Bluetooth 6\nЗарядка: быстрая, USB-C',
    colors: W_TITAN, storages: ST.watch42,
    bands: BANDS.series.concat(BANDS.seriesTitan),
    images: [], createdAt: now - 2.5 * DAY
  },
  {
    id: 'watch-series-10', name: 'Apple Watch Series 10', category: 'Apple Watch',
    price: 21750, inStock: true,
    shortDesc: 'Самый тонкий корпус, экран Wide-Angle OLED, 42 и 46 мм.',
    description: 'Прошлое поколение флагманских часов по цене без переплаты за новизну. Самый тонкий корпус за всю линейку, широкоугольный OLED-экран, который читается под углом, зарядка до 80 % за полчаса и датчик апноэ во сне.',
    specs: 'Корпус: алюминий 42 или 46 мм\nЭкран: Always-On Wide-Angle OLED, до 2000 нит\nЧип: S10 SiP\nАвтономность: до 18 ч\nНавигация: GPS\nЗащита: WR50, IP6X\nДатчики: пульс, ЭКГ, кислород в крови, температура\nСон: оценка сна и уведомления об апноэ\nБезопасность: Emergency SOS, Fall Detection, Crash Detection\nСвязь: LTE (опция), Wi-Fi, Bluetooth 5.3\nЗарядка: до 80 % за 30 минут, USB-C',
    colors: W_S10, storages: ST.watch42s10,
    bands: BANDS.series,
    options: [OPT.watchCellular(7000)],
    images: [], createdAt: now - 2.55 * DAY
  },
  {
    id: 'watch-ultra-3', name: 'Apple Watch Ultra 3', category: 'Apple Watch',
    price: 44250, discountPercent: 15, inStock: true,
    shortDesc: 'Титан 49 мм, спутник, до 42 часов, WR100.',
    description: 'Часы для спорта и приключений. Титановый корпус 49 мм, самый большой дисплей Apple Watch, спутниковая связь и экстренный вызов SOS, до 42 часов работы и до 72 часов в режиме энергосбережения.',
    specs: 'Корпус: титан 49 мм\nЭкран: Always-On Retina, до 3000 нит\nЧип: S11 SiP\nАвтономность: до 42 ч (72 ч в экономном режиме)\nНавигация: двухчастотный GPS\nСвязь: 5G, спутниковые сообщения\nБезопасность: Emergency SOS, сирена 86 дБ\nДатчики: Vitals — пульс, ЭКГ, кислород, температура, глубиномер\nЗащита: WR100, погружения до 40 м, MIL-STD 810H\nСон: оценка сна и отслеживание фаз\nКнопки: Действие, двойное нажатие',
    colors: [{ name: 'Натуральный титан', hex: '#cfc9c0' }, { name: 'Чёрный титан', hex: '#2b2b2e' }],
    storages: [],
    bands: BANDS.ultra,
    images: [], createdAt: now - 2.6 * DAY
  },
  {
    id: 'watch-ultra-2', name: 'Apple Watch Ultra 2', category: 'Apple Watch',
    price: 41250, inStock: true,
    shortDesc: 'Титан 49 мм, до 36 часов, WR100, сирена 86 дБ.',
    description: 'Первые часы Apple для настоящих нагрузок и вторая их версия: титановый корпус 49 мм, экран до 3000 нит, до 36 часов работы и до 72 в экономном режиме, погружения до 40 метров и сирена, которую слышно за 180 метров.',
    specs: 'Корпус: титан 49 мм\nЭкран: Always-On Retina, до 3000 нит\nЧип: S9 SiP\nАвтономность: до 36 ч (72 ч в экономном режиме)\nНавигация: двухчастотный GPS\nСвязь: LTE, Wi-Fi, Bluetooth 5.3\nБезопасность: Emergency SOS, сирена 86 дБ\nДатчики: пульс, ЭКГ, кислород в крови, температура, глубиномер\nЗащита: WR100, погружения до 40 м, MIL-STD 810H\nСон: оценка сна и отслеживание фаз\nКнопки: Действие, двойное нажатие',
    colors: [{ name: 'Натуральный титан', hex: '#cfc9c0' }, { name: 'Чёрный титан', hex: '#2b2b2e' }],
    storages: [],
    bands: BANDS.ultra,
    images: [], createdAt: now - 2.65 * DAY
  },
  {
    id: 'watch-se-3', name: 'Apple Watch SE 3', category: 'Apple Watch',
    price: 27990, discountPercent: 15, inStock: true,
    shortDesc: 'Основные функции здоровья по приятной цене.',
    description: 'Все главные возможности Apple Watch за меньшие деньги: датчик температуры, уведомления об апноэ во время сна, определение аварии и до 18 часов работы.',
    specs: 'Корпус: алюминий 40 или 44 мм\nЭкран: Always-On Retina\nЧип: S10 SiP\nАвтономность: до 18 ч\nНавигация: GPS\nЗащита: WR50\nДатчики: пульс, температура, акселерометр\nСон: оценка сна и отслеживание фаз\nБезопасность: Emergency SOS, Crash Detection\nСвязь: LTE (опция), Wi-Fi, Bluetooth\nЗарядка: быстрая, USB-C',
    colors: [C.midnight, C.starlight], storages: ST.watch40,
    bands: BANDS.se,
    options: [OPT.watchCellular(7000)],
    images: [], createdAt: now - 2.7 * DAY
  },
  {
    id: 'watch-hermes-series-11', name: 'Apple Watch Hermès Series 11', category: 'Apple Watch',
    price: 149990, inStock: true,
    shortDesc: 'Титан, эксклюзивные ремешки и циферблаты Hermès.',
    description: 'Совместная модель Apple и Hermès: титановый корпус, кожаные ремешки ручной работы и эксклюзивные циферблаты, недоступные в других версиях.',
    specs: 'Корпус: титан 42 или 46 мм, сапфировое стекло\nЭкран: Always-On Retina, до 2000 нит\nЧип: S11 SiP\nАвтономность: до 24 ч\nНавигация: GPS\nЗащита: WR50, IP6X\nДатчики: Vitals — пульс, ЭКГ, кислород в крови\nЗдоровье: уведомления о гипертонии\nБезопасность: Emergency SOS, Fall Detection\nСвязь: 5G, Wi-Fi\nРемешки: эксклюзивные ремешки и циферблаты Hermès',
    colors: [{ name: 'Титан Hermès', hex: '#cfc9c0' }], storages: ST.watch42,
    bands: BANDS.hermes,
    images: [], createdAt: now - 2.8 * DAY
  },

  /* ============================== AirPods ============================== */
  {
    // Продажи с 18 сентября 2026 — отсюда inStock: false (см. iPhone выше).
    id: 'airpods-5', name: 'AirPods 5', category: 'AirPods',
    price: 7400, discountPercent: 15, inStock: false,
    shortDesc: 'Шумодав в 1,5 раза сильнее, открытая посадка.',
    description: 'Активное шумоподавление теперь и в открытых AirPods — до полутора раз сильнее, чем у AirPods 4 с шумоподавлением. Переработанная акустика и адаптивный эквалайзер нового поколения, живой перевод и Siri AI. Ничего не давит в ухе: посадка открытая, без амбушюр.',
    specs: 'Шумоподавление: активное, до 1,5× сильнее AirPods 4\nЗвук: новая акустическая архитектура, Adaptive EQ нового поколения\nАудио: пространственное с отслеживанием головы\nПосадка: открытая, без амбушюр\nАвтономность: до 4 ч с шумоподавлением, до 5 ч с футляром беспроводной зарядки\nФутляр: зарядка USB-C, у версии с беспроводной — Qi и зарядка Apple Watch\nУправление: сенсор нажатия, у версии с беспроводным футляром — проведение по громкости\nПеревод: Live Translation на Apple Intelligence\nSiri: Siri AI, «Привет, Siri» и Siri Interactions\nМикрофон: Voice Isolation\nЗащита: IP54\nСвязь: Bluetooth',
    colors: [{ name: 'Белый', hex: '#f5f5f5' }], storages: [],
    options: [AIRPODS_5_CASE],
    images: [], createdAt: now - 2.89 * DAY
  },
  {
    id: 'airpods-pro-3', name: 'AirPods Pro 3', category: 'AirPods',
    price: 13000, discountPercent: 15, inStock: true,
    shortDesc: 'Шумодав вдвое сильнее, пульсометр, IP57.',
    description: 'Активное шумоподавление вдвое эффективнее, чем у AirPods Pro 2, встроенный датчик пульса для тренировок, живой перевод и функции слухового аппарата. До 8 часов с включённым шумодавом.',
    specs: 'Чип: H2\nШумоподавление: активное, вдвое сильнее предыдущего\nДатчик пульса: есть\nАвтономность: до 8 ч (24 ч с кейсом)\nЗащита: IP57\nЗарядка: USB-C, MagSafe, Qi\nАудио: Spatial Audio с отслеживанием головы\nПоддержка: слуховой аппарат, проверка слуха, живой перевод\nКомплект: 5 размеров амбушюр',
    colors: [{ name: 'Белый', hex: '#f5f5f5' }], storages: [],
    images: [], createdAt: now - 2.9 * DAY
  },
  {
    id: 'airpods-pro-2', name: 'AirPods Pro 2', category: 'AirPods',
    price: 12000, inStock: true,
    shortDesc: 'Чип H2, адаптивный звук, кейс USB-C, IP54.',
    description: 'Прошлое поколение Pro за половину цены нынешнего. Чип H2 с активным шумоподавлением и режимом адаптивного звука, функции слухового аппарата и проверки слуха, до 6 часов работы и кейс с USB-C, MagSafe и динамиком для поиска.',
    specs: 'Чип: H2\nШумоподавление: активное, адаптивный звук\nАвтономность: до 6 ч (30 ч с кейсом)\nЗащита: IP54\nЗарядка: USB-C, MagSafe, Qi, Apple Watch\nАудио: Spatial Audio с отслеживанием головы\nПоддержка: слуховой аппарат, проверка слуха, Voice Isolation\nУправление: сенсорное на ножке, громкость свайпом\nКомплект: 4 размера амбушюр',
    colors: [{ name: 'Белый', hex: '#f5f5f5' }], storages: [],
    images: [], createdAt: now - 2.95 * DAY
  },
  {
    // Обе версии AirPods 4 — одна карточка: у Apple это тоже один товар с
    // выбором «с шумоподавлением или без», а не две позиции в каталоге.
    // Базовая цена — версия без шумоподавления, доплата даёт прежние 17 990 ₽.
    id: 'airpods-4', name: 'AirPods 4', category: 'AirPods',
    price: 7875, discountPercent: 15, inStock: true,
    shortDesc: 'Чип H2, кейс USB-C — с шумоподавлением или без.',
    description: 'Обновлённая форма для удобной посадки, чип H2, пространственное аудио с отслеживанием головы и компактный кейс с USB-C. В версии с активным шумоподавлением добавляются адаптивный звук, живой перевод и кейс с беспроводной зарядкой и динамиком для поиска.',
    specs: 'Чип: H2\nШумоподавление: активное и адаптивный звук — в версии с шумоподавлением\nАвтономность: до 5 ч (20–30 ч с кейсом)\nЗащита: IP54\nЗарядка: USB-C, а в версии с шумоподавлением ещё Qi и Apple Watch\nАудио: Spatial Audio с отслеживанием головы\nПоддержка: проверка слуха, Voice Isolation, живой перевод\nДатчики: оптический, акселерометр\nСвязь: Bluetooth 5.3',
    colors: [{ name: 'Белый', hex: '#f5f5f5' }], storages: [],
    options: [AIRPODS_4_ANC],
    images: [], createdAt: now - 3 * DAY
  },
  {
    id: 'airpods-3', name: 'AirPods 3', category: 'AirPods',
    price: 7500, inStock: true,
    shortDesc: 'Открытая посадка, пространственное аудио, MagSafe.',
    description: 'Классические AirPods без амбушюр: ничего не давит в ухе и слышно, что происходит вокруг. Пространственное аудио с отслеживанием головы, адаптивный эквалайзер, защита от пота и воды и кейс с MagSafe.',
    specs: 'Чип: H1\nПосадка: открытая, без амбушюр\nАвтономность: до 6 ч (30 ч с кейсом)\nЗащита: IPX4\nЗарядка: Lightning, MagSafe, Qi\nАудио: Spatial Audio с отслеживанием головы, адаптивный эквалайзер\nМикрофоны: с формированием луча, датчик нажатия\nДатчики: оптический, акселерометр\nСвязь: Bluetooth 5.0',
    colors: [{ name: 'Белый', hex: '#f5f5f5' }], storages: [],
    images: [], createdAt: now - 3.1 * DAY
  },
  {
    id: 'airpods-max-2', name: 'AirPods Max 2', category: 'AirPods',
    price: 35250, discountPercent: 15, inStock: true,
    shortDesc: 'Полноразмерные, H2, Lossless по USB-C, 20 ч.',
    description: 'Полноразмерные наушники нового поколения: чип H2 в каждой чашке, шумоподавление в 1.5 раза сильнее, Lossless-аудио и минимальная задержка по USB-C. Пять цветов.',
    specs: 'Тип: полноразмерные\nЧип: H2 в каждой чашке\nШумоподавление: активное, в 1.5 раза сильнее\nАвтономность: до 20 ч\nЗарядка: USB-C\nАудио: Lossless и ультранизкая задержка по USB-C, Spatial Audio\nМикрофоны: 9 микрофонов\nПоддержка: живой перевод, Digital Crown\nВес: 386 г',
    colors: [C.midnight, C.starlight, C.blue, C.purple, { name: 'Оранжевый', hex: '#e8853c' }],
    storages: [],
    images: [], createdAt: now - 3.2 * DAY
  },
  {
    id: 'airpods-max', name: 'AirPods Max (USB-C)', category: 'AirPods',
    price: 33000, inStock: true,
    shortDesc: 'Полноразмерные, чип H1, USB-C, 20 ч, пять цветов.',
    description: 'Обновление 2024 года: те же полноразмерные наушники в алюминии и с амбушюрами из сетчатой ткани, но с разъёмом USB-C и в новых цветах. Активное шумоподавление, прозрачный режим и пространственное аудио с отслеживанием головы.',
    specs: 'Тип: полноразмерные\nЧип: H1 в каждой чашке\nШумоподавление: активное, прозрачный режим\nАвтономность: до 20 ч\nЗарядка: USB-C\nАудио: Spatial Audio с отслеживанием головы, адаптивный эквалайзер\nМикрофоны: 9 микрофонов\nУправление: Digital Crown, кнопка шумоподавления\nМатериал: алюминий, амбушюры из сетчатой ткани\nВес: 385 г',
    colors: [C.midnight, C.starlight, C.blue, C.purple, { name: 'Оранжевый', hex: '#e8853c' }],
    storages: [],
    images: [], createdAt: now - 3.3 * DAY
  },

  /* ========================= Apple TV и Дом ========================= */
  {
    id: 'apple-tv-4k', name: 'Apple TV 4K', category: 'Apple TV и Дом',
    price: 12990, discountPercent: 15, inStock: true,
    shortDesc: 'A17 Pro, 4K Dolby Vision, Siri Remote.',
    description: 'Кинематографичный опыт Apple на большом экране: чип A17 Pro с поддержкой Apple Intelligence, 4K HDR с Dolby Vision и Dolby Atmos, Wi-Fi 7 и пульт Siri Remote с USB-C.',
    specs: 'Чип: A17 Pro\nОЗУ: 8 ГБ\nПамять: 64 или 128 ГБ\nВидео: 4K HDR, Dolby Vision, HDR10+\nАудио: Dolby Atmos, поддержка HomePod как колонок\nПорты: HDMI 2.1, Ethernet (в версии 128 ГБ)\nСвязь: Wi-Fi 7, Bluetooth, Thread\nПоддержка: Siri Remote с USB-C',
    colors: [{ name: 'Чёрный', hex: '#1c1c1e' }], storages: ST.tv,
    images: [], createdAt: now - 3.3 * DAY
  },
  {
    id: 'homepod-2', name: 'HomePod (2-е поколение)', category: 'Apple TV и Дом',
    price: 32990, inStock: true,
    shortDesc: 'Объёмный звук, Spatial Audio, датчики дома.',
    description: 'Умная колонка с глубоким басом и высокими частотами кристальной чистоты. Пространственное аудио, распознавание акустики помещения, датчики температуры и влажности, хаб для умного дома.',
    specs: 'Тип: умная колонка\nАудио: высокочастотный твитер массив, Spatial Audio, room sensing\nМикрофоны: 4 микрофона дальнего действия\nДатчики: температура и влажность\nСвязь: Wi-Fi 6, Bluetooth 5, Thread, Matter\nПоддержка: Siri, стереопара, AirPlay\nРазмер: 16.8 см высота',
    colors: [{ name: 'Белый', hex: '#f2f1ee' }, C.midnight], storages: [],
    images: [], createdAt: now - 3.4 * DAY
  },
  {
    id: 'homepod-mini', name: 'HomePod mini', category: 'Apple TV и Дом',
    price: 11990, discountPercent: 15, inStock: true,
    shortDesc: 'Компактная колонка, пять цветов, Matter.',
    description: 'Удивительный звук для своего размера. Пять цветов, объёмное звучание на 360°, второе поколение чипа Ultra Wideband для передачи музыки с iPhone и полноценный хаб умного дома.',
    specs: 'Тип: компактная умная колонка\nАудио: полнодиапазонный драйвер, звук на 360°\nМикрофоны: 4 микрофона\nСвязь: Wi-Fi, Bluetooth, Thread, Matter, Ultra Wideband\nПоддержка: Siri, стереопара, Intercom\nРазмер: 8.4 см высота\nПитание: USB-C',
    colors: HOMEPOD_MINI, storages: [],
    images: [], createdAt: now - 3.5 * DAY
  },

  /* =============================== Vision =============================== */
  {
    id: 'vision-pro-m5', name: 'Apple Vision Pro (M5)', category: 'Vision',
    price: 349990, inStock: true,
    shortDesc: 'Пространственный компьютер: M5, микро-OLED.',
    description: 'Пространственный компьютер Apple: два дисплея micro-OLED с 23 миллионами пикселей, чип M5 в паре с R1, управление глазами, руками и голосом. В комплекте новый ремень Dual Knit.',
    specs: 'Экран: два micro-OLED, 23 млн пикселей\nЧип: Apple M5 и R1\nПамять: от 256 ГБ до 1 ТБ\nАвтономность: до 2.5 ч (внешний аккумулятор)\nДатчики: 12 камер, 5 сенсоров, 6 микрофонов\nАудио: Spatial Audio с трекингом головы\nСвязь: Wi-Fi 6E, Bluetooth\nПоддержка: Optic ID, управление взглядом и жестами',
    colors: [{ name: 'Белый', hex: '#f2f1ee' }], storages: ST.vision,
    options: [ZEISS_INSERTS],
    images: [], createdAt: now - 3.6 * DAY
  },

  /* ============================ Аксессуары ============================ */
  {
    // Одна метка и набор из четырёх — одна карточка с выбором комплекта.
    // Базовая цена — одна метка; набор доплатой выходит в прежние 11 990 ₽,
    // то есть дешевле четырёх штук по отдельности (13 960 ₽).
    id: 'airtag', name: 'AirTag', category: 'Аксессуары',
    price: 3490, inStock: true,
    shortDesc: 'Метка для поиска вещей: по одной или набором из четырёх.',
    description: 'Прикрепите AirTag к ключам или рюкзаку — и находите их через приложение «Локатор». Точный поиск с указанием направления, звуковой сигнал и год работы от сменной батарейки. Набор из четырёх меток обойдётся дешевле, чем четыре покупки по отдельности.',
    specs: 'Тип: поисковая метка\nКомплект: одна метка или набор из четырёх\nСвязь: Bluetooth, Ultra Wideband, NFC\nАвтономность: около года (батарейка CR2032, сменная)\nЗащита: IP67\nПоддержка: точный поиск, сеть «Локатор», уведомления о расставании\nАудио: встроенный динамик\nВес: 11 г',
    colors: [{ name: 'Белый', hex: '#f5f5f5' }], storages: [],
    options: [AIRTAG_PACK],
    images: [], createdAt: now - 3.7 * DAY
  },

  /* ------------------- Зарядка, кабели и переходники --------------------
   * Состав, описания и характеристики сняты со страниц товаров apple.com
   * (сентябрь 2026) скриптом `scripts/fetch-apple-product.js`; он же приносит
   * фотографии галереи. Цена — долларовая цена Apple по курсу 90 ₽/$ плюс 20 %,
   * округлённая вверх до ближайшего «…90». Скидки у этих карточек нет: цена
   * и так закупочная, а промоакция режет её процентом (см. lib/promo.js).
   */
  {
    id: 'usb-c-cable-60w-1m', name: 'Кабель USB-C для зарядки 60 Вт (1 м)', category: 'Аксессуары',
    price: 2090, inStock: true,
    shortDesc: 'Плетёный кабель USB-C — USB-C: зарядка до 60 Вт и передача данных.',
    description: 'Метровый кабель в плетёной оплётке с разъёмами USB-C на обоих концах — для зарядки, синхронизации и передачи данных между устройствами с USB-C. Держит зарядку мощностью до 60 Вт и передаёт данные на скорости USB 2. В паре с подходящим адаптером питания USB-C заряжает от розетки и поддерживает быструю зарядку. Адаптер питания приобретается отдельно.',
    specs: 'Разъёмы: USB-C и USB-C\nЗарядка: до 60 Вт\nПередача данных: USB 2, до 480 Мбит/с\nДлина: 1 м\nМатериал: плетёная оплётка\nПодключение: iPhone, iPad, Mac и другие устройства с USB-C',
    colors: [C.white], storages: [],
    images: [], createdAt: now - 3.8 * DAY
  },
  {
    id: 'usb-c-cable-240w-2m', name: 'Кабель USB-C для зарядки 240 Вт (2 м)', category: 'Аксессуары',
    price: 3190, inStock: true,
    shortDesc: 'Плетёный кабель USB-C — USB-C на два метра, зарядка до 240 Вт.',
    description: 'Двухметровый кабель в плетёной оплётке с разъёмами USB-C на обоих концах — для зарядки, синхронизации и передачи данных между устройствами с USB-C. Держит зарядку мощностью до 240 Вт, поэтому подходит и мощным ноутбукам, а данные передаёт на скорости USB 2. В паре с подходящим адаптером питания USB-C поддерживает быструю зарядку. Адаптер питания приобретается отдельно.',
    specs: 'Разъёмы: USB-C и USB-C\nЗарядка: до 240 Вт\nПередача данных: USB 2, до 480 Мбит/с\nДлина: 2 м\nМатериал: плетёная оплётка\nПодключение: MacBook Pro, iPad, iPhone и другие устройства с USB-C',
    colors: [C.white], storages: [],
    images: [], createdAt: now - 3.81 * DAY
  },
  {
    id: 'power-adapter-20w', name: 'Адаптер питания USB-C, 20 Вт', category: 'Аксессуары',
    price: 2090, inStock: true,
    shortDesc: 'Компактный адаптер для быстрой зарядки iPhone и iPad.',
    description: 'Адаптер питания Apple на 20 Вт быстро и экономно заряжает дома, в офисе и в дороге. С iPhone 8 и новее даёт быструю зарядку — до 50 % примерно за 35 минут, а с iPad Pro и iPad Air работает в оптимальном для них режиме. Кабель для зарядки приобретается отдельно.',
    specs: 'Питание: 20 Вт\nРазъём: USB-C\nБыстрая зарядка: до 50 % примерно за 35 минут (iPhone 8 и новее)\nПодключение: iPhone, iPad и другие устройства с USB-C\nРазмер: компактный корпус',
    colors: [C.white], storages: [],
    images: [], createdAt: now - 3.82 * DAY
  },
  {
    id: 'power-adapter-40w-dynamic', name: 'Адаптер питания Dynamic Power, 40 Вт (до 60 Вт)', category: 'Аксессуары',
    price: 4290, inStock: true,
    shortDesc: 'Карманный адаптер, который подаёт до 60 Вт, когда это нужно.',
    description: 'Адаптер выдаёт до 60 Вт, когда устройству нужен запас мощности, и остаётся при этом карманного размера. С iPhone 17, iPhone 17 Pro и iPhone 17 Pro Max заряжает до 50 % за 20 минут, с iPhone Air — за 30 минут, с iPad Pro 11″ — за 30 минут, с iPad Pro 13″ — за 35 минут. Подходит устройствам с USB-C; кабель для зарядки приобретается отдельно.',
    specs: 'Питание: 40 Вт, динамически до 60 Вт\nРазъём: USB-C\nБыстрая зарядка: до 50 % за 20 минут (iPhone 17 Pro)\nПодключение: iPhone, iPad и другие устройства с USB-C\nРазмер: карманный корпус',
    colors: [C.white], storages: [],
    images: [], createdAt: now - 3.83 * DAY
  },
  {
    id: 'power-adapter-35w-dual', name: 'Компактный адаптер питания с двумя портами USB-C, 35 Вт', category: 'Аксессуары',
    price: 6390, inStock: true,
    shortDesc: 'Два порта USB-C: заряжает два устройства одновременно.',
    description: 'Компактный адаптер на 35 Вт заряжает два устройства сразу — дома, в офисе и в дороге. Apple рекомендует его для MacBook Neo и MacBook Air, когда нужен второй порт; подходит он и для iPhone, iPad, Apple Watch и AirPods. Кабели для зарядки приобретаются отдельно.',
    specs: 'Питание: 35 Вт на два порта\nРазъёмы: два USB-C\nПодключение: MacBook Neo, MacBook Air, iPhone, iPad, Apple Watch, AirPods\nРазмер: компактный корпус',
    colors: [C.white], storages: [],
    images: [], createdAt: now - 3.84 * DAY
  },
  {
    id: 'magsafe-3-cable-2m', name: 'Кабель USB-C / MagSafe 3 (2 м)', category: 'Аксессуары',
    price: 5390, inStock: true,
    shortDesc: 'Магнитный кабель зарядки для ноутбуков Mac, плетёная оплётка.',
    description: 'Двухметровый кабель с магнитным разъёмом MagSafe 3: он сам подводит штекер к разъёму ноутбука Mac. Магнит держит крепко, но отсоединяется, если кто-то заденет провод, — ноутбук остаётся на месте. Индикатор горит янтарным во время зарядки и зелёным, когда аккумулятор заряжен. Плетёная оплётка рассчитана на долгую службу. Адаптер питания USB-C приобретается отдельно.',
    // «Крепление: магнитное…» здесь не написать: слово «магнитный» содержит «нит»,
    // и подбор иконки уводит строку в правило яркости («600 нит») — рядом с кабелем
    // это глиф солнца. Поэтому про магнит сказано ключом «Разъём».
    specs: 'Разъёмы: USB-C и MagSafe 3\nРазъём MagSafe 3: держит крепко и отходит при рывке\nИндикатор: янтарный при зарядке, зелёный при полном заряде\nДлина: 2 м\nМатериал: плетёная оплётка\nПодключение: ноутбуки Mac с разъёмом MagSafe 3',
    colors: [C.silver], storages: [],
    images: [], createdAt: now - 3.85 * DAY
  },
  {
    id: 'power-adapter-140w', name: 'Адаптер питания USB-C, 140 Вт', category: 'Аксессуары',
    price: 10790, inStock: true,
    shortDesc: 'Самый мощный адаптер Apple — для MacBook Pro 16″.',
    description: 'Адаптер на 140 Вт быстро и экономно заряжает дома, в офисе и в дороге и совместим с большинством устройств и кабелей USB-C. Apple рекомендует его для MacBook Pro 16″ (2021 года и новее) в паре с кабелем USB-C / MagSafe 3 или кабелем USB-C на 240 Вт: до 50 % заряда примерно за 30 минут. Кабель для зарядки приобретается отдельно.',
    specs: 'Питание: 140 Вт\nРазъём: USB-C\nБыстрая зарядка: до 50 % примерно за 30 минут (MacBook Pro 16″)\nПодключение: MacBook Pro, MacBook Air и другие устройства с USB-C',
    colors: [C.white], storages: [],
    images: [], createdAt: now - 3.86 * DAY
  },
  {
    id: 'power-adapter-96w', name: 'Адаптер питания USB-C, 96 Вт', category: 'Аксессуары',
    price: 8590, inStock: true,
    shortDesc: 'Мощный адаптер для MacBook Pro 14″ и других устройств с USB-C.',
    description: 'Адаптер на 96 Вт быстро и экономно заряжает дома, в офисе и в дороге и совместим с большинством устройств и кабелей USB-C. Apple рекомендует его для MacBook Pro 14″ (2021 года и новее) в паре с кабелем USB-C / MagSafe 3 или кабелем USB-C для зарядки: до 50 % заряда примерно за 30 минут. Кабель для зарядки приобретается отдельно.',
    specs: 'Питание: 96 Вт\nРазъём: USB-C\nБыстрая зарядка: до 50 % примерно за 30 минут (MacBook Pro 14″)\nПодключение: MacBook Pro, MacBook Air и другие устройства с USB-C',
    colors: [C.white], storages: [],
    images: [], createdAt: now - 3.87 * DAY
  },
  {
    id: 'usb-c-to-usb-adapter', name: 'Адаптер USB-C / USB', category: 'Аксессуары',
    price: 2090, inStock: true,
    shortDesc: 'Подключает обычные USB-аксессуары к порту USB-C.',
    description: 'Переходник подключает привычные USB-аксессуары к Mac, iPad или iPhone с портом USB-C либо Thunderbolt 3 (USB-C). Вставьте его в порт USB-C — и подключайте флешку, камеру или другое USB-устройство. Через него же работает кабель Lightning / USB для синхронизации и зарядки iPhone, iPad и iPod.',
    specs: 'Разъёмы: USB-C и USB (Type-A)\nПодключение: Mac, iPad и iPhone с портом USB-C или Thunderbolt 3\nНазначение: флешки, камеры и другие устройства USB\nРазмер: компактный переходник',
    colors: [C.white], storages: [],
    images: [], createdAt: now - 3.88 * DAY
  },
  {
    id: 'usb-c-digital-av-adapter', name: 'Многопортовый цифровой AV-адаптер USB-C', category: 'Аксессуары',
    price: 7490, inStock: true,
    shortDesc: 'HDMI, USB и зарядка через USB-C — три порта в одном переходнике.',
    description: 'Адаптер выводит изображение с Mac, iPad или iPhone на телевизор или монитор с HDMI и одновременно даёт порт USB для аксессуара и порт USB-C для зарядки. С iPhone 15 и новее, iPad Pro и iPad Air на чипах Apple и с большинством современных Mac поддерживает 3840×2160 при 60 Гц; с более ранними моделями — 1080p при 60 Гц или 3840×2160 при 30 Гц. Кабель HDMI приобретается отдельно.',
    specs: 'Разъёмы: HDMI, USB и USB-C\nВидео: 4K (3840×2160) при 60 кадрах/с\nПитание: сквозная зарядка через порт USB-C\nПодключение: Mac, iPad и iPhone с портом USB-C\nСистема: macOS 10.14.6 и новее, iOS 12.4 и новее',
    colors: [C.white], storages: [],
    images: [], createdAt: now - 3.89 * DAY
  },
  {
    id: 'thunderbolt-3-to-2-adapter', name: 'Адаптер Thunderbolt 3 (USB-C) / Thunderbolt 2', category: 'Аксессуары',
    price: 5390, inStock: true,
    shortDesc: 'Подключает устройства Thunderbolt 2 к портам Thunderbolt 3 и USB 4.',
    description: 'Переходник подключает устройства Thunderbolt и Thunderbolt 2 — внешние диски, док-станции — к портам Thunderbolt 3 (USB-C) и USB 4 на Mac. Работает в обе стороны: устройства Thunderbolt 3 подключаются к Mac с портом Thunderbolt или Thunderbolt 2 на macOS Sierra и новее. Дисплеи Thunderbolt тоже поддерживаются, но Apple Thunderbolt Display потребует отдельного питания. Мониторы DisplayPort и Mini DisplayPort адаптер не поддерживает.',
    specs: 'Разъёмы: Thunderbolt 3 (USB-C) и Thunderbolt 2\nПередача данных: Thunderbolt 2, до 20 Гбит/с\nПодключение: внешние диски, док-станции и дисплеи Thunderbolt\nСистема: macOS Sierra и новее\nРазмер: компактный переходник',
    colors: [C.white], storages: [],
    images: [], createdAt: now - 3.9 * DAY
  },
  {
    id: 'usb-c-lightning-cable-1m', name: 'Кабель USB-C / Lightning (1 м)', category: 'Аксессуары',
    price: 2090, inStock: true,
    shortDesc: 'Метровый кабель для зарядки и синхронизации устройств с Lightning.',
    description: 'Кабель соединяет устройство с разъёмом Lightning с компьютером или iPad, у которых есть порт USB-C либо Thunderbolt 3 (USB-C), — для синхронизации и зарядки. В паре с адаптером питания Apple USB-C на 18, 20, 29, 30, 61, 87 или 96 Вт заряжает iPhone и iPad, а на подходящих моделях поддерживает быструю зарядку.',
    specs: 'Разъёмы: USB-C и Lightning\nБыстрая зарядка: с адаптером питания USB-C от 18 Вт\nДлина: 1 м\nПодключение: iPhone, iPad и другие устройства с разъёмом Lightning',
    colors: [C.white], storages: [],
    images: [], createdAt: now - 3.91 * DAY
  },
  {
    id: 'usb-c-lightning-cable-2m', name: 'Кабель USB-C / Lightning (2 м)', category: 'Аксессуары',
    price: 3190, inStock: true,
    shortDesc: 'Двухметровый кабель для зарядки и синхронизации устройств с Lightning.',
    description: 'Кабель соединяет устройство с разъёмом Lightning с компьютером или iPad, у которых есть порт USB-C либо Thunderbolt 3 (USB-C), — для синхронизации и зарядки. Двух метров хватает, чтобы дотянуться до розетки за диваном или за столом. В паре с адаптером питания Apple USB-C на 18, 20, 29, 30, 61, 87 или 96 Вт поддерживает быструю зарядку на подходящих моделях.',
    specs: 'Разъёмы: USB-C и Lightning\nБыстрая зарядка: с адаптером питания USB-C от 18 Вт\nДлина: 2 м\nПодключение: iPhone, iPad и другие устройства с разъёмом Lightning',
    colors: [C.white], storages: [],
    images: [], createdAt: now - 3.92 * DAY
  },
  {
    id: 'lightning-usb-cable-1m', name: 'Кабель Lightning / USB (1 м)', category: 'Аксессуары',
    price: 2090, inStock: true,
    shortDesc: 'Классический кабель Lightning — USB для зарядки и синхронизации.',
    description: 'Кабель USB 2 соединяет устройство с разъёмом Lightning с портом USB компьютера — для синхронизации и зарядки. Его же можно подключить к адаптеру питания Apple и заряжать от розетки. Разъём Lightning двусторонний: вставляется любой стороной.',
    specs: 'Разъёмы: Lightning и USB (Type-A)\nПередача данных: USB 2, до 480 Мбит/с\nДлина: 1 м\nПодключение: iPhone, iPad и iPod с разъёмом Lightning\nОсобенность: двусторонний разъём Lightning',
    colors: [C.white], storages: [],
    images: [], createdAt: now - 3.93 * DAY
  },

  /* ---------------------- Чехлы и защита для iPhone ---------------------
   * Собираются фабриками CASE выше: тексты у всех моделей одни и те же, разное
   * только имя модели и набор расцветок. Каждая расцветка у Apple — отдельный
   * товар, у нас — цвет внутри карточки; снимки привязаны к цвету заливкой
   * (scripts/import-product-photos.js по списку scripts/apple-iphone-cases.txt).
   */
  CASE.techwoven('case-techwoven-17-pro-max', 'iPhone 17 Pro Max', cc('green', 'black', 'blue', 'purple', 'sienna'), 6390, 4.00),
  CASE.techwoven('case-techwoven-17-pro', 'iPhone 17 Pro', cc('purple', 'green', 'blue', 'black', 'sienna'), 6390, 4.01),
  CASE.silicone('case-silicone-17-pro-max', 'iPhone 17 Pro Max', cc('orange', 'black', 'terracotta', 'purplefog', 'brightguava', 'midnight', 'vanilla'), 5390, 4.02),
  CASE.silicone('case-silicone-17', 'iPhone 17', cc('brightguava', 'lightmoss', 'vanilla', 'black', 'purplefog', 'anchorblue', 'electriclavender'), 5390, 4.03),
  CASE.silicone('case-silicone-17-pro', 'iPhone 17 Pro', cc('orange', 'black', 'vanilla', 'terracotta', 'brightguava', 'purplefog', 'midnight'), 5390, 4.04),
  CASE.clear('case-clear-17-pro-max', 'iPhone 17 Pro Max', 5390, 4.05),
  CASE.clear('case-clear-17-pro', 'iPhone 17 Pro', 5390, 4.06),
  CASE.clear('case-clear-17', 'iPhone 17', 5390, 4.07),
  CASE.airCase('case-air', 'iPhone Air', cc('shadow', 'frost'), 5390, 4.08),
  CASE.bumper('bumper-air', 'iPhone Air', cc('lightblue', 'lightgray', 'black', 'tan'), 4290, 4.09),
  CASE.silicone('case-silicone-17e', 'iPhone 17e', cc('softpink', 'brightguava', 'vanilla', 'black', 'lightmoss', 'anchorblue'), 5390, 4.10),
  CASE.clear('case-clear-17e', 'iPhone 17e', 5390, 4.11),
  CASE.silicone('case-silicone-16', 'iPhone 16', cc('ultramarine', 'periwinkle', 'black', 'plum', 'aquamarine', 'starfruit', 'denim', 'fuchsia', 'tangerine', 'lakegreen'), 5390, 4.12),
  CASE.silicone('case-silicone-16-plus', 'iPhone 16 Plus', cc('lakegreen', 'tangerine', 'black', 'periwinkle', 'stonegray', 'starfruit', 'aquamarine', 'denim', 'ultramarine', 'plum', 'fuchsia'), 5390, 4.13),
  CASE.silicone('case-silicone-16-pro', 'iPhone 16 Pro', cc('denim', 'fuchsia', 'tangerine', 'aquamarine', 'peony', 'black', 'plum', 'stonegray', 'periwinkle', 'lakegreen'), 5390, 4.14),
  CASE.silicone('case-silicone-16-pro-max', 'iPhone 16 Pro Max', cc('black', 'ultramarine', 'stonegray', 'peony', 'aquamarine', 'plum', 'tangerine', 'lakegreen', 'periwinkle', 'denim'), 5390, 4.15),
  CASE.clear('case-clear-16', 'iPhone 16', 5390, 4.16),
  CASE.clear('case-clear-16-plus', 'iPhone 16 Plus', 5390, 4.17),
  CASE.clear('case-clear-16-pro-max', 'iPhone 16 Pro Max', 5390, 4.18),
  CASE.clear('case-clear-16-pro', 'iPhone 16 Pro', 5390, 4.19),
  CASE.siliconePlain('case-silicone-16e', 'iPhone 16e', cc('neonyellow', 'fuchsia', 'black', 'winterblue', 'white', 'lakegreen'), 4290, 4.20),
  CASE.silicone('case-silicone-14-plus', 'iPhone 14 Plus', cc('chalkpink', 'midnight', 'productred'), 5390, 4.21),
  CASE.silicone('case-silicone-14', 'iPhone 14', cc('chalkpink', 'productred', 'stormblue', 'midnight'), 5390, 4.22),
  CASE.silicone('case-silicone-15-pro-max', 'iPhone 15 Pro Max', cc('stormblue', 'lightpink'), 5390, 4.23),
  CASE.silicone('case-silicone-15', 'iPhone 15', cc('lightpink', 'clay', 'black', 'stormblue'), 5390, 4.24),
  CASE.silicone('case-silicone-15-plus', 'iPhone 15 Plus', cc('clay', 'black', 'lightpink', 'stormblue'), 5390, 4.25),
  CASE.clear('case-clear-14-plus', 'iPhone 14 Plus', 5390, 4.26),
  CASE.clear('case-clear-14', 'iPhone 14', 5390, 4.27),
  CASE.clear('case-clear-15', 'iPhone 15', 5390, 4.28),
  CASE.clear('case-clear-15-plus', 'iPhone 15 Plus', 5390, 4.29),
  CASE.glass('glass-belkin-17-pro', 'iPhone 17 Pro', 4390, 4.30),
  CASE.glass('glass-belkin-air', 'iPhone Air', 4390, 4.31),
  CASE.glass('glass-belkin-17-pro-max', 'iPhone 17 Pro Max', 4390, 4.32),
  CASE.glass('glass-belkin-17', 'iPhone 17', 4390, 4.33),
  CASE.glass('glass-belkin-16-pro-max', 'iPhone 16 Pro Max', 4390, 4.34),
  CASE.glass('glass-belkin-17e', 'iPhone 17e', 4390, 4.35),
  CASE.glassPrivacy('glass-belkin-privacy-17-pro', 'iPhone 17 Pro', 4890, 4.36),
  CASE.glassPrivacy('glass-belkin-privacy-air', 'iPhone Air', 4890, 4.37),
  CASE.glassPrivacy('glass-belkin-privacy-17', 'iPhone 17', 4890, 4.38),
  CASE.glassPrivacy('glass-belkin-privacy-17-pro-max', 'iPhone 17 Pro Max', 4890, 4.39),
  CASE.glassPrivacy('glass-belkin-privacy-17e', 'iPhone 17e', 4890, 4.40),
  CASE.glass('glass-belkin-16', 'iPhone 16', 4390, 4.41),
  CASE.glass('glass-belkin-16-plus', 'iPhone 16 Plus', 4390, 4.42),
];

// Товары, которых может не быть в живом каталоге, — их доливает `node add-novinki.js`.
// Это не только свежие релизы: прошлые поколения, добавленные в catalog.js после
// первого запуска, попадают на витрину тем же способом.
const NOVELTY_IDS = [
  'iphone-duo', 'iphone-18-pro-max', 'iphone-18-pro',
  'watch-series-12-alu', 'watch-series-12-titan', 'watch-series-12-ceramic',
  'watch-ultra-4', 'airpods-5',
  'iphone-17-pro-max', 'iphone-17-pro', 'iphone-air', 'iphone-17', 'iphone-17e',
  'iphone-16-pro-max', 'iphone-16-pro', 'iphone-16-plus', 'iphone-16e',
  'iphone-15-pro-max', 'iphone-15-pro', 'iphone-15-plus', 'iphone-15',
  'macbook-neo', 'macbook-air-13-m5', 'macbook-air-15-m5', 'macbook-pro-14-m5', 'macbook-pro-16-m5-pro',
  'imac-m5', 'mac-mini-m5', 'mac-studio-m5-max', 'studio-display-xdr',
  'ipad-pro-13-m5', 'ipad-pro-11-m5',
  'watch-series-11-alu', 'watch-series-11-titan', 'watch-series-10',
  'watch-ultra-3', 'watch-ultra-2', 'watch-se-3',
  'airpods-pro-3', 'airpods-pro-2', 'airpods-4', 'airpods-3',
  'airpods-max-2', 'airpods-max',
  'apple-tv-4k', 'homepod-mini', 'vision-pro-m5',
  'usb-c-cable-60w-1m', 'usb-c-cable-240w-2m', 'power-adapter-20w', 'power-adapter-40w-dynamic',
  'power-adapter-35w-dual', 'magsafe-3-cable-2m', 'power-adapter-140w', 'power-adapter-96w',
  'usb-c-to-usb-adapter', 'usb-c-digital-av-adapter', 'thunderbolt-3-to-2-adapter',
  'usb-c-lightning-cable-1m', 'usb-c-lightning-cable-2m', 'lightning-usb-cable-1m',
  'case-techwoven-17-pro-max', 'case-techwoven-17-pro', 'case-silicone-17-pro-max',
  'case-silicone-17', 'case-silicone-17-pro', 'case-clear-17-pro-max',
  'case-clear-17-pro', 'case-clear-17', 'case-air',
  'bumper-air', 'case-silicone-17e', 'case-clear-17e',
  'case-silicone-16', 'case-silicone-16-plus', 'case-silicone-16-pro',
  'case-silicone-16-pro-max', 'case-clear-16', 'case-clear-16-plus',
  'case-clear-16-pro-max', 'case-clear-16-pro', 'case-silicone-16e',
  'case-silicone-14-plus', 'case-silicone-14', 'case-silicone-15-pro-max',
  'case-silicone-15', 'case-silicone-15-plus', 'case-clear-14-plus',
  'case-clear-14', 'case-clear-15', 'case-clear-15-plus',
  'glass-belkin-17-pro', 'glass-belkin-air', 'glass-belkin-17-pro-max',
  'glass-belkin-17', 'glass-belkin-16-pro-max', 'glass-belkin-17e',
  'glass-belkin-privacy-17-pro', 'glass-belkin-privacy-air', 'glass-belkin-privacy-17',
  'glass-belkin-privacy-17-pro-max', 'glass-belkin-privacy-17e', 'glass-belkin-16',
  'glass-belkin-16-plus'
];

/* ЦЕНЫ ВЫШЕ ЗАПИСАНЫ ТАК, КАК ИХ ДАЁТ ПРАЙС ПОСТАВЩИКА, — то есть то, за что
 * товар продаётся при работающей промоакции. Модель хранит другое: `price` —
 * цена БЕЗ скидки, а процент срезает промокод (см. lib/discount.js). Перевод и
 * делается здесь, обратным ходом «цена ÷ (1 − процент)», — вместе с доплатами
 * за память, ремешки и доп. характеристики: иначе дорогая сборка после скидки
 * стоила бы дешевле, чем в прайсе.
 *
 * Почему перевод, а не переписанные числа: наборы `ST`, `OPT` и `BANDS` ОБЩИЕ у
 * нескольких товаров, а скидка у каждого своя — подняв доплату в самом наборе,
 * мы подняли бы её и у товара без скидки. Поэтому наборы клонируются на каждый
 * товар, а числа в файле остаются прайсовыми: их и сверяют с прайсом.
 */
const DISCOUNT = require('./lib/discount');

function fullPriced(p) {
  const pct = Number(p && p.discountPercent) || 0;
  if (!(pct > 0)) return p;
  const up = (n) => DISCOUNT.compareFor(Number(n) || 0, pct) || 0;
  const out = Object.assign({}, p, { price: up(p.price) });
  if (p.storages) out.storages = p.storages.map(s => Object.assign({}, s, { add: up(s.add) }));
  if (p.options) {
    out.options = p.options.map(g => Object.assign({}, g, {
      values: (g.values || []).map(v => Object.assign({}, v, { add: up(v.add) }))
    }));
  }
  if (p.bands) {
    out.bands = p.bands.map(g => Object.assign({}, g, {
      sizes: (g.sizes || []).map(x => Object.assign({}, x, { add: up(x.add) })),
      options: (g.options || []).map(o => Object.assign({}, o, { add: up(o.add) }))
    }));
  }
  return out;
}

module.exports = { products: products.map(fullPriced), NOVELTY_IDS, colors: C, DAY, now };
