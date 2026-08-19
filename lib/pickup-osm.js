'use strict';
/* ==================== Пункты выдачи OZON из OpenStreetMap ====================
 * У OZON нет публичного списка пунктов: их API требует аккаунта продавца, а
 * адреса на сайте отдаются внутренними запросами, которые ломаются от любой
 * правки их фронта. Зато в OSM точки OZON размечены плотно — 585 штук в радиусе
 * 12 км от центра Екатеринбурга, — и лицензия OSM разрешает коммерческое
 * использование при указании авторства (оно стоит под списком на витрине).
 *
 * Это ЕДИНСТВЕННОЕ место, где оформление заказа связано с чужим сервисом, и
 * связано оно нежёстко:
 *   · наружу уходит НЕ адрес покупателя, а ЦЕНТР ПЛИТКИ в 0,1° (~11 км) —
 *     Overpass не узнаёт ни улицы, ни дома, ни самого заказа;
 *   · запрос никогда не ждут: маршрут отдаёт то, что уже есть в базе, и лишь
 *     помечает ответ `refreshing`, чтобы витрина переспросила через несколько
 *     секунд. Медленный или упавший Overpass не задерживает заказ ни на миг;
 *   · результат ложится в ту же базу, что и СДЭК, и дальше живёт как свой:
 *     следующему покупателю в этом городе он достаётся мгновенно.
 *
 * АДРЕС БЕРЁТСЯ ТОЛЬКО ТОЧНЫМ ПОПАДАНИЕМ В ЗДАНИЕ, а не «ближайшим домом в
 * 60 м»: у точки OSM своего адреса почти никогда нет (11 из 585), и промах на
 * соседнее здание отправил бы покупателя не туда. Точка вне здания с адресом
 * просто не показывается — таких 21%.
 */

const PICKUP = require('./pickup');

const URL_OVERPASS = 'https://overpass-api.de/api/interpreter';
/* Запрос ОБЯЗАН представляться, и это не вежливость: Apache перед Overpass
 * отвечает 406 на запрос без User-Agent, а Node его сам не ставит. Проверено на
 * боевом сервере — с заголовком 200, без него 406 и в том, и в другом виде тела.
 * Правила пользования OSM тоже требуют опознаваемого агента.
 *
 * Домен магазина в него не пишем: Overpass и так видит IP, а называть себя
 * лишний раз незачем.
 */
const USER_AGENT = 'apple-store-pickup/1.0 (self-hosted shop; OpenStreetMap data)';
// Плитка, которой округляются координаты покупателя перед запросом наружу.
// 0,1° — это ~11 км по широте: город делится на несколько плиток, а дом или
// улица по такому центру не восстанавливаются.
const TILE = 0.1;
const RADIUS = 12000;              // м вокруг центра плитки
const TTL = 14 * 24 * 3600 * 1000; // пункты открываются и закрываются, но не ежедневно
const TIMEOUT = 90 * 1000;
// Публичный Overpass — общий ресурс, и вести себя с ним надо соответственно:
// один запрос за раз и пауза между ними.
const COOLDOWN = 20 * 1000;
// Регион и город берём у ближайшего пункта СДЭК: в OSM региона нет вовсе, а
// город есть лишь у половины зданий. Дальше этого не ищем — иначе адрес получит
// регион соседней области.
const PLACE_KM = 25;

const BRAND = /ozon|озон/i;

let inFlight = null;
let lastRun = 0;
const failed = new Map();          // плитка -> когда сорвалось, чтобы не долбить

function tileFor(lat, lon) {
  const t = n => Math.round(n / TILE) * TILE;
  const tLat = Math.round(t(lat) * 10) / 10;
  const tLon = Math.round(t(lon) * 10) / 10;
  return { key: tLat.toFixed(1) + ',' + tLon.toFixed(1), lat: tLat, lon: tLon };
}

function tilesOf(base) {
  const src = (base.sources && base.sources.ozon) || {};
  return src.tiles && typeof src.tiles === 'object' ? src.tiles : {};
}

