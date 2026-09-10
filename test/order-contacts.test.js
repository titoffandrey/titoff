'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const R = require('../lib/render');

test('Telegram распознаёт обычный username без @ и явные контакты, сохраняя написание', () => {
  for (const [contact, expected] of [
    ['example_user', 'example_user'], ['  Example_User42  ', 'Example_User42'],
    ['@example_user', 'example_user'], ['  @Example_User42  ', 'Example_User42'],
    ['@name', 'name'], // Коллекционные имена бывают короче обычных пяти символов.
    ['t.me/example_user', 'example_user'], ['https://t.me/example_user/', 'example_user'],
    ['http://telegram.me/Example_User42', 'Example_User42'], ['https://telegram.dog/example_user', 'example_user'],
    ['HTTPS://T.ME/Example_User42', 'Example_User42'], ['https://t.me/example_user?profile', 'example_user'],
    ['https://t.me/example_user?text=old%20draft#fragment', 'example_user']
  ]) assert.equal(R.telegramUsername(contact), expected, contact);
  assert.match(R.orderTelegramHref({ contact: 'example_user' }), /^https:\/\/t\.me\/example_user\?text=/);
});

test('почта, подпись рядом с контактом и неоднозначный текст не становятся Telegram пользователя', () => {
  for (const contact of [
    '', '  ', null, undefined, 12345, {}, 'name', 'tg', '123456', 'example user', 'Иван', 'user@example.com',
    'user@example_user', 'user@t.me', 'user@telegram.me', 'mailto:user@example.com',
    'Telegram: @example_user', 'Иван @example_user', '@example_user или user@example.com',
    '@@example_user', '@пример', '@name.with.dots', '@name-with-dashes', '@123456',
    '@' + 'a'.repeat(33), '@exam\nple_user', '@example\u0000_user', '@example_user\u200b'
  ]) {
    assert.equal(R.telegramUsername(contact), '', String(contact));
    assert.equal(R.orderTelegramHref({ contact }), '', String(contact));
  }
});

test('Telegram отбрасывает чужие хосты, внедрение URL, инвайты и ссылки на сообщения или специальные действия', () => {
  for (const contact of [
    'https://t.me.evil.example/example_user', 'https://evil.example/t.me/example_user',
    'https://t.me@evil.example/example_user', 'https://evil.example@t.me/example_user',
    'https://t.me:8443/example_user', '//t.me/example_user', 'javascript:https://t.me/example_user',
    'https://t.me\\@evil.example/example_user', 'https://t.me/exam\nple_user',
    'https://t.me/%65xample_user', 'https://t.me/example_user%2f42', 'https://t.me/example_user/42',
    'https://t.me/+79991234567', 'https://t.me/+InviteHash', 'https://t.me/joinchat/InviteHash',
    'https://t.me/c/123/45', 'https://t.me/share?text=hello', 'https://t.me/proxy', '@share',
    'https://t.me/example_user?start=payload', 'https://t.me/example_user?startapp=payload',
    'https://t.me/example_user?direct', 'https://t.me/example_user?post=42',
    'https://t.me/example_user?text=x&redirect=https://evil.example'
  ]) assert.equal(R.telegramUsername(contact), '', contact);
});

test('граница длины username не отрезает символы и не меняет получателя', () => {
  const username = 'A' + 'b'.repeat(31);
  assert.equal(R.telegramUsername('@' + username), username);
  assert.equal(R.telegramUsername('https://t.me/' + username), username);
  assert.equal(R.telegramUsername('@' + username + 'c'), '');
  assert.equal(R.telegramUsername('https://t.me/' + username + 'c'), '');
});

test('Позвонить использует сохранённый телефон и тот же нормализованный номер, что WhatsApp', () => {
  const settings = { storeName: 'adcApple', currency: '₽' };
  for (const phone of ['+79991234567', '+7 (999) 123-45-67', '8 999 123-45-67', '+1 202 555 0100']) {
    const tel = R.orderTelHref({ phone });
    const wa = new URL(R.orderWaHref({ phone }, settings));
    assert.match(tel, /^tel:\+[1-9]\d{7,14}$/);
    assert.equal(wa.pathname, '/' + tel.slice('tel:+'.length));
  }
  for (const order of [null, {}, { contact: '+79991234567' }, { phone: '' }, { phone: '123' }, { phone: 'не указан' }]) {
    assert.equal(R.orderTelHref(order), '');
  }
});

test('Telegram открывает конкретный диалог с тем же черновиком заказа, что WhatsApp', () => {
  const settings = { storeName: 'adcApple & Co', currency: '₽' };
  const order = {
    number: '581240', firstName: 'Анна', phone: '+79991234567',
    contact: 'https://t.me/Example_User?text=чужой%20черновик&profile',
    createdAt: Date.UTC(2026, 8, 8, 9, 30), total: 79990,
    items: [{ name: 'iPhone & AirTag + чехол «100%» #1 📱', price: 79990, qty: 1 }],
    address: 'Москва, улица Первая, 10\nКвартира 5',
    clientIp: '192.0.2.123', clientBrowser: 'InternalBrowser'
  };
  const href = R.orderTelegramHref(order, settings);
  const telegram = new URL(href);
  const whatsapp = new URL(R.orderWaHref(order, settings));
  assert.equal(telegram.origin, 'https://t.me');
  assert.equal(telegram.pathname, '/Example_User');
  assert.equal(telegram.hash, '');
  assert.deepEqual([...telegram.searchParams.keys()], ['text']);
  assert.equal(telegram.searchParams.get('text'), R.orderMessage(order, settings));
  assert.equal(telegram.searchParams.get('text'), whatsapp.searchParams.get('text'));
  assert.match(href, /%0A/);
  assert.match(href, /%26/);
  assert.match(href, /%2B/);
  assert.match(href, /%23/);
  assert.doesNotMatch(href, /[\r\n ]/);
  assert.doesNotMatch(telegram.searchParams.get('text'), /чужой черновик|192\.0\.2\.123|InternalBrowser/);
});

test('старый заказ без телефона допускает Telegram, а телефон без username — только звонок и WhatsApp', () => {
  assert.match(R.orderTelegramHref({ contact: '@example_user' }), /^https:\/\/t\.me\/example_user\?text=/);
  assert.equal(R.orderTelHref({ contact: '@example_user' }), '');
  assert.equal(R.orderTelegramHref({ phone: '+79991234567', contact: 'user@example.com' }), '');
  assert.equal(R.orderTelHref({ phone: '+79991234567', contact: 'user@example.com' }), 'tel:+79991234567');
});
