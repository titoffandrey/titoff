'use strict';
/* ============ Живые обновления панели: один SSE-канал на вкладку ============
 *
 * Панель открывают, чтобы смотреть на то, что меняется само: приходят заказы,
 * кассы двигают их состояние, посетители ходят по витрине, покупатели пишут
 * отзывы. До этого модуля всё это появлялось только по F5 — на «Метрике» ради
 * этого даже стояла кнопка «Обновить», то есть работу за нас делал человек.
 *
 * Устройство простое настолько, насколько возможно:
 *
 *   1. Браузер держит открытым `GET /admin/live` (Server-Sent Events — обычный
 *      ответ, который не заканчивается). Ни WebSocket, ни библиотек: EventSource
 *      умеют все браузеры, доходящие до панели, и сам переподключается.
 *   2. Раз в секунду сервер смотрит mtime трёх файлов хранилища. Изменился —
 *      номер версии темы растёт, и подписчикам этой темы уходит строка данных.
 *   3. Что делать дальше, решает браузер: он перезапрашивает ТУ ЖЕ страницу и
 *      подменяет в ней размеченные блоки (`public/admin-live.js`). Разметку
 *      по-прежнему рисует сервер и только он — второго рендера в JS нет, и
 *      разъезжаться нечему.
 *
 * Почему опрос mtime, а не `fs.watch`: watch на разных системах ведёт себя
 * по-разному, умеет молча пропускать события и отваливаться вместе с
 * переименованием файла — а `writeJson()` пишет именно во временный файл с
 * последующим rename. Три `statSync` в секунду стоят сотые доли миллисекунды и
 * ловят ЛЮБУЮ запись, включая правку скриптом со стороны (`demo-reviews.js`,
 * `sync-prices.js`). Таймер живёт только пока есть хоть один подписчик.
 *
 * Метрика на диск попадает раз в полминуты, поэтому её версию двигает не файл, а
 * сама `lib/analytics.js` вызовом `bump('analytics')`.
 *
 * Модуль не подключает НИЧЕГО из проекта: его требуют и `server.js`, и
 * `lib/analytics.js`, и обратная зависимость замкнула бы require в кольцо.
 */
const fs = require('fs');
const path = require('path');

// Темы, на которые подписываются страницы панели. Строка приходит из адреса
// запроса, поэтому список закрытый: чужое слово в подписку не попадает.
const TOPICS = ['orders', 'reviews', 'products', 'settings', 'analytics', 'chat'];
// Какой файл хранилища какой теме принадлежит. `analytics` и `chat` здесь нет
// намеренно: их данные лежат в памяти и на диск уходят с большой задержкой,
// поэтому об изменении сообщают сами модули (`bump`), а не отпечаток файла.
// Ждать записи чата было бы особенно заметно: диалог в панели отставал бы от
// переписки на несколько секунд у всех на глазах.
const FILES = { orders: 'orders.json', reviews: 'reviews.json', products: 'products.json', settings: 'settings.json' };

const POLL_MS = 1000;          // как часто сверяем файлы
const PING_MS = 25000;         // холостая строка, чтобы прокси не закрыл тихий канал
// Потолок подписчиков. Вкладок у одного администратора бывает много, а каждая
// держит открытый сокет: без предела забытые вкладки копились бы месяцами.
// Переполнение выселяет самого старого — то же правило, что у карт лимитов.
const MAX_CLIENTS = 24;

const rev = Object.create(null);      // тема → номер версии
for (const t of TOPICS) rev[t] = 1;
const stamps = Object.create(null);   // тема → отпечаток файла на прошлой сверке
const dirty = new Set();              // темы, изменившиеся с прошлой рассылки
const clients = new Set();
let dir = '';
let timer = null;

// Каталог данных приходит снаружи (`db.DATA_DIR`), а не собирается здесь из
// переменной окружения: второй такой расчёт разошёлся бы с хранилищем молча.
function watch(dataDir) { dir = String(dataDir || ''); }

