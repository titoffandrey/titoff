'use strict';
/* Карта магазина — СВОЯ, на тайлах OpenStreetMap.
 *
 * До неё на «О компании» стоял виджет Яндекса. Он рисовал внутри чужого фрейма
 * свои кнопки — «Открыть в Яндекс Картах», «Пробки», зум, — а убрать их нельзя
 * ни нам, ни владельцу: фрейм с другого домена, и это ещё и плата за бесплатную
 * карту по их условиям. Здесь карта наша целиком: своя метка, своя кнопка
 * маршрута, свой вид.
 *
 * ГЛАВНОЕ: ТАЙЛЫ ОТДАЁТ НАШ СЕРВЕР, а не чужой. Браузер покупателя ходит только
 * на `/map/tile/...`, то есть с витрины по-прежнему не уходит НИ ОДНОГО запроса
 * на сторону — ровно то правило, по которому здесь нет шрифтов Google и внешнего
 * геосервиса в метрике. Сервер забирает картинку у OSM один раз и кладёт рядом с
 * данными: магазин не переезжает, поэтому весь его район — это полтора десятка
 * файлов, скачанных однажды.
 *
 * ОТКРЫТЫМ ПРОКСИ ЭТО НЕ СТАНОВИТСЯ. Маршрут отдаёт только тайлы вокруг САМОГО
 * МАГАЗИНА и только на одном масштабе (`allows()`): без этой рамки любой мог бы
 * качать через нас планету, и наш адрес забанили бы у OSM — их правила прямо
 * запрещают массовую выкачку.
 *
 * Своей геолокации у нас нет и не будет: координаты вписывает владелец в
 * настройках (или их находит `scripts/geocode-store.js`). Без них карты нет
 * вовсе — точка посреди города, не названная адресом, ничего не говорит.
 */
const fs = require('fs');
const path = require('path');

const TILE = 256;
// Масштаб один: 17 — это квартал вокруг дома, на нём видно и вход, и соседние
// улицы. Один масштаб держит рамку `allows()` простой и маленькой.
const ZOOM = 17;
/* Слой 5×3 тайла — 1280×768. Ширины хватает самому широкому блоку страницы
 * (карточка «О компании» около 910 px), высоты — блоку в 380 px: слой стоит
 * центром на точке магазина, поэтому в любую сторону остаётся не меньше
 * 640−128 = 512 px по горизонтали и 384−128 = 256 px по вертикали. */
const COLS = 5;
const ROWS = 3;
// Рамка отдачи: столько тайлов вокруг центрального сервер согласен показать.
// С запасом на слой (2 и 1) — чтобы правка COLS/ROWS не упёрлась в неё сразу.
const WINDOW_X = 4;
const WINDOW_Y = 3;

const SOURCE = 'https://tile.openstreetmap.org';
/* Правила OSM требуют User-Agent, по которому видно приложение: безымянный
 * запрос там блокируют, а чужой UA — тем более. */
const USER_AGENT = 'istore-shop-map/1.0 (self-hosted single-shop map)';
const TIMEOUT = 6000;
const MAX_BYTES = 512 * 1024;
// Не достучались — минуту не долбим их сервер этим же тайлом: карта переживёт
// дырку, а очередь одинаковых неудачных запросов не переживёт никто.
const FAIL_TTL = 60 * 1000;

const pending = new Map();   // тайл уже качается — второй запрос ждёт тот же ответ
const failed = new Map();    // ключ → до какого времени не пробовать снова

