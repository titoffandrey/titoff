'use strict';
/*
 * Оптимизация загруженных изображений: очистка ВСЕХ метаданных (EXIF/GPS/камера — анонимность)
 * и конвертация в WebP (быстрая загрузка для посетителей). Работает через ImageMagick,
 * который есть в системе (apt install imagemagick webp). Без npm-зависимостей.
 * Если ImageMagick не установлен — файл остаётся как есть (graceful fallback), сайт не падает.
 */
const { execFile } = require('child_process');
const util = require('util');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const execFileP = util.promisify(execFile);

let BIN; // 'magick' | 'convert' | null — определяется один раз
const PRODUCT_BG = '#f5f5f7';

async function detectBin() {
  if (BIN !== undefined) return BIN;
  for (const cand of ['convert', 'magick']) {
    try { await execFileP(cand, ['-version']); BIN = cand; return BIN; }
    catch (e) { /* пробуем следующий */ }
  }
  BIN = null;
  return BIN;
}

// Конвертировать один файл в оптимизированный WebP без метаданных.
// opts.square: щадящая нормализация под каталог — убрать только почти однотонные внешние
// поля, целиком вписать найденный товар в квадрат и добавить одинаковый воздух по краям.
// Низкий fuzz не «съедает» белые наушники, как прежнее агрессивное значение 9%.
// Возвращает новое имя файла (.webp) либо исходное, если конвертация недоступна/не удалась.
// Насколько разрешено увеличивать мелкий снимок. Без этого товар, снятый мелко
// на большом белом фоне, оставался крошкой в центре карточки: флаг `>` у -resize
// разрешает только уменьшение.
//
// Было 3.5 — и это оказалось перестраховкой. В каталоге лежат студийные рендеры
// Apple: ровные матовые поверхности почти без мелкой фактуры, растягивать там
// нечего портить. Зато исходники с мелким товаром (у нас попадались с планшетом
// высотой ~140px) упирались в потолок и оставались на 41% кадра рядом с
// соседями на 92% — на витрине это читалось как брак обработки. Проверено
// глазами: 8× по такому снимку даёт лёгкую мягкость на гранях, но не мыло.
// Значение выбрано так, чтобы худший наш случай (140px) дотягивал до 1104px.
// Для снимка с мелким текстом или фактурой такой запас был бы велик.
const MAX_UPSCALE = 8;
// Какую долю кадра занимает товар. Чем больше — тем плотнее карточка; остаток
// уходит на поля вокруг.
const CONTENT_RATIO = 0.92;

// Во сколько пикселей вписывать товар после обрезки полей.
// box — размеры найденного товара (из -trim), null — если определить не удалось.
function targetContentSize(box, maxSize) {
  const contentSize = Math.round(maxSize * CONTENT_RATIO);
  if (!box || !(box.w > 0) || !(box.h > 0)) return null;      // не знаем размер — прежнее поведение
  const longest = Math.max(box.w, box.h);
  if (longest >= contentSize) return contentSize;             // большое фото просто уменьшаем
  return Math.min(contentSize, Math.round(longest * MAX_UPSCALE));
}

// Обрезка полей идёт ДВА раза. Фото товара обычно снято на белом, а наш кадр
// докрашивается серым #f5f5f7: разница между ними больше 2% fuzz, поэтому один
// -trim снимал только серую рамку и останавливался на белом прямоугольнике
// исходного снимка. Товар внутри так и оставался мелким. Второй проход убирает
// уже белое поле. Fuzz низкий, чтобы не «съесть» белый товар вроде наушников.
// Допуск подбирается: 2 % хватает для ровной заливки, но у части снимков фон —
// мягкий градиент или виньетка, и на них строгая обрезка не находит вообще
// ничего: кадр остаётся целиком, а товар ужимается вместе с пустыми полями.
// Идём от строгого к мягкому и берём первый допуск, который реально что-то
// обрезал. Начинать со строгого важно, чтобы не съесть белый товар (наушники).
const TRIM_FUZZ = [2, 8, 15];
const trimArgs = (fuzz) => ['-fuzz', fuzz + '%', '-trim', '+repage', '-fuzz', fuzz + '%', '-trim', '+repage'];
const TRIM_ARGS = trimArgs(TRIM_FUZZ[0]);

