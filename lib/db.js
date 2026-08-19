'use strict';
/*
 * Простое JSON-хранилище с атомарной записью.
 * Никаких внешних баз и нативных модулей — переносится на любой хостинг как есть.
 * При желании этот слой легко заменить на SQLite/Postgres, не трогая остальной код.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const auth = require('./auth');
const DELIVERY = require('./delivery');
const ZONES = require('./delivery-zones');
const PAY = require('./pay-methods');

const DATA_DIR = path.resolve(process.env.STORE_DATA_DIR || path.join(__dirname, '..', 'data'));
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');

fs.mkdirSync(UPLOAD_DIR, { recursive: true, mode: 0o700 });
// JSON содержит хеши паролей, токены, контакты и заказы. Он не должен быть
// доступен другим пользователям сервера; картинки всё равно отдаёт сам процесс.
try { fs.chmodSync(DATA_DIR, 0o700); fs.chmodSync(UPLOAD_DIR, 0o700); } catch (e) {}

function fileFor(name) { return path.join(DATA_DIR, name + '.json'); }

// Кэш чтения в памяти по времени изменения файла (mtime).
// За один запрос данные читаются десятки раз (товары, отзывы, сайты) — кэш убирает лишние чтения с диска.
const _cache = {};

function readJson(name, fallback) {
  try {
    const f = fileFor(name);
    const st = fs.statSync(f);
    const c = _cache[name];
    if (c && c.mtime === st.mtimeMs) return c.data;
    const data = JSON.parse(fs.readFileSync(f, 'utf8'));
    _cache[name] = { mtime: st.mtimeMs, data };
    return data;
  } catch (e) {
    if (e && e.code === 'ENOENT') return fallback;
    // Повреждённый JSON нельзя молча подменять пустым массивом: следующая запись
    // иначе уничтожит данные. Лучше остановить операцию с явной ошибкой.
    e.message = `Не удалось прочитать ${fileFor(name)}: ${e.message}`;
    throw e;
  }
}

function writeJson(name, data) {
  const tmp = fileFor(name) + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, fileFor(name)); // атомарная подмена файла
  delete _cache[name];               // сбрасываем кэш — при следующем чтении подхватится свежий файл
}

function exists(name) {
  return fs.existsSync(fileFor(name));
}

function newId() {
  return crypto.randomBytes(8).toString('hex');
}

const PRICE_MAX = 1e12;
function priceValue(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 && n <= PRICE_MAX ? n : fallback;
}
function optionalPrice(value, fallback) {
  if (value === '' || value == null) return null;
  return priceValue(value, fallback);
}
function safeUploadName(value) {
  const name = String(value || '');
  return name && name !== '.' && name !== '..' && path.basename(name) === name ? name : null;
}
function textValue(value, max) { return String(value == null ? '' : value).slice(0, max); }
// Как показывать наличие на странице товара: 'few' — «осталось несколько штук»,
// всё остальное — обычное «в наличии». Это НЕ замена inStock: тот выключает товар
// целиком, а здесь только подпись у купленного. Поля нет — считаем 'in', поэтому
// старые данные и catalog.js читаются без изменений, как и у флагов вариантов.
function stockLevelValue(value, fallback) {
  if (value === undefined || value === null) return fallback;
  return String(value) === 'few' ? 'few' : 'in';
}
// Показывать ли товар на витрине. Это НЕ наличие: `inStock` оставляет карточку в
// каталоге с подписью «Нет в наличии», а `visible: false` убирает её оттуда
// целиком — вместе со ссылкой, поиском, картой сайта и заказом. Раньше это была
// галочка «показывать» у каждого домена; домен остался один, и признак переехал
// к самому товару. Поля нет — товар виден, поэтому старые данные и catalog.js
// читаются без изменений.
function isVisible(product) { return !!product && product.visible !== false; }
function uploadIsUsed(filename) {
  if (!filename) return false;
  if (getProducts().some(p => (p.images || []).includes(filename))) return true;
  // Не только фотографии: имя файла у привезённых отзывов считается от адреса,
  // поэтому один и тот же снимок или ролик встречается у нескольких отзывов.
  // Без этой проверки удаление одного из них уносило бы файл у остальных.
  if (getReviews().some(r => reviewFiles(r).includes(filename))) return true;
  return getSettings().logoImage === filename;
}
function deleteUploadIfUnused(filename) {
  const name = safeUploadName(filename);
  if (!name || uploadIsUsed(name)) return false;
  try { fs.unlinkSync(path.join(UPLOAD_DIR, name)); return true; }
  catch (e) { return false; }
}

/* ----------------------------- Настройки ----------------------------- */

// Настройки одного магазина. Мультидоменности больше нет: один процесс — один
// сайт, и всё, что раньше было «своим у каждого домена» (бренд, логотип, цвета,
// контакты, реквизиты оператора, Telegram, доступ), живёт прямо здесь. Домен
// задаётся не приложением, а обратным прокси: под новый домен арендуется свой
// VPS и разворачивается своя копия.
function defaultSettings() {
  return {
    storeName: 'iStore',
    tagline: 'Оригинальная техника Apple с гарантией',
    currency: '₽',
    currencyPosition: 'after', // 'after' -> "1000 ₽", 'before' -> "₽1000"
    accentColor: '#0071e3',
    secondaryColor: '',        // второй цвет логотипа-надписи; пусто — как акцентный
    logoImage: null,           // файл в uploads/ — картинка вместо надписи
    logoText: '',              // надпись логотипа с выделением в фигурных скобках
    logoFont: 'system',        // шрифт надписи: system|rounded|grotesk|serif|slab|mono
    contactTelegram: '',       // @username менеджера для витрины (по желанию)
    contactPhone: '',
    footerNote: '',
    legalOperator: '',         // полное имя ИП/ООО/физлица — оператора персональных данных
    legalDetails: '',          // ИНН/ОГРН/ОГРНИП (по применимости)
    legalAddress: '',
    privacyEmail: '',
    telegramBotToken: '',      // токен бота, куда падают заявки
    telegramChatId: '',        // id чата/менеджера
    notifyReviews: true,       // уведомлять в Telegram о новых отзывах на модерацию
    // Ключ «Подсказки» dadata.ru живёт только на сервере. Пустой — поле адреса
    // на оформлении работает как обычный ввод, без подсказок.
    dadataToken: '',
    // Онлайн-оплата CrocoPAY. По умолчанию выключена: без ключей кассы и без
    // явной галочки витрина работает как прежде — заявка, менеджер связывается.
    // Ключи наружу не отдаются никогда, на витрину уходит только «включено».
    crocopayEnabled: false,
    crocopayClientId: '',
    crocopayClientSecret: '',
    // Поле осталось ради прежних настроек: касса рублёвая, выбора валюты нет.
    crocopayCurrency: 'RUB',
    // Какие способы оплаты показывать покупателю. По умолчанию два для России;
    // трансграничные у кассы включены, но админ добавляет их сам, когда
    // понадобятся. Список фильтруется ещё и тем, что включено у самой кассы.
    payMethods: PAY.DEFAULT_IDS.slice(),
    // Единственная учётная запись: полный доступ ко всему в /admin. Раньше их
    // было две — владелец каталога и администратор домена, — и разделять их
    // стало не с кем.
    adminUsername: 'admin',
    adminPasswordHash: '',     // задаётся при первом запуске
    sessionSecret: ''
  };
}

