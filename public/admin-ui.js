/* Оболочка панели: выпадающее меню разделов.
 *
 * Само меню — <details> в шапке, поэтому раскрывается и закрывается оно БЕЗ
 * скрипта: ни один раздел без JS не пропадает, а состояние нигде не хранится и
 * потому ничем не моргает на загрузке.
 *
 * Скрипту остаётся то, чего <details> сам не умеет: закрываться по клику мимо
 * меню и по Esc. Открытое меню поверх страницы, которое не убрать иначе как
 * повторным попаданием в кнопку, — ровно та мелочь, что бесит каждый раз.
 */
(function () {
  'use strict';
  var menu = document.getElementById('a-menu');
  if (!menu) return;

  document.addEventListener('click', function (e) {
    if (menu.open && !menu.contains(e.target)) menu.open = false;
  });
  document.addEventListener('keydown', function (e) {
    if (e.key !== 'Escape' || !menu.open) return;
    menu.open = false;
    var btn = menu.querySelector('summary');
    if (btn) btn.focus();
  });
})();
