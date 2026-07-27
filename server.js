'use strict';
// Точка входа. Мультитенант: один процесс — много доменов. Без внешних зависимостей.
const path = require('path');
const fs = require('fs');

const db = require('./lib/db');
const auth = require('./lib/auth');
const { sendTelegram } = require('./lib/telegram');
const R = require('./lib/render');
const D = require('./lib/deals');
const T = require('./lib/tenancy');
const O = require('./lib/owner-views');
const S = require('./lib/site-views');
const IMG = require('./lib/images');
const { Analytics, clientDetails } = require('./lib/analytics');
const { App } = require('./lib/server-lib');

db.ensureSeeded();
const metrics = new Analytics({ dataDir: db.DATA_DIR, geoEnabled: process.env.GEOIP_ENABLED !== '0' });

const PORT = process.env.PORT || 3000;
const app = new App({ secret: db.getSettings().sessionSecret || 'fallback-secret', uploadDir: db.UPLOAD_DIR });

app.static('/static', path.join(__dirname, 'public'));
app.static('/uploads', db.UPLOAD_DIR, { extensions: ['.jpg', '.jpeg', '.png', '.gif', '.webp'] });

const settings = () => db.getSettings();
// Multipart держит проверенные изображения в памяти. На диск они попадают только
// здесь — после проверки маршрута и прав доступа.
function persistUploads(files) {
  const names = [];
  for (const file of (files || [])) {
    if (!file || path.basename(file.filename || '') !== file.filename) continue;
    if (file.content) {
      fs.writeFileSync(path.join(db.UPLOAD_DIR, file.filename), file.content, { flag: 'wx' });
      delete file.content;
    }
    names.push(file.filename);
  }
  return names;
}
const asArray = (v) => v == null ? [] : (Array.isArray(v) ? v : [v]);
const parseDt = (v) => { if (!v) return null; const t = Date.parse(v); return isNaN(t) ? null : t; };
// Варианты из формы: цвета «Название|#hex» и память «Метка|доплата» по строке.
const safeHex = (v, fallback) => { const h = String(v || '').trim(); return /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(h) ? h : (fallback || '#cccccc'); };
const short = (v, max) => String(v == null ? '' : v).slice(0, max);
const parseColors = (txt) => String(txt || '').split('\n').map(l => l.trim()).filter(Boolean).map(l => { const [name, hex] = l.split('|'); return { name: (name || '').trim().slice(0, 40), hex: safeHex(hex) }; }).filter(c => c.name);
const parseStorages = (txt) => String(txt || '').split('\n').map(l => l.trim()).filter(Boolean).map(l => { const [label, add] = l.split('|'); const n = Number(add); return { label: (label || '').trim().slice(0, 80), add: Number.isFinite(n) && n >= 0 && n <= 1e12 ? Math.round(n) : 0 }; }).filter(s => s.label);
function tgEsc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
function isLoopback(address) { return /^(?:127(?:\.\d+){3}|::1|::ffff:127(?:\.\d+){3})$/.test(String(address || '')); }
function trustedProxy(req) { return process.env.TRUST_PROXY === '1' || isLoopback(req.socket && req.socket.remoteAddress); }
function requestHost(req) {
  const raw = String(req.headers.host || '').split(',')[0].trim();
  return /^(?:[a-z0-9.-]+(?::\d{1,5})?|\[[0-9a-f:.]+\](?::\d{1,5})?)$/i.test(raw) ? raw : 'localhost';
}
function siteOf(req) {
  const localHost = ['localhost', '127.0.0.1', '::1'].includes(db.normHost(requestHost(req)));
  const localPreview = localHost && isLoopback(req.socket && req.socket.remoteAddress);
  const siteQuery = (localPreview || process.env.ALLOW_SITE_QUERY === '1') ? req.query.site : null;
  return T.resolveSite(req.headers.host, siteQuery);
}
// Абсолютный адрес сайта (для canonical, Open Graph, sitemap).
function originOf(req) {
  const forwardedProto = trustedProxy(req) ? String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() : '';
  const proto = forwardedProto === 'https' || !!(req.socket && req.socket.encrypted) ? 'https' : 'http';
  const host = requestHost(req);
  return proto + '://' + host;
}
// Оптимизировать загруженные фото: WebP + очистка метаданных.
const optimizeUploads = (files, maxSize, opts) => IMG.optimizeMany(db.UPLOAD_DIR, persistUploads(files), maxSize, opts);
// Логотип сайта: удалить старый (если попросили), загрузить/оптимизировать новый, иначе оставить как было.
async function resolveLogo(req, site) {
  const current = site ? site.logoImage : null;
  const remove = req.body.removeLogo !== undefined;
  const up = await optimizeUploads(req.filesFor('logo'), 480);
  const value = up.length ? up[0] : (remove ? null : current);
  return { value, obsolete: current && current !== value ? current : null };
}

