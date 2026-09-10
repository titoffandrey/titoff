#!/usr/bin/env node
'use strict';

// Выгрузка фотографий с buy-страницы СЕМЕЙСТВА — apple.com/shop/buy-iphone/…,
// buy-airpods/… и подобных. Офлайн-инструмент для наполнения каталога: кадры
// потом заливаются в карточку скриптом `scripts/import-product-photos.js`,
// витрина об этой выгрузке не знает.
//
//   node scripts/fetch-apple-buy-photos.js https://www.apple.com/shop/buy-iphone/iphone-duo
//   node scripts/fetch-apple-buy-photos.js <url> --dry          # разобрать, ничего не качать
//   node scripts/fetch-apple-buy-photos.js <url> --out apple-photos/duo --force
//
// Ключи:
//   --out DIR   куда складывать (по умолчанию apple-photos/<слаг адреса>)
//   --dry       не качать файлы, только показать, что нашлось
//   --force     перекачать уже скачанное
//   --limit N   взять не больше N сочетаний размерностей (для пробы)
//   --jobs N    сколько файлов качать параллельно (по умолчанию 4)
//
// ЧЕМ ЭТО ОТЛИЧАЕТСЯ ОТ ДВУХ СОСЕДНИХ ВЫГРУЗОК.
//
// `fetch-apple-product.js` берёт обычную страницу товара (`/shop/product/…`),
// где список кадров лежит прямо в разметке блоком JSON-LD `ImageGallery`.
// `fetch-apple-watch-photos.js` — buy-страницу ЧАСОВ: там свой эндпоинт
// (`/shop/api/kit-product-gallery`) и своя пара размерностей «корпус + ремешок».
// Здесь третий случай: buy-страница семейства, где кадры отдаёт
// `/shop/api/product-gallery`, а выбор передаётся размерностями `dm.<имя>`.
//
// **Адрес галереи и имя параметра ЧИТАЮТСЯ СО СТРАНИЦЫ** (`buyFlowGallery`), а не
// вписаны сюда числом: и то и другое — внутренняя кухня магазина Apple, и она уже
// менялась (у часов до сих пор свой эндпоинт).
//
// **РАЗМЕР КАДРА МЕНЯТЬ НЕЛЬЗЯ ВОВСЕ, и это отличие от buy-watch.** Там `.v` в
// адресе — подпись под точный набор параметров, и без неё кадр отдаётся в любом
// размере. Здесь Scene7 отвечает 404 на любую правку `wid`/`hei` — и с токеном,
// и без него (проверено на всех четырёх вариантах). Поэтому адрес берётся
// выданным, как есть: кадры приходят в 5120×2880, а до 1200 их ужмёт уже наш
// пайплайн заливки.
//
// **Пустой ответ на сочетание — это норма, а не ошибка.** Часть сочетаний не
// существует как товар, и галерея на них отвечает пустым списком; такие мы
// считаем и идём дальше — ровно как выгрузка часов с её Modern Buckle.

const fs = require('fs');
const path = require('path');

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15';
const ROOT = path.join(__dirname, '..');

// Размерности, которые правда меняют КАДР ТОВАРА. Ёмкость, оператор и способ
// оплаты галерею не трогают (у ёмкости свой кадр «storage-select» — это экран
// выбора памяти, а не ракурс товара), а перебор по ним умножил бы работу впустую.
const GALLERY_DIMS = ['dimensionScreensize', 'dimensionColor', 'dimensionCase', 'dimensionCharging'];
// Миниатюры галереи и служебные картинки страницы кадрами товара не являются.
// AppleCare, обмен и рассрочка попадают в тот же поток адресов и в большом
// размере — по одному лишь размеру их от кадра товара не отличить.
// `storage-select` — тот же самый кадр, что и `finish-select`, только показанный
// на шаге выбора памяти: у iPhone 18 Pro оба файла совпадают побайтно
// (sha1 07003de1b70d…), у Duo это он же в jpeg. В галерее товара он давал бы
// второй такой же снимок первым номером.
const SKIP_NAMES = /thumb|swatch|-og-|icon|logo|compare|badge|unselect|storage-select|applecare|tradein|trade-in|financing|carrier|setup|payment/i;

function fail(msg) {
  console.error('Ошибка: ' + msg);
  process.exit(1);
}

// ────────────────────────────── аргументы ──────────────────────────────

function parseArgs(argv) {
  const o = { urls: [], out: '', dry: false, force: false, limit: 0, jobs: 4 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--out') o.out = argv[++i] || '';
    else if (a === '--dry') o.dry = true;
    else if (a === '--force') o.force = true;
    else if (a === '--limit') o.limit = Number(argv[++i]) || 0;
    else if (a === '--jobs') o.jobs = Math.max(1, Number(argv[++i]) || 4);
    else if (a.startsWith('--')) fail('неизвестный ключ ' + a);
    else o.urls.push(a);
  }
  if (!o.urls.length) fail('нужен адрес buy-страницы apple.com');
  if (o.out && o.urls.length > 1) fail('--out задаётся одному адресу');
  return o;
}

