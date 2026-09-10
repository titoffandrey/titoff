'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const R = require('../lib/render');
const A = require('../lib/admin-views');
const TRACK = require('../lib/tracking');

const SETTINGS = { storeName: 'iStore', currency: '₽', currencyPosition: 'after' };
const ORIGIN = 'https://shop.example';
const OPTIONS = { origin: ORIGIN };
const TOKEN_A = 'a'.repeat(32);
const TOKEN_B = 'b'.repeat(32);
const TOKEN_C = 'c'.repeat(32);

function shipment(token) {
  return {
    ...TRACK.normalize(TRACK.build({
      carrier: 'cdek', mode: 'pvz', from: 'Москва', to: 'Казань',
      zone: 'pfo', seed: 'message-test', startedAt: Date.now(), days: 4
    })),
    token
  };
}

function order(patch) {
  return {
    id: 'order-a', number: '700101', createdAt: Date.now(),
    firstName: 'анна', customerName: 'анна Петрова', phone: '+79991234567',
    contact: '@anna_example', total: 8490,
    items: [{ name: 'AirTag', price: 3490, qty: 2 }],
    ...patch
  };
}

function messageFromLink(href) {
  return new URL(href.replace(/&amp;/g, '&')).searchParams.get('text');
}

function contactLink(html, className) {
  const anchor = [...html.matchAll(/<a\b[^>]*>/g)]
    .map(match => match[0])
    .find(tag => (tag.match(/\bclass="([^"]*)"/) || [])[1]?.split(/\s+/).includes(className));
  assert.ok(anchor, 'кнопка контакта присутствует: ' + className);
  const href = anchor.match(/\bhref="([^"]+)"/);
  assert.ok(href, 'кнопка содержит ссылку');
  return href[1];
}

function ordersList(orders) {
  const db = {
    getOrders: () => orders, visibleOrders: () => orders,
    getProducts: () => [], visibleProducts: () => [], pendingReviewCount: () => 0
  };
  return A.ordersList(SETTINGS, db, null, 1, false, {}, OPTIONS);
}

test('черновик заказа использует короткие тире во всех разделителях', () => {
  const text = R.orderMessage(order({
    delivery: 'cdek', deliveryMode: 'pvz', deliveryPrice: 710,
    pickupCode: 'KZN123', pickupAddress: 'Казань, ул. Баумана, 10',
    promoCode: 'SALE', promoDiscount: 500
  }), SETTINGS);
  assert.match(text, /• AirTag - 2 × 3\s490\s₽/);
  assert.match(text, /Доставка: [^\n]+ - 710\s₽/);
  assert.match(text, /Пункт выдачи: KZN123 - Казань, ул\. Баумана, 10/);
  assert.match(text, /Промокод SALE - выгода 500\s₽/);
  assert.doesNotMatch(text, /[—–]/);
});

test('обращение начинается с заглавной буквы, включая старые заказы и Unicode', () => {
  for (const [patch, expected] of [
    [{ firstName: '  анна  ' }, 'Анна'],
    [{ firstName: 'ёлка' }, 'Ёлка'],
    [{ firstName: 'McDonald' }, 'McDonald'],
    [{ firstName: '\u{10428}lex' }, '\u{10400}lex'],
    [{ firstName: undefined, customerName: '  иван Петров  ' }, 'Иван'],
    [{ firstName: '', customerName: '  мария Иванова  ' }, 'Мария'],
    [{ firstName: ' \t ', customerName: '  ольга Иванова  ' }, 'Ольга']
  ]) {
    assert.equal(R.orderMessage(order(patch), SETTINGS).split('\n')[0],
      `Здравствуйте, ${expected}! Это магазин «iStore».`);
  }
  assert.equal(R.orderMessage(order({ firstName: ' ', customerName: ' ' }), SETTINGS).split('\n')[0],
    'Здравствуйте! Это магазин «iStore».');
});