const SITE_FONTS = new Set(['system', 'rounded', 'grotesk', 'serif', 'slab', 'mono']);
function siteFields(body, current) {
  return {
    storeName: short(body.storeName, 100), tagline: short(body.tagline, 240),
    accentColor: safeHex(body.accentColor, '#0071e3'), currency: short(body.currency, 12).replace(/[<>&]/g, '') || '₽',
    currencyPosition: body.currencyPosition === 'before' ? 'before' : 'after', priceMultiplier: body.priceMultiplier,
    contactTelegram: short(body.contactTelegram, 100), contactPhone: short(body.contactPhone, 100), footerNote: short(body.footerNote, 500),
    legalOperator: short(body.legalOperator, 240).trim(), legalDetails: short(body.legalDetails, 240).trim(),
    legalAddress: short(body.legalAddress, 400).trim(), privacyEmail: short(body.privacyEmail, 160).trim(),
    telegramBotToken: short(body.telegramBotToken, 240), telegramChatId: short(body.telegramChatId, 100),
    notifyReviews: body.notifyReviews !== undefined,
    adminUsername: short(body.adminUsername, 100).trim() || (current && current.adminUsername) || 'admin',
    adminPassword: short(body.adminPassword, 500),
    logoText: short(body.logoText, 120), logoFont: SITE_FONTS.has(body.logoFont) ? body.logoFont : 'system',
    secondaryColor: safeHex(body.secondaryColor, safeHex(body.accentColor, '#0071e3'))
  };
}

function consentAccepted(value) {
  return value === true || ['1', 'true', 'on', 'yes'].includes(String(value || '').toLowerCase());
}

// Защита входов от перебора паролей: временные счётчики попыток хранятся в памяти.
const loginAttempts = new Map();
function clientIp(req) {
  const canTrust = trustedProxy(req);
  const cloudflare = canTrust ? String(req.headers['cf-connecting-ip'] || '').trim() : '';
  const forwarded = canTrust ? String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() : '';
  const real = canTrust ? String(req.headers['x-real-ip'] || '').trim() : '';
  return cloudflare || forwarded || real || (req.socket && req.socket.remoteAddress) || '?';
}
function metricPublicPath(site, rawPath) {
  let pathname;
  try { pathname = decodeURIComponent(String(rawPath || '').split('?')[0]); } catch (e) { return ''; }
  if (['/', '/privacy', '/personal-data-consent', '/personal-data-publication-consent'].includes(pathname)) return pathname;
  const match = pathname.match(/^\/product\/([^/]+)$/);
  return match && T.siteProductView(site, match[1]) ? '/product/' + match[1] : '';
}
function trackPage(req, res, site, pathname, options) {
  if (metrics.trackingDisabled(req)) return;
  options = options || {};
  let id = metrics.visitorId(req);
  if (!id) {
    id = metrics.newVisitorId();
    res.setHeader('Set-Cookie', metrics.cookieHeader(id, originOf(req).startsWith('https://')));
  }
  metrics.recordPageView({
    id, siteId: site.id, path: pathname, host: req.headers.host,
    requestedPath: options.requestedPath, is404: !!options.is404, provisional: !options.is404,
    context: metrics.context(req, clientIp(req), trustedProxy(req))
  });
}
function loginBlocked(req) { const r = loginAttempts.get(clientIp(req)); return !!(r && r.until > Date.now()); }
function loginFail(req) { const ip = clientIp(req); const r = loginAttempts.get(ip) || { count: 0, until: 0 }; r.count++; if (r.count >= 6) { r.until = Date.now() + 15 * 60 * 1000; r.count = 0; } r.seen = Date.now(); loginAttempts.set(ip, r); }
function loginOk(req) { loginAttempts.delete(clientIp(req)); }
const TOO_MANY = 'Слишком много попыток входа. Подождите 15 минут.';

// Антиспам публичных форм (отзывы, заказы): не больше N запросов с одного IP за окно.
const rateHits = new Map();
function rateLimited(req, bucket, limit, windowMs) {
  const key = bucket + ':' + clientIp(req);
  const now = Date.now();
  const r = rateHits.get(key);
  if (!r || now - r.start > windowMs) { rateHits.set(key, { start: now, count: 1 }); return false; }
  r.count++;
  return r.count > limit;
}
// Раз в 30 минут выметаем протухшие записи, чтобы карты не росли бесконечно.
const sweep = setInterval(() => {
  const now = Date.now();
  for (const [k, v] of rateHits) if (now - v.start > 60 * 60 * 1000) rateHits.delete(k);
  for (const [k, v] of loginAttempts) if (v.until < now && now - (v.seen || 0) > 60 * 60 * 1000) loginAttempts.delete(k);
}, 30 * 60 * 1000);
if (sweep.unref) sweep.unref();

/* =========================== ВИТРИНА (по домену) =========================== */

app.get('/', (req, res) => {
  const site = siteOf(req);
  trackPage(req, res, site, '/');
  res.send(R.homePage(T.siteSettings(site), db, { category: req.query.category, q: req.query.q, origin: originOf(req) }, site));
});

