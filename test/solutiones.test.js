'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const SOLUTIONES = require('../lib/solutiones');

const KEY = 'pk_0123456789abcdef';
const SECRET = 'solutiones-test-secret-never-live';
const WEBHOOK = 'whsec_synthetic_webhook_secret_never_live';
const INVOICE = 'cmu4moyqb000lbsutsakpilig';
const ATTEMPT = 'a91209d1ae67f399bd7ed6c4';
const SETTINGS = { solutionesEnabled: true, solutionesApiKey: KEY, solutionesApiSecret: SECRET, solutionesWebhookSecret: WEBHOOK };
const PARAMS = {
  amount: 1000.25, currency: 'RUB', method: 'SBP_ONLINE', externalId: ATTEMPT,
  description: 'Заказ 1234', returnUrl: 'https://shop.example/pay/private-order',
  callbackUrl: 'https://shop.example/api/pay/solutiones/callback?order=private&attempt=' + ATTEMPT + '&token=never-send',
  expiresAt: Date.now() + 30 * 60 * 1000
};
// Ровно то, что касса отвечала на боевом сервере 17 сентября 2026: сумма в
// ответе — копейки строкой, срок null.
const CREATED = {
  id: INVOICE, orderId: ATTEMPT, status: 'PENDING', amount: '100025', currency: 'RUB',
  payUrl: 'https://qr.nspk.ru/AD10104HJJKN6HP99UF9JTN9943UV80E', expiresAt: null, createdAt: '2026-09-16T21:44:21.204Z'
};
const PAID = { ...CREATED, status: 'PAID', paidAt: '2026-09-16T21:50:00.000Z' };
const EXPECTED = { id: ATTEMPT, invoiceId: INVOICE, amount: 1000.25, currency: 'RUB', method: 'SBP_ONLINE' };
function json(body, status = 200) { return new Response(JSON.stringify(body), { status }); }
function mockFetch(t, handler) {
  // Каждый тест перехватывает fetch. Настоящих запросов к кассе с этой машины нет.
  return t.mock.method(globalThis, 'fetch', handler);
}
function sign(raw, secret = WEBHOOK) {
  return 'sha256=' + crypto.createHmac('sha256', secret).update(raw, 'utf8').digest('hex');
}

test('Solutiones включается только с публичным ключом pk_… и серверным секретом', () => {
  assert.equal(SOLUTIONES.configured(SETTINGS), true);
  assert.equal(SOLUTIONES.enabled(SETTINGS), true);
  assert.equal(SOLUTIONES.configured({ ...SETTINGS, solutionesApiSecret: '' }), false);
  assert.equal(SOLUTIONES.configured({ ...SETTINGS, solutionesApiKey: 'sk_0123456789abcdef' }), false);
  assert.equal(SOLUTIONES.configured({ ...SETTINGS, solutionesApiSecret: 'secret\r\nX-Other: value' }), false);
  assert.equal(SOLUTIONES.enabled({ ...SETTINGS, solutionesEnabled: false }), false);
  // Секрет вебхука не обязателен для работы кассы: без него не принимаются
  // только уведомления, оплату подтверждает фоновый опрос.
  assert.equal(SOLUTIONES.configured({ ...SETTINGS, solutionesWebhookSecret: '' }), true);
  assert.equal(SOLUTIONES.supports('SBP_ONLINE'), true);
  for (const method of ['SBP', 'TO_CARD', 'CARD_ONLINE', 'ONLINE_PAYMENT', 'QR_NSPK', '__proto__']) assert.equal(SOLUTIONES.supports(method), false);
});

