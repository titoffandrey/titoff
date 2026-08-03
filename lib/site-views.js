'use strict';
// Админка КОНКРЕТНОГО САЙТА (/admin по домену): цены, видимость товаров и отзывов, заказы, бренд.
const R = require('./render');
const T = require('./tenancy');
const AV = require('./analytics-view');
const esc = R.esc;

function layout(site, opts) {
  opts = opts || {};
  const accessibleBody = R.accessibleFields(opts.body || '', 'admin-field');
  const nav = [
    ['/admin', 'Обзор', 'dash'],
    ['/admin/catalog', 'Товары и цены', 'catalog'],
    ['/admin/reviews', 'Отзывы', 'reviews'],
    ['/admin/orders', 'Заказы', 'orders'],
    ['/admin/analytics', 'Метрика', 'analytics'],
    ['/admin/settings', 'Настройки', 'settings']
  ].map(([href, label, key]) => `<a href="${href}" class="a-nav-item${opts.active === key ? ' active' : ''}"${opts.active === key ? ' aria-current="page"' : ''}>${label}</a>`).join('');
  return `<!DOCTYPE html><html lang="ru"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(site.storeName)} · админка</title>
<link rel="stylesheet" href="/static/styles.css?v=${R.assetV('styles.css')}"><style>:root{--accent:${R.cssColor(site.accentColor)}}</style></head>
<body class="admin">
<div class="a-shell">
  <aside class="a-sidebar">
    <div class="a-brand">${esc(site.storeName)}<span>админка сайта</span></div>
    <nav class="a-nav">${nav}</nav>
    <div class="a-nav-foot">
      <a class="a-nav-item" href="${(site.hosts && site.hosts[0]) ? '//' + esc(site.hosts[0]) : '/?site=' + site.id}" target="_blank" rel="noopener noreferrer">Открыть сайт ↗</a>
      <form action="/admin/logout" method="post"><button class="a-logout">Выйти</button></form>
    </div>
  </aside>
  <main class="a-main">
    <div class="a-topbar"><h1>${esc(opts.title || '')}</h1>${opts.actions || ''}</div>
    ${opts.flash ? `<div class="a-flash ${esc(opts.flashType || 'ok')}">${esc(opts.flash)}</div>` : ''}
    <div class="a-content">${accessibleBody}</div>
  </main>
</div>
<script>document.addEventListener('submit',function(e){var f=e.target;if(f.matches('[data-confirm]')&&!confirm(f.getAttribute('data-confirm')))e.preventDefault();});</script>
</body></html>`;
}

function loginPage(site, error) {
  return `<!DOCTYPE html><html lang="ru"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>Вход · ${esc(site.storeName)}</title>
<link rel="stylesheet" href="/static/styles.css?v=${R.assetV('styles.css')}"><style>:root{--accent:${R.cssColor(site.accentColor)}}</style></head>
<body class="admin login-body">
<form class="login-card" method="post" action="/admin/login">
  <div class="login-brand">${esc(site.storeName)}</div>
  <p class="muted">Админка сайта</p>
  ${error ? `<div class="a-flash err">${esc(error)}</div>` : ''}
  <div class="field"><label for="admin-login">Логин</label><input id="admin-login" name="username" autocomplete="username" required autofocus></div>
  <div class="field"><label for="admin-password">Пароль</label><input id="admin-password" name="password" type="password" autocomplete="current-password" required></div>
  <button class="btn btn-primary btn-block" type="submit">Войти</button>
</form></body></html>`;
}

