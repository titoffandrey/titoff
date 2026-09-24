'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const vm = require('node:vm');
const { App } = require('../lib/server-lib');

function freshCustomers(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'store-backend-20260924-'));
  const keys = [require.resolve('../lib/db'), require.resolve('../lib/customers')];
  const cached = keys.map(key => require.cache[key]);
  const previous = process.env.STORE_DATA_DIR;
  process.env.STORE_DATA_DIR = dir;
  for (const key of keys) delete require.cache[key];
  const customers = require('../lib/customers');
  keys.forEach((key, i) => { if (cached[i]) require.cache[key] = cached[i]; else delete require.cache[key]; });
  if (previous === undefined) delete process.env.STORE_DATA_DIR;
  else process.env.STORE_DATA_DIR = previous;
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return customers;
}

test('смена и удаление почты отзывают ссылку восстановления со старого адреса', t => {
  const customers = freshCustomers(t);
  const made = customers.create({ email: 'before@example.test', phone: '+79991234567', password: 'secret123' });
  assert.equal(made.ok, true);
  for (const email of ['after@example.test', '']) {
    const token = customers.issueReset(made.customer.id);
    assert.equal(customers.byResetToken(token).id, made.customer.id);
    assert.equal(customers.update(made.customer.id, { email }).ok, true);
    assert.equal(customers.byResetToken(token), null);
    assert.equal(customers.byId(made.customer.id).resetUntil, undefined);
  }
});

test('обычная правка профиля и тот же email сохраняют текущую ссылку восстановления', t => {
  const customers = freshCustomers(t);
  const made = customers.create({ email: 'owner@example.test', password: 'secret123' });
  const token = customers.issueReset(made.customer.id);
  assert.equal(customers.update(made.customer.id, { name: 'Покупатель', email: 'OWNER@example.test' }).ok, true);
  assert.equal(customers.byResetToken(token).id, made.customer.id);
});

async function multipartServer(t) {
  const app = new App({ secret: 'local-test-only' });
  let handled = 0;
  app.post('/upload', (req, res) => {
    handled++;
    res.json({ body: req.body, files: req.files.map(file => ({ name: file.fieldname, data: file.content.toString('base64') })) });
  });
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const post = (body, contentType) => new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port: server.address().port,
      method: 'POST', path: '/upload', agent: false,
      headers: { 'content-type': contentType, 'content-length': Buffer.byteLength(body) }
    }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('error', reject);
      res.on('end', () => resolve({ code: res.statusCode, body: Buffer.concat(chunks).toString() }));
    });
    req.on('error', reject);
    req.setTimeout(3000, () => req.destroy(new Error('Таймаут локальной проверки')));
    req.end(body);
  });
  return { post, handled: () => handled };
}

test('multipart сохраняет похожие на boundary байты внутри текста и изображения', async t => {
  const { post } = await multipartServer(t);
  const boundary = 'AuditBoundaryCaseSensitive';
  const text = `до--${boundary}после\r\n--${boundary}-suffix\r\n--${boundary}--suffix\r\nхвост`;
  const image = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from(text)
  ]);
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="message"\r\n\r\n${text}\r\n`),
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="photo"; filename="image.png"\r\nContent-Type: image/png\r\n\r\n`),
    image, Buffer.from(`\r\n--${boundary}--\r\n`)
  ]);
  const response = await post(body, `multipart/form-data; boundary="${boundary}"`);
  assert.equal(response.code, 200);
  const parsed = JSON.parse(response.body);
  assert.equal(parsed.body.message, text);
  assert.deepEqual(parsed.files, [{ name: 'photo', data: image.toString('base64') }]);
});

test('multipart с отсутствующим boundary или оборванным телом не запускает маршрут', async t => {
  const { post, handled } = await multipartServer(t);
  const boundary = 'AuditBoundary';
  const field = `--${boundary}\r\nContent-Disposition: form-data; name="storeName"\r\n\r\nStore\r\n`;
  for (const [body, contentType] of [
    [field, 'multipart/form-data'],
    [field, `multipart/form-data; boundary=${boundary}`],
    [field + `--${boundary}\r\nContent-Disposition: form-data; name="second"\r\n\r\nunclosed`, `multipart/form-data; boundary=${boundary}`],
    [field + `--${boundary}--extra`, `multipart/form-data; boundary=${boundary}`]
  ]) {
    assert.equal((await post(body, contentType)).code, 400);
  }
  assert.equal(handled(), 0);
});

