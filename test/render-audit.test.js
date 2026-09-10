'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { execFileSync } = require('node:child_process');
const minify = require('../lib/minify');

// Исполняем тот же скрипт, который получает браузер. Управляемые часы и сеть
// воспроизводят обрывы без настоящего сервера и ожидания таймаутов по 20 секунд.
function browser(filename, options = {}) {
  let now = 100000;
  let sequence = 0;
  const timers = new Map();
  const events = new Map();
  const requests = [];
  const channels = [];
  const parsed = [];
  const classes = new Set();
  const mark = {
    classList: {
      contains: name => classes.has(name),
      toggle(name, on) { if (on) classes.add(name); else classes.delete(name); },
      add: name => classes.add(name), remove: name => classes.delete(name)
    },
    getAttribute: name => name === 'title' ? 'Свежие данные' : 'Нет связи',
    setAttribute() {}
  };
  const part = { innerHTML: 'готовая разметка', getAttribute: () => 'content' };
  const body = {
    classList: { contains: () => false },
    getAttribute: () => options.live === false ? '' : 'orders',
    hasAttribute: () => options.live !== false
  };
  function on(name, listener) {
    if (!events.has(name)) events.set(name, []);
    events.get(name).push(listener);
  }
  function schedule(fn, delay, repeat) {
    const id = ++sequence;
    timers.set(id, { fn, at: now + delay, repeat });
    return id;
  }
  class EventSource {
    constructor(url) { this.url = url; this.readyState = 1; this.listeners = {}; channels.push(this); }
    addEventListener(name, listener) { this.listeners[name] = listener; }
    close() { this.readyState = 2; }
  }
  const location = {
    href: 'https://shop.test/admin/orders', pathname: '/admin/orders',
    reload() { this.reloaded = true; }
  };
  const globals = {
    Date: class extends Date { static now() { return now; } },
    Promise, Error, AbortController,
    EventSource: options.sse === false ? undefined : EventSource,
    document: {
      body, activeElement: null, visibilityState: 'visible', hidden: false,
      querySelector: selector => selector === '.a-live' ? mark : null,
      querySelectorAll: selector => selector === '[data-live-part]' ? [part] : [],
      getElementById: () => null, addEventListener: on
    },
    DOMParser: class {
      parseFromString(html) {
        parsed.push(html);
        return { querySelector: () => html === 'не та страница' ? null : part };
      }
    },
    location,
    history: { pushState(state, title, url) { location.href = url; } },
    fetch(url, opts) {
      requests.push({ url, opts });
      return Promise.resolve().then(() => options.fetch ? options.fetch(requests.length, opts) : {
        ok: true, text: () => Promise.resolve('новая разметка')
      });
    },
    addEventListener: on,
    setTimeout: (fn, delay) => schedule(fn, delay, 0),
    clearTimeout: id => timers.delete(id),
    setInterval: (fn, delay) => schedule(fn, delay, delay)
  };
  globals.window = globals;
  vm.runInNewContext(minify.js(fs.readFileSync(path.join(__dirname, '../public', filename), 'utf8')), globals);
  async function flush() { for (let i = 0; i < 20; i++) await Promise.resolve(); }
  async function advance(ms) {
    const end = now + ms;
    await flush();
    for (;;) {
      const next = [...timers].filter(([, timer]) => timer.at <= end)
        .sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) break;
      now = next[1].at;
      if (next[1].repeat) next[1].at += next[1].repeat;
      else timers.delete(next[0]);
      next[1].fn();
      await flush();
    }
    now = end;
  }
  return {
    globals, requests, channels, parsed, classes, flush, advance,
    emit(name, event = {}) { for (const listener of events.get(name) || []) listener(event); },
    changed() {
      channels[0].onmessage({ data: '{"orders":1}' });
      channels[0].onmessage({ data: '{"orders":2}' });
    }
  };
}

test('панель повторяет неудачный запрос при открытом SSE без нового события', async () => {
  const b = browser('admin-live.js', {
    fetch: n => n === 1 ? { ok: false } : { ok: true, text: () => Promise.resolve('заказ получен') }
  });
  b.changed();
  await b.flush();
  assert.equal(b.requests.length, 1);
  await b.advance(3000);
  assert.equal(b.requests.length, 2);
  assert.deepEqual(b.parsed, ['заказ получен']);
  await b.advance(30000);
  assert.equal(b.requests.length, 2, 'после успеха лишних повторов нет');
});

test('таймаут чтения тела освобождает панель и отменяет зависший запрос', async () => {
  const b = browser('admin-live.js', {
    fetch: n => ({ ok: true, text: () => n === 1 ? new Promise(() => {}) : Promise.resolve('готово') })
  });
  b.changed();
  await b.advance(20000);
  assert.equal(b.requests[0].opts.signal.aborted, true);
  await b.advance(3000);
  assert.equal(b.requests.length, 2);
  assert.deepEqual(b.parsed, ['готово']);
});

test('страница без живых блоков не выдаётся за успешное обновление', async () => {
  const b = browser('admin-live.js', {
    fetch: n => ({ ok: true, text: () => Promise.resolve(n === 1 ? 'не та страница' : 'готово') })
  });
  b.changed();
  await b.advance(3000);
  assert.equal(b.requests.length, 2);
  assert.deepEqual(b.parsed, ['не та страница', 'готово']);
});

