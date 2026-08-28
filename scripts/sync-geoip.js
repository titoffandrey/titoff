#!/usr/bin/env node
'use strict';
/* ============ Сборка локальной базы «IP → город» из DB-IP City Lite ============
 *
 * Зачем она вообще: город посетителя определялся внешним сервисом на каждый
 * новый адрес, у бесплатного тарифа тысяча запросов в сутки, а посетителей
 * стало больше — и с середины дня все новые визиты получали «Город не
 * определён», молча, без единой ошибки в логах. Плюс каждый адрес посетителя
 * уходил третьей стороне (см. шапку `lib/geoip.js`).
 *
 * Источник — DB-IP City Lite: свободная лицензия CC BY 4.0 (коммерческое
 * использование разрешено при указании авторства), обновляется раз в месяц,
 * скачивается без ключей и регистрации. MaxMind GeoLite2 точнее, но требует
 * аккаунта и лицензионного ключа — ради поля «город» в панели это лишнее.
 *
 * Что делает скрипт: качает CSV.GZ за текущий месяц (не вышел — за прошлый),
 * разбирает его потоком и пишет компактный двоичный файл рядом с данными.
 * Разбор потоковый не ради красоты: в архиве почти восемь миллионов строк, и
 * держать их в памяти целиком значило бы упереться в память на сервере с 4 ГБ.
 *
 *   node scripts/sync-geoip.js            # предпросмотр: что скачается и сколько выйдет
 *   node scripts/sync-geoip.js --apply    # скачать и записать geoip.bin
 *   node scripts/sync-geoip.js --apply --month 2026-07
 *
 * Идемпотентен: пишет во временный файл и переименовывает его на место готового
 * (тот же приём, что у `writeJson` в хранилище) — прерванная закачка не оставит
 * половину базы, по которой панель показывала бы случайные города.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const zlib = require('zlib');
const readline = require('readline');
const GEO = require('../lib/geoip');

const DATA_DIR = process.env.STORE_DATA_DIR
  ? path.resolve(process.env.STORE_DATA_DIR)
  : path.join(__dirname, '..', 'data');

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const monthArg = (() => {
  const i = args.indexOf('--month');
  return i >= 0 ? String(args[i + 1] || '') : '';
})();

// IPv6 из базы выбрасываем: у наших посетителей его нет ни одного (проверено на
// боевых данных), а второй индекс удвоил бы и файл, и код поиска.
const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;
// Меньше этого числа диапазонов — значит скачалось что-то не то (обрезанный
// ответ, страница ошибки). Готовую базу таким не заменяем: лучше старая, чем
// половина новой. То же правило, что у базы пунктов выдачи.
const MIN_RANGES = 1000000;

function monthKey(shift) {
  const d = new Date();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() - (shift || 0));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}
function urlFor(month) { return `https://download.db-ip.com/free/dbip-city-lite-${month}.csv.gz`; }

function ipToInt(value) {
  const parts = value.split('.');
  if (parts.length !== 4) return -1;
  let out = 0;
  for (const part of parts) {
    const n = Number(part);
    if (!Number.isInteger(n) || n < 0 || n > 255) return -1;
    out = out * 256 + n;
  }
  return out;
}

/* Разбор строки CSV. Свой, а не библиотека: полей восемь, кавычки простые, и
 * тащить зависимость в проект без единой зависимости ради этого нельзя.
 */
function splitCsv(line) {
  const out = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; } else quoted = false;
      } else cur += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { out.push(cur); cur = ''; }
    else cur += ch;
  }
  out.push(cur);
  return out;
}

async function download(url, dest) {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res || !res.ok) throw new Error(`не скачалось: HTTP ${res ? res.status : '—'} ${url}`);
  await new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    const stream = require('stream');
    stream.pipeline(res.body, file, err => err ? reject(err) : resolve());
  });
  return fs.statSync(dest).size;
}