function dashboard(db, site) {
  const orders = db.ordersForSite(site.id);
  const newOrders = orders.filter(o => o.status === 'new').length;
  const shown = T.siteProductViews(site).length;
  const total = db.getProducts().length;
  const ss = T.siteSettings(site);
  const recent = orders.slice(0, 6).map(o => `<tr><td><b>${esc(o.number)}</b></td><td>${R.formatDate(o.createdAt)}</td><td>${esc(o.contact)}</td><td>${R.money(o.total, ss)}</td></tr>`).join('') || `<tr><td colspan="4" class="muted">Заказов пока нет</td></tr>`;
  const body = `
    <div class="a-cards">
      <a class="a-stat" href="/admin/orders"><div class="a-stat-num">${newOrders}</div><div>Новых заказов</div></a>
      <a class="a-stat" href="/admin/orders"><div class="a-stat-num">${orders.length}</div><div>Заказов всего</div></a>
      <a class="a-stat" href="/admin/catalog"><div class="a-stat-num">${shown}/${total}</div><div>Товаров показано</div></a>
      <a class="a-stat" href="/admin/settings"><div class="a-stat-num">×${esc(site.priceMultiplier || 1)}</div><div>Множитель цен</div></a>
    </div>
    <div class="a-panel"><div class="a-panel-head"><h2>Последние заказы</h2><a class="link" href="/admin/orders">Все →</a></div>
    <table class="a-table"><thead><tr><th>№</th><th>Дата</th><th>Контакт</th><th>Сумма</th></tr></thead><tbody>${recent}</tbody></table></div>`;
  return layout(site, { active: 'dash', title: 'Обзор · ' + site.storeName, body });
}

/* ---------- Товары и цены ---------- */
function catalogPage(db, site, flash) {
  const ss = T.siteSettings(site);
  const overrides = site.overrides || {};
  const rows = db.getProducts().map(p => {
    const ov = overrides[p.id] || {};
    const enabled = ov.enabled !== false;
    const sitePrice = T.sitePriceOf(p, site);
    return `<tr>
      <td class="a-thumb">${R.imageMarkup(p, 0)}</td>
      <td><b>${esc(p.name)}</b><br><span class="muted small">${esc(p.category)} · базовая ${R.money(p.price, ss)}</span></td>
      <td><label class="switch"><input type="checkbox" name="enabled_${p.id}" ${enabled ? 'checked' : ''}><span>показывать</span></label></td>
      <td><input class="price-inp" name="price_${p.id}" type="number" min="1" step="1" value="${ov.price != null && ov.price !== '' ? esc(ov.price) : ''}" placeholder="${sitePrice}"><div class="muted small">сейчас: ${R.money(sitePrice, ss)}</div></td>
    </tr>`;
  }).join('') || `<tr><td colspan="4" class="muted">Каталог пуст. Товары добавляет владелец.</td></tr>`;
  const body = `
  <form class="a-form" method="post" action="/admin/catalog">
    <p class="muted small">Каталог общий. Здесь вы задаёте, какие товары показывать на этом домене и по какой цене. Пустая цена = базовая × множитель (${esc(site.priceMultiplier || 1)}). Множитель меняется в «Настройках».</p>
    <div class="a-panel"><table class="a-table"><thead><tr><th></th><th>Товар</th><th>Видимость</th><th>Цена на этом сайте</th></tr></thead><tbody>${rows}</tbody></table></div>
    <div class="a-form-actions"><button class="btn btn-primary" type="submit">Сохранить</button></div>
  </form>`;
  return layout(site, { active: 'catalog', title: 'Товары и цены', flash, body });
}

/* ---------- Отзывы (видимость) ---------- */
function reviewsPage(db, site, flash, page) {
  const products = {}; db.getProducts().forEach(p => products[p.id] = p);
  const hidden = new Set(site.hiddenReviews || []);
  const approved = db.getReviews().filter(r => r.status === 'approved');
  // Страницами: список целиком весил мегабайты и надолго занимал единственный поток.
  const slice = R.adminSlice(approved, page);
  const pager = R.adminPager(slice, n => `/admin/reviews?page=${n}`);
  // Сохранение применяется только к отзывам этой страницы, поэтому их id уходят
  // в форму отдельным полем. Иначе переход на вторую страницу и «Сохранить»
  // спрятали бы все отзывы с первой — снятых галочек там нет, просто нет полей.
  const pageIds = slice.items.map(rv => rv.id).join(',');
  const rows = slice.items.map(rv => {
    const p = products[rv.productId];
    const show = !hidden.has(rv.id);
    const photos = (rv.photos || []).map(ph => `<a href="/uploads/${esc(ph)}" target="_blank" rel="noopener"><img src="/uploads/${esc(ph)}" alt=""></a>`).join('');
    return `<tr><td><label class="switch"><input type="checkbox" name="show_${rv.id}" ${show ? 'checked' : ''}><span>показывать</span></label></td>
      <td><div class="review-cell"><div class="rc-top"><b>${esc(rv.author)}</b> ${R.stars(rv.rating)} <span class="muted">${R.formatDate(rv.createdAt)}</span></div>
      <div class="muted small">${p ? esc(p.name) : '—'}</div>${rv.text ? `<div class="rc-text">${esc(rv.text)}</div>` : ''}${photos ? `<div class="rc-photos">${photos}</div>` : ''}</div></td></tr>`;
  }).join('') || `<tr><td colspan="2" class="muted">Опубликованных отзывов нет. Их добавляет и модерирует владелец.</td></tr>`;
  const body = `<form class="a-form" method="post" action="/admin/reviews">
    <input type="hidden" name="pageIds" value="${esc(pageIds)}">
    <input type="hidden" name="page" value="${slice.page}">
    <p class="muted small">Отзывы общие для всех доменов. Здесь вы решаете, какие из них показывать на этом сайте. Новые отзывы и модерацию ведёт владелец.</p>
    <p class="muted small">Сохранение применяется к отзывам текущей страницы — на других страницах видимость останется прежней.</p>
    <div class="a-panel"><table class="a-table"><thead><tr><th>Видимость</th><th>Отзыв</th></tr></thead><tbody>${rows}</tbody></table>${pager}</div>
    <div class="a-form-actions"><button class="btn btn-primary" type="submit">Сохранить</button></div>
  </form>`;
  return layout(site, { active: 'reviews', title: 'Отзывы на сайте', flash, body });
}

