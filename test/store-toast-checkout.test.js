'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '..', 'public/app.js'), 'utf8');
const hasSelection = source.includes('  function checkoutSelectionError()');
function block(from, to) {
  const start = source.indexOf(from), end = source.indexOf(to, start);
  assert.ok(start >= 0 && end > start);
  return source.slice(start, end);
}
function checkout() {
  const state = { count: 1, limit: '', mode: 'cashbox', delivery: 'cdek', deliveryMode: 'courier', fee: { total: 1000 }, available: true };
  const message = { dataset: {}, hidden: true };
  const button = { innerHTML: 'Оплатить', querySelector: () => ({ textContent: '' }) };
  const nodes = { 'order-msg': message, 'checkout-submit': button, 'checkout-page': { dataset: { paymentFeePercent: '0' } },
    'co-first-name': { value: 'Анна', focus() {} }, 'co-last-name': { value: 'Иванова' },
    'co-address': { value: 'Казань', focus() {} }, 'co-phone': { value: '+79990000000', focus() {} }, 'co-email': { value: '' } };
  const item = { id: 'phone', price: 1000, qty: 1 };
  const ship = { valid: true, pending: false, key: '1000|Казань', address: 'Казань' };
  const context = {
    document: { getElementById: id => nodes[id] || null }, window: {}, ship, pickup: { code: '' },
    checkoutLimit: () => 19000, checkoutCount: () => state.count, checkoutTotal: () => 1000,
    checkoutAllowed: () => state.available, checkoutItems: () => [item], cleanItem: i => i,
    Cart: { items: [item], total: () => 1000, availableCount: () => state.count },
    checkoutFeeQuote: () => state.fee, checkoutMode: () => state.mode, orderTotal: () => 1000,
    totalLimitError: () => state.limit, addressValue: () => nodes['co-address'].value,
    deliveryChoice: () => state.delivery, deliveryModeChoice: () => state.deliveryMode, shipCurrent: () => 0,
    phoneCheck: () => ({ ok: true }), phoneValue: () => '+79990000000', rememberCheckout() {},
    setText() {}, money: String, submitLabel: () => 'Оплатить', coIcon: () => '', openPoints() {},
    promoFields() {}, orderRequestId: () => 'test', fetch: async () => { throw new Error('offline'); }
  };
  vm.runInNewContext(
    block('  function checkoutAmountError()', '  function addressValue()')
    + (hasSelection ? block('  function checkoutSelectionError()', '  function setCheckoutQuantity(') : '')
    + block('  function syncSubmit()', '  // Адрес меняет зону')
    + source.slice(source.indexOf('  function submitOrder(btn)'), source.lastIndexOf('})();'))
    + '\nthis.subject = { syncSubmit, submitOrder };', context);
  return { ...context.subject, state, nodes, message, button, ship };
}

test('подсказки адреса, доставки и ожидания расчёта имеют тип info', () => {
  const ui = checkout();
  ui.nodes['co-address'].value = '';
  ui.syncSubmit();
  assert.equal(ui.message.dataset.toastType, 'info');
  assert.match(ui.message.textContent, /Укажите адрес/);
  assert.equal(ui.button.disabled, true);
  ui.nodes['co-address'].value = 'Казань'; ui.state.delivery = '';
  ui.syncSubmit();
  assert.equal(ui.message.dataset.toastType, 'info');
  assert.match(ui.message.textContent, /Выберите способ/);
  ui.state.delivery = 'cdek'; ui.ship.pending = true;
  ui.syncSubmit();
  assert.equal(ui.message.dataset.toastType, 'info');
  assert.match(ui.message.textContent, /Дождитесь расчёта/);
  ui.ship.pending = false; ui.syncSubmit();
  assert.equal(ui.message.hidden, true, 'после расчёта прежняя подсказка закрывается');
  assert.equal(ui.button.disabled, false);
});

test('ограничение суммы — warning, сбой расчёта — error', () => {
  const ui = checkout();
  ui.state.limit = 'Превышена сумма заказа'; ui.syncSubmit();
  assert.equal(ui.message.dataset.toastType, 'warning');
  ui.state.limit = ''; ui.state.fee = null; ui.syncSubmit();
  assert.equal(ui.message.dataset.toastType, 'error');
  assert.match(ui.message.textContent, /Не удалось проверить сумму/);
});

test('подсказка поля не окрашивает последующую сетевую ошибку в info', async () => {
  const ui = checkout(); ui.state.mode = 'request';
  ui.nodes['co-first-name'].value = ''; ui.submitOrder(ui.button);
  assert.equal(ui.message.dataset.toastType, 'info');
  ui.nodes['co-first-name'].value = 'Анна'; ui.submitOrder(ui.button);
  for (let n = 0; n < 20; n++) await Promise.resolve();
  assert.equal(ui.message.dataset.toastType, 'error');
  assert.equal(ui.message.textContent, 'Ошибка сети');
  assert.equal(ui.button.disabled, false);
});

if (hasSelection) test('пустой выбор товаров — info; выбор товара закрывает подсказку', () => {
  const ui = checkout(); ui.state.count = 0;
  ui.syncSubmit();
  assert.equal(ui.message.textContent, 'Выберите товары');
  assert.equal(ui.message.dataset.toastType, 'info');
  assert.equal(ui.message.hidden, false);
  assert.equal(ui.button.disabled, true);
  ui.state.count = 1; ui.syncSubmit();
  assert.equal(ui.message.hidden, true);
  assert.equal(ui.button.disabled, false);
  ui.state.available = false; ui.syncSubmit();
  assert.equal(ui.message.textContent, 'Оформите товары по одному');
  assert.equal(ui.message.dataset.toastType, 'warning');
});
