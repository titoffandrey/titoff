'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const A = require('../lib/admin-views');
const R = require('../lib/render');

const SETTINGS = { storeName: 'Магазин', currency: '₽', currencyPosition: 'after' };

function order(id, patch) {
  return Object.assign({
    id, number: '700101', customerName: 'Анна', createdAt: Date.now(),
    items: [], total: 1000, payment: null
  }, patch);
}

function render(orders, filters) {
  const db = {
    getOrders: () => orders, visibleOrders: () => orders,
    getProducts: () => [], visibleProducts: () => [], pendingReviewCount: () => 0
  };
  return A.ordersList(SETTINGS, db, null, 1, false, filters || {});
}

function rowIds(html) {
  return [...html.matchAll(/id="order-([^"]+)"/g)].map(match => match[1]);
}

function orderRow(html, id) {
  const row = [...html.matchAll(/<tr\b[^>]*>[\s\S]*?<\/tr>/g)]
    .map(match => match[0]).find(value => value.includes(`id="order-${id}"`));
  assert.ok(row, 'заказ присутствует в списке: ' + id);
  return row;
}

// Удаляем раскрытия целиком, включая вложенные. Оставшаяся разметка должна
// давать основные сведения и контакты без дополнительных нажатий.
function withoutDetails(html) {
  let depth = 0, end = 0, visible = '';
  for (const match of html.matchAll(/<\/?details\b[^>]*>/g)) {
    if (!depth) visible += html.slice(end, match.index);
    depth += match[0].startsWith('</') ? -1 : 1;
    assert.ok(depth >= 0, 'раскрытия правильно вложены');
    end = match.index + match[0].length;
  }
  assert.equal(depth, 0, 'все раскрытия закрыты');
  return visible + html.slice(end);
}

function actionFields(html, action) {
  const forms = [...html.matchAll(/<form\b[^>]*>[\s\S]*?<\/form>/g)].map(match => match[0]);
  const form = forms.find(value => value.includes(`action="${action}"`));
  assert.ok(form, 'действие заказа остаётся доступным: ' + action);
  const fields = {};
  for (const input of form.matchAll(/<input\b[^>]*>/g)) {
    const name = input[0].match(/\bname="([^"]*)"/);
    const value = input[0].match(/\bvalue="([^"]*)"/);
    if (name && value) fields[name[1]] = value[1];
  }
  return fields;
}

// Исполняем настоящий helper возврата, не поднимая сервер и не совершая
// удаления. Так проверяется переход формы обратно к той же выборке.
function ordersBackUrl(body) {
  const source = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8');
  const start = source.indexOf('const ordersBackUrl =');
  const end = source.indexOf('\n};', start);
  assert.ok(start >= 0 && end > start, 'helper возврата найден');
  const back = vm.runInNewContext(source.slice(start, end + 3) + '\nordersBackUrl;', { R });
  return back(body);
}

test('заказы: истёкший черновик фильтруется по видимому статусу оплаты', () => {
  const expired = order('expired-draft', { draft: true, createdAt: Date.now() - 31 * 60000 });
  const fresh = order('fresh-draft', { draft: true });
  assert.equal(R.orderTone(expired), 'off');
  assert.equal(R.orderTone(fresh), 'draft');
  assert.deepEqual(rowIds(render([expired, fresh], { pay: 'draft' })), ['fresh-draft']);
  assert.deepEqual(rowIds(render([expired, fresh], { pay: 'off' })), ['expired-draft']);
});

test('заказы: незавершённая оплата имеет точный фильтр и сохраняется после действия', () => {
  const idle = order('idle', { payment: { status: 'failed', startedAt: Date.now() } });
  const otherClient = order('other-idle', {
    customerName: 'Борис', payment: { status: 'pending', startedAt: Date.now() }
  });
  const waiting = order('waiting', { payment: {
    status: 'pending', invoiceId: 'invoice-waiting', requisite: '79990000000',
    expiresAt: Date.now() + 600000
  } });
  const mismatch = order('mismatch', { payment: { status: 'mismatch' } });
  const orders = [idle, otherClient, waiting, mismatch];
  assert.equal(R.orderTone(idle), 'idle');
  assert.deepEqual(rowIds(render(orders, { pay: 'idle' })), ['idle', 'other-idle']);
  assert.deepEqual(rowIds(render(orders, { pay: 'warn' })), ['mismatch']);

  const html = render(orders, { pay: 'idle', q: 'Анна', period: '7' });
  assert.deepEqual(rowIds(html), ['idle']);
  const body = actionFields(html, '/admin/orders/idle/delete');
  const returned = new URL(ordersBackUrl(body), 'https://shop.test');
  assert.equal(returned.searchParams.get('pay'), 'idle');
  assert.equal(returned.searchParams.get('q'), 'Анна');
  assert.equal(returned.searchParams.get('period'), '7');
  assert.deepEqual(rowIds(render(orders, Object.fromEntries(returned.searchParams))), ['idle']);
});

