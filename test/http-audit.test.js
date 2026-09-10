'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const zlib = require('zlib');
const { Readable } = require('stream');
const { App } = require('../lib/server-lib');

async function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'store-http-audit-'));
  const app = new App({ secret: 'test-only' });
  app.static('/static', dir);
  app.get('/health', (req, res) => res.json({ ok: true }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => {
    server.closeAllConnections(); server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const get = (url, headers = {}) => new Promise((resolve, reject) => {
    const req = http.get({ hostname: '127.0.0.1', port: server.address().port, path: url, headers, agent: false }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('error', reject);
      res.on('end', () => resolve({ code: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.setTimeout(3000, () => req.destroy(new Error('Таймаут проверки HTTP')));
  });
  return { dir, get, server };
}

test('условный GET понимает список ETag и wildcard без повторной передачи файла', async t => {
  const { dir, get } = await fixture(t);
  fs.writeFileSync(path.join(dir, 'asset.txt'), 'данные');
  const first = await get('/static/asset.txt');
  for (const tag of ['*', '"other", ' + first.headers.etag, first.headers.etag.replace(/^W\//, '')]) {
    const next = await get('/static/asset.txt', { 'if-none-match': tag });
    assert.equal(next.code, 304); assert.equal(next.body.length, 0);
  }
});

test('возобновление загрузки после изменения файла возвращает целый актуальный файл', async t => {
  const { dir, get } = await fixture(t);
  const body = Buffer.from('0123456789');
  fs.writeFileSync(path.join(dir, 'video.mp4'), body);
  const first = await get('/static/video.mp4');
  const later = new Date(Date.parse(first.headers['last-modified']) + 1000).toUTCString();
  for (const validator of ['Wed, 01 Jan 2020 00:00:00 GMT', later, '"old-etag"', '"2099"', first.headers.etag]) {
    const stale = await get('/static/video.mp4', { range: 'bytes=5-', 'if-range': validator });
    assert.equal(stale.code, 200); assert.deepEqual(stale.body, body);
  }
  const current = await get('/static/video.mp4', { range: 'bytes=5-', 'if-range': first.headers['last-modified'] });
  assert.equal(current.code, 206); assert.equal(current.body.toString(), '56789');
  const invalid = await get('/static/video.mp4', { range: 'bytes=50-' });
  assert.equal(invalid.code, 416); assert.equal(invalid.headers['content-range'], 'bytes */10');
});

test('параллельные холодные запросы разделяют сжатие и не блокируют другие маршруты', async t => {
  const { dir, get } = await fixture(t);
  const body = 'Содержимое большого файла.\n'.repeat(2000);
  fs.writeFileSync(path.join(dir, 'large.txt'), body);
  const original = zlib.brotliCompress;
  let started;
  const preparing = new Promise(resolve => { started = resolve; });
  let release, count = 0;
  zlib.brotliCompress = (raw, opts, callback) => {
    count++;
    release = () => original(raw, opts, callback);
    started();
  };
  t.after(() => { zlib.brotliCompress = original; });
  const first = get('/static/large.txt', { 'accept-encoding': 'br' });
  await preparing;
  const second = get('/static/large.txt', { 'accept-encoding': 'gzip' });
  const health = await get('/health');
  assert.equal(health.code, 200, 'другой маршрут отвечает, пока статика готовится');
  release();
  const [br, gz] = await Promise.all([first, second]);
  assert.equal(count, 1, 'сжатие не дублируется для второго покупателя');
  assert.equal(zlib.brotliDecompressSync(br.body).toString(), body);
  assert.equal(zlib.gunzipSync(gz.body).toString(), body);
});

test('ошибка чтения медиа закрывает только запрос и оставляет магазин работающим', async t => {
  const { dir, get } = await fixture(t);
  fs.writeFileSync(path.join(dir, 'gone.mp4'), Buffer.alloc(32));
  const original = fs.createReadStream;
  fs.createReadStream = () => new Readable({ read() { this.destroy(new Error('Файл удалён после stat')); } });
  t.after(() => { fs.createReadStream = original; });
  await assert.rejects(get('/static/gone.mp4'));
  assert.equal((await get('/health')).code, 200);
});

test('обрыв скачивания прекращает чтение медиа с диска', async t => {
  const { dir, server } = await fixture(t);
  fs.writeFileSync(path.join(dir, 'large.mp4'), Buffer.alloc(4 * 1024 * 1024));
  const original = fs.createReadStream;
  let stream;
  let stopped;
  const closed = new Promise(resolve => { stopped = resolve; });
  fs.createReadStream = () => {
    stream = new Readable({ read() { this.push(Buffer.alloc(64 * 1024)); } });
    stream.once('close', stopped);
    return stream;
  };
  t.after(() => { fs.createReadStream = original; });
  await new Promise((resolve, reject) => {
    const req = http.get({ hostname: '127.0.0.1', port: server.address().port, path: '/static/large.mp4', agent: false }, res => {
      res.once('data', () => { res.destroy(); resolve(); });
    });
    req.on('error', reject);
  });
  await closed;
  assert.equal(stream.destroyed, true);
});
