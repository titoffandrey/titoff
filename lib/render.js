'use strict';
// Рендер витрины (сервер-сайд, обычные шаблонные строки — без движков и лишних зависимостей).
const fs = require('fs');
const path = require('path');
const D = require('./deals');
const T = require('./tenancy');

// Версия статического файла по времени изменения — добавляется к ссылке (?v=...),
// чтобы браузер всегда подхватывал свежие стили/скрипты и не показывал старый кэш.
function assetV(file) {
  try { return Math.round(fs.statSync(path.join(__dirname, '..', 'public', file)).mtimeMs).toString(36); }
  catch (e) { return '1'; }
}

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function money(n, settings) {
  const val = Number(n || 0).toLocaleString('ru-RU');
  const cur = (settings && settings.currency) || '₽';
  return (settings && settings.currencyPosition === 'before') ? `${cur}${val}` : `${val} ${cur}`;
}

function formatDate(ms) {
  const d = new Date(ms);
  return d.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric' });
}

// Звёзды рейтинга: серый фон + золотой слой, обрезанный по проценту.
function stars(rating) {
  const pct = Math.max(0, Math.min(100, (Number(rating || 0) / 5) * 100));
  return `<span class="stars" role="img" aria-label="${rating} из 5">`
    + `<span class="stars-bg">★★★★★</span>`
    + `<span class="stars-fg" style="width:${pct}%">★★★★★</span>`
    + `</span>`;
}

// Иконки-плейсхолдеры по категории (когда у товара нет загруженных фото).
function glyph(category) {
  const c = String(category || '').toLowerCase();
  const g = {
    phone: '<rect x="150" y="70" width="100" height="180" rx="18" fill="none" stroke="#fff" stroke-width="7"/><line x1="180" y1="222" x2="220" y2="222" stroke="#fff" stroke-width="7" stroke-linecap="round"/>',
    laptop: '<rect x="128" y="95" width="144" height="92" rx="8" fill="none" stroke="#fff" stroke-width="7"/><path d="M108 205 h184 l14 22 H94 Z" fill="none" stroke="#fff" stroke-width="7" stroke-linejoin="round"/>',
    tablet: '<rect x="132" y="80" width="136" height="160" rx="14" fill="none" stroke="#fff" stroke-width="7"/><circle cx="200" cy="222" r="5" fill="#fff"/>',
    watch: '<rect x="158" y="120" width="84" height="90" rx="22" fill="none" stroke="#fff" stroke-width="7"/><path d="M172 120 l8 -38 h40 l8 38 M172 210 l8 38 h40 l8 -38" fill="none" stroke="#fff" stroke-width="7" stroke-linejoin="round"/>',
    earbuds: '<path d="M170 110 c-26 0 -34 30 -30 60 c4 26 26 30 30 6 c3 -20 -2 -40 0 -66 Z" fill="none" stroke="#fff" stroke-width="7"/><path d="M230 110 c26 0 34 30 30 60 c-4 26 -26 30 -30 6 c-3 -20 2 -40 0 -66 Z" fill="none" stroke="#fff" stroke-width="7"/>',
    generic: '<path d="M200 96 c30 0 52 22 52 58 c0 44 -34 92 -52 92 c-18 0 -52 -48 -52 -92 c0 -36 22 -58 52 -58 Z" fill="none" stroke="#fff" stroke-width="7"/><path d="M200 96 c0 -18 14 -30 30 -30" fill="none" stroke="#fff" stroke-width="7" stroke-linecap="round"/>'
  };
  let key = 'generic';
  if (/(iphone|phone|телефон)/.test(c)) key = 'phone';
  else if (/(mac|book|ноут|laptop)/.test(c)) key = 'laptop';
  else if (/(ipad|tablet|планшет)/.test(c)) key = 'tablet';
  else if (/(watch|часы)/.test(c)) key = 'watch';
  else if (/(airpod|pod|наушник|buds)/.test(c)) key = 'earbuds';
  return g[key];
}

