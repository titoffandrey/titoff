'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const https = require('node:https');
const { EventEmitter } = require('node:events');
const { execFileSync } = require('node:child_process');
const ALFA = require('../lib/alfabank');

function freshStore(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'store-backend-audit-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const key = require.resolve('../lib/db');
  const previous = process.env.STORE_DATA_DIR;
  process.env.STORE_DATA_DIR = dir;
  delete require.cache[key];
  const db = require('../lib/db');
  delete require.cache[key];
  if (previous === undefined) delete process.env.STORE_DATA_DIR;
  else process.env.STORE_DATA_DIR = previous;
  return { dir, db };
}

test('закрытие платежа с неизвестным requestId не меняет активный счёт', t => {
  const { db } = freshStore(t);
  const order = db.createOrder({ total: 5000 });
  db.startOrderPayment(order.id, { requestId: 'a'.repeat(32), amount: 5000, method: 'CARD_ONLINE' });
  for (const requestId of ['b'.repeat(32), 'повреждённый-ключ']) {
    const result = db.settleOrderPayment(order.id, { requestId, status: 'paid', total: 5000 });
    assert.equal(result.stale, true);
    assert.equal(result.changed, false);
    assert.equal(db.getOrder(order.id).payment.status, 'pending');
  }
  const paid = db.settleOrderPayment(order.id, { requestId: 'a'.repeat(32), status: 'paid', total: 5000 });
  assert.equal(paid.changed, true);
  assert.equal(db.getOrder(order.id).payment.status, 'paid');
});

test('атомарная замена JSON с сохранённым mtime обновляет цены и индекс заказов', t => {
  const { dir, db } = freshStore(t);
  const stamp = new Date('2026-01-01T00:00:00Z');
  const replace = (name, value) => {
    const tmp = path.join(dir, name + '.replacement');
    fs.writeFileSync(tmp, JSON.stringify(value));
    fs.utimesSync(tmp, stamp, stamp);
    fs.renameSync(tmp, path.join(dir, name + '.json'));
  };
  replace('products', [{ id: 'phone', price: 1000 }]);
  assert.equal(db.getProduct('phone').price, 1000);
  replace('products', [{ id: 'phone', price: 2000 }]);
  assert.equal(db.getProduct('phone').price, 2000);
  replace('orders', [{ id: 'order', total: 1000 }]);
  assert.equal(db.getOrder('order').total, 1000);
  replace('orders', [{ id: 'order', total: 2000 }]);
  assert.equal(db.getOrder('order').total, 2000);
});

test('уборка загрузок сохраняет фотографии магазина и вложения переписки', t => {
  const { dir, db } = freshStore(t);
  db.saveSettings({ storePhotos: ['store.webp'] });
  fs.writeFileSync(path.join(dir, 'chats.json'), JSON.stringify({ version: 1, chats: [
    { id: 'a'.repeat(32), messages: [{ role: 'user', photos: ['chat.webp'] }] }
  ] }));
  const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
  for (const name of ['store.webp', 'chat.webp', 'orphan.webp']) {
    const filename = path.join(db.UPLOAD_DIR, name);
    fs.writeFileSync(filename, name);
    fs.utimesSync(filename, old, old);
  }
  assert.equal(db.uploadIsUsed('store.webp'), true);
  assert.equal(db.uploadIsUsed('chat.webp'), true);
  assert.equal(db.deleteUploadIfUnused('store.webp'), false);
  assert.equal(db.deleteUploadIfUnused('chat.webp'), false);
  execFileSync(process.execPath, [path.join(__dirname, '../scripts/sweep-uploads.js'), '--apply'], {
    env: { ...process.env, STORE_DATA_DIR: dir }, encoding: 'utf8'
  });
  assert.equal(fs.existsSync(path.join(db.UPLOAD_DIR, 'store.webp')), true);
  assert.equal(fs.existsSync(path.join(db.UPLOAD_DIR, 'chat.webp')), true);
  assert.equal(fs.existsSync(path.join(db.UPLOAD_DIR, 'orphan.webp')), false);
  // Индекс ссылок перестраивается после сохранения настроек и переписки.
  db.saveSettings({ storePhotos: [] });
  fs.writeFileSync(path.join(dir, 'chats.json'), JSON.stringify({ version: 1, chats: [] }));
  assert.equal(db.deleteUploadIfUnused('store.webp'), true);
  assert.equal(db.deleteUploadIfUnused('chat.webp'), true);
});