function getSettings() {
  const s = Object.assign(defaultSettings(), readJson('settings', {}));
  return s;
}

function saveSettings(patch) {
  const s = Object.assign(getSettings(), patch);
  writeJson('settings', s);
  return s;
}

/* ----------------------------- Товары ----------------------------- */

function getProducts() {
  return readJson('products', []);
}

function getProduct(id) {
  return getProducts().find(p => p.id === id) || null;
}

// Каталог витрины: только показываемые товары, в порядке файла. Порядок и есть
// порядок карточек на главной, поэтому ни сортировки, ни копии здесь нет.
function visibleProducts() { return getProducts().filter(isVisible); }
function visibleProduct(id) {
  const p = getProduct(id);
  return p && isVisible(p) ? p : null;
}

function saveProducts(list) { writeJson('products', list); }

// Свой id принимается только у доливки из catalog.js (`add-novinki.js`): по нему
// ищет товар генератор демо-отзывов, а со случайным id карточка осталась бы без
// единого отзыва. Форма владельца id не передаёт, занятый или неслужебный id
// отбрасывается — двух товаров с одним id быть не должно.
const RESERVED_IDS = ['new', 'order']; // адреса /owner/products/new и /order
function stableId(id, list) {
  const slug = String(id == null ? '' : id);
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(slug) || RESERVED_IDS.includes(slug)) return newId();
  return list.some(p => p.id === slug) ? newId() : slug;
}

function createProduct(data) {
  const list = getProducts();
  const product = {
    id: stableId(data.id, list),
    name: textValue(data.name, 200).trim() || 'Без названия',
    category: textValue(data.category, 100).trim() || 'Прочее',
    price: priceValue(data.price, 0),
    oldPrice: optionalPrice(data.oldPrice, null),
    shortDesc: textValue(data.shortDesc, 500),
    description: textValue(data.description, 20000),
    specs: textValue(data.specs, 20000),
    images: (data.images || []).map(safeUploadName).filter(Boolean),
    imageColors: data.imageColors || {}, // {имяФайла: названиеЦвета} — фото, привязанные к цвету
    inStock: data.inStock !== false,
    visible: data.visible !== false,     // показывать ли карточку на витрине вообще
    stockLevel: stockLevelValue(data.stockLevel, 'in'),
    colors: data.colors || [],       // [{name, hex}]
    storages: data.storages || [],   // [{label, add}] — add = доплата к базовой цене
    // Ремешки часов: [{name, sizes:[{label}], options:[{name, hex, add, inStock}]}]
    bands: data.bands || [],
    // Доп. характеристики: [{name, hint, values:[{label, add, inStock, forStorage}]}]
    options: data.options || [],
    imageBands: data.imageBands || {},  // {имяФайла: «Коллекция|Цвет»} — фото вариации ремешка
    hotDeal: !!data.hotDeal,
    hotDealPrice: optionalPrice(data.hotDealPrice, null),
    hotDealUntil: Number.isFinite(Number(data.hotDealUntil)) && Number(data.hotDealUntil) > 0 ? Number(data.hotDealUntil) : null,
    createdAt: Date.now()
  };
  list.unshift(product);
  saveProducts(list);
  return product;
}

function updateProduct(id, data) {
  const list = getProducts();
  const i = list.findIndex(p => p.id === id);
  if (i === -1) return null;
  const p = list[i];
  Object.assign(p, {
    name: data.name !== undefined ? (textValue(data.name, 200).trim() || p.name) : p.name,
    category: data.category !== undefined ? (textValue(data.category, 100).trim() || p.category) : p.category,
    price: data.price !== undefined ? priceValue(data.price, p.price) : p.price,
    oldPrice: data.oldPrice !== undefined ? optionalPrice(data.oldPrice, p.oldPrice) : p.oldPrice,
    shortDesc: data.shortDesc !== undefined ? textValue(data.shortDesc, 500) : p.shortDesc,
    description: data.description !== undefined ? textValue(data.description, 20000) : p.description,
    specs: data.specs !== undefined ? textValue(data.specs, 20000) : p.specs,
    inStock: data.inStock !== undefined ? data.inStock !== false : p.inStock,
    visible: data.visible !== undefined ? data.visible !== false : isVisible(p),
    stockLevel: stockLevelValue(data.stockLevel, p.stockLevel || 'in'),
    colors: data.colors !== undefined ? data.colors : (p.colors || []),
    storages: data.storages !== undefined ? data.storages : (p.storages || []),
    bands: data.bands !== undefined ? data.bands : (p.bands || []),
    options: data.options !== undefined ? data.options : (p.options || []),
    imageBands: data.imageBands !== undefined ? data.imageBands : (p.imageBands || {}),
    hotDeal: data.hotDeal !== undefined ? !!data.hotDeal : p.hotDeal,
    hotDealPrice: data.hotDealPrice !== undefined ? optionalPrice(data.hotDealPrice, p.hotDealPrice) : p.hotDealPrice,
    hotDealUntil: data.hotDealUntil !== undefined
      ? (Number.isFinite(Number(data.hotDealUntil)) && Number(data.hotDealUntil) > 0 ? Number(data.hotDealUntil) : null)
      : p.hotDealUntil
  });
  if (data.images) p.images = data.images.map(safeUploadName).filter(Boolean);
  if (data.imageColors !== undefined) p.imageColors = data.imageColors || {};
  if (data.imageBands !== undefined) p.imageBands = data.imageBands || {};
  list[i] = p;
  saveProducts(list);
  return p;
}

