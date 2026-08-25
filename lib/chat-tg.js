'use strict';
/* ============ Мост «чат витрины ↔ Telegram»: тема на диалог ============
 *
 * Что он делает:
 *   - на каждый новый диалог заводит в супергруппе-форуме СВОЮ ТЕМУ;
 *   - пересылает туда реплики покупателя и ответы ИИ, чтобы менеджер видел
 *     разговор целиком, а не его финал;
 *   - принимает ответ оператора (обычное сообщение в теме) и отдаёт его
 *     витрине — с этого момента ИИ в диалоге молчит.
 *
 * ПОЧЕМУ ТЕМЫ, А НЕ ОДНА ЛЕНТА С РЕПЛАЯМИ. В одном чате три параллельных
 * разговора превращаются в кашу через минуту: ответ уходит не тому, а
 * восстановить, кто что спрашивал, можно только листая вверх. Тема — это готовая
 * переписка с одним человеком, у неё есть имя, история и своё «непрочитано».
 *
 * ПОЧЕМУ ЕСТЬ ЗАПАСНОЙ ПУТЬ ЧЕРЕЗ REPLY, ХОТЯ ВЫБРАНЫ ТЕМЫ. Тема не создастся,
 * если бот не админ группы, если Topics в ней выключены или если в настройках
 * стоит id обычного чата. Всё это — молчание бота без единой видимой причины, а
 * платит за него покупатель, который не дождался ответа. Поэтому при отказе
 * сообщение уходит в чат обычным текстом, ответ реплаем на него принимается
 * так же, как ответ в теме, а причина отказа показывается в панели словами
 * Telegram. Это страховка, а не второй режим работы.
 *
 * ПОЧЕМУ ОЧЕРЕДЬ С ПАУЗОЙ. Telegram принимает от бота около 20 сообщений в
 * минуту в ОДНУ группу, а разговор — это две реплики (вопрос и ответ) на
 * каждый ход. Три одновременных диалога упираются в лимит за минуту, и дальше
 * API отвечает 429, то есть вопросы покупателей просто пропадают. Поэтому
 * отправка идёт очередью с паузой, а всё, что накопилось для одной темы за
 * время паузы, склеивается в одно сообщение — оператору так даже удобнее.
 */
const TG = require('./telegram');

// Пауза между сообщениями в группу. 3 секунды — это ровно те самые 20 в минуту,
// с которыми Telegram согласен работать без 429.
const MIN_GAP = 3000;
// Предел одного сообщения Telegram — 4096 символов; берём с запасом на разметку.
const MAX_MESSAGE = 3500;
// Сколько ждём между попытками опроса после сетевой ошибки. Растёт до минуты:
// упавшая сеть не должна превращаться в тысячу запросов в минуту.
const RETRY_MIN = 2000;
const RETRY_MAX = 60000;
const POLL_SECONDS = 25;

