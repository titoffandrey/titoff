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
    buf = zlib.gzipSync(buf);
    headers['Content-Encoding'] = 'gzip';
    headers['Vary'] = 'Accept-Encoding';
  }
  res.writeHead(code, headers);
  res.end(buf);
}

const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8'
};
const MAX_BODY = 30 * 1024 * 1024; // 30 МБ на запрос

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
    if (i > -1) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim());
  });
  return out;
}

/* ---------- Разбор тела запроса ---------- */
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    req.on('data', c => { size += c.length; if (size > MAX_BODY) { reject(new Error('too_large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function parseUrlencoded(str) {
  const body = {};
  new URLSearchParams(str).forEach((v, k) => {
    if (k in body) body[k] = [].concat(body[k], v); else body[k] = v;
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
  if (name in body) body[name] = [].concat(body[name], value); else body[name] = value;
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
    const ctype = (typeM ? typeM[1] : '').trim();
    if (!/^image\//i.test(ctype)) return; // принимаем только картинки
    let ext = (path.extname(originalname) || '').toLowerCase().replace(/[^.a-z0-9]/g, '');
    if (!ext) ext = '.' + (ctype.split('/')[1] || 'jpg');
    const filename = crypto.randomBytes(10).toString('hex') + ext;
    fs.writeFileSync(path.join(uploadDir, filename), content);
    files.push({ fieldname: name, originalname, filename, size: content.length });
  } else {
    addField(body, name, content.toString('utf8'));
  }
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
    this.uploadDir = (opts && opts.uploadDir) || path.join(process.cwd(), 'uploads');
  }
  setSecret(s) { this.secret = s; }
  get(p, h) { this.routes.push({ method: 'GET', ...compile(p), h }); }
  post(p, h) { this.routes.push({ method: 'POST', ...compile(p), h }); }
  static(prefix, dir) { this.statics.push({ prefix, dir }); }

  async handle(req, res) {
    const u = new URL(req.url, 'http://localhost');
    const pathname = decodeURIComponent(u.pathname);
    const isHttps = req.headers['x-forwarded-proto'] === 'https' || !!(req.socket && req.socket.encrypted);

    // заголовки безопасности/приватности на каждый ответ
    for (const k in SECURITY_HEADERS) res.setHeader(k, SECURITY_HEADERS[k]);

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
    res.send = (html, code) => { flushSession(); sendBuffer(req, res, code || res._code || 200, 'text/html; charset=utf-8', Buffer.from(html)); };
    res.json = (obj, code) => { flushSession(); sendBuffer(req, res, code || res._code || 200, 'application/json; charset=utf-8', Buffer.from(JSON.stringify(obj))); };
    res.redirect = (loc) => { flushSession(); res.writeHead(302, { Location: loc }); res.end(); };
    res.status = (code) => { res._code = code; return res; };
    req.filesFor = (name) => (req.files || []).filter(f => f.fieldname === name);

    // статика (условные запросы ETag + gzip для текстовых файлов)
    for (const s of this.statics) {
      if (pathname.startsWith(s.prefix + '/') || pathname === s.prefix) {
        const rel = pathname.slice(s.prefix.length).replace(/^\/+/, '');
        const file = path.join(s.dir, rel);
        if (!file.startsWith(s.dir)) { res.writeHead(403); return res.end('Forbidden'); }
        let st = null; try { st = fs.statSync(file); } catch (e) {}
        if (st && st.isFile()) {
          const ext = path.extname(file).toLowerCase();
          const etag = '"' + st.size.toString(16) + '-' + Math.round(st.mtimeMs).toString(16) + '"';
          const longCache = s.prefix.includes('uploads') || /\.(png|jpe?g|gif|webp|svg|ico)$/.test(ext);
          const cacheCtl = longCache ? 'public, max-age=604800' : 'public, max-age=300, must-revalidate';
          if (req.headers['if-none-match'] === etag) { res.writeHead(304, { ETag: etag, 'Cache-Control': cacheCtl }); return res.end(); }
          const type = MIME[ext] || 'application/octet-stream';
          const headers = { ETag: etag, 'Cache-Control': cacheCtl, 'Last-Modified': new Date(st.mtimeMs).toUTCString() };
          if (/text|javascript|json|svg/.test(type)) return sendBuffer(req, res, 200, type, fs.readFileSync(file), headers);
          res.writeHead(200, Object.assign({ 'Content-Type': type }, headers));
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
        res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
        return res.end('Некорректный запрос');
      }
    }
    req.body = req.body || {};
    req.files = req.files || [];

    // маршрут
    for (const r of this.routes) {
      if (r.method !== req.method) continue;
      const m = r.rx.exec(pathname);
      if (!m) continue;
      req.params = {};
      r.keys.forEach((k, i) => req.params[k] = decodeURIComponent(m[i + 1]));
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
    const server = http.createServer((req, res) => this.handle(req, res));
    server.listen(port, cb);
    return server;
  }
}

module.exports = { App };
