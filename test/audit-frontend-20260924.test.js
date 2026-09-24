'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const minify = require('../lib/minify');

const source = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');
const paySource = fs.readFileSync(path.join(__dirname, '../public/pay.js'), 'utf8');
const flush = async () => { for (let i = 0; i < 25; i++) await Promise.resolve(); };

function element(value = '') {
  const events = {}, attrs = {};
  return {
    value, dataset: {}, innerHTML: '', hidden: true, style: {},
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    addEventListener(name, fn) { (events[name] ||= []).push(fn); },
    dispatch(name, extra = {}) { for (const fn of events[name] || []) fn({ preventDefault() {}, ...extra }); },
    setAttribute(name, val) { attrs[name] = String(val); },
    getAttribute: name => attrs[name] ?? null,
    removeAttribute(name) { delete attrs[name]; },
    querySelector: () => null, focus() {},
  };
}

// Исполняется весь витринный файл; DOMContentLoaded не нужен для точечных
// сценариев. Сеть и таймеры контролируются, функции не копируются в тест.
function browser(compressed, storage = new Map()) {
  const nodes = {}, requests = [], timers = new Map(), events = {};
  let serial = 0;
  const context = {
    document: {
      getElementById: id => nodes[id] || null,
      querySelector: selector => selector === 'input[name="co-delivery"]:checked' ? { value: 'cdek' }
        : selector === 'input[name="co-delivery-mode"]:checked' ? { value: 'courier' } : null,
      querySelectorAll: () => [], addEventListener() {},
      body: element(), activeElement: null
    },
    addEventListener(name, fn) { events[name] = fn; },
    setTimeout(fn, delay) { const id = ++serial; timers.set(id, { fn, delay }); return id; },
    clearTimeout: id => timers.delete(id),
    localStorage: {
      getItem: key => storage.get(key) || null,
      setItem: (key, value) => storage.set(key, String(value)),
      removeItem: key => storage.delete(key)
    },
    fetch(url, options) {
      let resolve, reject;
      const pending = new Promise((yes, no) => { resolve = yes; reject = no; });
      requests.push({ url, body: JSON.parse(options.body), reject,
        resolve: body => resolve({ status: body.ok ? 200 : 400, json: async () => body }) });
      return pending;
    },
    location: { pathname: '/checkout', origin: 'https://shop.test', search: '', hash: '' },
    Promise, Date, Uint8Array, URL, URLSearchParams, crypto: require('node:crypto').webcrypto
  };
  context.window = context;
  const instrumented = source.replace(/\}\)\(\);\s*$/, 'window.audit = { initAddressSuggest, syncSubmit, submitOrder, itemKey, refreshCartFromServer, startPayment };\n})();');
  vm.runInNewContext(compressed ? minify.js(instrumented) : instrumented, context);
  return { ...context.audit, context, nodes, requests, timers, storage, events, Cart: context.Cart,
    tick(delay) {
      for (const [id, timer] of [...timers]) {
        if (delay != null && timer.delay !== delay) continue;
        timers.delete(id); timer.fn();
      }
    }
  };
}

function checkout(h) {
  for (const [id, value] of Object.entries({
    'co-first-name': 'Анна', 'co-last-name': 'Тестова', 'co-phone': '+79990000000',
    'co-address': 'Казань, улица Баумана, дом 1', 'co-email': ''
  })) h.nodes[id] = element(value);
  for (const id of ['checkout-page', 'checkout-submit', 'order-msg']) h.nodes[id] = element();
  return h.nodes['checkout-submit'];
}

function payment(compressed, storage, order) {
  const h = browser(compressed, storage);
  h.nodes['pay-page'] = element();
  h.nodes['pay-page'].dataset = { order, currency: 'RUB', state: 'none' };
  h.nodes['pay-create'] = element();
  h.nodes['pay-msg'] = element();
  const query = h.context.document.querySelector;
  h.context.document.querySelector = selector => selector === 'input[name="pay-method"]:checked'
    ? { value: 'SBP', dataset: {} } : query(selector);
  vm.runInNewContext(compressed ? minify.js(paySource) : paySource, h.context);
  h.nodes['pay-create'].dispatch('click');
  return h;
}

