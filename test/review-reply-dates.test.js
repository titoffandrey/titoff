'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { shiftedReply } = require('../lib/review-reply-dates');

const ROOT = path.join(__dirname, '..');
const NOW = Date.parse('2026-09-09T12:00:00+03:00');
const DAY = 86400000;

// Любые команды с хранилищем работают в отдельном процессе и временном
// каталоге: тесты не подключают db с рабочим STORE_DATA_DIR.
function fixture(t, reviews) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'store-reply-dates-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'reviews.json');
  const clock = path.join(dir, 'clock.js');
  fs.writeFileSync(file, JSON.stringify(reviews, null, 2) + '\n');
  fs.writeFileSync(clock, `Date.now = () => ${NOW};\n`);
  const options = {
    cwd: ROOT,
    env: Object.assign({}, process.env, { STORE_DATA_DIR: dir }),
    encoding: 'utf8'
  };
  return {
    file,
    body: () => fs.readFileSync(file, 'utf8'),
    read: () => JSON.parse(fs.readFileSync(file, 'utf8')),
    run: code => JSON.parse(execFileSync(process.execPath, ['-e', code], options)),
    cli: (script, ...args) => execFileSync(process.execPath,
      ['--require', clock, path.join(ROOT, 'scripts', script), ...args], options)
  };
}

test('дата ответа сохраняет допустимую задержку, ограничена отзывом и текущим временем', () => {
  const review = Object.freeze({
    createdAt: NOW - 20 * DAY,
    reply: Object.freeze({ at: NOW - 18 * DAY, text: 'Спасибо!', author: 'Магазин' })
  });
  assert.deepEqual(shiftedReply(review, NOW - 10 * DAY, NOW), {
    at: NOW - 8 * DAY, text: 'Спасибо!', author: 'Магазин'
  });
  assert.equal(shiftedReply(review, NOW, NOW).at, NOW);
  assert.equal(review.reply.at, NOW - 18 * DAY);
  assert.equal(shiftedReply(review, review.createdAt, NOW), review.reply);

  const backwards = { createdAt: NOW - 3 * DAY, reply: { at: NOW - 4 * DAY, text: 'Ответ' } };
  assert.equal(shiftedReply(backwards, NOW - 2 * DAY, NOW).at, NOW - 2 * DAY);
  assert.equal(shiftedReply(backwards, NOW + DAY, NOW).at, NOW);

  const numericString = { createdAt: String(NOW - 20 * DAY), reply: { at: String(NOW - 18 * DAY) } };
  assert.equal(shiftedReply(numericString, NOW - 10 * DAY, NOW).at, NOW - 8 * DAY);
  assert.equal(shiftedReply(numericString, numericString.createdAt, NOW), numericString.reply);

  for (const createdAt of [undefined, 'invalid', 0, -1, Infinity]) {
    const missingPreviousDate = { createdAt, reply: { at: NOW - DAY } };
    assert.equal(shiftedReply(missingPreviousDate, NOW - 2 * DAY, NOW), missingPreviousDate.reply);
  }
  assert.equal(shiftedReply({}, NOW, NOW), undefined);
  for (const at of [undefined, null, 0, -1, 'invalid', Infinity, NaN]) {
    const invalid = { createdAt: NOW - DAY, reply: { at, text: 'Без корректной даты' } };
    assert.equal(shiftedReply(invalid, NOW, NOW), invalid.reply);
  }
});

test('ночной сдвиг исправляет будущее и ранние ответы, сохраняет задержку и не накапливается', t => {
  const before = [
    { id: 'latest', productId: 'phone', sourceDate: NOW - 60 * DAY, createdAt: NOW - 10 * DAY,
      reply: { at: NOW - 5 * DAY, text: 'Самый свежий ответ', author: 'Магазин' } },
    { id: 'older', productId: 'phone', sourceDate: NOW - 70 * DAY, createdAt: NOW - 20 * DAY,
      reply: { at: NOW - 18 * DAY, text: 'Ответ через два дня' } },
    { id: 'numeric-string', productId: 'phone', sourceDate: NOW - 90 * DAY, createdAt: NOW - 40 * DAY,
      reply: { at: String(NOW - 39 * DAY), text: 'Ответ через день' } },
    { id: 'unmanaged', productId: 'hidden-watch', status: 'pending', createdAt: NOW - 4 * DAY,
      reply: { at: NOW - 5 * DAY, text: 'Ответ раньше отзыва' } }
  ];
  const store = fixture(t, before);
  const result = store.run(`
    const assert = require('node:assert/strict');
    const fs = require('fs');
    const path = require('path');
    const db = require('./lib/db');
    const { shift, preview } = require('./scripts/shift-review-dates');
    const original = JSON.stringify(db.getReviews());
    const projected = preview(${NOW});
    assert.equal(JSON.stringify(db.getReviews()), original, 'preview изменил кэш отзывов');
    const first = shift(${NOW});
    const file = path.join(process.env.STORE_DATA_DIR, 'reviews.json');
    const inode = fs.statSync(file).ino;
    const second = shift(${NOW});
    assert.equal(fs.statSync(file).ino, inode, 'повторный запуск перезаписал файл');
    console.log(JSON.stringify({ projected, first, second, remaining: preview(${NOW}) }));
  `);
  assert.deepEqual(result, { projected: 4, first: 4, second: 0, remaining: 0 });
  const expected = structuredClone(before);
  expected[0].createdAt = NOW;
  expected[0].reply.at = NOW;
  expected[1].createdAt = NOW - 10 * DAY;
  expected[1].reply.at = NOW - 8 * DAY;
  expected[2].createdAt = NOW - 30 * DAY;
  expected[2].reply.at = NOW - 29 * DAY;
  expected[3].reply.at = expected[3].createdAt;
  assert.deepEqual(store.read(), expected);
});

