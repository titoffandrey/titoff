'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const FEE = require('../public/payment-fee');
const PAY = require('../lib/pay-methods');
const PAYMENTS = require('../lib/payments');
const CROCO = require('../lib/crocopay');
const R = require('../lib/render');
const admin = require('../lib/admin-views');
const prompt = require('../lib/chat-prompt');
const db = require('../lib/db');
const { mergeSettings } = require('../scripts/import-store');

const merchant = '00000000-0000-4000-8000-000000000001';
const secret = 'platega-ui-test-secret';
function settings() {
  return Object.assign(db.defaultSettings(), {
    storeName: 'Тестовый магазин', plategaEnabled: true,
    plategaMerchantId: merchant, plategaSecret: secret
  });
}
function order(status) {
  const now = Date.now();
  const payment = {
    id: 'a'.repeat(24), attemptId: 'a'.repeat(24), provider: 'platega',
    invoiceId: '00000000-0000-4000-8000-000000000002', method: 'ONLINE_PAYMENT',
    requisite: 'https://payment.example/invoice', status, amount: 67990, currency: 'RUB',
    startedAt: now - 60000, expiresAt: now + 600000, closedAt: status === 'refunded' ? now : 0,
    note: status === 'refunded' ? 'Возврат подтверждён сервисом' : ''
  };
  return {
    id: 'order-ui', number: '482913', total: 67990, createdAt: now - 60000,
    items: [{ id: 'p1', name: 'Товар', qty: 1, price: 67990 }],
    payment: Object.assign({}, payment, { attempts: [payment] })
  };
}

test('онлайн-оплата доступна по умолчанию только у поддерживающей её кассы', () => {
  assert.equal(PAY.isHosted('ONLINE_PAYMENT'), true);
  assert.equal(PAY.isDomestic('ONLINE_PAYMENT'), true);
  assert.ok(PAY.DEFAULT_IDS.includes('ONLINE_PAYMENT'));
  assert.equal(PAY.describe('ONLINE_PAYMENT', 'platega').name, 'Онлайн-оплата');
  assert.equal(CROCO.supports('ONLINE_PAYMENT'), false);
  assert.deepEqual(PAYMENTS.offeredMethods(settings()), [{ id: 'ONLINE_PAYMENT', provider: 'platega' }]);
});

