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

test('новое оформление создаёт новый заказ при прежнем неоплаченном, а повтор запроса не дублируется', async t => {
  const { db, request } = orderHarness(t);
  const first = await request();
  db.startOrderPayment(first.body.id, { provider: 'platega', attemptId: 'c'.repeat(24),
    method: 'SBP_ONLINE', amount: first.body.total, currency: 'RUB' });
  db.attachOrderInvoice(first.body.id, { attemptId: 'c'.repeat(24), invoiceId: 'synthetic-live',
    requisite: 'https://pay.example/first', expiresAt: Date.now() + 600000 });
  const second = await request({ requestId: 'b'.repeat(32) });
  assert.equal(second.status, 200);
  assert.notEqual(second.body.id, first.body.id);
  assert.equal(db.getOrders().length, 2);
  const replay = await request({ requestId: 'b'.repeat(32) });
  assert.equal(replay.body.id, second.body.id);
  assert.equal(replay.body.reused, true);
  assert.equal(db.getOrders().length, 2);
  db.setOrderVoided(second.body.id, true, 'customer');
  const afterCancel = await request({ requestId: 'b'.repeat(32) });
  assert.equal(afterCancel.status, 200);
  assert.notEqual(afterCancel.body.id, second.body.id);
  assert.ok(db.getOrder(second.body.id).manualVoid);
});

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
      paymentFeePercent: 8.5, paymentTotal: 1100, ...patch
    };
    let response;
    await handler({ body, session, headers: { host: 'shop.example' } }, {
      json: (value, status = 200) => { response = { body: value, status }; }
    });
    return response;
  };
  return { db, settings, request, setShipping: value => { shipping = value; } };
}

test('снимок комиссии внутри цены относится к Platega и доступен при выборе касс', () => {
  assert.deepEqual(PAYMENTS.checkoutFee(plategaSettings, 1000), {
    provider: 'platega', method: 'SBP_ONLINE', mode: 'included',
    baseAmount: 921.659, amount: 78.34, percent: 8.5, total: 1000
  });
  assert.equal(PAYMENTS.checkoutFee({ ...plategaSettings, plategaEnabled: false }, 1000), null);
  assert.equal(PAYMENTS.checkoutFee({ ...plategaSettings, payMethods: ['ONLINE_PAYMENT'] }, 1000), null);
  const unconfigured = { ...plategaSettings, plategaSecret: '' };
  assert.equal(PAYMENTS.checkoutFee(unconfigured, 1000), null);
  const multiple = { ...plategaSettings, alfabankEnabled: true,
    alfabankLogin: 'synthetic-login', alfabankPassword: 'synthetic-password',
    payMethods: ['SBP_ONLINE', 'CARD_ONLINE'] };
  assert.equal(PAYMENTS.offeredMethods(multiple).length, 2);
  assert.deepEqual(PAYMENTS.checkoutFee(multiple, 1000), PAYMENTS.checkoutFee(plategaSettings, 1000));
  assert.equal(PAYMENTS.checkoutFee({ ...multiple, payMethods: ['CARD_ONLINE'] }, 1000), null);
});

test('/api/order сохраняет прежние цены товара и доставки, включая комиссию внутри итога', async t => {
  const { db, request } = orderHarness(t);
  // Присланная браузером сумма и якобы нулевая комиссия не меняют расчёт.
  const result = await request({ total: 1, paymentFee: { amount: 0 } });
  assert.equal(result.status, 200);
  assert.equal(result.body.total, 1100);
  assert.equal(result.body.itemsTotal, 1000);
  assert.deepEqual(JSON.parse(JSON.stringify(result.body.paymentFee)), {
    provider: 'platega', method: 'SBP_ONLINE', mode: 'included',
    baseAmount: 1013.8249, amount: 86.18, percent: 8.5
  });
  const stored = db.getOrder(result.body.id);
  assert.equal(stored.total, 1100);
  assert.equal(stored.items[0].price, 1000);
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
  assert.equal(repeated.body.total, 1100);
  assert.equal(repeated.body.paymentFee.percent, 8.5);
  assert.equal(db.getOrders().length, 1);
  const updated = await request({ requestId: 'b'.repeat(32), paymentFeePercent: 12 });
  assert.equal(updated.status, 200);
  assert.notEqual(updated.body.id, first.body.id);
  assert.equal(updated.body.total, 1100);
  assert.equal(updated.body.paymentFee.percent, 12);
  assert.equal(updated.body.paymentFee.baseAmount, 982.1429);
  assert.equal(db.getOrder(first.body.id).total, 1100);
  assert.equal(db.getOrder(first.body.id).paymentFee.baseAmount, 1013.8249);
});

