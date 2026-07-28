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
// разрешает только уменьшение. Больше 2.5× не растягиваем — пойдёт мыло.
const MAX_UPSCALE = 3.5;
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

// Размер товара после обеих обрезок. Файл не меняется: результат уходит в info:,
// поэтому одна команда даёт ровно тот размер, который получится при конвертации.
const MIN_CONTENT = 24;      // меньше — значит обрезка сработала неверно (пустой кадр)
const TRIM_MIN_GAIN = 0.94;  // если рамка почти равна кадру — обрезка ничего не нашла

async function measure(bin, input, ops) {
  try {
    const { stdout } = await execFileP(bin, [input].concat(ops || [], ['-format', '%wx%h', 'info:']), { timeout: 15000 });
    const m = String(stdout).trim().match(/^(\d+)x(\d+)/);
    return m ? { w: Number(m[1]), h: Number(m[2]) } : null;
  } catch (e) { return null; }
}

// Размер товара после обрезки и допуск, которым его удалось найти.
// Файл не меняется: результат уходит в info:, поэтому замер совпадает с тем,
// что получится при конвертации тем же допуском.
async function contentBox(bin, input) {
  const full = await measure(bin, input, []);
  for (const fuzz of TRIM_FUZZ) {
    const box = await measure(bin, input, trimArgs(fuzz));
    if (!box || box.w < MIN_CONTENT || box.h < MIN_CONTENT) continue;
    if (!full) return Object.assign(box, { fuzz });
    // обрезка признаётся удачной, если рамка заметно меньше исходного кадра
    const shrank = Math.max(box.w / full.w, box.h / full.h) < TRIM_MIN_GAIN;
    if (shrank) return Object.assign(box, { fuzz });
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
  // -auto-orient: применить поворот из EXIF ДО удаления мета; -strip: снять все метаданные (анонимность);
  // -resize WxH>: уменьшить только если больше (без апскейла); -quality: степень сжатия webp.
  let args = [input, '-auto-orient', '-strip'];
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
  args = args.concat(['-define', 'webp:method=6', '-quality', '82', outPath]);
  try {
    await execFileP(bin, args, { timeout: 20000 });
    if (out !== filename) { try { fs.unlinkSync(input); } catch (e) {} } // убрать оригинал
    return out;
  } catch (e) {
    if (out !== filename) { try { fs.unlinkSync(outPath); } catch (unlinkError) {} }
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

function validImageOrder(current, requested) {
  if (!Array.isArray(current) || !Array.isArray(requested) || current.length !== requested.length) return false;
  const currentSet = new Set(current.map(String));
  const requestedSet = new Set(requested.map(String));
  return currentSet.size === current.length && requestedSet.size === currentSet.size &&
    requested.every(src => currentSet.has(String(src)));
}

module.exports = { optimizeToWebp, optimizeMany, detectBin, squareTransformArgs, targetContentSize, contentBox, validImageOrder, PRODUCT_BG, MAX_UPSCALE, CONTENT_RATIO };
