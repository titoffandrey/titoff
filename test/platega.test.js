'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const PLATEGA = require('../lib/platega');

const MERCHANT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const TRANSACTION = '99c2cb88-761b-4f3c-9988-f685b756b854';
const ATTEMPT = 'a91209d1ae67f399bd7ed6c4';
const SECRET = 'platega-test-secret-never-live';
const SETTINGS = { plategaEnabled: true, plategaMerchantId: MERCHANT, plategaSecret: SECRET };
const PARAMS = {
  amount: 1000.25, currency: 'RUB', method: 'ONLINE_PAYMENT', externalId: ATTEMPT,
  description: 'Заказ 1234', returnUrl: 'https://shop.example/pay/private-order',
  callbackUrl: 'https://shop.example/api/pay/platega/callback?token=never-send-in-payload'
};
const CREATED = {
  transactionId: TRANSACTION, status: 'PENDING',
  url: 'https://pay.platega.io/?id=' + TRANSACTION + '&mh=merchant', expiresIn: '00:15:00', rate: 95
};
const DETAILS = {
  id: TRANSACTION, status: 'CONFIRMED', paymentDetails: { amount: 1000.25, currency: 'RUB' },
  payload: ATTEMPT, expiresIn: '00:15:00', paymentMethod: '2', mechantId: MERCHANT
};
const CALLBACK = { id: TRANSACTION, amount: 1000.25, currency: 'RUB', status: 'CONFIRMED', payload: ATTEMPT };
const EXPECTED = { id: ATTEMPT, invoiceId: TRANSACTION, amount: 1000.25, currency: 'RUB', method: 'ONLINE_PAYMENT' };
function json(body, status = 200) { return new Response(JSON.stringify(body), { status }); }
function mockFetch(t, handler) {
  // Каждый тест перехватывает fetch. Настоящих запросов к сервису с этой машины нет.
  return t.mock.method(globalThis, 'fetch', handler);
}

test('Platega включается только с корректным merchant ID и серверным секретом', () => {
  assert.equal(PLATEGA.configured(SETTINGS), true);
  assert.equal(PLATEGA.enabled(SETTINGS), true);
  assert.equal(PLATEGA.configured({ ...SETTINGS, plategaSecret: '' }), false);
  assert.equal(PLATEGA.configured({ ...SETTINGS, plategaMerchantId: '../../other' }), false);
  assert.equal(PLATEGA.configured({ ...SETTINGS, plategaSecret: 'secret\r\nX-Other: value' }), false);
  assert.equal(PLATEGA.enabled({ ...SETTINGS, plategaEnabled: false }), false);
  assert.equal(PLATEGA.configured({ ...SETTINGS, plategaEnabled: false }), true);
  assert.equal(PLATEGA.supports('ONLINE_PAYMENT'), true);
  for (const method of ['SBP', 'TO_CARD', 'CARD_ONLINE', '__proto__']) assert.equal(PLATEGA.supports(method), false);
});

test('Platega принимает точные рубли и не округляет посторонние значения', () => {
  assert.equal(PLATEGA.toMinor(1000.25), 100025);
  assert.equal(PLATEGA.toMinor('0.01'), 1);
  assert.equal(PLATEGA.acceptsAmount(1000.25, 'RUB'), true);
  for (const value of [0, -1, NaN, Infinity, null, true, [], {}, '', ' 10 ', '1e3', 1.001, Number.MAX_SAFE_INTEGER]) {
    assert.equal(PLATEGA.toMinor(value), null, String(value));
  }
  for (const currency of ['USD', '', null]) assert.equal(PLATEGA.acceptsAmount(1000, currency), false);
  assert.equal(PLATEGA.stateOf('CHARGEBACKED'), 'refunded');
  assert.equal(PLATEGA.stateOf('CANCELED'), 'cancelled');
  for (const state of ['SUCCESS', 'confirmed', '__proto__', 'toString']) assert.equal(PLATEGA.stateOf(state), '');
});

