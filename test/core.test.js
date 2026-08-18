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
const clientIcons = require('../lib/client-icons');
const { Analytics, deviceFromUa, clientDetails, isPrivateIp, sourceFromReferrer, sessionsOf, MAX_HITS } = require('../lib/analytics');
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

test('срезанный краем кадр отличается от целого снимка квадратного товара', () => {
  // Часть фото с buy-страниц Apple — крупный план детали, а не товар целиком.
  // Одной геометрией их не отличить: Mac mini сверху тоже почти квадратный и
  // тоже заполняет кадр, но он целый. Решают углы рамки содержимого — у целого
  // товара там фон, у срезанного тело. Числа взяты с боевых снимков.
  const S = 1200;
  const bg = [0.97, 0.97, 0.97, 0.97];
  assert.equal(images.looksCropped({ w: 738, h: 1102 }, bg, S), false, 'обычный вертикальный снимок');
  assert.equal(images.looksCropped({ w: 1055, h: 1090 }, bg, S), false, 'Mac mini сверху — целый, хоть и квадратный');
  assert.equal(images.looksCropped({ w: 1101, h: 439 }, [0.85, 0.87, 0.97, 0.97], S), false, 'широкий снимок с тенью в углах');
  assert.equal(images.looksCropped({ w: 1096, h: 1104 }, [0.97, 0.97, 0.41, 0.56], S), true, 'макро-панель iPhone');
  assert.equal(images.looksCropped({ w: 1055, h: 1046 }, [0.42, 0.96, 0.97, 0.94], S), true, 'сценарный кадр AirTag');
  // Кадр, где товар не достаёт до края ни одной стороной, не проверяется вовсе.
  assert.equal(images.looksCropped({ w: 800, h: 900 }, [0.1, 0.1, 0.1, 0.1], S), false);
  assert.equal(images.looksCropped(null, bg, S), false);

  // Второй, более широкий уровень — только «под вопросом», порядок он не меняет.
  // Вертикальный крупный план занимает всю высоту, но лишь две трети ширины —
  // строгое правило его не берёт, широкое берёт.
  const verticalCrop = { w: 802, h: 1104 };
  assert.equal(images.looksCropped(verticalCrop, [0.48, 0.55, 0.97, 0.97], S), false);
  assert.equal(images.looksSuspect(verticalCrop, [0.48, 0.55, 0.97, 0.97], S), true);
  // Но туда же попадает ЦЕЛЫЙ снимок тёмного ноутбука: экран на тёмных обоях
  // доходит до углов рамки. Ровно поэтому широкий уровень ничего не переставляет.
  assert.equal(images.looksSuspect({ w: 1104, h: 700 }, [0.74, 0.76, 0.97, 0.97], S), true,
    'цельный MacBook тоже сюда попадает — значит автоматом такое двигать нельзя');
  // Всё, что строгое правило признало срезанным, широкое обязано подтверждать.
  assert.equal(images.looksSuspect({ w: 1096, h: 1104 }, [0.97, 0.97, 0.41, 0.56], S), true);

  // Перестановка обязана быть стабильной: галерея фильтрует список по цвету и
  // ремешку, и относительный порядок внутри группы должен сохраниться.
  const marks = [
    { file: 'a', cropped: false }, { file: 'b', cropped: true },
    { file: 'c', cropped: false }, { file: 'd', cropped: true }, { file: 'e', cropped: false }
  ];
  const next = marks.filter(m => !m.cropped).map(m => m.file).concat(marks.filter(m => m.cropped).map(m => m.file));
  assert.deepEqual(next, ['a', 'c', 'e', 'b', 'd']);
  // И остаётся точной перестановкой — иначе маршрут порядка её не примет.
  assert.equal(images.validImageOrder(marks.map(m => m.file), next), true);
});

test('карточки используют единый фон фото и естественный интервал до отзывов', () => {
  const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'styles.css'), 'utf8');
  assert.match(css, /\.card-media\{[^}]*background:#f5f5f7[^}]*isolation:isolate/);
  assert.match(css, /\.card-media img\{mix-blend-mode:darken\}/);
  // Важно, что под название не резервируется пустая высота (min-height:0) и что
  // до строки рейтинга остаётся небольшой отступ. Точное число пикселей — вопрос
  // вкуса и меняется при правках дизайна, поэтому проверяем диапазон, а не
  // конкретное значение: раньше тест падал от безобидного 7px → 5px.
  const cardName = /\.card-name\{[^}]*min-height:0[^}]*margin:0 0 (\d+)px/.exec(css);
  assert.ok(cardName, 'у названия карточки должен остаться min-height:0 и нижний отступ');
  const gap = Number(cardName[1]);
  assert.ok(gap >= 4 && gap <= 9, `отступ до рейтинга вышел за разумные пределы: ${gap}px`);
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

test('хронология посетителя пишется просмотрами, а время идёт открытой странице', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'store-visitor-hits-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const analytics = new Analytics({ dataDir: dir, geoEnabled: false, flushMs: 600000 });
  const id = 'a'.repeat(32);
  analytics.recordPageView({ id, siteId: 'shop', path: '/', context: { ip: '8.8.8.8', device: 'Телефон', os: 'iOS 26.0' } });
  analytics.recordPageView({ id, siteId: 'shop', path: '/product/p1', context: {} });
  const v = analytics.findVisitor(id);
  v.lastSeen = Date.now() - 30000;
  analytics.heartbeat({ id, siteId: 'shop', path: '/product/p1', context: {} });

  assert.deepEqual(v.hits.map(h => h.p), ['/', '/product/p1']);
  // Секунды heartbeat уходят той странице, что открыта сейчас, а не первой.
  assert.equal(v.hits[0].s, 0);
  assert.ok(v.hits[1].s >= 29, 'время засчитано текущей странице');

  // Оба просмотра — один визит: визит рвётся получасовым разрывом, а не каждой
  // страницей.
  const one = sessionsOf(v);
  assert.equal(one.length, 1);
  assert.equal(one[0].hits.length, 2);

  // Разрыв больше получаса — новый визит, свежие визиты идут первыми.
  v.lastSessionAt = Date.now() - 40 * 60 * 1000;
  analytics.recordPageView({ id, siteId: 'shop', path: '/checkout', context: {} });
  const two = sessionsOf(v);
  assert.equal(two.length, 2);
  assert.equal(two[0].hits[0].p, '/checkout');
  assert.equal(v.visits, 2);

  // Потолок: файл пишется целиком, и хронология не должна расти без предела.
  for (let i = 0; i < 80; i++) analytics.recordPageView({ id, siteId: 'shop', path: '/product/p' + i, context: {} });
  assert.equal(v.hits.length, MAX_HITS);
  assert.equal(v.hits[v.hits.length - 1].p, '/product/p79', 'вытесняются самые старые');
});

