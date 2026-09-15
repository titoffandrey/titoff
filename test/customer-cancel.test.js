'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const R = require('../lib/render');
const source = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8');

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'customer-cancel-'));
  const previous = process.env.STORE_DATA_DIR;
  const key = require.resolve('../lib/db'), cached = require.cache[key];
  process.env.STORE_DATA_DIR = dir; delete require.cache[key];
  const db = require('../lib/db'); delete require.cache[key];
  if (cached) require.cache[key] = cached;
  if (previous === undefined) delete process.env.STORE_DATA_DIR;
  else process.env.STORE_DATA_DIR = previous;
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  let cancel;
  const from = source.indexOf("app.post('/pay/:id/cancel'");
  const to = source.indexOf('/* Сверить ОДНУ адресную попытку', from);
  vm.runInNewContext(source.slice(from, to), {
    app: { post: (_, fn) => { cancel = fn; } }, db,
    ownOrder: (req, id) => req.session.myOrders.includes(id) ? db.getOrder(id) : null,
    rateLimited: () => false, sendNotFound: (_, res) => res.redirect('/404', 404)
  });
  const order = db.createOrder({ total: 1000, items: [] });
  const attempt = 'a'.repeat(24);
  const start = () => db.startOrderPayment(order.id, {
    provider: 'platega', attemptId: attempt, requestId: 'b'.repeat(32), token: 'c'.repeat(32),
    method: 'SBP_ONLINE', amount: 1000, currency: 'RUB'
  });
  const session = { myOrders: [order.id] };
  const request = (who = session) => {
    let result;
    cancel({ params: { id: order.id }, session: who }, { redirect: (url, status) => { result = { url, status }; } });
    return result;
  };
  const attach = () => db.attachOrderInvoice(order.id, { attemptId: attempt, invoiceId: 'synthetic-invoice',
    requisite: 'https://pay.example/invoice', expiresAt: Date.now() + 600000 });
  return { db, order, attempt, start, attach, request, session };
}

test('отмена живого счёта сохраняет историю, закрывает новый старт и повторяется безопасно', t => {
  const { db, order, start, attach, request, session } = fixture(t);
  start(); attach();
  const before = db.paymentAttempts(db.getOrder(order.id));
  assert.deepEqual(request(), { url: '/checkout?returned=cancel', status: 303 });
  const cancelled = db.getOrder(order.id);
  assert.equal(cancelled.manualVoid.by, 'customer');
  assert.deepEqual(db.paymentAttempts(cancelled), before);
  assert.equal(session.restoreOrder, order.id);
  assert.ok(session.myOrders.includes(order.id));
  assert.equal(db.startOrderPayment(order.id, { attemptId: 'd'.repeat(24) }), null);
  request();
  assert.equal(db.getOrder(order.id).manualVoid.at, cancelled.manualVoid.at);
});

test('после отказа кассы отмена сохраняет попытку для позднего ответа', t => {
  const { db, order, attempt, start, attach, request } = fixture(t);
  start(); db.failOrderPaymentAttempt(order.id, { attemptId: attempt, errorCode: 'provider_error' });
  request(); attach();
  const saved = db.getOrder(order.id);
  assert.equal(saved.manualVoid.by, 'customer');
  assert.equal(saved.payment.invoiceId, 'synthetic-invoice');
  assert.equal(db.paymentAttempts(saved).length, 1);
});

test('чужой и уже оплаченный заказ отменить нельзя', t => {
  const { db, order, attempt, start, request } = fixture(t);
  assert.equal(request({ myOrders: [] }).status, 404);
  assert.ok(!db.getOrder(order.id).manualVoid);
  db.setOrderPaidManually(order.id, true, 'admin');
  assert.equal(request().url, '/pay/' + order.id);
  assert.equal(db.setOrderVoided(order.id, true, 'customer').ok, false);
  db.setOrderPaidManually(order.id, false, 'admin'); start();
  for (const status of ['mismatch', 'paid', 'refunded']) {
    db.settleOrderPayment(order.id, { attemptId: attempt, status, total: 1000 });
    assert.equal(request().url, '/pay/' + order.id);
    assert.ok(!db.getOrder(order.id).manualVoid);
  }
});

