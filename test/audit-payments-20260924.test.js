'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const PROMO = require('../lib/promo');
const PRICING = require('../lib/pricing');
const PAYMENTS = require('../lib/payments');
const SHIP = require('../lib/delivery-price');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const product = { id: 'audit-product', name: 'Товар', price: 10000, discountPercent: 20, inStock: true };

test('ручной код «скидка товара» применяется при пустом или выключенном коде по умолчанию', () => {
  for (const promoDefault of ['', 'DISABLED']) {
    const settings = {
      promoOn: true, promoDefault,
      promoCodes: [{ code: 'SALE', percent: 0 }, { code: 'DISABLED', percent: 0, on: false }]
    };
    assert.equal(PROMO.shopPrice(product.price, product, settings).price, 10000);
    const state = PROMO.stateOf(settings, { code: 'SALE' });
    const row = PRICING.resolve(product, {}, settings, state, { previous: true });
    assert.equal(state.promo.code, 'SALE');
    assert.equal(row.problem, null);
    assert.equal(row.price, 8000);
    assert.equal(row.saved, 2000);
    assert.equal(PRICING.resolve(product, {}, settings, PROMO.stateOf(settings, { off: true })).price, 10000);
  }
});

test('ручной процентный код без кода по умолчанию даёт только свой процент', () => {
  const settings = { promoOn: true, promoCodes: [{ code: 'VIP10', percent: 10 }] };
  assert.equal(PRICING.resolve(product, {}, settings, PROMO.stateOf(settings, { code: 'VIP10' })).price, 9000);
  assert.equal(PRICING.resolve(product, {}, settings, PROMO.stateOf(settings, null)).price, 10000);
  settings.promoOn = false;
  assert.equal(PRICING.resolve(product, {}, settings, PROMO.stateOf(settings, { code: 'VIP10' })).price, 10000);
});

test('ручной процентный код сохраняет более выгодную автоматическую скидку товара', () => {
  const settings = {
    promoOn: true, promoDefault: 'SALE',
    promoCodes: [{ code: 'SALE', percent: 0 }, { code: 'VIP10', percent: 10 }]
  };
  assert.equal(PRICING.resolve(product, {}, settings, PROMO.stateOf(settings, { code: 'VIP10' })).price, 8000);
});

test('резервная касса принимает сумму, которую не поддерживает первая касса способа', () => {
  const settings = {
    payPrimary: 'meridianpay', payMethods: ['SBP'],
    meridianpayEnabled: true, meridianpayApiKey: 'test-only',
    meridianpayMerchantId: '11111111-1111-4111-8111-111111111111',
    crocopayEnabled: true, crocopayClientId: 'test-only', crocopayClientSecret: 'test-only'
  };
  assert.deepEqual(PAYMENTS.offeredMethods(settings), [{ id: 'SBP', provider: 'meridianpay' }]);
  assert.deepEqual(PAYMENTS.chainFor(settings, null, 'SBP', 'RUB', 1000.5).map(p => p.id), ['crocopay']);
  assert.equal(PAYMENTS.modeFor(settings, 1000.5), 'cashbox');
  assert.equal(PAYMENTS.modeFor({ ...settings, crocopayEnabled: false }, 1000.5), 'request');
  assert.equal(PAYMENTS.modeFor({ ...settings, payMethods: [] }, 1000.5), 'request');
});

function chatFixture(s, orders) {
  let settingsReads = 0, orderReads = 0, delivered = 0;
  const db = {
    getOrders: () => { orderReads++; return orders; },
    isOrderArchived: () => false,
    setOrderChatFollowup: () => {}
  };
  const chat = {
    visible: value => value.chatEnabled,
    get: () => ({ id: 'chat', visitorId: 'visitor', mode: 'ai', messages: [] }),
    say: () => { delivered++; return true; },
    flush: () => {}
  };
  const sandbox = {
    module: { exports: {} },
    require: name => ({
      './ai': { enabled: value => value.aiEnabled },
      '../public/phone': require('../public/phone'),
      './tracking': {},
      './render': { orderPayUntil: () => Infinity, payClosed: () => false }
    })[name]
  };
  require('node:vm').runInNewContext(require('node:fs').readFileSync(
    require('node:path').join(__dirname, '../lib/order-chat.js'), 'utf8'), sandbox);
  const service = sandbox.module.exports.create({
    db, chat, settings: () => { settingsReads++; return s; }, prepareShipment: () => {}
  });
  return { service, counts: () => ({ settingsReads, orderReads, delivered }) };
}

test('выключенные сообщения заказа не сканируют историю заказов каждые пять секунд', () => {
  for (const settings of [{ chatEnabled: false, aiEnabled: true }, { chatEnabled: true, aiEnabled: false }]) {
    const fixture = chatFixture(settings, []);
    fixture.service.sweep();
    assert.deepEqual(fixture.counts(), { settingsReads: 1, orderReads: 0, delivered: 0 });
  }
});

