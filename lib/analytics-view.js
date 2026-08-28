'use strict';

const R = require('./render');
const CI = require('./client-icons');
const { ONLINE_MS, VISITORS_PER_PAGE, sessionsOf } = require('./analytics');
const esc = R.esc;

function n(value) { return Number(value || 0).toLocaleString('ru-RU'); }
function pct(value) { return String(Number(value || 0).toLocaleString('ru-RU', { maximumFractionDigits: 1 })) + '%'; }
function duration(value) {
  const seconds = Math.max(0, Math.round(Number(value) || 0));
  if (seconds < 60) return seconds ? seconds + ' сек' : '—';
  if (seconds < 3600) return Math.floor(seconds / 60) + ' мин ' + seconds % 60 + ' сек';
  return Math.floor(seconds / 3600) + ' ч ' + Math.floor((seconds % 3600) / 60) + ' мин';
}
// Короткая длительность для плиток: «19 мин 59 сек» в 22 пикселя переносится на
// вторую строку и ломает ряд, а точность до секунды там и не нужна — она есть в
// хронологии ниже.
function durationShort(value) {
  const seconds = Math.max(0, Math.round(Number(value) || 0));
  if (seconds < 60) return seconds ? seconds + ' сек' : '—';
  if (seconds < 3600) return Math.round(seconds / 60) + ' мин';
  return Math.floor(seconds / 3600) + ' ч ' + Math.round((seconds % 3600) / 60) + ' мин';
}
function plural(value, one, few, many) {
  const a = Math.abs(Number(value) || 0) % 100;
  const b = a % 10;
  if (a > 10 && a < 20) return many;
  if (b > 1 && b < 5) return few;
  return b === 1 ? one : many;
}
function ago(ms, now) {
  const diff = Math.max(0, Number(now) - Number(ms || 0));
  if (diff < 60 * 1000) return 'только что';
  if (diff < 60 * 60 * 1000) return Math.floor(diff / 60000) + ' мин назад';
  if (diff < 24 * 60 * 60 * 1000) return Math.floor(diff / 3600000) + ' ч назад';
  return R.formatDate(ms);
}
/* Город посетителя строкой. Страна берётся ПО КОДУ из общей таблицы, а не как
 * лежит в карточке: кэш геолокации собирался двумя источниками, и они называют
 * одну страну по-разному («Россия» у своей базы, «Российская Федерация» у
 * прежнего внешнего сервиса). В списке городов это давало два ряда «Москва»
 * подряд, а в строке посетителя — соседей, у которых одна и та же страна
 * называется по-разному. Кода нет (карточка старая) — остаётся её собственное
 * название: оно честнее пустоты. */
function location(v) {
  const country = CI.countryName(v && v.countryCode) || (v && v.country) || '';
  return [v.city, v.region, country].filter(Boolean).filter((x, i, a) => a.indexOf(x) === i).join(', ') || 'Город не определён';
}
function device(v) { return [v.model || v.device, v.os, v.browser].filter(Boolean).join(' · ') || 'Не определено'; }
// Флаг страны рядом с городом. Кода нет — вернётся пустая строка, и подпись
// останется просто текстом: раскладка от этого не меняется.
function flagMark(v) {
  const f = CI.flag(v && v.country, v && v.countryCode);
  return f ? `<b class="cflag">${f}</b> ` : '';
}
// Значки устройства, системы и браузера — те же, что в строке заказа.
function deviceMarks(v) {
  return R.clientMarks({ device: v.device, model: v.model, os: v.os, browser: v.browser });
}
function dateTime(ms) {
  const d = new Date(Number(ms) || 0);
  if (Number.isNaN(d.getTime()) || !ms) return '—';
  return d.toLocaleString('ru-RU', { day: '2-digit', month: 'long', hour: '2-digit', minute: '2-digit' });
}
function clock(ms) {
  const d = new Date(Number(ms) || 0);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
}
// Дата YYYY-MM-DD → «27 июля». Для подписей графика и заголовка отбора.
function dayLabel(date, opts) {
  const d = new Date(String(date) + 'T00:00:00+03:00');
  if (Number.isNaN(d.getTime())) return String(date || '');
  return d.toLocaleDateString('ru-RU', Object.assign({ day: '2-digit', month: 'short' }, opts || {}));
}
function technical(v) {
  const power = [v.deviceMemory ? v.deviceMemory + ' ГБ RAM' : '', v.cpuCores ? v.cpuCores + ' ядер' : ''].filter(Boolean).join(' · ');
  return [v.platform, v.screen ? 'экран ' + v.screen : '', v.viewport ? 'окно ' + v.viewport : '', v.language, v.timezone, power, v.connection].filter(Boolean).join(' · ');
}
// Понятные названия для страниц, которые считает метрика: в списке «Популярные
// страницы» голый путь читается хуже, чем название раздела.
const PAGE_NAMES = {
  '/': 'Главная',
  '/checkout': 'Оформление заказа',
  '/privacy': 'Политика конфиденциальности',
  '/personal-data-consent': 'Согласие на обработку данных',
  '/personal-data-publication-consent': 'Согласие на публикацию отзыва',
  '/warranty': 'Гарантия',
  '/returns': 'Возврат и обмен'
};
function pageLabel(path, products) {
  const known = Object.prototype.hasOwnProperty.call(PAGE_NAMES, path) ? PAGE_NAMES[path] : '';
  if (known) return known;
  const m = String(path || '').match(/^\/product\/([^/]+)$/);
  if (m && products[m[1]]) return products[m[1]];
  return path || '—';
}

/* ------------------------------- Значки -------------------------------------
 * Один глиф на одно понятие, и подбирается он ТЕМ ЖЕ ключом, что и в строке
 * заказа (`lib/client-icons.js`): «Телефон» в метрике и «Телефон» в заявке
 * обязаны выглядеть одинаково, иначе панель читается как два разных раздела.
 * Незнакомая подпись уходит в запасной глиф, а не остаётся дырой в ряду.
 */