test('поздняя оплата отменённого заказа учитывается один раз и сохраняет факт отмены', t => {
  const { db, order, attempt, start, request } = fixture(t);
  start(); request();
  const at = db.getOrder(order.id).manualVoid.at;
  const paid = db.settleOrderPayment(order.id, { attemptId: attempt, status: 'paid', total: 1000 });
  assert.equal(paid.changed, true);
  assert.equal(paid.order.manualVoid, null);
  assert.equal(paid.order.cancelledBeforePayment.at, at);
  assert.equal(paid.order.payment.status, 'paid');
  assert.equal(db.settleOrderPayment(order.id, { attemptId: attempt, status: 'paid', total: 1000 }).changed, false);
  const page = R.payPage(db.defaultSettings(), db.getOrder(order.id), { methods: [] });
  assert.match(page, /Заказ оплачен/);
  assert.doesNotMatch(page, /pay-cancel-btn/);
});

test('отмена доступна после отказа и с реквизитами, а закрытый заказ больше не предлагает оплату', t => {
  const { db, order, start, attach, request, session } = fixture(t);
  start();
  const page = () => R.payPage(db.defaultSettings(), db.getOrder(order.id), { methods: [] });
  assert.match(page(), /Отменить заказ/);
  attach();
  assert.match(page(), /Отменить заказ/);
  assert.match(page(), /https:\/\/pay.example\/invoice/);
  request();
  assert.match(page(), /Заказ отменён/);
  assert.match(page(), /data-state="order_cancelled"/);
  assert.doesNotMatch(page(), /https:\/\/pay.example\/invoice|pay-create|pay-cancel-btn/);
  const from = source.indexOf('function payRemind(req)');
  const to = source.indexOf('// Общая обвязка любой страницы', from);
  const remind = vm.runInNewContext(source.slice(from, to) + '\npayRemind', { db, R });
  assert.equal(remind({ session }), null);
});

test('открытая вкладка узнаёт об отмене через статус без нового обращения к кассе', async t => {
  const { db, order, start, request } = fixture(t);
  start(); request();
  const from = source.indexOf('async function paymentStatusRoute(');
  const to = source.indexOf("app.get('/api/pay/status'", from);
  const handler = vm.runInNewContext(source.slice(from, to) + '\npaymentStatusRoute', {
    db, settings: () => ({}), ownOrder: () => db.getOrder(order.id)
  });
  let result;
  await handler({ query: { order: order.id } }, { json: value => { result = value; } });
  assert.equal(result.ok, true);
  assert.equal(result.state, 'order_cancelled');
});

test('запоздалый ответ отменённого заказа не очищает новую корзину и не открывает кассу', async () => {
  for (const file of ['app.js', 'pay.js']) {
    const js = fs.readFileSync(path.join(__dirname, '../public', file), 'utf8');
    const from = js.indexOf(file === 'app.js' ? 'function startPayment(orderId' : 'function startPayment(btn');
    const to = file === 'app.js' ? js.indexOf('/* Ключ идемпотентности для прямого старта', from)
      : js.indexOf('function safePayUrl(', from);
    const location = { href: '' };
    const Cart = { clear: () => assert.fail('новая корзина не очищается'), hold: () => assert.fail('новая корзина не подменяет снимок') };
    const start = vm.runInNewContext(js.slice(from, to) + '\nstartPayment', {
      window: { Cart }, Cart, location, orderId: 'synthetic', currency: 'RUB', total: 1000,
      directRequestId: () => 'a'.repeat(32), requestKey: () => 'key', paymentRequestId: () => 'a'.repeat(32),
      chosenMethod: () => 'SBP_ONLINE', chosenHosted: () => true, clearPaymentRequest: () => {},
      safePayUrl: () => '/pay/synthetic', showMsg: () => assert.fail('отмена не является ошибкой связи'),
      fetch: async () => ({ json: async () => ({ ok: true, terminal: 'order_cancelled',
        url: '/pay/synthetic', hostedUrl: 'https://pay.example/unused' }) })
    });
    if (file === 'app.js') start('synthetic', 'SBP_ONLINE', 1000);
    else start({ disabled: false, textContent: '' }, 'Оплатить');
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(location.href, '/pay/synthetic', file);
  }
});
