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

const DATA_DIR = path.join(__dirname, '..', 'data');
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');

fs.mkdirSync(UPLOAD_DIR, { recursive: true });

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
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
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
function uploadIsUsed(filename) {
  if (!filename) return false;
  if (getProducts().some(p => (p.images || []).includes(filename))) return true;
  if (getReviews().some(r => (r.photos || []).includes(filename))) return true;
  return getSites().some(s => s.logoImage === filename);
}
function deleteUploadIfUnused(filename) {
  const name = safeUploadName(filename);
  if (!name || uploadIsUsed(name)) return false;
  try { fs.unlinkSync(path.join(UPLOAD_DIR, name)); return true; }
  catch (e) { return false; }
}

/* ----------------------------- Настройки ----------------------------- */

function defaultSettings() {
  return {
    storeName: 'iStore',
    tagline: 'Оригинальная техника Apple с гарантией',
    currency: '₽',
    currencyPosition: 'after', // 'after' -> "1000 ₽", 'before' -> "₽1000"
    accentColor: '#0071e3',
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
    adminUsername: 'admin',
    adminPasswordHash: '',     // задаётся при первом запуске
    ownerUsername: 'owner',    // вход в панель владельца /owner
    ownerPasswordHash: '',     // задаётся при первом запуске
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

function saveProducts(list) { writeJson('products', list); }

function createProduct(data) {
  const list = getProducts();
  const product = {
    id: newId(),
    name: data.name || 'Без названия',
    category: data.category || 'Прочее',
    price: priceValue(data.price, 0),
    oldPrice: optionalPrice(data.oldPrice, null),
    shortDesc: data.shortDesc || '',
    description: data.description || '',
    specs: data.specs || '',
    images: (data.images || []).map(safeUploadName).filter(Boolean),
    imageColors: data.imageColors || {}, // {имяФайла: названиеЦвета} — фото, привязанные к цвету
    inStock: data.inStock !== false,
    badge: data.badge || '',
    colors: data.colors || [],       // [{name, hex}]
    storages: data.storages || [],   // [{label, add}] — add = доплата к базовой цене
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
    name: data.name ?? p.name,
    category: data.category ?? p.category,
    price: data.price !== undefined ? priceValue(data.price, p.price) : p.price,
    oldPrice: data.oldPrice !== undefined ? optionalPrice(data.oldPrice, p.oldPrice) : p.oldPrice,
    shortDesc: data.shortDesc ?? p.shortDesc,
    description: data.description ?? p.description,
    specs: data.specs ?? p.specs,
    inStock: data.inStock !== undefined ? data.inStock !== false : p.inStock,
    badge: data.badge ?? p.badge,
    colors: data.colors !== undefined ? data.colors : (p.colors || []),
    storages: data.storages !== undefined ? data.storages : (p.storages || []),
    hotDeal: data.hotDeal !== undefined ? !!data.hotDeal : p.hotDeal,
    hotDealPrice: data.hotDealPrice !== undefined ? optionalPrice(data.hotDealPrice, p.hotDealPrice) : p.hotDealPrice,
    hotDealUntil: data.hotDealUntil !== undefined
      ? (Number.isFinite(Number(data.hotDealUntil)) && Number(data.hotDealUntil) > 0 ? Number(data.hotDealUntil) : null)
      : p.hotDealUntil
  });
  if (data.images) p.images = data.images.map(safeUploadName).filter(Boolean);
  if (data.imageColors !== undefined) p.imageColors = data.imageColors || {};
  list[i] = p;
  saveProducts(list);
  return p;
}

function deleteProduct(id) {
  const gone = getProduct(id);
  const goneReviews = getReviews().filter(r => r.productId === id);
  saveProducts(getProducts().filter(p => p.id !== id));
  // заодно чистим отзывы этого товара
  saveReviews(getReviews().filter(r => r.productId !== id));
  // и ссылки на него в настройках сайтов (цена/видимость), иначе копится мусор
  const sites = getSites();
  const goneReviewIds = new Set(goneReviews.map(r => r.id));
  let touched = false;
  for (const s of sites) {
    if (s.overrides && s.overrides[id]) { delete s.overrides[id]; touched = true; }
    if (s.hiddenReviews && s.hiddenReviews.some(reviewId => goneReviewIds.has(reviewId))) {
      s.hiddenReviews = s.hiddenReviews.filter(reviewId => !goneReviewIds.has(reviewId));
      touched = true;
    }
  }
  if (touched) saveSites(sites);
  // Файлы товара и его отзывов удаляем, только если на них больше никто не ссылается.
  const files = new Set((gone && gone.images) || []);
  for (const r of goneReviews) for (const f of (r.photos || [])) files.add(f);
  for (const f of files) deleteUploadIfUnused(f);
}

function categories() {
  const set = [];
  for (const p of getProducts()) if (!set.includes(p.category)) set.push(p.category);
  return set;
}

/* ----------------------------- Отзывы ----------------------------- */
// status: 'pending' | 'approved'
// Публично видны только 'approved'. Посетителю про модерацию не сообщаем.

function getReviews() { return readJson('reviews', []); }
function saveReviews(list) { writeJson('reviews', list); }

function reviewsForProduct(productId, approvedOnly) {
  let list = getReviews().filter(r => r.productId === productId);
  if (approvedOnly) list = list.filter(r => r.status === 'approved');
  return list.sort((a, b) => b.createdAt - a.createdAt);
}

function ratingFor(productId) {
  const list = reviewsForProduct(productId, true);
  if (!list.length) return { avg: 0, count: 0 };
  const sum = list.reduce((a, r) => a + Number(r.rating || 0), 0);
  return { avg: Math.round((sum / list.length) * 10) / 10, count: list.length };
}

function createReview(data) {
  const list = getReviews();
  const review = {
    id: newId(),
    productId: data.productId,
    author: (data.author || 'Аноним').slice(0, 60),
    rating: Math.min(5, Math.max(1, Number(data.rating) || 5)),
    text: (data.text || '').slice(0, 2000),
    photos: (data.photos || []).map(safeUploadName).filter(Boolean),
    aspects: sanitizeAspects(data.aspects), // {delivery, service, price} — оценки по аспектам 1..5
    status: data.status === 'approved' ? 'approved' : 'pending',
    createdAt: Number.isFinite(Number(data.createdAt)) ? Number(data.createdAt) : Date.now(),
    siteId: data.siteId || null,
    siteName: (data.siteName || '').slice(0, 100),
    privacyConsentAt: Number.isFinite(Number(data.privacyConsentAt)) ? Number(data.privacyConsentAt) : null,
    privacyConsentVersion: (data.privacyConsentVersion || '').slice(0, 40),
    publicationConsentAt: Number.isFinite(Number(data.publicationConsentAt)) ? Number(data.publicationConsentAt) : null,
    publicationConsentVersion: (data.publicationConsentVersion || '').slice(0, 40)
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

function deleteReview(id) {
  const list = getReviews();
  const gone = list.find(r => r.id === id);
  saveReviews(list.filter(r => r.id !== id));
  const sites = getSites(); let touched = false;
  for (const site of sites) {
    if ((site.hiddenReviews || []).includes(id)) {
      site.hiddenReviews = site.hiddenReviews.filter(reviewId => reviewId !== id);
      touched = true;
    }
  }
  if (touched) saveSites(sites);
  if (gone) for (const f of (gone.photos || [])) deleteUploadIfUnused(f);
}

function sanitizeAspects(aspects) {
  if (!aspects || typeof aspects !== 'object') return null;
  const out = {};
  for (const key of ['delivery', 'service', 'price']) {
    const n = Number(aspects[key]);
    out[key] = Number.isInteger(n) && n >= 1 && n <= 5 ? n : null;
  }
  return Object.values(out).some(Boolean) ? out : null;
}

function pendingReviewCount() {
  return getReviews().filter(r => r.status === 'pending').length;
}

/* ----------------------------- Заказы ----------------------------- */

function getOrders() { return readJson('orders', []); }
function saveOrders(list) { writeJson('orders', list); }

// Следующий номер заказа: максимум из уже выданных + 1.
// (по длине списка считать нельзя — после удаления заказов номера начали бы повторяться)
function nextOrderNumber(list) {
  let max = 0;
  for (const o of list) {
    const n = parseInt(String(o.number || '').replace(/\D+/g, ''), 10);
    if (n > max) max = n;
  }
  return 'ORD-' + String(max + 1).padStart(4, '0');
}

function createOrder(data) {
  const list = getOrders();
  const order = {
    id: newId(),
    number: nextOrderNumber(list),
    siteId: data.siteId || null,       // к какому домену относится заказ
    siteName: data.siteName || '',
    host: data.host || '',
    items: data.items || [],
    total: priceValue(data.total, 0),
    customerName: (data.customerName || '').slice(0, 100),
    contact: (data.contact || '').slice(0, 120),
    comment: (data.comment || '').slice(0, 1000),
    status: 'new',
    createdAt: Date.now()
  };
  list.unshift(order);
  saveOrders(list);
  return order;
}

function ordersForSite(siteId) { return getOrders().filter(o => o.siteId === siteId); }

function setOrderStatus(id, status) {
  if (!['new', 'processing', 'done', 'cancelled'].includes(status)) return null;
  const list = getOrders();
  const o = list.find(x => x.id === id);
  if (o) { o.status = status; saveOrders(list); }
  return o;
}

function deleteOrder(id) { saveOrders(getOrders().filter(o => o.id !== id)); }

/* ----------------------------- Сайты (домены) ----------------------------- */
// Мультитенант: один процесс обслуживает много доменов. Каталог и отзывы общие,
// а бренд/валюта/цены/видимость — свои у каждого сайта.

function getSites() { return readJson('sites', []); }
function saveSites(list) { writeJson('sites', list); }
function getSite(id) { return getSites().find(s => s.id === id) || null; }

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

function getSiteByHost(host) {
  const h = normHost(host);
  return getSites().find(s => (s.hosts || []).some(x => normHost(x) === h)) || null;
}

function defaultSite() {
  const s = getSettings();
  return {
    id: 'default', hosts: [], storeName: s.storeName, tagline: s.tagline,
    accentColor: s.accentColor, currency: s.currency, currencyPosition: s.currencyPosition,
    contactTelegram: s.contactTelegram, contactPhone: s.contactPhone, footerNote: s.footerNote,
    legalOperator: s.legalOperator, legalDetails: s.legalDetails, legalAddress: s.legalAddress, privacyEmail: s.privacyEmail,
    telegramBotToken: s.telegramBotToken, telegramChatId: s.telegramChatId, notifyReviews: s.notifyReviews,
    adminUsername: s.adminUsername, adminPasswordHash: s.adminPasswordHash,
    priceMultiplier: 1, overrides: {}, hiddenReviews: [],
    logoImage: null, logoText: '', logoFont: 'system', secondaryColor: ''
  };
}

function createSite(data) {
  const list = getSites();
  const multiplier = Number(data.priceMultiplier);
  const site = {
    id: newId(),
    hosts: parseHosts(data.hosts),
    storeName: data.storeName || 'Магазин',
    tagline: data.tagline || '',
    accentColor: data.accentColor || '#0071e3',
    currency: data.currency || '₽',
    currencyPosition: data.currencyPosition || 'after',
    contactTelegram: data.contactTelegram || '',
    contactPhone: data.contactPhone || '',
    footerNote: data.footerNote || '',
    legalOperator: data.legalOperator || '',
    legalDetails: data.legalDetails || '',
    legalAddress: data.legalAddress || '',
    privacyEmail: data.privacyEmail || '',
    telegramBotToken: data.telegramBotToken || '',
    telegramChatId: data.telegramChatId || '',
    notifyReviews: data.notifyReviews !== false,
    adminUsername: data.adminUsername || 'admin',
    adminPasswordHash: data.adminPassword ? auth.hashPassword(data.adminPassword) : auth.hashPassword('admin'),
    priceMultiplier: Number.isFinite(multiplier) && multiplier > 0 && multiplier <= 1000 ? multiplier : 1,
    overrides: {},
    hiddenReviews: [],
    logoImage: data.logoImage || null,
    logoText: data.logoText || '',
    logoFont: data.logoFont || 'system',
    secondaryColor: data.secondaryColor || '',
    createdAt: Date.now()
  };
  list.push(site);
  saveSites(list);
  return site;
}

function parseHosts(v) {
  if (Array.isArray(v)) return v.map(x => String(x).trim()).filter(Boolean);
  return String(v || '').split(/[\s,]+/).map(x => x.trim()).filter(Boolean);
}

function updateSite(id, data) {
  const list = getSites();
  const i = list.findIndex(s => s.id === id);
  if (i === -1) return null;
  const s = list[i];
  const fields = ['storeName', 'tagline', 'accentColor', 'currency', 'currencyPosition',
    'contactTelegram', 'contactPhone', 'footerNote', 'legalOperator', 'legalDetails', 'legalAddress', 'privacyEmail',
    'telegramBotToken', 'telegramChatId', 'adminUsername',
    'logoText', 'logoFont', 'secondaryColor'];
  fields.forEach(f => { if (data[f] !== undefined) s[f] = data[f]; });
  if (data.logoImage !== undefined) s.logoImage = data.logoImage;
  if (data.hosts !== undefined) s.hosts = parseHosts(data.hosts);
  if (data.notifyReviews !== undefined) s.notifyReviews = !!data.notifyReviews;
  if (data.priceMultiplier !== undefined) {
    const multiplier = Number(data.priceMultiplier);
    if (Number.isFinite(multiplier) && multiplier > 0 && multiplier <= 1000) s.priceMultiplier = multiplier;
  }
  if (data.adminPassword && String(data.adminPassword).trim()) s.adminPasswordHash = auth.hashPassword(String(data.adminPassword).trim());
  if (data.overrides !== undefined) s.overrides = data.overrides;
  if (data.hiddenReviews !== undefined) s.hiddenReviews = data.hiddenReviews;
  list[i] = s;
  saveSites(list);
  return s;
}

function deleteSite(id) {
  const list = getSites();
  const gone = list.find(s => s.id === id);
  saveSites(list.filter(s => s.id !== id));
  if (gone && gone.logoImage) deleteUploadIfUnused(gone.logoImage);
}

// Записать оверрайды (цена/видимость) одного сайта.
function setSiteOverrides(id, overrides) {
  const list = getSites();
  const s = list.find(x => x.id === id);
  if (!s) return null;
  const clean = {};
  for (const [productId, value] of Object.entries(overrides || {})) {
    if (!value || typeof value !== 'object') continue;
    const entry = {};
    if (value.enabled === false) entry.enabled = false;
    if (value.price !== undefined && value.price !== '') {
      const price = priceValue(value.price, null);
      if (price !== null) entry.price = price;
    }
    if (Object.keys(entry).length) clean[productId] = entry;
  }
  s.overrides = clean;
  saveSites(list);
  return s;
}
function setSiteHiddenReviews(id, hidden) {
  const list = getSites();
  const s = list.find(x => x.id === id);
  if (!s) return null;
  s.hiddenReviews = [...new Set((hidden || []).map(String))];
  saveSites(list);
  return s;
}

/* ----------------------------- Первичная инициализация ----------------------------- */

function ensureSeeded() {
  // Настройки: создаём, если файла нет. Генерируем секрет сессии и пароль админа по умолчанию.
  if (!exists('settings')) {
    const seed = require('../seed-data');
    const s = Object.assign(defaultSettings(), seed.settings || {});
    s.sessionSecret = crypto.randomBytes(24).toString('hex');
    s.adminPasswordHash = auth.hashPassword('admin'); // ЛОГИН admin / ПАРОЛЬ admin — сменить в «Настройках»!
    writeJson('settings', s);
  } else {
    // добить недостающие поля, если файл старый
    const s = getSettings();
    const patch = {};
    if (!s.sessionSecret) patch.sessionSecret = crypto.randomBytes(24).toString('hex');
    if (!s.adminPasswordHash) patch.adminPasswordHash = auth.hashPassword('admin');
    if (!s.ownerPasswordHash) patch.ownerPasswordHash = auth.hashPassword('owner');
    if (Object.keys(patch).length) saveSettings(patch);
  }
  // Пароль владельца при первом создании настроек
  if (!getSettings().ownerPasswordHash) saveSettings({ ownerPasswordHash: auth.hashPassword('owner') });

  // Товары и отзывы: наполняем демо-данными только если пусто.
  if (!exists('products')) {
    const seed = require('../seed-data');
    saveProducts(seed.products || []);
    saveReviews(seed.reviews || []);
  }
  if (!exists('orders')) saveOrders([]);

  // Сайты (домены): создаём демо-набор при первом запуске.
  if (!exists('sites')) {
    const seed = require('../seed-data');
    if (seed.sites && seed.sites.length) {
      saveSites(seed.sites.map(x => Object.assign(createSiteShape(x))));
    } else {
      saveSites([Object.assign(defaultSite(), { id: newId(), hosts: [], createdAt: Date.now() })]);
    }
  }
}

// Превращает описание сайта из seed в полноценный объект (хешируем пароль).
function createSiteShape(x) {
  const s = Object.assign(defaultSite(), x, { id: x.id || newId(), createdAt: Date.now() });
  s.adminPasswordHash = auth.hashPassword(x.adminPassword || 'admin');
  delete s.adminPassword;
  s.overrides = x.overrides || {};
  s.hiddenReviews = x.hiddenReviews || [];
  const multiplier = Number(x.priceMultiplier);
  s.priceMultiplier = Number.isFinite(multiplier) && multiplier > 0 && multiplier <= 1000 ? multiplier : 1;
  s.hosts = parseHosts(x.hosts);
  return s;
}

module.exports = {
  DATA_DIR, UPLOAD_DIR, newId, ensureSeeded, normHost, deleteUploadIfUnused,
  getSettings, saveSettings,
  getProducts, getProduct, createProduct, updateProduct, deleteProduct, categories,
  getReviews, reviewsForProduct, ratingFor, createReview, setReviewStatus, deleteReview, pendingReviewCount,
  getOrders, createOrder, ordersForSite, setOrderStatus, deleteOrder,
  getSites, getSite, getSiteByHost, defaultSite, createSite, updateSite, deleteSite, setSiteOverrides, setSiteHiddenReviews
};
