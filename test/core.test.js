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

// Отдельный экземпляр lib/db поверх своего каталога данных: путь читается один раз
// при загрузке модуля, поэтому кэш require сбрасывается вокруг подмены переменной.
// Основной dbCore из шапки файла при этом остаётся прежним.
function freshDb(dir) {
  const key = require.resolve('../lib/db');
  const previous = process.env.STORE_DATA_DIR;
  process.env.STORE_DATA_DIR = dir;
  delete require.cache[key];
  const fresh = require('../lib/db');
  delete require.cache[key];
  if (previous === undefined) delete process.env.STORE_DATA_DIR;
  else process.env.STORE_DATA_DIR = previous;
  return fresh;
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

test('значение можно привязать к выбору в другой группе', () => {
  const V = require('../lib/variants');
  const ram128 = { label: '128 ГБ ОЗУ', add: 100, forChoice: { 'Чип': ['M5 Max'] } };
  const ssd8 = { label: '8 ТБ', add: 200, forChoice: { 'Чип': ['M5 Max'] } };
  assert.equal(V.optionFits(ram128, '', { 'Чип': 'M5 Max' }), true);
  assert.equal(V.optionFits(ram128, '', { 'Чип': 'M5 Pro' }), false, 'у M5 Pro 128 ГБ не бывает');
  // Группа ещё не выбрана — не прячем, иначе на первом рендере пропало бы всё.
  assert.equal(V.optionFits(ram128, '', {}), true);
  assert.equal(V.optionFits(ssd8, '', { 'Чип': 'M5 Pro' }), false);
  // Ограничения складываются с прежней привязкой к конфигурации.
  const both = { label: 'Нанотекстура', add: 0, forStorage: ['1 ТБ'], forChoice: { 'Чип': ['M5 Max'] } };
  assert.equal(V.optionFits(both, '1 ТБ', { 'Чип': 'M5 Max' }), true);
  assert.equal(V.optionFits(both, '512 ГБ', { 'Чип': 'M5 Max' }), false);
  // Невыбранная группа в карту не попадает — иначе пустая строка спрятала бы всё.
  assert.deepEqual(V.choiceMap([{ group: { name: 'Чип' }, label: 'M5 Max' }, { group: { name: 'Связь' }, label: '' }]),
    { 'Чип': 'M5 Max' });

  // Каталог не должен ссылаться на чип, которого нет в группе того же товара:
  // опечатка прячет вариант молча и навсегда.
  for (const p of catalog.products) {
    const byGroup = new Map((p.options || []).map(g => [g.name, new Set((g.values || []).map(v => v.label))]));
    for (const item of [...(p.options || []).flatMap(g => g.values || []), ...(p.storages || [])]) {
      for (const group of Object.keys(item.forChoice || {})) {
        assert.ok(byGroup.has(group), `${p.name}: нет группы «${group}»`);
        for (const val of item.forChoice[group]) {
          assert.ok(byGroup.get(group).has(val), `${p.name}: «${group}: ${val}» не существует`);
        }
      }
    }
    // У каждого чипа обязан остаться хотя бы один объём памяти и накопителя,
    // иначе витрина покажет пустой ряд, а купить будет нечего.
    const chips = (p.options || []).find(g => g.name === 'Чип');
    if (!chips) continue;
    for (const chip of chips.values) {
      const picked = { 'Чип': chip.label };
      for (const g of (p.options || [])) {
        if (g.name === 'Чип') continue;
        assert.ok((g.values || []).some(v => V.optionFits(v, '', picked)), `${p.name} / ${chip.label}: пустая группа «${g.name}»`);
      }
      if ((p.storages || []).length) {
        assert.ok(p.storages.some(s => V.optionFits(s, '', picked)), `${p.name} / ${chip.label}: нет ни одного накопителя`);
      }
    }
  }
});

test('привязка к чипу переживает сохранение формы, хотя в метке есть запятая', () => {
  // Метки чипов у Apple сами содержат запятую («M5 Max, 32 ядра GPU»). Пока
  // значения привязки писались одним списком через запятую, обычное «открыл
  // карточку и нажал Сохранить» разрезало метку пополам: привязка начинала
  // ссылаться на несуществующие значения, вся оперативная память и старший
  // накопитель пропадали с витрины, а Mac становился непокупаемым.
  const MAX = 'M5 Max, 32 ядра GPU';
  const PRO = 'M5 Pro, 18 ядер CPU';
  const product = {
    id: 'mac', name: 'MacBook', category: 'Mac', price: 100000, images: [], colors: [], bands: [],
    storages: [{ label: '1 ТБ', add: 0 }, { label: '8 ТБ', add: 90000, forChoice: { 'Чип': [MAX] } }],
    options: [
      { name: 'Чип', hint: '', values: [{ label: PRO, add: 0 }, { label: MAX, add: 50000 }] },
      { name: 'Оперативная память', hint: '', values: [
        { label: '24 ГБ ОЗУ', add: 0, forChoice: { 'Чип': [PRO] } },
        { label: '36 ГБ ОЗУ', add: 20000, forChoice: { 'Чип': [MAX] } },
        { label: 'Нанотекстура', add: 0, forStorage: ['1 ТБ', '8 ТБ'] }
      ] }
    ]
  };
  const db = { categories: () => [], pendingReviewCount: () => 0, getProducts: () => [product] };
  const form = ownerViews.productForm(db, product);
  const textarea = id => {
    const m = new RegExp('<textarea[^>]*id="' + id + '"[^>]*>([\\s\\S]*?)</textarea>').exec(form);
    return m[1].replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
  };

  // Разбор берём из самого server.js, а не переписываем в тесте: проверять надо
  // именно ту функцию, которая читает форму на сервере.
  const source = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const from = source.indexOf('function parseForChoice(');
  const to = source.indexOf('\n}', from);
  assert.ok(from > -1 && to > from, 'parseForChoice не найдена в server.js');
  const parseForChoice = new Function(source.slice(from, to + 2) + '; return parseForChoice;')();

  // Каждая строка варианта, вернувшаяся из формы, обязана разобраться в исходную привязку.
  const tails = (line, mark) => line.split('|').map(s => s.trim()).filter(s => s.startsWith(mark)).map(s => s.slice(1));
  const lines = (textarea('storages-raw') + '\n' + textarea('options-raw')).split('\n');

  const ssd8 = lines.find(l => l.startsWith('8 ТБ'));
  assert.deepEqual(parseForChoice(tails(ssd8, '?').join(';')), { 'Чип': [MAX] }, '8 ТБ потеряло привязку к чипу');
  const ram36 = lines.find(l => l.includes('36 ГБ ОЗУ'));
  assert.deepEqual(parseForChoice(tails(ram36, '?').join(';')), { 'Чип': [MAX] }, '36 ГБ потеряло привязку к чипу');
  const ram24 = lines.find(l => l.includes('24 ГБ ОЗУ'));
  assert.deepEqual(parseForChoice(tails(ram24, '?').join(';')), { 'Чип': [PRO] });

  // Несколько допустимых значений задаются повтором группы, а не списком.
  assert.deepEqual(parseForChoice('Чип=' + MAX + ';Чип=' + PRO), { 'Чип': [MAX, PRO] });
  assert.deepEqual(parseForChoice('Чип=' + MAX + ';Чип=' + MAX), { 'Чип': [MAX] }, 'повтор не должен дублироваться');

  // «@конфигурации» — по хвосту на метку, по той же причине.
  const nano = lines.find(l => l.includes('Нанотекстура'));
  assert.deepEqual(tails(nano, '@'), ['1 ТБ', '8 ТБ'], 'привязка к конфигурациям потерялась');

  // Редакторы в браузере проносят те же хвосты насквозь и складывают их, а не
  // заменяют друг другом: иначе форма стёрла бы часть привязок при сохранении.
  const optionEditor = fs.readFileSync(path.join(__dirname, '..', 'public', 'option-editor.js'), 'utf8');
  const colorEditor = fs.readFileSync(path.join(__dirname, '..', 'public', 'color-editor.js'), 'utf8');
  assert.match(optionEditor, /value\.forStorage\.indexOf\(only\) === -1/);
  assert.match(optionEditor, /value\.forChoice \+ ';' \+ tail/);
  assert.match(optionEditor, /forStorage\.map\(function \(only\) \{ return ' \| @' \+ only; \}\)/);
  assert.match(colorEditor, /forChoice \+ ';' \+ tail/);
});

test('добавление в корзину сразу уводит в корзину, а отказ — нет', () => {
  const js = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  const add = js.slice(js.indexOf('    add: function ('), js.indexOf('    setQty: function ('));
  // Признак успеха обязателен: без него переход случался бы и на отказе, и
  // покупатель уезжал бы в корзину, куда ничего не положили.
  assert.match(add, /if \(!next\) return false;/);
  assert.match(add, /слишком много разных товаров'\); return false;/);
  assert.match(add, /return true;\s*\},/);
  assert.match(js, /var added = Cart\.add\(/);
  assert.match(js, /if \(added\) goToCheckout\(\);/);
  // Всплывающей подсказки на успехе больше нет — она гасла вместе со страницей.
  assert.doesNotMatch(add, /toast\(name/);
});

test('зачёркнутая цена пересчитывается вместе с вариантом', () => {
  const settings = { storeName: 'Тест', tagline: '', accentColor: '#0071e3', currency: '₽', currencyPosition: 'after' };
  const db = { reviewsForProduct: () => [], ratingFor: () => ({ avg: 0, count: 0 }), categories: () => [] };
  const product = {
    id: 'p1', name: 'Товар', category: 'Категория', price: 50000, oldPrice: 60000,
    inStock: true, images: [], colors: [], storages: [{ label: '128 ГБ', add: 0 }, { label: '1 ТБ', add: 40000 }]
  };
  const html = render.productPage(settings, db, product, null, { origin: '' });
  const js = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  // Скрипт правит старую цену по id и берёт базу сравнения с кнопки: разъедется
  // разметка с app.js — рядом с ценой сборки снова повиснет цена базовой.
  assert.match(html, /id="product-old-price"/);
  assert.match(html, /id="product-save"/);
  assert.match(html, /data-base-compare="60000"/);
  assert.match(js, /getElementById\('product-old-price'\)/);
  assert.match(js, /getElementById\('product-save'\)/);
  assert.match(js, /baseCompare \+ \(total - basePrice\)/);
  // Зачёркивать нечего — атрибут нулевой, и скрипт ничего не трогает.
  const plain = render.productPage(settings, db, Object.assign({}, product, { oldPrice: 0 }), null, { origin: '' });
  assert.doesNotMatch(plain, /id="product-old-price"/);
  assert.match(plain, /data-base-compare="0"/);
});

test('старую цену видно, а стрелки галереи не лежат на товаре', () => {
  const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'styles.css'), 'utf8');
  // Все объявления селектора подряд: правила намеренно переопределяются ниже
  // по файлу, поэтому проверять надо их сумму, а не первое совпадение.
  const rule = name => [...css.matchAll(new RegExp(name + '\\s*\\{([^}]*)\\}', 'g'))].map(m => m[1]).join(';');

  // Старая цена на странице товара была 15px под сплошной чертой — сумма не
  // читалась. Кегль поднят, а линия тоньше и светлее самих цифр.
  const oldPrice = rule('\\.product-price \\.old-price');
  const size = /font-size:(\d+)px/.exec(oldPrice);
  assert.ok(size && Number(size[1]) >= 19, 'старая цена на странице товара снова мелкая');
  assert.match(css, /\.old-price\{[^}]*text-decoration-thickness:1px/, 'линия зачёркивания снова толстая');
  assert.match(oldPrice, /text-decoration-color:rgba/, 'линия должна быть светлее цифр');

  // Процент выгоды — залитая плашка с белым текстом (контраст 5.4:1), а не
  // светло-зелёный текст на светло-зелёном фоне.
  const save = rule('\\.save');
  assert.match(save, /background:#0b7a37/);
  assert.match(save, /color:#fff/);
  assert.doesNotMatch(css, /\.save\{[^}]*color:#18794e/, 'вернулся бледный вариант плашки');

  // Стрелки прижаты к краю кадра: товар вписан в 92 % квадрата, и на прежних
  // 12–16px кнопка ложилась прямо на снимок.
  assert.match(css, /\.g-prev\{left:6px\}/);
  assert.match(css, /\.g-next\{right:6px\}/);
  // На широком экране кнопка садится на границу кадра — половина снаружи,
  // внутрь заходит ровно на пустую кромку (42/2 = 21px против 4 % кадра).
  assert.match(css, /@media\(min-width:1200px\)\{\s*\.g-prev\{left:-21px\}\.g-next\{right:-21px\}/);
  const arrow = rule('\\.g-arrow');
  assert.match(arrow, /width:42px/, 'вынос рассчитан на кнопку 42px — размер и отступ связаны');
  assert.match(css, /\.g-arrow:focus-visible\{outline/, 'кнопка должна быть видима с клавиатуры');
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

test('в подвале есть знаки оплаты, а на телефоне подвал в одну колонку', () => {
  const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'styles.css'), 'utf8');
  const fakeDb = { getProducts: () => [], categories: () => [], ratingFor: () => ({ avg: 0, count: 0 }) };
  const html = render.homePage({ storeName: 'Тест', tagline: '', currency: '₽' }, fakeDb, {});
  assert.equal((html.match(/class="pay /g) || []).length, 4);
  assert.match(html, /class="pay pay-mc"[^>]*>[\s\S]*?<span class="sr-only">Mastercard<\/span>/);
  // Знаки — разметка, а не файлы: ни одной картинки грузить не нужно
  assert.doesNotMatch(html, /footer[\s\S]*?<img[^>]+pay/i);
  // Мобильная сетка подвала обязана сбрасывать вторую колонку: иначе копирайт,
  // выровненный по центру, уезжает за левый край экрана.
  const mobile = css.slice(css.indexOf('@media(max-width:800px)'));
  assert.match(mobile, /\.footer-bottom\{[^}]*grid-template-columns:minmax\(0,1fr\)/);
});

test('на телефоне слоган стоит в одну строку, а его длину считает сервер', () => {
  const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'styles.css'), 'utf8');
  const fakeDb = { getProducts: () => [], categories: () => [], ratingFor: () => ({ avg: 0, count: 0 }) };
  const tagline = 'Оригинальная техника Apple с гарантией';
  const html = render.homePage({ storeName: 'Тест', tagline, currency: '₽' }, fakeDb, {});

  // Разметка и CSS держатся вместе: без --fit в атрибуте var() подставит
  // запасное число, и заголовок поедет по ширине чужого слогана.
  assert.match(html, /<h1 style="--fit:[\d.]+">/);
  assert.match(html, /class="foot-note" style="--fit:[\d.]+"/);
  const mobile = css.slice(css.indexOf('@media(max-width:800px)'));
  assert.match(mobile, /\.store-hero h1\{white-space:nowrap;font-size:min\(28px,calc\(\(100vw - 32px\)\/var\(--fit,\d+\)\)\)/);
  assert.match(mobile, /\.foot-note\{[^}]*white-space:nowrap;font-size:min\(14px,calc\(\(100vw - 32px\)\/var\(--fit,\d+\)\)\)/);

  // Оценка обязана быть не меньше ширины, замеренной в браузере (em при кегле
  // 14px — на узком экране строка набирается примерно им). Заниженная оценка
  // выносит строку за экран, и увидеть это можно только глазами.
  const bound = render.bindShortWords(tagline);
  assert.ok(Number(render.heroFit({}, bound)) >= 19.586 + 0.86, 'заголовок: оценка меньше замера');
  assert.ok(Number(render.footFit(tagline)) >= 19.979, 'подвал: оценка меньше замера');
  // Длинный слоган обязан давать большую оценку, иначе кегль не уменьшится
  assert.ok(Number(render.footFit(tagline + ' и быстрой доставкой')) > Number(render.footFit(tagline)));
});

test('правовые ссылки в подвале тоже помещаются в строку', () => {
  const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'styles.css'), 'utf8');
  const fakeDb = { getProducts: () => [], categories: () => [], ratingFor: () => ({ avg: 0, count: 0 }) };
  const html = render.homePage({ storeName: 'Тест', tagline: '', currency: '₽' }, fakeDb, {});
  const mobile = css.slice(css.indexOf('@media(max-width:800px)'));
  assert.match(mobile, /\.footer-links\{[^}]*flex-wrap:nowrap[^}]*font-size:min\(12px,calc\(\(100vw - 46px\)\/32\.9\)\)/);
  assert.match(mobile, /\.footer-links a\{white-space:nowrap\}/);
  // Длина строки вписана в CSS числом, поэтому подписи менять нельзя, не
  // пересчитав константу 32.9 (это 31.3em двух ссылок плюс запас).
  assert.match(html, />Политика конфиденциальности</);
  assert.match(html, />Согласие на обработку данных</);
});

test('бегущая строка преимуществ едет ровно на одну свою копию', () => {
  const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'styles.css'), 'utf8');
  const js = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  const fakeDb = { getProducts: () => [], categories: () => [], ratingFor: () => ({ avg: 0, count: 0 }) };
  const html = render.homePage({ storeName: 'Тест', tagline: 'Оригинальная техника', currency: '₽' }, fakeDb, {});

  // Сдвиг в CSS обязан совпадать с числом копий: при -50 % на четырёх копиях
  // (или наоборот) в конце цикла у края экрана появляется пустота.
  const copies = (html.match(/class="ticker-row"/g) || []).length;
  const shift = css.match(/@keyframes ticker-run\{[\s\S]*?to\{transform:translate3d\(-(\d+)%/);
  assert.ok(shift, 'нет @keyframes ticker-run');
  assert.equal(copies, 100 / Number(shift[1]));
  assert.ok(copies >= 3, 'копий меньше трёх — ленты не хватит на широкий экран');

  // Глифы лежат в спрайте, копии ссылаются на него через <use>
  assert.match(html, /<symbol id="bi-price"/);
  assert.equal((html.match(/<symbol id="bi-price"/g) || []).length, 1);
  assert.match(html, /<use href="#bi-refund"\/>/);
  // Дубли строки не читаются скринридером, у первой есть подпись
  assert.equal((html.match(/class="ticker-row" aria-hidden="true"/g) || []).length, copies - 1);

  // Анимация только по transform, с паузой за экраном и уважением к настройке системы
  assert.match(css, /\.hero-ticker\.is-idle \.ticker-track\{animation-play-state:paused\}/);
  assert.match(css, /@media\(prefers-reduced-motion:reduce\)\{\.ticker-track\{animation:none\}\}/);
  assert.match(js, /function initHeroTicker\(\)/);
  assert.match(js, /initHeroTicker\(\);/);
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
    // Доп. характеристики: у группы должны быть значения, а ограничение
    // «только для конфигураций» — ссылаться на существующие. Опечатка в метке
    // прячет значение навсегда и молча, поэтому проверяем её здесь.
    const labels = new Set((product.storages || []).map(s => s.label));
    for (const group of (product.options || [])) {
      assert.ok(group.name, `группа без названия: ${product.name}`);
      assert.ok((group.values || []).length, `группа без значений: ${product.name} / ${group.name}`);
      for (const value of group.values) {
        assert.ok(value.label, `значение без подписи: ${product.name} / ${group.name}`);
        assert.ok(Number.isFinite(Number(value.add)) && Number(value.add) >= 0, `доплата: ${product.name} / ${value.label}`);
        for (const only of (value.forStorage || [])) {
          assert.ok(labels.has(only), `нет конфигурации «${only}»: ${product.name} / ${value.label}`);
        }
      }
      // хотя бы одно значение доступно с базовой конфигурацией, иначе группа пуста на старте
      const first = (product.storages || [])[0];
      assert.ok(group.values.some(v => !(v.forStorage || []).length || v.forStorage.includes(first && first.label)),
        `нечего выбрать на старте: ${product.name} / ${group.name}`);
    }
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

test('доп. характеристики обязательны к выбору и меняют цену', () => {
  const view = {
    storages: [{ label: '256 ГБ' }, { label: '2 ТБ' }],
    colors: [], bands: [],
    options: [
      { name: 'Покрытие дисплея', values: [
        { label: 'Стандартное стекло', add: 0 },
        { label: 'Нанотекстурное стекло', add: 15000, forStorage: ['2 ТБ'] }
      ] },
      { name: 'Связь', values: [{ label: 'Wi-Fi', add: 0 }, { label: 'Wi-Fi + Cellular', add: 20000 }] }
    ]
  };
  const item = (glass, link, storage) => ({
    storage: storage || '2 ТБ',
    options: [{ name: 'Покрытие дисплея', value: glass }, { name: 'Связь', value: link }]
  });
  const full = item('Нанотекстурное стекло', 'Wi-Fi + Cellular');
  assert.equal(variants.variantMissing(view, full), false);
  assert.equal(variants.optionsAdd(variants.findOptions(view, full)), 35000);
  assert.equal(variants.optionsAdd(variants.findOptions(view, item('Стандартное стекло', 'Wi-Fi'))), 0);
  // старая позиция без выбора не должна уйти по базовой цене
  assert.equal(variants.variantMissing(view, { storage: '2 ТБ' }), true);
  assert.equal(variants.variantMissing(view, { storage: '2 ТБ', options: [] }), true);
  // выбрана лишь часть групп — тоже не заказ
  assert.equal(variants.variantMissing(view, { storage: '2 ТБ', options: [{ name: 'Связь', value: 'Wi-Fi' }] }), true);
  // придуманное значение и придуманная группа
  assert.equal(variants.variantMissing(view, item('Алмазное стекло', 'Wi-Fi')), true);
  assert.equal(variants.variantMissing(view, {
    storage: '2 ТБ',
    options: full.options.concat([{ name: 'Гравировка', value: 'Да' }])
  }), true);
  // совместимость с конфигурацией — отдельная проверка, как у ремешка «в цвет корпуса»
  const glass = view.options[0].values[1];
  assert.equal(variants.optionFits(glass, '2 ТБ'), true);
  assert.equal(variants.optionFits(glass, '256 ГБ'), false);
  assert.equal(variants.optionFits(view.options[0].values[0], '256 ГБ'), true);
  // товар без доп. характеристик работает как раньше
  assert.equal(variants.variantMissing({ colors: [], storages: [], bands: [] }, {}), false);
});

test('доплата за доп. характеристику масштабируется множителем сайта', () => {
  const product = { id: 'p', name: 'Товар', price: 1000, storages: [], colors: [],
    options: [{ name: 'Связь', hint: 'подсказка', values: [
      { label: 'Wi-Fi', add: 0 }, { label: 'Wi-Fi + Cellular', add: 200 }] }] };
  const view = tenancy.viewFor(product, { priceMultiplier: 1.5, overrides: {} }, { avg: 0, count: 0 });
  assert.equal(view.price, 1500);
  assert.equal(view.options[0].values[1].add, 300);
  assert.equal(view.options[0].hint, 'подсказка');
});

test('страница товара показывает доп. характеристики и прячет несовместимые значения', () => {
  const db = { reviewsForProduct: () => [], ratingFor: () => ({ avg: 0, count: 0 }), categories: () => [] };
  const product = {
    id: 'pad', name: 'iPad', category: 'iPad', price: 100000, inStock: true, images: [], colors: [],
    storages: [{ label: '256 ГБ', add: 0 }, { label: '2 ТБ', add: 80000 }],
    options: [{ name: 'Покрытие дисплея', hint: 'Выберите, какое стекло вам подходит', values: [
      { label: 'Стандартное стекло', add: 0 },
      { label: 'Нанотекстурное стекло', add: 15000, forStorage: ['2 ТБ'] }
    ] }]
  };
  const html = render.productPage({ storeName: 'Тест', currency: '₽' }, db, product, null, {});
  assert.match(html, /id="options"/);
  assert.match(html, /Выберите, какое стекло вам подходит/);
  // страница открывается на 256 ГБ, поэтому нанотекстура скрыта уже сервером
  assert.match(html, /data-label="Нанотекстурное стекло"[^>]*hidden/);
  assert.match(html, /class="option-opt active" data-label="Стандартное стекло"/);
  assert.match(html, /data-for-storage="2 ТБ"/);
  // значение по умолчанию — первое доступное и подходящее выбранной конфигурации
  assert.equal(render.defaultOption(product.options[0], '256 ГБ'), 0);
  assert.equal(render.defaultOption(product.options[0], '2 ТБ'), 0);
  // распроданное первое значение уступает второму
  const group = { name: 'Связь', values: [{ label: 'Wi-Fi', inStock: false }, { label: 'Cellular' }] };
  assert.equal(render.defaultOption(group, ''), 1);
  // товар нельзя купить, если в группе не осталось ни одного доступного значения
  assert.equal(render.sellable(product), true);
  product.options[0].values.forEach(v => { v.inStock = false; });
  assert.equal(render.sellable(product), false);
});

test('порядок товаров меняется только точной перестановкой', () => {
  const products = [
    { id: 'p1', name: 'Первый', category: 'A', price: 10, images: [] },
    { id: 'p2', name: 'Второй', category: 'A', price: 20, images: [] },
    { id: 'p3', name: 'Третий', category: 'B', price: 30, images: [] }
  ];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'product-order-'));
  fs.writeFileSync(path.join(dir, 'products.json'), JSON.stringify(products));
  const fresh = freshDb(dir);

  assert.deepEqual(fresh.reorderProducts(['p3', 'p1', 'p2']).map(p => p.id), ['p3', 'p1', 'p2']);
  assert.deepEqual(fresh.getProducts().map(p => p.id), ['p3', 'p1', 'p2'], 'порядок сохранён на диск');
  // Через этот путь нельзя ни потерять товар, ни добавить чужой: иначе один
  // запрос с урезанным списком стирал бы каталог мимо /delete.
  assert.equal(fresh.reorderProducts(['p3', 'p1']), null);
  assert.equal(fresh.reorderProducts(['p3', 'p1', 'p2', 'p9']), null);
  assert.equal(fresh.reorderProducts(['p3', 'p1', 'чужой']), null);
  assert.equal(fresh.reorderProducts(['p3', 'p1', 'p1']), null);
  assert.equal(fresh.reorderProducts([]), null);
  assert.equal(fresh.reorderProducts('всё'), null);
  assert.deepEqual(fresh.getProducts().map(p => p.id), ['p3', 'p1', 'p2'], 'отказ ничего не меняет');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('доливка из каталога сохраняет id товара, а форма владельца — нет', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'product-id-'));
  fs.writeFileSync(path.join(dir, 'products.json'), JSON.stringify([
    { id: 'iphone-16', name: 'iPhone 16', category: 'iPhone', price: 10, images: [] }
  ]));
  const fresh = freshDb(dir);

  // Демо-отзывы ищут товар по id из catalog.js: со случайным id карточка,
  // добавленная через add-novinki.js, осталась бы без единого отзыва.
  assert.equal(fresh.createProduct({ id: 'iphone-15-pro', name: 'iPhone 15 Pro', price: 1 }).id, 'iphone-15-pro');
  // Занятый id второму товару не достаётся — иначе getProduct вернул бы чужую карточку.
  assert.notEqual(fresh.createProduct({ id: 'iphone-16', name: 'Дубль', price: 1 }).id, 'iphone-16');
  // «order» и «new» заняты адресами /owner/products/*, остальное — просто мусор.
  for (const bad of ['order', 'new', 'Не Слаг', '../../etc', 'A'.repeat(80), '', null, undefined]) {
    assert.match(fresh.createProduct({ id: bad, name: 'Товар ' + bad, price: 1 }).id, /^[0-9a-f]{8,}$/);
  }
  assert.equal(new Set(fresh.getProducts().map(p => p.id)).size, fresh.getProducts().length, 'id не повторяются');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('слияние карточек переносит отзывы покупателей, а не теряет их', () => {
  const reviews = [
    { id: 'real-1', productId: 'anc', author: 'Ирина', rating: 5, status: 'approved', createdAt: 3 },
    { id: 'demo-anc-1', productId: 'anc', author: 'Демо', rating: 5, status: 'approved', createdAt: 2, demo: true },
    { id: 'real-2', productId: 'base', author: 'Сергей', rating: 4, status: 'pending', createdAt: 1 }
  ];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'move-reviews-'));
  fs.writeFileSync(path.join(dir, 'reviews.json'), JSON.stringify(reviews));
  const fresh = freshDb(dir);

  // Демо-отзывы переносить незачем: набор пересобирается целиком, а вот отзыв
  // покупателя восстановить неоткуда.
  assert.equal(fresh.moveReviews('anc', 'base', r => !r.demo), 1);
  const after = fresh.getReviews();
  assert.equal(after.find(r => r.id === 'real-1').productId, 'base');
  assert.equal(after.find(r => r.id === 'demo-anc-1').productId, 'anc', 'демо осталось на месте');
  assert.equal(after.find(r => r.id === 'real-2').status, 'pending', 'статус чужого отзыва не тронут');
  assert.equal(fresh.moveReviews('anc', 'base', r => !r.demo), 0, 'повтор ничего не меняет');
  assert.equal(fresh.moveReviews('base', 'base'), 0, 'перенос в самого себя запрещён');
  assert.equal(fresh.moveReviews('', 'base'), 0);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('главная показывает товары в порядке каталога, а список владельца им управляет', () => {
  const products = [
    { id: 'p1', name: 'Первый', category: 'A', price: 10, inStock: true, images: [] },
    { id: 'p2', name: 'Второй', category: 'A', price: 20, inStock: true, images: [] }
  ];
  const db = {
    getProducts: () => products, categories: () => ['A'],
    ratingFor: () => ({ avg: 0, count: 0 }), pendingReviewCount: () => 0
  };
  const home = render.homePage({ storeName: 'Тест', tagline: '', currency: '₽' }, db, {});
  const order = [...home.matchAll(/href="\/product\/(p\d)"/g)].map(m => m[1]);
  assert.deepEqual([...new Set(order)], ['p1', 'p2'], 'карточки идут в порядке каталога');
  products.reverse();
  const flipped = render.homePage({ storeName: 'Тест', tagline: '', currency: '₽' }, db, {});
  assert.deepEqual([...new Set([...flipped.matchAll(/href="\/product\/(p\d)"/g)].map(m => m[1]))], ['p2', 'p1']);

  // В панели порядок правится перетаскиванием строки и стрелками, а крайние
  // стрелки погашены — иначе владелец жмёт кнопку, которая ничего не делает.
  const list = ownerViews.productsList(db);
  assert.match(list, /<tbody id="product-order" data-order="\[&quot;p2&quot;,&quot;p1&quot;\]"/);
  assert.match(list, /<tr data-id="p2" draggable="true">/);
  assert.match(list, /class="a-move a-move-up" aria-label="Переместить «Второй» выше" disabled/);
  assert.match(list, /class="a-move a-move-down" aria-label="Переместить «Первый» ниже" disabled/);
  assert.match(list, /product-order\.js/);
  // Скрипт шлёт весь список целиком — сервер принимает только перестановку
  const js = fs.readFileSync(path.join(__dirname, '..', 'public', 'product-order.js'), 'utf8');
  assert.match(js, /'\/owner\/products\/order'/);
  assert.match(js, /restore\(previous\)/);

  // Побеждает первый совпавший маршрут, а «/owner/products/:id» подходит и под
  // «/owner/products/order». Если регистрацию переставить, запрос порядка уйдёт
  // в сохранение товара — поэтому очередь закреплена здесь.
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const orderRoute = server.indexOf(`app.post('/owner/products/order'`);
  const saveRoute = server.indexOf(`app.post('/owner/products/:id'`);
  assert.ok(orderRoute > -1 && saveRoute > -1, 'маршруты на месте');
  assert.ok(orderRoute < saveRoute, 'порядок товаров регистрируется раньше сохранения товара');
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
  // У товара с вариантами кнопка ведёт на страницу товара, а не кладёт в корзину сразу
  assert.match(html, /href="\/product\/watch">В корзину<\/a>/);
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

test('отзывы листаются страницами, а свой неодобренный закреплён сверху', () => {
  const per = render.REVIEWS_PER_PAGE;
  const many = Array.from({ length: per * 3 + 2 }, (_, i) => ({
    id: 'r' + i, author: 'Автор ' + i, rating: (i % 5) + 1, text: 'x'.repeat(i + 1),
    status: 'approved', createdAt: 1000 + i
  }));
  const db = { reviewsForProduct: () => many, ratingFor: () => ({ avg: 4, count: many.length }), categories: () => [] };
  const product = { id: 'p', name: 'Товар', category: 'Тест', price: 100, inStock: true, images: [] };
  const count = html => (html.match(/class="review"/g) || []).length;

  const first = render.productPage({ storeName: 'Тест', currency: '₽' }, db, product, null, {});
  assert.equal(count(first), per, 'на странице только одна порция');
  assert.match(first, /rev-page" href="[^"]*rpage=2#reviews" data-page="2"/);
  assert.match(first, /Отзывы 1–8 из 26/);
  // На первой странице стрелка «назад» не ссылка, но остаётся на месте.
  assert.match(first, /rev-page rev-arrow rev-off/);
  assert.match(first, /<span class="rev-page rev-cur" aria-current="page">1<\/span>/);
  // Без JS сортировка и страница приходят из адреса, а не из состояния браузера.
  const third = render.productPage({ storeName: 'Тест', currency: '₽' }, db, product, null, { reviewSort: 'new', reviewPage: 3 });
  assert.equal(count(third), per);
  assert.match(third, /rev-page rev-arrow" href="[^"]*rpage=2#reviews" rel="prev"/);
  assert.match(third, /rev-page rev-arrow" href="[^"]*rpage=4#reviews" rel="next"/);
  assert.match(third, /class="sort-btn active"[^>]*data-sort="new"/);
  // Номер страницы приходит из запроса, поэтому мусор и выход за край не должны падать.
  const beyond = render.productPage({ storeName: 'Тест', currency: '₽' }, db, product, null, { reviewSort: 'нет', reviewPage: '999' });
  assert.equal(count(beyond), 2);
  assert.match(beyond, /<span class="rev-page rev-cur" aria-current="page">4<\/span>/);
  assert.doesNotMatch(beyond, /rpage=5/);

  const own = { id: 'own', author: 'Я', rating: 1, text: 'мой', status: 'pending', createdAt: 5 };
  const mine = render.productPage({ storeName: 'Тест', currency: '₽' }, db, product, null, { ownReviews: [own] });
  const ownAt = mine.indexOf('reviews-own');
  assert.ok(ownAt > -1 && ownAt < mine.indexOf('id="reviews-list"'), 'свой отзыв выше общего списка');
  assert.equal(count(mine), per + 1);
});

test('списки отзывов в панелях листаются, а не выгружаются целиком', () => {
  // На боевых данных 7000 отзывов: единый список весил 4,5 МБ и держал
  // единственный поток 16 секунд — витрина не отвечала никому всё это время.
  const per = render.ADMIN_PER_PAGE;
  const many = Array.from({ length: per * 3 + 7 }, (_, i) => ({
    id: 'r' + i, productId: 'p', author: 'Автор ' + i, rating: 5, text: 'текст',
    status: 'approved', createdAt: 1000 + i, photos: []
  }));
  const db = {
    getReviews: () => many, getProducts: () => [{ id: 'p', name: 'Товар' }],
    pendingReviewCount: () => 0, getSites: () => []
  };
  const site = { id: 's', storeName: 'Магазин', hiddenReviews: [], accentColor: '#000' };
  const rows = html => (html.match(/class="review-cell"/g) || []).length;

  const ownerFirst = ownerViews.reviewsList(db, null, null, 1);
  assert.equal(rows(ownerFirst), per, 'владелец видит одну страницу');
  assert.match(ownerFirst, /href="\/owner\/reviews\?status=all&amp;page=2"/);
  const ownerLast = ownerViews.reviewsList(db, null, null, 4);
  assert.equal(rows(ownerLast), 7, 'на последней странице остаток');

  const adminFirst = siteViews.reviewsPage(db, site, null, 1);
  assert.equal(rows(adminFirst), per, 'админка сайта тоже листает');
  assert.match(adminFirst, /href="\/admin\/reviews\?page=2"/);
  // Номер страницы приходит из адреса — мусор и выход за край не должны падать.
  assert.equal(rows(siteViews.reviewsPage(db, site, null, '999')), 7);
  assert.equal(rows(siteViews.reviewsPage(db, site, null, 'абв')), per);

  // Сохранение видимости применяется к отзывам страницы, поэтому их id уходят в форму.
  const ids = (adminFirst.match(/name="pageIds" value="([^"]*)"/) || [])[1].split(',');
  assert.equal(ids.length, per);
  assert.equal(ids[0], 'r0');
});

test('сохранение видимости не трогает отзывы с других страниц', () => {
  // Форма несёт только свою страницу. Старое «скрыть всё, у чего нет галочки»
  // со страницами спрятало бы весь остальной список одним нажатием «Сохранить».
  const applyVisibility = (hiddenBefore, pageIds, body) => {
    const hidden = new Set(hiddenBefore);
    for (const id of pageIds) {
      if (body['show_' + id] === undefined) hidden.add(id); else hidden.delete(id);
    }
    return [...hidden];
  };
  // На странице r1..r3: r2 сняли с публикации, r1 и r3 оставили видимыми.
  const result = applyVisibility(['r9', 'r2'], ['r1', 'r2', 'r3'], { show_r1: 'on', show_r3: 'on' });
  assert.ok(result.includes('r9'), 'скрытый отзыв с другой страницы остался скрытым');
  assert.ok(result.includes('r2'), 'снятая галочка скрывает отзыв');
  assert.ok(!result.includes('r1') && !result.includes('r3'), 'отмеченные остаются видимыми');
});

test('индекс отзывов даёт те же оценки, что прямой пересчёт', () => {
  // Индекс кэшируется по версии файла: рейтинг обязан совпасть с честным проходом.
  const reviews = [
    { id: 'a', productId: 'p1', rating: 5, status: 'approved', createdAt: 30 },
    { id: 'b', productId: 'p1', rating: 2, status: 'approved', createdAt: 10 },
    { id: 'c', productId: 'p1', rating: 1, status: 'pending', createdAt: 20 },
    { id: 'd', productId: 'p2', rating: 4, status: 'approved', createdAt: 5 }
  ];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reviews-index-'));
  fs.writeFileSync(path.join(dir, 'reviews.json'), JSON.stringify(reviews));
  const fresh = freshDb(dir);

  const p1 = fresh.reviewsForProduct('p1', true);
  assert.deepEqual(p1.map(r => r.id), ['a', 'b'], 'только одобренные, сначала свежие');
  assert.deepEqual(fresh.reviewsForProduct('p1', false).map(r => r.id), ['a', 'c', 'b']);
  assert.deepEqual(fresh.ratingFor('p1'), { avg: 3.5, count: 2 });
  assert.deepEqual(fresh.ratingFor('p2'), { avg: 4, count: 1 });
  assert.deepEqual(fresh.ratingFor('нет-такого'), { avg: 0, count: 0 });
  // Сайт, скрывший отзыв, вычитает его из готовой суммы, а не пересчитывает всё.
  const totals = fresh.approvedTotals();
  assert.deepEqual(totals.get('p1'), { sum: 7, count: 2 });
  assert.deepEqual(fresh.averageRating(7 - 2, 1), { avg: 5, count: 1 });
  fs.rmSync(dir, { recursive: true, force: true });
});

test('листалка держит ряд коротким и не теряет края', () => {
  const pagerFor = (page, total) => render.reviewsPager(
    render.reviewsSlice(Array.from({ length: total }, (_, i) => ({ id: 'r' + i, rating: 5, text: '', createdAt: i })), 'new', page),
    '/product/p'
  );
  const numbers = html => (html.match(/>(\d+)<\/(?:a|span)>/g) || []).map(x => Number(x.replace(/\D/g, '')));

  // 300 отзывов это 38 страниц: в ряду только края, соседи и многоточия.
  assert.deepEqual(numbers(pagerFor(20, 300)), [1, 18, 19, 20, 21, 22, 38]);
  assert.equal((pagerFor(20, 300).match(/rev-gap/g) || []).length, 2);
  // У краёв многоточие только с одной стороны, а ряд не становится длиннее.
  assert.deepEqual(numbers(pagerFor(1, 300)), [1, 2, 3, 38]);
  assert.deepEqual(numbers(pagerFor(38, 300)), [1, 36, 37, 38]);
  assert.equal((pagerFor(1, 300).match(/rev-gap/g) || []).length, 1);
  // Соседние страницы идут подряд, поэтому многоточия не нужно вовсе.
  assert.deepEqual(numbers(pagerFor(3, 40)), [1, 2, 3, 4, 5]);
  assert.equal(pagerFor(3, 40).includes('rev-gap'), false);
  // Одна страница листалку не рисует.
  assert.equal(pagerFor(1, 5), '');
});

test('срез отзывов сортирует и режет одинаково для страницы и для догрузки', () => {
  const list = [
    { id: 'a', rating: 5, text: 'коротко', createdAt: 10 },
    { id: 'b', rating: 5, text: 'подробный отзыв', createdAt: 20 },
    { id: 'c', rating: 2, text: 'плохо', createdAt: 30 },
    { id: 'd', rating: 2, text: 'тоже плохо', createdAt: 5 }
  ];
  assert.deepEqual(render.reviewsSlice(list, 'new', 1).items.map(r => r.id), ['c', 'b', 'a', 'd']);
  // Внутри одной оценки — сначала свежие, иначе жалобы трёхлетней давности
  // открывают ленту вперёд сегодняшних.
  assert.deepEqual(render.reviewsSlice(list, 'low', 1).items.map(r => r.id), ['c', 'd', 'b', 'a']);
  assert.deepEqual(render.reviewsSlice(list, 'high', 1).items.map(r => r.id), ['b', 'a', 'c', 'd']);
  // По умолчанию и на любой мусор в адресе — новые.
  assert.equal(render.reviewsSlice(list, 'мусор', 0).sort, 'new');
  assert.equal(render.reviewsSlice(list, 'helpful', 1).sort, 'new');
  assert.equal(render.reviewsSlice(list, undefined, 1).sort, 'new');
  assert.equal(render.reviewsSlice([], 'new', 5).page, 1);
  assert.equal(render.reviewsSlice([], 'new', 5).from, 0);
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
  // блок вариантов запускается и когда у товара только ремешки или только доп. характеристики
  assert.match(js, /getElementById\('bands'\) \|\| document\.getElementById\('options'\)\)\) \{/);
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

test('списки заказов в панелях листаются, а не выгружаются целиком', () => {
  // Та же ловушка, что была у отзывов: заказы не удаляются сами, список растёт
  // без предела. На 3000 заявок страница весила 2,8 МБ и держала единственный
  // поток около 100 мс — всё это время витрина не отвечала никому.
  const per = render.ADMIN_PER_PAGE;
  const many = Array.from({ length: per * 3 + 7 }, (_, i) => ({
    id: 'o' + i, number: 'ORD-' + String(i).padStart(4, '0'), siteId: 's', siteName: 'Магазин',
    items: [{ id: 'p', name: 'Товар', price: 100, qty: 1 }], total: 100,
    customerName: 'Клиент ' + i, contact: '@u' + i, status: 'new', createdAt: 2000 - i
  }));
  const db = {
    getOrders: () => many, ordersForSite: () => many, getSites: () => [],
    getProducts: () => [], pendingReviewCount: () => 0
  };
  const site = { id: 's', storeName: 'Магазин', accentColor: '#000', currency: '₽', hosts: [] };
  const rows = html => (html.match(/<tr id="order-/g) || []).length;

  const ownerFirst = ownerViews.ordersList(db, null, 1);
  assert.equal(rows(ownerFirst), per, 'владелец видит одну страницу');
  assert.match(ownerFirst, /href="\/owner\/orders\?page=2"/);
  assert.equal(rows(ownerViews.ordersList(db, null, 4)), 7, 'на последней странице остаток');

  const adminFirst = siteViews.ordersList(db, site, null, 1);
  assert.equal(rows(adminFirst), per, 'админка сайта тоже листает');
  assert.match(adminFirst, /href="\/admin\/orders\?page=2"/);

  // Номер страницы приходит из адреса — мусор и выход за край не должны падать.
  assert.equal(rows(siteViews.ordersList(db, site, null, '999')), 7);
  assert.equal(rows(siteViews.ordersList(db, site, null, 'абв')), per);
  assert.equal(rows(siteViews.ordersList(db, site, null, -5)), per);

  // Порядок файла сохраняется: свежие заявки остаются на первой странице.
  assert.ok(ownerFirst.indexOf('ORD-0000') > -1, 'самый свежий заказ на первой странице');
  assert.equal(ownerFirst.indexOf('ORD-0150'), -1, 'заказы других страниц сюда не попадают');

  // Действие над строкой возвращает на ту же страницу, а не в начало списка.
  const page3 = ownerViews.ordersList(db, null, 3);
  assert.match(page3, /<input type="hidden" name="page" value="3">/);
});

test('нечисловая цена в админке сайта не проходит молча', () => {
  // Хранилище такую цену и раньше отбрасывало, но администратор видел
  // «Цены и видимость сохранены»: товар уходил на базовую цену, а прежняя
  // ручная цена пропадала. Теперь это ошибка формы с подсветкой строки.
  const products = [
    { id: 'p1', name: 'Товар один', category: 'К', price: 1000, images: [] },
    { id: 'p2', name: 'Товар два', category: 'К', price: 2000, images: [] }
  ];
  const db = { getProducts: () => products, getReviews: () => [], approvedTotals: () => new Map() };
  const site = { id: 's', storeName: 'М', accentColor: '#000', currency: '₽', currencyPosition: 'after',
    priceMultiplier: 1, overrides: { p1: { price: 900 } }, hiddenReviews: [], hosts: [] };

  // Обычный показ: сохранённая цена в поле, ошибок нет.
  const plain = siteViews.catalogPage(db, site, null);
  assert.match(plain, /name="price_p1"[^>]*value="900"/);
  assert.doesNotMatch(plain, /row-error/);

  // Форма с ошибкой: введённое не теряется, строка подсвечена, подпись объясняет.
  const draft = { 'enabled_p1': 'on', 'enabled_p2': 'on', 'price_p1': '99 990', 'price_p2': '2500' };
  const failed = siteViews.catalogPage(db, site, 'Не сохранено', { flashType: 'err', draft, badPrices: ['p1'] });
  assert.match(failed, /value="99 990"/, 'введённое значение потеряно');
  assert.match(failed, /value="2500"/, 'корректное значение соседа тоже должно вернуться');
  assert.match(failed, /<tr class="row-error">/);
  assert.match(failed, /Введите число больше нуля/);
  assert.match(failed, /class="a-flash err"/);

  // Снятая галочка «показывать» из черновика тоже должна вернуться снятой.
  const hidden = siteViews.catalogPage(db, site, 'Не сохранено', { draft: { 'price_p1': 'abc' }, badPrices: ['p1'] });
  assert.doesNotMatch(hidden, /name="enabled_p1" checked/);

  // Подсветку рисует CSS — без правил она была бы невидимой.
  const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'styles.css'), 'utf8');
  assert.match(css, /\.price-inp\.has-error/);
  assert.match(css, /tr\.row-error/);

  // Маршрут обязан отклонять такую отправку, а не сохранять её.
  const source = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const route = source.slice(source.indexOf("app.post('/admin/catalog'"), source.indexOf("app.get('/admin/reviews'"));
  assert.match(route, /badPrices\.push\(p\.id\)/);
  assert.match(route, /if \(badPrices\.length\)/);
  assert.ok(route.indexOf('if (badPrices.length)') < route.indexOf('db.setSiteOverrides'),
    'проверка обязана идти до записи');
});

test('смена коллекции ремешков сбрасывает размер, а не тащит чужой', () => {
  const js = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  const pick = js.slice(js.indexOf('var pickSize = function'), js.indexOf('var applyCaseColor'));
  // showGroup зовёт pickSize(null), когда у коллекции нет размеров. Ранний выход
  // по !btn оставлял «M/L» от прошлой коллекции: сервер такую позицию не примет,
  // и покупатель получал «нет в наличии» на товаре, который есть.
  assert.doesNotMatch(pick, /if \(!btn\) return;/, 'ранний выход снова оставляет чужой размер');
  assert.match(pick, /vstate\.bandSize = '';/);
  assert.match(pick, /vstate\.bandSizeAdd = 0;/);
  assert.match(js, /pickSize\(sizes && sizes\.querySelector\('\.storage-opt'\)\)/);
  // Размер входит в ключ позиции и в проверку варианта на сервере.
  assert.match(js, /bandSize/);
  const V = require('../lib/variants');
  const view = { storages: [], colors: [], options: [], bands: [{ name: 'Ocean Band', sizes: [], options: [{ name: 'Black' }] }] };
  assert.equal(V.variantMissing(view, { band: 'Ocean Band · Black', bandSize: 'M/L' }), true,
    'размер от чужой коллекции обязан делать позицию недоступной');
  assert.equal(V.variantMissing(view, { band: 'Ocean Band · Black', bandSize: '' }), false);
});

test('модерация отзыва возвращает на ту же страницу и вкладку', () => {
  // То же правило, что у заказов. На боевых данных очередь отзывов — сотни
  // страниц: без возврата владелец после каждого «Одобрить» улетал в начало
  // списка, а «Удалить» вдобавок сбрасывало вкладку «На модерации» на «Все».
  const per = render.ADMIN_PER_PAGE;
  const many = Array.from({ length: per * 3 }, (_, i) => ({
    id: 'r' + i, productId: 'p', author: 'Автор ' + i, rating: 5, text: 'т', status: 'pending', createdAt: 2000 - i
  }));
  const db = { getReviews: () => many, getProducts: () => [], pendingReviewCount: () => many.length };

  const page3 = ownerViews.reviewsList(db, 'pending', null, 3);
  const forms = page3.match(/<form method="post" action="\/owner\/reviews\/[^"]+\/(approve|delete)">([\s\S]*?)<\/form>/g) || [];
  assert.ok(forms.length >= 2, 'на странице есть формы одобрения и удаления');
  for (const form of forms) {
    assert.match(form, /name="page" value="3"/, 'форма не несёт номер страницы');
    assert.match(form, /name="status" value="pending"/, 'форма не несёт вкладку');
  }

  // Адрес возврата собирает сервер: вкладка «Все» и первая страница не должны
  // засорять ссылку, а мусор в скрытых полях — уводить куда-то ещё.
  const source = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const from = source.indexOf('const reviewsBackUrl =');
  const to = source.indexOf('\n};', from);
  assert.ok(from > -1 && to > from, 'reviewsBackUrl не найдена в server.js');
  const build = new Function('const REVIEW_TABS = ["all","pending","approved"];'
    + source.slice(from, to + 3) + ' return reviewsBackUrl;')();
  assert.equal(build({ status: 'pending', page: '3' }, 'Готово'), '/owner/reviews?status=pending&page=3&flash=' + encodeURIComponent('Готово'));
  assert.equal(build({ status: 'all', page: '1' }), '/owner/reviews');
  assert.equal(build({ status: 'нет-такой', page: 'абв' }), '/owner/reviews');
  assert.equal(build({ status: 'approved', page: -7 }), '/owner/reviews?status=approved');
  // Маршруты обязаны пользоваться именно им, а не фиксированным адресом.
  assert.match(source, /approve[\s\S]{0,120}reviewsBackUrl\(req\.body/);
  assert.match(source, /deleteReview\(req\.params\.id\); res\.redirect\(reviewsBackUrl\(req\.body/);
});

test('оценка товара считается только когда её спрашивают', () => {
  // /api/cart и /api/order строят до 100 представлений на запрос и рейтинг не
  // показывают вовсе: раньше на каждое впустую пробегался список отзывов товара.
  let ratingReads = 0;
  const reviews = Array.from({ length: 50 }, (_, i) => ({
    id: 'r' + i, productId: 'p', rating: 4, status: 'approved', createdAt: i
  }));
  const product = { id: 'p', name: 'Товар', price: 100, category: 'К', colors: [], storages: [], bands: [] };
  const site = { id: 's', storeName: 'М', priceMultiplier: 1, overrides: {}, hiddenReviews: ['r0'] };
  const spy = new Proxy(dbCore, {
    get(target, key) {
      if (key === 'getProducts') return () => [product];
      if (key === 'getProduct') return id => (id === 'p' ? product : null);
      if (key === 'reviewsForProduct') { ratingReads++; return () => reviews; }
      return target[key];
    }
  });
  const isolated = requireWithDb(spy);
  const view = isolated.siteProductView(site, 'p');
  assert.equal(ratingReads, 0, 'построение представления не трогает отзывы');
  assert.equal(view.price, 100);
  // но значение по-прежнему верное, когда его действительно читают
  assert.deepEqual(view._rating, { avg: 4, count: 49 });
  assert.ok(ratingReads > 0, 'при обращении оценка всё-таки считается');
  assert.deepEqual(view._rating, { avg: 4, count: 49 }, 'повторное чтение отдаёт то же самое');
});

// tenancy держит ссылку на lib/db, поэтому подменяем её через кэш require.
function requireWithDb(fakeDb) {
  const dbKey = require.resolve('../lib/db');
  const tenancyKey = require.resolve('../lib/tenancy');
  const realDb = require.cache[dbKey];
  require.cache[dbKey] = { id: dbKey, filename: dbKey, loaded: true, exports: fakeDb };
  delete require.cache[tenancyKey];
  const fresh = require('../lib/tenancy');
  delete require.cache[tenancyKey];
  if (realDb) require.cache[dbKey] = realDb; else delete require.cache[dbKey];
  return fresh;
}

test('карточки посетителей метрики ищутся по индексу и он не расходится с массивом', () => {
  // findVisitor звали на каждый просмотр, heartbeat и заявку. Перебор массива
  // на потолке в 10 000 карточек — лишние доли миллисекунды в каждом запросе.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'metrics-index-'));
  try {
    const metrics = new Analytics({ dataDir: dir, geoEnabled: false, flushMs: 1e9 });
    const ids = Array.from({ length: 5 }, (_, i) => String(i).repeat(32));
    for (const id of ids) {
      metrics.recordPageView({ id, siteId: 's', path: '/', host: 'x.ru', context: { device: 'Компьютер' } });
    }
    assert.equal(metrics.byId.size, metrics.data.visitors.length);
    assert.equal(metrics.findVisitor(ids[2]).id, ids[2]);
    assert.equal(metrics.findVisitor('нет такого'), null);

    metrics.removeVisitor(ids[2]);
    assert.equal(metrics.findVisitor(ids[2]), null, 'удалённый посетитель не находится');
    assert.equal(metrics.byId.size, metrics.data.visitors.length, 'индекс не разошёлся после удаления');

    // Уборка по сроку хранения выкидывает карточки — индекс обязан это пережить.
    metrics.data.visitors[0].lastSeen = Date.now() - 400 * 24 * 60 * 60 * 1000;
    metrics.cleanup();
    assert.equal(metrics.byId.size, metrics.data.visitors.length, 'индекс пересобран после уборки');
    for (const v of metrics.data.visitors) assert.equal(metrics.findVisitor(v.id), v);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('осознанный sparkles отличается от промаха подбора иконки', () => {
  // sparkles — не только фолбэк: у Apple это глиф «Built for AI» на buy-mac.
  // Без отдельной проверки диагностика каталога считала эти строки ошибкой.
  const icons = require('../lib/spec-icons');
  assert.equal(icons.pickIcon('Готов к ИИ', 'Apple Intelligence в macOS 26'), 'sparkles');
  assert.equal(icons.hasIcon('Готов к ИИ', 'Apple Intelligence в macOS 26'), true, 'это правило, а не промах');
  assert.equal(icons.hasIcon('Абракадабра', 'ничего похожего в правилах нет'), false);
  assert.equal(icons.pickIcon('Абракадабра', 'ничего похожего в правилах нет'), 'sparkles', 'рисуем всё равно sparkles');

  // На текущем каталоге промахов быть не должно — это и есть смысл проверки.
  const misses = [];
  for (const p of catalog.products) {
    for (const line of String(p.specs || '').split('\n')) {
      if (!line.trim()) continue;
      const i = line.indexOf(':');
      const key = i > -1 ? line.slice(0, i).trim() : '';
      const value = i > -1 ? line.slice(i + 1).trim() : line;
      if (!icons.hasIcon(key, value)) misses.push(p.name + ' | ' + line);
    }
  }
  assert.deepEqual(misses, [], 'у каждой характеристики каталога есть своё правило');
});
