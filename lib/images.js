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

function squareTransformArgs(maxSize, opts) {
  opts = opts || {};
  const contentSize = Math.round(maxSize * CONTENT_RATIO);
  // Обрезаем тем же допуском, каким мерили товар, иначе размер не сойдётся.
  const args = opts.trim === false ? [] : trimArgs(opts.fuzz || TRIM_FUZZ[0]);
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
  let args = LIMITS.concat([input, '-auto-orient', '-strip']);
  if (opts.square) {
    const trim = opts.trim !== false;
    // Сначала узнаём, какого размера сам товар на снимке и каким допуском он
    // отделяется от фона, и только потом вписываем: мелкое фото на большом фоне
    // нужно увеличить, иначе оно теряется в карточке.
    const box = trim ? await contentBox(bin, input) : null;
    const fit = targetContentSize(box, maxSize);
    args = args.concat(squareTransformArgs(maxSize, { trim, fit, fuzz: box && box.fuzz }));
  } else {
    args = args.concat(['-resize', `${maxSize}x${maxSize}>`]);
  }
  // method=6 даёт выигрыш в весе на единицы процентов, но кодирует в разы дольше —
  // на слабом VPS это заметная часть времени загрузки фото.
  args = args.concat(['-define', 'webp:method=4', '-quality', '82', targetPath]);
  try {
    await execFileP(bin, args, { timeout: 20000 });
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

module.exports = { optimizeToWebp, optimizeMany, detectBin, squareTransformArgs, targetContentSize, contentBox, imageSize, validImageOrder,
  contentFrame, cornerMeans, looksCropped, looksSuspect, inspectCrop,
  PRODUCT_BG, MAX_UPSCALE, CONTENT_RATIO, FILL_RATIO, CORNER_DARK };
