'use strict';
/*
 * Две кассы за одной кнопкой «Оплатить».
 *
 * ЭТО ЕДИНСТВЕННОЕ МЕСТО ВО ВСЁМ ПРОЕКТЕ, КОТОРОЕ ЗНАЕТ, ЧТО ПЛАТЁЖЕК НЕСКОЛЬКО.
 * Покупатель не знает и знать не должен: он выбирает способ оплаты («СБП»,
 * «Перевод на карту») и получает реквизиты. Какая касса их выдала — наше
 * внутреннее дело, и на витрине об этом нет ни слова: ни в списке способов, ни
 * на странице оплаты, ни в тексте отказа (словарь общий, lib/pay-errors.js).
 *
 * Зачем вторая касса вообще. У P2P-процессинга пул реквизитов конечен, и
 * «свободной карты сейчас нет» — это ШТАТНЫЙ ответ, а не поломка (у CrocoPAY он
 * приходит как `Requisites not found`). Раньше на такой отказ покупателю
 * предлагалось выбрать другой способ или подождать пару минут — то есть работу
 * за нас делал он. Теперь мы молча спрашиваем вторую кассу: у неё свой пул
 * трейдеров, и отказ первой к ней отношения не имеет.
 *
 * Что здесь есть:
 *   - реестр провайдеров и их порядок (владелец выбирает, кто первый);
 *   - пределы одной покупки — они принадлежат режиму оплаты, а не кассе;
 *   - `chainFor()` — кто может обслужить этот способ в этой валюте, по порядку;
 *   - слияние живых списков способов: витрина видит ОБЪЕДИНЕНИЕ возможностей.
 *
 * Чего здесь нет: заказов и хранилища. Как у провайдеров, вся связь платежа с
 * заказом живёт в server.js и lib/db.js.
 */
const crypto = require('crypto');
const CROCO = require('./crocopay');
const MERIDIAN = require('./meridianpay');
const ERR = require('./pay-errors');
const PAY = require('./pay-methods');
// Телефон разбирает тот же модуль, что и поле заказа: два разбора одного номера
// разъехались бы, и покупатель увидел бы реквизит, которого не бывает.
const PHONE = require('../public/phone.js');

/* Реестр. Порядок в массиве — порядок по умолчанию; владелец может поменять его
 * в настройках («какую кассу спрашивать первой»).
 *
 * Ключ провайдера уходит в заказ полем `payment.attempts[].provider` и остаётся
 * там навсегда — менять эти строки нельзя, только добавлять новые. У всех
 * прежних заказов поля нет вовсе, и они читаются как `crocopay`: до появления
 * второй кассы другой и не было.
 */
const PROVIDERS = [CROCO, MERIDIAN];
const DEFAULT_ID = CROCO.id;

function providerIds() { return PROVIDERS.map(p => p.id); }

// Провайдер по ключу. Пустой ключ — это заказ, записанный до появления второй
// кассы: тогда платёжка была одна.
function provider(id) {
  const key = String(id == null ? '' : id).trim() || DEFAULT_ID;
  return PROVIDERS.find(p => p.id === key) || null;
}
function nameOf(id) {
  const p = provider(id);
  return p ? p.name : String(id == null ? '' : id).trim();
}

/* Кто включён — по порядку, который задал владелец.
 *
 * `payPrimary` называет первую кассу; остальные идут следом в порядке реестра.
 * Незнакомое значение (настройка из будущей версии) молча сводится к порядку по
 * умолчанию, а не оставляет витрину без оплаты.
 */
function ordered(settings) {
  const first = String((settings && settings.payPrimary) || '').trim();
  const head = PROVIDERS.filter(p => p.id === first);
  return head.concat(PROVIDERS.filter(p => p.id !== first));
}
function enabledProviders(settings) {
  return ordered(settings).filter(p => p.enabled(settings));
}
// Ключи заданы — с кассой можно сверяться. Это НЕ то же самое, что «включена»:
// снятая галочка запрещает новые счета, но уже выданные обязаны досверяться до
// конца, иначе оплаченный вчера заказ навсегда останется «ждём оплату».
function configuredProviders(settings) {
  return ordered(settings).filter(p => p.configured(settings));
}

// Оплата на витрине включена, если её умеет хоть одна касса. Обе выключены (или
// без ключей) — витрина работает в режиме заявок, ровно как раньше.
function enabled(settings) { return enabledProviders(settings).length > 0; }
function configured(settings) { return configuredProviders(settings).length > 0; }

