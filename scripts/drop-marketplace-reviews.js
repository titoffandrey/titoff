#!/usr/bin/env node
/*
 * Убрать с витрины привезённые отзывы, которые называют чужую площадку.
 *
 *   STORE_DATA_DIR=/var/lib/apple-store node scripts/drop-marketplace-reviews.js
 *   STORE_DATA_DIR=/var/lib/apple-store node scripts/drop-marketplace-reviews.js --apply
 *
 * Зачем понадобился. Фильтр при заливке (`scripts/import-ozon-reviews.js`)
 * появился позже первых выгрузок, поэтому на витрине осталось то, что успело
 * приехать до него: «заказывала на озоне», «спасибо команде Озон». Это рассказ о
 * покупке в другом магазине под нашей же карточкой.
 *
 * Правило одно на оба места — `lib/marketplace.js`.
 *
 * ТРОГАЕМ ТОЛЬКО ПРИВЕЗЁННЫЕ отзывы (`source` и не `demo`), и это не
 * перестраховка:
 *
 * - **отзыв покупателя не удаляем никогда.** Восстановить его неоткуда: ночная
 *   копия старше самого отзыва, а больше он нигде не лежит. Ровно так 7 сентября
 *   2026 пропал живой отзыв, и с тех пор обычный конец разбора очереди —
 *   «Прочитано», а не «Удалить»;
 * - **демо-отзыв площадку не называет по построению** — это отдельное правило
 *   генератора, закреплённое тестом. Попади он под фильтр, дело было бы в
 *   генераторе, а не в витрине, и чинить надо было бы там.
 *
 * Идемпотентен: второй прогон находить уже нечего.
 *
 * После удаления даты стоит раздать заново
 * (`node scripts/shift-review-dates.js --apply`): мест под ролики в ленте
 * столько, сколько страниц у товара, а страниц стало меньше.
 */
const db = require('../lib/db');
const { mentionsMarketplace } = require('../lib/marketplace');

const APPLY = process.argv.includes('--apply');

const reviews = db.getReviews();
const doomed = reviews.filter(rv =>
  rv.source && !rv.demo && mentionsMarketplace(rv.text));

if (!doomed.length) {
  console.log(`Отзывов с упоминанием чужой площадки нет — просмотрено ${reviews.length}.`);
  process.exit(0);
}

// Сколько у кого — чтобы было видно, у какой карточки лента похудеет заметно.
const byProduct = new Map();
for (const rv of doomed) {
  byProduct.set(rv.productId, (byProduct.get(rv.productId) || 0) + 1);
}
const order = [...byProduct.entries()].sort((a, b) => b[1] - a[1]);

console.log(`Найдено ${doomed.length} привезённых отзывов с упоминанием чужой площадки` +
  ` (просмотрено ${reviews.length}).`);
for (const [productId, n] of order) {
  const product = db.getProduct(productId);
  const left = db.reviewsForProduct(productId, true).length - n;
  console.log(`  ${String(n).padStart(4)}  ${productId}` +
    `${product ? '' : '  (товара уже нет)'}  → останется ${left}`);
}

console.log('\nПримеры:');
for (const rv of doomed.slice(0, 5)) {
  console.log(`  • ${rv.productId}: ${String(rv.text).replace(/\s+/g, ' ').slice(0, 90)}`);
}

if (!APPLY) {
  console.log('\nЭто только просмотр. Удалить — тот же вызов с --apply.');
  process.exit(0);
}

// Удаляем по одному: `deleteReview` — единственное место, которое знает про ВСЕ
// файлы отзыва (снимки, ролики, кадры-заставки и превью). Свой обход списка
// файлов здесь стал бы второй копией этого знания, а забытый ролик остался бы в
// хранилище навсегда.
let gone = 0;
for (const rv of doomed) {
  db.deleteReview(rv.id);
  gone++;
  if (gone % 50 === 0) console.log(`  удалено ${gone} из ${doomed.length}…`);
}

console.log(`\nУдалено отзывов: ${gone}. Осталось всего: ${db.getReviews().length}.`);
console.log('Теперь раздайте даты заново: node scripts/shift-review-dates.js --apply');