/* ---------- Фон исходника приводится к цвету плиты ПРОПОРЦИОНАЛЬНО ----------
 *
 * Снимок приезжает на своём фоне — белом со страниц товара apple.com, #fafafa с
 * buy-watch, #f6f5f8 с buy-iphone, — а кадр докрашивается плитой #f5f5f7. После
 * обрезки внутри кадра остаётся прямоугольник исходника своего цвета: у часов на
 * тёмном ремешке это светлый ящик за товаром, у белого адаптера — белые «уши» в
 * углах. Прятал его CSS: `mix-blend-mode:darken` прижимал к плите всё, что её
 * светлее. Но светлее плиты не только фон — светлее плиты БЕЛЫЙ КОРПУС товара,
 * и darken прижимал к плите и его: у адаптера на 140 Вт оставалась одна тень по
 * контуру, а сам он сливался с подложкой (10 сентября 2026, жалоба владельца).
 *
 * Правильно не срезать светлое, а МАСШТАБИРОВАТЬ: каждый канал умножается на
 * такой множитель, чтобы фон исходника стал ровно цветом плиты. Белый корпус при
 * этом тоже становится цветом плиты — но и его тень темнеет в той же пропорции,
 * поэтому контраст «корпус — тень» остаётся тем, каким его нарисовала Apple для
 * своей белой страницы. Ровно так белый товар и виден на apple.com: он того же
 * цвета, что фон, а читается по объёму. Ящика за товаром больше нет ни снаружи
 * (углы), ни внутри (дырка петли ремешка): фон везде стал плитой.
 *
 * Цена — общее потемнение на 2–4 %: у тёмных и цветных товаров глазом не видно
 * (замер на ремешке Braided Solo Loop и Starlight-корпусе: разницы нет), у белых
 * это и есть искомый результат.
 *
 * Фон меряется по ЧЕТЫРЁМ углам, и все четыре обязаны сходиться: разъехались —
 * это сцена, а не студийный фон, и трогать её нельзя. Тёмный фон тоже не
 * трогаем: множитель вышел бы далеко за единицу и выжег бы блики.
 *
 * Кадр, уже приведённый нами к плите (повторный прогон refit), узнаётся по углам
 * цвета плиты. Фон исходника тогда лежит ВНУТРИ, и меряется он по углам рамки
 * товара, которую уже посчитал `contentBox()`: `-extent` центрирует, поэтому
 * положение рамки в кадре — арифметика. Срезать плиту `-trim` и мерить углы
 * остатка нельзя: в сохранённом webp плита не плоская (lossy даёт ±3 уровня), и
 * плотный допуск упирается в этот шум, не дойдя до исходника, — на боевых файлах
 * так и вышло. Рамка меряется с допуском 2 %, для которого шум плиты невидим.
 */
const BG_MIN = 200;        // темнее — не фон студии, а сцена
const BG_SPREAD = 4;       // разброс между углами, уровней
const NORM_MIN = 0.94;     // множитель за этими границами — фон слишком далёк от плиты,
const NORM_MAX = 1.03;     // и «привести» его значило бы перекрасить снимок целиком
const NORM_SKIP = 3.5;     // фон ближе трёх с половиной уровней к плите — глазом не отличить,
                           // файл не трогаем (сюда же попадает шум lossy у нашей же плиты)
const PLATE_NEAR = 6;      // угол в этих пределах от плиты — это наш кадр, фон исходника внутри
const BOX_INSET = 8;       // отступ внутрь рамки товара: у неё погрешность ±3 px от замера на копии
const PLATE_RGB = [1, 3, 5].map(i => parseInt(PRODUCT_BG.slice(i, i + 2), 16));

// По угловым цветам решить, каким множителем (по каналам) привести фон к плите.
// null — приводить нечего или нельзя: фон уже плита, углы не сходятся, фон тёмный
// либо множитель вышел за границы. Чистая функция — её и проверяет тест.
function bgLevels(corners) {
  if (!Array.isArray(corners) || !corners.length) return null;
  const bg = [];
  for (let c = 0; c < 3; c++) {
    const values = corners.map(p => Number(p[c]));
    if (values.some(v => !Number.isFinite(v))) return null;
    if (Math.max(...values) - Math.min(...values) > BG_SPREAD) return null;
    if (Math.min(...values) < BG_MIN) return null;
    bg.push(values.reduce((s, v) => s + v, 0) / values.length);
  }
  if (bg.every((v, c) => Math.abs(v - PLATE_RGB[c]) <= NORM_SKIP)) return null;
  const levels = bg.map((v, c) => PLATE_RGB[c] / v);
  if (levels.some(f => !(f >= NORM_MIN && f <= NORM_MAX))) return null;
  return levels;
}

