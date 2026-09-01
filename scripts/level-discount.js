'use strict';
/*
 * Выравнивает скидку живого каталога: у каждого товара, где скидка ЕСТЬ,
 * процент становится одним и тем же (по умолчанию 20).
 *
 * Зачем отдельный скрипт, когда есть sync-prices.js. Тот переносит из
 * catalog.js ПАРУ «цена + процент», а живые цены с каталогом давно разошлись:
 * их правят в панели и прайсом поставщика. Прогон sync-prices.js вернул бы
 * витрине каталожные цены (на боевых данных это 20 карточек, от «AirTag
 * 3 490 → 1 000» до «iPad Pro 13" 134 990 → 79 190») — то есть заодно переписал
 * бы ценник, которого никто не просил трогать.
 *
 *   node scripts/level-discount.js              — показать, что изменится
 *   node scripts/level-discount.js --apply      — записать
 *   node scripts/level-discount.js --percent 25 — другой процент
 *
 * Что он НЕ делает, и это главное:
 *
 * - не трогает цену продажи. `price` — это уже цена со скидкой (lib/discount.js),
 *   поэтому покупатель платит ровно столько же, сколько платил вчера; вверх
 *   едет только выведенная из процента зачёркнутая цена;
 * - не раздаёт скидку тем, у кого её нет. «Скидка витрины» и есть скидка
 *   промокода по умолчанию, и товар без неё продаётся по своей цене осознанно —
 *   выдать ему 20% значило бы поднять ценник на четверть.
 *
 * Идемпотентен: повторный прогон отчитывается «к правке 0».
 */
const db = require('./../lib/db');
const D = require('./../lib/discount');

const apply = process.argv.includes('--apply');
const at = process.argv.indexOf('--percent');
const target = at > -1 ? Math.round(Number(process.argv[at + 1])) : 20;

if (!Number.isFinite(target) || target < 1 || target > D.MAX_PCT) {
  console.error(`Процент должен быть числом от 1 до ${D.MAX_PCT}.`);
  process.exit(1);
}

db.ensureSeeded();

const rub = (x) => (Number(x) > 0 ? Math.round(Number(x)).toLocaleString('ru-RU') + ' ₽' : '—');

let changed = 0, already = 0, without = 0;

for (const p of db.getProducts()) {
  const pct = D.discountPct(p);
  if (!pct) { without++; continue; }
  if (pct === target) { already++; continue; }

  /* Цена в карточке — БЕЗ скидки, её скрипт не трогает; меняется то, что платит
   * покупатель при работающей промоакции. Раньше было наоборот: `price` хранил
   * цену со скидкой, и правка процента двигала лишь зачёркнутую сумму. */
  console.log(`✓ ${p.name}: скидка −${pct}% → −${target}%`
    + `, цена без скидки ${rub(D.basePrice(p))} (не меняется)`
    + `, с промоакцией ${rub(D.salePrice(p))} → ${rub(D.saleFor(D.basePrice(p), target))}`);

  // Только процент: partial-обновление цену и всё остальное не затрагивает.
  if (apply) db.updateProduct(p.id, { discountPercent: target });
  changed++;
}

console.log(`\n${apply ? 'Изменено' : 'К правке'} товаров: ${changed}`
  + (already ? `, уже по −${target}%: ${already}` : '')
  + (without ? `, без скидки (не трогаем): ${without}` : '') + '.');
if (!apply && changed) console.log('Это был предпросмотр. Чтобы записать: node scripts/level-discount.js --apply');
