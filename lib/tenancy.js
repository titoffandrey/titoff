'use strict';
// Мультитенант: логика «какой сайт по домену» и «как выглядит товар/цена/отзывы на этом сайте».
// Каталог и отзывы общие (мастер), а цены/видимость/бренд берутся из настроек конкретного сайта.
const db = require('./db');

function round(n) { return Math.round(Number(n) || 0); }
function mult(site) { const m = Number(site.priceMultiplier); return m > 0 ? m : 1; }

// Разрешить сайт по хосту. ?site=<id> — для локальной проверки без реальных доменов.
// Всегда возвращает объект сайта (неизвестный домен -> первый сайт; нет сайтов -> дефолт из общих настроек).
function resolveSite(host, siteQuery) {
  if (siteQuery) { const s = db.getSite(siteQuery); if (s) return s; }
  const byHost = db.getSiteByHost(host);
  if (byHost) return byHost;
  const all = db.getSites();
  return all.length ? all[0] : db.defaultSite();
}

// Объект в форме settings — витрина рендерится им (бренд/валюта/контакты сайта).
function siteSettings(site) {
  return {
    storeName: site.storeName, tagline: site.tagline, accentColor: site.accentColor,
    currency: site.currency, currencyPosition: site.currencyPosition,
    contactTelegram: site.contactTelegram, contactPhone: site.contactPhone, footerNote: site.footerNote,
    legalOperator: site.legalOperator || '', legalDetails: site.legalDetails || '',
    legalAddress: site.legalAddress || '', privacyEmail: site.privacyEmail || '',
    telegramBotToken: site.telegramBotToken, telegramChatId: site.telegramChatId, notifyReviews: site.notifyReviews,
    logoImage: site.logoImage || null, logoText: site.logoText || '', logoFont: site.logoFont || 'system', secondaryColor: site.secondaryColor || ''
  };
}

function override(site, id) { return (site.overrides || {})[id] || {}; }
function hasPrice(ov) { return ov.price != null && ov.price !== ''; }

function isEnabled(product, site) {
  const ov = override(site, product.id);
  return ov.enabled !== false; // по умолчанию товар виден
}

// Цена товара на сайте: ручной оверрайд или базовая × множитель.
function sitePriceOf(product, site) {
  const ov = override(site, product.id);
  return hasPrice(ov) ? round(ov.price) : round(product.price * mult(site));
}

// Представление товара для сайта: те же поля, но цена и скидка пересчитаны.
function viewFor(product, site, rating) {
  const ov = override(site, product.id);
  const m = mult(site);
  const manual = hasPrice(ov);
  const v = {
    id: product.id, name: product.name, category: product.category,
    description: product.description, specs: product.specs, images: product.images,
    shortDesc: product.shortDesc, badge: product.badge, inStock: product.inStock,
    imageColors: product.imageColors || {},
    colors: product.colors || [],
    storages: (product.storages || []).map(s => ({ label: s.label, add: round(Number(s.add || 0) * m) })),
    price: manual ? round(ov.price) : round(product.price * m),
    oldPrice: product.oldPrice ? round(product.oldPrice * m) : null,
    // если цена задана вручную — скидку не применяем (чтобы не путать), иначе масштабируем
    hotDeal: manual ? false : !!product.hotDeal,
    hotDealPrice: (manual || !product.hotDealPrice) ? null : round(product.hotDealPrice * m),
    hotDealUntil: product.hotDealUntil || null
  };
  v._rating = rating || siteRating(product.id, site);
  return v;
}

function siteProductViews(site) {
  // На каталоге считаем все рейтинги одним проходом по отзывам. Раньше каждый
  // товар заново фильтровал весь массив отзывов (O(товары × отзывы)).
  const hidden = new Set(site.hiddenReviews || []);
  const sums = new Map();
  for (const review of db.getReviews()) {
    if (review.status !== 'approved' || hidden.has(review.id)) continue;
    const cur = sums.get(review.productId) || { sum: 0, count: 0 };
    cur.sum += Number(review.rating) || 0; cur.count++;
    sums.set(review.productId, cur);
  }
  return db.getProducts().filter(p => isEnabled(p, site)).map(p => {
    const r = sums.get(p.id);
    const rating = r ? { avg: Math.round((r.sum / r.count) * 10) / 10, count: r.count } : { avg: 0, count: 0 };
    return viewFor(p, site, rating);
  });
}
function siteProductView(site, productId) {
  const p = db.getProduct(productId);
  if (!p || !isEnabled(p, site)) return null;
  return viewFor(p, site);
}

// Отзывы товара, видимые на сайте (одобренные минус скрытые этим сайтом).
function siteReviews(site, productId) {
  const hidden = site.hiddenReviews || [];
  return db.reviewsForProduct(productId, true).filter(r => !hidden.includes(r.id));
}
function siteRating(productId, site) {
  const list = siteReviews(site, productId);
  if (!list.length) return { avg: 0, count: 0 };
  const sum = list.reduce((a, r) => a + Number(r.rating || 0), 0);
  return { avg: Math.round((sum / list.length) * 10) / 10, count: list.length };
}

function siteCategories(site) {
  const set = [];
  for (const product of db.getProducts()) {
    if (isEnabled(product, site) && !set.includes(product.category)) set.push(product.category);
  }
  return set;
}

module.exports = {
  resolveSite, siteSettings, viewFor, sitePriceOf, isEnabled,
  siteProductViews, siteProductView, siteReviews, siteRating, siteCategories
};