function esc(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/* Состояние моста для панели. Владелец обязан видеть не «включено», а то, что
 * происходит на самом деле: бот может быть настроен, но не быть админом группы,
 * а у токена может стоять webhook — и тогда опрос не получит ни одного
 * сообщения. Ровно то же правило, что у строк состояния касс в настройках. */
const state = {
  running: false,
  bot: '',            // @имя бота — по нему владелец узнаёт, тот ли токен
  chatId: '',
  topics: null,       // true — тема создавалась успешно, false — не вышло
  error: '',          // последняя понятная причина отказа
  lastUpdateAt: 0,
  polls: 0
};

let deps = null;      // { chat, settings, onOperator, onCommand }
let token = '';
let chatId = '';
let offset = 0;
let polling = false;
let stopping = false;
let retryAt = RETRY_MIN;

function configured(settings) {
  return !!(settings && settings.chatEnabled && settings.telegramBotToken && targetChat(settings));
}
// Группа чата. Отдельное поле, потому что заявки и переписка — разные потоки:
// заявки удобно держать в личке, а диалоги — в форуме. Пусто — общий чат заявок.
function targetChat(settings) {
  return String((settings && settings.chatChatId) || (settings && settings.telegramChatId) || '').trim();
}

/* ------------------------------ Очередь отправки ------------------------------ */

// ключ темы (или '' для общего чата) → { lines:[], threadId, timer }
const pending = new Map();
let sendingAt = 0;
let queueTimer = null;

function enqueue(key, threadId, line) {
  let box = pending.get(key);
  if (!box) { box = { lines: [], threadId }; pending.set(key, box); }
  box.threadId = threadId;
  box.lines.push(line);
  scheduleQueue();
}

function scheduleQueue() {
  if (queueTimer || !pending.size) return;
  const wait = Math.max(0, sendingAt + MIN_GAP - Date.now());
  queueTimer = setTimeout(() => { queueTimer = null; drainQueue(); }, wait);
  if (queueTimer.unref) queueTimer.unref();
}

async function drainQueue() {
  const entry = pending.entries().next();
  if (entry.done) return;
  const [key, box] = entry.value;
  pending.delete(key);
  sendingAt = Date.now();

  // Всё, что накопилось для этой темы, уходит одним сообщением: три реплики
  // подряд — это один ход разговора, а не три уведомления.
  let text = box.lines.join('\n\n');
  if (text.length > MAX_MESSAGE) text = text.slice(0, MAX_MESSAGE - 1) + '…';

  const res = await TG.sendTelegram(deps ? deps.settings() : null, text,
    box.threadId ? { chatId, threadId: box.threadId } : { chatId });

  if (!res.ok) {
    // Тема удалена в Telegram руками — сообщение потеряно навсегда, если не
    // повторить его в общий чат: переписка идёт живая, и молча ронять реплику
    // покупателя нельзя.
    if (box.threadId && /thread not found|TOPIC_DELETED|message thread/i.test(String(res.error || ''))) {
      forgetTopic(box.threadId);
      enqueue('', 0, text);
    } else if (res.code === 429) {
      // Уважаем паузу, которую назвал сам Telegram: спорить с ней бесполезно.
      sendingAt = Date.now() + 30000;
      enqueue(key, box.threadId, text);
    } else {
      state.error = String(res.error || '').slice(0, 300);
    }
  }
  scheduleQueue();
}

// Тема пропала — диалог не должен остаться привязанным к несуществующему id,
// иначе следующий ответ оператора искать будет негде.
function forgetTopic(threadId) {
  if (!deps || !deps.chat) return;
  const chat = deps.chat.byTopicId(threadId);
  if (chat) deps.chat.setTopic(chat, '');
}

/* --------------------------------- Отправка --------------------------------- */

// Шапка темы: кто пришёл, откуда и с какой страницы. Всё то же, что менеджер
// увидел бы в карточке заказа, — только заказа ещё нет, а решать, отвечать ли
// самому, надо уже сейчас.
function headline(chat) {
  const rows = [];
  if (chat.name) rows.push('👤 ' + esc(chat.name));
  if (chat.contact) rows.push('✉️ ' + esc(chat.contact));
  if (chat.city) rows.push('🌍 ' + esc(chat.city));
  if (chat.device) rows.push('💻 ' + esc(chat.device));
  if (chat.page) rows.push('📄 ' + esc((chat.origin || '') + chat.page));
  rows.push('🆔 <code>' + esc(chat.id.slice(0, 8)) + '</code>');
  return '💬 <b>Новый диалог на сайте</b>\n' + rows.join('\n')
    + '\n\nОтветьте в этой теме — покупатель увидит сообщение в окне чата, и ИИ замолчит.';
}

// Кнопки под шапкой. Их две, и обе про одно: кто ведёт разговор дальше.
function controls(chat) {
  return {
    inline_keyboard: [[
      { text: '🤖 Вернуть ИИ', callback_data: 'ai:' + chat.id.slice(0, 24) },
      { text: '✅ Завершить', callback_data: 'close:' + chat.id.slice(0, 24) }
    ]]
  };
}

/* Завести тему под диалог. Зовётся один раз — на первом сообщении покупателя.
 * Имя темы делаем говорящим: город и начало вопроса, чтобы список тем читался
 * без открытия каждой. */
async function openTopic(chat, settings, firstText) {
  if (!configured(settings)) return false;
  token = String(settings.telegramBotToken || '');
  chatId = targetChat(settings);

  const title = [chat.city || 'Сайт', String(firstText || '').replace(/\s+/g, ' ').trim().slice(0, 60)]
    .filter(Boolean).join(' · ').slice(0, 120);
  const res = await TG.createTopic(token, chatId, title);
  if (res.ok && res.result && res.result.message_thread_id) {
    state.topics = true;
    state.error = '';
    deps.chat.setTopic(chat, res.result.message_thread_id);
    const head = await TG.sendTelegram(settings, headline(chat),
      { chatId, threadId: res.result.message_thread_id, replyMarkup: controls(chat) });
    if (!head.ok) state.error = String(head.error || '').slice(0, 300);
    return true;
  }
  // Тема не завелась. Причину показываем в панели дословно: «Bad Request: the
  // chat is not a forum» и «not enough rights» лечатся по-разному, и угадывать
  // владельцу нечего.
  state.topics = false;
  state.error = String(res.error || '').slice(0, 300);
  console.error('Чат: не удалось создать тему в Telegram — ' + state.error);
  // Диалог всё равно уезжает в чат: молчание хуже неудобства.
  enqueue('', 0, headline(chat)
    + '\n\n<i>Тема не создалась (' + esc(state.error) + '). Ответьте реплаем на это сообщение.</i>');
  return false;
}

// Реплика покупателя.
function relayUser(chat, text) {
  enqueue(chat.topicId || '', Number(chat.topicId) || 0, '🗣 ' + esc(text));
}

// Ответ ИИ. Он тоже уходит в тему — иначе оператор, подключаясь, видит вопросы
// без ответов и переспрашивает то, что покупателю уже сказали.
function relayAi(chat, text) {
  enqueue(chat.topicId || '', Number(chat.topicId) || 0, '🤖 <i>' + esc(text) + '</i>');
}

// Служебная строка: покупатель нажал «Позвать менеджера», диалог закрыт и т.п.
function relaySystem(chat, text) {
  enqueue(chat.topicId || '', Number(chat.topicId) || 0, 'ℹ️ <b>' + esc(text) + '</b>');
}

/* ------------------------------- Приём ответов ------------------------------- */

/* Кому принадлежит входящее сообщение.
 *
 * Порядок проверок именно такой: сперва тема (основной путь), потом реплай на
 * сообщение бота (запасной, когда темы не работают). Обратный порядок ломал бы
 * ответы в теме, сделанные реплаем на конкретную реплику покупателя, — а так
 * отвечают чаще всего.
 */
function chatOfUpdate(message) {
  if (!deps || !deps.chat) return null;
  if (message.message_thread_id) {
    const byTopic = deps.chat.byTopicId(message.message_thread_id);
    if (byTopic) return byTopic;
  }
  const reply = message.reply_to_message;
  if (reply && reply.message_thread_id) {
    const byReply = deps.chat.byTopicId(reply.message_thread_id);
    if (byReply) return byReply;
  }
  // Запасной путь: в тексте сообщения бота стоит короткий id диалога.
  if (reply && typeof reply.text === 'string') {
    const m = /\b([a-f0-9]{8})\b/.exec(reply.text);
    if (m) {
      const found = deps.chat.list().find(c => c.id.startsWith(m[1]));
      if (found) return found;
    }
  }
  return null;
}

function operatorName(from) {
  if (!from) return 'Менеджер';
  const name = [from.first_name, from.last_name].filter(Boolean).join(' ').trim();
  return name || (from.username ? '@' + from.username : 'Менеджер');
}

async function handleMessage(message) {
  // Сообщения самого бота (пересланные реплики покупателя) ответом оператора
  // не являются — иначе бот отвечал бы сам себе бесконечно.
  if (!message || message.from && message.from.is_bot) return;
  const text = String(message.text || message.caption || '').trim();
  if (!text) return;
  const chat = chatOfUpdate(message);
  if (!chat) return;

  if (text.startsWith('/')) return handleCommand(chat, text, message);
  if (deps.onOperator) deps.onOperator(chat, text, operatorName(message.from));
}

/* Команды в теме. Их ровно три, и все — про то, кто ведёт разговор:
 *   /ai    — вернуть бота (после этого он снова отвечает сам)
 *   /close — завершить диалог
 *   /info  — что известно о покупателе
 * Всё остальное, начинающееся со слэша, отправлять покупателю нельзя: это почти
 * наверняка команда другому боту в той же группе.
 */
function handleCommand(chat, text, message) {
  const cmd = text.split(/[\s@]/)[0].toLowerCase();
  if (cmd === '/ai') return deps.onCommand && deps.onCommand(chat, 'ai', operatorName(message.from));
  if (cmd === '/close') return deps.onCommand && deps.onCommand(chat, 'close', operatorName(message.from));
  if (cmd === '/info') return deps.onCommand && deps.onCommand(chat, 'info', operatorName(message.from));
}

async function handleCallback(query) {
  const data = String(query && query.data || '');
  const [action, short] = data.split(':');
  const chat = short && deps.chat.list().find(c => c.id.startsWith(short));
  if (!chat) {
    await TG.answerCallback(token, query.id, 'Диалог не найден');
    return;
  }
  if (action === 'ai' || action === 'close') {
    if (deps.onCommand) deps.onCommand(chat, action, operatorName(query.from));
    await TG.answerCallback(token, query.id, action === 'ai' ? 'ИИ снова отвечает' : 'Диалог завершён');
  }
}

/* --------------------------------- Опрос --------------------------------- */

/* Длинный опрос вместо webhook — осознанно.
 *
 * Webhook требует публичного адреса с сертификатом и ломается при каждой смене
 * домена, а поднять чат надо и на машине разработчика. Длинный опрос работает
 * везде одинаково: запрос висит 25 секунд и возвращается в ту же миллисекунду,
 * когда оператор нажал «отправить», — задержка от этого не появляется.
 */
async function loop() {
  if (polling) return;
  polling = true;
  state.running = true;
  while (!stopping && token) {
    const res = await TG.getUpdates(token, offset, POLL_SECONDS);
    if (stopping) break;
    if (!res.ok) {
      // 409 — у токена стоит webhook, и getUpdates не отдаст ничего никогда.
      // Это единственная ошибка, которую нельзя переждать: её надо показать.
      if (res.code === 409) {
        state.error = 'У бота настроен webhook — приём сообщений из Telegram не работает. '
          + 'Снимите его (deleteWebhook) или отключите чат.';
        console.error('Чат: ' + state.error);
      } else if (res.error !== 'timeout') {
        state.error = String(res.error || '').slice(0, 300);
      }
      await sleep(retryAt);
      retryAt = Math.min(RETRY_MAX, retryAt * 2);
      continue;
    }
    retryAt = RETRY_MIN;
    state.polls++;
    const updates = Array.isArray(res.result) ? res.result : [];
    for (const update of updates) {
      offset = Math.max(offset, Number(update.update_id) + 1);
      state.lastUpdateAt = Date.now();
      try {
        if (update.message) await handleMessage(update.message);
        else if (update.callback_query) await handleCallback(update.callback_query);
      } catch (e) {
        // Одно битое сообщение не должно останавливать приём остальных.
        console.error('Чат: сбой разбора сообщения Telegram — ' + String(e && e.message || e));
      }
    }
  }
  polling = false;
  state.running = false;
}

function sleep(ms) {
  return new Promise(resolve => {
    const t = setTimeout(resolve, ms);
    if (t.unref) t.unref();
  });
}

/* Привести мост в соответствие с настройками. Зовётся при старте и после
 * каждого сохранения настроек: сменили токен — прежний опрос обязан
 * остановиться, иначе два цикла разберут сообщения по очереди и половина
 * ответов оператора пропадёт. */
function sync(settings) {
  const wanted = configured(settings) ? String(settings.telegramBotToken) : '';
  const wantedChat = configured(settings) ? targetChat(settings) : '';
  if (wanted === token && wantedChat === chatId) return;

  stopping = true;                 // текущий цикл выйдет после своего запроса
  token = wanted;
  chatId = wantedChat;
  state.chatId = wantedChat;
  state.error = '';
  offset = 0;
  if (!wanted) { state.running = false; return; }

  // Опрос начинаем с чистого листа, но НЕ разбираем накопленное за время
  // простоя: ответы оператора недельной давности покупателю уже не нужны.
  TG.getUpdates(wanted, -1, 0).then(res => {
    const last = res.ok && Array.isArray(res.result) && res.result.length
      ? Number(res.result[res.result.length - 1].update_id) + 1 : 0;
    offset = last;
    stopping = false;
    loop().catch(e => console.error('Чат: опрос Telegram остановлен — ' + String(e && e.message || e)));
  }).catch(() => { stopping = false; loop().catch(() => {}); });

  TG.botInfo(wanted).then(res => {
    if (res.ok && res.result) state.bot = '@' + String(res.result.username || '');
  }).catch(() => {});
  TG.webhookInfo(wanted).then(res => {
    if (res.ok && res.result && res.result.url) {
      state.error = 'У бота настроен webhook (' + String(res.result.url).slice(0, 80) + ') — '
        + 'пока он стоит, ответы из Telegram приходить не будут.';
    }
  }).catch(() => {});
}

function start(dependencies) {
  deps = dependencies;
  sync(deps.settings());
}
function stop() { stopping = true; token = ''; state.running = false; }

module.exports = {
  MIN_GAP, configured, targetChat, start, stop, sync, state,
  openTopic, relayUser, relayAi, relaySystem, controls
};
