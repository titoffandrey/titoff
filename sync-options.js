'use strict';
/*
 * Переносит дополнительные характеристики (поле options) из catalog.js
 * в живой каталог на сервере. Цены, фото, заказы и отзывы не трогает —
 * как sync-bands.js и sync-specs.js.
 *
 * Нужен потому, что товары лежат в data/products.json и засеиваются из
 * catalog.js только при первом запуске: git pull сам по себе «Покрытие
 * дисплея» и «Связь» на сервере не добавит.
 *
 *   node sync-options.js            — показать, что изменится (ничего не пишет)
 *   node sync-options.js --apply    — записать изменения
 */
const db = require('./lib/db');
const catalog = require('./catalog');

const apply = process.argv.includes('--apply');
db.ensureSeeded();

const live = db.getProducts();
const byId = new Map(live.map(p => [p.id, p]));
const byName = new Map(live.map(p => [p.name, p]));

let changed = 0, missing = 0, skipped = 0;

for (const src of catalog.products) {
  if (!(src.options || []).length) continue;
  const cur = byId.get(src.id) || byName.get(src.name);
  if (!cur) { console.log('• нет в живом каталоге:', src.name); missing++; continue; }
  if (JSON.stringify(cur.options || []) === JSON.stringify(src.options)) continue;
  // Метки конфигураций в живом каталоге могли разойтись с catalog.js: тогда
  // «только для 1 ТБ» указывало бы на несуществующий вариант, и значение
  // пропало бы с витрины навсегда. Такой товар пропускаем с предупреждением.
  const labels = new Set((cur.storages || []).map(s => s.label));
  const lost = [];
  for (const g of src.options) {
    for (const v of g.values || []) {
      for (const only of v.forStorage || []) if (!labels.has(only)) lost.push(`${g.name} · ${v.label} → «${only}»`);
    }
  }
  if (lost.length) {
    console.log(`! ${cur.name}: в живом каталоге нет таких конфигураций — ${lost.join('; ')}. Пропускаем.`);
    skipped++;
    continue;
  }

  console.log(`✓ ${cur.name}: характеристик ${(cur.options || []).length} → ${src.options.length}`);
  for (const g of src.options) {
    console.log(`    ${g.name}: ` + g.values.map(v => v.label
      + (v.add ? ' +' + v.add : '')
      + ((v.forStorage || []).length ? ` (только ${v.forStorage.join(', ')})` : '')).join(', '));
  }
  if (apply) db.updateProduct(cur.id, { options: src.options });
  changed++;
}

console.log(`\n${apply ? 'Обновлено' : 'Будет обновлено'} товаров: ${changed}`
  + (missing ? `, нет в каталоге магазина: ${missing}` : '')
  + (skipped ? `, пропущено из-за расхождения конфигураций: ${skipped}` : '') + '.');
if (!apply && changed) console.log('Это был предпросмотр. Чтобы записать: node sync-options.js --apply');
if (apply && changed) console.log('Дальше характеристики правятся в панели владельца: товар → «Дополнительные характеристики».');