/*
 * Пределы одной покупки: 1 000 ₽ снизу и 250 000 ₽ сверху.
 *
 * Числа пришли от CrocoPAY — она не проводит платежи за этими границами. Вторая
 * касса диапазон покрывает целиком (у рублёвых шлюзов MeridianPay минимум
 * 999–1 000, а потолок 300 000 у 890 шлюзов из 906), поэтому границы остались
 * прежними: витрина не должна менять список продаваемых товаров от того, какую
 * кассу включили сегодня.
 *
 * Заказ вне пределов НЕ ОФОРМЛЯЕТСЯ вовсе: кнопка на оформлении гаснет, а
 * `/api/order` отвечает отказом.
 *
 * Товар дороже потолка (Vision Pro, Studio Display XDR, MacBook Pro 16") купить
 * на витрине нельзя — это осознанное решение владельца, а не недосмотр.
 */
const MIN_TOTAL = 1000;
const MAX_TOTAL = 250000;

/* Границы из настроек — владелец меняет их в «Оплата на витрине».
 *
 * Числа выше остаются значениями ПО УМОЛЧАНИЮ: пустое или испорченное поле
 * означает «как было», а не «предела нет». Иначе первая же кривая правка
 * настроек либо закрыла бы магазин, либо сняла бы потолок кассы молча.
 *
 * Перевёрнутый диапазон (минимум больше максимума) не запрещаем целиком, а
 * разворачиваем: форма такого не сохранит, но настройки правят и руками, а
 * «нельзя оформить ни одного заказа» — худший способ узнать об опечатке.
 */
function boundsOf(settings) {
  const num = (value, fallback) => {
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? Math.round(n) : fallback;
  };
  const min = num(settings && settings.payMinTotal, MIN_TOTAL);
  const max = num(settings && settings.payMaxTotal, MAX_TOTAL);
  return max >= min ? { min, max } : { min: max, max: min };
}

function payable(total, settings) {
  const { min, max } = boundsOf(settings);
  const sum = Number(total);
  return Number.isFinite(sum) && sum >= min && sum <= max;
}

// Текст отказа для витрины. Пределы заданы в рублях — той же базовой валюте, в
// которой считается заказ; пересчёт самого счёта происходит позже.
function limitError(total, settings) {
  const { min, max } = boundsOf(settings);
  const sum = Number(total);
  if (!Number.isFinite(sum)) return 'Сумма заказа некорректна';
  if (sum > max) return `Один заказ — не более ${max.toLocaleString('ru-RU')} ₽. Разделите покупку на несколько заказов.`;
  if (sum < min) return `Минимальная сумма заказа — ${min.toLocaleString('ru-RU')} ₽.`;
  return '';
}

/*
 * Пределы — ограничение КАСС, а не правило магазина, поэтому действуют они ровно
 * тогда, когда покупатель платит на витрине. Оплата выключена — заказ уходит
 * заявкой, её разбирает менеджер, и запрещать заявку на Vision Pro незачем.
 *
 * Ноль означает «предела нет» — так его читает и витрина (`public/app.js` везде
 * проверяет `if (!ORDER_MAX)`), и разметка товара.
 */
/* ------------------------- Свои реквизиты ------------------------- */

/* ТРЕТИЙ РЕЖИМ ВИТРИНЫ: касс нет, а деньги принимать надо.
 *
 * P2P-кассы живут чужим пулом трейдеров, и он кончается: 27 августа 2026 обе
 * отказывали сутки подряд на любую сумму, то есть магазин не мог принять ни
 * одного платежа. Свои реквизиты этой зависимости не имеют вовсе — покупатель
 * переводит владельцу напрямую.
 *
 * Чего у этого режима нет и быть не может: сверки. Никто не скажет нам, что
 * деньги пришли, поэтому ни срока у реквизитов, ни автоматического «оплачено»
 * здесь не бывает — оплату подтверждает человек в панели. Отсюда и вид страницы
 * оплаты: реквизиты без таймера и без опроса статуса.
 *
 * Режим включается, только когда кассы ВЫКЛЮЧЕНЫ: их сверка надёжнее ручной
 * отметки, и подменять её своими реквизитами, пока они работают, незачем.
 */