app.get('/product/:id', (req, res) => {
  const site = siteOf(req);
  const view = T.siteProductView(site, req.params.id);
  if (!view) {
    trackPage(req, res, site, '/404', { is404: true, requestedPath: req.url });
    return res.send(R.homePage(T.siteSettings(site), db, { q: '', origin: originOf(req) }, site), 404);
  }
  trackPage(req, res, site, '/product/' + view.id);
  res.send(R.productPage(T.siteSettings(site), db, view, site, { origin: originOf(req) }));
});

app.get('/privacy', (req, res) => {
  const site = siteOf(req);
  trackPage(req, res, site, '/privacy');
  res.send(R.privacyPage(T.siteSettings(site), { origin: originOf(req), categories: T.siteCategories(site) }));
});

app.get('/personal-data-consent', (req, res) => {
  const site = siteOf(req);
  trackPage(req, res, site, '/personal-data-consent');
  res.send(R.personalDataConsentPage(T.siteSettings(site), { origin: originOf(req), categories: T.siteCategories(site) }));
});

app.get('/personal-data-publication-consent', (req, res) => {
  const site = siteOf(req);
  trackPage(req, res, site, '/personal-data-publication-consent');
  res.send(R.publicationConsentPage(T.siteSettings(site), { origin: originOf(req), categories: T.siteCategories(site) }));
});

// Собственная метрика запускается автоматически при первом открытии страницы.
app.post('/api/analytics/start', (req, res) => {
  if (rateLimited(req, 'analytics-start', 120, 10 * 60 * 1000)) return res.json({ ok: false }, 429);
  const site = siteOf(req);
  const publicPath = metricPublicPath(site, req.body.path);
  let id = metrics.visitorId(req);
  if (!id) id = metrics.newVisitorId();
  const secure = originOf(req).startsWith('https://');
  const setCookies = [metrics.cookieHeader(id, secure)];
  if (metrics.trackingDisabled(req)) setCookies.push(metrics.clearOptOutCookieHeader(secure));
  res.setHeader('Set-Cookie', setCookies);
  if (!publicPath) return res.json({ ok: true });
  const context = Object.assign(metrics.context(req, clientIp(req), trustedProxy(req)), clientDetails(req.body.client));
  // Первичный HTML-запрос такого робота уже записан сервером. Его вызов
  // клиентского endpoint не должен удваивать техническую статистику.
  if (context.isBot) return res.json({ ok: true });
  const input = {
    id, siteId: site.id, path: publicPath, host: req.headers.host, referrer: req.body.referrer,
    context
  };
  metrics.recordPageView(input);
  res.json({ ok: true });
});

app.post('/api/analytics/ping', (req, res) => {
  const site = siteOf(req);
  const id = metrics.visitorId(req);
  if (id) metrics.heartbeat({ id, siteId: site.id, path: req.body.path, context: metrics.context(req, clientIp(req), trustedProxy(req)) });
  res.writeHead(204, { 'Cache-Control': 'private, no-store' });
  res.end();
});

app.post('/api/analytics/withdraw', (req, res) => {
  const id = metrics.visitorId(req);
  if (id) metrics.removeVisitor(id);
  const secure = originOf(req).startsWith('https://');
  res.setHeader('Set-Cookie', [metrics.clearCookieHeader(secure), metrics.optOutCookieHeader(secure)]);
  res.json({ ok: true });
});

// robots.txt и sitemap.xml — по домену
app.get('/robots.txt', (req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end(`User-agent: *\nAllow: /\nSitemap: ${originOf(req)}/sitemap.xml\n`);
});
// Браузеры запрашивают favicon автоматически. Это не посещение и не ошибка
// сканера, поэтому отвечаем без содержимого и не добавляем запрос в метрику.
app.get('/favicon.ico', (req, res) => {
  res.writeHead(204, { 'Cache-Control': 'public, max-age=86400' });
  res.end();
});
app.get('/sitemap.xml', (req, res) => {
  const site = siteOf(req);
  const origin = originOf(req);
  const urls = [
    '<url><loc>' + R.esc(origin) + '/</loc><changefreq>daily</changefreq></url>',
    '<url><loc>' + R.esc(origin) + '/privacy</loc></url>',
    '<url><loc>' + R.esc(origin) + '/personal-data-consent</loc></url>',
    '<url><loc>' + R.esc(origin) + '/personal-data-publication-consent</loc></url>'
  ];
  for (const v of T.siteProductViews(site)) urls.push('<url><loc>' + R.esc(origin) + '/product/' + v.id + '</loc></url>');
  res.writeHead(200, { 'Content-Type': 'application/xml; charset=utf-8' });
  res.end('<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">' + urls.join('') + '</urlset>');
});

