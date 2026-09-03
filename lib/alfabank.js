'use strict';
/*
 * Альфа-Банк: оплата картой на странице банка, ссылку выдаёт сам шлюз.
 *
 * ЧЕМ ЭТА КАССА ОТЛИЧАЕТСЯ ОТ ДВУХ ОСТАЛЬНЫХ. CrocoPAY и MeridianPay — P2P: они
 * выдают чужой реквизит (карту или телефон трейдера), покупатель переводит на
 * него сам, а пул реквизитов конечен и регулярно кончается. Здесь эквайринг:
 * банк отдаёт АДРЕС СВОЕЙ ПЛАТЁЖНОЙ СТРАНИЦЫ, на которой покупатель вводит
 * карту. Пула нет, отказов «нет свободных реквизитов» не бывает, деньги идут на
 * счёт магазина.
 *
 * ПОЧЕМУ ТОКЕН, А НЕ ЛОГИН С ПАРОЛЕМ. Обычный путь интеграции — `register.do`
 * платёжного шлюза с парой `userName`/`password`, которую банк выдаёт письмом
 * при подключении эквайринга. Её может ещё не быть. Но у Альфы есть второй,
 * документированный вход — «Платёжный виджет», и он авторизуется ТОКЕНОМ, а
 * токен лежит в личном кабинете (Настройки → Платежный токен). Мануал банка про
 * него говорит прямо:
 *
 *   «В отличие от логина и пароля, Токен не является секретным, с его помощью
 *    можно только регистрировать заказы. Выполнение каких-либо других действий,
 *    которые могут представлять угрозу для Вашего магазина или Ваших клиентов,
 *    с его помощью невозможно.»
 *
 * Сам виджет — это кнопка и модальное окно на странице магазина, то есть чужой
 * скрипт на витрине. Мы его НЕ ПОДКЛЮЧАЕМ: у проекта `script-src 'self'`, и
 * пускать туда чужой домен ради кнопки нельзя, а покупателя незачем показывать
 * банку до того, как он решил платить. Вместо этого сервер сам ходит на те же
 * два эндпоинта, которые виджет и использует (они разобраны из его кода,
 * `ecom.alfabank.ru/assets/alfa-payment.js`):
 *
 *   POST /api/rest/register.do   {token, orderNumber, amount, returnUrl, …}
 *                                 → {orderId, formUrl}   ← ссылка на оплату
 *   POST /api/widget/status      {orderId, language}
 *                                 → {orderStatus, message}
 *
 * Проверено живьём 3 сентября 2026: с токеном-заглушкой шлюз отвечает
 * `{"errorCode":"5","errorMessage":"Доступ запрещен"}` — то есть запрос принят и
 * разобран, отказано только в токене.
 *
 * ЧЕГО ЗДЕСЬ НЕТ. Callback-уведомлений: у виджет-эндпоинта их не описано вовсе,
 * и выдумывать подпись мы не станем (та же осторожность, что с `integrity` у
 * MeridianPay). Оплата подтверждается опросом статуса — он и так идёт со
 * страницы оплаты и из фоновой сверки. Способов оплаты у этого пути ровно один —
 * карта на странице банка; валюта только рублёвая.
 */
const https = require('https');
const tls = require('tls');
const crypto = require('crypto');
const ERR = require('./pay-errors');
const PAY = require('./pay-methods');

const CURRENCY = 'RUB';
const MINOR = 100;

/* Единственный способ, который умеет эта касса.
 *
 * Это НЕ `TO_CARD`: тот означает перевод на карту получателя, а здесь покупатель
 * вводит свою карту на странице банка. Подписать эквайринг «переводом на карту»
 * значило бы соврать покупателю ровно там, где он решает, откуда платить.
 */
const METHOD = 'CARD_ONLINE';

/* Сколько живёт счёт. Столько же по умолчанию держит его сам шлюз (20 минут,
 * `sessionTimeoutSecs` в мануале), и мы передаём это число явно, чтобы не
 * зависеть от настроек мерчанта: срок уезжает покупателю на страницу оплаты, и
 * он обязан совпадать с тем, сколько ссылка правда работает.
 *
 * Внутрь нашего окна оплаты заказа (30 минут) это укладывается: не успел —
 * выставит новый счёт, заказ ещё жив.
 */
