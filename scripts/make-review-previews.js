'use strict';

// Готовит лёгкие превью для вложений отзывов и чистит видео.
//
//   node scripts/make-review-previews.js            # только показать объём работы
//   node scripts/make-review-previews.js --apply    # сделать
//   node scripts/make-review-previews.js --apply --clean-video
//
// Зачем — см. lib/review-previews.js. Коротко: в ленте отзывов вложения
// показываются квадратиками, а грузились полноразмерные снимки и метаданные
// каждого ролика. Скрипт идемпотентен: готовое превью не переделывается.
//
// --clean-video снимает с роликов метаданные площадки и переносит индекс в
// начало файла (`+faststart`), чтобы видео начинало играть сразу.

const fs = require('fs');
const path = require('path');
const db = require('../lib/db');
const PREV = require('../lib/review-previews');

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const cleanVideo = args.includes('--clean-video');

(async () => {
  const list = db.getReviews();
  const withMedia = list.filter(r => (r.photos && r.photos.length) || (r.videos && r.videos.length));
  const photos = withMedia.reduce((n, r) => n + (r.photos || []).length, 0);
  const videos = withMedia.reduce((n, r) => n + (r.videos || []).length, 0);

  const done = withMedia.filter(r => {
    const need = (r.photos || []).concat(r.videos || []);
    return need.length && need.every(f => r.previews && r.previews[f]);
  }).length;

  console.log(`Отзывов с вложениями: ${withMedia.length} (фото ${photos}, видео ${videos})`);
  console.log(`Уже с превью: ${done}, к обработке: ${withMedia.length - done}`);
  if (!(await PREV.ffmpeg())) console.log('  ! ffmpeg не найден — кадры для видео сделать не выйдет');

  if (!apply) {
    console.log('\nЭто предпросмотр. Добавьте --apply, чтобы сделать.');
    return;
  }

  let thumbs = 0, posters = 0, cleaned = 0, touched = 0, n = 0;
  for (const rv of withMedia) {
    const res = await PREV.buildPreviews(db.UPLOAD_DIR, rv, { clean: cleanVideo });
    thumbs += res.madeThumbs; posters += res.madePosters; cleaned += res.cleaned;
    if (res.madeThumbs || res.madePosters) {
      rv.previews = res.previews;
      touched++;
    }
    if (++n % 200 === 0) console.log(`  ${n}/${withMedia.length}: миниатюр ${thumbs}, кадров ${posters}`);
  }

  if (touched) db.saveReviews(list);

  // Сколько теперь весит лента: по этим числам и видно, ради чего всё затевалось.
  let small = 0, big = 0;
  for (const rv of withMedia) {
    for (const f of (rv.photos || []).concat(rv.videos || [])) {
      const prev = rv.previews && rv.previews[f];
      try { big += fs.statSync(path.join(db.UPLOAD_DIR, f)).size; } catch (e) {}
      if (prev) { try { small += fs.statSync(path.join(db.UPLOAD_DIR, prev)).size; } catch (e) {} }
    }
  }
  const mb = b => (b / 1048576).toFixed(1) + ' МБ';
  console.log(`\nГотово: миниатюр ${thumbs}, кадров ${posters}${cleanVideo ? `, видео вычищено ${cleaned}` : ''}.`);
  console.log(`Вложения целиком: ${mb(big)} → превью: ${mb(small)}`);
})().catch(e => { console.error(e); process.exit(1); });
