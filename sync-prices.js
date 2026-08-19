'use strict';
/*
 * Переносит цену и процент скидки из catalog.js в живой каталог на сервере.
 * Фото, заказы, отзывы и порядок карточек не трогает — как sync-options.js,
 * sync-bands.js и sync-specs.js.
 *
 * Нужен потому, что товары лежат в data/products.json и засеиваются из
 * catalog.js только при первом запуске: git pull сам по себе новую цену
 * на витрину не привезёт.
 *
 * Доплаты за память и за физическую SIM живут в storages/options — их
 * переносит sync-options.js, поэтому после смены прайса нужны оба прогона.
 *
 *   node sync-prices.js            — показать, что изменится (ничего не пишет)
 *   node sync-prices.js --apply    — записать изменения
 */
const db = require('./lib/db');
const catalog = require('./catalog');
const D = require('./lib/discount');

const apply = process.argv.includes('--apply');
db.ensureSeeded();

const live = db.getProducts();
const byId = new Map(live.map(p => [p.id, p]));
const byName = new Map(live.map(p => [p.name, p]));

/* Скидка переносится ПРОЦЕНТОМ, а не суммой старой цены: зачёркнутая цена из
 * него выводится для каждой сборки (lib/discount.js), и отдельного числа для
 * неё в каталоге больше нет. Прежние поля (`oldPrice`, `hotDealPrice`,
 * `hotDealUntil`) сняты вместе с горящими скидками.
 */
const money = (x) => (Number(x) > 0 ? Math.round(Number(x)) : 0);
const rub = (x) => (money(x) ? money(x).toLocaleString('ru-RU') + ' ₽' : '—');
const pctOf = (x) => {
  const n = Math.round(Number(x));
  return Number.isFinite(n) && n > 0 && n <= D.MAX_PCT ? n : 0;
};

let changed = 0, missing = 0, skipped = 0;

for (const src of catalog.products) {
  const cur = byId.get(src.id) || byName.get(src.name);
  if (!cur) { console.log('• нет в живом каталоге:', src.name); missing++; continue; }

  const next = { price: money(src.price), discountPercent: pctOf(src.discountPercent) };
  // У товара на сервере процента может ещё не быть — тогда он выводится из
  // сохранённой пары цен, ровно как это делает витрина. Иначе первый же прогон
  // отчитался бы об изменении скидки у каждого товара подряд.
  const now = { price: money(cur.price), discountPercent: D.discountPct(cur) };
  const diff = Object.keys(next).filter(k => next[k] !== now[k]);
  if (!diff.length) continue;

  if (!next.price) { console.log(`! ${cur.name}: цена в catalog.js нулевая. Пропускаем.`); skipped++; continue; }

  const show = (k, v) => (k === 'price' ? rub(v) : (v ? '−' + v + '%' : 'нет'));
  console.log(`✓ ${cur.name}: ` + diff.map(k => `${k} ${show(k, now[k])} → ${show(k, next[k])}`).join(', '));

  if (apply) db.updateProduct(cur.id, { price: next.price, discountPercent: next.discountPercent });
  changed++;
}

console.log(`\n${apply ? 'Обновлено' : 'Будет обновлено'} товаров: ${changed}`
  + (missing ? `, нет в каталоге магазина: ${missing}` : '')
  + (skipped ? `, пропущено из-за нулевой цены: ${skipped}` : '') + '.');
if (!apply && changed) console.log('Это был предпросмотр. Чтобы записать: node sync-prices.js --apply');
if (apply && changed) console.log('Доплаты за память и SIM едут отдельно: node sync-options.js --apply');
