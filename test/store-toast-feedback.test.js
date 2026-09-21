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
  select() {}
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
  const calls = [], sounds = [], timers = new Map(), stored = new Map();
  let serial = 0;
  const context = {
    document, Promise, Date, AbortController, StoreToast: options.toast,
    FormData: class { append() {} },
    URL: { createObjectURL: () => 'blob:local-' + (++serial), revokeObjectURL() {} },
    /* Память браузера: по умолчанию окно чата уже открывали (`chat_seen_v1`) —
     * сценарии ниже про живой разговор, а не про первый визит; у нового
     * посетителя (`options.fresh`) память пуста, и приветствие считается
     * непрочитанным. Записи собираются в `stored`. */
    localStorage: {
      getItem: key => stored.has(key) ? stored.get(key) : (!options.fresh && key === 'chat_seen_v1' ? '1' : null),
      setItem: (key, value) => stored.set(key, String(value))
    },
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
    ...context.audit, nodes, sendButton, document, calls, sounds, timers, stored,
    timer(delay) {
      const entry = [...timers.entries()].find(([, timer]) => timer.delay === delay);
      assert.ok(entry, 'таймер ' + delay + ' существует');
      const [id, timer] = entry;
      if (!timer.interval) timers.delete(id);
      timer.fn();
    }
  };
}


function toastRecorder() {
  const calls = [], visible = new Map();
  return {
    calls, visible,
    show(text, options) { calls.push({ text, ...options }); visible.set(options.id, { text, ...options }); },
    dismiss(id) { visible.delete(id); }
  };
}

function payment(options = {}) {
  const nodes = {};
  for (const id of ['pay-page', 'pay-msg', 'pay-create', 'pay-state', 'pay-recheck']) nodes[id] = new Element();
  nodes['pay-page'].dataset = { order: 'order-test', state: options.pending ? 'pending' : 'draft' };
  nodes['pay-state'].textContent = 'Ждём перевод…';
  nodes['pay-msg'].hidden = true;
  const method = new Element('input');
  method.value = 'TEST_METHOD'; method.checked = !options.noMethod;
  const document = new Element();
  document.visibilityState = 'visible'; document.readyState = 'complete';
  document.body = new Element('body');
  document.getElementById = id => nodes[id] || null;
  document.querySelector = () => method.checked ? method : null;
  document.querySelectorAll = () => [method];
  document.createElement = tag => new Element(tag);
  const timers = new Map(), stored = new Map();
  let serial = 0;
  const context = {
    document, Date, Promise, URL, URLSearchParams, StoreToast: options.toast,
    navigator: { clipboard: { writeText: text => options.copy ? options.copy(text) : Promise.resolve() } },
    location: { search: '', pathname: '/pay/order-test', origin: 'https://example.test', href: '', reload() {} },
    localStorage: {
      length: 0, getItem: key => stored.get(key) || null,
      setItem: (key, value) => stored.set(key, value), removeItem: key => stored.delete(key)
    },
    addEventListener() {},
    setTimeout: fn => { const id = ++serial; timers.set(id, fn); return id; },
    clearTimeout: id => timers.delete(id),
    setInterval: fn => { const id = ++serial; timers.set(id, fn); return id; },
    clearInterval: id => timers.delete(id),
    fetch: (...args) => options.fetch ? options.fetch(...args) : Promise.resolve(response({ ok: true, url: '/pay/order-test' }))
  };
  context.window = context;
  vm.runInNewContext(source('pay.js'), context);
  return { ...context, nodes, method, timers };
}

function copyClick(h) {
  const button = new Element('button');
  button.dataset.copy = 'synthetic-requisite'; button.textContent = 'Копировать';
  h.nodes['pay-page'].dispatch('click', { target: { closest: () => button } });
  return button;
}

test('ошибка вложения чата приходит уведомлением, исправление убирает её, история остаётся в разговоре', () => {
  const toast = toastRecorder(), h = chat({ toast });
  h.append({ role: 'system', text: 'Разговор передан менеджеру.' });
  h.nodes['chat-file'].files = [{ name: 'bad.txt', type: 'text/plain', size: 20 }];
  h.nodes['chat-file'].dispatch('change');
  assert.equal(toast.calls.length, 1);
  assert.equal(toast.calls[0].type, 'warning');
  assert.match(toast.calls[0].text, /только фотографии/);
  assert.doesNotMatch(h.nodes['chat-log'].textContent, /только фотографии/);
  assert.match(h.nodes['chat-log'].textContent, /Разговор передан менеджеру/);
  h.nodes['chat-file'].files = [{ name: 'good.jpg', type: 'image/jpeg', size: 20 }];
  h.nodes['chat-file'].dispatch('change');
  assert.equal(toast.visible.size, 0);
  assert.equal(h.state.files.length, 1);
});