// Отзыв посетителя -> общий каталог, на модерацию к владельцу
app.post('/api/reviews', async (req, res) => {
  if (rateLimited(req, 'review', 5, 10 * 60 * 1000)) return res.json({ ok: false, error: 'Слишком часто. Попробуйте позже.' }, 429);
  const site = siteOf(req);
  const p = db.getProduct(req.body.productId);
  if (!p || !T.isEnabled(p, site)) return res.json({ ok: false, error: 'Товар не найден' }, 400);
  if (!consentAccepted(req.body.privacyAccepted)) return res.json({ ok: false, error: 'Подтвердите согласие на обработку персональных данных' }, 400);
  if (!consentAccepted(req.body.publicationAccepted)) return res.json({ ok: false, error: 'Подтвердите согласие на публикацию отзыва' }, 400);
  if (!String(req.body.author || '').trim()) return res.json({ ok: false, error: 'Укажите имя' }, 400);
  const rating = parseInt(req.body.rating, 10);
  if (rating < 1 || rating > 5) return res.json({ ok: false, error: 'Укажите оценку от 1 до 5' }, 400);
  const clamp5 = v => { const n = parseInt(v, 10); return n >= 1 && n <= 5 ? n : null; };
  const aspects = (req.body.aspect_delivery || req.body.aspect_service || req.body.aspect_price)
    ? { delivery: clamp5(req.body.aspect_delivery), service: clamp5(req.body.aspect_service), price: clamp5(req.body.aspect_price) }
    : null;
  const review = db.createReview({
    productId: p.id, author: req.body.author, rating, text: req.body.text,
    photos: await optimizeUploads(req.filesFor('photos'), 1400), aspects, status: 'pending',
    siteId: site.id, siteName: site.storeName,
    privacyConsentAt: Date.now(), privacyConsentVersion: R.PRIVACY_VERSION,
    publicationConsentAt: Date.now(), publicationConsentVersion: R.PRIVACY_VERSION
  });
  const ss = T.siteSettings(site);
  if (ss.notifyReviews) {
    sendTelegram(ss, `📝 <b>Новый отзыв на модерации</b>\nМагазин: ${tgEsc(site.storeName)}\nТовар: ${tgEsc(p.name)}\nАвтор: ${tgEsc(review.author)}\nОценка: ${'★'.repeat(review.rating)}\n${review.text ? tgEsc(review.text) : ''}`).catch(() => {});
  }
  res.json({ ok: true, message: 'Спасибо! Ваш отзыв отправлен.' });
});

// Заказ -> цена считается по ценам сайта, заявка в Telegram этого сайта
app.post('/api/order', async (req, res) => {
  if (rateLimited(req, 'order', 10, 10 * 60 * 1000)) return res.json({ ok: false, error: 'Слишком часто. Попробуйте позже.' }, 429);
  const site = siteOf(req);
  const rawItems = Array.isArray(req.body.items) ? req.body.items.slice(0, 100) : [];
  const items = []; let total = 0;
  for (const it of rawItems) {
    if (!it || typeof it !== 'object') continue;
    const view = T.siteProductView(site, it.id);
    if (!view || !view.inStock) continue;
    const qty = Math.max(1, Math.min(99, parseInt(it.qty, 10) || 1));
    let price = D.effectivePrice(view);
    let name = view.name;
    const storageLabel = String(it.storage || '').trim();
    if (storageLabel && Array.isArray(view.storages)) {
      const s = view.storages.find(x => x.label === storageLabel);
      if (s) { price += Number(s.add) || 0; name += ' ' + s.label; }
    }
    const color = String(it.color || '').trim();
    if (color && Array.isArray(view.colors) && view.colors.some(c => c.name === color)) name += ', ' + color;
    if (!Number.isFinite(price) || price < 0) continue;
    items.push({ id: view.id, name, price, qty });
    total += price * qty;
  }
  if (!items.length) return res.json({ ok: false, error: 'В корзине нет доступных товаров' }, 400);
  if (!Number.isFinite(total) || total > 1e12) return res.json({ ok: false, error: 'Сумма заказа некорректна' }, 400);
  const contact = String(req.body.contact || '').trim();
  if (!contact) return res.json({ ok: false, error: 'Укажите контакт для связи' }, 400);

  // Определение выполняется на сервере. Для уже встречавшегося IP используется
  // 30-дневный кэш; внешняя геобаза вызывается только один раз для нового IP.
  const client = await metrics.describeRequest(req, clientIp(req), trustedProxy(req));
  const visitorId = metrics.visitorId(req) || null;
  const metricVisitor = visitorId ? metrics.findVisitor(visitorId) : null;

  const order = db.createOrder({
    siteId: site.id, siteName: site.storeName, host: db.normHost(req.headers.host),
    items, total, customerName: req.body.customerName, contact, comment: req.body.comment,
    visitorId, clientIp: client.ip, clientCity: client.city, clientRegion: client.region,
    clientCountry: client.country, clientIsp: client.isp, clientDevice: client.device,
    clientModel: client.model, clientOs: client.os, clientBrowser: client.browser,
    clientSource: (metricVisitor && metricVisitor.source) || client.source
  });
  metrics.markOrder(visitorId, order);
  const ss = T.siteSettings(site);
  const lines = items.map(i => `• ${tgEsc(i.name)} — ${i.qty} × ${R.money(i.price, ss)}`).join('\n');
  const msg = `🛒 <b>Новый заказ ${order.number}</b>\n🏬 ${tgEsc(site.storeName)}\n`
    + `👤 Имя: ${tgEsc(order.customerName) || '—'}\n📞 Контакт: ${tgEsc(order.contact)}\n`
    + `🌍 Город: ${tgEsc([order.clientCity, order.clientRegion, order.clientCountry].filter(Boolean).join(', ')) || 'не определён'}\n`
    + `💻 Устройство: ${tgEsc([order.clientModel || order.clientDevice, order.clientOs, order.clientBrowser].filter(Boolean).join(' · ')) || 'не определено'}\n`
    + `🌐 IP: ${tgEsc(order.clientIp) || 'не определён'}\n`
    + (order.comment ? `💬 ${tgEsc(order.comment)}\n` : '')
    + `\n${lines}\n\n<b>Итого: ${R.money(total, ss)}</b>`;
  const tg = await sendTelegram(ss, msg);
  res.json({ ok: true, number: order.number, total, telegram: tg.ok ? 'sent' : (tg.skipped ? 'not_configured' : 'failed') });
});