const ICON_OF = {
  device: label => CI.icon(CI.deviceKey(label)),
  browser: label => CI.icon(CI.browserKey(label)),
  system: label => CI.icon(CI.osKey(label)),
  source: label => CI.icon(CI.sourceKey(label)),
  page: label => CI.icon(CI.pageKey(label)),
  // У города свой глиф на всех: флага здесь не поставить — в подписи лежит
  // готовая строка «город, регион, страна», а кода страны рядом с ней нет.
  place: () => CI.icon('pin'),
  bot: () => CI.icon('bot')
};

/* --------------------------- Полосы со значками ------------------------------
 * Ряд «глиф · подпись · число · доля». Доля считается от того, что этот список
 * вообще меряет (`of`): у городов, устройств, браузеров, систем и источников это
 * посетители, у популярных страниц — открытия (у списка на это своя подпись).
 * Без `of` процент не показывается вовсе — доля от суммы восьми показанных строк
 * была бы завышенной, а врать в отчёте нельзя.
 */
function bars(items, options) {
  const o = options || {};
  const list = (items || []).map(x => ({ label: String(x.label == null ? '' : x.label), value: Number(x.value) || 0 }));
  if (!list.length) return `<p class="metric-empty">${esc(o.empty || 'Данных пока нет')}</p>`;
  const max = Math.max(1, ...list.map(x => x.value));
  const of = Number(o.of) || 0;
  const iconOf = o.icon ? (ICON_OF[o.icon] || null) : null;
  // Колонку под значок включает класс списка, а не селектор `:has()` у строки:
  // его поддерживают не все версии Safari, доходящие до панели.
  return `<div class="metric-bars${iconOf ? ' has-ico' : ''}${o.className ? ' ' + o.className : ''}">${list.map(x => {
    const share = of ? Math.round((x.value / of) * 1000) / 10 : 0;
    const label = o.labelOf ? o.labelOf(x.label) : x.label;
    return `<div class="metric-bar-row">
    <div class="metric-bar-label">${iconOf ? `<span class="metric-bar-ico">${iconOf(x.label)}</span>` : ''}<span class="metric-bar-name" title="${esc(label)}">${esc(label)}</span><b>${n(x.value)}</b>${of ? `<em>${esc(pct(share))}</em>` : ''}</div>
    <div class="metric-bar-track"><i style="width:${Math.max(3, Math.round((x.value / max) * 100))}%"></i></div>
  </div>`;
  }).join('')}</div>`;
}

/* --------------------------- График: линия и точки ---------------------------
 *
 * Столбцы отвечали на вопрос «сколько было в этот день», а у посещаемости
 * вопрос другой — «куда всё идёт»: направление читается линией, а точное
 * значение возвращает точка на каждом дне (и подпись при наведении).
 *
 * Устройство: линию и заливку рисует SVG, растянутый по ширине панели
 * (`preserveAspectRatio="none"`), а точки и подписи — обычная разметка,
 * расставленная процентами. Это не украшательство, а единственный способ
 * сохранить и пропорции, и читаемость: у пропорционального SVG подписи на
 * телефоне ужимаются до 5–6 px, а у растянутого — точки превращаются в овалы.
 * Штрих держит `vector-effect="non-scaling-stroke"`: линия остаётся одной
 * толщины на любой ширине, как и весь волосяной штрих панели.
 *
 * Ни строчки скрипта: панель обновляется подменой серверной разметки
 * (`public/admin-live.js`), и второй расчёт в браузере разъехался бы с этим.
 */
function niceMax(value) {
  const v = Math.max(1, Number(value) || 0);
  const pow = Math.pow(10, Math.floor(Math.log10(v)));
  for (const step of [1, 1.5, 2, 2.5, 3, 4, 5, 7.5, 10]) if (v <= step * pow) return step * pow;
  return 10 * pow;
}

/* Гладкая линия — МОНОТОННАЯ кубика, а не «просто сгладить».
 *
 * Ломаная из отрезков читается как чертёж, а посещаемость — это течение, и
 * глазу нужна кривая. Но обычное сглаживание (Catmull-Rom, `curveBasis` и
 * прочие) на резком всплеске выносит кривую ЗА крайние точки: у ряда «ноль весь
 * день и всплеск к вечеру» линия ныряет ниже нуля перед подъёмом и вылетает за
 * потолок оси после него. На графике посещаемости отрицательный провал — это не
 * стилистическая мелочь, а нарисованное число, которого не было.
 *
 * Монотонная кубика Фрица — Карлсона этого не допускает по построению: наклон в
 * точке зажимается тремя длинами соседних наклонов, а на смене знака (локальный
 * максимум или минимум) обнуляется. Между двумя точками кривая не выходит за их
 * значения, поэтому ноль остаётся нулём, а пик — ровно пиком.
 */
