'use strict';

const PLATEGA = require('./platega');

// Общий адрес из ЛК: payload содержит случайный id попытки, без данных клиента.
// Тело webhook лишь адресует проверку. Финансовый факт всегда берём из GET API.
async function handle(settings, body, headers, { db, reconcile }) {
  const reply = (status, data) => ({ status, body: data });
  if (!PLATEGA.configured(settings) || !PLATEGA.verifyCallback(settings, body, '', headers)) {
    return reply(403, { ok: false });
  }
  const event = PLATEGA.callbackView(body);
  if (!event) return reply(400, { ok: false });
  const candidates = [];
  for (const order of db.getOrders()) {
    for (const attempt of db.paymentAttempts(order)) {
      if (attempt.provider !== PLATEGA.id) continue;
      if (attempt.invoiceId === event.id || (event.externalId && attempt.id === event.externalId)) {
        candidates.push({ order, attempt });
      }
    }
  }
  // Один merchant может принимать заказы нескольких магазинов. Чужой callback
  // подтверждаем без изменений; каждый магазин сверяет свои счета в фоне.
  if (!candidates.length) return reply(200, { ok: true });
  if (candidates.length !== 1) return reply(409, { ok: false });
  const { order, attempt } = candidates[0];
  if ((event.externalId && event.externalId !== attempt.id)
    || (attempt.invoiceId && attempt.invoiceId !== event.id)) {
    return reply(409, { ok: false });
  }
  try {
    // POST мог создать счёт, но потерять ответ. Восстанавливаем привязку лишь
    // по аутентифицированному GET с теми же id, payload, суммой и валютой.
    if (!attempt.invoiceId) {
      const checked = await PLATEGA.invoice(settings, event.id);
      if (!checked.ok) return reply(503, { ok: false, retry: true });
      const match = PLATEGA.matchesInvoice(Object.assign({}, attempt, { invoiceId: event.id }), checked.invoice);
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
    // Уже запущенный polling мог вернуть снимок ДО события webhook. Такой
    // ответ не подтверждает доставку нового финансового события: просим
    // повторить его, не подменяя состояние GET данными уведомления.
    const awaitingEvent = event.state === 'refunded' ? result.state !== 'refunded'
      : event.state === 'paid' ? !['paid', 'mismatch', 'refunded'].includes(result.state)
        : event.state === 'cancelled' && result.state === 'pending';
    return awaitingEvent ? reply(503, { ok: false, retry: true }) : reply(200, { ok: true });
  } catch (_) {
    return reply(503, { ok: false, retry: true });
  }
}

module.exports = { handle };