const SESSION_SECONDS = 1200;

const CREATE_TIMEOUT = 10000;
const STATUS_TIMEOUT = 8000;
const PING_TIMEOUT = 4000;

/*
 * ТЛС: почему здесь пиннинг, а не обычная проверка цепочки.
 *
 * Сертификат `ecom.alfabank.ru` подписан промежуточным «Russian Trusted Sub CA»
 * Минцифры с ключом `77:3D:D9:39…`, а сервер присылает в цепочке ДРУГОЙ
 * промежуточный — с ключом `D1:E1:71:0D…`. Нужного нет ни в присланной цепочке,
 * ни в публичном бандле Минцифры (gu-st.ru), поэтому собрать цепочку снаружи РФ
 * нельзя вовсе: и curl, и Node отвергают соединение. Проверено 3 сентября 2026.
 *
 * Ставить российский корневой сертификат в системное доверие ради этого нельзя —
 * это доверие ко ВСЕМУ, что им подписано, на всей машине. Поэтому соглашаемся
 * ровно на один известный ключ: пин по SHA-256 публичного ключа сервера. Это
 * строже обычной валидации, а не слабее — подходит один-единственный сервер.
 *
 * ПИН ПРИВЯЗАН К КЛЮЧУ, А НЕ К СЕРТИФИКАТУ: перевыпуск с тем же ключом ничего не
 * ломает. Смена ключа — сломает, и это осознанная цена: список пинов ниже
 * пополняется правкой файла, а панель заранее скажет «касса не отвечает»,
 * потому что проверка связи ходит тем же путём.
 */
const HOSTS = {
  live: {
    host: 'ecom.alfabank.ru',
    // Ключ сертификата CN=ecom.alfabank.ru (действует до 20 марта 2027).
    pins: ['gLvYxm0mWfTa7JhDui/7zgN5ZC6va38ho90+7roADyQ=']
  },
  /* Тестовый контур банка. Пина у него нет намеренно: снаружи РФ он отвечает
   * 403 (проверено), сертификата мы не видели, а выдумывать отпечаток нельзя.
   * Пустой список означает обычную проверку цепочки — если сертификат там
   * нормальный, соединение пройдёт само. */
  test: { host: 'tws.egopay.ru', pins: [] }
};

const PATH_REGISTER = '/api/rest/register.do';
const PATH_STATUS = '/api/widget/status';

function trimmed(value) { return String(value == null ? '' : value).trim(); }

// Боевая среда или тестовая. Незнакомое значение — бой: витрина не должна молча
// уехать на тестовый контур и «принимать» деньги, которых не будет.
function envOf(settings) {
  return trimmed(settings && settings.alfabankTest) === '1'
    || (settings && settings.alfabankTest === true) ? HOSTS.test : HOSTS.live;
}

/* Ключи кассы заданы — можно ходить в банк. Токен у Альфы длинный (пример из
 * мануала: `fhojfle6ssav32c6ao42bkcr54`), но точную длину банк не обещает,
 * поэтому проверяем только вид: буквы и цифры, без пробелов. Пустая строка в
 * этом поле роняла бэкенд шлюза в 502 — проверять есть за чем. */
function validToken(value) { return /^[A-Za-z0-9]{16,64}$/.test(trimmed(value)); }
function configured(settings) { return validToken(settings && settings.alfabankToken); }

// Показываем покупателю, только когда включено И токен на месте: галочка без
// токена дала бы кнопку, которая всегда ошибается.
function enabled(settings) {
  return !!(settings && settings.alfabankEnabled) && configured(settings);
}

function toMinor(amount) { return Math.round((Number(amount) || 0) * MINOR); }

// Сумма из уведомления в минимальных единицах. У этого пути callback нет вовсе,
// функция остаётся частью общего контракта провайдера.
function paidEnough(expected, raw) {
  const want = Number(expected) || 0;
  const got = Number(raw);
  if (!Number.isFinite(got)) return { ok: false, major: null };
  return { ok: Math.round(got) >= toMinor(want), major: got / MINOR };
}

