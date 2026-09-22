'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const views = require('../lib/admin-views');
const TA = require('../lib/tailadmin');
const root = path.join(__dirname, '..');

test('TailAdmin: сохранённые файлы совпадают с оригинальными исходниками', () => {
  const manifest = require('../vendor/tailadmin/upstream.json');
  assert.equal(manifest.repository, 'https://github.com/TailAdmin/tailadmin-free-tailwind-dashboard-template');
  for (const [file, expected] of Object.entries(manifest.files)) {
    const contents = fs.readFileSync(path.join(root, 'vendor/tailadmin/upstream', file));
    assert.equal(createHash('sha256').update(contents).digest('hex'), expected, file);
  }
  const license = fs.readFileSync(path.join(root, 'public/tailadmin.LICENSE.txt'), 'utf8');
  assert.match(license, /MIT License/);
  assert.match(license, /TailAdmin/);
});

test('TailAdmin: компоненты не содержат действий из демо и не требуют Alpine', () => {
  const templates = require('../public/tailadmin-components.json');
  for (const name of ['sidebar', 'header', 'metric', 'recentOrders', 'signin']) {
    assert.ok(templates[name].length > 100, name);
    assert.match(templates[name], /data-tailadmin-component=/);
  }
  for (const html of Object.values(templates)) {
    assert.doesNotMatch(html, /(?:x-data|x-text|x-show|@click|:class)=/);
    assert.doesNotMatch(html, /Purchase Plan|info@gmail.com|href="https?:|src="https?:|signup\.html|reset-password\.html/);
  }
  assert.doesNotMatch(fs.readFileSync(path.join(root, 'public/tailadmin.css'), 'utf8'), /fonts\.googleapis|@import/);
});

test('TailAdmin: имя магазина экранируется, подстановка слотов не рекурсивна', () => {
  const login = views.loginPage({ storeName: '<img src=x onerror=alert(1)>@@ERROR@@' }, null);
  assert.doesNotMatch(login, /<img src=x/);
  assert.match(login, /&lt;img src=x onerror=alert\(1\)&gt;@@ERROR@@/);
  assert.equal((login.match(/name="username"/g) || []).length, 1);
  assert.equal((login.match(/name="password"/g) || []).length, 1);
  assert.match(login, /method="post" action="\/admin\/login"/);
  assert.throws(() => TA.render('metric', {}), /missing ICON/);
});
