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
//
// Видео тяжёлое (ролик весит как сотня снимков), поэтому берётся ровно
// столько, сколько для него мест в ленте: первые три страницы и последняя,
// через один отзыв (`DATES.videoCapacity`). Остальные отзывы приезжают с одними
// фотографиями. Раньше предел был 12 на цвет — у товара с тремя цветами это
// 36 роликов и 289 МБ, из которых до второй страницы доживало полтора.
// Длина ролика режется до минуты при заливке (см. lib/review-previews.js).

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
// Сколько роликов взять: по умолчанию — по числу мест в ленте, но не больше
// того, что задали руками.
const VIDEOS_MAX = numArg('max-videos', 0);
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
//
// Таблица общая на весь каталог, и это безопасно: название применяется только
// когда такой цвет у товара ДЕЙСТВИТЕЛЬНО есть (проверка ниже). Поэтому
// «чёрный → Полуночный» срабатывает у AirPods Max и молчит у AirPods 4,
// которые бывают только белыми.
const COLOR_ALIASES = {
  'silver': 'Серебристый',
  'deep blue': 'Глубокий синий',
  'cosmic orange': 'Космический оранжевый',
  // iPhone Air. «Liquid Gold» — подпись площадки, у Apple цвет называется
  // Light Gold; сводим оба к нашему названию.
  'space black': 'Космический чёрный',
  'sky blue': 'Небесно-голубой',
  'cloud white': 'Облачно-белый',
  'light gold': 'Светлое золото',
  'liquid gold': 'Светлое золото',
  // iPhone 17. Голубой у Apple называется Mist Blue, но площадка пишет просто
  // «Blue» — на витрине он всё равно «Туманно-синий».
  'lavender': 'Лавандовый',
  'sage': 'Шалфейный',
  'mist blue': 'Туманно-синий',
  'blue': 'Туманно-синий',
  'white': 'Белый',
  'black': 'Чёрный',
  // iPhone 16 Pro и Pro Max — титановые корпуса.
  'desert titanium': 'Песочный титан',
  'natural titanium': 'Натуральный титан',
  'white titanium': 'Белый титан',
  'black titanium': 'Чёрный титан',
  // iPhone 16 и 16 Plus. Белый и чёрный у них те же, что у 17-го, — они уже выше.
  'ultramarine': 'Ультрамарин',
  'teal': 'Бирюзовый',
  'pink': 'Розовый',
  // iPhone 17e. Розовый у него свой, «нежный», — от розового шестнадцатого он
  // отличается и названием, и оттенком.
  'soft pink': 'Нежно-розовый',
  // AirPods Max: у Ozon цвет записан двумя словами через дефис, у нас — одним.
  // «Тёмно-серый» — это Space Gray прежнего поколения: Apple переименовала его
  // в Midnight, когда перевела наушники на USB-C, так что цвет тот же самый.
  'черный-темно-серый': 'Полуночный',
  'темно-серый-черный матовый': 'Полуночный',
  'черный': 'Полуночный',
  'бежевый-золотой': 'Сияющая звезда',
  'золотой': 'Сияющая звезда',
  'синий-голубой': 'Синий',
  'голубой': 'Синий',
  'фиолетовый-сиреневый': 'Фиолетовый',
  'фиолетовый': 'Фиолетовый',
  'оранжевый-коралловый': 'Оранжевый',
  'оранжевый': 'Оранжевый',
  // AirPods Pro, 4 и 3 бывают только белыми, а подписи площадки описывают
  // не сами наушники, а кадр с футляром («чёрно-серый» у белых AirPods 4).
  'белый': 'Белый',
  'белый-серый': 'Белый',
  'белый-черный': 'Белый',
  'черно-серый': 'Белый',
  'белый-темно-серый': 'Белый',
  'белый-черно-серый-зеркальный': 'Белый'
};
const SIM_ALIASES = {
  'две esim': 'Только eSIM',
  'sim+esim': 'eSIM + физическая SIM'
};

