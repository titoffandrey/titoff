'use strict';
/* Вход в панель — по e-mail или телефону (lib/admin-login.js).
 *
 * Модуль проверяется напрямую, маршрут входа — вырезкой из server.js в
 * песочнице (тот же приём, что у маршрутов кабинета в account.test.js), а
 * проверка формы настроек — исполнением её собственного блока: правило
 * «не сохранили — скажи, что не так» обязано держаться на боевом коде, а не
 * на его пересказе в тесте. Перенос прежнего логина — на своём каталоге данных.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');

const LOGIN = require('../lib/admin-login');
const EMAIL = require('../lib/email');
const PHONE = require('../public/phone.js');
const auth = require('../lib/auth');
const A = require('../lib/admin-views');

const ROOT = path.join(__dirname, '..');
const serverSource = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');

// Свой lib/db поверх временного каталога — как `freshStore` в account.test.js.
function freshDb(t, seed) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'store-admin-login-'));
  if (seed) fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify(seed));
  const key = require.resolve('../lib/db');
  const cached = require.cache[key];
  const previous = process.env.STORE_DATA_DIR;
  process.env.STORE_DATA_DIR = dir;
  delete require.cache[key];
  const db = require('../lib/db');
  if (cached) require.cache[key] = cached; else delete require.cache[key];
  if (previous === undefined) delete process.env.STORE_DATA_DIR;
  else process.env.STORE_DATA_DIR = previous;
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return { dir, db };
}

test('логин панели приводится к хранимой форме теми же модулями, что почта заказа и телефон покупателя', () => {
  assert.equal(LOGIN.normalize('  Owner@Example.COM '), 'owner@example.com');
  assert.equal(LOGIN.normalize('8 (999) 123-45-67'), '+79991234567');
  assert.equal(LOGIN.normalize('+7 999 123-45-67'), '+79991234567');
  assert.equal(LOGIN.normalize('9991234567'), '+79991234567');
  // Ни адрес, ни номер — пусто: такое не хранится и на входе не проходит.
  for (const junk of ['admin', 'root', '', null, undefined, 'owner@mail', '+7 999', '123', 'ivan@mail.ru\r\nBcc: x@y.z']) {
    assert.equal(LOGIN.normalize(junk), '', JSON.stringify(junk));
  }
  assert.equal(LOGIN.kindOf('Owner@Example.com'), 'email');
  assert.equal(LOGIN.kindOf('89991234567'), 'phone');
  assert.equal(LOGIN.kindOf('admin'), '');
  // Своей проверки у модуля нет — та же, что у заказа и кабинета.
  assert.equal(LOGIN.normalize('Buyer@Example.ru'), EMAIL.valid('Buyer@Example.ru'));
  assert.equal(LOGIN.normalize('8 999 123-45-67'), PHONE.store('8 999 123-45-67'));
});

test('вход принимает e-mail и телефон в любой записи, а прежний логин — только пока новых нет', () => {
  const both = { adminEmail: 'owner@example.com', adminPhone: '+79991234567', adminUsername: 'admin' };
  assert.deepEqual(LOGIN.accepted(both), ['owner@example.com', '+79991234567']);
  assert.equal(LOGIN.configured(both), true);
  assert.equal(LOGIN.legacy(both), '', 'прежний логин не работает, когда задан новый');
  for (const typed of ['Owner@Example.com', 'owner@example.com ', '8 999 123-45-67', '+7 (999) 123-45-67', '+79991234567']) {
    assert.equal(LOGIN.matches(both, typed), true, typed);
  }
  for (const typed of ['admin', 'other@example.com', '+79991234568', '', null]) {
    assert.equal(LOGIN.matches(both, typed), false, JSON.stringify(typed));
  }
  assert.equal(LOGIN.identity(both), 'owner@example.com|+79991234567');
  assert.equal(LOGIN.describe(both), 'owner@example.com · +7 999 123-45-67');

  // Одного логина хватает; второго поля может не быть вовсе (старый файл).
  const mailOnly = { adminEmail: 'owner@example.com', adminUsername: 'admin' };
  assert.equal(LOGIN.matches(mailOnly, 'OWNER@example.com'), true);
  assert.equal(LOGIN.matches(mailOnly, '+79991234567'), false);
  assert.equal(LOGIN.matches(mailOnly, 'admin'), false);
  assert.equal(LOGIN.identity(mailOnly), 'owner@example.com');

  /* Установка со старой версии: e-mail и телефона нет, работает прежний логин
   * как есть — и маркер сессии у неё тот же, что до обновления (`identity`
   * равна самому логину), то есть владельца не выбрасывает из панели. */
  const old = { adminUsername: 'admin' };
  assert.equal(LOGIN.configured(old), false);
  assert.equal(LOGIN.legacy(old), 'admin');
  assert.equal(LOGIN.matches(old, 'admin'), true);
  assert.equal(LOGIN.matches(old, 'Admin'), false, 'прежний логин сверяется как раньше — посимвольно');
  assert.equal(LOGIN.matches(old, 'owner@example.com'), false);
  assert.equal(LOGIN.identity(old), 'admin');
  assert.equal(LOGIN.describe(old), '');
  // Мусор в файле — логин, который не работает, а не работает как попало.
  const junk = { adminEmail: 'owner@mail', adminPhone: '12', adminUsername: 'admin' };
  assert.deepEqual(LOGIN.accepted(junk), []);
  assert.equal(LOGIN.matches(junk, 'admin'), true);
});

