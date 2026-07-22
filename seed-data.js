'use strict';
// Демо-наполнение. Используется при первом запуске (если данных ещё нет) и командой `npm run seed`.
// Товары можно менять здесь или прямо в админке. Для другого магазина достаточно заменить этот список.

const DAY = 86400000;
const now = Date.now();

const products = [
  {
    id: 'iphone-15-pro', name: 'iPhone 15 Pro 256 ГБ', category: 'iPhone',
    price: 119990, oldPrice: 129990, badge: 'Хит', inStock: true,
    shortDesc: 'Титановый корпус, чип A17 Pro, камера 48 Мп.',
    description: 'Флагман Apple в титановом корпусе. Кнопка «Действие», порт USB-C, дисплей ProMotion 120 Гц и самый производительный мобильный чип A17 Pro.',
    specs: 'Экран: 6.1" OLED ProMotion\nЧип: A17 Pro\nПамять: 256 ГБ\nОсновная камера: 48 Мп\nМатериал: титан\nРазъём: USB-C',
    hotDeal: true, hotDealPrice: 109990, hotDealUntil: now + 3 * DAY,
    images: [], createdAt: now - 1 * DAY
  },
  {
    id: 'iphone-15', name: 'iPhone 15 128 ГБ', category: 'iPhone',
    price: 84990, oldPrice: null, badge: '', inStock: true,
    shortDesc: 'Dynamic Island, камера 48 Мп, USB-C.',
    description: 'Динамический остров, мощный чип A16 Bionic, основная камера 48 Мп и разъём USB-C. Пять цветов корпуса.',
    specs: 'Экран: 6.1" OLED\nЧип: A16 Bionic\nПамять: 128 ГБ\nОсновная камера: 48 Мп\nРазъём: USB-C',
    images: [], createdAt: now - 2 * DAY
  },
  {
    id: 'iphone-14', name: 'iPhone 14 128 ГБ', category: 'iPhone',
    price: 69990, oldPrice: 74990, badge: '', inStock: true,
    shortDesc: 'Надёжный выбор по доступной цене.',
    description: 'Отличный баланс цены и возможностей: чип A15 Bionic, двойная камера и до 20 часов видео.',
    specs: 'Экран: 6.1" OLED\nЧип: A15 Bionic\nПамять: 128 ГБ\nКамера: 12 Мп + 12 Мп',
    images: [], createdAt: now - 3 * DAY
  },
  {
    id: 'iphone-se', name: 'iPhone SE 64 ГБ', category: 'iPhone',
    price: 44990, oldPrice: null, badge: '', inStock: false,
    shortDesc: 'Компактный корпус и Touch ID.',
    description: 'Самый доступный iPhone с чипом A15 Bionic и кнопкой Touch ID. Компактный и быстрый.',
    specs: 'Экран: 4.7" Retina\nЧип: A15 Bionic\nПамять: 64 ГБ\nTouch ID: да',
    images: [], createdAt: now - 4 * DAY
  },
  {
    id: 'macbook-air-m3', name: 'MacBook Air 13" M3 8/256', category: 'Mac',
    price: 129990, oldPrice: null, badge: 'Новинка', inStock: true,
    shortDesc: 'Тонкий, лёгкий, до 18 часов работы.',
    description: 'Ультратонкий ноутбук на чипе M3. Бесшумный, до 18 часов автономности, дисплей Liquid Retina.',
    specs: 'Экран: 13.6" Liquid Retina\nЧип: Apple M3\nПамять: 8 ГБ\nНакопитель: 256 ГБ SSD\nВес: 1.24 кг',
    images: [], createdAt: now - 5 * DAY
  },
  {
    id: 'macbook-pro-14', name: 'MacBook Pro 14" M3 Pro 18/512', category: 'Mac',
    price: 219990, oldPrice: 239990, badge: '', inStock: true,
    shortDesc: 'Дисплей XDR 120 Гц, чип M3 Pro.',
    description: 'Профессиональный ноутбук с дисплеем Liquid Retina XDR, чипом M3 Pro и портами HDMI, SD, Thunderbolt.',
    specs: 'Экран: 14.2" Liquid Retina XDR 120 Гц\nЧип: Apple M3 Pro\nПамять: 18 ГБ\nНакопитель: 512 ГБ SSD',
    images: [], createdAt: now - 6 * DAY
  },
  {
    id: 'mac-mini-m2', name: 'Mac mini M2 8/256', category: 'Mac',
    price: 59990, oldPrice: null, badge: '', inStock: true,
    shortDesc: 'Компактный настольный компьютер.',
    description: 'Настольный компьютер на чипе M2 в компактном корпусе. Просто подключите монитор и клавиатуру.',
    specs: 'Чип: Apple M2\nПамять: 8 ГБ\nНакопитель: 256 ГБ SSD\nПорты: 2× Thunderbolt, HDMI, 2× USB-A',
    images: [], createdAt: now - 7 * DAY
  },
  {
    id: 'ipad-air-11', name: 'iPad Air 11" M2 128 ГБ', category: 'iPad',
    price: 69990, oldPrice: null, badge: '', inStock: true,
    shortDesc: 'Чип M2, поддержка Apple Pencil Pro.',
    description: 'Лёгкий и мощный планшет на чипе M2. Поддержка Apple Pencil Pro и клавиатуры Magic Keyboard.',
    specs: 'Экран: 11" Liquid Retina\nЧип: Apple M2\nПамять: 128 ГБ\nПоддержка: Apple Pencil Pro',
    images: [], createdAt: now - 8 * DAY
  },
  {
    id: 'ipad-pro-11-m4', name: 'iPad Pro 11" M4 256 ГБ', category: 'iPad',
    price: 109990, oldPrice: null, badge: 'Топ', inStock: true,
    shortDesc: 'Дисплей Ultra Retina OLED, чип M4.',
    description: 'Самый тонкий продукт Apple. Дисплей Ultra Retina XDR на технологии Tandem OLED и новейший чип M4.',
    specs: 'Экран: 11" Ultra Retina XDR OLED\nЧип: Apple M4\nПамять: 256 ГБ\nРазъём: USB-C / Thunderbolt',
    images: [], createdAt: now - 9 * DAY
  },
  {
    id: 'watch-s9', name: 'Apple Watch Series 9 45 мм', category: 'Apple Watch',
    price: 39990, oldPrice: 42990, badge: '', inStock: true,
    shortDesc: 'Жест «двойное касание», яркий дисплей.',
    description: 'Умные часы с чипом S9, жестом «двойное касание» и дисплеем яркостью до 2000 нит.',
    specs: 'Корпус: 45 мм\nЧип: S9 SiP\nДатчики: пульс, ЭКГ, кислород\nЗащита: WR50',
    hotDeal: true, hotDealPrice: 33990, hotDealUntil: now + 5 * DAY,
    images: [], createdAt: now - 10 * DAY
  },
  {
    id: 'watch-ultra-2', name: 'Apple Watch Ultra 2', category: 'Apple Watch',
    price: 79990, oldPrice: null, badge: '', inStock: true,
    shortDesc: 'Титан, до 36 часов автономности.',
    description: 'Самые прочные и функциональные часы Apple. Титановый корпус, кнопка «Действие», яркость 3000 нит.',
    specs: 'Корпус: 49 мм титан\nАвтономность: до 36 ч\nЯркость: 3000 нит\nЗащита: WR100, MIL-STD 810H',
    images: [], createdAt: now - 11 * DAY
  },
  {
    id: 'airpods-pro-2', name: 'AirPods Pro 2 (USB-C)', category: 'AirPods',
    price: 22990, oldPrice: 24990, badge: '−8%', inStock: true,
    shortDesc: 'Активное шумоподавление, USB-C.',
    description: 'Наушники с активным шумоподавлением нового поколения, адаптивным звуком и зарядкой USB-C.',
    specs: 'Шумоподавление: активное\nЧип: H2\nЗарядка: USB-C, MagSafe\nАвтономность: до 6 ч (30 ч с кейсом)',
    hotDeal: true, hotDealPrice: 18990, hotDealUntil: now + 2 * DAY,
    images: [], createdAt: now - 12 * DAY
  },
  {
    id: 'airpods-max', name: 'AirPods Max', category: 'AirPods',
    price: 54990, oldPrice: null, badge: '', inStock: true,
    shortDesc: 'Полноразмерные наушники, пространственный звук.',
    description: 'Полноразмерные наушники с высокой чёткостью звучания, пространственным аудио и активным шумоподавлением.',
    specs: 'Тип: полноразмерные\nШумоподавление: активное\nПространственное аудио: да\nАвтономность: до 20 ч',
    images: [], createdAt: now - 13 * DAY
  }
];