test('пакет автоматических сообщений использует один снимок настроек', () => {
  const now = Date.now();
  const orders = Array.from({ length: 1000 }, (_, i) => ({
    id: 'order-' + i, number: i, visitorId: 'visitor', createdAt: now - 130000,
    chatFollowup: { chatId: 'chat', enrolledAt: now - 130000 }
  }));
  const fixture = chatFixture({ chatEnabled: true, aiEnabled: true }, orders);
  fixture.service.sweep(now);
  assert.deepEqual(fixture.counts(), { settingsReads: 1, orderReads: 1, delivered: orders.length });
});

// Настоящий обработчик заказа с синтетическим каталогом: останавливаемся в
// точке записи заказа, без диска, уведомлений, аккаунтов и обращения к кассе.
function pickupOrderRoute(destination) {
  const source = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8');
  const script = source.slice(source.indexOf("app.post('/api/order'"),
    source.indexOf('/* ============================ ОНЛАЙН-ЧАТ ВИТРИНЫ'));
  const point = { code: 'AUDIT-PVZ', official: true };
  const stop = Symbol('stop before disk write');
  let handler, captured;
  vm.runInNewContext(script, {
    app: { post: (_name, fn) => { handler = fn; } },
    settings: () => ({}), checkoutRequestHash: () => '',
    db: {
      getOrderByCheckoutRequest: () => null, visibleProduct: () => product, normHost: () => '',
      createOrder: value => { captured = value; throw stop; }
    },
    anonymousSessionId: () => '', rateLimited: () => false,
    PROMO, PRICING, PAYMENTS, SHIP,
    PHONE: require('../public/phone'), EMAIL: require('../lib/email'),
    CUSTOMERS: { enabled: () => false }, DELIVERY: require('../lib/delivery'), ADDRESS: require('../lib/address'),
    PICKUP: { findPoint: (_carrier, code) => code === point.code ? point : null, addressOf: () => destination },
    metrics: { visitorId: () => null, context: () => ({}) }, clientIp: () => '', cloudflareTrusted: () => false
  });
  return async patch => {
    captured = null;
    let response;
    try {
      await handler({ headers: { host: 'example.test' }, body: {
        requestId: 'a'.repeat(32), items: [{ id: product.id, price: 10000, qty: 1 }],
        firstName: 'Тест', lastName: 'Покупатель', phone: '+79991234567',
        address: 'Москва, ул Тверская, д 1', delivery: 'cdek', deliveryMode: 'pvz', pickupCode: point.code,
        ...patch
      } }, { json: (body, status = 200) => { response = { body, status }; } });
    } catch (error) { if (error !== stop) throw error; }
    return { response, order: captured };
  };
}

test('заказ не принимает далёкий ПВЗ с московским тарифом доставки', async () => {
  const destination = 'Приморский край, Владивосток, ул Светланская, д 1';
  assert.equal(SHIP.quote('cdek', 'pvz', destination, 10000).price, 1010);
  const run = pickupOrderRoute(destination);
  const result = await run();
  assert.equal(result.order, null, 'нельзя создать заказ за 300 рублей доставки вместо 1010');
  assert.equal(result.response.status, 409);
  assert.equal(result.response.body.errorCode, 'pickup_zone_changed');
  // Курьер доставляет по адресу покупателя: сохранённый в браузере код ПВЗ
  // при переключении способа не участвует в расчёте и не блокирует заказ.
  const courier = await run({ deliveryMode: 'courier' });
  assert.equal(courier.order.deliveryPrice, 520);
  assert.equal(courier.order.pickupAddress, '');
});

test('ПВЗ своей зоны оформляется по той же цене, что предварительный расчёт', async () => {
  const run = pickupOrderRoute('Москва, ул Арбат, д 1');
  const result = await run();
  assert.equal(result.response, undefined);
  assert.equal(result.order.deliveryZone, 'msk');
  assert.equal(result.order.deliveryPrice, SHIP.quoteAll('Москва, ул Тверская, д 1', 10000).prices.cdek.pvz);
  assert.equal(result.order.total, 10300);
});

test('подсказки ПВЗ фильтруют другую тарифную зону даже при подставленных координатах', () => {
  const source = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8');
  const script = source.slice(source.indexOf("app.post('/api/delivery/points'"),
    source.indexOf('// Заказ -> цена считается'));
  let handler, response;
  vm.runInNewContext(script, {
    app: { post: (_name, fn) => { handler = fn; } }, rateLimited: () => false,
    DELIVERY: require('../lib/delivery'), SHIP,
    PICKUP: { has: () => true, nearest: () => [
      { code: 'NEAR', address: 'Москва, ул Арбат, д 1' },
      { code: 'FAR', address: 'Приморский край, Владивосток, ул Светланская, д 1' }
    ] }, OSM: { ensureTile: () => false }
  });
  handler({ body: { method: 'cdek', address: 'Москва, ул Тверская, д 1', lat: 43.12, lon: 131.88 } },
    { json: value => { response = value; } });
  assert.equal(response.items.length, 1);
  assert.equal(response.items[0].code, 'NEAR');
});