// Аргументы ImageMagick для множителей: -evaluate уважает -channel, поэтому три
// канала идут подряд, а +channel в конце возвращает обычный режим остальным шагам.
function levelsArgs(levels) {
  if (!Array.isArray(levels) || levels.length !== 3) return [];
  const args = [];
  ['R', 'G', 'B'].forEach((ch, i) => args.push('-channel', ch, '-evaluate', 'multiply', levels[i].toFixed(6)));
  args.push('+channel');
  return args;
}

// Цвета в четырёх точках (по умолчанию — углы с отступом в два пикселя: на самом
// краю у JPEG бывает мусор сжатия) и признак непрозрачности. В fx доступны w и h,
// поэтому дальние углы адресуются без второго вызова; points — свои координаты.
async function cornerColors(bin, input, points) {
  const spots = points || [['2', '2'], ['w-3', '2'], ['2', 'h-3'], ['w-3', 'h-3']];
  const fmt = spots.map(([x, y]) => ['r', 'g', 'b'].map(ch => `%[fx:int(255*p{${x},${y}}.${ch}+0.5)]`).join(',')).join(' ') + ' %[opaque]';
  try {
    const { stdout } = await execFileP(bin, LIMITS.concat([input + '[0]', '-format', fmt, 'info:']), { timeout: 12000 });
    const parts = String(stdout).trim().split(/\s+/);
    if (parts.length < 5) return null;
    const corners = parts.slice(0, 4).map(s => s.split(',').map(Number));
    if (corners.some(p => p.length !== 3 || p.some(v => !Number.isFinite(v)))) return null;
    // Незнакомый токен IM печатает как есть — это не «false», считаем непрозрачным.
    return { corners, opaque: !/^false$/i.test(parts[4]) };
  } catch (e) { return null; }
}

const nearPlate = (corners) => corners.every(p => p.every((v, c) => Math.abs(v - PLATE_RGB[c]) <= PLATE_NEAR));

// Углы рамки товара внутри кадра, отступив BOX_INSET внутрь. Рамка центрирована
// (-gravity center), поэтому её положение выводится из размеров кадра и рамки.
function boxCorners(full, box) {
  if (!full || !box || box.w <= 2 * BOX_INSET + 1 || box.h <= 2 * BOX_INSET + 1) return null;
  const x0 = Math.floor((full.w - box.w) / 2) + BOX_INSET, x1 = x0 + box.w - 1 - 2 * BOX_INSET;
  const y0 = Math.floor((full.h - box.h) / 2) + BOX_INSET, y1 = y0 + box.h - 1 - 2 * BOX_INSET;
  if (x0 < 0 || y0 < 0 || x1 >= full.w || y1 >= full.h) return null;
  return [[x0, y0], [x1, y0], [x0, y1], [x1, y1]].map(p => p.map(String));
}

// Множители для снимка либо null, если фон приводить не надо или нельзя.
// box — рамка товара из `contentBox()` (по ней ищется фон внутри нашего же кадра).
// Прозрачные снимки не трогаем: их поля докрасит -alpha remove, а угловой цвет
// под нулевой альфой ничего не значит.
async function backgroundLevels(bin, input, box) {
  const raw = await cornerColors(bin, input);
  if (!raw || !raw.opaque) return null;
  let corners = raw.corners;
  if (nearPlate(corners) && box) {
    // Это уже наш кадр (либо снимок на фоне, от плиты неотличимом): фон исходника
    // лежит внутри, по углам рамки товара. У товара углы скруглены, поэтому в углах
    // его рамки — фон; прямоугольный товар до угла достаёт сам, и тогда углы либо
    // разойдутся, либо окажутся тёмными — оба случая отсеет bgLevels().
    const full = await imageSize(bin, input);
    const spots = boxCorners(full, box);
    const inner = spots ? await cornerColors(bin, input, spots) : null;
    if (inner && inner.corners) corners = inner.corners;
  }
  return bgLevels(corners);
}

function squareTransformArgs(maxSize, opts) {
  opts = opts || {};
  const contentSize = Math.round(maxSize * CONTENT_RATIO);
  // Фон приводится к плите ДО обрезки: -trim меряет от углового пикселя, и после
  // приведения он равен плите — исходник и докрашенные поля режутся одним проходом.
  // Обрезаем тем же допуском, каким мерили товар, иначе размер не сойдётся.
  const args = levelsArgs(opts.levels).concat(opts.trim === false ? [] : trimArgs(opts.fuzz || TRIM_FUZZ[0]));
  // opts.fit — уже посчитанный размер товара: вписываем ровно в него (можно и увеличить).
  // Без него остаётся старое «только уменьшать».
  const resize = opts.fit ? `${opts.fit}x${opts.fit}` : `${contentSize}x${contentSize}>`;
  return args.concat([
    '-resize', resize,
    '-background', PRODUCT_BG, '-gravity', 'center',
    '-extent', `${maxSize}x${maxSize}`,
    '-alpha', 'remove', '-alpha', 'off'
  ]);
}

