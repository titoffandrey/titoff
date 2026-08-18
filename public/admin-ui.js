/* Оболочка панелей: показать/спрятать боковое меню.
 *
 * Меню занимает четверть ширины, а нужно раз в несколько минут — на каталоге,
 * заказах и метрике это место дороже отдать таблице. Кнопка стоит в шапке слева
 * от заголовка: там её ищут в любой панели.
 *
 * Состояние живёт в localStorage и применяется КЛАССОМ НА <html> ещё до первой
 * отрисовки (короткий скрипт в <head>, см. ADMIN_NAV_BOOT в lib/render.js) —
 * иначе меню моргало бы открытым на каждой странице у того, кто его спрятал.
 *
 * Без скрипта меню просто остаётся открытым, как было: ни один раздел без него
 * не пропадает.
 */
(function () {
  'use strict';
  var KEY = 'admin_nav_off';
  var root = document.documentElement;
  var btn = document.getElementById('a-nav-toggle');
  if (!btn) return;

  function hidden() { return root.classList.contains('nav-off'); }
  function paint() {
    var off = hidden();
    btn.setAttribute('aria-expanded', off ? 'false' : 'true');
    btn.setAttribute('aria-label', off ? 'Показать меню' : 'Скрыть меню');
    btn.setAttribute('title', off ? 'Показать меню' : 'Скрыть меню');
  }
  paint();

  // Один класс на оба размера экрана: на широком он убирает колонку, на телефоне —
  // ленту разделов. Смысл один и тот же, «меню спрятано», поэтому и состояние одно.
  btn.addEventListener('click', function () {
    root.classList.toggle('nav-off');
    try { localStorage.setItem(KEY, hidden() ? '1' : '0'); } catch (e) { /* приватный режим — просто не запомним */ }
    paint();
  });
})();
