'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Readable } = require('stream');

const auth = require('../lib/auth');
const deals = require('../lib/deals');
const dbCore = require('../lib/db');
const render = require('../lib/render');
const ownerViews = require('../lib/owner-views');
const images = require('../lib/images');
const { Analytics, deviceFromUa, clientDetails, isPrivateIp, sourceFromReferrer } = require('../lib/analytics');
const { App, imageExtension } = require('../lib/server-lib');
const catalog = require('../catalog');

function request(url, options) {
  options = options || {};
  const body = options.body || Buffer.alloc(0);
  const req = Readable.from(body.length ? [body] : []);
  req.url = url;
  req.method = options.method || 'GET';
  req.headers = options.headers || {};
  req.socket = { remoteAddress: '127.0.0.1', encrypted: false };
  return req;
}

function response() {
  const headers = {};
  return {
    headersSent: false,
    writableEnded: false,
    statusCode: null,
    body: Buffer.alloc(0),
    setHeader(name, value) { headers[name.toLowerCase()] = value; },
    writeHead(code, extra) {
      this.statusCode = code; this.headersSent = true;
      for (const [name, value] of Object.entries(extra || {})) headers[name.toLowerCase()] = value;
    },
    end(value) {
      if (value) this.body = Buffer.concat([this.body, Buffer.from(value)]);
      this.writableEnded = true;
    },
    get headers() { return headers; }
  };
}

test('пароли проверяются синхронно и асинхронно', async () => {
  const stored = auth.hashPassword('секрет');
  assert.equal(auth.verifyPassword('секрет', stored), true);
  assert.equal(auth.verifyPassword('неверно', stored), false);
  assert.equal(await auth.verifyPasswordAsync('секрет', stored), true);
  assert.equal(await auth.verifyPasswordAsync('неверно', stored), false);
  assert.equal(await auth.verifyPasswordAsync('секрет', 'сломанный-хеш'), false);
});

test('скидка применяется только при корректной активной цене', () => {
  assert.equal(deals.effectivePrice({ price: 100, hotDeal: true, hotDealPrice: 80 }), 80);
  assert.equal(deals.effectivePrice({ price: 100, hotDeal: true, hotDealPrice: 120 }), 100);
  assert.equal(deals.effectivePrice({ price: 100, hotDeal: true, hotDealPrice: 80, hotDealUntil: 1 }), 100);
});

test('тип изображения определяется по содержимому, а не имени', () => {
  assert.equal(imageExtension(Buffer.from('89504e470d0a1a0a00000000', 'hex')), '.png');
  assert.equal(imageExtension(Buffer.from('474946383961000000000000', 'hex')), '.gif');
  assert.equal(imageExtension(Buffer.from('524946460000000057454250', 'hex')), '.webp');
  assert.equal(imageExtension(Buffer.from('<script>alert(1)</script>')), null);
});

test('товарное фото щадяще очищается от полей и получает единый фон', () => {
  const args = images.squareTransformArgs(1200);
  assert.deepEqual(args, [
    '-fuzz', '2%', '-trim', '+repage',
    '-resize', '1056x1056>',
    '-background', '#f5f5f7', '-gravity', 'center',
    '-extent', '1200x1200', '-alpha', 'remove', '-alpha', 'off'
  ]);
  assert.equal(images.PRODUCT_BG, '#f5f5f7');
  assert.equal(images.squareTransformArgs(1200, { trim: false }).includes('-trim'), false);
});

test('карточки используют единый фон фото и естественный интервал до отзывов', () => {
  const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'styles.css'), 'utf8');
  assert.match(css, /\.card-media\{[^}]*background:#f5f5f7[^}]*isolation:isolate/);
  assert.match(css, /\.card-media img\{mix-blend-mode:darken\}/);
  assert.match(css, /\.card-name\{[^}]*min-height:0[^}]*margin:0 0 7px/);
});

test('порядок фото принимается только как точная перестановка', () => {
  assert.equal(images.validImageOrder(['a.webp', 'b.webp'], ['b.webp', 'a.webp']), true);
  assert.equal(images.validImageOrder(['a.webp', 'b.webp'], ['a.webp']), false);
  assert.equal(images.validImageOrder(['a.webp', 'b.webp'], ['a.webp', 'x.webp']), false);
  assert.equal(images.validImageOrder(['a.webp', 'b.webp'], ['a.webp', 'a.webp']), false);
});

test('хосты нормализуются вместе с IPv4, IPv6 и портами', () => {
  assert.equal(dbCore.normHost('www.Example.com:443'), 'example.com');
  assert.equal(dbCore.normHost('[::1]:3000'), '::1');
  assert.equal(dbCore.normHost('::1'), '::1');
});

