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

    const box = await IMG.contentBox(bin, file);
    const fit = IMG.targetContentSize(box, MAX);
    const longest = box ? Math.max(box.w, box.h) : 0;
    // товар уже занимает почти весь кадр — трогать нечего
    if (!box || longest >= Math.round(MAX * IMG.CONTENT_RATIO) - 8) { skipped++; continue; }

    console.log(`${apply ? '✓' : '•'} ${name}: товар ${box.w}×${box.h} → ${fit}px в кадре ${MAX}×${MAX}`);
    if (!apply) { fixed++; continue; }

    const tmp = path.join(db.UPLOAD_DIR, '.refit-' + name);
    const args = [file, '-auto-orient', '-strip']
      .concat(IMG.squareTransformArgs(MAX, { trim: true, fit, fuzz: box.fuzz }))
      .concat(['-define', 'webp:method=4', '-quality', '82', tmp]);
    try {
      await execFileP(bin, args, { timeout: 20000 });
      fs.renameSync(tmp, file);
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
