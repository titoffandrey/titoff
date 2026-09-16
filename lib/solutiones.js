'use strict';
/*
 * Solutiones (lk.solutiones.club): касса, которая на заказ выдаёт ССЫЛКУ СБП
 * (`https://qr.nspk.ru/…`) — покупатель открывает её в приложении банка,
 * сумма там уже стоит. Пула чужих реквизитов нет, ничего вводить не надо.
 *
 * ДОКУМЕНТАЦИИ У СЕРВИСА НЕТ — ни страницы, ни OpenAPI, ни llms.txt: в кабинете
 * описаны только два заголовка. Контракт ниже снят с живого API 17 сентября
 * 2026 с боевого сервера (см. docs/SOLUTIONES.md, там же — чем именно и как
 * это проверялось):
 *
 *   GET  /api/v1/me                      → {merchant:{id,name,currency,
 *                                            commissionBps}, apiKey:{publicKey}}
 *   POST /api/v1/payment/create          ← {orderId, amount, currency,
 *                                            description, successUrl, failUrl,
 *                                            callbackUrl}
 *                                        → {id, orderId, status, amount,
 *                                            currency, payUrl, expiresAt,
 *                                            createdAt}
 *   GET  /api/v1/payment/status?id=…     → то же плюс paidAt
 *        /api/v1/payment/status?orderId=…
 *
 * Три вещи, которые нельзя перепутать:
 *   - `amount` В ЗАПРОСЕ — РУБЛИ, В ОТВЕТЕ — КОПЕЙКИ СТРОКОЙ: на «12.34» касса
 *     ответила `"1234"`. Промах тут — ×100 в деньгах, поэтому сверка идёт в
 *     копейках и только по документированному нами же замеру;
 *   - `orderId` ИДЕМПОТЕНТЕН: повторный POST с тем же orderId возвращает тот
 *     же платёж (проверено). Поэтому orderId — id нашей попытки, а потерянный
 *     ответ на создание восстанавливается `status?orderId=` без второго счёта;
 *   - `expiresAt` приходит `null` — срок счёта задаёт магазин (30 минут заказа).
 *
 * Callback: POST JSON на Callback URL, заголовок `X-Webhook-Signature:
 * sha256=<hex>` — HMAC-SHA256 от СЫРОГО тела с секретом `whsec_…` из ЛК,
 * плюс `X-Webhook-Id` и `X-Webhook-Event` (`payment.paid`). Как и у всех
 * касс, уведомление только будит GET: деньгами становится ответ на наш
 * собственный запрос статуса.
 *
 * Комиссия мерчанта (21 %, `commissionBps: 2100` в /me) в сумму покупателя не
 * вмешивается — её касса удерживает из выплаты магазину.
 */
const crypto = require('crypto');
const ERR = require('./pay-errors');

const API = 'https://lk.solutiones.club';
const METHOD = 'SBP_ONLINE';
const CURRENCY = 'RUB';
const MINOR = 100;
const CREATE_TIMEOUT = 15000;
const STATUS_TIMEOUT = 8000;
const OPTIONS_TIMEOUT = 4000;
const RESPONSE_MAX = 256 * 1024;
/* Состояния кассы. Живьём виден только PENDING (и событие `payment.paid`);
 * остальные написания — обычный словарь таких сервисов. Незнакомое слово не
 * угадывается: `stateOf` отдаёт пустую строку, и сверка говорит
 * `unknown_status`, а не «оплачено». */
const STATUS = {
  PENDING: 'pending', NEW: 'pending', CREATED: 'pending', PROCESSING: 'pending', WAITING: 'pending',
  PAID: 'paid', SUCCESS: 'paid', SUCCEEDED: 'paid', COMPLETED: 'paid', CONFIRMED: 'paid',
  EXPIRED: 'expired',
  CANCELED: 'cancelled', CANCELLED: 'cancelled', VOIDED: 'cancelled',
  FAILED: 'failed', FAIL: 'failed', DECLINED: 'failed', REJECTED: 'failed', ERROR: 'failed',
  REFUNDED: 'refunded', CHARGEBACK: 'refunded', CHARGEBACKED: 'refunded'
};