// Ограничители ImageMagick: на маленьком VPS большой снимок иначе съедает всю
// память и процесс уходит в своп — загрузка «висит» после 100 %.
const LIMITS = [
  '-limit', 'memory', '256MiB',
  '-limit', 'map', '512MiB',
  '-limit', 'disk', '1GiB',
  '-limit', 'area', '64MP',
  '-limit', 'thread', '1'
];
const MIN_CONTENT = 24;      // меньше — значит обрезка сработала неверно (пустой кадр)
const TRIM_MIN_GAIN = 0.94;  // если рамка почти равна кадру — обрезка ничего не нашла
const MEASURE_SIZE = 500;    // на какой ширине мерить: замер на уменьшенной копии в разы дешевле

// Размеры файла без декодирования всей картинки (identify читает заголовок).
async function imageSize(bin, input) {
  const cmd = bin === 'magick' ? 'magick' : 'identify';
  const args = (bin === 'magick' ? ['identify'] : []).concat(LIMITS, ['-format', '%wx%h', input]);
  try {
    const { stdout } = await execFileP(cmd, args, { timeout: 10000 });
    const m = String(stdout).trim().match(/^(\d+)x(\d+)/);
    return m ? { w: Number(m[1]), h: Number(m[2]) } : null;
  } catch (e) { return null; }
}

async function measure(bin, input, ops) {
  try {
    // Ресурсные лимиты обязаны идти до входного файла: ImageMagick применяет
    // настройки слева направо, и поздний -limit не защищает этап декодирования.
    const { stdout } = await execFileP(bin, LIMITS.concat([input], ops || [], ['-format', '%wx%h', 'info:']), { timeout: 12000 });
    const m = String(stdout).trim().match(/^(\d+)x(\d+)/);
    return m ? { w: Number(m[1]), h: Number(m[2]) } : null;
  } catch (e) { return null; }
}

// Размер товара после обрезки и допуск, которым его удалось найти.
// Меряем на копии шириной MEASURE_SIZE и переводим долю обратно в пиксели
// оригинала: полноразмерные замеры на каждый допуск занимали десятки секунд.
// Как только допуск сработал — выходим, обычно хватает первого.
async function contentBox(bin, input) {
  const full = await imageSize(bin, input);
  if (!full || !(full.w > 0) || !(full.h > 0)) return null;
  const scale = Math.min(1, MEASURE_SIZE / Math.max(full.w, full.h));
  const sw = Math.max(1, Math.round(full.w * scale));
  const sh = Math.max(1, Math.round(full.h * scale));
  for (const fuzz of TRIM_FUZZ) {
    const box = await measure(bin, input, ['-resize', MEASURE_SIZE + 'x' + MEASURE_SIZE + '>'].concat(trimArgs(fuzz)));
    if (!box || box.w < 8 || box.h < 8) continue;
    const share = Math.max(box.w / sw, box.h / sh);
    if (share >= TRIM_MIN_GAIN) continue;                 // обрезка ничего не дала — пробуем мягче
    const w = Math.round(full.w * (box.w / sw));
    const h = Math.round(full.h * (box.h / sh));
    if (w >= MIN_CONTENT && h >= MIN_CONTENT) return { w, h, fuzz };
  }
  return null;   // фон не отделяется — оставляем прежнее поведение «только уменьшать»
}

/* Качество webp пишет cwebp, а не ImageMagick.
 *
 * У IM6 (та сборка, что стоит на сервере) `-quality` для webp не работает
 * вовсе: значения 60, 82 и 95 дают БАЙТ В БАЙТ один файл, и он совпадает с
 * `cwebp -q 75` — то есть все снимки магазина были закодированы умолчанием
 * libwebp, а объявленные здесь числа ничего не значили. Ни порядок ключей, ни
 * `-define webp:quality` этого не меняют (проверено пятью способами).
 *
 * Поэтому шаг разделён: ImageMagick делает все преобразования и кладёт
 * промежуточный PNG — он без потерь, так что второй раз картинка не мнётся, —
 * а webp из него пишет cwebp с настоящим качеством. Нет cwebp — остаётся
 * прежний однопроходный путь: хуже по качеству, но рабочий.
 */
