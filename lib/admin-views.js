'use strict';
// Рендер админ-панели.
const R = require('./render');
const esc = R.esc;

// timestamp (мс) -> строка для поля <input type="datetime-local"> ("YYYY-MM-DDTHH:MM").
function dtLocal(ms) {
  if (!ms) return '';
  const d = new Date(Number(ms));
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

function adminLayout(settings, opts) {
  opts = opts || {};
  const pending = opts.pendingCount || 0;
  const nav = [
    ['/admin', 'Обзор', 'dash'],
    ['/admin/products', 'Товары', 'products'],
    ['/admin/reviews', 'Отзывы', 'reviews'],
    ['/admin/orders', 'Заказы', 'orders'],
    ['/admin/settings', 'Настройки', 'settings']
  ].map(([href, label, key]) => {
    const badge = (key === 'reviews' && pending) ? `<span class="a-badge">${pending}</span>` : '';
    return `<a href="${href}" class="a-nav-item${opts.active === key ? ' active' : ''}">${label}${badge}</a>`;
  }).join('');

  return `<!DOCTYPE html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Админ · ${esc(settings.storeName)}</title>
<link rel="stylesheet" href="/static/styles.css">
<style>:root{--accent:${esc(settings.accentColor || '#0071e3')}}</style>
</head>
<body class="admin">
<div class="a-shell">
  <aside class="a-sidebar">
    <div class="a-brand">${esc(settings.storeName)}<span>админка</span></div>
    <nav class="a-nav">${nav}</nav>
    <div class="a-nav-foot">
      <a href="/" target="_blank" class="a-nav-item">Открыть сайт ↗</a>
      <form action="/admin/logout" method="post"><button class="a-logout">Выйти</button></form>
    </div>
  </aside>
  <main class="a-main">
    <div class="a-topbar"><h1>${esc(opts.title || '')}</h1>${opts.actions || ''}</div>
    ${opts.flash ? `<div class="a-flash ${esc(opts.flashType || 'ok')}">${esc(opts.flash)}</div>` : ''}
    <div class="a-content">${opts.body || ''}</div>
  </main>
</div>
<script>
// подтверждение удаления
document.addEventListener('submit', function(e){
  const f = e.target;
  if (f.matches('[data-confirm]') && !confirm(f.getAttribute('data-confirm'))) e.preventDefault();
});
// переключение вкладок статуса отзывов
</script>
</body>
</html>`;
}

function loginPage(settings, error) {
  return `<!DOCTYPE html><html lang="ru"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Вход · ${esc(settings.storeName)}</title>
<link rel="stylesheet" href="/static/styles.css">
<style>:root{--accent:${esc(settings.accentColor || '#0071e3')}}</style></head>
<body class="admin login-body">
<form class="login-card" method="post" action="/admin/login">
  <div class="login-brand">${esc(settings.storeName)}</div>
  <p class="muted">Панель администратора</p>
  ${error ? `<div class="a-flash err">${esc(error)}</div>` : ''}
  <div class="field"><label>Логин</label><input name="username" autocomplete="username" required autofocus></div>
  <div class="field"><label>Пароль</label><input name="password" type="password" autocomplete="current-password" required></div>
  <button class="btn btn-primary btn-block" type="submit">Войти</button>
</form>
</body></html>`;
}

function dashboard(settings, db) {
  const products = db.getProducts();
  const orders = db.getOrders();
  const pending = db.pendingReviewCount();
  const newOrders = orders.filter(o => o.status === 'new').length;
  const recent = orders.slice(0, 6).map(o => `
    <tr>
      <td><b>${esc(o.number)}</b></td>
      <td>${R.formatDate(o.createdAt)}</td>
      <td>${esc(o.customerName || '—')}<br><span class="muted">${esc(o.contact)}</span></td>
      <td>${o.items.reduce((a, i) => a + i.qty, 0)} шт.</td>
      <td>${R.money(o.total, settings)}</td>
    </tr>`).join('') || `<tr><td colspan="5" class="muted">Заказов пока нет</td></tr>`;

  const body = `
    <div class="a-cards">
      <a class="a-stat" href="/admin/products"><div class="a-stat-num">${products.length}</div><div>Товаров</div></a>
      <a class="a-stat" href="/admin/reviews?status=pending"><div class="a-stat-num">${pending}</div><div>Отзывов на модерации</div></a>
      <a class="a-stat" href="/admin/orders"><div class="a-stat-num">${newOrders}</div><div>Новых заказов</div></a>
      <a class="a-stat" href="/admin/orders"><div class="a-stat-num">${orders.length}</div><div>Всего заказов</div></a>
    </div>
    <div class="a-panel">
      <div class="a-panel-head"><h2>Последние заказы</h2><a href="/admin/orders" class="link">Все заказы →</a></div>
      <table class="a-table"><thead><tr><th>№</th><th>Дата</th><th>Клиент</th><th>Кол-во</th><th>Сумма</th></tr></thead><tbody>${recent}</tbody></table>
    </div>`;
  return adminLayout(settings, { active: 'dash', title: 'Обзор', pendingCount: pending, body });
}

function productsList(settings, db, flash) {
  const rows = db.getProducts().map(p => {
    const r = db.ratingFor(p.id);
    return `<tr>
      <td class="a-thumb">${R.imageMarkup(p, 0)}</td>
      <td><b>${esc(p.name)}</b><br><span class="muted">${esc(p.category)}</span></td>
      <td>${R.money(p.price, settings)}</td>
      <td>${p.inStock ? '<span class="pill ok">В наличии</span>' : '<span class="pill muted">Нет</span>'}</td>
      <td>${r.count ? `★ ${r.avg} (${r.count})` : '—'}</td>
      <td class="a-actions">
        <a class="btn btn-sm" href="/admin/products/${p.id}/edit">Изменить</a>
        <a class="btn btn-sm" href="/admin/reviews/new?productId=${p.id}">+ Отзыв</a>
        <form method="post" action="/admin/products/${p.id}/delete" data-confirm="Удалить товар «${esc(p.name)}» и все его отзывы?">
          <button class="btn btn-sm btn-danger">Удалить</button>
        </form>
      </td>
    </tr>`;
  }).join('') || `<tr><td colspan="6" class="muted">Товаров нет. Добавьте первый.</td></tr>`;

  const body = `<div class="a-panel"><table class="a-table a-products"><thead><tr><th></th><th>Товар</th><th>Цена</th><th>Наличие</th><th>Рейтинг</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>`;
  return adminLayout(settings, {
    active: 'products', title: 'Товары', pendingCount: db.pendingReviewCount(),
    actions: `<a class="btn btn-primary" href="/admin/products/new">+ Добавить товар</a>`,
    flash, body
  });
}

function productForm(settings, db, product) {
  const isEdit = !!product;
  const p = product || { name: '', category: '', price: '', oldPrice: '', badge: '', inStock: true, shortDesc: '', description: '', specs: '', images: [], hotDeal: false, hotDealPrice: '', hotDealUntil: null };
  const cats = db.categories();
  const existing = (p.images || []).map((src, i) => `
    <label class="img-chip">
      <img src="/uploads/${esc(src)}" alt="">
      <span class="img-remove"><input type="checkbox" name="removeImages" value="${esc(src)}"> удалить</span>
    </label>`).join('');

  const body = `
  <form class="a-form" method="post" action="${isEdit ? '/admin/products/' + product.id : '/admin/products'}" enctype="multipart/form-data">
    <div class="a-form-grid">
      <div class="field"><label>Название *</label><input name="name" value="${esc(p.name)}" required></div>
      <div class="field"><label>Категория *</label>
        <input name="category" value="${esc(p.category)}" list="cats" required>
        <datalist id="cats">${cats.map(c => `<option value="${esc(c)}">`).join('')}</datalist>
      </div>
      <div class="field"><label>Цена *</label><input name="price" type="number" min="0" step="1" value="${esc(p.price)}" required></div>
      <div class="field"><label>Старая цена (для скидки)</label><input name="oldPrice" type="number" min="0" step="1" value="${esc(p.oldPrice || '')}"></div>
      <div class="field"><label>Плашка (напр. «Хит», «−15%»)</label><input name="badge" value="${esc(p.badge || '')}"></div>
      <div class="field field-check"><label><input type="checkbox" name="inStock" ${p.inStock ? 'checked' : ''}> В наличии</label></div>
    </div>
    <div class="a-deal-box">
      <div class="field field-check"><label><input type="checkbox" name="hotDeal" ${p.hotDeal ? 'checked' : ''}> 🔥 Участвует в горящих скидках</label></div>
      <div class="a-form-grid">
        <div class="field"><label>Цена по акции (пусто — обычная цена)</label><input name="hotDealPrice" type="number" min="0" step="1" value="${esc(p.hotDealPrice || '')}"></div>
        <div class="field"><label>Акция действует до</label><input name="hotDealUntil" type="datetime-local" value="${dtLocal(p.hotDealUntil)}"></div>
      </div>
      <p class="muted small">Пока стоит галочка и не наступила дата окончания, товар показывается в блоке «Горящие скидки» с таймером обратного отсчёта. Если дату не указать — акция бессрочная.</p>
    </div>
    <div class="field"><label>Краткое описание</label><input name="shortDesc" value="${esc(p.shortDesc || '')}" maxlength="200"></div>
    <div class="field"><label>Полное описание</label><textarea name="description" rows="5">${esc(p.description || '')}</textarea></div>
    <div class="field"><label>Характеристики (по одной в строке, формат «Параметр: значение»)</label><textarea name="specs" rows="6" placeholder="Экран: 6.1&quot;&#10;Память: 256 ГБ">${esc(p.specs || '')}</textarea></div>
    ${existing ? `<div class="field"><label>Текущие фото</label><div class="img-chips">${existing}</div></div>` : ''}
    <div class="field"><label>Добавить фото</label><input type="file" name="images" accept="image/*" multiple></div>
    <div class="a-form-actions">
      <button class="btn btn-primary" type="submit">${isEdit ? 'Сохранить' : 'Создать товар'}</button>
      <a class="btn" href="/admin/products">Отмена</a>
    </div>
  </form>`;
  return adminLayout(settings, {
    active: 'products', title: isEdit ? 'Редактирование товара' : 'Новый товар',
    pendingCount: db.pendingReviewCount(), body
  });
}

function reviewsList(settings, db, statusFilter, flash) {
  const products = {};
  db.getProducts().forEach(p => products[p.id] = p);
  let list = db.getReviews();
  if (statusFilter === 'pending') list = list.filter(r => r.status === 'pending');
  else if (statusFilter === 'approved') list = list.filter(r => r.status === 'approved');

  const tab = (key, label) => `<a class="a-tab${(statusFilter || 'all') === key ? ' active' : ''}" href="/admin/reviews?status=${key}">${label}</a>`;

  const rows = list.map(rv => {
    const p = products[rv.productId];
    const photos = (rv.photos || []).map(ph => `<a href="/uploads/${esc(ph)}" target="_blank"><img src="/uploads/${esc(ph)}" alt=""></a>`).join('');
    const actions = rv.status === 'pending'
      ? `<form method="post" action="/admin/reviews/${rv.id}/approve"><button class="btn btn-sm btn-primary">Одобрить</button></form>`
      : `<span class="pill ok">Опубликован</span>`;
    return `<tr>
      <td>
        <div class="review-cell">
          <div class="rc-top"><b>${esc(rv.author)}</b> ${R.stars(rv.rating)} <span class="muted">${R.formatDate(rv.createdAt)}</span></div>
          <div class="muted">${p ? esc(p.name) : '— товар удалён —'}</div>
          ${rv.text ? `<div class="rc-text">${esc(rv.text)}</div>` : ''}
          ${photos ? `<div class="rc-photos">${photos}</div>` : ''}
        </div>
      </td>
      <td class="a-actions">
        ${actions}
        <form method="post" action="/admin/reviews/${rv.id}/delete" data-confirm="Удалить отзыв?"><button class="btn btn-sm btn-danger">Удалить</button></form>
      </td>
    </tr>`;
  }).join('') || `<tr><td colspan="2" class="muted">Отзывов нет.</td></tr>`;

  const body = `
    <div class="a-tabs">${tab('all', 'Все')}${tab('pending', 'На модерации')}${tab('approved', 'Опубликованные')}</div>
    <div class="a-panel"><table class="a-table"><tbody>${rows}</tbody></table></div>`;
  return adminLayout(settings, {
    active: 'reviews', title: 'Отзывы', pendingCount: db.pendingReviewCount(),
    actions: `<a class="btn btn-primary" href="/admin/reviews/new">+ Добавить отзыв</a>`,
    flash, body
  });
}

function addReviewForm(settings, db, presetProductId, flash) {
  const products = db.getProducts();
  const options = products.map(p => `<option value="${p.id}" ${presetProductId === p.id ? 'selected' : ''}>${esc(p.name)}</option>`).join('');
  const body = `
  <form class="a-form" method="post" action="/admin/reviews/new" enctype="multipart/form-data">
    <div class="a-form-grid">
      <div class="field"><label>Товар *</label><select name="productId" required>${options}</select></div>
      <div class="field"><label>Оценка</label>
        <select name="rating">${[5,4,3,2,1].map(v => `<option value="${v}" ${v === 5 ? 'selected' : ''}>${'★'.repeat(v)} (${v})</option>`).join('')}</select>
      </div>
      <div class="field"><label>Имя автора</label><input name="author" placeholder="Например, Алексей" required></div>
      <div class="field"><label>Дата (необязательно)</label><input name="date" type="date"></div>
    </div>
    <div class="field"><label>Текст отзыва</label><textarea name="text" rows="4" placeholder="Текст отзыва"></textarea></div>
    <div class="field"><label>Фото (необязательно)</label><input type="file" name="photos" accept="image/*" multiple></div>
    <div class="a-form-actions">
      <button class="btn btn-primary" type="submit">Опубликовать отзыв</button>
      <a class="btn" href="/admin/reviews">Отмена</a>
    </div>
    <p class="muted small">Отзыв публикуется сразу и отображается на странице товара наравне с остальными.</p>
  </form>`;
  return adminLayout(settings, {
    active: 'reviews', title: 'Добавить отзыв', pendingCount: db.pendingReviewCount(), flash, body
  });
}

function ordersList(settings, db, flash) {
  const statuses = ['new', 'processing', 'done', 'cancelled'];
  const label = { new: 'Новый', processing: 'В работе', done: 'Выполнен', cancelled: 'Отменён' };
  const rows = db.getOrders().map(o => {
    const items = o.items.map(i => `${esc(i.name)} × ${i.qty}`).join('<br>');
    const sel = `<form method="post" action="/admin/orders/${o.id}/status" class="inline-form">
      <select name="status" onchange="this.form.submit()">${statuses.map(s => `<option value="${s}" ${o.status === s ? 'selected' : ''}>${label[s]}</option>`).join('')}</select>
    </form>`;
    return `<tr>
      <td><b>${esc(o.number)}</b><br><span class="muted">${R.formatDate(o.createdAt)}</span></td>
      <td>${esc(o.customerName || '—')}<br><span class="muted">${esc(o.contact)}</span>${o.comment ? `<div class="muted small">«${esc(o.comment)}»</div>` : ''}</td>
      <td class="small">${items}</td>
      <td><b>${R.money(o.total, settings)}</b></td>
      <td>${sel}</td>
      <td><form method="post" action="/admin/orders/${o.id}/delete" data-confirm="Удалить заказ?"><button class="btn btn-sm btn-danger">✕</button></form></td>
    </tr>`;
  }).join('') || `<tr><td colspan="6" class="muted">Заказов пока нет.</td></tr>`;
  const body = `<div class="a-panel"><table class="a-table"><thead><tr><th>Заказ</th><th>Клиент</th><th>Состав</th><th>Сумма</th><th>Статус</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>`;
  return adminLayout(settings, { active: 'orders', title: 'Заказы', pendingCount: db.pendingReviewCount(), flash, body });
}

function settingsPage(settings, db, flash, flashType) {
  const s = settings;
  const tgState = (s.telegramBotToken && s.telegramChatId)
    ? '<span class="pill ok">Настроен</span>' : '<span class="pill muted">Не настроен</span>';
  const body = `
  <form class="a-form" method="post" action="/admin/settings">
    <div class="a-panel">
      <h2>Магазин</h2>
      <div class="a-form-grid">
        <div class="field"><label>Название магазина</label><input name="storeName" value="${esc(s.storeName)}"></div>
        <div class="field"><label>Слоган</label><input name="tagline" value="${esc(s.tagline)}"></div>
        <div class="field"><label>Валюта</label><input name="currency" value="${esc(s.currency)}"></div>
        <div class="field"><label>Позиция валюты</label>
          <select name="currencyPosition">
            <option value="after" ${s.currencyPosition === 'after' ? 'selected' : ''}>После суммы (1000 ₽)</option>
            <option value="before" ${s.currencyPosition === 'before' ? 'selected' : ''}>Перед суммой ($1000)</option>
          </select>
        </div>
        <div class="field"><label>Акцентный цвет</label><input name="accentColor" type="color" value="${esc(s.accentColor)}"></div>
        <div class="field"><label>Telegram для витрины (@username)</label><input name="contactTelegram" value="${esc(s.contactTelegram)}"></div>
        <div class="field"><label>Телефон для витрины</label><input name="contactPhone" value="${esc(s.contactPhone)}"></div>
      </div>
      <div class="field"><label>Текст в подвале</label><input name="footerNote" value="${esc(s.footerNote)}"></div>
    </div>

    <div class="a-panel">
      <h2>Telegram-бот для заявок ${tgState}</h2>
      <p class="muted small">Заявки с заказами и (по желанию) новые отзывы приходят в этот чат. Как получить токен и chat_id — см. README.</p>
      <div class="a-form-grid">
        <div class="field"><label>Токен бота</label><input name="telegramBotToken" value="${esc(s.telegramBotToken)}" placeholder="123456:ABC-..."></div>
        <div class="field"><label>Chat ID менеджера</label><input name="telegramChatId" value="${esc(s.telegramChatId)}" placeholder="напр. 123456789"></div>
        <div class="field field-check"><label><input type="checkbox" name="notifyReviews" ${s.notifyReviews ? 'checked' : ''}> Уведомлять о новых отзывах</label></div>
      </div>
      <button class="btn" type="submit" formaction="/admin/settings/test-telegram">Отправить тестовое сообщение</button>
    </div>

    <div class="a-panel">
      <h2>Доступ администратора</h2>
      <div class="a-form-grid">
        <div class="field"><label>Логин</label><input name="adminUsername" value="${esc(s.adminUsername)}"></div>
        <div class="field"><label>Новый пароль (оставьте пустым, чтобы не менять)</label><input name="newPassword" type="password" autocomplete="new-password"></div>
      </div>
    </div>

    <div class="a-form-actions"><button class="btn btn-primary" type="submit">Сохранить настройки</button></div>
  </form>`;
  return adminLayout(settings, { active: 'settings', title: 'Настройки', pendingCount: db.pendingReviewCount(), flash, flashType, body });
}

module.exports = {
  loginPage, dashboard, productsList, productForm,
  reviewsList, addReviewForm, ordersList, settingsPage
};
