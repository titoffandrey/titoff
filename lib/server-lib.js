'use strict';
/*
 * Мини-фреймворк на встроенных модулях Node (http, crypto, fs).
 * Заменяет express + cookie-session + multer, чтобы у проекта не было НИ ОДНОЙ внешней зависимости.
 * Возможности: роутинг с :параметрами, парсинг json/urlencoded/multipart (с загрузкой файлов),
 * отдача статики, подписанные cookie-сессии.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');
const { URL } = require('url');
// Снятие комментариев со статики на отдаче: в исходниках они остаются, в
// браузер не уезжают. Единственная правка, которую мы делаем над файлом.
const MINIFY = require('./minify');

// Заголовки безопасности и приватности на каждый ответ.
// CSP разрешает только собственные ресурсы (никаких сторонних скриптов/трекеров); 'unsafe-inline'
// нужен для встроенных обработчиков и стилей самого приложения. Внешних запросов из браузера нет.
const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'X-XSS-Protection': '0',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=()',
  /* `img-src` разрешает ещё и `blob:` — ради превью снимка, который покупатель
   * приложил к сообщению в чате, но ещё не отправил. Плитка над полем ввода
   * показывается по `URL.createObjectURL(file)`, и без этой схемы она молча
   * оставалась серым квадратом: CSP рубит blob-адреса так же, как внешние.
   *
   * Послаблением это не является. `blob:` — не сеть: такой адрес создаёт только
   * скрипт САМОЙ страницы и только из данных, которые у неё уже есть (здесь —
   * из файла, который человек сам и выбрал). Ни новой двери наружу, ни способа
   * подтянуть чужой ресурс это не даёт; альтернатива — `data:`-строка на
   * шестимегабайтный снимок прямо в разметке, что вчетверо дороже по памяти.
   *
   * `frame-src` — единственное место, где наружу открыт чужой хост: карта
   * Яндекса на странице «О компании». Открыт он УЗКО и осознанно:
   *
   *   — только `frame-src`, то есть чужой документ во фрейме. Ни скриптов
   *     (`script-src`), ни картинок, ни `connect-src` оттуда мы не разрешаем:
   *     собственный код страницы остаётся своим, а фрейм живёт в своём origin и
   *     до него не дотягивается;
   *   — поддомены нужны потому, что виджет вправе увести фрейм редиректом на
   *     свой хост, а `frame-src` проверяет и редиректы — иначе карта молча
   *     осталась бы пустым прямоугольником;
   *   — и главное: фрейм НЕ появляется сам. До нажатия «Показать карту» на
   *     странице нет ни одного яндексовского адреса, поэтому обычный посетитель
   *     наружу не светится (см. `storeMap` в lib/render.js).
   */
  'Content-Security-Policy': "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; connect-src 'self'; font-src 'self'; frame-src https://yandex.ru https://*.yandex.ru; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'",
  // У мультитенантного приложения нет гарантии, что все поддомены каждого
  // подключённого домена обслуживаются по HTTPS, поэтому includeSubDomains здесь
  // небезопасен: один магазин мог случайно заблокировать HTTP на чужом поддомене.
  'Strict-Transport-Security': 'max-age=31536000'
};

const COMPRESS_MIN = 860;
const SESSION_MAX_AGE = 7 * 24 * 60 * 60 * 1000;

// Разбор заголовка Range. Поддерживается один диапазон — этого хватает всем
// плеерам; составной диапазон и чужой формат считаем «не просили», и файл
// уходит целиком. 'invalid' — диапазон за пределами файла, на него отвечают 416.
function parseRange(header, size) {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(String(header).trim());
  if (!m) return null;
  const hasStart = m[1] !== '', hasEnd = m[2] !== '';
  if (!hasStart && !hasEnd) return null;
  let start, end;
  if (!hasStart) {
    const last = Number(m[2]);                 // «последние N байт»
    if (!last) return 'invalid';
    start = Math.max(0, size - last);
    end = size - 1;
  } else {
    start = Number(m[1]);
    end = hasEnd ? Number(m[2]) : size - 1;
  }
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= size) return 'invalid';
  return { start, end: Math.min(end, size - 1) };
}

