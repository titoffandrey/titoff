'use strict';
/* ============ Онлайн-чат витрины: диалоги, живой канал, режимы ============
 *
 * Чат нужен затем же, зачем он нужен любому магазину серого импорта: половина
 * вопросов покупателя («это оригинал?», «когда придёт?», «есть 256 ГБ?») стоит
 * между ним и кнопкой оплаты, а уходить за ответом в Telegram он не станет —
 * закроет вкладку. Отвечает на них ИИ, а менеджер видит ту же переписку в
 * Telegram и в любой момент подключается вместо него.
 *
 * Устройство — три части, и эта держит данные:
 *
 *   lib/chat.js        — диалоги, их состояние и живой канал к покупателю
 *   lib/chat-prompt.js — что именно ИИ знает о магазине
 *   lib/chat-tg.js     — мост в Telegram: тема на диалог, ответы оператора
 *
 * ПОЧЕМУ ДИАЛОГИ ЖИВУТ В ПАМЯТИ, А НЕ В `data/*.json` НА КАЖДОЕ СООБЩЕНИЕ.
 * Переписка — самое частое, что здесь пишется: буква за буквой идёт ответ ИИ,
 * покупатель печатает, оператор отвечает. `writeJson()` пишет файл ЦЕЛИКОМ и
 * делает два fsync (~4 мс на файле в мегабайт) — на каждое слово ответа это
 * означало бы дисковую запись всего архива переписок. Поэтому здесь тот же
 * приём, что у метрики: правда живёт в памяти, на диск уходит пачкой раз в
 * несколько секунд, а панель узнаёт об изменении не по файлу, а по вызову
 * `LIVE.bump('chat')` отсюда же.
 *
 * ПОЧЕМУ РЕЖИМ ДИАЛОГА — ЭТО ПОЛЕ, А НЕ ДОГАДКА ПО ПОСЛЕДНЕМУ СООБЩЕНИЮ.
 * Как только в диалог написал человек, ИИ обязан замолчать — и замолчать
 * НАВСЕГДА в этой переписке, а не «пока оператор рядом». Считать это по времени
 * последней реплики значило бы, что бот однажды перебьёт живого менеджера на
 * полуслове; вернуть его можно только осознанно, кнопкой в Telegram.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
// Живое обновление панели. Диалоги лежат в памяти и на диск уходят с задержкой,
// поэтому по файлу их изменение не отследить — модуль сообщает о нём сам, ровно
// как lib/analytics.js. Ничего из проекта `lib/live.js` не подключает, кольца
// зависимостей тут нет.
const LIVE = require('./live');
// Кому отвечать в окне: ИИ, менеджеру из Telegram или обоим. Оба модуля
// подключаются ради одной проверки «настроено ли», зато правило «когда чат
// вообще показывать» остаётся одно на весь проект. Кольца зависимостей нет:
// `lib/ai.js` не подключает ничего, а `lib/chat-tg.js` — только `lib/telegram.js`.
const AI = require('./ai');
const TGCHAT = require('./chat-tg');

/* Сколько сообщений помнит один диалог. Это и предел контекста для ИИ, и
 * предел того, что уезжает в файл: переписка на 300 реплик никому не нужна
 * целиком, а в контекст модели всё равно идёт только хвост. */
const MAX_MESSAGES = 120;
// Сколько диалогов держим. Дальше вытесняем самые старые по последней реплике —
// то же правило, что у карточек посетителей метрики.
const MAX_CHATS = 3000;
// Срок хранения переписки. Дольше её не спросит никто, а лежит она вместе с
// вопросами покупателей — то есть с их персональными данными.
const RETENTION_DAYS = 90;
const FLUSH_MS = 3000;              // как часто пачка изменений уходит на диск
const CLEANUP_MS = 10 * 60 * 1000;  // как часто выметаем протухшее
const MAX_TEXT = 4000;              // предел одной реплики
// Потолок живых каналов. Канал открывается ТОЛЬКО когда покупатель открыл чат
// (а не на каждой загрузке страницы), поэтому число небольшое и означает
// «сколько человек говорят с магазином одновременно».
const MAX_STREAMS = 200;
// Сколько каналов держит один диалог. Две вкладки — обычное дело, десять —
// уже неисправность или попытка занять память.
const MAX_STREAMS_PER_CHAT = 4;

