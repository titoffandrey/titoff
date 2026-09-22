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

test('TailAdmin: ряды продаж сохраняют оплаченные суммы и московскую границу дня', () => {
  const { salesSeries } = require('../lib/admin-charts');
  const now = Date.parse('2026-09-22T10:00:00Z');
  const rows = [
    { createdAt: Date.parse('2026-09-21T20:59:59Z'), total: 100, payment: { status: 'paid' } },
    { createdAt: Date.parse('2026-09-21T21:00:00Z'), total: 200, manualPaid: true },
    { createdAt: Date.parse('2026-09-22T08:00:00Z'), total: 300, payment: { status: 'refunded' } },
    { createdAt: now + 10000, total: 999, payment: { status: 'paid' } },
    { createdAt: 'wrong', total: 999 }
  ];
  const data = salesSeries(rows, 2, now);
  assert.deepEqual(data.total, [100, 500]);
  assert.deepEqual(data.revenue, [100, 200]);
  assert.deepEqual(data.count, [1, 2]);
  const year = salesSeries([{ createdAt: now - 364 * 86400000, total: 500, manualPaid: true }], 365, now);
  assert.equal(year.revenue.reduce((a, b) => a + b), 500, 'не теряется неполный месяц на начале годового периода');
  assert.deepEqual(salesSeries([], 1, now).count, [0]);
});

test('TailAdmin: данные графика безопасны, а все исходные блоки обзора присутствуют', () => {
  const dangerous = '</div><script>alert(1)</script>';
  const chart = TA.chart('barChart', 'test', { labels: [dangerous], series: [{ name: 'Заказы', data: [0] }] }, { TITLE: 'Проверка', CONTROLS: '' });
  assert.doesNotMatch(chart, /<script>alert/);
  assert.match(chart, /&lt;script&gt;/);
  const templates = require('../public/tailadmin-components.json');
  for (const slot of ['METRICS','BAR','RADIAL','AREA','ACTIVITY','RECENT']) assert.ok(templates.dashboard.includes('@@' + slot + '@@'), slot);
  assert.match(templates.recentOrders, /<thead/);
  assert.match(templates.recentOrders, /@@ROWS@@/);
  assert.match(templates.themeToggle, /data-ta-theme/);
  assert.match(templates.profileMenu, /<details/);
});

test('TailAdmin: тема восстанавливается до отрисовки и не требует доступного localStorage', () => {
  const vm = require('node:vm');
  for (const value of ['true', 'false', null]) {
    const states = {};
    const context = { document: { documentElement: { classList: { toggle: (key, value) => { states[key] = value; } } } }, localStorage: { getItem: key => key === 'darkMode' ? value : 'false' } };
    vm.runInNewContext(TA.themeBoot.replace(/<\/?script>/g, ''), context);
    assert.equal(states.dark, value === 'true');
  }
  assert.doesNotThrow(() => vm.runInNewContext(TA.themeBoot.replace(/<\/?script>/g, ''), { localStorage: { getItem() { throw new Error('blocked'); } } }));
});
