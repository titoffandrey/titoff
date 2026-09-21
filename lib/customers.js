'use strict';
/* Личный кабинет покупателя: учётные записи.
 *
 * Покупатель входит ПО E-MAIL ИЛИ ПО НОМЕРУ ТЕЛЕФОНА и паролю (просьба
 * владельца, 22 сентября 2026) и видит свои заказы и отправления. Логинов у
 * записи два — `email` и `phone`, — хватает любого; введённое на входе
 * приводится к хранимой форме теми же модулями, что почта заказа и телефон
 * покупателя (адрес нижним регистром, номер в E.164), поэтому «Owner@Mail.ru»
 * и «8 999 123-45-67» узнаются как свои. Телефон при этом остался и полем
 * профиля — тем же, что подставляется в оформление; логином его делает только
 * уникальность: один номер — один кабинет (см. `byPhone`). Записи лежат своим
 * файлом `customers.json` — рядом с заказами, но отдельно от них: это ЛЮДИ, а
 * не заявки, и при переносе магазина на другой сервер (scripts/export-store.js)
 * они не едут так же, как заказы и переписка.
 *
 * Пароль хранится хешем (scrypt, lib/auth.js) — тем же, что у панели. Сам
 * пароль владелец хочет простой: шесть знаков, хоть одни цифры. Это его
 * решение о пороге входа для покупателей, и хеш от этого не становится
 * лишним: файл с шестизначными паролями открытым текстом — это список
 * паролей, которыми люди пользуются и в других местах.
 *
 * КАБИНЕТ ЗАВОДИТСЯ САМ ПРИ ЗАКАЗЕ. Покупатель указал почту на оформлении —
 * учётная запись создаётся тут же, сессия уже вошедшая, а пароль уходит ему
 * письмом (lib/mail.js). Такая запись помечена `autoPassword`: пароля
 * человек не выбирал и знает его только из письма. Пока отметка стоит, в
 * кабинете он вправе задать свой пароль, не называя присланного, — письмо
 * могло не дойти, а запирать покупателя в его же кабинете из-за чужого
 * почтового сервера нельзя. Отметка снимается первым же входом по паролю или
 * его сменой: с этого момента пароль — его, и менять его без старого нельзя.
 *
 * ВОССТАНОВЛЕНИЕ — ССЫЛКОЙ, А НЕ НОВЫМ ПАРОЛЕМ ПИСЬМОМ. Соблазн выслать новый
 * пароль велик (так уже сделано при заказе), но там письмо создаёт запись, а
 * здесь меняло бы существующую: любой, кто знает чужой адрес, сбрасывал бы
 * чужой пароль раз за разом, и владелец ящика терял бы вход каждый раз, когда
 * кому-то вздумается. Ссылка (`resetToken`, час жизни) ничего не меняет, пока
 * по ней не пришли, — а прийти по ней может только тот, кому доставлено письмо.
 */
const crypto = require('crypto');
const db = require('./db');
const auth = require('./auth');
const EMAIL = require('./email');
const PHONE = require('../public/phone.js');
const ADDRESS = require('./address');

const PASSWORD_MIN = 6;
const PASSWORD_MAX = 200;
const RESET_TTL = 60 * 60 * 1000;
// Потолок числа записей: файл читается целиком, и расти без предела ему нельзя.
// Сто тысяч покупателей — это уже не этот магазин.
const MAX_CUSTOMERS = 100000;
// Символы автоматического пароля: без нулей, единиц, «l» и «o» — их путают,
// набирая пароль с письма на телефоне. Восемь таких знаков — тридцать девять
// бит, для кабинета с заказами достаточно.
const PASSWORD_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';
const PASSWORD_LENGTH = 8;

function list() { return db.readJson('customers', []); }
function save(all) { db.writeJson('customers', all); }

