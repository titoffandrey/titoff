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
    return fallback;
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
    price: Number(data.price) || 0,
    oldPrice: data.oldPrice ? Number(data.oldPrice) : null,
    shortDesc: data.shortDesc || '',
    description: data.description || '',
    specs: data.specs || '',
    images: data.images || [],
    inStock: data.inStock !== false,
    badge: data.badge || '',
    hotDeal: !!data.hotDeal,
    hotDealPrice: data.hotDealPrice ? Number(data.hotDealPrice) : null,
    hotDealUntil: data.hotDealUntil ? Number(data.hotDealUntil) : null,
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
    price: data.price !== undefined ? Number(data.price) : p.price,
    oldPrice: data.oldPrice ? Number(data.oldPrice) : (data.oldPrice === '' ? null : p.oldPrice),
    shortDesc: data.shortDesc ?? p.shortDesc,
    description: data.description ?? p.description,
    specs: data.specs ?? p.specs,
    inStock: data.inStock !== undefined ? data.inStock !== false : p.inStock,
    badge: data.badge ?? p.badge,
    hotDeal: data.hotDeal !== undefined ? !!data.hotDeal : p.hotDeal,
    hotDealPrice: data.hotDealPrice !== undefined ? (data.hotDealPrice ? Number(data.hotDealPrice) : null) : p.hotDealPrice,
    hotDealUntil: data.hotDealUntil !== undefined ? (data.hotDealUntil ? Number(data.hotDealUntil) : null) : p.hotDealUntil
  });
  if (data.images) p.images = data.images;
  list[i] = p;
  saveProducts(list);
  return p;
}

function deleteProduct(id) {
  saveProducts(getProducts().filter(p => p.id !== id));
  // заодно чистим отзывы этого товара
  saveReviews(getReviews().filter(r => r.productId !== id));
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
    photos: data.photos || [],
    status: data.status || 'pending',
    createdAt: data.createdAt || Date.now()
  };
  list.unshift(review);
  saveReviews(list);
  return review;
}

function setReviewStatus(id, status) {
  const list = getReviews();
  const r = list.find(x => x.id === id);
  if (r) { r.status = status; saveReviews(list); }
  return r;
}

function deleteReview(id) {
  saveReviews(getReviews().filter(r => r.id !== id));
}

function pendingReviewCount() {
  return getReviews().filter(r => r.status === 'pending').length;
}

/* ----------------------------- Заказы ----------------------------- */

function getOrders() { return readJson('orders', []); }
function saveOrders(list) { writeJson('orders', list); }

function createOrder(data) {
  const list = getOrders();
  const order = {
    id: newId(),
    number: 'ORD-' + String(list.length + 1).padStart(4, '0'),
    siteId: data.siteId || null,       // к какому домену относится заказ
    siteName: data.siteName || '',
    host: data.host || '',
    items: data.items || [],
    total: data.total || 0,
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

function normHost(h) { return String(h || '').toLowerCase().split(':')[0].replace(/^www\./, '').trim(); }

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
    telegramBotToken: s.telegramBotToken, telegramChatId: s.telegramChatId, notifyReviews: s.notifyReviews,
    adminUsername: s.adminUsername, adminPasswordHash: s.adminPasswordHash,
    priceMultiplier: 1, overrides: {}, hiddenReviews: [],
    logoImage: null, logoText: '', logoFont: 'system', secondaryColor: ''
  };
}

function createSite(data) {
  const list = getSites();
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
    telegramBotToken: data.telegramBotToken || '',
    telegramChatId: data.telegramChatId || '',
    notifyReviews: data.notifyReviews !== false,
    adminUsername: data.adminUsername || 'admin',
    adminPasswordHash: data.adminPassword ? auth.hashPassword(data.adminPassword) : auth.hashPassword('admin'),
    priceMultiplier: Number(data.priceMultiplier) > 0 ? Number(data.priceMultiplier) : 1,
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
    'contactTelegram', 'contactPhone', 'footerNote', 'telegramBotToken', 'telegramChatId', 'adminUsername',
    'logoText', 'logoFont', 'secondaryColor'];
  fields.forEach(f => { if (data[f] !== undefined) s[f] = data[f]; });
  if (data.logoImage !== undefined) s.logoImage = data.logoImage;
  if (data.hosts !== undefined) s.hosts = parseHosts(data.hosts);
  if (data.notifyReviews !== undefined) s.notifyReviews = !!data.notifyReviews;
  if (data.priceMultiplier !== undefined && Number(data.priceMultiplier) > 0) s.priceMultiplier = Number(data.priceMultiplier);
  if (data.adminPassword && String(data.adminPassword).trim()) s.adminPasswordHash = auth.hashPassword(String(data.adminPassword).trim());
  if (data.overrides !== undefined) s.overrides = data.overrides;
  if (data.hiddenReviews !== undefined) s.hiddenReviews = data.hiddenReviews;
  list[i] = s;
  saveSites(list);
  return s;
}

function deleteSite(id) { saveSites(getSites().filter(s => s.id !== id)); }

// Записать оверрайды (цена/видимость) одного сайта.
function setSiteOverrides(id, overrides) {
  const list = getSites();
  const s = list.find(x => x.id === id);
  if (!s) return null;
  s.overrides = overrides;
  saveSites(list);
  return s;
}
function setSiteHiddenReviews(id, hidden) {
  const list = getSites();
  const s = list.find(x => x.id === id);
  if (!s) return null;
  s.hiddenReviews = hidden;
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
  s.priceMultiplier = Number(x.priceMultiplier) > 0 ? Number(x.priceMultiplier) : 1;
  s.hosts = parseHosts(x.hosts);
  return s;
}

module.exports = {
  DATA_DIR, UPLOAD_DIR, newId, ensureSeeded, normHost,
  getSettings, saveSettings,
  getProducts, getProduct, createProduct, updateProduct, deleteProduct, categories,
  getReviews, reviewsForProduct, ratingFor, createReview, setReviewStatus, deleteReview, pendingReviewCount,
  getOrders, createOrder, ordersForSite, setOrderStatus, deleteOrder,
  getSites, getSite, getSiteByHost, defaultSite, createSite, updateSite, deleteSite, setSiteOverrides, setSiteHiddenReviews
};
