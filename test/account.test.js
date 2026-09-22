'use strict';
/* Личный кабинет покупателя: учётные записи, письма и маршруты.
 *
 * Хранилище и почта проверяются поведением — на своём каталоге данных и на
 * поддельном SMTP-сервере со своим сертификатом (его выписывает openssl во
 * временный каталог). Маршруты вырезаются из server.js тем же приёмом, что у
 * теста отмены оплаты: блок между отметками «ЛИЧНЫЙ КАБИНЕТ» исполняется в
 * песочнице с настоящими хранилищем и рендером и поддельной почтой.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const tls = require('node:tls');
const vm = require('node:vm');
const { execFileSync } = require('node:child_process');

const EMAIL = require('../lib/email');
const MAIL = require('../lib/mail');
const R = require('../lib/render');
const auth = require('../lib/auth');
const YM = require('../lib/yandex-metrika');

const ROOT = path.join(__dirname, '..');
const serverSource = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');

/* Свои lib/db и lib/customers поверх временного каталога: путь к данным оба
 * читают при загрузке, поэтому кэш require сбрасывается вокруг подмены
 * переменной — как `freshDb` в core.test.js. */
function freshStore(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'store-account-'));
  const keys = [require.resolve('../lib/db'), require.resolve('../lib/customers')];
  const cached = keys.map(k => require.cache[k]);
  const previous = process.env.STORE_DATA_DIR;
  process.env.STORE_DATA_DIR = dir;
  for (const k of keys) delete require.cache[k];
  const db = require('../lib/db');
  const customers = require('../lib/customers');
  keys.forEach((k, i) => { if (cached[i]) require.cache[k] = cached[i]; else delete require.cache[k]; });
  if (previous === undefined) delete process.env.STORE_DATA_DIR;
  else process.env.STORE_DATA_DIR = previous;
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return { dir, db, customers };
}

test('адрес почты приводится к одной форме, а мусор отсекается', () => {
  assert.equal(EMAIL.valid('  Ivan.Petrov@Mail.RU '), 'ivan.petrov@mail.ru');
  assert.equal(EMAIL.valid('ivan@mail'), '');
  assert.equal(EMAIL.valid('ivan@mail.ru\r\nBcc: x@y.z'), '');
  assert.equal(EMAIL.valid('<ivan@mail.ru>'), '');
  assert.equal(EMAIL.valid(''), '');
  assert.equal(EMAIL.valid(null), '');
});

test('кабинет: регистрация, вход, смена пароля, восстановление и отметка сессии', async t => {
  const { customers, db } = freshStore(t);
  // Порог пароля — шесть знаков, хоть одни цифры: решение владельца.
  assert.match(customers.passwordProblem('12345'), /не меньше 6/);
  assert.equal(customers.passwordProblem('123456'), '');
  assert.equal(customers.PASSWORD_MIN, 6);

  const bad = customers.create({ email: 'не адрес', password: '123456' });
  assert.equal(bad.ok, false);
  const made = customers.create({ email: 'Buyer@Example.RU', password: '123456', name: 'Иван Петров', phone: '8 999 123-45-67' });
  assert.equal(made.ok, true);
  assert.equal(made.customer.email, 'buyer@example.ru', 'адрес хранится в нижнем регистре');
  assert.equal(made.customer.phone, '+79991234567', 'телефон — в той же форме, что у заказа');
  assert.equal(made.customer.autoPassword, false);
  assert.ok(!('123456'.includes(made.customer.passHash)) && made.customer.passHash.includes(':'), 'пароль хранится хешем');
  assert.ok(fs.existsSync(path.join(db.DATA_DIR, 'customers.json')), 'записи лежат своим файлом');

  const dup = customers.create({ email: 'buyer@example.ru', password: 'другой1' });
  assert.equal(dup.ok, false); assert.equal(dup.exists, true);

  assert.equal(customers.byEmail('BUYER@example.ru').id, made.customer.id);
  assert.equal(await customers.verify('buyer@example.ru', '123456'), customers.byId(made.customer.id));
  assert.equal(await customers.verify('buyer@example.ru', '654321'), null);
  assert.equal(await customers.verify('nobody@example.ru', '123456'), null);

  /* ВХОД ПО ТЕЛЕФОНУ — вторым логином, в любой привычной записи: введённое
   * приводится к E.164 тем же модулем, что телефон покупателя в заказе. */
  assert.equal(customers.loginKey(' Buyer@Example.RU '), 'buyer@example.ru');
  assert.equal(customers.loginKey('8 (999) 123-45-67'), '+79991234567');
  assert.equal(customers.loginKey('admin'), ''); assert.equal(customers.loginKind('+7 999 123-45-67'), 'phone');
  assert.equal(customers.byPhone('8 999 123 45 67').id, made.customer.id);
  assert.equal(customers.byLogin('+7 (999) 123-45-67').id, made.customer.id);
  assert.equal(await customers.verify('89991234567', '123456'), customers.byId(made.customer.id));
  assert.equal(await customers.verify('+79991234568', '123456'), null);
  assert.equal(customers.loginText(made.customer), 'buyer@example.ru · +7 999 123-45-67');
  // Один номер — один кабинет: занятый номер второй записи не достаётся.
  const samePhone = customers.create({ login: '+7 999 123-45-67', password: '123456' });
  assert.equal(samePhone.ok, false); assert.equal(samePhone.exists, true); assert.match(samePhone.error, /этим номером/);
  // Кабинет по одному телефону, без почты: регистрация одним полем «логин».
  const phoneOnly = customers.create({ login: '8 999 000-11-22', password: '123456' });
  assert.equal(phoneOnly.ok, true); assert.equal(phoneOnly.customer.email, ''); assert.equal(phoneOnly.customer.phone, '+79990001122');
  assert.equal(await customers.verify('+7 999 000-11-22', '123456'), customers.byId(phoneOnly.customer.id));
  assert.equal(customers.loginText(phoneOnly.customer), '+7 999 000-11-22');
  assert.match(customers.create({ login: 'не логин', password: '123456' }).error, /e-mail или номер телефона/);
  assert.match(customers.create({ password: '123456' }).error, /e-mail или номер телефона/);
  // Логины правятся в профиле: чужие не берутся, последний не стирается.
  assert.match(customers.update(phoneOnly.customer.id, { email: 'buyer@example.ru' }).error, /другому кабинету/);
  assert.match(customers.update(phoneOnly.customer.id, { phone: '' }).error, /хотя бы один способ входа/);
  assert.match(customers.update(made.customer.id, { phone: '+7 999 000-11-22' }).error, /другому кабинету/);
  assert.equal(customers.update(phoneOnly.customer.id, { email: 'Second@Example.ru' }).customer.email, 'second@example.ru');
  assert.equal(customers.update(phoneOnly.customer.id, { phone: '' }).ok, true, 'с почтой телефон стереть можно');
  assert.equal(customers.byPhone('+79990001122'), null);
  // Кабинет учится контактам с заказа: пустое поле заполняется, занятое — нет.
  assert.equal(customers.rememberContacts(phoneOnly.customer.id, { email: 'other@example.ru', phone: '+7 999 123-45-67' }), null, 'почта уже задана, номер занят первым кабинетом — дописывать нечего');
  assert.equal(customers.rememberContacts(phoneOnly.customer.id, { phone: '+7 999 000-11-22' }).phone, '+79990001122');
  assert.equal(customers.byId(phoneOnly.customer.id).email, 'second@example.ru', 'заданная почта заказом не перебивается');
  /* Номер на двоих из прежних записей (телефон стал логином позже) на вход не
   * годится ни одному — иначе первый попавшийся получил бы чужой кабинет. */
  db.writeJson('customers', db.readJson('customers', []).map(c => c.id === phoneOnly.customer.id ? Object.assign({}, c, { phone: '+79991234567' }) : c));
  assert.equal(customers.byPhone('+79991234567'), null);
  assert.equal(await customers.verify('+79991234567', '123456'), null);
  assert.equal(await customers.verify('buyer@example.ru', '123456') !== null, true, 'по почте оба входят как раньше');
  db.writeJson('customers', db.readJson('customers', []).filter(c => c.id !== phoneOnly.customer.id));

  // Отметка сессии привязана к хешу пароля: сменили пароль — прежняя не годится.
  const stamp = customers.stamp(made.customer, 'secret');
  assert.equal(stamp.length, 24);
  const set = customers.setPassword(made.customer.id, '777777');
  assert.equal(set.ok, true);
  assert.notEqual(customers.stamp(set.customer, 'secret'), stamp);
  assert.equal(customers.setPassword(made.customer.id, '12').ok, false);
  assert.equal(await customers.verify('buyer@example.ru', '777777'), customers.byId(made.customer.id));

  // Ссылка восстановления: живёт час, снимается сменой пароля, чужая не находится.
  const token = customers.issueReset(made.customer.id);
  assert.match(token, /^[a-f0-9]{32}$/);
  assert.equal(customers.byResetToken(token).id, made.customer.id);
  assert.equal(customers.byResetToken('f'.repeat(32)), null);
  assert.equal(customers.byResetToken('not-a-token'), null);
  customers.setPassword(made.customer.id, '888888');
  assert.equal(customers.byResetToken(token), null, 'после смены пароля ссылка мертва');
  const late = customers.issueReset(made.customer.id);
  db.writeJson('customers', db.readJson('customers', []).map(c => Object.assign({}, c, { resetUntil: Date.now() - 1 })));
  assert.equal(customers.byResetToken(late), null, 'просроченная ссылка не находится');

  // Профиль: телефон проверяется тем же модулем, что и в заказе.
  assert.equal(customers.update(made.customer.id, { phone: 'abc' }).ok, false);
  assert.equal(customers.update(made.customer.id, { name: '  Пётр  ', phone: '' }).customer.name, 'Пётр');

  // Кабинет, созданный при заказе: пароль присланный, вход по нему снимает отметку.
  const auto = customers.create({ email: 'auto@example.ru', password: customers.generatePassword(), auto: true });
  assert.equal(auto.customer.autoPassword, true);
  assert.equal(customers.touchLogin(auto.customer.id).autoPassword, false);
  assert.match(customers.generatePassword(), /^[a-hj-km-np-z2-9]{8}$/, 'без 0, 1, l и o — их путают, набирая с письма');
  assert.deepEqual(Object.keys(customers.publicView(auto.customer)).sort(),
    ['address', 'addressAt', 'autoPassword', 'createdAt', 'email', 'id', 'lastLoginAt', 'name', 'phone'], 'наружу — без хеша и ключей');
});