test('/api/order повторяет заказ прежней версии с сохранённой доплатой и прежним отпечатком', async t => {
  const { db, settings, request } = orderHarness(t);
  const paymentFee = { provider: 'platega', method: 'SBP_ONLINE', baseAmount: 1100, amount: 93.5, percent: 8.5 };
  const legacy = db.createOrder({ draft: true, total: 1193.5, itemsTotal: 1000, deliveryPrice: 100,
    paymentFee, checkoutRequestId: 'a'.repeat(32),
    // Отпечаток синтетического запроса из версии с доплатой: формат переживает обновление.
    checkoutRequestHash: 'e5175cce6d4ef635b8a47152a26f5e1a543e1f421b0f9db75a4ec9a7c609240b' });
  settings.plategaFeePercent = 12;
  const result = await request({ paymentTotal: 1193.5 });
  assert.equal(result.status, 200);
  assert.equal(result.body.id, legacy.id);
  assert.equal(result.body.reused, true);
  assert.equal(result.body.total, 1193.5);
  assert.deepEqual(JSON.parse(JSON.stringify(result.body.paymentFee)), paymentFee);
  assert.equal(db.getOrders().length, 1);
});

test('/api/order сохраняет точный итог на границе округления базы и комиссии', async t => {
  const { db, request } = orderHarness(t, { shipping: 1.2 });
  const result = await request({ paymentTotal: 1001.2 });
  assert.equal(result.status, 200);
  assert.equal(result.body.total, 1001.2);
  assert.equal(result.body.paymentFee.baseAmount, 922.7649);
  assert.equal(result.body.paymentFee.amount, 78.44);
  assert.equal(db.getOrder(result.body.id).deliveryPrice, 1.2);
});

test('/api/order не создаёт заказ, если тариф не позволяет получить точную сумму', async t => {
  const { db, settings, request } = orderHarness(t, { shipping: 0.02 });
  settings.plategaFeePercent = 12;
  assert.equal(PAYMENTS.checkoutFee(settings, 1000.02), null);
  const result = await request({ paymentFeePercent: 12, paymentTotal: 1000.02 });
  assert.equal(result.status, 400);
  assert.match(result.body.error, /точную сумму оплаты/);
  assert.equal(db.getOrders().length, 0);
});

test('/api/order отклоняет устаревший и отсутствующий показанный процент до создания заказа', async t => {
  const { db, settings, request } = orderHarness(t);
  settings.plategaFeePercent = 12;
  for (const paymentFeePercent of [8.5, undefined, '', 'не число']) {
    const result = await request({ paymentFeePercent });
    assert.equal(result.status, 409);
    assert.match(result.body.error, /Обновите страницу оформления/);
    assert.equal(db.getOrders().length, 0);
  }
});

test('/api/order отклоняет неверный итог и доплату из вкладки прежней версии', async t => {
  const { db, request } = orderHarness(t);
  for (const paymentTotal of [undefined, null, '', '1100', 1, 1099.99, 1100.01, 1193.5]) {
    const result = await request({ paymentTotal });
    assert.equal(result.status, 409);
    assert.match(result.body.error, /актуальную сумму с доставкой/);
    assert.doesNotMatch(result.body.error, /комисси/i);
    assert.equal(db.getOrders().length, 0);
  }
});

test('/api/order требует новый показанный итог после изменения доставки при прежнем проценте', async t => {
  const { db, request, setShipping } = orderHarness(t);
  setShipping(200);
  const stale = await request();
  assert.equal(stale.status, 409);
  assert.equal(db.getOrders().length, 0);
  const updated = await request({ paymentTotal: 1200 });
  assert.equal(updated.status, 200);
  assert.equal(updated.body.total, 1200);
  assert.equal(updated.body.paymentFee.percent, 8.5);
  assert.equal(updated.body.paymentFee.baseAmount, 1105.9908);
  assert.equal(updated.body.paymentFee.amount, 94.01);
  // Итог входит в отпечаток запроса: тот же ключ с другой суммой — конфликт.
  const changed = await request();
  assert.equal(changed.status, 409);
  assert.equal(changed.body.errorCode, 'idempotency_conflict');
  const repeated = await request({ paymentTotal: 1200 });
  assert.equal(repeated.status, 200);
  assert.equal(repeated.body.id, updated.body.id);
  assert.equal(repeated.body.reused, true);
  assert.equal(db.getOrders().length, 1);
});

