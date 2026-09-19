'use strict';
/* Нижняя панель разделов на телефоне (снята с i-store.by) и разделение
 * главной и каталога на две страницы — 18 сентября 2026.
 *
 * Панель проверяется числами, снятыми с их живой мобильной версии, а страницы —
 * разметкой: у главной нет сетки всего каталога, у каталога нет первого экрана,
 * а прежние адреса `/?category=` и `/?q=` уводятся на `/catalog`.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const R = require('../lib/render');
const dbCore = require('../lib/db');
const catalog = require('../catalog');
const CI = require('../lib/client-icons');

const ROOT = path.join(__dirname, '..');
const css = fs.readFileSync(path.join(ROOT, 'public', 'styles.css'), 'utf8');
const app = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');
const chat = fs.readFileSync(path.join(ROOT, 'public', 'chat.js'), 'utf8');
const server = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');

const products = catalog.products.filter(p => p.visible !== false);
const DB = {
  UPLOAD_DIR: path.join(ROOT, 'data', 'uploads'),
  getProducts: () => catalog.products,
  visibleProducts: () => products,
  visibleProduct: id => products.find(p => p.id === id) || null,
  categories: () => [...new Set(catalog.products.map(p => p.category))],
  visibleCategories: () => [...new Set(products.map(p => p.category))],
  ratingFor: id => ({ avg: 4.7, count: id === 'iphone-17' ? 900 : 10 }),
  reviewsForProduct: () => []
};
const SETTINGS = Object.assign(dbCore.defaultSettings(), { chatEnabled: true, aiApiKey: 'sk-test', accountsOn: true });
const OFF = Object.assign(dbCore.defaultSettings(), { chatEnabled: false, accountsOn: false });

// Мобильный блок стилей вырезается по первому такому медиазапросу — как в
// core.test.js; всё, что про панель, стоит в самом конце файла.
const tail = css.slice(css.indexOf('НИЖНЯЯ ПАНЕЛЬ РАЗДЕЛОВ НА ТЕЛЕФОНЕ'));

test('нижняя панель: пять вкладок как у i-store.by, чат и кабинет — только когда они есть', () => {
  const home = R.homePage(SETTINGS, DB, {});
  const bar = (home.match(/<nav class="tabbar" aria-label="Разделы">[\s\S]*?<\/nav>/) || [])[0];
  assert.ok(bar, 'панель есть в разметке витрины');
  const labels = [...bar.matchAll(/<span class="tabbar-label">([^<]+)<\/span>/g)].map(m => m[1]);
  assert.deepEqual(labels, ['Главная', 'Каталог', 'Корзина', 'Кабинет', 'Чат']);
  assert.match(bar, /<a class="tabbar-item is-active" href="\/" aria-current="page">/);
  assert.match(bar, /<a class="tabbar-item" href="\/catalog">/);
  assert.match(bar, /<a class="tabbar-item" href="\/checkout">/);
  // Чат — кнопка, а не ссылка: окно открывает тот же скрипт, что и круглая кнопка.
  assert.match(bar, /<button class="tabbar-item" type="button" data-chat-open aria-controls="chat-panel">/);
  // Счётчики — свои узлы, но пишут в них те же скрипты, что и в шапку.
  assert.match(bar, /<span class="tabbar-badge" data-cart-count aria-hidden="true" hidden>0<\/span>/);
  assert.match(bar, /<span class="tabbar-badge tabbar-badge-alert" data-chat-badge aria-hidden="true" hidden>0<\/span>/);
  assert.match(app, /querySelectorAll\('\[data-cart-count\]'\)/);
  assert.match(chat, /querySelectorAll\('\[data-chat-badge\]'\)/);
  assert.match(chat, /closest\('\[data-chat-open\]'\)/);
  // Ожидающее сообщение от менеджера зажигает счётчик и на вкладке.
  const waiting = R.homePage(SETTINGS, DB, { chatWaiting: 3 });
  assert.match(waiting, /<span class="tabbar-badge tabbar-badge-alert" data-chat-badge aria-hidden="true">3<\/span>/);
  // Отметки «вошёл» у кабинета нет (снята 20 сентября 2026): синяя точка в углу
  // силуэта читалась уведомлением, которого нет. Ни на вкладке, ни в шапке.
  const signedIn = R.homePage(SETTINGS, DB, { customer: { id: 'c' } });
  assert.match(signedIn, /<a class="tabbar-item" href="\/account">/);
  assert.doesNotMatch(signedIn, /is-in/);

  const off = R.homePage(OFF, DB, {});
  const offBar = (off.match(/<nav class="tabbar"[\s\S]*?<\/nav>/) || [])[0];
  const offLabels = [...offBar.matchAll(/<span class="tabbar-label">([^<]+)<\/span>/g)].map(m => m[1]);
  assert.deepEqual(offLabels, ['Главная', 'Каталог', 'Корзина'], 'без чата и кабинета вкладок три');
});

test('нижняя панель: выбранная вкладка — по странице, товар считается каталогом', () => {
  const active = html => ((html.match(/<(?:a|button) class="tabbar-item is-active"[^>]*>[\s\S]*?<span class="tabbar-label">([^<]+)</) || [])[1] || '');
  assert.equal(active(R.homePage(SETTINGS, DB, {})), 'Главная');
  assert.equal(active(R.catalogPage(SETTINGS, DB, {})), 'Каталог');
  assert.equal(active(R.catalogPage(SETTINGS, DB, { category: 'iPhone' })), 'Каталог');
  assert.equal(active(R.productPage(SETTINGS, DB, products[0], {})), 'Каталог');
  assert.equal(active(R.checkoutPage(SETTINGS, {})), 'Корзина');
  assert.equal(active(R.aboutPage(SETTINGS, {})), '', 'у «О компании» своей вкладки нет');
});

test('нижняя панель: полоса как у i-store.by, значки крупнее, поднимает тост и ряд покупки', () => {
  // Только телефон: в базовом слое панель спрятана, показывает её мобильный блок.
  assert.match(css, /\.tabbar\{display:none\}/);
  assert.match(tail, /body\.storefront\{--tabbar-h:calc\(61px \+ env\(safe-area-inset-bottom,0px\)\);padding-bottom:var\(--tabbar-h\)\}/);
  const bar = (tail.match(/\.tabbar\{position:fixed;([^}]*)\}/) || [])[1] || '';
  assert.match(bar, /bottom:0/);
  assert.match(bar, /border-radius:12px 12px 0 0/);
  assert.match(bar, /box-shadow:0 -3px 10px rgba\(0,0,0,\.1\)/);
  assert.match(bar, /background:#fff/);
  /* Значок и подпись крупнее образца (просьба владельца 18 сентября 2026 —
   * «слишком плохо видно»): 24 px вместо 20, подпись 11/14 весом 500 вместо
   * 10/14, серый значка — --muted вместо #888. Полоса и вкладка прежние. */
  const item = (tail.match(/\.tabbar-item\{([^}]*)\}/) || [])[1] || '';
  assert.match(item, /height:56px/);
  assert.match(item, /gap:4px/);
  assert.match(item, /font-size:11px;line-height:14px;font-weight:500/);
  assert.match(item, /flex:1 1 0/);
  assert.match(tail, /\.tabbar-ico\{[^}]*height:24px;color:#6e6e73\}/);
  assert.match(tail, /\.tabbar-ico svg\{display:block;width:24px;height:24px/);
  // Выбранная вкладка — глубоким тоном акцента: чистый акцент у подписи в
  // 11 px не проходит контраст 4.5:1 (PageSpeed на бою, 19 сентября 2026).
  assert.match(tail, /\.tabbar-item\.is-active,\.tabbar-item\.is-active \.tabbar-ico\{color:var\(--accent-deep\)\}/);
  /* Дубли на телефоне спрятаны: круглая кнопка чата и значок кабинета в шапке
   * повторяли вкладки той же панели, а кнопка ещё и закрывала угол каталога.
   * Правило живёт в мобильном блоке — на компьютере оба на месте. */
  assert.match(tail, /\.chat-fab,\.account-btn,\.cart-btn\{display:none\}/, 'в шапке на телефоне остаётся одна лупа');
  assert.ok(css.indexOf('.chat-fab,.account-btn,.cart-btn{display:none}') > css.indexOf('@media(max-width:800px){\n  body.storefront{--tabbar-h'),
    'прячет их только мобильный блок — на компьютере круглая кнопка, значок и корзина остаются');
  assert.match(css, /\n\.chat-fab\{position:relative;[^}]*display:block/, 'базовое правило кнопки чата на месте');
  /* Анимаций у вкладки НЕТ ВОВСЕ — кольца, мигание и вибрацию владелец
   * отверг. Внимание держит значок «1» у нового посетителя: приветствие
   * консультанта в окне и правда не прочитано. Первое открытие гасит его и
   * запоминается в браузере; тому, у кого разговор начат или сервер прислал
   * настоящие непрочитанные, единица не подставляется. */
  assert.doesNotMatch(tail, /animation|@keyframes|is-attract|tabbar-shake|tabbar-blink|tabbar-pulse/, 'у панели нет ни одной анимации');
  assert.match(chat, /var SEEN = 'chat_seen_v1';/);
  assert.match(chat, /if \(!waiting && !chatSeen\(\) && !recall\(\)\) \{ state\.unread = 1; paintBadge\(\); \}/,
    'единица — только новому: без начатого разговора и без настоящих непрочитанных от сервера');
  assert.match(chat, /function show\(\) \{\s*markSeen\(\);/, 'первое открытие запоминается — в следующий заход приветствие прочитано');
  assert.doesNotMatch(chat, /attractTabs|is-attract/, 'вибрации в скрипте не осталось');
  // Значок «вам написали» — красный, как у круглой кнопки; счётчик корзины — цветом темы.
  assert.match(tail, /\.tabbar-badge\{position:absolute;[^}]*background:var\(--accent\)[^}]*box-shadow:0 0 0 2px #fff\}/);
  assert.match(tail, /\.tabbar-badge-alert\{background:#eb5757\}/);
  assert.doesNotMatch(css, /is-in/, 'точки «вошёл» нет ни у вкладки, ни у значка в шапке');
  // Закрытое окно возвращает фокус туда, откуда открыли: на телефоне — на вкладку.
  assert.match(chat, /var back = button && button\.offsetParent !== null \? button : document\.querySelector\('\[data-chat-open\]'\);/);
  assert.match(chat, /tab\.setAttribute\('aria-label', 'Чат, новых сообщений: ' \+ state\.unread\)/);
  // Кнопка чата, тост и липкий ряд покупки поднимаются на высоту панели —
  // правила стоят в конце файла, после своих блоков.
  assert.match(tail, /\.chat-widget\{bottom:calc\(12px \+ var\(--tabbar-h\)\)\}/);
  assert.match(tail, /\.toast\{bottom:calc\(16px \+ var\(--tabbar-h\)\)\}/);
  assert.match(tail, /\.product \.buy-row\{bottom:var\(--tabbar-h\);padding-bottom:12px;margin-bottom:0\}/);
  assert.match(tail, /\.product-page \.chat-widget\{bottom:calc\(84px \+ var\(--tabbar-h,0px\)\)\}/);
  assert.match(tail, /@media print\{\.tabbar\{display:none!important\}\}/);
  // Панель под затемнением меню и под корзиной, но над содержимым.
  const z = Number((bar.match(/z-index:(\d+)/) || [])[1]);
  assert.ok(z > 30 && z < 39, 'панель ниже затемнения меню (39) и выше липкого ряда покупки');
});

test('главная — страница входа: категории, популярное и кнопка в каталог, без сетки всего каталога', () => {
  const home = R.homePage(SETTINGS, DB, { origin: 'https://shop.test' });
  assert.match(home, /<section class="store-hero">/);
  assert.match(home, /<h2>Категории<\/h2><a class="section-more" href="\/catalog">Весь каталог/);
  assert.match(home, /<div class="cat-grid">/);
  assert.match(home, /<h2>Популярное<\/h2>/);
  assert.match(home, /<a class="btn btn-primary btn-lg" href="\/catalog">Смотреть весь каталог<\/a>/);
  const cards = (home.match(/class="card-name"/g) || []).length;
  assert.equal(cards, 8, 'на главной восемь карточек, а не весь каталог');
  assert.ok(cards < products.length);
  // Плитка категории ведёт в каталог с фильтром и называет число товаров.
  const iphones = products.filter(p => p.category === 'iPhone').length;
  assert.match(home, new RegExp(`<a class="cat-tile" href="/catalog\\?category=iPhone">[\\s\\S]*?<span class="cat-tile-name">iPhone</span><span class="cat-tile-count">${iphones} товаров</span>`));
  // Прежних адресов «/?category=» на витрине не осталось нигде.
  assert.doesNotMatch(home, /href="\/\?category=/);
  assert.doesNotMatch(home, /\/\?q=/);
  assert.match(home, /"target":"https:\/\/shop\.test\/catalog\?q=\{search_term_string\}"/);
  assert.match(home, /rel="canonical" href="https:\/\/shop\.test\/"/);

  // «Популярное» — по числу отзывов среди того, что можно купить: товар без
  // цены и распроданный туда не попадают, а самый обсуждаемый стоит первым.
  const picks = [...home.matchAll(/<a class="card-name" href="\/product\/([^"]+)">/g)].map(m => m[1]);
  assert.equal(picks[0], 'iphone-17');
  const hidden = products.filter(p => p.hidePrice || !R.sellable(p, SETTINGS)).map(p => p.id);
  assert.ok(hidden.length, 'в каталоге есть товары без цены — иначе проверка пуста');
  for (const id of picks) assert.ok(!hidden.includes(id), id + ': без цены или не в наличии в «Популярном»');
  assert.doesNotMatch(home, /class="card card-out"/);
});

test('каталог — своя страница: заголовок с числом, ряд категорий, сетка, крошки', () => {
  const all = R.catalogPage(SETTINGS, DB, { origin: 'https://shop.test' });
  assert.match(all, /<nav class="breadcrumb"><a href="\/">Главная<\/a> \/ <span>Каталог<\/span><\/nav>/);
  assert.match(all, new RegExp(`<h1>Каталог<span class="cat-count">${products.length}</span></h1>`));
  assert.match(all, /<div class="cat-row">/);
  assert.equal((all.match(/class="card-name"/g) || []).length, products.length);
  assert.doesNotMatch(all, /store-hero/, 'первого экрана на каталоге нет');
  assert.match(all, /rel="canonical" href="https:\/\/shop\.test\/catalog"/);

  const cat = R.catalogPage(SETTINGS, DB, { category: 'iPhone' });
  assert.match(cat, /<a href="\/catalog">Каталог<\/a> \/ <span>iPhone<\/span>/);
  assert.match(cat, /<h1>iPhone<span class="cat-count">\d+<\/span><\/h1>/);
  assert.match(cat, /<a class="cat-tile is-active" href="\/catalog\?category=iPhone" aria-current="page">/);
  assert.match(cat, /<a href="\/catalog\?category=iPhone" class="nav-item active" aria-current="page">iPhone<\/a>/);

  const found = R.catalogPage(SETTINGS, DB, { q: 'айфон' });
  assert.match(found, /<h1>Результаты: «айфон»<span class="cat-count">\d+<\/span><\/h1>/);
  assert.doesNotMatch(found, /<div class="cat-row">/, 'у поиска ряда категорий нет');

  // Мобильный ряд — лента вбок, и привязка прокрутки не съедает поле.
  const mobile = css.slice(css.indexOf('@media(max-width:800px){'));
  assert.match(mobile, /\.cat-row\{flex-wrap:nowrap;[^}]*overflow-x:auto;[^}]*scroll-padding-inline:20px\}/);
});

test('прежние адреса каталога уводятся на /catalog, страница стоит в метрике и карте сайта', () => {
  assert.match(server, /app\.get\('\/', \(req, res\) => \{\n  if \(req\.query\.category \|\| req\.query\.q\) return res\.redirect\(catalogUrl\(req\.query\), 301\);/);
  assert.match(server, /app\.get\('\/catalog', \(req, res\) => \{\n  trackPage\(req, res, '\/catalog'\);/);
  assert.match(server, /const PUBLIC_PAGES = \[[^\]]*'\/catalog'/);
  assert.match(server, /'\/catalog\?category=' \+ encodeURIComponent\(category\)/);
  assert.doesNotMatch(server, /'\/\?category='/);
  const names = fs.readFileSync(path.join(ROOT, 'lib', 'analytics-view.js'), 'utf8');
  assert.match(names, /'\/catalog': 'Каталог'/);
  assert.equal(CI.pageKey('/catalog'), 'catalog');
  assert.equal(CI.pageKey('/catalog?category=Mac'), 'catalog');
  assert.ok(CI.has('catalog'));
  // Все ссылки «в каталог» ведут на новую страницу, а не на главную.
  for (const file of ['lib/render.js', 'public/app.js']) {
    const src = fs.readFileSync(path.join(ROOT, file), 'utf8');
    for (const m of src.matchAll(/href="\/"[^<]*>(Вернуться в каталог|Продолжить покупки|Перейти в каталог)/g)) {
      assert.fail(file + ': «' + m[1] + '» ведёт на главную, а не в каталог');
    }
  }
});

/* LCP главной на телефоне — снимок ПЕРВОЙ плитки категорий: сетка из девяти
 * плиток занимает первый экран целиком. PageSpeed на бою (19 сентября 2026)
 * показал этот снимок с `loading="lazy"` и без приоритета — браузер откладывал
 * ровно ту картинку, по которой считается скорость. Первый ряд грузится сразу,
 * приоритет — у одной первой (девять «высоких» приоритетов разом означали бы,
 * что высокого нет ни у одной), а у плитки есть srcset с sizes под её сетку:
 * одна копия 320 на экране с DPR 2 растягивалась до мыла. */
test('плитки категорий: первый ряд грузится сразу и с приоритетом целиком, srcset со ступенью 200 и sizes под снимок плитки', () => {
  const os = require('node:os');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tiles-'));
  for (const n of ['a.webp', 'a-c200.webp', 'a-c320.webp', 'a-c480.webp', 'a-c640.webp']) fs.writeFileSync(path.join(dir, n), 'x');
  const cats = ['iPhone', 'Mac', 'iPad', 'Apple Watch', 'AirPods'];
  const list = cats.map((c, i) => ({ id: 'p' + i, name: c + ' X', category: c, price: 1000, images: ['a.webp'] }));
  const db = { UPLOAD_DIR: dir, visibleProducts: () => list, visibleCategories: () => cats };
  const imgs = R.categoryTiles(db, {}, {}).match(/<img[^>]*>/g);
  assert.equal(imgs.length, 5);
  // LCP — одна из плиток первого ряда, и какая, наперёд не знает никто
  // (PageSpeed назвал вторую при приоритете у первой): высокий приоритет у
  // всех трёх, а не у девяти.
  for (const i of [0, 1, 2]) assert.match(imgs[i], /loading="eager"[^>]*fetchpriority="high"/, 'плитка ' + i + ' первого ряда — сразу и с приоритетом');
  assert.match(imgs[3], /loading="lazy"/, 'со второго ряда плитки ленивые'); assert.doesNotMatch(imgs[3], /fetchpriority/);
  for (const img of imgs) {
    assert.match(img, /srcset="\/uploads\/a-c200\.webp 200w, \/uploads\/a-c320\.webp 320w, \/uploads\/a-c480\.webp 480w, \/uploads\/a-c640\.webp 640w"/);
    assert.match(img, /sizes="\(min-width:1248px\) 240px, \(min-width:801px\) calc\(25vw - 60px\), calc\(33\.3vw - 39px\)"/, 'sizes — ширина снимка, а не плитки: поля вычтены');
    assert.match(img, /src="\/uploads\/a-c200\.webp"/, 'запасной src — самая мелкая копия');
  }
  // Ряд категорий на каталоге — плитки по 54 px: там мелкая копия без srcset, как было.
  const row = R.categoryTiles(db, {}, { row: true }).match(/<img[^>]*>/g)[0];
  assert.doesNotMatch(row, /srcset|eager|fetchpriority/);
  // Сетка плиток: три колонки на телефоне и четыре на компьютере — числа sizes.
  assert.match(css, /\.cat-grid\{display:grid;grid-template-columns:repeat\(2,minmax\(0,1fr\)\)/);
  assert.match(css, /@media\(min-width:640px\)\{\.cat-grid\{grid-template-columns:repeat\(4,minmax\(0,1fr\)\)/);
  const mobile = css.slice(css.indexOf('@media(max-width:800px){'));
  assert.match(mobile, /\.cat-grid\{grid-template-columns:repeat\(3,minmax\(0,1fr\)\);gap:8px\}/);
  // Из чего сложены числа `sizes`: на телефоне поля страницы 20, зазор 8, поля
  // плитки 10 → снимок = 33,3vw − 39; от 801 px поля 24, зазор 16, поля плитки
  // 18 → 25vw − 60. Поменялось любое из них — пересчитай TILE_SIZES_ATTR.
  assert.match(mobile, /\.container\{padding-inline:20px\}/);
  assert.match(mobile, /\.cat-grid \.cat-tile-media\{aspect-ratio:1\/1;padding:8px 10px 0\}/);
  assert.match(css, /\.container\{padding-inline:24px\}/);
  assert.match(css, /\.cat-tile-media\{[^}]*padding:12px 18px 0\}/);
  fs.rmSync(dir, { recursive: true, force: true });
});
