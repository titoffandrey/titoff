'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const PLATEGA = require('../lib/platega');
const CALLBACK = require('../lib/platega-callback');
const merchant = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const invoiceId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const attemptId = '0123456789abcdef01234567';
const settings = { plategaMerchantId: merchant, plategaSecret: 'synthetic-secret' };
const headers = { 'x-merchantid': merchant, 'x-secret': settings.plategaSecret };
const event = { id: invoiceId, payload: attemptId, amount: 1000, currency: 'RUB', status: 'CONFIRMED' };

function fixture(t, patch = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'platega-callback-'));
  const previous = process.env.STORE_DATA_DIR;
  process.env.STORE_DATA_DIR = dir;
  const key = require.resolve('../lib/db');
  const cached = require.cache[key];
  delete require.cache[key];
  const db = require('../lib/db');
  delete require.cache[key];
  if (cached) require.cache[key] = cached;
  if (previous === undefined) delete process.env.STORE_DATA_DIR;
  else process.env.STORE_DATA_DIR = previous;
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const attempt = { id: attemptId, provider: 'platega', method: 'ONLINE_PAYMENT',
    status: 'pending', amount: 1000, currency: 'RUB', invoiceId,
    requisite: 'https://pay.platega.io/pay/synthetic', startedAt: Date.now(),
    expiresAt: Date.now() + 600000, ...patch };
  fs.writeFileSync(path.join(dir, 'orders.json'), JSON.stringify([{ id: 'synthetic-order', total: attempt.amount, createdAt: Date.now(),
    payment: { ...attempt, attemptId, attempts: [attempt] } }]), { mode: 0o600 });
  return { db, orderId: 'synthetic-order', attempt };
}

function reconciliation(db) {
  // Выполняем именно production reconcile с подставленной кассой/уведомлениями.
  const source = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8');
  const start = source.indexOf('async function reconcilePaymentAttempt(');
  const end = source.indexOf('\n/* Что реально включено', start);
  const notifications = [], shipments = [];
  const reconcile = vm.runInNewContext(source.slice(start, end) + '\nreconcilePaymentAttempt', {
    db, PAYMENTS: { provider: id => id === 'platega' ? PLATEGA : null, startErrorCode: () => 'provider_error' },
    paymentReconcileJobs: new Map(), invoiceNote: invoice => invoice.reason || '', console,
    notifyPayment: (order, state) => notifications.push(state),
    prepareShipment: order => shipments.push(order.id)
  });
  return { reconcile, notifications, shipments };
}

function stubStatus(t, patch = {}) {
  const original = PLATEGA.invoice;
  let calls = 0;
  PLATEGA.invoice = async () => {
    calls++;
    return { ok: true, invoice: { id: invoiceId, state: 'paid', amount: 1000,
      currency: 'RUB', externalId: attemptId, method: 'ONLINE_PAYMENT', ...patch } };
  };
  t.after(() => { PLATEGA.invoice = original; });
  return () => calls;
}

test('Platega: callback требует оба ключа и не доверяет CONFIRMED из тела', async t => {
  const { db } = fixture(t);
  const calls = stubStatus(t, { state: 'pending' });
  const tools = { db, ...reconciliation(db) };
  assert.equal((await CALLBACK.handle(settings, event, {}, tools)).status, 403);
  assert.equal(calls(), 0);
  assert.equal((await CALLBACK.handle(settings, event, headers, tools)).status, 503);
  assert.equal(db.getOrder('synthetic-order').payment.status, 'pending');
  assert.equal(tools.shipments.length, 0);
});

test('Platega: точный GET подтверждает оплату единожды даже при повторном callback', async t => {
  const { db } = fixture(t);
  stubStatus(t);
  const tools = { db, ...reconciliation(db) };
  assert.equal((await CALLBACK.handle(settings, event, headers, tools)).status, 200);
  assert.equal((await CALLBACK.handle(settings, event, headers, tools)).status, 200);
  assert.equal(db.getOrder('synthetic-order').payment.status, 'paid');
  assert.deepEqual(tools.notifications, ['paid']);
  assert.equal(tools.shipments.length, 1);
});

