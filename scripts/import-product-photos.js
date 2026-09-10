#!/usr/bin/env node
'use strict';

// Заливает выгрузку `scripts/fetch-apple-product.js` в карточки каталога — тем же
// путём, каким фото попадают туда из панели, и никак иначе.
//
//   STORE_DATA_DIR=/var/lib/apple-store node scripts/import-product-photos.js \
//     --src apple-photos/accessories                 # только показать план
//   … --apply                                        # записать
//   … --product usb-c-cable-60w-1m --src apple-photos/accessories/60w-usb-c-charge-cable-1-m
//
// Ключи:
//   --src DIR       папка выгрузки. С manifest.json внутри — один товар; без него
//                   обходятся подпапки, и каждая заливается в свою карточку
//   --product ID    карточка каталога; без него берётся `product` из manifest.json
//   --color NAME    цвет карточки; без него берётся `color` из manifest.json
//   --apply         записать; без него — только план
//   --replace       сначала снять с карточки все прежние фото
//   --files         перечень путей для передачи на сервер (stdout, для `tar -T`)
//
// **`--color` нужен выгрузкам с buy-страниц семейства.** `fetch-apple-buy-photos.js`
// оставляет `product` и `color` в манифесте пустыми намеренно: карточек этих
// товаров в каталоге на момент выгрузки ещё нет, а вписать апловское имя цвета
// значит привязать снимки к варианту, которого магазин не продаёт. Соответствие
// и проставляется здесь — по папке на цвет.
//
// Чем это отличается от `import-watch-photos.js`. Там у снимка две привязки —
// цвет корпуса и вариация ремешка, — и половина скрипта занята тем, чтобы свести
// апловские идентификаторы с нашими названиями. Здесь привязка одна и приходит
// готовой: цвет карточки записан в манифест выгрузки (у кабеля его нет вовсе,
// у чехла он есть, и снимки этой расцветки достаются именно ему).
//
// **Папок на карточку бывает несколько.** У чехла каждая расцветка — своя
// страница Apple, то есть своя папка выгрузки, а карточка одна: заливка идёт
// подряд, фото добавляются к уже лежащим, и `imageColors` набирается по частям.
// Поэтому `--replace` снимает прежние снимки ОДИН раз на карточку, а не на папку:
// иначе вторая расцветка стёрла бы первую.
//
// Обработка идёт ровно теми же вызовами, что и маршрут `/admin/products/:id/images/add`:
// сигнатура файла → `IMG.optimizeMany(UPLOAD_DIR, …, 1200, {square:true})` → `IMG.makeCards`.
// Своей обработки здесь нет ни строчки — разойдясь с маршрутом, она давала бы
// фотографии, не похожие на загруженные руками.
//
// **ImageMagick обязателен.** Без него `lib/images.js` молча отдаёт файл как есть,
// и в каталог уедут исходники вместо сжатых WebP. Скрипт это проверяет и отказывается
// работать — молчаливый провал здесь дороже отказа. Проверка идёт через `await`:
// `detectBin()` асинхронная, и без него остаётся промис, а промис всегда истинный.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const db = require('../lib/db');
const IMG = require('../lib/images');
const { imageExtension } = require('../lib/server-lib');

const PRODUCT_IMAGE_MAX = db.PRODUCT_IMAGE_MAX; // потолок один на маршрут и скрипты

function fail(msg) {
  console.error('Ошибка: ' + msg);
  process.exit(1);
}

function parseArgs(argv) {
  const o = { src: '', product: '', color: '', apply: false, replace: false, files: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--apply') o.apply = true;
    else if (a === '--replace') o.replace = true;
    else if (a === '--files') o.files = true;
    else if (a === '--src') o.src = argv[++i] || '';
    else if (a === '--product') o.product = argv[++i] || '';
    else if (a === '--color') o.color = argv[++i] || '';
    else fail('неизвестный ключ: ' + a);
  }
  if (!o.src) fail('нужен --src <папка выгрузки>');
  return o;
}

// Папки к заливке: сама `--src`, если в ней лежит manifest.json, иначе её подпапки.
function jobsOf(src, forced, forcedColor) {
  const one = dir => {
    const file = path.join(dir, 'manifest.json');
    if (!fs.existsSync(file)) return null;
    const m = JSON.parse(fs.readFileSync(file, 'utf8'));
    const product = forced || m.product || '';
    // Порядок кадров задаёт манифест: он повторяет порядок галереи на apple.com,
    // где первым идёт сам товар, а дальше ракурсы и кадры «в работе».
    const files = (m.images || []).map(i => i.file).filter(f => fs.existsSync(path.join(dir, f)));
    return { dir, product, color: forcedColor || m.color || '', name: m.name || path.basename(dir), files };
  };
  const self = one(src);
  if (self) return [self];
  const out = [];
  for (const entry of fs.readdirSync(src).sort()) {
    const dir = path.join(src, entry);
    if (!fs.statSync(dir).isDirectory()) continue;
    const job = one(dir);
    if (job) out.push(job);
  }
  return out;
}

