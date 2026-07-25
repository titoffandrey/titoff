'use strict';
/*
 * Безопасно добавляет актуальные новинки Apple в ЖИВОЙ каталог.
 * НЕ удаляет и НЕ меняет существующие товары, фото и настройки.
 * Идемпотентно: повторный запуск не создаёт дублей (проверка по названию).
 *
 * Запуск на сервере (в папке проекта):
 *   node add-novinki.js
 */
const db = require('./lib/db');
db.ensureSeeded();

const NEW = require('./new-products');
const have = new Set(db.getProducts().map(p => p.name));
let added = 0;

for (const p of NEW) {
  if (have.has(p.name)) { console.log('• пропуск (уже есть):', p.name); continue; }
  db.createProduct(p);
  console.log('✓ добавлено:', p.name);
  added++;
}

console.log(`\nГотово. Добавлено новинок: ${added}. Всего товаров в каталоге: ${db.getProducts().length}.`);