const ROLES = ['user', 'ai', 'operator', 'system'];

let dataFile = '';
let chats = new Map();            // id → диалог
let byTopic = new Map();          // message_thread_id темы Telegram → id диалога
const streams = new Map();        // id диалога → Set живых каналов
let dirty = false;
let flushTimer = null;
let lastCleanup = 0;

function clean(value, max) {
  return String(value == null ? '' : value)
    // Управляющие символы убираем, но перевод строки (\u000a) оставляем:
    // покупатель пишет абзацами, а склеенный в одну строку вопрос читается хуже.
    .replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, '')
    .slice(0, max || MAX_TEXT);
}

function newId() { return crypto.randomBytes(16).toString('hex'); }
function validId(value) { return /^[a-f0-9]{32}$/.test(String(value || '')); }

/* Показывать ли кнопку чата на витрине.
 *
 * Мало включить галочку: окно, в котором некому ответить, хуже отсутствия
 * кнопки — покупатель пишет вопрос и не получает ничего. Поэтому нужен хотя бы
 * один собеседник: ключ ИИ или настроенный Telegram менеджера. Правило одно на
 * весь проект: по нему витрина рисует виджет, а маршруты решают, принимать ли
 * сообщение.
 */
function visible(settings) {
  if (!settings || !settings.chatEnabled) return false;
  return AI.configured(settings) || TGCHAT.configured(settings);
}

/* ------------------------------- Хранилище ------------------------------- */

function init(dataDir) {
  dataFile = path.join(String(dataDir || ''), 'chats.json');
  load();
}

function load() {
  if (!dataFile) return;
  let raw = null;
  try { raw = JSON.parse(fs.readFileSync(dataFile, 'utf8')); }
  catch (e) { return; }             // файла нет или он повреждён — начинаем с чистого
  const list = Array.isArray(raw && raw.chats) ? raw.chats : [];
  chats = new Map();
  for (const item of list) {
    if (!item || !validId(item.id)) continue;
    chats.set(item.id, normalize(item));
  }
  reindex();
}

// Карта «тема Telegram → диалог» строится заново при любой полной замене
// набора: точечные правки ведут обе структуры, а перебор по всем диалогам на
// каждое сообщение оператора стоил бы столько же, сколько поиск посетителя
// метрики до появления там индекса.
function reindex() {
  byTopic = new Map();
  for (const chat of chats.values()) {
    if (chat.topicId) byTopic.set(String(chat.topicId), chat.id);
  }
}

function normalize(item) {
  const messages = Array.isArray(item.messages) ? item.messages : [];
  return {
    id: item.id,
    at: Number(item.at) || Date.now(),
    lastAt: Number(item.lastAt) || Number(item.at) || Date.now(),
    // Кто пишет: имя покупатель называет сам, если захочет.
    name: clean(item.name, 80),
    contact: clean(item.contact, 120),
    // Метка посетителя из метрики — по ней открывается его карточка со всей
    // историей визитов. Диалог и визит связаны, и связывать их вручную незачем.
    visitorId: clean(item.visitorId, 64),
    ip: clean(item.ip, 80),
    city: clean(item.city, 120),
    device: clean(item.device, 200),
    page: clean(item.page, 300),
    // Адрес витрины на момент разговора. Нужен ровно затем, чтобы страница в
    // теме Telegram была ссылкой, по которой менеджер нажмёт: собрать его в
    // мосте не из чего — там нет запроса покупателя.
    origin: clean(item.origin, 200),
    // 'ai' — отвечает бот, 'operator' — в диалоге человек и бот молчит,
    // 'closed' — переписка завершена оператором.
    mode: ['ai', 'operator', 'closed'].includes(item.mode) ? item.mode : 'ai',
    topicId: item.topicId ? String(item.topicId) : '',
    // Не прочитано покупателем: счётчик для значка на кнопке чата.
    unread: Math.max(0, Math.floor(Number(item.unread)) || 0),
    messages: messages.filter(m => m && ROLES.includes(m.role)).slice(-MAX_MESSAGES).map(m => ({
      role: m.role,
      text: clean(m.text, MAX_TEXT),
      at: Number(m.at) || 0,
      // Имя оператора — чтобы в переписке было видно, что отвечает человек.
      by: clean(m.by, 80)
    }))
  };
}

