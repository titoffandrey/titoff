'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { Readable } = require('stream');

const auth = require('../lib/auth');
const deals = require('../lib/deals');
const dbCore = require('../lib/db');
const render = require('../lib/render');
const ownerViews = require('../lib/owner-views');
const siteViews = require('../lib/site-views');
const analyticsView = require('../lib/analytics-view');
const variants = require('../lib/variants');
const tenancy = require('../lib/tenancy');
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
  req.socket = {
    remoteAddress: options.remoteAddress || '127.0.0.1',
    encrypted: !!options.encrypted
  };
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
    getHeader(name) { return headers[name.toLowerCase()]; },
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

test('утилита безопасно сбрасывает пароль владельца во внешнем хранилище', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'store-password-reset-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const script = path.join(__dirname, '..', 'scripts', 'reset-owner-password.js');
  execFileSync(process.execPath, [script], {
    input: 'новый-надёжный-пароль', encoding: 'utf8',
    env: Object.assign({}, process.env, { STORE_DATA_DIR: dir, OWNER_USERNAME: 'new-owner' })
  });
  const stored = JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8'));
  assert.equal(stored.ownerUsername, 'new-owner');
  assert.equal(auth.verifyPassword('новый-надёжный-пароль', stored.ownerPasswordHash), true);
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
  // Обрезка идёт двумя проходами: снимок обычно на белом, а кадр докрашивается
  // серым #f5f5f7 — за один -trim снимается только серая рамка.
  const size = Math.round(1200 * images.CONTENT_RATIO);
  assert.deepEqual(images.squareTransformArgs(1200), [
    '-fuzz', '2%', '-trim', '+repage',
    '-fuzz', '2%', '-trim', '+repage',
    '-resize', `${size}x${size}>`,
    '-background', '#f5f5f7', '-gravity', 'center',
    '-extent', '1200x1200', '-alpha', 'remove', '-alpha', 'off'
  ]);
  assert.equal(images.PRODUCT_BG, '#f5f5f7');
  assert.equal(images.squareTransformArgs(1200, { trim: false }).includes('-trim'), false);
  // Допуск подбирается под фон: тем же fuzz, каким измерили товар, его и режем.
  assert.equal(images.squareTransformArgs(1200, { fuzz: 8 }).includes('8%'), true);
  // Мелкий товар разрешено увеличить, но не более чем в MAX_UPSCALE раз.
  assert.equal(images.targetContentSize({ w: 900, h: 700 }, 1200), size);
  assert.equal(images.targetContentSize({ w: 100, h: 80 }, 1200), Math.round(100 * images.MAX_UPSCALE));
  assert.equal(images.targetContentSize(null, 1200), null);
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
  const sites = [
    { id: 'one', hosts: ['www.Example.com', 'shop.test'] },
    { id: 'two', hosts: ['other.test'] }
  ];
  assert.deepEqual(dbCore.findHostConflicts('example.com, new.test', null, sites), ['example.com']);
  assert.deepEqual(dbCore.findHostConflicts('example.com', 'one', sites), []);
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

test('маршруты экранируют точки, HEAD не отправляет тело, а cookies не перетираются', async () => {
  const app = new App({ secret: 'test' });
  app.get('/robots.txt', (req, res) => res.send('ok'));
  app.get('/large', (req, res) => res.send('x'.repeat(2000)));
  app.get('/cookies', (req, res) => {
    res.setHeader('Set-Cookie', 'first=1; Path=/');
    req.session.checked = true;
    res.json({ ok: true });
  });

  const similar = response();
  await app.handle(request('/robotsXtxt'), similar);
  assert.equal(similar.statusCode, 404);

  const head = response();
  await app.handle(request('/large', { method: 'HEAD', headers: { 'accept-encoding': 'br, gzip' } }), head);
  assert.equal(head.statusCode, 200);
  assert.equal(head.body.length, 0);
  assert.equal(head.headers['content-encoding'], undefined);

  const cookies = response();
  await app.handle(request('/cookies'), cookies);
  assert.equal(Array.isArray(cookies.headers['set-cookie']), true);
  assert.equal(cookies.headers['set-cookie'].length, 2);
  assert.match(cookies.headers['set-cookie'][1], /^sess=/);
});

test('POST из другого origin отклоняется до обработчика', async () => {
  const app = new App({ secret: 'test' });
  let calls = 0;
  app.post('/change', (req, res) => { calls++; res.json({ ok: true }); });

  const blocked = response();
  await app.handle(request('/change', {
    method: 'POST', body: Buffer.from('{}'),
    headers: { host: 'shop.test', origin: 'https://evil.test', 'content-type': 'application/json' }
  }), blocked);
  assert.equal(blocked.statusCode, 403);
  assert.equal(calls, 0);

  const allowed = response();
  await app.handle(request('/change', {
    method: 'POST', body: Buffer.from('{}'),
    headers: { host: 'shop.test', origin: 'http://shop.test', 'content-type': 'application/json' }
  }), allowed);
  assert.equal(allowed.statusCode, 200);
  assert.equal(calls, 1);
});

test('privacy-браузер может отправить формы входа со скрытым Origin', async () => {
  const app = new App({ secret: 'test', forceHttps: true });
  app.post('/owner/login', (req, res) => res.json({ ok: true }));

  const res = response();
  await app.handle(request('/owner/login', {
    method: 'POST', body: Buffer.from('{}'), remoteAddress: '10.0.0.2',
    headers: { host: 'shop.test', origin: 'null', 'content-type': 'application/json' }
  }), res);

  assert.equal(res.statusCode, 200);
});

test('явный cross-site Origin не проходит даже на форме входа', async () => {
  const app = new App({ secret: 'test', forceHttps: true });
  let calls = 0;
  app.post('/owner/login', (req, res) => { calls++; res.json({ ok: true }); });

  const res = response();
  await app.handle(request('/owner/login', {
    method: 'POST', body: Buffer.from('{}'), remoteAddress: '10.0.0.2',
    headers: {
      host: 'shop.test', origin: 'https://evil.test', 'sec-fetch-site': 'cross-site',
      'content-type': 'application/json'
    }
  }), res);

  assert.equal(res.statusCode, 403);
  assert.equal(calls, 0);
});

test('скрытый Origin внутри панели требует подписанную авторизованную сессию', async () => {
  const app = new App({ secret: 'test', forceHttps: true });
  app.get('/authorize', (req, res) => { req.session.owner = 'signed-owner-stamp'; res.json({ ok: true }); });
  app.post('/private-change', (req, res) => res.json({ ok: true }));

  const authRes = response();
  await app.handle(request('/authorize'), authRes);
  const sessionCookie = [authRes.headers['set-cookie']].flat()
    .find(value => String(value).startsWith('sess=')).split(';')[0];

  const allowed = response();
  await app.handle(request('/private-change', {
    method: 'POST', body: Buffer.from('{}'), remoteAddress: '10.0.0.2',
    headers: { host: 'shop.test', origin: 'null', cookie: sessionCookie, 'content-type': 'application/json' }
  }), allowed);
  assert.equal(allowed.statusCode, 200);

  const blocked = response();
  await app.handle(request('/private-change', {
    method: 'POST', body: Buffer.from('{}'), remoteAddress: '10.0.0.2',
    headers: {
      host: 'shop.test', origin: 'https://evil.test', cookie: sessionCookie,
      'sec-fetch-site': 'cross-site', 'content-type': 'application/json'
    }
  }), blocked);
  assert.equal(blocked.statusCode, 403);
});

test('доверенный HTTPS-прокси не вызывает ложную блокировку POST', async () => {
  const app = new App({ secret: 'test', trustProxy: true });
  app.post('/login', (req, res) => res.json({ ok: true }));

  const res = response();
  await app.handle(request('/login', {
    method: 'POST', body: Buffer.from('{}'), remoteAddress: '10.0.0.2',
    headers: {
      host: 'shop.test', origin: 'https://shop.test',
      'x-forwarded-proto': 'https', 'content-type': 'application/json'
    }
  }), res);

  assert.equal(res.statusCode, 200);
});

test('same-origin браузера работает за прокси без служебных заголовков', async () => {
  const app = new App({ secret: 'test' });
  app.post('/login', (req, res) => res.json({ ok: true }));

  const res = response();
  await app.handle(request('/login', {
    method: 'POST', body: Buffer.from('{}'), remoteAddress: '10.0.0.2',
    headers: {
      host: '127.0.0.1:3000', origin: 'https://shop.test',
      'sec-fetch-site': 'same-origin', 'content-type': 'application/json'
    }
  }), res);

  assert.equal(res.statusCode, 200);
});

test('принудительный HTTPS ставит Secure на сессионную cookie', async () => {
  const app = new App({ secret: 'test', forceHttps: true });
  app.post('/session', (req, res) => { req.session.user = 'owner'; res.json({ ok: true }); });

  const res = response();
  await app.handle(request('/session', {
    method: 'POST', body: Buffer.from('{}'), remoteAddress: '10.0.0.2',
    headers: { host: 'shop.test', origin: 'https://shop.test', 'content-type': 'application/json' }
  }), res);

  assert.equal(res.statusCode, 200);
  assert.match(String(res.headers['set-cookie']), /; Secure;/);
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
  const missing = response();
  await app.handle(request('/uploads/missing.webp'), missing);
  assert.equal(missing.statusCode, 404);
  assert.equal(missing.body.toString(), 'Не найдено');
});

test('статика корректно разделяет identity и сжатые ответы, включая 304', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'store-static-cache-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'large.css'), '.card{color:#123456}\n'.repeat(100));
  const app = new App({ secret: 'test' });
  app.static('/static', dir);

  const identity = response();
  await app.handle(request('/static/large.css', { headers: { 'accept-encoding': 'identity' } }), identity);
  assert.equal(identity.statusCode, 200);
  assert.equal(identity.headers.vary, 'Accept-Encoding');
  assert.equal(identity.headers['content-encoding'], undefined);

  const cached = response();
  await app.handle(request('/static/large.css', {
    headers: { 'accept-encoding': 'br', 'if-none-match': identity.headers.etag }
  }), cached);
  assert.equal(cached.statusCode, 304);
  assert.equal(cached.headers.vary, 'Accept-Encoding');
  assert.equal(cached.headers['content-encoding'], 'br');
});

test('Content-Type разбирается без учёта регистра, а query не наследует prototype', async () => {
  const app = new App({ secret: 'test' });
  app.post('/json', (req, res) => res.json(req.body));
  app.get('/query', (req, res) => res.json(req.query));

  const json = response();
  await app.handle(request('/json', {
    method: 'POST', body: Buffer.from('{"ok":true}'),
    headers: { 'content-type': 'Application/JSON; Charset=UTF-8' }
  }), json);
  assert.deepEqual(JSON.parse(json.body), { ok: true });

  const query = response();
  await app.handle(request('/query?constructor=a&toString=b'), query);
  assert.deepEqual(JSON.parse(query.body), { constructor: 'a', toString: 'b' });
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
  const bot = deviceFromUa('Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)');
  assert.equal(bot.isBot, true);
  assert.equal(bot.device, 'Робот');
  assert.match(bot.botName, /Googlebot/i);
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
  analytics.recordPageView({ id: 'b'.repeat(32), siteId: 'shop', path: '/', requestedPath: '/', context: { isBot: true, botName: 'Googlebot' } });
  analytics.recordPageView({ id: 'c'.repeat(32), siteId: 'shop', path: '/404', requestedPath: '/wp-admin.php', is404: true, context: {} });
  analytics.recordPageView({ id: 'd'.repeat(32), siteId: 'shop', path: '/', provisional: true, context: { device: 'Компьютер', browser: 'Chrome 150', os: 'Windows 10/11' } });
  analytics.findVisitor('d'.repeat(32)).lastSeen = Date.now() - 3 * 60 * 1000;
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
  assert.equal(report.bots.hits, 3);
  assert.equal(report.bots.notFound, 1);
  assert.equal(report.visitors.length, 1);
  assert.equal(report.pages.some(x => x.label === '/404'), false);
  assert.equal(report.daily.length, 7);
  assert.equal(fs.existsSync(path.join(dir, 'analytics.json')), true);
});

test('метрика безопасно считает специальные ключи объектов', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'store-analytics-keys-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const analytics = new Analytics({ dataDir: dir, geoEnabled: false, flushMs: 600000 });
  analytics.recordPageView({
    id: 'e'.repeat(32), siteId: 'shop', path: '/',
    context: { device: 'Компьютер', browser: 'Тест', os: 'Тест', utmCampaign: '__proto__' }
  });
  const report = analytics.snapshot({ siteId: 'shop', days: 1 });
  assert.deepEqual(report.campaigns, [{ label: '__proto__', value: 1 }]);
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
    campaigns: [{ label: 'telegram · summer', value: 2 }], visitors: [],
    bots: { hits: 70, notFound: 68, agents: [{ label: 'Неизвестный сканер / 404', value: 68 }], paths: [{ label: '/wp-admin', value: 20 }] }
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
  assert.match(html, /Боты и технические запросы/);
  assert.match(html, /не влияют на основную метрику/);
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

test('старая загрязнённая метрика мигрирует на чистые счётчики v2', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'store-analytics-migration-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'analytics.json'), JSON.stringify({
    version: 1,
    visitors: [{ id: 'e'.repeat(32), siteId: 'shop', lastSeen: Date.now(), visits: 50, pageViews: 100 }],
    daily: { old: { siteId: 'shop', date: '2026-07-27', visits: 50, pageViews: 100 } },
    geoCache: {}, geoUsage: { date: '', count: 0 }
  }));
  const analytics = new Analytics({ dataDir: dir, geoEnabled: false, flushMs: 600000 });
  const report = analytics.snapshot({ siteId: 'shop', days: 1 });
  assert.equal(analytics.data.version, 2);
  assert.equal(report.unique, 0);
  assert.equal(report.pageViews, 0);
});

