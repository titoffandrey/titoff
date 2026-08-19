'use strict';
/*
 * Приводит уже залитые ролики отзывов к нынешним правилам:
 *
 *   1. длина — не больше 60 секунд (`PREV.MAX_VIDEO_SECONDS`);
 *   2. число роликов у товара — не больше, чем мест в ленте
 *      (`DATES.videoCapacity`: первые три страницы и последняя, через один).
 *
 * Зачем: один товар с 1225 привезёнными отзывами занимал 366 МБ, и 289 МБ из
 * них — 36 роликов. Дело в длине: самый большой шёл 8 минут и весил 48,8 МБ —
 * как все 1181 фотография товара вместе. На весь каталог такой расход не
 * помещается на диск вовсе.
 *
 * Обрезка идёт без перекодирования (`-c copy`), поэтому качество не страдает, а
 * лишние ролики удаляются вместе с файлами: отзыв остаётся на месте, теряя
 * только вложенное видео.
 *
 *   node scripts/trim-review-videos.js           — показать, что изменится
 *   node scripts/trim-review-videos.js --apply   — сделать
 *
 * На сервере: STORE_DATA_DIR=/var/lib/apple-store node scripts/trim-review-videos.js --apply
 */
const fs = require('fs');
const path = require('path');
const db = require('../lib/db');
const PREV = require('../lib/review-previews');
const DATES = require('../lib/review-dates');

const apply = process.argv.includes('--apply');
const mb = n => (n / 1048576).toFixed(1) + ' МБ';
const sizeOf = f => { try { return fs.statSync(path.join(db.UPLOAD_DIR, f)).size; } catch (e) { return 0; } };

(async () => {
  if (!(await PREV.ffmpeg())) {
    console.error('ffmpeg не найден — обрезать ролики нечем.');
    process.exit(1);
  }
  const all = db.getReviews();
  // Только привезённые: у отзыва покупателя видео не бывает (форма принимает
  // одни картинки), а трогать чужое вложение мы права не имеем.
  const managed = all.filter(r => r.source && !/^demo/i.test(r.source) && (r.videos || []).length);

  const byProduct = new Map();
  for (const rv of managed) {
    if (!byProduct.has(rv.productId)) byProduct.set(rv.productId, []);
    byProduct.get(rv.productId).push(rv);
  }

  let trimmed = 0, dropped = 0, freed = 0;
  for (const [productId, group] of byProduct) {
    const total = all.filter(r => r.productId === productId && r.source && !/^demo/i.test(r.source)).length;
    const cap = DATES.videoCapacity(total, undefined);
    // Кого оставляем: свежие по исходной дате, как и в раскладке ленты, — чтобы
    // отобранные ролики и оказались на первых страницах.
    const keep = group.slice().sort((a, b) =>
      Number(b.sourceDate) - Number(a.sourceDate) || String(a.id).localeCompare(String(b.id))).slice(0, cap);
    const keepIds = new Set(keep.map(r => r.id));
    console.log(`${productId}: отзывов ${total}, роликов ${group.length}, мест в ленте ${cap}`);

    for (const rv of group) {
      const files = (rv.videos || []).slice();
      if (!keepIds.has(rv.id)) {
        const bytes = files.reduce((s, f) => s + sizeOf(f), 0)
          + files.reduce((s, f) => s + sizeOf((rv.previews || {})[f] || ''), 0);
        freed += bytes; dropped++;
        console.log(`  − лишний ролик у «${rv.author}» (${mb(bytes)})`);
        // Дальше всё делает `updateReview`: он же убирает превью снятого
        // вложения и чистит осиротевшие файлы после записи.
        if (apply) db.updateReview(rv.id, { videos: [] });
        continue;
      }
      for (const f of files) {
        const before = sizeOf(f);
        if (!before) continue;
        if (!apply) { console.log(`  ~ ${f} (${mb(before)}) — будет обрезан до ${PREV.MAX_VIDEO_SECONDS} с`); trimmed++; continue; }
        const ok = await PREV.cleanVideo(db.UPLOAD_DIR, f);
        const after = sizeOf(f);
        if (ok && after && after < before) {
          freed += before - after; trimmed++;
          console.log(`  ~ ${f}: ${mb(before)} → ${mb(after)}`);
        }
      }
    }
  }

  console.log(`\n${apply ? 'Обрезано' : 'К обрезке'} роликов: ${trimmed}, ${apply ? 'удалено лишних' : 'к удалению'}: ${dropped}`
    + (apply ? `, освобождено: ${mb(freed)}` : ''));
  if (apply && dropped) console.log('Даты стоит пересчитать: node scripts/shift-review-dates.js --apply');
  if (!apply) console.log('Это предпросмотр. Чтобы сделать: node scripts/trim-review-videos.js --apply');
})().catch(e => { console.error(e); process.exit(1); });
