'use strict';

// Сдвигает даты привезённых отзывов так, чтобы самый свежий был сегодняшним.
//
// Зачем — см. lib/review-dates.js: набор, залитый один раз, через месяц
// показывает самый свежий отзыв месячной давности, и витрина выглядит
// заброшенной. Запускается тем же cron'ом, что и обновление демо-отзывов.
//
//   node scripts/shift-review-dates.js          # показать, сколько сдвинется
//   node scripts/shift-review-dates.js --apply  # сдвинуть
//
// Считается всегда от исходной даты отзыва (`sourceDate`), поэтому повторный
// запуск ничего не ломает и сдвиг не накапливается.

const db = require('../lib/db');
const { plannedDates } = require('../lib/review-dates');

function shift(now) {
  const list = db.getReviews();
  const plan = plannedDates(list, now);
  if (!plan.size) return 0;
  for (const rv of list) {
    if (!plan.has(rv.id)) continue;
    const next = plan.get(rv.id);
    // Ответ магазина едет вместе с отзывом: даты привезённых отзывов раздаются
    // заново каждую ночь, и оставшийся на месте ответ рано или поздно оказался
    // бы написан раньше самого отзыва. Сдвигается он ровно на ту же величину,
    // поэтому «ответили в тот же день» остаётся правдой. То же правило, что у
    // `sourceDate` при ручной правке даты в панели (db.updateReview).
    if (rv.reply && Number(rv.reply.at) > 0) rv.reply.at += next - (Number(rv.createdAt) || next);
    rv.createdAt = next;
  }
  db.saveReviews(list);
  return plan.size;
}

function preview(now) {
  return plannedDates(db.getReviews(), now).size;
}

if (require.main === module) {
  const apply = process.argv.includes('--apply');
  if (apply) {
    const n = shift();
    console.log(`Сдвинуто дат: ${n}`);
  } else {
    console.log(`К сдвигу: ${preview()} (добавьте --apply, чтобы записать)`);
  }
}

module.exports = { shift, preview };
