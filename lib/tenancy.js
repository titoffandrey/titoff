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
function viewFor(product, site) {
  const ov = override(site, product.id);
  const m = mult(site);
  const manual = hasPrice(ov);
  const v = {
    id: product.id, name: product.name, category: product.category,
    description: product.description, specs: product.specs, images: product.images,
    shortDesc: product.shortDesc, badge: product.badge, inStock: product.inStock,
    price: manual ? round(ov.price) : round(product.price * m),
    oldPrice: product.oldPrice ? round(product.oldPrice * m) : null,
    // если цена задана вручную — скидку не применяем (чтобы не путать), иначе масштабируем
    hotDeal: manual ? false : !!product.hotDeal,
    hotDealPrice: (manual || !product.hotDealPrice) ? null : round(product.hotDealPrice * m),
    hotDealUntil: product.hotDealUntil || null
  };
  v._rating = siteRating(product.id, site);
  return v;
}

function siteProductViews(site) {
  return db.getProducts().filter(p => isEnabled(p, site)).map(p => viewFor(p, site));
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
  for (const v of siteProductViews(site)) if (!set.includes(v.category)) set.push(v.category);
  return set;
}

module.exports = {
  resolveSite, siteSettings, viewFor, sitePriceOf, isEnabled,
  siteProductViews, siteProductView, siteReviews, siteRating, siteCategories
};
