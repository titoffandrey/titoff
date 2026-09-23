'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'order-chat-'));
process.env.STORE_DATA_DIR = dir;
const db = require('../lib/db');
const chat = require('../lib/chat');
const notices = require('../lib/order-chat');
const TRACK = require('../lib/tracking');
let settings, service;
function setup() {
  db.writeJson('orders', []);
  db.writeJson('chats', []);
  chat.init(dir);
  settings = { chatEnabled: true, aiEnabled: true, aiApiKey: 'test-only', contactWhatsApp: '+79991234567' };
  service = notices.create({ db, chat, settings: () => settings, prepareShipment(order) {
    if (order.shipment) return;
    db.setOrderShipment(order.id, TRACK.build({ carrier: 'cdek', mode: 'pvz',
      from: 'Москва', to: 'Казань', zone: 'pfo', seed: order.id, startedAt: Date.now(), days: 4 }));
  } });
}
function order(patch = {}) {
  return db.createOrder({ visitorId: 'a'.repeat(32), total: 1000, draft: true, ...patch });
}
function saved(o) { return db.getOrder(o.id); }
function patch(o, values) {
  const list = db.getOrders();
  Object.assign(list.find(row => row.id === o.id), values);
  db.writeJson('orders', list);
}
function messages(o) { return chat.get(saved(o).chatFollowup.chatId).messages; }
test.beforeEach(setup);
test.after(() => { chat.shutdown(); fs.rmSync(dir, { recursive: true, force: true }); });

test('через две минуты пишет первым, даёт WhatsApp этого магазина и не повторяется', () => {
  const o = order();
  const target = service.watch(o);
  assert.equal(target.visitorId, o.visitorId);
  assert.equal(target.startedBy, 'operator');
  service.sweep(o.createdAt + notices.HELP_DELAY - 1);
  assert.equal(messages(o).length, 0);
  service.sweep(o.createdAt + notices.HELP_DELAY);
  assert.equal(messages(o).length, 1);
  assert.match(messages(o)[0].text, /Нужна помощь с оплатой/);
  assert.match(messages(o)[0].text, /https:\/\/wa.me\/79991234567\?text=/);
  assert.ok(messages(o)[0].text.includes(encodeURIComponent(o.number)));
  service.sweep(o.createdAt + notices.HELP_DELAY + 10000);
  assert.equal(messages(o).length, 1);
  assert.equal(target.unread, 1);
});

test('подтверждённая оплата сразу отправляет спасибо и секретную ссылку своего заказа', () => {
  const o = order();
  service.watch(o);
  patch(o, { payment: { status: 'paid' } });
  service.paid(o);
  assert.equal(messages(o).length, 1);
  assert.match(messages(o)[0].text, /Спасибо за покупку/);
  assert.match(messages(o)[0].text, /свяжется менеджер/);
  assert.ok(messages(o)[0].text.includes(TRACK.trackPath(saved(o).shipment)));
  service.paid(o);
  service.sweep(o.createdAt + notices.HELP_DELAY);
  assert.equal(messages(o).length, 1);
});

test('после предложения помощи ручная оплата отправляет благодарность один раз', () => {
  const o = order({ draft: false, payMode: 'own' });
  service.watch(o);
  service.sweep(o.createdAt + notices.HELP_DELAY);
  db.setOrderPaidManually(o.id, true, 'test');
  service.paid(o);
  assert.equal(messages(o).length, 2);
  assert.match(messages(o)[1].text, /Спасибо за покупку/);
});

test('перезапуск сохраняет очередь и уже отправленные сообщения', () => {
  const o = order();
  service.watch(o);
  chat.init(dir);
  service.sweep(o.createdAt + notices.HELP_DELAY);
  chat.init(dir);
  service.sweep(o.createdAt + notices.HELP_DELAY + 10000);
  assert.equal(messages(o).length, 1);
  assert.equal(messages(o)[0].orderEvent, o.id + ':help');
  // Остановка после записи сообщения, до записи отметки в заказе.
  db.setOrderChatFollowup(o.id, { helpAt: null });
  service.sweep(o.createdAt + notices.HELP_DELAY + 20000);
  assert.equal(messages(o).length, 1);
  assert.ok(saved(o).chatFollowup.helpAt);
});

