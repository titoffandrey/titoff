'use strict';
// Панель администратора (/admin) — единственная и с полными правами: каталог,
// модерация отзывов, заказы, метрика и все настройки магазина.
//
// Раньше панелей было две: владелец правил общий каталог, а администратор
// домена — цены и видимость на своём сайте. Домен остался один, разделять права
// стало не с кем, и обе панели слились в эту.
const R = require('./render');
const AV = require('./analytics-view');
const PAY = require('./pay-methods');
const DELIVERY = require('./delivery');
const esc = R.esc;

// Начало адреса карточки посетителя. Одно место на панель: этот же адрес стоит
// у IP в строке заказа и у строки в таблице метрики.
const VISITOR_BASE = '/admin/analytics/visitor/';

function dtLocal(ms) {
  if (!ms) return '';
  const d = new Date(Number(ms)); const p = n => String(n).padStart(2, '0');
  if (Number.isNaN(d.getTime())) return '';
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

// Панель красится акцентным цветом магазина: он и так уже настраивается, а
// раньше владелец сидел на жёстко зашитом графите просто потому, что панель
// была общей на все домены.
function shellStyle(settings) {
  return `<style>:root{--accent:${R.cssColor(settings && settings.accentColor, '#1d1d1f')}}</style>`;
}

function layout(settings, opts) {
  opts = opts || {};
  const accessibleBody = R.accessibleFields(opts.body || '', 'admin-field');
  const pending = opts.pendingCount || 0;
  const nav = [
    ['/admin', 'Обзор', 'dash'],
    ['/admin/products', 'Каталог', 'products'],
    ['/admin/reviews', 'Отзывы', 'reviews'],
    ['/admin/orders', 'Заказы', 'orders'],
    ['/admin/analytics', 'Метрика', 'analytics'],
    ['/admin/settings', 'Настройки', 'settings']
  ].map(([href, label, key]) => {
    const badge = (key === 'reviews' && pending) ? `<span class="a-badge">${pending}</span>` : '';
    return `<a href="${href}" class="a-nav-item${opts.active === key ? ' active' : ''}"${opts.active === key ? ' aria-current="page"' : ''}>${R.adminIcon(key)}<span>${label}</span>${badge}</a>`;
  }).join('');
  return `<!DOCTYPE html><html lang="ru"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(settings.storeName || 'Магазин')} · ${esc(opts.title || '')}</title>
<meta name="robots" content="noindex, nofollow">
<link rel="stylesheet" href="/static/styles.css?v=${R.assetV('styles.css')}">${shellStyle(settings)}
${R.ADMIN_NAV_BOOT}</head>
<body class="admin">
<div class="a-shell">
  <aside class="a-sidebar" id="a-sidebar">
    <div class="a-brand">${esc(settings.storeName || 'Магазин')}<span>панель управления</span></div>
    <nav class="a-nav">${nav}</nav>
    <div class="a-nav-foot">
      <a class="a-nav-item" href="/" target="_blank" rel="noopener noreferrer">Открыть витрину ↗</a>
      <form action="/admin/logout" method="post"><button class="a-logout">Выйти</button></form>
    </div>
  </aside>
  <main class="a-main">
    <div class="a-topbar">${R.adminNavToggle()}<h1>${esc(opts.title || '')}</h1>${opts.actions || ''}</div>
    ${opts.flash ? `<div class="a-flash ${esc(opts.flashType || 'ok')}">${esc(opts.flash)}</div>` : ''}
    <div class="a-content${opts.wide ? ' a-content-wide' : ''}">${accessibleBody}</div>
  </main>
</div>
<script>document.addEventListener('submit',function(e){var f=e.target;if(f.matches('[data-confirm]')&&!confirm(f.getAttribute('data-confirm')))e.preventDefault();});</script>
<script src="/static/admin-ui.js?v=${R.assetV('admin-ui.js')}" defer></script>
</body></html>`;
}

function loginPage(settings, error) {
  return `<!DOCTYPE html><html lang="ru"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>Вход · ${esc(settings.storeName || 'Магазин')}</title>
<meta name="robots" content="noindex, nofollow">
<link rel="stylesheet" href="/static/styles.css?v=${R.assetV('styles.css')}">${shellStyle(settings)}</head>
<body class="admin login-body">
<form class="login-card" method="post" action="/admin/login">
  <div class="login-brand">${esc(settings.storeName || 'Магазин')}</div>
  <p class="muted">Панель управления</p>
  ${error ? `<div class="a-flash err">${esc(error)}</div>` : ''}
  <div class="field"><label for="admin-login">Логин</label><input id="admin-login" name="username" autocomplete="username" required autofocus></div>
  <div class="field"><label for="admin-password">Пароль</label><input id="admin-password" name="password" type="password" autocomplete="current-password" required></div>
  <button class="btn btn-primary btn-block" type="submit">Войти</button>
</form></body></html>`;
}

function dashboard(settings, db) {
  const products = db.getProducts();
  const shown = db.visibleProducts().length;
  const orders = db.visibleOrders();
  const pending = db.pendingReviewCount();
  const recent = orders.slice(0, 8).map(o => `<tr>
    <td><b>${esc(R.orderNo(o.number))}</b></td>
    <td>${R.formatDate(o.createdAt)}</td>
    <td>${esc(o.contact)}</td>
    <td>${R.money(o.total, settings)}</td>
  </tr>`).join('') || `<tr><td colspan="4" class="muted">Заказов пока нет</td></tr>`;
  const body = `
    <div class="a-cards">
      <a class="a-stat" href="/admin/products"><div class="a-stat-num">${shown}${shown === products.length ? '' : '/' + products.length}</div><div>Товаров на витрине</div></a>
      <a class="a-stat" href="/admin/reviews?status=pending"><div class="a-stat-num">${pending}</div><div>Отзывов на модерации</div></a>
      <a class="a-stat" href="/admin/orders"><div class="a-stat-num">${orders.length}</div><div>Заказов всего</div></a>
      <a class="a-stat" href="/admin/analytics"><div class="a-stat-num">Метрика</div><div>Посетители и источники</div></a>
    </div>
    <div class="a-panel"><div class="a-panel-head"><h2>Последние заказы</h2><a class="link" href="/admin/orders">Все →</a></div>
      <table class="a-table"><thead><tr><th>№</th><th>Дата</th><th>Контакт</th><th>Сумма</th></tr></thead><tbody>${recent}</tbody></table></div>`;
  return layout(settings, { active: 'dash', title: 'Обзор', pendingCount: pending, body });
}

/* ---------- Каталог ---------- */
function productsList(settings, db, flash) {
  // Порядок строк здесь и есть порядок карточек на главной: витрина показывает
  // товары в порядке файла. Строку можно перетащить за ручку или подвинуть
  // стрелками — сохраняется сразу, без кнопки «Сохранить».
  const list = db.getProducts();
  const grip = `<svg viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path d="M6 3.2h.01M10 3.2h.01M6 8h.01M10 8h.01M6 12.8h.01M10 12.8h.01" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"/></svg>`;
  const rows = list.map((p, i) => {
    const r = db.ratingFor(p.id);
    const hidden = !db.isVisible(p);
    return `<tr data-id="${esc(p.id)}" draggable="true"${hidden ? ' class="row-off"' : ''}>
      <td class="a-order">
        <span class="a-grip" title="Перетащите, чтобы изменить порядок" aria-hidden="true">${grip}</span>
        <span class="a-order-num">${i + 1}</span>
        <span class="a-order-btns">
          <button type="button" class="a-move a-move-up" aria-label="Переместить «${esc(p.name)}» выше"${i === 0 ? ' disabled' : ''}>↑</button>
          <button type="button" class="a-move a-move-down" aria-label="Переместить «${esc(p.name)}» ниже"${i === list.length - 1 ? ' disabled' : ''}>↓</button>
        </span>
      </td>
      <td class="a-thumb">${R.imageMarkup(p, 0)}</td>
      <td><b>${esc(p.name)}</b><br><span class="muted">${esc(p.category)}</span></td>
      <td>${R.money(p.price, settings)}<div class="muted small">базовая цена</div></td>
      <td>${hidden ? '<span class="pill off">скрыт</span> ' : ''}${p.hotDeal ? '<span class="pill ok">🔥 акция</span>' : ''} ${r.count
        ? `<a href="/admin/reviews/product/${encodeURIComponent(p.id)}" title="Отзывы товара">★ ${r.avg} (${r.count})</a>`
        : ''}</td>
      <td class="a-actions">
        <a class="btn btn-sm" href="/admin/products/${p.id}/edit">Изменить</a>
        <a class="btn btn-sm" href="/admin/reviews/new?productId=${p.id}">+ Отзыв</a>
        <form method="post" action="/admin/products/${p.id}/delete" data-confirm="Удалить товар «${esc(p.name)}» из каталога?"><button class="btn btn-sm btn-danger">Удалить</button></form>
      </td></tr>`;
  }).join('') || `<tr><td colspan="6" class="muted">Каталог пуст.</td></tr>`;
  return layout(settings, { active: 'products', title: 'Каталог', pendingCount: db.pendingReviewCount(),
    actions: `<a class="btn btn-primary" href="/admin/products/new">+ Добавить товар</a>`,
    flash, body: `<p class="muted small">Порядок строк — это порядок карточек на главной. Перетащите строку за ручку <span class="a-grip a-grip-inline" aria-hidden="true">${grip}</span> или подвиньте стрелками: сохраняется сразу.</p>
    <div class="a-panel"><table class="a-table a-table-sortable"><thead><tr><th><span class="sr-only">Порядок</span></th><th></th><th>Товар</th><th>Базовая цена</th><th></th><th></th></tr></thead>
    <tbody id="product-order" data-order="${esc(JSON.stringify(list.map(p => p.id)))}">${rows}</tbody></table></div>
    <p class="form-msg" id="order-msg" hidden></p>
    <script src="/static/product-order.js?v=${R.assetV('product-order.js')}"></script>` });
}

function productForm(settings, db, product, opts) {
  opts = opts || {};
  const isEdit = !!product;
  const errors = opts.errors || [];
  const draft = opts.draft || null;           // то, что админ только что отправил с ошибкой
  const errFor = field => (errors.find(e => e.field === field) || {}).text || '';
  const p = product || { name: '', category: '', price: '', oldPrice: '', badge: '', inStock: true, visible: true, stockLevel: 'in', shortDesc: '', description: '', specs: '', images: [], hotDeal: false, hotDealPrice: '', hotDealUntil: null, colors: [], storages: [], bands: [], options: [] };
  // При ошибке подставляем введённые значения, чтобы не потерять набранное
  const val = (field, fallback) => draft && draft[field] !== undefined ? draft[field] : fallback;
  const checked = (field, fallback) => draft ? draft[field] !== undefined : fallback;
  // Третье поле — наличие варианта; для распроданных пишем «нет», иначе строка прежняя.
  const colorsText = draft ? String(draft.colors || '') : (p.colors || []).map(c => `${c.name}|${c.hex || '#cccccc'}${c.inStock === false ? '|нет' : ''}`).join('\n');
  // «?Группа=значение» — привязка к выбору в другой группе (8 ТБ только с M5 Max).
  // Своего поля в редакторе у неё нет, но в текст она обязана попасть: иначе форма
  // стёрла бы её при первом же сохранении товара.
  //
  // На каждое значение пишется своя пара, а не список через запятую: у Apple
  // запятая стоит внутри самой метки чипа («M5 Max, 32 ядра GPU»), и список из
  // таких меток при обратном разборе распадался на несуществующие значения.
  const choiceTail = (x) => {
    if (!x || !x.forChoice) return '';
    const pairs = [];
    for (const group of Object.keys(x.forChoice)) {
      for (const value of (x.forChoice[group] || [])) pairs.push(group + '=' + value);
    }
    return pairs.length ? ' | ?' + pairs.join(';') : '';
  };
  // «@метка» — значение продаётся только с этими конфигурациями. По хвосту на
  // метку, по той же причине: запятая может оказаться внутри самой метки.
  const storageTail = (v) => (v.forStorage || []).map(label => ' | @' + label).join('');
  const storagesText = draft ? String(draft.storages || '') : (p.storages || []).map(s => `${s.label}|${s.add || 0}${s.inStock === false ? '|нет' : ''}${choiceTail(s)}`).join('\n');
  // Ремешки: «# Коллекция | размеры» и строки «- Цвет | #hex | доплата | нет»
  const bandsText = draft ? String(draft.bands || '') : (p.bands || []).map(g =>
    `# ${g.name} | ${(g.sizes || []).map(x => x.label).join(', ')}\n`
    + (g.options || []).map(o => `- ${o.name} | ${o.hex || '#cccccc'} | ${o.add || 0}${o.inStock === false ? ' | нет' : ''}${o.forColor ? ' | @' + o.forColor : ''}`).join('\n')
  ).join('\n');
  // Доп. характеристики: «# Группа | подсказка» и строки «- Значение | доплата | нет | @конфигурации»
  const optionsText = draft ? String(draft.options || '') : (p.options || []).map(g =>
    `# ${g.name}${g.hint ? ' | ' + g.hint : ' | '}\n`
    + (g.values || []).map(v => `- ${v.label} | ${v.add || 0}${v.inStock === false ? ' | нет' : ''}${storageTail(v)}${choiceTail(v)}`).join('\n')
  ).join('\n');
  const cats = db.categories();
  const ic = p.imageColors || {};
  // Фото привязывается к цвету корпуса И к вариации ремешка независимо: один и тот
  // же ремешок на натуральном и на чёрном титане выглядит по-разному, поэтому у
  // снимка две привязки, а не одна на выбор. Списка два — по одному на каждую.
  const ib = p.imageBands || {};
  // Привязка считается живой, только если такой цвет/вариация ещё существуют:
  // иначе после удаления цвета его фото пропадали из панели совсем.
  const knownColors = new Set((p.colors || []).map(c => c.name));
  const knownBands = new Set((p.bands || []).flatMap(g => (g.options || []).map(o => `${g.name}|${o.name}`)));
  const bandOf = src => (knownBands.has(ib[src]) ? ib[src] : '');
  const caseOf = src => (knownColors.has(ic[src]) ? ic[src] : '');
  const colorOpts = cur => `<option value="">— общее —</option>`
    + (p.colors || []).map(c => `<option value="${esc(c.name)}" ${cur === c.name ? 'selected' : ''}>${esc(c.name)}</option>`).join('');
  const bandOpts = cur => `<option value="">— без ремешка —</option>`
    + (p.bands || []).map(g => (g.options || []).map(o => {
        const key = `${g.name}|${o.name}`;
        return `<option value="${esc(key)}" ${cur === key ? 'selected' : ''}>${esc(g.name + ' · ' + o.name)}</option>`;
      }).join('')).join('');
  const mainSrc = (p.images || [])[0] || '';
  const chip = src => `<div class="img-chip${src === mainSrc ? ' is-main' : ''}" data-src="${esc(src)}" draggable="true"${caseOf(src) ? ` data-case="${esc(caseOf(src))}"` : ''}>
    <div class="img-chip-media"${caseOf(src) ? ` data-case="${esc(caseOf(src))}"` : ''}><img src="/uploads/${esc(src)}" alt="">
      <span class="img-main-badge">Главное</span>
      <button type="button" class="img-main" title="Сделать главным фото" aria-label="Сделать главным фото">★</button>
      <button type="button" class="img-del" title="Удалить фото" aria-label="Удалить фото">&times;</button></div>
    <div class="img-chip-controls">
      <button type="button" class="img-move img-move-prev" title="Переместить раньше" aria-label="Переместить фото раньше">←</button>
      <select class="img-color" name="imgcolor:${esc(src)}" aria-label="Цвет корпуса на фото">${colorOpts(caseOf(src))}</select>
      ${(p.bands || []).length ? `<select class="img-band" name="imgband:${esc(src)}" aria-label="Ремешок на фото">${bandOpts(bandOf(src))}</select>` : ''}
      <button type="button" class="img-move img-move-next" title="Переместить позже" aria-label="Переместить фото позже">→</button>
    </div>
  </div>`;
  // Фото сгруппированы: сначала «общие», затем по каждому цвету товара
  const groupHead = (name, hex) => name
    ? `<div class="img-group-head"><span class="swatch" style="background:${R.cssColor(hex, '#cccccc')}"></span>${esc(name)}<span class="img-group-count"></span></div>`
    : `<div class="img-group-head"><span class="swatch swatch-any"></span>Общие фото<span class="img-group-count"></span></div>`;
  const groupFor = (name, hex) => {
    // Фото, привязанное к ремешку, живёт в своей группе и не должно попадать
    // ни в «Общие», ни в группу цвета — иначе один снимок виден дважды.
    const list = (p.images || []).filter(src => !bandOf(src) && caseOf(src) === name);
    return `<div class="img-group" data-color="${esc(name)}"${list.length ? '' : ' hidden'}>
      ${groupHead(name, hex)}
      <div class="img-chips">${list.map(chip).join('')}</div>
    </div>`;
  };
  // Группы снимков: общие → по цвету корпуса → «ремешок на этом корпусе».
  // Последние раздельные, потому что один ремешок на разных корпусах выглядит
  // по-разному и фото у них свои.
  const groupForBand = (g, o, caseName, caseHex) => {
    const key = `${g.name}|${o.name}`;
    const list = (p.images || []).filter(src => bandOf(src) === key && caseOf(src) === caseName);
    const title = esc(g.name + ' · ' + o.name) + (caseName ? ` <span class="img-group-case">${esc(caseName)}</span>` : '');
    return `<div class="img-group" data-band="${esc(key)}" data-case="${esc(caseName)}"${list.length ? '' : ' hidden'}>
      <div class="img-group-head"><span class="swatch" style="background:${R.cssColor(o.hex, '#cccccc')}"></span>${title}<span class="img-group-count"></span></div>
      <div class="img-chips">${list.map(chip).join('')}</div>
    </div>`;
  };
  const caseList = (p.colors || []).length ? p.colors : [{ name: '', hex: '' }];
  const bandGroups = (p.bands || []).map(g => (g.options || []).map(o =>
    [''].concat(caseList.map(c => c.name)).filter((v, i, a) => a.indexOf(v) === i)
      .map(caseName => groupForBand(g, o, caseName)).join('')
  ).join('')).join('');
  const existing = [groupFor('', '')]
    .concat((p.colors || []).map(c => groupFor(c.name, c.hex)))
    .concat(bandGroups)
    .join('');

  const uploadField = (label, attrs) => `<div class="field photo-upload-field">
    <label>${label}</label>
    <label class="photo-upload-box">
      <input type="file" accept="image/*" multiple ${attrs || ''}>
      <span class="photo-upload-icon" aria-hidden="true">＋</span>
      <span class="photo-upload-text"><b>Выбрать фотографии</b><span class="photo-upload-selection"></span></span>
    </label>
    <div class="photo-upload-progress" hidden><div class="photo-progress-track"><span></span></div><span class="photo-upload-status" aria-live="polite"></span><button type="button" class="photo-upload-cancel" data-upload-cancel hidden>Остановить</button></div>
    <div class="photo-queue"></div>
  </div>`;
  const colorUploads = isEdit
    ? `<div class="field" id="color-uploads" style="display:none">
    <label>Фото для конкретного цвета</label>
    <div class="cu-grid"></div>
  </div>
  <details class="field upload-fold" id="band-uploads" style="display:none">
    <summary><span>Фото для конкретного ремешка</span><span class="muted upload-fold-note">нажмите, чтобы раскрыть</span></summary>
    <p class="field-hint">Снимок попадёт только в эту вариацию: покупатель увидит его, когда выберет этот ремешок.</p>
    <div class="cu-grid"></div>
  </details>`
    : '';
  // Поле с подсказкой и текстом ошибки под ним
  const field = (name, label, control, hint) => `<div class="field${errFor(name) ? ' has-error' : ''}">
    <label>${label}</label>${control}
    ${errFor(name) ? `<p class="field-err">${esc(errFor(name))}</p>` : (hint ? `<p class="field-hint">${hint}</p>` : '')}
  </div>`;
  const section = (title, hint, inner) => `<section class="form-section">
    <div class="form-section-head"><h2>${title}</h2>${hint ? `<p class="muted small">${hint}</p>` : ''}</div>
    ${inner}
  </section>`;

  const body = `
  <form class="a-form product-form" data-product-form method="post" action="${isEdit ? '/admin/products/' + product.id : '/admin/products'}" enctype="multipart/form-data">
    ${errors.length ? `<div class="form-alert" role="alert"><b>Не сохранено.</b> ${errors.length === 1 ? 'Поправьте одно поле:' : 'Поправьте поля:'}
      <ul>${errors.map(e => `<li>${esc(e.text)}</li>`).join('')}</ul></div>` : ''}

    ${section('Основное', 'Название и категория видны покупателю в каталоге.', `
      <div class="a-form-grid">
        ${field('name', 'Название', `<input name="name" value="${esc(val('name', p.name))}" placeholder="iPhone 17 Pro" required autofocus>`)}
        ${field('category', 'Категория', `<input name="category" value="${esc(val('category', p.category))}" list="cats" placeholder="iPhone" required><datalist id="cats">${cats.map(c => `<option value="${esc(c)}">`).join('')}</datalist>`, 'Начните вводить — подскажет существующие')}
        ${field('badge', 'Отметка на карточке', `<input name="badge" value="${esc(val('badge', p.badge || ''))}" placeholder="Новинка" maxlength="20">`, 'Необязательно. Встанет строкой над названием вместо категории')}
        ${(() => {
          const lvl = val('stockLevel', p.stockLevel || 'in') === 'few' ? 'few' : 'in';
          return field('stockLevel', 'Подпись наличия', `<select name="stockLevel">
            <option value="in"${lvl === 'in' ? ' selected' : ''}>В наличии</option>
            <option value="few"${lvl === 'few' ? ' selected' : ''}>Осталось несколько штук</option>
          </select>`, 'Строка с мигающей точкой на странице товара. У распроданного не показывается');
        })()}
      </div>
      <label class="switch-row"><input type="checkbox" name="inStock" ${checked('inStock', !!p.inStock) ? 'checked' : ''}><span>Товар в наличии</span></label>
      <label class="switch-row"><input type="checkbox" name="visible" ${checked('visible', p.visible !== false) ? 'checked' : ''}><span>Показывать на витрине</span></label>
      <p class="field-hint">Снятая галочка убирает карточку с витрины целиком — вместе с поиском, картой сайта и возможностью заказать. Это не «нет в наличии»: там карточка остаётся на месте с соответствующей подписью.</p>
    `)}

    ${section('Цена', 'Скидка появится сама, если цена по акции ниже базовой.', `
      <div class="a-form-grid">
        ${field('price', 'Базовая цена', `<div class="price-field"><input name="price" type="number" min="1" step="1" value="${esc(val('price', p.price))}" placeholder="89990" required><span>₽</span></div>`)}
        ${field('oldPrice', 'Старая цена', `<div class="price-field"><input name="oldPrice" type="number" min="0" step="1" value="${esc(val('oldPrice', p.oldPrice || ''))}" placeholder="—"><span>₽</span></div>`, 'Показывается зачёркнутой рядом с ценой')}
      </div>
      <div class="deal-box${checked('hotDeal', !!p.hotDeal) ? ' is-on' : ''}" id="deal-box">
        <label class="switch-row"><input type="checkbox" name="hotDeal" id="deal-toggle" ${checked('hotDeal', !!p.hotDeal) ? 'checked' : ''}><span>🔥 Горящая скидка</span></label>
        <div class="deal-fields">
          <div class="a-form-grid">
            ${field('hotDealPrice', 'Цена по акции', `<div class="price-field"><input name="hotDealPrice" type="number" min="0" step="1" value="${esc(val('hotDealPrice', p.hotDealPrice || ''))}" placeholder="84990"><span>₽</span></div>`)}
            ${field('hotDealUntil', 'Действует до', `<input name="hotDealUntil" type="datetime-local" value="${esc(val('hotDealUntil', dtLocal(p.hotDealUntil)))}">`, 'Пусто — без таймера')}
          </div>
        </div>
      </div>
      <p class="price-preview" id="price-preview" hidden></p>
    `)}

    ${section('Тексты', 'Характеристики — по строке на пункт, в формате «Параметр: значение». Иконка подбирается сама.', `
      ${field('shortDesc', 'Краткое описание', `<input name="shortDesc" value="${esc(val('shortDesc', p.shortDesc || ''))}" maxlength="200" placeholder="A19 Pro, три камеры 48 Мп, до 39 ч видео">`, 'Одна строка под названием на странице товара')}
      ${field('description', 'Полное описание', `<textarea name="description" rows="5">${esc(val('description', p.description || ''))}</textarea>`)}
      ${field('specs', 'Характеристики', `<textarea class="specs-input" name="specs" rows="12" placeholder="Экран: 6.9&quot; Super Retina XDR&#10;Чип: A19 Pro&#10;Память: 256 ГБ">${esc(val('specs', p.specs || ''))}</textarea>`)}
    `)}

    ${section('Варианты', 'Цвета и конфигурации, между которыми покупатель выбирает на странице товара. Снятая галочка «в наличии» оставляет вариант видимым, но недоступным.', `
      <div class="a-form-grid product-options-grid">
        <div class="field"><label>Цвета</label>
          <div class="color-editor" id="color-editor" data-edit="${isEdit ? '1' : '0'}"></div>
          <button type="button" class="btn btn-sm" id="color-add">+ Добавить цвет</button>
          <textarea name="colors" id="colors-raw" hidden>${esc(colorsText)}</textarea>
        </div>
        <div class="field"><label>Память / конфигурации</label>
          <div class="storage-editor" id="storage-editor"></div>
          <button type="button" class="btn btn-sm" id="storage-add">+ Добавить вариант</button>
          <textarea name="storages" id="storages-raw" hidden>${esc(storagesText)}</textarea>
          <p class="field-hint">Указывайте полную цену варианта — доплата посчитается сама.</p>
        </div>
      </div>
      <div class="field option-field">
        <label>Дополнительные характеристики <span class="muted">— покрытие дисплея, связь, комплект</span></label>
        <div class="option-editor" id="option-editor"></div>
        <button type="button" class="btn btn-sm" id="option-add">+ Добавить характеристику</button>
        <p class="field-hint">Цена — полная: сколько стоит товар с этим значением. «Только для конфигураций» ограничивает значение частью вариантов памяти — как нанотекстурное стекло у iPad Pro.</p>
        <textarea name="options" id="options-raw" hidden>${esc(optionsText)}</textarea>
      </div>
      <div class="field band-field">
        <label>Ремешки <span class="muted">— для часов: коллекция, её размеры и цвета</span></label>
        <div class="band-editor" id="band-editor"></div>
        <button type="button" class="btn btn-sm" id="band-add">+ Добавить коллекцию ремешков</button>
        <p class="field-hint">Цена — полная: сколько стоят часы с этим ремешком. Фото вариации выбирается в списке фотографий ниже.</p>
        <textarea name="bands" id="bands-raw" hidden>${esc(bandsText)}</textarea>
      </div>
    `)}

    ${section('Фотографии', isEdit ? 'Первое фото — главное. Перетаскиванием меняется порядок.' : 'Фото можно добавить и после создания товара.', isEdit ? `
      <div id="photo-manager" data-product="${esc(product.id)}" data-order="${esc(JSON.stringify(p.images || []))}">
        <div class="field" id="img-chips-wrap"${(p.images || []).length ? '' : ' hidden'}><label>Текущие фото</label>
          <div class="img-groups" id="img-chips">${existing}</div>
        </div>
        ${uploadField('Добавить общие фото', 'data-auto')}
        ${colorUploads}
      </div>` : `${uploadField('Фотографии товара', 'name="images"')}${colorUploads}`)}

    <div class="form-actions-bar">
      <a class="btn" href="/admin/products">Отмена</a>
      <button class="btn btn-primary" type="submit">${isEdit ? 'Сохранить' : 'Создать товар'}</button>
    </div>
  </form>
  <script src="/static/product-form.js?v=${R.assetV('product-form.js')}"></script>
  <script src="/static/color-editor.js?v=${R.assetV('color-editor.js')}"></script>
  <script src="/static/band-editor.js?v=${R.assetV('band-editor.js')}"></script>
  <script src="/static/option-editor.js?v=${R.assetV('option-editor.js')}"></script>
  <script src="/static/photo-manager.js?v=${R.assetV('photo-manager.js')}"></script>`;
  return layout(settings, { active: 'products', title: isEdit ? 'Товар' : 'Новый товар', pendingCount: db.pendingReviewCount(), body, wide: true });
}

/* ---------- Отзывы ----------
   Раздел устроен в два уровня. На входе — очередь модерации: то, что ждёт
   решения, видно сразу и подкрашено, потому что это единственное здесь дело со
   сроком. Под ней — товары, у каждого свой список: разбирать семь тысяч отзывов
   одной лентой невозможно, а «что пишут про 17 Pro Max» — обычный вопрос.
   Общий список никуда не делся, он остался соседней вкладкой. */

// Вкладки одни на обе страницы: подписи и порядок расходиться не должны.
// Первой идёт та, что открыта по умолчанию на очереди модерации.
const REVIEW_TABS = [['pending', 'На модерации'], ['approved', 'Опубликованные'], ['all', 'Все']];
const REVIEW_TAB_KEYS = REVIEW_TABS.map(([k]) => k);
function reviewTab(status, fallback) {
  return REVIEW_TAB_KEYS.includes(String(status)) ? String(status) : fallback;
}
function filterByStatus(list, status) {
  if (status === 'pending') return list.filter(r => r.status !== 'approved');
  if (status === 'approved') return list.filter(r => r.status === 'approved');
  return list;
}
function reviewTabs(current, href) {
  return `<div class="a-tabs">${REVIEW_TABS.map(([key, label]) =>
    `<a class="a-tab${current === key ? ' active' : ''}" href="${href(key)}">${label}</a>`).join('')}</div>`;
}

// Куда вернуться после действия над строкой. Без этого админ, разбирающий
// очередь на 12-й странице, после каждого «Одобрить» оказывался в начале списка,
// а «Удалить» вдобавок сбрасывало вкладку. Те же три значения уходят и в адрес
// формы правки — возврат из неё обязан вести туда же, откуда пришли.
//
// Вкладка называется `tab`, а НЕ `status`: в форме правки есть свой `status` —
// состояние самого отзыва, — и два поля с одним именем ушли бы на сервер массивом.
// Отзыв тогда сохранялся бы «на модерации» независимо от выбранного.
function backFields(back) {
  return `<input type="hidden" name="page" value="${Math.max(1, Math.floor(Number(back.page)) || 1)}">`
    + `<input type="hidden" name="tab" value="${esc(back.status || '')}">`
    + (back.product ? `<input type="hidden" name="product" value="${esc(back.product)}">` : '');
}
function backQuery(back) {
  const params = [`tab=${encodeURIComponent(back.status || '')}`, `page=${Math.max(1, Math.floor(Number(back.page)) || 1)}`];
  if (back.product) params.push('product=' + encodeURIComponent(back.product));
  return params.join('&amp;');
}

// Вложения строкой квадратиков. В ленте показывается лёгкое превью, а не сам
// снимок: в списке их до полусотни, и полноразмерные фото весом по четверти
// мегабайта сделали бы страницу панели тяжелее всей витрины.
const THUMB_LIMIT = 6;
function reviewThumbs(rv) {
  const prev = rv.previews || {};
  const items = (rv.videos || []).filter(Boolean).map(f => ({ f, video: true }))
    .concat((rv.photos || []).filter(Boolean).map(f => ({ f, video: false })));
  if (!items.length) return '';
  const shown = items.slice(0, THUMB_LIMIT);
  const rest = items.length - shown.length;
  const tiles = shown.map(it => {
    const src = prev[it.f] || (it.video ? (rv.poster || '') : it.f);
    const inner = src
      ? `<img src="/uploads/${esc(src)}" alt="" loading="lazy" decoding="async" width="80" height="80">`
      : '<span class="rv-thumb-cap">MP4</span>';
    return `<a class="rv-thumb${it.video ? ' is-video' : ''}" href="/uploads/${esc(it.f)}" target="_blank" rel="noopener">${inner}</a>`;
  }).join('');
  return `<div class="rv-thumbs">${tiles}${rest > 0 ? `<span class="rv-thumb rv-thumb-more">+${rest}</span>` : ''}</div>`;
}

// Одна строка отзыва. Общая для очереди модерации и для списка товара: подписи
// и набор кнопок в двух местах разъехались бы на первой же правке.
function reviewRow(rv, product, back, opts) {
  opts = opts || {};
  const pending = rv.status !== 'approved';
  const fields = backFields(back);
  // У опубликованного — «Снять с витрины»: он возвращается в очередь модерации.
  // Убрать неудачный отзыв со страницы товара нужно по-прежнему, а удаление для
  // этого слишком грубо — отзыв покупателя восстановить неоткуда.
  const act = pending
    ? `<form method="post" action="/admin/reviews/${esc(rv.id)}/approve">${fields}<button class="btn btn-sm btn-primary">Одобрить</button></form>`
    : `<form method="post" action="/admin/reviews/${esc(rv.id)}/hide">${fields}<button class="btn btn-sm">Снять с витрины</button></form>`;
  const where = opts.showProduct
    ? (product
      ? `<a class="rv-where" href="/admin/reviews/product/${encodeURIComponent(product.id)}">${esc(product.name)}</a>`
      : '<span class="rv-where rv-where-gone">товар удалён</span>')
    : '';
  // Мелочи под текстом: что купил и чем везли. Пусто — строки нет вовсе, а не
  // пустая полоска отступа.
  const bits = [];
  if (rv.config) bits.push(esc(rv.config));
  const carrier = DELIVERY.nameOf(rv.delivery);
  if (carrier) bits.push('доставка ' + esc(carrier));
  // Откуда отзыв — только про привезённые. У демо-набора это поле стоит у
  // каждой записи, и строка «demo-generated-v1» повторялась бы во всей ленте.
  if (rv.source && !/^demo/i.test(rv.source)) bits.push(esc(rv.source));
  return `<article class="rv-row${pending ? ' is-pending' : ''}" id="rv-${esc(rv.id)}">
    <div class="rv-main">
      <div class="rv-head">
        ${R.stars(rv.rating)}
        <b class="rv-who">${esc(rv.author)}</b>
        <span class="rv-when muted">${R.formatDate(rv.createdAt)}</span>
        ${pending ? '<span class="rv-tag">На модерации</span>' : ''}
        ${where}
      </div>
      ${rv.text ? `<p class="rv-text">${esc(rv.text)}</p>` : '<p class="rv-text rv-text-none">без текста</p>'}
      ${bits.length ? `<div class="rv-bits muted small">${bits.join(' · ')}</div>` : ''}
      ${reviewThumbs(rv)}
    </div>
    <div class="rv-acts">
      <a class="btn btn-sm" href="/admin/reviews/${esc(rv.id)}/edit?${backQuery(back)}">Изменить</a>
      ${act}
      <form method="post" action="/admin/reviews/${esc(rv.id)}/delete" data-confirm="Удалить отзыв «${esc(rv.author)}»? Вместе с ним удалятся его фото и видео.">${fields}<button class="btn btn-sm btn-danger">Удалить</button></form>
    </div>
  </article>`;
}

function reviewRows(slice, products, back, opts) {
  if (!slice.items.length) return `<p class="rv-empty muted">${esc((opts && opts.empty) || 'Отзывов нет.')}</p>`;
  return `<div class="rv-list">${slice.items.map(rv => reviewRow(rv, products[rv.productId], back, opts)).join('')}</div>`;
}

// Плитки товаров: имя, число отзывов, оценка и счётчик очереди. Открывается
// список отзывов именно этого товара.
function reviewProducts(db) {
  const stats = db.reviewStats();
  const cards = db.getProducts().map(p => {
    const s = stats.get(p.id) || { total: 0, pending: 0, avg: 0 };
    const line = s.total
      ? `${R.reviewCountText(s.total)}${s.avg ? ` · ★ ${s.avg}` : ''}`
      : 'отзывов нет';
    return `<a class="rv-prod${s.pending ? ' has-wait' : ''}" href="/admin/reviews/product/${encodeURIComponent(p.id)}">
      <span class="rv-prod-pic">${R.imageMarkup(p, 0)}</span>
      <span class="rv-prod-body"><b>${esc(p.name)}</b><span class="muted small">${line}</span></span>
      ${s.pending ? `<span class="rv-prod-wait" title="Ждут модерации: ${s.pending}">${s.pending}</span>` : ''}
    </a>`;
  }).join('');
  return `<div class="a-panel"><div class="a-panel-head"><h2>Отзывы по товарам</h2><span class="rv-hint muted small">откройте товар, чтобы разобрать его ленту</span></div>
    <div class="rv-products">${cards || '<p class="muted">Каталог пуст.</p>'}</div></div>`;
}

function reviewsList(settings, db, statusFilter, flash, page) {
  const products = {}; db.getProducts().forEach(p => products[p.id] = p);
  // По умолчанию открыта очередь: одобрить или отклонить — единственное дело в
  // этом разделе, у которого есть срок. Остальное лежит и ждёт.
  const status = reviewTab(statusFilter, 'pending');
  // Страницами: весь список разом — это мегабайты разметки и секунды блокировки
  // единственного потока, то есть замершая витрина для всех посетителей.
  const slice = R.adminSlice(filterByStatus(db.getReviews(), status), page);
  const back = { status, page: slice.page };
  const href = k => `/admin/reviews?status=${encodeURIComponent(k)}`;
  const pager = R.adminPager(slice, n => `/admin/reviews?status=${encodeURIComponent(status)}&amp;page=${n}`);
  const empty = status === 'pending' ? 'Очередь пуста — всё разобрано.' : 'Отзывов нет.';
  const body = `<p class="muted small">На витрине видны только опубликованные. «На модерации» — то, что оставили посетители: пока отзыв там, его видит лишь сам автор. Такие строки подсвечены.</p>
    ${reviewTabs(status, href)}
    <div class="a-panel">${reviewRows(slice, products, back, { showProduct: true, empty })}${pager}</div>
    ${reviewProducts(db)}`;
  return layout(settings, { active: 'reviews', title: 'Отзывы', pendingCount: db.pendingReviewCount(),
    actions: `<a class="btn btn-primary" href="/admin/reviews/new">+ Добавить отзыв</a>`, flash, body });
}

// Отзывы одного товара. Открывается с плитки товара и из строки общей ленты.
function productReviews(settings, db, product, statusFilter, flash, page) {
  const products = { [product.id]: product };
  // Здесь по умолчанию видно всё: товар открывают, чтобы посмотреть его ленту
  // целиком, а не только непрочитанное.
  const status = reviewTab(statusFilter, 'all');
  const all = db.reviewsForProduct(product.id, false);
  const slice = R.adminSlice(filterByStatus(all, status), page);
  const back = { status, page: slice.page, product: product.id };
  const base = `/admin/reviews/product/${encodeURIComponent(product.id)}`;
  const pager = R.adminPager(slice, n => `${base}?status=${encodeURIComponent(status)}&amp;page=${n}`);
  const rating = db.ratingFor(product.id);
  const waiting = all.filter(r => r.status !== 'approved').length;
  const body = `<div class="a-panel rv-prod-head">
      <span class="rv-prod-pic">${R.imageMarkup(product, 0)}</span>
      <div class="rv-prod-info">
        <b>${esc(product.name)}</b>
        <span class="muted small">${all.length ? R.reviewCountText(all.length) : 'отзывов нет'}${rating.count ? ` · ★ ${rating.avg}` : ''}${waiting ? ` · ${waiting} ждёт модерации` : ''}</span>
      </div>
      <div class="rv-prod-links">
        <a class="btn btn-sm" href="/product/${encodeURIComponent(product.id)}" target="_blank" rel="noopener noreferrer">На витрине ↗</a>
        <a class="btn btn-sm" href="/admin/products/${encodeURIComponent(product.id)}/edit">Карточка товара</a>
      </div>
    </div>
    ${reviewTabs(status, k => `${base}?status=${encodeURIComponent(k)}`)}
    <div class="a-panel">${reviewRows(slice, products, back, { empty: 'У этого товара таких отзывов нет.' })}${pager}</div>`;
  return layout(settings, { active: 'reviews', title: 'Отзывы товара', pendingCount: db.pendingReviewCount(),
    actions: `<a class="btn" href="/admin/reviews">← Все отзывы</a><a class="btn btn-primary" href="/admin/reviews/new?productId=${encodeURIComponent(product.id)}">+ Добавить отзыв</a>`,
    flash, body });
}

/* Форма отзыва — одна на создание и на правку.
   Править можно всё, что видно покупателю: товар, автора, оценку, дату, текст,
   сборку, перевозчика, состояние и вложения. Двумя формами это разъехалось бы
   на первой же добавленной строке. */
function reviewForm(settings, db, review, opts) {
  opts = opts || {};
  const isEdit = !!review;
  const rv = review || {};
  const back = opts.back || {};
  const productId = isEdit ? rv.productId : (opts.productId || '');
  const options = db.getProducts().map(p =>
    `<option value="${esc(p.id)}"${p.id === productId ? ' selected' : ''}>${esc(p.name)}</option>`).join('');
  const rating = Math.min(5, Math.max(1, Number(rv.rating) || 5));
  const stars = [5, 4, 3, 2, 1].map(v => `<option value="${v}"${v === rating ? ' selected' : ''}>${'★'.repeat(v)} (${v})</option>`).join('');
  const status = rv.status === 'approved' || !isEdit ? 'approved' : 'pending';
  const carriers = DELIVERY.METHODS.map(m =>
    `<option value="${esc(m.id)}"${rv.delivery === m.id ? ' selected' : ''}>${esc(m.name)}</option>`).join('');
  const action = isEdit ? `/admin/reviews/${esc(rv.id)}/edit` : '/admin/reviews/new';
  const cancel = isEdit ? `/admin/reviews${back.product ? '/product/' + encodeURIComponent(back.product) : ''}?${backQuery(back)}` : '/admin/reviews';

  // Вложения: каждое можно отметить к удалению галочкой — ни строчки скрипта,
  // поэтому форма работает и там, где скрипты панели не загрузились. Новые
  // ролики через панель не заливаются: multipart принимает только картинки
  // (проверка по сигнатуре файла в lib/server-lib.js), и обходить её незачем.
  const prev = rv.previews || {};
  const files = (rv.videos || []).filter(Boolean).map(f => ({ f, video: true }))
    .concat((rv.photos || []).filter(Boolean).map(f => ({ f, video: false })));
  const tiles = files.map(it => {
    const src = prev[it.f] || (it.video ? (rv.poster || '') : it.f);
    const inner = src
      ? `<img src="/uploads/${esc(src)}" alt="" loading="lazy" decoding="async" width="120" height="120">`
      : '<span class="rv-thumb-cap">MP4</span>';
    return `<label class="rv-file" title="Отметьте, чтобы удалить при сохранении">
      <input type="checkbox" name="drop" value="${esc(it.f)}">
      <span class="rv-file-body">${inner}<span class="rv-file-x" aria-hidden="true">✕</span></span>
      <span class="rv-file-cap"><i class="rv-keep">${it.video ? 'видео' : 'фото'}</i><i class="rv-gone">удалить</i></span>
    </label>`;
  }).join('');

  const body = `<form class="a-form rv-form" method="post" action="${action}" enctype="multipart/form-data">
    ${isEdit ? backFields(back) : ''}
    <div class="rv-form-grid">
      <div class="rv-form-col">
        <div class="a-form-grid">
          <div class="field"><label>Товар *</label><select name="productId" required>${options}</select></div>
          <div class="field"><label>Состояние</label><select name="status">
            <option value="approved"${status === 'approved' ? ' selected' : ''}>Опубликован</option>
            <option value="pending"${status === 'pending' ? ' selected' : ''}>На модерации</option>
          </select></div>
          <div class="field"><label>Имя автора *</label><input name="author" value="${esc(rv.author || '')}" maxlength="60" required></div>
          <div class="field"><label>Оценка</label><select name="rating">${stars}</select></div>
          <div class="field"><label>Дата и время</label><input name="date" type="datetime-local" value="${dtLocal(rv.createdAt)}"></div>
          <div class="field"><label>Доставка</label><select name="delivery">
            <option value="">— не указана —</option>${carriers}
          </select></div>
        </div>
        <div class="field"><label>Сборка покупателя</label><input name="config" value="${esc(rv.config || '')}" maxlength="200" placeholder="Космический оранжевый · 256 ГБ · Только eSIM">
          <span class="field-note">Серая строка под оценкой: о какой именно сборке отзыв.</span></div>
        <div class="field"><label>Текст</label><textarea name="text" rows="8" maxlength="2000">${esc(rv.text || '')}</textarea></div>
      </div>
      <div class="rv-form-col rv-form-media">
        <label class="rv-form-sub">Вложения${files.length ? ` <span class="muted small">${files.length}</span>` : ''}</label>
        ${files.length ? `<div class="rv-files">${tiles}</div><span class="field-note">Отмеченные удалятся при сохранении — вместе с самими файлами.</span>` : '<p class="muted small">Пока ничего не приложено.</p>'}
        <div class="field"><label>${files.length ? 'Добавить фото' : 'Фото'}</label><input type="file" name="photos" accept="image/*" multiple>
          <span class="field-note">Фото ужимаются автоматически. Видео через панель не загружается.</span></div>
        ${isEdit && rv.sourceDate ? `<p class="field-note">Отзыв привезён с площадки: показанная дата каждую ночь сдвигается вместе со всем набором, поэтому правка двигает и исходную дату.</p>` : ''}
      </div>
    </div>
    <div class="a-form-actions">
      <button class="btn btn-primary" type="submit">${isEdit ? 'Сохранить' : 'Опубликовать'}</button>
      <a class="btn" href="${cancel}">Отмена</a>
      ${isEdit ? `<span class="rv-form-del"><button class="btn btn-danger" type="submit" form="rv-del">Удалить отзыв</button></span>` : ''}
    </div>
  </form>
  ${isEdit ? `<form id="rv-del" method="post" action="/admin/reviews/${esc(rv.id)}/delete" data-confirm="Удалить отзыв «${esc(rv.author || '')}»? Вместе с ним удалятся его фото и видео.">${backFields(back)}</form>` : ''}`;
  return layout(settings, { active: 'reviews', title: isEdit ? 'Отзыв' : 'Добавить отзыв',
    pendingCount: db.pendingReviewCount(), flash: opts.flash, flashType: opts.flashType, body, wide: true });
}

/* ---------- Заказы ---------- */
// Страницами, как и отзывы: заказы не удаляются сами, поэтому список растёт без
// предела. Тысячи заявок разом — это мегабайты разметки и заметная пауза
// единственного потока, то есть замершая витрина для всех посетителей.
function ordersList(settings, db, flash, page) {
  const slice = R.adminSlice(db.visibleOrders(), page);
  const pager = R.adminPager(slice, n => `/admin/orders?page=${n}`);
  const rows = slice.items.map(o => {
    // Возврат на ту же страницу: после удаления на 7-й странице админ не должен
    // оказываться в начале списка.
    const back = `<input type="hidden" name="page" value="${slice.page}">`;
    return `<tr id="order-${esc(o.id)}">
      <td class="o-num"><b>${esc(R.orderNo(o.number))}</b><span class="muted small">${R.formatDate(o.createdAt)}</span></td>
      <td class="o-client">${R.orderClient(o, { metricsBase: VISITOR_BASE, money: settings })}</td>
      <td class="o-items">${R.orderItems(o)}</td>
      <td class="o-state">${R.orderStatus(o)}</td>
      <td class="o-pay">${R.orderPayMethod(o)}</td>
      <td class="o-sum"><b>${R.money(o.total, settings)}</b></td>
      <td class="o-act"><form method="post" action="/admin/orders/${o.id}/delete" data-confirm="Удалить заказ?">${back}<button class="btn btn-sm btn-danger" aria-label="Удалить заказ">✕</button></form></td></tr>`;
  }).join('') || `<tr><td colspan="7" class="muted">Заказов нет.</td></tr>`;
  return layout(settings, { active: 'orders', title: 'Заказы', pendingCount: db.pendingReviewCount(), flash,
    body: `<div class="a-panel">${R.editSwitch('orders-edit')}<table class="a-table a-orders"><thead><tr><th>Заказ</th><th>Клиент</th><th>Состав</th><th>Статус</th><th>Оплата</th><th class="o-sum">Сумма</th><th class="o-act"><span class="sr-only">Удалить</span></th></tr></thead><tbody>${rows}</tbody></table>${pager}</div>` });
}

function analyticsPage(settings, db, snapshot) {
  const products = {}; db.getProducts().forEach(p => { products[p.id] = p.name; });
  const body = AV.dashboard(snapshot, { products, rangeBase: '/admin/analytics?days=', ordersHref: '/admin/orders', visitorBase: VISITOR_BASE });
  return layout(settings, { active: 'analytics', title: 'Метрика', pendingCount: db.pendingReviewCount(), wide: true, body });
}

// Карточка одного посетителя: вся его история посещений. Открывается по клику
// на IP или значки в строке заказа и по строке в таблице метрики.
function visitorPage(settings, db, visitor, opts) {
  opts = opts || {};
  const products = {}; db.getProducts().forEach(p => { products[p.id] = p.name; });
  const body = visitor
    ? AV.visitorPage(visitor, {
      products, backHref: '/admin/analytics', ordersHref: '/admin/orders', visitorBase: VISITOR_BASE,
      orders: opts.orders || [], alsoOnIp: opts.alsoOnIp || [], moneySettings: settings
    })
    : AV.visitorMissing(opts.key || '', { backHref: '/admin/analytics' });
  return layout(settings, { active: 'analytics', title: 'Посетитель', pendingCount: db.pendingReviewCount(), wide: true, body });
}

// Все настройки магазина на одной странице: бренд, оформление, реквизиты
// оператора, Telegram, доступ, подсказки адресов и касса. Раньше первые пять
// секций жили в админке домена, а последние две — у владельца.
//
// `opts.draft` — то, что админ только что отправил с ошибкой: форма возвращается
// с введённым, а не с сохранённым, иначе правка теряется целиком.
function settingsPage(settings, db, flash, flashType, opts) {
  opts = opts || {};
  const draft = opts.draft || null;
  const s = Object.assign({}, settings, draft || {});
  // Снятая галочка приходит в теле формы не значением, а ОТСУТСТВИЕМ поля.
  // Поэтому при возврате с ошибкой её нельзя искать в `s`: там она подхватится
  // из сохранённых настроек, и админ увидит свою галочку снова отмеченной —
  // а нажав «Сохранить» ещё раз, молча вернёт то, что только что снял.
  const checked = (field, saved) => (draft ? draft[field] !== undefined : saved);
  // Поля ещё нет — значит установка обновилась со старой версии: показываем
  // набор по умолчанию, а не «всё отмечено».
  const savedMethods = Array.isArray(settings.payMethods) ? settings.payMethods : PAY.DEFAULT_IDS;
  const shownMethods = draft ? [].concat(draft.payMethods === undefined ? [] : draft.payMethods) : savedMethods;
  const body = `<form class="a-form" method="post" enctype="multipart/form-data" action="/admin/settings">
    <div class="a-panel"><h2>Магазин</h2>
      <div class="a-form-grid">
        <div class="field"><label>Название магазина *</label><input name="storeName" value="${esc(s.storeName || '')}" required></div>
        <div class="field"><label>Слоган</label><input name="tagline" value="${esc(s.tagline || '')}"></div>
        <div class="field"><label>Акцентный цвет</label><input name="accentColor" type="color" value="${R.cssColor(s.accentColor, '#0071e3')}"></div>
        <div class="field"><label>Валюта</label><input name="currency" value="${esc(s.currency || '₽')}"></div>
        <div class="field"><label>Позиция валюты</label><select name="currencyPosition"><option value="after" ${s.currencyPosition === 'before' ? '' : 'selected'}>После суммы (1000 ₽)</option><option value="before" ${s.currencyPosition === 'before' ? 'selected' : ''}>Перед суммой ($1000)</option></select></div>
      </div>
      <div class="a-form-grid">
        <div class="field"><label>Telegram для витрины</label><input name="contactTelegram" value="${esc(s.contactTelegram || '')}" placeholder="@manager"></div>
        <div class="field"><label>Телефон</label><input name="contactPhone" value="${esc(s.contactPhone || '')}"></div>
      </div>
      <div class="field"><label>Текст в подвале</label><input name="footerNote" value="${esc(s.footerNote || '')}"></div>
    </div>
    ${R.brandFields(s)}
    <div class="a-panel"><h2>Персональные данные</h2>
      <div class="a-form-grid">
        <div class="field"><label>Оператор (ИП, ООО или ФИО)</label><input name="legalOperator" value="${esc(s.legalOperator || '')}"></div>
        <div class="field"><label>ИНН / ОГРН / ОГРНИП</label><input name="legalDetails" value="${esc(s.legalDetails || '')}"></div>
        <div class="field"><label>Адрес оператора</label><input name="legalAddress" value="${esc(s.legalAddress || '')}"></div>
        <div class="field"><label>E-mail для обращений по персональным данным</label><input name="privacyEmail" inputmode="email" value="${esc(s.privacyEmail || '')}"></div>
      </div>
      <p class="muted small">Эти поля подставляются в политику конфиденциальности, согласия и страницы гарантии и возврата. Пустые — документы остаются без реквизитов продавца.</p>
    </div>
    <div class="a-panel"><h2>Telegram для заявок</h2>
      <div class="a-form-grid">
        <div class="field"><label>Токен бота</label><input name="telegramBotToken" value="${esc(s.telegramBotToken || '')}" autocomplete="off" spellcheck="false"></div>
        <div class="field"><label>Chat ID</label><input name="telegramChatId" value="${esc(s.telegramChatId || '')}" autocomplete="off"></div>
        <div class="field field-check"><label><input type="checkbox" name="notifyReviews" ${checked('notifyReviews', settings.notifyReviews !== false) ? 'checked' : ''}> Уведомлять о новых отзывах</label></div>
      </div>
    </div>
    <div class="a-panel"><h2>Доступ в панель</h2>
      <div class="a-form-grid">
        <div class="field"><label>Логин</label><input name="adminUsername" value="${esc(s.adminUsername || 'admin')}" autocomplete="username"></div>
        <div class="field"><label>Новый пароль (пусто — не менять)</label><input name="adminPassword" type="password" autocomplete="new-password" minlength="10" maxlength="500"><span class="muted small">Не менее 10 символов.</span></div>
      </div>
      <p class="muted small">Учётная запись одна и с полными правами: панель открывается по адресу <b>/admin</b>. Смена логина или пароля разлогинивает все открытые сессии.</p>
    </div>
    <div class="a-panel"><h2>Подсказки адресов</h2>
      <div class="a-form-grid">
        <div class="field"><label>Ключ dadata.ru (API-ключ «Подсказок»)</label>
          <input name="dadataToken" value="${esc(s.dadataToken || '')}" placeholder="пусто — подсказок не будет" autocomplete="off"></div>
      </div>
      <p class="muted small">Ключ берётся в личном кабинете <a class="link" href="https://dadata.ru/profile/#info" target="_blank" rel="noopener noreferrer">dadata.ru</a>.
      Он хранится только на сервере: браузер покупателя спрашивает подсказки у нас, а в DaData ходит уже сервер. Без ключа поле адреса на оформлении остаётся обычным вводом.</p>
    </div>
    <div class="a-panel"><h2>Онлайн-оплата (CrocoPAY)</h2>
      <div class="field field-check"><label><input type="checkbox" name="crocopayEnabled"${checked('crocopayEnabled', !!settings.crocopayEnabled) ? ' checked' : ''}> Принимать оплату на витрине</label></div>
      <div class="a-form-grid">
        <div class="field"><label>Client ID кассы</label>
          <input name="crocopayClientId" value="${esc(s.crocopayClientId || '')}" placeholder="пусто — оплаты не будет" autocomplete="off" spellcheck="false"></div>
        <div class="field"><label>Client Secret кассы</label>
          <input name="crocopayClientSecret" value="${esc(s.crocopayClientSecret || '')}" placeholder="пусто — оплаты не будет" autocomplete="off" spellcheck="false"></div>
      </div>
      <p class="muted small">Ключи берутся в кабинете <a class="link" href="https://crocopay.tech/merchants" target="_blank" rel="noopener noreferrer">CrocoPAY</a>: «Кассы» → иконка шестерни у нужной кассы.
      Схема — H2H: счёт выставляем мы, покупатель платит переводом по реквизитам, не уходя с витрины. Номер его карты мы не спрашиваем и не получаем. Ключи хранятся только на сервере и на витрину не попадают.</p>
      <p class="muted small">Валюта всегда <b>рубли</b>: касса магазина рублёвая.</p>
      <p class="muted small">Галочка снята или ключи пусты — витрина работает как раньше: заявка, менеджер связывается. Уже оформленные заказы это не затрагивает.
      Состояние платежа видно в списке заказов: касса отдаёт настоящий статус счёта, поэтому «счёт истёк» и «оплата отменена» там тоже появляются, а не только «оплачено».</p>
      ${settings.crocopayEnabled && !(String(settings.crocopayClientId || '').trim() && String(settings.crocopayClientSecret || '').trim())
        ? '<p class="form-msg err">Оплата включена, но ключи кассы не заданы — на витрине она не показывается.</p>' : ''}

      <h3 class="a-subhead">Способы оплаты на витрине</h3>
      <input type="hidden" name="payMethodsForm" value="1">
      <div class="pay-methods-grid">${PAY.METHODS.map(m => `<label class="pay-method-check">
        <input type="checkbox" name="payMethods" value="${esc(m.id)}"${shownMethods.includes(m.id) ? ' checked' : ''}>
        <span><b>${esc(m.name)}</b><i>${esc(m.hint)}</i></span></label>`).join('')}</div>
      <p class="muted small">Покупатель увидит только отмеченные — и только те из них, что включены у самой кассы. Трансграничные способы (для карт иностранных банков) по умолчанию сняты: в длинном списке обычный покупатель теряется, а нужны они редко. Понадобятся — отметьте здесь.</p>
      ${shownMethods.length ? '' : '<p class="form-msg err">Не отмечен ни один способ — оплатить на витрине будет нечем.</p>'}
    </div>
    <div class="a-form-actions"><button class="btn btn-primary" type="submit">Сохранить</button></div>
  </form>`;
  return layout(settings, { active: 'settings', title: 'Настройки', pendingCount: db.pendingReviewCount(), flash, flashType, body });
}

module.exports = { loginPage, dashboard, productsList, productForm, reviewsList, productReviews, reviewForm, ordersList, analyticsPage, visitorPage, settingsPage };
