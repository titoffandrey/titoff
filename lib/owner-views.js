'use strict';
// Панель ВЛАДЕЛЬЦА (/owner): общий каталог, модерация отзывов, управление доменами, все заказы.
const R = require('./render');
const AV = require('./analytics-view');
const esc = R.esc;

function dtLocal(ms) {
  if (!ms) return '';
  const d = new Date(Number(ms)); const p = n => String(n).padStart(2, '0');
  if (Number.isNaN(d.getTime())) return '';
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
    ['/owner/analytics', 'Метрика', 'analytics'],
    ['/owner/settings', 'Настройки', 'settings']
  ].map(([href, label, key]) => {
    const badge = (key === 'reviews' && pending) ? `<span class="a-badge">${pending}</span>` : '';
    return `<a href="${href}" class="a-nav-item${opts.active === key ? ' active' : ''}"${opts.active === key ? ' aria-current="page"' : ''}>${label}${badge}</a>`;
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
    <div class="a-content${opts.wide ? ' a-content-wide' : ''}">${opts.body || ''}</div>
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

function productForm(db, product, opts) {
  opts = opts || {};
  const isEdit = !!product;
  const errors = opts.errors || [];
  const draft = opts.draft || null;           // то, что владелец только что отправил с ошибкой
  const errFor = field => (errors.find(e => e.field === field) || {}).text || '';
  const p = product || { name: '', category: '', price: '', oldPrice: '', badge: '', inStock: true, shortDesc: '', description: '', specs: '', images: [], hotDeal: false, hotDealPrice: '', hotDealUntil: null, colors: [], storages: [], bands: [] };
  // При ошибке подставляем введённые значения, чтобы не потерять набранное
  const val = (field, fallback) => draft && draft[field] !== undefined ? draft[field] : fallback;
  const checked = (field, fallback) => draft ? draft[field] !== undefined : fallback;
  // Третье поле — наличие варианта; для распроданных пишем «нет», иначе строка прежняя.
  const colorsText = draft ? String(draft.colors || '') : (p.colors || []).map(c => `${c.name}|${c.hex || '#cccccc'}${c.inStock === false ? '|нет' : ''}`).join('\n');
  const storagesText = draft ? String(draft.storages || '') : (p.storages || []).map(s => `${s.label}|${s.add || 0}${s.inStock === false ? '|нет' : ''}`).join('\n');
  // Ремешки: «# Коллекция | размеры» и строки «- Цвет | #hex | доплата | нет»
  const bandsText = draft ? String(draft.bands || '') : (p.bands || []).map(g =>
    `# ${g.name} | ${(g.sizes || []).map(x => x.label).join(', ')}\n`
    + (g.options || []).map(o => `- ${o.name} | ${o.hex || '#cccccc'} | ${o.add || 0}${o.inStock === false ? ' | нет' : ''}${o.forColor ? ' | @' + o.forColor : ''}`).join('\n')
  ).join('\n');
  const cats = db.categories();
  const ic = p.imageColors || {};
  // Фото можно привязать к цвету корпуса или к конкретной вариации ремешка
  const ib = p.imageBands || {};
  const colorOpts = (cur, curBand) => `<option value="">— общее —</option>`
    + (p.colors || []).map(c => `<option value="${esc(c.name)}" ${ic_sel(cur, c.name)}>${esc(c.name)}</option>`).join('')
    + ((p.bands || []).length ? `<optgroup label="Ремешки" data-bands="1">` + (p.bands || []).map(g => (g.options || []).map(o => {
        const value = `band:${g.name}|${o.name}`;
        return `<option value="${esc(value)}" ${curBand === `${g.name}|${o.name}` ? 'selected' : ''}>${esc(g.name + ' · ' + o.name)}</option>`;
      }).join('')).join('') + `</optgroup>` : '');
  function ic_sel(cur, name) { return cur === name ? 'selected' : ''; }
  const mainSrc = (p.images || [])[0] || '';
  const chip = src => `<div class="img-chip${src === mainSrc ? ' is-main' : ''}" data-src="${esc(src)}" draggable="true"${ic[src] ? ` data-case="${esc(ic[src])}"` : ''}>
    <div class="img-chip-media"><img src="/uploads/${esc(src)}" alt="">
      <span class="img-main-badge">Главное</span>
      <button type="button" class="img-main" title="Сделать главным фото" aria-label="Сделать главным фото">★</button>
      <button type="button" class="img-del" title="Удалить фото" aria-label="Удалить фото">&times;</button></div>
    <div class="img-chip-controls">
      <button type="button" class="img-move img-move-prev" title="Переместить раньше" aria-label="Переместить фото раньше">←</button>
      <select class="img-color" name="imgcolor:${esc(src)}" aria-label="Цвет фотографии">${colorOpts(ic[src] || '', ib[src] || '')}</select>
      <button type="button" class="img-move img-move-next" title="Переместить позже" aria-label="Переместить фото позже">→</button>
    </div>
  </div>`;
  // Фото сгруппированы: сначала «общие», затем по каждому цвету товара
  const groupHead = (name, hex) => name
    ? `<div class="img-group-head"><span class="swatch" style="background:${R.cssColor(hex, '#cccccc')}"></span>${esc(name)}<span class="img-group-count"></span></div>`
    : `<div class="img-group-head"><span class="swatch swatch-any"></span>Общие фото<span class="img-group-count"></span></div>`;
  // Привязка считается живой, только если такой цвет/вариация ещё существуют:
  // иначе после удаления цвета его фото пропадали из панели совсем.
  const knownColors = new Set((p.colors || []).map(c => c.name));
  const knownBands = new Set((p.bands || []).flatMap(g => (g.options || []).map(o => `${g.name}|${o.name}`)));
  const bandOf = src => (knownBands.has(ib[src]) ? ib[src] : '');
  const colorOf = src => (bandOf(src) ? '' : (knownColors.has(ic[src]) ? ic[src] : ''));
  const groupFor = (name, hex) => {
    // Фото, привязанное к ремешку, живёт в своей группе и не должно попадать
    // ни в «Общие», ни в группу цвета — иначе один снимок виден дважды.
    const list = (p.images || []).filter(src => !bandOf(src) && colorOf(src) === name);
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
    const list = (p.images || []).filter(src => bandOf(src) === key && (ic[src] || '') === caseName);
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
    <div class="photo-upload-progress" hidden><div class="photo-progress-track"><span></span></div><span class="photo-upload-status" aria-live="polite"></span></div>
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
  <form class="a-form product-form" data-product-form method="post" action="${isEdit ? '/owner/products/' + product.id : '/owner/products'}" enctype="multipart/form-data">
    ${errors.length ? `<div class="form-alert" role="alert"><b>Не сохранено.</b> ${errors.length === 1 ? 'Поправьте одно поле:' : 'Поправьте поля:'}
      <ul>${errors.map(e => `<li>${esc(e.text)}</li>`).join('')}</ul></div>` : ''}

    ${section('Основное', 'Название и категория видны покупателю в каталоге.', `
      <div class="a-form-grid">
        ${field('name', 'Название', `<input name="name" value="${esc(val('name', p.name))}" placeholder="iPhone 17 Pro" required autofocus>`)}
        ${field('category', 'Категория', `<input name="category" value="${esc(val('category', p.category))}" list="cats" placeholder="iPhone" required><datalist id="cats">${cats.map(c => `<option value="${esc(c)}">`).join('')}</datalist>`, 'Начните вводить — подскажет существующие')}
        ${field('badge', 'Плашка на карточке', `<input name="badge" value="${esc(val('badge', p.badge || ''))}" placeholder="Новинка" maxlength="20">`, 'Необязательно')}
      </div>
      <label class="switch-row"><input type="checkbox" name="inStock" ${checked('inStock', !!p.inStock) ? 'checked' : ''}><span>Товар в наличии</span></label>
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
      <a class="btn" href="/owner/products">Отмена</a>
      <button class="btn btn-primary" type="submit">${isEdit ? 'Сохранить' : 'Создать товар'}</button>
    </div>
  </form>
  <script src="/static/product-form.js?v=${R.assetV('product-form.js')}"></script>
  <script src="/static/color-editor.js?v=${R.assetV('color-editor.js')}"></script>
  <script src="/static/band-editor.js?v=${R.assetV('band-editor.js')}"></script>
  <script src="/static/photo-manager.js?v=${R.assetV('photo-manager.js')}"></script>`;
  return layout({ active: 'products', title: isEdit ? 'Товар' : 'Новый товар', pendingCount: db.pendingReviewCount(), body, wide: true });
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
    <div class="a-form-grid">
      <div class="field"><label>Доставка (1–5)</label><select name="aspect_delivery"><option value="">—</option>${[5,4,3,2,1].map(v => `<option value="${v}">${v}</option>`).join('')}</select></div>
      <div class="field"><label>Обслуживание (1–5)</label><select name="aspect_service"><option value="">—</option>${[5,4,3,2,1].map(v => `<option value="${v}">${v}</option>`).join('')}</select></div>
      <div class="field"><label>Цена/качество (1–5)</label><select name="aspect_price"><option value="">—</option>${[5,4,3,2,1].map(v => `<option value="${v}">${v}</option>`).join('')}</select></div>
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
      <td><span class="swatch" style="background:${R.cssColor(s.accentColor)}"></span> ×${esc(s.priceMultiplier || 1)}</td>
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
  const s = site || { hosts: [], storeName: '', tagline: '', accentColor: '#0071e3', currency: '₽', currencyPosition: 'after', contactTelegram: '', contactPhone: '', footerNote: '', legalOperator: '', legalDetails: '', legalAddress: '', privacyEmail: '', telegramBotToken: '', telegramChatId: '', notifyReviews: true, priceMultiplier: 1, adminUsername: 'admin', logoImage: null, logoText: '', logoFont: 'system', secondaryColor: '' };
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
    <div class="a-panel"><h2>Персональные данные</h2>
      <div class="a-form-grid">
        <div class="field"><label>Оператор (ИП, ООО или ФИО)</label><input name="legalOperator" value="${esc(s.legalOperator || '')}"></div>
        <div class="field"><label>ИНН / ОГРН / ОГРНИП</label><input name="legalDetails" value="${esc(s.legalDetails || '')}"></div>
        <div class="field"><label>Адрес оператора</label><input name="legalAddress" value="${esc(s.legalAddress || '')}"></div>
        <div class="field"><label>E-mail для обращений по персональным данным</label><input name="privacyEmail" inputmode="email" value="${esc(s.privacyEmail || '')}"></div>
      </div>
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
    return `<tr id="order-${esc(o.id)}"><td><b>${esc(o.number)}</b><br><span class="muted small">${R.formatDate(o.createdAt)}</span></td>
      <td>${esc(o.siteName || (sites[o.siteId] && sites[o.siteId].storeName) || '—')}</td>
      <td>${esc(o.customerName || '—')}<br><span class="muted">${esc(o.contact)}</span>${clientMeta(o)}</td>
      <td class="small">${items}</td><td><b>${R.money(o.total, { currency: '₽' })}</b></td><td>${sel}</td>
      <td><form method="post" action="/owner/orders/${o.id}/delete" data-confirm="Удалить заказ?"><button class="btn btn-sm btn-danger">✕</button></form></td></tr>`;
  }).join('') || `<tr><td colspan="7" class="muted">Заказов нет.</td></tr>`;
  return layout({ active: 'orders', title: 'Все заказы', pendingCount: db.pendingReviewCount(), flash,
    body: `<div class="a-panel"><table class="a-table"><thead><tr><th>Заказ</th><th>Домен</th><th>Клиент</th><th>Состав</th><th>Сумма</th><th>Статус</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>` });
}

function clientMeta(o) {
  const place = [o.clientCity, o.clientRegion, o.clientCountry].filter(Boolean).filter((x, i, a) => a.indexOf(x) === i).join(', ');
  const device = [o.clientModel || o.clientDevice, o.clientOs, o.clientBrowser].filter(Boolean).join(' · ');
  if (!place && !device && !o.clientIp) return '';
  return `<div class="order-client-meta">${place ? `<span>⌖ ${esc(place)}</span>` : ''}${device ? `<span>◫ ${esc(device)}</span>` : ''}${o.clientIp ? `<span>IP ${esc(o.clientIp)}</span>` : ''}${o.clientSource && o.clientSource !== 'Внутренний переход' ? `<span>↗ ${esc(o.clientSource)}</span>` : ''}</div>`;
}

function analyticsPage(db, snapshot, selectedSiteId) {
  const sites = db.getSites();
  const options = ['<option value="">Все домены</option>'].concat(sites.map(s => `<option value="${esc(s.id)}"${s.id === selectedSiteId ? ' selected' : ''}>${esc(s.storeName)}${s.hosts && s.hosts[0] ? ' · ' + esc(s.hosts[0]) : ''}</option>`)).join('');
  const siteSelect = `<form class="metric-site-filter" method="get" action="/owner/analytics"><input type="hidden" name="days" value="${snapshot.days}"><select name="site" onchange="this.form.submit()" aria-label="Выбрать домен">${options}</select></form>`;
  const products = {}; db.getProducts().forEach(p => { products[p.id] = p.name; });
  const siteQuery = selectedSiteId ? '&amp;site=' + encodeURIComponent(selectedSiteId) : '';
  const body = AV.dashboard(snapshot, { products, siteSelect, rangeBase: '/owner/analytics?days=', ordersHref: '/owner/orders' }).replace(/(\/owner\/analytics\?days=\d+)/g, '$1' + siteQuery);
  return layout({ active: 'analytics', title: 'Метрика', pendingCount: db.pendingReviewCount(), wide: true, body });
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

module.exports = { loginPage, dashboard, productsList, productForm, reviewsList, addReviewForm, sitesList, siteForm, ordersList, analyticsPage, settingsPage };
