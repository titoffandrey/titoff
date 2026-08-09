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

  let raw = 0, tiny = 0, total = 0;
  for (const p of products) {
    const images = p.images || [];
    if (!images.length) continue;
    console.log(`— ${p.name}`);
    for (const f of images) {
      total++;
      const file = path.join(db.UPLOAD_DIR, f);
      const full = await IMG.imageSize(bin, file);
      const box = await IMG.contentBox(bin, file);
      const fit = IMG.targetContentSize(box, MAX);
      // Доля считается от РЕАЛЬНОГО холста. Делить на MAX вслепую нельзя: у необработанного
      // снимка 5120×2880 товар крупнее самого кадра, и доля выходила больше 100%.
      const framed = full && full.w === MAX && full.h === MAX;
      const size = full ? `${full.w}×${full.h}` : 'размер неизвестен';
      if (!box) { console.log(`   ${f}: ${size}, фон не отделяется ни одним допуском — файл останется как есть`); continue; }
      const longest = Math.max(box.w, box.h);
      const share = full ? Math.round(longest / Math.max(full.w, full.h) * 100) : 0;

      let verdict;
      if (!framed) { verdict = `кадр не приведён — refit впишет товар в ${fit || Math.round(MAX * IMG.CONTENT_RATIO)}px`; raw++; }
      else if (longest >= Math.round(MAX * IMG.CONTENT_RATIO) - 8) verdict = 'уже вписан';
      else {
        // Кадр уже 1200×1200, а товар мелкий — значит обработка отработала и упёрлась в потолок
        // увеличения: исходник был слишком мал. refit тут не помощник, он примет уже растянутый
        // товар за новый оригинал и растянет ещё раз, поверх прежнего увеличения.
        verdict = `мелкий исходник (~${Math.round(longest / IMG.MAX_UPSCALE)}px) — перезалить, refit только размылит`;
        tiny++;
      }
      console.log(`   ${f}: ${size}, товар ${box.w}×${box.h} (${share}% кадра, допуск ${box.fuzz}%) → ${verdict}`);
    }
  }
  console.log(`\nвсего фото: ${total} | не обработано: ${raw} | мелкий исходник: ${tiny}`);
  if (raw) console.log('Не обработанные впишет: node refit-photos.js --apply');
  if (tiny) console.log('Мелкие исходники refit не чинит — их нужно перезалить в большем разрешении.');
})();
