'use strict';
// Логика «горящих скидок»: активна ли акция, эффективная цена продажи, зачёркнутая цена, процент скидки.
// Используется и на витрине (отображение), и на сервере (пересчёт заказа) — цена всегда считается одинаково.

function dealActive(p, now) {
  now = now || Date.now();
  if (!p || !p.hotDeal) return false;
  if (p.hotDealUntil && Number(p.hotDealUntil) <= now) return false; // срок вышел
  return true;
}

// Цена, по которой товар реально продаётся сейчас.
function effectivePrice(p) {
  if (dealActive(p) && Number(p.hotDealPrice) > 0) return Number(p.hotDealPrice);
  return Number(p.price) || 0;
}

// Зачёркнутая (старая) цена для показа рядом. null — если показывать нечего.
function comparePrice(p) {
  const eff = effectivePrice(p);
  if (dealActive(p) && Number(p.hotDealPrice) > 0 && Number(p.hotDealPrice) < Number(p.price)) return Number(p.price);
  if (p.oldPrice && Number(p.oldPrice) > eff) return Number(p.oldPrice);
  return null;
}

function discountPct(p) {
  const cmp = comparePrice(p), eff = effectivePrice(p);
  if (!cmp || cmp <= eff) return 0;
  return Math.round((1 - eff / cmp) * 100);
}

module.exports = { dealActive, effectivePrice, comparePrice, discountPct };