const PHOTO_QUALITY = 88;
const THUMB_QUALITY = 80;

let cwebpBin;
async function detectCwebp() {
  if (cwebpBin !== undefined) return cwebpBin;
  cwebpBin = null;
  for (const candidate of ['cwebp', '/usr/bin/cwebp', '/usr/local/bin/cwebp', '/opt/homebrew/bin/cwebp']) {
    try { await execFileP(candidate, ['-version'], { timeout: 5000 }); cwebpBin = candidate; break; }
    catch (e) { /* нет такого — пробуем следующий */ }
  }
  return cwebpBin;
}

// Прогнать преобразования и записать webp с заданным качеством.
async function encodeWebp(bin, args, targetPath, quality) {
  const cwebp = await detectCwebp();
  if (!cwebp) {
    await execFileP(bin, args.concat(['-define', 'webp:method=4', '-quality', String(quality), targetPath]),
      { timeout: 20000 });
    return;
  }
  const tmpPng = `${targetPath}.${process.pid}.png`;
  try {
    await execFileP(bin, args.concat([tmpPng]), { timeout: 20000 });
    // method=4: method=6 выигрывает единицы процентов веса, но кодирует в разы
    // дольше — на слабом VPS это заметная часть времени загрузки фото.
    await execFileP(cwebp, ['-quiet', '-q', String(quality), '-m', '4', tmpPng, '-o', targetPath],
      { timeout: 20000 });
  } finally {
    try { fs.unlinkSync(tmpPng); } catch (e) { /* нечего убирать */ }
  }
}

async function optimizeToWebp(dir, filename, maxSize, opts) {
  maxSize = maxSize || 1600;
  opts = opts || {};
  const bin = await detectBin();
  if (!bin) return filename;
  const input = path.join(dir, filename);
  const out = filename.replace(/\.[^.]+$/, '') + '.webp';
  const outPath = path.join(dir, out);
  // Входной WebP нельзя надёжно читать и перезаписывать по одному пути. Пишем во
  // временный соседний файл и атомарно подменяем оригинал после успешной обработки.
  const samePath = out === filename;
  const targetPath = samePath
    ? path.join(dir, `.${path.basename(filename)}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.webp`)
    : outPath;
  // -auto-orient: применить поворот из EXIF ДО удаления мета; -strip: снять все метаданные (анонимность);
  // -resize WxH>: уменьшить только если больше (без апскейла); -quality: степень сжатия webp.
  // `-strip` снимает EXIF, но ImageMagick сам дописывает в файл date:create и
  // date:modify по времени файла на диске. Это тоже след, поэтому гасим их явно.
  let args = LIMITS.concat([input, '-auto-orient', '-strip',
    '+set', 'date:create', '+set', 'date:modify', '+set', 'date:timestamp']);
  if (opts.square) {
    const trim = opts.trim !== false;
    // Сначала узнаём, какого размера сам товар на снимке и каким допуском он
    // отделяется от фона, и только потом вписываем: мелкое фото на большом фоне
    // нужно увеличить, иначе оно теряется в карточке.
    const box = trim ? await contentBox(bin, input) : null;
    const fit = targetContentSize(box, maxSize);
    // Фон исходника приводится к плите и без обрезки: без него белый прямоугольник
    // снимка так и стоял бы на серых полях.
    const levels = await backgroundLevels(bin, input, box);
    args = args.concat(squareTransformArgs(maxSize, { trim, fit, fuzz: box && box.fuzz, levels }));
  } else {
    args = args.concat(['-resize', `${maxSize}x${maxSize}>`]);
  }
  try {
    await encodeWebp(bin, args, targetPath, PHOTO_QUALITY);
    if (samePath) fs.renameSync(targetPath, input);
    else { try { fs.unlinkSync(input); } catch (e) {} } // убрать оригинал
    return out;
  } catch (e) {
    if (targetPath !== input) { try { fs.unlinkSync(targetPath); } catch (unlinkError) {} }
    // Если trim не поддержан конкретным файлом, сохраняем квадрат и единый фон,
    // но повторяем без удаления полей. Затем остаётся общий безопасный fallback.
    if (opts.square && opts.trim !== false) return optimizeToWebp(dir, filename, maxSize, { square: true, trim: false });
    if (opts.square) return optimizeToWebp(dir, filename, maxSize, {});
    return filename; // при ошибке оставляем оригинал
  }
}

