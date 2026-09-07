#!/usr/bin/env node
'use strict';
/* ============ Словарь русских названий городов из GeoNames ============
 *
 * Зачем. Города посетителей приходят из DB-IP по-английски, а панель русская.
 * Переводила их таблица руками в `lib/geoip.js` — три сотни крупных городов, и
 * этого хватало ровно до первого посёлка: на боевых данных латиницей оставалась
 * КАЖДАЯ ПЯТАЯ карточка (1632 из 7316) — «Sysert'», «Druzhba», «Kuznechikha»,
 * «Vostochnoe Degunino», а вместе с ними «Stockholm», «London» и «Frankfurt am
 * Main». Дописывать это руками бессмысленно: в базе сто шестьдесят тысяч мест,
 * и каждый месяц приходят новые.
 *
 * Источник — GeoNames (свободная лицензия CC BY 4.0, без ключей и регистрации),
 * тот же по духу, что DB-IP у самой базы и OpenStreetMap у карты магазина:
 *
 *   RU.zip + alternatenames/RU.zip  — все населённые пункты России и их русские
 *                                     имена (26 МБ, покрытие 97% нашего трафика)
 *   cities1000.zip + alternateNamesV2.zip — города мира от тысячи жителей
 *                                     (194 МБ, ради Франкфурта и Стокгольма)
 *
 *   node scripts/build-city-names.js            # предпросмотр: что выйдет
 *   node scripts/build-city-names.js --apply    # собрать lib/city-names-ru.txt.gz
 *   node scripts/build-city-names.js --apply --keep   # не удалять скачанное
 *
 * ЗАПУСКАТЬ ЛУЧШЕ НА СЕРВЕРЕ: 220 МБ через Tor с ноутбука едут долго, а готовый
 * файл весит 1,2 МБ и забирается обратно одной командой. Скрипт офлайновый —
 * витрина о нём не знает вовсе, как и о генераторе карт.
 *
 * Обновлять его каждый месяц не нужно: города не переименовываются пачками.
 * Раз в год — с запасом.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const zlib = require('zlib');
const readline = require('readline');
// Ключ считает сам `lib/geoip.js`: собери мы его здесь по своим правилам —
// файл однажды перестал бы находиться при поиске, причём молча.
const GEO = require('../lib/geoip');

const BASE = 'https://download.geonames.org/export/dump/';
const OUT = GEO.NAMES_FILE;

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const KEEP = args.includes('--keep');
const CACHE = path.join(os.tmpdir(), 'geonames-cache');

// Меньше этого — значит скачалось что-то не то (обрезанный ответ, страница
// ошибки). Готовый словарь таким не заменяем: лучше старый, чем половина
// нового. То же правило, что у базы «IP → город» и у пунктов выдачи.
const MIN_ROWS = 50000;

async function get(name) {
  fs.mkdirSync(CACHE, { recursive: true });
  const dest = path.join(CACHE, name.replace(/\//g, '_'));
  if (fs.existsSync(dest) && fs.statSync(dest).size > 100000) return dest;
  const res = await fetch(BASE + name, { redirect: 'follow' });
  if (!res || !res.ok) throw new Error(`не скачалось: HTTP ${res ? res.status : '—'} ${name}`);
  await new Promise((ok, bad) => {
    require('stream').pipeline(res.body, fs.createWriteStream(dest), e => e ? bad(e) : ok());
  });
  console.log('  скачано', name, Math.round(fs.statSync(dest).size / 1048576), 'МБ');
  return dest;
}

/* Распаковка zip своими руками: единственная зависимость проекта — Node, а
 * `unzip` на сервере нет вовсе. Идём от ЦЕНТРАЛЬНОГО КАТАЛОГА в конце файла, а
 * не по локальным заголовкам: у записей GeoNames размер лежит в data descriptor
 * ПОСЛЕ данных, и по локальным заголовкам файл не пройти.
 */