test('кабинет: адрес доставки — свой, с проверкой полноты, из первого заказа и с отметкой правки', t => {
  const { customers } = freshStore(t);
  const made = customers.create({ email: 'addr@example.ru', password: '123456' });
  assert.equal(made.customer.address, ''); assert.equal(made.customer.addressAt, 0);

  // Проверяется ТОЙ ЖЕ полнотой, что и заказ: «Екатеринбург» — не адрес.
  const short = customers.update(made.customer.id, { address: 'Екатеринбург' });
  assert.equal(short.ok, false); assert.match(short.error, /не хватает улицы и номера дома/);
  assert.equal(customers.byId(made.customer.id).address, '', 'негодный адрес не записан');
  // Хранится одной строкой: перенос из вставки и ряды пробелов схлопнуты.
  const before = Date.now();
  const ok = customers.update(made.customer.id, { address: ' г Екатеринбург,\n ул  Малышева, д 5 ' });
  assert.equal(ok.ok, true);
  assert.equal(ok.customer.address, 'г Екатеринбург, ул Малышева, д 5');
  assert.ok(ok.customer.addressAt >= before, 'правка адреса помечена временем');
  // Тот же адрес заново отметку не двигает: по ней оформление решает, что свежее.
  const at = ok.customer.addressAt;
  const same = customers.update(made.customer.id, { address: 'г Екатеринбург, ул Малышева, д 5', name: 'Иван' });
  assert.equal(same.customer.addressAt, at);
  assert.equal(same.customer.name, 'Иван');
  // Правка имени без поля адреса адрес не трогает; пустой адрес — законное «стереть».
  assert.equal(customers.update(made.customer.id, { name: 'Пётр' }).customer.address, 'г Екатеринбург, ул Малышева, д 5');
  assert.equal(customers.update(made.customer.id, { address: '' }).customer.address, '');

  // Из заказа адрес берётся только в пустой кабинет: заданный принадлежит покупателю.
  assert.equal(customers.rememberAddress(made.customer.id, ''), null, 'пустой адрес ничего не пишет');
  assert.equal(customers.rememberAddress(made.customer.id, 'г Москва, ул Тверская, д 1').address, 'г Москва, ул Тверская, д 1');
  assert.equal(customers.rememberAddress(made.customer.id, 'г Казань, ул Баумана, д 2'), null, 'заказ на другой адрес сохранённый не перебивает');
  assert.equal(customers.byId(made.customer.id).address, 'г Москва, ул Тверская, д 1');
  assert.equal(customers.rememberAddress('нет-такого', 'г Москва, ул Тверская, д 1'), null);
  // Автосозданный кабинет берёт адрес из заказа сразу, как имя и телефон.
  const auto = customers.create({ email: 'auto2@example.ru', password: customers.generatePassword(), address: 'г Пермь, ул Ленина, д 3', auto: true });
  assert.equal(auto.customer.address, 'г Пермь, ул Ленина, д 3');
  assert.ok(auto.customer.addressAt > 0);
});

test('заказ знает почту и кабинет, а привязка не перебивает чужую', t => {
  const { db } = freshStore(t);
  const order = db.createOrder({ items: [], total: 1000, email: ' Buyer@Example.ru ', customerId: 'bad-id' });
  assert.equal(order.email, 'buyer@example.ru');
  assert.equal(order.customerId, '', 'чужой формат id не записывается');
  const mine = 'a'.repeat(16), other = 'b'.repeat(16);
  assert.equal(db.attachOrderCustomer(order.id, mine).customerId, mine);
  assert.equal(db.attachOrderCustomer(order.id, mine).customerId, mine, 'повтор — тот же заказ');
  assert.equal(db.attachOrderCustomer(order.id, other), null, 'к другому кабинету не переезжает');
  assert.equal(db.attachOrderCustomer('нет-такого', mine), null);
  assert.deepEqual(db.ordersForCustomer(mine).map(o => o.id), [order.id]);
  assert.deepEqual(db.ordersForCustomer(other), []);
  db.archiveOrder(order.id, 'admin');
  assert.deepEqual(db.ordersForCustomer(mine), [], 'удалённый менеджером заказ покупателю не показывается');
});

