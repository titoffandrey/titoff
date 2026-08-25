#!/usr/bin/env node
'use strict';

// Заливает выгрузку `scripts/fetch-apple-watch-photos.js` в карточку часов —
// тем же путём, каким фото попадают в каталог из панели, и никак иначе.
//
//   STORE_DATA_DIR=/var/lib/apple-store node scripts/import-watch-photos.js \
//     --product watch-se-3 --src /tmp/apple-watch-se           # только показать план
//   … --apply                                                  # записать
//
// Ключи:
//   --product ID     карточка каталога (обязательно)
//   --src DIR        папка выгрузки с manifest.json (обязательно)
//   --size 40mm      какой размер корпуса брать (по умолчанию первый в выгрузке)
//   --conn gps       какую связь брать (по умолчанию gps)
//   --views a,b      ракурсы по порядку (по умолчанию 1-34fr,2-pf)
//   --apply          записать; без него — только план
//   --replace        сначала снять с карточки все прежние фото
//
// Почему берётся ОДИН размер корпуса и ОДНА связь. У снимка в нашей модели две
// привязки — цвет корпуса (`imageColors`) и вариация ремешка (`imageBands`), и
// ни одной под размер корпуса или связь. Взяв все восемь артикулов, мы положили
// бы в галерею по четыре почти одинаковых кадра на каждую пару, которые нечем
// развести: галерея фильтрует список по варианту, а варианта «44 мм» у снимка нет.
//
// Обработка идёт ровно теми же вызовами, что и маршрут `/admin/products/:id/images/add`:
// сигнатура файла → `IMG.optimizeMany(UPLOAD_DIR, …, 1200, {square:true})` → `IMG.makeCards`.
// Своей обработки здесь нет ни строчки — разойдясь с маршрутом, она давала бы
// фотографии, не похожие на загруженные руками.
//
// **ImageMagick обязателен.** Без него `lib/images.js` молча отдаёт файл как есть,
// и в каталог уедут исходники вместо сжатых WebP. Скрипт это проверяет и отказывается
// работать — молчаливый провал здесь дороже отказа.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const db = require('../lib/db');
const IMG = require('../lib/images');
const { imageExtension } = require('../lib/server-lib');

const PRODUCT_IMAGE_MAX = 100; // тот же потолок, что в server.js

// ─────────────────────── соответствия названий ───────────────────────

// Наши названия коллекций и апловские id стилей. Большинство сходится обычной
// нормализацией («Solo Loop» → `sololoop`), в таблице только те, что не сходятся.
const STYLE_ALIAS = {
  sportband: 'sport',
  modernbuckle: 'modbuckle',
  milaneseloop: 'milanese',
  linkbracelet: 'link',
};

// Цвет корпуса у нас по-русски, у Apple — латиницей. Нормализацией это не берётся,
// поэтому таблица; незнакомый цвет скрипт называет вслух, а не пропускает молча.
// Ключи пишутся через «е»: normRu() сводит к ней «ё», иначе «Чёрный титан» не найдётся.
const CASE_COLOR = {
  'полуночный': 'midnight',
  'сияющая звезда': 'starlight',
  'серебристый': 'silver',
  'серый космос': 'spacegray',
  'натуральный титан': 'natural',
  'золотой титан': 'gold',
  'сланцевый титан': 'slate',
  'черный титан': 'black',
};

// У Apple цвет ремешка бывает привязан к цвету корпуса: спортивный «Black»
// продаётся только со «Сияющей звездой», а с полуночным корпусом идёт «Midnight» —
// тот же тёмный ремешок под другим именем. У нас в каталоге он один, «Black»,
// поэтому для полуночного корпуса подставляется апловский `midnight`.
const BAND_COLOR_BY_CASE = {
  'midnight|sport|black': 'midnight',
};

const norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
// «е» и «ё» в названиях цветов пишут вперемешку, поэтому сводим к одной букве.
const normRu = s => String(s || '').toLowerCase().replace(/ё/g, 'е').replace(/\s+/g, ' ').trim();