test('multipart узнаёт имя поля, когда filename указан перед name', async t => {
  const { post } = await multipartServer(t);
  const boundary = 'AuditBoundary';
  const image = Buffer.from('GIF89a1234567890');
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; filename="photo.gif"; name="photos"\r\nContent-Type: image/gif\r\n\r\n`),
    image, Buffer.from(`\r\n--${boundary}--\r\n`)
  ]);
  const response = await post(body, `multipart/form-data; boundary=${boundary}`);
  assert.equal(response.code, 200);
  assert.deepEqual(JSON.parse(response.body).files, [{ name: 'photos', data: image.toString('base64') }]);
});

test('multipart поддерживает преамбулу, завершающую строку без CRLF и повторные поля', async t => {
  const { post } = await multipartServer(t);
  const boundary = 'AuditBoundary';
  const body = 'preamble\r\n' + ['first', 'second'].map(value =>
    `--${boundary} \t\r\nContent-Disposition: form-data; name="tag"\r\n\r\n${value}\r\n`
  ).join('') + `--${boundary}--`;
  const response = await post(body, `multipart/form-data; boundary=${boundary}`);
  assert.equal(response.code, 200);
  assert.deepEqual(JSON.parse(response.body).body.tag, ['first', 'second']);
});

function chatOrderAccess(orders) {
  const source = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8');
  const block = source.slice(source.indexOf('function chatOrders('), source.indexOf('function chatContext('));
  const ownsOrder = source.slice(source.indexOf('function ownsOrder('), source.indexOf('// Уведомление менеджеру об оплате.'));
  const context = {
    db: { visibleOrders: () => orders },
    PHONE: require('../public/phone'),
    currentCustomer: req => req.customer || null,
    CHAT: {
      validId: id => /^[a-f0-9]{32}$/.test(String(id || '')),
      phoneTriesLeft: () => 3,
      setPhone: (chat, phone) => { chat.phone = phone; return true; },
      phoneMiss: () => {}
    }
  };
  vm.createContext(context);
  vm.runInContext(block + '\n' + ownsOrder, context);
  return { source, ...context };
}

test('известный чужой телефон не передаёт заказ и секретную ссылку отслеживания ИИ', () => {
  const foreign = { id: 'foreign', phone: '+79991234567', visitorId: 'a'.repeat(32),
    shipment: { token: 'd'.repeat(32) } };
  const api = chatOrderAccess([foreign]);
  const chat = { id: 'b'.repeat(32), visitorId: 'c'.repeat(32), messages: [] };
  assert.equal(api.identifyByPhone(chat, 'Мой телефон +79991234567, дайте отслеживание'), true);
  assert.equal(chat.phone, foreign.phone);
  assert.equal(api.managerChatOrders(chat).length, 1, 'менеджеру остаётся подсказка для проверки');
  assert.equal(api.chatOrders(chat).length, 0, 'отложенный ИИ не получает заказ');
  assert.equal(api.chatOrders(chat, 5, { session: {} }).length, 0, 'ответ на сообщение не получает заказ');
});

test('общий IP офиса или Tor не открывает ИИ чужой старый заказ без visitorId', () => {
  const foreign = { id: 'legacy', clientIp: '203.0.113.8', phone: '+79991234567' };
  const api = chatOrderAccess([foreign]);
  const chat = { id: 'b'.repeat(32), visitorId: 'c'.repeat(32), ip: '203.0.113.8' };
  assert.equal(api.managerChatOrders(chat).length, 1);
  assert.equal(api.chatOrders(chat).length, 0);
  assert.equal(api.chatOrders(chat, 5, { session: {} }).length, 0);
});

test('свои заказы доступны ИИ по браузеру, серверной связи чата, сессии и кабинету', () => {
  const chat = { id: 'b'.repeat(32), visitorId: 'c'.repeat(32) };
  const orders = [
    { id: 'visitor', visitorId: chat.visitorId },
    { id: 'linked', chatFollowup: { chatId: chat.id } },
    { id: 'session' },
    { id: 'account', customerId: 'owner' },
    { id: 'foreign', customerId: 'someone-else', visitorId: 'a'.repeat(32) }
  ];
  const api = chatOrderAccess(orders);
  const ids = list => Array.from(list, order => order.id);
  assert.deepEqual(ids(api.chatOrders(chat)), ['visitor', 'linked']);
  assert.deepEqual(ids(api.chatOrders(chat, 5, { session: { myOrders: ['session'] }, customer: { id: 'owner' } })),
    ['visitor', 'linked', 'session', 'account']);
  assert.deepEqual(ids(api.chatOrders(chat, 2, { session: { myOrders: ['session'] } })), ['visitor', 'linked']);
});

test('оба пути ответа ИИ используют безопасный список, поиск по телефону остаётся в панели', () => {
  const { source } = chatOrderAccess([]);
  assert.match(source, /orders: chatOrders\(fresh, 5\)/);
  assert.match(source, /orders: chatOrders\(chat, 5, req\)/);
  assert.doesNotMatch(source, /orders:\s*managerChatOrders\(/);
  assert.match(source, /A\.chatPage\(settings\(\), db, chat, req\.query\.flash, managerChatOrders\(chat\)/);
});