test('битый URL и cookie не завершают обработчик', async () => {
  const app = new App({ secret: 'test' });
  app.get('/', (req, res) => res.json({ ok: true }));

  const badUrl = response();
  await app.handle(request('/%'), badUrl);
  assert.equal(badUrl.statusCode, 400);

  const badCookie = response();
  await app.handle(request('/', { headers: { cookie: 'sess=%' } }), badCookie);
  assert.equal(badCookie.statusCode, 200);
  assert.deepEqual(JSON.parse(badCookie.body), { ok: true });
});

test('multipart-файл остаётся в памяти до решения маршрута', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'store-upload-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const boundary = 'test-boundary';
  const png = Buffer.from('89504e470d0a1a0a00000000', 'hex');
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="photo"; filename="x.html"\r\nContent-Type: text/html\r\n\r\n`),
    png,
    Buffer.from(`\r\n--${boundary}--\r\n`)
  ]);
  const app = new App({ secret: 'test', uploadDir: dir });
  app.post('/upload', (req, res) => {
    const files = req.filesFor('photo');
    res.json({ count: files.length, ext: files[0] && path.extname(files[0].filename), buffered: !!(files[0] && files[0].content) });
  });
  const res = response();
  await app.handle(request('/upload', {
    method: 'POST', body,
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}`, 'content-length': String(body.length) }
  }), res);
  assert.deepEqual(JSON.parse(res.body), { count: 1, ext: '.png', buffered: true });
  assert.deepEqual(fs.readdirSync(dir), []);
});

test('каталог загрузок не раздаёт HTML и SVG', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'store-static-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'payload.html'), '<script>alert(1)</script>');
  fs.writeFileSync(path.join(dir, 'payload.svg'), '<svg onload="alert(1)"></svg>');
  const app = new App({ secret: 'test' });
  app.static('/uploads', dir, { extensions: ['.jpg', '.jpeg', '.png', '.gif', '.webp'] });
  for (const name of ['payload.html', 'payload.svg']) {
    const res = response();
    await app.handle(request('/uploads/' + name), res);
    assert.equal(res.statusCode, 404);
  }
});

test('рендер экранирует категорию, валюту и CSS-цвет', () => {
  const db = { getProducts: () => [], categories: () => [], ratingFor: () => ({ avg: 0, count: 0 }) };
  const payload = '</script><script>globalThis.pwned=1</script>';
  const html = render.homePage({
    storeName: 'Тест', tagline: '', accentColor: 'red;display:none',
    currency: payload, currencyPosition: 'after'
  }, db, { category: '<img src=x onerror=alert(1)>', q: '', origin: '' });
  assert.equal(html.includes('<img src=x onerror=alert(1)>'), false);
  assert.equal(html.includes('window.__CURRENCY__="</script>'), false);
  assert.equal(html.includes('\\u003c/script>'), true);
  assert.equal(html.includes('--accent:#0071e3'), true);
});

test('подвал и юридические страницы содержат обязательную информацию без ссылки на админку', () => {
  const settings = {
    storeName: 'a:Market', tagline: '', accentColor: '#ef3340', currency: '₽', currencyPosition: 'after',
    legalOperator: 'ИП <Тест>', legalDetails: 'ИНН 123', legalAddress: 'Москва', privacyEmail: 'privacy@example.test'
  };
  const html = render.layout(settings, { body: '' });
  assert.match(html, /© 2017–2026 a:Market\. Все права защищены\./);
  assert.match(html, /href="\/privacy"/);
  assert.doesNotMatch(html, /id="cookie-notice"|id="cookie-ok"|Не сейчас/);
  assert.doesNotMatch(html, /Для администратора|href="\/admin"/);

  const privacy = render.privacyPage(settings, { origin: 'https://example.test' });
  const js = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  assert.match(privacy, /Политика конфиденциальности и обработки персональных данных/);
  assert.match(privacy, /cart_v1/);
  assert.match(privacy, /analytics_disabled_v1/);
  assert.match(privacy, /am_analytics/);
  assert.match(privacy, /am_analytics_off/);
  assert.match(privacy, /IPWhois/);
  assert.match(privacy, /id="analytics-disable"/);
  assert.match(privacy, /автоматически запускается собственная first-party метрика/);
  assert.match(js, /\/api\/analytics\/start/);
  assert.doesNotMatch(js, /\/api\/analytics\/consent|initCookieNotice/);
  assert.match(privacy, /ИП &lt;Тест&gt;/);
  assert.match(privacy, /privacy@example\.test/);
  assert.doesNotMatch(privacy, /Редакция от|дата редакции/);
});

