/* Оболочка панели: меню разделов.
 *
 * Само меню — скрытый чекбокс и подписи к нему, поэтому открывается и
 * закрывается оно БЕЗ скрипта: кнопка в шапке открывает, нажатие по затемнению
 * закрывает, ни один раздел без JS не пропадает, а состояние нигде не хранится
 * и потому ничем не моргает на загрузке.
 *
 * Скрипту остаётся то, чего разметка не умеет: закрыть меню по Esc и вернуть
 * фокус на кнопку. Открытая панель, которую не убрать иначе как попаданием
 * мышью, — ровно та мелочь, что бесит каждый раз.
 *
 * Клик мимо здесь не обрабатывается намеренно: затемнение — это подпись к тому
 * же чекбоксу, и второй обработчик снимал бы галочку ПЕРЕД тем, как её вернёт
 * действие подписи, то есть меню не закрывалось бы вовсе.
 */
(function () {
  'use strict';
  var menu = document.getElementById('a-menu');
  if (!menu) return;

  document.addEventListener('keydown', function (e) {
    if (e.key !== 'Escape' || !menu.checked) return;
    menu.checked = false;
    menu.focus();
  });
})();

/* ================= Календарь диапазона в метрике =================
 *
 * Данные по-прежнему живут в двух родных `<input type=date>` и уходят обычной
 * GET-формой. Этот слой отвечает только за вид и взаимодействие: диалог,
 * палитра, непрерывная лента месяцев и формат ДД.ММ.ГГГГ повторяют Google
 * Trends. Не загрузился скрипт — остаются нативные рабочие поля, а не две
 * нарисованные кнопки без действия.
 *
 * Обработчик делегирован документу, потому что живая метрика подменяет форму
 * прямо на открытой странице. Черновик хранится в диалоге, а по «ОК» всегда
 * записывается в НОВЫЕ поля текущей формы, даже если подмена случилась, пока
 * календарь был открыт.
 */