test('Solutiones: рубли в запросе, копейки в ответе — и ни одной догадки по величине', () => {
  assert.equal(SOLUTIONES.toMinor(1000.25), 100025);
  assert.equal(SOLUTIONES.toMinor('12.34'), 1234);
  for (const value of [0, -1, NaN, Infinity, null, true, [], {}, '', ' 10 ', '1e3', 1.001]) {
    assert.equal(SOLUTIONES.toMinor(value), null, String(value));
  }
  // Ответ кассы: «12.34» → "1234". Это копейки, и читаются они как копейки.
  assert.equal(SOLUTIONES.minorOf('1234'), 1234);
  assert.equal(SOLUTIONES.minorOf(1000), 1000);
  for (const value of ['12.34', '', '0', '-5', null, 'abc']) assert.equal(SOLUTIONES.minorOf(value), null, String(value));
  assert.equal(SOLUTIONES.invoiceView(CREATED).amount, 1000.25);
  assert.equal(SOLUTIONES.acceptsAmount(1000.25, 'RUB'), true);
  for (const currency of ['USD', '', null]) assert.equal(SOLUTIONES.acceptsAmount(1000, currency), false);
  assert.equal(SOLUTIONES.stateOf('PENDING'), 'pending');
  assert.equal(SOLUTIONES.stateOf('paid'), 'paid');
  assert.equal(SOLUTIONES.stateOf('CANCELED'), 'cancelled');
  assert.equal(SOLUTIONES.stateOf('EXPIRED'), 'expired');
  for (const state of ['DONE', '__proto__', 'toString', 'constructor', '']) assert.equal(SOLUTIONES.stateOf(state), '');
});

test('POST создаёт счёт на orderId попытки, в рублях, без token в адресе уведомления', async t => {
  const fetch = mockFetch(t, async (url, init) => {
    assert.equal(url, 'https://lk.solutiones.club/api/v1/payment/create');
    assert.equal(init.method, 'POST');
    assert.equal(init.redirect, 'error');
    assert.equal(init.headers['X-Api-Key'], KEY);
    assert.equal(init.headers['X-Api-Secret'], SECRET);
    const body = JSON.parse(init.body);
    assert.deepEqual(body, {
      orderId: ATTEMPT, amount: '1000.25', currency: 'RUB', description: 'Заказ 1234',
      successUrl: PARAMS.returnUrl, failUrl: PARAMS.returnUrl,
      callbackUrl: 'https://shop.example/api/pay/solutiones/callback'
    });
    assert.equal(init.body.includes('never-send'), false, 'token и номер заказа в адрес кассы не уезжают');
    return json(CREATED);
  });
  const result = await SOLUTIONES.createInvoice(SETTINGS, PARAMS);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(fetch.mock.calls.length, 1);
  assert.equal(result.invoice.id, INVOICE);
  assert.equal(result.invoice.externalId, ATTEMPT);
  assert.equal(result.invoice.method, 'SBP_ONLINE');
  assert.equal(result.invoice.requisite, CREATED.payUrl);
  assert.equal(result.invoice.amount, 1000.25);
  assert.equal(result.invoice.currency, 'RUB');
  assert.equal(result.invoice.state, 'pending');
  // expiresAt: null — срок магазина, а не выдуманный.
  assert.equal(result.invoice.expiresAt, PARAMS.expiresAt);
});

test('POST отвергает чужой orderId, не ту сумму, http-ссылку и счёт не в ожидании', async t => {
  const cases = [
    [{ ...CREATED, orderId: 'someone-else-order' }, 'payload_mismatch'],
    [{ ...CREATED, amount: '100000' }, 'amount_mismatch'],
    [{ ...CREATED, currency: 'USD' }, 'currency_mismatch'],
    [{ ...CREATED, payUrl: 'http://qr.nspk.ru/AD10104' }, 'no_requisite'],
    [{ ...CREATED, status: 'PAID' }, 'bad_invoice_state'],
    [{ ...CREATED, status: 'WEIRD' }, 'unknown_status'],
    [{ ...CREATED, id: '' }, 'no_invoice_id']
  ];
  for (const [answer, error] of cases) {
    mockFetch(t, async () => json(answer));
    const result = await SOLUTIONES.createInvoice(SETTINGS, PARAMS);
    assert.equal(result.ok, false);
    assert.equal(result.error, error, JSON.stringify(answer));
    assert.equal(result.ambiguous, true, 'счёт у кассы уже есть: исход двусмысленный');
    if (error !== 'no_invoice_id') assert.equal(result.invoice.id, INVOICE, 'частичный счёт сохраняется для сверки');
  }
  // Срок магазина обязателен: без него ссылка жила бы вечно.
  assert.equal((await SOLUTIONES.createInvoice(SETTINGS, { ...PARAMS, expiresAt: undefined })).error, 'bad_expiry');
  assert.equal((await SOLUTIONES.createInvoice(SETTINGS, { ...PARAMS, expiresAt: Date.now() - 1 })).error, 'bad_expiry');
  assert.equal((await SOLUTIONES.createInvoice(SETTINGS, { ...PARAMS, method: 'SBP' })).error, 'method_unavailable');
  assert.equal((await SOLUTIONES.createInvoice(SETTINGS, { ...PARAMS, currency: 'USD' })).error, 'bad_currency');
  assert.equal((await SOLUTIONES.createInvoice(SETTINGS, { ...PARAMS, amount: 10.005 })).error, 'bad_amount');
  assert.equal((await SOLUTIONES.createInvoice(SETTINGS, { ...PARAMS, returnUrl: 'http://shop.example/pay/x' })).error, 'bad_return_url');
});