/* Индекс по id, по адресу и по телефону. Ключ актуальности — ССЫЛКА на массив
 * из хранилища, тот же приём, что у индекса отзывов: `readJson` отдаёт один и
 * тот же объект, пока не изменился файл, поэтому кэш протухает вместе с ним
 * сам. Спрашивают его на каждой странице витрины (кто вошёл?), и перебирать
 * список ради этого незачем.
 *
 * ТЕЛЕФОН — ЛОГИН, ТОЛЬКО ПОКА ОН ОДИН. Записи, сделанные до того, как он стал
 * логином, могли получить один номер на двоих (два кабинета с разной почтой
 * из заказов одного человека); отдать такой номер первому попавшемуся значило
 * бы пустить в чужой кабинет. Номер, который встретился дважды, помечается
 * `SHARED` и на вход не годится — у обоих остаётся почта. Новые записи один
 * номер на двоих не получают: `create()` и `update()` это проверяют. */
const SHARED = Symbol('shared-phone');
let _index = { src: null, byId: new Map(), byEmail: new Map(), byPhone: new Map() };
function index() {
  const all = list();
  if (_index.src === all) return _index;
  const byId = new Map(), byEmail = new Map(), byPhone = new Map();
  for (const c of all) {
    if (!c || typeof c !== 'object') continue;
    byId.set(String(c.id), c);
    const email = EMAIL.norm(c.email);
    if (email && !byEmail.has(email)) byEmail.set(email, c);
    const phone = PHONE.store(c.phone);
    if (phone) byPhone.set(phone, byPhone.has(phone) ? SHARED : c);
  }
  _index = { src: all, byId, byEmail, byPhone };
  return _index;
}

function byId(id) {
  const key = String(id || '');
  return key ? (index().byId.get(key) || null) : null;
}
function byEmail(email) {
  const key = EMAIL.norm(email);
  return key ? (index().byEmail.get(key) || null) : null;
}
function byPhone(phone) {
  const key = PHONE.store(phone);
  const found = key ? index().byPhone.get(key) : null;
  return found && found !== SHARED ? found : null;
}
// Занят ли номер КЕМ-ТО ЕЩЁ (включая номер на двоих) — для проверок формы.
function phoneTakenBy(phone, ownId) {
  const key = PHONE.store(phone);
  const found = key ? index().byPhone.get(key) : null;
  if (!found) return false;
  return found === SHARED || String(found.id) !== String(ownId || '');
}

/* Логин — то, что набрали в поле «E-mail или телефон». Признак адреса — «@»:
 * номер его не содержит никогда, адрес — всегда. Приводится к хранимой форме
 * теми же модулями, что почта заказа и телефон покупателя; не адрес и не
 * номер — пустая строка. */
function loginKey(value) {
  const raw = String(value == null ? '' : value).trim();
  if (!raw) return '';
  return raw.includes('@') ? EMAIL.valid(raw) : PHONE.store(raw);
}
function loginKind(value) {
  const key = loginKey(value);
  return !key ? '' : (key.includes('@') ? 'email' : 'phone');
}
function byLogin(value) {
  const key = loginKey(value);
  if (!key) return null;
  return key.includes('@') ? byEmail(key) : byPhone(key);
}
// Логин словами — для шапки кабинета, письма и подсказок: адрес как есть,
// номер с разделителями; оба сразу — через точку.
function loginText(c) {
  if (!c) return '';
  const phone = String(c.phone || '');
  return [String(c.email || ''), phone ? (PHONE.format(phone) || phone) : ''].filter(Boolean).join(' · ');
}

// Что не так с паролем. Пустая строка — всё в порядке.
function passwordProblem(value) {
  const password = String(value == null ? '' : value);
  if (!password.trim()) return `Задайте пароль — не короче ${PASSWORD_MIN} знаков`;
  if (password.length < PASSWORD_MIN) return `Пароль слишком короткий — нужно не меньше ${PASSWORD_MIN} знаков`;
  if (password.length > PASSWORD_MAX) return 'Пароль слишком длинный';
  return '';
}