function placeholderSvg(product) {
  return `<svg class="ph" viewBox="0 0 400 320" xmlns="http://www.w3.org/2000/svg" preserveAspectRatio="xMidYMid meet" aria-hidden="true">`
    + `<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">`
    + `<stop offset="0" stop-color="#eef1f6"/><stop offset="1" stop-color="#dfe4ec"/></linearGradient></defs>`
    + `<rect width="400" height="320" fill="url(#g)"/>`
    + `<g opacity="0.55" stroke-linecap="round">${glyph(product.category)}</g>`
    + `</svg>`;
}

// Разметка изображения товара: загруженное фото или SVG-плейсхолдер.
function imageMarkup(product, index) {
  const imgs = product.images || [];
  if (imgs.length) {
    const src = imgs[index || 0];
    return `<img src="/uploads/${esc(src)}" alt="${esc(product.name)}" loading="lazy">`;
  }
  return placeholderSvg(product);
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

// Текстовый логотип: буквы в {фигурных скобках} красятся вторичным/акцентным цветом.
function logoTextMarkup(text) {
  return esc(text).replace(/\{([^}]*)\}/g, '<span class="logo-accent">$1</span>');
}
function logoMarkup(settings) {
  if (settings.logoImage) return `<img class="logo-img" src="/uploads/${esc(settings.logoImage)}" alt="${esc(settings.storeName)}">`;
  if (settings.logoText && settings.logoText.trim()) return `<span class="logo-txt">${logoTextMarkup(settings.logoText)}</span>`;
  return `<span class="logo-txt">${esc(settings.storeName)}</span>`;
}

function currencyCode(sym) {
  return ({ '₽': 'RUB', '$': 'USD', '€': 'EUR', '£': 'GBP', '₴': 'UAH', '₸': 'KZT' })[sym] || 'RUB';
}
function jsonLd(obj) { return JSON.stringify(obj).replace(/</g, '\\u003c'); } // безопасно для <script>

