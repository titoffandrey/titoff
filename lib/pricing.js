'use strict';
/* ==================== Цена одной позиции: корзина и заказ ====================
 *
 * `/api/cart` и `/api/order` отвечают на разные вопросы — «что показать в
 * корзине» и «что записать в заявку», — но ЦЕНУ обязаны считать одинаково, до
 * рубля. Считали они её двумя отдельными кусками кода по полсотни строк каждый:
 * оба разбирали конфигурацию, цвет, ремешок с размером и доп. характеристики,
 * оба перепроверяли наличие и совместимость, оба складывали доплаты и звали
 * промокод. Расхождение между ними было бы не опечаткой, а разными деньгами у
 * покупателя на двух соседних экранах, — и держалось согласие только на
 * внимательности того, кто правит оба места разом.
 *
 * Теперь разбор один, а маршруты берут из него то, что им нужно: корзине —
 * `available`, заказу — `problem.reason` для строки «корзина изменилась».
 *
 * ЧТО СЮДА НЕ ПЕРЕЕХАЛО И ПОЧЕМУ:
 *   - выбор фотографии позиции — вопрос показа, а не денег, и нужен только
 *     корзине;
 *   - `startPrice()` в lib/render.js. Он отвечает на ДРУГОЙ вопрос — «сколько
 *     стоит самая дешёвая доступная сборка», то есть перебирает сочетания, а не
 *     считает названное. Сводить их в одну функцию значило бы склеить «от какой
 *     цены товар» с «сколько стоит вот это»;
 *   - проверка количества и потолка одной покупки: это свойства ЗАКАЗА целиком,
 *     а не позиции.
 *
 * ПОРЯДОК ПРОВЕРОК ЗНАЧИМ. Заказ показывает покупателю причину («вариант
 * изменился» против «нет в наличии»), и она обязана остаться прежней, поэтому
 * проверки идут ровно в том порядке, в каком стояли в маршруте.
 */

const D = require('./discount');
const PF = require('./price-float');
const PROMO = require('./promo');
const V = require('./variants');

const str = (v) => String(v == null ? '' : v).trim();
const add = (v) => Number(v && v.add) || 0;

/* Разбор позиции: что выбрано, во что это обходится и что с этим не так.
 *
 *   view    — товар из хранилища (уже проверенный на видимость);
 *   item    — позиция корзины, как её прислал браузер;
 *   settings — настройки магазина (нужны для плавающих цен и промокодов);
 *   promo   — состояние промокода (`PROMO.stateOf`), одно на весь запрос;
 *   opts.previous — посчитать ещё и цену ПРОШЛОГО периода (нужно только заказу).
 *
 * Считается всё до конца даже у негодной позиции: корзина показывает её цену
 * зачёркнутой рядом с «нет в наличии», а заказ смотрит только на `problem`.
 */
