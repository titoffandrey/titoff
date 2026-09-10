'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const R = require('../lib/render');

const ms = value => Date.parse(value);

test('«Вчера» доступно после «Сегодня» и принимает числовой параметр -1', () => {
  const today = R.ORDER_PERIODS.findIndex(([value]) => value === 1);
  assert.deepEqual(R.ORDER_PERIODS[today + 1], [-1, 'Вчера']);
  assert.equal(R.ORDER_PERIODS.filter(([value]) => value === -1).length, 1);
  for (const raw of [-1, '-1', ' -1 ']) {
    assert.equal(R.orderPeriod(raw), -1);
    assert.equal(R.orderPeriodLabel(raw), 'Вчера');
  }
});

test('«Вчера» включает обе стороны суток до миллисекунды, исключает сегодня и позавчера', () => {
  const start = ms('2026-09-08T00:00:00+03:00');
  const end = ms('2026-09-09T00:00:00+03:00');
  const now = ms('2026-09-09T15:42:18.456+03:00');
  const orders = [
    { id: 'позавчера', createdAt: start - 1 },
    { id: 'начало вчера', createdAt: start },
    { id: 'утро вчера', createdAt: ms('2026-09-08T08:00:00+03:00') },
    { id: 'конец вчера', createdAt: String(end - 1) },
    { id: 'начало сегодня', createdAt: end },
    { id: 'сейчас', createdAt: now },
    { id: 'будущее', createdAt: now + 86400000 },
    { id: 'повреждённая дата', createdAt: 'не дата' },
    { id: 'даты нет' }, null
  ];
  const snapshot = structuredClone(orders);
  assert.equal(R.orderPeriodSince(-1, now), start);
  const selected = R.ordersInPeriod(orders, '-1', now);
  assert.deepEqual(selected.map(order => order.id), ['начало вчера', 'утро вчера', 'конец вчера']);
  assert.strictEqual(selected[0], orders[1], 'возвращаются сами заказы, без переписывания данных');
  assert.deepEqual(orders, snapshot);
});

test('границы «Вчера» переходят через месяц, год и високосный февраль', () => {
  const cases = [
    ['2026-09-09T00:00:00+03:00', '2026-09-08'],
    ['2026-09-09T23:59:59.999+03:00', '2026-09-08'],
    ['2026-09-01T10:00:00+03:00', '2026-08-31'],
    ['2026-01-01T01:15:00+03:00', '2025-12-31'],
    ['2026-03-01T12:00:00+03:00', '2026-02-28'],
    ['2024-03-01T12:00:00+03:00', '2024-02-29']
  ];
  for (const [clock, date] of cases) {
    const now = ms(clock), since = ms(date + 'T00:00:00+03:00');
    assert.equal(R.orderPeriodSince(-1, now), since, clock);
    const selected = R.ordersInPeriod([
      { id: 'до', createdAt: since - 1 }, { id: 'от', createdAt: since },
      { id: 'до полуночи', createdAt: since + 86400000 - 1 },
      { id: 'сегодня', createdAt: since + 86400000 }
    ], -1, now);
    assert.deepEqual(selected.map(order => order.id), ['от', 'до полуночи'], clock);
  }
});

test('ровно в московскую полночь вчерашним становится только завершившийся день', () => {
  const midnight = ms('2026-10-01T00:00:00+03:00');
  const orders = [
    { id: '29 сентября', createdAt: ms('2026-09-29T12:00:00+03:00') },
    { id: '30 сентября', createdAt: ms('2026-09-30T12:00:00+03:00') },
    { id: '1 октября', createdAt: midnight }
  ];
  assert.deepEqual(R.ordersInPeriod(orders, -1, midnight - 1).map(order => order.id), ['29 сентября']);
  assert.deepEqual(R.ordersInPeriod(orders, -1, midnight).map(order => order.id), ['30 сентября']);
});

test('фильтр «Вчера» читает текущие часы один раз, даже если расчёт пересёк полночь', t => {
  const midnight = ms('2026-09-10T00:00:00+03:00');
  let calls = 0;
  t.mock.method(Date, 'now', () => calls++ === 0 ? midnight - 1 : midnight);
  const selected = R.ordersInPeriod([
    { id: 'вчера', createdAt: ms('2026-09-08T12:00:00+03:00') },
    { id: 'сегодня', createdAt: ms('2026-09-09T12:00:00+03:00') }
  ], -1);
  assert.deepEqual(selected.map(order => order.id), ['вчера']);
  assert.equal(calls, 1, 'нижняя и верхняя границы рассчитаны от одного now');
});

