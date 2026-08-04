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
function hasPrice(ov) {
  const price = Number(ov && ov.price);
  return ov && ov.price !== '' && ov.price != null && Number.isFinite(price) && price > 0 && price <= 1e12;
}

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
    storages: (product.storages || []).map(s => ({ label: s.label, add: round(Number(s.add || 0) * m), inStock: s.inStock !== false })),
    // доплата за ремешок масштабируется множителем сайта так же, как за память
    bands: (product.bands || []).map(g => ({
      name: g.name,
      sizes: (g.sizes || []).map(x => ({ label: x.label, add: round(Number(x.add || 0) * m) })),
      options: (g.options || []).map(o => ({ name: o.name, hex: o.hex, add: round(Number(o.add || 0) * m), inStock: o.inStock !== false, forColor: o.forColor || '' }))
    })),
    imageBands: product.imageBands || {},
    // Дополнительные характеристики (покрытие экрана, связь, комплект): доплата
    // масштабируется множителем сайта так же, как за память и за ремешок.
    options: (product.options || []).map(g => ({
      name: g.name, hint: g.hint || '',
      values: (g.values || []).map(v => ({
        label: v.label, add: round(Number(v.add || 0) * m), inStock: v.inStock !== false,
        forStorage: Array.isArray(v.forStorage) ? v.forStorage.slice() : []
      }))
    })),
    price: manual ? round(ov.price) : round(product.price * m),
    oldPrice: product.oldPrice ? round(product.oldPrice * m) : null,
    // если цена задана вручную — скидку не применяем (чтобы не путать), иначе масштабируем
    hotDeal: manual ? false : !!product.hotDeal,
    hotDealPrice: (manual || !product.hotDealPrice) ? null : round(product.hotDealPrice * m),
    hotDealUntil: product.hotDealUntil || null
  };
  // Оценка считается только когда её действительно спросят. /api/cart и /api/order
  // строят до 100 представлений на запрос и рейтинг не показывают вовсе — раньше
  // на каждое из них впустую пробегался список отзывов товара (до 300 записей).
  if (rating) v._rating = rating;
  else Object.defineProperty(v, '_rating', {
    configurable: true, enumerable: false,
    get() {
      const value = siteRating(product.id, site);
      Object.defineProperty(v, '_rating', { value, configurable: true, enumerable: false, writable: true });
      return value;
    }
  });
  return v;
}

// Суммы оценок по товарам с поправкой на отзывы, скрытые этим сайтом.
// Готовые суммы приходят из индекса db (считаются один раз на версию файла),
// а скрытые вычитаются поштучно — их единицы, полный проход по всем отзывам
// ради этого не нужен.
function siteTotals(site) {
  const totals = db.approvedTotals();
  const hidden = site.hiddenReviews || [];
  if (!hidden.length) return totals;
  const hiddenSet = new Set(hidden);
  const adjusted = new Map(totals);
  for (const review of db.getReviews()) {
    if (review.status !== 'approved' || !hiddenSet.has(review.id)) continue;
    const cur = adjusted.get(review.productId);
    if (!cur) continue;
    adjusted.set(review.productId, { sum: cur.sum - (Number(review.rating) || 0), count: cur.count - 1 });
  }
  return adjusted;
}

function siteProductViews(site) {
  const totals = siteTotals(site);
  return db.getProducts().filter(p => isEnabled(p, site)).map(p => {
    const t = totals.get(p.id);
    return viewFor(p, site, t ? db.averageRating(t.sum, t.count) : { avg: 0, count: 0 });
  });
}
function siteProductView(site, productId) {
  const p = db.getProduct(productId);
  if (!p || !isEnabled(p, site)) return null;
  return viewFor(p, site);
}

// Отзывы товара, видимые на сайте (одобренные минус скрытые этим сайтом).
// Сайт без скрытых отзывов получает массив из индекса как есть — лишней копии нет.
function siteReviews(site, productId) {
  const approved = db.reviewsForProduct(productId, true);
  const hidden = site.hiddenReviews || [];
  if (!hidden.length) return approved;
  const hiddenSet = new Set(hidden);
  return approved.filter(r => !hiddenSet.has(r.id));
}
function siteRating(productId, site) {
  const list = siteReviews(site, productId);
  if (!list.length) return { avg: 0, count: 0 };
  const sum = list.reduce((a, r) => a + Number(r.rating || 0), 0);
  return db.averageRating(sum, list.length);
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