test('ошибочные ответы исправляются и при пустом плане сдвига дат отзывов', t => {
  const before = [
    { id: 'already-current', productId: 'phone', sourceDate: NOW - 30 * DAY, createdAt: NOW,
      reply: { at: NOW + DAY, text: 'Ответ из будущего' } },
    { id: 'real', createdAt: NOW - 3 * DAY,
      reply: { at: NOW - 4 * DAY, text: 'Ранний ответ' } }
  ];
  const store = fixture(t, before);
  const result = store.run(`
    const db = require('./lib/db');
    const { plannedDates } = require('./lib/review-dates');
    const { shift, preview } = require('./scripts/shift-review-dates');
    const planned = plannedDates(db.getReviews(), ${NOW}).size;
    const projected = preview(${NOW});
    console.log(JSON.stringify({ planned, projected, changed: shift(${NOW}) }));
  `);
  assert.deepEqual(result, { planned: 0, projected: 2, changed: 2 });
  const expected = structuredClone(before);
  expected[0].reply.at = NOW;
  expected[1].reply.at = expected[1].createdAt;
  assert.deepEqual(store.read(), expected);
});

test('режим ремонта меняет только ошибочные даты ответов, а предварительный просмотр не пишет файл', t => {
  const before = [
    { id: 'future', productId: 'phone', sourceDate: NOW - 60 * DAY, createdAt: NOW - 10 * DAY,
      status: 'approved', photos: ['photo.webp'], reply: { at: NOW + 60 * DAY, text: 'Ответ', by: 'admin' } },
    { id: 'backwards', productId: 'hidden-watch', createdAt: NOW - 3 * DAY,
      status: 'pending', reply: { at: NOW - 4 * DAY, text: 'Другой ответ' } },
    { id: 'valid', sourceDate: NOW - 70 * DAY, createdAt: NOW - 20 * DAY,
      reply: { at: String(NOW - 19 * DAY), text: 'Корректный ответ' } },
    { id: 'no-reply', createdAt: NOW - DAY, text: 'Без ответа' }
  ];
  const store = fixture(t, before);
  const originalBody = store.body();
  assert.equal(store.run(`
    const { preview } = require('./scripts/shift-review-dates');
    console.log(JSON.stringify(preview(${NOW}, { repairRepliesOnly: true })));
  `), 2);
  assert.match(store.cli('shift-review-dates.js', '--repair-replies'), /: 2(?:\s|$)/);
  assert.equal(store.body(), originalBody);
  assert.match(store.cli('shift-review-dates.js', '--repair-replies', '--apply'), /: 2(?:\s|$)/);
  const expected = structuredClone(before);
  expected[0].reply.at = NOW;
  expected[1].reply.at = expected[1].createdAt;
  assert.deepEqual(store.read(), expected);
  const inode = fs.statSync(store.file).ino;
  assert.match(store.cli('shift-review-dates.js', '--repair-replies', '--apply'), /: 0(?:\s|$)/);
  assert.equal(fs.statSync(store.file).ino, inode);
});

test('пересборка демо сохраняет ответ и переносит его вместе с отзывом в допустимый интервал', t => {
  const { products } = require('../catalog');
  const { generateDemoReviews } = require('../lib/demo-reviews');
  const product = products.find(item => item.id === 'iphone-17-pro-max');
  assert.ok(product);
  const generated = generateDemoReviews([product], { now: NOW });
  const next = generated.reduce((latest, review) => review.createdAt > latest.createdAt ? review : latest);
  const previous = {
    ...next,
    createdAt: next.createdAt - 10 * DAY,
    photos: ['owner-photo.webp'],
    reply: { at: next.createdAt - 9 * DAY, text: 'Сохранить ответ магазина', by: 'admin' }
  };
  // Ограничиваем генерацию одним товаром; остальные уже имеют импортированные отзывы.
  const real = products.filter(item => item.id !== product.id).map(item => ({
    id: `imported-${item.id}`, productId: item.id, source: 'test-import',
    createdAt: NOW - DAY, text: 'Отзыв покупателя'
  }));
  const store = fixture(t, real.concat(previous));
  store.cli('demo-reviews.js', '--apply');
  const stored = store.read();
  const refreshed = stored.find(review => review.id === previous.id);
  assert.equal(refreshed.createdAt, next.createdAt);
  assert.deepEqual(refreshed.reply, {
    ...previous.reply, at: Math.min(NOW, next.createdAt + DAY)
  });
  assert.ok(refreshed.reply.at >= refreshed.createdAt);
  assert.ok(refreshed.reply.at <= NOW);
  assert.deepEqual(refreshed.photos, previous.photos);
  for (const review of real) assert.deepEqual(stored.find(item => item.id === review.id), review);
  store.cli('demo-reviews.js', '--apply');
  assert.deepEqual(store.read(), stored);
});