test('живой SSE не скрывает ошибку обновления страницы', async () => {
  const b = browser('admin-live.js', { fetch: () => ({ ok: false }) });
  b.changed();
  await b.advance(3000);
  b.channels[0].listeners.visitors({ data: '{"n":3}' });
  await b.advance(1000);
  assert.equal(b.classes.has('is-off'), true);
});

test('без EventSource переходы и запасной опрос панели продолжают работать', async () => {
  const b = browser('admin-live.js', { sse: false });
  b.globals.AdminLive.go('https://shop.test/admin/orders?period=week');
  await b.flush();
  assert.equal(b.requests.length, 1);
  assert.equal(b.parsed.length, 1);
  await b.advance(20000);
  assert.equal(b.requests.length, 2);
});

test('быстрый переход не подменяется запоздавшим ответом прежнего отчёта', async () => {
  let release;
  const b = browser('admin-live.js', {
    fetch: n => ({ ok: true, text: () => n === 1
      ? new Promise(resolve => { release = resolve; }) : Promise.resolve('второй отчёт') })
  });
  b.globals.AdminLive.go('https://shop.test/admin/orders?period=week');
  await b.flush();
  b.globals.AdminLive.go('https://shop.test/admin/orders?period=month');
  release('первый отчёт');
  await b.flush();
  assert.equal(b.requests.length, 2);
  assert.deepEqual(b.parsed, ['второй отчёт']);
});

test('форма восстанавливает присутствие администратора после возврата из bfcache', () => {
  const b = browser('admin-presence.js', { live: false });
  assert.equal(b.channels.length, 1);
  b.emit('pagehide');
  assert.equal(b.channels[0].readyState, 2);
  b.emit('pageshow', { persisted: true });
  assert.equal(b.channels.length, 2);
  assert.equal(b.channels[1].readyState, 1);
  b.emit('pageshow', { persisted: true });
  assert.equal(b.channels.length, 2, 'повторный pageshow не дублирует подключение');
});

test('метрика считает календарные периоды и показывает московское время в любой зоне сервера', () => {
  const script = `
    const assert = require('node:assert/strict');
    const views = require(${JSON.stringify(require.resolve('../lib/analytics-view'))});
    const visitors = views.visitorsPage({ from: '2026-09-09', to: '2026-09-09' }, { today: '2026-09-09' });
    assert.match(visitors, /from=2026-09-03&amp;to=2026-09-09[^>]*>7 дней/);
    assert.match(visitors, /from=2026-08-11&amp;to=2026-09-09[^>]*>30 дней/);
    assert.match(visitors, /09 сентября/);
    const at = Date.parse('2026-01-01T22:30:00Z');
    const visitor = views.visitorPage({ id: 'audit', activeSeconds: 7199,
      firstSeen: at, lastSeen: at, hits: [{ t: at, p: '/' }] });
    assert.match(visitor, /visit-time">01:30/);
    assert.match(visitor, /02 января в 01:30/);
    assert.match(visitor, /2 ч 0 мин/);
    assert.doesNotMatch(visitor, /1 ч 60 мин/);
    const yearly = views.dashboard({ days: 365, weekly: [
      { date: '2026-01-01', endDate: '2026-01-07', visitors: 2 },
      { date: '2026-01-08', endDate: '2026-01-14', visitors: 1 }
    ] });
    assert.match(yearly, /01 января — 07 января/);
    assert.match(yearly, /class="mc-x[^\"]*"[^>]*>2026</);
    assert.doesNotMatch(yearly, /31 декабря/);
  `;
  for (const timezone of ['UTC', 'Europe/Moscow', 'Asia/Vladivostok', 'America/Los_Angeles']) {
    assert.doesNotThrow(() => execFileSync(process.execPath, ['-e', script], {
      env: { ...process.env, TZ: timezone }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']
    }), timezone);
  }
});

test('старый выбранный месяц не вытесняет сегодняшний из календаря метрики', () => {
  const source = fs.readFileSync(path.join(__dirname, '../public/admin-ui.js'), 'utf8');
  const body = source.slice(source.indexOf('  function renderMonths()'), source.indexOf('  function showPane('));
  assert.ok(body.includes('function renderMonths()'), 'проверяется существующий рендер календаря');
  for (const selected of ['2024-01-15', '2026-01-15', '']) {
    const months = [];
    vm.runInNewContext(body + '\nrenderMonths();', {
      monthList: { querySelector: () => null, scrollHeight: 0 },
      draft: { from: selected }, activeName: 'from', today: '2026-09-09',
      parse: value => value ? new Date(value + 'T12:00:00') : null,
      addMonth: (container, year, month) => months.push(year + '-' + String(month + 1).padStart(2, '0'))
    });
    assert.ok(months.includes('2026-09'), 'сегодня доступно при выбранной дате ' + selected);
    if (selected) assert.ok(months.includes(selected.slice(0, 7)), 'выбранный месяц доступен');
    assert.ok(months.length <= 18, 'календарь не создаёт тысячи кнопок для давнего периода');
    assert.equal(new Set(months).size, months.length);
  }
});
