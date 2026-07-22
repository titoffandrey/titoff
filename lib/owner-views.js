'use strict';
// Панель ВЛАДЕЛЬЦА (/owner): общий каталог, модерация отзывов, управление доменами, все заказы.
const R = require('./render');
const esc = R.esc;

function dtLocal(ms) {
  if (!ms) return '';
  const d = new Date(Number(ms)); const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

function layout(opts) {
  opts = opts || {};
  const pending = opts.pendingCount || 0;
  const nav = [
    ['/owner', 'Обзор', 'dash'],
    ['/owner/products', 'Каталог', 'products'],
    ['/owner/reviews', 'Отзывы', 'reviews'],
    ['/owner/sites', 'Домены', 'sites'],
    ['/owner/orders', 'Заказы', 'orders'],
    ['/owner/settings', 'Настройки', 'settings']
  ].map(([href, label, key]) => {
    const badge = (key === 'reviews' && pending) ? `<span class="a-badge">${pending}</span>` : '';
    return `<a href="${href}" class="a-nav-item${opts.active === key ? ' active' : ''}">${label}${badge}</a>`;
  }).join('');
  return `<!DOCTYPE html><html lang="ru"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Владелец · ${esc(opts.title || '')}</title>
<link rel="stylesheet" href="/static/styles.css?v=${R.assetV('styles.css')}"><style>:root{--accent:#1d1d1f}</style></head>
<body class="admin">
<div class="a-shell">
  <aside class="a-sidebar">
    <div class="a-brand">Владелец<span>панель управления</span></div>
    <nav class="a-nav">${nav}</nav>
    <div class="a-nav-foot"><form action="/owner/logout" method="post"><button class="a-logout">Выйти</button></form></div>
  </aside>
  <main class="a-main">
    <div class="a-topbar"><h1>${esc(opts.title || '')}</h1>${opts.actions || ''}</div>
    ${opts.flash ? `<div class="a-flash ${esc(opts.flashType || 'ok')}">${esc(opts.flash)}</div>` : ''}
    <div class="a-content">${opts.body || ''}</div>
  </main>
</div>
<script>document.addEventListener('submit',function(e){var f=e.target;if(f.matches('[data-confirm]')&&!confirm(f.getAttribute('data-confirm')))e.preventDefault();});</script>
</body></html>`;
}

function loginPage(error) {
  return `<!DOCTYPE html><html lang="ru"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>Вход владельца</title>
<link rel="stylesheet" href="/static/styles.css?v=${R.assetV('styles.css')}"><style>:root{--accent:#1d1d1f}</style></head>
<body class="admin login-body">
<form class="login-card" method="post" action="/owner/login">
  <div class="login-brand">Панель владельца</div>
  <p class="muted">Управление каталогом и доменами</p>
  ${error ? `<div class="a-flash err">${esc(error)}</div>` : ''}
  <div class="field"><label>Логин</label><input name="username" autocomplete="username" required autofocus></div>
  <div class="field"><label>Пароль</label><input name="password" type="password" autocomplete="current-password" required></div>
  <button class="btn btn-primary btn-block" type="submit">Войти</button>
</form></body></html>`;
}

function dashboard(db) {
  const products = db.getProducts();
  const sites = db.getSites();
  const orders = db.getOrders();
  const pending = db.pendingReviewCount();
  const sitesById = {}; sites.forEach(s => sitesById[s.id] = s);
  const recent = orders.slice(0, 8).map(o => `<tr>
    <td><b>${esc(o.number)}</b></td>
    <td>${esc(o.siteName || (sitesById[o.siteId] && sitesById[o.siteId].storeName) || '—')}</td>
    <td>${R.formatDate(o.createdAt)}</td>
    <td>${esc(o.contact)}</td>
    <td>${R.money(o.total, { currency: '₽' })}</td>
  </tr>`).join('') || `<tr><td colspan="5" class="muted">Заказов пока нет</td></tr>`;
  const body = `
    <div class="a-cards">
      <a class="a-stat" href="/owner/products"><div class="a-stat-num">${products.length}</div><div>Товаров в каталоге</div></a>
      <a class="a-stat" href="/owner/sites"><div class="a-stat-num">${sites.length}</div><div>Доменов</div></a>
      <a class="a-stat" href="/owner/reviews?status=pending"><div class="a-stat-num">${pending}</div><div>Отзывов на модерации</div></a>
      <a class="a-stat" href="/owner/orders"><div class="a-stat-num">${orders.length}</div><div>Заказов всего</div></a>
    </div>
    <div class="a-panel"><div class="a-panel-head"><h2>Последние заказы</h2><a class="link" href="/owner/orders">Все →</a></div>
      <table class="a-table"><thead><tr><th>№</th><th>Домен</th><th>Дата</th><th>Контакт</th><th>Сумма</th></tr></thead><tbody>${recent}</tbody></table></div>`;
  return layout({ active: 'dash', title: 'Обзор', pendingCount: pending, body });
}

/* ---------- Каталог (мастер) ---------- */
function productsList(db, flash) {
  const rows = db.getProducts().map(p => {
    const r = db.ratingFor(p.id);
    return `<tr>
      <td class="a-thumb">${R.imageMarkup(p, 0)}</td>
      <td><b>${esc(p.name)}</b><br><span class="muted">${esc(p.category)}</span></td>
      <td>${R.money(p.price, { currency: '₽' })}<div class="muted small">базовая цена</div></td>
      <td>${p.hotDeal ? '<span class="pill ok">🔥 акция</span>' : ''} ${r.count ? `★ ${r.avg} (${r.count})` : ''}</td>
      <td class="a-actions">
        <a class="btn btn-sm" href="/owner/products/${p.id}/edit">Изменить</a>
        <a class="btn btn-sm" href="/owner/reviews/new?productId=${p.id}">+ Отзыв</a>
        <form method="post" action="/owner/products/${p.id}/delete" data-confirm="Удалить товар «${esc(p.name)}» из общего каталога?"><button class="btn btn-sm btn-danger">Удалить</button></form>
      </td></tr>`;
  }).join('') || `<tr><td colspan="5" class="muted">Каталог пуст.</td></tr>`;
  return layout({ active: 'products', title: 'Общий каталог', pendingCount: db.pendingReviewCount(),
    actions: `<a class="btn btn-primary" href="/owner/products/new">+ Добавить товар</a>`,
    flash, body: `<p class="muted small">Каталог общий для всех доменов. Цены и видимость на конкретном сайте настраиваются в админке этого домена.</p><div class="a-panel"><table class="a-table"><thead><tr><th></th><th>Товар</th><th>Базовая цена</th><th></th><th></th></tr></thead><tbody>${rows}</tbody></table></div>` });
}

function productForm(db, product) {
  const isEdit = !!product;
  const p = product || { name: '', category: '', price: '', oldPrice: '', badge: '', inStock: true, shortDesc: '', description: '', specs: '', images: [], hotDeal: false, hotDealPrice: '', hotDealUntil: null };
  const cats = db.categories();
  const existing = (p.images || []).map(src => `<label class="img-chip"><img src="/uploads/${esc(src)}" alt=""><span class="img-remove"><input type="checkbox" name="removeImages" value="${esc(src)}"> удалить</span></label>`).join('');
  const body = `
  <form class="a-form" method="post" action="${isEdit ? '/owner/products/' + product.id : '/owner/products'}" enctype="multipart/form-data">
    <div class="a-form-grid">
      <div class="field"><label>Название *</label><input name="name" value="${esc(p.name)}" required></div>
      <div class="field"><label>Категория *</label><input name="category" value="${esc(p.category)}" list="cats" required><datalist id="cats">${cats.map(c => `<option value="${esc(c)}">`).join('')}</datalist></div>
      <div class="field"><label>Базовая цена *</label><input name="price" type="number" min="0" step="1" value="${esc(p.price)}" required></div>
      <div class="field"><label>Старая цена (зачёркнутая)</label><input name="oldPrice" type="number" min="0" step="1" value="${esc(p.oldPrice || '')}"></div>
      <div class="field"><label>Плашка</label><input name="badge" value="${esc(p.badge || '')}"></div>
      <div class="field field-check"><label><input type="checkbox" name="inStock" ${p.inStock ? 'checked' : ''}> В наличии</label></div>
    </div>
    <div class="a-deal-box">
      <div class="field field-check"><label><input type="checkbox" name="hotDeal" ${p.hotDeal ? 'checked' : ''}> 🔥 Горящая скидка</label></div>
      <div class="a-form-grid">
        <div class="field"><label>Цена по акции</label><input name="hotDealPrice" type="number" min="0" step="1" value="${esc(p.hotDealPrice || '')}"></div>
        <div class="field"><label>Акция до</label><input name="hotDealUntil" type="datetime-local" value="${dtLocal(p.hotDealUntil)}"></div>
      </div>
      <p class="muted small">На сайтах с множителем цена акции тоже масштабируется.</p>
    </div>
    <div class="field"><label>Краткое описание</label><input name="shortDesc" value="${esc(p.shortDesc || '')}" maxlength="200"></div>
    <div class="field"><label>Полное описание</label><textarea name="description" rows="5">${esc(p.description || '')}</textarea></div>
    <div class="field"><label>Характеристики (строки «Параметр: значение»)</label><textarea name="specs" rows="6">${esc(p.specs || '')}</textarea></div>
    ${existing ? `<div class="field"><label>Текущие фото</label><div class="img-chips">${existing}</div></div>` : ''}
    <div class="field"><label>Добавить фото</label><input type="file" name="images" accept="image/*" multiple></div>
    <div class="a-form-actions"><button class="btn btn-primary" type="submit">${isEdit ? 'Сохранить' : 'Создать'}</button><a class="btn" href="/owner/products">Отмена</a></div>
  </form>`;
  return layout({ active: 'products', title: isEdit ? 'Товар' : 'Новый товар', pendingCount: db.pendingReviewCount(), body });
}

/* ---------- Отзывы (мастер) ---------- */
function reviewsList(db, statusFilter, flash) {
  const products = {}; db.getProducts().forEach(p => products[p.id] = p);
  let list = db.getReviews();
  if (statusFilter === 'pending') list = list.filter(r => r.status === 'pending');
  else if (statusFilter === 'approved') list = list.filter(r => r.status === 'approved');
  const tab = (k, l) => `<a class="a-tab${(statusFilter || 'all') === k ? ' active' : ''}" href="/owner/reviews?status=${k}">${l}</a>`;
  const rows = list.map(rv => {
    const p = products[rv.productId];
    const photos = (rv.photos || []).map(ph => `<a href="/uploads/${esc(ph)}" target="_blank"><img src="/uploads/${esc(ph)}" alt=""></a>`).join('');
    const act = rv.status === 'pending'
      ? `<form method="post" action="/owner/reviews/${rv.id}/approve"><button class="btn btn-sm btn-primary">Одобрить</button></form>`
      : `<span class="pill ok">Опубликован</span>`;
    return `<tr><td><div class="review-cell"><div class="rc-top"><b>${esc(rv.author)}</b> ${R.stars(rv.rating)} <span class="muted">${R.formatDate(rv.createdAt)}</span></div>
      <div class="muted">${p ? esc(p.name) : '— товар удалён —'}</div>${rv.text ? `<div class="rc-text">${esc(rv.text)}</div>` : ''}${photos ? `<div class="rc-photos">${photos}</div>` : ''}</div></td>
      <td class="a-actions">${act}<form method="post" action="/owner/reviews/${rv.id}/delete" data-confirm="Удалить отзыв?"><button class="btn btn-sm btn-danger">Удалить</button></form></td></tr>`;
  }).join('') || `<tr><td colspan="2" class="muted">Отзывов нет.</td></tr>`;
  return layout({ active: 'reviews', title: 'Отзывы', pendingCount: db.pendingReviewCount(),
    actions: `<a class="btn btn-primary" href="/owner/reviews/new">+ Добавить отзыв</a>`,
    flash, body: `<p class="muted small">Отзывы общие для всех доменов. На конкретном сайте их можно скрыть в его админке.</p><div class="a-tabs">${tab('all', 'Все')}${tab('pending', 'На модерации')}${tab('approved', 'Опубликованные')}</div><div class="a-panel"><table class="a-table"><tbody>${rows}</tbody></table></div>` });
}

function addReviewForm(db, presetProductId, flash) {
  const options = db.getProducts().map(p => `<option value="${p.id}" ${presetProductId === p.id ? 'selected' : ''}>${esc(p.name)}</option>`).join('');
  const body = `<form class="a-form" method="post" action="/owner/reviews/new" enctype="multipart/form-data">
    <div class="a-form-grid">
      <div class="field"><label>Товар *</label><select name="productId" required>${options}</select></div>
      <div class="field"><label>Оценка</label><select name="rating">${[5,4,3,2,1].map(v => `<option value="${v}" ${v === 5 ? 'selected' : ''}>${'★'.repeat(v)} (${v})</option>`).join('')}</select></div>
      <div class="field"><label>Имя автора</label><input name="author" required></div>
      <div class="field"><label>Дата</label><input name="date" type="date"></div>
    </div>
    <div class="field"><label>Текст</label><textarea name="text" rows="4"></textarea></div>
    <div class="field"><label>Фото</label><input type="file" name="photos" accept="image/*" multiple></div>
    <div class="a-form-actions"><button class="btn btn-primary" type="submit">Опубликовать</button><a class="btn" href="/owner/reviews">Отмена</a></div>
  </form>`;
  return layout({ active: 'reviews', title: 'Добавить отзыв', pendingCount: db.pendingReviewCount(), flash, body });
}

/* ---------- Домены ---------- */
function sitesList(db, flash) {
  const rows = db.getSites().map(s => {
    const open = (s.hosts && s.hosts[0]) ? `http://${esc(s.hosts[0])}` : `/?site=${s.id}`;
    return `<tr>
      <td><b>${esc(s.storeName)}</b><br><span class="muted small">${(s.hosts || []).map(esc).join(', ') || 'домен не задан'}</span></td>
      <td><span class="swatch" style="background:${esc(s.accentColor)}"></span> ×${esc(s.priceMultiplier || 1)}</td>
      <td class="muted small">логин: ${esc(s.adminUsername)}</td>
      <td class="a-actions">
        <a class="btn btn-sm" href="${open}" target="_blank">Открыть ↗</a>
        <a class="btn btn-sm" href="/owner/sites/${s.id}/edit">Изменить</a>
        <form method="post" action="/owner/sites/${s.id}/delete" data-confirm="Удалить домен «${esc(s.storeName)}»?"><button class="btn btn-sm btn-danger">Удалить</button></form>
      </td></tr>`;
  }).join('') || `<tr><td colspan="4" class="muted">Доменов нет.</td></tr>`;
  return layout({ active: 'sites', title: 'Домены', pendingCount: db.pendingReviewCount(),
    actions: `<a class="btn btn-primary" href="/owner/sites/new">+ Добавить домен</a>`,
    flash, body: `<div class="a-panel"><table class="a-table"><thead><tr><th>Магазин</th><th>Оформление</th><th>Админ</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>` });
}

function siteForm(db, site) {
  const isEdit = !!site;
  const s = site || { hosts: [], storeName: '', tagline: '', accentColor: '#0071e3', currency: '₽', currencyPosition: 'after', contactTelegram: '', contactPhone: '', footerNote: '', telegramBotToken: '', telegramChatId: '', notifyReviews: true, priceMultiplier: 1, adminUsername: 'admin', logoImage: null, logoText: '', logoFont: 'system', secondaryColor: '' };
  const body = `<form class="a-form" method="post" enctype="multipart/form-data" action="${isEdit ? '/owner/sites/' + site.id : '/owner/sites'}">
    <div class="a-panel"><h2>Домены и бренд</h2>
      <div class="field"><label>Домены (через запятую или с новой строки)</label><textarea name="hosts" rows="2" placeholder="shop1.ru, www.shop1.ru">${esc((s.hosts || []).join(', '))}</textarea></div>
      <div class="a-form-grid">
        <div class="field"><label>Название магазина *</label><input name="storeName" value="${esc(s.storeName)}" required></div>
        <div class="field"><label>Слоган</label><input name="tagline" value="${esc(s.tagline)}"></div>
        <div class="field"><label>Акцентный цвет</label><input name="accentColor" type="color" value="${esc(s.accentColor)}"></div>
        <div class="field"><label>Валюта</label><input name="currency" value="${esc(s.currency)}"></div>
        <div class="field"><label>Позиция валюты</label><select name="currencyPosition"><option value="after" ${s.currencyPosition === 'after' ? 'selected' : ''}>После (1000 ₽)</option><option value="before" ${s.currencyPosition === 'before' ? 'selected' : ''}>Перед ($1000)</option></select></div>
        <div class="field"><label>Множитель цен</label><input name="priceMultiplier" type="number" min="0.1" step="0.01" value="${esc(s.priceMultiplier || 1)}"></div>
      </div>
      <div class="a-form-grid">
        <div class="field"><label>Telegram для витрины</label><input name="contactTelegram" value="${esc(s.contactTelegram)}"></div>
        <div class="field"><label>Телефон</label><input name="contactPhone" value="${esc(s.contactPhone)}"></div>
      </div>
      <div class="field"><label>Текст в подвале</label><input name="footerNote" value="${esc(s.footerNote)}"></div>
    </div>
    ${R.brandFields(s)}
    <div class="a-panel"><h2>Telegram для заявок этого домена</h2>
      <div class="a-form-grid">
        <div class="field"><label>Токен бота</label><input name="telegramBotToken" value="${esc(s.telegramBotToken)}"></div>
        <div class="field"><label>Chat ID</label><input name="telegramChatId" value="${esc(s.telegramChatId)}"></div>
        <div class="field field-check"><label><input type="checkbox" name="notifyReviews" ${s.notifyReviews ? 'checked' : ''}> Уведомлять об отзывах</label></div>
      </div>
    </div>
    <div class="a-panel"><h2>Доступ в админку этого домена</h2>
      <div class="a-form-grid">
        <div class="field"><label>Логин</label><input name="adminUsername" value="${esc(s.adminUsername)}"></div>
        <div class="field"><label>${isEdit ? 'Новый пароль (пусто — не менять)' : 'Пароль'}</label><input name="adminPassword" type="password" autocomplete="new-password" ${isEdit ? '' : 'placeholder="по умолчанию admin"'}></div>
      </div>
    </div>
    <div class="a-form-actions"><button class="btn btn-primary" type="submit">${isEdit ? 'Сохранить' : 'Создать домен'}</button><a class="btn" href="/owner/sites">Отмена</a></div>
  </form>`;
  return layout({ active: 'sites', title: isEdit ? 'Домен: ' + s.storeName : 'Новый домен', pendingCount: db.pendingReviewCount(), body });
}

/* ---------- Заказы (все) ---------- */
function ordersList(db, flash) {
  const statuses = ['new', 'processing', 'done', 'cancelled'];
  const label = { new: 'Новый', processing: 'В работе', done: 'Выполнен', cancelled: 'Отменён' };
  const sites = {}; db.getSites().forEach(s => sites[s.id] = s);
  const rows = db.getOrders().map(o => {
    const items = o.items.map(i => `${esc(i.name)} × ${i.qty}`).join('<br>');
    const sel = `<form method="post" action="/owner/orders/${o.id}/status" class="inline-form"><select name="status" onchange="this.form.submit()">${statuses.map(x => `<option value="${x}" ${o.status === x ? 'selected' : ''}>${label[x]}</option>`).join('')}</select></form>`;
    return `<tr><td><b>${esc(o.number)}</b><br><span class="muted small">${R.formatDate(o.createdAt)}</span></td>
      <td>${esc(o.siteName || (sites[o.siteId] && sites[o.siteId].storeName) || '—')}</td>
      <td>${esc(o.customerName || '—')}<br><span class="muted">${esc(o.contact)}</span></td>
      <td class="small">${items}</td><td><b>${R.money(o.total, { currency: '₽' })}</b></td><td>${sel}</td>
      <td><form method="post" action="/owner/orders/${o.id}/delete" data-confirm="Удалить заказ?"><button class="btn btn-sm btn-danger">✕</button></form></td></tr>`;
  }).join('') || `<tr><td colspan="7" class="muted">Заказов нет.</td></tr>`;
  return layout({ active: 'orders', title: 'Все заказы', pendingCount: db.pendingReviewCount(), flash,
    body: `<div class="a-panel"><table class="a-table"><thead><tr><th>Заказ</th><th>Домен</th><th>Клиент</th><th>Состав</th><th>Сумма</th><th>Статус</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>` });
}

function settingsPage(settings, db, flash) {
  const body = `<form class="a-form" method="post" action="/owner/settings">
    <div class="a-panel"><h2>Доступ владельца</h2>
      <div class="a-form-grid">
        <div class="field"><label>Логин</label><input name="ownerUsername" value="${esc(settings.ownerUsername)}"></div>
        <div class="field"><label>Новый пароль (пусто — не менять)</label><input name="ownerPassword" type="password" autocomplete="new-password"></div>
      </div>
      <p class="muted small">Панель владельца открывается по адресу <b>/owner</b> и не зависит от домена.</p>
    </div>
    <div class="a-form-actions"><button class="btn btn-primary" type="submit">Сохранить</button></div>
  </form>`;
  return layout({ active: 'settings', title: 'Настройки владельца', pendingCount: db.pendingReviewCount(), flash, body });
}

module.exports = { loginPage, dashboard, productsList, productForm, reviewsList, addReviewForm, sitesList, siteForm, ordersList, settingsPage };