/*
 * Состояния заказа платёжного шлюза (мануал мерчанта, раздел getOrderStatus):
 *   0 — зарегистрирован, но не оплачен
 *   1 — предавторизованная сумма захолдирована (двухстадийный платёж)
 *   2 — проведена полная авторизация суммы
 *   3 — авторизация отменена
 *   4 — по транзакции была проведена операция возврата
 *   5 — инициирована авторизация через ACS банка-эмитента
 *   6 — авторизация отклонена
 *
 * Мы работаем одностадийно (`stages: 1`), поэтому деньгами считается только 2.
 * Холд и «ушёл на 3-D Secure» — это ещё не оплата, но и не отказ: покупатель
 * прямо сейчас платит, и заказ обязан остаться ждущим.
 */
const STATUS = { 0: 'pending', 1: 'pending', 2: 'paid', 3: 'cancelled', 4: 'refunded', 5: 'pending', 6: 'failed' };
function stateOf(raw) {
  const n = Number(raw);
  return Number.isFinite(n) && Object.prototype.hasOwnProperty.call(STATUS, n) ? STATUS[n] : '';
}

// orderId уезжает в тело запроса статуса. Шлюз выдаёт UUID; пропускаем только
// то, что на него похоже.
function validInvoiceId(id) {
  return /^[A-Za-z0-9][A-Za-z0-9-]{7,63}$/.test(trimmed(id));
}

/* --------------------------------- Транспорт --------------------------------- */

// Агент на среду, а не на запрос: иначе каждое обращение к банку заново делало
// бы рукопожатие TLS — на странице оплаты это заметная задержка.
const _agents = new Map();
function agentFor(env) {
  const key = env.host + '|' + env.pins.join(',');
  if (_agents.has(key)) return _agents.get(key);
  // Пинов нет — обычная проверка цепочки (тестовый контур).
  const agent = new https.Agent({ keepAlive: true, maxSockets: 8 });
  if (env.pins.length) {
    agent.options.rejectUnauthorized = false;
    /* Проверка идёт в колбэке `tls.connect`, то есть ПЕРВЫМ обработчиком
     * `secureConnect` — раньше, чем http-клиент начнёт писать в сокет. Это
     * важно: не совпал ключ — рвём соединение, и токен наружу не уходит. */
    agent.createConnection = (opts, cb) => {
      const socket = tls.connect(Object.assign({}, opts, { rejectUnauthorized: false }), () => {
        const cert = socket.getPeerCertificate();
        const got = cert && cert.pubkey
          ? crypto.createHash('sha256').update(cert.pubkey).digest('base64') : '';
        if (!env.pins.includes(got)) {
          socket.destroy(new Error('pin_mismatch'));
          return;
        }
        if (cb) cb();
      });
      return socket;
    };
  }
  _agents.set(key, agent);
  return agent;
}

/*
 * Один вход для обоих эндпоинтов. Ошибки не бросаем: вызывающий покажет
 * покупателю понятную фразу, а заказ к этому моменту уже записан.
 *
 * Шлюз отвечает JSON и HTTP 200 даже на отказ (`errorCode` внутри тела), а на
 * статус несуществующего заказа — 200 с ПУСТЫМ телом. Пустой ответ поэтому не
 * ошибка транспорта, а «ничего не знаю про этот заказ».
 */
function post(env, path, payload, timeoutMs) {
  return new Promise(resolve => {
    const body = JSON.stringify(payload);
    let done = false;
    const finish = value => { if (!done) { done = true; resolve(value); } };
    const req = https.request({
      host: env.host, path, method: 'POST', agent: agentFor(env),
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'Content-Length': Buffer.byteLength(body)
      }
    }, res => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { text += chunk.length > 65536 ? '' : chunk; });
      res.on('end', () => {
        const raw = text.trim();
        if (!raw) return finish({ ok: true, data: null, http: res.statusCode });
        let data = null;
        try { data = JSON.parse(raw); } catch (e) { data = null; }
        if (!data || typeof data !== 'object') return finish({ ok: false, error: 'http_' + res.statusCode });
        finish({ ok: true, data, http: res.statusCode });
      });
    });
    req.setTimeout(Number(timeoutMs) || CREATE_TIMEOUT, () => {
      req.destroy(new Error('timeout'));
    });
    req.on('error', e => {
      const message = String((e && e.message) || e);
      finish({ ok: false, error: message === 'pin_mismatch' ? 'tls_pin' : message });
    });
    req.end(body);
  });
}