test('в панели Platega есть доступ и инструкция callback, секрет остаётся скрытым', () => {
  const s = { ...settings(), plategaFeePercent: 8.5 };
  const html = admin.settingsPage(s, { pendingReviewCount: () => 0 }, null);
  assert.match(html, /name="plategaEnabled" checked/);
  assert.match(html, /name="plategaMerchantId" value="00000000-0000-4000-8000-000000000001"/);
  assert.match(html, /name="plategaSecret" type="password" value=""/);
  assert.match(html, /name="clearPlategaSecret"/);
  assert.match(html, /\/api\/pay\/platega\/callback/);
  assert.match(html, /https:\/\/docs\.platega\.io\//);
  assert.match(html, /Комиссия Platega, включённая в цены, %/);
  assert.match(html, /name="plategaFeePercent" type="number" min="0" max="100" step="0\.01" value="8\.5"/);
  assert.match(html, /Он сидит внутри цены: кассе уходит цена без него/);
  assert.doesNotMatch(html, /Комиссия сверху для покупателя/);
  /* Потолок одного платежа — настройка рядом с тарифом: лимит СБП Platega
   * (20 000 ₽ вместе с комиссией) публично не описан, значит его могут поднять,
   * и владелец впишет число сам. Подсказка называет путь заказа дороже. */
  assert.match(html, /name="plategaMaxTotal" inputmode="numeric" autocomplete="off"\s*value="20000" placeholder="20000"/);
  assert.match(html, /Заказ дороже уходит заявкой — менеджер связывается с покупателем сам/);
  const withOwn = admin.settingsPage({ ...s, plategaMaxTotal: 50000, ownPayEnabled: true, ownPayPhone: '+79991234567', ownPayOwner: 'Иван И.' }, { pendingReviewCount: () => 0 }, null);
  assert.match(withOwn, /value="50000" placeholder="20000"/);
  assert.match(withOwn, /Заказ дороже уходит переводом по своим реквизитам/);
  assert.match(withOwn, /на них уходят заказы дороже 50\s000\s₽/, 'свёртка своих реквизитов знает про запасной путь');
  assert.match(withOwn, /В кассу уходят заказы до 50\s000\s₽, дороже — переводом по своим реквизитам/);
  // Свёрнутая строка раздела оплаты тоже называет порог и путь за ним.
  const summary = admin.paySummary ? admin.paySummary(s, []) : null;
  if (summary) assert.match(summary[1], /до 20\s000\s₽, дороже — заявкой/);
  assert.doesNotMatch(html, new RegExp(secret));
  const disabled = admin.settingsPage(s, {}, null, '', { draft: { storeName: s.storeName } });
  assert.doesNotMatch(disabled, /name="plategaEnabled" checked/);
});

test('статический список способов не выдаётся в панели за проверенную связь', () => {
  const methods = ['ONLINE_PAYMENT'];
  const live = {
    ok: true, methods, currencies: ['RUB'], byCurrency: { RUB: methods },
    byProvider: { platega: { methods, currencies: ['RUB'], byCurrency: { RUB: methods } } },
    status: { platega: { ok: true, verified: false, methods, currencies: ['RUB'] } }
  };
  const html = admin.settingsPage(settings(), {}, null, '', { live });
  assert.match(html, /ключи заданы · связь ещё не проверена/);
  assert.doesNotMatch(html, /ни одна касса не отвечает|Молчит Platega/);
  assert.match(html, /class="pay-method-check">\s*<input[^>]*value="ONLINE_PAYMENT" checked/);
});

test('витрина и консультант описывают выбор способа на странице оплаты без имени кассы и ручного перевода', () => {
  const s = settings();
  const pending = order('pending');
  const html = R.payPage(s, pending, { origin: '', methods: [PAY.find('ONLINE_PAYMENT')] });
  const card = html.slice(html.indexOf('<div class="pay-wrap">'), html.indexOf('<script', html.indexOf('<div class="pay-wrap">')));
  assert.match(card, /Выберите доступный способ/);
  assert.match(card, /На оплату осталось/);
  assert.doesNotMatch(card, /Страница оплаты через СБП|Открыть в приложении банка/);
  assert.match(card, /target="_blank" rel="noopener noreferrer">Перейти к оплате/);
  assert.doesNotMatch(card, /странице банка|точную сумму|Оплата картой|Сумма перевода|Переведите сумму/i);
  const choice = R.payPage(s, Object.assign({}, pending, { payment: null }), { origin: '', methods: [PAY.find('ONLINE_PAYMENT')] });
  assert.match(choice, /id="pay-create">Перейти к оплате/);
  assert.match(choice, /data-hosted="1"/);
  const facts = prompt.storeText(s);
  assert.match(facts, /Онлайн-оплата:.*выбирает СБП или другой доступный там способ — сумма уже указана/);
  assert.doesNotMatch(facts, /сразу открывается защищённая страница оплаты через СБП/);
  assert.doesNotMatch(facts, /странице банка|ТОЧНУЮ СУММУ|эквайринг|перевод по реквизитам/);
  for (const page of [html, choice, R.checkoutPage(s, { origin: '', payCashbox: true }), facts]) {
    assert.doesNotMatch(page, new RegExp(merchant + '|' + secret));
    assert.doesNotMatch(page, /Platega/i);
  }
});

test('старый счёт прямого СБП сохраняет ссылку и инструкции после перехода к выбору способов', () => {
  const pending = order('pending');
  pending.payment.method = 'SBP_ONLINE';
  pending.payment.attempts[0].method = 'SBP_ONLINE';
  const html = R.payPage(settings(), pending, { methods: [PAY.find('ONLINE_PAYMENT')] });
  // Подсказок у СБП-ссылки нет — ни на странице, ни в карточке способа (снял владелец).
  assert.doesNotMatch(html, /Ссылка СБП|Ссылка откроется в приложении банка|class="pay-hint"/);
  assert.match(html, /href="https:\/\/payment\.example\/invoice"/);
  assert.doesNotMatch(html, /id="pay-create"/);
});

test('возврат закрывает оплату, не показывает реквизиты и исключается из выручки', () => {
  const refunded = order('refunded');
  // Даже старая действующая попытка или ручная отметка не открывает оплату.
  refunded.payment.attempts.push(order('pending').payment.attempts[0]);
  refunded.manualPaid = { at: Date.now() };
  assert.equal(R.payDisplay(refunded.payment).status, 'refunded');
  assert.equal(R.payClosed(refunded, Date.now(), false), true);
  assert.equal(R.payExpired(refunded, Date.now() + 3600000), false);
  assert.equal(R.orderTone(refunded), 'off');
  assert.match(R.orderStatus(refunded), /возврат платежа/);
  assert.match(R.orderStatus(refunded), /Возврат подтверждён сервисом/);
  const html = R.payPage(settings(), refunded, { origin: '', methods: [PAY.find('ONLINE_PAYMENT')] });
  assert.match(html, /Платёж возвращён/);
  assert.doesNotMatch(html, /id="pay-create"|id="pay-recheck"|data-paid="1"|Платёж получен|Товарный чек|Перейти к оплате/);
  assert.equal(R.orderStats([refunded]).revenue, 0);
  assert.equal(R.orderStats([refunded]).paid, 0);
  const log = admin.paymentsPage(settings(), { getOrders: () => [refunded] }, {});
  assert.match(log, /возврат платежа/);
  assert.match(log, /Возврат подтверждён сервисом/);
});

test('перенос магазина сбрасывает все настройки Platega', () => {
  const normal = mergeSettings(settings()).merged;
  assert.equal(normal.plategaEnabled, false);
  assert.equal(normal.plategaMerchantId, '');
  assert.equal(normal.plategaSecret, '');
  const kept = mergeSettings(settings(), { keep: true }).merged;
  assert.equal(kept.plategaMerchantId, merchant);
  assert.equal(kept.plategaSecret, secret);
});

test('выбор онлайн-оплаты ведёт на HTTPS-страницу, а негодная или отсутствующая ссылка — к своему заказу', async () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'public', 'pay.js'), 'utf8');
  const from = source.indexOf('  function startPayment(');
  const to = source.indexOf('  if (create) {', from);
  assert.ok(from > 0 && to > from);
  const make = new Function('env', `const { orderId, currency, total, chosenMethod, chosenHosted,
    requestKey, paymentRequestId, clearPaymentRequest, fetch, reachGoal, showMsg, window, document, location } = env;
    ${source.slice(from, to)}
    return startPayment;`);
  for (const [hosted, hostedUrl, expected] of [
    // Ссылка кассы годная — уходим на СВОЮ страницу оплаты с `?go=1`: она
    // откроет ссылку сама и останется в истории (autoOpen в pay.js).
    [true, 'https://payment.example/invoice?id=1', '/pay/order-ui?go=1'],
    [true, undefined, '/pay/order-ui'],
    [true, 'javascript:alert(1)', '/pay/order-ui'],
    [true, 'http://payment.example/invoice', '/pay/order-ui'],
    [true, 'https://user:secret@payment.example/invoice', '/pay/order-ui'],
    [true, '//payment.example/invoice', '/pay/order-ui'],
    [false, 'https://payment.example/invoice', '/pay/order-ui']
  ]) {
    const location = { origin: 'https://shop.example', href: '' };
    const goals = [];
    const start = make({
      orderId: 'order-ui', currency: 'RUB', total: 67990,
      chosenMethod: () => hosted ? 'ONLINE_PAYMENT' : 'SBP', chosenHosted: () => hosted,
      requestKey: () => 'request-key', paymentRequestId: () => 'a'.repeat(32),
      clearPaymentRequest() {}, showMsg() {}, window: {}, document: {}, location,
      fetch: async () => ({ status: 200, json: async () => ({ ok: true, url: '/pay/order-ui', hostedUrl }) }),
      reachGoal: (name, _params, _key, go) => { goals.push(name); if (go) go(); }
    });
    start({ disabled: false, textContent: '' }, hosted ? 'Перейти к оплате' : 'Получить реквизиты');
    await new Promise(setImmediate);
    assert.equal(location.href, expected, `${hosted}: ${hostedUrl}`);
    assert.deepEqual(goals, ['order'], 'переход идёт после цели заказа');
  }
});