test('POST v2 создаёт одну размещённую форму без paymentMethod, id и данных покупателя', async t => {
  const fetch = mockFetch(t, async (url, init) => {
    assert.equal(url, 'https://app.platega.io/v2/transaction/process');
    assert.equal(init.method, 'POST');
    assert.equal(init.redirect, 'error');
    assert.equal(init.headers['X-MerchantId'], MERCHANT);
    assert.equal(init.headers['X-Secret'], SECRET);
    const body = JSON.parse(init.body);
    assert.deepEqual(body, {
      paymentDetails: { amount: 1000.25, currency: 'RUB' }, description: 'Заказ 1234',
      return: PARAMS.returnUrl, failedUrl: PARAMS.returnUrl, payload: ATTEMPT
    });
    assert.equal(init.body.includes('never-send'), false);
    return json(CREATED);
  });
  const before = Date.now();
  const result = await PLATEGA.createInvoice(SETTINGS, PARAMS);
  assert.equal(result.ok, true);
  assert.equal(fetch.mock.calls.length, 1);
  assert.equal(result.invoice.id, TRANSACTION);
  assert.equal(result.invoice.externalId, ATTEMPT);
  assert.equal(result.invoice.method, 'ONLINE_PAYMENT');
  assert.equal(result.invoice.amount, 1000.25);
  assert.equal(result.invoice.requisite, CREATED.url);
  assert.ok(result.invoice.expiresAt >= before + 900000 && result.invoice.expiresAt <= Date.now() + 900000);
});

test('Локальная валидация отклоняет невозможный запрос до fetch', async t => {
  const fetch = mockFetch(t, async () => { throw new Error('network must not run'); });
  for (const changes of [
    { amount: 1.001 }, { currency: 'USD' }, { method: 'SBP' }, { externalId: '../order' },
    { returnUrl: 'http://shop.example/pay' }, { returnUrl: 'javascript:alert(1)' },
    { returnUrl: 'https://user:password@shop.example/pay' }, { failedUrl: 'data:text/html,bad' }
  ]) {
    const result = await PLATEGA.createInvoice(SETTINGS, { ...PARAMS, ...changes });
    assert.equal(result.ok, false);
    assert.equal(!!result.ambiguous, false);
  }
  assert.equal(fetch.mock.calls.length, 0);
});

test('Потерянный POST и HTTP 5xx остаются неоднозначными без автоматического повтора', async t => {
  const fetch = mockFetch(t, async () => { throw new Error('secret=' + SECRET); });
  const lost = await PLATEGA.createInvoice(SETTINGS, PARAMS);
  assert.deepEqual(lost, { ok: false, error: 'network', ambiguous: true });
  assert.equal(JSON.stringify(lost).includes(SECRET), false);
  fetch.mock.mockImplementation(async () => json({ secret: SECRET, message: SECRET }, 503));
  const unavailable = await PLATEGA.createInvoice(SETTINGS, PARAMS);
  assert.deepEqual(unavailable, { ok: false, error: 'http_503', http: 503, ambiguous: true });
  assert.equal(fetch.mock.calls.length, 2);
  for (const result of [lost, unavailable, { ok: false, error: 'no_requisite' }]) assert.equal(PLATEGA.retryableStart(result), false);
});

test('Явный HTTP отказ не хранит сырое тело и не объявляется созданной транзакцией', async t => {
  const fetch = mockFetch(t, async () => json({ message: SECRET }, 401));
  assert.deepEqual(await PLATEGA.createInvoice(SETTINGS, PARAMS), {
    ok: false, error: 'unauthorized', http: 401, ambiguous: false
  });
  fetch.mock.mockImplementation(async () => json({ message: SECRET }, 400));
  const result = await PLATEGA.createInvoice(SETTINGS, PARAMS);
  assert.equal(result.error, 'http_400');
  assert.equal(result.ambiguous, false);
  assert.equal(JSON.stringify(result).includes(SECRET), false);
});