/* ---------------- Почта ---------------- */

// Самоподписанный сертификат для поддельного сервера. Нет openssl — эти
// проверки пропускаются, остальные идут.
function selfSigned(t) {
  let dir;
  try {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'store-mail-cert-'));
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', path.join(dir, 'key.pem'),
      '-out', path.join(dir, 'cert.pem'), '-days', '2', '-subj', '/CN=localhost',
      '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1'], { stdio: 'ignore' });
  } catch (e) { return null; }
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return { key: fs.readFileSync(path.join(dir, 'key.pem')), cert: fs.readFileSync(path.join(dir, 'cert.pem')) };
}

/* Поддельный SMTP: отвечает как настоящий сервер и записывает всё, что ему
 * прислали. `mode` — 'tls' (шифрование с первого байта), 'starttls' или
 * 'plain' (STARTTLS не предлагает). */
function fakeSmtp(t, mode, cert, opts) {
  const log = { commands: [], data: '', auth: '' };
  const o = opts || {};
  const serve = (socket, greeted) => {
    let data = false, buffer = '', authStep = 0;
    const say = line => socket.write(line + '\r\n');
    // После STARTTLS настоящий сервер приветствие не повторяет: клиент сразу
    // шлёт EHLO внутри шифрования.
    if (!greeted) say('220 fake.smtp ESMTP');
    socket.on('data', chunk => {
      buffer += chunk.toString('utf8');
      let i;
      while ((i = buffer.indexOf('\r\n')) >= 0) {
        const line = buffer.slice(0, i); buffer = buffer.slice(i + 2);
        if (data) {
          if (line === '.') { data = false; say('250 2.0.0 Ok: queued'); }
          else log.data += line + '\r\n';
          continue;
        }
        // AUTH LOGIN: две следующие строки — логин и пароль в base64, не команды.
        if (authStep === 1) { log.auth = 'LOGIN ' + line; authStep = 2; say('334 UGFzc3dvcmQ6'); continue; }
        if (authStep === 2) { log.auth += ' ' + line; authStep = 0; say('235 OK'); continue; }
        log.commands.push(line);
        const cmd = line.split(' ')[0].toUpperCase();
        if (cmd === 'EHLO') {
          say('250-fake.smtp');
          if (mode === 'starttls' && !socket.encrypted) say('250-STARTTLS');
          if (socket.encrypted || mode === 'plain') say('250-AUTH ' + (o.loginOnly ? 'LOGIN' : 'PLAIN LOGIN'));
          say('250 SIZE 10240000');
        } else if (cmd === 'STARTTLS') {
          say('220 Ready');
          socket.removeAllListeners('data');
          const secure = new tls.TLSSocket(socket, { isServer: true, key: cert.key, cert: cert.cert });
          serve(secure, true); // разговор продолжается уже внутри шифрования
          return;
        } else if (cmd === 'AUTH') {
          if (line.toUpperCase().startsWith('AUTH PLAIN ')) { log.auth = line.slice(11); say(o.badAuth ? '535 5.7.8 Authentication failed' : '235 2.7.0 OK'); }
          else { authStep = 1; say('334 VXNlcm5hbWU6'); }
        } else if (cmd === 'MAIL' || cmd === 'RCPT') say('250 OK');
        else if (cmd === 'DATA') { data = true; say('354 End data with <CR><LF>.<CR><LF>'); }
        else if (cmd === 'QUIT') { say('221 Bye'); socket.end(); }
        else say('500 Unknown');
      }
    });
    socket.on('error', () => {});
  };
  const server = mode === 'tls'
    ? tls.createServer({ key: cert.key, cert: cert.cert }, serve)
    : net.createServer(serve);
  server.listen(0, '127.0.0.1');
  t.after(() => server.close());
  return { log, port: () => server.address().port, ready: new Promise(resolve => server.once('listening', resolve)) };
}

test('письмо: заголовки закодированы, тело base64, чужой адрес не проходит', () => {
  const c = MAIL.conf({ mailHost: 'smtp.example.ru', mailUser: 'shop@example.ru', mailFromName: 'Магазин «Тест»' });
  assert.equal(c.from, 'shop@example.ru', 'адрес отправителя — логин, если он адрес');
  assert.equal(c.port, 465); assert.equal(c.secure, true);
  assert.equal(MAIL.conf({ mailHost: 'smtp.example.ru', mailPort: '587' }).secure, false);
  assert.equal(MAIL.configured({ mailHost: 'smtp.example.ru', mailUser: 'shop@example.ru' }), true);
  assert.equal(MAIL.configured({ mailHost: 'smtp.example.ru', mailUser: 'shop' }), false, 'без адреса отправителя письма нет');
  assert.equal(MAIL.configured({ mailUser: 'shop@example.ru' }), false);

  const { to, data } = MAIL.compose(c, { to: ' Buyer@Example.ru', subject: 'Пароль от кабинета', text: 'Пароль: abc\n.\nконец' });
  assert.equal(to, 'buyer@example.ru');
  assert.match(data, /^From: =\?UTF-8\?B\?[A-Za-z0-9+/=]+\?= <shop@example.ru>\r\n/);
  assert.match(data, /\r\nSubject: =\?UTF-8\?B\?0J/);
  assert.match(data, /\r\nContent-Transfer-Encoding: base64\r\n/);
  const body = data.split('\r\n\r\n')[1].replace(/\r\n/g, '');
  assert.equal(Buffer.from(body, 'base64').toString('utf8'), 'Пароль: abc\n.\nконец', 'точка в тексте не оборвёт DATA — тело в base64');
  assert.throws(() => MAIL.compose(c, { to: 'x@y\r\nBcc: z@w.ru', subject: 's', text: 't' }), /bad_to/);
  assert.equal(MAIL.encodeWord('Plain subject'), 'Plain subject');
  const long = MAIL.encodeWord('Очень длинная тема письма, которая не помещается в одно закодированное слово заголовка');
  assert.ok(long.split('\r\n ').every(w => w.length <= 75), 'закодированные слова не длиннее 75 знаков');
  assert.deepEqual(MAIL.capabilities({ lines: ['250-x', '250-STARTTLS', '250 AUTH PLAIN LOGIN'] }), { starttls: true, auth: ['PLAIN', 'LOGIN'] });
});

