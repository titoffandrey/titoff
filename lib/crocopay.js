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
 * Цены и сумма заказа всегда в RUB. Валюту самого H2H-счёта выбираем из живого
 * списка кассы, а пересчёт делает сервер по курсу владельца.
 *
 * Модуль намеренно не знает ни про заказы, ни про хранилище — только HTTP к
 * платёжке и проверка подписи вебхука. Всё, что связывает платёж с заказом,
 * живёт в server.js и lib/db.js, поэтому платёжку можно снять, удалив этот файл
 * и один блок маршрутов.
 *
 * Внешних зависимостей нет — fetch встроен в Node 18+, как в lib/dadata.js.
 */
const crypto = require('crypto');
const ERR = require('./pay-errors');
// Вид реквизита у способа и проверка «похож ли он на настоящий» — общие с
// MeridianPay: правило одно, и двумя копиями оно разъехалось бы молча.
const PAY = require('./pay-methods');

const API = 'https://crocopay.tech/api/v2/h2h';
// Платёжку ждём дольше, чем подсказки адреса: этот запрос покупатель ждёт
// осознанно, а без ответа оплату вообще не открыть.
const TIMEOUT = 10000;
// Создание счёта на боевой кассе несколько раз не укладывалось в 10 секунд.
// Для POST даём больше времени, но транспортный timeout автоматически НЕ
// повторяем: касса могла создать счёт, а ответ потерялся, и без idempotency key
// второй POST выпустил бы ещё один.
const CREATE_TIMEOUT = 25000;
// Список способов — не критический путь: без него страница оплаты честно
// показывает разрешённое владельцем, а настройки — встроенный список с
// оговоркой. Поэтому ждём его вчетверо меньше, чем счёт (тот же 4 с, что у
// подсказок адреса в lib/dadata.js). С двумя кассами это уже не мелочь: их
// спрашивают параллельно, и зависшая любая держала бы страницу оплаты все
// десять секунд — ровно там, где покупатель нетерпеливее всего.
const OPTIONS_TIMEOUT = 4000;


// Базовая валюта: цены каталога и сумма заказа — рублёвые, в них же стоят
// пределы одной покупки. Счёт можно выставить и в другой валюте — какие
// включены, отвечает сама касса, а курс к рублю задаётся в настройках
// (см. lib/pay-methods.js).
const CURRENCY = 'RUB';
// Минорная единица — сотая. Так у рубля и у всех валют, с которыми работает
// касса; счёт округляется до двух знаков.
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
 * (`subtotal: 500000`). Угадывать единицы нельзя: webhook теперь только будит
 * строгую сверку конкретного счёта через GET, а `paidEnough()` разбирает лишь
 * документированные минимальные единицы.
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
 * Пределы одной покупки переехали в lib/payments.js.
 *
 * Числа те же (1 000 – 250 000 ₽) и пришли они отсюда, из ограничений CrocoPAY.
 * Но с появлением второй кассы это перестало быть свойством ОДНОЙ платёжки:
 * пределы действуют, пока на витрине включена оплата хоть какой-нибудь, — а
 * решает это router, а не отдельный провайдер. Диапазон покрывают обе кассы
 * (у рублёвых шлюзов MeridianPay 999–300 000, у 890 из 906).
 */

// Сумма заказа -> минимальные единицы. Счёту это больше не нужно (см. блок про
// единицы выше), но пригождается при разборе вебхука.
function toMinor(amount) {
  return Math.round((Number(amount) || 0) * MINOR);
}