test('длинные названия городов не перекрывают числа в метрике', () => {
  const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'styles.css'), 'utf8');
  assert.match(css, /\.metric-bar-label\{display:grid;grid-template-columns:minmax\(0,1fr\) max-content/);
  assert.match(css, /\.metric-location-bars \.metric-bar-label span\{white-space:normal;overflow-wrap:anywhere\}/);
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
  assert.match(html, /data-upload-cancel/);
  assert.match(html, /\/static\/product-form\.js/);
  assert.doesNotMatch(html, /Кружок слева|Файлы загружаются сразу|Слева метка/);
});

test('массовую загрузку фото можно остановить, а случайная огромная пачка блокируется', () => {
  const formJs = fs.readFileSync(path.join(__dirname, '..', 'public', 'product-form.js'), 'utf8');
  const managerJs = fs.readFileSync(path.join(__dirname, '..', 'public', 'photo-manager.js'), 'utf8');
  const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'styles.css'), 'utf8');
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.match(formJs, /var MAX_FILES = 30/);
  assert.match(formJs, /activeXhr\.abort\(\)/);
  assert.match(managerJs, /var MAX_FILES = 30/);
  assert.match(managerJs, /uploadGeneration\+\+/);
  assert.match(managerJs, /activeUpload\.abort\(\)/);
  assert.match(css, /\.photo-upload-cancel\{/);
  assert.match(server, /const PRODUCT_IMAGE_MAX = 100/);
  assert.match(server, /error: 'image_limit'/);
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

test('корзина не подменяет исчезнувший вариант базовой сборкой', () => {
  const view = {
    storages: [{ label: '256 ГБ' }, { label: '512 ГБ' }],
    colors: [{ name: 'Космический чёрный' }],
    bands: [{ name: 'Ocean Band', sizes: [{ label: 'S/M' }, { label: 'M/L' }], options: [{ name: 'Anchor Blue' }] }]
  };
  // существующие варианты проходят
  const valid = { storage: '512 ГБ', color: 'Космический чёрный', band: 'Ocean Band · Anchor Blue', bandSize: 'M/L' };
  assert.equal(variants.variantMissing(view, valid), false);
  // старая позиция без обязательного выбора не должна уйти по базовой цене
  assert.equal(variants.variantMissing(view, {}), true);
  assert.equal(variants.variantMissing(view, { storage: '', color: '', band: '' }), true);
  // а вот названный, но исчезнувший вариант продавать нельзя
  assert.equal(variants.variantMissing(view, Object.assign({}, valid, { storage: '9 ТБ' })), true);
  assert.equal(variants.variantMissing(view, Object.assign({}, valid, { color: 'Космос' })), true);
  assert.equal(variants.variantMissing(view, Object.assign({}, valid, { band: 'Ocean Band · Purple' })), true);
  assert.equal(variants.variantMissing(view, Object.assign({}, valid, { bandSize: 'XL' })), true);
  assert.equal(variants.variantMissing(view, valid), false);
  assert.equal(variants.variantMissing({ colors: [], storages: [], bands: [] }, {}), false);
  assert.equal(variants.findBand(view, 'Ocean Band · Anchor Blue').option.name, 'Anchor Blue');
  assert.equal(variants.findBand(view, 'Ocean Band · Purple'), null);
});

test('нулевая или некорректная ручная цена не превращает товар в бесплатный', () => {
  const product = { id: 'p', price: 1000 };
  assert.equal(tenancy.sitePriceOf(product, { priceMultiplier: 2, overrides: { p: { price: 0 } } }), 2000);
  assert.equal(tenancy.sitePriceOf(product, { priceMultiplier: 2, overrides: { p: { price: 'abc' } } }), 2000);
  assert.equal(tenancy.sitePriceOf(product, { priceMultiplier: 2, overrides: { p: { price: 1500 } } }), 1500);
});

test('наличие учитывает совместимость ремешка, а карточка требует выбрать вариант', () => {
  const watch = {
    id: 'watch', name: 'Часы', category: 'Watch', price: 100, inStock: true, images: [], storages: [],
    colors: [{ name: 'Натуральный', hex: '#ddd', inStock: false }, { name: 'Чёрный', hex: '#111' }],
    bands: [{ name: 'Milanese', sizes: [], options: [{ name: 'Natural', hex: '#ddd', forColor: 'Натуральный' }] }]
  };
  assert.equal(render.sellable(watch), false);
  assert.equal(render.colorAvailable(watch, watch.colors[1]), false);
  watch.bands[0].options.push({ name: 'Black', hex: '#111', forColor: 'Чёрный' });
  assert.equal(render.sellable(watch), true);
  assert.equal(render.colorAvailable(watch, watch.colors[1]), true);

  const fakeDb = {
    getProducts: () => [watch], categories: () => ['Watch'],
    ratingFor: () => ({ avg: 0, count: 0 })
  };
  const html = render.homePage({ storeName: 'Тест', tagline: '', currency: '₽' }, fakeDb, {});
  assert.match(html, /href="\/product\/watch">Выбрать вариант<\/a>/);
  assert.doesNotMatch(html, /class="btn btn-primary btn-block add-to-cart"\s+data-id="watch"/);
});

test('счётчик отзывов склоняется по-русски', () => {
  const db = {
    reviewsForProduct: () => [{ id: 'r1', author: 'Тест', rating: 5, text: '', status: 'approved', createdAt: Date.now() }],
    ratingFor: () => ({ avg: 5, count: 1 }), categories: () => []
  };
  const product = { id: 'p', name: 'Товар', category: 'Тест', price: 100, inStock: true, images: [] };
  const html = render.productPage({ storeName: 'Тест', currency: '₽' }, db, product, null, {});
  assert.match(html, /1 отзыв/);
  assert.doesNotMatch(html, /1 отзывов/);
  assert.match(html, /class="qty-input" aria-label="Количество"/);
  assert.match(html, /role="radiogroup" aria-label="Общая оценка"/);
  assert.match(html, /role="radio" aria-label="5 из 5" aria-checked="true"/);
});

test('подписи полей админки связаны с элементами форм', () => {
  const login = ownerViews.loginPage(null);
  assert.match(login, /<label for="owner-login">Логин<\/label><input id="owner-login"/);
  const page = ownerViews.settingsPage({ ownerUsername: 'owner' }, { pendingReviewCount: () => 0 });
  assert.match(page, /<label for="owner-field-1">Логин<\/label><input[^>]*id="owner-field-1"/);
  assert.match(page, /<label for="owner-field-2">Новый пароль/);
  const siteLogin = siteViews.loginPage({ storeName: 'Тест', accentColor: '#0071e3' }, null);
  assert.match(siteLogin, /<label for="admin-password">Пароль<\/label><input id="admin-password"/);
});

test('HEAD обслуживается обработчиком GET, а не уходит в 404', async () => {
  const app = new App({ secret: 'test' });
  app.get('/', (req, res) => res.send('<html></html>'));

  const head = response();
  await app.handle(request('/', { method: 'HEAD' }), head);
  assert.equal(head.statusCode, 200);

  const get = response();
  await app.handle(request('/'), get);
  assert.equal(get.statusCode, 200);
});

test('поле формы с именем из прототипа остаётся строкой', async () => {
  const app = new App({ secret: 'test' });
  let seen = null;
  app.post('/echo', (req, res) => { seen = req.body; res.json({ ok: true }); });
  await app.handle(request('/echo', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: Buffer.from('constructor=a&toString=b&name=обычное')
  }), response());
  assert.equal(seen.constructor, 'a');
  assert.equal(seen.toString, 'b');
  assert.equal(seen.name, 'обычное');
});

