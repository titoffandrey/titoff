'use strict';
/*
 * Приём платежей через MeridianPay, схема H2H (Host-to-Host).
 * Документация: https://p2p-white-label.gitbook.io/meridianpay-api
 *
 * Вторая касса рядом с CrocoPAY. Покупатель про неё не знает и знать не должен:
 * он выбирает способ оплаты, а какая платёжка выдаст реквизиты — решает
 * lib/payments.js (первая отказала — сразу спрашиваем вторую). Поэтому модуль
 * отвечает ровно тем же контрактом, что и lib/crocopay.js:
 *
 *   configured / enabled / supports / availableOptions
 *   createInvoice -> {ok, invoice:{id,state,amount,currency,method,requisite,…}}
 *   invoice(id)   -> то же самое по уже созданному счёту
 *   matchesInvoice / sameStartRequest / retryableStart
 *
 * Как и у CrocoPAY, это P2P: покупатель переводит деньги из своего банковского
 * приложения по выданным реквизитам. Формы ввода карты у сервиса нет вовсе.
 *
 * ЧТО ПРОВЕРЕНО НА ЖИВОМ API 23 августа 2026 (документация врёт трижды):
 *
 *  1. Базовый путь — `https://meridianpay.top/api`, и методы дописываются к нему
 *     БЕЗ второго `/api`. В документации список валют указан как
 *     `GET /api/api/currencies`; такой адрес отвечает 404
 *     («The route api/api/currencies could not be found»), рабочий —
 *     `https://meridianpay.top/api/currencies`.
 *  2. Единицы суммы РАЗНЫЕ на входе и на выходе. В запросе `amount` — целое
 *     число ОСНОВНЫХ единиц («100 = 100 rub»), а в ответе тот же заказ приходит
 *     как `"amount": 123400` с подписью «сумма в копейках». В callback он снова
 *     в рублях. Это ровно та грабля, на которой стоит весь разбор ниже.
 *  3. Ошибки приходят ПО-РУССКИ и с HTTP 400: `{"success":false,"message":
 *     "Мерчант находится на модерации."}`. У CrocoPAY они английские, поэтому
 *     словарь отказов общий и знает оба языка (lib/pay-errors.js).
 *
 * Внешних зависимостей нет — fetch встроен в Node 18+.
 */
const crypto = require('crypto');
const ERR = require('./pay-errors');

const API = 'https://meridianpay.top/api';
// Те же числа, что у CrocoPAY: покупатель ждёт этот запрос осознанно, а без
// ответа оплату вообще не открыть. POST ждём дольше и НЕ повторяем по таймауту —
// касса могла создать сделку, а ответ потеряться.
const TIMEOUT = 10000;
const CREATE_TIMEOUT = 25000;
// Список способов — не критический путь: без него страница оплаты честно
// показывает разрешённое владельцем, а настройки — встроенный список с
// оговоркой. Поэтому ждём его вчетверо меньше, чем счёт (тот же 4 с, что у
// подсказок адреса в lib/dadata.js). С двумя кассами это уже не мелочь: их
// спрашивают параллельно, и зависшая любая держала бы страницу оплаты все
// десять секунд — ровно там, где покупатель нетерпеливее всего.
const OPTIONS_TIMEOUT = 4000;


const CURRENCY = 'RUB';
const MINOR = 100;

// Статусы сделки: pending / success / fail — и всё. Отдельного «истёк» у
// MeridianPay нет вовсе, хотя `expires_at` она возвращает: сгоревший счёт так и
// висит `pending`. Это не проблема — «истёк» на витрине и в панели считается по
// времени (`R.payLive`), ровно как у просроченного счёта CrocoPAY.
const STATUS = { pending: 'pending', success: 'paid', fail: 'failed' };

