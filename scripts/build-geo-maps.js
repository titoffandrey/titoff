'use strict';

/* Одноразовая сборка геометрии карт метрики: мир целиком и регионы стран.
 *
 * Исходники — свободные данные Natural Earth (public domain,
 * https://github.com/nvkelso/natural-earth-vector):
 *   geojson/ne_110m_admin_0_countries.geojson          — контуры стран мира
 *   geojson/ne_10m_admin_1_states_provinces.geojson    — регионы внутри стран
 *
 * В приложение кладётся не сорок мегабайт GeoJSON, а уже спроецированные и
 * упрощённые контуры: `lib/world-map-data.js` и по файлу на страну в
 * `lib/maps/`. Серверу остаётся покрасить их цифрами отчёта — ни
 * картографической библиотеки, ни сетевого запроса в панели нет.
 *
 * КАРТУ РОССИИ ЭТОТ СКРИПТ НЕ ТРОГАЕТ: она собрана `build-russia-map.js` из
 * данных Click That 'Hood, и её названия сопоставлены с геобазой поимённо
 * (тест перебирает все 85). У Natural Earth на замену есть свой соблазн —
 * готовые `name_ru`, — но в них Алтайский край подписан «Республика Алтай», то
 * есть два разных субъекта слились бы в один и один из них пропал бы с карты.
 * Проверять чужие переводы дороже, чем оставить рабочие контуры на месте.
 *
 * Запуск:
 *   node scripts/build-geo-maps.js <ne_110m_admin_0_countries.geojson> [<ne_10m_admin_1_states_provinces.geojson>]
 */

const fs = require('fs');
const path = require('path');
const CI = require('../lib/client-icons');

const WIDTH = 1000;   // ширина viewBox: в ней же считаются упрощение и допуск
const PAD = 6;
/* Допуск упрощения — в единицах viewBox, а не в градусах: карта показывается
 * шириной 300–900 px, то есть единица viewBox это доли пикселя. То же число и
 * та же причина, что у карты России (см. build-russia-map.js). */
const TOLERANCE = 0.8;
const MIN_AREA = 1.2;   // остров мельче пикселя не рисуем, а место он занимает
const MIN_REGIONS = 3;  // карта из двух областей ничего не показывает

/* Мир рисуется МЕРКАТОРОМ и обрезается по широте, как у Google: снизу карта
 * кончается на Новой Зеландии и юге Чили, сверху — на севере Гренландии.
 * Антарктида отброшена целиком: у неё нет ни посетителей, ни смысла в отчёте, а
 * места в Меркаторе она занимает больше всей остальной карты. */
const WORLD_TOP = 84;
const WORLD_BOTTOM = -58;
const SKIP_COUNTRIES = new Set(['AQ']);

const rad = deg => deg * Math.PI / 180;

const countriesFile = process.argv[2];
const statesFile = process.argv[3];
if (!countriesFile) throw new Error('Укажите путь к ne_110m_admin_0_countries.geojson');

/* ------------------------------ Общая геометрия --------------------------- */

function sqSegDistance(p, a, b) {
  let x = a[0]; let y = a[1];
  let dx = b[0] - x; let dy = b[1] - y;
  if (dx || dy) {
    const t = ((p[0] - x) * dx + (p[1] - y) * dy) / (dx * dx + dy * dy);
    if (t > 1) { x = b[0]; y = b[1]; }
    else if (t > 0) { x += dx * t; y += dy * t; }
  }
  dx = p[0] - x; dy = p[1] - y;
  return dx * dx + dy * dy;
}

function simplifyStep(points, first, last, tolerance, kept) {
  let max = tolerance; let at = -1;
  for (let i = first + 1; i < last; i++) {
    const d = sqSegDistance(points[i], points[first], points[last]);
    if (d > max) { at = i; max = d; }
  }
  if (at < 0) return;
  if (at - first > 1) simplifyStep(points, first, at, tolerance, kept);
  kept.push(points[at]);
  if (last - at > 1) simplifyStep(points, at, last, tolerance, kept);
}

function simplify(points) {
  if (points.length < 5) return points;
  const kept = [points[0]];
  simplifyStep(points, 0, points.length - 1, TOLERANCE * TOLERANCE, kept);
  kept.push(points[points.length - 1]);
  return kept;
}

function ringArea(ring) {
  let sum = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) sum += (ring[j][0] + ring[i][0]) * (ring[j][1] - ring[i][1]);
  return Math.abs(sum / 2);
}