// Переставить товары в каталоге: витрина показывает их в порядке файла, поэтому
// порядок здесь и есть порядок карточек на главной.
//
// Принимается только ТОЧНАЯ перестановка текущего списка — то же правило, что у
// порядка фотографий (`validImageOrder` в lib/images.js). Иначе один запрос с
// урезанным списком стирал бы товары из каталога мимо /delete, а с чужим id —
// добавлял бы пустую позицию.
function reorderProducts(ids) {
  const list = getProducts();
  const requested = Array.isArray(ids) ? ids.map(String) : [];
  if (requested.length !== list.length) return null;
  const byId = new Map(list.map(p => [p.id, p]));
  if (byId.size !== list.length) return null;            // дубли id — сначала чинить каталог
  const seen = new Set();
  const next = [];
  for (const id of requested) {
    const product = byId.get(id);
    if (!product || seen.has(id)) return null;
    seen.add(id);
    next.push(product);
  }
  saveProducts(next);
  return next;
}

// Перенести отзывы с одного товара на другой — нужно при слиянии двух карточек
// в одну (две версии AirPods 4, две фасовки AirTag). Без этого deleteProduct
// унёс бы отзывы вместе с товаром.
//
// Кого переносить, решает вызывающий: демо-отзывы переносить незачем — их набор
// пересобирается целиком, а вот отзыв покупателя восстановить неоткуда.
// readJson отдаёт массив по ссылке, поэтому правим копии, а не записи на месте.
function moveReviews(fromId, toId, shouldMove) {
  if (!fromId || !toId || fromId === toId) return 0;
  const list = getReviews();
  let moved = 0;
  const next = list.map(review => {
    if (review.productId !== fromId) return review;
    if (shouldMove && !shouldMove(review)) return review;
    moved++;
    return Object.assign({}, review, { productId: toId });
  });
  if (moved) saveReviews(next);
  return moved;
}

function deleteProduct(id) {
  const gone = getProduct(id);
  const goneReviews = getReviews().filter(r => r.productId === id);
  saveProducts(getProducts().filter(p => p.id !== id));
  // заодно чистим отзывы этого товара
  saveReviews(getReviews().filter(r => r.productId !== id));
  // Файлы товара и его отзывов удаляем, только если на них больше никто не ссылается.
  const files = new Set((gone && gone.images) || []);
  for (const r of goneReviews) for (const f of (r.photos || [])) files.add(f);
  for (const f of files) deleteUploadIfUnused(f);
}

// Все категории каталога — для подсказки в форме товара.
function categories() {
  const set = [];
  for (const p of getProducts()) if (!set.includes(p.category)) set.push(p.category);
  return set;
}
// Категории витрины: скрытый товар не должен оставлять за собой пустой раздел
// в меню и лишний адрес в карте сайта.
function visibleCategories() {
  const set = [];
  for (const p of getProducts()) if (isVisible(p) && !set.includes(p.category)) set.push(p.category);
  return set;
}

/* ----------------------------- Отзывы ----------------------------- */
// status: 'pending' | 'approved'
// Публично видны только 'approved'. Посетителю про модерацию не сообщаем.

function getReviews() { return readJson('reviews', []); }
function saveReviews(list) { writeJson('reviews', list); }

// Разбивка отзывов по товарам. Без неё каждый вызов reviewsForProduct проходил
// весь массив (на боевых данных это 7000 записей) и заново сортировал результат,
// а страница товара делает это дважды: один раз ради оценки, второй — ради списка.
// Индекс строится один раз на версию файла: readJson отдаёт тот же массив по
// ссылке, пока не изменился mtime, поэтому сравнение по ссылке и есть проверка
// актуальности. Массивы уже отсортированы от свежих к старым.
let _reviewIndex = { src: null, byProduct: new Map() };
function reviewIndex() {
  const list = getReviews();
  if (_reviewIndex.src === list) return _reviewIndex.byProduct;
  const byProduct = new Map();
  for (const r of list) {
    let e = byProduct.get(r.productId);
    if (!e) { e = { all: [], approved: [] }; byProduct.set(r.productId, e); }
    e.all.push(r);
    if (r.status === 'approved') e.approved.push(r);
  }
  const fresh = (a, b) => Number(b.createdAt || 0) - Number(a.createdAt || 0);
  for (const e of byProduct.values()) {
    e.all.sort(fresh); e.approved.sort(fresh);
    // Сумма оценок хранится рядом: витрине каталога нужен только средний балл,
    // и пересчитывать его на каждой отрисовке незачем. Сайт, скрывший часть
    // отзывов, вычитает из готовой суммы только свои скрытые (см. tenancy.js).
    e.sum = e.approved.reduce((a, r) => a + (Number(r.rating) || 0), 0);
  }
  _reviewIndex = { src: list, byProduct };
  return byProduct;
}

// Средняя оценка из суммы и числа отзывов — одна формула на весь проект,
// чтобы округление в каталоге и на странице товара не разошлось.
function averageRating(sum, count) {
  return count ? { avg: Math.round((sum / count) * 10) / 10, count } : { avg: 0, count: 0 };
}
// Готовые суммы одобренных отзывов по товарам: {productId: {sum, count}}.
function approvedTotals() {
  const out = new Map();
  for (const [productId, e] of reviewIndex()) out.set(productId, { sum: e.sum, count: e.approved.length });
  return out;
}

const EMPTY_REVIEWS = [];
// Возвращает массив из индекса по ссылке — как и getReviews, его нельзя мутировать
// на месте. Все вызывающие сначала делают filter/slice/concat, так что копий не нужно.
function reviewsForProduct(productId, approvedOnly) {
  const e = reviewIndex().get(productId);
  if (!e) return EMPTY_REVIEWS;
  return approvedOnly ? e.approved : e.all;
}

function ratingFor(productId) {
  const e = reviewIndex().get(productId);
  return e ? averageRating(e.sum, e.approved.length) : { avg: 0, count: 0 };
}

