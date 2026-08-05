'use strict';
/*
 * Безопасно добавляет недостающие товары из catalog.js в ЖИВОЙ каталог.
 * НЕ удаляет и НЕ меняет существующие товары, фото и настройки.
 * Идемпотентно: повторный запуск не создаёт дублей (проверка по названию).
 *
 * Запуск на сервере (в папке проекта):
 *   node add-novinki.js
 */
const db = require('./lib/db');
db.ensureSeeded();

const { products: CATALOG } = require('./catalog');
const NEW = require('./new-products');
const have = new Set(db.getProducts().map(p => p.name));
const added = [];

for (const p of NEW) {
  if (have.has(p.name)) { console.log('• пропуск (уже есть):', p.name); continue; }
  added.push(db.createProduct(p).id);
  console.log('✓ добавлено:', p.name);
}

// createProduct кладёт товар в начало списка, а список и есть порядок карточек
// на главной. Для новинки это правильно, а вот прошлое поколение оказалось бы
// выше свежего. Поэтому добавленный товар встаёт туда, где он стоит в
// catalog.js: сразу за ближайшим соседом сверху, который на витрине уже есть.
function placeByCatalog(ids) {
  const order = db.getProducts().map(p => p.id);
  const catalogAt = new Map(CATALOG.map((p, i) => [p.id, i]));
  for (const id of ids) {
    const i = catalogAt.get(id);
    if (i === undefined) continue; // товар не из catalog.js — оставляем сверху
    // Ближайший сосед сверху по catalog.js, который на витрине уже есть.
    let anchor = '';
    for (let k = i - 1; k >= 0 && !anchor; k--) {
      if (order.includes(CATALOG[k].id)) anchor = CATALOG[k].id;
    }
    if (!anchor) continue; // соседей сверху нет — место в начале и есть верное
    order.splice(order.indexOf(id), 1);
    order.splice(order.indexOf(anchor) + 1, 0, id);
  }
  return order;
}

if (added.length) {
  const order = placeByCatalog(added);
  if (!db.reorderProducts(order)) console.log('! порядок карточек не изменён — поправьте вручную в /owner/products');
}

console.log(`\nГотово. Добавлено товаров: ${added.length}. Всего товаров в каталоге: ${db.getProducts().length}.`);
