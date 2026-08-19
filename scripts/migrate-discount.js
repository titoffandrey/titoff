'use strict';
/*
 * Разовый перенос скидок на процент. Идемпотентный: повторный прогон ничего не
 * меняет.
 *
 * До перехода скидка была СУММОЙ: у товара лежала старая цена (`oldPrice`), а
 * рядом жила «горящая акция» со своей ценой и сроком (`hotDeal`,
 * `hotDealPrice`, `hotDealUntil`). Зачёркнутая цена варианта считалась как
 * «старая цена базовой сборки + те же доплаты», и процент выгоды таял с каждой
 * доплатой. Теперь скидка — один процент на товар, а зачёркнутая цена из него
 * выводится для каждой сборки.
 *
 * Главное правило переноса то же, что было у переезда с мультидоменности:
 * **витрина обязана выглядеть так же, как выглядела вчера**. Поэтому цена
 * товара становится той, по которой он РЕАЛЬНО продавался (у активной акции это
 * её цена — иначе снятие акции молча подняло бы ценник), а процент — тем, что
 * видел покупатель.
 *
 *   node scripts/migrate-discount.js           — показать, что изменится
 *   node scripts/migrate-discount.js --apply   — записать
 *
 * На сервере: STORE_DATA_DIR=/var/lib/apple-store node scripts/migrate-discount.js --apply
 */
const db = require('../lib/db');
const D = require('../lib/discount');

const apply = process.argv.includes('--apply');
const rub = (x) => Math.round(Number(x) || 0).toLocaleString('ru-RU') + ' ₽';

const list = db.getProducts();
let changed = 0, clean = 0;

for (const p of list) {
  const legacy = D.fromLegacy(p);
  const hasOld = p.oldPrice !== undefined || p.hotDeal !== undefined
    || p.hotDealPrice !== undefined || p.hotDealUntil !== undefined;
  const samePrice = Math.round(Number(p.price) || 0) === Math.round(legacy.price);
  const samePct = Number(p.discountPercent || 0) === legacy.percent;
  if (!hasOld && samePrice && samePct) { clean++; continue; }

  const was = `${rub(p.price)}${D.discountPct(p) ? ` (−${D.discountPct(p)}%)` : ''}`;
  const now = `${rub(legacy.price)}${legacy.percent ? ` (−${legacy.percent}%)` : ''}`;
  console.log(`✓ ${p.name}: ${was} → ${now}`);

  if (apply) db.updateProduct(p.id, { price: legacy.price, discountPercent: legacy.percent });
  changed++;
}

console.log(`\n${apply ? 'Переведено' : 'Будет переведено'} товаров: ${changed}, уже на процентах: ${clean}.`);
if (!apply && changed) console.log('Это был предпросмотр. Чтобы записать: node scripts/migrate-discount.js --apply');
