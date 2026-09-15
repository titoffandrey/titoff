/* Комиссия платёжного сервиса: один расчёт для оформления и сервера.
 * Все промежуточные суммы — целые копейки, процент — сотые доли процента. */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.PaymentFee = api;
})(typeof window !== 'undefined' ? window : null, function () {
  'use strict';

  function hundredths(value) {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return null;
    var parts = String(value).match(/^(\d+)(?:\.(\d{1,2}))?$/);
    if (!parts) return null;
    var minor = Number(parts[1]) * 100 + Number((parts[2] || '').padEnd(2, '0'));
    return Number.isSafeInteger(minor) ? minor : null;
  }

  function quote(baseAmount, percent) {
    var base = hundredths(baseAmount);
    var rate = hundredths(percent);
    if (base === null || rate === null || rate > 10000) return null;
    var product = base * rate;
    if (!Number.isSafeInteger(product)) return null;
    // Половина копейки округляется вверх; двоичная дробь здесь не участвует.
    var fee = Math.floor(product / 10000) + (product % 10000 >= 5000 ? 1 : 0);
    if (!Number.isSafeInteger(base + fee)) return null;
    return { baseAmount: base / 100, amount: fee / 100, percent: rate / 100, total: (base + fee) / 100 };
  }

  return { quote: quote };
});
