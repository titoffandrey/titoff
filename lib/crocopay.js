'use strict';
/*
 * Приём платежей через CrocoPAY, схема H2H (Host-to-Host).
 * Документация: https://crocopay.tech/developer?type=standard
 *
 * Счёт создаём мы сами и сами показываем плательщику реквизиты получателя —
 * покупатель остаётся на витрине. Взамен готовой формы Express, которая была
 * здесь раньше, мы получаем главное: НАСТОЯЩИЙ статус платежа. У Express ручки
 * статуса нет вовсе — вебхук приходит только на успех, и «не оплатил» там
 * неотличим от «ещё не оплатил», заказ висит в ожидании вечно. Здесь есть
 * `GET /invoices/{id}` со статусами Pending / Success / Expired / Cancelled /
 * Failed, прямо предназначенный для опроса.
 *
 * Реквизиты карт покупателя через нас по-прежнему не проходят: это P2P-перевод,
 * покупатель платит из своего банковского приложения по выданным реквизитам.
 * Формы ввода карты и 3-D Secure нет ни в одной из схем этого сервиса.
 *
 * Валюта всегда RUB. Мульти-гео с пересчётом по курсу было свойством формы
 * Express; в H2H валюту и способ выбираем мы, а касса магазина рублёвая.
 *
 * Модуль намеренно не знает ни про заказы, ни про хранилище — только HTTP к
 * платёжке и проверка подписи вебхука. Всё, что связывает платёж с заказом,
 * живёт в server.js и lib/db.js, поэтому платёжку можно снять, удалив этот файл
 * и один блок маршрутов.
 *
 * Внешних зависимостей нет — fetch встроен в Node 18+, как в lib/dadata.js.
 */
const crypto = require('crypto');

const API = 'https://crocopay.tech/api/v2/h2h';
// Платёжку ждём дольше, чем подсказки адреса: этот запрос покупатель ждёт
// осознанно, а без ответа оплату вообще не открыть.
const TIMEOUT = 10000;

// Касса магазина рублёвая, выбора валюты у покупателя нет.
const CURRENCY = 'RUB';
// У рубля два знака после запятой.
const MINOR = 100;

/*
 * ЕДИНИЦЫ СУММЫ — грабля, на которую документация укладывает прямым текстом.
 * Она утверждает, что счёт создаётся в МИНИМАЛЬНЫХ единицах («копейки для RUB»,
 * пример 500000 = 5000.00 RUB). Это неправда. Проверено на боевой кассе
 * 17 августа 2026: на `amount: 10000` она отвечает `"amount":"10000.00000000"`
 * при `"currency":"RUB"` — то есть понимает число как РУБЛИ и хранит его в
 * десятичном поле. Положив туда копейки, мы выставили бы счёт в сто раз больше:
 * на заказ в 239 990 ₽ покупателя просили бы перевести 23 999 000 ₽.
 *
 * Поэтому в счёт сумма идёт в ОСНОВНЫХ единицах, и ожидаемую сумму заказа мы
 * храним такой же. А вот вебхук по документации присылает минимальные
 * (`subtotal: 500000`), и проверить это, не проведя настоящий платёж, нельзя —
 * отсюда `paidEnough()`, который принимает оба прочтения.
 */

// Поля подписи вебхука и их порядок — ровно как в документации. Вебхук в H2H
// такой же, как был в Express: те же поля, тот же HMAC.
const SIGN_FIELDS = ['timestamp', 'subtotal', 'percentage', 'charge_percentage', 'charge_fixed', 'total'];

// Статусы счёта из документации → наши состояния платежа. Незнакомый статус
// даёт пустую строку: лучше оставить заказ как есть, чем угадать.
const STATUS = {
  pending: 'pending',
  success: 'paid',
  expired: 'expired',
  cancelled: 'cancelled',
  canceled: 'cancelled',   // на случай американского написания
  failed: 'failed'
};

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

/*
 * Пределы одного платежа: 1 000 ₽ снизу и 250 000 ₽ сверху.
 *
 * Это ограничение КАССЫ, а не заказа, поэтому сумма за границами не отменяет
 * покупку: такой заказ оформляется прежним путём — обычной заявкой, с которой
 * связывается менеджер (ровно то, что происходит, когда онлайн-оплата вообще не
 * настроена). Иначе Vision Pro за 349 990 ₽, MacBook Pro 16" и Studio Display
 * стало бы нельзя купить в принципе: они дороже потолка уже в базовой сборке, и
 * покупатель упирался бы в отказ, заполнив всю форму.
 *
 * Подсказок про пределы на витрине нет — покупателю нечего с ними делать:
 * сумму заказа задаёт корзина, а не он. Меняется только подпись кнопки
 * («Оформить заказ» вместо «Перейти к оплате»), потому что она обязана говорить
 * правду о следующем шаге.
 */
