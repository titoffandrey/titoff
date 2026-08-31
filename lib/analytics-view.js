'use strict';

const R = require('./render');
const CI = require('./client-icons');
const { ONLINE_MS, VISITORS_PER_PAGE, sessionsOf } = require('./analytics');
// Геометрия карт и сведение названий: мир, регионы стран и их имена — всё
// оттуда, здесь только раскраска и раскладка.
const GEO = require('./geo-maps');
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
// YYYY-MM-DD из адреса формы -> тот же вид, что у полей Google Trends.
// Невалидное и пустое значение становится не выдуманной датой, а явным
// плейсхолдером: его отдельно красит `.is-placeholder`, поэтому подсказка не
// выглядит уже выбранным периодом.
function inputDayLabel(date) {
  const match = String(date || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return match ? `${match[3]}.${match[2]}.${match[1]}` : 'ДД.ММ.ГГГГ';
}
/* Подпись оси у ГОДОВОГО графика — месяц, а не дата.
 *
 * У Trends по оси года стоят «октябрь · 2026 · апрель · июль», и это не
 * оформление: пятьдесят две недели, подписанные датами вида «28 окт.», глаз
 * читает как перечень, а не как шкалу времени. Январь подписывается ГОДОМ —
 * так же, как у них: смена года на годовом графике важнее названия месяца. */
function monthLabel(date) {
  const d = new Date(String(date) + 'T00:00:00+03:00');
  if (Number.isNaN(d.getTime())) return String(date || '');
  return d.getMonth() === 0 ? String(d.getFullYear()) : d.toLocaleDateString('ru-RU', { month: 'long' });
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
 * значение возвращает подсказка при наведении.
 *
 * Устройство: линию рисует SVG, растянутый по ширине панели
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

/* Потолок оси обязан ДЕЛИТЬСЯ НА ПЯТЬ, потому что делений на оси пять, а
 * подписей шесть — 0, 20, 40, 60, 80 и 100% высоты поля. Столько же их у
 * Trends: их ось всегда «0 20 40 60 80 100», просто у них величина
 * нормированная, а у нас живые люди.
 *
 * Заодно это лечит дробные подписи. Пока потолок брался из ряда 1/1,5/2/2,5/…,
 * подпись линии выходила «37,5 посетителя» — дробных людей не бывает, а
 * округлить подпись, оставив линию на месте, значило бы подписать её чужим
 * числом. Поэтому подбирается КРУГЛЫЙ ЦЕЛЫЙ ШАГ, а потолок — пять шагов. */
function niceStep(value) {
  const v = Math.max(1, Number(value) || 0);
  if (v <= 1) return 1;
  const pow = Math.pow(10, Math.floor(Math.log10(v)));
  for (const step of [1, 1.5, 2, 2.5, 3, 3.5, 4, 5, 6, 7.5, 10]) {
    const candidate = Math.round(step * pow);
    if (candidate >= v) return candidate;
  }
  return Math.ceil(v);
}
const AXIS_STEPS = 5;
function niceMax(value) { return niceStep(Math.max(1, Number(value) || 0) / AXIS_STEPS) * AXIS_STEPS; }

/* Линия СГЛАЖЕННАЯ, и это не вкусовщина, а то, что правда рисует Trends: их
 * график построен монотонной кубикой (у Google Charts это `curveType:'function'`
 * — та же кубика Фрица — Карлсона). Здесь она однажды была заменена на ломаную
 * «ради сходства с оригиналом» — сходство от этого как раз и пропало.
 *
 * Монотонная, а не «просто сглаженная»: обычное сглаживание (Catmull-Rom,
 * `curveBasis` и прочие) на резком всплеске выносит кривую ЗА крайние точки. У
 * ряда «ноль весь день и всплеск к вечеру» линия ныряет ниже нуля перед
 * подъёмом и вылетает за потолок оси после него, а отрицательный провал на
 * графике посещаемости — это нарисованное число, которого не было. Кубика
 * Фрица — Карлсона такого не допускает по построению: наклон в точке зажимается
 * тремя длинами соседних наклонов, а на смене знака (локальный максимум или
 * минимум) обнуляется. Между двумя точками кривая не выходит за их значения,
 * поэтому ноль остаётся нулём, а пик — ровно пиком.
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
  // Подписи по оси X: все, пока их немного, дальше — каждая k-я. Плюс последняя
  // всегда: она про «сейчас», и её отсутствие читается как обрыв графика.
  const step = Math.max(1, Math.ceil(list.length / (Number(o.labels) || 8)));
  /* Наведение работает по ВЕРТИКАЛЬНОЙ полосе вокруг каждой точки, как в
   * Trends: не надо ловить мышью четырёхпиксельный кружок. Полоса показывает
   * маркер, направляющую и двухстрочную карточку со значением. Всё остаётся на
   * CSS и переживает живую подмену отчёта без повторной инициализации. */
  const hits = list.map((p, i) => {
    const before = i ? (x(i - 1) + x(i)) / 2 : 0;
    const after = i < last ? (x(i) + x(i + 1)) / 2 : 100;
    const local = ((x(i) - before) / Math.max(.001, after - before)) * 100;
    const edge = i <= 1 ? ' at-start' : (i >= last - 1 ? ' at-end' : '');
    return `<span class="mc-hit" style="left:${before.toFixed(2)}%;width:${(after - before).toFixed(2)}%">
      <i class="mc-guide" style="left:${local.toFixed(2)}%"></i>
      <i class="mc-dot" style="left:${local.toFixed(2)}%;top:${y(p.value).toFixed(2)}%"></i>
      <span class="mc-tip${edge}" style="left:${local.toFixed(2)}%;top:${y(p.value).toFixed(2)}%"><b>${esc(p.note || p.label)}</b><span><i></i><em>Посетители</em><strong>${n(p.value)}</strong></span></span>
    </span>`;
  }).join('');
  /* Соседняя подпись, повторяющая предыдущую, не рисуется: у годового графика
   * подпись — это месяц, и две отметки, попавшие в один месяц, дали бы
   * «август · август» — читается как сбой, а не как шкала. */
  let shown = '';
  const marks = list.map((p, i) => {
    if (i % step !== 0 && i !== last) return '';
    if (p.label === shown) return '';
    shown = p.label;
    /* Крайние подписи прижимаются к своему краю, а не встают по центру точки:
     * на телефоне у последней половина текста уезжала за границу панели, и
     * «31 авг.» читалось как «31 авг». */
    const edge = i === 0 ? ' at-start' : (i === last ? ' at-end' : '');
    return `<span class="mc-x${edge}" style="left:${x(i).toFixed(2)}%">${esc(p.label)}</span>`;
  }).join('');
  /* Подписанный пик — ЕДИНСТВЕННОЕ число графика на сенсорном экране (показывает
   * его CSS, см. `.mc-peak`). Наведения там нет, а вместе с ним нет и подсказки:
   * телефон получал голую линию, по которой не сказать даже, до скольких она
   * доходила. Сначала на её месте пробовались точки у каждого замера, но на
   * ровном ряду (а посещаемость почти всегда ровная) три десятка кружков на
   * трёхстах пикселях превращают линию в пунктир. Пик отвечает на тот же вопрос
   * одним числом и ничего не портит. */
  const peak = values.indexOf(Math.max(...values));
  const peakMark = list.length > 2
    ? `<span class="mc-peak" style="left:${x(peak).toFixed(2)}%;top:${y(values[peak]).toFixed(2)}%">${n(values[peak])}</span>`
    : '';
  // Подписи оси — сверху вниз, ровно по числу линий сетки. Считаются шагом, а не
  // долями потолка: доля дала бы дробь у любого потолка, не кратного знаменателю.
  const axis = [];
  for (let i = AXIS_STEPS; i >= 0; i--) axis.push((max / AXIS_STEPS) * i);
  return `<div class="metric-chart" role="img" aria-label="${esc(o.aria || 'График посещаемости')}">
    <div class="mc-axis">${axis.map(v => `<span>${n(v)}</span>`).join('')}</div>
    <div class="mc-plot">
      <svg class="mc-svg" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true" focusable="false">
        <path class="mc-line" d="${line}" fill="none" stroke="#4285f4" stroke-width="2.8" stroke-linejoin="round" stroke-linecap="round" vector-effect="non-scaling-stroke"/>
      </svg>
      ${peakMark}
      ${hits}
    </div>
    <div class="mc-marks">${marks}</div>
    <div class="mc-legend"><i></i>Посетители</div>
  </div>`;
}

/* ======================= Карта посетителей: мир и страны =====================
 *
 * Раскладка, цвета и поведение сняты с географического блока Google Trends: та
 * же карта-хороплет слева, тот же рейтинг страницами по пять справа, тот же
 * выбор местоположения кнопкой в шапке блока. Правя карту, сверяйся с их живой
 * страницей, а не с памятью — на этом здесь уже наступали.
 *
 * ЧТО ПОКАЗЫВАЕТСЯ, РЕШАЕТ ВЫБРАННОЕ МЕСТО, и это главное правило блока:
 *   «Весь мир» — страны мира, и клик по стране проваливается внутрь неё;
 *   страна, у которой есть карта регионов, — её области;
 *   страна без карты регионов (или без единого определившегося региона) — она
 *     сама, приближением на мировой карте, а рейтинг тогда по городам.
 * Третий случай — не заглушка: у половины мира областей в свободных данных нет
 * вовсе, а «пусто» на месте карты читалось бы как поломка отчёта.
 *
 * Контуры уезжают ИНЛАЙНОМ в страницу, как спрайт карточек каталога и логотипы
 * перевозчиков. Сперва карта России лежала отдельным `public/russia-regions.svg`,
 * а страница ссылалась на него через `<use href="/static/…svg#id">` — красиво по
 * трафику и мертво по делу: ссылку на ВНЕШНИЙ документ WebKit не поддерживает
 * (баг 12499 у них с 2006 года), то есть в Safari и в панели на айфоне карта
 * оставалась бы пустым местом без единой ошибки в консоли.
 *
 * Цена инлайна — от 53 КБ (мир) до 65 КБ (Россия) разметки, и она платится
 * осознанно: геометрия пересобрана под ту точность, которая ВИДНА (см.
 * scripts/build-geo-maps.js). На страницу при этом уезжает РОВНО ОДНА карта —
 * та, которую открыли.
 */
const REGION_MAP_ALIASES = {
  'Республика Адыгея': 'Адыгея',
  'Республика Алтай': 'Алтай',
  'Республика Башкортостан': 'Башкортостан',
  'Республика Бурятия': 'Бурятия',
  'Республика Дагестан': 'Дагестан',
  'Республика Ингушетия': 'Ингушетия',
  'Республика Марий Эл': 'Марий Эл',
  'Республика Татарстан': 'Татарстан',
  'Республика Тыва': 'Тыва',
  'Удмуртия': 'Удмуртская республика',
  'Удмуртская Республика': 'Удмуртская республика',
  'Мордовия': 'Республика Мордовия',
  'Коми': 'Республика Коми',
  'Карелия': 'Республика Карелия',
  'Калмыкия': 'Республика Калмыкия',
  'Хакасия': 'Республика Хакасия',
  'Якутия': 'Республика Саха (Якутия)',
  'Кабардино-Балкария': 'Кабардино-Балкарская республика',
  'Кабардино-Балкарская Республика': 'Кабардино-Балкарская республика',
  'Карачаево-Черкесия': 'Карачаево-Черкесская республика',
  'Карачаево-Черкесская Республика': 'Карачаево-Черкесская республика',
  'Северная Осетия': 'Северная Осетия - Алания',
  'Республика Северная Осетия — Алания': 'Северная Осетия - Алания',
  'Республика Северная Осетия - Алания': 'Северная Осетия - Алания',
  'Чечня': 'Чеченская республика',
  'Чеченская Республика': 'Чеченская республика',
  'Чувашская Республика': 'Чувашия',
  'Кемеровская область — Кузбасс': 'Кемеровская область',
  'Кемеровская область - Кузбасс': 'Кемеровская область',
  'Ханты-Мансийский АО': 'Ханты-Мансийский автономный округ - Югра',
  'Ханты-Мансийский автономный округ — Югра': 'Ханты-Мансийский автономный округ - Югра',
  'Ямало-Ненецкий АО': 'Ямало-Ненецкий автономный округ',
  'Ненецкий АО': 'Ненецкий автономный округ',
  'Чукотский АО': 'Чукотский автономный округ',
  'Еврейская АО': 'Еврейская автономная область'
};
function regionMapName(value) {
  const name = String(value || '').trim();
  return REGION_MAP_ALIASES[name] || name;
}
/* Рейтинг справа листается страницами по пять строк — как региональный блок
 * Google Trends, откуда снята вся раскладка. Пять и есть его высота: столько
 * строк стоит рядом с картой, не растягивая панель.
 *
 * До этого подпись честно писала «Субъекты: 1–5 из 64», а добраться до
 * шестого было нельзя вовсе: число говорило, сколько всего нашлось, и на этом
 * всё. Владельцу же интересен именно хвост — из каких городов ещё приходят.
 */
const REGIONS_PER_PAGE = 5;
// Ступеней заливки пять, как у Trends: шестая уже не различается глазом, а
// четырёх мало, чтобы отличить столицу от области рядом с ней.
const HEAT_STEPS = 5;
function heatOf(value, max) {
  return value ? Math.max(1, Math.min(HEAT_STEPS, Math.ceil((Number(value) / Math.max(1, max)) * HEAT_STEPS))) : 0;
}

/* Строки данных ложатся на контуры по имени.
 *
 * У России для этого есть поимённая таблица выше: её контуры собраны из другого
 * источника, и все 85 названий геобазы сверены с ними тестом. Всем остальным
 * достаётся нормализация из `lib/geo-maps.js` — она сводит «Gomel Region» из
 * DB-IP с английским именем Natural Earth, а показывается при этом РУССКОЕ имя
 * карты: панель русская, и «Noord-Holland» посреди списка читался бы как сбой.
 *
 * Строка, которой контура не нашлось, из рейтинга НЕ пропадает: посетитель
 * оттуда был, и молчать о нём нельзя. Так на карте России ведут себя Крым и
 * Севастополь — в свободных данных Click That 'Hood их нет вовсе.
 */
function shapesFor(map, items) {
  const byKey = new Map();
  for (const region of map.regions) {
    // Латинских написаний у региона несколько («Noord-Holland», «North
    // Holland», «Provincie Noord-Holland»), и какое из них придёт из геобазы —
    // заранее не известно: в карте лежат все, разделённые «|».
    for (const variant of [region.name].concat(String(region.alt || '').split('|'))) {
      const key = GEO.matchKey(variant);
      if (key && !byKey.has(key)) byKey.set(key, region);
    }
  }
  const values = new Map();
  const extra = [];
  for (const item of items || []) {
    const label = regionMapName(item && item.label);
    const value = Number(item && item.value) || 0;
    if (!label || !value) continue;
    const hit = byKey.get(GEO.matchKey(label));
    if (hit) values.set(hit.name, (values.get(hit.name) || 0) + value);
    else extra.push({ label, value });
  }
  return { values, extra };
}

/* Одна карточка карты: контуры, подсказка и место под кнопки приближения.
 *
 * Кнопки рисует `public/admin-ui.js` — их здесь нет намеренно: без скриптов они
 * ничего не делают, а кнопке, которая ничего не делает, на экране не место (то
 * же правило, по которому готовые акценты в настройках появляются только со
 * скриптом). Сама карта при этом остаётся полноценной и без них.
 */
function mapStage(shapes, options) {
  const o = options || {};
  const paths = shapes.map(shape => {
    const attrs = [
      `class="gm-shape heat-${shape.level}${shape.current ? ' is-current' : ''}"`,
      `d="${shape.d}"`,
      `data-name="${esc(shape.name)}"`,
      `data-value="${esc(n(shape.value))}"`,
      // Подпись уезжает уже с заглавной: в подсказке она стоит первой строкой
      // ряда, а склонять и поднимать регистр в браузере значило бы завести там
      // вторую таблицу слов.
      `data-unit="${esc(R.pluralRu(shape.value, 'Посетитель', 'Посетителя', 'Посетителей'))}"`
    ];
    // Провалиться внутрь можно только туда, где есть что показать: у страны без
    // единого посетителя за период внутри пусто, и уводить туда незачем.
    // Адрес уже экранирован общей `href()` — второй проход дал бы `&amp;amp;`
    // прямо в ссылке, то есть параметр с амперсандом в имени.
    if (shape.href) attrs.push(`data-go="${shape.href}"`);
    return `<path ${attrs.join(' ')}></path>`;
  }).join('');
  /* `data-home` — исходный кадр: по нему кнопка сброса возвращает карту на
   * место, а сам `viewBox` скрипт правит на каждом приближении. Два разных
   * места хранения тут были бы ловушкой: живое обновление панели присылает
   * разметку с исходным кадром, и «домой» после него уводило бы не туда. */
  return `<div class="gm-stage" data-map data-home="${esc(o.viewBox)}">
      <svg class="gm-svg" viewBox="${esc(o.viewBox)}" role="img" aria-label="${esc(o.aria || 'Карта посетителей')}" focusable="false">${paths}</svg>
      <div class="gm-tip" hidden><b></b><span><i></i><em>Посетители</em><strong></strong></span></div>
    </div>`;
}

/* Рейтинг справа от карты: строки с числом, полосой и листалкой.
 *
 * Длина полосы считается от вершины ВСЕГО рейтинга, а не показанной страницы:
 * иначе на второй странице первая же строка растянулась бы во всю ширину и
 * прочиталась бы как самое посещаемое место.
 */
function ranking(rows, options) {
  const o = options || {};
  const max = Math.max(1, ...rows.map(row => row.value));
  const pages = Math.max(1, Math.ceil(rows.length / REGIONS_PER_PAGE));
  const page = Math.min(pages, Math.max(1, Math.floor(Number(o.page)) || 1));
  const start = (page - 1) * REGIONS_PER_PAGE;
  const top = rows.slice(start, start + REGIONS_PER_PAGE);
  const body = top.length ? top.map((row, i) => {
    const inner = `<span class="rm-rank-num">${start + i + 1}</span><b>${row.flag ? `<span class="rm-flag">${row.flag}</span>` : ''}${esc(row.label)}</b><span>${n(row.value)}</span>
    <i><em style="width:${Math.max(4, Math.round((row.value / max) * 100))}%"></em></i>`;
    // Строка страны — настоящая ссылка внутрь неё: без скриптов это
    // единственный путь с мировой карты в её регионы, и он обязан работать.
    return row.href
      ? `<a class="rm-rank-row is-link" href="${row.href}">${inner}</a>`
      : `<div class="rm-rank-row">${inner}</div>`;
  }).join('') : `<p class="metric-empty rm-empty">${esc(o.empty || 'Карта заполнится, когда определятся места посетителей.')}</p>`;

  /* Стрелки — настоящие ссылки, без единой строчки скрипта: страница метрики
   * рисуется сервером и обновляется подменой его же разметки, и свой расчёт в
   * браузере разъехался бы с ней. Якорь `#regions` возвращает к самой карте —
   * она стоит посреди отчёта, и без него листание уводило бы в начало страницы.
   * Одна страница — стрелок нет вовсе: кнопке, которая ничего не делает, на
   * экране не место. */
  const pageHref = o.pageHref || (num => '#regions' + num);
  const arrow = (dir, num, label) => (num >= 1 && num <= pages)
    ? `<a class="rm-page" href="${pageHref(num)}" rel="${dir}" aria-label="${label}">${R.PAGER_CHEVRON[dir]}</a>`
    : `<span class="rm-page rm-page-off" aria-hidden="true">${R.PAGER_CHEVRON[dir]}</span>`;
  const nav = pages > 1 ? arrow('prev', page - 1, 'Предыдущие места') : '';
  const navNext = pages > 1 ? arrow('next', page + 1, 'Следующие места') : '';
  const foot = top.length
    ? `<div class="rm-rank-foot">${nav}<span>${esc(o.unit || 'Места')}: ${start + 1}–${start + top.length} из ${rows.length}</span>${navNext}</div>`
    : '';
  return `<div class="rm-ranking">${body}${foot}</div>`;
}

/* Карта мира: страны красятся числом посетителей, серым — те, откуда никто не
 * заходил. Ступени считаются от самой посещаемой страны, У КОТОРОЙ ЕСТЬ КОНТУР:
 * посетитель с неопознанной страной первым местом обесцветил бы всю карту. */
function worldBoard(s, o) {
  const rows = (s.countries || []).map(row => ({
    code: GEO.codeOf(row.code),
    value: Number(row.value) || 0
  })).filter(row => row.value);
  const byCode = new Map(rows.map(row => [row.code, row.value]));
  const world = GEO.world();
  const mapMax = Math.max(1, ...world.countries.map(c => byCode.get(c.code) || 0));
  const shapes = world.countries.map(country => {
    const value = byCode.get(country.code) || 0;
    return {
      name: GEO.countryName(country.code), value, d: country.d,
      level: heatOf(value, mapMax),
      href: value ? o.link({ geo: country.code, reg: '' }) : ''
    };
  });
  const list = rows.map(row => ({
    label: row.code ? GEO.countryName(row.code) : 'Страна не определена',
    value: row.value,
    flag: row.code ? CI.flag('', row.code) : '',
    href: row.code ? o.link({ geo: row.code, reg: '' }) : ''
  })).sort((a, b) => b.value - a.value);
  return {
    stage: mapStage(shapes, { viewBox: world.viewBox, aria: 'Посетители по странам мира' }),
    rank: ranking(list, { page: o.page, pageHref: o.pageHref, unit: 'Страны', empty: 'Карта заполнится, когда определятся страны посетителей.' })
  };
}

/* Карта одной страны: её регионы, если контуры есть и хоть один регион
 * определился, иначе — она сама на приближённой мировой карте, а рейтинг по
 * городам. Второй случай честнее пустого места: посетители из страны есть, а
 * области у них не определились (или их нет в свободных данных вовсе). */
function countryBoard(s, o) {
  const code = GEO.codeOf(s.geo);   // сюда приходит уже проверенный `GEO.known()`
  const map = GEO.regionsOf(code);
  const parsed = map ? shapesFor(map, s.regions || []) : null;
  /* Своя карта есть — показываем именно её, даже когда ни один регион не
   * определился: серая карта страны честно говорит «регионы неизвестны», а мир
   * целиком на её месте не говорит ничего. Рейтинг тогда собирается по городам,
   * и заголовок блока называет именно их.
   *
   * Регионы, которым контура не нашлось, при этом рейтингом СЧИТАЮТСЯ: строка
   * данных не имеет права пропадать с экрана из-за того, что её нечем
   * закрасить, — так на карте России ведут себя Крым и Севастополь. */
  if (map && (parsed.values.size || parsed.extra.length)) {
    const mapMax = Math.max(1, ...map.regions.map(region => parsed.values.get(region.name) || 0));
    const shapes = map.regions.map(region => {
      const value = parsed.values.get(region.name) || 0;
      return { name: region.name, value, d: region.d, level: heatOf(value, mapMax) };
    });
    const list = [...parsed.values.entries()].map(([label, value]) => ({ label, value }))
      .concat(parsed.extra).sort((a, b) => b.value - a.value);
    return {
      stage: mapStage(shapes, { viewBox: map.viewBox, aria: 'Посетители по регионам: ' + GEO.countryName(code) }),
      rank: ranking(list, { page: o.page, pageHref: o.pageHref, unit: 'Регионы' }),
      note: 'регионы'
    };
  }
  const cities = (s.cities || []).map(row => ({ label: row.label, value: Number(row.value) || 0 }));
  const cityRank = { page: o.page, pageHref: o.pageHref, unit: 'Города', empty: 'Города посетителей этой страны не определились.' };
  if (map) {
    // Регионы неизвестны — контуры остаются серыми, но страна на месте.
    const shapes = map.regions.map(region => ({ name: region.name, value: 0, d: region.d, level: 0 }));
    return {
      stage: mapStage(shapes, { viewBox: map.viewBox, aria: 'Посетители: ' + GEO.countryName(code) }),
      rank: ranking(cities, cityRank),
      note: 'города'
    };
  }

  // Приближение к стране: соседи остаются на карте серыми — без них страна
  // висела бы силуэтом без места на глобусе.
  const world = GEO.world();
  const total = ((s.countries || []).find(row => GEO.codeOf(row.code) === code) || {}).value || 0;
  const shapes = world.countries.map(country => ({
    name: GEO.countryName(country.code),
    value: country.code === code ? total : 0,
    d: country.d,
    level: country.code === code ? HEAT_STEPS : 0,
    current: country.code === code
  }));
  /* Кадр вокруг страны берётся С ЗАПАСОМ, и запас большой намеренно. Контуры
   * мира упрощены под общий вид (см. scripts/build-geo-maps.js), и вблизи у них
   * видны прямые грани: приближение впритык показывает не страну, а многоугольник.
   * Полтора её размера в кадре — та мера, при которой и форма узнаётся, и
   * соседи вокруг говорят, где это на глобусе. Крошечное государство при этом
   * не раздувается до пикселей: у кадра есть наименьший размер. */
  const box = GEO.boxOf(code);
  const MIN_FRAME = 150;
  let viewBox = world.viewBox;
  if (box) {
    const pad = Math.max(24, Math.max(box[2], box[3]) * 0.6);
    let width = box[2] + pad * 2;
    let height = box[3] + pad * 2;
    const grow = Math.max(1, MIN_FRAME / Math.max(width, height));
    width *= grow; height *= grow;
    const x = box[0] + box[2] / 2 - width / 2;
    const y = box[1] + box[3] / 2 - height / 2;
    viewBox = `${Math.round(x)} ${Math.round(y)} ${Math.round(width)} ${Math.round(height)}`;
  }
  return {
    stage: mapStage(shapes, { viewBox, aria: 'Посетители: ' + GEO.countryName(code) }),
    rank: ranking(cities, cityRank),
    note: 'страна'
  };
}

function geoBoard(s, o) {
  const code = GEO.known(s.geo) ? GEO.codeOf(s.geo) : '';
  const board = code ? countryBoard(s, o) : worldBoard(s, o);
  const titles = {
    регионы: ['Посетители по регионам', 'Уникальные посетители по регионам страны · места без посетителей остаются серыми'],
    города: ['Посетители по городам', 'У этих посетителей регион не определился — рейтинг собран по городам'],
    страна: ['Посетители по городам', 'Своей карты регионов у этой страны нет — она показана на общей карте, а рейтинг собран по городам']
  };
  const [title, hint] = titles[board.note] || ['Посетители по странам', 'Уникальные посетители по странам · нажатие на страну открывает её регионы'];
  return { html: `<div class="ru-map gm">${board.stage}${board.rank}</div>`, title, hint };
}

/* ------------------------- Выпадающие меню Trends ---------------------------
 *
 * Кнопка-пилюля со значком и меню под ней — те самые, что стоят у Google над
 * отчётом («Весь мир», «Последние 4 часа»): белая пилюля 40 px с волосяной
 * рамкой, открытая подсвечена голубым, в меню выбранный пункт лежит на зелёной
 * плашке с галочкой.
 *
 * Держит их `<details>`, а не скрипт: панель обновляется подменой серверной
 * разметки, и второе состояние в браузере разъехалось бы с ней. Живое
 * обновление `open` у `<details>` не трогает вовсе — это состояние, которым
 * владеет человек. Без скриптов меню тоже работает: пункты — обычные ссылки, а
 * поле поиска над длинным списком просто фильтрует их, когда скрипт есть.
 */
const MENU_CHECK = '<svg class="g-check" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="m5 12.5 4.6 4.5L19 7.5"/></svg>';
const MENU_CHEVRON = '<svg class="g-chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="m7 10 5 5 5-5"/></svg>';

function gOption(item) {
  const inner = `${MENU_CHECK}<span>${esc(item.label)}</span>${item.note ? `<b>${esc(item.note)}</b>` : ''}`;
  return `<a class="g-opt${item.active ? ' is-on' : ''}" href="${item.href}"${item.active ? ' aria-current="true"' : ''} data-menu-item="${esc(String(item.label).toLowerCase())}">${inner}</a>`;
}

function gSelect(options) {
  const o = options || {};
  const groups = (o.groups || []).map(group => `${group.title ? `<div class="g-menu-title">${esc(group.title)}</div>` : ''}<div class="g-menu-list">${group.items.map(gOption).join('')}</div>`).join('<div class="g-menu-line"></div>');
  const search = o.search
    ? `<label class="g-menu-search">${CI.icon('search')}<input type="search" placeholder="${esc(o.search)}" data-menu-search aria-label="${esc(o.search)}"></label>`
    : '';
  return `<details class="g-select${o.className ? ' ' + o.className : ''}" data-menu>
    <summary class="g-pill" aria-haspopup="menu"><span class="g-pill-ico">${o.icon || ''}</span><span class="g-pill-text">${esc(o.label)}</span>${MENU_CHEVRON}</summary>
    <div class="g-menu">${o.title ? `<div class="g-menu-head">${esc(o.title)}</div>` : ''}${search}<div class="g-menu-body">${groups}</div><p class="g-menu-empty" hidden>Ничего не нашлось</p></div>
  </details>`;
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
  const byWeek = days === 365 && Array.isArray(s.weekly) && s.weekly.length;
  const people = value => n(value) + ' ' + plural(value, 'посетитель', 'посетителя', 'посетителей');
  const chart = byHour
    ? lineChart((s.hourly || []).map(h => ({
      label: String(h.hour).padStart(2, '0'),
      value: h.visitors,
      note: String(h.hour).padStart(2, '0') + ':00'
    })), { labels: 8, aria: 'Посетители по часам сегодня' })
    : lineChart((byWeek ? s.weekly : (s.daily || [])).map(d => ({
      label: byWeek ? monthLabel(d.date) : dayLabel(d.date),
      value: d.visitors,
      note: byWeek
        ? dayLabel(d.date, { month: 'long' }) + ' — ' + dayLabel(d.endDate, { month: 'long' })
        : dayLabel(d.date, { month: 'long' })
      // Подписей у года четыре — это шаг ровно в тринадцать недель, то есть в
      // квартал: столько же их у Trends, и месяцы в подписях тогда не соседние.
    })), { labels: byWeek ? 4 : (days > 14 ? 7 : 10), aria: byWeek ? 'Посетители по неделям' : 'Посетители по дням', empty: days === 1 ? 'Сегодня заходов ещё не было' : 'График появится после первых посещений' });
  /* Подпись справа от заголовка называет ПЕРИОД И ШАГ ряда, и больше ничего.
   * У Google на этом месте стоит выбранная страна, и первым заходом сюда было
   * скопировано «Россия · 30 дней» — а график считает всех посетителей подряд,
   * включая заграничных. Подпись под картинкой Trends обещала бы отбор, которого
   * нет. */
  const chartScale = byHour ? 'сегодня · по часам'
    : byWeek ? '12 месяцев · по неделям'
      : days + ' ' + plural(days, 'день', 'дня', 'дней') + ' · по дням';

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

  /* Весь адрес отчёта собирает ОДНА функция: период, страна и страница рейтинга
   * живут в нём рядом, и собранный где-то ещё он разъехался бы с этим на первой
   * правке. Смена периода или страны при этом возвращает рейтинг на первую
   * страницу — другой отбор, другой рейтинг, и «страница 9» в нём означала бы
   * уже не тех соседей. */
  const base = options.base || '/admin/analytics';
  // Неизвестный код в адресе — это «весь мир»: показать про него всё равно
  // нечего, а пустая карта рядом с пустым рейтингом читалась бы как поломка.
  const geo = GEO.known(s.geo) ? GEO.codeOf(s.geo) : '';
  const link = patch => href(base, { days, geo }, patch);
  const visitorsHref = esc(options.visitorsHref || '#');

  /* Подписи периодов — как в меню Trends («Последние 24 часа», «Последний
   * месяц»): они называют отрезок целиком, а не одно число. «Сегодня» при этом
   * остаётся собой — это ТЕКУЩИЕ СУТКИ по Москве, а не последние 24 часа, и
   * называть их так значило бы соврать о том, что показано. */
  const RANGES = [[1, 'Сегодня'], [7, 'Последние 7 дней'], [30, 'Последние 30 дней'], [365, 'Последние 12 месяцев']];
  const daysSelect = gSelect({
    className: 'gs-days', icon: CI.icon('calendar'), title: 'Период отчёта',
    label: (RANGES.find(([d]) => d === days) || RANGES[0])[1],
    groups: [{ items: RANGES.map(([d, label]) => ({ label, href: link({ days: d, reg: '' }), active: days === d })) }]
  });

  /* Меню местоположения показывает ТОЛЬКО страны, откуда правда заходили.
   *
   * У Google в этом списке весь мир алфавитом — у них данные есть везде. Здесь
   * же двести стран, из которых у ста девяноста восьми ноль посетителей, — это
   * не выбор, а перебор пустых карт. Поиск появляется, когда список перестаёт
   * читаться с одного взгляда. */
  const countryOptions = (s.countries || []).filter(row => GEO.codeOf(row.code) && row.value).map(row => ({
    label: GEO.countryName(row.code), note: n(row.value),
    href: link({ geo: GEO.codeOf(row.code), reg: '' }), active: geo === GEO.codeOf(row.code)
  }));
  const geoSelect = gSelect({
    /* Меню раскрывается ВЛЕВО: кнопка стоит у правого края шапки блока, и меню,
     * начатое от её левого края, вылезало бы за границу панели — на широком
     * экране это 24 пикселя за краем, то есть обрезанный список. */
    className: 'gs-geo g-menu-right', icon: CI.icon(geo ? 'pin' : 'globe'), title: 'Местоположение',
    label: geo ? GEO.countryName(geo) : 'Весь мир',
    search: countryOptions.length > 8 ? 'Поиск страны' : '',
    groups: [
      { items: [{ label: 'Весь мир', href: link({ geo: '', reg: '' }), active: !geo, note: n(s.unique) }] },
      { title: countryOptions.length ? 'Откуда заходили' : '', items: countryOptions }
    ].filter(group => group.items.length)
  });

  const board = geoBoard(s, { page: options.regionPage, link, pageHref: num => link({ reg: num }) + '#regions' });

  /* Кнопки «Обновить» и подписи «Обновлено 16:36» здесь больше нет.
   *
   * Обе появились от одного и того же: страница отдавалась один раз, а метрика
   * менялась каждую секунду, и узнать, что на витрине происходит СЕЙЧАС, можно
   * было только перезагрузкой. Теперь страница обновляется сама
   * (`public/admin-live.js`), кнопка предлагала бы сделать руками то, что уже
   * сделано, а время последнего обновления перестало что-либо значить: оно
   * всегда «только что». Отметка «живое» стоит в шапке панели.
   */
  return `<div class="metric-toolbar">${daysSelect}<a class="metric-more-link" href="${visitorsHref}">${CI.icon('users')}Кто заходил${s.visitorsTotal ? ' · ' + n(s.visitorsTotal) : ''}</a></div>
  <div class="metric-summary">${cards}</div>
  <section class="a-panel metric-panel metric-traffic trends-panel"><div class="metric-panel-head trends-head"><div><h2>Динамика посещаемости <span class="trends-help" title="Уникальные посетители за выбранный период">?</span></h2></div><span>${esc(chartScale)}</span></div>${chart}</section>
  <section class="a-panel metric-panel metric-russia trends-panel" id="regions"><div class="metric-panel-head trends-head"><div><h2>${esc(board.title)} <span class="trends-help" title="${esc(board.hint)}">?</span></h2></div>${geoSelect}</div>${board.html}</section>
  <section class="a-panel metric-panel metric-visitors"><div class="metric-panel-head"><div><span class="metric-kicker">Посетители</span><h2>Кто заходил</h2></div><a class="link" href="${visitorsHref}">Все посетители →</a></div>
    ${visitorsTable(s.visitors || [], { now: s.generatedAt, products, visitorBase: options.visitorBase, ordersHref: options.ordersHref })}
  </section>
  <div class="metric-grid-secondary">
    <section class="a-panel metric-panel"><div class="metric-panel-head"><div><span class="metric-kicker">Устройства</span><h2>Типы устройств</h2></div></div>${bars(s.devices, { icon: 'device', of: s.unique, className: 'metric-device-bars' })}</section>
    <section class="a-panel metric-panel"><div class="metric-panel-head"><div><span class="metric-kicker">География</span><h2>Города</h2></div></div>${bars(s.locations || [], { icon: 'place', of: s.unique, className: 'metric-location-bars' })}</section>
  </div>
  <div class="metric-grid-secondary">
    <section class="a-panel metric-panel"><div class="metric-panel-head"><div><span class="metric-kicker">Контент</span><h2>Популярные страницы</h2></div><span>сколько раз открывали</span></div>${bars(s.pages, { icon: 'page', of: s.pageViews, labelOf: p => pageLabel(p, products) })}</section>
    <section class="a-panel metric-panel"><div class="metric-panel-head"><div><span class="metric-kicker">Источники</span><h2>Откуда приходят</h2></div></div>${bars(s.sources, { icon: 'source', of: s.unique })}</section>
  </div>
  <div class="metric-grid-secondary">
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

  /* Отбор остаётся обычной GET-формой. Родные `type=date` никуда не исчезают:
   * без скрипта ими можно пользоваться как прежде. `admin-ui.js` только
   * подменяет их видимой кнопкой и открывает календарь в раскладке Trends;
   * итоговое YYYY-MM-DD по-прежнему отправляет именно нативное поле.
   *
   * Уже выбранные фишки — скрытыми полями рядом, иначе «Показать» за один
   * нажим стирал бы отбор по технике. */
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
      <div class="mf-date"><span class="mf-date-caption">С</span><span class="mf-date-control">
        <input type="date" name="from" value="${esc(res.from || '')}" class="mf-date-native" max="${esc(today)}" aria-label="Дата начала">
        <button type="button" class="mf-date-trigger" data-date-trigger="from" aria-haspopup="dialog" aria-expanded="false" hidden><span data-date-label class="${res.from ? '' : 'is-placeholder'}">${inputDayLabel(res.from)}</span><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m7 9.5 5 5 5-5"/></svg></button>
      </span></div>
      <div class="mf-date"><span class="mf-date-caption">По</span><span class="mf-date-control">
        <input type="date" name="to" value="${esc(res.to || '')}" class="mf-date-native" max="${esc(today)}" aria-label="Дата окончания">
        <button type="button" class="mf-date-trigger" data-date-trigger="to" aria-haspopup="dialog" aria-expanded="false" hidden><span data-date-label class="${res.to ? '' : 'is-placeholder'}">${inputDayLabel(res.to)}</span><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m7 9.5 5 5 5-5"/></svg></button>
      </span></div>
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

module.exports = { dashboard, visitorsPage, visitorPage, visitorMissing, pageLabel, ago };
