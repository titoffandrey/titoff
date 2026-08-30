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
    id: 'iphone-17-pro-max', name: 'iPhone 17 Pro Max', category: 'iPhone',
    price: 67990, discountPercent: 6, inStock: true,
    shortDesc: 'A19 Pro, три камеры 48 Мп, 6.9", до 39 ч видео.',
    description: 'Самый мощный iPhone. Чип A19 Pro с 6-ядерным GPU и паровой камерой охлаждения, три камеры по 48 Мп с 8-кратным оптическим зумом и рекордная автономность — до 39 часов видео. Цельный корпус из кованого алюминия, Ceramic Shield 2 спереди и Ceramic Shield сзади.',
    specs: 'Экран: 6.9" Super Retina XDR, ProMotion 120 Гц, до 3000 нит\nЧип: A19 Pro, 6-ядерный GPU\nКамеры: 48 Мп Fusion + 48 Мп СШУ + 48 Мп теле, зум 8×\nФронталка: 18 Мп Center Stage\nАвтономность: до 39 ч видео\nПамять: от 256 ГБ до 2 ТБ\nМатериал: кованый алюминий, Ceramic Shield 2\nЗащита: IP68\nКнопки: Действие\nCamera Control: быстрый доступ к съёмке\nРазъём: USB-C 3 (10 Гбит/с)\nСвязь: 5G, Wi-Fi 7\nСистема: iOS 26 с Apple Intelligence',
    colors: IPHONE_17_PRO, storages: ST.ph17pm,
    options: [OPT.sim(8500)],
    images: [], createdAt: now - 0.2 * DAY
  },
  {
    id: 'iphone-17-pro', name: 'iPhone 17 Pro', category: 'iPhone',
    price: 66990, discountPercent: 13, inStock: true,
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
    price: 51990, discountPercent: 9, inStock: true,
    shortDesc: 'A19, ProMotion 120 Гц, две камеры 48 Мп.',
    description: 'Впервые в базовой модели — ProMotion 120 Гц и стартовая память 256 ГБ. Чип A19, две камеры по 48 Мп, до 30 часов видео и Ceramic Shield 2 с втрое лучшей стойкостью к царапинам.',
    specs: 'Экран: 6.3" Super Retina XDR, ProMotion 120 Гц\nЧип: A19, 5-ядерный GPU\nКамеры: 48 Мп Dual Fusion + 48 Мп СШУ\nФронталка: 18 Мп Center Stage\nАвтономность: до 30 ч видео\nПамять: 256 или 512 ГБ\nМатериал: алюминий, Ceramic Shield 2\nЗащита: IP68\nКнопки: Действие\nCamera Control: быстрый доступ к съёмке\nРазъём: USB-C\nСвязь: 5G, Wi-Fi 7\nСистема: iOS 26 с Apple Intelligence',
    colors: IPHONE_17, storages: ST.ph17,
    options: [OPT.sim(1500)],
    images: [], createdAt: now - 0.5 * DAY
  },
  {
    id: 'iphone-17e', name: 'iPhone 17e', category: 'iPhone',
    price: 54990, discountPercent: 8, inStock: true,
    shortDesc: 'A19, камера 48 Мп, 6.1" — доступный iPhone.',
    description: 'Максимум возможностей за минимальные деньги: чип A19 с поддержкой Apple Intelligence, камера 48 Мп Fusion с 2-кратным оптическим зумом, кнопка «Действие» и стартовая память 256 ГБ.',
    specs: 'Экран: 6.1" Super Retina XDR\nЧип: A19\nКамера: 48 Мп Fusion Main, зум 2×\nФронталка: 12 Мп TrueDepth\nАвтономность: до 26 ч видео\nПамять: 256 или 512 ГБ\nМатериал: алюминий, Ceramic Shield 2\nЗащита: IP68\nКнопки: Действие\nРазъём: USB-C\nСвязь: 5G\nСистема: iOS 26 с Apple Intelligence',
    colors: IPHONE_17E, storages: ST.ph256s,
    options: [OPT.sim(3000)],
    images: [], createdAt: now - 0.6 * DAY
  },
  {
    id: 'iphone-16-pro-max', name: 'iPhone 16 Pro Max', category: 'iPhone',
    price: 76990, discountPercent: 14, inStock: true,
    shortDesc: 'A18 Pro, титан, 6.9", зум 5×, до 33 ч видео.',
    description: 'Флагман прошлого поколения по цене без переплаты за новизну. Титановый корпус 6.9", чип A18 Pro, тройная камера с 48 Мп Fusion и 5-кратным тетрапризменным зумом, съёмка 4K120 в Dolby Vision и до 33 часов видео.',
    specs: 'Экран: 6.9" Super Retina XDR, ProMotion 120 Гц, до 2000 нит\nЧип: A18 Pro, 6-ядерный GPU\nКамеры: 48 Мп Fusion + 48 Мп СШУ + 12 Мп теле, зум 5×\nФронталка: 12 Мп TrueDepth\nАвтономность: до 33 ч видео\nПамять: от 256 ГБ до 1 ТБ\nМатериал: титан, Ceramic Shield\nЗащита: IP68\nКнопки: Действие\nCamera Control: быстрый доступ к съёмке\nРазъём: USB-C 3 (10 Гбит/с)\nСвязь: 5G, Wi-Fi 7\nСистема: iOS 26 с Apple Intelligence',
    colors: IPHONE_16_PRO, storages: ST.ph256,
    options: [OPT.sim(5000)],
    images: [], createdAt: now - 0.9 * DAY
  },
  {
    id: 'iphone-16-pro', name: 'iPhone 16 Pro', category: 'iPhone',
    price: 68990, discountPercent: 14, inStock: true,
    shortDesc: 'A18 Pro, титан, 6.3", зум 5×.',
    description: 'Компактный Pro в титановом корпусе: чип A18 Pro, три камеры с 48 Мп Fusion и 5-кратным зумом, кнопка Camera Control и до 27 часов видео.',
    specs: 'Экран: 6.3" Super Retina XDR, ProMotion 120 Гц, до 2000 нит\nЧип: A18 Pro, 6-ядерный GPU\nКамеры: 48 Мп Fusion + 48 Мп СШУ + 12 Мп теле, зум 5×\nФронталка: 12 Мп TrueDepth\nАвтономность: до 27 ч видео\nПамять: от 128 ГБ до 1 ТБ\nМатериал: титан, Ceramic Shield\nЗащита: IP68\nКнопки: Действие\nCamera Control: быстрый доступ к съёмке\nРазъём: USB-C 3 (10 Гбит/с)\nСвязь: 5G, Wi-Fi 7\nСистема: iOS 26 с Apple Intelligence',
    colors: IPHONE_16_PRO, storages: ST.ph128p,
    options: [OPT.sim(5000)],
    images: [], createdAt: now - 0.95 * DAY
  },
  {
    id: 'iphone-16-plus', name: 'iPhone 16 Plus', category: 'iPhone',
    price: 63990, discountPercent: 11, inStock: true,
    shortDesc: 'A18, большой экран 6.7", до 27 ч видео.',
    description: 'Тот же iPhone 16, но с экраном 6.7" и самой большой батареей в линейке — до 27 часов видео. Чип A18 с Apple Intelligence, камера 48 Мп Fusion и кнопка Camera Control.',
    specs: 'Экран: 6.7" Super Retina XDR\nЧип: A18\nКамеры: 48 Мп Fusion + 12 Мп СШУ\nФронталка: 12 Мп TrueDepth\nАвтономность: до 27 ч видео\nПамять: от 128 до 512 ГБ\nМатериал: алюминий, Ceramic Shield\nЗащита: IP68\nКнопки: Действие\nCamera Control: быстрый доступ к съёмке\nРазъём: USB-C\nСвязь: 5G, Wi-Fi 7\nСистема: iOS 26 с Apple Intelligence',
    colors: IPHONE_16, storages: ST.ph128,
    options: [OPT.sim(4000)],
    images: [], createdAt: now - 0.98 * DAY
  },
  {
    id: 'iphone-16', name: 'iPhone 16', category: 'iPhone',
    price: 41990, discountPercent: 11, inStock: true,
    shortDesc: 'A18, две камеры, пять цветов.',
    description: 'Проверенный флагман прошлого поколения по сниженной цене. Чип A18 с поддержкой Apple Intelligence, камера 48 Мп Fusion, кнопка Camera Control и прочный корпус из алюминия.',
    specs: 'Экран: 6.1" Super Retina XDR\nЧип: A18\nКамеры: 48 Мп Fusion + 12 Мп СШУ\nФронталка: 12 Мп TrueDepth\nАвтономность: до 22 ч видео\nПамять: от 128 до 512 ГБ\nМатериал: алюминий, Ceramic Shield\nЗащита: IP68\nКнопки: Действие\nCamera Control: быстрый доступ к съёмке\nРазъём: USB-C\nСвязь: 5G, Wi-Fi 7\nСистема: iOS 26 с Apple Intelligence',
    colors: IPHONE_16, storages: ST.ph16,
    options: [OPT.sim(2000)],
    images: [], createdAt: now - 1 * DAY
  },
  {
    id: 'iphone-16e', name: 'iPhone 16e', category: 'iPhone',
    price: 41990, discountPercent: 7, inStock: true,
    shortDesc: 'A18, камера 48 Мп, до 26 ч видео — вход в линейку.',
    description: 'Самый доступный iPhone с Apple Intelligence. Чип A18, камера 48 Мп Fusion с 2-кратным оптическим зумом, кнопка «Действие» и собственный модем Apple C1, с которым автономность выросла до 26 часов видео.',
    specs: 'Экран: 6.1" Super Retina XDR\nЧип: A18\nКамера: 48 Мп Fusion Main, зум 2×\nФронталка: 12 Мп TrueDepth\nАвтономность: до 26 ч видео\nПамять: от 128 до 512 ГБ\nМатериал: алюминий, Ceramic Shield\nЗащита: IP68\nКнопки: Действие\nРазъём: USB-C\nСвязь: 5G, модем Apple C1\nСистема: iOS 26 с Apple Intelligence',
    colors: IPHONE_16E, storages: ST.ph128,
    options: [OPT.sim(3000)],
    images: [], createdAt: now - 1.1 * DAY
  },
  {
    id: 'iphone-15-pro-max', name: 'iPhone 15 Pro Max', category: 'iPhone',
    price: 41250, discountPercent: 13, inStock: true,
    shortDesc: 'A17 Pro, титан, 6.7", зум 5×, до 29 ч видео.',
    description: 'Первый iPhone из титана и первый с 5-кратным тетрапризменным зумом. Чип A17 Pro, кнопка «Действие» вместо переключателя звука, разъём USB-C и до 29 часов видео.',
    specs: 'Экран: 6.7" Super Retina XDR, ProMotion 120 Гц, до 2000 нит\nЧип: A17 Pro, 6-ядерный GPU\nКамеры: 48 Мп Main + 12 Мп СШУ + 12 Мп теле, зум 5×\nФронталка: 12 Мп TrueDepth\nАвтономность: до 29 ч видео\nПамять: от 256 ГБ до 1 ТБ\nМатериал: титан, Ceramic Shield\nЗащита: IP68\nКнопки: Действие\nРазъём: USB-C 3 (10 Гбит/с)\nСвязь: 5G, Wi-Fi 6E\nСистема: iOS 26',
    colors: IPHONE_15_PRO, storages: ST.ph15pm,
    options: [OPT.sim(5000)],
    images: [], createdAt: now - 1.2 * DAY
  },
  {
    id: 'iphone-15-pro', name: 'iPhone 15 Pro', category: 'iPhone',
    price: 33000, discountPercent: 12, inStock: true,
    shortDesc: 'A17 Pro, титан, 6.1", кнопка «Действие».',
    description: 'Самый лёгкий Pro за счёт титанового корпуса: 187 граммов. Чип A17 Pro, три камеры с 48 Мп Main и 3-кратным зумом, кнопка «Действие» и USB-C со скоростью до 10 Гбит/с.',
    specs: 'Экран: 6.1" Super Retina XDR, ProMotion 120 Гц, до 2000 нит\nЧип: A17 Pro, 6-ядерный GPU\nКамеры: 48 Мп Main + 12 Мп СШУ + 12 Мп теле, зум 3×\nФронталка: 12 Мп TrueDepth\nАвтономность: до 23 ч видео\nПамять: от 128 ГБ до 1 ТБ\nМатериал: титан, Ceramic Shield\nЗащита: IP68\nКнопки: Действие\nРазъём: USB-C 3 (10 Гбит/с)\nСвязь: 5G, Wi-Fi 6E\nСистема: iOS 26',
    colors: IPHONE_15_PRO, storages: ST.ph15pro,
    options: [OPT.sim(5000)],
    images: [], createdAt: now - 1.25 * DAY
  },
  {
    id: 'iphone-15-plus', name: 'iPhone 15 Plus', category: 'iPhone',
    price: 42000, discountPercent: 12, inStock: true,
    shortDesc: 'A16 Bionic, 6.7", камера 48 Мп, до 26 ч видео.',
    description: 'Большой экран 6.7" и запас автономности на два дня спокойного пользования. Камера 48 Мп с 2-кратным зумом без потери качества, Dynamic Island и разъём USB-C.',
    specs: 'Экран: 6.7" Super Retina XDR, Dynamic Island\nЧип: A16 Bionic\nКамеры: 48 Мп Main + 12 Мп СШУ, зум 2×\nФронталка: 12 Мп TrueDepth\nАвтономность: до 26 ч видео\nПамять: от 128 до 512 ГБ\nМатериал: алюминий, Ceramic Shield\nЗащита: IP68\nРазъём: USB-C\nСвязь: 5G, Wi-Fi 6\nСистема: iOS 26',
    colors: IPHONE_15, storages: ST.ph15plus,
    options: [OPT.sim(4000)],
    images: [], createdAt: now - 1.3 * DAY
  },
  {
    id: 'iphone-15', name: 'iPhone 15', category: 'iPhone',
    price: 26500, discountPercent: 7, inStock: true,
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
    price: 119990, discountPercent: 8, inStock: true,
    shortDesc: 'M5, 13.6", до 18 часов работы, 1.24 кг.',
    description: 'Тонкий, быстрый, мощный и портативный. Чип M5 с 10-ядерным CPU, безвентиляторная конструкция, до 18 часов автономной работы и вес всего 1.24 кг.',
    specs: 'Экран: 13.6" Liquid Retina, 500 нит\nЧип: Apple M5, 10-ядерный CPU\nОЗУ: 16 ГБ (до 32 ГБ)\nПамять: от 512 ГБ SSD\nАвтономность: до 18 ч\nВес: 1.24 кг\nПорты: 2× Thunderbolt 4, MagSafe 3, аудиоразъём\nКамера: 12 Мп Center Stage\nАудио: 4 динамика, Spatial Audio\nСвязь: Wi-Fi 7, Bluetooth 6\nГотов к ИИ: Apple Intelligence в macOS 26',
    colors: MB_AIR, storages: ST.air13,
    options: [PERF_AIR13, POWER_AIR],
    images: [], createdAt: now - 0.8 * DAY
  },
  {
    id: 'macbook-air-15-m5', name: 'MacBook Air 15" (M5)', category: 'Mac',
    price: 139990, discountPercent: 7, inStock: true,
    shortDesc: 'M5, большой экран 15.3", шесть динамиков.',
    description: 'Всё то же, что в 13-дюймовом Air, но с большим экраном 15.3" и системой из шести динамиков. Идеально, когда нужен простор для работы и кино.',
    specs: 'Экран: 15.3" Liquid Retina, 500 нит\nЧип: Apple M5, 10-ядерный CPU\nОЗУ: 16 ГБ (до 32 ГБ)\nПамять: от 512 ГБ SSD\nАвтономность: до 18 ч\nВес: 1.51 кг\nПорты: 2× Thunderbolt 4, MagSafe 3, аудиоразъём\nКамера: 12 Мп Center Stage\nАудио: 6 динамиков, Spatial Audio\nСвязь: Wi-Fi 7, Bluetooth 6\nГотов к ИИ: Apple Intelligence в macOS 26',
    colors: MB_AIR, storages: ST.air15,
    options: [RAM_AIR15, POWER_AIR],
    images: [], createdAt: now - 0.9 * DAY
  },
  {
    id: 'macbook-pro-14-m5', name: 'MacBook Pro 14" (M5)', category: 'Mac',
    price: 189990, discountPercent: 10, inStock: true,
    shortDesc: 'M5 / M5 Pro / M5 Max, Liquid Retina XDR 120 Гц.',
    description: 'Самый продвинутый ноутбук Mac для требовательных задач. Чипы M5, M5 Pro или M5 Max, дисплей Liquid Retina XDR с ProMotion 120 Гц, Thunderbolt 5 и до 24 часов автономной работы.',
    specs: 'Экран: 14.2" Liquid Retina XDR, 120 Гц, 1600 нит\nЧип: Apple M5 (до M5 Max)\nОЗУ: 16 ГБ (до 128 ГБ)\nПамять: от 1 ТБ SSD\nАвтономность: до 24 ч\nВес: 1.55 кг\nПорты: 3× Thunderbolt 5, HDMI, SDXC, MagSafe 3\nКамера: 12 Мп Center Stage\nАудио: 6 динамиков, 3 микрофона студийного качества\nСвязь: Wi-Fi 7, Bluetooth 6\nГотов к ИИ: Apple Intelligence в macOS 26',
    colors: MB_PRO, storages: ST.pro14,
    options: [CHIP_PRO14, RAM_PRO14, OPT.glass(13500), POWER_PRO14],
    images: [], createdAt: now - 1.1 * DAY
  },
  {
    id: 'macbook-pro-16-m5-pro', name: 'MacBook Pro 16" (M5 Pro)', category: 'Mac',
    price: 279990, discountPercent: 7, inStock: true,
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
    price: 74990, discountPercent: 6, inStock: true,
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
    price: 134990, discountPercent: 7, inStock: true,
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
    price: 104990, discountPercent: 9, inStock: true,
    shortDesc: 'M5, OLED 11", 5.3 мм, Apple Pencil Pro.',
    description: 'Компактный iPad Pro с чипом M5 и тандемным OLED-дисплеем Ultra Retina XDR. Толщина всего 5.3 мм при полной производительности Pro.',
    specs: 'Экран: 11" Ultra Retina XDR OLED, ProMotion 120 Гц\nЧип: Apple M5\nОЗУ: 12 ГБ\nПамять: от 256 ГБ до 2 ТБ\nКамера: 12 Мп + LiDAR\nФронталка: 12 Мп Center Stage\nАвтономность: до 10 ч\nТолщина: 5.3 мм\nРазъём: USB-C с Thunderbolt / USB 4\nПоддержка: Apple Pencil Pro, Magic Keyboard\nСвязь: Wi-Fi 7, 5G (опция)\nApple Intelligence: тексты, Genmoji, обновлённая Siri',
    colors: IPAD_PRO, storages: ST.pad256,
    options: [OPT.glass(15000, ['1 ТБ', '2 ТБ']), OPT.cellular(20000)],
    images: [], createdAt: now - 1.9 * DAY
  },
  {
    id: 'ipad-air-13-m4', name: 'iPad Air 13" (M4)', category: 'iPad',
    price: 79990, discountPercent: 11, inStock: true,
    shortDesc: 'M4, большой экран 13", четыре цвета.',
    description: 'Серьёзная производительность в тонком и легком корпусе. Чип M4, дисплей Liquid Retina 13", поддержка Apple Pencil Pro и клавиатуры Magic Keyboard.',
    specs: 'Экран: 13" Liquid Retina, 600 нит\nЧип: Apple M4\nОЗУ: 8 ГБ\nПамять: от 128 ГБ до 1 ТБ\nКамера: 12 Мп\nФронталка: 12 Мп Center Stage\nАвтономность: до 10 ч\nВес: 618 г\nРазъём: USB-C\nПоддержка: Apple Pencil Pro, Magic Keyboard\nСвязь: Wi-Fi 6E, 5G (опция)\nApple Intelligence: тексты, Genmoji, обновлённая Siri',
    colors: IPAD_AIR, storages: ST.padAir,
    options: [OPT.cellular(15000)],
    images: [], createdAt: now - 2 * DAY
  },
  {
    id: 'ipad-air-11-m4', name: 'iPad Air 11" (M4)', category: 'iPad',
    price: 55990, discountPercent: 7, inStock: true,
    shortDesc: 'M4, 11", лёгкий и универсальный.',
    description: 'Универсальный iPad для учёбы, работы и творчества: чип M4, дисплей Liquid Retina 11", поддержка Apple Pencil Pro и Apple Intelligence.',
    specs: 'Экран: 11" Liquid Retina, 500 нит\nЧип: Apple M4\nОЗУ: 8 ГБ\nПамять: от 128 ГБ до 1 ТБ\nКамера: 12 Мп\nФронталка: 12 Мп Center Stage\nАвтономность: до 10 ч\nВес: 460 г\nРазъём: USB-C\nПоддержка: Apple Pencil Pro, Magic Keyboard\nСвязь: Wi-Fi 6E, 5G (опция)\nApple Intelligence: тексты, Genmoji, обновлённая Siri',
    colors: IPAD_AIR, storages: ST.padAir,
    options: [OPT.cellular(15000)],
    images: [], createdAt: now - 2.1 * DAY
  },
  {
    id: 'ipad-a16', name: 'iPad (A16)', category: 'iPad',
    price: 34990, discountPercent: 10, inStock: true,
    shortDesc: 'A16, 11", четыре цвета — самый доступный iPad.',
    description: 'Красочный iPad для повседневных дел. Чип A16, дисплей Liquid Retina 11", поддержка Apple Pencil (USB-C) и целый день автономной работы.',
    specs: 'Экран: 11" Liquid Retina, 500 нит\nЧип: Apple A16\nПамять: от 128 до 512 ГБ\nКамера: 12 Мп\nФронталка: 12 Мп Center Stage\nАвтономность: до 10 ч\nВес: 477 г\nРазъём: USB-C\nПоддержка: Apple Pencil (USB-C)\nСвязь: Wi-Fi 6, 5G (опция)',
    colors: IPAD_11, storages: ST.pad128,
    options: [OPT.cellular(12000)],
    images: [], createdAt: now - 2.2 * DAY
  },
  {
    id: 'ipad-mini-a17-pro', name: 'iPad mini (A17 Pro)', category: 'iPad',
    price: 49990, discountPercent: 9, inStock: true,
    shortDesc: 'A17 Pro, 8.3" — весь iPad в кармане.',
    description: 'Полноценный iPad в ультрапортативном формате. Чип A17 Pro с поддержкой Apple Intelligence, дисплей 8.3" и поддержка Apple Pencil Pro.',
    specs: 'Экран: 8.3" Liquid Retina, 500 нит\nЧип: Apple A17 Pro\nПамять: от 128 до 512 ГБ\nКамера: 12 Мп\nФронталка: 12 Мп Center Stage\nАвтономность: до 10 ч\nВес: 293 г\nРазъём: USB-C\nПоддержка: Apple Pencil Pro\nСвязь: Wi-Fi 6E, 5G (опция)\nApple Intelligence: тексты, Genmoji, обновлённая Siri',
    colors: IPAD_AIR, storages: ST.pad128,
    options: [OPT.cellular(15000)],
    images: [], createdAt: now - 2.3 * DAY
  },

  /* =========================== Apple Watch =========================== */
  {
    id: 'watch-series-11-alu', name: 'Apple Watch Series 11 (алюминий)', category: 'Apple Watch',
    price: 23250, discountPercent: 11, inStock: true,
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
    price: 44250, discountPercent: 10, inStock: true,
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
    price: 27990, discountPercent: 13, inStock: true,
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
    id: 'airpods-pro-3', name: 'AirPods Pro 3', category: 'AirPods',
    price: 13000, discountPercent: 13, inStock: true,
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
    price: 7875, discountPercent: 12, inStock: true,
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
    price: 35250, discountPercent: 8, inStock: true,
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
    price: 12990, discountPercent: 13, inStock: true,
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
    price: 11990, discountPercent: 8, inStock: true,
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
  }
];

// Товары, которых может не быть в живом каталоге, — их доливает `node add-novinki.js`.
// Это не только свежие релизы: прошлые поколения, добавленные в catalog.js после
// первого запуска, попадают на витрину тем же способом.
const NOVELTY_IDS = [
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
  'apple-tv-4k', 'homepod-mini', 'vision-pro-m5'
];

module.exports = { products, NOVELTY_IDS, colors: C, DAY, now };