// Нужно ли обновлять плитку. Свежая или недавно сорвавшаяся — не трогаем.
function tileStale(base, key) {
  const at = Number(tilesOf(base)[key]) || 0;
  if (Date.now() - at < TTL) return false;
  const bad = failed.get(key) || 0;
  return Date.now() - bad >= COOLDOWN * 15;
}

/* ------------------------------- Разбор OSM -------------------------------- */
// Точка внутри контура. Обычный «луч вправо»: считаем пересечения с рёбрами.
function inside(lat, lon, ring) {
  let hit = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const yi = ring[i].lat, xi = ring[i].lon, yj = ring[j].lat, xj = ring[j].lon;
    if (((yi > lat) !== (yj > lat)) && (lon < (xj - xi) * (lat - yi) / (yj - yi) + xi)) hit = !hit;
  }
  return hit;
}

const DAYS = { Mo: 'Пн', Tu: 'Вт', We: 'Ср', Th: 'Чт', Fr: 'Пт', Sa: 'Сб', Su: 'Вс' };
// `opening_hours` пишется по-английски. Переводим только дни недели — время в
// нём и так цифрами, а разбирать всю грамматику формата незачем.
function hoursRu(value) {
  const s = String(value || '').trim();
  if (!s || s.length > 120) return '';
  return s.replace(/\b(Mo|Tu|We|Th|Fr|Sa|Su)\b/g, d => DAYS[d]).replace(/;\s*/g, ', ');
}

function isOzon(tags) {
  const t = tags || {};
  if (t.shop !== 'outpost' && t.amenity !== 'parcel_locker') return false;
  return BRAND.test([t.brand, t.operator, t.name, t['brand:ru']].filter(Boolean).join(' '));
}

function coordsOf(el) {
  if (typeof el.lat === 'number') return { lat: el.lat, lon: el.lon };
  if (el.center) return { lat: el.center.lat, lon: el.center.lon };
  return null;
}

/* Собрать пункты из ответа Overpass. Регион и город, если его нет в OSM, берутся
 * у ближайшего пункта СДЭК: своей таблицы населённых пунктов у нас нет, а эта
 * уже лежит рядом и покрывает 5857 городов.
 */
function pointsFrom(elements) {
  const points = [];
  const seen = new Set();
  const stats = { found: 0, noAddress: 0, noPlace: 0 };
  const buildings = elements.filter(e => e.geometry && e.tags
    && e.tags['addr:housenumber'] && e.tags['addr:street']);

  for (const el of elements) {
    if (!isOzon(el.tags)) continue;
    stats.found++;
    const at = coordsOf(el);
    if (!at) continue;
    const tags = el.tags || {};

    // Свой адрес у точки — большая редкость, но если он есть, он и есть лучший.
    let street = tags['addr:street'] && tags['addr:housenumber']
      ? tags['addr:street'] + ', ' + tags['addr:housenumber'] : '';
    let city = tags['addr:city'] || '';
    if (!street) {
      const box = buildings.find(b => inside(at.lat, at.lon, b.geometry));
      if (!box) { stats.noAddress++; continue; }
      street = box.tags['addr:street'] + ', ' + box.tags['addr:housenumber'];
      city = city || box.tags['addr:city'] || '';
    }

    // Регион в OSM не размечают, а без него адрес не пройдёт проверку полноты
    // в маленьком городе. Берём его (и город, если он не нашёлся) у ближайшего
    // пункта СДЭК — данные уже свои, и обходятся бесплатно.
    const near = PICKUP.nearestRaw('cdek', at.lat, at.lon, PLACE_KM);
    if (!near) { stats.noPlace++; continue; }
    const code = 'osm' + (el.type === 'way' ? 'w' : el.type === 'relation' ? 'r' : 'n') + el.id;
    if (seen.has(code)) continue;
    seen.add(code);
    points.push({
      carrier: 'ozon',
      code,
      // Лицензия OSM требует указать авторство там, где показаны её данные, —
      // по этому полю витрина подписывает список.
      source: 'osm',
      region: near.region,
      city: city || near.city,
      short: street,
      lat: Math.round(at.lat * 1e6) / 1e6,
      lon: Math.round(at.lon * 1e6) / 1e6,
      type: tags.amenity === 'parcel_locker' ? 'postamat' : 'pvz',
      hours: hoursRu(tags.opening_hours)
    });
  }
  return { points, stats };
}