// Строгий разбор суммы webhook по документированным МИНИМАЛЬНЫМ единицам.
// Прежнее «попробовать и рубли, и копейки» было опасно: при webhook в копейках
// платёж 122 ₽ за заказ 12 200 ₽ приходил как raw=12200 и ошибочно считался
// полной оплатой в рублях. Основной путь больше вообще не доверяет этой сумме —
// webhook лишь запускает GET конкретного счёта (server.js), функция остаётся
// страховкой и для тестов старых интеграций.
function paidEnough(expected, raw) {
  const want = Number(expected) || 0;
  const got = Number(raw);
  if (!Number.isFinite(got)) return { ok: false, major: null };
  const major = got / MINOR;
  return { ok: Math.round(got) >= toMinor(want), major };
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

// `expires_at` приходит строкой ISO. Ноль означает «срок не подтверждён» — такой
// новый счёт сохраняется для сверки, но реквизиты покупателю не показываются.
function expiryMs(value) {
  const ms = Date.parse(trimmed(value));
  return Number.isFinite(ms) ? ms : 0;
}

/* --------------------------------- Запросы --------------------------------- */

// Один вход для всех трёх эндпоинтов. Ошибки не бросаем: вызывающий покажет
// покупателю понятное сообщение, а заказ к этому моменту уже записан.
async function api(settings, path, init, timeoutMs) {
  if (!configured(settings)) return { ok: false, error: 'not_configured' };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Number(timeoutMs) || TIMEOUT);
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
// Похоже ли значение на платёжного адресата: номер карты, телефон или безопасная
// http(s)-ссылка. Произвольную строку из ответа нельзя потом ставить в href:
// платёжка — внешняя граница, а `javascript:` превратил бы кнопку QR в XSS.
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
  return '';                              // неизвестный формат — fail closed
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
    // Пустую валюту не превращаем в RUB: при сверке оплаты отсутствие поля
    // должно быть несовпадением, а не неявным подтверждением рублёвого счёта.
    currency: pick(tx, ['currency']).toUpperCase(),
    // Возвращённый способ сохраняем для проверки. Подмену TO_CARD на
    // TO_CARD_TRANSGRAN нельзя показывать покупателю как его выбор.
    method: pick(req, ['paymentOption', 'payment_option', 'method', 'code'])
      || pick(tx, ['paymentOption', 'payment_option']),
    requisite: findRequisite(req),
    bank: pick(req, ['bank_receiver', 'bankReceiver', 'bank', 'bankName', 'paymentMethod']),
    owner: pick(req, ['card_owner', 'cardOwner', 'owner', 'receiver', 'holder', 'fio']),
    expiresAt: expiryMs(pick(tx, ['expiredAt', 'expires_at', 'expire_at', 'expired_at', 'expires']))
  };
}