const reviews = [
  { id: 'r1', productId: 'iphone-15-pro', author: 'Алексей М.', rating: 5, text: 'Титан реально приятнее в руке, чем сталь. Камера огонь, батарея держит весь день. Доставили быстро.', photos: [], status: 'approved', createdAt: now - 2 * DAY },
  { id: 'r2', productId: 'iphone-15-pro', author: 'Ирина', rating: 5, text: 'Брала в подарок мужу, очень доволен. Менеджер помог с выбором цвета.', photos: [], status: 'approved', createdAt: now - 5 * DAY },
  { id: 'r3', productId: 'iphone-15-pro', author: 'Дмитрий', rating: 4, text: 'Отличный телефон, но греется при играх. В остальном претензий нет.', photos: [], status: 'approved', createdAt: now - 9 * DAY },
  { id: 'r4', productId: 'macbook-air-m3', author: 'Сергей', rating: 5, text: 'Тихий, лёгкий, тянет всё что нужно для работы. Автономность шикарная.', photos: [], status: 'approved', createdAt: now - 4 * DAY },
  { id: 'r5', productId: 'macbook-air-m3', author: 'Ольга К.', rating: 5, text: 'Перешла с Windows — не нарадуюсь. Экран очень приятный.', photos: [], status: 'approved', createdAt: now - 7 * DAY },
  { id: 'r6', productId: 'airpods-pro-2', author: 'Никита', rating: 5, text: 'Шумодав топ, в метро вообще ничего не слышно. За свои деньги лучшее.', photos: [], status: 'approved', createdAt: now - 3 * DAY },
  { id: 'r7', productId: 'watch-ultra-2', author: 'Павел', rating: 5, text: 'Ношу на тренировках и в горах — держат заряд по два дня. Крепкие.', photos: [], status: 'approved', createdAt: now - 6 * DAY },
  { id: 'r8', productId: 'ipad-pro-11-m4', author: 'Марина', rating: 4, text: 'Экран нереальный, но чехол пришлось докупать отдельно.', photos: [], status: 'approved', createdAt: now - 8 * DAY },
  // Пример отзывов на модерации (видны только в админке):
  { id: 'r9', productId: 'iphone-15', author: 'Гость', rating: 5, text: 'Пришёл запечатанный, всё работает. Спасибо!', photos: [], status: 'pending', createdAt: now - 12 * 3600000 },
  { id: 'r10', productId: 'macbook-pro-14', author: 'Аноним', rating: 5, text: 'Проверьте пожалуйста, это тестовый отзыв на модерации.', photos: [], status: 'pending', createdAt: now - 3 * 3600000 }
];

// Демо-домены (мультитенант). На VPS в hosts указывают реальные домены.
// Локально: site-a привязан к localhost; остальные можно посмотреть через ?site=<id>.
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
