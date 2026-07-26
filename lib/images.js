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
function squareTransformArgs(maxSize, opts) {
  opts = opts || {};
  const contentSize = Math.round(maxSize * 0.88);
  const args = opts.trim === false ? [] : ['-fuzz', '2%', '-trim', '+repage'];
  return args.concat([
    '-resize', `${contentSize}x${contentSize}>`,
    '-background', PRODUCT_BG, '-gravity', 'center',
    '-extent', `${maxSize}x${maxSize}`,
    '-alpha', 'remove', '-alpha', 'off'
  ]);
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
    args = args.concat(squareTransformArgs(maxSize, { trim: opts.trim !== false }));
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

module.exports = { optimizeToWebp, optimizeMany, detectBin, squareTransformArgs, validImageOrder, PRODUCT_BG };