test('метрика считает визиты пакетно, различает устройства и связывает заказ', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'store-analytics-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const analytics = new Analytics({ dataDir: dir, geoEnabled: false, flushMs: 600000 });
  const id = 'a'.repeat(32);
  const phone = deviceFromUa('Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 Version/18.5 Mobile/15E148 Safari/604.1');
  assert.equal(phone.device, 'Телефон');
  assert.equal(phone.model, 'iPhone');
  assert.match(phone.os, /^iOS 18\.5/);
  assert.match(phone.browser, /^Safari/);
  assert.equal(isPrivateIp('127.0.0.1'), true);
  assert.equal(isPrivateIp('8.8.8.8'), false);
  assert.equal(sourceFromReferrer('https://shop.test/product/x', 'shop.test:443'), 'Внутренний переход');
  assert.equal(analytics.trackingDisabled({ headers: { cookie: 'am_analytics_off=1' } }), true);
  assert.deepEqual(clientDetails({ screen: '1179×2556', viewport: '390×844', language: 'ru-RU', timezone: 'Europe/Moscow', cpuCores: 8, deviceMemory: 8, connection: '4g', utmCampaign: 'summer' }), {
    screen: '1179×2556', viewport: '390×844', language: 'ru-RU', timezone: 'Europe/Moscow', platform: '',
    cpuCores: 8, deviceMemory: 8, connection: '4g', utmSource: '', utmMedium: '', utmCampaign: 'summer'
  });

  analytics.recordPageView({ id, siteId: 'shop', path: '/product/test?q=secret', host: 'shop.test', referrer: 'https://google.com/search?q=x', context: { ip: '8.8.8.8', device: phone.device, model: phone.model, os: phone.os, browser: phone.browser, screen: '1179×2556', utmSource: 'telegram', utmCampaign: 'summer' } });
  analytics.findVisitor(id).lastSeen = Date.now() - 60000;
  analytics.heartbeat({ id, siteId: 'shop', path: '/product/test', context: {} });
  analytics.markOrder(id, { id: 'order1', number: 'ORD-0001', siteId: 'shop', createdAt: Date.now() });
  const report = analytics.snapshot({ siteId: 'shop', days: 7 });
  assert.equal(report.unique, 1);
  assert.equal(report.visits, 1);
  assert.equal(report.pageViews, 1);
  assert.equal(report.orders, 1);
  assert.equal(report.conversion, 100);
  assert.equal(report.averageSeconds, 60);
  assert.equal(report.pages[0].label, '/product/test');
  assert.equal(report.sources[0].label, 'google.com');
  assert.equal(report.campaigns[0].label, 'telegram · summer');
  assert.equal(report.visitors[0].orderCount, 1);
  assert.equal(report.visitors[0].lastOrderNumber, 'ORD-0001');
  assert.equal(report.daily.length, 7);
  assert.equal(fs.existsSync(path.join(dir, 'analytics.json')), true);
});

test('раздел метрики защищён панелью и показывает понятные показатели', () => {
  const fakeDb = {
    getSites: () => [{ id: 'shop', storeName: 'Магазин', hosts: ['shop.test'] }],
    getProducts: () => [{ id: 'p1', name: 'iPhone' }],
    pendingReviewCount: () => 0
  };
  const snapshot = {
    generatedAt: Date.now(), days: 7, online: 1, unique: 12, visits: 15,
    pageViews: 42, orders: 2, conversion: 16.7,
    daily: [{ date: '2026-07-27', visits: 2, pageViews: 5, orders: 1, visitors: 2 }],
    pages: [{ label: '/product/p1', value: 5 }], sources: [{ label: 'Прямой заход', value: 5 }],
    devices: [{ label: 'Телефон', value: 5 }], browsers: [{ label: 'Safari 18', value: 5 }],
    systems: [{ label: 'iOS 18', value: 5 }], locations: [{ label: 'Москва', value: 3 }],
    campaigns: [{ label: 'telegram · summer', value: 2 }], visitors: []
  };
  const html = ownerViews.analyticsPage(fakeDb, snapshot, 'shop');
  assert.match(html, /Метрика/);
  assert.match(html, /Онлайн сейчас/);
  assert.match(html, /Популярные страницы/);
  assert.match(html, /iPhone/);
  assert.match(html, /Все домены/);
  assert.match(html, /Среднее время/);
  assert.match(html, /UTM-кампании/);
  assert.match(html, /Операционные системы/);
  assert.match(html, /Обновить/);
});

