'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = file => fs.readFileSync(path.join(__dirname, '..', 'public', file), 'utf8');
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const flush = async () => { for (let n = 0; n < 20; n++) await Promise.resolve(); };
const response = data => ({ json: async () => data });

// Только используемые браузерные примитивы. Проверяем полный скрипт чата,
// события и отложенные ответы, не копируя клиентские функции в тест.
class Element {
  constructor(tag = 'div') {
    this.tagName = tag;
    this.children = [];
    this.attributes = {};
    this.events = {};
    this.style = {};
    this.dataset = {};
    this.value = '';
    this.className = '';
    this.scrollHeight = 100;
    this.clientHeight = 100;
    this.scrollTop = 0;
    this.classList = {
      contains: value => this.className.split(/\s+/).includes(value),
      add: value => { if (!this.classList.contains(value)) this.className += ' ' + value; },
      remove: value => { this.className = this.className.split(/\s+/).filter(x => x !== value).join(' '); },
      toggle: (value, on) => on ? this.classList.add(value) : this.classList.remove(value)
    };
  }
  set textContent(value) { this.text = value; this.children = []; }
  get textContent() { return (this.text || '') + this.children.map(child => child.textContent).join(''); }
  setAttribute(key, value) { this.attributes[key] = String(value); }
  getAttribute(key) { return this.attributes[key] ?? null; }
  removeAttribute(key) { delete this.attributes[key]; }
  addEventListener(event, fn) { (this.events[event] ||= []).push(fn); }
  dispatch(event, data = {}) { for (const fn of this.events[event] || []) fn(data); }
  appendChild(child) { child.parentNode = this; this.children.push(child); return child; }
  removeChild(child) { this.children.splice(this.children.indexOf(child), 1); child.parentNode = null; }
  querySelectorAll(selector) {
    const result = [];
    for (const child of this.children) {
      const match = selector[0] === '.' ? child.classList.contains(selector.slice(1)) : child.tagName === selector;
      if (match) result.push(child);
      result.push(...child.querySelectorAll(selector));
    }
    return result;
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  focus() { this.focused = true; }
}

function chat(options = {}) {
  const nodes = {};
  for (const id of ['chat-widget', 'chat-panel', 'chat-log', 'chat-form', 'chat-input', 'chat-badge',
    'chat-open', 'chat-file', 'chat-picks']) nodes[id] = new Element();
  const sendButton = new Element('button');
  nodes['chat-form'].querySelector = () => sendButton;
  if (options.waiting) nodes['chat-widget'].setAttribute('data-chat-waiting', options.waiting);
  const document = new Element();
  document.visibilityState = 'visible';
  document.body = new Element('body');
  document.getElementById = id => nodes[id] || null;
  document.createElement = tag => new Element(tag);
  document.createElementNS = (_, tag) => new Element(tag);
  document.createTextNode = text => { const node = new Element('text'); node.textContent = text; return node; };
  const calls = [], sounds = [], timers = new Map();
  let serial = 0;
  const context = {
    document, Promise, Date, AbortController,
    FormData: class { append() {} },
    URL: { createObjectURL: () => 'blob:local-' + (++serial), revokeObjectURL() {} },
    localStorage: { getItem: () => null, setItem() {} },
    location: { pathname: '/' },
    ChatSound: { play: sound => sounds.push(sound) },
    matchMedia: () => ({ matches: false }),
    EventSource: class { addEventListener() {} close() {} },
    setTimeout: (fn, delay) => { const id = ++serial; timers.set(id, { fn, delay }); return id; },
    clearTimeout: id => timers.delete(id),
    setInterval: (fn, delay) => { const id = ++serial; timers.set(id, { fn, delay, interval: true }); return id; },
    clearInterval: id => timers.delete(id),
    fetch: (url, init) => {
      calls.push({ url, init });
      return options.fetch ? options.fetch(url, init) : Promise.resolve(response({ ok: true }));
    }
  };
  context.window = context;
  const code = source('chat.js').replace(/\}\)\(\);\s*$/, 'window.audit = { state, send, open, show, hide, append, startPolling, pollOnce };\n})();');
  vm.runInNewContext(code, context);
  return {
    ...context.audit, nodes, sendButton, document, calls, sounds, timers,
    timer(delay) {
      const entry = [...timers.entries()].find(([, timer]) => timer.delay === delay);
      assert.ok(entry, 'таймер ' + delay + ' существует');
      const [id, timer] = entry;
      if (!timer.interval) timers.delete(id);
      timer.fn();
    }
  };
}

test('чат сохраняет текст и исходные фото при сетевой ошибке', async () => {
  const h = chat({ fetch: async () => { throw new Error('offline'); } });
  h.state.started = true;
  h.nodes['chat-input'].value = 'Проверьте комплектацию';
  const photo = { name: 'photo.jpg' };
  h.state.files = [photo];
  h.send(h.nodes['chat-input'].value);
  await flush();
  assert.equal(h.nodes['chat-input'].value, 'Проверьте комплектацию');
  assert.equal(h.state.files[0], photo);
  assert.equal(h.state.sending, false);
  assert.equal(h.sendButton.disabled, false);
  assert.match(h.nodes['chat-log'].textContent, /Не удалось подтвердить отправку/);
  assert.equal(h.state.mine[0].box.getAttribute('aria-label'), 'отправка не подтверждена');
});