// Учитываем q=0 и выбираем Brotli, когда браузер его поддерживает: на больших
// HTML/CSS/JS он заметно компактнее gzip. Старое простое /gzip/ отправляло gzip
// даже клиенту с `gzip;q=0`.
function acceptedEncoding(req) {
  const values = new Map();
  let wildcard = null;
  for (const part of String(req.headers['accept-encoding'] || '').toLowerCase().split(',')) {
    const bits = part.trim().split(';');
    const name = bits.shift();
    if (!name) continue;
    let q = 1;
    for (const bit of bits) {
      const m = bit.trim().match(/^q\s*=\s*(0(?:\.\d+)?|1(?:\.0+)?)$/);
      if (m) q = Number(m[1]);
    }
    if (name === '*') wildcard = q;
    else values.set(name, q);
  }
  const quality = name => values.has(name) ? values.get(name) : (wildcard == null ? 0 : wildcard);
  const br = quality('br'), gzip = quality('gzip');
  if (br > 0 && br >= gzip) return 'br';
  if (gzip > 0) return 'gzip';
  return '';
}

function compressedAsync(encoding, buf, callback) {
  if (encoding === 'br') {
    return zlib.brotliCompress(buf, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 4 } }, callback);
  }
  return zlib.gzip(buf, { level: 6 }, callback);
}

// Отправить ответ, сжав Brotli/gzip, если клиент поддерживает и тело достаточно большое.
function sendBuffer(req, res, code, contentType, buf, extraHeaders) {
  const headers = Object.assign({ 'Content-Type': contentType }, extraHeaders || {});
  // Мониторинги часто используют HEAD. Рендер страницы всё равно нужен ради
  // корректных заголовков, но сжимать и передавать тело в этом случае незачем.
  if (req.method === 'HEAD') {
    headers['Content-Length'] = buf.length;
    res.writeHead(code, headers);
    return res.end();
  }
  const encoding = buf.length > COMPRESS_MIN ? acceptedEncoding(req) : '';
  if (encoding) {
    // Динамические страницы не сжимаем синхронно: gzipSync блокировал весь
    // event loop на время рендера большой страницы каталога.
    return compressedAsync(encoding, buf, (error, compressed) => {
      const body = error ? buf : compressed;
      if (!error) {
        headers['Content-Encoding'] = encoding;
        headers['Vary'] = 'Accept-Encoding';
      }
      headers['Content-Length'] = body.length;
      if (res.destroyed || res.writableEnded) return;
      try { res.writeHead(code, headers); res.end(body); }
      catch (e) { if (!res.destroyed && typeof res.destroy === 'function') res.destroy(e); }
    });
  }
  headers['Content-Length'] = buf.length; // без chunked — меньше накладных расходов
  res.writeHead(code, headers);
  res.end(buf);
}

function sendRaw(res, code, headers, buf) { res.writeHead(code, headers); res.end(buf); }

/* Кэш статики в памяти: файл читается, чистится и сжимается один раз, дальше
   отдаётся из ОЗУ. Ключ — путь + mtime, поэтому изменение файла подхватывается
   автоматически.

   Чистка — снятие комментариев у .css и .js (`lib/minify.js`). В исходниках они
   остаются: это документация проекта. А вот посетителю они не нужны и стоят
   около 46 КБ сжатого трафика на первое открытие витрины — половину всего веса
   стилей и скрипта. Разборщик при любом сомнении отдаёт файл нетронутым, так
   что худший исход правки — несжатые комментарии, а не сломанная витрина. */
