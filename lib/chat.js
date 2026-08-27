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
// Открытие окна заводит канал заранее, ещё до первой реплики. Такой черновик
// нужен, пока человек выбирает товар и набирает вопрос, но хранить его 90 дней
// и показывать менеджеру как «Пустой диалог» незачем.
const EMPTY_RETENTION_MS = 60 * 60 * 1000;
const FLUSH_MS = 3000;              // как часто пачка изменений уходит на диск
const CLEANUP_MS = 10 * 60 * 1000;  // как часто выметаем протухшее
const MAX_TEXT = 4000;              // предел одной реплики
/* Сколько снимков можно приложить к одной реплике. Три — это ровно тот случай,
 * ради которого фото в чате и нужно: показать коробку, чек или экран с ошибкой.
 * Больше — уже галерея, а разбирать её менеджеру в переписке негде. */
const MAX_PHOTOS = 3;
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
let byVisitor = new Map();        // метка посетителя метрики → id диалога
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
/* Через сколько консультант возвращается, если менеджер не ответил.
 *
 * Число живёт ЗДЕСЬ, а не в server.js, потому что спрашивают его трое: сам
 * возврат, форма настроек (подпись поля и проверка) и её же проверка границ.
 * Тремя копиями они разъехались бы на первой правке.
 *
 * НОЛЬ означает «не возвращать вовсе»: ответил человек — дальше только человек.
 * Это законный режим, поэтому пустое поле читается как значение по умолчанию, а
 * ноль — как осознанный отказ.
 */
const TAKEOVER_DEFAULT_MIN = 5;
const TAKEOVER_MAX_MIN = 24 * 60;
function takeoverMinutes(settings) {
  const raw = settings && settings.aiTakeoverMinutes;
  if (raw === '' || raw === null || raw === undefined) return TAKEOVER_DEFAULT_MIN;
  const n = Math.floor(Number(raw));
  if (!Number.isFinite(n) || n < 0) return TAKEOVER_DEFAULT_MIN;
  return Math.min(n, TAKEOVER_MAX_MIN);
}

function visible(settings) {
  if (!settings || !settings.chatEnabled) return false;
  // Отвечать должен хоть кто-то: выключенный галочкой консультант в счёт не
  // идёт — с ключом или без, он молчит, и остаётся только менеджер в Telegram.
  return AI.enabled(settings) || TGCHAT.configured(settings);
}

/* ------------------------------- Хранилище ------------------------------- */

/* Куда девать файлы удалённых реплик.
 *
 * Снимки покупателя лежат в общем хранилище загрузок, а срок жизни у них —
 * срок жизни переписки: она вытесняется по 90 дням и по потолку в 3000
 * диалогов, реплики обрезаются по MAX_MESSAGES, менеджер удаляет отдельные
 * сообщения и целые разговоры. Без уборки каждый такой путь оставлял бы файл
 * в хранилище навсегда.
 *
 * Сам модуль про хранилище загрузок ничего не знает и знать не должен —
 * удаление приходит снаружи одной функцией (`server.js` подставляет
 * `db.deleteUploadIfUnused`). Заодно это единственная дверь: все пути удаления
 * реплик сходятся в `forget()` ниже, и забыть один из них уже нельзя.
 */
let dropFiles = null;

function init(dataDir, opts) {
  dataFile = path.join(String(dataDir || ''), 'chats.json');
  dropFiles = opts && typeof opts.dropFiles === 'function' ? opts.dropFiles : null;
  load();
}

// Снимки перечисленных реплик — и сразу в уборку. Пустой список ничего не стоит.
function forget(messages) {
  if (!dropFiles) return;
  const files = [];
  for (const m of (messages || [])) for (const f of photosOf(m)) files.push(f);
  if (files.length) dropFiles(files);
}
function photosOf(message) {
  return Array.isArray(message && message.photos) ? message.photos : [];
}

