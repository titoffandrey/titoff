'use strict';
/*
 * Приём платежей через CrocoPAY, схема Express.
 * Документация: https://crocopay.tech/developer?type=express
 *
 * Как работает: одним POST мы создаём платёжную ссылку и уводим плательщика на
 * готовую форму CrocoPAY. Реквизиты карт через наш сервер не проходят вовсе —
 * поэтому выбрана Express, а не H2H: там пришлось бы показывать номер чужой
 * карты у себя на странице и опрашивать статус счёта в цикле.
 *
 * Модуль намеренно не знает ни про заказы, ни про хранилище — только HTTP к
 * платёжке и проверка подписи вебхука. Всё, что связывает платёж с заказом,
 * живёт в server.js и lib/db.js, поэтому платёжку можно снять, удалив этот файл
 * и один блок маршрутов.
 *
 * Внешних зависимостей нет — fetch встроен в Node 18+, как в lib/dadata.js.
 */
const crypto = require('crypto');

const API_INITIATE = 'https://crocopay.tech/api/v2/initiate-payment';
const API_HOST = 'crocopay.tech';
// Платёжку ждём дольше, чем подсказки адреса: этот запрос покупатель ждёт
// осознанно, а без ответа оплату вообще не открыть.
const TIMEOUT = 10000;

// Валюты, которые принимает касса (из документации). Список закрытый: чужой код
// касса всё равно отвергнет, а поймать это лучше до запроса.
const CURRENCIES = ['RUB', 'UZS', 'KGS', 'KZT', 'AZN', 'TJS'];
// У всех шести валют два знака после запятой, поэтому множитель один.
// В запросе сумма идёт в основных единицах (5000.00), а в вебхуке — в
// минимальных (500000). На этой асимметрии легко ошибиться в сто раз.
const MINOR = 100;

// Поля подписи и их порядок — ровно как в документации.
const SIGN_FIELDS = ['timestamp', 'subtotal', 'percentage', 'charge_percentage', 'charge_fixed', 'total'];

function trimmed(value) { return String(value == null ? '' : value).trim(); }

// Ключи кассы заданы — можно ходить в платёжку.
function configured(settings) {
  return !!(settings && trimmed(settings.crocopayClientId) && trimmed(settings.crocopayClientSecret));
}

// Оплата показывается покупателю только когда её включили И ключи на месте:
// включённая галочка без ключей давала бы кнопку, которая всегда ошибается.
function enabled(settings) {
  return !!(settings && settings.crocopayEnabled) && configured(settings);
}

function currencyOf(settings) {
  const code = trimmed(settings && settings.crocopayCurrency).toUpperCase();
  return CURRENCIES.includes(code) ? code : 'RUB';
}

// Сумма заказа -> минимальные единицы, как их присылает вебхук.
function toMinor(amount) {
  return Math.round((Number(amount) || 0) * MINOR);
}

// Адрес формы приходит из ответа платёжки, а мы отправляем по нему покупателя,
// поэтому проверяем: только https и только сам crocopay.tech. Иначе подменённый
// или ошибочный ответ увёл бы покупателя куда угодно.
function safeRedirect(value) {
  let url;
  try { url = new URL(String(value || '')); } catch (e) { return ''; }
  if (url.protocol !== 'https:') return '';
  const host = url.hostname.toLowerCase();
  if (host !== API_HOST && !host.endsWith('.' + API_HOST)) return '';
  return url.toString();
}

// Создать платёжную ссылку. Ошибки не бросаем: вызывающий покажет покупателю
// понятное сообщение, а заказ к этому моменту уже записан и не теряется.
async function initiate(settings, params) {
  if (!configured(settings)) return { ok: false, error: 'not_configured' };
  const amount = Number(params && params.amount);
  if (!Number.isFinite(amount) || amount <= 0) return { ok: false, error: 'bad_amount' };

  const form = new URLSearchParams({
    client_id: trimmed(settings.crocopayClientId),
    client_secret: trimmed(settings.crocopayClientSecret),
    // Double в основных единицах валюты, не в копейках.
    amount: amount.toFixed(2),
    currency: currencyOf(settings),
    successUrl: String((params && params.successUrl) || ''),
    cancelUrl: String((params && params.cancelUrl) || ''),
    callbackUrl: String((params && params.callbackUrl) || '')
  });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT);
  if (timer.unref) timer.unref();
  try {
    const res = await fetch(API_INITIATE, {
      method: 'POST',
      signal: controller.signal,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: form.toString()
    });
    const data = await res.json().catch(() => null);
    // У ошибок 403/422 в ответе только message, без status — поэтому решаем по
    // наличию ссылки, а не по коду ответа.
    if (!data || typeof data !== 'object') return { ok: false, error: 'http_' + res.status };
    const url = safeRedirect(data.redirect_url);
    if (!url) return { ok: false, error: trimmed(data.message) || ('http_' + res.status) };
    return { ok: true, url };
  } catch (e) {
    return { ok: false, error: (e && e.name) === 'AbortError' ? 'timeout' : String((e && e.message) || e) };
  } finally {
    clearTimeout(timer);
  }
}

/* ------------------------------ Подпись вебхука ------------------------------ */

// Достать значение поля из тела так, как оно в нём написано. Подпись считается по
// ТЕКСТУ значений, а JSON.parse его теряет: `"0.00000000"` после разбора и
// обратной сборки станет `0`, и HMAC не сойдётся. Число берём литералом как есть,
// строку — раскавычиваем.
function rawToken(raw, key) {
  const rx = new RegExp('"' + key + '"\\s*:\\s*("(?:[^"\\\\]|\\\\.)*"|-?\\d+(?:\\.\\d+)?(?:[eE][-+]?\\d+)?|true|false|null)');
  const m = rx.exec(raw);
  if (!m) return null;
  if (m[1][0] === '"') { try { return JSON.parse(m[1]); } catch (e) { return null; } }
  return m[1];
}

// Строки для HMAC. Их может быть две, и это не перестраховка: в документации
// callback показан и как JSON, и как $_POST (то есть form-data), а charge_fixed в
// одном примере «0», в другом «0.00000000». Обе строки проверяются одним и тем же
// секретом, так что подобрать подпись это не помогает.
function signMessages(body, rawBody) {
  const fromParsed = SIGN_FIELDS
    .map(k => (body && body[k] !== undefined && body[k] !== null) ? String(body[k]) : '')
    .join('|');
  const out = [fromParsed];
  if (rawBody) {
    const raw = SIGN_FIELDS.map(k => rawToken(rawBody, k));
    if (raw.every(v => v !== null)) {
      const joined = raw.join('|');
      if (joined !== fromParsed) out.push(joined);
    }
  }
  return out;
}

// Подтвердить, что вебхук пришёл от CrocoPAY. Подпись покрывает только суммы и
// время, но не заказ, поэтому одной её мало — какой это заказ, решает token в
// адресе callback (см. server.js).
function verify(secret, body, rawBody) {
  const key = trimmed(secret);
  const sign = trimmed(body && body.sign).toLowerCase();
  if (!key || !/^[a-f0-9]{64}$/.test(sign)) return false;
  const given = Buffer.from(sign, 'hex');
  for (const message of signMessages(body, rawBody)) {
    const expected = crypto.createHmac('sha256', key).update(message).digest();
    if (expected.length === given.length && crypto.timingSafeEqual(expected, given)) return true;
  }
  return false;
}

module.exports = { CURRENCIES, MINOR, configured, enabled, currencyOf, toMinor, initiate, verify, safeRedirect };
