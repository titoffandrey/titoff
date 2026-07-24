'use strict';
// Демо-наполнение. Используется при первом запуске (если данных ещё нет) и командой `node seed.js`.
// ВНИМАНИЕ: цены — ориентировочные (уровень РФ-рынка, лето 2026), их легко поменять в админке.
// Товары можно менять здесь или прямо в админке. Для другого магазина достаточно заменить этот список.
// Варианты: colors = [{name, hex}], storages = [{label, add}] — add это доплата к базовой цене.
// Первый объём памяти всегда add:0 (равен базовой цене товара).

const DAY = 86400000;
const now = Date.now();

// --- Палитры цветов (переиспользуются) ---
const TITAN = [
  { name: 'Титановый чёрный', hex: '#3b3b3d' },
  { name: 'Титановый белый', hex: '#f2f1ec' },
  { name: 'Титановый натуральный', hex: '#c9c4bd' },
  { name: 'Титановый пустынный', hex: '#bfa48f' }
];
const IP16 = [
  { name: 'Чёрный', hex: '#1f2020' },
  { name: 'Белый', hex: '#f5f5f0' },
  { name: 'Розовый', hex: '#f2d4d8' },
  { name: 'Бирюзовый', hex: '#a7c8c4' },
  { name: 'Ультрамарин', hex: '#4b5ac4' }
];
const IP15 = [
  { name: 'Чёрный', hex: '#2b2b2d' },
  { name: 'Синий', hex: '#c9d4d6' },
  { name: 'Зелёный', hex: '#cad3c8' },
  { name: 'Жёлтый', hex: '#efe6c4' },
  { name: 'Розовый', hex: '#efd7d9' }
];
const MAC4 = [
  { name: 'Серебристый', hex: '#e3e4e6' },
  { name: 'Серый космос', hex: '#7d7e80' },
  { name: 'Сияющая звезда', hex: '#e8e0d0' },
  { name: 'Полуночный', hex: '#2e3641' }
];
const MACPRO = [
  { name: 'Космический чёрный', hex: '#35353a' },
  { name: 'Серебристый', hex: '#e3e4e6' }
];
const IPADAIR = [
  { name: 'Серый космос', hex: '#7d7e80' },
  { name: 'Синий', hex: '#7f95b8' },
  { name: 'Фиолетовый', hex: '#b7add0' },
  { name: 'Сияющая звезда', hex: '#e8e0d0' }
];