/* ------------------------- Способ оплаты -> параметры -------------------------
 *
 * У CrocoPAY способ — это один код (`payment_option`), у MeridianPay — набор из
 * трёх полей: тип реквизита, банк и признак трансграничности. Наши id способов
 * (`lib/pay-methods.js`) исторически совпадают с кодами CrocoPAY и лежат в уже
 * оформленных заказах, поэтому менять их нельзя — вместо этого здесь таблица
 * перевода.
 *
 * `transgran` ставится ЯВНО, а не опускается: документация обещает, что `false`
 * оставляет только российские реквизиты, а `true` — только трансграничные. Не
 * передать поле значит «любые», а это как раз та подмена маршрута, на которой мы
 * уже обожглись с CrocoPAY (просили TO_CARD — получили TO_CARD_TRANSGRAN).
 *
 * `gateway` — код банка из живого списка (`GET /payment-gateways`, 906 шлюзов).
 * Он проверяется по этому списку перед показом способа: банк могли отключить, и
 * предлагать покупателю заведомо нерабочую кнопку незачем.
 *
 * `selfBank` — внутрибанковский перевод. Ровно это и значит «если платите из
 * Т-Банка»: сделка создаётся только на реквизиты, отмеченные трейдером как
 * внутрибанковские, и только в указанном банке (тогда `gateway` обязателен).
 */
const MAP = {
  SBP: { detail: 'phone', transgran: false },
  TO_CARD: { detail: 'card', transgran: false },
  QR_NSPK: { detail: 'nspk', transgran: false },
  SBP_TBANK: { detail: 'phone', transgran: false, gateway: 'tbank_rub', selfBank: true },
  SBP_ALFA: { detail: 'phone', transgran: false, gateway: 'alfabank_rub', selfBank: true },
  TO_CARD_TRANSGRAN: { detail: 'card', transgran: true },
  SBP_TRANSGRAN: { detail: 'phone', transgran: true },
  TRANSGRAN_SBER: { detail: 'phone', transgran: true, gateway: 'sberbank_rub' },
  TRANSGRAN_ALFA: { detail: 'card', transgran: true, gateway: 'alfabank_rub' },
  TRANSGRAN_VTB: { detail: 'card', transgran: true, gateway: 'vtb_rub' },
  TRANSGRAN_TPAY: { detail: 'card', transgran: true, gateway: 'tbank_rub' },
  TRANSGRANCARD_TJS: { detail: 'card', transgran: true }
};

/* Какие `detail_type` в ответе считаем подтверждением запрошенного.
 *
 * Сверять строку в строку нельзя: у ПСБ рядом с `nspk` живёт ещё и `qr`, и
 * ответ на запрос НСПК законно приходит любым из них. А вот `card` вместо
 * `phone` — это уже другой способ, и такой счёт мы не показываем.
 */
const ACCEPT = { card: ['card'], phone: ['phone', 'sim'], nspk: ['nspk', 'qr'] };

function trimmed(value) { return String(value == null ? '' : value).trim(); }

/* ------------------------------- Настройки ------------------------------- */

// Ключи заданы — можно ходить в кассу. `merchant_id` обязателен наравне с
// ключом: без него `POST /h2h/order` не примет ни одной сделки.
function configured(settings) {
  return !!(settings && trimmed(settings.meridianpayApiKey) && validMerchantId(settings.meridianpayMerchantId));
}
function enabled(settings) {
  return !!(settings && settings.meridianpayEnabled) && configured(settings);
}
// UUID мерчанта уходит в тело запроса и должен быть именно UUID: чужая строка
// там — это запрос от имени неизвестно кого.
function validMerchantId(id) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(trimmed(id));
}
// `order_id` уходит в АДРЕС запроса статуса, поэтому пропускаем только UUID.
function validInvoiceId(id) {
  return validMerchantId(id);
}
// `external_id` — наш идентификатор попытки. Он обязан быть уникальным у
// мерчанта, и id попытки (12 случайных байт) это обеспечивает.
function validExternalId(id) { return /^[A-Za-z0-9_-]{8,64}$/.test(trimmed(id)); }

/* --------------------------------- Запросы --------------------------------- */

