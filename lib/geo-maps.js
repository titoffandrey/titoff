'use strict';

/* Карты метрики: мир целиком и регионы внутри страны.
 *
 * Здесь только доступ к геометрии и сведение названий; кто и как её красит —
 * дело `lib/analytics-view.js`. Данные лежат готовыми:
 *   `lib/world-map-data.js` — 174 страны в Меркаторе, у каждой рамка `box`;
 *   `lib/russia-map-data.js` — субъекты РФ (конус Альберса, свой источник);
 *   `lib/maps/<КОД>.js` — регионы прочих стран, по файлу на страну.
 *
 * ФАЙЛ СТРАНЫ ПОДКЛЮЧАЕТСЯ ЛЕНИВО. Все карты вместе весят полтора мегабайта, а
 * на страницу уезжает ровно одна — та, которую открыли. Список стран с картами
 * читается один раз при загрузке модуля: спрашивают его на каждый показ отчёта
 * (по нему меню решает, у какой страны есть своя карта), и щупать диск ради
 * этого незачем.
 */

const fs = require('fs');
const path = require('path');
const WORLD = require('./world-map-data');
const RUSSIA = require('./russia-map-data');
const CI = require('./client-icons');

const MAPS_DIR = path.join(__dirname, 'maps');
const withMaps = new Set(['RU']);
try {
  for (const file of fs.readdirSync(MAPS_DIR)) {
    const match = /^([A-Z]{2})\.js$/.exec(file);
    if (match) withMaps.add(match[1]);
  }
} catch (err) { /* папки нет — остаётся одна Россия, карта мира при этом цела */ }

const cache = new Map();

function isCode(value) { return /^[A-Z]{2}$/.test(String(value || '')); }

// Код страны из адреса или настроек: мусор становится пустой строкой, то есть
// «весь мир», а не поводом упасть.
function codeOf(value) {
  const code = String(value || '').trim().toUpperCase();
  return isCode(code) ? code : '';
}

function hasRegions(code) { return withMaps.has(codeOf(code)); }

/* Знаем ли мы такую страну вообще: есть имя в своей таблице, контур на карте
 * мира или своя карта регионов. Код в адресе правят руками, и `?geo=ZZ` не
 * должен превращать отчёт в пустую карту с пустым рейтингом — про неизвестную
 * страну показывать нечего, поэтому она и читается как «весь мир». */
function known(code) {
  const iso = codeOf(code);
  return !!iso && (!!CI.countryName(iso) || !!boxOf(iso) || withMaps.has(iso));
}

/* Карта регионов страны: `{viewBox, regions:[{name, alt, d}]}` либо null.
 * Россия отдаётся из своего файла — она собрана другим скриптом и с другими
 * названиями (см. scripts/build-geo-maps.js). */
function regionsOf(code) {
  const iso = codeOf(code);
  if (!iso || !withMaps.has(iso)) return null;
  if (cache.has(iso)) return cache.get(iso);
  let map = null;
  if (iso === 'RU') map = { viewBox: RUSSIA.viewBox, regions: RUSSIA.regions };
  else {
    try { map = require(path.join(MAPS_DIR, iso + '.js')); }
    catch (err) { map = null; }
  }
  cache.set(iso, map);
  return map;
}

function world() { return WORLD; }

/* Рамка страны на карте мира — по ней карта приближается к самой стране, когда
 * своих регионов у неё нет. Нет такой страны в контурах (микрогосударство,
 * которого нет даже в Natural Earth) — null, и карта останется общей. */
function boxOf(code) {
  const iso = codeOf(code);
  if (!iso) return null;
  const found = WORLD.countries.find(c => c.code === iso);
  return found && found.box ? found.box : null;
}

/* Имя страны ОДНО на всю панель: сначала своя таблица (`lib/client-icons.js` —
 * там же, где флаги и коды), и только если её там нет — имя из контуров карты.
 * Так у страны с флагом подпись везде одинаковая, а мир при этом назван весь. */
function countryName(code) {
  const iso = codeOf(code);
  if (!iso) return '';
  const own = CI.countryName(iso);
  if (own) return own;
  const found = WORLD.countries.find(c => c.code === iso);
  return found ? found.name : iso;
}

/* Сведение названий региона из геобазы с названием на карте.
 *
 * У России для этого есть поимённая таблица (`lib/analytics-view.js`): её
 * контуры собраны из другого источника и сверены тестом. Всем остальным
 * достаётся нормализация: DB-IP отдаёт регион по-английски («Gomel Region»), а
 * Natural Earth несёт и русское имя, и английское — сравниваем с обоими,
 * предварительно сняв диакритику и слово-тип («область», «province», «state»).
 */
/* Слово-тип выбрасывается СПИСКОМ, а не регуляркой с `\b`: с кириллицей граница
 * слова в JS не работает вовсе (это граница ASCII-слова), и «Гомельская
 * область» так и осталась бы с «областью» — а сравнивать её предстоит с
 * «Gomel Region», у которой тип как раз отрезался. */
const REGION_WORDS = new Set([
  'oblast', 'oblasti', 'obl', 'region', 'regione', 'regiao', 'province', 'provincia', 'provincie',
  'prefecture', 'state', 'estado', 'department', 'departement', 'departamento', 'county', 'district',
  'voivodeship', 'governorate', 'canton', 'krai', 'kray', 'okrug', 'republic', 'autonomous', 'city',
  'municipality', 'territory', 'of', 'the', 'and',
  'область', 'области', 'обл', 'край', 'края', 'республика', 'округ', 'автономный', 'автономная',
  'город', 'провинция', 'штат', 'воеводство', 'префектура', 'губерния', 'регион', 'земля'
]);

function matchKey(value) {
  const plain = String(value || '')
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/ё/g, 'е')
    .replace(/[^a-zа-я0-9]+/g, ' ')
    .trim();
  const words = plain.split(' ').filter(w => w && !REGION_WORDS.has(w));
  // Название состояло из одних типовых слов («Столичный округ») — тогда лучше
  // сравнивать целиком, чем по пустой строке: она совпала бы со всем подряд.
  return (words.length ? words : plain.split(' ')).join(' ');
}

module.exports = { world, regionsOf, hasRegions, known, boxOf, countryName, codeOf, matchKey, MAPS_DIR };
