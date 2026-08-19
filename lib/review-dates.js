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

// Размер страницы отзывов на витрине: от него считаются места для роликов.
// Берётся из рендера, а не повторяется числом — разъехавшись, они поставили
// бы ролики в середину страницы.
const { REVIEWS_PER_PAGE } = require('./render');

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
function hasVideo(review) { return !!(review && review.videos && review.videos.length); }

/* Куда в ленте ставить отзывы с видео.
 *
 * Ролики стоят **только на первых трёх страницах и на самой последней**, и там
 * идут через один: сначала отзыв без видео, за ним с видео. Причин две.
 *
 * Первая — вес: ролик тяжелее фотографии в сотню раз, и держать их по всей
 * ленте значит платить за то, чего никто не листает. Вторая — вид: три страницы
 * подряд с видео в каждом втором отзыве читаются как живая лента, а сплошная
 * стена роликов — как заливка.
 *
 * Последняя страница нужна тому, кто долистал до конца: пустой хвост выглядит
 * так, будто отзывы кончились ещё раньше.
 *
 * Позиции считаются от размера страницы витрины (`REVIEWS_PER_PAGE`), поэтому
 * он берётся из рендера, а не повторяется здесь числом: разъехавшись, они
 * поставили бы ролики в середину страницы.
 */
const VIDEO_PAGES = [1, 2, 3];
// Места одной страницы: со второй позиции и через одну. Первым в ленте и в
// начале каждой страницы стоит отзыв без видео.
function pageSlots(page, total, size) {
  const start = (page - 1) * size;
  const end = Math.min(total, start + size);
  const slots = [];
  for (let i = start + 1; i < end; i += 2) slots.push(i);
  return slots;
}
function pageSize(perPage) { return Math.max(1, Number(perPage) || REVIEWS_PER_PAGE); }

function videoSlots(total, perPage) {
  const size = pageSize(perPage);
  const pages = Math.max(1, Math.ceil(total / size));
  const wanted = [...new Set(VIDEO_PAGES.concat([pages]))].filter(p => p >= 1 && p <= pages).sort((a, b) => a - b);
  return wanted.reduce((all, page) => all.concat(pageSlots(page, total, size)), []);
}
// Сколько роликов у товара вообще имеет смысл держать: ровно столько, сколько
// мест в раскладке. Остальные лягут в середину ленты и будут весить впустую.
function videoCapacity(total, perPage) { return videoSlots(total, perPage).length; }

/* Какие именно места займут `need` роликов.
 *
 * Раздаём по кругу между целевыми страницами, а не подряд: роликов обычно
 * меньше, чем мест, и при раздаче подряд первые три страницы съедали бы всё, а
 * последняя оставалась пустой — хотя ради того, кто долистал до конца, она в
 * раскладке и есть.
 *
 * Мест не хватило (у уже залитого товара роликов может оказаться больше, чем
 * берёт импортёр) — чередование «через один» просто продолжается на следующих
 * страницах. Дописать лишние в конец нельзя: они собираются в стену видео на
 * последних страницах, а это ровно то, что читается как заливка.
 */
function slotsFor(total, perPage, need) {
  const size = pageSize(perPage);
  const pages = Math.max(1, Math.ceil(total / size));
  const target = [...new Set(VIDEO_PAGES.concat([pages]))].filter(p => p >= 1 && p <= pages).sort((a, b) => a - b);
  const queues = target.map(page => pageSlots(page, total, size));
  const picked = [];
  for (let round = 0; picked.length < need; round++) {
    let any = false;
    for (const queue of queues) {
      if (round >= queue.length) continue;
      any = true;
      picked.push(queue[round]);
      if (picked.length >= need) break;
    }
    if (!any) break;
  }
  // Перелив: те же правила, остальные страницы по порядку.
  const used = new Set(picked);
  for (let page = 1; page <= pages && picked.length < need; page++) {
    for (const pos of pageSlots(page, total, size)) {
      if (picked.length >= need) break;
      if (!used.has(pos)) { used.add(pos); picked.push(pos); }
    }
  }
  return picked.sort((a, b) => a - b);
}

/* Порядок ленты: кому достанутся самые свежие даты.
 *
 * Сначала по местам расставляются ролики, потом всё остальное — отзывы с фото
 * впереди текстовых (снимок убедительнее текста, и на первой странице ему
 * место). Роликов больше, чем мест, быть не должно (импортёр берёт по
 * `videoCapacity`), но если такое случилось — чередование просто продолжается
 * на следующих страницах (`slotsFor`), а не сваливается стеной в хвост.
 *
 * Сравнение по id на конце — чтобы раздача не зависела от порядка записей в
 * файле: иначе после правки или удаления одного отзыва даты у соседей могли бы
 * поменяться местами.
 */
function arrange(group, perPage) {
  const fresh = (a, b) => Number(b.sourceDate) - Number(a.sourceDate) || String(a.id).localeCompare(String(b.id));
  const videos = group.filter(hasVideo).sort(fresh);
  const rest = group.filter(rv => !hasVideo(rv)).sort((a, b) =>
    (hasMedia(b) ? 1 : 0) - (hasMedia(a) ? 1 : 0) || fresh(a, b));

  const out = new Array(group.length);
  const slots = slotsFor(group.length, perPage, videos.length);
  let vi = 0;
  for (const pos of slots) {
    if (vi >= videos.length) break;
    out[pos] = videos[vi++];
  }
  const pool = rest.concat(videos.slice(vi));
  let pi = 0;
  for (let i = 0; i < out.length; i++) if (!out[i]) out[i] = pool[pi++];
  return out;
}

/**
 * Новые значения createdAt для привезённых отзывов.
 * Возвращает Map(id → createdAt) только для тех, у кого дата реально меняется.
 *
 * Даты раздаются заново, и это единственное место, где решается **порядок
 * ленты**: ролики встают по своим местам (`arrange()` — первые три страницы и
 * последняя, через один), за ними отзывы с фото, потом текстовые. Набор дат при
 * этом остаётся прежним, меняется только то, кому какая досталась.
 *
 * Почему не сортировкой: витрина обязана идти строго по дате — отзыв за
 * 8 августа над отзывом за 18-е читается как сбой. Поэтому «свежесть» задаётся
 * здесь, один раз в сутки, а лента потом просто сортируется по createdAt.
 */
function plannedDates(reviews, now, opts) {
  const at = Number.isFinite(Number(now)) ? Number(now) : Date.now();
  const perPage = Number((opts && opts.perPage) || 0) || REVIEWS_PER_PAGE;
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
    // Кому они достанутся — решает раскладка выше.
    const order = arrange(group, perPage);
    order.forEach((rv, i) => {
      const next = slots[i];
      if (Number(rv.createdAt) !== next) out.set(rv.id, next);
    });
  }
  return out;
}

module.exports = { plannedDates, arrange, videoSlots, videoCapacity, isShiftable, hasMedia, hasVideo, inventDate, seeded, DAY };
