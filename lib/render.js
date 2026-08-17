'use strict';
// Рендер витрины (сервер-сайд, обычные шаблонные строки — без движков и лишних зависимостей).
const fs = require('fs');
const path = require('path');
const D = require('./deals');
const T = require('./tenancy');
const V = require('./variants');

// Версия публичных юридических документов записывается вместе с согласием
// автора отзыва, чтобы можно было подтвердить, какой текст он принял.
const PRIVACY_VERSION = '2026-07-31';

// Версия статического файла по времени изменения — добавляется к ссылке (?v=...),
// чтобы браузер всегда подхватывал свежие стили/скрипты и не показывал старый кэш.
const _assetV = new Map();
function assetV(file) {
  const hit = _assetV.get(file);
  if (hit && Date.now() - hit.at < 5000) return hit.v; // проверяем диск не чаще раза в 5 секунд
  let v = '1';
  try { v = Math.round(fs.statSync(path.join(__dirname, '..', 'public', file)).mtimeMs).toString(36); } catch (e) {}
  _assetV.set(file, { v, at: Date.now() });
  return v;
}

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// Предлог не должен висеть в конце строки: «Оригинальная техника Apple с» и
// перенос «гарантией» на следующую строку читается как ошибка вёрстки. Слова из
// одной-двух букв привязываем к следующему слову неразрывным пробелом. Заголовок
// магазина владелец пишет сам, поэтому чинится это здесь, а не в тексте.
function bindShortWords(s) {
  return String(s == null ? '' : s).replace(/(^|[\s(«"])([A-Za-zА-Яа-яЁё]{1,2})\s+/g, '$1$2 ');
}

// На телефоне слоган обязан помещаться в одну строку — и в заголовке первого
// экрана (вместе с яблоком), и в подвале. Кегль под ширину экрана подбирает сам
// CSS: `min(23px, calc((100vw - поля)/var(--fit)))`. Ему нужно знать длину
// строки в em — её и считает сервер. Мерить ширину скриптом в браузере значит
// показать сначала крупный заголовок и дёрнуть вёрстку на загрузке, а слоган
// пишет владелец, поэтому подобрать кегль числом заранее нельзя.
//
// Ширины символов — замер системного шрифта, десять групп. Точность нужна
// односторонняя: заниженная оценка выносит строку за экран, завышенная лишь
// делает кегль на пару процентов меньше нужного. Поэтому спорные символы
// округлены вверх, незнакомый считается широким, а сверху ещё запас на кегль.
const FIT_WIDTHS = [
  [0.21, '  .,:;ijlI'],
  [0.32, '!/()ftr'],
  [0.47, '-1гтьзsxz'],
  [0.50, 'вкхуяvkyJ?'],
  [0.56, 'абеёийлнопрсчъэacdeghnopqubFLE7Г'],
  [0.62, 'дцЕЁЗКРТУЬБВBKPRSTYZ02345689+«»'],
  [0.68, 'фыЯАХЧADVX'],
  [0.75, 'жмшюДЛНОПСЦЪИЙЭCGHNOQUw'],
  [0.85, 'щФЫМmM—'],
  [0.97, 'ЖШЩЮW']
];
const FIT_CHARS = new Map();
for (const [width, chars] of FIT_WIDTHS) for (const ch of chars) FIT_CHARS.set(ch, width);
// Яблоко в заголовке — те же .6em ширины и .26em отступа, что у `.apple-mark`.
const FIT_MARK = 0.86;
// Полужирное начертание заголовка шире обычного примерно на 7 %.
const FIT_BOLD = 1.07;
// Засечковые наборы шире системного, моноширинный — тем более.
const FIT_FONTS = { system: 1, rounded: 1, serif: 1.25, slab: 1.22, mono: 1.2, grotesk: 1.05 };
// Одна и та же строка на мелком кегле занимает больше em, чем на крупном: у
// системного шрифта свой трекинг на каждый размер и отдельное начертание для
// мелкого. От 23px к 10px набегает 11 %, и этого хватало, чтобы длинный слоган
// вылез за экран. Поэтому запас зависит от кегля, а кегль прикидывается по
// длине строки на типичном телефоне (FIT_REF — сколько ему остаётся под текст).
const FIT_REF = 349;
const FIT_DENSE = size => Math.min(1.16, 1.025 + 0.0105 * Math.max(0, 23 - size));

function textUnits(s, scale, tracking) {
  let sum = 0, count = 0;
  for (const ch of String(s == null ? '' : s)) { sum += FIT_CHARS.get(ch) || 0.62; count++; }
  return sum * scale + tracking * count;
}
function fitValue(units) {
  const safe = Math.max(1, units);
  return (safe * FIT_DENSE(FIT_REF / safe)).toFixed(2);
}
// Слоган в заголовке первого экрана: яблоко + текст брендовым шрифтом
// (полужирный, трекинг -.038em — см. `.store-hero h1` в styles.css).
function heroFit(settings, text) {
  const scale = FIT_BOLD * (FIT_FONTS[settings && settings.logoFont] || 1);
  return fitValue(FIT_MARK + textUnits(text, scale, -0.038));
}
// Слоган в подвале набран обычным системным шрифтом и без трекинга.
function footFit(text) { return fitValue(textUnits(text, 1, 0)); }

// Старые админские шаблоны ставят <label> перед полем без for/id. Дорабатываем
// готовую разметку централизованно: подпись становится кликабельной, а скринридер
// получает корректное имя input/select/textarea. Уже связанные поля не меняем.
function accessibleFields(html, prefix) {
  let index = 0;
  return String(html || '').replace(/<label(?![^>]*\bfor=)([^>]*)>([\s\S]*?)<\/label>(\s*)<(input|select|textarea)([^>]*)>/gi,
    (all, labelAttrs, labelHtml, gap, tag, controlAttrs) => {
      const existing = controlAttrs.match(/\bid\s*=\s*"([^"]+)"/i);
      const id = existing ? existing[1] : `${prefix || 'field'}-${++index}`;
      const attrs = existing ? controlAttrs : `${controlAttrs} id="${id}"`;
      return `<label${labelAttrs} for="${esc(id)}">${labelHtml}</label>${gap}<${tag}${attrs}>`;
    });
}

function money(n, settings) {
  const amount = Number(n);
  const val = (Number.isFinite(amount) ? amount : 0).toLocaleString('ru-RU');
  const cur = esc((settings && settings.currency) || '₽');
  return (settings && settings.currencyPosition === 'before') ? `${cur}${val}` : `${val} ${cur}`;
}

function formatDate(ms) {
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric' });
}

// Состояние онлайн-оплаты для строки заказа в панелях. Отдельная подпись, а не
// значение статуса заказа: заказ бывает и оплачен, и «в работе» одновременно.
// Заказ без оплаты (в том числе любой прежний) не рисует ничего.
function paymentBadge(order) {
  const pay = order && order.payment;
  if (!pay || !pay.status) return '';
  const view = {
    pending: ['pay-wait', '⏳ ждём оплату'],
    paid: ['pay-ok', '✓ оплачено'],
    mismatch: ['pay-warn', '⚠ проверить оплату']
  }[pay.status];
  if (!view) return '';
  return `<div class="pay-tag ${view[0]}">${view[1]}</div>`
    + (pay.note ? `<div class="muted small">${esc(pay.note)}</div>` : '');
}

function pluralRu(n, one, few, many) {
  const a = Math.abs(Number(n) || 0) % 100;
  const b = a % 10;
  if (a > 10 && a < 20) return many;
  if (b > 1 && b < 5) return few;
  return b === 1 ? one : many;
}
function reviewCountText(count) { return `${count} ${pluralRu(count, 'отзыв', 'отзыва', 'отзывов')}`; }

// ВРЕМЕННО ВЫКЛЮЧЕНО. Поле «Фото» в форме отзыва на витрине. Вернуть — поставить
// true, больше ничего менять не нужно: уже загруженные фото отзывов показываются
// в любом случае, а /api/reviews принимает их как принимал.
const REVIEW_PHOTOS = false;

// Отзывов у популярных товаров сотни, поэтому страница товара отдаёт только
// одну страницу, а остальные приходят через GET /api/reviews той же разметкой.
const REVIEWS_PER_PAGE = 8;
// Первым идёт режим по умолчанию: свежие отзывы полезнее любых «полезных».
const REVIEW_SORTS = [
  ['new', 'Новые'],
  ['low', 'Низкая оценка'],
  ['high', 'Высокая оценка']
];
const REVIEW_SORT_KEYS = REVIEW_SORTS.map(([key]) => key);

function reviewSortMode(sort) {
  return REVIEW_SORT_KEYS.includes(String(sort)) ? String(sort) : REVIEW_SORT_KEYS[0];
}

function sortReviews(list, sort) {
  const arr = list.slice();
  const fresh = (a, b) => Number(b.createdAt || 0) - Number(a.createdAt || 0);
  const mode = reviewSortMode(sort);
  // Внутри одной оценки всегда сначала свежие: иначе «низкая оценка» открывает
  // ленту трёхлетними жалобами, которые к нынешнему сервису отношения не имеют.
  if (mode === 'low') return arr.sort((a, b) => (Number(a.rating) || 0) - (Number(b.rating) || 0) || fresh(a, b));
  if (mode === 'high') return arr.sort((a, b) => (Number(b.rating) || 0) - (Number(a.rating) || 0) || fresh(a, b));
  return arr.sort(fresh);
}

const ASPECT_LABELS = { delivery: 'Доставка', service: 'Сервис', price: 'Цена' };

function reviewCard(rv) {
  const chips = rv.aspects
    ? ['delivery', 'service', 'price']
      .filter(k => Number(rv.aspects[k]) >= 1 && Number(rv.aspects[k]) <= 5)
      .map(k => `<span class="asp-chip">${ASPECT_LABELS[k]} ${Number(rv.aspects[k])}</span>`).join('')
    : '';
  const rating = Math.max(1, Math.min(5, Number(rv.rating) || 1));
  const ts = Number.isFinite(Number(rv.createdAt)) ? Number(rv.createdAt) : 0;
  return `
    <article class="review" data-rating="${rating}" data-ts="${ts}" data-len="${String(rv.text || '').length}">
      <div class="review-top">
        <div class="review-author">${esc(rv.author)}</div>
        <div class="review-date">${formatDate(rv.createdAt)}</div>
      </div>
      <div class="review-stars">${stars(rv.rating)}</div>
      ${rv.text ? `<p class="review-text">${esc(rv.text)}</p>` : ''}
      ${chips ? `<div class="review-aspects">${chips}</div>` : ''}
      ${(rv.photos && rv.photos.length) ? `<div class="review-photos">${rv.photos.map(ph =>
        `<a href="/uploads/${esc(ph)}" target="_blank" rel="noopener"><img src="/uploads/${esc(ph)}" alt="Фото к отзыву" loading="lazy"></a>`
      ).join('')}</div>` : ''}
    </article>`;
}

// Срез отзывов под запрошенные сортировку и страницу. Номер страницы приходит
// из адреса и от витрины, поэтому приводится к допустимому диапазону здесь же.
function reviewsSlice(list, sort, page) {
  const total = list.length;
  const pages = Math.max(1, Math.ceil(total / REVIEWS_PER_PAGE));
  const current = Math.min(pages, Math.max(1, Math.floor(Number(page)) || 1));
  const offset = (current - 1) * REVIEWS_PER_PAGE;
  const items = sortReviews(list, sort).slice(offset, offset + REVIEWS_PER_PAGE);
  return {
    items, html: items.map(reviewCard).join(''), sort: reviewSortMode(sort),
    page: current, pages, total, from: items.length ? offset + 1 : 0, to: offset + items.length
  };
}

function reviewsRangeText(slice) {
  if (!slice.total) return '';
  if (slice.pages === 1) return reviewCountText(slice.total);
  return `Отзывы ${slice.from}–${slice.to} из ${slice.total}`;
}

// Номера для листалки: первая, последняя, текущая и соседние. Между разрывами
// ставится многоточие, поэтому у 38 страниц ряд остаётся коротким.
function reviewsPageNumbers(page, pages) {
  const wanted = [];
  const add = n => { if (n >= 1 && n <= pages && !wanted.includes(n)) wanted.push(n); };
  add(1);
  for (let n = page - 2; n <= page + 2; n++) add(n);
  add(pages);
  wanted.sort((a, b) => a - b);
  const row = [];
  let prev = 0;
  for (const n of wanted) {
    if (prev && n - prev > 1) row.push('gap');
    row.push(n);
    prev = n;
  }
  return row;
}

// Постраничная навигация для панелей. На боевых данных 7000 отзывов, и список
// «все сразу» весил 4,5 МБ и держал единственный поток 16 секунд — всё это время
// витрина не отвечала никому. Разметка своя, простая: у админки нет ни JS-догрузки,
// ни якоря #reviews, зато нужен произвольный набор query-параметров.
const ADMIN_PER_PAGE = 50;
// Срез списка под номер страницы. Номер приходит из адреса, поэтому зажимается здесь же.
function adminSlice(list, page, perPage) {
  const size = perPage || ADMIN_PER_PAGE;
  const total = list.length;
  const pages = Math.max(1, Math.ceil(total / size));
  const current = Math.min(pages, Math.max(1, Math.floor(Number(page)) || 1));
  const offset = (current - 1) * size;
  return {
    items: list.slice(offset, offset + size), page: current, pages, total,
    from: total ? offset + 1 : 0, to: Math.min(total, offset + size)
  };
}
// href(n) строит адрес страницы n — у каждой панели свои параметры (status, site).
function adminPager(slice, href) {
  if (slice.pages < 2) return `<div class="a-pager-info muted small">Всего: ${slice.total}</div>`;
  const link = (n, label, cls) => (n >= 1 && n <= slice.pages)
    ? `<a class="a-page${cls || ''}" href="${href(n)}">${label}</a>`
    : `<span class="a-page a-page-off" aria-hidden="true">${label}</span>`;
  const numbers = reviewsPageNumbers(slice.page, slice.pages).map(item => {
    if (item === 'gap') return `<span class="a-page-gap" aria-hidden="true">…</span>`;
    if (item === slice.page) return `<span class="a-page a-page-cur" aria-current="page">${item}</span>`;
    return link(item, item);
  }).join('');
  return `<nav class="a-pager" aria-label="Страницы">${link(slice.page - 1, '‹', ' a-page-arrow')}${numbers}${link(slice.page + 1, '›', ' a-page-arrow')}`
    + `<span class="a-pager-info muted small">${slice.from}–${slice.to} из ${slice.total}</span></nav>`;
}

const PAGER_CHEVRON = {
  prev: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 5l-7 7 7 7"/></svg>`,
  next: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 5l7 7-7 7"/></svg>`
};

// Внутренности листалки. Отдаются и страницей товара, и /api/reviews: после
// перехода витрина заменяет разметку целиком, чтобы номера не считались дважды.
function reviewsPager(slice, base) {
  if (slice.pages < 2) return '';
  const href = n => `${base}?rsort=${slice.sort}&amp;rpage=${n}#reviews`;
  const arrow = (dir, n, label) => (n >= 1 && n <= slice.pages)
    ? `<a class="rev-page rev-arrow" href="${href(n)}" rel="${dir}" data-page="${n}" aria-label="${label}">${PAGER_CHEVRON[dir]}</a>`
    : `<span class="rev-page rev-arrow rev-off" aria-hidden="true">${PAGER_CHEVRON[dir]}</span>`;
  const numbers = reviewsPageNumbers(slice.page, slice.pages).map(item => {
    if (item === 'gap') return `<span class="rev-gap" aria-hidden="true">…</span>`;
    // Дальние номера на узком экране прячет CSS: там остаются стрелки, соседи и края.
    const far = Math.abs(item - slice.page) === 2 ? ' rev-far' : '';
    if (item === slice.page) return `<span class="rev-page rev-cur${far}" aria-current="page">${item}</span>`;
    return `<a class="rev-page${far}" href="${href(item)}" data-page="${item}" aria-label="Страница ${item}">${item}</a>`;
  }).join('');
  return `<nav class="rev-pages" aria-label="Страницы отзывов">${arrow('prev', slice.page - 1, 'Предыдущая страница')}${numbers}${arrow('next', slice.page + 1, 'Следующая страница')}</nav>`
    + `<span class="reviews-shown muted small" id="reviews-shown" aria-live="polite">${reviewsRangeText(slice)}</span>`;
}

// Звёзды рейтинга: серый фон + золотой слой, обрезанный по проценту.
function stars(rating) {
  const value = Number(rating);
  const safe = Number.isFinite(value) ? Math.max(0, Math.min(5, value)) : 0;
  const pct = (safe / 5) * 100;
  return `<span class="stars" role="img" aria-label="${safe} из 5">`
    + `<span class="stars-bg">★★★★★</span>`
    + `<span class="stars-fg" style="width:${pct}%">★★★★★</span>`
    + `</span>`;
}

// Иконки-плейсхолдеры по категории (когда у товара нет загруженных фото).
const GLYPHS = {
    phone: '<rect x="150" y="70" width="100" height="180" rx="18" fill="none" stroke="#fff" stroke-width="7"/><line x1="180" y1="222" x2="220" y2="222" stroke="#fff" stroke-width="7" stroke-linecap="round"/>',
    laptop: '<rect x="128" y="95" width="144" height="92" rx="8" fill="none" stroke="#fff" stroke-width="7"/><path d="M108 205 h184 l14 22 H94 Z" fill="none" stroke="#fff" stroke-width="7" stroke-linejoin="round"/>',
    tablet: '<rect x="132" y="80" width="136" height="160" rx="14" fill="none" stroke="#fff" stroke-width="7"/><circle cx="200" cy="222" r="5" fill="#fff"/>',
    watch: '<rect x="158" y="120" width="84" height="90" rx="22" fill="none" stroke="#fff" stroke-width="7"/><path d="M172 120 l8 -38 h40 l8 38 M172 210 l8 38 h40 l8 -38" fill="none" stroke="#fff" stroke-width="7" stroke-linejoin="round"/>',
    earbuds: '<path d="M170 110 c-26 0 -34 30 -30 60 c4 26 26 30 30 6 c3 -20 -2 -40 0 -66 Z" fill="none" stroke="#fff" stroke-width="7"/><path d="M230 110 c26 0 34 30 30 60 c-4 26 -26 30 -30 6 c-3 -20 2 -40 0 -66 Z" fill="none" stroke="#fff" stroke-width="7"/>',
  generic: '<path d="M200 96 c30 0 52 22 52 58 c0 44 -34 92 -52 92 c-18 0 -52 -48 -52 -92 c0 -36 22 -58 52 -58 Z" fill="none" stroke="#fff" stroke-width="7"/><path d="M200 96 c0 -18 14 -30 30 -30" fill="none" stroke="#fff" stroke-width="7" stroke-linecap="round"/>'
};

function glyphKey(category) {
  const c = String(category || '').toLowerCase();
  if (/(iphone|phone|телефон)/.test(c)) return 'phone';
  if (/(mac|book|ноут|laptop)/.test(c)) return 'laptop';
  if (/(ipad|tablet|планшет)/.test(c)) return 'tablet';
  if (/(watch|часы)/.test(c)) return 'watch';
  if (/(airpod|pod|наушник|buds)/.test(c)) return 'earbuds';
  return 'generic';
}

// Спрайт плейсхолдеров: шесть заготовок один раз на страницу. Раньше каждая карточка
// несла свою копию SVG (38% веса каталога) и свой <linearGradient id="g"> — то есть
// на странице было четыре десятка элементов с одинаковым id.
const PH_SPRITE = `<svg class="ph-sprite" aria-hidden="true" width="0" height="0" style="position:absolute">`
  + `<linearGradient id="ph-g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#eef1f6"/><stop offset="1" stop-color="#dfe4ec"/></linearGradient>`
  + Object.keys(GLYPHS).map(k => `<symbol id="ph-${k}" viewBox="0 0 400 320" preserveAspectRatio="xMidYMid meet">`
    + `<rect width="400" height="320" fill="url(#ph-g)"/>`
    + `<g opacity="0.55" stroke-linecap="round">${GLYPHS[k]}</g></symbol>`).join('')
  + `</svg>`;

function placeholderSvg(product) {
  return `<svg class="ph" viewBox="0 0 400 320" preserveAspectRatio="xMidYMid meet" aria-hidden="true"><use href="#ph-${glyphKey(product.category)}"/></svg>`;
}

// Разметка изображения товара: загруженное фото или SVG-плейсхолдер.
function imageMarkup(product, index, opts) {
  const imgs = product.images || [];
  if (imgs.length) {
    const src = imgs[index || 0];
    // width/height заданы, чтобы не «прыгала» вёрстка; главное фото товара грузим сразу (eager).
    const eager = !!(opts && opts.eager);
    return `<img src="/uploads/${esc(src)}" alt="${esc(product.name)}" width="800" height="800"`
      + ` loading="${eager ? 'eager' : 'lazy'}" decoding="async"${eager ? ' fetchpriority="high"' : ''}>`;
  }
  return placeholderSvg(product);
}

// ===== Иконки-хайлайты характеристик (авто из поля specs) =====
// Оригинальные глифы Apple из public/spec-icons — см. lib/spec-icons.js.
const { specIcon } = require('./spec-icons');
function specHighlights(p) {
  if (!p.specs) return '';
  const seen = new Set();   // повторный глиф на этой же странице вставится ссылкой <use>
  const items = String(p.specs).split('\n').map(l => l.trim()).filter(Boolean).map(line => {
    const i = line.indexOf(':');
    const key = i > -1 ? line.slice(0, i).trim() : '';
    const val = i > -1 ? line.slice(i + 1).trim() : line;
    // Разметка как в highlights на apple.com: глиф слева, одна строка текста справа.
    return `<li class="spec-item"><span class="spec-ico">${specIcon(key, val, seen)}</span>`
      + `<span class="spec-txt">${key ? `<b class="spec-key">${esc(key)}</b> ` : ''}${esc(val)}</span></li>`;
  }).join('');
  return `<section class="section spec-section">`
    + `<h2 class="spec-h">Характеристики. <span class="muted">Всё, что важно знать.</span></h2>`
    + `<ul class="spec-grid">${items}</ul></section>`;
}

// Наборы шрифтов для брендинга (выбираются в настройках сайта).
const FONTS = {
  system: '-apple-system,BlinkMacSystemFont,"SF Pro Text","Segoe UI",Roboto,Helvetica,Arial,sans-serif',
  rounded: 'ui-rounded,"SF Pro Rounded",Quicksand,Nunito,system-ui,sans-serif',
  serif: 'Georgia,"Iowan Old Style","Times New Roman",serif',
  slab: 'Rockwell,"Roboto Slab",Georgia,serif',
  mono: '"SF Mono",ui-monospace,Menlo,Consolas,monospace',
  grotesk: '"Space Grotesk","Trebuchet MS","Helvetica Neue",Arial,sans-serif'
};
function brandFont(settings) { return FONTS[settings && settings.logoFont] || FONTS.system; }
function cssColor(value, fallback) {
  const color = String(value || '').trim();
  return /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i.test(color) ? color : (fallback || '#0071e3');
}

// Текстовый логотип: буквы в {фигурных скобках} красятся вторичным/акцентным цветом.
function logoTextMarkup(text) {
  return esc(text).replace(/\{([^}]*)\}/g, '<span class="logo-accent">$1</span>');
}
function logoMarkup(settings) {
  if (settings.logoImage) return `<img class="logo-img" src="/uploads/${esc(settings.logoImage)}" alt="${esc(settings.storeName)}">`;
  if (settings.logoText && settings.logoText.trim()) return `<span class="logo-txt">${logoTextMarkup(settings.logoText)}</span>`;
  return `<span class="logo-txt">${esc(settings.storeName)}</span>`;
}
// Telegram: юзернейм без @ и фирменная иконка (цвет задаётся через CSS color/fill:currentColor)
function tgUser(settings) { return String(settings.contactTelegram || '').replace(/^@/, '').replace(/[^a-z0-9_]/gi, ''); }
function tgIcon() { return '<svg class="tg-ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M9.78 18.65l.28-4.23 7.68-6.92c.34-.31-.07-.46-.52-.19L7.74 13.3 3.64 12c-.88-.25-.89-.86.2-1.3l15.97-6.16c.73-.33 1.43.18 1.15 1.3l-2.72 12.81c-.19.91-.74 1.13-1.5.71l-4.15-3.06-1.99 1.94c-.23.23-.42.42-.83.42z"/></svg>'; }
function tgHeaderBtn(settings) {
  if (!settings.contactTelegram) return '';
  return `<a class="tg-header" href="https://t.me/${esc(tgUser(settings))}" target="_blank" rel="noopener" aria-label="Написать в Telegram">${tgIcon()}<span class="tg-header-txt">Telegram</span></a>`;
}

function currencyCode(sym) {
  return ({ '₽': 'RUB', '$': 'USD', '€': 'EUR', '£': 'GBP', '₴': 'UAH', '₸': 'KZT' })[sym] || 'RUB';
}
function jsonLd(obj) { return JSON.stringify(obj).replace(/</g, '\\u003c'); } // безопасно для <script>
function scriptJson(value) {
  return JSON.stringify(value).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
}

// SEO-блок в <head>: описание, canonical, Open Graph, Twitter, JSON-LD.
function seoHead(settings, opts) {
  const origin = opts.origin || '';
  const canonical = origin + (opts.canonicalPath || '/');
  const desc = (opts.description || settings.tagline || settings.storeName || '').slice(0, 300);
  const ogTitle = opts.title ? opts.title + ' — ' + settings.storeName : settings.storeName;
  const ogImage = opts.ogImage ? (/^https?:/.test(opts.ogImage) ? opts.ogImage : origin + opts.ogImage) : '';
  // Оформление заказа и страница «не найдено» в индекс не идут: там нечего
  // показывать в выдаче, а дубли только размывают релевантность каталога.
  return `<meta name="description" content="${esc(desc)}">`
    + `<meta name="robots" content="${opts.noindex ? 'noindex,follow' : 'index,follow'}">`
    + (origin && !opts.noCanonical ? `<link rel="canonical" href="${esc(canonical)}">` : '')
    + `<meta property="og:site_name" content="${esc(settings.storeName)}"><meta property="og:locale" content="ru_RU">`
    + `<meta property="og:type" content="${esc(opts.ogType || 'website')}"><meta property="og:title" content="${esc(ogTitle)}">`
    + `<meta property="og:description" content="${esc(desc)}">`
    + (origin && !opts.noCanonical ? `<meta property="og:url" content="${esc(canonical)}">` : '')
    + (ogImage ? `<meta property="og:image" content="${esc(ogImage)}">` : '')
    + `<meta name="twitter:card" content="${ogImage ? 'summary_large_image' : 'summary'}">`
    + `<meta name="twitter:title" content="${esc(ogTitle)}"><meta name="twitter:description" content="${esc(desc)}">`
    + (ogImage ? `<meta name="twitter:image" content="${esc(ogImage)}">` : '')
    + (opts.jsonLd ? `<script type="application/ld+json">${opts.jsonLd}</script>` : '');
}

// Панель «Оформление» для админок (логотип, шрифт, цвета) — общая для владельца и админки сайта.
function brandFields(s) {
  s = s || {};
  const fonts = [['system', 'Системный'], ['rounded', 'Округлый'], ['grotesk', 'Гротеск'], ['serif', 'С засечками'], ['slab', 'Брусковый'], ['mono', 'Моноширинный']];
  const cur = s.logoImage
    ? `<div class="field"><label>Текущий логотип</label><div class="logo-chip"><img src="/uploads/${esc(s.logoImage)}" alt=""><label class="img-remove"><input type="checkbox" name="removeLogo"> убрать</label></div></div>` : '';
  return `<div class="a-panel"><h2>Оформление</h2>
    <div class="a-form-grid">
      <div class="field"><label>Шрифт названия и заголовков</label><select name="logoFont">${fonts.map(([v, l]) => `<option value="${v}" ${s.logoFont === v ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
      <div class="field"><label>Вторичный цвет (для выделенных букв)</label><input name="secondaryColor" type="color" value="${cssColor(s.secondaryColor || s.accentColor)}"></div>
    </div>
    <div class="field"><label>Цветной текст логотипа</label><input name="logoText" value="${esc(s.logoText || '')}" placeholder="например: {i}Store"><p class="muted small">Пусто — берётся название магазина. Буквы в фигурных скобках <b>{ }</b> красятся вторичным цветом. Пример: <b>{i}Store</b> → «i» цветное.</p></div>
    ${cur}
    <div class="field"><label>Логотип-картинка (необязательно, заменяет текст)</label><input type="file" name="logo" accept="image/*"><p class="muted small">Фото автоматически чистится от метаданных и сжимается в WebP.</p></div>
  </div>`;
}

// Наличие по вариантам: цвет или память можно отключить по отдельности.
// Флага нет (старые данные) — считаем, что вариант есть.
function variantInStock(v) { return !v || v.inStock !== false; }
// Доступен ли для корпуса хотя бы один реальный ремешок. Совместимость важна
// вместе с наличием: независимые проверки «есть цвет» и «есть ремешок» давали
// ложное наличие, когда единственный ремешок подходил только распроданному корпусу.
function bandAvailableForColor(bands, caseColor) {
  return !(bands || []).length || (bands || []).some(g => (g.options || []).some(o => variantInStock(o) && bandFits(o, caseColor)));
}
function colorAvailable(p, color) {
  return variantInStock(color) && bandAvailableForColor(p.bands || [], color && color.name || '');
}
// Товар вообще можно купить? Нужен хотя бы один доступный цвет, вариант памяти,
// по одному доступному значению в каждой доп. характеристике и — у часов —
// хотя бы один доступный ремешок.
function sellable(p) {
  if (!p || !p.inStock) return false;
  const colors = p.colors || [], storages = p.storages || [], bands = p.bands || [];
  const choicesOk = colors.length ? colors.some(c => colorAvailable(p, c)) : bandAvailableForColor(bands, '');
  const optionsOk = (p.options || []).every(g => (g.values || []).some(variantInStock));
  return choicesOk && optionsOk && (!storages.length || storages.some(variantInStock));
}

// Подпись наличия под вариантами: зелёная точка «В наличии» или предупреждающая
// «Осталось несколько штук». Распроданному товару её не показываем — про это уже
// говорит кнопка «Нет в наличии», и два разных ответа рядом сбивали бы с толку.
// Точка мигает средствами CSS (см. .stock-dot в styles.css): ни скрипта, ни
// запроса это не добавляет, поэтому на скорость загрузки страницы не влияет.
function stockNote(p) {
  if (!sellable(p)) return '';
  const few = p.stockLevel === 'few';
  return `<p class="stock${few ? ' stock-few' : ''}">
          <span class="stock-dot" aria-hidden="true"></span>${few ? 'Осталось несколько штук' : 'В наличии'}
        </p>`;
}

// Значение доп. характеристики, выбранное по умолчанию: первое доступное,
// подходящее выбранной конфигурации. Нанотекстурное стекло бывает только от
// 1 ТБ, и открывать страницу с варианта, который JS тут же спрячет, нельзя.
function defaultOption(group, storage, picked) {
  const values = (group && group.values) || [];
  const pick = strict => values.findIndex(v => V.optionFits(v, storage, picked) && (!strict || variantInStock(v)));
  let i = pick(true);
  if (i === -1) i = pick(false);
  return i === -1 ? 0 : i;
}

// Что выбрано по умолчанию, когда группы зависят друг от друга: у MacBook Pro
// объём памяти и потолок накопителя определяет чип. Считаем в два прохода —
// сначала группы без учёта конфигурации, потом конфигурацию под них и группы
// заново. Открывать страницу с варианта, который скрипт тут же спрячет, нельзя.
function defaultChoices(p) {
  const storages = (p && p.storages) || [];
  const groups = (p && p.options) || [];
  const map = (byStorage) => {
    const out = {};
    for (const g of groups) {
      const v = (g.values || [])[defaultOption(g, byStorage, out)];
      if (v) out[g.name] = v.label;
    }
    return out;
  };
  const rough = map('');
  const fits = (s) => variantInStock(s) && V.optionFits(s, '', rough);
  let idx = storages.findIndex(fits);
  if (idx === -1) idx = storages.findIndex(s => V.optionFits(s, '', rough));
  if (idx === -1) idx = firstAvailable(storages);
  const label = (storages[idx] || {}).label || '';
  return { storageIdx: idx, storage: label, picked: map(label) };
}

// Вариация «в цвет корпуса» продаётся только со своим корпусом (титановый
// миланский у Apple подбирается в цвет часов) — для чужого корпуса её не показываем.
function bandFits(o, caseColor) { return !o || !o.forColor || o.forColor === caseColor; }
// Ремешок, выбранный по умолчанию: первый доступный, который подходит выбранному
// корпусу. Раньше сервер брал просто первый — и на чёрном титане страница
// открывалась с ремешка «только для натурального», который JS тут же прятал.
function defaultBand(bands, caseColor) {
  bands = bands || [];
  if (!bands.length) return null;
  const pick = (list, strict) => (list || []).findIndex(o => bandFits(o, caseColor) && (!strict || variantInStock(o)));
  let gi = bands.findIndex(g => pick(g.options, true) > -1);
  if (gi === -1) gi = bands.findIndex(g => pick(g.options, false) > -1);
  if (gi === -1) gi = 0;
  const opts = bands[gi].options || [];
  let oi = pick(opts, true);
  if (oi === -1) oi = pick(opts, false);
  if (oi === -1) oi = 0;
  return { gi, oi };
}
// Индекс первого доступного варианта — он и выбирается на странице по умолчанию.
function firstAvailable(list) {
  const i = (list || []).findIndex(variantInStock);
  return i === -1 ? 0 : i;
}

function firstAvailableColor(p) {
  const colors = (p && p.colors) || [];
  const compatible = colors.findIndex(c => colorAvailable(p, c));
  return compatible > -1 ? compatible : firstAvailable(colors);
}

// Подпись группы вариантов: у часов это размер корпуса, у остальных — память.
function variantLabel(p) {
  // \b в JS работает только с ASCII, поэтому русские единицы проверяем без границ слова
  const all = ((p && p.storages) || []).map(s => s.label).join(' ');
  if (/мм|\bmm\b/i.test(all)) return 'Размер корпуса';
  if (/гб|тб|\bgb\b|\btb\b/i.test(all)) {
    // У Mac рядом стоит выбор ОЗУ, и две соседние строки «Память» и «Оперативная
    // память» читаются как одно и то же. Там накопитель называем прямо.
    return ((p && p.options) || []).some(g => g.name === 'Оперативная память') ? 'Накопитель' : 'Память';
  }
  return 'Вариант';
}

function productCard(p, settings, db, opts) {
  opts = opts || {};
  const r = p._rating || db.ratingFor(p.id);
  const inStock = sellable(p);   // распроданы все цвета или все конфигурации — товар не купить
  const hot = D.dealActive(p);
  const eff = D.effectivePrice(p);
  const cmp = D.comparePrice(p);
  const pct = D.discountPct(p);
  // Зачёркнутая цена и процент — одной группой: на узкой карточке они переносятся
  // на вторую строку вместе, а не порознь. У распроданного процент не показываем:
  // «−13%» на товаре, который нельзя купить, — обещание впустую.
  //
  // Плашка положена любой скидке, а не только горящей акции. Раньше условие было
  // `hot && inStock`, и товар с обычной старой ценой показывал в каталоге голую
  // зачёркнутую сумму без процента — хотя на своей же странице показывал «−13%».
  const compareHtml = cmp
    ? `<span class="price-was"><span class="old-price">${money(cmp, settings)}</span>${inStock && pct > 0 ? `<span class="save">−${pct}%</span>` : ''}</span>`
    : '';
  // Отметка стоит в строке над названием, а не поверх снимка: товар вписан в 92 %
  // кадра, поэтому плашка в углу ложилась прямо на него — особенно на телефоне,
  // где карточка вдвое уже. Слот тот же, что у категории, поэтому ритм сетки не
  // меняется. «Нет в наличии» важнее рекламной подписи — иначе покупатель читает
  // «Хит» на том, что нельзя купить.
  const flag = !inStock
    ? '<span class="card-flag card-flag-out">Нет в наличии</span>'
    : (p.badge ? `<span class="card-flag">${esc(p.badge)}</span>` : '');
  const ratingLine = r.count
    ? `<div class="card-rating">${stars(r.avg)}<span class="rating-count">${r.avg} · ${r.count}</span></div>`
    : `<div class="card-rating card-rating-empty">Пока нет отзывов</div>`;
  const timer = (hot && p.hotDealUntil)
    ? `<div class="deal-timer" data-deal-until="${p.hotDealUntil}"><span class="dt-ico">⏳</span><span class="dt-val">—</span></div>` : '';
  // Карточка: ссылка и кнопка — соседи, а не вложены друг в друга (корректный HTML и доступность).
  return `
  <article class="card${hot ? ' card-hot' : ''}${inStock ? '' : ' card-out'}">
    <a class="card-link" href="/product/${p.id}">
      <div class="card-media">${imageMarkup(p, 0, { eager: !!opts.eager })}</div>
      <div class="card-body">
        <div class="card-cat">${flag || esc(p.category)}</div>
        <div class="card-name">${esc(p.name)}</div>
        ${ratingLine}
        <div class="card-price${cmp ? ' price-sale' : ''}"><span class="price-now">${money(eff, settings)}</span>${compareHtml}</div>
        ${timer}
      </div>
    </a>
    <div class="card-add">${!inStock
      ? `<button type="button" class="btn btn-primary btn-block" disabled>Нет в наличии</button>`
      : ((p.colors || []).length || (p.storages || []).length || (p.bands || []).length || (p.options || []).length)
        ? `<a class="btn btn-primary btn-block" href="/product/${p.id}">В корзину</a>`
        : `<button type="button" class="btn btn-primary btn-block add-to-cart"
          data-id="${p.id}" data-name="${esc(p.name)}" data-price="${eff}" data-img="${esc((p.images || [])[0] || '')}">В корзину</button>`}
    </div>
  </article>`;
}

// Способы оплаты в подвале. Знаки собраны разметкой, а не картинками: ни одного
// лишнего запроса и никакой растровой мазни при масштабировании. Все они одного
// цвета с текстом подвала (fill: currentColor), поэтому ряд не рябит.
// viewBox у каждого обрезан по фигуре, так что высота в CSS — это высота знака.
const PAY_MARKS = {
  // «Мир», Visa, Mastercard и СБП — официальные знаки с Викисклада (public
  // domain), приведённые к currentColor. viewBox у каждого обрезан по фигуре,
  // поэтому высота в CSS — это высота самого знака.
  mir: '<svg viewBox="31 13 351.75 96.02" fill="currentColor" aria-hidden="true"><path d="m31 13h33c3 0 12-1 16 13 3 9 7 23 13 44h2c6-22 11-37 13-44 4-14 14-13 18-13h31v96h-32v-57h-2l-17 57h-24l-17-57h-3v57h-31m139-96h32v57h3l21-47c4-9 13-10 13-10h30v96h-32v-57h-2l-21 47c-4 9-14 10-14 10h-30m142-29v29h-30v-50h98c-4 12-18 21-34 21"/><path d="m382 53c4-18-8-40-34-40h-68c2 21 20 40 39 40"/></svg>',
  // Visa — контур логотипа; transform поднимает фигуру в начало обрезанного viewBox
  visa: '<svg viewBox="0 0 24 7.76" fill="currentColor" aria-hidden="true"><path transform="translate(0,-8.12)" d="M9.112 8.262L5.97 15.758H3.92L2.374 9.775c-.094-.368-.175-.503-.461-.658C1.447 8.864.677 8.627 0 8.479l.046-.217h3.3a.904.904 0 01.894.764l.817 4.338 2.018-5.102zm8.033 5.049c.008-1.979-2.736-2.088-2.717-2.972.006-.269.262-.555.822-.628a3.66 3.66 0 011.913.336l.34-1.59a5.207 5.207 0 00-1.814-.333c-1.917 0-3.266 1.02-3.278 2.48-.012 1.079.963 1.68 1.698 2.04.756.367 1.01.603 1.006.931-.005.504-.602.725-1.16.734-.975.015-1.54-.263-1.99-.473l-.351 1.642c.453.208 1.289.39 2.156.398 2.037 0 3.37-1.006 3.376-2.565m5.061 2.447H24l-1.565-7.496h-1.656a.883.883 0 00-.826.55l-2.909 6.946h2.036l.405-1.12h2.488zm-2.163-2.656l1.02-2.815.588 2.815zm-8.16-4.84l-1.603 7.496H8.34l1.605-7.496z"/></svg>',
  // Mastercard: круги радиуса 309 с центрами на расстоянии 381.1 — геометрия
  // из официального файла. Одноцветная версия: оба круга плотные, а границу
  // пересечения показывает обводка цветом подвала (stroke в CSS) — снаружи она
  // сливается с фоном, а внутри рисует ту самую линзу. Прозрачностью этого не
  // сделать: знак получается блёклым рядом с остальными.
  mastercard: '<svg viewBox="0 0 999.2 618" fill="currentColor" aria-hidden="true"><circle cx="309" cy="309" r="309" stroke="none"/><circle cx="690.1" cy="309" r="309" stroke="none"/><circle cx="309" cy="309" r="309" fill="none"/><circle cx="690.1" cy="309" r="309" fill="none"/></svg>',
  // Сегменты знака СБП стыкуются вплотную: в один цвет они слились бы в пятно,
  // поэтому в CSS у них обводка цветом подвала — она возвращает зазоры.
  sbp: '<svg viewBox="0 0 97.28 120" fill="currentColor" aria-hidden="true"><path d="M0 26.12l14.53 25.98v15.84L.02 93.86 0 26.12z" /><path d="M55.8 42.64l13.62-8.35 27.87-.03-41.48 25.41V42.64z" /><path d="M55.72 25.97l.08 34.39-14.57-8.95V0l14.49 25.97z" /><path d="M97.28 34.27l-27.87.03-13.69-8.33L41.23 0l56.05 34.27z" /><path d="M55.8 94.01V77.32l-14.57-8.78.01 51.46 14.56-25.99z" /><path d="M69.38 85.74L14.53 52.09 0 26.12l97.22 59.58-27.84.03z" /><path d="M41.24 120l14.56-25.99 13.58-8.27 27.84-.03L41.24 120z" /><path d="M.02 93.86l41.33-25.32-13.9-8.53-12.92 7.92L.02 93.86z" /></svg>',
  sbpWord: '<svg viewBox="105.27 22.73 101.39 41.91" fill="currentColor" aria-hidden="true"><path d="m 206.66,34.25 v 29.34 h -10.48 v -20.58 h -10.09 v 20.58 h -10.48 v -29.34 h 31.04 z" inkscape:connector-curvature="0" /><path d="m 154.11,64.64 c 9.38,0 16.34,-5.75 16.34,-14.47 0,-8.44 -5.14,-13.91 -13.72,-13.91 -3.96,0 -7.23,1.4 -9.7,3.8 .59,-4.97 4.79,-8.61 9.43,-8.61 1.07,0 9.12,-.02 9.12,-.02 l 4.55,-8.71 c 0,0 -10.1,.23 -14.8,.23 -10.73,.19 -17.98,9.94 -17.98,21.79 0,13.8 7.07,19.89 16.77,19.89 z m .06,-20.67 c 3.48,0 5.9,2.29 5.9,6.2 0,3.52 -2.15,6.42 -5.9,6.43 -3.59,0 -6,-2.69 -6,-6.37 0,-3.91 2.41,-6.26 6,-6.26 z" inkscape:connector-curvature="0" /><path d="m 128.82,53.77 c 0,0 -2.47,1.43 -6.17,1.7 -4.25,.13 -8.03,-2.56 -8.03,-7.32 0,-4.65 3.34,-7.32 7.93,-7.32 2.81,0 6.53,1.95 6.53,1.95 0,0 2.72,-5 4.13,-7.49 -2.58,-1.96 -6.02,-3.03 -10.02,-3.03 -10.1,0 -17.91,6.58 -17.91,15.83 0,9.37 7.35,15.79 17.91,15.6 2.95,-.11 7.03,-1.15 9.51,-2.74 z" inkscape:connector-curvature="0" /></svg>'
};
const PAY_METHODS = `<div class="footer-pay" role="list" aria-label="Способы оплаты">
        <span class="pay pay-mir" role="listitem">${PAY_MARKS.mir}<span class="sr-only">Мир</span></span>
        <span class="pay pay-visa" role="listitem">${PAY_MARKS.visa}<span class="sr-only">Visa</span></span>
        <span class="pay pay-mc" role="listitem">${PAY_MARKS.mastercard}<span class="sr-only">Mastercard</span></span>
        <span class="pay pay-sbp" role="listitem">${PAY_MARKS.sbp}${PAY_MARKS.sbpWord}<span class="sr-only">СБП</span></span>
      </div>`;

function layout(settings, opts) {
  opts = opts || {};
  const accent = cssColor(settings.accentColor);
  const cats = opts.categories || [];
  const navCats = cats.map(c =>
    `<a href="/?category=${encodeURIComponent(c)}" class="nav-cat${opts.activeCategory === c ? ' active' : ''}"${opts.activeCategory === c ? ' aria-current="page"' : ''}>${esc(c)}</a>`
  ).join('');
  return `<!DOCTYPE html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${esc(opts.title ? opts.title + ' — ' + settings.storeName : settings.storeName)}</title>
${seoHead(settings, opts)}
<link rel="icon" href="data:image/svg+xml,%3Csvg%20xmlns='http://www.w3.org/2000/svg'%20viewBox='0%200%2024%2024'%3E%3Cpath%20fill='%231d1d1f'%20d='M17.05%2020.28c-.98.95-2.05.8-3.08.35-1.09-.46-2.09-.48-3.24%200-1.44.62-2.2.44-3.06-.35C2.79%2015.25%203.51%207.59%209.05%207.31c1.35.07%202.29.74%203.08.8%201.18-.24%202.31-.93%203.57-.84%201.51.12%202.65.72%203.4%201.8-3.12%201.87-2.38%205.98.48%207.13-.57%201.5-1.31%202.99-2.53%204.09ZM12.03%207.25c-.15-2.23%201.66-4.07%203.74-4.25.29%202.58-2.34%204.5-3.74%204.25Z'/%3E%3C/svg%3E">
<meta name="theme-color" content="#ffffff">
<meta name="color-scheme" content="light">
<link rel="stylesheet" href="/static/styles.css?v=${assetV('styles.css')}">
<style>:root{--accent:${accent};--secondary:${cssColor(settings.secondaryColor, accent)};--brand-font:${brandFont(settings)}}</style>
</head>
<body class="storefront">
${PH_SPRITE}
<header class="site-header">
  <div class="container header-row">
    <button class="icon-btn menu-toggle" type="button" aria-label="Меню" aria-expanded="false">
      <svg viewBox="0 0 24 24" width="24" height="24"><path d="M3 6h18M3 12h18M3 18h18" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round"/></svg>
    </button>
    <a class="logo" href="/">${logoMarkup(settings)}</a>
    <form class="search" action="/" method="get" role="search">
      <input type="search" name="q" placeholder="Поиск товаров" value="${esc(opts.q || '')}" aria-label="Поиск">
    </form>
    ${tgHeaderBtn(settings)}
    <button class="icon-btn cart-btn" type="button" aria-label="Корзина" aria-expanded="false" onclick="Cart.open()">
      <svg viewBox="0 0 24 24" width="24" height="24"><path d="M6 6h15l-1.5 9h-12z M6 6l-1-3H2 M9 20a1 1 0 100 2 1 1 0 000-2 M18 20a1 1 0 100 2 1 1 0 000-2" stroke="currentColor" stroke-width="1.8" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>
      <span class="cart-badge" id="cart-badge" hidden>0</span>
    </button>
  </div>
  ${cats.length ? `<nav class="site-nav" aria-label="Категории"><div class="container nav-inner"><a href="/" class="nav-cat${!opts.activeCategory ? ' active' : ''}"${!opts.activeCategory ? ' aria-current="page"' : ''}>Все</a>${navCats}</div></nav>` : ''}
</header>

<main>${opts.body || ''}</main>

<footer class="site-footer">
  <div class="container footer-grid">
    <div class="footer-about">
      <div class="foot-brand"><a class="logo" href="/">${logoMarkup(settings)}</a></div>
      <div class="foot-note" style="--fit:${footFit(settings.tagline || '')}">${esc(settings.tagline || '')}</div>
    </div>
    ${(settings.contactTelegram || settings.contactPhone) ? `<div class="footer-contacts">
      ${settings.contactTelegram ? `<div class="foot-tg"><a class="tg-link" href="https://t.me/${esc(tgUser(settings))}" target="_blank" rel="noopener">${tgIcon()}<span>${esc(settings.contactTelegram)}</span></a></div>` : ''}
      ${settings.contactPhone ? `<div class="foot-contact">${esc(settings.contactPhone)}</div>` : ''}
    </div>` : ''}
    <div class="footer-bottom">
      ${PAY_METHODS}
      <div class="footer-meta">
        <div class="foot-legal">© 2017–2026 ${esc(settings.storeName)}. Все права защищены.</div>
        ${settings.footerNote ? `<div class="foot-legal">${esc(settings.footerNote)}</div>` : ''}
      </div>
      <nav class="footer-links" aria-label="Правовая информация">
        <a href="/privacy">Политика конфиденциальности</a>
        <a href="/personal-data-consent">Согласие на обработку данных</a>
      </nav>
    </div>
  </div>
</footer>

<!-- Корзина -->
<div class="cart-overlay" id="cart-overlay" onclick="Cart.close()"></div>
<aside class="cart-drawer" id="cart-drawer" role="dialog" aria-modal="true" aria-label="Корзина" aria-hidden="true">
  <div class="cart-head">
    <h2>Корзина</h2>
    <button class="icon-btn" aria-label="Закрыть" onclick="Cart.close()">
      <svg viewBox="0 0 24 24" width="24" height="24"><path d="M6 6l12 12M18 6L6 18" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>
    </button>
  </div>
  <div class="cart-items" id="cart-items"></div>
  <div class="cart-foot" id="cart-foot"></div>
</aside>

<div class="toast" id="toast" hidden></div>

<div class="review-consent-overlay" id="review-consent-overlay" hidden>
  <section class="review-consent-dialog" role="dialog" aria-modal="true" aria-labelledby="review-consent-title" aria-describedby="review-consent-text">
    <button class="icon-btn review-consent-close" type="button" id="review-consent-close" aria-label="Закрыть">×</button>
    <p class="review-consent-progress" id="review-consent-progress">Шаг 1 из 2</p>
    <h2 id="review-consent-title">Обработка данных</h2>
    <p id="review-consent-text">Подтвердите согласие на обработку данных, которые вы указали в отзыве.</p>
    <a class="review-consent-link" id="review-consent-link" href="/personal-data-consent" target="_blank" rel="noopener">Открыть текст согласия</a>
    <div class="review-consent-actions">
      <button class="btn" type="button" id="review-consent-cancel">Отмена</button>
      <button class="btn btn-primary" type="button" id="review-consent-next">Согласен</button>
    </div>
  </section>
</div>

<script>window.__CURRENCY__=${scriptJson(settings.currency || '₽')};window.__CURPOS__=${scriptJson(settings.currencyPosition || 'after')};</script>
<script src="/static/app.js?v=${assetV('app.js')}" defer></script>
</body>
</html>`;
}

/* --------------------------- Страницы витрины --------------------------- */

// Яблоко в начале заголовка. Контур — фирменный глиф из глобальной навигации
// apple.com, в строке текста стоит на базовой линии, как буква: заливка
// currentColor, цвет и размер берутся у самого заголовка.
// viewBox обрезан по фигуре (bbox 0.514/12.251 … 13.486/28.186) плюс четверть
// единицы полей со всех сторон. Ровно по краю нельзя: внешний svg обрезает
// содержимое по своему viewport, и при дробном размере строки браузер срезал
// у яблока нижний ряд пикселей.
const APPLE_MARK = '<svg class="apple-mark" viewBox="0.26 12 13.48 16.44" aria-hidden="true">'
  + '<path d="m13.0729 17.6825a3.61 3.61 0 0 0 -1.7248 3.0365 3.5132 3.5132 0 0 0 2.1379 3.2223 8.394 8.394 0 0 1 -1.0948 2.2618c-.6816.9812-1.3943 1.9623-2.4787 1.9623s-1.3633-.63-2.613-.63c-1.2187 0-1.6524.6507-2.644.6507s-1.6833-.9089-2.4787-2.0243a9.7842 9.7842 0 0 1 -1.6628-5.2776c0-3.0984 2.014-4.7405 3.9969-4.7405 1.0535 0 1.9314.6919 2.5924.6919.63 0 1.6112-.7333 2.8092-.7333a3.7579 3.7579 0 0 1 3.1604 1.5802zm-3.7284-2.8918a3.5615 3.5615 0 0 0 .8469-2.22 1.5353 1.5353 0 0 0 -.0311-.32 3.5686 3.5686 0 0 0 -2.3445 1.2084 3.4629 3.4629 0 0 0 -.8779 2.1585 1.419 1.419 0 0 0 .0311.2892 1.1657 1.1657 0 0 0 .2169.0207 3.0935 3.0935 0 0 0 2.1586-1.1368z"/></svg>';

// Преимущества первого экрана. Холст 35×35 и волосяная обводка — те же, что у
// глифов характеристик в public/spec-icons, поэтому вес штриха на витрине один.
const BENEFIT_GLYPHS = {
  // Ценник с отверстием
  price: '<path d="M5.99 3.94h11.51l11.65 11.64a2.72 2.72 0 0 1 0 3.84L19.42 29.15a2.72 2.72 0 0 1-3.84 0L3.94 17.5V5.99a2.05 2.05 0 0 1 2.05-2.05z"/><circle cx="9.87" cy="9.87" r="1.67"/>',
  // Щит с галочкой — контур повторяет spec-icons/shield.svg
  warranty: '<path d="M17.5 5.85c3.1 2.06 6.57 3.14 9.57 3.33v8.22c0 6.45-4.12 10.92-9.57 12.9-5.45-1.98-9.57-6.45-9.57-12.9v-8.22c3-.19 6.47-1.27 9.57-3.33z"/><path d="M13.34 17.92l3.02 3.02 5.51-5.82" stroke-linecap="round"/>',
  // Фургон доставки
  delivery: '<rect x="3.9" y="8.9" width="15.3" height="13" rx="1.8"/><path d="M19.2 13.4h4.9c.42 0 .82.19 1.09.51l3.1 3.72c.21.25.32.56.32.88v3.39h-9.4z"/><circle cx="9.3" cy="24" r="2.4"/><circle cx="24.5" cy="24" r="2.4"/>',
  // Процент: два кружка и косая черта
  sale: '<circle cx="11.6" cy="11.6" r="3.15"/><circle cx="23.4" cy="23.4" r="3.15"/><path d="M25.1 9.9L9.9 25.1" stroke-linecap="round"/>',
  // Стрелка возврата
  refund: '<path d="M12.1 8.9l-4 4 4 4" stroke-linecap="round"/><path d="M8.1 12.9H20a6.9 6.9 0 0 1 0 13.8h-6.5" stroke-linecap="round"/>',
  // Кружок с галочкой — «проверено, оригинал». Щит рядом занят гарантией, а два
  // щита подряд в одном блоке читались бы как одно и то же обещание дважды.
  verified: '<circle cx="17.5" cy="17.5" r="12.6"/><path d="M11.9 17.8l4 4 7.7-8.1" stroke-linecap="round"/>'
};
// Спрайт на страницу: обе половины бегущей строки ссылаются на один набор глифов
// через <use>, поэтому дубль строки почти ничего не добавляет к разметке.
const BENEFIT_SPRITE = '<svg class="tick-sprite" aria-hidden="true" width="0" height="0" style="position:absolute">'
  + Object.keys(BENEFIT_GLYPHS).map(k => `<symbol id="bi-${k}" viewBox="0 0 35 35" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round">${BENEFIT_GLYPHS[k]}</symbol>`).join('')
  + '</svg>';
// Блок доверия под кнопкой покупки. Глифы те же, что в бегущей строке главной:
// холст 35×35 и волосяная обводка, поэтому вес штриха на всей витрине один.
// Спрайт сюда не тянем — на странице товара каждый глиф встречается ровно раз, а
// <use> окупается только повтором. Жирным идёт то, что отличает предложение
// (100%, 1 год, Оптовая), обычным — что это такое.
const TRUST_ITEMS = [
  ['verified', '100%', 'оригинал'],
  ['warranty', '1 год', 'гарантия'],
  ['price', 'Оптовая', 'цена']
];
const TRUST_BLOCK = `<ul class="trust">${TRUST_ITEMS.map(([g, strong, tail]) => `<li class="trust-item">`
  + `<svg class="trust-ico" viewBox="0 0 35 35" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round" aria-hidden="true">${BENEFIT_GLYPHS[g]}</svg>`
  + `<span class="trust-text"><b>${strong}</b> ${tail}</span></li>`).join('')}</ul>`;

const HERO_BENEFITS = [
  ['price', 'Оптовые цены'],
  ['sale', 'Скидки и акции каждый день'],
  ['warranty', '1 год гарантии'],
  ['delivery', 'Быстрая доставка'],
  ['refund', 'Простой возврат']
];
// Одна копия бегущей строки. В ленте их TICKER_COPIES, а едет она ровно на
// ширину одной копии (см. ticker-run в styles.css) и возвращается в начало —
// склейка незаметна. Копий четыре, а не две: лента сдвигается на свою ширину,
// поэтому оставшихся копий должно хватать, чтобы закрыть экран целиком, иначе
// в конце цикла у правого края появлялась бы пустота.
const TICKER_COPIES = 4;
function tickerRow(dup) {
  return `<ul class="ticker-row"${dup ? ' aria-hidden="true"' : ' aria-label="Преимущества магазина"'}>`
    + HERO_BENEFITS.map(([k, text]) =>
      `<li><svg class="tick-ico" viewBox="0 0 35 35" aria-hidden="true"><use href="#bi-${k}"/></svg>${text}</li>`).join('')
    + '</ul>';
}

function homePage(settings, db, opts, site) {
  opts = opts || {};
  const all = site ? T.siteProductViews(site) : db.getProducts();
  const categoryValid = !opts.category || all.some(p => p.category === opts.category);
  let list = all;
  if (opts.category) list = list.filter(p => p.category === opts.category);
  if (opts.q) {
    const q = opts.q.trim().toLowerCase();
    list = list.filter(p => [p.name, p.category, p.shortDesc, p.specs].filter(Boolean).join(' ').toLowerCase().includes(q));
  }
  // Блок «Горящие скидки» — только на главной (без поиска/категории), если есть активные акции.
  const deals = (!opts.q && !opts.category) ? all.filter(p => D.dealActive(p)) : [];
  const eagerCatalog = !deals.length;
  const cards = list.map((p, i) => productCard(p, settings, db, { eager: eagerCatalog && i < 4 })).join('');
  // На главной заголовка у каталога нет: слово «Каталог» ничего не сообщало —
  // товары и так начинаются сразу под первым экраном. У категории и поиска
  // заголовок остаётся: он единственный говорит, что именно отфильтровано.
  const heading = opts.q ? `Результаты: «${esc(opts.q)}»` : esc(opts.category || '');

  const dealsBand = deals.length ? `
    <section class="deals-band">
      <div class="container">
        <div class="deals-head">
          <div><span class="section-kicker">Ограниченное предложение</span>
          <h2 class="deals-title">Специальные цены</h2></div>
          <p class="deals-sub">Выгодные модели, пока действует акция</p>
        </div>
        <div class="grid">${deals.map((p, i) => productCard(p, settings, db, { eager: i < 4 })).join('')}</div>
      </div>
    </section>` : '';

  const heroText = bindShortWords(settings.tagline || 'Выбирайте нужную модель — мы поможем с остальным.');
  const intro = (!opts.q && !opts.category) ? `
    <section class="store-hero">
      <div class="container store-hero-inner">
        <div class="store-hero-copy">
          <h1 style="--fit:${heroFit(settings, heroText)}">${APPLE_MARK}${esc(heroText)}</h1>
        </div>
      </div>
      ${BENEFIT_SPRITE}
      <div class="hero-ticker">
        <div class="ticker-track">${tickerRow()}${Array.from({ length: TICKER_COPIES - 1 }, () => tickerRow(true)).join('')}</div>
      </div>
    </section>` : '';

  const body = `
    ${intro}
    ${dealsBand}
    <section class="container section">
      ${heading ? `<div class="section-head section-head-center"><h2>${heading}</h2></div>` : ''}
      ${list.length ? `<div class="grid">${cards}</div>` : `<p class="empty">Ничего не найдено.</p>`}
    </section>`;
  const origin = opts.origin || '';
  const ld = origin ? jsonLd({
    '@context': 'https://schema.org', '@graph': [
      { '@type': 'WebSite', url: origin, name: settings.storeName, inLanguage: 'ru', potentialAction: { '@type': 'SearchAction', target: origin + '/?q={search_term_string}', 'query-input': 'required name=search_term_string' } },
      { '@type': 'Store', name: settings.storeName, url: origin, description: settings.tagline || undefined }
    ]
  }) : '';
  return layout(settings, {
    body,
    categories: site ? T.siteCategories(site) : db.categories(),
    activeCategory: opts.category,
    q: opts.q,
    title: opts.category || (opts.q ? 'Поиск' : ''),
    // Страницы поиска и «не найдено» в индекс не отдаём: своей ценности в выдаче
    // у них нет, а дублей каталога от них много. Категории индексируются как были.
    noindex: !!(opts.noindex || opts.q || (opts.category && !categoryValid)),
    origin,
    canonicalPath: opts.category && categoryValid ? '/?category=' + encodeURIComponent(opts.category) : '/',
    description: settings.tagline, ogType: 'website', jsonLd: ld
  });
}

function notFoundPage(settings, opts) {
  opts = opts || {};
  const body = `<section class="container section not-found">
    <div class="empty"><span class="section-kicker">Ошибка 404</span><h1>Страница не найдена</h1>
    <p>Возможно, адрес изменился или в ссылке есть опечатка.</p>
    <a class="btn btn-primary" href="/">Вернуться в каталог</a></div>
  </section>`;
  return layout(settings, {
    body, categories: opts.categories || [], title: 'Страница не найдена',
    origin: opts.origin || '', noindex: true, noCanonical: true,
    description: 'Запрошенная страница не найдена'
  });
}

function productPage(settings, db, p, site, opts) {
  opts = opts || {};
  const published = site ? T.siteReviews(site, p.id) : db.reviewsForProduct(p.id, true);
  // opts.ownReviews — отзывы самого посетителя, ещё не одобренные. Для него они
  // стоят в общем списке и считаются в оценке; другим они не отдаются вовсе.
  const own = (opts.ownReviews || []).filter(Boolean);
  const reviews = own.length
    ? own.concat(published).sort((a, b) => Number(b.createdAt || 0) - Number(a.createdAt || 0))
    : published;
  const r = own.length
    ? { count: reviews.length, avg: Math.round(reviews.reduce((a, rv) => a + Number(rv.rating || 0), 0) / reviews.length * 10) / 10 }
    : (p._rating || db.ratingFor(p.id));
  // Что выбрано по умолчанию: первый доступный корпус и подходящий ему ремешок.
  const defColorIdx = (p.colors && p.colors.length) ? firstAvailableColor(p) : -1;
  const defColor = defColorIdx > -1 ? p.colors[defColorIdx].name : '';
  const defBand = defaultBand(p.bands, defColor);
  // Стартовая сборка: конфигурация и значения групп считаются вместе, потому что
  // у Mac они зависят друг от друга (объём памяти определяет чип).
  const defChoice = defaultChoices(p);
  const defBandKey = defBand ? `${p.bands[defBand.gi].name}|${((p.bands[defBand.gi].options || [])[defBand.oi] || {}).name || ''}` : '';
  const imgColorOf = s => (p.imageColors && s && p.imageColors[s]) || '';
  const imgBandOf = s => (p.imageBands && s && p.imageBands[s]) || '';
  // Первый кадр — тот же, что покажет галерея после фильтра: снимок выбранной пары
  // «ремешок + корпус». Иначе страница на миг открывалась с чужого варианта.
  const startIdx = (() => {
    const imgs = p.images || [];
    const tiers = [
      s => defBandKey && imgBandOf(s) === defBandKey && imgColorOf(s) === defColor,
      s => defBandKey && imgBandOf(s) === defBandKey && !imgColorOf(s),
      s => defColor && imgColorOf(s) === defColor && !imgBandOf(s),
      s => !imgColorOf(s) && !imgBandOf(s)
    ];
    for (const t of tiers) { const i = imgs.findIndex(t); if (i > -1) return i; }
    return 0;
  })();
  const mainImg = imageMarkup(p, startIdx, { eager: true });
  // Данные слайдов для JS-галереи (стрелки + точки, как на apple.com)
  const slidesData = (p.images && p.images.length)
    ? esc(JSON.stringify(p.images.map(s => ({ src: '/uploads/' + s, color: imgColorOf(s), band: imgBandOf(s) }))))
    : '';
  const chevL = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 5l-7 7 7 7"/></svg>`;
  const chevR = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 5l7 7-7 7"/></svg>`;
  const galleryNav = (p.images && p.images.length > 1) ? `
        <button type="button" class="g-arrow g-prev" id="g-prev" aria-label="Предыдущее фото">${chevL}</button>
        <button type="button" class="g-arrow g-next" id="g-next" aria-label="Следующее фото">${chevR}</button>` : '';
  const hot = D.dealActive(p);
  const eff = D.effectivePrice(p);
  const cmp = D.comparePrice(p);
  const pct = D.discountPct(p);
  // id нужны скрипту: при выборе памяти и доп. характеристик зачёркнутая цена
  // пересчитывается вместе с основной (`applyVariant()` в public/app.js).
  const discount = cmp
    ? `<span class="old-price" id="product-old-price">${money(cmp, settings)}</span><span class="save" id="product-save">−${pct}%</span>` : '';
  const dealBanner = (hot && p.hotDealUntil)
    ? `<div class="deal-banner" data-deal-until="${p.hotDealUntil}">Специальная цена · ещё <b class="dt-val">—</b></div>` : '';

  // разбивка по звёздам и средние по аспектам
  const dist = [0, 0, 0, 0, 0];
  const asp = { delivery: [0, 0], service: [0, 0], price: [0, 0] };
  reviews.forEach(rv => {
    const st = Math.round(rv.rating); if (st >= 1 && st <= 5) dist[st - 1]++;
    if (rv.aspects) ['delivery', 'service', 'price'].forEach(k => { if (rv.aspects[k]) { asp[k][0] += Number(rv.aspects[k]); asp[k][1]++; } });
  });
  const aspAvg = k => asp[k][1] ? Math.round(asp[k][0] / asp[k][1] * 10) / 10 : null;

  // Свои неодобренные отзывы закреплены сверху и в постраничную выдачу не входят:
  // иначе при сортировке «сначала полезные» автор искал бы свой отзыв на пятой странице.
  const slice = reviewsSlice(published, opts.reviewSort, opts.reviewPage);
  const ownItems = own.map(reviewCard).join('');
  const reviewItems = slice.total ? slice.html : `<p class="muted">Отзывов пока нет. Оставьте первый!</p>`;
  const reviewsBase = '/product/' + encodeURIComponent(p.id);
  // Ссылки настоящие: без JS это обычная постраничная навигация, с JS витрина
  // подменяет список и листалку, не перезагружая страницу товара целиком.
  const pager = slice.pages > 1 ? `
      <div class="reviews-pager" id="reviews-pager" data-product="${esc(p.id)}" data-href="${reviewsBase}" data-sort="${slice.sort}" data-page="${slice.page}" data-pages="${slice.pages}" data-total="${slice.total}">${reviewsPager(slice, reviewsBase)}</div>` : '';

  const breakdown = r.count ? `
    <div class="rating-overview">
      <div class="rating-big"><div class="rating-num">${r.avg}</div>${stars(r.avg)}<div class="muted small">${reviewCountText(r.count)}</div></div>
      <div class="rating-bars">
        ${[5, 4, 3, 2, 1].map(s => { const c = dist[s - 1]; const pct = r.count ? Math.round(c / r.count * 100) : 0; return `<div class="rbar"><span class="rbar-star">${s}★</span><div class="rbar-track"><div class="rbar-fill" style="width:${pct}%"></div></div><span class="muted small rbar-num">${c}</span></div>`; }).join('')}
      </div>
      ${(aspAvg('delivery') != null || aspAvg('service') != null || aspAvg('price') != null) ? `<div class="aspects">
        ${aspAvg('delivery') != null ? `<div class="asp"><span>🚚 Доставка</span><b>${aspAvg('delivery')}</b></div>` : ''}
        ${aspAvg('service') != null ? `<div class="asp"><span>🎧 Обслуживание</span><b>${aspAvg('service')}</b></div>` : ''}
        ${aspAvg('price') != null ? `<div class="asp"><span>💰 Цена/качество</span><b>${aspAvg('price')}</b></div>` : ''}
      </div>` : ''}
    </div>` : '';

  const ratingSummary = r.count
    ? `<a href="#reviews" class="rating-summary">${stars(r.avg)}<b>${r.avg}</b><span class="muted">· ${reviewCountText(r.count)}</span></a>`
    : `<a href="#reviews" class="rating-summary muted">Нет отзывов</a>`;

  const body = `
  <div class="container">
    <nav class="breadcrumb"><a href="/">Главная</a> / <a href="/?category=${encodeURIComponent(p.category)}">${esc(p.category)}</a> / <span>${esc(p.name)}</span></nav>
    <div class="product">
      <div class="product-gallery">
        <div class="gallery" id="gallery"${slidesData ? ` data-imgs="${slidesData}"` : ''}>
          <div class="gallery-main" id="gallery-main">${mainImg}</div>
          ${galleryNav}
        </div>
        <div class="g-dots" id="g-dots"></div>
      </div>
      <div class="product-info">
        <div class="product-cat">${esc(p.category)}</div>
        <h1 class="product-name">${esc(p.name)}</h1>
        ${ratingSummary}
        ${dealBanner}
        <div class="product-price${cmp ? ' price-sale' : ''}"><span class="price-now" id="product-price">${money(eff, settings)}</span> ${discount}</div>
        ${p.shortDesc ? `<p class="product-short">${esc(p.shortDesc)}</p>` : ''}
        ${(p.colors && p.colors.length) ? (() => {
          const sel = defColorIdx;
          return `
        <div class="variant-group">
          <div class="variant-label">Цвет: <b id="sel-color">${esc(p.colors[sel].name)}</b></div>
          <div class="swatches" id="colors">
            ${p.colors.map((c, i) => { const ok = colorAvailable(p, c); return `<button type="button" class="swatch${i === sel ? ' active' : ''}${ok ? '' : ' out'}" data-color="${esc(c.name)}" aria-label="Цвет: ${esc(c.name)}${ok ? '' : ' — нет в наличии'}" aria-pressed="${i === sel ? 'true' : 'false'}" title="${esc(c.name)}${ok ? '' : ' — нет в наличии'}" style="--sw:${cssColor(c.hex, '#cccccc')}"${ok ? '' : ' disabled'}></button>`; }).join('')}
          </div>
        </div>`; })() : ''}
        ${(p.storages && p.storages.length) ? (() => {
          const sel = defChoice.storageIdx;
          return `
        <div class="variant-group">
          <div class="variant-label">${variantLabel(p)}</div>
          <div class="storage-opts" id="storages">
            ${p.storages.map((s, i) => { const ok = variantInStock(s); const fit = V.optionFits(s, '', defChoice.picked); return `<button type="button" class="storage-opt${i === sel ? ' active' : ''}${ok ? '' : ' out'}" data-add="${Number(s.add) || 0}" data-label="${esc(s.label)}" data-for-choice="${esc(JSON.stringify(s.forChoice || null))}" aria-pressed="${i === sel ? 'true' : 'false'}"${ok ? '' : ' disabled title="Нет в наличии"'}${fit ? '' : ' hidden'}>${esc(s.label)}${ok ? '' : '<span class="opt-note">нет в наличии</span>'}</button>`; }).join('')}
          </div>
        </div>`; })() : ''}
        ${(p.options && p.options.length) ? (() => {
          // Значения, доступные не со всеми конфигурациями, прячем уже на сервере
          // тем же правилом, что применит JS при смене памяти: иначе на 256 ГБ
          // мелькало бы нанотекстурное стекло, которого с ней не бывает.
          const storage = defChoice.storage;
          return `
        <div class="variant-group option-groups" id="options">
          ${p.options.map(g => {
            const sel = defaultOption(g, storage, defChoice.picked);
            return `<div class="option-group" data-group="${esc(g.name)}">
            <div class="variant-label">${esc(g.name)}</div>
            ${g.hint ? `<p class="variant-hint">${esc(g.hint)}</p>` : ''}
            <div class="option-opts">
              ${(g.values || []).map((v, i) => {
                const ok = variantInStock(v);
                const add = Number(v.add) || 0;
                return `<button type="button" class="option-opt${i === sel ? ' active' : ''}${ok ? '' : ' out'}" data-label="${esc(v.label)}" data-add="${add}" data-for-storage="${esc((v.forStorage || []).join('|'))}" data-for-choice="${esc(JSON.stringify(v.forChoice || null))}" aria-pressed="${i === sel ? 'true' : 'false'}"${ok ? '' : ' disabled title="Нет в наличии"'}${V.optionFits(v, storage, defChoice.picked) ? '' : ' hidden'}><span class="opt-name">${esc(v.label)}</span><span class="opt-add">${add > 0 ? '+ ' + money(add, settings) : 'без доплаты'}</span>${ok ? '' : '<span class="opt-note">нет в наличии</span>'}</button>`;
              }).join('')}
            </div>
          </div>`;
          }).join('')}
        </div>`; })() : ''}
        ${(p.bands && p.bands.length) ? (() => {
          const gi = defBand.gi;
          const group = p.bands[gi];
          const oi = defBand.oi;
          // Вариации не для выбранного корпуса прячем уже на сервере — тем же
          // правилом, что применяет JS при смене цвета. Иначе при загрузке
          // мелькали ремешки, которых с этим корпусом не бывает.
          const fits = o => bandFits(o, defColor);
          const groupFits = g => (g.options || []).some(o => fits(o) && variantInStock(o));
          const tabs = p.bands.length > 1 ? `<div class="band-tabs" id="band-tabs" role="tablist">
            ${p.bands.map((g, i) => `<button type="button" class="band-tab${i === gi ? ' active' : ''}" data-group="${i}" role="tab" aria-selected="${i === gi ? 'true' : 'false'}"${groupFits(g) ? '' : ' hidden'}>${esc(g.name)}</button>`).join('')}
          </div>` : '';
          // Цвета и размеры готовим для всех коллекций сразу, показываем выбранную —
          // так переключение мгновенное и работает без ожидания запроса.
          const colorRows = p.bands.map((g, i) => `<div class="band-colors" data-group="${i}"${i === gi ? '' : ' hidden'}>
            ${(g.options || []).map((o, j) => { const ok = variantInStock(o); const selected = i === gi && j === oi; return `<button type="button" class="swatch${selected ? ' active' : ''}${ok ? '' : ' out'}" data-band="${esc(g.name)}" data-option="${esc(o.name)}" data-add="${Number(o.add) || 0}" data-for-color="${esc(o.forColor || '')}" title="${esc(o.name)}${ok ? '' : ' — нет в наличии'}" aria-label="Ремешок ${esc(g.name)}: ${esc(o.name)}" aria-pressed="${selected ? 'true' : 'false'}" style="--sw:${cssColor(o.hex, '#cccccc')}"${ok ? '' : ' disabled'}${fits(o) ? '' : ' hidden'}></button>`; }).join('')}
          </div>`).join('');
          const sizeRows = p.bands.map((g, i) => (g.sizes || []).length ? `<div class="band-sizes" data-group="${i}"${i === gi ? '' : ' hidden'}>
            ${g.sizes.map((s, j) => `<button type="button" class="storage-opt${i === gi && j === 0 ? ' active' : ''}" data-size="${esc(s.label)}" data-add="${Number(s.add) || 0}" aria-pressed="${i === gi && j === 0 ? 'true' : 'false'}">${esc(s.label)}</button>`).join('')}
          </div>` : '').join('');
          return `
        <div class="variant-group band-group" id="bands">
          <div class="variant-label">Ремешок: <b id="sel-band">${esc(group.name)} · ${esc((group.options[oi] || {}).name || '')}</b></div>
          ${tabs}
          <div class="band-color-rows" id="band-color-rows">${colorRows}</div>
          ${sizeRows ? `<div class="variant-sub">Размер ремешка</div><div class="band-size-rows" id="band-size-rows">${sizeRows}</div>` : ''}
        </div>`; })() : ''}
        ${stockNote(p)}
        <div class="buy-row">
          <div class="qty" data-qty>
            <button type="button" class="qty-btn" data-delta="-1" aria-label="Меньше">−</button>
            <input type="text" value="1" inputmode="numeric" class="qty-input" aria-label="Количество" readonly>
            <button type="button" class="qty-btn" data-delta="1" aria-label="Больше">+</button>
          </div>
          <button class="btn btn-primary btn-lg add-to-cart" data-id="${p.id}"
            data-base-name="${esc(p.name)}" data-name="${esc(p.name)}"
            data-img="${esc((p.images || [])[0] || '')}"
            data-base-price="${eff}" data-price="${eff}" data-base-compare="${cmp || 0}"
            data-qty-source ${sellable(p) ? '' : 'disabled'}>
            ${sellable(p) ? 'Добавить в корзину' : 'Нет в наличии'}
          </button>
        </div>
        ${TRUST_BLOCK}
      </div>
    </div>

    ${p.description ? `<section class="section"><h2>Описание</h2><div class="prose">${esc(p.description).replace(/\n/g, '<br>')}</div></section>` : ''}
    ${specHighlights(p)}

    <section class="section" id="reviews">
      <div class="section-head"><h2>Отзывы ${r.count ? `(${r.count})` : ''}</h2></div>
      ${breakdown}
      ${r.count ? `<div class="reviews-toolbar"><span class="sort-label muted small">Сортировка:</span>${
        REVIEW_SORTS.map(([mode, label]) =>
          `<a class="sort-btn${slice.sort === mode ? ' active' : ''}" href="${reviewsBase}?rsort=${mode}#reviews" data-sort="${mode}"${slice.sort === mode ? ' aria-current="true"' : ''}>${label}</a>`
        ).join('')}</div>` : ''}
      ${ownItems ? `<div class="reviews-list reviews-own">${ownItems}</div>` : ''}
      <div class="reviews-list" id="reviews-list" data-product="${esc(p.id)}" data-href="${reviewsBase}">${reviewItems}</div>
      ${pager}

      <div class="review-form-wrap">
        <h3>Оставить отзыв</h3>
        <form id="review-form" enctype="multipart/form-data">
          <input type="hidden" name="productId" value="${p.id}">
          <div class="field">
            <label>Общая оценка</label>
            <div class="rate-input" id="rate-input" data-value="5" role="radiogroup" aria-label="Общая оценка">
              ${[1,2,3,4,5].map(i => `<button type="button" class="rate-star" data-v="${i}" role="radio" aria-label="${i} из 5" aria-checked="${i === 5 ? 'true' : 'false'}">★</button>`).join('')}
            </div>
            <input type="hidden" name="rating" id="rating-value" value="5">
          </div>
          <div class="aspect-inputs">
            ${[['delivery', 'Доставка'], ['service', 'Обслуживание'], ['price', 'Цена/качество']].map(([k, l]) => `<div class="aspect-row"><span>${l}</span><div class="rate-input rate-sm" data-aspect="${k}" data-value="5" role="radiogroup" aria-label="${l}">${[1, 2, 3, 4, 5].map(i => `<button type="button" class="rate-star" data-v="${i}" role="radio" aria-label="${i} из 5" aria-checked="${i === 5 ? 'true' : 'false'}">★</button>`).join('')}</div><input type="hidden" name="aspect_${k}" value="5"></div>`).join('')}
          </div>
          <div class="field">
            <label for="rv-author">Имя</label>
            <input type="text" id="rv-author" name="author" maxlength="60" placeholder="Как вас представить" required>
          </div>
          <div class="field">
            <label for="rv-text">Отзыв</label>
            <textarea id="rv-text" name="text" rows="4" maxlength="2000" placeholder="Поделитесь впечатлением о товаре"></textarea>
          </div>
          ${REVIEW_PHOTOS ? `<div class="field">
            <label for="rv-photos">Фото (по желанию)</label>
            <input type="file" id="rv-photos" name="photos" accept="image/*" multiple>
          </div>` : ''}
          <p class="form-legal-note">После нажатия кнопки мы отдельно попросим подтвердить обработку данных и публикацию отзыва. <a href="/privacy" target="_blank" rel="noopener">Подробнее</a></p>
          <button type="submit" class="btn btn-primary">Отправить отзыв</button>
          <p class="form-msg" id="review-msg" hidden></p>
        </form>
      </div>
    </section>
  </div>`;

  const origin = opts.origin || '';
  const imgAbs = (p.images || []).map(f => origin + '/uploads/' + f);
  const shortD = (p.shortDesc || String(p.description || '').replace(/\s+/g, ' ').trim().slice(0, 200) || p.name);
  const ld = origin ? jsonLd({
    '@context': 'https://schema.org', '@type': 'Product',
    name: p.name, sku: p.id, category: p.category, description: shortD,
    image: imgAbs.length ? imgAbs : undefined,
    offers: {
      '@type': 'Offer', price: eff, priceCurrency: currencyCode(settings.currency),
      // sellable(), а не p.inStock: если распроданы все цвета или все конфигурации,
      // кнопка на витрине уже неактивна — поисковику незачем обещать наличие.
      availability: 'https://schema.org/' + (sellable(p) ? 'InStock' : 'OutOfStock'), url: origin + '/product/' + p.id
    },
    aggregateRating: r.count ? { '@type': 'AggregateRating', ratingValue: r.avg, reviewCount: r.count } : undefined
  }) : '';
  return layout(settings, {
    body,
    categories: site ? T.siteCategories(site) : db.categories(),
    title: p.name,
    origin, canonicalPath: '/product/' + p.id, description: shortD, ogType: 'product',
    ogImage: (p.images && p.images[0]) ? '/uploads/' + p.images[0] : '', jsonLd: ld
  });
}

function operatorDetails(settings) {
  const operator = String(settings.legalOperator || settings.storeName || 'Владелец сайта').trim();
  const registration = String(settings.legalDetails || '').trim();
  const address = String(settings.legalAddress || '').trim();
  const email = String(settings.privacyEmail || '').trim();
  const telegram = String(settings.contactTelegram || '').trim();
  const phone = String(settings.contactPhone || '').trim();
  const contact = email
    ? `<a href="mailto:${esc(email)}">${esc(email)}</a>`
    : (phone ? esc(phone) : (telegram ? esc(telegram) : 'через контакты, указанные на сайте'));
  return { operator, registration, address, email, contact };
}

function operatorCard(settings) {
  const info = operatorDetails(settings);
  return `<dl class="legal-details">
    <div><dt>Оператор</dt><dd>${esc(info.operator)}</dd></div>
    ${info.registration ? `<div><dt>Реквизиты</dt><dd>${esc(info.registration)}</dd></div>` : ''}
    ${info.address ? `<div><dt>Адрес</dt><dd>${esc(info.address)}</dd></div>` : ''}
    <div><dt>Обращения по персональным данным</dt><dd>${info.contact}</dd></div>
  </dl>`;
}

// Отдельный шаг оформления: список позиций и форма живут на своей странице,
// а не поверх корзины — иначе на телефоне список приходится проматывать сквозь форму.
function checkoutPage(settings, opts) {
  opts = opts || {};
  // Включена ли онлайн-оплата — единственное, что витрина знает о платёжке.
  // Ключи кассы остаются на сервере, как и ключ подсказок адреса.
  const pay = opts.payOnline ? ' data-pay="1"' : '';
  const body = `<div class="container checkout-page" id="checkout-page"${pay}>
    <header class="checkout-head">
      <h1 class="checkout-title">Оформление заказа</h1>
      <p class="checkout-sub">${opts.payOnline
        ? 'Проверьте состав заказа, оставьте контакт и выберите, как удобнее — оплатить сразу или дождаться менеджера'
        : 'Проверьте состав заказа и оставьте контакт — менеджер свяжется с вами и подтвердит наличие'}</p>
    </header>
    <div class="checkout-grid">
      <section class="checkout-col checkout-items" id="checkout-items" aria-label="Товары в заказе"></section>
      <aside class="checkout-col checkout-side" id="checkout-side"></aside>
    </div>
  </div>`;
  return layout(settings, {
    body, categories: opts.categories || [], title: 'Оформление заказа',
    origin: opts.origin || '', canonicalPath: '/checkout', noindex: true,
    description: `Оформление заказа в ${settings.storeName}`
  });
}

// Куда возвращается плательщик с формы CrocoPAY. Страница нарочно не утверждает,
// что деньги получены: подтверждает оплату только вебхук, а сюда покупатель
// попадает и просто закрыв форму. Обещать «оплачено» раньше вебхука — значит
// однажды пообещать это тому, кто не заплатил.
function paymentPage(settings, opts) {
  opts = opts || {};
  const cancelled = opts.kind === 'cancel';
  const number = String(opts.number || '').trim().slice(0, 40);
  const body = `<div class="container checkout-page">
    <header class="checkout-head">
      <h1 class="checkout-title">${cancelled ? 'Оплата не завершена' : 'Платёж отправлен'}</h1>
    </header>
    <div class="checkout-done">
      <section class="order-success${cancelled ? ' order-success-neutral' : ''}" role="status" aria-live="polite">
        <div class="order-success-check" aria-hidden="true">${cancelled ? '↩' : '✓'}</div>
        <p class="order-success-eyebrow">${cancelled ? 'Заявка сохранена' : 'Спасибо!'}</p>
        <h3>${cancelled ? 'Оплата отменена' : 'Мы проверяем платёж'}</h3>
        <p class="order-success-copy">${cancelled
          ? 'Заказ остался в работе — оплату можно не делать: менеджер свяжется с вами и подтвердит детали.'
          : 'Платёж подтверждается платёжным сервисом, это занимает до нескольких минут. Менеджер свяжется с вами и подтвердит заказ.'}</p>
        ${number ? `<div class="order-success-number"><span>Номер заказа</span><strong>${esc(number)}</strong></div>` : ''}
        <a class="btn btn-primary btn-lg" href="/">Продолжить покупки</a>
      </section>
    </div>
  </div>`;
  return layout(settings, {
    body, categories: opts.categories || [],
    title: cancelled ? 'Оплата не завершена' : 'Платёж отправлен',
    origin: opts.origin || '', canonicalPath: cancelled ? '/pay/cancel' : '/pay/success', noindex: true,
    description: `Оплата заказа в ${settings.storeName}`
  });
}

function privacyPage(settings, opts) {
  opts = opts || {};
  const info = operatorDetails(settings);
  const body = `<div class="container legal-page">
    <nav class="breadcrumb"><a href="/">Главная</a> / <span>Политика конфиденциальности</span></nav>
    <header class="legal-hero">
      <span class="section-kicker">Правовая информация</span>
      <h1>Политика конфиденциальности и обработки персональных данных</h1>
    </header>

    <div class="legal-card">
      <section class="legal-section" id="general">
        <h2>1. Общие положения</h2>
        <p>Настоящая Политика описывает, как ${esc(settings.storeName)} обрабатывает и защищает персональные данные посетителей сайта. Она составлена с учётом Федерального закона от 27.07.2006 № 152-ФЗ «О персональных данных» и иных применимых норм законодательства Российской Федерации.</p>
        <p>Оператор обрабатывает данные, необходимые для ответа на обращение, оформления заказа, публикации и модерации отзывов, работы корзины, защиты сайта и собственной аналитики посещаемости.</p>
      </section>

      <section class="legal-section" id="operator">
        <h2>2. Оператор и контакты</h2>
        ${operatorCard(settings)}
      </section>

      <section class="legal-section" id="data">
        <h2>3. Какие данные обрабатываются</h2>
        <ul>
          <li><b>Заказы и обращения:</b> имя (если указано), телефон, Telegram или e-mail, адрес доставки (если указан), состав и параметры заказа.</li>
          <li><b>Отзывы:</b> имя или псевдоним, оценки, текст, приложенные фотографии и сведения о товаре.</li>
          <li><b>Технические данные:</b> IP-адрес, дата и время запроса, адрес страницы, сведения о браузере и устройстве — для работы сервера, безопасности и ограничения спама.</li>
          <li><b>Собственная метрика:</b> случайный идентификатор посетителя, посещённые страницы, число, продолжительность и время визитов, источник и UTM-метки, IP-адрес, приблизительные город, регион и страна, факт оформления заявки.</li>
          <li><b>Устройство:</b> тип и модель устройства, браузер, операционная система, язык, часовой пояс, платформа, размер экрана и окна, объём памяти, число логических процессоров и тип соединения — если браузер предоставляет эти сведения.</li>
          <li><b>Данные браузера:</b> содержимое корзины и настройка отключения собственной метрики хранятся локально на устройстве посетителя.</li>
        </ul>
        <p>Сайт не запрашивает паспортные данные, платёжные реквизиты или специальные категории персональных данных. Не указывайте их в свободных полях и не загружайте на фотографиях.</p>
      </section>

      <section class="legal-section" id="purposes">
        <h2>4. Цели и основания обработки</h2>
        <div class="legal-table-wrap"><table class="legal-table purposes-table"><thead><tr><th>Цель</th><th>Данные</th><th>Основание</th></tr></thead><tbody>
          <tr><td>Обработка заявки и связь с покупателем</td><td>Имя, контакт, адрес доставки, заказ</td><td>Действия по инициативе посетителя до заключения договора и исполнение договора (п. 5 ч. 1 ст. 6 Закона № 152-ФЗ)</td></tr>
          <tr><td>Модерация и публикация отзыва</td><td>Имя или псевдоним, оценки, текст, фотографии</td><td>Отдельные согласия на обработку и распространение</td></tr>
          <tr><td>Безопасность и предотвращение злоупотреблений</td><td>Технические данные</td><td>Исполнение обязанностей оператора и защита законных интересов</td></tr>
          <tr><td>Корзина и интерфейс сайта</td><td>Локальные идентификаторы и выбранные товары</td><td>Запрос посетителя на использование функций сайта</td></tr>
          <tr><td>Оценка посещаемости, эффективности и улучшение сайта</td><td>Идентификатор метрики, посещения, устройство, источник, IP и приблизительная геолокация</td><td>Осуществление прав и законных интересов Оператора при условии соблюдения прав и свобод посетителя (п. 7 ч. 1 ст. 6 Закона № 152-ФЗ); итоговая статистика обезличивается</td></tr>
        </tbody></table></div>
      </section>

      <section class="legal-section" id="processing">
        <h2>5. Как обрабатываются данные</h2>
        <p>Обработка может включать сбор, запись, систематизацию, хранение, уточнение, извлечение, использование, предоставление лицам, обеспечивающим работу сайта, блокирование и удаление. Обработка выполняется автоматизированным способом и, при работе менеджера с заявкой, без использования средств автоматизации.</p>
        <p>Если для сайта настроены уведомления в Telegram, сведения из заказа или отзыва, включая IP, приблизительный город и данные устройства, могут быть направлены менеджеру через этот сервис. Переход посетителя по внешней ссылке Telegram регулируется также документами самого Telegram.</p>
        <p>Для определения приблизительного города по IP может использоваться сервис <a class="link" href="https://ipwhois.io/privacy" target="_blank" rel="noopener noreferrer">IPWhois</a>, которому передаётся IP-адрес. Точность такой геолокации не гарантируется. Иные сведения заказа сервису геолокации не передаются.</p>
        <p>Для подсказок при заполнении поля адреса на оформлении заказа может использоваться сервис <a class="link" href="https://dadata.ru/agreement/" target="_blank" rel="noopener noreferrer">DaData</a>: сервер сайта передаёт ему только ту строку, которую посетитель набирает в этом поле, и получает варианты адресов. Имя, контакт, состав заказа и иные сведения этому сервису не передаются, а подсказки можно не использовать — адрес допустимо ввести вручную или не указывать вовсе.</p>
        <p>Оператор не продаёт персональные данные, не передаёт их рекламным сетям и не использует сторонние рекламные cookie. Передача государственным органам допускается только в случаях, предусмотренных законом.</p>
      </section>

      <section class="legal-section" id="storage">
        <h2>6. Сроки хранения и защита</h2>
        <p>Данные заказа хранятся до завершения работы с заявкой и далее в течение срока, необходимого для исполнения договора, разрешения споров и выполнения требований закона. Данные отзыва хранятся до удаления отзыва, отзыва согласия либо прекращения работы сайта. Идентифицируемая карточка посетителя в собственной метрике автоматически ограничивается 365 днями.</p>
        <p>Оператор применяет разграничение доступа, защищённые сессии, ограничение частоты запросов, резервное копирование и иные разумные организационные и технические меры. Оператор обязан обеспечить выполнение применимых требований о локализации баз данных граждан Российской Федерации и трансграничной передаче до начала такой обработки.</p>
      </section>

      <section class="legal-section" id="rights">
        <h2>7. Права посетителя</h2>
        <p>Посетитель вправе запросить сведения об обработке своих данных, потребовать их уточнения, блокирования или удаления, а также отозвать согласие. Для этого направьте обращение Оператору: ${info.contact}. В обращении укажите сведения, позволяющие найти заявку или отзыв, и суть требования.</p>
        <p>Отзыв согласия не влияет на законность обработки до его отзыва и не прекращает обработку, для которой у Оператора остаётся иное предусмотренное законом основание. Посетитель также вправе обратиться в Роскомнадзор или суд.</p>
      </section>

      <section class="legal-section" id="cookies">
        <h2>8. Cookie и локальное хранилище</h2>
        <p>При открытии сайта автоматически запускается собственная first-party метрика. Она работает без стороннего аналитического скрипта и не используется для показа рекламы. Короткий технический сигнал отправляется не чаще одного раза в минуту и только пока страница видима.</p>
        <div class="legal-table-wrap"><table class="legal-table cookies-table"><thead><tr><th>Название</th><th>Тип</th><th>Назначение</th><th>Срок</th></tr></thead><tbody>
          <tr><td><code>sess</code></td><td>Cookie, HttpOnly, SameSite=Lax, Secure при HTTPS</td><td>Защищённая авторизация владельца и администратора. Для обычного просмотра не создаётся.</td><td>До 7 дней или до выхода</td></tr>
          <tr><td><code>cart_v1</code></td><td>localStorage</td><td>Хранит выбранные товары и их количество на устройстве посетителя.</td><td>До очистки данных сайта в браузере</td></tr>
          <tr><td><code>am_analytics</code></td><td>Cookie, HttpOnly, SameSite=Lax, Secure при HTTPS</td><td>Случайный идентификатор для подсчёта уникальных посетителей, визитов, просмотренных страниц и связи посещения с заявкой.</td><td>До 1 года или до отключения</td></tr>
          <tr><td><code>am_analytics_off</code></td><td>Cookie, HttpOnly, SameSite=Lax, Secure при HTTPS</td><td>Не позволяет серверу снова создавать идентификатор после отключения метрики на этом устройстве.</td><td>До 1 года</td></tr>
          <tr><td><code>analytics_disabled_v1</code></td><td>localStorage</td><td>Запоминает отключение собственной метрики на этом устройстве.</td><td>До очистки данных сайта в браузере</td></tr>
        </tbody></table></div>
        <p>Запись выполняется на сервере сайта; рекламные идентификаторы и содержимое полей форм в статистику не попадают. Параметры URL очищаются, кроме явно указанных UTM-меток рекламной кампании.</p>
        <p>Метрику можно отключить для этого устройства: идентификатор и связанная с ним карточка посетителя будут удалены. Обезличенные итоговые счётчики посещений могут сохраниться, а данные уже оформленных заказов хранятся по правилам раздела 6.</p>
        <div class="legal-actions"><button class="btn" type="button" id="analytics-disable">Отключить метрику на этом устройстве</button></div>
      </section>

      <section class="legal-section" id="changes">
        <h2>9. Изменение Политики</h2>
        <p>Оператор может обновлять Политику при изменении функций сайта или законодательства. Новая редакция действует с момента публикации по этому адресу.</p>
        <div class="legal-actions"><a class="btn" href="/personal-data-consent">Согласие на обработку данных</a><a class="btn" href="/personal-data-publication-consent">Согласие на публикацию отзыва</a></div>
      </section>
    </div>
  </div>`;
  return layout(settings, {
    body, categories: opts.categories || [], title: 'Политика конфиденциальности',
    origin: opts.origin || '', canonicalPath: '/privacy',
    description: `Политика конфиденциальности и обработки персональных данных ${settings.storeName}`
  });
}

function personalDataConsentPage(settings, opts) {
  opts = opts || {};
  const body = `<div class="container legal-page">
    <nav class="breadcrumb"><a href="/">Главная</a> / <span>Согласие на обработку данных</span></nav>
    <header class="legal-hero"><span class="section-kicker">Отдельный документ</span><h1>Согласие на обработку персональных данных</h1></header>
    <div class="legal-card">
      <section class="legal-section"><h2>Оператор</h2>${operatorCard(settings)}</section>
      <section class="legal-section">
        <h2>Условия согласия</h2>
        <p>Нажимая кнопку «Согласен» в отдельном окне перед отправкой отзыва, я свободно, своей волей и в своём интересе даю Оператору конкретное, информированное и однозначное согласие на обработку переданных мной персональных данных.</p>
        <h3>Данные отзыва</h3>
        <p>Состав данных: имя или псевдоним, оценки, текст, фотографии и сведения о товаре. Цели: принять, проверить и модерировать отзыв. Публикация данных на сайте регулируется <a class="link" href="/personal-data-publication-consent">отдельным согласием на распространение</a>.</p>
        <p>Разрешённые действия: сбор, запись, систематизация, хранение, уточнение, извлечение, использование, предоставление техническим исполнителям, блокирование и удаление; автоматизированная и неавтоматизированная обработка. Если настроены уведомления, данные могут быть переданы менеджеру через Telegram в объёме, необходимом для работы с обращением.</p>
        <p>Согласие действует до достижения указанных целей либо до его отзыва, если обработка не должна быть продолжена на ином законном основании. Отозвать согласие можно по контактам Оператора, указанным выше. Порядок обработки и права субъекта подробнее описаны в <a class="link" href="/privacy">Политике конфиденциальности</a>.</p>
      </section>
    </div>
  </div>`;
  return layout(settings, { body, categories: opts.categories || [], title: 'Согласие на обработку персональных данных', origin: opts.origin || '', canonicalPath: '/personal-data-consent', description: `Согласие на обработку персональных данных ${settings.storeName}` });
}

function publicationConsentPage(settings, opts) {
  opts = opts || {};
  const body = `<div class="container legal-page">
    <nav class="breadcrumb"><a href="/">Главная</a> / <span>Согласие на публикацию отзыва</span></nav>
    <header class="legal-hero"><span class="section-kicker">Отдельный документ</span><h1>Согласие на обработку персональных данных, разрешённых для распространения</h1></header>
    <div class="legal-card">
      <section class="legal-section"><h2>Оператор</h2>${operatorCard(settings)}</section>
      <section class="legal-section">
        <h2>Что разрешается публиковать</h2>
        <p>Нажимая кнопку «Согласен и отправить» в отдельном окне публикации, я разрешаю Оператору после модерации разместить на сайте указанные мной имя или псевдоним, оценку, текст отзыва и приложенные фотографии в связи с выбранным товаром.</p>
        <p>Доступ к опубликованным сведениям получает неограниченный круг посетителей сайта. Оператор вправе не публиковать отзыв, скрыть или удалить его. Передача опубликованных сведений третьим лицам для самостоятельного использования и продвижение отзыва в рекламе этим согласием не разрешаются.</p>
        <p>Я подтверждаю, что не включил(а) в отзыв лишние контактные, паспортные, платёжные и иные конфиденциальные сведения, а также персональные данные третьих лиц без законного основания.</p>
        <p>Согласие действует до удаления отзыва или его отзыва мной. Отозвать согласие и потребовать удаления можно по контактам Оператора, указанным выше, сообщив товар, имя или псевдоним и примерную дату публикации.</p>
        <p><a class="link" href="/privacy">Политика конфиденциальности</a> · <a class="link" href="/personal-data-consent">Согласие на обработку данных</a></p>
      </section>
    </div>
  </div>`;
  return layout(settings, { body, categories: opts.categories || [], title: 'Согласие на публикацию отзыва', origin: opts.origin || '', canonicalPath: '/personal-data-publication-consent', description: `Согласие на публикацию отзыва ${settings.storeName}` });
}

module.exports = {
  esc, money, formatDate, paymentBadge, stars, layout, homePage, notFoundPage, productPage, checkoutPage, paymentPage, privacyPage,
  personalDataConsentPage, publicationConsentPage, imageMarkup, placeholderSvg,
  assetV, brandFields, cssColor, sellable, colorAvailable, defaultOption, accessibleFields, PRIVACY_VERSION,
  reviewsSlice, reviewCard, reviewsPager, reviewsRangeText, REVIEWS_PER_PAGE,
  reviewsPageNumbers, adminSlice, adminPager, ADMIN_PER_PAGE,
  heroFit, footFit, bindShortWords
};