function markDirty() {
  dirty = true;
  LIVE.bump('chat');
  if (flushTimer) return;
  flushTimer = setTimeout(() => { flushTimer = null; flush(); }, FLUSH_MS);
  if (flushTimer.unref) flushTimer.unref();
}

/* Запись на диск. Здесь нет ни fsync, ни временного файла, в отличие от
 * `db.writeJson()`, и это осознанно: переписка — не заказ. Потерять последние
 * секунды разговора при выключении питания неприятно, но не невосполнимо, а
 * платить за каждую реплику двумя fsync значило бы держать диск занятым ради
 * данных, которые через месяц всё равно вычистятся по сроку хранения. */
function flush() {
  if (!dirty || !dataFile) return;
  dirty = false;
  cleanup();
  const list = [...chats.values()];
  try {
    const tmp = dataFile + '.' + process.pid + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({ version: 1, chats: list }), { mode: 0o600 });
    fs.renameSync(tmp, dataFile);
  } catch (e) { /* диск занят или полон — попробуем на следующей пачке */ }
}

function cleanup(force) {
  const now = Date.now();
  if (!force && now - lastCleanup < CLEANUP_MS) return;
  lastCleanup = now;
  const edge = now - RETENTION_DAYS * 24 * 60 * 60 * 1000;
  let changed = false;
  for (const [id, chat] of chats) {
    // Диалог с живым каналом не выселяем, чем бы ни был его возраст: человек
    // прямо сейчас смотрит на эту переписку.
    if (chat.lastAt < edge && !streams.has(id)) { chats.delete(id); changed = true; }
  }
  if (chats.size > MAX_CHATS) {
    const order = [...chats.values()].sort((a, b) => a.lastAt - b.lastAt);
    for (const chat of order) {
      if (chats.size <= MAX_CHATS) break;
      if (streams.has(chat.id)) continue;
      chats.delete(chat.id); changed = true;
    }
  }
  if (changed) reindex();
}

/* --------------------------------- Диалоги -------------------------------- */

function get(id) { return validId(id) ? (chats.get(id) || null) : null; }
function byTopicId(topicId) {
  const id = byTopic.get(String(topicId || ''));
  return id ? get(id) : null;
}
function list() { return [...chats.values()].sort((a, b) => b.lastAt - a.lastAt); }
function count() { return chats.size; }
// Сколько диалогов ждут человека: оператор ещё не входил, а покупатель пишет.
// Это и есть счётчик у раздела в панели — тот же смысл, что у очереди отзывов.
function activeCount(withinMs) {
  const edge = Date.now() - (withinMs || 30 * 60 * 1000);
  let n = 0;
  for (const chat of chats.values()) if (chat.mode !== 'closed' && chat.lastAt >= edge) n++;
  return n;
}

function create(info) {
  const chat = normalize(Object.assign({ id: newId(), at: Date.now(), lastAt: Date.now() }, info || {}));
  chats.set(chat.id, chat);
  cleanup();
  markDirty();
  return chat;
}