// ────────────────────────────── сеть ──────────────────────────────

async function get(url, asJson) {
  const res = await fetch(url, {
    headers: { 'User-Agent': UA, 'Accept-Language': 'en-US,en;q=0.9', Accept: asJson ? 'application/json' : '*/*' },
    redirect: 'follow'
  });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  return asJson ? res.json() : res.text();
}

function slugOf(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

// ────────────────────────────── разбор страницы ──────────────────────────────

// JS-присваивание, а не отдельный <script type=json>: объект вырезаем счётом скобок.
function jsonAfter(src, from) {
  let depth = 0;
  for (let i = from; i < src.length; i++) {
    const c = src[i];
    if (c === '{' || c === '[') depth++;
    else if (c === '}' || c === ']') { depth--; if (!depth) return src.slice(from, i + 1); }
  }
  return '';
}

function galleryOf(html) {
  const m = html.match(/buyFlowGallery\s*=\s*\{/);
  if (!m) return null;
  let data;
  try { data = JSON.parse(jsonAfter(html, m.index + m[0].length - 1)); } catch (e) { return null; }
  const url = String(data.productGalleryUrl || '');
  if (!url) return null;
  // Имя параметра размерностей у Apple лежит рядом с адресом: «dimensions» → «dm».
  let dimKey = 'dm';
  try {
    const params = JSON.parse(String(data.productGalleryParams || '{}'));
    if (params.dimensions) dimKey = String(params.dimensions);
  } catch (e) { /* формат поменялся — остаётся привычное dm */ }
  return { url: url.startsWith('http') ? url : 'https://www.apple.com' + url, dimKey };
}

// Значения размерностей страница повторяет у каждого артикула: «"dimensionColor":"nightsky"».
// Списком их нигде нет, поэтому собираем встречающиеся — порядок первого появления
// совпадает с порядком кнопок на странице.
function dimensionsOf(html) {
  const out = new Map();
  const re = /"(dimension[A-Za-z]+)"\s*:\s*"([^"]+)"/g;
  let m;
  while ((m = re.exec(html))) {
    const [, name, value] = m;
    if (!GALLERY_DIMS.includes(name)) continue;
    if (/^fullwidth$/i.test(value)) continue;           // служебное значение раскладки, не вариант товара
    if (!out.has(name)) out.set(name, []);
    const list = out.get(name);
    if (!list.includes(value)) list.push(value);
  }
  return [...out.entries()].filter(([, v]) => v.length).map(([name, values]) => ({ name, values }));
}

// Декартово произведение размерностей: у Duo это цвета, у 18 Pro — размер экрана × цвет.
function combos(dims) {
  let list = [{}];
  for (const d of dims) {
    const next = [];
    for (const base of list) for (const v of d.values) next.push(Object.assign({}, base, { [d.name]: v }));
    list = next;
  }
  return list;
}