// Один вход на все методы. Ошибки не бросаем — вызывающий покажет покупателю
// понятную фразу, а заказ к этому моменту уже записан.
async function api(settings, path, init, timeoutMs) {
  if (!configured(settings)) return { ok: false, error: 'not_configured' };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Number(timeoutMs) || TIMEOUT);
  if (timer.unref) timer.unref();
  const headers = Object.assign({
    'Access-Token': trimmed(settings.meridianpayApiKey),
    Accept: 'application/json'
  }, (init && init.headers) || {});
  try {
    const res = await fetch(API + path, Object.assign({}, init, { signal: controller.signal, headers }));
    const data = await res.json().catch(() => null);
    if (!data || typeof data !== 'object') return { ok: false, error: 'http_' + res.status };
    // Конверт у кассы один на всё: {success:true,data:…} либо
    // {success:false,message:"…"}. Решаем по нему, а не только по коду ответа.
    if (!res.ok || data.success === false) {
      return { ok: false, error: trimmed(data.message) || ('http_' + res.status), http: res.status };
    }
    return { ok: true, data: data.data === undefined ? data : data.data };
  } catch (e) {
    return { ok: false, error: (e && e.name) === 'AbortError' ? 'timeout' : String((e && e.message) || e) };
  } finally {
    clearTimeout(timer);
  }
}

function pick(box, keys) {
  for (const k of keys) {
    const v = box && box[k];
    if (v !== undefined && v !== null && trimmed(v) !== '') return trimmed(v);
  }
  return '';
}

/* Реквизит для показа покупателю.
 *
 * `payment_detail.detail` универсально: там и номер карты, и телефон для СБП, и
 * — у НСПК — сам QR-код КАРТИНКОЙ в base64 (`data:image/jpeg;base64,…`).
 * Картинку в реквизит отдавать нельзя: она уедет в `href` кнопки и в
 * «скопировать», а покупателю нужен адрес платёжной страницы. Поэтому у НСПК
 * берём `qr_code_link` (https://qr.nspk.ru/…), и только если его нет — отказ.
 *
 * Всё, что не похоже на карту, телефон или http(s)-ссылку, отбрасываем
 * (fail-closed): чужая строка в `href` — это готовый XSS через `javascript:`,
 * и правило здесь то же, что в lib/crocopay.js.
 */
function looksLikeRequisite(value) {
  const v = trimmed(value);
  if (/^https?:\/\/\S+$/i.test(v)) return true;
  return /^[0-9+][0-9 +*()-]{7,}$/.test(v);
}
function requisiteOf(detail, type) {
  if (!detail || typeof detail !== 'object') return '';
  if (type === 'nspk' || type === 'qr') {
    const link = pick(detail, ['qr_code_link', 'qr_code_url']);
    return looksLikeRequisite(link) ? link : '';
  }
  const raw = pick(detail, ['detail', 'requisite', 'card', 'phone', 'account_number']);
  return looksLikeRequisite(raw) ? raw : '';
}

/* Срок действия реквизита.
 *
 * `expires_at` и `current_server_time` приходят в СЕКУНДАХ unix. Считаем остаток
 * по часам КАССЫ (`expires_at - current_server_time`) и прикладываем к своим:
 * так расхождение часов между нашим сервером и её не превращается в счёт,
 * который у нас уже истёк или, наоборот, живёт лишние минуты. Нет
 * `current_server_time` — берём абсолютное значение, как есть.
 */
function expiryMs(data) {
  const until = Number(data && data.expires_at) || 0;
  if (!Number.isFinite(until) || until <= 0) return 0;
  const theirNow = Number(data && data.current_server_time) || 0;
  if (Number.isFinite(theirNow) && theirNow > 0) {
    const left = (until - theirNow) * 1000;
    return left > 0 ? Date.now() + left : 0;
  }
  return until * 1000;
}

function stateOf(raw) {
  const key = trimmed(raw).toLowerCase();
  return Object.prototype.hasOwnProperty.call(STATUS, key) ? STATUS[key] : '';
}

/* Ответ кассы -> плоский вид, общий с CrocoPAY.
 *
 * СУММА ЗДЕСЬ В КОПЕЙКАХ. Это единственное место, где происходит деление, и
 * применяется оно ТОЛЬКО к ответам POST/GET: у callback тот же `amount` уже в
 * рублях, и его мы не разбираем вовсе (см. verifyCallback ниже) — сверка всегда
 * идёт отдельным GET.
 */