test('комиссия считается одинаково на сервере и в браузере с округлением до копейки', () => {
  const browser = { window: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'public', 'payment-fee.js'), 'utf8'), browser);
  for (const [base, percent, amount, total] of [
    [1000, 8.5, 85, 1085], [19.99, 8.5, 1.7, 21.69],
    [0.5, 1, 0.01, 0.51], [0.49, 1, 0, 0.49],
    [99999.99, 8.5, 8500, 108499.99], [1000, 0, 0, 1000], [0, 8.5, 0, 0]
  ]) {
    const expected = { baseAmount: base, amount, percent, total };
    assert.deepEqual(FEE.quote(base, percent), expected);
    assert.deepEqual(JSON.parse(JSON.stringify(browser.window.PaymentFee.quote(base, percent))), expected);
  }
  for (const invalid of [undefined, null, '', '8.5', NaN, Infinity, -1, 1.234, {}, []]) {
    assert.equal(FEE.quote(1000, invalid), null);
    assert.equal(FEE.quote(invalid, 8.5), null);
  }
  assert.equal(FEE.quote(1000, 100.01), null);
  assert.equal(FEE.quote(Number.MAX_SAFE_INTEGER, 8.5), null);
});

test('оформление получает процент только при наличии Platega и различает прямую оплату и выбор', () => {
  const s = { ...settings(), plategaFeePercent: 8.5 };
  const html = R.checkoutPage(s, { payCashbox: true });
  assert.match(html, /data-payment-fee-percent="8\.5"/);
  // Потолок Platega уезжает рядом с процентом: дороже него расчёт её суммы не нужен.
  assert.match(html, /data-payment-fee-max="20000"/);
  assert.match(html, /data-pay-cashbox="1" data-pay-min="1000" data-pay-max="20000"/);
  const raised = R.checkoutPage({ ...s, plategaMaxTotal: 75000 }, { payCashbox: true });
  assert.match(raised, /data-payment-fee-max="75000"/);
  assert.match(raised, /data-pay-max="75000"/);
  assert.match(html, /data-pay-flow="choice"/);
  assert.ok(html.indexOf('/static/payment-fee.js?') < html.indexOf('/static/app.js?'));
  assert.match(R.checkoutPage({ ...s, plategaFeePercent: 0 }, { payCashbox: true }), /data-payment-fee-percent="0"/);
  const mixed = R.checkoutPage({ ...s, crocopayEnabled: true, crocopayClientId: 'test', crocopayClientSecret: 'test' }, { payCashbox: true });
  assert.match(mixed, /data-payment-fee-percent="8\.5"/);
  assert.match(mixed, /data-pay-flow="choice"/);
  assert.doesNotMatch(mixed, /data-pay-flow="sbp"/);
  for (const [configured, opts] of [
    [{ ...s, plategaEnabled: false }, { payCashbox: true }],
    [s, { payCashbox: false }],
    [{ ...s, plategaEnabled: false, crocopayEnabled: true, crocopayClientId: 'test', crocopayClientSecret: 'test' }, { payCashbox: true }]
  ]) {
    const noFee = R.checkoutPage(configured, opts);
    assert.doesNotMatch(noFee, /data-payment-fee-percent|\/static\/payment-fee\.js/);
  }
});

