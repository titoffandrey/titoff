'use strict';

// Добавляет или удаляет явно помеченные синтетические отзывы в живом хранилище.
// Без флага команда только показывает, сколько записей будет создано.

const fs = require('fs');
const path = require('path');
const { products } = require('../catalog');
const { generateDemoReviews, isDemoReview } = require('../lib/demo-reviews');

const DATA_DIR = process.env.STORE_DATA_DIR
  ? path.resolve(process.env.STORE_DATA_DIR)
  : path.join(__dirname, '..', 'data');
const REVIEWS_FILE = path.join(DATA_DIR, 'reviews.json');
const apply = process.argv.includes('--apply');
const remove = process.argv.includes('--remove');

if (apply && remove) {
  console.error('Выберите только один режим: --apply или --remove');
  process.exit(1);
}

function readReviews() {
  try {
    const parsed = JSON.parse(fs.readFileSync(REVIEWS_FILE, 'utf8'));
    if (!Array.isArray(parsed)) throw new Error('ожидался массив');
    return parsed;
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw new Error(`Не удалось прочитать ${REVIEWS_FILE}: ${error.message}`);
  }
}

function isLegacySeedReview(review) {
  // Старый набор r1..r23 тоже был синтетическим, но еще не имел явной метки.
  return /^r(?:[1-9]|1\d|2[0-3])$/.test(String(review && review.id || ''));
}

function writeReviews(reviews) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const temp = `${REVIEWS_FILE}.tmp-${process.pid}`;
  fs.writeFileSync(temp, JSON.stringify(reviews, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(temp, REVIEWS_FILE);
  try { fs.chmodSync(REVIEWS_FILE, 0o600); } catch (error) {}
}

const current = readReviews();
const realReviews = current.filter(review => !isDemoReview(review) && !isLegacySeedReview(review));
const currentDemoById = new Map(current.filter(isDemoReview).map(review => [review.id, review]));

if (remove) {
  writeReviews(realReviews.sort((a, b) => Number(b.createdAt || 0) - Number(a.createdAt || 0)));
  console.log(`Удалено демо-отзывов: ${current.length - realReviews.length}. Осталось отзывов покупателей: ${realReviews.length}.`);
  process.exit(0);
}

// Товары, которым привезли настоящие отзывы с площадки, демо-набор обходит
// стороной: подмешивать к ним синтетику значит разбавлять живые отзывы, ради
// которых их и заливали, а после каждой ночной пересборки они возвращались бы
// сами. Признак — поле `source` у отзыва (см. scripts/import-ozon-reviews.js).
const imported = new Set(realReviews.filter(review => review && review.source).map(review => review.productId));
const demoProducts = products.filter(product => !imported.has(product.id));
if (imported.size) {
  console.log(`Товаров с привезёнными отзывами: ${imported.size} — демо-набор для них не создаётся.`);
}

const generated = generateDemoReviews(demoProducts, { now: Date.now() }).map(review => {
  // Идентификаторы стабильны, поэтому добавленные вручную фото не пропадут при
  // повторном обновлении дат или текстов демо-набора.
  const previous = currentDemoById.get(review.id);
  if (previous && Array.isArray(previous.photos)) review.photos = previous.photos.slice();
  // Ответ магазина писал человек, и пересборка набора его переживает — иначе он
  // пропадал бы с витрины в ближайшую ночь (cron в 01:20 UTC), а автор ответа
  // узнавал бы об этом случайно.
  if (previous && previous.reply) review.reply = previous.reply;
  return review;
});
if (!apply) {
  console.log(`Будет создано ${generated.length} демо-отзывов для ${demoProducts.length} товаров.`);
  console.log('Для записи в живой каталог запустите: node scripts/demo-reviews.js --apply');
  process.exit(0);
}

const merged = realReviews.concat(generated)
  .sort((a, b) => Number(b.createdAt || 0) - Number(a.createdAt || 0));
writeReviews(merged);
console.log(`Готово. Добавлено ${generated.length} демо-отзывов, сохранено отзывов покупателей: ${realReviews.length}.`);
