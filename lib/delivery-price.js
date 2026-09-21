'use strict';
/* ========================= Оценка стоимости доставки магазина =========================
 * Это настроенная в коде сетка магазина, а не текущая котировка перевозчика.
 * Внешних запросов к СДЭК или OZON здесь нет. Оценка предполагает одну посылку
 * около 2 кг, 30×20×15 см, с отправкой из Москвы. Фактические вес и габариты
 * товаров этот модуль не получает; для них требуется отдельный расчёт.
 *
 * Цена зависит от перевозчика, варианта доставки и зоны. Стоимость товаров и
 * предел оплаты кассы её не меняют: подгонка доставки под круглую сумму заказа
 * стирала разницу между перевозчиками и могла занижать исходную оценку.
 * Значения сетки — коммерческое решение магазина; автоматически актуальными
 * тарифами перевозчиков они не становятся.
 */

const Z = require('./delivery-zones');
const DELIVERY = require('./delivery');

// [способ][вариант][зона] — оценка в рублях за принятую выше посылку.
const RATES = {
  cdek: {
    pvz: { msk: 300, cfo: 370, szfo: 420, pfo: 520, yug: 550, ural: 620, sfo: 740, dfo: 1010, ru: 650 },
    courier: { msk: 520, cfo: 640, szfo: 670, pfo: 790, yug: 840, ural: 940, sfo: 1090, dfo: 1420, ru: 960 }
  },
  ozon: {
    pvz: { msk: 220, cfo: 290, szfo: 340, pfo: 380, yug: 420, ural: 480, sfo: 560, dfo: 790, ru: 500 },
    courier: { msk: 430, cfo: 500, szfo: 550, pfo: 600, yug: 650, ural: 710, sfo: 790, dfo: 1080, ru: 740 }
  }
};

// Неизвестный способ, вариант или зона не получают выдуманную цену.
function rate(method, mode, zoneId) {
  const byMode = RATES[String(method || '')];
  const byZone = byMode && byMode[String(mode || '')];
  const price = byZone && byZone[String(zoneId || '')];
  return Number.isFinite(price) ? price : 0;
}

// /api/order берёт тот же расчёт, что предварительный просмотр всех вариантов.
// Пустой выбор товаров не является заказом и не получает цену доставки.
function quote(method, mode, address, goods) {
  const all = quoteAll(address, goods);
  const byMode = all.prices && all.prices[String(method == null ? '' : method)];
  const price = byMode ? byMode[String(mode == null ? '' : mode)] : undefined;
  const amount = Number(goods);
  const sum = Number.isFinite(amount) && amount > 0 ? amount : 0;
  const ok = typeof price === 'number' && price > 0;
  return {
    ok,
    zone: all.zone,
    zoneName: all.zoneName,
    base: rate(method, mode, all.zone),
    price: ok ? price : 0,
    total: sum + (ok ? price : 0)
  };
}

// Сумма нужна только для проверки, что товары выбраны. Даже дополнительный
// аргумент прежнего вызывающего кода (потолок кассы) больше не меняет тариф.
function quoteAll(address, goods) {
  const zoneId = Z.zoneFor(address);
  const amount = Number(goods);
  if (!Number.isFinite(amount) || amount <= 0) {
    return { zone: zoneId, zoneName: Z.zoneName(zoneId), prices: null };
  }
  const prices = {};
  for (const method of DELIVERY.METHODS) {
    prices[method.id] = {};
    for (const mode of method.modes) {
      prices[method.id][mode.id] = rate(method.id, mode.id, zoneId);
    }
  }
  return { zone: zoneId, zoneName: Z.zoneName(zoneId), prices };
}

module.exports = { RATES, rate, quote, quoteAll };
