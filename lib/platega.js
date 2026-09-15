'use strict';
/*
 * Platega: СБП на платёжной странице сервиса, без выбора других способов.
 * Документация: https://docs.platega.io (сверено 15 сентября 2026).
 *
 * POST /transaction/process с paymentMethod: 2 возвращает transactionId и
 * redirect. Ранее созданные счета v2 без фиксированного способа читаются GET.
 * GET /transaction/{id} возвращает сумму В РУБЛЯХ, валюту и наш payload.
 * Callback авторизуется X-MerchantId + X-Secret и только запускает этот GET.
 *
 * payload — случайный id нашей попытки, без номера заказа и данных покупателя.
 * Документация не обещает идемпотентность POST. Потерянный ответ оставляем
 * неоднозначным: повторять создание нельзя, привязку восстанавливает callback.
 */
const crypto = require('crypto');
const ERR = require('./pay-errors');
const FEE = require('../public/payment-fee');

const API = 'https://app.platega.io';
const METHOD = 'SBP_ONLINE';
const LEGACY_METHOD = 'ONLINE_PAYMENT';
const CURRENCY = 'RUB';
const MINOR = 100;
const CREATE_TIMEOUT = 15000;
const STATUS_TIMEOUT = 8000;
const OPTIONS_TIMEOUT = 4000;
const RESPONSE_MAX = 1024 * 1024;
const UNRESOLVED_START_TTL = 30 * 60 * 1000;
const STATUS = { PENDING: 'pending', CONFIRMED: 'paid', CANCELED: 'cancelled', CHARGEBACKED: 'refunded' };

function trimmed(value) { return typeof value === 'string' ? value.trim() : ''; }
function object(value) { return !!value && typeof value === 'object' && !Array.isArray(value); }
function validInvoiceId(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(trimmed(value));
}
function validMerchantId(value) { return validInvoiceId(value); }
function validExternalId(value) { return typeof value === 'string' && /^[A-Za-z0-9_-]{8,64}$/.test(value); }
function validSecret(value) {
  // Секрет уходит в HTTP-заголовок: перевод строки и управляющие символы
  // запрещены. Алгоритм и длину ключа документация не задаёт.
  return typeof value === 'string' && /^[\x21-\x7e]{1,4096}$/.test(value.trim());
}
function configured(settings) {
  return !!settings && validMerchantId(settings.plategaMerchantId) && validSecret(settings.plategaSecret);
}
function enabled(settings) { return !!(settings && settings.plategaEnabled) && configured(settings); }
function supports(method) { return trimmed(method) === METHOD; }
function storedMethod(method) { return [METHOD, LEGACY_METHOD].includes(trimmed(method)); }
function isSbpMethod(method) { return method === 2 || method === '2' || method === 'SBPQR'; }

// В контракте amount — основные единицы. Не угадываем копейки по величине и
// не округляем третью дробную цифру: иначе отличающаяся сумма станет «той же».
function toMinor(value) {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const raw = String(value);
  if (!/^\d+(?:\.\d{1,2})?$/.test(raw)) return null;
  const parts = raw.split('.');
  const minor = Number(parts[0]) * MINOR + Number((parts[1] || '').padEnd(2, '0'));
  return Number.isSafeInteger(minor) && minor > 0 ? minor : null;
}
function acceptsAmount(amount, currency) {
  return toMinor(amount) !== null && trimmed(currency).toUpperCase() === CURRENCY;
}
function stateOf(value) {
  const key = trimmed(value);
  return Object.prototype.hasOwnProperty.call(STATUS, key) ? STATUS[key] : '';
}

// POST описывает сумму строкой «100 RUB»; GET возвращает объект. Оба формата
// разбираем без округления, поиска чисел внутри произвольного текста и догадок.
function paymentDetails(value) {
  if (object(value)) return value;
  if (typeof value !== 'string') return {};
  const match = /^(\d+(?:\.\d{1,2})?) ([A-Z]{3})$/.exec(value);
  return match ? { amount: match[1], currency: match[2] } : {};
}