const storedItems = h => JSON.parse(h.storage.get('cart_v1') || '[]');
const quantities = h => storedItems(h).map(item => [item.id, item.color, item.qty]);

for (const compressed of [false, true]) {
  const kind = compressed ? 'минифицированный JS' : 'исходный JS';

  test(`${kind}: старый ответ подсказок не возвращается после очистки и правки адреса`, async () => {
    for (const next of ['', 'Ка', 'Казань, Баумана']) {
      const h = browser(compressed), input = element(), list = element();
      h.context.document.activeElement = input;
      h.initAddressSuggest(input, list);
      input.value = 'Москва'; input.dispatch('input'); h.tick(220);
      assert.equal(h.requests.length, 1);
      input.value = next; input.dispatch('input');
      h.requests[0].resolve({ ok: true, items: [{ value: 'Москва, Тверская' }] });
      await flush();
      assert.equal(list.hidden, true);
      assert.equal(list.innerHTML, '');
      if (next.length >= 3) {
        h.tick(220);
        assert.equal(h.requests[1].body.q, next);
        h.requests[1].resolve({ ok: true, items: [{ value: next }] });
        await flush();
        assert.equal(list.hidden, false);
        assert.match(list.innerHTML, /Казань/);
      }
    }
  });

  test(`${kind}: Escape отменяет ожидающие подсказки, ArrowUp начинает с последнего адреса`, async () => {
    const h = browser(compressed), input = element(), list = element();
    h.context.document.activeElement = input;
    h.initAddressSuggest(input, list);
    input.value = 'Москва'; input.dispatch('input'); h.tick(220);
    input.dispatch('keydown', { key: 'Escape' });
    h.requests[0].resolve({ ok: true, items: [{ value: 'старый адрес' }] });
    await flush();
    assert.equal(list.hidden, true);
    input.value = 'Казань'; input.dispatch('input'); h.tick(220);
    h.requests[1].resolve({ ok: true, items: [{ value: 'Первый' }, { value: 'Второй' }, { value: 'Последний' }] });
    await flush();
    input.dispatch('keydown', { key: 'ArrowUp' });
    assert.equal(input.getAttribute('aria-activedescendant'), 'co-address-opt-2');
    input.dispatch('keydown', { key: 'Enter' });
    assert.equal(input.value, 'Последний');
    assert.equal(list.hidden, true);
  });

  test(`${kind}: пересчёт не разрешает повторный заказ и правку отправляемой корзины`, async () => {
    const h = browser(compressed);
    for (const [id, value] of Object.entries({
      'co-first-name': 'Анна', 'co-last-name': 'Тестова', 'co-phone': '+79990000000',
      'co-address': 'Казань, улица Баумана, дом 1', 'co-email': ''
    })) h.nodes[id] = element(value);
    h.nodes['checkout-page'] = element();
    h.nodes['checkout-submit'] = element();
    h.nodes['order-msg'] = element();
    h.Cart.add('phone', 'Телефон', 1000, 1);
    const btn = h.nodes['checkout-submit'], key = h.itemKey(h.Cart.items[0]);
    h.submitOrder(btn);
    assert.equal(h.requests.length, 1);
    h.syncSubmit();
    assert.equal(btn.disabled, true, 'пересчёт не снимает блокировку запроса');
    h.nodes['co-first-name'].value = 'Мария';
    h.submitOrder(btn);
    assert.equal(h.requests.length, 1, 'изменённая форма не создаёт второй запрос');
    h.Cart.setQty(key, 2); h.Cart.remove(key);
    assert.equal(h.Cart.add('charger', 'Зарядка', 500, 1), false);
    assert.equal(h.Cart.items.length, 1);
    assert.equal(h.Cart.items[0].qty, 1);
    h.requests[0].resolve({ ok: false, error: 'Повторите отправку' });
    await flush();
    assert.equal(h.Cart.submitting, false);
    assert.equal(btn.disabled, false);
    h.Cart.setQty(key, 2);
    assert.equal(h.Cart.items[0].qty, 2);
    h.submitOrder(btn);
    assert.equal(h.requests.length, 2);
    h.requests[1].reject(new Error('offline'));
    await flush();
    assert.equal(h.Cart.submitting, false);
    assert.equal(btn.disabled, false);
    h.submitOrder(btn);
    assert.equal(h.requests.length, 3, 'после сетевого отказа доступна повторная отправка');
    assert.equal(h.requests[2].body.requestId, h.requests[1].body.requestId,
      'повтор после неопределённого сетевого ответа использует прежний ключ заказа');
  });

  test(`${kind}: возврат из истории восстанавливает доступность оформления`, () => {
    const h = browser(compressed);
    h.nodes['checkout-submit'] = element();
    h.storage.set('cart_v1', JSON.stringify([{ id: 'phone', name: 'Телефон', price: 1000, qty: 1 }]));
    h.Cart.submitting = true;
    h.events.pageshow({ persisted: true });
    h.syncSubmit();
    assert.equal(h.Cart.submitting, false);
    assert.equal(h.Cart.items.length, 1);
    assert.equal(h.nodes['checkout-submit'].disabled, false);
  });

  test(`${kind}: действия старой вкладки объединяются с актуальной корзиной`, () => {
    const a = browser(compressed), b = browser(compressed, a.storage);
    a.Cart.add('phone', 'Телефон', 1000, 1);
    b.Cart.add('charger', 'Зарядка', 500, 1);
    assert.deepEqual(quantities(b), [['phone', '', 1], ['charger', '', 1]]);
    const phone = a.itemKey(a.Cart.items[0]);
    a.Cart.adjustQty(phone, 1);
    b.Cart.adjustQty(phone, 1);
    assert.deepEqual(quantities(a), [['phone', '', 3], ['charger', '', 1]]);
    a.Cart.remove(a.itemKey(a.Cart.items.find(item => item.id === 'charger')));
    b.nodes['cart-badge'] = element();
    b.events.storage({ key: 'cart_v1', storageArea: b.context.localStorage });
    assert.deepEqual(quantities(b), [['phone', '', 3]]);
    assert.equal(b.Cart.count(), 3);
    assert.equal(b.nodes['cart-badge'].textContent, 3);
    assert.equal(b.nodes['cart-badge'].hidden, false);
    a.storage.delete('cart_v1');
    b.events.storage({ key: null, storageArea: b.context.localStorage });
    assert.equal(b.Cart.count(), 0, 'очистка хранилища обновляет открытые вкладки');
  });

  test(`${kind}: запоздалые цены не стирают новые товары и количество другой вкладки`, async () => {
    const a = browser(compressed), b = browser(compressed, a.storage);
    a.Cart.add('phone', 'Телефон', 1000, 1);
    const update = a.refreshCartFromServer();
    b.Cart.add('charger', 'Зарядка', 500, 1);
    a.requests[0].resolve({ ok: true, items: [{ name: 'Телефон', price: 1200 }] });
    await update;
    assert.deepEqual(quantities(a), [['phone', '', 1], ['charger', '', 1]]);
    const second = a.refreshCartFromServer();
    b.Cart.adjustQty(b.itemKey(b.Cart.items[0]), 1);
    a.requests[1].resolve({ ok: true, items: [{ price: 1200 }, { price: 600 }] });
    await second;
    assert.deepEqual(quantities(a), [['phone', '', 2], ['charger', '', 1]]);
    assert.equal(storedItems(a)[0].price, 1200, 'свежие цены объединяются с текущим количеством');
    const third = a.refreshCartFromServer();
    b.Cart.remove(b.itemKey(b.Cart.items[0]));
    a.requests[2].resolve({ ok: true, items: [{ price: 1300 }, { price: 600 }] });
    await third;
    assert.deepEqual(quantities(a), [['charger', '', 1]], 'старый ответ не возвращает удалённый товар');
  });

  test(`${kind}: ответ заказа вычитает отправленные варианты и сохраняет добавленное во время POST`, async () => {
    const a = browser(compressed), b = browser(compressed, a.storage);
    const btn = checkout(a);
    a.Cart.add('phone', 'Телефон', 1000, 2, { color: 'Красный' });
    a.submitOrder(btn);
    b.Cart.add('phone', 'Телефон', 1000, 1, { color: 'Красный' });
    b.Cart.add('phone', 'Телефон', 1000, 1, { color: 'Синий' });
    b.Cart.add('charger', 'Зарядка', 500, 1);
    a.requests[0].resolve({ ok: true, id: 'order-snapshot', number: '001', pay: false });
    await flush();
    assert.deepEqual(quantities(a), [['phone', 'Красный', 1], ['phone', 'Синий', 1], ['charger', '', 1]]);
    assert.equal(a.Cart.submitting, false);
    const hold = JSON.parse(a.storage.get('cart_hold_v1'));
    assert.equal(hold.order, 'order-snapshot');
    assert.deepEqual(hold.items.map(item => [item.id, item.color, item.qty]), [['phone', 'Красный', 2]]);
    const again = browser(compressed, a.storage);
    assert.equal(again.Cart.completeOrder('order-snapshot'), false, 'повтор ответа не вычитает новые единицы');
    assert.equal(again.Cart.completeOrder('unknown-order'), false, 'без снимка корзину не очищаем');
    assert.equal(storedItems(a).length, 3);
  });

  test(`${kind}: черновик сохраняет снимок до оплаты, отказ кассы не трогает корзину`, async () => {
    const a = browser(compressed), b = browser(compressed, a.storage);
    const btn = checkout(a);
    a.Cart.add('phone', 'Телефон', 1000, 1);
    a.submitOrder(btn);
    a.requests[0].resolve({ ok: true, id: 'order-draft', number: '002', pay: true, draft: true });
    await flush();
    assert.deepEqual(quantities(a), [['phone', '', 1]], 'черновик не очищает корзину');
    b.Cart.add('charger', 'Зарядка', 500, 1);
    const failed = payment(compressed, a.storage, 'order-draft');
    failed.requests[0].resolve({ ok: false, placed: true, error: 'Нет реквизитов' });
    await flush();
    assert.deepEqual(quantities(a), [['phone', '', 1], ['charger', '', 1]]);
    const pay = payment(compressed, a.storage, 'order-draft');
    b.Cart.add('phone', 'Телефон', 1000, 1);
    pay.requests[0].resolve({ ok: true, url: '/pay/order-draft' });
    await flush();
    assert.deepEqual(quantities(a), [['phone', '', 1], ['charger', '', 1]]);
    const repeated = payment(compressed, a.storage, 'order-draft');
    repeated.requests[0].resolve({ ok: true, url: '/pay/order-draft' });
    await flush();
    assert.deepEqual(quantities(a), [['phone', '', 1], ['charger', '', 1]], 'повторное получение реквизитов не чистит новый выбор');
  });

  test(`${kind}: прямой запуск оплаты завершает только сохранённый снимок`, async () => {
    const a = browser(compressed), b = browser(compressed, a.storage);
    a.Cart.add('phone', 'Телефон', 1000, 1);
    a.Cart.rememberOrder('direct-order', a.Cart.items);
    a.startPayment('direct-order', 'SBP_ONLINE', 1000);
    b.Cart.add('charger', 'Зарядка', 500, 1);
    a.requests[0].resolve({ ok: true });
    await flush();
    assert.deepEqual(quantities(a), [['charger', '', 1]]);
    assert.equal(a.context.location.href, '/pay/direct-order');
  });

  test(`${kind}: недоступный localStorage сохраняет корзину текущей страницы`, () => {
    const h = browser(compressed);
    h.context.localStorage.getItem = () => { throw new Error('blocked'); };
    h.context.localStorage.setItem = () => { throw new Error('blocked'); };
    h.Cart.add('phone', 'Телефон', 1000, 1);
    h.Cart.add('charger', 'Зарядка', 500, 1);
    assert.equal(h.Cart.items.length, 2);
    h.Cart.rememberOrder('local-order', h.Cart.items.slice(0, 1));
    assert.equal(h.Cart.completeOrder('local-order'), true);
    assert.equal(h.Cart.items.length, 1);
    assert.equal(h.Cart.items[0].id, 'charger');
  });
}