const ourColors = (product.colors || []).map(c => String(c.name || ''));
const unknownColors = new Set();

// Сравнение названий цветов. «Ё» приводится к «е»: у нас «Чёрный», а площадка
// пишет «черный», и без этого один и тот же цвет считался бы разным — на
// витрине отзыв получал подпись «Черный», которой в выборе цвета нет.
function sameColor(a, b) {
  const norm = s => String(s || '').trim().toLowerCase().replace(/ё/g, 'е');
  return norm(a) === norm(b);
}

function ourColorName(sourceColor, configColor) {
  const key = String(sourceColor || '').trim().toLowerCase();
  const mapped = COLOR_ALIASES[key];
  // Название берём только то, что реально есть у товара: выдумать цвет,
  // которого магазин не продаёт, хуже, чем оставить исходный.
  if (mapped && ourColors.some(c => sameColor(c, mapped))) return mapped;
  // Подпись площадки могла совпасть с нашей и без таблицы — тогда берём наше
  // написание, а не её (та же «ё»).
  const near = ourColors.find(c => sameColor(c, configColor)) || ourColors.find(c => sameColor(c, sourceColor));
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

// ── Аватарка профиля — не снимок отзыва ─────────────────────────────────────
// Площадка держит портреты покупателей на тех же хостах, что и медиа отзывов,
// и в пакет они попадали наравне со снимками товара: на витрине это выглядело
// так, будто покупатель приложил к отзыву своё фото. Отличить их можно только
// по пути в адресе — настоящие снимки лежат под `rp-photo-NN`.
//
// Проверка стоит здесь, а не только в скрейпере: пакет приходит извне, и
// хранилищу нельзя верить ему на слово — то же правило, что у цены заказа.
const AVATAR_RE = /fs-my-account-avatar|\/avatar\/|user-avatar/i;
function isAvatar(url) { return AVATAR_RE.test(String(url || '')); }
function realPhotos(rv) { return (rv.photos || []).filter(u => !isAvatar(u)); }

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
  // Мест под ролики столько, сколько их в раскладке ленты этого товара.
  const capacity = VIDEOS_MAX > 0 ? VIDEOS_MAX : DATES.videoCapacity(list.length);
  // Раздаём места по кругу между цветами: иначе один цвет с сотней роликов
  // забирает их все, и у остальных в ленте не остаётся ни одного.
  const byColor = new Map();
  const queues = new Map();
  for (const rv of list) {
    if (!(rv.videos && rv.videos.length)) continue;
    const color = colorOf(rv);
    if (!queues.has(color)) queues.set(color, []);
    queues.get(color).push(rv);
  }
  let videosPlanned = 0;
  for (let round = 0; videosPlanned < capacity; round++) {
    let any = false;
    for (const [color, queue] of queues) {
      if (round >= queue.length) continue;
      any = true;
      queue[round]._takeVideo = true;
      byColor.set(color, (byColor.get(color) || 0) + 1);
      if (++videosPlanned >= capacity) break;
    }
    if (!any) break;
  }

  const photosPlanned = list.reduce((n, r) => n + Math.min(realPhotos(r).length, MAX_PHOTOS), 0);
  const avatars = list.reduce((n, r) => n + (r.photos || []).filter(isAvatar).length, 0);
  if (avatars) console.log(`Аватарок профиля в пакете: ${avatars} — не берём, это не снимки отзыва`);
  console.log(`Товар: ${product.name} (${productId})`);
  console.log(`Отзывов в пакете: ${list.length}, фото к загрузке: ${photosPlanned}, видео: ${videosPlanned}`);
  console.log(`Мест под видео в ленте: ${capacity} → ${[...byColor].map(([c, n]) => `${c} ${n}`).join(', ') || 'нет роликов'}`);

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
    for (const url of realPhotos(rv).slice(0, MAX_PHOTOS)) {
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