test('Срок кассы, если он вдруг пришёл, не продлевает срок магазина', async t => {
  const later = new Date(PARAMS.expiresAt + 60 * 60 * 1000).toISOString();
  mockFetch(t, async () => json({ ...CREATED, expiresAt: later }));
  const long = await SOLUTIONES.createInvoice(SETTINGS, PARAMS);
  assert.equal(long.ok, true);
  assert.equal(long.invoice.expiresAt, PARAMS.expiresAt, 'касса живёт дольше — берём свой срок');
  const soon = new Date(Date.now() + 5 * 60 * 1000).toISOString();
  mockFetch(t, async () => json({ ...CREATED, expiresAt: soon }));
  const short = await SOLUTIONES.createInvoice(SETTINGS, PARAMS);
  assert.equal(short.ok, true);
  assert.equal(short.invoice.expiresAt, Date.parse(soon), 'касса закроет раньше — верим ей');
});

test('Потерянный ответ POST восстанавливается статусом по orderId, без второго счёта', async t => {
  const calls = [];
  mockFetch(t, async (url) => {
    calls.push(url);
    if (calls.length === 1) return new Response('', { status: 502 });
    assert.equal(url, 'https://lk.solutiones.club/api/v1/payment/status?orderId=' + ATTEMPT);
    return json({ ...CREATED, paidAt: null });
  });
  const result = await SOLUTIONES.createInvoice(SETTINGS, PARAMS);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.recovered, true);
  assert.equal(result.invoice.id, INVOICE);
  assert.equal(calls.length, 2, 'один POST и один GET — второго POST нет');
  // Статус ответил «не найдено» — исход остаётся двусмысленным, а не «отказ»:
  // POST мог дойти до кассы позже нашего таймаута.
  mockFetch(t, async (url) => /status/.test(url) ? json({ error: 'not found' }, 404) : new Response('', { status: 502 }));
  const lost = await SOLUTIONES.createInvoice(SETTINGS, PARAMS);
  assert.equal(lost.ok, false);
  assert.equal(lost.ambiguous, true);
  assert.equal(lost.error, 'http_502');
  // Однозначный отказ 400 счёта не создал — статус не спрашиваем, повторять можно.
  mockFetch(t, async () => json({ error: 'amount limit exceeded' }, 400));
  const rejected = await SOLUTIONES.createInvoice(SETTINGS, PARAMS);
  assert.equal(rejected.ok, false);
  assert.equal(rejected.ambiguous, false);
  assert.equal(rejected.hint, 'amount', 'строка `error` читается только ради кода из словаря');
  assert.equal(SOLUTIONES.retryableStart(rejected), false);
});