const MIN_TOTAL = 1000;
const MAX_TOTAL = 250000;

function payable(total) {
  const sum = Number(total);
  return Number.isFinite(sum) && sum >= MIN_TOTAL && sum <= MAX_TOTAL;
}

// Сумма заказа -> минимальные единицы. Счёту это больше не нужно (см. блок про
// единицы выше), но пригождается при разборе вебхука.
function toMinor(amount) {
  return Math.round((Number(amount) || 0) * MINOR);
}

// Хватает ли пришедшей суммы. `expected` — в рублях (как мы её записали при
// старте оплаты), `raw` — то, что прислал вебхук. Единицы вебхука проверить,
// не проведя настоящий платёж, невозможно: документация обещает минимальные, но
// на эндпоинте счёта она уже соврала. Поэтому пробуем оба прочтения и считаем
// оплаченным, если хватает хоть по одному.
//
// Ложного «оплачено» это не создаёт: недоплата мала в обоих прочтениях сразу
// (заплатив 1 000 ₽ за заказ в 239 990, получим 1000 и 10 — оба меньше).
// Переплата законна — при пересчёте по курсу сумма приходит больше рублёвой.
function paidEnough(expected, raw) {
  const want = Number(expected) || 0;
  const got = Number(raw);
  if (!Number.isFinite(got)) return { ok: false, major: null };
  const asMajor = got;
  const asMinor = got / MINOR;
  if (asMajor + 0.01 >= want) return { ok: true, major: asMajor };
  if (asMinor + 0.01 >= want) return { ok: true, major: asMinor };
  return { ok: false, major: asMajor };
}

function stateOf(raw) {
  const key = trimmed(raw).toLowerCase();
  return Object.prototype.hasOwnProperty.call(STATUS, key) ? STATUS[key] : '';
}

// UUID счёта уходит в адрес запроса, поэтому пропускаем только то, что на него
// похоже: чужая строка в пути — это уже запрос неизвестно куда.
function validInvoiceId(id) {
  return /^[A-Za-z0-9][A-Za-z0-9-]{7,63}$/.test(trimmed(id));
}

// `expires_at` приходит строкой ISO. Ноль означает «срок неизвестен» — страница
// оплаты тогда просто не показывает обратный отсчёт.
function expiryMs(value) {
  const ms = Date.parse(trimmed(value));
  return Number.isFinite(ms) ? ms : 0;
}

/* --------------------------------- Запросы --------------------------------- */

// Один вход для всех трёх эндпоинтов. Ошибки не бросаем: вызывающий покажет
// покупателю понятное сообщение, а заказ к этому моменту уже записан.
async function api(settings, path, init) {
  if (!configured(settings)) return { ok: false, error: 'not_configured' };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT);
  if (timer.unref) timer.unref();
  const headers = Object.assign({
    'Client-Id': trimmed(settings.crocopayClientId),
    'Client-Secret': trimmed(settings.crocopayClientSecret),
    Accept: 'application/json'
  }, (init && init.headers) || {});
  try {
    const res = await fetch(API + path, Object.assign({}, init, { signal: controller.signal, headers }));
    const data = await res.json().catch(() => null);
    if (!data || typeof data !== 'object') return { ok: false, error: 'http_' + res.status };
    // У ошибок платёжки в теле лежит message, а код бывает и 200 — поэтому
    // решаем по содержимому, а не только по res.ok.
    if (!res.ok || trimmed(data.status).toLowerCase() === 'error') {
      return { ok: false, error: trimmed(data.message) || ('http_' + res.status), http: res.status };
    }
    return { ok: true, data };
  } catch (e) {
    return { ok: false, error: (e && e.name) === 'AbortError' ? 'timeout' : String((e && e.message) || e) };
  } finally {
    clearTimeout(timer);
  }
}

