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
// Пустое поле допустимо только когда у товара такого типа вариантов нет. Старую
// позицию без выбора нельзя молча оформить по базовой цене: /api/cart пометит её
// недоступной, а покупатель заново выберет актуальную конфигурацию.
function variantMissing(view, item) {
  const want = (value) => String(value == null ? '' : value).trim();
  const storages = (view && view.storages) || [];
  const colors = (view && view.colors) || [];
  const bands = (view && view.bands) || [];
  const storage = want(item && item.storage);
  if (storages.length && !storage) return true;
  if (storage && !storages.some(x => x.label === storage)) return true;
  const color = want(item && item.color);
  if (colors.length && !color) return true;
  if (color && !colors.some(x => x.name === color)) return true;
  const band = want(item && item.band);
  if (bands.length && !band) return true;
  const foundBand = band ? findBand(view, band) : null;
  if (band && !foundBand) return true;
  // Названный размер ремешка проверяем так же строго, как память, цвет и сам
  // ремешок. Иначе удалённый «M/L» молча исчезал из заявки и не влиял на цену.
  const bandSize = want(item && item.bandSize);
  if (foundBand && (foundBand.group.sizes || []).length && !bandSize) return true;
  if (bandSize && (!foundBand || !(foundBand.group.sizes || []).some(x => x.label === bandSize))) return true;
  return false;
}

module.exports = { findBand, variantMissing };