test('запоздавшее подтверждение чата не стирает новый текст и новые вложения', async () => {
  const pending = deferred();
  const h = chat({ fetch: () => pending.promise });
  h.state.started = true;
  h.nodes['chat-input'].value = 'Первый вопрос';
  const first = {}, second = {};
  h.state.files = [first];
  h.send('Первый вопрос');
  h.nodes['chat-input'].value = 'Второй вопрос';
  h.state.files.push(second);
  pending.resolve(response({ ok: true, at: 123 }));
  await flush();
  assert.equal(h.nodes['chat-input'].value, 'Второй вопрос');
  assert.equal(h.state.files.length, 1);
  assert.equal(h.state.files[0], second);
});

test('две одинаковые реплики покупателя отображаются обе, серверное эхо — один раз', async () => {
  let at = 100;
  const h = chat({ fetch: async () => response({ ok: true, at: ++at }) });
  h.state.started = true;
  for (let n = 0; n < 2; n++) {
    h.nodes['chat-input'].value = 'Да';
    h.send('Да');
    await flush();
  }
  assert.equal(h.nodes['chat-log'].querySelectorAll('.chat-me').length, 2);
  h.append({ role: 'user', text: 'Да', at: 102 });
  assert.equal(h.nodes['chat-log'].querySelectorAll('.chat-me').length, 2);
  assert.equal(h.state.mine[1].at, 102);
});

test('историческая реплика с тем же текстом не подтверждает ещё не отправленный черновик', async () => {
  const h = chat({ fetch: async () => response({ ok: false }) });
  h.state.started = true;
  h.nodes['chat-input'].value = 'Да';
  h.send('Да');
  h.append({ role: 'user', text: 'Да', at: 100 }, true);
  await flush();
  assert.equal(h.state.mine[0].at, 0);
  assert.equal(h.nodes['chat-input'].value, 'Да');
  assert.equal(h.nodes['chat-log'].querySelectorAll('.chat-me').length, 2);
});

test('одинаковая реплика из другой вкладки не путается с уже подтверждённой отправкой', async () => {
  const h = chat({ fetch: async () => response({ ok: true, at: 100 }) });
  h.state.started = true;
  h.nodes['chat-input'].value = 'Да';
  h.send('Да');
  await flush();
  h.append({ role: 'user', text: 'Да', at: 101 });
  assert.equal(h.nodes['chat-log'].querySelectorAll('.chat-me').length, 2);
});

test('входящее в фоновую вкладку остаётся непрочитанным до возвращения', async () => {
  const h = chat();
  h.state.started = true;
  h.state.id = 'dialog';
  h.state.open = true;
  h.document.visibilityState = 'hidden';
  h.append({ role: 'operator', text: 'Ваш товар есть', at: 100 });
  await flush();
  assert.equal(h.state.unread, 1);
  assert.deepEqual(h.sounds, ['in'], 'фоновая вкладка тоже сообщает о входящем звуком');
  assert.equal(h.calls.filter(call => call.url === '/api/chat/read').length, 0);
  h.document.visibilityState = 'visible';
  h.document.dispatch('visibilitychange');
  await flush();
  assert.equal(h.state.unread, 0);
  assert.equal(h.calls.filter(call => call.url === '/api/chat/read').length, 1);
});

test('отложенная отметка прочтения не уходит после скрытия вкладки', async () => {
  const h = chat();
  h.state.started = h.state.open = true;
  h.append({ role: 'operator', text: 'Здравствуйте', at: 100 });
  h.document.visibilityState = 'hidden';
  h.timer(900);
  await flush();
  assert.equal(h.calls.length, 0);
});

test('зависшее чтение JSON не блокирует резервный опрос чата навсегда', async () => {
  const h = chat({ fetch: async () => ({ json: () => new Promise(() => {}) }) });
  h.state.started = true;
  h.startPolling();
  await flush();
  assert.equal(h.state.pollBusy, true);
  h.timer(15000);
  await flush();
  assert.equal(h.state.pollBusy, false);
  assert.equal(h.calls[0].init.signal.aborted, true);
  h.timer(3000);
  await flush();
  assert.equal(h.calls.length, 2);
});

test('таймаут отправки сохраняет черновик и не повторяет POST автоматически', async () => {
  const h = chat({ fetch: () => new Promise(() => {}) });
  h.state.started = true;
  h.nodes['chat-input'].value = 'Нужна доставка';
  h.send('Нужна доставка');
  await flush();
  h.timer(30000);
  await flush();
  assert.equal(h.state.sending, false);
  assert.equal(h.nodes['chat-input'].value, 'Нужна доставка');
  assert.equal(h.calls.length, 1);
});