function generatePassword() {
  const bytes = crypto.randomBytes(PASSWORD_LENGTH);
  let out = '';
  for (let i = 0; i < PASSWORD_LENGTH; i++) out += PASSWORD_ALPHABET[bytes[i] % PASSWORD_ALPHABET.length];
  return out;
}

// Что из записи можно показывать и отдавать наружу — без хеша и без ключей.
function publicView(c) {
  if (!c) return null;
  return {
    id: String(c.id), email: String(c.email || ''), name: String(c.name || ''),
    phone: String(c.phone || ''), address: String(c.address || ''), addressAt: Number(c.addressAt) || 0,
    createdAt: Number(c.createdAt) || 0,
    autoPassword: !!c.autoPassword, lastLoginAt: Number(c.lastLoginAt) || 0
  };
}

/* Завести запись. Логин — `login` («E-mail или телефон» с формы регистрации)
 * либо `email` и `phone` порознь (кабинет при заказе); хватает любого одного.
 * `auto` — кабинет создан при заказе, пароль ушёл письмом: такой запрос обязан
 * пройти по почте, и номер заказа, уже занятый другим кабинетом, просто не
 * записывается — кабинет от этого не хуже, а два кабинета на один номер нельзя.
 * Возвращает `{ok, customer}` либо `{ok:false, error}` со словами для формы. */
function create(data) {
  const d = data || {};
  const typed = String(d.login == null ? '' : d.login).trim();
  const kind = typed ? loginKind(typed) : '';
  if (typed && !kind) return { ok: false, error: 'Укажите e-mail или номер телефона — например, mail@example.ru или +7 999 123-45-67' };
  const emailRaw = kind === 'email' ? typed : String(d.email == null ? '' : d.email).trim();
  const phoneRaw = kind === 'phone' ? typed : String(d.phone == null ? '' : d.phone).trim();
  const email = EMAIL.valid(emailRaw);
  if (emailRaw && !email) return { ok: false, error: 'Укажите e-mail — адрес вида mail@example.ru' };
  let phone = PHONE.store(phoneRaw);
  if (phoneRaw && !phone && !d.auto) return { ok: false, error: PHONE.check(phoneRaw).error || 'Телефон введён с ошибкой' };
  if (!email && !phone) return { ok: false, error: 'Укажите e-mail или номер телефона' };
  const problem = passwordProblem(d.password);
  if (problem) return { ok: false, error: problem };
  if (email && byEmail(email)) return { ok: false, error: 'Кабинет с этой почтой уже есть — войдите в него', exists: true };
  if (phone && phoneTakenBy(phone, '')) {
    if (!d.auto) return { ok: false, error: 'Кабинет с этим номером уже есть — войдите в него', exists: true };
    phone = '';
  }
  const all = list();
  if (all.length >= MAX_CUSTOMERS) return { ok: false, error: 'Регистрация сейчас недоступна' };
  // Адрес при создании не проверяется: сюда он приходит только из заказа, а
  // тот уже прошёл `checkAddress` на оформлении. Форма регистрации адреса не
  // спрашивает вовсе.
  const address = ADDRESS.normalize(d.address);
  const customer = {
    id: db.newId(),
    email,
    passHash: auth.hashPassword(String(d.password)),
    name: String(d.name || '').trim().slice(0, 120),
    phone,
    address,
    addressAt: address ? Date.now() : 0,
    autoPassword: !!d.auto,
    createdAt: Date.now(),
    lastLoginAt: 0
  };
  all.push(customer);
  save(all);
  return { ok: true, customer };
}

/* Вход: запись по e-mail или телефону и совпавший пароль. Хеш сверяется
 * асинхронно — scrypt на единственном потоке магазина считать синхронно
 * нельзя, витрина стояла бы на каждой попытке входа. Чужого логина от
 * неверного пароля ответ не отличает: иначе по форме входа перебирали бы, кто
 * здесь покупал. */
