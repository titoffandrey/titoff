'use strict';
/*
 * Перевписывает уже загруженные фото товаров в кадр.
 *
 * Зачем: до исправления фото уменьшалось, но не увеличивалось, поэтому товар,
 * снятый мелко на большом фоне, оставался крошечным в центре карточки. Новые
 * загрузки чинит lib/images.js, а этот скрипт приводит в порядок старые файлы.
 *
 * Файлы перезаписываются под теми же именами, ссылки в каталоге не меняются.
 *
 *   node refit-photos.js          — показать, что изменится (ничего не пишет)
 *   node refit-photos.js --apply  — перезаписать фото
 */
const fs = require('fs');
const path = require('path');
const util = require('util');
const execFileP = util.promisify(require('child_process').execFile);

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

    const full = await IMG.imageSize(bin, file);
    const box = await IMG.contentBox(bin, file);
    const fit = IMG.targetContentSize(box, MAX);
    const longest = box ? Math.max(box.w, box.h) : 0;
    // Трогать нечего, только если кадр УЖЕ приведён к MAX×MAX и товар занимает его почти целиком.
    // Размер товара тут в пикселях исходника, поэтому сравнивать его с порогом от MAX, не проверив
    // холст, нельзя: у снимка 5120×2880 товар заведомо крупнее 1096 px, и файл, которому обработка
    // нужнее всего, считался бы «уже в кадре». Ровно так скрипт и молчал про необработанные фото.
    const framed = full && full.w === MAX && full.h === MAX;
    if (framed && (!box || longest >= Math.round(MAX * IMG.CONTENT_RATIO) - 8)) { skipped++; continue; }

    const size = full ? `${full.w}×${full.h}` : 'размер неизвестен';
    // Фон не отделяется — остаётся «только уменьшить и вписать», как в lib/images.js.
    const plan = box ? `товар ${box.w}×${box.h} → ${fit}px` : 'фон не отделяется, только вписываем';
    console.log(`${apply ? '✓' : '•'} ${name}: ${size}, ${plan} в кадре ${MAX}×${MAX}`);
    if (!apply) { fixed++; continue; }

    const tmp = path.join(db.UPLOAD_DIR, '.refit-' + name);
    const args = [file, '-auto-orient', '-strip']
      .concat(IMG.squareTransformArgs(MAX, { trim: true, fit, fuzz: box ? box.fuzz : undefined }))
      .concat(['-define', 'webp:method=4', '-quality', '82', tmp]);
    try {
      await execFileP(bin, args, { timeout: 20000 });
      fs.renameSync(tmp, file);
      // Уменьшенные копии для карточки сделаны с прежнего кадра, а мы только что
      // его переписали: не пересобрать их — значит оставить на витрине именно
      // тот кадр, ради исправления которого всё и затевалось.
      for (const derived of IMG.derivedNames(name)) {
        try { fs.unlinkSync(path.join(db.UPLOAD_DIR, derived)); } catch (err) {}
      }
      await IMG.makeCards(db.UPLOAD_DIR, name);
      fixed++;
    } catch (e) {
      try { fs.unlinkSync(tmp); } catch (err) {}
      console.log('  ✗ не удалось обработать:', name, '—', e.message.split('\n')[0]);
      failed++;
    }
  }

  console.log(`\n${apply ? 'Перевписано' : 'Будет перевписано'}: ${fixed} | уже в кадре: ${skipped}${failed ? ` | ошибок: ${failed}` : ''}`);
  if (!apply && fixed) console.log('Это предпросмотр. Чтобы применить: node refit-photos.js --apply');
})();
