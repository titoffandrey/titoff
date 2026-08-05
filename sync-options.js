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

// Сравнивать поля напрямую нельзя: сохранение через панель дописывает значению
// умолчания (`inStock: true`, `forStorage: []`), которых в catalog.js нет. Голый
// JSON.stringify считал это расхождением, и скрипт обещал переписать половину
// каталога там, где не менялось ни цены, ни наличия. Сводим обе стороны к
// одному виду.
function normOptions(groups) {
  return JSON.stringify((groups || []).map(g => ({
    name: g.name,
    hint: g.hint || '',
    values: (g.values || []).map(v => ({
      label: v.label,
      add: Number(v.add) || 0,
      inStock: v.inStock !== false,
      forStorage: (v.forStorage || []).map(String),
      forChoice: v.forChoice || null
    }))
  })));
}
// Конфигурации накопителя переносим вместе с группами, а не отдельным скриптом:
// у Mac они привязаны к чипу («8 ТБ только с M5 Max»), и приехать на витрину
// порознь не могут — иначе привязка укажет на чип, которого там ещё нет.
function normStorages(list) {
  return JSON.stringify((list || []).map(s => ({
    label: s.label, add: Number(s.add) || 0,
    inStock: s.inStock !== false, forChoice: s.forChoice || null
  })));
}

for (const src of catalog.products) {
  if (!(src.options || []).length) continue;
  const cur = byId.get(src.id) || byName.get(src.name);
  if (!cur) { console.log('• нет в живом каталоге:', src.name); missing++; continue; }
  const stChanged = normStorages(cur.storages) !== normStorages(src.storages);
  if (normOptions(cur.options) === normOptions(src.options) && !stChanged) continue;
  // Метки конфигураций могли разойтись: тогда «только для 1 ТБ» указывало бы на
  // несуществующий вариант, и значение пропало бы с витрины навсегда. Сверяем с
  // теми метками, которые встанут после этого же прогона, — конфигурации и
  // группы едут вместе, поэтому смотреть на старые нельзя.
  const labels = new Set(((stChanged ? src.storages : cur.storages) || []).map(s => s.label));
  const lost = [];
  for (const g of src.options) {
    for (const v of g.values || []) {
      for (const only of v.forStorage || []) if (!labels.has(only)) lost.push(`${g.name} · ${v.label} → «${only}»`);
    }
  }
  // Привязка к выбору в другой группе должна указывать на существующие значения:
  // опечатка в названии чипа прячет вариант молча и навсегда.
  const byGroup = new Map(src.options.map(g => [g.name, new Set((g.values || []).map(v => v.label))]));
  for (const item of [...src.options.flatMap(g => g.values || []), ...(src.storages || [])]) {
    for (const group of Object.keys(item.forChoice || {})) {
      const known = byGroup.get(group);
      if (!known) { lost.push(`${item.label} → нет группы «${group}»`); continue; }
      for (const val of item.forChoice[group] || []) if (!known.has(val)) lost.push(`${item.label} → «${group}: ${val}»`);
    }
  }
  if (lost.length) {
    console.log(`! ${cur.name}: привязка указывает в пустоту — ${lost.join('; ')}. Пропускаем.`);
    skipped++;
    continue;
  }

  const tail = (x) => ((x.forStorage || []).length ? ` (только ${x.forStorage.join(', ')})` : '')
    + (x.forChoice ? ' (' + Object.keys(x.forChoice).map(k => k + ': ' + x.forChoice[k].join('/')).join('; ') + ')' : '');
  console.log(`✓ ${cur.name}: характеристик ${(cur.options || []).length} → ${src.options.length}`);
  if (stChanged) {
    console.log('    Конфигурации: ' + (src.storages || []).map(s => s.label + (s.add ? ' +' + s.add : '') + tail(s)).join(', '));
  }
  for (const g of src.options) {
    console.log(`    ${g.name}: ` + g.values.map(v => v.label + (v.add ? ' +' + v.add : '') + tail(v)).join(', '));
  }
  if (apply) db.updateProduct(cur.id, stChanged ? { options: src.options, storages: src.storages } : { options: src.options });
  changed++;
}

console.log(`\n${apply ? 'Обновлено' : 'Будет обновлено'} товаров: ${changed}`
  + (missing ? `, нет в каталоге магазина: ${missing}` : '')
  + (skipped ? `, пропущено из-за расхождения конфигураций: ${skipped}` : '') + '.');
if (!apply && changed) console.log('Это был предпросмотр. Чтобы записать: node sync-options.js --apply');
if (apply && changed) console.log('Дальше характеристики правятся в панели владельца: товар → «Дополнительные характеристики».');