const DUMMY_HASH = auth.hashPassword('dummy-password');
async function verify(login, password) {
  const customer = byLogin(login);
  if (!customer) {
    // Время ответа выравниваем: без записи хеш не считался бы вовсе, и по
    // задержке было бы видно, есть ли такой логин.
    await auth.verifyPasswordAsync(String(password || ''), DUMMY_HASH);
    return null;
  }
  const ok = await auth.verifyPasswordAsync(String(password || ''), customer.passHash);
  return ok ? customer : null;
}

// Отметить вход по паролю: с этого момента пароль — свой, а не присланный.
function touchLogin(id) {
  return patch(id, c => { c.lastLoginAt = Date.now(); c.autoPassword = false; });
}

function patch(id, fn) {
  const all = list();
  const i = all.findIndex(c => c && String(c.id) === String(id));
  if (i < 0) return null;
  const next = Object.assign({}, all[i]);
  fn(next);
  all[i] = next;
  save(all);
  return next;
}

/* Сменить пароль. Снимает и `autoPassword`, и ссылку восстановления: прежняя
 * ссылка после смены пароля никому не нужна, а лежать заряженной час она не
 * должна. */
function setPassword(id, password) {
  const problem = passwordProblem(password);
  if (problem) return { ok: false, error: problem };
  const customer = patch(id, c => {
    c.passHash = auth.hashPassword(String(password));
    c.autoPassword = false;
    delete c.resetToken; delete c.resetUntil;
  });
  return customer ? { ok: true, customer } : { ok: false, error: 'Кабинет не найден' };
}

/* Имя, e-mail, телефон и адрес доставки — профиль. Имя, телефон и адрес
 * подставляются в оформление заказа; e-mail и телефон — ещё и логины, поэтому
 * их правят с оглядкой: занятый другим кабинетом не запишется, а стереть оба
 * нельзя — без логина в кабинет не войти. Проверка идёт ДО записи и называет,
 * что не так, как во всех формах магазина.
 *
 * Адрес проверяется ТОЙ ЖЕ `checkAddress`, что и на оформлении: сохранить
 * «Екатеринбург» и узнать, что его не хватает, только нажав «Оплатить», —
 * хуже, чем услышать это сразу, в кабинете. Пустой адрес законен — поле
 * необязательное. Меняется он с отметкой времени `addressAt`: по ней
 * оформление решает, что подставлять — адрес из кабинета или тот, что
 * покупатель набирал на самом оформлении (см. `initCheckoutMemory` в
 * public/app.js: побеждает то, что менялось позже). */
function update(id, data) {
  const d = data || {};
  const current = byId(id);
  if (!current) return { ok: false, error: 'Кабинет не найден' };
  const phoneRaw = String(d.phone == null ? '' : d.phone).trim();
  const phone = phoneRaw ? PHONE.store(phoneRaw) : '';
  if (phoneRaw && !phone) return { ok: false, error: PHONE.check(phoneRaw).error || 'Телефон введён с ошибкой' };
  if (phone && phoneTakenBy(phone, id)) return { ok: false, error: 'Этот номер уже привязан к другому кабинету' };
  const emailRaw = String(d.email == null ? '' : d.email).trim();
  const email = emailRaw ? EMAIL.valid(emailRaw) : '';
  if (emailRaw && !email) return { ok: false, error: 'Укажите e-mail — адрес вида mail@example.ru' };
  const emailOwner = email ? byEmail(email) : null;
  if (emailOwner && String(emailOwner.id) !== String(id)) return { ok: false, error: 'Этот e-mail уже привязан к другому кабинету' };
  const nextEmail = d.email === undefined ? String(current.email || '') : email;
  const nextPhone = d.phone === undefined ? String(current.phone || '') : phone;
  if (!nextEmail && !nextPhone) return { ok: false, error: 'Оставьте хотя бы один способ входа — e-mail или телефон' };
  const address = d.address === undefined ? undefined : ADDRESS.normalize(d.address);
  if (address) {
    const check = ADDRESS.checkAddress(address);
    if (!check.ok) return { ok: false, error: check.error };
  }
  const customer = patch(id, c => {
    if (d.name !== undefined) c.name = String(d.name || '').trim().slice(0, 120);
    if (d.email !== undefined) c.email = email;
    if (d.phone !== undefined) c.phone = phone;
    if (address !== undefined && address !== String(c.address || '')) {
      c.address = address;
      c.addressAt = Date.now();
    }
  });
  return customer ? { ok: true, customer } : { ok: false, error: 'Кабинет не найден' };
}