function entryOf(file, want) {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const tailLen = Math.min(size, 70000);
    const tail = Buffer.alloc(tailLen);
    fs.readSync(fd, tail, 0, tailLen, size - tailLen);
    let eocd = -1;
    for (let i = tail.length - 22; i >= 0; i--) if (tail.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
    if (eocd < 0) throw new Error('не нашёлся конец zip: ' + path.basename(file));
    const total = tail.readUInt16LE(eocd + 10);
    const cd = Buffer.alloc(tail.readUInt32LE(eocd + 12));
    fs.readSync(fd, cd, 0, cd.length, tail.readUInt32LE(eocd + 16));
    let at = 0;
    for (let n = 0; n < total; n++) {
      const method = cd.readUInt16LE(at + 10);
      const nameLen = cd.readUInt16LE(at + 28);
      const name = cd.toString('utf8', at + 46, at + 46 + nameLen);
      const local = cd.readUInt32LE(at + 42);
      at += 46 + nameLen + cd.readUInt16LE(at + 30) + cd.readUInt16LE(at + 32);
      if (name !== want) continue;
      const head = Buffer.alloc(30);
      fs.readSync(fd, head, 0, 30, local);
      return { start: local + 30 + head.readUInt16LE(26) + head.readUInt16LE(28), method };
    }
    throw new Error(`в архиве нет файла ${want}`);
  } finally { fs.closeSync(fd); }
}

// Строки файла внутри zip — потоком: распакованный alternateNamesV2 весит
// больше гигабайта, и держать его в памяти на сервере с 4 ГБ нельзя.
function lines(file, want) {
  const { start, method } = entryOf(file, want);
  const raw = fs.createReadStream(file, { start });
  const input = method === 0 ? raw : raw.pipe(zlib.createInflateRaw());
  return readline.createInterface({ input, crlfDelay: Infinity });
}

/* Латинское ли это написание. Русские имена берём только из строк с языком
 * «ru», а ключами делаем латиницу — кириллический ключ искать нечем: DB-IP
 * присылает латиницу всегда.
 */
function latin(value) { return /^[\x20-\x7EÀ-ɏ]+$/.test(value); }

// Русское имя лучше прежнего? Предпочтительное (isPreferred) важнее обычного,
// разговорное (isColloquial) — хуже, историческое не берём вовсе.
function rankOf(f) { return (f[4] === '1' ? 2 : 0) + (f[6] === '1' ? -1 : 0); }

/* Один проход по файлу альтернативных имён отдаёт сразу два: русское название
 * места и его ЛАТИНСКИЕ написания. Второй проход стоил бы ещё гигабайта
 * распаковки ради тех же строк, а нужны они обе вместе:
 *   — русское имя это то, что увидит владелец в панели;
 *   — латинские написания это ключи, по которым его найдёт DB-IP. Без них
 *     «New York» не находится вовсе: в GeoNames место зовётся «New York City».
 */
async function scanAlt(zip, inner, ids) {
  const titles = new Map();     // id → { name, rank }
  const aliases = new Map();    // id → [латинские написания]
  let rows = 0;
  for await (const line of lines(zip, inner)) {
    rows++;
    const f = line.split('\t');
    const id = f[1], name = f[3];
    if (!id || !name || f[7] === '1') continue;   // историческое название не берём
    if (ids && !ids.has(id)) continue;
    if (f[2] === 'ru') {
      if (!/[А-Яа-яЁё]/.test(name)) continue;
      const rank = rankOf(f);
      const cur = titles.get(id);
      if (!cur || rank > cur.rank) titles.set(id, { name, rank });
      continue;
    }
    // Пустой язык — обычное написание, «en» — английское. Всё прочее (ссылки,
    // почтовые коды, иные языки) в ключи не годится.
    if (f[2] && f[2] !== 'en') continue;
    if (name.length < 3 || !latin(name)) continue;
    let list = aliases.get(id);
    if (!list) aliases.set(id, list = []);
    if (list.length < 6) list.push(name);         // больше шести написаний — уже шум
  }
  return { titles, aliases, rows };
}

function newDict() {
  const dict = new Map();   // «CC|ключ» → { ru, pop }
  const add = (cc, name, ru, pop) => {
    const k = GEO.softKey(name);
    if (!k || !cc) return;
    const full = cc + '|' + k;
    const cur = dict.get(full);
    // Тёзок в стране много («Александровка» в десяти областях), и по-русски они
    // зовутся одинаково — спор решает население, а не порядок строк в файле.
    if (!cur || pop > cur.pop) dict.set(full, { ru, pop });
  };
  return { dict, add };
}

