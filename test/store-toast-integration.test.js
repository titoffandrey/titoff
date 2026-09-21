'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const R = require('../lib/render');
const A = require('../lib/admin-views');
const minify = require('../lib/minify');

const root = path.join(__dirname, '..');
const settings = { storeName: 'Тестовый магазин', currency: '₽', currencyPosition: 'after' };
const db = {
  getProducts: () => [], visibleProducts: () => [], getOrders: () => [], visibleOrders: () => [],
  pendingReviewCount: () => 0
};

function checkAssets(html, applicationScript) {
  const css = [...html.matchAll(/<link\b[^>]*href="(\/static\/smoothui-toast\.css\?v=[^"]+)"[^>]*>/g)];
  const js = [...html.matchAll(/<script\b[^>]*src="(\/static\/smoothui-toast\.js\?v=[^"]+)"[^>]*><\/script>/g)];
  assert.equal(css.length, 1, 'страница загружает стили исходного BasicToast один раз');
  assert.equal(js.length, 1, 'страница загружает общий движок один раз');
  assert.match(js[0][0], /\bdefer\b/);
  assert.ok(html.indexOf(css[0][0]) < html.indexOf('</head>'));
  if (applicationScript) assert.ok(html.indexOf(js[0][0]) < html.indexOf('/static/' + applicationScript));
}

test('витрина, админка и вход подключают одинаковый движок уведомлений до своих обработчиков', () => {
  const storefront = R.layout(settings, { title: 'Проверка', body: '<p>Содержимое</p>' });
  const admin = A.settingsPage(settings, db, 'Сохранено');
  const login = A.loginPage(settings, 'Неверный пароль');
  checkAssets(storefront, 'app.js');
  checkAssets(admin, 'admin-ui.js');
  checkAssets(login);
  assert.match(storefront, /id="toast"[^>]*data-store-toast[^>]*hidden/);
  assert.match(admin, /data-store-toast data-toast-type="success"/);
  assert.match(login, /data-store-toast data-toast-type="error"/);
  assert.match(login, /Неверный пароль/);
  assert.doesNotMatch(storefront + admin + login, /data-toast-duration=/);
});

test('ошибки и информационные ответы сервера передают тип без пользовательской разметки', () => {
  const error = A.settingsPage(settings, db, '<img src=x onerror=alert(1)>', 'err', { draft: {} });
  const waiting = A.ordersList(settings, db, 'Касса ещё ждёт оплату', 1);
  const account = R.accountAuthPage(settings, { error: 'Не удалось сохранить' });
  assert.match(error, /data-toast-type="error"/);
  assert.doesNotMatch(error, /<img src=x/);
  assert.match(waiting, /data-toast-type="info"/);
  assert.match(account, /data-store-toast data-toast-type="error"/);
  assert.doesNotMatch(error + waiting + account, /data-toast-duration=/);
  const adminHint = A.settingsPage(settings, db, 'Укажите название магазина', 'err', { draft: {} });
  const accountHint = R.accountAuthPage(settings, { error: 'Укажите e-mail' });
  assert.match(adminHint, /data-toast-type="info"/);
  assert.match(accountHint, /data-toast-type="info"/);
});

test('готовые файлы SmoothUI отдаются без повторной минификации и сохраняют атрибуцию', () => {
  for (const file of ['smoothui-toast.js', 'smoothui-toast.css']) {
    const full = path.join(root, 'public', file);
    const bytes = fs.readFileSync(full);
    assert.match(bytes.toString('utf8', 0, 350), /SmoothUI Basic Toast.*MIT/);
    assert.deepEqual(minify.forFile(full, bytes), bytes);
  }
});