test('маршрут входа: e-mail или телефон в любой записи, пароль сверяется всегда', async () => {
  const stored = auth.hashPassword('надёжный-пароль-панели');
  let settings = { storeName: 'Тест', sessionSecret: 's'.repeat(48), adminEmail: 'owner@example.com', adminPhone: '+79991234567', adminUsername: 'admin', adminPasswordHash: stored };
  const handlers = { GET: {}, POST: {} };
  const app = { get: (route, fn) => { handlers.GET[route] = fn; }, post: (route, fn) => { handlers.POST[route] = fn; } };
  const helpers = serverSource.slice(serverSource.indexOf('// Маркер зависит от текущих логинов'), serverSource.indexOf('/* Вошедший покупатель'));
  const routes = serverSource.slice(serverSource.indexOf("app.get('/admin/login'"), serverSource.indexOf('/* Живые обновления: вкладка панели'));
  const failed = [];
  const box = vm.runInNewContext(helpers + '\n' + routes + '\n({ authStamp, adminAuthorized })', {
    app, auth, A, crypto, LOGIN, settings: () => settings,
    loginBlocked: () => false, loginFail: req => failed.push(req.body.username), loginOk: () => {},
    TOO_MANY: 'Слишком много попыток входа. Подождите 15 минут.'
  });
  const login = async (username, password) => {
    const req = { method: 'POST', pathname: '/admin/login', session: {}, body: { username, password }, query: {}, headers: {} };
    const res = { status: 200, html: '', location: '',
      send(html, code) { this.html = String(html); this.status = code || 200; },
      redirect(url) { this.location = url; this.status = 302; } };
    await handlers.POST['/admin/login'](req, res);
    return { res, session: req.session };
  };

  for (const typed of ['Owner@Example.com', '8 (999) 123-45-67', '+7 999 123-45-67']) {
    const { res, session } = await login(typed, 'надёжный-пароль-панели');
    assert.equal(res.status, 302, typed); assert.equal(res.location, '/admin');
    assert.equal(session.admin, box.authStamp(LOGIN.identity(settings), stored));
    assert.equal(box.adminAuthorized({ session }), true, typed + ': сессия проходит guard');
  }
  for (const [typed, password] of [['admin', 'надёжный-пароль-панели'], ['owner@example.com', 'не тот'], ['+79991234568', 'надёжный-пароль-панели'], ['', 'надёжный-пароль-панели']]) {
    const { res, session } = await login(typed, password);
    assert.equal(res.status, 401, typed);
    assert.match(res.html, /Неверный e-mail\/телефон или пароль/);
    assert.equal(session.admin, undefined);
  }
  assert.deepEqual(failed, ['admin', 'owner@example.com', '+79991234568', ''], 'каждый отказ считается попыткой');

  // Смена логина разлогинивает: маркер старой сессии больше не проходит.
  const { session } = await login('owner@example.com', 'надёжный-пароль-панели');
  settings = Object.assign({}, settings, { adminPhone: '+79991234568' });
  assert.equal(box.adminAuthorized({ session }), false);

  // Установка на прежнем логине: «admin» проходит, e-mail — нет, и маркер
  // сессии совпадает со старым расчётом (['admin', логин, хеш]).
  settings = { storeName: 'Тест', sessionSecret: 's'.repeat(48), adminUsername: 'admin', adminPasswordHash: stored };
  const old = await login('admin', 'надёжный-пароль-панели');
  assert.equal(old.res.status, 302);
  const legacyStamp = crypto.createHmac('sha256', settings.sessionSecret).update(['admin', 'admin', stored].join('\0')).digest('base64url').slice(0, 24);
  assert.equal(old.session.admin, legacyStamp, 'маркер прежней установки не меняется от обновления кода');
  assert.equal((await login('owner@example.com', 'надёжный-пароль-панели')).res.status, 401);
});

test('страница входа спрашивает e-mail или телефон, а не «логин»', () => {
  const html = A.loginPage({ storeName: 'Тест' }, null);
  assert.match(html, /<label for="admin-login">E-mail или телефон<\/label><input id="admin-login" name="username" autocomplete="username" autocapitalize="none" spellcheck="false" required autofocus>/);
  assert.doesNotMatch(html, /Логин/);
});

