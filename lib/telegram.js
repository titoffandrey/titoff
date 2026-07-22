'use strict';
// Отправка заявок и уведомлений в Telegram через Bot API (обычный HTTPS-запрос, fetch встроен в Node 18+).

async function sendTelegram(settings, text) {
  const token = settings && settings.telegramBotToken;
  const chatId = settings && settings.telegramChatId;
  if (!token || !chatId) {
    return { ok: false, skipped: true, reason: 'not_configured' };
  }
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: 'HTML',
        disable_web_page_preview: true
      })
    });
    const data = await res.json().catch(() => ({}));
    return { ok: !!data.ok, data };
  } catch (e) {
    return { ok: false, error: String(e && e.message || e) };
  }
}

module.exports = { sendTelegram };