test('последняя строка черновика содержит публичную ссылку конкретного отправления', () => {
  const current = order({ shipment: shipment(TOKEN_A) });
  const text = R.orderMessage(current, SETTINGS, OPTIONS);
  assert.ok(text.endsWith(`\n\n🔗 Ссылка отслеживания: ${ORIGIN}/track/${TOKEN_A}`));
  assert.equal((text.match(/Ссылка отслеживания/g) || []).length, 1);
  assert.equal(messageFromLink(R.orderWaHref(current, SETTINGS, OPTIONS)), text);
  assert.equal(messageFromLink(R.orderTelegramHref(current, SETTINGS, OPTIONS)), text);
  assert.ok(R.orderMessage(current, SETTINGS, { origin: 'http://localhost:3000/' })
    .endsWith(`🔗 Ссылка отслеживания: http://localhost:3000/track/${TOKEN_A}`));
});

test('ссылка не появляется без доступного покупателю отправления и корректного адреса сайта', () => {
  const visible = shipment(TOKEN_A);
  for (const unavailable of [
    undefined, null, {}, { token: TOKEN_A },
    { ...visible, visible: false }, { ...visible, steps: [] }, { ...visible, steps: null },
    { ...visible, token: '' }, { ...visible, token: undefined },
    { ...visible, token: '700101' }, { ...visible, token: '../other-order' }
  ]) {
    const current = order({ shipment: unavailable });
    for (const text of [
      R.orderMessage(current, SETTINGS, OPTIONS),
      messageFromLink(R.orderWaHref(current, SETTINGS, OPTIONS)),
      messageFromLink(R.orderTelegramHref(current, SETTINGS, OPTIONS))
    ]) {
      assert.doesNotMatch(text, /Ссылка отслеживания|\/track\//);
      assert.match(text, /Итого: 8\s490\s₽$/);
    }
  }
  const current = order({ shipment: visible });
  for (const options of [undefined, {}, { origin: '' }, { origin: 'shop.example' },
    { origin: '//shop.example' }, { origin: 'ftp://shop.example' }, { origin: 'javascript:alert(1)' }]) {
    assert.doesNotMatch(R.orderMessage(current, SETTINGS, options), /Ссылка отслеживания|\/track\//);
  }
});

test('два заказа одного покупателя получают свои ссылки, а замена ключа сразу меняет черновик', () => {
  const first = order({ shipment: shipment(TOKEN_A) });
  const second = order({ id: 'order-b', number: '700102', shipment: shipment(TOKEN_B) });
  for (const makeLink of [R.orderWaHref, R.orderTelegramHref]) {
    const firstText = messageFromLink(makeLink(first, SETTINGS, OPTIONS));
    const secondText = messageFromLink(makeLink(second, SETTINGS, OPTIONS));
    assert.ok(firstText.endsWith(`${ORIGIN}/track/${TOKEN_A}`));
    assert.ok(secondText.endsWith(`${ORIGIN}/track/${TOKEN_B}`));
    assert.ok(!firstText.includes(TOKEN_B));
    assert.ok(!secondText.includes(TOKEN_A));
  }
  first.shipment.token = TOKEN_C;
  for (const makeLink of [R.orderWaHref, R.orderTelegramHref]) {
    const text = messageFromLink(makeLink(first, SETTINGS, OPTIONS));
    assert.ok(text.endsWith(`${ORIGIN}/track/${TOKEN_C}`));
    assert.ok(!text.includes(TOKEN_A));
    assert.ok(!text.includes(TOKEN_B));
  }
});

test('кнопки списка заказов и карточки клиента передают адрес сайта для своего заказа', () => {
  const orders = [
    order({ shipment: shipment(TOKEN_A) }),
    order({ id: 'order-b', number: '700102', shipment: shipment(TOKEN_B) }),
    order({ id: 'order-c', number: '700103' })
  ];
  const html = ordersList(orders);
  const rows = [...html.matchAll(/<tr\b[^>]*>[\s\S]*?<\/tr>/g)].map(match => match[0]);
  for (const current of orders) {
    const row = rows.find(value => value.includes(`id="order-${current.id}"`));
    assert.ok(row, 'заказ присутствует в списке: ' + current.id);
    const expected = R.orderMessage(current, SETTINGS, OPTIONS);
    assert.equal(messageFromLink(contactLink(row, 'of-whatsapp')), expected);
    assert.equal(messageFromLink(contactLink(row, 'of-telegram')), expected);
    const card = R.orderClient(current, { money: SETTINGS, origin: ORIGIN });
    assert.equal(messageFromLink(contactLink(card, 'o-wa')), expected);
    if (!current.shipment) assert.doesNotMatch(expected, /Ссылка отслеживания|\/track\//);
  }
});