async function optimizeMany(dir, filenames, maxSize, opts) {
  const result = [];
  for (const f of (filenames || [])) result.push(await optimizeToWebp(dir, f, maxSize, opts));
  return result;
}

/* ---------- «Товар на снимке срезан краем кадра» ----------
 * Часть фотографий с buy-страниц Apple — не снимок товара целиком, а крупный
 * план детали: угол корпуса, блок камер, экран с интерфейсом. В галерее такой
 * кадр читается как «фото обрезано», хотя обработка ни при чём — он таким
 * пришёл. Отличить его от обычного снимка одной геометрией нельзя: Mac mini
 * сверху тоже почти квадратный и тоже заполняет кадр, но он-то целый.
 *
 * Работает признак по УГЛАМ рамки содержимого. У целого товара силуэт со
 * скруглениями, поэтому углы описывающего прямоугольника — фон. У срезанного
 * объект доходит до самого угла. Замер на боевых данных: у целых снимков все
 * четыре угла 0.85–0.97 (фон), у срезанных хотя бы один 0.41–0.56.
 */
const FILL_RATIO = 0.86;
const CORNER_DARK = 0.75;   // угол темнее — там тело товара, а не фон
const CORNER_BOX = 12;

// Рамка непустого содержимого: {w, h, x, y} в пикселях файла.
async function contentFrame(bin, input) {
  try {
    const { stdout } = await execFileP(bin, LIMITS.concat([input, '-fuzz', '6%', '-format', '%@', 'info:']), { timeout: 12000 });
    const m = String(stdout).trim().match(/^(\d+)x(\d+)\+(\d+)\+(\d+)/);
    return m ? { w: +m[1], h: +m[2], x: +m[3], y: +m[4] } : null;
  } catch (e) { return null; }
}

// Средняя яркость (0..1) квадратика в каждом из четырёх углов рамки.
async function cornerMeans(bin, input, frame) {
  const box = Math.min(CORNER_BOX, frame.w, frame.h);
  const spots = [
    [frame.x, frame.y],
    [frame.x + frame.w - box, frame.y],
    [frame.x, frame.y + frame.h - box],
    [frame.x + frame.w - box, frame.y + frame.h - box]
  ];
  const out = [];
  for (const [x, y] of spots) {
    try {
      const { stdout } = await execFileP(bin, LIMITS.concat([input,
        '-crop', `${box}x${box}+${Math.max(0, x)}+${Math.max(0, y)}`, '+repage',
        '-format', '%[fx:mean]', 'info:']), { timeout: 12000 });
      const value = Number(String(stdout).trim());
      out.push(Number.isFinite(value) ? value : 1);
    } catch (e) { out.push(1); }
  }
  return out;
}

// Срезан ли товар краем кадра. Углы меряем только у снимков, которые вообще
// заполняют кадр: у остальных вокруг товара и так есть поле.
// Уверенный случай: содержимое упирается в кадр ОБЕИМИ сторонами и занимает
// угол. Только такие кадры переставляются сами — на боевых данных из 529 фото
// их 25, и все проверены глазами.
function looksCropped(frame, corners, size) {
  if (!frame || !size) return false;
  if (frame.w / size < FILL_RATIO || frame.h / size < FILL_RATIO) return false;
  return (corners || []).some(value => value <= CORNER_DARK);
}

// Подозрение: упирается лишь длинной стороной. Так выглядит вертикальный крупный
// план задней панели — но так же выглядит и ЦЕЛЫЙ снимок тёмного прямоугольного
// товара: у MacBook на тёмных обоях экран доходит до углов рамки, хотя ноутбук
// в кадре весь. Отличить их по готовому файлу нечем — исходник с полями до
// обработки не сохраняется. Поэтому такие кадры только показываются владельцу,
// а порядок он меняет сам, если согласен.
function looksSuspect(frame, corners, size) {
  if (!frame || !size) return false;
  if (Math.max(frame.w, frame.h) / size < FILL_RATIO) return false;
  return (corners || []).some(value => value <= CORNER_DARK);
}

async function inspectCrop(bin, input, size) {
  const frame = await contentFrame(bin, input);
  if (!frame) return { frame: null, corners: [], cropped: false, suspect: false };
  const fills = Math.max(frame.w, frame.h) / size >= FILL_RATIO;
  const corners = fills ? await cornerMeans(bin, input, frame) : [];
  return {
    frame, corners,
    cropped: looksCropped(frame, corners, size),
    suspect: looksSuspect(frame, corners, size)
  };
}

