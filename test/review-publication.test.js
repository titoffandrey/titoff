'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');
const ROOT = path.join(__dirname, '..');

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'review-publication-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'reviews.json');
  const env = { ...process.env, STORE_DATA_DIR: dir };
  const run = (file, ...args) => execFileSync(process.execPath, [path.join(ROOT, file), ...args], { cwd: ROOT, env });
  return { dir, file, env, run, read: () => JSON.parse(fs.readFileSync(file, 'utf8')) };
}

test('первый запуск, повторный запуск и сброс не создают демо-отзывы', t => {
  const store = fixture(t);
  const init = () => execFileSync(process.execPath, ['-e', 'require("./lib/db").ensureSeeded()'], { cwd: ROOT, env: store.env });
  init();
  assert.deepEqual(store.read(), []);
  assert.ok(JSON.parse(fs.readFileSync(path.join(store.dir, 'products.json'))).length > 0);
  const customer = { id: 'customer', productId: 'iphone-18-pro', status: 'pending', text: 'Отзыв покупателя' };
  fs.writeFileSync(store.file, JSON.stringify([customer]));
  init();
  assert.deepEqual(store.read(), [customer]);
  // Восстановление каталога тоже не должно стирать существующие отзывы.
  fs.unlinkSync(path.join(store.dir, 'products.json'));
  init();
  assert.deepEqual(store.read(), [customer]);
  store.run('seed.js');
  assert.deepEqual(store.read(), []);
});

test('ручная генерация не публикует новые и не возвращает скрытые отзывы', t => {
  const store = fixture(t);
  const statuses = ['approved', 'pending', 'seen'];
  const previous = statuses.map((status, i) => ({
    id: `demo-iphone-17-pro-max-00${i + 1}`, productId: 'iphone-17-pro-max',
    demo: true, status, photos: ['owner.webp']
  }));
  const customer = { id: 'customer', productId: 'iphone-18-pro', status: 'approved', text: 'Отзыв покупателя' };
  fs.writeFileSync(store.file, JSON.stringify([...previous, customer]));
  const before = fs.readFileSync(store.file, 'utf8');
  store.run('scripts/demo-reviews.js');
  assert.equal(fs.readFileSync(store.file, 'utf8'), before, 'предпросмотр не пишет данные');
  store.run('scripts/demo-reviews.js', '--apply');
  store.run('scripts/demo-reviews.js', '--apply');
  const stored = store.read();
  for (const review of previous) {
    const current = stored.find(r => r.id === review.id);
    assert.equal(current.status, review.status);
    assert.deepEqual(current.photos, review.photos);
  }
  assert.deepEqual(stored.find(r => r.id === customer.id), customer);
  const existing = new Set([...previous, customer].map(r => r.id));
  const added = stored.filter(r => !existing.has(r.id));
  assert.ok(added.length > 0);
  assert.ok(added.every(r => r.status === 'pending'));
  const publicIds = JSON.parse(execFileSync(process.execPath, ['-e',
    'console.log(JSON.stringify(require("./lib/db").reviewsForProduct("iphone-18-pro", true).map(r => r.id)))'
  ], { cwd: ROOT, env: store.env, encoding: 'utf8' }));
  assert.deepEqual(publicIds, ['customer']);
});

test('старый ночной скрипт не создаёт отзывы и не изменяет их даты', t => {
  const store = fixture(t);
  execFileSync('sh', [path.join(ROOT, 'scripts/refresh-demo-reviews.sh')], { env: store.env });
  assert.equal(fs.existsSync(store.file), false);
  const body = JSON.stringify([{ id: 'demo-old', demo: true, createdAt: 1 }, { id: 'imported', source: 'ozon', createdAt: 2 }]);
  fs.writeFileSync(store.file, body);
  execFileSync('sh', [path.join(ROOT, 'scripts/refresh-demo-reviews.sh')], { env: store.env });
  assert.equal(fs.readFileSync(store.file, 'utf8'), body);
});

test('отключение cron сохраняет остальные задания и не повторяет запись', t => {
  const store = fixture(t);
  const bin = path.join(store.dir, 'bin');
  fs.mkdirSync(bin);
  const cronFile = path.join(store.dir, 'crontab');
  fs.writeFileSync(path.join(bin, 'crontab'), `#!/bin/sh
if [ "$1" = -l ]; then
  if [ -n "\${CRON_FAIL:-}" ]; then echo 'permission denied' >&2; exit 1; fi
  if [ ! -f "$CRON_FILE" ]; then echo 'no crontab for test' >&2; exit 1; fi
  cat "$CRON_FILE"
else
  cp "$1" "$CRON_FILE"
  echo written >> "$CRON_FILE.writes"
fi
`, { mode: 0o755 });
  const env = { ...store.env, PATH: bin + path.delimiter + process.env.PATH, CRON_FILE: cronFile };
  const script = path.join(ROOT, 'scripts/disable-demo-reviews-cron.sh');
  const run = () => execFileSync('sh', [script], { env });
  run();
  assert.equal(fs.existsSync(cronFile), false);
  const keep = '# служебные задания\n0 2 * * * node scripts/sync-pickup-points.js\n0 3 3 * * node scripts/sync-geoip.js\n';
  fs.writeFileSync(cronFile, keep + '20 1 * * * /project/scripts/refresh-demo-reviews.sh\n20 1 * * * node scripts/demo-reviews.js --apply\n20 1 * * * npm run reviews:demo\n');
  run();
  assert.equal(fs.readFileSync(cronFile, 'utf8'), keep);
  run();
  assert.equal(fs.readFileSync(cronFile + '.writes', 'utf8'), 'written\n');
  const failed = spawnSync('sh', [script], { env: { ...env, CRON_FAIL: '1' } });
  assert.equal(failed.status, 1);
  assert.equal(fs.readFileSync(cronFile, 'utf8'), keep);
  assert.equal(fs.readFileSync(cronFile + '.writes', 'utf8'), 'written\n');
});