const products = [
  /* ===================== iPhone 17 ===================== */
  {
    id: 'iphone-17-pro-max', name: 'iPhone 17 Pro Max', category: 'iPhone',
    price: 144990, oldPrice: 154990, badge: 'Хит', inStock: true,
    shortDesc: 'A19 Pro, три камеры 48 Мп, экран 6.9".',
    description: 'Флагман линейки 17. Чип A19 Pro, все три камеры по 48 Мп с 4-кратным оптическим зумом, дисплей 6.9" яркостью до 3000 нит. Единственная модель с версией 2 ТБ.',
    specs: 'Экран: 6.9" OLED ProMotion 120 Гц, до 3000 нит\nЧип: A19 Pro\nКамеры: 48 Мп + 48 Мп СШУ + 48 Мп теле 4×\nМатериал: алюминий\nРазъём: USB-C 3',
    colors: [{ name: 'Космический оранжевый', hex: '#c75b2a' }, { name: 'Глубокий синий', hex: '#2e3f5c' }, { name: 'Серебристый', hex: '#e3e4e6' }],
    storages: [{ label: '256 ГБ', add: 0 }, { label: '512 ГБ', add: 12000 }, { label: '1 ТБ', add: 30000 }, { label: '2 ТБ', add: 60000 }],
    hotDeal: true, hotDealPrice: 134990, hotDealUntil: now + 3 * DAY,
    images: [], createdAt: now - 0.3 * DAY
  },
  {
    id: 'iphone-17-pro', name: 'iPhone 17 Pro', category: 'iPhone',
    price: 119990, oldPrice: 129990, badge: 'Новинка', inStock: true,
    shortDesc: 'A19 Pro, зум 4×, компактный флагман.',
    description: 'Компактный флагман: чип A19 Pro, три камеры 48 Мп, дисплей ProMotion 6.3" и улучшенное охлаждение в алюминиевом корпусе.',
    specs: 'Экран: 6.3" OLED ProMotion 120 Гц\nЧип: A19 Pro\nКамеры: 48 Мп + 48 Мп СШУ + 48 Мп теле 4×\nМатериал: алюминий\nРазъём: USB-C 3',
    colors: [{ name: 'Космический оранжевый', hex: '#c75b2a' }, { name: 'Глубокий синий', hex: '#2e3f5c' }, { name: 'Серебристый', hex: '#e3e4e6' }],
    storages: [{ label: '256 ГБ', add: 0 }, { label: '512 ГБ', add: 12000 }, { label: '1 ТБ', add: 30000 }],
    images: [], createdAt: now - 0.4 * DAY
  },
  {
    id: 'iphone-air', name: 'iPhone Air', category: 'iPhone',
    price: 104990, oldPrice: null, badge: 'Новинка', inStock: true,
    shortDesc: 'Тоньше всех: 5.6 мм, экран 6.5".',
    description: 'Самый тонкий iPhone в истории — около 5.6 мм и рекордно лёгкий. Дисплей ProMotion 6.5", чип A19 Pro и камера 48 Мп в титановой рамке.',
    specs: 'Экран: 6.5" OLED ProMotion 120 Гц\nЧип: A19 Pro\nКамера: 48 Мп\nТолщина: ~5.6 мм\nМатериал: титановая рамка\nРазъём: USB-C',
    colors: [{ name: 'Космический чёрный', hex: '#35353a' }, { name: 'Облачно-белый', hex: '#f2f1ec' }, { name: 'Светлое золото', hex: '#e6d6b8' }, { name: 'Небесно-голубой', hex: '#c3d3e2' }],
    storages: [{ label: '256 ГБ', add: 0 }, { label: '512 ГБ', add: 12000 }, { label: '1 ТБ', add: 30000 }],
    images: [], createdAt: now - 0.5 * DAY
  },
  {
    id: 'iphone-17', name: 'iPhone 17', category: 'iPhone',
    price: 89990, oldPrice: 94990, badge: '', inStock: true,
    shortDesc: 'A19, ProMotion наконец в базовой модели.',
    description: 'Базовая модель линейки 17 впервые получила дисплей ProMotion 120 Гц. Чип A19, камера 48 Мп и фронталка Center Stage 18 Мп.',
    specs: 'Экран: 6.3" OLED ProMotion 120 Гц\nЧип: A19\nКамера: 48 Мп + 12 Мп СШУ\nФронталка: 18 Мп Center Stage\nРазъём: USB-C',
    colors: [{ name: 'Чёрный', hex: '#1f2020' }, { name: 'Белый', hex: '#f5f5f0' }, { name: 'Лавандовый', hex: '#d4c8e0' }, { name: 'Шалфей', hex: '#b8c4ae' }, { name: 'Туманно-голубой', hex: '#b9c7d6' }],
    storages: [{ label: '256 ГБ', add: 0 }, { label: '512 ГБ', add: 12000 }],
    images: [], createdAt: now - 0.6 * DAY
  },

  /* ===================== iPhone 16 и старше ===================== */
  {
    id: 'iphone-16-pro-max', name: 'iPhone 16 Pro Max', category: 'iPhone',
    price: 114990, oldPrice: 139990, badge: 'Выгодно', inStock: true,
    shortDesc: 'Титан, A18 Pro, камера 48 Мп, экран 6.9".',
    description: 'Самый большой и мощный iPhone. Титановый корпус, чип A18 Pro, система камер Pro 48 Мп с 5-кратным зумом и кнопка Camera Control.',
    specs: 'Экран: 6.9" OLED ProMotion 120 Гц\nЧип: A18 Pro\nОсновная камера: 48 Мп + 48 Мп СШУ + 12 Мп теле 5×\nМатериал: титан\nРазъём: USB-C 3\nАвтономность: до 33 ч видео',
    colors: TITAN, storages: [{ label: '256 ГБ', add: 0 }, { label: '512 ГБ', add: 15000 }, { label: '1 ТБ', add: 35000 }],
    hotDeal: true, hotDealPrice: 107990, hotDealUntil: now + 3 * DAY,
    images: [], createdAt: now - 1 * DAY
  },
  {
    id: 'iphone-16-pro', name: 'iPhone 16 Pro', category: 'iPhone',
    price: 94990, oldPrice: 119990, badge: 'Выгодно', inStock: true,
    shortDesc: 'Титан, A18 Pro, кнопка Camera Control.',
    description: 'Флагман в компактном титановом корпусе. Чип A18 Pro, камера 48 Мп с 5-кратным зумом, дисплей ProMotion 120 Гц и кнопка Camera Control.',
    specs: 'Экран: 6.3" OLED ProMotion 120 Гц\nЧип: A18 Pro\nОсновная камера: 48 Мп + 48 Мп СШУ + 12 Мп теле\nМатериал: титан\nРазъём: USB-C 3',
    colors: TITAN, storages: [{ label: '128 ГБ', add: 0 }, { label: '256 ГБ', add: 10000 }, { label: '512 ГБ', add: 25000 }, { label: '1 ТБ', add: 45000 }],
    images: [], createdAt: now - 2 * DAY
  },
  {
    id: 'iphone-16-plus', name: 'iPhone 16 Plus', category: 'iPhone',
    price: 79990, oldPrice: 99990, badge: '', inStock: true,
    shortDesc: 'Большой экран 6.7", A18, Camera Control.',
    description: 'Большой дисплей, чип A18, обновлённая камера Fusion 48 Мп, кнопка Camera Control и увеличенная автономность.',
    specs: 'Экран: 6.7" OLED\nЧип: A18\nКамера: 48 Мп + 12 Мп СШУ\nРазъём: USB-C\nАвтономность: до 27 ч видео',
    colors: IP16, storages: [{ label: '128 ГБ', add: 0 }, { label: '256 ГБ', add: 8000 }, { label: '512 ГБ', add: 20000 }],
    images: [], createdAt: now - 3 * DAY
  },
  {
    id: 'iphone-16', name: 'iPhone 16', category: 'iPhone',
    price: 69990, oldPrice: 84990, badge: '', inStock: true,
    shortDesc: 'A18, Camera Control, 5 цветов.',
    description: 'Чип A18, камера Fusion 48 Мп, кнопка Camera Control и кнопка «Действие». Пять ярких цветов корпуса.',
    specs: 'Экран: 6.1" OLED\nЧип: A18\nКамера: 48 Мп + 12 Мп СШУ\nРазъём: USB-C\nКнопки: Действие, Camera Control',
    colors: IP16, storages: [{ label: '128 ГБ', add: 0 }, { label: '256 ГБ', add: 8000 }, { label: '512 ГБ', add: 20000 }],
    images: [], createdAt: now - 4 * DAY
  },
  {
    id: 'iphone-16e', name: 'iPhone 16e', category: 'iPhone',
    price: 54990, oldPrice: null, badge: 'Выгодно', inStock: true,
    shortDesc: 'A18, доступный флагманский чип.',
    description: 'Доступный iPhone с флагманским чипом A18, камерой 48 Мп и рекордной автономностью. Два лаконичных цвета.',
    specs: 'Экран: 6.1" OLED\nЧип: A18\nКамера: 48 Мп\nРазъём: USB-C\nАвтономность: до 26 ч видео',
    colors: [{ name: 'Чёрный', hex: '#1f2020' }, { name: 'Белый', hex: '#f5f5f0' }],
    storages: [{ label: '128 ГБ', add: 0 }, { label: '256 ГБ', add: 8000 }, { label: '512 ГБ', add: 18000 }],
    images: [], createdAt: now - 5 * DAY
  },
  {
    id: 'iphone-15', name: 'iPhone 15', category: 'iPhone',
    price: 62990, oldPrice: 74990, badge: '', inStock: true,
    shortDesc: 'Dynamic Island, камера 48 Мп, USB-C.',
    description: 'Динамический остров, чип A16 Bionic, основная камера 48 Мп и разъём USB-C. Отличный выбор по сниженной цене.',
    specs: 'Экран: 6.1" OLED\nЧип: A16 Bionic\nКамера: 48 Мп + 12 Мп СШУ\nРазъём: USB-C',
    colors: IP15, storages: [{ label: '128 ГБ', add: 0 }, { label: '256 ГБ', add: 8000 }, { label: '512 ГБ', add: 18000 }],
    hotDeal: true, hotDealPrice: 57990, hotDealUntil: now + 4 * DAY,
    images: [], createdAt: now - 6 * DAY
  },
  {
    id: 'iphone-14', name: 'iPhone 14', category: 'iPhone',
    price: 46990, oldPrice: null, badge: '', inStock: true,
    shortDesc: 'Надёжный выбор по доступной цене.',
    description: 'Проверенный временем iPhone: чип A15 Bionic, двойная камера и до 20 часов воспроизведения видео.',
    specs: 'Экран: 6.1" OLED\nЧип: A15 Bionic\nКамера: 12 Мп + 12 Мп\nРазъём: Lightning',
    colors: [{ name: 'Тёмная ночь', hex: '#25292d' }, { name: 'Сияющая звезда', hex: '#e8e0d0' }, { name: 'Синий', hex: '#a7bcd6' }, { name: 'Фиолетовый', hex: '#d5cfe0' }, { name: '(PRODUCT)RED', hex: '#b71b2b' }],
    storages: [{ label: '128 ГБ', add: 0 }, { label: '256 ГБ', add: 7000 }],
    images: [], createdAt: now - 7 * DAY
  },

  /* ===================== Mac ===================== */
  {
    id: 'macbook-air-13-m3', name: 'MacBook Air 13" M3', category: 'Mac',
    price: 109990, oldPrice: null, badge: 'Хит', inStock: true,
    shortDesc: 'Тонкий, лёгкий, до 18 часов работы.',
    description: 'Ультратонкий бесшумный ноутбук на чипе M3. До 18 часов автономности, дисплей Liquid Retina, поддержка двух внешних мониторов.',
    specs: 'Экран: 13.6" Liquid Retina\nЧип: Apple M3 (8 CPU / 10 GPU)\nОЗУ: 8 ГБ\nВес: 1.24 кг',
    colors: MAC4, storages: [{ label: '256 ГБ SSD', add: 0 }, { label: '512 ГБ SSD', add: 15000 }, { label: '1 ТБ SSD', add: 35000 }],
    images: [], createdAt: now - 8 * DAY
  },
  {
    id: 'macbook-air-15-m3', name: 'MacBook Air 15" M3', category: 'Mac',
    price: 134990, oldPrice: 144990, badge: '', inStock: true,
    shortDesc: 'Большой экран 15.3", чип M3.',
    description: 'Просторный дисплей Liquid Retina 15.3", чип M3, шестидинамиковая аудиосистема и до 18 часов работы в тонком корпусе.',
    specs: 'Экран: 15.3" Liquid Retina\nЧип: Apple M3\nОЗУ: 8 ГБ\nВес: 1.51 кг',
    colors: MAC4, storages: [{ label: '256 ГБ SSD', add: 0 }, { label: '512 ГБ SSD', add: 15000 }, { label: '1 ТБ SSD', add: 35000 }],
    images: [], createdAt: now - 9 * DAY
  },
  {
    id: 'macbook-pro-14-m4', name: 'MacBook Pro 14" M4', category: 'Mac',
    price: 179990, oldPrice: null, badge: '', inStock: true,
    shortDesc: 'Дисплей XDR 120 Гц, чип M4.',
    description: 'Профессиональный ноутбук с дисплеем Liquid Retina XDR, чипом M4, портами Thunderbolt 4, HDMI и SD. Опция Nano-texture.',
    specs: 'Экран: 14.2" Liquid Retina XDR 120 Гц\nЧип: Apple M4\nОЗУ: 16 ГБ\nПорты: 3× Thunderbolt 4, HDMI, SD',
    colors: MACPRO, storages: [{ label: '512 ГБ SSD', add: 0 }, { label: '1 ТБ SSD', add: 25000 }, { label: '2 ТБ SSD', add: 60000 }],
    images: [], createdAt: now - 10 * DAY
  },
  {
    id: 'macbook-pro-16-m4-pro', name: 'MacBook Pro 16" M4 Pro', category: 'Mac',
    price: 279990, oldPrice: null, badge: 'Топ', inStock: true,
    shortDesc: 'Максимальная мощь, экран 16.2" XDR.',
    description: 'Флагманский ноутбук для профессионалов: чип M4 Pro, огромный дисплей Liquid Retina XDR 120 Гц и до 24 часов автономности.',
    specs: 'Экран: 16.2" Liquid Retina XDR 120 Гц\nЧип: Apple M4 Pro\nОЗУ: 24 ГБ\nПорты: 3× Thunderbolt 5, HDMI, SD',
    colors: MACPRO, storages: [{ label: '512 ГБ SSD', add: 0 }, { label: '1 ТБ SSD', add: 25000 }, { label: '2 ТБ SSD', add: 60000 }],
    images: [], createdAt: now - 11 * DAY
  },
  {
    id: 'imac-24-m4', name: 'iMac 24" M4', category: 'Mac',
    price: 149990, oldPrice: null, badge: '', inStock: true,
    shortDesc: 'Яркий 4.5K дисплей, 7 цветов.',
    description: 'Моноблок на чипе M4 с дисплеем 4.5K Retina, камерой Center Stage и цветными аксессуарами в тон.',
    specs: 'Экран: 24" 4.5K Retina\nЧип: Apple M4\nОЗУ: 16 ГБ\nКамера: 12 Мп Center Stage',
    colors: [{ name: 'Синий', hex: '#7f95b8' }, { name: 'Зелёный', hex: '#a7c0a0' }, { name: 'Розовый', hex: '#e6c3c6' }, { name: 'Серебристый', hex: '#e3e4e6' }],
    storages: [{ label: '256 ГБ SSD', add: 0 }, { label: '512 ГБ SSD', add: 15000 }, { label: '1 ТБ SSD', add: 35000 }],
    images: [], createdAt: now - 12 * DAY
  },
  {
    id: 'mac-mini-m4', name: 'Mac mini M4', category: 'Mac',
    price: 54990, oldPrice: null, badge: 'Выгодно', inStock: true,
    shortDesc: 'Компактный настольный на M4.',
    description: 'Самый компактный настольный Mac. Чип M4, порты Thunderbolt спереди и сзади. Просто подключите монитор и клавиатуру.',
    specs: 'Чип: Apple M4\nОЗУ: 16 ГБ\nПорты: 2× Thunderbolt 4 спереди, 3× Thunderbolt сзади, HDMI\nРазмер: 12.7 см',
    colors: [], storages: [{ label: '256 ГБ SSD', add: 0 }, { label: '512 ГБ SSD', add: 20000 }, { label: '1 ТБ SSD', add: 40000 }],
    images: [], createdAt: now - 13 * DAY
  },
  {
    id: 'mac-studio-m4-max', name: 'Mac Studio M4 Max', category: 'Mac',
    price: 259990, oldPrice: null, badge: '', inStock: true,
    shortDesc: 'Рабочая станция для профи.',
    description: 'Компактная рабочая станция с чипом M4 Max для тяжёлых задач: монтаж 8K, 3D и разработка. Множество портов Thunderbolt 5.',
    specs: 'Чип: Apple M4 Max\nОЗУ: 36 ГБ\nПорты: 4× Thunderbolt 5, 2× USB-A, HDMI, SD, 10Gb Ethernet',
    colors: [], storages: [{ label: '512 ГБ SSD', add: 0 }, { label: '1 ТБ SSD', add: 30000 }, { label: '2 ТБ SSD', add: 75000 }],
    images: [], createdAt: now - 14 * DAY
  },

  /* ===================== iPad ===================== */
  {
    id: 'ipad-pro-13-m4', name: 'iPad Pro 13" M4', category: 'iPad',
    price: 139990, oldPrice: null, badge: 'Топ', inStock: true,
    shortDesc: 'Ultra Retina OLED, чип M4.',
    description: 'Самый тонкий продукт Apple. Дисплей Ultra Retina XDR на технологии Tandem OLED, чип M4 и поддержка Apple Pencil Pro.',
    specs: 'Экран: 13" Ultra Retina XDR OLED\nЧип: Apple M4\nРазъём: USB-C / Thunderbolt\nПоддержка: Apple Pencil Pro',
    colors: [{ name: 'Серебристый', hex: '#e3e4e6' }, { name: 'Космический чёрный', hex: '#35353a' }],
    storages: [{ label: '256 ГБ', add: 0 }, { label: '512 ГБ', add: 20000 }, { label: '1 ТБ', add: 60000 }],
    images: [], createdAt: now - 15 * DAY
  },
  {
    id: 'ipad-pro-11-m4', name: 'iPad Pro 11" M4', category: 'iPad',
    price: 109990, oldPrice: null, badge: '', inStock: true,
    shortDesc: 'Ultra Retina OLED, чип M4, компактный.',
    description: 'Компактный iPad Pro с дисплеем Tandem OLED и чипом M4. Поддержка Apple Pencil Pro и клавиатуры Magic Keyboard.',
    specs: 'Экран: 11" Ultra Retina XDR OLED\nЧип: Apple M4\nРазъём: USB-C / Thunderbolt',
    colors: [{ name: 'Серебристый', hex: '#e3e4e6' }, { name: 'Космический чёрный', hex: '#35353a' }],
    storages: [{ label: '256 ГБ', add: 0 }, { label: '512 ГБ', add: 20000 }, { label: '1 ТБ', add: 60000 }],
    images: [], createdAt: now - 16 * DAY
  },
  {
    id: 'ipad-air-13-m2', name: 'iPad Air 13" M2', category: 'iPad',
    price: 89990, oldPrice: null, badge: '', inStock: true,
    shortDesc: 'Большой экран, чип M2, Pencil Pro.',
    description: 'Большой лёгкий планшет на чипе M2 с поддержкой Apple Pencil Pro. Отлично для работы, учёбы и творчества.',
    specs: 'Экран: 13" Liquid Retina\nЧип: Apple M2\nПоддержка: Apple Pencil Pro, Magic Keyboard',
    colors: IPADAIR, storages: [{ label: '128 ГБ', add: 0 }, { label: '256 ГБ', add: 12000 }, { label: '512 ГБ', add: 30000 }],
    images: [], createdAt: now - 17 * DAY
  },
  {
    id: 'ipad-air-11-m2', name: 'iPad Air 11" M2', category: 'iPad',
    price: 69990, oldPrice: 74990, badge: '', inStock: true,
    shortDesc: 'Чип M2, поддержка Apple Pencil Pro.',
    description: 'Лёгкий и мощный планшет на чипе M2. Поддержка Apple Pencil Pro и клавиатуры Magic Keyboard в четырёх цветах.',
    specs: 'Экран: 11" Liquid Retina\nЧип: Apple M2\nПоддержка: Apple Pencil Pro',
    colors: IPADAIR, storages: [{ label: '128 ГБ', add: 0 }, { label: '256 ГБ', add: 12000 }, { label: '512 ГБ', add: 30000 }],
    images: [], createdAt: now - 18 * DAY
  },
  {
    id: 'ipad-mini-7', name: 'iPad mini 7', category: 'iPad',
    price: 54990, oldPrice: null, badge: '', inStock: true,
    shortDesc: 'Компактный 8.3", чип A17 Pro.',
    description: 'Компактный планшет с чипом A17 Pro и поддержкой Apple Pencil Pro. Помещается в одной руке.',
    specs: 'Экран: 8.3" Liquid Retina\nЧип: A17 Pro\nПоддержка: Apple Pencil Pro\nРазъём: USB-C',
    colors: [{ name: 'Серый космос', hex: '#7d7e80' }, { name: 'Синий', hex: '#7f95b8' }, { name: 'Фиолетовый', hex: '#b7add0' }, { name: 'Сияющая звезда', hex: '#e8e0d0' }],
    storages: [{ label: '128 ГБ', add: 0 }, { label: '256 ГБ', add: 15000 }],
    images: [], createdAt: now - 19 * DAY
  },
  {
    id: 'ipad-10', name: 'iPad 10-го поколения', category: 'iPad',
    price: 39990, oldPrice: null, badge: 'Выгодно', inStock: true,
    shortDesc: 'Яркие цвета, USB-C, для всей семьи.',
    description: 'Универсальный планшет для учёбы и развлечений. Дисплей Liquid Retina 10.9", разъём USB-C и четыре сочных цвета.',
    specs: 'Экран: 10.9" Liquid Retina\nЧип: A14 Bionic\nРазъём: USB-C\nПоддержка: Apple Pencil (USB-C)',
    colors: [{ name: 'Синий', hex: '#7f95b8' }, { name: 'Розовый', hex: '#e6c3c6' }, { name: 'Жёлтый', hex: '#efe6c4' }, { name: 'Серебристый', hex: '#e3e4e6' }],
    storages: [{ label: '64 ГБ', add: 0 }, { label: '256 ГБ', add: 12000 }],
    images: [], createdAt: now - 20 * DAY
  },

  /* ===================== Apple Watch ===================== */
  {
    id: 'watch-series-10', name: 'Apple Watch Series 10 46 мм', category: 'Apple Watch',
    price: 44990, oldPrice: 47990, badge: 'Новинка', inStock: true,
    shortDesc: 'Тоньше и легче, большой дисплей.',
    description: 'Самые тонкие часы Apple с большим дисплеем LTPO3, быстрой зарядкой и датчиками здоровья. Жест «двойное касание».',
    specs: 'Корпус: 46 мм алюминий\nЧип: S10 SiP\nДатчики: пульс, ЭКГ, кислород, температура\nЗащита: WR50\nБыстрая зарядка',
    colors: [{ name: 'Тёмная ночь', hex: '#25292d' }, { name: 'Розовое золото', hex: '#e6c9c1' }, { name: 'Серебристый', hex: '#e3e4e6' }],
    storages: [], hotDeal: true, hotDealPrice: 39990, hotDealUntil: now + 5 * DAY,
    images: [], createdAt: now - 21 * DAY
  },
  {
    id: 'watch-ultra-2', name: 'Apple Watch Ultra 2', category: 'Apple Watch',
    price: 79990, oldPrice: null, badge: '', inStock: true,
    shortDesc: 'Титан, до 36 часов автономности.',
    description: 'Самые прочные и функциональные часы Apple. Титановый корпус 49 мм, кнопка «Действие», яркость 3000 нит, GPS двухдиапазонный.',
    specs: 'Корпус: 49 мм титан\nАвтономность: до 36 ч (72 ч эконом)\nЯркость: 3000 нит\nЗащита: WR100, MIL-STD 810H',
    colors: [{ name: 'Натуральный титан', hex: '#c9c4bd' }, { name: 'Чёрный титан', hex: '#3b3b3d' }],
    storages: [], images: [], createdAt: now - 22 * DAY
  },
  {
    id: 'watch-se-2', name: 'Apple Watch SE 44 мм', category: 'Apple Watch',
    price: 27990, oldPrice: null, badge: 'Выгодно', inStock: true,
    shortDesc: 'Все основные функции по доступной цене.',
    description: 'Доступные умные часы с датчиком пульса, уведомлениями о падении и аварии, отслеживанием сна и тренировок.',
    specs: 'Корпус: 44 мм алюминий\nЧип: S8 SiP\nДатчики: пульс, акселерометр\nЗащита: WR50',
    colors: [{ name: 'Тёмная ночь', hex: '#25292d' }, { name: 'Сияющая звезда', hex: '#e8e0d0' }, { name: 'Серебристый', hex: '#e3e4e6' }],
    storages: [], images: [], createdAt: now - 23 * DAY
  },

  /* ===================== AirPods и звук ===================== */
  {
    id: 'airpods-pro-2', name: 'AirPods Pro 2 (USB-C)', category: 'AirPods',
    price: 22990, oldPrice: 24990, badge: '−8%', inStock: true,
    shortDesc: 'Активное шумоподавление, USB-C.',
    description: 'Наушники с активным шумоподавлением нового поколения, адаптивным звуком, режимом «Прозрачность» и зарядкой USB-C.',
    specs: 'Чип: H2\nШумоподавление: активное\nЗарядка: USB-C, MagSafe, Qi\nАвтономность: до 6 ч (30 ч с кейсом)',
    colors: [], storages: [], hotDeal: true, hotDealPrice: 18990, hotDealUntil: now + 2 * DAY,
    images: [], createdAt: now - 24 * DAY
  },
  {
    id: 'airpods-4-anc', name: 'AirPods 4 с шумоподавлением', category: 'AirPods',
    price: 19990, oldPrice: null, badge: 'Новинка', inStock: true,
    shortDesc: 'Открытая посадка + активный шумодав.',
    description: 'Открытые наушники нового дизайна с чипом H2, активным шумоподавлением и пространственным аудио. Компактный кейс с USB-C.',
    specs: 'Чип: H2\nШумоподавление: активное\nПространственное аудио: да\nЗарядка: USB-C',
    colors: [], storages: [], images: [], createdAt: now - 25 * DAY
  },
  {
    id: 'airpods-4', name: 'AirPods 4', category: 'AirPods',
    price: 14990, oldPrice: null, badge: '', inStock: true,
    shortDesc: 'Новый дизайн, пространственное аудио.',
    description: 'Обновлённые открытые наушники с чипом H2, улучшенным звуком и персонализированным пространственным аудио.',
    specs: 'Чип: H2\nПространственное аудио: да\nЗарядка: USB-C\nАвтономность: до 5 ч (30 ч с кейсом)',
    colors: [], storages: [], images: [], createdAt: now - 26 * DAY
  },
  {
    id: 'airpods-max-usbc', name: 'AirPods Max (USB-C)', category: 'AirPods',
    price: 54990, oldPrice: null, badge: '', inStock: true,
    shortDesc: 'Полноразмерные, 5 цветов, USB-C.',
    description: 'Полноразмерные наушники высокой чёткости с активным шумоподавлением, пространственным аудио и разъёмом USB-C. Пять цветов.',
    specs: 'Тип: полноразмерные\nШумоподавление: активное\nПространственное аудио: да\nЗарядка: USB-C\nАвтономность: до 20 ч',
    colors: [{ name: 'Полуночный', hex: '#2e3641' }, { name: 'Синий', hex: '#7f95b8' }, { name: 'Фиолетовый', hex: '#b7add0' }, { name: 'Розовый', hex: '#e6c3c6' }, { name: 'Сияющая звезда', hex: '#e8e0d0' }],
    storages: [], images: [], createdAt: now - 27 * DAY
  }
];

