/* ============ Живое обновление панели: страница не ждёт F5 ============
 *
 * Панель смотрит на то, что меняется само: приходят заказы, кассы двигают их
 * состояние, посетители ходят по витрине, покупатели пишут отзывы. Раньше всё
 * это появлялось только после перезагрузки, а на «Метрике» ради этого даже
 * стояла кнопка «Обновить» — то есть работу за нас делал человек.
 *
 * Как устроено:
 *
 *   1. Вкладка держит открытым `GET /admin/live` (EventSource). Сервер шлёт туда
 *      номера версий тем, на которые вкладка подписана (`lib/live.js`).
 *   2. Номер изменился — вкладка перезапрашивает ТУ ЖЕ страницу обычным fetch и
 *      подменяет в ней блоки, помеченные `data-live-part`.
 *
 * Главное правило: **разметку по-прежнему рисует сервер и только он.** Здесь нет
 * ни одного шаблона строки заказа, отзыва или плитки — второй рендер в браузере
 * разъехался бы с серверным на первой же правке, а увидеть это можно было бы
 * только глазами. Скрипт занимается ровно одним: аккуратно переносит свежую
 * разметку в живой документ.
 *
 * «Аккуратно» — это `morph()` ниже, а не сплошная подстановка разметки. Замена
 * сбрасывает всё, чем владеет человек: раскрытые свёртки ответов на отзыв,
 * набранный в них текст, включённый режим правки, положение курсора и выделение.
 * Поэтому дерево обходится узел за узлом и меняется только то, что правда стало
 * другим.
 */
