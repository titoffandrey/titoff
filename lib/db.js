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
// Телефон покупателя приводится к международному виду тем же модулем, что и
// поле ввода на витрине (см. шапку `public/phone.js`): в заказе он хранится
// одной формой — «+79991234567».
const PHONE = require('../public/phone.js');
// Скидка задаётся процентом, и верхняя граница у неё одна на хранилище, форму
// товара и показ. Модуль ничего не подключает сам, поэтому цикла тут нет.
const DISCOUNT = require('./discount');

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

/* Запись «всё или ничего»: временный файл → fsync → переименование → fsync
 * каталога.
 *
 * Одного `rename` мало. Он атомарен только в смысле «читатель увидит либо старый
 * файл, либо новый», но НЕ гарантирует, что содержимое временного файла успело
 * дойти до диска раньше самой записи о переименовании. При потере питания или
 * жёсткой перезагрузке ядро вправе сохранить переименование и потерять данные —
 * и на месте orders.json оказывается пустой файл. Для заказов и платёжной
 * истории это невосполнимо: счёт у покупателя остаётся, а заказа под него нет.
 *
 * fsync каталога нужен отдельно: без него на диск может не попасть сама запись
 * каталога о новом имени.
 */
function fsyncQuiet(fd) {
  try { fs.fsyncSync(fd); }
  // На некоторых файловых системах (например, смонтированных по сети) fsync не
  // поддержан. Это не повод ронять запись — данные уже отданы ядру.
  catch (e) { if (!e || (e.code !== 'EINVAL' && e.code !== 'ENOTSUP' && e.code !== 'EPERM')) throw e; }
}
function writeJson(name, data) {
  const target = fileFor(name);
  const tmp = target + '.' + process.pid + '.tmp';
  const body = JSON.stringify(data, null, 2);
  try {
    const fd = fs.openSync(tmp, 'w', 0o600);
    try {
      fs.writeFileSync(fd, body);
      fsyncQuiet(fd);                  // содержимое на диске ДО переименования
    } finally { fs.closeSync(fd); }
    fs.renameSync(tmp, target);        // атомарная подмена файла
    // Запись каталога о новом имени тоже должна пережить сбой питания.
    let dir = null;
    try { dir = fs.openSync(DATA_DIR, 'r'); fsyncQuiet(dir); }
    catch (e) { /* каталог не открывается на чтение — данные уже на диске */ }
    finally { if (dir !== null) fs.closeSync(dir); }
  } catch (e) {
    // Недописанный временный файл рядом с данными не оставляем.
    try { fs.unlinkSync(tmp); } catch (e2) {}
    throw e;
  } finally {
    // Сбрасываем кэш в любом случае: при неудачной записи в памяти остался бы
    // изменённый объект с mtime старого файла, и чтение вернуло бы то, чего на
    // диске нет.
    delete _cache[name];
  }
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
// Процент скидки: целое 0..MAX_PCT. Старая цена из него выводится (lib/discount.js),
// поэтому мусор здесь означал бы выдуманную зачёркнутую цену на витрине.
function pctValue(value, fallback) {
  if (value === '' || value == null) return fallback;
  const n = Math.round(Number(value));
  return Number.isFinite(n) && n >= 0 && n <= DISCOUNT.MAX_PCT ? n : fallback;
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
    // Валюта СЧЁТА. Цены каталога рублёвые всегда, а счёт касса умеет выставить
    // и в другой валюте — какие у неё включены, отвечает она сама. Курс к рублю
    // задаётся рядом: внешних источников курса у проекта нет.
    crocopayCurrency: 'RUB',
    // Курсы «сколько рублей за единицу валюты»: {USD: 90}. Валюты без курса
    // выставить нельзя — счёт вышел бы на выдуманную сумму.
    crocopayRates: {},
    // Показывать ли покупателю выбор валюты на странице оплаты. Выключено —
    // счёт всегда в crocopayCurrency.
    crocopayCurrencyChoice: false,
    // Вторая касса — MeridianPay. Включается и настраивается независимо от
    // первой: обе могут работать разом, любая по отдельности или ни одной.
    // Покупатель разницы не видит вовсе — способ он выбирает один и тот же, а
    // какая касса выдаст реквизиты, решает lib/payments.js.
    meridianpayEnabled: false,
    // Access-Token со страницы «Интеграция» в ЛК мерчанта.
    meridianpayApiKey: '',
    // UUID мерчанта из раздела мерчантов ЛК. Обязателен наравне с ключом: без
    // него `POST /h2h/order` не примет ни одной сделки.
    meridianpayMerchantId: '',
    // Secret Key из ЛК. Сейчас НЕ проверяет ничего: алгоритм поля `integrity` в
    // callback не описан в документации вовсе (см. lib/meridianpay.js), а
    // подтверждает платёж всё равно отдельный запрос статуса по API-ключу.
    // Хранится, чтобы включить проверку одной строкой, когда формула станет
    // известна из первого же настоящего callback.
    meridianpaySecret: '',
    // Какую кассу спрашивать первой. Вторая подхватывает молча, если первая
    // отказала, — покупатель об этом не узнаёт.
    payPrimary: 'crocopay',
    // Диапазон суммы ОДНОГО заказа, в рублях. Числа по умолчанию — пределы
    // CrocoPAY: платежей за этими границами она не проводит. Владелец меняет их
    // в настройках, когда касса разрешит другие: от потолка зависит не только
    // оплата, но и то, какие товары вообще продаются на витрине (дороже потолка
    // карточка становится «Нет в наличии»).
    payMinTotal: 1000,
    payMaxTotal: 250000,
    // Какие способы оплаты показывать покупателю. По умолчанию два для России;
    // трансграничные у касс включены, но админ добавляет их сам, когда
    // понадобятся. Список фильтруется ещё и тем, что включено у самих касс —
    // способ доступен, если его умеет ХОТЯ БЫ ОДНА.
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
    // Скидка — процент, а не сумма: старая цена выводится из него для каждой
    // сборки, поэтому она одинаково выгодна и в базовой, и в старшей.
    discountPercent: pctValue(data.discountPercent, 0),
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
    discountPercent: data.discountPercent !== undefined ? pctValue(data.discountPercent, p.discountPercent || 0) : (p.discountPercent || 0),
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
    imageBands: data.imageBands !== undefined ? data.imageBands : (p.imageBands || {})
  });
  // Наследство прежней модели скидки: сумма старой цены и «горящая акция» со
  // своей ценой и таймером. Пока товар не пересохраняли, старая цена ещё
  // читается (из неё выводится процент), но первое же сохранение из формы
  // убирает эти поля — двух источников у одной скидки быть не должно.
  if (data.discountPercent !== undefined) {
    delete p.oldPrice; delete p.hotDeal; delete p.hotDealPrice; delete p.hotDealUntil;
  }
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

