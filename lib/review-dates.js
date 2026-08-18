'use strict';
// Даты привезённых отзывов.
//
// У отзыва с площадки есть своя дата (`sourceDate`), и она не меняется никогда.
// А на витрине показывается сдвинутая: набор, залитый один раз, через месяц
// показывал бы самый свежий отзыв месячной давности — витрина выглядит
// заброшенной. Ровно та же беда была у демо-отзывов, и лечится она так же:
// раз в сутки даты сдвигаются вперёд.
//
// Сдвиг считается ВСЕГДА от `sourceDate`, а не от текущего `createdAt`, иначе он
// накапливается: каждый прогон двигал бы ленту ещё на сутки вперёд, и через
// неделю отзывы оказались бы из будущего.

const DAY = 24 * 60 * 60 * 1000;

// Отзыв, которым управляет этот механизм: у него есть исходная дата.
function isShiftable(review) {
  return !!review && Number.isFinite(Number(review.sourceDate)) && Number(review.sourceDate) > 0;
}

// Ровный ГПСЧ от строки — чтобы отзыв без даты получал одну и ту же выдуманную
// дату при каждом прогоне, а не прыгал по ленте.
function seeded(str) {
  let h = 2166136261;
  for (let i = 0; i < String(str).length; i++) {
    h ^= String(str).charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return () => {
    h += 0x6d2b79f5;
    let t = h;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Дата для отзыва, у которого её не было в источнике. Раскидываем по тому же
// отрезку, что и у остальных: чужеродная дата сразу выдаёт заливку.
function inventDate(review, from, to) {
  const rnd = seeded(String(review.id || review.author || '') + ':date');
  return Math.round(from + (to - from) * rnd());
}

function hasMedia(review) {
  return !!(review && ((review.photos && review.photos.length) || (review.videos && review.videos.length)));
}

/**
 * Новые значения createdAt для привезённых отзывов.
 * Возвращает Map(id → createdAt) только для тех, у кого дата реально меняется.
 *
 * Даты раздаются заново: **самые свежие достаются отзывам с фото и видео**, а
 * текстовым — те, что постарше. Набор дат при этом остаётся прежним, меняется
 * только то, кому какая досталась.
 *
 * Зачем: снимок и ролик убедительнее любого текста, и они должны быть видны на
 * первой странице. Переставлять их сортировкой нельзя — тогда на витрине отзыв
 * за 8 августа встаёт над отзывом за 18-е и это читается как сбой. Поэтому лента
 * сортируется строго по дате, а «свежесть» задаётся здесь, один раз в сутки.
 */
function plannedDates(reviews, now) {
  const at = Number.isFinite(Number(now)) ? Number(now) : Date.now();
  const managed = (reviews || []).filter(isShiftable);
  if (!managed.length) return new Map();

  const dates = managed.map(r => Number(r.sourceDate));
  const newest = Math.max.apply(null, dates);
  // Самый свежий отзыв становится сегодняшним — как в наборе демо-отзывов.
  const offset = at - newest;

  // По товарам: набор дат у каждого свой, и перемешивать их между товарами
  // нельзя — у нового iPhone лента начиналась бы датами прошлогодней модели.
  const byProduct = new Map();
  for (const rv of managed) {
    const key = String(rv.productId || '');
    if (!byProduct.has(key)) byProduct.set(key, []);
    byProduct.get(key).push(rv);
  }

  const out = new Map();
  for (const group of byProduct.values()) {
    // Свободные даты этого товара, от свежих к старым.
    const slots = group.map(rv => Math.min(Number(rv.sourceDate) + offset, at)).sort((a, b) => b - a);
    // Кому они достанутся: сначала отзывы с вложениями, внутри группы — в
    // прежнем порядке по исходной дате. Сравнение по id на конце нужно, чтобы
    // раздача не зависела от порядка записей в файле: иначе после правки или
    // удаления одного отзыва даты у соседей могли бы поменяться местами.
    const order = group.slice().sort((a, b) =>
      (hasMedia(b) ? 1 : 0) - (hasMedia(a) ? 1 : 0)
      || Number(b.sourceDate) - Number(a.sourceDate)
      || String(a.id).localeCompare(String(b.id)));
    order.forEach((rv, i) => {
      const next = slots[i];
      if (Number(rv.createdAt) !== next) out.set(rv.id, next);
    });
  }
  return out;
}

module.exports = { plannedDates, isShiftable, hasMedia, inventDate, seeded, DAY };