/* ---------- Заказы сайта ---------- */
function ordersList(db, site, flash) {
  const ss = T.siteSettings(site);
  const statuses = ['new', 'processing', 'done', 'cancelled'];
  const label = { new: 'Новый', processing: 'В работе', done: 'Выполнен', cancelled: 'Отменён' };
  const rows = db.ordersForSite(site.id).map(o => {
    const items = o.items.map(i => `${esc(i.name)} × ${i.qty}`).join('<br>');
    const sel = `<form method="post" action="/admin/orders/${o.id}/status" class="inline-form"><select name="status" onchange="this.form.submit()">${statuses.map(x => `<option value="${x}" ${o.status === x ? 'selected' : ''}>${label[x]}</option>`).join('')}</select></form>`;
    return `<tr id="order-${esc(o.id)}"><td><b>${esc(o.number)}</b><br><span class="muted small">${R.formatDate(o.createdAt)}</span></td>
      <td>${esc(o.customerName || '—')}<br><span class="muted">${esc(o.contact)}</span>${orderNote(o)}${clientMeta(o)}</td>
      <td class="small">${items}</td><td><b>${R.money(o.total, ss)}</b></td><td>${sel}</td>
      <td><form method="post" action="/admin/orders/${o.id}/delete" data-confirm="Удалить заказ?"><button class="btn btn-sm btn-danger">✕</button></form></td></tr>`;
  }).join('') || `<tr><td colspan="6" class="muted">Заказов пока нет.</td></tr>`;
  return layout(site, { active: 'orders', title: 'Заказы', flash, body: `<div class="a-panel"><table class="a-table"><thead><tr><th>Заказ</th><th>Клиент</th><th>Состав</th><th>Сумма</th><th>Статус</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>` });
}

// Адрес доставки, а у старых заявок — их комментарий: поле с витрины убрано,
// но прежние заказы должны читаться как раньше.
function orderNote(o) {
  return (o.address ? `<div class="muted small">📍 ${esc(o.address)}</div>` : '')
    + (o.comment ? `<div class="muted small">«${esc(o.comment)}»</div>` : '');
}

function clientMeta(o) {
  const place = [o.clientCity, o.clientRegion, o.clientCountry].filter(Boolean).filter((x, i, a) => a.indexOf(x) === i).join(', ');
  const device = [o.clientModel || o.clientDevice, o.clientOs, o.clientBrowser].filter(Boolean).join(' · ');
  if (!place && !device && !o.clientIp) return '';
  return `<div class="order-client-meta">${place ? `<span>⌖ ${esc(place)}</span>` : ''}${device ? `<span>◫ ${esc(device)}</span>` : ''}${o.clientIp ? `<span>IP ${esc(o.clientIp)}</span>` : ''}${o.clientSource && o.clientSource !== 'Внутренний переход' ? `<span>↗ ${esc(o.clientSource)}</span>` : ''}</div>`;
}