/* =========================== ПАНЕЛЬ ВЛАДЕЛЬЦА (/owner) =========================== */

function guardOwner(req, res) { if (req.session && req.session.owner) return true; res.redirect('/owner/login'); return false; }

app.get('/owner/login', (req, res) => { if (req.session && req.session.owner) return res.redirect('/owner'); res.send(O.loginPage(null)); });
app.post('/owner/login', async (req, res) => {
  if (loginBlocked(req)) return res.send(O.loginPage(TOO_MANY), 429);
  const s = settings();
  const ok = req.body.username === s.ownerUsername && await auth.verifyPasswordAsync(req.body.password, s.ownerPasswordHash);
  if (!ok) { loginFail(req); return res.send(O.loginPage('Неверный логин или пароль'), 401); }
  loginOk(req); req.session.owner = true; res.redirect('/owner');
});
app.post('/owner/logout', (req, res) => { req.session = null; res.redirect('/owner/login'); });

app.get('/owner', (req, res) => { if (!guardOwner(req, res)) return; res.send(O.dashboard(db)); });
app.get('/owner/analytics', (req, res) => {
  if (!guardOwner(req, res)) return;
  const siteId = db.getSite(req.query.site) ? req.query.site : '';
  res.send(O.analyticsPage(db, metrics.snapshot({ siteId, days: req.query.days }), siteId));
});

// Каталог (мастер)
app.get('/owner/products', (req, res) => { if (!guardOwner(req, res)) return; res.send(O.productsList(db, req.query.flash)); });
app.get('/owner/products/new', (req, res) => { if (!guardOwner(req, res)) return; res.send(O.productForm(db, null)); });
app.post('/owner/products', async (req, res) => {
  if (!guardOwner(req, res)) return;
  db.createProduct({
    name: req.body.name, category: req.body.category, price: req.body.price, oldPrice: req.body.oldPrice, badge: req.body.badge,
    inStock: req.body.inStock !== undefined, shortDesc: req.body.shortDesc, description: req.body.description, specs: req.body.specs,
    hotDeal: req.body.hotDeal !== undefined, hotDealPrice: req.body.hotDealPrice, hotDealUntil: parseDt(req.body.hotDealUntil),
    colors: parseColors(req.body.colors), storages: parseStorages(req.body.storages),
    images: await optimizeUploads(req.filesFor('images'), 1200, { square: true })
  });
  res.redirect('/owner/products?flash=' + encodeURIComponent('Товар создан'));
});
app.get('/owner/products/:id/edit', (req, res) => { if (!guardOwner(req, res)) return; const p = db.getProduct(req.params.id); if (!p) return res.redirect('/owner/products'); res.send(O.productForm(db, p)); });
app.post('/owner/products/:id', async (req, res) => {
  if (!guardOwner(req, res)) return;
  const p = db.getProduct(req.params.id); if (!p) return res.redirect('/owner/products');
  const remove = asArray(req.body.removeImages);
  let images = (p.images || []).filter(src => !remove.includes(src));
  const colors = parseColors(req.body.colors);
  const colorNames = colors.map(c => c.name);
  // Привязка фото к цветам: селекты «imgcolor:<файл>» у оставшихся фото
  const imageColors = {};
  for (const src of images) {
    const c = req.body['imgcolor:' + src];
    if (c && colorNames.includes(c)) imageColors[src] = c;
  }
  // Новые общие фото
  images = images.concat(await optimizeUploads(req.filesFor('images'), 1200, { square: true }));
  // Новые фото под конкретный цвет (поля imagesColor_<индекс цвета>)
  for (let ci = 0; ci < colors.length; ci++) {
    const added = await optimizeUploads(req.filesFor('imagesColor_' + ci), 1200, { square: true });
    for (const f of added) { images.push(f); imageColors[f] = colors[ci].name; }
  }
  db.updateProduct(p.id, {
    name: req.body.name, category: req.body.category, price: req.body.price, oldPrice: req.body.oldPrice, badge: req.body.badge,
    inStock: req.body.inStock !== undefined, shortDesc: req.body.shortDesc, description: req.body.description, specs: req.body.specs,
    hotDeal: req.body.hotDeal !== undefined, hotDealPrice: req.body.hotDealPrice, hotDealUntil: parseDt(req.body.hotDealUntil),
    colors, storages: parseStorages(req.body.storages), images, imageColors
  });
  remove.forEach(db.deleteUploadIfUnused);
  res.redirect('/owner/products?flash=' + encodeURIComponent('Сохранено'));
});
app.post('/owner/products/:id/delete', (req, res) => { if (!guardOwner(req, res)) return; db.deleteProduct(req.params.id); res.redirect('/owner/products?flash=' + encodeURIComponent('Товар удалён')); });

