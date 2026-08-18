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
    if (plan.has(rv.id)) rv.createdAt = plan.get(rv.id);
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
