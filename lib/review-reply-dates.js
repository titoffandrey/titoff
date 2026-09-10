'use strict';

// Ответ сохраняет задержку относительно отзыва, пока она помещается между
// новой датой отзыва и текущим временем. Без верхней границы ночной сдвиг
// переносил ответы на месяцы вперёд; без нижней ответ предшествовал отзыву.
// Возвращаем новый объект только при изменении даты, сохраняя остальные поля.
function shiftedReply(review, nextCreatedAt, now) {
  const reply = review && review.reply;
  const replyAt = Number(reply && reply.at);
  if (!reply || !Number.isFinite(replyAt) || replyAt <= 0) return reply;
  const next = Number(nextCreatedAt);
  const at = Number.isFinite(Number(now)) ? Number(now) : Date.now();
  if (!Number.isFinite(next) || next <= 0) return reply;
  const previous = Number(review.createdAt);
  const from = Number.isFinite(previous) && previous > 0 ? previous : next;
  const shifted = replyAt + (next - from);
  const bounded = Math.min(at, Math.max(Math.min(next, at), shifted));
  return bounded === replyAt ? reply : Object.assign({}, reply, { at: bounded });
}

module.exports = { shiftedReply };