function trimmed(value) { return typeof value === 'string' ? value.trim() : ''; }
function object(value) { return !!value && typeof value === 'object' && !Array.isArray(value); }
// id платежа у кассы — cuid вида `cmu4moyqb000lbsutsakpilig`. Он уходит в
// query статуса, поэтому мусор до него доходить не должен.
function validInvoiceId(value) { return /^[A-Za-z0-9_-]{10,64}$/.test(trimmed(value)); }
function validExternalId(value) { return typeof value === 'string' && /^[A-Za-z0-9_-]{8,64}$/.test(value); }
// Публичный ключ показан в ЛК открыто: `pk_` и hex.
function validKey(value) { return /^pk_[a-f0-9]{8,64}$/i.test(trimmed(value)); }
// Секрет уходит в HTTP-заголовок: без переводов строк и управляющих символов.
function validSecret(value) { return typeof value === 'string' && /^[\x21-\x7e]{16,256}$/.test(value.trim()); }
// Секрет вебхука — `whsec_…` из настроек ЛК. Не обязателен: без него
// уведомления не принимаются (403), а оплата подтверждается фоновым опросом.
function validWebhookSecret(value) { return typeof value === 'string' && /^[\x21-\x7e]{16,256}$/.test(value.trim()); }
function configured(settings) {
  return !!settings && validKey(settings.solutionesApiKey) && validSecret(settings.solutionesApiSecret);
}
function enabled(settings) { return !!(settings && settings.solutionesEnabled) && configured(settings); }
function supports(method) { return trimmed(method) === METHOD; }

// Рубли с двумя знаками → копейки. Без округления третьего знака и без догадок
// по величине: иначе «не та» сумма становилась бы «той же».
function toMinor(value) {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const raw = String(value);
  if (!/^\d+(?:\.\d{1,2})?$/.test(raw)) return null;
  const parts = raw.split('.');
  const minor = Number(parts[0]) * MINOR + Number((parts[1] || '').padEnd(2, '0'));
  return Number.isSafeInteger(minor) && minor > 0 ? minor : null;
}
// Сумма В ОТВЕТЕ кассы — целые копейки строкой («1234»). Число тоже принимаем:
// сервис молодой, формат может поехать, а целое в копейках читается однозначно.
function minorOf(value) {
  const raw = typeof value === 'number' ? String(value) : trimmed(value);
  if (!/^\d{1,15}$/.test(raw)) return null;
  const minor = Number(raw);
  return Number.isSafeInteger(minor) && minor > 0 ? minor : null;
}
function acceptsAmount(amount, currency) {
  return toMinor(amount) !== null && trimmed(currency).toUpperCase() === CURRENCY;
}
function stateOf(value) {
  const key = trimmed(value).toUpperCase();
  return Object.prototype.hasOwnProperty.call(STATUS, key) ? STATUS[key] : '';
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
// Срок из ответа — ISO-дата либо null. Мусор считаем отсутствием срока.
function timeOf(value) {
  if (value === null || value === undefined || value === '') return 0;
  const ms = typeof value === 'number' ? value : Date.parse(trimmed(value));
  return Number.isFinite(ms) && ms > 0 ? ms : 0;
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

/* Один запрос к кассе. Таймер охватывает и заголовки, и чтение тела; redirect
 * запрещён — ключи нельзя переслать на адрес из Location. Тело отказа наружу
 * не попадает: у Zod-ошибок оно повторяет поля запроса, а 401 говорит
 * `unauthorized` — этого хватает и панели, и словарю отказов. */
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
      'X-Api-Key': trimmed(settings.solutionesApiKey),
      'X-Api-Secret': trimmed(settings.solutionesApiSecret),
      Accept: 'application/json'
    };
    if (creating) headers['Content-Type'] = 'application/json';
    const response = await fetch(API + path, {
      method: creating ? 'POST' : 'GET', headers,
      ...(creating ? { body: JSON.stringify(body) } : {}),
      redirect: 'error', signal: controller.signal
    });
    http = response.status;
    if (!response.ok) {
      /* Из тела однозначного отказа читаем ОДНУ строку `error` — только чтобы
       * прогнать её через общий словарь (лимит суммы → `amount`). Наружу
       * уходит узнанный код, не текст. 404 у статуса — «нет такого платежа». */
      let hint = '';
      if ([400, 404, 405, 422].includes(http)) {
        try {
          const data = await readJson(response, controller);
          const message = object(data) && typeof data.error === 'string' ? data.error.slice(0, 300) : '';
          const code = message ? ERR.codeOf(message) : '';
          if (code && code !== 'provider_error') hint = code;
        } catch (_) { hint = ''; }
      } else if (response.body && typeof response.body.cancel === 'function') {
        response.body.cancel().catch(() => {});
      }
      return {
        ok: false,
        error: [401, 403].includes(http) ? 'unauthorized' : http === 404 && !creating ? 'not_found' : 'http_' + http,
        http, ...(hint ? { hint } : {}),
        // 4xx — счёт точно не создан. Остальное двусмысленно: мог создаться.
        ambiguous: creating && ![400, 401, 403, 404, 405, 422].includes(http)
      };
    }
    return { ok: true, data: await readJson(response, controller) };
  })();
  try { return await Promise.race([request, deadline]); }
  catch (error) {
    const kind = error && error.message;
    const reason = kind === 'timeout' || (error && error.name === 'AbortError') ? 'timeout'
      : ['invalid_response', 'response_too_large'].includes(kind) || error instanceof SyntaxError ? 'invalid_response'
        : 'network';
    return { ok: false, error: reason, ...(http ? { http } : {}), ambiguous: creating };
  } finally { clearTimeout(timer); }
}