test('заказы: ручная сверка проверяет показанный живой счёт из истории попыток', () => {
  const now = Date.now();
  const live = {
    id: 'a'.repeat(24), status: 'pending', invoiceId: 'invoice-live', method: 'SBP',
    requisite: '79990000000', expiresAt: now + 600000, startedAt: now - 120000
  };
  const closed = {
    id: 'b'.repeat(24), status: 'failed', invoiceId: 'invoice-closed', method: 'SBP',
    requisite: '79991111111', expiresAt: now - 60000, closedAt: now - 60000,
    startedAt: now - 90000, note: 'Счёт закрыт без оплаты'
  };
  const mixed = order('mixed-attempts', {
    payment: Object.assign({}, closed, { attemptId: closed.id, attempts: [live, closed] })
  });
  assert.equal(R.orderTone(mixed, now), 'wait');
  assert.equal(R.payDisplay(mixed.payment, now).id, live.id);
  const body = actionFields(render([mixed]), '/admin/orders/mixed-attempts/reconcile');
  assert.equal(body.attemptId, live.id, 'сверка относится к счёту, по которому ждём перевод');
});

test('заказы: быстрые контакты доступны без раскрытия и соответствуют данным клиента', () => {
  const allContacts = order('all-contacts', { phone: '+79991234567', contact: '@example_user' });
  const email = order('email', { phone: '+79991234567', contact: 'client@example.com' });
  const withoutPhone = order('without-phone', { contact: 'https://t.me/example_user' });
  const absent = order('absent');
  const html = render([allContacts, email, withoutPhone, absent]);
  const visible = item => withoutDetails(orderRow(html, item.id));
  const contactRow = visible(allContacts);
  for (const href of [R.orderTelHref(allContacts), R.orderTelegramHref(allContacts, SETTINGS), R.orderWaHref(allContacts, SETTINGS)]) {
    assert.ok(href, 'контакт имеет адрес');
    assert.ok(contactRow.includes(`href="${R.esc(href)}"`), 'контакт доступен вне раскрытий: ' + href.split('?')[0]);
  }
  assert.match(contactRow, />Позвонить<\/span>/);
  assert.match(contactRow, />Telegram<\/span>/);
  assert.match(contactRow, />WhatsApp<\/span>/);
  assert.doesNotMatch(visible(email), /href="https:\/\/t\.me\//, 'адрес почты не превращается в аккаунт Telegram');
  assert.match(visible(email), /href="tel:\+79991234567"/, 'почта не отменяет существующий телефон');
  assert.match(visible(withoutPhone), /href="https:\/\/t\.me\/example_user\?text=/);
  for (const item of [withoutPhone, absent]) {
    assert.doesNotMatch(orderRow(html, item.id), /href="(?:tel:|https:\/\/wa\.me\/)/, 'без телефона нет пустой ссылки для звонка или WhatsApp');
  }
  assert.doesNotMatch(orderRow(html, absent.id), /href="https:\/\/t\.me\//);
  assert.match(visible(absent), /Контакты не указаны/);
});

test('заказы: имя, сумма, статус, товары и доставка видны сразу, банковские подробности раскрываются отдельно', () => {
  const paid = order('main-info', {
    customerName: 'Анна Смирнова', total: 12345, phone: '+79991234567',
    items: [{ name: 'Тестовый планшет', price: 12345, qty: 1 }],
    delivery: 'cdek', deliveryMode: 'pvz', pickupAddress: 'Тестовый пункт выдачи',
    payment: { status: 'paid', method: 'SBP', note: 'Платёж подтверждён банком' }
  });
  const row = orderRow(render([paid]), paid.id);
  const visible = withoutDetails(row);
  assert.match(visible, /Анна Смирнова/);
  assert.match(visible, /Сумма заказа/);
  assert.match(visible, /12\s?345\s?₽/);
  assert.match(visible, /Статус оплаты/);
  assert.match(visible, /оплачено/);
  for (const primary of ['Тестовый планшет', 'Тестовый пункт выдачи']) {
    assert.ok(visible.includes(primary), 'товары и доставка доступны без раскрытия: ' + primary);
  }
  assert.ok(row.includes('Платёж подтверждён банком'), 'банковская диагностика сохранена');
  assert.ok(!visible.includes('Платёж подтверждён банком'), 'банковская диагностика остаётся в раскрытии');
  assert.doesNotMatch(row, /<details\b[^>]*class="[^"]*\bof-order-details\b/);
  assert.match(row, /href="\/receipt\/main-info"/, 'чек оплаченного заказа сохранён');
});

test('заказы: оформление подключается только к списку заказов', () => {
  const db = {
    getOrders: () => [], visibleOrders: () => [], getProducts: () => [], visibleProducts: () => [],
    categories: () => [], visibleCategories: () => [], pendingReviewCount: () => 0,
    ratingFor: () => ({ avg: 0, count: 0 })
  };
  const focusedStyles = /href="\/static\/admin-orders\.css\?v=/;
  assert.match(A.ordersList(SETTINGS, db, null, 1), focusedStyles);
  assert.doesNotMatch(A.dashboard(SETTINGS, db), focusedStyles);
  assert.doesNotMatch(R.homePage(SETTINGS, db, {}), focusedStyles);
});