/* Адрес из заказа — в кабинет, у которого адреса ещё нет. Кабинет учится
 * адресу с первого заказа, как при автосоздании берёт имя и телефон, а дальше
 * адрес принадлежит покупателю: заказ на другой адрес (подарок, чужой город)
 * сохранённый не перебивает — менять его можно только в самом кабинете.
 * Записи нет, адреса нет или он уже задан — не пишем ничего. */
function rememberAddress(id, value) {
  const address = ADDRESS.normalize(value);
  const current = byId(id);
  if (!current || !address || String(current.address || '')) return null;
  return patch(id, c => { c.address = address; c.addressAt = Date.now(); });
}
/* Почта и телефон из заказа — в кабинет, у которого их ещё нет: кабинет,
 * заведённый по телефону, с первого же заказа с почтой получает и её (а с ней
 * — восстановление пароля письмом), и наоборот. Заданное не перебивается, а
 * занятое другим кабинетом не берётся: логин один на кабинет. */
function rememberContacts(id, data) {
  const d = data || {};
  const current = byId(id);
  if (!current) return null;
  const email = !String(current.email || '') ? EMAIL.valid(d.email) : '';
  const phone = !String(current.phone || '') ? PHONE.store(d.phone) : '';
  const addEmail = email && !byEmail(email) ? email : '';
  const addPhone = phone && !phoneTakenBy(phone, id) ? phone : '';
  if (!addEmail && !addPhone) return null;
  return patch(id, c => { if (addEmail) c.email = addEmail; if (addPhone) c.phone = addPhone; });
}

// Ключ восстановления: 128 бит, час жизни. Новый вызов заменяет прежний.
function issueReset(id) {
  const token = crypto.randomBytes(16).toString('hex');
  const customer = patch(id, c => { c.resetToken = token; c.resetUntil = Date.now() + RESET_TTL; });
  return customer ? token : '';
}
function byResetToken(token) {
  const key = String(token || '');
  if (!/^[a-f0-9]{32}$/.test(key)) return null;
  const now = Date.now();
  for (const c of list()) {
    if (!c || c.resetToken !== key) continue;
    if (!(Number(c.resetUntil) > now)) return null;
    return c;
  }
  return null;
}

/* Отметка сессии, привязанная к текущему хешу пароля: сменил пароль (сам или
 * по ссылке восстановления) — все прежние сессии перестают проходить. Тот же
 * приём, что у `authStamp` панели, и по той же причине: ссылка восстановления
 * нужна и тому, у кого кабинет увели, а без отметки чужая сессия жила бы
 * дальше. */
function stamp(customer, secret) {
  if (!customer || !customer.id) return '';
  return crypto.createHmac('sha256', String(secret || ''))
    .update(['customer', String(customer.id), String(customer.passHash || '')].join('\0'))
    .digest('base64url').slice(0, 24);
}

function count() { return list().length; }

// Включён ли кабинет на этой витрине. Поля нет вовсе — включён: так кабинет
// появляется у обоих сайтов сразу, а выключается настройкой того, кому не нужен.
function enabled(settings) { return !!settings && settings.accountsOn !== false; }

module.exports = {
  PASSWORD_MIN, PASSWORD_MAX, RESET_TTL,
  byId, byEmail, byPhone, byLogin, loginKey, loginKind, loginText, create, verify, touchLogin, setPassword, update, rememberAddress, rememberContacts,
  issueReset, byResetToken, stamp, passwordProblem, generatePassword, publicView, count, enabled
};