// Меркатор: доля от края мира по каждой оси, в тайлах. Долгота линейна, широта
// логарифмична — та же проекция, что у карты метрики (см. lib/geo-maps.js).
function project(lat, lon, z) {
  const n = Math.pow(2, z);
  const rad = lat * Math.PI / 180;
  return {
    x: (lon + 180) / 360 * n,
    y: (1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2 * n
  };
}

/* Разметка слоя: какие тайлы взять и где внутри слоя оказалась сама точка.
 * Ставит слой по месту уже CSS — `margin-left:-cx; margin-top:-cy` от центра
 * блока, поэтому одна и та же разметка годится и широкому экрану, и телефону:
 * лишнее просто обрезается рамкой блока. */
function layer(point, z) {
  z = z || ZOOM;
  const n = Math.pow(2, z);
  const p = project(point.lat, point.lon, z);
  const x0 = Math.floor(p.x) - Math.floor(COLS / 2);
  const y0 = Math.floor(p.y) - Math.floor(ROWS / 2);
  const tiles = [];
  for (let j = 0; j < ROWS; j++) {
    for (let i = 0; i < COLS; i++) {
      const y = y0 + j;
      if (y < 0 || y >= n) continue;              // за полюсом тайлов не бывает
      const x = ((x0 + i) % n + n) % n;            // мир замкнут по долготе
      tiles.push({ z, x, y, left: i * TILE, top: j * TILE, src: `/map/tile/${z}/${x}/${y}` });
    }
  }
  return {
    z, tiles,
    width: COLS * TILE, height: ROWS * TILE,
    cx: (p.x - x0) * TILE, cy: (p.y - y0) * TILE
  };
}

/* Отдаём ли мы этот тайл. Проверка идёт по ТЕКУЩЕЙ точке магазина, а не по
 * тому, что просили: сменил владелец адрес — прежние тайлы перестают отдаваться
 * сами собой. */
function allows(point, z, x, y) {
  // Масштаба два: обычный слой плитки и вдвое более плотный для склейки
  // постера. Оба — вокруг самой точки магазина, рамка ниже общая.
  if (!point || (z !== ZOOM && z !== ZOOM + 1)) return false;
  if (!Number.isInteger(x) || !Number.isInteger(y)) return false;
  const n = Math.pow(2, z);
  if (x < 0 || x >= n || y < 0 || y >= n) return false;
  const p = project(point.lat, point.lon, z);
  const dy = Math.abs(y - Math.floor(p.y));
  const raw = Math.abs(x - Math.floor(p.x));
  const dx = Math.min(raw, n - raw);                // через край мира тоже близко
  // На ближнем масштабе тайлы вдвое мельче, поэтому и рамка вдвое шире: та же
  // площадь квартала, просто нарезанная подробнее.
  const k = z === ZOOM ? 1 : 2;
  return dx <= WINDOW_X * k && dy <= WINDOW_Y * k;
}

function tileFile(dir, z, x, y) {
  return path.join(dir, 'map-tiles', String(z), String(x), y + '.png');
}
// PNG узнаём по сигнатуре, а не по заголовку ответа: в кэш магазина должна лечь
// картинка, а не страница с ошибкой, которую отдал прокси по дороге.
function isPng(buf) {
  return buf.length > 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47;
}

async function fetchTile(dir, z, x, y) {
  const key = `${z}/${x}/${y}`;
  const until = failed.get(key);
  if (until && until > Date.now()) return null;
  if (pending.has(key)) return pending.get(key);
  const job = (async () => {
    const control = new AbortController();
    const timer = setTimeout(() => control.abort(), TIMEOUT);
    try {
      const answer = await fetch(`${SOURCE}/${z}/${x}/${y}.png`, {
        headers: { 'User-Agent': USER_AGENT, Accept: 'image/png' },
        signal: control.signal
      });
      if (!answer.ok) throw new Error('HTTP ' + answer.status);
      const buf = Buffer.from(await answer.arrayBuffer());
      if (!buf.length || buf.length > MAX_BYTES || !isPng(buf)) throw new Error('в ответе не PNG');
      // Пишем через временный файл: оборванная закачка не должна оставить в кэше
      // половину тайла — тот же приём, что у writeJson в lib/db.js.
      const file = tileFile(dir, z, x, y);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const tmp = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, buf);
      fs.renameSync(tmp, file);
      failed.delete(key);
      return buf;
    } catch (e) {
      failed.set(key, Date.now() + FAIL_TTL);
      console.warn('карта: не удалось забрать тайл ' + key + ' — ' + e.message);
      return null;
    } finally {
      clearTimeout(timer);
      pending.delete(key);
    }
  })();
  pending.set(key, job);
  return job;
}

// Тайл из кэша, а если его там нет — с сервера OSM (и сразу в кэш).
async function load(dir, z, x, y) {
  try { return fs.readFileSync(tileFile(dir, z, x, y)); } catch (e) {}
  return fetchTile(dir, z, x, y);
}

/* ------------------------- Готовая картинка карты -------------------------
 *
 * ПЛИТКА ИЗ ТАЙЛОВ МЫЛИТСЯ, и дело не в OSM. Тайл 256×256 показывается ровно в
 * 256 CSS-пикселей, а экран у покупателя давно плотнее: на телефоне и любом
 * ноутбуке с Retina каждый пиксель картинки растягивается на два-три
 * физических. Карта из-за этого выглядит мутной рядом с текстом, который тут же
 * нарисован чётко.
 *
 * Лечится это единственным честным способом — БОЛЬШЕЙ ПЛОТНОСТЬЮ: берём тайлы
 * на масштаб ближе (`POSTER_ZOOM`) и показываем их вдвое мельче. Тогда на
 * каждый CSS-пиксель приходится два пикселя картинки, и карта становится такой
 * же резкой, как всё вокруг.
 *
 * Но плитка из 32 отдельных картинок — это 32 запроса на странице, поэтому
 * тайлы СКЛЕИВАЮТСЯ НА СЕРВЕРЕ в одну картинку (ImageMagick, тот же, что жмёт
 * фото товаров), и покупатель забирает её одним файлом. Заодно на склейке
 * снимается лишняя насыщенность: у стандартного стиля OSM жёлтые дороги и
 * розовые дома спорят с витриной, где всё спокойное и серо-белое.
 *
 * Постер лежит рядом с тайлами и НАЗЫВАЕТСЯ ПО КООРДИНАТАМ: сменил владелец
 * адрес — имя другое, старый файл просто перестаёт использоваться, а кэш
 * браузера не показывает чужой квартал. Нет ImageMagick или не собрался —
 * витрина рисует прежнюю плитку тайлов, и карта работает как раньше.
 */
