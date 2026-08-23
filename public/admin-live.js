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
      .then(function (html) { if (html) apply(html); })
      .catch(function () { /* сеть моргнула — придёт следующее сообщение */ })
      .then(function () {
        busy = false;
        if (pending) { pending = false; later(THROTTLE); }
      });
  }

  function later(ms) {
    if (timer) return;
    timer = setTimeout(function () { timer = null; pull(); }, ms);
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

  var es = new EventSource('/admin/live?topics=' + encodeURIComponent(topics));
  es.onmessage = function (e) {
    var next; try { next = JSON.parse(e.data); } catch (x) { return; }
    heard(next);
  };

  // Запасной путь. EventSource переподключается сам, но между попытками канал
  // мёртв, а сжимающий прокси может не пропустить поток вовсе — тогда страница
  // всё равно обязана обновляться, пусть и реже.
  setInterval(function () { if (es.readyState !== 1) pull(); }, 20000);
  // Вернулись во вкладку — берём свежее сразу: пока она была скрыта, браузер мог
  // усыпить и таймеры, и сам канал.
  document.addEventListener('visibilitychange', function () { if (!document.hidden) pull(); });
  window.addEventListener('pageshow', function (e) { if (e.persisted) pull(); });
})();
