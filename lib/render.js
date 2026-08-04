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

function pluralRu(n, one, few, many) {
  const a = Math.abs(Number(n) || 0) % 100;
  const b = a % 10;
  if (a > 10 && a < 20) return many;
  if (b > 1 && b < 5) return few;
  return b === 1 ? one : many;
}
function reviewCountText(count) { return `${count} ${pluralRu(count, 'отзыв', 'отзыва', 'отзывов')}`; }

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

// Значение доп. характеристики, выбранное по умолчанию: первое доступное,
// подходящее выбранной конфигурации. Нанотекстурное стекло бывает только от
// 1 ТБ, и открывать страницу с варианта, который JS тут же спрячет, нельзя.
function defaultOption(group, storage) {
  const values = (group && group.values) || [];
  const pick = strict => values.findIndex(v => V.optionFits(v, storage) && (!strict || variantInStock(v)));
  let i = pick(true);
  if (i === -1) i = pick(false);
  return i === -1 ? 0 : i;
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
function variantLabel(storages) {
  // \b в JS работает только с ASCII, поэтому русские единицы проверяем без границ слова
  const all = (storages || []).map(s => s.label).join(' ');
  if (/мм|\bmm\b/i.test(all)) return 'Размер корпуса';
  if (/гб|тб|\bgb\b|\btb\b/i.test(all)) return 'Память';
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
  const compareHtml = cmp ? `<span class="old-price">${money(cmp, settings)}</span>` : '';
  // «Нет в наличии» важнее рекламной плашки и скидки — иначе покупатель видит
  // «−13%» на товаре, который нельзя купить.
  const badge = !inStock
    ? `<span class="badge badge-muted">Нет в наличии</span>`
    : (hot ? `<span class="badge badge-hot">−${pct}%</span>`
      : (p.badge ? `<span class="badge">${esc(p.badge)}</span>` : ''));
  const ratingLine = r.count
    ? `<div class="card-rating">${stars(r.avg)}<span class="rating-count">${r.avg} · ${r.count}</span></div>`
    : `<div class="card-rating card-rating-empty">Пока нет отзывов</div>`;
  const timer = (hot && p.hotDealUntil)
    ? `<div class="deal-timer" data-deal-until="${p.hotDealUntil}"><span class="dt-ico">⏳</span><span class="dt-val">—</span></div>` : '';
  // Карточка: ссылка и кнопка — соседи, а не вложены друг в друга (корректный HTML и доступность).
  return `
  <article class="card${hot ? ' card-hot' : ''}">
    <a class="card-link" href="/product/${p.id}">
      <div class="card-media">${badge}${imageMarkup(p, 0, { eager: !!opts.eager })}</div>
      <div class="card-body">
        <div class="card-cat">${esc(p.category)}</div>
        <div class="card-name">${esc(p.name)}</div>
        ${ratingLine}
        <div class="card-price${hot ? ' price-hot' : ''}">${money(eff, settings)} ${compareHtml}</div>
        ${timer}
      </div>
    </a>
    <div class="card-add">${!inStock
      ? `<button type="button" class="btn btn-primary btn-block" disabled>Нет в наличии</button>`
      : ((p.colors || []).length || (p.storages || []).length || (p.bands || []).length || (p.options || []).length)
        ? `<a class="btn btn-primary btn-block" href="/product/${p.id}">Выбрать вариант</a>`
        : `<button type="button" class="btn btn-primary btn-block add-to-cart"
          data-id="${p.id}" data-name="${esc(p.name)}" data-price="${eff}" data-img="${esc((p.images || [])[0] || '')}">В корзину</button>`}
    </div>
  </article>`;
}

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
      <div class="foot-note">${esc(settings.tagline || '')}</div>
    </div>
    ${(settings.contactTelegram || settings.contactPhone) ? `<div class="footer-contacts">
      ${settings.contactTelegram ? `<div class="foot-tg"><a class="tg-link" href="https://t.me/${esc(tgUser(settings))}" target="_blank" rel="noopener">${tgIcon()}<span>${esc(settings.contactTelegram)}</span></a></div>` : ''}
      ${settings.contactPhone ? `<div class="foot-contact">${esc(settings.contactPhone)}</div>` : ''}
    </div>` : ''}
    <div class="footer-bottom">
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

// Яблоко перед строкой «Оригинальная техника Apple…» — заливка currentColor,
// поэтому цвет задаётся из CSS вместе с текстом.
const APPLE_MARK = '<svg class="apple-mark" viewBox="0 0 24 24" aria-hidden="true">'
  + '<path d="M12.152 6.896c-.948 0-2.415-1.078-3.96-1.04-2.04.027-3.91 1.183-4.961 3.014-2.117 3.675-.546 9.103 1.519 12.09 1.013 1.454 2.208 3.09 3.792 3.039 1.52-.065 2.09-.987 3.935-.987 1.831 0 2.35.987 3.96.948 1.637-.026 2.676-1.48 3.676-2.948 1.156-1.688 1.636-3.325 1.662-3.415-.039-.013-3.182-1.221-3.22-4.857-.026-3.04 2.48-4.494 2.597-4.559-1.417-2.09-3.623-2.324-4.39-2.376-2-.156-3.675 1.088-4.61 1.088zM15.53 3.83c.843-1.012 1.4-2.427 1.245-3.83-1.207.052-2.662.805-3.532 1.818-.78.896-1.454 2.338-1.273 3.714 1.338.104 2.715-.688 3.559-1.701"/></svg>';

// Преимущества первого экрана. Глифы линейные, как иконки шапки: обводка
// currentColor, поэтому наследуют цвет плитки.
const BENEFIT_ICON = (d) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
const HERO_BENEFITS = [
  // Ценник с отверстием
  ['Оптовые цены', BENEFIT_ICON('<path d="M11.9 3.1H5.6a2.5 2.5 0 0 0-2.5 2.5v6.3c0 .66.26 1.3.73 1.77l6.9 6.9a2.5 2.5 0 0 0 3.54 0l5.86-5.86a2.5 2.5 0 0 0 0-3.54l-6.9-6.9a2.5 2.5 0 0 0-1.77-.73z"/><circle cx="8" cy="8" r="1.5"/>')],
  // Щит с галочкой
  ['1 год гарантии', BENEFIT_ICON('<path d="M12 2.7l7.3 2.6v5.5c0 4.4-2.95 8.4-7.3 9.6-4.35-1.2-7.3-5.2-7.3-9.6V5.3z"/><path d="M9 11.9l2.1 2.1 4-4"/>')],
  // Фургон доставки
  ['Быстрая доставка', BENEFIT_ICON('<path d="M2.6 7.2a1.6 1.6 0 0 1 1.6-1.6h8.3a1.6 1.6 0 0 1 1.6 1.6v9.2H2.6z"/><path d="M14.1 9.9h2.8c.45 0 .88.19 1.18.52l2.5 2.75c.26.29.4.66.4 1.04v2.19h-6.88z"/><circle cx="7.1" cy="17.9" r="1.9"/><circle cx="17.1" cy="17.9" r="1.9"/>')]
];

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
  const heading = opts.q ? `Результаты: «${esc(opts.q)}»` : esc(opts.category || 'Каталог');

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

  const intro = (!opts.q && !opts.category) ? `
    <section class="store-hero">
      <div class="container store-hero-inner">
        <div class="store-hero-copy">
          <span class="section-kicker">${esc(settings.storeName)}</span>
          <h1>Техника для важных моментов.</h1>
          <p class="store-hero-tag">${APPLE_MARK}<span>${esc(settings.tagline || 'Выбирайте нужную модель — мы поможем с остальным.')}</span></p>
        </div>
        <ul class="store-benefits" aria-label="Преимущества магазина">
          ${HERO_BENEFITS.map(([text, ico]) => `<li><span class="benefit-ico">${ico}</span>${text}</li>`).join('')}
        </ul>
      </div>
    </section>` : '';

  const body = `
    ${intro}
    ${dealsBand}
    <section class="container section">
      <div class="section-head"><h2>${heading}</h2></div>
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
  const discount = cmp
    ? `<span class="old-price">${money(cmp, settings)}</span><span class="save">−${pct}%</span>` : '';
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
        <div class="product-price${hot ? ' price-hot' : ''}"><span id="product-price">${money(eff, settings)}</span> ${discount}</div>
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
          const sel = firstAvailable(p.storages);
          return `
        <div class="variant-group">
          <div class="variant-label">${variantLabel(p.storages)}</div>
          <div class="storage-opts" id="storages">
            ${p.storages.map((s, i) => { const ok = variantInStock(s); return `<button type="button" class="storage-opt${i === sel ? ' active' : ''}${ok ? '' : ' out'}" data-add="${Number(s.add) || 0}" data-label="${esc(s.label)}" aria-pressed="${i === sel ? 'true' : 'false'}"${ok ? '' : ' disabled title="Нет в наличии"'}>${esc(s.label)}${ok ? '' : '<span class="opt-note">нет в наличии</span>'}</button>`; }).join('')}
          </div>
        </div>`; })() : ''}
        ${(p.options && p.options.length) ? (() => {
          // Значения, доступные не со всеми конфигурациями, прячем уже на сервере
          // тем же правилом, что применит JS при смене памяти: иначе на 256 ГБ
          // мелькало бы нанотекстурное стекло, которого с ней не бывает.
          const storage = (p.storages && p.storages.length)
            ? ((p.storages[firstAvailable(p.storages)] || {}).label || '') : '';
          return `
        <div class="variant-group option-groups" id="options">
          ${p.options.map(g => {
            const sel = defaultOption(g, storage);
            return `<div class="option-group" data-group="${esc(g.name)}">
            <div class="variant-label">${esc(g.name)}</div>
            ${g.hint ? `<p class="variant-hint">${esc(g.hint)}</p>` : ''}
            <div class="option-opts">
              ${(g.values || []).map((v, i) => {
                const ok = variantInStock(v);
                const add = Number(v.add) || 0;
                return `<button type="button" class="option-opt${i === sel ? ' active' : ''}${ok ? '' : ' out'}" data-label="${esc(v.label)}" data-add="${add}" data-for-storage="${esc((v.forStorage || []).join('|'))}" aria-pressed="${i === sel ? 'true' : 'false'}"${ok ? '' : ' disabled title="Нет в наличии"'}${V.optionFits(v, storage) ? '' : ' hidden'}><span class="opt-name">${esc(v.label)}</span><span class="opt-add">${add > 0 ? '+ ' + money(add, settings) : 'без доплаты'}</span>${ok ? '' : '<span class="opt-note">нет в наличии</span>'}</button>`;
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
        <div class="buy-row">
          <div class="qty" data-qty>
            <button type="button" class="qty-btn" data-delta="-1" aria-label="Меньше">−</button>
            <input type="text" value="1" inputmode="numeric" class="qty-input" aria-label="Количество" readonly>
            <button type="button" class="qty-btn" data-delta="1" aria-label="Больше">+</button>
          </div>
          <button class="btn btn-primary btn-lg add-to-cart" data-id="${p.id}"
            data-base-name="${esc(p.name)}" data-name="${esc(p.name)}"
            data-img="${esc((p.images || [])[0] || '')}"
            data-base-price="${eff}" data-price="${eff}" data-qty-source ${sellable(p) ? '' : 'disabled'}>
            ${sellable(p) ? 'Добавить в корзину' : 'Нет в наличии'}
          </button>
        </div>
        <div class="trust">
          <span>✓ Оригинальная продукция</span><span>✓ Гарантия</span><span>✓ Быстрая связь с менеджером</span>
        </div>
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
          <div class="field">
            <label for="rv-photos">Фото (по желанию)</label>
            <input type="file" id="rv-photos" name="photos" accept="image/*" multiple>
          </div>
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
  const body = `<div class="container checkout-page" id="checkout-page">
    <header class="checkout-head">
      <h1 class="checkout-title">Оформление заказа</h1>
      <p class="checkout-sub">Проверьте состав заказа и оставьте контакт — менеджер свяжется с вами и подтвердит наличие</p>
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
  esc, money, formatDate, stars, layout, homePage, notFoundPage, productPage, checkoutPage, privacyPage,
  personalDataConsentPage, publicationConsentPage, imageMarkup, placeholderSvg,
  assetV, brandFields, cssColor, sellable, colorAvailable, defaultOption, accessibleFields, PRIVACY_VERSION,
  reviewsSlice, reviewCard, reviewsPager, reviewsRangeText, REVIEWS_PER_PAGE,
  reviewsPageNumbers, adminSlice, adminPager, ADMIN_PER_PAGE
};
