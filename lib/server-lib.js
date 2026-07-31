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

// Заголовки безопасности и приватности на каждый ответ.
// CSP разрешает только собственные ресурсы (никаких сторонних скриптов/трекеров); 'unsafe-inline'
// нужен для встроенных обработчиков и стилей самого приложения. Внешних запросов из браузера нет.
const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'X-XSS-Protection': '0',
  'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'",
  'Strict-Transport-Security': 'max-age=31536000; includeSubDomains'
};

function acceptsGzip(req) { return /\bgzip\b/.test(req.headers['accept-encoding'] || ''); }

// Отправить ответ, сжав gzip, если клиент поддерживает и тело достаточно большое.
function sendBuffer(req, res, code, contentType, buf, extraHeaders) {
  const headers = Object.assign({ 'Content-Type': contentType }, extraHeaders || {});
  if (acceptsGzip(req) && buf.length > 860) {
    // Динамические страницы не сжимаем синхронно: gzipSync блокировал весь
    // event loop на время рендера большой страницы каталога.
    return zlib.gzip(buf, { level: 6 }, (error, compressed) => {
      const body = error ? buf : compressed;
      if (!error) {
        headers['Content-Encoding'] = 'gzip';
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

/* Кэш статики в памяти: файл читается и сжимается один раз, дальше отдаётся из ОЗУ.
   Ключ — путь + mtime, поэтому изменение файла подхватывается автоматически. */
const staticCache = new Map();
const STATIC_CACHE_MAX = 120;
function cachedStatic(file, mtime, size) {
  const key = file + ':' + mtime + ':' + size;
  let e = staticCache.get(key);
  if (e) return e;
  const raw = fs.readFileSync(file);
  e = { raw, gz: raw.length > 860 ? zlib.gzipSync(raw, { level: 9 }) : null };
  if (staticCache.size >= STATIC_CACHE_MAX) staticCache.clear();
  staticCache.set(key, e);
  return e;
}

const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8'
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

function parseMultipart(buf, boundary, uploadDir) {
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
    processPart(part, body, files, uploadDir);
    start = next + delim.length;
  }
  return { body, files };
}

function addField(body, name, value) {
  if (own(body, name)) body[name] = [].concat(body[name], value); else body[name] = value;
}

function processPart(part, body, files, uploadDir) {
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
  const rx = new RegExp('^' + pattern.replace(/:[^/]+/g, m => { keys.push(m.slice(1)); return '([^/]+)'; }) + '/?$');
  return { rx, keys };
}

class App {
  constructor(opts) {
    this.routes = [];
    this.statics = [];
    this.secret = (opts && opts.secret) || 'secret';
    this.uploadDir = path.resolve((opts && opts.uploadDir) || path.join(process.cwd(), 'uploads'));
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
    const isHttps = req.headers['x-forwarded-proto'] === 'https' || !!(req.socket && req.socket.encrypted);

    // сессия из подписанной cookie
    const cookies = parseCookies(req.headers.cookie);
    let session = {};
    let originalSession = '{}';
    if (cookies.sess) {
      const raw = unsign(cookies.sess, this.secret);
      if (raw) { try { session = JSON.parse(unb64u(raw)); originalSession = JSON.stringify(session); } catch (e) {} }
    }
    req.session = session;
    req.query = {}; u.searchParams.forEach((v, k) => { if (!(k in req.query)) req.query[k] = v; });

    // помощники ответа (Secure-cookie за HTTPS)
    const secure = isHttps ? '; Secure' : '';
    const flushSession = () => {
      if (res.headersSent) return;
      if (req.session === null) {
        res.setHeader('Set-Cookie', 'sess=; Path=/; HttpOnly; SameSite=Lax' + secure + '; Max-Age=0');
      } else {
        const now = JSON.stringify(req.session);
        if (now !== originalSession) {
          res.setHeader('Set-Cookie', 'sess=' + sign(b64u(now), this.secret) + '; Path=/; HttpOnly; SameSite=Lax' + secure + '; Max-Age=604800');
        }
      }
    };
    // HTML/JSON — динамика: не кладём в общий кэш и всегда перепроверяем (личные страницы админки в том числе).
    const noStore = { 'Cache-Control': 'private, no-cache, no-store, must-revalidate' };
    res.send = (html, code) => { flushSession(); sendBuffer(req, res, code || res._code || 200, 'text/html; charset=utf-8', Buffer.from(html), noStore); };
    res.json = (obj, code) => { flushSession(); sendBuffer(req, res, code || res._code || 200, 'application/json; charset=utf-8', Buffer.from(JSON.stringify(obj)), noStore); };
    res.redirect = (loc) => { flushSession(); res.writeHead(302, { Location: loc }); res.end(); };
    res.status = (code) => { res._code = code; return res; };
    req.filesFor = (name) => (req.files || []).filter(f => f.fieldname === name);

    // статика (условные запросы ETag + gzip для текстовых файлов)
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
          const etag = '"' + st.size.toString(16) + '-' + Math.round(st.mtimeMs).toString(16) + '"';
          // Адрес с меткой версии (?v=hash) меняется вместе с файлом, поэтому такой
          // ответ можно кэшировать навсегда — браузер перестанет ходить за 304.
          const versioned = u.searchParams.has('v');
          const longCache = s.prefix.includes('uploads') || /\.(png|jpe?g|gif|webp|svg|ico)$/.test(ext);
          const cacheCtl = versioned ? 'public, max-age=31536000, immutable'
            : (longCache ? 'public, max-age=604800' : 'public, max-age=300, must-revalidate');
          if (req.headers['if-none-match'] === etag) { res.writeHead(304, { ETag: etag, 'Cache-Control': cacheCtl }); return res.end(); }
          const type = MIME[ext] || 'application/octet-stream';
          const headers = { ETag: etag, 'Cache-Control': cacheCtl, 'Last-Modified': new Date(st.mtimeMs).toUTCString() };
          if (/text|javascript|json|svg/.test(type)) {
            const c = cachedStatic(file, st.mtimeMs, st.size);
            if (c.gz && acceptsGzip(req)) {
              if (req.method === 'HEAD') { res.writeHead(200, Object.assign({ 'Content-Type': type, 'Content-Encoding': 'gzip', Vary: 'Accept-Encoding', 'Content-Length': c.gz.length }, headers)); return res.end(); }
              return sendRaw(res, 200, Object.assign({ 'Content-Type': type, 'Content-Encoding': 'gzip', Vary: 'Accept-Encoding', 'Content-Length': c.gz.length }, headers), c.gz);
            }
            if (req.method === 'HEAD') { res.writeHead(200, Object.assign({ 'Content-Type': type, 'Content-Length': c.raw.length }, headers)); return res.end(); }
            return sendRaw(res, 200, Object.assign({ 'Content-Type': type, 'Content-Length': c.raw.length }, headers), c.raw);
          }
          res.writeHead(200, Object.assign({ 'Content-Type': type, 'Content-Length': st.size }, headers));
          if (req.method === 'HEAD') return res.end();
          return fs.createReadStream(file).pipe(res);
        }
      }
    }

    // тело запроса
    if (req.method === 'POST') {
      try {
        const raw = await readBody(req);
        const ctype = req.headers['content-type'] || '';
        if (ctype.includes('application/json')) {
          req.body = raw.length ? JSON.parse(raw.toString('utf8')) : {};
        } else if (ctype.includes('multipart/form-data')) {
          const bm = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(ctype);
          const boundary = bm ? (bm[1] || bm[2]).trim() : '';
          const parsed = parseMultipart(raw, boundary, this.uploadDir);
          req.body = parsed.body; req.files = parsed.files;
        } else {
          req.body = parseUrlencoded(raw.toString('utf8'));
        }
      } catch (e) {
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

  listen(port, cb) {
    const server = http.createServer((req, res) => {
      this.handle(req, res).catch(e => {
        console.error(e);
        if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
        if (!res.writableEnded) res.end('Внутренняя ошибка сервера');
      });
    });
    server.listen(port, cb);
    return server;
  }
}

module.exports = { App, imageExtension };
