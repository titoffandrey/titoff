#!/usr/bin/env node
'use strict';

// Скачивает все фотографии с buy-страницы Apple Watch — по каждому сочетанию
// «корпус (размер, цвет, связь) + ремешок (коллекция, цвет)».
//
//   node scripts/fetch-apple-watch-photos.js https://www.apple.com/shop/buy-watch/apple-watch-se
//
// Ключи:
//   --out DIR        куда складывать (по умолчанию apple-photos/<модель>)
//   --width N        длинная сторона фото, px (по умолчанию 2000; максимум у Apple — 5120)
//   --jobs N         параллельных запросов (по умолчанию 4)
//   --limit N        взять только первые N сочетаний — для проверки
//   --dry            только собрать список и записать manifest.json, ничего не качать
//   --force          перекачать даже то, что уже лежит на диске
//
// Как это устроено. Страница несёт два блока данных:
//   productSelectionData          — корпуса: размер, материал, цвет, связь + артикулы;
//   pageLevelData.bandSelectionBootstrap — ремешки: коллекции → цвета → размеры.
// Сами фотографии в HTML не лежат: там заглушки «выберите корпус». Готовые кадры
// отдаёт /shop/api/kit-product-gallery, если передать ему выбор размерностями
// `dm.<имя>=<значение>` — формат подсмотрен в step1evolution.js, в сборщике запроса.
// Артикул корпуса (`case`) при этом не нужен вовсе: хватает размерностей.
//
// Скрипт идемпотентен: уже скачанный файл пропускается, повторный прогон дозагружает
// недостающее. Работает только на встроенных модулях Node — как и весь проект.

const fs = require('fs');
const path = require('path');

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 ' +
  '(KHTML, like Gecko) Version/17.0 Safari/605.1.15';

const IMG_BASE = 'https://store.storeimages.cdn-apple.com/1/as-images.apple.com/is/';
const SWATCH_PX = 512; // образцы цвета — просто плашки, гнать их в 2000 px незачем

// ────────────────────────────── аргументы ──────────────────────────────

function parseArgs(argv) {
  const o = { width: 2000, jobs: 4, limit: 0, dry: false, force: false, url: '', out: '' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry') o.dry = true;
    else if (a === '--force') o.force = true;
    else if (a === '--out') o.out = argv[++i];
    else if (a === '--width') o.width = Number(argv[++i]);
    else if (a === '--jobs') o.jobs = Number(argv[++i]);
    else if (a === '--limit') o.limit = Number(argv[++i]);
    else if (a.startsWith('-')) fail('неизвестный ключ: ' + a);
    else o.url = a;
  }
  if (!o.url) fail('укажи адрес buy-страницы, например https://www.apple.com/shop/buy-watch/apple-watch-se');
  if (!/^https:\/\/www\.apple\.com\/.*buy-watch\//.test(o.url)) {
    fail('ожидается страница вида https://www.apple.com/shop/buy-watch/<модель>');
  }
  if (!Number.isFinite(o.width) || o.width < 64 || o.width > 5120) fail('--width: число от 64 до 5120');
  if (!Number.isFinite(o.jobs) || o.jobs < 1 || o.jobs > 8) fail('--jobs: число от 1 до 8');
  return o;
}

function fail(msg) {
  console.error('Ошибка: ' + msg);
  process.exit(1);
}

// ─────────────────────────── разбор страницы ───────────────────────────

// Вырезает JSON-объект, начиная с первой «{» после метки. Считает скобки
// вне строк — регуляркой такое не берётся, объекты вложенные и с кавычками внутри.
function jsonAfter(text, label) {
  const at = text.indexOf(label);
  if (at < 0) return null;
  let i = text.indexOf('{', at + label.length);
  if (i < 0) return null;
  const start = i;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (!depth) {
        try {
          return JSON.parse(text.slice(start, i + 1));
        } catch (e) {
          return null;
        }
      }
    }
  }
  return null;
}