// Обстановка вокруг покупателя обновляется на каждом сообщении: он ходит по
// сайту, пока идёт разговор, и «смотрит iPhone 17» через пять реплик может
// означать уже другой товар.
function touch(chat, info) {
  if (!chat || !info) return chat;
  for (const key of ['name', 'contact', 'visitorId', 'ip', 'city', 'device', 'page', 'origin']) {
    if (info[key] !== undefined && info[key] !== null && String(info[key]).trim()) {
      chat[key] = clean(info[key], key === 'page' ? 300 : 200);
    }
  }
  return chat;
}

function addMessage(chat, role, text, opts) {
  if (!chat || !ROLES.includes(role)) return null;
  // Обрезаем края: строка из одних пробелов — это не реплика, а нажатый по
  // ошибке «отправить». Без trim она проходила проверку на пустоту (пробелы —
  // непустая строка) и оставляла в ленте молчаливый пузырь.
  const body = clean(text, MAX_TEXT).trim();
  if (!body) return null;
  const message = { role, text: body, at: Date.now(), by: clean(opts && opts.by, 80) };
  chat.messages.push(message);
  if (chat.messages.length > MAX_MESSAGES) chat.messages = chat.messages.slice(-MAX_MESSAGES);
  chat.lastAt = message.at;
  // Непрочитанное считаем только для покупателя: значок висит на его кнопке.
  if (role !== 'user') chat.unread++;
  else chat.unread = 0;
  markDirty();
  return message;
}

function setMode(chat, mode, opts) {
  if (!chat || !['ai', 'operator', 'closed'].includes(mode)) return chat;
  if (chat.mode === mode) return chat;
  chat.mode = mode;
  chat.lastAt = Date.now();
  markDirty();
  if (opts && opts.silent) return chat;
  // Покупатель обязан видеть, что за клавиатурой сменился собеседник: иначе
  // смена тона и скорости ответов выглядит как сбой.
  push(chat.id, 'mode', { mode });
  return chat;
}

function setTopic(chat, topicId) {
  if (!chat) return chat;
  const value = topicId ? String(topicId) : '';
  if (chat.topicId === value) return chat;
  if (chat.topicId) byTopic.delete(chat.topicId);
  chat.topicId = value;
  if (value) byTopic.set(value, chat.id);
  markDirty();
  return chat;
}

function markRead(chat) {
  if (!chat || !chat.unread) return chat;
  chat.unread = 0;
  markDirty();
  return chat;
}

/* --------------------------- Живой канал покупателю ---------------------------
 *
 * Тот же Server-Sent Events, что у панели, и по той же причине: ни WebSocket,
 * ни библиотек — `EventSource` умеют все браузеры, доходящие до витрины, и он
 * сам переподключается при обрыве.
 *
 * Через канал идёт ТРИ вида событий, и все три должны доходить мгновенно:
 *   - `delta` — очередной кусок ответа ИИ, пока модель его печатает;
 *   - `message` — готовая реплика (оператора, ИИ или системная);
 *   - `mode`/`typing` — кто сейчас отвечает и печатает ли.
 *
 * Канал открывается, только когда покупатель открыл окно чата. Держать сокет
 * на каждого посетителя витрины ради кнопки в углу было бы расточительством:
 * страниц открывают сотни, разговор ведут единицы.
 */
function attach(id, req, res) {
  const chat = get(id);
  if (!chat) return false;

  /* У канала есть свой короткий номер, и покупатель шлёт его вместе с
   * сообщением. Нужен он ради одной вещи: своя реплика уже нарисована в окне в
   * момент нажатия «отправить» (ждать сети здесь нельзя — пауза после своего
   * же сообщения читается как сбой), и эхо того же текста из канала дало бы
   * дубль. Вторая вкладка того же покупателя номера не знает и эхо получит —
   * там реплика и должна появиться. */
  const client = { id, sid: crypto.randomBytes(6).toString('hex'), res, at: Date.now() };
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    // no-transform обязателен: сжимающий прокси накопил бы поток в буфере, и
    // ответ ИИ приезжал бы не по словам, а пачкой в конце.
    'Cache-Control': 'private, no-cache, no-store, no-transform',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no'
  });
  if (req.socket && req.socket.setNoDelay) req.socket.setNoDelay(true);

  let set = streams.get(id);
  if (!set) { set = new Set(); streams.set(id, set); }
  set.add(client);
  // Лишние вкладки одного диалога и переполнение по всем диалогам выселяем с
  // самой старой — то же правило, что у канала панели.
  while (set.size > MAX_STREAMS_PER_CHAT) detach(set.values().next().value);
  while (totalStreams() > MAX_STREAMS) {
    const oldest = oldestClient();
    if (!oldest || oldest === client) break;
    detach(oldest);
  }

  send(client, 'retry: 3000\n\n');
  send(client, event('ready', { mode: chat.mode, sid: client.sid }));

  const bye = () => detach(client);
  res.on('close', bye);
  res.on('error', bye);
  startPing();
  return true;
}

