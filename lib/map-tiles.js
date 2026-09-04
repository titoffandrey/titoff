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
  if (!point || z !== ZOOM) return false;
  if (!Number.isInteger(x) || !Number.isInteger(y)) return false;
  const n = Math.pow(2, z);
  if (x < 0 || x >= n || y < 0 || y >= n) return false;
  const p = project(point.lat, point.lon, z);
  const dy = Math.abs(y - Math.floor(p.y));
  const raw = Math.abs(x - Math.floor(p.x));
  const dx = Math.min(raw, n - raw);                // через край мира тоже близко
  return dx <= WINDOW_X && dy <= WINDOW_Y;
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

module.exports = { ZOOM, TILE, COLS, ROWS, project, layer, allows, load, tileFile, SOURCE };
