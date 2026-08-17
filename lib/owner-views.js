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
  const accessibleBody = R.accessibleFields(opts.body || '', 'owner-field');
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
    <div class="a-content${opts.wide ? ' a-content-wide' : ''}">${accessibleBody}</div>
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
  <div class="field"><label for="owner-login">Логин</label><input id="owner-login" name="username" autocomplete="username" required autofocus></div>
  <div class="field"><label for="owner-password">Пароль</label><input id="owner-password" name="password" type="password" autocomplete="current-password" required></div>
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
  // Порядок строк здесь и есть порядок карточек на главной: витрина показывает
  // товары в порядке файла. Строку можно перетащить за ручку или подвинуть
  // стрелками — сохраняется сразу, без кнопки «Сохранить».
  const list = db.getProducts();
  const grip = `<svg viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path d="M6 3.2h.01M10 3.2h.01M6 8h.01M10 8h.01M6 12.8h.01M10 12.8h.01" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"/></svg>`;
  const rows = list.map((p, i) => {
    const r = db.ratingFor(p.id);
    return `<tr data-id="${esc(p.id)}" draggable="true">
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
      <td>${R.money(p.price, { currency: '₽' })}<div class="muted small">базовая цена</div></td>
      <td>${p.hotDeal ? '<span class="pill ok">🔥 акция</span>' : ''} ${r.count ? `★ ${r.avg} (${r.count})` : ''}</td>
      <td class="a-actions">
        <a class="btn btn-sm" href="/owner/products/${p.id}/edit">Изменить</a>
        <a class="btn btn-sm" href="/owner/reviews/new?productId=${p.id}">+ Отзыв</a>
        <form method="post" action="/owner/products/${p.id}/delete" data-confirm="Удалить товар «${esc(p.name)}» из общего каталога?"><button class="btn btn-sm btn-danger">Удалить</button></form>
      </td></tr>`;
  }).join('') || `<tr><td colspan="6" class="muted">Каталог пуст.</td></tr>`;
  return layout({ active: 'products', title: 'Общий каталог', pendingCount: db.pendingReviewCount(),
    actions: `<a class="btn btn-primary" href="/owner/products/new">+ Добавить товар</a>`,
    flash, body: `<p class="muted small">Каталог общий для всех доменов. Цены и видимость на конкретном сайте настраиваются в админке этого домена.</p>
    <p class="muted small">Порядок строк — это порядок карточек на главной странице всех сайтов. Перетащите строку за ручку <span class="a-grip a-grip-inline" aria-hidden="true">${grip}</span> или подвиньте стрелками: сохраняется сразу.</p>
    <div class="a-panel"><table class="a-table a-table-sortable"><thead><tr><th><span class="sr-only">Порядок</span></th><th></th><th>Товар</th><th>Базовая цена</th><th></th><th></th></tr></thead>
    <tbody id="product-order" data-order="${esc(JSON.stringify(list.map(p => p.id)))}">${rows}</tbody></table></div>
    <p class="form-msg" id="order-msg" hidden></p>
    <script src="/static/product-order.js?v=${R.assetV('product-order.js')}"></script>` });
}