test('GET статуса сверяется до копейки, по orderId и валюте; 404 — «нет такого счёта»', async t => {
  mockFetch(t, async (url, init) => {
    assert.equal(url, 'https://lk.solutiones.club/api/v1/payment/status?id=' + INVOICE);
    assert.equal(init.method, 'GET');
    return json(PAID);
  });
  const result = await SOLUTIONES.invoice(SETTINGS, INVOICE);
  assert.equal(result.ok, true);
  assert.equal(result.invoice.state, 'paid');
  assert.equal(result.invoice.amount, 1000.25);
  assert.equal(result.invoice.paidAt, Date.parse(PAID.paidAt));
  assert.deepEqual(SOLUTIONES.matchesInvoice(EXPECTED, result.invoice), { ok: true });
  assert.equal(SOLUTIONES.matchesInvoice(EXPECTED, { ...result.invoice, amount: 1000.24 }).reason, 'amount');
  assert.equal(SOLUTIONES.matchesInvoice(EXPECTED, { ...result.invoice, amount: 1000.26 }).reason, 'amount', 'больше — тоже не то: тарифа способа у ссылки нет');
  assert.equal(SOLUTIONES.matchesInvoice(EXPECTED, { ...result.invoice, externalId: 'other-attempt-id' }).reason, 'payload');
  assert.equal(SOLUTIONES.matchesInvoice(EXPECTED, { ...result.invoice, id: 'cmu4other0000000000000000' }).reason, 'invoice_id');
  assert.equal(SOLUTIONES.matchesInvoice(EXPECTED, { ...result.invoice, currency: 'USD' }).reason, 'currency');
  assert.equal(SOLUTIONES.matchesInvoice({ ...EXPECTED, method: 'ONLINE_PAYMENT' }, result.invoice).reason, 'method');
  assert.equal((await SOLUTIONES.invoice(SETTINGS, '../etc')).error, 'bad_invoice_id');
  mockFetch(t, async () => json({ error: 'not found' }, 404));
  assert.equal((await SOLUTIONES.invoice(SETTINGS, INVOICE)).error, 'not_found');
  mockFetch(t, async () => json({ error: 'unauthorized' }, 401));
  assert.equal((await SOLUTIONES.invoice(SETTINGS, INVOICE)).error, 'unauthorized');
});

test('Проверка связи — GET /api/v1/me: ключ обязан быть наш, ничего не создаётся', async t => {
  SOLUTIONES.forgetMethods();
  const fetch = mockFetch(t, async (url, init) => {
    assert.equal(url, 'https://lk.solutiones.club/api/v1/me');
    assert.equal(init.method, 'GET');
    return json({ merchant: { id: 'cmu4jq5rm000cbsut37m8368h', name: 'Shop', currency: 'RUB', commissionBps: 2100 },
      apiKey: { id: 'cmu4mlja0000ibsutylmi54ri', publicKey: KEY } });
  });
  const live = await SOLUTIONES.availableOptions(SETTINGS);
  assert.equal(live.ok, true);
  assert.deepEqual(live.byCurrency, { RUB: ['SBP_ONLINE'] });
  assert.equal(JSON.stringify(live).includes('2100'), false, 'комиссия и мерчант наружу не уезжают');
  // Второй вызов за пять минут — из кэша, без запроса.
  const again = await SOLUTIONES.availableOptions(SETTINGS);
  assert.equal(again.cached, true);
  assert.equal(fetch.mock.calls.length, 1);
  SOLUTIONES.forgetMethods();
  mockFetch(t, async () => json({ merchant: { currency: 'RUB' }, apiKey: { publicKey: 'pk_ffffffffffffffff' } }));
  assert.equal((await SOLUTIONES.availableOptions(SETTINGS)).error, 'invalid_response', 'чужой ключ в ответе — не наша касса');
  SOLUTIONES.forgetMethods();
  mockFetch(t, async () => json({ error: 'unauthorized' }, 401));
  assert.equal((await SOLUTIONES.availableOptions(SETTINGS)).error, 'unauthorized');
  SOLUTIONES.forgetMethods();
});

