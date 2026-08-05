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
      { name: 'Natural', hex: '#d6d6d8', add: 7000, forColor: 'Натуральный титан' },
      { name: 'Gold', hex: '#d4b483', add: 7000, forColor: 'Золотой титан' },
      { name: 'Slate', hex: '#5a5a5f', add: 7000, forColor: 'Сланцевый титан' }
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
  hermes: [
    { name: 'Hermès Torsade', sizes: SML, options: [
      { name: 'Noir', hex: '#1f1f21', add: 0 },
      { name: 'Gris Perle', hex: '#b7b2a8', add: 0 }
    ] },
    { name: 'Hermès Kilim', sizes: SML, options: [
      { name: 'Bleu Saphir', hex: '#27406b', add: 18000 },
      { name: 'Orange', hex: '#e2661f', add: 18000 }
    ] },
    { name: 'Hermès Grand H', sizes: SML, options: [
      { name: 'Noir', hex: '#1f1f21', add: 26000 },
      { name: 'Gold', hex: '#b98b4e', add: 26000 }
    ] }
  ]
};

/* -------- типовые наборы памяти (add — доплата к базовой цене, ₽) -------- */
const ST = {
  ph256: [{ label: '256 ГБ', add: 0 }, { label: '512 ГБ', add: 12000 }, { label: '1 ТБ', add: 30000 }],
  ph256max: [{ label: '256 ГБ', add: 0 }, { label: '512 ГБ', add: 12000 }, { label: '1 ТБ', add: 30000 }, { label: '2 ТБ', add: 60000 }],
  ph256s: [{ label: '256 ГБ', add: 0 }, { label: '512 ГБ', add: 12000 }],
  ph128: [{ label: '128 ГБ', add: 0 }, { label: '256 ГБ', add: 7000 }, { label: '512 ГБ', add: 19000 }],
  ph128p: [{ label: '128 ГБ', add: 0 }, { label: '256 ГБ', add: 7000 }, { label: '512 ГБ', add: 19000 }, { label: '1 ТБ', add: 37000 }],
  pad128: [{ label: '128 ГБ', add: 0 }, { label: '256 ГБ', add: 8000 }, { label: '512 ГБ', add: 20000 }],
  pad256: [{ label: '256 ГБ', add: 0 }, { label: '512 ГБ', add: 15000 }, { label: '1 ТБ', add: 40000 }, { label: '2 ТБ', add: 80000 }],
  mac256: [{ label: '256 ГБ', add: 0 }, { label: '512 ГБ', add: 18000 }, { label: '1 ТБ', add: 40000 }, { label: '2 ТБ', add: 80000 }],
  mac512: [{ label: '512 ГБ', add: 0 }, { label: '1 ТБ', add: 22000 }, { label: '2 ТБ', add: 62000 }, { label: '4 ТБ', add: 130000 }],
  // Накопители Mac по apple.com (август 2026). Доплаты — долларовые Apple по
  // курсу 90 ₽/$. Часть объёмов идёт только со своим чипом, отсюда forChoice.
  air13: [
    { label: '512 ГБ', add: 0 },
    { label: '1 ТБ', add: 27000, forChoice: { 'Чип': ['M5, 10 ядер GPU'] } },
    { label: '2 ТБ', add: 72000, forChoice: { 'Чип': ['M5, 10 ядер GPU'] } },
    { label: '4 ТБ', add: 162000, forChoice: { 'Чип': ['M5, 10 ядер GPU'] } }
  ],
  air15: [{ label: '512 ГБ', add: 0 }, { label: '1 ТБ', add: 27000 }, { label: '2 ТБ', add: 72000 }, { label: '4 ТБ', add: 162000 }],
  pro14: [
    { label: '1 ТБ', add: 0 },
    { label: '2 ТБ', add: 45000 },
    { label: '4 ТБ', add: 135000 },
    { label: '8 ТБ', add: 270000, forChoice: { 'Чип': ['M5 Max, 32 ядра GPU'] } }
  ],
  pro16: [
    { label: '1 ТБ', add: 0, forChoice: { 'Чип': ['M5 Pro, 18 ядер CPU'] } },
    { label: '2 ТБ', add: 45000 },
    { label: '4 ТБ', add: 135000 },
    { label: '8 ТБ', add: 270000, forChoice: { 'Чип': ['M5 Max, 32 ядра GPU', 'M5 Max, 40 ядер GPU'] } }
  ],
  imac: [{ label: '256 ГБ', add: 0 }, { label: '512 ГБ', add: 18000 }, { label: '1 ТБ', add: 45000 }, { label: '2 ТБ', add: 90000 }],
  mini: [
    { label: '256 ГБ', add: 0 },
    { label: '512 ГБ', add: 18000 },
    { label: '1 ТБ', add: 45000 },
    { label: '2 ТБ', add: 90000 },
    { label: '4 ТБ', add: 180000, forChoice: { 'Чип': ['M4 Pro, 12 ядер CPU'] } },
    { label: '8 ТБ', add: 360000, forChoice: { 'Чип': ['M4 Pro, 12 ядер CPU'] } }
  ],
  studio: [
    { label: '512 ГБ', add: 0 }, { label: '1 ТБ', add: 18000 }, { label: '2 ТБ', add: 54000 },
    { label: '4 ТБ', add: 108000 }, { label: '8 ТБ', add: 216000 },
    { label: '16 ТБ', add: 414000, forChoice: { 'Чип': ['M3 Ultra, 28 ядер CPU'] } }
  ],
  watch42: [{ label: '42 мм', add: 0 }, { label: '46 мм', add: 4000 }],
  watch40: [{ label: '40 мм', add: 0 }, { label: '44 мм', add: 3000 }],
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

// MacBook Air: 13" — 8-ядерный GPU только в базе (16 ГБ / 512 ГБ), всё, что
// выше, идёт с 10-ядерным. У 15" вариант один, поэтому и группы «Чип» нет.
const CHIP_AIR13 = OPT.chip([['M5, 8 ядер GPU', 0], ['M5, 10 ядер GPU', 18000]]);
const RAM_AIR13 = OPT.ram([
  ['16 ГБ', 0],
  ['24 ГБ', 18000, forChip('M5, 10 ядер GPU')],
  ['32 ГБ', 36000, forChip('M5, 10 ядер GPU')]
]);
const RAM_AIR15 = OPT.ram([['16 ГБ', 0], ['24 ГБ', 18000], ['32 ГБ', 36000]]);

// MacBook Pro 14": M5 → M5 Pro (15 и 18 ядер CPU) → M5 Max. 16": M5 Pro → M5 Max
// (32 и 40 ядер GPU). Доплаты за чип — разница базовых цен Apple по тому же курсу.
const CHIP_PRO14 = OPT.chip([
  ['M5, 10 ядер CPU', 0],
  ['M5 Pro, 15 ядер CPU', 63000],
  ['M5 Pro, 18 ядер CPU', 81000],
  ['M5 Max, 32 ядра GPU', 153000]
]);
const RAM_PRO14 = OPT.ram([
  ['16 ГБ', 0, forChip('M5, 10 ядер CPU')],
  ['24 ГБ', 18000, forChip('M5, 10 ядер CPU', 'M5 Pro, 15 ядер CPU', 'M5 Pro, 18 ядер CPU')],
  ['32 ГБ', 36000, forChip('M5, 10 ядер CPU')],
  ['36 ГБ', 45000, forChip('M5 Max, 32 ядра GPU')],
  ['48 ГБ', 54000, forChip('M5 Pro, 15 ядер CPU', 'M5 Pro, 18 ядер CPU')],
  ['64 ГБ', 90000, forChip('M5 Pro, 15 ядер CPU', 'M5 Pro, 18 ядер CPU')]
]);
const CHIP_PRO16 = OPT.chip([
  ['M5 Pro, 18 ядер CPU', 0],
  ['M5 Max, 32 ядра GPU', 126000],
  ['M5 Max, 40 ядер GPU', 180000]
]);
const RAM_PRO16 = OPT.ram([
  ['24 ГБ', 0, forChip('M5 Pro, 18 ядер CPU')],
  ['36 ГБ', 45000, forChip('M5 Max, 32 ядра GPU')],
  ['48 ГБ', 54000, forChip('M5 Pro, 18 ядер CPU', 'M5 Max, 40 ядер GPU')],
  ['64 ГБ', 90000, forChip('M5 Pro, 18 ядер CPU', 'M5 Max, 40 ядер GPU')],
  ['128 ГБ', 270000, forChip('M5 Max, 40 ядер GPU')]
]);

// Десктопы. iMac и Mac mini — всё ещё M4, Mac Studio — M4 Max и M3 Ultra.
const RAM_IMAC = OPT.ram([['16 ГБ', 0], ['24 ГБ', 18000], ['32 ГБ', 36000]]);
const CHIP_MINI = OPT.chip([['M4, 10 ядер CPU', 0], ['M4 Pro, 12 ядер CPU', 72000]]);
const RAM_MINI = OPT.ram([
  ['16 ГБ', 0, forChip('M4, 10 ядер CPU')],
  ['24 ГБ', 18000, forChip('M4, 10 ядер CPU', 'M4 Pro, 12 ядер CPU')],
  ['48 ГБ', 54000, forChip('M4 Pro, 12 ядер CPU')],
  ['64 ГБ', 90000, forChip('M4 Pro, 12 ядер CPU')]
]);
const CHIP_STUDIO = OPT.chip([['M4 Max, 14 ядер CPU', 0], ['M3 Ultra, 28 ядер CPU', 252000]]);
const RAM_STUDIO = OPT.ram([
  ['36 ГБ', 0, forChip('M4 Max, 14 ядер CPU')],
  ['64 ГБ', 36000, forChip('M4 Max, 14 ядер CPU')],
  ['96 ГБ', 90000, forChip('M4 Max, 14 ядер CPU', 'M3 Ultra, 28 ядер CPU')],
  ['256 ГБ', 306000, forChip('M3 Ultra, 28 ядер CPU')],
  ['512 ГБ', 720000, forChip('M3 Ultra, 28 ядер CPU')]
]);

// Группы, которые встречаются у одного-двух товаров, — отдельными константами
const POWER_AIR = {
  name: 'Блок питания', hint: 'Выберите зарядное устройство в комплекте',
  values: [
    { label: '30 Вт USB-C', add: 0 },
    { label: '35 Вт с двумя портами', add: 0 },
    { label: '70 Вт быстрая зарядка', add: 2990 }
  ]
};
const POWER_PRO14 = {
  name: 'Блок питания', hint: 'Выберите зарядное устройство в комплекте',
  values: [{ label: '70 Вт USB-C', add: 0 }, { label: '96 Вт быстрая зарядка', add: 3990 }]
};
const IMAC_PORTS = {
  name: 'Порты и сеть', hint: 'Выберите набор портов на задней панели',
  values: [
    { label: '2 порта Thunderbolt', add: 0 },
    { label: '4 порта Thunderbolt и Gigabit Ethernet', add: 19990 }
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
  values: [{ label: 'Gigabit Ethernet', add: 0 }, { label: '10 Гбит Ethernet', add: 12990 }]
};
// Две версии AirPods 4 и два комплекта AirTag живут одной карточкой: у Apple
// это тоже один товар с выбором, а не соседние позиции в каталоге. Доплата
// выводит на прежнюю цену второй карточки — 17 990 ₽ и 11 990 ₽.
const AIRPODS_4_ANC = {
  name: 'Версия', hint: 'Выберите, нужно ли активное шумоподавление',
  values: [
    { label: 'Без шумоподавления', add: 0 },
    { label: 'С шумоподавлением', add: 5000 }
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

const products = [

  /* ============================== iPhone ============================== */
  {
    id: 'iphone-17-pro-max', name: 'iPhone 17 Pro Max', category: 'iPhone',
    price: 89990, oldPrice: 104990, badge: 'Хит', inStock: true,
    shortDesc: 'A19 Pro, три камеры 48 Мп, 6.9", до 39 ч видео.',
    description: 'Самый мощный iPhone. Чип A19 Pro с 6-ядерным GPU и паровой камерой охлаждения, три камеры по 48 Мп с 8-кратным оптическим зумом и рекордная автономность — до 39 часов видео. Цельный корпус из кованого алюминия, Ceramic Shield 2 спереди и Ceramic Shield сзади.',
    specs: 'Экран: 6.9" Super Retina XDR, ProMotion 120 Гц, до 3000 нит\nЧип: A19 Pro, 6-ядерный GPU\nКамеры: 48 Мп Fusion + 48 Мп СШУ + 48 Мп теле, зум 8×\nФронталка: 18 Мп Center Stage\nАвтономность: до 39 ч видео\nПамять: от 256 ГБ до 2 ТБ\nМатериал: кованый алюминий, Ceramic Shield 2\nЗащита: IP68\nКнопки: Действие\nCamera Control: быстрый доступ к съёмке\nРазъём: USB-C 3 (10 Гбит/с)\nСвязь: 5G, Wi-Fi 7\nСистема: iOS 26 с Apple Intelligence',
    colors: IPHONE_17_PRO, storages: ST.ph256max,
    options: [OPT.sim(5000)],
    hotDeal: true, hotDealPrice: 84990, hotDealUntil: now + 4 * DAY,
    images: [], createdAt: now - 0.2 * DAY
  },
  {
    id: 'iphone-17-pro', name: 'iPhone 17 Pro', category: 'iPhone',
    price: 82990, oldPrice: 94990, badge: '', inStock: true,
    shortDesc: 'A19 Pro, три камеры 48 Мп, 6.3".',
    description: 'Вся мощь Pro в компактном корпусе 6.3". Чип A19 Pro, тройная система камер 48 Мп с оптическим зумом 8×, до 33 часов видео и корпус из кованого алюминия.',
    specs: 'Экран: 6.3" Super Retina XDR, ProMotion 120 Гц, до 3000 нит\nЧип: A19 Pro, 6-ядерный GPU\nКамеры: 48 Мп Fusion + 48 Мп СШУ + 48 Мп теле, зум 8×\nФронталка: 18 Мп Center Stage\nАвтономность: до 33 ч видео\nПамять: от 256 ГБ до 1 ТБ\nМатериал: кованый алюминий, Ceramic Shield 2\nЗащита: IP68\nКнопки: Действие\nCamera Control: быстрый доступ к съёмке\nРазъём: USB-C 3 (10 Гбит/с)\nСвязь: 5G, Wi-Fi 7\nСистема: iOS 26 с Apple Intelligence',
    colors: IPHONE_17_PRO, storages: ST.ph256,
    options: [OPT.sim(5000)],
    hotDeal: false, hotDealPrice: null, hotDealUntil: null,
    images: [], createdAt: now - 0.3 * DAY
  },
  {
    id: 'iphone-air', name: 'iPhone Air', category: 'iPhone',
    price: 79990, oldPrice: 0, badge: 'Новинка', inStock: true,
    shortDesc: 'Самый тонкий iPhone: A19 Pro, титан, 6.5".',
    description: 'Самый тонкий iPhone в истории — и при этом с производительностью Pro. Титановый корпус, чип A19 Pro, камера 48 Мп Fusion и фронтальная камера Center Stage 18 Мп.',
    specs: 'Экран: 6.5" Super Retina XDR, ProMotion 120 Гц\nЧип: A19 Pro\nКамера: 48 Мп Fusion Main, зум 2×\nФронталка: 18 Мп Center Stage\nАвтономность: до 27 ч видео\nПамять: от 256 ГБ до 1 ТБ\nМатериал: титан, Ceramic Shield 2\nЗащита: IP68\nТолщина: 5.6 мм\nКнопки: Действие\nCamera Control: быстрый доступ к съёмке\nРазъём: USB-C\nСвязь: 5G, eSIM\nСистема: iOS 26 с Apple Intelligence',
    colors: IPHONE_AIR, storages: ST.ph256,
    hotDeal: false, hotDealPrice: null, hotDealUntil: null,
    images: [], createdAt: now - 0.4 * DAY
  },
  {
    id: 'iphone-17', name: 'iPhone 17', category: 'iPhone',
    price: 67990, oldPrice: 74990, badge: 'Выбор покупателей', inStock: true,
    shortDesc: 'A19, ProMotion 120 Гц, две камеры 48 Мп.',
    description: 'Впервые в базовой модели — ProMotion 120 Гц и стартовая память 256 ГБ. Чип A19, две камеры по 48 Мп, до 30 часов видео и Ceramic Shield 2 с втрое лучшей стойкостью к царапинам.',
    specs: 'Экран: 6.3" Super Retina XDR, ProMotion 120 Гц\nЧип: A19, 5-ядерный GPU\nКамеры: 48 Мп Dual Fusion + 48 Мп СШУ\nФронталка: 18 Мп Center Stage\nАвтономность: до 30 ч видео\nПамять: 256 или 512 ГБ\nМатериал: алюминий, Ceramic Shield 2\nЗащита: IP68\nКнопки: Действие\nCamera Control: быстрый доступ к съёмке\nРазъём: USB-C\nСвязь: 5G, Wi-Fi 7\nСистема: iOS 26 с Apple Intelligence',
    colors: IPHONE_17, storages: ST.ph256s,
    options: [OPT.sim(4000)],
    hotDeal: false, hotDealPrice: null, hotDealUntil: null,
    images: [], createdAt: now - 0.5 * DAY
  },
  {
    id: 'iphone-17e', name: 'iPhone 17e', category: 'iPhone',
    price: 54990, oldPrice: 59990, badge: 'Новинка', inStock: true,
    shortDesc: 'A19, камера 48 Мп, 6.1" — доступный iPhone.',
    description: 'Максимум возможностей за минимальные деньги: чип A19 с поддержкой Apple Intelligence, камера 48 Мп Fusion с 2-кратным оптическим зумом, кнопка «Действие» и стартовая память 256 ГБ.',
    specs: 'Экран: 6.1" Super Retina XDR\nЧип: A19\nКамера: 48 Мп Fusion Main, зум 2×\nФронталка: 12 Мп TrueDepth\nАвтономность: до 26 ч видео\nПамять: 256 или 512 ГБ\nМатериал: алюминий, Ceramic Shield 2\nЗащита: IP68\nКнопки: Действие\nРазъём: USB-C\nСвязь: 5G\nСистема: iOS 26 с Apple Intelligence',
    colors: IPHONE_17E, storages: ST.ph256s,
    options: [OPT.sim(3000)],
    hotDeal: false, hotDealPrice: null, hotDealUntil: null,
    images: [], createdAt: now - 0.6 * DAY
  },
  {
    id: 'iphone-16-pro-max', name: 'iPhone 16 Pro Max', category: 'iPhone',
    price: 76990, oldPrice: 89990, badge: 'Хит', inStock: true,
    shortDesc: 'A18 Pro, титан, 6.9", зум 5×, до 33 ч видео.',
    description: 'Флагман прошлого поколения по цене без переплаты за новизну. Титановый корпус 6.9", чип A18 Pro, тройная камера с 48 Мп Fusion и 5-кратным тетрапризменным зумом, съёмка 4K120 в Dolby Vision и до 33 часов видео.',
    specs: 'Экран: 6.9" Super Retina XDR, ProMotion 120 Гц, до 2000 нит\nЧип: A18 Pro, 6-ядерный GPU\nКамеры: 48 Мп Fusion + 48 Мп СШУ + 12 Мп теле, зум 5×\nФронталка: 12 Мп TrueDepth\nАвтономность: до 33 ч видео\nПамять: от 256 ГБ до 1 ТБ\nМатериал: титан, Ceramic Shield\nЗащита: IP68\nКнопки: Действие\nCamera Control: быстрый доступ к съёмке\nРазъём: USB-C 3 (10 Гбит/с)\nСвязь: 5G, Wi-Fi 7\nСистема: iOS 26 с Apple Intelligence',
    colors: IPHONE_16_PRO, storages: ST.ph256,
    options: [OPT.sim(5000)],
    hotDeal: false, hotDealPrice: null, hotDealUntil: null,
    images: [], createdAt: now - 0.9 * DAY
  },
  {
    id: 'iphone-16-pro', name: 'iPhone 16 Pro', category: 'iPhone',
    price: 68990, oldPrice: 79990, badge: '', inStock: true,
    shortDesc: 'A18 Pro, титан, 6.3", зум 5×.',
    description: 'Компактный Pro в титановом корпусе: чип A18 Pro, три камеры с 48 Мп Fusion и 5-кратным зумом, кнопка Camera Control и до 27 часов видео.',
    specs: 'Экран: 6.3" Super Retina XDR, ProMotion 120 Гц, до 2000 нит\nЧип: A18 Pro, 6-ядерный GPU\nКамеры: 48 Мп Fusion + 48 Мп СШУ + 12 Мп теле, зум 5×\nФронталка: 12 Мп TrueDepth\nАвтономность: до 27 ч видео\nПамять: от 128 ГБ до 1 ТБ\nМатериал: титан, Ceramic Shield\nЗащита: IP68\nКнопки: Действие\nCamera Control: быстрый доступ к съёмке\nРазъём: USB-C 3 (10 Гбит/с)\nСвязь: 5G, Wi-Fi 7\nСистема: iOS 26 с Apple Intelligence',
    colors: IPHONE_16_PRO, storages: ST.ph128p,
    options: [OPT.sim(5000)],
    hotDeal: false, hotDealPrice: null, hotDealUntil: null,
    images: [], createdAt: now - 0.95 * DAY
  },
  {
    id: 'iphone-16-plus', name: 'iPhone 16 Plus', category: 'iPhone',
    price: 63990, oldPrice: 71990, badge: '', inStock: true,
    shortDesc: 'A18, большой экран 6.7", до 27 ч видео.',
    description: 'Тот же iPhone 16, но с экраном 6.7" и самой большой батареей в линейке — до 27 часов видео. Чип A18 с Apple Intelligence, камера 48 Мп Fusion и кнопка Camera Control.',
    specs: 'Экран: 6.7" Super Retina XDR\nЧип: A18\nКамеры: 48 Мп Fusion + 12 Мп СШУ\nФронталка: 12 Мп TrueDepth\nАвтономность: до 27 ч видео\nПамять: от 128 до 512 ГБ\nМатериал: алюминий, Ceramic Shield\nЗащита: IP68\nКнопки: Действие\nCamera Control: быстрый доступ к съёмке\nРазъём: USB-C\nСвязь: 5G, Wi-Fi 7\nСистема: iOS 26 с Apple Intelligence',
    colors: IPHONE_16, storages: ST.ph128,
    options: [OPT.sim(4000)],
    hotDeal: false, hotDealPrice: null, hotDealUntil: null,
    images: [], createdAt: now - 0.98 * DAY
  },
  {
    id: 'iphone-16', name: 'iPhone 16', category: 'iPhone',
    price: 57990, oldPrice: 64990, badge: '', inStock: true,
    shortDesc: 'A18, две камеры, пять цветов.',
    description: 'Проверенный флагман прошлого поколения по сниженной цене. Чип A18 с поддержкой Apple Intelligence, камера 48 Мп Fusion, кнопка Camera Control и прочный корпус из алюминия.',
    specs: 'Экран: 6.1" Super Retina XDR\nЧип: A18\nКамеры: 48 Мп Fusion + 12 Мп СШУ\nФронталка: 12 Мп TrueDepth\nАвтономность: до 22 ч видео\nПамять: от 128 до 512 ГБ\nМатериал: алюминий, Ceramic Shield\nЗащита: IP68\nКнопки: Действие\nCamera Control: быстрый доступ к съёмке\nРазъём: USB-C\nСвязь: 5G, Wi-Fi 7\nСистема: iOS 26 с Apple Intelligence',
    colors: IPHONE_16, storages: ST.ph128,
    options: [OPT.sim(4000)],
    hotDeal: false, hotDealPrice: null, hotDealUntil: null,
    images: [], createdAt: now - 1 * DAY
  },
  {
    id: 'iphone-16e', name: 'iPhone 16e', category: 'iPhone',
    price: 44990, oldPrice: 49990, badge: '', inStock: true,
    shortDesc: 'A18, камера 48 Мп, до 26 ч видео — вход в линейку.',
    description: 'Самый доступный iPhone с Apple Intelligence. Чип A18, камера 48 Мп Fusion с 2-кратным оптическим зумом, кнопка «Действие» и собственный модем Apple C1, с которым автономность выросла до 26 часов видео.',
    specs: 'Экран: 6.1" Super Retina XDR\nЧип: A18\nКамера: 48 Мп Fusion Main, зум 2×\nФронталка: 12 Мп TrueDepth\nАвтономность: до 26 ч видео\nПамять: от 128 до 512 ГБ\nМатериал: алюминий, Ceramic Shield\nЗащита: IP68\nКнопки: Действие\nРазъём: USB-C\nСвязь: 5G, модем Apple C1\nСистема: iOS 26 с Apple Intelligence',
    colors: IPHONE_16E, storages: ST.ph128,
    options: [OPT.sim(3000)],
    hotDeal: true, hotDealPrice: 41990, hotDealUntil: now + 3 * DAY,
    images: [], createdAt: now - 1.1 * DAY
  },
  {
    id: 'iphone-15-pro-max', name: 'iPhone 15 Pro Max', category: 'iPhone',
    price: 64990, oldPrice: 74990, badge: '', inStock: true,
    shortDesc: 'A17 Pro, титан, 6.7", зум 5×, до 29 ч видео.',
    description: 'Первый iPhone из титана и первый с 5-кратным тетрапризменным зумом. Чип A17 Pro, кнопка «Действие» вместо переключателя звука, разъём USB-C и до 29 часов видео.',
    specs: 'Экран: 6.7" Super Retina XDR, ProMotion 120 Гц, до 2000 нит\nЧип: A17 Pro, 6-ядерный GPU\nКамеры: 48 Мп Main + 12 Мп СШУ + 12 Мп теле, зум 5×\nФронталка: 12 Мп TrueDepth\nАвтономность: до 29 ч видео\nПамять: от 256 ГБ до 1 ТБ\nМатериал: титан, Ceramic Shield\nЗащита: IP68\nКнопки: Действие\nРазъём: USB-C 3 (10 Гбит/с)\nСвязь: 5G, Wi-Fi 6E\nСистема: iOS 26',
    colors: IPHONE_15_PRO, storages: ST.ph256,
    options: [OPT.sim(5000)],
    hotDeal: false, hotDealPrice: null, hotDealUntil: null,
    images: [], createdAt: now - 1.2 * DAY
  },
  {
    id: 'iphone-15-pro', name: 'iPhone 15 Pro', category: 'iPhone',
    price: 56990, oldPrice: 64990, badge: '', inStock: true,
    shortDesc: 'A17 Pro, титан, 6.1", кнопка «Действие».',
    description: 'Самый лёгкий Pro за счёт титанового корпуса: 187 граммов. Чип A17 Pro, три камеры с 48 Мп Main и 3-кратным зумом, кнопка «Действие» и USB-C со скоростью до 10 Гбит/с.',
    specs: 'Экран: 6.1" Super Retina XDR, ProMotion 120 Гц, до 2000 нит\nЧип: A17 Pro, 6-ядерный GPU\nКамеры: 48 Мп Main + 12 Мп СШУ + 12 Мп теле, зум 3×\nФронталка: 12 Мп TrueDepth\nАвтономность: до 23 ч видео\nПамять: от 128 ГБ до 1 ТБ\nМатериал: титан, Ceramic Shield\nЗащита: IP68\nКнопки: Действие\nРазъём: USB-C 3 (10 Гбит/с)\nСвязь: 5G, Wi-Fi 6E\nСистема: iOS 26',
    colors: IPHONE_15_PRO, storages: ST.ph128p,
    options: [OPT.sim(5000)],
    hotDeal: false, hotDealPrice: null, hotDealUntil: null,
    images: [], createdAt: now - 1.25 * DAY
  },
  {
    id: 'iphone-15-plus', name: 'iPhone 15 Plus', category: 'iPhone',
    price: 47990, oldPrice: 54990, badge: '', inStock: true,
    shortDesc: 'A16 Bionic, 6.7", камера 48 Мп, до 26 ч видео.',
    description: 'Большой экран 6.7" и запас автономности на два дня спокойного пользования. Камера 48 Мп с 2-кратным зумом без потери качества, Dynamic Island и разъём USB-C.',
    specs: 'Экран: 6.7" Super Retina XDR, Dynamic Island\nЧип: A16 Bionic\nКамеры: 48 Мп Main + 12 Мп СШУ, зум 2×\nФронталка: 12 Мп TrueDepth\nАвтономность: до 26 ч видео\nПамять: от 128 до 512 ГБ\nМатериал: алюминий, Ceramic Shield\nЗащита: IP68\nРазъём: USB-C\nСвязь: 5G, Wi-Fi 6\nСистема: iOS 26',
    colors: IPHONE_15, storages: ST.ph128,
    options: [OPT.sim(4000)],
    hotDeal: false, hotDealPrice: null, hotDealUntil: null,
    images: [], createdAt: now - 1.3 * DAY
  },
  {
    id: 'iphone-15', name: 'iPhone 15', category: 'iPhone',
    price: 42990, oldPrice: 47990, badge: '', inStock: true,
    shortDesc: 'A16 Bionic, 6.1", камера 48 Мп, Dynamic Island.',
    description: 'Первый iPhone с USB-C и цветом, запечённым в само стекло. Камера 48 Мп с 2-кратным зумом, Dynamic Island и чип A16 Bionic — рабочая лошадка, которая ещё долго будет получать обновления.',
    specs: 'Экран: 6.1" Super Retina XDR, Dynamic Island\nЧип: A16 Bionic\nКамеры: 48 Мп Main + 12 Мп СШУ, зум 2×\nФронталка: 12 Мп TrueDepth\nАвтономность: до 20 ч видео\nПамять: от 128 до 512 ГБ\nМатериал: алюминий, Ceramic Shield\nЗащита: IP68\nРазъём: USB-C\nСвязь: 5G, Wi-Fi 6\nСистема: iOS 26',
    colors: IPHONE_15, storages: ST.ph128,
    options: [OPT.sim(4000)],
    hotDeal: true, hotDealPrice: 39990, hotDealUntil: now + 6 * DAY,
    images: [], createdAt: now - 1.35 * DAY
  },

  /* =============================== Mac =============================== */
  {
    id: 'macbook-neo', name: 'MacBook Neo', category: 'Mac',
    price: 69990, oldPrice: 0, badge: 'Новинка', inStock: true,
    shortDesc: 'Самый доступный MacBook: 13", лёгкий, четыре цвета.',
    description: 'Магия Mac по удивительной цене. Лёгкий 13-дюймовый ноутбук в четырёх ярких цветах, тоньше половины дюйма, с поддержкой Apple Intelligence и целым днём автономной работы.',
    specs: 'Экран: 13.3" Liquid Retina\nЧип: Apple silicon с нейронным движком\nОЗУ: 16 или 24 ГБ\nПамять: от 256 ГБ SSD\nАвтономность: до 18 ч\nВес: 1.2 кг\nПорты: 2× USB-C, MagSafe 3, аудиоразъём\nКамера: 12 Мп Center Stage\nАудио: стереодинамики, 3 микрофона\nКлавиатура: Magic Keyboard с Touch ID\nГотов к ИИ: Apple Intelligence в macOS 26',
    colors: MB_NEO, storages: ST.mac256,
    options: [OPT.ram([['16 ГБ', 0], ['24 ГБ', 18000]])],
    hotDeal: false, hotDealPrice: null, hotDealUntil: null,
    images: [], createdAt: now - 0.7 * DAY
  },
  {
    id: 'macbook-air-13-m5', name: 'MacBook Air 13" (M5)', category: 'Mac',
    price: 119990, oldPrice: 129990, badge: 'Хит', inStock: true,
    shortDesc: 'M5, 13.6", до 18 часов работы, 1.24 кг.',
    description: 'Тонкий, быстрый, мощный и портативный. Чип M5 с 10-ядерным CPU, безвентиляторная конструкция, до 18 часов автономной работы и вес всего 1.24 кг.',
    specs: 'Экран: 13.6" Liquid Retina, 500 нит\nЧип: Apple M5, 10-ядерный CPU\nОЗУ: 16 ГБ (до 32 ГБ)\nПамять: от 512 ГБ SSD\nАвтономность: до 18 ч\nВес: 1.24 кг\nПорты: 2× Thunderbolt 4, MagSafe 3, аудиоразъём\nКамера: 12 Мп Center Stage\nАудио: 4 динамика, Spatial Audio\nСвязь: Wi-Fi 7, Bluetooth 6\nГотов к ИИ: Apple Intelligence в macOS 26',
    colors: MB_AIR, storages: ST.air13,
    options: [CHIP_AIR13, RAM_AIR13, POWER_AIR],
    hotDeal: false, hotDealPrice: null, hotDealUntil: null,
    images: [], createdAt: now - 0.8 * DAY
  },
  {
    id: 'macbook-air-15-m5', name: 'MacBook Air 15" (M5)', category: 'Mac',
    price: 139990, oldPrice: 149990, badge: '', inStock: true,
    shortDesc: 'M5, большой экран 15.3", шесть динамиков.',
    description: 'Всё то же, что в 13-дюймовом Air, но с большим экраном 15.3" и системой из шести динамиков. Идеально, когда нужен простор для работы и кино.',
    specs: 'Экран: 15.3" Liquid Retina, 500 нит\nЧип: Apple M5, 10-ядерный CPU\nОЗУ: 16 ГБ (до 32 ГБ)\nПамять: от 512 ГБ SSD\nАвтономность: до 18 ч\nВес: 1.51 кг\nПорты: 2× Thunderbolt 4, MagSafe 3, аудиоразъём\nКамера: 12 Мп Center Stage\nАудио: 6 динамиков, Spatial Audio\nСвязь: Wi-Fi 7, Bluetooth 6\nГотов к ИИ: Apple Intelligence в macOS 26',
    colors: MB_AIR, storages: ST.air15,
    options: [RAM_AIR15, POWER_AIR],
    hotDeal: false, hotDealPrice: null, hotDealUntil: null,
    images: [], createdAt: now - 0.9 * DAY
  },
  {
    id: 'macbook-pro-14-m5', name: 'MacBook Pro 14" (M5)', category: 'Mac',
    price: 189990, oldPrice: 209990, badge: '', inStock: true,
    shortDesc: 'M5 / M5 Pro / M5 Max, Liquid Retina XDR 120 Гц.',
    description: 'Самый продвинутый ноутбук Mac для требовательных задач. Чипы M5, M5 Pro или M5 Max, дисплей Liquid Retina XDR с ProMotion 120 Гц, Thunderbolt 5 и до 24 часов автономной работы.',
    specs: 'Экран: 14.2" Liquid Retina XDR, 120 Гц, 1600 нит\nЧип: Apple M5 (до M5 Max)\nОЗУ: 16 ГБ (до 64 ГБ)\nПамять: от 1 ТБ SSD\nАвтономность: до 24 ч\nВес: 1.55 кг\nПорты: 3× Thunderbolt 5, HDMI, SDXC, MagSafe 3\nКамера: 12 Мп Center Stage\nАудио: 6 динамиков, 3 микрофона студийного качества\nСвязь: Wi-Fi 7, Bluetooth 6\nГотов к ИИ: Apple Intelligence в macOS 26',
    colors: MB_PRO, storages: ST.pro14,
    options: [CHIP_PRO14, RAM_PRO14, OPT.glass(13500), POWER_PRO14],
    hotDeal: false, hotDealPrice: null, hotDealUntil: null,
    images: [], createdAt: now - 1.1 * DAY
  },
  {
    id: 'macbook-pro-16-m5-pro', name: 'MacBook Pro 16" (M5 Pro)', category: 'Mac',
    price: 279990, oldPrice: 299990, badge: '', inStock: true,
    shortDesc: 'M5 Pro / M5 Max, 16.2" XDR, до 26 часов.',
    description: 'Максимальный экран и максимальная производительность. Чипы M5 Pro и M5 Max, до 128 ГБ объединённой памяти, четыре порта Thunderbolt 5 и самая долгая автономность среди ноутбуков Mac.',
    specs: 'Экран: 16.2" Liquid Retina XDR, 120 Гц, 1600 нит\nЧип: Apple M5 Pro (до M5 Max)\nОЗУ: 24 ГБ (до 128 ГБ)\nПамять: от 1 ТБ SSD\nАвтономность: до 26 ч\nВес: 2.14 кг\nПорты: 4× Thunderbolt 5, HDMI, SDXC, MagSafe 3\nКамера: 12 Мп Center Stage\nАудио: 6 динамиков, Spatial Audio\nСвязь: Wi-Fi 7, Bluetooth 6\nГотов к ИИ: Apple Intelligence в macOS 26',
    colors: MB_PRO, storages: ST.pro16,
    options: [CHIP_PRO16, RAM_PRO16, OPT.glass(13500)],
    hotDeal: false, hotDealPrice: null, hotDealUntil: null,
    images: [], createdAt: now - 1.2 * DAY
  },
  {
    id: 'imac-m5', name: 'iMac 24" (M4)', category: 'Mac',
    price: 139990, oldPrice: 0, badge: '', inStock: true,
    shortDesc: 'Моноблок 24" 4.5K, семь цветов, M4.',
    description: 'Моноблок для творчества и работы: дисплей 24" Retina 4.5K, чип M4, камера Center Stage 12 Мп и подобранные в цвет Magic Keyboard и Magic Mouse в комплекте.',
    specs: 'Экран: 24" Retina 4.5K, 500 нит\nЧип: Apple M4, 8 или 10 ядер GPU\nОЗУ: 16 ГБ (до 32 ГБ)\nПамять: от 256 ГБ SSD\nКамера: 12 Мп Center Stage с Desk View\nАудио: 6 динамиков, Spatial Audio\nПорты: 2× Thunderbolt 4, 2× USB-C\nКлавиатура: Magic Keyboard в цвет корпуса\nСвязь: Wi-Fi 7, Bluetooth 6\nГотов к ИИ: Apple Intelligence в macOS 26',
    colors: IMAC, storages: ST.imac,
    options: [RAM_IMAC, OPT.glass(18000), IMAC_PORTS, IMAC_KEYBOARD],
    hotDeal: false, hotDealPrice: null, hotDealUntil: null,
    images: [], createdAt: now - 1.3 * DAY
  },
  {
    id: 'mac-mini-m5', name: 'Mac mini (M4)', category: 'Mac',
    price: 74990, oldPrice: 79990, badge: 'Выгодно', inStock: true,
    shortDesc: 'Самый компактный Mac: M4 или M4 Pro, 12.7 см.',
    description: 'Самый маленький и доступный десктоп Mac. Чип M4 или M4 Pro, корпус 12.7 × 12.7 см, порты Thunderbolt спереди и сзади — подключается к любому монитору и клавиатуре.',
    specs: 'Чип: Apple M4 (опция M4 Pro)\nОЗУ: 16 ГБ (до 64 ГБ)\nПамять: от 256 ГБ SSD\nПорты: 2× Thunderbolt 4 спереди, 3× Thunderbolt сзади, HDMI, Ethernet\nРазмер: 12.7 × 12.7 × 5 см\nАудио: аудиоразъём 3.5 мм\nСвязь: Wi-Fi 7, Bluetooth 6\nПитание: встроенный блок питания',
    colors: [C.silver], storages: ST.mini,
    options: [CHIP_MINI, RAM_MINI, MINI_ETHERNET],
    hotDeal: false, hotDealPrice: null, hotDealUntil: null,
    images: [], createdAt: now - 1.4 * DAY
  },
  {
    id: 'mac-studio-m5-max', name: 'Mac Studio (M4 Max)', category: 'Mac',
    price: 239990, oldPrice: 0, badge: '', inStock: true,
    shortDesc: 'M4 Max / M3 Ultra, Thunderbolt 5, 10 Гбит Ethernet.',
    description: 'Настольная станция для профессионалов: чипы M4 Max и M3 Ultra, до 512 ГБ объединённой памяти, четыре порта Thunderbolt 5 и Ethernet 10 Гбит/с в компактном корпусе.',
    specs: 'Чип: Apple M4 Max (опция M3 Ultra)\nОЗУ: 36 ГБ (до 512 ГБ)\nПамять: от 512 ГБ SSD\nПорты: 4× Thunderbolt 5, 2× USB-A, HDMI, SDXC, Ethernet 10 Гбит/с\nРазмер: 19.7 × 19.7 × 9.5 см\nАудио: аудиоразъём для наушников высокого сопротивления\nСвязь: Wi-Fi 7, Bluetooth 6\nГотов к ИИ: Apple Intelligence в macOS 26',
    colors: [C.silver], storages: ST.studio,
    options: [CHIP_STUDIO, RAM_STUDIO],
    hotDeal: false, hotDealPrice: null, hotDealUntil: null,
    images: [], createdAt: now - 1.5 * DAY
  },
  {
    id: 'studio-display', name: 'Studio Display', category: 'Mac',
    price: 159990, oldPrice: 0, badge: '', inStock: true,
    shortDesc: 'Монитор 27" 5K Retina с камерой и динамиками.',
    description: 'Монитор 27" Retina 5K, созданный для Mac: 600 нит, широкий цвет P3, True Tone, камера Center Stage 12 Мп, три микрофона и шесть динамиков с поддержкой Spatial Audio.',
    specs: 'Экран: 27" Retina 5K, 600 нит, P3\nКамера: 12 Мп Center Stage\nАудио: 6 динамиков, Spatial Audio, 3 микрофона\nПорты: Thunderbolt 3, 3× USB-C\nПоддержка: подставка с наклоном (опция — регулировка высоты)\nПокрытие: стандартное или нанотекстурное',
    colors: [C.silver], storages: [],
    options: [OPT.glass(29990), OPT.stand(39990)],
    hotDeal: false, hotDealPrice: null, hotDealUntil: null,
    images: [], createdAt: now - 1.6 * DAY
  },
  {
    id: 'studio-display-xdr', name: 'Studio Display XDR', category: 'Mac',
    price: 289990, oldPrice: 0, badge: 'Новинка', inStock: true,
    shortDesc: 'Монитор 27" 5K XDR, mini-LED, 120 Гц.',
    description: 'Профессиональный монитор 27" Retina 5K XDR с подсветкой mini-LED: 1000 нит SDR и 2000 нит пиковой яркости HDR, частота 120 Гц и охват Adobe RGB для точной работы с цветом.',
    specs: 'Экран: 27" Retina 5K XDR, mini-LED\nЯркость: 1000 нит SDR, 2000 нит HDR\nЧастота: 120 Гц адаптивная\nЦвет: P3 и Adobe RGB\nКамера: 12 Мп Center Stage\nАудио: 6 динамиков, Spatial Audio\nПорты: Thunderbolt 5, 3× USB-C\nПокрытие: стандартное или нанотекстурное',
    colors: [C.silver], storages: [],
    options: [OPT.glass(44990), OPT.stand(59990)],
    hotDeal: false, hotDealPrice: null, hotDealUntil: null,
    images: [], createdAt: now - 1.7 * DAY
  },

  /* =============================== iPad =============================== */
  {
    id: 'ipad-pro-13-m5', name: 'iPad Pro 13" (M5)', category: 'iPad',
    price: 134990, oldPrice: 144990, badge: 'Хит', inStock: true,
    shortDesc: 'M5, Ultra Retina XDR OLED 13", Thunderbolt.',
    description: 'Самый мощный iPad. Чип M5, тандемный OLED-дисплей Ultra Retina XDR, толщина корпуса 5.1 мм, Thunderbolt и поддержка Apple Pencil Pro с Magic Keyboard.',
    specs: 'Экран: 13" Ultra Retina XDR OLED, ProMotion 120 Гц\nЧип: Apple M5\nОЗУ: 12 ГБ\nПамять: от 256 ГБ до 2 ТБ\nКамера: 12 Мп + LiDAR\nФронталка: 12 Мп Center Stage\nАвтономность: до 10 ч\nТолщина: 5.1 мм\nРазъём: USB-C с Thunderbolt / USB 4\nПоддержка: Apple Pencil Pro, Magic Keyboard\nСвязь: Wi-Fi 7, 5G (опция)\nApple Intelligence: тексты, Genmoji, обновлённая Siri',
    colors: IPAD_PRO, storages: ST.pad256,
    // Нанотекстура — только на 1 ТБ и 2 ТБ, как на apple.com/shop/buy-ipad
    options: [OPT.glass(15000, ['1 ТБ', '2 ТБ']), OPT.cellular(20000)],
    hotDeal: false, hotDealPrice: null, hotDealUntil: null,
    images: [], createdAt: now - 1.8 * DAY
  },
  {
    id: 'ipad-pro-11-m5', name: 'iPad Pro 11" (M5)', category: 'iPad',
    price: 104990, oldPrice: 114990, badge: '', inStock: true,
    shortDesc: 'M5, OLED 11", 5.3 мм, Apple Pencil Pro.',
    description: 'Компактный iPad Pro с чипом M5 и тандемным OLED-дисплеем Ultra Retina XDR. Толщина всего 5.3 мм при полной производительности Pro.',
    specs: 'Экран: 11" Ultra Retina XDR OLED, ProMotion 120 Гц\nЧип: Apple M5\nОЗУ: 12 ГБ\nПамять: от 256 ГБ до 2 ТБ\nКамера: 12 Мп + LiDAR\nФронталка: 12 Мп Center Stage\nАвтономность: до 10 ч\nТолщина: 5.3 мм\nРазъём: USB-C с Thunderbolt / USB 4\nПоддержка: Apple Pencil Pro, Magic Keyboard\nСвязь: Wi-Fi 7, 5G (опция)\nApple Intelligence: тексты, Genmoji, обновлённая Siri',
    colors: IPAD_PRO, storages: ST.pad256,
    options: [OPT.glass(15000, ['1 ТБ', '2 ТБ']), OPT.cellular(20000)],
    hotDeal: false, hotDealPrice: null, hotDealUntil: null,
    images: [], createdAt: now - 1.9 * DAY
  },
  {
    id: 'ipad-air-13-m4', name: 'iPad Air 13" (M4)', category: 'iPad',
    price: 79990, oldPrice: 89990, badge: '', inStock: true,
    shortDesc: 'M4, большой экран 13", четыре цвета.',
    description: 'Серьёзная производительность в тонком и легком корпусе. Чип M4, дисплей Liquid Retina 13", поддержка Apple Pencil Pro и клавиатуры Magic Keyboard.',
    specs: 'Экран: 13" Liquid Retina, 600 нит\nЧип: Apple M4\nОЗУ: 8 ГБ\nПамять: от 128 до 512 ГБ\nКамера: 12 Мп\nФронталка: 12 Мп Center Stage\nАвтономность: до 10 ч\nВес: 618 г\nРазъём: USB-C\nПоддержка: Apple Pencil Pro, Magic Keyboard\nСвязь: Wi-Fi 6E, 5G (опция)\nApple Intelligence: тексты, Genmoji, обновлённая Siri',
    colors: IPAD_AIR, storages: ST.pad128,
    options: [OPT.cellular(15000)],
    hotDeal: false, hotDealPrice: null, hotDealUntil: null,
    images: [], createdAt: now - 2 * DAY
  },
  {
    id: 'ipad-air-11-m4', name: 'iPad Air 11" (M4)', category: 'iPad',
    price: 59990, oldPrice: 66990, badge: 'Выбор покупателей', inStock: true,
    shortDesc: 'M4, 11", лёгкий и универсальный.',
    description: 'Универсальный iPad для учёбы, работы и творчества: чип M4, дисплей Liquid Retina 11", поддержка Apple Pencil Pro и Apple Intelligence.',
    specs: 'Экран: 11" Liquid Retina, 500 нит\nЧип: Apple M4\nОЗУ: 8 ГБ\nПамять: от 128 до 512 ГБ\nКамера: 12 Мп\nФронталка: 12 Мп Center Stage\nАвтономность: до 10 ч\nВес: 460 г\nРазъём: USB-C\nПоддержка: Apple Pencil Pro, Magic Keyboard\nСвязь: Wi-Fi 6E, 5G (опция)\nApple Intelligence: тексты, Genmoji, обновлённая Siri',
    colors: IPAD_AIR, storages: ST.pad128,
    options: [OPT.cellular(15000)],
    hotDeal: true, hotDealPrice: 55990, hotDealUntil: now + 2 * DAY,
    images: [], createdAt: now - 2.1 * DAY
  },
  {
    id: 'ipad-a16', name: 'iPad (A16)', category: 'iPad',
    price: 34990, oldPrice: 38990, badge: 'Выгодно', inStock: true,
    shortDesc: 'A16, 11", четыре цвета — самый доступный iPad.',
    description: 'Красочный iPad для повседневных дел. Чип A16, дисплей Liquid Retina 11", поддержка Apple Pencil (USB-C) и целый день автономной работы.',
    specs: 'Экран: 11" Liquid Retina, 500 нит\nЧип: Apple A16\nПамять: от 128 до 512 ГБ\nКамера: 12 Мп\nФронталка: 12 Мп Center Stage\nАвтономность: до 10 ч\nВес: 477 г\nРазъём: USB-C\nПоддержка: Apple Pencil (USB-C)\nСвязь: Wi-Fi 6, 5G (опция)',
    colors: IPAD_11, storages: ST.pad128,
    options: [OPT.cellular(12000)],
    hotDeal: false, hotDealPrice: null, hotDealUntil: null,
    images: [], createdAt: now - 2.2 * DAY
  },
  {
    id: 'ipad-mini-a17-pro', name: 'iPad mini (A17 Pro)', category: 'iPad',
    price: 49990, oldPrice: 54990, badge: '', inStock: true,
    shortDesc: 'A17 Pro, 8.3" — весь iPad в кармане.',
    description: 'Полноценный iPad в ультрапортативном формате. Чип A17 Pro с поддержкой Apple Intelligence, дисплей 8.3" и поддержка Apple Pencil Pro.',
    specs: 'Экран: 8.3" Liquid Retina, 500 нит\nЧип: Apple A17 Pro\nПамять: от 128 до 512 ГБ\nКамера: 12 Мп\nФронталка: 12 Мп Center Stage\nАвтономность: до 10 ч\nВес: 293 г\nРазъём: USB-C\nПоддержка: Apple Pencil Pro\nСвязь: Wi-Fi 6E, 5G (опция)\nApple Intelligence: тексты, Genmoji, обновлённая Siri',
    colors: IPAD_AIR, storages: ST.pad128,
    options: [OPT.cellular(15000)],
    hotDeal: false, hotDealPrice: null, hotDealUntil: null,
    images: [], createdAt: now - 2.3 * DAY
  },

  /* =========================== Apple Watch =========================== */
  {
    id: 'watch-series-11-alu', name: 'Apple Watch Series 11 (алюминий)', category: 'Apple Watch',
    price: 42990, oldPrice: 47990, badge: 'Хит', inStock: true,
    shortDesc: 'Уведомления о гипертонии, оценка сна, 5G.',
    description: 'Лучший способ следить за здоровьем: уведомления о признаках гипертонии, оценка качества сна, ЭКГ и кислород в крови. Экран в 2 раза устойчивее к царапинам, до 24 часов работы и связь 5G.',
    specs: 'Корпус: алюминий 42 или 46 мм\nЭкран: Always-On Retina, до 2000 нит\nЧип: S11 SiP\nАвтономность: до 24 ч\nНавигация: GPS\nЗащита: WR50, IP6X\nДатчики: Vitals — пульс, дыхание, температура, сон\nЗдоровье: уведомления о гипертонии\nСон: оценка сна и отслеживание фаз\nБезопасность: Emergency SOS, Fall Detection, Crash Detection\nСвязь: 5G (опция), Wi-Fi, Bluetooth 6\nЗарядка: быстрая, USB-C',
    colors: W_ALU, storages: ST.watch42,
    bands: BANDS.series,
    // алюминиевые Series 11 продаются в двух версиях: GPS и GPS + Cellular
    options: [OPT.watchCellular(9000)],
    hotDeal: false, hotDealPrice: null, hotDealUntil: null,
    images: [], createdAt: now - 2.4 * DAY
  },
  {
    id: 'watch-series-11-titan', name: 'Apple Watch Series 11 (титан)', category: 'Apple Watch',
    price: 72990, oldPrice: 0, badge: '', inStock: true,
    shortDesc: 'Титановый корпус, сапфировое стекло, 5G.',
    description: 'Series 11 в полированном титановом корпусе с сапфировым стеклом. Все функции здоровья флагманских часов и премиальные материалы в трёх оттенках.',
    specs: 'Корпус: титан 42 или 46 мм, сапфировое стекло\nЭкран: Always-On Retina, до 2000 нит\nЧип: S11 SiP\nАвтономность: до 24 ч\nНавигация: GPS\nЗащита: WR50, IP6X\nДатчики: Vitals — пульс, ЭКГ, кислород в крови, температура\nЗдоровье: уведомления о гипертонии\nСон: оценка сна и отслеживание фаз\nБезопасность: Emergency SOS, Fall Detection, Crash Detection\nСвязь: 5G, Wi-Fi, Bluetooth 6\nЗарядка: быстрая, USB-C',
    colors: W_TITAN, storages: ST.watch42,
    bands: BANDS.series.concat(BANDS.seriesTitan),
    hotDeal: false, hotDealPrice: null, hotDealUntil: null,
    images: [], createdAt: now - 2.5 * DAY
  },
  {
    id: 'watch-ultra-3', name: 'Apple Watch Ultra 3', category: 'Apple Watch',
    price: 89990, oldPrice: 99990, badge: '', inStock: true,
    shortDesc: 'Титан 49 мм, спутник, до 42 часов, WR100.',
    description: 'Часы для спорта и приключений. Титановый корпус 49 мм, самый большой дисплей Apple Watch, спутниковая связь и экстренный вызов SOS, до 42 часов работы и до 72 часов в режиме энергосбережения.',
    specs: 'Корпус: титан 49 мм\nЭкран: Always-On Retina, до 3000 нит\nЧип: S11 SiP\nАвтономность: до 42 ч (72 ч в экономном режиме)\nНавигация: двухчастотный GPS\nСвязь: 5G, спутниковые сообщения\nБезопасность: Emergency SOS, сирена 86 дБ\nДатчики: Vitals — пульс, ЭКГ, кислород, температура, глубиномер\nЗащита: WR100, погружения до 40 м, MIL-STD 810H\nСон: оценка сна и отслеживание фаз\nКнопки: Действие, двойное нажатие',
    colors: [{ name: 'Натуральный титан', hex: '#cfc9c0' }, { name: 'Чёрный титан', hex: '#2b2b2e' }],
    storages: [],
    bands: BANDS.ultra,
    hotDeal: false, hotDealPrice: null, hotDealUntil: null,
    images: [], createdAt: now - 2.6 * DAY
  },
  {
    id: 'watch-se-3', name: 'Apple Watch SE 3', category: 'Apple Watch',
    price: 27990, oldPrice: 31990, badge: 'Выгодно', inStock: true,
    shortDesc: 'Основные функции здоровья по приятной цене.',
    description: 'Все главные возможности Apple Watch за меньшие деньги: датчик температуры, уведомления об апноэ во время сна, определение аварии и до 18 часов работы.',
    specs: 'Корпус: алюминий 40 или 44 мм\nЭкран: Always-On Retina\nЧип: S10 SiP\nАвтономность: до 18 ч\nНавигация: GPS\nЗащита: WR50\nДатчики: пульс, температура, акселерометр\nСон: оценка сна и отслеживание фаз\nБезопасность: Emergency SOS, Crash Detection\nСвязь: LTE (опция), Wi-Fi, Bluetooth\nЗарядка: быстрая, USB-C',
    colors: [C.midnight, C.starlight], storages: ST.watch40,
    bands: BANDS.se,
    options: [OPT.watchCellular(7000)],
    hotDeal: false, hotDealPrice: null, hotDealUntil: null,
    images: [], createdAt: now - 2.7 * DAY
  },
  {
    id: 'watch-hermes-series-11', name: 'Apple Watch Hermès Series 11', category: 'Apple Watch',
    price: 149990, oldPrice: 0, badge: '', inStock: true,
    shortDesc: 'Титан, эксклюзивные ремешки и циферблаты Hermès.',
    description: 'Совместная модель Apple и Hermès: титановый корпус, кожаные ремешки ручной работы и эксклюзивные циферблаты, недоступные в других версиях.',
    specs: 'Корпус: титан 42 или 46 мм, сапфировое стекло\nЭкран: Always-On Retina, до 2000 нит\nЧип: S11 SiP\nАвтономность: до 24 ч\nНавигация: GPS\nЗащита: WR50, IP6X\nДатчики: Vitals — пульс, ЭКГ, кислород в крови\nЗдоровье: уведомления о гипертонии\nБезопасность: Emergency SOS, Fall Detection\nСвязь: 5G, Wi-Fi\nРемешки: эксклюзивные ремешки и циферблаты Hermès',
    colors: [{ name: 'Титан Hermès', hex: '#cfc9c0' }], storages: ST.watch42,
    bands: BANDS.hermes,
    hotDeal: false, hotDealPrice: null, hotDealUntil: null,
    images: [], createdAt: now - 2.8 * DAY
  },

  /* ============================== AirPods ============================== */
  {
    id: 'airpods-pro-3', name: 'AirPods Pro 3', category: 'AirPods',
    price: 22990, oldPrice: 25990, badge: 'Хит', inStock: true,
    shortDesc: 'Шумодав вдвое сильнее, пульсометр, IP57.',
    description: 'Активное шумоподавление вдвое эффективнее, чем у AirPods Pro 2, встроенный датчик пульса для тренировок, живой перевод и функции слухового аппарата. До 8 часов с включённым шумодавом.',
    specs: 'Чип: H2\nШумоподавление: активное, вдвое сильнее предыдущего\nДатчик пульса: есть\nАвтономность: до 8 ч (24 ч с кейсом)\nЗащита: IP57\nЗарядка: USB-C, MagSafe, Qi\nАудио: Spatial Audio с отслеживанием головы\nПоддержка: слуховой аппарат, проверка слуха, живой перевод\nКомплект: 5 размеров амбушюр',
    colors: [{ name: 'Белый', hex: '#f5f5f5' }], storages: [],
    hotDeal: true, hotDealPrice: 19990, hotDealUntil: now + 5 * DAY,
    images: [], createdAt: now - 2.9 * DAY
  },
  {
    // Обе версии AirPods 4 — одна карточка: у Apple это тоже один товар с
    // выбором «с шумоподавлением или без», а не две позиции в каталоге.
    // Базовая цена — версия без шумоподавления, доплата даёт прежние 17 990 ₽.
    id: 'airpods-4', name: 'AirPods 4', category: 'AirPods',
    price: 12990, oldPrice: 14990, badge: 'Выгодно', inStock: true,
    shortDesc: 'Чип H2, кейс USB-C — с шумоподавлением или без.',
    description: 'Обновлённая форма для удобной посадки, чип H2, пространственное аудио с отслеживанием головы и компактный кейс с USB-C. В версии с активным шумоподавлением добавляются адаптивный звук, живой перевод и кейс с беспроводной зарядкой и динамиком для поиска.',
    specs: 'Чип: H2\nШумоподавление: активное и адаптивный звук — в версии с шумоподавлением\nАвтономность: до 5 ч (20–30 ч с кейсом)\nЗащита: IP54\nЗарядка: USB-C, а в версии с шумоподавлением ещё Qi и Apple Watch\nАудио: Spatial Audio с отслеживанием головы\nПоддержка: проверка слуха, Voice Isolation, живой перевод\nДатчики: оптический, акселерометр\nСвязь: Bluetooth 5.3',
    colors: [{ name: 'Белый', hex: '#f5f5f5' }], storages: [],
    options: [AIRPODS_4_ANC],
    hotDeal: false, hotDealPrice: null, hotDealUntil: null,
    images: [], createdAt: now - 3 * DAY
  },
  {
    id: 'airpods-max-2', name: 'AirPods Max 2', category: 'AirPods',
    price: 54990, oldPrice: 59990, badge: 'Новинка', inStock: true,
    shortDesc: 'Полноразмерные, H2, Lossless по USB-C, 20 ч.',
    description: 'Полноразмерные наушники нового поколения: чип H2 в каждой чашке, шумоподавление в 1.5 раза сильнее, Lossless-аудио и минимальная задержка по USB-C. Пять цветов.',
    specs: 'Тип: полноразмерные\nЧип: H2 в каждой чашке\nШумоподавление: активное, в 1.5 раза сильнее\nАвтономность: до 20 ч\nЗарядка: USB-C\nАудио: Lossless и ультранизкая задержка по USB-C, Spatial Audio\nМикрофоны: 9 микрофонов\nПоддержка: живой перевод, Digital Crown\nВес: 386 г',
    colors: [C.midnight, C.starlight, C.blue, C.purple, { name: 'Оранжевый', hex: '#e8853c' }],
    storages: [],
    hotDeal: false, hotDealPrice: null, hotDealUntil: null,
    images: [], createdAt: now - 3.2 * DAY
  },

  /* ========================= Apple TV и Дом ========================= */
  {
    id: 'apple-tv-4k', name: 'Apple TV 4K', category: 'Apple TV и Дом',
    price: 12990, oldPrice: 14990, badge: '', inStock: true,
    shortDesc: 'A17 Pro, 4K Dolby Vision, Siri Remote.',
    description: 'Кинематографичный опыт Apple на большом экране: чип A17 Pro с поддержкой Apple Intelligence, 4K HDR с Dolby Vision и Dolby Atmos, Wi-Fi 7 и пульт Siri Remote с USB-C.',
    specs: 'Чип: A17 Pro\nОЗУ: 8 ГБ\nПамять: 64 или 128 ГБ\nВидео: 4K HDR, Dolby Vision, HDR10+\nАудио: Dolby Atmos, поддержка HomePod как колонок\nПорты: HDMI 2.1, Ethernet (в версии 128 ГБ)\nСвязь: Wi-Fi 7, Bluetooth, Thread\nПоддержка: Siri Remote с USB-C',
    colors: [{ name: 'Чёрный', hex: '#1c1c1e' }], storages: ST.tv,
    hotDeal: false, hotDealPrice: null, hotDealUntil: null,
    images: [], createdAt: now - 3.3 * DAY
  },
  {
    id: 'homepod-2', name: 'HomePod (2-е поколение)', category: 'Apple TV и Дом',
    price: 32990, oldPrice: 0, badge: '', inStock: true,
    shortDesc: 'Объёмный звук, Spatial Audio, датчики дома.',
    description: 'Умная колонка с глубоким басом и высокими частотами кристальной чистоты. Пространственное аудио, распознавание акустики помещения, датчики температуры и влажности, хаб для умного дома.',
    specs: 'Тип: умная колонка\nАудио: высокочастотный твитер массив, Spatial Audio, room sensing\nМикрофоны: 4 микрофона дальнего действия\nДатчики: температура и влажность\nСвязь: Wi-Fi 6, Bluetooth 5, Thread, Matter\nПоддержка: Siri, стереопара, AirPlay\nРазмер: 16.8 см высота',
    colors: [{ name: 'Белый', hex: '#f2f1ee' }, C.midnight], storages: [],
    hotDeal: false, hotDealPrice: null, hotDealUntil: null,
    images: [], createdAt: now - 3.4 * DAY
  },
  {
    id: 'homepod-mini', name: 'HomePod mini', category: 'Apple TV и Дом',
    price: 11990, oldPrice: 12990, badge: 'Выгодно', inStock: true,
    shortDesc: 'Компактная колонка, пять цветов, Matter.',
    description: 'Удивительный звук для своего размера. Пять цветов, объёмное звучание на 360°, второе поколение чипа Ultra Wideband для передачи музыки с iPhone и полноценный хаб умного дома.',
    specs: 'Тип: компактная умная колонка\nАудио: полнодиапазонный драйвер, звук на 360°\nМикрофоны: 4 микрофона\nСвязь: Wi-Fi, Bluetooth, Thread, Matter, Ultra Wideband\nПоддержка: Siri, стереопара, Intercom\nРазмер: 8.4 см высота\nПитание: USB-C',
    colors: HOMEPOD_MINI, storages: [],
    hotDeal: false, hotDealPrice: null, hotDealUntil: null,
    images: [], createdAt: now - 3.5 * DAY
  },

  /* =============================== Vision =============================== */
  {
    id: 'vision-pro-m5', name: 'Apple Vision Pro (M5)', category: 'Vision',
    price: 349990, oldPrice: 0, badge: '', inStock: true,
    shortDesc: 'Пространственный компьютер: M5, микро-OLED.',
    description: 'Пространственный компьютер Apple: два дисплея micro-OLED с 23 миллионами пикселей, чип M5 в паре с R1, управление глазами, руками и голосом. В комплекте новый ремень Dual Knit.',
    specs: 'Экран: два micro-OLED, 23 млн пикселей\nЧип: Apple M5 и R1\nПамять: от 256 ГБ до 1 ТБ\nАвтономность: до 2.5 ч (внешний аккумулятор)\nДатчики: 12 камер, 5 сенсоров, 6 микрофонов\nАудио: Spatial Audio с трекингом головы\nСвязь: Wi-Fi 6E, Bluetooth\nПоддержка: Optic ID, управление взглядом и жестами',
    colors: [{ name: 'Белый', hex: '#f2f1ee' }], storages: ST.vision,
    options: [ZEISS_INSERTS],
    hotDeal: false, hotDealPrice: null, hotDealUntil: null,
    images: [], createdAt: now - 3.6 * DAY
  },

  /* ============================ Аксессуары ============================ */
  {
    // Одна метка и набор из четырёх — одна карточка с выбором комплекта.
    // Базовая цена — одна метка; набор доплатой выходит в прежние 11 990 ₽,
    // то есть дешевле четырёх штук по отдельности (13 960 ₽).
    id: 'airtag', name: 'AirTag', category: 'Аксессуары',
    price: 3490, oldPrice: 0, badge: 'Выгодно', inStock: true,
    shortDesc: 'Метка для поиска вещей: по одной или набором из четырёх.',
    description: 'Прикрепите AirTag к ключам или рюкзаку — и находите их через приложение «Локатор». Точный поиск с указанием направления, звуковой сигнал и год работы от сменной батарейки. Набор из четырёх меток обойдётся дешевле, чем четыре покупки по отдельности.',
    specs: 'Тип: поисковая метка\nКомплект: одна метка или набор из четырёх\nСвязь: Bluetooth, Ultra Wideband, NFC\nАвтономность: около года (батарейка CR2032, сменная)\nЗащита: IP67\nПоддержка: точный поиск, сеть «Локатор», уведомления о расставании\nАудио: встроенный динамик\nВес: 11 г',
    colors: [{ name: 'Белый', hex: '#f5f5f5' }], storages: [],
    options: [AIRTAG_PACK],
    hotDeal: false, hotDealPrice: null, hotDealUntil: null,
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
  'watch-series-11-alu', 'watch-series-11-titan', 'watch-ultra-3', 'watch-se-3',
  'airpods-pro-3', 'airpods-4', 'airpods-max-2',
  'apple-tv-4k', 'homepod-mini', 'vision-pro-m5'
];

module.exports = { products, NOVELTY_IDS, colors: C, DAY, now };