function productForm(db, product, opts) {
  opts = opts || {};
  const isEdit = !!product;
  const errors = opts.errors || [];
  const draft = opts.draft || null;           // то, что владелец только что отправил с ошибкой
  const errFor = field => (errors.find(e => e.field === field) || {}).text || '';
  const p = product || { name: '', category: '', price: '', oldPrice: '', badge: '', inStock: true, stockLevel: 'in', shortDesc: '', description: '', specs: '', images: [], hotDeal: false, hotDealPrice: '', hotDealUntil: null, colors: [], storages: [], bands: [], options: [] };
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
  <form class="a-form product-form" data-product-form method="post" action="${isEdit ? '/owner/products/' + product.id : '/owner/products'}" enctype="multipart/form-data">
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
      <a class="btn" href="/owner/products">Отмена</a>
      <button class="btn btn-primary" type="submit">${isEdit ? 'Сохранить' : 'Создать товар'}</button>
    </div>
  </form>
  <script src="/static/product-form.js?v=${R.assetV('product-form.js')}"></script>
  <script src="/static/color-editor.js?v=${R.assetV('color-editor.js')}"></script>
  <script src="/static/band-editor.js?v=${R.assetV('band-editor.js')}"></script>
  <script src="/static/option-editor.js?v=${R.assetV('option-editor.js')}"></script>
  <script src="/static/photo-manager.js?v=${R.assetV('photo-manager.js')}"></script>`;
  return layout({ active: 'products', title: isEdit ? 'Товар' : 'Новый товар', pendingCount: db.pendingReviewCount(), body, wide: true });
}

/* ---------- Отзывы (мастер) ---------- */
function reviewsList(db, statusFilter, flash, page) {
  const products = {}; db.getProducts().forEach(p => products[p.id] = p);
  let list = db.getReviews();
  if (statusFilter === 'pending') list = list.filter(r => r.status === 'pending');
  else if (statusFilter === 'approved') list = list.filter(r => r.status === 'approved');
  const tab = (k, l) => `<a class="a-tab${(statusFilter || 'all') === k ? ' active' : ''}" href="/owner/reviews?status=${k}">${l}</a>`;
  // Страницами: весь список разом — это мегабайты разметки и секунды блокировки
  // единственного потока, то есть замершая витрина для всех посетителей.
  const slice = R.adminSlice(list, page);
  const status = statusFilter || 'all';
  const pager = R.adminPager(slice, n => `/owner/reviews?status=${encodeURIComponent(status)}&amp;page=${n}`);
  const rows = slice.items.map(rv => {
    const p = products[rv.productId];
    const photos = (rv.photos || []).map(ph => `<a href="/uploads/${esc(ph)}" target="_blank" rel="noopener"><img src="/uploads/${esc(ph)}" alt=""></a>`).join('');
    // Куда вернуться после действия. Без этого владелец, разбирающий очередь на
    // 12-й странице, после каждого одобрения оказывался в начале списка, а
    // удаление вдобавок сбрасывало вкладку «На модерации» на «Все».
    const back = `<input type="hidden" name="page" value="${slice.page}"><input type="hidden" name="status" value="${esc(status)}">`;
    const act = rv.status === 'pending'
      ? `<form method="post" action="/owner/reviews/${rv.id}/approve">${back}<button class="btn btn-sm btn-primary">Одобрить</button></form>`
      : `<span class="pill ok">Опубликован</span>`;
    return `<tr><td><div class="review-cell"><div class="rc-top"><b>${esc(rv.author)}</b> ${R.stars(rv.rating)} <span class="muted">${R.formatDate(rv.createdAt)}</span></div>
      <div class="muted">${p ? esc(p.name) : '— товар удалён —'}</div>${rv.text ? `<div class="rc-text">${esc(rv.text)}</div>` : ''}${photos ? `<div class="rc-photos">${photos}</div>` : ''}</div></td>
      <td class="a-actions">${act}<form method="post" action="/owner/reviews/${rv.id}/delete" data-confirm="Удалить отзыв?">${back}<button class="btn btn-sm btn-danger">Удалить</button></form></td></tr>`;
  }).join('') || `<tr><td colspan="2" class="muted">Отзывов нет.</td></tr>`;
  return layout({ active: 'reviews', title: 'Отзывы', pendingCount: db.pendingReviewCount(),
    actions: `<a class="btn btn-primary" href="/owner/reviews/new">+ Добавить отзыв</a>`,
    flash, body: `<p class="muted small">Отзывы общие для всех доменов. На конкретном сайте их можно скрыть в его админке.</p><div class="a-tabs">${tab('all', 'Все')}${tab('pending', 'На модерации')}${tab('approved', 'Опубликованные')}</div><div class="a-panel"><table class="a-table"><tbody>${rows}</tbody></table>${pager}</div>` });
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
    const open = (s.hosts && s.hosts[0]) ? `//${esc(s.hosts[0])}` : `/?site=${s.id}`;
    return `<tr>
      <td><b>${esc(s.storeName)}</b><br><span class="muted small">${(s.hosts || []).map(esc).join(', ') || 'домен не задан'}</span></td>
      <td><span class="swatch" style="background:${R.cssColor(s.accentColor)}"></span> ×${esc(s.priceMultiplier || 1)}</td>
      <td class="muted small">логин: ${esc(s.adminUsername)}</td>
      <td class="a-actions">
        <a class="btn btn-sm" href="${open}" target="_blank" rel="noopener noreferrer">Открыть ↗</a>
        <a class="btn btn-sm" href="/owner/sites/${s.id}/edit">Изменить</a>
        <form method="post" action="/owner/sites/${s.id}/delete" data-confirm="Удалить домен «${esc(s.storeName)}»?"><button class="btn btn-sm btn-danger">Удалить</button></form>
      </td></tr>`;
  }).join('') || `<tr><td colspan="4" class="muted">Доменов нет.</td></tr>`;
  return layout({ active: 'sites', title: 'Домены', pendingCount: db.pendingReviewCount(),
    actions: `<a class="btn btn-primary" href="/owner/sites/new">+ Добавить домен</a>`,
    flash, body: `<div class="a-panel"><table class="a-table"><thead><tr><th>Магазин</th><th>Оформление</th><th>Админ</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>` });
}