test('SMTP: письмо уходит через TLS с первого байта и через STARTTLS, пароль — только внутри шифрования', async t => {
  const cert = selfSigned(t);
  if (!cert) return t.skip('нет openssl — сертификат для поддельного сервера не выписать');
  for (const mode of ['tls', 'starttls']) {
    const smtp = fakeSmtp(t, mode, cert);
    await smtp.ready;
    const c = Object.assign(MAIL.conf({ mailHost: 'localhost', mailPort: smtp.port(), mailUser: 'shop@example.ru', mailPass: 'p@ss', mailFromName: 'Shop' }),
      { secure: mode === 'tls', ca: cert.cert });
    const sent = await MAIL.session(c, { to: 'buyer@example.ru', subject: 'Тест', text: 'Пароль: 123456' });
    assert.equal(sent.ok, true);
    assert.equal(Buffer.from(smtp.log.auth, 'base64').toString('utf8'), '\0shop@example.ru\0p@ss', mode + ': AUTH PLAIN с логином и паролем');
    assert.ok(smtp.log.commands.includes('MAIL FROM:<shop@example.ru>') && smtp.log.commands.includes('RCPT TO:<buyer@example.ru>'), mode + ': конверт');
    assert.match(smtp.log.data, /From: "Shop" <shop@example.ru>\r\n/);
    assert.match(smtp.log.data, /Auto-Submitted: auto-generated/);
    if (mode === 'starttls') {
      const starttls = smtp.log.commands.indexOf('STARTTLS');
      const authAt = smtp.log.commands.findIndex(x => x.startsWith('AUTH '));
      assert.ok(starttls > -1 && authAt > starttls, 'логин уходит только после STARTTLS');
      assert.equal(smtp.log.commands.filter(x => x.startsWith('EHLO')).length, 2, 'после шифрования EHLO повторяется');
    }
  }
  // AUTH LOGIN, когда PLAIN сервер не предлагает.
  const login = fakeSmtp(t, 'tls', cert, { loginOnly: true });
  await login.ready;
  const lc = Object.assign(MAIL.conf({ mailHost: 'localhost', mailPort: login.port(), mailUser: 'u@example.ru', mailPass: 'pw' }), { secure: true, ca: cert.cert });
  assert.equal((await MAIL.session(lc, null)).ok, true, 'проверка без письма проходит тот же путь');
  assert.equal(login.log.auth, 'LOGIN ' + Buffer.from('u@example.ru').toString('base64') + ' ' + Buffer.from('pw').toString('base64'));
  assert.ok(!login.log.commands.some(x => x.startsWith('MAIL ')), 'проверка связи письма не шлёт');
});

test('SMTP: без STARTTLS пароль не отправляется, а отказы называются по коду', async t => {
  const plain = fakeSmtp(t, 'plain', null);
  await plain.ready;
  const c = Object.assign(MAIL.conf({ mailHost: 'localhost', mailPort: plain.port(), mailUser: 'shop@example.ru', mailPass: 'secret' }), { secure: false });
  await assert.rejects(MAIL.session(c, { to: 'b@example.ru', subject: 's', text: 't' }), e => e.code === 'tls');
  assert.ok(!plain.log.commands.some(x => /^AUTH/i.test(x)), 'логин без шифрования не ушёл');
  assert.equal(plain.log.auth, '');

  const cert = selfSigned(t);
  if (cert) {
    const bad = fakeSmtp(t, 'tls', cert, { badAuth: true });
    await bad.ready;
    const bc = Object.assign(MAIL.conf({ mailHost: 'localhost', mailPort: bad.port(), mailUser: 'shop@example.ru', mailPass: 'wrong' }), { secure: true, ca: cert.cert });
    await assert.rejects(MAIL.session(bc, { to: 'b@example.ru', subject: 's', text: 't' }), e => e.code === 'auth');
    // Самоподписанный сертификат без доверия — отказ, а не молчаливое согласие.
    const untrusted = Object.assign({}, bc, { ca: undefined });
    await assert.rejects(MAIL.session(untrusted, null), e => e.code === 'tls' || e.code === 'net');
  }
  assert.match(MAIL.explain(new MAIL.SmtpError('auth', 'x')), /логин или пароль/);
  await assert.rejects(MAIL.send({ mailHost: '' }, { to: 'b@example.ru' }), e => e.code === 'config');
});

/* ---------------- Маршруты ---------------- */

function routes(t, opts) {
  const { db, customers } = freshStore(t);
  db.ensureSeeded();
  const settings = Object.assign(db.getSettings(), { storeName: 'Тест', mailHost: 'smtp.example.ru', mailUser: 'shop@example.ru' }, opts && opts.settings || {});
  const sent = [];
  const mail = {
    configured: s => !!s.mailHost, explain: e => String(e && e.message || e), PORT_TLS: 465,
    send: async (s, m) => { sent.push(m); if (opts && opts.mailFails) throw new Error('smtp down'); return { ok: true }; }
  };
  const handlers = { GET: {}, POST: {} };
  const app = { get: (route, fn) => { handlers.GET[route] = fn; }, post: (route, fn) => { handlers.POST[route] = fn; } };
  // Помощники сессии живут рядом с проверкой админа, маршруты — своим блоком.
  const helpers = serverSource.slice(serverSource.indexOf('function currentCustomer(req)'), serverSource.indexOf('// Защита входов от перебора паролей'));
  const block = serverSource.slice(serverSource.indexOf('/* ============================ ЛИЧНЫЙ КАБИНЕТ'), serverSource.indexOf('/* ============================ /ЛИЧНЫЙ КАБИНЕТ'));
  const own = serverSource.slice(serverSource.indexOf('function ownOrder(req, id)'), serverSource.indexOf('// Уведомление менеджеру об оплате'));
  const notFound = [];
  const box = vm.runInNewContext(helpers + '\n' + block + '\n' + own + '\n({ accountForOrder, currentCustomer, loginCustomer, ownOrder, ownsOrder })', {
    app, db, R, auth, CUSTOMERS: customers, MAIL: mail, EMAIL, console,
    settings: () => settings,
    pageOpts: (req, extra) => Object.assign({ categories: [] }, extra || {}),
    sendNotFound: (req, res) => { notFound.push(req.pathname); res.send('404', 404); },
    floodLimited: () => false, rateLimited: () => false,
    paymentOrigin: () => 'https://shop.example', originOf: () => 'http://localhost:3000'
  });
  const call = async (method, route, session, body, params) => {
    const req = { method, pathname: route, session, body: body || {}, query: {}, params: params || {}, headers: { host: 'shop.example' } };
    const res = { status: 200, html: '', location: '',
      send(html, code) { this.html = String(html); this.status = code || 200; },
      redirect(url) { this.location = url; this.status = 302; } };
    await handlers[method][route](req, res);
    return res;
  };
  return { db, customers, settings, sent, call, box, notFound, handlers };
}