test('форма настроек: логины проверяются до записи, оба пустыми оставить нельзя', () => {
  // Блок исполняется как есть: `fail` бросает своим текстом, `patch` собирает записанное.
  const start = serverSource.indexOf('  /* Доступ в панель: логин — e-mail и телефон');
  const end = serverSource.indexOf('  if (req.body.adminPassword && String(req.body.adminPassword).trim()) {');
  assert.ok(start > -1 && end > start, 'блок проверки логинов не найден');
  const block = new Function('req', 'fail', 'current', 'patch', 'EMAIL', 'PHONE', 'LOGIN', serverSource.slice(start, end) + '\nreturn patch;');
  const run = (body, current) => {
    const patch = {};
    try { return { patch: block({ body }, msg => { throw new Error(msg); }, current, patch, EMAIL, PHONE, LOGIN) }; }
    catch (error) { return { error: error.message }; }
  };
  const configured = { adminEmail: 'owner@example.com', adminPhone: '', adminUsername: 'admin' };
  const legacy = { adminUsername: 'admin' };

  assert.deepEqual(run({ adminEmail: ' Owner@Example.com ', adminPhone: '8 999 123-45-67' }, legacy).patch,
    { adminEmail: 'owner@example.com', adminPhone: '+79991234567' });
  assert.deepEqual(run({ adminEmail: '', adminPhone: '+7 999 123-45-67' }, configured).patch, { adminEmail: '', adminPhone: '+79991234567' });
  assert.match(run({ adminEmail: 'owner@mail', adminPhone: '' }, legacy).error, /E-mail для входа в панель введён с ошибкой/);
  assert.match(run({ adminEmail: '', adminPhone: '+7 999' }, legacy).error, /Телефон для входа в панель введён с ошибкой/);
  // Заданный логин стереть подчистую нельзя: прежний «admin» не возвращается,
  // и «Сохранить» заперло бы панель.
  assert.match(run({ adminEmail: '', adminPhone: '' }, configured).error, /Укажите e-mail или телефон для входа в панель/);
  // А установке на прежнем логине пустые поля законны — он и продолжает работать.
  assert.deepEqual(run({ adminEmail: '', adminPhone: '' }, legacy).patch, { adminEmail: '', adminPhone: '' });
  // Секции нет в теле (частичная форма) — логины не трогаются.
  assert.deepEqual(run({ storeName: 'x' }, configured).patch, {});
  // Прежнего поля формы больше нет, и сервер его не читает.
  assert.doesNotMatch(serverSource, /req\.body\.adminUsername/);
});

test('прежний логин, бывший адресом или номером, переезжает в новое поле сам; «admin» остаётся временным', t => {
  const base = { sessionSecret: 's'.repeat(48), adminPasswordHash: 'x:y' };
  const mail = freshDb(t, Object.assign({ adminUsername: 'Owner@Example.com' }, base));
  mail.db.ensureSeeded();
  let s = mail.db.getSettings();
  assert.equal(s.adminEmail, 'owner@example.com');
  assert.equal(s.adminPhone, '');
  assert.equal(LOGIN.matches(s, 'owner@example.com'), true);
  assert.equal(LOGIN.matches(s, 'Owner@Example.com'), true, 'раньше сравнивалось посимвольно, теперь по адресу');

  const phone = freshDb(t, Object.assign({ adminUsername: '89991234567' }, base));
  phone.db.ensureSeeded();
  s = phone.db.getSettings();
  assert.equal(s.adminPhone, '+79991234567');
  assert.equal(LOGIN.matches(s, '+7 999 123-45-67'), true);

  const plain = freshDb(t, Object.assign({ adminUsername: 'admin' }, base));
  plain.db.ensureSeeded();
  s = plain.db.getSettings();
  assert.equal(s.adminEmail, ''); assert.equal(s.adminPhone, '');
  assert.equal(LOGIN.configured(s), false);
  assert.equal(LOGIN.matches(s, 'admin'), true, 'обновление не запирает панель');

  // Перенос — ровно один раз: заданный владельцем логин старым не перебивается.
  const done = freshDb(t, Object.assign({ adminUsername: 'old@example.com', adminPhone: '+79991234567' }, base));
  done.db.ensureSeeded();
  s = done.db.getSettings();
  assert.equal(s.adminEmail, '');
  assert.equal(LOGIN.matches(s, 'old@example.com'), false);

  // Первый запуск: ADMIN_LOGIN задаёт логин сразу, без него — временный «admin».
  const previous = process.env.ADMIN_LOGIN;
  process.env.ADMIN_LOGIN = '+7 999 123-45-67';
  try {
    const fresh = freshDb(t);
    fresh.db.ensureSeeded();
    s = fresh.db.getSettings();
    assert.equal(s.adminPhone, '+79991234567');
    assert.equal(s.adminEmail, '');
    assert.equal(s.adminUsername, 'admin');
    assert.equal(LOGIN.matches(s, 'admin'), false, 'временный логин не работает рядом с заданным');
  } finally {
    if (previous === undefined) delete process.env.ADMIN_LOGIN; else process.env.ADMIN_LOGIN = previous;
  }
  const bare = freshDb(t);
  bare.db.ensureSeeded();
  s = bare.db.getSettings();
  assert.equal(LOGIN.configured(s), false);
  assert.equal(LOGIN.legacy(s), 'admin');
  assert.deepEqual(bare.db.adminLoginPatch('admin'), {});
});