// После округления до целых соседние точки часто совпадают: «L512,300L512,300»
// это девять лишних байт на каждом повторе, а их тысячи.
function dedupe(ring) {
  const out = [];
  for (const p of ring) {
    const prev = out[out.length - 1];
    if (!prev || prev[0] !== p[0] || prev[1] !== p[1]) out.push(p);
  }
  return out;
}

function polygonsOf(geometry) {
  if (!geometry) return [];
  if (geometry.type === 'Polygon') return [geometry.coordinates];
  if (geometry.type === 'MultiPolygon') return geometry.coordinates;
  return [];
}

/* Замкнутую линию начинаем с самой западной точки: так первый и последний узлы
 * стабильны, а упрощение не создаёт щель на границе полигона. */
function orderRing(points) {
  if (points.length < 5) return points;
  let start = 0;
  for (let i = 1; i < points.length - 1; i++) if (points[i][0] < points[start][0]) start = i;
  const open = points.slice(0, -1);
  const rotated = open.slice(start).concat(open.slice(0, start));
  rotated.push(rotated[0]);
  return rotated;
}

// Путь из уже спроецированных и отмасштабированных колец.
function pathOf(rings) {
  const chunks = [];
  for (const ring of rings) {
    const points = simplify(ring);
    if (ringArea(points) < MIN_AREA) continue;
    const grid = dedupe(points.map(p => [Math.round(p[0]), Math.round(p[1])]));
    if (grid.length < 3) continue;
    chunks.push('M' + grid.map(p => p[0] + ',' + p[1]).join('L') + 'Z');
  }
  return chunks.join('');
}

/* --------------------------------- Мир ------------------------------------ */

/* У Меркатора обе оси считаются в радианах — и долгота тоже. Написать x в
 * градусах, а y логарифмом (он безразмерный) значит растянуть карту в
 * пятьдесят семь раз по горизонтали: первый заход выдал ровно это — мир
 * высотой в 24 единицы, где от стран не осталось ничего крупнее пикселя. */
const mercY = lat => Math.log(Math.tan(Math.PI / 4 + rad(Math.max(WORLD_BOTTOM, Math.min(WORLD_TOP, lat))) / 2));
const WORLD_Y0 = mercY(WORLD_TOP);
const WORLD_Y1 = mercY(WORLD_BOTTOM);
const WORLD_SCALE = (WIDTH - PAD * 2) / (2 * Math.PI);
const WORLD_HEIGHT = Math.round((WORLD_Y0 - WORLD_Y1) * WORLD_SCALE + PAD * 2);
const worldPoint = point => [
  PAD + rad(Number(point[0]) + 180) * WORLD_SCALE,
  PAD + (WORLD_Y0 - mercY(Number(point[1]))) * WORLD_SCALE
];

function isoOf(properties) {
  for (const key of ['ISO_A2', 'ISO_A2_EH', 'ADM0_ISO']) {
    const value = String(properties[key] || '').trim().toUpperCase();
    if (/^[A-Z]{2}$/.test(value) && value !== '-9') return value;
  }
  return '';
}

/* Имя страны в панели ОДНО. Своя таблица (`lib/client-icons.js`) знает около
 * девяноста стран — это те, у кого рядом есть флаг и по чьим названиям панель
 * ищет код; для остального мира берётся русское имя Natural Earth. Второй
 * таблицы-конкурента при этом не заводится: своя всегда главнее, а данные карты
 * только закрывают то, чего в ней нет. */
function nameOf(code, properties) {
  return CI.countryName(code) || String(properties.NAME_RU || properties.NAME || '').trim();
}