// SEO-блок в <head>: описание, canonical, Open Graph, Twitter, JSON-LD.
function seoHead(settings, opts) {
  const origin = opts.origin || '';
  const canonical = origin + (opts.canonicalPath || '/');
  const desc = (opts.description || settings.tagline || settings.storeName || '').slice(0, 300);
  const ogTitle = opts.title ? opts.title + ' — ' + settings.storeName : settings.storeName;
  const ogImage = opts.ogImage ? (/^https?:/.test(opts.ogImage) ? opts.ogImage : origin + opts.ogImage) : '';
  return `<meta name="description" content="${esc(desc)}">`
    + `<meta name="robots" content="index,follow">`
    + (origin ? `<link rel="canonical" href="${esc(canonical)}">` : '')
    + `<meta property="og:site_name" content="${esc(settings.storeName)}"><meta property="og:locale" content="ru_RU">`
    + `<meta property="og:type" content="${esc(opts.ogType || 'website')}"><meta property="og:title" content="${esc(ogTitle)}">`
    + `<meta property="og:description" content="${esc(desc)}">`
    + (origin ? `<meta property="og:url" content="${esc(canonical)}">` : '')
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
      <div class="field"><label>Вторичный цвет (для выделенных букв)</label><input name="secondaryColor" type="color" value="${esc(s.secondaryColor || s.accentColor || '#0071e3')}"></div>
    </div>
    <div class="field"><label>Цветной текст логотипа</label><input name="logoText" value="${esc(s.logoText || '')}" placeholder="например: {i}Store"><p class="muted small">Пусто — берётся название магазина. Буквы в фигурных скобках <b>{ }</b> красятся вторичным цветом. Пример: <b>{i}Store</b> → «i» цветное.</p></div>
    ${cur}
    <div class="field"><label>Логотип-картинка (необязательно, заменяет текст)</label><input type="file" name="logo" accept="image/*"><p class="muted small">Фото автоматически чистится от метаданных и сжимается в WebP.</p></div>
  </div>`;
}

function productCard(p, settings, db) {
  const r = p._rating || db.ratingFor(p.id);
  const hot = D.dealActive(p);
  const eff = D.effectivePrice(p);
  const cmp = D.comparePrice(p);
  const pct = D.discountPct(p);
  const compareHtml = cmp ? `<span class="old-price">${money(cmp, settings)}</span>` : '';
  const badge = hot
    ? `<span class="badge badge-hot">🔥 −${pct}%</span>`
    : (p.badge ? `<span class="badge">${esc(p.badge)}</span>`
      : (!p.inStock ? `<span class="badge badge-muted">Нет в наличии</span>` : ''));
  const ratingLine = r.count
    ? `<div class="card-rating">${stars(r.avg)}<span class="rating-count">${r.count}</span></div>`
    : `<div class="card-rating card-rating-empty">Пока нет отзывов</div>`;
  const timer = (hot && p.hotDealUntil)
    ? `<div class="deal-timer" data-deal-until="${p.hotDealUntil}"><span class="dt-ico">⏳</span><span class="dt-val">—</span></div>` : '';
  return `
  <a class="card${hot ? ' card-hot' : ''}" href="/product/${p.id}">
    <div class="card-media">${badge}${imageMarkup(p)}</div>
    <div class="card-body">
      <div class="card-cat">${esc(p.category)}</div>
      <div class="card-name">${esc(p.name)}</div>
      ${ratingLine}
      <div class="card-price${hot ? ' price-hot' : ''}">${money(eff, settings)} ${compareHtml}</div>
      ${timer}
    </div>
    <div class="card-add">
      <button type="button" class="btn btn-primary btn-block add-to-cart"
        data-id="${p.id}" data-name="${esc(p.name)}" data-price="${eff}"
        ${p.inStock ? '' : 'disabled'}>${p.inStock ? 'В корзину' : 'Нет в наличии'}</button>
    </div>
  </a>`;
}

function layout(settings, opts) {
  opts = opts || {};
  const accent = settings.accentColor || '#0071e3';
  const cats = opts.categories || [];
  const navCats = cats.map(c =>
    `<a href="/?category=${encodeURIComponent(c)}" class="nav-cat${opts.activeCategory === c ? ' active' : ''}">${esc(c)}</a>`
  ).join('');
  return `<!DOCTYPE html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${esc(opts.title ? opts.title + ' — ' + settings.storeName : settings.storeName)}</title>
${seoHead(settings, opts)}
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'%3E%3Ctext y='.9em' font-size='90'%3E%F0%9F%9B%8D%EF%B8%8F%3C/text%3E%3C/svg%3E">
<link rel="stylesheet" href="/static/styles.css?v=${assetV('styles.css')}">
<style>:root{--accent:${esc(accent)};--secondary:${esc(settings.secondaryColor || accent)};--brand-font:${brandFont(settings)}}</style>
</head>
<body>
<header class="site-header">
  <div class="container header-row">
    <button class="icon-btn menu-toggle" aria-label="Меню" onclick="document.body.classList.toggle('nav-open')">
      <svg viewBox="0 0 24 24" width="24" height="24"><path d="M3 6h18M3 12h18M3 18h18" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round"/></svg>
    </button>
    <a class="logo" href="/">${logoMarkup(settings)}</a>
    <form class="search" action="/" method="get" role="search">
      <input type="search" name="q" placeholder="Поиск товаров" value="${esc(opts.q || '')}" aria-label="Поиск">
    </form>
    <button class="icon-btn cart-btn" aria-label="Корзина" onclick="Cart.open()">
      <svg viewBox="0 0 24 24" width="24" height="24"><path d="M6 6h15l-1.5 9h-12z M6 6l-1-3H2 M9 20a1 1 0 100 2 1 1 0 000-2 M18 20a1 1 0 100 2 1 1 0 000-2" stroke="currentColor" stroke-width="1.8" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>
      <span class="cart-badge" id="cart-badge" hidden>0</span>
    </button>
  </div>
  ${cats.length ? `<nav class="site-nav"><div class="container nav-inner"><a href="/" class="nav-cat${!opts.activeCategory ? ' active' : ''}">Все</a>${navCats}</div></nav>` : ''}
</header>

<main>${opts.body || ''}</main>

<footer class="site-footer">
  <div class="container">
    <div class="foot-brand">${esc(settings.storeName)}</div>
    <div class="foot-note">${esc(settings.tagline || '')}</div>
    ${settings.contactTelegram ? `<div class="foot-contact">Telegram: <a href="https://t.me/${esc(String(settings.contactTelegram).replace(/^@/, ''))}">${esc(settings.contactTelegram)}</a></div>` : ''}
    ${settings.contactPhone ? `<div class="foot-contact">Тел: ${esc(settings.contactPhone)}</div>` : ''}
    ${settings.footerNote ? `<div class="foot-legal">${esc(settings.footerNote)}</div>` : ''}
    <div class="foot-legal"><a href="/admin">Вход для администратора</a></div>
  </div>
</footer>

<!-- Корзина -->
<div class="cart-overlay" id="cart-overlay" onclick="Cart.close()"></div>
<aside class="cart-drawer" id="cart-drawer" aria-label="Корзина">
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

<script>window.__CURRENCY__=${JSON.stringify(settings.currency || '₽')};window.__CURPOS__=${JSON.stringify(settings.currencyPosition || 'after')};</script>
<script src="/static/app.js?v=${assetV('app.js')}"></script>
</body>
</html>`;
}

/* --------------------------- Страницы витрины --------------------------- */

function homePage(settings, db, opts, site) {
  const all = site ? T.siteProductViews(site) : db.getProducts();
  let list = all;
  if (opts.category) list = list.filter(p => p.category === opts.category);
  if (opts.q) {
    const q = opts.q.toLowerCase();
    list = list.filter(p => (p.name + ' ' + p.category + ' ' + p.shortDesc).toLowerCase().includes(q));
  }
  const cards = list.map(p => productCard(p, settings, db)).join('');
  const heading = opts.q ? `Результаты: «${esc(opts.q)}»` : (opts.category || 'Каталог');
  const hero = (!opts.q && !opts.category) ? `
    <section class="hero">
      <div class="container">
        <h1>${esc(settings.storeName)}</h1>
        <p>${esc(settings.tagline || '')}</p>
      </div>
    </section>` : '';

  // Блок «Горящие скидки» — только на главной (без поиска/категории), если есть активные акции.
  const deals = (!opts.q && !opts.category) ? all.filter(p => D.dealActive(p)) : [];
  const dealsBand = deals.length ? `
    <section class="deals-band">
      <div class="container">
        <div class="deals-head">
          <h2 class="deals-title"><span class="flame">🔥</span> Горящие скидки</h2>
          <p class="deals-sub">Специальные цены на ограниченное время — успейте забрать</p>
        </div>
        <div class="grid">${deals.map(p => productCard(p, settings, db)).join('')}</div>
      </div>
    </section>` : '';

  const body = `
    ${hero}
    ${dealsBand}
    <section class="container section">
      <div class="section-head"><h2>${heading}</h2><span class="muted">${list.length} товаров</span></div>
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
    origin, canonicalPath: '/', description: settings.tagline, ogType: 'website', jsonLd: ld
  });
}