(function () {
  'use strict';

  var layer = null;
  var pane = null;
  var monthList = null;
  var opener = null;
  var activeName = 'from';
  var activeTab = 'archive';
  var draft = { from: '', to: '' };
  var today = '';
  var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  function two(n) { return n < 10 ? '0' + n : String(n); }

  function localToday() {
    var d = new Date();
    return d.getFullYear() + '-' + two(d.getMonth() + 1) + '-' + two(d.getDate());
  }

  function parse(value) {
    var m = String(value || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!m) return null;
    var d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12);
    if (d.getFullYear() !== Number(m[1]) || d.getMonth() !== Number(m[2]) - 1 || d.getDate() !== Number(m[3])) return null;
    return d;
  }

  function ymd(d) {
    return d.getFullYear() + '-' + two(d.getMonth() + 1) + '-' + two(d.getDate());
  }

  function label(value) {
    var d = parse(value);
    return d ? two(d.getDate()) + '.' + two(d.getMonth() + 1) + '.' + d.getFullYear() : 'ДД.ММ.ГГГГ';
  }

  function shiftDay(value, amount) {
    var d = parse(value) || new Date();
    d.setDate(d.getDate() + amount);
    return ymd(d);
  }

  function currentForm() { return document.querySelector('.mf-form'); }

  function field(name) {
    var form = currentForm();
    return form ? form.querySelector('.mf-date-native[name="' + name + '"]') : null;
  }

  function paintPageLabels() {
    var triggers = document.querySelectorAll('[data-date-trigger]');
    for (var i = 0; i < triggers.length; i++) {
      var trigger = triggers[i];
      var input = trigger.parentNode && trigger.parentNode.querySelector('.mf-date-native');
      var slot = trigger.querySelector('[data-date-label]');
      if (!slot || !input) continue;
      var text = label(input.value);
      // `textContent=` даже с тем же значением создаёт новый текстовый узел.
      // На живой странице это снова будит MutationObserver и без проверки
      // замыкает его в бесконечную очередь обновлений после кнопки «ОК».
      if (slot.textContent !== text) slot.textContent = text;
      slot.classList.toggle('is-placeholder', !parse(input.value));
    }
  }

  function enhance(root) {
    // Добавление текста — не новая форма. Если прогнать через общий `document`,
    // наблюдатель снова затронет все подписи дат, включая только что изменённую.
    if (root && root.nodeType && root.nodeType !== 1 && root.nodeType !== 9) return;
    var scope = root && root.querySelectorAll ? root : document;
    var triggers = scope.querySelectorAll('[data-date-trigger]');
    for (var i = 0; i < triggers.length; i++) {
      triggers[i].hidden = false;
      var control = triggers[i].closest ? triggers[i].closest('.mf-date-control') : triggers[i].parentNode;
      if (control) control.classList.add('is-ready');
    }
    // `root` сам может быть кнопкой после точечной подмены.
    if (root && root.matches && root.matches('[data-date-trigger]')) {
      root.hidden = false;
      var own = root.closest('.mf-date-control');
      if (own) own.classList.add('is-ready');
    }
    paintPageLabels();
  }

  function build() {
    if (layer) return;
    layer = document.createElement('div');
    layer.className = 'gcal-layer';
    layer.hidden = true;
    layer.innerHTML = '<div class="gcal-backdrop" data-gcal-cancel></div>'
      + '<section class="gcal-dialog" role="dialog" aria-modal="true" aria-labelledby="gcal-title">'
      + '<div class="gcal-title" id="gcal-title">Произвольный период времени</div>'
      + '<div class="gcal-tabs" role="tablist">'
      + '<button class="gcal-tab is-active" type="button" role="tab" aria-selected="true" data-gcal-tab="archive">АРХИВ</button>'
      + '<button class="gcal-tab" type="button" role="tab" aria-selected="false" data-gcal-tab="week">ПРОШЛАЯ НЕДЕЛЯ</button></div>'
      + '<div data-gcal-panel="archive" role="tabpanel">'
      + '<div class="gcal-content"><div class="gcal-row"><i class="gcal-radio is-on" aria-hidden="true"></i><span>С</span>'
      + '<button class="gcal-range-field" type="button" data-gcal-range="from"><span data-gcal-label="from"></span><svg class="gcal-chev" viewBox="0 0 24 24" aria-hidden="true"><path d="m7 9 5 5 5-5z"/></svg></button></div>'
      + '<div class="gcal-row"><i aria-hidden="true"></i><span>По</span>'
      + '<button class="gcal-range-field" type="button" data-gcal-range="to"><span data-gcal-label="to"></span><svg class="gcal-chev" viewBox="0 0 24 24" aria-hidden="true"><path d="m7 9 5 5 5-5z"/></svg></button></div>'
      + '<div class="gcal-row gcal-year" aria-disabled="true"><i class="gcal-radio" aria-hidden="true"></i><span>Весь год</span>'
      + '<span class="gcal-year-value"><b data-gcal-year></b><svg class="gcal-chev" viewBox="0 0 24 24" aria-hidden="true"><path d="m7 9 5 5 5-5z"/></svg></span></div></div></div>'
      + '<div class="gcal-last-week" data-gcal-panel="week" role="tabpanel" hidden><span><b>Последние 7 дней</b>Диапазон будет установлен по календарным дням.</span></div>'
      + '<div class="gcal-actions"><button class="gcal-action" type="button" data-gcal-cancel>ОТМЕНА</button><button class="gcal-action" type="button" data-gcal-ok>ОК</button></div>'
      + '<div class="gcal-pane" data-gcal-pane hidden><div class="gcal-pane-value"><span data-gcal-pane-value></span><svg class="gcal-chev" viewBox="0 0 24 24" aria-hidden="true"><path d="m7 9 5 5 5-5z"/></svg></div>'
      + '<div class="gcal-weekdays" aria-hidden="true"><span>S</span><span>M</span><span>T</span><span>W</span><span>T</span><span>F</span><span>S</span></div><div class="gcal-months" data-gcal-months role="grid" aria-label="Календарь"></div></div>'
      + '</section>';
    document.body.appendChild(layer);
    pane = layer.querySelector('[data-gcal-pane]');
    monthList = layer.querySelector('[data-gcal-months]');
  }

  function paintDraft() {
    if (!layer) return;
    for (var i = 0; i < 2; i++) {
      var name = i ? 'to' : 'from';
      var slot = layer.querySelector('[data-gcal-label="' + name + '"]');
      if (!slot) continue;
      slot.textContent = label(draft[name]);
      slot.classList.toggle('is-placeholder', !parse(draft[name]));
    }
    var year = layer.querySelector('[data-gcal-year]');
    var date = parse(today) || new Date();
    if (year) year.textContent = String(date.getFullYear());
  }

  function setTab(name) {
    activeTab = name === 'week' ? 'week' : 'archive';
    var tabs = layer.querySelectorAll('[data-gcal-tab]');
    var panels = layer.querySelectorAll('[data-gcal-panel]');
    for (var i = 0; i < tabs.length; i++) {
      var on = tabs[i].getAttribute('data-gcal-tab') === activeTab;
      tabs[i].classList.toggle('is-active', on);
      tabs[i].setAttribute('aria-selected', on ? 'true' : 'false');
    }
    for (var p = 0; p < panels.length; p++) panels[p].hidden = panels[p].getAttribute('data-gcal-panel') !== activeTab;
    pane.hidden = true;
    if (activeTab === 'week') {
      draft.to = today;
      draft.from = shiftDay(today, -6);
      paintDraft();
    }
  }

  function addMonth(container, year, month, selected) {
    var section = document.createElement('section');
    section.className = 'gcal-month';
    section.setAttribute('data-gcal-month', year + '-' + two(month + 1));
    var title = document.createElement('div');
    title.className = 'gcal-month-title';
    title.textContent = MONTHS[month] + ' ' + year;
    section.appendChild(title);
    var days = document.createElement('div');
    days.className = 'gcal-days';
    var first = new Date(year, month, 1, 12).getDay();
    var count = new Date(year, month + 1, 0, 12).getDate();
    for (var blank = 0; blank < first; blank++) {
      var empty = document.createElement('i');
      empty.className = 'gcal-blank';
      empty.setAttribute('aria-hidden', 'true');
      days.appendChild(empty);
    }
    for (var day = 1; day <= count; day++) {
      var value = year + '-' + two(month + 1) + '-' + two(day);
      var button = document.createElement('button');
      button.type = 'button';
      button.className = 'gcal-day';
      button.setAttribute('data-gcal-day', value);
      button.setAttribute('role', 'gridcell');
      button.setAttribute('aria-label', label(value));
      button.disabled = value > today;
      if (value === today) button.classList.add('is-today');
      if (value === selected) {
        button.classList.add('is-selected');
        button.setAttribute('aria-selected', 'true');
      }
      var number = document.createElement('span');
      number.textContent = String(day);
      button.appendChild(number);
      days.appendChild(button);
    }
    section.appendChild(days);
    container.appendChild(section);
  }

  function renderMonths() {
    if (!monthList) return;
    monthList.textContent = '';
    var selected = draft[activeName];
    var base = parse(selected) || parse(today) || new Date();
    var end = parse(today) || new Date();
    end = new Date(end.getFullYear(), end.getMonth(), 1, 12);
    var start = new Date(end.getFullYear(), end.getMonth() - 12, 1, 12);
    if (base < start) start = new Date(base.getFullYear(), base.getMonth(), 1, 12);
    var cursor = new Date(start.getFullYear(), start.getMonth(), 1, 12);
    var guard = 0;
    while (cursor <= end && guard++ < 18) {
      addMonth(monthList, cursor.getFullYear(), cursor.getMonth(), selected);
      cursor.setMonth(cursor.getMonth() + 1);
    }
    var selectedNode = monthList.querySelector('.gcal-day.is-selected');
    var selectedMonth = selectedNode && selectedNode.closest ? selectedNode.closest('.gcal-month') : null;
    if (!selectedMonth) selectedMonth = monthList.querySelector('.gcal-month:last-child');
    // `offsetTop` считается от всего листа и включает 80 px строки даты и
    // заголовка недели. Вычитаем положение самого скролл-контейнера, иначе
    // название месяца уезжает ровно на эти 80 px за верхний край.
    monthList.scrollTop = selectedMonth
      ? Math.max(0, selectedMonth.offsetTop - monthList.offsetTop)
      : monthList.scrollHeight;
  }

  function showPane(name) {
    activeName = name === 'to' ? 'to' : 'from';
    setTab('archive');
    // Размеры месяцев нужны для прокрутки к выбранному. У скрытого `pane` все
    // `offsetTop` равны нулю, поэтому сначала показываем лист и только потом
    // строим и ставим его на нужный месяц.
    pane.hidden = false;
    renderMonths();
    var value = layer.querySelector('[data-gcal-pane-value]');
    if (value) value.textContent = label(draft[activeName]);
    var selected = monthList.querySelector('.gcal-day.is-selected');
    if (selected) selected.focus();
    else pane.querySelector('.gcal-pane-value').focus && pane.querySelector('.gcal-pane-value').focus();
  }

  function open(trigger) {
    build();
    opener = trigger;
    activeName = trigger.getAttribute('data-date-trigger') === 'to' ? 'to' : 'from';
    var from = field('from');
    var to = field('to');
    draft.from = from ? from.value : '';
    draft.to = to ? to.value : '';
    today = (from && from.max) || (to && to.max) || localToday();
    paintDraft();
    layer.hidden = false;
    document.body.classList.add('gcal-open');
    trigger.setAttribute('aria-expanded', 'true');
    showPane(activeName);
  }

  function close() {
    if (!layer || layer.hidden) return;
    layer.hidden = true;
    pane.hidden = true;
    document.body.classList.remove('gcal-open');
    if (opener) {
      opener.setAttribute('aria-expanded', 'false');
      if (document.documentElement.contains(opener)) opener.focus();
    }
    opener = null;
  }

  function commit() {
    var from = field('from');
    var to = field('to');
    if (from) from.value = draft.from;
    if (to) to.value = draft.to;
    var event;
    try { event = new Event('change', { bubbles: true }); } catch (err) { event = document.createEvent('Event'); event.initEvent('change', true, false); }
    if (from) from.dispatchEvent(event);
    try { event = new Event('change', { bubbles: true }); } catch (err2) { event = document.createEvent('Event'); event.initEvent('change', true, false); }
    if (to) to.dispatchEvent(event);
    paintPageLabels();
    close();
  }

  document.addEventListener('click', function (event) {
    var target = event.target;
    if (!target || !target.closest) return;
    var trigger = target.closest('[data-date-trigger]');
    if (trigger) { event.preventDefault(); open(trigger); return; }
    if (!layer || layer.hidden) return;

    var cancel = target.closest('[data-gcal-cancel]');
    if (cancel) { event.preventDefault(); close(); return; }
    if (target.closest('[data-gcal-ok]')) { event.preventDefault(); commit(); return; }
    var tab = target.closest('[data-gcal-tab]');
    if (tab) { event.preventDefault(); setTab(tab.getAttribute('data-gcal-tab')); return; }
    var range = target.closest('[data-gcal-range]');
    if (range) { event.preventDefault(); showPane(range.getAttribute('data-gcal-range')); return; }
    var day = target.closest('[data-gcal-day]');
    if (day && !day.disabled) {
      event.preventDefault();
      var chosen = day.getAttribute('data-gcal-day') || '';
      draft[activeName] = chosen;
      if (activeName === 'from' && draft.to && chosen > draft.to) draft.to = chosen;
      if (activeName === 'to' && draft.from && chosen < draft.from) draft.from = chosen;
      paintDraft();
      pane.hidden = true;
      var next = layer.querySelector('[data-gcal-range="' + (activeName === 'from' ? 'to' : 'from') + '"]');
      if (next) next.focus();
    }
  });

  document.addEventListener('keydown', function (event) {
    if (event.key !== 'Escape' || !layer || layer.hidden) return;
    event.preventDefault();
    if (!pane.hidden) {
      pane.hidden = true;
      var range = layer.querySelector('[data-gcal-range="' + activeName + '"]');
      if (range) range.focus();
    } else close();
  });

  enhance(document);
  var content = document.querySelector('.a-content');
  if (content && typeof MutationObserver === 'function') {
    new MutationObserver(function (records) {
      for (var i = 0; i < records.length; i++) {
        for (var j = 0; j < records[i].addedNodes.length; j++) enhance(records[i].addedNodes[j]);
      }
    }).observe(content, { childList: true, subtree: true });
  }
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
    /* На ДЕСКТОПЕ у ленты своя высота, но страница под ней тоже прокручивается,
     * и последняя реплика может оказаться под прилипшим полем ответа. Ведём к
     * ней саму страницу — не к нижней границе ленты, а выше на высоту поля.
     *
     * На телефоне разговор занимает экран целиком (`.a-app`), прокручиваемая
     * область там ровно одна — сама лента, — и двигать страницу не нужно и
     * нечем: прежняя оговорка про «прокрутку внутри прокрутки» относилась к
     * старой раскладке, где лента жила посреди обычной страницы. */
    if (app()) return;
    if (thread.scrollHeight <= thread.clientHeight + 4) {
      var box = thread.getBoundingClientRect();
      var docked = dock ? dock.getBoundingClientRect().height : 0;
      var below = box.bottom - window.innerHeight + docked;
      if (below > 0) window.scrollBy(0, below + 12);
    }
  }

  /* Разговор во весь экран — на любой ширине, но только на своей странице.
   * Признак ставит сервер классом `a-app` у <body>: `:has()` для этого не
   * годится, его поддерживают не все версии Safari, доходящие до панели.
   * Спрашивать ширину здесь больше не нужно — на мониторе разговор такой же
   * полноэкранный, как на телефоне. */
  var view = document.querySelector('.chat-view');
  function app() {
    return !!view && document.body.classList.contains('a-app');
  }

  /* Клавиатура. Ровно та же беда и то же лечение, что у окна чата на витрине:
   * браузер не уменьшает окно, а сдвигает видимую область, и `position:fixed`
   * панель остаётся на месте — шапка уезжает вверх, поле ввода прячется под
   * клавиатуру. Считает всё общая `window.fitPanel` из `mobile-shell.js`. */
  function fit() {
    if (!window.fitPanel) return;
    if (window.fitPanel(view, app())) toBottom();
  }
  if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', fit);
    window.visualViewport.addEventListener('scroll', fit);
  }
  /* Клавиатура выезжает уже ПОСЛЕ того, как фокус встал в поле, и `resize`
   * приходит с задержкой в пару кадров — без этого первый кадр менеджер видит
   * съехавшую шапку, и запоминается именно он. */
  document.addEventListener('focusin', function () { setTimeout(fit, 120); });
  fit();

  /* Подробности о собеседнике закрываются нажатием мимо — то же, что скрипт
   * делает с меню разделов. Раскрытые они лежат ПОВЕРХ ленты, и оставить их
   * висеть, пока не попадёшь второй раз по имени, — ровно та мелочь, которая
   * раздражает каждый раз. Само раскрытие при этом чистый CSS: без скрипта
   * профиль по-прежнему открывается и закрывается подписью-кнопкой. */
  var profile = document.getElementById('chat-profile');
  if (profile) {
    document.addEventListener('click', function (e) {
      if (!profile.checked) return;
      /* САМ ПЕРЕКЛЮЧАТЕЛЬ — не «мимо», и это не мелочь: нажатие по подписи
       * браузер повторяет нажатием по её полю, а поле лежит РЯДОМ с шапкой, а не
       * внутри неё. Без этой проверки профиль открывался и тут же закрывался сам
       * — со стороны выглядело так, будто имя вообще не нажимается. */
      if (e.target === profile) return;
      if (e.target.closest && e.target.closest('.chat-head-box')) return;
      profile.checked = false;
    });
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

  /* ======================= Фотографии в ответе =======================
   *
   * Снимки ведут себя так же, как у покупателя: можно выбрать несколько раз,
   * увидеть плитки до отправки и убрать промах. Сам input после выбора
   * очищается, чтобы повторно выбрать тот же файл; настоящую очередь держим в
   * памяти и при отправке собираем multipart сами. Обычный ответ без файлов
   * остаётся нативной формой и работает даже без этого скрипта. */
  var photoInput = dock && dock.querySelector('.chat-answer-file');
  var photoBox = dock && dock.querySelector('.chat-answer-picks');
  var photoNote = dock && dock.querySelector('.chat-answer-photo-note');
  var sendButton = dock && dock.querySelector('.chat-answer-send-round');
  var maxPhotos = Math.max(1, Number(dock && dock.getAttribute('data-max-photos')) || 3);
  var maxPhotoBytes = 6 * 1024 * 1024;
  var photoFiles = [], photoUrls = [];

  function sayPhoto(text, error) {
    if (!photoNote) return;
    photoNote.textContent = text || '';
    photoNote.hidden = !text;
    photoNote.classList.toggle('is-error', !!error);
  }

  function clearPhotoUrls() {
    for (var i = 0; i < photoUrls.length; i++) URL.revokeObjectURL(photoUrls[i]);
    photoUrls = [];
  }

  function renderPhotos() {
    if (!photoBox) return;
    clearPhotoUrls();
    photoBox.textContent = '';
    photoBox.hidden = !photoFiles.length;
    for (var i = 0; i < photoFiles.length; i++) {
      var url = URL.createObjectURL(photoFiles[i]);
      photoUrls.push(url);
      var cell = document.createElement('span');
      cell.className = 'chat-answer-pick';
      var img = document.createElement('img');
      img.src = url;
      img.alt = '';
      cell.appendChild(img);
      var remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'chat-answer-pick-x';
      remove.setAttribute('data-chat-photo', String(i));
      remove.setAttribute('aria-label', 'Убрать фото ' + (i + 1));
      remove.textContent = '×';
      cell.appendChild(remove);
      photoBox.appendChild(cell);
    }
  }

  function pickPhotos(list) {
    var tooMany = false, tooBig = false, notImage = false;
    for (var i = 0; i < list.length; i++) {
      var file = list[i];
      if (!file) continue;
      if (photoFiles.length >= maxPhotos) { tooMany = true; break; }
      if (!/^image\//.test(file.type || '')) { notImage = true; continue; }
      if (file.size > maxPhotoBytes) { tooBig = true; continue; }
      photoFiles.push(file);
    }
    if (notImage) sayPhoto('Приложить можно только фотографии.', true);
    else if (tooBig) sayPhoto('Один снимок — не больше 6 МБ.', true);
    else if (tooMany) sayPhoto('К сообщению можно приложить не больше ' + maxPhotos + ' фото.', true);
    else sayPhoto('');
    renderPhotos();
  }

  if (photoInput) {
    photoInput.addEventListener('change', function () {
      pickPhotos(photoInput.files ? [].slice.call(photoInput.files) : []);
      photoInput.value = '';
    });
  }
  if (photoBox) {
    photoBox.addEventListener('click', function (e) {
      var remove = e.target.closest && e.target.closest('[data-chat-photo]');
      if (!remove) return;
      photoFiles.splice(Number(remove.getAttribute('data-chat-photo')), 1);
      sayPhoto('');
      renderPhotos();
    });
  }

  if (dock) {
    dock.addEventListener('submit', function (e) {
      var text = String(field && field.value || '').trim();
      if (!text && !photoFiles.length) {
        e.preventDefault();
        sayPhoto('Напишите сообщение или приложите фото.', true);
        if (field) field.focus();
        return;
      }
      // Без снимков браузер отправляет обычную форму с PRG-переходом.
      if (!photoFiles.length) return;
      e.preventDefault();
      var body = new FormData(dock);
      // Пустой очищенный input уже мог дать техническую файловую часть.
      body.delete('photos');
      for (var i = 0; i < photoFiles.length; i++) body.append('photos', photoFiles[i], photoFiles[i].name);
      if (sendButton) sendButton.disabled = true;
      sayPhoto('Отправляем фото…');
      fetch(dock.action, { method: 'POST', credentials: 'same-origin', body: body })
        .then(function (res) {
          if (!res.ok) throw new Error('upload');
          // fetch следует за 303 сам; переходим на итоговый адрес с `sent=1`,
          // чтобы звук и очистка адреса остались общими с текстовым ответом.
          window.location.assign(res.url || dock.action);
        })
        .catch(function () {
          if (sendButton) sendButton.disabled = false;
          sayPhoto('Не удалось отправить. Проверьте соединение и попробуйте ещё раз.', true);
        });
    });
  }

  window.addEventListener('pagehide', clearPhotoUrls);

  /* ==================== Ответ на конкретную реплику ====================
   *
   * Путей два, и это не роскошь: они отвечают разным рукам.
   *
   *   1. «Ответить» первым пунктом в меню реплики — обычная ССЫЛКА
   *      (`?reply=<время>`). Работает везде, с клавиатуры и без скриптов вовсе:
   *      сервер вернёт ту же страницу с уже подставленной цитатой.
   *   2. Смахивание реплики в сторону — на сенсорном экране, как в Telegram и
   *      WhatsApp. Мышью такого нет намеренно: горизонтальное перетаскивание по
   *      тексту — это выделение, и отбирать его у мыши ради жеста нельзя.
   *
   * Оба пути берут цитату ИЗ ОДНОЙ И ТОЙ ЖЕ ссылки (`data-*` у пункта меню):
   * второе место, где решается, что попадёт в цитату, разъехалось бы с первым.
   * Разметку плашки рисует сервер — скрипт только подставляет в неё имя и текст.
   */
  var chip = dock && dock.querySelector('.chat-answer-reply');
  var chipWho = chip && chip.querySelector('.chat-answer-reply-who');
  var chipText = chip && chip.querySelector('.chat-answer-reply-text');
  var chipAt = chip && chip.querySelector('input[name="replyTo"]');

  function setReply(at, who, text) {
    if (!chip) return;
    chipAt.value = at || '';
    chipWho.textContent = who || '';
    chipText.textContent = text || '';
    chip.hidden = !at;
    if (at && field) field.focus();
  }

  // Выделенная реплика — раскрытое меню под ней. Открытым остаётся одно: два
  // ряда кнопок в разных местах ленты читались бы как два начатых действия.
  function closeTools(keep) {
    var open = thread.querySelectorAll('.chat-bubble[open]');
    for (var i = 0; i < open.length; i++) if (open[i] !== keep) open[i].open = false;
  }

  function replyFrom(link) {
    setReply(link.getAttribute('data-chat-reply'),
      link.getAttribute('data-reply-who'), link.getAttribute('data-reply-text'));
    closeTools();
  }

  document.addEventListener('click', function (e) {
    var t = e.target;
    if (!t || !t.closest) return;
    var link = t.closest('[data-chat-reply]');
    // Без плашки (её нет на странице «написать первым») ссылка работает как
    // ссылка: цитату подставит сервер.
    if (link && chip) { e.preventDefault(); replyFrom(link); return; }
    var off = t.closest('.chat-answer-reply-x');
    if (off && chip) { e.preventDefault(); setReply('', '', ''); return; }
    /* Нажали мимо — выделение снимается. Открытое меню, которое иначе не убрать
     * иначе как повторным попаданием в ту же реплику, — ровно та мелочь, что
     * раздражает каждый раз. Внутри самого пузыря (форма правки, поле ввода)
     * ничего не закрываем: это и есть начатое действие. */
    closeTools(t.closest('.chat-bubble'));
  });

  document.addEventListener('keydown', function (e) {
    if (e.key !== 'Escape') return;
    // Esc снимает сперва выделение реплики, а потом уже отменяет ответ: два
    // состояния — два нажатия, как в мессенджерах.
    if (thread.querySelector('.chat-bubble[open]')) { closeTools(); return; }
    if (chip && !chip.hidden) setReply('', '', '');
  });

  /* -------------------------- Удержание --------------------------
   *
   * `<summary>` сам раскрывает `<details>` по обычному нажатию. Для меню
   * реплики это слишком легко задеть при чтении ленты, поэтому указательный
   * клик гасим, а выделяем реплику только после короткого удержания. Клавиатуру
   * обрабатываем отдельно: Enter/Space обязаны работать без таймера.
   *
   * Ход на 10 px отменяет удержание раньше порога смахивания: палец либо
   * листает ленту, либо отвечает жестом, но случайно меню не раскрывает.
   */
  var HOLD_MS = 480, HOLD_MOVE = 10, hold = null, heldLine = null, heldAt = 0;

  function messageControl(target) {
    return target && target.closest
      && target.closest('a,button,input,textarea,select,label,[contenteditable]');
  }

  function holdEnd(id) {
    if (!hold || (id !== undefined && hold.id !== id)) return;
    clearTimeout(hold.timer);
    hold.line.classList.remove('is-holding');
    hold = null;
  }

  thread.addEventListener('pointerdown', function (e) {
    if (!e.isPrimary || e.button !== 0 || messageControl(e.target)) return;
    var line = e.target.closest && e.target.closest('.chat-line');
    var bubble = line && line.parentNode;
    if (!line || !bubble || !bubble.classList.contains('chat-bubble')) return;
    holdEnd();
    var active = hold = {
      line: line, bubble: bubble, x: e.clientX, y: e.clientY,
      id: e.pointerId, timer: 0
    };
    line.classList.add('is-holding');
    active.timer = setTimeout(function () {
      if (hold !== active) return;
      heldLine = active.line;
      heldAt = Date.now();
      closeTools(active.bubble);
      active.bubble.open = true;
    }, HOLD_MS);
  });

  thread.addEventListener('pointermove', function (e) {
    if (!hold || e.pointerId !== hold.id) return;
    if (Math.abs(e.clientX - hold.x) >= HOLD_MOVE || Math.abs(e.clientY - hold.y) >= HOLD_MOVE) {
      holdEnd(e.pointerId);
    }
  });
  thread.addEventListener('pointerup', function (e) { holdEnd(e.pointerId); });
  thread.addEventListener('pointercancel', function (e) { holdEnd(e.pointerId); });
  thread.addEventListener('pointerleave', function (e) {
    if (e.pointerType === 'mouse') holdEnd(e.pointerId);
  });

  // Долгое нажатие на сенсорном экране не должно заодно показывать системное
  // меню выделения текста. Правый клик мышью без предшествующего удержания не
  // трогаем — скопировать текст им по-прежнему можно.
  thread.addEventListener('contextmenu', function (e) {
    var line = e.target.closest && e.target.closest('.chat-line');
    if (line === heldLine && Date.now() - heldAt < 1000) e.preventDefault();
  });

  // Chromium не активирует `summary`, когда его родительский `details` имеет
  // `display:contents`, поэтому на нативный keyboard-click здесь не полагаемся.
  thread.addEventListener('keydown', function (e) {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    var line = e.target.closest && e.target.closest('.chat-line');
    if (!line || e.target !== line) return;
    var bubble = line.parentNode;
    e.preventDefault();
    closeTools(bubble);
    bubble.open = !bubble.open;
  });

  // Интерактивные узлы внутри пузыря (прежде всего снимки) живут своей жизнью.
  // `detail === 0` — программная активация или средство доступности: у них
  // раскрытие остаётся мгновенным. Любой указательный клик требует удержания.
  thread.addEventListener('click', function (e) {
    var line = e.target.closest && e.target.closest('.chat-line');
    if (!line || messageControl(e.target) || e.detail === 0) return;
    e.preventDefault();
  }, true);

  /* -------------------------- Смахивание --------------------------
   *
   * Порог хода — `SWIPE_ON`, дальше `SWIPE_MAX` реплика не едет: жест обязан
   * упираться, иначе непонятно, сработает он или нет. Направление любое: в
   * Telegram отвечают ходом влево, в WhatsApp — вправо, и требовать от менеджера
   * помнить, в каком он мессенджере, незачем.
   *
   * Вертикальный ход — это прокрутка ленты, и жест мы отпускаем сразу: пузырь,
   * дёргающийся при листании, хуже отсутствия жеста. Ровно за этим у `.chat-line`
   * стоит `touch-action:pan-y` — прокрутку делает браузер, горизонталь достаётся
   * нам.
   */
  var SWIPE_ON = 52, SWIPE_MAX = 74, drag = null, swipedAt = 0;

  function dragEnd(fire) {
    if (!drag) return;
    var line = drag.line, item = drag.item, on = drag.on, dx = drag.dx, link = drag.link;
    drag = null;
    line.style.transform = '';
    item.classList.remove('is-drag');
    item.style.setProperty('--swipe', 0);
    if (!on) return;
    // Ход был — значит нажатие в конце него принадлежит жесту, а не пузырю:
    // иначе смахивание заодно раскрывало бы меню реплики или снимок.
    swipedAt = Date.now();
    setTimeout(function () {
      item.classList.remove('is-swipe-left');
      item.classList.remove('is-swipe-right');
    }, 220);
    if (fire && Math.abs(dx) >= SWIPE_ON) replyFrom(link);
  }

  thread.addEventListener('pointerdown', function (e) {
    // Мышь не смахивает: горизонтальное перетаскивание по тексту — это его
    // выделение, и отбирать его ради жеста нельзя.
    if (!e.isPrimary || e.pointerType === 'mouse' || !chip) return;
    var line = e.target.closest && e.target.closest('.chat-line');
    if (!line) return;
    // Отвечать не на что (системная строка) — и вести нечего.
    var link = line.parentNode && line.parentNode.querySelector('[data-chat-reply]');
    var item = line.closest('.chat-item');
    if (!link || !item) return;
    dragEnd(false);
    drag = { line: line, item: item, link: link, x: e.clientX, y: e.clientY, dx: 0, on: false, id: e.pointerId };
  });

  thread.addEventListener('pointermove', function (e) {
    if (!drag || e.pointerId !== drag.id) return;
    var dx = e.clientX - drag.x, dy = e.clientY - drag.y;
    if (!drag.on) {
      if (Math.abs(dy) > Math.abs(dx)) { dragEnd(false); return; }   // это прокрутка
      if (Math.abs(dx) < 10) return;
      drag.on = true;
      drag.item.classList.add('is-drag');
      // Захват: палец уходит с пузыря, а события обязаны доходить до конца хода.
      try { drag.line.setPointerCapture(e.pointerId); } catch (err) { /* не умеет — переживём */ }
    }
    drag.dx = dx;
    var shift = Math.max(-SWIPE_MAX, Math.min(SWIPE_MAX, dx));
    drag.line.style.transform = 'translateX(' + shift + 'px)';
    drag.item.classList.toggle('is-swipe-right', dx > 0);
    drag.item.classList.toggle('is-swipe-left', dx < 0);
    drag.item.style.setProperty('--swipe', Math.min(1, Math.abs(dx) / SWIPE_ON));
  });

  thread.addEventListener('pointerup', function () { dragEnd(true); });
  thread.addEventListener('pointercancel', function () { dragEnd(false); });

  // Нажатие, доставшееся от жеста, гасим НА ПЕРЕХВАТЕ: до него ни `<details>`,
  // ни просмотрщик снимков не успевают сработать.
  thread.addEventListener('click', function (e) {
    if (Date.now() - swipedAt > 400) return;
    e.preventDefault();
    e.stopPropagation();
  }, true);

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

/* ============== Настройки: раскрытый раздел переживает сохранение ==============
 *
 * Разделы настроек — обычные <details>, поэтому раскрываются и без скрипта.
 * Скрипту остаётся то, чего <details> не умеет сам: пережить перезагрузку.
 *
 * Страница после «Сохранить» приходит заново, и раздел, который только что
 * правили, закрывался бы прямо под руками — а на странице их девять, и искать
 * свой пришлось бы каждый раз. Список раскрытого уезжает СКРЫТЫМ ПОЛЕМ ФОРМЫ и
 * возвращается от сервера параметром `?open=`: ни localStorage, ни скрипта в
 * <head>, ни моргания на загрузке (тем же путём когда-то ушло меню разделов).
 *
 * Сервер уже положил в поле то, что раскрыл сам, поэтому без скрипта настройки
 * работают как работали.
 */
(function () {
  'use strict';
  document.addEventListener('submit', function (e) {
    var form = e.target;
    if (!form || !form.classList || !form.classList.contains('a-settings')) return;
    var field = form.querySelector('input[name="openSections"]');
    if (!field) return;
    var open = [];
    var list = form.querySelectorAll('details.set[open]');
    for (var i = 0; i < list.length; i++) open.push(list[i].id.replace(/^set-/, ''));
    field.value = open.join(',');
  });

  /* Поле не прошло проверку браузера — раскрываем раздел, в котором оно лежит.
   *
   * Иначе форма молча отказывается отправляться: в скрытое поле нельзя поставить
   * фокус, и браузер пишет об этом только в консоль — со стороны это выглядит
   * как переставшая работать кнопка «Сохранить». Своих `required` на странице
   * нет намеренно (их ловит сервер), но проверки бывают и другие — `minlength` у
   * пароля, — и одна забытая обошлась бы владельцу магазина слишком дорого.
   */
  document.addEventListener('invalid', function (e) {
    var box = e.target && e.target.closest && e.target.closest('details');
    while (box) { box.open = true; box = box.parentElement && box.parentElement.closest('details'); }
  }, true);
})();

/* ============== Оформление: предпросмотр и готовые акценты ==============
 *
 * Раздел «Оформление» отвечал на вопрос «какие тут поля», а не «как это
 * выглядит»: цвет виден квадратиком, шрифт — только словом «Гротеск», а
 * фигурные скобки в надписи объяснялись абзацем подсказки. Разметку
 * предпросмотра рисует СЕРВЕР (`brandPreview()` в lib/render.js) — здесь только
 * то, чего без скрипта не бывает: правка на лету и ряд готовых цветов.
 *
 * Без скрипта раздел работает как работал: предпросмотр показывает сохранённое,
 * цвет выбирается родным контролом, пресетов просто нет — кнопке, которая
 * ничего не делает, на экране не место.
 */
(function () {
  'use strict';
  var accent = document.querySelector('[data-brand-accent]');
  var preview = document.querySelector('[data-brand-preview]');
  if (!accent && !preview) return;
  var pick = document.querySelector('.color-pick[data-color-presets]');
  var value = document.querySelector('[data-color-value]');
  var font = document.querySelector('[data-brand-font]');
  var text = document.querySelector('[data-brand-text]');
  var name = document.querySelector('input[name="storeName"]');
  var logo = document.querySelector('[data-brand-logo]');
  var HEX = /^#[0-9a-fA-F]{6}$/;
  var dots = [];

  function paintColor() {
    var color = accent ? String(accent.value || '') : '';
    if (!HEX.test(color)) return;
    if (preview) preview.style.setProperty('--accent', color);
    if (value) value.textContent = color.toUpperCase();
    for (var i = 0; i < dots.length; i++) {
      dots[i].classList.toggle('is-on', dots[i].getAttribute('data-color').toLowerCase() === color.toLowerCase());
    }
  }

  /* Начертание берётся у ВЫБРАННОГО `<option>`: список шрифтов живёт в
   * lib/render.js, и своя копия здесь разъехалась бы с ним молча — предпросмотр
   * показывал бы не тот шрифт, который поедет на витрину. */
  function paintFont() {
    if (!preview || !font) return;
    var opt = font.options[font.selectedIndex];
    var family = opt && opt.getAttribute('data-font');
    if (family) preview.style.setProperty('--brand-font', family);
  }

  /* Надпись логотипа. Разбор тот же, что у `logoTextMarkup()` на сервере: буквы
   * в фигурных скобках красятся акцентом — ровно это и надо показать, иначе
   * скобки приходится объяснять словами.
   *
   * Узлы строятся руками: текст владельца разметкой не становится ни здесь, ни
   * где-либо ещё в панели. Логотип-картинка заменяет надпись целиком, поэтому
   * при ней трогать нечего.
   */
  function paintText() {
    if (!logo || !text || logo.querySelector('img')) return;
    var raw = (text.value || '').trim() || (name ? String(name.value || '').trim() : '');
    var box = document.createElement('span');
    box.className = 'logo-txt';
    var re = /\{([^}]*)\}/g, last = 0, m;
    while ((m = re.exec(raw))) {
      if (m.index > last) box.appendChild(document.createTextNode(raw.slice(last, m.index)));
      var mark = document.createElement('span');
      mark.className = 'logo-accent';
      mark.textContent = m[1];
      box.appendChild(mark);
      last = re.lastIndex;
    }
    if (last < raw.length) box.appendChild(document.createTextNode(raw.slice(last)));
    logo.textContent = '';
    logo.appendChild(box);
  }

  if (pick && accent) {
    var row = document.createElement('span');
    row.className = 'color-presets';
    var list = String(pick.getAttribute('data-color-presets') || '').split(',');
    for (var i = 0; i < list.length; i++) {
      var color = list[i].trim();
      if (!HEX.test(color)) continue;
      var dot = document.createElement('button');
      dot.type = 'button';
      dot.className = 'color-dot';
      dot.style.background = color;
      dot.setAttribute('data-color', color);
      dot.setAttribute('aria-label', 'Цвет ' + color);
      dot.title = color;
      dot.addEventListener('click', function () {
        accent.value = this.getAttribute('data-color');
        paintColor();
      });
      row.appendChild(dot);
      dots.push(dot);
    }
    if (dots.length) pick.appendChild(row);
  }

  if (accent) accent.addEventListener('input', paintColor);
  if (font) font.addEventListener('change', paintFont);
  if (text) text.addEventListener('input', paintText);
  if (name) name.addEventListener('input', paintText);
  paintColor();
})();

/* ===================== Копирование ===================== *
 *
 * Единственное действие панели, которое из разметки не сделать: буфер обмена
 * открывается только скриптом. Копируют в двух местах — реплику в чате и ссылку
 * на отслеживание, — и обработчик у них ОДИН: второй такой же код разошёлся бы
 * с этим на первой правке.
 *
 * СВОЙ IIFE, а не кусок блока чата, и это не придирка: тот выходит первой
 * строкой, когда на странице нет ленты диалога (`if (!thread) return`), — то
 * есть кнопка «Копировать» на странице отправления не работала бы вовсе, молча.
 *
 * Запасной путь через execCommand обязателен: clipboard-API нет в старых
 * браузерах и он не работает без https, а панель открывают и с телефона по
 * локальной сети.
 */
(function () {
  function say(btn) {
    var was = btn.querySelector('span');
    if (!was || was.dataset.was) return;
    was.dataset.was = was.textContent;
    was.textContent = 'Скопировано';
    btn.classList.add('is-done');
    setTimeout(function () {
      was.textContent = was.dataset.was;
      delete was.dataset.was;
      btn.classList.remove('is-done');
    }, 1800);
  }
  function fallback(text, done) {
    var box = document.createElement('textarea');
    box.value = text;
    box.setAttribute('readonly', '');
    box.style.cssText = 'position:fixed;top:-1000px;opacity:0';
    document.body.appendChild(box);
    box.select();
    // Результат обязателен: execCommand не бросает исключение, а возвращает
    // false, и без проверки кнопка говорила бы «Скопировано» там, где ничего не
    // скопировалось.
    try { if (document.execCommand('copy')) done(); } catch (err) { /* нечем — молчим */ }
    box.remove();
  }
  document.addEventListener('click', function (e) {
    var btn = e.target.closest && e.target.closest('[data-chat-copy],[data-copy]');
    if (!btn) return;
    e.preventDefault();
    var text = btn.getAttribute('data-chat-copy') || btn.getAttribute('data-copy') || '';
    var done = function () { say(btn); };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done, function () { fallback(text, done); });
    } else fallback(text, done);
  });
})();