/* --- Фото товара без перезагрузки страницы (мгновенная загрузка и удаление) --- */
function guardApi(req, res) { if (req.session && req.session.owner) return true; res.json({ ok: false, error: 'auth' }, 401); return false; }

// Загрузить фото сразу: сохраняет в товар и возвращает готовые файлы
app.post('/owner/products/:id/images/add', async (req, res) => {
  if (!guardApi(req, res)) return;
  const p = db.getProduct(req.params.id);
  if (!p) return res.json({ ok: false, error: 'not_found' }, 404);
  const added = await optimizeUploads(req.filesFor('images'), 1200, { square: true });
  if (!added.length) return res.json({ ok: false, error: 'no_files' }, 400);
  const current = db.getProduct(req.params.id);
  if (!current) { added.forEach(db.deleteUploadIfUnused); return res.json({ ok: false, error: 'not_found' }, 404); }
  const color = String(req.body.color || '').trim();
  const valid = (current.colors || []).some(c => c.name === color);
  const images = (current.images || []).concat(added);
  const imageColors = Object.assign({}, current.imageColors || {});
  if (color && valid) added.forEach(f => { imageColors[f] = color; });
  db.updateProduct(current.id, { images, imageColors });
  res.json({ ok: true, images: added.map(f => ({ src: f, color: (color && valid) ? color : '' })) });
});

// Изменить порядок фотографий. Принимается только точная перестановка текущего списка:
// добавить чужой файл или случайно потерять существующий через этот маршрут нельзя.
app.post('/owner/products/:id/images/order', (req, res) => {
  if (!guardApi(req, res)) return;
  const p = db.getProduct(req.params.id);
  if (!p) return res.json({ ok: false, error: 'not_found' }, 404);
  const current = (p.images || []).map(String);
  const requested = Array.isArray(req.body.images) ? req.body.images.map(String) : [];
  if (!IMG.validImageOrder(current, requested)) return res.json({ ok: false, error: 'invalid_order' }, 400);
  db.updateProduct(p.id, { images: requested });
  res.json({ ok: true, images: requested });
});

// Сделать фото главным: оно идёт первым в галерее и на карточке товара
app.post('/owner/products/:id/images/main', (req, res) => {
  if (!guardApi(req, res)) return;
  const p = db.getProduct(req.params.id);
  if (!p) return res.json({ ok: false, error: 'not_found' }, 404);
  const src = String(req.body.src || '');
  if (!src || !(p.images || []).includes(src)) return res.json({ ok: false, error: 'no_image' }, 400);
  db.updateProduct(p.id, { images: [src].concat((p.images || []).filter(x => x !== src)) });
  res.json({ ok: true, main: src });
});

// Привязать фото к цвету (или снять привязку) — сразу, без сохранения формы
app.post('/owner/products/:id/images/color', (req, res) => {
  if (!guardApi(req, res)) return;
  const p = db.getProduct(req.params.id);
  if (!p) return res.json({ ok: false, error: 'not_found' }, 404);
  const src = String(req.body.src || '');
  if (!src || !(p.images || []).includes(src)) return res.json({ ok: false, error: 'no_image' }, 400);
  const color = String(req.body.color || '').trim();
  const imageColors = Object.assign({}, p.imageColors || {});
  if (color && (p.colors || []).some(c => c.name === color)) imageColors[src] = color;
  else delete imageColors[src];
  db.updateProduct(p.id, { imageColors });
  res.json({ ok: true, color: imageColors[src] || '' });
});

// Удалить фото: убирает из товара и стирает файл с диска
app.post('/owner/products/:id/images/remove', (req, res) => {
  if (!guardApi(req, res)) return;
  const p = db.getProduct(req.params.id);
  if (!p) return res.json({ ok: false, error: 'not_found' }, 404);
  const src = String(req.body.src || '');
  if (!src || !(p.images || []).includes(src)) return res.json({ ok: false, error: 'no_image' }, 400);
  const images = (p.images || []).filter(x => x !== src);
  const imageColors = Object.assign({}, p.imageColors || {});
  delete imageColors[src];
  db.updateProduct(p.id, { images, imageColors });
  // сам файл удаляем только если он больше нигде не используется
  const used = db.getProducts().some(x => (x.images || []).includes(src));
  if (!used) db.deleteUploadIfUnused(src);
  res.json({ ok: true });
});

