'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
function block(start, end) {
  const a = source.indexOf(start), b = source.indexOf(end, a);
  assert.ok(a >= 0 && b > a, 'найден исходный блок: ' + start);
  return source.slice(a, b);
}
const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
const quote = (price = 710) => ({
  ok: true, valid: true,
  prices: { cdek: { courier: price, pvz: 300 } },
  days: { cdek: { courier: '3–5 дней', pvz: '4–6 дней' } }
});

// Запускаем функции доставки и разметки из app.js. Отложенная сеть намеренно
// отвечает даже после abort: защита от старого ответа нужна и в этой гонке.
function checkout(count = 1) {
  const state = { count, method: 'cdek', mode: 'courier', remembered: [] };
  const pageClasses = new Set();
  const nodes = {
    'checkout-page': { dataset: {}, classList: {
      toggle: (name, on) => on ? pageClasses.add(name) : pageClasses.delete(name),
      contains: name => pageClasses.has(name)
    } },
    'checkout-items': { innerHTML: '' },
    'checkout-form': { innerHTML: 'Поля заказа', dataset: { ready: '1' } },
    'checkout-action': { innerHTML: 'Кнопка оплаты', dataset: { ready: '1' } },
    'checkout-side': { innerHTML: '' },
    'co-modes': { innerHTML: '' },
    'co-address': { value: 'Казань, улица Баумана, дом 10' },
    'co-first-name': { value: 'Анна' },
    'co-phone': { value: '+79990000000' }
  };
  const timers = new Map(), calls = [];
  let timerId = 0;
  const context = {
    document: { getElementById: id => nodes[id] || null }, window: { AbortController },
    AbortController, Promise,
    Cart: {
      items: [{ id: 'phone', price: 1000, qty: 1 }],
      availableCount: () => state.count, total: () => state.count * 1000, saved: () => 0
    },
    checkoutCount: () => state.count, checkoutTotal: () => state.count * 1000,
    checkoutSaved: () => 0, checkoutFeeQuote: () => null, checkoutMode: () => 'own',
    deliveryChoice: () => state.method, deliveryModeChoice: () => state.mode,
    deliveryName: () => 'СДЭК', deliveryModeName: () => 'Курьером',
    deliveryModes: () => [{ id: 'courier', name: 'Курьером' }, { id: 'pvz', name: 'В пункт выдачи' }],
    rememberCheckout: () => state.remembered.push(nodes['co-address'].value),
    promoView: null, money: value => value + ' ₽', coIcon: () => '',
    escapeHtml: value => String(value), lineLabel: (icon, text) => '<span>' + text + '</span>',
    setTimeout: fn => { const id = ++timerId; timers.set(id, fn); return id; },
    clearTimeout: id => timers.delete(id),
    fetch: (url, request) => {
      let resolve, reject;
      const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
      calls.push({ url, payload: JSON.parse(request.body), signal: request.signal,
        resolve: data => resolve({ json: async () => data }), reject });
      return promise;
    }
  };
  vm.runInNewContext(
    block('  var ship =', '  /* ===== Поле адреса растёт под текст =====')
    + block('  function renderCheckoutPage()', '  function syncSubmit()')
    + block('  function renderRail()', '  // ===== Оплата и доставка =====')
    + block('  function deliveryModesHtml()', '  function renderModes()')
    + '\nfunction syncDelivery() { renderRail(); document.getElementById("co-modes").innerHTML = deliveryModesHtml(); }'
    + '\nthis.subject = { Cart, ship, quoteDelivery, renderCheckoutPage, syncDelivery, shipCurrent, shipDaysCurrent };', context);
  const subject = context.subject;
  subject.syncDelivery();
  return { ...subject, state, nodes, timers, calls,
    async tick() {
      const pending = [...timers.entries()];
      for (const [id, fn] of pending) { if (timers.delete(id)) fn(); }
      await flush();
    }
  };
}

function assertNoPrice(ui) {
  assert.equal(ui.shipCurrent(), null);
  assert.equal(ui.shipDaysCurrent(), '');
  assert.doesNotMatch(ui.nodes['checkout-side'].innerHTML, /Доставка|co-delivery-due|710 ₽|3-5 дней/);
  assert.doesNotMatch(ui.nodes['co-modes'].innerHTML, /co-mode-price|co-mode-days/);
  assert.match(ui.nodes['co-modes'].innerHTML, /value="courier" checked/,
    'вариант доставки остаётся выбранным');
}

function assertReset(ui) {
  for (const key of ['key', 'wanted', 'address', 'error']) assert.equal(ui.ship[key], '', key);
  for (const key of ['prices', 'days', 'timer']) assert.equal(ui.ship[key], null, key);
  assert.equal(ui.ship.valid, false);
  assert.equal(ui.ship.pending, false);
  assert.equal(ui.timers.size, 0);
  assertNoPrice(ui);
}

test('без выбранных товаров адрес не запускает расчёт и цены доставки не показаны', async () => {
  const ui = checkout(0);
  ui.quoteDelivery(0);
  await ui.tick();
  assert.equal(ui.calls.length, 0);
  assertReset(ui);
});