test('/api/order применяет предел кассы к прежнему полному итогу без доплаты', async t => {
  const { db, settings, request } = orderHarness(t);
  settings.payMaxTotal = 1150;
  const allowed = await request();
  assert.equal(allowed.status, 200);
  assert.equal(allowed.body.total, 1100);
  settings.payMaxTotal = 1050;
  const result = await request({ requestId: 'b'.repeat(32) });
  assert.equal(result.status, 400);
  assert.match(result.body.error, /Один заказ — не более/);
  assert.equal(db.getOrders().length, 1);
});

test('/api/order фиксирует нулевой процент и не пересчитывает его при повторе', async t => {
  const { db, settings, request } = orderHarness(t);
  settings.plategaFeePercent = 0;
  for (const patch of [{ paymentFeePercent: undefined }, { paymentFeePercent: 0, paymentTotal: undefined }]) {
    assert.equal((await request(patch)).status, 409);
    assert.equal(db.getOrders().length, 0);
  }
  const first = await request({ paymentFeePercent: 0 });
  assert.equal(first.status, 200);
  assert.deepEqual(JSON.parse(JSON.stringify(first.body.paymentFee)), {
    provider: 'platega', method: 'SBP_ONLINE', mode: 'included', baseAmount: 1100, amount: 0, percent: 0
  });
  settings.plategaFeePercent = 8.5;
  const repeated = await request({ paymentFeePercent: 0 });
  assert.equal(repeated.status, 200);
  assert.equal(repeated.body.id, first.body.id);
  assert.equal(repeated.body.paymentFee.percent, 0);
  assert.equal(db.getOrder(first.body.id).paymentFee.baseAmount, 1100);
});

test('/api/order при нескольких кассах сохраняет прежний итог, а без Platega не требует её расчёт', async t => {
  const { db, settings, request } = orderHarness(t);
  Object.assign(settings, { alfabankEnabled: true, alfabankLogin: 'synthetic-login',
    alfabankPassword: 'synthetic-password', payMethods: ['SBP_ONLINE', 'CARD_ONLINE'] });
  const mixed = await request();
  assert.equal(mixed.status, 200);
  assert.equal(mixed.body.total, 1100);
  assert.equal(mixed.body.paymentFee.mode, 'included');
  settings.plategaEnabled = false;
  const other = await request({ requestId: 'b'.repeat(32), paymentFeePercent: undefined, paymentTotal: undefined });
  assert.equal(other.status, 200);
  assert.equal(other.body.total, 1100);
  assert.equal(other.body.paymentFee, null);
  assert.equal(db.getOrders().length, 2);
});

test('хранилище не принимает комиссию, не совпадающую с итогом заказа', t => {
  const db = freshDb(t);
  const fee = { provider: 'platega', method: 'SBP_ONLINE', baseAmount: 1000, amount: 85, percent: 8.5 };
  const valid = db.createOrder({ total: 1085, paymentFee: fee });
  assert.deepEqual(db.getOrder(valid.id).paymentFee, fee);
  const forged = db.createOrder({ total: 1000, paymentFee: fee });
  assert.equal(db.getOrder(forged.id).paymentFee, null);
});

test('хранилище проверяет внутреннюю комиссию, базу и режим независимо от присланного снимка', t => {
  const db = freshDb(t);
  const fee = { provider: 'platega', method: 'SBP_ONLINE', mode: 'included',
    baseAmount: 1013.8249, amount: 86.18, percent: 8.5 };
  const valid = db.createOrder({ total: 1100, paymentFee: fee });
  assert.deepEqual(db.getOrder(valid.id).paymentFee, fee);
  for (const patch of [{ baseAmount: 1013.82 }, { baseAmount: 1013.825 }, { amount: 86.17 },
    { percent: 12 }, { mode: 'unknown' }, { mode: undefined }, { provider: 'alfabank' }, { method: 'CARD_ONLINE' }]) {
    const forged = db.createOrder({ total: 1100, paymentFee: { ...fee, ...patch } });
    assert.equal(db.getOrder(forged.id).paymentFee, null);
  }
  const wrongTotal = db.createOrder({ total: 1100.01, paymentFee: fee });
  assert.equal(db.getOrder(wrongTotal.id).paymentFee, null);
});