function ownRequisites(settings) {
  const s = settings || {};
  const card = String(s.ownPayCard || '').replace(/\D+/g, '');
  const phone = PHONE.store(s.ownPayPhone);
  const owner = String(s.ownPayOwner || '').trim().slice(0, 120);
  const bank = String(s.ownPayBank || '').trim().slice(0, 80);
  return {
    on: !!s.ownPayEnabled,
    card: PAY.luhnOk(card) ? card : '',
    phone,
    owner,
    bank,
    // Показывать покупателю можно только то, что он сможет проверить: хотя бы
    // один реквизит и имя получателя — по нему он сверяет, туда ли переводит.
    get ready() { return !!(this.on && this.owner && (this.card || this.phone)); }
  };
}
// Витрина принимает деньги своими реквизитами: касс нет, а реквизиты готовы.
function ownEnabled(settings) { return !enabled(settings) && ownRequisites(settings).ready; }
// Чем именно витрина принимает оплату прямо сейчас. Одно место на весь проект:
// от этого зависят и подпись кнопки, и черновик заказа, и страница оплаты.
function mode(settings) {
  if (enabled(settings)) return 'cashbox';
  return ownEnabled(settings) ? 'own' : 'request';
}

function limits(settings) {
  return enabled(settings) ? boundsOf(settings) : { min: 0, max: 0 };
}
function limitFor(settings, total) { return enabled(settings) ? limitError(total, settings) : ''; }

/* ------------------------- Что включено у касс ------------------------- */

/*
 * Живые списки способов у всех включённых касс — и их ОБЪЕДИНЕНИЕ.
 *
 * Объединение, а не пересечение: способ, который умеет хотя бы одна касса,
 * покупателю доступен. Пересечение отняло бы у него ровно то, ради чего вторая
 * касса и заводилась.
 *
 * Касса не ответила (нет ключей, выключена, сеть) — её условие не применяем, но
 * и не выкидываем остальных. Не ответил НИКТО — отдаём `null`: это прежний
 * договор с вызывающим, «списка нет, ограничение не применяется».
 */
async function availableOptions(settings) {
  const list = enabledProviders(settings);
  if (!list.length) return null;
  const answers = await Promise.all(list.map(async p => {
    try {
      const r = await p.availableOptions(settings);
      return { provider: p, answer: r || { ok: false, error: 'no_answer' } };
    } catch (e) { return { provider: p, answer: { ok: false, error: String((e && e.message) || e) } }; }
  }));
  const byCurrency = {};
  const byProvider = {};
  // Что ответила КАЖДАЯ касса — отдельно от объединения. Витрине нужно только
  // объединение (способ доступен, если его умеет хоть одна), а панели — правда
  // про каждую: пока ответы сливались в одну кучу, «MeridianPay не ответила»
  // было неотличимо от «у неё ничего не включено».
  const status = {};
  for (const { provider: p, answer } of answers) {
    const live = answer.ok ? answer : null;
    byProvider[p.id] = live;
    status[p.id] = {
      ok: !!live,
      error: live ? '' : String(answer.error || ''),
      pending: !!answer.pending,          // ответ ещё едет (медленная касса)
      cached: !!answer.cached,
      stale: !!answer.stale,
      currencies: live ? live.currencies.slice() : [],
      methods: live ? Object.keys(live.byCurrency)
        .reduce((all, cur) => all.concat(live.byCurrency[cur].filter(id => !all.includes(id))), []) : []
    };
    if (!live) continue;
    for (const cur of live.currencies) {
      if (!byCurrency[cur]) byCurrency[cur] = [];
      for (const id of (live.byCurrency[cur] || [])) {
        if (!byCurrency[cur].includes(id)) byCurrency[cur].push(id);
      }
    }
  }
  const currencies = Object.keys(byCurrency)
    .sort((a, b) => (a === PAY.BASE ? -1 : b === PAY.BASE ? 1 : 0));
  // `ok` — ответил ли хоть кто-то. Прежде в этом случае возвращался `null`, и
  // вместе с ним пропадало всё, что мы знаем о причине молчания; теперь объект
  // приходит всегда, а вызывающий смотрит на флаг (договор «списка нет —
  // ограничение не применяется» это не меняет).
  return {
    ok: answers.some(a => a.answer.ok),
    currencies, byCurrency, byProvider, status, options: byCurrency[PAY.BASE] || []
  };
}