function invoiceView(raw) {
  const data = (raw && typeof raw === 'object' && (raw.data || raw)) || {};
  const detail = (data.payment_detail && typeof data.payment_detail === 'object') ? data.payment_detail : {};
  const type = pick(detail, ['detail_type']).toLowerCase();
  return {
    id: pick(data, ['order_id']),
    externalId: pick(data, ['external_id']),
    state: stateOf(pick(data, ['status'])),
    amount: Math.round(Number(data.amount) || 0) / MINOR,
    // Пустую валюту не подменяем рублём: при сверке отсутствие поля обязано быть
    // несовпадением, а не молчаливым подтверждением рублёвого счёта.
    currency: pick(data, ['currency']).toUpperCase(),
    method: type,
    requisite: requisiteOf(detail, type),
    // Название банка — то, что покупатель увидит рядом с реквизитом. Регионом
    // его НЕ подменяем: строка «Банк получателя: Россия» хуже, чем отсутствие
    // строки, а пустое значение `payRow()` просто не рисует.
    bank: pick(data, ['payment_gateway']),
    gateway: pick(data, ['payment_gateway_code']),
    owner: pick(detail, ['initials']),
    region: pick(detail, ['region']),
    expiresAt: expiryMs(data),
    // Не проверяем и ни на что не влияет — храним для разбора спорных платежей
    // (алгоритм не описан в документации вовсе, см. verifyCallback).
    integrity: pick(data, ['integrity'])
  };
}

/* --------------------------- Что включено у кассы --------------------------- */

// Список банков меняется редко, а спрашивают его на каждой странице оплаты.
// Ключ кэша — сам API-ключ: сменили кассу в настройках, и прежний ответ не годится.
const _gateways = { key: '', at: 0, live: null };
const GATEWAYS_TTL = 5 * 60 * 1000;

/* Из 906 банков собираем то, что нужно витрине: какие НАШИ способы оплаты
 * доступны в какой валюте. Наружу отдаём тот же вид, что и CrocoPAY
 * (`{currencies, byCurrency}`), поэтому вызывающий не различает кассы.
 *
 * Кроме способов запоминаем потолок суммы: у большинства рублёвых шлюзов он
 * 300 000, но встречаются и 100 000. Ниже он нужен, чтобы не предлагать кассу
 * на заказ, который она заведомо не проведёт.
 */
function parseGateways(list) {
  const byCurrency = {};
  const limits = {};
  const seen = {};                       // валюта -> {код банка: типы реквизитов}
  for (const g of (Array.isArray(list) ? list : [])) {
    if (!g || typeof g !== 'object') continue;
    const cur = trimmed(g.currency).toUpperCase();
    if (!/^[A-Z]{3}$/.test(cur)) continue;
    const code = trimmed(g.code);
    const types = Array.isArray(g.detail_types) ? g.detail_types.map(t => trimmed(t).toLowerCase()) : [];
    if (!code || !types.length) continue;
    if (!seen[cur]) seen[cur] = {};
    seen[cur][code] = types;
    const max = Number(g.max_limit) || 0;
    const min = Number(g.min_limit) || 0;
    if (!limits[cur]) limits[cur] = { min: Infinity, max: 0 };
    if (min > 0) limits[cur].min = Math.min(limits[cur].min, min);
    if (max > 0) limits[cur].max = Math.max(limits[cur].max, max);
  }
  for (const cur of Object.keys(seen)) {
    const banks = seen[cur];
    const anyType = type => Object.keys(banks).some(code => banks[code].includes(type));
    const ids = [];
    for (const id of Object.keys(MAP)) {
      const m = MAP[id];
      // Способ с привязкой к банку доступен, только если этот банк реально есть
      // в живом списке и умеет нужный тип реквизита.
      const ok = m.gateway
        ? (banks[m.gateway] || []).includes(m.detail)
        : anyType(m.detail);
      if (ok) ids.push(id);
    }
    if (ids.length) byCurrency[cur] = ids;
    if (limits[cur] && limits[cur].min === Infinity) limits[cur].min = 0;
  }
  const currencies = Object.keys(byCurrency)
    .sort((a, b) => (a === CURRENCY ? -1 : b === CURRENCY ? 1 : 0));
  return { currencies, byCurrency, limits };
}