function smoothPath(pts) {
  const n = pts.length;
  if (n < 2) return n ? `M${pts[0].x.toFixed(2)},${pts[0].y.toFixed(2)}` : '';
  // Наклоны отрезков и наклоны в самих точках.
  const dx = []; const slope = [];
  for (let i = 0; i < n - 1; i++) {
    dx.push(pts[i + 1].x - pts[i].x);
    slope.push(dx[i] ? (pts[i + 1].y - pts[i].y) / dx[i] : 0);
  }
  const m = new Array(n);
  m[0] = slope[0];
  m[n - 1] = slope[n - 2];
  for (let i = 1; i < n - 1; i++) {
    // Смена знака — точка перегиба ряда: наклон здесь ноль, иначе кривая
    // «перелетит» через локальный максимум и нарисует значение выше пика.
    m[i] = slope[i - 1] * slope[i] <= 0 ? 0 : (slope[i - 1] + slope[i]) / 2;
  }
  for (let i = 0; i < n - 1; i++) {
    if (!slope[i]) { m[i] = 0; m[i + 1] = 0; continue; }
    const a = m[i] / slope[i]; const b = m[i + 1] / slope[i];
    const h = Math.hypot(a, b);
    if (h > 3) { m[i] = (3 / h) * a * slope[i]; m[i + 1] = (3 / h) * b * slope[i]; }
  }
  let d = `M${pts[0].x.toFixed(2)},${pts[0].y.toFixed(2)}`;
  for (let i = 0; i < n - 1; i++) {
    const t = dx[i] / 3;
    d += ` C${(pts[i].x + t).toFixed(2)},${(pts[i].y + m[i] * t).toFixed(2)}`
      + ` ${(pts[i + 1].x - t).toFixed(2)},${(pts[i + 1].y - m[i + 1] * t).toFixed(2)}`
      + ` ${pts[i + 1].x.toFixed(2)},${pts[i + 1].y.toFixed(2)}`;
  }
  return d;
}
function lineChart(points, options) {
  const o = options || {};
  const list = (points || []).map(p => ({ label: String(p.label == null ? '' : p.label), value: Number(p.value) || 0, note: String(p.note || '') }));
  const values = list.map(p => p.value);
  // Пустой ряд И ряд из одних нулей — одно и то же: рисовать линию по нулевой
  // оси незачем, она читается как поломка, а не как «посещений ещё не было».
  if (!list.length || !values.some(v => v > 0)) return `<p class="metric-empty">${esc(o.empty || 'График появится после первых посещений')}</p>`;
  const max = niceMax(Math.max(...values));
  const last = list.length - 1;
  // Одна точка — линию строить не из чего, поэтому она встаёт по центру.
  const x = i => (list.length === 1 ? 50 : (i / last) * 100);
  const y = v => 100 - (v / max) * 100;
  const pts = list.map((p, i) => ({ x: x(i), y: y(p.value) }));
  const line = smoothPath(pts);
  const area = `${line} L${x(last).toFixed(2)},100 L${x(0).toFixed(2)},100 Z`;
  // Подписи по оси X: все, пока их немного, дальше — каждая k-я. Плюс последняя
  // всегда: она про «сейчас», и её отсутствие читается как обрыв графика.
  const step = Math.max(1, Math.ceil(list.length / (Number(o.labels) || 8)));
  const peak = values.indexOf(Math.max(...values));
  const total = values.reduce((s, v) => s + v, 0);
  /* Подсказка — СВОЙ узел, а не атрибут `title`.
   *
   * Родную подсказку браузер показывает через секунду с лишним удержания и в
   * своём месте у курсора: чтобы прочитать три значения подряд, приходится
   * замирать над каждой точкой. Свой узел показывается по `:hover` мгновенно и
   * встаёт ровно над точкой. Показывает его CSS, поэтому скрипта на графике
   * по-прежнему нет ни строчки (панель перерисовывается подменой серверной
   * разметки, и второй расчёт в браузере разъехался бы с ней).
   *
   * У крайних точек подсказка прижимается к своему краю (`at-start`/`at-end`):
   * по центру она уезжала бы за границу панели, и половина текста обрезалась бы.
   *
   * Фокуса точкам НЕ даём: весь график — это `role="img"`, и содержимое внутри
   * него читающему с экрана всё равно не достаётся, а два десятка остановок
   * табуляции посреди страницы он бы получил. Значение для него несёт подпись
   * самого графика — ровно как было с прежним `title`.
   */
  const near = Math.max(1, Math.round(list.length / 12));
  const dots = list.map((p, i) => {
    const edge = i <= near ? ' at-start' : (i >= last - near ? ' at-end' : '');
    return `<span class="mc-dot${i === last ? ' is-now' : ''}" style="left:${x(i).toFixed(2)}%;top:${y(p.value).toFixed(2)}%"><i></i><b class="mc-tip${edge}">${esc(p.note || (p.label + ': ' + n(p.value)))}</b></span>`;
  }).join('');
  const marks = list.map((p, i) => (i % step === 0 || i === last)
    ? `<span class="mc-x" style="left:${x(i).toFixed(2)}%">${esc(p.label)}</span>` : '').join('');
  return `<div class="metric-chart" role="img" aria-label="${esc(o.aria || 'График посещаемости')}">
    <div class="mc-axis"><span>${n(max)}</span><span>${n(Math.round(max * 0.75))}</span><span>${n(Math.round(max / 2))}</span><span>${n(Math.round(max / 4))}</span><span>0</span></div>
    <div class="mc-plot">
      <svg class="mc-svg" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true" focusable="false">
        <defs><linearGradient id="mc-fill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stop-color="var(--accent)" stop-opacity=".24"/>
          <stop offset=".55" stop-color="var(--accent)" stop-opacity=".07"/>
          <stop offset="1" stop-color="var(--accent)" stop-opacity="0"/>
        </linearGradient></defs>
        <path class="mc-area" d="${area}" fill="url(#mc-fill)"/>
        <path class="mc-line" d="${line}" fill="none" stroke="var(--accent)" stroke-width="2.2" stroke-linejoin="round" stroke-linecap="round" vector-effect="non-scaling-stroke"/>
      </svg>
      ${dots}
      ${total && list.length > 2 ? `<span class="mc-peak" style="left:${x(peak).toFixed(2)}%;top:${y(values[peak]).toFixed(2)}%">${n(values[peak])}</span>` : ''}
    </div>
    <div class="mc-marks">${marks}</div>
  </div>`;
}

/* Сравнение с прошлым таким же периодом. Одно число («42 посетителя») не
 * отвечает на главный вопрос владельца — стало лучше или хуже, — а стрелка
 * отвечает. Сравнивать не с чем (в прошлом периоде пусто) — значка нет вовсе:
 * «+100%» от нуля ничего не значит. */
function trend(now, before, options) {
  const o = options || {};
  const a = Number(now) || 0; const b = Number(before) || 0;
  if (!b || a === b) return '';
  const diff = Math.round(((a - b) / b) * 100);
  if (!diff) return '';
  const up = diff > 0;
  return `<span class="metric-trend ${up ? 'is-up' : 'is-down'}" title="${esc((o.title || 'к прошлому периоду'))}">${up ? '↑' : '↓'} ${Math.abs(diff)}%</span>`;
}