function buildWorld() {
  const geo = JSON.parse(fs.readFileSync(countriesFile, 'utf8'));
  const countries = [];
  for (const feature of geo.features || []) {
    const code = isoOf(feature.properties || {});
    if (!code || SKIP_COUNTRIES.has(code)) continue;
    const rings = [];
    for (const polygon of polygonsOf(feature.geometry)) {
      for (const ring of polygon) rings.push(orderRing(ring.map(worldPoint)));
    }
    const d = pathOf(rings);
    if (!d) continue;
    /* Рамка страны нужна не для красоты: по ней карта приближается к выбранной
     * стране, когда своих регионов у неё нет. Считается она по УПРОЩЁННОМУ
     * пути — ровно по тому, что нарисовано, иначе приближение уезжало бы на
     * островок, которого на карте не осталось. */
    const xs = []; const ys = [];
    for (const chunk of d.slice(1).split('M')) {
      for (const pair of chunk.replace(/Z$/, '').split('L')) {
        const [x, y] = pair.split(',').map(Number);
        if (Number.isFinite(x) && Number.isFinite(y)) { xs.push(x); ys.push(y); }
      }
    }
    countries.push({
      code, name: nameOf(code, feature.properties || {}), d,
      box: [Math.min(...xs), Math.min(...ys), Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)].map(v => Math.round(v))
    });
  }
  countries.sort((a, b) => a.name.localeCompare(b.name, 'ru'));
  const out = `'use strict';\n\n`
    + `/* Контуры стран мира для карты метрики.\n`
    + ` *\n`
    + ` * Сгенерировано scripts/build-geo-maps.js из данных Natural Earth (public\n`
    + ` * domain). Руками не правится: перегенерируй скриптом.\n`
    + ` *\n`
    + ` * Проекция — Меркатор, обрезанный по широте (${WORLD_TOP}° … ${WORLD_BOTTOM}°): снизу карта\n`
    + ` * кончается Новой Зеландией и югом Чили, Антарктиды нет вовсе.\n`
    + ` * У страны хранится рамка \`box\` — по ней карта приближается к ней самой.\n`
    + ` */\n`
    + `module.exports = ${JSON.stringify({ viewBox: `0 0 ${WIDTH} ${WORLD_HEIGHT}`, countries })};\n`;
  fs.writeFileSync(path.join(__dirname, '..', 'lib', 'world-map-data.js'), out);
  console.log(`мир: ${countries.length} стран · viewBox 0 0 ${WIDTH} ${WORLD_HEIGHT} · ${Math.round(Buffer.byteLength(out) / 1024)} КБ`);
}

/* ----------------------------- Регионы страны ------------------------------
 *
 * Проекция — коническая Альберса, та же, в которой нарисована Россия, но её
 * параллели считаются от самой страны: центральный меридиан по середине,
 * параллели сечения на трети и двух третях широтного размаха. У страны на
 * экваторе конус вырождается (высота вершины уходит в бесконечность), поэтому
 * ниже двенадцатого градуса берётся обычная равнопромежуточная сетка со сжатием
 * по косинусу широты — там разница между ними и так незаметна.
 */
function projectorFor(bounds) {
  const [lonMin, latMin, lonMax, latMax] = bounds;
  const lon0 = (lonMin + lonMax) / 2;
  const lat0 = (latMin + latMax) / 2;
  const span = Math.max(1, latMax - latMin);
  const phi1 = latMin + span / 3;
  const phi2 = latMax - span / 3;
  const cone = (Math.sin(rad(phi1)) + Math.sin(rad(phi2))) / 2;
  if (Math.abs(lat0) < 12 || Math.abs(cone) < 0.2) {
    const squeeze = Math.cos(rad(lat0));
    return point => [Number(point[0]) * squeeze, -Number(point[1])];
  }
  const c = Math.cos(rad(phi1)) ** 2 + 2 * cone * Math.sin(rad(phi1));
  const radius = lat => Math.sqrt(Math.max(0, c - 2 * cone * Math.sin(rad(lat)))) / cone;
  const rho0 = radius(lat0);
  const flip = cone > 0 ? 1 : -1;
  return point => {
    const theta = cone * rad(Number(point[0]) - lon0);
    const rho = radius(Number(point[1]));
    // Ось Y в SVG смотрит вниз, поэтому знак обратный географическому.
    return [rho * Math.sin(theta) * flip, (rho * Math.cos(theta) - rho0) * flip];
  };
}

/* Заморские территории в карту не идут. Франция вместе с Гвианой и Реюньоном
 * растягивается на полмира, и метрополия занимает в таком кадре пятую часть —
 * узнать в ней Францию невозможно.
 *
 * Основной массив ищется КЛАСТЕРИЗАЦИЕЙ, а не «от самого крупного куска».
 * Разница не теоретическая: крупнейший ОДИНОЧНЫЙ полигон Франции — Гвиана
 * (3°×3,6°), она больше любого департамента метрополии, и карта собиралась
 * вокруг неё, а вся Франция оставалась за кадром. Поэтому куски сперва
 * сшиваются в связные группы (соседи ближе `REACH`), и побеждает группа с
 * наибольшей суммарной площадью — метрополия из сотни департаментов, Аляска
 * вместе с континентом США, а Гавайи и Реюньон остаются снаружи, ровно как на
 * школьных картах.
 */