function matchesMerchant(settings, data) {
  // В схеме GET встречается опечатка mechantId. Проверяем оба написания,
  // когда сервис прислал владельца, включая ответ на создание платежа.
  return ['mechantId', 'merchantId'].every(field => data[field] === undefined
    || (validMerchantId(data[field])
      && trimmed(data[field]).toLowerCase() === trimmed(settings.plategaMerchantId).toLowerCase()));
}

function safeUrl(value) {
  const raw = trimmed(value);
  if (!raw || raw.length > 2048 || /\s/.test(raw)) return '';
  try {
    const url = new URL(raw);
    return url.protocol === 'https:' && !url.username && !url.password && url.hostname && url.href.length <= 2048
      ? url.href : '';
  } catch (_) { return ''; }
}

// Непустой expiresIn описан как HH:MM:SS, а не Unix-время или число секунд.
// Абсолютный срок вычисляется только при создании; GET его не продлевает.
function expiryMs(value, now = Date.now()) {
  const match = /^(\d{2}):([0-5]\d):([0-5]\d)$/.exec(trimmed(value));
  if (!match) return 0;
  const seconds = Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]);
  return seconds > 0 ? now + seconds * 1000 : 0;
}

async function readJson(response, controller) {
  let text;
  if (response.body && typeof response.body.getReader === 'function') {
    const reader = response.body.getReader();
    const chunks = [];
    let size = 0;
    try {
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        size += part.value.byteLength;
        if (size > RESPONSE_MAX) {
          controller.abort();
          throw new Error('response_too_large');
        }
        chunks.push(Buffer.from(part.value));
      }
      text = Buffer.concat(chunks).toString('utf8');
    } finally { reader.releaseLock(); }
  } else {
    text = await response.text();
    if (Buffer.byteLength(text, 'utf8') > RESPONSE_MAX) throw new Error('response_too_large');
  }
  const data = JSON.parse(text);
  if (!object(data) && !Array.isArray(data)) throw new Error('invalid_response');
  return data;
}

// Таймер охватывает и заголовки, и чтение тела. Redirect запрещён: секреты
// нельзя переслать на адрес из Location. Ошибки и чужое тело не логируем.
async function api(settings, path, body, timeoutMs) {
  if (!configured(settings)) return { ok: false, error: 'not_configured' };
  const creating = body !== undefined;
  const controller = new AbortController();
  let timer, http = 0;
  const deadline = new Promise((resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error('timeout'));
    }, timeoutMs);
    if (timer.unref) timer.unref();
  });
  const request = (async () => {
    const headers = {
      'X-MerchantId': trimmed(settings.plategaMerchantId),
      'X-Secret': trimmed(settings.plategaSecret),
      Accept: 'application/json'
    };
    if (creating) headers['Content-Type'] = 'application/json';
    const response = await fetch(API + path, {
      method: creating ? 'POST' : 'GET', headers,
      ...(creating ? { body: JSON.stringify(body) } : {}),
      redirect: 'error', signal: controller.signal
    });
    http = response.status;
    // Отказ распознаём по HTTP, не по произвольному тексту с сервера. Тело
    // отказа может повторять ключи запроса, поэтому наружу оно не попадает.
    if (!response.ok) {
      if (response.body && typeof response.body.cancel === 'function') {
        response.body.cancel().catch(() => {});
      }
      return {
        ok: false, error: [401, 403].includes(http) ? 'unauthorized' : 'http_' + http,
        http, ambiguous: creating && ![400, 401, 403, 404, 405, 422].includes(http)
      };
    }
    return { ok: true, data: await readJson(response, controller) };
  })();
  try { return await Promise.race([request, deadline]); }
  catch (error) {
    const kind = error && error.message;
    // Только собственные коды: fetch иногда включает адрес и детали запроса
    // в сообщение ошибки, а их нельзя хранить в истории платежа.
    const reason = kind === 'timeout' || (error && error.name === 'AbortError') ? 'timeout'
      : ['invalid_response', 'response_too_large'].includes(kind) || error instanceof SyntaxError ? 'invalid_response'
        : 'network';
    return { ok: false, error: reason, ...(http ? { http } : {}), ambiguous: creating };
  } finally { clearTimeout(timer); }
}

