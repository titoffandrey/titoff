'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { products } = require('../catalog');
const {
  DEMO_SOURCE,
  RELEASE_DATES,
  REVIEW_COUNTS,
  generateDemoReviews,
  isDemoReview
} = require('../lib/demo-reviews');

const NOW = Date.parse('2026-08-02T12:00:00+03:00');
const reviews = generateDemoReviews(products, { now: NOW });

test('для каждого товара создается заданное число явно помеченных демо-отзывов', () => {
  const counts = new Map();
  for (const review of reviews) counts.set(review.productId, (counts.get(review.productId) || 0) + 1);

  assert.equal(reviews.length, 7110);
  assert.equal(Object.keys(REVIEW_COUNTS).length, products.length);
  for (const product of products) {
    assert.ok(REVIEW_COUNTS[product.id] >= 50 && REVIEW_COUNTS[product.id] <= 300);
    assert.equal(counts.get(product.id), REVIEW_COUNTS[product.id], product.id);
  }

  for (const review of reviews) {
    assert.match(review.author, / \(демо\)$/);
    assert.equal(review.demo, true);
    assert.equal(review.source, DEMO_SOURCE);
    assert.equal(review.status, 'approved');
    assert.equal(isDemoReview(review), true);
  }
});

test('даты отзывов покрывают период от релиза до текущего дня', () => {
  for (const product of products) {
    const list = reviews.filter(review => review.productId === product.id);
    const release = Date.parse(`${RELEASE_DATES[product.id]}T09:00:00+03:00`);
    const dates = list.map(review => review.createdAt);
    assert.ok(Math.min(...dates) >= release, product.id);
    assert.ok(Math.max(...dates) <= NOW, product.id);
    assert.ok(Math.max(...dates) >= NOW - 2 * 86400000, product.id);
  }
});

test('тексты разнообразны, ориентированы на сервис и не используют длинный дефис', () => {
  const unique = new Set(reviews.map(review => review.text));
  const aboutService = reviews.filter(review =>
    /(менеджер|сотрудник|магазин|заказ|достав|курьер|выдач|упаков|чате|привез)/i.test(review.text));
  const aboutGift = reviews.filter(review => /(подар|дню рождения|всей семье)/i.test(review.text));

  assert.ok(unique.size / reviews.length > 0.98);
  assert.ok(aboutService.length / reviews.length > 0.85);
  assert.ok(aboutGift.length / reviews.length > 0.2);
  assert.equal(reviews.some(review => /[—–]/.test(review.text)), false);
});

test('есть разные возрасты, оба пола и умеренно негативные оценки', () => {
  const women = reviews.filter(review => review.demoPersona.gender === 'female');
  const men = reviews.filter(review => review.demoPersona.gender === 'male');
  const ages = reviews.map(review => review.demoPersona.age);
  const ratings = new Set(reviews.map(review => review.rating));

  assert.ok(women.length > reviews.length * 0.4);
  assert.ok(men.length > reviews.length * 0.4);
  assert.ok(Math.min(...ages) <= 18);
  assert.ok(Math.max(...ages) >= 75);
  assert.deepEqual([...ratings].sort(), [3, 4, 5]);
  assert.equal(reviews.some(review => review.rating < 3), false);
  assert.ok(reviews.some(review => review.rating === 3 && /(задерж|перенос|долго не отвечал|долго не отвечала|опоздал|не тот пункт)/i.test(review.text)));
});

test('формы прошедшего времени совпадают с полом демо-персоны', () => {
  const maleForms = /(^|[^а-яё])(брал|заказал|покупал|выбрал|получил|забрал|доволен|проверил|ожидал|подключил|поставил|добавил|повесил|потерял|понервничал|накопил|обновил|сравнивал|остановился|угадал|сам)(?=$|[^а-яё])/iu;
  const femaleForms = /(^|[^а-яё])(брала|заказала|покупала|выбрала|получила|забрала|довольна|проверила|ожидала|подключила|поставила|добавила|повесила|потеряла|понервничала|накопила|обновила|сравнивала|остановилась|угадала|сама)(?=$|[^а-яё])/iu;

  assert.equal(reviews.some(review => review.demoPersona.gender === 'female' && maleForms.test(review.text)), false);
  assert.equal(reviews.some(review => review.demoPersona.gender === 'male' && femaleForms.test(review.text)), false);
});

test('команда обновления сохраняет реальные отзывы и добавленные к демо фото', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'store-demo-reviews-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const reviewsFile = path.join(dir, 'reviews.json');
  const script = path.join(__dirname, '..', 'scripts', 'demo-reviews.js');
  fs.writeFileSync(reviewsFile, JSON.stringify([
    { id: 'demo-iphone-17-pro-max-001', demo: true, photos: ['added-by-owner.webp'] },
    { id: 'real-review', productId: 'iphone-17', author: 'Покупатель', photos: [], status: 'approved' },
    { id: 'r1', productId: 'iphone-17', author: 'Старое демо', photos: [], status: 'approved' }
  ]));

  execFileSync(process.execPath, [script, '--apply'], {
    env: Object.assign({}, process.env, { STORE_DATA_DIR: dir })
  });
  let stored = JSON.parse(fs.readFileSync(reviewsFile, 'utf8'));
  assert.equal(stored.length, reviews.length + 1);
  assert.ok(stored.some(review => review.id === 'real-review'));
  assert.equal(stored.some(review => review.id === 'r1'), false);
  assert.deepEqual(stored.find(review => review.id === 'demo-iphone-17-pro-max-001').photos, ['added-by-owner.webp']);

  execFileSync(process.execPath, [script, '--remove'], {
    env: Object.assign({}, process.env, { STORE_DATA_DIR: dir })
  });
  stored = JSON.parse(fs.readFileSync(reviewsFile, 'utf8'));
  assert.deepEqual(stored.map(review => review.id), ['real-review']);
});