// Плитка сводки: значок, подпись, число и строка пояснения под ним.
function statCard(item) {
  return `<article class="metric-card${item.live ? ' metric-live' : ''}${item.idle ? ' is-idle' : ''}">
    <span>${item.icon ? `<i class="metric-card-ico">${CI.icon(item.icon)}</i>` : ''}${esc(item.label)}</span>
    <strong>${item.live ? '<i></i>' : ''}${item.value}${item.trend || ''}</strong>
    <small>${item.note || ''}</small>
  </article>`;
}

/* --------------------------- Строка посетителя -------------------------------
 * Одна разметка на предпросмотр в «Метрике» и на страницу «Кто заходил»: две
 * копии разъехались бы на первой правке, а смотрят на них одни и те же глаза.
 * Ячейки названы, потому что на телефоне строка становится карточкой и
 * раскладку задаёт сетка: безымянные <td> ей не адресовать.
 */
function visitorRow(v, options) {
  const o = options || {};
  const now = Number(o.now) || Date.now();
  const online = now - Number(v.lastSeen) <= ONLINE_MS;
  const products = o.products || {};
  const href = o.visitorBase ? esc(o.visitorBase + encodeURIComponent(v.id)) : '';
  const open = (inner, cls) => href ? `<a class="metric-open${cls ? ' ' + cls : ''}" href="${href}">${inner}</a>` : inner;
  return `<tr>
      <td class="mv-when">${open(`<div class="metric-visitor"><span class="metric-status${online ? ' online' : ''}"></span><div><b>${online ? 'Сейчас на сайте' : ago(v.lastSeen, now)}</b><small>${esc(String(v.id || '').slice(0, 8))}</small></div></div>`)}</td>
      <td class="mv-place"><b>${flagMark(v)}${esc(location(v))}</b><small>${open(esc(v.ip || 'IP не определён'), 'metric-ip')}${v.isp ? ' · ' + esc(v.isp) : ''}</small></td>
      <td class="mv-tech">${deviceMarks(v) || `<b>${esc(device(v))}</b>`}<small>${esc(technical(v) || v.platform || 'Технические данные не переданы')}</small><small class="mv-source">${ICON_OF.source(v.source)}${esc(v.source || 'Прямой заход')}${v.utmCampaign ? ' · UTM: ' + esc(v.utmCampaign) : ''}</small></td>
      <td class="mv-page"><b>${esc(pageLabel(v.lastPage, products))}</b><small>Вход: ${esc(pageLabel(v.entryPage, products))}</small><small>${n(v.visits)} ${plural(v.visits, 'заход', 'захода', 'заходов')} · ${n(v.pageViews)} ${plural(v.pageViews, 'страница', 'страницы', 'страниц')} · ${duration(v.activeSeconds)}</small></td>
      <td class="mv-order">${v.orderCount ? `<a class="metric-order" href="${esc(o.ordersHref || '#')}${v.lastOrderId ? '#order-' + esc(v.lastOrderId) : ''}">${v.lastOrderNumber ? esc(v.lastOrderNumber) : n(v.orderCount) + ' ' + plural(v.orderCount, 'заказ', 'заказа', 'заказов')}</a>` : '<span class="metric-no-order">—</span>'}</td>
    </tr>`;
}

function visitorsTable(rows, options) {
  const o = options || {};
  const body = (rows || []).map(v => visitorRow(v, o)).join('')
    || `<tr><td colspan="5" class="metric-empty">${esc(o.empty || 'После первых посещений данные появятся здесь.')}</td></tr>`;
  return `<div class="metric-table-wrap"><table class="a-table metric-table"><thead><tr><th>Активность</th><th>Город и IP</th><th>Устройство и источник</th><th>Страница</th><th>Заявка</th></tr></thead><tbody>${body}</tbody></table></div>`;
}

/* Боты и технические запросы — под раскрытием.
 *
 * Блок отвечает на вопрос, который задают раз в месяц («нас вообще сканируют?»),
 * а занимал он полтора экрана прямо посреди отчёта — между списками и списком
 * посетителей. Свёрнутая строка при этом сама называет числа, поэтому раскрывать
 * её ради ответа не нужно: внутри только разбивка по типам запросов и адресам.
 *
 * Разметка — та же `<details class="set">`, что у разделов настроек: правило
 * «редкое прячем под раскрытие» в панели одно, и второй свой вид у него быть не
 * должен. Ни строчки скрипта, работает и там, где скрипты панели не загрузились.
 * Требовать `settingsSection()` из `lib/admin-views.js` нельзя — он сам
 * подключает этот модуль, и `require` замкнулся бы в кольцо.
 */
function botsFold(bots) {
  const hits = Number(bots.hits) || 0;
  const notFound = Number(bots.notFound) || 0;
  const note = hits
    ? `${n(hits)} ${plural(hits, 'запрос', 'запроса', 'запросов')} · ${n(notFound)} ${plural(notFound, 'ошибка', 'ошибки', 'ошибок')} 404 · на метрику не влияют`
    : 'за этот период не приходили';
  return `<details class="set metric-bots">
    <summary>
      <span class="set-ico">${CI.icon('bot')}</span>
      <span class="set-cap"><h3>Боты и технические запросы</h3><span class="set-note">${esc(note)}</span></span>
      <svg class="set-chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="m9.5 5.5 7 6.5-7 6.5"/></svg>
    </summary>
    <div class="set-body">
      <div class="metric-bot-grid"><div><h4>Типы запросов</h4>${bars(bots.agents || [], { icon: 'bot' })}</div><div><h4>Какие адреса проверяли</h4>${bars(bots.paths || [])}</div></div>
    </div>
  </details>`;
}