// Отзывы (мастер, модерация)
app.get('/owner/reviews', (req, res) => { if (!guardOwner(req, res)) return; res.send(O.reviewsList(db, req.query.status, req.query.flash)); });
app.get('/owner/reviews/new', (req, res) => { if (!guardOwner(req, res)) return; res.send(O.addReviewForm(db, req.query.productId, null)); });
app.post('/owner/reviews/new', async (req, res) => {
  if (!guardOwner(req, res)) return;
  const p = db.getProduct(req.body.productId); if (!p) return res.redirect('/owner/reviews');
  let createdAt = Date.now(); if (req.body.date) { const t = Date.parse(req.body.date); if (!isNaN(t)) createdAt = t; }
  const c5 = v => { const n = parseInt(v, 10); return n >= 1 && n <= 5 ? n : null; };
  const aspects = (req.body.aspect_delivery || req.body.aspect_service || req.body.aspect_price)
    ? { delivery: c5(req.body.aspect_delivery), service: c5(req.body.aspect_service), price: c5(req.body.aspect_price) } : null;
  db.createReview({ productId: p.id, author: req.body.author, rating: req.body.rating, text: req.body.text, photos: await optimizeUploads(req.filesFor('photos'), 1400), aspects, status: 'approved', createdAt });
  res.redirect('/owner/reviews?flash=' + encodeURIComponent('Отзыв опубликован'));
});
app.post('/owner/reviews/:id/approve', (req, res) => { if (!guardOwner(req, res)) return; db.setReviewStatus(req.params.id, 'approved'); res.redirect('/owner/reviews?status=pending&flash=' + encodeURIComponent('Отзыв опубликован')); });
app.post('/owner/reviews/:id/delete', (req, res) => { if (!guardOwner(req, res)) return; db.deleteReview(req.params.id); res.redirect('/owner/reviews?flash=' + encodeURIComponent('Отзыв удалён')); });

// Домены
app.get('/owner/sites', (req, res) => { if (!guardOwner(req, res)) return; res.send(O.sitesList(db, req.query.flash)); });
app.get('/owner/sites/new', (req, res) => { if (!guardOwner(req, res)) return; res.send(O.siteForm(db, null)); });
app.post('/owner/sites', async (req, res) => {
  if (!guardOwner(req, res)) return;
  const logo = await optimizeUploads(req.filesFor('logo'), 480);
  db.createSite(Object.assign(siteFields(req.body), {
    hosts: req.body.hosts,
    logoImage: logo.length ? logo[0] : null
  }));
  res.redirect('/owner/sites?flash=' + encodeURIComponent('Домен создан'));
});
app.get('/owner/sites/:id/edit', (req, res) => { if (!guardOwner(req, res)) return; const s = db.getSite(req.params.id); if (!s) return res.redirect('/owner/sites'); res.send(O.siteForm(db, s)); });
app.post('/owner/sites/:id', async (req, res) => {
  if (!guardOwner(req, res)) return;
  const current = db.getSite(req.params.id);
  if (!current) return res.redirect('/owner/sites');
  const logo = await resolveLogo(req, current);
  db.updateSite(req.params.id, Object.assign(siteFields(req.body, current), { hosts: req.body.hosts, logoImage: logo.value }));
  if (logo.obsolete) db.deleteUploadIfUnused(logo.obsolete);
  res.redirect('/owner/sites?flash=' + encodeURIComponent('Сохранено'));
});
app.post('/owner/sites/:id/delete', (req, res) => { if (!guardOwner(req, res)) return; db.deleteSite(req.params.id); res.redirect('/owner/sites?flash=' + encodeURIComponent('Домен удалён')); });

// Заказы (все) + настройки владельца
app.get('/owner/orders', (req, res) => { if (!guardOwner(req, res)) return; res.send(O.ordersList(db, req.query.flash)); });
app.post('/owner/orders/:id/status', (req, res) => { if (!guardOwner(req, res)) return; db.setOrderStatus(req.params.id, req.body.status); res.redirect('/owner/orders'); });
app.post('/owner/orders/:id/delete', (req, res) => { if (!guardOwner(req, res)) return; db.deleteOrder(req.params.id); res.redirect('/owner/orders'); });

app.get('/owner/settings', (req, res) => { if (!guardOwner(req, res)) return; res.send(O.settingsPage(settings(), db, req.query.flash)); });
app.post('/owner/settings', (req, res) => {
  if (!guardOwner(req, res)) return;
  const patch = { ownerUsername: String(req.body.ownerUsername || '').trim().slice(0, 100) || settings().ownerUsername || 'owner' };
  if (req.body.ownerPassword && req.body.ownerPassword.trim()) patch.ownerPasswordHash = auth.hashPassword(req.body.ownerPassword.trim());
  db.saveSettings(patch);
  res.redirect('/owner/settings?flash=' + encodeURIComponent('Сохранено'));
});

/* =========================== АДМИНКА САЙТА (/admin по домену) =========================== */

function guardSite(req, res) {
  const site = siteOf(req);
  if (req.session && req.session.siteAdmin === site.id) return site;
  res.redirect('/admin/login'); return null;
}

