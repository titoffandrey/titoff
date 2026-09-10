'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const A = require('../lib/admin-views');
const R = require('../lib/render');

const SETTINGS = { storeName: 'Магазин', currency: '₽', currencyPosition: 'after' };

function order(id, patch) {
  return Object.assign({
    id, number: '700101', customerName: 'Анна', createdAt: Date.now(),
    total: 1000, items: [], payment: null, payMode: 'own'
  }, patch);
}

function render(orders, filters, page) {
  const db = {
    getOrders: () => orders, visibleOrders: () => orders,
    getProducts: () => [], visibleProducts: () => [], pendingReviewCount: () => 0
  };
  const f = filters || {};
  return A.ordersList(SETTINGS, db, null, page || 1, f.edit, f);
}

function attribute(html, name) {
  const value = html.match(new RegExp('\\b' + name + '="([^"]*)"'));
  return value ? value[1].replace(/&amp;/g, '&').replace(/&quot;/g, '"') : '';
}

function element(html, className) {
  const first = [...html.matchAll(/<([a-z][a-z0-9]*)\b[^>]*>/gi)]
    .find(match => attribute(match[0], 'class').split(/\s+/).includes(className));
  assert.ok(first, 'элемент существует: .' + className);
  const rest = html.slice(first.index);
  let depth = 0;
  for (const tag of rest.matchAll(new RegExp('<\\/?' + first[1] + '\\b[^>]*>', 'gi'))) {
    depth += tag[0].startsWith('</') ? -1 : 1;
    if (!depth) return rest.slice(0, tag.index + tag[0].length);
  }
  assert.fail('элемент не закрыт: .' + className);
}

function row(html, id) {
  const found = [...html.matchAll(/<tr\b[^>]*>[\s\S]*?<\/tr>/g)]
    .map(match => match[0]).find(value => value.includes(`id="order-${id}"`));
  assert.ok(found, 'заказ присутствует: ' + id);
  return found;
}

function withoutDetails(html) {
  let depth = 0, end = 0, out = '';
  for (const tag of html.matchAll(/<\/?details\b[^>]*>/g)) {
    if (!depth) out += html.slice(end, tag.index);
    depth += tag[0].startsWith('</') ? -1 : 1;
    assert.ok(depth >= 0);
    end = tag.index + tag[0].length;
  }
  assert.equal(depth, 0);
  return out + html.slice(end);
}

function text(html) { return html.replace(/<[^>]*>/g, '').trim(); }

test('компактные заказы: все позиции и полная доставка видны без раскрытия', () => {
  const source = order('full-content', {
    items: Array.from({ length: 5 }, (_, i) => ({ name: 'Позиция ' + (i + 1), price: 1000, qty: i + 1 })),
    delivery: 'cdek', deliveryMode: 'pvz', deliveryPrice: 710,
    pickupCode: 'MSK123', pickupAddress: 'Москва, улица Выдачи, 5',
    address: 'Москва, улица Покупателя, 9', comment: 'Позвоните перед выдачей'
  });
  const html = row(render([source]), source.id);
  const visible = withoutDetails(html);
  const items = element(visible, 'of-items');
  const delivery = element(visible, 'of-delivery');
  for (const item of source.items) assert.ok(items.includes(item.name), 'видна позиция: ' + item.name);
  assert.ok(items.includes(R.orderItems(source, { all: true })), 'состав сохраняет названия, количества и цены');
  assert.doesNotMatch(items, /<details\b/, 'длинный состав не прячет четвёртую и пятую позиции');
  assert.ok(delivery.includes(R.orderDelivery(source, { money: SETTINGS })), 'выведена вся информация доставки');
  for (const value of [source.pickupCode, source.pickupAddress, source.address, source.comment]) {
    assert.ok(delivery.includes(value), 'сохранены данные доставки: ' + value);
  }
  assert.doesNotMatch(html, /<details\b[^>]*class="[^"]*\bof-order-details\b/);
  assert.match(html, /<details\b[^>]*class="[^"]*\bof-payment-details\b/, 'платёжные действия остаются в своём раскрытии');
});

