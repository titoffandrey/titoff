'use strict';
// Telegram Bot API: заявки, уведомления и онлайн-чат витрины. Обычный HTTPS-запрос,
// fetch встроен в Node 18+ — библиотека боту здесь не нужна ни одна.
//
// Наружу отдаётся `call()` — один вызов метода API, — и поверх него готовые
// `sendTelegram()` для уведомлений и всё, что нужно чату (темы форума, приём
// обновлений). Разбирать ответы каждый раз на месте значило бы повторять одну
// и ту же обработку ошибок в четырёх файлах.

const API = 'https://api.telegram.org/bot';
const TIMEOUT = 10000;

/* Один вызов метода Bot API.
 *
 * `timeout` задаётся отдельно, потому что у длинного опроса (`getUpdates`) он
 * заведомо больше обычного: там запрос ВИСИТ до появления сообщения — в этом
 * весь смысл long polling, и десятисекундный срок обрывал бы его на ровном
 * месте каждые десять секунд.
 */
async function call(token, method, params, timeout) {
  if (!token) return { ok: false, error: 'not_configured' };
  const controller = new AbortController();
  const guard = setTimeout(() => controller.abort(), timeout || TIMEOUT);
  if (guard.unref) guard.unref();
  try {
    const res = await fetch(API + token + '/' + method, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify(params || {})
    });
    const data = await res.json().catch(() => ({}));
    if (data && data.ok) return { ok: true, result: data.result };
    return {
      ok: false,
      // `description` Telegram пишет человеческим языком («Bad Request: message
      // thread not found»), и именно его стоит показывать владельцу в панели:
      // свой перевод здесь только исказил бы причину.
      error: String(data && data.description || 'telegram_error'),
      code: Number(data && data.error_code) || res.status
    };
  } catch (e) {
    const aborted = e && e.name === 'AbortError';
    return { ok: false, error: aborted ? 'timeout' : String(e && e.message || e) };
  } finally {
    clearTimeout(guard);
  }
}

// Уведомление менеджеру: заявки, отзывы, платежи. Настроек нет — молча
// пропускаем, это штатный режим магазина без Telegram.
async function sendTelegram(settings, text, opts) {
  const token = settings && settings.telegramBotToken;
  const chatId = (opts && opts.chatId) || (settings && settings.telegramChatId);
  if (!token || !chatId) return { ok: false, skipped: true, reason: 'not_configured' };
  const params = {
    chat_id: chatId,
    text,
    parse_mode: 'HTML',
    disable_web_page_preview: true
  };
  // Тема супергруппы-форума. Для обычного чата поле просто отсутствует.
  if (opts && opts.threadId) params.message_thread_id = Number(opts.threadId);
  if (opts && opts.replyMarkup) params.reply_markup = opts.replyMarkup;
  const res = await call(token, 'sendMessage', params);
  // Прежний вид ответа сохраняем: его читают вызывающие в server.js.
  return res.ok ? { ok: true, data: { ok: true, result: res.result }, result: res.result }
    : { ok: false, error: res.error, code: res.code };
}

/* Новая тема форума под один диалог чата.
 *
 * Работает только в супергруппе с включёнными Topics, и бот обязан быть в ней
 * администратором с правом «Manage topics». Не вышло — причина возвращается
 * словами Telegram: она уезжает в панель, потому что угадать её по молчанию
 * бота невозможно, а выглядит это как «чат не работает».
 */
function createTopic(token, chatId, name, iconColor) {
  return call(token, 'createForumTopic', {
    chat_id: chatId,
    name: String(name || 'Диалог').slice(0, 128),
    // Цвет иконки темы. Разные цвета у разных состояний делают список тем
    // читаемым с одного взгляда — как раскраска строк заказов по состоянию.
    icon_color: iconColor || 0x6FB9F0
  });
}

function closeTopic(token, chatId, threadId) {
  return call(token, 'closeForumTopic', { chat_id: chatId, message_thread_id: Number(threadId) });
}
function reopenTopic(token, chatId, threadId) {
  return call(token, 'reopenForumTopic', { chat_id: chatId, message_thread_id: Number(threadId) });
}
function editTopic(token, chatId, threadId, name) {
  return call(token, 'editForumTopic', { chat_id: chatId, message_thread_id: Number(threadId), name: String(name || '').slice(0, 128) });
}

// Длинный опрос: запрос висит до `timeout` секунд и возвращается сразу, как
// только у бота появилось сообщение. Задержка ответа оператора при этом почти
// нулевая, а держать открытый webhook-адрес не нужно вовсе.
function getUpdates(token, offset, timeoutSec, allowed) {
  const seconds = Math.max(1, Math.min(50, Number(timeoutSec) || 25));
  return call(token, 'getUpdates', {
    offset: Number(offset) || 0,
    timeout: seconds,
    allowed_updates: allowed || ['message', 'callback_query']
  // Сетевой срок берём с запасом над серверным: обрывать соединение ровно в
  // тот момент, когда Telegram собирается ответить, — верный способ терять
  // последнее сообщение в каждом цикле.
  }, (seconds + 10) * 1000);
}

// Всплывающий ответ на нажатие inline-кнопки. Без него Telegram несколько
// секунд показывает на кнопке часы — оператору кажется, что она не сработала.
function answerCallback(token, id, text) {
  return call(token, 'answerCallbackQuery', { callback_query_id: id, text: String(text || '').slice(0, 200) });
}

// Стоит ли у бота webhook. Он и длинный опрос взаимоисключающи: при живом
// webhook `getUpdates` отвечает 409, и чат молчит без единой видимой причины.
function webhookInfo(token) { return call(token, 'getWebhookInfo', {}); }
function botInfo(token) { return call(token, 'getMe', {}); }

module.exports = {
  call, sendTelegram, createTopic, closeTopic, reopenTopic, editTopic,
  getUpdates, answerCallback, webhookInfo, botInfo
};