const staticCache = new Map();
const STATIC_CACHE_MAX = 120;
function cachedStatic(file, mtime, size) {
  const key = file + ':' + mtime + ':' + size;
  let e = staticCache.get(key);
  if (e) return e;
  const raw = MINIFY.forFile(file, fs.readFileSync(file));
  e = { raw, gz: null, br: null };
  if (raw.length > COMPRESS_MIN) {
    e.gz = zlib.gzipSync(raw, { level: 9 });
    e.br = zlib.brotliCompressSync(raw, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 6 } });
  }
  if (staticCache.size >= STATIC_CACHE_MAX) staticCache.clear();
  staticCache.set(key, e);
  return e;
}

const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8',
  '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm',
  // woff2 сжат сам по себе, поэтому в `compressible` он не попадает намеренно:
  // brotli поверх brotli только тратит процессор и добавляет байты.
  '.woff2': 'font/woff2'
};
const MAX_BODY = 30 * 1024 * 1024; // 30 МБ на запрос
const MAX_FILE = 6 * 1024 * 1024;   // 6 МБ на одно изображение

/* ---------- Подписанные cookie ---------- */
function b64u(str) { return Buffer.from(str).toString('base64url'); }
function unb64u(str) { return Buffer.from(str, 'base64url').toString('utf8'); }
function sign(val, secret) {
  const sig = crypto.createHmac('sha256', secret).update(val).digest('base64url');
  return val + '.' + sig;
}
function unsign(signed, secret) {
  const i = signed.lastIndexOf('.');
  if (i < 0) return null;
  const val = signed.slice(0, i), sig = signed.slice(i + 1);
  const exp = crypto.createHmac('sha256', secret).update(val).digest('base64url');
  const a = Buffer.from(sig), b = Buffer.from(exp);
  return (a.length === b.length && crypto.timingSafeEqual(a, b)) ? val : null;
}
function parseCookies(header) {
  const out = {};
  (header || '').split(';').forEach(p => {
    const i = p.indexOf('=');
    if (i < 0) return;
    try { out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim()); }
    catch (e) { /* повреждённую cookie игнорируем, остальные продолжаем разбирать */ }
  });
  return out;
}

function appendCookie(res, value) {
  const current = typeof res.getHeader === 'function' ? res.getHeader('Set-Cookie') : null;
  if (!current) return res.setHeader('Set-Cookie', value);
  res.setHeader('Set-Cookie', (Array.isArray(current) ? current : [current]).concat(value));
}

/* ---------- Разбор тела запроса ---------- */
function readBody(req) {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > MAX_BODY) {
      req.resume();
      const e = new Error('too_large'); e.statusCode = 413;
      return reject(e);
    }
    const chunks = []; let size = 0; let tooLarge = false;
    req.on('data', c => {
      size += c.length;
      if (size > MAX_BODY) { tooLarge = true; chunks.length = 0; }
      else if (!tooLarge) chunks.push(c);
    });
    req.on('end', () => {
      if (tooLarge) { const e = new Error('too_large'); e.statusCode = 413; reject(e); }
      else resolve(Buffer.concat(chunks));
    });
    req.on('aborted', () => reject(new Error('request_aborted')));
    req.on('error', reject);
  });
}

// hasOwnProperty, а не `k in body`: у обычного объекта уже «есть» constructor,
// toString и прочие ключи прототипа — поле формы с таким именем превращалось
// в массив [функция, значение] вместо строки.
const own = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);

function parseUrlencoded(str) {
  const body = {};
  new URLSearchParams(str).forEach((v, k) => {
    if (own(body, k)) body[k] = [].concat(body[k], v); else body[k] = v;
  });
  return body;
}