function resolve(view, item, settings, promo, opts) {
  const it = item && typeof item === 'object' ? item : {};
  const storage = str(it.storage);
  const color = str(it.color);
  const bandStr = str(it.band);
  const bandSize = str(it.bandSize);

  const st = storage && Array.isArray(view.storages) ? view.storages.find(x => x.label === storage) : null;
  const cl = color && Array.isArray(view.colors) ? view.colors.find(x => x.name === color) : null;
  const band = V.findBand(view, bandStr);
  const sz = band && bandSize ? (band.group.sizes || []).find(x => x.label === bandSize) : null;
  const chosen = V.findOptions(view, it);
  const picked = V.choiceMap(chosen);

  // Название сборки — то, что уедет в заявку и в уведомление менеджеру.
  let name = view.name;
  if (st) name += ' ' + st.label;
  if (cl) name += ', ' + color;
  if (band) {
    name += ', ' + band.group.name + ' · ' + band.option.name;
    if (sz) name += ' ' + sz.label;
  }
  for (const c of chosen) if (c.value) name += ', ' + c.value.label;

  /* Цена текущего периода плюс доплаты выбранного. Спрашивается она у
   * `PF.priceOf` — единственной точки входа во всём проекте: с ценой из
   * каталога покупатель увидел бы в корзине не то, что стояло на карточке. */
  const base = PF.priceOf(view, settings);
  const adds = add(st) + (band ? add(band.option) : 0) + add(sz) + V.optionsAdd(chosen);
  const sum = base + adds;

  /* Процент — тот же, что видит покупатель на карточке (`PROMO.pctFor`), а не
   * скидка товара из каталога: выключенная промоакция обязана пропасть и из
   * корзины тоже, иначе зачёркнутая цена осталась бы жить в ней одной. */
  const pct = PROMO.pctFor(view, settings);
  const priced = PROMO.priceFor(sum, pct, promo);

  const out = {
    base, adds, sum, name, storage, color, chosen,
    band: band ? bandStr : '', bandSize: band ? bandSize : '',
    price: priced.price, compare: priced.compare, full: priced.full,
    saved: Math.max(0, (priced.compare || 0) - priced.price),
    problem: firstProblem(view, it, { st, cl, band, sz, chosen, picked, storage, color, sum }),
    previous: null
  };

  /* Цена ПРОШЛОГО периода — ради стыка на оформлении: покупатель мог смотреть на
   * ценник в 14:59, а нажать «Оформить» в 15:00. Считается она через тот же
   * промокод, а не вычитанием: код со своим процентом — не линейная надбавка, и
   * «цена минус база плюс прошлая база» дала бы не то число, которое он видел. */
  if (opts && opts.previous) {
    const prevBase = PF.previousOf(view, settings);
    if (prevBase !== base) {
      const prev = PROMO.priceFor(sum - base + prevBase, pct, promo);
      out.previous = { base: prevBase, price: prev.price, compare: prev.compare, saved: Math.max(0, (prev.compare || 0) - prev.price) };
    }
  }
  return out;
}

/* Первая беда позиции — или `null`, если всё в порядке.
 *
 * `label` попадает покупателю в строку «корзина изменилась», поэтому у наличия
 * он называет ИМЕННО распроданный вариант («iPhone 17 Pro 1 ТБ»), а не товар.
 */
function firstProblem(view, it, ctx) {
  const { st, cl, band, sz, chosen, picked, storage, sum } = ctx;
  if (!view.inStock) return { reason: 'out_of_stock', label: view.name };
  // Названного варианта в товаре больше нет: цвет переименовали, конфигурацию
  // убрали. Молча продать «просто товар» по базовой цене нельзя.
  if (V.variantMissing(view, it)) return { reason: 'variant_changed', label: view.name };
  if (st && st.inStock === false) return { reason: 'out_of_stock', label: view.name + ' ' + st.label };
  if (cl && cl.inStock === false) return { reason: 'out_of_stock', label: view.name + ', ' + cl.name };
  if (band) {
    if (band.option.inStock === false) return { reason: 'out_of_stock', label: view.name + ', ' + band.option.name };
    // Вариация «в цвет корпуса» продаётся только со своим корпусом.
    if (band.option.forColor && band.option.forColor !== ctx.color) return { reason: 'variant_changed', label: view.name };
    if (sz && sz.inStock === false) return { reason: 'out_of_stock', label: view.name + ', ' + sz.label };
  }
  for (const c of chosen) {
    if (!c.value || c.value.inStock === false || !V.optionFits(c.value, storage, picked)) {
      return { reason: 'variant_changed', label: view.name };
    }
  }
  // Конфигурация тоже бывает привязана к выбору: 8 ТБ есть только с M5 Max.
  if (st && !V.optionFits(st, storage, picked)) return { reason: 'variant_changed', label: view.name };
  if (!Number.isFinite(sum) || sum < 0) return { reason: 'price_changed', label: view.name };
  return null;
}

module.exports = { resolve };