function dashboard(snapshot, options) {
  options = options || {};
  const products = options.products || {};
  const s = snapshot || {};
  const days = Number(s.days) || 1;
  const prev = s.prev || {};
  const was = days === 1 ? 'вчера' : 'прошлые ' + days + ' ' + plural(days, 'день', 'дня', 'дней');

  /* Отчёт «Сегодня» строится по ЧАСАМ, остальные — по дням. По дням «сегодня»
   * было бы одной точкой: линии не из чего строить, а вопрос «как идёт день»
   * остался бы без ответа. Часы приходят из суточной сводки — у дней, записанных
   * до появления этого поля, их нет, и график честно падает на дневной ряд. */
  const byHour = days === 1 && s.hasHours;
  const people = value => n(value) + ' ' + plural(value, 'посетитель', 'посетителя', 'посетителей');
  const chart = byHour
    ? lineChart((s.hourly || []).map(h => ({
      label: String(h.hour).padStart(2, '0'),
      value: h.visitors,
      note: String(h.hour).padStart(2, '0') + ':00 — ' + people(h.visitors)
    })), { labels: 8, aria: 'Посетители по часам сегодня' })
    : lineChart((s.daily || []).map(d => ({
      label: dayLabel(d.date),
      value: d.visitors,
      note: dayLabel(d.date, { month: 'long' }) + ' — ' + people(d.visitors)
    })), { labels: days > 14 ? 7 : 10, aria: 'Посетители по дням', empty: days === 1 ? 'Сегодня заходов ещё не было' : 'График появится после первых посещений' });

  const prevAverage = prev.visits ? Math.round(prev.activeSeconds / prev.visits) : 0;
  const cards = [
    {
      // Никого на сайте — точка гаснет и перестаёт дышать: зелёный пульс рядом
      // с нулём обещал бы движение, которого нет.
      live: true, idle: !Number(s.online), icon: 'activity', label: 'Онлайн сейчас', value: n(s.online),
      note: 'за последние 2 минуты'
    },
    {
      /* Главное число отчёта — УНИКАЛЬНЫЕ люди, а не заходы.
       *
       * Рядом стояла плитка «Просмотры», и три числа об одном и том же
       * (просмотры, визиты, посетители) читались как три разных ответа на
       * вопрос «сколько было народу»: у одного человека десяток просмотров, и
       * самое крупное число на странице означало меньше всех. Просмотры сняты
       * отовсюду, кроме карточки одного посетителя, где это его собственные
       * открытые страницы и спутать их не с чем. */
      icon: 'users', label: 'Посетители', value: n(s.unique),
      trend: trend(s.unique, prev.visitors, { title: 'к ' + was }),
      note: `возвращаются ${pct(s.returnRate)} · ${was}: ${n(prev.visitors)}`
    },
    {
      icon: 'clock', label: 'Среднее время', value: durationShort(s.averageSeconds),
      trend: trend(s.averageSeconds, prevAverage, { title: 'к ' + was }),
      note: `${duration(s.activeSeconds)} вовлечённого времени`
    },
    {
      icon: 'bag', label: 'Заявки', value: n(s.orders),
      trend: trend(s.orders, prev.orders, { title: 'к ' + was }),
      note: `конверсия ${pct(s.conversion)} · ${was}: ${n(prev.orders)}`
    }
  ].map(statCard).join('');

  const ranges = [1, 7, 30].map(d => `<a href="${esc(options.rangeBase || '')}${d}" class="metric-range${days === d ? ' active' : ''}">${d === 1 ? 'Сегодня' : d + ' дней'}</a>`).join('');
  const visitorsHref = esc(options.visitorsHref || '#');

  /* Кнопки «Обновить» и подписи «Обновлено 16:36» здесь больше нет.
   *
   * Обе появились от одного и того же: страница отдавалась один раз, а метрика
   * менялась каждую секунду, и узнать, что на витрине происходит СЕЙЧАС, можно
   * было только перезагрузкой. Теперь страница обновляется сама
   * (`public/admin-live.js`), кнопка предлагала бы сделать руками то, что уже
   * сделано, а время последнего обновления перестало что-либо значить: оно
   * всегда «только что». Отметка «живое» стоит в шапке панели.
   */
  return `<div class="metric-toolbar"><div class="metric-ranges">${ranges}</div><a class="metric-more-link" href="${visitorsHref}">${CI.icon('users')}Кто заходил${s.visitorsTotal ? ' · ' + n(s.visitorsTotal) : ''}</a></div>
  <div class="metric-summary">${cards}</div>
  <div class="metric-grid-main">
    <section class="a-panel metric-panel metric-traffic"><div class="metric-panel-head"><div><span class="metric-kicker">Динамика</span><h2>Посещаемость</h2></div><span>${byHour ? 'по часам · сегодня' : 'по дням · ' + people(s.unique)}</span></div>${chart}</section>
    <section class="a-panel metric-panel"><div class="metric-panel-head"><div><span class="metric-kicker">Устройства</span><h2>Типы устройств</h2></div></div>${bars(s.devices, { icon: 'device', of: s.unique, className: 'metric-device-bars' })}</section>
  </div>
  <section class="a-panel metric-panel metric-visitors"><div class="metric-panel-head"><div><span class="metric-kicker">Посетители</span><h2>Кто заходил</h2></div><a class="link" href="${visitorsHref}">Все посетители →</a></div>
    ${visitorsTable(s.visitors || [], { now: s.generatedAt, products, visitorBase: options.visitorBase, ordersHref: options.ordersHref })}
  </section>
  <div class="metric-grid-secondary">
    <section class="a-panel metric-panel"><div class="metric-panel-head"><div><span class="metric-kicker">Контент</span><h2>Популярные страницы</h2></div><span>сколько раз открывали</span></div>${bars(s.pages, { icon: 'page', of: s.pageViews, labelOf: p => pageLabel(p, products) })}</section>
    <section class="a-panel metric-panel"><div class="metric-panel-head"><div><span class="metric-kicker">Источники</span><h2>Откуда приходят</h2></div></div>${bars(s.sources, { icon: 'source', of: s.unique })}</section>
  </div>
  <div class="metric-grid-tertiary">
    <section class="a-panel metric-panel"><div class="metric-panel-head"><div><span class="metric-kicker">География</span><h2>Города</h2></div></div>${bars(s.locations || [], { icon: 'place', of: s.unique, className: 'metric-location-bars' })}</section>
    <section class="a-panel metric-panel"><div class="metric-panel-head"><div><span class="metric-kicker">Технологии</span><h2>Браузеры</h2></div></div>${bars(s.browsers || [], { icon: 'browser', of: s.unique })}</section>
    <section class="a-panel metric-panel"><div class="metric-panel-head"><div><span class="metric-kicker">Технологии</span><h2>Операционные системы</h2></div></div>${bars(s.systems || [], { icon: 'system', of: s.unique })}</section>
  </div>
  ${s.campaigns && s.campaigns.length ? `<section class="a-panel metric-panel metric-campaigns"><div class="metric-panel-head"><div><span class="metric-kicker">Маркетинг</span><h2>UTM-кампании</h2></div></div>${bars(s.campaigns, { icon: 'source' })}</section>` : ''}
  ${botsFold(s.bots || {})}`;
}