async function availableOptions(settings) {
  const key = trimmed(settings && settings.meridianpayApiKey);
  const shape = live => ({
    ok: true, currencies: live.currencies, byCurrency: live.byCurrency,
    limits: live.limits, options: live.byCurrency[CURRENCY] || []
  });
  if (_gateways.live && _gateways.key === key && Date.now() - _gateways.at < GATEWAYS_TTL) {
    return Object.assign(shape(_gateways.live), { cached: true });
  }
  const r = await api(settings, '/payment-gateways', null, OPTIONS_TIMEOUT);
  if (!r.ok) return r;
  const live = parseGateways(r.data);
  if (!live.currencies.length) {
    console.error('meridianpay gateways: пустой список, банков в ответе —',
      Array.isArray(r.data) ? r.data.length : 'не массив');
  }
  _gateways.key = key;
  _gateways.at = Date.now();
  _gateways.live = live;
  return shape(live);
}

function forgetMethods() { _gateways.key = ''; _gateways.at = 0; _gateways.live = null; }

// Умеет ли эта касса такой способ вообще. Незнакомый код (CrocoPAY включила у
// себя новый `payment_option`) сюда не попадает — и правильно: перевести его в
// параметры MeridianPay нечем, такой способ обслужит только CrocoPAY.
function supports(methodId) {
  return Object.prototype.hasOwnProperty.call(MAP, trimmed(methodId));
}

/*
 * Возьмётся ли касса за такую сумму — спрашивается ДО создания попытки.
 *
 * Без этого получалась ложь в статистике: `createInvoice()` отбивает дробную
 * сумму по `bad_amount` мгновенно, ни разу не сходив в сеть, — а в истории
 * заказа уже лежала бы попытка, и в таблице «Кассы» она считалась бы ОТКАЗОМ
 * MeridianPay. Касса при этом запроса даже не видела.
 *
 * Дробные суммы берутся не из воздуха: счёт в валюте считается по курсу
 * владельца (51 600 ₽ / 90 = 573.33 $), а MeridianPay принимает только целое
 * число основных единиц. В рублях сумма заказа всегда целая, поэтому на
 * обычной витрине это сито не срабатывает ни разу.
 *
 * Заодно проверяем потолок и минимум по живому списку банков — данные уже
 * собраны `parseGateways()`, и не воспользоваться ими значило бы держать их зря.
 */
function acceptsAmount(amount, currency, live) {
  const sum = Number(amount);
  if (!Number.isFinite(sum) || sum <= 0 || !Number.isInteger(sum)) return false;
  const cur = trimmed(currency).toUpperCase() || CURRENCY;
  const limit = live && live.limits && live.limits[cur];
  if (!limit) return true;                 // касса не ответила — её условие не применяем
  if (limit.max > 0 && sum > limit.max) return false;
  if (limit.min > 0 && sum < limit.min) return false;
  return true;
}

/* ------------------------------ Создание счёта ------------------------------ */

/*
 * `is_floating_amount` ВСЕГДА false, и это не перестраховка. Документация
 * обещает, что при `true` касса сама увеличит сумму сделки, если под текущую не
 * нашлось трейдера. Для магазина это означало бы, что покупателя просят
 * перевести не ту сумму, которую он видел в заказе, — и сверка платежа перестала
 * бы сходиться. Лучше отказ и переход на вторую кассу.
 */