async function build(csvGz, outFile, month) {
  const tmpRanges = outFile + '.ranges';
  const ranges = fs.createWriteStream(tmpRanges);
  const places = new Map();          // «CC\tрегион\tгород» → номер
  const placeList = [];
  let count = 0, skipped = 0;
  let chunk = Buffer.alloc(GEO.REC * 4096);
  let at = 0;

  const flush = () => new Promise((resolve, reject) => {
    if (!at) return resolve();
    const piece = Buffer.from(chunk.subarray(0, at));
    at = 0;
    ranges.write(piece, err => err ? reject(err) : resolve());
  });

  const rl = readline.createInterface({
    input: fs.createReadStream(csvGz).pipe(zlib.createGunzip()),
    crlfDelay: Infinity
  });
  for await (const line of rl) {
    if (!line) continue;
    const cols = splitCsv(line);
    if (cols.length < 6) { skipped++; continue; }
    const [start, end, , code, region, city] = cols;
    if (!IPV4.test(start) || !IPV4.test(end)) continue;           // IPv6 и мусор
    if (!/^[A-Za-z]{2}$/.test(code) || code === 'ZZ') { skipped++; continue; }
    const from = ipToInt(start), to = ipToInt(end);
    if (from < 0 || to < from) { skipped++; continue; }
    const key = code.toUpperCase() + '\t' + (region || '') + '\t' + (city || '');
    let idx = places.get(key);
    if (idx === undefined) { idx = placeList.length; places.set(key, idx); placeList.push(key); }
    chunk.writeUInt32BE(from, at);
    chunk.writeUInt32BE(to, at + 4);
    chunk.writeUInt32BE(idx, at + 8);
    at += GEO.REC;
    count++;
    if (at === chunk.length) await flush();
  }
  await flush();
  await new Promise((resolve, reject) => ranges.end(err => err ? reject(err) : resolve()));

  if (count < MIN_RANGES) {
    fs.unlinkSync(tmpRanges);
    throw new Error(`в базе всего ${count} диапазонов — это не похоже на полный файл, готовую не трогаем`);
  }

  // Таблица мест: у каждого длина и строка. Читается в память целиком при
  // загрузке базы, поэтому держим её компактной — повторов тут нет по построению.
  const chunks = [];
  for (const key of placeList) {
    const body = Buffer.from(key, 'utf8');
    const head = Buffer.alloc(2);
    head.writeUInt16BE(body.length);
    chunks.push(head, body);
  }
  const placesBuf = Buffer.concat(chunks);

  const header = Buffer.alloc(GEO.HEADER);
  header.write(GEO.MAGIC, 0, 'latin1');
  header.writeUInt32BE(count, 8);
  header.writeUInt32BE(placeList.length, 12);
  header.writeUInt32BE(GEO.HEADER + count * GEO.REC, 16);
  header.writeUInt32BE(Number(month.replace('-', '')) || 0, 20);

  const tmpOut = outFile + '.tmp';
  const out = fs.createWriteStream(tmpOut);
  await new Promise((resolve, reject) => {
    out.write(header);
    const src = fs.createReadStream(tmpRanges);
    src.pipe(out, { end: false });
    src.on('error', reject);
    src.on('end', () => { out.end(placesBuf, err => err ? reject(err) : resolve()); });
  });
  fs.unlinkSync(tmpRanges);
  return { tmpOut, count, places: placeList.length, size: fs.statSync(tmpOut).size };
}

(async () => {
  const month = /^\d{4}-\d{2}$/.test(monthArg) ? monthArg : monthKey(0);
  const outFile = path.join(DATA_DIR, GEO.FILE);
  const current = GEO.info(DATA_DIR);
  console.log('Каталог данных:', DATA_DIR);
  console.log('Сейчас:', current ? `${current.ranges.toLocaleString('ru-RU')} диапазонов, база за ${current.stamp}` : 'базы нет');

  let url = urlFor(month);
  let head = await fetch(url, { method: 'HEAD' }).catch(() => null);
  let picked = month;
  // Файл за текущий месяц выкладывают первого числа; пока его нет — берём прошлый.
  if (!head || !head.ok) {
    picked = monthKey(1);
    url = urlFor(picked);
    head = await fetch(url, { method: 'HEAD' }).catch(() => null);
    if (!head || !head.ok) throw new Error('база DB-IP недоступна ни за этот месяц, ни за прошлый');
  }
  console.log('Источник:', url, '(', Math.round(Number(head.headers.get('content-length') || 0) / 1048576), 'МБ )');
  if (!APPLY) {
    console.log('\nПредпросмотр. Чтобы скачать и собрать базу: node scripts/sync-geoip.js --apply');
    return;
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'geoip-'));
  const csvGz = path.join(tmpDir, 'dbip.csv.gz');
  try {
    const bytes = await download(url, csvGz);
    console.log('Скачано:', Math.round(bytes / 1048576), 'МБ. Собираю…');
    const built = await build(csvGz, outFile, picked);
    // Готовую базу подменяем одним переименованием: прерванная сборка не должна
    // оставить половину файла, по которой панель показывала бы случайные города.
    fs.renameSync(built.tmpOut, outFile);
    try { fs.chmodSync(outFile, 0o600); } catch (e) {}
    GEO.close();
    console.log(`Готово: ${built.count.toLocaleString('ru-RU')} диапазонов, ${built.places.toLocaleString('ru-RU')} мест, `
      + `${Math.round(built.size / 1048576)} МБ → ${outFile}`);
    const check = GEO.lookup(DATA_DIR, '77.88.55.88');
    console.log('Проверка 77.88.55.88 →', check ? `${check.city || '—'}, ${check.country}` : 'не найден');
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) {}
  }
})().catch(err => { console.error('Ошибка:', err && err.message ? err.message : err); process.exit(1); });