test('компактные заказы: рядом с именем иконка устройства, география полная и с флагом', () => {
  const source = order('customer', {
    customerName: 'Анна Смирнова', clientCity: 'Moscow', clientRegion: 'Московская область',
    clientCountry: 'Россия', clientCountryCode: 'RU', clientDevice: 'Компьютер',
    clientModel: 'MacBook Air', clientOs: 'macOS 15', clientBrowser: 'Safari 18'
  });
  const customer = element(withoutDetails(row(render([source]), source.id)), 'of-customer');
  const heading = customer.match(/<h2\b[^>]*>[\s\S]*?<\/h2>/);
  assert.ok(heading);
  assert.ok(heading[0].includes('Анна Смирнова'));
  const device = element(customer, 'of-device');
  assert.match(device, /<svg\b/);
  assert.equal(text(device), '', 'устройство обозначено иконкой, без отдельной текстовой строки');
  assert.doesNotMatch(text(customer), /MacBook Air|Компьютер|macOS 15|Safari 18/);
  const city = element(customer, 'of-city');
  for (const value of ['Москва', 'Московская область', 'Россия', '🇷🇺']) assert.ok(city.includes(value), 'видна география: ' + value);
});

test('компактные заказы: банк показанного счёта виден сразу, платёжные формы сохранены', () => {
  const now = Date.now();
  const live = {
    id: 'a'.repeat(24), status: 'pending', invoiceId: 'invoice-live', method: 'SBP', bank: 'Сбербанк',
    requisite: '79990000000', expiresAt: now + 600000, startedAt: now - 120000
  };
  const closed = {
    id: 'b'.repeat(24), status: 'failed', invoiceId: 'invoice-closed', method: 'SBP', bank: 'ВТБ',
    requisite: '79991111111', expiresAt: now - 60000, closedAt: now - 60000, startedAt: now - 90000
  };
  const source = order('bank', { payMode: '', payment: { ...closed, attemptId: closed.id, attempts: [live, closed] } });
  const html = row(render([source]), source.id);
  const bank = element(withoutDetails(html), 'of-bank');
  const mark = R.orderBankMark(source, now);
  assert.ok(mark, 'для выданного счёта есть банковская отметка');
  assert.ok(bank.includes(mark), 'список использует банковскую отметку фактически показанной попытки');
  const paymentDetails = element(html, 'of-payment-details');
  assert.match(paymentDetails, /action="\/admin\/orders\/bank\/reconcile"/);
  assert.match(paymentDetails, /name="attemptId" value="aaaaaaaaaaaaaaaaaaaaaaaa"/);
  assert.match(html, /action="\/admin\/orders\/bank\/delete"/);
});

test('компактные заказы: счётчик оплат учитывает поиск и период до фильтра статуса', () => {
  const orders = [
    order('paid', { payment: { status: 'paid' } }),
    order('manual', { manualPaid: { at: Date.now(), by: 'admin' } }),
    order('mismatch', { payment: { status: 'mismatch' } }),
    order('old-paid', { createdAt: Date.now() - 8 * 86400000, payment: { status: 'paid' } }),
    order('other-paid', { customerName: 'Борис', payment: { status: 'paid' } }),
    ...Array.from({ length: 55 }, (_, index) => order('waiting-' + index))
  ];
  const html = render(orders, { q: 'Анна', period: '7', pay: 'wait', edit: '1' }, 2);
  const topbar = element(html, 'a-topbar');
  assert.equal(attribute(topbar, 'data-live-part'), 'topbar');
  const badge = element(element(topbar, 'of-orders-heading'), 'of-paid-count');
  assert.equal(text(badge), 'Оплатили (2)', 'учтены касса и ручная оплата, исключены mismatch, чужой поиск и старый заказ');
  assert.doesNotMatch(badge, /\bdata-live-part=/, 'бейдж обновляется через существующую шапку без вложенных live-блоков');
  const href = new URL(attribute(badge, 'href'), 'https://shop.test');
  assert.equal(href.pathname, '/admin/orders');
  for (const [name, value] of Object.entries({ q: 'Анна', period: '7', pay: 'ok', edit: '1' })) {
    assert.equal(href.searchParams.get(name), value);
  }
  assert.equal(Number(href.searchParams.get('page') || 1), 1, 'переход из второй страницы начинает список оплат с первой');
  assert.doesNotMatch(html, /id="order-paid"|id="order-manual"/, 'фильтр ожидания по-прежнему применён к строкам');
  assert.equal(text(element(render(orders, { q: 'Никого', period: '7' }), 'of-paid-count')), 'Оплатили (0)');
});

test('компактные заказы: строки сохраняют фактические классы оплаченного и ожидающего заказа', () => {
  const paid = order('tone-paid', { payment: { status: 'paid' } });
  const waiting = order('tone-wait');
  const html = render([paid, waiting]);
  assert.equal(R.orderRowClass(paid), 'o-row o-row-ok');
  assert.equal(R.orderRowClass(waiting), 'o-row o-row-wait');
  assert.equal(attribute(row(html, paid.id), 'class'), R.orderRowClass(paid));
  assert.equal(attribute(row(html, waiting.id), 'class'), R.orderRowClass(waiting));
});
