'use strict';
/* Почта магазина: SMTP-клиент на встроенных `net` и `tls`.
 *
 * Письма магазин шлёт ровно в двух случаях, и оба — про личный кабинет:
 * пароль покупателю, для которого кабинет завёлся сам при заказе, и ссылка
 * для восстановления пароля. Рассылок здесь нет и не будет — это не почтовая
 * система, а одна дверь наружу с одним назначением.
 *
 * Своя реализация SMTP, а не библиотека: у проекта нет ни одной внешней
 * зависимости, и ради двух писем заводить первую незачем. Протокол простой —
 * приветствие, EHLO, шифрование, логин, конверт, текст, — и умещается в
 * полторы сотни строк. Чего здесь НЕТ намеренно: вложений, HTML, нескольких
 * получателей, очереди с повторами. Письмо не дошло — это видно в логе и в
 * панели, а покупатель в кабинете задаёт пароль сам (см. lib/customers.js).
 *
 * ПАРОЛЬ ПОЧТЫ НЕ УХОДИТ ОТКРЫТЫМ КАНАЛОМ НИКОГДА. Порт 465 — TLS с первого
 * байта; любой другой — STARTTLS, и если сервер его не предлагает, разговор
 * прекращается ДО логина. Сертификат сервера проверяется по системному
 * доверию (`rejectUnauthorized`), как у любого https-запроса проекта.
 *
 * Отправка идёт с боевого сервера: с ним и разговаривает почтовый сервер, и
 * ему же виден IP магазина. Это тот же сервер, который и так ходит в кассы и
 * Telegram, — новой связки «домен → адрес» здесь не появляется.
 */
const net = require('net');
const tls = require('tls');
const crypto = require('crypto');
const EMAIL = require('./email');

// Весь разговор с сервером — не дольше двадцати секунд: подключение, TLS,
// логин и само письмо. Дольше — это не «медленно», а «не отвечает».
const TIMEOUT_MS = 20000;
const PORT_TLS = 465;
const PORT_DEFAULT = 465;
// Ответ сервера не может быть бесконечным: обрываем, если он не помещается.
const REPLY_MAX = 64 * 1024;

function conf(settings) {
  const s = settings || {};
  const host = String(s.mailHost || '').trim().toLowerCase();
  const rawPort = Number(String(s.mailPort == null ? '' : s.mailPort).trim());
  const port = Number.isInteger(rawPort) && rawPort > 0 && rawPort < 65536 ? rawPort : PORT_DEFAULT;
  const user = String(s.mailUser || '').trim();
  const pass = String(s.mailPass || '');
  // Адрес отправителя. Пусто — берётся логин, если он сам похож на адрес:
  // у большинства почтовых служб логин и есть ящик.
  const from = EMAIL.valid(s.mailFrom) || EMAIL.valid(user);
  const fromName = String(s.mailFromName || s.storeName || '').trim().slice(0, 80);
  return { host, port, user, pass, from, fromName, secure: port === PORT_TLS };
}

// Настроена ли почта: без сервера и адреса отправителя письмо не собрать.
function configured(settings) {
  const c = conf(settings);
  return !!(c.host && /^[a-z0-9.-]+$/.test(c.host) && c.from);
}

/* ---------------- Кодирование заголовков и тела ---------------- */

