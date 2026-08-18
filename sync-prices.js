'use strict';
/*
 * Переносит цены (price, oldPrice, hotDealPrice) из catalog.js в живой каталог
 * на сервере. Фото, заказы, отзывы и порядок карточек не трогает — как
 * sync-options.js, sync-bands.js и sync-specs.js.
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

const apply = process.argv.includes('--apply');
db.ensureSeeded();

const live = db.getProducts();
const byId = new Map(live.map(p => [p.id, p]));
const byName = new Map(live.map(p => [p.name, p]));

// hotDealUntil намеренно не переносим: в catalog.js это `now + 4 * DAY`,
// то есть каждый прогон сдвигал бы конец акции вперёд на четыре дня от
// сегодняшнего числа. Срок задаётся в панели, скрипт правит только суммы.
const money = (x) => (Number(x) > 0 ? Math.round(Number(x)) : 0);
const rub = (x) => (money(x) ? money(x).toLocaleString('ru-RU') + ' ₽' : '—');

let changed = 0, missing = 0, skipped = 0;
const stale = [];

for (const src of catalog.products) {
  const cur = byId.get(src.id) || byName.get(src.name);
  if (!cur) { console.log('• нет в живом каталоге:', src.name); missing++; continue; }

  // Цену по акции переносим только там, где акцию не выключали: у
  // выключенной товар живёт по базовой цене, и вписывать ей сумму из catalog.js
  // значит воскрешать снятую скидку. А у включённой сумму поправить обязательно —
  // иначе после снижения базовой цены «скидка» окажется дороже товара.
  const deal = cur.hotDeal === true;
  const next = { price: money(src.price), oldPrice: money(src.oldPrice), hotDealPrice: deal ? money(src.hotDealPrice) : money(cur.hotDealPrice) };
  const now = { price: money(cur.price), oldPrice: money(cur.oldPrice), hotDealPrice: money(cur.hotDealPrice) };
  const diff = Object.keys(next).filter(k => next[k] !== now[k]);
  if (!diff.length) continue;

  // Те же правила, что у validateProduct() в server.js: старая цена выше
  // базовой, цена по акции ниже. Иначе на витрине выйдет «скидка» вверх.
  // У выключенной акции сумма на витрину не выходит вовсе, поэтому проверяем её
  // только у включённой: иначе давняя завершённая скидка держала бы базовую цену
  // и не давала её снизить.
  const bad = [];
  if (next.oldPrice && next.oldPrice <= next.price) bad.push(`старая цена ${rub(next.oldPrice)} не выше базовой ${rub(next.price)}`);
  if (deal && next.hotDealPrice && next.hotDealPrice >= next.price) bad.push(`цена по акции ${rub(next.hotDealPrice)} не ниже базовой ${rub(next.price)}`);
  if (bad.length) { console.log(`! ${cur.name}: ${bad.join('; ')}. Пропускаем.`); skipped++; continue; }
  if (!deal && next.hotDealPrice && next.hotDealPrice >= next.price) {
    stale.push(`${cur.name}: ${rub(next.hotDealPrice)} при базовой ${rub(next.price)}`);
  }

  console.log(`✓ ${cur.name}: ` + diff.map(k => `${k} ${rub(now[k])} → ${rub(next[k])}`).join(', '));

  if (apply) db.updateProduct(cur.id, { price: next.price, oldPrice: next.oldPrice || null, hotDealPrice: next.hotDealPrice || null });
  changed++;
}

console.log(`\n${apply ? 'Обновлено' : 'Будет обновлено'} товаров: ${changed}`
  + (missing ? `, нет в каталоге магазина: ${missing}` : '')
  + (skipped ? `, пропущено из-за неверной пары цен: ${skipped}` : '') + '.');
if (stale.length) {
  console.log('\nУ этих товаров лежит цена выключенной акции выше новой базовой — включать её в панели нельзя, сначала поправить сумму:');
  for (const line of stale) console.log('  • ' + line);
}
if (!apply && changed) console.log('Это был предпросмотр. Чтобы записать: node sync-prices.js --apply');
if (apply && changed) console.log('Доплаты за память и SIM едут отдельно: node sync-options.js --apply');
