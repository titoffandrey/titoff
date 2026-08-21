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

// Недовольный отзыв: тройка и ниже.
const LOW_RATING = 3;
// Окна, в каждом из которых обязан оказаться хотя бы один такой: «страница 1»
// и «страницы 2–3». Именно окнами, а не порогом «двое в первых трёх»: при
// пороге обе низкие оценки садились на первую страницу подряд, что читается
// уже не как честная лента, а как подборка жалоб.
const EARLY_LOW = [[1, 1, 1], [2, 3, 1]];

function isLow(rv) {
  const n = Number(rv && rv.rating);
  return Number.isFinite(n) && n > 0 && n <= LOW_RATING;
}
// Чем отзыв занимает своё место в ленте: роликом, снимком или одним текстом.
function mediaClass(rv) { return hasVideo(rv) ? 'v' : (hasMedia(rv) ? 'p' : 't'); }

/* Недовольные отзывы на первых страницах.
 *
 * Лента, которая начинается двумя десятками пятёрок подряд, читается как
 * заказная. Низких оценок в наборе мало (у Ultra 3 их три на 221 отзыв), и при
 * раздаче по дате первая попадала на седьмую страницу — то есть её не видел
 * никто.
 *
 * Двигаем их обменом с отзывом ТОГО ЖЕ состава вложений: раскладка медиа от
 * этого не меняется ни на одну позицию, а места роликов остаются за роликами.
 * Берём ближайшего недовольного за границей — так дата съезжает меньше всего.
 */
function liftLow(out, size) {
  for (const [fromPage, toPage, want] of EARLY_LOW) {
    const start = Math.min(out.length, (fromPage - 1) * size);
    const end = Math.min(out.length, toPage * size);
    let have = 0;
    for (let i = start; i < end; i++) if (isLow(out[i])) have++;
    for (let need = want - have; need > 0; need--) {
      let from = -1;
      for (let i = end; i < out.length && from < 0; i++) if (isLow(out[i])) from = i;
      if (from < 0) break;
      let to = -1;
      for (let i = start; i < end && to < 0; i++) {
        if (!isLow(out[i]) && mediaClass(out[i]) === mediaClass(out[from])) to = i;
      }
      if (to < 0) break;
      const swap = out[to]; out[to] = out[from]; out[from] = swap;
    }
  }
  return out;
}

/* Порядок ленты: кому достанутся самые свежие даты.
 *
 * Сначала по местам расставляются ролики (вес — см. `videoSlots`), потом всё
 * остальное. Роликов больше, чем мест, быть не должно (импортёр берёт по
 * `videoCapacity`), но если такое случилось — лишние идут дальше наравне со
 * снимками, а не сваливаются стеной в хвост.
 *
 * **Снимки раздаются РОВНО по всей ленте, а не пачкой в начале.** Раньше было
 * «сначала все с вложениями, потом все текстовые», и на живых данных это давало
 * ленту из двух половин: у Ultra 3 четырнадцать страниц подряд со снимком в
 * каждом отзыве и тринадцать подряд вообще без единого, у AirPods 4 — восемьдесят
 * и сто сорок. Читается это так, будто к середине фотографии кончились. Шаг
 * считается как `floor(j * свободных / снимков)`, поэтому первый снимок
 * достаётся первому же свободному месту, а дальше они идут поровну.
 *
 * Сравнение по id на конце — чтобы раздача не зависела от порядка записей в
 * файле: иначе после правки или удаления одного отзыва даты у соседей могли бы
 * поменяться местами.
 */
function arrange(group, perPage) {
  const fresh = (a, b) => Number(b.sourceDate) - Number(a.sourceDate) || String(a.id).localeCompare(String(b.id));
  const videos = group.filter(hasVideo).sort(fresh);
  const photos = group.filter(rv => !hasVideo(rv) && hasMedia(rv)).sort(fresh);
  const texts = group.filter(rv => !hasMedia(rv)).sort(fresh);

  const out = new Array(group.length);
  const slots = slotsFor(group.length, perPage, videos.length);
  let vi = 0;
  for (const pos of slots) {
    if (vi >= videos.length) break;
    out[pos] = videos[vi++];
  }

  // Ролик без своего места — такое же вложение, как снимок, и дальше он идёт
  // общим потоком.
  const media = photos.concat(videos.slice(vi)).sort(fresh);
  const free = [];
  for (let i = 0; i < out.length; i++) if (!out[i]) free.push(i);

  const mediaAt = new Set();
  if (media.length >= free.length) {
    for (let k = 0; k < free.length; k++) mediaAt.add(k);
  } else {
    for (let j = 0; j < media.length; j++) mediaAt.add(Math.floor(j * free.length / media.length));
  }

  let mi = 0, ti = 0;
  for (let k = 0; k < free.length; k++) {
    out[free[k]] = mediaAt.has(k)
      ? (media[mi++] || texts[ti++])
      : (texts[ti++] || media[mi++]);
  }

  return liftLow(out, pageSize(perPage));
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
    /* Даты обязаны идти строго по убыванию, иначе раскладка не доезжает до
     * витрины: площадка отдаёт дату с точностью до дня, и у 1225 отзывов их
     * всего 277 — до 25 отзывов с одним и тем же значением. Лента сортируется
     * по `createdAt`, и внутри такой группы порядок оказывался произвольным:
     * ролики вставали по два подряд вместо «через один».
     *
     * Разводим соседей на секунду. Показанная дата (дд.мм.гггг) от этого не
     * меняется, а порядок становится ровно тем, что задан раскладкой.
     */
    let prev = Infinity;
    order.forEach((rv, i) => {
      const next = Math.min(slots[i], prev - 1000);
      prev = next;
      if (Number(rv.createdAt) !== next) out.set(rv.id, next);
    });
  }
  return out;
}

module.exports = { plannedDates, arrange, videoSlots, videoCapacity, isShiftable, hasMedia, hasVideo, inventDate, seeded, DAY };