async function getText(url) {
  const r = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'text/html,*/*' } });
  if (!r.ok) throw new Error(url + ' → HTTP ' + r.status);
  return r.text();
}

// ────────────────────────────── картинки ───────────────────────────────

// У каждого кадра Apple отдаёт готовый srcSet со своими параметрами
// (bgc, trim, формат, токен .v). Свой адрес собирать нельзя — потеряются
// подложка и обрезка, и кадры разъедутся с теми, что показывает витрина Apple.
// Поэтому берём оригинальный адрес и меняем в нём только размер и качество.
//
// **`.v` обязательно выбрасывать вместе с правкой размера.** Это не версия файла,
// а подпись, привязанная к точному набору параметров: с прежним токеном и другим
// `wid` Scene7 отвечает 404 (пятнадцать байт тела), причём на ВСЕ кадры разом —
// со стороны это выглядит как «Apple забанила», хотя дело только в подписи.
// Без токена тот же адрес отдаётся спокойно, в любом размере.
function scaleUrl(srcSet, longSide) {
  let u;
  try {
    u = new URL(srcSet);
  } catch (e) {
    return null;
  }
  const w = Number(u.searchParams.get('wid')) || 0;
  const h = Number(u.searchParams.get('hei')) || 0;
  if (w && h) {
    const k = longSide / Math.max(w, h);
    u.searchParams.set('wid', String(Math.max(1, Math.round(w * k))));
    u.searchParams.set('hei', String(Math.max(1, Math.round(h * k))));
  } else {
    u.searchParams.set('wid', String(longSide));
    u.searchParams.set('hei', String(longSide));
  }
  // p-jpg — прогрессивный JPEG, он же и отдаётся витрине; качество поднимаем.
  if (!/png/.test(u.searchParams.get('fmt') || '')) u.searchParams.set('qlt', '95');
  u.searchParams.delete('.v');
  return u.toString();
}

function imageOf(item) {
  return (item && ((item.asset && item.asset.image) || item.image)) || null;
}

function srcOf(img) {
  const s = (img && img.sources) || [];
  for (const x of s) if (x && x.srcSet) return x.srcSet.split(/\s+/)[0];
  return img && img.src ? img.src : '';
}

function extOf(url) {
  const fmt = (() => {
    try {
      return new URL(url).searchParams.get('fmt') || '';
    } catch (e) {
      return '';
    }
  })();
  return /png/.test(fmt) ? '.png' : '.jpg';
}

// ─────────────────────────────── имена ─────────────────────────────────

function slug(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '') || 'x';
}

// Ракурс зашит в имя кадра: ..._VW_34FR — три четверти спереди, _VW_PF — профиль.
function viewOf(imageName) {
  const m = String(imageName || '').match(/_VW_([A-Z0-9]+)/);
  if (m) return m[1].toLowerCase();
  const av = String(imageName || '').match(/_AV(\d+)$/);
  if (av) return 'alt' + av[1];
  return 'main';
}

// ──────────────────────────── сбор данных ──────────────────────────────

function readCases(psd) {
  const list = Array.isArray(psd && psd.products) ? psd.products : [];
  return list.map(p => ({ part: p.part, dims: p.dimensions || {} }));
}

function readBands(boot) {
  const data = (boot && boot.bandSelectionData) || {};
  const items = data.items || {};
  const out = [];
  for (const [styleId, style] of Object.entries(items)) {
    const colors = Array.isArray(style.subDimensionValue) ? style.subDimensionValue : [];
    for (const c of colors) {
      out.push({
        style: styleId,
        styleName: stripTags(style.sectionHeader) || styleId,
        color: c.dimensionValue,
        colorName: c.text || c.dimensionValue,
        part: (c.image && c.image.baseIdentifier) || '',
        swatch: srcOf(c.image),
      });
    }
  }
  return out;
}

