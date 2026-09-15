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
  url: 'https://pay.platega.io/?id=' + TRANSACTION + '&mh=merchant',
  expiresIn: '00:15:00', rate: 91.2
};
const DETAILS = {
  id: TRANSACTION, status: 'CONFIRMED', paymentDetails: { amount: 1000.25, currency: 'RUB' },
  payload: ATTEMPT, expiresIn: '00:15:00', paymentMethod: 'SBPQR', mechantId: MERCHANT
};
const CALLBACK = { id: TRANSACTION, amount: 1000.25, currency: 'RUB', status: 'CONFIRMED', payload: ATTEMPT };
const EXPECTED = { id: ATTEMPT, invoiceId: TRANSACTION, amount: 1000.25, currency: 'RUB', method: 'SBP_ONLINE' };
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
  for (const method of ['SBP', 'TO_CARD', 'CARD_ONLINE', 'SBP_ONLINE', '__proto__']) assert.equal(PLATEGA.supports(method), false);
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

test('POST создаёт общую форму v2 без paymentMethod, id и данных покупателя', async t => {
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

test('POST проверяет присланную базу и сохраняет свободный выбор способа', async t => {
  const fetch = mockFetch(t, async () => json(CREATED));
  for (const paymentMethod of [undefined, null, 'SBPQR', 13]) {
    for (const paymentDetails of ['1000.25 RUB', { amount: '1000.25', currency: 'RUB' }]) {
      fetch.mock.mockImplementation(async () => json({ ...CREATED, paymentMethod, paymentDetails }));
      const result = await PLATEGA.createInvoice(SETTINGS, PARAMS);
      assert.equal(result.ok, true);
      assert.equal(result.invoice.method, 'ONLINE_PAYMENT');
      assert.equal(result.invoice.amount, PARAMS.amount);
    }
  }
  assert.equal(fetch.mock.calls.length, 8);
});

test('POST проверяет базу формы, а оплаченный GET — полную сумму заказа', async t => {
  const params = { ...PARAMS, amount: 1085, baseAmount: 1000, expiresAt: Date.now() + 1800000 };
  const fetch = mockFetch(t, async (url, init) => {
    assert.equal(JSON.parse(init.body).paymentDetails.amount, 1000);
    return json({ ...CREATED, paymentDetails: '1000.00 RUB', expiresIn: null });
  });
  const result = await PLATEGA.createInvoice(SETTINGS, params);
  assert.equal(result.ok, true);
  assert.equal(result.invoice.amount, 1085);
  assert.equal(result.invoice.expiresAt, params.expiresAt);
  const expected = { ...EXPECTED, amount: 1085 };
  fetch.mock.mockImplementation(async () => json({ ...DETAILS, paymentDetails: { amount: 1085, currency: 'RUB' } }));
  const checked = await PLATEGA.invoice(SETTINGS, TRANSACTION);
  assert.equal(checked.ok, true);
  assert.deepEqual(PLATEGA.matchesInvoice(expected, checked.invoice), { ok: true });
  assert.equal(checked.invoice.expiresAt, 0);
  for (const amount of [1084.99, 1085.01, 1177.23]) {
    assert.deepEqual(PLATEGA.matchesInvoice(expected, { ...checked.invoice, amount }), { ok: false, reason: 'amount' });
    fetch.mock.mockImplementation(async () => json({ ...CREATED, paymentDetails: { amount, currency: 'RUB' } }));
    const wrongTotal = await PLATEGA.createInvoice(SETTINGS, params);
    assert.equal(wrongTotal.error, 'amount_mismatch');
    assert.equal(wrongTotal.ambiguous, true);
  }
});

test('Неверная исходная сумма и срок заказа отклоняются до создания счёта', async t => {
  const fetch = mockFetch(t, async () => { throw new Error('network must not run'); });
  for (const baseAmount of [0, -1, 1000.26, 1.001, NaN, Infinity, null, true, '', '1e3', Number.MAX_SAFE_INTEGER]) {
    assert.deepEqual(await PLATEGA.createInvoice(SETTINGS, { ...PARAMS, baseAmount }), { ok: false, error: 'bad_base_amount' });
  }
  for (const expiresAt of [0, Date.now() - 1, null, NaN, Infinity, true, String(Date.now() + 900000)]) {
    assert.deepEqual(await PLATEGA.createInvoice(SETTINGS, { ...PARAMS, expiresAt }), { ok: false, error: 'bad_expiry' });
  }
  assert.equal(fetch.mock.calls.length, 0);
});

test('включённый тариф разрешает дробную базу v2, сохраняя строгий оплаченный итог GET', async t => {
  const params = { ...PARAMS, amount: 1100, baseAmount: 1013.8249, feePercent: 8.5 };
  const fetch = mockFetch(t, async (url, init) => {
    assert.equal(JSON.parse(init.body).paymentDetails.amount, 1013.8249);
    return json({ ...CREATED, paymentDetails: { amount: 1013.8249, currency: 'RUB' } });
  });
  const created = await PLATEGA.createInvoice({ ...SETTINGS, plategaFeePercent: 12 }, params);
  assert.equal(created.ok, true, 'используется сохранённый процент заказа');
  assert.equal(created.invoice.amount, 1100);
  fetch.mock.mockImplementation(async () => json({ ...DETAILS, paymentDetails: { amount: 1100, currency: 'RUB' } }));
  const checked = await PLATEGA.invoice(SETTINGS, TRANSACTION);
  assert.equal(checked.ok, true);
  assert.deepEqual(PLATEGA.matchesInvoice({ ...EXPECTED, amount: 1100 }, checked.invoice), { ok: true });
  for (const amount of [1099.99, 1100.01, 1100.001, 1193.5]) {
    assert.equal(PLATEGA.matchesInvoice({ ...EXPECTED, amount: 1100 }, { ...checked.invoice, amount }).ok, false);
    fetch.mock.mockImplementation(async () => json({ ...CREATED, paymentDetails: { amount, currency: 'RUB' } }));
    const mismatch = await PLATEGA.createInvoice(SETTINGS, params);
    assert.equal(mismatch.error, 'amount_mismatch');
    assert.equal(mismatch.ambiguous, true);
  }
});

test('дробная база не принимается без точного расчёта включённого тарифа', async t => {
  const fetch = mockFetch(t, async () => assert.fail('некорректный запрос не уходит в API'));
  for (const patch of [{ baseAmount: 1013.8249 }, { baseAmount: 1013.82, feePercent: 8.5 },
    { baseAmount: 1013.8248, feePercent: 8.5 }, { baseAmount: 1013.8249, feePercent: 12 },
    { baseAmount: 1013.8249, feePercent: '8.5' }, { feePercent: 8.5 }]) {
    assert.deepEqual(await PLATEGA.createInvoice(SETTINGS, { ...PARAMS, amount: 1100, ...patch }),
      { ok: false, error: 'bad_base_amount' });
  }
  assert.equal(fetch.mock.calls.length, 0);
});

test('новая база общей формы убирает тысячные рубля без изменения суммы и строгой сверки', async t => {
  const params = { ...PARAMS, amount: 35500, baseAmount: 32718.89, feePercent: 8.5, feeRounding: 'cents' };
  const fetch = mockFetch(t, async (url, init) => {
    assert.equal(url, 'https://app.platega.io/v2/transaction/process');
    assert.equal(JSON.parse(init.body).paymentDetails.amount, 32718.89);
    return json({ ...CREATED, paymentDetails: { amount: 32718.89, currency: 'RUB' } });
  });
  const result = await PLATEGA.createInvoice({ ...SETTINGS, plategaFeePercent: 12 }, params);
  assert.equal(result.ok, true);
  assert.equal(result.invoice.amount, 35500);
  const expected = { ...EXPECTED, method: 'ONLINE_PAYMENT', amount: 35500 };
  const actual = { ...PLATEGA.invoiceView(DETAILS), amount: 35500 };
  assert.deepEqual(PLATEGA.matchesInvoice(expected, actual), { ok: true });
  for (const amount of [35499.99, 35500.01, 35500.004]) {
    assert.deepEqual(PLATEGA.matchesInvoice(expected, { ...actual, amount }), { ok: false, reason: 'amount' });
  }
  for (const patch of [{ feeRounding: 'unknown' }, { feeRounding: null },
    { feePercent: undefined }, { baseAmount: 32718.894 },
    { amount: 1100, baseAmount: 1013.82 }]) {
    assert.deepEqual(await PLATEGA.createInvoice(SETTINGS, { ...params, ...patch }), { ok: false, error: 'bad_base_amount' });
  }
  assert.equal(fetch.mock.calls.length, 1);
});

test('общая форма с включённой комиссией не подтверждает оплату по базе до выбора способа', async t => {
  const expected = { ...EXPECTED, method: 'ONLINE_PAYMENT', amount: 1100 };
  const fetch = mockFetch(t, async () => json({ ...DETAILS, status: 'PENDING', paymentMethod: null,
    paymentDetails: { amount: 1013.8249, currency: 'RUB' } }));
  const pending = await PLATEGA.invoice(SETTINGS, TRANSACTION);
  assert.equal(pending.ok, true);
  assert.equal(pending.invoice.state, 'pending');
  assert.equal(pending.invoice.amount, null, 'база не округляется до оплаченной суммы');
  assert.deepEqual(PLATEGA.matchesInvoice(expected, pending.invoice), { ok: false, reason: 'amount' });
  for (const paymentMethod of ['SBPQR', 13]) {
    for (const amount of [1013.82, 1099.99, 1100, 1100.01]) {
      fetch.mock.mockImplementation(async () => json({ ...DETAILS, paymentMethod,
        paymentDetails: { amount, currency: 'RUB' } }));
      const paid = await PLATEGA.invoice(SETTINGS, TRANSACTION);
      assert.equal(PLATEGA.matchesInvoice(expected, paid.invoice).ok, amount === 1100);
    }
  }
});

test('Срок счёта ограничен сроком магазина, null не создаёт новый срок сам по себе', async t => {
  const fetch = mockFetch(t, async () => json(CREATED));
  const shorter = Date.now() + 300000;
  assert.equal((await PLATEGA.createInvoice(SETTINGS, { ...PARAMS, expiresAt: shorter })).invoice.expiresAt, shorter);
  const before = Date.now();
  const longer = Date.now() + 1800000;
  const limited = await PLATEGA.createInvoice(SETTINGS, { ...PARAMS, expiresAt: longer });
  assert.equal(limited.ok, true);
  assert.ok(limited.invoice.expiresAt >= before + 900000 && limited.invoice.expiresAt <= Date.now() + 900000);
  assert.ok(limited.invoice.expiresAt < longer);
  fetch.mock.mockImplementation(async () => json({ ...CREATED, expiresIn: null }));
  const noDeadline = await PLATEGA.createInvoice(SETTINGS, PARAMS);
  assert.equal(noDeadline.error, 'bad_expiry');
  assert.equal(noDeadline.ambiguous, true);
  assert.equal((await PLATEGA.createInvoice(SETTINGS, { ...PARAMS, expiresAt: shorter })).invoice.expiresAt, shorter);
  for (const expiresIn of [undefined, '', '900', '00:00:00', '00:60:00', 900]) {
    fetch.mock.mockImplementation(async () => json({ ...CREATED, expiresIn }));
    const invalid = await PLATEGA.createInvoice(SETTINGS, { ...PARAMS, expiresAt: longer });
    assert.equal(invalid.error, 'bad_expiry');
    assert.equal(invalid.ambiguous, true);
  }
});

test('Локальная валидация отклоняет невозможный запрос до fetch', async t => {
  const fetch = mockFetch(t, async () => { throw new Error('network must not run'); });
  for (const changes of [
    { amount: 1.001 }, { currency: 'USD' }, { method: 'SBP' }, { method: 'SBP_ONLINE' }, { externalId: '../order' },
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
    [{ url: undefined, redirect: CREATED.url }, 'no_requisite'],
    [{ expiresIn: '900' }, 'bad_expiry'],
    [{ status: 'CONFIRMED' }, 'bad_invoice_state'],
    [{ merchantId: TRANSACTION }, 'merchant_mismatch'],
    [{ merchantId: null }, 'merchant_mismatch'],
    [{ mechantId: TRANSACTION }, 'merchant_mismatch'],
    [{ payload: 'some-other-attempt' }, 'payload_mismatch'],
    [{ paymentDetails: { amount: 1000.26, currency: 'RUB' } }, 'amount_mismatch'],
    [{ paymentDetails: { amount: 1000.25, currency: 'USD' } }, 'currency_mismatch'],
    [{ paymentDetails: '1000.26 RUB' }, 'amount_mismatch'],
    [{ paymentDetails: '1000.251 RUB' }, 'amount_mismatch'],
    [{ paymentDetails: '1000.25 USD' }, 'currency_mismatch'],
    [{ paymentDetails: ' 1000.25 RUB' }, 'amount_mismatch'],
    [{ paymentDetails: '1000.25 RUB ' }, 'amount_mismatch'],
    [{ paymentDetails: '1000.25 RUB\n' }, 'amount_mismatch'],
    [{ paymentDetails: 'Сумма: 1000.25 RUB' }, 'amount_mismatch'],
    [{ paymentDetails: 1000.25 }, 'amount_mismatch'],
    [{ paymentDetails: null }, 'amount_mismatch']
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

test('Сохранённый счёт СБП требует подтверждённый способ GET, общая форма разрешает выбор', async t => {
  const fetch = mockFetch(t, async () => json(DETAILS));
  const legacy = { ...EXPECTED, method: 'ONLINE_PAYMENT' };
  for (const paymentMethod of ['SBPQR', 2, '2']) {
    fetch.mock.mockImplementation(async () => json({ ...DETAILS, paymentMethod }));
    const result = await PLATEGA.invoice(SETTINGS, TRANSACTION);
    assert.equal(result.ok, true);
    assert.equal(result.invoice.method, 'SBP_ONLINE');
    assert.deepEqual(PLATEGA.matchesInvoice(EXPECTED, result.invoice), { ok: true });
    assert.deepEqual(PLATEGA.matchesInvoice(legacy, result.invoice), { ok: true });
  }
  // Старые размещённые формы разрешали все способы, включая криптовалюту;
  // отсутствие paymentMethod раньше также не мешало строгой сверке суммы.
  for (const paymentMethod of ['CRYPTO', 13, '13', 'CARD', undefined, null, 'sbpqr', ' 2 ', { id: 2 }]) {
    fetch.mock.mockImplementation(async () => json({ ...DETAILS, paymentMethod }));
    const result = await PLATEGA.invoice(SETTINGS, TRANSACTION);
    assert.equal(result.ok, true);
    assert.equal(result.invoice.method, 'ONLINE_PAYMENT');
    assert.deepEqual(PLATEGA.matchesInvoice(EXPECTED, result.invoice), { ok: false, reason: 'method' });
    assert.deepEqual(PLATEGA.matchesInvoice(legacy, result.invoice), { ok: true });
    assert.deepEqual(PLATEGA.matchesInvoice(legacy, { ...result.invoice, amount: 1000.26 }), { ok: false, reason: 'amount' });
  }
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
  const legacy = { ...EXPECTED, method: 'ONLINE_PAYMENT' };
  assert.equal(PLATEGA.sameStartRequest(legacy, legacy), true);
  assert.equal(PLATEGA.sameStartRequest(legacy, EXPECTED), false);
  assert.equal(PLATEGA.sameStartRequest(EXPECTED, legacy), false);
  assert.equal(PLATEGA.sameStartRequest({ ...EXPECTED, method: 'SBP' }, { ...EXPECTED, method: 'SBP' }), false);
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