/* Отказ самого шлюза приходит внутри тела: `errorCode` не ноль плюс
 * `errorMessage` по-русски («Доступ запрещен», «Заказ с таким номером уже
 * зарегистрирован»). Отдаём наружу текст банка — его переведёт общий словарь
 * отказов, а в панели он ляжет в историю попытки как есть. */
function gatewayError(data) {
  const code = Number(data && data.errorCode);
  if (!Number.isFinite(code) || code === 0) return '';
  return trimmed(data && data.errorMessage) || ('error_' + code);
}

/* ------------------------------- Выставить счёт ------------------------------- */

/*
 * Эндпоинт 1 — зарегистрировать заказ и получить ссылку на оплату.
 *
 * `orderNumber` обязан быть уникальным в пределах магазина: повтор шлюз отбивает
 * ошибкой 1 («Заказ с таким номером уже зарегистрирован»). Поэтому номером
 * служит id ПОПЫТКИ, а не номер заказа: у одного заказа попыток бывает
 * несколько (первая касса отказала, покупатель вернулся и нажал снова), и
 * номером заказа они бы столкнулись между собой.
 *
 * Сумма уходит в КОПЕЙКАХ — так её считает и сам виджет (`amount * 100`).
 */
async function createInvoice(settings, params) {
  if (!configured(settings)) return { ok: false, error: 'not_configured' };
  const amount = Number(params && params.amount);
  if (!Number.isFinite(amount) || amount <= 0) return { ok: false, error: 'bad_amount' };
  const method = trimmed(params && params.method);
  if (method && method !== METHOD) return { ok: false, error: 'method_unavailable' };
  const currency = trimmed(params && params.currency).toUpperCase() || CURRENCY;
  // Валюта счёта здесь только рублёвая: виджет-эндпоинт поля валюты не
  // принимает вовсе, и молча выставить счёт в другой было бы обманом.
  if (currency !== CURRENCY) return { ok: false, error: 'currency_unavailable' };
  const orderNumber = trimmed(params && params.externalId).slice(0, 32);
  if (!orderNumber) return { ok: false, error: 'bad_order_number' };
  /* Куда вернуть покупателя после оплаты. Обязателен по документации, и это не
   * формальность: без него банк уведёт человека на свой адрес, и он останется
   * без нашей страницы заказа. */
  const returnUrl = trimmed(params && params.returnUrl);
  if (!/^https?:\/\/\S+$/i.test(returnUrl)) return { ok: false, error: 'bad_return_url' };

  const env = envOf(settings);
  const payload = {
    token: trimmed(settings.alfabankToken),
    orderNumber,
    amount: toMinor(amount),
    returnUrl,
    failUrl: trimmed(params && params.failUrl) || returnUrl,
    language: 'ru',
    // Одностадийный платёж: деньги списываются сразу. Двухстадийный (у виджета
    // он по умолчанию) требует второго запроса на списание, а его в этом пути
    // нет — заказ навсегда остался бы в холде.
    stages: '1',
    sessionTimeoutSecs: SESSION_SECONDS
  };
  const description = trimmed(params && params.description).slice(0, 512);
  if (description) payload.description = description;

  const r = await post(env, PATH_REGISTER, payload, CREATE_TIMEOUT);
  if (!r.ok) return r;
  const data = r.data;
  if (!data) {
    console.error('alfabank invoice: пустой ответ шлюза, HTTP', r.http);
    return { ok: false, error: 'empty_response' };
  }
  const failure = gatewayError(data);
  if (failure) return { ok: false, error: failure };

  const id = trimmed(data.orderId);
  const formUrl = trimmed(data.formUrl);
  if (!validInvoiceId(id) || !formUrl) {
    console.error('alfabank invoice: ответ без', validInvoiceId(id) ? 'ссылки' : 'id',
      '— ключи:', Object.keys(data).join(','));
    return { ok: false, error: validInvoiceId(id) ? 'no_requisite' : 'no_invoice_id' };
  }
  /* Ссылка уедет покупателю в `href`, поэтому проверяем её тем же правилом, что
   * и ссылочные реквизиты касс: только https и явный хост. Банк, конечно,
   * присылает свой адрес — но полагаться на это нельзя, значение приходит
   * снаружи. */
  if (!PAY.isPayLink(formUrl)) {
    console.error('alfabank invoice: ссылка не похожа на платёжную');
    return { ok: false, error: 'bad_requisite', reason: 'link' };
  }
  return {
    ok: true,
    invoice: {
      id,
      state: 'pending',
      amount,
      currency: CURRENCY,
      method: METHOD,
      requisite: formUrl,
      /* Ни банка, ни получателя тут нет намеренно. Строка «Банк получателя» —
       * это про то, КУДА покупатель переводит деньги сам; при оплате картой он
       * никуда не переводит, а получатель — сам магазин. Заодно это соблюдает
       * общее правило витрины: имя кассы покупателю не показывается (домен в
       * ссылке он, конечно, увидит — но это адрес, куда он идёт платить, а не
       * подпись в нашем интерфейсе). Менеджеру касса видна в панели отдельно. */
      bank: '',
      owner: '',
      expiresAt: Date.now() + SESSION_SECONDS * 1000
    }
  };
}