/* ======================= Карта посетителей: мир и страны ====================
 *
 * Контуры, цвета и числа рисует сервер — они лежат в `data-*` у самого контура.
 * Скрипт делает то, чего разметка не умеет: подсказку у курсора, приближение
 * (колесом, щипком, кнопками и двойным нажатием) и переход внутрь страны по
 * нажатию на неё. Обработчики делегированы документу, поэтому переживают живую
 * подмену всей метрики (`admin-live.js`) без переинициализации.
 *
 * Клавиатурных обработчиков у контуров нет намеренно: их до ста семидесяти
 * четырёх, и фокус на каждом дал бы столько же остановок табуляции посреди
 * отчёта. Числа читаются из рейтинга справа — обычным текстом, а страна там же
 * открывается настоящей ссылкой.
 */
(function () {
  'use strict';
  var active = null;
  var sticky = false;   // подсказку открыли пальцем: сама она не уходит

  function stageOf(el) { return el && el.closest ? el.closest('.gm-stage') : null; }
  function tipOf(shape) {
    var stage = stageOf(shape);
    return stage ? stage.querySelector('.gm-tip') : null;
  }
  function shapeAt(target) { return target && target.closest ? target.closest('.gm-shape') : null; }

  function place(shape, event) {
    var tip = tipOf(shape);
    var stage = stageOf(shape);
    if (!tip || !stage || !event) return;
    var box = stage.getBoundingClientRect();
    var x = event.clientX - box.left + 14;
    var y = event.clientY - box.top - 14;
    // Подсказка не вылезает за карту: у края она встаёт слева от пальца, а не
    // наполовину за границей панели.
    x = Math.max(5, Math.min(box.width - (tip.offsetWidth || 170) - 5, x));
    y = Math.max(5, Math.min(box.height - (tip.offsetHeight || 70) - 5, y));
    tip.style.left = x + 'px';
    tip.style.top = y + 'px';
  }

  function show(shape, event) {
    var tip = tipOf(shape);
    if (!tip) return;
    active = shape;
    var name = tip.querySelector('b');
    var unit = tip.querySelector('em');
    var value = tip.querySelector('strong');
    if (name) name.textContent = shape.getAttribute('data-name') || '';
    /* Подпись приезжает готовой, вместе со склонением («посетитель» —
     * «посетителя» — «посетителей»): все слова отчёта живут на сервере, и своя
     * запасная строка здесь была бы второй таблицей склонений. Скрипт пишет в
     * подсказку ровно то, что уже лежит в разметке. */
    if (unit) unit.textContent = shape.getAttribute('data-unit') || '';
    if (value) value.textContent = shape.getAttribute('data-value') || '';
    tip.hidden = false;
    place(shape, event);
  }

  function hide() {
    var tip = active ? tipOf(active) : null;
    if (tip) tip.hidden = true;
    active = null;
    sticky = false;
  }

  document.addEventListener('pointerover', function (event) {
    var shape = shapeAt(event.target);
    if (!shape) return;
    /* Касание тоже даёт `pointerover`, но сразу за ним приходит `pointerout` —
     * подсказка успевала бы только мигнуть. Поэтому у пальца она остаётся до
     * следующего касания мимо: места на карте мелкие, и попадание в них — уже
     * работа, которую не хочется делать дважды. */
    sticky = event.pointerType === 'touch';
    show(shape, event);
  });
  document.addEventListener('pointermove', function (event) {
    if (active && !sticky && document.documentElement.contains(active)) place(active, event);
  });
  document.addEventListener('pointerout', function (event) {
    if (sticky) return;
    if (active && shapeAt(event.target) === active && !shapeAt(event.relatedTarget)) hide();
  });
  // Касание мимо карты убирает залипшую подсказку — как закрывается меню разделов.
  document.addEventListener('pointerdown', function (event) {
    if (sticky && !shapeAt(event.target)) hide();
  });

  /* --------------------------- Приближение карты ---------------------------
   *
   * Кадр живёт в `viewBox`: там его правит и сервер (у каждой карты свой), и
   * этот скрипт. Второго места хранения нет намеренно — исходный кадр лежит
   * рядом в `data-home`, и кнопка сброса возвращает именно его.
   *
   * На телефоне это не украшение, а единственный способ вообще попасть в
   * область: Свердловская область на карте России занимает там десяток
   * пикселей. Поэтому жесты те же, что у любой карты, — щипок и перетаскивание.
   */
  var MIN_SCALE = 1;
  var MAX_SCALE = 12;

  function parseBox(value) {
    var parts = String(value || '').trim().split(/[\s,]+/).map(Number);
    return parts.length === 4 && parts.every(function (n) { return isFinite(n); }) ? parts : null;
  }
  function svgOf(stage) { return stage ? stage.querySelector('.gm-svg') : null; }
  function homeBox(stage) { return parseBox(stage.getAttribute('data-home')); }
  function currentBox(stage) {
    var svg = svgOf(stage);
    return svg ? parseBox(svg.getAttribute('viewBox')) : null;
  }

  function applyBox(stage, box) {
    var svg = svgOf(stage);
    var home = homeBox(stage);
    if (!svg || !home) return;
    // Ближе MAX_SCALE смотреть не на что: контуры упрощены под ширину панели, и
    // дальше видно уже не географию, а ломаную из отрезков.
    var minW = home[2] / MAX_SCALE;
    var maxW = home[2] / MIN_SCALE;
    var width = Math.min(maxW, Math.max(minW, box[2]));
    var height = width * (home[3] / home[2]);
    // Карта не уезжает за собственные края: гулять можно внутри исходного кадра.
    var x = Math.min(home[0] + home[2] - width, Math.max(home[0], box[0]));
    var y = Math.min(home[1] + home[3] - height, Math.max(home[1], box[1]));
    svg.setAttribute('viewBox', round(x) + ' ' + round(y) + ' ' + round(width) + ' ' + round(height));
    /* Отметка говорит живому обновлению, что кадр теперь принадлежит человеку:
     * без неё подмена разметки возвращала бы карту к общему виду по нескольку
     * раз в минуту, прямо под рукой (см. `ownedByUser` в admin-live.js). */
    if (width < home[2] - 0.5) svg.setAttribute('data-zoomed', '1');
    else svg.removeAttribute('data-zoomed');
    syncButtons(stage);
  }
  function round(value) { return Math.round(value * 100) / 100; }

  function zoomAt(stage, factor, point) {
    var box = currentBox(stage);
    var home = homeBox(stage);
    if (!box || !home) return;
    var rect = stage.getBoundingClientRect();
    // Точка под курсором обязана остаться на месте — иначе карта «уплывает»
    // из-под пальца, и приближать её приходится наугад.
    var ratioX = point ? Math.min(1, Math.max(0, (point.x - rect.left) / rect.width)) : 0.5;
    var ratioY = point ? Math.min(1, Math.max(0, (point.y - rect.top) / rect.height)) : 0.5;
    var anchorX = box[0] + box[2] * ratioX;
    var anchorY = box[1] + box[3] * ratioY;
    var width = box[2] / factor;
    var height = box[3] / factor;
    applyBox(stage, [anchorX - width * ratioX, anchorY - height * ratioY, width, height]);
  }

  function syncButtons(stage) {
    var box = currentBox(stage);
    var home = homeBox(stage);
    if (!box || !home) return;
    var zoom = stage.querySelector('.gm-zoom');
    if (!zoom) return;
    var at = home[2] / box[2];
    var out = zoom.querySelector('[data-zoom="out"]');
    var into = zoom.querySelector('[data-zoom="in"]');
    var reset = zoom.querySelector('[data-zoom="reset"]');
    if (out) out.disabled = at <= MIN_SCALE + 0.001;
    if (into) into.disabled = at >= MAX_SCALE - 0.001;
    if (reset) reset.hidden = at <= MIN_SCALE + 0.001;
  }

  var ZOOM_ICONS = {
    in: ['M12 5.5v13M5.5 12h13'],
    out: ['M5.5 12h13'],
    reset: ['M4.6 9.4A8 8 0 1 1 4 12', 'M4.2 4.6v5h5']
  };
  var ZOOM_TITLES = { in: 'Приблизить', out: 'Отдалить', reset: 'Показать целиком' };
  var SVG_NS = 'http://www.w3.org/2000/svg';

  // Значок собирается узлами, а не присваиванием строки разметки: исключение
  // «здесь-то строка своя» рано или поздно переползает туда, где строка чужая,
  // а в панели рядом лежит текст владельца и текст покупателя.
  function zoomIcon(kind) {
    var svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('aria-hidden', 'true');
    ZOOM_ICONS[kind].forEach(function (d) {
      var path = document.createElementNS(SVG_NS, 'path');
      path.setAttribute('d', d);
      svg.appendChild(path);
    });
    return svg;
  }

  /* Кнопки создаёт скрипт, а не сервер: без него они ничего не делают, а
   * кнопке, которая ничего не делает, на экране не место — то же правило, по
   * которому готовые акценты в настройках появляются только со скриптом. */
  function addButtons(stage) {
    if (stage.querySelector('.gm-zoom')) return;
    var box = document.createElement('div');
    box.className = 'gm-zoom';
    ['in', 'out', 'reset'].forEach(function (kind) {
      var button = document.createElement('button');
      button.type = 'button';
      button.setAttribute('data-zoom', kind);
      button.title = ZOOM_TITLES[kind];
      button.setAttribute('aria-label', ZOOM_TITLES[kind]);
      button.appendChild(zoomIcon(kind));
      box.appendChild(button);
    });
    stage.appendChild(box);
    syncButtons(stage);
  }

  function setupStages() {
    var list = document.querySelectorAll('.gm-stage');
    for (var i = 0; i < list.length; i++) addButtons(list[i]);
  }
  document.addEventListener('DOMContentLoaded', setupStages);
  setupStages();
  /* Живое обновление подменяет разметку отчёта целиком и уносит кнопки вместе с
   * ней — после него их надо вернуть. Ждать наведения мыши для этого нельзя: на
   * телефоне `pointerover` не приходит вовсе, и карта осталась бы без
   * приближения именно там, где оно нужнее всего. */
  document.addEventListener('admin-live:updated', setupStages);

  document.addEventListener('click', function (event) {
    var button = event.target.closest ? event.target.closest('.gm-zoom [data-zoom]') : null;
    if (!button) return;
    var stage = stageOf(button);
    if (!stage) return;
    var kind = button.getAttribute('data-zoom');
    if (kind === 'reset') applyBox(stage, homeBox(stage));
    else zoomAt(stage, kind === 'in' ? 1.6 : 1 / 1.6, null);
  });

  /* Колесо приближает только с Ctrl (на трекпаде это и есть щипок — браузер
   * присылает его как `wheel` с `ctrlKey`). Без этого условия отчёт переставал
   * бы прокручиваться, стоило курсору проехать над картой: страница застревала
   * бы посреди чтения, а зум случался бы сам собой. */
  document.addEventListener('wheel', function (event) {
    var stage = stageOf(event.target);
    if (!stage || !(event.ctrlKey || event.metaKey)) return;
    event.preventDefault();
    zoomAt(stage, event.deltaY < 0 ? 1.18 : 1 / 1.18, { x: event.clientX, y: event.clientY });
  }, { passive: false });

  document.addEventListener('dblclick', function (event) {
    var stage = stageOf(event.target);
    if (!stage) return;
    zoomAt(stage, 1.9, { x: event.clientX, y: event.clientY });
  });

  /* Перетаскивание и щипок. Свой учёт указателей, а не готовый жест браузера:
   * `touch-action:none` у карты отключает прокрутку внутри неё, и всё, что
   * приходит, — это наши же `pointer`-события. */
  var drag = null;
  var points = new Map();

  document.addEventListener('pointerdown', function (event) {
    var stage = stageOf(event.target);
    if (!stage || event.button > 0) return;
    points.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (points.size === 1) {
      drag = { stage: stage, x: event.clientX, y: event.clientY, box: currentBox(stage), moved: 0 };
    } else if (points.size === 2) {
      drag = null;
      var pair = Array.from(points.values());
      stage.__pinch = { distance: distanceOf(pair), box: currentBox(stage) };
    }
  });

  function distanceOf(pair) {
    return Math.hypot(pair[0].x - pair[1].x, pair[0].y - pair[1].y) || 1;
  }

  document.addEventListener('pointermove', function (event) {
    if (!points.has(event.pointerId)) return;
    points.set(event.pointerId, { x: event.clientX, y: event.clientY });
    var stage = drag ? drag.stage : stageOf(event.target);
    if (!stage) return;
    if (points.size >= 2 && stage.__pinch) {
      var pair = Array.from(points.values());
      var factor = distanceOf(pair) / stage.__pinch.distance;
      var rect = stage.getBoundingClientRect();
      var center = { x: (pair[0].x + pair[1].x) / 2, y: (pair[0].y + pair[1].y) / 2 };
      var base = stage.__pinch.box;
      if (!base) return;
      var width = base[2] / factor;
      var ratioX = Math.min(1, Math.max(0, (center.x - rect.left) / rect.width));
      var ratioY = Math.min(1, Math.max(0, (center.y - rect.top) / rect.height));
      var anchorX = base[0] + base[2] * ratioX;
      var anchorY = base[1] + base[3] * ratioY;
      var height = width * (base[3] / base[2]);
      applyBox(stage, [anchorX - width * ratioX, anchorY - height * ratioY, width, height]);
      return;
    }
    if (!drag || !drag.box) return;
    var box = drag.box;
    var rectDrag = drag.stage.getBoundingClientRect();
    var dx = (event.clientX - drag.x) * (box[2] / rectDrag.width);
    var dy = (event.clientY - drag.y) * (box[3] / rectDrag.height);
    drag.moved = Math.max(drag.moved, Math.hypot(event.clientX - drag.x, event.clientY - drag.y));
    // Пока карта показана целиком, таскать нечего — иначе кадр «дрожал» бы под
    // рукой у того, кто просто ведёт мышью по стране.
    var home = homeBox(drag.stage);
    if (!home || box[2] >= home[2] - 0.5) return;
    drag.stage.classList.add('is-drag');
    applyBox(drag.stage, [box[0] - dx, box[1] - dy, box[2], box[3]]);
  });

  function endPointer(event) {
    points.delete(event.pointerId);
    if (points.size < 2) {
      var stages = document.querySelectorAll('.gm-stage');
      for (var i = 0; i < stages.length; i++) stages[i].__pinch = null;
    }
    if (drag) drag.stage.classList.remove('is-drag');
    if (points.size === 0) drag = null;
  }
  document.addEventListener('pointerup', endPointer);
  document.addEventListener('pointercancel', endPointer);

  /* Нажатие на страну открывает её карту. Ссылку в разметке для этого не
   * завести: `<a>` вокруг каждого контура дал бы сто семьдесят четыре остановки
   * табуляции, а путь без скриптов и так есть — рейтинг справа состоит из
   * настоящих ссылок. Перетаскивание при этом переходом не считается: карту
   * возят пальцем, и уехать с неё от каждого движения было бы издевательством. */
  var touchArmed = null;   // страна, подсказку которой уже открыли пальцем

  document.addEventListener('click', function (event) {
    var shape = shapeAt(event.target);
    if (!shape) return;
    var go = shape.getAttribute('data-go');
    if (!go || (drag && drag.moved > 6)) return;
    /* На телефоне первое касание ПОКАЗЫВАЕТ подсказку, и уводить с него внутрь
     * страны нельзя: посмотреть число, не провалившись, было бы невозможно.
     * Переход делает второе касание той же страны — так же ведут себя карты в
     * мобильных приложениях. Мышью переход происходит сразу: там подсказка уже
     * висит под курсором. */
    if (sticky && touchArmed !== shape) { touchArmed = shape; return; }
    window.location.href = go;
  });
})();

