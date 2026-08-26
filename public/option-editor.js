'use strict';
// Редактор дополнительных характеристик товара (панель владельца).
// Работает поверх скрытого <textarea name="options">, формат:
//   # Покрытие дисплея | Выберите, какое стекло вам подходит
//   - Стандартное стекло | 0
//   - Нанотекстурное стекло | 15000 | нет | @1 ТБ, 2 ТБ
// «#» — группа и подпись под её заголовком, «-» — значение с доплатой.
// В интерфейсе вводится ПОЛНАЯ цена товара с этим значением, доплата считается
// сама — так же, как в редакторах памяти и ремешков.
(function () {
  var editor = document.getElementById('option-editor');
  if (!editor) return;
  var raw = document.getElementById('options-raw');
  var addBtn = document.getElementById('option-add');
  var baseInput = document.querySelector('input[name="price"]');

  function base() { return Number(baseInput && baseInput.value) || 0; }
  // Доплата — свойство самого значения («+5000 за физическую SIM»), а НЕ разница
  // с текущим содержимым поля цены. Поэтому она живёт у строки, а поле показывает
  // полную цену «база + доплата» и пересчитывается, когда базовая цена меняется.
  //
  // Раньше при правке базовой цены пересчитывалась доплата: владелец снижал цену
  // товара на 10 000, поля полных цен оставались прежними — и базовое значение
  // группы получало доплату +10 000. Витрина показывает «база + доплата первого
  // доступного значения», то есть ровно прежнюю цену, и правка выглядела как
  // «цена не сохранилась». У товара с тремя группами разница складывалась трижды,
  // и цена на витрине не возвращалась к прежней, а вырастала.
  function addOf(row) { var v = row.dataset.add; return v == null || v === '' ? 0 : Number(v) || 0; }
  function readAdd(row) {
    var priceStr = row.querySelector('.ov-price').value.replace(/\s+/g, '');
    var price = Number(priceStr);
    row.dataset.add = (priceStr === '' || isNaN(price)) ? '' : String(Math.max(0, Math.round(price - base())));
  }
  function reprice() {
    editor.querySelectorAll('.option-val-row').forEach(function (row) {
      if (row.dataset.add == null || row.dataset.add === '') return;
      row.querySelector('.ov-price').value = String(base() + addOf(row));
    });
  }
  function escHtml(s) { return String(s).replace(/[&<>]/g, function (m) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;' }[m]; }); }
  function escAttr(s) { return String(s).replace(/[&<>"]/g, function (m) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[m]; }); }
  // Конфигурации берём из живого редактора памяти: значение можно ограничить
  // частью из них (нанотекстура у iPad Pro бывает только от 1 ТБ).
  function storageLabels() {
    var out = [];
    document.querySelectorAll('#storage-editor .st-label').forEach(function (i) {
      var v = i.value.trim(); if (v && out.indexOf(v) < 0) out.push(v);
    });
    return out;
  }
  // Ограничение хранится списком меток. Их набор меняется, пока владелец правит
  // конфигурации, поэтому в поле остаётся то, что он выбрал, даже если метки
  // временно нет: иначе строка «@2 ТБ» пропадала от одной опечатки в памяти.
  function fillOnly(box, current) {
    var labels = storageLabels();
    current = (current || []).filter(Boolean);
    current.forEach(function (v) { if (labels.indexOf(v) < 0) labels.push(v); });
    if (!labels.length) { box.innerHTML = '<span class="muted small">добавьте конфигурации выше</span>'; return; }
    box.innerHTML = labels.map(function (l) {
      return '<label class="ov-only-item"><input type="checkbox" value="' + escAttr(l) + '"'
        + (current.indexOf(l) >= 0 ? ' checked' : '') + '><span>' + escHtml(l) + '</span></label>';
    }).join('');
  }

  // ---- одно значение характеристики ----
  function makeValue(list, value) {
    value = value || {};
    var row = document.createElement('div');
    row.className = 'option-val-row';
    // Основные поля — своей строкой, «только для конфигураций» — под ней.
    // Через flex-wrap это не сделать: у полей формы ширина 100%, и подпись
    // значения уносила цену с галочкой на следующую строку.
    row.innerHTML =
      '<div class="ov-main">' +
        '<input type="text" class="ov-label" placeholder="Например: Нанотекстурное стекло">' +
        '<div class="st-price-wrap"><input type="text" class="ov-price" inputmode="numeric" placeholder="Цена с этим значением"><span class="st-cur">₽</span></div>' +
        '<label class="stock-toggle" title="Снимите галочку, если вариант распродан"><input type="checkbox" class="ov-stock"><span>в наличии</span></label>' +
        '<button type="button" class="color-del" title="Удалить значение" aria-label="Удалить значение">&times;</button>' +
      '</div>' +
      '<details class="ov-only-fold"><summary>Только для конфигураций</summary><div class="ov-only"></div></details>';
    row.querySelector('.ov-label').value = value.label || '';
    row.dataset.add = value.add != null ? String(Number(value.add || 0)) : '';
    row.querySelector('.ov-price').value = value.add != null ? String(base() + Number(value.add || 0)) : '';
    var stock = row.querySelector('.ov-stock');
    stock.checked = value.inStock !== false;
    row.classList.toggle('row-out', !stock.checked);
    var only = row.querySelector('.ov-only');
    fillOnly(only, value.forStorage || []);
    if ((value.forStorage || []).length) row.querySelector('.ov-only-fold').open = true;
    // Привязка к выбору в другой группе («128 ГБ только с M5 Max») своего поля в
    // редакторе не имеет, но пережить сохранение обязана: без переноса хвоста
    // форма стирала бы её при каждой правке, как когда-то forColor у ремешков.
    if (value.forChoice) row.dataset.forChoice = value.forChoice;
    row.querySelector('.ov-label').addEventListener('input', sync);
    row.querySelector('.ov-price').addEventListener('input', function () { readAdd(row); sync(); });
    stock.addEventListener('change', function () { row.classList.toggle('row-out', !stock.checked); sync(); });
    only.addEventListener('change', sync);
    row.querySelector('.color-del').addEventListener('click', function () { row.remove(); sync(); });
    list.appendChild(row);
    return row;
  }

  // ---- группа: заголовок, подсказка и список значений ----
  function makeGroup(group) {
    group = group || {};
    var box = document.createElement('div');
    box.className = 'option-group-box';
    box.innerHTML =
      '<div class="option-group-head">' +
        '<input type="text" class="og-name" placeholder="Название, например Покрытие дисплея">' +
        '<input type="text" class="og-hint" placeholder="Подсказка под заголовком (необязательно)">' +
        '<button type="button" class="color-del" title="Удалить характеристику" aria-label="Удалить характеристику">&times;</button>' +
      '</div>' +
      '<div class="option-vals"></div>' +
      '<button type="button" class="btn btn-sm og-add-val">+ Значение</button>';
    box.querySelector('.og-name').value = group.name || '';
    box.querySelector('.og-hint').value = group.hint || '';
    var list = box.querySelector('.option-vals');
    (group.values || []).forEach(function (v) { makeValue(list, v); });
    box.querySelector('.og-name').addEventListener('input', sync);
    box.querySelector('.og-hint').addEventListener('input', sync);
    box.querySelector('.og-add-val').addEventListener('click', function () {
      var row = makeValue(list, { inStock: true });
      sync();
      row.querySelector('.ov-label').focus();
    });
    box.querySelector('.option-group-head .color-del').addEventListener('click', function () { box.remove(); sync(); });
    editor.appendChild(box);
    return box;
  }

  function read() {
    var out = [];
    editor.querySelectorAll('.option-group-box').forEach(function (box) {
      var name = box.querySelector('.og-name').value.trim();
      if (!name) return;
      var values = [];
      box.querySelectorAll('.option-val-row').forEach(function (row) {
        var label = row.querySelector('.ov-label').value.trim();
        if (!label) return;
        var add = addOf(row);
        var forStorage = [];
        row.querySelectorAll('.ov-only input:checked').forEach(function (c) { forStorage.push(c.value); });
        values.push({ label: label, add: add, inStock: row.querySelector('.ov-stock').checked,
          forStorage: forStorage, forChoice: row.dataset.forChoice || '' });
      });
      if (values.length) out.push({ name: name, hint: box.querySelector('.og-hint').value.trim(), values: values });
    });
    return out;
  }

  function sync() {
    var groups = read();
    var lines = [];
    groups.forEach(function (g) {
      lines.push('# ' + g.name + ' | ' + g.hint);
      g.values.forEach(function (v) {
        lines.push('- ' + v.label + ' | ' + v.add + (v.inStock ? '' : ' | нет')
          + v.forStorage.map(function (only) { return ' | @' + only; }).join('')
          + (v.forChoice ? ' | ?' + v.forChoice : ''));
      });
    });
    raw.value = lines.join('\n');
  }

  // ---- разбор текущего значения textarea ----
  function parse(text) {
    var groups = [];
    (text || '').split('\n').forEach(function (line) {
      var l = line.trim();
      if (!l) return;
      if (l.charAt(0) === '#') {
        var head = l.slice(1).split('|');
        groups.push({ name: (head[0] || '').trim(), hint: (head[1] || '').trim(), values: [] });
      } else if (l.charAt(0) === '-' && groups.length) {
        var parts = l.slice(1).split('|');
        var value = { label: (parts[0] || '').trim(), add: parseInt(parts[1], 10) || 0, inStock: true, forStorage: [], forChoice: '' };
        parts.slice(2).forEach(function (part) {
          var v = (part || '').trim();
          if (!v) return;
          // Хвостов «@» и «?» бывает несколько — они складываются, а не заменяют
          // друг друга: метка конфигурации и метка чипа сами бывают с запятой,
          // поэтому одним списком через запятую их не записать.
          if (v.charAt(0) === '@') {
            v.slice(1).split(',').map(function (s) { return s.trim(); }).filter(Boolean).forEach(function (only) {
              if (value.forStorage.indexOf(only) === -1) value.forStorage.push(only);
            });
          } else if (v.charAt(0) === '?') {
            var tail = v.slice(1).trim();
            if (tail) value.forChoice = value.forChoice ? value.forChoice + ';' + tail : tail;
          } else if (/^(нет|no|0|out)$/i.test(v)) value.inStock = false;
        });
        groups[groups.length - 1].values.push(value);
      }
    });
    return groups;
  }

  parse(raw.value).forEach(makeGroup);
  // Базовая цена двигает все полные цены товара, а доплаты остаются прежними.
  if (baseInput) baseInput.addEventListener('input', function () { reprice(); sync(); });
  var storageEditor = document.getElementById('storage-editor');
  if (storageEditor) storageEditor.addEventListener('input', function () {
    editor.querySelectorAll('.option-val-row').forEach(function (row) {
      var current = [];
      row.querySelectorAll('.ov-only input:checked').forEach(function (c) { current.push(c.value); });
      fillOnly(row.querySelector('.ov-only'), current);
    });
    sync();
  });
  addBtn.addEventListener('click', function () {
    var box = makeGroup({ values: [{ add: 0, inStock: true }] });
    sync();
    box.querySelector('.og-name').focus();
  });
  sync();
})();
