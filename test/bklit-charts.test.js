'use strict';

/* Графики «Метрики» — исходные компоненты Bklit UI (vendor/bklit), собранные в
 * public/bklit-charts.*. Сервер рисует острова с данными и прежней разметкой
 * внутри, браузер поднимает на их месте React. Здесь закреплено то, что ломается
 * молча: данные островов, подключение пакета, живое обновление и соответствие
 * собранного файла исходникам. */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const view = require('../lib/analytics-view');
const A = require('../lib/admin-views');
const minify = require('../lib/minify');
const CSSR = require('../lib/css-rules');

const root = path.join(__dirname, '..');
const vendor = path.join(root, 'vendor', 'bklit');
const SETTINGS = { storeName: 'Тестовый магазин', currency: '₽', currencyPosition: 'after' };
const fakeDb = { getProducts: () => [], pendingReviewCount: () => 0 };

// 21:50 по Москве: в отчёте «Сегодня» есть часы 00–21.
const GENERATED_AT = Date.parse('2026-09-09T18:50:00Z');
const day = (date, visitors, extra) => Object.assign({ date, visitors, visits: visitors * 2, activeSeconds: visitors * 240, orders: Math.floor(visitors / 10), pageViews: visitors * 3 }, extra);
const weekSnapshot = () => ({
  generatedAt: GENERATED_AT, days: 7, unique: 70, online: 3, averageSeconds: 130, orders: 4, conversion: 5.7, returnRate: 20,
  prev: { visitors: 50, visits: 90, activeSeconds: 9000, orders: 2 },
  daily: ['2026-09-03', '2026-09-04', '2026-09-05', '2026-09-06', '2026-09-07', '2026-09-08', '2026-09-09'].map((d, i) => day(d, 10 + i)),
  funnel: [
    { label: 'Заходы', value: 140 },
    { label: 'Смотрели товар', value: 60, step: 42.9, lost: 80 },
    { label: 'Дошли до оформления', value: 12, step: 20, lost: 48 },
    { label: 'Оформили заявку', value: 4, step: 33.3, lost: 8 }
  ],
  bounceRate: 30,
  speed: [{ name: 'lcp', count: 10, good: 7, ok: 2, poor: 1, average: 2100 }]
});

function islands(html) {
  return [...html.matchAll(/<(div|article) class="bk-island([^"]*)" data-bk="([^"]+)" data-bk-props="([^"]*)"/g)].map(m => ({
    tag: m[1], className: m[2].trim(), kind: m[3],
    props: JSON.parse(m[4].replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&'))
  }));
}

test('отчёт отдаёт графикам Bklit острова с данными, а прежняя разметка остаётся запасной', () => {
  const html = view.dashboard(weekSnapshot());
  const list = islands(html);
  const kinds = list.map(x => x.kind);
  assert.deepEqual(kinds.filter(k => k === 'stat').length, 4, 'все четыре плитки сводки');
  for (const kind of ['traffic', 'funnel', 'speed']) assert.ok(kinds.includes(kind), kind);

  const traffic = list.find(x => x.kind === 'traffic').props;
  assert.equal(traffic.points.length, 7);
  assert.deepEqual(traffic.points[0], { d: '2026-09-03', v: 10, s: traffic.points[0].s, l: traffic.points[0].l });
  assert.match(traffic.points.at(-1).l, /данные неполные$/, 'сегодняшний день помечен неполным');
  assert.equal(traffic.partial, true);
  assert.deepEqual(traffic.future, []);
  // Запасная разметка — прежний график, внутри острова.
  assert.match(html, /<div class="bk-fallback"><div class="metric-chart" role="group"/);

  const stats = list.filter(x => x.kind === 'stat');
  assert.equal(stats[0].tag, 'article');
  assert.match(stats[0].className, /\bmetric-card\b/, 'обёртка плитки остаётся панельной');
  const visitors = stats.find(x => x.props.title === 'Посетители').props;
  assert.equal(visitors.value, 70);
  assert.equal(visitors.trend, 40, 'тренд — тем же расчётом, что у серверной стрелки');
  assert.equal(visitors.spark.length, 7);
  const time = stats.find(x => x.props.title === 'Среднее время').props;
  assert.equal(time.format, 'duration');
  assert.equal(time.spark[0].v, 120, 'среднее время дня — вовлечённые секунды на заход');

  const funnel = list.find(x => x.kind === 'funnel').props;
  assert.deepEqual(funnel.stages.map(s => s.value), [140, 60, 12, 4]);
  assert.match(funnel.stages[1].note, /с прошлого шага/, 'доля от ПРЕДЫДУЩЕЙ ступени и потеря — под воронкой');

  const speed = list.find(x => x.kind === 'speed').props;
  assert.deepEqual(speed.rows, [{ label: 'Отрисовка главного', good: 7, total: 10, avg: '2,1 с' }]);
});

test('отчёт «Сегодня»: будущие часы продолжают ось до 24:00, но значений не несут', () => {
  const snapshot = {
    generatedAt: GENERATED_AT, days: 1, hasHours: true, daily: [],
    hourly: Array.from({ length: 24 }, (_, hour) => ({ hour, visitors: hour <= 21 ? hour + 1 : 999 }))
  };
  const traffic = islands(view.dashboard(snapshot)).find(x => x.kind === 'traffic').props;
  assert.equal(traffic.points.length, 22);
  assert.equal(traffic.points[0].s, '00:00');
  assert.match(traffic.points.at(-1).l, /^Сегодня, 21:00 · данные неполные$/);
  assert.deepEqual(traffic.future.map(p => p.h), [22, 23, 24]);
  assert.ok(traffic.future.every(p => !('v' in p)), 'у будущих часов нет выдуманных значений');
  assert.equal(traffic.future.at(-1).s, '24:00');
  // У «Сегодня» искорок нет: по часам есть одни посетители, а плитки одного
  // ряда обязаны быть одной высоты.
  assert.ok(islands(view.dashboard(snapshot)).filter(x => x.kind === 'stat').every(x => !x.props.spark));
});