async function importOne(job, opt, wiped) {
  const product = db.getProduct(job.product);
  if (!product) { console.warn('  ! карточки ' + (job.product || '—') + ' нет в каталоге, пропущено'); return 0; }
  // Цвет из манифеста обязан существовать у товара: иначе снимок получил бы
  // привязку к варианту, которого нет, и галерея не показала бы его никогда.
  const color = job.color && (product.colors || []).some(c => c.name === job.color) ? job.color : '';
  if (job.color && !color) console.warn('  ! у карточки нет цвета «' + job.color + '» — снимки лягут общими');
  // `--replace` снимает прежние фото один раз на карточку: у чехла папок столько
  // же, сколько расцветок, и вторая иначе стёрла бы залитое первой.
  const wipe = opt.replace && !wiped.has(product.id);
  const already = wipe ? 0 : (product.images || []).length;
  const room = Math.max(0, PRODUCT_IMAGE_MAX - already);
  const take = job.files.slice(0, room);
  console.log(product.name + ' (' + product.id + ')' + (color ? ' · ' + color : '') + ': в карточке ' +
    (product.images || []).length + ', заливаем ' + take.length + ' из ' + job.files.length);
  if (take.length < job.files.length) console.warn('  ! потолок ' + PRODUCT_IMAGE_MAX + ' фото — лишние кадры пропущены');
  if (!opt.apply || !take.length) return take.length;
  wiped.add(product.id);

  // ── та же цепочка, что и у ручной загрузки ──
  const names = [];
  for (const f of take) {
    const content = fs.readFileSync(path.join(job.dir, f));
    const ext = imageExtension(content); // сигнатура файла, как в multipart
    if (!ext) { console.warn('  ! не картинка, пропущено: ' + f); continue; }
    const filename = crypto.randomBytes(10).toString('hex') + ext;
    fs.writeFileSync(path.join(db.UPLOAD_DIR, filename), content, { flag: 'wx' });
    names.push(filename);
  }
  const optimized = await IMG.optimizeMany(db.UPLOAD_DIR, names, 1200, { square: true });
  for (const f of optimized) await IMG.makeCards(db.UPLOAD_DIR, f);

  const current = db.getProduct(product.id);
  const keep = wipe ? [] : (current.images || []);
  const imageColors = Object.assign({}, wipe ? {} : (current.imageColors || {}));
  if (color) for (const f of optimized) imageColors[f] = color;
  db.updateProduct(current.id, { images: keep.concat(optimized), imageColors });
  // Снятые фото убираем с диска — как это делает панель.
  if (wipe) for (const f of (current.images || [])) db.deleteUploadIfUnused(f);

  let bytes = 0;
  for (const f of optimized) {
    try { bytes += fs.statSync(path.join(db.UPLOAD_DIR, f)).size; } catch (e) { /* нет — и ладно */ }
  }
  console.log('  ✓ фото в карточке: ' + (db.getProduct(product.id).images || []).length +
    ' · вес обработанных: ' + (bytes / 1048576).toFixed(2) + ' МБ');
  return optimized.length;
}

async function main() {
  const opt = parseArgs(process.argv.slice(2));
  const jobs = jobsOf(opt.src, opt.product, opt.color);
  if (!jobs.length) fail('в ' + opt.src + ' не нашлось ни одной выгрузки с manifest.json');

  // Перечень для передачи на сервер считается ТЕМ ЖЕ обходом, что и заливка,
  // иначе на сервер уехал бы один набор файлов, а искался бы там другой.
  if (opt.files) {
    for (const j of jobs) {
      console.log(path.join(j.dir, 'manifest.json'));
      for (const f of j.files) console.log(path.join(j.dir, f));
    }
    return;
  }

  const noProduct = jobs.filter(j => !j.product);
  if (noProduct.length) {
    console.warn('Без карточки в манифесте (пропустим): ' + noProduct.map(j => path.basename(j.dir)).join(', '));
    console.warn('Допишите id второй колонкой в scripts/apple-accessories.txt и повторите выгрузку.\n');
  }

  // ── ImageMagick обязателен: без него в каталог уедут необработанные исходники ──
  if (opt.apply && !(await IMG.detectBin())) {
    fail('ImageMagick не найден — фото ушли бы в каталог без обработки. apt install imagemagick webp');
  }

  let total = 0;
  const wiped = new Set();
  for (const job of jobs) {
    if (!job.product) continue;
    total += await importOne(job, opt, wiped);
  }
  console.log('\nГотово. Карточек: ' + jobs.filter(j => j.product).length + ' · снимков: ' + total +
    (opt.apply ? '' : '. Это только план — тот же вызов с --apply запишет.'));
}

main().catch(e => fail(e.stack || e.message));
