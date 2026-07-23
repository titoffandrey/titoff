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
const { App } = require('./lib/server-lib');

db.ensureSeeded();

const PORT = process.env.PORT || 3000;
const app = new App({ secret: db.getSettings().sessionSecret || 'fallback-secret', uploadDir: db.UPLOAD_DIR });

app.static('/static', path.join(__dirname, 'public'));
app.static('/uploads', db.UPLOAD_DIR);

const settings = () => db.getSettings();
const filenames = (files) => (files || []).map(f => f.filename);
const asArray = (v) => v == null ? [] : (Array.isArray(v) ? v : [v]);
const parseDt = (v) => { if (!v) return null; const t = Date.parse(v); return isNaN(t) ? null : t; };
// Варианты из формы: цвета «Название|#hex» и память «Метка|доплата» по строке.
const parseColors = (txt) => String(txt || '').split('\n').map(l => l.trim()).filter(Boolean).map(l => { const [name, hex] = l.split('|'); return { name: (name || '').trim(), hex: (hex || '#cccccc').trim() }; }).filter(c => c.name);
const parseStorages = (txt) => String(txt || '').split('\n').map(l => l.trim()).filter(Boolean).map(l => { const [label, add] = l.split('|'); return { label: (label || '').trim(), add: parseInt(add, 10) || 0 }; }).filter(s => s.label);
function tgEsc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
function siteOf(req) { return T.resolveSite(req.headers.host, req.query.site); }
// Абсолютный адрес сайта (для canonical, Open Graph, sitemap).
function originOf(req) {
  const proto = (req.headers['x-forwarded-proto'] || '').split(',')[0].trim() || 'http';
  const host = (req.headers.host || 'localhost').split(',')[0].trim();
  return proto + '://' + host;
}
// Оптимизировать загруженные фото: WebP + очистка метаданных.
const optimizeUploads = (files, maxSize) => IMG.optimizeMany(db.UPLOAD_DIR, filenames(files), maxSize);
// Логотип сайта: удалить старый (если попросили), загрузить/оптимизировать новый, иначе оставить как было.
async function resolveLogo(req, site) {
  let current = site ? site.logoImage : null;
  if (req.body.removeLogo !== undefined && current) { try { fs.unlinkSync(path.join(db.UPLOAD_DIR, current)); } catch (e) {} current = null; }
  const up = await optimizeUploads(req.filesFor('logo'), 480);
  return up.length ? up[0] : current;
}