function query(tile) {
  return `[out:json][timeout:120];\n`
    + `(nwr(around:${RADIUS},${tile.lat},${tile.lon})["shop"="outpost"];`
    + `nwr(around:${RADIUS},${tile.lat},${tile.lon})["amenity"="parcel_locker"];)->.p;\n`
    + `.p out center tags;\n`
    + `way(around.p:40)["addr:housenumber"]["addr:street"];\nout geom;\n`;
}

async function fetchTile(tile) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT);
  if (timer.unref) timer.unref();
  try {
    const res = await fetch(URL_OVERPASS, {
      method: 'POST', signal: controller.signal,
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': USER_AGENT,
        Accept: 'application/json'
      },
      body: 'data=' + encodeURIComponent(query(tile))
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    return Array.isArray(data && data.elements) ? data.elements : [];
  } finally {
    clearTimeout(timer);
  }
}

/* Обновить плитку и записать её пункты в общую базу. Пункты ЭТОЙ плитки
 * заменяются целиком (закрытые должны исчезать), пункты соседних плиток и
 * другие перевозчики не трогаются.
 *
 * База перечитывается прямо перед записью: рядом по ночам работает cron СДЭК, и
 * писать поверх прочитанного десять секунд назад значило бы его затереть.
 */
async function refreshTile(tile) {
  const elements = await fetchTile(tile);
  const { points, stats } = pointsFrom(elements);
  const base = PICKUP.load();
  const keep = base.points.filter(p => p.carrier !== 'ozon' || tileFor(p.lat, p.lon).key !== tile.key);
  const tiles = Object.assign({}, tilesOf(base));
  tiles[tile.key] = Date.now();
  PICKUP.save({
    version: PICKUP.VERSION,
    updatedAt: Date.now(),
    sources: Object.assign({}, base.sources, {
      ozon: { updatedAt: Date.now(), source: 'openstreetmap', tiles }
    }),
    points: keep.concat(points)
  });
  return { added: points.length, stats };
}

/* Позаботиться о том, чтобы у этих координат были свежие пункты OZON.
 * НИЧЕГО НЕ ЖДЁТ и ничего не бросает: возвращает `true`, если обновление
 * запущено, — по нему витрина переспросит список через несколько секунд.
 */
function ensureTile(lat, lon, opts) {
  if (!PICKUP.isCoord(lat, lon)) return false;
  const tile = tileFor(lat, lon);
  const base = PICKUP.load();
  if (!tileStale(base, tile.key)) return false;
  // Пока не знаем региона — писать адреса не из чего: база СДЭК ещё не скачана.
  if (!PICKUP.has('cdek')) return false;
  if (inFlight) return true;
  if (Date.now() - lastRun < COOLDOWN) return true;
  lastRun = Date.now();
  const log = !opts || opts.log !== false;
  inFlight = refreshTile(tile)
    .then(r => {
      failed.delete(tile.key);
      if (log) console.log(`  пункты OZON, плитка ${tile.key}: ${r.added}`
        + ` (без адреса ${r.stats.noAddress} из ${r.stats.found})`);
      return r;
    })
    .catch(e => {
      // Overpass — общий бесплатный ресурс, он вправе не ответить. Это не
      // ошибка магазина: список просто останется прежним.
      failed.set(tile.key, Date.now());
      if (log) console.warn('  пункты OZON не обновились:', (e && e.message) || e);
      return null;
    })
    .finally(() => { inFlight = null; });
  return true;
}

// Ждать обновления умеет только скрипт синхронизации — маршруту витрины ждать
// нельзя, и такой возможности у него нет.
function pending() { return inFlight; }

module.exports = {
  TILE, RADIUS, TTL, URL_OVERPASS, USER_AGENT,
  tileFor, tileStale, tilesOf, ensureTile, refreshTile, pending,
  pointsFrom, hoursRu, isOzon, inside
};
