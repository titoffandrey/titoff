'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const A = require('../lib/admin-views');
const images = require('../lib/images');

const SETTINGS = { storeName: 'Магазин', currency: '₽', currencyPosition: 'after' };

function uploads(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'admin-photo-loading-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function decode(value) {
  return value.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

function attributes(tag) {
  return Object.fromEntries([...tag.matchAll(/\s([\w:-]+)(?:="([^"]*)")?/g)]
    .map(match => [match[1], decode(match[2] || '')]));
}

function render(product, dir) {
  return A.productForm(SETTINGS, {
    UPLOAD_DIR: dir,
    categories: () => ['Apple Watch'],
    visibleCategories: () => ['Apple Watch'],
    pendingReviewCount: () => 0
  }, product);
}

function selectedValues(html) {
  const values = new Map();
  for (const select of html.matchAll(/<select\b([^>]*)>([\s\S]*?)<\/select>/g)) {
    const name = attributes(select[1]).name;
    if (!name || !/^img(?:color|band):/.test(name)) continue;
    const options = [...select[2].matchAll(/<option\b[^>]*>/g)].map(match => attributes(match[0]));
    const selected = options.find(option => Object.hasOwn(option, 'selected')) || options[0];
    assert.ok(!values.has(name), 'каждая привязка отправляется ровно один раз');
    values.set(name, selected.value);
  }
  return values;
}

test('превью выбирает самую маленькую существующую копию и сохраняет исходник при их отсутствии', t => {
  const dir = uploads(t);
  const cases = [
    { file: 'all.webp', sizes: [640, 480, 320, 200], expected: 'all-c200.webp' },
    { file: 'medium.jpg', sizes: [640, 480, 320], expected: 'medium-c320.webp' },
    { file: 'large.png', sizes: [640, 480], expected: 'large-c480.webp' },
    { file: 'only.webp', sizes: [640], expected: 'only-c640.webp' },
    { file: 'original.webp', sizes: [], expected: 'original.webp' },
    { file: 'already-c200.webp', sizes: [], expected: 'already-c200.webp' }
  ];
  for (const item of cases) {
    fs.writeFileSync(path.join(dir, item.file), '');
    for (const size of item.sizes) fs.writeFileSync(path.join(dir, images.cardName(item.file, size)), '');
  }
  for (const item of cases) assert.equal(images.previewName(dir, item.file), item.expected);
  assert.equal(images.previewName(path.join(dir, 'missing'), 'old.webp'), 'old.webp');
  assert.equal(images.previewName(undefined, 'old.webp'), 'old.webp');
});

test('100 фото часов остаются в форме с порядком и привязками, но не начинают загрузку до открытия группы', t => {
  const dir = uploads(t);
  const colors = [{ name: 'Чёрный титан', hex: '#111111' }, { name: 'Натуральный титан', hex: '#cccccc' }];
  const bands = [{ name: 'Спортивный', sizes: [{ label: 'M/L' }], options: [
    { name: 'Синий', hex: '#0000ff' }, { name: 'Белый', hex: '#ffffff' }
  ] }];
  const product = {
    id: 'watch', name: 'Часы', category: 'Apple Watch', price: 50000,
    images: Array.from({ length: 100 }, (_, i) => `watch-${i}.webp`),
    imageColors: {}, imageBands: {}, colors, bands, storages: [], options: []
  };
  const previews = new Map();
  for (const [i, file] of product.images.entries()) {
    // Есть общие фото, фото корпуса и фото одного ремешка на разных корпусах.
    if (i % 3) product.imageColors[file] = colors[i % 3 - 1].name;
    if (i % 4) product.imageBands[file] = `${bands[0].name}|${bands[0].options[i % 2].name}`;
    fs.writeFileSync(path.join(dir, file), '');
    const preview = images.cardName(file, i % 2 ? 320 : 200);
    fs.writeFileSync(path.join(dir, preview), '');
    fs.writeFileSync(path.join(dir, images.cardName(file, 640)), '');
    previews.set(file, '/uploads/' + preview);
  }
  const html = render(product, dir);
  const groups = [...html.matchAll(/<details\b[^>]*class="img-group"[^>]*>/g)];
  assert.equal(groups.length, 9, 'общие, два корпуса и два ремешка на каждом корпусе, включая общий');
  for (const group of groups) assert.equal(Object.hasOwn(attributes(group[0]), 'open'), false);
  assert.equal([...html.matchAll(/<summary\b[^>]*class="img-group-head"[^>]*>/g)].length, groups.length);

  const chips = [...html.matchAll(/<div\b[^>]*class="img-chip(?: is-main)?"[^>]*>/g)]
    .map(match => attributes(match[0]));
  assert.equal(chips.length, product.images.length);
  assert.deepEqual(chips.map(chip => chip['data-src']).sort(), [...product.images].sort());
  assert.equal(chips.filter(chip => chip.class.split(' ').includes('is-main')).length, 1);
  assert.equal(chips.find(chip => chip.class.split(' ').includes('is-main'))['data-src'], product.images[0]);

  const photos = [...html.matchAll(/<img\b[^>]*>/g)].map(match => attributes(match[0]));
  assert.equal(photos.length, product.images.length);
  assert.deepEqual(photos.map(photo => photo['data-src']).sort(), [...previews.values()].sort());
  for (const photo of photos) {
    assert.equal(Object.hasOwn(photo, 'src'), false, 'при открытии редактора запрос фото ещё не создаётся');
    assert.equal(Object.hasOwn(photo, 'srcset'), false);
    assert.equal(photo.loading, 'lazy');
    assert.equal(photo.decoding, 'async');
    assert.equal(photo.width, '92');
    assert.equal(photo.height, '92');
    assert.equal(photo.alt, '');
  }

  const values = selectedValues(html);
  assert.equal(values.size, product.images.length * 2);
  for (const file of product.images) {
    assert.equal(values.get('imgcolor:' + file), product.imageColors[file] || '');
    assert.equal(values.get('imgband:' + file), product.imageBands[file] || '');
  }
  const manager = html.match(/<div\b[^>]*id="photo-manager"[^>]*>/);
  assert.ok(manager);
  assert.deepEqual(JSON.parse(attributes(manager[0])['data-order']), product.images);
});

test('старый товар без уменьшенных копий получает отложенные исходники', t => {
  const dir = uploads(t);
  const product = {
    id: 'old', name: 'Старый товар', category: 'Apple Watch', price: 1000,
    images: ['front.jpg', 'back.png'], colors: [], bands: [], storages: [], options: []
  };
  const html = render(product, dir);
  const photos = [...html.matchAll(/<img\b[^>]*>/g)].map(match => attributes(match[0]));
  assert.deepEqual(photos.map(photo => photo['data-src']), ['/uploads/front.jpg', '/uploads/back.png']);
  for (const photo of photos) {
    assert.equal(Object.hasOwn(photo, 'src'), false);
    assert.equal(Object.hasOwn(photo, 'srcset'), false);
  }
  const values = selectedValues(html);
  assert.equal(values.size, 2);
  assert.deepEqual([...values.keys()], ['imgcolor:front.jpg', 'imgcolor:back.png']);
});