const REACH = 4;   // градусов между кусками, которые считаем соседями
function mainlandBounds(features) {
  const parts = [];
  for (const feature of features) {
    for (const polygon of polygonsOf(feature.geometry)) {
      const ring = polygon[0] || [];
      if (ring.length < 4) continue;
      const lons = ring.map(p => Number(p[0])); const lats = ring.map(p => Number(p[1]));
      const box = [Math.min(...lons), Math.min(...lats), Math.max(...lons), Math.max(...lats)];
      parts.push({ box, area: Math.max(0.0001, (box[2] - box[0]) * (box[3] - box[1])) });
    }
  }
  if (!parts.length) return null;
  const group = parts.map((_, i) => i);
  const root = i => { while (group[i] !== i) { group[i] = group[group[i]]; i = group[i]; } return i; };
  for (let i = 0; i < parts.length; i++) {
    for (let j = i + 1; j < parts.length; j++) {
      const a = parts[i].box; const b = parts[j].box;
      const near = b[2] >= a[0] - REACH && b[0] <= a[2] + REACH && b[3] >= a[1] - REACH && b[1] <= a[3] + REACH;
      if (near) group[root(i)] = root(j);
    }
  }
  const clusters = new Map();
  for (let i = 0; i < parts.length; i++) {
    const key = root(i);
    const box = parts[i].box;
    const cluster = clusters.get(key) || { area: 0, box: box.slice() };
    cluster.area += parts[i].area;
    cluster.box = [Math.min(cluster.box[0], box[0]), Math.min(cluster.box[1], box[1]), Math.max(cluster.box[2], box[2]), Math.max(cluster.box[3], box[3])];
    clusters.set(key, cluster);
  }
  return [...clusters.values()].sort((a, b) => b.area - a.area)[0].box;
}

// Страна вокруг 180-го меридиана (Фиджи, Новая Зеландия, Чукотка) иначе
// разрывается на противоположные края карты.
function unwrap(features) {
  let west = false; let east = false;
  for (const feature of features) {
    for (const polygon of polygonsOf(feature.geometry)) {
      for (const ring of polygon) for (const point of ring) {
        if (point[0] < -150) west = true;
        if (point[0] > 150) east = true;
      }
    }
  }
  return west && east;
}

function buildCountry(code, features) {
  const shift = unwrap(features);
  const fix = point => [shift && point[0] < 0 ? Number(point[0]) + 360 : Number(point[0]), Number(point[1])];
  /* Тип всегда MultiPolygon, и это не придирка: `polygonsOf()` заворачивает
   * одиночный Polygon в список, поэтому оставленный прежним тип означал бы
   * лишний уровень вложенности — кольца читались бы как полигоны. На этом уже
   * наступили: рамка не собиралась вовсе, и все страны, нарисованные одним
   * полигоном (Беларусь, Польша, Израиль — два десятка), молча оставались без
   * карты. */
  const bounds = mainlandBounds(features.map(f => ({
    geometry: f.geometry && {
      type: 'MultiPolygon',
      coordinates: polygonsOf(f.geometry).map(polygon => polygon.map(ring => ring.map(fix)))
    }
  })));
  if (!bounds) return null;
  const project = projectorFor(bounds);
  const inside = point => point[0] >= bounds[0] - 1 && point[0] <= bounds[2] + 1 && point[1] >= bounds[1] - 1 && point[1] <= bounds[3] + 1;

  const prepared = [];
  for (const feature of features) {
    const name = String(feature.properties.name_ru || feature.properties.name || '').trim();
    if (!name) continue;
    /* Латинских написаний у региона несколько, и геобазы называют его каждая
     * по-своему: Natural Earth пишет «Noord-Holland», DB-IP отдаёт английский
     * экзоним «North Holland», GeoNames — «Provincie Noord-Holland». Показывать
     * мы будем русское имя, а сводить строки отчёта с контуром — по любому из
     * написаний, поэтому все они уезжают в карту вместе с ним. */
    const alt = [...new Set([
      feature.properties.name, feature.properties.name_en, feature.properties.woe_name,
      feature.properties.gn_name, feature.properties.gns_name,
      ...String(feature.properties.name_alt || '').split('|')
    ].map(v => String(v || '').trim()).filter(v => v && v !== name))].slice(0, 6).join('|');
    const rings = [];
    for (const polygon of polygonsOf(feature.geometry)) {
      for (const ring of polygon) {
        const points = ring.map(fix);
        // Полигон целиком за пределами основного массива — заморская территория.
        if (!points.some(inside)) continue;
        rings.push(orderRing(points.map(project)));
      }
    }
    if (rings.length) prepared.push({ name, alt, rings });
  }
  if (prepared.length < MIN_REGIONS) return null;

  const all = [];
  for (const region of prepared) for (const ring of region.rings) all.push(...ring);
  const minX = Math.min(...all.map(p => p[0])); const maxX = Math.max(...all.map(p => p[0]));
  const minY = Math.min(...all.map(p => p[1])); const maxY = Math.max(...all.map(p => p[1]));
  /* Кадр подгоняется по длинной стороне: у вытянутой страны (Чили, Норвегия)
   * карта иначе вылезала бы за viewBox по высоте. */
  const scale = Math.min((WIDTH - PAD * 2) / Math.max(0.001, maxX - minX), (WIDTH - PAD * 2) / Math.max(0.001, maxY - minY));
  const width = Math.round((maxX - minX) * scale + PAD * 2);
  const height = Math.round((maxY - minY) * scale + PAD * 2);
  const xy = p => [PAD + (p[0] - minX) * scale, PAD + (p[1] - minY) * scale];

  const regions = [];
  for (const region of prepared) {
    const d = pathOf(region.rings.map(ring => ring.map(xy)));
    if (!d) continue;
    /* Названия слились — это один и тот же субъект двумя кусками (у Natural
     * Earth такое бывает), и рисовать их двумя строками рейтинга нельзя. */
    const same = regions.find(r => r.name === region.name);
    if (same) { same.d += d; continue; }
    regions.push({ name: region.name, alt: region.alt, d });
  }
  if (regions.length < MIN_REGIONS) return null;
  regions.sort((a, b) => a.name.localeCompare(b.name, 'ru'));
  return { viewBox: `0 0 ${width} ${height}`, regions: regions.map(r => (r.alt ? r : { name: r.name, d: r.d })) };
}

