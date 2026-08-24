'use strict';

// Готовит уменьшенные копии фото товаров для карточек каталога.
//
//   node scripts/make-card-photos.js            # только показать объём работы
//   node scripts/make-card-photos.js --apply    # сделать
//
// Зачем — см. «Снимок для карточки каталога» в lib/images.js. Коротко: в
// хранилище лежит квадрат 1200×1200, а карточка показывает его в 169–276
// CSS-пикселей, и покупатель качал полтора мегабайта лишнего на одну главную.
// Копии называются `<имя>-c320.webp` и `<имя>-c640.webp`, скрипт идемпотентен:
// готовая копия не переделывается.
//
// Живой каталог на сервере после выкатки:
//   STORE_DATA_DIR=/var/lib/apple-store node scripts/make-card-photos.js --apply

const fs = require('fs');
const path = require('path');
const db = require('../lib/db');
const IMG = require('../lib/images');

const apply = process.argv.slice(2).includes('--apply');

function bytes(n) {
  return n > 1024 * 1024 ? (n / 1024 / 1024).toFixed(1) + ' МБ' : Math.round(n / 1024) + ' КБ';
}
function sizeOf(file) {
  try { return fs.statSync(path.join(db.UPLOAD_DIR, file)).size; } catch (e) { return 0; }
}

(async () => {
  const products = db.getProducts();
  const photos = [];
  const seen = new Set();
  for (const p of products) {
    for (const f of (p.images || [])) {
      if (seen.has(f) || IMG.isDerived(f)) continue;
      seen.add(f);
      photos.push(f);
    }
  }

  const ready = photos.filter(f => {
    const have = IMG.cardSources(db.UPLOAD_DIR, f);
    return have && have.sizes.length === IMG.CARD_SIZES.length;
  }).length;

  console.log(`Товаров: ${products.length}, снимков: ${photos.length}`);
  console.log(`Уже с копиями: ${ready}, к обработке: ${photos.length - ready}`);
  if (!(await IMG.detectBin())) {
    console.log('  ! ImageMagick не найден — копии сделать не выйдет, карточки останутся на исходниках');
    return;
  }

  if (!apply) {
    console.log('\nЭто предпросмотр. Добавьте --apply, чтобы сделать.');
    return;
  }

  let made = 0, n = 0;
  for (const f of photos) {
    const res = await IMG.makeCards(db.UPLOAD_DIR, f);
    made += res.length;
    if (++n % 100 === 0) console.log(`  ${n}/${photos.length}`);
  }

  // Сколько теперь весит карточка: ради этих чисел всё и затевалось.
  let full = 0, small = 0;
  for (const f of photos) {
    full += sizeOf(f);
    const card = IMG.cardSources(db.UPLOAD_DIR, f);
    small += card ? sizeOf(card.src) : sizeOf(f);
  }
  console.log(`Готово. Файлов на диске: ${made}`);
  console.log(`Снимки в карточках: ${bytes(full)} → ${bytes(small)}`);
})().catch(e => { console.error(e); process.exit(1); });
