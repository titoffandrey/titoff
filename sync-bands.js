'use strict';
/*
 * Переносит ремешки (поле bands) из catalog.js в живой каталог на сервере.
 * Цены, фото, заказы и отзывы не трогает — как и sync-specs.js.
 *
 * Нужен потому, что товары лежат в data/products.json и засеиваются из
 * catalog.js только при первом запуске: git pull сам по себе ремешки
 * на сервере не добавит.
 *
 *   node sync-bands.js            — показать, что изменится (ничего не пишет)
 *   node sync-bands.js --apply    — записать изменения
 */
const db = require('./lib/db');
const catalog = require('./catalog');

const apply = process.argv.includes('--apply');
db.ensureSeeded();

const live = db.getProducts();
const byId = new Map(live.map(p => [p.id, p]));
const byName = new Map(live.map(p => [p.name, p]));

const count = list => (list || []).reduce((a, g) => a + (g.options || []).length, 0);
let changed = 0, missing = 0;

for (const src of catalog.products) {
  if (!(src.bands || []).length) continue;
  const cur = byId.get(src.id) || byName.get(src.name);
  if (!cur) { console.log('• нет в живом каталоге:', src.name); missing++; continue; }
  if (JSON.stringify(cur.bands || []) === JSON.stringify(src.bands)) continue;

  console.log(`✓ ${cur.name}: коллекций ${(cur.bands || []).length} → ${src.bands.length}, вариаций ${count(cur.bands)} → ${count(src.bands)}`);
  for (const g of src.bands) {
    console.log(`    ${g.name} (${(g.sizes || []).map(s => s.label).join(', ')}): `
      + g.options.map(o => `${o.name}${o.add ? ' +' + o.add : ''}`).join(', '));
  }
  if (apply) db.updateProduct(cur.id, { bands: src.bands });
  changed++;
}

console.log(`\n${apply ? 'Обновлено' : 'Будет обновлено'} товаров: ${changed}` +
  (missing ? `, нет в каталоге магазина: ${missing}` : '') + '.');
if (!apply && changed) console.log('Это был предпросмотр. Чтобы записать: node sync-bands.js --apply');
if (apply && changed) console.log('Фотографии вариаций загружаются в панели владельца: товар → фото → выбрать ремешок в списке.');