function buildRegions() {
  const geo = JSON.parse(fs.readFileSync(statesFile, 'utf8'));
  const byCountry = new Map();
  for (const feature of geo.features || []) {
    const p = feature.properties || {};
    const code = String(p.iso_a2 || '').trim().toUpperCase();
    // Россия собрана своим скриптом — см. шапку файла.
    if (!/^[A-Z]{2}$/.test(code) || code === 'RU' || SKIP_COUNTRIES.has(code)) continue;
    /* Регионы кладём только у стран, которые панель вообще умеет называть
     * по-русски (`lib/client-icons.js` — там же, где флаги). Natural Earth
     * знает области двухсот сорока стран, и все они вместе весят полтора
     * мегабайта ради карт, которые в этом магазине никто не откроет. */
    if (!CI.countryName(code)) continue;
    if (!byCountry.has(code)) byCountry.set(code, []);
    byCountry.get(code).push(feature);
  }
  const dir = path.join(__dirname, '..', 'lib', 'maps');
  fs.mkdirSync(dir, { recursive: true });
  for (const file of fs.readdirSync(dir)) if (/^[A-Z]{2}\.js$/.test(file)) fs.unlinkSync(path.join(dir, file));

  let total = 0; let made = 0; const skipped = [];
  for (const [code, features] of [...byCountry.entries()].sort()) {
    const map = buildCountry(code, features);
    // Пропуск называется вслух: страна с областями в исходнике, но без карты на
    // выходе — это ошибка сборки, а молчаливый пропуск её и прячет.
    if (!map) { skipped.push(code + '(' + features.length + ')'); continue; }
    const out = `'use strict';\n\n`
      + `// Регионы страны ${code} для карты метрики. Сгенерировано\n`
      + `// scripts/build-geo-maps.js из данных Natural Earth. Руками не правится.\n`
      + `module.exports = ${JSON.stringify(map)};\n`;
    fs.writeFileSync(path.join(dir, code + '.js'), out);
    total += Buffer.byteLength(out); made++;
  }
  console.log(`регионы: ${made} стран · ${Math.round(total / 1024)} КБ, крупнейший файл ${Math.round(Math.max(...fs.readdirSync(dir).filter(f => /\.js$/.test(f)).map(f => fs.statSync(path.join(dir, f)).size)) / 1024)} КБ`);
  if (skipped.length) console.log(`пропущены: ${skipped.join(' ')}`);
}

buildWorld();
if (statesFile) buildRegions();