function invoiceView(data) {
  data = object(data) ? data : {};
  const details = paymentDetails(data.paymentDetails);
  const minor = toMinor(details.amount);
  return {
    id: trimmed(data.id), externalId: typeof data.payload === 'string' ? data.payload : '',
    state: stateOf(data.status), amount: minor === null ? null : minor / MINOR,
    currency: trimmed(details.currency).toUpperCase(),
    // Старый ONLINE_PAYMENT не фиксировал способ. Только явное значение СБП
    // доказывает способ нового счёта; прочие ответы пригодны лишь для старых.
    method: isSbpMethod(data.paymentMethod) ? METHOD : LEGACY_METHOD,
    requisite: '', bank: '', owner: '', expiresAt: 0
  };
}

async function createInvoice(settings, params) {
  params = params || {};
  if (!configured(settings)) return { ok: false, error: 'not_configured' };
  const totalMinor = toMinor(params.amount);
  if (totalMinor === null) return { ok: false, error: 'bad_amount' };
  // В новых заказах комиссия уже внутри цены. Четыре знака разрешены только
  // для базы, совпавшей с сохранённым обратным расчётом. Итоги POST/GET ниже
  // по-прежнему проверяются строго до копейки. Старые базы остаются прежними.
  const included = params.feePercent === undefined ? null : FEE.included(totalMinor / MINOR, params.feePercent);
  let baseAmount;
  if (params.feePercent !== undefined) {
    if (!included || included.baseAmount <= 0 || params.baseAmount !== included.baseAmount) return { ok: false, error: 'bad_base_amount' };
    baseAmount = included.baseAmount;
  } else {
    const baseMinor = params.baseAmount === undefined ? totalMinor : toMinor(params.baseAmount);
    if (baseMinor === null || baseMinor > totalMinor) return { ok: false, error: 'bad_base_amount' };
    baseAmount = baseMinor / MINOR;
  }
  const shopExpiry = params.expiresAt === undefined ? 0 : params.expiresAt;
  if (params.expiresAt !== undefined && (typeof shopExpiry !== 'number'
    || !Number.isFinite(shopExpiry) || shopExpiry <= Date.now())) return { ok: false, error: 'bad_expiry' };
  if (trimmed(params.currency).toUpperCase() !== CURRENCY) return { ok: false, error: 'bad_currency' };
  if (!supports(params.method)) return { ok: false, error: 'method_unavailable' };
  const externalId = trimmed(params.externalId);
  if (!validExternalId(externalId)) return { ok: false, error: 'bad_external_id' };
  const returnUrl = safeUrl(params.returnUrl);
  const failedUrl = safeUrl(params.failedUrl === undefined ? params.returnUrl : params.failedUrl);
  if (!returnUrl || !failedUrl) return { ok: false, error: 'bad_return_url' };
  const body = {
    paymentMethod: 2,
    paymentDetails: { amount: baseAmount, currency: CURRENCY },
    description: trimmed(params.description).replace(/[\r\n\t]+/g, ' ').slice(0, 250) || 'Оплата заказа',
    return: returnUrl, failedUrl, payload: externalId
  };
  const startedAt = Date.now();
  const result = await api(settings, '/transaction/process', body, CREATE_TIMEOUT);
  if (!result.ok) return result;
  const data = result.data;
  const details = paymentDetails(data.paymentDetails);
  const providerExpiry = expiryMs(data.expiresIn, startedAt);
  // Сервис может вернуть null: используем только уже установленный магазином
  // срок заказа. Не выдумываем срок кассы и не продлеваем его при повторном GET.
  // Некорректный непустой expiresIn не подменяем сроком магазина.
  const expiresAt = providerExpiry > 0
    ? (shopExpiry ? Math.min(providerExpiry, shopExpiry) : providerExpiry)
    : data.expiresIn === null ? shopExpiry : 0;
  const view = {
    id: trimmed(data.transactionId), externalId,
    state: stateOf(data.status), amount: totalMinor / MINOR,
    currency: CURRENCY, method: METHOD, requisite: safeUrl(data.redirect),
    bank: '', owner: '', expiresAt
  };
  // POST обязан подтвердить выбранный СБП и сумму; доказательством самой
  // оплаты остаётся отдельный GET. Не подменяем redirect старым полем v2 url.
  const failure = !validInvoiceId(view.id) ? 'no_invoice_id'
    : !view.requisite ? 'no_requisite'
      : view.state !== 'pending' ? 'bad_invoice_state'
        : !(view.expiresAt > Date.now()) ? 'bad_expiry'
          : !isSbpMethod(data.paymentMethod) ? 'method_mismatch'
            : !matchesMerchant(settings, data) ? 'merchant_mismatch'
              : data.payload !== undefined && data.payload !== externalId ? 'payload_mismatch'
                : toMinor(details.amount) !== totalMinor ? 'amount_mismatch'
                  : trimmed(details.currency).toUpperCase() !== CURRENCY ? 'currency_mismatch' : '';
  if (failure) return {
    ok: false, error: failure, ambiguous: true,
    ...(validInvoiceId(view.id) ? { invoice: view } : {})
  };
  return { ok: true, invoice: view };
}

