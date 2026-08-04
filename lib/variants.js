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

// Дополнительные характеристики товара: «Покрытие дисплея», «Связь», «Комплект».
// У каждой группы свой обязательный выбор со своей доплатой — как у Apple на
// buy-ipad. Корзина присылает их парами {name, value}; здесь пары сопоставляются
// с группами товара в порядке самого товара, а не корзины.
function findOptions(view, item) {
  const groups = (view && view.options) || [];
  const picked = (Array.isArray(item && item.options) ? item.options : []).slice(0, 40);
  return groups.map(group => {
    const hit = picked.find(x => x && String(x.name == null ? '' : x.name).trim() === group.name);
    const label = hit ? String(hit.value == null ? '' : hit.value).trim() : '';
    return { group, label, value: label ? ((group.values || []).find(v => v.label === label) || null) : null };
  });
}
// Сумма доплат за выбранные значения — считается одинаково в корзине и в заказе.
function optionsAdd(chosen) {
  return (chosen || []).reduce((sum, c) => sum + (c.value ? Number(c.value.add) || 0 : 0), 0);
}
// Значение может продаваться не со всеми конфигурациями: нанотекстурное стекло
// у iPad Pro бывает только от 1 ТБ. Пустой список — совместимо со всем.
function optionFits(value, storage) {
  const only = (value && value.forStorage) || [];
  return !only.length || only.includes(String(storage == null ? '' : storage).trim());
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
  // Дополнительные характеристики проверяем так же строго: каждая группа товара
  // обязана быть выбрана, а названная корзиной группа — существовать. Иначе
  // позиция «iPad Pro» из старой корзины ушла бы в заявку без покрытия и связи,
  // то есть по цене базовой сборки.
  const options = (view && view.options) || [];
  const picked = (Array.isArray(item && item.options) ? item.options : []).slice(0, 40);
  for (const x of picked) {
    const name = String((x && x.name) == null ? '' : x.name).trim();
    if (!name || !options.some(g => g.name === name)) return true;
  }
  for (const chosen of findOptions(view, item)) if (!chosen.label || !chosen.value) return true;
  return false;
}

module.exports = { findBand, variantMissing, findOptions, optionsAdd, optionFits };
