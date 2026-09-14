/*
 * Яндекс Метрика на витрине: загрузчик счётчика и цели.
 *
 * Файл подключается ТОЛЬКО тем страницам, которым сервер решил отдать счётчик
 * (`lib/yandex-metrika.js`): номер приезжает атрибутом `data-ym` у <html>, и
 * без него скрипт не делает ничего. Стоит он в разметке раньше app.js, поэтому
 * `window.ymGoal` уже существует, когда витрина захочет отметить цель; где
 * счётчика нет, нет и функции — вызывающий просто идёт дальше.
 *
 * Настройки счётчика — минимум, ради которого он и нужен Директу:
 * - вебвизор ВЫКЛЮЧЕН: он пишет содержимое полей, то есть имя, телефон и адрес
 *   покупателя уезжали бы Яндексу;
 * - карта кликов и слежение за ссылками выключены — своя метрика это уже
 *   считает, а Яндексу знать незачем;
 * - `accurateTrackBounce` включён: без него любой короткий визит из Директа
 *   считается отказом и портит оценку кампании;
 * - электронная коммерция через dataLayer: покупка с суммой и составом даёт
 *   Директу оптимизацию по доходу, а не только по числу заявок.
 */
(function () {
  'use strict';
  var root = document.documentElement;
  var id = Number(String(root.getAttribute('data-ym') || '').replace(/\D/g, ''));
  if (!id) return;
  var w = window;

  // Стандартный загрузчик Метрики: очередь вызовов до прихода tag.js.
  w.ym = w.ym || function () { (w.ym.a = w.ym.a || []).push(arguments); };
  w.ym.l = 1 * new Date();
  w.dataLayer = w.dataLayer || [];
  var s = document.createElement('script');
  s.async = true;
  s.src = 'https://mc.yandex.ru/metrika/tag.js';
  document.head.appendChild(s);
  w.ym(id, 'init', {
    clickmap: false,
    trackLinks: false,
    accurateTrackBounce: true,
    webvisor: false,
    ecommerce: 'dataLayer'
  });

  /* Отметка «эта цель по этому заказу уже отправлена». Страница оплаты
   * перезагружается на каждую смену состояния и открывается повторно, а
   * оплаченный заказ обязан считаться один раз. Месяц с запасом: заказ живёт
   * полчаса, страницу к нему открывают ещё дни. */
  var ONCE_TTL = 30 * 24 * 3600 * 1000;
  function onceKey(key) { return 'ym_goal_' + key; }
  function seen(key) {
    try {
      var at = Number(localStorage.getItem(onceKey(key)) || 0);
      return at > 0 && Date.now() - at >= 0 && Date.now() - at < ONCE_TTL;
    } catch (e) { return false; }
  }
  function mark(key) { try { localStorage.setItem(onceKey(key), String(Date.now())); } catch (e) {} }

  /* Цель. `params` — параметры цели (`order_price` и `currency` Метрика читает
   * как ценность конверсии), `once` — ключ одноразовости ('' — считать каждый
   * раз), `done` — что сделать после отправки.
   *
   * `done` зовётся РОВНО ОДИН РАЗ и в любом исходе: по подтверждению Метрики,
   * по таймауту (tag.js не загрузился — блокировщик, сеть) или сразу, если
   * цель уже отправлена. Вызывающий ждёт его перед уходом со страницы: иначе
   * `location.href` сразу за `reachGoal` обрывал бы запрос вместе со страницей,
   * и ровно та цель, ради которой всё затевалось, не доезжала бы. */
  var GOAL_WAIT = 600;
  w.ymGoal = function (name, params, once, done) {
    var fired = false;
    var finish = function () { if (fired) return; fired = true; if (typeof done === 'function') done(); };
    try {
      if (once && seen(once)) { finish(); return; }
      if (once) mark(once);
      var timer = setTimeout(finish, GOAL_WAIT);
      w.ym(id, 'reachGoal', String(name), params || {}, function () { clearTimeout(timer); finish(); });
    } catch (e) { finish(); }
  };

  /* Покупка для электронной коммерции: номер заказа, сумма и состав. Отдаётся
   * с той же одноразовостью, что и цель `paid`, — Метрика повторы покупок не
   * склеивает. */
  w.ymPurchase = function (order, once) {
    try {
      if (once && seen(once)) return;
      if (once) mark(once);
      var products = Array.isArray(order.products) ? order.products : [];
      w.dataLayer.push({ ecommerce: { currencyCode: 'RUB', purchase: {
        actionField: { id: String(order.id || ''), revenue: Number(order.revenue) || 0 },
        products: products
      } } });
    } catch (e) {}
  };
})();
