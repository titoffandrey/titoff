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
  // Точка «вошёл» у кабинета — как у значка в шапке: на телефоне значка в шапке нет.
  assert.match(R.homePage(SETTINGS, DB, { customer: { id: 'c' } }), /<a class="tabbar-item is-in" href="\/account">/);
  assert.doesNotMatch(bar, /tabbar-item is-in/);

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
  assert.match(tail, /\.tabbar-item\.is-active,\.tabbar-item\.is-active \.tabbar-ico\{color:var\(--accent\)\}/);
  /* Дубли на телефоне спрятаны: круглая кнопка чата и значок кабинета в шапке
   * повторяли вкладки той же панели, а кнопка ещё и закрывала угол каталога.
   * Правило живёт в мобильном блоке — на компьютере оба на месте. */
  assert.match(tail, /\.chat-fab,\.account-btn,\.cart-btn\{display:none\}/, 'в шапке на телефоне остаётся одна лупа');
  assert.ok(css.indexOf('.chat-fab,.account-btn,.cart-btn{display:none}') > css.indexOf('@media(max-width:800px){\n  body.storefront{--tabbar-h'),
    'прячет их только мобильный блок — на компьютере круглая кнопка, значок и корзина остаются');
  assert.match(css, /\n\.chat-fab\{position:relative;[^}]*display:block/, 'базовое правило кнопки чата на месте');
  /* Значок «Чата» ВИБРИРУЕТ — качается с затухающим размахом и замирает на
   * три четверти периода — и только пока окно ни разу не открывали: класс
   * `is-attract` ставит chat.js по памяти браузера и снимает первым открытием.
   * Анимируется один transform (композитор, без перерисовки); колец, волн и
   * мигания цветом нет — владелец отверг их. При prefers-reduced-motion стоит. */
  assert.match(tail, /\.tabbar-item\.is-attract \.tabbar-ico svg\{animation:tabbar-shake 3\.6s ease-in-out \.6s infinite;transform-origin:50% 60%\}/);
  const shake = (css.match(/@keyframes tabbar-shake\{[^]*?\}\}/) || [])[0] || '';
  assert.ok(shake, 'кадры вибрации на месте');
  assert.match(shake, /0%,22%,to\{transform:rotate\(0\)\}/, 'три четверти периода значок стоит');
  assert.doesNotMatch(shake, /color|opacity|width|height|top|left/, 'анимируется только transform');
  assert.doesNotMatch(tail, /\.tabbar-ico::before|tabbar-pulse|tabbar-blink|chat-wave/, 'колец, волн и мигания цветом у вкладки нет');
  assert.doesNotMatch(tail, /\[data-chat-open\] \.tabbar-ico\{animation/, 'вибрирует не любая вкладка чата, а только зовущая (is-attract)');
  assert.match(css, /@media \(prefers-reduced-motion:reduce\)\{\s*\.tabbar-item\.is-attract \.tabbar-ico svg\{animation:none\}/);
  assert.match(chat, /var SEEN = 'chat_seen_v1';/);
  assert.match(chat, /if \(!chatSeen\(\) && !recall\(\)\) attractTabs\(true\);/, 'зовёт только того, кто окна не открывал и разговора не вёл');
  assert.match(chat, /function show\(\) \{\s*markSeen\(\);/, 'первое открытие снимает вибрацию и запоминается');
  assert.doesNotMatch(chat, /setInterval\([^)]*attract|setTimeout\([^)]*attract/, 'ни одного таймера ради вибрации');
  // Значок «вам написали» — красный, как у круглой кнопки; счётчик корзины — цветом темы.
  assert.match(tail, /\.tabbar-badge\{position:absolute;[^}]*background:var\(--accent\)[^}]*box-shadow:0 0 0 2px #fff\}/);
  assert.match(tail, /\.tabbar-badge-alert\{background:#eb5757\}/);
  assert.match(tail, /\.tabbar-item\.is-in \.tabbar-ico::after\{[^}]*background:var\(--accent\);box-shadow:0 0 0 2px #fff\}/);
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
