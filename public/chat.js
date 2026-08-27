'use strict';
/* ==================== Онлайн-чат витрины: окно и живой канал ====================
 *
 * Кнопку в углу и каркас окна рисует СЕРВЕР (`chatWidget()` в lib/render.js) —
 * скрипт создаёт только сами реплики, как это делает корзина. Причина простая:
 * кнопка обязана быть на месте вместе со страницей, а не появляться через
 * полсекунды после загрузки скрипта, дёргая угол экрана.
 *
 * ЧТО ЗДЕСЬ ГЛАВНОЕ — СКОРОСТЬ ПЕРВОГО ОТВЕТА. Покупатель, задавший вопрос,
 * ждёт молча, и каждая секунда этого молчания — шанс, что он закроет вкладку.
 * Поэтому:
 *   - окно открывается мгновенно и с приветствием, которое уже лежит в
 *     разметке: за ним никуда не ходят;
 *   - его вопрос уходит одним коротким POST, который НЕ ждёт модель;
 *   - ответ приходит по живому каналу кусками, ровно так, как его печатает ИИ.
 *
 * ПОЧЕМУ КАНАЛ, А НЕ ОПРОС. Ответ оператора приходит когда угодно — через
 * десять секунд или через десять минут; опрос раз в три секунды означал бы
 * либо задержку, либо тысячу пустых запросов на каждого посетителя. Опрос
 * остаётся запасным путём — на случай прокси, который не пропускает поток.
 *
 * РАЗМЕТКУ ДАННЫХ СТРОИМ УЗЛАМИ, А НЕ СТРОКОЙ. В ленту попадает текст, который
 * написал посторонний человек (и текст, который сочинила модель по его
 * просьбе). Ни одна из этих строк не должна иметь возможности стать разметкой,
 * поэтому здесь нет ни одного `innerHTML` с данными — только `textContent` и
 * `createElement`.
 */