// Поведение реального транспортного модуля проверяем через поддельный сокет:
// тесты не обращаются ни к магазину, ни к банку и не содержат настоящих ключей.
function bankTransport(t, handler) {
  const original = https.request;
  let calls = 0;
  https.request = (options, onResponse) => {
    calls++;
    const req = new EventEmitter();
    req.setTimeout = () => req;
    req.destroy = () => { req.destroyed = true; };
    req.end = body => {
      const res = new EventEmitter();
      res.statusCode = 200;
      res.setEncoding = () => {};
      queueMicrotask(() => {
        onResponse(res);
        handler({ req, res, body: new URLSearchParams(body), options });
      });
    };
    return req;
  };
  ALFA.forgetMethods();
  t.after(() => { https.request = original; ALFA.forgetMethods(); });
  return () => calls;
}

function bankReply(res, body) {
  res.emit('data', JSON.stringify(body));
  res.emit('end');
}

const BANK_SETTINGS = { alfabankTest: true, alfabankLogin: 'audit-merchant', alfabankPassword: 'test-password' };

function pickupModules(t) {
  const { dir, db } = freshStore(t);
  const dbKey = require.resolve('../lib/db');
  const pickupKey = require.resolve('../lib/pickup');
  const osmKey = require.resolve('../lib/pickup-osm');
  const previous = [dbKey, pickupKey, osmKey].map(key => [key, require.cache[key]]);
  require.cache[dbKey] = { id: dbKey, filename: dbKey, loaded: true, exports: db };
  delete require.cache[pickupKey];
  delete require.cache[osmKey];
  const PICKUP = require('../lib/pickup');
  const OSM = require('../lib/pickup-osm');
  t.after(() => {
    for (const [key, value] of previous) {
      if (value) require.cache[key] = value;
      else delete require.cache[key];
    }
  });
  return { dir, PICKUP, OSM };
}

test('OZON: ошибочный HTTP 200 Overpass сохраняет прежние пункты и срок обновления', async t => {
  const { dir, PICKUP, OSM } = pickupModules(t);
  const tile = OSM.tileFor(55.75, 37.6);
  PICKUP.save({ version: 1, updatedAt: 100, sources: { ozon: { tiles: { [tile.key]: 100 } } }, points: [
    { carrier: 'ozon', code: 'osmn1', lat: 55.75, lon: 37.6 }
  ] });
  const original = fs.readFileSync(path.join(dir, 'pickup-points.json'), 'utf8');
  let payload;
  t.mock.method(global, 'fetch', async () => ({ ok: true, json: async () => payload }));
  for (payload of [{}, null, { elements: null }, { remark: 'runtime error: Query timed out', elements: [] }]) {
    await assert.rejects(OSM.refreshTile(tile), /Overpass/);
    assert.equal(fs.readFileSync(path.join(dir, 'pickup-points.json'), 'utf8'), original);
  }
  // Настоящий успешный пустой результат по-прежнему удаляет закрытые пункты.
  payload = { elements: [] };
  await OSM.refreshTile(tile);
  assert.equal(PICKUP.load().points.length, 0);
  assert.ok(OSM.tilesOf(PICKUP.load())[tile.key] > 100);
});

test('OZON: соседние плитки обновляют общий пункт без повторов в списке', async t => {
  const { PICKUP, OSM } = pickupModules(t);
  PICKUP.save({ version: 1, sources: {}, points: [
    { carrier: 'cdek', code: 'MSK1', lat: 55.74, lon: 37.6, region: 'Москва', city: 'Москва', short: 'Ленина, 1' },
    { carrier: 'ozon', code: 'osmn42', lat: 55.74, lon: 37.6, region: 'Москва', city: 'Москва', short: 'старый адрес' },
    { carrier: 'ozon', code: 'osmn99', lat: 55.6, lon: 37.6, region: 'Москва', city: 'Москва', short: 'соседний пункт' }
  ] });
  t.mock.method(global, 'fetch', async () => ({ ok: true, json: async () => ({ elements: [
    { type: 'node', id: 42, lat: 55.74, lon: 37.6, tags: {
      shop: 'outpost', brand: 'Ozon', 'addr:street': 'Ленина', 'addr:housenumber': '2', 'addr:city': 'Москва'
    } }
  ] }) }));
  await OSM.refreshTile(OSM.tileFor(55.8, 37.6));
  await OSM.refreshTile(OSM.tileFor(55.8, 37.6));
  const list = PICKUP.load().points;
  assert.equal(list.filter(p => p.carrier === 'ozon' && p.code === 'osmn42').length, 1);
  assert.equal(list.find(p => p.code === 'osmn42').short, 'Ленина, 2');
  assert.ok(list.some(p => p.carrier === 'cdek' && p.code === 'MSK1'));
  assert.ok(list.some(p => p.code === 'osmn99'));
});