test('Невалидный успешный ответ и частичный invoice не теряют неоднозначную попытку', async t => {
  const fetch = mockFetch(t, async () => new Response('<html>' + SECRET));
  const malformed = await PLATEGA.createInvoice(SETTINGS, PARAMS);
  assert.equal(malformed.error, 'invalid_response');
  assert.equal(malformed.ambiguous, true);
  for (const [changes, code] of [
    [{ url: 'javascript:alert(1)' }, 'no_requisite'],
    [{ url: 'https://secret:pass@pay.platega.io' }, 'no_requisite'],
    [{ url: 'https://pay.platega.io/?token=' + 'x'.repeat(2048) }, 'no_requisite'],
    [{ url: 'https://pay.platega.io/?token=' + 'я'.repeat(400) }, 'no_requisite'],
    [{ expiresIn: '900' }, 'bad_expiry'],
    [{ status: 'CONFIRMED' }, 'bad_invoice_state'],
    [{ payload: 'some-other-attempt' }, 'payload_mismatch'],
    [{ paymentDetails: { amount: 1000.26, currency: 'RUB' } }, 'amount_mismatch'],
    [{ paymentDetails: { amount: 1000.25, currency: 'USD' } }, 'currency_mismatch']
  ]) {
    fetch.mock.mockImplementation(async () => json({ ...CREATED, ...changes }));
    const result = await PLATEGA.createInvoice(SETTINGS, PARAMS);
    assert.equal(result.error, code);
    assert.equal(result.ambiguous, true);
    assert.equal(result.invoice.id, TRANSACTION);
  }
  fetch.mock.mockImplementation(async () => json({ ...CREATED, transactionId: '' }));
  const missing = await PLATEGA.createInvoice(SETTINGS, PARAMS);
  assert.equal(missing.error, 'no_invoice_id');
  assert.equal(missing.ambiguous, true);
  assert.equal(missing.invoice, undefined);
});

test('Таймаут охватывает зависшее тело после полученных заголовков', async t => {
  const realSetTimeout = globalThis.setTimeout;
  t.mock.method(globalThis, 'setTimeout', callback => realSetTimeout(callback, 10));
  let aborted = false;
  mockFetch(t, async (url, init) => {
    init.signal.addEventListener('abort', () => { aborted = true; });
    return { ok: true, status: 200, text: () => new Promise(() => {}) };
  });
  // Держим цикл событий живым, как это делает реальный сокет fetch.
  const keepAlive = setInterval(() => {}, 1000);
  try {
    assert.deepEqual(await PLATEGA.createInvoice(SETTINGS, PARAMS), {
      ok: false, error: 'timeout', http: 200, ambiguous: true
    });
    assert.equal(aborted, true);
  } finally { clearInterval(keepAlive); }
});

test('Большое тело ограничено до JSON-разбора и не возвращается вызывающему', async t => {
  mockFetch(t, async () => new Response('x'.repeat(1024 * 1024 + 1)));
  const result = await PLATEGA.createInvoice(SETTINGS, PARAMS);
  assert.equal(result.error, 'invalid_response');
  assert.equal(result.ambiguous, true);
  assert.ok(JSON.stringify(result).length < 200);
});

test('GET статуса использует UUID и рубли, не продлевает срок и сохраняет payload', async t => {
  const fetch = mockFetch(t, async (url, init) => {
    assert.equal(url, 'https://app.platega.io/transaction/' + TRANSACTION);
    assert.equal(init.method, 'GET');
    assert.equal(init.redirect, 'error');
    assert.equal(init.headers['X-Secret'], SECRET);
    assert.equal(init.body, undefined);
    return json(DETAILS);
  });
  const result = await PLATEGA.invoice(SETTINGS, TRANSACTION);
  assert.equal(result.ok, true);
  assert.equal(result.invoice.amount, 1000.25);
  assert.equal(result.invoice.state, 'paid');
  assert.equal(result.invoice.externalId, ATTEMPT);
  assert.equal(result.invoice.expiresAt, 0);
  assert.deepEqual(PLATEGA.matchesInvoice(EXPECTED, result.invoice), { ok: true });
  assert.equal((await PLATEGA.invoice(SETTINGS, '../other')).error, 'bad_invoice_id');
  assert.equal(fetch.mock.calls.length, 1);
});