test('оформление, поиск и 404 закрыты от индексации, каталог — открыт', () => {
  const settings = { storeName: 'Тест', tagline: 'Слоган', currency: '₽' };
  const fakeDb = { getProducts: () => [], categories: () => [], ratingFor: () => ({ avg: 0, count: 0 }) };
  assert.match(render.checkoutPage(settings, {}), /<meta name="robots" content="noindex,follow">/);
  assert.match(render.homePage(settings, fakeDb, { q: 'iphone' }), /content="noindex,follow"/);
  assert.match(render.homePage(settings, fakeDb, { q: '', noindex: true }), /content="noindex,follow"/);
  assert.match(render.homePage(settings, fakeDb, {}), /content="index,follow">/);
  assert.match(render.homePage(settings, fakeDb, { category: 'iPhone' }), /content="noindex,follow">/);

  const categoryDb = {
    getProducts: () => [{ id: 'mac', name: 'Mac', category: 'Mac', price: 100, inStock: true }],
    categories: () => ['Mac'], ratingFor: () => ({ avg: 0, count: 0 })
  };
  const category = render.homePage(settings, categoryDb, { category: 'Mac', origin: 'https://shop.test' });
  assert.match(category, /content="index,follow"/);
  assert.match(category, /rel="canonical" href="https:\/\/shop\.test\/\?category=Mac"/);
  const invalidCategory = render.homePage(settings, categoryDb, { category: 'Unknown', origin: 'https://shop.test' });
  assert.match(invalidCategory, /content="noindex,follow"/);

  const notFound = render.notFoundPage(settings, { origin: 'https://shop.test', categories: ['Mac'] });
  assert.match(notFound, /Ошибка 404/);
  assert.match(notFound, /content="noindex,follow"/);
  assert.doesNotMatch(notFound, /rel="canonical"/);
  assert.doesNotMatch(notFound, /class="card/);
});

test('админка сайта отдаёт закрытое правило :root', () => {
  const site = { id: 's', storeName: 'Магазин', accentColor: '#123456', hosts: [] };
  for (const html of [siteViews.loginPage(site, null), siteViews.dashboard(fakeSiteDb(), site)]) {
    const style = html.match(/<style>([^<]*)<\/style>/);
    assert.ok(style, 'нет блока стилей');
    assert.equal(style[1], ':root{--accent:#123456}');
  }
});

function fakeSiteDb() {
  return {
    ordersForSite: () => [], getProducts: () => [], getReviews: () => [],
    getSites: () => [], ratingFor: () => ({ avg: 0, count: 0 }), pendingReviewCount: () => 0
  };
}

test('корзина различает варианты одного товара, а метрика знает оформление', () => {
  const js = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'styles.css'), 'utf8');
  // выдвижная корзина показывает подпись варианта: /api/cart возвращает базовое имя
  assert.match(js, /cart-item-variant/);
  assert.match(css, /\.cart-item-variant\{/);
  assert.match(js, /item\.img = fresh\.img \|\| ''/);
  assert.match(js, /addBtn\.dataset\.name = baseName;/);
  // блок вариантов запускается и когда у товара только ремешки
  assert.match(js, /getElementById\('bands'\)\)\) \{/);
  assert.equal(analyticsView.pageLabel('/checkout', {}), 'Оформление заказа');
  assert.equal(analyticsView.pageLabel('/', {}), 'Главная');
});

test('подпись корпуса на фото ремешка читается с того же элемента', () => {
  const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'styles.css'), 'utf8');
  // attr() берёт атрибут элемента, к которому прикреплён ::after
  assert.match(css, /\.img-chip-media\[data-case\]::after\{content:attr\(data-case\)/);
  const product = { id: 'p1', images: ['a.webp'], imageColors: { 'a.webp': 'Чёрный титан' }, colors: [{ name: 'Чёрный титан', hex: '#111111' }], bands: [], storages: [] };
  const html = ownerViews.productForm({ categories: () => [], pendingReviewCount: () => 0 }, product);
  assert.match(html, /<div class="img-chip-media" data-case="Чёрный титан">/);
});