// Эндпоинт 1 — создать счёт. Сумма в ОСНОВНЫХ единицах (см. блок про единицы
// выше) и уже в валюте счёта: пересчёт из рублей делает вызывающий по курсу из
// настроек. Способ оплаты и валюта проверены им же — по тому, что реально
// включено у кассы.
async function createInvoice(settings, params) {
  const amount = Math.round((Number(params && params.amount) || 0) * MINOR) / MINOR;
  if (!Number.isFinite(amount) || amount <= 0) return { ok: false, error: 'bad_amount' };
  const method = trimmed(params && params.method);
  if (!method) return { ok: false, error: 'bad_method' };
  const currency = trimmed(params && params.currency).toUpperCase() || CURRENCY;
  if (!/^[A-Z]{3}$/.test(currency)) return { ok: false, error: 'bad_currency' };

  const r = await api(settings, '/invoices', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      amount,
      currency,
      payment_option: method,
      // GET-параметры этого адреса платёжка сохраняет и вернёт в вебхуке —
      // только по ним и понятно, о каком заказе речь (см. server.js).
      callback_url: String((params && params.callbackUrl) || '')
    })
  }, CREATE_TIMEOUT);
  if (!r.ok) return r;
  const view = invoiceView(r.data);
  const responseMessage = trimmed(r.data && r.data.message);
  const responseCode = startErrorCode(responseMessage);
  // Счёт без id или без реквизитов показывать нечем. Ключи ответа пишем в лог:
  // формат кассы уже расходился с документацией, и без этой строки разбираться
  // пришлось бы вслепую (значения не пишем — это чужие платёжные реквизиты).
  if (!validInvoiceId(view.id) || !view.requisite) {
    console.error('crocopay invoice: ответ без', validInvoiceId(view.id) ? 'реквизитов' : 'id',
      '— ключи:', Object.keys((r.data && (r.data.response || r.data)) || {}).join(','));
    return {
      ok: false,
      // CrocoPAY встречался с HTTP 200 + `message: Requisites not found` без
      // response. Не теряем явный штатный отказ под техническим no_invoice_id:
      // именно no_requisite разрешает один безопасный повтор.
      error: responseCode !== 'provider_error'
        ? responseMessage : (validInvoiceId(view.id) ? 'no_requisite' : 'no_invoice_id'),
      // Частичный счёт не теряем: если id уже есть, повторять POST опасно. Сервер
      // сохранит id без реквизита и сможет сверять его в фоне.
      invoice: validInvoiceId(view.id) ? view : null
    };
  }
  // Выбор владельца — граница, а не пожелание. CrocoPAY реально отвечал
  // TO_CARD_TRANSGRAN на запрос TO_CARD; раньше мы показывали эту карту TJ, хотя
  // в настройках были разрешены только банки РФ. Такой счёт сохраняем для
  // аудита, но реквизиты покупателю не отдаём.
  if (!view.method || view.method !== method) {
    console.error('crocopay invoice: касса вернула способ', view.method || '(пусто)', 'вместо', method);
    return { ok: false, error: 'method_mismatch', invoice: view };
  }
  if (view.currency !== currency) {
    console.error('crocopay invoice: касса вернула валюту', view.currency || '(пусто)', 'вместо', currency);
    return { ok: false, error: 'currency_mismatch', invoice: view };
  }
  if (view.state !== 'pending') {
    console.error('crocopay invoice: новый счёт пришёл в состоянии', view.state);
    return { ok: false, error: 'bad_invoice_state', invoice: view };
  }
  /* Срок — часть реквизитов, а не косметический таймер. Без подтверждённого
   * будущего expiresAt нельзя угадать, когда карта снова станет чужой; такой
   * invoice сохраняем для сверки, но покупателю не показываем.
   *
   * ССЫЛОЧНЫЙ СЧЁТ — исключение, и появилось оно не от хорошей жизни. С 27
   * августа 2026 касса отвечает на `TO_CARD` своей платёжной страницей
   * (`requisites: "https://…", manual: true`) и `expiredAt` в ответе не шлёт
   * вовсе — за одно утро мы так забраковали шесть настоящих счетов, а покупатели
   * остались без оплаты. Срок в этом случае СПРАШИВАЕМ У САМОЙ КАССЫ отдельным
   * запросом статуса: выдумывать четверть часа нельзя (на этом уже наступали),
   * а её собственное число — единственное честное, какое здесь есть. Сверка
   * потом всё равно вправе его сократить, если касса закроет сделку раньше.
   *
   * Спрашиваем ровно один раз и только когда срока нет: у обычного счёта с
   * картой лишнего запроса не появляется. */
  if (!(view.expiresAt > Date.now()) && PAY.isPayLink(view.requisite)) {
    const status = await invoice(settings, view.id);
    const late = status.ok && status.invoice ? status.invoice.expiresAt : 0;
    if (late > Date.now()) {
      console.log('crocopay invoice: срок ссылочного счёта взят из статуса —', new Date(late).toISOString());
      view.expiresAt = late;
    }
  }
  if (!(view.expiresAt > Date.now())) {
    console.error('crocopay invoice: касса не вернула будущий срок действия счёта');
    return { ok: false, error: 'bad_expiry', invoice: view };
  }
  // Касса возвращает сумму счёта эхом. Разошлась с нашей — значит она поняла
  // запрос иначе, и показывать покупателю такие реквизиты нельзя: он переведёт
  // не ту сумму, и платёж не сойдётся.
  if (!(view.amount > 0) || toMinor(view.amount) !== toMinor(amount)) {
    console.error('crocopay invoice: касса вернула сумму', view.amount, 'вместо', amount);
    return { ok: false, error: 'amount_mismatch', invoice: view };
  }
  // Последняя граница — сам реквизит. Номер, которого не бывает, покупателю
  // показывать нельзя: он либо не сможет заплатить, либо переведёт деньги
  // постороннему (см. «Реквизит обязан быть похож на настоящий» в
  // lib/pay-methods.js). Значение в лог не пишем — это чужие платёжные данные.
  const problem = PAY.requisiteProblem(PAY.describe(method).kind, view.requisite, PAY.isDomestic(method));
  if (problem) {
    console.error('crocopay invoice: реквизит не похож на настоящий —', problem, '| способ', method);
    // `reason` уезжает в историю попытки: владельцу в панели нужно видеть не
    // только «реквизит забракован», но и чем именно он плох.
    return { ok: false, error: 'bad_requisite', reason: problem, invoice: view };
  }
  return { ok: true, invoice: view };
}

/* Что показать покупателю, когда счёт не вышел.
 *
 * Строки кассы английские и объясняют покупателю ровно ничего («Requisites not
 * found»), поэтому наружу отдаём свои — и главное, говорим, что делать дальше.
 *
 * Разбор ответа живёт здесь, а не в маршруте: это знание о чужом API, и ему
 * место рядом с остальным знанием о нём.
 *
 * **`Requisites not found` — не поломка, а штатный отказ**: у P2P-процессинга
 * пул карт конечен, и на конкретную сумму свободной может не быть прямо сейчас.
 * Лечится другим способом оплаты (у СБП пул свой) или повтором через пару минут,
 * поэтому именно это и написано покупателю. Заказ при этом уже настоящий —
 * менеджер видит его и может довести оплату руками.
 *
 * Сам словарь переехал в lib/pay-errors.js и стал общим со второй кассой.
 * Причина простая: покупатель не должен по формулировке отказа догадываться,
 * какая платёжка ему отказала, — а строки у касс разные и даже на разных языках
 * (CrocoPAY отвечает по-английски, MeridianPay по-русски).
 */
