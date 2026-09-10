'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const R = require('../lib/render');
const PAY = require('../lib/pay-methods');
const ALFA = require('../lib/alfabank');

const NOW = Date.parse('2026-09-09T09:30:00+03:00');
const ALFA_LINK = 'https://pay.alfabank.ru/payment/merchants/alfasbp/payment.html?mdOrder=synthetic&language=ru';
const settings = { storeName: 'Тестовый магазин', currency: '₽', tagline: '', accentColor: '#0071e3' };
function invoice(extra = {}) {
  return { provider: 'alfabank', method: 'CARD_ONLINE', status: 'pending', bank: '',
    invoiceId: 'synthetic-invoice', requisite: ALFA_LINK, currency: 'RUB', amount: 1000,
    startedAt: NOW - 60000, expiresAt: NOW + 60000, ...extra };
}
function order(extra = {}) {
  return { id: 'synthetic-order', number: '581240', total: 1000, itemsTotal: 1000,
    createdAt: NOW - 60000, items: [{ id: 'sample', name: 'Тестовый товар', qty: 1, price: 1000 }],
    payment: null, ...extra };
}

test('банк Альфы виден с локальным логотипом даже при пустом payment.bank', () => {
  for (const status of ['pending', 'paid', 'mismatch', 'expired', 'failed']) {
    const html = R.orderBankMark(order({ payment: invoice({ status }) }), NOW);
    assert.match(html, /<span class="bank-name">Альфа-Банк<\/span>/, status);
    assert.match(html, /<img class="bank-logo"[^>]*src="\/static\/banks\/alfa\.svg\?v=[a-z0-9]+"/, status);
    assert.match(html, /width="24" height="24" alt="" aria-hidden="true"/, status);
    assert.doesNotMatch(html, /<a\b|(?:src|href)="https?:/, 'знак не обращается к внешнему сайту');
  }
  const svg = fs.readFileSync(path.join(__dirname, '../public/banks/alfa.svg'), 'utf8');
  assert.match(svg, /viewBox="0 0 24 24"/);
  assert.doesNotMatch(svg, /<script|<foreignObject|(?:href|src)="https?:/i);
});

test('сохранённое название банка имеет приоритет над именем кассы и экранируется', () => {
  const html = R.orderBankMark(order({ payment: invoice({ bank: 'Другой банк & <подпись>' }) }), NOW);
  assert.match(html, /<span class="bank-name">Другой банк &amp; &lt;подпись&gt;<\/span>/);
  assert.doesNotMatch(html, /<img|<svg|Альфа-Банк|<подпись>/);
  for (const name of ['Альфа-Банк', 'АО «АЛЬФА-БАНК»', 'Alfa Bank', 'alfa-bank']) {
    const known = R.orderBankMark(order({ payment: { provider: 'meridianpay', bank: name } }), NOW);
    assert.match(known, /\/static\/banks\/alfa\.svg/);
    assert.ok(known.includes('<span class="bank-name">' + R.esc(name) + '</span>'));
  }
});

test('банк неизвестной попытки и банк старого ручного платежа не угадываются', () => {
  for (const value of [undefined, {}, order(), order({ manualPaid: { at: NOW, by: 'preview' } }),
    order({ payMode: 'own', payment: null }), order({ payment: { provider: 'meridianpay', method: 'SBP' } }),
    order({ payment: { method: 'CARD_ONLINE', requisite: ALFA_LINK } }),
    order({ payment: { provider: 'unknown', bank: '   ' } })]) {
    assert.equal(R.orderBankMark(value, NOW), '', JSON.stringify(value));
  }
});

test('банк относится к новейшему живому счёту, а не к последнему отказу', () => {
  const older = invoice({ startedAt: NOW - 120000 });
  const current = invoice({ provider: 'meridianpay', method: 'SBP', bank: 'ЮMoney',
    startedAt: NOW - 30000, invoiceId: 'current', requisite: '+12025550101' });
  const value = order({ payment: invoice({ provider: 'crocopay', status: 'failed', bank: 'Банк отказа',
    attempts: [current, older] }) });
  const snapshot = structuredClone(value);
  const html = R.orderBankMark(value, NOW);
  assert.match(html, /<span class="bank-name">ЮMoney<\/span>/);
  assert.match(html, /<svg class="bank-logo"[^>]*viewBox="0 0 1440 320"/);
  assert.doesNotMatch(html, /Банк отказа|Альфа-Банк|alfa\.svg/);
  assert.deepEqual(value, snapshot, 'история попыток не сортируется и не переписывается в заказе');
});

test('подтверждённая оплата и расхождение суммы важнее другого живого счёта', () => {
  for (const status of ['paid', 'mismatch']) {
    const value = order({ payment: invoice({ status,
      attempts: [invoice({ provider: 'meridianpay', bank: 'ЮMoney' })] }) });
    assert.match(R.orderBankMark(value, NOW), /<span class="bank-name">Альфа-Банк<\/span>/);
  }
});

test('банк и способ одновременно меняются при истечении исторического живого счёта', () => {
  const live = invoice({ expiresAt: NOW + 1 });
  const value = order({ payment: invoice({ provider: 'crocopay', status: 'failed', bank: '',
    attempts: [live] }) });
  assert.match(R.orderBankMark(value, NOW), /Альфа-Банк/);
  assert.match(R.orderPayMethod(value, NOW), /^СБП/);
  assert.equal(R.orderBankMark(value, NOW + 1), '');
  assert.match(R.orderPayMethod(value, NOW + 1), /^Карта или СБП/);
});

test('свои реквизиты используют только явно сохранённый банк, не текущую кассу', () => {
  const value = order({ payMode: 'own', manualPaid: { at: NOW, by: 'preview' },
    ownSnapshot: { bank: 'Ю-мани', owner: 'Тестовый получатель', phone: '+12025550101' } });
  const snapshot = structuredClone(value);
  assert.match(R.orderBankMark(value, NOW), /<svg class="bank-logo"/);
  assert.match(R.orderBankMark(value, NOW), /<span class="bank-name">Ю-мани<\/span>/);
  assert.equal(R.orderBankMark({ ...value, payMode: '' }, NOW), '');
  assert.equal(R.orderBankMark({ ...value, ownSnapshot: null }, NOW), '');
  assert.match(R.orderBankMark({ ...value, payment: invoice({ status: 'paid' }) }, NOW), /Альфа-Банк/,
    'оплаченная попытка сохраняет свой банк');
  assert.deepEqual(value, snapshot);
});

test('контекст Альфы меняет только подпись CARD_ONLINE, сохраняя протокол и ссылочный реквизит', () => {
  const snapshot = structuredClone(PAY.METHODS);
  const method = PAY.describe('CARD_ONLINE', 'alfabank');
  assert.equal(method.name, 'СБП');
  assert.equal(method.hint, 'Оплата через СБП на странице банка');
  assert.equal(method.mark, 'sbp');
  assert.equal(PAY.nameOf('CARD_ONLINE', 'alfabank'), 'СБП');
  assert.equal(method.id, 'CARD_ONLINE');
  assert.equal(method.kind, PAY.find('CARD_ONLINE').kind);
  assert.equal(method.hosted, true);
  assert.equal(PAY.requisiteLabel(method.id), 'Ссылка на оплату');
  assert.equal(PAY.requisiteProblem(method.id, ALFA_LINK), '');
  assert.equal(ALFA.supports('CARD_ONLINE'), true);
  assert.equal(ALFA.supports('SBP'), false, 'запросы по-прежнему используют старый идентификатор');
  for (const provider of [undefined, 'crocopay', 'meridianpay', 'unknown']) {
    assert.equal(PAY.describe('CARD_ONLINE', provider).name, 'Карта или СБП');
  }
  assert.equal(PAY.describe('TO_CARD', 'alfabank').name, 'Перевод на карту');
  assert.deepEqual(PAY.METHODS, snapshot, 'контекст не меняет общий справочник');
});

test('способ заказа Альфы подписан СБП, реквизиты и номер счёта сохранены', () => {
  const value = order({ payment: invoice({ status: 'paid', bank: 'Альфа-Банк', owner: 'Тестовый магазин' }) });
  const snapshot = structuredClone(value);
  const html = R.orderPayMethod(value, NOW);
  assert.match(html, /^СБП/);
  assert.doesNotMatch(html, /Карта или СБП/);
  assert.match(html, /<details class="o-req"><summary>Реквизиты<\/summary>/);
  assert.match(html, /Ссылка на оплату/);
  assert.ok(html.includes('href="' + R.esc(ALFA_LINK) + '"'));
  assert.match(html, /synthetic-invoice|Тестовый магазин/);
  assert.deepEqual(value, snapshot);
});

test('выбор до выставления счёта подписан СБП только при единственном маршруте через Альфу', () => {
  const configured = { ...settings, alfabankEnabled: true, alfabankToken: 'synthetictoken1234567890123456',
    payMethods: ['CARD_ONLINE'] };
  assert.equal(ALFA.enabled(configured), true);
  const value = order({ createdAt: Date.now(), draft: true });
  const methods = PAY.allowed(['CARD_ONLINE'], ['CARD_ONLINE']);
  const snapshot = structuredClone(methods);
  const opts = { methods, currency: 'RUB', amount: 1000, origin: '' };
  const html = R.payPage(configured, value, opts);
  assert.match(html, /name="pay-method" value="CARD_ONLINE"/);
  assert.match(html, /<b>СБП<\/b>/);
  assert.match(html, /Оплата через СБП на странице банка/);
  assert.doesNotMatch(html, /Карта или СБП/);
  const unknown = R.payPage(settings, value, opts);
  assert.match(unknown, /Карта или СБП/, 'без подтверждённой кассы способ не переименовывается');
  assert.deepEqual(methods, snapshot);
});

test('страница выставленного платежа и чек Альфы используют сохранённый provider', () => {
  const now = Date.now();
  const value = order({ createdAt: now, payment: invoice({ startedAt: now, expiresAt: now + 600000 }) });
  const page = R.payPage(settings, value, { methods: [], origin: '' });
  assert.match(page, /СБП/);
  assert.doesNotMatch(page, /Карта или СБП/);
  assert.ok(page.includes('href="' + R.esc(ALFA_LINK) + '"'));
  const receipt = R.receiptPage(settings, { ...value, payment: { ...value.payment, status: 'paid', paidAt: now } });
  assert.match(receipt, /СБП/);
  assert.doesNotMatch(receipt, /Карта или СБП/);
});

test('orderItems all показывает все позиции без раскрытия, обычный вызов сохраняет первые три', () => {
  const items = Array.from({ length: 5 }, (_, index) => ({ name: 'Товар <' + (index + 1) + '>', qty: index + 1 }));
  const value = { items }, snapshot = structuredClone(value);
  const plain = R.orderItems(value), all = R.orderItems(value, { all: true });
  assert.match(plain, /<details class="o-rest"><summary>ещё 2 позиции<\/summary>/);
  assert.doesNotMatch(plain.split('<details')[0], /Товар &lt;4&gt;/);
  assert.doesNotMatch(all, /<details|<summary|<Товар/);
  for (let i = 1; i <= 5; i++) assert.ok(all.includes('Товар &lt;' + i + '&gt;'));
  assert.match(all, /<b>× 5<\/b>/);
  assert.equal(R.orderItems(value, { all: false }), plain);
  assert.equal(R.orderItems({ items: [] }, { all: true }), '<span class="muted">—</span>');
  assert.deepEqual(value, snapshot);
});

const alfaSettings = { ...settings, alfabankEnabled: true,
  alfabankToken: 'synthetictoken1234567890123456', payMethods: ['CARD_ONLINE'] };
const crocoSettings = { crocopayEnabled: true, crocopayClientId: 'synthetic-client',
  crocopayClientSecret: 'synthetic-secret' };
const ownCardSettings = { ownPayEnabled: true, ownPayCard: '4111111111111111',
  ownPayOwner: 'Тестовый получатель' };
function footerMarks(html) {
  const footer = html.slice(html.indexOf('<footer'));
  return [...footer.matchAll(/class="pay (pay-[a-z]+)"/g)].map(match => match[1]);
}
function pageShell(config) { return R.layout(config, { body: '<p>Тестовая страница</p>', categories: [] }); }

test('инструкция действующего счёта Альфы говорит про СБП, чужого hosted-счёта — по-прежнему про карту', () => {
  const now = Date.now();
  for (const provider of ['alfabank', 'crocopay']) {
    const value = order({ createdAt: now,
      payment: invoice({ provider, startedAt: now, expiresAt: now + 600000 }) });
    const html = R.payPage(alfaSettings, value, { methods: [], origin: '' });
    const hint = html.match(/<p class="pay-hint">([\s\S]*?)<\/p>/);
    assert.ok(hint);
    if (provider === 'alfabank') {
      assert.match(hint[1], /^Оплата через СБП пройдёт/);
      assert.doesNotMatch(hint[1], /картой/);
    } else assert.match(hint[1], /^Оплата картой пройдёт/);
    assert.match(hint[1], /сумма там уже указана/);
    assert.match(hint[1], /как только банк подтвердит оплату, она обновится сама/);
  }
});

test('при единственной активной Альфе подвал выбора, счёта, успеха и витрины показывает только СБП', () => {
  const now = Date.now();
  const plain = order({ createdAt: now });
  const live = invoice({ startedAt: now, expiresAt: now + 600000 });
  const pages = [
    pageShell(alfaSettings),
    R.payPage(alfaSettings, plain, { methods: PAY.allowed(['CARD_ONLINE'], ['CARD_ONLINE']) }),
    R.payPage(alfaSettings, { ...plain, payment: live }, {}),
    R.payPage(alfaSettings, { ...plain, payment: { ...live, status: 'paid' } }, {})
  ];
  for (const html of pages) {
    assert.deepEqual(footerMarks(html), ['pay-sbp']);
    assert.doesNotMatch(html, /Карта или СБП|Оплата картой пройдёт|>Visa<|>Mastercard<|>Мир</);
  }
});

test('другая активная касса или активная оплата своими реквизитами сохраняет прежние логотипы подвала', () => {
  const cases = [
    { ...settings, ...crocoSettings },
    { ...alfaSettings, ...crocoSettings },
    { ...settings, meridianpayEnabled: true, meridianpayApiKey: 'synthetic-key',
      meridianpayMerchantId: '11111111-1111-1111-1111-111111111111' },
    { ...settings, ...ownCardSettings },
    { ...alfaSettings, alfabankEnabled: false, ...ownCardSettings },
    { ...settings, ownPayEnabled: true, ownPayPhone: '+12025550101', ownPayOwner: 'Тестовый получатель' }
  ];
  for (const config of cases) assert.deepEqual(footerMarks(pageShell(config)), ['pay-mir', 'pay-visa', 'pay-mc', 'pay-sbp']);
});

test('выключенные кассы, неполные ключи и неактивные собственные карты не обещают приём карт рядом с Альфой', () => {
  const cases = [
    { ...alfaSettings, ...crocoSettings, crocopayEnabled: false },
    { ...alfaSettings, crocopayEnabled: true, crocopayClientId: 'synthetic-client', crocopayClientSecret: '' },
    { ...alfaSettings, ...ownCardSettings }
  ];
  for (const config of cases) assert.deepEqual(footerMarks(pageShell(config)), ['pay-sbp']);
  for (const config of [settings, { ...alfaSettings, alfabankEnabled: false },
    { ...alfaSettings, alfabankToken: '' }]) assert.deepEqual(footerMarks(pageShell(config)), []);
});