/* ------------------------- Состояние касс для панели -------------------------
 *
 * Панель обязана говорить, что происходит НА САМОМ ДЕЛЕ, а не пересказывать
 * галочку. Раньше строка «работает» означала ровно одно: ключи в настройках
 * заполнены. Касса при этом могла не отвечать вовсе, отвергать ключи или (как
 * MeridianPay всё время модерации) отвечать на всё, кроме создания сделок, — а
 * панель писала «работает» одинаково бодро.
 *
 * Что здесь можно узнать честно и без единого лишнего запроса: касса ответила на
 * тот же список способов, который и так спрашивается для витрины. Отсюда четыре
 * состояния связи — и ни одного слова сверх того, что видно из ответа.
 *
 * Чего здесь НЕТ и быть не может: «может ли касса создавать сделки». Проверено
 * на живом API 24 августа 2026: `GET /h2h/order/<uuid>` и `PATCH …/cancel`
 * отвечают обычным 404, а `POST /h2h/order` сначала прогоняет проверку полей
 * (422) — про модерацию касса говорит только на настоящий запрос сделки.
 * Спрашивать её проверочной сделкой мы намеренно не стали, поэтому про сделки
 * панель показывает историю заказов (R.providerStats), а не догадку.
 */
const HEALTH_STATES = [
  // Ключи касса не приняла: у MeridianPay это «Invalid Access Token.» (HTTP 400),
  // у CrocoPAY — «Can not verify the client…» (HTTP 500). И то и другое проверено
  // на живых кассах, поэтому строки здесь настоящие, а не предполагаемые.
  ['auth', /invalid access token|verify the client|unauthor|forbidden|access denied|invalid client|http_40[13]/i],
  // Не дошли вовсе: сеть, таймаут, чужая пятисотка.
  ['down', /timeout|abort|fetch failed|network|socket|econn|enotfound|getaddrinfo|http_5\d\d/i]
];
function healthState(entry) {
  if (!entry) return 'unknown';
  if (entry.ok) return 'ok';
  if (entry.pending) return 'slow';
  const text = String(entry.error || '');
  for (const [state, re] of HEALTH_STATES) if (re.test(text)) return state;
  return 'error';
}

/*
 * Строка состояния на каждую кассу реестра — включая выключенные: «MeridianPay
 * выключена» отвечает на вопрос, почему её нет в очереди, а её отсутствие в
 * списке — нет.
 *
 * `live` — уже полученный ответ `availableOptions()`. Именно переданный, а не
 * запрошенный заново: второй запрос за той же страницей означал бы ещё восемь
 * секунд ожидания у медленной кассы.
 */
function health(settings, live) {
  const status = (live && live.status) || {};
  return PROVIDERS.map(p => {
    const on = !!(settings && settings[p.id + 'Enabled']);
    const ready = p.configured(settings);
    const entry = status[p.id] || null;
    const state = !on ? 'off' : !ready ? 'nokeys' : healthState(entry);
    return {
      id: p.id, name: p.name, on, ready, state,
      live: state === 'ok',
      methods: entry ? entry.methods : [],
      currencies: entry ? entry.currencies : [],
      cached: !!(entry && entry.cached),
      error: entry ? entry.error : ''
    };
  });
}

/*
 * Кого спрашивать про этот способ — по порядку.
 *
 * Отбор в три сита:
 *   1. касса включена и с ключами;
 *   2. она умеет такой способ вообще (`supports`): у CrocoPAY id способа и есть
 *      её код, у MeridianPay он собирается по таблице перевода, и незнакомый код
 *      перевести нечем;
 *   3. если касса ОТВЕТИЛА живым списком — способ в нём есть для этой валюты.
 *      Не ответила — условие не применяем: несовпадение поймает она сама при
 *      создании счёта, а выкинуть её из очереди значило бы остаться без
 *      запасного варианта именно тогда, когда он нужнее всего;
 *   4. она берётся за такую сумму (`acceptsAmount`).
 *
 * Четвёртое сито важно не тем, что экономит запрос, — его и не было бы, отказ
 * приходит мгновенно и без сети, — а тем, что не даёт соврать статистике.
 * Попытка записывается в заказ ДО обращения к кассе, и без этой проверки
 * MeridianPay копила бы «отказы» на дробных суммах, которых в глаза не видела.
 */