const startErrorCode = ERR.codeOf;
const startError = ERR.messageOf;

// Единственный безопасный автоматический повтор POST: касса явно ответила, что
// реквизитов нет, и не вернула id счёта. Timeout/5xx и частичный счёт повторять
// нельзя — первый запрос мог успеть создать оплачиваемый invoice.
function retryableStart(result) {
  return !!result && !result.ok && startErrorCode(result.error) === 'no_requisite'
    && !(result.invoice && validInvoiceId(result.invoice.id));
}

// Один контракт для клиентского polling, webhook-reconcile и фоновой сверки.
// Только точное совпадение конкретного invoice, суммы и валюты вправе привести
// к `paid`; возвращённый метод сверяем, когда GET его содержит.
function matchesInvoice(expected, actual) {
  expected = expected || {};
  actual = actual || {};
  const invoiceId = trimmed(expected.invoiceId);
  if (!invoiceId || trimmed(actual.id) !== invoiceId) return { ok: false, reason: 'invoice_id' };
  const currency = trimmed(expected.currency).toUpperCase() || CURRENCY;
  if (trimmed(actual.currency).toUpperCase() !== currency) return { ok: false, reason: 'currency' };
  const want = Number(expected.amount), got = Number(actual.amount);
  if (!Number.isFinite(want) || want <= 0 || !Number.isFinite(got)
    || toMinor(got) !== toMinor(want)) {
    return { ok: false, reason: 'amount' };
  }
  const method = trimmed(expected.method), actualMethod = trimmed(actual.method);
  const issuedMethod = trimmed(expected.actualMethod);
  // POST уже доказал, что касса выпустила этот invoice по другому маршруту.
  // GET часто не повторяет paymentOption; отсутствие поля не должно стирать
  // ранее замеченную подмену и превращать такой счёт в подтверждённый.
  if (method && issuedMethod && issuedMethod !== method) return { ok: false, reason: 'method' };
  // У новой попытки наличие пустого actualMethod означает, что POST вообще не
  // подтвердил маршрут. Старые записи этого поля не имеют и остаются
  // совместимыми; новую можно подтвердить только если GET явно вернул способ.
  if (method && Object.prototype.hasOwnProperty.call(expected, 'actualMethod')
    && !issuedMethod && !actualMethod) return { ok: false, reason: 'method' };
  if (method && actualMethod && actualMethod !== method) return { ok: false, reason: 'method' };
  return { ok: true };
}