function productPage(settings, db, p, site, opts) {
  opts = opts || {};
  const r = p._rating || db.ratingFor(p.id);
  const reviews = site ? T.siteReviews(site, p.id) : db.reviewsForProduct(p.id, true);
  const imgs = (p.images && p.images.length) ? p.images : [null];
  const mainImg = imageMarkup(p, 0);
  const thumbs = imgs.length > 1 ? `<div class="thumbs">${imgs.map((s, i) =>
    `<button class="thumb${i === 0 ? ' active' : ''}" data-src="/uploads/${esc(s)}"><img src="/uploads/${esc(s)}" alt=""></button>`
  ).join('')}</div>` : '';
  const hot = D.dealActive(p);
  const eff = D.effectivePrice(p);
  const cmp = D.comparePrice(p);
  const pct = D.discountPct(p);
  const discount = cmp
    ? `<span class="old-price">${money(cmp, settings)}</span><span class="save">−${pct}%</span>` : '';
  const dealBanner = (hot && p.hotDealUntil)
    ? `<div class="deal-banner" data-deal-until="${p.hotDealUntil}"><span class="flame">🔥</span> Горящая скидка · до конца <b class="dt-val">—</b></div>` : '';

  // разбивка по звёздам и средние по аспектам
  const dist = [0, 0, 0, 0, 0];
  const asp = { delivery: [0, 0], service: [0, 0], price: [0, 0] };
  reviews.forEach(rv => {
    const st = Math.round(rv.rating); if (st >= 1 && st <= 5) dist[st - 1]++;
    if (rv.aspects) ['delivery', 'service', 'price'].forEach(k => { if (rv.aspects[k]) { asp[k][0] += Number(rv.aspects[k]); asp[k][1]++; } });
  });
  const aspAvg = k => asp[k][1] ? Math.round(asp[k][0] / asp[k][1] * 10) / 10 : null;
  const aspLabels = { delivery: 'Доставка', service: 'Сервис', price: 'Цена' };

  const reviewItems = reviews.length ? reviews.map(rv => {
    const chips = rv.aspects ? ['delivery', 'service', 'price'].filter(k => rv.aspects[k]).map(k => `<span class="asp-chip">${aspLabels[k]} ${rv.aspects[k]}</span>`).join('') : '';
    return `
    <article class="review" data-rating="${rv.rating}" data-ts="${rv.createdAt}" data-len="${(rv.text || '').length}">
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
  }).join('') : `<p class="muted">Отзывов пока нет. Оставьте первый!</p>`;

  const breakdown = r.count ? `
    <div class="rating-overview">
      <div class="rating-big"><div class="rating-num">${r.avg}</div>${stars(r.avg)}<div class="muted small">${r.count} отзывов</div></div>
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
    ? `<a href="#reviews" class="rating-summary">${stars(r.avg)}<b>${r.avg}</b><span class="muted">· ${r.count} отзывов</span></a>`
    : `<a href="#reviews" class="rating-summary muted">Нет отзывов</a>`;

  const body = `
  <div class="container">
    <nav class="breadcrumb"><a href="/">Главная</a> / <a href="/?category=${encodeURIComponent(p.category)}">${esc(p.category)}</a> / <span>${esc(p.name)}</span></nav>
    <div class="product">
      <div class="product-gallery">
        <div class="gallery-main" id="gallery-main">${mainImg}</div>
        ${thumbs}
      </div>
      <div class="product-info">
        <div class="product-cat">${esc(p.category)}</div>
        <h1 class="product-name">${esc(p.name)}</h1>
        ${ratingSummary}
        ${dealBanner}
        <div class="product-price${hot ? ' price-hot' : ''}"><span id="product-price">${money(eff, settings)}</span> ${discount}</div>
        ${p.shortDesc ? `<p class="product-short">${esc(p.shortDesc)}</p>` : ''}
        ${(p.colors && p.colors.length) ? `
        <div class="variant-group">
          <div class="variant-label">Цвет: <b id="sel-color">${esc(p.colors[0].name)}</b></div>
          <div class="swatches" id="colors">
            ${p.colors.map((c, i) => `<button type="button" class="swatch${i === 0 ? ' active' : ''}" data-color="${esc(c.name)}" title="${esc(c.name)}" style="--sw:${esc(c.hex || '#cccccc')}"></button>`).join('')}
          </div>
        </div>` : ''}
        ${(p.storages && p.storages.length) ? `
        <div class="variant-group">
          <div class="variant-label">Память</div>
          <div class="storage-opts" id="storages">
            ${p.storages.map((s, i) => `<button type="button" class="storage-opt${i === 0 ? ' active' : ''}" data-add="${Number(s.add) || 0}" data-label="${esc(s.label)}">${esc(s.label)}</button>`).join('')}
          </div>
        </div>` : ''}
        <div class="buy-row">
          <div class="qty" data-qty>
            <button type="button" class="qty-btn" data-delta="-1" aria-label="Меньше">−</button>
            <input type="text" value="1" inputmode="numeric" class="qty-input" readonly>
            <button type="button" class="qty-btn" data-delta="1" aria-label="Больше">+</button>
          </div>
          <button class="btn btn-primary btn-lg add-to-cart" data-id="${p.id}"
            data-base-name="${esc(p.name)}" data-name="${esc(p.name)}"
            data-base-price="${eff}" data-price="${eff}" data-qty-source ${p.inStock ? '' : 'disabled'}>
            ${p.inStock ? 'Добавить в корзину' : 'Нет в наличии'}
          </button>
        </div>
        <div class="trust">
          <span>✓ Оригинальная продукция</span><span>✓ Гарантия</span><span>✓ Быстрая связь с менеджером</span>
        </div>
      </div>
    </div>

    ${p.description ? `<section class="section"><h2>Описание</h2><div class="prose">${esc(p.description).replace(/\n/g, '<br>')}</div></section>` : ''}
    ${p.specs ? `<section class="section"><h2>Характеристики</h2><table class="specs">${
      p.specs.split('\n').filter(Boolean).map(line => {
        const idx = line.indexOf(':');
        if (idx > -1) return `<tr><td>${esc(line.slice(0, idx).trim())}</td><td>${esc(line.slice(idx + 1).trim())}</td></tr>`;
        return `<tr><td colspan="2">${esc(line.trim())}</td></tr>`;
      }).join('')
    }</table></section>` : ''}

    <section class="section" id="reviews">
      <div class="section-head"><h2>Отзывы ${r.count ? `(${r.count})` : ''}</h2></div>
      ${breakdown}
      ${r.count ? `<div class="reviews-toolbar"><span class="muted small">Сортировка:</span><button type="button" class="sort-btn active" data-sort="helpful">Сначала полезные</button><button type="button" class="sort-btn" data-sort="new">Сначала новые</button></div>` : ''}
      <div class="reviews-list" id="reviews-list">${reviewItems}</div>

      <div class="review-form-wrap">
        <h3>Оставить отзыв</h3>
        <form id="review-form" enctype="multipart/form-data">
          <input type="hidden" name="productId" value="${p.id}">
          <div class="field">
            <label>Общая оценка</label>
            <div class="rate-input" id="rate-input" data-value="5">
              ${[1,2,3,4,5].map(i => `<button type="button" class="rate-star" data-v="${i}">★</button>`).join('')}
            </div>
            <input type="hidden" name="rating" id="rating-value" value="5">
          </div>
          <div class="aspect-inputs">
            ${[['delivery', 'Доставка'], ['service', 'Обслуживание'], ['price', 'Цена/качество']].map(([k, l]) => `<div class="aspect-row"><span>${l}</span><div class="rate-input rate-sm" data-aspect="${k}" data-value="5">${[1, 2, 3, 4, 5].map(i => `<button type="button" class="rate-star" data-v="${i}">★</button>`).join('')}</div><input type="hidden" name="aspect_${k}" value="5"></div>`).join('')}
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
      availability: 'https://schema.org/' + (p.inStock ? 'InStock' : 'OutOfStock'), url: origin + '/product/' + p.id
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

module.exports = { esc, money, formatDate, stars, layout, homePage, productPage, imageMarkup, placeholderSvg, assetV, brandFields };