test('оформление не показывает пояснения о способе оплаты под кнопкой', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  assert.doesNotMatch(source, /function payNote\(|checkout-pay-note/);
  assert.doesNotMatch(source, /Оплата через СБП на защищённой странице|Способ оплаты выберете на следующем шаге/);
});

test('оформление сохраняет цены и итог без строки комиссии после скидки и смены доставки', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  const rail = source.slice(source.indexOf('  function lineLabel('), source.indexOf('  // ===== Оплата и доставка ====='));
  const total = source.slice(source.indexOf('  function orderTotal('), source.indexOf('  function addressValue('));
  const side = { innerHTML: '' };
  const page = { dataset: { pay: '1', payCashbox: '1', payFallback: 'request', paymentFeePercent: '8.5' } };
  let goods = 1000, ship = null, saved = 0;
  const env = {
    document: { getElementById: id => id === 'checkout-page' ? page : id === 'checkout-side' ? side : null },
    window: { PaymentFee: FEE },
    Cart: { items: [{}], availableCount: () => 1, total: () => goods, saved: () => saved },
    money: n => n + ' ₽', shipCurrent: () => ship, deliveryName: () => 'СДЭК',
    deliveryModeName: () => 'Курьер', shipDaysCurrent: () => '2–4 дня',
    promoView: { on: true, code: 'SALE' }, escapeHtml: s => s, coIcon: () => ''
  };
  const ui = new Function('env', `const { document, window, Cart, money, shipCurrent,
    deliveryName, deliveryModeName, shipDaysCurrent, promoView, escapeHtml, coIcon } = env;
    ${rail}\n${total}\nreturn { renderRail, orderTotal, checkoutFeeQuote, checkoutMode };`)(env);
  ui.renderRail();
  assert.doesNotMatch(side.innerHTML, /комисси|8,5%|co-line-fee/i);
  assert.match(side.innerHTML, /по адресу/);
  assert.match(side.innerHTML, /Итого<\/span><b>1000 ₽/);
  ship = 200;
  ui.renderRail();
  assert.match(side.innerHTML, /Доставка<\/span><span>200 ₽/);
  assert.doesNotMatch(side.innerHTML, /комисси|co-line-fee/i);
  assert.equal(ui.orderTotal(), 1200);
  goods = 900; saved = 100;
  ui.renderRail();
  assert.match(side.innerHTML, /Промокод SALE/);
  assert.match(side.innerHTML, /Товары \(1\)<\/span><span>1000 ₽/);
  assert.doesNotMatch(side.innerHTML, /комисси|co-line-fee/i);
  assert.equal(ui.orderTotal(), 1100);
  page.dataset.paymentRoundedOnly = '1';
  ui.renderRail();
  assert.equal(ui.orderTotal(), 1099, 'единственная касса показывает скидку до прямого перехода');
  assert.match(side.innerHTML, /Скидка при оплате/);
  assert.match(side.innerHTML, /Итого<\/span><b>1099 ₽/);
  delete page.dataset.paymentRoundedOnly;
  page.dataset.paymentFeePercent = '12';
  ui.renderRail();
  assert.equal(ui.orderTotal(), 1100, 'смена тарифа меняет расходы магазина, но не сумму покупателя');
  assert.doesNotMatch(side.innerHTML, /комисси|co-line-fee/i);
  page.dataset.paymentFeePercent = '8.5';
  goods = 10.1; ship = 0.2;
  assert.deepEqual(ui.checkoutFeeQuote(), { mode: 'included', rounding: 'rubles',
    baseAmount: 9.22, amount: 0.78, percent: 8.5, total: 10.3,
    originalTotal: 10.3, paymentTotal: 10, discount: 0.3, direct: false });
  page.dataset.paymentFeePercent = '';
  assert.equal(ui.checkoutFeeQuote(), null, 'пустой процент не принимается за нулевой тариф');
  page.dataset.paymentFeePercent = '8.5';
  env.window.PaymentFee = {};
  assert.equal(ui.checkoutFeeQuote(), null, 'старый или неполный модуль не создаёт ошибку JavaScript');
  env.window.PaymentFee = FEE;
  delete page.dataset.paymentFeePercent;
  ui.renderRail();
  assert.doesNotMatch(side.innerHTML, /Комиссия/);
  assert.equal(ui.orderTotal(), 10.1 + 0.2);
  /* Потолок Platega: сумма кассы выше него — заказ уходит другим путём, и
   * скидки кассы у него нет: покупатель платит ценник. */
  page.dataset.paymentFeePercent = '8.5';
  page.dataset.paymentRoundedOnly = '1';
  page.dataset.paymentFeeMax = '20000';
  goods = 19000; ship = 500; saved = 0;
  ui.renderRail();
  assert.equal(ui.checkoutMode(), 'cashbox');
  assert.equal(ui.orderTotal(), 19500);
  goods = 21000;
  ui.renderRail();
  assert.equal(ui.checkoutMode(), 'request');
  assert.equal(ui.orderTotal(), 21500);
  assert.doesNotMatch(side.innerHTML, /Скидка при оплате/);
  assert.equal(ui.checkoutFeeQuote().overLimit, true);
});