app.get('/admin/login', (req, res) => {
  const site = siteOf(req);
  if (req.session && req.session.siteAdmin === site.id) return res.redirect('/admin');
  res.send(S.loginPage(site, null));
});
app.post('/admin/login', async (req, res) => {
  const site = siteOf(req);
  if (loginBlocked(req)) return res.send(S.loginPage(site, TOO_MANY), 429);
  const ok = req.body.username === site.adminUsername && await auth.verifyPasswordAsync(req.body.password, site.adminPasswordHash);
  if (!ok) { loginFail(req); return res.send(S.loginPage(site, 'Неверный логин или пароль'), 401); }
  loginOk(req); req.session.siteAdmin = site.id; res.redirect('/admin');
});
app.post('/admin/logout', (req, res) => { req.session = null; res.redirect('/admin/login'); });

app.get('/admin', (req, res) => { const site = guardSite(req, res); if (!site) return; res.send(S.dashboard(db, site)); });

// Товары и цены сайта
app.get('/admin/catalog', (req, res) => { const site = guardSite(req, res); if (!site) return; res.send(S.catalogPage(db, site, req.query.flash)); });
app.post('/admin/catalog', (req, res) => {
  const site = guardSite(req, res); if (!site) return;
  const overrides = {};
  for (const p of db.getProducts()) {
    const enabled = req.body['enabled_' + p.id] !== undefined;
    const priceRaw = req.body['price_' + p.id];
    const entry = {};
    if (!enabled) entry.enabled = false;
    if (priceRaw !== undefined && String(priceRaw).trim() !== '') entry.price = Number(priceRaw);
    if (Object.keys(entry).length) overrides[p.id] = entry;
  }
  db.setSiteOverrides(site.id, overrides);
  res.redirect('/admin/catalog?flash=' + encodeURIComponent('Цены и видимость сохранены'));
});

// Видимость отзывов на сайте
app.get('/admin/reviews', (req, res) => { const site = guardSite(req, res); if (!site) return; res.send(S.reviewsPage(db, site, req.query.flash)); });
app.post('/admin/reviews', (req, res) => {
  const site = guardSite(req, res); if (!site) return;
  const hidden = db.getReviews().filter(r => r.status === 'approved' && req.body['show_' + r.id] === undefined).map(r => r.id);
  db.setSiteHiddenReviews(site.id, hidden);
  res.redirect('/admin/reviews?flash=' + encodeURIComponent('Видимость отзывов сохранена'));
});

// Заказы сайта
app.get('/admin/orders', (req, res) => { const site = guardSite(req, res); if (!site) return; res.send(S.ordersList(db, site, req.query.flash)); });
app.get('/admin/analytics', (req, res) => { const site = guardSite(req, res); if (!site) return; res.send(S.analyticsPage(db, site, metrics.snapshot({ siteId: site.id, days: req.query.days }))); });
app.post('/admin/orders/:id/status', (req, res) => {
  const site = guardSite(req, res); if (!site) return;
  const o = db.getOrders().find(x => x.id === req.params.id);
  if (o && o.siteId === site.id) db.setOrderStatus(req.params.id, req.body.status);
  res.redirect('/admin/orders');
});
app.post('/admin/orders/:id/delete', (req, res) => {
  const site = guardSite(req, res); if (!site) return;
  const o = db.getOrders().find(x => x.id === req.params.id);
  if (o && o.siteId === site.id) db.deleteOrder(req.params.id);
  res.redirect('/admin/orders');
});

// Настройки сайта
app.get('/admin/settings', (req, res) => { const site = guardSite(req, res); if (!site) return; res.send(S.settingsPage(db, site, req.query.flash)); });
app.post('/admin/settings', async (req, res) => {
  const site = guardSite(req, res); if (!site) return;
  const logo = await resolveLogo(req, site);
  db.updateSite(site.id, Object.assign(siteFields(req.body, site), { logoImage: logo.value }));
  if (logo.obsolete) db.deleteUploadIfUnused(logo.obsolete);
  res.redirect('/admin/settings?flash=' + encodeURIComponent('Настройки сохранены'));
});

/* =========================== 404 =========================== */
app.notFound = (req, res) => { const site = siteOf(req); trackPage(req, res, site, '/404', { is404: true, requestedPath: req.url }); res.send(R.homePage(T.siteSettings(site), db, { q: '' }, site), 404); };

const httpServer = app.listen(PORT, () => {
  console.log(`\n  Мультимагазин запущен на порту ${PORT}: http://localhost:${PORT}`);
  console.log(`  Витрина:        http://localhost:${PORT}   (демо-домены см. ?site=…)`);
  console.log(`  Админка сайта:  http://localhost:${PORT}/admin    (по домену; демо-логин admin / admin)`);
  console.log(`  Панель владельца: http://localhost:${PORT}/owner  (демо-логин owner / owner)\n`);
});

let shuttingDown = false;
function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  metrics.flush();
  httpServer.close(() => process.exit(0));
  const force = setTimeout(() => process.exit(0), 5000);
  if (force.unref) force.unref();
}
process.once('SIGTERM', shutdown);
process.once('SIGINT', shutdown);