/* Имя файла в хранилище загрузок. Проверка та же, что у `safeUploadName` в
 * lib/db.js, и по той же причине: имя уезжает в путь на диске и в `src` на
 * странице. Своей копии правила здесь быть не хотелось, но альтернатива —
 * подключить `lib/db.js` в модуль, который прекрасно живёт без него.
 */
function safePhoto(name) {
  const value = String(name == null ? '' : name);
  return /^[\w.\-]{1,120}$/.test(value) && !value.includes('..') ? value : '';
}
function cleanPhotos(list) {
  const out = [];
  for (const item of (Array.isArray(list) ? list : [])) {
    const name = safePhoto(item);
    if (name && !out.includes(name)) out.push(name);
    if (out.length >= MAX_PHOTOS) break;
  }
  return out;
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
  byVisitor = new Map();
  for (const chat of chats.values()) {
    if (chat.topicId) byTopic.set(String(chat.topicId), chat.id);
    if (chat.visitorId) byVisitor.set(chat.visitorId, chat.id);
  }
}

/* Диалог этого посетителя метрики.
 *
 * Нужен ровно для одного: менеджер пишет ПЕРВЫМ человеку, который в окно чата
 * ещё не заглядывал. Такому диалогу неоткуда попасть в подписанную сессию
 * покупателя, и связывает их метка посетителя — та же, что стоит в его заказе и
 * в карточке метрики.
 *
 * Индекс, а не перебор: спрашивают его на каждой загрузке страницы витрины у
 * того, кто ещё не завёл диалог, а диалогов до трёх тысяч.
 */
function byVisitorId(visitorId) {
  const key = clean(visitorId, 64);
  if (!key) return null;
  const id = byVisitor.get(key);
  return id ? (chats.get(id) || null) : null;
}
// Точечная правка индекса: `visitorId` проставляется и меняется в `touch()`,
// когда покупатель приходит с другого браузера или впервые получает метку.
function indexVisitor(chat, before) {
  if (before && before !== chat.visitorId && byVisitor.get(before) === chat.id) byVisitor.delete(before);
  if (chat.visitorId) byVisitor.set(chat.visitorId, chat.id);
}

