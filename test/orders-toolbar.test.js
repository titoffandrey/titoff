'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const A = require('../lib/admin-views');
const R = require('../lib/render');

const SETTINGS = { storeName: 'Магазин', currency: '₽', currencyPosition: 'after', chatEnabled: false };
const QUERY = 'Анна & Борис';
const FILTERS = { q: QUERY, pay: 'ok', period: '-1', edit: '1' };
const yesterday = () => R.mskDayStart(Date.now()) - 12 * 60 * 60000;

function order(id, patch) {
  return Object.assign({
    id, number: '700101', customerName: QUERY, createdAt: yesterday(),
    total: 1000, items: [], payment: { status: 'paid' }
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

function unescape(value) {
  return value.replace(/&(?:amp|quot|lt|gt|#39|#x27);/g, entity => ({
    '&amp;': '&', '&quot;': '"', '&lt;': '<', '&gt;': '>', '&#39;': "'", '&#x27;': "'"
  })[entity]);
}

function attribute(tag, name) {
  const found = tag.match(new RegExp('\\b' + name + '="([^"]*)"'));
  return found ? unescape(found[1]) : '';
}

// Находим элемент целиком с учётом вложенных div/details: одна регулярка
// до первого закрывающего тега потеряла бы половину панели или карточки.
function element(html, className) {
  const found = [...html.matchAll(/<([a-z][a-z0-9]*)\b[^>]*>/gi)]
    .find(match => attribute(match[0], 'class').split(/\s+/).includes(className));
  assert.ok(found, 'элемент существует: .' + className);
  let depth = 0;
  const rest = html.slice(found.index);
  for (const tag of rest.matchAll(new RegExp('<\\/?' + found[1] + '\\b[^>]*>', 'gi'))) {
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
  assert.equal(depth, 0, 'раскрытия закрыты');
  return out + html.slice(end);
}

function links(html) {
  return [...html.matchAll(/<a\b[^>]*>[\s\S]*?<\/a>/g)].map(match => ({
    html: match[0], url: new URL(attribute(match[0], 'href'), 'https://shop.test'),
    text: unescape(match[0].replace(/<[^>]*>/g, '')).trim()
  }));
}

function inputs(form) {
  return [...form.matchAll(/<input\b[^>]*>/g)].map(match => ({
    type: attribute(match[0], 'type'), name: attribute(match[0], 'name'),
    value: attribute(match[0], 'value')
  }));
}

function expectParams(url, expected) {
  assert.equal(url.pathname, '/admin/orders');
  for (const [key, value] of Object.entries(expected)) {
    assert.equal(url.searchParams.get(key), value, 'параметр ' + key + ': ' + url.pathname + url.search);
  }
}

function ordersBackUrl(body) {
  const source = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8');
  const start = source.indexOf('const ordersBackUrl =');
  const end = source.indexOf('\n};', start);
  assert.ok(start >= 0 && end > start);
  const back = vm.runInNewContext(source.slice(start, end + 3) + '\nordersBackUrl;', { R });
  return new URL(back(body), 'https://shop.test');
}

test('панель заказов: город клиента переведён и виден сразу, доставка его не подменяет', () => {
  const orders = [
    order('berlin', { clientCity: 'Berlin', clientCountryCode: 'DE', address: 'Москва, улица Доставки' }),
    order('moscow', { clientCity: 'Moscow', clientCountry: 'Россия', address: 'Казань, улица Доставки' }),
    order('unknown', { clientCity: '', pickupAddress: 'Санкт-Петербург, пункт выдачи' })
  ];
  const html = render(orders);
  for (const [id, city] of [['berlin', 'Берлин'], ['moscow', 'Москва'], ['unknown', 'Город не определён']]) {
    const customer = element(withoutDetails(row(html, id)), 'of-customer');
    const cityElement = element(customer, 'of-city');
    assert.ok(cityElement.includes(city), id + ': город виден рядом с клиентом');
    assert.equal(attribute(cityElement, 'title'), 'Местоположение по IP');
    assert.doesNotMatch(cityElement, /улица Доставки|Санкт-Петербург|пункт выдачи/);
  }
  assert.doesNotMatch(element(row(html, 'berlin'), 'of-city'), /Москва|Berlin/);
});

test('панель заказов: чат сайта рядом с мессенджерами доступен только для корректного посетителя', () => {
  const valid = order('chat', { visitorId: 'ab'.repeat(16), phone: '+79991234567', contact: '@example_user' });
  const missing = order('no-visitor', { phone: '+79991234567', contact: '@example_user' });
  const invalid = order('bad-visitor', { visitorId: 'x/?id=42&to=other', phone: '+79991234567' });
  const html = render([valid, missing, invalid]);
  const contacts = element(withoutDetails(row(html, valid.id)), 'of-contact-actions');
  const chat = element(contacts, 'of-chat');
  assert.ok(attribute(chat, 'class').split(/\s+/).includes('of-contact'));
  assert.equal(attribute(chat, 'href'), '/admin/chat/new?to=' + encodeURIComponent(valid.visitorId));
  assert.ok(element(contacts, 'of-whatsapp'));
  assert.ok(element(contacts, 'of-telegram'));
  assert.equal(SETTINGS.chatEnabled, false, 'открытие карточки чата не зависит от включённого виджета');
  for (const item of [missing, invalid]) {
    assert.doesNotMatch(row(html, item.id), /class="[^"]*\bof-chat\b/, 'битая ссылка на чат не показывается');
    assert.doesNotMatch(row(html, item.id), /href="\/admin\/chat\/new\?to=/);
  }
});

test('панель заказов: поиск отделён от меню и передаёт выбранные фильтры через GET', () => {
  const html = render([order('search')], FILTERS);
  const toolbar = element(html, 'of-toolbar');
  const search = element(toolbar, 'o-filters');
  assert.match(search, /^<form\b/);
  assert.equal(attribute(search, 'method'), 'get');
  assert.equal(attribute(search, 'action'), '/admin/orders');
  assert.doesNotMatch(search, /<select\b|\bgs-days\b|\bgs-payment\b/);
  const fields = inputs(search);
  assert.deepEqual(fields.filter(field => field.type !== 'hidden').map(field => [field.type, field.name]), [['search', 'q']]);
  for (const [name, value] of Object.entries({ pay: 'ok', period: '-1', edit: '1' })) {
    assert.ok(fields.some(field => field.type === 'hidden' && field.name === name && field.value === value), 'скрытый фильтр ' + name);
  }
  const submitted = new URL('/admin/orders', 'https://shop.test');
  submitted.search = new URLSearchParams(fields.map(field => [field.name, field.value])).toString();
  expectParams(submitted, { q: QUERY, pay: 'ok', period: '-1', edit: '1' });
  const period = element(toolbar, 'a-period');
  assert.match(element(period, 'gs-days'), /^<details\b[^>]*\bdata-menu/);
  assert.match(element(period, 'gs-payment'), /^<details\b[^>]*\bdata-menu/);
});

test('панель заказов: обычные ссылки дат и оплаты сохраняют соседние фильтры и поиск', () => {
  const html = render([order('menus')], FILTERS);
  const toolbar = element(html, 'of-toolbar');
  const dateLinks = links(element(toolbar, 'gs-days'));
  const yesterdayLink = dateLinks.find(link => link.text === 'Вчера');
  assert.ok(yesterdayLink, 'Вчера доступно в меню дат');
  expectParams(yesterdayLink.url, { q: QUERY, pay: 'ok', period: '-1', edit: '1' });
  assert.match(yesterdayLink.html, /aria-current="true"/);
  for (const link of dateLinks) {
    expectParams(link.url, { q: QUERY, pay: 'ok', edit: '1', page: null });
  }
  const paymentLinks = links(element(toolbar, 'gs-payment'));
  assert.ok(paymentLinks.some(link => link.url.searchParams.get('pay') === 'idle'), 'незавершённая оплата не потерялась');
  assert.ok(paymentLinks.some(link => link.url.searchParams.get('pay') === 'ok'));
  for (const link of paymentLinks) {
    expectParams(link.url, { q: QUERY, period: '-1', edit: '1', page: null });
  }
});

test('панель заказов: сброс поиска и сброс фильтров работают независимо', () => {
  const toolbar = element(render([order('reset')], FILTERS), 'of-toolbar');
  const searchReset = links(element(toolbar, 'o-filters')).find(link => link.text === 'Сбросить');
  assert.ok(searchReset, 'у поиска есть собственный сброс');
  expectParams(searchReset.url, { q: null, pay: 'ok', period: '-1', edit: '1', page: null });
  const filterReset = links(element(toolbar, 'a-period')).find(link => link.text === 'Сбросить фильтры');
  assert.ok(filterReset, 'у фильтров есть собственный сброс');
  expectParams(filterReset.url, { q: QUERY, pay: null, period: null, edit: '1', page: null });
});

test('панель заказов: Вчера сохраняется в пагинации и после POST-действия', () => {
  const orders = Array.from({ length: 106 }, (_, index) => order('page-' + index));
  const html = render(orders, FILTERS, 2);
  const pagerLinks = links(element(html, 'a-pager'));
  assert.ok(pagerLinks.some(link => link.url.searchParams.get('page') === '3'));
  for (const link of pagerLinks) {
    expectParams(link.url, { q: QUERY, pay: 'ok', period: '-1', edit: '1' });
  }
  const action = [...html.matchAll(/<form\b[^>]*>[\s\S]*?<\/form>/g)]
    .map(match => match[0]).find(form => /action="\/admin\/orders\/[^/]+\/delete"/.test(form));
  assert.ok(action, 'POST-действие есть на второй странице');
  const body = Object.fromEntries(inputs(action).map(field => [field.name, field.value]));
  assert.equal(body.period, '-1');
  expectParams(ordersBackUrl(body), { page: '2', q: QUERY, pay: 'ok', period: '-1', edit: '1' });
});
