'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const PAYMENTS = require('../lib/payments');
const R = require('../lib/render');
const PAY = require('../lib/pay-methods');
const source = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8');
const plategaSettings = {
  plategaEnabled: true, plategaMerchantId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  plategaSecret: 'synthetic-secret', plategaFeePercent: 8.5, payMethods: ['SBP_ONLINE']
};

function freshDb(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'payment-fee-backend-'));
  const previous = process.env.STORE_DATA_DIR;
  const key = require.resolve('../lib/db');
  const cached = require.cache[key];
  process.env.STORE_DATA_DIR = dir;
  delete require.cache[key];
  const db = require('../lib/db');
  delete require.cache[key];
  if (cached) require.cache[key] = cached;
  if (previous === undefined) delete process.env.STORE_DATA_DIR;
  else process.env.STORE_DATA_DIR = previous;
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return db;
}

function orderHarness(t, { shipping = 100 } = {}) {
  const db = freshDb(t);
  const settings = { ...db.defaultSettings(), ...plategaSettings };
  const product = { id: 'synthetic-product', name: 'Товар', price: 1000, inStock: true };
  db.visibleProduct = id => id === product.id ? product : null;
  let handler;
  const from = source.indexOf('const orderClosedForBuyer =');
  const to = source.indexOf('/* ============================ ОНЛАЙН-ЧАТ ВИТРИНЫ', from);
  assert.ok(from > 0 && to > from);
  vm.runInNewContext(source.slice(from, to), {
    app: { post: (route, fn) => { assert.equal(route, '/api/order'); handler = fn; } },
    db, R, PAY, PAYMENTS, crypto, console, settings: () => settings,
    PROMO: require('../lib/promo'), PRICING: require('../lib/pricing'),
    PHONE: require('../public/phone'), DELIVERY: require('../lib/delivery'),
    ADDRESS: { checkAddress: () => ({ ok: true }) },
    SHIP: { quote: () => ({ ok: true, price: shipping, zone: 'synthetic' }) },
    paymentOrigin: () => 'https://shop.example', ORDER_REUSE_TTL: 30 * 60000,
    anonymousSessionId: () => 'synthetic-session', rateLimited: () => false,
    clientIp: () => '', cloudflareTrusted: () => false,
    metrics: { visitorId: () => null, context: () => ({}), describeRequest: async () => ({}) },
    metricsSkipped: () => true,
    notifyNewOrder: () => assert.fail('черновик не уведомляет менеджера')
  });
  const session = {};
  const request = async (patch = {}) => {
    const body = {
      requestId: 'a'.repeat(32), items: [{ id: product.id, price: 1000, qty: 1 }],
      firstName: 'Тест', lastName: 'Покупатель', phone: '+79991234567',
      address: 'Тестовый адрес', delivery: 'cdek', deliveryMode: 'courier',
      paymentFeePercent: 8.5, paymentTotal: 1193.5, ...patch
    };
    let response;
    await handler({ body, session, headers: { host: 'shop.example' } }, {
      json: (value, status = 200) => { response = { body: value, status }; }
    });
    return response;
  };
  return { db, settings, request, setShipping: value => { shipping = value; } };
}

test('комиссия начисляется только на единственный маршрут СБП Platega', () => {
  assert.deepEqual(PAYMENTS.checkoutFee(plategaSettings, 1000), {
    provider: 'platega', method: 'SBP_ONLINE', baseAmount: 1000, amount: 85, percent: 8.5, total: 1085
  });
  assert.equal(PAYMENTS.checkoutFee({ ...plategaSettings, plategaEnabled: false }, 1000), null);
  assert.equal(PAYMENTS.checkoutFee({ ...plategaSettings, payMethods: ['ONLINE_PAYMENT'] }, 1000), null);
  const unconfigured = { ...plategaSettings, plategaSecret: '' };
  assert.equal(PAYMENTS.checkoutFee(unconfigured, 1000), null);
  const multiple = { ...plategaSettings, alfabankEnabled: true,
    alfabankLogin: 'synthetic-login', alfabankPassword: 'synthetic-password',
    payMethods: ['SBP_ONLINE', 'CARD_ONLINE'] };
  assert.equal(PAYMENTS.offeredMethods(multiple).length, 2);
  assert.equal(PAYMENTS.checkoutFee(multiple, 1000), null);
});