// Ответ кассы → общий вид счёта, которым живут server.js и lib/db.js.
function invoiceView(data) {
  data = object(data) ? data : {};
  const minor = minorOf(data.amount);
  return {
    id: trimmed(data.id), externalId: typeof data.orderId === 'string' ? data.orderId : '',
    state: stateOf(data.status), amount: minor === null ? null : minor / MINOR,
    currency: trimmed(data.currency).toUpperCase(), method: METHOD,
    way: '', fee: null,
    requisite: safeUrl(data.payUrl), bank: '', owner: '',
    expiresAt: timeOf(data.expiresAt), paidAt: timeOf(data.paidAt)
  };
}

// Что не так с полученным счётом — одним словом; пусто — счёт годится.
function invoiceFailure(view, data, externalId, minor, shopExpiry) {
  return !validInvoiceId(view.id) ? 'no_invoice_id'
    : !view.state ? 'unknown_status'
      : view.state !== 'pending' ? 'bad_invoice_state'
        : !view.requisite ? 'no_requisite'
          : view.externalId !== externalId ? 'payload_mismatch'
            : data.amount !== undefined && minorOf(data.amount) !== minor ? 'amount_mismatch'
              : data.currency !== undefined && view.currency !== CURRENCY ? 'currency_mismatch'
                : !(view.expiresAt > Date.now()) ? 'bad_expiry' : '';
}

async function createInvoice(settings, params) {
  params = params || {};
  if (!configured(settings)) return { ok: false, error: 'not_configured' };
  const minor = toMinor(params.amount);
  if (minor === null) return { ok: false, error: 'bad_amount' };
  if (trimmed(params.currency).toUpperCase() !== CURRENCY) return { ok: false, error: 'bad_currency' };
  if (!supports(params.method)) return { ok: false, error: 'method_unavailable' };
  const externalId = trimmed(params.externalId);
  if (!validExternalId(externalId)) return { ok: false, error: 'bad_external_id' };
  // Срок задаёт магазин: касса отвечает `expiresAt: null`, а показывать
  // покупателю ссылку без конца нельзя — заказ закрывается через полчаса.
  const shopExpiry = params.expiresAt === undefined ? 0 : params.expiresAt;
  if (typeof shopExpiry !== 'number' || !Number.isFinite(shopExpiry) || shopExpiry <= Date.now()) {
    return { ok: false, error: 'bad_expiry' };
  }
  const returnUrl = safeUrl(params.returnUrl);
  if (!returnUrl) return { ok: false, error: 'bad_return_url' };
  /* Адрес уведомления — без query: наш общий маршрут узнаёт попытку по
   * `orderId` из тела и проверяет подпись, а не token в адресе. Хвост
   * `?order=…&token=…`, который server.js собирает для P2P-касс, здесь
   * только осел бы в чужой базе без пользы. */
  let callbackUrl = '';
  const rawCallback = safeUrl(params.callbackUrl);
  if (rawCallback) {
    const url = new URL(rawCallback);
    callbackUrl = url.origin + url.pathname;
  }
  const body = {
    orderId: externalId,
    // Рубли с двумя знаками — строкой: касса принимает и число, но строка не
    // подвержена двоичному округлению.
    amount: (minor / MINOR).toFixed(2), currency: CURRENCY,
    description: trimmed(params.description).replace(/[\r\n\t]+/g, ' ').slice(0, 250) || 'Оплата заказа',
    successUrl: returnUrl, failUrl: returnUrl,
    ...(callbackUrl ? { callbackUrl } : {})
  };
  let result = await api(settings, '/api/v1/payment/create', body, CREATE_TIMEOUT);
  /* Ответ потерян (таймаут, сеть, 5xx) — счёт мог создаться. У этой кассы
   * orderId идемпотентен, и у нас есть ключ: спрашиваем статус ПО НАШЕМУ
   * orderId. Нашёлся — это тот самый счёт, дубля нет. Не нашёлся — оставляем
   * исход двусмысленным: POST мог дойти позже. */
  let recovered = false;
  if (!result.ok && result.ambiguous) {
    const check = await api(settings, '/api/v1/payment/status?orderId=' + encodeURIComponent(externalId), undefined, STATUS_TIMEOUT);
    if (check.ok) { result = check; recovered = true; }
  }
  if (!result.ok) return result;
  const data = result.data;
  const view = invoiceView(data);
  // Свой срок — не позже срока кассы, если она его вдруг прислала.
  view.expiresAt = view.expiresAt > 0 ? Math.min(view.expiresAt, shopExpiry) : shopExpiry;
  view.amount = minor / MINOR;
  const failure = invoiceFailure(view, data, externalId, minor, shopExpiry);
  if (failure) {
    return {
      ok: false, error: failure, ambiguous: true,
      ...(validInvoiceId(view.id) ? { invoice: view } : {})
    };
  }
  return { ok: true, invoice: view, ...(recovered ? { recovered: true } : {}) };
}