function siteForm(db, site, opts) {
  opts = opts || {};
  const isEdit = !!site;
  const defaults = { hosts: [], storeName: '', tagline: '', accentColor: '#0071e3', currency: '₽', currencyPosition: 'after', contactTelegram: '', contactPhone: '', footerNote: '', legalOperator: '', legalDetails: '', legalAddress: '', privacyEmail: '', telegramBotToken: '', telegramChatId: '', notifyReviews: true, priceMultiplier: 1, adminUsername: 'admin', logoImage: null, logoText: '', logoFont: 'system', secondaryColor: '' };
  const s = Object.assign({}, defaults, site || {}, opts.draft || {});
  const hosts = Array.isArray(s.hosts) ? s.hosts.join(', ') : String(s.hosts || '');
  const body = `<form class="a-form" method="post" enctype="multipart/form-data" action="${isEdit ? '/owner/sites/' + site.id : '/owner/sites'}">
    <div class="a-panel"><h2>Домены и бренд</h2>
      <div class="field"><label>Домены (через запятую или с новой строки)</label><textarea name="hosts" rows="2" placeholder="shop1.ru, www.shop1.ru">${esc(hosts)}</textarea></div>
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
        <div class="field"><label>${isEdit ? 'Новый пароль (пусто — не менять)' : 'Пароль *'}</label><input name="adminPassword" type="password" autocomplete="new-password" minlength="10" maxlength="500" ${isEdit ? '' : 'required'}><span class="muted small">Не менее 10 символов.</span></div>
      </div>
    </div>
    <div class="a-form-actions"><button class="btn btn-primary" type="submit">${isEdit ? 'Сохранить' : 'Создать домен'}</button><a class="btn" href="/owner/sites">Отмена</a></div>
  </form>`;
  return layout({ active: 'sites', title: isEdit ? 'Домен: ' + s.storeName : 'Новый домен', pendingCount: db.pendingReviewCount(), flash: opts.error, flashType: 'err', body });
}

/* ---------- Заказы (все) ---------- */
// Страницами, как и отзывы: заказы не удаляются сами, поэтому список растёт без
// предела. Тысячи заявок разом — это мегабайты разметки и заметная пауза
// единственного потока, то есть замершая витрина для всех посетителей.
function ordersList(db, flash, page) {
  const statuses = ['new', 'processing', 'done', 'cancelled'];
  const label = { new: 'Новый', processing: 'В работе', done: 'Выполнен', cancelled: 'Отменён' };
  const sites = {}; db.getSites().forEach(s => sites[s.id] = s);
  const slice = R.adminSlice(db.getOrders(), page);
  const pager = R.adminPager(slice, n => `/owner/orders?page=${n}`);
  const rows = slice.items.map(o => {
    const items = o.items.map(i => `${esc(i.name)} × ${i.qty}`).join('<br>');
    // Возврат на ту же страницу: после смены статуса на 7-й странице владелец
    // не должен оказываться в начале списка.
    const back = `<input type="hidden" name="page" value="${slice.page}">`;
    const sel = `<form method="post" action="/owner/orders/${o.id}/status" class="inline-form">${back}<select name="status" onchange="this.form.submit()">${statuses.map(x => `<option value="${x}" ${o.status === x ? 'selected' : ''}>${label[x]}</option>`).join('')}</select></form>`;
    return `<tr id="order-${esc(o.id)}"><td><b>${esc(o.number)}</b><br><span class="muted small">${R.formatDate(o.createdAt)}</span></td>
      <td>${esc(o.siteName || (sites[o.siteId] && sites[o.siteId].storeName) || '—')}</td>
      <td>${esc(o.customerName || '—')}<br><span class="muted">${esc(o.contact)}</span>${orderNote(o)}${clientMeta(o)}</td>
      <td class="small">${items}</td><td><b>${R.money(o.total, { currency: '₽' })}</b>${R.paymentBadge(o)}</td><td>${sel}</td>
      <td><form method="post" action="/owner/orders/${o.id}/delete" data-confirm="Удалить заказ?">${back}<button class="btn btn-sm btn-danger">✕</button></form></td></tr>`;
  }).join('') || `<tr><td colspan="7" class="muted">Заказов нет.</td></tr>`;
  return layout({ active: 'orders', title: 'Все заказы', pendingCount: db.pendingReviewCount(), flash,
    body: `<div class="a-panel"><table class="a-table"><thead><tr><th>Заказ</th><th>Домен</th><th>Клиент</th><th>Состав</th><th>Сумма</th><th>Статус</th><th></th></tr></thead><tbody>${rows}</tbody></table>${pager}</div>` });
}