function createReview(data) {
  const list = getReviews();
  const review = {
    id: newId(),
    productId: data.productId,
    author: textValue(data.author || 'Аноним', 60),
    rating: Math.min(5, Math.max(1, Number(data.rating) || 5)),
    text: textValue(data.text, 2000),
    photos: (data.photos || []).map(safeUploadName).filter(Boolean),
    videos: (data.videos || []).map(safeUploadName).filter(Boolean),
    poster: safeUploadName(data.poster) || null,      // кадр-заставка для видео
    // Лёгкие превью для ленты вложений: файл → его миниатюра (у видео — кадр).
    // Полноразмерный снимок весит сотни килобайт и нужен только в просмотрщике.
    previews: sanitizePreviews(data.previews),
    config: textValue(data.config, 200),              // сборка покупателя: цвет, память
    delivery: DELIVERY.isValid(data.delivery) ? String(data.delivery) : null,
    // Откуда отзыв и какая у него была дата в источнике. Дата хранится отдельно
    // от createdAt: витрина показывает сдвинутую (см. scripts/shift-review-dates.js),
    // а пересчитывать сдвиг надо всегда от исходной, иначе он накапливается.
    source: textValue(data.source, 40),
    sourceDate: Number.isFinite(Number(data.sourceDate)) ? Number(data.sourceDate) : null,
    status: data.status === 'approved' ? 'approved' : 'pending',
    createdAt: Number.isFinite(Number(data.createdAt)) ? Number(data.createdAt) : Date.now(),
    privacyConsentAt: Number.isFinite(Number(data.privacyConsentAt)) ? Number(data.privacyConsentAt) : null,
    privacyConsentVersion: textValue(data.privacyConsentVersion, 40),
    publicationConsentAt: Number.isFinite(Number(data.publicationConsentAt)) ? Number(data.publicationConsentAt) : null,
    publicationConsentVersion: textValue(data.publicationConsentVersion, 40)
  };
  list.unshift(review);
  saveReviews(list);
  return review;
}

function setReviewStatus(id, status) {
  if (status !== 'pending' && status !== 'approved') return null;
  const list = getReviews();
  const r = list.find(x => x.id === id);
  if (r) { r.status = status; saveReviews(list); }
  return r;
}

function getReview(id) { return getReviews().find(r => r.id === id) || null; }

// Правка отзыва из панели. Меняются ТОЛЬКО пришедшие поля: остальное (откуда
// отзыв, согласия покупателя, превью нетронутых вложений) остаётся как было —
// переписывать историю ради правки имени незачем.
function updateReview(id, data) {
  const list = getReviews();
  const rv = list.find(r => r.id === id);
  if (!rv) return null;
  const before = reviewFiles(rv);

  if (data.productId !== undefined && data.productId) rv.productId = String(data.productId);
  if (data.author !== undefined) rv.author = textValue(data.author, 60) || 'Аноним';
  if (data.rating !== undefined) rv.rating = Math.min(5, Math.max(1, Number(data.rating) || 5));
  if (data.text !== undefined) rv.text = textValue(data.text, 2000);
  if (data.config !== undefined) rv.config = textValue(data.config, 200);
  if (data.delivery !== undefined) rv.delivery = DELIVERY.isValid(data.delivery) ? String(data.delivery) : null;
  if (data.status !== undefined) rv.status = data.status === 'approved' ? 'approved' : 'pending';
  if (data.createdAt !== undefined && Number.isFinite(Number(data.createdAt))) {
    const next = Number(data.createdAt);
    // У привезённого отзыва показанная дата — производная от исходной: раз в
    // сутки её пересчитывает scripts/shift-review-dates.js от `sourceDate`, и
    // правка руками молча откатилась бы к утру. Поэтому исходную двигаем на ту
    // же величину: отзыв сразу встаёт на новую дату и продолжает ехать вместе с
    // набором. Если подвинули самый свежий — на него и переанкерится весь набор.
    if (Number.isFinite(Number(rv.sourceDate)) && Number(rv.sourceDate) > 0) {
      rv.sourceDate = Number(rv.sourceDate) + (next - (Number(rv.createdAt) || next));
    }
    rv.createdAt = next;
  }
  if (data.photos !== undefined) rv.photos = (data.photos || []).map(safeUploadName).filter(Boolean);
  if (data.videos !== undefined) rv.videos = (data.videos || []).map(safeUploadName).filter(Boolean);
  if (data.previews !== undefined) rv.previews = sanitizePreviews(Object.assign({}, rv.previews || {}, data.previews || {}));
  // Превью и кадр-заставка уходят вместе со своим вложением: карта «файл →
  // картинка» переживает удаление самого файла, и оставленная запись держала бы
  // ненужный файл в хранилище вечно (reviewFiles считает его нужным).
  if (rv.previews) {
    const keep = new Set((rv.photos || []).concat(rv.videos || []));
    const next = {};
    for (const key of Object.keys(rv.previews)) if (keep.has(key)) next[key] = rv.previews[key];
    rv.previews = Object.keys(next).length ? next : null;
  }
  if (rv.poster && !(rv.videos || []).length) rv.poster = null;

  saveReviews(list);
  // Осиротевшие файлы — только ПОСЛЕ записи: uploadIsUsed читает сохранённый
  // список, и уборка до неё унесла бы файл, который отзыв ещё держит.
  for (const f of before) if (!reviewFiles(rv).includes(f)) deleteUploadIfUnused(f);
  return rv;
}

// Сводка по товарам для раздела отзывов: сколько всего, сколько ждёт модерации
// и какая оценка. Берётся из того же индекса, что и рейтинг витрины, — ещё
// одного прохода по семи тысячам записей на открытие страницы не делается.
function reviewStats() {
  const out = new Map();
  for (const [productId, e] of reviewIndex()) {
    const rating = averageRating(e.sum, e.approved.length);
    out.set(productId, {
      total: e.all.length, approved: e.approved.length,
      pending: e.all.length - e.approved.length, avg: rating.avg
    });
  }
  return out;
}

// Все файлы отзыва: снимки, ролики, кадр-заставка и лёгкие превью. Видео весит
// мегабайты, а превью плодятся по одному на файл — забытые остались бы навсегда.
function reviewFiles(rv) {
  const out = (rv.photos || []).concat(rv.videos || []);
  if (rv.poster) out.push(rv.poster);
  if (rv.previews) for (const key of Object.keys(rv.previews)) out.push(rv.previews[key]);
  return out.filter(Boolean);
}

function deleteReview(id) {
  const list = getReviews();
  const gone = list.find(r => r.id === id);
  saveReviews(list.filter(r => r.id !== id));
  // Вместе с отзывом уходят все его файлы, а не только фотографии: видео весит
  // мегабайты, и забытый ролик остался бы в хранилище навсегда.
  if (gone) for (const f of reviewFiles(gone)) deleteUploadIfUnused(f);
}

