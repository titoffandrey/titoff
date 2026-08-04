'use strict';
// Порядок товаров в каталоге (панель владельца).
// Витрина показывает карточки в порядке файла, поэтому порядок строк здесь и
// есть порядок товаров на главной. Строку можно перетащить за ручку или
// подвинуть стрелками; каждое изменение сразу уходит на сервер.
//
// Сервер принимает только точную перестановку текущего списка, поэтому послать
// «половину каталога» и потерять товары через этот путь нельзя. Если запрос не
// прошёл — возвращаем строки на прежние места, чтобы список не расходился с тем,
// что сохранено.
(function () {
  var body = document.getElementById('product-order');
  if (!body) return;
  var msg = document.getElementById('order-msg');
  var order = [];
  try { order = JSON.parse(body.dataset.order || '[]'); } catch (e) { order = []; }
  if (!Array.isArray(order) || !order.length) return;
  var busy = false;
  var dragged = null;
  var msgTimer = null;

  function rows() { return Array.prototype.slice.call(body.querySelectorAll('tr[data-id]')); }

  function say(text, isError) {
    if (!msg) return;
    clearTimeout(msgTimer);
    msg.hidden = false;
    msg.className = 'form-msg' + (isError ? ' err' : ' ok');
    msg.textContent = text;
    if (!isError) msgTimer = setTimeout(function () { msg.hidden = true; }, 2500);
  }

  // Номера строк и крайние стрелки зависят от позиции, поэтому обновляются
  // после каждого перемещения.
  function repaint() {
    var list = rows();
    list.forEach(function (row, i) {
      var num = row.querySelector('.a-order-num');
      if (num) num.textContent = String(i + 1);
      var up = row.querySelector('.a-move-up');
      var down = row.querySelector('.a-move-down');
      if (up) up.disabled = busy || i === 0;
      if (down) down.disabled = busy || i === list.length - 1;
    });
  }

  function save(previous) {
    var next = rows().map(function (row) { return row.dataset.id; });
    busy = true;
    body.classList.add('is-busy');
    repaint();
    fetch('/owner/products/order', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: next })
    })
      .then(function (r) { return r.json(); })
      .then(function (json) {
        if (json && json.ok) { order = next; say('Порядок сохранён'); }
        else { restore(previous); say('Не удалось сохранить порядок', true); }
      })
      .catch(function () { restore(previous); say('Нет связи с сервером — порядок не сохранён', true); })
      .then(function () {
        busy = false;
        body.classList.remove('is-busy');
        repaint();
      });
  }

  // Возврат к сохранённому порядку: строки переставляются по прежнему списку,
  // а не перезагрузкой страницы — так владелец видит, что именно откатилось.
  function restore(previous) {
    var byId = {};
    rows().forEach(function (row) { byId[row.dataset.id] = row; });
    previous.forEach(function (id) { if (byId[id]) body.appendChild(byId[id]); });
  }

  function move(row, target, after) {
    if (busy || !row || !target || row === target) return;
    var previous = rows().map(function (r) { return r.dataset.id; });
    body.insertBefore(row, after ? target.nextSibling : target);
    save(previous);
  }

  body.addEventListener('click', function (e) {
    var button = e.target.closest ? e.target.closest('.a-move') : null;
    if (!button || button.disabled) return;
    var row = button.closest('tr');
    var up = button.classList.contains('a-move-up');
    var target = up ? row.previousElementSibling : row.nextElementSibling;
    move(row, target, !up);
  });

  body.addEventListener('dragstart', function (e) {
    dragged = e.target.closest ? e.target.closest('tr[data-id]') : null;
    if (!dragged || busy) { dragged = null; return; }
    dragged.classList.add('is-dragging');
    if (e.dataTransfer) { e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', dragged.dataset.id); }
  });
  body.addEventListener('dragend', function () {
    if (dragged) dragged.classList.remove('is-dragging');
    dragged = null;
  });
  body.addEventListener('dragover', function (e) {
    var target = e.target.closest ? e.target.closest('tr[data-id]') : null;
    if (dragged && target && target !== dragged) e.preventDefault();
  });
  body.addEventListener('drop', function (e) {
    var target = e.target.closest ? e.target.closest('tr[data-id]') : null;
    if (!dragged || !target || target === dragged) return;
    e.preventDefault();
    // Ниже середины строки — встаём после неё, выше — перед: так перетаскивание
    // и вверх, и вниз попадает туда, куда целится курсор.
    var rect = target.getBoundingClientRect();
    move(dragged, target, e.clientY > rect.top + rect.height / 2);
  });

  repaint();
})();
