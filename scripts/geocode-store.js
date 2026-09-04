#!/usr/bin/env node
'use strict';
/* Координаты офлайн-точки по её адресу — офлайн-инструмент, а не витрина.
 *
 * Карта на «О компании» рисуется по координатам (`storeGeo` в настройках): без
 * них квартал нарисовать нечем, а геокодера у витрины нет и не будет — каждый
 * такой запрос это поход к чужому сервису, и делать его на открытии страницы
 * покупателем незачем. Поэтому поиск живёт здесь: запустили один раз, число
 * легло в настройки, витрина дальше работает сама.
 *
 *   node scripts/geocode-store.js                 # показать, что нашлось
 *   node scripts/geocode-store.js --apply         # записать в настройки
 *   node scripts/geocode-store.js --query "…"     # искать другую строку
 *
 * Источник — Nominatim (тот же OpenStreetMap, что и тайлы карты). Его правила
 * требуют User-Agent, по которому видно приложение, и не больше запроса в
 * секунду; здесь запрос ровно один на прогон.
 *
 * НАЙДЕННОЕ НАДО ГЛАЗАМИ ПРОВЕРИТЬ: скрипт печатает, что именно он нашёл
 * («ТЦ Ноябрьский, проспект Мира, 88А…»), и на какой это карте. Молча вписать
 * координаты промахнувшегося поиска хуже, чем оставить поле пустым: метка на
 * витрине встанет уверенно и не туда.
 */
const db = require('../lib/db');

const API = 'https://nominatim.openstreetmap.org/search';
const USER_AGENT = 'istore-shop-map/1.0 (self-hosted single-shop map)';
const TIMEOUT = 15000;

function arg(name) {
  const i = process.argv.indexOf(name);
  return i > -1 ? process.argv[i + 1] : '';
}

async function main() {
  const apply = process.argv.includes('--apply');
  const settings = db.getSettings();
  const query = (arg('--query') || settings.storeAddress || '').trim();
  if (!query) {
    console.error('Адрес магазина не задан: заполните «Адрес офлайн-магазина» в настройках или передайте --query "…".');
    process.exit(1);
  }
  console.log('Ищем: ' + query);

  const url = `${API}?format=jsonv2&limit=5&accept-language=ru&q=${encodeURIComponent(query)}`;
  const control = new AbortController();
  const timer = setTimeout(() => control.abort(), TIMEOUT);
  let found;
  try {
    const answer = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
      signal: control.signal
    });
    if (!answer.ok) throw new Error('HTTP ' + answer.status);
    found = await answer.json();
  } catch (e) {
    console.error('Не получилось спросить Nominatim: ' + e.message);
    process.exit(1);
  } finally { clearTimeout(timer); }

  if (!Array.isArray(found) || !found.length) {
    console.error('Ничего не нашлось. Скопируйте координаты руками: в Яндекс.Картах правой кнопкой по точке → «Что здесь?».');
    process.exit(1);
  }
  found.forEach((place, i) => {
    console.log(`${i === 0 ? '→' : ' '} ${Number(place.lat).toFixed(6)}, ${Number(place.lon).toFixed(6)}  ${place.display_name}`);
  });

  const best = found[0];
  const value = `${Number(best.lat).toFixed(6)}, ${Number(best.lon).toFixed(6)}`;
  if (!apply) {
    console.log('\nПредпросмотр. Записать первую строку в настройки: --apply');
    console.log('Проверьте по подписи, что это правда ваш дом: промахнувшийся поиск поставит метку уверенно и не туда.');
    return;
  }
  const next = db.getSettings();
  next.storeGeo = value;
  db.saveSettings(next);
  console.log('\nЗаписано в настройки: storeGeo = ' + value);
}

main();