function styleOf(name) {
  const n = norm(name);
  return STYLE_ALIAS[n] || n;
}

// ────────────────────────────── аргументы ──────────────────────────────

function parseArgs(argv) {
  const o = { product: '', src: '', size: '', conn: 'gps', views: '1-34fr,2-pf', apply: false, replace: false, files: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--apply') o.apply = true;
    else if (a === '--files') o.files = true;
    else if (a === '--replace') o.replace = true;
    else if (a === '--product') o.product = argv[++i];
    else if (a === '--src') o.src = argv[++i];
    else if (a === '--size') o.size = argv[++i];
    else if (a === '--conn') o.conn = argv[++i];
    else if (a === '--views') o.views = argv[++i];
    else fail('неизвестный ключ: ' + a);
  }
  if (!o.product) fail('нужен --product <id карточки>');
  if (!o.src) fail('нужен --src <папка выгрузки>');
  return o;
}

function fail(msg) {
  console.error('Ошибка: ' + msg);
  process.exit(1);
}

// ─────────────────────────────── главное ───────────────────────────────

async function main() {
  const opt = parseArgs(process.argv.slice(2));
  const views = opt.views.split(',').map(s => s.trim()).filter(Boolean);

  const manifestPath = path.join(opt.src, 'manifest.json');
  if (!fs.existsSync(manifestPath)) fail('в ' + opt.src + ' нет manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

  // При --files на stdout уходит только перечень путей: его подхватывает tar,
  // и посторонние строки там читались бы как имена файлов.
  const say = opt.files ? () => {} : (...a) => console.log(...a);

  const product = db.getProduct(opt.product);
  if (!product) fail('карточки ' + opt.product + ' нет в каталоге');
  say('Карточка: ' + product.name + ' (' + product.id + ')');
  say('Фото сейчас: ' + (product.images || []).length);

  // Размер корпуса: берём заданный либо первый попавшийся в выгрузке.
  const sizes = [...new Set(manifest.items.map(i => i.caseDims && i.caseDims['watch_cases-dimensionCaseSize']).filter(Boolean))];
  const size = opt.size || sizes[0];
  if (!sizes.includes(size)) fail('в выгрузке нет размера ' + size + ' (есть: ' + sizes.join(', ') + ')');
  say('Берём: корпус ' + size + ', связь ' + opt.conn + ', ракурсы ' + views.join(' + '));

  // Индекс выгрузки: «цвет корпуса|стиль|цвет ремешка» → файлы в порядке ракурсов.
  const idx = new Map();
  for (const it of manifest.items) {
    if (it.section !== 'summary' || !it.band) continue;
    const d = it.caseDims || {};
    if (d['watch_cases-dimensionCaseSize'] !== size) continue;
    if (d['watch_cases-dimensionConnection'] !== opt.conn) continue;
    const key = d['watch_cases-dimensionColor'] + '|' + it.band.style + '|' + norm(it.band.color);
    if (!idx.has(key)) idx.set(key, []);
    idx.get(key).push(it.file);
  }

  // ── план: что к какой паре «цвет корпуса + вариация ремешка» ──
  const plan = [];
  const missing = [];
  const unknownColors = new Set();

  for (const c of product.colors || []) {
    const apCase = CASE_COLOR[normRu(c.name)];
    if (!apCase) { unknownColors.add(c.name); continue; }
    for (const g of product.bands || []) {
      const style = styleOf(g.name);
      for (const o of g.options || []) {
        const want = apCase + '|' + style + '|' + norm(o.name);
        const alias = BAND_COLOR_BY_CASE[want];
        const key = alias ? apCase + '|' + style + '|' + alias : want;
        const files = (idx.get(key) || [])
          .filter(f => views.some(v => f.endsWith(v + '.jpg')))
          .sort((a, b) => views.findIndex(v => a.endsWith(v + '.jpg')) - views.findIndex(v => b.endsWith(v + '.jpg')));
        if (!files.length) { missing.push(c.name + ' · ' + g.name + ' · ' + o.name); continue; }
        for (const f of files) plan.push({ file: f, color: c.name, band: g.name + '|' + o.name });
      }
    }
  }

  if (unknownColors.size) {
    say('\nЦвета корпуса без соответствия (пропущены, допиши CASE_COLOR):');
    for (const c of unknownColors) say('   ' + c);
  }
  say('\nПар покрыто: ' + new Set(plan.map(p => p.color + '|' + p.band)).size + ' · снимков: ' + plan.length);
  if (missing.length) {
    say('Без фотографий (' + missing.length + '):');
    for (const m of missing) say('   ' + m);
  }

  if (!plan.length) fail('нечего заливать');

  // Перечень для передачи на сервер: считается ТЕМ ЖЕ отбором, что и заливка,
  // иначе на сервер уехал бы один набор файлов, а искался бы там другой.
  if (opt.files) {
    for (const f of [...new Set(plan.map(p => p.file))]) console.log(f);
    return;
  }

  const already = opt.replace ? 0 : (product.images || []).length;
  if (already + plan.length > PRODUCT_IMAGE_MAX) {
    fail(
      'не влезает: в карточке ' + already + ' фото, к заливке ' + plan.length +
      ', потолок ' + PRODUCT_IMAGE_MAX + '. Убери ракурс из --views или почисти карточку.'
    );
  }

  if (!opt.apply) {
    console.log('\nЭто только план. Записать — тот же вызов с --apply.');
    return;
  }

  // ── ImageMagick обязателен: без него в каталог уедут необработанные исходники ──
  // detectBin() АСИНХРОННАЯ: без await здесь остаётся промис, а он всегда истинный,
  // и проверка не срабатывает никогда — 88 исходников уезжают в каталог необработанными.
  if (!(await IMG.detectBin())) {
    fail('ImageMagick не найден — фото ушли бы в каталог без обработки. apt install imagemagick webp');
  }

  // ── та же цепочка, что и у ручной загрузки ──
  const names = [];
  for (const p of plan) {
    const content = fs.readFileSync(path.join(opt.src, p.file));
    const ext = imageExtension(content); // сигнатура файла, как в multipart
    if (!ext) { console.warn('  ! не картинка, пропущено: ' + p.file); continue; }
    const filename = crypto.randomBytes(10).toString('hex') + ext;
    fs.writeFileSync(path.join(db.UPLOAD_DIR, filename), content, { flag: 'wx' });
    names.push({ filename, color: p.color, band: p.band });
  }
  console.log('\nПеренесено в uploads: ' + names.length + ', обрабатываю…');

  const optimized = await IMG.optimizeMany(db.UPLOAD_DIR, names.map(n => n.filename), 1200, { square: true });
  for (const f of optimized) await IMG.makeCards(db.UPLOAD_DIR, f);

  // Оптимизация меняет имя файла (webp), поэтому привязки переносим по позиции.
  const current = db.getProduct(product.id);
  const keep = opt.replace ? [] : (current.images || []);
  const images = keep.concat(optimized);
  const imageColors = Object.assign({}, opt.replace ? {} : (current.imageColors || {}));
  const imageBands = Object.assign({}, opt.replace ? {} : (current.imageBands || {}));
  optimized.forEach((f, i) => {
    imageColors[f] = names[i].color;
    imageBands[f] = names[i].band;
  });
  db.updateProduct(current.id, { images, imageColors, imageBands });

  // Снятые фото убираем с диска — как это делает панель.
  if (opt.replace) for (const f of (current.images || [])) db.deleteUploadIfUnused(f);

  const after = db.getProduct(product.id);
  let bytes = 0;
  for (const f of optimized) {
    try { bytes += fs.statSync(path.join(db.UPLOAD_DIR, f)).size; } catch (e) { /* нет — и ладно */ }
  }
  console.log('Готово. Фото в карточке: ' + (after.images || []).length + ' · вес обработанных: ' + (bytes / 1048576).toFixed(1) + ' МБ');
}

main().catch(e => {
  console.error(e && e.stack ? e.stack : e);
  process.exit(1);
});