function stripTags(s) {
  return String(s || '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function caseSwatches(psd) {
  const out = [];
  const dv = (psd && psd.displayValues) || {};
  for (const [dim, values] of Object.entries(dv)) {
    if (!values || typeof values !== 'object') continue;
    for (const [val, entry] of Object.entries(values)) {
      const src = srcOf(entry && entry.image);
      if (src) out.push({ dim, value: val, src, name: (entry.image && entry.image.imageName) || val });
    }
  }
  return out;
}

// ────────────────────────── запросы к галерее ──────────────────────────

async function galleryFor(api, dimParam, dims) {
  const u = new URL(api, 'https://www.apple.com');
  for (const [k, v] of Object.entries(dims)) u.searchParams.set(dimParam + '.' + k, v);
  const r = await fetch(u, { headers: { 'User-Agent': UA, Accept: 'application/json' } });
  if (r.status === 429 || r.status >= 500) throw Object.assign(new Error('HTTP ' + r.status), { retry: true });
  if (!r.ok) throw new Error('HTTP ' + r.status + ' ' + u.pathname);
  const j = await r.json();
  return (j && j.body) || {};
}

// У Ultra и Hermès корпус описан всего двумя размерностями (размер и цвет), а галерея
// требует ещё материал и связь — их у таких моделей ровно по одному значению, и Apple
// не публикует их на странице ВООБЩЕ: ни в `products`, ни в `displayValues`, ни где-то
// ещё в HTML. Есть только имена самих размерностей в `warmStateImageSetRules`.
// Поэтому недостающее подбирается — набор закрытый и крошечный, а проверяется он живым
// ответом галереи, так что в работу уходит не догадка, а то, что правда отдало кадры.
const GUESSES = {
  'watch_cases-dimensionCaseMaterial': ['titanium', 'aluminum', 'steel'],
  'watch_cases-dimensionConnection': ['gpscell', 'gps'],
};

// `samples` — несколько разных выборов «корпус + ремешок», а не один. Пробовать на
// одном нельзя: у Hermès первая пара в данных (46 мм + Grand H Fin) не существует как
// товар, ответ на неё пуст при ЛЮБЫХ размерностях — и подбор решал бы, что не подходит
// ничего, оставляя весь прогон без единой фотографии. На этом я уже наступил.
async function fillMissingDims(api, dimParam, rules, samples) {
  const first = samples[0] || {};
  const missing = rules.filter(r => !(r in first) && !r.startsWith('watch_bands-') && GUESSES[r]);
  if (!missing.length) return {};
  const combos = missing.reduce(
    (acc, dim) => acc.flatMap(base => GUESSES[dim].map(v => ({ ...base, [dim]: v }))),
    [{}]
  );
  for (const sample of samples) {
    for (const extra of combos) {
      let body;
      try {
        body = await withRetry(() => galleryFor(api, dimParam, { ...sample, ...extra }));
      } catch (e) {
        continue;
      }
      const got = (body.summary || []).some(it => {
        const img = imageOf(it);
        return img && img.imageName && !/unselect/.test(img.imageName);
      });
      if (got) return extra;
    }
  }
  return {};
}

async function withRetry(fn, tries = 4) {
  let wait = 800;
  for (let i = 1; ; i++) {
    try {
      return await fn();
    } catch (e) {
      if (i >= tries || !(e && (e.retry || e.name === 'TypeError'))) throw e;
      await sleep(wait);
      wait *= 2;
    }
  }
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// Простой пул: держит не больше `jobs` задач в воздухе одновременно.
async function pool(items, jobs, worker) {
  let i = 0;
  const run = async () => {
    while (i < items.length) {
      const n = i++;
      await worker(items[n], n);
    }
  };
  await Promise.all(Array.from({ length: Math.min(jobs, items.length) }, run));
}

// ───────────────────────────── скачивание ──────────────────────────────

async function download(url, file) {
  const r = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'image/*' } });
  if (r.status === 429 || r.status >= 500) throw Object.assign(new Error('HTTP ' + r.status), { retry: true });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  const buf = Buffer.from(await r.arrayBuffer());
  if (buf.length < 512) throw new Error('подозрительно маленький файл: ' + buf.length + ' байт');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.part';
  fs.writeFileSync(tmp, buf);
  fs.renameSync(tmp, file);
  return buf.length;
}

