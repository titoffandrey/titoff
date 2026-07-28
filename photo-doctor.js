'use strict';
/*
 * Диагностика фотографий: показывает, каким ImageMagick видит товар на каждом
 * снимке и до какого размера тот будет вписан. Ничего не меняет.
 *
 *   node photo-doctor.js                 — все товары
 *   node photo-doctor.js ipad-pro-11-m5  — один товар
 */
const path = require('path');
const db = require('./lib/db');
const IMG = require('./lib/images');

const MAX = 1200;
const only = process.argv[2];

(async () => {
  const bin = await IMG.detectBin();
  console.log('ImageMagick:', bin || 'НЕ НАЙДЕН — фото не обрабатываются вообще');
  if (!bin) process.exit(0);
  const { execFile } = require('child_process');
  await new Promise(r => execFile(bin, ['-version'], (e, out) => {
    console.log('версия:', String(out || '').split('\n')[0] || '—');
    console.log('кадр:', MAX, '| поле под товар:', Math.round(MAX * IMG.CONTENT_RATIO), 'px | потолок увеличения:', IMG.MAX_UPSCALE + '×\n');
    r();
  }));

  const products = db.getProducts().filter(p => !only || p.id === only);
  if (!products.length) { console.log('товар не найден:', only); return; }

  let small = 0, total = 0;
  for (const p of products) {
    const images = p.images || [];
    if (!images.length) continue;
    console.log(`— ${p.name}`);
    for (const f of images) {
      total++;
      const file = path.join(db.UPLOAD_DIR, f);
      const box = await IMG.contentBox(bin, file);
      const fit = IMG.targetContentSize(box, MAX);
      if (!box) { console.log(`   ${f}: фон не отделяется ни одним допуском — файл останется как есть`); continue; }
      const longest = Math.max(box.w, box.h);
      const share = Math.round(longest / MAX * 100);
      const verdict = longest >= Math.round(MAX * IMG.CONTENT_RATIO) - 8
        ? 'уже вписан'
        : `будет увеличен до ${fit}px`;
      if (verdict !== 'уже вписан') small++;
      console.log(`   ${f}: товар ${box.w}×${box.h} (${share}% кадра, допуск ${box.fuzz}%) → ${verdict}`);
    }
  }
  console.log(`\nвсего фото: ${total} | требуют переобработки: ${small}`);
  if (small) console.log('Исправить: node refit-photos.js --apply && pm2 restart all');
})();
