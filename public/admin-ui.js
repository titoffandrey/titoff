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

/* Обратный отсчёт действующего счёта в списке заказов.
 *
 * Первый кадр рисует сервер (`orderStatus` в lib/render.js), скрипту остаётся
 * тикать: страница отдаётся один раз, а срок у счёта идёт минутами — через
 * четверть часа плашка обещала бы менеджеру то, чего уже нет.
 *
 * Досчитав до нуля, плашка переписывается в то, что покажет сервер при
 * следующем открытии страницы, а сама строка отсчёта уходит: считать больше
 * нечего. Подпись берётся из разметки (`data-over`), а не пишется здесь — все
 * слова про состояние оплаты живут в одном месте, в lib/render.js.
 */
(function () {
  'use strict';
  var boxes = [].slice.call(document.querySelectorAll('.o-left[data-pay-until]'));
  if (!boxes.length) return;

  function left(ms) {
    var total = Math.max(0, Math.floor(ms / 1000));
    var p = function (n) { return n < 10 ? '0' + n : String(n); };
    var h = Math.floor(total / 3600), m = Math.floor((total % 3600) / 60), s = total % 60;
    return h ? h + ':' + p(m) + ':' + p(s) : m + ':' + p(s);
  }

  // Счёт сгорел: плашка соседняя, у неё меняется тон и подпись. Точку внутри
  // собираем заново — <i> красится тоном и без неё плашка выглядит обрезанной.
  function expire(box) {
    var cell = box.parentNode;
    var tag = cell ? cell.querySelector('.pay-tag') : null;
    if (tag) {
      tag.className = 'pay-tag pay-off';
      tag.textContent = '';
      tag.appendChild(document.createElement('i'));
      tag.appendChild(document.createTextNode(box.getAttribute('data-over') || ''));
    }
    var row = cell && cell.closest ? cell.closest('tr.o-row, .o-recent-row') : null;
    if (row) row.className = row.className.replace(/\bo-row-wait\b/, 'o-row-off');
    box.parentNode.removeChild(box);
  }

  function tick() {
    var live = 0;
    for (var i = 0; i < boxes.length; i++) {
      var box = boxes[i];
      if (!box) continue;                                  // этот уже сгорел
      var ms = Number(box.getAttribute('data-pay-until') || 0) - Date.now();
      if (ms <= 0) { expire(box); boxes[i] = null; continue; }
      var b = box.querySelector('b');
      if (b) b.textContent = left(ms);
      live++;
    }
    // Считать больше нечего — таймер незачем держать до ухода со страницы.
    if (!live) clearInterval(timer);
  }

  var timer = setInterval(tick, 1000);
  tick();
})();
