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
const MAX_UPSCALE = 2.5;

// Во сколько пикселей вписывать товар после обрезки полей.
// box — размеры найденного товара (из -trim), null — если определить не удалось.
function targetContentSize(box, maxSize) {
  const contentSize = Math.round(maxSize * 0.88);
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
const TRIM_ARGS = ['-fuzz', '2%', '-trim', '+repage', '-fuzz', '2%', '-trim', '+repage'];

function squareTransformArgs(maxSize, opts) {
  opts = opts || {};
  const contentSize = Math.round(maxSize * 0.88);
  const args = opts.trim === false ? [] : TRIM_ARGS.slice();
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
const MIN_CONTENT = 24;   // меньше — значит обрезка сработала неверно (пустой кадр)
async function contentBox(bin, input) {
  const args = [input].concat(TRIM_ARGS, ['-format', '%wx%h', 'info:']);
  try {
    const { stdout } = await execFileP(bin, args, { timeout: 15000 });
    const m = String(stdout).trim().match(/^(\d+)x(\d+)/);
    if (!m) return null;
    const box = { w: Number(m[1]), h: Number(m[2]) };
    return (box.w >= MIN_CONTENT && box.h >= MIN_CONTENT) ? box : null;
  } catch (e) { return null; }
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
    // Сначала узнаём, какого размера сам товар на снимке, и только потом вписываем:
    // мелкое фото на большом фоне нужно увеличить, иначе оно теряется в карточке.
    const fit = trim ? targetContentSize(await contentBox(bin, input), maxSize) : null;
    args = args.concat(squareTransformArgs(maxSize, { trim, fit }));
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

module.exports = { optimizeToWebp, optimizeMany, detectBin, squareTransformArgs, targetContentSize, contentBox, validImageOrder, PRODUCT_BG, MAX_UPSCALE };
