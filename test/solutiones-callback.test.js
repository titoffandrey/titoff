'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const SOLUTIONES = require('../lib/solutiones');
const CALLBACK = require('../lib/solutiones-callback');
const invoiceId = 'cmu4moyqb000lbsutsakpilig';
const attemptId = '0123456789abcdef01234567';
const WEBHOOK = 'whsec_synthetic_webhook_secret_never_live';
const settings = { solutionesApiKey: 'pk_0123456789abcdef', solutionesApiSecret: 'synthetic-secret-never-live', solutionesWebhookSecret: WEBHOOK };
const raw = JSON.stringify({ id: invoiceId, orderId: attemptId, status: 'PAID', amount: '100000', currency: 'RUB' });
const event = JSON.parse(raw);
const headers = { 'x-webhook-signature': 'sha256=' + crypto.createHmac('sha256', WEBHOOK).update(raw, 'utf8').digest('hex'),
  'x-webhook-id': 'evt_synthetic', 'x-webhook-event': 'payment.paid' };

function fixture(t, patch = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'solutiones-callback-'));
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
  const attempt = { id: attemptId, provider: 'solutiones', method: 'SBP_ONLINE',
    status: 'pending', amount: 1000, currency: 'RUB', invoiceId,
    requisite: 'https://qr.nspk.ru/SYNTHETIC', startedAt: Date.now(),
    expiresAt: Date.now() + 600000, ...patch };
  fs.writeFileSync(path.join(dir, 'orders.json'), JSON.stringify([{ id: 'synthetic-order', total: attempt.amount, createdAt: Date.now(),
    payment: { ...attempt, attemptId, attempts: [attempt] } }]), { mode: 0o600 });
  return { db, orderId: 'synthetic-order', attempt };
}

function reconciliation(db) {
  // Сверка — production `reconcilePaymentAttempt` из server.js с подставленной кассой.
  const source = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8');
  const start = source.indexOf('function invoiceNote(');
  const end = source.indexOf('\n/* Что реально включено', start);
  const notifications = [], shipments = [];
  const reconcile = vm.runInNewContext(source.slice(start, end) + '\nreconcilePaymentAttempt', {
    db, R: require('../lib/render'),
    PAYMENTS: { provider: id => id === 'solutiones' ? SOLUTIONES : null, startErrorCode: () => 'provider_error' },
    paymentReconcileJobs: new Map(), console: { error: () => {}, log: () => {} },
    notifyPayment: (order, state) => notifications.push(state),
    prepareShipment: order => shipments.push(order.id)
  });
  return { reconcile, notifications, shipments };
}

function stubStatus(t, patch = {}) {
  const original = SOLUTIONES.invoice;
  let calls = 0;
  SOLUTIONES.invoice = async () => {
    calls++;
    return { ok: true, invoice: { id: invoiceId, state: 'paid', amount: 1000,
      currency: 'RUB', externalId: attemptId, method: 'SBP_ONLINE', ...patch } };
  };
  t.after(() => { SOLUTIONES.invoice = original; });
  return () => calls;
}

test('Solutiones: без верной подписи — 403, и PAID из тела деньгами не становится', async t => {
  const { db } = fixture(t);
  const calls = stubStatus(t, { state: 'pending' });
  const tools = { db, ...reconciliation(db) };
  assert.equal((await CALLBACK.handle(settings, event, raw, {}, tools)).status, 403);
  assert.equal((await CALLBACK.handle(settings, event, raw, { 'x-webhook-signature': 'sha256=' + 'a'.repeat(64) }, tools)).status, 403);
  assert.equal((await CALLBACK.handle({ ...settings, solutionesWebhookSecret: '' }, event, raw, headers, tools)).status, 403);
  assert.equal(calls(), 0);
  // Подпись верна, но GET говорит «ещё ждём»: просим повторить, тело не верим.
  assert.equal((await CALLBACK.handle(settings, event, raw, headers, tools)).status, 503);
  assert.equal(db.getOrder('synthetic-order').payment.status, 'pending');
  assert.equal(tools.shipments.length, 0);
});

test('Solutiones: точный GET подтверждает оплату единожды даже при повторном уведомлении', async t => {
  const { db } = fixture(t);
  stubStatus(t);
  const tools = { db, ...reconciliation(db) };
  assert.equal((await CALLBACK.handle(settings, event, raw, headers, tools)).status, 200);
  assert.equal((await CALLBACK.handle(settings, event, raw, headers, tools)).status, 200);
  assert.equal(db.getOrder('synthetic-order').payment.status, 'paid');
  assert.deepEqual(tools.notifications, ['paid']);
  assert.equal(tools.shipments.length, 1);
});

test('Solutiones: чужая сумма в GET — mismatch на разбор, а не оплата', async t => {
  const { db } = fixture(t);
  stubStatus(t, { amount: 999 });
  const tools = { db, ...reconciliation(db) };
  assert.equal((await CALLBACK.handle(settings, event, raw, headers, tools)).status, 200);
  assert.equal(db.getOrder('synthetic-order').payment.status, 'mismatch');
  assert.deepEqual(tools.notifications, ['mismatch']);
  assert.equal(tools.shipments.length, 0);
});

test('Solutiones: неизвестный платёж (второй сайт того же мерчанта) — 200 и ничего не меняем', async t => {
  const { db } = fixture(t);
  const calls = stubStatus(t);
  const tools = { db, ...reconciliation(db) };
  const foreignRaw = JSON.stringify({ id: 'cmu4other00000000000000000', orderId: 'ffffffffffffffffffffffff', status: 'PAID' });
  const foreignHeaders = { 'x-webhook-signature': 'sha256=' + crypto.createHmac('sha256', WEBHOOK).update(foreignRaw, 'utf8').digest('hex') };
  assert.equal((await CALLBACK.handle(settings, JSON.parse(foreignRaw), foreignRaw, foreignHeaders, tools)).status, 200);
  assert.equal(calls(), 0);
  assert.equal(db.getOrder('synthetic-order').payment.status, 'pending');
});

test('Solutiones: потерянный ответ POST привязывается по orderId уведомления через GET', async t => {
  const { db } = fixture(t, { invoiceId: '', requisite: '' });
  stubStatus(t);
  const tools = { db, ...reconciliation(db) };
  assert.equal((await CALLBACK.handle(settings, event, raw, headers, tools)).status, 200);
  const order = db.getOrder('synthetic-order');
  assert.equal(order.payment.invoiceId, invoiceId);
  assert.equal(order.payment.status, 'paid');
  assert.equal(tools.shipments.length, 1);
});