test('маршруты кабинета: регистрация, вход, чужой заказ, смена и восстановление пароля', async t => {
  const { db, customers, sent, call, box, settings } = routes(t);
  assert.deepEqual(Object.keys(box), ['accountForOrder', 'currentCustomer', 'loginCustomer', 'ownOrder', 'ownsOrder']);

  // Без входа — на страницу входа; страница входа обещает пароль письмом, когда почта есть.
  let res = await call('GET', '/account', {});
  assert.equal(res.location, '/account/login');
  res = await call('GET', '/account/login', {});
  assert.match(res.html, /Вход в личный кабинет/);
  assert.match(res.html, /Забыли пароль\?/);
  assert.match(res.html, /minlength="6"/);

  assert.match(res.html, /<label for="acc-login">E-mail или телефон<\/label>/, 'поле логина одно на оба');
  // Регистрация: короткий пароль — отказ с введённым логином; годный — вход.
  const session = { myOrders: [] };
  res = await call('POST', '/account/register', session, { login: 'Buyer@Example.ru', password: '12345' });
  assert.equal(res.status, 400); assert.match(res.html, /не меньше 6/); assert.match(res.html, /value="Buyer@Example.ru"/);
  res = await call('POST', '/account/register', session, { login: 'Buyer@Example.ru', password: '123456' });
  assert.equal(res.status, 302); assert.match(res.location, /^\/account\?flash=/);
  assert.match(session.customerId, /^[a-f0-9]{16}$/);
  assert.equal(box.currentCustomer({ session }).email, 'buyer@example.ru');
  res = await call('GET', '/account', session);
  assert.match(res.html, /buyer@example\.ru/); assert.match(res.html, /Заказов пока нет/);
  assert.match(res.html, /Сменить пароль/); assert.match(res.html, /name="current"/, 'свой пароль меняется только со старым');

  // Вход: чужой логин и неверный пароль — один ответ.
  const other = {};
  res = await call('POST', '/account/login', other, { login: 'buyer@example.ru', password: '000000' });
  assert.equal(res.status, 400); assert.match(res.html, /Неверный e-mail, телефон или пароль/);
  const noOne = await call('POST', '/account/login', {}, { login: 'nobody@example.ru', password: '000000' });
  assert.equal(noOne.status, 400); assert.equal(noOne.html.includes('Неверный e-mail, телефон или пароль'), true);
  assert.equal((await call('POST', '/account/login', {}, { login: 'admin', password: '123456' })).status, 400, 'не адрес и не номер — отказ, без похода в scrypt');
  res = await call('POST', '/account/login', other, { login: 'BUYER@example.ru', password: '123456' });
  assert.equal(res.location, '/account');
  assert.equal(other.customerId, session.customerId);
  // Телефон — второй логин: в профиле задали, по нему и входят, в любой записи.
  res = await call('POST', '/account/profile', session, { name: 'Иван', email: 'buyer@example.ru', phone: '8 999 123-45-67', address: '' });
  assert.equal(res.status, 302);
  const byPhone = {};
  res = await call('POST', '/account/login', byPhone, { login: '+7 (999) 123-45-67', password: '123456' });
  assert.equal(res.location, '/account'); assert.equal(byPhone.customerId, session.customerId);
  res = await call('GET', '/account', byPhone);
  assert.match(res.html, /acc-sub">buyer@example\.ru · \+7 999 123-45-67</, 'в шапке кабинета оба логина');
  assert.match(res.html, /<label for="acc-email">E-mail<\/label><input type="email" id="acc-email" name="email" value="buyer@example\.ru"/);
  // Регистрация по одному телефону: без почты, вход по номеру, восстанавливать нечем.
  const phoneSession = {};
  res = await call('POST', '/account/register', phoneSession, { login: '8 999 000-11-22', password: '123456' });
  assert.equal(res.status, 302); assert.match(decodeURIComponent(res.location), /с этим номером телефона/);
  assert.equal(box.currentCustomer({ session: phoneSession }).phone, '+79990001122');
  res = await call('GET', '/account', phoneSession);
  assert.match(res.html, /acc-sub">\+7 999 000-11-22</);
  res = await call('POST', '/account/forgot', {}, { login: '+7 999 000-11-22' });
  assert.match(res.html, /Письмо отправлено/); assert.match(res.html, /к номеру \+7 999 000-11-22 привязан кабинет с e-mail/);
  assert.equal(sent.length, 0, 'почты у кабинета нет — письмо не уходит, а ответ тот же');
  res = await call('POST', '/account/register', {}, { login: '+7 999 000 11 22', password: '123456' });
  assert.equal(res.status, 400); assert.match(res.html, /этим номером уже есть/);
  res = await call('POST', '/account/forgot', {}, { login: 'просто слова' });
  assert.equal(res.status, 400); assert.match(res.html, /Укажите e-mail или номер телефона/);

  // Заказ кабинета свой с любого устройства, чужой — нет.
  const order = db.createOrder({ items: [], total: 1000, customerId: session.customerId });
  const stranger = db.createOrder({ items: [], total: 1000, customerId: 'c'.repeat(16) });
  assert.equal(box.ownOrder({ session: other }, order.id).id, order.id);
  assert.equal(box.ownOrder({ session: other }, stranger.id), null);
  assert.equal(box.ownOrder({ session: { myOrders: [stranger.id] } }, stranger.id).id, stranger.id, 'заказ из своей сессии — по-прежнему свой');
  res = await call('GET', '/account', other);
  assert.match(res.html, new RegExp(R.orderNo(order.number)));

  // Смена пароля: старый обязателен и проверяется; новая отметка выгоняет вторую сессию.
  res = await call('POST', '/account/password', session, { current: 'wrong1', password: '654321' });
  assert.equal(res.status, 400); assert.match(res.html, /Текущий пароль не подходит/);
  res = await call('POST', '/account/password', session, { current: '123456', password: '654321' });
  assert.equal(res.status, 302);
  assert.equal(box.currentCustomer({ session }).email, 'buyer@example.ru', 'эта сессия остаётся');
  assert.equal(box.currentCustomer({ session: other }), null, 'прежняя сессия с другого устройства вышла');
  assert.equal(await customers.verify('buyer@example.ru', '654321') !== null, true);

  // Восстановление: письмо со ссылкой (и по телефону — на почту кабинета),
  // чужой логин отвечает так же, ссылка одноразовая.
  res = await call('POST', '/account/forgot', {}, { login: '8 999 123-45-67' });
  assert.match(res.html, /Письмо отправлено/); assert.equal(sent.length, 1);
  assert.equal(sent[0].to, 'buyer@example.ru', 'по телефону ссылка уходит на почту того же кабинета');
  sent.length = 0;
  res = await call('POST', '/account/forgot', {}, { login: 'buyer@example.ru' });
  assert.match(res.html, /Письмо отправлено/);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, 'buyer@example.ru');
  const link = sent[0].text.match(/https:\/\/shop\.example\/account\/reset\/([a-f0-9]{32})/);
  assert.ok(link, 'ссылка — по публичному адресу, а не по Host запроса');
  assert.doesNotMatch(sent[0].text, /654321/, 'пароля в письме нет — ссылка ничего не меняет, пока по ней не пришли');
  res = await call('POST', '/account/forgot', {}, { login: 'nobody@example.ru' });
  assert.match(res.html, /Письмо отправлено/); assert.equal(sent.length, 1);
  res = await call('GET', '/account/reset/:token', {}, {}, { token: 'f'.repeat(32) });
  assert.equal(res.status, 400); assert.match(res.html, /устарела/);
  res = await call('GET', '/account/reset/:token', {}, {}, { token: link[1] });
  assert.match(res.html, /Новый пароль/);
  const fresh = {};
  res = await call('POST', '/account/reset/:token', fresh, { password: '999999' }, { token: link[1] });
  assert.equal(res.status, 302); assert.equal(fresh.customerId, session.customerId);
  assert.equal(await customers.verify('buyer@example.ru', '999999') !== null, true);
  assert.equal(await customers.verify('buyer@example.ru', '654321'), null);
  res = await call('POST', '/account/reset/:token', {}, { password: '111111' }, { token: link[1] });
  assert.equal(res.status, 400, 'ссылка одноразовая');
  assert.equal(box.currentCustomer({ session }), null, 'смена по ссылке выгоняет прежние сессии');

  // Выход и выключенный кабинет.
  res = await call('POST', '/account/logout', fresh);
  assert.equal(fresh.customerId, undefined); assert.equal(res.location, '/');
  settings.accountsOn = false;
  res = await call('GET', '/account/login', {});
  assert.equal(res.status, 404);
  assert.equal(box.currentCustomer({ session: other }), null);
});

test('кабинет заводится сам при заказе с почтой: пароль письмом, сессия вошедшая, заказ привязан', async t => {
  const { db, customers, sent, call, box, settings } = routes(t);
  const session = { myOrders: [] };
  const order = db.createOrder({ items: [], total: 1000, firstName: 'Иван', lastName: 'Петров', phone: '+79991234567', email: 'new@example.ru', address: 'г Тула, ул Советская, д 7' });
  session.myOrders.push(order.id);
  // Объект приходит из песочницы vm — сравниваем по значениям, а не по прототипу.
  const plain = v => JSON.parse(JSON.stringify(v));
  const note = box.accountForOrder({ session, headers: {} }, settings, order, null, 'new@example.ru');
  assert.deepEqual(plain(note), { created: true, email: 'new@example.ru' });
  await new Promise(r => setTimeout(r, 5));
  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, 'new@example.ru');
  const password = sent[0].text.match(/Пароль: (\S+)/)[1];
  assert.match(sent[0].text, /https:\/\/shop\.example\/account\/login/);
  assert.match(sent[0].text, new RegExp(R.orderNo(order.number)));
  const customer = customers.byEmail('new@example.ru');
  assert.equal(customer.autoPassword, true);
  assert.equal(customer.name, 'Иван Петров'); assert.equal(customer.phone, '+79991234567');
  assert.equal(customer.address, 'г Тула, ул Советская, д 7', 'адрес заказа стал адресом кабинета');
  assert.equal(session.customerId, customer.id, 'сессия уже вошедшая');
  assert.equal(db.getOrder(order.id).customerId, customer.id, 'заказ привязан');
  assert.equal(await customers.verify('new@example.ru', password) !== null, true, 'присланный пароль подходит');

  // В кабинете присланный пароль меняется без старого — письмо могло не дойти.
  let res = await call('GET', '/account', session);
  assert.match(res.html, /Пароль от кабинета мы отправили на new@example\.ru/);
  assert.doesNotMatch(res.html, /name="current"/);
  res = await call('POST', '/account/password', session, { password: '123456' });
  assert.equal(res.status, 302);
  assert.equal(customers.byEmail('new@example.ru').autoPassword, false);
  res = await call('GET', '/account', session);
  assert.match(res.html, /name="current"/, 'после смены свой пароль без старого уже не меняется');

  // Почта существующего кабинета заказ к нему НЕ привязывает: привяжет вход из этой же сессии.
  const second = db.createOrder({ items: [], total: 500, email: 'new@example.ru' });
  const guest = { myOrders: [second.id] };
  assert.deepEqual(plain(box.accountForOrder({ session: guest }, settings, second, null, 'new@example.ru')), { exists: true, email: 'new@example.ru' });
  assert.equal(db.getOrder(second.id).customerId, '');
  assert.equal(guest.customerId, undefined);
  res = await call('POST', '/account/login', guest, { login: 'new@example.ru', password: '123456' });
  assert.equal(res.location, '/account');
  assert.equal(db.getOrder(second.id).customerId, customer.id, 'вход из сессии, оформившей заказ, привязал его');
  const foreign = db.createOrder({ items: [], total: 500, email: 'someone-else@example.ru' });
  const guest2 = { myOrders: [foreign.id] };
  await call('POST', '/account/login', guest2, { login: 'new@example.ru', password: '123456' });
  assert.equal(db.getOrder(foreign.id).customerId, '', 'заказ с чужой почтой не привязывается');
  // Заказ с ТЕМ ЖЕ телефоном и другой почтой — свой: кабинет мог быть заведён по номеру.
  const byPhoneOrder = db.createOrder({ items: [], total: 500, email: 'other@example.ru', phone: '+79991234567' });
  const guest3 = { myOrders: [byPhoneOrder.id] };
  await call('POST', '/account/login', guest3, { login: '8 999 123-45-67', password: '123456' });
  assert.equal(db.getOrder(byPhoneOrder.id).customerId, customer.id, 'вход по телефону привязал заказ с тем же номером');
  // Номер заказа уже принадлежит кабинету — второй на тот же номер не заводится.
  const fourth = db.createOrder({ items: [], total: 500, email: 'fourth@example.ru', phone: '+79991234567' });
  assert.deepEqual(plain(box.accountForOrder({ session: { myOrders: [fourth.id] } }, settings, fourth, null, 'fourth@example.ru')), { exists: true, phone: '+79991234567' });
  assert.equal(customers.byEmail('fourth@example.ru'), null);
  assert.match(R.accountNoteText({ exists: true, phone: '+79991234567' }), /К номеру \+7 999 123-45-67 уже привязан личный кабинет/);

  // Без почты кабинет при заказе не создаётся; вошедший — ничего не получает.
  settings.mailHost = '';
  const third = db.createOrder({ items: [], total: 500, email: 'third@example.ru' });
  assert.equal(box.accountForOrder({ session: {} }, settings, third, null, 'third@example.ru'), null);
  assert.equal(customers.byEmail('third@example.ru'), null);
  assert.equal(box.accountForOrder({ session }, settings, third, customer, 'third@example.ru'), null);
});

