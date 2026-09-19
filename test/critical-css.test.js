'use strict';
/* Критические стили витрины: `public/critical/<вид>.css` — правила первого
 * экрана, которые `layout()` инлайнит в <head> на посадочном заходе, чтобы
 * отрисовка не ждала запроса за styles.css. Собирает их живой браузер
 * (`scripts/build-critical-css.js`), а сторожат тесты ниже: каждое правило
 * файла обязано ЕЩЁ БЫТЬ в styles.css слово в слово (правка стиля без
 * пересборки — устаревшее правило, и первый кадр разошёлся бы с полным),
 * а макет обязан инлайнить набор ровно там, где обещано, и грузить полный
 * файл без блокировки. Чего тест НЕ ловит: новое правило первого экрана,
 * не попавшее в набор, — это видно только браузеру, поэтому правка
 * styles.css кончается `npm run css:critical`. */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const RULES = require('../lib/css-rules');
const MIN = require('../lib/minify');
const render = require('../lib/render');
const dbCore = require('../lib/db');
const catalog = require('../catalog');

const ROOT = path.join(__dirname, '..');
const STYLES = fs.readFileSync(path.join(ROOT, 'public', 'styles.css'), 'utf8');
const FULL = RULES.flatten(RULES.parse(STYLES));
const FULL_KEYS = new Set(FULL.map(RULES.leafKey));

const DB = {
  getProducts: () => catalog.products,
  visibleProducts: () => catalog.products.filter(p => p.visible !== false),
  visibleProduct: (id) => DB.visibleProducts().find(p => p.id === id) || null,
  categories: () => [...new Set(catalog.products.map(p => p.category))],
  visibleCategories: () => [...new Set(DB.visibleProducts().map(p => p.category))],
  ratingFor: () => ({ avg: 4.7, count: 300 }),
  reviewsForProduct: () => []
};

