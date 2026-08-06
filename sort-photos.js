'use strict';
/*
 * Кадры, где товар срезан краем, уводит в конец галереи товара.
 *
 * Часть фотографий с buy-страниц Apple — крупные планы детали: угол корпуса,
 * блок камер, экран с интерфейсом. Сами по себе они полезны, но в ленте между
 * обычными ракурсами читаются как «фото обрезали». Место таким кадрам — после
 * общих видов, ровно как у Apple: сначала товар целиком, потом детали.
 *
 * Порядок меняется СТАБИЛЬНО, поэтому внутри каждой цветовой группы и каждой
 * вариации ремешка срезанные кадры тоже оказываются последними — галерея
 * фильтрует список по варианту, а относительный порядок сохраняется.
 *
 *   node sort-photos.js                 — показать, что изменится
 *   node sort-photos.js ipad-a16        — только один товар
 *   node sort-photos.js --apply         — записать
 *
 * Признак срезанного кадра — в lib/images.js (`looksCropped`): содержимое
 * заполняет кадр И хотя бы один угол его рамки занят телом товара. Светлый
 * объект на белом фоне так не опознаётся, поэтому список стоит просмотреть
 * глазами: скрипт печатает адрес каждого кадра.
 */
const path = require('path');
const db = require('./lib/db');
const IMG = require('./lib/images');

const MAX = 1200;
const args = process.argv.slice(2);
const apply = args.includes('--apply');
const only = args.find(a => !a.startsWith('--'));

(async () => {
  const bin = await IMG.detectBin();
  if (!bin) {
    console.log('ImageMagick не найден — измерить снимки нечем. Ставится пакетом imagemagick.');
    process.exit(1);
  }

  const products = db.getProducts().filter(p => !only || p.id === only);
  if (!products.length) { console.log('товар не найден:', only); return; }

  let scanned = 0, cropped = 0, touched = 0;
  for (const product of products) {
    const images = product.images || [];
    if (images.length < 2) continue;              // переставлять нечего

    const marks = [];
    for (const file of images) {
      scanned++;
      const result = await IMG.inspectCrop(bin, path.join(db.UPLOAD_DIR, file), MAX);
      marks.push({ file, cropped: result.cropped, corners: result.corners });
      if (result.cropped) cropped++;
    }

    // Стабильная перестановка: сначала всё целое в прежнем порядке, потом срезанное.
    const next = marks.filter(m => !m.cropped).map(m => m.file)
      .concat(marks.filter(m => m.cropped).map(m => m.file));
    const moved = next.some((file, i) => file !== images[i]);
    const list = marks.filter(m => m.cropped);
    if (!list.length) continue;

    console.log(`— ${product.name} (${product.id}): срезанных ${list.length} из ${images.length}${moved ? '' : ', уже в конце'}`);
    for (const m of list) {
      const dark = m.corners.length ? Math.min(...m.corners).toFixed(2) : '—';
      console.log(`   /uploads/${m.file}  тёмный угол ${dark}`);
    }
    if (!moved) continue;
    touched++;
    if (apply) {
      const saved = db.updateProduct(product.id, { images: next });
      if (!saved) console.log('   !! не удалось сохранить');
    }
  }

  console.log(`\nпросмотрено фото: ${scanned} | срезанных: ${cropped} | товаров к перестановке: ${touched}`);
  if (!apply && touched) console.log('Записать: node sort-photos.js --apply');
  if (apply && touched) console.log('Готово. Порядок фото на витрине обновится сразу, перезапуск не нужен.');
})();