test('снятие последнего товара очищает готовый тариф, сохраняя поля и выбранную доставку', async () => {
  const ui = checkout();
  ui.quoteDelivery(0);
  await ui.tick();
  ui.calls[0].resolve(quote());
  await flush();
  assert.equal(ui.shipCurrent(), 710);
  assert.match(ui.nodes['checkout-side'].innerHTML, /710 ₽/);
  assert.match(ui.nodes['co-modes'].innerHTML, /co-mode-price/);
  const fields = ['co-address', 'co-first-name', 'co-phone'].map(id => ui.nodes[id].value);
  ui.state.count = 0;
  ui.quoteDelivery(0);
  assertReset(ui);
  assert.deepEqual(['co-address', 'co-first-name', 'co-phone'].map(id => ui.nodes[id].value), fields);
  assert.equal(ui.state.method, 'cdek');
  assert.equal(ui.state.mode, 'courier');
});

test('снятие выбора до debounce отменяет ещё не отправленный запрос', async () => {
  const ui = checkout();
  ui.quoteDelivery(350);
  assert.equal(ui.timers.size, 1);
  ui.state.count = 0;
  ui.quoteDelivery(0);
  await ui.tick();
  assert.equal(ui.calls.length, 0);
  assertReset(ui);
});

test('снятие выбора прерывает запрос, его поздний ответ не возвращает тариф', async () => {
  const ui = checkout();
  ui.quoteDelivery(0);
  await ui.tick();
  assert.equal(ui.ship.pending, true);
  ui.state.count = 0;
  ui.quoteDelivery(0);
  assert.equal(ui.calls[0].signal.aborted, true);
  ui.calls[0].resolve(quote());
  await flush();
  assertReset(ui);
});

test('повторный выбор тех же товаров возобновляет расчёт и игнорирует ответ прежнего запроса', async () => {
  const ui = checkout();
  ui.quoteDelivery(0);
  await ui.tick();
  ui.state.count = 0;
  ui.quoteDelivery(0);
  ui.state.count = 1;
  ui.quoteDelivery(0);
  await ui.tick();
  assert.equal(ui.calls.length, 2);
  assert.equal(ui.calls[1].url, '/api/delivery/quote');
  assert.deepEqual(ui.calls[1].payload, ui.calls[0].payload, 'адрес и сумма у запросов совпадают');
  ui.calls[0].resolve(quote(999));
  await flush();
  assert.equal(ui.ship.pending, true, 'старый ответ не завершает новый запрос');
  assert.equal(ui.shipCurrent(), null);
  assert.equal(ui.calls[1].signal.aborted, false);
  ui.calls[1].resolve(quote());
  await flush();
  assert.equal(ui.ship.pending, false);
  assert.equal(ui.ship.valid, true);
  assert.equal(ui.shipCurrent(), 710);
  assert.match(ui.ship.key, /^1000\|/);
  assert.match(ui.nodes['checkout-side'].innerHTML, /710 ₽/);
  assert.match(ui.nodes['co-modes'].innerHTML, /co-mode-price/);
});

test('поздняя ошибка отменённого запроса не сбрасывает ожидание нового расчёта', async () => {
  const ui = checkout();
  ui.quoteDelivery(0);
  await ui.tick();
  ui.state.count = 0;
  ui.quoteDelivery(0);
  ui.state.count = 1;
  ui.quoteDelivery(0);
  await ui.tick();
  ui.calls[0].reject(new Error('offline'));
  await flush();
  assert.equal(ui.ship.pending, true);
  ui.calls[1].resolve(quote());
  await flush();
  assert.equal(ui.shipCurrent(), 710);
  assert.equal(ui.ship.pending, false);
});

test('удаление последнего товара через отрисовку корзины отменяет запрос до раннего выхода', async () => {
  const ui = checkout();
  ui.quoteDelivery(0);
  await ui.tick();
  const previousSeq = ui.ship.requestSeq;
  ui.state.count = 0;
  ui.Cart.items = [];
  ui.renderCheckoutPage();
  assert.ok(ui.ship.requestSeq > previousSeq);
  assert.equal(ui.calls[0].signal.aborted, true);
  assert.equal(ui.ship.pending, false);
  assert.equal(ui.ship.key, '');
  assert.equal(ui.ship.prices, null);
  assert.equal(ui.ship.days, null);
  assert.equal(ui.ship.timer, null);
  assert.equal(ui.nodes['checkout-page'].classList.contains('is-empty'), true);
  assert.match(ui.nodes['checkout-items'].innerHTML, /В корзине пока пусто/);
  assert.deepEqual(ui.state.remembered, ['Казань, улица Баумана, дом 10']);
  for (const id of ['checkout-form', 'checkout-action', 'checkout-side']) assert.equal(ui.nodes[id].innerHTML, '');
  for (const id of ['checkout-form', 'checkout-action']) assert.equal(ui.nodes[id].dataset.ready, undefined);
  ui.calls[0].resolve(quote());
  await flush();
  assert.equal(ui.shipCurrent(), null);
  assert.equal(ui.ship.pending, false);
  assert.equal(ui.nodes['checkout-side'].innerHTML, '', 'поздний ответ не возвращает сводку пустой корзины');
});

test('таймер и ответ сами замечают пустой выбор даже без повторного вызова расчёта', async () => {
  const waiting = checkout();
  waiting.quoteDelivery(350);
  waiting.state.count = 0;
  await waiting.tick();
  assert.equal(waiting.calls.length, 0, 'таймер не отправляет устаревший состав');
  assertReset(waiting);

  for (const failed of [false, true]) {
    const pending = checkout();
    pending.quoteDelivery(0);
    await pending.tick();
    pending.state.count = 0;
    if (failed) pending.calls[0].reject(new Error('offline'));
    else pending.calls[0].resolve(quote());
    await flush();
    assertReset(pending);
    assert.equal(pending.calls.length, 1);
  }
});
