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
// Касса: одна и та же `enabled()` решает, что показывает витрина и что пишет
// про свой режим панель — разъехавшись, они рассказывали бы разное об одном.
const PAYMENTS = require('./payments');
const CROCO = require('./crocopay');
const MERIDIAN = require('./meridianpay');
const DELIVERY = require('./delivery');
// Скидка процентом: панель показывает её в списке и правит в форме товара.
const D = require('./discount');
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
  // Меню — одна кнопка в шапке и выпадающий под ней список разделов.
  //
  // Сделано на <details>, а не на скрипте: без JS список всё равно
  // раскрывается, закрыт он по умолчанию (а значит, ничем не моргает на
  // загрузке) и с клавиатуры ведёт себя как обычная кнопка. Скрипту
  // (public/admin-ui.js) остаётся закрывать его по клику мимо и по Esc.
  //
  // Счётчик очереди продублирован на самой кнопке: со свёрнутым меню он иначе
  // не виден вовсе, а «сколько ждёт модерации» — единственное в панели, что
  // нужно знать, не открывая раздел.
  const menu = `<details class="a-menu" id="a-menu">
      <summary class="a-menu-btn" title="Разделы" aria-label="Разделы">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" aria-hidden="true"><path d="M4 6.5h16M4 12h16M4 17.5h16"/></svg>
        ${pending ? `<span class="a-menu-dot">${pending}</span>` : ''}
      </summary>
      <div class="a-menu-drop">
        <div class="a-menu-brand">${esc(settings.storeName || 'Магазин')}<span>панель управления</span></div>
        <nav class="a-nav">${nav}</nav>
        <div class="a-menu-foot"><a class="a-nav-item" href="/" target="_blank" rel="noopener noreferrer">Открыть витрину ↗</a></div>
      </div>
    </details>`;
  return `<!DOCTYPE html><html lang="ru"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(settings.storeName || 'Магазин')} · ${esc(opts.title || '')}</title>
<meta name="robots" content="noindex, nofollow">
<link rel="stylesheet" href="/static/styles.css?v=${R.assetV('styles.css')}">${shellStyle(settings)}</head>
<body class="admin">
<div class="a-shell">
  <main class="a-main">
    <div class="a-topbar">${menu}<h1>${esc(opts.title || '')}</h1>${opts.actions || ''}</div>
    ${opts.flash ? `<div class="a-flash ${esc(opts.flashType || 'ok')}">${esc(opts.flash)}</div>` : ''}
    <div class="a-content${opts.wide ? ' a-content-wide' : ''}">${accessibleBody}</div>
  </main>
</div>
<script>document.addEventListener('submit',function(e){var f=e.target;if(f.matches('[data-confirm]')&&!confirm(f.getAttribute('data-confirm')))e.preventDefault();});</script>
<script src="/static/admin-ui.js?v=${R.assetV('admin-ui.js')}" defer></script>
<script src="/static/media-lightbox.js?v=${R.assetV('media-lightbox.js')}" defer></script>
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

// Сколько заявок показывать на «Обзоре». Восемь строк таблицы занимали экран
// целиком; строка списка вдвое ниже, но и шести хватает: за остальными идут в
// раздел заказов.
const RECENT_ORDERS = 6;

function dashboard(settings, db) {
  const products = db.getProducts();
  const shown = db.visibleProducts().length;
  const orders = db.visibleOrders();
  const pending = db.pendingReviewCount();
  // Сводка по оплате — та же, что над списком заказов: «Обзор» отвечает на тот
  // же вопрос, и два разных вида одних и тех же счётчиков разъехались бы.
  const stats = R.orderStats(orders);
  /* Последние заказы — списком, а не таблицей в четыре столбца: на телефоне
   * таблицу приходилось листать вбок, теряя из виду и номер, и сумму, а строк
   * здесь всего шесть.
   *
   * Строка ведёт в раздел заказов к якорю этой заявки: там она подсвечивается
   * (`tr:target`) и рядом лежит всё остальное — состав, адрес, техника.
   */
  const recent = orders.slice(0, RECENT_ORDERS).map(o => `<a class="o-recent-row ${R.orderRowClass(o)}" href="/admin/orders#order-${esc(o.id)}">
      <div class="o-recent-num"><b>${esc(R.orderNo(o.number))}</b><span class="muted small">${R.formatDate(o.createdAt)}</span></div>
      <div class="o-recent-state">${R.orderStatus(o)}</div>
      <div class="o-recent-who">${esc([o.customerName, R.phoneText(o.phone) || o.contact].filter(Boolean).join(' · ') || 'Без контакта')}</div>
      <div class="o-recent-sum">${R.money(o.total, settings)}</div>
    </a>`).join('');
  // Порядок блоков: деньги, последние заявки, потом всё остальное. «Обзор»
  // открывают, чтобы узнать, что с заказами, — карточки каталога и отзывов
  // между сводкой и списком разрывали бы этот рассказ надвое.
  const body = `
    ${R.orderStatsBar(stats, settings)}
    <div class="a-panel"><div class="a-panel-head"><h2>Последние заказы</h2><a class="link" href="/admin/orders">Все заказы →</a></div>
      ${recent ? `<div class="o-recent">${recent}</div>` : '<p class="muted o-recent-empty">Заказов пока нет</p>'}</div>
    <div class="a-cards">
      <a class="a-stat" href="/admin/products"><div class="a-stat-num">${shown}${shown === products.length ? '' : '/' + products.length}</div><div class="a-stat-label">Товаров на витрине</div><div class="a-stat-sub">${shown === products.length ? 'показаны все' : 'скрыто ' + (products.length - shown)}</div></a>
      <a class="a-stat" href="/admin/reviews"><div class="a-stat-num">${pending}</div><div class="a-stat-label">Отзывов на модерации</div><div class="a-stat-sub">${pending ? 'ждут ответа' : 'очередь разобрана'}</div></a>
      <a class="a-stat a-stat-link" href="/admin/analytics"><div class="a-stat-num">Метрика</div><div class="a-stat-label">Посетители и источники</div></a>
    </div>`;
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
    const pct = D.discountPct(p);
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
      <td>${hidden ? '<span class="pill off">скрыт</span> ' : ''}${pct ? `<span class="pill ok">−${pct}%</span>` : ''} ${r.count
        ? `<a href="/admin/reviews/product/${encodeURIComponent(p.id)}" title="Отзывы товара">★ ${r.avg} (${r.count})</a>`
        : ''}</td>
      <td class="a-actions">
        <a class="btn btn-sm" href="/admin/products/${esc(p.id)}/edit">Изменить</a>
        <a class="btn btn-sm" href="/admin/reviews/new?productId=${encodeURIComponent(p.id)}">+ Отзыв</a>
        <form method="post" action="/admin/products/${esc(p.id)}/delete" data-confirm="Удалить товар «${esc(p.name)}» из каталога?"><button class="btn btn-sm btn-danger">Удалить</button></form>
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
  const p = product || { name: '', category: '', price: '', inStock: true, visible: true, stockLevel: 'in', shortDesc: '', description: '', specs: '', images: [], colors: [], storages: [], bands: [], options: [] };
  // Процент скидки: у старых товаров его ещё нет, и он выводится из сохранённой
  // пары цен — иначе форма показала бы «скидки нет» у товара, который на витрине
  // её показывает, а первое же сохранение эту скидку и стёрло бы.
  const pct = product ? D.discountPct(product) : 0;
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
  <form class="a-form product-form" data-product-form method="post" action="${isEdit ? '/admin/products/' + encodeURIComponent(product.id) : '/admin/products'}" enctype="multipart/form-data">
    ${errors.length ? `<div class="form-alert" role="alert"><b>Не сохранено.</b> ${errors.length === 1 ? 'Поправьте одно поле:' : 'Поправьте поля:'}
      <ul>${errors.map(e => `<li>${esc(e.text)}</li>`).join('')}</ul></div>` : ''}

    ${section('Основное', 'Название и категория видны покупателю в каталоге.', `
      <div class="a-form-grid">
        ${field('name', 'Название', `<input name="name" value="${esc(val('name', p.name))}" placeholder="iPhone 17 Pro" required autofocus>`)}
        ${field('category', 'Категория', `<input name="category" value="${esc(val('category', p.category))}" list="cats" placeholder="iPhone" required><datalist id="cats">${cats.map(c => `<option value="${esc(c)}">`).join('')}</datalist>`, 'Начните вводить — подскажет существующие')}
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

    ${section('Цена', 'Скидка задаётся процентом — одним на все конфигурации. Старая цена из него выводится и правке не подлежит.', `
      <div class="a-form-grid">
        ${field('price', 'Цена продажи', `<div class="price-field"><input name="price" type="number" min="1" step="1" value="${esc(val('price', p.price))}" placeholder="89990" required><span>₽</span></div>`, 'Столько платит покупатель за базовую сборку')}
        ${field('discountPercent', 'Скидка', `<div class="price-field"><input name="discountPercent" id="discount-pct" type="number" min="0" max="${D.MAX_PCT}" step="1" value="${esc(val('discountPercent', pct || ''))}" placeholder="0"><span>%</span></div>`, `0 — скидки нет. Больше ${D.MAX_PCT}% не бывает`)}
      </div>
      <p class="price-preview" id="price-preview" hidden></p>
      <p class="field-hint">Процент один на весь товар, поэтому у дорогой сборки выгода в рублях больше, а «−${esc(String(pct || 10))}%» на витрине везде одинаковые. Зачёркнутая цена считается как «цена ÷ (1 − процент)» и хранится не отдельным числом, а выводится каждый раз заново — иначе она разошлась бы с ценой при первой же её правке.</p>
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
   Раздел устроен в два уровня. На входе — только очередь модерации: то, что
   ждёт решения, и ничего больше, потому что это единственное здесь дело со
   сроком. Под ней — товары, у каждого свой список: разбирать семь тысяч отзывов
   одной лентой невозможно, а «что пишут про 17 Pro Max» — обычный вопрос.
   Вкладки и сортировка живут там, в ленте товара: на входе выбирать нечего. */

// Вкладки ленты товара. Порядок и подписи в одном месте: страница у них теперь
// одна, но расходиться со списком состояний отзыва они не должны.
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
// Сортировка та же, что на витрине, и подписи берутся оттуда же (`REVIEW_SORTS`
// в lib/render.js): «Новые» в панели и «Новые» на витрине обязаны означать одно
// и то же, а разъехавшиеся подписи — первый признак двух разных реализаций.
function reviewSorts(current, href) {
  return `<div class="a-sorts"><span class="muted small">Сортировка:</span>${R.REVIEW_SORTS.map(([key, label]) =>
    `<a class="a-sort${current === key ? ' active' : ''}" href="${href(key)}">${label}</a>`).join('')}</div>`;
}
/* Отбор по вложениям: с видео, только с фото, без медиа.
 *
 * Это не сортировка, а именно отбор, и вопрос он решает свой: вкладка отвечает
 * «что показываем» (состояние), сортировка — «в каком порядке», а этот ряд —
 * «что внутри». Разбирать ленту иначе нельзя: ролики стоят по своим местам в
 * раскладке (lib/review-dates.js), и найти их среди тысячи отзывов, листая
 * страницы по восемь, невозможно.
 *
 * Наборы НЕ пересекаются — это разбиение, а не три галочки: отзыв с видео и
 * фотографиями лежит в «С видео», иначе он попадался бы дважды и счётчики не
 * сходились бы с длиной списка. Отсюда и подпись «Только фото».
 */
const REVIEW_MEDIA = [['all', 'Все'], ['video', 'С видео'], ['photo', 'Только фото'], ['none', 'Без медиа']];
const REVIEW_MEDIA_KEYS = REVIEW_MEDIA.map(([k]) => k);
function reviewMedia(value, fallback) {
  return REVIEW_MEDIA_KEYS.includes(String(value)) ? String(value) : (fallback || 'all');
}
function hasVideo(rv) { return !!(rv && rv.videos && rv.videos.length); }
function hasPhoto(rv) { return !!(rv && rv.photos && rv.photos.length); }
function filterByMedia(list, media) {
  if (media === 'video') return list.filter(hasVideo);
  if (media === 'photo') return list.filter(rv => !hasVideo(rv) && hasPhoto(rv));
  if (media === 'none') return list.filter(rv => !hasVideo(rv) && !hasPhoto(rv));
  return list;
}
// Счётчик у каждого набора: без него «С видео» приходится открывать, чтобы
// узнать, есть ли там хоть что-то, — а роликов у товара полтора десятка на
// тысячу отзывов.
function reviewMediaTabs(current, list, href) {
  const count = key => filterByMedia(list, key).length;
  return `<div class="a-sorts a-media"><span class="muted small">Вложения:</span>${REVIEW_MEDIA.map(([key, label]) =>
    `<a class="a-sort${current === key ? ' active' : ''}" href="${href(key)}">${esc(label)}<i>${count(key)}</i></a>`).join('')}</div>`;
}

// Панель списка: вкладки слева, сортировка и отбор по вложениям справа. Тремя
// рядами они занимали бы три строки на ровном месте, а на телефоне всё равно
// встают друг под другом и прокручиваются вбок.
function reviewToolbar(tabs, sorts, media) {
  return `<div class="a-toolbar">${tabs}${sorts || ''}${media || ''}</div>`;
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
    + `<input type="hidden" name="sort" value="${esc(back.sort || '')}">`
    + (back.media ? `<input type="hidden" name="media" value="${esc(back.media)}">` : '')
    + (back.product ? `<input type="hidden" name="product" value="${esc(back.product)}">` : '');
}
function backQuery(back) {
  const params = [
    `tab=${encodeURIComponent(back.status || '')}`,
    `sort=${encodeURIComponent(back.sort || '')}`,
    `page=${Math.max(1, Math.floor(Number(back.page)) || 1)}`
  ];
  // Отбор по вложениям возвращается вместе с остальным: разбирая ленту роликов,
  // после каждого действия оказываться снова во «Всех» — то же, что терять место.
  if (back.media && back.media !== 'all') params.push('media=' + encodeURIComponent(back.media));
  if (back.product) params.push('product=' + encodeURIComponent(back.product));
  return params.join('&amp;');
}

// Вложения отзыва одним списком: сначала ролики, потом снимки — тот же порядок,
// что и на витрине, чтобы номер кадра в просмотрщике совпадал с увиденным.
function reviewFileList(rv) {
  return (rv.videos || []).filter(Boolean).map(f => ({ f, video: true }))
    .concat((rv.photos || []).filter(Boolean).map(f => ({ f, video: false })));
}
// Что показать в квадратике: лёгкое превью, а у ролика — кадр из него. Полный
// файл грузится только в просмотрщике: в списке вложений до полусотни, и
// полноразмерные фото весом по четверти мегабайта сделали бы страницу панели
// тяжелее всей витрины. Превью нет (старая запись, не было ImageMagick) — у
// фото показываем сам снимок, у ролика подпись.
function thumbInner(rv, it, size) {
  const src = (rv.previews || {})[it.f] || (it.video ? (rv.poster || '') : it.f);
  return src
    ? `<img src="/uploads/${esc(src)}" alt="" loading="lazy" decoding="async" width="${size}" height="${size}">`
    : '<span class="rv-thumb-cap">MP4</span>';
}

// Вложения строкой квадратиков. Ссылки настоящие: без скрипта клик открывает
// файл, как раньше. Со скриптом открывается тот же просмотрщик, что и на
// витрине (public/media-lightbox.js) — по `data-media` у группы и `data-kind`
// у вложения.
const THUMB_LIMIT = 6;
function reviewThumbs(rv) {
  const items = reviewFileList(rv);
  if (!items.length) return '';
  const shown = items.slice(0, THUMB_LIMIT);
  const rest = items.length - shown.length;
  const link = (it, opts) => `<a class="rv-thumb${opts.cls || ''}" href="/uploads/${esc(it.f)}"`
    + ` data-kind="${it.video ? 'video' : 'photo'}" target="_blank" rel="noopener"`
    + `${opts.hidden ? ' hidden' : ''} aria-label="${esc(opts.label)}">${opts.inner || ''}</a>`;
  const tiles = shown.map(it => link(it, {
    cls: it.video ? ' is-video' : '', inner: thumbInner(rv, it, 80),
    label: it.video ? 'Видео к отзыву' : 'Фото к отзыву'
  })).join('');
  // «+N» — это уже седьмое вложение, а не отдельная кнопка: клик по нему
  // открывает просмотр ровно с него. Остальные идут следом ссылками БЕЗ
  // картинок и скрытыми: галерея обязана содержать все вложения, иначе с
  // седьмого кадра листать было бы некуда, — но грузить полсотни превью ради
  // строки списка незачем.
  const more = rest > 0
    ? link(items[THUMB_LIMIT], { cls: ' rv-thumb-more', inner: `+${rest}`, label: `Ещё вложений: ${rest}` })
      + items.slice(THUMB_LIMIT + 1).map(it => link(it, { hidden: true, label: 'Вложение к отзыву' })).join('')
    : '';
  return `<div class="rv-thumbs" data-media>${tiles}${more}</div>`;
}

/* Ответ магазина прямо в строке списка.
 *
 * Отвечают там же, где разбирают очередь: уводить ради двух строк текста в
 * форму правки, а оттуда возвращаться обратно — это три перехода на один ответ.
 * Форма целиком на <details>, ни строчки скрипта: свёрнутая строка держит
 * список компактным, а работает она и там, где скрипты панели не загрузились.
 *
 * Свёрнутый вид сам показывает состояние: у отвеченного отзыва в подписи стоит
 * начало ответа, у остальных — «Ответить». Открывать строку, чтобы узнать, есть
 * ли ответ, не нужно.
 *
 * Удаление ответа — вторая кнопка отправки в той же форме (`drop`): браузер
 * шлёт имя только нажатой кнопки, поэтому второй формы (а её пришлось бы класть
 * вне этой — вложенных форм не бывает) не потребовалось.
 */
const REPLY_GLYPH = '<path d="M20.3 4.6H3.7v11.9h4.1v3.9l4.6-3.9h7.9z"/>';
function replyIcon(cls) {
  return `<svg class="${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"`
    + ` stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${REPLY_GLYPH}</svg>`;
}
function reviewReplyBox(rv, back) {
  const text = String(((rv.reply || {}).text) || '').trim();
  const answered = !!text;
  return `<details class="rv-reply${answered ? ' is-answered' : ''}">
      <summary class="rv-reply-sum">
        ${replyIcon('rv-reply-ico')}
        ${answered
          ? `<span class="rv-reply-peek"><b>Ответ магазина</b><i class="rv-reply-cut">: ${esc(text)}</i></span>`
          : '<span class="rv-reply-peek rv-reply-none">Ответа магазина пока нет</span>'}
        <span class="rv-reply-more">${answered ? 'Изменить ответ' : 'Ответить'}</span>
      </summary>
      <form class="rv-reply-form" method="post" action="/admin/reviews/${esc(rv.id)}/reply">
        ${backFields(back)}
        <div class="field"><label class="sr-only" for="reply-${esc(rv.id)}">Ответ магазина</label>
          <textarea id="reply-${esc(rv.id)}" name="reply" rows="3" maxlength="2000" placeholder="Спасибо за отзыв! Рады, что всё подошло.">${esc(text)}</textarea></div>
        <div class="rv-reply-acts">
          <button class="btn btn-sm btn-primary" type="submit">${answered ? 'Сохранить ответ' : 'Опубликовать ответ'}</button>
          ${answered ? `<button class="btn btn-sm btn-danger" type="submit" name="drop" value="1">Удалить ответ</button>` : ''}
          <span class="rv-reply-note muted small">Ответ виден всем на странице товара.</span>
        </div>
      </form>
    </details>`;
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
    ${reviewReplyBox(rv, back)}
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

/* Вход в раздел — ТОЛЬКО очередь модерации, без вкладок, сортировки и подсказок.
 *
 * Одобрить или отклонить — единственное дело здесь, у которого есть срок, и
 * выбирать в нём нечего: очередь идёт свежими сверху. Вкладки «Опубликованные»
 * и «Все» на входе отвечали на вопрос, который на этой странице не задают:
 * лента конкретного товара открывается плиткой ниже, и вкладки с сортировкой
 * есть там. Абзац-подсказка объяснял ровно то, что и так видно по подсветке
 * строк.
 *
 * Разобранная очередь блока не оставляет вовсе: пустая карточка со словами
 * «всё разобрано» занимала первый экран ради сообщения «делать нечего».
 * Разобрал — сразу отзывы по товарам.
 */
function reviewsList(settings, db, flash, page) {
  const products = {}; db.getProducts().forEach(p => products[p.id] = p);
  // Страницами: весь список разом — это мегабайты разметки и секунды блокировки
  // единственного потока, то есть замершая витрина для всех посетителей.
  const waiting = R.sortReviews(filterByStatus(db.getReviews(), 'pending'), 'new');
  const slice = R.adminSlice(waiting, page);
  // Вкладку и сортировку формы действий несут прежние: возврат после «Одобрить»
  // обязан вести в очередь, а не в общую ленту.
  const back = { status: 'pending', page: slice.page, sort: 'new' };
  const pager = R.adminPager(slice, n => `/admin/reviews?page=${n}`);
  const queue = slice.total
    ? `<div class="a-panel">${reviewRows(slice, products, back, { showProduct: true })}${pager}</div>`
    : '';
  return layout(settings, { active: 'reviews', title: 'Отзывы', pendingCount: db.pendingReviewCount(),
    actions: `<a class="btn btn-primary" href="/admin/reviews/new">+ Добавить отзыв</a>`,
    flash, body: queue + reviewProducts(db) });
}

// Отзывы одного товара. Открывается с плитки товара и из строки общей ленты.
function productReviews(settings, db, product, statusFilter, flash, page, sort, media) {
  const products = { [product.id]: product };
  // Здесь по умолчанию видно всё: товар открывают, чтобы посмотреть его ленту
  // целиком, а не только непрочитанное.
  const status = reviewTab(statusFilter, 'all');
  const mode = R.reviewSortMode(sort);
  const kind = reviewMedia(media, 'all');
  const all = db.reviewsForProduct(product.id, false);
  // Состояние отбирается первым, вложения — вторым: счётчики у вложений должны
  // считаться в пределах открытой вкладки, иначе «С видео 16» на вкладке
  // «На модерации» обещает то, чего там нет.
  const byStatus = filterByStatus(all, status);
  const slice = R.adminSlice(R.sortReviews(filterByMedia(byStatus, kind), mode), page);
  const back = { status, page: slice.page, product: product.id, sort: mode, media: kind };
  const root = `/admin/reviews/product/${encodeURIComponent(product.id)}`;
  const base = (k, m, v) => `${root}?status=${encodeURIComponent(k)}&amp;sort=${encodeURIComponent(m)}&amp;media=${encodeURIComponent(v)}`;
  const pager = R.adminPager(slice, n => `${base(status, mode, kind)}&amp;page=${n}`);
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
    ${reviewToolbar(reviewTabs(status, k => base(k, mode, kind)), reviewSorts(mode, m => base(status, m, kind)), reviewMediaTabs(kind, byStatus, v => base(status, mode, v)))}
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

  // Вложения: снимок открывается тем же просмотрщиком, что и на витрине (клик
  // по плитке), а крестик в углу помечает вложение к удалению. Пометка — обычный
  // чекбокс с подписью-меткой, ни строчки скрипта: форма работает и там, где
  // скрипты панели не загрузились, и удаляется всё одним сохранением.
  //
  // Поэтому плитка НЕ обёрнута в <label> целиком, как была: тогда клик по
  // снимку и помечал бы его к удалению, и открывал просмотр разом.
  //
  // Новые ролики через панель не заливаются: multipart принимает только
  // картинки (проверка по сигнатуре файла в lib/server-lib.js).
  const files = reviewFileList(rv);
  const tiles = files.map((it, i) => {
    const id = `drop-${i}`;
    return `<div class="rv-file">
      <input type="checkbox" id="${id}" name="drop" value="${esc(it.f)}">
      <a class="rv-file-body" href="/uploads/${esc(it.f)}" data-kind="${it.video ? 'video' : 'photo'}" target="_blank" rel="noopener"
        aria-label="Открыть ${it.video ? 'видео' : 'фото'}">${thumbInner(rv, it, 120)}</a>
      <label class="rv-file-x" for="${id}" title="Отметить к удалению"><span aria-hidden="true">✕</span><span class="sr-only">Удалить ${it.video ? 'видео' : 'фото'}</span></label>
      <label class="rv-file-cap" for="${id}"><i class="rv-keep">${it.video ? 'видео' : 'фото'}</i><i class="rv-gone">удалить</i></label>
    </div>`;
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
        <div class="field"><label>Ответ магазина</label><textarea name="reply" rows="3" maxlength="2000" placeholder="Спасибо за отзыв! Рады, что всё подошло.">${esc(((rv.reply || {}).text) || '')}</textarea>
          <span class="field-note">Виден всем под отзывом на странице товара. Пустое поле — ответа нет; так он и удаляется.</span></div>
      </div>
      <div class="rv-form-col rv-form-media">
        <label class="rv-form-sub">Вложения${files.length ? ` <span class="muted small">${files.length}</span>` : ''}</label>
        ${files.length ? `<div class="rv-files" data-media>${tiles}</div><span class="field-note">Нажмите на вложение, чтобы посмотреть. Отмеченные крестиком удалятся при сохранении — вместе с самими файлами.</span>` : '<p class="muted small">Пока ничего не приложено.</p>'}
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
function ordersList(settings, db, flash, page, view) {
  const archiveView = String(view || '') === 'archive';
  const activeOrders = db.visibleOrders();
  const archived = typeof db.archivedOrders === 'function'
    ? db.archivedOrders()
    : (typeof db.getOrders === 'function' ? db.getOrders().filter(o => o && o.archive && o.archive.active === true) : []);
  const orders = archiveView ? archived : activeOrders;
  const slice = R.adminSlice(orders, page);
  const pager = R.adminPager(slice, n => archiveView
    ? `/admin/orders?view=archive&page=${n}` : `/admin/orders?page=${n}`);
  const rows = slice.items.map(o => {
    // Возврат на ту же страницу: после удаления на 7-й странице админ не должен
    // оказываться в начале списка.
    const back = `<input type="hidden" name="page" value="${slice.page}">`
      + `<input type="hidden" name="view" value="${archiveView ? 'archive' : 'active'}">`;
    // Класс тона красит строку по состоянию оплаты: оплаченную от отменённой
    // надо отличать с одного взгляда, не вчитываясь в плашку статуса.
    const warning = o.payment
      ? 'Удалить заказ из списка? Уже выданный счёт у кассы не отменится. Платёжная история сохранится, а при поступлении денег заказ вернётся автоматически.'
      : 'Удалить заказ из списка? Его можно будет восстановить в разделе «Удалённые».';
    const remove = archiveView
      ? `<form method="post" action="/admin/orders/${esc(o.id)}/restore">${back}<button class="btn btn-sm" aria-label="Восстановить заказ" title="Восстановить заказ">Вернуть</button></form>`
      : `<form method="post" action="/admin/orders/${esc(o.id)}/delete" data-confirm="${esc(warning)}">${back}<button class="btn btn-sm btn-danger" aria-label="Удалить заказ" title="Удалить заказ">✕</button></form>`;
    const archivedAt = archiveView && o.archive && Number(o.archive.at) > 0
      ? `<span class="muted small">Удалён ${R.formatDate(o.archive.at)}</span>` : '';
    return `<tr id="order-${esc(o.id)}" class="${R.orderRowClass(o)}">
      <td class="o-num"><b>${esc(R.orderNo(o.number))}</b><span class="muted small">${R.formatDate(o.createdAt)}</span>${archivedAt}</td>
      <td class="o-client">${R.orderClient(o, { metricsBase: VISITOR_BASE, money: settings })}</td>
      <td class="o-items">${R.orderItems(o)}</td>
      <td class="o-state">${R.orderStatus(o)}</td>
      <td class="o-pay">${R.orderPayMethod(o)}</td>
      <td class="o-sum"><b>${R.money(o.total, settings)}</b></td>
      <td class="o-act">${remove}</td></tr>`;
  }).join('') || `<tr><td colspan="7" class="muted">${archiveView ? 'Удалённых заказов нет.' : 'Заказов нет.'}</td></tr>`;
  const switcher = `<nav class="o-list-switch" aria-label="Список заказов">
    <a href="/admin/orders"${archiveView ? '' : ' aria-current="page"'}>Текущие <b>${activeOrders.length}</b></a>
    <a href="/admin/orders?view=archive"${archiveView ? ' aria-current="page"' : ''}>Удалённые <b>${archived.length}</b></a>
  </nav>`;
  return layout(settings, { active: 'orders', title: 'Заказы', pendingCount: db.pendingReviewCount(), flash,
    // Сводка стоит НАД панелью, а не внутри неё: столбец удаления показывается
    // правилом `.edit-switch:checked ~ .a-orders`, и чужой блок между ними
    // разорвал бы цепочку соседей. Счётчики считаются по всему списку, а не по
    // показанной странице: «оплачено 12» на седьмой странице означало бы
    // двенадцать из пятидесяти.
    body: switcher + R.orderStatsBar(R.orderStats(orders), settings)
      + `<div class="a-panel">${R.editSwitch('orders-edit')}<table class="a-table a-orders"><thead><tr><th>Заказ</th><th>Клиент</th><th>Состав</th><th>Статус</th><th>Оплата</th><th class="o-sum">Сумма</th><th class="o-act"><span class="sr-only">Удалить</span></th></tr></thead><tbody>${rows}</tbody></table>${pager}</div>`
      // Статистика по кассам идёт ПОД списком: разбирают заказы каждый день, а
      // сравнивают кассы раз в месяц. Считается она по всем заказам, а не по
      // показанной странице — как и сводка выше.
      + R.providerStatsBar(R.providerStats(orders)) });
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

/* ---------------------- Кассы: валюта счёта и способы ----------------------
 *
 * И то и другое приходит ЖИВЫМ ответом касс, а не берётся из зашитого списка: у
 * кассы способ могли включить или выключить, а встроенный список правится только
 * выкаткой. Отвечают обе, и их возможности ОБЪЕДИНЯЮТСЯ — способ доступен, если
 * его умеет хотя бы одна.
 *
 * Не ответил никто (ключей нет, оплата выключена, сеть) — показываем встроенный
 * список и прямо об этом говорим.
 */

// Что показать в списке способов: объединение трёх наборов — включённого у
// кассы, нашего закрытого и уже отмеченного владельцем. Последнее обязательно:
// иначе способ, который касса временно выключила, исчез бы из формы и первым же
// «Сохранить» пропал бы из настроек молча.
function payMethodRows(shown, live) {
  const cassa = live ? Object.keys(live.byCurrency).reduce((all, cur) => all.concat(live.byCurrency[cur]), []) : [];
  const ids = [];
  for (const id of PAY.METHODS.map(m => m.id).concat(cassa, shown)) {
    if (id && !ids.includes(id)) ids.push(id);
  }
  return ids.map(id => {
    const m = PAY.describe(id);
    // В каких валютах этот способ включён — показываем, только когда валют
    // больше одной: иначе это «RUB» у каждой строки и чистый шум.
    const where = live && live.currencies.length > 1
      ? live.currencies.filter(c => live.byCurrency[c].includes(id)) : [];
    // Какие кассы умеют этот способ. Строка «СБП · CrocoPAY, MeridianPay»
    // отвечает на единственный вопрос, который здесь и задают: есть ли у него
    // подстраховка. Способ, который умеет одна касса, при её отказе просто не
    // сработает — и знать это лучше заранее, чем по жалобе покупателя.
    const via = live && live.byProvider
      ? Object.keys(live.byProvider).filter(pid => {
        const own = live.byProvider[pid];
        return own && Object.keys(own.byCurrency).some(c => own.byCurrency[c].includes(id));
      }).map(pid => PAYMENTS.nameOf(pid))
      : [];
    return {
      id, name: m.name, hint: m.hint,
      // Кассы ответили, и этого способа нет ни у одной: строку оставляем (выбор
      // владельца не теряем), но говорим, что на витрину он не попадёт.
      off: !!live && !cassa.includes(id),
      fresh: !!m.unknown,
      where, via
    };
  });
}

/* Пояснительных подсказок в этом разделе нет намеренно — их убрали все.
 *
 * Состояние по-прежнему читается, но не абзацами, а самой строкой способа:
 * пометки «новый у кассы» / «нет у касс» и перечисленные рядом кассы говорят то
 * же, что говорил абзац под списком. Ошибка «не отмечен ни один способ» —
 * не подсказка, а отказ, и остаётся на месте.
 */
function payMethodsSection(shown, live) {
  const rows = payMethodRows(shown, live);
  return `<h3 class="a-subhead">Способы оплаты на витрине</h3>
      <input type="hidden" name="payMethodsForm" value="1">
      <div class="pay-methods-grid">${rows.map(r => `<label class="pay-method-check${r.off ? ' is-off' : ''}">
        <input type="checkbox" name="payMethods" value="${esc(r.id)}"${shown.includes(r.id) ? ' checked' : ''}>
        <span><b>${esc(r.name)}${r.fresh ? '<em class="pay-method-tag">новый у кассы</em>' : ''}${r.off ? '<em class="pay-method-tag pay-method-tag-off">нет у касс</em>' : ''}</b>
        <i>${esc(r.hint)}${r.where.length ? ' · ' + esc(r.where.join(', ')) : ''}${r.via.length ? ' · ' + esc(r.via.join(', ')) : ''}</i></span></label>`).join('')}</div>
      ${shown.length ? '' : '<p class="form-msg err">Не отмечен ни один способ — оплатить на витрине будет нечем.</p>'}`;
}

// Валюта счёта и курс к рублю. Цены каталога рублёвые всегда: пересчитывается
// только сумма счёта, и курс задаёт владелец — внешних источников курса у
// проекта нет и заводить их ради этого незачем.
function payCurrencySection(s, saved, draft, live, checked) {
  const base = PAY.BASE;
  const picked = PAY.currencyCode(s.crocopayCurrency) || base;
  const list = [];
  for (const c of [base, picked].concat(live ? live.currencies : [])) {
    const code = PAY.currencyCode(c);
    if (code && !list.includes(code)) list.push(code);
  }
  const rates = Object.assign({}, saved.crocopayRates || {});
  // Курс введён только что и форма вернулась с ошибкой — показываем введённое.
  if (draft) for (const code of list) {
    if (draft['payrate:' + code] !== undefined) rates[code] = draft['payrate:' + code];
  }
  const rateRows = list.filter(c => c !== base).map(c => `<div class="field">
          <label for="payrate-${esc(c)}">Курс: 1 ${esc(PAY.currencySymbol(c))} = ? ₽</label>
          <input id="payrate-${esc(c)}" name="payrate:${esc(c)}" inputmode="decimal" autocomplete="off"
            value="${esc(rates[c] === undefined || rates[c] === null ? '' : String(rates[c]))}" placeholder="пусто — валюта недоступна"></div>`).join('');
  return `<h3 class="a-subhead">Валюта счёта</h3>
      <div class="a-form-grid">
        <div class="field"><label for="pay-currency">Валюта по умолчанию</label>
          <select id="pay-currency" name="crocopayCurrency">${list.map(c =>
            `<option value="${esc(c)}"${c === picked ? ' selected' : ''}>${esc(c)} — ${esc(PAY.currencyName(c))}</option>`).join('')}</select></div>
        <div class="field field-check"><label><input type="checkbox" name="crocopayCurrencyChoice"${checked('crocopayCurrencyChoice', !!saved.crocopayCurrencyChoice) ? ' checked' : ''}> Показывать покупателю выбор валюты</label></div>
      </div>
      ${rateRows ? `<div class="a-form-grid">${rateRows}</div>` : ''}`;
}

/*
 * Что витрина делает ПРЯМО СЕЙЧАС — одной плашкой над настройками кассы.
 *
 * Галочка отвечает на вопрос «включать ли оплату», а плашка — на вопрос «что
 * увидит покупатель», и это не одно и то же: включённая галочка без ключей
 * оставляет витрину в режиме заявок. Поэтому спрашиваем ту же `CROCO.enabled()`,
 * по которой решает и сама витрина, а не читаем галочку из настроек.
 *
 * Про пределы суммы плашка говорит намеренно: они принадлежат кассе, и вместе с
 * ней исчезают — на витрине это видно сразу (дорогие товары перестают быть
 * «Нет в наличии»), и объяснить это лучше здесь, чем оставить догадкам.
 */
/* Плашка режима — теперь ровно состояние, без объяснений.
 *
 * Раньше под жирной строкой шли три-четыре предложения про то, что увидит
 * покупатель и откуда берутся пределы суммы. Это подсказка: её читают один раз,
 * а видят каждый день. Осталось только то, чего иначе не узнать: включена
 * оплата или нет и какие кассы работают — с одной включённой подстраховать её
 * некому, и это стоит того, чтобы стоять на виду.
 */
function payModeNote(settings) {
  const on = PAYMENTS.enabledProviders(settings);
  if (!on.length) return '<p class="pay-mode is-off"><b>Сейчас: заявки без оплаты.</b></p>';
  const crew = on.length > 1
    ? `Работают обе кассы: ${esc(on.map(p => p.name).join(' и '))}.`
    : `Работает одна касса — ${esc(on[0].name)}, подстраховки нет.`;
  return `<p class="pay-mode is-on"><b>Сейчас: оплата на витрине.</b> ${crew}</p>`;
}

/* Диапазон суммы одного заказа.
 *
 * Числа принадлежат КАССЕ: за своими границами она платёж не проведёт. Но какие
 * они у конкретной кассы — знает только владелец, поэтому поля правятся здесь, а
 * не в коде. От потолка зависит не только оплата: товар дороже него на витрине
 * становится «Нет в наличии», и поднятие потолка возвращает в продажу дорогую
 * технику.
 *
 * Пустое поле возвращает значение по умолчанию, а не снимает предел: молча
 * снятый потолок означал бы заказы, которые касса не проведёт.
 */
function payLimitsSection(s, draft) {
  const value = (field, fallback) => {
    if (draft && draft[field] !== undefined) return String(draft[field]);
    const saved = Number(s[field]);
    return String(Number.isFinite(saved) && saved > 0 ? saved : fallback);
  };
  return `<h3 class="a-subhead">Сумма одного заказа</h3>
      <div class="a-form-grid">
        <div class="field"><label for="pay-min">Минимальная сумма, ₽</label>
          <input id="pay-min" name="payMinTotal" inputmode="numeric" autocomplete="off"
            value="${esc(value('payMinTotal', PAYMENTS.MIN_TOTAL))}" placeholder="${PAYMENTS.MIN_TOTAL}"></div>
        <div class="field"><label for="pay-max">Максимальная сумма, ₽</label>
          <input id="pay-max" name="payMaxTotal" inputmode="numeric" autocomplete="off"
            value="${esc(value('payMaxTotal', PAYMENTS.MAX_TOTAL))}" placeholder="${PAYMENTS.MAX_TOTAL}"></div>
      </div>`;
}

/* Включение касс — ОДНОЙ строкой и до всяких ключей.
 *
 * Это единственное решение в разделе, которое принимают часто: включить,
 * выключить, посмотреть, что сейчас работает. Оно обязано быть видно, ничего не
 * раскрывая. Раньше галочки лежали внутри свёрток, и чтобы включить кассу, надо
 * было сперва раскрыть строку «выключена» — то есть открыть секцию с ключами
 * ради того, чтобы ключей не трогать.
 *
 * Рядом друг с другом они ещё и сравниваются: «обе включены» видно одним
 * взглядом, а это и есть ответ на вопрос «есть ли у меня подстраховка».
 */
function payProviderSwitches(settings, checked) {
  const row = (id, label, field, on) => `<label class="pay-switch">
          <input type="checkbox" name="${esc(field)}"${checked(field, on) ? ' checked' : ''}> ${esc(label)}</label>`;
  return `<div class="pay-switches">
        ${row('crocopay', 'CrocoPAY', 'crocopayEnabled', !!settings.crocopayEnabled)}
        ${row('meridianpay', 'MeridianPay', 'meridianpayEnabled', !!settings.meridianpayEnabled)}
      </div>`;
}

/* Ключи одной кассы: свёртка, которую открывают раз в жизни.
 *
 * Свёрнутое содержимое браузер отправляет так же, как открытое, поэтому поля
 * внутри не теряются (та же грабля, что со строкой «нет у касс» в списке
 * способов).
 *
 * Раскрыта она РОВНО ТОГДА, когда с ней что-то не так: касса включена, а ключей
 * нет. В остальных случаях закрыта — ключи это секреты, и держать их развёрнутыми
 * на экране незачем, а две открытые секции подряд растягивают страницу настроек
 * вдвое.
 *
 * Подпись говорит состояние, а не повторяет галочку: «включена, но ключи не
 * заданы» — самый частый способ остаться без оплаты, и увидеть это надо не
 * открывая секцию.
 */
function payProviderFold(name, on, ready, body) {
  const state = on && ready ? 'работает' : on ? 'включена, но ключи не заданы' : 'выключена';
  return `<details class="pay-fold"${on && !ready ? ' open' : ''}>
        <summary>${esc(name)}<span class="pay-fold-note">${esc(state)}</span></summary>
        <div class="pay-fold-body">${body}</div>
      </details>`;
}

/* Какую кассу спрашивать первой.
 *
 * Показывается ВСЕГДА, при любом числе включённых касс. Была попытка прятать
 * выбор, пока включена одна, — «с одной кассой очередь состоит из неё же». Со
 * стороны это выглядит не как экономия места, а как пропавшая настройка: пока
 * вторая касса ждёт модерации, порядок задают заранее, и найти его на странице
 * надо тогда же, а не после того, как она заработает.
 *
 * Порядок виден только нам: покупатель в любом случае получает реквизиты от той
 * кассы, которая их дала. Ставят первой обычно ту, где ниже комиссия или полнее
 * пул реквизитов.
 */
function payPrimarySection(s) {
  const picked = PAYMENTS.providerIds().includes(String(s.payPrimary || '')) ? s.payPrimary : PAYMENTS.DEFAULT_ID;
  return `<h3 class="a-subhead">Порядок опроса</h3>
      <div class="a-form-grid">
        <div class="field"><label for="pay-primary">Спрашивать первой</label>
          <select id="pay-primary" name="payPrimary">${PAYMENTS.PROVIDERS.map(p =>
    `<option value="${esc(p.id)}"${p.id === picked ? ' selected' : ''}>${esc(p.name)}</option>`).join('')}</select></div>
      </div>`;
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
  // Живой ответ кассы: какие способы и валюты у неё РЕАЛЬНО включены. Не
  // ответила (нет ключей, оплата выключена, сеть) — `null`, и тогда показываем
  // встроенный список, честно сказав об этом.
  const live = opts.live && opts.live.ok ? opts.live : null;
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
    <div class="a-panel"><h2>Оплата на витрине</h2>
      ${payModeNote(settings)}
      ${payProviderSwitches(settings, checked)}
      ${payProviderFold('CrocoPAY', !!settings.crocopayEnabled, CROCO.configured(settings), `
      ${settings.crocopayEnabled && !CROCO.configured(settings)
        ? '<p class="form-msg err">Касса включена, но ключи не заданы — реквизиты она не выдаст.</p>' : ''}
      <div class="a-form-grid">
        <div class="field"><label>Client ID кассы</label>
          <input name="crocopayClientId" value="${esc(s.crocopayClientId || '')}" placeholder="пусто — касса не работает" autocomplete="off" spellcheck="false"></div>
        <div class="field"><label>Client Secret кассы</label>
          <input name="crocopayClientSecret" value="${esc(s.crocopayClientSecret || '')}" placeholder="пусто — касса не работает" autocomplete="off" spellcheck="false"></div>
      </div>`)}
      ${payProviderFold('MeridianPay', !!settings.meridianpayEnabled, MERIDIAN.configured(settings), `
      ${settings.meridianpayEnabled && !MERIDIAN.configured(settings)
        ? '<p class="form-msg err">Касса включена, но ключ или Merchant ID не заданы — реквизиты она не выдаст.</p>' : ''}
      <div class="a-form-grid">
        <div class="field"><label>Access-Token (API-ключ)</label>
          <input name="meridianpayApiKey" value="${esc(s.meridianpayApiKey || '')}" placeholder="пусто — касса не работает" autocomplete="off" spellcheck="false"></div>
        <div class="field"><label>Merchant ID (UUID мерчанта)</label>
          <input name="meridianpayMerchantId" value="${esc(s.meridianpayMerchantId || '')}" placeholder="00000000-0000-0000-0000-000000000000" autocomplete="off" spellcheck="false"></div>
        <div class="field"><label>Secret Key</label>
          <input name="meridianpaySecret" value="${esc(s.meridianpaySecret || '')}" placeholder="не обязателен" autocomplete="off" spellcheck="false"></div>
      </div>`)}
      ${payPrimarySection(s)}
      ${payLimitsSection(s, draft)}

      ${payCurrencySection(s, settings, draft, live, checked)}
      ${payMethodsSection(shownMethods, live)}
    </div>
    <div class="a-form-actions"><button class="btn btn-primary" type="submit">Сохранить</button></div>
  </form>
  <div class="a-panel a-exit">
    <form action="/admin/logout" method="post"><button class="btn" type="submit">Выйти из панели</button></form>
  </div>`;
  return layout(settings, { active: 'settings', title: 'Настройки', pendingCount: db.pendingReviewCount(), flash, flashType, body });
}

module.exports = { loginPage, dashboard, productsList, productForm, reviewsList, productReviews, reviewForm, ordersList, analyticsPage, visitorPage, settingsPage };