/* ============================ Страница «Кто заходил» =========================
 *
 * Отдельная страница, а не блок в отчёте, по трём причинам сразу: здесь свой
 * период (метрика показывает 1/7/30 дней, а посмотреть можно любой отрезок за
 * год), свой отбор по технике и источнику и своя листалка. В отчёте всё это
 * стояло бы ниже графиков, куда никто не доскроллит.
 *
 * Ничего не решает сама: и отбор, и сортировку, и потолок выдачи считает
 * `metrics.queryVisitors()` — здесь только показ. Своя копия правил в
 * представлении разошлась бы с моделью молча.
 */
const SORT_LABELS = [
  ['last', 'Последний заход'],
  ['first', 'Первый заход'],
  ['visits', 'Больше заходов'],
  ['views', 'Больше открытых страниц'],
  ['time', 'Больше времени на сайте'],
  ['orders', 'Сначала с заказом']
];
// Ссылка на ту же страницу с изменённым набором параметров. Пустое значение
// параметр убирает — адрес не обрастает хвостами вроде `device=`.
function href(base, query, patch) {
  const q = Object.assign({}, query || {}, patch || {});
  const parts = Object.keys(q)
    .filter(k => q[k] !== '' && q[k] != null && q[k] !== false)
    .map(k => encodeURIComponent(k) + '=' + encodeURIComponent(String(q[k])));
  return esc(String(base || '') + (parts.length ? '?' + parts.join('&') : ''));
}
// Ряд «фишек» одного отбора: сама подпись, счётчик и крестик у выбранной.
function chips(base, query, field, counts, options) {
  const o = options || {};
  const list = Object.entries(counts || {}).sort((a, b) => b[1] - a[1]).slice(0, o.limit || 8);
  if (!list.length) return '';
  const current = String(query[field] || '');
  return `<div class="mf-chips"><span class="mf-chips-title">${esc(o.title || '')}</span>${list.map(([label, count]) => {
    const active = current === label;
    // Нажатие по выбранной снимает отбор: второй кнопки «сбросить» у каждого
    // ряда быть не должно, а искать общий сброс ради одной фишки — лишний шаг.
    return `<a class="mf-chip${active ? ' active' : ''}" href="${href(base, query, { [field]: active ? '' : label, show: '' })}">${o.icon ? `<i>${(ICON_OF[o.icon] || ICON_OF.source)(label)}</i>` : ''}${esc(label)}<b>${n(count)}</b></a>`;
  }).join('')}</div>`;
}