/* ===================== Кнопки-меню метрики (период и место) =================
 *
 * Само меню держит `<details>` — открывается и закрывается оно и без скриптов.
 * Здесь только то, чего разметка не умеет: закрытие по нажатию мимо и по Esc,
 * поиск по длинному списку стран и фокус в поле поиска при открытии.
 */
(function () {
  'use strict';
  function menus() { return document.querySelectorAll('details[data-menu][open]'); }

  function closeAll(except) {
    var open = menus();
    for (var i = 0; i < open.length; i++) if (open[i] !== except) open[i].removeAttribute('open');
  }

  document.addEventListener('click', function (event) {
    var inside = event.target.closest ? event.target.closest('details[data-menu]') : null;
    closeAll(inside);
  });

  document.addEventListener('keydown', function (event) {
    if (event.key !== 'Escape') return;
    var open = menus();
    if (!open.length) return;
    // Меню закрывается первым: у панели свой Esc (он снимает выделение реплики
    // и закрывает боковое меню), и уводить фокус разом отовсюду не нужно.
    event.stopPropagation();
    closeAll(null);
  }, true);

  document.addEventListener('toggle', function (event) {
    var box = event.target;
    if (!box.matches || !box.matches('details[data-menu]')) return;
    if (!box.open) return;
    closeAll(box);
    var search = box.querySelector('[data-menu-search]');
    // Курсор ставится сам: список стран открывают, чтобы найти в нём страну, и
    // целиться в поле вторым нажатием незачем — то же правило, что у лупы в
    // шапке витрины. На телефоне фокуса не даём: клавиатура закрыла бы список.
    if (search && !window.matchMedia('(pointer:coarse)').matches) search.focus();
  }, true);

  document.addEventListener('input', function (event) {
    var field = event.target;
    if (!field.matches || !field.matches('[data-menu-search]')) return;
    var menu = field.closest('.g-menu');
    if (!menu) return;
    var query = field.value.trim().toLowerCase();
    var items = menu.querySelectorAll('[data-menu-item]');
    var shown = 0;
    for (var i = 0; i < items.length; i++) {
      var hit = !query || items[i].getAttribute('data-menu-item').indexOf(query) >= 0;
      items[i].hidden = !hit;
      if (hit) shown++;
    }
    // Заголовки групп и разделители у пустой группы прячутся вместе с ней:
    // «Откуда заходили» над пустотой читается как потерянный список.
    var groups = menu.querySelectorAll('.g-menu-list');
    for (var g = 0; g < groups.length; g++) {
      var empty = !groups[g].querySelector('[data-menu-item]:not([hidden])');
      groups[g].hidden = empty;
      var title = groups[g].previousElementSibling;
      if (title && title.classList.contains('g-menu-title')) title.hidden = empty;
    }
    var note = menu.querySelector('.g-menu-empty');
    if (note) note.hidden = shown > 0;
  });
})();
