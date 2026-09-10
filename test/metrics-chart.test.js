'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const analyticsView = require('../lib/analytics-view');

// 21:50 in the store's Moscow timezone; the report includes hours 00–21.
const GENERATED_AT = Date.parse('2026-09-09T18:50:00Z');
const hourlySnapshot = (extra = {}) => ({
  generatedAt: GENERATED_AT, days: 1, hasHours: true, daily: [],
  hourly: Array.from({ length: 24 }, (_, hour) => ({ hour, visitors: hour <= 21 ? hour + 1 : 0 })),
  ...extra
});

function chart(snapshot) {
  const html = analyticsView.dashboard(snapshot);
  const start = html.indexOf('role="group" aria-label="Посетители по');
  assert.ok(start >= 0, 'the data has an accessible chart');
  return html.slice(start, html.indexOf('</section>', start));
}

function points(html) {
  return [...html.matchAll(/<button\b([^>]*\bclass="mc-hit"[^>]*)>/g)].map(match => ({
    attributes: match[1], label: match[1].match(/\baria-label="([^"]+)"/)[1]
  }));
}

function paths(html) {
  return [...html.matchAll(/<path\b[^>]*\bd="([^"]*)"[^>]*>/g)].map(match => ({
    tag: match[0], d: match[1]
  }));
}

test('future hours remain time-axis labels without zero-valued points or a falling line', () => {
  const snapshot = hourlySnapshot();
  const html = chart(snapshot);
  const labels = points(html).map(point => point.label);
  assert.equal(labels.length, 22);
  assert.match(labels[0], /^00:00: 1 посетитель$/);
  assert.match(labels.at(-1), /^21:00 · данные неполные: 22 посетителя$/);
  assert.ok(labels.every(label => !/^(22|23):00/.test(label)));
  assert.match(html, />23<\/span>/, 'the axis may still show the full day');

  const futureNoise = hourlySnapshot({ hourly: snapshot.hourly.map(row => ({
    ...row, visitors: row.hour > 21 ? 1000000 : row.visitors
  })) });
  assert.equal(chart(futureNoise), html, 'future values cannot affect points, peak, scale or path');
  const drawnXs = paths(html).flatMap(path => [...path.d.matchAll(/(-?[\d.]+),-?[\d.]+/g)].map(pair => Number(pair[1])));
  assert.ok(drawnXs.length > 0);
  assert.ok(Math.max(...drawnXs) <= 91.31, 'the plotted data stops at hour 21 of the 00–23 axis');
});

test('only the current hour is incomplete and uses a dashed segment with keyboard-readable values', () => {
  const html = chart(hourlySnapshot());
  const buttons = points(html);
  assert.equal(buttons.filter(point => point.label.includes('данные неполные')).length, 1);
  assert.match(buttons[20].label, /^20:00: 21 посетитель$/);
  assert.match(buttons[21].label, /^21:00 · данные неполные: 22 посетителя$/);
  for (const point of buttons) {
    assert.match(point.attributes, /\btype="button"/);
    assert.doesNotMatch(point.attributes, /\bdisabled|tabindex="-1"|aria-hidden="true"/);
    assert.match(point.label, /\d{2}:00.*: \d+ посетител/);
  }
  const dashed = paths(html).filter(path => /stroke-dasharray="[^"]+"/.test(path.tag));
  assert.equal(dashed.length, 1);
  assert.match(dashed[0].d, / C/, 'the unfinished hour is connected to the last completed hour');
  assert.match(html, /Неполный интервал/, 'the dashed segment has a visible explanation');
});

test('at Moscow midnight a single current-hour point is visible and finite', () => {
  const html = chart(hourlySnapshot({
    generatedAt: Date.parse('2026-09-08T21:00:00Z'),
    hourly: Array.from({ length: 24 }, (_, hour) => ({ hour, visitors: hour === 0 ? 3 : 0 }))
  }));
  assert.deepEqual(points(html).map(point => point.label), ['00:00 · данные неполные: 3 посетителя']);
  assert.doesNotMatch(html, /NaN|Infinity/);
  assert.match(html, /class="mc-current"[^>]*style="[^"]*left:0\.00%/, 'a visible marker represents the lone point');
  assert.ok(paths(html).some(path => /^M[\d.]+,[\d.]+$/.test(path.d)));
  assert.ok(paths(html).every(path => !/ C/.test(path.d)), 'a single observation cannot fabricate a time segment');
});

const dailySnapshot = () => ({
  generatedAt: GENERATED_AT, days: 7,
  daily: [
    { date: '2026-09-07', visitors: 2 }, { date: '2026-09-08', visitors: 3 },
    { date: '2026-09-09', visitors: 4 }, { date: '2026-09-10', visitors: 0 }
  ]
});

test('daily reports keep completed days, mark today incomplete and omit future observations', () => {
  const snapshot = dailySnapshot();
  const html = chart(snapshot);
  assert.deepEqual(points(html).map(point => point.label), [
    '07 сентября: 2 посетителя', '08 сентября: 3 посетителя', '09 сентября · данные неполные: 4 посетителя'
  ]);
  assert.equal(paths(html).filter(path => /stroke-dasharray=/.test(path.tag)).length, 1);
  snapshot.daily.at(-1).visitors = 1000000;
  assert.equal(chart(snapshot), html, 'a future day cannot change the displayed report');
});

test('hour and day cutoffs use Moscow regardless of the server timezone', () => {
  const source = `const view = require(${JSON.stringify(require.resolve('../lib/analytics-view'))});
    const snapshots = JSON.parse(process.argv[1]);
    process.stdout.write(JSON.stringify(snapshots.map(snapshot =>
      [...view.dashboard(snapshot).matchAll(/<button\\b[^>]*class="mc-hit"[^>]*aria-label="([^"]+)"/g)].map(match => match[1]))));`;
  const input = JSON.stringify([hourlySnapshot(), dailySnapshot()]);
  const expected = [hourlySnapshot(), dailySnapshot()].map(snapshot => points(chart(snapshot)).map(point => point.label));
  for (const TZ of ['UTC', 'Pacific/Honolulu', 'Asia/Tokyo']) {
    const output = execFileSync(process.execPath, ['-e', source, input], {
      env: { ...process.env, TZ }, encoding: 'utf8', timeout: 10000
    });
    assert.deepEqual(JSON.parse(output), expected, TZ);
  }
});