// Отпечаток идемпотентного POST. Один requestId нельзя переиспользовать после
// смены способа, валюты или суммы (например, обновился курс): это уже другой
// запрос, даже если браузер по ошибке сохранил старый ключ.
function sameStartRequest(expected, actual) {
  expected = expected || {};
  actual = actual || {};
  return trimmed(expected.method) === trimmed(actual.method)
    && trimmed(expected.currency).toUpperCase() === trimmed(actual.currency).toUpperCase()
    && toMinor(expected.amount) === toMinor(actual.amount);
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
const _methods = { key: '', at: 0, live: null };
const METHODS_TTL = 5 * 60 * 1000;

// Разбор ответа. Документация и живая касса тут РАСХОДЯТСЯ, поэтому понимаем оба
// вида. В документации это плоский список
//   {methods:[{currency:'RUB', payment_option:'TO_CARD'}]},
// а живая касса отвечает сгруппированно по валюте
//   {payment_methods:[{code:'RUB', options:[{code:'TO_CARD'}]}]}.
// Проверено на боевой кассе 17 августа 2026: приходит второй вид.
//
// Разбираем ВСЕ валютные группы, а не одну рублёвую: что у кассы включено —
// знает только она, и список валют счёта берётся отсюда же, из живого ответа.
// Порядок валют — как ответила касса, но базовая (рубль) всегда первой:
// цены магазина рублёвые, и это валюта по умолчанию.
function parseOptions(data) {
  const byCurrency = {};
  const add = (currency, code) => {
    const cur = trimmed(currency).toUpperCase();
    const option = trimmed(code);
    if (!/^[A-Z]{3}$/.test(cur) || !option) return;
    if (!byCurrency[cur]) byCurrency[cur] = [];
    if (!byCurrency[cur].includes(option)) byCurrency[cur].push(option);
  };
  const groups = Array.isArray(data && data.payment_methods) ? data.payment_methods : [];
  for (const g of groups) {
    if (!g || typeof g !== 'object') continue;
    const cur = g.code || g.currency;
    for (const o of (Array.isArray(g.options) ? g.options : [])) {
      if (o && typeof o === 'object') add(cur, o.code || o.payment_option);
      else if (typeof o === 'string') add(cur, o);
    }
  }
  const flat = Array.isArray(data && data.methods) ? data.methods : [];
  for (const m of flat) {
    if (!m || typeof m !== 'object') continue;
    add(m.currency || m.code, m.payment_option || m.code);
  }
  const currencies = Object.keys(byCurrency)
    .sort((a, b) => (a === CURRENCY ? -1 : b === CURRENCY ? 1 : 0));
  return { currencies, byCurrency };
}

// Что реально включено у кассы. Отдаём и список валют, и способы каждой из них:
// настройки показывают всё это владельцу, а страница оплаты берёт срез по
// выбранной валюте. `options` — срез базовой валюты, он же прежний ответ.
async function availableOptions(settings) {
  const key = trimmed(settings && settings.crocopayClientId);
  const shape = live => ({
    ok: true, currencies: live.currencies, byCurrency: live.byCurrency,
    options: live.byCurrency[CURRENCY] || []
  });
  if (_methods.live && _methods.key === key && Date.now() - _methods.at < METHODS_TTL) {
    return Object.assign(shape(_methods.live), { cached: true });
  }
  const r = await api(settings, '/payment-method/available', null, OPTIONS_TIMEOUT);
  if (!r.ok) return r;
  const live = parseOptions(r.data);
  // Ответ есть, а способов ноль — либо у кассы правда ничего не включено, либо
  // формат ответа снова поменялся. Второе видно только в логе, поэтому пишем
  // ключи ответа: без этого «оплатить нечем» не отличить от ошибки разбора.
  if (!live.currencies.length) console.error('crocopay methods: пустой список, ключи ответа —', Object.keys(r.data || {}).join(','));
  _methods.key = key;
  _methods.at = Date.now();
  _methods.live = live;
  return shape(live);
}

// Сбросить кэш способов — нужен после смены ключей кассы в панели владельца.
function forgetMethods() { _methods.key = ''; _methods.at = 0; _methods.live = null; }

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

/*
 * Умеет ли эта касса такой способ. У CrocoPAY id способа И ЕСТЬ её
 * `payment_option`, поэтому подходит любой непустой код — в том числе тот,
 * которого нет в нашем закрытом списке (касса включила новый, и владелец
 * отметил его в настройках). У MeridianPay иначе: там способ собирается из трёх
 * полей по таблице перевода, и незнакомый код перевести нечем.
 */
function supports(methodId) { return trimmed(methodId) !== ''; }

/*
 * Возьмётся ли касса за такую сумму. У CrocoPAY проверять нечего: своих
 * ограничений по сумме, кроме общих пределов одной покупки (они уже проверены
 * маршрутом), она не объявляет, а дробные суммы принимает — счёт создаётся с
 * округлением до двух знаков.
 *
 * Функция всё равно есть, потому что она часть контракта провайдера: очередь
 * касс спрашивает её у каждого, а у MeridianPay ответ содержательный.
 */
function acceptsAmount(amount) {
  const sum = Number(amount);
  return Number.isFinite(sum) && sum > 0;
}

// Единый вход для маршрута callback: он не должен знать, чем именно
// подтверждается уведомление у конкретной кассы (у CrocoPAY — HMAC по телу, у
// MeridianPay подписи нет вовсе).
function verifyCallback(settings, body, rawBody) {
  return verify(trimmed(settings && settings.crocopayClientSecret), body, rawBody);
}

module.exports = {
  id: 'crocopay', name: 'CrocoPAY',
  verifyCallback,
  CURRENCY, MINOR, configured, enabled, supports, acceptsAmount, toMinor, paidEnough, stateOf, validInvoiceId,
  createInvoice, startError, startErrorCode, retryableStart, matchesInvoice, sameStartRequest,
  invoice, availableOptions, parseOptions, forgetMethods, verify
};
