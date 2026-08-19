'use strict';
// Лёгкие превью вложений отзыва и чистка видео.
//
// Зачем превью: в ленте вложения показываются квадратиками ~92 px, а лежат
// снимки 900×1200 весом под 260 КБ. На странице их до шестнадцати — это
// мегабайты трафика на ровном месте. Полноразмерный файл нужен только в
// просмотрщике, куда он и грузится по клику.
//
// Зачем кадр у видео: без него в ленте пришлось бы ставить сам <video>, а
// ролик весит мегабайты — браузер лез бы за метаданными каждого. Кадр весит
// килобайты, и до открытия просмотрщика видео вообще не загружается.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const IMG = require('./images');

function execFileP(bin, args, opts) {
  return new Promise((resolve, reject) => {
    execFile(bin, args, opts || {}, (error, stdout, stderr) => {
      if (error) reject(error); else resolve({ stdout, stderr });
    });
  });
}

let FFMPEG;
async function ffmpeg() {
  if (FFMPEG !== undefined) return FFMPEG;
  for (const cand of ['ffmpeg', '/usr/bin/ffmpeg', '/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg']) {
    try { await execFileP(cand, ['-version'], { timeout: 8000 }); FFMPEG = cand; return FFMPEG; }
    catch (e) { /* пробуем следующий */ }
  }
  FFMPEG = null;
  return FFMPEG;
}

const VIDEO_RE = /\.(mp4|m4v|mov|webm)$/i;
function isVideo(file) { return VIDEO_RE.test(String(file || '')); }

/* Предел длины ролика в отзыве.
 *
 * Смысл отзыва — в первых секундах, а с площадки приезжают и восьмиминутные
 * распаковки: один такой файл весил 48,8 МБ — как все 1181 фотография товара
 * вместе. Дело именно в длине, а не в качестве: 540×960 при 0,9 Мбит/с — это
 * нормальный битрейт, и перекодирование дало бы всего вдвое, потратив пять
 * минут на ролик (замер на сервере, одно ядро).
 *
 * Обрезка идёт БЕЗ перекодирования (`-t` при `-c copy`), поэтому она мгновенна
 * и ничего не теряет в качестве. Резать `-c copy` умеет только по ключевому
 * кадру, так что итог бывает на пару секунд короче предела — это нормально.
 */
const MAX_VIDEO_SECONDS = 60;

function posterName(file) {
  const name = String(file || '');
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(0, dot) + '-p.webp' : '';
}

/**
 * Кадр-заставка для ролика. Берём секунду от начала: на нулевом кадре у многих
 * роликов ещё чёрный экран.
 */
async function makePoster(dir, file) {
  const bin = await ffmpeg();
  if (!bin) return '';
  const out = posterName(file);
  if (!out) return '';
  const input = path.join(dir, file);
  const outPath = path.join(dir, out);
  if (!fs.existsSync(input)) return '';
  if (fs.existsSync(outPath)) return out;
  const args = [
    '-v', 'error', '-y',
    '-ss', '1', '-i', input, '-frames:v', '1',
    '-vf', `scale='min(${IMG.THUMB_SIZE},iw)':-2`,
    // Метаданные в кадр не переносим — он ими и не нужен.
    '-map_metadata', '-1', '-fflags', '+bitexact',
    outPath
  ];
  try {
    await execFileP(bin, args, { timeout: 60000 });
    if (fs.existsSync(outPath) && fs.statSync(outPath).size > 200) return out;
  } catch (e) { /* ниже вторая попытка с нулевой секунды */ }
  try {
    await execFileP(bin, ['-v', 'error', '-y', '-i', input, '-frames:v', '1',
      '-vf', `scale='min(${IMG.THUMB_SIZE},iw)':-2`, '-map_metadata', '-1', outPath],
      { timeout: 60000 });
    if (fs.existsSync(outPath) && fs.statSync(outPath).size > 200) return out;
  } catch (e) { /* кадр не сделался — не беда, лента переживёт */ }
  try { fs.unlinkSync(outPath); } catch (e) {}
  return '';
}

/**
 * Снять с ролика все метаданные и перенести индекс в начало файла.
 *
 * Теги площадки («Lavc61.3.100 h264_nvenc») — это след источника, и в наших
 * файлах ему делать нечего. `+faststart` кладёт moov-атом в начало: без него
 * браузер не может начать проигрывание, пока не докачает файл почти целиком.
 * Поток не перекодируется (`-c copy`), поэтому качество не страдает.
 */
async function cleanVideo(dir, file, opts) {
  const bin = await ffmpeg();
  if (!bin) return false;
  const input = path.join(dir, file);
  if (!fs.existsSync(input)) return false;
  const limit = Number((opts && opts.maxSeconds) != null ? opts.maxSeconds : MAX_VIDEO_SECONDS);
  const tmp = path.join(dir, `.${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.mp4`);
  try {
    // -map_metadata -1 снимает теги контейнера (у роликов площадки там лежал
    // её кодировщик — «Lavc61.3.100 h264_nvenc»). Имена дорожек живут отдельно,
    // и очистить их до конца нельзя: mp4-муксер ffmpeg всё равно пишет свои
    // «VideoHandler»/«SoundHandler» (опции empty_hdlr_name в этой сборке нет).
    // Это подпись формата, а не источника, и об исходном файле не говорит ничего.
    await execFileP(bin, ['-v', 'error', '-y', '-i', input, '-map_metadata', '-1',
      '-map_chapters', '-1', '-c', 'copy', '-movflags', '+faststart',
      // Обрезка тем же проходом, которым и так снимаются метаданные: лишнего
      // запуска ffmpeg не появляется, а короткий ролик от `-t` не страдает.
      ...(limit > 0 ? ['-t', String(limit)] : []),
      '-metadata:s:v', 'handler_name=', '-metadata:s:a', 'handler_name=',
      '-metadata:s:v', 'vendor_id=', '-metadata:s:a', 'vendor_id=',
      '-fflags', '+bitexact', '-flags:v', '+bitexact', '-flags:a', '+bitexact', tmp],
      { timeout: 180000 });
    if (!fs.existsSync(tmp) || fs.statSync(tmp).size < 1024) throw new Error('пустой файл');
    fs.renameSync(tmp, input);
    return true;
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch (unlinkError) {}
    return false;
  }
}

/**
 * Превью для всех вложений отзыва: карта «файл → его лёгкая картинка».
 * Возвращает { previews, madeThumbs, madePosters }.
 */
async function buildPreviews(dir, review, opts) {
  opts = opts || {};
  const previews = Object.assign({}, review.previews || {});
  let madeThumbs = 0, madePosters = 0, cleaned = 0;

  for (const file of (review.photos || [])) {
    if (previews[file] && fs.existsSync(path.join(dir, previews[file]))) continue;
    const thumb = await IMG.makeThumb(dir, file);
    if (thumb) { previews[file] = thumb; madeThumbs++; }
  }
  for (const file of (review.videos || [])) {
    if (opts.clean && await cleanVideo(dir, file)) cleaned++;
    if (previews[file] && fs.existsSync(path.join(dir, previews[file]))) continue;
    const poster = await makePoster(dir, file);
    if (poster) { previews[file] = poster; madePosters++; }
  }
  return { previews, madeThumbs, madePosters, cleaned };
}

module.exports = { buildPreviews, makePoster, cleanVideo, posterName, isVideo, ffmpeg, MAX_VIDEO_SECONDS };
