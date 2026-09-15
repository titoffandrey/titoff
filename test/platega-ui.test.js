'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
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
  const s = settings();
  const html = admin.settingsPage(s, { pendingReviewCount: () => 0 }, null);
  assert.match(html, /name="plategaEnabled" checked/);
  assert.match(html, /name="plategaMerchantId" value="00000000-0000-4000-8000-000000000001"/);
  assert.match(html, /name="plategaSecret" type="password" value=""/);
  assert.match(html, /name="clearPlategaSecret"/);
  assert.match(html, /\/api\/pay\/platega\/callback/);
  assert.match(html, /https:\/\/docs\.platega\.io\//);
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

test('витрина и консультант описывают выбор на странице оплаты без имени кассы и ручного перевода', () => {
  const s = settings();
  const pending = order('pending');
  const html = R.payPage(s, pending, { origin: '', methods: [PAY.find('ONLINE_PAYMENT')] });
  const card = html.slice(html.indexOf('<div class="pay-wrap">'), html.indexOf('<script', html.indexOf('<div class="pay-wrap">')));
  assert.match(card, /Выберите доступный способ и следуйте инструкциям/);
  assert.match(card, /На оплату осталось/);
  assert.doesNotMatch(card, /странице банка|точную сумму|Оплата картой|Сумма перевода|Переведите сумму/i);
  const choice = R.payPage(s, Object.assign({}, pending, { payment: null }), { origin: '', methods: [PAY.find('ONLINE_PAYMENT')] });
  assert.match(choice, /id="pay-create">Перейти к оплате/);
  assert.match(choice, /data-hosted="1"/);
  const facts = prompt.storeText(s);
  assert.match(facts, /Онлайн-оплата:.*защищённая страница оплаты/);
  assert.doesNotMatch(facts, /странице банка|ТОЧНУЮ СУММУ|эквайринг|перевод по реквизитам/);
  for (const page of [html, choice, R.checkoutPage(s, { origin: '', payOnline: true }), facts]) {
    assert.doesNotMatch(page, new RegExp(merchant + '|' + secret));
    assert.doesNotMatch(page, /Platega/i);
  }
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
    [true, 'https://payment.example/invoice?id=1', 'https://payment.example/invoice?id=1'],
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
