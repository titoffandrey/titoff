'use strict';
/*
 * Демо-наполнение: используется при первом запуске (если данных ещё нет) и командой `node seed.js`.
 *
 * Каталог товаров живёт в отдельном файле catalog.js — там вся линейка устройств Apple
 * (состав, цвета, объёмы памяти и характеристики по apple.com, июль 2026).
 * Здесь — только настройки магазина, демо-отзывы и демо-домены.
 *
 * ВНИМАНИЕ: цены ориентировочные (уровень РФ-рынка, июль 2026) и легко правятся в админке.
 */

const { products, DAY, now } = require('./catalog');

/* ------------------------------- отзывы ------------------------------- */
const reviews = [
  { id: 'r1', productId: 'iphone-17-pro-max', author: 'Владимир', rating: 5, text: 'Оранжевый вживую смотрится дорого. Зум 8× реально работает — ночные фото заметно лучше, чем на 15 Pro. Доставили за день.', aspects: { delivery: 5, service: 5, price: 4 }, photos: [], status: 'approved', createdAt: now - 1 * DAY },
  { id: 'r2', productId: 'iphone-17-pro-max', author: 'Анна С.', rating: 4, text: 'Телефон супер, но ждала неделю нужный цвет — на складе был только серебристый. Менеджер честно предупредил о сроках.', aspects: { delivery: 3, service: 5, price: 4 }, photos: [], status: 'approved', createdAt: now - 3 * DAY },
  { id: 'r3', productId: 'iphone-air', author: 'Кирилл', rating: 5, text: 'Он правда невесомый, в кармане не чувствуется. Батареи хватает на день при моём сценарии, титан приятный на ощупь.', aspects: { delivery: 5, service: 4, price: 5 }, photos: [], status: 'approved', createdAt: now - 2 * DAY },
  { id: 'r4', productId: 'iphone-17', author: 'Светлана', rating: 5, text: 'Наконец 120 Гц в обычной модели, и сразу 256 ГБ. Взяла лавандовый — очень довольна. Оформили быстро.', aspects: { delivery: 5, service: 5, price: 5 }, photos: [], status: 'approved', createdAt: now - 4 * DAY },
  { id: 'r5', productId: 'iphone-17e', author: 'Тимур', rating: 5, text: 'За эти деньги — лучший выбор. A19, нормальная камера, кнопка «Действие». Брал вместо 16-го и не пожалел.', aspects: { delivery: 5, service: 5, price: 5 }, photos: [], status: 'approved', createdAt: now - 1.5 * DAY },
  { id: 'r6', productId: 'iphone-16', author: 'Максим', rating: 3, text: 'Сам телефон норм, но брал месяц назад дороже — сейчас вижу скидку и немного обидно. Работает без нареканий.', aspects: { delivery: 4, service: 4, price: 2 }, photos: [], status: 'approved', createdAt: now - 6 * DAY },
  { id: 'r7', productId: 'macbook-air-13-m5', author: 'Сергей П.', rating: 5, text: 'Тихий, лёгкий, тянет всё для работы и монтажа. Автономность шикарная. Доставка курьером до двери.', aspects: { delivery: 5, service: 5, price: 4 }, photos: [], status: 'approved', createdAt: now - 4 * DAY },
  { id: 'r8', productId: 'macbook-air-13-m5', author: 'Ольга К.', rating: 4, text: 'Перешла с Windows, привыкаю. Ноутбук классный, но советую сразу брать 512 — 256 маловато.', aspects: { delivery: 4, service: 5, price: 3 }, photos: [], status: 'approved', createdAt: now - 7 * DAY },
  { id: 'r9', productId: 'macbook-pro-14-m5', author: 'Андрей', rating: 5, text: 'Машина зверь для рендера, M5 после M1 — другой уровень. Проверили при мне, всё завелось идеально.', aspects: { delivery: 5, service: 5, price: 4 }, photos: [], status: 'approved', createdAt: now - 8 * DAY },
  { id: 'r10', productId: 'macbook-neo', author: 'Дарья', rating: 5, text: 'Брала ребёнку в школу. Цитрусовый цвет очень живой, весит мало, для учёбы более чем достаточно.', aspects: { delivery: 5, service: 5, price: 5 }, photos: [], status: 'approved', createdAt: now - 2.5 * DAY },
  { id: 'r11', productId: 'mac-mini-m5', author: 'Игорь', rating: 5, text: 'Поставил на стол вместо башни — места занимает как книга, а по скорости обгоняет старый ПК в разы.', aspects: { delivery: 5, service: 4, price: 5 }, photos: [], status: 'approved', createdAt: now - 5 * DAY },
  { id: 'r12', productId: 'ipad-pro-13-m5', author: 'Марина', rating: 4, text: 'Экран нереальный, OLED видно сразу. Чехол и Pencil пришлось докупать отдельно, но это ожидаемо.', aspects: { delivery: 4, service: 4, price: 3 }, photos: [], status: 'approved', createdAt: now - 8 * DAY },
  { id: 'r13', productId: 'ipad-air-11-m4', author: 'Егор', rating: 5, text: 'Идеальный баланс цены и возможностей. Рисую в Procreate, тормозов нет вообще.', aspects: { delivery: 5, service: 5, price: 5 }, photos: [], status: 'approved', createdAt: now - 3.5 * DAY },
  { id: 'r14', productId: 'watch-series-11-alu', author: 'Юлия', rating: 5, text: 'Оценка сна и уведомления о давлении — то, за чем и брала. Заряжаются быстро, пришли раньше срока.', aspects: { delivery: 5, service: 5, price: 5 }, photos: [], status: 'approved', createdAt: now - 2 * DAY },
  { id: 'r15', productId: 'watch-ultra-3', author: 'Павел', rating: 5, text: 'Ношу на тренировках и в горах — держат заряд два дня. Титан не царапается, спутник реально пригодился.', aspects: { delivery: 5, service: 5, price: 4 }, photos: [], status: 'approved', createdAt: now - 6 * DAY },
  { id: 'r16', productId: 'airpods-pro-3', author: 'Никита', rating: 5, text: 'Шумодав топ, в метро вообще ничего не слышно. Пульсометр на тренировках совпадает с часами.', aspects: { delivery: 5, service: 4, price: 5 }, photos: [], status: 'approved', createdAt: now - 3 * DAY },
  { id: 'r17', productId: 'airpods-pro-3', author: 'Гость', rating: 4, text: 'Наушники хорошие, но кейс быстро поцарапался в кармане. К звуку и шумодаву претензий нет.', aspects: { delivery: 4, service: 4, price: 4 }, photos: [], status: 'approved', createdAt: now - 10 * DAY },
  { id: 'r18', productId: 'airpods-max-2', author: 'Лев', rating: 5, text: 'Lossless по USB-C — вот за это и брал. По сравнению с первыми Max звук чище, шумодав сильнее.', aspects: { delivery: 5, service: 5, price: 3 }, photos: [], status: 'approved', createdAt: now - 4.5 * DAY },
  { id: 'r19', productId: 'apple-tv-4k', author: 'Роман', rating: 5, text: 'Интерфейс летает, Dolby Vision работает как надо. Взял версию на 128 ГБ ради Ethernet.', aspects: { delivery: 5, service: 5, price: 5 }, photos: [], status: 'approved', createdAt: now - 5.5 * DAY },
  { id: 'r20', productId: 'homepod-mini', author: 'Алина', rating: 4, text: 'Для кухни идеально. Взяла жёлтый, выглядит здорово. Басов немного не хватает, но для размера отлично.', aspects: { delivery: 5, service: 4, price: 5 }, photos: [], status: 'approved', createdAt: now - 7.5 * DAY },
  { id: 'r21', productId: 'airtag-4pack', author: 'Виктор', rating: 5, text: 'Разложил по чемоданам перед отпуском — в аэропорту сразу видел, где мой багаж. Набором заметно выгоднее.', aspects: { delivery: 5, service: 5, price: 5 }, photos: [], status: 'approved', createdAt: now - 9 * DAY },
  // На модерации (видны только в панели владельца):
  { id: 'r22', productId: 'iphone-17', author: 'Гость', rating: 5, text: 'Пришёл запечатанный, всё работает. Спасибо!', aspects: null, photos: [], status: 'pending', createdAt: now - 12 * 3600000 },
  { id: 'r23', productId: 'macbook-pro-16-m5-pro', author: 'Аноним', rating: 5, text: 'Тестовый отзыв на модерации — проверка панели.', aspects: null, photos: [], status: 'pending', createdAt: now - 3 * 3600000 }
];

/* --------------------- демо-домены (мультитенант) --------------------- */
// На VPS в hosts указывают реальные домены магазинов.
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