function sanitizePreviews(map) {
  if (!map || typeof map !== 'object') return null;
  const out = {};
  for (const key of Object.keys(map)) {
    const from = safeUploadName(key), to = safeUploadName(map[key]);
    if (from && to) out[from] = to;
  }
  return Object.keys(out).length ? out : null;
}

// Удаление всех отзывов одного товара — им начинается заливка нового набора.
// Файлы чистятся тем же путём, что и при удалении по одному.
function deleteReviewsForProduct(productId) {
  const list = getReviews();
  const gone = list.filter(r => r.productId === productId);
  if (!gone.length) return 0;
  saveReviews(list.filter(r => r.productId !== productId));
  for (const rv of gone) for (const f of reviewFiles(rv)) deleteUploadIfUnused(f);
  return gone.length;
}

function pendingReviewCount() {
  return getReviews().filter(r => r.status === 'pending').length;
}

/* ----------------------------- Заказы ----------------------------- */

function getOrders() { return readJson('orders', []); }
function saveOrders(list) { writeJson('orders', list); }

/*
 * ЧЕРНОВИКИ. Заказ с онлайн-оплатой записывается ещё до того, как покупатель
 * выбрал способ: без записи нечему выдавать номер и не на что вешать счёт. Но
 * заказом такая заготовка ещё не является — покупатель мог просто посмотреть
 * страницу оплаты и уйти. Пока способ не выбран, заказ помечен `draft: true`:
 * в панелях его нет, менеджеру он не приходит, а товары остаются в корзине.
 *
 * `getOrders()` отдаёт ВСЁ, включая черновики: на нём построены все записи в
 * файл, и фильтрованный список, отданный в saveOrders, стёр бы черновики
 * заодно. Панели ходят через `visibleOrders()` / `ordersForSite()`.
 */
function visibleOrders() { return getOrders().filter(o => !o.draft); }

// Брошенные черновики чистим при записи новых: покупатель, ушедший со страницы
// оплаты, оставляет запись навсегда, а таких больше, чем купивших.
const DRAFT_TTL = 24 * 60 * 60 * 1000;
function dropStaleDrafts(list) {
  const edge = Date.now() - DRAFT_TTL;
  return list.filter(o => !o.draft || Number(o.createdAt) > edge);
}

// Номер заказа — случайное шестизначное число, а не счётчик.
//
// Сквозная нумерация с единицы выдаёт обороты магазина любому покупателю: по
// «Заказ №7» видно, что заказов было семь, а по двум заказам с разницей в
// неделю считается и скорость продаж. Случайный номер такого не рассказывает.
// Отсюда же нижняя граница в 100 000: номер не должен выглядеть маленьким.
//
// Совпадения исключаем перебором по уже выданным. Диапазон в 900 000 значений
// против нескольких тысяч заказов делает повтор редким, но не невозможным
// (парадокс дней рождения), а номер обязан быть уникальным: по нему менеджер
// находит заявку. Если не повезло полсотни раз подряд, расширяем разрядность,
// и лишь в самом безнадёжном случае берём max+1 — он уникален всегда.
const ORDER_MIN = 100000;
const ORDER_MAX = 999999;
function nextOrderNumber(list) {
  const taken = new Set();
  let max = 0;
  for (const o of list) {
    const digits = String(o.number || '').replace(/\D+/g, '');
    if (digits) taken.add(digits);
    const n = parseInt(digits, 10);
    if (n > max) max = n;
  }
  const tries = [
    [ORDER_MIN, ORDER_MAX, 50],
    [1000000, 9999999, 50]
  ];
  for (const [from, to, attempts] of tries) {
    for (let i = 0; i < attempts; i++) {
      const candidate = String(crypto.randomInt(from, to + 1));
      if (!taken.has(candidate)) return candidate;
    }
  }
  return String(Math.max(max, ORDER_MIN) + 1);
}