async function invoice(settings, id) {
  if (!validInvoiceId(id)) return { ok: false, error: 'bad_invoice_id' };
  const result = await api(settings, '/api/v1/payment/status?id=' + encodeURIComponent(trimmed(id)), undefined, STATUS_TIMEOUT);
  if (!result.ok) return result;
  const view = invoiceView(result.data);
  if (!validInvoiceId(view.id)) return { ok: false, error: 'no_invoice_id' };
  if (!view.state) return { ok: false, error: 'unknown_status' };
  return { ok: true, invoice: view };
}

/* Сверка — строгая, до копейки: касса выдаёт ссылку на нашу сумму, выбирать
 * на ней нечего, и «заплачено иначе» здесь означает не тариф способа, а чужой
 * платёж. Отсюда же `payload`: orderId у кассы обязан быть id попытки. */
function matchesInvoice(expected, actual) {
  expected = expected || {};
  actual = actual || {};
  if (!validInvoiceId(expected.invoiceId) || !validInvoiceId(actual.id)
    || trimmed(expected.invoiceId) !== trimmed(actual.id)) return { ok: false, reason: 'invoice_id' };
  const currency = trimmed(expected.currency).toUpperCase();
  if (currency !== CURRENCY || trimmed(actual.currency).toUpperCase() !== currency) return { ok: false, reason: 'currency' };
  const want = toMinor(expected.amount), got = toMinor(actual.amount);
  if (want === null || got === null || got !== want) return { ok: false, reason: 'amount' };
  const externalId = trimmed(expected.externalId || expected.attemptId || expected.id);
  if (!validExternalId(externalId) || trimmed(actual.externalId) !== externalId) return { ok: false, reason: 'payload' };
  if (!supports(expected.method) || !supports(actual.method)) return { ok: false, reason: 'method' };
  return { ok: true };
}

function sameStartRequest(expected, actual) {
  expected = expected || {};
  actual = actual || {};
  const amount = toMinor(expected.amount);
  return amount !== null && amount === toMinor(actual.amount)
    && supports(expected.method) && trimmed(expected.method) === trimmed(actual.method)
    && trimmed(expected.currency).toUpperCase() === CURRENCY
    && trimmed(actual.currency).toUpperCase() === CURRENCY;
}
// Повтор POST не нужен никогда: отказа «нет реквизитов» у этой кассы не
// бывает, а потерянный ответ восстанавливает сам `createInvoice` по orderId.
function retryableStart() { return false; }

