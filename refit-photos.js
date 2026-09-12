'use strict';
/*
 * Перевписывает уже загруженные фото товаров в кадр.
 *
 * Зачем: новые загрузки проходят через lib/images.js, а этот скрипт приводит к
 * тому же виду старые файлы. Поводов было два, и оба остались в силе:
 *  - товар, снятый мелко на большом фоне, оставался крошкой в центре карточки
 *    (до исправления фото уменьшалось, но не увеличивалось);
 *  - фон исходника (белый, #fafafa) не приводился к цвету плиты, и внутри кадра
 *    лежал светлый прямоугольник, который прятал только CSS — заодно с белыми
 *    товарами (см. «Фон исходника приводится к цвету плиты» в lib/images.js).
 *
 * Обработка ТА ЖЕ, что у загрузки через панель — `IMG.optimizeToWebp(square)`,
 * своей копии пайплайна здесь нет: разойдясь с ней, скрипт давал бы файлы, не
 * похожие на загруженные руками (так было: -quality шёл через ImageMagick, а он
 * его для webp не понимает, и файлы выходили другого качества).
 *
 * Файлы перезаписываются под теми же именами, ссылки в каталоге не меняются.
 *
 *   node refit-photos.js          — показать, что изменится (ничего не пишет)
 *   node refit-photos.js --apply  — перезаписать фото
 */
const fs = require('fs');
const path = require('path');

const db = require('./lib/db');
const IMG = require('./lib/images');

const apply = process.argv.includes('--apply');
const MAX = 1200;

(async () => {
  const bin = await IMG.detectBin();
  if (!bin) {
    console.error('ImageMagick не найден. Установите: apt install imagemagick webp');
    process.exit(1);
  }
  db.ensureSeeded();

  // только фото, на которые ссылается каталог
  const used = new Set();
  for (const p of db.getProducts()) for (const src of (p.images || [])) used.add(src);
  if (!used.size) { console.log('В каталоге нет фотографий.'); return; }

  let fixed = 0, skipped = 0, failed = 0;
  for (const name of used) {
    const file = path.join(db.UPLOAD_DIR, name);
    if (!fs.existsSync(file)) { console.log('• нет файла:', name); continue; }
    // Обработка переименовывает не-webp в .webp, а ссылка в каталоге осталась бы
    // прежней. Такой файл честнее перезалить через панель, чем молча переименовать.
    if (!/\.webp$/i.test(name)) { console.log('• не webp, перезалейте через панель:', name); skipped++; continue; }

    const full = await IMG.imageSize(bin, file);
    const box = await IMG.contentBox(bin, file);
    const fit = IMG.targetContentSize(box, MAX);
    const levels = await IMG.backgroundLevels(bin, file, box);
    const longest = box ? Math.max(box.w, box.h) : 0;
    // Трогать нечего, только если кадр УЖЕ приведён к MAX×MAX, товар занимает его почти
    // целиком И фон исходника внутри совпадает с плитой. Размер товара тут в пикселях
    // исходника, поэтому сравнивать его с порогом от MAX, не проверив холст, нельзя: у
    // снимка 5120×2880 товар заведомо крупнее 1096 px, и файл, которому обработка нужнее
    // всего, считался бы «уже в кадре». Ровно так скрипт и молчал про необработанные фото.
    const framed = full && full.w === MAX && full.h === MAX;
    const fitted = framed && (!box || longest >= Math.round(MAX * IMG.CONTENT_RATIO) - 8);
    if (fitted && !levels) {
      // Фон внутри светлый, но множителя нет — углы рамки разошлись или ушли за
      // границы. Такой файл остаётся как есть, и владелец должен об этом знать:
      // молча пропущенный светлый прямоугольник ничем не отличим от исправленного.
      const spots = IMG.boxCorners(full, box);
      const inner = spots ? await IMG.cornerColors(bin, file, spots) : null;
      if (inner && inner.corners.some(p => p.some((v, c) => Math.abs(v - IMG.PLATE_RGB[c]) > 6)))
        console.log(`• фон внутри не определился (оставлен как есть): ${name} углы ${JSON.stringify(inner.corners)}`);
      skipped++; continue;
    }

    const size = full ? `${full.w}×${full.h}` : 'размер неизвестен';
    const plan = [];
    if (!fitted) plan.push(box ? `товар ${box.w}×${box.h} → ${fit}px` : 'фон не отделяется, только вписываем');
    if (levels) plan.push(`фон → плита (×${levels.map(f => f.toFixed(3)).join('/')})`);
    console.log(`${apply ? '✓' : '•'} ${name}: ${size}, ${plan.join(', ')} в кадре ${MAX}×${MAX}`);
    if (!apply) { fixed++; continue; }

    try {
      const out = await IMG.optimizeToWebp(db.UPLOAD_DIR, name, MAX, { square: true });
      if (out !== name) throw new Error('обработка вернула другое имя: ' + out);
      // Уменьшенные копии для карточки сделаны с прежнего кадра, а мы только что
      // его переписали: не пересобрать их — значит оставить на витрине именно
      // тот кадр, ради исправления которого всё и затевалось.
      for (const derived of IMG.derivedNames(name)) {
        try { fs.unlinkSync(path.join(db.UPLOAD_DIR, derived)); } catch (err) {}
      }
      await IMG.makeCards(db.UPLOAD_DIR, name);
      fixed++;
    } catch (e) {
      console.log('  ✗ не удалось обработать:', name, '—', e.message.split('\n')[0]);
      failed++;
    }
  }

  console.log(`\n${apply ? 'Перевписано' : 'Будет перевписано'}: ${fixed} | уже в кадре: ${skipped}${failed ? ` | ошибок: ${failed}` : ''}`);
  if (!apply && fixed) console.log('Это предпросмотр. Чтобы применить: node refit-photos.js --apply');
})();