// Кадры из ответа галереи. Массивы там дублируют друг друга (один и тот же набор
// лежит под каждой размерностью), поэтому сводим по имени картинки.
function shotsOf(body) {
  const seen = new Map();
  for (const value of Object.values(body || {})) {
    if (!Array.isArray(value)) continue;
    for (const item of value) {
      const image = item && item.asset && item.asset.image;
      if (!image || !Array.isArray(image.sources)) continue;
      const name = String(image.imageName || '');
      if (!name || seen.has(name) || SKIP_NAMES.test(name)) continue;
      // Первый source — webp: он и легче, и того же разрешения, что jpeg рядом.
      const src = String((image.sources[0] || {}).srcSet || '').split(/\s+/)[0];
      if (!/^https:\/\//.test(src)) continue;
      seen.set(name, { name, src, alt: String(image.alt || ''), w: Number(image.width) || 0, h: Number(image.height) || 0 });
    }
  }
  return [...seen.values()];
}

// Запасной путь для страниц без галереи (AirPods): кадры лежат прямо в разметке.
function shotsFromHtml(html) {
  const seen = new Map();
  const re = /https:\/\/store\.storeimages\.cdn-apple\.com\/[^"'\\ ]+/g;
  let m;
  while ((m = re.exec(html))) {
    const src = m[0].replace(/&amp;/g, '&');
    const name = (src.split('/is/')[1] || '').split('?')[0];
    if (!name || seen.has(name) || SKIP_NAMES.test(name)) continue;
    const wid = Number((src.match(/wid=(\d+)/) || [])[1]) || 0;
    if (wid < 1000) continue;                            // мелочь со страницы — не кадр товара
    seen.set(name, { name, src, alt: '', w: wid, h: Number((src.match(/hei=(\d+)/) || [])[1]) || 0 });
  }
  return [...seen.values()];
}

// ────────────────────────────── скачивание ──────────────────────────────

async function download(shot, dir, opt) {
  const ext = /fmt=([a-z]+)/.exec(shot.src) ? RegExp.$1.replace('p-jpg', 'jpg').replace('jpeg', 'jpg') : 'jpg';
  const file = shot.name.replace(/[^A-Za-z0-9_-]/g, '-') + '.' + (ext === 'webp' ? 'webp' : 'jpg');
  const full = path.join(dir, file);
  if (!opt.force && fs.existsSync(full) && fs.statSync(full).size > 0) return { file, bytes: 0, skipped: true };
  if (opt.dry) return { file, bytes: 0, skipped: false };
  const res = await fetch(shot.src, { headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error(shot.name + ': HTTP ' + res.status);
  const body = Buffer.from(await res.arrayBuffer());
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(full, body);
  return { file, bytes: body.length, skipped: false };
}

async function pool(items, size, worker) {
  const out = [];
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, async () => {
    while (i < items.length) out.push(await worker(items[i++]));
  }));
  return out;
}

// ────────────────────────────── одна страница ──────────────────────────────

async function one(url, opt) {
  const html = await get(url);
  const family = slugOf(new URL(url).pathname.split('/').filter(Boolean).pop());
  const base = opt.out ? path.resolve(opt.out) : path.join(ROOT, 'apple-photos', family);
  const gallery = galleryOf(html);
  const dims = gallery ? dimensionsOf(html) : [];
  const jobs = [];

  if (gallery && dims.length) {
    let list = combos(dims);
    if (opt.limit) list = list.slice(0, opt.limit);
    console.log(`${url}\n  галерея: ${gallery.url.replace(/^https:\/\/www\.apple\.com/, '')}`);
    console.log('  размерности: ' + dims.map(d => `${d.name} (${d.values.length})`).join(' × ') + ` → ${list.length} сочетаний`);
    let empty = 0;
    for (const pick of list) {
      const q = Object.entries(pick).map(([k, v]) => `${gallery.dimKey}.${k}=${encodeURIComponent(v)}`).join('&');
      let body;
      try { body = (await get(gallery.url + '&' + q, true)).body; } catch (e) { console.error('  ! ' + q + ' — ' + e.message); continue; }
      const shots = shotsOf(body);
      if (!shots.length) { empty++; continue; }
      const label = Object.values(pick).map(slugOf).join('-');
      jobs.push({ dir: path.join(base, label), label, pick, shots });
    }
    if (empty) console.log(`  сочетаний без кадров: ${empty} (у Apple их не бывает как товара)`);
  } else {
    // Галереи нет — берём то, что страница показывает сама (так устроен AirPods 5).
    const shots = shotsFromHtml(html);
    console.log(`${url}\n  галереи по размерностям нет — кадры со страницы: ${shots.length}`);
    if (shots.length) jobs.push({ dir: base, label: '', pick: {}, shots });
  }

  let files = 0, bytes = 0, skipped = 0;
  for (const job of jobs) {
    const done = await pool(job.shots, opt.jobs, async shot => {
      try { return await download(shot, job.dir, opt); } catch (e) { console.error('  ! ' + e.message); return null; }
    });
    const ok = done.filter(Boolean);
    files += ok.length;
    bytes += ok.reduce((s, r) => s + r.bytes, 0);
    skipped += ok.filter(r => r.skipped).length;
    if (!opt.dry) {
      fs.mkdirSync(job.dir, { recursive: true });
      // Манифест того же вида, что у `fetch-apple-product.js`: заливка
      // `import-product-photos.js` читает его как есть.
      // `product` и `color` оставляем пустыми намеренно: карточки этих товаров в
      // каталоге ещё нет, а вписать сюда апловское имя цвета значит привязать
      // снимки к варианту, которого магазин не продаёт (см. «Чехлы и защита»).
      fs.writeFileSync(path.join(job.dir, 'manifest.json'), JSON.stringify({
        product: '', color: '', name: family + (job.label ? ' · ' + job.label : ''),
        url, family, dimensions: job.pick, fetched: new Date().toISOString(),
        images: job.shots.map(s => ({
          file: s.name.replace(/[^A-Za-z0-9_-]/g, '-') + (/fmt=webp/.test(s.src) ? '.webp' : '.jpg'),
          name: s.name, src: s.src, alt: s.alt, w: s.w, h: s.h
        }))
      }, null, 2) + '\n');
    }
    console.log(`  ${job.label || family}: ${job.shots.length} кадров`);
  }
  const mb = (bytes / 1048576).toFixed(1);
  console.log(`  итого: ${files} файлов${skipped ? `, из них уже было ${skipped}` : ''}, скачано ${mb} МБ → ${path.relative(process.cwd(), base)}\n`);
  return { files, bytes };
}

// ────────────────────────────── main ──────────────────────────────

(async () => {
  const opt = parseArgs(process.argv.slice(2));
  if (opt.dry) console.log('Пробный прогон: ничего не качаем\n');
  let files = 0, bytes = 0;
  for (const url of opt.urls) {
    try {
      const r = await one(url, opt);
      files += r.files; bytes += r.bytes;
    } catch (e) {
      console.error('! ' + url + ' — ' + e.message);
    }
  }
  console.log(`Всего: ${files} файлов, ${(bytes / 1048576).toFixed(1)} МБ`);
  if (!opt.dry) console.log('Заливка в карточку — scripts/import-product-photos.js (на сервере, ему нужен ImageMagick).');
})();