// Защита входов от перебора паролей (в памяти, IP нигде не сохраняется).
const loginAttempts = new Map();
function clientIp(req) { return (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || (req.socket && req.socket.remoteAddress) || '?'; }
function loginBlocked(req) { const r = loginAttempts.get(clientIp(req)); return !!(r && r.until > Date.now()); }
function loginFail(req) { const ip = clientIp(req); const r = loginAttempts.get(ip) || { count: 0, until: 0 }; r.count++; if (r.count >= 6) { r.until = Date.now() + 15 * 60 * 1000; r.count = 0; } loginAttempts.set(ip, r); }
function loginOk(req) { loginAttempts.delete(clientIp(req)); }
const TOO_MANY = 'Слишком много попыток входа. Подождите 15 минут.';

/* =========================== ВИТРИНА (по домену) =========================== */

app.get('/', (req, res) => {
  const site = siteOf(req);
  res.send(R.homePage(T.siteSettings(site), db, { category: req.query.category, q: req.query.q, origin: originOf(req) }, site));
});

app.get('/product/:id', (req, res) => {
  const site = siteOf(req);
  const view = T.siteProductView(site, req.params.id);
  if (!view) return res.send(R.homePage(T.siteSettings(site), db, { q: '', origin: originOf(req) }, site), 404);
  res.send(R.productPage(T.siteSettings(site), db, view, site, { origin: originOf(req) }));
});

// robots.txt и sitemap.xml — по домену
app.get('/robots.txt', (req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end(`User-agent: *\nAllow: /\nSitemap: ${originOf(req)}/sitemap.xml\n`);
});
app.get('/sitemap.xml', (req, res) => {
  const site = siteOf(req);
  const origin = originOf(req);
  const urls = ['<url><loc>' + R.esc(origin) + '/</loc><changefreq>daily</changefreq></url>'];
  for (const v of T.siteProductViews(site)) urls.push('<url><loc>' + R.esc(origin) + '/product/' + v.id + '</loc></url>');
  res.writeHead(200, { 'Content-Type': 'application/xml; charset=utf-8' });
  res.end('<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">' + urls.join('') + '</urlset>');
});

// Отзыв посетителя -> общий каталог, на модерацию к владельцу
app.post('/api/reviews', async (req, res) => {
  const site = siteOf(req);
  const p = db.getProduct(req.body.productId);
  if (!p) return res.json({ ok: false, error: 'Товар не найден' }, 400);
  const clamp5 = v => { const n = parseInt(v, 10); return n >= 1 && n <= 5 ? n : null; };
  const aspects = (req.body.aspect_delivery || req.body.aspect_service || req.body.aspect_price)
    ? { delivery: clamp5(req.body.aspect_delivery), service: clamp5(req.body.aspect_service), price: clamp5(req.body.aspect_price) }
    : null;
  const review = db.createReview({
    productId: p.id, author: req.body.author, rating: req.body.rating, text: req.body.text,
    photos: await optimizeUploads(req.filesFor('photos'), 1400), aspects, status: 'pending'
  });
  const ss = T.siteSettings(site);
  if (ss.notifyReviews) {
    sendTelegram(ss, `📝 <b>Новый отзыв на модерации</b>\nМагазин: ${tgEsc(site.storeName)}\nТовар: ${tgEsc(p.name)}\nАвтор: ${tgEsc(review.author)}\nОценка: ${'★'.repeat(review.rating)}\n${review.text ? tgEsc(review.text) : ''}`).catch(() => {});
  }
  res.json({ ok: true, message: 'Спасибо! Ваш отзыв отправлен.' });
});

// Заказ -> цена считается по ценам сайта, заявка в Telegram этого сайта
app.post('/api/order', async (req, res) => {
  const site = siteOf(req);
  const rawItems = Array.isArray(req.body.items) ? req.body.items : [];
  const items = []; let total = 0;
  for (const it of rawItems) {
    const view = T.siteProductView(site, it.id);
    if (!view) continue;
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
    items.push({ id: view.id, name, price, qty });
    total += price * qty;
  }
  if (!items.length) return res.json({ ok: false, error: 'Корзина пуста' }, 400);
  const contact = String(req.body.contact || '').trim();
  if (!contact) return res.json({ ok: false, error: 'Укажите контакт для связи' }, 400);

  const order = db.createOrder({
    siteId: site.id, siteName: site.storeName, host: db.normHost(req.headers.host),
    items, total, customerName: req.body.customerName, contact, comment: req.body.comment
  });
  const ss = T.siteSettings(site);
  const lines = items.map(i => `• ${tgEsc(i.name)} — ${i.qty} × ${R.money(i.price, ss)}`).join('\n');
  const msg = `🛒 <b>Новый заказ ${order.number}</b>\n🏬 ${tgEsc(site.storeName)}\n`
    + `👤 Имя: ${tgEsc(order.customerName) || '—'}\n📞 Контакт: ${tgEsc(order.contact)}\n`
    + (order.comment ? `💬 ${tgEsc(order.comment)}\n` : '')
    + `\n${lines}\n\n<b>Итого: ${R.money(total, ss)}</b>`;
  const tg = await sendTelegram(ss, msg);
  res.json({ ok: true, number: order.number, telegram: tg.ok ? 'sent' : (tg.skipped ? 'not_configured' : 'failed') });
});

/* =========================== ПАНЕЛЬ ВЛАДЕЛЬЦА (/owner) =========================== */

function guardOwner(req, res) { if (req.session && req.session.owner) return true; res.redirect('/owner/login'); return false; }

app.get('/owner/login', (req, res) => { if (req.session && req.session.owner) return res.redirect('/owner'); res.send(O.loginPage(null)); });
app.post('/owner/login', (req, res) => {
  if (loginBlocked(req)) return res.send(O.loginPage(TOO_MANY), 429);
  const s = settings();
  const ok = req.body.username === s.ownerUsername && auth.verifyPassword(req.body.password, s.ownerPasswordHash);
  if (!ok) { loginFail(req); return res.send(O.loginPage('Неверный логин или пароль'), 401); }
  loginOk(req); req.session.owner = true; res.redirect('/owner');
});
app.post('/owner/logout', (req, res) => { req.session = null; res.redirect('/owner/login'); });

app.get('/owner', (req, res) => { if (!guardOwner(req, res)) return; res.send(O.dashboard(db)); });

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
    images: await optimizeUploads(req.filesFor('images'), 1600)
  });
  res.redirect('/owner/products?flash=' + encodeURIComponent('Товар создан'));
});
app.get('/owner/products/:id/edit', (req, res) => { if (!guardOwner(req, res)) return; const p = db.getProduct(req.params.id); if (!p) return res.redirect('/owner/products'); res.send(O.productForm(db, p)); });
app.post('/owner/products/:id', async (req, res) => {
  if (!guardOwner(req, res)) return;
  const p = db.getProduct(req.params.id); if (!p) return res.redirect('/owner/products');
  const remove = asArray(req.body.removeImages);
  let images = (p.images || []).filter(src => !remove.includes(src));
  remove.forEach(src => { try { fs.unlinkSync(path.join(db.UPLOAD_DIR, src)); } catch (e) {} });
  images = images.concat(await optimizeUploads(req.filesFor('images'), 1600));
  db.updateProduct(p.id, {
    name: req.body.name, category: req.body.category, price: req.body.price, oldPrice: req.body.oldPrice, badge: req.body.badge,
    inStock: req.body.inStock !== undefined, shortDesc: req.body.shortDesc, description: req.body.description, specs: req.body.specs,
    hotDeal: req.body.hotDeal !== undefined, hotDealPrice: req.body.hotDealPrice, hotDealUntil: parseDt(req.body.hotDealUntil),
    colors: parseColors(req.body.colors), storages: parseStorages(req.body.storages), images
  });
  res.redirect('/owner/products?flash=' + encodeURIComponent('Сохранено'));
});
app.post('/owner/products/:id/delete', (req, res) => { if (!guardOwner(req, res)) return; db.deleteProduct(req.params.id); res.redirect('/owner/products?flash=' + encodeURIComponent('Товар удалён')); });

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
  db.createSite({
    hosts: req.body.hosts, storeName: req.body.storeName, tagline: req.body.tagline, accentColor: req.body.accentColor,
    currency: req.body.currency, currencyPosition: req.body.currencyPosition, priceMultiplier: req.body.priceMultiplier,
    contactTelegram: req.body.contactTelegram, contactPhone: req.body.contactPhone, footerNote: req.body.footerNote,
    telegramBotToken: req.body.telegramBotToken, telegramChatId: req.body.telegramChatId, notifyReviews: req.body.notifyReviews !== undefined,
    adminUsername: req.body.adminUsername, adminPassword: req.body.adminPassword,
    logoText: req.body.logoText, logoFont: req.body.logoFont, secondaryColor: req.body.secondaryColor,
    logoImage: logo.length ? logo[0] : null
  });
  res.redirect('/owner/sites?flash=' + encodeURIComponent('Домен создан'));
});
app.get('/owner/sites/:id/edit', (req, res) => { if (!guardOwner(req, res)) return; const s = db.getSite(req.params.id); if (!s) return res.redirect('/owner/sites'); res.send(O.siteForm(db, s)); });
app.post('/owner/sites/:id', async (req, res) => {
  if (!guardOwner(req, res)) return;
  const logoImage = await resolveLogo(req, db.getSite(req.params.id));
  db.updateSite(req.params.id, {
    hosts: req.body.hosts, storeName: req.body.storeName, tagline: req.body.tagline, accentColor: req.body.accentColor,
    currency: req.body.currency, currencyPosition: req.body.currencyPosition, priceMultiplier: req.body.priceMultiplier,
    contactTelegram: req.body.contactTelegram, contactPhone: req.body.contactPhone, footerNote: req.body.footerNote,
    telegramBotToken: req.body.telegramBotToken, telegramChatId: req.body.telegramChatId, notifyReviews: req.body.notifyReviews !== undefined,
    adminUsername: req.body.adminUsername, adminPassword: req.body.adminPassword,
    logoText: req.body.logoText, logoFont: req.body.logoFont, secondaryColor: req.body.secondaryColor, logoImage
  });
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
  const patch = { ownerUsername: req.body.ownerUsername };
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
app.post('/admin/login', (req, res) => {
  const site = siteOf(req);
  if (loginBlocked(req)) return res.send(S.loginPage(site, TOO_MANY), 429);
  const ok = req.body.username === site.adminUsername && auth.verifyPassword(req.body.password, site.adminPasswordHash);
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
  const logoImage = await resolveLogo(req, site);
  db.updateSite(site.id, {
    storeName: req.body.storeName, tagline: req.body.tagline, accentColor: req.body.accentColor,
    currency: req.body.currency, currencyPosition: req.body.currencyPosition, priceMultiplier: req.body.priceMultiplier,
    contactTelegram: req.body.contactTelegram, contactPhone: req.body.contactPhone, footerNote: req.body.footerNote,
    telegramBotToken: req.body.telegramBotToken, telegramChatId: req.body.telegramChatId, notifyReviews: req.body.notifyReviews !== undefined,
    adminUsername: req.body.adminUsername, adminPassword: req.body.adminPassword,
    logoText: req.body.logoText, logoFont: req.body.logoFont, secondaryColor: req.body.secondaryColor, logoImage
  });
  res.redirect('/admin/settings?flash=' + encodeURIComponent('Настройки сохранены'));
});

/* =========================== 404 =========================== */
app.notFound = (req, res) => { const site = siteOf(req); res.send(R.homePage(T.siteSettings(site), db, { q: '' }, site), 404); };

app.listen(PORT, () => {
  console.log(`\n  Мультимагазин запущен на порту ${PORT}: http://localhost:${PORT}`);
  console.log(`  Витрина:        http://localhost:${PORT}   (демо-домены см. ?site=…)`);
  console.log(`  Админка сайта:  http://localhost:${PORT}/admin    (по домену; демо-логин admin / admin)`);
  console.log(`  Панель владельца: http://localhost:${PORT}/owner  (демо-логин owner / owner)\n`);
});
