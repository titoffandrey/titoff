'use strict';

// Сдвигает даты привезённых отзывов так, чтобы самый свежий был сегодняшним.
//
// Зачем — см. lib/review-dates.js: набор, залитый один раз, через месяц
// показывает самый свежий отзыв месячной давности, и витрина выглядит
// заброшенной. Запускается тем же cron'ом, что и обновление демо-отзывов.
//
//   node scripts/shift-review-dates.js          # показать, сколько сдвинется
//   node scripts/shift-review-dates.js --apply  # сдвинуть
//   node scripts/shift-review-dates.js --repair-replies          # проверить ответы
//   node scripts/shift-review-dates.js --repair-replies --apply  # исправить только их даты
//
// Считается всегда от исходной даты отзыва (`sourceDate`), поэтому повторный
// запуск ничего не ломает и сдвиг не накапливается.

const db = require('../lib/db');
const { plannedDates } = require('../lib/review-dates');
const { shiftedReply } = require('../lib/review-reply-dates');

function updates(list, now, opts) {
  // Одна отметка времени для плана и ответов, в том числе на границе суток.
  const at = Number.isFinite(Number(now)) ? Number(now) : Date.now();
  const plan = opts && opts.repairRepliesOnly ? new Map() : plannedDates(list, at);
  const changed = [];
  for (const rv of list) {
    const next = plan.has(rv.id) ? plan.get(rv.id) : rv.createdAt;
    const reply = shiftedReply(rv, next, at);
    // Проверяем и отзывы без сдвига: ошибочная дата ответа могла сохраниться
    // ещё до исправления, в том числе у демо-отзыва без sourceDate.
    if (plan.has(rv.id) || reply !== rv.reply) changed.push({ rv, next, reply });
  }
  return changed;
}

function shift(now, opts) {
  const list = db.getReviews();
  const changed = updates(list, now, opts);
  if (!changed.length) return 0;
  for (const { rv, next, reply } of changed) {
    rv.createdAt = next;
    if (reply !== rv.reply) rv.reply = reply;
  }
  db.saveReviews(list);
  return changed.length;
}

function preview(now, opts) {
  return updates(db.getReviews(), now, opts).length;
}

if (require.main === module) {
  const apply = process.argv.includes('--apply');
  const opts = { repairRepliesOnly: process.argv.includes('--repair-replies') };
  if (apply) {
    const n = shift(undefined, opts);
    console.log(`${opts.repairRepliesOnly ? 'Исправлено дат ответов' : 'Обновлено отзывов'}: ${n}`);
  } else {
    console.log(`К обновлению: ${preview(undefined, opts)} (добавьте --apply, чтобы записать)`);
  }
}

module.exports = { shift, preview };