// ─────────────────────────────── главное ───────────────────────────────

async function main() {
  const opt = parseArgs(process.argv.slice(2));
  const model = opt.url.replace(/\/+$/, '').split('/').pop();
  const outDir = path.resolve(opt.out || path.join('apple-photos', model));

  console.log('Страница: ' + opt.url);
  const html = await getText(opt.url);

  const psd = jsonAfter(html, 'productSelectionData:');
  const bandBoot = jsonAfter(html, 'window.pageLevelData.bandSelectionBootstrap');
  const gallery = jsonAfter(html, 'window.buyFlowGallery');
  if (!psd) fail('на странице нет productSelectionData — Apple поменяла разметку');
  if (!gallery || !gallery.productGalleryUrl) fail('на странице нет buyFlowGallery — Apple поменяла разметку');

  // Имя параметра размерностей Apple задаёт сама (сейчас «dm»), поэтому читаем его,
  // а не вписываем числом: поменяют — скрипт продолжит работать.
  let dimParam = 'dm';
  try {
    const p = JSON.parse(gallery.productGalleryParams || '{}');
    if (p.dimensions) dimParam = p.dimensions;
  } catch (e) {
    /* оставим значение по умолчанию */
  }

  const cases = readCases(psd);
  const bands = bandBoot ? readBands(bandBoot) : [];
  if (!cases.length) fail('не нашлось ни одного корпуса');
  console.log('Корпусов: ' + cases.length + ' · вариаций ремешка: ' + bands.length);
  if (!bands.length) console.log('Ремешков в данных нет — соберём только корпуса.');

  // Чего галерее не хватает сверх опубликованного (см. GUESSES) — подбираем один раз.
  const rules = (gallery.productGalleryData && gallery.productGalleryData.summary
    ? gallery.productGalleryData.summary.warmStateImageSetRules
    : null) || [];
  const samples = [];
  for (const c of cases.slice(0, 2)) {
    if (!bands.length) samples.push({ ...c.dims });
    else for (const b of bands.slice(0, 3)) {
      samples.push({
        ...c.dims,
        'watch_bands-dimensionBandStyle': b.style,
        'watch_bands-dimensionColor': b.color,
      });
    }
  }
  const extraDims = await fillMissingDims(gallery.productGalleryUrl, dimParam, rules, samples);
  if (Object.keys(extraDims).length) {
    console.log('Дописаны размерности, которых нет на странице: ' + JSON.stringify(extraDims));
  }

  // ── что качаем: сначала образцы цвета, потом сами кадры ──
  const plan = new Map(); // imageName → {url, file}
  const add = (name, src, dir, base, px) => {
    if (!name || !src || plan.has(name)) return;
    const url = scaleUrl(src, px);
    if (!url) return;
    plan.set(name, { url, file: path.join(outDir, dir, base + extOf(url)) });
  };

  for (const s of caseSwatches(psd)) add(s.name, s.src, 'swatches', 'case-' + slug(s.dim) + '-' + slug(s.value), SWATCH_PX);
  for (const b of bands) {
    const nm = b.swatch && b.swatch.split('/is/')[1] ? b.swatch.split('/is/')[1].split('?')[0] : '';
    add(nm, b.swatch, 'swatches', 'band-' + slug(b.style) + '-' + slug(b.color), SWATCH_PX);
  }
  console.log('Образцов цвета: ' + plan.size);

  // ── обход сочетаний ──
  const combos = [];
  for (const c of cases) {
    if (!bands.length) combos.push({ c, b: null });
    else for (const b of bands) combos.push({ c, b });
  }
  const work = opt.limit > 0 ? combos.slice(0, opt.limit) : combos;
  console.log('Сочетаний к опросу: ' + work.length + (opt.limit ? ' (ограничено --limit)' : ''));

  const manifest = [];
  let asked = 0;
  let empty = 0;

  await pool(work, opt.jobs, async ({ c, b }) => {
    const dims = { ...c.dims, ...extraDims };
    if (b) {
      dims['watch_bands-dimensionBandStyle'] = b.style;
      dims['watch_bands-dimensionColor'] = b.color;
    }
    let body;
    try {
      body = await withRetry(() => galleryFor(gallery.productGalleryUrl, dimParam, dims));
    } catch (e) {
      console.warn('  ! ' + describe(c, b) + ' → ' + e.message);
      return;
    }
    asked++;

    const dir = path.join(
      slug(c.dims['watch_cases-dimensionCaseSize']) +
        '-' +
        slug(c.dims['watch_cases-dimensionColor']) +
        '-' +
        slug(c.dims['watch_cases-dimensionConnection']),
      b ? slug(b.style) + '-' + slug(b.color) : 'case'
    );

    // «summary» — это и есть карточка товара: три четверти, профиль и общий кадр.
    // Остальные секции несут кадры для самих переключателей, они тоже нужны.
    let n = 0;
    for (const [section, list] of Object.entries(body)) {
      if (!Array.isArray(list)) continue;
      for (const it of list) {
        const img = imageOf(it);
        const name = img && img.imageName;
        const src = srcOf(img);
        if (!name || !src) continue;
        // Заглушки «выберите корпус/ремешок» — не фотографии товара.
        if (/unselect/.test(name)) continue;
        const isSummary = section === 'summary';
        const base = (isSummary ? String(++n) + '-' : 'ui-') + viewOf(name);
        add(name, src, isSummary ? dir : 'selectors', isSummary ? base : slug(name), opt.width);
        manifest.push({
          case: c.part,
          caseDims: c.dims,
          band: b ? { style: b.style, color: b.color, part: b.part } : null,
          section,
          imageName: name,
          file: path.relative(outDir, plan.get(name).file),
        });
      }
    }
    if (!n) empty++;
  });

  console.log('Опрошено: ' + asked + ' · без фотографий: ' + empty);
  console.log('Уникальных файлов: ' + plan.size);

  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(
    path.join(outDir, 'manifest.json'),
    JSON.stringify({ url: opt.url, model, width: opt.width, at: new Date().toISOString(), items: manifest }, null, 2)
  );
  console.log('Список записан: ' + path.join(outDir, 'manifest.json'));

  if (opt.dry) {
    console.log('--dry: скачивание пропущено.');
    return;
  }

  const jobs = [...plan.values()].filter(j => opt.force || !fs.existsSync(j.file));
  console.log('К скачиванию: ' + jobs.length + ' (уже на диске: ' + (plan.size - jobs.length) + ')');

  let done = 0;
  let bytes = 0;
  let bad = 0;
  await pool(jobs, opt.jobs, async j => {
    try {
      // Именно так, а не `bytes += await …`: там переменная читается ДО ожидания,
      // и параллельные загрузки затирают счёт друг друга — итог в логе скачет вниз.
      const n = await withRetry(() => download(j.url, j.file));
      bytes += n;
      done++;
      if (done % 25 === 0 || done === jobs.length) {
        console.log('  ' + done + '/' + jobs.length + ' · ' + (bytes / 1048576).toFixed(1) + ' МБ');
      }
    } catch (e) {
      bad++;
      console.warn('  ! ' + path.relative(outDir, j.file) + ' → ' + e.message + '\n    ' + j.url);
    }
  });

  console.log('Готово: ' + done + ' файлов, ' + (bytes / 1048576).toFixed(1) + ' МБ' + (bad ? ', с ошибкой: ' + bad : ''));
  console.log('Папка: ' + outDir);
}

function describe(c, b) {
  const d = c.dims;
  return (
    [d['watch_cases-dimensionCaseSize'], d['watch_cases-dimensionColor'], d['watch_cases-dimensionConnection']].join(' ') +
    (b ? ' + ' + b.style + '/' + b.color : '')
  );
}

main().catch(e => {
  console.error(e && e.stack ? e.stack : e);
  process.exit(1);
});