// Демо-отзывы. Аспекты: delivery (доставка), service (обслуживание), price (цена/качество), 1–5.
const reviews = [
  { id: 'r16', productId: 'iphone-17-pro-max', author: 'Владимир', rating: 5, text: 'Оранжевый цвет вживую смотрится дорого. Зум 4× на все 48 Мп — фото ночью заметно лучше, чем на 15 Pro. Доставили за день.', aspects: { delivery: 5, service: 5, price: 4 }, photos: [], status: 'approved', createdAt: now - 1 * DAY },
  { id: 'r17', productId: 'iphone-17-pro-max', author: 'Анна С.', rating: 4, text: 'Телефон супер, но ждала неделю нужный цвет — на складе был только серебристый. Менеджер честно предупредил о сроках.', aspects: { delivery: 3, service: 5, price: 4 }, photos: [], status: 'approved', createdAt: now - 3 * DAY },
  { id: 'r18', productId: 'iphone-air', author: 'Кирилл', rating: 5, text: 'Он реально невесомый, в кармане не чувствуется. Батареи хватает на день при моём сценарии. Цена приятнее, чем у Pro.', aspects: { delivery: 5, service: 4, price: 5 }, photos: [], status: 'approved', createdAt: now - 2 * DAY },
  { id: 'r19', productId: 'iphone-17', author: 'Светлана', rating: 5, text: 'Наконец 120 Гц в обычной модели! Взяла лавандовый, очень довольна. Оформили быстро, привезли вовремя.', aspects: { delivery: 5, service: 5, price: 5 }, photos: [], status: 'approved', createdAt: now - 4 * DAY },
  { id: 'r1', productId: 'iphone-16-pro-max', author: 'Алексей М.', rating: 5, text: 'Титан реально приятнее в руке. Камера с 5-кратным зумом огонь, батарея держит весь день. Привезли на следующий день.', aspects: { delivery: 5, service: 5, price: 4 }, photos: [], status: 'approved', createdAt: now - 2 * DAY },
  { id: 'r2', productId: 'iphone-16-pro-max', author: 'Ирина В.', rating: 4, text: 'Телефон отличный, всё честно и запечатано. Немного ждала доставку из-за нужного цвета, но менеджер держал в курсе.', aspects: { delivery: 3, service: 5, price: 4 }, photos: [], status: 'approved', createdAt: now - 5 * DAY },
  { id: 'r3', productId: 'iphone-16-pro', author: 'Дмитрий', rating: 5, text: 'Взял на 256, кнопка Camera Control удобная. Консультант помог выбрать между Pro и Pro Max, спасибо.', aspects: { delivery: 5, service: 5, price: 5 }, photos: [], status: 'approved', createdAt: now - 4 * DAY },
  { id: 'r4', productId: 'iphone-16', author: 'Максим', rating: 3, text: 'Сам телефон норм, но брал месяц назад дороже — сейчас вижу скидку и немного обидно. Работает без нареканий.', aspects: { delivery: 4, service: 4, price: 2 }, photos: [], status: 'approved', createdAt: now - 6 * DAY },
  { id: 'r5', productId: 'iphone-15', author: 'Екатерина', rating: 5, text: 'За свои деньги — топ. USB-C наконец-то, цвет синий очень красивый вживую.', aspects: { delivery: 5, service: 4, price: 5 }, photos: [], status: 'approved', createdAt: now - 3 * DAY },
  { id: 'r6', productId: 'macbook-air-13-m3', author: 'Сергей П.', rating: 5, text: 'Тихий, лёгкий, тянет всё для работы и монтажа. Автономность шикарная. Доставка курьером до двери.', aspects: { delivery: 5, service: 5, price: 4 }, photos: [], status: 'approved', createdAt: now - 4 * DAY },
  { id: 'r7', productId: 'macbook-air-13-m3', author: 'Ольга К.', rating: 4, text: 'Перешла с Windows, привыкаю. Ноутбук классный, но хотелось бы 512 сразу — 256 маловато.', aspects: { delivery: 4, service: 5, price: 3 }, photos: [], status: 'approved', createdAt: now - 7 * DAY },
  { id: 'r8', productId: 'macbook-pro-14-m4', author: 'Андрей', rating: 5, text: 'Машина зверь для рендера. Проверили при мне, всё завелось идеально. Рекомендую магазин.', aspects: { delivery: 5, service: 5, price: 4 }, photos: [], status: 'approved', createdAt: now - 8 * DAY },
  { id: 'r9', productId: 'airpods-pro-2', author: 'Никита', rating: 5, text: 'Шумодав топ, в метро вообще ничего не слышно. За акционную цену просто отлично.', aspects: { delivery: 5, service: 4, price: 5 }, photos: [], status: 'approved', createdAt: now - 3 * DAY },
  { id: 'r10', productId: 'airpods-pro-2', author: 'Гость', rating: 4, text: 'Наушники хорошие, но кейс поцарапался в кармане быстро. Звук и шумодав претензий нет.', aspects: { delivery: 4, service: 4, price: 4 }, photos: [], status: 'approved', createdAt: now - 10 * DAY },
  { id: 'r11', productId: 'watch-ultra-2', author: 'Павел', rating: 5, text: 'Ношу на тренировках и в горах — держат заряд по два дня. Крепкие, титан не царапается.', aspects: { delivery: 5, service: 5, price: 4 }, photos: [], status: 'approved', createdAt: now - 6 * DAY },
  { id: 'r12', productId: 'ipad-pro-13-m4', author: 'Марина', rating: 4, text: 'Экран нереальный, OLED видно сразу. Чехол пришлось докупать отдельно, но это мелочь.', aspects: { delivery: 4, service: 4, price: 3 }, photos: [], status: 'approved', createdAt: now - 8 * DAY },
  { id: 'r13', productId: 'watch-series-10', author: 'Юлия', rating: 5, text: 'Тонкие и лёгкие, заряжаются быстро. Пришли на день раньше срока, приятно.', aspects: { delivery: 5, service: 5, price: 5 }, photos: [], status: 'approved', createdAt: now - 2 * DAY },
  // На модерации (видны только в админке-владельце):
  { id: 'r14', productId: 'iphone-16', author: 'Гость', rating: 5, text: 'Пришёл запечатанный, всё работает. Спасибо!', aspects: null, photos: [], status: 'pending', createdAt: now - 12 * 3600000 },
  { id: 'r15', productId: 'macbook-pro-16-m4-pro', author: 'Аноним', rating: 5, text: 'Тестовый отзыв на модерации — проверка панели.', aspects: null, photos: [], status: 'pending', createdAt: now - 3 * 3600000 }
];

