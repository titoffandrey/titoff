/* Присутствие администратора на страницах без живой подмены данных.
 *
 * Списки и обзор уже держат /admin/live через admin-live.js. Формы намеренно
 * не обновляются из-под рук, но открытая форма всё равно означает, что
 * менеджер на смене. Поэтому здесь тот же защищённый канал без обработчиков:
 * он сообщает серверу только «вкладка открыта» и ничего на странице не меняет.
 */
(function () {
  'use strict';
  if (document.body.hasAttribute('data-live') || !window.EventSource) return;
  var channel = new EventSource('/admin/live?topics=settings');
  window.addEventListener('pagehide', function () { channel.close(); });
})();