/* Проверка связи — `GET /api/v1/me`: ничего не создаёт, зато отвечает и про
 * ключи (401 — не приняты), и про мерчанта. Сверяем, что публичный ключ в
 * ответе — наш: чужой ответ на наши заголовки означал бы, что перед нами не
 * та касса. Остатки и комиссию наружу не отдаём — панели нужен факт связи. */
const OPTIONS_TTL = 5 * 60 * 1000;
let optionsCache = null;
let optionsJob = null;
function optionsShape(extra) {
  return Object.assign({
    ok: true, currencies: [CURRENCY], byCurrency: { [CURRENCY]: [METHOD] }, options: [METHOD]
  }, extra || {});
}
async function availableOptions(settings) {
  if (!configured(settings)) return { ok: false, error: 'not_configured' };
  const key = crypto.createHash('sha256').update(JSON.stringify([
    trimmed(settings.solutionesApiKey), trimmed(settings.solutionesApiSecret)
  ])).digest('hex');
  if (optionsCache && optionsCache.key === key && Date.now() - optionsCache.at < OPTIONS_TTL) {
    return optionsCache.error ? { ok: false, error: optionsCache.error, cached: true } : optionsShape({ cached: true });
  }
  if (optionsJob && optionsJob.key === key) return optionsJob.job;
  const entry = { key, job: null };
  optionsJob = entry;
  entry.job = (async () => {
    try {
      const result = await api(settings, '/api/v1/me', undefined, OPTIONS_TIMEOUT);
      const data = result.ok ? result.data : null;
      const valid = !!data && object(data.merchant) && object(data.apiKey)
        && trimmed(data.apiKey.publicKey).toLowerCase() === trimmed(settings.solutionesApiKey).toLowerCase()
        && (data.merchant.currency === undefined || trimmed(data.merchant.currency).toUpperCase() === CURRENCY);
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
  // Дублированный заголовок и массив не принимаем: подпись обязана быть одна.
  return entries.length === 1 && typeof entries[0][1] === 'string' ? entries[0][1] : '';
}
/* Подпись вебхука: `X-Webhook-Signature: sha256=<hex>` — HMAC-SHA256 от
 * СЫРОГО тела запроса секретом `whsec_…`. Считается по `req.rawBody`
 * (lib/server-lib.js хранит тело как есть), а не по разобранному JSON:
 * пересобранная строка отличается пробелами, и подпись не сошлась бы никогда.
 * Без секрета в настройках подпись проверить нечем — уведомление отклоняется,
 * оплату подтвердит фоновый опрос. */
function verifyCallback(settings, body, rawBody, headers) {
  if (!configured(settings) || !validWebhookSecret(settings.solutionesWebhookSecret)) return false;
  const raw = typeof rawBody === 'string' ? rawBody : Buffer.isBuffer(rawBody) ? rawBody.toString('utf8') : '';
  if (!raw) return false;
  const header = trimmed(headerValue(headers, 'x-webhook-signature'));
  const match = /^(?:sha256=)?([a-f0-9]{64})$/i.exec(header);
  if (!match) return false;
  const expected = crypto.createHmac('sha256', trimmed(settings.solutionesWebhookSecret)).update(raw, 'utf8').digest('hex');
  return crypto.timingSafeEqual(Buffer.from(expected, 'utf8'), Buffer.from(match[1].toLowerCase(), 'utf8'));
}
/* Тело уведомления не описано: берём поля платежа из корня либо из вложенного
 * объекта (`data`/`payment`). Это только адрес сверки — что именно случилось,
 * скажет GET. Без id платежа адресовать нечего. */
function callbackView(body) {
  if (!object(body)) return null;
  const source = object(body.data) ? body.data : object(body.payment) ? body.payment : body;
  const view = invoiceView(source);
  if (!validInvoiceId(view.id)) return null;
  if (view.externalId && !validExternalId(view.externalId)) return null;
  return view;
}

module.exports = {
  id: 'solutiones', name: 'Solutiones', METHOD, CURRENCY, MINOR, API,
  configured, enabled, supports, acceptsAmount, toMinor, minorOf, stateOf,
  validInvoiceId, validExternalId, validKey, validSecret, validWebhookSecret,
  invoiceView, createInvoice, invoice, matchesInvoice, sameStartRequest,
  retryableStart, availableOptions, forgetMethods, verifyCallback, callbackView,
  startError: ERR.messageOf, startErrorCode: ERR.codeOf
};
