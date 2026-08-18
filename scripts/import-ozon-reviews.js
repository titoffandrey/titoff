'use strict';

// Заливка отзывов с площадки в живое хранилище магазина.
//
// Пакет (bundle.json) несёт только тексты и АДРЕСА медиа — файлы скрипт качает
// сам, прямо с CDN площадки: тащить полгигабайта на сервер по узкому каналу
// незачем, а CDN отдаёт их обычным запросом.
//
//   node scripts/import-ozon-reviews.js bundle.json            # только показать
//   node scripts/import-ozon-reviews.js bundle.json --apply    # залить
//   node scripts/import-ozon-reviews.js bundle.json --apply --replace
//
// --replace  сначала удаляет ВСЕ отзывы этого товара (и их файлы).
// Видео тяжёлое, поэтому берём не больше --videos-per-color штук на цвет:
// остальные отзывы приезжают с одними фотографиями.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const db = require('../lib/db');
const IMG = require('../lib/images');
const DATES = require('../lib/review-dates');
const PREV = require('../lib/review-previews');

const args = process.argv.slice(2);
const file = args.find(a => !a.startsWith('--'));
const apply = args.includes('--apply');
const replace = args.includes('--replace');
const numArg = (name, def) => {
  const i = args.indexOf('--' + name);
  if (i < 0) return def;
  const n = Number(args[i + 1]);
  return Number.isFinite(n) ? n : def;
};
const VIDEOS_PER_COLOR = numArg('videos-per-color', 12);
const LIMIT = numArg('limit', 0);
const MAX_PHOTOS = numArg('max-photos', 6);

if (!file) {
  console.error('Укажите файл пакета: node scripts/import-ozon-reviews.js bundle.json --apply');
  process.exit(1);
}

const bundle = JSON.parse(fs.readFileSync(path.resolve(file), 'utf8'));
const productId = String(bundle.productId || '');
const product = db.getProduct(productId);
if (!product) {
  console.error(`Товар «${productId}» не найден в каталоге магазина`);
  process.exit(1);
}

// Цвет, по которому считается лимит видео. В пакете он приходит отдельным полем
// и уже сведён к настоящему цвету (Silver, Deep Blue, Cosmic Orange): подписи
// площадки дробят один цвет на «серебристый» и «серебристый-серый металлик»,
// и лимит раздваивался бы вместе с ними. Поля нет — берём начало сборки.
function colorOf(rv) {
  const own = String((rv && rv.color) || '').trim().toLowerCase();
  if (own) return own;
  return String((rv && rv.config) || '').split('·')[0].trim().toLowerCase() || 'без цвета';
}

// ── Подпись сборки нашими словами ───────────────────────────────────────────
// На площадке цвета и версии SIM называются по-своему («Синий-темно-синий»,
// «Две eSIM»). В отзыве на нашей витрине должно стоять то же название, что
// покупатель видит в выборе цвета, иначе отзыв ссылается на вариант, которого
// у нас будто бы нет.
const COLOR_ALIASES = {
  'silver': 'Серебристый',
  'deep blue': 'Глубокий синий',
  'cosmic orange': 'Космический оранжевый'
};
const SIM_ALIASES = {
  'две esim': 'Только eSIM',
  'sim+esim': 'eSIM + физическая SIM'
};

const ourColors = (product.colors || []).map(c => String(c.name || ''));
const unknownColors = new Set();

function ourColorName(sourceColor, configColor) {
  const key = String(sourceColor || '').trim().toLowerCase();
  const mapped = COLOR_ALIASES[key];
  // Название берём только то, что реально есть у товара: выдумать цвет,
  // которого магазин не продаёт, хуже, чем оставить исходный.
  if (mapped && ourColors.some(c => c.toLowerCase() === mapped.toLowerCase())) return mapped;
  const near = ourColors.find(c => c.toLowerCase() === String(configColor || '').trim().toLowerCase());
  if (near) return near;
  if (sourceColor) unknownColors.add(sourceColor);
  return configColor || '';
}

