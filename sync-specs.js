'use strict';
/*
 * Обновляет ТОЛЬКО характеристики (поле specs) у товаров живого каталога
 * значениями из catalog.js. Цены, фото, скидки, заказы, отзывы и настройки
 * магазинов не трогает — их правят в админке, и перезаписывать их нельзя.
 *
 * Нужен потому, что товары лежат в data/products.json и засеиваются из
 * catalog.js только при первом запуске: git pull сам по себе тексты
 * характеристик на сервере не меняет.
 *
 * Запуск на сервере (в папке проекта):
 *   node sync-specs.js            — показать, что изменится (ничего не пишет)
 *   node sync-specs.js --apply    — записать изменения
 */
const db = require('./lib/db');
const catalog = require('./catalog');

const apply = process.argv.includes('--apply');
db.ensureSeeded();

const live = db.getProducts();
const byId = new Map(live.map(p => [p.id, p]));
const byName = new Map(live.map(p => [p.name, p]));

// Сохранение через панель приходит из <textarea>, а браузер переводит строки в
// CRLF. Сравнение «в лоб» считало расхождением каждый такой товар: скрипт обещал
// переписать почти весь каталог там, где не менялось ни буквы. Перед сравнением
// приводим переводы строк и хвостовые пробелы к одному виду.
const normSpecs = (s) => String(s == null ? '' : s).replace(/\r\n?/g, '\n').replace(/[ \t]+$/gm, '').trim();

let changed = 0, missing = 0;
for (const src of catalog.products) {
  const cur = byId.get(src.id) || byName.get(src.name);
  if (!cur) { console.log('• нет в живом каталоге:', src.name); missing++; continue; }
  if (normSpecs(cur.specs) === normSpecs(src.specs)) continue;

  const was = String(cur.specs || '').split('\n').filter(Boolean).length;
  const now = String(src.specs || '').split('\n').filter(Boolean).length;
  console.log(`✓ ${cur.name}: строк ${was} → ${now}`);
  if (apply) db.updateProduct(cur.id, { specs: src.specs });
  changed++;
}

console.log(`\n${apply ? 'Обновлено' : 'Будет обновлено'} товаров: ${changed}` +
  (missing ? `, нет в каталоге магазина: ${missing}` : '') +
  `. Всего товаров: ${live.length}.`);
if (!apply && changed) console.log('Это был предпросмотр. Чтобы записать: node sync-specs.js --apply');
