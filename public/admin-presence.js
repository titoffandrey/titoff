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
  var channel = null;
  function connect() {
    if (!channel) channel = new EventSource('/admin/live?topics=settings');
  }
  connect();
  window.addEventListener('pagehide', function () {
    if (channel) channel.close();
    channel = null;
  });
  // Возврат кнопкой «Назад» может восстановить тот же документ из bfcache.
  // Скрипты повторно не запускаются, а закрытый EventSource сам не оживает.
  window.addEventListener('pageshow', function (event) { if (event.persisted) connect(); });
})();
