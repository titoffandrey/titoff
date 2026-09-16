'use strict';

const SOLUTIONES = require('./solutiones');

/* Уведомление Solutiones — один адрес на магазин (`/api/pay/solutiones/callback`),
 * подписанный HMAC-SHA256 от сырого тела. Попытка узнаётся по телу: `id` —
 * это наш invoiceId, `orderId` — id нашей попытки. Само тело деньгами не
 * становится: как и у Platega, оно лишь адресует GET-сверку.
 *
 * Один мерчант обслуживает и второй сайт на этом же коде: чужое уведомление
 * подтверждаем (200) и ничего не меняем — тот магазин сверит свой счёт сам. */
async function handle(settings, body, rawBody, headers, { db, reconcile }) {
  const reply = (status, data) => ({ status, body: data });
  if (!SOLUTIONES.configured(settings) || !SOLUTIONES.verifyCallback(settings, body, rawBody, headers)) {
    return reply(403, { ok: false });
  }
  const event = SOLUTIONES.callbackView(body);
  if (!event) return reply(400, { ok: false });
  const candidates = [];
  for (const order of db.getOrders()) {
    for (const attempt of db.paymentAttempts(order)) {
      if (attempt.provider !== SOLUTIONES.id) continue;
      if (attempt.invoiceId === event.id || (event.externalId && attempt.id === event.externalId)) {
        candidates.push({ order, attempt });
      }
    }
  }
  if (!candidates.length) return reply(200, { ok: true });
  if (candidates.length !== 1) return reply(409, { ok: false });
  const { order, attempt } = candidates[0];
  if ((event.externalId && event.externalId !== attempt.id)
    || (attempt.invoiceId && attempt.invoiceId !== event.id)) {
    return reply(409, { ok: false });
  }
  try {
    // POST мог создать счёт, а ответ потеряться. Привязку восстанавливаем
    // только по аутентифицированному GET с теми же id, orderId, суммой и валютой.
    if (!attempt.invoiceId) {
      const checked = await SOLUTIONES.invoice(settings, event.id);
      if (!checked.ok) return reply(503, { ok: false, retry: true });
      const match = SOLUTIONES.matchesInvoice(Object.assign({}, attempt, { invoiceId: event.id }), checked.invoice);
      if (!match.ok) return reply(409, { ok: false });
      const attached = db.attachOrderInvoice(order.id, {
        attemptId: attempt.id, invoiceId: event.id, method: attempt.method,
        actualMethod: checked.invoice.method, requisite: '', expiresAt: 0
      });
      if (!attached) return reply(503, { ok: false, retry: true });
    }
    const fresh = db.findPaymentAttempt(db.getOrder(order.id), { attemptId: attempt.id, invoiceId: event.id });
    if (!fresh) return reply(503, { ok: false, retry: true });
    const result = await reconcile(settings, order.id, fresh);
    if (!result.ok) return reply(503, { ok: false, retry: true });
    // GET, ушедший раньше события, мог вернуть прежний снимок. Не подменяем его
    // телом уведомления — просим кассу повторить, и следующий GET увидит деньги.
    const awaitingEvent = event.state === 'refunded' ? result.state !== 'refunded'
      : event.state === 'paid' ? !['paid', 'mismatch', 'refunded'].includes(result.state)
        : event.state === 'cancelled' && result.state === 'pending';
    return awaitingEvent ? reply(503, { ok: false, retry: true }) : reply(200, { ok: true });
  } catch (_) {
    return reply(503, { ok: false, retry: true });
  }
}

module.exports = { handle };