async function invoice(settings, id) {
  if (!validInvoiceId(id)) return { ok: false, error: 'bad_invoice_id' };
  const result = await api(settings, '/transaction/' + encodeURIComponent(trimmed(id)), undefined, STATUS_TIMEOUT);
  if (!result.ok) return result;
  if (!matchesMerchant(settings, result.data)) return { ok: false, error: 'merchant_mismatch' };
  const view = invoiceView(result.data);
  if (!validInvoiceId(view.id)) return { ok: false, error: 'no_invoice_id' };
  if (!view.state) return { ok: false, error: 'unknown_status' };
  return { ok: true, invoice: view };
}

function matchesInvoice(expected, actual) {
  expected = expected || {};
  actual = actual || {};
  if (!validInvoiceId(expected.invoiceId) || !validInvoiceId(actual.id)
    || trimmed(expected.invoiceId).toLowerCase() !== trimmed(actual.id).toLowerCase()) return { ok: false, reason: 'invoice_id' };
  const currency = trimmed(expected.currency).toUpperCase();
  if (currency !== CURRENCY || trimmed(actual.currency).toUpperCase() !== currency) return { ok: false, reason: 'currency' };
  const want = toMinor(expected.amount), got = toMinor(actual.amount);
  if (want === null || got === null || got !== want) return { ok: false, reason: 'amount' };
  const externalId = trimmed(expected.externalId || expected.attemptId || expected.id);
  if (!validExternalId(externalId) || !validExternalId(actual.externalId)
    || trimmed(actual.externalId) !== externalId) return { ok: false, reason: 'payload' };
  // Ранее размещённая форма разрешала криптовалюту и другие способы: при
  // сверке такого счёта нельзя задним числом потребовать только СБП.
  if (!storedMethod(expected.method) || !storedMethod(actual.method)
    || (supports(expected.method) && !supports(actual.method))) return { ok: false, reason: 'method' };
  return { ok: true };
}

function sameStartRequest(expected, actual) {
  expected = expected || {};
  actual = actual || {};
  const amount = toMinor(expected.amount);
  return amount !== null && amount === toMinor(actual.amount)
    && storedMethod(expected.method) && trimmed(expected.method) === trimmed(actual.method)
    && trimmed(expected.currency).toUpperCase() === CURRENCY
    && trimmed(actual.currency).toUpperCase() === CURRENCY;
}
function retryableStart() { return false; }