/* Повторять POST автоматически здесь нечего.
 *
 * У P2P-касс единственный безопасный повтор — «нет свободных реквизитов»: пул
 * мог освободиться за секунду. У эквайринга пула нет вовсе, а любой другой
 * отказ (таймаут, чужая пятисотка) двусмыслен: заказ мог зарегистрироваться, и
 * второй POST выдал бы второй счёт на те же деньги.
 */
function retryableStart() { return false; }

/* ------------------------------- Статус счёта ------------------------------- */

/*
 * Эндпоинт 2 — что с оплатой. Тот же, что опрашивает виджет.
 *
 * ЧТО ОН НЕ ВОЗВРАЩАЕТ: ни суммы, ни валюты. Поэтому сверять их при
 * подтверждении нечем — и это осознанно принятая граница, а не недосмотр:
 * сумму назначили МЫ сами в `register.do`, изменить её покупатель не может, а
 * шлюз выставляет счёт ровно на неё. Проверяем то, что есть, — что это тот
 * самый заказ и что он оплачен.
 */
async function invoice(settings, id) {
  if (!configured(settings)) return { ok: false, error: 'not_configured' };
  if (!validInvoiceId(id)) return { ok: false, error: 'bad_invoice_id' };
  const env = envOf(settings);
  const r = await post(env, PATH_STATUS, { orderId: trimmed(id), language: 'ru' }, STATUS_TIMEOUT);
  if (!r.ok) return r;
  // Пустое тело — шлюз про такой заказ ничего не сказал. Это не «не оплачен»:
  // молча объявить чужой ответ отказом значило бы закрыть живой платёж.
  if (!r.data) return { ok: false, error: 'unknown_order' };
  const failure = gatewayError(r.data);
  if (failure) return { ok: false, error: failure };
  const state = stateOf(r.data.orderStatus);
  if (!state) return { ok: false, error: 'unknown_status' };
  return {
    ok: true,
    invoice: {
      id: trimmed(id), state, amount: 0, currency: CURRENCY, method: METHOD,
      requisite: '', bank: 'Альфа-Банк', owner: '', expiresAt: 0
    }
  };
}

/*
 * Подтверждать оплату вправе только точное совпадение по конкретному счёту.
 *
 * Сумму и валюту статус не отдаёт (см. выше), поэтому сверяется идентификатор —
 * тот самый `orderId`, который вернул `register.do` и который лежит в попытке.
 * Способ у этой кассы один, сверять его не с чем.
 */
function matchesInvoice(expected, actual) {
  expected = expected || {};
  actual = actual || {};
  const invoiceId = trimmed(expected.invoiceId);
  if (!invoiceId || trimmed(actual.id) !== invoiceId) return { ok: false, reason: 'invoice_id' };
  return { ok: true };
}