function visitorsPage(result, options) {
  const o = options || {};
  const base = o.base || '/admin/analytics/visitors';
  const res = result || {};
  const facets = res.facets || {};
  // В адресе живёт ровно то, чем сейчас отобрано: ссылки «показать ещё» и фишки
  // собираются из него же, поэтому ни один отбор при переходе не теряется.
  const query = {
    from: res.from || '', to: res.to || '',
    device: o.device || '', browser: o.browser || '', system: o.system || '',
    source: o.source || '', ordered: o.ordered ? '1' : '', sort: res.sort === 'last' ? '' : res.sort
  };
  const today = o.today || '';
  const dayShift = (back) => {
    const d = new Date(String(today) + 'T00:00:00+03:00');
    if (Number.isNaN(d.getTime())) return '';
    d.setUTCDate(d.getUTCDate() - back);
    return d.toISOString().slice(0, 10);
  };
  const presets = [
    ['Сегодня', { from: today, to: today }],
    ['7 дней', { from: dayShift(6), to: today }],
    ['30 дней', { from: dayShift(29), to: today }],
    ['Всё время', { from: '', to: '' }]
  ].map(([label, patch]) => {
    const active = String(query.from || '') === String(patch.from || '') && String(query.to || '') === String(patch.to || '');
    return `<a class="metric-range${active ? ' active' : ''}" href="${href(base, query, Object.assign({ show: '' }, patch))}">${esc(label)}</a>`;
  }).join('');

  const period = res.from || res.to
    ? (res.from === res.to ? dayLabel(res.from, { month: 'long' }) : `${res.from ? dayLabel(res.from, { month: 'long' }) : 'начало'} — ${res.to ? dayLabel(res.to, { month: 'long' }) : 'сегодня'}`)
    : 'за всё время';

  const filtered = !!(query.device || query.browser || query.system || query.source || query.ordered);
  const sortSelect = `<label class="mf-sort">Сортировка
    <select name="sort">${SORT_LABELS.map(([value, label]) => `<option value="${value}"${res.sort === value ? ' selected' : ''}>${esc(label)}</option>`).join('')}</select></label>`;

  /* Отбор — обычная форма с GET и ссылки-фишки: ни строчки скрипта. Даты
   * уезжают полями, а уже выбранные фишки — скрытыми полями рядом, иначе
   * «Показать» за один нажим стирал бы отбор по технике. */
  const hidden = ['device', 'browser', 'system', 'source', 'ordered']
    .filter(k => query[k]).map(k => `<input type="hidden" name="${k}" value="${esc(query[k])}">`).join('');

  const rows = visitorsTable(res.rows || [], {
    now: res.generatedAt, products: o.products || {}, visitorBase: o.visitorBase, ordersHref: o.ordersHref,
    empty: filtered || res.from || res.to
      ? 'За этот период и с таким отбором никого не нашлось.'
      : 'После первых посещений данные появятся здесь.'
  });

  // «Показать ещё» — обычная ссылка с увеличенным потолком выдачи и якорем к
  // списку: страница возвращается на то же место, а не в начало.
  const more = res.hasMore
    ? `<div class="mf-more"><a class="btn btn-sm" href="${href(base, query, { show: (Number(res.shown) || VISITORS_PER_PAGE) + VISITORS_PER_PAGE })}#visitors">Показать ещё ${VISITORS_PER_PAGE} · осталось ${n(res.found - res.shown)}</a></div>`
    : '';

  return `<div class="metric-toolbar">
    <div class="metric-ranges">${presets}</div>
    <a class="metric-more-link" href="${esc(o.backHref || '/admin/analytics')}">← К отчёту</a>
  </div>
  <section class="a-panel metric-panel metric-filters">
    <form method="get" action="${esc(base)}" class="mf-form">
      ${hidden}
      <label class="mf-date">С<input type="date" name="from" value="${esc(res.from || '')}" max="${esc(today)}"></label>
      <label class="mf-date">По<input type="date" name="to" value="${esc(res.to || '')}" max="${esc(today)}"></label>
      ${sortSelect}
      <button class="btn btn-sm btn-primary" type="submit">Показать</button>
      ${(res.from || res.to || filtered || (res.sort && res.sort !== 'last')) ? `<a class="link mf-reset" href="${esc(base)}">Сбросить всё</a>` : ''}
    </form>
    ${chips(base, query, 'device', facets.devices, { title: 'Устройство', icon: 'device' })}
    ${chips(base, query, 'system', facets.systems, { title: 'Система', icon: 'system' })}
    ${chips(base, query, 'browser', facets.browsers, { title: 'Браузер', icon: 'browser' })}
    ${chips(base, query, 'source', facets.sources, { title: 'Источник', icon: 'source', limit: 10 })}
    <div class="mf-chips"><span class="mf-chips-title">Заявки</span>
      <a class="mf-chip${query.ordered ? ' active' : ''}" href="${href(base, query, { ordered: query.ordered ? '' : '1', show: '' })}"><i>${CI.icon('bag')}</i>Только с заказом<b>${n(facets.orders)}</b></a>
    </div>
  </section>
  <section class="a-panel metric-panel metric-visitors" id="visitors">
    <div class="metric-panel-head">
      <div><span class="metric-kicker">${esc(period)}</span><h2>Кто заходил</h2></div>
      <span>${n(res.found)} ${plural(res.found, 'посетитель', 'посетителя', 'посетителей')}${res.found === res.total ? '' : ' из ' + n(res.total)} · показано ${n(res.shown)}</span>
    </div>
    ${rows}
    ${more}
  </section>`;
}

/* ---------------------------- Карточка посетителя ----------------------------
 * Куда ведут IP и значки из строки заказа: вся история одного посетителя —
 * визиты по датам, какие страницы он открывал и сколько на каждой пробыл,
 * техника, источник перехода и его заказы.
 *
 * Хронология собирается из `visitor.hits` (последние 50 просмотров), поэтому у
 * давнего посетителя видны последние визиты, а счётчики сверху и список «все
 * страницы» — за всё время: они считаются отдельно и потолком не режутся.
 */