/* Ответ магазина на отзыв: {text, at} либо null.
 *
 * Отдельным объектом, а не парой полей рядом с отзывом: «поля нет — ответа нет»,
 * поэтому все прежние записи читаются без миграции, а витрине достаточно одной
 * проверки. Пустой текст и есть удаление ответа — отдельной ручки для этого не
 * нужно, форма и так шлёт текст целиком.
 *
 * Дата ответа при правке НЕ обновляется: опечатку в уже показанном ответе
 * исправляют задним числом, и «Ответ магазина от сегодня» под отзывом
 * трёхмесячной давности читалось бы как новый ответ.
 */
function replyValue(input, prev) {
  if (input === null) return null;
  const text = textValue(input && input.text, 2000).trim();
  if (!text) return null;
  const at = Number(input && input.at);
  return { text, at: Number.isFinite(at) && at > 0 ? at : (Number(prev && prev.at) || Date.now()) };
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
    reply: replyValue(data.reply, null),              // ответ магазина, см. replyValue

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
  // Пустой текст ответа — это его удаление, поэтому поле обнуляется, а не
  // остаётся прежним: иначе снять неудачный ответ было бы нечем.
  if (data.reply !== undefined) rv.reply = replyValue(data.reply, rv.reply);
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
 * менеджеру он не приходит, в метрике не засчитан, а товары остаются в корзине.
 *
 * А вот В ПАНЕЛИ он теперь виден — своим состоянием «способ не выбран» и своей
 * плиткой в сводке. Данные покупателя в черновике уже полные, вместе с
 * телефоном: это брошенная на последнем шаге покупка, и звонок по ней стоит
 * дороже, чем чистота списка. В выручку и в уведомления черновик по-прежнему не
 * попадает — заказом он не стал.
 *
 * `getOrders()` отдаёт ВСЁ: на нём построены все записи в файл, и
 * фильтрованный список, отданный в saveOrders, стёр бы черновики или архивную
 * платёжную историю заодно. `visibleOrders()` — только рабочий список панели;
 * архив остаётся в этом же файле для webhook и фоновой сверки.
 */
function isOrderArchived(order) {
  return !!(order && order.archive && order.archive.active === true);
}
function visibleOrders() { return getOrders().filter(order => !isOrderArchived(order)); }
function archivedOrders() { return getOrders().filter(isOrderArchived); }

// Брошенные черновики чистим при записи новых: покупатель, ушедший со страницы
// оплаты, оставляет запись навсегда, а таких больше, чем купивших.
//
// Неделя, а не сутки: раз черновик показывается менеджеру, он должен дожить до
// того, как менеджер до него доберётся. Суточный срок молча уносил заявку с
// телефоном покупателя раньше, чем по ней успевали позвонить.
const DRAFT_TTL = 7 * 24 * 60 * 60 * 1000;
function dropStaleDrafts(list) {
  const edge = Date.now() - DRAFT_TTL;
  // Любая финансовая или архивная запись сохраняется fail-closed. В штатном
  // потоке payment снимает draft раньше, но legacy/corrupt JSON не должен из-за
  // одного флага потерять callback уже выданного счёта или возможность restore.
  return list.filter(o => isOrderArchived(o) || o.payment || !o.draft || Number(o.createdAt) > edge);
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
    /* Телефон — главный контакт заказа, и хранится он ровно одной формой
     * (E.164, «+79991234567»): по нему звонят, его же ставят в накладную, и
     * искать заказ по номеру можно только когда номер записан одинаково.
     * Приводит его тот же модуль, что форматирует поле ввода; не номер —
     * пустая строка, как у всех прежних заявок, где поля не было вовсе.
     * Маршрут до этого места мусор всё равно не пропускает. */
    phone: PHONE.store(data.phone),
    // Telegram или почта — необязательный второй канал. У заявок, оформленных
    // до отдельного поля телефона, он единственный.
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
  if (isOrderArchived(order)) return { order, promoted: false, archived: true };
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

function archiveEvent(order, active, by, reason) {
  const now = Date.now();
  const previous = order.archive && typeof order.archive === 'object' ? order.archive : {};
  const history = Array.isArray(previous.history) ? previous.history.slice(-19) : [];
  const actor = textValue(by, 40) || 'admin';
  const why = textValue(reason, 80);
  history.push({ action: active ? 'archive' : 'restore', at: now, by: actor, reason: why });
  order.archive = Object.assign({}, previous, { active: !!active, history });
  if (active) {
    order.archive.at = now;
    order.archive.by = actor;
    delete order.archive.restoredAt;
    delete order.archive.restoredBy;
    delete order.archive.restoredReason;
  } else {
    order.archive.restoredAt = now;
    order.archive.restoredBy = actor;
    order.archive.restoredReason = why;
  }
  return order.archive;
}

// «Удалить» в панели означает убрать заказ из рабочего списка. Физически
// стирать его нельзя: даже failed/expired invoice может оплатиться позднее, а
// callback обязан найти прежние id/token/amount. Архив лежит на том же объекте
// и потому не меняет ни платёжные адреса, ни историю попыток.
function archiveOrder(id, by) {
  const list = getOrders();
  const order = list.find(o => o.id === id);
  if (!order) return { ok: false, reason: 'not_found' };
  if (isOrderArchived(order)) return { ok: true, changed: false, order };
  archiveEvent(order, true, by || 'admin', 'admin_delete');
  saveOrders(list);
  return { ok: true, changed: true, order };
}

function restoreOrder(id, by) {
  const list = getOrders();
  const order = list.find(o => o.id === id);
  if (!order) return { ok: false, reason: 'not_found' };
  if (!isOrderArchived(order)) return { ok: true, changed: false, order };
  archiveEvent(order, false, by || 'admin', 'admin_restore');
  saveOrders(list);
  return { ok: true, changed: true, order };
}

// Совместимость старого внутреннего имени: сторонний локальный вызов тоже
// получает безопасное поведение вместо физического удаления.
function deleteOrder(id) {
  return archiveOrder(id, 'admin').ok;
}

/* Покупатель может вернуться к оформлению только из чистого черновика — до
 * первого обращения к кассе. `!payLive` здесь недостаточно: у timeout или
 * частичного ответа реквизитов на экране ещё нет, но invoice уже мог появиться
 * у провайдера и оплатиться позднее.
 *
 * Проверка вынесена отдельно для рендера, а удаление повторяет её В ТОЙ ЖЕ
 * синхронной операции чтение→запись. Поэтому параллельный start либо успеет
 * записать payment и заблокирует отмену, либо увидит, что черновика уже нет,
 * после своего сетевого `await` и не создаст счёт.
 */
function canDiscardDraftOrder(order) {
  return !!order && !isOrderArchived(order)
    && order.status === 'new' && order.draft === true && order.payment === null;
}
function discardDraftOrder(id) {
  const list = getOrders();
  const index = list.findIndex(order => order.id === id);
  if (index < 0) return { ok: false, reason: 'not_found' };
  const order = list[index];
  if (!canDiscardDraftOrder(order)) return { ok: false, reason: 'locked', order };
  list.splice(index, 1);
  saveOrders(list);
  return { ok: true, order };
}

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

// Одна заявка может пережить несколько счетов: касса не нашла реквизиты,
// покупатель сменил способ, ответ первого запроса пришёл позже второго. Раньше
// все эти события писались в один изменяемый `payment`, поэтому старый ответ
// мог истечь или оплатить уже новый счёт. `attempts` хранит адресные попытки, а
// верхние поля `payment` остаются зеркалом активной (или оплаченной) — так
// прежний рендер и старые заказы читаются без миграции.
const ATTEMPT_ID_RE = /^[a-f0-9]{24,64}$/;
const REQUEST_ID_RE = /^[a-f0-9]{24,64}$/;
const MAX_PAYMENT_ATTEMPTS = 100;
const ATTEMPT_FIELDS = [
  'provider', 'status', 'token', 'requestId', 'method', 'actualMethod',
  'amount', 'currency', 'invoiceId', 'requisite', 'bank', 'owner',
  'expiresAt', 'startedAt', 'paidTotal', 'paidAt', 'closedAt', 'note',
  'lastErrorCode', 'lastErrorAt', 'providerTries',
  'lastCheckedAt', 'lastCheckError', 'lastProviderState'
];

function validAttemptId(value) {
  const id = String(value || '');
  return ATTEMPT_ID_RE.test(id) ? id : '';
}

function attemptSnapshot(pay, id) {
  const out = { id: validAttemptId(id || (pay && pay.attemptId)) };
  for (const key of ATTEMPT_FIELDS) if (pay && pay[key] !== undefined) out[key] = pay[key];
  out.status = PAYMENT_STATES.includes(out.status) ? out.status : 'pending';
  return out;
}

function ensureAttemptHistory(pay) {
  if (Array.isArray(pay.attempts)) return pay.attempts;
  const id = validAttemptId(pay.attemptId) || crypto.randomBytes(12).toString('hex');
  pay.attemptId = id;
  pay.attempts = [attemptSnapshot(pay, id)];
  return pay.attempts;
}

function paymentAttempts(order) {
  const pay = order && order.payment;
  if (!pay) return [];
  if (Array.isArray(pay.attempts)) return pay.attempts;
  // Старый заказ ещё не перезаписываем одним чтением. Для поиска его верхние
  // поля выглядят одной legacy-попыткой; id может отсутствовать, token/invoiceId
  // всё равно позволяют безопасно найти её.
  return [attemptSnapshot(pay, pay.attemptId)];
}

function findPaymentAttempt(order, query) {
  const pay = order && order.payment;
  if (!pay) return null;
  const q = query || {};
  const hasAttemptId = String(q.attemptId || '') !== '';
  const hasRequestId = String(q.requestId || '') !== '';
  const hasToken = String(q.token || '') !== '';
  const hasInvoiceId = String(q.invoiceId || '') !== '';
  const id = validAttemptId(q.attemptId);
  const requestId = REQUEST_ID_RE.test(String(q.requestId || '')) ? String(q.requestId) : '';
  const token = String(q.token || '');
  const invoiceId = String(q.invoiceId || '');
  let list = paymentAttempts(order);
  // Если вызывающий адресовал конкретную попытку, неверный или уже чужой
  // идентификатор не должен молча превращаться в «возьми активную». Иначе
  // поздний ответ старого счёта снова сможет испортить новый.
  const addressed = hasAttemptId || hasRequestId || hasToken || hasInvoiceId;
  if (hasAttemptId) {
    if (!id) return null;
    list = list.filter(a => a.id === id);
  }
  if (hasRequestId) {
    if (!requestId) return null;
    list = list.filter(a => a.requestId === requestId);
  }
  if (hasToken) list = list.filter(a => String(a.token || '') === token);
  if (hasInvoiceId) list = list.filter(a => String(a.invoiceId || '') === invoiceId);
  if (addressed) return list[0] || null;
  return list.find(a => a.id && a.id === pay.attemptId) || list[list.length - 1] || null;
}

function syncPayment(pay, attempt) {
  pay.attemptId = attempt.id || pay.attemptId || '';
  for (const key of ATTEMPT_FIELDS) {
    if (attempt[key] === undefined) delete pay[key];
    else pay[key] = attempt[key];
  }
  return pay;
}

// Начать оплату: записать ожидаемую сумму, выбранный способ и token, по которому
// потом узнаем webhook именно этой попытки заказа.
function startOrderPayment(id, data) {
  const list = getOrders();
  const order = list.find(x => x.id === id);
  if (!order) return null;
  // Архив не отменяет уже выпущенный invoice (его продолжают сверять), но
  // выпускать новый счёт у удалённого из панели заказа нельзя.
  if (isOrderArchived(order)) return null;
  if (order.status === 'cancelled') return null;
  // Уже подтверждённую оплату вторым счётом не сбрасываем: иначе повторное
  // нажатие «Оплатить» обнулило бы данные платежа поверх факта оплаты.
  if (order.payment && (order.payment.status === 'paid' || order.payment.status === 'mismatch')) return order;
  const prev = order.payment || null;
  const attempts = prev ? ensureAttemptHistory(prev) : [];
  const requestId = REQUEST_ID_RE.test(String((data && data.requestId) || '')) ? String(data.requestId) : '';
  // Потерялся ответ между сервером и браузером — тот же requestId возвращает ту
  // же попытку и никогда не создаёт второй счёт. Новый осознанный клик получает
  // новый requestId на витрине.
  const existing = requestId && attempts.find(a => a.requestId === requestId);
  if (existing) return order;
  // JSON-хранилище переписывается целиком. Один заказ не должен расти без
  // границы из-за автоматических/злонамеренных кликов. Удалять invoice, paid,
  // mismatch, timeout и другие двусмысленные попытки нельзя — это финансовый
  // аудит; после ста попыток безопаснее остановить новые и подключить менеджера.
  if (attempts.length >= MAX_PAYMENT_ATTEMPTS) return null;
  const attempt = {
    id: validAttemptId(data && data.attemptId) || crypto.randomBytes(12).toString('hex'),
    provider: textValue(data && data.provider, 40) || 'crocopay',
    status: 'pending',
    // Token свой у каждой попытки. Он вместе с attemptId возвращается в callback,
    // поэтому старый оплаченный счёт сверяется со своей суммой и валютой, а не с
    // теми, которые успела записать следующая попытка.
    token: /^[a-f0-9]{32}$/.test(String((data && data.token) || '')) ? String(data.token) : null,
    requestId,
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
    closedAt: null,
    note: '',
    lastErrorCode: '',
    lastErrorAt: null,
    providerTries: 0,
    lastCheckedAt: null,
    lastCheckError: '',
    lastProviderState: ''
  };
  attempts.push(attempt);
  order.payment = { attempts };
  syncPayment(order.payment, attempt);
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
  const pay = order.payment;
  const attempts = ensureAttemptHistory(pay);
  const selector = data && data.attemptId ? { attemptId: data.attemptId }
    : data && data.requestId ? { requestId: data.requestId }
      : data && data.token ? { token: data.token } : {};
  const attempt = findPaymentAttempt(order, selector);
  if (!attempt) return null;
  const invoiceId = textValue(data && data.invoiceId, 64);
  // Привязка invoice одноразовая. Повтор того же ответа идемпотентен, а другой
  // id для уже связанной попытки — поздний/чужой ответ, который надо отвергнуть.
  if (attempt.status !== 'pending' || (attempt.invoiceId && attempt.invoiceId !== invoiceId)) return null;
  attempt.invoiceId = invoiceId;
  attempt.requisite = textValue(data && data.requisite, 200);
  attempt.bank = textValue(data && data.bank, 80);
  attempt.owner = textValue(data && data.owner, 120);
  attempt.method = textValue(data && data.method, 40) || attempt.method;
  // Явно переданная пустая строка — важный факт: POST не подтвердил маршрут.
  // Не превращаем её в запрошенный method, иначе GET без paymentOption позже
  // сделал бы неподтверждённый (в том числе трансграничный) счёт оплачиваемым.
  if (data && Object.prototype.hasOwnProperty.call(data, 'actualMethod')) {
    attempt.actualMethod = textValue(data.actualMethod, 40);
  } else if (!attempt.actualMethod) attempt.actualMethod = attempt.method;
  attempt.expiresAt = Number.isFinite(Number(data && data.expiresAt)) ? Number(data.expiresAt) : 0;
  attempt.providerTries = Math.max(0, Math.floor(Number(data && data.providerTries) || attempt.providerTries || 0));
  // Оплаченная другая попытка остаётся главным фактом заказа. Поздний ответ
  // всё равно сохраняем в истории для аудита, но поверх paid его не показываем.
  if (pay.status !== 'paid' && pay.attemptId === attempt.id) syncPayment(pay, attempt);
  pay.attempts = attempts;
  saveOrders(list);
  return order;
}

// Зафиксировать безопасный код отказа без сырого ответа кассы и без реквизитов.
// По нему повтор потерянного HTTP-ответа вернёт тот же исход, а менеджер увидит,
// почему у заказа нет счёта.
function failOrderPaymentAttempt(id, data) {
  const list = getOrders();
  const order = list.find(x => x.id === id);
  if (!order || !order.payment) return null;
  const pay = order.payment;
  const attempts = ensureAttemptHistory(pay);
  const selector = data && data.attemptId ? { attemptId: data.attemptId }
    : data && data.requestId ? { requestId: data.requestId }
      : data && data.token ? { token: data.token } : {};
  const attempt = findPaymentAttempt(order, selector);
  if (!attempt) return null;
  // Ошибка относится только к ещё незавершённому ответу POST. Она не должна
  // затереть успешно выданные реквизиты или терминальный статус этой попытки.
  if (attempt.status !== 'pending' || (attempt.invoiceId && attempt.requisite)) return null;
  attempt.lastErrorCode = textValue(data && data.errorCode, 40);
  attempt.lastErrorAt = Date.now();
  attempt.providerTries = Math.max(0, Math.floor(Number(data && data.providerTries) || attempt.providerTries || 0));
  if (pay.status !== 'paid' && pay.attemptId === attempt.id) syncPayment(pay, attempt);
  pay.attempts = attempts;
  saveOrders(list);
  return order;
}

// Обновить срок/состояние конкретного счёта после GET, не позволяя позднему
// ответу старой попытки менять новую.
function refreshOrderPaymentAttempt(id, data) {
  const list = getOrders();
  const order = list.find(x => x.id === id);
  if (!order || !order.payment) return null;
  const pay = order.payment;
  const attempts = ensureAttemptHistory(pay);
  const attempt = findPaymentAttempt(order, data);
  if (!attempt) return null;
  if (data && data.invoiceId && String(attempt.invoiceId || '') !== String(data.invoiceId)) return null;
  if (Number.isFinite(Number(data && data.expiresAt)) && Number(data.expiresAt) > 0) {
    attempt.expiresAt = Number(data.expiresAt);
  }
  if (Number.isFinite(Number(data && data.lastCheckedAt)) && Number(data.lastCheckedAt) > 0) {
    attempt.lastCheckedAt = Number(data.lastCheckedAt);
  }
  if (data && data.lastCheckError !== undefined) {
    attempt.lastCheckError = textValue(data.lastCheckError, 40);
  }
  if (data && data.lastProviderState !== undefined) {
    attempt.lastProviderState = textValue(data.lastProviderState, 24);
  }
  if (pay.status !== 'paid' && pay.attemptId === attempt.id) syncPayment(pay, attempt);
  pay.attempts = attempts;
  saveOrders(list);
  return order;
}

// Закрыть оплату — по вебхуку или по ответу кассы на опрос статуса. Идемпотентно:
// платёжка вправе повторить вызов, а опрос идёт каждые несколько секунд —
// уведомлять менеджера второй раз незачем, отсюда `changed`.
//
// `paid` липкий навсегда. `mismatch` липкий относительно неуспешных состояний:
// Success уже означает, что деньги могли прийти, поэтому поздний Expired не
// должен снова предложить платить; при точной повторной сверке mismatch может
// дорасти до paid.
function settleOrderPayment(id, data) {
  const status = String((data && data.status) || '');
  if (!PAYMENT_STATES.includes(status) || status === 'pending') return null;
  const list = getOrders();
  const order = list.find(x => x.id === id);
  if (!order || !order.payment) return null;
  const pay = order.payment;
  const attempts = ensureAttemptHistory(pay);
  const attempt = findPaymentAttempt(order, data) || (!data || (!data.attemptId && !data.invoiceId && !data.token) ? findPaymentAttempt(order) : null);
  if (!attempt) return { order, changed: false, stale: true };
  if (data && data.invoiceId && String(attempt.invoiceId || '') !== String(data.invoiceId)) {
    return { order, changed: false, stale: true };
  }
  // Саму подтверждённую попытку поздний Expired/Failed не «разоплачивает».
  // Но если оплачен ДРУГОЙ счёт заказа, эту попытку всё равно закрываем в
  // истории: иначе она навечно останется pending и будет опрашиваться в фоне.
  if (attempt.status === 'paid' && status !== 'paid') return { order, changed: false, attempt };
  // Success с несовпавшими реквизитами уже означает «деньги могли прийти».
  // Поздний Expired не должен снова предложить покупателю платить; разрешён
  // только рост mismatch -> paid после исправившейся точной сверки.
  if (attempt.status === 'mismatch' && status !== 'paid' && status !== 'mismatch') {
    return { order, changed: false, attempt };
  }
  if (attempt.status === status && (status !== 'paid' || pay.status === 'paid')) {
    return { order, changed: false, attempt };
  }
  const attemptAlreadyHadFunds = attempt.status === 'paid' || attempt.status === 'mismatch';
  attempt.status = status;
  attempt.paidTotal = priceValue(data && data.total, null);
  if (status === 'paid' || status === 'mismatch') attempt.paidAt = Date.now();
  else attempt.closedAt = Date.now();
  attempt.note = textValue(data && data.note, 300);
  // Оплата или расхождение на любом ещё действительном счёте важнее активной
  // попытки: показываем и уведомляем именно про тот счёт, где пришли деньги.
  const paidAggregateIsSticky = pay.status === 'paid' && status !== 'paid';
  if (!paidAggregateIsSticky && (status === 'paid' || status === 'mismatch' || pay.attemptId === attempt.id)) {
    syncPayment(pay, attempt);
  }
  // Если после удаления деньги пришли ВПЕРВЫЕ по этой попытке, заказ обязан
  // вернуться менеджеру. Повтор webhook и mismatch→paid уже известного платежа
  // архив намеренно не снимают; новый оплаченный invoice — снимает.
  if (!attemptAlreadyHadFunds && (status === 'paid' || status === 'mismatch') && isOrderArchived(order)) {
    archiveEvent(order, false, 'system:payment', 'payment_received');
  }
  pay.attempts = attempts;
  saveOrders(list);
  return { order, changed: true, attempt };
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
  // Скидка переезжает процентом: он не зависит ни от множителя домена, ни от
  // ручной цены, поэтому витрина после переезда показывает ту же выгоду, что и
  // до него. Правило «у ручной цены акции нет» сохранено: ручная цена и была
  // окончательной, зачёркивать рядом с ней нечего.
  const legacy = DISCOUNT.fromLegacy(product);
  p.price = manual ? round(manualPrice) : scale(legacy.price);
  p.discountPercent = manual ? 0 : legacy.percent;
  delete p.oldPrice; delete p.hotDeal; delete p.hotDealPrice; delete p.hotDealUntil;
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
  getOrders, visibleOrders, archivedOrders, isOrderArchived, getOrder, createOrder, promoteOrder,
  updateOrderClient, setOrderStatus, archiveOrder, restoreOrder, deleteOrder,
  canDiscardDraftOrder, discardDraftOrder,
  startOrderPayment, attachOrderInvoice, failOrderPaymentAttempt,
  refreshOrderPaymentAttempt, settleOrderPayment,
  paymentAttempts, findPaymentAttempt, PAYMENT_STATES
};