// Отпечаток идемпотентного запроса: тот же, что у остальных касс. Сменилась
// сумма — это уже другой запрос, даже если браузер прислал прежний ключ.
function sameStartRequest(expected, actual) {
  expected = expected || {};
  actual = actual || {};
  return trimmed(expected.method) === trimmed(actual.method)
    && trimmed(expected.currency).toUpperCase() === trimmed(actual.currency).toUpperCase()
    && toMinor(expected.amount) === toMinor(actual.amount);
}

/* --------------------------- Что включено у кассы --------------------------- */

/*
 * Список способов у Альфы спрашивать негде: этот путь умеет ровно одно — карту
 * на странице банка. Но ответить статикой мало: панель обязана говорить, что
 * происходит НА САМОМ ДЕЛЕ, а у нас тут пин по ключу сертификата, который
 * однажды сменится. Поэтому связь проверяем настоящим запросом — статусом
 * заведомо несуществующего заказа. Он ничего не создаёт и не меняет, а отвечает
 * тем же путём, каким пойдут боевые запросы: не тот сертификат, нет сети,
 * закрытый контур — всё это видно сразу и в панели.
 *
 * Кэш на пять минут, как у остальных касс: список спрашивают на каждой странице
 * оплаты, а меняться ему негде.
 */
const _live = { key: '', at: 0, ok: false, error: '' };
const LIVE_TTL = 5 * 60 * 1000;

function optionsShape(extra) {
  return Object.assign({
    ok: true,
    currencies: [CURRENCY],
    byCurrency: { [CURRENCY]: [METHOD] },
    options: [METHOD]
  }, extra || {});
}

async function availableOptions(settings) {
  if (!configured(settings)) return { ok: false, error: 'not_configured' };
  const env = envOf(settings);
  const key = env.host + '|' + trimmed(settings.alfabankToken).slice(0, 8);
  if (_live.key === key && Date.now() - _live.at < LIVE_TTL) {
    return _live.ok ? optionsShape({ cached: true }) : { ok: false, error: _live.error, cached: true };
  }
  const r = await post(env, PATH_STATUS, {
    orderId: '00000000-0000-0000-0000-000000000000', language: 'ru'
  }, PING_TIMEOUT);
  _live.key = key;
  _live.at = Date.now();
  _live.ok = !!r.ok;
  _live.error = r.ok ? '' : String(r.error || '');
  if (!r.ok) return { ok: false, error: _live.error };
  return optionsShape();
}

function forgetMethods() { _live.key = ''; _live.at = 0; _live.ok = false; _live.error = ''; }

/* ------------------------------- Мелочи контракта ------------------------------- */

// Способ у этой кассы один. Незнакомый код перевести не во что — в отличие от
// CrocoPAY, где id способа и есть её собственный код.
function supports(methodId) { return trimmed(methodId) === METHOD; }

/*
 * Возьмётся ли за такую сумму. Дробные суммы шлюз принимает (сумма уходит в
 * копейках), нижней границы у него своей нет — общие пределы одной покупки уже
 * проверены маршрутом.
 */
function acceptsAmount(amount, currency) {
  const sum = Number(amount);
  if (!Number.isFinite(sum) || sum <= 0) return false;
  return (trimmed(currency).toUpperCase() || CURRENCY) === CURRENCY;
}

/*
 * Callback у этого пути не описан вовсе, поэтому уведомлениям мы не верим
 * никогда: оплата подтверждается только опросом статуса. Возвращать `true`
 * «на всякий случай» нельзя — это открытая дверь к чужому «заказ оплачен».
 */
function verifyCallback() { return false; }

module.exports = {
  id: 'alfabank', name: 'Альфа-Банк',
  METHOD, CURRENCY, MINOR, SESSION_SECONDS,
  // `validToken` наружу нужен форме настроек: она проверяет токен ДО записи, как
  // и всё остальное в ней.
  configured, enabled, supports, acceptsAmount, toMinor, paidEnough, stateOf, validInvoiceId, validToken,
  createInvoice, startError: ERR.messageOf, startErrorCode: ERR.codeOf, retryableStart,
  matchesInvoice, sameStartRequest, invoice, availableOptions, forgetMethods, verifyCallback
};