test('в запрос заказа входят процент Platega и прежний итог, другие способы не получают поля комиссии', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  const begin = source.indexOf('  function submitOrder(');
  const send = source.indexOf("    fetch('/api/order'", begin);
  const env = {
    rememberCheckout() {}, document: { getElementById: () => ({ value: 'Тест' }) },
    phoneCheck: () => ({ ok: true }), phoneValue: () => '+79990000000', ship: {},
    deliveryChoice: () => 'cdek', deliveryModeChoice: () => 'courier', pickup: {},
    totalLimitError: () => '', orderTotal: () => 1000, checkoutMode: () => 'cashbox',
    checkoutAmountError: () => '',
    Cart: { items: [{ id: 'p1', qty: 1, price: 1000 }] }, promoFields() {},
    orderRequestId: () => 'test-request'
  };
  for (const fee of [FEE.included(1000, 8.5), FEE.included(1000, 0), null]) {
    const make = new Function('env', 'checkoutFeeQuote', `const { rememberCheckout, document, phoneCheck,
      phoneValue, ship, deliveryChoice, deliveryModeChoice, pickup, totalLimitError, orderTotal,
      checkoutMode, Cart, promoFields, orderRequestId, checkoutAmountError } = env;
      ${source.slice(begin, send)}\nreturn payload; }\nreturn submitOrder;`);
    const payload = make(env, () => fee)({ innerHTML: 'Оплатить' });
    if (fee) {
      assert.equal(payload.paymentFeePercent, fee.percent);
      assert.equal(payload.paymentTotal, 1000);
    } else {
      assert.equal(Object.hasOwn(payload, 'paymentFeePercent'), false);
      assert.equal(Object.hasOwn(payload, 'paymentTotal'), false);
    }
    assert.equal(payload.items[0].price, 1000, 'цена товара не подменяется суммой с комиссией');
  }
  // Заказ дороже кассы полей комиссии не несёт: он в Platega не пойдёт.
  const away = new Function('env', 'checkoutFeeQuote', `const { rememberCheckout, document, phoneCheck,
    phoneValue, ship, deliveryChoice, deliveryModeChoice, pickup, totalLimitError, orderTotal,
    checkoutMode, Cart, promoFields, orderRequestId, checkoutAmountError } = env;
    ${source.slice(begin, send)}\nreturn payload; }\nreturn submitOrder;`)(
    { ...env, checkoutMode: () => 'request' }, () => FEE.included(1000, 8.5))({ innerHTML: 'Оформить заказ' });
  assert.equal(Object.hasOwn(away, 'paymentFeePercent'), false);
});

