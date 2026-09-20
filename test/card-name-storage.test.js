'use strict';
/* Объём памяти стартовой сборки в названии карточки каталога — 20 сентября 2026.
 *
 * Просьба владельца второго сайта: «iPhone 15 Pro Max» → «iPhone 15 Pro Max
 * 256 ГБ», где 256 ГБ — та сборка, цену которой карточка и показывает. Первому
 * сайту это не нужно, и код у сайтов один, поэтому это настройка
 * `cardNameStorage` с умолчанием «как было», а не ветка по домену.
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
const ON = Object.assign(dbCore.defaultSettings(), { cardNameStorage: true });
const byId = id => catalog.products.find(p => p.id === id);
// Между числом и единицей — неразрывный пробел (см. `startStorageLabel`).
const NB = '\u00a0';
const clone = p => JSON.parse(JSON.stringify(p));
const cardNames = html => [...html.matchAll(/<a class="card-name" href="[^"]+">([^<]+)<\/a>/g)].map(m => m[1]);

test('по умолчанию выключено: названия карточек как были, и на первом сайте ничего не меняется', () => {
  assert.equal(dbCore.defaultSettings().cardNameStorage, false);
  assert.equal(R.cardNameStorageOn(OFF), false);
  for (const p of products) assert.equal(R.cardName(p, OFF), p.name);
  const names = cardNames(R.catalogPage(OFF, DB, {}));
  assert.ok(names.includes('iPhone 15 Pro Max'));
  const plain = new Set(products.map(p => R.esc(p.name)));
  assert.ok(names.length && names.every(n => plain.has(n)), 'без галочки у каждой карточки — ровно название товара');
});

test('с галочкой к названию дописан объём той сборки, чья цена показана', () => {
  assert.equal(R.cardName(byId('iphone-15-pro-max'), ON), `iPhone 15 Pro Max 256${NB}ГБ`);
  assert.equal(R.cardName(byId('iphone-16'), ON), `iPhone 16 128${NB}ГБ`);
  assert.equal(R.cardName(byId('macbook-pro-14-m5'), ON), `MacBook Pro 14" (M5) 1${NB}ТБ`);
  // Из метки конфигурации вынимается только память: «256 ГБ · Magic Keyboard»
  // у MacBook Neo даёт «256 ГБ», а не хвост с клавиатурой.
  assert.equal(R.cardName(byId('macbook-neo'), ON), `MacBook Neo 256${NB}ГБ`);
  // Часы (размер корпуса) и наушники (конфигураций нет) остаются как были.
  assert.equal(R.cardName(byId('watch-series-11-alu'), ON), byId('watch-series-11-alu').name);
  assert.equal(R.cardName(byId('airpods-pro-3'), ON), 'AirPods Pro 3');
  // Без ценника нет и сборки, «цена которой показывается».
  assert.equal(R.cardName(Object.assign({}, byId('iphone-15-pro-max'), { hidePrice: true }), ON), 'iPhone 15 Pro Max');
  // Объём уже вписан в название руками (обычным пробелом) — второй раз не дописывается.
  assert.equal(R.cardName(Object.assign({}, byId('iphone-15-pro-max'), { name: 'iPhone 15 Pro Max 256 ГБ' }), ON), 'iPhone 15 Pro Max 256 ГБ');

  // Сборка ТА ЖЕ, что у цены: распроданные 256 ГБ уводят и цену, и подпись на 512.
  const p = clone(byId('iphone-15-pro-max'));
  p.storages[0].inStock = false;
  assert.equal(R.cardName(p, ON), `iPhone 15 Pro Max 512${NB}ГБ`);
  const base = R.startPrice(clone(byId('iphone-15-pro-max')), ON);
  assert.equal(R.startPrice(p, ON), base + Number(p.storages[1].add), 'цена карточки — за ту же сборку 512 ГБ');

  // В разметке каталога и «Популярного» — тот же результат, через esc().
  const html = R.catalogPage(ON, DB, { category: 'iPhone' });
  const names = cardNames(html);
  assert.ok(names.includes(`iPhone 15 Pro Max 256${NB}ГБ`), names.join(' | '));
  assert.ok(names.includes(`iPhone 16 128${NB}ГБ`));
  const macs = cardNames(R.catalogPage(ON, DB, { category: byId('macbook-pro-14-m5').category }));
  assert.ok(macs.includes(`MacBook Pro 14&quot; (M5) 1${NB}ТБ`), 'кавычка дюйма экранирована');
  // Страница самого товара не трогается: там объём выбирают рядом.
  const page = R.productPage(ON, DB, byId('iphone-15-pro-max'), {});
  assert.match(page, /<h1 class="product-name">iPhone 15 Pro Max<\/h1>/);
});

test('настройка в панели: галочка в «Оформлении» с признаком секции, снятие читается по его наличию', () => {
  const db = { pendingReviewCount: () => 0, getOrders: () => [] };
  const base = Object.assign(dbCore.defaultSettings(), { storeName: 'iStore', legalOperator: 'ИП Иванов' });
  const off = adminViews.settingsPage(base, db, null);
  assert.match(off, /<input type="hidden" name="brandForm" value="1">/);
  assert.match(off, /<input type="checkbox" name="cardNameStorage"> В названии карточки каталога — объём памяти сборки, чья цена показана/);
  assert.doesNotMatch(off, /память в названии карточки/);
  const on = adminViews.settingsPage(Object.assign({}, base, { cardNameStorage: true }), db, null);
  assert.match(on, /<input type="checkbox" name="cardNameStorage" checked>/);
  assert.match(on, /шрифт «[^»]+» · название магазина текстом · память в названии карточки/);
  // Форма вернулась с ошибкой и снятой галочкой — она не должна снова оказаться
  // отмеченной из сохранённых настроек (то же правило, что у остальных галочек).
  const draft = adminViews.settingsPage(Object.assign({}, base, { cardNameStorage: true }), db, 'Ошибка', 'err', { draft: { storeName: '' } });
  assert.match(draft, /<input type="checkbox" name="cardNameStorage"> В названии/);
  // Сервер: секцию узнаёт по `brandForm`, галочку — по наличию поля.
  assert.match(server, /if \(req\.body\.brandForm !== undefined\) patch\.cardNameStorage = req\.body\.cardNameStorage !== undefined;/);
});
