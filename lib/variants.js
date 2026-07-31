'use strict';
// Разбор варианта позиции корзины: какой ремешок выбран и существует ли вообще
// названный вариант. Логика общая для /api/cart и /api/order — как в lib/deals.js
// с ценой: корзина и заказ обязаны понимать позицию одинаково.

// Найти выбранный ремешок по строке «Коллекция · Цвет» из корзины.
function findBand(view, bandStr) {
  const want = String(bandStr == null ? '' : bandStr).trim();
  if (!want) return null;
  for (const g of (view && view.bands) || []) {
    for (const o of g.options || []) {
      if (g.name + ' · ' + o.name === want) return { group: g, option: o };
    }
  }
  return null;
}

// Корзина назвала вариант, которого в товаре больше нет: цвет переименовали,
// конфигурацию убрали, коллекцию ремешков заменили. Молча продать «просто товар»
// нельзя — покупатель выбирал 1 ТБ и титановый миланский, а в заявку ушла бы
// базовая сборка по базовой цене. Такую позицию считаем недоступной.
//
// Пустое поле — не ошибка: позиции, добавленные до появления ремешков, хранят
// пустую строку, и раньше они читались без вариантов вообще.
function variantMissing(view, item) {
  const want = (value) => String(value == null ? '' : value).trim();
  const storage = want(item && item.storage);
  if (storage && !((view && view.storages) || []).some(x => x.label === storage)) return true;
  const color = want(item && item.color);
  if (color && !((view && view.colors) || []).some(x => x.name === color)) return true;
  const band = want(item && item.band);
  if (band && !findBand(view, band)) return true;
  return false;
}

module.exports = { findBand, variantMissing };