test('неизвестная или устаревшая доставка блокирует Platega до показа полного итога', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  const amount = source.slice(source.indexOf('  function checkoutAmountError('), source.indexOf('  function addressValue('));
  const sync = source.slice(source.indexOf('  function syncSubmit('), source.indexOf('  // Адрес меняет зону'));
  const begin = source.indexOf('  function submitOrder(');
  const send = source.indexOf("    fetch('/api/order'", begin);
  const button = { innerHTML: 'Оплатить', querySelector: () => ({ textContent: '' }) };
  const message = { dataset: {}, value: '' };
  const ship = { valid: true, pending: false, key: '1000|Адрес', address: 'Адрес' };
  let address = 'Адрес', price = 0, percent = 8.5, hasFee = true, configured = true;
  const env = {
    rememberCheckout() {}, document: { getElementById: id => id === 'checkout-submit' ? button
      : id === 'order-msg' ? message : id === 'co-btn-ico' ? { dataset: {} } : id === 'checkout-page'
        ? { dataset: configured ? { paymentFeePercent: String(percent) } : {} } : { value: address } },
    phoneCheck: () => ({ ok: true }), phoneValue: () => '+79990000000', ship,
    deliveryChoice: () => 'cdek', deliveryModeChoice: () => 'courier', pickup: {},
    totalLimitError: () => '', orderTotal: () => 1000, checkoutMode: () => 'cashbox', coIcon: () => '',
    Cart: { items: [{ id: 'p1', qty: 1, price: 1000 }], total: () => 1000, availableCount: () => 1 },
    promoFields() {}, orderRequestId: () => 'test-request', setText() {}, money: String,
    submitLabel: () => 'Оплатить', addressValue: () => address, shipCurrent: () => price,
    checkoutFeeQuote: () => hasFee ? FEE.included(1000, percent) : null
  };
  const ui = new Function('env', `const { rememberCheckout, document, phoneCheck,
    phoneValue, ship, deliveryChoice, deliveryModeChoice, pickup, totalLimitError, orderTotal,
    checkoutMode, coIcon, Cart, promoFields, orderRequestId, setText, money, submitLabel,
    addressValue, shipCurrent, checkoutFeeQuote } = env;
    ${amount}\n${sync}\n${source.slice(begin, send)}\nreturn payload; }
    return { syncSubmit, submitOrder };`)(env);
  ui.syncSubmit();
  assert.equal(button.disabled, false, 'подтверждённая бесплатная доставка допустима');
  assert.equal(ui.submitOrder(button).paymentTotal, 1000);
  for (const change of [
    () => { ship.pending = true; }, () => { ship.valid = false; },
    () => { ship.key = '900|Адрес'; }, () => { address = 'Другой адрес'; },
    () => { price = null; }
  ]) {
    ship.valid = true; ship.pending = false; ship.key = '1000|Адрес'; address = 'Адрес'; price = 0;
    change();
    ui.syncSubmit();
    assert.equal(button.disabled, true);
    assert.match(message.textContent, /Дождитесь расчёта доставки/);
    assert.equal(ui.submitOrder(button), undefined, 'обход отключённой кнопки не отправляет заказ');
  }
  percent = 0;
  ui.syncSubmit();
  assert.equal(button.disabled, true, 'нулевой тариф Platega тоже требует полного итога');
  hasFee = false;
  ui.syncSubmit();
  assert.equal(button.disabled, true, 'невозможность вычислить сумму не разрешает отправить заказ');
  assert.match(message.textContent, /Не удалось проверить сумму заказа/);
  assert.equal(ui.submitOrder(button), undefined);
  configured = false;
  ui.syncSubmit();
  assert.equal(button.disabled, false, 'поведение других платёжных способов сохранено');
});

