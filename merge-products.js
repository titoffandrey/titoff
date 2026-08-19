'use strict';
/*
 * Сливает две карточки живого каталога в одну — там, где у Apple один товар с
 * выбором, а у нас были две позиции:
 *   AirPods 4 и AirPods 4 с шумоподавлением  → «Версия»
 *   AirTag и AirTag (комплект 4 шт.)         → «Комплект»
 *
 * Что делает для каждой пары:
 *   1. приводит оставшийся товар к описанию из catalog.js (название, цена,
 *      тексты, доп. характеристики) — но НЕ трогает цену, если владелец задал
 *      её сам, иначе скрипт откатил бы ручную правку;
 *   2. переносит на него отзывы покупателей и фотографии второй карточки;
 *   3. удаляет вторую карточку.
 *
 * Демо-отзывы не переносятся: их набор пересобирает scripts/demo-reviews.js,
 * и после слияния он всё равно выдаст объединённой карточке свежую ленту.
 *
 * Идемпотентно: второй запуск ничего не меняет.
 *
 *   node merge-products.js            — показать, что изменится (ничего не пишет)
 *   node merge-products.js --apply    — записать изменения
 */
const db = require('./lib/db');
const catalog = require('./catalog');
const { isDemoReview } = require('./lib/demo-reviews');

const MERGES = [
  { keep: 'airpods-4', remove: 'airpods-4-anc' },
  { keep: 'airtag', remove: 'airtag-4pack' }
];

const apply = process.argv.includes('--apply');
db.ensureSeeded();

// Поля, которые слияние приводит к catalog.js. Цена в списке есть, но ручной
// оверрайд сайта живёт отдельно (в настройках домена) и не затрагивается.
const FIELDS = ['name', 'shortDesc', 'description', 'specs', 'badge', 'price', 'discountPercent', 'options'];
const same = (a, b) => JSON.stringify(a === undefined ? null : a) === JSON.stringify(b === undefined ? null : b);

let merged = 0, updated = 0, missing = 0;

for (const { keep, remove } of MERGES) {
  const src = catalog.products.find(p => p.id === keep);
  const live = db.getProduct(keep);
  const gone = db.getProduct(remove);
  if (!src) { console.log(`• нет в catalog.js: ${keep}`); missing++; continue; }
  if (!live) { console.log(`• нет в живом каталоге: ${keep} — слияние пропущено`); missing++; continue; }

  // 1. описание оставшейся карточки
  const patch = {};
  for (const field of FIELDS) if (!same(live[field], src[field])) patch[field] = src[field];
  if (Object.keys(patch).length) {
    console.log(`✓ ${live.name}: обновляем ${Object.keys(patch).join(', ')}`);
    if (patch.options) {
      for (const g of patch.options) {
        console.log(`    ${g.name}: ` + g.values.map(v => `${v.label} — ${(Number(src.price) || 0) + (v.add || 0)} ₽`).join(', '));
      }
    }
    if (apply) db.updateProduct(keep, patch);
    updated++;
  }

  if (!gone) continue;                       // вторая карточка уже слита

  // 2. отзывы покупателей и фотографии второй карточки
  const reviews = db.getReviews().filter(r => r.productId === remove);
  const real = reviews.filter(r => !isDemoReview(r));
  const photos = (gone.images || []).filter(src2 => !(db.getProduct(keep).images || []).includes(src2));
  console.log(`✓ ${gone.name} → ${live.name}: отзывов покупателей ${real.length}, демо ${reviews.length - real.length} (не переносим), фото ${photos.length}`);

  if (apply) {
    db.moveReviews(remove, keep, r => !isDemoReview(r));
    if (photos.length) {
      const cur = db.getProduct(keep);
      const imageColors = Object.assign({}, cur.imageColors || {});
      for (const file of photos) {
        // Цвет у слитой карточки может называться иначе — привязку переносим,
        // только если такой цвет у оставшегося товара действительно есть.
        const color = (gone.imageColors || {})[file];
        if (color && (cur.colors || []).some(c => c.name === color)) imageColors[file] = color;
      }
      db.updateProduct(keep, { images: (cur.images || []).concat(photos), imageColors });
    }
    db.deleteProduct(remove);
  }
  merged++;
}

console.log(`\n${apply ? 'Слито карточек' : 'Будет слито карточек'}: ${merged}`
  + (updated ? `, обновлено описаний: ${updated}` : '')
  + (missing ? `, пропущено: ${missing}` : '') + '.');
if (!apply && (merged || updated)) console.log('Это был предпросмотр. Чтобы записать: node merge-products.js --apply');
if (apply && merged) console.log('Дальше стоит обновить демо-отзывы: node scripts/demo-reviews.js --apply');