test('старые заказы без очереди не получают сообщения при запуске', () => {
  order();
  service.sweep(Date.now() + notices.HELP_DELAY);
  assert.equal(chat.count(), 0);
});

test('отмена, архив, возврат, расхождение суммы и истечение срока гасят напоминание', () => {
  for (const values of [
    { manualVoid: { at: Date.now() } }, { archive: { active: true, at: Date.now() } },
    { payment: { status: 'refunded' } }, { payment: { status: 'mismatch' } },
    { cancelledBeforePayment: true }
  ]) {
    const o = order();
    patch(o, values);
    service.watch(o);
    service.sweep(o.createdAt + notices.HELP_DELAY);
    assert.equal(messages(o).length, 0, JSON.stringify(values));
  }
  const o = order();
  service.watch(o);
  service.sweep(o.createdAt + 31 * 60000);
  assert.equal(messages(o).length, 0);
});

test('выключенный ИИ, чужой посетитель и удалённый диалог не получают сообщения', () => {
  const o = order();
  settings.aiEnabled = false;
  assert.equal(service.watch(o), null);
  settings.aiEnabled = true;
  const stranger = chat.create({ visitorId: 'b'.repeat(32) });
  assert.equal(service.watch(o, stranger), null);
  service.watch(o);
  chat.remove(saved(o).chatFollowup.chatId);
  service.sweep(o.createdAt + notices.HELP_DELAY);
  assert.equal(stranger.messages.length, 0);
});

test('живому менеджеру напоминание не мешает, отсутствие WhatsApp не порождает выдуманную ссылку', () => {
  const o = order();
  const target = service.watch(o);
  chat.setMode(target, 'operator');
  service.sweep(o.createdAt + notices.HELP_DELAY);
  assert.equal(messages(o).length, 0);
  chat.setMode(target, 'ai');
  settings.contactWhatsApp = '';
  service.sweep(o.createdAt + notices.HELP_DELAY);
  assert.match(messages(o)[0].text, /Напишите здесь/);
  assert.doesNotMatch(messages(o)[0].text, /wa.me/);
});

test('скрытое отправление не выдаёт секретную ссылку', () => {
  const o = order();
  service.watch(o);
  patch(o, { payment: { status: 'paid' } });
  patch(o, { shipment: { visible: false, token: 'c'.repeat(32), steps: [{}] } });
  service.paid(o);
  assert.match(messages(o)[0].text, /странице заказа/);
  assert.doesNotMatch(messages(o)[0].text, /\/track\//);
});

test('без метрики заказ привязывается только к чату из подписанной сессии', () => {
  const o = order({ visitorId: null });
  assert.equal(service.watch(o), null);
  const own = chat.create({});
  assert.equal(service.watch(o, own).id, own.id);
  service.sweep(o.createdAt + notices.HELP_DELAY);
  assert.equal(own.messages.length, 1);
});

test('оформление запоминает чат до редиректа и подключает канал без раскрытия окна', () => {
  const source = fs.readFileSync(path.join(__dirname, '../public/chat.js'), 'utf8');
  const from = source.indexOf("  document.addEventListener('store:order-created'");
  const to = source.indexOf('  if (recall() || waiting)', from);
  let handler, remembered, opens = 0;
  require('node:vm').runInNewContext(source.slice(from, to), {
    document: { addEventListener: (event, fn) => { handler = fn; } },
    STORE: 'test-chat', Date,
    localStorage: { setItem: (key, value) => { remembered = JSON.parse(value); } },
    open: () => { assert.equal(remembered.started, true); opens++; }
  });
  handler();
  assert.equal(opens, 1);
});