// Ответ счёта -> плоское представление для заказа и страницы оплаты. Поле `card`
// у платёжки универсальное: там и номер карты, и номер телефона для СБП, и
// строка QR — что именно, говорит выбранный способ оплаты.
// Имена полей берём не только те, что в документации: на эндпоинте способов она
// уже разошлась с живой кассой, поэтому у каждого поля есть запасные написания.
// Промах здесь стоит дорого — покупатель увидит «не удалось выставить счёт» на
// ровном месте.
function pick(data, keys) {
  for (const k of keys) {
    const v = data && data[k];
    if (v !== undefined && v !== null && trimmed(v) !== '') return trimmed(v);
  }
  return '';
}
// Похоже ли значение на платёжного адресата: номер карты, телефон или ссылка.
// Имён полей внутри `paymentRequisites` документация не описывает вовсе (там
// вообще другой формат ответа), поэтому кроме известных имён есть и перебор по
// виду значения. Название банка и имя получателя под это не попадают — они
// словами, а не цифрами.
function looksLikeRequisite(value) {
  const v = trimmed(value);
  if (/^https?:\/\/\S+$/i.test(v)) return true;
  return /^[0-9+][0-9 +*()-]{7,}$/.test(v);
}
function findRequisite(box) {
  if (!box || typeof box !== 'object') return '';
  const known = pick(box, ['card', 'cardNumber', 'card_number', 'requisite', 'account',
    'accountNumber', 'phone', 'phoneNumber', 'number', 'wallet', 'qr', 'url', 'link', 'value']);
  if (looksLikeRequisite(known)) return known;
  for (const k of Object.keys(box)) {
    const v = box[k];
    if (v && typeof v === 'object') {
      const deep = findRequisite(v);
      if (deep) return deep;
    } else if (looksLikeRequisite(v)) return trimmed(v);
  }
  return known;                            // ничего похожего — отдадим что есть
}

// Живой ответ кассы (проверено 17 августа 2026) устроен так:
//   POST /invoices -> {message, response:{transaction:{id,status,currency,amount,
//                      expiredAt}, paymentRequisites:{paymentOption,paymentMethod,…}}}
//   GET  /invoices/{id} -> {message, transaction:{id,status,currency,amount,expiredAt}}
// В документации вместо этого показан плоский объект со snake_case. Читаем оба:
// раз формат уже разошёлся дважды, полагаться на одно написание нельзя.
function invoiceView(raw) {
  const root = (raw && typeof raw === 'object' && (raw.response || raw.data)) || raw || {};
  const tx = (root && typeof root === 'object' && (root.transaction || root.invoice)) || root || {};
  const req = (root && typeof root === 'object' && (root.paymentRequisites || root.requisites)) || tx || {};
  return {
    id: pick(tx, ['id', 'invoice_id', 'invoiceId', 'uuid']),
    state: stateOf(pick(tx, ['status', 'state'])),
    amount: Number(pick(tx, ['amount', 'total'])) || 0,
    currency: pick(tx, ['currency']).toUpperCase() || CURRENCY,
    // Касса вправе подменить способ: на запрос TO_CARD она вернула
    // TO_CARD_TRANSGRAN. Записывать надо тот, что пришёл.
    method: pick(req, ['paymentOption', 'payment_option', 'method', 'code'])
      || pick(tx, ['paymentOption', 'payment_option']),
    requisite: findRequisite(req),
    bank: pick(req, ['bank_receiver', 'bankReceiver', 'bank', 'bankName', 'paymentMethod']),
    owner: pick(req, ['card_owner', 'cardOwner', 'owner', 'receiver', 'holder', 'fio']),
    expiresAt: expiryMs(pick(tx, ['expiredAt', 'expires_at', 'expire_at', 'expired_at', 'expires']))
  };
}

// Эндпоинт 1 — создать счёт. Сумма в ОСНОВНЫХ единицах (см. блок про единицы
// выше), способ оплаты проверен вызывающим по закрытому списку lib/pay-methods.js.
async function createInvoice(settings, params) {
  const amount = Math.round((Number(params && params.amount) || 0) * MINOR) / MINOR;
  if (!Number.isFinite(amount) || amount <= 0) return { ok: false, error: 'bad_amount' };
  const method = trimmed(params && params.method);
  if (!method) return { ok: false, error: 'bad_method' };

  const r = await api(settings, '/invoices', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      amount,
      currency: CURRENCY,
      payment_option: method,
      // GET-параметры этого адреса платёжка сохраняет и вернёт в вебхуке —
      // только по ним и понятно, о каком заказе речь (см. server.js).
      callback_url: String((params && params.callbackUrl) || '')
    })
  });
  if (!r.ok) return r;
  const view = invoiceView(r.data);
  // Счёт без id или без реквизитов показывать нечем. Ключи ответа пишем в лог:
  // формат кассы уже расходился с документацией, и без этой строки разбираться
  // пришлось бы вслепую (значения не пишем — это чужие платёжные реквизиты).
  if (!validInvoiceId(view.id) || !view.requisite) {
    console.error('crocopay invoice: ответ без', validInvoiceId(view.id) ? 'реквизитов' : 'id',
      '— ключи:', Object.keys((r.data && (r.data.response || r.data)) || {}).join(','));
    return { ok: false, error: validInvoiceId(view.id) ? 'no_requisite' : 'no_invoice_id' };
  }
  // Касса возвращает сумму счёта эхом. Разошлась с нашей — значит она поняла
  // запрос иначе, и показывать покупателю такие реквизиты нельзя: он переведёт
  // не ту сумму, и платёж не сойдётся.
  if (view.amount && Math.abs(view.amount - amount) > 0.01) {
    console.error('crocopay invoice: касса вернула сумму', view.amount, 'вместо', amount);
    return { ok: false, error: 'amount_mismatch' };
  }
  return { ok: true, invoice: view };
}