test('Подтверждение требует точно тот же id, payload, сумму, валюту и способ', () => {
  const actual = PLATEGA.invoiceView(DETAILS);
  for (const [change, reason] of [
    [{ id: MERCHANT }, 'invoice_id'], [{ id: '' }, 'invoice_id'],
    [{ amount: 1000.24 }, 'amount'], [{ amount: 1000.26 }, 'amount'], [{ amount: 100025 }, 'amount'],
    [{ amount: 1000.251 }, 'amount'], [{ amount: null }, 'amount'],
    [{ currency: '' }, 'currency'], [{ currency: 'USD' }, 'currency'],
    [{ externalId: '' }, 'payload'], [{ externalId: 'another-attempt-id' }, 'payload'],
    [{ method: 'CARD_ONLINE' }, 'method']
  ]) assert.deepEqual(PLATEGA.matchesInvoice(EXPECTED, { ...actual, ...change }), { ok: false, reason });
  assert.deepEqual(PLATEGA.matchesInvoice({ ...EXPECTED, id: undefined, attemptId: ATTEMPT }, actual), { ok: true });
  assert.deepEqual(PLATEGA.matchesInvoice({ ...EXPECTED, id: undefined, externalId: ATTEMPT }, actual), { ok: true });
  assert.deepEqual(PLATEGA.matchesInvoice({ ...EXPECTED, currency: '' }, actual), { ok: false, reason: 'currency' });
  assert.deepEqual(PLATEGA.matchesInvoice(EXPECTED, PLATEGA.invoiceView({ ...DETAILS, paymentDetails: {} })), { ok: false, reason: 'currency' });
  assert.deepEqual(PLATEGA.matchesInvoice(EXPECTED, PLATEGA.invoiceView({ ...DETAILS, payload: ' ' + ATTEMPT + ' ' })), { ok: false, reason: 'payload' });
});

test('Незнакомый статус не становится оплаченным или отменённым', async t => {
  mockFetch(t, async () => json({ ...DETAILS, status: 'SUCCESS' }));
  assert.deepEqual(await PLATEGA.invoice(SETTINGS, TRANSACTION), { ok: false, error: 'unknown_status' });
});

test('GET не принимает транзакцию другого мерчанта, если API вернул владельца', async t => {
  const fetch = mockFetch(t, async () => json({ ...DETAILS, mechantId: TRANSACTION }));
  assert.deepEqual(await PLATEGA.invoice(SETTINGS, TRANSACTION), { ok: false, error: 'merchant_mismatch' });
  fetch.mock.mockImplementation(async () => json({ ...DETAILS, mechantId: MERCHANT, merchantId: TRANSACTION }));
  assert.deepEqual(await PLATEGA.invoice(SETTINGS, TRANSACTION), { ok: false, error: 'merchant_mismatch' });
  fetch.mock.mockImplementation(async () => json({ ...DETAILS, mechantId: undefined }));
  assert.equal((await PLATEGA.invoice(SETTINGS, TRANSACTION)).ok, true);
});

test('Callback требует оба секретных заголовка без дубликатов', () => {
  const verify = headers => PLATEGA.verifyCallback(SETTINGS, CALLBACK, Buffer.from(JSON.stringify(CALLBACK)), headers);
  assert.equal(verify({ 'x-merchantid': MERCHANT, 'x-secret': SECRET }), true);
  assert.equal(verify({ 'X-MerchantId': MERCHANT, 'X-Secret': SECRET }), true);
  for (const headers of [
    {}, { 'x-merchantid': MERCHANT }, { 'x-secret': SECRET },
    { 'x-merchantid': TRANSACTION, 'x-secret': SECRET },
    { 'x-merchantid': MERCHANT, 'x-secret': SECRET + 'x' },
    { 'x-merchantid': MERCHANT, 'x-secret': [SECRET] },
    { 'x-merchantid': MERCHANT, 'x-secret': SECRET + ', ' + SECRET },
    { 'x-merchantid': MERCHANT, 'x-secret': SECRET, 'X-Secret': SECRET }
  ]) assert.equal(verify(headers), false);
  assert.equal(PLATEGA.verifyCallback({ ...SETTINGS, plategaSecret: '' }, CALLBACK, '', {
    'x-merchantid': MERCHANT, 'x-secret': SECRET
  }), false);
});

