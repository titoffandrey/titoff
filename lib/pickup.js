'use strict';
/* ======================== Пункты выдачи: своя база и поиск ========================
 * Покупатель ввёл адрес — показываем ближайшие к нему пункты выдачи выбранного
 * перевозчика. Выбранный пункт подставляется в то же поле адреса, а его код
 * уезжает в заказ: именно по коду менеджер оформляет накладную.
 *
 * ВНЕШНИХ ЗАПРОСОВ НА ОФОРМЛЕНИИ НЕТ ВОВСЕ — ровно как у зон и тарифов
 * (lib/delivery-zones.js, lib/delivery-price.js). База пунктов лежит рядом с
 * данными магазина и обновляется ночью отдельным скриптом
 * (scripts/sync-pickup-points.js) тем же cron'ом, что двигает даты отзывов.
 * Так поиск ближайшего пункта стоит доли миллисекунды, не зависит от чужого
 * сервиса в момент покупки и не рассказывает наружу, куда везти заказ.
 *
 * Источник для СДЭК — ОФИЦИАЛЬНЫЙ ПУБЛИЧНЫЙ список пунктов
 * (`integration.cdek.ru/pvzlist/v1/xml`, старый интеграторский API 1.5). Ни
 * ключей, ни договора, ни бизнес-аккаунта он не требует: около десяти тысяч
 * пунктов по России, у всех до единого есть полный адрес и координаты, а вместе
 * с ними — код пункта, часы работы и тип (пункт выдачи или постамат).
 *
 * OpenStreetMap для СДЭК не годится, и это измерено, а не предположено: в
 * Екатеринбурге в радиусе 4 км там НОЛЬ офисов СДЭК и семь постаматов, при том
 * что офисов в городе десятки. Зато Ozon в OSM размечен плотно (217 точек в том
 * же радиусе) — и своего публичного списка у Ozon нет. Отсюда правило: у каждого
 * перевозчика свой источник, и оба лежат в одной базе.
 *
 * Пунктов у перевозчика может не быть вовсе (база ещё не скачана, город глухой,
 * источник отвалился). Это НЕ ошибка и оформление не ломает: список просто не
 * показывается, а адрес покупатель пишет руками, как и раньше.
 */

const fs = require('fs');
const path = require('path');
const db = require('./db');
const Z = require('./delivery-zones');

const FILE = path.join(db.DATA_DIR, 'pickup-points.json');
const VERSION = 1;

// Сколько пунктов показываем. Больше пяти — это уже список, в котором выбирают
// глазами по карте, а карты у нас нет: CSP запрещает внешние тайлы, да и решение
// «куда ехать» покупатель принимает по названию улицы, а не по плитке карты.
const LIMIT = 5;
// Дальше этого не предлагаем: «ближайший пункт в 200 км» — не подсказка. В
// глухом месте список просто останется пустым, и это честнее.
const MAX_KM = 60;
// Насколько устаревшей может быть база, прежде чем о ней стоит сказать в лог.
// Пункты открываются и закрываются постоянно, но месяц — ещё не беда.
const STALE_MS = 30 * 24 * 3600 * 1000;

/* ------------------------------- Чтение базы -------------------------------
 * Кэш по mtime — тем же приёмом, что `readJson` в lib/db.js: файл большой (около
 * двух мегабайт), а меняется раз в сутки. Вместе с данными кэшируется индекс:
 * строить его на каждый запрос значило бы отдать всю выгоду обратно.
 */
let cache = { mtime: -1, data: null, index: null };

function empty() { return { version: VERSION, updatedAt: 0, sources: {}, points: [] }; }

function load() {
  let st = null;
  try { st = fs.statSync(FILE); } catch (e) { cache = { mtime: -1, data: null, index: null }; return empty(); }
  if (cache.data && cache.mtime === st.mtimeMs) return cache.data;
  let data;
  try {
    const raw = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    data = raw && Array.isArray(raw.points) ? raw : empty();
  } catch (e) {
    // Битый файл — не повод падать на оформлении заказа.
    data = empty();
  }
  cache = { mtime: st.mtimeMs, data, index: null };
  return data;
}

// Запись атомарная, как и всё в lib/db.js: скрипт синхронизации бежит по ночам
// рядом с живым процессом, и полупустой файл прочитала бы витрина.
function save(data) {
  const tmp = FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data), { mode: 0o600 });
  fs.renameSync(tmp, FILE);
  cache = { mtime: -1, data: null, index: null };
}

/* --------------------------------- Индекс ---------------------------------
 * Две карты: пункты по перевозчику (для поиска по координатам) и пункты по
 * «перевозчик|город» (для запасного поиска по названию города).
 */