// Способ доставки, адрес и комментарий старых заявок — общая разметка на обе
// панели (`R.orderDelivery`), чтобы подписи в них не разъехались.
const orderNote = o => R.orderDelivery(o);

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

function settingsPage(settings, db, flash, flashType) {
  const body = `<form class="a-form" method="post" action="/owner/settings">
    <div class="a-panel"><h2>Доступ владельца</h2>
      <div class="a-form-grid">
        <div class="field"><label>Логин</label><input name="ownerUsername" value="${esc(settings.ownerUsername)}"></div>
        <div class="field"><label>Новый пароль (пусто — не менять)</label><input name="ownerPassword" type="password" autocomplete="new-password" minlength="10" maxlength="500"><span class="muted small">Не менее 10 символов.</span></div>
      </div>
      <p class="muted small">Панель владельца открывается по адресу <b>/owner</b> и не зависит от домена.</p>
    </div>
    <div class="a-panel"><h2>Подсказки адресов</h2>
      <div class="a-form-grid">
        <div class="field"><label>Ключ dadata.ru (API-ключ «Подсказок»)</label>
          <input name="dadataToken" value="${esc(settings.dadataToken || '')}" placeholder="пусто — подсказок не будет" autocomplete="off"></div>
      </div>
      <p class="muted small">Ключ берётся в личном кабинете <a class="link" href="https://dadata.ru/profile/#info" target="_blank" rel="noopener noreferrer">dadata.ru</a> и работает на всех доменах сразу.
      Он хранится только на сервере: браузер покупателя спрашивает подсказки у нас, а в DaData ходит уже сервер. Без ключа поле адреса на оформлении остаётся обычным вводом.</p>
    </div>
    <div class="a-panel"><h2>Онлайн-оплата (CrocoPAY)</h2>
      <div class="field field-check"><label><input type="checkbox" name="crocopayEnabled"${settings.crocopayEnabled ? ' checked' : ''}> Принимать оплату на витрине</label></div>
      <div class="a-form-grid">
        <div class="field"><label>Client ID кассы</label>
          <input name="crocopayClientId" value="${esc(settings.crocopayClientId || '')}" placeholder="пусто — оплаты не будет" autocomplete="off" spellcheck="false"></div>
        <div class="field"><label>Client Secret кассы</label>
          <input name="crocopayClientSecret" value="${esc(settings.crocopayClientSecret || '')}" placeholder="пусто — оплаты не будет" autocomplete="off" spellcheck="false"></div>
      </div>
      <p class="muted small">Ключи берутся в кабинете <a class="link" href="https://crocopay.tech/merchants" target="_blank" rel="noopener noreferrer">CrocoPAY</a>: «Кассы» → иконка шестерни у нужной кассы. Работают на всех доменах сразу.
      Схема — H2H: счёт выставляем мы, покупатель платит переводом по реквизитам, не уходя с витрины. Номер его карты мы не спрашиваем и не получаем. Ключи хранятся только на сервере и на витрину не попадают.</p>
      <p class="muted small">Валюта всегда <b>рубли</b>: касса магазина рублёвая, а способ оплаты (СБП, перевод на карту и прочие) покупатель выбирает сам — показываются те, что включены у кассы.</p>
      <p class="muted small">Галочка снята или ключи пусты — витрина работает как раньше: заявка, менеджер связывается. Уже оформленные заказы это не затрагивает.
      Состояние платежа видно в списке заказов: касса отдаёт настоящий статус счёта, поэтому «счёт истёк» и «оплата отменена» там тоже появляются, а не только «оплачено».</p>
      ${settings.crocopayEnabled && !(String(settings.crocopayClientId || '').trim() && String(settings.crocopayClientSecret || '').trim())
        ? '<p class="form-msg err">Оплата включена, но ключи кассы не заданы — на витрине она не показывается.</p>' : ''}
    </div>
    <div class="a-form-actions"><button class="btn btn-primary" type="submit">Сохранить</button></div>
  </form>`;
  return layout({ active: 'settings', title: 'Настройки владельца', pendingCount: db.pendingReviewCount(), flash, flashType, body });
}

module.exports = { loginPage, dashboard, productsList, productForm, reviewsList, addReviewForm, sitesList, siteForm, ordersList, analyticsPage, settingsPage };
