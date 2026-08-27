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
 *
 * Список строк ищется ЗАНОВО на каждом такте, а не запоминается при загрузке:
 * живое обновление (`public/admin-live.js`) подменяет строки списка прямо на
 * открытой странице, и у приехавшего таким образом заказа отсчёт иначе не шёл
 * бы вовсе. Полсотни строк в секунду — это доли миллисекунды.
 */
(function () {
  'use strict';

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
    var boxes = document.querySelectorAll('.o-left[data-pay-until]');
    for (var i = 0; i < boxes.length; i++) {
      var box = boxes[i];
      var ms = Number(box.getAttribute('data-pay-until') || 0) - Date.now();
      if (ms <= 0) { expire(box); continue; }
      var b = box.querySelector('b');
      if (b) b.textContent = left(ms);
    }
  }

  setInterval(tick, 1000);
  tick();
})();

/* ================= Переписка чата открывается на последней реплике =================
 *
 * Ровно то, что делает любой мессенджер: разговор показывают с конца, потому
 * что нужен последний вопрос, а не первый. Без этого лента открывалась сверху,
 * и менеджер каждый раз прокручивал её вниз руками — а именно внизу лежит то,
 * ради чего он диалог и открыл.
 *
 * Разметку скрипт не создаёт: он только прокручивает готовый блок. То же
 * правило, что у отсчёта срока счёта выше.
 */
(function () {
  var thread = document.querySelector('.chat-thread');
  if (!thread) return;

  var dock = document.querySelector('.chat-answer-dock');

  /* Звук отправки — тот же, что слышит покупатель у себя в окне
   * (`public/chat-sound.js`, один файл на витрину и панель).
   *
   * Играет он ПОСЛЕ перезагрузки, а не на отправке формы: ответ уходит обычным
   * POST с редиректом, и начатый перед уходом со страницы звук браузер обрывает.
   * Признак приезжает в разметке (`data-chat-sent`), а из адреса убирается
   * сразу — иначе обновление страницы повторяло бы сигнал на пустом месте. */
  var view = document.querySelector('.chat-view[data-chat-sent]');
  if (view) {
    if (window.ChatSound) window.ChatSound.play('out');
    view.removeAttribute('data-chat-sent');
    if (window.history && history.replaceState) {
      history.replaceState(null, '', location.pathname);
    }
  }

  function toBottom() {
    thread.scrollTop = thread.scrollHeight;
    /* На телефоне у ленты своей прокрутки нет вовсе: высота не ограничена,
     * чтобы не заводить прокрутку внутри прокрутки — палец не разберёт, какую
     * из них он тянет. Значит к последней реплике надо вести саму страницу,
     * иначе длинный разговор открывается на своём начале, то есть на самом
     * бесполезном месте.
     *
     * Поле ответа прилипло к низу экрана (`position:sticky`), поэтому вести
     * страницу надо не к нижней границе ленты, а выше на его высоту: иначе
     * последняя реплика оказывается ровно под ним — то есть невидимой. */
    if (thread.scrollHeight <= thread.clientHeight + 4) {
      var box = thread.getBoundingClientRect();
      var docked = dock ? dock.getBoundingClientRect().height : 0;
      var below = box.bottom - window.innerHeight + docked;
      if (below > 0) window.scrollBy(0, below + 12);
    }
  }

  /* Скопировать реплику. Единственное действие меню, которое из разметки не
   * сделать: буфер обмена открывается только скриптом. Запасной путь через
   * execCommand обязателен — clipboard-API нет в старых браузерах и он не
   * работает без https, а панель открывают и с телефона по локальной сети. */
  document.addEventListener('click', function (e) {
    var btn = e.target.closest && e.target.closest('[data-chat-copy]');
    if (!btn) return;
    e.preventDefault();
    var text = btn.getAttribute('data-chat-copy') || '';
    var was = btn.querySelector('span');
    var done = function () {
      if (!was || was.dataset.was) return;
      was.dataset.was = was.textContent;
      was.textContent = 'Скопировано';
      setTimeout(function () { was.textContent = was.dataset.was; delete was.dataset.was; }, 1800);
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done, function () { fallback(text, done); });
    } else fallback(text, done);
  });
  function fallback(text, done) {
    var box = document.createElement('textarea');
    box.value = text;
    box.setAttribute('readonly', '');
    box.style.cssText = 'position:fixed;top:-1000px;opacity:0';
    document.body.appendChild(box);
    box.select();
    try { document.execCommand('copy'); done(); } catch (err) { /* нечем — молчим */ }
    box.remove();
  }

  /* Поле растёт под текст, как в мессенджере: одна строка под короткий ответ,
   * до четырёх под длинный. Своя высота у него потому, что `rows` задаёт только
   * начальную, а `resize` на телефоне не потянешь пальцем. */
  var field = dock && dock.querySelector('textarea');
  if (field) {
    var grow = function () {
      field.style.height = 'auto';
      field.style.height = Math.min(field.scrollHeight, 132) + 'px';
    };
    field.addEventListener('input', grow);
    grow();
  }
  toBottom();

  /* Живое обновление подменяет содержимое ленты целиком, и после подмены она
   * оказывается прокрученной наверх. Возвращаем вниз — но ТОЛЬКО если менеджер
   * и так стоял внизу: он мог отлистать вверх, чтобы перечитать начало
   * разговора, и дёргать ленту у него под руками нельзя. */
  var atBottom = true;
  thread.addEventListener('scroll', function () {
    atBottom = thread.scrollHeight - thread.scrollTop - thread.clientHeight < 120;
  });
  if (typeof MutationObserver === 'function') {
    new MutationObserver(function () { if (atBottom) toBottom(); })
      .observe(thread, { childList: true, subtree: true });
  }
})();