async function createInvoice(settings, params) {
  const amount = Number(params && params.amount);
  // Касса принимает ТОЛЬКО целое число основных единиц. Дробная сумма (такое
  // бывает после пересчёта в валюту счёта по курсу владельца) для неё не годится
  // вовсе — пусть её обслужит другая касса.
  if (!Number.isFinite(amount) || amount <= 0 || !Number.isInteger(amount)) {
    return { ok: false, error: 'bad_amount' };
  }
  const method = trimmed(params && params.method);
  const route = MAP[method];
  if (!route) return { ok: false, error: 'method_unavailable' };
  const currency = trimmed(params && params.currency).toUpperCase() || CURRENCY;
  if (!/^[A-Z]{3}$/.test(currency)) return { ok: false, error: 'bad_currency' };
  const externalId = trimmed(params && params.externalId);
  if (!validExternalId(externalId)) return { ok: false, error: 'bad_external_id' };

  const body = {
    merchant_id: trimmed(settings.meridianpayMerchantId),
    external_id: externalId,
    amount,
    // GET-параметры этого адреса касса сохраняет и вернёт нам в callback —
    // только по ним и понятно, о какой попытке какого заказа речь.
    callback_url: String((params && params.callbackUrl) || ''),
    payment_detail_type: route.detail,
    currency: currency.toLowerCase(),
    is_floating_amount: false,
    is_transgran: !!route.transgran
  };
  if (route.gateway) body.payment_gateway = route.gateway;
  if (route.selfBank) body['self-bank'] = true;

  const r = await api(settings, '/h2h/order', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  }, CREATE_TIMEOUT);
  if (!r.ok) return r;

  const view = invoiceView(r.data);
  // Счёт без id или без реквизита показывать нечем. Значения в лог не пишем —
  // это чужие платёжные реквизиты; пишем только состав ответа.
  if (!validInvoiceId(view.id) || !view.requisite) {
    console.error('meridianpay order: ответ без', validInvoiceId(view.id) ? 'реквизита' : 'order_id',
      '| тип', view.method || '(пусто)', '| ключи:', Object.keys(r.data || {}).join(','));
    return {
      ok: false,
      error: validInvoiceId(view.id) ? 'no_requisite' : 'no_invoice_id',
      // Частичную сделку не теряем: id есть — значит она создана, и повторять
      // POST опасно. Сервер сохранит её и сверит в фоне.
      invoice: validInvoiceId(view.id) ? view : null
    };
  }
  // Дальше — те же границы, что у CrocoPAY: выбор владельца и покупателя это
  // договор, а не пожелание. Всё, что им не соответствует, покупателю не
  // показываем, но сохраняем для сверки.
  const accept = ACCEPT[route.detail] || [route.detail];
  if (!view.method || !accept.includes(view.method)) {
    console.error('meridianpay order: касса вернула тип', view.method || '(пусто)', 'вместо', route.detail);
    return { ok: false, error: 'method_mismatch', invoice: view };
  }
  // Регион реквизита — единственная проверка трансграничности, которую ответ
  // вообще позволяет сделать. Просили российский маршрут, а реквизит чужой —
  // это ровно та подмена, из-за которой у CrocoPAY появился route_mismatch.
  if (!route.transgran && view.region && !/росс/i.test(view.region)) {
    console.error('meridianpay order: российский способ, а реквизит из региона', view.region);
    return { ok: false, error: 'region_mismatch', invoice: view };
  }
  if (view.currency !== currency) {
    console.error('meridianpay order: касса вернула валюту', view.currency || '(пусто)', 'вместо', currency);
    return { ok: false, error: 'currency_mismatch', invoice: view };
  }
  if (view.state !== 'pending') {
    console.error('meridianpay order: новая сделка пришла в состоянии', view.state || '(пусто)');
    return { ok: false, error: 'bad_invoice_state', invoice: view };
  }
  if (!(view.expiresAt > Date.now())) {
    console.error('meridianpay order: касса не вернула будущий срок действия реквизита');
    return { ok: false, error: 'bad_expiry', invoice: view };
  }
  /*
   * Сумма сверяется СТРОГО по документированным копейкам, и расхождение — отказ.
   *
   * Соблазн «принять и рубли, и копейки» здесь смертелен: заказ на 1 000 ₽ и
   * заказ на 10 ₽, понятый кассой как 1 000 копеек, дали бы одно и то же число.
   * Ошибка в эту сторону означает отгрузку товара за сотую часть цены, поэтому
   * fail-closed: не сошлось — отказываем и уходим на вторую кассу. В лог кладём
   * обе трактовки, чтобы расхождение единиц было видно с первой же строки.
   */
  if (Math.round(view.amount * MINOR) !== Math.round(amount * MINOR)) {
    console.error('meridianpay order: касса вернула сумму', view.amount,
      '(в копейках было бы', Math.round(Number((r.data || {}).amount) || 0) / MINOR,
      ', в рублях —', Number((r.data || {}).amount) || 0, ') вместо', amount, currency);
    return { ok: false, error: 'amount_mismatch', invoice: view };
  }
  return { ok: true, invoice: view };
}