function createOrder(data) {
  const list = getOrders();
  const order = {
    id: newId(),
    number: nextOrderNumber(list),
    // Каким именем магазин был открыт. Домен теперь один и приложение его не
    // выбирает, но в заявке он полезен: по нему видно, пришёл заказ на основной
    // домен или на www/зеркало.
    host: data.host || '',
    items: data.items || [],
    total: priceValue(data.total, 0),
    // Имя и фамилия хранятся раздельно, но `customerName` остаётся собранной
    // строкой: по ней рисуются панели и уведомления, и у прежних заявок (где
    // раздельных полей нет вовсе) она единственная — иначе весь список заказов
    // пришлось бы переписывать ради одного поля.
    firstName: textValue(data.firstName, 60),
    lastName: textValue(data.lastName, 60),
    customerName: textValue(data.customerName
      || [data.firstName, data.lastName].map(x => String(x || '').trim()).filter(Boolean).join(' '), 100),
    contact: textValue(data.contact, 120),
    /* Адрес САМОГО ПОКУПАТЕЛЯ, подсказки берутся из dadata.ru. Это его данные
     * наравне с именем и контактом, и выбор пункта выдачи его не трогает: куда
     * везти заказ, говорит `pickupAddress` ниже. Раньше поле было одно на двоих,
     * и адрес пункта затирал адрес покупателя — при доставке курьером его потом
     * было взять неоткуда.
     */
    address: textValue(data.address, 400),
    // Способ доставки: только из закрытого списка lib/delivery.js. Чужое значение
    // сводится к пустому — у всех прежних заявок оно таким и остаётся.
    delivery: DELIVERY.isValid(data.delivery) ? String(data.delivery) : '',
    // Куда именно — в пункт выдачи или курьером. От этого зависит цена, поэтому
    // рядом лежат и она сама, и зона, по которой её посчитали: тарифы правятся,
    // а заказ должен читаться той ценой, по которой он оформлен.
    deliveryMode: DELIVERY.isValidMode(data.delivery, data.deliveryMode) ? String(data.deliveryMode) : '',
    deliveryPrice: priceValue(data.deliveryPrice, 0),
    deliveryZone: ZONES.isValidZone(data.deliveryZone) ? String(data.deliveryZone) : '',
    /* Код выбранного пункта выдачи («MSK2401») — по нему менеджер оформляет
     * накладную: адрес перевозчик пишет по-своему, а код у пункта один.
     *
     * Что такой пункт существует, проверяет МАРШРУТ по базе (lib/pickup.js), а
     * не хранилище: pickup.js читает DATA_DIR отсюда, и обратная зависимость
     * замкнула бы require в кольцо. Здесь остаётся отсев мусора по виду строки.
     * Пусто — заказ курьером или пункт вписан адресом руками, как было раньше.
     */
    pickupCode: /^[A-Za-z0-9_-]{1,32}$/.test(String(data.pickupCode || '')) ? String(data.pickupCode) : '',
    /* Адрес пункта выдачи — КУДА ЕДЕТ ПОСЫЛКА при доставке в пункт. Хранится
     * отдельно от адреса покупателя, потому что это разные вещи: по первому
     * менеджер оформляет накладную, по второму связывается с человеком.
     * Пусто — доставка курьером, и тогда адресом назначения служит `address`.
     */
    pickupAddress: textValue(data.pickupAddress, 400),
    // Сумма товаров без доставки. `total` — то, что платит покупатель, то есть
    // товары плюс доставка; у всех прежних заявок доставки нет, и обе суммы
    // совпадают.
    itemsTotal: priceValue(data.itemsTotal, priceValue(data.total, 0)),
    // comment остаётся ради старых заказов: поле с витрины убрано, но в панели
    // у прежних заявок текст должен читаться по-прежнему.
    comment: textValue(data.comment, 1000),
    visitorId: /^[a-f0-9]{32}$/.test(String(data.visitorId || '')) ? data.visitorId : null,
    clientIp: textValue(data.clientIp, 80),
    clientCity: textValue(data.clientCity, 100),
    clientRegion: textValue(data.clientRegion, 120),
    clientCountry: textValue(data.clientCountry, 100),
    // Код страны — ради флага в панелях: название приходит по-русски, а флаг
    // собирается из пары букв ISO. У прежних заявок его нет, там код находится
    // по названию (таблица в lib/client-icons.js).
    clientCountryCode: textValue(data.clientCountryCode, 4),
    clientIsp: textValue(data.clientIsp, 140),
    clientDevice: textValue(data.clientDevice, 40),
    clientModel: textValue(data.clientModel, 80),
    clientOs: textValue(data.clientOs, 80),
    clientBrowser: textValue(data.clientBrowser, 80),
    clientSource: textValue(data.clientSource, 120),
    status: 'new',
    // Черновик — заказ записан, но покупатель ещё не выбрал способ оплаты.
    // В панелях его нет и менеджеру он не уходит (см. блок про черновики выше).
    draft: !!data.draft,
    // Онлайн-оплата: null — «не запускалась». Так же читаются все прежние заказы.
    payment: null,
    createdAt: Date.now()
  };
  list.unshift(order);
  saveOrders(dropStaleDrafts(list));
  return order;
}

// Черновик становится заказом: покупатель выбрал способ оплаты. Возвращает
// признак того, что это случилось именно сейчас, — по нему шлётся уведомление
// менеджеру и засчитывается заказ в метрике, и ровно один раз.
function promoteOrder(id) {
  const list = getOrders();
  const order = list.find(o => o.id === id);
  if (!order) return { order: null, promoted: false };
  if (!order.draft) return { order, promoted: false };
  delete order.draft;
  saveOrders(list);
  return { order, promoted: true };
}

function getOrder(id) { return getOrders().find(o => o.id === id) || null; }

// Геолокация может прийти после мгновенного ответа покупателю. Обновляем только
// серверные технические поля, не затрагивая состав, сумму и статус заказа.
function updateOrderClient(id, data) {
  const list = getOrders();
  const order = list.find(x => x.id === id);
  if (!order) return null;
  const limits = {
    clientIp: 80, clientCity: 100, clientRegion: 120, clientCountry: 100,
    clientCountryCode: 4, clientIsp: 140, clientDevice: 40, clientModel: 80, clientOs: 80,
    clientBrowser: 80, clientSource: 120
  };
  for (const [field, max] of Object.entries(limits)) {
    if (data && data[field] !== undefined) order[field] = String(data[field] || '').slice(0, max);
  }
  saveOrders(list);
  return order;
}

// Ручной статус заказа («новый / в работе / выполнен / отменён») с панелей
// убран: его вёл менеджер вручную, и рядом с настоящим состоянием оплаты от
// кассы он только путал — заказ бывает и «новым», и уже оплаченным. Поле в
// данных осталось: у всех прежних заявок оно есть, а переписывать историю ради
// снятого селекта незачем.
function setOrderStatus(id, status) {
  if (!['new', 'processing', 'done', 'cancelled'].includes(status)) return null;
  const list = getOrders();
  const o = list.find(x => x.id === id);
  if (o) { o.status = status; saveOrders(list); }
  return o;
}

function deleteOrder(id) { saveOrders(getOrders().filter(o => o.id !== id)); }

/* ----------------------------- Оплата заказа ----------------------------- */
// Состояние оплаты живёт отдельным полем `payment`, а НЕ новым значением
// `status`. Статусы заказа («новый / в работе / выполнен / отменён») ведёт
// менеджер, и подмешивать туда оплату значит терять одно из двух: заказ
// одновременно бывает и оплачен, и в работе. Поле необязательное, поэтому
// прежние заказы читаются без изменений, а платёжка снимается без миграции.
//
// Состояния: 'pending' — счёт выставлен, ждём перевод; 'paid' — оплата
// подтверждена; 'mismatch' — вебхук пришёл с верной подписью, но сумма меньше
// ожидаемой, поэтому оплаченным заказ не считается и его должен посмотреть
// человек; 'expired', 'cancelled', 'failed' — так ответила касса про свой счёт
// (в схеме Express таких состояний не было вовсе: там вебхук приходит только на
// успех, и неоплаченный заказ висел в ожидании вечно).
const PAYMENT_STATES = ['pending', 'paid', 'mismatch', 'expired', 'cancelled', 'failed'];