// «Серебристый · 256 ГБ · Две eSIM» → «Серебристый · 256 ГБ · Только eSIM»,
// где первая часть заменена на наше название цвета.
function ourConfig(rv) {
  const parts = String(rv.config || '').split('·').map(s => s.trim()).filter(Boolean);
  if (!parts.length) return '';
  parts[0] = ourColorName(rv.color, parts[0]) || parts[0];
  for (let i = 1; i < parts.length; i++) {
    const sim = SIM_ALIASES[parts[i].toLowerCase()];
    if (sim) parts[i] = sim;
  }
  return parts.join(' · ');
}

// ── Перевозчик ──────────────────────────────────────────────────────────────
// Половина заказов уезжает СДЭКом, половина OZON. Раздаём не по очереди —
// чередование в ленте сразу видно и читается как подделка, — а по хешу самого
// отзыва: доля та же, порядок вперемешку, и при повторной заливке у отзыва
// остаётся тот же перевозчик.
const DELIVERIES = (() => {
  const i = args.indexOf('--deliveries');
  const raw = i >= 0 ? String(args[i + 1] || '') : 'cdek,ozon';
  return raw.split(',').map(s => s.trim()).filter(Boolean);
})();

function deliveryFor(rv) {
  if (!DELIVERIES.length) return null;
  if (DELIVERIES.length === 1) return DELIVERIES[0];
  const key = String(rv.uuid || rv.author || '') + '|' + String(rv.text || '').slice(0, 40);
  const hash = crypto.createHash('sha1').update(key).digest();
  return DELIVERIES[hash[0] % DELIVERIES.length];
}

const EXT_OK = new Set(['.jpg', '.jpeg', '.png', '.webp', '.mp4', '.m4v', '.mov']);
function extOf(url, fallback) {
  const m = String(url).split('?')[0].match(/\.([a-z0-9]{2,4})$/i);
  const ext = m ? '.' + m[1].toLowerCase() : '';
  return EXT_OK.has(ext) ? (ext === '.jpeg' ? '.jpg' : ext) : fallback;
}

// Имя файла в хранилище — от адреса, поэтому повторный прогон не плодит копии.
function nameFor(url, fallback) {
  const hash = crypto.createHash('sha1').update(String(url)).digest('hex').slice(0, 16);
  return 'rv-' + hash + extOf(url, fallback);
}

async function fetchTo(url, dest, tries) {
  tries = tries || 3;
  for (let attempt = 1; attempt <= tries; attempt++) {
    try {
      const res = await fetch(url, {
        headers: { 'Referer': bundle.sourceUrl || 'https://www.ozon.ru/', 'Accept': '*/*' },
        signal: AbortSignal.timeout(120000)
      });
      if (!res.ok) {
        if (res.status === 404) return false;
        throw new Error('HTTP ' + res.status);
      }
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length < 1024) throw new Error('слишком маленький файл');
      fs.writeFileSync(dest, buf);
      return true;
    } catch (e) {
      if (attempt === tries) { console.log(`      ! не скачалось (${e.message}): ${url}`); return false; }
      await new Promise(r => setTimeout(r, 1200 * attempt));
    }
  }
  return false;
}