// Статус сделки. Ради него всё и затевалось: callback приходит не на всякое
// изменение, а сверять оплату надо всегда одинаково.
async function invoice(settings, id) {
  if (!validInvoiceId(id)) return { ok: false, error: 'bad_invoice_id' };
  const r = await api(settings, '/h2h/order/' + encodeURIComponent(trimmed(id)));
  if (!r.ok) return r;
  return { ok: true, invoice: invoiceView(r.data) };
}

/* Отменить сделку — то, чего у CrocoPAY нет вовсе.
 *
 * Зовём в одном месте: когда касса выдала сделку, а мы её ЗАБРАКОВАЛИ (не тот
 * тип реквизита, чужой регион, не та сумма). Реквизиты покупателю в этом случае
 * не показаны, платить по ним никто не будет, а трейдерская карта иначе осталась
 * бы зарезервированной все 10–15 минут впустую.
 *
 * Живой счёт, по которому покупатель МОЖЕТ платить, не отменяем никогда: деньги
 * бывают в пути, а отменённая сделка их уже не свяжет с заказом.
 */
async function cancel(settings, id) {
  if (!validInvoiceId(id)) return { ok: false, error: 'bad_invoice_id' };
  return api(settings, '/h2h/order/' + encodeURIComponent(trimmed(id)) + '/cancel', { method: 'PATCH' });
}

/* --------------------------- Сверка и идемпотентность --------------------------- */

// Тот же контракт, что у CrocoPAY: только точное совпадение конкретной сделки,
// валюты и суммы вправе привести заказ к `paid`.
function matchesInvoice(expected, actual) {
  expected = expected || {};
  actual = actual || {};
  const invoiceId = trimmed(expected.invoiceId);
  if (!invoiceId || trimmed(actual.id) !== invoiceId) return { ok: false, reason: 'invoice_id' };
  const currency = trimmed(expected.currency).toUpperCase() || CURRENCY;
  if (trimmed(actual.currency).toUpperCase() !== currency) return { ok: false, reason: 'currency' };
  const want = Number(expected.amount), got = Number(actual.amount);
  if (!Number.isFinite(want) || want <= 0 || !Number.isFinite(got)
    || Math.round(got * MINOR) !== Math.round(want * MINOR)) {
    return { ok: false, reason: 'amount' };
  }
  // Способ сверяем по типу реквизита: в заказе лежит наш id способа, а касса
  // знает только `detail_type`. Поле в ответе есть не всегда — пустое не
  // считаем подменой, как и у CrocoPAY.
  const route = MAP[trimmed(expected.method)];
  const type = trimmed(actual.method);
  if (route && type && !(ACCEPT[route.detail] || [route.detail]).includes(type)) {
    return { ok: false, reason: 'method' };
  }
  return { ok: true };
}

// Отпечаток идемпотентного POST — общий с CrocoPAY по смыслу: один requestId
// нельзя переиспользовать после смены способа, валюты или суммы.
function sameStartRequest(expected, actual) {
  expected = expected || {};
  actual = actual || {};
  return trimmed(expected.method) === trimmed(actual.method)
    && trimmed(expected.currency).toUpperCase() === trimmed(actual.currency).toUpperCase()
    && Math.round((Number(expected.amount) || 0) * MINOR) === Math.round((Number(actual.amount) || 0) * MINOR);
}

// Повторять POST можно только когда касса ЯВНО сказала, что реквизитов нет, и не
// вернула id сделки. Таймаут и частичный ответ повторять нельзя — первый запрос
// мог успеть создать оплачиваемую сделку.
function retryableStart(result) {
  return !!result && !result.ok && ERR.codeOf(result.error) === 'no_requisite'
    && !(result.invoice && validInvoiceId(result.invoice.id));
}

/* -------------------------------- Callback -------------------------------- */