(function () {
  var root = document.getElementById('chat-widget');
  if (!root) return;

  var panel = document.getElementById('chat-panel');
  var list = document.getElementById('chat-log');
  var form = document.getElementById('chat-form');
  var input = document.getElementById('chat-input');
  var badge = document.getElementById('chat-badge');
  var button = document.getElementById('chat-open');
  var sendBtn = form && form.querySelector('button[type="submit"]');
  var fileInput = document.getElementById('chat-file');
  var picksBox = document.getElementById('chat-picks');
  if (!panel || !list || !form || !input) return;

  var STORE = 'chat_v1';
  var state = {
    id: '',
    mode: 'ai',
    open: false,
    started: false,      // диалог уже заведён на сервере
    stream: null,        // EventSource
    streamTimer: null,   // канал обязан прислать ready; иначе прокси его буферизует
    sid: '',             // номер своего канала: по нему сервер не шлёт нам эхо своей же реплики
    pollTimer: null,     // запасной опрос, когда канал не открылся
    pollBusy: false,     // медленный Tor-запрос не должен обрастать параллельными опросами
    pollGeneration: 0,  // ответ остановленного опроса не вмешивается в живой канал
    opening: null,       // один /open на все быстрые show/send/call
    since: 0,            // время последней показанной реплики (для опроса)
    typing: null,        // узел «печатает…»
    live: null,          // узел ответа ИИ, который печатается прямо сейчас
    unread: 0,
    sending: false,
    echo: null,          // своя последняя реплика: по ней узнаётся эхо с сервера
    day: '',             // последний показанный разделитель дат
    mine: [],            // свои реплики и их галочки
    got: 0,              // докуда магазин получил свои реплики
    read: 0,             // докуда прочитал
    files: [],           // выбранные снимки: прикреплены, но ещё не отправлены
    blobs: []            // их локальные адреса — освобождаем, когда лента перерисована
  };
  // Предел приходит от сервера: своя копия числа разошлась бы с ним и обещала
  // покупателю то, что маршрут потом отрежет молча.
  var MAX_SHOTS = Math.max(1, Number(root.getAttribute('data-max-photos')) || 3);
  // Тот же предел, что у разбора multipart на сервере (`MAX_FILE`). Проверка
  // здесь — вежливость: сказать сразу, а не после долгой загрузки впустую.
  var MAX_SHOT_BYTES = 6 * 1024 * 1024;

  /* --------------------------------- Память --------------------------------- */

  function remember() {
    try {
      localStorage.setItem(STORE, JSON.stringify({ started: state.started, at: Date.now() }));
    } catch (e) { /* приватный режим — переживём, диалог хранит сервер */ }
  }
  function recall() {
    try {
      var raw = JSON.parse(localStorage.getItem(STORE) || 'null');
      // Неделю спустя разговор уже не продолжают: канал в фоне держать незачем.
      if (raw && raw.started && Date.now() - Number(raw.at || 0) < 7 * 24 * 3600 * 1000) return true;
    } catch (e) {}
    return false;
  }

  /* --------------------------------- Реплики --------------------------------- */

  // Ссылки на карточки товаров ИИ пишет адресом (/product/id) — превращаем их в
  // настоящие ссылки. Всё остальное остаётся текстом: узлы создаются вручную,
  // поэтому чужая строка разметкой стать не может в принципе.
  var LINK = /(https?:\/\/[^\s<>"]+|\/(?:product|checkout|warranty|returns|privacy)[^\s<>",;]*)/g;

  function fillText(node, text) {
    var rest = String(text == null ? '' : text);
    var at = 0;
    var m;
    LINK.lastIndex = 0;
    while ((m = LINK.exec(rest))) {
      if (m.index > at) node.appendChild(document.createTextNode(rest.slice(at, m.index)));
      /* Знаки препинания в конец ссылки не забираем. Модель пишет адрес внутри
       * предложения («смотрите здесь: /product/iphone-17-pro-max.»), и точка,
       * попавшая в href, превращает живую ссылку в 404 — то есть ровно в тот
       * тупик, ради обхода которого ссылку и дают. */
      var href = m[0].replace(/[.,;:!?)»"']+$/, '');
      if (!href) { at = m.index; break; }
      var a = document.createElement('a');
      a.href = href;
      a.textContent = href;
      // Внешние ссылки открываем в новой вкладке, свои — в этой же: увести
      // покупателя с витрины по своей же ссылке было бы странно.
      if (href.charAt(0) !== '/') { a.target = '_blank'; a.rel = 'noopener noreferrer'; }
      node.appendChild(a);
      // Отрезанная пунктуация остаётся обычным текстом сразу за ссылкой.
      at = m.index + href.length;
    }
    if (at < rest.length) node.appendChild(document.createTextNode(rest.slice(at)));
  }

  /* Снимки в реплике.
   *
   * Разметка — ТОТ ЖЕ ДОГОВОР, что у вложений отзыва: группа с `data-media`,
   * внутри ссылки с `data-kind="photo"`. По ним работает общий просмотрщик
   * (`public/media-lightbox.js`), который витрина и так грузит на каждой
   * странице, — своего окна просмотра здесь заводить не пришлось, и открывается
   * снимок ровно так же, как в отзывах.
   *
   * Ссылки настоящие: без скрипта клик просто откроет файл, как и в отзывах.
   */
  function photoGrid(photos, local) {
    var box = document.createElement('span');
    box.className = 'chat-shots is-' + Math.min(photos.length, 3);
    box.setAttribute('data-media', '');
    for (var i = 0; i < photos.length; i++) {
      var src = String(photos[i] || '');
      /* Адрес уезжает в `href` как есть, поэтому берём только два вида: свою
       * загрузку с сервера и `blob:` собственной реплики, который мы сами же и
       * создали строкой выше. Чужая схема в ссылке ведёт неизвестно куда, и
       * пришла бы она из ответа сервера — то есть из места, которому в этом
       * файле не верят и в остальном. */
      if (src.indexOf('/uploads/') !== 0 && !(local && src.indexOf('blob:') === 0)) continue;
      var link = document.createElement('a');
      link.className = 'chat-shot';
      link.href = src;
      link.setAttribute('data-kind', 'photo');
      link.setAttribute('aria-label', 'Открыть фото ' + (i + 1));
      var img = document.createElement('img');
      img.src = src;
      img.alt = '';
      img.loading = 'lazy';
      // Размеры обязательны: без них лента прыгает по мере загрузки снимков —
      // та же грабля, что у миниатюр отзывов.
      img.width = 200; img.height = 200;
      link.appendChild(img);
      box.appendChild(link);
    }
    return box;
  }

  function bubble(role, text, by, at, photos, local) {
    var row = document.createElement('div');
    row.className = 'chat-msg chat-' + (role === 'user' ? 'me' : role === 'system' ? 'sys' : 'them');
    if (role === 'system') {
      row.textContent = text;
      return row;
    }
    /* Имя приходит от сервера готовым (`by`). Своей таблицы имён здесь нет
     * намеренно: она лежит в lib/chat.js одним списком, и копия в браузере
     * разъехалась бы с ней на первой правке — под одной и той же репликой
     * покупатель видел бы одно имя, а панель другое. */
    if ((role === 'operator' || role === 'ai') && by) {
      var who = document.createElement('span');
      who.className = 'chat-who';
      who.textContent = by;
      row.appendChild(who);
    }
    /* Снимки идут ПЕРЕД текстом — как в любом мессенджере: подпись относится к
     * картинке, а не наоборот. Реплика бывает и вовсе без слов, поэтому пустой
     * пузырь текста в неё не добавляется. */
    if (photos && photos.length) row.appendChild(photoGrid(photos, local));
    if (text) {
      var body = document.createElement('span');
      body.className = 'chat-text';
      fillText(body, text);
      row.appendChild(body);
    }
    /* Время внутри пузыря справа внизу — как в любом мессенджере. Покупатель
     * возвращается в чат через час и через день, и без времени непонятно,
     * ответили ему только что или вчера вечером. У растущей реплики времени
     * ещё нет: оно приедет вместе с готовой (событие `done`). */
    if (at) row.appendChild(stampNode(at));
    // Галочка стоит только у своих реплик: у чужих отвечать ею не на что.
    if (role === 'user') row.appendChild(tickNode());
    return row;
  }

  function stampNode(at) {
    var stamp = document.createElement('span');
    stamp.className = 'chat-at';
    stamp.textContent = clock(at);
    return stamp;
  }

  /* ---------------------------------- Галочки ----------------------------------
   *
   * Часы — уходит, одна галочка — отправлено, две — дошло до магазина, две
   * цветные — прочитано. Язык знакомый по любому мессенджеру, объяснять его не
   * приходится, а отвечает он на единственный вопрос написавшего: увидели или
   * нет.
   *
   * САМУ ФИГУРУ РИСУЕТ СЕРВЕР — она лежит спрайтом в разметке виджета
   * (`CHAT_TICK_SPRITE` в lib/render.js), потому что та же галочка нужна
   * менеджеру в панели. Здесь только ссылка `<use>` на нужный символ: своя копия
   * путей разъехалась бы с панельной, а увидеть это можно было бы лишь глазами.
   *
   * Состояние считается по времени реплики и двум отметкам, пришедшим от
   * сервера. Своего представления о доставке у браузера быть не может: он знает
   * только то, что его запрос ушёл. */
  var SVG = 'http://www.w3.org/2000/svg';
  var TICKS = { wait: ['wait', 'отправляется'], sent: ['one', 'отправлено'],
    got: ['two', 'доставлено'], read: ['two', 'прочитано'] };

  function tickNode() {
    var box = document.createElement('span');
    box.className = 'chat-tick';
    box.setAttribute('role', 'img');
    var svg = document.createElementNS(SVG, 'svg');
    svg.setAttribute('viewBox', '0 0 18 12');
    svg.setAttribute('aria-hidden', 'true');
    svg.appendChild(document.createElementNS(SVG, 'use'));
    box.appendChild(svg);
    return box;
  }

  // Своя реплика и её галочка. `at` серверное — по нему считаются отметки; у
  // только что отправленной его ещё нет, и она висит часами.
  function mine(row, at) {
    var box = row.querySelector('.chat-tick');
    if (!box) return null;
    var rec = { row: row, box: box, at: Number(at) || 0, kind: '' };
    state.mine.push(rec);
    // Лента за долгий разговор растёт, а отметки нужны только последним
    // репликам: перебирать сотню узлов на каждое событие незачем.
    if (state.mine.length > 120) state.mine.splice(0, state.mine.length - 120);
    setTick(rec);
    return rec;
  }

  function mineOf(row) {
    for (var i = state.mine.length - 1; i >= 0; i--) if (state.mine[i].row === row) return state.mine[i];
    return null;
  }

  function setTick(rec) {
    var kind = !rec.at ? 'wait'
      : rec.at <= state.read ? 'read'
      : rec.at <= state.got ? 'got' : 'sent';
    if (rec.kind === kind) return;
    rec.kind = kind;
    rec.box.className = 'chat-tick is-' + kind;
    rec.box.setAttribute('aria-label', TICKS[kind][1]);
    rec.box.querySelector('use').setAttribute('href', '#ct-' + TICKS[kind][0]);
  }

  function paintTicks() {
    for (var i = 0; i < state.mine.length; i++) setTick(state.mine[i]);
  }

  // Отметки только растут: поздний ответ на старый запрос не должен отматывать
  // галочки назад.
  function applyReceipt(r) {
    if (!r) return;
    var got = Math.max(state.got, Number(r.got) || 0);
    var read = Math.max(state.read, Number(r.read) || 0);
    if (got === state.got && read === state.read) return;
    state.got = got;
    state.read = read;
    paintTicks();
  }

  function two(n) { return n < 10 ? '0' + n : String(n); }

  /* ВРЕМЯ В ЧАТЕ — МОСКОВСКОЕ, а не по часам покупателя.
   *
   * Магазин работает по Москве: «отправим сегодня» в переписке означает
   * московский день, и менеджер в панели видит ту же подпись. Показывай мы
   * местное время, покупатель из Красноярска и менеджер обсуждали бы одно и
   * то же сообщение под подписями, разошедшимися на четыре часа.
   *
   * Зону берём у браузера (Intl с timeZone), а если он её не знает — считаем
   * постоянное смещение +3: у Москвы оно неизменно с 2014 года. Без запасного
   * пути такой браузер молча показывал бы UTC.
   */
  var MSK_OFFSET = 180;
  var mskFormat = (function () {
    try {
      var fmt = new Intl.DateTimeFormat('en-GB', {
        timeZone: 'Europe/Moscow', hour12: false,
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit'
      });
      // Проверка на заведомо известной точке: 1 января 2021 года в Москве 03:00.
      var probe = {};
      fmt.formatToParts(new Date(Date.UTC(2021, 0, 1, 0, 0))).forEach(function (p) { probe[p.type] = p.value; });
      return Number(probe.hour) % 24 === 3 ? fmt : null;
    } catch (e) { return null; }
  })();

  // Дата, у которой локальные геттеры дают московское время.
  function msk(ms) {
    var d = new Date(Number(ms) || 0);
    if (!mskFormat) return new Date(d.getTime() + (MSK_OFFSET + d.getTimezoneOffset()) * 60000);
    var parts = {};
    mskFormat.formatToParts(d).forEach(function (p) { parts[p.type] = p.value; });
    return new Date(Number(parts.year), Number(parts.month) - 1, Number(parts.day),
      Number(parts.hour) % 24, Number(parts.minute));
  }

  function clock(ms) {
    var d = msk(ms);
    return two(d.getHours()) + ':' + two(d.getMinutes());
  }

  var MONTHS = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня',
    'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];

  function sameDay(a, b) {
    return a.getDate() === b.getDate() && a.getMonth() === b.getMonth() && a.getFullYear() === b.getFullYear();
  }

  /* Подпись разделителя дат: «Сегодня», «Вчера», «25 августа» — тоже по Москве.
   * «Сегодня» обязано означать тот же день, что у менеджера в панели: иначе
   * покупатель из Владивостока видел бы «Вчера» там, где магазин отвечал
   * сегодня. */
  function dayLabel(ms) {
    var d = msk(ms);
    var now = msk(Date.now());
    if (sameDay(d, now)) return 'Сегодня';
    var yesterday = msk(Date.now());
    yesterday.setDate(yesterday.getDate() - 1);
    if (sameDay(d, yesterday)) return 'Вчера';
    var label = d.getDate() + ' ' + MONTHS[d.getMonth()];
    return d.getFullYear() === now.getFullYear() ? label : label + ' ' + d.getFullYear();
  }

  /* Разделитель дат ставится перед репликой, если она из другого дня, чем
   * предыдущая. Помним последний показанный день, а не пересчитываем ленту
   * заново: реплики приходят по одной, и перебор всего списка на каждую был бы
   * работой на пустом месте. */
  function dayDivider(at) {
    if (!at) return;
    var label = dayLabel(at);
    if (label === state.day) return;
    state.day = label;
    var row = document.createElement('div');
    row.className = 'chat-day';
    var span = document.createElement('span');
    span.textContent = label;
    row.appendChild(span);
    list.appendChild(row);
  }

  function append(message) {
    // Реплика без слов законна, когда в ней есть снимок.
    if (!message || (!message.text && !(message.photos && message.photos.length))) return;
    if (message.at && message.at <= state.since) return;    // уже показано
    /* Страховка от собственного эха на ПЕРВОМ сообщении.
     *
     * Обычно эхо отсекает сервер по номеру канала, но номер приезжает в
     * событии `ready`, а канал открывается уже после того, как покупатель
     * нажал «отправить»: первое сообщение уходит, когда номера ещё нет, и
     * возвращается дублем. Поэтому свою последнюю реплику узнаём и по тексту.
     *
     * Два одинаковых сообщения подряд («да», «да») от этого не теряются: оба
     * нарисованы здесь локально в момент отправки, подавляется только эхо. */
    if (message.role === 'user' && state.echo && message.text === state.echo.text
      && (message.photos ? message.photos.length : 0) === state.echo.shots
      && Date.now() - state.echo.at < 15000) {
      state.echo = null;
      if (message.at) state.since = message.at;
      return;
    }
    if (message.at) state.since = message.at;
    hideTyping();
    /* Для ПОКАЗА времени годится и локальное «сейчас»: своя реплика рисуется
     * до ответа сервера, и висеть без времени, пока идёт сеть, она не должна.
     * А вот `state.since` двигает только серверное `at` — он уезжает обратно
     * на сервер курсором, и часы браузера в нём означали бы пропущенные
     * ответы. */
    var stamp = message.at || Date.now();
    dayDivider(stamp);
    var row = bubble(message.role, message.text, message.by, stamp, message.photos, message.local);
    if (message.role === 'user') mine(row, message.at);
    list.appendChild(row);
    scroll();
    if (message.role !== 'user') { if (state.open) seen(); else bumpUnread(); }
    return row;
  }

  // Лента прокручивается вниз только когда покупатель и так внизу: он мог
  // отлистать вверх, чтобы перечитать ответ, и дёргать страницу под ним нельзя.
  function scroll(force) {
    var near = list.scrollHeight - list.scrollTop - list.clientHeight < 120;
    if (force || near) list.scrollTop = list.scrollHeight;
  }

  function showTyping() {
    if (state.typing) return;
    var row = document.createElement('div');
    row.className = 'chat-msg chat-them chat-typing';
    row.setAttribute('aria-label', 'Печатает ответ');
    for (var i = 0; i < 3; i++) row.appendChild(document.createElement('i'));
    list.appendChild(row);
    state.typing = row;
    scroll();
  }
  function hideTyping() {
    if (!state.typing) return;
    if (state.typing.parentNode) state.typing.parentNode.removeChild(state.typing);
    state.typing = null;
  }

  /* Ответ ИИ печатается прямо в ленту: приходит кусок текста — дописываем его в
   * ту же реплику. Именно это превращает ожидание в чтение. */
  function delta(piece) {
    hideTyping();
    if (!state.live) {
      /* Имя для растущей реплики берём из разметки: сама реплика приедет
       * подписанной только в конце (событие `done`), а подпись нужна с первого
       * же слова — иначе ответ полминуты висит безымянным, а потом имя
       * появляется рывком. Это по-прежнему значение от сервера, а не своя
       * копия списка имён в скрипте. */
      dayDivider(Date.now());
      state.live = bubble('ai', '', root.getAttribute('data-ai-name') || '');
      list.appendChild(state.live);
    }
    var body = state.live.querySelector('.chat-text');
    if (!body) return;
    // Пока текст растёт, ссылки не собираем: они всё равно приезжают по частям.
    // Готовую реплику перерисуем целиком в `endDelta()`.
    body.textContent += piece;
    scroll();
  }
  function endDelta(message) {
    // «Печатает…» гасим в любом случае: ответ мог закончиться и ничем — например,
    // оператор вошёл в разговор прямо посреди генерации.
    hideTyping();
    if (!state.live) { if (message && message.text) append(message); return; }
    var body = state.live.querySelector('.chat-text');
    if (body && message && message.text) {
      body.textContent = '';
      fillText(body, message.text);
    }
    if (message && message.at) state.since = message.at;
    /* Время ставим в конце: пока ответ печатался, его в пузыре не было — у
     * растущей реплики его ещё нет ни у сервера, ни у нас. Локальное «сейчас»
     * годится и здесь: расхождение с серверным — доли секунды, а показанная
     * минута от этого не меняется. */
    if (!state.live.querySelector('.chat-at')) {
      state.live.appendChild(stampNode((message && message.at) || Date.now()));
    }
    state.live = null;
    if (state.open) seen(); else bumpUnread();
    scroll();
  }

  /* ------------------------------- Непрочитанное ------------------------------- */

  /* Сигнал звучит РОВНО ЗДЕСЬ — в единственном месте, куда сходятся оба пути
   * входящей реплики: и обычный `append`, и дописанный ответ ИИ (`endDelta`).
   * А сходятся они здесь именно потому, что сюда попадает только то, что пришло
   * в ЗАКРЫТОЕ окно: с открытым вызывается `seen()`, и звук там не нужен —
   * покупатель и так смотрит на ленту, а звенеть ему в ухо на каждое слово
   * консультанта незачем.
   *
   * Своего условия «окно закрыто» тут нет и быть не должно: второе такое
   * условие рано или поздно разошлось бы с этим. */
  function sound(name) {
    if (window.ChatSound) window.ChatSound.play(name);
  }
  function bumpUnread() {
    state.unread++;
    paintBadge();
    sound('in');
  }
  function paintBadge() {
    if (!badge) return;
    badge.textContent = state.unread > 9 ? '9+' : String(state.unread);
    badge.hidden = !state.unread;
    if (button) {
      button.setAttribute('aria-label', state.unread ? 'Чат с магазином, новых сообщений: ' + state.unread : 'Чат с магазином');
    }
  }
  function clearUnread() {
    if (!state.unread) return;
    state.unread = 0;
    paintBadge();
    if (state.id) post('/api/chat/read', {});
  }

  /* Реплика пришла в ОТКРЫТОЕ окно — покупатель её видит, и менеджеру об этом
   * надо сказать: у его реплики в панели от этого синеют галочки. Значок
   * непрочитанного тут ни при чём — он и не зажигался, — поэтому `clearUnread`
   * этот случай не покрывает вовсе.
   *
   * Запрос откладываем: реплики приходят по одной, а ответ ИИ ещё и
   * заканчивается отдельным событием — иначе на один ход разговора уходило бы
   * три одинаковых POST. */
  var seenTimer = null;
  function seen() {
    if (!state.started || seenTimer) return;
    seenTimer = setTimeout(function () {
      seenTimer = null;
      if (state.open) post('/api/chat/read', {});
    }, 900);
  }

  /* --------------------------------- Состояние -------------------------------- */

  /* Режим нужен скрипту (ждать ли ответа консультанта), но покупателю о нём не
   * говорят ничего: подпись в шапке — всегда «online», и она лежит в разметке.
   * Раньше здесь менялся текст на «Отвечает менеджер» — то есть покупателю
   * сообщали, что до этого отвечал не человек. */
  function setMode(mode) {
    state.mode = mode || 'ai';
    root.setAttribute('data-mode', state.mode);
  }

  /* ---------------------------------- Запросы ---------------------------------- */

  function post(url, data) {
    return fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify(data || {})
    }).then(function (r) { return r.json().catch(function () { return { ok: false }; }); })
      .catch(function () { return { ok: false, error: 'network' }; });
  }

  /* Та же отправка, но со снимками: multipart вместо JSON.
   *
   * Заголовок Content-Type НЕ ставим руками — его обязан выставить браузер
   * вместе с границей частей. Составные значения (корзина) уезжают строкой
   * JSON: полей-массивов в multipart не бывает, и сервер разбирает эту строку
   * обратно (`chatCart` в server.js).
   */
  function postFiles(url, data, files) {
    var body = new FormData();
    Object.keys(data || {}).forEach(function (key) {
      var value = data[key];
      if (value === undefined || value === null) return;
      body.append(key, typeof value === 'object' ? JSON.stringify(value) : String(value));
    });
    for (var i = 0; i < files.length; i++) body.append('photos', files[i]);
    return fetch(url, { method: 'POST', credentials: 'same-origin', body: body })
      .then(function (r) { return r.json().catch(function () { return { ok: false }; }); })
      .catch(function () { return { ok: false, error: 'network' }; });
  }

  // Где стоит покупатель и что у него в корзине — это уезжает с каждым
  // сообщением, потому что за разговор он успевает уйти на другую страницу, и
  // «а 512 есть?» через пять реплик означает уже другой товар.
  function place() {
    var cart = [];
    try {
      var raw = JSON.parse(localStorage.getItem('cart_v1') || '[]');
      if (Array.isArray(raw)) {
        cart = raw.slice(0, 20).map(function (it) {
          return { name: String(it && it.name || '').slice(0, 120), qty: Number(it && it.qty) || 1 };
        });
      }
    } catch (e) {}
    return { path: location.pathname, cart: cart };
  }

  function open() {
    if (state.started) return Promise.resolve(true);
    if (state.opening) return state.opening;
    var body = place();
    var request = post('/api/chat/open', body).then(function (d) {
      if (!d || !d.ok) return false;
      state.id = d.id || '';
      state.started = true;
      setMode(d.mode);
      applyReceipt(d.receipt);
      // Сервер отдаёт всю переписку: покупатель мог начать разговор на другой
      // странице или вчера — окно обязано открыться там же, где он его оставил.
      (Array.isArray(d.messages) ? d.messages : []).forEach(append);
      remember();
      connect();
      return true;
    });
    // `post()` сам превращает сетевую ошибку в `{ ok:false }`, но второй
    // обработчик оставляет single-flight исправным и при неожиданной ошибке в
    // данных/DOM: следующий клик сможет повторить открытие.
    state.opening = request.then(function (ok) {
      state.opening = null;
      return ok;
    }, function () {
      state.opening = null;
      return false;
    });
    return state.opening;
  }

  /* --------------------------------- Живой канал -------------------------------- */

  var STREAM_GRACE = 10000;

  function clearStreamWatch() {
    if (state.streamTimer) clearTimeout(state.streamTimer);
    state.streamTimer = null;
  }

  function stopPolling() {
    if (state.pollTimer) clearInterval(state.pollTimer);
    state.pollTimer = null;
    state.pollBusy = false;
    state.pollGeneration++;
  }

  function fallbackFrom(src) {
    if (state.stream !== src) return;
    clearStreamWatch();
    try { src.close(); } catch (e) {}
    state.stream = null;
    startPolling();
  }

  function watchStream(src) {
    clearStreamWatch();
    state.streamTimer = setTimeout(function () {
      // CONNECTING может висеть бесконечно у прокси, который принял HTTP-запрос,
      // но буферизует поток. `readyState === CLOSED` в таком сценарии не бывает.
      fallbackFrom(src);
    }, STREAM_GRACE);
  }

  function connect() {
    if (state.stream || !state.started) return;
    if (typeof EventSource === 'undefined') return startPolling();
    var src = new EventSource('/api/chat/stream', { withCredentials: true });
    state.stream = src;
    watchStream(src);

    /* Номер канала запоминаем и шлём с каждым сообщением. Без него сервер
     * рассылает нашу же реплику всем вкладкам, включая эту, — а она нарисована
     * здесь ещё в момент нажатия «отправить» (ждать сети нельзя: пауза после
     * своего сообщения читается как сбой). Ровно так вопрос покупателя и
     * показывался в окне дважды. */
    src.addEventListener('ready', function (e) {
      if (state.stream !== src) return;
      clearStreamWatch();
      stopPolling();
      var d = parse(e.data);
      if (d && d.sid) state.sid = d.sid;
      if (d && d.mode) setMode(d.mode);
    });
    src.addEventListener('message', function (e) { append(parse(e.data)); });
    src.addEventListener('delta', function (e) {
      var d = parse(e.data);
      if (d && typeof d.text === 'string') delta(d.text);
    });
    src.addEventListener('done', function (e) { endDelta(parse(e.data)); });
    src.addEventListener('typing', function () { showTyping(); });
    /* Галочки меняются и без новых реплик — менеджер просто открыл диалог,
     * поэтому у них своё событие, а не поле у сообщения. */
    src.addEventListener('receipt', function (e) { applyReceipt(parse(e.data)); });
    src.addEventListener('mode', function (e) {
      var d = parse(e.data);
      if (d && d.mode) setMode(d.mode);
    });
    src.addEventListener('error', function () {
      // EventSource переподключается сам, и обрыв на секунду — обычное дело.
      // Даём ему время на штатное переподключение, но не бесконечность: через
      // onion/proxy соединение нередко остаётся в CONNECTING и никогда не
      // становится CLOSED, поэтому одной проверки readyState было недостаточно.
      if (src.readyState === 2) fallbackFrom(src);
      else if (state.stream === src) watchStream(src);
    });
  }

  function parse(raw) {
    try { return JSON.parse(raw); } catch (e) { return null; }
  }

  function startPolling() {
    if (state.pollTimer || !state.started) return;
    state.pollGeneration++;
    state.pollTimer = setInterval(pollOnce, 3000);
    pollOnce();
  }

  function pollOnce() {
    if (state.pollBusy || !state.pollTimer || !state.started) return;
    var generation = state.pollGeneration;
    state.pollBusy = true;
    fetch('/api/chat/poll?since=' + encodeURIComponent(state.since), { credentials: 'same-origin' })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (generation !== state.pollGeneration || !d || !d.ok) return;
        if (d.mode) setMode(d.mode);
        applyReceipt(d.receipt);
        (Array.isArray(d.messages) ? d.messages : []).forEach(function (message) {
          // Если поток успел прислать части ответа перед обрывом, полный ответ
          // завершает тот же bubble, а не рисуется рядом вторым сообщением.
          if (state.live && message && message.role === 'ai') endDelta(message);
          else append(message);
        });
      }).catch(function () {})
      .then(function () {
        if (generation === state.pollGeneration) state.pollBusy = false;
      });
  }

  /* ------------------------------ Прикреплённые фото ------------------------------
   *
   * Выбранный снимок НЕ УЛЕТАЕТ сразу: он становится плиткой над полем ввода, и
   * до нажатия «отправить» его можно убрать или добавить к нему ещё один. Так
   * это устроено во всех мессенджерах, и по делу — снимок почти всегда идёт с
   * подписью, а промахнуться в выборе файла проще простого.
   *
   * Проверки здесь — вежливость, а не защита: тип файла решает сигнатура на
   * сервере, число — маршрут, размер — разбор multipart. Смысл их в том, чтобы
   * сказать «так не выйдет» сразу, а не после минуты загрузки впустую.
   */
  function pickShots(chosen) {
    var added = 0, tooMany = false, tooBig = false, notImage = false;
    for (var i = 0; i < chosen.length; i++) {
      var file = chosen[i];
      if (!file) continue;
      if (state.files.length >= MAX_SHOTS) { tooMany = true; break; }
      if (!/^image\//.test(file.type || '')) { notImage = true; continue; }
      if (file.size > MAX_SHOT_BYTES) { tooBig = true; continue; }
      state.files.push(file);
      added++;
    }
    if (notImage) note('Приложить можно только фотографии.');
    else if (tooBig) note('Один снимок — не больше 6 МБ.');
    else if (tooMany) note('К сообщению можно приложить не больше ' + MAX_SHOTS + ' фото.');
    if (added) renderPicks();
  }

  // Короткая строка о том, почему не вышло. Обычная системная реплика в ленте:
  // своего места для ошибок в окне нет, а это ровно то место, куда смотрят.
  function note(text) { append({ role: 'system', text: text }); }

  function renderPicks() {
    if (!picksBox) return;
    /* Полоса пересобирается на каждое добавление и удаление, и адреса прошлой
     * сборки надо освободить: без этого браузер держит в памяти по копии
     * снимка на каждое нажатие. Адреса уже ОТПРАВЛЕННЫХ реплик сюда не
     * попадают — они живут в ленте, пока живёт страница. */
    for (var b = 0; b < state.blobs.length; b++) URL.revokeObjectURL(state.blobs[b]);
    state.blobs = [];
    picksBox.textContent = '';
    picksBox.hidden = !state.files.length;
    for (var i = 0; i < state.files.length; i++) {
      var url = URL.createObjectURL(state.files[i]);
      state.blobs.push(url);
      var cell = document.createElement('span');
      cell.className = 'chat-pick';
      var img = document.createElement('img');
      img.src = url;
      img.alt = '';
      cell.appendChild(img);
      var x = document.createElement('button');
      x.type = 'button';
      x.className = 'chat-pick-x';
      x.setAttribute('data-pick', String(i));
      x.setAttribute('aria-label', 'Убрать фото ' + (i + 1));
      x.textContent = '×';
      cell.appendChild(x);
      picksBox.appendChild(cell);
    }
  }

  function clearPicks() {
    state.files = [];
    // Адреса самой полосы освобождаем, а адреса отправленной реплики — нет: по
    // ним показан снимок в ленте, пока не приедут настоящие.
    for (var b = 0; b < state.blobs.length; b++) URL.revokeObjectURL(state.blobs[b]);
    state.blobs = [];
    if (picksBox) { picksBox.textContent = ''; picksBox.hidden = true; }
    if (fileInput) fileInput.value = '';
  }

  if (fileInput) {
    fileInput.addEventListener('change', function () {
      pickShots(fileInput.files ? [].slice.call(fileInput.files) : []);
      /* Значение сбрасываем всегда: без этого повторный выбор ТОГО ЖЕ файла не
       * даёт события `change` вовсе — покупатель нажимает скрепку, выбирает тот
       * же снимок, и не происходит ничего. */
      fileInput.value = '';
    });
  }
  if (picksBox) {
    picksBox.addEventListener('click', function (e) {
      var x = e.target.closest && e.target.closest('[data-pick]');
      if (!x) return;
      state.files.splice(Number(x.getAttribute('data-pick')), 1);
      renderPicks();
    });
  }

  /* ---------------------------------- Отправка ---------------------------------- */

  function send(text) {
    var body = String(text || '').trim();
    var files = state.files.slice();
    // Реплика без слов законна, когда к ней приложен снимок.
    if ((!body && !files.length) || state.sending) return;
    state.sending = true;
    if (sendBtn) sendBtn.disabled = true;
    /* Своя реплика рисуется БЕЗ времени, и это важно: `state.since` уезжает на
     * сервер в запасном опросе и сравнивается там с временем сервера. Часы
     * браузера идут по-своему — спешащие на минуту заставили бы сервер считать
     * уже показанным всё, что он пришлёт следующую минуту, то есть покупатель
     * молча не получил бы ответа. Отметку двигают только серверные сообщения.
     *
     * Отметку «ждём эхо» ставим ПОСЛЕ отрисовки: поставленная до неё, она
     * подавляла бы саму эту реплику — сообщение покупателя не появлялось в
     * окне вовсе. */
    /* Снимки в своей реплике показываем СРАЗУ — по локальным `blob:`-адресам,
     * не дожидаясь загрузки на сервер: пауза в несколько секунд между «отправил»
     * и «увидел» читается как сбой. Настоящие адреса приедут вместе с эхом или
     * при следующем открытии окна, а до тех пор картинка уже в ленте. */
    var localShots = files.map(function (f) { return URL.createObjectURL(f); });
    var row = append({ role: 'user', text: body, photos: localShots, local: true });
    state.echo = { text: body, shots: files.length, at: Date.now() };
    input.value = '';
    clearPicks();
    resize();
    // Звук отправки — здесь, вместе с появлением пузыря: покупатель нажал, и
    // подтверждение должно прийти в тот же миг, а не через ответ сети. Ошибку,
    // если она случится, он увидит отдельной строкой в ленте.
    sound('out');

    var go = state.started ? Promise.resolve(true) : open();
    go.then(function (ok) {
      if (!ok) {
        state.sending = false;
        if (sendBtn) sendBtn.disabled = false;
        return append({ role: 'system', text: 'Не удалось отправить сообщение. Проверьте соединение.' });
      }
      var payload = place();
      payload.text = body;
      payload.sid = state.sid;
      // «Печатает…» показываем сразу, не дожидаясь ответа сервера: ждать здесь
      // нечего, а пустая пауза после своего сообщения читается как сбой.
      if (state.mode === 'ai') showTyping();
      var request = files.length
        ? postFiles('/api/chat/send', payload, files)
        : post('/api/chat/send', payload);
      return request.then(function (d) {
        state.sending = false;
        if (sendBtn) sendBtn.disabled = false;
        if (!d || !d.ok) {
          hideTyping();
          append({ role: 'system', text: (d && d.error) || 'Сообщение не отправлено. Попробуйте ещё раз.' });
          return;
        }
        if (d.mode) setMode(d.mode);
        /* Реплика сохранена — у неё появляется первая галочка. Время берём
         * серверное: по нему считаются и «доставлено», и «прочитано», а часы
         * браузера идут по-своему. */
        var rec = row && mineOf(row);
        if (rec && d.at) { rec.at = Number(d.at) || 0; setTick(rec); }
        applyReceipt(d.receipt);
        // Ответ ИИ не ждём — он приедет по каналу. Но если канала нет (запасной
        // опрос), сервер вернёт готовый ответ прямо здесь.
        if (d.reply) append(d.reply);
        else if (state.mode !== 'ai') hideTyping();
      });
    });
  }

  form.addEventListener('submit', function (e) {
    e.preventDefault();
    send(input.value);
  });

  // Enter отправляет, Shift+Enter переносит строку — как во всех мессенджерах.
  // На телефоне поле остаётся многострочным и Enter там обычный: экранная
  // клавиатура в этом случае показывает перевод строки, а не отправку.
  input.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && !e.shiftKey && !matchMedia('(pointer:coarse)').matches) {
      e.preventDefault();
      send(input.value);
    }
  });

  // Поле растёт под текст до трёх строк: длинный вопрос набирают вслепую, когда
  // видно только последнюю строку.
  function resize() {
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 96) + 'px';
  }
  input.addEventListener('input', resize);

  /* ------------------------------ Открыть / закрыть ------------------------------ */

  /* ОКНО И ЭКРАННАЯ КЛАВИАТУРА.
   *
   * На телефоне окно занимает экран целиком (`position:fixed; inset:0`), и с
   * этим связана беда, которую видно только на живом телефоне: открывая
   * клавиатуру, Safari и Chrome НЕ уменьшают окно, а сдвигают видимую область
   * вверх. Фиксированная панель остаётся на месте по документу, поэтому её
   * шапка — имя магазина, «online» и крестик — уезжает за верхний край экрана,
   * и закрыть чат становится нечем.
   *
   * Лечится единственным честным способом: спросить у браузера, какую часть
   * экрана он сейчас показывает (`visualViewport`), и посадить панель ровно в
   * неё. Медиазапросами этого не сделать — они про размер окна, а не про
   * видимую его часть.
   */
  function narrow() { return matchMedia('(max-width:560px)').matches; }

  function fitViewport() {
    var vv = window.visualViewport;
    if (!vv || !state.open || !narrow()) return resetViewport();
    var keyboard = window.innerHeight - vv.height > 80;
    /* Видимая область бывает сдвинута и без клавиатуры — щипком. Масштаб мы
       гасим (мета-тег плюс `public/mobile-shell.js`), но щипок мог случиться до
       загрузки скрипта или в браузере, который его не отдаёт, — и тогда окно
       чата стоит шире экрана и по краям торчит витрина. Проверяем, а не верим:
       у `position:fixed` координаты считаются от layout viewport, и никакой CSS
       про эту разницу не знает. */
    var shifted = Math.abs(vv.offsetLeft) > 1 || Math.abs(vv.offsetTop) > 1;
    var zoomed = Math.abs((vv.scale || 1) - 1) > 0.01;
    // Всё на своих местах — не трогаем ничего: лишний inline-стиль перебил бы
    // анимацию открытия и обычную раскладку.
    if (!keyboard && !shifted && !zoomed) return resetViewport();
    panel.style.width = vv.width + 'px';
    panel.style.height = vv.height + 'px';
    // Сдвиг именно transform, а не top/left: он идёт в композиторе и не
    // заставляет пересчитывать раскладку на каждый кадр выезжающей клавиатуры.
    panel.style.transform = 'translate(' + vv.offsetLeft + 'px,' + vv.offsetTop + 'px)';
    scroll(true);
  }

  function resetViewport() {
    if (!panel.style.height && !panel.style.transform && !panel.style.width) return;
    panel.style.removeProperty('width');
    panel.style.removeProperty('height');
    panel.style.removeProperty('transform');
  }

  if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', fitViewport);
    window.visualViewport.addEventListener('scroll', fitViewport);
  }

  function show() {
    state.open = true;
    root.classList.add('is-open');
    panel.removeAttribute('inert');
    panel.setAttribute('aria-hidden', 'false');
    if (button) button.setAttribute('aria-expanded', 'true');
    // Страница под открытым окном прокручиваться не должна: на телефоне палец
    // легко попадает мимо ленты, и вместо переписки уезжает витрина.
    if (narrow()) document.body.classList.add('chat-locked');
    clearUnread();
    open();
    scroll(true);
    // Фокус в поле ставим только на большом экране: на телефоне он поднимает
    // клавиатуру поверх только что открытого окна, и покупатель видит вместо
    // приветствия одну строку ввода.
    if (!matchMedia('(pointer:coarse)').matches) setTimeout(function () { input.focus(); }, 60);
  }

  function hide() {
    state.open = false;
    root.classList.remove('is-open');
    panel.setAttribute('inert', '');
    panel.setAttribute('aria-hidden', 'true');
    document.body.classList.remove('chat-locked');
    resetViewport();
    if (button) { button.setAttribute('aria-expanded', 'false'); button.focus(); }
  }

  /* Клавиатура выезжает уже ПОСЛЕ того, как фокус встал в поле, и `resize`
   * визуальной области приходит с задержкой в пару кадров. Поэтому подгоняем
   * панель ещё и по фокусу — иначе первый кадр покупатель видит съехавшую
   * шапку, и именно он запоминается. */
  input.addEventListener('focus', function () { setTimeout(fitViewport, 120); });
  input.addEventListener('blur', function () { setTimeout(fitViewport, 120); });

  if (button) button.addEventListener('click', function () { state.open ? hide() : show(); });
  root.addEventListener('click', function (e) {
    var act = e.target.closest && e.target.closest('[data-chat-act]');
    if (!act) return;
    var name = act.getAttribute('data-chat-act');
    if (name === 'close') { e.preventDefault(); hide(); }
  });

  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && state.open) hide();
  });

  /* Диалог уже начат в прошлый заход — подключаем канал сразу, не открывая
   * окно: менеджер мог ответить, пока покупатель ходил по каталогу, и об этом
   * должен сказать значок на кнопке. Ради одной кнопки в углу канал при этом
   * не открывается никогда: разговор ведут единицы, страниц открывают сотни.
   *
   * Второй повод подключиться — сервер сам сказал, что покупателя ждёт
   * сообщение (`data-chat-waiting` в разметке виджета). Так доходит разговор,
   * начатый МЕНЕДЖЕРОМ: своей памяти о нём у витрины нет — покупатель окно ни
   * разу не открывал, — и без этого его сообщение осталось бы неуслышанным.
   * Значок сервер уже нарисовал, так что до ответа кнопка не пустая. */
  var waiting = Math.max(0, Number(root.getAttribute('data-chat-waiting')) || 0);
  if (waiting) {
    state.unread = waiting;
    // Дальше разговор живёт по обычным правилам: следующий заход подключит
    // канал сам, даже если менеджер больше ничего не написал.
    state.started = true;
    remember();
  }
  if (recall() || waiting) {
    var restoring = post('/api/chat/open', place()).then(function (d) {
      if (!d || !d.ok) return false;
      state.id = d.id || '';
      state.started = true;
      setMode(d.mode);
      applyReceipt(d.receipt);
      (Array.isArray(d.messages) ? d.messages : []).forEach(function (m) {
        if (!m || !m.text) return;
        if (m.at) state.since = Math.max(state.since, m.at);
        dayDivider(m.at);
        var row = bubble(m.role, m.text, m.by, m.at);
        if (m.role === 'user') mine(row, m.at);
        list.appendChild(row);
      });
      state.unread = Math.max(0, Number(d.unread) || 0);
      paintBadge();
      scroll(true);
      connect();
      return true;
    });
    state.opening = restoring.then(function (ok) {
      state.opening = null;
      return ok;
    }, function () {
      state.opening = null;
      return false;
    });
  }

  // Вкладку вернули из фона — канал мог оборваться, пока её усыпляли.
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'visible' && state.started && !state.stream) connect();
  });
})();