(async () => {
  const list = LIMIT ? bundle.reviews.slice(0, LIMIT) : bundle.reviews;
  const byColor = new Map();
  let videosPlanned = 0;
  for (const rv of list) {
    const color = colorOf(rv);
    const taken = byColor.get(color) || 0;
    if (rv.videos && rv.videos.length && taken < VIDEOS_PER_COLOR) {
      byColor.set(color, taken + 1);
      videosPlanned++;
      rv._takeVideo = true;
    }
  }

  const photosPlanned = list.reduce((n, r) => n + Math.min((r.photos || []).length, MAX_PHOTOS), 0);
  console.log(`Товар: ${product.name} (${productId})`);
  console.log(`Отзывов в пакете: ${list.length}, фото к загрузке: ${photosPlanned}, видео: ${videosPlanned}`);
  console.log(`Лимит видео на цвет: ${VIDEOS_PER_COLOR} → ${[...byColor].map(([c, n]) => `${c} ${n}`).join(', ')}`);

  const ship = new Map();
  const colors = new Map();
  for (const rv of list) {
    const d = deliveryFor(rv) || '—';
    ship.set(d, (ship.get(d) || 0) + 1);
    const c = ourConfig(rv).split('·')[0].trim();
    colors.set(c, (colors.get(c) || 0) + 1);
  }
  console.log(`Цвета нашими названиями: ${[...colors].map(([c, n]) => `${c} ${n}`).join(', ')}`);
  console.log(`Перевозчики: ${[...ship].map(([c, n]) => `${c} ${n} (${Math.round(n / list.length * 100)}%)`).join(', ')}`);
  if (unknownColors.size) console.log(`  ! не нашлось нашего названия для: ${[...unknownColors].join(', ')}`);

  const existing = db.getReviews().filter(r => r.productId === productId).length;
  console.log(`Сейчас у товара отзывов: ${existing}${replace ? ' — будут удалены' : ''}`);

  if (!apply) {
    console.log('\nЭто предпросмотр. Добавьте --apply, чтобы залить.');
    return;
  }

  if (replace) {
    const gone = db.deleteReviewsForProduct(productId);
    console.log(`Удалено прежних отзывов: ${gone}`);
  }

  fs.mkdirSync(db.UPLOAD_DIR, { recursive: true });
  let done = 0, photosOk = 0, videosOk = 0;

  for (const rv of list) {
    const photos = [];
    for (const url of (rv.photos || []).slice(0, MAX_PHOTOS)) {
      const name = nameFor(url, '.jpg');
      // Первый прогон превратил файл в .webp и исходник убрал. Повторная
      // заливка должна брать готовый, а не качать всё заново.
      const webp = name.replace(/\.[^.]+$/, '') + '.webp';
      if (fs.existsSync(path.join(db.UPLOAD_DIR, webp))) { photos.push(webp); photosOk++; continue; }
      const dest = path.join(db.UPLOAD_DIR, name);
      if (!fs.existsSync(dest) && !(await fetchTo(url, dest))) continue;
      // Тот же путь, что и у фотографий, загруженных через форму отзыва.
      const finalName = await IMG.optimizeToWebp(db.UPLOAD_DIR, name, 1400);
      photos.push(finalName);
      photosOk++;
    }

    const videos = [];
    if (rv._takeVideo) {
      for (const url of (rv.videos || []).slice(0, 1)) {
        const name = nameFor(url, '.mp4');
        const dest = path.join(db.UPLOAD_DIR, name);
        if (!fs.existsSync(dest) && !(await fetchTo(url, dest))) continue;
        videos.push(name);
        videosOk++;
      }
    }

    // Лёгкие превью сразу при заливке: иначе первая же страница отзывов
    // потянет полноразмерные снимки и метаданные каждого ролика.
    const prep = await PREV.buildPreviews(db.UPLOAD_DIR, { photos, videos }, { clean: true });

    db.createReview({
      productId,
      author: rv.author || 'Покупатель',
      rating: rv.rating || 5,
      text: rv.text || '',
      photos, videos,
      previews: prep.previews,
      config: ourConfig(rv),
      delivery: deliveryFor(rv),
      source: bundle.source || 'ozon',
      // Своя дата отзыва. На витрину она попадёт сдвинутой — см. lib/review-dates.js.
      sourceDate: Number.isFinite(Number(rv.date)) ? Number(rv.date) : null,
      createdAt: Number.isFinite(Number(rv.date)) ? Number(rv.date) : Date.now(),
      status: 'approved'
    });

    done++;
    if (done % 100 === 0) console.log(`  залито ${done}/${list.length} (фото ${photosOk}, видео ${videosOk})`);
  }

  // Отзывам без даты в источнике раздаём даты по тому же отрезку, потом сдвигаем всё разом.
  const all = db.getReviews();
  const mine = all.filter(r => r.productId === productId && r.source);
  const known = mine.map(r => Number(r.sourceDate)).filter(Number.isFinite);
  if (known.length) {
    const from = Math.min.apply(null, known), to = Math.max.apply(null, known);
    let invented = 0;
    for (const rv of mine) {
      if (!Number.isFinite(Number(rv.sourceDate))) { rv.sourceDate = DATES.inventDate(rv, from, to); invented++; }
    }
    if (invented) { db.saveReviews(all); console.log(`Дат не было в источнике: ${invented} — проставлены случайные по тому же отрезку`); }
  }

  const shifted = require('./shift-review-dates').shift();
  console.log(`\nГотово: ${done} отзывов, ${photosOk} фото, ${videosOk} видео. Даты сдвинуты у ${shifted}.`);
})().catch(e => { console.error(e); process.exit(1); });
