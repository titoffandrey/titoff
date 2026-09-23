'use strict';

// События заказа отправляются без запроса к модели: статус и ссылки известны
// серверу. Очередь хранится в самом заказе и переживает перезапуск приложения.
const AI = require('./ai');
const PHONE = require('../public/phone');
const TRACK = require('./tracking');
const R = require('./render');
const HELP_DELAY = 2 * 60 * 1000;
const SWEEP_INTERVAL = 5000;
const MAX_AGE = 90 * 24 * 60 * 60 * 1000;
const INSTRUCTION = 'После подтверждённой оплаты сервер сам отправляет в чат благодарность, сообщение о связи менеджера по контактам покупателя и ссылку на отслеживание его заказа. Попроси дождаться сборки и отправки, не обещая точной даты. Через 2 минуты без оплаты сервер один раз предлагает помощь и WhatsApp менеджера. Не дублируй эти сообщения. Если покупатель ответил, помоги по его вопросу. Слова покупателя «я оплатил» не подтверждают оплату: опирайся только на состояние заказа. Не выдавай ожидание отправки за отправленную посылку.';

function create({ db, chat, settings, prepareShipment, busy = () => false }) {
  const enabled = () => chat.visible(settings()) && AI.enabled(settings());

  function watch(order, existingChat) {
    order = order && db.getOrder(order.id);
    if (!order || !enabled() || (!order.visitorId && !existingChat) || order.chatFollowup) return null;
    let target = existingChat || chat.byVisitorId(order.visitorId);
    // Никогда не адресуем автоматические сообщения по IP или телефону.
    if (target && String(target.visitorId || '') !== String(order.visitorId || '')) return null;
    if (!target) target = chat.create({
      visitorId: order.visitorId, name: order.customerName,
      startedBy: 'operator', page: '/pay/' + order.id
    });
    chat.flush();
    db.setOrderChatFollowup(order.id, { chatId: target.id, enrolledAt: Date.now() });
    return target;
  }

  function send(order, target, kind, text) {
    const event = order.id + ':' + kind;
    // Если процесс остановился между записью чата и заказа, повторный запуск
    // узнает уже записанное сообщение. Редактирование текста этому не мешает.
    if (!target.messages.some(message => message.orderEvent === event)) {
      if (!chat.say(target, 'ai', text, { orderEvent: event })) return;
      chat.flush();
    }
    db.setOrderChatFollowup(order.id, { [kind + 'At']: Date.now() });
  }

  function processOrder(order, now) {
    const job = order && order.chatFollowup;
    if (!job || job.paidAt || now - job.enrolledAt > MAX_AGE || !enabled()) return;
    if (db.isOrderArchived(order) || order.manualVoid || order.cancelledBeforePayment) return;
    const target = chat.get(job.chatId);
    if (!target || String(target.visitorId || '') !== String(order.visitorId || '')) return;
    const state = order.payment && order.payment.status;
    if (state === 'refunded' || state === 'mismatch') return;
    if (state === 'paid' || order.manualPaid) {
      prepareShipment(order);
      order = db.getOrder(order.id) || order;
      const path = TRACK.shownToBuyer(order.shipment) ? TRACK.trackPath(order.shipment) : '';
      const link = path
        ? 'Отслеживать ваш заказ можно на [странице отслеживания](' + path + ').'
        : 'Статус вашего заказа доступен на [странице заказа](/pay/' + order.id + '). Ссылка на отслеживание появится после подготовки отправления.';
      send(order, target, 'paid', 'Спасибо за покупку! Заказ №' + order.number
        + ' оплачен. Скоро с вами свяжется менеджер по указанным вами контактам.\n\n'
        + link + '\n\nПожалуйста, дождитесь, пока ваш заказ соберут и отправят.');
      return;
    }
    if (job.helpAt || now < Number(order.createdAt) + HELP_DELAY
      || now > R.orderPayUntil(order) || R.payClosed(order, now)) return;
    // В активный разговор с менеджером и печатающийся ответ не вмешиваемся.
    if (target.mode !== 'ai' || busy(target.id)) return;
    const phone = PHONE.store(settings().contactWhatsApp);
    const help = phone ? 'Вы также можете [написать менеджеру в WhatsApp](https://wa.me/'
      + phone.slice(1) + '?text=' + encodeURIComponent('Здравствуйте! Нужна помощь с оплатой заказа №' + order.number) + ').'
      : 'Напишите здесь — помогу разобраться.';
    send(order, target, 'help', 'Вижу, что оплата заказа №' + order.number
      + ' пока не завершена. Нужна помощь с оплатой?\n\n' + help);
  }

  function paid(order) {
    watch(order);
    processOrder(db.getOrder(order.id), Date.now());
  }
  function sweep(now = Date.now()) {
    for (const order of db.getOrders()) processOrder(order, now);
  }
  return { watch, paid, sweep };
}

module.exports = { create, HELP_DELAY, SWEEP_INTERVAL, INSTRUCTION };