(async () => {
  console.log('Источник: GeoNames, CC BY 4.0 —', BASE);
  if (!APPLY) {
    console.log('\nПредпросмотр. Чтобы собрать словарь: node scripts/build-city-names.js --apply');
    console.log('Скачается около 220 МБ, на выходе', OUT);
    return;
  }

  const { dict, add } = newDict();

  // --- Россия: все населённые пункты, а не только города ---
  console.log('Россия:');
  const ruZip = await get('RU.zip');
  const ruAlt = await get('alternatenames/RU.zip');
  const places = new Map();   // id → { name, ascii, pop }
  for await (const line of lines(ruZip, 'RU.txt')) {
    const f = line.split('\t');
    if (f[6] !== 'P') continue;               // населённые пункты
    places.set(f[0], { name: f[1], ascii: f[2], pop: Number(f[14]) || 0 });
  }
  const ruIds = new Set(places.keys());
  const { titles: ruTitles, aliases: ruAliases } = await scanAlt(ruAlt, 'RU.txt', ruIds);
  let ruPlaces = 0;
  for (const [id, p] of places) {
    const title = ruTitles.get(id);
    if (!title) continue;
    ruPlaces++;
    for (const variant of [p.name, p.ascii, ...(ruAliases.get(id) || [])]) {
      if (variant && latin(variant)) add('RU', variant, title.name, p.pop);
    }
  }
  console.log(`  населённых пунктов ${places.size.toLocaleString('ru-RU')}, с русским именем ${ruPlaces.toLocaleString('ru-RU')}`);

  // --- Мир: города от тысячи жителей ---
  console.log('Мир:');
  const cityZip = await get('cities1000.zip');
  const altZip = await get('alternateNamesV2.zip');
  const cities = new Map();
  for await (const line of lines(cityZip, 'cities1000.txt')) {
    const f = line.split('\t');
    if (f.length < 15) continue;
    if (f[8] === 'RU') continue;              // Россия уже разобрана целиком
    cities.set(f[0], { name: f[1], ascii: f[2], cc: f[8], pop: Number(f[14]) || 0 });
  }
  const worldIds = new Set(cities.keys());
  const { titles: worldTitles, aliases: worldAliases, rows } = await scanAlt(altZip, 'alternateNamesV2.txt', worldIds);
  let worldPlaces = 0;
  for (const [id, c] of cities) {
    const title = worldTitles.get(id);
    if (!title) continue;
    worldPlaces++;
    for (const variant of [c.name, c.ascii, ...(worldAliases.get(id) || [])]) {
      if (variant && latin(variant)) add(c.cc, variant, title.name, c.pop);
    }
  }
  console.log(`  городов ${cities.size.toLocaleString('ru-RU')}, с русским именем ${worldPlaces.toLocaleString('ru-RU')}`
    + ` (просмотрено ${rows.toLocaleString('ru-RU')} строк)`);

  if (dict.size < MIN_ROWS) {
    throw new Error(`в словаре всего ${dict.size} строк — это не похоже на полный разбор, готовый не трогаем`);
  }

  /* Сортировка байтовая и обязана совпасть с той, которой ищет `lib/geoip.js`:
   * он читает ключ как latin1, то есть сравнивает байты. `localeCompare` тут
   * дал бы другой порядок, и бинарный поиск промахивался бы через раз. */
  const keys = [...dict.keys()].sort();
  const text = keys.map(k => k + '\t' + dict.get(k).ru).join('\n') + '\n';
  const gz = zlib.gzipSync(Buffer.from(text, 'utf8'), { level: 9 });
  const tmp = OUT + '.tmp';
  fs.writeFileSync(tmp, gz);
  fs.renameSync(tmp, OUT);   // прерванная запись не оставит половину словаря

  console.log(`\nГотово: ${keys.length.toLocaleString('ru-RU')} написаний, `
    + `${(Buffer.byteLength(text) / 1048576).toFixed(1)} МБ текста → ${(gz.length / 1048576).toFixed(2)} МБ сжатого`);
  console.log('Файл:', OUT);
  if (!KEEP) { try { fs.rmSync(CACHE, { recursive: true, force: true }); } catch (e) {} }
  else console.log('Скачанное осталось в', CACHE);
})().catch(err => { console.error('Ошибка:', err && err.message ? err.message : err); process.exit(1); });