test('пакет графиков подключается только на странице «Метрика»', () => {
  const metrics = A.analyticsPage(SETTINGS, fakeDb, weekSnapshot());
  const js = metrics.match(/<script src="\/static\/bklit-charts\.js\?v=[^"]+" defer><\/script>/g) || [];
  const css = metrics.match(/<link rel="stylesheet" href="\/static\/bklit-charts\.css\?v=[^"]+">/g) || [];
  assert.equal(js.length, 1);
  assert.equal(css.length, 1);
  assert.ok(metrics.indexOf(css[0]) < metrics.indexOf('</head>'));
  // Класс ставится до первой отрисовки: запасной график ждёт скрипт невидимым.
  assert.ok(metrics.indexOf("classList.add('bk-js')") < metrics.indexOf('</head>'));
  const other = A.settingsPage(SETTINGS, fakeDb, '');
  assert.doesNotMatch(other, /bklit-charts|bk-js/);
});

test('живое обновление переносит в остров только атрибуты — внутри живёт React', () => {
  const live = fs.readFileSync(path.join(root, 'public', 'admin-live.js'), 'utf8');
  assert.match(live, /if \(name === 'data-bk-mounted'\) return true;/, 'отметку «поднят» ставит браузер, сервер её не стирает');
  const morph = live.slice(live.indexOf('function morph(from, to)'), live.indexOf('function morphChildren'));
  assert.ok(morph.indexOf('syncAttrs(from, to)') < morph.indexOf("from.hasAttribute('data-bk-mounted')"),
    'сначала переносятся новые данные, потом остров отпускается');
  const adapter = fs.readFileSync(path.join(vendor, 'store-charts.tsx'), 'utf8');
  assert.match(adapter, /addEventListener\("admin-live:updated", scan\)/, 'перерисовка — по событию подмены');
  assert.match(adapter, /island\.json === json\) return;/, 'неизменившиеся данные не перерисовываются');
});

test('собранный пакет соответствует исходникам vendor/bklit, и они не правлены', () => {
  const files = [];
  (function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(p); else files.push(p);
    }
  })(path.join(vendor, 'src'));
  files.sort();
  const hash = crypto.createHash('sha256');
  for (const file of files) {
    hash.update(path.relative(vendor, file).split(path.sep).join('/'));
    hash.update(fs.readFileSync(file));
  }
  const digest = hash.digest('hex');
  for (const out of ['bklit-charts.js', 'bklit-charts.css']) {
    const head = fs.readFileSync(path.join(root, 'public', out), 'utf8').slice(0, 400);
    assert.ok(head.includes('Source tree SHA-256: ' + digest), out + ' собран из текущих исходников — пересоберите `npm run ui:charts`');
  }
  const readme = fs.readFileSync(path.join(vendor, 'README.md'), 'utf8');
  assert.ok(readme.includes(digest), 'README называет отпечаток исходников');
  // Русские подписи подставляются при сборке, а не правкой исходника.
  const formatters = fs.readFileSync(path.join(vendor, 'src', 'charts', 'chart-formatters.ts'), 'utf8');
  assert.match(formatters, /new Intl\.DateTimeFormat\("en-US"/);
  assert.match(fs.readFileSync(path.join(vendor, 'build.mjs'), 'utf8'), /chart-formatters\$\/[\s\S]*store-formatters\.ts/);
});

test('готовые файлы Bklit отдаются без повторной минификации, сброс .grid стоит до утилит', () => {
  for (const file of ['bklit-charts.js', 'bklit-charts.css']) {
    const buffer = fs.readFileSync(path.join(root, 'public', file));
    assert.equal(minify.forFile(file, buffer), buffer);
  }
  const css = fs.readFileSync(path.join(root, 'public', 'bklit-charts.css'), 'utf8');
  const reset = css.indexOf('.grid:where(.bk-root, .bk-root *) { grid-template-columns: none; gap: 0; }');
  assert.ok(reset > 0, 'сетка каталога витрины (.grid) не протекает в графики');
  assert.ok(reset < css.indexOf('.grid-cols-'), 'утилиты колонок перебивают сброс, а не наоборот');
  // Preflight и утилиты Tailwind действуют только внутри островов графиков:
  // панель грузит и styles.css витрины, и admin.css, и чужой `button{}` или
  // `svg{display:block}` без ограничения перекроил бы их.
  const unscoped = [];
  (function walk(list) {
    for (const rule of list) {
      if (rule.type === 'at') walk(rule.rules);
      else if (rule.type === 'rule') {
        for (const sel of CSSR.splitSelectors(rule.selector)) if (!/\.bk-/.test(sel)) unscoped.push(sel);
      }
    }
  })(CSSR.parse(css));
  assert.deepEqual(unscoped, [], 'каждый селектор ограничен островом графика');
  assert.match(fs.readFileSync(path.join(root, 'public', 'bklit-charts.LICENSE.txt'), 'utf8'), /MIT License[\s\S]*uixmat/);
});