// Эндпоинт 2 — статус счёта. Ради него всё и затевалось.
async function invoice(settings, id) {
  if (!validInvoiceId(id)) return { ok: false, error: 'bad_invoice_id' };
  const r = await api(settings, '/invoices/' + encodeURIComponent(trimmed(id)));
  if (!r.ok) return r;
  return { ok: true, invoice: invoiceView(r.data) };
}

// Эндпоинт 3 — что реально включено у кассы. Список меняется редко, а спрашивают
// его на каждой странице оплаты, поэтому держим короткий кэш. Ключ — client_id:
// сменили кассу в настройках, и ответ прежней уже не годится.
const _methods = { key: '', at: 0, options: null };
const METHODS_TTL = 5 * 60 * 1000;

// Разбор ответа. Документация и живая касса тут РАСХОДЯТСЯ, поэтому понимаем оба
// вида. В документации это плоский список
//   {methods:[{currency:'RUB', payment_option:'TO_CARD'}]},
// а живая касса отвечает сгруппированно по валюте
//   {payment_methods:[{code:'RUB', options:[{code:'TO_CARD'}]}]}.
// Проверено на боевой кассе 17 августа 2026: приходит второй вид.
function parseOptions(data) {
  const options = [];
  const add = code => {
    const option = trimmed(code);
    if (option && !options.includes(option)) options.push(option);
  };
  const groups = Array.isArray(data && data.payment_methods) ? data.payment_methods : [];
  for (const g of groups) {
    if (!g || typeof g !== 'object') continue;
    // Касса бывает мульти-валютной; нам нужна только рублёвая группа.
    if (trimmed(g.code || g.currency).toUpperCase() !== CURRENCY) continue;
    for (const o of (Array.isArray(g.options) ? g.options : [])) {
      if (o && typeof o === 'object') add(o.code || o.payment_option);
    }
  }
  const flat = Array.isArray(data && data.methods) ? data.methods : [];
  for (const m of flat) {
    if (!m || typeof m !== 'object') continue;
    if (trimmed(m.currency || m.code).toUpperCase() !== CURRENCY) continue;
    add(m.payment_option || m.code);
  }
  return options;
}

async function availableOptions(settings) {
  const key = trimmed(settings && settings.crocopayClientId);
  if (_methods.options && _methods.key === key && Date.now() - _methods.at < METHODS_TTL) {
    return { ok: true, options: _methods.options, cached: true };
  }
  const r = await api(settings, '/payment-method/available');
  if (!r.ok) return r;
  const options = parseOptions(r.data);
  // Ответ есть, а способов ноль — либо у кассы правда ничего не включено, либо
  // формат ответа снова поменялся. Второе видно только в логе, поэтому пишем
  // ключи ответа: без этого «оплатить нечем» не отличить от ошибки разбора.
  if (!options.length) console.error('crocopay methods: пустой список, ключи ответа —', Object.keys(r.data || {}).join(','));
  _methods.key = key;
  _methods.at = Date.now();
  _methods.options = options;
  return { ok: true, options };
}

// Сбросить кэш способов — нужен после смены ключей кассы в панели владельца.
function forgetMethods() { _methods.key = ''; _methods.at = 0; _methods.options = null; }

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

module.exports = {
  CURRENCY, MINOR, MIN_TOTAL, MAX_TOTAL, payable, configured, enabled, toMinor, paidEnough, stateOf, validInvoiceId,
  createInvoice, invoice, availableOptions, forgetMethods, verify
};