test('Platega: callback подтверждает новый СБП-счёт через GET с методом SBPQR', async t => {
  const { db } = fixture(t, { method: 'SBP_ONLINE' });
  stubFetch(t, async (url, init) => {
    assert.equal(url, 'https://app.platega.io/transaction/' + invoiceId);
    assert.equal(init.method, 'GET');
    return new Response(JSON.stringify({ id: invoiceId, payload: attemptId,
      paymentDetails: { amount: 1000, currency: 'RUB' },
      paymentMethod: 'SBPQR', status: 'CONFIRMED' }));
  });
  const tools = { db, ...reconciliation(db) };
  assert.equal((await CALLBACK.handle(settings, event, headers, tools)).status, 200);
  assert.equal(db.getOrder('synthetic-order').payment.status, 'paid');
  assert.deepEqual(tools.notifications, ['paid']);
  assert.equal(tools.shipments.length, 1);
});

test('Platega: другой метод из GET не подтверждает новый СБП-счёт', async t => {
  const { db } = fixture(t, { method: 'SBP_ONLINE' });
  stubFetch(t, async () => new Response(JSON.stringify({ id: invoiceId, payload: attemptId,
    paymentDetails: { amount: 1000, currency: 'RUB' },
    paymentMethod: 'CRYPTO', status: 'CONFIRMED' })));
  const tools = { db, ...reconciliation(db) };
  assert.equal((await CALLBACK.handle(settings, event, headers, tools)).status, 200);
  assert.equal(db.getOrder('synthetic-order').payment.status, 'mismatch');
  assert.deepEqual(tools.notifications, ['mismatch']);
  assert.equal(tools.shipments.length, 0);
});

test('Platega: старый счёт с выбором способов остаётся оплачиваемым после перехода на СБП', async t => {
  const { db } = fixture(t);
  stubFetch(t, async () => new Response(JSON.stringify({ id: invoiceId, payload: attemptId,
    paymentDetails: { amount: 1000, currency: 'RUB' },
    paymentMethod: 'CRYPTO', status: 'CONFIRMED' })));
  const tools = { db, ...reconciliation(db) };
  assert.equal((await CALLBACK.handle(settings, event, headers, tools)).status, 200);
  assert.equal(db.getOrder('synthetic-order').payment.status, 'paid');
  assert.deepEqual(tools.notifications, ['paid']);
  assert.equal(tools.shipments.length, 1);
});

test('Platega: GET с другой суммой не выдаёт заказ', async t => {
  const { db } = fixture(t);
  stubStatus(t, { amount: 10 });
  const tools = { db, ...reconciliation(db) };
  assert.equal((await CALLBACK.handle(settings, event, headers, tools)).status, 200);
  assert.equal(db.getOrder('synthetic-order').payment.status, 'mismatch');
  assert.equal(tools.shipments.length, 0);
});

test('Platega: callback восстанавливает потерянный ответ POST по точному GET', async t => {
  const { db } = fixture(t, { invoiceId: '', requisite: '', lastErrorCode: 'timeout' });
  stubStatus(t);
  const tools = { db, ...reconciliation(db) };
  assert.equal((await CALLBACK.handle(settings, event, headers, tools)).status, 200);
  assert.equal(db.getOrder('synthetic-order').payment.invoiceId, invoiceId);
  assert.equal(db.getOrder('synthetic-order').payment.status, 'paid');
});

test('Platega: при восстановлении несовпадение payload/суммы не привязывает счёт', async t => {
  const { db } = fixture(t, { invoiceId: '', requisite: '' });
  stubStatus(t, { externalId: 'fedcba9876543210fedcba98' });
  const tools = { db, ...reconciliation(db) };
  assert.equal((await CALLBACK.handle(settings, event, headers, tools)).status, 409);
  assert.equal(db.getOrder('synthetic-order').payment.invoiceId, '');
  assert.equal(tools.shipments.length, 0);
});

test('Platega: неизвестный заказ другого магазина подтверждается без действий', async t => {
  const { db } = fixture(t);
  const calls = stubStatus(t);
  const tools = { db, ...reconciliation(db) };
  assert.equal((await CALLBACK.handle(settings, { ...event,
    id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', payload: 'fedcba9876543210fedcba98'
  }, headers, tools)).status, 200);
  assert.equal(calls(), 0);
  assert.equal((await CALLBACK.handle(settings, { ...event, payload: 'fedcba9876543210fedcba98' }, headers, tools)).status, 409);
});

