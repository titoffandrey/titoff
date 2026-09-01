'use strict';
/*
 * РАЗОВЫЙ ПЕРЕВОД ЖИВОГО КАТАЛОГА на цены БЕЗ скидки.
 *
 * Раньше `price` хранил цену СО скидкой, а зачёркнутая выводилась обратным
 * ходом. Теперь наоборот: в карточке товара лежит полная цена, а процент от неё
 * срезает промоакция (см. lib/discount.js). Пара чисел на витрине остаётся той
 * же, но выключенная акция больше не оставляет скидку внутри ценника.
 *
 *   node scripts/full-price.js           — показать, что изменится
 *   node scripts/full-price.js --apply   — записать
 *
 * Что делает:
 *
 * - у каждого товара со скидкой поднимает цену обратным ходом «цена ÷ (1 − процент)»;
 * - ТЕМ ЖЕ множителем поднимает ВСЕ доплаты — за память, ремешки, их размеры и
 *   значения доп. характеристик. Без этого шага дорогая сборка после скидки
 *   стоила бы дешевле, чем вчера: скидка режет всю сумму, а не одну базу;
 * - товары без скидки не трогает вовсе: у них цена и была полной.
 *
 * ЗАПУСКАТЬ РОВНО ОДИН РАЗ. Второй прогон поднял бы цены ещё раз, поэтому
 * скрипт ставит метку в настройках (`fullPriceAt`) и без `--force` отказывается
 * работать повторно. Метка — единственный способ отличить переведённый каталог
 * от непереведённого: в самих числах эта разница не записана никак.
 */
const db = require('./../lib/db');
const D = require('./../lib/discount');

const apply = process.argv.includes('--apply');
const force = process.argv.includes('--force');

db.ensureSeeded();

const settings = db.getSettings();
if (settings.fullPriceAt && !force) {
  console.error('Каталог уже переведён на цены без скидки '
    + new Date(settings.fullPriceAt).toLocaleString('ru-RU') + '.');
  console.error('Повторный прогон поднял бы цены второй раз. Если это правда нужно — `--force`.');
  process.exit(1);
}

const rub = (x) => (Number(x) > 0 ? Math.round(Number(x)).toLocaleString('ru-RU') + ' ₽' : '—');
// Обратный ход общий для цены и доплат: «÷ (1 − процент)» с округлением до
// десятки, тем же, каким считалась зачёркнутая цена (D.compareFor).
const up = (n, pct) => D.compareFor(Number(n) || 0, pct) || 0;

let changed = 0, without = 0, adds = 0;

for (const p of db.getProducts()) {
  const pct = D.discountPct(p);
  if (!pct) { without++; continue; }

  const patch = { price: up(p.price, pct) };
  if (p.storages) patch.storages = p.storages.map(s => Object.assign({}, s, { add: up(s.add, pct) }));
  if (p.options) {
    patch.options = p.options.map(g => Object.assign({}, g, {
      values: (g.values || []).map(v => Object.assign({}, v, { add: up(v.add, pct) }))
    }));
  }
  if (p.bands) {
    patch.bands = p.bands.map(g => Object.assign({}, g, {
      sizes: (g.sizes || []).map(x => Object.assign({}, x, { add: up(x.add, pct) })),
      options: (g.options || []).map(o => Object.assign({}, o, { add: up(o.add, pct) }))
    }));
  }
  // Сколько доплат поднялось — по ним и видно, что сборки остались в цене.
  adds += (patch.storages || []).filter(s => s.add).length
    + (patch.options || []).reduce((n, g) => n + g.values.filter(v => v.add).length, 0)
    + (patch.bands || []).reduce((n, g) => n + g.sizes.filter(x => x.add).length + g.options.filter(o => o.add).length, 0);

  console.log(`✓ ${p.name}: ${rub(p.price)} → ${rub(patch.price)} (−${pct}% даёт ${rub(D.saleFor(patch.price, pct))})`);
  if (apply) db.updateProduct(p.id, patch);
  changed++;
}

if (apply && changed) db.saveSettings({ fullPriceAt: Date.now() });

console.log(`\n${apply ? 'Переведено' : 'К переводу'} товаров: ${changed}`
  + `, поднято доплат: ${adds}`
  + `, без скидки (не трогаем): ${without}`);
if (!apply && changed) console.log('Это предпросмотр. Записать: node scripts/full-price.js --apply');
