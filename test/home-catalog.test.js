'use strict';
/* Весь каталог на главной — настройка сайта, 20 сентября 2026.
 *
 * Просьба владельца второго магазина: на главной — просто все товары, без
 * плиток категорий, «Популярного» и без заголовка «Каталог» или «Главная».
 * Это прежняя главная (до 18 сентября 2026): слоган, бегущая строка и сразу
 * сетка. Первому сайту нужна главная с плитками и подборкой, а код у сайтов
 * один — поэтому галочка `homeCatalog` с умолчанием «как было», а не ветка
 * по домену (см. «Два сайта из одного репозитория» в CLAUDE.md).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const R = require('../lib/render');
const dbCore = require('../lib/db');
const adminViews = require('../lib/admin-views');
const catalog = require('../catalog');

const ROOT = path.join(__dirname, '..');
const server = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');

const products = catalog.products.filter(p => p.visible !== false);
const DB = {
  UPLOAD_DIR: path.join(ROOT, 'data', 'uploads'),
  getProducts: () => catalog.products,
  visibleProducts: () => products,
  visibleProduct: id => products.find(p => p.id === id) || null,
  categories: () => [...new Set(catalog.products.map(p => p.category))],
  visibleCategories: () => [...new Set(products.map(p => p.category))],
  ratingFor: () => ({ avg: 4.7, count: 10 }),
  reviewsForProduct: () => []
};
const OFF = dbCore.defaultSettings();
const ON = Object.assign(dbCore.defaultSettings(), { homeCatalog: true });
const cardIds = html => [...html.matchAll(/<a class="card-name" href="\/product\/([^"]+)">/g)].map(m => m[1]);
const activeTab = html => ((html.match(/<a class="tabbar-item is-active"[^>]*>[\s\S]*?<span class="tabbar-label">([^<]+)<\/span>/) || [])[1]);

test('по умолчанию выключено: главная первого сайта как была — плитки, «Популярное», кнопка в каталог', () => {
  assert.equal(dbCore.defaultSettings().homeCatalog, false);
  assert.equal(R.homeCatalogOn(OFF), false);
  assert.equal(R.homeCatalogOn({}), false);
  const home = R.homePage(OFF, DB, { origin: 'https://shop.test' });
  assert.match(home, /<section class="store-hero">/);
  assert.match(home, /<div class="cat-grid">/);
  assert.match(home, /<h2>Категории<\/h2>/);
  assert.match(home, /<h2>Популярное<\/h2>/);
  assert.match(home, /<a class="btn btn-primary btn-lg" href="\/catalog">Смотреть весь каталог<\/a>/);
  assert.doesNotMatch(home, /home-catalog/);
  assert.equal(cardIds(home).length, 8);
});

test('с галочкой на главной сразу весь каталог: слоган и сетка всех товаров, ни плиток, ни «Популярного», ни заголовка', () => {
  const home = R.homePage(ON, DB, { origin: 'https://shop.test' });
  // Первый экран остаётся — это слоган магазина, а не заголовок «Каталог».
  assert.match(home, /<section class="store-hero">/);
  // Сразу за ним — сетка: отступ даёт `.store-hero + .section`, как у прежней главной.
  assert.match(home, /<\/section>\s*<section class="container section home-catalog">\s*<div class="grid">/);
  assert.doesNotMatch(home, /<div class="cat-grid">/);
  assert.doesNotMatch(home, /class="cat-row"/);
  assert.doesNotMatch(home, /<h2>Категории<\/h2>|<h2>Популярное<\/h2>|section-cta|section-more|Смотреть весь каталог/);
  // Заголовка «Каталог» / «Главная» нет: единственный <h1> — слоган первого экрана.
  const h1 = home.match(/<h1[^>]*>[^<]*<\/h1>/g) || [];
  assert.equal(h1.length, 1, h1.join(' | '));
  assert.match(h1[0], /store-hero|--fit:/);
  assert.doesNotMatch(home, /<h1[^>]*>(Каталог|Главная)/);
  assert.doesNotMatch(home, /class="cat-count"|class="breadcrumb"/);
  // Все видимые товары, в порядке витрины — как на /catalog.
  assert.deepEqual(cardIds(home), products.map(p => p.id));
  assert.deepEqual(cardIds(home), cardIds(R.catalogPage(ON, DB, {})));
  // Первый ряд грузится сразу, как на каталоге: четыре снимка eager, остальные
  // lazy (у товаров catalog.js фото нет — даём каждому по снимку).
  const withPhotos = products.map(p => Object.assign({}, p, { images: [p.id + '.webp'] }));
  const photoDb = Object.assign({}, DB, { visibleProducts: () => withPhotos, visibleProduct: id => withPhotos.find(p => p.id === id) || null });
  const shots = R.homePage(ON, photoDb, {}).match(/<div class="card-media"><img [^>]*loading="(eager|lazy)"/g) || [];
  assert.equal(shots.length, products.length);
  assert.deepEqual(shots.map(m => /eager/.test(m)), products.map((p, i) => i < 4));
  // Это по-прежнему главная: вкладка «Главная», canonical «/», поиск ведёт на /catalog.
  assert.equal(activeTab(home), 'Главная');
  assert.match(home, /rel="canonical" href="https:\/\/shop\.test\/"/);
  assert.match(home, /"target":"https:\/\/shop\.test\/catalog\?q=\{search_term_string\}"/);
  assert.doesNotMatch(home, /href="\/\?category=|\/\?q=/);
  // Набор критических стилей — свой: первый экран другой.
  assert.equal(R.criticalKind({ tab: 'home', homeCatalog: true }), 'home-catalog');
  assert.equal(R.criticalKind({ tab: 'home', homeCatalog: false }), 'home');
  // Пустой каталог — честная строка, а не пустая сетка.
  const emptyDb = Object.assign({}, DB, { visibleProducts: () => [], visibleCategories: () => [] });
  assert.match(R.homePage(ON, emptyDb, {}), /<p class="empty">Каталог пока пуст\.<\/p>/);
});

test('страница /catalog от галочки не меняется: заголовок с числом, ряд категорий, вся сетка', () => {
  for (const settings of [OFF, ON]) {
    const cat = R.catalogPage(settings, DB, { origin: 'https://shop.test' });
    assert.match(cat, new RegExp(`<h1>Каталог<span class="cat-count">${products.length}</span></h1>`));
    assert.match(cat, /<div class="cat-row">/);
    assert.equal(cardIds(cat).length, products.length);
    assert.equal(activeTab(cat), 'Каталог');
  }
});

test('настройка в панели: галочка в «Оформлении» с признаком секции, снятие читается по его наличию', () => {
  const db = { pendingReviewCount: () => 0, getOrders: () => [] };
  const base = Object.assign(dbCore.defaultSettings(), { storeName: 'iStore', legalOperator: 'ИП Иванов' });
  const off = adminViews.settingsPage(base, db, null);
  assert.match(off, /<input type="hidden" name="brandForm" value="1">/);
  assert.match(off, /<input type="checkbox" name="homeCatalog"> На главной — сразу весь каталог/);
  assert.doesNotMatch(off, /весь каталог на главной/);
  const on = adminViews.settingsPage(Object.assign({}, base, { homeCatalog: true }), db, null);
  assert.match(on, /<input type="checkbox" name="homeCatalog" checked>/);
  assert.match(on, /шрифт «[^»]+» · название магазина текстом · весь каталог на главной/);
  // Обе галочки «Оформления» независимы и в свёрнутой строке стоят вместе.
  const both = adminViews.settingsPage(Object.assign({}, base, { homeCatalog: true, cardNameStorage: true }), db, null);
  assert.match(both, /· память в названии карточки · весь каталог на главной/);
  // Форма вернулась с ошибкой и снятой галочкой — она не должна снова оказаться
  // отмеченной из сохранённых настроек (то же правило, что у остальных галочек).
  const draft = adminViews.settingsPage(Object.assign({}, base, { homeCatalog: true }), db, 'Ошибка', 'err', { draft: { storeName: '' } });
  assert.match(draft, /<input type="checkbox" name="homeCatalog"> На главной/);
  // Сервер: секцию узнаёт по `brandForm`, галочку — по наличию поля.
  assert.match(server, /if \(req\.body\.brandForm !== undefined\) patch\.homeCatalog = req\.body\.homeCatalog !== undefined;/);
});