test('Platega: недоступность GET возвращает 503 для повторной доставки', async t => {
  const { db } = fixture(t);
  const original = PLATEGA.invoice;
  PLATEGA.invoice = async () => ({ ok: false, error: 'timeout' });
  t.after(() => { PLATEGA.invoice = original; });
  const tools = { db, ...reconciliation(db) };
  assert.equal((await CALLBACK.handle(settings, event, headers, tools)).status, 503);
  assert.equal(db.getOrder('synthetic-order').payment.status, 'pending');
});

test('Platega: подтверждённый возврат липкий и не готовит отправку заново', async t => {
  const { db, orderId } = fixture(t, { status: 'paid', paidAt: 123, paidTotal: 1000 });
  stubStatus(t, { state: 'refunded' });
  const tools = { db, ...reconciliation(db) };
  assert.equal((await CALLBACK.handle(settings, { ...event, status: 'CHARGEBACKED' }, headers, tools)).status, 200);
  assert.equal((await CALLBACK.handle(settings, { ...event, status: 'CHARGEBACKED' }, headers, tools)).status, 200);
  assert.equal(db.getOrder(orderId).payment.status, 'refunded');
  assert.equal(db.getOrder(orderId).payment.paidAt, 123);
  assert.deepEqual(tools.notifications, ['refunded']);
  assert.equal(tools.shipments.length, 0);
  db.settleOrderPayment(orderId, { attemptId, invoiceId, status: 'paid', total: 1000 });
  assert.equal(db.getOrder(orderId).payment.status, 'refunded');
  assert.equal(db.setOrderPaidManually(orderId, true, 'test').ok, false);
});

test('Platega: возврат требует совпадения суммы, как и успешная оплата', async t => {
  const { db } = fixture(t, { status: 'paid', paidTotal: 1000 });
  stubStatus(t, { state: 'refunded', amount: 1 });
  const tools = { db, ...reconciliation(db) };
  assert.equal((await CALLBACK.handle(settings, { ...event, status: 'CHARGEBACKED' }, headers, tools)).status, 503);
  assert.equal(db.getOrder('synthetic-order').payment.status, 'paid');
});

test('Platega: устаревший GET не подтверждает доставку уведомления о возврате', async t => {
  const { db } = fixture(t, { status: 'paid' });
  stubStatus(t, { state: 'paid' });
  const tools = { db, ...reconciliation(db) };
  assert.equal((await CALLBACK.handle(settings, { ...event, status: 'CHARGEBACKED' }, headers, tools)).status, 503);
  assert.equal(db.getOrder('synthetic-order').payment.status, 'paid');
});