function chainFor(settings, live, methodId, currency, amount) {
  const method = String(methodId || '');
  const cur = PAY.currencyCode(currency) || PAY.BASE;
  return enabledProviders(settings).filter(p => {
    if (!p.supports(method)) return false;
    const own = live && live.byProvider ? live.byProvider[p.id] : null;
    // Сумму спрашиваем только когда она известна. Вызов без неё (настройки,
    // предпросмотр) не должен молча выкидывать кассы из очереди.
    if (amount !== undefined && p.acceptsAmount && !p.acceptsAmount(amount, cur, own)) return false;
    if (!own) return true;
    return (own.byCurrency[cur] || []).includes(method);
  });
}

// Сбросить кэши способов у всех касс. Нужен после смены ключей в панели: иначе
// прежний ответ ещё пять минут отвечал бы за другую кассу.
function forgetMethods() { for (const p of PROVIDERS) if (p.forgetMethods) p.forgetMethods(); }

/*
 * Отпечаток идемпотентного запроса — общий, а не провайдерский.
 *
 * Один requestId из браузера нельзя переиспользовать после смены способа,
 * валюты или суммы (например, обновился курс): это уже другой запрос, даже если
 * вкладка сохранила прежний ключ. Проверка одинакова для всех касс и сравнивает
 * то, что покупатель видел на экране, а не то, что ответила платёжка.
 */
function sameStartRequest(expected, actual) {
  expected = expected || {};
  actual = actual || {};
  const cents = v => Math.round((Number(v) || 0) * 100);
  return String(expected.method || '') === String(actual.method || '')
    && String(expected.currency || '').toUpperCase() === String(actual.currency || '').toUpperCase()
    && cents(expected.amount) === cents(actual.amount);
}

/*
 * requestId для конкретной кассы.
 *
 * Браузер присылает ОДИН requestId на нажатие кнопки, а попыток за это нажатие
 * может быть две: первая касса отказала, спрашиваем вторую. Записать обе под
 * одним ключом нельзя — `db.startOrderPayment()` считает повтор того же
 * requestId потерянным ответом и второй попытки просто не создаёт.
 *
 * Поэтому каждой кассе достаётся свой ключ, выведенный из общего. Он
 * детерминированный: повтор того же нажатия (пропал ответ, покупатель нажал
 * снова) попадает в те же самые две попытки и никогда не плодит лишние счета.
 */
/*
 * Что сказать покупателю, когда отказали ВСЕ кассы очереди.
 *
 * Кодов набирается столько же, сколько было касс, и они разные: одна ответила
 * «нет свободных реквизитов», вторая не ответила вовсе. Показать оба нельзя —
 * покупатель тут же увидит, что платёжек несколько, — поэтому берём один, и не
 * последний по счёту, а самый полезный: тот, чей совет ведёт к покупке.
 *
 * Отсюда и порядок: «нет реквизитов» (выбери другой способ или подожди пару
 * минут) полезнее, чем «сервис не отвечает», а тот — полезнее, чем общее «не
 * удалось». Незнакомые коды уходят в конец.
 */
const CODE_PRIORITY = ['no_requisite', 'bad_requisite', 'timeout', 'amount', 'method_unavailable',
  'merchant_off', 'route_mismatch', 'invoice_invalid', 'provider_error'];
function summaryErrorCode(codes) {
  const list = (codes || []).map(c => String(c || '')).filter(Boolean);
  if (!list.length) return 'provider_error';
  const rank = c => {
    const i = CODE_PRIORITY.indexOf(c);
    return i === -1 ? CODE_PRIORITY.length : i;
  };
  return list.slice().sort((a, b) => rank(a) - rank(b))[0];
}

function requestIdFor(requestId, providerId) {
  return crypto.createHash('sha256')
    .update(String(requestId || '') + ':' + String(providerId || ''))
    .digest('hex').slice(0, 32);
}

module.exports = {
  PROVIDERS, DEFAULT_ID, MIN_TOTAL, MAX_TOTAL,
  providerIds, provider, nameOf, enabledProviders,
  enabled, configured, payable, limitError, limits, limitFor, boundsOf,
  ownRequisites, ownEnabled, mode,
  availableOptions, health, healthState, chainFor, forgetMethods,
  sameStartRequest, requestIdFor, summaryErrorCode,
  startError: ERR.messageOf, startErrorCode: ERR.codeOf
};