(function () {
  'use strict';

  var topics = (document.body.getAttribute('data-live') || '').trim();
  if (!topics || !window.EventSource || !window.fetch || !window.DOMParser) return;

  // Не чаще одного перезапроса в эту паузу. На витрине с трафиком метрика
  // меняется каждую секунду, а перерисовывать страницу столько раз незачем:
  // человек всё равно читает медленнее.
  var THROTTLE = 1200;
  var known = null;          // номера версий, известные этой вкладке
  var busy = false;          // запрос уже в пути
  var pending = false;       // пока он шёл, пришло ещё одно изменение
  var lastAt = 0;
  var timer = null;

  /* ---------------------------------------------------------------- перенос */

  // Ключ узла: по нему строка заказа или отзыва узнаётся после пересборки
  // списка. Без ключей вставленный сверху свежий заказ сдвинул бы весь список
  // на позицию, и каждая строка была бы переписана заново — вместе с раскрытой
  // свёрткой и набранным в ней ответом.
  function keyOf(node) {
    return node.nodeType === 1 ? (node.getAttribute('data-live-key') || node.id || '') : '';
  }

  function sameKind(a, b) {
    if (a.nodeType !== b.nodeType) return false;
    if (a.nodeType !== 1) return true;
    return a.tagName === b.tagName && keyOf(a) === keyOf(b);
  }

  // Поля ввода: их содержимое принадлежит человеку, а не серверу. Значение,
  // отметку и выбранный пункт не трогаем никогда — иначе живое обновление
  // стирало бы недописанный ответ на отзыв и выключало режим правки.
  var FIELDS = { INPUT: 1, TEXTAREA: 1, SELECT: 1, OPTION: 1 };

  function syncAttrs(from, to) {
    var i, at;
    for (i = to.attributes.length - 1; i >= 0; i--) {
      at = to.attributes[i];
      if (ownedByUser(from, at.name)) continue;
      if (from.getAttribute(at.name) !== at.value) from.setAttribute(at.name, at.value);
    }
    for (i = from.attributes.length - 1; i >= 0; i--) {
      at = from.attributes[i];
      if (ownedByUser(from, at.name)) continue;
      if (!to.hasAttribute(at.name)) from.removeAttribute(at.name);
    }
  }

  // Что человек уже решил сам: раскрыл свёртку, отметил галочку, выбрал пункт.
  function ownedByUser(el, name) {
    /* Плашка связи целиком принадлежит браузеру: жив ли канал, знает только он,
       а сервер рисует её всегда в подключённом виде. Без этого первая же удачная
       подмена стирала бы отметку «нет связи» — и она возвращалась бы обратно
       через несколько секунд, то есть мигала бы на ровном месте. */
    if (el.classList && el.classList.contains('a-live')) return true;
    if (name === 'open' && el.tagName === 'DETAILS') return true;
    return FIELDS[el.tagName] && (name === 'value' || name === 'checked' || name === 'selected');
  }

  function morph(from, to) {
    if (from.nodeType === 3 || from.nodeType === 8) {
      if (from.nodeValue !== to.nodeValue) from.nodeValue = to.nodeValue;
      return;
    }
    if (from.nodeType !== 1) return;
    syncAttrs(from, to);
    // У поля ввода детей либо нет, либо они и есть его значение (textarea).
    if (FIELDS[from.tagName]) return;
    morphChildren(from, to);
  }

  function morphChildren(from, to) {
    var keyed = Object.create(null), node, next;
    for (node = from.firstChild; node; node = node.nextSibling) {
      var k = keyOf(node);
      if (k) keyed[k] = node;
    }
    var cur = from.firstChild;
    for (var fresh = to.firstChild; fresh; fresh = fresh.nextSibling) {
      var key = keyOf(fresh);
      var match = null;
      if (key && keyed[key]) match = keyed[key];
      else if (cur && !keyOf(cur) && sameKind(cur, fresh)) match = cur;
      if (match) {
        if (match === cur) cur = cur.nextSibling;
        else from.insertBefore(match, cur);       // строка переехала выше
        if (key) delete keyed[key];
        morph(match, fresh);
      } else {
        from.insertBefore(document.importNode(fresh, true), cur);
      }
    }
    while (cur) { next = cur.nextSibling; from.removeChild(cur); cur = next; }
  }

  /* --------------------------------------------------------------- обновление */

  // Мгновения, когда трогать страницу нельзя. Ни одно из них не длится долго,
  // поэтому обновление не отменяется, а откладывается.
  function blocked() {
    var el = document.activeElement;
    // Человек печатает — например, ответ магазина на отзыв.
    if (el && FIELDS[el.tagName] && el.closest && el.closest('[data-live-part]')) return true;
    // Открыт просмотрщик вложений: он держит ссылки на узлы страницы.
    if (document.body.classList.contains('lb-open')) return true;
    // Раскрыто меню разделов — из-под руки его выдёргивать незачем.
    var menu = document.getElementById('a-menu');
    return !!(menu && menu.open);
  }

  function apply(html) {
    var doc = new DOMParser().parseFromString(html, 'text/html');
    var parts = document.querySelectorAll('[data-live-part]');
    var changed = false;
    for (var i = 0; i < parts.length; i++) {
      var name = parts[i].getAttribute('data-live-part');
      var fresh = doc.querySelector('[data-live-part="' + name + '"]');
      // Свежая разметка есть, а старая и новая совпадают — не трогаем дерево
      // вовсе: это самый частый случай (метрика тикает чаще, чем меняется вид).
      if (!fresh || fresh.innerHTML === parts[i].innerHTML) continue;
      morph(parts[i], fresh);
      changed = true;
    }
    if (changed) flash();
  }

  function pull() {
    if (busy) { pending = true; return; }
    var wait = THROTTLE - (Date.now() - lastAt);
    if (wait > 0 || blocked()) return later(wait > 0 ? wait : 900);
    busy = true; lastAt = Date.now();
    fetch(location.href, { credentials: 'same-origin', headers: { 'X-Live': '1' } })
      .then(function (r) {
        // Сессия кончилась: сервер увёл на вход, и показывать дальше нечего.
        if (r.redirected && r.url.indexOf('/admin/login') > -1) { location.reload(); return null; }
        return r.ok ? r.text() : null;
      })
      // Пустой ответ — это либо 5xx, либо увод на вход: в обоих случаях свежего
      // мы не получили, и обещать обратное плашке нельзя.
      .then(function (html) { if (html) { apply(html); fresh(); } else stale(); })
      // Сеть моргнула. Данные на экране с этого мгновения могли устареть, и
      // плашка обязана это сказать — но не сразу: одна неудачная попытка ещё
      // ничего не значит, ждём `stale()`.
      .catch(function () { stale(); })
      .then(function () {
        busy = false;
        if (pending) { pending = false; later(THROTTLE); }
      });
  }

  function later(ms) {
    if (timer) return;
    timer = setTimeout(function () { timer = null; pull(); }, ms);
  }

  /* ------------------------------------------------- состояние связи в шапке */

  /* Плашка в шапке отвечает на один вопрос: свежее ли то, что на экране.
   *
   * Она НЕ показывает состояние SSE-канала как такового, и это осознанно.
   * Канал бывает мёртв, пока страница исправно обновляется запасным опросом
   * (сжимающий прокси не пропускает поток), — сказать в этот момент «нет связи»
   * было бы такой же неправдой, как молчать при выдернутом проводе. Поэтому
   * «свежо» ставит ЛЮБОЙ успех — и открытый канал, и удачный запрос, — а «нет
   * связи» зажигается, только когда за OFFLINE_AFTER не случилось ни одного.
   *
   * Задержка нужна против мигания: EventSource переподключается сам и стреляет
   * `onerror` даже на секундной заминке, а плашка, дёргающаяся на каждый вздох
   * сети, быстро перестаёт что-либо значить.
   *
   * Слова обе — в разметке (`layout()` в lib/admin-views.js), скрипт только
   * переключает класс и берёт заголовок из `data-title-off`.
   */
  var OFFLINE_AFTER = 4000;
  var offTimer = null;
  var titleOn = '';

  function setOffline(off) {
    var mark = document.querySelector('.a-live');
    if (!mark || off === mark.classList.contains('is-off')) return;
    mark.classList.toggle('is-off', off);
    var t = off ? mark.getAttribute('data-title-off') : titleOn;
    if (t) mark.setAttribute('title', t);
  }

  // Свежее: канал открылся или запрос прошёл. Отменяет ожидание разрыва.
  function fresh() {
    if (offTimer) { clearTimeout(offTimer); offTimer = null; }
    setOffline(false);
  }

  // Похоже на разрыв. Ждём: поднимется само — `fresh()` снимет таймер.
  function stale() {
    if (offTimer) return;
    offTimer = setTimeout(function () { offTimer = null; setOffline(true); }, OFFLINE_AFTER);
  }

  // Отметка «обновилось» в шапке: без неё подмена происходит бесшумно, и
  // непонятно, живая страница или просто давно открытая.
  function flash() {
    var mark = document.querySelector('.a-live');
    if (!mark) return;
    mark.classList.remove('is-hit');
    void mark.offsetWidth;                        // перезапустить анимацию
    mark.classList.add('is-hit');
  }

  /* ------------------------------------------------------------ уведомления */

  /* Заказ, отзыв и реплика в чате приходят сами, и подмена блоков показывает их
   * молча: цифра в таблице поменялась — а что именно случилось, видно, только
   * если стоишь на нужном разделе. Поэтому событие приезжает отдельным
   * сообщением канала и ложится карточкой поверх страницы.
   *
   * Разметку карточки прислал СЕРВЕР (`noteCard()` в lib/admin-views.js) — здесь
   * её не собирают, как и разметку любой строки: второй рендер в браузере
   * разъехался бы с серверным на первой правке.
   */
  var NOTE_TTL = 12000;        // сколько карточка висит сама по себе
  var NOTE_KEEP = 4;           // сколько их держим на экране разом
  var NOTE_FADE = 260;         // столько идёт её уход, см. .a-note в styles.css

  function noteHide(card) {
    if (!card || !card.parentNode || card.classList.contains('is-out')) return;
    card.classList.add('is-out');
    setTimeout(function () { if (card.parentNode) card.parentNode.removeChild(card); }, NOTE_FADE);
  }

  function noteShow(html) {
    var box = document.getElementById('a-notes');
    if (!box || !html) return;
    /* Разбираем тем же DOMParser, что и свежую страницу в `apply()`. Не потому,
     * что так короче, а потому, что присваивать innerHTML в этом файле нельзя
     * вовсе: правило простое и проверяется тестом, а исключение «здесь-то узел
     * новый» рано или поздно переползло бы на живые блоки. */
    var doc = new DOMParser().parseFromString(html, 'text/html');
    var incoming = doc.body.firstElementChild;
    if (!incoming) return;
    var card = document.importNode(incoming, true);
    box.insertBefore(card, box.firstChild);
    // Старые уводим сами: десяток карточек закрыл бы половину экрана — ровно
    // тем, ради чего панель и открыта.
    while (box.children.length > NOTE_KEEP) noteHide(box.lastElementChild);
    var timer = setTimeout(function () { noteHide(card); }, NOTE_TTL);
    // Пока на карточку смотрят (курсор на ней), она не исчезает: читать
    // уведомление, которое уходит из-под руки, невозможно.
    card.addEventListener('mouseenter', function () { clearTimeout(timer); });
    card.addEventListener('mouseleave', function () { timer = setTimeout(function () { noteHide(card); }, NOTE_TTL); });
  }

  (function () {
    var box = document.getElementById('a-notes');
    if (!box) return;
    // Слушаем контейнер, а не крестик: карточки приходят и уходят, и вешать
    // обработчик на каждую заново незачем.
    box.addEventListener('click', function (e) {
      var x = e.target.closest && e.target.closest('[data-note-close]');
      if (!x) return;
      e.preventDefault();
      noteHide(x.closest('[data-note]'));
    });
  })();

  /* ------------------------------------------------------------------- канал */

  // Первое сообщение задаёт отсчётную точку и ничего не перерисовывает: страницу
  // мы только что получили свежей. Дальше отличие любого номера — это «на
  // сервере что-то поменялось, спроси заново».
  function heard(next) {
    if (!known) { known = next; return; }
    var differs = false;
    for (var k in next) if (next[k] !== known[k]) differs = true;
    known = next;
    if (differs) pull();
  }

  (function () {
    var mark = document.querySelector('.a-live');
    if (mark) titleOn = mark.getAttribute('title') || '';
  })();

  var es = new EventSource('/admin/live?topics=' + encodeURIComponent(topics));
  es.onmessage = function (e) {
    var next; try { next = JSON.parse(e.data); } catch (x) { return; }
    fresh();                                      // сообщение дошло — связь есть
    heard(next);
  };
  es.onopen = fresh;
  es.onerror = stale;
  // Уведомление о событии — своим именем сообщения: номера версий отвечают
  // «спроси страницу заново», а это карточка, которую надо просто показать.
  es.addEventListener('note', function (e) {
    var data; try { data = JSON.parse(e.data); } catch (x) { return; }
    fresh();
    if (data && data.html) noteShow(data.html);
  });

  // Запасной путь. EventSource переподключается сам, но между попытками канал
  // мёртв, а сжимающий прокси может не пропустить поток вовсе — тогда страница
  // всё равно обязана обновляться, пусть и реже. Удачный опрос при этом и есть
  // доказательство, что данные свежие: `pull()` зовёт `fresh()` сам.
  setInterval(function () { if (es.readyState !== 1) pull(); }, 20000);
  // Вернулись во вкладку — берём свежее сразу: пока она была скрыта, браузер мог
  // усыпить и таймеры, и сам канал.
  document.addEventListener('visibilitychange', function () { if (!document.hidden) pull(); });
  window.addEventListener('pageshow', function (e) { if (e.persisted) pull(); });
})();