function parseMultipart(buf, boundary) {
  const body = {}, files = [];
  const delim = Buffer.from('--' + boundary);
  let start = buf.indexOf(delim);
  if (start === -1) return { body, files };
  start += delim.length;
  while (start < buf.length) {
    if (buf[start] === 0x2d && buf[start + 1] === 0x2d) break;          // "--" => конец
    if (buf[start] === 0x0d && buf[start + 1] === 0x0a) start += 2;      // пропустить CRLF
    const next = buf.indexOf(delim, start);
    if (next === -1) break;
    let end = next;
    if (buf[end - 2] === 0x0d && buf[end - 1] === 0x0a) end -= 2;        // убрать хвостовой CRLF
    const part = buf.slice(start, end);
    processPart(part, body, files);
    start = next + delim.length;
  }
  return { body, files };
}

function addField(body, name, value) {
  if (own(body, name)) body[name] = [].concat(body[name], value); else body[name] = value;
}

function processPart(part, body, files) {
  const sep = part.indexOf(Buffer.from('\r\n\r\n'));
  if (sep === -1) return;
  const headerStr = part.slice(0, sep).toString('utf8');
  const content = part.slice(sep + 4);
  const nameM = /name="([^"]*)"/i.exec(headerStr);
  const fileM = /filename="([^"]*)"/i.exec(headerStr);
  const typeM = /content-type:\s*([^\r\n]+)/i.exec(headerStr);
  if (!nameM) return;
  const name = nameM[1];
  if (fileM) {
    const originalname = fileM[1];
    if (!originalname) return; // пустое поле файла
    if (content.length > MAX_FILE) return;
    // MIME и расширение присылает клиент, поэтому доверяем только сигнатуре файла.
    const ext = imageExtension(content);
    if (!ext) return;
    const ctype = (typeM ? typeM[1] : '').trim();
    const filename = crypto.randomBytes(10).toString('hex') + ext;
    // Запись отложена до явного вызова обработчиком маршрута. Так неизвестный URL
    // или запрос без авторизации не может наполнить uploads мусорными файлами.
    files.push({ fieldname: name, originalname, filename, size: content.length, mimetype: ctype, content });
  } else {
    addField(body, name, content.toString('utf8'));
  }
}

function imageExtension(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 12) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return '.jpg';
  if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return '.png';
  const head6 = buf.subarray(0, 6).toString('ascii');
  if (head6 === 'GIF87a' || head6 === 'GIF89a') return '.gif';
  if (buf.subarray(0, 4).toString('ascii') === 'RIFF' && buf.subarray(8, 12).toString('ascii') === 'WEBP') return '.webp';
  return null;
}

/* ---------- Приложение ---------- */
function compile(pattern) {
  const keys = [];
  // Статические части — обычный текст, а не регулярное выражение. Иначе точка в
  // /robots.txt совпадала с любым символом и маршрут принимал /robotsXtxt.
  const source = String(pattern).split('/').map(part => {
    if (part.startsWith(':')) { keys.push(part.slice(1)); return '([^/]+)'; }
    return part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }).join('/');
  const rx = new RegExp('^' + source + '/?$');
  return { rx, keys };
}


function loopback(address) {
  return /^(?:127(?:\.\d+){3}|::1|::ffff:127(?:\.\d+){3})$/.test(String(address || ''));
}

// Fetch Metadata браузер вычисляет относительно публичного адреса до прокси,
// поэтому same-origin остаётся надёжным даже у прокси без X-Forwarded-Proto.
// Для старых клиентов сохраняется строгая сверка Origin с внешним хостом.
function sameOriginPost(req, isHttps, expectedHost) {
  if (req.method !== 'POST') return true;
  const fetchSite = String(req.headers['sec-fetch-site'] || '').toLowerCase();
  if (fetchSite === 'cross-site') return false;
  // Sec-Fetch-Site — запрещённый для JavaScript заголовок, который выставляет
  // сам браузер относительно публичного адреса страницы. Некоторые privacy-
  // конфигурации Firefox при этом заменяют Origin на буквальный `null`, поэтому
  // подтверждённый same-origin важнее скрытого/непрозрачного значения Origin.
  if (fetchSite === 'same-origin') return true;
  const origin = String(req.headers.origin || '').trim();
  if (!origin) return true;
  if (origin === 'null') return false;
  try {
    const source = new URL(origin);
    return source.protocol === (isHttps ? 'https:' : 'http:')
      && source.host.toLowerCase() === String(expectedHost || req.headers.host || '').trim().toLowerCase();
  } catch (e) { return false; }
}

