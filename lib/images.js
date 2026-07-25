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
// opts.square: «умная» нормализация под каталог — срезать однотонные поля вокруг товара
// (-fuzz -trim), отцентрировать и привести к одинаковому квадрату (gravity center + extent),
// подложка в цвет фона снимка. Все фото товара получаются одного формата.
// Возвращает новое имя файла (.webp) либо исходное, если конвертация недоступна/не удалась.
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
    args = args.concat([
      '-fuzz', '9%', '-trim', '+repage',                    // срезать однотонный фон вокруг товара
      '-resize', `${Math.round(maxSize * 0.92)}x${Math.round(maxSize * 0.92)}>`, // товар с небольшим воздухом
      '-background', bg, '-gravity', 'center',
      '-extent', `${maxSize}x${maxSize}`                    // одинаковый квадрат, товар по центру
    ]);
  } else {
    args = args.concat(['-resize', `${maxSize}x${maxSize}>`]);
  }
  args = args.concat(['-quality', '82', outPath]);
  try {
    await execFileP(bin, args, { timeout: 20000 });
    if (out !== filename) { try { fs.unlinkSync(input); } catch (e) {} } // убрать оригинал
    return out;
  } catch (e) {
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

module.exports = { optimizeToWebp, optimizeMany, detectBin };
