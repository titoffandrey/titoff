'use strict';
const R = require('./render');
// Календарные интервалы магазина — по Москве, как и фильтр периода.
function salesSeries(orders, period, now = Date.now()) {
  const current = new Date(now + 3 * 3600000);
  const monthly = !period || period > 90;
  const firstDay = new Date(Date.UTC(current.getUTCFullYear(), current.getUTCMonth(), current.getUTCDate() - Math.max(0, period - 1)));
  const count = monthly ? (period ? (current.getUTCFullYear() - firstDay.getUTCFullYear()) * 12 + current.getUTCMonth() - firstDay.getUTCMonth() + 1 : 12) : Math.max(1, period || 30);
  const buckets = new Map();
  for (let i = count - 1; i >= 0; i--) {
    const date = monthly
      ? new Date(Date.UTC(current.getUTCFullYear(), current.getUTCMonth() - i, 1))
      : new Date(Date.UTC(current.getUTCFullYear(), current.getUTCMonth(), current.getUTCDate() - i));
    const key = date.toISOString().slice(0, monthly ? 7 : 10);
    buckets.set(key, { label: date.toLocaleDateString('ru-RU', monthly ? { month: 'short', timeZone: 'UTC' } : { day: 'numeric', month: 'short', timeZone: 'UTC' }), total: 0, revenue: 0, count: 0 });
  }
  for (const order of orders || []) {
    const at = Number(order.createdAt);
    if (!Number.isFinite(at) || at > now) continue;
    const date = new Date(at + 3 * 3600000);
    if (Number.isNaN(date.valueOf())) continue;
    const bucket = buckets.get(date.toISOString().slice(0, monthly ? 7 : 10));
    if (!bucket) continue;
    const total = Number(order.total) || 0;
    bucket.count++;
    bucket.total += total;
    if (R.orderTone(order, now) === 'ok') bucket.revenue += total;
  }
  const list = [...buckets.values()];
  return { labels: list.map(b => b.label), total: list.map(b => b.total), revenue: list.map(b => b.revenue), count: list.map(b => b.count), monthly };
}
module.exports = { salesSeries };