function visitorPage(visitor, options) {
  options = options || {};
  const v = visitor || {};
  const products = options.products || {};
  const now = Number(options.now) || Date.now();
  const online = now - Number(v.lastSeen || 0) <= ONLINE_MS;
  const sessions = sessionsOf(v);

  const days = Math.max(1, Math.round((now - Number(v.firstSeen || now)) / 86400000));
  const cards = [
    ['users', 'Заходов', n(v.visits || 0), 'за всё время'],
    /* Здесь «страницы» остались, и это не оговорка: в отчёте просмотры путались
     * с посетителями, а в карточке одного человека спутать их не с чем — это
     * ровно то, сколько страниц открыл он сам. Слово при этом другое: «просмотры»
     * из панели убраны совсем, чтобы к прежней путанице не возвращаться. */
    ['eye', 'Открыл страниц', n(v.pageViews || 0), sessions.length ? 'в хронологии ниже — ' + n(sessions.length) + ' ' + plural(sessions.length, 'заход', 'захода', 'заходов') : ''],
    ['clock', 'Время на сайте', durationShort(v.activeSeconds), v.visits ? 'в среднем ' + durationShort(Math.round((Number(v.activeSeconds) || 0) / Number(v.visits))) + ' за заход' : ''],
    ['activity', 'Первый заход', esc(R.formatDate(v.firstSeen)), 'знаем его ' + n(days) + ' ' + plural(days, 'день', 'дня', 'дней')],
    ['pin', 'Последний заход', online ? 'сейчас' : ago(v.lastSeen, now), esc(dateTime(v.lastSeen))],
    ['bag', 'Заказов', n(v.orderCount || 0), v.lastOrderAt ? 'последний ' + esc(R.formatDate(v.lastOrderAt)) : 'заказов не было']
  ].map(([icon, label, value, note]) => statCard({ icon, label, value, note })).join('');

  const visits = sessions.map((s, i) => {
    // Нумерация от общего счётчика визитов: в хронологии их последние
    // полсотни просмотров, а всего визитов могло быть больше.
    const number = Math.max(1, (Number(v.visits) || sessions.length) - i);
    const steps = s.hits.map(h => `<li>
      <span class="visit-time">${esc(clock(h.t))}</span>
      <span class="visit-page">${ICON_OF.page(h.p)}${esc(pageLabel(h.p, products))}<i>${esc(h.p || '')}</i></span>
      <span class="visit-sec">${h.s ? esc(duration(h.s)) : '—'}</span></li>`).join('');
    return `<div class="visit">
      <div class="visit-head"><b>Заход №${number}</b><span>${esc(dateTime(s.startAt))} · ${esc(duration(s.seconds))} · ${n(s.hits.length)} ${plural(s.hits.length, 'страница', 'страницы', 'страниц')}</span></div>
      <ol class="visit-steps">${steps}</ol></div>`;
  }).join('') || '<p class="metric-empty">Хронология появится после первого подтверждённого просмотра страницы.</p>';

  const pathRows = Object.entries(v.pathCounts || {}).sort((a, b) => b[1] - a[1]).slice(0, 12)
    .map(([p, count]) => ({ label: p, value: count }));

  const facts = [
    ['IP-адрес', v.ip || 'не определён'],
    ['Провайдер', v.isp],
    ['Город', location(v)],
    ['Устройство', device(v)],
    ['Источник перехода', v.source || 'Прямой заход'],
    ['UTM-метка', [v.utmSource, v.utmMedium, v.utmCampaign].filter(Boolean).join(' · ')],
    ['Экран и окно', [v.screen, v.viewport].filter(Boolean).join(' · ')],
    ['Язык и часовой пояс', [v.language, v.timezone].filter(Boolean).join(' · ')],
    ['Платформа', v.platform],
    ['Память и ядра', [v.deviceMemory ? v.deviceMemory + ' ГБ' : '', v.cpuCores ? v.cpuCores + ' ядер' : ''].filter(Boolean).join(' · ')],
    ['Связь', v.connection],
    ['Первый заход', dateTime(v.firstSeen)],
    ['Идентификатор', v.id],
    ['User-Agent', v.userAgent]
  ].filter(([, value]) => value).map(([label, value]) => `<div class="vfact"><span>${esc(label)}</span><b>${esc(value)}</b></div>`).join('');

  const orders = (options.orders || []).map(o => `<li>
    <a href="${esc(options.ordersHref || '#')}#order-${esc(o.id)}"><b>${esc(R.orderNo(o.number))}</b></a>
    <span>${esc(R.formatDate(o.createdAt))} · ${R.money(o.total, options.moneySettings || { currency: '₽' })}</span></li>`).join('');

  const alsoOnIp = (options.alsoOnIp || []).map(other => `<li>
    <a href="${esc((options.visitorBase || '') + encodeURIComponent(other.id))}">${esc(String(other.id).slice(0, 8))}</a>
    <span>${esc(device(other))} · ${n(other.visits)} ${plural(other.visits, 'заход', 'захода', 'заходов')} · ${esc(ago(other.lastSeen, now))}</span></li>`).join('');

  return `<div class="metric-toolbar"><a class="metric-range" href="${esc(options.backHref || '#')}">← Ко всей метрике</a><div class="metric-updated">Карточка посетителя</div></div>
  <section class="a-panel metric-panel visitor-head">
    <div class="visitor-title">
      <span class="metric-status${online ? ' online' : ''}"></span>
      <h2>${flagMark(v)}${esc(location(v))}</h2>
      <span class="visitor-when">${online ? 'сейчас на сайте' : esc(ago(v.lastSeen, now))}</span>
    </div>
    <div class="visitor-ip">${esc(v.ip || 'IP не определён')}${v.isp ? ' · ' + esc(v.isp) : ''}</div>
    ${deviceMarks(v)}
    ${options.chatHref ? `<a class="btn btn-sm visitor-write" href="${esc(options.chatHref)}">${esc(options.chatLabel || 'Написать в чат')}</a>` : ''}
  </section>
  <div class="metric-summary visitor-summary">${cards}</div>
  ${orders ? `<section class="a-panel metric-panel"><div class="metric-panel-head"><div><span class="metric-kicker">Покупки</span><h2>Заказы этого посетителя</h2></div></div><ul class="visitor-orders">${orders}</ul></section>` : ''}
  <section class="a-panel metric-panel visitor-visits">
    <div class="metric-panel-head"><div><span class="metric-kicker">Хронология</span><h2>Как он ходил по сайту</h2></div><span>последние ${n(sessions.length)} ${plural(sessions.length, 'заход', 'захода', 'заходов')}</span></div>
    ${visits}
  </section>
  <div class="metric-grid-secondary">
    <section class="a-panel metric-panel"><div class="metric-panel-head"><div><span class="metric-kicker">За всё время</span><h2>Какие страницы открывал</h2></div></div>${bars(pathRows, { icon: 'page', of: v.pageViews, labelOf: p => pageLabel(p, products) })}</section>
    <section class="a-panel metric-panel"><div class="metric-panel-head"><div><span class="metric-kicker">Техника</span><h2>Устройство и заход</h2></div></div><div class="vfacts">${facts}</div></section>
  </div>
  ${alsoOnIp ? `<section class="a-panel metric-panel"><div class="metric-panel-head"><div><span class="metric-kicker">Тот же адрес</span><h2>Другие посетители с этого IP</h2></div></div><ul class="visitor-orders visitor-others">${alsoOnIp}</ul></section>` : ''}`;
}

// Посетитель не нашёлся: карточку могло вытеснить сроком хранения (365 дней) или
// потолком в 10 000 записей, а у заявки до появления метрики его и не было.
function visitorMissing(key, options) {
  options = options || {};
  return `<div class="metric-toolbar"><a class="metric-range" href="${esc(options.backHref || '#')}">← Ко всей метрике</a></div>
  <section class="a-panel metric-panel"><div class="metric-panel-head"><div><span class="metric-kicker">Карточка посетителя</span><h2>История не найдена</h2></div></div>
  <p class="metric-empty">По ключу <b>${esc(key)}</b> в метрике ничего нет. Карточку могло вытеснить сроком хранения, посетитель мог отказаться от метрики, а у заявок, оформленных до её появления, истории нет вовсе.</p></section>`;
}

// `smoothPath` наружу — ради теста: «кривая не выходит за значения точек» это
// свойство, которое глазами на графике замечаешь не сразу, а нарисованный
// отрицательный провал — это число, которого не было.
module.exports = { dashboard, visitorsPage, visitorPage, visitorMissing, pageLabel, ago, smoothPath };