// Демо-домены (мультитенант). На VPS в hosts указывают реальные домены.
const sites = [
  {
    id: 'site-a', hosts: ['localhost', '127.0.0.1'],
    storeName: 'iStore', tagline: 'Оригинальная техника Apple с гарантией',
    accentColor: '#0071e3', currency: '₽', currencyPosition: 'after',
    priceMultiplier: 1, adminUsername: 'admin', adminPassword: 'admin',
    footerNote: 'iStore — официальная гарантия и быстрая доставка'
  },
  {
    id: 'site-b', hosts: ['shop-b.local'],
    storeName: 'ТехноМаркет', tagline: 'Apple по выгодным ценам, доставка по всей стране',
    accentColor: '#ff2d55', currency: '₽', currencyPosition: 'after',
    priceMultiplier: 1.15, adminUsername: 'admin', adminPassword: 'admin',
    logoText: '{Техно}Маркет', logoFont: 'grotesk', secondaryColor: '#ff2d55',
    footerNote: 'ТехноМаркет — ваш магазин техники'
  },
  {
    id: 'site-c', hosts: ['shop-c.local'],
    storeName: 'AppleZone', tagline: 'Всё для твоей экосистемы Apple',
    accentColor: '#34c759', currency: '₽', currencyPosition: 'after',
    priceMultiplier: 0.95, adminUsername: 'admin', adminPassword: 'admin',
    logoText: 'Apple{Zone}', logoFont: 'rounded', secondaryColor: '#34c759',
    footerNote: 'AppleZone'
  }
];

// Актуальные новинки Apple (2025–2026), общий модуль с add-novinki.js
products.push(...require('./new-products'));

module.exports = {
  settings: {
    storeName: 'iStore',
    tagline: 'Оригинальная техника Apple с гарантией и быстрой доставкой',
    footerNote: 'Демонстрационный магазин. Замените текст и товары под свой бренд.'
  },
  products,
  reviews,
  sites
};