function validImageOrder(current, requested) {
  if (!Array.isArray(current) || !Array.isArray(requested) || current.length !== requested.length) return false;
  const currentSet = new Set(current.map(String));
  const requestedSet = new Set(requested.map(String));
  return currentSet.size === current.length && requestedSet.size === currentSet.size &&
    requested.every(src => currentSet.has(String(src)));
}

// Миниатюра для ленты вложений. Показывать снимок 900×1200 весом 260 КБ в
// квадратике 92×92 — это мегабайты на страницу отзывов на ровном месте;
// полноразмерный нужен только в просмотрщике.
const THUMB_SUFFIX = '-t';
const THUMB_SIZE = 320;

function thumbName(file) {
  const name = String(file || '');
  const dot = name.lastIndexOf('.');
  if (dot <= 0) return '';
  return name.slice(0, dot) + THUMB_SUFFIX + '.webp';
}

// Уже миниатюра? Иначе повторный прогон делал бы миниатюру миниатюры.
function isThumb(file) {
  return new RegExp(THUMB_SUFFIX + '\\.webp$').test(String(file || ''));
}

/* Снимок для карточки каталога.
 *
 * В хранилище лежит квадрат 1200×1200 (см. «Фото товара вписывается в кадр»), а
 * карточка показывает его в 169–276 CSS-пикселей: на телефоне сетка в две
 * колонки, на широком экране — в четыре. Замер PageSpeed на боевой витрине:
 * лишних 735 КиБ на мобильной главной и 1126 КиБ на десктопной — полтора
 * мегабайта, которые покупатель качает, чтобы увидеть их же уменьшенными вчетверо.
 *
 * Поэтому рядом с исходником лежат три уменьшённые копии, а <img> выбирает из
 * них через srcset: 320 — экранам без удвоения, 640 — десктопной карточке при
 * DPR 2 (276 CSS-пикселей это 552 точки) и телефону при DPR 3.
 *
 * Средняя ступень появилась по замеру: у типичного телефона DPR 1.75, карточка
 * в 189 CSS-пикселей просит 331 точку — и в лестнице 320/640 браузер брал 640,
 * вдвое больше нужного. 480 закрывает и этот случай, и DPR 2 (358 точек).
 *
 * Полноразмерный снимок остаётся на странице товара, где кадр и правда крупный.
 *
 * Копии не обязательны: нет ImageMagick или их ещё не сделали — карточка
 * показывает исходник ровно как раньше. Поэтому и разметку собирает
 * `cardSources()`, а не вера в то, что файл на месте.
 */
const CARD_SUFFIX = '-c';
const CARD_SIZES = [320, 480, 640];

function cardName(file, size) {
  const name = String(file || '');
  const dot = name.lastIndexOf('.');
  if (dot <= 0) return '';
  return name.slice(0, dot) + CARD_SUFFIX + size + '.webp';
}

// Уже производная? Иначе повторный прогон делал бы копию копии.
function isDerived(file) {
  return isThumb(file) || new RegExp(CARD_SUFFIX + '\\d+\\.webp$').test(String(file || ''));
}

// Список файлов хранилища, перечитываемый только когда каталог менялся: имя
// файла проверяется на каждую карточку, а их на главной полсотни. Ключ
// свежести — mtime самого каталога, тот же приём, что у кэша `readJson`.
const _dirCache = { dir: '', mtime: -1, files: null };
function uploadFiles(dir) {
  let st = null;
  try { st = fs.statSync(dir); } catch (e) { return null; }
  if (_dirCache.dir === dir && _dirCache.mtime === st.mtimeMs) return _dirCache.files;
  let files = null;
  try { files = new Set(fs.readdirSync(dir)); } catch (e) { return null; }
  _dirCache.dir = dir; _dirCache.mtime = st.mtimeMs; _dirCache.files = files;
  return files;
}

// Что подставить в src/srcset карточки. Пусто — копий нет, показываем исходник.
function cardSources(dir, file) {
  if (!file || isDerived(file)) return null;
  const have = uploadFiles(dir);
  if (!have) return null;
  const found = [];
  for (const size of CARD_SIZES) {
    const name = cardName(file, size);
    if (name && have.has(name)) found.push({ name, size });
  }
  if (!found.length) return null;
  return { src: found[found.length - 1].name, sizes: found };
}