test('чат ждёт восстановления истории и разрешает повторить неудачное открытие', async () => {
  const pending = deferred();
  const h = chat({ waiting: 1, fetch: () => pending.promise });
  const same = h.open();
  assert.equal(same, h.state.opening);
  await flush();
  assert.equal(h.calls.length, 1);
  pending.resolve(response({ ok: false }));
  await flush();
  assert.equal(h.state.started, false);
  h.open();
  await flush();
  assert.equal(h.calls.length, 2);
});

test('Enter завершает IME composition без отправки сообщения', async () => {
  const h = chat();
  h.state.started = true;
  h.nodes['chat-input'].value = 'Текст';
  h.nodes['chat-input'].dispatch('keydown', { key: 'Enter', isComposing: true, preventDefault() { assert.fail('composition нельзя прерывать'); } });
  await flush();
  assert.equal(h.calls.length, 0);
});

test('обычный Enter отправляет со звуком сразу, Shift+Enter остаётся переносом строки', async () => {
  const h = chat();
  h.state.started = true;
  h.nodes['chat-input'].value = 'Текст';
  h.nodes['chat-input'].dispatch('keydown', { key: 'Enter', shiftKey: true, preventDefault() { assert.fail('перенос строки нельзя блокировать'); } });
  assert.deepEqual(h.sounds, []);
  let prevented = false;
  h.nodes['chat-input'].dispatch('keydown', { key: 'Enter', preventDefault() { prevented = true; } });
  assert.equal(prevented, true);
  assert.deepEqual(h.sounds, ['out'], 'звук прозвучал до первого ответа сети');
  assert.equal(h.calls.length, 0);
  await flush();
  assert.equal(h.calls.filter(call => call.url === '/api/chat/send').length, 1);
});

test('быстро закрытый чат не перехватывает фокус отложенным таймером', () => {
  const h = chat();
  h.state.started = true;
  h.show();
  h.hide();
  h.timer(60);
  assert.equal(h.nodes['chat-input'].focused, undefined);
  assert.equal(h.nodes['chat-open'].focused, true);
});

function reviews() {
  const list = new Element(), pager = new Element();
  list.dataset = { product: 'iphone', href: '/product/iphone' };
  pager.dataset = { sort: 'new', page: 1 };
  const document = { getElementById: id => ({ 'reviews-list': list, 'reviews-pager': pager }[id] || null), querySelector: () => null };
  const window = new Element(), requests = [], changes = [];
  const context = {
    document, window, URLSearchParams,
    location: { href: '/product/iphone?rsort=new', search: '?rsort=new' },
    history: { pushState: (...args) => changes.push(['push', ...args]), replaceState: (...args) => changes.push(['replace', ...args]) },
    fetch: url => { const next = deferred(); requests.push({ url, ...next }); return next.promise; }
  };
  const app = source('app.js');
  const start = app.indexOf("    var revList = document.getElementById('reviews-list');");
  const end = app.indexOf('    // Согласие даётся одной галочкой', start);
  vm.runInNewContext(app.slice(start, end), context);
  return { list, pager, window, requests, changes, location: context.location };
}

test('«Назад» во время загрузки отзывов побеждает старый ответ и старый pushState', async () => {
  const h = reviews();
  h.pager.dispatch('click', { target: { closest: () => ({ dataset: { page: 2 }, href: '/product/iphone?rpage=2' }) }, preventDefault() {} });
  h.window.dispatch('popstate', { state: { rsort: 'new', rpage: 1 } });
  assert.equal(h.requests.length, 2);
  h.requests[1].resolve(response({ ok: true, html: 'первая страница', pager: '', sort: 'new', page: 1 }));
  await flush();
  h.requests[0].resolve(response({ ok: true, html: 'вторая страница', pager: '', sort: 'new', page: 2 }));
  await flush();
  assert.equal(h.list.innerHTML, 'первая страница');
  assert.equal(h.pager.dataset.page, 1);
  assert.equal(h.changes.length, 1);
  assert.equal(h.changes[0][0], 'replace');
});

test('ошибка устаревшего запроса отзывов не перенаправляет после «Назад»', async () => {
  const h = reviews();
  h.pager.dispatch('click', { target: { closest: () => ({ dataset: { page: 2 }, href: '/product/iphone?rpage=2' }) }, preventDefault() {} });
  h.window.dispatch('popstate', { state: { rsort: 'new', rpage: 1 } });
  h.requests[0].reject(new Error('offline'));
  await flush();
  assert.equal(h.location.href, '/product/iphone?rsort=new');
  assert.equal(h.list.getAttribute('aria-busy'), 'true');
  h.requests[1].resolve(response({ ok: true, html: 'первая страница', pager: '', sort: 'new', page: 1 }));
  await flush();
  assert.equal(h.list.getAttribute('aria-busy'), null);
});