function normalize(item) {
  const messages = Array.isArray(item.messages) ? item.messages : [];
  // `poll?since=` использует timestamp как курсор. Две реплики в одну
  // миллисекунду поэтому обязаны получить разные значения, в том числе после
  // перезапуска со старым файлом, где такое совпадение уже могло сохраниться.
  let messageAt = 0;
  const normalizedMessages = messages.filter(m => m && ROLES.includes(m.role))
    .slice(-MAX_MESSAGES).map(m => {
      const rawAt = Math.floor(Number(m.at));
      messageAt = Math.max(messageAt + 1, Number.isFinite(rawAt) && rawAt > 0 ? rawAt : 1);
      const row = {
        role: m.role,
        text: clean(m.text, MAX_TEXT),
        at: messageAt,
        // Имя оператора — чтобы в переписке было видно, что отвечает человек.
        by: clean(m.by, 80)
      };
      // Снимки покупателя. Поля нет у подавляющего большинства реплик, и пустой
      // массив в каждой из них зря раздувал бы файл переписок.
      const photos = cleanPhotos(m.photos);
      if (photos.length) row.photos = photos;
      return row;
    });
  const createdAt = Number(item.at) || Date.now();
  return {
    id: item.id,
    at: createdAt,
    lastAt: Math.max(Number(item.lastAt) || 0, createdAt, messageAt),
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
    /* Техника и место РАЗОБРАННЫМИ полями, а не только склейкой «Компьютер ·
     * macOS 10 · Firefox 140». Значки в панели подбираются по каждому полю
     * отдельно (`R.clientMarks`), и из склеенной строки их не достать — а
     * разбирать её обратно регуляркой значило бы гадать о том, что мы сами
     * только что сложили. Склейка при этом остаётся: она уходит в Telegram,
     * где значков нет, и она же показывается у диалогов, записанных до
     * появления этих полей. */
    client: {
      device: clean(item.client && item.client.device, 60),
      model: clean(item.client && item.client.model, 70),
      os: clean(item.client && item.client.os, 60),
      browser: clean(item.client && item.client.browser, 60),
      city: clean(item.client && item.client.city, 100),
      country: clean(item.client && item.client.country, 100),
      countryCode: clean(item.client && item.client.countryCode, 4)
    },
    /* Когда покупателя видели в последний раз. Обновляется, когда он открывает
     * окно (живой канал), пишет или просто читает — то есть отвечает на вопрос
     * «он ещё здесь?», который менеджер задаёт перед тем, как ответить.
     * «Сейчас в сети» считается отдельно, по открытому каналу: время последней
     * реплики этого не расскажет — человек может молча читать. */
    seenAt: Math.max(Number(item.seenAt) || 0, Number(item.lastAt) || 0, createdAt),
    // Адрес витрины на момент разговора. Нужен ровно затем, чтобы страница в
    // теме Telegram была ссылкой, по которой менеджер нажмёт: собрать его в
    // мосте не из чего — там нет запроса покупателя.
    origin: clean(item.origin, 200),
    // 'ai' — отвечает бот, 'operator' — в диалоге человек и бот молчит,
    // 'closed' — переписка завершена оператором.
    mode: ['ai', 'operator', 'closed'].includes(item.mode) ? item.mode : 'ai',
    /* Кто заговорил первым. Поля нет — писал покупатель: так было у всех
     * диалогов до появления кнопки «Написать» в панели, и переписывать историю
     * ради нового признака незачем.
     *
     * Отличать их приходится не ради подписи: диалог, начатый менеджером,
     * витрина подхватывает по метке посетителя, а не по подписанной сессии, — и
     * разрешать это для разговоров, которые покупатель завёл сам, было бы
     * лишним послаблением там, где сессия и так есть. */
    startedBy: item.startedBy === 'operator' ? 'operator' : 'user',
    topicId: item.topicId ? String(item.topicId) : '',
    // Не прочитано покупателем: счётчик для значка на кнопке чата.
    unread: Math.max(0, Math.floor(Number(item.unread)) || 0),
    /* Галочки: докуда реплики каждой стороны дошли до собеседника и докуда он
     * их прочитал. Пары две — разговор двусторонний: покупатель видит галочки
     * у своих реплик в окне, менеджер у своих в панели.
     *
     * Это WATERMARK по времени реплики, а не отметка у каждой из них. Так
     * дешевле (четыре числа на диалог против поля у каждой из 120 реплик) и,
     * главное, так эта отметка и устроена по смыслу: собеседник открывает
     * переписку и разом прочитывает всё, что в ней накопилось.
     *
     * Полей нет — все нули, то есть у прежних диалогов галочки начинаются с
     * первой новой реплики. Переписывать историю ради нового признака незачем.
     */
    receipt: {
      storeGot: stamp(item.receipt && item.receipt.storeGot),
      storeRead: stamp(item.receipt && item.receipt.storeRead),
      userGot: stamp(item.receipt && item.receipt.userGot),
      userRead: stamp(item.receipt && item.receipt.userRead)
    },
    messages: normalizedMessages
  };
}