test('Platega: возврат одной из двух оплат сохраняет другую в итоге заказа', t => {
  const { db, orderId, attempt } = fixture(t, { status: 'paid', paidAt: 123 });
  const other = { ...attempt, id: 'abcdefabcdefabcdefabcdef', invoiceId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' };
  const order = db.getOrder(orderId);
  order.payment.attempts.unshift(other);
  db.writeJson('orders', [order]);
  db.settleOrderPayment(orderId, { attemptId, invoiceId, status: 'refunded', total: 1000 });
  assert.equal(db.getOrder(orderId).payment.status, 'paid');
  assert.equal(db.getOrder(orderId).payment.attemptId, other.id);
  assert.equal(db.getOrder(orderId).payment.paidAt, 123);
});

test('Platega: возврат не скрывает расхождение другой попытки при любом порядке событий', t => {
  const { db, orderId, attempt } = fixture(t, { status: 'pending' });
  const other = { ...attempt, id: 'abcdefabcdefabcdefabcdef', invoiceId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' };
  const order = db.getOrder(orderId);
  order.payment.attempts.push(other);
  for (const refundFirst of [false, true]) {
    db.writeJson('orders', [order]);
    const refund = () => db.settleOrderPayment(orderId, { attemptId, invoiceId, status: 'refunded', total: 1000 });
    const mismatch = () => db.settleOrderPayment(orderId, { attemptId: other.id, invoiceId: other.invoiceId, status: 'mismatch', total: 1 });
    if (refundFirst) { refund(); mismatch(); } else { mismatch(); refund(); }
    assert.equal(db.getOrder(orderId).payment.status, 'mismatch');
    assert.equal(db.getOrder(orderId).payment.attemptId, other.id);
  }
});

function checkoutHarness(t, { total = 1000, paymentFee = null, feePercent = 0, extraSettings = {} } = {}) {
  const { db, orderId } = fixture(t);
  const order = db.getOrder(orderId);
  order.payment = null;
  order.total = total;
  order.paymentFee = paymentFee;
  db.writeJson('orders', [order]);
  const R = require('../lib/render');
  const PAY = require('../lib/pay-methods');
  const PAYMENTS = require('../lib/payments');
  const s = { ...settings, plategaEnabled: true, plategaFeePercent: feePercent,
    payMethods: ['SBP_ONLINE'], ...extraSettings };
  const source = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8');
  const helpers = source.slice(source.indexOf('async function requestInvoiceFrom('), source.indexOf('const paymentStartJobs ='));
  const contextFrom = source.indexOf('async function payContext(');
  const contextTo = source.indexOf('\n/* Выставить счёт по уже созданному заказу', contextFrom);
  assert.ok(contextFrom > 0 && contextTo > contextFrom);
  const context = source.slice(contextFrom, contextTo);
  const route = source.slice(source.indexOf('async function startPaymentRoute('), source.indexOf("app.post('/api/pay/start'"));
  const flow = vm.runInNewContext(helpers + context + route + '\n({ start: startPaymentRoute, context: payContext })', {
    db, R, PAY, PAYMENTS, crypto: require('node:crypto'), console,
    settings: () => s, paymentOrigin: () => 'https://shop.example',
    ownOrder: (_, id) => db.getOrder(id), rateLimited: () => false,
    livePayMethods: async () => ({ ok: true, currencies: ['RUB'], byCurrency: { RUB: s.payMethods } }),
    paymentStartJobs: new Map(), UNRESOLVED_PAYMENT_TTL: 300000,
    metricsSkipped: () => true, notifyNewOrder: () => {}, notifyPaymentProblem: () => {}
  });
  const request = async (key = 'a'.repeat(32), patch = {}) => {
    let response;
    await flow.start({ body: { orderId, method: 'SBP_ONLINE', requestId: key, ...patch } }, {
      json: (body, status = 200) => { response = { body, status }; }
    });
    return response;
  };
  return { db, orderId, request, settings: s, context: () => flow.context(s, db.getOrder(orderId), 'RUB') };
}

test('Platega: отмена во время POST сохраняет поздний invoice, но не отдаёт платёжную ссылку', async t => {
  const { db, orderId, request } = checkoutHarness(t);
  let entered, release;
  const inPost = new Promise(resolve => { entered = resolve; });
  const response = new Promise(resolve => { release = resolve; });
  stubFetch(t, async () => { entered(); return response; });
  const starting = request();
  await inPost;
  assert.equal(db.setOrderVoided(orderId, true, 'customer').ok, true);
  release(new Response(JSON.stringify({ transactionId: invoiceId, status: 'PENDING',
    paymentMethod: 'SBPQR', paymentDetails: { amount: 1000, currency: 'RUB' },
    redirect: 'https://pay.platega.io/pay/synthetic-cancel', expiresIn: '00:15:00' })));
  const result = await starting;
  assert.equal(result.status, 200);
  assert.equal(result.body.terminal, 'order_cancelled');
  assert.equal(result.body.hostedUrl, undefined);
  const saved = db.getOrder(orderId);
  assert.equal(saved.payment.invoiceId, invoiceId);
  assert.equal(saved.manualVoid.by, 'customer');
  assert.equal(db.paymentAttempts(saved).length, 1);
  const repeated = await request('c'.repeat(32));
  assert.equal(repeated.body.terminal, 'order_cancelled');
  assert.equal(repeated.body.hostedUrl, undefined);
  assert.equal(db.paymentAttempts(db.getOrder(orderId)).length, 1);
});

function stubFetch(t, fn) {
  const previous = global.fetch;
  global.fetch = fn;
  t.after(() => { global.fetch = previous; });
}

test('Platega: одновременные и повторные нажатия создают один счёт', async t => {
  const { db, orderId, request } = checkoutHarness(t);
  let calls = 0;
  const link = 'https://pay.platega.io/?id=' + invoiceId + '&mh=' + 'x'.repeat(220);
  stubFetch(t, async (url, init) => {
    assert.equal(url, 'https://app.platega.io/transaction/process');
    assert.equal(init.method, 'POST');
    const data = JSON.parse(init.body);
    assert.deepEqual(data.paymentDetails, { amount: 1000, currency: 'RUB' });
    assert.equal(data.paymentMethod, 2);
    assert.equal(data.return, 'https://shop.example/pay/' + orderId);
    assert.equal(data.failedUrl, data.return);
    assert.equal(data.id, undefined);
    calls++;
    await new Promise(resolve => setTimeout(resolve, 10));
    return new Response(JSON.stringify({ transactionId: invoiceId, status: 'PENDING',
      paymentMethod: 'SBPQR', paymentDetails: { amount: 1000, currency: 'RUB' },
      redirect: link, expiresIn: '00:15:00' }));
  });
  const first = await Promise.all([request(), request()]);
  assert.equal(first[0].status, 200);
  assert.equal(first[1].status, 200);
  assert.equal(first[0].body.hostedUrl, link);
  assert.equal((await request('b'.repeat(32))).status, 200);
  assert.equal(calls, 1);
  assert.equal(db.paymentAttempts(db.getOrder(orderId)).length, 1);
  assert.equal(db.getOrder(orderId).payment.method, 'SBP_ONLINE');
  assert.equal(db.getOrder(orderId).payment.requisite, link, 'длинный URL не обрезан хранилищем');
});

test('Platega: сохранённая комиссия не начисляется повторно и сверяется в полном GET', async t => {
  const paymentFee = { provider: 'platega', method: 'SBP_ONLINE', baseAmount: 1000, amount: 85, percent: 8.5 };
  const { db, orderId, request } = checkoutHarness(t, { total: 1085, paymentFee, feePercent: 12 });
  let creates = 0, statusChecks = 0, externalId;
  stubFetch(t, async (url, init) => {
    if (init.method === 'POST') {
      creates++;
      assert.equal(url, 'https://app.platega.io/transaction/process');
      const data = JSON.parse(init.body);
      externalId = data.payload;
      assert.deepEqual(data.paymentDetails, { amount: 1000, currency: 'RUB' });
      return new Response(JSON.stringify({ transactionId: invoiceId, status: 'PENDING',
        paymentMethod: 'SBPQR', paymentDetails: { amount: 1085, currency: 'RUB' },
        redirect: 'https://pay.platega.io/pay/synthetic-sbp', expiresIn: null }));
    }
    statusChecks++;
    assert.equal(url, 'https://app.platega.io/transaction/' + invoiceId);
    return new Response(JSON.stringify({ id: invoiceId, payload: externalId, status: 'CONFIRMED',
      paymentMethod: 'SBPQR', paymentDetails: { amount: 1085, currency: 'RUB' } }));
  });
  assert.equal((await request()).status, 200);
  assert.equal((await request('b'.repeat(32))).status, 200);
  assert.equal(creates, 1);
  const pending = db.getOrder(orderId);
  assert.equal(pending.total, 1085);
  assert.equal(pending.payment.amount, 1085);
  assert.deepEqual(pending.paymentFee, paymentFee, 'новый тариф не меняет уже показанный итог');
  assert.equal(pending.payment.expiresAt, require('../lib/render').orderPayUntil(pending));
  const tools = { db, ...reconciliation(db) };
  const callback = { id: invoiceId, payload: externalId, amount: 1085, currency: 'RUB', status: 'CONFIRMED' };
  assert.equal((await CALLBACK.handle(settings, callback, headers, tools)).status, 200);
  assert.equal(statusChecks, 1);
  assert.equal(db.getOrder(orderId).payment.status, 'paid');
  assert.equal(db.getOrder(orderId).payment.paidTotal, 1085);
  assert.equal(tools.shipments.length, 1);
});

test('Platega: комиссия внутри 1100 ₽ использует сохранённую дробную базу и подтверждает полный итог', async t => {
  const paymentFee = { provider: 'platega', method: 'SBP_ONLINE', mode: 'included',
    baseAmount: 1013.8249, amount: 86.18, percent: 8.5 };
  const { db, orderId, request } = checkoutHarness(t, { total: 1100, paymentFee, feePercent: 12,
    extraSettings: { alfabankEnabled: true, alfabankLogin: 'synthetic-login',
      alfabankPassword: 'synthetic-password', payMethods: ['SBP_ONLINE', 'CARD_ONLINE'] } });
  let creates = 0, statusChecks = 0, externalId;
  stubFetch(t, async (url, init) => {
    if (init.method === 'POST') {
      creates++;
      assert.equal(url, 'https://app.platega.io/transaction/process');
      const data = JSON.parse(init.body);
      externalId = data.payload;
      assert.deepEqual(data.paymentDetails, { amount: 1013.8249, currency: 'RUB' });
      assert.equal(data.paymentMethod, 2);
      return new Response(JSON.stringify({ transactionId: invoiceId, status: 'PENDING',
        paymentMethod: 'SBPQR', paymentDetails: { amount: 1100, currency: 'RUB' },
        redirect: 'https://pay.platega.io/pay/synthetic-included', expiresIn: null }));
    }
    statusChecks++;
    assert.equal(url, 'https://app.platega.io/transaction/' + invoiceId);
    return new Response(JSON.stringify({ id: invoiceId, payload: externalId, status: 'CONFIRMED',
      paymentMethod: 'SBPQR', paymentDetails: { amount: 1100, currency: 'RUB' } }));
  });
  assert.equal((await request()).status, 200);
  assert.equal((await request('b'.repeat(32))).status, 200);
  assert.equal(creates, 1);
  const pending = db.getOrder(orderId);
  assert.equal(pending.total, 1100);
  assert.equal(pending.payment.amount, 1100);
  assert.deepEqual(pending.paymentFee, paymentFee);
  const tools = { db, ...reconciliation(db) };
  const callback = { id: invoiceId, payload: externalId, amount: 1100, currency: 'RUB', status: 'CONFIRMED' };
  assert.equal((await CALLBACK.handle(settings, callback, headers, tools)).status, 200);
  assert.equal((await CALLBACK.handle(settings, callback, headers, tools)).status, 200);
  assert.equal(db.getOrder(orderId).payment.status, 'paid');
  assert.equal(db.getOrder(orderId).payment.paidTotal, 1100);
  assert.equal(statusChecks, 2);
  assert.equal(tools.shipments.length, 1);
  assert.deepEqual(tools.notifications, ['paid']);
});

test('Platega: сохранённые 0% не заменяются текущим тарифом при создании счёта', async t => {
  const paymentFee = { provider: 'platega', method: 'SBP_ONLINE', mode: 'included',
    baseAmount: 1100, amount: 0, percent: 0 };
  const { db, orderId, request } = checkoutHarness(t, { total: 1100, paymentFee, feePercent: 8.5 });
  let creates = 0;
  stubFetch(t, async (_, init) => {
    creates++;
    assert.deepEqual(JSON.parse(init.body).paymentDetails, { amount: 1100, currency: 'RUB' });
    return new Response(JSON.stringify({ transactionId: invoiceId, status: 'PENDING',
      paymentMethod: 'SBPQR', paymentDetails: { amount: 1100, currency: 'RUB' },
      redirect: 'https://pay.platega.io/pay/synthetic-zero', expiresIn: null }));
  });
  assert.equal((await request()).status, 200);
  assert.equal(creates, 1);
  assert.equal(db.getOrder(orderId).payment.amount, 1100);
  assert.equal(db.getOrder(orderId).paymentFee.percent, 0);
});

test('снимок Platega внутри цены сохраняет выбор Alfa и передаёт ей обычный полный итог', async t => {
  const paymentFee = { provider: 'platega', method: 'SBP_ONLINE', mode: 'included',
    baseAmount: 1013.8249, amount: 86.18, percent: 8.5 };
  const { db, orderId, request, context } = checkoutHarness(t, { total: 1100, paymentFee, feePercent: 8.5,
    extraSettings: { alfabankEnabled: true, alfabankLogin: 'synthetic-login',
      alfabankPassword: 'synthetic-password', payMethods: ['SBP_ONLINE', 'CARD_ONLINE'] } });
  const ctx = await context();
  assert.deepEqual(Array.from(ctx.methods, method => method.id), ['CARD_ONLINE', 'SBP_ONLINE']);
  assert.equal(ctx.amount, 1100);
  const ALFA = require('../lib/alfabank');
  const original = ALFA.createInvoice;
  t.after(() => { ALFA.createInvoice = original; });
  let creates = 0;
  ALFA.createInvoice = async (_, params) => {
    creates++;
    assert.equal(params.amount, 1100);
    assert.equal(params.currency, 'RUB');
    assert.equal(params.method, 'CARD_ONLINE');
    assert.equal(Object.hasOwn(params, 'baseAmount'), false);
    assert.equal(Object.hasOwn(params, 'feePercent'), false);
    return { ok: true, invoice: { id: invoiceId, amount: 1100, currency: 'RUB',
      method: 'CARD_ONLINE', requisite: 'https://bank.example/payment', expiresAt: Date.now() + 600000 } };
  };
  const result = await request('a'.repeat(32), { method: 'CARD_ONLINE' });
  assert.equal(result.status, 200);
  assert.equal(creates, 1);
  assert.equal(db.getOrder(orderId).payment.provider, 'alfabank');
  assert.equal(db.getOrder(orderId).payment.amount, 1100);
});

test('старый заказ с доплатой Platega по-прежнему ограничивает выбор своим способом', async t => {
  const paymentFee = { provider: 'platega', method: 'SBP_ONLINE', baseAmount: 1000, amount: 85, percent: 8.5 };
  const { db, orderId, request, context } = checkoutHarness(t, { total: 1085, paymentFee, feePercent: 8.5,
    extraSettings: { alfabankEnabled: true, alfabankLogin: 'synthetic-login',
      alfabankPassword: 'synthetic-password', payMethods: ['SBP_ONLINE', 'CARD_ONLINE'] } });
  const ctx = await context();
  assert.deepEqual(Array.from(ctx.methods, method => method.id), ['SBP_ONLINE']);
  stubFetch(t, async () => assert.fail('недоступный способ не вызывает кассу'));
  assert.equal((await request('a'.repeat(32), { method: 'CARD_ONLINE' })).status, 400);
  assert.equal(db.getOrder(orderId).payment, null);
});

test('Platega: GET только исходной суммы без комиссии не выдаёт заказ', async t => {
  const { db } = fixture(t, { method: 'SBP_ONLINE', amount: 1085 });
  stubFetch(t, async () => new Response(JSON.stringify({ id: invoiceId, payload: attemptId,
    status: 'CONFIRMED', paymentMethod: 'SBPQR', paymentDetails: { amount: 1000, currency: 'RUB' } })));
  const tools = { db, ...reconciliation(db) };
  assert.equal((await CALLBACK.handle(settings, { ...event, amount: 1085 }, headers, tools)).status, 200);
  assert.equal(db.getOrder('synthetic-order').payment.status, 'mismatch');
  assert.equal(tools.shipments.length, 0);
});

test('Platega: потерянный ответ POST блокирует новый счёт и через десять минут', async t => {
  const { db, orderId, request } = checkoutHarness(t);
  let calls = 0;
  stubFetch(t, async () => { calls++; throw new TypeError('fetch failed'); });
  assert.equal((await request()).status, 502);
  const order = db.getOrder(orderId);
  order.payment.startedAt -= 10 * 60000;
  order.payment.attempts[0].startedAt -= 10 * 60000;
  db.writeJson('orders', [order]);
  const retry = await request('b'.repeat(32));
  assert.equal(retry.status, 409);
  assert.equal(retry.body.errorCode, 'payment_processing');
  assert.equal(calls, 1);
});

test('Platega: частичный ответ с ID и плохой ссылкой не разрешает второй POST', async t => {
  const { db, orderId, request } = checkoutHarness(t);
  let calls = 0;
  stubFetch(t, async () => {
    calls++;
    return new Response(JSON.stringify({ transactionId: invoiceId, status: 'PENDING',
      paymentMethod: 'SBPQR', paymentDetails: { amount: 1000, currency: 'RUB' },
      redirect: 'javascript:alert(1)', expiresIn: '00:15:00' }));
  });
  assert.equal((await request()).status, 502);
  assert.equal(db.getOrder(orderId).payment.invoiceId, invoiceId);
  assert.equal(db.getOrder(orderId).payment.requisite, '');
  assert.equal((await request('b'.repeat(32))).status, 409);
  assert.equal(calls, 1);
});