function index() {
  const data = load();
  if (cache.index && cache.data === data) return cache.index;
  const byCarrier = new Map(), byCity = new Map();
  for (const p of data.points) {
    if (!byCarrier.has(p.carrier)) byCarrier.set(p.carrier, []);
    byCarrier.get(p.carrier).push(p);
    const key = p.carrier + '|' + cityKey(p.city);
    if (!byCity.has(key)) byCity.set(key, []);
    byCity.get(key).push(p);
  }
  cache.index = { byCarrier, byCity };
  return cache.index;
}

// Есть ли вообще пункты этого перевозчика. По этому ответу витрина решает,
// спрашивать ли список: пустой блок «ближайшие пункты» показывать незачем.
function has(carrier) { return (index().byCarrier.get(String(carrier || '')) || []).length > 0; }

function stats() {
  const data = load();
  const by = {};
  for (const [carrier, list] of index().byCarrier) by[carrier] = list.length;
  return { updatedAt: data.updatedAt || 0, total: data.points.length, byCarrier: by };
}

// Насколько база устарела — для предупреждения при старте сервера. Молчаливое
// «фича просто не работает» здесь недопустимо: та же грабля, что с ImageMagick,
// который без установки тихо отдавал исходники вместо превью.
function staleNote() {
  const data = load();
  if (!data.points.length) return 'база пунктов выдачи пуста — запусти scripts/sync-pickup-points.js';
  const age = Date.now() - (data.updatedAt || 0);
  if (age > STALE_MS) return `база пунктов выдачи обновлялась ${Math.round(age / 86400000)} дн. назад`;
  return '';
}

/* ------------------------------- Расстояние -------------------------------- */
const R_EARTH = 6371;
const rad = deg => deg * Math.PI / 180;

function distanceKm(lat1, lon1, lat2, lon2) {
  const dLat = rad(lat2 - lat1), dLon = rad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLon / 2) ** 2;
  return R_EARTH * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function isCoord(lat, lon) {
  return Number.isFinite(lat) && Number.isFinite(lon)
    && lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180
    && !(lat === 0 && lon === 0);
}

/* ------------------------- Поиск по названию города -------------------------
 * Запасной путь, когда координат нет: ключа подсказок может не быть вовсе, а
 * покупатель мог вписать адрес руками, не выбирая из списка.
 *
 * Строку разбирает ТОТ ЖЕ модуль, которым считается зона доставки: свой
 * нормализатор разошёлся бы с ним на первом же «Ростове-на-Дону», и город, по
 * которому посчитан тариф, отличался бы от города, в котором ищутся пункты.
 * `placePart()` заодно выбрасывает улицу вместе с её маркером — без этого
 * «ул. Кирова» находила бы посёлок Кирова где-нибудь в другой области.
 */
function cityKey(s) { return Z.words(s).join(' '); }

// Названия бывают в два-три слова («Нижний Новгород», «Гаврилов Посад»), поэтому
// из адреса берутся все цепочки до трёх слов подряд. Длинная проверяется раньше
// короткой: «Нижний Новгород» должен победить «Новгород».
const CITY_WORDS = 3;

function cityCandidates(address) {
  const words = Z.placePart(address).trim().split(/\s+/).filter(Boolean);
  const out = [];
  for (let len = CITY_WORDS; len >= 1; len--) {
    for (let i = 0; i + len <= words.length; i++) out.push(words.slice(i, i + len).join(' '));
  }
  return out;
}

// Пункты города, названного в адресе. Пусто — значит города мы не узнали, и
// предлагать нечего: пункт «где-то в России» бесполезен.
function pointsInCity(carrier, address) {
  if (!address) return [];
  const byCity = index().byCity;
  for (const name of cityCandidates(address)) {
    if (name.length < 3) continue;
    const list = byCity.get(carrier + '|' + name);
    if (list && list.length) return list;
  }
  return [];
}

/* ---------------------------- Адрес пункта --------------------------------
 * Строка, которая уедет в поле адреса и в заказ. Собирается из частей, а не
 * хранится готовой: так она одна и та же у скрипта, который базу пишет, и у
 * витрины, которая её показывает, — и файл заметно меньше.
 *
 * РЕГИОН В СТРОКЕ ОБЯЗАТЕЛЕН, и это не украшательство. Во-первых, по нему
 * считается зона доставки: в таблице зон крупные города, а пункты стоят и в
 * Акмуруне, и в Краснооктябрьском — без региона большая часть адресов уехала бы
 * в зону «регион не опознан» со средним тарифом по стране. Во-вторых, проверка
 * полноты адреса засчитывает населённый пункт по той же таблице зон, и без
 * региона она отвергала бы 60% пунктов как «адрес без города».
 * Измерено на официальном списке СДЭК: с регионом проходит 99,6% пунктов, и у
 * всех до одного зона определяется правильно.
 *
 * Регион, совпавший с городом (Москва, Петербург), не повторяем.
 */