test('ошибка отправки чата сохраняет черновик и галочку, успешный повтор закрывает уведомление', async () => {
  let offline = true;
  const toast = toastRecorder(), h = chat({ toast, fetch: async () => {
    if (offline) throw new Error('offline');
    return response({ ok: true, at: 123 });
  } });
  h.state.started = true;
  h.nodes['chat-input'].value = 'Проверьте комплектацию';
  h.send(h.nodes['chat-input'].value);
  await flush();
  assert.equal(h.nodes['chat-input'].value, 'Проверьте комплектацию');
  assert.equal(h.state.mine[0].box.getAttribute('aria-label'), 'отправка не подтверждена');
  assert.equal(toast.calls.length, 1);
  assert.equal(toast.calls[0].type, 'error');
  assert.equal(toast.calls[0].duration, 0);
  assert.doesNotMatch(h.nodes['chat-log'].textContent, /Не удалось подтвердить/);
  offline = false;
  h.send(h.nodes['chat-input'].value);
  await flush();
  assert.equal(h.nodes['chat-input'].value, '');
  assert.equal(toast.visible.size, 0);
  assert.equal(toast.calls.length, 1);
});

test('без библиотеки уведомлений ошибка чата сохраняет читаемое объяснение', async () => {
  const h = chat({ fetch: async () => { throw new Error('offline'); } });
  h.state.started = true;
  h.nodes['chat-input'].value = 'Вопрос'; h.send('Вопрос');
  await flush();
  assert.match(h.nodes['chat-log'].textContent, /Не удалось подтвердить отправку/);
  assert.equal(h.nodes['chat-input'].value, 'Вопрос');
});

test('копирование оплаты сообщает успех или отказ одним уведомлением без реквизитов и дублирования на кнопке', async () => {
  const toast = toastRecorder();
  const success = payment({ toast });
  const goodButton = copyClick(success);
  await flush();
  assert.equal(toast.calls[0].type, 'success');
  assert.equal(goodButton.textContent, 'Копировать');
  const fail = payment({ toast, copy: async () => { throw new Error('denied'); } });
  fail.document.execCommand = () => false;
  const badButton = copyClick(fail);
  await flush();
  assert.equal(toast.calls[1].type, 'warning');
  assert.equal(badButton.textContent, 'Копировать');
  assert.equal(toast.visible.size, 1);
  assert.ok(toast.calls.every(call => !call.text.includes('synthetic-requisite')));
});

test('ошибка выбора оплаты остаётся уведомлением до успешного выставления счёта', async () => {
  const toast = toastRecorder(), h = payment({ toast, noMethod: true });
  h.nodes['pay-create'].dispatch('click');
  assert.equal(toast.calls[0].type, 'error');
  assert.equal(toast.calls[0].duration, 0);
  assert.equal(h.nodes['pay-msg'].hidden, true);
  h.method.checked = true;
  h.nodes['pay-create'].dispatch('click');
  await flush();
  assert.equal(h.location.href, '/pay/order-test');
  assert.equal(toast.visible.size, 0);
});

test('ручная ошибка проверки оплаты видна один раз, фон молчит, успешная проверка закрывает ошибку', async () => {
  let offline = true;
  const toast = toastRecorder(), h = payment({ toast, pending: true, fetch: async () => {
    if (offline) throw new Error('offline');
    return response({ ok: true, state: 'pending' });
  } });
  h.nodes['pay-recheck'].dispatch('click');
  await flush();
  assert.equal(toast.calls.length, 1);
  assert.equal(toast.calls[0].type, 'error');
  assert.equal(toast.calls[0].duration, 0);
  assert.equal(h.nodes['pay-state'].textContent, 'Ждём перевод…');
  h.document.dispatch('visibilitychange');
  await flush();
  assert.equal(toast.calls.length, 1);
  offline = false;
  h.nodes['pay-recheck'].dispatch('click');
  await flush();
  assert.equal(toast.visible.size, 0);
  assert.match(h.nodes['pay-state'].textContent, /Перевод пока не виден/);
});

test('без библиотеки уведомлений оплата сохраняет сообщение ошибки и подтверждение копирования', async () => {
  const h = payment({ noMethod: true });
  h.nodes['pay-create'].dispatch('click');
  assert.equal(h.nodes['pay-msg'].hidden, false);
  assert.equal(h.nodes['pay-msg'].textContent, 'Выберите способ оплаты');
  const button = copyClick(h);
  await flush();
  assert.equal(button.textContent, 'Скопировано');
});