// Начать оплату: записать ожидаемую сумму, выбранный способ и token, по которому
// потом узнаем вебхук именно этого заказа.
function startOrderPayment(id, data) {
  const list = getOrders();
  const order = list.find(x => x.id === id);
  if (!order) return null;
  // Уже подтверждённую оплату вторым счётом не сбрасываем: иначе повторное
  // нажатие «Оплатить» обнулило бы данные платежа поверх факта оплаты.
  if (order.payment && order.payment.status === 'paid') return order;
  const prev = order.payment || null;
  order.payment = {
    provider: textValue(data && data.provider, 40) || 'crocopay',
    status: 'pending',
    // Token — один на ЗАКАЗ, а не на счёт. Покупатель может сменить способ
    // оплаты, и тогда по прежнему счёту вебхук придёт с прежним токеном: с
    // перевыпуском мы отвергли бы его как чужой, то есть потеряли бы платёж,
    // который реально прошёл.
    token: (prev && /^[a-f0-9]{32}$/.test(String(prev.token || '')) ? prev.token : null)
      || (/^[a-f0-9]{32}$/.test(String((data && data.token) || '')) ? data.token : null),
    method: textValue(data && data.method, 40),
    // Ожидаемая сумма — в ОСНОВНЫХ единицах (рублях): именно так её понимает
    // касса при создании счёта, вопреки её же документации.
    amount: priceValue(data && data.amount, 0),
    currency: textValue(data && data.currency, 8).toUpperCase() || 'RUB',
    invoiceId: '',
    requisite: '',
    bank: '',
    owner: '',
    expiresAt: 0,
    startedAt: Date.now(),
    paidTotal: null,
    paidAt: null,
    note: ''
  };
  saveOrders(list);
  return order;
}

// Записать выставленный счёт: его id и реквизиты получателя. Отдельным шагом,
// потому что token должен существовать ДО создания счёта — он уходит в
// callback_url, а id счёта появляется только в ответе.
function attachOrderInvoice(id, data) {
  const list = getOrders();
  const order = list.find(x => x.id === id);
  if (!order || !order.payment) return null;
  if (order.payment.status === 'paid') return order;
  const pay = order.payment;
  pay.invoiceId = textValue(data && data.invoiceId, 64);
  pay.requisite = textValue(data && data.requisite, 200);
  pay.bank = textValue(data && data.bank, 80);
  pay.owner = textValue(data && data.owner, 120);
  pay.method = textValue(data && data.method, 40) || pay.method;
  pay.expiresAt = Number.isFinite(Number(data && data.expiresAt)) ? Number(data.expiresAt) : 0;
  saveOrders(list);
  return order;
}

// Закрыть оплату — по вебхуку или по ответу кассы на опрос статуса. Идемпотентно:
// платёжка вправе повторить вызов, а опрос идёт каждые несколько секунд —
// уведомлять менеджера второй раз незачем, отсюда `changed`.
//
// Липким состоянием сделан только 'paid': из 'expired' в 'paid' дорасти можно и
// нужно (вебхук об успехе вполне приходит после того, как опрос увидел
// истёкший счёт), а обратно — нет.
function settleOrderPayment(id, data) {
  const status = String((data && data.status) || '');
  if (!PAYMENT_STATES.includes(status) || status === 'pending') return null;
  const list = getOrders();
  const order = list.find(x => x.id === id);
  if (!order || !order.payment) return null;
  if (order.payment.status === 'paid') return { order, changed: false };
  if (order.payment.status === status) return { order, changed: false };
  order.payment.status = status;
  order.payment.paidTotal = priceValue(data && data.total, null);
  order.payment.paidAt = Date.now();
  order.payment.note = textValue(data && data.note, 300);
  saveOrders(list);
  return { order, changed: true };
}

/* --------------- Переезд с мультидоменности на один магазин --------------- */
/*
 * Раньше бренд, цены и видимость были «свои у каждого домена» и лежали в
 * sites.json, а каталог был общим мастером. Домен теперь один: под новый
 * арендуется свой VPS со своей копией приложения.
 *
 * Перенос одноразовый и идемпотентный — он срабатывает ровно тогда, когда рядом
 * ещё лежит sites.json, и переименовывает файл в sites.migrated.json, а не
 * удаляет: это единственная копия прежних настроек.
 *
 * Главное правило переноса: витрина обязана выглядеть ровно так же, как
 * выглядела вчера. Поэтому цены не «берутся из каталога», а считаются ровно тем
 * же способом, каким их считало представление сайта (множитель + ручная цена).
 */
function normHost(h) {
  let host = String(h || '').toLowerCase().split(',')[0].trim();
  if (host.startsWith('[')) {
    const end = host.indexOf(']');
    if (end >= 0) host = host.slice(1, end);
  } else {
    // У обычного hostname один двоеточие отделяет порт; в голом IPv6 их несколько.
    if (host.indexOf(':') === host.lastIndexOf(':')) host = host.replace(/:\d+$/, '');
  }
  return host.replace(/^www\./, '');
}

// Какой из прежних сайтов считать этим магазином. Побеждает тот, на котором
// реально шла торговля: у него больше всего заказов. Дальше — первый с доменом
// (демо-сайты в seed стояли без хостов), в самом конце — просто первый.
function pickPrimarySite(sites, orders) {
  const forced = String(process.env.STORE_PRIMARY_SITE || '').trim();
  if (forced) {
    const chosen = sites.find(s => s && s.id === forced);
    if (chosen) return chosen;
  }
  const counts = new Map();
  for (const o of (orders || [])) counts.set(o.siteId, (counts.get(o.siteId) || 0) + 1);
  const withOrders = sites.filter(s => counts.get(s.id));
  if (withOrders.length) return withOrders.sort((a, b) => counts.get(b.id) - counts.get(a.id))[0];
  return sites.find(s => (s.hosts || []).length) || sites[0];
}

const SITE_BRAND_FIELDS = ['storeName', 'tagline', 'accentColor', 'secondaryColor', 'currency', 'currencyPosition',
  'contactTelegram', 'contactPhone', 'footerNote', 'legalOperator', 'legalDetails', 'legalAddress', 'privacyEmail',
  'telegramBotToken', 'telegramChatId', 'logoImage', 'logoText', 'logoFont'];