test('письмо с паролем не ушло — заказ и кабинет всё равно на месте', async t => {
  const { db, customers, call, box, settings } = routes(t, { mailFails: true });
  const session = { myOrders: [] };
  const order = db.createOrder({ items: [], total: 1000, email: 'lost@example.ru' });
  const errors = [];
  const original = console.error; console.error = m => errors.push(String(m));
  try {
    assert.deepEqual(JSON.parse(JSON.stringify(box.accountForOrder({ session }, settings, order, null, 'lost@example.ru'))), { created: true, email: 'lost@example.ru' });
    await new Promise(r => setTimeout(r, 5));
  } finally { console.error = original; }
  assert.ok(errors.some(m => /lost@example\.ru/.test(m)), 'отказ почты виден в логе');
  assert.equal(session.customerId, customers.byEmail('lost@example.ru').id);
  const res = await call('POST', '/account/password', session, { password: '123456' });
  assert.equal(res.status, 302, 'без письма покупатель задаёт пароль сам');
});

/* ---------------- Витрина и панель ---------------- */

test('страницы кабинета: состояния заказов словами покупателя, значок в шапке, оплата помнит отметку', () => {
  const settings = Object.assign(require('../lib/db').defaultSettings(), { storeName: 'Тест' });
  const now = Date.now();
  const orders = [
    { id: 'o1', number: 100001, createdAt: now, total: 1000, items: [{ name: 'Товар А', qty: 1 }, { name: 'Товар Б', qty: 2 }, { name: 'Товар В', qty: 1 }], payMode: 'own' },
    { id: 'o2', number: 100002, createdAt: now - 3600e3, total: 2000, items: [{ name: 'Товар', qty: 1 }], manualPaid: { at: now, by: 'admin' },
      shipment: { carrier: 'cdek', to: 'Казань', token: 'a'.repeat(32), visible: true, createdAt: now, steps: [{ at: now - 1000, title: 'Принят на склад', city: 'Москва' }] } },
    { id: 'o3', number: 100003, createdAt: now - 86400e3, total: 3000, items: [{ name: 'Товар', qty: 1 }], manualVoid: { at: now, by: 'customer' } },
    { id: 'o4', number: 100004, createdAt: now, total: 4000, items: [{ name: 'Товар', qty: 1 }], draft: true }
  ];
  assert.equal(R.accountOrderState(orders[0], now).label, 'Ждёт оплаты');
  assert.equal(R.accountOrderState(orders[1], now).label, 'Оплачен');
  assert.equal(R.accountOrderState(orders[2], now).label, 'Отменён');
  assert.equal(R.accountOrderState(orders[3], now).label, 'Не завершён');
  assert.equal(R.accountOrderState({ id: 'x', createdAt: now, total: 1 }, now).label, 'Принят');
  const html = R.accountPage(settings, { customer: { id: 'c', email: 'b@example.ru', name: 'Иван', address: 'г Тула, ул Советская, д 7' }, orders, now });
  // Адрес доставки в профиле — то же растущее поле с подсказками, что на оформлении.
  assert.match(html, /<label for="acc-address">Адрес доставки<\/label><div class="suggest-box"><textarea id="acc-address" class="addr-input" rows="1" maxlength="400" name="address"[^>]*enterkeyhint="done"[^>]*role="combobox"[^>]*aria-controls="acc-address-list"[^>]*>г Тула, ул Советская, д 7<\/textarea><div class="suggest-list" id="acc-address-list" role="listbox" hidden>/);
  assert.match(html, /href="\/pay\/o1">Оплатить/);
  assert.match(html, /href="\/receipt\/o2">Товарный чек/);
  assert.match(html, /href="\/track\/a{32}">Отследить/);
  assert.doesNotMatch(html, /href="\/pay\/o3"/, 'отменённый заказ платить не зовёт');
  assert.match(html, /и ещё 2 товара/);
  assert.match(html, /<section class="acc-card" id="shipments"/);
  assert.match(html, /trk-mine-item trk-cdek/);
  /* КОРЗИНЫ В КАБИНЕТЕ НЕТ (20 сентября 2026, по просьбе владельца): у неё
   * своя вкладка нижней панели и шторка в шапке. Крошек «Главная / Личный
   * кабинет» тоже нет, а «Выйти» стоит ПОСЛЕ всех разделов маленькой кнопкой —
   * в шапке рядом с заголовком оно было самой заметной кнопкой страницы. */
  assert.doesNotMatch(html, /id="account-cart"|id="cart"|acc-cart/);
  assert.doesNotMatch(html, /class="breadcrumb"/);
  assert.match(html, /<\/div>\s*<form method="post" action="\/account\/logout" class="acc-logout"><button class="btn btn-sm" type="submit">Выйти<\/button><\/form>\s*<\/div>/);
  assert.ok(html.indexOf('id="password"') < html.indexOf('class="acc-logout"'), '«Выйти» — после последнего раздела');
  assert.doesNotMatch(html, /acc-head[\s\S]{0,300}\/account\/logout/, 'в шапке кабинета кнопки выхода нет');
  // Подсказка про пароль — без «можно и просто цифры»: минимум и так сказан.
  assert.match(html, /Не короче 6 знаков\.<\/p>/);
  assert.doesNotMatch(html, /можно и просто цифры/);
  assert.match(html, /<meta name="robots" content="noindex/);
  assert.doesNotMatch(html, /data-ym=/, 'счётчика Яндекса в кабинете нет');
  assert.match(html, /<a class="icon-btn account-btn" href="\/account"/, 'значок в шапке без отметки «вошёл»');
  assert.doesNotMatch(html, /is-in/);
  // Кабинет выключен — значка нет вовсе; включён — есть даже у гостя.
  const off = R.homePage(Object.assign({}, settings, { accountsOn: false }), { visibleProducts: () => [], visibleCategories: () => [], ratingFor: () => ({ avg: 0, count: 0 }) }, {});
  assert.doesNotMatch(off, /account-btn/);
  const on = R.homePage(settings, { visibleProducts: () => [], visibleCategories: () => [], ratingFor: () => ({ avg: 0, count: 0 }) }, {});
  assert.match(on, /<a class="icon-btn account-btn" href="\/account" aria-label="Личный кабинет"/);
  assert.equal(YM.pageAllowed('/account/login'), false);
  // Формы входа: регистрация без почты не предлагает восстановление.
  const login = R.accountAuthPage(settings, { mode: 'login', mailOn: false });
  assert.doesNotMatch(login, /Забыли пароль/);
  assert.match(login, /Зарегистрироваться/);
  const reset = R.accountAuthPage(settings, { mode: 'reset', token: 'b'.repeat(32) });
  assert.match(reset, /action="\/account\/reset\/b{32}"/);
  /* ВХОД ЗАНИМАЕТ ЭКРАН ЦЕЛИКОМ и без крошек: блок не ниже высоты окна без
   * шапки (и нижней панели на телефоне — `--tabbar-h`), форма по центру
   * свободного места, все надписи по центру, поле ввода набирается слева. На
   * телефоне у карточки нет рамки — рамка вокруг формы на весь экран читалась
   * бы окном в окне. */
  assert.doesNotMatch(login, /class="breadcrumb"/);
  assert.doesNotMatch(reset, /можно и просто цифры/);
  const css = fs.readFileSync(path.join(ROOT, 'public', 'styles.css'), 'utf8');
  const auth = (css.match(/\n\.acc-auth\{([^}]*)\}/) || [])[1] || '';
  assert.match(auth, /display:flex;flex-direction:column;justify-content:center/);
  assert.match(auth, /text-align:center/);
  assert.match(auth, /min-height:calc\(100dvh - 58px - var\(--tabbar-h,0px\)\)/);
  assert.match(css, /\.acc-auth input\{text-align:start\}/);
  const mobile = css.slice(css.indexOf('@media(max-width:800px){\n  .acc-card{'));
  assert.match(mobile, /\.acc-auth\{min-height:calc\(100vh - 54px\);min-height:calc\(100dvh - 54px - var\(--tabbar-h,0px\)\)/);
  assert.match(mobile, /\.acc-auth-card\{[^}]*border:0;border-radius:0;background:transparent\}/);
  // «Выйти» — маленькая кнопка по центру под разделами, а «Пароль» после
  // снятия корзины идёт во всю ширину сетки, как заказы.
  assert.match(css, /\.acc-logout\{margin:22px 0 0;text-align:center\}/);
  assert.match(css, /\.acc-card#password\{grid-column:1\/-1\}/);
  // Отметка о созданном кабинете — на странице оплаты и на экране «оформлено» одними словами.
  assert.match(R.accountNoteText({ created: true, email: 'b@example.ru' }), /пароль отправили на b@example\.ru/);
  const pay = R.payPage(settings, { id: 'o1', number: 100001, createdAt: now, total: 1000, items: [], payMode: 'own' },
    { methods: [], accountNote: { created: true, email: 'b@example.ru' }, own: { owner: 'ИП', phone: '+79991234567' } });
  assert.match(pay, /class="acc-note"/);
  const app = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');
  assert.match(app, /Мы создали для вас личный кабинет: пароль отправили на ' \+ account\.email/);
  assert.match(app, /function initAccountPage\(\)/);
  assert.match(app, /data-account-email/);
});

test('оформление: поле почты, привязка к вошедшему и отпечаток без почты как прежде', () => {
  const settings = Object.assign(require('../lib/db').defaultSettings(), { storeName: 'Тест' });
  const guest = R.checkoutPage(settings, { account: { auto: true, in: false, email: '', name: '', phone: '' } });
  assert.match(guest, /id="checkout-page"[^>]*data-account="1" data-account-auto="1"/);
  assert.doesNotMatch(guest, /data-account-email|data-account-in/);
  const logged = R.checkoutPage(settings, { account: { auto: true, in: true, email: 'b@example.ru', name: 'Иван Петров', phone: '+79991234567', address: 'г Тула, ул Советская, д 7', addressAt: 1700000000000 } });
  assert.match(logged, /data-account-in="1" data-account-email="b@example\.ru" data-account-name="Иван Петров" data-account-phone="\+79991234567" data-account-address="г Тула, ул Советская, д 7" data-account-address-at="1700000000000"/);
  // Адрес и отметка едут и тогда, когда адреса нет: скрипт читает атрибуты, а не гадает.
  assert.match(R.checkoutPage(settings, { account: { auto: true, in: true, email: 'b@example.ru', name: '', phone: '' } }), /data-account-address="" data-account-address-at="0"/);
  // Кабинет по одному телефону: вошёл — имя, телефон и адрес едут, почта пустая.
  assert.match(R.checkoutPage(settings, { account: { auto: true, in: true, email: '', name: 'Иван', phone: '+79991234567' } }), /data-account-in="1" data-account-email="" data-account-name="Иван" data-account-phone="\+79991234567"/);
  // Маршрут отдаёт их из записи кабинета, а первый заказ вошедшего учит пустой кабинет адресу.
  assert.match(serverSource, /address: customer \? String\(customer\.address \|\| ''\) : '', addressAt: customer \? Number\(customer\.addressAt\) \|\| 0 : 0/);
  assert.match(serverSource, /CUSTOMERS\.create\(\{ email, password, name: order\.customerName, phone: order\.phone, address: order\.address, auto: true \}\)/);
  assert.match(serverSource, /CUSTOMERS\.update\(customer\.id, \{ name: req\.body\.name, email: req\.body\.email, phone: req\.body\.phone, address: req\.body\.address \}\)/);
  assert.match(serverSource, /if \(customer\) \{ CUSTOMERS\.rememberAddress\(customer\.id, order\.address\); CUSTOMERS\.rememberContacts\(customer\.id, \{ email: order\.email, phone: order\.phone \}\); \}/);
  // Политика называет адрес среди данных кабинета: собираем — значит называем.
  assert.match(R.privacyPage(settings, {}), /имя, телефон и адрес доставки из профиля/);
  const off = R.checkoutPage(settings, { account: null });
  assert.doesNotMatch(off, /data-account/);
  const route = serverSource.slice(serverSource.indexOf("app.post('/api/order'"), serverSource.indexOf('/* ============================ ОНЛАЙН-ЧАТ'));
  assert.match(route, /const email = EMAIL\.valid\(emailTyped\)/);
  assert.match(route, /email: email \|\| \(customer \? customer\.email : ''\)/);
  assert.match(route, /customerId: customer \? customer\.id : ''/);
  assert.match(route, /const account = accountForOrder\(req, s, order, customer, email\)/);
  assert.ok(route.indexOf('accountForOrder(') > route.indexOf('rememberOwnOrder(req, order)'), 'кабинет — после того как заказ записан и стал своим');
  const hash = new Function('crypto', 'PROMO', serverSource.slice(serverSource.indexOf('function checkoutRequestHash(body)'), serverSource.indexOf('function rememberOwnOrder')) + '\nreturn checkoutRequestHash;')(require('node:crypto'), require('../lib/promo'));
  assert.equal(hash({ items: [], phone: '+7' }), hash({ items: [], phone: '+7', email: '' }), 'пустая почта не меняет отпечаток прежних запросов');
  assert.notEqual(hash({ items: [], phone: '+7' }), hash({ items: [], phone: '+7', email: 'b@example.ru' }));
  // Уведомление менеджеру и строка заказа в панели показывают почту.
  assert.match(serverSource, /order\.email \? `✉️ E-mail:/);
  assert.match(R.orderClient({ customerName: 'Иван', email: 'b@example.ru' }), /o-contact">b@example\.ru/);
});

test('панель: разделы «Личный кабинет» и «Почта для писем», секреты и перенос сайта', () => {
  const A = require('../lib/admin-views');
  const db = require('../lib/db');
  const base = Object.assign(db.defaultSettings(), { storeName: 'iStore' });
  const fake = { pendingReviewCount: () => 0, getOrders: () => [] };
  let html = A.settingsPage(base, fake, null);
  /* Кабинет и почта — ДВА раздела: полей у почты семь, и вместе с галочкой
   * кабинета они читались одной кучей. Связь между ними держат строки
   * состояния: кабинет говорит, заводится ли он при заказе, почта — уходят ли
   * письма вообще. */
  assert.match(html, /id="set-accounts"/);
  assert.match(html, /id="set-mail"/);
  assert.match(html, /включён · без почты: покупатель регистрируется сам, пароль не восстановить/);
  assert.match(html, /не настроена — письма покупателям не уходят/);
  assert.match(html, /name="mailPass" type="password" value=""/, 'пароль почты в HTML не возвращается');
  assert.match(html, /name="mailTest" value="1"/);
  html = A.settingsPage(Object.assign({}, base, { mailHost: 'smtp.yandex.ru', mailUser: 'shop@yandex.ru', mailPass: 'x' }), fake, null);
  assert.match(html, /письма уходят через smtp\.yandex\.ru/);
  assert.match(html, /включён · кабинет заводится при заказе, пароль уходит письмом/);
  assert.doesNotMatch(html, /value="x"/);
  html = A.settingsPage(Object.assign({}, base, { accountsOn: false }), fake, null);
  assert.match(html, /выключен — значка в шапке нет/);
  const post = serverSource.slice(serverSource.indexOf("app.post('/admin/settings'"), serverSource.indexOf('/* =========================== 404'));
  assert.match(post, /keepOrReplaceSecret\('mailPass', 'clearMailPass', 300\)/);
  assert.match(post, /if \(req\.body\.accountsForm !== undefined\) patch\.accountsOn = req\.body\.accountsOn !== undefined/);
  assert.ok(post.indexOf('MAIL.send(next') > post.indexOf('db.saveSettings(patch)'), 'проверочное письмо идёт после записи настроек');
  // Почта — свойство сайта: при переносе магазина сбрасывается, как ключи касс.
  const importer = fs.readFileSync(path.join(ROOT, 'scripts', 'import-store.js'), 'utf8');
  for (const field of ['mailHost', 'mailUser', 'mailPass', 'mailFrom']) assert.ok(importer.includes(`'${field}'`), field + ' сбрасывается при переносе');
  const exporter = fs.readFileSync(path.join(ROOT, 'scripts', 'export-store.js'), 'utf8');
  assert.doesNotMatch(exporter, /customers\.json/, 'покупатели старого сайта на новый не едут');
  // Политика называет кабинет только когда он включён.
  assert.match(R.privacyPage(base, {}), /Личный кабинет:/);
  assert.doesNotMatch(R.privacyPage(Object.assign({}, base, { accountsOn: false }), {}), /Личный кабинет:/);
  assert.equal(auth.verifyPassword('x', 'y'), false);
});