function addressOf(p) {
  const region = String((p && p.region) || '').trim();
  const city = String((p && p.city) || '').trim();
  const street = String((p && p.short) || '').trim();
  const parts = [];
  if (region && region.toLowerCase() !== city.toLowerCase()) parts.push(region);
  if (city) parts.push(city);
  if (street) parts.push(street);
  return parts.join(', ');
}

// Короткая подпись для списка на витрине: город и улица с домом. Регион там ни
// к чему — покупатель и так смотрит на пункты рядом со своим адресом.
function shortOf(p) {
  return [String((p && p.city) || '').trim(), String((p && p.short) || '').trim()]
    .filter(Boolean).join(', ');
}

/* --------------------------------- Поиск ----------------------------------
 * Ближайшие пункты перевозчика. Координаты — главный путь (их отдаёт DaData
 * вместе с подсказкой адреса, отдельный геокодер не нужен), название города —
 * запасной. Вся сортировка живёт здесь же, рядом с базой: витрина получает
 * готовый список и ничего про пункты не решает.
 */
function nearest(carrier, opts) {
  const o = opts || {};
  const key = String(carrier || '');
  const limit = Math.max(1, Math.min(20, Number(o.limit) || LIMIT));
  const list = index().byCarrier.get(key) || [];
  if (!list.length) return [];

  const lat = Number(o.lat), lon = Number(o.lon);
  if (isCoord(lat, lon)) {
    // Грубый отсев по прямоугольнику до гаверсинуса: считать честное расстояние
    // до Владивостока ради пункта в Москве незачем. Градус широты — 111 км.
    const dLat = MAX_KM / 111;
    const dLon = MAX_KM / Math.max(1, 111 * Math.cos(rad(lat)));
    const near = [];
    for (const p of list) {
      if (Math.abs(p.lat - lat) > dLat || Math.abs(p.lon - lon) > dLon) continue;
      const km = distanceKm(lat, lon, p.lat, p.lon);
      if (km <= MAX_KM) near.push({ point: p, km });
    }
    near.sort((a, b) => a.km - b.km);
    return near.slice(0, limit).map(x => shape(x.point, x.km));
  }

  const city = pointsInCity(key, o.address);
  if (!city.length) return [];
  // Без координат покупателя сортируем от центра города: центральные пункты
  // ближе к кому угодно, чем окраинные, а лучшего порядка тут взять неоткуда.
  const cLat = city.reduce((s, p) => s + p.lat, 0) / city.length;
  const cLon = city.reduce((s, p) => s + p.lon, 0) / city.length;
  return city
    .map(p => ({ point: p, km: distanceKm(cLat, cLon, p.lat, p.lon) }))
    .sort((a, b) => a.km - b.km)
    .slice(0, limit)
    // Расстояние от центра города — не расстояние до покупателя, и показывать
    // его как «420 м от вас» было бы враньём. Поэтому отдаём без него.
    .map(x => shape(x.point, null));
}

// Что видит витрина. `address` — строка для поля адреса: она обязана проходить
// проверку полноты (lib/address.js), иначе выбор пункта ломает оформление.
// `title` — короткая подпись в списке.
function shape(p, km) {
  return {
    carrier: p.carrier,
    code: p.code,
    address: addressOf(p),
    title: shortOf(p),
    hours: p.hours || '',
    postamat: p.type === 'postamat',
    // Координаты отдаём витрине, чтобы после выбора пункта список считался от
    // него самого: подсказка dadata.ru относилась к прежнему адресу, а он уже
    // сменился на адрес пункта.
    lat: p.lat, lon: p.lon,
    km: km == null ? null : Math.round(km * 100) / 100
  };
}

// Пункт по коду — им проверяется выбор при оформлении заказа. Клиентской строке
// верить нельзя ровно так же, как клиентской цене: в заказ должен уехать адрес
// из базы, а не то, что прислал браузер.
function findPoint(carrier, code) {
  const c = String(carrier || ''), id = String(code || '');
  if (!id) return null;
  return (index().byCarrier.get(c) || []).find(p => p.code === id) || null;
}

module.exports = {
  FILE, VERSION, LIMIT, MAX_KM,
  load, save, empty, has, stats, staleNote,
  nearest, findPoint, shape, addressOf, shortOf,
  distanceKm, isCoord, cityKey, cityCandidates, pointsInCity
};