/*
 * ПОДПИСИ У CALLBACK НЕТ — и это не наша недоработка.
 *
 * В теле приходит поле `integrity` (64 hex, похоже на SHA-256), но алгоритм его
 * расчёта не описан НИГДЕ: ни на странице callback, ни в остальной
 * документации — там встречаются только сами значения в примерах (проверено по
 * полному дампу llms-full.txt 23 августа 2026). Подобрать формулу «на глаз» и
 * пускать по ней деньги нельзя.
 *
 * Поэтому callback у нас — только СИГНАЛ, а не доказательство:
 *   - что он про этот заказ и эту попытку, подтверждает наш собственный token в
 *     адресе callback_url (16 случайных байт, как у CrocoPAY);
 *   - что деньги ПРАВДА пришли, подтверждает отдельный `GET /h2h/order/{id}` по
 *     API-ключу — единственный источник истины во всём модуле.
 *
 * Так устроена и сверка CrocoPAY, у которой подпись есть: она всё равно не
 * покрывает ни id сделки, ни единицы суммы. То есть вторая касса ничего не
 * ослабляет — просто у неё нет лишнего необязательного шага.
 *
 * Сумму из тела callback не разбираем вовсе: там она в РУБЛЯХ, а в ответе API —
 * в копейках, и любая попытка «понять по числу» кончится тем, чем кончилась у
 * CrocoPAY (см. шапку файла).
 *
 * `integrityHint()` ниже — диагностика, а не проверка. Она перебирает несколько
 * очевидных формул с Secret Key из настроек и, если одна сойдётся, пишет в лог
 * её имя. Первый же настоящий callback покажет, какая именно формула у кассы, и
 * тогда проверку можно будет включить осознанно — одной строкой.
 */
function integrityHint(settings, body) {
  const secret = trimmed(settings && settings.meridianpaySecret);
  const given = trimmed(body && body.integrity).toLowerCase();
  if (!secret || !/^[a-f0-9]{64}$/.test(given)) return '';
  const order = trimmed(body && body.order_id);
  const ext = trimmed(body && body.external_id);
  const amount = trimmed(body && body.amount);
  const status = trimmed(body && body.status);
  const candidates = {
    'hmac(order_id)': ['hmac', order],
    'hmac(external_id)': ['hmac', ext],
    'hmac(order_id:amount)': ['hmac', order + ':' + amount],
    'hmac(order_id|amount|status)': ['hmac', [order, amount, status].join('|')],
    'sha256(order_id+secret)': ['sha', order + secret],
    'sha256(secret+order_id)': ['sha', secret + order],
    'sha256(order_id+amount+secret)': ['sha', order + amount + secret]
  };
  for (const [name, [kind, message]] of Object.entries(candidates)) {
    const digest = kind === 'hmac'
      ? crypto.createHmac('sha256', secret).update(message).digest('hex')
      : crypto.createHash('sha256').update(message).digest('hex');
    if (digest === given) return name;
  }
  return '';
}

/*
 * Единый вход для маршрута callback — тот же, что у CrocoPAY, чтобы маршрут не
 * знал разницы между кассами.
 *
 * Проверять здесь нечем, и это осознанно (см. блок выше): подтверждают
 * уведомление наш token в адресе и обязательная сверка через GET. Возврат
 * `true` означает «своей проверки у этой кассы нет», а не «всё в порядке».
 *
 * Заодно — единственный за процесс диагностический прогон по `integrity`:
 * сойдётся формула, и мы наконец узнаем алгоритм из настоящего уведомления.
 */
let integrityLogged = false;
function verifyCallback(settings, body) {
  if (!integrityLogged) {
    const hit = integrityHint(settings, body);
    if (hit) {
      integrityLogged = true;
      console.log('meridianpay callback: integrity сошлась по формуле', hit,
        '— проверку можно включить в verifyCallback');
    }
  }
  return true;
}

module.exports = {
  id: 'meridianpay',
  name: 'MeridianPay',
  verifyCallback,
  CURRENCY, MAP,
  configured, enabled, supports, acceptsAmount, validInvoiceId, validMerchantId, validExternalId,
  createInvoice, invoice, cancel, availableOptions, parseGateways, forgetMethods,
  matchesInvoice, sameStartRequest, retryableStart, stateOf, expiryMs, integrityHint,
  // Словарь отказов общий с CrocoPAY: покупатель не должен по формулировке
  // догадываться, какая касса ему отказала.
  startError: ERR.messageOf, startErrorCode: ERR.codeOf
};