test('Callback разбирает рубли и непрозрачный payload, отклоняет неполные тела', () => {
  const view = PLATEGA.callbackView(CALLBACK);
  assert.equal(view.amount, 1000.25);
  assert.equal(view.externalId, ATTEMPT);
  assert.equal(view.state, 'paid');
  assert.equal(PLATEGA.callbackView({ ...CALLBACK, payload: undefined }).externalId, '');
  assert.equal(PLATEGA.callbackView({ ...CALLBACK, payload: '' }).externalId, '');
  for (const change of [
    { id: '' }, { payload: null }, { payload: { order: 1 } }, { payload: ' ' + ATTEMPT }, { amount: 1.001 },
    { amount: true }, { currency: '' }, { currency: 'USD' }, { status: '__proto__' }
  ]) assert.equal(PLATEGA.callbackView({ ...CALLBACK, ...change }), null);
  assert.equal(PLATEGA.callbackView({ ...CALLBACK, status: 'CHARGEBACKED' }).state, 'refunded');
});

test('Отпечаток запроса и срок неоднозначной попытки не дают повторить чужую сумму', () => {
  assert.equal(PLATEGA.sameStartRequest(EXPECTED, EXPECTED), true);
  assert.equal(PLATEGA.sameStartRequest(EXPECTED, { ...EXPECTED, amount: 1000.26 }), false);
  assert.equal(PLATEGA.sameStartRequest(EXPECTED, { ...EXPECTED, amount: 1000.251 }), false);
  assert.equal(PLATEGA.sameStartRequest(EXPECTED, { ...EXPECTED, currency: 'USD' }), false);
  assert.equal(PLATEGA.unresolvedStartTtl, 30 * 60 * 1000);
  assert.equal(PLATEGA.expiryMs('00:15:00', 100), 900100);
  for (const value of ['900', '00:60:00', '00:00:00', '', 900]) assert.equal(PLATEGA.expiryMs(value, 100), 0);
});

test('Проверка доступа читает баланс один раз, скрывает остатки и сбрасывается при смене ключа', async t => {
  PLATEGA.forgetMethods();
  const fetch = mockFetch(t, async (url, init) => {
    assert.equal(url, 'https://app.platega.io/balance/all');
    assert.equal(init.method, 'GET');
    assert.equal(init.redirect, 'error');
    return json([{ amount: 345678.12, currency: 'RUB', frozenBalance: 12345 }]);
  });
  const [first, second] = await Promise.all([PLATEGA.availableOptions(SETTINGS), PLATEGA.availableOptions(SETTINGS)]);
  assert.equal(first.ok, true);
  assert.deepEqual(first, second);
  assert.deepEqual(first.options, ['ONLINE_PAYMENT']);
  assert.equal(fetch.mock.calls.length, 1);
  assert.equal(JSON.stringify(first).includes('345678'), false);
  assert.equal((await PLATEGA.availableOptions(SETTINGS)).cached, true);
  assert.equal(fetch.mock.calls.length, 1);
  await PLATEGA.availableOptions({ ...SETTINGS, plategaSecret: SECRET + '-new' });
  assert.equal(fetch.mock.calls.length, 2);
  PLATEGA.forgetMethods();
});

test('Проверка доступа различает неверные ключи и невалидную схему баланса', async t => {
  PLATEGA.forgetMethods();
  const fetch = mockFetch(t, async () => json({ error: SECRET }, 403));
  assert.deepEqual(await PLATEGA.availableOptions(SETTINGS), { ok: false, error: 'unauthorized' });
  PLATEGA.forgetMethods();
  fetch.mock.mockImplementation(async () => json({ amount: 100, currency: 'RUB' }));
  assert.deepEqual(await PLATEGA.availableOptions(SETTINGS), { ok: false, error: 'invalid_response' });
  PLATEGA.forgetMethods();
  fetch.mock.mockImplementation(async () => json([]));
  assert.equal((await PLATEGA.availableOptions(SETTINGS)).ok, true);
  PLATEGA.forgetMethods();
});
