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

async function detectBin() {
  if (BIN !== undefined) return BIN;
  for (const cand of ['convert', 'magick']) {
    try { await execFileP(cand, ['-version']); BIN = cand; return BIN; }
    catch (e) { /* пробуем следующий */ }
  }
  BIN = null;
  return BIN;
}

// Цвет фона снимка — берём угловой пиксель. Им заполняются поля при выравнивании
// до квадрата, чтобы подложка не отличалась от фона фото (белый товарный фон -> белые поля).
async function cornerColor(bin, input) {
  try {
    const { stdout } = await execFileP(bin, [input, '-format', '%[pixel:p{3,3}]', 'info:'], { timeout: 10000 });
    const c = stdout.trim();
    return /^(#|rgb|srgb|gray|white|black)/i.test(c) ? c : 'white';
  } catch (e) { return 'white'; }
}

// Конвертировать один файл в оптимизированный WebP без метаданных.
// opts.square: безопасная нормализация под каталог — целиком вписать снимок в квадрат,
// отцентрировать и добавить воздух по краям. Содержимое не обрезается: это особенно важно
// для белых товаров на белом фоне, которые ImageMagick ошибочно принимал за фон при -trim.
// Возвращает новое имя файла (.webp) либо исходное, если конвертация недоступна/не удалась.
function squareTransformArgs(maxSize, bg) {
  const contentSize = Math.round(maxSize * 0.9);
  return [
    '-resize', `${contentSize}x${contentSize}>`,
    '-background', bg, '-gravity', 'center',
    '-extent', `${maxSize}x${maxSize}`
  ];
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
    const bg = await cornerColor(bin, input);
    args = args.concat(squareTransformArgs(maxSize, bg));
  } else {
    args = args.concat(['-resize', `${maxSize}x${maxSize}>`]);
  }
  args = args.concat(['-quality', '82', outPath]);
  try {
    await execFileP(bin, args, { timeout: 20000 });
    if (out !== filename) { try { fs.unlinkSync(input); } catch (e) {} } // убрать оригинал
    return out;
  } catch (e) {
    if (out !== filename) { try { fs.unlinkSync(outPath); } catch (unlinkError) {} }
    // «умный» вариант не сработал (например, слишком пёстрый фон) — пробуем обычный
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

module.exports = { optimizeToWebp, optimizeMany, detectBin, squareTransformArgs, validImageOrder };