test('переданный now полностью задаёт период без чтения текущих часов', t => {
  const now = ms('2026-01-01T01:00:00+03:00');
  t.mock.method(Date, 'now', () => { throw new Error('Текущие часы читать нельзя'); });
  assert.equal(R.orderPeriodSince(-1, now), ms('2025-12-31T00:00:00+03:00'));
  assert.equal(R.ordersInPeriod([{ createdAt: ms('2025-12-31T23:59:59+03:00') }], -1, now).length, 1);
});

test('старые периоды сохраняют календарную нижнюю границу и прежний отбор', () => {
  const now = ms('2026-01-02T12:40:00+03:00');
  const cases = [[1, '2026-01-02'], [7, '2025-12-27'], [30, '2025-12-04'], [365, '2025-01-03']];
  for (const [period, date] of cases) {
    const since = ms(date + 'T00:00:00+03:00');
    assert.equal(R.orderPeriodSince(period, now), since, String(period));
    const orders = [
      { id: 'рано', createdAt: since - 1 }, { id: 'граница', createdAt: since },
      { id: 'сейчас', createdAt: now }, { id: 'будущая метка', createdAt: now + 86400000 }
    ];
    assert.deepEqual(R.ordersInPeriod(orders, period, now).map(order => order.id),
      ['граница', 'сейчас', 'будущая метка'], 'новая верхняя граница применяется только к «Вчера»: ' + period);
  }
  assert.equal(R.orderPeriod(7.5), 7, 'прежняя нормализация положительных периодов сохранена');
});

test('все даты и прежние некорректные параметры по-прежнему означают «за всё время»', () => {
  const orders = [{ createdAt: 1 }, { createdAt: 'не дата' }, null];
  for (const raw of [0, undefined, null, '', 'мусор', '99', '-2', -0.5, '-0.01', NaN, Infinity]) {
    assert.equal(R.orderPeriod(raw), 0, String(raw));
    assert.equal(R.orderPeriodSince(raw), 0, String(raw));
    assert.strictEqual(R.ordersInPeriod(orders, raw), orders, String(raw));
  }
  for (const value of [undefined, null, {}, 'orders']) assert.deepEqual(R.ordersInPeriod(value, -1), []);
});

test('московские границы не зависят от зоны сервера, включая пропущенный час местного DST', () => {
  const script = `
    const assert = require('node:assert/strict');
    const R = require(${JSON.stringify(require.resolve('../lib/render'))});
    const cases = [
      ['2026-03-07T23:30:00.456Z', '2026-03-06T21:00:00Z', '2026-03-07T21:00:00Z'],
      ['2026-03-28T23:30:00.789Z', '2026-03-27T21:00:00Z', '2026-03-28T21:00:00Z'],
      ['2025-12-31T21:01:00Z', '2025-12-30T21:00:00Z', '2025-12-31T21:00:00Z']
    ];
    for (const [clock, yesterday, today] of cases) {
      const now = Date.parse(clock), start = Date.parse(yesterday), end = Date.parse(today);
      assert.equal(R.orderPeriodSince(-1, now), start, clock);
      assert.equal(R.orderPeriodSince(1, now), end, clock);
      assert.equal(R.orderPeriodSince(7, now), end - 6 * 86400000, clock);
      const orders = [{ id: 1, createdAt: start - 1 }, { id: 2, createdAt: start },
        { id: 3, createdAt: end - 1 }, { id: 4, createdAt: end }];
      assert.deepEqual(R.ordersInPeriod(orders, -1, now).map(o => o.id), [2, 3]);
    }
  `;
  for (const timezone of ['UTC', 'Europe/Moscow', 'Asia/Vladivostok', 'America/Los_Angeles', 'Europe/Berlin']) {
    assert.doesNotThrow(() => execFileSync(process.execPath, ['-e', script], {
      env: { ...process.env, TZ: timezone }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']
    }), timezone);
  }
});

test('без ICU московская граница использует UTC+3 независимо от местного DST', () => {
  const script = `
    const assert = require('node:assert/strict');
    Intl.DateTimeFormat = function () { throw new Error('ICU недоступен'); };
    const R = require(${JSON.stringify(require.resolve('../lib/render'))});
    const now = Date.parse('2026-03-07T23:30:00.456Z');
    assert.equal(R.orderPeriodSince(-1, now), Date.parse('2026-03-06T21:00:00Z'));
    assert.equal(R.orderPeriodSince(1, now), Date.parse('2026-03-07T21:00:00Z'));
  `;
  assert.doesNotThrow(() => execFileSync(process.execPath, ['-e', script], {
    env: { ...process.env, TZ: 'America/Los_Angeles' }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']
  }));
});