function migrateFromSites() {
  if (!exists('sites')) return null;
  const sites = readJson('sites', []);
  const list = Array.isArray(sites) ? sites.filter(s => s && typeof s === 'object') : [];
  const report = { site: null, hosts: [], products: 0, hidden: 0, multiplier: 1, dropped: [] };
  if (list.length) {
    const site = pickPrimarySite(list, getOrders());
    report.site = site.storeName || site.id;
    // Домены только для отчёта в лог: «shop.ru» и «www.shop.ru» — одно имя.
    report.hosts = [...new Set((site.hosts || []).map(normHost))];
    report.dropped = list.filter(s => s !== site).map(s => s.storeName || s.id);

    // 1. Бренд, контакты и реквизиты оператора переезжают в общие настройки.
    const patch = {};
    for (const field of SITE_BRAND_FIELDS) if (site[field] !== undefined && site[field] !== null) patch[field] = site[field];
    patch.notifyReviews = site.notifyReviews !== false;
    // 2. Учётная запись — прежнего ВЛАДЕЛЬЦА, а не администратора домена: полный
    //    доступ был именно у него, и отдавать его паролю от урезанной панели
    //    значило бы молча раздать права.
    const current = getSettings();
    if (current.ownerPasswordHash) {
      patch.adminUsername = current.ownerUsername || 'admin';
      patch.adminPasswordHash = current.ownerPasswordHash;
    }
    const saved = saveSettings(patch);
    // Поля прежних двух учёток в файле больше не нужны.
    for (const field of ['ownerUsername', 'ownerPasswordHash']) delete saved[field];
    writeJson('settings', saved);

    // 3. Цены: то, что покупатель видел на этом домене, становится ценой товара.
    const multiplier = Number(site.priceMultiplier) > 0 ? Number(site.priceMultiplier) : 1;
    report.multiplier = multiplier;
    const overrides = site.overrides || {};
    const products = getProducts().map(p => applySiteView(p, multiplier, overrides[p.id] || {}));
    report.products = products.length;
    saveProducts(products);

    // 4. Скрытые на домене отзывы возвращаются в очередь модерации: удалять их
    //    нельзя, а показывать — значит вернуть на витрину то, что убрали руками.
    const hidden = new Set((site.hiddenReviews || []).map(String));
    if (hidden.size) {
      const reviews = getReviews().map(r => (hidden.has(r.id) && r.status === 'approved' ? Object.assign({}, r, { status: 'pending' }) : r));
      report.hidden = hidden.size;
      saveReviews(reviews);
    }
  }
  // Файл не удаляем — переименовываем: другой копии прежних настроек нет.
  try { fs.renameSync(fileFor('sites'), path.join(DATA_DIR, 'sites.migrated.json')); }
  catch (e) { try { fs.unlinkSync(fileFor('sites')); } catch (e2) {} }
  delete _cache.sites;
  return report;
}

// Товар в том виде, в каком его показывал сайт: множитель домена вбит в цены и
// доплаты, ручная цена стала базовой, «не показывать» — флагом видимости.
// Повторяет прежний viewFor() из lib/tenancy.js поле в поле, включая правило
// «у ручной цены акции нет».
function applySiteView(product, multiplier, override) {
  const round = n => Math.round(Number(n) || 0);
  const scale = n => round(Number(n || 0) * multiplier);
  const manualPrice = Number(override.price);
  const manual = override.price !== '' && override.price != null && Number.isFinite(manualPrice) && manualPrice > 0;
  const p = Object.assign({}, product);
  p.visible = override.enabled !== false;
  p.price = manual ? round(manualPrice) : scale(product.price);
  p.oldPrice = product.oldPrice ? scale(product.oldPrice) : null;
  p.hotDeal = manual ? false : !!product.hotDeal;
  p.hotDealPrice = (manual || !product.hotDealPrice) ? null : scale(product.hotDealPrice);
  if (multiplier !== 1) {
    p.storages = (product.storages || []).map(s => Object.assign({}, s, { add: scale(s.add) }));
    p.bands = (product.bands || []).map(g => Object.assign({}, g, {
      sizes: (g.sizes || []).map(x => Object.assign({}, x, { add: scale(x.add) })),
      options: (g.options || []).map(o => Object.assign({}, o, { add: scale(o.add) }))
    }));
    p.options = (product.options || []).map(g => Object.assign({}, g, {
      values: (g.values || []).map(v => Object.assign({}, v, { add: scale(v.add) }))
    }));
  }
  return p;
}

/* ----------------------------- Первичная инициализация ----------------------------- */

function ensureSeeded() {
  // Настройки: создаём, если файла нет. Генерируем секрет сессии и пароль админа по умолчанию.
  if (!exists('settings')) {
    const seed = require('../seed-data');
    const s = Object.assign(defaultSettings(), seed.settings || {});
    s.sessionSecret = crypto.randomBytes(24).toString('hex');
    s.adminPasswordHash = auth.hashPassword(process.env.ADMIN_PASSWORD || 'admin');
    writeJson('settings', s);
  } else {
    // добить недостающие поля, если файл старый
    const s = getSettings();
    const patch = {};
    if (!s.sessionSecret) patch.sessionSecret = crypto.randomBytes(24).toString('hex');
    if (!s.adminPasswordHash) patch.adminPasswordHash = auth.hashPassword(process.env.ADMIN_PASSWORD || 'admin');
    if (Object.keys(patch).length) saveSettings(patch);
  }

  // Товары и отзывы: наполняем демо-данными только если пусто.
  if (!exists('products')) {
    const seed = require('../seed-data');
    saveProducts(seed.products || []);
    saveReviews(seed.reviews || []);
  }
  if (!exists('orders')) saveOrders([]);

  // Установка с прежней мультидоменной версии: переносим настройки домена сюда.
  // Порядок важен — переносить есть куда только после того, как файлы созданы.
  const migrated = migrateFromSites();

  for (const name of ['settings', 'products', 'reviews', 'orders']) {
    try { fs.chmodSync(fileFor(name), 0o600); } catch (e) {}
  }
  return migrated;
}

module.exports = {
  DATA_DIR, UPLOAD_DIR, newId, ensureSeeded, normHost, deleteUploadIfUnused,
  getSettings, saveSettings, defaultSettings,
  getProducts, getProduct, visibleProducts, visibleProduct, isVisible,
  createProduct, updateProduct, deleteProduct, reorderProducts, categories, visibleCategories,
  getReviews, reviewsForProduct, ratingFor, approvedTotals, averageRating, moveReviews,
  createReview, setReviewStatus, getReview, updateReview, reviewStats,
  deleteReview, deleteReviewsForProduct, pendingReviewCount,
  saveReviews,
  getOrders, visibleOrders, getOrder, createOrder, promoteOrder, updateOrderClient, setOrderStatus, deleteOrder,
  startOrderPayment, attachOrderInvoice, settleOrderPayment, PAYMENT_STATES
};