function totalStreams() {
  let n = 0;
  for (const set of streams.values()) n += set.size;
  return n;
}
function oldestClient() {
  let found = null;
  for (const set of streams.values()) for (const client of set) {
    if (!found || client.at < found.at) found = client;
  }
  return found;
}

function detach(client) {
  if (!client) return;
  const set = streams.get(client.id);
  if (set) {
    set.delete(client);
    if (!set.size) streams.delete(client.id);
  }
  try { client.res.end(); } catch (e) {}
  if (!streams.size) stopPing();
}

function event(name, data) {
  return 'event: ' + name + '\ndata: ' + JSON.stringify(data || {}) + '\n\n';
}

function send(client, chunk) {
  try { client.res.write(chunk); client.at = Date.now(); }
  catch (e) { detach(client); }
}

// Разослать событие всем вкладкам одного диалога. `exceptSid` — номер канала,
// которому это событие не нужно (он сам его и вызвал, см. `attach`).
function push(id, name, data, exceptSid) {
  const set = streams.get(String(id || ''));
  if (!set || !set.size) return false;
  const chunk = event(name, data);
  for (const client of [...set]) {
    if (exceptSid && client.sid === exceptSid) continue;
    send(client, chunk);
  }
  return true;
}

// Смотрит ли покупатель на диалог прямо сейчас. От этого зависит, звать ли его
// значком на кнопке и стоит ли ИИ вообще печатать ответ в пустоту.
function online(id) {
  const set = streams.get(String(id || ''));
  return !!(set && set.size);
}

let pingTimer = null;
function startPing() {
  if (pingTimer) return;
  pingTimer = setInterval(() => {
    const now = Date.now();
    for (const set of streams.values()) for (const client of [...set]) {
      // Комментарий SSE: браузер его игнорирует, а канал остаётся живым и
      // прокси не закрывает его как тихий.
      if (now - client.at >= 25000) send(client, ': ping\n\n');
    }
  }, 10000);
  if (pingTimer.unref) pingTimer.unref();
}
function stopPing() {
  if (!pingTimer) return;
  clearInterval(pingTimer); pingTimer = null;
}

/* Реплика, которую видят все разом: она ложится в переписку и тут же уходит
 * в открытый канал покупателя. Двумя вызовами это писалось бы вразнобой —
 * рано или поздно кто-нибудь сохранил бы сообщение, забыв его отправить. */
function say(chat, role, text, opts) {
  const message = addMessage(chat, role, text, opts);
  if (!message) return null;
  push(chat.id, 'message', message, opts && opts.exceptSid);
  return message;
}

function messagesFor(chat, limit) {
  if (!chat) return [];
  const n = Math.max(1, Math.floor(Number(limit)) || MAX_MESSAGES);
  return chat.messages.slice(-n);
}

// Аккуратное завершение процесса: недописанная пачка уходит на диск.
function shutdown() { flush(); }

module.exports = {
  MAX_MESSAGES, MAX_TEXT, RETENTION_DAYS,
  init, flush, shutdown, visible,
  get, byTopicId, list, count, activeCount, create, touch,
  addMessage, say, setMode, setTopic, markRead, messagesFor,
  attach, push, online, validId, clean
};
