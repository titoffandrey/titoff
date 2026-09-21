'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');

function promoUi(fallback = 'SALE') {
  const ids = ['checkout-page', 'checkout-promo', 'co-promo', 'co-promo-chip',
    'co-promo-code', 'co-promo-cut', 'co-promo-drop', 'co-promo-form',
    'co-promo-input', 'co-promo-note'];
  const nodes = Object.fromEntries(ids.map(id => [id, {
    dataset: {}, hidden: false, textContent: '', value: '', innerHTML: '',
    addEventListener() {}, setAttribute() {}
  }]));
  nodes['checkout-page'].dataset.promo = '1';
  const button = { disabled: false };
  const stored = new Map();
  const requests = [];
  const active = code => ({ on: true, code, percent: 0, fallback, off: false });
  let ui;
  const env = {
    document: {
      getElementById: id => nodes[id] || null,
      querySelector: selector => selector === '.co-promo-apply' ? button : null
    },
    localStorage: {
      getItem: key => stored.get(key) || null,
      setItem: (key, value) => stored.set(key, value),
      removeItem: key => stored.delete(key)
    },
    Cart: { items: [{ id: 'item' }], render() {} },
    coIcon: () => '',
    setText: (id, value) => { if (nodes[id]) nodes[id].textContent = value; },
    refreshCartFromServer: () => {
      const fields = ui.promoFields({});
      ui.takePromo({ promo: fields.promoOff
        ? { on: true, code: '', off: true, fallback }
        : active(fields.promoCode || fallback) });
      return Promise.resolve();
    },
    fetch: async (url, options) => {
      const body = JSON.parse(options.body);
      requests.push({ url, method: options.method, body });
      return { json: async () => body.promoCode === 'SALE'
        ? { ok: true, promo: active('SALE') }
        : { ok: false, error: 'Такого промокода нет' } };
    }
  };
  const start = source.indexOf("  var PROMO_KEY =");
  const end = source.indexOf('  // ===== Страница оформления (/checkout) =====', start);
  assert.ok(start >= 0 && end > start, 'модуль промокода найден');
  ui = new Function('env', `const { document, localStorage, Cart, coIcon, setText,
    refreshCartFromServer, fetch } = env;
    ${source.slice(start, end)}
    return { buildPromo, takePromo, dropPromo, applyPromo, promoFields };`)(env);
  ui.buildPromo();
  ui.takePromo({ promo: active(fallback) });
  return { ui, nodes, button, stored, requests };
}

const settle = () => new Promise(resolve => setImmediate(resolve));

test('удалённый промокод возвращается кнопкой «Применить» при пустом поле', async () => {
  const { ui, nodes, button, stored, requests } = promoUi();
  assert.equal(nodes['co-promo-chip'].hidden, false);
  assert.equal(nodes['co-promo-form'].hidden, true);
  ui.dropPromo();
  assert.deepEqual(ui.promoFields({}), { promoOff: true });
  assert.equal(nodes['co-promo-chip'].hidden, true);
  assert.equal(nodes['co-promo-form'].hidden, false);
  assert.equal(nodes['co-promo-input'].value, '');
  assert.equal(nodes['co-promo-input'].placeholder, 'SALE');
  assert.equal(nodes['co-promo-note'].hidden, true, 'обычной подсказки после удаления нет');
  assert.doesNotMatch(nodes['checkout-promo'].innerHTML, /co-promo-back/);

  ui.applyPromo();
  assert.equal(button.disabled, true, 'повторный запрос блокируется до ответа');
  await settle();
  assert.deepEqual(requests, [{ url: '/api/promo', method: 'POST', body: { promoCode: 'SALE' } }]);
  assert.deepEqual(ui.promoFields({}), { promoCode: 'SALE' });
  assert.equal(nodes['co-promo-code'].textContent, 'SALE');
  assert.equal(nodes['co-promo-chip'].hidden, false);
  assert.equal(nodes['co-promo-form'].hidden, true);
  assert.equal(nodes['co-promo-note'].hidden, true);
  assert.equal(button.disabled, false);
  assert.deepEqual(JSON.parse(stored.get('promo_v1')), { code: 'SALE' });
});

test('введённый неверный промокод показывает отказ сервера и не подменяется кодом по умолчанию', async () => {
  const { ui, nodes, button, stored, requests } = promoUi();
  ui.dropPromo();
  nodes['co-promo-input'].value = 'NOPE';
  ui.applyPromo();
  await settle();
  assert.deepEqual(requests, [{ url: '/api/promo', method: 'POST', body: { promoCode: 'NOPE' } }]);
  assert.deepEqual(ui.promoFields({}), { promoOff: true });
  assert.equal(nodes['co-promo-chip'].hidden, true);
  assert.equal(nodes['co-promo-form'].hidden, false);
  assert.equal(nodes['co-promo-input'].value, 'NOPE');
  assert.equal(nodes['co-promo-input'].placeholder, 'SALE');
  assert.equal(nodes['co-promo-note'].hidden, false);
  assert.match(nodes['checkout-promo'].innerHTML, /class="co-promo-note is-err"/);
  assert.equal(nodes['co-promo-note'].textContent, 'Такого промокода нет');
  assert.equal(button.disabled, false);
  assert.equal(stored.has('promo_v1'), false);
});

test('непустой ввод недопустимых символов не восстанавливает скидку молча', async () => {
  const { ui, nodes, requests } = promoUi();
  ui.dropPromo();
  nodes['co-promo-input'].value = '!!!';
  ui.applyPromo();
  await settle();
  assert.deepEqual(requests, []);
  assert.deepEqual(ui.promoFields({}), { promoOff: true });
  assert.equal(nodes['co-promo-form'].hidden, false);
  assert.equal(nodes['co-promo-note'].hidden, false);
  assert.equal(nodes['co-promo-note'].textContent, 'Введите промокод');
});

test('пустое применение без доступного кода по умолчанию просит ввести промокод', async () => {
  const { ui, nodes, requests } = promoUi('');
  ui.applyPromo();
  await settle();
  assert.deepEqual(requests, []);
  assert.equal(nodes['co-promo-input'].placeholder, 'Промокод');
  assert.equal(nodes['co-promo-note'].hidden, false);
  assert.equal(nodes['co-promo-note'].textContent, 'Введите промокод');
});

test('под адресом видна только ошибка проверки текущего адреса', () => {
  const start = source.indexOf('  function addressNote(');
  const end = source.indexOf('  function deliveryChoiceHtml(', start);
  assert.ok(start >= 0 && end > start, 'функции ошибки адреса найдены');
  const note = { textContent: '', className: '', hidden: false };
  const ship = { address: '', valid: false, error: '' };
  let address = '';
  const sync = new Function('document', 'ship', 'addressValue',
    `${source.slice(start, end)}\nreturn syncAddressNote;`)(
    { getElementById: id => id === 'co-address-note' ? note : null }, ship, () => address);
  sync();
  assert.equal(note.hidden, true);
  assert.equal(note.textContent, '');
  address = ship.address = 'Москва';
  ship.error = 'Укажите улицу и дом';
  sync();
  assert.equal(note.hidden, false);
  assert.equal(note.textContent, 'Укажите улицу и дом');
  assert.match(note.className, /field-note-warn/);
  address = 'Москва, ул Тверская, 1';
  sync();
  assert.equal(note.hidden, true, 'старый ответ не показывает ошибку нового адреса');
  assert.equal(note.textContent, '');
  ship.address = address;
  ship.valid = true;
  sync();
  assert.equal(note.hidden, true);
  assert.equal(note.textContent, '');
});
