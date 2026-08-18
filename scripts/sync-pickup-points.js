#!/usr/bin/env node
'use strict';
/* ===================== Обновление базы пунктов выдачи =====================
 * Качает список пунктов выдачи и кладёт его рядом с данными магазина
 * (`pickup-points.json`), откуда его читает lib/pickup.js. Запускается ночью
 * cron'ом — тем же, что двигает даты отзывов, — и вручную после установки.
 *
 *   node scripts/sync-pickup-points.js            # показать, что изменится
 *   node scripts/sync-pickup-points.js --apply    # записать
 *
 * Источник СДЭК — официальный публичный список пунктов, БЕЗ ключей и договора:
 * https://integration.cdek.ru/pvzlist/v1/xml?country=RU
 * Это старый интеграторский API 1.5; авторизации у него нет по построению, и
 * ровно поэтому он нам подходит — бизнес-аккаунт для подсказки «вот ближайший
 * пункт» заводить незачем.
 *
 * Скрипт идемпотентен: пункты не дописываются к прежним, а ЗАМЕНЯЮТ список
 * своего перевозчика целиком. Иначе закрытые пункты жили бы в базе вечно.
 * Чужие перевозчики при этом не трогаются — база одна на всех.
 *
 * Ничего не записано, пока список не разобран до конца и не оказался
 * правдоподобным (см. MIN_POINTS): пустой или обрезанный ответ чужого сервиса
 * не должен стирать рабочую базу.
 */

const PICKUP = require('../lib/pickup');
const ADDRESS = require('../lib/address');

const URL_CDEK = 'https://integration.cdek.ru/pvzlist/v1/xml?country=RU';
const TIMEOUT = 180 * 1000;      // 17 МБ по узкому каналу качаются небыстро
// Порог правдоподобия. У СДЭК больше десяти тысяч пунктов; если пришла тысяча —
// это обрезанный ответ или поломка на той стороне, и записывать его нельзя.
const MIN_POINTS = 3000;

const apply = process.argv.includes('--apply');

/* --------------------------------- Разбор ---------------------------------
 * Своего XML-парсера в проекте нет и заводить незачем: список плоский, каждый
 * пункт — один тег с атрибутами. Читаем атрибуты регуляркой, как читаются
 * строки характеристик и вариантов в остальном проекте.
 */
const ENTITIES = { quot: '"', apos: "'", lt: '<', gt: '>', amp: '&' };

function unescapeXml(s) {
  return String(s == null ? '' : s)
    .replace(/&#(\d+);/g, (m, code) => String.fromCharCode(Number(code)))
    .replace(/&(quot|apos|lt|gt|amp);/g, (m, name) => ENTITIES[name])
    .replace(/\s+/g, ' ')
    .trim();
}

function attrs(tag) {
  const out = {};
  const re = /([\w:]+)="([^"]*)"/g;
  let m;
  while ((m = re.exec(tag))) out[m[1]] = unescapeXml(m[2]);
  return out;
}

function parseCdek(xml) {
  const points = [];
  const seen = new Set();
  const skipped = { abroad: 0, inactive: 0, noHandout: 0, noGeo: 0, badAddress: 0, dupes: 0 };
  const tags = xml.match(/<Pvz\s[^>]*>/g) || [];
  for (const tag of tags) {
    const a = attrs(tag);
    // Список приходит со всем зарубежьем разом (Баку, Алматы, Минск), сколько бы
    // раз ни просили `country=RU`. Магазин отправляет по России — зоны доставки
    // и тарифы посчитаны только для неё.
    if (a.countryCodeIso && a.countryCodeIso !== 'RU') { skipped.abroad++; continue; }
    // Только действующие пункты, и только те, что выдают заказы: часть точек
    // работает лишь на приём отправлений, везти туда покупателя нельзя.
    if (a.Status && a.Status !== 'ACTIVE') { skipped.inactive++; continue; }
    if (a.IsHandout === 'false') { skipped.noHandout++; continue; }
    const lat = Number(a.coordY), lon = Number(a.coordX);   // coordX — долгота!
    if (!PICKUP.isCoord(lat, lon)) { skipped.noGeo++; continue; }
    const code = String(a.Code || '').trim();
    if (!code || seen.has(code)) { skipped.dupes++; continue; }
    const point = {
      carrier: 'cdek',
      code,
      region: String(a.RegionName || '').trim(),
      city: String(a.City || '').trim(),
      short: String(a.Address || '').trim(),
      lat: Math.round(lat * 1e6) / 1e6,
      lon: Math.round(lon * 1e6) / 1e6,
      type: a.Type === 'POSTAMAT' ? 'postamat' : 'pvz',
      hours: String(a.WorkTime || '').trim().slice(0, 120)
    };
    // Пункт, чей адрес не пройдёт проверку полноты, показывать нельзя: покупатель
    // выберет его, а оформление откажет — и виноват будет магазин, а не данные.
    // Строку собирает та же функция, что потом отдаёт её витрине.
    if (!ADDRESS.checkAddress(PICKUP.addressOf(point)).ok) { skipped.badAddress++; continue; }
    seen.add(code);
    points.push(point);
  }
  return { points, skipped };
}

async function download(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { Accept: 'application/xml, text/xml, */*' }
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

async function main() {
  console.log('Источник СДЭК:', URL_CDEK);
  let xml;
  try {
    xml = await download(URL_CDEK);
  } catch (e) {
    console.error('Не скачалось:', (e && e.message) || e);
    console.error('База осталась прежней — витрина продолжает работать со старым списком.');
    process.exit(1);
  }
  console.log('Получено:', (xml.length / 1048576).toFixed(1), 'МБ');

  const { points, skipped } = parseCdek(xml);
  console.log(`Разобрано пунктов: ${points.length}`
    + ` (постаматов: ${points.filter(p => p.type === 'postamat').length})`);
  console.log(`Отброшено: зарубежных ${skipped.abroad}, закрытых ${skipped.inactive},`
    + ` без выдачи ${skipped.noHandout}, без координат ${skipped.noGeo},`
    + ` с неполным адресом ${skipped.badAddress}, дублей ${skipped.dupes}`);

  if (points.length < MIN_POINTS) {
    console.error(`Пунктов подозрительно мало (< ${MIN_POINTS}) — ответ похож на обрезанный.`);
    console.error('Ничего не записано.');
    process.exit(1);
  }

  const base = PICKUP.load();
  const was = base.points.filter(p => p.carrier === 'cdek').length;
  console.log(`Было в базе: ${was}, станет: ${points.length}`);

  if (!apply) {
    console.log('\nЭто предпросмотр. Записать: --apply');
    return;
  }
  // Список своего перевозчика заменяется целиком, чужие остаются: базу делят
  // несколько источников, и у каждого свой срок обновления.
  const next = {
    version: PICKUP.VERSION,
    updatedAt: Date.now(),
    sources: Object.assign({}, base.sources, {
      cdek: { updatedAt: Date.now(), count: points.length, url: URL_CDEK }
    }),
    points: base.points.filter(p => p.carrier !== 'cdek').concat(points)
  };
  PICKUP.save(next);
  console.log('Записано в', PICKUP.FILE);
}

// Разбор вынесен наружу, чтобы его проверял тест: на живой список ходить из
// теста нельзя, а формат чужого XML — ровно то место, где всё и ломается.
module.exports = { parseCdek, unescapeXml, MIN_POINTS };

if (require.main === module) main().catch(e => { console.error(e); process.exit(1); });