test('город по IP запрашивается один раз и затем берётся из кэша', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'store-geo-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  let calls = 0;
  const analytics = new Analytics({
    dataDir: dir, flushMs: 600000,
    fetcher: async () => {
      calls++;
      return { ok: true, json: async () => ({ success: true, city: 'Москва', region: 'Москва', country: 'Россия', connection: { isp: 'Тест' } }) };
    }
  });
  const first = await analytics.geoForIp('8.8.8.8');
  const second = await analytics.geoForIp('8.8.8.8');
  assert.equal(first.city, 'Москва');
  assert.equal(second.city, 'Москва');
  assert.equal(calls, 1);
});

test('каталог не показывает технический счётчик товаров', () => {
  const settings = { storeName: 'Тест', tagline: '', accentColor: '#0071e3', currency: '₽', currencyPosition: 'after' };
  const product = { id: 'p1', name: 'Товар', category: 'Категория', price: 100, inStock: true, images: [] };
  const db = { getProducts: () => [product], categories: () => ['Категория'], ratingFor: () => ({ avg: 0, count: 0 }) };
  const html = render.homePage(settings, db, { category: '', q: '', origin: '' });
  assert.doesNotMatch(html, />\s*1 товаров\s*</);
});

test('формы не содержат галочек, а отзыв требует последовательные отдельные согласия', () => {
  const settings = { storeName: 'Тест', tagline: '', accentColor: '#0071e3', currency: '₽', currencyPosition: 'after' };
  const db = { reviewsForProduct: () => [], ratingFor: () => ({ avg: 0, count: 0 }), categories: () => [] };
  const product = { id: 'p1', name: 'Товар', category: 'Категория', price: 100, inStock: true, images: [], colors: [], storages: [] };
  const html = render.productPage(settings, db, product, null, { origin: '' });
  const js = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const orderRoute = server.slice(server.indexOf("app.post('/api/order'"), server.indexOf('/* =========================== ПАНЕЛЬ ВЛАДЕЛЬЦА'));
  assert.doesNotMatch(html, /type="checkbox"[^>]*name="(?:privacyAccepted|publicationAccepted)"/);
  assert.match(html, /id="review-consent-overlay"/);
  assert.match(js, /\/personal-data-publication-consent/);
  assert.doesNotMatch(js, /id="co-privacy"|privacyAccepted:\s*true/);
  assert.doesNotMatch(orderRoute, /consentAccepted|privacyConsentAt/);
  assert.match(js, /fd\.append\('privacyAccepted', '1'\)/);
  assert.match(js, /fd\.append\('publicationAccepted', '1'\)/);
});

test('после заказа показывается понятное адаптивное подтверждение', () => {
  const js = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'styles.css'), 'utf8');
  assert.match(js, /class="order-success"/);
  assert.match(js, /Номер заказа/);
  assert.match(js, /Что дальше\?/);
  assert.match(js, /Продолжить покупки/);
  assert.match(css, /\.order-success-check\{/);
  assert.match(css, /\.cart-items\.cart-items-success\{/);
});

test('шапка сворачивается при прокрутке, а Telegram остаётся контурным', () => {
  const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'styles.css'), 'utf8');
  const js = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  assert.match(css, /\.site-header\.header-compact/);
  assert.match(css, /\.site-header\.header-compact \.site-nav\{max-height:0/);
  assert.match(css, /\.tg-header\{[^}]*border:1px solid[^}]*background:transparent/);
  assert.match(js, /function initCompactHeader\(\)/);
  assert.match(js, /initCompactHeader\(\);/);
  assert.match(js, /var headerFieldFocused/);
  assert.doesNotMatch(js, /header\.contains\(document\.activeElement\)/);
});

test('форма товара широкая, без текстовых подсказок и с менеджером загрузки', () => {
  const fakeDb = { categories: () => ['AirPods'], pendingReviewCount: () => 0 };
  const html = ownerViews.productForm(fakeDb, null);
  assert.match(html, /class="specs-input"/);
  assert.match(html, /class="a-form-grid product-options-grid"/);
  assert.match(html, /class="photo-upload-progress"/);
  assert.match(html, /\/static\/product-form\.js/);
  assert.doesNotMatch(html, /Кружок слева|Файлы загружаются сразу|Слева метка/);
});

test('каталог не содержит дублей и некорректных вариантов', () => {
  const ids = new Set();
  const names = new Set();
  for (const product of catalog.products) {
    assert.ok(product.id && !ids.has(product.id), `повтор id: ${product.id}`);
    assert.ok(product.name && !names.has(product.name), `повтор названия: ${product.name}`);
    assert.ok(Number.isFinite(Number(product.price)) && Number(product.price) >= 0, `цена: ${product.name}`);
    for (const color of (product.colors || [])) assert.match(color.hex, /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i);
    for (const storage of (product.storages || [])) assert.ok(storage.label && Number.isFinite(Number(storage.add)));
    ids.add(product.id); names.add(product.name);
  }
});
