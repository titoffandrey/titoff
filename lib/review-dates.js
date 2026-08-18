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

/**
 * Новые значения createdAt для привезённых отзывов.
 * Возвращает Map(id → createdAt) только для тех, у кого дата реально меняется.
 */
function plannedDates(reviews, now) {
  const at = Number.isFinite(Number(now)) ? Number(now) : Date.now();
  const managed = (reviews || []).filter(isShiftable);
  if (!managed.length) return new Map();

  const dates = managed.map(r => Number(r.sourceDate));
  const newest = Math.max.apply(null, dates);
  const oldest = Math.min.apply(null, dates);
  // Самый свежий отзыв становится сегодняшним — как в наборе демо-отзывов.
  const offset = at - newest;

  const out = new Map();
  for (const rv of managed) {
    let next = Number(rv.sourceDate) + offset;
    if (!Number.isFinite(next)) next = inventDate(rv, oldest + offset, at);
    next = Math.min(next, at);        // из будущего отзывов не бывает
    if (Number(rv.createdAt) !== next) out.set(rv.id, next);
  }
  return out;
}

module.exports = { plannedDates, isShiftable, inventDate, seeded, DAY };