// Слово заголовка по RFC 2047. Латиница уходит как есть; всё остальное —
// base64 кусками не длиннее 75 знаков, разделёнными переносом с пробелом
// (так письмо не ломается у серверов, которые режут длинные заголовки).
function encodeWord(text) {
  const value = String(text == null ? '' : text).replace(/[\r\n]+/g, ' ').trim();
  if (!value) return '';
  if (/^[\x20-\x7e]*$/.test(value) && !/[=?]/.test(value)) return value;
  const words = [];
  let chunk = '';
  for (const ch of value) {
    if (Buffer.byteLength(chunk + ch, 'utf8') > 45) { words.push(chunk); chunk = ''; }
    chunk += ch;
  }
  if (chunk) words.push(chunk);
  return words.map(w => '=?UTF-8?B?' + Buffer.from(w, 'utf8').toString('base64') + '?=').join('\r\n ');
}
// Имя отправителя перед адресом: латиницу берём в кавычки, остальное кодируем.
function displayName(name) {
  const value = String(name || '').replace(/[\r\n"]+/g, ' ').trim();
  if (!value) return '';
  if (/^[\x20-\x7e]*$/.test(value)) return '"' + value + '"';
  return encodeWord(value);
}
function base64Lines(text) {
  const b64 = Buffer.from(String(text == null ? '' : text), 'utf8').toString('base64');
  return b64.replace(/(.{76})/g, '$1\r\n');
}

/* Собрать письмо целиком: заголовки и тело. Тело всегда base64 — так ни
 * кириллица, ни строка из одной точки (конец DATA у SMTP) не требуют особого
 * обращения. Текст здесь только простой: покупателю нужен пароль и ссылка, а
 * не вёрстка. */
function compose(c, mail) {
  const to = EMAIL.valid(mail && mail.to);
  if (!to) throw new Error('bad_to');
  const subject = encodeWord(mail.subject || '');
  const fromName = displayName(c.fromName);
  const id = crypto.randomBytes(12).toString('hex') + '@' + (c.from.split('@')[1] || 'localhost');
  const headers = [
    `From: ${fromName ? fromName + ' ' : ''}<${c.from}>`,
    `To: <${to}>`,
    `Subject: ${subject}`,
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: <${id}>`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: base64',
    // Письмо служебное: автоответчики на той стороне не должны отвечать на него.
    'Auto-Submitted: auto-generated'
  ];
  return { to, data: headers.join('\r\n') + '\r\n\r\n' + base64Lines(mail.text || '') + '\r\n' };
}

/* ---------------- Разговор по SMTP ---------------- */

class SmtpError extends Error {
  constructor(code, message, reply) {
    super(message);
    this.code = code;       // net · timeout · tls · auth · refused · protocol
    this.reply = reply || '';
  }
}

/* Обёртка над сокетом: читает ответы сервера построчно и умеет дождаться
 * ЦЕЛОГО ответа — у SMTP он бывает многострочным («250-…», последняя строка
 * «250 …»). Кодировку сокету НЕ задаём: при STARTTLS тот же сокет оборачивается
 * в TLS, и строки вместо байтов сломали бы шифрование. Ответы SMTP — ASCII,
 * поэтому `latin1` их читает без потерь. */
class Conn {
  constructor(socket, deadline) {
    this.socket = socket;
    this.deadline = deadline;
    this.buffer = '';
    this.pending = null;
    this.dead = null;
    socket.on('data', chunk => {
      this.buffer += chunk.toString('latin1');
      if (this.buffer.length > REPLY_MAX) return this.fail(new SmtpError('protocol', 'ответ сервера слишком длинный'));
      this.flush();
    });
    socket.on('error', e => this.fail(new SmtpError('net', 'ошибка соединения: ' + (e && e.message || e))));
    socket.on('close', () => this.fail(new SmtpError('net', 'соединение закрыто сервером')));
  }
  fail(error) {
    if (this.dead) return;
    this.dead = error;
    if (this.pending) { const p = this.pending; this.pending = null; p.reject(error); }
  }
  detach() {
    this.dead = new SmtpError('net', 'сокет передан TLS');
    this.socket.removeAllListeners('data');
    this.socket.removeAllListeners('error');
    this.socket.removeAllListeners('close');
  }
  flush() {
    if (!this.pending) return;
    const lines = this.buffer.split('\r\n');
    // Последний элемент — недописанная строка (или пусто после «\r\n»).
    for (let i = 0; i < lines.length - 1; i++) {
      if (/^\d{3}(?: |$)/.test(lines[i])) {
        const reply = lines.slice(0, i + 1);
        this.buffer = lines.slice(i + 1).join('\r\n');
        const p = this.pending; this.pending = null;
        p.resolve({ code: Number(reply[reply.length - 1].slice(0, 3)), lines: reply, text: reply.join('\n') });
        return;
      }
      if (!/^\d{3}-/.test(lines[i])) {
        return this.fail(new SmtpError('protocol', 'непонятный ответ сервера: ' + lines[i].slice(0, 120)));
      }
    }
  }
  read() {
    if (this.dead) return Promise.reject(this.dead);
    return new Promise((resolve, reject) => { this.pending = { resolve, reject }; this.flush(); });
  }
  write(line) {
    if (this.dead) return Promise.reject(this.dead);
    return new Promise((resolve, reject) => this.socket.write(line + '\r\n', e => (e ? reject(new SmtpError('net', 'не удалось отправить команду')) : resolve())));
  }
  async command(line, expected, failCode) {
    await this.write(line);
    const reply = await this.read();
    if (!expected.includes(reply.code)) throw new SmtpError(failCode || 'protocol', replyMessage(reply), reply.text);
    return reply;
  }
}

function replyMessage(reply) {
  const last = reply.lines[reply.lines.length - 1] || '';
  return 'сервер ответил: ' + last.slice(0, 160);
}

function connect(c, deadline) {
  return new Promise((resolve, reject) => {
    /* `ca` — только для тестов с поддельным сервером и своим сертификатом:
     * `conf()` его не задаёт никогда, и боевой сертификат проверяется по
     * системному доверию. */
    const socket = c.secure
      ? tls.connect({ host: c.host, port: c.port, servername: c.host, rejectUnauthorized: true, ca: c.ca || undefined })
      : net.connect({ host: c.host, port: c.port });
    const ready = c.secure ? 'secureConnect' : 'connect';
    socket.setNoDelay(true);
    socket.once(ready, () => { socket.removeListener('error', onError); resolve(socket); });
    const onError = e => reject(new SmtpError(c.secure && /certificate|CERT|self signed|altname/i.test(String(e && e.message)) ? 'tls' : 'net',
      'не удалось подключиться к ' + c.host + ':' + c.port + ' — ' + (e && e.message || e)));
    socket.once('error', onError);
    const left = deadline - Date.now();
    socket.setTimeout(Math.max(1000, left), () => socket.destroy(new Error('таймаут')));
  });
}

function upgrade(socket, host, ca) {
  return new Promise((resolve, reject) => {
    const secure = tls.connect({ socket, servername: host, rejectUnauthorized: true, ca: ca || undefined });
    secure.once('secureConnect', () => { secure.removeListener('error', onError); resolve(secure); });
    const onError = e => reject(new SmtpError('tls', 'не удалось включить шифрование: ' + (e && e.message || e)));
    secure.once('error', onError);
  });
}

// Что сервер умеет — из ответа на EHLO: «250-STARTTLS», «250-AUTH PLAIN LOGIN».
function capabilities(reply) {
  const caps = { starttls: false, auth: [] };
  for (const line of reply.lines.slice(1)) {
    const text = line.slice(4).trim().toUpperCase();
    if (text === 'STARTTLS') caps.starttls = true;
    if (text.startsWith('AUTH ')) caps.auth.push(...text.slice(5).split(/[\s=]+/).filter(Boolean));
  }
  return caps;
}

// Имя, которым представляемся в EHLO. Своё доменное имя процесс не знает
// (домен — забота прокси), а серверу оно и не важно: годится любое.
const EHLO_NAME = 'apple-store';

/* Один сеанс: подключиться, зашифровать, войти и, если есть письмо, отправить.
 * Без письма это проверка настроек — тот же путь до самого DATA, поэтому
 * «связь есть» здесь значит ровно то же, что и при настоящей отправке. */
async function session(c, mail) {
  const deadline = Date.now() + TIMEOUT_MS;
  const composed = mail ? compose(c, mail) : null;
  let socket = await connect(c, deadline);
  let conn = new Conn(socket, deadline);
  const timer = setTimeout(() => conn.fail(new SmtpError('timeout', 'сервер не ответил за ' + (TIMEOUT_MS / 1000) + ' секунд')), TIMEOUT_MS);
  try {
    const greeting = await conn.read();
    if (greeting.code !== 220) throw new SmtpError('refused', replyMessage(greeting), greeting.text);
    let ehlo = await conn.command('EHLO ' + EHLO_NAME, [250]);
    let caps = capabilities(ehlo);
    if (!c.secure) {
      // Без STARTTLS дальше не идём: логин и пароль ушли бы открытым текстом.
      if (!caps.starttls) throw new SmtpError('tls', 'сервер не предлагает STARTTLS — используйте порт 465 или другой сервер');
      await conn.command('STARTTLS', [220], 'tls');
      conn.detach();
      socket = await upgrade(socket, c.host, c.ca);
      conn = new Conn(socket, deadline);
      // После шифрования сервер обязан услышать EHLO заново — его возможности
      // (в том числе AUTH) объявляются только внутри защищённого канала.
      ehlo = await conn.command('EHLO ' + EHLO_NAME, [250]);
      caps = capabilities(ehlo);
    }
    if (c.user) {
      if (caps.auth.includes('PLAIN') || !caps.auth.includes('LOGIN')) {
        const token = Buffer.from('\0' + c.user + '\0' + c.pass, 'utf8').toString('base64');
        await conn.command('AUTH PLAIN ' + token, [235], 'auth');
      } else {
        await conn.command('AUTH LOGIN', [334], 'auth');
        await conn.command(Buffer.from(c.user, 'utf8').toString('base64'), [334], 'auth');
        await conn.command(Buffer.from(c.pass, 'utf8').toString('base64'), [235], 'auth');
      }
    }
    if (composed) {
      await conn.command('MAIL FROM:<' + c.from + '>', [250], 'refused');
      await conn.command('RCPT TO:<' + composed.to + '>', [250, 251], 'refused');
      await conn.command('DATA', [354], 'refused');
      // Письмо целиком; конец — одиночная точка на своей строке.
      await conn.command(composed.data + '.', [250], 'refused');
    }
    // QUIT — вежливость, а не условие: письмо уже принято, и молчание сервера
    // на прощание ничего не отменяет.
    try { await conn.command('QUIT', [221]); } catch (e) { /* уже отправлено */ }
    return { ok: true, to: composed ? composed.to : '' };
  } finally {
    clearTimeout(timer);
    conn.detach();
    socket.destroy();
  }
}

/* Отправить письмо. Отклоняется `SmtpError` с полем `code`; текст ошибки
 * рассчитан на владельца в панели, а не на покупателя. */
async function send(settings, mail) {
  const c = conf(settings);
  if (!configured(settings)) throw new SmtpError('config', 'почта не настроена: нужны сервер и адрес отправителя');
  return session(c, mail);
}
// Проверка настроек без письма: тот же путь до конверта.
async function verify(settings) {
  const c = conf(settings);
  if (!configured(settings)) throw new SmtpError('config', 'почта не настроена: нужны сервер и адрес отправителя');
  return session(c, null);
}

// Что сказать владельцу про отказ — по коду, а не по тексту сервера.
function explain(error) {
  const code = error && error.code;
  const detail = error && error.message ? ' (' + String(error.message).slice(0, 200) + ')' : '';
  switch (code) {
    case 'auth': return 'почтовый сервер не принял логин или пароль' + detail;
    case 'net': return 'почтовый сервер недоступен' + detail;
    case 'tls': return 'не удалось установить шифрованное соединение' + detail;
    case 'timeout': return 'почтовый сервер не ответил вовремя' + detail;
    case 'refused': return 'почтовый сервер отклонил письмо' + detail;
    case 'config': return String(error.message);
    case 'bad_to': return 'адрес получателя введён с ошибкой';
    default: return 'не удалось отправить письмо' + detail;
  }
}

module.exports = { configured, conf, send, verify, explain, compose, encodeWord, capabilities, session, SmtpError, TIMEOUT_MS, PORT_TLS };
