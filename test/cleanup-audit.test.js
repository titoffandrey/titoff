'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

test('карантин сохраняет используемые и свежие файлы, а сироты остаются восстановимыми', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'store-cleanup-audit-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const uploads = path.join(dir, 'uploads');
  fs.mkdirSync(uploads);
  const write = (name, data) => fs.writeFileSync(path.join(dir, name + '.json'), JSON.stringify(data));
  write('products', [{ id: 'one', images: ['used.webp'] }]);
  write('reviews', []); write('settings', { storePhotos: ['store.webp'] });
  write('chats', { chats: [{ messages: [{ photos: ['chat.webp'] }] }] });
  const past = new Date(Date.now() - 2 * 60 * 60 * 1000);
  for (const name of ['used.webp', 'used-c320.webp', 'store.webp', 'chat.webp', 'orphan.webp', 'orphan-c320.webp', 'fresh.webp']) {
    const file = path.join(uploads, name);
    fs.writeFileSync(file, name);
    if (name !== 'fresh.webp') fs.utimesSync(file, past, past);
  }
  fs.mkdirSync(path.join(uploads, 'subdirectory'));
  const run = (...args) => execFileSync(process.execPath, [path.join(__dirname, '../scripts/sweep-uploads.js'), ...args], {
    env: { ...process.env, STORE_DATA_DIR: dir }, encoding: 'utf8'
  });
  run();
  assert.equal(fs.existsSync(path.join(uploads, 'orphan.webp')), true, 'предпросмотр ничего не удаляет');
  run('--quarantine');
  assert.deepEqual(fs.readdirSync(uploads).sort(), ['chat.webp', 'fresh.webp', 'store.webp', 'subdirectory', 'used-c320.webp', 'used.webp']);
  const backups = path.join(dir, 'backups');
  const folders = fs.readdirSync(backups);
  assert.equal(folders.length, 1);
  const saved = path.join(backups, folders[0]);
  assert.deepEqual(fs.readdirSync(saved).sort(), ['orphan-c320.webp', 'orphan.webp']);
  assert.equal(fs.readFileSync(path.join(saved, 'orphan.webp'), 'utf8'), 'orphan.webp');
  run('--quarantine');
  assert.deepEqual(fs.readdirSync(backups), folders, 'повторная уборка не создаёт пустые карантины');
});
