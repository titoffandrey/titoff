'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { Readable } = require('stream');

const auth = require('../lib/auth');
const deals = require('../lib/discount');
const dbCore = require('../lib/db');
const render = require('../lib/render');
const adminViews = require('../lib/admin-views');
const analyticsView = require('../lib/analytics-view');
const variants = require('../lib/variants');
const search = require('../lib/search');
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

// Настройки магазина для панели и витрины: панель красится акцентным цветом и
// подписывает деньги валютой, поэтому фейку без них верить нельзя.
const SETTINGS = { storeName: 'Магазин', tagline: 'Слоган', accentColor: '#1d1d1f', currency: '₽', currencyPosition: 'after', adminUsername: 'admin' };

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

// То же самое для базы пунктов выдачи: lib/pickup берёт путь у lib/db, поэтому
// подменять надо обоих разом, иначе пункты искались бы в рабочем каталоге.
function freshPickup(dir) {
  const keys = [require.resolve('../lib/db'), require.resolve('../lib/pickup')];
  const previous = process.env.STORE_DATA_DIR;
  process.env.STORE_DATA_DIR = dir;
  for (const k of keys) delete require.cache[k];
  const fresh = require('../lib/pickup');
  for (const k of keys) delete require.cache[k];
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

test('утилита безопасно сбрасывает пароль панели во внешнем хранилище', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'store-password-reset-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const script = path.join(__dirname, '..', 'scripts', 'reset-admin-password.js');
  execFileSync(process.execPath, [script], {
    input: 'новый-надёжный-пароль', encoding: 'utf8',
    env: Object.assign({}, process.env, { STORE_DATA_DIR: dir, ADMIN_USERNAME: 'new-admin' })
  });
  const stored = JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8'));
  assert.equal(stored.adminUsername, 'new-admin');
  assert.equal(auth.verifyPassword('новый-надёжный-пароль', stored.adminPasswordHash), true);
});

test('повторяющиеся глифы карточки лежат в спрайте, а не копируются в каждую', () => {
  const settings = dbCore.getSettings();
  const html = render.homePage(settings, dbCore, { origin: 'https://shop.example' });
  const cards = (html.match(/class="card-name"/g) || []).length;
  assert.ok(cards > 10, 'на главной должно быть много карточек, иначе проверка бессмысленна');

  // Символ объявлен ровно один раз, а карточки на него ссылаются.
  for (const glyph of ['rt-star', 'rt-bubble', 'rt-cart']) {
    const declared = (html.match(new RegExp('<symbol id="g-' + glyph + '"', 'g')) || []).length;
    assert.equal(declared, 1, glyph + ': символ объявлен не один раз');
    const used = (html.match(new RegExp('href="#g-' + glyph + '"', 'g')) || []).length;
    assert.ok(used > 10, glyph + ': ссылок меньше, чем карточек — глиф снова копируется');
  }
  // Сама фигура в разметке встречается один раз — в спрайте. Копия в карточке
  // и была теми 37 КБ, ради которых спрайт заводился.
  const star = 'M8 2.4 9.56 6.16';
  assert.equal(html.split(star).length - 1, 1, 'контур звезды скопирован в карточки');
});

test('карточка товара для поисковика полна, а крошки идут отдельным блоком', () => {
  const settings = dbCore.getSettings();
  const product = dbCore.visibleProducts()[0];
  const html = render.productPage(settings, dbCore, product, { origin: 'https://shop.example' });
  const blocks = (html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g) || [])
    .map(s => JSON.parse(s.replace(/^<script[^>]*>/, '').replace(/<\/script>$/, '')));
  assert.equal(blocks.length, 2, 'ожидались карточка товара и хлебные крошки');

  const card = blocks.find(b => b['@type'] === 'Product');
  assert.ok(card, 'нет блока Product');
  // От этих полей зависит, покажет ли выдача цену, наличие и звёзды.
  assert.equal(card.brand.name, 'Apple');
  assert.equal(card.offers.itemCondition, 'https://schema.org/NewCondition');
  assert.ok(/^\d{4}-\d{2}-\d{2}$/.test(card.offers.priceValidUntil), 'нет срока действия цены');
  assert.ok(new Date(card.offers.priceValidUntil) > new Date(), 'срок действия цены уже истёк');
  // Цена — та же, что видит покупатель, открыв страницу.
  assert.equal(card.offers.price, render.startPrice(product, settings));

  const crumbs = blocks.find(b => b['@type'] === 'BreadcrumbList');
  assert.ok(crumbs, 'нет блока BreadcrumbList');
  assert.deepEqual(crumbs.itemListElement.map(x => x.position), [1, 2, 3]);
  assert.equal(crumbs.itemListElement[crumbs.itemListElement.length - 1].name, product.name);
  // Крошки обязаны вести туда же, куда ссылки над названием на самой странице.
  assert.ok(html.includes('/?category=' + encodeURIComponent(product.category)));
});

test('комментарии снимаются с отдаваемой статики и ничего не ломают', () => {
  const minify = require('../lib/minify');
  const vmMod = require('vm');
  const dir = path.join(__dirname, '..', 'public');

  // Ловушки, на которых наивная замена регуляркой ломает код. Проверяем их
  // отдельно от файлов: в файле такую строку легко не заметить.
  const traps = [
    ['ссылка внутри строки', 'var u = "https://x.ru/a"; // хвост', 'var u = "https://x.ru/a";'],
    ['звёздочка в строке', 'var s = "/* не комментарий */"; /* а это да */', 'var s = "/* не комментарий */";'],
    ['регулярка после return', 'function f(s){ return /^\\s+/.test(s); } // да', 'function f(s){ return /^\\s+/.test(s); }'],
    ['слэши внутри регулярки', 'var re = /https?:\\/\\//; // хвост', 'var re = /https?:\\/\\//;'],
    ['деление, а не регулярка', 'var x = (a + b) / 2 / c; // хвост', 'var x = (a + b) / 2 / c;'],
    ['шаблон с ссылкой', 'var t = `see https://x.ru/${id}`; // хвост', 'var t = `see https://x.ru/${id}`;']
  ];
  for (const [why, src, want] of traps) {
    assert.equal(minify.js(src).trim(), want, why);
  }

  // CSS: `/*` внутри строки — не начало комментария.
  assert.equal(minify.css('a::after{content:"/*"}/* убрать */').trim(), 'a::after{content:"/*"}');

  // И весь боевой набор: очищенный файл обязан разбираться, а литералы —
  // совпасть с исходными. Иначе `js()` вернул бы исходник, и чистки не будет.
  let cleaned = 0;
  for (const file of fs.readdirSync(dir).filter(f => /\.(js|css)$/.test(f))) {
    const src = fs.readFileSync(path.join(dir, file), 'utf8');
    const out = file.endsWith('.css') ? minify.css(src) : minify.js(src);
    assert.ok(out.length < src.length, file + ': комментарии не снялись — разборщик отказался');
    if (file.endsWith('.js')) assert.doesNotThrow(() => new vmMod.Script(out), file + ' не разбирается после чистки');
    cleaned++;
  }
  assert.ok(cleaned >= 12, 'проверены не все файлы статики');

  // phone.js работает и на сервере, поэтому его поведение сверяем целиком.
  const load = code => { const m = { exports: {} }; new vmMod.Script('(function(module,exports){' + code + '\n})').runInThisContext()(m, m.exports); return m.exports; };
  const raw = fs.readFileSync(path.join(dir, 'phone.js'), 'utf8');
  const before = load(raw);
  const after = load(minify.js(raw));
  for (const value of ['+79991234567', '8 (999) 123-45-67', '+375291234567', 'мусор', '']) {
    assert.deepEqual(after.check(value), before.check(value), 'phone.js разошёлся на ' + JSON.stringify(value));
  }
});

test('поиск разбирает запрос на слова и знает русские названия техники', () => {
  // На боевом каталоге, а не на выдуманных товарах: правила подбирались под
  // реальные названия, и проверять их надо тем же списком.
  const list = catalog.products;
  const names = q => search.filter(list, q).map(p => p.name);

  // Слова запроса складываются по И, а не ищутся одной подстрокой. Между
  // «MacBook Air» и «(M5)» в названии стоит `13"`, и прежний поиск давал ноль.
  assert.deepEqual(names('macbook air m5').sort(), ['MacBook Air 13" (M5)', 'MacBook Air 15" (M5)']);
  // ИЛИ здесь не годится: одна семнадцатка не должна тянуть iPad mini (A17 Pro).
  assert.ok(!names('iphone 17').some(n => n.includes('iPad')));

  // Русский магазин — русские слова. Ноль карточек по «айфон» при четырнадцати
  // айфонах в каталоге и был той самой потерянной покупкой.
  assert.equal(names('айфон').length, 14);
  assert.equal(names('макбук').length, 5);
  assert.deepEqual(names('колонка').sort(), ['HomePod (2-е поколение)', 'HomePod mini']);
  assert.equal(names('часы').length, 7);
  assert.deepEqual(names('эйртег'), ['AirTag']);
  // Множественное число и именительный падеж — то, что набирают на самом деле.
  // Одной основы «наушник» в таблице мало: сравнение идёт в обратную сторону.
  assert.ok(names('наушники').length >= 6);
  assert.ok(names('планшеты').length >= 6);

  // Категория в подбор слов не входит: `HomePod` лежит в разделе «Apple TV и
  // Дом», и по правилу для приставки колонка получала бы слово «приставка».
  assert.deepEqual(names('приставка'), ['Apple TV 4K']);

  // Слитно набирают не реже, чем через пробел.
  assert.ok(names('iphone17').every(n => n.includes('17')));
  assert.ok(names('airpodspro').length >= 2);

  // Пустой запрос ничего не отбирает, бессмысленный — не находит.
  assert.equal(search.filter(list, '   ').length, list.length);
  assert.deepEqual(names('zzzнеттакого'), []);

  // Строка поиска считается один раз на товар: ключ — ссылка на объект.
  const one = list[0];
  assert.equal(search.haystack(one), search.haystack(one));
});

test('скидка — один процент на все сборки, а старая цена из него выводится', () => {
  // Скидка задаётся процентом, и зачёркнутая цена считается от ЛЮБОЙ суммы
  // сборки. Поэтому «−13%» одинаковы и у базовой сборки, и у старшей — раньше
  // зачёркивалась «старая цена базы + те же доплаты», и процент таял.
  const p = { price: 66990, discountPercent: 13 };
  assert.equal(deals.discountPct(p), 13);
  assert.equal(deals.effectivePrice(p), 66990);
  const back = (sum) => Math.round((1 - sum / deals.compareFor(sum, 13)) * 100);
  for (const add of [0, 11500, 25000, 120000]) assert.equal(back(66990 + add), 13, 'процент не зависит от доплат');
  // Округление старой цены до десятки: без него она выходит с копейками.
  assert.equal(deals.compareFor(66990, 13) % 10, 0);
  // Скидки нет — зачёркивать нечего.
  assert.equal(deals.comparePrice({ price: 100 }), 0);
  assert.equal(deals.compareFor(100, 0), 0);
  assert.equal(deals.compareFor(100, 95), 0, 'больше 90% — опечатка, а не скидка');

  // Старые данные знают только пару цен: процент выводится из неё, иначе
  // витрина потеряла бы скидку у товара, который ещё не пересохраняли.
  assert.equal(deals.discountPct({ price: 1000, oldPrice: 1200 }), 17);
  assert.equal(deals.discountPct({ price: 1000, oldPrice: 900 }), 0);

  // Перенос со старой модели: цена становится той, по которой товар РЕАЛЬНО
  // продавался, — иначе снятие «горящей акции» молча подняло бы ценник.
  assert.deepEqual(deals.fromLegacy({ price: 100, oldPrice: 120 }), { price: 100, percent: 17 });
  assert.deepEqual(deals.fromLegacy({ price: 100, hotDeal: true, hotDealPrice: 80 }), { price: 80, percent: 20 });
  assert.deepEqual(deals.fromLegacy({ price: 100, hotDeal: true, hotDealPrice: 120 }), { price: 100, percent: 0 });
  assert.deepEqual(deals.fromLegacy({ price: 100, hotDeal: true, hotDealPrice: 80, hotDealUntil: 1 }), { price: 100, percent: 0 });
  // Перенос идемпотентен: у уже переведённого товара он ничего не меняет.
  // Без этого повторный прогон «не находил» старой цены и обнулял скидку.
  assert.deepEqual(deals.fromLegacy({ price: 80, discountPercent: 20 }), { price: 80, percent: 20 });
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
  app.post('/admin/login', (req, res) => res.json({ ok: true }));

  const res = response();
  await app.handle(request('/admin/login', {
    method: 'POST', body: Buffer.from('{}'), remoteAddress: '10.0.0.2',
    headers: { host: 'shop.test', origin: 'null', 'content-type': 'application/json' }
  }), res);

  assert.equal(res.statusCode, 200);
});

test('явный cross-site Origin не проходит даже на форме входа', async () => {
  const app = new App({ secret: 'test', forceHttps: true });
  let calls = 0;
  app.post('/admin/login', (req, res) => { calls++; res.json({ ok: true }); });

  const res = response();
  await app.handle(request('/admin/login', {
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
  app.get('/authorize', (req, res) => { req.session.admin = 'signed-admin-stamp'; res.json({ ok: true }); });
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

test('загруженный файл кэшируется навсегда, а обычная статика — нет', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'store-upload-cache-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'photo.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
  const app = new App({ secret: 'test' });
  app.static('/uploads', dir);
  app.static('/static', dir);

  // Имя загруженного файла случайное и другому содержимому уже не достанется,
  // поэтому неделя кэша означала лишь то, что постоянный покупатель раз в
  // неделю заново качает весь каталог снимков.
  const upload = response();
  await app.handle(request('/uploads/photo.svg'), upload);
  assert.equal(upload.headers['cache-control'], 'public, max-age=31536000, immutable');

  // Файл из public/ без метки версии так помечать нельзя: он правится на месте.
  const asset = response();
  await app.handle(request('/static/photo.svg'), asset);
  assert.equal(asset.headers['cache-control'], 'public, max-age=604800');
});

test('карточка каталога берёт уменьшенную копию снимка, а без неё — исходник', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'store-card-photos-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const product = {
    id: 'iphone', name: 'iPhone 17', category: 'iPhone', price: 90000,
    images: ['abc.webp'], inStock: true
  };
  const db = {
    UPLOAD_DIR: dir,
    getProducts: () => [product], visibleProducts: () => [product],
    categories: () => ['iPhone'], visibleCategories: () => ['iPhone'],
    ratingFor: () => ({ avg: 0, count: 0 }), reviewsForProduct: () => []
  };
  const settings = { storeName: 'iStore', currency: '₽' };

  // Копий рядом нет — карточка показывает исходник, ровно как до всего этого.
  fs.writeFileSync(path.join(dir, 'abc.webp'), 'x');
  const plain = render.homePage(settings, db, {});
  assert.match(plain, /src="\/uploads\/abc\.webp"/);
  assert.doesNotMatch(plain, /srcset=/, 'srcset обещает копии, которых нет на диске');

  // Копии появились — карточка отдаёт их, и по умолчанию берёт 640.
  for (const size of images.CARD_SIZES) fs.writeFileSync(path.join(dir, images.cardName('abc.webp', size)), 'x');
  const small = render.homePage(settings, db, {});
  assert.match(small, /src="\/uploads\/abc-c640\.webp"/);
  assert.match(small, /srcset="\/uploads\/abc-c320\.webp 320w, \/uploads\/abc-c480\.webp 480w, \/uploads\/abc-c640\.webp 640w"/);
  assert.doesNotMatch(small, /\/uploads\/abc\.webp/, 'полноразмерный снимок остался в карточке');

  // Без sizes браузер берёт из srcset самый крупный вариант, и вся экономия
  // пропадает: разметка обязана назвать ширину снимка в раскладке.
  assert.match(small, /sizes="\(min-width:1248px\) 276px[^"]*46vw"/);

  // Страница товара остаётся на полном снимке: там кадр и правда крупный.
  const page = render.productPage(settings, db, product, {});
  assert.match(page, /src="\/uploads\/abc\.webp"/);

  // Имена производных считаются от исходника, а копия копии не делается.
  assert.deepEqual(images.derivedNames('abc.webp'), ['abc-c320.webp', 'abc-c480.webp', 'abc-c640.webp']);
  assert.deepEqual(images.derivedNames('abc-c320.webp'), []);
  assert.ok(images.isDerived('abc-c640.webp') && images.isDerived('abc-t.webp'));
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
  const db = { getProducts: () => [], visibleProducts: () => [], categories: () => [], visibleCategories: () => [], ratingFor: () => ({ avg: 0, count: 0 }) };
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

  analytics.recordPageView({ id, path: '/product/test?q=secret', host: 'shop.test', referrer: 'https://google.com/search?q=x', context: { ip: '8.8.8.8', device: phone.device, model: phone.model, os: phone.os, browser: phone.browser, screen: '1179×2556', utmSource: 'telegram', utmCampaign: 'summer' } });
  analytics.findVisitor(id).lastSeen = Date.now() - 60000;
  analytics.heartbeat({ id, path: '/product/test', context: {} });
  analytics.markOrder(id, { id: 'order1', number: 'ORD-0001', createdAt: Date.now() });
  analytics.recordPageView({ id: 'b'.repeat(32), path: '/', requestedPath: '/', context: { isBot: true, botName: 'Googlebot' } });
  analytics.recordPageView({ id: 'c'.repeat(32), path: '/404', requestedPath: '/wp-admin.php', is404: true, context: {} });
  analytics.recordPageView({ id: 'd'.repeat(32), path: '/', provisional: true, context: { device: 'Компьютер', browser: 'Chrome 150', os: 'Windows 10/11' } });
  analytics.findVisitor('d'.repeat(32)).lastSeen = Date.now() - 3 * 60 * 1000;
  const report = analytics.snapshot({ days: 7 });
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
    id: 'e'.repeat(32), path: '/',
    context: { device: 'Компьютер', browser: 'Тест', os: 'Тест', utmCampaign: '__proto__' }
  });
  const report = analytics.snapshot({ days: 1 });
  assert.deepEqual(report.campaigns, [{ label: '__proto__', value: 1 }]);
});

test('раздел метрики защищён панелью и показывает понятные показатели', () => {
  const fakeDb = { getProducts: () => [{ id: 'p1', name: 'iPhone' }], pendingReviewCount: () => 0 };
  const snapshot = {
    generatedAt: Date.now(), days: 7, online: 1, unique: 12, visits: 15,
    pageViews: 42, orders: 2, conversion: 16.7,
    daily: [{ date: '2026-07-27', visits: 2, pageViews: 5, orders: 1, visitors: 2 }],
    pages: [{ label: '/product/p1', value: 5 }], sources: [{ label: 'Прямой заход', value: 5 }],
    devices: [{ label: 'Телефон', value: 5 }], browsers: [{ label: 'Safari 18', value: 5 }],
    systems: [{ label: 'iOS 18', value: 5 }], locations: [{ label: 'Москва', value: 3 }],
    campaigns: [{ label: 'telegram · summer', value: 2 }],
    visitors: [{
      id: 'a'.repeat(32), lastSeen: Date.now() - 6e5, ip: '1.2.3.4', isp: 'Тест',
      city: 'Москва', country: 'Россия', countryCode: 'RU', device: 'Телефон', os: 'iOS 18',
      browser: 'Safari 18', lastPage: '/product/p1', entryPage: '/', visits: 2, pageViews: 5,
      activeSeconds: 120, orderCount: 0
    }],
    bots: { hits: 70, notFound: 68, agents: [{ label: 'Неизвестный сканер / 404', value: 68 }], paths: [{ label: '/wp-admin', value: 20 }] }
  };
  const html = adminViews.analyticsPage(SETTINGS, fakeDb, snapshot);
  assert.match(html, /Метрика/);
  assert.match(html, /Онлайн сейчас/);
  assert.match(html, /Популярные страницы/);
  assert.match(html, /iPhone/);
  assert.doesNotMatch(html, /Все домены/, 'выбора домена больше нет');
  assert.match(html, /Среднее время/);
  assert.match(html, /UTM-кампании/);
  assert.match(html, /Операционные системы/);
  // Кнопки «Обновить» и подписи «Обновлено 16:36» здесь больше нет: страница
  // обновляется сама, и кнопка предлагала бы сделать руками уже сделанное.
  assert.doesNotMatch(html, /Обновить|location\.reload/, 'обновление метрики руками снято');
  assert.doesNotMatch(html, /Обновлено \d/, 'время последнего обновления всегда «только что»');
  assert.match(html, /data-live="analytics/, 'раздел метрики обязан обновляться сам');
  assert.match(html, /admin-live\.js/);
  assert.match(html, /Боты и технические запросы/);
  assert.match(html, /не влияют на основную метрику/);

  /* Плашка состояния канала. Подпись «online» вместо «живого»: рядом с зелёной
     пульсирующей точкой это привычная отметка «на связи».
     ОБА слова лежат в разметке, показывает нужное CSS по классу `is-off` —
     писать текст из скрипта нельзя по тому же правилу, по которому отсчёт срока
     счёта берёт «истёк» из `data-over`. */
  assert.match(html, /<span class="a-live" title="[^"]+" data-title-off="[^"]+"><i><\/i><b class="a-live-on">online<\/b><b class="a-live-off">нет связи<\/b><\/span>/);
  assert.doesNotMatch(html, /<b>живое<\/b>/);

  const live = fs.readFileSync(path.join(__dirname, '..', 'public', 'admin-live.js'), 'utf8');
  /* Скрипт подписи НЕ пишет — только переключает класс и берёт заголовок из
     data-атрибута. Своя копия слов разошлась бы с разметкой молча.
     Смотрим на КОД без комментариев (той же чисткой, что идёт на отдаче): сами
     слова в пояснениях рядом с правилом — это документация, а не разметка. */
  const liveCode = require('../lib/minify').js(live);
  assert.doesNotMatch(liveCode, /нет связи|online/, 'подписи плашки живут в разметке, а не в скрипте');
  assert.match(live, /es\.onerror\s*=\s*stale/, 'разрыв канала обязан доходить до плашки');
  assert.match(live, /es\.onopen\s*=\s*fresh/);
  /* Плашка целиком принадлежит браузеру: сервер рисует её всегда подключённой,
     и без защиты первая же удачная подмена стирала бы «нет связи» — отметка
     возвращалась бы через несколько секунд, то есть мигала на ровном месте. */
  assert.match(live, /el\.classList\.contains\('a-live'\)/);

  /* «Кто заходил» на телефоне — карточки: пять столбцов требуют 900 px, и
     список приходилось листать вбок, теряя из виду время визита. Ячейки для
     этого названы — безымянные <td> сетке не адресовать. */
  const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'styles.css'), 'utf8');
  for (const cls of ['mv-when', 'mv-place', 'mv-tech', 'mv-page', 'mv-order']) {
    assert.match(html, new RegExp(`<td class="${cls}"`), cls + ' должен быть в строке посетителя');
  }
  const mobile = css.slice(css.indexOf('@media(max-width:800px){'));
  assert.match(mobile, /\.a-table\.metric-table\{min-width:0;display:block\}/);
  assert.match(mobile, /\.metric-table tr\{display:grid/);
  /* Пятая плитка сводки раздаётся на обе колонки: пяти плиток в две колонки
     последняя оставалась половинкой рядом с полосой пустоты. Правило обязано
     обойти карточку посетителя — там плиток шесть и ряды делятся ровно. */
  assert.match(mobile, /\.metric-summary:not\(\.visitor-summary\) \.metric-card:last-child\{grid-column:1\/-1/);
  /* Пустая строка растягивается КЛАССОМ самой ячейки, а не `tr:has(...)`:
     `:has()` поддерживают не все версии Safari, доходящие до панели, — то же
     правило, что у выбора способа оплаты на витрине. */
  assert.match(mobile, /\.metric-table \.metric-empty\{grid-column:1\/-1\}/);

  /* Оборванная связь видна и без чтения подписи: точка гаснет и ПЕРЕСТАЁТ
     дышать. Пульсация и есть то, что читается как «канал работает прямо
     сейчас», — оставить её при мёртвом канале значило бы соврать ровно тем
     единственным, ради чего плашка висит в шапке. */
  assert.match(css, /\.a-live-off\{display:none\}/);
  assert.match(css, /\.a-live\.is-off \.a-live-on\{display:none\}/);
  assert.match(css, /\.a-live\.is-off \.a-live-off\{display:inline\}/);
  assert.match(css, /\.a-live\.is-off i\{[^}]*animation:none/);
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
    visitors: [{ id: 'e'.repeat(32), lastSeen: Date.now(), visits: 50, pageViews: 100 }],
    daily: { old: { date: '2026-07-27', visits: 50, pageViews: 100 } },
    geoCache: {}, geoUsage: { date: '', count: 0 }
  }));
  const analytics = new Analytics({ dataDir: dir, geoEnabled: false, flushMs: 600000 });
  const report = analytics.snapshot({ days: 1 });
  assert.equal(analytics.data.version, 3);
  assert.equal(report.unique, 0);
  assert.equal(report.pageViews, 0);
});

test('суточные сводки прежних доменов складываются, а не пропадают', t => {
  // До переезда сводки лежали под ключом «домен|дата». Домен теперь один, и
  // строки за одну дату надо сложить: иначе метрика за прошлые дни исчезнет из
  // отчёта, хотя на диске она цела.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'store-analytics-single-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const today = require('../lib/analytics').dayKey(Date.now());
  fs.writeFileSync(path.join(dir, 'analytics.json'), JSON.stringify({
    version: 2,
    visitors: [
      { id: 'a'.repeat(32), siteId: 'one', lastSeen: Date.now(), clientConfirmed: true, visits: 2, pageViews: 3 },
      { id: 'b'.repeat(32), siteId: 'two', lastSeen: Date.now(), clientConfirmed: true, visits: 1, pageViews: 1 }
    ],
    daily: {
      ['one|' + today]: { siteId: 'one', date: today, visitors: ['a'.repeat(32)], orderVisitors: [], visits: 2, pageViews: 3, orders: 1, activeSeconds: 30, pages: { '/': 3 }, sources: {}, devices: {}, browsers: {}, systems: {}, campaigns: {} },
      ['two|' + today]: { siteId: 'two', date: today, visitors: ['b'.repeat(32)], orderVisitors: [], visits: 1, pageViews: 1, orders: 0, activeSeconds: 10, pages: { '/': 1, '/checkout': 1 }, sources: {}, devices: {}, browsers: {}, systems: {}, campaigns: {} }
    },
    botDaily: {
      ['one|' + today]: { siteId: 'one', date: today, hits: 5, notFound: 2, agents: { 'Googlebot': 5 }, paths: {} },
      ['two|' + today]: { siteId: 'two', date: today, hits: 3, notFound: 1, agents: { 'Googlebot': 3 }, paths: {} }
    },
    geoCache: {}, geoUsage: { date: '', count: 0 }
  }));
  const analytics = new Analytics({ dataDir: dir, geoEnabled: false, flushMs: 600000 });
  assert.equal(analytics.data.version, 3);
  assert.deepEqual(Object.keys(analytics.data.daily), [today], 'ключ теперь дата, а не «домен|дата»');
  assert.equal(analytics.data.visitors.every(v => v.siteId === undefined), true);

  const report = analytics.snapshot({ days: 1 });
  assert.equal(report.visits, 3);
  assert.equal(report.pageViews, 4);
  assert.equal(report.orders, 1);
  assert.equal(report.unique, 2, 'посетители обоих доменов теперь одни');
  assert.equal(report.activeSeconds, 40);
  assert.deepEqual(report.pages.find(x => x.label === '/'), { label: '/', value: 4 });
  assert.equal(report.bots.hits, 8);
  assert.equal(report.bots.notFound, 3);
  assert.deepEqual(report.bots.agents, [{ label: 'Googlebot', value: 8 }]);
});

test('хронология посетителя пишется просмотрами, а время идёт открытой странице', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'store-visitor-hits-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const analytics = new Analytics({ dataDir: dir, geoEnabled: false, flushMs: 600000 });
  const id = 'a'.repeat(32);
  analytics.recordPageView({ id, path: '/', context: { ip: '8.8.8.8', device: 'Телефон', os: 'iOS 26.0' } });
  analytics.recordPageView({ id, path: '/product/p1', context: {} });
  const v = analytics.findVisitor(id);
  v.lastSeen = Date.now() - 30000;
  analytics.heartbeat({ id, path: '/product/p1', context: {} });

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
  analytics.recordPageView({ id, path: '/checkout', context: {} });
  const two = sessionsOf(v);
  assert.equal(two.length, 2);
  assert.equal(two[0].hits[0].p, '/checkout');
  assert.equal(v.visits, 2);

  // Потолок: файл пишется целиком, и хронология не должна расти без предела.
  for (let i = 0; i < 80; i++) analytics.recordPageView({ id, path: '/product/p' + i, context: {} });
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
  const html = render.orderClient(order, { metricsBase: '/admin/analytics/visitor/' });
  assert.match(html, /href="\/admin\/analytics\/visitor\/a{32}"/);
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

  // Базу адреса даёт панель: разметка строки общая, и без параметра ссылка
  // осталась бы без адреса вовсе.
  const list = [order];
  const db = { getOrders: () => list, visibleOrders: () => list, getProducts: () => [], visibleProducts: () => [], pendingReviewCount: () => 0 };
  assert.match(adminViews.ordersList(SETTINGS, db, null, 1), /\/admin\/analytics\/visitor\//);
});

test('карточка посетителя показывает визиты, страницы и время на каждой', () => {
  const now = Date.now();
  const visitor = {
    id: 'a'.repeat(32), firstSeen: now - 40 * 86400000, lastSeen: now - 5 * 60000,
    visits: 3, pageViews: 9, activeSeconds: 900, ip: '85.140.7.212', isp: 'MTS',
    city: 'Москва', country: 'Россия', countryCode: 'RU',
    device: 'Телефон', model: 'iPhone', os: 'iOS 26.0', browser: 'Safari 26',
    source: 'yandex.ru', pathCounts: { '/product/p1': 4, '/': 3 },
    hits: [{ p: '/', t: now - 600000, s: 20, v: 1 }, { p: '/product/p1', t: now - 580000, s: 245 }]
  };
  const html = analyticsView.visitorPage(visitor, {
    products: { p1: 'iPhone 17 Pro Max' }, backHref: '/admin/analytics', ordersHref: '/admin/orders',
    visitorBase: '/admin/analytics/visitor/', now,
    orders: [{ id: 'o1', number: '482913', total: 121990, createdAt: now }]
  });
  assert.match(html, /Визит №3/, 'нумерация идёт от общего счётчика визитов');
  assert.match(html, /iPhone 17 Pro Max/, 'страница названа по товару, а не голым путём');
  assert.match(html, /4 мин 5 сек/, 'время на странице');
  assert.match(html, /85\.140\.7\.212/);
  assert.match(html, /🇷🇺/);
  assert.match(html, /yandex\.ru/);
  assert.match(html, /№482913/, 'заказы этого посетителя рядом с историей');
  assert.match(html, /href="\/admin\/analytics"/, 'возврат ко всей метрике');

  // Посетителя могло вытеснить сроком хранения — это не ошибка, а понятный ответ.
  assert.match(analyticsView.visitorMissing('85.140.7.212', { backHref: '/admin/analytics' }), /История не найдена/);
});

test('длинные названия городов не перекрывают числа в метрике', () => {
  const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'styles.css'), 'utf8');
  assert.match(css, /\.metric-bar-label\{display:grid;grid-template-columns:minmax\(0,1fr\) max-content/);
  assert.match(css, /\.metric-location-bars \.metric-bar-label span\{white-space:normal;overflow-wrap:anywhere\}/);
});

test('каталог не показывает технический счётчик товаров', () => {
  const settings = { storeName: 'Тест', tagline: '', accentColor: '#0071e3', currency: '₽', currencyPosition: 'after' };
  const product = { id: 'p1', name: 'Товар', category: 'Категория', price: 100, inStock: true, images: [] };
  const db = { getProducts: () => [product], visibleProducts: () => [product], categories: () => ['Категория'], visibleCategories: () => ['Категория'], ratingFor: () => ({ avg: 0, count: 0 }) };
  const html = render.homePage(settings, db, { category: '', q: '', origin: '' });
  assert.doesNotMatch(html, />\s*1 товаров\s*</);
});

test('согласие на отзыв даётся галочкой в самой форме, а у заказа галочек нет', () => {
  const settings = { storeName: 'Тест', tagline: '', accentColor: '#0071e3', currency: '₽', currencyPosition: 'after' };
  const db = { reviewsForProduct: () => [], ratingFor: () => ({ avg: 0, count: 0 }), categories: () => [], visibleCategories: () => [] };
  const product = { id: 'p1', name: 'Товар', category: 'Категория', price: 100, inStock: true, images: [], colors: [], storages: [] };
  const html = render.productPage(settings, db, product, { origin: '' });
  const js = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const orderRoute = server.slice(server.indexOf("app.post('/api/order'"), server.indexOf('/* =========================== ПАНЕЛЬ ВЛАДЕЛЬЦА'));

  // Галочка обязательная и названы оба согласия — обработка и публикация.
  assert.match(html, /<input type="checkbox" id="rv-consent" name="privacyAccepted" value="1" required>/);
  assert.match(html, /href="\/personal-data-consent"[^>]*>обработку данных<\/a>/);
  assert.match(html, /href="\/personal-data-publication-consent"[^>]*>публикацию отзыва<\/a>/);
  // Окна с двумя шагами больше нет ни в разметке, ни в скрипте: диалог поверх
  // страницы на последнем шаге отзыва — лишний, галочка стоит в самой форме.
  assert.doesNotMatch(html, /review-consent/);
  assert.doesNotMatch(js, /review-consent-overlay/);
  // Публикация уезжает тем же запросом, а согласие на обработку — самой галочкой,
  // поэтому пустая галочка означает отказ и на сервере (поля в теле просто нет).
  assert.match(js, /fd\.set\('publicationAccepted', '1'\)/);
  assert.doesNotMatch(js, /fd\.append\('privacyAccepted'/);
  // Сервер по-прежнему требует оба согласия — форме на слово он не верит.
  const reviewRoute = server.slice(server.indexOf("app.post('/api/reviews'"), server.indexOf("app.post('/api/cart'"));
  assert.match(reviewRoute, /consentAccepted\(req\.body\.privacyAccepted\)/);
  assert.match(reviewRoute, /consentAccepted\(req\.body\.publicationAccepted\)/);

  // У формы заказа галочек нет вовсе: заказ — исполнение договора, и согласия
  // для него не спрашиваются (в маршруте их проверки тоже нет).
  assert.doesNotMatch(js, /id="co-privacy"|privacyAccepted:\s*true/);
  assert.doesNotMatch(orderRoute, /consentAccepted|privacyConsentAt/);
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
  const db = { categories: () => [], visibleCategories: () => [], pendingReviewCount: () => 0, getProducts: () => [product], visibleProducts: () => [product] };
  const form = adminViews.productForm(SETTINGS, db, product);
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
  const db = { reviewsForProduct: () => [], ratingFor: () => ({ avg: 0, count: 0 }), categories: () => [], visibleCategories: () => [] };
  const product = {
    id: 'p1', name: 'Товар', category: 'Категория', price: 50000, discountPercent: 17,
    inStock: true, images: [], colors: [], storages: [{ label: '128 ГБ', add: 0 }, { label: '1 ТБ', add: 40000 }]
  };
  const html = render.productPage(settings, db, product, { origin: '' });
  const js = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  // Скрипт правит старую цену по id и берёт процент с кнопки: разъедется
  // разметка с app.js — рядом с ценой сборки снова повиснет цена базовой.
  assert.match(html, /id="product-old-price"/);
  assert.match(html, /id="product-save"/);
  assert.match(html, /data-discount-pct="17"/);
  assert.match(js, /getElementById\('product-old-price'\)/);
  assert.match(js, /getElementById\('product-save'\)/);
  // Старая цена выводится из процента для ВЫБРАННОЙ сборки — тем же способом,
  // что и на сервере (compareFor в lib/discount.js).
  assert.match(js, /Math\.round\(total \/ \(1 - discountPct \/ 100\) \/ 10\) \* 10/);
  // Процент при смене варианта не меняется: скидка у товара одна.
  assert.match(js, /se\.textContent = '−' \+ discountPct \+ '%'/);
  assert.doesNotMatch(js, /1 - total \/ cmpTotal/, 'процент больше не пересчитывается от суммы');
  // Зачёркивать нечего — атрибут нулевой, и скрипт ничего не трогает.
  const plain = render.productPage(settings, db, Object.assign({}, product, { discountPercent: 0 }), { origin: '' });
  assert.doesNotMatch(plain, /id="product-old-price"/);
  assert.match(plain, /data-discount-pct="0"/);
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

  // Процент выгоды — розовый текст того же цвета, что и цена со скидкой, и без
  // подложки: так у Ozon, и так одинаково на витрине и на странице товара.
  // Прежняя залитая зелёная плашка была решением для зелёной же цены.
  const save = rule('\\.save');
  assert.match(save, /color:var\(--sale\)/);
  assert.doesNotMatch(css, /\.save\{[^}]*background/, 'к проценту вернулась подложка');
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

test('в форме товара задаётся процент, а старой цены и горящей скидки нет', () => {
  const settings = { storeName: 'Тест', tagline: '', accentColor: '#0071e3', currency: '₽', currencyPosition: 'after' };
  const db = { categories: () => ['iPhone'], getProducts: () => [], ratingFor: () => ({ avg: 0, count: 0 }), isVisible: () => true, pendingReviewCount: () => 0 };
  const product = { id: 'p1', name: 'Товар', category: 'iPhone', price: 66990, discountPercent: 13, inStock: true, images: [], colors: [], storages: [], bands: [], options: [] };
  const form = adminViews.productForm(settings, db, product);

  // Вводится только процент. Старой цены как поля нет вовсе: она выводится из
  // цены и процента, и второе поле для неё означало бы два источника у одного
  // числа — они разъехались бы при первой же правке цены.
  assert.match(form, /name="discountPercent"[^>]*value="13"/);
  assert.equal(/name="oldPrice"/.test(form), false, 'старая цена снова стала полем');
  assert.equal(/name="hotDeal"/.test(form), false, 'вернулась горящая скидка');
  assert.equal(/hotDealPrice|hotDealUntil|deal-box/.test(form), false, 'остатки горящей скидки в форме');

  // Товар со старой парой цен показывает выведенный процент, а не «скидки нет»:
  // иначе первое же сохранение эту скидку молча стёрло бы.
  const legacy = adminViews.productForm(settings, db, { id: 'p2', name: 'Б', category: 'iPhone', price: 1000, oldPrice: 1200, images: [], colors: [], storages: [], bands: [], options: [] });
  assert.match(legacy, /name="discountPercent"[^>]*value="17"/);

  // Маршрут сохранения принимает процент и не принимает старую цену.
  const source = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const fields = source.slice(source.indexOf('function productFields'), source.indexOf('app.get(\'/admin/products\''));
  assert.match(fields, /discountPercent: String\(req\.body\.discountPercent/);
  assert.equal(/oldPrice|hotDeal/.test(fields), false, 'в поля товара вернулась старая цена или акция');
  // Мусор в проценте — ошибка формы, а не молча ноль: сравнение с NaN всегда ложно.
  const from = source.indexOf('function validateProduct');
  const to = source.indexOf('\nfunction tgEsc');
  const validateProduct = new Function('D', 'PRICE_MAX', source.slice(from, to) + ' return validateProduct;')(deals, 1e12);
  assert.deepEqual(validateProduct({ name: 'A', category: 'C', price: '100', discountPercent: 'абв' }).map(e => e.field), ['discountPercent']);
  assert.deepEqual(validateProduct({ name: 'A', category: 'C', price: '100', discountPercent: '95' }).map(e => e.field), ['discountPercent']);
  assert.deepEqual(validateProduct({ name: 'A', category: 'C', price: '100', discountPercent: '13' }), []);
  assert.deepEqual(validateProduct({ name: 'A', category: 'C', price: '100', discountPercent: '' }), []);

  // Витрина: процент один на все сборки, полосы «Специальные цены» с таймером
  // на главной больше нет.
  const shop = { getProducts: () => [product], visibleProducts: () => [product], categories: () => ['iPhone'], visibleCategories: () => ['iPhone'], ratingFor: () => ({ avg: 0, count: 0 }) };
  const home = render.homePage(settings, shop, { category: '', q: '', origin: '' });
  assert.equal(/deals-band|deal-timer|Специальные цены|data-deal-until/.test(home), false, 'остатки горящих скидок на главной');
  assert.match(home, /class="save">−13%<\/span>/);
  const js = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  assert.equal(/data-deal-until|initCountdowns/.test(js), false, 'таймер акции остался в скрипте витрины');
  const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'styles.css'), 'utf8');
  assert.equal(/deals-band|deal-timer|deal-banner|card-hot|deal-box/.test(css), false, 'остатки горящих скидок в стилях');
});

test('карточка каталога: строка отзывов, розовая цена и плашка «Распродажа»', () => {
  const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'styles.css'), 'utf8');
  const settings = { storeName: 'Тест', tagline: '', accentColor: '#0071e3', currency: '₽', currencyPosition: 'after' };
  const product = { id: 'p1', name: 'Товар', category: 'Категория', price: 67990, discountPercent: 6, inStock: true, images: [] };
  const db = {
    getProducts: () => [product], visibleProducts: () => [product],
    categories: () => ['Категория'], visibleCategories: () => ['Категория'],
    ratingFor: () => ({ avg: 4.7, count: 1225 }),
  };
  const html = render.homePage(settings, db, { category: '', q: '', origin: '' });

  // Строка отзывов — одна звезда с оценкой, пузырёк и число словом. Пять звёзд
  // в карточке занимали ширину, но оценку всё равно читают числом рядом.
  assert.doesNotMatch(html, /<div class="card-rating">\s*<span class="stars"/, 'в карточку вернулись пять звёзд');
  assert.match(html, /class="rt-star"[\s\S]*?class="rt-avg">4\.7<\/span>[\s\S]*?class="rt-bubble"/);
  assert.match(html, /class="rating-count">1\s225 отзывов<\/span>/, 'число отзывов — с разрядами и словом');
  // Звёзды остаются там, где их читают как оценку, а не как значок
  assert.match(render.stars(4.7), /class="stars"/);

  // Плашка «Распродажа» лежит на снимке и только у того, что можно купить
  assert.match(html, /<div class="card-media">[\s\S]*?<span class="card-sale">/);
  const sold = { ...product, inStock: false };
  const soldHtml = render.homePage(settings, { ...db, getProducts: () => [sold], visibleProducts: () => [sold] }, {});
  assert.doesNotMatch(soldHtml, /card-sale/, 'скидка обещана на том, что нельзя купить');

  const rule = name => [...css.matchAll(new RegExp(name + '\\s*\\{([^}]*)\\}', 'g'))].map(m => m[1]).join(';');
  // Плашка — розовая пилюля в углу кадра, поверх снимка
  const sale = rule('\\.card-sale');
  assert.match(sale, /position:absolute/);
  assert.match(sale, /background:var\(--sale\)/);
  // Цена со скидкой и процент при ней — одного цвета с плашкой; процент без
  // подложки, иначе две залитые плашки в карточке спорят друг с другом.
  // Правило одно на всю витрину: и в карточке, и на странице товара.
  assert.match(rule("\\.price-sale \\.price-now"), /color:var\(--sale\)/);
  assert.match(rule("\\.save"), /color:var\(--sale\)/);
  // Черта старой цены — наклонный псевдоэлемент, а не text-decoration
  assert.match(rule('\\.card-price \\.old-price::before'), /transform:rotate\(-3deg\)/);
  assert.match(rule('\\.rt-star'), /color:#ffa800/);
});

test('страница товара: строка отзывов как в карточке, белый текст в выбранной кнопке', () => {
  const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'styles.css'), 'utf8');
  const settings = { storeName: 'Тест', tagline: '', accentColor: '#0071e3', currency: '₽', currencyPosition: 'after' };
  const product = { id: 'p1', name: 'Товар', category: 'Категория', price: 100, images: [], colors: [], storages: [] };
  const db = { reviewsForProduct: () => [], ratingFor: () => ({ avg: 4.9, count: 1225 }), categories: () => [], visibleCategories: () => [] };
  const html = render.productPage(settings, db, product, { origin: '' });

  // Та же строка, что в карточке каталога: звезда, оценка, пузырёк, число словом
  assert.match(html, /class="rating-summary">[\s\S]*?class="rt-star"[\s\S]*?<b>4\.9<\/b>[\s\S]*?class="rt-bubble"/);
  assert.match(html, /class="rating-count">1\s225 отзывов<\/span>/);
  assert.doesNotMatch(html, /class="rating-summary">\s*<span class="stars"/, 'в шапку товара вернулись пять звёзд');

  const rule = name => [...css.matchAll(new RegExp(name + '\\s*\\{([^}]*)\\}', 'g'))].map(m => m[1]).join(';');
  // Внутри выбранной (тёмной) кнопки весь текст чисто белый: подпись доплаты
  // гасилась до .82 прозрачности и на 11,5px читалась серым по тёмному.
  const activeSub = rule('\\.option-opt\\.active \\.opt-add,\\.option-opt\\.active \\.opt-note');
  assert.match(activeSub, /color:#fff/);
  assert.match(activeSub, /opacity:1/);
  assert.doesNotMatch(css, /\.option-opt\.active \.opt-add\{[^}]*opacity:\.8/, 'подпись в кнопке снова полупрозрачная');
  // Кадр ограничен по ширине: он занимал больше половины первого экрана
  assert.match(rule('\\.product-gallery'), /max-width:520px/);
});

test('в карточке нет категории и отметок, а ссылок на товар две — снимок и название', () => {
  const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'styles.css'), 'utf8');
  const settings = { storeName: 'Тест', tagline: '', accentColor: '#0071e3', currency: '₽', currencyPosition: 'after' };
  const product = { id: 'p1', name: 'Товар', category: 'Категория', price: 100, badge: 'Новинка', inStock: true, images: [] };
  const db = {
    getProducts: () => [product], visibleProducts: () => [product],
    categories: () => ['Категория'], visibleCategories: () => ['Категория'],
    ratingFor: () => ({ avg: 0, count: 0 }),
  };
  const html = render.homePage(settings, db, { category: '', q: '', origin: '' });
  const card = html.slice(html.indexOf('<article class="card'), html.indexOf('</article>'));

  // Строки над названием нет вовсе — ни категории, ни отметки. Отметка не
  // возвращается даже из старых данных: поля больше нет ни в форме, ни в БД.
  assert.doesNotMatch(card, /card-cat|card-flag/, 'строка категории и отметок вернулась');
  assert.doesNotMatch(card, /Новинка/, 'отметка товара всё ещё попадает на витрину');
  const admin = fs.readFileSync(path.join(__dirname, '..', 'lib', 'admin-views.js'), 'utf8');
  assert.doesNotMatch(admin, /name="badge"/, 'поле отметки вернулось в форму товара');
  assert.doesNotMatch(fs.readFileSync(path.join(__dirname, '..', 'lib', 'db.js'), 'utf8'), /badge:/, 'отметка вернулась в хранилище');

  // Две ссылки на товар: снимок (без имени и фокуса) и название
  assert.match(card, /<a class="card-media-link" href="\/product\/p1" tabindex="-1" aria-hidden="true">/);
  assert.match(card, /<a class="card-name" href="\/product\/p1">Товар<\/a>/);
  assert.doesNotMatch(card, /card-link/, 'вернулась общая ссылка на всё тело карточки');

  // Карточка неподвижна: ни подъёма, ни наплыва снимка при наведении
  assert.doesNotMatch(css, /\.card:hover\{/, 'карточка снова двигается при наведении');
  assert.doesNotMatch(css, /\.card:active\{/);
  assert.doesNotMatch(css, /\.card:hover \.card-media img/);
  // Название — ссылка, и при наведении меняется только цвет, как у Ozon
  assert.match(css, /\.card-name:hover\{color:#0050e0\}/);
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

  // Высоты в шапке связаны: поле поиска и кнопка Telegram одного роста, корзина
  // заметно крупнее — её ищут глазами на каждой странице. Числа порознь
  // разъезжаются молча, увидеть это можно только глазами.
  const num = (rule, prop) => Number((css.match(new RegExp('\\' + rule + '\\{[^}]*' + prop + ':(\\d+)px'))
    || [])[1]);
  const searchH = num('.search input', 'height');
  const tgH = num('.tg-header', 'min-height');
  const cartH = num('.cart-btn', 'min-height');
  assert.equal(searchH, tgH, 'поле поиска и кнопка Telegram обязаны быть одного роста');
  assert.ok(cartH > tgH, 'корзина должна оставаться крупнее остальных кнопок шапки');
  assert.ok(num('.header-row', 'height') >= cartH + 8, 'ряд шапки ужат так, что корзине не хватает полей');

  // У подписи «Telegram» есть выносная «g», а ширина строки анимируется, то есть
  // overflow:hidden снять нельзя — значит строке обязана быть задана своя высота,
  // иначе хвост буквы срезается ровно по кеглю.
  // Берём то правило подписи, где задан overflow, а не свёрнутое состояние
  // (`.header-compact .tg-header-txt{max-width:0}` совпадает с тем же куском).
  const txt = (css.match(/\.tg-header-txt\{[^}]*\}/g) || []).find(r => r.includes('overflow')) || '';
  assert.match(txt, /overflow:hidden/);
  assert.match(txt, /line-height:1\.[1-9]/, 'подпись кнопки Telegram снова режет выносные буквы');
});

test('в подвале Telegram — кнопка с действием, а ник её подписью', () => {
  const fakeDb = { getProducts: () => [], visibleProducts: () => [], categories: () => [], visibleCategories: () => [], ratingFor: () => ({ avg: 0, count: 0 }) };
  const html = render.homePage({ storeName: 'Тест', tagline: '', currency: '₽', contactTelegram: '@adc_apple' }, fakeDb, {});
  // Голый ник не говорит, что по нему пишут, и нажимать его никто не догадывался.
  assert.match(html, /<a class="tg-cta" href="https:\/\/t\.me\/adc_apple"[^>]*>.*?<span>Написать в Telegram<\/span><\/a>/);
  assert.match(html, /<span class="foot-tg-user">@adc_apple<\/span>/);
  assert.doesNotMatch(html, /class="tg-link"/);
  // Без Telegram в настройках блока нет вовсе — пустая кнопка в подвале не нужна.
  assert.doesNotMatch(render.homePage({ storeName: 'Тест', tagline: '', currency: '₽' }, fakeDb, {}), /tg-cta/);

  const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'styles.css'), 'utf8');
  // Глиф самолётика нарисован с воздухом внутри холста, поэтому рядом с текстом
  // он казался отставшим на пробел: пустоту съедают отрицательные поля.
  assert.match(css, /\.tg-cta \.tg-ico\{[^}]*margin:0 -\d+px 0 -\d+px/);
});

test('в подвале есть знаки оплаты, а на телефоне подвал в одну колонку', () => {
  const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'styles.css'), 'utf8');
  const fakeDb = { getProducts: () => [], visibleProducts: () => [], categories: () => [], visibleCategories: () => [], ratingFor: () => ({ avg: 0, count: 0 }) };
  // Знаки платёжных систем — обещание принять карту, поэтому показываются они
  // только при включённой оплате на витрине. В режиме заявок платит покупатель
  // уже по договорённости с менеджером, и обещать ему СБП в подвале нельзя.
  const payOn = { storeName: 'Тест', tagline: '', currency: '₽', crocopayEnabled: true, crocopayClientId: 'id', crocopayClientSecret: 'secret' };
  const html = render.homePage(payOn, fakeDb, {});
  assert.equal((html.match(/class="pay /g) || []).length, 4);
  const claims = render.homePage({ storeName: 'Тест', tagline: '', currency: '₽' }, fakeDb, {});
  assert.doesNotMatch(claims, /footer-pay/, 'в режиме заявок подвал не обещает приём карт');
  assert.match(html, /class="pay pay-mc"[^>]*>[\s\S]*?<span class="sr-only">Mastercard<\/span>/);
  // Знаки — разметка, а не файлы: ни одной картинки грузить не нужно
  assert.doesNotMatch(html, /footer[\s\S]*?<img[^>]+pay/i);
  // Мобильная сетка подвала обязана сбрасывать вторую колонку: иначе копирайт,
  // выровненный по центру, уезжает за левый край экрана.
  const mobile = css.slice(css.indexOf('@media(max-width:800px){'));
  assert.match(mobile, /\.footer-bottom\{[^}]*grid-template-columns:minmax\(0,1fr\)/);
});

test('на телефоне слоган стоит в одну строку, а его длину считает сервер', () => {
  const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'styles.css'), 'utf8');
  const fakeDb = { getProducts: () => [], visibleProducts: () => [], categories: () => [], visibleCategories: () => [], ratingFor: () => ({ avg: 0, count: 0 }) };
  const tagline = 'Оригинальная техника Apple с гарантией';
  const html = render.homePage({ storeName: 'Тест', tagline, currency: '₽' }, fakeDb, {});

  // Разметка и CSS держатся вместе: без --fit в атрибуте var() подставит
  // запасное число, и заголовок поедет по ширине чужого слогана.
  assert.match(html, /<h1 style="--fit:[\d.]+">/);
  assert.match(html, /class="foot-note" style="--fit:[\d.]+"/);
  const mobile = css.slice(css.indexOf('@media(max-width:800px){'));
  // Потолок кегля — свободная величина оформления, его двигают. Закрепляем то,
  // от чего зависит правильность: перенос запрещён, а второй аргумент min()
  // считает кегль от ширины экрана и серверной оценки длины строки.
  assert.match(mobile, /\.store-hero h1\{white-space:nowrap;font-size:min\(\d+px,calc\(\(100vw - 40px\)\/var\(--fit,\d+\)\)\)/);
  assert.match(mobile, /\.foot-note\{[^}]*white-space:nowrap;font-size:min\(14px,calc\(\(100vw - 40px\)\/var\(--fit,\d+\)\)\)/);

  // Оценка обязана быть не меньше ширины, замеренной в браузере (em при кегле
  // 14px — на узком экране строка набирается примерно им). Заниженная оценка
  // выносит строку за экран, и увидеть это можно только глазами.
  const bound = render.bindShortWords(tagline);
  assert.ok(Number(render.heroFit({}, bound)) >= 19.586 + 0.86, 'заголовок: оценка меньше замера');
  assert.ok(Number(render.footFit(tagline)) >= 19.979, 'подвал: оценка меньше замера');
  // Длинный слоган обязан давать большую оценку, иначе кегль не уменьшится
  assert.ok(Number(render.footFit(tagline + ' и быстрой доставкой')) > Number(render.footFit(tagline)));
});

test('на телефоне поиск открывается лупой, а на десктопе остаётся строкой', () => {
  const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'styles.css'), 'utf8');
  const fakeDb = { getProducts: () => [], visibleProducts: () => [], categories: () => [], visibleCategories: () => [], ratingFor: () => ({ avg: 0, count: 0 }) };
  const settings = { storeName: 'Тест', tagline: 'Слоган', currency: '₽' };
  const html = render.homePage(settings, fakeDb, {});

  // Переключатель обязан стоять ПЕРЕД формой: поле открывается селектором
  // соседа (~), и перестановка в разметке молча оставила бы лупу без действия.
  const sw = html.indexOf('id="search-open"');
  const form = html.indexOf('<form class="search"');
  assert.ok(sw > -1 && form > -1 && sw < form, 'чекбокс поиска должен идти перед формой');
  assert.match(html, /<label class="icon-btn search-toggle" for="search-open"/);

  // С непустым запросом поле открыто: иначе строка с набранным закрывалась бы
  // сразу после поиска, и покупатель не видел бы, что именно он искал.
  assert.doesNotMatch(html, /id="search-open"[^>]*checked/);
  assert.match(render.homePage(settings, fakeDb, { q: 'айфон' }), /id="search-open"[^>]*checked/);

  // На десктопе лупы нет вовсе — там поле видно всегда.
  assert.match(css, /\.search-toggle\{display:none\}/);
  const mobile = css.slice(css.indexOf('@media(max-width:800px){'));
  assert.match(mobile, /\.header-row \.search-toggle\{display:inline-flex/);
  assert.match(mobile, /\.search\{[^}]*max-height:0\}/);
  assert.match(mobile, /\.search-switch:checked~\.search\{max-height:\d+px/);

  // Чекбокс спрятан визуально, а не hidden: иначе он выпадает из потока фокуса
  // и лупу нельзя ни навести с клавиатуры, ни увидеть на ней рамку.
  assert.doesNotMatch(html, /id="search-open"[^>]*\shidden/);
  assert.match(css, /\.search-switch\{position:absolute[^}]*clip-path:inset\(50%\)/);

  // Разметку рисует сервер, скрипту остаётся только фокус: своя вставка поля в
  // app.js разъехалась бы с серверной на первой правке шапки.
  const app = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  const fn = app.slice(app.indexOf('function initSearchToggle'), app.indexOf('function initMediaGuard'));
  assert.ok(fn.length > 0, 'initSearchToggle должна существовать');
  assert.doesNotMatch(fn, /innerHTML|createElement|insertAdjacent/);
});

test('шапка и корзина читаются с клавиатуры и вслух', () => {
  const fakeDb = { getProducts: () => [], visibleProducts: () => [], categories: () => [], visibleCategories: () => [], ratingFor: () => ({ avg: 0, count: 0 }) };
  const html = render.homePage({ storeName: 'Тест', tagline: 'Слоган', currency: '₽' }, fakeDb, {});
  const app = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');

  // Имя носит сам чекбокс: внутри подписи одна лупа и ни буквы текста, поэтому
  // у поля выходило пустое доступное имя — «форма без ярлыка».
  assert.match(html, /id="search-open"[^>]*aria-label="Поиск"/);

  // Счётчик корзины спрятан от скринридера, а число уезжает в имя кнопки:
  // видимый текст «3» и доступное имя «Корзина» — разные вещи.
  assert.match(html, /class="cart-badge" id="cart-badge" aria-hidden="true"/);
  assert.match(app, /trigger\.setAttribute\('aria-label', c \? 'Корзина, '/);

  // Закрытая панель корзины не только спрятана, но и вынута из порядка обхода:
  // без inert по Tab туда попадали, а прочитать не могли.
  assert.match(html, /id="cart-drawer"[^>]*aria-hidden="true" inert>/);
  assert.match(app, /drawer\.removeAttribute\('inert'\)/);
  assert.match(app, /drawer\.setAttribute\('inert', ''\)/);
});

test('цвета витрины читаются: скидка, зачёркнутая цена и Telegram', () => {
  const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'styles.css'), 'utf8');
  // Порог 4.5:1 на белом. Цена и процент — это текст про деньги, а не оформление,
  // и прежние #f1117e (4.10), #99a3ae (2.55) и #229ed9 (3.02) его не проходили.
  const luminance = hex => {
    const parts = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255)
      .map(c => (c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)));
    return 0.2126 * parts[0] + 0.7152 * parts[1] + 0.0722 * parts[2];
  };
  const onWhite = hex => 1.05 / (luminance(hex) + 0.05);
  const value = name => (css.match(new RegExp('--' + name + ':(#[0-9a-f]{6})')) || [])[1];

  for (const name of ['sale', 'price-was', 'tg']) {
    const hex = value(name);
    assert.ok(hex, 'переменная --' + name + ' пропала');
    assert.ok(onWhite(hex) >= 4.5, '--' + name + ' даёт на белом ' + onWhite(hex).toFixed(2) + ' — текст не прочесть');
  }
});

test('минификатор снимает отступы, но не трогает переводы строк', () => {
  const minify = require('../lib/minify');
  const src = [
    'function f() {',
    '  var a = 1;',
    '',
    '  return a',
    '}',
    'var s = "  два  пробела  ";',
    'var t = `строка',
    '  с отступом`;'
  ].join('\n');
  const out = minify.js(src);

  // Отступы и пустые строки уходят — но только в коде.
  assert.ok(out.startsWith('function f() {\nvar a = 1;\nreturn a\n}'), 'отступ или пустая строка остались: ' + JSON.stringify(out.slice(0, 60)));
  // Внутри литералов не тронуто ни одного пробела.
  assert.ok(out.includes('"  два  пробела  "'), 'пробелы внутри строки схлопнулись');
  assert.ok(out.includes('`строка\n  с отступом`'), 'отступ внутри шаблона схлопнулся');
  // Число переводов строки в коде не изменилось: иначе автоматическая
  // расстановка точек с запятой сработала бы иначе, и `return a` вернул бы undefined.
  assert.equal((out.match(/\n/g) || []).length, (src.match(/\n/g) || []).length - 1);
  assert.ok(out.length < src.length);
});

test('правовые ссылки в подвале тоже помещаются в строку', () => {
  const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'styles.css'), 'utf8');
  const fakeDb = { getProducts: () => [], visibleProducts: () => [], categories: () => [], visibleCategories: () => [], ratingFor: () => ({ avg: 0, count: 0 }) };
  const html = render.homePage({ storeName: 'Тест', tagline: '', currency: '₽' }, fakeDb, {});
  const mobile = css.slice(css.indexOf('@media(max-width:800px){'));
  assert.match(mobile, /\.footer-links\{[^}]*grid-template-columns:repeat\(2,auto\)[^}]*font-size:min\(12px,calc\(\(100vw - 54px\)\/32\.9\)\)/);
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
  const fakeDb = { getProducts: () => [], visibleProducts: () => [], categories: () => [], visibleCategories: () => [], ratingFor: () => ({ avg: 0, count: 0 }) };
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
  const fakeDb = { categories: () => ['AirPods'], visibleCategories: () => ['AirPods'], pendingReviewCount: () => 0 };
  const html = adminViews.productForm(SETTINGS, fakeDb, null);
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

test('переезд на один магазин переносит домен в общие настройки, не меняя витрину', t => {
  // Главное правило переноса: витрина обязана выглядеть так же, как выглядела.
  // Поэтому множитель домена и его ручные цены вбиваются в сам товар, а не
  // «берутся из каталога заново».
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'store-single-site-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const write = (name, data) => fs.writeFileSync(path.join(dir, name + '.json'), JSON.stringify(data));
  write('settings', {
    storeName: 'Старое', sessionSecret: 'x'.repeat(48),
    adminUsername: 'admin', adminPasswordHash: auth.hashPassword('слабый-от-домена'),
    ownerUsername: 'chief', ownerPasswordHash: auth.hashPassword('пароль-владельца')
  });
  write('products', [
    { id: 'a', name: 'A', category: 'C', price: 1000, oldPrice: 1200, hotDeal: true, hotDealPrice: 900,
      storages: [{ label: '1 ТБ', add: 100 }], colors: [], bands: [],
      options: [{ name: 'Связь', hint: 'подсказка', values: [{ label: 'Wi-Fi', add: 0 }, { label: 'Cellular', add: 200 }] }] },
    { id: 'b', name: 'B', category: 'C', price: 500, storages: [], colors: [], bands: [], options: [] },
    { id: 'c', name: 'C', category: 'C', price: 700, storages: [], colors: [], bands: [], options: [] }
  ]);
  write('reviews', [
    { id: 'r1', productId: 'a', rating: 5, status: 'approved', createdAt: 1 },
    { id: 'r2', productId: 'a', rating: 1, status: 'approved', createdAt: 2 }
  ]);
  write('orders', [{ id: 'o1', number: '1', siteId: 'live', createdAt: Date.now(), items: [], total: 1 }]);
  write('sites', [
    { id: 'dead', hosts: [], storeName: 'Заброшенный', priceMultiplier: 3, overrides: {}, hiddenReviews: [] },
    { id: 'live', hosts: ['shop.test', 'www.shop.test'], storeName: 'Живой', tagline: 'слоган',
      accentColor: '#ff2d55', logoText: '{Ж}ивой', telegramBotToken: 'бот', notifyReviews: false,
      priceMultiplier: 1.5, overrides: { b: { price: 444 }, c: { enabled: false } }, hiddenReviews: ['r2'] }
  ]);

  const store = freshDb(dir);
  const report = store.ensureSeeded();
  assert.equal(report.site, 'Живой', 'выигрывает домен, на котором шла торговля');
  assert.deepEqual(report.hosts, ['shop.test'], 'www — то же имя, в отчёте оно одно');
  assert.deepEqual(report.dropped, ['Заброшенный']);

  const settings = store.getSettings();
  assert.equal(settings.storeName, 'Живой');
  assert.equal(settings.accentColor, '#ff2d55');
  assert.equal(settings.logoText, '{Ж}ивой');
  assert.equal(settings.notifyReviews, false, 'снятая галочка переезжает снятой');
  // Полный доступ был у владельца — его учётка и становится единственной.
  // Пароль от урезанной админки домена права получить не должен.
  assert.equal(settings.adminUsername, 'chief');
  assert.ok(auth.verifyPassword('пароль-владельца', settings.adminPasswordHash));
  assert.ok(!auth.verifyPassword('слабый-от-домена', settings.adminPasswordHash));
  assert.equal(settings.ownerPasswordHash, undefined, 'вторая учётка из файла убрана');

  const byId = Object.fromEntries(store.getProducts().map(p => [p.id, p]));
  // Товар «a» продавался по горящей акции за 900 при базовой 1000 — значит на
  // витрине стояло 900 и «−10%». После переезда это 1350 (множитель 1.5) и тот
  // же процент: скидка переехала процентом, а не суммой.
  assert.equal(byId.a.price, 1350, 'множитель вбит в цену продажи');
  assert.equal(byId.a.discountPercent, 10);
  assert.equal(byId.a.oldPrice, undefined, 'сумма старой цены снята вместе со старой моделью');
  assert.equal(byId.a.hotDealPrice, undefined);
  assert.equal(byId.a.storages[0].add, 150, 'доплата за память масштабируется так же');
  assert.equal(byId.a.options[0].values[1].add, 300);
  assert.equal(byId.a.options[0].hint, 'подсказка', 'остальные поля не теряются');
  assert.equal(byId.b.price, 444, 'ручная цена домена становится базовой');
  assert.equal(byId.b.discountPercent, 0, 'у ручной цены скидки не было и не появится');
  assert.equal(byId.c.visible, false, 'снятая на домене видимость стала флагом товара');
  assert.equal(store.visibleProducts().length, 2);

  // Скрытый на домене отзыв возвращается в модерацию: удалять нельзя, а
  // показывать — значит вернуть на витрину то, что убрали руками.
  const reviews = Object.fromEntries(store.getReviews().map(r => [r.id, r.status]));
  assert.deepEqual(reviews, { r1: 'approved', r2: 'pending' });

  // Файл не удалён, а сохранён: другой копии прежних настроек нет.
  assert.ok(fs.existsSync(path.join(dir, 'sites.migrated.json')));
  assert.ok(!fs.existsSync(path.join(dir, 'sites.json')));
  // Повторный запуск ничего не пересчитывает второй раз.
  assert.equal(freshDb(dir).ensureSeeded(), null);
  assert.equal(freshDb(dir).getProducts().find(p => p.id === 'a').price, 1350);
});

test('страница товара показывает доп. характеристики и прячет несовместимые значения', () => {
  const db = { reviewsForProduct: () => [], ratingFor: () => ({ avg: 0, count: 0 }), categories: () => [], visibleCategories: () => [] };
  const product = {
    id: 'pad', name: 'iPad', category: 'iPad', price: 100000, inStock: true, images: [], colors: [],
    storages: [{ label: '256 ГБ', add: 0 }, { label: '2 ТБ', add: 80000 }],
    options: [{ name: 'Покрытие дисплея', hint: 'Выберите, какое стекло вам подходит', values: [
      { label: 'Стандартное стекло', add: 0 },
      { label: 'Нанотекстурное стекло', add: 15000, forStorage: ['2 ТБ'] }
    ] }]
  };
  const html = render.productPage({ storeName: 'Тест', currency: '₽' }, db, product, {});
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
  // «order» и «new» заняты адресами /admin/products/*, остальное — просто мусор.
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
    getProducts: () => products, visibleProducts: () => products, isVisible: p => p.visible !== false,
    categories: () => ['A'], visibleCategories: () => ['A'],
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
  const list = adminViews.productsList(SETTINGS, db);
  assert.match(list, /<tbody id="product-order" data-order="\[&quot;p2&quot;,&quot;p1&quot;\]"/);
  assert.match(list, /<tr data-id="p2" draggable="true"/);
  assert.match(list, /class="a-move a-move-up" aria-label="Переместить «Второй» выше" disabled/);
  assert.match(list, /class="a-move a-move-down" aria-label="Переместить «Первый» ниже" disabled/);
  assert.match(list, /product-order\.js/);

  /* Подсказок в списке нет ни одной. Абзац про порядок строк объяснял то, что
     видно самими элементами (ручка, номер и стрелки стоят в каждой строке), а
     «базовая цена» повторяла заголовок столбца у каждого из полусотни товаров.
     Читают их один раз, видят — при каждом заходе в каталог. */
  assert.doesNotMatch(list, /Порядок строк/);
  assert.doesNotMatch(list, /базовая цена/);
  assert.doesNotMatch(list, /a-grip-inline/);

  /* Ячейки названы, потому что на телефоне строка становится карточкой и
     раскладку задаёт сетка: безымянные <td> ей не адресовать. */
  const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'styles.css'), 'utf8');
  for (const cls of ['a-pname', 'a-price', 'a-marks']) assert.match(list, new RegExp(`<td class="${cls}"`));
  assert.match(list, /<div class="a-panel a-panel-list">/);
  const mobile = css.slice(css.indexOf('@media(max-width:800px){'));
  assert.match(mobile, /\.a-table\.a-table-sortable\{min-width:0;display:block\}/);
  assert.match(mobile, /\.a-table-sortable tr\{display:grid/);
  // Ручка перетаскивания на телефоне не работает вовсе (обычный HTML5 drag), и
  // кнопке, которая ничего не делает, на экране не место — двигают стрелками.
  assert.match(mobile, /\.a-order \.a-grip\{display:none\}/);
  // Рамку панели снимает ОДНО правило на все такие списки: порознь каталог и
  // лента отзывов разъехались бы молча.
  assert.equal((mobile.match(/\.a-panel\.a-panel-list\{padding:0/g) || []).length, 1);
  // Скрипт шлёт весь список целиком — сервер принимает только перестановку
  const js = fs.readFileSync(path.join(__dirname, '..', 'public', 'product-order.js'), 'utf8');
  assert.match(js, /'\/admin\/products\/order'/);
  assert.match(js, /restore\(previous\)/);

  // Побеждает первый совпавший маршрут, а «/admin/products/:id» подходит и под
  // «/admin/products/order». Если регистрацию переставить, запрос порядка уйдёт
  // в сохранение товара — поэтому очередь закреплена здесь.
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const orderRoute = server.indexOf(`app.post('/admin/products/order'`);
  const saveRoute = server.indexOf(`app.post('/admin/products/:id'`);
  assert.ok(orderRoute > -1 && saveRoute > -1, 'маршруты на месте');
  assert.ok(orderRoute < saveRoute, 'порядок товаров регистрируется раньше сохранения товара');
});

test('скрытый товар пропадает с витрины целиком, а не «нет в наличии»', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'store-visible-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'products.json'), '[]');
  fs.writeFileSync(path.join(dir, 'reviews.json'), '[]');
  const store = freshDb(dir);
  store.ensureSeeded();
  const shown = store.createProduct({ id: 'shown', name: 'Виден', category: 'A', price: 100 });
  const hidden = store.createProduct({ id: 'hidden', name: 'Скрыт', category: 'B', price: 100, visible: false });

  // Поля нет — товар виден: старые данные и catalog.js читаются без изменений.
  assert.equal(store.isVisible({ id: 'x' }), true);
  assert.equal(store.isVisible(shown), true);
  assert.equal(store.isVisible(hidden), false);
  assert.deepEqual(store.visibleProducts().map(p => p.id), ['shown']);
  assert.equal(store.visibleProduct('hidden'), null, 'скрытый не открывается и по прямой ссылке');
  assert.ok(store.getProduct('hidden'), 'но в каталоге панели он на месте');
  // Пустой раздел в меню и лишний адрес в карте сайта тоже не остаются.
  assert.deepEqual(store.visibleCategories(), ['A']);
  assert.deepEqual(store.categories().sort(), ['A', 'B']);

  // Частичное обновление (маршрут загрузки фото) видимость не затирает.
  store.updateProduct('hidden', { images: [] });
  assert.equal(store.getProduct('hidden').visible, false);
  store.updateProduct('hidden', { visible: true });
  assert.equal(store.visibleProducts().length, 2);
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
    getProducts: () => [watch], visibleProducts: () => [watch], categories: () => ['Watch'], visibleCategories: () => ['Watch'],
    ratingFor: () => ({ avg: 0, count: 0 })
  };
  const html = render.homePage({ storeName: 'Тест', tagline: '', currency: '₽' }, fakeDb, {});
  // У товара с вариантами кнопка ведёт на страницу товара, а не кладёт в корзину сразу
  assert.match(html, /href="\/product\/watch">.*?В корзину<\/a>/);
  // Слева от подписи — значок тележки, как в карточке Ozon. Он в разметке, а не
  // в CSS: скрипт витрины возвращает кнопку из dataset.label, и текстом там
  // значок бы не пережил добавление товара с последующим удалением.
  assert.match(html, /<svg class="btn-ico"[^>]*>.*?<\/svg>В корзину/);
  const app = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  assert.match(app, /btn\.dataset\.label = btn\.innerHTML/);
  assert.doesNotMatch(app, /btn\.textContent = btn\.dataset\.label/);
  assert.doesNotMatch(html, /class="btn btn-primary btn-block add-to-cart"\s+data-id="watch"/);
});

test('карточка каталога показывает цену самой дешёвой ДОСТУПНОЙ сборки', () => {
  const ss = { storeName: 'Тест', tagline: '', currency: '₽' };
  const phone = {
    id: 'ph', name: 'Телефон', category: 'iPhone', price: 60000, discountPercent: 20, inStock: true, images: [],
    colors: [{ name: 'Чёрный', hex: '#111' }],
    storages: [{ label: '128 ГБ', add: 0 }, { label: '256 ГБ', add: 8000 }],
    options: [{ name: 'SIM-карта', values: [{ label: 'Только eSIM', add: 0 }, { label: 'eSIM + SIM', add: 3000 }] }]
  };
  const db = {
    getProducts: () => [phone], visibleProducts: () => [phone], categories: () => ['iPhone'],
    visibleCategories: () => ['iPhone'], ratingFor: () => ({ avg: 0, count: 0 }), reviewsForProduct: () => []
  };
  const price = html => (html.match(/class="price-now"[^>]*>([^<]+)</) || [])[1] || '';
  const nbsp = s => s.replace(/\s/g, ' ');

  // Всё в наличии — цена та же, что и раньше: базовая.
  assert.equal(nbsp(price(render.homePage(ss, db, {}))), '60 000 ₽');

  /* Дешёвая конфигурация кончилась — карточка обязана показать следующую
   * доступную, а не обещать цену, которой на странице товара уже нет: страница
   * открывается с первого ДОСТУПНОГО варианта. */
  phone.storages[0].inStock = false;
  const out = render.homePage(ss, db, {});
  assert.equal(nbsp(price(out)), '68 000 ₽');
  // Зачёркнутая цена считается от той же суммы: процент у товара один на все
  // сборки, а рубли выгоды у дорогой сборки свои.
  assert.match(nbsp(out), /class="old-price">85 000 ₽/);
  assert.equal(render.startPrice(phone), 68000);

  // То же число стоит и на самой странице товара: раньше сервер рисовал базовую
  // цену, а скрипт тут же исправлял её — сумма дёргалась на глазах.
  assert.equal(nbsp(price(render.productPage(ss, db, phone, {}))), '68 000 ₽');

  // Распроданное значение доп. характеристики двигает цену так же.
  phone.storages[0].inStock = true;
  phone.options[0].values[0].inStock = false;
  assert.equal(nbsp(price(render.homePage(ss, db, {}))), '63 000 ₽');

  // Базовая цена остаётся базовой: скрипт считает сумму как «база + доплаты
  // выбранного», и подменить её ценой стартовой сборки нельзя.
  assert.match(render.productPage(ss, db, phone, {}), /data-base-price="60000"/);
});

test('счётчик отзывов склоняется по-русски', () => {
  const db = {
    reviewsForProduct: () => [{ id: 'r1', author: 'Тест', rating: 5, text: '', status: 'approved', createdAt: Date.now() }],
    ratingFor: () => ({ avg: 5, count: 1 }), categories: () => [], visibleCategories: () => []
  };
  const product = { id: 'p', name: 'Товар', category: 'Тест', price: 100, inStock: true, images: [] };
  const html = render.productPage({ storeName: 'Тест', currency: '₽' }, db, product, {});
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
  const db = { reviewsForProduct: () => many, ratingFor: () => ({ avg: 4, count: many.length }), categories: () => [], visibleCategories: () => [] };
  const product = { id: 'p', name: 'Товар', category: 'Тест', price: 100, inStock: true, images: [] };
  const count = html => (html.match(/class="review"/g) || []).length;

  const first = render.productPage({ storeName: 'Тест', currency: '₽' }, db, product, {});
  assert.equal(count(first), per, 'на странице только одна порция');
  assert.match(first, /rev-page" href="[^"]*rpage=2#reviews" data-page="2"/);
  assert.match(first, /Отзывы 1–8 из 26/);
  // На первой странице стрелка «назад» не ссылка, но остаётся на месте.
  assert.match(first, /rev-page rev-arrow rev-off/);
  assert.match(first, /<span class="rev-page rev-cur" aria-current="page">1<\/span>/);
  // Без JS сортировка и страница приходят из адреса, а не из состояния браузера.
  const third = render.productPage({ storeName: 'Тест', currency: '₽' }, db, product, { reviewSort: 'new', reviewPage: 3 });
  assert.equal(count(third), per);
  assert.match(third, /rev-page rev-arrow" href="[^"]*rpage=2#reviews" rel="prev"/);
  assert.match(third, /rev-page rev-arrow" href="[^"]*rpage=4#reviews" rel="next"/);
  assert.match(third, /class="sort-btn active"[^>]*data-sort="new"/);
  // Номер страницы приходит из запроса, поэтому мусор и выход за край не должны падать.
  const beyond = render.productPage({ storeName: 'Тест', currency: '₽' }, db, product, { reviewSort: 'нет', reviewPage: '999' });
  assert.equal(count(beyond), 2);
  assert.match(beyond, /<span class="rev-page rev-cur" aria-current="page">4<\/span>/);
  assert.doesNotMatch(beyond, /rpage=5/);

  const own = { id: 'own', author: 'Я', rating: 1, text: 'мой', status: 'pending', createdAt: 5 };
  const mine = render.productPage({ storeName: 'Тест', currency: '₽' }, db, product, { ownReviews: [own] });
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
    status: 'pending', createdAt: 1000 + i, photos: []
  }));
  const db = {
    getReviews: () => many, getProducts: () => [{ id: 'p', name: 'Товар' }],
    reviewStats: () => new Map([['p', { total: many.length, approved: 0, pending: many.length, avg: 5 }]]),
    pendingReviewCount: () => many.length
  };
  const rows = html => (html.match(/class="rv-row/g) || []).length;

  const first = adminViews.reviewsList(SETTINGS, db, null, 1);
  assert.equal(rows(first), per, 'на странице ровно один срез');
  assert.match(first, /href="\/admin\/reviews\?page=2"/);
  const last = adminViews.reviewsList(SETTINGS, db, null, 4);
  assert.equal(rows(last), 7, 'на последней странице остаток');
  // Номер страницы приходит из адреса — мусор и выход за край не должны падать.
  assert.equal(rows(adminViews.reviewsList(SETTINGS, db, null, '999')), 7);
  assert.equal(rows(adminViews.reviewsList(SETTINGS, db, null, 'абв')), per);
  assert.equal(rows(adminViews.reviewsList(SETTINGS, db, null, -5)), per);

  // Лента одного товара листается той же нарезкой — на боевых данных у
  // 17 Pro Max их больше тысячи.
  const one = Object.assign({}, db, { reviewsForProduct: () => many, ratingFor: () => ({ avg: 5, count: many.length }) });
  const page2 = adminViews.productReviews(SETTINGS, one, { id: 'p', name: 'Товар' }, 'all', null, 2);
  assert.equal(rows(page2), per);
  assert.match(page2, /href="\/admin\/reviews\/product\/p\?status=all&amp;sort=new&amp;media=all&amp;page=3"/);
});

test('раздел отзывов открывается очередью модерации, и она подкрашена', () => {
  // Одобрить или отклонить — единственное дело в разделе, у которого есть срок.
  // Поэтому на входе видно именно его, а не общую ленту, где неразобранное
  // тонет среди тысяч опубликованных.
  const reviews = [
    { id: 'wait', productId: 'p', author: 'Ждёт', rating: 4, text: 'т', status: 'pending', createdAt: 3 },
    { id: 'ok', productId: 'p', author: 'Виден', rating: 5, text: 'т', status: 'approved', createdAt: 2 }
  ];
  const db = {
    getReviews: () => reviews, getProducts: () => [{ id: 'p', name: 'Товар' }],
    reviewStats: () => new Map([['p', { total: 2, approved: 1, pending: 1, avg: 5 }]]),
    pendingReviewCount: () => 1
  };
  const home = adminViews.reviewsList(SETTINGS, db, null, 1);
  assert.match(home, /id="rv-wait"/, 'неодобренный виден сразу на входе');
  assert.equal(/id="rv-ok"/.test(home), false, 'опубликованный в очередь не попадает');
  // Подкраска — не украшение: в общей ленте неразобранное надо находить взглядом.
  assert.match(home, /class="rv-row is-pending" id="rv-wait"/);
  const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'styles.css'), 'utf8');
  assert.match(css, /\.rv-row\.is-pending\{[^}]*background:#fffaf2/);

  // И тот же список — по товарам, каждый открывается отдельно.
  assert.match(home, /href="\/admin\/reviews\/product\/p"/);
  assert.match(home, /class="rv-prod-wait"[^>]*>1</, 'у товара виден счётчик очереди');

  // На входе ВСЁ: ни вкладок, ни сортировки, ни абзаца-подсказки. Выбирать в
  // очереди нечего, а вкладки отвечали на вопрос, который здесь не задают.
  assert.equal(/class="a-tabs"/.test(home), false, 'вкладок на входе быть не должно');
  assert.equal(/class="a-sorts"/.test(home), false, 'сортировки на входе быть не должно');
  assert.equal(home.includes('На витрине видны только опубликованные'), false, 'подсказка убрана');

  // Разобранная очередь не оставляет ни пустой карточки, ни заголовка: сразу
  // отзывы по товарам.
  const clean = Object.assign({}, db, {
    getReviews: () => reviews.filter(r => r.status === 'approved'), pendingReviewCount: () => 0
  });
  const done = adminViews.reviewsList(SETTINGS, clean, null, 1);
  assert.equal(/class="rv-row/.test(done), false, 'разбирать нечего — строк нет');
  assert.equal(done.includes('Очередь пуста'), false, 'пустой карточки быть не должно');
  assert.ok(done.includes('Отзывы по товарам'), 'плитки товаров остаются');

  // Вкладки и сортировка живут в ленте товара — там их и выбирают.
  const one = Object.assign({}, db, { reviewsForProduct: () => reviews, ratingFor: () => ({ avg: 5, count: 1 }) });
  const page = adminViews.productReviews(SETTINGS, one, { id: 'p', name: 'Товар' }, null, null, 1);
  assert.match(page, /id="rv-wait"/);
  assert.match(page, /id="rv-ok"/);
  assert.match(page, /class="a-tabs"/);
  assert.match(page, /class="a-sorts"/);
  // Действие над строкой обязано вернуть в ленту этого же товара.
  assert.match(page, /name="product" value="p"/);
});

test('вложения в панели открываются той же галереей, что и на витрине', () => {
  // Раньше клик по снимку в панели просто открывал файл в новой вкладке: чтобы
  // посмотреть все вложения отзыва, приходилось открывать их по одному.
  const rv = {
    id: 'r1', productId: 'p', author: 'А', rating: 5, text: 'т', status: 'pending', createdAt: 1,
    videos: ['v1.mp4'], photos: ['p1.webp', 'p2.webp', 'p3.webp', 'p4.webp', 'p5.webp', 'p6.webp', 'p7.webp'],
    previews: { 'v1.mp4': 'v1-p.webp', 'p1.webp': 'p1-t.webp' }
  };
  const db = {
    getReviews: () => [rv], getProducts: () => [{ id: 'p', name: 'Товар' }],
    reviewStats: () => new Map([['p', { total: 1, approved: 0, pending: 1, avg: 5 }]]),
    pendingReviewCount: () => 1
  };
  const list = adminViews.reviewsList(SETTINGS, db, null, 1);
  const group = list.slice(list.indexOf('<div class="rv-thumbs"'), list.indexOf('</div>', list.indexOf('<div class="rv-thumbs"')));
  assert.match(group, /<div class="rv-thumbs" data-media>/, 'группу просмотрщик ищет по data-media');
  // Порядок тот же, что на витрине: видео первым, нумерация сквозная.
  const kinds = (group.match(/data-kind="(photo|video)"/g) || []).map(s => s.slice(11, -1));
  assert.equal(kinds[0], 'video');
  assert.equal(kinds.length, 8, 'в галерее все вложения, а не только показанные');
  // В ленте — лёгкое превью, полный файл только в просмотрщике.
  assert.match(group, /<img src="\/uploads\/v1-p\.webp"/);
  assert.match(group, /href="\/uploads\/v1\.mp4"/);
  // Сверх шестого — ссылки без картинок и скрытые: грузить полсотни превью ради
  // строки списка незачем, но листать галерею должно быть куда.
  assert.equal((group.match(/<img /g) || []).length, 6, 'картинок ровно шесть');
  assert.match(group, /class="rv-thumb rv-thumb-more"[^>]*>\+2</);
  assert.match(group, /<a class="rv-thumb" href="\/uploads\/p7\.webp"[^>]* hidden /);
  // hidden обязан побеждать display:flex — иначе скрытые ссылки видно.
  const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'styles.css'), 'utf8');
  assert.match(css, /\.rv-thumb\[hidden\]\{display:none\}/);

  // В форме правки клик по снимку открывает просмотр, а помечает к удалению
  // только крестик: обёрнутая в <label> плитка делала бы и то и другое разом.
  const form = adminViews.reviewForm(SETTINGS, Object.assign({}, db, { getProducts: () => [{ id: 'p', name: 'Товар' }] }), rv, { back: {} });
  assert.match(form, /<div class="rv-files" data-media>/);
  assert.match(form, /<a class="rv-file-body" href="\/uploads\/v1\.mp4" data-kind="video"/);
  assert.match(form, /<label class="rv-file-x" for="drop-0"/);
  assert.equal(/<label class="rv-file"/.test(form), false, 'плитка целиком не должна быть меткой');
});

test('в панели отзывы сортируются теми же тремя способами, что на витрине', () => {
  const reviews = [
    { id: 'a', productId: 'p', author: 'А', rating: 5, text: 'т', status: 'approved', createdAt: 3 },
    { id: 'b', productId: 'p', author: 'Б', rating: 2, text: 'т', status: 'approved', createdAt: 2 },
    { id: 'c', productId: 'p', author: 'В', rating: 4, text: 'т', status: 'approved', createdAt: 1 }
  ];
  const db = {
    getReviews: () => reviews, reviewsForProduct: () => reviews,
    getProducts: () => [{ id: 'p', name: 'Товар' }], ratingFor: () => ({ avg: 4, count: 3 }),
    reviewStats: () => new Map([['p', { total: 3, approved: 3, pending: 0, avg: 4 }]]),
    pendingReviewCount: () => 0
  };
  const ids = html => [...html.matchAll(/id="rv-([a-z])"/g)].map(m => m[1]);

  // Сортировка живёт в ленте товара: на входе в раздел лежит очередь модерации,
  // и порядок в ней один — свежие сверху.
  // Подписи берутся из того же REVIEW_SORTS, что и на витрине: «Новые» в панели
  // и «Новые» на витрине обязаны означать одно и то же.
  const page = adminViews.productReviews(SETTINGS, db, { id: 'p', name: 'Товар' }, 'all', null, 1, null);
  for (const [key, label] of render.REVIEW_SORTS) {
    assert.ok(page.includes('sort=' + key), 'нет ссылки на сортировку ' + key);
    assert.ok(page.includes('>' + label + '</a>'), 'нет подписи ' + label);
  }
  const sorted = m => adminViews.productReviews(SETTINGS, db, { id: 'p', name: 'Товар' }, 'all', null, 1, m);
  assert.deepEqual(ids(page), ['a', 'b', 'c'], 'по умолчанию — свежие сверху');
  assert.deepEqual(ids(sorted('low')), ['b', 'c', 'a']);
  assert.deepEqual(ids(sorted('high')), ['a', 'c', 'b']);
  // Мусор в адресе приводится к порядку по умолчанию, а не роняет страницу.
  assert.deepEqual(ids(sorted('абв')), ['a', 'b', 'c']);

  // Выбранная сортировка уезжает в формы действий, чтобы после «Одобрить» не
  // вернуться в «Новые».
  const one = sorted('low');
  assert.match(one, /name="sort" value="low"/);
  assert.match(one, /href="\/admin\/reviews\/product\/p\?status=all&amp;sort=high&amp;media=all"/);
});

test('форма правки отзыва меняет всё, что видит покупатель', () => {
  const rv = {
    id: 'r1', productId: 'p', author: 'Ирина', rating: 4, text: 'Хороший телефон',
    config: 'Синий · 256 ГБ', delivery: 'cdek', status: 'pending', createdAt: Date.UTC(2026, 0, 5),
    photos: ['a.webp'], videos: ['v.mp4'], previews: { 'a.webp': 'a-t.webp' }
  };
  const db = {
    getProducts: () => [{ id: 'p', name: 'Товар' }, { id: 'q', name: 'Другой' }],
    pendingReviewCount: () => 1
  };
  const html = adminViews.reviewForm(SETTINGS, db, rv, { back: { status: 'pending', page: 2 } });
  for (const field of ['name="productId"', 'name="status"', 'name="author"', 'name="rating"',
    'name="date"', 'name="delivery"', 'name="config"', 'name="text"', 'name="photos"']) {
    assert.ok(html.includes(field), 'в форме нет поля ' + field);
  }
  assert.match(html, /value="Ирина"/);
  assert.match(html, /<option value="cdek" selected>/, 'перевозчик выбран по отзыву');
  assert.match(html, /<option value="pending" selected>/, 'состояние выбрано по отзыву');
  assert.ok(html.includes('Хороший телефон'), 'текст подставлен в поле');
  // Вложения удаляются галочкой — ни строчки скрипта, поэтому форма работает и
  // там, где скрипты панели не загрузились.
  assert.match(html, /name="drop" value="a\.webp"/);
  assert.match(html, /name="drop" value="v\.mp4"/);
  // Возврат из формы ведёт туда же, откуда пришли. Вкладка приезжает полем
  // `tab`, а не `status`: у формы уже есть свой `status` — состояние отзыва, — и
  // два поля с одним именем ушли бы на сервер массивом, из-за чего отзыв
  // сохранялся бы «на модерации» что ни выбери.
  assert.match(html, /name="page" value="2"/);
  assert.match(html, /name="tab" value="pending"/);
  assert.equal(/name="status" value=/.test(html), false, 'вкладка не должна называться status');

  // Новый отзыв — та же форма, без полей возврата и без вложений.
  const fresh = adminViews.reviewForm(SETTINGS, db, null, { productId: 'q' });
  assert.match(fresh, /<option value="q" selected>/);
  assert.equal(/name="drop"/.test(fresh), false);
});

test('опубликованный отзыв снимается с витрины, а не только удаляется', () => {
  // Прятать отзыв в админке домена было больше негде и не от кого, но убрать
  // неудачный со страницы товара по-прежнему нужно — а удаление слишком грубо:
  // отзыв покупателя восстановить неоткуда.
  const reviews = [
    { id: 'ok', productId: 'p', author: 'А', rating: 5, text: 'т', status: 'approved', createdAt: 2, photos: [] },
    { id: 'wait', productId: 'p', author: 'Б', rating: 4, text: 'т', status: 'pending', createdAt: 1, photos: [] }
  ];
  const db = {
    getReviews: () => reviews, getProducts: () => [{ id: 'p', name: 'Товар' }],
    reviewsForProduct: () => reviews, ratingFor: () => ({ avg: 5, count: 1 }),
    reviewStats: () => new Map([['p', { total: 2, approved: 1, pending: 1, avg: 5 }]]),
    pendingReviewCount: () => 1
  };
  // Обе кнопки видно в ленте товара: на входе в раздел лежит только очередь, а
  // в ней снимать с витрины нечего.
  const html = adminViews.productReviews(SETTINGS, db, { id: 'p', name: 'Товар' }, 'all', null, 1);
  assert.match(html, /action="\/admin\/reviews\/wait\/approve"/, 'у ожидающего — «Одобрить»');
  assert.match(html, /action="\/admin\/reviews\/ok\/hide"/, 'у опубликованного — «Снять с витрины»');

  // Маршрут возвращает отзыв в очередь модерации, а не удаляет его.
  const source = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const route = source.slice(source.indexOf("app.post('/admin/reviews/:id/hide'"));
  assert.match(route.slice(0, 300), /setReviewStatus\(req\.params\.id, 'pending'\)/);
});

test('ответ магазина виден под отзывом и подписан как ответ', () => {
  const at = Date.UTC(2026, 7, 18, 9, 0, 0);
  const card = render.reviewCard({
    id: 'r', author: 'Наташа', rating: 5, text: 'Пришло за два дня', createdAt: at,
    reply: { text: 'Спасибо за отзыв!\nПишите, если что', at }
  });
  assert.match(card, /<div class="review-reply">/);
  assert.match(card, /Ответ магазина/);
  assert.match(card, /<p class="rr-text">Спасибо за отзыв!\nПишите, если что<\/p>/,
    'переносы строк остаются в тексте — их показывает white-space:pre-line, а не <br> в разметке');
  assert.match(card, /class="rr-when" datetime="2026-08-18/);

  // Ответа нет — нет и блока: пустая серая плашка под каждым отзывом.
  const bare = render.reviewCard({ id: 'r', author: 'Наташа', rating: 5, text: 'т', createdAt: at });
  assert.doesNotMatch(bare, /review-reply/);
  assert.doesNotMatch(render.reviewCard({ id: 'r', author: 'А', rating: 5, createdAt: at, reply: { text: '   ' } }), /review-reply/,
    'пробелы — это не ответ');

  // Ответ пишет человек в панели, но экранируется он как любое чужое значение.
  assert.doesNotMatch(render.reviewCard({ id: 'r', author: 'А', rating: 5, createdAt: at, reply: { text: '<script>alert(1)</script>' } }), /<script>/);

  // Названия магазина в шапке нет намеренно: продавец на витрине один, его имя
  // стоит в шапке страницы и в подвале, и третий повтор ничего не добавляет.
  // Правило легко потерять, дописав сюда «name» из настроек.
  assert.doesNotMatch(render.reviewReply({ reply: { text: 'т', at } }), /iStore|Магазин«|storeName/);

  // Плашка нарисована в CSS: без стиля она читалась бы как второй отзыв.
  const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'styles.css'), 'utf8');
  assert.match(css, /\.rr-text\{[^}]*white-space:pre-line/);
  assert.match(css, /\.review-reply\{/);
});

test('ответ магазина правится из строки списка и переживает ночную пересборку', () => {
  const reviews = [
    { id: 'ok', productId: 'p', author: 'А', rating: 5, text: 'т', status: 'approved', createdAt: 2, photos: [], reply: { text: 'Спасибо за отзыв!', at: 1 } },
    { id: 'wait', productId: 'p', author: 'Б', rating: 4, text: 'т', status: 'pending', createdAt: 1, photos: [] }
  ];
  const db = {
    getReviews: () => reviews, getProducts: () => [{ id: 'p', name: 'Товар' }],
    reviewsForProduct: () => reviews, ratingFor: () => ({ avg: 5, count: 1 }),
    reviewStats: () => new Map([['p', { total: 2, approved: 1, pending: 1, avg: 5 }]]),
    pendingReviewCount: () => 1
  };
  const html = adminViews.productReviews(SETTINGS, db, { id: 'p', name: 'Товар' }, 'all', null, 1);
  // Отвечают там же, где разбирают ленту: форма стоит прямо в строке.
  assert.match(html, /action="\/admin\/reviews\/ok\/reply"/);
  assert.match(html, /action="\/admin\/reviews\/wait\/reply"/);
  assert.match(html, /<textarea id="reply-wait" name="reply"/);
  // Свёрнутая строка сама говорит, есть ответ или нет.
  assert.match(html, /Ответ магазина<\/b><i class="rv-reply-cut">: Спасибо за отзыв!/);
  assert.match(html, /Ответа магазина пока нет/);
  // Удаление ответа — вторая кнопка отправки той же формы, и только у отвеченного.
  assert.equal((html.match(/name="drop" value="1"/g) || []).length, 1);

  // Форма правки отзыва меняет всё, что видит покупатель, — ответ в том числе.
  const form = adminViews.reviewForm(SETTINGS, db, reviews[0], {});
  assert.match(form, /<textarea name="reply"[^>]*>Спасибо за отзыв!<\/textarea>/);

  // Маршрут: пустой текст — это удаление, поэтому отдельной ручки для него нет.
  const source = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const route = source.slice(source.indexOf("app.post('/admin/reviews/:id/reply'"));
  assert.match(route.slice(0, 600), /req\.body\.drop \? '' : String\(req\.body\.reply/);

  // Ночная пересборка демо-набора ответ не стирает: его писал человек, а cron
  // ходит каждую ночь — пропажу заметили бы случайно и не сразу.
  const script = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'demo-reviews.js'), 'utf8');
  assert.match(script, /previous && previous\.reply/);
});

test('ответ магазина хранится с датой и снимается пустым текстом', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'review-reply-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = freshDb(dir);
  const rv = store.createReview({ productId: 'p', author: 'А', rating: 5, text: 'т' });
  assert.equal(rv.reply, null, 'поля нет — ответа нет, старые записи читаются без миграции');

  const answered = store.updateReview(rv.id, { reply: { text: '  Спасибо!  ' } });
  assert.equal(answered.reply.text, 'Спасибо!');
  assert.ok(answered.reply.at > 0);

  // Правка опечатки дату не двигает: «Ответ магазина от сегодня» под отзывом
  // трёхмесячной давности читался бы как новый ответ.
  const fixed = store.updateReview(rv.id, { reply: { text: 'Спасибо!!' } });
  assert.equal(fixed.reply.at, answered.reply.at);

  // Пустой текст — это удаление ответа.
  assert.equal(store.updateReview(rv.id, { reply: { text: '' } }).reply, null);

  // У привезённого отзыва показанная дата каждую ночь раздаётся заново, и
  // оставшийся на месте ответ оказался бы написан раньше самого отзыва.
  const shifter = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'shift-review-dates.js'), 'utf8');
  assert.match(shifter, /rv\.reply\.at \+= next - \(Number\(rv\.createdAt\) \|\| next\)/,
    'ответ обязан ехать вместе с датой отзыва');

  // Поле не пришло вовсе — ответ остаётся как был (updateReview меняет только
  // пришедшее, и правка имени не должна стирать ответ).
  store.updateReview(rv.id, { reply: { text: 'Здравствуйте!' } });
  assert.equal(store.updateReview(rv.id, { author: 'Б' }).reply.text, 'Здравствуйте!');
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

test('подписи полей панели связаны с элементами форм', () => {
  const login = adminViews.loginPage({ storeName: 'Тест' }, null);
  assert.match(login, /<label for="admin-login">Логин<\/label><input id="admin-login"/);
  assert.match(login, /<label for="admin-password">Пароль<\/label><input id="admin-password"/);
  const page = adminViews.settingsPage({ storeName: 'Тест', adminUsername: 'admin' }, { pendingReviewCount: () => 0 });
  const named = page.match(/<label for="(admin-field-\d+)">Название магазина[^<]*<\/label><input[^>]*id="\1"/);
  assert.ok(named, 'подпись «Название магазина» не связана со своим полем');
  assert.match(page, /<label for="admin-field-\d+">Слоган<\/label><input/);
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

test('панель одна: /owner уводит на /admin, а прав меньше не бывает', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

  // Прежняя панель владельца жила на /owner, и её адреса остались в закладках.
  assert.match(source, /if \(\/\^\\\/owner\(\?:\\\/\|\$\)\/\.test\([\s\S]*?\) return res\.redirect\('\/admin'\)/,
    'адреса прежней панели обязаны уводить на новую, а не в 404');

  // Ни одного маршрута прежней панели и ни одной второй учётной записи.
  assert.equal(/app\.(get|post)\('\/owner/.test(source), false, 'маршруты /owner должны быть сняты целиком');
  assert.equal(/ownerPasswordHash|ownerUsername/.test(source), false, 'вторая учётка ушла вместе с панелью');
  assert.equal(/\/admin\/catalog|setSiteOverrides|siteAdmin/.test(source), false, 'урезанная админка домена ушла тоже');

  // Все разделы панели закрыты одним guard: пропущенный открыл бы каталог всем.
  const panel = source.slice(source.indexOf('/* =========================== ПАНЕЛЬ'));
  const routes = [...panel.matchAll(/app\.(get|post)\('(\/admin[^']*)'/g)];
  assert.ok(routes.length > 15, 'маршруты панели не найдены — проверьте разметку блока');
  const open = new Set(['GET /admin/login', 'POST /admin/login', 'POST /admin/logout']);
  for (const found of routes) {
    const name = found[1].toUpperCase() + ' ' + found[2];
    if (open.has(name)) continue;
    const body = panel.slice(found.index, found.index + 500);
    assert.match(body, /guardAdmin\(req, res\)|guardApi\(req, res\)/, 'раздел без проверки входа: ' + name);
  }

  // Маркер сессии завязан на текущие логин и хеш: смена реквизитов обязана
  // разлогинивать все открытые сессии сама.
  assert.match(source, /function authStamp\(username, passwordHash\)/);
  assert.match(source, /req\.session\.admin === authStamp\(s\.adminUsername, s\.adminPasswordHash\)/);
});

test('домен нигде не выбирается приложением — его задаёт прокси', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  // Под новый домен арендуется свой VPS со своей копией. Приложение host не
  // разбирает вовсе — иначе перенос на другое имя снова стал бы правкой данных.
  assert.equal(/siteOf\(|resolveSite|getSiteByHost|ALLOW_SITE_QUERY|previewSite/.test(source), false);
  assert.equal(fs.existsSync(path.join(__dirname, '..', 'lib', 'tenancy.js')), false);
  assert.equal(fs.existsSync(path.join(__dirname, '..', 'lib', 'site-views.js')), false);
  // Ни один файл проекта больше не читает список сайтов.
  const files = ['server.js', 'seed-data.js', 'seed.js', 'sync-prices.js', 'merge-products.js', 'add-novinki.js']
    .concat(fs.readdirSync(path.join(__dirname, '..', 'lib')).map(f => path.join('lib', f)));
  for (const file of files) {
    const text = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
    assert.equal(/db\.getSites\(|db\.getSite\(|saveSites\(/.test(text), false, 'список сайтов ещё читается: ' + file);
  }
});

test('заказ и отзыв больше не помечаются доменом, а прежние читаются как были', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'store-no-site-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'products.json'), '[]');
  fs.writeFileSync(path.join(dir, 'reviews.json'), '[]');
  const store = freshDb(dir);
  store.ensureSeeded();

  // Чужое поле в заявку не попадает: писать в неё домен больше нечему.
  const order = store.createOrder({ items: [], total: 100, contact: 'tg', host: 'shop.test', siteId: 'x', siteName: 'X' });
  assert.equal(order.siteId, undefined);
  assert.equal(order.siteName, undefined);
  assert.equal(order.host, 'shop.test', 'каким именем открыли магазин — по-прежнему пишем');
  const review = store.createReview({ productId: 'p', author: 'А', rating: 5, siteId: 'x', siteName: 'X' });
  assert.equal(review.siteId, undefined);
  assert.equal(review.siteName, undefined);

  // А прежние заявки со своим siteId читаются и показываются как были.
  const list = store.getOrders();
  list.push({ id: 'old', number: '1', siteId: 'site-a', siteName: 'Первый', total: 5, items: [], createdAt: Date.now() });
  fs.writeFileSync(path.join(dir, 'orders.json'), JSON.stringify(list));
  const again = freshDb(dir);
  assert.equal(again.visibleOrders().length, 2, 'заявки прежних доменов остаются в списке');
});

test('оформление, поиск и 404 закрыты от индексации, каталог — открыт', () => {
  const settings = { storeName: 'Тест', tagline: 'Слоган', currency: '₽' };
  const fakeDb = { getProducts: () => [], visibleProducts: () => [], categories: () => [], visibleCategories: () => [], ratingFor: () => ({ avg: 0, count: 0 }) };
  assert.match(render.checkoutPage(settings, {}), /<meta name="robots" content="noindex,follow">/);
  assert.match(render.homePage(settings, fakeDb, { q: 'iphone' }), /content="noindex,follow"/);
  assert.match(render.homePage(settings, fakeDb, { q: '', noindex: true }), /content="noindex,follow"/);
  assert.match(render.homePage(settings, fakeDb, {}), /content="index,follow">/);
  assert.match(render.homePage(settings, fakeDb, { category: 'iPhone' }), /content="noindex,follow">/);

  const macs = [{ id: 'mac', name: 'Mac', category: 'Mac', price: 100, inStock: true }];
  const categoryDb = {
    getProducts: () => macs, visibleProducts: () => macs,
    categories: () => ['Mac'], visibleCategories: () => ['Mac'], ratingFor: () => ({ avg: 0, count: 0 })
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

test('панель отдаёт закрытое правило :root и красится акцентом магазина', () => {
  const settings = { storeName: 'Магазин', accentColor: '#123456' };
  for (const html of [adminViews.loginPage(settings, null), adminViews.dashboard(settings, fakePanelDb())]) {
    const style = html.match(/<style>([^<]*)<\/style>/);
    assert.ok(style, 'нет блока стилей');
    assert.equal(style[1], ':root{--accent:#123456}');
    // Панель не для поисковика: её адреса попадали в выдачу через страницу входа.
    assert.match(html, /<meta name="robots" content="noindex, nofollow">/);
  }
  // Чужой цвет в атрибут не уедет: cssColor пропускает только #rgb и #rrggbb.
  const bad = adminViews.loginPage({ storeName: 'Т', accentColor: 'red;}body{display:none' }, null);
  assert.equal(bad.match(/<style>([^<]*)<\/style>/)[1], ':root{--accent:#1d1d1f}');
});

function fakePanelDb() {
  return {
    visibleOrders: () => [], getProducts: () => [], visibleProducts: () => [], getReviews: () => [],
    ratingFor: () => ({ avg: 0, count: 0 }), pendingReviewCount: () => 0
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
  const html = adminViews.productForm(SETTINGS, { categories: () => [], visibleCategories: () => [], pendingReviewCount: () => 0 }, product);
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
    getOrders: () => [long], visibleOrders: () => [long],
    getProducts: () => [], visibleProducts: () => [], pendingReviewCount: () => 0
  };
  const panels = { 'панель': adminViews.ordersList(SETTINGS, db, null, 1) };
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
    // Имя и контакты — разные элементы, а не одна строка через «·»: набраны они
    // по-разному, и разделитель рисует CSS. Слитно строка читалась одним пятном.
    assert.match(html, /<details class="o-who"><summary><span class="o-head"><b class="o-name">Анна Смирнова<\/b><span class="o-contact">@anna<\/span><\/span><\/summary>/, name);
    assert.doesNotMatch(html, /o-name">[^<]*·/, 'разделитель не должен уезжать в текст: ' + name);
    // Длинный заказ сворачивается после трёх позиций.
    assert.match(html, /class="o-rest"><summary>ещё 3 позиции<\/summary>/, name);
    // Свёртки «Откуда зашёл» больше нет: строка значков и есть ссылка в метрику,
    // а IP с провайдером лежат там же, в карточке посетителя.
    assert.doesNotMatch(html, /Откуда зашёл|o-tech/, name);
    // Удаление доступно и у финансового заказа: DB отправляет его в архив,
    // поэтому callback не теряет платёжную историю.
    assert.match(html, /id="orders-edit" class="edit-switch/, name);
    assert.match(html, /orders\/o1\/delete/, name);
    assert.match(html, /aria-label="Удалить заказ"/, name);
    assert.doesNotMatch(html, /Удаление запрещено|🔒/, name);
    assert.match(html, /Удалённые <b>0<\/b>/, name);
  }
  const unpaid = Object.assign({}, long, { payment: null });
  const unpaidDb = Object.assign({}, db, { getOrders: () => [unpaid], visibleOrders: () => [unpaid] });
  assert.match(adminViews.ordersList(SETTINGS, unpaidDb, null, 1), /orders\/o1\/delete/,
    'заявку без платёжной истории тоже можно удалить');
  const archived = Object.assign({}, long, { archive: { active: true, at: Date.now(), by: 'admin' } });
  const archivedDb = Object.assign({}, db, {
    getOrders: () => [archived], visibleOrders: () => [], archivedOrders: () => [archived]
  });
  const archivedHtml = adminViews.ordersList(SETTINGS, archivedDb, null, 1, 'archive');
  assert.match(archivedHtml, /orders\/o1\/restore/);
  assert.match(archivedHtml, /aria-label="Восстановить заказ"/);
  assert.doesNotMatch(archivedHtml, /orders\/o1\/delete/);

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

test('меню панели — одна кнопка в шапке и выпадающий список разделов', () => {
  const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'styles.css'), 'utf8');
  const js = fs.readFileSync(path.join(__dirname, '..', 'public', 'admin-ui.js'), 'utf8');
  const db = {
    getProducts: () => [], visibleProducts: () => [], visibleOrders: () => [],
    getOrders: () => [], pendingReviewCount: () => 3, categories: () => [], visibleCategories: () => [], ratingFor: () => ({ avg: 0, count: 0 })
  };
  const html = adminViews.dashboard(SETTINGS, db);
  // Кнопка стоит в шапке, список выпадает под ней. Ни боковой колонки, ни ленты
  // разделов, ни кнопки выхода рядом с ними.
  assert.match(html, /<div class="a-topbar" data-live-part="topbar"><details class="a-menu" id="a-menu">/);
  assert.match(html, /<summary class="a-menu-btn"/);
  assert.match(html, /<div class="a-menu-drop">/);
  assert.equal(/a-sidebar/.test(html), false, 'боковой колонки больше нет');
  assert.equal(/\/admin\/logout/.test(html), false, 'выход переехал в настройки');
  assert.match(html, /admin-ui\.js/);
  // Меню на <details>: без скрипта оно всё равно раскрывается, а состояние
  // нигде не хранится — значит, и моргать на загрузке нечему.
  assert.equal(/nav-off|admin_nav_off/.test(html + css + js), false, 'прежнего состояния меню не осталось');
  // Счётчик очереди виден и со свёрнутым меню — иначе о нём не узнать вовсе.
  assert.match(html, /<span class="a-menu-dot">3<\/span>/);
  // У каждого раздела свой значок — раздел опознаётся по нему быстрее, чем по слову.
  assert.equal((html.match(/class="a-nav-ico"/g) || []).length, 6, 'значки не у всех разделов');
  // Незнакомый ключ не ломает разметку: подпись раздела остаётся и без значка.
  assert.equal(render.adminIcon('выдумка'), '');
  assert.equal(render.adminIcon(''), '');
  assert.match(render.adminIcon('orders'), /<svg class="a-nav-ico"/);

  // Колонки нет — содержимое раздаётся во всю ширину.
  assert.match(css, /\.a-content\{width:100%;max-width:1500px/);
  // Список выпадает поверх страницы, а не раздвигает шапку.
  assert.match(css, /\.a-menu\{position:relative/);
  assert.match(css, /\.a-menu-drop\{position:absolute/);
  // Своя стрелка-маркер у <summary> убрана: кнопка тут своя.
  assert.match(css, /\.a-menu>summary\{list-style:none\}/);
  assert.match(css, /\.a-menu>summary::-webkit-details-marker\{display:none\}/);
  // Скрипту остаётся то, чего <details> не умеет: клик мимо и Esc.
  assert.match(js, /menu\.open = false/);
  assert.match(js, /Escape/);

  // Выход теперь на странице настроек, отдельной карточкой.
  const settings = adminViews.settingsPage(SETTINGS, db);
  assert.match(settings, /<form action="\/admin\/logout" method="post">/);
  assert.match(settings, /class="a-panel a-exit"/);

  // Заказы на телефоне — карточками: таблица в семь столбцов в ленту не влезает.
  assert.match(css, /\.a-table\.a-orders\{min-width:0;display:block\}/);
  assert.match(css, /\.a-orders thead\{display:none\}/);
});

test('списки заказов в панелях листаются, а не выгружаются целиком', () => {
  // Та же ловушка, что была у отзывов: заказы не удаляются сами, список растёт
  // без предела. На 3000 заявок страница весила 2,8 МБ и держала единственный
  // поток около 100 мс — всё это время витрина не отвечала никому.
  const per = render.ADMIN_PER_PAGE;
  const many = Array.from({ length: per * 3 + 7 }, (_, i) => ({
    id: 'o' + i, number: String(500000 + i), siteName: 'Магазин',
    items: [{ id: 'p', name: 'Товар', price: 100, qty: 1 }], total: 100,
    customerName: 'Клиент ' + i, contact: '@u' + i, status: 'new', createdAt: 2000 - i
  }));
  const db = {
    getOrders: () => many, visibleOrders: () => many,
    getProducts: () => [], visibleProducts: () => [], pendingReviewCount: () => 0
  };
  const rows = html => (html.match(/<tr id="order-/g) || []).length;

  const first = adminViews.ordersList(SETTINGS, db, null, 1);
  assert.equal(rows(first), per, 'на странице ровно один срез');
  assert.match(first, /href="\/admin\/orders\?page=2"/);
  assert.equal(rows(adminViews.ordersList(SETTINGS, db, null, 4)), 7, 'на последней странице остаток');

  // Номер страницы приходит из адреса — мусор и выход за край не должны падать.
  assert.equal(rows(adminViews.ordersList(SETTINGS, db, null, '999')), 7);
  assert.equal(rows(adminViews.ordersList(SETTINGS, db, null, 'абв')), per);
  assert.equal(rows(adminViews.ordersList(SETTINGS, db, null, -5)), per);

  // Порядок файла сохраняется: свежие заявки остаются на первой странице.
  assert.ok(first.indexOf('№500000') > -1, 'самый свежий заказ на первой странице');
  assert.equal(first.indexOf('№500150'), -1, 'заказы других страниц сюда не попадают');

  // Действие над строкой возвращает на ту же страницу, а не в начало списка.
  const page3 = adminViews.ordersList(SETTINGS, db, null, 3);
  assert.match(page3, /<input type="hidden" name="page" value="3">/);
});

test('форма настроек возвращает введённое, а не молча теряет правку', () => {
  // Прежде эту ловушку ловила админка домена: администратор писал «99 990» с
  // пробелом, видел «сохранено» — и терял прежнее значение. Настройки магазина
  // теперь одни, и правило то же: не сохранили — покажи, что было введено.
  const db = { pendingReviewCount: () => 0 };
  const saved = { storeName: 'Магазин', tagline: 'старый', accentColor: '#0071e3', adminUsername: 'admin' };
  const plain = adminViews.settingsPage(saved, db, null);
  assert.match(plain, /name="tagline" value="старый"/);
  assert.doesNotMatch(plain, /class="a-flash err"/);

  const draft = { storeName: '', tagline: 'новый слоган', contactPhone: '+7 900' };
  const failed = adminViews.settingsPage(saved, db, 'Укажите название магазина', 'err', { draft });
  assert.match(failed, /name="tagline" value="новый слоган"/, 'введённое значение потеряно');
  assert.match(failed, /name="contactPhone" value="\+7 900"/);
  assert.match(failed, /class="a-flash err"/);

  // Снятая галочка приходит не значением, а ОТСУТСТВИЕМ поля. Если при возврате
  // с ошибкой искать её в сохранённых настройках, она снова отметится — и
  // второе «Сохранить» молча вернёт то, что админ только что снял.
  const on = { notifyReviews: true, crocopayEnabled: true, payMethods: ['SBP', 'TO_CARD'] };
  const off = adminViews.settingsPage(Object.assign({}, saved, on), db, 'Ошибка', 'err',
    { draft: { storeName: 'Магазин' } });
  assert.doesNotMatch(off, /name="notifyReviews" checked/, 'снятая «уведомлять об отзывах» вернулась отмеченной');
  assert.doesNotMatch(off, /name="crocopayEnabled" checked/, 'снятая галочка кассы вернулась отмеченной');
  assert.doesNotMatch(off, /name="payMethods" value="SBP" checked/, 'снятый способ оплаты вернулся отмеченным');
  // А отмеченное в черновике — остаётся отмеченным, даже если в настройках снято.
  const back = adminViews.settingsPage(saved, db, 'Ошибка', 'err',
    { draft: { storeName: 'Магазин', notifyReviews: 'on', crocopayEnabled: 'on', payMethods: 'SBP' } });
  assert.match(back, /name="notifyReviews" checked/);
  assert.match(back, /name="crocopayEnabled" checked/);
  assert.match(back, /name="payMethods" value="SBP" checked/);

  // Маршрут обязан отклонять такую отправку, а не сохранять её.
  const source = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const route = source.slice(source.indexOf("app.post('/admin/settings'"));
  assert.match(route.slice(0, 900), /if \(!String\(req\.body\.storeName \|\| ''\)\.trim\(\)\) return fail/);
  assert.ok(route.indexOf('return fail') < route.indexOf('db.saveSettings'), 'проверка обязана идти до записи');
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
  const db = {
    getReviews: () => many, getProducts: () => [], visibleProducts: () => [],
    reviewStats: () => new Map(), pendingReviewCount: () => many.length
  };

  const page3 = adminViews.reviewsList(SETTINGS, db, null, 3);
  const forms = page3.match(/<form method="post" action="\/admin\/reviews\/[^"]+\/(approve|delete)">([\s\S]*?)<\/form>/g) || [];
  assert.ok(forms.length >= 2, 'на странице есть формы одобрения и удаления');
  for (const form of forms) {
    assert.match(form, /name="page" value="3"/, 'форма не несёт номер страницы');
    assert.match(form, /name="tab" value="pending"/, 'форма не несёт вкладку');
  }

  // Адрес возврата собирает сервер: вкладка «Все» и первая страница не должны
  // засорять ссылку, а мусор в скрытых полях — уводить куда-то ещё.
  const source = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const from = source.indexOf('const reviewsBackUrl =');
  const to = source.indexOf('\n};', from);
  assert.ok(from > -1 && to > from, 'reviewsBackUrl не найдена в server.js');
  const build = new Function('db', 'R', 'const REVIEW_TABS = ["pending","approved","all"];'
    + 'const REVIEW_MEDIA = ["all","video","photo","none"];'
    + source.slice(from, to + 3) + ' return reviewsBackUrl;')(
    { getProduct: id => id === 'p' ? { id: 'p' } : null }, render);
  assert.equal(build({ tab: 'approved', page: '3' }, 'Готово'), '/admin/reviews?status=approved&page=3&flash=' + encodeURIComponent('Готово'));
  // Вкладка по умолчанию у страниц разная: очередь открывается на «На модерации»,
  // лента товара — на «Все». В адрес пишем только отличие от неё.
  assert.equal(build({ tab: 'pending', page: '1' }), '/admin/reviews');
  assert.equal(build({ tab: 'нет-такой', page: 'абв' }), '/admin/reviews');
  assert.equal(build({ tab: 'all', page: -7 }), '/admin/reviews?status=all');
  // Разбирали ленту товара — туда и возвращаемся, а не в общую очередь.
  assert.equal(build({ tab: 'all', page: '2', product: 'p' }), '/admin/reviews/product/p?page=2');
  assert.equal(build({ tab: 'pending', page: '1', product: 'p' }), '/admin/reviews/product/p?status=pending');
  // Товара нет — возврат в общий список, а не на страницу, которой не существует.
  assert.equal(build({ tab: 'all', page: '1', product: 'нет' }), '/admin/reviews?status=all');
  // Сортировка возвращается тоже: разобрав низкие оценки, админ после каждого
  // действия оказывался бы снова в «Новых». По умолчанию её в адресе нет.
  assert.equal(build({ tab: 'all', sort: 'low', page: '1' }), '/admin/reviews?status=all&sort=low');
  assert.equal(build({ tab: 'all', sort: 'new', page: '1' }), '/admin/reviews?status=all');
  assert.equal(build({ tab: 'all', sort: 'мусор', page: '1' }), '/admin/reviews?status=all');
  // Отбор по вложениям возвращается так же: разбирая ленту роликов, после
  // каждого действия оказываться снова во «Всех» — то же, что терять место.
  assert.equal(build({ tab: 'all', media: 'video', page: '2', product: 'p' }), '/admin/reviews/product/p?media=video&page=2');
  assert.equal(build({ tab: 'all', media: 'all', page: '1', product: 'p' }), '/admin/reviews/product/p');
  assert.equal(build({ tab: 'all', media: 'мусор', page: '1', product: 'p' }), '/admin/reviews/product/p');
  // Маршруты обязаны пользоваться именно им, а не фиксированным адресом.
  assert.match(source, /approve[\s\S]{0,120}reviewsBackUrl\(req\.body/);
  assert.match(source, /deleteReview\(req\.params\.id\); res\.redirect\(reviewsBackUrl\(req\.body/);

  // Побеждает первый совпавший маршрут, а «/admin/reviews/:id/edit» подходит и
  // под «/admin/reviews/product/…». Переставь регистрацию — и лента товара
  // уйдёт в форму правки отзыва с id «product».
  const productRoute = source.indexOf(`app.get('/admin/reviews/product/:productId'`);
  const editRoute = source.indexOf(`app.get('/admin/reviews/:id/edit'`);
  assert.ok(productRoute > -1 && editRoute > -1, 'маршруты на месте');
  assert.ok(productRoute < editRoute, 'лента товара регистрируется раньше формы правки');
});

test('правка отзыва меняет поля, чистит файлы и не ломает привезённую дату', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'review-edit-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const DAY = 24 * 60 * 60 * 1000;
  const source = Date.UTC(2026, 0, 10);
  fs.writeFileSync(path.join(dir, 'products.json'), '[]');
  fs.writeFileSync(path.join(dir, 'reviews.json'), JSON.stringify([{
    id: 'r1', productId: 'p', author: 'Ирина', rating: 4, text: 'старый текст',
    config: '', delivery: 'cdek', status: 'pending', createdAt: source + 5 * DAY,
    sourceDate: source, source: 'ozon',
    photos: ['keep.webp', 'gone.webp'], videos: [], previews: { 'keep.webp': 'keep-t.webp', 'gone.webp': 'gone-t.webp' }
  }]));
  const store = freshDb(dir);
  for (const f of ['keep.webp', 'gone.webp', 'keep-t.webp', 'gone-t.webp']) {
    fs.writeFileSync(path.join(store.UPLOAD_DIR, f), 'x');
  }

  const next = source + 9 * DAY;
  const saved = store.updateReview('r1', {
    author: 'Ирина К.', rating: 5, text: 'новый текст', config: 'Синий · 256 ГБ',
    delivery: 'ozon', status: 'approved', createdAt: next, photos: ['keep.webp'], videos: []
  });
  assert.equal(saved.author, 'Ирина К.');
  assert.equal(saved.rating, 5);
  assert.equal(saved.text, 'новый текст');
  assert.equal(saved.delivery, 'ozon');
  assert.equal(saved.status, 'approved');
  assert.equal(saved.source, 'ozon', 'откуда отзыв — не переписываем');

  // Показанная дата у привезённого отзыва каждую ночь пересчитывается от
  // sourceDate: не подвинь мы её на ту же величину — правка молча откатилась бы
  // к утру. Сдвиг набора при этом сохраняется.
  assert.equal(saved.createdAt, next);
  assert.equal(saved.sourceDate, source + 4 * DAY, 'исходная дата уехала на ту же величину');
  const { plannedDates } = require('../lib/review-dates');
  assert.equal(plannedDates(store.getReviews(), next).size, 0, 'ночной прогон правку не откатывает');

  // Снятое вложение уходит вместе со своим превью и своим файлом, а оставшееся
  // цело: карта превью переживает удаление и держала бы файл в хранилище вечно.
  assert.deepEqual(saved.photos, ['keep.webp']);
  assert.deepEqual(saved.previews, { 'keep.webp': 'keep-t.webp' });
  assert.equal(fs.existsSync(path.join(store.UPLOAD_DIR, 'keep.webp')), true);
  assert.equal(fs.existsSync(path.join(store.UPLOAD_DIR, 'keep-t.webp')), true);
  assert.equal(fs.existsSync(path.join(store.UPLOAD_DIR, 'gone.webp')), false);
  assert.equal(fs.existsSync(path.join(store.UPLOAD_DIR, 'gone-t.webp')), false);

  // Не пришло поле — не тронули: частичная правка не должна затирать соседнее.
  const again = store.updateReview('r1', { rating: 3 });
  assert.equal(again.text, 'новый текст');
  assert.equal(again.author, 'Ирина К.');
  assert.equal(store.updateReview('нет-такого', { rating: 1 }), null);
});

test('оценка товара в каталоге читается из индекса, а не пересчётом отзывов', () => {
  // На главной десятки карточек. Раньше оценку считал viewFor() — по разу на
  // товар, полным проходом по его отзывам; теперь это готовая пара из индекса.
  const reviews = Array.from({ length: 49 }, (_, i) => ({ id: 'r' + i, productId: 'p', rating: 4, status: 'approved', createdAt: i }));
  let ratingCalls = 0, listCalls = 0;
  const db = {
    getProducts: () => [product], visibleProducts: () => [product],
    categories: () => ['К'], visibleCategories: () => ['К'],
    reviewsForProduct: () => { listCalls++; return reviews; },
    ratingFor: () => { ratingCalls++; return { avg: 4, count: 49 }; }
  };
  const product = { id: 'p', name: 'Товар', category: 'К', price: 100, inStock: true, images: [], colors: [], storages: [], bands: [], options: [] };
  const html = render.homePage({ storeName: 'Тест', currency: '₽' }, db, {});
  assert.match(html, /★|4/);
  assert.equal(ratingCalls, 1, 'на карточку — ровно одно обращение к индексу');
  assert.equal(listCalls, 0, 'список отзывов товара каталогу не нужен вовсе');
});

test('карточки посетителей метрики ищутся по индексу и он не расходится с массивом', () => {
  // findVisitor звали на каждый просмотр, heartbeat и заявку. Перебор массива
  // на потолке в 10 000 карточек — лишние доли миллисекунды в каждом запросе.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'metrics-index-'));
  try {
    const metrics = new Analytics({ dataDir: dir, geoEnabled: false, flushMs: 1e9 });
    const ids = Array.from({ length: 5 }, (_, i) => String(i).repeat(32));
    for (const id of ids) {
      metrics.recordPageView({ id, path: '/', host: 'x.ru', context: { device: 'Компьютер' } });
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

  // Словарь общий на обе кассы: покупатель не должен по формулировке отказа
  // догадываться, какая платёжка ему отказала (строки у них даже на разных
  // языках — английские у CrocoPAY, русские у MeridianPay).
  const meridian = require('../lib/meridianpay');
  assert.equal(meridian.startError('Requisites not found'), noReq);
  assert.equal(meridian.startError('Нет свободных реквизитов'), noReq);
  // «Мерчант на модерации» — штатный ответ MeridianPay на старте работы. Про
  // нашу модерацию покупателю знать незачем: для него способ просто недоступен.
  assert.match(meridian.startError('Мерчант находится на модерации.'), /способ оплаты сейчас недоступен/i);

  // Маршрут берёт текст оттуда же: разбор чужих ответов живёт рядом с остальным
  // знанием об их API, а не размазан по server.js.
  const start = server.slice(server.indexOf('async function requestInvoiceFrom('), server.indexOf("app.post('/api/pay/start'"));
  assert.match(start, /const code = PAYMENTS\.startErrorCode\(r\.error\)/);
  assert.match(start, /error: PAYMENTS\.startError\(code\)/);
  // Заказ при отказе кассы остаётся настоящим — иначе покупатель оформит второй.
  assert.match(start, /placed: true/);
  // В логе — имя кассы, способ и сумма: по одной строке «Requisites not found»
  // не понять ни на чём споткнулись, ни кто именно.
  assert.match(start, /console\.error\(p\.id \+ ' invoice:'[^)]*способ[^)]*сумма/);
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
    getProducts: () => [product], visibleProducts: () => [product], categories: () => ['Категория'], visibleCategories: () => ['Категория'],
    ratingFor: () => ({ avg: 0, count: 0 }), reviewsForProduct: () => []
  };

  // Полоса обязана быть на КАЖДОЙ странице витрины: покупатель возвращается не
  // обязательно на главную, а товары из корзины уже уехали в заказ — без неё он
  // о заказе просто забудет.
  const pages = {
    'главная': render.homePage(ss, db, { category: '', q: '', origin: '', payRemind: remind }, null),
    'товар': render.productPage(ss, db, product, { origin: '', payRemind: remind }),
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
  // Условие живого счёта одно на весь проект: страница оплаты, полоса
  // напоминания и плашка в панели обязаны считать «ждём перевод» одинаково —
  // иначе у покупателя счёт сгорел, а менеджер всё ещё ждёт деньги.
  assert.match(fn, /R\.payDisplay\(pay, now\)/, 'напоминание должно видеть живой старый invoice из истории');
  assert.match(fn, /R\.payLive\(shown, now\)/, 'своей копии условия у напоминания быть не должно');

  /* Заказ, счёт по которому не выставился (касса не ответила) или уже сгорел,
   * тоже напоминает о себе — но без срока: отсчитывать нечего, а вернуться на
   * страницу оплаты и выставить новый счёт покупатель должен уметь. Иначе
   * ссылки на свой заказ у него нет нигде. */
  assert.match(fn, /pay\.status === 'paid' \|\| pay\.status === 'mismatch'/, 'оплаченному напоминать нечего');
  assert.match(fn, /REMIND_TTL/, 'без срока давности напоминание превращается в навязчивость');
  assert.match(fn, /card\(order, 0\)/);
  const noTimer = render.homePage(ss, db, { category: '', q: '', origin: '', payRemind: { id: 'a1b2', number: '482913', total: 68200, expiresAt: 0 } }, null);
  assert.match(noTimer, /id="pay-remind" data-until="0"/);
  assert.match(noTimer, /ждёт оплаты/);
  // Ноль в data-until — это «срока нет», а не «время вышло»: полоса без срока
  // не должна исчезать сразу после загрузки страницы.
  const appJs = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  assert.match(appJs, /function payRemindDead\(\)[\s\S]{0,220}return !!until && until - Date\.now\(\) <= 0/);
  assert.match(appJs, /if \(!box \|\| payRemindDead\(\)\) return ''/);
  const live = { status: 'pending', invoiceId: 'inv', requisite: '79104693811', expiresAt: Date.now() + 60000 };
  assert.equal(render.payLive(live), true);
  const olderLive = Object.assign({ id: 'a'.repeat(24), startedAt: 1 }, live);
  const failedTop = {
    status: 'failed', attemptId: 'b'.repeat(24), attempts: [
      olderLive,
      { id: 'b'.repeat(24), status: 'failed', startedAt: 2, lastErrorCode: 'no_requisite' }
    ]
  };
  assert.equal(render.payDisplay(failedTop), olderLive,
    'failed наверху не скрывает прежние реквизиты, которые всё ещё можно оплатить');
  assert.equal(render.payLive(Object.assign({}, live, { expiresAt: Date.now() - 1 })), false, 'у сгоревшего счёта реквизиты уже чужие');
  assert.equal(render.payLive(Object.assign({}, live, { expiresAt: 0, startedAt: Date.now() })), false,
    'без подтверждённого срока реквизиты не показываем по угаданному TTL');
  assert.equal(render.payLive(Object.assign({}, live, { invoiceId: '', requisite: '' })), false, 'счёт так и не выставили');
  assert.equal(render.payLive(Object.assign({}, live, { status: 'paid' })), false);
  assert.equal(render.payLive(null), false);

  // Напоминание собирает pageOpts() — одна обвязка на все страницы витрины.
  // Раньше поле протаскивалось в каждый layout() поимённо, и забытая страница
  // молча оставалась без него.
  assert.match(fn, /function pageOpts\(req, extra\)/);
  assert.match(fn, /payRemind: payRemind\(req\)/);
  const routes = server.slice(server.indexOf('function pageOpts('), server.indexOf('/* =========================== ПАНЕЛЬ'));
  assert.equal(/payRemind:/.test(routes.replace(/payRemind: payRemind\(req\)/, '').replace('payRemind: null', '')), false,
    'страницы витрины не должны собирать напоминание сами — только через pageOpts()');

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

test('сумма вебхука читается строго в минимальных единицах', () => {
  const croco = require('../lib/crocopay');
  // Webhook документирован в минимальных единицах. Угадывать второе прочтение
  // опасно: raw=12200 может означать 122 ₽, а не полную оплату заказа 12 200 ₽.
  assert.deepEqual(croco.paidEnough(239990, 23999000), { ok: true, major: 239990 });
  assert.deepEqual(croco.paidEnough(239990, 239990), { ok: false, major: 2399.9 });
  assert.deepEqual(croco.paidEnough(12200, 12200), { ok: false, major: 122 });
  assert.equal(croco.paidEnough(100, 10000).ok, true, 'копейки распознаются');
  assert.equal(croco.paidEnough(100, 10000).major, 100);
  // Переплата законна, но и она передаётся в минимальных единицах.
  assert.equal(croco.paidEnough(1000, 120000).ok, true);
  assert.equal(croco.paidEnough(239990, 23998998).ok, false, 'двух копеек недоплаты достаточно для отказа');
  assert.equal(croco.paidEnough(100, 9998).ok, false);
  // Суммы нет вовсе — это не оплата.
  assert.deepEqual(croco.paidEnough(100, undefined), { ok: false, major: null });
  assert.deepEqual(croco.paidEnough(100, 'вообще не число'), { ok: false, major: null });
});

test('сверка счёта принимает только совпавшие id, валюту, сумму и способ', () => {
  const croco = require('../lib/crocopay');
  const expected = {
    invoiceId: '911c2823-f55b-43b5-9881-d5653107f7dc',
    currency: 'RUB', amount: 12200, method: 'TO_CARD'
  };
  const actual = {
    id: expected.invoiceId, currency: 'RUB', amount: 12200, method: 'TO_CARD'
  };

  assert.deepEqual(croco.matchesInvoice(expected, actual), { ok: true });
  assert.deepEqual(croco.matchesInvoice(expected, Object.assign({}, actual, { id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' })),
    { ok: false, reason: 'invoice_id' });
  assert.deepEqual(croco.matchesInvoice(expected, Object.assign({}, actual, { currency: 'USD' })),
    { ok: false, reason: 'currency' });
  assert.deepEqual(croco.matchesInvoice(expected, Object.assign({}, actual, { amount: 122 })),
    { ok: false, reason: 'amount' }, 'один процент суммы не становится полной оплатой');
  assert.deepEqual(croco.matchesInvoice(expected, Object.assign({}, actual, { amount: 12200.02 })),
    { ok: false, reason: 'amount' });
  assert.deepEqual(croco.matchesInvoice(expected, Object.assign({}, actual, { amount: 12199.99 })),
    { ok: false, reason: 'amount' }, 'даже одна копейка недоплаты не является точным совпадением');
  assert.deepEqual(croco.matchesInvoice(expected, Object.assign({}, actual, { method: 'TO_CARD_TRANSGRAN' })),
    { ok: false, reason: 'method' });
  // GET старых счетов может не содержать способ; остальные три поля всё равно
  // обязаны совпасть, а при наличии способа подмена запрещена.
  assert.deepEqual(croco.matchesInvoice(expected, Object.assign({}, actual, { method: '' })), { ok: true });
  assert.deepEqual(croco.matchesInvoice(Object.assign({}, expected, { actualMethod: 'TO_CARD_TRANSGRAN' }),
    Object.assign({}, actual, { method: '' })), { ok: false, reason: 'method' },
  'GET без paymentOption не стирает уже замеченную трансграничную подмену POST');
  assert.deepEqual(croco.matchesInvoice(Object.assign({}, expected, { actualMethod: '' }),
    Object.assign({}, actual, { method: '' })), { ok: false, reason: 'method' },
  'новый POST без подтверждённого способа не принимается по такому же пустому GET');
  assert.deepEqual(croco.matchesInvoice(Object.assign({}, expected, { actualMethod: '' }), actual),
    { ok: true }, 'явный точный способ в GET может подтвердить неполный POST');
  assert.deepEqual(croco.matchesInvoice(Object.assign({}, expected, { amount: 0 }), actual),
    { ok: false, reason: 'amount' });
  assert.equal(croco.sameStartRequest(expected, actual), true);
  assert.equal(croco.sameStartRequest(expected, Object.assign({}, actual, { method: 'SBP' })), false);
  assert.equal(croco.sameStartRequest(expected, Object.assign({}, actual, { currency: 'USD' })), false);
  assert.equal(croco.sameStartRequest(expected, Object.assign({}, actual, { amount: 12200.01 })), false);
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
  // Настройки теперь одни на всё, и в шаблон витрины уходит тот же объект —
  // значит ни один ключ не должен попадать в разметку ни одной страницы.
  const secret = Object.assign({}, ss, {
    dadataToken: 'КЛЮЧ-ПОДСКАЗОК', crocopayClientId: 'ГДЕ-ТО-КЛЮЧ', crocopayClientSecret: 'СЕКРЕТ-КАССЫ',
    telegramBotToken: 'ТОКЕН-БОТА', adminPasswordHash: 'ХЕШ', sessionSecret: 'СЕКРЕТ-СЕССИИ'
  });
  const pages = [
    render.homePage(secret, { getProducts: () => [], visibleProducts: () => [], visibleCategories: () => [], ratingFor: () => ({ avg: 0, count: 0 }) }, {}),
    render.checkoutPage(secret, { origin: '', payOnline: true }),
    render.privacyPage(secret, {}), render.warrantyPage(secret, {}), render.returnsPage(secret, {}),
    render.notFoundPage(secret, {})
  ];
  for (const html of pages) {
    assert.doesNotMatch(html, /КЛЮЧ-ПОДСКАЗОК|ГДЕ-ТО-КЛЮЧ|СЕКРЕТ-КАССЫ|ТОКЕН-БОТА|ХЕШ|СЕКРЕТ-СЕССИИ/);
  }
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
  const html = adminViews.settingsPage(settings, { pendingReviewCount: () => 0 }, null);
  assert.match(html, /name="payMethodsForm"/);
  assert.match(html, /name="payMethods" value="SBP" checked/);
  assert.match(html, /name="payMethods" value="TO_CARD"(?! checked)/);
  const empty = adminViews.settingsPage(Object.assign({}, settings, { payMethods: [] }), { pendingReviewCount: () => 0 }, null);
  assert.match(empty, /Не отмечен ни один способ/);

  // Скрытый способ не должен проходить запросом мимо интерфейса: и страница
  // оплаты, и создание счёта берут список у одной и той же payContext(), где
  // сходятся включённое у кассы, разрешённое в настройках и валюта счёта.
  const start = source.slice(source.indexOf('async function startPaymentRoute('), source.indexOf("app.post('/api/pay/start'"));
  assert.match(start, /ctx\.methods\.some\(m => m\.id === method\)/);
  // `answered`, а не `live`: ответ касс приходит теперь всегда (в нём лежит и
  // состояние каждой из них для панели), а ограничивать список способов вправе
  // только живой ответ — молчание кассы по-прежнему означает «условие не
  // применяем», а не «способов нет».
  assert.match(source, /PAY\.allowed\(answered \? \(answered\.byCurrency\[currency\] \|\| \[\]\) : null, s\.payMethods\)/);
  assert.equal((source.match(/PAY\.allowed\(/g) || []).length, 1, 'список способов собирается в одном месте');
});

test('способы и валюты в настройках приходят от кассы, а не из зашитого списка', () => {
  const pay = require('../lib/pay-methods');
  const croco = require('../lib/crocopay');
  const db = { pendingReviewCount: () => 0 };

  // Живой вид ответа — сгруппированный по валюте. Разбираем ВСЕ группы: список
  // валют счёта берётся отсюда же, а не из своей таблицы.
  const live = croco.parseOptions({
    payment_methods: [
      { code: 'RUB', options: [{ code: 'SBP' }, { code: 'NEW_FANCY_PAY' }] },
      { code: 'USD', options: [{ code: 'TO_CARD_TRANSGRAN' }] }
    ]
  });
  assert.deepEqual(live.currencies, ['RUB', 'USD']);
  assert.deepEqual(live.byCurrency.USD, ['TO_CARD_TRANSGRAN']);
  // Рубль первым всегда: цены магазина в нём, он же валюта по умолчанию.
  assert.deepEqual(croco.parseOptions({ payment_methods: [{ code: 'USD', options: [{ code: 'SBP' }] }, { code: 'RUB', options: [{ code: 'SBP' }] }] }).currencies, ['RUB', 'USD']);
  // Документированный плоский вид тоже читается — формат уже расходился дважды.
  assert.deepEqual(croco.parseOptions({ methods: [{ currency: 'RUB', payment_option: 'SBP' }] }).byCurrency.RUB, ['SBP']);

  const settings = Object.assign(dbCore.defaultSettings(), {
    crocopayEnabled: true, crocopayClientId: 'ID', crocopayClientSecret: 'S',
    payMethods: ['SBP', 'NEW_FANCY_PAY'], crocopayRates: { USD: 90 }
  });
  // Живой ответ в настройки приходит уже объединённым по кассам: `byProvider`
  // говорит, кто из них что умеет, и по нему в строке способа печатаются имена
  // касс — по ним видно, есть ли у способа подстраховка.
  const html = adminViews.settingsPage(settings, db, null, 'ok', {
    live: Object.assign({ ok: true }, live, { byProvider: { crocopay: live } })
  });

  // Способ, которого нет в закрытом списке, но который включён у кассы, —
  // отмечается прямо здесь, а не выкаткой новой версии.
  assert.match(html, /name="payMethods" value="NEW_FANCY_PAY" checked/);
  assert.match(html, /новый у кассы/);
  // Способ из нашего списка, которого у кассы нет: строка остаётся (иначе выбор
  // владельца стёрся бы первым же «Сохранить»), но помечена.
  assert.match(html, /name="payMethods" value="QR_NSPK"[\s\S]{0,240}нет у касс/);
  // Пояснительных абзацев в разделе нет вовсе — их убрали все. Состояние
  // читается самой строкой способа, а не подписью под списком.
  assert.doesNotMatch(html, /Список пришёл от касс/);
  // Ровно в блоке оплаты, а не по всей странице: подсказки других панелей
  // (доступ, ключ dadata) не трогали.
  const payPanel = html.slice(html.indexOf('<h2>Оплата на витрине</h2>'), html.indexOf('<div class="a-form-actions">'));
  assert.ok(payPanel.length > 500, 'блок оплаты найден');
  assert.doesNotMatch(payPanel, /class="muted small"/, 'подсказок в блоке оплаты не осталось');
  // У способа подписано, какие кассы его умеют: одна — значит подстраховки нет.
  assert.match(html, /name="payMethods" value="SBP"[\s\S]{0,300}CrocoPAY/);
  // Валюты — тоже её ответ.
  assert.match(html, /<option value="USD"/);
  assert.match(html, /name="payrate:USD"/);

  // Незнакомый код показывается сам собой и НЕ выдаёт себя за карту: подпись
  // реквизита у него нейтральная — угадывать, что там придёт, нельзя.
  const fresh = pay.describe('NEW_FANCY_PAY');
  assert.equal(fresh.name, 'NEW_FANCY_PAY');
  assert.equal(fresh.unknown, true);
  assert.equal(pay.requisiteLabel('NEW_FANCY_PAY'), 'Реквизиты');
  // И он проходит на витрину, если касса его включила, а владелец отметил.
  assert.deepEqual(pay.allowed(['SBP', 'NEW_FANCY_PAY'], ['SBP', 'NEW_FANCY_PAY']).map(m => m.id), ['SBP', 'NEW_FANCY_PAY']);
  // Не отмечен владельцем — не показываем, как и любой другой.
  assert.deepEqual(pay.allowed(['SBP', 'NEW_FANCY_PAY'], ['SBP']).map(m => m.id), ['SBP']);
});

test('счёт выставляется в валюте по курсу магазина, а без курса валюты нет', () => {
  const pay = require('../lib/pay-methods');
  const source = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

  // Курс — «сколько рублей за единицу валюты». База не пересчитывается никогда.
  assert.equal(pay.rateOf({ USD: 90 }, 'RUB'), 1);
  assert.equal(pay.rateOf({ USD: 90 }, 'USD'), 90);
  assert.equal(pay.rateOf({ USD: 0 }, 'USD'), 0, 'ноль — курса нет');
  assert.equal(pay.rateOf({}, 'мусор'), 0);
  assert.equal(pay.convert(68500, 90.5), 756.91);
  assert.equal(pay.convert(68500, 0), 0, 'без курса суммы нет');
  assert.equal(pay.currencyCode('usd'), 'USD');
  assert.equal(pay.currencyCode('РУБ'), '', 'код валюты — три латинские буквы');
  assert.match(pay.formatAmount(756.91, 'USD'), /756,91\s\$/);

  // Валюта предлагается, только когда она включена у кассы И у неё есть курс:
  // без курса счёт вышел бы на выдуманную сумму. Правило одно на страницу
  // оплаты и на создание счёта — иначе покупатель видел бы одну сумму, а счёт
  // уходил бы на другую.
  const ctx = source.slice(source.indexOf('async function payContext'), source.indexOf('// Выставить счёт по уже созданному заказу'));
  assert.match(ctx, /filter\(c => PAY\.rateOf\(rates, c\) > 0\)/);
  assert.match(ctx, /if \(!s\.crocopayCurrencyChoice && codes\.length\) codes = \[codes\.includes\(def\) \? def : codes\[0\]\]/);
  // Сумма счёта — пересчитанная, а не рублёвая: иначе доллары ушли бы в кассу
  // числом рублей.
  assert.match(source, /amount: ctx\.amount, currency: ctx\.currency, method, callbackUrl/);
  assert.match(source, /method, amount: ctx\.amount, currency: ctx\.currency/);

  // Проверка курса идёт ДО записи настроек — то же правило, что у всей формы.
  const route = source.slice(source.indexOf("app.post('/admin/settings'"));
  assert.match(route, /if \(!PAY\.rateOf\(rates, code\)\) return fail\(/);

  // На витрине сумма перевода показана в валюте счёта, а рублёвая сумма заказа
  // рядом: покупатель обязан видеть, от чего она посчитана.
  const ss = { storeName: 'Тест', tagline: '', accentColor: '#0071e3', currency: '₽', currencyPosition: 'after' };
  const order = { id: 'o1', number: '482913', total: 68500, items: [], contact: 'tg',
    payment: { status: 'pending', invoiceId: 'i1', requisite: '2200', method: 'TO_CARD_TRANSGRAN', amount: 756.91, currency: 'USD', expiresAt: Date.now() + 6e5 } };
  const invoice = render.payPage(ss, order, { origin: '', methods: [], currencies: ['RUB', 'USD'], currency: 'USD', amount: 756.91 });
  assert.match(invoice, /Сумма перевода<\/span><b>756,91 \$<\/b>/);
  // Разряды в toLocaleString('ru-RU') разделяет неразрывный пробел — отсюда \s.
  assert.match(invoice, /Заказ на 68\s500\s₽ — счёт выставлен в валюте Доллар США/);

  // После оплаты счёт уже не live, но его историческую валюту нельзя заменять
  // текущим выбором страницы или новым курсом.
  const paid = render.payPage(ss, Object.assign({}, order, {
    payment: Object.assign({}, order.payment, { status: 'paid' })
  }), { origin: '', methods: [], currencies: ['RUB'], currency: 'RUB', amount: 68500 });
  assert.match(paid, /Касса подтвердила перевод на 756,91 \$/);
  assert.doesNotMatch(paid, /Касса подтвердила перевод на 68\s500\s₽/);

  // Выбор валюты — ссылки с суммой у каждой: выбирают, уже видя, сколько
  // переводить. Одна валюта — выбора нет вовсе.
  const choice = render.payPage(ss, Object.assign({}, order, { payment: null }), {
    origin: '', methods: pay.allowed(null, ['SBP']), currencies: ['RUB', 'USD'], currency: 'RUB',
    amount: 68500, amounts: { RUB: 68500, USD: 756.91 }
  });
  assert.match(choice, /class="pay-cur-opt active" href="\/pay\/o1\?currency=RUB"/);
  assert.match(choice, /href="\/pay\/o1\?currency=USD"[\s\S]{0,120}756,91 \$/);
  const single = render.payPage(ss, Object.assign({}, order, { payment: null }), {
    origin: '', methods: pay.allowed(null, ['SBP']), currencies: ['RUB'], currency: 'RUB', amount: 68500
  });
  assert.equal(/pay-cur-opt/.test(single), false, 'одна валюта — переключателя нет');

  // Прежний способ не в списке (сменили валюту) — отмечается первый доступный,
  // иначе кнопка отвечала бы «выберите способ» на пустом месте.
  const switched = render.payPage(ss, Object.assign({}, order, {
    payment: { status: 'expired', method: 'TO_CARD_TRANSGRAN' }
  }), { origin: '', methods: pay.allowed(null, ['SBP', 'TO_CARD']), currencies: ['RUB'], currency: 'RUB', amount: 68500 });
  assert.match(switched, /value="SBP" checked/);
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

  /* В списке заказов черновик виден — своим состоянием: данные покупателя в нём
   * уже полные, вместе с телефоном, и это брошенная на последнем шаге покупка.
   * Заказом он при этом не стал: ни уведомления менеджеру, ни отметки в
   * метрике, ни выручки. */
  assert.deepEqual(fresh.visibleOrders().map(o => o.id).sort(), [real.id, draft.id].sort());
  assert.equal(render.orderTone({ draft: true }), 'draft');
  assert.match(render.orderStatus({ draft: true }), /pay-draft/);
  assert.match(render.orderStatus({ draft: true }), /способ не выбран/);
  assert.equal(render.orderStats([{ draft: true, total: 200 }]).revenue, 0, 'черновик — не выручка');
  assert.equal(fresh.getOrder(draft.id).id, draft.id);
  assert.equal(fresh.getOrders().length, 2, 'внутренний список отдаёт всё — иначе запись стёрла бы черновики');

  // Способ выбран — черновик стал заказом, и ровно один раз: уведомление
  // менеджеру и отметка в метрике идут по этому признаку.
  const first = fresh.promoteOrder(draft.id);
  assert.equal(first.promoted, true);
  assert.equal(fresh.promoteOrder(draft.id).promoted, false, 'второй раз менеджера не дёргаем');
  assert.equal(fresh.visibleOrders().length, 2);
  assert.equal('draft' in fresh.getOrder(draft.id), false, 'признак снимается, а не остаётся false');

  // Брошенные черновики не копятся: их больше, чем купивших. Но живут неделю, а
  // не сутки: раз менеджер их видит, они должны дожить до его звонка.
  const stale = fresh.createOrder({ draft: true, items: [], total: 300, contact: 'tg' });
  const kept = fresh.createOrder({ draft: true, items: [], total: 350, contact: 'tg' });
  const archivedDraft = fresh.createOrder({ draft: true, items: [], total: 360, contact: 'tg' });
  fresh.archiveOrder(archivedDraft.id, 'admin');
  assert.equal(fresh.canDiscardDraftOrder(fresh.getOrder(archivedDraft.id)), false,
    'устаревшая открытая форма покупателя не удалит tombstone');
  const financialDraft = fresh.createOrder({ draft: true, items: [], total: 370, contact: 'tg' });
  fresh.startOrderPayment(financialDraft.id, { attemptId: '9'.repeat(24), token: '8'.repeat(32), amount: 37000 });
  const file = path.join(dir, 'orders.json');
  const list = JSON.parse(fs.readFileSync(file, 'utf8'));
  list.find(o => o.id === stale.id).createdAt = Date.now() - 8 * 24 * 60 * 60 * 1000;
  list.find(o => o.id === kept.id).createdAt = Date.now() - 3 * 24 * 60 * 60 * 1000;
  list.find(o => o.id === archivedDraft.id).createdAt = Date.now() - 8 * 24 * 60 * 60 * 1000;
  list.find(o => o.id === financialDraft.id).createdAt = Date.now() - 8 * 24 * 60 * 60 * 1000;
  fs.writeFileSync(file, JSON.stringify(list));
  fresh.createOrder({ items: [], total: 400, contact: 'tg' });
  assert.equal(fresh.getOrder(stale.id), null, 'неделя — и брошенный черновик убран');
  assert.equal(fresh.getOrder(kept.id).id, kept.id, 'трёхдневный черновик менеджер ещё увидит');
  assert.equal(fresh.getOrder(archivedDraft.id).id, archivedDraft.id, 'архивный черновик можно восстановить и через неделю');
  assert.equal(fresh.getOrder(financialDraft.id).id, financialDraft.id, 'финансовый legacy-черновик не теряет callback');
  assert.equal(fresh.getOrder(real.id).id, real.id, 'настоящие заказы уборка не трогает');
  fs.rmSync(dir, { recursive: true, force: true });

  // А вот в «Покупках» посетителя черновика нет: блок называется так не зря, и
  // брошенная заявка читалась бы в нём как состоявшийся заказ.
  const source = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const lookup = source.slice(source.indexOf('function lookupVisitor('), source.indexOf("app.get('/admin/analytics/visitor/:key'"));
  assert.match(lookup, /filter\(o => !o\.draft\)/);
});

test('клиент удаляет только чистый черновик до первого запроса реквизитов', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'discard-draft-'));
  const fresh = freshDb(dir);
  const draft = fresh.createOrder({ draft: true, items: [], total: 200, contact: 'tg' });
  const ordinary = fresh.createOrder({ items: [], total: 300, contact: 'tg' });

  assert.equal(fresh.canDiscardDraftOrder(draft), true);
  assert.equal(fresh.canDiscardDraftOrder(ordinary), false, 'обычный заказ без payment — не черновик');
  const removed = fresh.discardDraftOrder(draft.id);
  assert.equal(removed.ok, true);
  assert.equal(fresh.getOrder(draft.id), null, 'чистый черновик удалён атомарно');
  assert.equal(fresh.discardDraftOrder(draft.id).reason, 'not_found');
  assert.equal(fresh.getOrder(ordinary.id).id, ordinary.id, 'настоящая заявка не затронута');

  const started = fresh.createOrder({ draft: true, items: [], total: 400, contact: 'tg' });
  fresh.startOrderPayment(started.id, {
    attemptId: 'a'.repeat(24), requestId: 'b'.repeat(32), token: 'c'.repeat(32),
    provider: 'crocopay', method: 'SBP', amount: 400, currency: 'RUB'
  });
  const withAttempt = fresh.getOrder(started.id);
  assert.equal(fresh.canDiscardDraftOrder(withAttempt), false,
    'даже попытка без invoice блокирует отмену: потерянный ответ мог создать счёт');
  assert.equal(fresh.discardDraftOrder(started.id).reason, 'locked');
  assert.equal(fresh.getOrder(started.id).id, started.id, 'платёжная история не удалена');

  const processing = fresh.createOrder({ draft: true, items: [], total: 500, contact: 'tg' });
  fresh.setOrderStatus(processing.id, 'processing');
  assert.equal(fresh.discardDraftOrder(processing.id).reason, 'locked', 'взятый в работу черновик не удаляется');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('возврат с оплаты проверяет владельца и перечитывает заказ после сети', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const route = source.slice(source.indexOf("app.post('/pay/:id/draft'"), source.indexOf('/* Сверить ОДНУ адресную попытку'));
  assert.match(route, /ownOrder\(req, req\.params\.id\)/);
  assert.ok(route.indexOf('ownOrder(req, req.params.id)') < route.indexOf("rateLimited(req, 'order-draft'"),
    'чужой id отсекается до различимого rate-limit ответа');
  assert.match(route, /intent !== 'edit' && intent !== 'cancel'/, 'назначение кнопки — закрытый список');
  assert.match(route, /db\.discardDraftOrder\(order\.id\)/, 'проверка и удаление — одна DB-операция');
  assert.match(route, /req\.session\.myOrders = mine\.filter/);
  assert.match(route, /res\.redirect\('\/checkout\?returned=' \+ intent, 303\)/);

  const payRoute = source.slice(source.indexOf("app.get('/pay/:id'"), source.indexOf("app.post('/api/pay/crocopay/callback'"));
  const awaited = payRoute.indexOf('await payContext');
  const reread = payRoute.indexOf('const currentOrder = ownOrder', awaited);
  assert.ok(awaited > -1 && reread > awaited,
    'другая вкладка могла запустить invoice, пока страница ждала список способов');
  assert.match(payRoute.slice(reread), /canDiscardDraft: db\.canDiscardDraftOrder\(currentOrder\)/);

  const browser = fs.readFileSync(path.join(__dirname, '..', 'public', 'pay.js'), 'utf8');
  assert.doesNotMatch(browser, /pay-switch|replaceInvoiceId|\?choose=1/,
    'при запущенном таймере клиент не создаёт второй счёт');
  const serverLib = fs.readFileSync(path.join(__dirname, '..', 'lib', 'server-lib.js'), 'utf8');
  assert.match(serverLib, /\[301, 302, 303, 307, 308\]\.includes\(wanted\)/,
    'POST-форма возвращается GET-запросом через настоящий 303');
});

test('оформление с онлайн-оплатой не чистит корзину до выбора способа', () => {
  const js = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  const pay = fs.readFileSync(path.join(__dirname, '..', 'public', 'pay.js'), 'utf8');
  const source = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

  // Корзина остаётся до выбора способа: иначе ушедший со страницы оплаты
  // покупатель теряет и заказ, и товары разом.
  assert.match(js, /if \(!online\) Cart\.clear\(\)/);
  // А при отказе кассы корзина ОСТАЁТСЯ: заплатить не вышло, и покупателю нужно
  // чем-то попробовать ещё раз. Раньше она чистилась и здесь — по флагу
  // `placed`, — и «назад» возвращало пустую корзину с пустой формой.
  assert.match(pay, /d\.ok && window\.Cart[\s\S]{0,40}Cart\.clear\(\)/);
  assert.doesNotMatch(pay, /d\.placed[\s\S]{0,80}Cart\.clear\(\)/);

  // Заказ становится настоящим при выборе способа — ДО обращения к кассе:
  // отказ кассы (у неё кончились свободные реквизиты) не должен прятать от
  // менеджера готового покупателя.
  const start = source.slice(source.indexOf('async function startPaymentRoute('), source.indexOf("app.post('/api/pay/start'"));
  assert.ok(start.indexOf('db.promoteOrder(id)') < start.indexOf('requestInvoiceFrom(p, s, req'));
  assert.match(start, /grown\.promoted[\s\S]{0,160}notifyNewOrder\(grown\.order\)/);
  // Черновик — только когда есть что выбирать. Без онлайн-оплаты заявка
  // настоящая сразу, как и была.
  assert.match(source, /const draft = PAYMENTS\.enabled\(s\)/);
  assert.match(source, /if \(!draft\) metrics\.markOrder/);
});

test('оформление помнит введённое — после неудачной оплаты его не набирают заново', () => {
  const js = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');

  /* Покупатель, у которого касса не выставила счёт, возвращается на оформление.
   * Контакты, адрес и выбранная доставка восстанавливаются из браузера самого
   * покупателя и протухают через неделю. */
  assert.match(js, /FORM_FIELDS = \['co-first-name', 'co-last-name', 'co-phone', 'co-contact', 'co-address'\]/);
  assert.match(js, /FORM_RADIOS = \['co-delivery', 'co-delivery-mode'\]/);
  assert.match(js, /FORM_TTL/);
  assert.match(js, /initCheckoutMemory\(\);/, 'память подключается при сборке формы');

  /* Значения возвращаются событием `change`: по нему телефон переформатирует
   * себя и поднимает флаг, а адрес пересчитывает доставку и отпирает выбор
   * способа. `input` для этого не годится — он ещё и раскрыл бы список
   * подсказок адреса поверх формы. */
  assert.match(js, /dispatchEvent\(new Event\('change', \{ bubbles: true \}\)\)/);
  assert.doesNotMatch(js, /dispatchEvent\(new Event\('input'/);
  // Уже набранное не трогаем: своё важнее запомненного.
  assert.match(js, /if \(!el \|\| !value \|\| el\.value\) return/);

  // Исполняем ровно функции из browser-файла на фейковом DOM/localStorage:
  // regex по исходнику не поймал бы неверный TTL или удаление не того ключа.
  const from = js.indexOf("var FORM_KEY = 'checkout_v1';");
  const to = js.indexOf('function initAddressQuote()', from);
  assert.ok(from > -1 && to > from, 'блок памяти оформления найден');
  const factory = new Function('document', 'localStorage', 'window', 'Event', 'cleanText', 'pickup',
    js.slice(from, to) + '\nreturn { rememberCheckout, initCheckoutMemory };');
  function harness(initial, preset, broken) {
    const values = new Map(Object.entries(initial || {}));
    const events = [];
    const fields = {};
    for (const id of ['co-first-name', 'co-last-name', 'co-phone', 'co-contact', 'co-address']) {
      fields[id] = {
        value: (preset && preset[id]) || '', listeners: {},
        addEventListener(type, fn) { this.listeners[type] = fn; },
        dispatchEvent(event) { events.push([id, event.type]); }
      };
    }
    const radios = [
      { name: 'co-delivery', value: 'cdek', checked: false },
      { name: 'co-delivery', value: 'ozon', checked: false },
      { name: 'co-delivery-mode', value: 'pvz', checked: false },
      { name: 'co-delivery-mode', value: 'courier', checked: false }
    ];
    radios.forEach(radio => {
      radio.dispatchEvent = event => events.push([radio.name + ':' + radio.value, event.type]);
    });
    const storage = broken ? {
      getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); }, removeItem() { throw new Error('blocked'); }
    } : {
      getItem(key) { return values.has(key) ? values.get(key) : null; },
      setItem(key, value) { values.set(key, String(value)); },
      removeItem(key) { values.delete(key); }
    };
    const page = { listeners: {}, addEventListener(type, fn) { this.listeners[type] = fn; } };
    const pickup = { code: '', restoredCode: '', open: true };
    const doc = {
      getElementById: id => fields[id] || null,
      querySelectorAll(selector) {
        const match = /input\[name="([^"]+)"\]/.exec(selector);
        return match ? radios.filter(radio => radio.name === match[1]) : [];
      }
    };
    const api = factory(doc, storage, page,
      class FakeEvent { constructor(type) { this.type = type; } },
      (value, max) => String(value == null ? '' : value).trim().slice(0, max), pickup);
    return { api, fields, radios, pickup, events, values, page };
  }

  const fresh = harness({ checkout_v1: JSON.stringify({
    at: Date.now(), 'co-first-name': ' Иван ', 'co-last-name': 'Из памяти',
    'co-phone': '+79990000000', 'co-contact': '', 'co-address': 'Москва, Тверская, 1',
    'co-delivery': 'ozon', 'co-delivery-mode': 'courier', 'co-pickup-code': 'PVZ_42'
  }) }, { 'co-last-name': 'Уже введено' });
  fresh.api.initCheckoutMemory();
  assert.equal(fresh.fields['co-first-name'].value, 'Иван');
  assert.equal(fresh.fields['co-last-name'].value, 'Уже введено', 'своё значение не перезаписано');
  assert.ok(fresh.events.some(([id, type]) => id === 'co-first-name' && type === 'change'));
  assert.equal(fresh.radios.find(radio => radio.value === 'ozon').checked, true);
  assert.equal(fresh.radios.find(radio => radio.value === 'courier').checked, true);
  assert.equal(fresh.pickup.code, '', 'сохранённый код ещё не подтверждён актуальным списком');
  assert.equal(fresh.pickup.restoredCode, 'PVZ_42');
  assert.equal(fresh.pickup.open, true);
  fresh.fields['co-phone'].value = '+79991112233';
  fresh.page.listeners.pagehide();
  assert.equal(JSON.parse(fresh.values.get('checkout_v1'))['co-phone'], '+79991112233',
    'активное поле сохраняется при уходе со страницы');
  assert.equal(JSON.parse(fresh.values.get('checkout_v1'))['co-delivery'], 'ozon');
  assert.equal(JSON.parse(fresh.values.get('checkout_v1'))['co-pickup-code'], 'PVZ_42');

  const stale = harness({ checkout_v1: JSON.stringify({
    at: Date.now() - 8 * 24 * 60 * 60 * 1000, 'co-first-name': 'Старое'
  }) });
  stale.api.initCheckoutMemory();
  assert.equal(stale.values.has('checkout_v1'), false, 'просроченные персональные данные удалены');
  const malformed = harness({ checkout_v1: JSON.stringify({ at: Date.now() + 60000, 'co-first-name': {} }) });
  malformed.api.initCheckoutMemory();
  assert.equal(malformed.values.has('checkout_v1'), false, 'будущая/битая запись удалена');
  const blocked = harness({}, {}, true);
  assert.doesNotThrow(() => blocked.api.initCheckoutMemory(), 'запрет localStorage не ломает оформление');
  assert.doesNotThrow(() => blocked.page.listeners.pagehide());
  const submit = js.slice(js.indexOf('function submitOrder(btn)'), js.indexOf("fetch('/api/order'", js.indexOf('function submitOrder(btn)')));
  const rememberAt = submit.indexOf('rememberCheckout()');
  const readFieldsAt = submit.indexOf("document.getElementById(id)");
  assert.ok(rememberAt > -1 && readFieldsAt > rememberAt,
    'активное поле сохраняется непосредственно перед чтением/submit');
  const empty = js.slice(js.indexOf('if (!Cart.items.length) {'), js.indexOf('var count = Cart.count()'));
  assert.ok(empty.indexOf('rememberCheckout()') < empty.indexOf("form.innerHTML = ''"),
    'форма сохраняется до программного удаления при пустой корзине');
  assert.match(js, /window\.addEventListener\('pageshow'[\s\S]{0,180}event\.persisted[\s\S]{0,180}Cart\.load\(\)[\s\S]{0,100}Cart\.render\(\)/,
    'возврат из BFCache перечитывает актуальную корзину');
});

test('повтор оформления возвращает тот же свой неоплаченный заказ, а не создаёт дубль', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const from = source.indexOf('const ORDER_REUSE_TTL');
  const to = source.indexOf("app.post('/api/order'", from);
  assert.ok(from > -1 && to > from, 'reusableOrder найден');
  const orders = new Map();
  const reusableOrder = new Function('db', source.slice(from, to) + '\nreturn reusableOrder;')({
    getOrder: id => orders.get(id) || null,
    isOrderArchived: order => !!(order && order.archive && order.archive.active)
  });
  const base = {
    items: [
      { id: 'phone', name: 'iPhone', price: 60000, qty: 1 },
      { id: 'case', name: 'Чехол', price: 2000, qty: 1 }
    ],
    total: 62500, itemsTotal: 62000, firstName: 'Иван', lastName: 'Петров',
    phone: '+79990000000', contact: '@ivan', address: 'Москва, Тверская, 1',
    delivery: 'cdek', deliveryMode: 'pickup', deliveryPrice: 500,
    deliveryZone: 'center', pickupCode: 'MSK1', pickupAddress: 'Тверская, 2', comment: 'Позвонить'
  };
  const order = Object.assign({ id: 'mine', status: 'new', draft: true, createdAt: Date.now() }, base, {
    items: base.items.slice().reverse()
  });
  orders.set(order.id, order);
  const req = { session: { myOrders: [order.id] } };
  assert.equal(reusableOrder(req, base), order, 'порядок одинаковых позиций не создаёт дубль');
  assert.equal(reusableOrder(req, Object.assign({}, base, { comment: 'Без звонка' })), null,
    'изменённый значимый параметр — новый заказ');
  order.draft = false;
  order.payment = { status: 'pending' };
  assert.equal(reusableOrder(req, base), order, 'повтор оплаты существующего заказа переиспользуется');
  order.payment.status = 'paid';
  assert.equal(reusableOrder(req, base), null, 'оплаченный заказ не оживает');
  order.payment.status = 'pending';
  order.status = 'done';
  assert.equal(reusableOrder(req, base), null, 'выполненный заказ не оживает');
  order.status = 'new';
  order.archive = { active: true, at: Date.now() };
  assert.equal(reusableOrder(req, base), null, 'удалённый администратором заказ не оживает');
  order.archive.active = false;
  order.createdAt = Date.now() + 1000;
  assert.equal(reusableOrder(req, base), null, 'запись из будущего не переиспользуется');
  assert.equal(reusableOrder({ session: { myOrders: [] } }, base), null, 'чужая сессия заказ не видит');
});

test('идентификатор запроса кассы хранится отдельно по способу и удаляется адресно', () => {
  const js = fs.readFileSync(path.join(__dirname, '..', 'public', 'pay.js'), 'utf8');
  const from = js.indexOf('var REQUEST_TTL');
  const to = js.indexOf('function startPayment', from);
  assert.ok(from > -1 && to > from, 'блок browser-idempotency найден');
  const factory = new Function('orderId', 'currency', 'window', 'localStorage', 'setTimeout',
    js.slice(from, to) + '\nreturn { requestKey, paymentRequestId, clearPaymentRequest };');
  function storage(initial) {
    const values = new Map(Object.entries(initial || {}));
    return {
      values,
      get length() { return values.size; },
      key(i) { return Array.from(values.keys())[i] || null; },
      getItem(key) { return values.has(key) ? values.get(key) : null; },
      setItem(key, value) { values.set(key, String(value)); },
      removeItem(key) { values.delete(key); }
    };
  }
  let seed = 1;
  const browser = { crypto: { getRandomValues(bytes) {
    for (let i = 0; i < bytes.length; i++) bytes[i] = (seed++ % 255) || 1;
  } } };
  const local = storage();
  const api = factory('order-1', 'RUB', browser, local, () => 1);
  const card1 = api.paymentRequestId('TO_CARD');
  assert.equal(api.paymentRequestId('TO_CARD'), card1, 'потерянный ответ повторяет тот же requestId');
  const sbp = api.paymentRequestId('SBP');
  assert.notEqual(sbp, card1, 'другой способ не перезаписывает ключ карты');
  const cardKey = api.requestKey('TO_CARD');
  local.setItem(cardKey, JSON.stringify({ id: 'f'.repeat(32), method: 'TO_CARD', currency: 'RUB', at: Date.now() }));
  api.clearPaymentRequest(cardKey, card1);
  assert.equal(JSON.parse(local.getItem(cardKey)).id, 'f'.repeat(32),
    'ответ старой вкладки не удаляет более новый requestId');

  const staleKey = 'pay_request_v1:order-2:RUB:TO_CARD';
  const stale = storage({ [staleKey]: JSON.stringify({
    id: 'a'.repeat(32), method: 'TO_CARD', currency: 'RUB', at: Date.now() - 6 * 60 * 1000
  }) });
  factory('order-2', 'RUB', browser, stale, () => 1);
  assert.equal(stale.getItem(staleKey), null, 'просроченный технический ключ удаляется при открытии');
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
  const db = { getOrders: () => list, visibleOrders: () => list, getProducts: () => [], visibleProducts: () => [], pendingReviewCount: () => 0 };
  assert.match(adminViews.ordersList(SETTINGS, db, null, 1), /<b>№482913<\/b>/);
  assert.match(js, /function orderNo\(number\)/);
  assert.doesNotMatch(js, /<span>Номер заказа<\/span>/);
});

test('оплата хранит отдельные попытки и закрывается идемпотентно', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'order-pay-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const fresh = freshDb(dir);
  const order = fresh.createOrder({ items: [{ id: 'p1', name: 'Товар', price: 100, qty: 1 }], total: 100, contact: 'tg' });
  assert.equal(order.payment, null, 'заказ без оплаты читается как «не запускалась»');
  assert.equal(order.status, 'new');

  const firstId = '1'.repeat(24);
  const firstRequest = 'a'.repeat(32);
  const firstToken = 'b'.repeat(32);
  const started = fresh.startOrderPayment(order.id, {
    provider: 'crocopay', attemptId: firstId, requestId: firstRequest,
    token: firstToken, method: 'SBP', amount: 10000, currency: 'RUB'
  });
  assert.equal(started.payment.status, 'pending');
  assert.equal(started.payment.attemptId, firstId);
  assert.equal(started.payment.token, firstToken);
  assert.equal(started.payment.amount, 10000);
  assert.equal(started.payment.method, 'SBP');
  assert.equal(started.payment.attempts.length, 1);
  assert.equal(started.status, 'new', 'статус заказа оплата не подменяет');

  // Реквизиты приезжают отдельным шагом: token нужен ДО создания счёта (он
  // уходит в callback_url), а id счёта появляется только в ответе кассы.
  fresh.attachOrderInvoice(order.id, {
    attemptId: firstId,
    invoiceId: '911c2823-f55b-43b5-9881-d5653107f7dc', requisite: '4276 1234 5678 9012',
    bank: 'Сбербанк', owner: 'IVAN PETROV', method: 'TO_CARD', expiresAt: 1893456000000
  });
  const withInvoice = fresh.getOrder(order.id).payment;
  assert.equal(withInvoice.invoiceId, '911c2823-f55b-43b5-9881-d5653107f7dc');
  assert.equal(withInvoice.requisite, '4276 1234 5678 9012');
  assert.equal(withInvoice.expiresAt, 1893456000000);

  // Каждая попытка адресуется своим id/token/requestId. Старый token остаётся в
  // истории: поздний webhook найдёт именно старый счёт, не новую сумму.
  const secondId = '2'.repeat(24);
  const secondRequest = 'c'.repeat(32);
  const secondToken = 'd'.repeat(32);
  const second = fresh.startOrderPayment(order.id, {
    attemptId: secondId, requestId: secondRequest, token: secondToken,
    method: 'SBP', amount: 10000, currency: 'RUB'
  });
  assert.equal(second.payment.attemptId, secondId);
  assert.equal(second.payment.token, secondToken);
  assert.equal(second.payment.invoiceId, '', 'новый счёт начинается с чистых реквизитов');
  assert.equal(second.payment.attempts.length, 2);
  const old = fresh.findPaymentAttempt(second, { attemptId: firstId });
  assert.equal(old.token, firstToken);
  assert.equal(old.invoiceId, '911c2823-f55b-43b5-9881-d5653107f7dc');

  // Повтор потерянного HTTP-ответа с тем же requestId не создаёт третий счёт.
  const retried = fresh.startOrderPayment(order.id, {
    attemptId: '3'.repeat(24), requestId: secondRequest, token: 'e'.repeat(32), method: 'SBP', amount: 10000
  });
  assert.equal(retried.payment.attempts.length, 2);
  assert.equal(fresh.findPaymentAttempt(retried, { requestId: secondRequest }).id, secondId);

  fresh.attachOrderInvoice(order.id, {
    attemptId: secondId, invoiceId: 'bbbbbbbb-0000-0000-0000-000000000000',
    requisite: '+79001234567', method: 'SBP'
  });

  // 'pending' закрытием не бывает, иначе вебхук мог бы «разоплатить» заказ.
  assert.equal(fresh.settleOrderPayment(order.id, { attemptId: secondId, status: 'pending' }), null);
  assert.equal(fresh.settleOrderPayment(order.id, { status: 'выдумка' }), null);
  assert.equal(fresh.settleOrderPayment('чужой-id', { status: 'paid' }), null);

  const paid = fresh.settleOrderPayment(order.id, {
    attemptId: secondId, invoiceId: 'bbbbbbbb-0000-0000-0000-000000000000', status: 'paid', total: 10000
  });
  assert.equal(paid.changed, true);
  assert.equal(paid.order.payment.status, 'paid');
  // Платёжка вправе повторить вызов, да и опрос статуса идёт каждые несколько
  // секунд — второй раз менеджера дёргать нельзя.
  assert.equal(fresh.settleOrderPayment(order.id, {
    attemptId: secondId, invoiceId: 'bbbbbbbb-0000-0000-0000-000000000000', status: 'paid', total: 10000
  }).changed, false);
  // Оплаченный заказ новым счётом не сбрасывается.
  assert.equal(fresh.startOrderPayment(order.id, { token: 'f'.repeat(32) }).payment.token, secondToken);
  assert.equal(fresh.getOrder(order.id).payment.status, 'paid');
  assert.equal(fresh.attachOrderInvoice(order.id, {
    attemptId: 'f'.repeat(24), invoiceId: 'ffffffff-0000-0000-0000-000000000000'
  }), null, 'неизвестная попытка не превращается в активную');
  assert.equal(fresh.getOrder(order.id).payment.invoiceId,
    'bbbbbbbb-0000-0000-0000-000000000000', 'чужие реквизиты поверх оплаченного заказа не пишем');
  const paymentHistory = JSON.parse(JSON.stringify(fresh.getOrder(order.id).payment));
  const archivedPayment = fresh.archiveOrder(order.id, 'admin');
  assert.equal(archivedPayment.ok, true, 'админ может убрать финансовый заказ из списка');
  assert.equal(archivedPayment.changed, true);
  assert.equal(fresh.archiveOrder(order.id, 'admin').changed, false, 'повтор удаления идемпотентен');
  assert.equal(fresh.visibleOrders().some(x => x.id === order.id), false, 'архивный заказ скрыт из рабочего списка');
  assert.equal(fresh.getOrder(order.id).payment.status, 'paid');
  assert.deepEqual(fresh.getOrder(order.id).payment, paymentHistory, 'архив не меняет ни одну платёжную попытку');
  assert.equal(fresh.settleOrderPayment(order.id, {
    attemptId: secondId, invoiceId: 'bbbbbbbb-0000-0000-0000-000000000000', status: 'paid', total: 10000
  }).changed, false);
  assert.equal(fresh.isOrderArchived(fresh.getOrder(order.id)), true,
    'повтор уже известного webhook не отменяет осознанное удаление');
  assert.equal(fresh.startOrderPayment(order.id, { token: 'f'.repeat(32) }), null,
    'архивному заказу новый invoice не выпускается');
  assert.equal(fresh.restoreOrder(order.id, 'admin').changed, true);
  assert.equal(fresh.restoreOrder(order.id, 'admin').changed, false, 'повтор restore идемпотентен');
  assert.equal(fresh.visibleOrders().some(x => x.id === order.id), true, 'заказ можно восстановить');
  const disposable = fresh.createOrder({ items: [], total: 1, contact: 'tg' });
  assert.equal(fresh.deleteOrder(disposable.id), true, 'обычная заявка без кассы тоже уходит в архив');
  assert.equal(fresh.getOrder(disposable.id).id, disposable.id, 'админское удаление обратимо');
  assert.equal(fresh.archivedOrders().some(x => x.id === disposable.id), true);

  // Из 'expired' в 'paid' дорасти можно и нужно: webhook об успехе вполне
  // приходит после того, как опрос увидел истёкший счёт.
  const other = fresh.createOrder({ items: [], total: 50, contact: 'tg' });
  const otherId = '4'.repeat(24);
  fresh.startOrderPayment(other.id, { attemptId: otherId, token: '5'.repeat(32), amount: 5000, currency: 'RUB' });
  assert.equal(fresh.settleOrderPayment(other.id, { attemptId: otherId, status: 'expired' }).changed, true);
  assert.equal(fresh.settleOrderPayment(other.id, { attemptId: otherId, status: 'expired' }).changed, false, 'то же состояние — не изменение');
  fresh.archiveOrder(other.id, 'admin');
  assert.equal(fresh.isOrderArchived(fresh.getOrder(other.id)), true);
  assert.equal(fresh.settleOrderPayment(other.id, { attemptId: otherId, status: 'paid', total: 5000 }).changed, true);
  assert.equal(fresh.getOrder(other.id).payment.status, 'paid');
  assert.equal(fresh.isOrderArchived(fresh.getOrder(other.id)), false,
    'поздняя первая оплата автоматически возвращает удалённый заказ менеджеру');
  assert.equal(fresh.getOrder(other.id).archive.restoredBy, 'system:payment');
  assert.equal(fresh.settleOrderPayment(other.id, { attemptId: otherId, status: 'expired' }).changed, false, 'оплаченное не истекает');
  assert.equal(fresh.getOrder(other.id).payment.status, 'paid');
});

test('удалить навсегда можно только из «Удалённых», и заказ исчезает из файла', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'order-purge-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const fresh = freshDb(dir);
  fresh.ensureSeeded();

  const live = fresh.createOrder({ items: [], total: 1000, contact: 'tg' });
  // Из рабочего списка стереть нельзя вовсе: архив и есть защита от нажатия не
  // туда, а стёртый заказ теряет привязку к уже выданному счёту.
  const refused = fresh.purgeOrder(live.id);
  assert.equal(refused.ok, false);
  assert.equal(refused.reason, 'not_archived');
  assert.ok(fresh.getOrder(live.id), 'отказ не должен ничего трогать');

  fresh.archiveOrder(live.id, 'admin');
  const gone = fresh.purgeOrder(live.id);
  assert.equal(gone.ok, true);
  assert.equal(gone.hadInvoice, false, 'счёта у этого заказа не было');
  assert.ok(!fresh.getOrder(live.id), 'заказ исчез из хранилища');
  assert.equal(fresh.getOrders().some(o => o.id === live.id), false);
  assert.equal(fresh.archivedOrders().some(o => o.id === live.id), false);
  // Именно из файла, а не только из кэша в памяти.
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'orders.json'), 'utf8')).some(o => o.id === live.id), false);
  assert.equal(fresh.purgeOrder(live.id).reason, 'not_found', 'второй раз стирать нечего');

  // Про заказ с выставленным счётом вызывающий обязан узнать: деньги по нему
  // ещё могут прийти, и привязать их будет не к чему. Запрета здесь нет —
  // решение владельца, — но панель на этом строит текст предупреждения.
  const paidish = fresh.createOrder({ items: [], total: 2000, contact: 'tg' });
  const attempt = '7'.repeat(24);
  fresh.startOrderPayment(paidish.id, { attemptId: attempt, token: '8'.repeat(32), amount: 2000, currency: 'RUB' });
  fresh.attachOrderInvoice(paidish.id, { attemptId: attempt, invoiceId: 'cccccccc-0000-0000-0000-000000000000' });
  fresh.archiveOrder(paidish.id, 'admin');
  assert.equal(fresh.purgeOrder(paidish.id).hadInvoice, true);

  assert.equal(fresh.purgeOrder('нет-такого').reason, 'not_found');
});

/* Очистка корзины целиком.
 *
 * Архив копится сам: брошенные черновики и тестовые заявки удаляют из рабочего
 * списка, и дальше они лежат там навсегда. По одной их чистить — подтверждение
 * на каждую, и на полусотне записей за этим перестают следить вовсе.
 */
test('«Очистить корзину» стирает весь архив и не трогает рабочий список', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'order-purge-all-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const fresh = freshDb(dir);
  fresh.ensureSeeded();

  const working = fresh.createOrder({ items: [], total: 1000, contact: 'tg' });
  const trash = [1000, 2000, 3000].map(total => fresh.createOrder({ items: [], total, contact: 'tg' }));
  // У одного из удалённых был счёт: панель обязана сказать это ДО нажатия —
  // деньги по нему ещё могут прийти, и привязать их будет не к чему. Счёт
  // выставляется до архива: заархивированному заказу новый счёт запрещён.
  const attempt = '9'.repeat(24);
  fresh.startOrderPayment(trash[1].id, { attemptId: attempt, token: 'a'.repeat(32), amount: 2000, currency: 'RUB' });
  fresh.attachOrderInvoice(trash[1].id, { attemptId: attempt, invoiceId: 'dddddddd-0000-0000-0000-000000000000' });
  for (const o of trash) fresh.archiveOrder(o.id, 'admin');

  const result = fresh.purgeArchivedOrders();
  assert.equal(result.removed, 3);
  assert.equal(result.hadInvoice, 1);
  // Рабочий список не трогается ни при каких условиях: это единственная защита
  // от «одним нажатием снёс все заказы».
  assert.ok(fresh.getOrder(working.id), 'заказ из рабочего списка на месте');
  assert.equal(fresh.archivedOrders().length, 0);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'orders.json'), 'utf8')).length, 1,
    'из файла удалённые исчезли физически');
  // Пустая корзина — не ошибка: чистить нечего, и файл трогать незачем.
  assert.deepEqual(fresh.purgeArchivedOrders(), { ok: true, removed: 0, hadInvoice: 0 });
});

/* Список заказов: режим правки переживает действие, а «Очистить корзину» живёт
 * внутри него.
 */
test('режим правки не выключается после удаления, очистка есть только в «Удалённых»', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orders-edit-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const fresh = freshDb(dir);
  fresh.ensureSeeded();
  const kept = fresh.createOrder({ items: [], total: 1000, contact: 'tg' });
  const dropped = fresh.createOrder({ items: [], total: 2000, contact: 'tg' });
  fresh.archiveOrder(dropped.id, 'admin');
  const s = fresh.getSettings();

  const plain = adminViews.ordersList(s, fresh, null, 1, 'active');
  assert.match(plain, /class="edit-switch sr-only">/, 'по умолчанию режим выключен');
  const editing = adminViews.ordersList(s, fresh, null, 1, 'active', '1');
  assert.match(editing, /class="edit-switch sr-only" checked>/, 'адрес вернул режим правки');
  // Формы действий несут его обратно на сервер вместе со страницей и вкладкой:
  // все эти кнопки показываются только в режиме правки, значит и возвращаться
  // надо в него же.
  assert.match(editing, new RegExp(`/admin/orders/${kept.id}/delete[\\s\\S]{0,400}name="edit" value="1"`));
  // Сервер кладёт его в адрес возврата — иначе режим гас бы после каждого
  // удаления, и чистка десятка заявок означала бы десять нажатий «Изменить».
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const back = server.slice(server.indexOf('const ordersBackUrl'), server.indexOf('// Тот же возврат для отзывов'));
  assert.match(back, /body\.edit[\s\S]{0,40}edit=1/);
  assert.match(server, /A\.ordersList\(settings\(\), db, req\.query\.flash, req\.query\.page, req\.query\.view, req\.query\.edit\)/);

  // Режим держится в адресе, поэтому он переживает и переход по страницам, и
  // смену вкладки: чистят список подряд, и возвращать человека в режим чтения
  // на каждом шаге значит заставлять его нажимать «Изменить» снова и снова.
  assert.match(editing, /href="\/admin\/orders\?view=archive&edit=1"/);
  assert.doesNotMatch(plain, /edit=1/, 'без режима адреса им не обрастают');

  // «Очистить корзину» — только на вкладке «Удалённые» и только когда там
  // что-то есть. В рабочем списке ей делать нечего.
  const archive = adminViews.ordersList(s, fresh, null, 1, 'archive');
  assert.match(archive, /action="\/admin\/orders\/purge-all"/);
  assert.match(archive, /Стереть все удалённые заказы \(1\)\?/);
  assert.doesNotMatch(plain, /purge-all/, 'в рабочем списке очистки нет');
  fresh.purgeArchivedOrders();
  assert.doesNotMatch(adminViews.ordersList(s, fresh, null, 1, 'archive'), /purge-all/,
    'пустой корзине очищаться нечем');
  // Стоит она в шапке режима правки и показывается тем же правилом, что и
  // крестики у строк: стереть архив из списка, открытого почитать, нельзя.
  const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'styles.css'), 'utf8');
  assert.match(css, /\.o-purge-all\{display:none\}/);
  assert.match(css, /\.edit-switch:checked ~ \.a-panel-edit \.o-purge-all\{display:block\}/);
});

/* Уведомление в панели гаснет само.
 *
 * Плашка отвечает на вопрос «получилось?», и ответ нужен ровно один раз: пока
 * она висела до следующего перехода, «Сохранено» от давней правки соседствовало
 * с уже другим содержимым формы.
 */
test('плашка «Сохранено» гаснет сама и не оставляет пустой полосы', () => {
  const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'styles.css'), 'utf8');
  assert.match(css, /@keyframes a-flash-out\{/);
  assert.match(css, /\.a-flash:not\(\.err\)\{overflow:hidden;animation:a-flash-out [\d.]+s ease \ds forwards\}/);
  /* Гаснет только «получилось». Ошибка отвечает на другой вопрос — «почему не
   * сохранилось», — и нужна всё время, пока человек правит форму: пропасть у
   * него из-под рук вместе с объяснением она не имеет права. */
  assert.doesNotMatch(css, /\.a-flash\{[^}]*animation:a-flash-out/);
  const frames = css.slice(css.indexOf('@keyframes a-flash-out{'), css.indexOf('@keyframes a-flash-out{') + 400);
  // Гаснет не только цвет: поля, рамка и высота уходят в ноль, иначе на месте
  // плашки осталась бы пустая полоса, читаемая как незагрузившийся блок.
  for (const prop of ['visibility:hidden', 'max-height:0', 'margin-top:0', 'padding-top:0', 'border-width:0']) {
    assert.ok(frames.includes(prop), 'плашка обязана схлопываться: ' + prop);
  }
  // При выключенной анимации она не остаётся навсегда — просто исчезает без
  // движения: «висит вечно» здесь хуже, чем «пропало резко».
  assert.match(css, /@media \(prefers-reduced-motion:reduce\)\{\.a-flash:not\(\.err\)\{animation-duration:[\d.]+s\}\}/);
  // И ни строчки скрипта: плашку рисует сервер, гаснуть она обязана и там, где
  // скрипты панели не загрузились.
  const ui = fs.readFileSync(path.join(__dirname, '..', 'public', 'admin-ui.js'), 'utf8');
  assert.doesNotMatch(ui, /a-flash/);
});

test('поздние ответы старого счёта не перезаписывают новую попытку', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'order-pay-race-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const fresh = freshDb(dir);
  const order = fresh.createOrder({ items: [], total: 12200, contact: 'tg' });
  const oldId = '6'.repeat(24);
  const newId = '7'.repeat(24);
  const oldInvoice = 'aaaaaaaa-0000-0000-0000-000000000000';
  const newInvoice = 'bbbbbbbb-0000-0000-0000-000000000000';

  fresh.startOrderPayment(order.id, {
    attemptId: oldId, requestId: '6'.repeat(32), token: 'a'.repeat(32),
    method: 'TO_CARD', amount: 12200, currency: 'RUB'
  });
  fresh.attachOrderInvoice(order.id, {
    attemptId: oldId, invoiceId: oldInvoice, requisite: '4276 0000 0000 0001',
    method: 'TO_CARD', expiresAt: 1000
  });
  fresh.startOrderPayment(order.id, {
    attemptId: newId, requestId: '7'.repeat(32), token: 'b'.repeat(32),
    method: 'SBP', amount: 12200, currency: 'RUB'
  });
  fresh.attachOrderInvoice(order.id, {
    attemptId: newId, invoiceId: newInvoice, requisite: '+79000000002',
    method: 'SBP', expiresAt: 2000
  });

  // Поздний attach/refresh старого POST меняет только его строку истории.
  fresh.attachOrderInvoice(order.id, {
    attemptId: oldId, invoiceId: oldInvoice, requisite: '4276 0000 0000 0009',
    method: 'TO_CARD', expiresAt: 3000
  });
  let saved = fresh.getOrder(order.id);
  assert.equal(saved.payment.attemptId, newId);
  assert.equal(saved.payment.invoiceId, newInvoice);
  assert.equal(saved.payment.requisite, '+79000000002');
  assert.equal(fresh.findPaymentAttempt(saved, { attemptId: oldId }).requisite, '4276 0000 0000 0009');
  assert.equal(fresh.attachOrderInvoice(order.id, {
    attemptId: oldId, invoiceId: newInvoice, requisite: 'чужой реквизит'
  }), null, 'уже связанная попытка не перепривязывается к другому invoice');
  assert.equal(fresh.failOrderPaymentAttempt(order.id, {
    attemptId: oldId, errorCode: 'provider_error'
  }), null, 'ошибка позднего POST не затирает уже выданные реквизиты');

  // CAS включает и attemptId, и invoiceId: перепутанный ответ — stale/no-op.
  assert.equal(fresh.refreshOrderPaymentAttempt(order.id, {
    attemptId: oldId, invoiceId: newInvoice, expiresAt: 4000
  }), null);
  const stale = fresh.settleOrderPayment(order.id, {
    attemptId: oldId, invoiceId: newInvoice, status: 'paid', total: 12200
  });
  assert.equal(stale.changed, false);
  assert.equal(stale.stale, true);
  saved = fresh.getOrder(order.id);
  assert.equal(saved.payment.attemptId, newId);
  assert.equal(saved.payment.status, 'pending');

  // Истечение старого счёта не гасит новый. Но подтверждённая оплата старого
  // счёта законна и становится липким фактом всего заказа.
  assert.equal(fresh.settleOrderPayment(order.id, {
    attemptId: oldId, invoiceId: oldInvoice, status: 'expired'
  }).changed, true);
  saved = fresh.getOrder(order.id);
  assert.equal(saved.payment.attemptId, newId);
  assert.equal(saved.payment.status, 'pending');
  assert.equal(fresh.findPaymentAttempt(saved, { attemptId: oldId }).status, 'expired');

  assert.equal(fresh.settleOrderPayment(order.id, {
    attemptId: oldId, invoiceId: oldInvoice, status: 'paid', total: 12200
  }).changed, true);
  saved = fresh.getOrder(order.id);
  assert.equal(saved.payment.attemptId, oldId);
  assert.equal(saved.payment.invoiceId, oldInvoice);
  assert.equal(saved.payment.status, 'paid');
  assert.equal(fresh.settleOrderPayment(order.id, {
    attemptId: newId, invoiceId: newInvoice, status: 'expired'
  }).changed, true, 'истёкшую попытку закрываем в истории, чтобы фон больше её не опрашивал');
  saved = fresh.getOrder(order.id);
  assert.equal(saved.payment.status, 'paid', 'агрегат заказа остаётся оплаченным');
  assert.equal(saved.payment.attemptId, oldId);
  assert.equal(fresh.findPaymentAttempt(saved, { attemptId: newId }).status, 'expired');

  const mismatchOrder = fresh.createOrder({ items: [], total: 12200, contact: 'tg' });
  const mismatchId = '8'.repeat(24);
  fresh.startOrderPayment(mismatchOrder.id, {
    attemptId: mismatchId, requestId: '8'.repeat(32), token: 'c'.repeat(32),
    method: 'TO_CARD', amount: 12200, currency: 'RUB'
  });
  assert.equal(fresh.settleOrderPayment(mismatchOrder.id, {
    attemptId: mismatchId, status: 'mismatch', total: 122
  }).changed, true);
  assert.equal(fresh.settleOrderPayment(mismatchOrder.id, {
    attemptId: mismatchId, status: 'expired'
  }).changed, false, 'после возможного прихода денег Expired не предлагает заплатить повторно');
  assert.equal(fresh.getOrder(mismatchOrder.id).payment.status, 'mismatch');
  assert.equal(fresh.settleOrderPayment(mismatchOrder.id, {
    attemptId: mismatchId, status: 'paid', total: 12200
  }).changed, true, 'исправленная точная сверка доращивает mismatch до paid');
});

test('вебхук сверяет token попытки и подтверждает оплату только через центральную сверку', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const route = source.slice(source.indexOf('function paymentCallbackRoute('), source.indexOf("app.post('/api/pay/crocopay/callback'"));
  const reconcile = source.slice(source.indexOf('async function reconcilePaymentAttempt'), source.indexOf('async function livePayMethods'));
  // Один разбор на обе кассы, но адреса именные: по ним видно, ЧЬИМ ключом
  // проверять уведомление, и token одной кассы не открывает счёт другой.
  assert.match(source, /app\.post\('\/api\/pay\/crocopay\/callback', paymentCallbackRoute\('crocopay'\)\)/);
  assert.match(source, /app\.post\('\/api\/pay\/meridianpay\/callback', paymentCallbackRoute\('meridianpay'\)\)/);
  assert.match(route, /PAYMENTS\.provider\(attempt\.provider\) === p/);
  assert.ok(route.length > 200, 'маршрут вебхука не найден');
  // Подпись сама не адресует нашу попытку: какой это счёт, решают attemptId и
  // отдельный token в callback_url.
  assert.match(route, /timingSafeEqual/);
  assert.match(route, /p\.verifyCallback\(s, req\.body, req\.rawBody\)/);
  assert.match(route, /403/);
  assert.match(route, /db\.findPaymentAttempt\(order, \{ attemptId \}\)/);
  assert.ok(route.indexOf('!tokenOk') < route.indexOf('reconcilePaymentAttempt'), 'проверка обязана идти до сверки');

  // Webhook — только сигнал. Сумме и invoice id из его тела не доверяем: GET
  // конкретного счёта проходит одну и ту же проверку для webhook, polling и sweep.
  assert.doesNotMatch(route, /paidEnough|req\.body\.(amount|sum|invoice)/);
  // Сверять счёт обязана ТА ЖЕ касса, что его выдала: id сделок у них свои.
  assert.match(reconcile, /const p = PAYMENTS\.provider\(attempt && attempt\.provider\)/);
  assert.match(reconcile, /const r = await p\.invoice\(s, invoiceId\)/);
  assert.match(reconcile, /p\.matchesInvoice\(attempt, r\.invoice\)/);
  assert.match(reconcile, /attemptId: attempt\.id, invoiceId, status: state/);
  assert.match(reconcile, /if \(result && result\.changed\) notifyPayment/);
  const identityGuard = reconcile.indexOf("if (match.reason === 'invoice_id')");
  const terminalClose = reconcile.indexOf("if (['expired', 'cancelled', 'failed'].includes(state))");
  assert.ok(identityGuard > -1 && terminalClose > identityGuard,
    'чужой id от GET отсекается до закрытия нашей попытки terminal-статусом');
  assert.match(reconcile.slice(identityGuard, terminalClose), /return \{ ok: false, error: 'invoice_id_mismatch' \}/);

  const start = source.slice(source.indexOf('async function startPaymentRoute('), source.indexOf("app.post('/api/pay/start'"));
  // Обращение к кассе живёт отдельной функцией: маршрут перебирает очередь, а
  // она делает одну попытку у одной кассы.
  const create = source.slice(source.indexOf('async function requestInvoiceFrom('), source.indexOf('function paymentAlternative('));
  // Платить можно только за свой заказ: id лежит в подписанной cookie-сессии.
  assert.match(start, /ownOrder\(req, id\)/);
  assert.match(source, /function ownOrder[\s\S]*req\.session\.myOrders/);
  assert.match(start, /PAYMENTS\.enabled\(s\)/, 'выключенная оплата не должна ходить в платёжку');
  // Способ проверяем по живому объединению касс и настроек до запроса.
  assert.ok(start.indexOf('ctx.methods.some(m => m.id === method)') < start.indexOf('requestInvoiceFrom(p, s, req'));
  // Callback адресует ровно созданную попытку, а не изменяемую верхушку payment.
  assert.match(create, /'&attempt=' \+ encodeURIComponent\(attemptId\) \+ '&token=' \+ attempt\.token/);
  // Ответ кассы записывается адресно только после её запроса.
  assert.ok(create.indexOf('p.createInvoice') < create.indexOf('db.attachOrderInvoice'));
  assert.match(create, /db\.attachOrderInvoice\(id, \{[\s\S]{0,80}attemptId/);
  assert.doesNotMatch(start, /replaceInvoiceId|payReplaceInvoice|stale_replace/,
    'живой invoice не заменяется вторым до конца таймера');
  assert.match(start, /const activeAttempt = R\.payDisplay\(currentOrder\.payment\)/,
    'guard ищет живой invoice во всей legacy-истории, а не только наверху');
  assert.match(create, /terminalAfterFailure[\s\S]{0,140}status: 200/,
    'оплатившийся во время POST старый счёт побеждает ошибку нового запроса');
  const providerCap = start.indexOf("rateLimited(req, 'pay-provider-ip'");
  const providerCall = start.indexOf('requestInvoiceFrom(p, s, req');
  const reuseGuard = start.indexOf('if (activeAttempt && R.payLive(activeAttempt))');
  assert.ok(reuseGuard > -1 && providerCap > reuseGuard && providerCall > providerCap,
    'широкий лимит стоит после безопасного reuse, но до внешнего POST кассы');
  assert.match(start, /pay-provider-global[\s\S]{0,80}'all'/,
    'ротация cookie/IP всё равно упирается в общий бюджет процесса');

  // Опрос статуса — то, ради чего затевался H2H. Оплаченный заказ кассу не
  // тревожит и использует ту же центральную сверку, а не свою трактовку суммы.
  const status = source.slice(source.indexOf('async function paymentStatusRoute('), source.indexOf("app.get('/api/pay/status'"));
  assert.match(status, /ownOrder\(req, req\.query\.order\)/);
  assert.match(status, /pay\.status === 'paid' \|\| pay\.status === 'mismatch'/,
    'старая вкладка прекращает polling после любой уже пришедшей суммы');
  assert.match(status, /reconcilePaymentAttempt\(s, order\.id, attempt\)/);
  assert.doesNotMatch(status, /\.invoice\(s,|settleOrderPayment/);
  assert.match(status, /pay-status-provider-ip/);
  assert.match(status, /pay-status-provider-global/);
  assert.match(status, /req\.query\.attempt[\s\S]{0,260}db\.findPaymentAttempt\(order, \{ attemptId: askedAttempt \}\)/,
    'polling адресован попытке, реквизиты которой показаны на странице');
  const statusAwait = status.indexOf('await reconcilePaymentAttempt');
  const statusReread = status.indexOf('const latest = db.getOrder(order.id)', statusAwait);
  const statusReply = status.indexOf('if (!result.ok)', statusAwait);
  assert.ok(statusAwait > -1 && statusReread > statusAwait && statusReply > statusReread,
    'webhook по другой попытке, пришедший во время GET, получает terminal-приоритет');
  assert.match(status.slice(statusReread, statusReply), /latestState === 'paid' \|\| latestState === 'mismatch'/);
  const payBrowser = fs.readFileSync(path.join(__dirname, '..', 'public', 'pay.js'), 'utf8');
  assert.match(payBrowser, /page\.dataset\.attempt/);
  assert.match(payBrowser, /'&attempt=' \+ encodeURIComponent\(attemptId\)/);

  const sweep = source.slice(source.indexOf('async function reconcileOpenPayments'), source.indexOf('/ОПЛАТА: CrocoPAY'));
  assert.match(sweep, /db\.paymentAttempts\(order\)/);
  assert.match(sweep, /reconcilePaymentAttempt\(s, orderId, attempt\)/);
});

test('terminal-состояние оплаты возвращает успех, а не ложную ошибку повторного клика', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const from = source.indexOf('function terminalPaymentBody(');
  const to = source.indexOf('const paymentStartJobs', from);
  assert.ok(from > -1 && to > from, 'terminalPaymentBody найден');
  const terminalPaymentBody = new Function(source.slice(from, to) + '\nreturn terminalPaymentBody;')();
  assert.equal(terminalPaymentBody({ id: 'o1', payment: { status: 'pending' } }), null);
  assert.deepEqual(terminalPaymentBody({ id: 'o1', payment: { status: 'paid' } }), {
    ok: true, placed: true, reused: true, terminal: 'paid', url: '/pay/o1'
  });
  assert.equal(terminalPaymentBody({ id: 'o1', payment: { status: 'mismatch' } }).terminal, 'mismatch');
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
  const CROCO = require('../lib/payments');
  // Потолок принадлежит кассе, поэтому и проверяем его при включённой оплате:
  // в режиме заявок его нет вовсе (см. следующий тест).
  const ss = { storeName: 'Тест', tagline: '', accentColor: '#0071e3', currency: '₽', currencyPosition: 'after',
    crocopayEnabled: true, crocopayClientId: 'id', crocopayClientSecret: 'secret' };
  const db = { reviewsForProduct: () => [], ratingFor: () => ({ avg: 0, count: 0 }), categories: () => [], visibleCategories: () => [] };
  const base = { id: 'p1', name: 'Товар', category: 'К', inStock: true, images: [], colors: [], bands: [] };

  // Товар, у которого даже стартовая сборка дороже потолка, купить нельзя —
  // значит и на витрине он «Нет в наличии», а не кнопка, ведущая в отказ.
  const pricey = Object.assign({}, base, { price: CROCO.MAX_TOTAL + 10, storages: [], options: [] });
  assert.equal(render.sellable(pricey, ss), false);
  assert.match(render.productPage(ss, db, pricey, { origin: '' }), /Нет в наличии/);
  const fine = Object.assign({}, base, { price: 100000, storages: [], options: [] });
  assert.equal(render.sellable(fine, ss), true);

  // Конфигурация и значение группы, выводящие сборку за потолок, гаснут как
  // распроданные — с той же подписью, чтобы покупателю не пришлось гадать.
  const mac = Object.assign({}, base, {
    price: 200000,
    storages: [{ label: '1 ТБ', add: 0 }, { label: '8 ТБ', add: 100000 }],
    options: [{ name: 'Чип', values: [{ label: 'M5', add: 0 }, { label: 'M5 Max', add: 90000 }] }]
  });
  const html = render.productPage(ss, db, mac, { origin: '' });
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
  const CROCO = require('../lib/payments');
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

  // Пределы уходят на витрину от сервера числами: они нужны на каждой странице
  // (корзина открывается везде), поэтому идут глобальными, как валюта, а не
  // атрибутом страницы оформления.
  const ss = { storeName: 'Тест', tagline: '', accentColor: '#0071e3', currency: '₽', currencyPosition: 'after',
    crocopayEnabled: true, crocopayClientId: 'id', crocopayClientSecret: 'secret' };
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
  assert.match(server, /const limit = PAYMENTS\.limitFor\(settings\(\), grandTotal\);[\s\S]{0,200}return res\.json\(\{ ok: false, error: limit \}, 400\)/);
  assert.match(server, /const grandTotal = total \+ ship\.price;/);
});

test('оплату можно выключить: витрина принимает заявки, а пределы кассы уходят вместе с ней', () => {
  const CROCO = require('../lib/payments');
  // Ключи на месте, снята только галочка: именно так владелец «прячет платёжку».
  const off = { storeName: 'Тест', tagline: '', accentColor: '#0071e3', currency: '₽', currencyPosition: 'after',
    crocopayClientId: 'id', crocopayClientSecret: 'secret' };
  const on = Object.assign({}, off, { crocopayEnabled: true });

  // Пределы одной покупки принадлежат КАССЕ и вместе с ней исчезают: заявку
  // разбирает менеджер, и ограничивать её суммой платёжки незачем. Ноль — «нет
  // предела»: так это число читает и public/app.js.
  assert.deepEqual(CROCO.limits(on), { min: CROCO.MIN_TOTAL, max: CROCO.MAX_TOTAL });
  assert.deepEqual(CROCO.limits(off), { min: 0, max: 0 });
  assert.deepEqual(CROCO.limits({ crocopayEnabled: true }), { min: 0, max: 0 }, 'галочка без ключей — те же заявки');
  // Вторая касса включает те же пределы: они принадлежат режиму оплаты, а не
  // конкретной платёжке.
  assert.deepEqual(CROCO.limits({ meridianpayEnabled: true, meridianpayApiKey: 'k', meridianpayMerchantId: '3f2a1c88-5d94-4e07-9b31-6a0c2e7d5b40' }),
    { min: CROCO.MIN_TOTAL, max: CROCO.MAX_TOTAL });
  assert.match(CROCO.limitFor(on, CROCO.MAX_TOTAL + 1), /не более/);
  assert.equal(CROCO.limitFor(off, CROCO.MAX_TOTAL + 1), '');
  assert.equal(CROCO.limitFor(off, 1), '');
  // Сама касса своих пределов не теряет: /api/pay/crocopay/start спрашивает
  // именно её, и там оплата заведомо включена.
  assert.match(CROCO.limitError(CROCO.MAX_TOTAL + 1), /не более/);

  // Товар дороже потолка в режиме заявок продаётся наравне с остальными.
  const db = { reviewsForProduct: () => [], ratingFor: () => ({ avg: 0, count: 0 }), categories: () => [], visibleCategories: () => [] };
  const pricey = { id: 'vision', name: 'Дорогой', category: 'К', inStock: true, images: [], colors: [], bands: [], storages: [], options: [], price: CROCO.MAX_TOTAL + 100000 };
  assert.equal(render.sellable(pricey, off), true);
  assert.equal(render.sellable(pricey, on), false);
  const page = render.productPage(off, db, pricey, { origin: '' });
  assert.match(page, /Добавить в корзину/);
  assert.doesNotMatch(page, /Нет в наличии/);
  assert.match(page, /window\.__ORDER_MIN__=0;window\.__ORDER_MAX__=0/, 'пределы уходят на витрину нулями');
  const js = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  assert.match(js, /if \(!ORDER_MAX\)/, 'ноль в скрипте означает «предела нет»');

  // Оформление говорит про заявку и менеджера, а не про оплату, и знаков
  // платёжных систем в подвале нет: обещать приём карт в этом режиме нельзя.
  const co = render.checkoutPage(off, { origin: '' });
  assert.doesNotMatch(co, /data-pay="1"/);
  assert.doesNotMatch(co, /footer-pay/);
  assert.match(co, /менеджер свяжется с вами и подтвердит наличие/);
  assert.match(js, /function submitLabel\(\) \{ return payOnline\(\) \? 'Перейти к оплате' : 'Оформить заказ'; \}/);
  assert.match(js, /Оплата не онлайн: менеджер свяжется с вами/);

  // Заявка сразу настоящая: черновиком заказ становится только ради выбора
  // способа оплаты, а выбирать в этом режиме нечего.
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.match(server, /const draft = PAYMENTS\.enabled\(s\);/);
});

test('в настройках видно режим витрины, а касса переживает выключение целиком', () => {
  const db = { pendingReviewCount: () => 0 };
  const base = Object.assign(dbCore.defaultSettings(), {
    crocopayClientId: 'ID-КАССЫ', crocopayClientSecret: 'СЕКРЕТ', payMethods: ['SBP']
  });
  const offHtml = adminViews.settingsPage(base, db, null);
  assert.match(offHtml, /Сейчас: заявки без оплаты/);
  assert.doesNotMatch(offHtml, /Сейчас: оплата на витрине/);
  // Вернуть оплату — одна галочка: ключи, валюта и способы остаются в форме.
  // Убрать их со страницы нельзя вовсе — снятые галочки в теле формы просто
  // отсутствуют, и пропавшая секция стёрла бы выбор владельца первым же
  // «Сохранить». Свёрнутый <details> при этом отправляется как обычно.
  assert.match(offHtml, /name="crocopayClientId" value="ID-КАССЫ"/);
  assert.match(offHtml, /name="crocopayClientSecret" value="СЕКРЕТ"/);
  assert.match(offHtml, /name="payMethodsForm"/);
  assert.match(offHtml, /name="payMethods" value="SBP" checked/);
  assert.match(offHtml, /name="crocopayCurrencyChoice"/);
  assert.match(offHtml, /<details class="pay-fold is-off">/, 'в режиме заявок ключи свёрнуты');

  /* Включение касс стоит ДО ключей и вне свёрток.
   *
   * Это единственное решение раздела, которое принимают часто, и оно обязано
   * быть видно, ничего не раскрывая. Пока галочки лежали внутри свёрток, чтобы
   * включить кассу, надо было сперва открыть строку «выключена» — то есть
   * развернуть секцию с ключами ради того, чтобы ключей не трогать.
   */
  assert.match(offHtml, /class="pay-switches"[\s\S]{0,400}name="crocopayEnabled"[\s\S]{0,400}name="meridianpayEnabled"/);
  assert.ok(offHtml.indexOf('class="pay-switches"') < offHtml.indexOf('<details class="pay-fold'),
    'переключатели касс стоят выше свёрток с ключами');

  const onHtml = adminViews.settingsPage(Object.assign({}, base, { crocopayEnabled: true }), db, null);
  assert.match(onHtml, /Сейчас: оплата на витрине/);
  /* Свёртка раскрыта РОВНО ТОГДА, когда с кассой что-то не так: включена, а
   * ключей нет. Настроенная и работающая остаётся закрытой — ключи это секреты,
   * держать их развёрнутыми на экране незачем, а две открытые секции подряд
   * растягивают страницу настроек вдвое. */
  assert.doesNotMatch(onHtml, /<details class="pay-fold[^"]*" open>/, 'работающая касса ключи не разворачивает');
  const halfSet = adminViews.settingsPage(Object.assign({}, base, { crocopayEnabled: true, crocopayClientSecret: '' }), db, null);
  assert.equal((halfSet.match(/<details class="pay-fold[^"]*" open>/g) || []).length, 1,
    'раскрыта ровно та касса, у которой не хватает ключей');

  // Плашка говорит про то, что видит ПОКУПАТЕЛЬ, а не про саму галочку:
  // включённая без ключей оставляет витрину в режиме заявок.
  const noKeys = adminViews.settingsPage(Object.assign({}, base, { crocopayEnabled: true, crocopayClientSecret: '' }), db, null);
  assert.match(noKeys, /Сейчас: заявки без оплаты/);
  assert.match(noKeys, /ключи не заданы/);

  // Касс две, и у каждой своя свёртка со своей галочкой. Включена одна —
  // плашка честно говорит, что подстраховать её некому: покупатель увидит отказ
  // своими глазами, а не молчаливый переход на вторую.
  assert.match(offHtml, /MeridianPay/);
  assert.match(offHtml, /name="meridianpayMerchantId"/);
  /* Кассы здесь никто не спрашивал (страница собрана без живого ответа),
   * поэтому плашка говорит только то, что знает наверняка: какие кассы
   * ВКЛЮЧЕНЫ. «Работают» и «на связи» — это уже про ответ кассы, и писать их,
   * не спросив, нельзя (см. тест про состояние касс ниже). */
  assert.match(onHtml, /Включена одна касса — CrocoPAY, подстраховки нет\./);
  /* Плашка режима — ровно состояние, без объяснений: подсказки под ней убраны
   * все. Осталось только то, чего иначе не узнать, — включена оплата и какие
   * кассы работают. */
  assert.doesNotMatch(onHtml, /После оформления покупатель попадает/);
  assert.doesNotMatch(offHtml, /менеджер свяжется с ним и подтвердит наличие/);
  assert.match(offHtml, /<p class="pay-mode is-off"><b>Сейчас: заявки без оплаты\.<\/b><\/p>/);

  /* Диапазон суммы заказа правится в настройках: числа принадлежат кассе, а
   * какие они у конкретной — знает только владелец. От потолка зависит и то,
   * какие товары продаются: дороже него карточка становится «Нет в наличии». */
  assert.match(offHtml, /name="payMinTotal"/);
  assert.match(offHtml, /name="payMaxTotal"/);

  // Блок выхода — одна кнопка и ничего больше.
  assert.match(offHtml, /<div class="a-panel a-exit">\s*<form action="\/admin\/logout"/);
  assert.doesNotMatch(offHtml, /Панель закроется/);
  const both = adminViews.settingsPage(Object.assign({}, base, {
    crocopayEnabled: true, meridianpayEnabled: true,
    meridianpayApiKey: 'КЛЮЧ', meridianpayMerchantId: '3f2a1c88-5d94-4e07-9b31-6a0c2e7d5b40'
  }), db, null);
  assert.match(both, /Включены обе кассы: CrocoPAY и MeridianPay\./);
  /* «Спрашивать первой» видно ВСЕГДА, при любом числе включённых касс.
   * Пряталось оно, пока включена одна, — и со стороны это выглядело не как
   * экономия места, а как пропавшая настройка: пока вторая касса ждёт
   * модерации, порядок задают заранее, и найти его надо тогда же. */
  assert.match(both, /Порядок опроса/);
  assert.match(onHtml, /Порядок опроса/, 'с одной кассой выбор первой всё равно доступен');
  assert.match(offHtml, /name="payPrimary"/, 'в режиме заявок настройка тоже на месте');
  // Ключи второй кассы так же переживают выключение и так же не теряются.
  assert.match(both, /name="meridianpayApiKey" value="КЛЮЧ"/);
  // Порядок опроса — настройка владельца, а не порядок в коде.
  assert.match(both, /name="payPrimary"/);
  // Переключатели остаются на месте при любом режиме: их отсутствие стёрло бы
  // выбор владельца первым же «Сохранить».
  assert.match(both, /class="pay-switch"/);
});

/* Состояние касс — по живому ответу, а не по заполненным ключам.
 *
 * Ловушка, ради которой всё это писалось: панель писала «работает» ровно
 * потому, что в настройках заполнены ключи. Касса при этом могла не отвечать
 * вовсе, отвергать ключи или (как MeridianPay всё время модерации) отвечать на
 * что угодно, кроме создания сделок, — а владелец узнавал правду от покупателя.
 */
test('панель говорит состояние касс, а не пересказывает галочку', () => {
  const PAYMENTS = require('../lib/payments');
  const ERR = require('../lib/pay-errors');
  const db = { pendingReviewCount: () => 0 };
  const uuid = '3f2a1c88-5d94-4e07-9b31-6a0c2e7d5b40';
  const both = Object.assign(dbCore.defaultSettings(), {
    crocopayEnabled: true, crocopayClientId: 'ID', crocopayClientSecret: 'СЕКРЕТ',
    meridianpayEnabled: true, meridianpayApiKey: 'КЛЮЧ', meridianpayMerchantId: uuid,
    payMethods: ['SBP', 'TO_CARD']
  });

  // Разбор ответа: что именно сказала касса. Строки здесь настоящие — сняты с
  // живых касс 24 августа 2026, а не придуманы.
  assert.equal(PAYMENTS.healthState({ ok: true }), 'ok');
  assert.equal(PAYMENTS.healthState({ ok: false, error: 'Invalid Access Token.' }), 'auth');
  assert.equal(PAYMENTS.healthState({ ok: false, error: 'Can not verify the client. Please check client Id and Client Secret.' }), 'auth');
  assert.equal(PAYMENTS.healthState({ ok: false, error: 'timeout' }), 'down');
  assert.equal(PAYMENTS.healthState({ ok: false, error: 'fetch failed' }), 'down');
  assert.equal(PAYMENTS.healthState({ ok: false, error: 'http_502' }), 'down');
  // Медленная касса — это НЕ «не отвечает»: запрос жив и заполнит кэш к
  // следующему открытию страницы.
  assert.equal(PAYMENTS.healthState({ ok: false, error: 'timeout', pending: true }), 'slow');
  assert.equal(PAYMENTS.healthState(null), 'unknown', 'не спрашивали — так и говорим');

  // Живой ответ: CrocoPAY на связи, MeridianPay ключи не приняла.
  const live = {
    ok: true,
    currencies: ['RUB'],
    byCurrency: { RUB: ['SBP', 'TO_CARD'] },
    byProvider: { crocopay: { currencies: ['RUB'], byCurrency: { RUB: ['SBP', 'TO_CARD'] } }, meridianpay: null },
    status: {
      crocopay: { ok: true, error: '', currencies: ['RUB'], methods: ['SBP', 'TO_CARD'] },
      meridianpay: { ok: false, error: 'Invalid Access Token.', currencies: [], methods: [] }
    }
  };
  const health = PAYMENTS.health(both, live);
  assert.deepEqual(health.map(r => r.state), ['ok', 'auth']);
  assert.equal(health[0].live, true);
  assert.equal(health[1].live, false);
  // Выключенная и ненастроенная кассы разводятся по разным состояниям: «нечего
  // спрашивать» и «спросить нечем» — разные беды с разным лечением.
  assert.equal(PAYMENTS.health(Object.assign({}, both, { meridianpayEnabled: false }), live)[1].state, 'off');
  assert.equal(PAYMENTS.health(Object.assign({}, both, { meridianpayApiKey: '' }), live)[1].state, 'nokeys');

  /* Свёрнутая строка кассы и ЕСТЬ её состояние — отдельным блоком над
   * свёртками это стояло один заход и было выброшено: строки повторяли подписи
   * свёрток слово в слово, и на четыре строки экрана приходилось два факта. */
  const html = adminViews.settingsPage(both, db, null, 'ok', { live });
  assert.match(html, /<b>CrocoPAY<\/b><span class="pay-fold-note">на связи · 2 способа<\/span>/);
  assert.match(html, /<b>MeridianPay<\/b><span class="pay-fold-note">ключи не приняты кассой<\/span>/);
  assert.equal(html.includes('class="pay-state"'), false, 'состояние не дублируется отдельным блоком');
  // Слово «работает» из подписи свёртки ушло вместе с причиной, по которой оно
  // там стояло: оно означало «ключи заполнены», а читалось как «касса выдаёт
  // реквизиты».
  assert.doesNotMatch(html, /pay-fold-note">работает/);
  assert.match(html, /На связи только CrocoPAY — вторая не отвечает\./);
  /* Медленная касса — НЕ молчащая: её ответ идёт своим ходом и приедет к
   * следующему открытию страницы (список банков у MeridianPay честно занимает
   * восемь секунд). Сказать про неё «не отвечает» значило бы звать чинить то,
   * что чинить не нужно. */
  const slow = adminViews.settingsPage(both, db, null, 'ok', {
    live: Object.assign({}, live, {
      status: Object.assign({}, live.status, {
        meridianpay: { ok: false, error: 'timeout', pending: true, currencies: [], methods: [] }
      })
    })
  });
  assert.match(slow, /На связи CrocoPAY, вторая ещё не ответила\./);
  assert.match(slow, /касса отвечает слишком медленно — список ещё грузится/);
  // Касса, чьи ключи не приняты, разворачивает свои поля: чинить надо там.
  assert.equal((html.match(/<details class="pay-fold[^"]*" open>/g) || []).length, 1);

  // Ни одна не ответила — плашка говорит это прямо: покупатель реквизитов не
  // получит, и узнать об этом владелец должен раньше него.
  const mute = adminViews.settingsPage(both, db, null, 'ok', {
    live: Object.assign({}, live, {
      ok: false,
      status: {
        crocopay: { ok: false, error: 'fetch failed', currencies: [], methods: [] },
        meridianpay: { ok: false, error: 'fetch failed', currencies: [], methods: [] }
      }
    })
  });
  assert.match(mute, /ни одна касса не отвечает/);

  /* Вторая строка — про СДЕЛКИ, и берётся она из истории заказов: живым
   * опросом это не узнать вовсе (проверено на живом API — GET и отмена отдают
   * обычный 404, а POST сперва проверяет поля), а проверочные сделки мы кассам
   * не шлём. Поэтому у кассы, которую ещё ни разу не спрашивали, честно стоит
   * «сделок ещё не выдавала»: связь — это ещё не оплата. */
  assert.match(html, /MeridianPay<\/b>[\s\S]{0,200}сделок ещё не выдавала/);

  // Модерация мерчанта — свой код отказа, а не «способ недоступен». Разница
  // важна: другой способ оплаты тут не поможет ни один, и владелец должен
  // видеть это словами.
  assert.equal(ERR.codeOf('Мерчант находится на модерации.'), 'merchant_off');
  assert.equal(ERR.shortOf('merchant_off'), 'мерчант не допущен к сделкам');
  // А покупателю — ровно тот же нейтральный текст, что и про недоступный
  // способ: про нашу модерацию ему знать незачем.
  assert.equal(ERR.messageOf('Мерчант находится на модерации.'), ERR.messageOf('method_unavailable'));

  const at = Date.parse('2026-08-23T16:12:00Z');
  const stats = render.providerStats([{ payment: { attempts: [
    { provider: 'meridianpay', lastErrorCode: 'merchant_off', lastErrorAt: at, status: 'pending' },
    { provider: 'crocopay', invoiceId: 'x', requisite: '+7 900 000-00-00', startedAt: at, status: 'pending' }
  ] } }]);
  const meridian = stats.find(r => r.id === 'meridianpay');
  assert.equal(meridian.lastErrorCode, 'merchant_off');
  assert.equal(stats.find(r => r.id === 'crocopay').lastIssuedAt, at);

  const withHistory = adminViews.settingsPage(both, Object.assign({}, db, {
    getOrders: () => [{ payment: { attempts: [
      { provider: 'meridianpay', lastErrorCode: 'merchant_off', lastErrorAt: at, status: 'pending' }
    ] } }]
  }), null, 'ok', { live });
  assert.match(withHistory, /последний ответ на сделку: мерчант не допущен к сделкам/);
});

/* Список банков MeridianPay идёт восемь секунд, и это не повод его терять.
 *
 * Замер с боевого сервера (24 августа 2026): 8,4–8,7 с на 317 КБ и 906 банков,
 * три замера подряд. В отведённые списку четыре секунды он не укладывается
 * НИКОГДА — то есть до этой правки живой список второй кассы не доезжал ни
 * разу, и витрина показывала «объединение возможностей» из одной кассы.
 */
test('медленный список банков не теряется и не задерживает страницу', async () => {
  const meridian = require('../lib/meridianpay');
  const on = { meridianpayEnabled: true, meridianpayApiKey: 'КЛЮЧ', meridianpayMerchantId: '3f2a1c88-5d94-4e07-9b31-6a0c2e7d5b40' };
  const real = global.fetch;
  const gateways = [{ code: 'sberbank_rub', currency: 'rub', detail_types: ['card', 'phone', 'nspk'], min_limit: '999', max_limit: '300000' }];
  let calls = 0;
  meridian.forgetMethods();
  try {
    global.fetch = async () => { calls++; return { ok: true, status: 200, json: async () => ({ success: true, data: gateways }) }; };
    // Два открытия страницы разом (оплата и настройки) — запрос ОДИН: список у
    // кассы один, а стоит он восемь секунд.
    const [a, b] = await Promise.all([meridian.availableOptions(on), meridian.availableOptions(on)]);
    assert.equal(calls, 1, 'запрос списка склеивается на всех, кто его ждёт');
    assert.deepEqual(a.options, b.options);
    assert.ok(a.options.includes('SBP') && a.options.includes('TO_CARD'));
    // Дальше он лежит в кэше и в сеть не ходит вовсе.
    const cached = await meridian.availableOptions(on);
    assert.equal(calls, 1);
    assert.equal(cached.cached, true);
  } finally {
    meridian.forgetMethods();
    if (real) global.fetch = real; else delete global.fetch;
  }
  // Ждём мы список не дольше, чем не жалко покупателю, а идёт он своим сроком —
  // и этот срок обязан быть больше измеренных восьми секунд, иначе список опять
  // будет обрываться на полпути.
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'meridianpay.js'), 'utf8');
  const num = name => Number((src.match(new RegExp('const ' + name + ' = (\\d+)')) || [])[1]);
  assert.ok(num('LIST_TIMEOUT') >= 20000, 'запрос списка живёт дольше своих восьми секунд');
  assert.ok(num('OPTIONS_TIMEOUT') <= 5000, 'а страница ждёт его недолго');
  assert.ok(num('LIST_TIMEOUT') > num('OPTIONS_TIMEOUT'));
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
  assert.match(route, /Укажите адрес/);
  // Адрес покупателя и пункт выдачи — два разных требования: первый есть у
  // любого заказа, второй только у доставки в пункт.
  assert.match(route, /Выберите пункт выдачи/);
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

test('телефон обязателен и разбирается одним модулем на витрину и сервер', () => {
  const P = require('../public/phone.js');

  // Россия — страна по умолчанию и она же в приоритете: «+7» это она, а
  // Казахстан, который делит с ней код, узнаётся по «+7 7…» и «+7 6…».
  assert.equal(P.check('+7 999 123-45-67').country, 'RU');
  assert.equal(P.check('+7 705 123-45-67').country, 'KZ');
  assert.equal(P.check('+7 999 123-45-67').e164, '+79991234567');
  assert.equal(P.format('+79991234567'), '+7 999 123-45-67');
  // Привычная местная запись исправляется сама — ради этого всё и затевалось.
  assert.equal(P.check('8 (999) 123-45-67').e164, '+79991234567');
  assert.equal(P.check('9991234567').e164, '+79991234567');
  assert.equal(P.check('+7 8 999 123-45-67').e164, '+79991234567', 'местная восьмёрка после кода страны');
  // …но честную восьмёрку в самом номере трогать нельзя.
  assert.equal(P.check('+7 800 555-35-35').e164, '+78005553535');
  // Соседи по СНГ узнаются и форматируются по своим маскам.
  assert.equal(P.check('+375 29 123-45-67').country, 'BY');
  assert.equal(P.check('+380501234567').country, 'UA');
  assert.equal(P.format('+998901234567'), '+998 90 123-45-67');
  assert.equal(P.check('+37491234567').country, 'AM');
  // Страна без маски принимается как есть: врать про формат хуже, чем показать
  // номер как есть, а отказать верному номеру — хуже всего.
  assert.equal(P.check('+4915112345678').ok, true);
  // Недобранный, пустой и с неизвестным кодом — отказ, и текст один на всех.
  assert.equal(P.check('+7 999').ok, false);
  assert.equal(P.check('').error, 'Укажите номер телефона');
  assert.equal(P.check('+999123456789').ok, false);
  // Флаг — эмодзи из пары региональных индикаторов, как у карточек метрики.
  assert.equal(P.flag('RU'), '🇷🇺');
  assert.equal(P.flag('чужое'), '');
  // Лишние цифры в поле не копятся: скопированный номер с добавочным
  // становится нормальным номером, а не отказом на верном номере.
  assert.equal(P.format('+7 (999) 123-45-67 доб. 12'), '+7 999 123-45-67');

  // Сервер проверяет сам и ДО записи: клиентским данным не верим, как и в цене.
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const route = server.slice(server.indexOf("app.post('/api/order'"), server.indexOf('/* ====================== ОПЛАТА'));
  assert.match(route, /PHONE\.check\(req\.body\.phone\)/);
  assert.ok(route.indexOf('PHONE.check(req.body.phone)') < route.indexOf('db.createOrder'),
    'телефон обязан проверяться до записи заказа');
  // Второй контакт стал необязательным: телефон уже обязателен, и требовать
  // ещё и Telegram значило бы спрашивать одно и то же дважды.
  assert.doesNotMatch(route, /Укажите контакт для связи/);

  // Витрина шлёт номер отдельным полем и проверяет тем же модулем.
  const js = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  assert.match(js, /phone: phoneValue\(\)/);
  assert.match(js, /id="co-phone"/);
  assert.match(js, /type="tel"/);
  assert.match(js, /autocomplete="tel"/);
  assert.match(js, /window\.Phone\.check\(value\)/);
  assert.match(js, /window\.Phone\.attach\(document\.getElementById\('co-phone'\)\)/);
  /* Своей таблицы кодов у витрины нет — то же правило, что у способов доставки:
   * разъехавшись, она приняла бы номер, который сервер потом отверг. */
  assert.doesNotMatch(js, /'375'|'998'|\+375|\bDEFAULT = 'RU'/, 'коды стран не дублируются в скрипте');
  // Файл подключается только на оформлении: на остальных страницах он был бы
  // лишним запросом.
  const ss = { storeName: 'Тест', tagline: '', accentColor: '#0071e3', currency: '₽', currencyPosition: 'after' };
  const co = render.checkoutPage(ss, { origin: '' });
  assert.match(co, /\/static\/phone\.js\?v=/);
  assert.doesNotMatch(render.notFoundPage(ss, { origin: '' }), /phone\.js/);

  // Поле телефона — обычный `.field`, и общее правило ширины обязано его
  // накрывать: `input[type=tel]` в этом списке не было вовсе.
  const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'styles.css'), 'utf8');
  assert.match(css, /\.field input\[type=tel\]/);
  assert.match(css, /\.field \.phone-box input\[type=tel\]\{padding-left/, 'отступ слева обязан перебивать общее правило поля');

  /* Телефон и второй контакт стоят ОДНИМ РЯДОМ, как имя с фамилией, и
   * складываются в столбик на узком экране: два поля об одном и том же
   * растягивали шаг «Получатель» вдвое. */
  assert.match(js, /<div class="co-contacts">/);
  assert.match(css, /\.co-names,\.co-contacts\{display:grid/);
  assert.match(css, /\.co-contacts\{grid-template-columns:1fr\}/, 'на узком экране ряд обязан складываться');
  /* Значок способа связи берёт цвет и размер у текста подписи — иначе он
   * разъедется с ней в первой же правке палитры. Своего цвета у него нет. */
  assert.match(css, /\.note-ico\{width:1\.15em;height:1\.15em;[^}]*fill:currentColor\}/);
  assert.doesNotMatch(css, /\.note-ico\{[^}]*fill:#/, 'цвет значка задаётся только текстом');
  assert.match(css, /\.ico-word\{white-space:nowrap\}/, 'значок не отрывается от своего слова');
  for (const name of ['whatsapp', 'mobile', 'telegram', 'mail']) {
    assert.ok(js.indexOf(name + ':') > -1, 'нет глифа ' + name);
  }
  assert.match(js, /Введите номер ' \+ iconWord\('whatsapp', 'WhatsApp'\)/);
  assert.match(js, /iconWord\('telegram', 'Telegram'\)/);
  // Подписи, которые убрали: телефон больше не обещает трек-номер, а у второго
  // контакта нет строки «по желанию» — её заменяет отсутствие звёздочки.
  assert.doesNotMatch(js, /пришлём трек-номер/);
  assert.doesNotMatch(js, /переписываться удобнее/);

  // Хранилище держит одну форму номера: искать заказ по телефону можно только
  // когда номер записан одинаково.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'store-phone-'));
  const fresh = freshDb(dir);
  const order = fresh.createOrder({
    items: [], total: 68500, firstName: 'Иван', lastName: 'Петров', phone: '8 (999) 123-45-67'
  });
  assert.equal(order.phone, '+79991234567');
  assert.equal(fresh.createOrder({ items: [], total: 100, phone: 'позвоните вечером' }).phone, '',
    'не номер — пустая строка, а не мусор в заказе');
  // Прежние заявки телефона не имеют вовсе и читаются как были.
  const old = fresh.createOrder({ items: [], total: 100, contact: '@severov' });
  assert.equal(old.phone, '');

  // В панели номер показывается тем же форматом, что и в поле ввода: два
  // формата одного номера читались бы как два разных номера.
  const row = render.orderClient(order);
  assert.match(row, /\+7 999 123-45-67/);
  assert.match(row, /🇷🇺/);
  assert.match(render.orderClient(old), /@severov/);
  fs.rmSync(dir, { recursive: true, force: true });
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
  const CROCO = require('../lib/payments');

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
  assert.match(route, /SHIP\.quote\(delivery, deliveryMode, address, total, PAYMENTS\.limits\(settings\(\)\)\.max\)/);
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
  const rail = js.slice(js.indexOf('function renderRail'), js.indexOf('function renderRail') + 2400);
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

/* ====================== Ближайшие пункты выдачи ====================== */

// Кусочек базы вместо настоящей: скачивать список перевозчика в тесте нельзя,
// а всё, что проверяется ниже, от размера базы не зависит.
function seedPickup(dir, points) {
  const PICKUP = freshPickup(dir);
  PICKUP.save({ version: PICKUP.VERSION, updatedAt: Date.now(), sources: {}, points });
  return PICKUP;
}
const PICKUP_SAMPLE = [
  { carrier: 'cdek', code: 'YEKB97', region: 'Свердловская область', city: 'Екатеринбург', short: 'ул. Малышева, 53', lat: 56.8362, lon: 60.6155, type: 'postamat', hours: 'Пн-Вс 10:00-20:00' },
  { carrier: 'cdek', code: 'YEKB121', region: 'Свердловская область', city: 'Екатеринбург', short: 'ул. Белинского, 54', lat: 56.8309, lon: 60.6205, type: 'pvz', hours: 'Пн-Пт 10:00-21:00' },
  { carrier: 'cdek', code: 'NSK376', region: 'Новосибирская область', city: 'Новосибирск', short: 'ул. Колхидская, 6', lat: 54.9866, lon: 82.8158, type: 'pvz', hours: '' },
  { carrier: 'cdek', code: 'NN12', region: 'Нижегородская область', city: 'Нижний Новгород', short: 'пр-т Ленина, 9', lat: 56.2565, lon: 43.8636, type: 'pvz', hours: '' }
];

test('скидка на оформлении показана тем же языком, что и в каталоге', () => {
  const js = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'styles.css'), 'utf8');
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const D = require('../lib/discount');

  /* Цену для сравнения считает СЕРВЕР тем же способом, что и зачёркнутую на
   * карточке: процент товара от ПОЛНОЙ цены сборки. Своей формулы у витрины
   * нет — она разъехалась бы с каталогом на первом же товаре с доплатой. */
  const cart = server.slice(server.indexOf("app.post('/api/cart'"), server.indexOf("app.post('/api/address-suggest'"));
  assert.match(cart, /const compare = D\.compareFor\(price, D\.discountPct\(view\)\)/);
  assert.match(cart, /price, compare,/);
  // Процент одинаков у любой сборки, а выгода в рублях у дорогой больше — так
  // скидка и работает. Раньше было наоборот: рубли те же, процент таял.
  const p = { price: 66990, discountPercent: 13 };
  assert.equal(D.discountPct(p), 13);
  const back = sum => Math.round((1 - sum / D.compareFor(sum, D.discountPct(p))) * 100);
  assert.equal(back(66990), 13);
  assert.equal(back(66990 + 12000), 13, 'процент обязан остаться прежним у сборки с доплатой');
  assert.ok(D.compareFor(78990, 13) - 78990 > D.compareFor(66990, 13) - 66990, 'в рублях дорогая сборка выгоднее');

  // Разметка позиции — те же классы, что и в карточке каталога: розовая цена,
  // зачёркнутая старая с наклонной чертой, розовый процент.
  assert.match(js, /class="card-price' \+ \(sale \? ' price-sale' : ''\)/);
  assert.match(js, /class="price-now"/);
  assert.match(js, /class="price-was"><span class="old-price"/);
  assert.match(js, /class="save">−' \+ sale\.pct \+ '%/);
  assert.match(css, /\.co-item-unit \.card-price\{/);
  // Стиль общий с каталогом, а не скопированный: правило розовой цены и черты
  // одно на всю витрину.
  assert.match(css, /\.price-sale \.price-now\{color:var\(--sale\)\}/);
  assert.match(css, /\.card-price \.old-price::before\{content:""/);

  // Выгода видна дважды и по-разному: рублями у позиции и строкой в сводке.
  assert.match(js, /выгода ' \+ money\(sale\.saved \* i\.qty\)/);
  assert.match(js, /co-line-save"><span>Скидка<\/span><span>−/);
  assert.match(css, /\.co-line-save span\{color:var\(--sale\)/);
  /* Столбик сводки обязан сходиться: при скидке «Товары» показывают сумму ДО
   * неё, иначе покупатель вычитает скидку и не получает итог. */
  assert.match(js, /var goods = saved > 0 \? money\(Cart\.total\(\) \+ saved\) : sum/);

  // У распроданной позиции процента нет: обещать выгоду на том, что не попадёт
  // в заказ, незачем — то же правило, что и в карточке каталога.
  assert.match(js, /out \? '' : '<span class="save">/);
  // И плашки «Распродажа» здесь нет: миниатюра 80 px, слово в неё не влезает.
  assert.doesNotMatch(js, /card-sale/);

  // Выгода считается по тем же позициям, что и сумма: у распроданной цены в
  // итоге нет, и выгоды по ней тоже нет.
  const saved = js.slice(js.indexOf('saved: function'), js.indexOf('saved: function') + 420);
  assert.match(saved, /i\.available === false/);
  assert.match(saved, /Number\(i\.compare\)/);
});

test('пункт выдачи ищется по координатам, а без них — по названию города', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pickup-'));
  const PICKUP = seedPickup(dir, PICKUP_SAMPLE);
  const ADDRESS = require('../lib/address');

  // Координаты — главный путь: их отдаёт подсказка dadata.ru вместе с адресом.
  const near = PICKUP.nearest('cdek', { lat: 56.836094, lon: 60.614637 });
  assert.equal(near.length, 2);
  assert.equal(near[0].code, 'YEKB97', 'первым обязан идти ближайший');
  assert.ok(near[0].km < near[1].km, 'список отсортирован по расстоянию');
  assert.equal(near[0].postamat, true, 'постамат отличается от пункта выдачи');

  // Адрес пункта ОБЯЗАН проходить проверку полноты: иначе покупатель выберет
  // пункт, а оформление откажет — и виноват будет магазин, а не данные.
  for (const p of near) assert.equal(ADDRESS.checkAddress(p.address).ok, true, 'неполный адрес пункта: ' + p.address);
  // Регион в строке нужен зоне доставки: без него Екатеринбург уехал бы в «ru»
  // со средним тарифом по стране.
  const Z = require('../lib/delivery-zones');
  assert.equal(Z.zoneFor(near[0].address), 'ural');
  assert.match(near[0].address, /^Свердловская область, Екатеринбург, /);
  // А в списке регион не нужен — покупатель и так смотрит на пункты рядом с собой.
  assert.equal(near[0].title, 'Екатеринбург, ул. Малышева, 53');

  // Далёкое место — пусто, а не «ближайший пункт в 900 км».
  assert.equal(PICKUP.nearest('cdek', { lat: 53.5, lon: 107.7 }).length, 0);

  // Без координат ищем по городу, и расстояние тогда НЕ показываем: считать его
  // от центра города и подписывать «от вас» было бы враньём.
  const byCity = PICKUP.nearest('cdek', { address: 'Новосибирск, ул Ленина, 10' });
  assert.equal(byCity.length, 1);
  assert.equal(byCity[0].code, 'NSK376');
  assert.equal(byCity[0].km, null);
  // Название в два слова не должно рассыпаться на «Новгород».
  assert.equal(PICKUP.nearest('cdek', { address: 'Нижний Новгород, ул Большая Покровская, 1' })[0].code, 'NN12');
  // Улица выбрасывается вместе с маркером — иначе «ул. Кирова» находила бы
  // посёлок Кирова в другой области. Города нет — предлагать нечего.
  assert.equal(PICKUP.nearest('cdek', { address: 'ул Кирова, 5' }).length, 0);
  // Перевозчика в базе нет вовсе — это не ошибка и не пустой город.
  assert.equal(PICKUP.nearest('ozon', { lat: 56.836, lon: 60.614 }).length, 0);
  assert.equal(PICKUP.has('ozon'), false);
  assert.equal(PICKUP.has('cdek'), true);

  fs.rmSync(dir, { recursive: true, force: true });
});

test('база пунктов не найдена — оформление работает, но сервер об этом говорит', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pickup-empty-'));
  const PICKUP = freshPickup(dir);
  // Молчаливое «фича просто не работает» — ровно та грабля, что была с
  // ImageMagick, поэтому пустая база обязана быть слышной.
  assert.match(PICKUP.staleNote(), /пуста/);
  assert.equal(PICKUP.nearest('cdek', { lat: 55.75, lon: 37.61 }).length, 0);
  assert.equal(PICKUP.findPoint('cdek', 'MSK1'), null);

  // Устаревшая база тоже: пункты открываются и закрываются постоянно.
  PICKUP.save({ version: 1, updatedAt: Date.now() - 90 * 86400000, sources: {}, points: PICKUP_SAMPLE });
  assert.match(PICKUP.staleNote(), /обновлялась 90 дн/);
  PICKUP.save({ version: 1, updatedAt: Date.now(), sources: {}, points: PICKUP_SAMPLE });
  assert.equal(PICKUP.staleNote(), '');

  fs.rmSync(dir, { recursive: true, force: true });
});

test('адрес пункта выдачи в заказе берётся из базы, а не от браузера', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pickup-order-'));
  const PICKUP = seedPickup(dir, PICKUP_SAMPLE);

  // Код есть в базе — адрес и зона считаются по нему, что бы ни прислал браузер.
  const point = PICKUP.findPoint('cdek', 'YEKB121');
  assert.ok(point);
  assert.equal(PICKUP.addressOf(point), 'Свердловская область, Екатеринбург, ул. Белинского, 54');
  assert.equal(PICKUP.findPoint('cdek', 'нет-такого'), null);
  // Чужой перевозчик по коду не находится: пункты СДЭК не годятся для OZON.
  assert.equal(PICKUP.findPoint('ozon', 'YEKB121'), null);

  // Маршрут заказа обязан брать адрес пункта из базы, а адрес покупателя —
  // оставлять как есть: это разные поля и разные вещи.
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const route = server.slice(server.indexOf("app.post('/api/order'"), server.indexOf('/* ====================== ОПЛАТА'));
  assert.match(route, /PICKUP\.findPoint\(delivery, req\.body\.pickupCode\)/);
  assert.match(route, /if \(!point\) return res\.json\(\{ ok: false, error: 'Выберите пункт выдачи' \}/);
  assert.match(route, /pickupAddress = PICKUP\.addressOf\(point\)/);
  assert.match(route, /const address = String\(req\.body\.address \|\| ''\)\.trim\(\)/);
  // Пункт берётся только у «в пункт выдачи»: курьеру он ни к чему.
  assert.match(route, /if \(deliveryMode === 'pvz'\)/);
  // Оба адреса проверяются на полноту, и оба — до записи заказа.
  assert.ok(route.indexOf('ADDRESS.checkAddress(pickupAddress)') < route.indexOf('db.createOrder'),
    'адрес пункта обязан проверяться до записи');
  assert.ok(route.indexOf('ADDRESS.checkAddress(address)') < route.indexOf('db.createOrder'),
    'адрес покупателя обязан проверяться до записи');
  // Зона считается по адресу ПОКУПАТЕЛЯ: иначе цена менялась бы от выбора
  // пункта, и показанная сумма разошлась бы с той, что уйдёт в заказ.
  assert.match(route, /SHIP\.quote\(delivery, deliveryMode, address, total, PAYMENTS\.limits\(settings\(\)\)\.max\)/);

  // Хранилище отсеивает мусор в коде, но существование пункта проверяет маршрут:
  // lib/db не может требовать lib/pickup — вышло бы кольцо require.
  const fresh = freshDb(dir);
  const order = fresh.createOrder({
    items: [], total: 68500, contact: 'tg', firstName: 'Иван', lastName: 'Петров',
    delivery: 'cdek', deliveryMode: 'pvz', address: 'г Екатеринбург, ул Малышева, д 51',
    pickupAddress: 'Свердловская область, Екатеринбург, ул. Белинского, 54', pickupCode: 'YEKB121'
  });
  assert.equal(order.pickupCode, 'YEKB121');
  // Адрес покупателя выбор пункта не трогает — это его данные.
  assert.equal(order.address, 'г Екатеринбург, ул Малышева, д 51');
  assert.equal(order.pickupAddress, 'Свердловская область, Екатеринбург, ул. Белинского, 54');
  const junk = fresh.createOrder({ items: [], total: 1000, contact: 'tg', pickupCode: '<script>alert(1)</script>' });
  assert.equal(junk.pickupCode, '');
  // Прежние заявки читаются как были: полей нет — значит пункт не выбирали.
  const old = fresh.createOrder({ items: [], total: 1000, contact: 'tg', address: 'г Москва, ул Тверская, д 1' });
  assert.equal(old.pickupCode, '');
  assert.equal(old.pickupAddress, '');

  // В панели видно и куда едет посылка, и адрес самого покупателя — но только
  // когда они разные: у курьерского заказа это была бы одна строка дважды.
  const line = render.orderDelivery(order);
  assert.match(line, /YEKB121/);
  assert.match(line, /ул\. Белинского, 54/);
  assert.match(line, /Покупатель: г Екатеринбург, ул Малышева, д 51/);
  const courier = render.orderDelivery(old);
  assert.doesNotMatch(courier, /o-pvz/);
  assert.match(courier, /ул Тверская, д 1/);
  assert.doesNotMatch(courier, /Покупатель:/, 'у курьерского заказа адрес один');

  fs.rmSync(dir, { recursive: true, force: true });
});

test('список пунктов витрина берёт у сервера и ничего про них не решает', () => {
  const js = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'styles.css'), 'utf8');
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

  // Ни расстояний, ни сортировки, ни своей базы у витрины нет — только показ.
  assert.doesNotMatch(js, /6371|Math\.atan2/, 'расстояние считает сервер, а не витрина');
  assert.match(js, /fetch\('\/api\/delivery\/points'/);
  // Список нужен только выбравшему пункт выдачи и только по разобранному адресу.
  assert.match(js, /deliveryModeChoice\(\) === 'pvz' && ship\.valid/);

  // АДРЕС ПОКУПАТЕЛЯ ВЫБОР ПУНКТА НЕ ТРОГАЕТ. Это его данные, и лежат они в
  // блоке «Получатель», а не в доставке. Раньше поле было одно на двоих, и
  // адрес пункта затирал адрес покупателя.
  const form = js.slice(js.indexOf('>2</span>Получатель'), js.indexOf('co-submit'));
  assert.ok(form.indexOf('co-address') < form.indexOf('>3</span>Доставка'), 'адрес обязан стоять у получателя');
  assert.doesNotMatch(js, /field\.value = picked\.address|input\.value = picked\.address/,
    'выбор пункта не пишет в поле адреса покупателя');
  assert.doesNotMatch(js, /restoreTypedAddress/, 'возвращать адрес больше не нужно — он и не менялся');

  // Выбранный пункт снимается со сменой адреса или перевозчика: пункт в прежнем
  // городе или чужой сети — не выбор покупателя.
  assert.match(js, /input\.addEventListener\('input', function \(\) \{ dropPickup\(\); setGeo\(null, null\); quoteDelivery\(\); \}\)/);
  assert.match(js, /box\.addEventListener\('change', function \(\) \{ dropPickup\(\); syncDelivery\(\); rememberCheckout\(\); \}\)/);

  // «Рядом ничего нет» и «списка этого перевозчика у нас нет» — разные ответы.
  assert.match(server, /ready: PICKUP\.has\(method\)/);
  assert.match(js, /pickup\.ready = !!d\.ready/);

  /* В блоке ТОЛЬКО выбор пункта. Ни поиска, ни ручного ввода адреса, ни сносок
   * под списком: шаг «Доставка» — последний перед оплатой, и лишние строки на
   * нём читаются как работа, которую ещё надо сделать. Авторство OpenStreetMap
   * при этом никуда не делось — оно в подвале, где ему и место. */
  assert.doesNotMatch(js, /co-pickup-address|co-point-other|co-point-q/, 'в блоке остаётся только выбор пункта');
  assert.doesNotMatch(js, /Нужного пункта нет в списке|Поиск по улице/);
  assert.doesNotMatch(js, /openstreetmap\.org/i, 'сносок про источник данных на оформлении нет');
  // Выбирать нечего — говорим это, а не делаем вид, что выбор есть.
  assert.match(js, /Рядом с вашим адресом пунктов не нашлось/);

  // Пункт выдачи обязателен, когда выбран «в пункт выдачи»: заказ без адреса
  // назначения оформить нельзя.
  assert.match(js, /deliveryModeChoice\(\) === 'pvz' && !pickup\.code/);

  // В заказ уезжает только код: адрес пункта витрина не присылает вовсе —
  // выбрать можно лишь то, что сервер сам и показал.
  assert.match(js, /pickupCode: pickup\.code/);
  assert.doesNotMatch(js, /pickupAddress:/);

  // Строки с волосяной линией, а не пять карточек с рамками: карточка выделяет
  // выбор из двух-трёх равных, а здесь перечень адресов.
  assert.match(css, /\.co-point\+\.co-point\{border-top:1px solid var\(--border\)\}/);
  assert.match(css, /\.co-point-km\{[^}]*tabular-nums/);

  /* Выпадающий список: пока пункт не выбран — раскрыт (выбирать всё равно
   * придётся), после выбора схлопывается в строку с выбранным пунктом, нажатие
   * на неё открывает снова. */
  assert.match(js, /var open = picked \? pickup\.open : true/);
  assert.match(js, /pickup\.open = !pickup\.open; renderPoints\(\)/);
  assert.match(js, /pickup\.open = false;\s*\n\s*renderPoints\(\)/);
  assert.match(js, /aria-expanded="' \+ \(open \? 'true' : 'false'\)/);
  assert.match(js, /role="listbox"/);
  assert.match(js, /role="option"/);
  // Кнопка оформления не просто ругается, а раскрывает список: сказать
  // «выберите пункт» и оставить его закрытым было бы издевательством.
  assert.match(js, /openPoints\(\);/);
  // Снятый выбор снова раскрывает список: свёрнутый пустой выглядел бы как
  // уже сделанный выбор.
  assert.match(js, /pickup\.code = '';\s*\n(?:\s*\/\/[^\n]*\n)*\s*pickup\.open = true/);
  // Раскрытие высотой, а не display: список выезжает из строки выше.
  assert.match(css, /\.co-pvz-drop\{max-height:0/);
  assert.match(css, /\.co-pvz\.is-open \.co-pvz-drop\{max-height:/);
  // Высоту раскрытого списка меряет скрипт: числом её не задать — на узком
  // экране адрес переносится, и последний пункт оказывался за границей.
  assert.match(js, /drop\.style\.maxHeight = open \? drop\.scrollHeight \+ 'px' : ''/);
  assert.match(css, /\.co-pvz\.is-open \.co-pvz-chev\{transform:rotate\(180deg\)\}/);
  // Галочка занимает место всегда — иначе строка дёргалась бы при выборе.
  assert.match(css, /\.co-point-check\{[^}]*opacity:0/);

  // Значки: витрина и постамат различаются рисунком, вес штриха тот же, что у
  // остальных глифов витрины.
  assert.match(js, /PVZ_ICONS = \{/);
  for (const name of ['pvz', 'postamat', 'pin', 'chevron', 'check']) {
    assert.match(js, new RegExp(name + ':\\s*\'<path'), 'нет значка ' + name);
  }
  assert.match(js, /stroke-width="1\.6"/);
});

test('сохранённый ПВЗ подтверждается сервером, а старый ответ не стирает новый список', async () => {
  const js = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  const from = js.indexOf('var pickup = {');
  const to = js.indexOf('function pointDistance', from);
  assert.ok(from > -1 && to > from, 'блок загрузки пунктов найден');
  const factory = new Function(
    'document', 'deliveryChoice', 'deliveryModeChoice', 'ship', 'addressValue',
    'fetch', 'renderPoints', 'rememberCheckout',
    js.slice(from, to) + '\nreturn { pickup: pickup, loadPoints: loadPoints };'
  );
  function harness() {
    let address = 'A';
    let renders = 0; let remembers = 0;
    const requests = [];
    const api = factory(
      { getElementById: id => id === 'co-points' ? { hidden: false } : null },
      () => 'cdek', () => 'pvz', { valid: true }, () => address,
      () => new Promise((resolve, reject) => { requests.push({ resolve, reject }); }),
      () => { renders++; }, () => { remembers++; }
    );
    return {
      api, requests,
      setAddress(value) { address = value; },
      renders: () => renders, remembers: () => remembers
    };
  }
  const answer = data => ({ json: () => Promise.resolve(data) });
  const flush = () => new Promise(resolve => setImmediate(resolve));

  const stale = harness();
  stale.api.pickup.restoredCode = 'CLOSED_42';
  stale.api.loadPoints();
  stale.requests[0].resolve(answer({ ok: true, ready: true, items: [] }));
  await flush();
  assert.equal(stale.api.pickup.code, '', 'удалённый пункт не считается выбранным');
  assert.equal(stale.api.pickup.restoredCode, '', 'протухшее предпочтение очищено после точного ответа');
  assert.equal(stale.remembers(), 1, 'очистка попала в checkout_v1');

  const valid = harness();
  valid.api.pickup.restoredCode = 'PVZ_42';
  valid.api.loadPoints();
  valid.requests[0].resolve(answer({ ok: true, ready: true, items: [{ code: 'PVZ_42' }] }));
  await flush();
  assert.equal(valid.api.pickup.code, 'PVZ_42', 'актуальный пункт восстановлен после подтверждения');
  assert.equal(valid.api.pickup.restoredCode, '');
  assert.equal(valid.api.pickup.open, false);

  const raced = harness();
  raced.api.loadPoints();                                      // A₁ ещё в сети
  raced.setAddress('B');
  raced.api.loadPoints();                                      // B ещё в сети
  raced.setAddress('A');
  raced.api.loadPoints();                                      // актуальный A₂
  raced.requests[2].resolve(answer({ ok: true, ready: true, items: [{ code: 'A2' }] }));
  await flush();
  raced.requests[0].reject(new Error('late A1 failure'));
  raced.requests[1].resolve(answer({ ok: true, ready: true, items: [{ code: 'B1' }] }));
  await flush();
  assert.match(raced.api.pickup.key, /\|A\|/);
  assert.deepEqual(raced.api.pickup.items, [{ code: 'A2' }],
    'поздние A₁ и B не стирают успешный список A₂ при возврате к тому же ключу');
  assert.equal(raced.api.pickup.pending, false);
});

test('координаты для поиска пунктов приходят от подсказки адреса, а не от геокодера', () => {
  const { suggestAddress } = require('../lib/dadata');
  const dadata = fs.readFileSync(path.join(__dirname, '..', 'lib', 'dadata.js'), 'utf8');
  // Точный ответ (дом, ближайший дом, улица) отдаёт координаты; «город целиком»
  // — нет: «пункт в 400 м» от центра города означал бы не то, что прочитают.
  assert.match(dadata, /GEO_EXACT = new Set\(\['0', '1', '2'\]\)/);
  assert.match(dadata, /GEO_EXACT\.has\(String\(d\.qc_geo\)\)/);
  // Своего геокодера в проекте нет и заводить его не нужно.
  const files = fs.readdirSync(path.join(__dirname, '..', 'lib')).map(f => fs.readFileSync(path.join(__dirname, '..', 'lib', f), 'utf8')).join('\n');
  // Геокодера нет ни своего, ни чужого: координаты приходят вместе с подсказкой
  // адреса. OpenStreetMap в проекте есть, но не как геокодер — оттуда берутся
  // сами пункты выдачи OZON (lib/pickup-osm.js).
  assert.doesNotMatch(files, /nominatim|geocod/i, 'внешний геокодер не нужен: координаты уже приходят с подсказкой');
  assert.equal(typeof suggestAddress, 'function');
});

test('точки OZON берутся из OSM только с точным адресом и своим регионом', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pickup-osm-'));
  seedPickup(dir, PICKUP_SAMPLE);
  const keys = [require.resolve('../lib/db'), require.resolve('../lib/pickup'), require.resolve('../lib/pickup-osm')];
  const previous = process.env.STORE_DATA_DIR;
  process.env.STORE_DATA_DIR = dir;
  for (const k of keys) delete require.cache[k];
  const OSM = require('../lib/pickup-osm');
  const PICKUP = require('../lib/pickup');
  const ADDRESS = require('../lib/address');
  for (const k of keys) delete require.cache[k];
  if (previous === undefined) delete process.env.STORE_DATA_DIR; else process.env.STORE_DATA_DIR = previous;

  // Здание с адресом вокруг точки — квадрат рядом с пунктом СДЭК в образце.
  const box = [
    { lat: 56.8355, lon: 60.6145 }, { lat: 56.8355, lon: 60.6165 },
    { lat: 56.8370, lon: 60.6165 }, { lat: 56.8370, lon: 60.6145 }, { lat: 56.8355, lon: 60.6145 }
  ];
  const elements = [
    // Внутри здания — адрес берётся у здания.
    { type: 'node', id: 1, lat: 56.8362, lon: 60.6155, tags: { shop: 'outpost', brand: 'Ozon', opening_hours: 'Mo-Su 09:00-21:00' } },
    // Вне любого здания с адресом — не показываем вовсе: гадать нельзя.
    { type: 'node', id: 2, lat: 56.8300, lon: 60.6300, tags: { shop: 'outpost', brand: 'Ozon' } },
    // Постамат внутри того же здания.
    { type: 'node', id: 3, lat: 56.8360, lon: 60.6150, tags: { amenity: 'parcel_locker', brand: 'Ozon Box' } },
    // Чужой бренд в том же здании — не наш перевозчик.
    { type: 'node', id: 4, lat: 56.8361, lon: 60.6152, tags: { shop: 'outpost', brand: 'Wildberries' } },
    { type: 'way', id: 90, geometry: box, tags: { 'addr:street': 'улица Малышева', 'addr:housenumber': '53' } }
  ];
  const { points, stats } = OSM.pointsFrom(elements);
  assert.equal(stats.found, 3, 'считаем только точки OZON');
  assert.equal(stats.noAddress, 1, 'точка вне здания остаётся без адреса');
  assert.deepEqual(points.map(p => p.code), ['osmn1', 'osmn3']);
  assert.equal(points[1].type, 'postamat');
  // Регион в OSM не размечают, а без него адрес не пройдёт проверку полноты в
  // маленьком городе. Берём его у ближайшего пункта СДЭК — данные уже свои.
  assert.equal(points[0].region, 'Свердловская область');
  assert.equal(PICKUP.addressOf(points[0]), 'Свердловская область, Екатеринбург, улица Малышева, 53');
  assert.equal(ADDRESS.checkAddress(PICKUP.addressOf(points[0])).ok, true);
  // Часы у OSM по-английски — дни недели переводим, время и так цифрами.
  assert.equal(points[0].hours, 'Пн-Вс 09:00-21:00');
  assert.equal(OSM.hoursRu('Mo-Fr 10:00-20:00; Sa 11:00-18:00'), 'Пн-Пт 10:00-20:00, Сб 11:00-18:00');
  // Точка помечена источником — по нему видно, откуда взялся адрес.
  assert.equal(points[0].source, 'osm');
  // Кода перевозчика у неё нет — в заказ уедет только адрес.
  assert.equal(points[0].official, undefined);

  // Наружу уходит ЦЕНТР ПЛИТКИ, а не адрес покупателя: 0,1° — это ~11 км, по
  // такому центру ни улицы, ни дома не восстановить.
  assert.deepEqual(OSM.tileFor(56.836094, 60.614637).key, '56.8,60.6');
  assert.deepEqual(OSM.tileFor(56.8, 60.6).key, OSM.tileFor(56.83, 60.64).key);
  assert.ok(OSM.TILE >= 0.05, 'плитка не должна быть точнее нескольких километров');

  fs.rmSync(dir, { recursive: true, force: true });
});

test('обновление точек OZON не задерживает оформление заказа', () => {
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const js = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  const osm = fs.readFileSync(path.join(__dirname, '..', 'lib', 'pickup-osm.js'), 'utf8');
  const route = server.slice(server.indexOf("app.post('/api/delivery/points'"), server.indexOf("app.post('/api/order'"));

  // Маршрут НЕ ждёт Overpass: отдаёт что есть и помечает ответ.
  assert.doesNotMatch(route, /await/, 'ответ не должен ждать чужой сервис');
  assert.match(route, /OSM\.ensureTile\(/);
  assert.match(route, /refreshing/);
  // Витрина переспрашивает один раз, а не опрашивает по кругу.
  assert.match(js, /d\.refreshing && pickup\.retriedKey !== key/);

  // Авторство OpenStreetMap — требование лицензии, и оно в подвале сайта:
  // на оформлении сноскам не место, а подвал закрывает требование так же.
  assert.doesNotMatch(js, /openstreetmap\.org/i);

  // Код в заказ пишем только от самого перевозчика: у точки OSM это
  // идентификатор объекта карты, накладной он не поможет.
  assert.match(server, /pickupCode: point && point\.official \? point\.code : ''/);

  // Публичный Overpass — общий бесплатный ресурс: один запрос за раз и пауза.
  assert.match(osm, /if \(inFlight\) return true/);
  assert.match(osm, /Date\.now\(\) - lastRun < COOLDOWN/);
  // Запрос обязан представляться: без User-Agent Apache перед Overpass отвечает
  // 406, а Node его сам не ставит. Уже ловили на боевом сервере.
  assert.match(osm, /'User-Agent': USER_AGENT/);
  assert.doesNotMatch(osm, /USER_AGENT = '[^']*(adcapple|\.com|\.ru)/i, 'домен магазина наружу не называем');
  // Без базы СДЭК региона взять неоткуда — тогда и ходить незачем.
  assert.match(osm, /if \(!PICKUP\.has\('cdek'\)\) return false/);
});

test('разбор официального списка СДЭК отсеивает всё, что нельзя показать', () => {
  const SYNC = require('../scripts/sync-pickup-points.js');
  const xml = '<?xml version="1.0"?><PvzList>'
    + '<Pvz Code="YEKB121" Status="ACTIVE" countryCodeIso="RU" RegionName="Свердловская область" City="Екатеринбург"'
    + ' Address="ул. Белинского, 54" WorkTime="Пн-Пт 10:00-21:00" coordX="60.6205" coordY="56.8309" Type="PVZ" IsHandout="true"/>'
    + '<Pvz Code="MSK9" Status="ACTIVE" countryCodeIso="RU" RegionName="Москва" City="Москва"'
    + ' Address="б-р. Чистопрудный, 13с1" coordX="37.64" coordY="55.76" Type="POSTAMAT" IsHandout="true"/>'
    // Зарубежные пункты приходят даже на запрос по России — магазин туда не возит.
    + '<Pvz Code="BAKU1" Status="ACTIVE" countryCodeIso="AZ" RegionName="Баку" City="Баку"'
    + ' Address="ул. Мамедова, 1" coordX="49.8" coordY="40.4" Type="PVZ" IsHandout="true"/>'
    // Только приём отправлений: везти туда покупателя нельзя.
    + '<Pvz Code="X1" Status="ACTIVE" countryCodeIso="RU" RegionName="Тверская область" City="Тверь"'
    + ' Address="ул. Мира, 3" coordX="35.9" coordY="56.8" Type="PVZ" IsHandout="false"/>'
    // Адрес без номера дома — покупатель выбрал бы, а оформление отказало.
    + '<Pvz Code="X2" Status="ACTIVE" countryCodeIso="RU" RegionName="Тверская область" City="Тверь"'
    + ' Address="ул. Нусрета Мамедова, -" coordX="35.9" coordY="56.8" Type="PVZ" IsHandout="true"/>'
    + '<Pvz Code="X3" Status="CLOSED" countryCodeIso="RU" RegionName="Тверская область" City="Тверь"'
    + ' Address="ул. Мира, 5" coordX="35.9" coordY="56.8" Type="PVZ" IsHandout="true"/>'
    + '<Pvz Code="YEKB121" Status="ACTIVE" countryCodeIso="RU" RegionName="Свердловская область" City="Екатеринбург"'
    + ' Address="ул. Белинского, 54" coordX="60.6205" coordY="56.8309" Type="PVZ" IsHandout="true"/>'
    + '</PvzList>';
  const { points, skipped } = SYNC.parseCdek(xml);
  assert.deepEqual(points.map(p => p.code), ['YEKB121', 'MSK9']);
  assert.equal(skipped.abroad, 1);
  assert.equal(skipped.noHandout, 1);
  assert.equal(skipped.badAddress, 1);
  assert.equal(skipped.inactive, 1);
  assert.equal(skipped.dupes, 1);
  // coordX — долгота, coordY — широта. Перепутать их значит отправить всех
  // покупателей в другое полушарие.
  assert.equal(points[0].lat, 56.8309);
  assert.equal(points[0].lon, 60.6205);
  assert.equal(points[1].type, 'postamat');
  // Слитное строение — обычная московская запись, и раньше она отвергалась.
  const ADDRESS = require('../lib/address');
  assert.equal(ADDRESS.checkAddress('Москва, б-р. Чистопрудный, 13с1').ok, true);
  assert.equal(ADDRESS.checkAddress('Москва, ул. Автозаводская, 23Ак2').ok, true);
  // А порядковое название улицы номером дома по-прежнему не считается.
  assert.equal(ADDRESS.checkAddress('Москва, 1-я Тверская-Ямская улица').ok, false);
  // Обрезанный ответ чужого сервиса не должен стирать рабочую базу.
  assert.ok(SYNC.MIN_POINTS >= 1000);
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
  const db = { getOrders: () => list, visibleOrders: () => list, getProducts: () => [], visibleProducts: () => [], pendingReviewCount: () => 0 };
  for (const html of [adminViews.ordersList(SETTINGS, db, null, 1)]) {
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
  assert.match(html, /id="pay-timer" role="timer" aria-live="off"/);
  assert.ok(html.indexOf('class="pay-req"') < html.indexOf('id="pay-timer"')
    && html.indexOf('id="pay-timer"') < html.indexOf('class="pay-hint"'),
  'заметный таймер стоит сразу под реквизитами, до длинной инструкции');
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
  assert.doesNotMatch(stale, /id="pay-timer"/);
  assert.match(stale, /name="pay-method"/, 'вместо мёртвых реквизитов — выбор способа заново');

  // Даже старый URL с ?choose=1 не показывает выбор поверх действующего счёта:
  // у кассы нет отмены invoice, и второй оставил бы два оплачиваемых реквизита.
  const choose = render.payPage(ss, Object.assign({}, order, { payment: live }), { methods, origin: '', choose: true });
  assert.doesNotMatch(choose, /name="pay-method"/);
  assert.match(choose, /4276 1234 5678 9012/);
  assert.doesNotMatch(choose, /id="pay-switch"|Выбрать другой способ/);

  // Данные прежней версии могли содержать живой A под более новой failed B.
  // Показываем и адресно опрашиваем A, а не предлагаем выпустить третий счёт.
  const oldLive = Object.assign({ id: 'a'.repeat(24), startedAt: Date.now() - 2000 }, live);
  const legacyHistory = {
    status: 'failed', attemptId: 'b'.repeat(24), method: 'SBP', attempts: [
      oldLive,
      { id: 'b'.repeat(24), status: 'failed', method: 'SBP', startedAt: Date.now() - 1000, lastErrorCode: 'no_requisite' }
    ]
  };
  const recovered = render.payPage(ss, Object.assign({}, order, { payment: legacyHistory }), { methods, origin: '' });
  assert.match(recovered, /4276 1234 5678 9012/);
  assert.match(recovered, new RegExp('data-attempt="' + 'a'.repeat(24) + '"'));
  assert.doesNotMatch(recovered, /name="pay-method"/);

  // Оплата ещё не начиналась — только выбор способа.
  const fresh = render.payPage(ss, order, { methods, origin: '' });
  assert.match(fresh, /name="pay-method"/);
  assert.match(fresh, /id="pay-create"/);
  assert.doesNotMatch(fresh, /Номер карты на сайте вводить не нужно/);
  // Вернуться к оформлению можно только из чистого черновика до первого
  // запроса кассы. Обе POST-кнопки оставляют корзину/checkout_v1 в браузере.
  const draft = Object.assign({}, order, { status: 'new', draft: true, payment: null });
  const editable = render.payPage(ss, draft, { methods, origin: '', canDiscardDraft: true });
  assert.match(editable, /method="post" action="\/pay\/ord1\/draft"/);
  assert.match(editable, /name="intent" value="edit">Вернуться и изменить заказ/);
  assert.match(editable, /name="intent" value="cancel">Отменить заказ/);
  assert.doesNotMatch(editable, /Корзина и заполненные данные останутся/);
  const forgedFlag = render.payPage(ss, Object.assign({}, draft, { draft: false, payment: live }),
    { methods, origin: '', canDiscardDraft: true });
  assert.doesNotMatch(forgedFlag, /pay-draft-actions|Отменить заказ/,
    'ошибочный флаг не рисует отмену поверх платёжной попытки');
  // Способов нет вовсе — не оставляем покупателя перед пустым блоком.
  const none = render.payPage(ss, order, { methods: [], origin: '' });
  assert.doesNotMatch(none, /id="pay-create"/);
  assert.match(none, /менеджер свяжется/);

  const archivedPage = render.payPage(ss, Object.assign({}, order, {
    archive: { active: true, at: Date.now() }
  }), { methods, origin: '', orderArchived: true });
  assert.match(archivedPage, /Заказ закрыт/);
  assert.doesNotMatch(archivedPage, /id="pay-create"|name="pay-method"/);

  const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'styles.css'), 'utf8');
  const payJs = fs.readFileSync(path.join(__dirname, '..', 'public', 'pay.js'), 'utf8');
  assert.match(css, /\.pay-timer\{[^}]*border:2px[^}]*background:#fff7e9/,
    'таймер — отдельная контрастная карточка, а не бледная строка');
  assert.match(css, /\.pay-timer b\{[^}]*min-width:5ch[^}]*font-size:23px/);
  assert.match(css, /\.pay-timer\.is-urgent/);
  assert.match(payJs, /classList\.toggle\('is-urgent', ms <= 2 \* 60 \* 1000\)/,
    'последние две минуты выделяются сильнее');
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
  /* «Ждём оплату» — только у ДЕЙСТВУЮЩЕГО счёта: реквизиты выданы и срок идёт.
   * Статус 'pending' в данных значит всего лишь «оплату начали» — он пишется до
   * обращения к кассе, а дальше двигает его только опрос со страницы оплаты,
   * которого ушедший покупатель не делает. */
  const liveInvoice = { status: 'pending', method: 'SBP', invoiceId: 'inv', requisite: '79104693811', expiresAt: Date.now() + 9 * 60000 };
  const waiting = render.orderStatus({ payment: liveInvoice });
  assert.match(waiting, /pay-wait/);
  // Сколько осталось видно прямо в строке, а дальше тикает public/admin-ui.js.
  assert.match(waiting, /data-pay-until="\d+"/);
  assert.match(waiting, /осталось <b>[89]:\d\d<\/b>/);
  assert.match(waiting, /data-over="счёт истёк"/, 'подпись на ноль отсчёта берётся из разметки, а не из скрипта');

  // Реквизитов не выдали (касса отказала) — покупатель не платил вовсе, и это
  // не «ждём оплату», а незавершённая оплата: заявку надо довести руками.
  const idle = render.orderStatus({ payment: { status: 'pending', method: 'SBP', startedAt: Date.now() } });
  assert.match(idle, /pay-idle/);
  assert.match(idle, /не завершена/);
  assert.doesNotMatch(idle, /data-pay-until/, 'отсчитывать нечего: счёта нет');
  assert.equal(render.orderTone({ payment: { status: 'pending' } }), 'idle');

  // Срок вышел, а вебхука об успехе не пришло — счёт истёк, даже если в данных
  // так и осталось 'pending'. Раньше такая заявка висела «ждём оплату» вечно.
  const stale = render.orderStatus({ payment: Object.assign({}, liveInvoice, { expiresAt: Date.now() - 60000 }) });
  assert.match(stale, /pay-off/);
  assert.match(stale, /счёт истёк/);
  assert.match(stale, /срок вышел/);
  assert.doesNotMatch(stale, /data-pay-until/);

  // Оплаченный заказ говорит, КОГДА пришли деньги: «оплачено» без времени в
  // списке из полусотни строк ничего не подсказывает.
  assert.match(render.orderStatus({ payment: { status: 'paid', paidAt: Date.now() } }), /деньги пришли · \d\d\.\d\d в \d\d:\d\d/);

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
    getOrders: () => [paid, bad], visibleOrders: () => [paid, bad],
    getProducts: () => [], visibleProducts: () => [], pendingReviewCount: () => 0
  };
  // Черновик виден в списке своим состоянием и своей плиткой в сводке.
  const withDraft = adminViews.ordersList(SETTINGS, {
    getOrders: () => [paid, Object.assign({}, paid, { id: 'o9', number: 'ORD-9', payment: null, draft: true })],
    visibleOrders: () => [paid, Object.assign({}, paid, { id: 'o9', number: 'ORD-9', payment: null, draft: true })],
    getProducts: () => [], visibleProducts: () => [], pendingReviewCount: () => 0
  }, null, 1);
  assert.match(withDraft, /pay-draft/);
  assert.match(withDraft, /o-leg o-stat-draft"><i><\/i><span class="o-leg-k">Способ не выбран<\/span><b>1<\/b>/);

  for (const html of [adminViews.ordersList(SETTINGS, db, null, 1)]) {
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
  assert.match(css, /\.pay-tag\.pay-idle/, 'у незавершённой оплаты свой тон, а не чужой');
  // Отсчёт тикает скриптом панели, и подпись он берёт из разметки.
  const ui = fs.readFileSync(path.join(__dirname, '..', 'public', 'admin-ui.js'), 'utf8');
  assert.match(ui, /\.o-left\[data-pay-until\]/);
  assert.match(ui, /getAttribute\('data-over'\)/);
  assert.doesNotMatch(ui, /ждём оплату/, 'слова про состояние оплаты живут в lib/render.js');
});

// Заказы, на которых считается сводка. Все шесть состояний кассы плюс заявка,
// у которой оплаты не было вовсе, — как у всех прежних заказов.
//
// У «ждём оплату» обязан быть ДЕЙСТВУЮЩИЙ счёт: без реквизитов заказ попадает в
// «не завершены», и это разные плитки — покупатель либо переводит деньги прямо
// сейчас, либо не начинал вовсе.
function statsOrders() {
  const make = (id, total, status, extra) => ({
    id, number: String(480000 + Number(id.slice(1))), createdAt: 1000 - Number(id.slice(1)),
    customerName: 'Клиент ' + id, contact: '@u' + id, total, items: [{ name: 'Товар', price: total, qty: 1 }],
    payment: status ? Object.assign({ status, method: 'SBP' }, extra || {}) : null
  });
  const invoice = { invoiceId: 'inv', requisite: '79104693811', expiresAt: Date.now() + 600000 };
  return [
    make('o1', 100000, 'paid'), make('o2', 50000, 'paid'),
    make('o3', 30000, 'pending', invoice), make('o4', 20000, 'pending', invoice),
    make('o5', 70000, 'expired'), make('o6', 60000, 'cancelled'),
    make('o7', 40000, 'mismatch'), make('o8', 10000, 'failed'),
    make('o9', 90000, null),
    // Нажал «Оплатить», реквизитов не получил: касса отказала, покупатель ушёл.
    make('o10', 80000, 'pending', { startedAt: Date.now() })
  ];
}
function statsDb(orders) {
  return {
    getOrders: () => orders, visibleOrders: () => orders,
    getProducts: () => [{ id: 'p', name: 'Товар' }], visibleProducts: () => [{ id: 'p' }],
    pendingReviewCount: () => 0, categories: () => [], visibleCategories: () => [], ratingFor: () => ({ avg: 0, count: 0 })
  };
}

test('сводка по заказам считает выручку по оплаченным и складывает состояния по тонам', () => {
  const stats = render.orderStats(statsOrders());
  assert.equal(stats.count, 10);
  // Выручка — только оплаченные, и это рублёвый `total` вместе с доставкой:
  // `payment.amount` лежит в валюте счёта и в общую сумму не годится.
  assert.equal(stats.revenue, 150000);
  assert.equal(stats.paid, 2);
  // «Истёк» и «отменён» для менеджера одно и то же, «сумма не сошлась» и
  // «платёж не прошёл» — тоже: шесть состояний кассы складываются в тона.
  assert.equal(stats.tones.ok.n, 2);
  // «Ждут оплату» — только действующие счета, и сумма в плитке та же: это
  // деньги, которые прямо сейчас переводят.
  assert.equal(stats.tones.wait.n, 2);
  assert.equal(stats.tones.wait.sum, 50000);
  // Незавершённая оплата считается отдельно: покупатель до перевода не дошёл.
  assert.equal(stats.tones.idle.n, 1);
  assert.equal(stats.tones.idle.sum, 80000);
  assert.equal(stats.tones.off.n, 2);
  assert.equal(stats.tones.warn.n, 2);
  // Заказ без оплаты (и любой прежний) — свой тон, а не «ждём оплату».
  assert.equal(stats.tones.none.n, 1);
  assert.equal(render.orderTone({ payment: null }), 'none');
  assert.equal(render.orderTone({ payment: { status: 'выдумка' } }), 'none');
  assert.equal(render.orderTone({ payment: { status: 'paid' } }), 'ok');
  assert.equal(render.orderTone({ payment: { status: 'cancelled' } }), 'off');
  // Пустой список не падает и не выдумывает выручку.
  assert.equal(render.orderStats([]).revenue, 0);
  assert.equal(render.orderStats(undefined).count, 0);
  // Битая сумма не превращается в NaN на всю сводку.
  assert.equal(render.orderStats([{ total: 'абв', payment: { status: 'paid' } }]).revenue, 0);

  // Средний чек считается по ОПЛАЧЕННЫМ, а не по всем заявкам: брошенные
  // черновики и сгоревшие счета денег не принесли и среднее только занижают.
  assert.equal(stats.avg, 75000);
  assert.equal(render.orderStats([]).avg, 0, 'делить на ноль оплаченных нечего');
  // «Сегодня» — только заявки текущих суток. У тестовых заказов дата 1970 года,
  // поэтому сегодняшних среди них нет ни одной.
  assert.equal(stats.today.n, 0);
  const now = Date.now();
  const fresh = render.orderStats([
    { total: 5000, createdAt: now, payment: { status: 'paid' } },
    { total: 3000, createdAt: now, payment: null },
    { total: 9000, createdAt: 1000, payment: { status: 'paid' } }
  ]);
  assert.equal(fresh.today.n, 2);
  assert.equal(fresh.today.sum, 8000);
  assert.equal(fresh.today.revenue, 5000, 'сегодняшняя выручка — только оплаченное');

  // Состояния «Проверить» и «Без оплаты» при нуле не показываются: сводка
  // отвечает на вопрос «что сейчас с заказами», а не перечисляет пустые.
  const clean = render.orderStatsBar(render.orderStats([{ total: 1000, payment: { status: 'paid' } }]), SETTINGS);
  assert.doesNotMatch(clean, /Проверить|Без оплаты/);
  assert.match(clean, /Оплачено/);
  assert.match(clean, /Не оплачены/, 'состояние «счёт истёк» видно даже при нуле');
  // У пустого состояния подписи нет вовсе: «Ждут оплату 0 · на 0 ₽» — объяснение
  // того, чего не случилось. Само оно остаётся в списке, но приглушено.
  assert.match(clean, /o-stat-off is-zero"><i><\/i><span class="o-leg-k">Не оплачены<\/span><b>0<\/b><\/li>/);
  assert.doesNotMatch(render.orderStatsBar(render.orderStats([]), SETTINGS), /на 0\s?₽|деньги получены/);
});

test('счётчики и выручка одинаковы на «Обзоре» и в «Заказах», а строка красится по оплате', () => {
  const orders = statsOrders();
  const db = statsDb(orders);
  const dash = adminViews.dashboard(SETTINGS, db);
  const list = adminViews.ordersList(SETTINGS, db, null, 1);

  // Разметка сводки одна на обе страницы: разъехавшиеся счётчики читались бы
  // как разные числа об одном и том же.
  const bar = html => {
    const from = html.indexOf('<div class="o-stats">');
    return html.slice(from, html.indexOf('</section></div>', from) + 16);
  };
  assert.equal(bar(dash), bar(list));
  for (const html of [dash, list]) {
    assert.match(html, /Выручка<\/span>\s*<strong>150\s?000\s?₽/);
    // Доля оплаченных — и словами, и полосой: «2 из 10» читается за секунду,
    // полоса — с одного взгляда.
    assert.match(html, /<dd>2 из 10 заказов · 20%<\/dd>/);
    assert.match(html, /<i class="o-stat-ok" style="width:20%">/);
    // Средний чек считается по оплаченным: 150 000 на два заказа.
    assert.match(html, /<dt>Средний чек<\/dt><dd>75\s?000\s?₽<\/dd>/);
    assert.match(html, /o-leg o-stat-ok"><i><\/i><span class="o-leg-k">Оплачено<\/span><b>2<\/b>/);
    assert.match(html, /o-leg o-stat-off"><i><\/i><span class="o-leg-k">Не оплачены<\/span><b>2<\/b>/);
    // Сумма стоит у КАЖДОГО состояния: «не оплачены 2 · 130 000 ₽» — ровно те
    // деньги, которых магазин не получил, и знать их так же полезно, как выручку.
    assert.match(html, /Не оплачены<\/span><b>2<\/b><small><span>счёт истёк или отменён<\/span><em>130\s?000\s?₽<\/em>/);
    // Составная полоса: доли задаёт flex-grow, чтобы сумма сходилась без
    // округлений, дающих щель в конце.
    assert.match(html, /<div class="o-share"><i class="o-stat-ok" style="flex-grow:2"/);
  }

  // Счётчики считаются по ВСЕМУ списку, а не по показанной странице: «оплачено
  // 12» на седьмой странице означало бы двенадцать из пятидесяти.
  const many = Array.from({ length: render.ADMIN_PER_PAGE * 2 }, (_, i) => ({
    id: 'm' + i, number: String(600000 + i), total: 1000, items: [], createdAt: 9000 - i,
    payment: { status: 'paid' }
  }));
  assert.match(adminViews.ordersList(SETTINGS, statsDb(many), null, 2), /<dd>100 из 100 заказов · 100%<\/dd>/);

  // Строка заказа красится по состоянию оплаты: оплаченную от отменённой надо
  // отличать с одного взгляда, не вчитываясь в плашку.
  assert.equal(render.orderRowClass({ payment: { status: 'paid' } }), 'o-row o-row-ok');
  assert.equal(render.orderRowClass({ payment: { status: 'expired' } }), 'o-row o-row-off');
  assert.equal(render.orderRowClass({}), 'o-row', 'заявка без оплаты остаётся белой');
  assert.match(list, /<tr id="order-o1" class="o-row o-row-ok">/);
  assert.match(list, /<tr id="order-o6" class="o-row o-row-off">/);
  assert.match(list, /<tr id="order-o9" class="o-row">/);

  // На «Обзоре» у каждой заявки сразу видно состояние и сумму — за этим туда и
  // заходят. Строка ведёт к якорю этой же заявки в разделе заказов.
  // data-live-key — чтобы при живом обновлении свежая заявка вставлялась сверху,
  // а остальные строки оставались теми же узлами, а не переписывались заново.
  assert.match(dash, /<a class="o-recent-row o-row o-row-ok" data-live-key="recent-o1" href="\/admin\/orders#order-o1">/);
  assert.match(dash, /o-recent-state"><span class="pay-tag pay-ok"><i><\/i>оплачено<\/span>/);
  assert.match(dash, /o-recent-sum">100\s?000\s?₽/);
  assert.match(list, /<tr id="order-o1"/, 'якорь на месте, иначе ссылка с «Обзора» ведёт в пустоту');

  // Пустой магазин не показывает выдуманных чисел и не ломает раскладку.
  const empty = adminViews.dashboard(SETTINGS, statsDb([]));
  assert.match(empty, /Заказов пока нет/);
  assert.match(empty, /o-recent-empty/);
  assert.doesNotMatch(empty, /o-recent-row/);
});

test('состояние оплаты красит панель одним набором цветов, и на телефоне это карточки', () => {
  const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'styles.css'), 'utf8');
  // Цвет тона задан ОДИН раз: по нему красятся плашка, строка и точка сводки.
  // Разъезжаются такие вещи молча — увидеть это можно только глазами.
  for (const tone of ['ok', 'wait', 'warn', 'off']) {
    const rule = new RegExp(`\\.o-stat-${tone},\\.o-row-${tone},\\.pay-tag\\.pay-${tone}\\{--tone:`);
    assert.match(css, rule, 'тон ' + tone + ' раскрашен не одним правилом');
  }
  assert.match(css, /\.pay-tag\{[^}]*background:var\(--tone-soft\)/);
  assert.match(css, /\.a-orders tr\.o-row td\{background:var\(--tone-row,transparent\)\}/);
  assert.match(css, /\.a-orders tr\.o-row td:first-child\{box-shadow:inset 3px 0 0 var\(--tone,transparent\)\}/);
  // Подсветка якоря обязана перебивать тон: по ссылке с «Обзора» открывается
  // ровно эта заявка, и найти её в списке надо по подсветке. Специфичность у
  // общего правила та же, поэтому у заказов оно своё.
  assert.match(css, /\.a-orders tr\.o-row:target td\{background:#fff8df\}/);

  // Мобильная карточка: подложка и полоска переезжают на саму строку, иначе
  // полоска висела бы чёрточкой у номера заказа.
  const mobile = css.slice(css.indexOf('@media(max-width:800px){'));
  assert.match(mobile, /\.a-orders tr\{[^}]*background:var\(--tone-row,#fff\);box-shadow:inset 3px 0 0 var\(--tone,transparent\)/);
  assert.match(mobile, /\.a-orders tr\.o-row td:first-child\{box-shadow:none\}/);
  // Ряды карточки заданы явно: порядок ячеек в таблице задан столбцами, и
  // автоматической раскладке взяться за «состояние справа от номера» неоткуда.
  assert.match(mobile, /\.a-orders \.o-state\{grid-column:2;grid-row:1/);
  assert.match(mobile, /\.a-orders \.o-sum\{grid-column:2;grid-row:4/);
  // Сводка на телефоне — карточками друг под другом, список состояний в одну
  // колонку: в две подпись вроде «Способ не выбран» переносится посреди слова.
  assert.match(mobile, /\.o-stats\{grid-template-columns:minmax\(0,1fr\)/);
  assert.match(mobile, /\.o-legend\{grid-template-columns:minmax\(0,1fr\)/);
  // Ряд одинаковых плиток ушёл целиком: их число плавало от четырёх до семи,
  // и лишняя переносилась на вторую строку, оставляя рядом полосу пустоты.
  assert.doesNotMatch(css, /\.o-stat\{|\.o-stat-money/, 'прежние плитки сводки должны быть сняты');

  // На «Обзоре» таблицы больше нет вовсе — значит, и листать её вбок нечего.
  const db = statsDb(statsOrders());
  assert.doesNotMatch(adminViews.dashboard(SETTINGS, db), /<table/);
});

test('счёт создаётся в основных единицах и только для подтверждённого способа', async () => {
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
    const providerExpiry = new Date(Date.now() + 10 * 60 * 1000).toISOString();
    const providerInvoice = paymentOption => ({ message: 'Data successfully received', response: {
      transaction: {
        id: '911c2823-f55b-43b5-9881-d5653107f7dc', status: 'Pending',
        currency: 'RUB', amount: '67990.00000000', expiredAt: providerExpiry
      },
      paymentRequisites: {
        paymentOption, paymentMethod: 'Сбербанк',
        card: '4276 1234 5678 9012', cardOwner: 'IVAN PETROV'
      }
    } });

    // Ответ TO_CARD_TRANSGRAN на запрос TO_CARD раньше показывал покупателю
    // иностранную карту вопреки настройкам. Частичный счёт сохраняется для
    // аудита/сверки, но реквизиты такого маршрута принимать нельзя.
    stub(json(providerInvoice('TO_CARD_TRANSGRAN')));
    const mismatch = await croco.createInvoice(on, { amount: 67990, method: 'TO_CARD', callbackUrl: 'https://shop/cb?order=1&token=t' });
    assert.equal(mismatch.ok, false);
    assert.equal(mismatch.error, 'method_mismatch');
    assert.equal(mismatch.invoice.method, 'TO_CARD_TRANSGRAN');

    stub(json(providerInvoice('TO_CARD')));
    const ok = await croco.createInvoice(on, { amount: 67990, method: 'TO_CARD', callbackUrl: 'https://shop/cb?order=1&token=t' });
    assert.equal(ok.ok, true);
    assert.equal(ok.invoice.requisite, '4276 1234 5678 9012');
    assert.equal(ok.invoice.owner, 'IVAN PETROV');
    assert.equal(ok.invoice.state, 'pending');
    assert.equal(ok.invoice.expiresAt, Date.parse(providerExpiry));
    assert.equal(ok.invoice.method, 'TO_CARD');
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

    // Без подтверждённого будущего срока показывать реквизиты нельзя: после
    // фактического expiry они могут уже принадлежать другому получателю.
    const noExpiry = providerInvoice('TO_CARD');
    delete noExpiry.response.transaction.expiredAt;
    stub(json(noExpiry));
    assert.equal((await croco.createInvoice(on, { amount: 67990, method: 'TO_CARD' })).error, 'bad_expiry');
    const pastExpiry = providerInvoice('TO_CARD');
    pastExpiry.response.transaction.expiredAt = new Date(Date.now() - 1000).toISOString();
    stub(json(pastExpiry));
    assert.equal((await croco.createInvoice(on, { amount: 67990, method: 'TO_CARD' })).error, 'bad_expiry');

    // Реквизит приходит с внешней границы и для QR становится href. Неизвестную
    // схему нельзя принимать даже из поля с ожидаемым именем.
    const unsafe = providerInvoice('QR_NSPK');
    unsafe.response.paymentRequisites = { paymentOption: 'QR_NSPK', qr: 'javascript:alert(1)' };
    stub(json(unsafe));
    const unsafeQr = await croco.createInvoice(on, { amount: 67990, method: 'QR_NSPK' });
    assert.equal(unsafeQr.ok, false);
    assert.equal(croco.startErrorCode(unsafeQr.error), 'no_requisite');

    // Касса вернула другую сумму — реквизиты показывать нельзя: покупатель
    // переведёт не столько, и платёж не сойдётся.
    stub(json({ response: { transaction: {
      id: '911c2823-f55b-43b5-9881-d5653107f7dc', status: 'Pending', currency: 'RUB', amount: '6799000.00',
      expiredAt: providerExpiry
    }, paymentRequisites: { paymentOption: 'TO_CARD', card: '4276 1234 5678 9012' } } }));
    assert.equal((await croco.createInvoice(on, { amount: 67990, method: 'TO_CARD' })).error, 'amount_mismatch');

    // Счёт без реквизитов бесполезен: показывать покупателю нечего.
    stub(json({ response: { transaction: { id: '911c2823-f55b-43b5-9881-d5653107f7dc', status: 'Pending' }, paymentRequisites: { paymentMethod: 'Сбербанк' } } }));
    assert.equal((await croco.createInvoice(on, { amount: 1, method: 'SBP' })).error, 'no_requisite');

    // На крупных чеках касса реально отвечает HTTP 200, но сообщает отказ в
    // message без response. Это именно явный no_requisite: его можно один раз
    // безопасно повторить, в отличие от timeout/500.
    stub(json({ message: 'Requisites not found' }));
    const noPool = await croco.createInvoice(on, { amount: 70700, method: 'TO_CARD' });
    assert.equal(croco.startErrorCode(noPool.error), 'no_requisite');
    assert.equal(croco.retryableStart(noPool), true);
    assert.equal(croco.retryableStart({ ok: false, error: 'timeout' }), false);
    assert.equal(croco.retryableStart({
      ok: false, error: 'Requisites not found', invoice: { id: '911c2823-f55b-43b5-9881-d5653107f7dc' }
    }), false, 'частичный invoice вторым POST не дублируем');

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
      currency: 'RUB', amount: '1.00', payment_option: 'SBP',
      account: '+7 900 123-45-67', bank: 'Т-Банк', receiver: 'IVAN PETROV', expire_at: providerExpiry
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

/* ------------------- Вторая касса: MeridianPay и переключение -------------------
 *
 * Главное требование ко всему блоку: покупатель не должен догадаться, что касс
 * несколько. Он выбирает способ, нажимает один раз и получает реквизиты — от
 * той платёжки, которая их дала. Всё остальное здесь про то, чтобы это было
 * ещё и безопасно.
 */

test('MeridianPay: сумма уходит в рублях, а приходит в копейках', async () => {
  const mp = require('../lib/meridianpay');
  const on = {
    meridianpayEnabled: true, meridianpayApiKey: 'k',
    meridianpayMerchantId: '3f2a1c88-5d94-4e07-9b31-6a0c2e7d5b40'
  };
  const real = global.fetch;
  let sent = null;
  const now = Math.floor(Date.now() / 1000);
  const deal = amount => ({ ok: true, status: 200, json: async () => ({ success: true, data: {
    order_id: '566c2485-7909-41d4-9fed-98d92e3f9b5f', external_id: 'aabbccddeeff001122334455',
    status: 'pending', currency: 'rub', amount,
    payment_gateway: 'Сбербанк', payment_gateway_code: 'sberbank_rub',
    payment_detail: { detail: '4000100020003000', initials: 'IVAN P', detail_type: 'card', region: 'Россия' },
    expires_at: now + 600, created_at: now, current_server_time: now,
    integrity: 'a'.repeat(64)
  } }) });
  const call = () => mp.createInvoice(on, {
    amount: 67990, currency: 'RUB', method: 'TO_CARD',
    externalId: 'aabbccddeeff001122334455', callbackUrl: 'https://shop/cb?order=1&token=t'
  });
  try {
    global.fetch = async () => { throw new Error('в сеть ходить нельзя'); };
    // Без ключа и без merchant_id не ходим вовсе: UUID мерчанта обязателен.
    assert.equal((await mp.createInvoice({}, { amount: 1000, method: 'TO_CARD', externalId: 'aabbccddeeff' })).error, 'not_configured');
    assert.equal(mp.configured({ meridianpayApiKey: 'k', meridianpayMerchantId: 'не-uuid' }), false);

    global.fetch = async (url, opts) => { sent = { url, opts }; return deal(6799000); };
    const ok = await call();
    assert.equal(ok.ok, true);
    // В ЗАПРОСЕ сумма — целые рубли: «100 = 100 rub» по документации кассы.
    const body = JSON.parse(sent.opts.body);
    assert.equal(body.amount, 67990);
    assert.equal(body.currency, 'rub');
    assert.equal(body.merchant_id, '3f2a1c88-5d94-4e07-9b31-6a0c2e7d5b40');
    // Базовый путь проверен на живом API: второго `/api` в нём нет, хотя
    // документация показывает `GET /api/api/currencies` (он отвечает 404).
    assert.equal(sent.url, 'https://meridianpay.top/api/h2h/order');
    assert.match(sent.opts.headers['Access-Token'], /^k$/);
    // А в ОТВЕТЕ она в копейках — то же поле, другие единицы.
    assert.equal(ok.invoice.amount, 67990);
    assert.equal(ok.invoice.requisite, '4000100020003000');
    assert.equal(ok.invoice.bank, 'Сбербанк');

    // Если бы касса вернула сумму рублями, мы получили бы 679.90 — и отказали.
    // Fail closed: принять «и рубли, и копейки» значит однажды отгрузить товар
    // за сотую часть цены. Отказ здесь стоит перехода на вторую кассу.
    global.fetch = async () => deal(67990);
    const wrong = await call();
    assert.equal(wrong.ok, false);
    assert.equal(wrong.error, 'amount_mismatch');

    // Целое число — тоже требование кассы. Дробная сумма (пересчёт в валюту по
    // курсу владельца) ей не годится, и это не повод молча округлить.
    assert.equal((await mp.createInvoice(on, { amount: 100.5, method: 'TO_CARD', externalId: 'aabbccddeeff' })).error, 'bad_amount');
  } finally {
    if (real) global.fetch = real; else delete global.fetch;
  }
});

test('MeridianPay: способ переводится в параметры кассы, а трансграничность задаётся явно', async () => {
  const mp = require('../lib/meridianpay');
  const on = {
    meridianpayEnabled: true, meridianpayApiKey: 'k',
    meridianpayMerchantId: '3f2a1c88-5d94-4e07-9b31-6a0c2e7d5b40'
  };
  const real = global.fetch;
  const now = Math.floor(Date.now() / 1000);
  const reply = detail => ({ ok: true, status: 200, json: async () => ({ success: true, data: {
    order_id: '566c2485-7909-41d4-9fed-98d92e3f9b5f', status: 'pending', currency: 'rub', amount: 100000,
    payment_gateway: 'Сбербанк', payment_detail: detail,
    expires_at: now + 600, current_server_time: now
  } }) });
  const send = async method => {
    let body = null;
    global.fetch = async (url, opts) => { body = JSON.parse(opts.body); return reply({ detail: '4000100020003000', detail_type: 'card', region: 'Россия' }); };
    const r = await mp.createInvoice(on, { amount: 1000, currency: 'RUB', method, externalId: 'aabbccddeeff112233', callbackUrl: 'https://shop/cb' });
    return { body, r };
  };
  try {
    // Российский способ — `is_transgran: false` ЯВНО. Не передать поле значит
    // «любые реквизиты», а это ровно та подмена маршрута, из-за которой у
    // CrocoPAY появилась проверка route_mismatch.
    const card = await send('TO_CARD');
    assert.equal(card.body.payment_detail_type, 'card');
    assert.equal(card.body.is_transgran, false);
    // Подбор суммы кассой запрещён всегда: иначе покупателя попросят перевести
    // не ту сумму, которую он видел в заказе, и сверка перестанет сходиться.
    assert.equal(card.body.is_floating_amount, false);

    const sbp = await send('SBP');
    assert.equal(sbp.body.payment_detail_type, 'phone');
    // «Если платите из Т-Банка» — это и есть внутрибанковский перевод, и банк
    // при нём обязателен.
    const tbank = await send('SBP_TBANK');
    assert.equal(tbank.body['self-bank'], true);
    assert.equal(tbank.body.payment_gateway, 'tbank_rub');
    const abroad = await send('TO_CARD_TRANSGRAN');
    assert.equal(abroad.body.is_transgran, true);

    // Просили российский маршрут, а реквизит из другого региона — отказ. Это
    // единственная проверка трансграничности, которую ответ вообще позволяет.
    global.fetch = async () => reply({ detail: '4000100020003000', detail_type: 'card', region: 'Таджикистан' });
    const foreign = await mp.createInvoice(on, { amount: 1000, currency: 'RUB', method: 'TO_CARD', externalId: 'aabbccddeeff112233' });
    assert.equal(foreign.error, 'region_mismatch');
    // Тип реквизита не тот, что просили, — тоже отказ: карта вместо телефона
    // это другой способ, а не мелочь.
    global.fetch = async () => reply({ detail: '4000100020003000', detail_type: 'card', region: 'Россия' });
    assert.equal((await mp.createInvoice(on, { amount: 1000, currency: 'RUB', method: 'SBP', externalId: 'aabbccddeeff112233' })).error, 'method_mismatch');
  } finally {
    if (real) global.fetch = real; else delete global.fetch;
  }
});

test('MeridianPay: у НСПК реквизит — ссылка, а не картинка base64', async () => {
  const mp = require('../lib/meridianpay');
  const on = {
    meridianpayEnabled: true, meridianpayApiKey: 'k',
    meridianpayMerchantId: '3f2a1c88-5d94-4e07-9b31-6a0c2e7d5b40'
  };
  const real = global.fetch;
  const now = Math.floor(Date.now() / 1000);
  const nspk = detail => ({ ok: true, status: 200, json: async () => ({ success: true, data: {
    order_id: '566c2485-7909-41d4-9fed-98d92e3f9b5f', status: 'pending', currency: 'rub', amount: 100000,
    payment_gateway: 'ПСБ', payment_detail: detail,
    expires_at: now + 600, current_server_time: now
  } }) });
  const ask = () => mp.createInvoice(on, { amount: 1000, currency: 'RUB', method: 'QR_NSPK', externalId: 'aabbccddeeff112233' });
  try {
    // У НСПК в `detail` лежит сам QR картинкой. В href такое ставить нельзя, да
    // и покупателю нужна платёжная страница, а не изображение.
    global.fetch = async () => nspk({
      detail: 'data:image/jpeg;base64,/9j/4AAQSkZJRg', detail_type: 'nspk',
      qr_code_link: 'https://qr.nspk.ru/ABCD?type=01', region: 'Россия'
    });
    const ok = await ask();
    assert.equal(ok.ok, true);
    assert.equal(ok.invoice.requisite, 'https://qr.nspk.ru/ABCD?type=01');

    // Ссылки нет — реквизита нет: показывать base64 как «номер для перевода»
    // хуже, чем честно уйти на вторую кассу.
    global.fetch = async () => nspk({ detail: 'data:image/jpeg;base64,/9j/4AAQ', detail_type: 'nspk', region: 'Россия' });
    assert.equal((await ask()).error, 'no_requisite');
    // Чужая схема в ссылке отбрасывается так же: реквизит уезжает в href.
    global.fetch = async () => nspk({ detail: 'x', detail_type: 'nspk', qr_code_link: 'javascript:alert(1)', region: 'Россия' });
    assert.equal((await ask()).error, 'no_requisite');
  } finally {
    if (real) global.fetch = real; else delete global.fetch;
  }
});

test('живой список банков MeridianPay превращается в наши способы', () => {
  const mp = require('../lib/meridianpay');
  const live = mp.parseGateways([
    { code: 'sberbank_rub', currency: 'rub', min_limit: '999', max_limit: '100000', detail_types: ['card', 'phone', 'nspk'] },
    { code: 'tbank_rub', currency: 'rub', min_limit: '1000', max_limit: '300000', detail_types: ['card', 'phone', 'nspk'] },
    { code: 'somebank_tjs', currency: 'tjs', min_limit: '1', max_limit: '300000', detail_types: ['card'] }
  ]);
  // Рубль первым: цены магазина в нём.
  assert.deepEqual(live.currencies, ['RUB', 'TJS']);
  assert.ok(live.byCurrency.RUB.includes('SBP'));
  assert.ok(live.byCurrency.RUB.includes('TO_CARD'));
  assert.ok(live.byCurrency.RUB.includes('QR_NSPK'));
  // Способ с привязкой к банку доступен только если этот банк есть в ответе.
  assert.ok(live.byCurrency.RUB.includes('SBP_TBANK'), 'tbank_rub в списке есть');
  assert.equal(live.byCurrency.RUB.includes('SBP_ALFA'), false, 'alfabank_rub в ответе нет — способ не предлагаем');
  // У сомони есть только карта — телефонных способов там взяться неоткуда.
  assert.deepEqual(live.byCurrency.TJS.filter(id => id === 'SBP'), []);
  assert.equal(live.limits.RUB.max, 300000);

  // Незнакомый код перевести в параметры MeridianPay нечем: такой способ
  // обслужит только CrocoPAY, у которой id способа и есть её собственный код.
  assert.equal(mp.supports('NEW_FANCY_PAY'), false);
  assert.equal(mp.supports('SBP'), true);
  assert.equal(require('../lib/crocopay').supports('NEW_FANCY_PAY'), true);
});

test('очередь касс: отказ первой уводит ко второй, и покупатель этого не видит', () => {
  const PAYMENTS = require('../lib/payments');
  const source = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const both = {
    crocopayEnabled: true, crocopayClientId: 'id', crocopayClientSecret: 's',
    meridianpayEnabled: true, meridianpayApiKey: 'k',
    meridianpayMerchantId: '3f2a1c88-5d94-4e07-9b31-6a0c2e7d5b40'
  };
  // Порядок задаёт владелец, а не порядок в коде.
  assert.deepEqual(PAYMENTS.chainFor(both, null, 'SBP', 'RUB').map(p => p.id), ['crocopay', 'meridianpay']);
  assert.deepEqual(PAYMENTS.chainFor(Object.assign({ payPrimary: 'meridianpay' }, both), null, 'SBP', 'RUB').map(p => p.id),
    ['meridianpay', 'crocopay']);
  // Выключенная касса в очередь не попадает, и оплата остаётся на одной.
  assert.deepEqual(PAYMENTS.chainFor(Object.assign({}, both, { meridianpayEnabled: false }), null, 'SBP', 'RUB').map(p => p.id), ['crocopay']);
  // Способ, которого нет в живом списке кассы, ей не отдаём; та, что не
  // ответила, остаётся в очереди — иначе запасного варианта не будет как раз
  // тогда, когда он нужнее всего.
  const live = { byProvider: { crocopay: { byCurrency: { RUB: ['TO_CARD'] } }, meridianpay: null } };
  assert.deepEqual(PAYMENTS.chainFor(both, live, 'SBP', 'RUB').map(p => p.id), ['meridianpay']);
  // Незнакомый код умеет только CrocoPAY.
  assert.deepEqual(PAYMENTS.chainFor(both, null, 'NEW_FANCY_PAY', 'RUB').map(p => p.id), ['crocopay']);

  // Оплата на витрине включена, если работает ХОТЯ БЫ одна касса.
  assert.equal(PAYMENTS.enabled({ meridianpayEnabled: true, meridianpayApiKey: 'k', meridianpayMerchantId: '3f2a1c88-5d94-4e07-9b31-6a0c2e7d5b40' }), true);
  assert.equal(PAYMENTS.enabled({ meridianpayEnabled: true, meridianpayApiKey: 'k' }), false, 'без merchant_id касса не работает');
  assert.equal(PAYMENTS.enabled({}), false);

  // Маршрут перебирает очередь и уходит к следующей кассе только с ОТКАЗОМ:
  // готовый ответ (реквизиты выданы, заказ уже оплачен) возвращается сразу.
  const route = source.slice(source.indexOf('async function startPaymentRoute('), source.indexOf("app.post('/api/pay/start'"));
  assert.match(route, /for \(let i = 0; i < chain\.length; i\+\+\)/);
  assert.match(route, /if \(outcome\.done\) return \{ status: outcome\.status, body: outcome\.body \}/);
  assert.match(route, /tried\.push\(\{ provider: p\.id, code: outcome\.code \}\)/);
  // Покупателю — одна фраза на всю очередь, и не последняя по счёту, а самая
  // полезная: про то, что касс было несколько, он знать не должен.
  assert.match(route, /PAYMENTS\.summaryErrorCode\(tried\.map\(t => t\.code\)\)/);
  assert.equal(PAYMENTS.summaryErrorCode(['provider_error', 'no_requisite']), 'no_requisite');
  assert.equal(PAYMENTS.summaryErrorCode(['timeout', 'no_requisite']), 'no_requisite');
  assert.equal(PAYMENTS.summaryErrorCode(['provider_error', 'timeout']), 'timeout');
  assert.equal(PAYMENTS.summaryErrorCode([]), 'provider_error');

  // Двусмысленный исход (ответ прошлого POST потерян) не зовёт платить заново:
  // касса могла молча выпустить счёт.
  assert.match(route, /if \(processing\)[\s\S]{0,200}payment_processing/);

  // Адрес маршрута — без имени кассы, и прежний остаётся ради открытых вкладок.
  assert.match(source, /app\.post\('\/api\/pay\/start', startPaymentRoute\)/);
  assert.match(source, /app\.post\('\/api\/pay\/crocopay\/start', startPaymentRoute\)/);
  const browser = fs.readFileSync(path.join(__dirname, '..', 'public', 'pay.js'), 'utf8');
  assert.match(browser, /fetch\('\/api\/pay\/start'/);
  assert.doesNotMatch(browser, /crocopay|meridianpay/i, 'витрина не называет платёжки даже в адресах');
});

test('у каждой кассы свой производный requestId', () => {
  const PAYMENTS = require('../lib/payments');
  const base = 'a'.repeat(32);
  const one = PAYMENTS.requestIdFor(base, 'crocopay');
  const two = PAYMENTS.requestIdFor(base, 'meridianpay');
  // Браузер шлёт ОДИН ключ на нажатие, а попыток за это нажатие бывает две.
  // Под общим ключом вторая просто не создалась бы: db.startOrderPayment
  // считает повтор того же requestId потерянным ответом.
  assert.notEqual(one, two);
  assert.match(one, /^[a-f0-9]{32}$/);
  assert.match(two, /^[a-f0-9]{32}$/);
  // Детерминированный: повтор того же нажатия попадает в те же две попытки и
  // никогда не плодит лишние счета.
  assert.equal(PAYMENTS.requestIdFor(base, 'crocopay'), one);

  // Отпечаток запроса общий на кассы и сравнивает то, что видел покупатель.
  const want = { method: 'SBP', currency: 'RUB', amount: 67990 };
  assert.equal(PAYMENTS.sameStartRequest(want, { method: 'SBP', currency: 'rub', amount: 67990 }), true);
  assert.equal(PAYMENTS.sameStartRequest(want, { method: 'TO_CARD', currency: 'RUB', amount: 67990 }), false);
  assert.equal(PAYMENTS.sameStartRequest(want, { method: 'SBP', currency: 'RUB', amount: 67991 }), false);
});

test('статистика по кассам считает отказы и видна в заказах', () => {
  const orders = [
    { id: 'a', total: 1000, payment: { attempts: [
      { provider: 'crocopay', status: 'failed', lastErrorCode: 'no_requisite' },
      { provider: 'meridianpay', status: 'paid', invoiceId: 'x', requisite: '4000' }
    ] } },
    { id: 'b', total: 2000, payment: { attempts: [
      { provider: 'crocopay', status: 'failed', lastErrorCode: 'timeout' }
    ] } },
    // Заявка, оформленная до появления второй кассы: поля provider нет вовсе,
    // и читается она как CrocoPAY — другой тогда и не было.
    { id: 'c', total: 3000, payment: { status: 'paid', invoiceId: 'y', requisite: '5000' } },
    { id: 'd', total: 4000, payment: null }
  ];
  const rows = render.providerStats(orders);
  const croco = rows.find(r => r.id === 'crocopay');
  const meridian = rows.find(r => r.id === 'meridianpay');
  assert.equal(croco.tries, 3);
  assert.equal(croco.failed, 2);
  assert.equal(croco.paid, 1, 'легаси-попытка без provider досталась CrocoPAY');
  assert.deepEqual(croco.errors, { no_requisite: 1, timeout: 1 });
  assert.equal(meridian.tries, 1);
  assert.equal(meridian.paid, 1);
  assert.equal(meridian.failed, 0);

  const html = render.providerStatsBar(rows);
  assert.match(html, /CrocoPAY/);
  assert.match(html, /MeridianPay/);
  // Доля отказов рядом с самим числом: «2 (67%)» читается за один раз.
  assert.match(html, /2 <span class="muted">\(67%\)<\/span>/);
  assert.match(html, /нет свободных реквизитов 1/);
  assert.match(html, /касса не ответила 1/);
  // Оплату ещё не включали — таблице нечего сказать, и её нет вовсе.
  assert.equal(render.providerStatsBar(render.providerStats([{ id: 'x', total: 1, payment: null }])), '');

  // В строке заказа видно, какая касса выдала реквизиты.
  const row = render.orderPayMethod({ payment: { provider: 'meridianpay', method: 'SBP', invoiceId: 'x', requisite: '+7 900' } });
  assert.match(row, /СБП/);
  assert.match(row, /MeridianPay/);
});


test('касса не берётся за сумму — очередь отсеивает её ДО создания попытки', async () => {
  const PAYMENTS = require('../lib/payments');
  const mp = require('../lib/meridianpay');
  const pay = require('../lib/pay-methods');

  /* MeridianPay принимает только ЦЕЛОЕ число основных единиц, а счёт в валюте
   * считается по курсу владельца: 51 600 ₽ / 90 = 573.33 $. Без этого сита в
   * заказе появлялась бы попытка, которую касса в глаза не видела: отказ
   * `bad_amount` приходит мгновенно и без сети — то есть в таблице «Кассы» это
   * выглядело бы как её отказ. Ложь в той самой статистике, ради которой
   * таблицу и завели.
   */
  const amount = pay.convert(51600, 90);
  assert.equal(Number.isInteger(amount), false, 'пересчёт по курсу даёт копейки');
  assert.equal(mp.acceptsAmount(amount, 'USD', null), false);
  assert.equal(mp.acceptsAmount(51600, 'RUB', null), true);

  // Ни одного обращения в сеть на такой сумме — значит и «отказ кассы» здесь
  // был бы выдуман нами, а не получен от неё.
  const real = global.fetch;
  try {
    global.fetch = async () => { throw new Error('в сеть ходить нельзя'); };
    const r = await mp.createInvoice(
      { meridianpayEnabled: true, meridianpayApiKey: 'k', meridianpayMerchantId: '3f2a1c88-5d94-4e07-9b31-6a0c2e7d5b40' },
      { amount, currency: 'USD', method: 'TO_CARD', externalId: 'aabbccddeeff1122' });
    assert.equal(r.error, 'bad_amount');
  } finally {
    if (real) global.fetch = real; else delete global.fetch;
  }

  const both = {
    crocopayEnabled: true, crocopayClientId: 'i', crocopayClientSecret: 's',
    meridianpayEnabled: true, meridianpayApiKey: 'k',
    meridianpayMerchantId: '3f2a1c88-5d94-4e07-9b31-6a0c2e7d5b40'
  };
  const live = { byProvider: {
    crocopay: { byCurrency: { RUB: ['TO_CARD'], USD: ['TO_CARD'] } },
    meridianpay: { byCurrency: { RUB: ['TO_CARD'], USD: ['TO_CARD'] }, limits: { RUB: { min: 999, max: 300000 } } }
  } };
  assert.deepEqual(PAYMENTS.chainFor(both, live, 'TO_CARD', 'RUB', 51600).map(p => p.id), ['crocopay', 'meridianpay']);
  assert.deepEqual(PAYMENTS.chainFor(both, live, 'TO_CARD', 'USD', amount).map(p => p.id), ['crocopay']);
  // Потолок банков тоже сито: 906 шлюзов приходят живым ответом, и не
  // воспользоваться их лимитами значило бы держать эти данные зря.
  assert.deepEqual(PAYMENTS.chainFor(both, live, 'TO_CARD', 'RUB', 400000).map(p => p.id), ['crocopay']);
  // Вызов БЕЗ суммы (настройки, предпросмотр списка) касс не выкидывает.
  assert.deepEqual(PAYMENTS.chainFor(both, live, 'TO_CARD', 'RUB').map(p => p.id), ['crocopay', 'meridianpay']);

  // Маршрут спрашивает очередь именно с суммой — иначе сито не сработает.
  const source = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.match(source, /PAYMENTS\.chainFor\(s, ctx\.live, method, ctx\.currency, ctx\.amount\)/);
});

test('таблица перевода способов MeridianPay не может указывать в пустоту', () => {
  const mp = require('../lib/meridianpay');
  const pay = require('../lib/pay-methods');
  const known = pay.METHODS.map(m => m.id);
  // Документированные значения `payment_detail_type`. Опечатка здесь тихо
  // сделала бы способ нерабочим: касса вернула бы не тот тип реквизита, а мы
  // забраковали бы её же ответ.
  const TYPES = ['card', 'phone', 'sim', 'tips', 'nspk'];
  for (const [id, route] of Object.entries(mp.MAP)) {
    assert.ok(known.includes(id), `перевод есть, а способа нет: ${id}`);
    assert.ok(TYPES.includes(route.detail), `неизвестный тип реквизита у ${id}: ${route.detail}`);
    assert.equal(typeof route.transgran, 'boolean', `трансграничность у ${id} задаётся явно`);
    // Требование документации: при self-bank банк обязателен, иначе сделку
    // просто не на что создавать.
    if (route.selfBank) assert.ok(route.gateway, `self-bank без банка: ${id}`);
    if (route.gateway) assert.match(route.gateway, /^[a-z0-9_]+$/, `код банка у ${id}`);
    assert.equal(mp.supports(id), true);
  }
  // Способ, которого касса перевести не может, честно об этом говорит — тогда
  // его обслужит только CrocoPAY, а не «обе, но одна молча сломается».
  assert.equal(mp.supports('NEW_FANCY_PAY'), false);
});

test('срок реквизита считается по часам кассы, а не по нашим', () => {
  const mp = require('../lib/meridianpay');
  // MeridianPay отдаёт unix-СЕКУНДЫ. Если брать `expires_at` как абсолютное
  // время, расхождение часов между её сервером и нашим превращается в счёт,
  // который у нас уже истёк (реквизиты не покажем на живой сделке) или живёт
  // лишние минуты (покажем чужие). Поэтому берём остаток по ЕЁ часам.
  const theirNow = 1759091081;                 // часы кассы ушли вперёд на годы
  const left = mp.expiryMs({ expires_at: theirNow + 600, current_server_time: theirNow });
  assert.ok(Math.abs(left - (Date.now() + 600000)) < 2000, 'остаток 10 минут от НАШЕГО времени');
  // Сгоревшая сделка даёт ноль, а не отрицательный срок: ноль всюду означает
  // «срок не подтверждён», и реквизиты по нему не показываются.
  assert.equal(mp.expiryMs({ expires_at: theirNow - 10, current_server_time: theirNow }), 0);
  // Нет часов кассы — берём абсолютное значение, как есть.
  assert.equal(mp.expiryMs({ expires_at: 1759091681 }), 1759091681000);
  assert.equal(mp.expiryMs({}), 0);
  assert.equal(mp.expiryMs(null), 0);
});

test('integrity у MeridianPay ничего не подтверждает и не может ничего сломать', () => {
  const mp = require('../lib/meridianpay');
  const crypto = require('crypto');
  const secret = 'T5Q0-secret';
  const order = '566c2485-7909-41d4-9fed-98d92e3f9b5f';
  // Алгоритм поля `integrity` не описан в документации НИГДЕ — только значения
  // в примерах. Поэтому оно не авторизует ничего: подтверждают уведомление наш
  // token в адресе и обязательная сверка через GET. Здесь только диагностика,
  // которая узнает формулу с первого настоящего callback.
  const hit = mp.integrityHint({ meridianpaySecret: secret },
    { order_id: order, integrity: crypto.createHmac('sha256', secret).update(order).digest('hex') });
  assert.equal(hit, 'hmac(order_id)');
  // Ни секрета, ни мусора она наружу не пускает и на них не спотыкается.
  assert.equal(mp.integrityHint({}, { order_id: order, integrity: 'x' }), '');
  assert.equal(mp.integrityHint({ meridianpaySecret: secret }, { integrity: 'не-хеш' }), '');
  assert.equal(mp.integrityHint({ meridianpaySecret: secret }, null), '');
  assert.equal(mp.integrityHint(null, null), '');

  // Проверка callback у MeridianPay ничего не проверяет намеренно — и должна
  // об этом говорить в коде, чтобы её не приняли за настоящую подпись.
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'meridianpay.js'), 'utf8');
  const fn = src.slice(src.indexOf('function verifyCallback'), src.indexOf('module.exports'));
  assert.match(fn, /return true/);
  assert.match(src, /ПОДПИСИ У CALLBACK НЕТ/);
  // Значит вся тяжесть на token и сверке: маршрут обязан требовать оба.
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const route = server.slice(server.indexOf('function paymentCallbackRoute('), server.indexOf("app.post('/api/pay/crocopay/callback'"));
  assert.match(route, /!tokenOk \|\| !ownAttempt/);
});

test('ни одна страница витрины не называет платёжку и не носит её ключи', () => {
  // Прямое требование: покупатель не должен догадаться, что касс несколько.
  // Проверяем разом все страницы, а не одну: забытая страница — это ровно тот
  // способ, которым такая утечка и появляется.
  const secrets = {
    crocopayEnabled: true, crocopayClientId: 'ID-КАССЫ', crocopayClientSecret: 'СЕКРЕТ-CROCO',
    meridianpayEnabled: true, meridianpayApiKey: 'ТОКЕН-MERIDIAN',
    meridianpayMerchantId: '3f2a1c88-5d94-4e07-9b31-6a0c2e7d5b40', meridianpaySecret: 'СЕКРЕТ-MERIDIAN'
  };
  const settings = Object.assign(dbCore.defaultSettings(), { storeName: 'Тест', tagline: '' }, secrets);
  const product = {
    id: 'p1', name: 'iPhone', category: 'iPhone', price: 50990, inStock: true,
    images: [], colors: [], bands: [], storages: [], options: [], specs: ''
  };
  const db = {
    getProducts: () => [product], visibleProducts: () => [product],
    categories: () => ['iPhone'], visibleCategories: () => ['iPhone'],
    ratingFor: () => ({ avg: 0, count: 0 }), reviewsForProduct: () => []
  };
  const order = {
    id: 'o1', number: '482913', total: 51600, status: 'new', createdAt: Date.now(),
    items: [{ id: 'p1', name: 'iPhone', qty: 1, price: 50990 }],
    payment: { provider: 'meridianpay', status: 'pending', method: 'SBP', attempts: [] }
  };
  const opts = { origin: 'https://shop', categories: ['iPhone'], payRemind: null };
  const pages = {
    'главная': () => render.homePage(settings, db, Object.assign({ category: '', q: '' }, opts)),
    'товар': () => render.productPage(settings, db, product, opts),
    'оформление': () => render.checkoutPage(settings, Object.assign({ payOnline: true }, opts)),
    'оплата': () => render.payPage(settings, order, Object.assign({
      methods: [{ id: 'SBP', name: 'СБП', hint: '', kind: 'phone', mark: 'sbp' }],
      currencies: ['RUB'], currency: 'RUB', amount: 51600, amounts: { RUB: 51600 }
    }, opts)),
    'политика': () => render.privacyPage(settings, opts)
  };
  for (const [name, build] of Object.entries(pages)) {
    const html = build();
    assert.doesNotMatch(html, /crocopay|meridian/i, `имя платёжки на витрине: ${name}`);
    for (const value of Object.values(secrets)) {
      if (typeof value !== 'string' || value.length < 6) continue;
      assert.ok(!html.includes(value), `ключ кассы уехал на витрину: ${name} / ${value}`);
    }
  }
});

test('оплатившийся во время очереди заказ побеждает технический отказ', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const create = source.slice(source.indexOf('async function requestInvoiceFrom('), source.indexOf('function paymentAlternative('));
  /* Очередь касс идёт с await между попытками, и за это время webhook мог
   * подтвердить прежний счёт. `startOrderPayment()` тогда намеренно возвращает
   * заказ, не создавая попытку поверх подтверждённой оплаты, — и без этой
   * проверки покупатель увидел бы «не удалось начать оплату» поверх уже
   * пришедших денег.
   */
  const guard = create.indexOf('if (!started || !attempt || !attempt.token)');
  assert.ok(guard > -1);
  const tail = create.slice(guard, guard + 700);
  assert.match(tail, /terminalPaymentBody\(db\.getOrder\(id\)\)/);
  assert.ok(tail.indexOf('terminalPaymentBody') < tail.indexOf('Не удалось начать оплату'),
    'терминальное состояние проверяется ДО технической ошибки');
});


test('счета кассы без ключей не забивают очередь фоновой сверки', () => {
  const PAYMENTS = require('../lib/payments');
  const source = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const sweep = source.slice(source.indexOf('async function reconcileOpenPayments'), source.indexOf('const paymentSweep = setInterval'));

  /* Пока касса была одна, проход просто не начинался без ключей. С двумя так
   * нельзя: счета выключенной кассы сверке не поддаются, `reconcile` выходит по
   * `not_reconcilable` и НЕ трогает `lastCheckedAt` — значит в сортировке
   * «сначала давно не проверенные» они вечно первые и вытесняют рабочие счета
   * из бюджета в 40 штук. Отбор по ключам эмитента закрывает это.
   */
  assert.match(sweep, /const issuer = PAYMENTS\.provider\(attempt\.provider\);\s*\n\s*if \(!issuer \|\| !issuer\.configured\(s\)\) continue;/);
  assert.ok(sweep.indexOf('issuer.configured(s)') < sweep.indexOf('queue.push'),
    'несверяемые счета отсеиваются ДО попадания в очередь');
  // Проход по-прежнему начинается, пока с ключами хоть одна касса.
  assert.match(sweep, /if \(!PAYMENTS\.configured\(s\)\) return;/);

  const onlyCroco = { crocopayEnabled: true, crocopayClientId: 'i', crocopayClientSecret: 's' };
  assert.equal(PAYMENTS.configured(onlyCroco), true);
  assert.equal(PAYMENTS.provider('crocopay').configured(onlyCroco), true);
  assert.equal(PAYMENTS.provider('meridianpay').configured(onlyCroco), false);
  // Заказ, записанный до второй кассы, поля provider не имеет — и обязан
  // сверяться как прежде.
  assert.equal(PAYMENTS.provider('').configured(onlyCroco), true);
});

test('регион не выдаёт себя за банк получателя', async () => {
  const mp = require('../lib/meridianpay');
  const on = {
    meridianpayEnabled: true, meridianpayApiKey: 'k',
    meridianpayMerchantId: '3f2a1c88-5d94-4e07-9b31-6a0c2e7d5b40'
  };
  const real = global.fetch;
  const now = Math.floor(Date.now() / 1000);
  try {
    // Касса не вернула название банка. Подставить вместо него регион значило бы
    // напечатать покупателю «Банк получателя: Россия» — пустое значение честнее,
    // и такую строку payRow() просто не рисует.
    global.fetch = async () => ({ ok: true, status: 200, json: async () => ({ success: true, data: {
      order_id: '566c2485-7909-41d4-9fed-98d92e3f9b5f', status: 'pending', currency: 'rub', amount: 100000,
      payment_detail: { detail: '4000100020003000', detail_type: 'card', region: 'Россия' },
      expires_at: now + 600, current_server_time: now
    } }) });
    const r = await mp.createInvoice(on, { amount: 1000, currency: 'RUB', method: 'TO_CARD', externalId: 'aabbccddeeff11' });
    assert.equal(r.ok, true);
    assert.equal(r.invoice.bank, '', 'банка нет — строки не будет');
    assert.equal(r.invoice.region, 'Россия', 'но регион остаётся: по нему сверяется трансграничность');
    assert.equal(render.payLive({ status: 'pending', invoiceId: r.invoice.id, requisite: r.invoice.requisite, expiresAt: r.invoice.expiresAt }), true);
  } finally {
    if (real) global.fetch = real; else delete global.fetch;
  }
});


test('диапазон суммы заказа задаётся в настройках и меняет витрину', () => {
  const PAYMENTS = require('../lib/payments');
  const SHIP = require('../lib/delivery-price');

  // Значения по умолчанию — пределы CrocoPAY, как и было.
  assert.deepEqual(PAYMENTS.boundsOf({}), { min: PAYMENTS.MIN_TOTAL, max: PAYMENTS.MAX_TOTAL });
  assert.deepEqual(dbCore.defaultSettings().payMinTotal, 1000);
  assert.deepEqual(dbCore.defaultSettings().payMaxTotal, 250000);

  const wide = { payMinTotal: 500, payMaxTotal: 900000 };
  assert.deepEqual(PAYMENTS.boundsOf(wide), { min: 500, max: 900000 });
  assert.equal(PAYMENTS.payable(600, wide), true);
  assert.equal(PAYMENTS.payable(600), false, 'без настроек действует предел по умолчанию');
  assert.equal(PAYMENTS.payable(900000, wide), true);
  assert.equal(PAYMENTS.payable(900001, wide), false);
  assert.match(PAYMENTS.limitError(900001, wide), /не более 900\s000\s₽/);
  assert.match(PAYMENTS.limitError(499, wide), /Минимальная сумма заказа — 500\s₽/);

  /* Пустое или испорченное поле — возврат к значению по умолчанию, а НЕ «предела
   * нет»: молча снятый потолок означал бы заказы, которые касса не проведёт. */
  assert.deepEqual(PAYMENTS.boundsOf({ payMinTotal: '', payMaxTotal: null }), { min: PAYMENTS.MIN_TOTAL, max: PAYMENTS.MAX_TOTAL });
  assert.deepEqual(PAYMENTS.boundsOf({ payMinTotal: 'сто', payMaxTotal: -5 }), { min: PAYMENTS.MIN_TOTAL, max: PAYMENTS.MAX_TOTAL });
  // Перевёрнутый диапазон разворачиваем, а не запрещаем всё: форма такого не
  // сохранит, но настройки правят и руками, а «нельзя оформить ни одного
  // заказа» — худший способ узнать об опечатке.
  assert.deepEqual(PAYMENTS.boundsOf({ payMinTotal: 5000, payMaxTotal: 2000 }), { min: 2000, max: 5000 });

  // Оплата выключена — пределов нет вовсе, как и раньше.
  assert.deepEqual(PAYMENTS.limits(wide), { min: 0, max: 0 });
  const on = Object.assign({ crocopayEnabled: true, crocopayClientId: 'i', crocopayClientSecret: 's' }, wide);
  assert.deepEqual(PAYMENTS.limits(on), { min: 500, max: 900000 });

  /* Видимое следствие: потолок решает, какие товары вообще продаются. Пока он
   * 250 000, Vision Pro на витрине «Нет в наличии»; подняли — вернулся в
   * продажу. Ради этого настройку и заводили. */
  const pricey = {
    id: 'vision', name: 'Дорогой', category: 'К', inStock: true,
    images: [], colors: [], bands: [], storages: [], options: [], price: 349990
  };
  const base = { storeName: 'Т', tagline: '', currency: '₽', currencyPosition: 'after' };
  const db = {
    getProducts: () => [pricey], visibleProducts: () => [pricey],
    categories: () => ['К'], visibleCategories: () => ['К'], ratingFor: () => ({ avg: 0, count: 0 })
  };
  const tight = Object.assign({}, base, { crocopayEnabled: true, crocopayClientId: 'i', crocopayClientSecret: 's' });
  const roomy = Object.assign({}, tight, { payMaxTotal: 900000 });
  assert.match(render.homePage(tight, db, { category: '', q: '', origin: '' }), /Нет в наличии/);
  assert.doesNotMatch(render.homePage(roomy, db, { category: '', q: '', origin: '' }), /Нет в наличии/);
  // Потолок уезжает и в скрипт витрины — там он гасит «+» у количества.
  assert.match(render.homePage(roomy, db, { category: '', q: '', origin: '' }), /__ORDER_MAX__\s*=\s*900000/);

  /* Подгонка доставки под круглый итог обязана двигаться в тех же границах:
   * округлять ВВЕРХ за потолок — значит собрать заказ, который касса не
   * проведёт. Потолок приходит параметром: модуль доставки о настройках не
   * знает и знать не должен. */
  const addr = 'г Москва, ул Тверская, д 1';
  const capped = SHIP.quoteAll(addr, 249800, 250000).prices.cdek;
  const uncapped = SHIP.quoteAll(addr, 249800, 900000).prices.cdek;
  // Округлённый вариант, помещающийся под потолок, выбирается как обычно.
  assert.equal(249800 + capped.pvz, 250000);
  /* А вот курьеру под потолком места нет вовсе: любой круглый итог с ним уходит
   * за 250 000. Тогда берётся чистый тариф (360), а не округление вверх (400) —
   * и заказ у самого потолка просто не оформляется. Это задокументированное
   * следствие, а не недосмотр: «заказ на 249 900 ₽ может не пройти — доставка
   * выведет его за потолок». */
  assert.equal(capped.courier, SHIP.rate('cdek', 'courier', 'msk'));
  assert.equal(uncapped.courier > capped.courier, true, 'без потолка округление вверх разрешено');
  // Сверяем с теми же настройками, при которых считали доставку: у `on` потолок
  // расширен до 900 000, и 250 160 ₽ там как раз проходят.
  assert.equal(PAYMENTS.payable(249800 + capped.courier, tight), false);
  assert.equal(PAYMENTS.payable(249800 + capped.courier, on), true);
  // Ноль означает «потолка нет» (оплата на витрине выключена).
  assert.ok(SHIP.quoteAll(addr, 249800, 0).prices.cdek.pvz > 0);
});

test('форма настроек не сохраняет кривой диапазон суммы', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const route = source.slice(source.indexOf("app.post('/admin/settings'"));
  // Проверка ДО записи — то же правило, что у всей этой формы.
  assert.ok(route.indexOf('Максимальная сумма заказа не может быть меньше минимальной') < route.indexOf('db.saveSettings(patch)'));
  assert.match(route, /положительное число или пусто/);
  assert.match(route, /не больше 100 000 000 ₽/);
  // Пустое поле возвращает значение по умолчанию, а не снимает предел.
  assert.match(route, /bound\('payMinTotal', PAYMENTS\.MIN_TOTAL/);
  assert.match(route, /bound\('payMaxTotal', PAYMENTS\.MAX_TOTAL/);
  // `fail()` только отправляет ответ и выполнение не прерывает — поэтому его
  // зовут через `return`, а не изнутри вспомогательной функции.
  assert.match(route, /if \(!low\.ok\) return fail\(low\.error\)/);
  assert.match(route, /if \(!high\.ok\) return fail\(high\.error\)/);
});

test('в настройках есть касса, а ключи не утекают в разметку витрины', () => {
  const settings = Object.assign(dbCore.defaultSettings(), {
    crocopayEnabled: true, crocopayClientId: 'ID-КАССЫ', crocopayClientSecret: ''
  });
  const db = { pendingReviewCount: () => 0 };
  const html = adminViews.settingsPage(settings, db, null);
  assert.match(html, /name="crocopayEnabled"[^>]*checked/);
  assert.match(html, /name="crocopayClientId"/);
  assert.match(html, /name="crocopayClientSecret"/);
  // Валюта счёта выбирается, но пока касса не ответила — только рубль: список
  // валют приходит от неё, а не из зашитой таблицы.
  assert.match(html, /name="crocopayCurrency"/);
  assert.equal((html.match(/<option value="[A-Z]{3}" selected>/g) || []).length, 1);
  assert.match(html, /<option value="RUB" selected>RUB — Рубль<\/option>/);
  assert.match(html, /name="crocopayCurrencyChoice"/);
  // Включено без ключей — на витрине оплаты нет, и владелец обязан это увидеть.
  assert.match(html, /Касса включена, но ключи не заданы/);
  const full = adminViews.settingsPage(Object.assign({}, settings, { crocopayClientSecret: 'СЕКРЕТ' }), db, null);
  assert.doesNotMatch(full, /Касса включена, но ключи не заданы/);

  // Ключи второй кассы в разметку витрины не попадают ровно так же.
  const withMeridian = adminViews.settingsPage(Object.assign({}, settings, {
    crocopayClientSecret: 'СЕКРЕТ', meridianpayEnabled: true, meridianpayApiKey: 'ТОКЕН',
    meridianpayMerchantId: '3f2a1c88-5d94-4e07-9b31-6a0c2e7d5b40', meridianpaySecret: 'СЕКРЕТ-2'
  }), db, null);
  assert.match(withMeridian, /name="meridianpaySecret" value="СЕКРЕТ-2"/);
  const shop = render.checkoutPage(Object.assign({}, settings, {
    meridianpayApiKey: 'ТОКЕН', meridianpayMerchantId: '3f2a1c88-5d94-4e07-9b31-6a0c2e7d5b40',
    meridianpaySecret: 'СЕКРЕТ-2', crocopayClientSecret: 'СЕКРЕТ'
  }), { origin: '', payOnline: true });
  assert.doesNotMatch(shop, /ТОКЕН|СЕКРЕТ|3f2a1c88|ID-КАССЫ/, 'ключи касс на витрину не уходят');
  // И названий платёжек покупатель нигде не видит: их у нас две, и это наше
  // внутреннее дело.
  assert.doesNotMatch(shop, /CrocoPAY|MeridianPay/i);

  // Маршрут сохранения: галочка снимается отсутствием поля, а кэш способов
  // сбрасывается — он собран под ключи прежних касс.
  const source = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const route = source.slice(source.indexOf("app.post('/admin/settings'"));
  assert.match(route, /patch\.crocopayEnabled = req\.body\.crocopayEnabled !== undefined/);
  assert.match(route, /patch\.meridianpayEnabled = req\.body\.meridianpayEnabled !== undefined/);
  // UUID мерчанта проверяется ДО записи: с мусором в этом поле касса не примет
  // ни одной сделки, а владелец увидел бы «Сохранено».
  assert.match(route, /MERIDIAN\.validMerchantId\(merchant\)/);
  assert.match(route, /PAYMENTS\.forgetMethods\(\)/);
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
  const rail = js.slice(js.indexOf('function renderRail'), js.indexOf('function renderRail') + 2400);
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

// ─── Отзывы с площадки: сборка покупателя, доставка, видео, даты ─────────────

test('у отзыва одна общая оценка: признаков «доставка/сервис/цена» нет нигде', () => {
  const rv = { id: 'r1', author: 'Вера', rating: 5, text: 'Хорошо', status: 'approved', createdAt: 1000,
    aspects: { delivery: 5, service: 4, price: 5 } };
  const db = { reviewsForProduct: () => [rv], ratingFor: () => ({ avg: 5, count: 1 }), categories: () => [], visibleCategories: () => [] };
  const product = { id: 'p', name: 'Товар', category: 'Тест', price: 100, inStock: true, images: [] };
  const html = render.productPage({ storeName: 'Тест', currency: '₽' }, db, product, {});

  // Ни плашек в карточке, ни средних в сводке, ни полей в форме отзыва.
  assert.doesNotMatch(html, /asp-chip|review-aspects/, 'плашки признаков в карточке');
  assert.doesNotMatch(html, /Цена\/качество|🎧|Обслуживание/, 'средние по признакам в сводке');
  assert.doesNotMatch(html, /aspect_(delivery|service|price)/, 'поля признаков в форме отзыва');
  // Общая оценка и разбивка по звёздам при этом на месте.
  assert.match(html, /rating-big/);
  assert.match(html, /rbar-fill/);

  const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'styles.css'), 'utf8');
  assert.doesNotMatch(css, /\.asp-chip|\.aspect-row|\.aspects\{/, 'остались стили признаков');
});

test('в отзыве видно сборку покупателя и перевозчика, а медиа идёт одной лентой', () => {
  const rv = {
    id: 'r1', author: 'Пётр', rating: 5, text: 'Отлично', status: 'approved', createdAt: 1000,
    config: 'Серебристый · 256 ГБ · Две eSIM', delivery: 'ozon',
    photos: ['a.webp'], videos: ['v.mp4']
  };
  const db = { reviewsForProduct: () => [rv], ratingFor: () => ({ avg: 5, count: 1 }), categories: () => [], visibleCategories: () => [] };
  const product = { id: 'p', name: 'Товар', category: 'Тест', price: 100, inStock: true, images: [] };
  const html = render.productPage({ storeName: 'Тест', currency: '₽' }, db, product, {});

  assert.match(html, /<span class="review-config">Серебристый · 256 ГБ · Две eSIM<\/span>/);
  assert.match(html, /class="rv-ship"[^>]*Доставка: OZON/);
  // Сборка, дата и перевозчик — одной серой строкой, а не тремя рядами: по
  // отдельности они не значат почти ничего, а высоту карточки съедали.
  assert.match(html, /<div class="review-meta"><time[^>]*>[^<]*<\/time><span class="review-sep"/);
  // Логотип берётся из того же спрайта, что и на оформлении, и спрайт на странице есть.
  assert.match(html, /<use href="#dl-ozon">/);
  assert.match(html, /<symbol id="dl-ozon"/);
  // Фото и видео — одной лентой: их листают в общей галерее.
  assert.match(html, /<a class="rv-item rv-video" href="\/uploads\/v\.mp4" data-kind="video" data-i="0"/);
  assert.match(html, /<a class="rv-item rv-photo" href="\/uploads\/a\.webp" data-kind="photo" data-i="1"/);
  assert.match(html, /data-video="1"/);

  // Серым и мелким — это уточнение к отзыву, а не его содержание.
  const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'styles.css'), 'utf8');
  assert.match(css, /\.review-meta\{[^}]*color:var\(--muted\)/);

  // Чужой перевозчик в разметку не попадает: только из закрытого списка.
  const alien = render.reviewCard(Object.assign({}, rv, { delivery: '"><script>' }));
  assert.doesNotMatch(alien, /<script>/);
  assert.doesNotMatch(alien, /rv-ship/);
});

test('покупатель снова может приложить фото к отзыву', () => {
  const db = { reviewsForProduct: () => [], ratingFor: () => ({ avg: 0, count: 0 }), categories: () => [], visibleCategories: () => [] };
  const product = { id: 'p', name: 'Товар', category: 'Тест', price: 100, inStock: true, images: [] };
  const html = render.productPage({ storeName: 'Тест', currency: '₽' }, db, product, {});
  assert.match(html, /<input class="rf-file-input" type="file" id="rv-photos" name="photos" accept="image\/\*" multiple data-max="\d+">/);
  // Подписи «до 6, по желанию» в форме нет: сколько снимков выбрано, пишет
  // public/app.js уже по факту выбора — на месте технической строки браузера.
  assert.doesNotMatch(html, /по желанию/);
  assert.match(html, new RegExp('data-max="' + render.REVIEW_PHOTOS_MAX + '"'));
  const app = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  assert.match(app, /Number\(rvPhotos\.dataset\.max\)/, 'предел в скрипте свой, а должен приезжать из разметки');

  // Предел с витрины свой и меньше панельного: здесь грузит кто угодно, а один
  // файл может весить до 6 МБ. Маршрут обязан его применять, а не верить форме.
  const source = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const route = source.slice(source.indexOf("app.post('/api/reviews'"));
  assert.match(route.slice(0, 1600), /filesFor\('photos'\)\.slice\(0, R\.REVIEW_PHOTOS_MAX\)/);
  // Превью делаем сразу: в ленте показывается оно, полный файл — в просмотрщике.
  assert.match(route.slice(0, 1600), /previews: await reviewPreviews\(photos\)/);
});

test('форма отзыва идёт во всю ширину и четырьмя рядами', () => {
  const db = { reviewsForProduct: () => [], ratingFor: () => ({ avg: 0, count: 0 }), categories: () => [], visibleCategories: () => [] };
  const product = { id: 'p', name: 'Товар', category: 'Тест', price: 100, inStock: true, images: [] };
  const html = render.productPage({ storeName: 'Тест', currency: '₽' }, db, product, {});
  // Оценка и имя рядом, ниже текст, ниже снимки, внизу согласие с кнопкой.
  assert.match(html, /<form id="review-form" class="rf-grid"/);
  for (const cls of ['rf-rate', 'rf-name', 'rf-text', 'rf-photos', 'rf-foot']) {
    assert.ok(html.includes('class="field ' + cls + '"') || html.includes('class="' + cls + '"'), 'нет блока ' + cls);
  }
  // Порядок рядов задаёт разметка, а не только сетка: текст стоит выше фото.
  assert.ok(html.indexOf('rf-text') < html.indexOf('rf-photos'), 'фото поднялось выше текста отзыва');
  assert.ok(html.indexOf('rf-photos') < html.indexOf('rf-foot'), 'согласие и кнопка обязаны быть последними');
  // Подсказок в форме не осталось: ни про согласия «на следующем шаге», ни про
  // предел снимков — их место заняли сама галочка и счётчик выбранных файлов.
  assert.doesNotMatch(html, /следующем шаге/);
  assert.doesNotMatch(html, /form-legal-note/);
  // Слово рядом со звёздами приезжает из разметки, а не из своего списка в app.js
  assert.match(html, /class="rate-star" data-v="5" data-note="Отлично"/);
  assert.match(html, /<span class="rate-note" id="rate-note">Отлично<\/span>/);

  const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'styles.css'), 'utf8');
  // Ширину блок больше ничем не режет: половина страницы пустовала.
  for (const rule of css.match(/\.review-form-wrap\{[^}]*\}/g) || []) {
    assert.equal(/max-width/.test(rule), false, 'у формы отзыва снова появился предел ширины: ' + rule);
  }
  // На телефоне два поля в ряд не встают — там один столбец и широкая кнопка.
  assert.match(css, /@media\(max-width:800px\)\{[^]*\.rf-grid\{grid-template-columns:minmax\(0,1fr\)/);
  assert.match(css, /@media\(max-width:800px\)\{[^]*\.rf-foot\{[^}]*flex-direction:column/);
});

test('в порядке «Новые» лента идёт строго по дате и ничем не переставляется', () => {
  const per = render.REVIEWS_PER_PAGE;
  const list = Array.from({ length: per * 3 }, (_, i) => ({
    id: 'r' + i, author: 'A' + i, rating: 5, status: 'approved', createdAt: 10000 - i, text: 't',
    videos: i % 4 === 3 ? ['v' + i + '.mp4'] : [],
    photos: i % 4 === 1 ? ['p' + i + '.webp'] : []
  }));

  const sorted = render.sortReviews(list, 'new');
  assert.equal(sorted.length, list.length, 'ни один отзыв не потерялся');
  // Ни подъёма вложений, ни раскладки видео: на витрине это сразу видно —
  // отзыв за 8 августа над отзывом за 18-е читается как сбой. Наверх отзывы с
  // фото и видео выводит не сортировка, а раздача дат (lib/review-dates.js).
  assert.deepEqual(sorted.map(r => r.id), list.map(r => r.id));
  const dates = sorted.map(r => r.createdAt);
  assert.deepEqual(dates, dates.slice().sort((a, b) => b - a));

  const byHigh = render.sortReviews(list, 'high');
  assert.equal(byHigh.length, list.length);
  assert.equal(byHigh[0].id, 'r0', 'при равных оценках сверху всё равно самый свежий');
});

test('свежие даты достаются отзывам с фото и видео', () => {
  const dates = require('../lib/review-dates');
  const day = 24 * 60 * 60 * 1000;
  const now = 1000 * day;
  // Даты в источнике: у отзывов с вложениями они самые старые.
  const list = [
    { id: 'a', productId: 'p', sourceDate: 900 * day, createdAt: 900 * day },
    { id: 'b', productId: 'p', sourceDate: 880 * day, createdAt: 880 * day },
    { id: 'c', productId: 'p', sourceDate: 860 * day, createdAt: 860 * day, photos: ['x.webp'] },
    { id: 'd', productId: 'p', sourceDate: 840 * day, createdAt: 840 * day, videos: ['v.mp4'] }
  ];
  const plan = dates.plannedDates(list, now);
  for (const rv of list) if (plan.has(rv.id)) rv.createdAt = plan.get(rv.id);
  const order = list.slice().sort((x, y) => y.createdAt - x.createdAt).map(r => r.id);
  assert.deepEqual(order, ['c', 'd', 'a', 'b'], 'сверху вложения, внутри группы — по исходной дате');
  // Набор дат прежний: меняется только то, кому какая досталась.
  assert.deepEqual(list.map(r => r.createdAt).sort(), [900, 880, 860, 840].map(d => d * day + (now - 900 * day)).sort());
  assert.equal(Math.max.apply(null, list.map(r => r.createdAt)), now, 'самый свежий — сегодняшний');

  // Повторный прогон ничего не меняет: раздача зависит только от исходных дат
  // и вложений, а не от текущего createdAt.
  assert.equal(dates.plannedDates(list, now).size, 0);

  // Даты разных товаров не перемешиваются: у нового iPhone лента начиналась бы
  // датами прошлогодней модели.
  const two = [
    { id: 'x1', productId: 'p1', sourceDate: 900 * day, createdAt: 0 },
    { id: 'x2', productId: 'p2', sourceDate: 500 * day, createdAt: 0, photos: ['y.webp'] }
  ];
  const plan2 = dates.plannedDates(two, now);
  assert.equal(plan2.get('x1'), now);
  assert.equal(plan2.get('x2'), now - 400 * day, 'товар со своей датой её и получил');
});

test('в ленте товара отзывы отбираются по вложениям: видео, фото, без медиа', () => {
  const reviews = [
    { id: 'v1', productId: 'p', author: 'А', rating: 5, text: 'т', status: 'approved', createdAt: 5, videos: ['a.mp4'], photos: ['a.webp'] },
    { id: 'f1', productId: 'p', author: 'Б', rating: 5, text: 'т', status: 'approved', createdAt: 4, photos: ['b.webp'] },
    { id: 'f2', productId: 'p', author: 'В', rating: 4, text: 'т', status: 'pending', createdAt: 3, photos: ['c.webp'] },
    { id: 't1', productId: 'p', author: 'Г', rating: 5, text: 'т', status: 'approved', createdAt: 2 }
  ];
  const db = {
    getReviews: () => reviews, reviewsForProduct: () => reviews,
    getProducts: () => [{ id: 'p', name: 'Товар' }], ratingFor: () => ({ avg: 5, count: 3 }),
    reviewStats: () => new Map(), pendingReviewCount: () => 1
  };
  const product = { id: 'p', name: 'Товар' };
  const ids = html => [...html.matchAll(/id="rv-([a-z0-9]+)"/g)].map(m => m[1]);
  const feed = (media, status) => adminViews.productReviews(SETTINGS, db, product, status || 'all', null, 1, 'new', media);

  // Наборы не пересекаются: отзыв с видео и фотографиями лежит в «С видео»,
  // иначе он попадался бы дважды и счётчики не сходились бы с длиной списка.
  assert.deepEqual(ids(feed('video')), ['v1']);
  assert.deepEqual(ids(feed('photo')), ['f1', 'f2']);
  assert.deepEqual(ids(feed('none')), ['t1']);
  assert.deepEqual(ids(feed('all')).sort(), ['f1', 'f2', 't1', 'v1']);
  assert.deepEqual(ids(feed('мусор')).sort(), ['f1', 'f2', 't1', 'v1'], 'мусор в адресе — это «Все»');

  // Счётчики считаются в пределах открытой вкладки: «С видео 1» на вкладке
  // «На модерации» обещало бы то, чего там нет.
  const pending = feed('all', 'pending');
  assert.match(pending, /media=video"[^>]*>С видео<i>0<\/i>/);
  assert.match(feed('all'), /media=video"[^>]*>С видео<i>1<\/i>/);
  assert.match(feed('all'), /media=none"[^>]*>Без медиа<i>1<\/i>/);

  // Выбранный отбор уезжает в формы действий и в ссылки листалки: разбирая
  // ленту роликов, после каждого «Одобрить» возвращаться во «Все» нельзя.
  assert.match(feed('video'), /name="media" value="video"/);
  assert.match(feed('video'), /href="\/admin\/reviews\/product\/p\?status=all&amp;sort=low&amp;media=video"/);

  // На входе в раздел отбора нет: там очередь модерации и ничего кроме неё.
  const queue = adminViews.reviewsList(SETTINGS, db, null, 1);
  // Именно класс ряда: `data-media` у ленты вложений — это другое.
  assert.equal(/class="a-sorts a-media"/.test(queue), false);
});

test('на телефоне сортировка и вложения прячутся под кнопку, на десктопе стоят открыто', () => {
  const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'styles.css'), 'utf8');
  const reviews = [{ id: 'a1', productId: 'p', status: 'approved', rating: 5, author: 'А', createdAt: 1, photos: [], videos: [] }];
  const db = {
    getReviews: () => reviews, reviewsForProduct: () => reviews,
    getProducts: () => [{ id: 'p', name: 'Товар' }], ratingFor: () => ({ avg: 5, count: 1 }),
    reviewStats: () => new Map(), pendingReviewCount: () => 0
  };
  const feed = (sort, media) => adminViews.productReviews(SETTINGS, db, { id: 'p', name: 'Товар' }, 'all', null, 1, sort, media);
  const html = feed('new', 'all');

  // Переключатель обязан стоять ПЕРЕД рядами: они открываются селектором соседа
  // (~), и перестановка в разметке молча оставила бы кнопку без действия.
  const sw = html.indexOf('id="a-filters-open"');
  const box = html.indexOf('<div class="a-filters">');
  assert.ok(sw > -1 && box > -1 && sw < box, 'чекбокс фильтров должен идти перед рядами');
  assert.match(html, /<label class="a-filters-btn" for="a-filters-open">/);

  // Свёрнутая кнопка называет выбранное, иначе порядок ленты пришлось бы
  // раскрывать. Подписи берутся из тех же таблиц, что и сами кнопки.
  assert.match(html, /<span class="a-filters-now">Новые · Все<\/span>/);
  assert.match(feed('low', 'video'), /<span class="a-filters-now">Низкая оценка · С видео<\/span>/);

  // Вкладки состояния остаются на виду всегда: «что показываем» — первый вопрос
  // к списку, и прятать его за нажатием нельзя.
  assert.ok(html.indexOf('class="a-tabs"') < sw, 'вкладки идут до кнопки фильтров');

  // id не из пространства строк отзыва (`rv-<id>`): туда смотрит и живое
  // обновление панели, и разбор списка в тестах.
  assert.doesNotMatch(html, /id="rv-filters"/);

  // На десктопе обёртка исчезает из раскладки, оба ряда — прямые участники
  // flex-шапки, а кнопки нет вовсе.
  assert.match(css, /\.a-filters\{display:contents\}/);
  assert.match(css, /\.a-filters-switch,\.a-filters-btn\{display:none\}/);
  const mobile = css.slice(css.indexOf('@media(max-width:800px){'));
  assert.match(mobile, /\.a-filters\{display:none\}/);
  assert.match(mobile, /\.a-filters-switch:checked~\.a-filters\{display:block/);

  // Кнопки раздела в шапке — своей обёрткой: без неё их нечем отправить на
  // вторую строку, и заголовок сжимался до одной буквы.
  assert.match(html, /<div class="a-topbar-acts">/);
  assert.match(mobile, /\.a-topbar-acts\{flex:1 0 100%/);
});

test('ролики стоят через один на первых трёх страницах и на последней', () => {
  const dates = require('../lib/review-dates');
  const per = render.REVIEWS_PER_PAGE;
  const now = Date.UTC(2026, 7, 19);
  const make = (n, videos, photos) => Array.from({ length: n }, (_, i) => ({
    id: 'r' + String(i).padStart(4, '0'), productId: 'p', sourceDate: now - i * 36e5,
    videos: i < videos ? ['v' + i + '.mp4'] : [],
    photos: (i >= videos && i < videos + photos) ? ['p' + i + '.webp'] : []
  }));
  const feed = list => {
    const plan = dates.plannedDates(list, now);
    for (const rv of list) if (plan.has(rv.id)) rv.createdAt = plan.get(rv.id);
    return list.slice().sort((a, b) => b.createdAt - a.createdAt);
  };
  const pageOf = i => Math.floor(i / per) + 1;

  // Ролик тяжелее снимка в сотню раз, и держать их по всей ленте — платить за
  // то, чего никто не листает. Поэтому места у них только на первых трёх
  // страницах и на последней, и там через один: сначала отзыв без видео.
  const list = make(100, 14, 30);
  const order = feed(list);
  const pages = Math.ceil(order.length / per);
  const videoAt = order.map((rv, i) => rv.videos.length ? i : -1).filter(i => i >= 0);
  assert.ok(videoAt.length, 'ролики обязаны попасть в ленту');
  for (const i of videoAt) {
    const page = pageOf(i);
    assert.ok(page <= 3 || page === pages, `ролик на странице ${page} — не по раскладке`);
    assert.equal(i % 2, 1, 'ролик обязан стоять через один, а не подряд');
  }
  assert.ok(videoAt.some(i => pageOf(i) === pages), 'последняя страница осталась без роликов');
  assert.equal(order[0].videos.length, 0, 'первым в ленте стоит отзыв без видео');
  // Сразу за роликом — отзыв без него: два видео подряд читаются как заливка.
  for (const i of videoAt) assert.ok(!order[i + 1] || !order[i + 1].videos.length, 'два ролика подряд');

  // Мест ровно столько, сколько берёт импортёр: считает их одна и та же функция.
  assert.equal(dates.videoCapacity(100), dates.videoSlots(100, per).length);
  assert.ok(dates.videoCapacity(100) > 0, 'без размера страницы вместимость обязана считаться');
  assert.ok(dates.videoCapacity(1225) < 20, '36 роликов на товар — это уже стена видео');

  // Роликов больше, чем мест: чередование продолжается на следующих страницах,
  // а не сваливается стеной в хвост.
  const many = feed(make(100, 20, 30));
  const tail = many.slice(-per);
  assert.ok(tail.filter(rv => rv.videos.length).length <= per / 2, 'в хвосте собралась стена видео');
  for (let i = 0; i < many.length - 1; i++) {
    if (many[i].videos.length) assert.ok(!many[i + 1].videos.length, 'два ролика подряд при переливе');
  }

  // Раздача не зависит от порядка записей в файле и от повторного прогона.
  const twice = make(100, 14, 30);
  feed(twice);
  assert.equal(dates.plannedDates(twice, now).size, 0, 'повторный прогон переставляет ленту');

  /* Площадка отдаёт дату с точностью до ДНЯ: у 1225 привезённых отзывов их
   * всего 277, до 25 отзывов с одним значением. Лента сортируется по дате, и
   * внутри такой группы порядок был произвольным — ролики вставали по два
   * подряд вместо «через один». Поэтому назначенные даты обязаны идти строго
   * по убыванию: соседи разводятся на секунду, а показанный день не меняется.
   */
  const day = 24 * 60 * 60 * 1000;
  const coarse = make(100, 14, 30).map((rv, i) => Object.assign(rv, { sourceDate: now - Math.floor(i / 20) * day }));
  const byDay = feed(coarse);
  assert.equal(new Set(byDay.map(r => r.createdAt)).size, byDay.length, 'даты обязаны быть различными');
  for (let i = 0; i < byDay.length - 1; i++) {
    if (byDay[i].videos.length) assert.ok(!byDay[i + 1].videos.length, 'два ролика подряд при датах по дню');
  }
  assert.equal(dates.plannedDates(coarse, now).size, 0, 'повторный прогон снова тасует ленту');
});

test('снимки идут вперемешку с текстом, а недовольные попадаются с первых страниц', () => {
  const dates = require('../lib/review-dates');
  const per = render.REVIEWS_PER_PAGE;
  const now = Date.UTC(2026, 7, 21);
  // Похоже на живой товар: ролики, снимки и текстовые отзывы, низкие оценки
  // лежат в источнике глубоко — при раздаче по дате их не увидит никто.
  const make = (n, videos, photos, low) => Array.from({ length: n }, (_, i) => ({
    id: 'r' + String(i).padStart(4, '0'), productId: 'p', sourceDate: now - i * 36e5,
    rating: low.includes(i) ? 2 : 5,
    videos: i < videos ? ['v' + i + '.mp4'] : [],
    photos: (i >= videos && i < videos + photos) ? ['p' + i + '.webp'] : []
  }));
  const feed = list => {
    const plan = dates.plannedDates(list, now);
    for (const rv of list) if (plan.has(rv.id)) rv.createdAt = plan.get(rv.id);
    return list.slice().sort((a, b) => b.createdAt - a.createdAt);
  };
  const hasMedia = rv => rv.photos.length || rv.videos.length;

  const order = feed(make(221, 14, 100, [40, 90, 150]));
  const pages = Math.ceil(order.length / per);

  /* Снимки раздаются по всей ленте, а не пачкой в начале. Раньше было
   * «сначала все с вложениями, потом все текстовые», и лента разваливалась на
   * две половины: у товара с 221 отзывом четырнадцать страниц подряд со
   * снимком в каждом отзыве и тринадцать подряд вообще без единого. К середине
   * это читается так, будто фотографии кончились.
   */
  for (let p = 1; p <= pages; p++) {
    const page = order.slice((p - 1) * per, p * per);
    assert.ok(page.some(hasMedia), `страница ${p} осталась без единого вложения`);
    assert.ok(page.some(rv => !hasMedia(rv)) || p <= 3,
      `страница ${p} состоит из одних вложений — это уже не вперемешку`);
  }

  // Недовольные: один на первой странице и ещё один на второй-третьей.
  const lowAt = order.map((rv, i) => (rv.rating <= 3 ? i : -1)).filter(i => i >= 0);
  assert.ok(lowAt.some(i => i < per), 'на первой странице ни одной низкой оценки');
  assert.ok(lowAt.some(i => i >= per && i < 3 * per), 'на второй-третьей странице ни одной низкой оценки');
  // Но не подборка жалоб: две подряд в начале читаются хуже, чем ни одной.
  assert.ok(lowAt.filter(i => i < per).length <= 2, 'первая страница завалена низкими оценками');

  // Обмен идёт с отзывом того же состава вложений, поэтому места роликов
  // остаются за роликами, а раскладка медиа не съезжает.
  for (const i of order.map((rv, k) => (rv.videos.length ? k : -1)).filter(i => i >= 0)) {
    const page = Math.floor(i / per) + 1;
    assert.ok(page <= 3 || page === pages, `ролик уехал на страницу ${page}`);
  }

  // Даты по-прежнему строго по убыванию: витрина сортирует именно по ним.
  const when = order.map(r => r.createdAt);
  assert.deepEqual(when, when.slice().sort((a, b) => b - a));

  // Низких оценок нет вовсе — раскладка не должна падать.
  const calm = feed(make(40, 6, 15, []));
  assert.equal(calm.length, 40);
});

test('даты привезённых отзывов сдвигаются к сегодня и сдвиг не накапливается', () => {
  const dates = require('../lib/review-dates');
  const day = 24 * 60 * 60 * 1000;
  const list = [
    { id: 'a', sourceDate: 1000 * day, createdAt: 1000 * day },
    { id: 'b', sourceDate: 990 * day, createdAt: 990 * day },
    { id: 'c', sourceDate: 900 * day, createdAt: 900 * day },
    { id: 'd', createdAt: 5 }                       // обычный отзыв покупателя — не трогаем
  ];
  const now = 1200 * day;
  const plan = dates.plannedDates(list, now);
  assert.equal(plan.get('a'), now, 'самый свежий становится сегодняшним');
  assert.equal(plan.get('b'), now - 10 * day, 'расстояния между отзывами сохраняются');
  assert.equal(plan.get('c'), now - 100 * day);
  assert.ok(!plan.has('d'), 'отзыв без исходной даты не трогается');

  // Повторный прогон в тот же момент ничего не меняет: сдвиг считается от
  // исходной даты, а не от текущей, иначе лента каждый день уезжала бы вперёд.
  for (const rv of list) if (plan.has(rv.id)) rv.createdAt = plan.get(rv.id);
  assert.equal(dates.plannedDates(list, now).size, 0);
  // На следующий день сдвигается ровно на сутки, а не на двое.
  assert.equal(dates.plannedDates(list, now + day).get('a'), now + day);
});

test('видео из отзыва отдаётся и режется по диапазонам байтов', async () => {
  const os = require('os');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'uploads-'));
  const name = 'rv-test.mp4';
  fs.writeFileSync(path.join(dir, name), Buffer.alloc(5000, 7));

  const app = new App({ secret: 'test' });
  app.static('/uploads', dir, { extensions: ['.webp', '.mp4'] });

  // HEAD: заголовки те же, что у GET, но поток в поддельный ответ не пишется.
  const call = async range => {
    const headers = range ? { range } : {};
    const res = response();
    await app.handle(request('/uploads/' + name, { method: 'HEAD', headers }), res);
    return res;
  };

  const whole = await call();
  assert.equal(whole.statusCode, 200);
  assert.equal(whole.headers['content-type'], 'video/mp4');
  // Без этого заголовка плеер даже не попробует запросить кусок.
  assert.equal(whole.headers['accept-ranges'], 'bytes');

  // Safari без поддержки диапазонов не проигрывает <video> вовсе.
  const part = await call('bytes=100-199');
  assert.equal(part.statusCode, 206);
  assert.equal(part.headers['content-range'], 'bytes 100-199/5000');
  assert.equal(part.headers['content-length'], 100);

  assert.equal((await call('bytes=-50')).headers['content-range'], 'bytes 4950-4999/5000');
  assert.equal((await call('bytes=4990-')).headers['content-range'], 'bytes 4990-4999/5000');

  // Запрос за пределами файла — 416, а не пустой ответ с кодом 206.
  const bad = await call('bytes=9000-9100');
  assert.equal(bad.statusCode, 416);
  assert.equal(bad.headers['content-range'], 'bytes */5000');

  // Чужой формат — не повод ломаться: отдаём файл целиком.
  assert.equal((await call('items=1-2')).statusCode, 200);

  // Расширение видео должно быть разрешено и в самой витрине.
  const srv = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.match(srv, /app\.static\('\/uploads'[^)]*'\.mp4'/);

  fs.rmSync(dir, { recursive: true, force: true });
});

test('ночная пересборка демо-отзывов обходит товары с привезёнными', () => {
  // Правило легко потерять при правке скрипта, а цена ошибки высокая: к 1225
  // настоящим отзывам каждую ночь подмешивалось бы 300 синтетических.
  const src = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'demo-reviews.js'), 'utf8');
  assert.match(src, /realReviews\.filter\(review => review && review\.source\)/,
    'товары с привезёнными отзывами должны определяться по полю source');
  assert.match(src, /generateDemoReviews\(demoProducts/,
    'генератор должен получать отфильтрованный список товаров');
  assert.doesNotMatch(src, /generateDemoReviews\(products/,
    'полный список товаров вернул бы демо-отзывы обратно');
});

test('фото и видео отзыва листаются одной галереей', () => {
  const rv = { id: 'r1', author: 'А', rating: 5, text: 't', status: 'approved', createdAt: 1,
    photos: ['p1.webp', 'p2.webp'], videos: ['v1.mp4'] };
  const card = render.reviewCard(rv);

  // Один блок на все вложения, а не отдельные «фото» и «видео»: открыв снимок,
  // посетитель должен долистать до ролика, не закрывая просмотр.
  assert.equal((card.match(/class="review-media"/g) || []).length, 1);
  assert.doesNotMatch(card, /review-photos|review-videos/);
  const order = (card.match(/data-kind="(photo|video)"/g) || []).map(s => s.slice(11, -1));
  assert.deepEqual(order, ['video', 'photo', 'photo'], 'видео идёт первым, нумерация сквозная');

  // Ссылки настоящие: без скрипта клик открывает файл, как раньше.
  assert.match(card, /<a class="rv-item rv-video" href="\/uploads\/v1\.mp4"/);
  assert.match(card, /<a class="rv-item rv-photo" href="\/uploads\/p1\.webp"/);
  // Кадра у ролика нет — тогда кадром служит сам <video>, ломаться тут нельзя.
  assert.match(card, /<video src="\/uploads\/v1\.mp4#t=0\.1" preload="metadata" muted playsinline/);
  assert.match(card, /<span class="rv-play"/);

  // А когда кадр есть — в ленте лёгкая картинка, полный файл только в просмотрщике.
  const light = render.reviewCard(Object.assign({}, rv, {
    previews: { 'v1.mp4': 'v1-p.webp', 'p1.webp': 'p1-t.webp', 'p2.webp': 'p2-t.webp' }
  }));
  assert.match(light, /<img src="\/uploads\/v1-p\.webp"[^>]*loading="lazy"/);
  assert.match(light, /<img src="\/uploads\/p1-t\.webp"/);
  assert.doesNotMatch(light, /<video/, 'при готовом кадре видео в ленте не грузится');
  // Ссылка ведёт на полный файл: его открывает просмотрщик.
  assert.match(light, /href="\/uploads\/v1\.mp4"/);
  assert.match(light, /width="320" height="320"/, 'размеры нужны, чтобы лента не прыгала при загрузке');

  // Просмотрщик живёт отдельным файлом: тот же нужен в панели отзывов, а
  // витринный app.js панель не грузит. Копия разъехалась бы с оригиналом.
  const js = fs.readFileSync(path.join(__dirname, '..', 'public', 'media-lightbox.js'), 'utf8');
  assert.match(js, /e\.key === 'Escape'[^]{0,40}lbClose/, 'Esc обязан закрывать просмотр');
  assert.match(js, /ArrowLeft[^]{0,60}lbGo\(-1\)/, 'стрелки листают');
  // Уходя с кадра, ролик обязан замолчать — иначе звук идёт из закрытого просмотра.
  assert.match(js, /function lbClose\(\)[^]{0,220}pause\(\)/);
  // Разметку он опознаёт по атрибутам, а не по классам витрины: те же атрибуты
  // ставит и панель.
  assert.match(js, /var GROUP = '\[data-media\]'/);
  assert.match(js, /var ITEM = 'a\[data-kind\]'/);
  assert.match(card, /class="review-media" data-media/);
  const app = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  assert.equal(/function lbBuild|initReviewLightbox/.test(app), false, 'второй копии просмотрщика быть не должно');
  // Обе страницы обязаны его подключать — иначе галерея есть только у одной.
  assert.match(fs.readFileSync(path.join(__dirname, '..', 'lib', 'render.js'), 'utf8'), /static\/media-lightbox\.js/);
  assert.match(fs.readFileSync(path.join(__dirname, '..', 'lib', 'admin-views.js'), 'utf8'), /static\/media-lightbox\.js/);

  const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'styles.css'), 'utf8');
  assert.match(css, /body\.lb-open\{overflow:hidden\}/, 'фон под просмотром не должен прокручиваться');
});

test('перевозчик у привезённых отзывов раздан вперемешку, а не по очереди', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'import-ozon-reviews.js'), 'utf8');
  // Чередование в ленте сразу видно и читается как подделка.
  assert.match(src, /createHash\('sha1'\)\.update\(key\)/, 'перевозчик выбирается по хешу отзыва');
  assert.doesNotMatch(src, /index % DELIVERIES\.length|i % 2/, 'раздача по очереди');
  // Название цвета должно быть нашим, а не с площадки.
  assert.match(src, /COLOR_ALIASES/);
  assert.match(src, /ourColors\.some/, 'цвет берётся только тот, что есть у товара');
});

test('товар без единой даты в источнике всё равно попадает под раздачу', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'import-ozon-reviews.js'), 'utf8');

  /* Дату площадка отдаёт не всегда, и бывает, что её нет ни у одного отзыва
   * карточки. Без `sourceDate` отзыв не попадает под раздачу вовсе, то есть
   * мимо него проходит вся раскладка ленты, а сам он получает отметку
   * «сейчас» — тридцать отзывов с одним временем и в случайном порядке.
   */
  assert.match(src, /FALLBACK_DAYS/, 'нет запасного отрезка для карточки совсем без дат');
  assert.doesNotMatch(src, /if \(known\.length\) \{\s*\n\s*const from/,
    'раздача дат снова спрятана под «есть хоть одна дата»');

  /* Ноль — не дата. `Number(null)` даёт НОЛЬ, а ноль конечен, поэтому проверка
   * через `Number.isFinite(Number(v))` пропускала отзыв без даты: он получал
   * `sourceDate: 0`, а дальше выпадал из раздачи, где дата обязана быть больше
   * нуля. Раскладка ленты шла мимо него молча.
   */
  assert.match(src, /function realDate/, 'нет общей проверки «настоящая дата»');
  assert.doesNotMatch(src, /Number\.isFinite\(Number\(rv\.date\)\)/,
    'дата снова проверяется через isFinite — ноль пройдёт');
  assert.doesNotMatch(src, /Number\.isFinite\(Number\(rv\.sourceDate\)\)/,
    'исходная дата снова проверяется через isFinite — ноль пройдёт');

  // И сама проверка обязана считать ноль отсутствием даты.
  const realDate = new Function('value', src.match(/function realDate\(value\) \{[^}]*\}/)[0] + '; return realDate(value);');
  assert.equal(realDate(null), null, 'null принят за дату');
  assert.equal(realDate(0), null, 'ноль принят за дату');
  assert.equal(realDate('нет'), null, 'мусор принят за дату');
  assert.equal(realDate(1755000000000), 1755000000000, 'настоящая дата отвергнута');

  // Отрезок обязан кончаться сегодня и быть непустым.
  const days = Number(String(src.match(/FALLBACK_DAYS = (\d+)/)[1]));
  assert.ok(days > 0 && days <= 400, 'запасной отрезок должен быть в пределах года');

  // Сама выдумка даты — детерминированная: иначе отзыв прыгал бы по ленте
  // при каждом прогоне.
  const dates = require('../lib/review-dates');
  const rv = { id: 'r1', author: 'Кто-то' };
  assert.equal(dates.inventDate(rv, 1000, 2000), dates.inventDate(rv, 1000, 2000));
});

test('аватарка профиля не попадает в фото отзыва', () => {
  const file = path.join(__dirname, '..', 'scripts', 'import-ozon-reviews.js');
  const src = fs.readFileSync(file, 'utf8');

  // Площадка держит портреты покупателей на тех же хостах, что и снимки
  // отзывов, поэтому пакету верить на слово нельзя — то же правило, что у цены
  // заказа. Отличается аватарка только путём в адресе.
  assert.match(src, /AVATAR_RE/, 'нет отсева аватарок');
  assert.match(src, /fs-my-account-avatar/, 'не узнаётся путь аватарки Ozon');
  // Скачивание идёт по отфильтрованному списку, а не по сырому полю пакета.
  assert.match(src, /for \(const url of realPhotos\(rv\)/,
    'фото качаются мимо отсева аватарок');
  assert.doesNotMatch(src, /for \(const url of \(rv\.photos \|\| \[\]\)/,
    'остался проход по сырому списку фотографий');

  // Сама регулярка обязана отличать портрет от снимка отзыва.
  const re = new RegExp(String(src.match(/const AVATAR_RE = (\/.+?\/i);/)[1]).slice(1, -2), 'i');
  assert.ok(re.test('https://cdn1.ozonusercontent.com/s3/fs-my-account-avatar/Huush4S6.jpg'),
    'аватарка не распознана');
  assert.ok(!re.test('https://ir.ozone.ru/s3/rp-photo-14/3b25d4bf-54fb-4782.jpeg'),
    'снимок отзыва принят за аватарку');
  assert.ok(!re.test('https://ir.ozone.ru/s3/video-73/01KZ6HC0/cover/wc500/cover.jpg'),
    'обложка ролика принята за аватарку');
});

test('медиа не отдаётся в один клик и просмотрщик собран иконками', () => {
  const app = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  const js = fs.readFileSync(path.join(__dirname, '..', 'public', 'media-lightbox.js'), 'utf8');
  const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'styles.css'), 'utf8');

  // Перетаскивание и правая кнопка на картинках и видео перехватываются.
  assert.match(app, /initMediaGuard\(\);/);
  assert.match(app, /'contextmenu'[^]{0,200}preventDefault/);
  assert.match(app, /'dragstart'[^]{0,200}preventDefault/);
  // У плеера не должно быть кнопки скачивания.
  assert.match(js, /controlsList[^]{0,30}nodownload/);

  // Иконки — SVG. Текстовые глифы (× ‹ ›) берутся из системного шрифта, сидят
  // в круге по-разному и выглядят криво — из-за этого кнопки и были кривыми.
  assert.doesNotMatch(js, /&times;|&#8249;|&#8250;/, 'текстовые глифы в кнопках просмотрщика');
  assert.match(js, /<svg viewBox="0 0 24 24"/);
  assert.match(css, /\.lb-btn\{[^}]*place-items:center/, 'иконка обязана стоять по центру кнопки');

  // На телефоне стрелки уходят вниз и становятся крупнее: поверх кадра по ним
  // не попасть пальцем, а сам кадр они закрывают.
  assert.match(css, /@media\(max-width:640px\)\{[^]*\.lb-btn\{width:48px/);

  // Высота строки сетки задана ЯВНО. На auto она растягивается под натуральный
  // размер снимка: max-height:100% перестаёт действовать, высокое фото уезжает
  // за нижний край, а стрелки — центрированные в переросшей строке — сползают
  // вниз. Ровно это и было видно на боевой витрине.
  assert.match(css, /\.lb\{[^}]*grid-template-rows:minmax\(0,1fr\)/,
    'строка сетки просмотрщика обязана быть minmax(0,1fr), а не auto');
  assert.match(css, /\.lb-stage\{[^}]*min-height:0/,
    'без min-height:0 элемент сетки не может стать меньше содержимого');
  assert.match(css, /@media\(max-width:640px\)\{[^]*grid-template-rows:minmax\(0,1fr\) auto/);
  assert.match(css, /\.lb-media\{[^}]*max-height:100%/);
});

/* ==================================================================== *
 * Регрессии аудита: подмена адреса посетителя, экранирование id товара,
 * долговечность записи хранилища.
 * ==================================================================== */

const clientIp = require('../lib/client-ip');

// Дыра, которую это закрывает: прокси ДОПИСЫВАЕТ адрес посетителя в конец
// `X-Forwarded-For`, а код брал первый элемент. Клиент подставлял себе любой
// «IP» и подбирал пароль к панели без единой блокировки.
test('адрес посетителя берётся из ПРАВОГО хвоста X-Forwarded-For', () => {
  const headers = { 'x-forwarded-for': '8.8.8.8, 203.0.113.7' };
  assert.equal(clientIp.forwardedValue(headers, 'x-forwarded-for', 1), '203.0.113.7',
    'при одном прокси доверяем последнему элементу — его дописал он сам');

  // Меняя левую часть, клиент не должен получать разные личности.
  const seen = new Set();
  for (let i = 1; i <= 5; i++) {
    seen.add(clientIp.clientIpFrom(
      { headers: { 'x-forwarded-for': `8.8.8.${i}, 203.0.113.7` }, socket: { remoteAddress: '127.0.0.1' } },
      { trusted: true, hops: 1 }
    ));
  }
  assert.deepEqual([...seen], ['203.0.113.7'], 'подмена левой части XFF меняла личность посетителя');

  // Две ступени прокси — берём предпоследний, дописанный внешним из своих.
  assert.equal(clientIp.forwardedValue({ 'x-forwarded-for': 'fake, 203.0.113.7, 10.0.0.2' }, 'x-forwarded-for', 2),
    '203.0.113.7');
  // Цепочка короче объявленной — свои хопы её не дописали, верить нечему.
  assert.equal(clientIp.forwardedValue({ 'x-forwarded-for': '8.8.8.8' }, 'x-forwarded-for', 2), '');
  // Заголовок с одним значением при одном хопе читается как прежде.
  assert.equal(clientIp.forwardedValue({ 'x-forwarded-host': 'shop.example' }, 'x-forwarded-host', 1), 'shop.example');
});

// CF-Connecting-IP наш прокси не ставит вовсе: за Caddy он целиком приходит от
// посетителя. Раньше он стоял в списке ПЕРВЫМ и полностью отдавал выбор «своего
// IP» клиенту — этого хватало, чтобы обойти счётчик попыток входа.
test('заголовки Cloudflare не читаются, пока за Cloudflare реально не стоим', () => {
  const req = {
    headers: { 'cf-connecting-ip': '9.9.9.9', 'x-real-ip': '5.5.5.5', 'x-forwarded-for': '203.0.113.7' },
    socket: { remoteAddress: '127.0.0.1' }
  };
  assert.equal(clientIp.clientIpFrom(req, { trusted: true, hops: 1 }), '203.0.113.7',
    'CF-Connecting-IP и X-Real-IP по умолчанию доверять нельзя');
  assert.equal(clientIp.clientIpFrom(req, { trusted: true, hops: 1, cloudflare: true }), '9.9.9.9',
    'за настоящим Cloudflare его заголовок обязан работать');
  assert.equal(clientIp.clientIpFrom(req, { trusted: false, hops: 1 }), '127.0.0.1',
    'без доверенного прокси остаётся только адрес сокета');
  assert.equal(clientIp.clientIpFrom({ headers: {}, socket: {} }, { trusted: true, hops: 1 }), '?');
});

// То же правило — в самом server.js: geo-заголовки Cloudflare задают городу и
// стране заказа значение, и посетитель не должен выбирать их себе сам.
test('server.js не доверяет forwarded-заголовкам напрямую', () => {
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.doesNotMatch(server, /x-forwarded-for'\s*\]\s*\|\|\s*''\s*\)\s*\.split\(','\)\[0\]/,
    'X-Forwarded-For снова читается слева — это возвращает обход лимита попыток входа');
  // Единственное обращение к cf-* в маршрутах идёт через cloudflareTrusted().
  assert.doesNotMatch(server, /trustedProxy\(req\)\s*\?\s*String\(req\.headers\['cf-/,
    'заголовок Cloudflare снова читается по одному лишь доверию прокси');
  for (const call of server.match(/metrics\.context\(req, clientIp\(req\), [^)]*\)/g) || []) {
    assert.match(call, /cloudflareTrusted\(req\)/,
      'geo-заголовки метрики обязаны требовать настоящего Cloudflare: ' + call);
  }
});

// id товара уезжает в атрибуты (`data-id`, `action`, `href`). Сейчас он всегда
// слаг, но проверяет это одна функция в хранилище: любой другой путь записи
// (ручная правка JSON, будущий скрипт переноса) превращал бы его в XSS.
test('id товара экранируется в разметке витрины и панели', () => {
  const evil = '"><script>alert(1)</script><x y="';
  const product = {
    id: evil, name: 'Товар', category: 'iPhone', price: 5000, inStock: true, visible: true,
    shortDesc: '', description: '', specs: '', colors: [], storages: [], bands: [], options: [],
    images: [], imageColors: {}, imageBands: {}
  };
  const db = {
    visibleProducts: () => [product], getProducts: () => [product], visibleCategories: () => [],
    categories: () => ['iPhone'], getProduct: () => product, visibleProduct: () => product,
    ratingFor: () => ({ count: 0, sum: 0 }), reviewsForProduct: () => [], getReviews: () => [],
    reviewStats: () => new Map(), pendingReviewCount: () => 0, isVisible: () => true
  };
  const pages = {
    'главная': render.homePage(SETTINGS, db, { origin: 'http://x', categories: [] }),
    'страница товара': render.productPage(SETTINGS, db, product, { origin: 'http://x', categories: [] }),
    'каталог панели': adminViews.productsList(SETTINGS, db, ''),
    'форма товара': adminViews.productForm(SETTINGS, db, product, {})
  };
  for (const [name, html] of Object.entries(pages)) {
    assert.doesNotMatch(html, /<script>alert\(1\)<\/script>/, 'id товара попал в разметку без экранирования: ' + name);
  }
});

// Одного rename мало: он не обещает, что содержимое временного файла дошло до
// диска раньше самой записи о переименовании. При потере питания на месте
// orders.json оказывался бы пустой файл — счёт у покупателя есть, заказа нет.
test('запись хранилища идёт через fsync и не оставляет временных файлов', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'lib', 'db.js'), 'utf8');
  const body = source.slice(source.indexOf('function writeJson('), source.indexOf('function exists('));
  assert.match(body, /fsyncQuiet\(fd\)/, 'содержимое обязано попасть на диск ДО переименования');
  assert.ok(body.indexOf('fsyncQuiet(fd)') < body.indexOf('renameSync'), 'fsync стоит после переименования — это не защищает ни от чего');
  assert.match(body, /openSync\(DATA_DIR/, 'запись каталога о новом имени тоже должна пережить сбой питания');
  assert.match(body, /unlinkSync\(tmp\)/, 'недописанный временный файл не должен оставаться рядом с данными');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'store-write-'));
  const store = freshDb(dir);
  const product = store.createProduct({ name: 'Проверка записи', category: 'iPhone', price: 1000 });
  assert.ok(product.id);
  const saved = JSON.parse(fs.readFileSync(path.join(dir, 'products.json'), 'utf8'));
  assert.equal(saved.length, 1, 'файл обязан содержать записанный товар целиком');
  assert.deepEqual(fs.readdirSync(dir).filter(f => f.endsWith('.tmp')), [], 'временные файлы после записи не остаются');
  fs.rmSync(dir, { recursive: true, force: true });
});

/* ===================== Живые обновления панели ============================
 *
 * Панель смотрит на то, что меняется само: приходят заказы, кассы двигают их
 * состояние, посетители ходят по витрине. Раньше всё это появлялось только по
 * F5, а на «Метрике» ради этого стояла кнопка «Обновить» — то есть работу за нас
 * делал человек.
 */

// Подписчик SSE: тот же объект ответа, что видит lib/live.js, только всё
// записанное складывается в массив сообщений.
function liveClient() {
  const closers = [];
  return {
    chunks: [], headers: null, statusCode: null,
    writeHead(code, headers) { this.statusCode = code; this.headers = headers; },
    write(chunk) { this.chunks.push(String(chunk)); return true; },
    end() { this.ended = true; },
    on(event, fn) { if (event === 'close') closers.push(fn); },
    close() { for (const fn of closers) fn(); },
    // Только строки данных: комментарии-пинги и `retry:` к содержимому не относятся.
    messages() {
      return this.chunks.filter(c => c.startsWith('data: ')).map(c => JSON.parse(c.slice(6)));
    }
  };
}

function liveWait(client, count, live) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const timer = setInterval(() => {
      if (client.messages().length >= count) { clearInterval(timer); return resolve(client.messages()); }
      if (Date.now() - started > live.POLL_MS * 6) { clearInterval(timer); reject(new Error('сообщение так и не пришло')); }
    }, 50);
  });
}

test('живой канал панели: файл изменился — подписчику этой темы уходит новый номер версии', async () => {
  // Свой экземпляр модуля: он держит общий набор подписчиков на процесс, и
  // соседние тесты не должны видеть чужих клиентов.
  const key = require.resolve('../lib/live');
  delete require.cache[key];
  const live = require('../lib/live');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'store-live-'));
  live.watch(dir);
  fs.writeFileSync(path.join(dir, 'orders.json'), '[]');
  fs.writeFileSync(path.join(dir, 'reviews.json'), '[]');

  const onOrders = liveClient();
  const onReviews = liveClient();
  live.subscribe({ socket: {} }, onOrders, 'orders');
  live.subscribe({ socket: {} }, onReviews, 'reviews');

  // Заголовки обязаны говорить «поток», и никакой прокси не должен его копить:
  // иначе «живое обновление» приходило бы пачками через минуту.
  assert.equal(onOrders.statusCode, 200);
  assert.match(onOrders.headers['Content-Type'], /text\/event-stream/);
  assert.match(onOrders.headers['Cache-Control'], /no-transform/);

  // Первое сообщение — отсчётная точка: страницу браузер только что получил
  // свежей и перерисовывать её незачем.
  assert.deepEqual(Object.keys(onOrders.messages()[0]), ['orders']);
  const first = onOrders.messages()[0].orders;

  fs.writeFileSync(path.join(dir, 'orders.json'), '[{"id":"o1"}]');
  const got = await liveWait(onOrders, 2, live);
  assert.ok(got[1].orders > first, 'номер версии заказов обязан вырасти');
  // Чужая тема молчит: перерисовывать страницу отзывов из-за нового заказа
  // незачем, а лишний перезапрос страницы — это лишний рендер на сервере.
  assert.equal(onReviews.messages().length, 1, 'подписчику отзывов заказ не касается');

  // Метрика лежит в памяти и на диск уходит раз в полминуты — про её изменение
  // сообщает сам модуль метрики.
  const onMetrics = liveClient();
  live.subscribe({ socket: {} }, onMetrics, 'analytics');
  live.bump('analytics');
  const metric = await liveWait(onMetrics, 2, live);
  assert.ok(metric[1].analytics > metric[0].analytics);

  // Темы приходят строкой из адреса запроса, поэтому список закрытый.
  const junk = liveClient();
  live.subscribe({ socket: {} }, junk, 'orders,<script>,выдумка');
  assert.deepEqual(Object.keys(junk.messages()[0]), ['orders'], 'чужое слово в подписку не попадает');

  // Новая вкладка не должна проглатывать чужое накопленное изменение: она
  // сверяет файлы, чтобы не получить «изменилось всё» первым же сообщением, —
  // но соседняя вкладка, открытая раньше, своё обновление обязана получить.
  const before = onOrders.messages().length;
  fs.writeFileSync(path.join(dir, 'orders.json'), '[{"id":"o1"},{"id":"o2"}]');
  const late = liveClient();
  live.subscribe({ socket: {} }, late, 'orders');
  await liveWait(onOrders, before + 1, live);

  for (const c of [onOrders, onReviews, onMetrics, junk, late]) c.close();
  assert.equal(live.clientCount(), 0, 'закрытая вкладка не должна оставаться в списке');
  fs.rmSync(dir, { recursive: true, force: true });
  delete require.cache[key];
});

test('живое обновление рисуется сервером, а страницы правки его не грузят', () => {
  const script = fs.readFileSync(path.join(__dirname, '..', 'public', 'admin-live.js'), 'utf8');

  // Главное правило: разметку рисует сервер и только он. Второй рендер в
  // браузере разъехался бы с серверным на первой же правке, а увидеть это можно
  // было бы только глазами.
  assert.doesNotMatch(script, /<(tr|td|li|article|section)\b/i, 'разметки строк в скрипте быть не должно');
  // Сравнивать innerHTML можно (это дешёвая проверка «а изменилось ли вообще»),
  // а присваивать — нет: сплошная замена сбрасывает всё, чем владеет человек.
  assert.doesNotMatch(script, /innerHTML\s*=[^=]/, 'сплошная замена сбрасывает всё, чем владеет человек');
  // Состояние, которым владеет человек: раскрытая свёртка, отмеченная галочка,
  // набранный текст. Ответ сервера его отменять не вправе.
  assert.match(script, /ownedByUser/);
  assert.match(script, /'open' && el\.tagName === 'DETAILS'/);

  const db = {
    getProducts: () => [], visibleProducts: () => [], visibleOrders: () => [], getOrders: () => [],
    getReviews: () => [], reviewStats: () => new Map(), pendingReviewCount: () => 0,
    categories: () => [], visibleCategories: () => [], ratingFor: () => ({ avg: 0, count: 0 })
  };
  // Разделы, которые меняются сами, обязаны подписываться — и оба блока панели
  // обязаны быть размечены. Перечислять блоки по разделам значило бы забыть
  // один и молча остаться без обновлений именно там.
  for (const html of [adminViews.dashboard(SETTINGS, db), adminViews.ordersList(SETTINGS, db, null, 1),
    adminViews.reviewsList(SETTINGS, db, null, 1)]) {
    assert.match(html, /<body class="admin" data-live="/);
    assert.match(html, /data-live-part="topbar"/);
    assert.match(html, /data-live-part="content"/);
    assert.match(html, /admin-live\.js/);
  }
  // А формы правки — не обязаны и не должны: подмена под руками стирала бы
  // набранное. Скрипт туда не приезжает вовсе.
  for (const html of [adminViews.productForm(SETTINGS, db, null), adminViews.settingsPage(SETTINGS, db)]) {
    assert.doesNotMatch(html, /admin-live\.js/, 'форму правки обновлять из-под руки нельзя');
    assert.doesNotMatch(html, /<body class="admin" data-live=/);
  }

  // Отсчёт у строк, приехавших живым обновлением, обязан идти так же: список
  // ищется заново на каждом такте, а не запоминается при загрузке страницы.
  const ui = fs.readFileSync(path.join(__dirname, '..', 'public', 'admin-ui.js'), 'utf8');
  const ticker = ui.slice(ui.indexOf('function tick()'));
  assert.match(ticker, /document\.querySelectorAll\('\.o-left\[data-pay-until\]'\)/);
});
