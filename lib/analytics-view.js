'use strict';

const R = require('./render');
const { ONLINE_MS } = require('./analytics');
const esc = R.esc;

function n(value) { return Number(value || 0).toLocaleString('ru-RU'); }
function pct(value) { return String(Number(value || 0).toLocaleString('ru-RU', { maximumFractionDigits: 1 })) + '%'; }
function duration(value) {
  const seconds = Math.max(0, Math.round(Number(value) || 0));
  if (seconds < 60) return seconds ? seconds + ' сек' : '—';
  if (seconds < 3600) return Math.floor(seconds / 60) + ' мин ' + seconds % 60 + ' сек';
  return Math.floor(seconds / 3600) + ' ч ' + Math.floor((seconds % 3600) / 60) + ' мин';
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
function technical(v) {
  const power = [v.deviceMemory ? v.deviceMemory + ' ГБ RAM' : '', v.cpuCores ? v.cpuCores + ' ядер' : ''].filter(Boolean).join(' · ');
  return [v.platform, v.screen ? 'экран ' + v.screen : '', v.viewport ? 'окно ' + v.viewport : '', v.language, v.timezone, power, v.connection].filter(Boolean).join(' · ');
}
function pageLabel(path, products) {
  if (path === '/') return 'Главная';
  if (path === '/privacy') return 'Политика конфиденциальности';
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
    return `<tr>
      <td><div class="metric-visitor"><span class="metric-status${online ? ' online' : ''}"></span><div><b>${online ? 'Сейчас на сайте' : ago(v.lastSeen, snapshot.generatedAt)}</b><small>${esc(String(v.id || '').slice(0, 8))}</small></div></div></td>
      <td><b>${esc(location(v))}</b><small>${esc(v.ip || 'IP не определён')}${v.isp ? ' · ' + esc(v.isp) : ''}</small></td>
      <td><b>${esc(device(v))}</b><small>${esc(technical(v) || v.platform || 'Технические данные не переданы')}</small><small>Источник: ${esc(v.source || 'Прямой заход')}${v.utmCampaign ? ' · UTM: ' + esc(v.utmCampaign) : ''}</small></td>
      <td><b>${esc(pageLabel(v.lastPage, products))}</b><small>Вход: ${esc(pageLabel(v.entryPage, products))}</small><small>${n(v.visits)} визитов · ${n(v.pageViews)} просмотров · ${duration(v.activeSeconds)}</small></td>
      <td>${v.orderCount ? `<a class="metric-order" href="${esc(options.ordersHref || '#')}${v.lastOrderId ? '#order-' + esc(v.lastOrderId) : ''}">${v.lastOrderNumber ? esc(v.lastOrderNumber) : n(v.orderCount) + ' заказ' + (v.orderCount === 1 ? '' : 'а')}</a>` : '<span class="metric-no-order">—</span>'}</td>
    </tr>`;
  }).join('') || '<tr><td colspan="5" class="metric-empty">После первых посещений данные появятся здесь.</td></tr>';

  const ranges = [1, 7, 30].map(days => `<a href="${esc(options.rangeBase || '')}${days}" class="metric-range${snapshot.days === days ? ' active' : ''}">${days === 1 ? 'Сегодня' : days + ' дней'}</a>`).join('');
  const siteSelect = options.siteSelect || '';

  return `<div class="metric-toolbar"><div class="metric-ranges">${ranges}</div>${siteSelect}<div class="metric-updated">Обновлено ${new Date(snapshot.generatedAt).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}</div><button class="metric-refresh" type="button" onclick="location.reload()">Обновить</button></div>
  <div class="metric-summary">
    <article class="metric-card metric-live"><span>Онлайн сейчас</span><strong><i></i>${n(snapshot.online)}</strong><small>активность за последние 2 минуты</small></article>
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

module.exports = { dashboard, pageLabel, ago };