class App {
  constructor(opts) {
    this.routes = [];
    this.statics = [];
    this.secret = (opts && opts.secret) || 'secret';
    // Каталога загрузок здесь нет намеренно: разбор multipart держит проверенные
    // файлы в памяти, а на диск их кладёт только маршрут — после проверки прав
    // (`persistUploads` в server.js). Путь протаскивался до `processPart`, где
    // им никто не пользовался, и создавал вид, будто фреймворк что-то пишет сам.
    this.trustProxy = !!(opts && opts.trustProxy);
    this.forceHttps = !!(opts && opts.forceHttps);
  }
  setSecret(s) { this.secret = s; }
  get(p, h) { this.routes.push({ method: 'GET', ...compile(p), h }); }
  post(p, h) { this.routes.push({ method: 'POST', ...compile(p), h }); }
  static(prefix, dir, opts) {
    const extensions = opts && opts.extensions ? new Set(opts.extensions.map(x => String(x).toLowerCase())) : null;
    this.statics.push({ prefix, dir: path.resolve(dir), extensions });
  }

  async handle(req, res) {
    // заголовки безопасности/приватности на каждый ответ
    for (const k in SECURITY_HEADERS) res.setHeader(k, SECURITY_HEADERS[k]);

    let u, pathname;
    try {
      u = new URL(req.url, 'http://localhost');
      pathname = decodeURIComponent(u.pathname);
    } catch (e) {
      res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('Некорректный адрес');
    }
    const proxyTrusted = this.trustProxy || loopback(req.socket && req.socket.remoteAddress);
    const forwardedProto = proxyTrusted ? String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() : '';
    const forwardedHost = proxyTrusted ? String(req.headers['x-forwarded-host'] || '').split(',')[0].trim() : '';
    const isHttps = this.forceHttps || forwardedProto === 'https' || !!(req.socket && req.socket.encrypted);

    // сессия из подписанной cookie
    const cookies = parseCookies(req.headers.cookie);
    let session = {};
    let originalSession = '{}';
    let staleSession = false;
    if (cookies.sess) {
      const raw = unsign(cookies.sess, this.secret);
      if (raw) {
        try {
          const parsed = JSON.parse(unb64u(raw));
          const issued = Number(parsed && parsed._iat);
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && Number.isFinite(issued)
            && issued <= Date.now() + 5 * 60 * 1000 && Date.now() - issued <= SESSION_MAX_AGE) {
            session = parsed; originalSession = JSON.stringify(session);
          } else staleSession = true;
        } catch (e) { staleSession = true; }
      } else staleSession = true;
    }

