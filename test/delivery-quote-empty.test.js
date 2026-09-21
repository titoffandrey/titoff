'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

function quoteRoute() {
  const source = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const route = source.slice(source.indexOf("app.post('/api/delivery/quote'"), source.indexOf("app.post('/api/delivery/points'"));
  const calls = { address: 0, prices: 0, days: 0 };
  const shipping = require('../lib/delivery-price');
  let handler;
  new Function('app', 'rateLimited', 'ADDRESS', 'SHIP', 'SHIPDAYS', 'settings', route)(
    { post: (_path, fn) => { handler = fn; } }, () => false,
    { checkAddress: address => { calls.address++; return require('../lib/address').checkAddress(address); } },
    { quoteAll: (...args) => { calls.prices++; return shipping.quoteAll(...args); } },
    { textAll: () => { calls.days++; return { cdek: { pvz: '2–3 дня' } }; } },
    () => ({})
  );
  return { calls, run(body) { let reply; handler({ body }, { json: value => { reply = value; } }); return reply; } };
}

test('delivery quote: no items means no address validation, prices or delivery days', () => {
  const route = quoteRoute();
  for (const total of [undefined, null, 0, -1, '', 'abc', Infinity, -Infinity, NaN]) {
    for (const address of ['', 'г Москва, ул Тверская, д 1']) {
      assert.deepEqual(route.run({ total, address }), { ok: true, valid: false, error: '', prices: null, days: null });
    }
  }
  assert.deepEqual(route.run(undefined), { ok: true, valid: false, error: '', prices: null, days: null });
  assert.deepEqual(route.calls, { address: 0, prices: 0, days: 0 });
});

test('delivery quote resumes for selected goods and uses separate carrier tariffs', () => {
  const route = quoteRoute();
  route.run({ total: 0, address: 'г Москва, ул Тверская, д 1' });
  for (const total of [17850, 19690, 19700, 19840]) {
    const reply = route.run({ total, address: 'г Москва, ул Тверская, д 1' });
    assert.equal(reply.ok, true);
    assert.equal(reply.valid, true);
    assert.equal(reply.prices.cdek.pvz, 300);
    assert.equal(reply.prices.ozon.pvz, 220);
    assert.ok(reply.days.cdek.pvz);
  }
  assert.deepEqual(route.calls, { address: 4, prices: 4, days: 4 });
});

test('delivery quote still rejects an incomplete address with selected goods', () => {
  const route = quoteRoute();
  const reply = route.run({ total: 17850, address: '' });
  assert.equal(reply.valid, false);
  assert.equal(reply.prices, null);
  assert.equal(reply.days, null);
  assert.ok(reply.error);
  assert.deepEqual(route.calls, { address: 1, prices: 0, days: 0 });
});