function analyticsPage(db, site, snapshot) {
  const products = {}; db.getProducts().forEach(p => { products[p.id] = p.name; });
  const body = AV.dashboard(snapshot, { products, rangeBase: '/admin/analytics?days=', ordersHref: '/admin/orders' });
  return layout(site, { active: 'analytics', title: 'Метрика · ' + site.storeName, body });
}

/* ---------- Настройки сайта ---------- */
function settingsPage(db, site, flash, flashType) {
  const s = site;
  const body = `<form class="a-form" method="post" enctype="multipart/form-data" action="/admin/settings">
    <div class="a-panel"><h2>Магазин</h2>
      <div class="a-form-grid">
        <div class="field"><label>Название магазина</label><input name="storeName" value="${esc(s.storeName)}"></div>
        <div class="field"><label>Слоган</label><input name="tagline" value="${esc(s.tagline)}"></div>
        <div class="field"><label>Акцентный цвет</label><input name="accentColor" type="color" value="${esc(s.accentColor)}"></div>
        <div class="field"><label>Валюта</label><input name="currency" value="${esc(s.currency)}"></div>
        <div class="field"><label>Позиция валюты</label><select name="currencyPosition"><option value="after" ${s.currencyPosition === 'after' ? 'selected' : ''}>После суммы</option><option value="before" ${s.currencyPosition === 'before' ? 'selected' : ''}>Перед суммой</option></select></div>
        <div class="field"><label>Множитель цен к базовым</label><input name="priceMultiplier" type="number" min="0.1" step="0.01" value="${esc(s.priceMultiplier || 1)}"></div>
      </div>
      <div class="a-form-grid">
        <div class="field"><label>Telegram для витрины</label><input name="contactTelegram" value="${esc(s.contactTelegram)}"></div>
        <div class="field"><label>Телефон</label><input name="contactPhone" value="${esc(s.contactPhone)}"></div>
      </div>
      <div class="field"><label>Текст в подвале</label><input name="footerNote" value="${esc(s.footerNote)}"></div>
    </div>
    <div class="a-panel"><h2>Персональные данные</h2>
      <div class="a-form-grid">
        <div class="field"><label>Оператор (ИП, ООО или ФИО)</label><input name="legalOperator" value="${esc(s.legalOperator || '')}"></div>
        <div class="field"><label>ИНН / ОГРН / ОГРНИП</label><input name="legalDetails" value="${esc(s.legalDetails || '')}"></div>
        <div class="field"><label>Адрес оператора</label><input name="legalAddress" value="${esc(s.legalAddress || '')}"></div>
        <div class="field"><label>E-mail для обращений по персональным данным</label><input name="privacyEmail" inputmode="email" value="${esc(s.privacyEmail || '')}"></div>
      </div>
    </div>
    ${R.brandFields(s)}
    <div class="a-panel"><h2>Telegram для заявок</h2>
      <div class="a-form-grid">
        <div class="field"><label>Токен бота</label><input name="telegramBotToken" value="${esc(s.telegramBotToken)}"></div>
        <div class="field"><label>Chat ID</label><input name="telegramChatId" value="${esc(s.telegramChatId)}"></div>
        <div class="field field-check"><label><input type="checkbox" name="notifyReviews" ${s.notifyReviews ? 'checked' : ''}> Уведомлять об отзывах</label></div>
      </div>
    </div>
    <div class="a-panel"><h2>Доступ в эту админку</h2>
      <div class="a-form-grid">
        <div class="field"><label>Логин</label><input name="adminUsername" value="${esc(s.adminUsername)}"></div>
        <div class="field"><label>Новый пароль (пусто — не менять)</label><input name="adminPassword" type="password" autocomplete="new-password" minlength="10" maxlength="500"><span class="muted small">Не менее 10 символов.</span></div>
      </div>
      <p class="muted small">Домены этого сайта меняет владелец в панели /owner.</p>
    </div>
    <div class="a-form-actions"><button class="btn btn-primary" type="submit">Сохранить</button></div>
  </form>`;
  return layout(site, { active: 'settings', title: 'Настройки сайта', flash, flashType, body });
}

module.exports = { loginPage, dashboard, catalogPage, reviewsPage, ordersList, analyticsPage, settingsPage };