// GET /balance/all проверяет доступ без создания платежа. Сами остатки нам
// не нужны: они не попадают ни в результат, ни в кэш, ни в журнал.
const OPTIONS_TTL = 5 * 60 * 1000;
let optionsCache = null;
let optionsJob = null;
function optionsShape(extra) {
  // Доступ API проверен, но фактическую выдачу СБП подтверждает создание счёта.
  return Object.assign({
    ok: true, currencies: [CURRENCY], byCurrency: { [CURRENCY]: [METHOD] }, options: [METHOD]
  }, extra || {});
}
async function availableOptions(settings) {
  if (!configured(settings)) return { ok: false, error: 'not_configured' };
  const key = crypto.createHash('sha256').update(JSON.stringify([
    trimmed(settings.plategaMerchantId), trimmed(settings.plategaSecret)
  ])).digest('hex');
  if (optionsCache && optionsCache.key === key && Date.now() - optionsCache.at < OPTIONS_TTL) {
    return optionsCache.error ? { ok: false, error: optionsCache.error, cached: true } : optionsShape({ cached: true });
  }
  if (optionsJob && optionsJob.key === key) return optionsJob.job;
  const entry = { key, job: null };
  optionsJob = entry;
  entry.job = (async () => {
    try {
      const result = await api(settings, '/balance/all', undefined, OPTIONS_TIMEOUT);
      const valid = result.ok && Array.isArray(result.data) && result.data.every(balance =>
        object(balance) && typeof balance.amount === 'number' && Number.isFinite(balance.amount)
        && /^[A-Z][A-Z0-9]{2,11}$/.test(trimmed(balance.currency)));
      const error = !result.ok ? result.error : valid ? '' : 'invalid_response';
      if (optionsJob === entry) optionsCache = { key, at: Date.now(), error };
      return error ? { ok: false, error } : optionsShape();
    } finally { if (optionsJob === entry) optionsJob = null; }
  })();
  return entry.job;
}
function forgetMethods() { optionsCache = null; optionsJob = null; }

function headerValue(headers, name) {
  if (!headers || typeof headers !== 'object') return '';
  const entries = Object.entries(headers).filter(([key]) => key.toLowerCase() === name);
  // Дублированный заголовок, массив и склеенный Node заголовок не принимаем.
  return entries.length === 1 && typeof entries[0][1] === 'string' ? entries[0][1] : '';
}
function constantEqual(expected, supplied) {
  // Дайджесты одной длины позволяют выполнить timingSafeEqual и при неверной
  // длине секрета. Оба сравнения выполняются независимо от результата первого.
  const digest = value => crypto.createHash('sha256').update(value).digest();
  return crypto.timingSafeEqual(digest(expected), digest(supplied));
}
function verifyCallback(settings, body, rawBody, headers) {
  if (!configured(settings)) return false;
  const merchant = headerValue(headers, 'x-merchantid');
  const secret = headerValue(headers, 'x-secret');
  const merchantOk = constantEqual(trimmed(settings.plategaMerchantId), merchant);
  const secretOk = constantEqual(trimmed(settings.plategaSecret), secret);
  return !!(merchant && secret && merchantOk && secretOk);
}

// Это только адрес и параметры для сверки. Даже авторизованный callback
// сам не делает заказ оплаченным: сервер затем запрашивает invoice().
function callbackView(body) {
  if (!object(body)) return null;
  if (body.payload !== undefined && typeof body.payload !== 'string') return null;
  const view = invoiceView({
    id: body.id, status: body.status, payload: body.payload,
    paymentDetails: { amount: body.amount, currency: body.currency }
  });
  // payload в уведомлении необязателен. Без него сервер найдёт только уже
  // привязанный invoiceId; восстановление потерянного POST требует payload.
  return validInvoiceId(view.id) && (!view.externalId || validExternalId(view.externalId)) && view.state
    && view.amount !== null && view.currency === CURRENCY ? view : null;
}

module.exports = {
  id: 'platega', name: 'Platega', METHOD, CURRENCY, MINOR,
  unresolvedStartTtl: UNRESOLVED_START_TTL,
  configured, enabled, supports, acceptsAmount, toMinor, stateOf,
  validInvoiceId, validMerchantId, validExternalId, validSecret,
  expiryMs, invoiceView, createInvoice, invoice, matchesInvoice, sameStartRequest,
  retryableStart, availableOptions, forgetMethods, verifyCallback, callbackView,
  startError: ERR.messageOf, startErrorCode: ERR.codeOf
};