test('включённая комиссия не видна на странице оплаты и в товарном чеке после смены тарифа', () => {
  const s = { ...settings(), plategaFeePercent: 12 };
  const paid = {
    ...order('paid'), itemsTotal: 900, deliveryPrice: 100, total: 1000,
    items: [{ id: 'p1', name: 'Товар', qty: 1, price: 900 }],
    paymentFee: { provider: 'platega', method: 'ONLINE_PAYMENT', ...FEE.included(1000, 8.5) }
  };
  paid.payment.amount = 1000;
  paid.payment.attempts[0].amount = 1000;
  const receipt = R.receiptPage(s, paid);
  assert.match(receipt, /Товары<\/dt><dd>900\s₽/);
  assert.match(receipt, /Доставка<\/dt><dd>100\s₽/);
  assert.match(receipt, /Итого<\/dt><dd>1\s000\s₽/);
  for (const page of [receipt, R.payPage(s, paid)]) {
    assert.doesNotMatch(page, /комисси|8,5%|12%/i);
  }
});

test('сумма со скидкой видна до выбора оплаты, а чек вычитает её из исходного заказа', () => {
  const s = settings();
  const { total, ...fee } = FEE.checkout(1100, 8.5);
  const original = { ...order('pending'), total: 1100, itemsTotal: 1000, deliveryPrice: 100,
    payment: null, items: [{ id: 'p1', name: 'Товар', qty: 1, price: 1000 }],
    paymentFee: { provider: 'platega', method: 'ONLINE_PAYMENT', ...fee } };
  const choice = R.payPage(s, original, {
    methods: [PAY.describe('ONLINE_PAYMENT', 'platega'), PAY.describe('CARD_ONLINE', 'alfabank')],
    currency: 'RUB', amount: 1100, methodAmounts: { ONLINE_PAYMENT: 1099, CARD_ONLINE: 1100 }
  });
  assert.match(choice, /К оплате 1\s099\s₽ · скидка 1\s₽/);
  assert.match(choice, /К оплате 1\s100\s₽/);
  assert.doesNotMatch(choice, /комисси|8,5%/i);
  const paid = { ...original, ...{ payment: order('paid').payment }, total: 1099 };
  paid.payment.amount = 1099;
  paid.payment.attempts[0].amount = 1099;
  const receipt = R.receiptPage(s, paid);
  assert.match(receipt, /Товары<\/dt><dd>1\s000\s₽/);
  assert.match(receipt, /Доставка<\/dt><dd>100\s₽/);
  assert.match(receipt, /Скидка при оплате<\/dt><dd>−1\s₽/);
  assert.match(receipt, /Итого<\/dt><dd>1\s099\s₽/);
  assert.doesNotMatch(receipt, /комисси|8,5%/i);
  assert.match(R.payPage(s, paid), /Скидка при оплате: 1\s₽/);
  const other = { ...paid, total: 1100, payment: { ...paid.payment, provider: 'alfabank', amount: 1100 } };
  const otherReceipt = R.receiptPage(s, other);
  assert.doesNotMatch(otherReceipt, /Скидка при оплате/);
  assert.match(otherReceipt, /Итого<\/dt><dd>1\s100\s₽/);
});

test('страница оплаты и товарный чек показывают сохранённую комиссию даже после смены тарифа', () => {
  const s = { ...settings(), plategaFeePercent: 12 };
  const paid = {
    ...order('paid'), itemsTotal: 900, deliveryPrice: 100, total: 1085,
    items: [{ id: 'p1', name: 'Товар', qty: 1, price: 900 }],
    paymentFee: { provider: 'platega', method: 'SBP_ONLINE', baseAmount: 1000, amount: 85, percent: 8.5 }
  };
  paid.payment.amount = 1085;
  paid.payment.attempts[0].amount = 1085;
  const receipt = R.receiptPage(s, paid);
  assert.match(receipt, /Комиссия платёжного сервиса \(8,5%\)<\/dt><dd>85\s₽/);
  assert.match(receipt, /Итого<\/dt><dd>1\s085\s₽/);
  const page = R.payPage(s, paid);
  assert.match(page, /В том числе комиссия платёжного сервиса \(8,5%\): 85\s₽/);
  for (const legacy of [R.receiptPage(s, order('paid')), R.payPage(s, order('pending'))]) {
    assert.doesNotMatch(legacy, /комиссия платёжного сервиса|Комиссия платёжного сервиса/);
  }
});