    /* Скрытый Origin — обычное дело у privacy-браузеров, и `sameOriginPost()`
     * пропускает его сам: заголовка нет — проверять нечего, а `Sec-Fetch-Site`
     * при этом всё равно обязан быть не `cross-site`. Firefox с усиленной
     * приватностью может прислать и буквальный `null`; он допустим только когда
     * защищённый браузерный заголовок прямо подтверждает `same-origin`.
     *
     * Раньше рядом стояли ещё два исключения — для формы входа и для живой
     * админской сессии, — и оба принимали не только ОТСУТСТВУЮЩИЙ Origin, но и
     * буквальный `null`. Разница между ними принципиальная: отсутствие означает
     * «браузер не сказал», а `null` — «источник непрозрачный», то есть
     * песочница в iframe, страница с `data:` или переход с чужого origin.
     * Ничего из этого нашей формой быть не может: `frame-ancestors 'none'` в
     * CSP запрещает встраивать сайт в кадр вовсе. А исключения при этом были
     * единственной щелью в остальном строгой проверке — POST с `Origin: null`
     * и без `Sec-Fetch-Site` проходил при живой сессии панели.
     *
     * Старые исключения убраны целиком: `null` без подтверждения same-origin
     * по-прежнему отклоняется, а отсутствующий Origin и так проходит выше.
     */
    if (!sameOriginPost(req, isHttps, forwardedHost || req.headers.host)) {
      req.resume();
      res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'private, no-store' });
      return res.end('Запрос с другого сайта отклонён');
    }

    req.session = session;
    req.pathname = pathname;
    req.query = Object.create(null);
    u.searchParams.forEach((v, k) => { if (!own(req.query, k)) req.query[k] = v; });

    // помощники ответа (Secure-cookie за HTTPS)
    const secure = isHttps ? '; Secure' : '';
    const flushSession = () => {
      if (res.headersSent) return;
      if (req.session === null) {
        appendCookie(res, 'sess=; Path=/; HttpOnly; SameSite=Lax' + secure + '; Max-Age=0');
      } else {
        const now = JSON.stringify(req.session);
        if (now !== originalSession) {
          if (!Number.isFinite(Number(req.session._iat))) req.session._iat = Date.now();
          const value = JSON.stringify(req.session);
          appendCookie(res, 'sess=' + sign(b64u(value), this.secret) + '; Path=/; HttpOnly; SameSite=Lax' + secure + '; Max-Age=604800');
        } else if (staleSession) appendCookie(res, 'sess=; Path=/; HttpOnly; SameSite=Lax' + secure + '; Max-Age=0');
      }
    };
    // HTML/JSON — динамика: не кладём в общий кэш и всегда перепроверяем (личные страницы админки в том числе).
    const noStore = { 'Cache-Control': 'private, no-cache, no-store, must-revalidate' };
    /* Обычные ответы дописывают сессию в cookie сами. Но поток (SSE) пишет
     * заголовки напрямую, минуя `res.send`, — и всё, что маршрут успел положить
     * в `req.session` перед этим, до браузера не доезжало. У чата это `chatId`
     * разговора, начатого менеджером: он находился по метке посетителя и
     * терялся до следующего обычного запроса. Отсюда явная ручка.
     */
    res.flushSession = flushSession;
    res.send = (html, code) => { flushSession(); sendBuffer(req, res, code || res._code || 200, 'text/html; charset=utf-8', Buffer.from(html), noStore); };
    res.json = (obj, code) => { flushSession(); sendBuffer(req, res, code || res._code || 200, 'application/json; charset=utf-8', Buffer.from(JSON.stringify(obj)), noStore); };
    res.redirect = (loc, code) => {
      flushSession();
      const wanted = Number(code || res._code || 302);
      const status = [301, 302, 303, 307, 308].includes(wanted) ? wanted : 302;
      res.writeHead(status, { Location: loc }); res.end();
    };
    res.status = (code) => { res._code = code; return res; };
    req.filesFor = (name) => (req.files || []).filter(f => f.fieldname === name);

    // статика (условные запросы ETag + Brotli/gzip для текстовых файлов)
    for (const s of this.statics) {
      if (pathname.startsWith(s.prefix + '/') || pathname === s.prefix) {
        if (req.method !== 'GET' && req.method !== 'HEAD') continue;
        const rel = pathname.slice(s.prefix.length).replace(/^\/+/, '');
        const file = path.resolve(s.dir, rel);
        if (file !== s.dir && !file.startsWith(s.dir + path.sep)) { res.writeHead(403); return res.end('Forbidden'); }
        if (s.extensions && !s.extensions.has(path.extname(file).toLowerCase())) {
          res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
          return res.end('Не найдено');
        }
        let st = null; try { st = fs.statSync(file); } catch (e) {}
        if (st && st.isFile()) {
          const ext = path.extname(file).toLowerCase();
          const etag = 'W/"' + st.size.toString(16) + '-' + Math.round(st.mtimeMs).toString(16) + '"';
          // Адрес с меткой версии (?v=hash) меняется вместе с файлом, поэтому такой
          // ответ можно кэшировать навсегда — браузер перестанет ходить за 304.
          const versioned = u.searchParams.has('v');
          /* Загруженный файл живёт под именем, которое больше никогда не
           * достанется другому содержимому: имя выдаётся случайным при загрузке,
           * а уменьшенные копии считаются от него. Значит его можно кэшировать
           * навсегда, как и адрес с меткой версии. Прежняя неделя означала, что
           * постоянный покупатель раз в неделю заново качает весь каталог
           * снимков (PageSpeed насчитал на этом 121 КиБ на одной главной).
           *
           * Цена решения одна: `refit-photos.js` перезаписывает файлы ПОД ТЕМИ
           * ЖЕ ИМЕНАМИ, и у того, кто уже открывал витрину, останется прежний
           * снимок. Это разовый ремонтный инструмент, а не рабочий путь —
           * обычная замена фото в панели даёт новое имя и доезжает сразу.
           */
          const upload = s.prefix.includes('uploads');
          const longCache = /\.(png|jpe?g|gif|webp|svg|ico)$/.test(ext);
          const cacheCtl = (versioned || upload) ? 'public, max-age=31536000, immutable'
            : (longCache ? 'public, max-age=604800' : 'public, max-age=300, must-revalidate');
          const type = MIME[ext] || 'application/octet-stream';
          const headers = { ETag: etag, 'Cache-Control': cacheCtl, 'Last-Modified': new Date(st.mtimeMs).toUTCString() };
          const compressible = /text|javascript|json|svg/.test(type);
          // Сжатые представления по диапазонам не режутся: смещения считались бы
          // по несжатому файлу. Поэтому диапазоны обещаем только несжимаемым.
          if (!compressible) headers['Accept-Ranges'] = 'bytes';
          const negotiatesEncoding = compressible && st.size > COMPRESS_MIN;
          const encoding = negotiatesEncoding ? acceptedEncoding(req) : '';
          // Один URL имеет identity/gzip/br-представления. Vary нужен даже когда
          // конкретный клиент выбрал identity, и обязан сохраняться в 304 — иначе
          // общий кэш может раздать не то представление или перестать сжимать файл.
          if (negotiatesEncoding) headers.Vary = 'Accept-Encoding';
          if (encoding) headers['Content-Encoding'] = encoding;
          if (req.headers['if-none-match'] === etag) { res.writeHead(304, headers); return res.end(); }
          if (compressible) {
            const c = cachedStatic(file, st.mtimeMs, st.size);
            const packed = encoding === 'br' ? c.br : (encoding === 'gzip' ? c.gz : null);
            if (packed) {
              if (req.method === 'HEAD') { res.writeHead(200, Object.assign({ 'Content-Type': type, 'Content-Length': packed.length }, headers)); return res.end(); }
              return sendRaw(res, 200, Object.assign({ 'Content-Type': type, 'Content-Length': packed.length }, headers), packed);
            }
            delete headers['Content-Encoding'];
            if (req.method === 'HEAD') { res.writeHead(200, Object.assign({ 'Content-Type': type, 'Content-Length': c.raw.length }, headers)); return res.end(); }
            return sendRaw(res, 200, Object.assign({ 'Content-Type': type, 'Content-Length': c.raw.length }, headers), c.raw);
          }
          // Диапазон байтов. Без него Safari не проигрывает <video> вовсе, а
          // остальные браузеры не дают перематывать: плеер запрашивает кусок
          // файла, а получает его целиком с кодом 200.
          const range = parseRange(req.headers.range, st.size);
          if (range === 'invalid') {
            res.writeHead(416, Object.assign({ 'Content-Range': 'bytes */' + st.size }, headers));
            return res.end();
          }
          if (range) {
            const length = range.end - range.start + 1;
            res.writeHead(206, Object.assign({
              'Content-Type': type, 'Content-Length': length,
              'Content-Range': `bytes ${range.start}-${range.end}/${st.size}`
            }, headers));
            if (req.method === 'HEAD') return res.end();
            return fs.createReadStream(file, { start: range.start, end: range.end }).pipe(res);
          }
          res.writeHead(200, Object.assign({ 'Content-Type': type, 'Content-Length': st.size }, headers));
          if (req.method === 'HEAD') return res.end();
          return fs.createReadStream(file).pipe(res);
        }
        // Запрос уже попал в пространство статики: не рендерим вместо отсутствующего
        // файла всю витрину и не записываем такой запрос как просмотр магазина.
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'public, max-age=60' });
        return res.end('Не найдено');
      }
    }

    // тело запроса
    if (req.method === 'POST') {
      try {
        const raw = await readBody(req);
        const rawType = String(req.headers['content-type'] || '');
        const ctype = rawType.toLowerCase();
        if (ctype.includes('application/json')) {
          req.body = raw.length ? JSON.parse(raw.toString('utf8')) : {};
          // Подпись вебхука платёжки считается по ТЕКСТУ значений, а разбор его
          // теряет: "0.00000000" после JSON.parse станет 0, и HMAC не сойдётся.
          // Поэтому небольшое тело сохраняем ещё и как есть. Порог отсекает
          // загрузки: держать в памяти мегабайты ради подписи незачем.
          if (raw.length <= 64 * 1024) req.rawBody = raw.toString('utf8');
        } else if (ctype.includes('multipart/form-data')) {
          // Значение boundary регистрозависимо, поэтому извлекаем его из исходного
          // заголовка, а не из нормализованной копии Content-Type.
          const bm = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(rawType);
          const boundary = bm ? (bm[1] || bm[2]).trim() : '';
          const parsed = parseMultipart(raw, boundary);
          req.body = parsed.body; req.files = parsed.files;
        } else {
          req.body = parseUrlencoded(raw.toString('utf8'));
        }
      } catch (e) {
        if (req.aborted || res.destroyed) return;
        const code = e && e.statusCode === 413 ? 413 : 400;
        res.writeHead(code, { 'Content-Type': 'text/plain; charset=utf-8' });
        return res.end(code === 413 ? 'Запрос слишком большой' : 'Некорректный запрос');
      }
    }
    req.body = req.body || {};
    req.files = req.files || [];

    // маршрут. HEAD обслуживается обработчиком GET: Node сам не отправляет тело
    // такого ответа, но заголовки нужны те же. Без этого мониторинги и краулеры,
    // проверяющие страницы через HEAD, получали 404 на живой витрине.
    const routeMethod = req.method === 'HEAD' ? 'GET' : req.method;
    for (const r of this.routes) {
      if (r.method !== routeMethod) continue;
      const m = r.rx.exec(pathname);
      if (!m) continue;
      req.params = {};
      // pathname уже декодирован выше; повторный decode ломал параметры с символом "%".
      r.keys.forEach((k, i) => req.params[k] = m[i + 1]);
      try {
        await r.h(req, res);
      } catch (e) {
        console.error(e);
        if (!res.headersSent) { res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('Внутренняя ошибка сервера'); }
      }
      return;
    }

    // 404
    if (this.notFound) return this.notFound(req, res);
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Не найдено');
  }

  listen(port, host, cb) {
    if (typeof host === 'function') { cb = host; host = undefined; }
    const server = http.createServer((req, res) => {
      this.handle(req, res).catch(e => {
        console.error(e);
        if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
        if (!res.writableEnded) res.end('Внутренняя ошибка сервера');
      });
    });
    server.requestTimeout = 30000;
    server.headersTimeout = 15000;
    server.keepAliveTimeout = 5000;
    server.maxHeadersCount = 100;
    server.listen(port, host, cb);
    return server;
  }
}

module.exports = { App, imageExtension };