// Отметить, что тема изменилась. Пока никто не подписан, считать и рассылать
// нечего: подключившемуся всё равно уезжает текущий номер версии как отсчётная
// точка. Поэтому вызов из `heartbeat` метрики стоит ровно ничего.
function bump(topic) {
  if (!clients.size || rev[topic] === undefined) return;
  dirty.add(topic);
}

function revisions(topics) {
  const out = {};
  for (const t of topics) out[t] = rev[t];
  return out;
}

// Отпечаток файла: время правки и размер. Только mtime мало — две записи внутри
// одной миллисекунды дали бы одинаковую метку, а размер у них почти всегда
// разный. Файла нет вовсе (хранилище ещё не создано) — отпечаток пустой.
function stampOf(file) {
  try { const st = fs.statSync(file); return st.mtimeMs + ':' + st.size; }
  catch (e) { return ''; }
}

function scan() {
  if (!dir) return;
  for (const topic of Object.keys(FILES)) {
    const now = stampOf(path.join(dir, FILES[topic]));
    // Первая сверка только запоминает: иначе каждый запуск панели начинался бы
    // с обновления «всего сразу» на ровном месте.
    if (stamps[topic] === undefined) { stamps[topic] = now; continue; }
    if (stamps[topic] !== now) { stamps[topic] = now; dirty.add(topic); }
  }
}

function write(client, chunk) {
  try { client.res.write(chunk); client.at = Date.now(); }
  catch (e) { drop(client); }
}

function drop(client) {
  if (!clients.delete(client)) return;
  try { client.res.end(); } catch (e) {}
  if (!clients.size) stop();
}

function tick() {
  scan();
  const changed = [...dirty];
  dirty.clear();
  for (const t of changed) rev[t]++;
  const now = Date.now();
  for (const client of [...clients]) {
    if (changed.some(t => client.topics.includes(t))) {
      write(client, 'data: ' + JSON.stringify(revisions(client.topics)) + '\n\n');
    } else if (now - client.at >= PING_MS) {
      // Комментарий SSE: браузер его игнорирует, а канал остаётся живым.
      write(client, ': ping\n\n');
    }
  }
}

function start() {
  if (timer) return;
  timer = setInterval(tick, POLL_MS);
  if (timer.unref) timer.unref();     // висящий канал не должен держать процесс
}
function stop() {
  if (!timer) return;
  clearInterval(timer); timer = null;
}

/* Подписать вкладку. `wanted` — список тем из адреса запроса; неизвестные слова
 * отбрасываются, пустой список означает «все».
 *
 * Первое сообщение — текущие номера версий: браузер запоминает их как отсчётную
 * точку и НЕ перерисовывается (страницу он только что получил свежей). Оно же
 * ловит изменения, случившиеся, пока канал был оборван: после переподключения
 * номера окажутся другими, и вкладка догонит пропущенное сама.
 */
function subscribe(req, res, wanted) {
  const topics = String(wanted || '').split(/[\s,]+/).filter(t => TOPICS.includes(t));
  const client = { res, topics: topics.length ? topics : TOPICS.slice(), at: Date.now() };

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    // no-transform обязателен: сжимающий прокси накопил бы поток в буфере, и
    // «живое обновление» приходило бы пачками через минуту.
    'Cache-Control': 'private, no-cache, no-store, no-transform',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no'
  });
  if (req.socket && req.socket.setNoDelay) req.socket.setNoDelay(true);

  clients.add(client);
  while (clients.size > MAX_CLIENTS) drop(clients.values().next().value);
  /* Сверка файлов до первой рассылки: у самой первой подписки она только
   * запоминает отпечатки, иначе вкладка получила бы «изменилось всё» через
   * секунду после открытия страницы.
   *
   * Накопленные изменения при этом НЕ сбрасываются: их ждёт соседняя вкладка,
   * открытая раньше, и глотать чужое обновление ради своего первого сообщения
   * нельзя. */
  scan();
  start();

  write(client, 'retry: 4000\n\n');
  write(client, 'data: ' + JSON.stringify(revisions(client.topics)) + '\n\n');

  const bye = () => drop(client);
  res.on('close', bye);
  res.on('error', bye);
}

module.exports = { TOPICS, POLL_MS, watch, bump, subscribe, revisions, clientCount: () => clients.size };
