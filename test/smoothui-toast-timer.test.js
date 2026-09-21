'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const vendor = path.join(__dirname, '..', 'vendor', 'smoothui');
const adapter = fs.readFileSync(path.join(vendor, 'store-toast.tsx'), 'utf8');
const upstream = fs.readFileSync(path.join(vendor, 'basic-toast.tsx'), 'utf8');

// Исполняем настоящую фабрику адаптера и настоящий effect оригинала.
// DOM/React здесь не нужны: проверяется переданный duration и его завершение.
const showSource = adapter.slice(adapter.indexOf('function show('), adapter.indexOf('\nfunction enhance('))
  .replace('function show(message: string, options: Options = {}, source?: HTMLElement): Handle',
    'function show(message, options = {}, source)')
  .replace('const entry: Entry =', 'const entry =')
  .replace(/options\.(type|duration)!/g, 'options.$1');
const timerEffect = upstream.match(/useEffect\(\(\) => \{(\n    if \(visible && duration > 0\)[\s\S]*?)\n  \}, \[visible, duration, onClose\]\);/);
assert.ok(timerEffect, 'В оригинале должен сохраниться effect автоматического закрытия');

function createRuntime(type, duration) {
  const timers = [];
  const state = {
    entries: [], types: new Set(['success', 'error', 'warning', 'info']),
    sourceEntries: new WeakMap(), serial: 0,
    render() {}, safeHref() {}, signature() {},
    remove(entry) { state.entries.splice(state.entries.indexOf(entry), 1); },
    setTimeout(callback, delay) { const timer = { callback, delay }; timers.push(timer); return timer; },
    clearTimeout(timer) { const index = timers.indexOf(timer); if (index !== -1) timers.splice(index, 1); },
    setVisible(visible) { state.visible = visible; },
  };
  state.window = { setTimeout: state.setTimeout };
  const context = vm.createContext(state);
  vm.runInContext(showSource, context);
  const options = duration === undefined ? { type } : { type, duration };
  state.show('Уведомление', options);
  const entry = state.entries[0];
  Object.assign(state, { visible: true, duration: entry.duration, onClose: entry.close });
  vm.runInContext(`(function () {${timerEffect[1]}\n})()`, context);
  return { state, entry, timers };
}

for (const type of ['success', 'error', 'warning', 'info']) {
  test(`SmoothUI ${type}: оригинальный таймер 3000 мс закрывает сообщение`, () => {
    const { state, entry, timers } = createRuntime(type);
    assert.equal(entry.duration, 3000);
    assert.equal(timers.length, 1);
    assert.equal(timers[0].delay, 3000);
    assert.equal(entry.visible, true);
    timers.shift().callback();
    assert.equal(state.visible, false);
    assert.equal(entry.visible, false);
    assert.equal(timers.length, 1, 'После закрытия остаётся только время exit-анимации');
    assert.equal(timers[0].delay, 180);
    timers.shift().callback();
    assert.equal(state.entries.length, 0);
  });
}

test('SmoothUI: наведение и фокус не останавливают исходный таймер', () => {
  assert.doesNotMatch(adapter, /paused|setPaused|mouseenter|mouseleave|focusin|focusout/);
  assert.match(adapter, /duration=\{entry\.duration\}/);
});

test('SmoothUI: явный duration: 0 по-прежнему поддерживается публичным API', () => {
  const { entry, timers } = createRuntime('info', 0);
  assert.equal(entry.duration, 0);
  assert.equal(timers.length, 0);
  assert.equal(entry.visible, true);
});