function stamp(value) {
  const n = Math.floor(Number(value));
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function scheduleFlush() {
  if (flushTimer || !dirty || !dataFile) return;
  flushTimer = setTimeout(() => { flushTimer = null; flush(); }, FLUSH_MS);
  if (flushTimer.unref) flushTimer.unref();
}

function markDirty() {
  dirty = true;
  LIVE.bump('chat');
  scheduleFlush();
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
  const tmp = dataFile + '.' + process.pid + '.tmp';
  try {
    fs.writeFileSync(tmp, JSON.stringify({ version: 1, chats: list }), { mode: 0o600 });
    fs.renameSync(tmp, dataFile);
  } catch (e) {
    // Сбой записи не превращает несохранённую переписку в «чистую». Оставляем
    // её dirty и повторяем через обычный интервал, даже если новых сообщений не
    // будет (именно этот случай раньше терял последнюю пачку навсегда).
    dirty = true;
    try { fs.unlinkSync(tmp); } catch (e2) {}
    scheduleFlush();
  }
}

function cleanup(force) {
  const now = Date.now();
  if (!force && now - lastCleanup < CLEANUP_MS) return;
  lastCleanup = now;
  const edge = now - RETENTION_DAYS * 24 * 60 * 60 * 1000;
  const emptyEdge = now - EMPTY_RETENTION_MS;
  let changed = false;
  for (const [id, chat] of chats) {
    // Диалог с живым каналом не выселяем, чем бы ни был его возраст: человек
    // прямо сейчас смотрит на эту переписку.
    // Выселенная переписка уносит снимки с собой: срок хранения у них общий.
    if ((chat.lastAt < edge || (!chat.messages.length && chat.lastAt < emptyEdge)) && !streams.has(id)) {
      forget(chat.messages); chats.delete(id); changed = true;
    }
  }
  if (chats.size > MAX_CHATS) {
    const order = [...chats.values()].sort((a, b) => a.lastAt - b.lastAt);
    for (const chat of order) {
      if (chats.size <= MAX_CHATS) break;
      if (streams.has(chat.id)) continue;
      forget(chat.messages);
      chats.delete(chat.id); changed = true;
    }
  }
  if (changed) reindex();
}

/* --------------------------------- Диалоги -------------------------------- */

/* Удалить переписку целиком — насовсем.
 *
 * Корзины здесь нет намеренно: у диалога нет ни счёта, ни денег, которые могли
 * бы прийти позже, — то есть нет и причины держать удалённое «на всякий
 * случай» (в отличие от заказа, где такая причина была). Удаляют мусор:
 * пустые заходы, чужие боты, разговор, начатый по ошибке.
 *
 * Живой канал у покупателя при этом закрывается сам: `push` в несуществующий
 * диалог никого не найдёт, а его вкладка при следующем вопросе заведёт новый.
 * Тема в Telegram остаётся, но привязки к ней больше нет — ответ оператора
 * туда просто не найдёт диалога, и мост скажет об этом в самой теме.
 */
function remove(id) {
  if (!validId(id) || !chats.has(id)) return false;
  const chat = chats.get(id);
  /* Удаляемый диалог может быть открыт у покупателя. Оставить его канал в
   * `streams` значило бы две поломки сразу: утечку соединения до закрытия
   * вкладки и живой канал, привязанный к id, которого больше нет. Закрываем
   * клиентов до удаления записи — EventSource сам перейдёт на запасной опрос,
   * а следующая реплика покупателя заведёт новый разговор обычным маршрутом. */
  const clients = streams.get(id);
  if (clients) for (const client of [...clients]) detach(client);
  forget(chat.messages);
  chats.delete(id);
  reindex();
  markDirty();
  return true;
}

function get(id) { return validId(id) ? (chats.get(id) || null) : null; }
function byTopicId(topicId) {
  const id = byTopic.get(String(topicId || ''));
  return id ? get(id) : null;
}
/* В общий список панели попадают только настоящие разговоры. Само открытие
 * виджета создаёт пустой черновик ради живого канала; показывать каждое такое
 * любопытство строкой «Пустой диалог» означало бы засыпать менеджера мусором.
 * Черновик остаётся доступен по посетителю и появится здесь с первой репликой. */
function list() {
  return [...chats.values()].filter(chat => chat.messages.length).sort((a, b) => b.lastAt - a.lastAt);
}
function count() { return chats.size; }
// Сколько диалогов ждут человека: оператор ещё не входил, а покупатель пишет.
// Это и есть счётчик у раздела в панели — тот же смысл, что у очереди отзывов.
function activeCount(withinMs) {
  const edge = Date.now() - (withinMs || 30 * 60 * 1000);
  let n = 0;
  for (const chat of chats.values()) if (chat.mode !== 'closed' && chat.lastAt >= edge) n++;
  return n;
}

/* Сколько диалогов ждут прочтения — счётчик у раздела в шапке панели.
 *
 * Считаем ровно то же, что показывают галочки покупателю: его реплика новее
 * отметки «магазин прочитал». Своего признака «непрочитано» заводить не нужно —
 * он уже есть, и второй разъехался бы с галочками, то есть с тем, что покупатель
 * видит у себя в окне. Ответ ИИ отметку двигает, и это правильно: вопрос закрыт,
 * звать человека незачем.
 */
function unreadCount() {
  let n = 0;
  for (const chat of chats.values()) if (storeUnread(chat)) n++;
  return n;
}

/* Сколько реплик покупателя в этом диалоге ждут прочтения.
 *
 * Тот же признак, что и у счётчика в шапке (`unreadCount` считает диалоги, где
 * это число не ноль), — и в этом весь смысл: пока признаков было два, шапка
 * писала «6», а по списку было не понять, какие именно шесть. Второй счётчик
 * `chat.unread` рядом — НЕ про то же самое: он про непрочитанное У ПОКУПАТЕЛЯ и
 * висит значком на его кнопке.
 */
function storeUnread(chat) {
  if (!chat || chat.mode === 'closed') return 0;
  const read = (chat.receipt && chat.receipt.storeRead) || 0;
  let n = 0;
  for (let i = chat.messages.length - 1; i >= 0; i--) {
    const m = chat.messages[i];
    if (m.at <= read) break;                 // дальше только прочитанное: реплики идут по времени
    if (m.role === 'user') n++;
  }
  return n;
}

/* Метки посетителей, у кого прямо сейчас открыт живой канал чата.
 *
 * Нужно метрике: канал держится только открытой страницей витрины, то есть
 * человек на сайте — а heartbeat метрики молчит, пока вкладка скрыта (он идёт
 * только у видимой). Без этой связки панель говорила про одного и того же
 * человека «в сети» в чате и «был 5 минут назад» в его карточке.
 */
function onlineVisitorIds() {
  const out = [];
  for (const id of streams.keys()) {
    const chat = chats.get(id);
    if (chat && chat.visitorId) out.push(chat.visitorId);
  }
  return out;
}

function create(info) {
  const chat = normalize(Object.assign({ id: newId(), at: Date.now(), lastAt: Date.now() }, info || {}));
  chats.set(chat.id, chat);
  indexVisitor(chat, '');
  cleanup();
  markDirty();
  return chat;
}

// Обстановка вокруг покупателя обновляется на каждом сообщении: он ходит по
// сайту, пока идёт разговор, и «смотрит iPhone 17» через пять реплик может
// означать уже другой товар.
function touch(chat, info) {
  if (!chat || !info) return chat;
  const visitorBefore = chat.visitorId;
  for (const key of ['name', 'contact', 'visitorId', 'ip', 'city', 'device', 'page', 'origin']) {
    if (info[key] !== undefined && info[key] !== null && String(info[key]).trim()) {
      chat[key] = clean(info[key], key === 'page' ? 300 : 200);
    }
  }
  // Метка посетителя ведёт свой индекс: диалог по ней ищут на каждой загрузке
  // страницы у того, кто ещё не писал сам.
  if (chat.visitorId !== visitorBefore) indexVisitor(chat, visitorBefore);
  // Разобранная техника и место — для значков в панели.
  if (info.client) {
    for (const key of ['device', 'model', 'os', 'browser', 'city', 'country', 'countryCode']) {
      const value = clean(info.client[key], 100);
      if (value) chat.client[key] = value;
    }
  }
  // Любое обращение покупателя — это признак жизни: он на сайте прямо сейчас.
  chat.seenAt = Date.now();
  return chat;
}

/* Здесь ли покупатель.
 *
 * Два разных вопроса, и оба нужны менеджеру перед тем, как отвечать: «сидит ли
 * он в окне ПРЯМО СЕЙЧАС» и «если ушёл, то когда». Первое — это открытый живой
 * канал, и только он: по времени последней реплики этого не узнать, человек
 * может молча читать ответ. Второе — `seenAt`.
 */
function presence(chat) {
  if (!chat) return { online: false, seenAt: 0 };
  return { online: online(chat.id), seenAt: Number(chat.seenAt) || Number(chat.lastAt) || 0 };
}

/* Отметить, что покупателя видели. Зовётся при открытии и закрытии канала:
 * пока он смотрит в окно, время не важно (он «в сети»), а вот момент ухода —
 * это ровно то, что показывается менеджеру как «был в 20:36».
 *
 * `LIVE.bump` здесь обязателен: у открытой панели статус иначе оставался бы
 * прежним до следующей реплики, то есть врал бы всё время, пока идёт молчание.
 */
function markSeen(chat) {
  if (!chat) return;
  chat.seenAt = Date.now();
  markDirty();
}

/* Имена собеседников — ОДНО место на весь проект.
 *
 * Покупателю магазин отвечает двумя голосами, и оба они наши: консультант и
 * менеджер. Имя оператора берётся отсюда, а НЕ из его учётной записи Telegram —
 * иначе покупатель видел бы то «Максим», то «@sales_ivan», то есть внутреннюю
 * кухню магазина вместо ровного разговора с одним продавцом. Кто именно из
 * менеджеров ответил, видно в самой теме Telegram, где стоит его подпись.
 *
 * Подставляются они на сервере (`chatView` в server.js), поэтому в браузере
 * своей копии этих строк нет: разъехавшись, витрина и панель показывали бы
 * разные имена под одной и той же репликой.
 */
const SPEAKERS = {
  ai: 'Роман (Консультант)',
  operator: 'Александр (Менеджер)'
};
function speakerOf(role, fallback) {
  return SPEAKERS[role] || String(fallback || '');
}

function addMessage(chat, role, text, opts) {
  if (!chat || !ROLES.includes(role)) return null;
  // Обрезаем края: строка из одних пробелов — это не реплика, а нажатый по
  // ошибке «отправить». Без trim она проходила проверку на пустоту (пробелы —
  // непустая строка) и оставляла в ленте молчаливый пузырь.
  const body = clean(text, MAX_TEXT).trim();
  /* Реплика без текста законна ровно тогда, когда в ней есть снимок: прислать
   * фото коробки без единого слова — обычное дело в любом мессенджере. Пустая
   * же во всех смыслах реплика по-прежнему отбрасывается: строка из одних
   * пробелов — это не сообщение, а нажатый по ошибке «отправить». */
  const photos = cleanPhotos(opts && opts.photos);
  if (!body && !photos.length) return null;
  const previous = Math.max(Number(chat.lastAt) || 0,
    Number(chat.messages.length && chat.messages[chat.messages.length - 1].at) || 0);
  /* Подпись ставится при сохранении, а не при показе: реплика уходит сразу в
   * три места — в живой канал покупателю, в переписку на диск и в панель, — и
   * подписывать её в каждом из них значило бы три раза повторить одно правило.
   * У покупателя и системных строк имени нет вовсе. */
  const message = {
    role, text: body, at: Math.max(Date.now(), previous + 1),
    by: speakerOf(role, clean(opts && opts.by, 80))
  };
  if (photos.length) message.photos = photos;
  chat.messages.push(message);
  if (chat.messages.length > MAX_MESSAGES) {
    // Вытесненные реплики уносят свои снимки: ссылок на них больше нет нигде.
    forget(chat.messages.slice(0, chat.messages.length - MAX_MESSAGES));
    chat.messages = chat.messages.slice(-MAX_MESSAGES);
  }
  chat.lastAt = message.at;
  // Непрочитанное считаем только для покупателя: значок висит на его кнопке.
  if (role !== 'user') chat.unread++;
  else chat.unread = 0;
  markDirty();
  return message;
}

/* ---------------------- Правка и удаление реплики ----------------------
 *
 * Менеджер правит переписку из панели — и свои реплики, и ответы консультанта,
 * и сообщения покупателя. Повод обычный: бот наговорил лишнего, оператор
 * промахнулся кнопкой, покупатель прислал в чат номер карты.
 *
 * ГЛАВНОЕ ПРАВИЛО: покупатель этого не видит.
 *
 *   - ничего не уходит в живой канал (`push`), поэтому в уже открытом окне
 *     ничего не дёргается и не пропадает у человека из-под глаз;
 *   - пометок «изменено» и «удалено» нет ни в панели, ни на витрине: правка —
 *     наше внутреннее дело, а такая подпись рассказывала бы покупателю ровно
 *     то, что мы прячем;
 *   - `at`, `role`, `by` и обе пары галочек не трогаются. Время реплики — ключ
 *     и курсор опроса (`/api/chat/poll` отдаёт всё новее `since`), а отметки
 *     прочтения — watermark по этому же времени: сдвинь их правка, и у
 *     покупателя поехали бы галочки под соседними репликами.
 *
 * Исправленный текст он увидит при следующем открытии окна — `/api/chat/open`
 * отдаёт переписку целиком.
 */
function findMessage(chat, at) {
  const stamp = Number(at) || 0;
  if (!chat || !stamp) return -1;
  return chat.messages.findIndex(m => m.at === stamp);
}

function editMessage(chat, at, text) {
  const i = findMessage(chat, at);
  if (i < 0) return null;
  const body = clean(text, MAX_TEXT).trim();
  // Пустой текст — это удаление, а не молчаливый пузырь в ленте. Здесь его не
  // делаем: удаление отдельным действием и с подтверждением.
  if (!body || body === chat.messages[i].text) return null;
  chat.messages[i].text = body;
  markDirty();
  return chat.messages[i];
}

function dropMessage(chat, at) {
  const i = findMessage(chat, at);
  if (i < 0) return null;
  const [gone] = chat.messages.splice(i, 1);
  // Снимки уходят вместе с репликой: показывать их больше негде, а лежать они
  // будут вечно.
  forget([gone]);
  /* `lastAt` держит порядок списка диалогов. Указывать он может ровно на ту
   * реплику, которую сейчас удалили, — тогда диалог висел бы в списке по
   * времени сообщения, которого больше нет. Пересчитываем по оставшимся, а у
   * опустевшего диалога возвращаемся ко времени начала. */
  const last = chat.messages[chat.messages.length - 1];
  chat.lastAt = last ? last.at : (Number(chat.at) || chat.lastAt);
  /* Значок непрочитанного у покупателя — про реплики магазина. Оставить его
   * висеть за удалённую значило бы позвать человека в окно, где для него
   * ничего нового нет. */
  if (gone.role !== 'user' && chat.unread > 0) chat.unread--;
  markDirty();
  return gone;
}

/* Смена собеседника ничего не пишет в ленту, и это осознанно.
 *
 * Раньше здесь появлялась серая строка «Менеджер подключился к разговору». Она
 * рассказывала покупателю про устройство магазина — что до этого отвечал не
 * человек, — а знать ему это незачем: он пришёл за техникой, а не за составом
 * смены. Смену голоса и так видно по имени над репликой, и этого достаточно.
 *
 * Событие `mode` в канал уходит по-прежнему: по нему браузер понимает, ждать
 * ли ответа бота, — но никакого текста покупателю оно не показывает.
 */
function setMode(chat, mode, opts) {
  if (!chat || !['ai', 'operator', 'closed'].includes(mode)) return chat;
  if (chat.mode === mode) return chat;
  chat.mode = mode;
  chat.lastAt = Math.max(Date.now(), (Number(chat.lastAt) || 0) + 1);
  markDirty();
  if (opts && opts.silent) return chat;
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

/* ------------------------------ Галочки ------------------------------
 *
 * Отметки живут парами и всегда двигаются ВПЕРЁД — до времени последней реплики
 * той стороны, чьи сообщения читают. Именно до реплики, а не до «сейчас», и в
 * этом весь фокус: страницу диалога в панели перерисовывает живое обновление, и
 * watermark по текущему времени двигался бы на каждой перерисовке, помечая
 * данные изменёнными, — то есть панель обновляла бы сама себя по кругу.
 * Сдвинуть отметку нечем, пока собеседник не написал что-то новое.
 *
 * Прочитанное заведомо доставлено: иначе у реплики, прочитанной раньше, чем
 * дошло подтверждение доставки, галочек оказалось бы меньше, чем у соседней.
 */
function lastFrom(chat, side) {
  for (let i = chat.messages.length - 1; i >= 0; i--) {
    const role = chat.messages[i].role;
    if (side === 'user' ? role === 'user' : (role === 'ai' || role === 'operator')) return chat.messages[i].at;
  }
  return 0;
}

function bump(chat, key, edge) {
  if (!chat || !(edge > 0)) return false;
  const r = chat.receipt;
  const before = r.storeGot + ':' + r.storeRead;
  let changed = false;
  if (edge > r[key]) { r[key] = edge; changed = true; }
  if (key === 'storeRead' && r.storeRead > r.storeGot) { r.storeGot = r.storeRead; changed = true; }
  if (key === 'userRead' && r.userRead > r.userGot) { r.userGot = r.userRead; changed = true; }
  if (!changed) return false;
  markDirty();
  /* Покупателю галочки уходят в открытый канал: они меняются и без новых
   * реплик — менеджер просто открыл диалог. Уходят ТОЛЬКО его: отметки о
   * репликах магазина двигает каждый его же опрос, и слать их обратно было бы
   * шумом на ровном месте. */
  if (before !== r.storeGot + ':' + r.storeRead) push(chat.id, 'receipt', receipt(chat));
  return true;
}

// Магазин получил или прочитал реплики покупателя.
function markStore(chat, kind, at) {
  const edge = stamp(at) || (chat ? lastFrom(chat, 'user') : 0);
  return bump(chat, kind === 'read' ? 'storeRead' : 'storeGot', edge);
}
// Покупатель получил или прочитал реплики магазина. `at` — до какой именно
// (реплика дошла в открытый канал); без него — до последней.
function markUser(chat, kind, at) {
  const edge = stamp(at) || (chat ? lastFrom(chat, 'store') : 0);
  return bump(chat, kind === 'read' ? 'userRead' : 'userGot', edge);
}

// То, что видит покупатель: докуда магазин получил и прочитал ЕГО реплики.
// Отметки магазина о его собственных репликах покупателю знать незачем.
function receipt(chat) {
  const r = (chat && chat.receipt) || {};
  return { got: stamp(r.storeGot), read: stamp(r.storeRead) };
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
  // Покупатель открыл окно — в панели он становится «в сети» сразу, а не после
  // первой реплики: молчаливого читателя менеджер тоже должен видеть.
  markSeen(chat);
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
    // Ушла последняя вкладка — с этой минуты он «был в сети», и момент ухода
    // надо запомнить именно сейчас: позже взять его будет неоткуда.
    if (!set.size) { streams.delete(client.id); markSeen(get(client.id)); }
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
  /* Реплика магазина, ушедшая в открытый канал, — это и есть «доставлено».
   * Отмечаем здесь, а не у каждого вызывающего: реплики уходят покупателю из
   * трёх мест (ответ оператора, готовый ответ ИИ, системная строка), и
   * забытая отметка означала бы галочку, которая не появляется именно там, где
   * про неё забыли. Событие `receipt` сюда же не возвращается — оно с другим
   * именем, и петли не выходит. */
  if ((name === 'message' || name === 'done') && data && (data.role === 'ai' || data.role === 'operator')) {
    markUser(get(id), 'got', data.at);
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
  MAX_MESSAGES, MAX_TEXT, MAX_PHOTOS, RETENTION_DAYS, SPEAKERS, speakerOf, photosOf, cleanPhotos,
  TAKEOVER_DEFAULT_MIN, TAKEOVER_MAX_MIN, takeoverMinutes,
  init, flush, shutdown, visible,
  get, remove, byTopicId, byVisitorId, list, count, activeCount, unreadCount, storeUnread, onlineVisitorIds,
  create, touch, presence, markSeen,
  addMessage, editMessage, dropMessage, say, setMode, setTopic, markRead, messagesFor,
  markStore, markUser, receipt,
  attach, push, online, validId, clean
};