test('оборванный ответ банка завершается отказом, а не вечным ожиданием оплаты', async t => {
  bankTransport(t, ({ res }) => res.emit('aborted'));
  let timer;
  const result = await Promise.race([
    ALFA.availableOptions(BANK_SETTINGS),
    new Promise(resolve => { timer = setTimeout(() => resolve({ hung: true }), 250); })
  ]);
  clearTimeout(timer);
  assert.equal(result.hung, undefined);
  assert.equal(result.ok, false);
  assert.equal(result.error, 'response_aborted');
});

test('HTTP-ошибка банка не считается успешной проверкой ключей по JSON', async t => {
  bankTransport(t, ({ res }) => { res.statusCode = 503; bankReply(res, { errorCode: 6 }); });
  const result = await ALFA.availableOptions(BANK_SETTINGS);
  assert.equal(result.ok, false);
  assert.equal(result.error, 'http_503');
});

test('банк: ошибка потока ответа возвращает отказ без необработанного события', async t => {
  bankTransport(t, ({ res }) => res.emit('error', new Error('broken response')));
  const result = await ALFA.availableOptions(BANK_SETTINGS);
  assert.equal(result.ok, false);
  assert.equal(result.error, 'response_error');
});

test('банк: общий deadline завершает запрос до получения сокета и ответа', async t => {
  let socket;
  bankTransport(t, ({ req }) => { socket = req; });
  const realTimeout = global.setTimeout;
  t.mock.method(global, 'setTimeout', (callback, delay, ...args) =>
    realTimeout(callback, delay === 4000 ? 20 : delay, ...args));
  let guard;
  const result = await Promise.race([
    ALFA.availableOptions(BANK_SETTINGS),
    new Promise(resolve => { guard = realTimeout(() => resolve({ hung: true }), 250); })
  ]);
  clearTimeout(guard);
  assert.equal(result.hung, undefined);
  assert.equal(result.error, 'timeout');
  assert.equal(socket.destroyed, true);
});

test('банк: большой допустимый JSON не обрезается на границе сетевого чанка', async t => {
  bankTransport(t, ({ res }) => bankReply(res, { errorCode: 6, info: 'x'.repeat(70000) }));
  assert.equal((await ALFA.availableOptions(BANK_SETTINGS)).ok, true);
});

test('банк: общий размер ответа ограничен при множестве маленьких чанков', async t => {
  let socket;
  bankTransport(t, ({ req, res }) => {
    socket = req;
    for (let i = 0; i < 18; i++) res.emit('data', 'x'.repeat(65536));
    res.emit('end');
  });
  const result = await ALFA.availableOptions(BANK_SETTINGS);
  assert.equal(result.ok, false);
  assert.equal(result.error, 'response_too_large');
  assert.equal(socket.destroyed, true);
});

test('банк: параллельные проверки объединены, смена пароля проверяется заново', async t => {
  const calls = bankTransport(t, ({ res, body }) => bankReply(res,
    { errorCode: body.get('password') === 'test-password' ? 6 : 5 }));
  const [first, second] = await Promise.all([
    ALFA.availableOptions(BANK_SETTINGS), ALFA.availableOptions(BANK_SETTINGS)
  ]);
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.equal(calls(), 1);
  assert.equal((await ALFA.availableOptions(BANK_SETTINGS)).cached, true);
  const changed = await ALFA.availableOptions({ ...BANK_SETTINGS, alfabankPassword: 'wrong-password' });
  assert.equal(changed.ok, false);
  assert.equal(calls(), 2);
});

test('банк: разные токены с одинаковым префиксом имеют независимый кэш', async t => {
  const calls = bankTransport(t, ({ res, body }) => bankReply(res,
    { errorCode: body.get('token').endsWith('AAAA') ? 6 : 5 }));
  assert.equal((await ALFA.availableOptions({ alfabankTest: true, alfabankToken: 'abcdefghijklAAAA' })).ok, true);
  assert.equal((await ALFA.availableOptions({ alfabankTest: true, alfabankToken: 'abcdefghijklBBBB' })).ok, false);
  assert.equal(calls(), 2);
});

test('банк: сброс кэша во время запроса не оживляет старую проверку', async t => {
  const responses = [];
  const calls = bankTransport(t, ({ res }) => responses.push(res));
  const old = ALFA.availableOptions(BANK_SETTINGS);
  await new Promise(resolve => setImmediate(resolve));
  ALFA.forgetMethods();
  const current = ALFA.availableOptions(BANK_SETTINGS);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls(), 2);
  bankReply(responses[1], { errorCode: 5 });
  assert.equal((await current).ok, false);
  bankReply(responses[0], { errorCode: 6 });
  assert.equal((await old).ok, true);
  const cached = await ALFA.availableOptions(BANK_SETTINGS);
  assert.equal(cached.ok, false);
  assert.equal(cached.cached, true);
  assert.equal(calls(), 2);
});
