'use strict';

const R = require('./render');
const CI = require('./client-icons');
const { ONLINE_MS, sessionsOf } = require('./analytics');
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
function location(v) { return [v.city, v.region, v.country].filter(Boolean).filter((x, i, a) => a.indexOf(x) === i).join(', ') || 'Город не определён'; }
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

function bars(items, className) {
  const max = Math.max(1, ...items.map(x => Number(x.value) || 0));
  return items.length ? `<div class="metric-bars ${className || ''}">${items.map(x => `<div class="metric-bar-row">
    <div class="metric-bar-label"><span title="${esc(x.label)}">${esc(x.label)}</span><b>${n(x.value)}</b></div>
    <div class="metric-bar-track"><i style="width:${Math.max(3, Math.round((Number(x.value) || 0) / max * 100))}%"></i></div>
  </div>`).join('')}</div>` : '<p class="metric-empty">Данных пока нет</p>';
}

function dashboard(snapshot, options) {
  options = options || {};
  const products = options.products || {};
  const maxChart = Math.max(1, ...snapshot.daily.map(d => d.pageViews || 0));
  const chart = snapshot.daily.length ? `<div class="metric-chart" aria-label="Просмотры по дням">${snapshot.daily.map(d => {
    const h = Math.max(5, Math.round((d.pageViews || 0) / maxChart * 100));
    const date = new Date(d.date + 'T00:00:00+03:00').toLocaleDateString('ru-RU', { day: '2-digit', month: 'short' });
    return `<div class="metric-day" title="${esc(date)}: ${n(d.pageViews)} просмотров"><span>${n(d.pageViews)}</span><i style="height:${h}%"></i><small>${esc(date)}</small></div>`;
  }).join('')}</div>` : '<p class="metric-empty">График появится после первых посещений</p>';

  const visitors = snapshot.visitors.map(v => {
    const online = snapshot.generatedAt - Number(v.lastSeen) <= ONLINE_MS;
    // Вся строка ведёт в карточку посетителя: там его хронология по визитам.
    const href = options.visitorBase ? esc(options.visitorBase + encodeURIComponent(v.id)) : '';
    const open = (inner, cls) => href ? `<a class="metric-open${cls ? ' ' + cls : ''}" href="${href}">${inner}</a>` : inner;
    /* Ячейки названы, потому что на телефоне строка становится карточкой и
     * раскладку задаёт сетка: безымянные <td> ей не адресовать. Пять столбцов
     * (активность, город с IP, техника, страница, заявка) в 390 px не встают
     * никак — таблицу приходилось листать вбок, теряя из виду и время, и город. */
    return `<tr>
      <td class="mv-when">${open(`<div class="metric-visitor"><span class="metric-status${online ? ' online' : ''}"></span><div><b>${online ? 'Сейчас на сайте' : ago(v.lastSeen, snapshot.generatedAt)}</b><small>${esc(String(v.id || '').slice(0, 8))}</small></div></div>`)}</td>
      <td class="mv-place"><b>${flagMark(v)}${esc(location(v))}</b><small>${open(esc(v.ip || 'IP не определён'), 'metric-ip')}${v.isp ? ' · ' + esc(v.isp) : ''}</small></td>
      <td class="mv-tech">${deviceMarks(v) || `<b>${esc(device(v))}</b>`}<small>${esc(technical(v) || v.platform || 'Технические данные не переданы')}</small><small>Источник: ${esc(v.source || 'Прямой заход')}${v.utmCampaign ? ' · UTM: ' + esc(v.utmCampaign) : ''}</small></td>
      <td class="mv-page"><b>${esc(pageLabel(v.lastPage, products))}</b><small>Вход: ${esc(pageLabel(v.entryPage, products))}</small><small>${n(v.visits)} визитов · ${n(v.pageViews)} просмотров · ${duration(v.activeSeconds)}</small></td>
      <td class="mv-order">${v.orderCount ? `<a class="metric-order" href="${esc(options.ordersHref || '#')}${v.lastOrderId ? '#order-' + esc(v.lastOrderId) : ''}">${v.lastOrderNumber ? esc(v.lastOrderNumber) : n(v.orderCount) + ' заказ' + (v.orderCount === 1 ? '' : 'а')}</a>` : '<span class="metric-no-order">—</span>'}</td>
    </tr>`;
  }).join('') || '<tr><td colspan="5" class="metric-empty">После первых посещений данные появятся здесь.</td></tr>';

  const ranges = [1, 7, 30].map(days => `<a href="${esc(options.rangeBase || '')}${days}" class="metric-range${snapshot.days === days ? ' active' : ''}">${days === 1 ? 'Сегодня' : days + ' дней'}</a>`).join('');

  /* Кнопки «Обновить» и подписи «Обновлено 16:36» здесь больше нет.
   *
   * Обе появились от одного и того же: страница отдавалась один раз, а метрика
   * менялась каждую секунду, и узнать, что на витрине происходит СЕЙЧАС, можно
   * было только перезагрузкой. Теперь страница обновляется сама
   * (`public/admin-live.js`), кнопка предлагала бы сделать руками то, что уже
   * сделано, а время последнего обновления перестало что-либо значить: оно
   * всегда «только что». Отметка «живое» стоит в шапке панели.
   */
  return `<div class="metric-toolbar"><div class="metric-ranges">${ranges}</div></div>
  <div class="metric-summary">
    <article class="metric-card metric-live"><span>Онлайн сейчас</span><strong><i></i>${n(snapshot.online)}</strong><small>за последние 2 минуты</small></article>
    <article class="metric-card"><span>Посетители</span><strong>${n(snapshot.unique)}</strong><small>возвращаются ${pct(snapshot.returnRate)}</small></article>
    <article class="metric-card"><span>Визиты</span><strong>${n(snapshot.visits)}</strong><small>${n(snapshot.pageViews)} просмотров · ${n(snapshot.pagesPerVisit)} стр./визит</small></article>
    <article class="metric-card"><span>Среднее время</span><strong>${duration(snapshot.averageSeconds)}</strong><small>${duration(snapshot.activeSeconds)} вовлечённого времени</small></article>
    <article class="metric-card"><span>Заявки</span><strong>${n(snapshot.orders)}</strong><small>конверсия ${pct(snapshot.conversion)}</small></article>
  </div>
  <div class="metric-grid-main">
    <section class="a-panel metric-panel metric-traffic"><div class="metric-panel-head"><div><span class="metric-kicker">Динамика</span><h2>Посещаемость</h2></div><span>${n(snapshot.pageViews)} просмотров</span></div>${chart}</section>
    <section class="a-panel metric-panel"><div class="metric-panel-head"><div><span class="metric-kicker">Устройства</span><h2>Типы устройств</h2></div></div>${bars(snapshot.devices, 'metric-device-bars')}</section>
  </div>
  <div class="metric-grid-secondary">
    <section class="a-panel metric-panel"><div class="metric-panel-head"><div><span class="metric-kicker">Контент</span><h2>Популярные страницы</h2></div></div>${bars(snapshot.pages.map(x => ({ label: pageLabel(x.label, products), value: x.value })))}</section>
    <section class="a-panel metric-panel"><div class="metric-panel-head"><div><span class="metric-kicker">Источники</span><h2>Откуда приходят</h2></div></div>${bars(snapshot.sources)}</section>
  </div>
  <div class="metric-grid-tertiary">
    <section class="a-panel metric-panel"><div class="metric-panel-head"><div><span class="metric-kicker">География</span><h2>Города</h2></div></div>${bars(snapshot.locations || [], 'metric-location-bars')}</section>
    <section class="a-panel metric-panel"><div class="metric-panel-head"><div><span class="metric-kicker">Технологии</span><h2>Браузеры</h2></div></div>${bars(snapshot.browsers || [])}</section>
    <section class="a-panel metric-panel"><div class="metric-panel-head"><div><span class="metric-kicker">Технологии</span><h2>Операционные системы</h2></div></div>${bars(snapshot.systems || [])}</section>
  </div>
  ${snapshot.campaigns && snapshot.campaigns.length ? `<section class="a-panel metric-panel metric-campaigns"><div class="metric-panel-head"><div><span class="metric-kicker">Маркетинг</span><h2>UTM-кампании</h2></div></div>${bars(snapshot.campaigns)}</section>` : ''}
  <section class="a-panel metric-panel metric-bots">
    <div class="metric-panel-head"><div><span class="metric-kicker">Отдельно от посетителей</span><h2>Боты и технические запросы</h2></div><span>не влияют на основную метрику</span></div>
    <div class="metric-bot-summary"><div><strong>${n((snapshot.bots || {}).hits)}</strong><span>запросов</span></div><div><strong>${n((snapshot.bots || {}).notFound)}</strong><span>ошибок 404</span></div></div>
    <div class="metric-bot-grid"><div><h3>Типы запросов</h3>${bars((snapshot.bots || {}).agents || [])}</div><div><h3>Какие адреса проверяли</h3>${bars((snapshot.bots || {}).paths || [])}</div></div>
  </section>
  <section class="a-panel metric-panel metric-visitors"><div class="metric-panel-head"><div><span class="metric-kicker">Посетители</span><h2>Кто заходил</h2></div><span>до 250 последних</span></div>
    <div class="metric-table-wrap"><table class="a-table metric-table"><thead><tr><th>Активность</th><th>Город и IP</th><th>Устройство и источник</th><th>Страница</th><th>Заявка</th></tr></thead><tbody>${visitors}</tbody></table></div>
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
    ['Визитов', n(v.visits || 0), 'за всё время'],
    ['Просмотров', n(v.pageViews || 0), sessions.length ? 'в хронологии ниже — ' + n(sessions.length) + ' ' + plural(sessions.length, 'визит', 'визита', 'визитов') : ''],
    ['Время на сайте', durationShort(v.activeSeconds), v.visits ? 'в среднем ' + durationShort(Math.round((Number(v.activeSeconds) || 0) / Number(v.visits))) + ' за визит' : ''],
    ['Первый заход', esc(R.formatDate(v.firstSeen)), 'знаем его ' + n(days) + ' ' + plural(days, 'день', 'дня', 'дней')],
    ['Последний заход', online ? 'сейчас' : ago(v.lastSeen, now), esc(dateTime(v.lastSeen))],
    ['Заказов', n(v.orderCount || 0), v.lastOrderAt ? 'последний ' + esc(R.formatDate(v.lastOrderAt)) : 'заказов не было']
  ].map(([label, value, note]) => `<article class="metric-card"><span>${label}</span><strong>${value}</strong><small>${note || ''}</small></article>`).join('');

  const visits = sessions.map((s, i) => {
    // Нумерация от общего счётчика визитов: в хронологии их последние
    // полсотни просмотров, а всего визитов могло быть больше.
    const number = Math.max(1, (Number(v.visits) || sessions.length) - i);
    const steps = s.hits.map(h => `<li>
      <span class="visit-time">${esc(clock(h.t))}</span>
      <span class="visit-page">${esc(pageLabel(h.p, products))}<i>${esc(h.p || '')}</i></span>
      <span class="visit-sec">${h.s ? esc(duration(h.s)) : '—'}</span></li>`).join('');
    return `<div class="visit">
      <div class="visit-head"><b>Визит №${number}</b><span>${esc(dateTime(s.startAt))} · ${esc(duration(s.seconds))} · ${n(s.hits.length)} ${plural(s.hits.length, 'страница', 'страницы', 'страниц')}</span></div>
      <ol class="visit-steps">${steps}</ol></div>`;
  }).join('') || '<p class="metric-empty">Хронология появится после первого подтверждённого просмотра страницы.</p>';

  const pathRows = Object.entries(v.pathCounts || {}).sort((a, b) => b[1] - a[1]).slice(0, 12)
    .map(([p, count]) => ({ label: pageLabel(p, products), value: count }));

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
    <span>${esc(device(other))} · ${n(other.visits)} визитов · ${esc(ago(other.lastSeen, now))}</span></li>`).join('');

  return `<div class="metric-toolbar"><a class="metric-range" href="${esc(options.backHref || '#')}">← Ко всей метрике</a><div class="metric-updated">Карточка посетителя</div></div>
  <section class="a-panel metric-panel visitor-head">
    <div class="visitor-title">
      <span class="metric-status${online ? ' online' : ''}"></span>
      <h2>${flagMark(v)}${esc(location(v))}</h2>
      <span class="visitor-when">${online ? 'сейчас на сайте' : esc(ago(v.lastSeen, now))}</span>
    </div>
    <div class="visitor-ip">${esc(v.ip || 'IP не определён')}${v.isp ? ' · ' + esc(v.isp) : ''}</div>
    ${deviceMarks(v)}
  </section>
  <div class="metric-summary visitor-summary">${cards}</div>
  ${orders ? `<section class="a-panel metric-panel"><div class="metric-panel-head"><div><span class="metric-kicker">Покупки</span><h2>Заказы этого посетителя</h2></div></div><ul class="visitor-orders">${orders}</ul></section>` : ''}
  <section class="a-panel metric-panel visitor-visits">
    <div class="metric-panel-head"><div><span class="metric-kicker">Хронология</span><h2>Как он ходил по сайту</h2></div><span>последние ${n(sessions.length)} ${plural(sessions.length, 'визит', 'визита', 'визитов')}</span></div>
    ${visits}
  </section>
  <div class="metric-grid-secondary">
    <section class="a-panel metric-panel"><div class="metric-panel-head"><div><span class="metric-kicker">За всё время</span><h2>Какие страницы открывал</h2></div></div>${bars(pathRows)}</section>
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

module.exports = { dashboard, visitorPage, visitorMissing, pageLabel, ago };