const POSTER_ZOOM = ZOOM + 1;      // масштаб ближе: он и даёт двойную плотность
const POSTER_COLS = 8;             // 2048 px картинки = 1024 CSS
const POSTER_ROWS = 4;             // 1024 px картинки = 512 CSS
// Насыщенность стандартного стиля OSM для витрины великовата: 100 — как есть,
// 78 — спокойная карта, на которой метка магазина остаётся самым ярким пятном.
const POSTER_SATURATION = 78;
const POSTER_QUALITY = 82;

function posterLayer(point) {
  const z = POSTER_ZOOM;
  const n = Math.pow(2, z);
  const p = project(point.lat, point.lon, z);
  const x0 = Math.floor(p.x) - Math.floor(POSTER_COLS / 2);
  const y0 = Math.floor(p.y) - Math.floor(POSTER_ROWS / 2);
  const tiles = [];
  for (let j = 0; j < POSTER_ROWS; j++) {
    for (let i = 0; i < POSTER_COLS; i++) {
      const y = y0 + j;
      if (y < 0 || y >= n) continue;
      const x = ((x0 + i) % n + n) % n;
      tiles.push({ z, x, y, left: i * TILE, top: j * TILE });
    }
  }
  return {
    z, tiles,
    width: POSTER_COLS * TILE, height: POSTER_ROWS * TILE,
    // Где внутри картинки оказалась сама точка — в CSS-пикселях, то есть уже
    // с учётом двойной плотности: разметке нужно именно это.
    cx: (p.x - x0) * TILE / 2, cy: (p.y - y0) * TILE / 2
  };
}

// Имя постера — от координат: чужой квартал под тем же адресом не покажется.
function posterName(point) {
  if (!point) return '';
  const key = point.lat.toFixed(5) + ',' + point.lon.toFixed(5) + ',' + POSTER_ZOOM
    + ',' + POSTER_COLS + 'x' + POSTER_ROWS + ',' + POSTER_SATURATION;
  return require('crypto').createHash('sha1').update(key).digest('hex').slice(0, 16) + '.webp';
}
function posterFile(dir, name) {
  return path.join(dir, 'map-tiles', 'poster', String(name || '').replace(/[^a-f0-9.]/g, ''));
}
function posterReady(dir, point) {
  const name = posterName(point);
  if (!name) return '';
  try { fs.accessSync(posterFile(dir, name)); return name; } catch (e) { return ''; }
}

let building = null;   // сборка идёт — второй вызов ждёт тот же ответ

/* Собрать постер. Идемпотентна: готовый файл возвращается сразу, а параллельные
 * вызовы ждут одну работу — карта собирается при старте и может быть запрошена
 * страницей в тот же момент.
 */
async function buildPoster(dir, point, images) {
  if (!point) return '';
  const name = posterName(point);
  const file = posterFile(dir, name);
  try { fs.accessSync(file); return name; } catch (e) {}
  if (building) return building;
  building = (async () => {
    const bin = await images.detectBin();
    // Без ImageMagick склеивать нечем — витрина покажет прежнюю плитку тайлов.
    if (!bin) return '';
    const view = posterLayer(point);
    const parts = [];
    for (const t of view.tiles) {
      const buf = await load(dir, t.z, t.x, t.y);
      // Дырка в карте лучше, чем карта, собранная наполовину: пусть покупатель
      // видит прежнюю плитку, где недостающий тайл хотя бы догрузится потом.
      if (!buf) return '';
      parts.push(tileFile(dir, t.z, t.x, t.y));
    }
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = file + '.' + process.pid + '.tmp';
    try {
      await images.montage(bin, parts, {
        cols: POSTER_COLS, tile: TILE,
        saturation: POSTER_SATURATION, quality: POSTER_QUALITY, out: tmp
      });
      fs.renameSync(tmp, file);
      return name;
    } catch (e) {
      try { fs.unlinkSync(tmp); } catch (err) {}
      console.warn('карта: не удалось собрать картинку — ' + e.message);
      return '';
    }
  })().finally(() => { building = null; });
  return building;
}

module.exports = { ZOOM, TILE, COLS, ROWS, project, layer, allows, load, tileFile, SOURCE,
  POSTER_ZOOM, POSTER_COLS, POSTER_ROWS, posterLayer, posterName, posterFile, posterReady, buildPoster };