test('значок подбирается по строке устройства, а флаг — по стране или её коду', () => {
  assert.equal(clientIcons.osKey('iOS 26.0'), 'apple');
  assert.equal(clientIcons.osKey('macOS 15.5'), 'apple');
  assert.equal(clientIcons.osKey('Android 15'), 'android');
  assert.equal(clientIcons.osKey('Windows 10/11'), 'windows');
  assert.equal(clientIcons.osKey('Другая ОС'), 'globe');
  assert.equal(clientIcons.deviceKey('Телефон', 'iPhone'), 'phone');
  assert.equal(clientIcons.deviceKey('Планшет', 'iPad'), 'tablet');
  assert.equal(clientIcons.deviceKey('Робот', ''), 'bot');
  assert.equal(clientIcons.deviceKey('Компьютер', ''), 'desktop');
  assert.equal(clientIcons.browserKey('Яндекс Браузер 25'), 'yandex');
  assert.equal(clientIcons.browserKey('Safari 26'), 'safari');
  assert.equal(clientIcons.browserKey('Другой браузер'), 'globe');

  // Код от геосервиса и название из старых заявок дают один и тот же флаг.
  assert.equal(clientIcons.flag('', 'ru'), '🇷🇺');
  assert.equal(clientIcons.flag('Россия', ''), '🇷🇺');
  assert.equal(clientIcons.flag('Казахстан', ''), '🇰🇿');
  assert.equal(clientIcons.flag('Страны такой нет', ''), '', 'незнакомая страна остаётся без флага');

  // Имя глифа приходит из разбора строк — чужая строка не должна попасть в разметку.
  const stray = clientIcons.icon('<script>alert(1)</script>', 'a"b');
  assert.match(stray, /^<svg class="cico ab" viewBox="0 0 24 24"/);
  assert.doesNotMatch(stray, /script|"b/);
});

test('в строке заказа видно, откуда клиент, а адрес ведёт в его карточку метрики', () => {
  const order = {
    id: 'o1', number: '482913', customerName: 'Пётр Северов', contact: '@severov',
    delivery: 'cdek', address: 'Москва, СДЭК', visitorId: 'a'.repeat(32), clientIp: '85.140.7.212',
    clientCity: 'Москва', clientCountry: 'Россия', clientIsp: 'MTS',
    clientDevice: 'Телефон', clientModel: 'iPhone', clientOs: 'iOS 26.0', clientBrowser: 'Safari 26', items: []
  };
  const html = render.orderClient(order, { metricsBase: '/owner/analytics/visitor/' });
  assert.match(html, /href="\/owner\/analytics\/visitor\/a{32}"/);
  assert.match(html, /🇷🇺/, 'флаг находится по названию страны — кода у прежних заявок нет');
  assert.match(html, /class="cico/, 'устройство, система и браузер — значками');
  assert.match(html, /iOS 26\.0/);

  // Без базы адреса значки остаются, а ссылки нет: та же функция рисует строку
  // там, где переходить некуда.
  const plain = render.orderClient(order);
  assert.match(plain, /class="cmarks"/);
  assert.doesNotMatch(plain, /visitor\//);

  // У заявки до появления id метрики есть только адрес — по нему и открываем.
  const old = Object.assign({}, order, { visitorId: null });
  assert.match(render.orderClient(old, { metricsBase: '/admin/analytics/visitor/' }), /href="\/admin\/analytics\/visitor\/85\.140\.7\.212"/);

  // Обе панели передают свою базу, иначе ссылка ведёт в чужую панель.
  const list = [order];
  const db = { getOrders: () => list, visibleOrders: () => list, ordersForSite: () => list, getSites: () => [], getProducts: () => [], pendingReviewCount: () => 0 };
  assert.match(ownerViews.ordersList(db, null, 1), /\/owner\/analytics\/visitor\//);
  assert.match(siteViews.ordersList(db, dbCore.defaultSite(), null, 1), /\/admin\/analytics\/visitor\//);
});

test('карточка посетителя показывает визиты, страницы и время на каждой', () => {
  const now = Date.now();
  const visitor = {
    id: 'a'.repeat(32), siteId: 'shop', firstSeen: now - 40 * 86400000, lastSeen: now - 5 * 60000,
    visits: 3, pageViews: 9, activeSeconds: 900, ip: '85.140.7.212', isp: 'MTS',
    city: 'Москва', country: 'Россия', countryCode: 'RU',
    device: 'Телефон', model: 'iPhone', os: 'iOS 26.0', browser: 'Safari 26',
    source: 'yandex.ru', pathCounts: { '/product/p1': 4, '/': 3 },
    hits: [{ p: '/', t: now - 600000, s: 20, v: 1 }, { p: '/product/p1', t: now - 580000, s: 245 }]
  };
  const html = analyticsView.visitorPage(visitor, {
    products: { p1: 'iPhone 17 Pro Max' }, backHref: '/owner/analytics', ordersHref: '/owner/orders',
    visitorBase: '/owner/analytics/visitor/', now,
    orders: [{ id: 'o1', number: '482913', total: 121990, createdAt: now }]
  });
  assert.match(html, /Визит №3/, 'нумерация идёт от общего счётчика визитов');
  assert.match(html, /iPhone 17 Pro Max/, 'страница названа по товару, а не голым путём');
  assert.match(html, /4 мин 5 сек/, 'время на странице');
  assert.match(html, /85\.140\.7\.212/);
  assert.match(html, /🇷🇺/);
  assert.match(html, /yandex\.ru/);
  assert.match(html, /№482913/, 'заказы этого посетителя рядом с историей');
  assert.match(html, /href="\/owner\/analytics"/, 'возврат ко всей метрике');

  // Посетителя могло вытеснить сроком хранения — это не ошибка, а понятный ответ.
  assert.match(analyticsView.visitorMissing('85.140.7.212', { backHref: '/owner/analytics' }), /История не найдена/);
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
  assert.match(mobile, /\.footer-links\{[^}]*grid-template-columns:repeat\(2,auto\)[^}]*font-size:min\(12px,calc\(\(100vw - 46px\)\/32\.9\)\)/);
  assert.match(mobile, /\.footer-links a\{white-space:nowrap\}/);
  // Длина строки вписана в CSS числом, поэтому подписи менять нельзя, не
  // пересчитав константу 32.9 (это 31.3em самой длинной пары плюс запас).
  // В сетке 2×2 такая пара — вторая строка, ссылки про персональные данные:
  // «Гарантия» и «Возврат и обмен» короче и ширину колонок не задают.
  assert.match(html, />Гарантия</);
  assert.match(html, />Возврат и обмен</);
  assert.match(html, />Политика конфиденциальности</);
  assert.match(html, />Согласие на обработку данных</);
});

test('гарантия и возврат — две отдельные страницы со своими условиями', () => {
  const settings = {
    storeName: 'a:Market', tagline: '', accentColor: '#ef3340', currency: '₽', currencyPosition: 'after',
    legalOperator: 'ИП <Тест>', legalDetails: 'ИНН 123', legalAddress: 'Москва', privacyEmail: 'privacy@example.test'
  };
  const warranty = render.warrantyPage(settings, { origin: 'https://example.test' });
  const returns = render.returnsPage(settings, { origin: 'https://example.test' });

  assert.match(warranty, /<link rel="canonical" href="https:\/\/example\.test\/warranty"/);
  assert.match(returns, /<link rel="canonical" href="https:\/\/example\.test\/returns"/);
  assert.match(warranty, /1 год с момента покупки/);
  assert.match(warranty, /не превышает 45 дней/);
  assert.match(returns, /статьей? 25|статье 25/);
  assert.match(returns, /от 1 до 30 банковских дней/);
  assert.match(returns, /Публичная оферта/);
  // Реквизиты продавца экранируются так же, как на странице политики.
  assert.match(warranty, /ИП &lt;Тест&gt;/);
  assert.match(returns, /privacy@example\.test/);

  // Страницы ссылаются друг на друга: покупатель приходит с одним вопросом,
  // а попадает нередко не на тот документ.
  assert.match(warranty, /href="\/returns"/);
  assert.match(returns, /href="\/warranty"/);

  // Перевозчики берутся из закрытого списка доставки, а не переписаны руками.
  for (const m of require('../lib/delivery').METHODS) {
    assert.ok(warranty.includes(m.name), 'гарантия: нет перевозчика ' + m.name);
    assert.ok(returns.includes(m.name), 'возврат: нет перевозчика ' + m.name);
  }

  // Мобильные подписи колонок таблицы сроков — как у остальных legal-таблиц:
  // на телефоне шапка скрыта, и без них строка «1 месяц» осталась бы без имени.
  const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'styles.css'), 'utf8');
  assert.match(css, /\.warranty-table td:nth-child\(1\)::before\{content:"Срок"\}/);
  assert.match(css, /\.warranty-table td:nth-child\(2\)::before/);
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

test('доливка не создаёт дубль переименованной карточки', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'add-novinki-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  // Владелец переименовывает карточки в панели, и одной сверки по названию мало:
  // id занят, имя не совпадает — товар заводится заново со случайным id, без фото
  // и без отзывов. Так на витрине разом появилось шесть пустых дублей.
  const renamed = catalog.products.find(p => p.id === 'vision-pro-m5');
  fs.writeFileSync(path.join(dir, 'products.json'), JSON.stringify([
    Object.assign({}, renamed, { name: 'Apple Vision Pro', images: [] })
  ]));

  const script = path.join(__dirname, '..', 'add-novinki.js');
  execFileSync(process.execPath, [script], {
    encoding: 'utf8', env: Object.assign({}, process.env, { STORE_DATA_DIR: dir })
  });

  const after = JSON.parse(fs.readFileSync(path.join(dir, 'products.json'), 'utf8'));
  const vision = after.filter(p => p.id === 'vision-pro-m5' || p.name.startsWith('Apple Vision Pro'));
  assert.equal(vision.length, 1, 'переименованная карточка не задвоилась');
  assert.equal(vision[0].name, 'Apple Vision Pro', 'имя владельца не перезаписано');
  assert.equal(new Set(after.map(p => p.id)).size, after.length, 'id не повторяются');
  assert.equal(new Set(after.map(p => p.name)).size, after.length, 'названия не повторяются');
  // Остальные новинки при этом доливаются как обычно.
  assert.ok(after.some(p => p.id === 'watch-series-10'), 'новинки всё же добавлены');
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
    ordersForSite: () => [], visibleOrders: () => [], getProducts: () => [], getReviews: () => [],
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

test('строка заказа: свой столбец у каждого вопроса, длинное — под раскрытием', () => {
  const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'styles.css'), 'utf8');
  const long = {
    id: 'o1', number: '482913', createdAt: Date.now(), status: 'new',
    customerName: 'Анна Смирнова', contact: '@anna', total: 420940,
    delivery: 'cdek', deliveryMode: 'pvz', deliveryPrice: 510,
    address: 'Краснодарский край, Брюховецкий р-н, ст-ца Новоджерелиевская, тер Автодорога, 28-й км, зд 1',
    clientCity: 'Берлин', clientCountry: 'Германия', clientCountryCode: 'DE',
    clientDevice: 'Компьютер', clientOs: 'macOS 10', clientBrowser: 'Firefox 140',
    clientIp: '85.140.7.212', clientIsp: 'Vodafone', visitorId: 'a'.repeat(32),
    payment: { status: 'paid', method: 'SBP' },
    items: Array.from({ length: 6 }, (_, i) => ({ name: 'Товар ' + (i + 1), price: 100, qty: 1 }))
  };
  const db = {
    getOrders: () => [long], visibleOrders: () => [long], ordersForSite: () => [long],
    getSites: () => [], getProducts: () => [], pendingReviewCount: () => 0
  };
  const panels = {
    'владелец': ownerViews.ordersList(db, null, 1),
    'админка сайта': siteViews.ordersList(db, dbCore.defaultSite(), null, 1)
  };
  for (const [name, html] of Object.entries(panels)) {
    // Состояние оплаты, способ и сумма — три разных вопроса и три столбца.
    // В одной ячейке они читались как одно целое.
    assert.match(html, /<th>Статус<\/th>/, name);
    assert.match(html, /<th>Оплата<\/th>/, name);
    assert.match(html, /<td class="o-state">/, name);
    assert.match(html, /<td class="o-pay">/, name);
    assert.match(html, /<td class="o-sum"><b>/, name);
    // Сумма в своей ячейке одна: значок состояния к ней больше не приписан.
    const sumCell = html.slice(html.indexOf('<td class="o-sum">'), html.indexOf('</td>', html.indexOf('<td class="o-sum">')));
    assert.doesNotMatch(sumCell, /pay-tag|СБП/, 'в ячейке суммы только сумма: ' + name);
    // Клиент раскрывается: адрес пункта выдачи бывает длиннее всей строки.
    assert.match(html, /<details class="o-who"><summary>Анна Смирнова · @anna<\/summary>/, name);
    // Длинный заказ сворачивается после трёх позиций.
    assert.match(html, /class="o-rest"><summary>ещё 3 позиции<\/summary>/, name);
    // Свёртки «Откуда зашёл» больше нет: строка значков и есть ссылка в метрику,
    // а IP с провайдером лежат там же, в карточке посетителя.
    assert.doesNotMatch(html, /Откуда зашёл|o-tech/, name);
    // Удаление доступно только в режиме правки, но сама форма в разметке есть.
    assert.match(html, /id="orders-edit" class="edit-switch/, name);
    assert.match(html, /orders\/o1\/delete/, name);
  }

  // Раскрывать нечего — стрелки нет: у заявки без адреса и техники она открывала
  // бы пустоту.
  assert.doesNotMatch(render.orderClient({ customerName: 'Старый', contact: 'tg' }), /<details/);
  // Короткий заказ не сворачивается вовсе.
  assert.doesNotMatch(render.orderItems({ items: [{ name: 'Товар', qty: 1 }] }), /<details/);

  // Столбец действий скрыт, пока не нажата «Изменить»: «✕» у каждой строки —
  // это удаление заказа в один промах мыши. Переключатель — чистый CSS.
  assert.match(css, /\.a-orders \.o-act\{display:none/);
  assert.match(css, /\.edit-switch:checked ~ \.a-orders \.o-act\{display:table-cell\}/);
  // Всё в строке выровнено по центру, а не прижато к верхней границе.
  assert.match(css, /\.a-orders td\{[^}]*vertical-align:middle/);
});

test('списки заказов в панелях листаются, а не выгружаются целиком', () => {
  // Та же ловушка, что была у отзывов: заказы не удаляются сами, список растёт
  // без предела. На 3000 заявок страница весила 2,8 МБ и держала единственный
  // поток около 100 мс — всё это время витрина не отвечала никому.
  const per = render.ADMIN_PER_PAGE;
  const many = Array.from({ length: per * 3 + 7 }, (_, i) => ({
    id: 'o' + i, number: String(500000 + i), siteId: 's', siteName: 'Магазин',
    items: [{ id: 'p', name: 'Товар', price: 100, qty: 1 }], total: 100,
    customerName: 'Клиент ' + i, contact: '@u' + i, status: 'new', createdAt: 2000 - i
  }));
  const db = {
    getOrders: () => many, visibleOrders: () => many, ordersForSite: () => many, getSites: () => [],
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
  assert.ok(ownerFirst.indexOf('№500000') > -1, 'самый свежий заказ на первой странице');
  assert.equal(ownerFirst.indexOf('№500150'), -1, 'заказы других страниц сюда не попадают');

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

/* ------------------------------ Онлайн-оплата ------------------------------ */

test('оплата выключена по умолчанию и не включается без ключей кассы', () => {
  const croco = require('../lib/crocopay');
  // Именно значения по умолчанию: свежая установка не должна показывать оплату.
  assert.equal(dbCore.defaultSettings().crocopayEnabled, false);
  assert.equal(croco.enabled(dbCore.defaultSettings()), false);
  // Галочка без ключей дала бы кнопку, которая всегда ошибается.
  assert.equal(croco.enabled({ crocopayEnabled: true }), false);
  assert.equal(croco.enabled({ crocopayEnabled: true, crocopayClientId: 'a', crocopayClientSecret: '' }), false);
  assert.equal(croco.enabled({ crocopayEnabled: true, crocopayClientId: 'a', crocopayClientSecret: 'b' }), true);
  // Ключи есть, но галочка снята — витрина работает как раньше.
  assert.equal(croco.enabled({ crocopayClientId: 'a', crocopayClientSecret: 'b' }), false);
  // Касса рублёвая, выбора валюты нет ни у покупателя, ни у владельца.
  assert.equal(croco.CURRENCY, 'RUB');
  assert.equal(croco.toMinor(5000), 500000);
  assert.equal(croco.toMinor(99990), 9999000);
});

test('отказ кассы объяснён покупателю, а «нет реквизитов» — не поломка', () => {
  const croco = require('../lib/crocopay');
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

  // Штатный отказ P2P-процессинга: пул карт конечен, и на конкретную сумму
  // свободной может не быть. Лечится другим способом (у СБП пул свой) или
  // повтором — ровно это покупателю и говорим, а не «не удалось».
  const noReq = croco.startError('Requisites not found');
  assert.match(noReq, /нет свободных реквизитов/i);
  assert.match(noReq, /другой способ|через пару минут/i);
  assert.equal(croco.startError('REQUISITE_NOT_FOUND'), noReq);

  assert.match(croco.startError('payment_option is not enabled'), /способ оплаты сейчас недоступен/i);
  assert.match(croco.startError('timeout'), /не отвечает/i);
  // Незнакомый ответ кассы наружу не показываем — он покупателю ничего не
  // объясняет, — но говорим, что заказ сохранён: он и правда настоящий.
  const unknown = croco.startError('Internal server error #42');
  assert.doesNotMatch(unknown, /Internal|#42/);
  assert.match(unknown, /заказ уже сохранён/i);
  assert.equal(croco.startError(''), unknown);
  assert.equal(croco.startError(null), unknown);

  // Маршрут берёт текст оттуда же: разбор чужих ответов живёт рядом с остальным
  // знанием об их API, а не размазан по server.js.
  const start = server.slice(server.indexOf("app.post('/api/pay/crocopay/start'"), server.indexOf("app.get('/api/pay/crocopay/status'"));
  assert.match(start, /CROCO\.startError\(r\.error\)/);
  // Заказ при отказе кассы остаётся настоящим — иначе покупатель оформит второй.
  assert.match(start, /placed: true/);
  // В логе — способ и сумма: по одной строке «Requisites not found» не понять,
  // на чём именно споткнулась касса.
  assert.match(start, /console\.error\('crocopay invoice:'[^)]*способ[^)]*сумма/);
});

test('страница оплаты: точная сумма выделена, подписи без рода, отмены счёта нет', () => {
  const ss = { storeName: 'Тест', tagline: '', accentColor: '#0071e3', currency: '₽', currencyPosition: 'after' };
  const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'styles.css'), 'utf8');
  const order = {
    id: 'a1b2', number: '482913', total: 68200, createdAt: Date.now(), items: [],
    payment: {
      provider: 'crocopay', status: 'pending', method: 'SBP', invoiceId: '11111111-2222-3333-4444-555555555555',
      requisite: '79104693811', bank: 'Т-Банк', owner: 'Иванов Иван', expiresAt: Date.now() + 10 * 60 * 1000
    }
  };
  const html = render.payPage(ss, order, { origin: '' });

  // Точная сумма — единственное требование страницы, которое нельзя не
  // выполнить: у P2P перевод сходится с заказом по сумме.
  assert.match(html, /<b class="pay-exact">Переведите точную сумму<\/b>/);
  assert.match(css, /\.pay-exact\{[^}]*text-transform:uppercase/);
  assert.match(css, /\.pay-exact\{[^}]*font-weight:700/);
  assert.match(css, /\.pay-exact\{[^}]*color:#b42318/);
  // Прописные делает CSS, а не сам текст: скринридер читает исходную строку как
  // обычное предложение, а без стилей она остаётся читаемой.
  assert.doesNotMatch(html, /ПЕРЕВЕДИТЕ ТОЧНУЮ СУММУ/);

  // Покупатель бывает и женщиной: «Я оплатил — проверить» на кнопке быть не
  // должно. Ищем в самой карточке оплаты, а не во всей странице: в общей
  // разметке есть «которые вы указали» — это вежливое «вы», а не мужской род.
  assert.match(html, /id="pay-recheck">Проверить перевод</);
  const card = html.slice(html.indexOf('pay-invoice'), html.indexOf('Отменять счёт'));
  for (const gendered of [/оплатил(?![аи])/, /перевёл/, /выбрал(?![аи])/, /готов(?![аы])/]) {
    assert.doesNotMatch(card, gendered, 'на странице оплаты мужской род: ' + gendered);
  }
  // И длинного тире в подписи кнопки тоже нет — оно там только мешало.
  assert.doesNotMatch(card, /<button[^>]*id="pay-recheck">[^<]*—/);

  // Отмены счёта у кассы нет вовсе — в H2H всего три эндпоинта (создать,
  // статус, способы). Кнопки-обманки поэтому не рисуем: покупатель нажал бы
  // «Отменить», а счёт остался бы оплачиваемым. Объяснять это на странице тоже
  // не стали — счёт гаснет сам, и лишняя строка только шумела.
  assert.doesNotMatch(html, /id="pay-cancel"|Отменить (счёт|платёж|оплату)|Отменять счёт/);
  const croco = fs.readFileSync(path.join(__dirname, '..', 'lib', 'crocopay.js'), 'utf8');
  assert.doesNotMatch(croco, /\/cancel|\/void|\/refund/, 'у кассы нет отмены — выдумывать эндпоинт нельзя');
});

test('неоплаченный счёт напоминает о себе на всей витрине и в корзине', () => {
  const ss = { storeName: 'Тест', tagline: '', accentColor: '#0071e3', currency: '₽', currencyPosition: 'after' };
  const remind = { id: 'a1b2', number: '482913', total: 68200, expiresAt: Date.now() + 9 * 60 * 1000 };
  const product = { id: 'p1', name: 'Товар', category: 'Категория', price: 100, inStock: true, images: [], colors: [], storages: [] };
  const db = {
    getProducts: () => [product], categories: () => ['Категория'],
    ratingFor: () => ({ avg: 0, count: 0 }), reviewsForProduct: () => []
  };

  // Полоса обязана быть на КАЖДОЙ странице витрины: покупатель возвращается не
  // обязательно на главную, а товары из корзины уже уехали в заказ — без неё он
  // о заказе просто забудет.
  const pages = {
    'главная': render.homePage(ss, db, { category: '', q: '', origin: '', payRemind: remind }, null),
    'товар': render.productPage(ss, db, product, null, { origin: '', payRemind: remind }),
    'оформление': render.checkoutPage(ss, { origin: '', payRemind: remind }),
    'политика': render.privacyPage(ss, { origin: '', payRemind: remind }),
    'гарантия': render.warrantyPage(ss, { origin: '', payRemind: remind }),
    'возврат': render.returnsPage(ss, { origin: '', payRemind: remind }),
    'не найдено': render.notFoundPage(ss, { origin: '', payRemind: remind })
  };
  for (const [name, html] of Object.entries(pages)) {
    assert.match(html, /id="pay-remind"/, 'нет напоминания на странице: ' + name);
    assert.match(html, /№482913/, 'нет номера заказа: ' + name);
    assert.match(html, /href="\/pay\/a1b2"/, 'некуда вернуться: ' + name);
    assert.ok(html.includes('68 200'.replace(' ', ' ')) || /68\s200/.test(html), 'нет суммы: ' + name);
  }
  // Без напоминания страницы остаются прежними — полоса не появляется из ниоткуда.
  assert.doesNotMatch(render.homePage(ss, db, { category: '', q: '', origin: '' }, null), /id="pay-remind"/);

  // На самой странице оплаты полосы нет: она и есть напоминание.
  const order = {
    id: 'a1b2', number: '482913', total: 68200, createdAt: Date.now(), items: [],
    payment: {
      provider: 'crocopay', status: 'pending', method: 'SBP', invoiceId: '11111111-2222-3333-4444-555555555555',
      requisite: '79104693811', bank: 'Т-Банк', owner: 'Иванов Иван', expiresAt: remind.expiresAt
    }
  };
  assert.doesNotMatch(render.payPage(ss, order, { origin: '' }), /id="pay-remind"/);

  // Сервер отдаёт напоминание только про СВОЙ и только про действующий счёт.
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const fn = server.slice(server.indexOf('function payRemind('), server.indexOf('app.get(\'/product/:id\''));
  assert.match(fn, /req\.session && req\.session\.myOrders/, 'ключ — та же подписанная сессия, что у /pay/:id');
  assert.match(fn, /order\.draft/, 'черновик заказом ещё не стал');
  assert.match(fn, /pay\.status !== 'pending'/);
  assert.match(fn, /pay\.expiresAt <= now/, 'у сгоревшего счёта реквизиты уже чужие');
  assert.match(fn, /order\.siteId !== site\.id/, 'заказ другого магазина показывать нельзя');

  // Витрина повторяет напоминание в корзине и сама убирает его, когда счёт сгорел.
  const js = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'styles.css'), 'utf8');
  assert.match(js, /payRemindCard\(\) \|\| '<div class="cart-empty">/, 'в пустой корзине напоминание вместо «пусто»');
  assert.match(js, /wrap\.innerHTML = payRemindCard\(\) \+ this\.items/, 'и первой строкой при непустой корзине');
  assert.match(js, /box\.remove\(\)/);
  assert.match(js, /setInterval\(syncPayRemind/);
  assert.match(css, /\.pay-remind\{/);
  assert.match(css, /\.cart-remind\{/);
  // На телефоне полоса обязана ужиматься: она стоит над первым экраном.
  assert.match(css, /\.pay-remind-no\{display:none\}/);
  assert.match(css, /\.pay-remind-go-short\{display:inline\}/);
});

test('единицы суммы вебхука угадываются, а недоплата не проходит ни в каких', () => {
  const croco = require('../lib/crocopay');
  // Ожидаем 239 990 ₽. Касса вправе прислать и рубли, и копейки — документация
  // обещает копейки, но она же врёт про единицы счёта, так что верим обеим.
  assert.deepEqual(croco.paidEnough(239990, 239990), { ok: true, major: 239990 });
  assert.deepEqual(croco.paidEnough(239990, 23999000), { ok: true, major: 23999000 });
  assert.equal(croco.paidEnough(100, 10000).ok, true, 'копейки распознаются');
  assert.equal(croco.paidEnough(100, 10000).major, 10000);
  // Переплата законна: при пересчёте по курсу сумма приходит больше рублёвой.
  assert.equal(croco.paidEnough(1000, 1200).ok, true);
  // Недоплата мала сразу в обоих прочтениях, поэтому ложного «оплачено» нет.
  assert.equal(croco.paidEnough(239990, 1000).ok, false);
  assert.equal(croco.paidEnough(239990, 239989).ok, false);
  assert.equal(croco.paidEnough(100, 99).ok, false);
  // Суммы нет вовсе — это не оплата.
  assert.deepEqual(croco.paidEnough(100, undefined), { ok: false, major: null });
  assert.deepEqual(croco.paidEnough(100, 'вообще не число'), { ok: false, major: null });
});

test('статусы счёта переводятся в наши состояния, а чужой id в адрес не уходит', () => {
  const croco = require('../lib/crocopay');
  // Ради этих статусов и затевался переход на H2H: в Express их нет вовсе.
  assert.equal(croco.stateOf('Pending'), 'pending');
  assert.equal(croco.stateOf('Success'), 'paid');
  assert.equal(croco.stateOf('Expired'), 'expired');
  assert.equal(croco.stateOf('Cancelled'), 'cancelled');
  assert.equal(croco.stateOf('Canceled'), 'cancelled', 'американское написание тоже понимаем');
  assert.equal(croco.stateOf('Failed'), 'failed');
  // Незнакомый статус ничего не меняет: лучше оставить заказ как есть, чем угадать.
  assert.equal(croco.stateOf('WhoKnows'), '');
  assert.equal(croco.stateOf(''), '');
  assert.equal(croco.stateOf(null), '');

  // UUID счёта подставляется в путь запроса, поэтому пропускаем только похожее
  // на него: чужая строка там — это уже запрос неизвестно куда.
  assert.ok(croco.validInvoiceId('911c2823-f55b-43b5-9881-d5653107f7dc'));
  assert.equal(croco.validInvoiceId('../../merchants'), false);
  assert.equal(croco.validInvoiceId('a b'), false);
  assert.equal(croco.validInvoiceId(''), false);
  assert.equal(croco.validInvoiceId('короткий'), false);
});

test('ключи кассы не попадают на витрину, а признак оплаты — попадает', () => {
  const ss = { storeName: 'Тест', tagline: '', accentColor: '#0071e3', currency: '₽', currencyPosition: 'after' };
  const off = render.checkoutPage(ss, { origin: '' });
  const on = render.checkoutPage(ss, { origin: '', payOnline: true });
  assert.doesNotMatch(off, /data-pay/, 'без оплаты витрина о ней не знает');
  assert.match(on, /id="checkout-page" data-pay="1"/);
  // На витрину уходит только «включено». Ключи остаются на сервере, как ключ
  // подсказок адреса.
  const keys = render.checkoutPage(Object.assign({}, ss, {
    crocopayClientId: 'ГДЕ-ТО-КЛЮЧ', crocopayClientSecret: 'СЕКРЕТ-КАССЫ'
  }), { origin: '', payOnline: true });
  assert.doesNotMatch(keys, /ГДЕ-ТО-КЛЮЧ|СЕКРЕТ-КАССЫ/);
  // siteSettings собирается поимённо — платёжных полей там быть не должно.
  const site = Object.assign(dbCore.defaultSite(), { crocopayClientSecret: 'СЕКРЕТ-КАССЫ' });
  assert.doesNotMatch(JSON.stringify(tenancy.siteSettings(site)), /СЕКРЕТ-КАССЫ|crocopay/i);
});

test('способы оплаты — закрытый список, а показываем только включённые у кассы', () => {
  const pay = require('../lib/pay-methods');
  // id уходит в счёт и остаётся в заказе навсегда — это и есть закрытый список.
  assert.ok(pay.isValid('SBP'));
  assert.ok(pay.isValid('TO_CARD'));
  assert.equal(pay.isValid('ЧУЖОЕ'), false);
  assert.equal(pay.isValid(''), false);
  assert.equal(pay.nameOf('SBP'), 'СБП');
  // Неизвестный способ (и платёж прежней схемы, где способа не было) даёт
  // пустую строку, а не «undefined» в панели.
  assert.equal(pay.nameOf('ЧУЖОЕ'), '');
  assert.equal(pay.nameOf(undefined), '');
  // Подпись реквизита зависит от способа: поле `card` у платёжки одно на все
  // случаи — там и номер карты, и телефон СБП, и ссылка QR.
  assert.equal(pay.requisiteLabel('TO_CARD'), 'Номер карты');
  assert.equal(pay.requisiteLabel('SBP'), 'Номер телефона');
  assert.equal(pay.requisiteLabel('QR_NSPK'), 'Ссылка для оплаты');

  // Показываем пересечение трёх списков: нашего, кассы и разрешённого владельцем.
  const some = pay.allowed(['SBP', 'QR_NSPK', 'НЕИЗВЕСТНЫЙ_НАМ'], ['SBP', 'QR_NSPK', 'TO_CARD']);
  assert.deepEqual(some.map(m => m.id), ['SBP', 'QR_NSPK']);
  // Владелец скрыл способ — касса его наличие не перебивает.
  assert.deepEqual(pay.allowed(['SBP', 'TO_CARD'], ['SBP']).map(m => m.id), ['SBP']);
  // Настройки нет вовсе (установка обновилась со старой версии) — набор по
  // умолчанию, а не «всё»: иначе на витрине разом появились бы трансграничные.
  assert.deepEqual(pay.allowed(null, null).map(m => m.id), pay.DEFAULT_IDS);
  assert.deepEqual(pay.DEFAULT_IDS, ['SBP', 'TO_CARD']);
  // Касса не ответила — её условие не применяем: без списка покупателю нечем
  // платить вовсе, а несовпадение поймает сама касса при создании счёта.
  assert.equal(pay.allowed(null, ['SBP', 'TO_CARD', 'QR_NSPK']).length, 3);
  // А вот пустой ответ кассы — это «у неё ничего не включено»: заведомо
  // нерабочие кнопки хуже честного «оплатить сейчас нечем».
  assert.deepEqual(pay.allowed([], ['SBP', 'TO_CARD']), []);
  // Владелец снял все галочки — показывать нечего, и это его решение.
  assert.deepEqual(pay.allowed(['SBP'], []), []);

  // То, что реально включено у боевой кассы, обязано быть в списке — иначе мы
  // молча спрячем рабочий способ (пересечение чужой код не пропускает).
  for (const id of ['TO_CARD', 'SBP', 'TO_CARD_TRANSGRAN', 'SBP_TRANSGRAN', 'TRANSGRANCARD_TJS']) {
    assert.ok(pay.isValid(id), 'способ кассы не описан: ' + id);
  }
});

test('подпись вебхука проверяется по тексту значений, а не по разобранным числам', () => {
  const croco = require('../lib/crocopay');
  const crypto = require('crypto');
  const secret = 'секрет-кассы';
  const sign = msg => crypto.createHmac('sha256', secret).update(msg).digest('hex');

  // Ровно порядок полей из документации.
  const body = { timestamp: 1753282096, subtotal: 500000, percentage: 0, charge_percentage: 0, charge_fixed: 0, total: 500000 };
  body.sign = sign('1753282096|500000|0|0|0|500000');
  assert.equal(croco.verify(secret, body, null), true);
  assert.equal(croco.verify('другой-секрет', body, null), false);
  assert.equal(croco.verify(secret, Object.assign({}, body, { total: 1 }), null), false, 'подменённая сумма ломает подпись');
  assert.equal(croco.verify(secret, Object.assign({}, body, { sign: 'нехекс' }), null), false);
  assert.equal(croco.verify('', body, null), false, 'без секрета не подтверждаем ничего');

  // charge_fixed приходит и как "0.00000000" — JSON.parse обратно в такую строку
  // не собирается, поэтому подпись считается по сырому телу. Без rawBody этот
  // вебхук отвергался бы как чужой.
  const raw = '{"timestamp":1734617868,"subtotal":500000,"percentage":0,"charge_percentage":0,'
    + '"charge_fixed":"0.00000000","total":500000,"sign":"' + sign('1734617868|500000|0|0|0.00000000|500000') + '"}';
  const parsed = JSON.parse(raw);
  assert.equal(croco.verify(secret, parsed, raw), true);
  assert.equal(croco.verify(secret, parsed, null), true, 'строка из JSON доезжает и без сырого тела');
  // Дробное число литералом: разбор потерял бы хвостовой ноль.
  const rawNum = '{"timestamp":1,"subtotal":150,"percentage":0,"charge_percentage":0,'
    + '"charge_fixed":0.50,"total":150,"sign":"' + sign('1|150|0|0|0.50|150') + '"}';
  assert.equal(croco.verify(secret, JSON.parse(rawNum), rawNum), true);
  assert.equal(croco.verify(secret, JSON.parse(rawNum), null), false, 'без сырого тела 0.50 превращается в 0.5');
});

test('сырое тело JSON сохраняется для подписи, но не для загрузок', async () => {
  const app = new App({ secret: 'k' });
  let seen = null;
  app.post('/echo', (req, res) => { seen = req.rawBody; res.json({ ok: true }); });
  const send = async body => {
    seen = null;
    const res = response();
    await app.handle(request('/echo', {
      method: 'POST', body: Buffer.from(body),
      headers: { 'content-type': 'application/json' }
    }), res);
    return seen;
  };
  assert.equal(await send('{"charge_fixed":"0.00000000"}'), '{"charge_fixed":"0.00000000"}');
  // Мегабайты в памяти ради подписи держать незачем.
  const big = '{"a":"' + 'x'.repeat(70 * 1024) + '"}';
  assert.equal(await send(big), undefined);
});

test('трансграничные способы скрыты по умолчанию и включаются в настройках', () => {
  const pay = require('../lib/pay-methods');
  const source = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

  // Свежая установка показывает два способа для России, а не все одиннадцать.
  assert.deepEqual(dbCore.defaultSettings().payMethods, ['SBP', 'TO_CARD']);
  assert.ok(pay.METHODS.length > 2, 'остальные способы никуда не делись — они просто скрыты');
  for (const m of pay.METHODS) {
    if (/TRANSGRAN/.test(m.id)) assert.equal(pay.DEFAULT_IDS.includes(m.id), false, 'трансграничный по умолчанию скрыт: ' + m.id);
  }

  // Галочки в панели: снятые в теле формы отсутствуют, поэтому нужен признак
  // того, что секция вообще пришла, — иначе «снять все» неотличимо от запроса
  // без этой секции.
  const settings = Object.assign(dbCore.defaultSettings(), { payMethods: ['SBP'] });
  const html = ownerViews.settingsPage(settings, { pendingReviewCount: () => 0 }, null);
  assert.match(html, /name="payMethodsForm"/);
  assert.match(html, /name="payMethods" value="SBP" checked/);
  assert.match(html, /name="payMethods" value="TO_CARD"(?! checked)/);
  const empty = ownerViews.settingsPage(Object.assign({}, settings, { payMethods: [] }), { pendingReviewCount: () => 0 }, null);
  assert.match(empty, /Не отмечен ни один способ/);

  // Скрытый способ не должен проходить запросом мимо интерфейса.
  const start = source.slice(source.indexOf("app.post('/api/pay/crocopay/start'"), source.indexOf("app.get('/api/pay/crocopay/status'"));
  assert.match(start, /PAY\.allowed\(null, s\.payMethods\)\.some/);
  assert.match(source, /PAY\.allowed\(r\.ok \? r\.options : null, s\.payMethods\)/);
});

test('у способа оплаты есть знак, а у СБП — настоящий логотип', () => {
  const ss = { storeName: 'Тест', tagline: '', accentColor: '#0071e3', currency: '₽', currencyPosition: 'after' };
  const pay = require('../lib/pay-methods');
  const order = { id: 'o1', number: '482913', total: 71990, items: [], contact: 'tg' };
  const html = render.payPage(ss, order, { origin: '', methods: pay.allowed(null, ['SBP', 'TO_CARD', 'QR_NSPK']) });

  // Логотип СБП — тот же файл, что в подвале: два svg, знак и надпись.
  assert.match(html, /class="pay-opt-sbp">\s*<svg[\s\S]*?<\/svg>\s*<svg/);
  // Остальные знаки — заливкой, а не волосяным контуром: рядом с плотным
  // логотипом СБП тонкий глиф выглядел бледной мелочью.
  assert.match(html, /class="pay-opt-glyph"[^>]*fill="currentColor"[^>]*fill-rule="evenodd"/);
  assert.doesNotMatch(html, /class="pay-opt-glyph"[^>]*stroke/);

  const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'styles.css'), 'utf8');
  // Высота знака одна на всех, ширина — по пропорции из viewBox.
  assert.match(css, /\.pay-opt-glyph\{[^}]*height:21px;width:auto/);
  // Знак СБП разделяет сегменты обводкой цветом фона. На карточке фон белый,
  // поэтому и обводка белая, а фон выбранной карточки обязан остаться белым —
  // иначе зазоры знака проступят полосками.
  assert.match(css, /\.pay-opt-sbp svg:first-child\{[^}]*stroke:#fff/);
  assert.match(css, /\.pay-opt:has\(input:checked\)\{background:#fff/);
  // Радио остаётся настоящим и видимым: :has() поддерживают не все версии
  // Safari, доходящие до витрины, и выбор обязан читаться без него.
  assert.doesNotMatch(css, /\.pay-opt input\{[^}]*(display:none|opacity:0)/);
});

test('черновик не считается заказом, пока не выбран способ оплаты', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'order-draft-'));
  const fresh = freshDb(dir);
  const real = fresh.createOrder({ items: [], total: 100, contact: 'tg' });
  const draft = fresh.createOrder({ draft: true, items: [], total: 200, contact: 'tg' });

  // В панелях черновика нет: покупатель мог просто заглянуть на страницу оплаты.
  assert.deepEqual(fresh.visibleOrders().map(o => o.id), [real.id]);
  assert.equal(fresh.ordersForSite(null).some(o => o.id === draft.id), false);
  // Но сам он записан: на него вешается счёт, и по id его надо находить.
  assert.equal(fresh.getOrder(draft.id).id, draft.id);
  assert.equal(fresh.getOrders().length, 2, 'внутренний список отдаёт всё — иначе запись стёрла бы черновики');

  // Способ выбран — черновик стал заказом, и ровно один раз: уведомление
  // менеджеру и отметка в метрике идут по этому признаку.
  const first = fresh.promoteOrder(draft.id);
  assert.equal(first.promoted, true);
  assert.equal(fresh.promoteOrder(draft.id).promoted, false, 'второй раз менеджера не дёргаем');
  assert.equal(fresh.visibleOrders().length, 2);
  assert.equal('draft' in fresh.getOrder(draft.id), false, 'признак снимается, а не остаётся false');

  // Брошенные черновики не копятся: их больше, чем купивших.
  const stale = fresh.createOrder({ draft: true, items: [], total: 300, contact: 'tg' });
  const file = path.join(dir, 'orders.json');
  const list = JSON.parse(fs.readFileSync(file, 'utf8'));
  list.find(o => o.id === stale.id).createdAt = Date.now() - 25 * 60 * 60 * 1000;
  fs.writeFileSync(file, JSON.stringify(list));
  fresh.createOrder({ items: [], total: 400, contact: 'tg' });
  assert.equal(fresh.getOrder(stale.id), null, 'сутки — и брошенный черновик убран');
  assert.equal(fresh.getOrder(real.id).id, real.id, 'настоящие заказы уборка не трогает');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('оформление с онлайн-оплатой не чистит корзину до выбора способа', () => {
  const js = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  const pay = fs.readFileSync(path.join(__dirname, '..', 'public', 'pay.js'), 'utf8');
  const source = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

  // Корзина остаётся до выбора способа: иначе ушедший со страницы оплаты
  // покупатель теряет и заказ, и товары разом.
  assert.match(js, /if \(!online\) Cart\.clear\(\)/);
  assert.match(pay, /d\.placed[\s\S]{0,80}Cart\.clear\(\)/);

  // Заказ становится настоящим при выборе способа — ДО обращения к кассе:
  // отказ кассы (у неё кончились свободные реквизиты) не должен прятать от
  // менеджера готового покупателя.
  const start = source.slice(source.indexOf("app.post('/api/pay/crocopay/start'"), source.indexOf("app.get('/api/pay/crocopay/status'"));
  assert.ok(start.indexOf('db.promoteOrder(id)') < start.indexOf('CROCO.createInvoice'));
  assert.match(start, /grown\.promoted[\s\S]{0,160}notifyNewOrder\(grown\.order\)/);
  // Черновик — только когда есть что выбирать. Без онлайн-оплаты заявка
  // настоящая сразу, как и была.
  assert.match(source, /const draft = CROCO\.enabled\(settings\(\)\)/);
  assert.match(source, /if \(!draft\) metrics\.markOrder/);
});

test('номера заказов случайные, не маленькие и не повторяются', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'order-num-'));
  const fresh = freshDb(dir);
  const numbers = [];
  for (let i = 0; i < 40; i++) {
    const o = fresh.createOrder({ items: [], total: 1, contact: 'tg' });
    numbers.push(o.number);
  }
  for (const n of numbers) {
    // Шестизначный: по «Заказ №7» покупатель прочитал бы оборот магазина.
    assert.match(n, /^\d{6,7}$/, 'номер не похож на случайный: ' + n);
    assert.ok(Number(n) >= 100000, 'номер выглядит маленьким: ' + n);
  }
  // По номеру менеджер находит заявку, поэтому повторов быть не должно.
  assert.equal(new Set(numbers).size, numbers.length, 'номера повторились');
  // Именно случайные, а не подряд: сорок последовательных значений — это счётчик.
  const sorted = numbers.map(Number).slice().sort((a, b) => a - b);
  const consecutive = sorted.every((v, i) => i === 0 || v === sorted[i - 1] + 1);
  assert.equal(consecutive, false, 'номера выдаются подряд');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('номер заказа везде пишется как «Заказ №…»', () => {
  const js = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  assert.equal(render.orderNo('482913'), '№482913');
  // Заявки до перехода на случайные номера остаются с префиксом ORD-, и
  // «Заказ №ORD-0001» читалось бы как опечатка. Сами номера не переписываем.
  assert.equal(render.orderNo('ORD-0001'), '№0001');
  assert.equal(render.orderNo(''), '—');
  assert.equal(render.orderNo(null), '—');

  const ss = { storeName: 'Тест', tagline: '', accentColor: '#0071e3', currency: '₽', currencyPosition: 'after' };
  const order = { id: 'o1', number: '482913', total: 71990, items: [], contact: 'tg', payment: { status: 'paid' } };
  const paid = render.payPage(ss, order, { origin: '' });
  assert.match(paid, /<span>Заказ<\/span><strong>№482913<\/strong>/);
  assert.doesNotMatch(paid, /Номер заказа/, 'подпись «Номер заказа» рядом с «№» читалась бы дважды');

  // Панели и витрина берут ту же функцию, иначе где-то останется голое число.
  const list = [{ id: 'o1', number: '482913', createdAt: Date.now(), status: 'new', contact: 'tg', total: 100, items: [] }];
  const db = { getOrders: () => list, visibleOrders: () => list, ordersForSite: () => list, getSites: () => [], getProducts: () => [], pendingReviewCount: () => 0 };
  assert.match(ownerViews.ordersList(db, null, 1), /<b>№482913<\/b>/);
  assert.match(siteViews.ordersList(db, dbCore.defaultSite(), null, 1), /<b>№482913<\/b>/);
  assert.match(js, /function orderNo\(number\)/);
  assert.doesNotMatch(js, /<span>Номер заказа<\/span>/);
});

test('оплата живёт отдельным полем и закрывается один раз', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'order-pay-'));
  const fresh = freshDb(dir);
  const order = fresh.createOrder({ items: [{ id: 'p1', name: 'Товар', price: 100, qty: 1 }], total: 100, contact: 'tg' });
  assert.equal(order.payment, null, 'заказ без оплаты читается как «не запускалась»');
  assert.equal(order.status, 'new');

  const token = 'a'.repeat(32);
  const started = fresh.startOrderPayment(order.id, { provider: 'crocopay', token, method: 'SBP', amount: 10000, currency: 'RUB' });
  assert.equal(started.payment.status, 'pending');
  assert.equal(started.payment.token, token);
  assert.equal(started.payment.amount, 10000);
  assert.equal(started.payment.method, 'SBP');
  assert.equal(started.status, 'new', 'статус заказа оплата не подменяет');

  // Реквизиты приезжают отдельным шагом: token нужен ДО создания счёта (он
  // уходит в callback_url), а id счёта появляется только в ответе кассы.
  fresh.attachOrderInvoice(order.id, {
    invoiceId: '911c2823-f55b-43b5-9881-d5653107f7dc', requisite: '4276 1234 5678 9012',
    bank: 'Сбербанк', owner: 'IVAN PETROV', method: 'TO_CARD', expiresAt: 1893456000000
  });
  const withInvoice = fresh.getOrder(order.id).payment;
  assert.equal(withInvoice.invoiceId, '911c2823-f55b-43b5-9881-d5653107f7dc');
  assert.equal(withInvoice.requisite, '4276 1234 5678 9012');
  assert.equal(withInvoice.expiresAt, 1893456000000);

  // Token — один на ЗАКАЗ, а не на счёт: покупатель вправе сменить способ, и по
  // прежнему счёту вебхук придёт с прежним токеном. Перевыпуск отверг бы такой
  // вебхук, то есть потерял бы реально прошедший платёж.
  const second = fresh.startOrderPayment(order.id, { token: 'b'.repeat(32), method: 'SBP', amount: 10000 });
  assert.equal(second.payment.token, token, 'токен заказа не перевыпускается');
  assert.equal(second.payment.invoiceId, '', 'новый счёт начинается с чистых реквизитов');
  fresh.attachOrderInvoice(order.id, { invoiceId: 'bbbbbbbb-0000-0000-0000-000000000000', requisite: '+79001234567', method: 'SBP' });

  // 'pending' закрытием не бывает, иначе вебхук мог бы «разоплатить» заказ.
  assert.equal(fresh.settleOrderPayment(order.id, { status: 'pending' }), null);
  assert.equal(fresh.settleOrderPayment(order.id, { status: 'выдумка' }), null);
  assert.equal(fresh.settleOrderPayment('чужой-id', { status: 'paid' }), null);

  const first = fresh.settleOrderPayment(order.id, { status: 'paid', total: 10000 });
  assert.equal(first.changed, true);
  assert.equal(first.order.payment.status, 'paid');
  // Платёжка вправе повторить вызов, да и опрос статуса идёт каждые несколько
  // секунд — второй раз менеджера дёргать нельзя.
  assert.equal(fresh.settleOrderPayment(order.id, { status: 'paid', total: 10000 }).changed, false);
  // Оплаченный заказ новым счётом не сбрасывается.
  assert.equal(fresh.startOrderPayment(order.id, { token: 'c'.repeat(32) }).payment.token, token);
  assert.equal(fresh.getOrder(order.id).payment.status, 'paid');
  assert.equal(fresh.attachOrderInvoice(order.id, { invoiceId: 'ffffffff-0000-0000-0000-000000000000' }).payment.invoiceId,
    'bbbbbbbb-0000-0000-0000-000000000000', 'реквизиты поверх оплаченного заказа не пишем');

  // Липким сделано только 'paid'. Из 'expired' в 'paid' дорасти можно и нужно:
  // вебхук об успехе вполне приходит после того, как опрос увидел истёкший счёт.
  const other = fresh.createOrder({ items: [], total: 50, contact: 'tg' });
  fresh.startOrderPayment(other.id, { token: 'd'.repeat(32), amount: 5000, currency: 'RUB' });
  assert.equal(fresh.settleOrderPayment(other.id, { status: 'expired' }).changed, true);
  assert.equal(fresh.settleOrderPayment(other.id, { status: 'expired' }).changed, false, 'то же состояние — не изменение');
  assert.equal(fresh.settleOrderPayment(other.id, { status: 'paid', total: 5000 }).changed, true);
  assert.equal(fresh.getOrder(other.id).payment.status, 'paid');
  assert.equal(fresh.settleOrderPayment(other.id, { status: 'expired' }).changed, false, 'оплаченное не истекает');
  assert.equal(fresh.getOrder(other.id).payment.status, 'paid');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('вебхук оплаты сверяет token заказа до записи и отвечает 403', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const route = source.slice(source.indexOf("app.post('/api/pay/crocopay/callback'"), source.indexOf('/ОПЛАТА: CrocoPAY'));
  assert.ok(route.length > 200, 'маршрут вебхука не найден');
  // Подпись покрывает только суммы и время, но не заказ, поэтому одной её мало:
  // какой это заказ, решает token в адресе callback.
  assert.match(route, /timingSafeEqual/);
  assert.match(route, /CROCO\.verify\(secret, req\.body, req\.rawBody\)/);
  assert.match(route, /403/);
  assert.ok(route.indexOf('!tokenOk') < route.indexOf('db.settleOrderPayment'), 'проверка обязана идти до записи');
  // Меньше ожидаемого — не «оплачено». Больше бывает законно: при пересчёте по
  // курсу сумма приходит в валюте плательщика. Единицы вебхука неизвестны,
  // поэтому сверку делает CROCO.paidEnough, принимающий оба прочтения.
  assert.match(route, /CROCO\.paidEnough\(expected, raw\)/);
  assert.match(route, /check\.ok \? 'paid' : 'mismatch'/);
  // Уведомляем только на реальное изменение — вебхук повторяется.
  assert.match(route, /if \(result\.changed\)/);

  const start = source.slice(source.indexOf("app.post('/api/pay/crocopay/start'"), source.indexOf("app.get('/api/pay/crocopay/status'"));
  // Платить можно только за свой заказ: id лежит в подписанной cookie-сессии.
  assert.match(start, /ownOrder\(req, id\)/);
  assert.match(source, /function ownOrder[\s\S]*req\.session\.myOrders/);
  assert.match(start, /CROCO\.enabled\(s\)/, 'выключенная оплата не должна ходить в платёжку');
  // Способ проверяем по своему списку до запроса: чужое значение касса всё
  // равно отвергнет, а поймать это дешевле у себя.
  assert.ok(start.indexOf('PAY.isValid(method)') < start.indexOf('CROCO.createInvoice'));
  // Токен в callback_url — из записанного платежа, а не из локальной переменной:
  // startOrderPayment сохраняет прежний токен заказа.
  assert.match(start, /token=' \+ started\.payment\.token/);
  // Реквизиты записываем только после успешного ответа кассы.
  assert.ok(start.indexOf('CROCO.createInvoice') < start.indexOf('db.attachOrderInvoice'));

  // Опрос статуса — то, ради чего затевался H2H. Оплаченный заказ кассу не
  // тревожит, а уведомление уходит только на реальное изменение.
  const status = source.slice(source.indexOf("app.get('/api/pay/crocopay/status'"), source.indexOf("app.get('/pay/:id'"));
  assert.match(status, /ownOrder\(req, req\.query\.order\)/);
  assert.match(status, /pay\.status === 'paid'/);
  assert.match(status, /CROCO\.invoice\(s, pay\.invoiceId\)/);
  assert.match(status, /result\.changed.*notifyPayment/);
});

test('витрина уводит на свою страницу оплаты только после того, как заказ записан', () => {
  const js = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  const submit = js.slice(js.indexOf('function submitOrder'), js.length);
  // Сначала /api/order, и только на его ok — оплата. Иначе упавшая платёжка
  // теряла бы заявку целиком.
  assert.ok(submit.indexOf("fetch('/api/order'") < submit.indexOf('startPayment(d.id'));
  assert.match(submit, /if \(online && d\.id\) \{ startPayment/);
  // Способ оплаты выбирается уже на странице оплаты, поэтому оформление в
  // платёжку не ходит вовсе — оно только уводит на свою страницу.
  assert.match(js, /function startPayment\(orderId\) \{\s*location\.href = '\/pay\/'/);
  assert.doesNotMatch(js, /crocopay\.tech|client_secret|Client-Secret/);
  // Выбора «оплатить позже» нет: включённая оплата — всегда оплата сразу.
  assert.doesNotMatch(js, /co-pay|payMode|Оплатить после/);
  assert.match(js, /function submitLabel\(\) \{ return payOnline\(\) \? 'Перейти к оплате' : 'Оформить заказ'; \}/);
  // Идём ли на оплату, решает ответ сервера: только он знает пересчитанную
  // сумму и пределы кассы. Витринная догадка нужна лишь для подписи кнопки.
  assert.match(submit, /online = !!d\.pay;/);
});

test('сборка дороже потолка недоступна, а количество упирается в него же', () => {
  const CROCO = require('../lib/crocopay');
  const ss = { storeName: 'Тест', tagline: '', accentColor: '#0071e3', currency: '₽', currencyPosition: 'after' };
  const db = { reviewsForProduct: () => [], ratingFor: () => ({ avg: 0, count: 0 }), categories: () => [] };
  const base = { id: 'p1', name: 'Товар', category: 'К', inStock: true, images: [], colors: [], bands: [] };

  // Товар, у которого даже стартовая сборка дороже потолка, купить нельзя —
  // значит и на витрине он «Нет в наличии», а не кнопка, ведущая в отказ.
  const pricey = Object.assign({}, base, { price: CROCO.MAX_TOTAL + 10, storages: [], options: [] });
  assert.equal(render.sellable(pricey), false);
  assert.match(render.productPage(ss, db, pricey, null, { origin: '' }), /Нет в наличии/);
  const fine = Object.assign({}, base, { price: 100000, storages: [], options: [] });
  assert.equal(render.sellable(fine), true);

  // Конфигурация и значение группы, выводящие сборку за потолок, гаснут как
  // распроданные — с той же подписью, чтобы покупателю не пришлось гадать.
  const mac = Object.assign({}, base, {
    price: 200000,
    storages: [{ label: '1 ТБ', add: 0 }, { label: '8 ТБ', add: 100000 }],
    options: [{ name: 'Чип', values: [{ label: 'M5', add: 0 }, { label: 'M5 Max', add: 90000 }] }]
  });
  const html = render.productPage(ss, db, mac, null, { origin: '' });
  const btn = label => (html.match(new RegExp('<button[^>]*>(?:(?!</button>).)*' + label + '(?:(?!</button>).)*</button>', 's')) || [''])[0];
  assert.doesNotMatch(btn('1 ТБ'), /disabled/, 'базовая конфигурация доступна');
  assert.match(btn('8 ТБ'), /disabled/, '200 000 + 100 000 не влезает в потолок');
  assert.match(btn('8 ТБ'), /нет в наличии/);
  assert.doesNotMatch(btn('M5<'), /disabled/);
  assert.match(btn('M5 Max'), /disabled/, '200 000 + 90 000 не влезает');

  // Стартовая цена уходит на витрину: от неё скрипт считает потолок количества.
  assert.match(html, /data-start-price="200000"/);

  // Потолок количества считается от АКТУАЛЬНОЙ цены сборки, а не от базовой.
  const js = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  assert.match(js, /Math\.floor\(ORDER_MAX \/ unit\)/);
  assert.match(js, /markLimits\(total\);\s*\n\s*refreshQtyCap\(\);/, 'после смены варианта пересчитываются и варианты, и количество');
  // Корзина упирается в тот же потолок: «+» гаснет, а не даёт собрать заказ,
  // который потом не оформить.
  assert.match(js, /fits: function \(item\)/);
  assert.match(js, /i\.qty >= Cart\.fits\(i\) \? ' disabled/);
});

test('заказ вне пределов одной покупки не оформляется вовсе', () => {
  const CROCO = require('../lib/crocopay');
  assert.equal(CROCO.MIN_TOTAL, 1000);
  assert.equal(CROCO.MAX_TOTAL, 250000);
  assert.equal(CROCO.payable(1000), true);
  assert.equal(CROCO.payable(250000), true);
  assert.equal(CROCO.payable(999), false);
  assert.equal(CROCO.payable(250001), false);
  assert.equal(CROCO.payable('не число'), false);

  // Границы включительно, а текст отказа называет предел.
  assert.equal(CROCO.limitError(250000), '');
  assert.equal(CROCO.limitError(1000), '');
  assert.match(CROCO.limitError(250001), /не более 250\s000\s₽/);   // toLocaleString ставит неразрывный пробел
  assert.match(CROCO.limitError(999), /Минимальная сумма заказа — 1\s000\s₽/);

  // Пределы уходят на витрину от сервера и НЕ зависят от того, включена ли
  // онлайн-оплата: «один заказ — не больше 250 000 ₽» действует всегда. Они
  // нужны на каждой странице (корзина открывается везде), поэтому идут
  // глобальными, как валюта, а не атрибутом страницы оформления.
  const ss = { storeName: 'Тест', tagline: '', accentColor: '#0071e3', currency: '₽', currencyPosition: 'after' };
  for (const html of [render.checkoutPage(ss, { origin: '', payOnline: true }), render.checkoutPage(ss, { origin: '' })]) {
    assert.match(html, /window\.__ORDER_MIN__=1000/);
    assert.match(html, /window\.__ORDER_MAX__=250000/);
  }

  const js = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  assert.match(js, /window\.__ORDER_MAX__/, 'витрина читает пределы от сервера, а не хранит свои');
  assert.doesNotMatch(js, /250000/, 'числа пределов в скрипте не дублируются');
  // Кнопка гаснет, а причина стоит под ней: серая кнопка без объяснения
  // читается как поломка сайта.
  const render_ = js.slice(js.indexOf('var overLimit'), js.indexOf('var overLimit') + 700);
  assert.match(render_, /submit\.disabled = !canOrder \|\| !!overLimit/);
  assert.match(js, /Один заказ — не более/);
  // Считается предел по ИТОГУ с доставкой: платит покупатель именно его, и
  // касса проводит тоже его.
  assert.match(js, /var overLimit = totalLimitError\(orderTotal\(\)\)/);
  assert.match(js, /var limitError = totalLimitError\(orderTotal\(\)\)/);
  // Сервер проверяет сумму заново — клиентским данным не верим.
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.match(server, /const limit = CROCO\.limitError\(grandTotal\);[\s\S]{0,200}return res\.json\(\{ ok: false, error: limit \}, 400\)/);
  assert.match(server, /const grandTotal = total \+ ship\.price;/);
});

test('на оформлении нет «обсудим при подтверждении» и выбора платить позже', () => {
  const js = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  const ss = { storeName: 'Тест', tagline: '', accentColor: '#0071e3', currency: '₽', currencyPosition: 'after' };
  const html = render.checkoutPage(ss, { origin: '', payOnline: true });
  // Заказ оформляется с оплатой сразу, поэтому расплывчатых обещаний «уточним
  // потом» на странице не остаётся ни в разметке, ни в скрипте.
  for (const text of [js, html]) {
    assert.doesNotMatch(text, /обсудим при подтверждении/);
    assert.doesNotMatch(text, /уточнить при подтверждении/);
  }
  assert.doesNotMatch(html, /подтвердит наличие/);
  assert.match(html, /на следующем шаге откроется оплата/);
  // Оплата не настроена — прежний путь «заявка» обязан остаться: иначе кнопка
  // вела бы в платёжку, которой нет.
  const off = render.checkoutPage(ss, { origin: '' });
  assert.match(off, /менеджер свяжется с вами и подтвердит наличие/);
});

test('имя, фамилия, адрес и способ доставки обязательны', () => {
  const delivery = require('../lib/delivery');
  const js = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const route = server.slice(server.indexOf("app.post('/api/order'"), server.indexOf('/* ====================== ОПЛАТА'));

  // Сервер проверяет сам: клиентским данным не верим, как и в цене заказа.
  assert.match(route, /Укажите имя получателя/);
  assert.match(route, /Укажите фамилию получателя/);
  assert.match(route, /Укажите адрес или пункт выдачи/);
  assert.match(route, /DELIVERY\.isValid\(delivery\)/);
  assert.ok(route.indexOf('Выберите способ доставки') < route.indexOf('db.createOrder'), 'проверка обязана идти до записи');

  // Витрина отправляет ровно эти поля, а не прежнее одно customerName.
  assert.match(js, /firstName: val\('co-first-name'\)/);
  assert.match(js, /lastName: val\('co-last-name'\)/);
  assert.match(js, /delivery: deliveryChoice\(\)/);
  assert.doesNotMatch(js, /customerName:/);
  assert.match(js, /id="co-first-name"/);
  assert.match(js, /id="co-last-name"/);

  // Список способов доставки один: витрина берёт его от сервера, а не свой.
  const ss = { storeName: 'Тест', tagline: '', accentColor: '#0071e3', currency: '₽', currencyPosition: 'after' };
  const html = render.checkoutPage(ss, { origin: '', payOnline: true });
  assert.match(html, /data-delivery=/);
  for (const m of delivery.METHODS) assert.ok(html.includes(m.name), 'в разметке нет способа ' + m.name);
  // Свой список в скрипте разъехался бы с серверным, и покупатель выбрал бы то,
  // чего сервер потом не принимает. Названия в подсказке к адресу — не список.
  assert.match(js, /JSON\.parse\(page\.dataset\.delivery\)/);
  assert.doesNotMatch(js, /id:\s*'cdek'|id:\s*'ozon'/, 'способы не дублируются в скрипте');
  assert.deepEqual(delivery.METHODS.map(m => m.id), ['cdek', 'ozon']);
  assert.equal(delivery.isValid('cdek'), true);
  assert.equal(delivery.isValid('почта'), false);
  assert.equal(delivery.nameOf('ozon'), 'OZON');
  assert.equal(delivery.nameOf(''), '', 'заказ без доставки не даёт «undefined»');
});

test('зона доставки определяется по адресу, а улицы её не сбивают', () => {
  const Z = require('../lib/delivery-zones');

  assert.equal(Z.zoneFor('г Москва, ул Тверская, д 1'), 'msk');
  assert.equal(Z.zoneFor('Московская обл, г Химки, ул Ленина, д 5'), 'msk');
  assert.equal(Z.zoneFor('г Санкт-Петербург, Невский пр-кт, д 100'), 'szfo');
  assert.equal(Z.zoneFor('Респ Татарстан, г Казань, ул Баумана'), 'pfo');
  assert.equal(Z.zoneFor('г Краснодар, ул Красная, д 1'), 'yug');
  assert.equal(Z.zoneFor('Свердловская обл, г Екатеринбург, ул Малышева'), 'ural');
  assert.equal(Z.zoneFor('660000, Красноярск, пр Мира 10'), 'sfo');
  assert.equal(Z.zoneFor('г Владивосток, ул Светланская, д 1'), 'dfo');

  // Улица Кирова есть в каждом втором городе, а Ленинградский проспект — в
  // Москве: по одному только «самому длинному совпадению» такой заказ уезжал бы
  // в чужую зону. Слово после «ул»/«пр-кт» выбрасывается, а из оставшегося
  // побеждает самое раннее — регион и город стоят в адресе первыми.
  assert.equal(Z.zoneFor('г Москва, Ленинградский пр-кт, д 39'), 'msk');
  assert.equal(Z.zoneFor('Новосибирск, ул. Кирова, 27'), 'sfo');
  assert.equal(Z.zoneFor('ул Кирова 3, Омск'), 'sfo');
  assert.equal(Z.zoneFor('Чита, ул Кирова 5'), 'sfo');

  // Одноимённые города и области различаются целиком, а не по общей части.
  assert.equal(Z.zoneFor('г Нижний Новгород, ул Большая Покровская'), 'pfo');
  assert.equal(Z.zoneFor('Великий Новгород, ул Ленина'), 'szfo');
  assert.equal(Z.zoneFor('Ростов-на-Дону, пр Стачки 1'), 'yug');
  assert.equal(Z.zoneFor('Ярославская обл, г Ростов, ул Мира'), 'cfo');

  // Регион не опознан — не ошибка: покупатель мог написать «ПВЗ у метро».
  // Тогда действует средний тариф по стране, а не самый дешёвый.
  assert.equal(Z.zoneFor('ПВЗ у метро'), 'ru');
  assert.equal(Z.zoneFor(''), 'ru');
  assert.equal(Z.zoneFor(null), 'ru');
  assert.equal(Z.isValidZone('msk'), true);
  assert.equal(Z.isValidZone('европа'), false);
});

test('сетка тарифов полная, курьер дороже ПВЗ, а итог с доставкой круглый', () => {
  const Z = require('../lib/delivery-zones');
  const SHIP = require('../lib/delivery-price');
  const DELIVERY = require('../lib/delivery');
  const CROCO = require('../lib/crocopay');

  // Сетка обязана быть полной: пропущенная клетка — это заказ, который нельзя
  // оформить, потому что доставку не посчитать.
  for (const m of DELIVERY.METHODS) {
    for (const mode of m.modes) {
      for (const z of Z.ZONES) {
        assert.ok(SHIP.rate(m.id, mode.id, z.id) > 0, `нет тарифа: ${m.id}/${mode.id}/${z.id}`);
      }
    }
    for (const z of Z.ZONES) {
      assert.ok(SHIP.rate(m.id, 'courier', z.id) > SHIP.rate(m.id, 'pvz', z.id),
        `курьер обязан быть дороже пункта выдачи: ${m.id}/${z.id}`);
    }
    // Отправка из Москвы: чем дальше, тем дороже.
    assert.ok(SHIP.rate(m.id, 'pvz', 'dfo') > SHIP.rate(m.id, 'pvz', 'msk'));
    // Зона «регион не опознан» не должна быть самой дешёвой — недобор оплатит магазин.
    assert.ok(SHIP.rate(m.id, 'pvz', 'ru') > SHIP.rate(m.id, 'pvz', 'msk'));
  }
  // Неизвестный способ, вариант или зона — ноль, а не выдуманная цена.
  assert.equal(SHIP.rate('почта', 'pvz', 'msk'), 0);
  assert.equal(SHIP.rate('cdek', 'дрон', 'msk'), 0);
  assert.equal(SHIP.rate('cdek', 'pvz', 'европа'), 0);

  const addresses = ['г Москва, ул Тверская', 'Екатеринбург', 'г Владивосток', 'ПВЗ у метро'];
  for (const address of addresses) {
    for (const goods of [1990, 7990, 23250, 67990, 99990, 189990, 249000]) {
      const all = SHIP.quoteAll(address, goods);
      for (const m of DELIVERY.METHODS) {
        for (const mode of m.modes) {
          const q = SHIP.quote(m.id, mode.id, address, goods);
          // Витрина и заказ считают ОДНИМ И ТЕМ ЖЕ: quote — это срез quoteAll,
          // иначе показанная цена разошлась бы с той, что уйдёт в заказ.
          assert.equal(q.price, all.prices[m.id][mode.id], 'quote и quoteAll обязаны совпадать');
          assert.ok(q.price > 0);
          // До сотен итог округляется всегда — окно шире 100 ₽ при любом тарифе.
          assert.equal((goods + q.price) % 100, 0, `итог не круглый: ${goods} + ${q.price}`);
          // Округление вверх не выводит заказ за потолок одной покупки: такую
          // сумму касса не проведёт.
          assert.ok(goods + q.price <= CROCO.MAX_TOTAL);
          // Цена держится около тарифа, а не улетает ради круглого числа.
          assert.ok(Math.abs(q.price - q.base) <= Math.max(150, q.base * 0.3),
            `цена ушла от тарифа: ${q.price} против ${q.base}`);
        }
        // После подгонки курьер тоже обязан остаться дороже: рядом в одном ряду
        // «курьером дешевле» читалось бы как ошибка витрины.
        assert.ok(all.prices[m.id].courier > all.prices[m.id].pvz,
          `подгонка сломала порядок: ${m.id} на ${goods} по адресу «${address}»`);
      }
    }
  }

  // Круглая тысяча — когда попадает: 67 990 + 1 010 = 69 000.
  assert.equal(SHIP.quote('cdek', 'courier', 'г Владивосток', 67990).price, 1010);
  assert.equal(SHIP.quote('cdek', 'courier', 'г Владивосток', 67990).total, 69000);
  // Пустая корзина — чистый тариф, подгонять нечего.
  assert.equal(SHIP.quote('cdek', 'pvz', 'г Москва', 0).price, SHIP.rate('cdek', 'pvz', 'msk'));
  // Неизвестный вариант — отказ, а не «доставка бесплатно».
  assert.equal(SHIP.quote('cdek', 'дрон', 'г Москва', 67990).ok, false);
  assert.equal(SHIP.quote('cdek', 'дрон', 'г Москва', 67990).price, 0);
});

test('куда доставить — обязательный выбор, а его цена входит в итог заказа', () => {
  const DELIVERY = require('../lib/delivery');
  const js = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'styles.css'), 'utf8');
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const route = server.slice(server.indexOf("app.post('/api/order'"), server.indexOf('/* ====================== ОПЛАТА'));

  // Варианты есть у каждого перевозчика, и id у них общие: заказ хранит их
  // навсегда, а название правится свободно.
  for (const m of DELIVERY.METHODS) {
    // Пункт выдачи стоит первым: он дешевле, а витрина выбирает заранее первый.
    assert.deepEqual(m.modes.map(x => x.id), ['pvz', 'courier'], 'варианты доставки: ' + m.id);
  }
  assert.equal(DELIVERY.isValidMode('cdek', 'courier'), true);
  assert.equal(DELIVERY.isValidMode('cdek', 'дрон'), false);
  assert.equal(DELIVERY.isValidMode('почта', 'pvz'), false);
  // Названия у перевозчиков свои: у OZON пункт выдачи бывает и постаматом.
  assert.equal(DELIVERY.findMode('ozon', 'pvz').name, 'В пункт выдачи или постамат');
  assert.equal(DELIVERY.shortModeOf('ozon', 'courier'), 'курьером');
  assert.equal(DELIVERY.shortModeOf('', ''), '', 'прежний заказ без варианта не даёт «undefined»');

  // Сервер проверяет вариант сам и до записи заказа.
  assert.match(route, /DELIVERY\.isValidMode\(delivery, deliveryMode\)/);
  assert.ok(route.indexOf('Выберите, куда доставить') < route.indexOf('db.createOrder'), 'проверка обязана идти до записи');
  // Цена доставки считается на сервере заново — клиентской цифре верим не больше,
  // чем клиентской цене товара.
  assert.match(route, /SHIP\.quote\(delivery, deliveryMode, address, total\)/);
  assert.match(route, /total: grandTotal, itemsTotal: total/);
  assert.doesNotMatch(route, /req\.body\.deliveryPrice/, 'цену доставки витрина не присылает');

  // Витрина отправляет вариант и берёт список от сервера, а не держит свой.
  assert.match(js, /deliveryMode: deliveryModeChoice\(\)/);
  assert.match(js, /\(m && m\.modes\) \|\| \[\]/);
  assert.doesNotMatch(js, /id:\s*'pvz'|id:\s*'courier'/, 'варианты не дублируются в скрипте');
  // Своей сетки тарифов у витрины нет: цену считает сервер тем же модулем, что
  // и заказ. Числа тарифов в скрипте — это уже расхождение.
  assert.doesNotMatch(js, /RATES|delivery-price/);
  assert.match(js, /fetch\('\/api\/delivery\/quote'/);
  // Ответ несёт цены всех вариантов сразу, поэтому переключение способа не ходит
  // на сервер, а цена стоит у каждой карточки — до выбора, а не после.
  assert.match(server, /app\.post\('\/api\/delivery\/quote'/);
  assert.match(server, /SHIP\.quoteAll\(address/);
  assert.match(js, /shipPrice\(deliveryChoice\(\), m\.id\)/);
  assert.match(js, /class="co-mode-price"/);
  assert.match(css, /\.co-mode-price\{[^}]*tabular-nums/);
  assert.match(css, /\.co-modes-row\{display:grid/);
  // Вопрос «куда доставить» подписан: на телефоне обе группы встают в один
  // столбик, и без подписи это читается как список из четырёх перевозчиков.
  assert.match(js, /class="co-modes-label">Куда доставить/);
  assert.match(css, /\.co-modes-label\{/);

  // В сводке доставка стоит отдельной строкой, а итог считается вместе с ней.
  const rail = js.slice(js.indexOf('function renderRail'), js.indexOf('function renderRail') + 1400);
  assert.match(rail, /Доставка/);
  assert.match(rail, /money\(orderTotal\(\)\)/);
  // Пока адреса нет, цену не выдумываем и «бесплатно» не обещаем.
  assert.match(rail, /price == null \? '<i class="co-line-wait">по адресу/);

  // Разметка страницы несёт варианты вместе со способом — одним списком.
  const ss = { storeName: 'Тест', tagline: '', accentColor: '#0071e3', currency: '₽', currencyPosition: 'after' };
  const html = render.checkoutPage(ss, { origin: '', payOnline: true });
  for (const m of DELIVERY.METHODS) for (const mode of m.modes) {
    assert.ok(html.includes(mode.name), `в разметке нет варианта ${m.id}/${mode.id}`);
  }
  // Сетка тарифов наружу не выходит: на витрине только цены посчитанного заказа.
  const SHIP = require('../lib/delivery-price');
  assert.doesNotMatch(html, new RegExp('data-delivery="[^"]*' + SHIP.RATES.cdek.pvz.dfo));
});

test('адрес обязан быть полным: населённый пункт, улица и дом', () => {
  const ADDRESS = require('../lib/address');

  // Полные адреса — в обоих видах: как их отдаёт DaData и как набирают руками.
  for (const good of [
    'г Москва, ул Тверская, д 1',
    'Свердловская обл, г Екатеринбург, ул Малышева, д 5',
    'Екатеринбург, ул Малышева, 5',
    'г Санкт-Петербург, Невский пр-кт, д 100, кв 12',
    'Московская обл, г Химки, Ленинградская ул, 1к2',
    'с Верхние Луки, ул Мира, 5',
    '620000, г Екатеринбург, ул Малышева, д 5',
    'г Владивосток, ул Светланская, д 12/3'
  ]) assert.equal(ADDRESS.checkAddress(good).ok, true, 'отвергнут полный адрес: ' + good);

  // Город без «г» засчитываем по таблице зон: так пишут чаще всего, и требовать
  // сокращение — придирка. Три части через запятую заменяют слово «ул»:
  // «Екатеринбург, Малышева, 5» — это город, улица и дом.
  assert.equal(ADDRESS.checkAddress('Екатеринбург, Малышева, 5').ok, true);

  // Чего не хватает — сказано словами: покупателю надо знать, что дописать.
  assert.match(ADDRESS.checkAddress('Екатеринбург').error, /улицы и номера дома/);
  assert.match(ADDRESS.checkAddress('Москва, ул Тверская').error, /номера дома/);
  assert.match(ADDRESS.checkAddress('ул Малышева, 5').error, /населённого пункта/);
  assert.match(ADDRESS.checkAddress('ПВЗ у метро').error, /населённого пункта, улицы и номера дома/);
  assert.equal(ADDRESS.checkAddress('').error, 'Укажите адрес или пункт выдачи');
  // Индекс — это не дом: шесть цифр подряд номером дома не считаются.
  assert.equal(ADDRESS.checkAddress('620000').ok, false);
  for (const bad of ['Екатеринбург', 'Москва, ул Тверская', 'ул Малышева, 5', 'Свердловская область', '']) {
    assert.equal(ADDRESS.checkAddress(bad).ok, false, 'принят неполный адрес: ' + bad);
  }
  // В отказе есть образец — иначе непонятно, чего от тебя хотят.
  assert.match(ADDRESS.checkAddress('Екатеринбург').error, /Например: г Екатеринбург, ул Малышева, д 5/);

  // Проверка одна на всех: сервер не принимает неполный адрес, а витрина берёт
  // тот же разбор от `/api/delivery/quote` и своей копии правил не держит.
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const js = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  const route = server.slice(server.indexOf("app.post('/api/order'"), server.indexOf('/* ====================== ОПЛАТА'));
  assert.match(route, /ADDRESS\.checkAddress\(address\)/);
  assert.ok(route.indexOf('checkAddress') < route.indexOf('db.createOrder'), 'проверка обязана идти до записи');
  assert.match(server, /app\.post\('\/api\/delivery\/quote'[\s\S]{0,900}ADDRESS\.checkAddress\(address\)/);
  assert.doesNotMatch(js, /населённого пункта|checkAddress/, 'разбор адреса не дублируется в скрипте');
  assert.match(js, /ship\.error/);

  // Словарь маркеров общий с разбором зоны: разъехавшись, они пропускали бы
  // адрес, который потом уезжает в другую зону.
  const Z = require('../lib/delivery-zones');
  assert.ok(Z.STREET_MARKERS.includes('ул') && Z.HOUSE_MARKERS.includes('д'));
  for (const w of Z.STREET_MARKERS.concat(Z.HOUSE_MARKERS)) assert.ok(Z.MARKERS.has(w), 'маркер потерян: ' + w);
});

test('способ доставки заперт, пока адрес не полон, и стоит ПОСЛЕ адреса', () => {
  const js = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'styles.css'), 'utf8');
  const form = js.slice(js.indexOf("<span class=\"co-step\" aria-hidden=\"true\">3</span>Доставка"), js.indexOf('co-submit'));

  // Адрес первым, способ доставки за ним: цена зависит от региона, и до адреса
  // у карточек нечего показать, кроме прочерка.
  assert.ok(form.indexOf('co-address') < form.indexOf('co-ways'), 'адрес обязан идти выше способа доставки');
  assert.ok(form.indexOf('co-ways') < form.indexOf('co-modes'), 'варианты — внутри блока способов');
  // Блок собирается запертым: до ответа сервера адрес заведомо не проверен.
  assert.match(form, /class="co-ways is-locked" id="co-ways"/);
  assert.match(form, /id="co-ways-note"/);

  // Запирание — это `disabled` у радио, а не спрятанные карточки: покупатель
  // видит, чем повезут, ещё до того как впишет улицу, а выбранное значение
  // остаётся выбранным и после разблокировки.
  const lock = js.slice(js.indexOf('function setWaysLocked'), js.indexOf('function setWaysLocked') + 500);
  assert.match(lock, /inputs\[i\]\.disabled = !!locked/);
  assert.match(lock, /classList\.toggle\('is-locked'/);
  assert.match(css, /\.co-ways\.is-locked\{opacity/);
  assert.match(css, /\.field-note-warn\{color:#b42318\}/);
  // Специфичность у `.field-note` и `.field-note-warn` одинаковая — значит
  // решает порядок, и предупреждение обязано стоять ниже. Уже ломалось: подпись
  // оставалась серой, хотя класс проставлялся.
  assert.ok(css.indexOf('.field-note{') < css.indexOf('.field-note-warn{'), 'предупреждение обязано идти после .field-note');

  // Отпирает ответ сервера, а не собственная догадка витрины.
  assert.match(js, /setWaysLocked\(!ship\.valid\)/);
  assert.match(js, /ship\.valid = !!d\.valid/);
  // Разбор устаревает: показывать «не хватает дома» про адрес, который уже
  // дописали, нельзя — поэтому ответ помнит строку, к которой относится.
  assert.match(js, /ship\.address === addressValue\(\)/);
  assert.match(js, /ship\.address = address;/);
  // На отправке решаем только по свежему разбору — иначе дописанный в последний
  // момент адрес отвергался бы по прошлому ответу.
  assert.match(js, /ship\.address === val\('co-address'\) && !ship\.valid && ship\.error/);
});

test('вариант, цена и зона доставки хранятся в заказе, а старые заявки читаются как были', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'order-ship-'));
  const fresh = freshDb(dir);
  const order = fresh.createOrder({
    items: [], itemsTotal: 67990, total: 68700, contact: 'tg', firstName: 'Иван', lastName: 'Петров',
    delivery: 'ozon', deliveryMode: 'courier', deliveryPrice: 710, deliveryZone: 'dfo', address: 'г Владивосток'
  });
  assert.equal(order.deliveryMode, 'courier');
  assert.equal(order.deliveryPrice, 710);
  assert.equal(order.deliveryZone, 'dfo');
  // total — то, что платит покупатель; itemsTotal — только товары.
  assert.equal(order.total, 68700);
  assert.equal(order.itemsTotal, 67990);

  // Чужие значения в заказ не попадают.
  const junk = fresh.createOrder({ items: [], total: 1000, contact: 'tg', delivery: 'cdek', deliveryMode: 'дрон', deliveryZone: 'европа' });
  assert.equal(junk.deliveryMode, '');
  assert.equal(junk.deliveryZone, '');
  assert.equal(junk.deliveryPrice, 0);
  // Вариант без способа тоже пустой: `pvz` без перевозчика ничего не значит.
  assert.equal(fresh.createOrder({ items: [], total: 1000, contact: 'tg', deliveryMode: 'pvz' }).deliveryMode, '');
  // Прежняя заявка: доставки нет вовсе, а суммы совпадают.
  const old = fresh.createOrder({ items: [], total: 4500, contact: 'tg' });
  assert.equal(old.deliveryPrice, 0);
  assert.equal(old.itemsTotal, 4500);

  // В панелях видно, куда и почём: без цены итог не сходится с суммой позиций.
  const line = render.orderClient(order, { money: { currency: '₽' } });
  // money() ставит перед валютой неразрывный пробел, поэтому сверяем через \s.
  assert.match(line, /OZON, курьером · 710\s₽ · г Владивосток/);
  // У прежней заявки строка остаётся прежней — ни «undefined», ни «0 ₽».
  const oldLine = render.orderClient({ delivery: 'cdek', address: 'Москва' }, { money: { currency: '₽' } });
  assert.match(oldLine, /СДЭК · Москва/);
  assert.doesNotMatch(oldLine, /undefined|0 ₽/);
});

test('имя с фамилией собираются в customerName, а старые заказы читаются как были', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'order-name-'));
  const fresh = freshDb(dir);
  const order = fresh.createOrder({ items: [], total: 100, contact: 'tg', firstName: 'Иван', lastName: 'Петров', delivery: 'cdek', address: 'Москва' });
  assert.equal(order.firstName, 'Иван');
  assert.equal(order.lastName, 'Петров');
  // Панели и Telegram рисуются по customerName — она обязана собраться сама.
  assert.equal(order.customerName, 'Иван Петров');
  assert.equal(order.delivery, 'cdek');
  // Чужой способ доставки в заказ не попадает.
  assert.equal(fresh.createOrder({ items: [], total: 1, contact: 'tg', delivery: 'своя-почта' }).delivery, '');
  assert.equal(fresh.createOrder({ items: [], total: 1, contact: 'tg' }).delivery, '');
  // Прежний заказ без раздельных полей: customerName остаётся как есть.
  const old = fresh.createOrder({ items: [], total: 1, contact: 'tg', customerName: 'Старый Клиент' });
  assert.equal(old.customerName, 'Старый Клиент');
  assert.equal(old.firstName, '');

  // В панелях видно способ доставки, а комментарий старых заявок — по-прежнему.
  const list = [order, { id: 'o9', number: 'ORD-9', createdAt: Date.now(), status: 'new', contact: 'tg', total: 1, items: [], comment: 'позвоните вечером' }];
  const db = { getOrders: () => list, visibleOrders: () => list, ordersForSite: () => list, getSites: () => [], pendingReviewCount: () => 0 };
  for (const html of [ownerViews.ordersList(db, null, 1), siteViews.ordersList(db, dbCore.defaultSite(), null, 1)]) {
    assert.match(html, /СДЭК/);
    assert.match(html, /Иван Петров/);
    assert.match(html, /позвоните вечером/);
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

test('страница оплаты показывает реквизиты, пока счёт действует', () => {
  const ss = { storeName: 'Тест', tagline: '', accentColor: '#0071e3', currency: '₽', currencyPosition: 'after' };
  const pay = require('../lib/pay-methods');
  const order = { id: 'ord1', number: '482913', total: 71990, items: [], contact: 'tg' };
  const methods = pay.allowed(['SBP', 'TO_CARD']);
  const live = {
    status: 'pending', method: 'TO_CARD', invoiceId: '911c2823-f55b-43b5-9881-d5653107f7dc',
    requisite: '4276 1234 5678 9012', bank: 'Сбербанк', owner: 'IVAN PETROV', expiresAt: Date.now() + 900000
  };

  const html = render.payPage(ss, Object.assign({}, order, { payment: live }), { methods, origin: '' });
  assert.match(html, /4276 1234 5678 9012/);
  assert.match(html, /Номер карты/);
  assert.match(html, /Сбербанк/);
  assert.match(html, /id="pay-timer"/);
  assert.match(html, /noindex/, 'страница оплаты в индексе не нужна');
  assert.match(html, /pay\.js/, 'без скрипта не будет ни отсчёта, ни опроса статуса');
  // Реквизиты чужие и с апострофами — экранирование обязательно.
  const evil = render.payPage(ss, Object.assign({}, order, {
    payment: Object.assign({}, live, { owner: '"><img src=x onerror=alert(1)>' })
  }), { methods, origin: '' });
  assert.doesNotMatch(evil, /<img src=x/);

  // Истёкший счёт реквизиты не показывает: они уже чужие.
  const stale = render.payPage(ss, Object.assign({}, order, {
    payment: Object.assign({}, live, { expiresAt: Date.now() - 1000 })
  }), { methods, origin: '' });
  assert.doesNotMatch(stale, /4276 1234 5678 9012/);
  assert.match(stale, /name="pay-method"/, 'вместо мёртвых реквизитов — выбор способа заново');

  // «Выбрать другой способ»: выбор поверх ещё действующего счёта.
  const choose = render.payPage(ss, Object.assign({}, order, { payment: live }), { methods, origin: '', choose: true });
  assert.match(choose, /name="pay-method"/);
  assert.doesNotMatch(choose, /4276 1234 5678 9012/);

  // Оплата ещё не начиналась — только выбор способа.
  const fresh = render.payPage(ss, order, { methods, origin: '' });
  assert.match(fresh, /name="pay-method"/);
  assert.match(fresh, /id="pay-create"/);
  // Способов нет вовсе — не оставляем покупателя перед пустым блоком.
  const none = render.payPage(ss, order, { methods: [], origin: '' });
  assert.doesNotMatch(none, /id="pay-create"/);
  assert.match(none, /менеджер свяжется/);
});

test('оплаченным заказ на странице называется только по ответу кассы', () => {
  const ss = { storeName: 'Тест', tagline: '', accentColor: '#0071e3', currency: '₽', currencyPosition: 'after' };
  const order = { id: 'ord1', number: '482913', total: 71990, items: [], contact: 'tg' };
  const paid = render.payPage(ss, Object.assign({}, order, { payment: { status: 'paid' } }), { origin: '' });
  assert.match(paid, /Платёж получен/);
  assert.match(paid, /№482913/);
  assert.doesNotMatch(paid, /name="pay-method"/, 'оплаченному заказу счёт больше не выставляем');

  // Расхождение по сумме успехом не выглядит: его смотрит человек.
  const bad = render.payPage(ss, Object.assign({}, order, { payment: { status: 'mismatch' } }), { origin: '' });
  assert.match(bad, /order-success order-success-neutral/);
  assert.doesNotMatch(bad, /Платёж получен/);
  const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'styles.css'), 'utf8');
  assert.match(css, /\.order-success-neutral \.order-success-check/);

  // Истёкший и отменённый счёт объясняются словами, а не пустым выбором.
  for (const [state, text] of [['expired', /Срок действия/], ['cancelled', /отменён/], ['failed', /не прош/]]) {
    const html = render.payPage(ss, Object.assign({}, order, { payment: { status: state } }),
      { origin: '', methods: require('../lib/pay-methods').METHODS });
    assert.match(html, text);
    assert.match(html, /id="pay-create"/);
  }
});

test('состояние оплаты видно в обеих панелях и не путается со статусом заказа', () => {
  const paid = { id: 'o1', number: 'ORD-1', createdAt: Date.now(), status: 'new', contact: 'tg', total: 100, items: [], payment: { status: 'paid', note: '' } };
  const bad = Object.assign({}, paid, { payment: { status: 'mismatch', note: 'Пришло 100, ожидали 10000' } });
  assert.match(render.orderStatus(paid), /pay-ok/);
  assert.match(render.orderStatus(bad), /pay-warn/);
  assert.match(render.orderStatus(bad), /ожидали 10000/);
  assert.match(render.orderStatus({ payment: { status: 'pending' } }), /pay-wait/);
  // Состояния, которых в схеме Express не было вовсе: касса отдаёт настоящий
  // статус счёта, и «истёк» больше не выглядит как «ждём оплату».
  assert.match(render.orderStatus({ payment: { status: 'expired' } }), /pay-off/);
  assert.match(render.orderStatus({ payment: { status: 'cancelled' } }), /pay-off/);
  assert.match(render.orderStatus({ payment: { status: 'failed' } }), /pay-warn/);
  // Способ оплаты — свой столбец, а не приписка к состоянию: «сколько», «чем» и
  // «дошло ли» — разные вопросы, и в одной ячейке они читались как одно целое.
  assert.match(render.orderPayMethod({ payment: { status: 'paid', method: 'SBP' } }), /СБП/);
  assert.doesNotMatch(render.orderStatus({ payment: { status: 'paid', method: 'SBP' } }), /СБП/);
  // Заказ без оплаты (и любой прежний) даёт прочерк, а не пустую ячейку.
  for (const empty of [{ payment: null }, {}, { payment: { status: 'выдумка' } }]) {
    assert.match(render.orderStatus(empty), /—/);
    assert.match(render.orderPayMethod(empty), /—/);
  }

  const db = {
    getOrders: () => [paid, bad], visibleOrders: () => [paid, bad], ordersForSite: () => [paid, bad], getSites: () => [], pendingReviewCount: () => 0
  };
  const ownerHtml = ownerViews.ordersList(db, null, 1);
  const siteHtml = siteViews.ordersList(db, dbCore.defaultSite(), null, 1);
  for (const html of [ownerHtml, siteHtml]) {
    assert.match(html, /pay-ok/);
    assert.match(html, /pay-warn/);
    // Ручной статус заказа с панелей убран: рядом с настоящим состоянием оплаты
    // от кассы он только путал — заказ бывает и «новым», и уже оплаченным.
    assert.doesNotMatch(html, /option value="new"|name="status"/);
  }
  const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'styles.css'), 'utf8');
  assert.match(css, /\.pay-tag\.pay-ok/);
  assert.match(css, /\.pay-tag\.pay-warn/);
  assert.match(css, /\.pay-tag\.pay-off/);
});

test('счёт создаётся в минимальных единицах, а ответ кассы разбирается целиком', async () => {
  const croco = require('../lib/crocopay');
  const on = { crocopayEnabled: true, crocopayClientId: 'id', crocopayClientSecret: 'secret' };
  const real = global.fetch;
  let sent = null;
  const stub = reply => { global.fetch = async (url, opts) => { sent = { url, opts }; return reply; }; };
  const json = obj => ({ ok: true, status: 200, json: async () => obj });
  try {
    // Без ключей в платёжку не ходим вовсе.
    global.fetch = async () => { throw new Error('в сеть ходить нельзя'); };
    assert.deepEqual(await croco.createInvoice({}, { amount: 100, method: 'SBP' }), { ok: false, error: 'not_configured' });
    assert.equal((await croco.createInvoice(on, { amount: 0, method: 'SBP' })).error, 'bad_amount');
    assert.equal((await croco.createInvoice(on, { amount: 100, method: '' })).error, 'bad_method');
    assert.equal(sent, null, 'ни одного запроса на кривых входных данных');

    // Формат — тот, что РЕАЛЬНО отдаёт касса (проверено на боевой 17.08.2026):
    // вложенный response.transaction + paymentRequisites, camelCase, сумма
    // строкой в рублях. В документации показан плоский snake_case — он ниже.
    stub(json({ message: 'Data successfully received', response: {
      transaction: {
        id: '911c2823-f55b-43b5-9881-d5653107f7dc', status: 'Pending',
        currency: 'RUB', amount: '67990.00000000', expiredAt: '2026-01-15T12:30:00Z'
      },
      paymentRequisites: {
        paymentOption: 'TO_CARD_TRANSGRAN', paymentMethod: 'Сбербанк',
        card: '4276 1234 5678 9012', cardOwner: 'IVAN PETROV'
      }
    } }));
    const ok = await croco.createInvoice(on, { amount: 67990, method: 'TO_CARD', callbackUrl: 'https://shop/cb?order=1&token=t' });
    assert.equal(ok.ok, true);
    assert.equal(ok.invoice.requisite, '4276 1234 5678 9012');
    assert.equal(ok.invoice.owner, 'IVAN PETROV');
    assert.equal(ok.invoice.state, 'pending');
    assert.equal(ok.invoice.expiresAt, Date.parse('2026-01-15T12:30:00Z'));
    // Касса вправе подменить способ — записываем возвращённый, иначе подпись
    // реквизита будет от другого способа.
    assert.equal(ok.invoice.method, 'TO_CARD_TRANSGRAN');
    // Сумма уходит в ОСНОВНЫХ единицах. Документация обещает копейки и врёт:
    // с копейками счёт вышел бы в сто раз больше заказа.
    const body = JSON.parse(sent.opts.body);
    assert.equal(body.amount, 67990);
    assert.equal(body.currency, 'RUB');
    assert.equal(body.payment_option, 'TO_CARD');
    assert.equal(body.callback_url, 'https://shop/cb?order=1&token=t');
    // Ключи кассы идут заголовками, а не в теле.
    assert.equal(sent.opts.headers['Client-Secret'], 'secret');
    assert.match(sent.url, /\/api\/v2\/h2h\/invoices$/);

    // Касса вернула другую сумму — реквизиты показывать нельзя: покупатель
    // переведёт не столько, и платёж не сойдётся.
    stub(json({ response: { transaction: { id: '911c2823-f55b-43b5-9881-d5653107f7dc', status: 'Pending', amount: '6799000.00' },
      paymentRequisites: { card: '4276 1234 5678 9012' } } }));
    assert.equal((await croco.createInvoice(on, { amount: 67990, method: 'TO_CARD' })).error, 'amount_mismatch');

    // Счёт без реквизитов бесполезен: показывать покупателю нечего.
    stub(json({ response: { transaction: { id: '911c2823-f55b-43b5-9881-d5653107f7dc', status: 'Pending' }, paymentRequisites: { paymentMethod: 'Сбербанк' } } }));
    assert.equal((await croco.createInvoice(on, { amount: 1, method: 'SBP' })).error, 'no_requisite');

    // Ошибки кассы: и с полем status, и просто кодом ответа.
    stub({ ok: false, status: 422, json: async () => ({ status: 'error', message: 'payment_option TO_CARD is not enabled for currency UZS' }) });
    assert.match((await croco.createInvoice(on, { amount: 1, method: 'TO_CARD' })).error, /not enabled/);
    stub({ ok: false, status: 500, json: async () => { throw new Error('не json'); } });
    assert.equal((await croco.createInvoice(on, { amount: 1, method: 'SBP' })).error, 'http_500');

    // Статус счёта — ради него всё и затевалось. У GET своя форма ответа:
    // transaction лежит в корне, без обёртки response (проверено на боевой).
    stub(json({ message: 'Data successfully received', transaction: {
      id: '911c2823-f55b-43b5-9881-d5653107f7dc', status: 'Success', currency: 'RUB', amount: '67990.00000000'
    } }));
    const st = await croco.invoice(on, '911c2823-f55b-43b5-9881-d5653107f7dc');
    assert.equal(st.invoice.state, 'paid');
    assert.equal(st.invoice.amount, 67990);
    assert.match(sent.url, /\/invoices\/911c2823-f55b-43b5-9881-d5653107f7dc$/);
    // Чужая строка в путь запроса не уходит.
    sent = null;
    assert.equal((await croco.invoice(on, '../merchants')).error, 'bad_invoice_id');
    assert.equal(sent, null);

    // Способы: берём только рублёвые, ответ кэшируется. Формат — тот, что
    // РЕАЛЬНО отдаёт касса: группы по валюте с вложенными options. В
    // документации показан другой, плоский, — его тоже понимаем (ниже).
    croco.forgetMethods();
    stub(json({ message: 'Data successfully received', payment_methods: [
      { id: 6, code: 'RUB', name: 'Россия', options: [
        { code: 'TO_CARD', name: 'Visa/Mastercard' }, { code: 'SBP', name: 'СБП' },
        { code: 'TO_CARD_TRANSGRAN', name: 'Card (Cross-border)' }
      ] },
      { id: 7, code: 'UZS', name: 'Узбекистан', options: [{ code: 'UZCARD', name: 'UzCard' }] }
    ] }));
    const live = await croco.availableOptions(on);
    assert.deepEqual(live.options, ['TO_CARD', 'SBP', 'TO_CARD_TRANSGRAN'], 'живой формат кассы');
    sent = null;
    const cached = await croco.availableOptions(on);
    assert.equal(cached.cached, true);
    assert.equal(sent, null, 'повторный запрос уходит не чаще раза в пять минут');

    // Формат из документации — плоский список. Разъехаться они могут в любую
    // сторону, поэтому оба разбираются одним проходом.
    croco.forgetMethods();
    stub(json({ methods: [
      { currency: 'RUB', payment_option: 'SBP' }, { currency: 'RUB', payment_option: 'TO_CARD' },
      { currency: 'UZS', payment_option: 'TO_CARD' }, { currency: 'RUB', payment_option: 'SBP' }
    ] }));
    assert.deepEqual((await croco.availableOptions(on)).options, ['SBP', 'TO_CARD'], 'формат документации');
    croco.forgetMethods();

    // Реквизиты могут прийти вложенными и под другими именами: на эндпоинте
    // способов документация уже разошлась с кассой, поэтому счёт разбирается
    // терпимо.
    stub(json({ message: 'ok', invoice: {
      invoice_id: '911c2823-f55b-43b5-9881-d5653107f7dc', state: 'Pending',
      account: '+7 900 123-45-67', bank: 'Т-Банк', receiver: 'IVAN PETROV', expire_at: '2026-01-15T12:30:00Z'
    } }));
    const alt = await croco.createInvoice(on, { amount: 1, method: 'SBP' });
    assert.equal(alt.ok, true, 'счёт с другими именами полей всё равно разбирается');
    assert.equal(alt.invoice.requisite, '+7 900 123-45-67');
    assert.equal(alt.invoice.bank, 'Т-Банк');
    assert.equal(alt.invoice.state, 'pending');
  } finally {
    if (real) global.fetch = real; else delete global.fetch;
  }
});

test('в настройках владельца есть касса, а ключи не утекают в разметку витрины', () => {
  const settings = Object.assign(dbCore.defaultSettings(), {
    crocopayEnabled: true, crocopayClientId: 'ID-КАССЫ', crocopayClientSecret: ''
  });
  const db = { pendingReviewCount: () => 0 };
  const html = ownerViews.settingsPage(settings, db, null);
  assert.match(html, /name="crocopayEnabled"[^>]*checked/);
  assert.match(html, /name="crocopayClientId"/);
  assert.match(html, /name="crocopayClientSecret"/);
  // Валюта всегда рублёвая — выбора в форме быть не должно.
  assert.doesNotMatch(html, /name="crocopayCurrency"/);
  // Включено без ключей — на витрине оплаты нет, и владелец обязан это увидеть.
  assert.match(html, /Оплата включена, но ключи кассы не заданы/);
  const full = ownerViews.settingsPage(Object.assign({}, settings, { crocopayClientSecret: 'СЕКРЕТ' }), db, null);
  assert.doesNotMatch(full, /Оплата включена, но ключи кассы не заданы/);

  // Маршрут сохранения: галочка снимается отсутствием поля, а кэш способов
  // сбрасывается — он собран под ключи прежней кассы.
  const source = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const route = source.slice(source.indexOf("app.post('/owner/settings'"), source.indexOf('/* =========================== АДМИНКА САЙТА'));
  assert.match(route, /patch\.crocopayEnabled = req\.body\.crocopayEnabled !== undefined/);
  assert.match(route, /CROCO\.forgetMethods\(\)/);
});

test('оформление разложено на три блока, а сумма липнет отдельно от формы', () => {
  const ss = { storeName: 'Тест', tagline: '', accentColor: '#0071e3', currency: '₽', currencyPosition: 'after' };
  const html = render.checkoutPage(ss, { origin: '', payOnline: true });
  const js = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'styles.css'), 'utf8');

  // Три контейнера, а не «список слева, форма справа»: форме нужна широкая
  // колонка, иначе она снова окажется в узкой полосе рядом с пустым местом.
  assert.match(html, /id="checkout-items"/);
  assert.match(html, /id="checkout-form"/);
  assert.match(html, /class="checkout-rail"[\s\S]*id="checkout-side"/);
  // Доводы в правой панели — из общего TRUST_BLOCK, в своём варианте: три
  // колонки, глиф над текстом. Столбиком они забирали 110 px высоты панели.
  assert.match(html, /class="trust trust-col"/);
  assert.match(css, /\.trust-col\{grid-template-columns:repeat\(3,minmax\(0,1fr\)\)/);
  assert.match(css, /\.trust-col \.trust-item\{flex-direction:column/);
  // Ниже 800 px общий блок доверия переставляет разделители сверху — в узкой
  // панели строка остаётся строкой, и вертикальную линию нужно вернуть явно.
  assert.match(css, /\.trust-col \.trust-item\+\.trust-item\{border-left:1px solid/);

  // Раскладка через именованные области: только так сумма встаёт МЕЖДУ товарами
  // и формой на телефоне, оставаясь справа на десктопе.
  assert.match(css, /grid-template-areas:"items rail" "form rail"/);
  assert.match(css, /grid-template-areas:"items" "rail" "form"/);
  assert.match(css, /\.checkout-rail\{grid-area:rail;position:sticky/);
  // Пустая корзина: ни формы, ни суммы, ни обещания шагов.
  assert.match(css, /\.checkout-page\.is-empty #checkout-form,\.checkout-page\.is-empty \.checkout-rail\{display:none\}/);

  // Форма собирается один раз — иначе смена количества стирала бы введённое.
  assert.match(js, /if \(form && !form\.dataset\.ready\)/);
  assert.match(js, /form\.dataset\.ready = '1'/);
  // В правой панели только деньги: полей формы там быть не должно.
  const rail = js.slice(js.indexOf('function renderRail'), js.indexOf('function renderRail') + 900);
  assert.doesNotMatch(rail, /co-first-name|co-last-name|co-contact|co-address|checkout-submit/);
  assert.match(rail, /Cart\.availableCount\(\)/, 'число товаров обязано совпадать с суммой рядом');
  // Смена перевозчика обновляет варианты доставки (у них своя цена), сумму
  // справа, кнопку с итогом и подсказку под адресом.
  const sync = js.slice(js.indexOf('function syncDelivery'), js.indexOf('function syncDelivery') + 260);
  assert.match(sync, /renderModes\(\)/);
  assert.match(sync, /renderRail\(\)/);
  assert.match(sync, /syncSubmit\(\)/);
  assert.match(sync, /syncAddressNote\(\)/);
  assert.match(sync, /setWaysLocked\(!ship\.valid\)/);
});

test('логотип перевозчика инлайнится спрайтом, а без файла остаётся текст', () => {
  const logos = require('../lib/delivery-logos');
  const ss = { storeName: 'Тест', tagline: '', accentColor: '#0071e3', currency: '₽', currencyPosition: 'after' };
  const js = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'styles.css'), 'utf8');

  // Файлы приходят снаружи (их скачивают с брендбука), а инлайн чужого SVG в
  // HTML исполняет всё, что внутри.
  const dirty = '<svg viewBox="0 0 10 10"><script>alert(1)</script>'
    + '<rect onload="alert(2)" fill="url(#a)"/>'
    + '<image href="https://example.com/t.png"/>'
    + '<foreignObject><b>x</b></foreignObject></svg>';
  const clean = logos.sanitize(dirty);
  assert.doesNotMatch(clean, /<script/i);
  assert.doesNotMatch(clean, /onload/i);
  assert.doesNotMatch(clean, /example\.com/);
  assert.doesNotMatch(clean, /foreignObject/i);
  assert.match(clean, /url\(#a\)/, 'внутренние ссылки логотипа обязаны остаться');

  // В брендбуках служебные id — сплошь «a». Без приставки второй логотип на
  // странице красился бы градиентом первого.
  const one = logos.namespaceIds('<linearGradient id="a"/><rect fill="url(#a)"/><use href="#a"/>', 'dl-cdek');
  assert.match(one, /id="dl-cdek-a"/);
  assert.match(one, /url\(#dl-cdek-a\)/);
  assert.match(one, /href="#dl-cdek-a"/);
  assert.doesNotMatch(one, /url\(#a\)/);

  // Витрина получает viewBox логотипа списком способов — по нему <use>
  // масштабируется, а высоту задаёт CSS.
  const html = render.checkoutPage(ss, { origin: '', payOnline: true });
  assert.match(html, /logoBox/);
  assert.match(js, /m\.logoBox/);
  assert.match(js, /<use href="#dl-/);
  // Логотипа нет — название текстом, раскладка та же.
  assert.match(js, /: '<b>' \+ escapeHtml\(m\.name\) \+ '<\/b>'/);
  for (const m of require('../lib/delivery').METHODS) {
    if (!logos.has(m.id)) assert.ok(html.includes(m.name), 'без логотипа обязано остаться название ' + m.name);
  }
  // Имя перевозчика обязано быть скрытым ТЕКСТОМ рядом с логотипом: aria-label на
  // инлайновом SVG читалки поддерживают через раз, а имя — единственное, что
  // отличает варианты друг от друга. Сам логотип при этом декоративный.
  assert.match(js, /aria-hidden="true"/);
  assert.match(js, /<span class="sr-only">' \+ escapeHtml\(m\.name\)/);
  assert.doesNotMatch(js, /co-choice-logo[^']*role="img"/, 'на accname у SVG не полагаемся');

  // Установленные логотипы: спрайт собран, оба знака на месте, чужого кода внутри
  // нет. Проверки условные — файлы можно и убрать, тогда останется текст.
  const installed = logos.names();
  if (installed.length) {
    const sprite = logos.sprite();
    for (const id of installed) {
      assert.match(sprite, new RegExp('<symbol id="dl-' + id + '" viewBox="'), 'нет символа ' + id);
      assert.ok(logos.viewBox(id), 'у ' + id + ' обязан быть viewBox');
    }
    assert.doesNotMatch(sprite, /<script|\son[a-z]+=/i);
    assert.doesNotMatch(sprite, /https?:\/\/(?!www\.w3\.org)/);
    assert.ok(sprite.length < 12 * 1024, 'спрайт уезжает в каждую страницу оформления — он обязан быть маленьким');
  }
  // Высота фиксирована, ширина по пропорции: вордмарки разной длины, подгонять
  // их под общую ширину значило бы искажать.
  assert.match(css, /\.co-choice-logo\{display:block;height:19px;width:auto/);
  assert.match(css, /\.co-choice-mark\{display:flex;align-items:center;min-height:20px\}/);
  // Спрайта нет, пока нет ни одного файла — лишнего узла в разметке не будет.
  if (!logos.names().length) assert.equal(logos.sprite(), '');
});