test('/api/order сам считает комиссию с товара и доставки и сохраняет полный итог', async t => {
  const { db, request } = orderHarness(t);
  // Присланная браузером сумма и якобы нулевая комиссия не меняют расчёт.
  const result = await request({ total: 1, paymentFee: { amount: 0 } });
  assert.equal(result.status, 200);
  assert.equal(result.body.total, 1193.5);
  assert.equal(result.body.itemsTotal, 1000);
  assert.deepEqual(JSON.parse(JSON.stringify(result.body.paymentFee)), {
    provider: 'platega', method: 'SBP_ONLINE', baseAmount: 1100, amount: 93.5, percent: 8.5
  });
  const stored = db.getOrder(result.body.id);
  assert.equal(stored.total, 1193.5);
  assert.equal(stored.deliveryPrice, 100);
  assert.deepEqual(stored.paymentFee, JSON.parse(JSON.stringify(result.body.paymentFee)));
});

test('/api/order возвращает прежнюю сумму после смены тарифа при повторе потерянного ответа', async t => {
  const { db, settings, request } = orderHarness(t);
  const first = await request();
  assert.equal(first.status, 200);
  settings.plategaFeePercent = 12;
  const repeated = await request();
  assert.equal(repeated.status, 200);
  assert.equal(repeated.body.id, first.body.id);
  assert.equal(repeated.body.reused, true);
  assert.equal(repeated.body.total, 1193.5);
  assert.equal(repeated.body.paymentFee.percent, 8.5);
  assert.equal(db.getOrders().length, 1);
  const updated = await request({ requestId: 'b'.repeat(32), paymentFeePercent: 12, paymentTotal: 1232 });
  assert.equal(updated.status, 200);
  assert.notEqual(updated.body.id, first.body.id);
  assert.equal(updated.body.total, 1232);
  assert.equal(updated.body.paymentFee.percent, 12);
  assert.equal(db.getOrder(first.body.id).total, 1193.5);
});

test('/api/order отклоняет устаревший и отсутствующий показанный процент до создания заказа', async t => {
  const { db, settings, request } = orderHarness(t);
  settings.plategaFeePercent = 12;
  for (const paymentFeePercent of [8.5, undefined, '', 'не число']) {
    const result = await request({ paymentFeePercent, paymentTotal: 1232 });
    assert.equal(result.status, 409);
    assert.match(result.body.error, /Обновите страницу оформления/);
    assert.equal(db.getOrders().length, 0);
  }
});

test('/api/order не создаёт заказ без точного показанного итога с комиссией', async t => {
  const { db, request } = orderHarness(t);
  for (const paymentTotal of [undefined, null, '', '1193.5', 1, 1193.49, 1193.51]) {
    const result = await request({ paymentTotal });
    assert.equal(result.status, 409);
    assert.match(result.body.error, /увидеть доставку и комиссию до оплаты/);
    assert.equal(db.getOrders().length, 0);
  }
});

test('/api/order требует новый показанный итог после изменения доставки при прежнем проценте', async t => {
  const { db, request, setShipping } = orderHarness(t);
  setShipping(200);
  const stale = await request();
  assert.equal(stale.status, 409);
  assert.equal(db.getOrders().length, 0);
  const updated = await request({ paymentTotal: 1302 });
  assert.equal(updated.status, 200);
  assert.equal(updated.body.total, 1302);
  assert.equal(updated.body.paymentFee.percent, 8.5);
  assert.equal(updated.body.paymentFee.baseAmount, 1200);
  assert.equal(updated.body.paymentFee.amount, 102);
  // Итог входит в отпечаток запроса: тот же ключ с другой суммой — конфликт.
  const changed = await request();
  assert.equal(changed.status, 409);
  assert.equal(changed.body.errorCode, 'idempotency_conflict');
  const repeated = await request({ paymentTotal: 1302 });
  assert.equal(repeated.status, 200);
  assert.equal(repeated.body.id, updated.body.id);
  assert.equal(repeated.body.reused, true);
  assert.equal(db.getOrders().length, 1);
});

test('/api/order применяет предел кассы к сумме с комиссией', async t => {
  const { db, settings, request } = orderHarness(t);
  settings.payMaxTotal = 1150;
  // Товар с доставкой стоят 1100, но фактическая оплата 1193,50 выше предела.
  const result = await request();
  assert.equal(result.status, 400);
  assert.match(result.body.error, /Один заказ — не более/);
  assert.equal(db.getOrders().length, 0);
});

test('хранилище не принимает комиссию, не совпадающую с итогом заказа', t => {
  const db = freshDb(t);
  const fee = { provider: 'platega', method: 'SBP_ONLINE', baseAmount: 1000, amount: 85, percent: 8.5 };
  const valid = db.createOrder({ total: 1085, paymentFee: fee });
  assert.deepEqual(db.getOrder(valid.id).paymentFee, fee);
  const forged = db.createOrder({ total: 1000, paymentFee: fee });
  assert.equal(db.getOrder(forged.id).paymentFee, null);
});