// Сделать недостающие копии. Возвращает имена всех, что теперь есть на диске.
async function makeCards(dir, file) {
  const bin = await detectBin();
  if (!bin || !file || isDerived(file)) return [];
  const input = path.join(dir, file);
  if (!fs.existsSync(input)) return [];
  const made = [];
  for (const size of CARD_SIZES) {
    const out = cardName(file, size);
    if (!out) continue;
    const outPath = path.join(dir, out);
    if (fs.existsSync(outPath)) { made.push(out); continue; }
    try {
      await encodeWebp(bin, LIMITS.concat([
        input + '[0]', '-auto-orient', '-strip',
        '+set', 'date:create', '+set', 'date:modify', '+set', 'date:timestamp',
        '-resize', `${size}x${size}>`
      ]), outPath, THUMB_QUALITY);
      made.push(out);
    } catch (e) {
      try { fs.unlinkSync(outPath); } catch (unlinkError) {}
    }
  }
  if (made.length) _dirCache.mtime = -1;   // каталог пополнился — перечитать список
  return made;
}

// Имена всех производных снимка: их удаляют вместе с ним, ссылок на них нигде нет.
function derivedNames(file) {
  if (!file || isDerived(file)) return [];
  return CARD_SIZES.map(size => cardName(file, size)).filter(Boolean);
}

async function makeThumb(dir, file, size) {
  const bin = await detectBin();
  if (!bin) return '';
  const out = thumbName(file);
  if (!out || isThumb(file)) return '';
  const input = path.join(dir, file);
  const outPath = path.join(dir, out);
  if (!fs.existsSync(input)) return '';
  if (fs.existsSync(outPath)) return out;
  try {
    await encodeWebp(bin, LIMITS.concat([
      input + '[0]', '-auto-orient', '-strip',
      '+set', 'date:create', '+set', 'date:modify', '+set', 'date:timestamp',
      '-resize', `${size || THUMB_SIZE}x${size || THUMB_SIZE}>`
    ]), outPath, THUMB_QUALITY);
    return out;
  } catch (e) {
    try { fs.unlinkSync(outPath); } catch (unlinkError) {}
    return '';
  }
}

/* Склеить тайлы карты в одну картинку.
 *
 * Живёт здесь, а не в `lib/map-tiles.js`, по тому же правилу, по которому тут
 * лежит вся остальная работа с ImageMagick: одно место знает, как его звать,
 * какие лимиты ставить и чем он у нас называется (IM6 — `convert`, IM7 —
 * `magick`). Карта об этом знать не обязана, она знает про тайлы.
 *
 * `-montage` не используем намеренно: он рисует рамки и подписи, которые потом
 * пришлось бы гасить флагами. `+append` / `-append` просто сшивают ряды встык —
 * ровно то, что нужно из тайлов, которые и так стыкуются пиксель в пиксель.
 */
async function montage(bin, files, opts) {
  opts = opts || {};
  const cols = Math.max(1, Number(opts.cols) || 1);
  const rows = [];
  for (let i = 0; i < files.length; i += cols) rows.push(files.slice(i, i + cols));
  if (!rows.length) throw new Error('нечего склеивать');
  const args = LIMITS.slice();
  // Каждый ряд собирается в скобках горизонтально, ряды — вертикально.
  for (const row of rows) args.push('(', ...row, '+append', ')');
  args.push('-append');
  // Насыщенность стандартного стиля OSM для витрины великовата: жёлтые дороги и
  // розовые дома спорят с товаром. Приглушаем — как приглушают карту у себя все,
  // кто ставит её фоном под карточку.
  if (opts.saturation) args.push('-modulate', '100,' + opts.saturation + ',100');
  /* Формат задаём ЯВНО префиксом, а не расширением файла: пишем во временный
   * `…tmp`, и по нему ImageMagick выбрал бы PNG — карта весила бы втрое больше,
   * а отдавали бы мы её как webp. На этом уже наступили. */
  args.push('-strip', '-quality', String(opts.quality || 82), 'webp:' + opts.out);
  await execFileP(bin === 'magick' ? 'magick' : 'convert', args, { timeout: 60000 });
  return opts.out;
}

module.exports = { montage, optimizeToWebp, optimizeMany, detectBin, squareTransformArgs, targetContentSize, contentBox, imageSize, validImageOrder,
  bgLevels, levelsArgs, backgroundLevels, cornerColors, boxCorners, PLATE_RGB,
  makeThumb, thumbName, isThumb, THUMB_SIZE, THUMB_SUFFIX,
  makeCards, cardName, cardSources, derivedNames, isDerived, uploadFiles, CARD_SIZES, CARD_SUFFIX,
  contentFrame, cornerMeans, looksCropped, looksSuspect, inspectCrop,
  PRODUCT_BG, MAX_UPSCALE, CONTENT_RATIO, FILL_RATIO, CORNER_DARK };
