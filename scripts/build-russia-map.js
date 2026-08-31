'use strict';

/* Одноразовая сборка геометрии карты субъектов РФ.
 *
 * Исходник — `russia.geojson` из MIT-проекта Click That 'Hood:
 * https://github.com/codeforgermany/click_that_hood
 *
 * В приложение кладётся не трёхмегабайтный GeoJSON, а уже спроецированные и
 * упрощённые контуры — сразу в `lib/russia-map-data.js`. Серверу остаётся
 * только покрасить их цифрами текущего отчёта: ни картографической библиотеки,
 * ни сетевого запроса в панели нет.
 *
 * ОТДЕЛЬНОГО ФАЙЛА `public/russia-regions.svg` БОЛЬШЕ НЕТ, и это не экономия
 * запроса, а работоспособность: ссылку `<use href="файл.svg#id">` на ВНЕШНИЙ
 * документ WebKit не поддерживает (баг 12499 у них с 2006 года), то есть в
 * Safari — и в панели на айфоне — карта осталась бы пустой. Контуры теперь
 * уезжают в саму страницу, как спрайт карточек каталога и логотипы
 * перевозчиков.
 *
 * Запуск:
 *   node scripts/build-russia-map.js /путь/russia.geojson
 */

const fs = require('fs');
const path = require('path');

const WIDTH = 1000;       // ширина viewBox: в ней же считаются упрощение и допуск
const PAD = 12;
/* Допуск упрощения — в единицах viewBox, а не в градусах.
 *
 * Это важнее, чем кажется: карта показывается шириной 300–900 px, то есть одна
 * единица viewBox — это доли пикселя. Прежний допуск задавался до
 * масштабирования и выходил примерно в 0,06 единицы — в тридцать раз точнее
 * того, что вообще можно увидеть, и стоил вчетверо более тяжёлого файла.
 * 0,35 единицы — это около 0,25 px при обычной ширине панели.
 */
const TOLERANCE = 0.35;
// Остров мельче единицы площади занял бы меньше пикселя: его не видно, а место
// в файле он занимает наравне с материком.
const MIN_AREA = 1;

const source = process.argv[2];
if (!source) throw new Error('Укажите путь к russia.geojson');

const geo = JSON.parse(fs.readFileSync(source, 'utf8'));
const features = Array.isArray(geo.features) ? geo.features : [];
if (!features.length) throw new Error('В GeoJSON нет субъектов');

// Россия пересекает 180-й меридиан. Отрицательные долготы Чукотки продолжаем
// вправо, иначе субъект разорвётся на противоположные края карты.
const project = point => {
  let lon = Number(point[0]);
  const lat = Number(point[1]);
  if (lon < 0) lon += 360;
  return [(lon - 18) * Math.cos(61 * Math.PI / 180), 82.5 - lat];
};

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

function orderRing(ring) {
  const points = ring.map(project);
  if (points.length < 5) return points;
  // Замкнутую линию начинаем с самой западной точки. Так первый и последний
  // узлы стабильны, а упрощение не создаёт щель на границе полигона.
  let start = 0;
  for (let i = 1; i < points.length - 1; i++) if (points[i][0] < points[start][0]) start = i;
  const open = points.slice(0, -1);
  const rotated = open.slice(start).concat(open.slice(0, start));
  rotated.push(rotated[0]);
  return rotated;
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
// это лишние девять байт на каждом повторе, а их тысячи.
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

const prepared = features.map(feature => ({
  name: String(feature.properties && feature.properties.name || '').trim(),
  polygons: polygonsOf(feature.geometry).map(poly => poly.map(orderRing))
})).filter(feature => feature.name && feature.polygons.length);

const all = [];
for (const feature of prepared) for (const polygon of feature.polygons) for (const ring of polygon) all.push(...ring);
const minX = Math.min(...all.map(p => p[0])); const maxX = Math.max(...all.map(p => p[0]));
const minY = Math.min(...all.map(p => p[1])); const maxY = Math.max(...all.map(p => p[1]));
const scale = (WIDTH - PAD * 2) / (maxX - minX);
const height = Math.round((maxY - minY) * scale + PAD * 2);
const xy = p => [PAD + (p[0] - minX) * scale, PAD + (p[1] - minY) * scale];

function pathOf(feature) {
  const chunks = [];
  for (const polygon of feature.polygons) {
    for (const ring of polygon) {
      // Порядок обязателен: сперва в единицы viewBox, потом упрощение по ним,
      // и только в конце округление до целых.
      const points = simplify(ring.map(xy));
      if (ringArea(points) < MIN_AREA) continue;
      const grid = dedupe(points.map(p => [Math.round(p[0]), Math.round(p[1])]));
      if (grid.length < 3) continue;
      chunks.push('M' + grid.map(p => p[0] + ',' + p[1]).join('L') + 'Z');
    }
  }
  return chunks.join('');
}

const regions = prepared.map(feature => ({ name: feature.name, d: pathOf(feature) }))
  .filter(region => region.d)
  .sort((a, b) => a.name.localeCompare(b.name, 'ru'))
  .map((region, index) => ({ name: region.name, id: 'ru-region-' + index, d: region.d }));

const output = `'use strict';\n\n`
  + `/* Контуры субъектов РФ для карты метрики.\n`
  + ` *\n`
  + ` * Сгенерировано scripts/build-russia-map.js из MIT-данных Click That 'Hood.\n`
  + ` * Руками не правится: перегенерируй скриптом.\n`
  + ` */\n`
  + `module.exports = ${JSON.stringify({ viewBox: `0 0 ${WIDTH} ${height}`, regions })};\n`;
const target = path.join(__dirname, '..', 'lib', 'russia-map-data.js');
fs.writeFileSync(target, output);
console.log(`${regions.length} субъектов · viewBox 0 0 ${WIDTH} ${height} · ${Buffer.byteLength(output)} байт`);
