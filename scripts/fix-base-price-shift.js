'use strict';
/*
 * Чинит товары, у которых БАЗОВОЕ значение группы доп. характеристик стало
 * платным.
 *
 * Откуда берётся поломка. В форме товара у групп («SIM-карта», «Связь», «Чип»,
 * «Оперативная память») вводится ПОЛНАЯ цена товара с этим значением, а доплата
 * считается сама. Пока редакторы пересчитывали доплату при каждой правке поля
 * «Цена», снижение базовой цены на 10 000 не двигало полные цены — вместо этого
 * доплату +10 000 получало первое, базовое значение группы. Витрина показывает
 * «база + доплата первого доступного значения» (startPrice), то есть ровно
 * прежнюю цену: правка выглядела как несохранившаяся. У товара с тремя группами
 * разница складывалась трижды, и цена на витрине не оставалась прежней, а
 * вырастала. Сами редакторы починены, этот скрипт разбирает последствия.
 *
 * Что делает: у каждой группы вычитает МИНИМАЛЬНУЮ доплату из всех её значений.
 * Тогда базовое значение снова бесплатно, разницы между вариантами сохраняются,
 * а витрина показывает ту базовую цену, которую владелец и вводил.
 *
 * Минимальную, а не первую: порядок значений мог быть изменён руками, а самое
 * дешёвое значение обязано стоять первым (`parseOptions()` отбрасывает
 * отрицательные доплаты). Ремешки (`bands`) не трогаем вовсе — у Hermès базовая
 * вариация платная законно.
 *
 *   node scripts/fix-base-price-shift.js           — показать, что изменится
 *   node scripts/fix-base-price-shift.js --apply   — записать
 *
 * Идемпотентен: после прогона минимальная доплата каждой группы равна нулю.
 */
const db = require('./../lib/db');
const R = require('./../lib/render');

const apply = process.argv.includes('--apply');
db.ensureSeeded();

const money = n => Number(n).toLocaleString('ru-RU') + ' ₽';
let changed = 0;

for (const p of db.getProducts()) {
  const groups = p.options || [];
  if (!groups.length) continue;

  const fixes = [];
  const next = groups.map(g => {
    const values = g.values || [];
    if (!values.length) return g;
    const min = Math.min(...values.map(v => Number(v.add) || 0));
    if (min <= 0) return g;
    fixes.push({ name: g.name, min });
    return Object.assign({}, g, {
      values: values.map(v => Object.assign({}, v, { add: (Number(v.add) || 0) - min }))
    });
  });
  if (!fixes.length) continue;

  // Цену витрины считаем той же функцией, что рисует карточку: своя формула
  // разошлась бы с ней на первом же товаре с распроданным вариантом.
  const before = R.startPrice(p);
  const after = R.startPrice(Object.assign({}, p, { options: next }));

  console.log(`• ${p.name}`);
  console.log(`    базовая цена в панели: ${money(p.price)}`);
  for (const f of fixes) console.log(`    «${f.name}»: снять лишние ${money(f.min)} со всех значений`);
  console.log(`    на витрине: ${money(before)} → ${money(after)}`);

  if (apply) db.updateProduct(p.id, { options: next });
  changed++;
}

if (!changed) console.log('Всё в порядке: платных базовых значений не найдено.');
else console.log(`\nТоваров ${apply ? 'исправлено' : 'к исправлению'}: ${changed}${apply ? '' : '  (запустите с --apply, чтобы записать)'}`);