test('css-rules: правила, вложенные блоки, непрозрачные @-правила, строки и скобки', () => {
  const tree = RULES.parse(`
    /* комментарий { с фигурной } */
    @import url(x.css);
    a{color:red}
    .x::before{content:"}"} .y{background:url(a.png)}
    @media (max-width:800px){ .a,.b{margin:0} @supports (color:red){ .c{color:red} } }
    @keyframes spin{from{transform:none}to{transform:rotate(1turn)}}
    :is(.p, .q) .r{x:1}
  `);
  assert.deepStrictEqual(tree.map(n => n.type), ['stmt', 'rule', 'rule', 'rule', 'at', 'raw', 'rule']);
  assert.equal(tree[2].body, 'content:"}"', 'фигурная скобка внутри строки — не граница блока');
  assert.equal(tree[4].rules[1].type, 'at');
  assert.equal(tree[4].rules[1].rules[0].text, '.c{color:red}');
  assert.equal(tree[5].name, 'keyframes');
  assert.match(tree[5].text, /^@keyframes spin\{from\{/);
  assert.deepStrictEqual(RULES.splitSelectors(':is(.p, .q) .r, .s[data-x="a,b"]'), [':is(.p, .q) .r', '.s[data-x="a,b"]'],
    'запятая внутри скобок и атрибута не делит список селекторов');
  const flat = RULES.flatten(tree);
  assert.equal(flat.length, 8);
  assert.equal(RULES.leafKey(flat[5]), '@media (max-width:800px)\n@supports (color:red)\n.c{color:red}');
  // Разбор устойчив к своей же записи и к повторной чистке.
  assert.deepStrictEqual(RULES.flatten(RULES.parse(RULES.stringify(tree))).map(RULES.leafKey), flat.map(RULES.leafKey));
});

test('styles.css разбирается целиком: ни одного «утверждения» вне блока (хвост комментария снаружи /* */ выбрасывал бы соседнее правило)', () => {
  const stray = FULL.filter(l => l.node.type === 'stmt').map(l => l.node.text);
  assert.deepStrictEqual(stray, [], 'текст вне правил: ' + stray.join(' | '));
  assert.ok(FULL.some(l => l.node.selector === '.legal-section .legal-note p'), 'правило после починенного комментария на месте');
});

/* Что обязано быть в каждом наборе: без этих правил первый кадр не тот.
 * Счётчик корзины с `[hidden]` — та самая ловушка: без него `display:flex`
 * показал бы «0» в шапке до прихода полного файла. */
const ANCHORS = {
  home: [':root', 'body.storefront', '.site-header', '.nav-wrap', '.nav-panel', '.cart-badge[hidden]', '.tabbar', '.store-hero', '.cat-grid', '.cat-tile-media', '.card-media'],
  catalog: [':root', '.site-header', '.nav-wrap', '.cart-badge[hidden]', '.tabbar', '.cat-row', '.grid', '.card', '.card-price'],
  product: [':root', '.site-header', '.nav-wrap', '.cart-badge[hidden]', '.tabbar', '.product-gallery', '.swatch', '.storage-opt', '.option-opt', '.band-tab', '.buy-row', '.btn-primary', '.trust']
};

test('критические стили: у каждого вида страниц свой файл, каждое правило — правило styles.css в том же порядке и с той же обёрткой', () => {
  for (const kind of render.CRITICAL_KINDS) {
    const file = path.join(ROOT, 'public', 'critical', kind + '.css');
    assert.ok(fs.existsSync(file), `нет public/critical/${kind}.css — соберите: npm run css:critical`);
    const text = fs.readFileSync(file, 'utf8');
    const leaves = RULES.flatten(RULES.parse(text));
    assert.ok(leaves.length > 100, `${kind}: правил подозрительно мало (${leaves.length})`);
    const stale = leaves.filter(l => !FULL_KEYS.has(RULES.leafKey(l)));
    assert.deepStrictEqual(stale.map(l => (l.chain.map(a => a.prelude).join(' ') + ' ' + l.node.text).slice(0, 120)), [],
      `${kind}: правил нет в styles.css (устарели после правки стилей) — прогоните npm run css:critical`);
    // Порядок исходника сохранён: каскад инлайна обязан совпадать с каскадом
    // полного файла, иначе до его прихода побеждало бы другое правило. Ищется
    // курсором: одно и то же правило в styles.css встречается и дважды.
    let cursor = 0;
    for (const l of leaves) {
      const key = RULES.leafKey(l);
      while (cursor < FULL.length && RULES.leafKey(FULL[cursor]) !== key) cursor++;
      assert.ok(cursor < FULL.length, `${kind}: порядок правил разошёлся с styles.css у «${l.node.text.slice(0, 60)}»`);
      cursor++;
    }
    // Размер: набор — седьмая-пятая часть файла, не его копия.
    const size = MIN.css(text).length;
    assert.ok(size < 40000, `${kind}: ${size} байт — это уже не критические стили, а весь файл`);
    const selectors = leaves.map(l => l.node.selector || '').join('\n');
    for (const a of ANCHORS[kind]) assert.ok(selectors.includes(a), `${kind}: в наборе нет правила для ${a}`);
    // Анимация без своих @keyframes до прихода полного файла — не анимация.
    const names = new Set();
    for (const l of leaves) if (l.node.type === 'rule') for (const m of l.node.body.matchAll(/animation(?:-name)?\s*:([^;]+)/g)) {
      for (const w of m[1].split(/[\s,]+/)) if (/^[a-zA-Z_][\w-]*$/.test(w) && !/^(none|linear|infinite|ease|forwards|both|alternate|paused|running|normal|reverse|ease-in|ease-out|ease-in-out|backwards|step-start|step-end|inherit|initial|unset)$/.test(w)) names.add(w);
    }
    const frames = new Set(leaves.filter(l => l.node.type === 'raw' && /keyframes$/.test(l.node.name)).map(l => l.node.prelude.split(/\s+/).pop()));
    for (const n of names) assert.ok(frames.has(n), `${kind}: у анимации ${n} нет @keyframes в наборе`);
    // Инлайн закрывать тег не должен.
    assert.doesNotMatch(text, /<\/style/i);
  }
});

test('макет: посадочный заход инлайнит набор и грузит styles.css без блокировки; переход со своей страницы и страница без набора — обычная ссылка', () => {
  const settings = dbCore.defaultSettings();
  const landing = render.homePage(settings, DB, { origin: 'https://shop.example', landing: true });
  const head = landing.slice(0, landing.indexOf('</head>'));
  // Подпись инлайна — первое правило styles.css (с пробелом после `;`, как в
  // файле); настроечный `:root{--accent:…;--accent-deep:…}` пишется без него.
  const INLINE = '<style>:root{--accent:#0071e3; --bg:#ffffff;';
  assert.ok(head.includes(INLINE), 'критические стили стоят инлайном в <head>');
  assert.match(head, /<link rel="preload" href="\/static\/styles\.css\?v=[^"]+" as="style" fetchpriority="low" onload="this\.onload=null;this\.rel='stylesheet'">/,
    'полный файл едет preload с низким приоритетом и подключается по загрузке');
  assert.match(head, /<noscript><link rel="stylesheet" href="\/static\/styles\.css\?v=[^"]+"><\/noscript>/, 'без скриптов — обычная ссылка');
  const blocking = /<link rel="stylesheet" href="\/static\/styles\.css[^>]*>(?!<\/noscript>)/;
  assert.doesNotMatch(head, blocking, 'блокирующей ссылки на styles.css вне <noscript> быть не должно');
  // Инлайн стоит РАНЬШЕ настроечного :root с акцентом: тот обязан побеждать.
  assert.ok(head.indexOf(INLINE) < head.indexOf('--accent-deep:'), 'настроечный акцент стоит после критических стилей');
  // Инлайн — ровно файл набора, минифицированный той же чисткой.
  const expected = MIN.css(MIN.css(fs.readFileSync(path.join(ROOT, 'public', 'critical', 'home.css'), 'utf8'))).trim();
  assert.ok(head.includes('<style>' + expected + '</style>'), 'инлайн главной — это critical/home.css');

  // Со своей же страницы (Sec-Fetch-Site: same-origin) — файл в кэше, инлайн лишний.
  const inner = render.homePage(settings, DB, { origin: 'https://shop.example', landing: false });
  const innerHead = inner.slice(0, inner.indexOf('</head>'));
  assert.match(innerHead, blocking, 'переход со своей страницы грузит стили обычной ссылкой');
  assert.doesNotMatch(innerHead, /rel="preload"/);
  assert.ok(!innerHead.includes(INLINE), 'со своей страницы инлайна нет');

  // Без признака (тесты, старые вызовы) — прежняя ссылка: быстрый путь
  // включает только сервер, знающий заголовок запроса.
  assert.doesNotMatch(render.homePage(settings, DB, { origin: 'https://shop.example' }), /rel="preload"/);

  // Каталог и товар — свои наборы, оформление — обычная ссылка (набора нет).
  const cat = render.catalogPage(settings, DB, { origin: 'https://shop.example', landing: true });
  assert.ok(cat.includes('<style>' + MIN.css(MIN.css(fs.readFileSync(path.join(ROOT, 'public', 'critical', 'catalog.css'), 'utf8'))).trim() + '</style>'), 'каталог инлайнит critical/catalog.css');
  const product = DB.visibleProducts().find(p => /^iphone-17-pro/.test(p.id));
  const pp = render.productPage(settings, DB, product, { origin: 'https://shop.example', landing: true });
  assert.ok(pp.includes('<style>' + MIN.css(MIN.css(fs.readFileSync(path.join(ROOT, 'public', 'critical', 'product.css'), 'utf8'))).trim() + '</style>'), 'товар инлайнит critical/product.css');
  assert.equal(render.criticalKind({ tab: 'cart', landing: true }), '');
  assert.equal(render.criticalKind({ tab: 'home' }), 'home');
  assert.equal(render.criticalKind({ productPage: true, tab: 'catalog' }), 'product');
  assert.match(render.stylesTag({ tab: 'cart', landing: true }), /^<link rel="stylesheet" href="\/static\/styles\.css\?v=[^"]+">$/);
});

test('генератор и макет перечисляют одни и те же виды страниц, посадочный заход считается по Sec-Fetch-Site, а команда есть в package.json', () => {
  const script = fs.readFileSync(path.join(ROOT, 'scripts', 'build-critical-css.js'), 'utf8');
  for (const kind of render.CRITICAL_KINDS) assert.match(script, new RegExp('^    ' + kind + ': \\[', 'm'), `в генераторе нет набора ${kind}`);
  const kindsInScript = script.slice(script.indexOf('function kinds('), script.indexOf('}', script.indexOf('return {', script.indexOf('function kinds(')))).match(/^    (\w+): \[/gm).map(s => s.trim().replace(/: \[$/, ''));
  assert.deepStrictEqual(kindsInScript, render.CRITICAL_KINDS);
  const server = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  assert.match(server, /landing: String\(req\.headers\['sec-fetch-site'\] \|\| ''\)\.toLowerCase\(\) !== 'same-origin'/, 'pageOpts решает посадочный заход по Sec-Fetch-Site');
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert.equal(pkg.scripts['css:critical'], 'node scripts/build-critical-css.js');
});