test('Вебхук: подпись HMAC-SHA256 от сырого тела секретом whsec_, и только она', () => {
  const raw = JSON.stringify({ id: INVOICE, orderId: ATTEMPT, status: 'PAID', amount: '100025', currency: 'RUB' });
  const body = JSON.parse(raw);
  const good = { 'x-webhook-signature': sign(raw), 'x-webhook-id': 'evt_1', 'x-webhook-event': 'payment.paid' };
  assert.equal(SOLUTIONES.verifyCallback(SETTINGS, body, raw, good), true);
  // Без префикса sha256= тоже принимаем: hex тот же.
  assert.equal(SOLUTIONES.verifyCallback(SETTINGS, body, raw, { 'x-webhook-signature': sign(raw).slice(7) }), true);
  assert.equal(SOLUTIONES.verifyCallback(SETTINGS, body, raw, { 'x-webhook-signature': sign(raw, 'whsec_other_secret_of_someone') }), false);
  assert.equal(SOLUTIONES.verifyCallback(SETTINGS, body, raw + ' ', good), false, 'подпись — от сырого тела, пробел его меняет');
  assert.equal(SOLUTIONES.verifyCallback(SETTINGS, body, '', good), false);
  assert.equal(SOLUTIONES.verifyCallback(SETTINGS, body, raw, {}), false);
  assert.equal(SOLUTIONES.verifyCallback(SETTINGS, body, raw, { 'x-webhook-signature': ['a', 'b'] }), false);
  assert.equal(SOLUTIONES.verifyCallback({ ...SETTINGS, solutionesWebhookSecret: '' }, body, raw, good), false, 'без секрета проверить нечем — отказ, не доверие');
  const view = SOLUTIONES.callbackView(body);
  assert.equal(view.id, INVOICE);
  assert.equal(view.externalId, ATTEMPT);
  assert.equal(view.state, 'paid');
  // Вложенный объект платежа читается так же.
  assert.equal(SOLUTIONES.callbackView({ event: 'payment.paid', data: body }).id, INVOICE);
  assert.equal(SOLUTIONES.callbackView({ orderId: ATTEMPT }), null, 'без id платежа адресовать нечего');
  assert.equal(SOLUTIONES.callbackView({ id: INVOICE, orderId: '../x' }), null);
});

test('Solutiones стоит в реестре касс и у неё свой callback-маршрут с сырым телом', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const PAYMENTS = require('../lib/payments');
  assert.ok(PAYMENTS.providerIds().includes('solutiones'));
  assert.equal(PAYMENTS.nameOf('solutiones'), 'Solutiones');
  const server = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8');
  assert.match(server, /app\.post\('\/api\/pay\/solutiones\/callback'/);
  assert.match(server, /SOLUTIONES_CALLBACK\.handle\(settings\(\), req\.body, req\.rawBody, req\.headers/, 'подпись считается по сырому телу');
  // Секреты переносятся между сайтами со сбросом, как у остальных касс.
  const { SITE_FIELDS } = require('../scripts/import-store');
  const all = Object.values(SITE_FIELDS).flat();
  for (const key of ['solutionesEnabled', 'solutionesApiKey', 'solutionesApiSecret', 'solutionesWebhookSecret']) {
    assert.ok(all.includes(key), key);
  }
  const defaults = require('../lib/db').defaultSettings();
  assert.equal(defaults.solutionesEnabled, false);
  assert.equal(defaults.solutionesApiKey, '');
  // Способ ссылки СБП предложен по умолчанию: включил кассу — платить есть чем.
  const PAY = require('../lib/pay-methods');
  assert.ok(PAY.DEFAULT_IDS.includes('SBP_ONLINE'));
  assert.equal(PAY.isHosted('SBP_ONLINE'), true);
  // Здоровье кассы: 401 читается как «ключи не приняты», а не «не отвечает».
  assert.equal(PAYMENTS.healthState({ ok: false, error: 'unauthorized' }), 'auth');
  const with5 = { ...SETTINGS, payMethods: ['SBP_ONLINE'] };
  assert.deepEqual(PAYMENTS.offeredMethods(with5), [{ id: 'SBP_ONLINE', provider: 'solutiones' }]);
  assert.equal(PAYMENTS.modeFor(with5, 5000), 'cashbox');
  assert.deepEqual(PAYMENTS.chainFor(with5, null, 'SBP_ONLINE', 'RUB', 5000).map(p => p.id), ['solutiones']);
  assert.deepEqual(PAYMENTS.chainFor(with5, null, 'SBP_ONLINE', 'USD', 5000), []);
});
