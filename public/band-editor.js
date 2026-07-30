'use strict';
// Редактор ремешков часов (панель владельца).
// Работает поверх скрытого <textarea name="bands">, формат:
//   # Trail Loop | S/M, M/L
//   - Синий/чёрный | #2b4a7d | 3000
// «#» — коллекция и её размеры, «-» — цветовая вариация с доплатой.
// В интерфейсе вводится ПОЛНАЯ цена часов с этим ремешком, доплата считается сама —
// так же, как в редакторе памяти.
(function () {
  var editor = document.getElementById('band-editor');
  if (!editor) return;
  var raw = document.getElementById('bands-raw');
  var addBtn = document.getElementById('band-add');
  var baseInput = document.querySelector('input[name="price"]');

  function base() { return Number(baseInput && baseInput.value) || 0; }
  function norm(hex) {
    hex = (hex || '').trim();
    if (/^#?[0-9a-fA-F]{3}$/.test(hex)) { hex = hex.replace('#', ''); hex = '#' + hex[0] + hex[0] + hex[1] + hex[1] + hex[2] + hex[2]; }
    if (/^[0-9a-fA-F]{6}$/.test(hex)) hex = '#' + hex;
    if (!/^#[0-9a-fA-F]{6}$/.test(hex)) hex = '#cccccc';
    return hex.toLowerCase();
  }
  function escHtml(s) { return String(s).replace(/[&<>]/g, function (m) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;' }[m]; }); }
  function escAttr(s) { return String(s).replace(/[&<>"]/g, function (m) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[m]; }); }

  // ---- одна цветовая вариация ----
  function makeOption(list, opt) {
    opt = opt || {};
    var row = document.createElement('div');
    row.className = 'band-opt-row';
    row.innerHTML =
      '<input type="color" class="bo-hex" value="' + norm(opt.hex) + '" aria-label="Оттенок ремешка">' +
      '<input type="text" class="bo-name" placeholder="Название цвета">' +
      '<div class="st-price-wrap"><input type="text" class="bo-price" inputmode="numeric" placeholder="Цена с ремешком"><span class="st-cur">₽</span></div>' +
      '<label class="stock-toggle" title="Снимите галочку, если вариант распродан"><input type="checkbox" class="bo-stock"><span>в наличии</span></label>' +
      '<button type="button" class="color-del" title="Удалить вариацию" aria-label="Удалить вариацию">&times;</button>';
    row.querySelector('.bo-name').value = opt.name || '';
    row.querySelector('.bo-price').value = opt.add != null ? String(base() + Number(opt.add || 0)) : '';
    var stock = row.querySelector('.bo-stock');
    stock.checked = opt.inStock !== false;
    row.classList.toggle('row-out', !stock.checked);
    row.querySelectorAll('input').forEach(function (inp) {
      inp.addEventListener('input', sync);
      inp.addEventListener('change', function () { row.classList.toggle('row-out', !stock.checked); sync(); });
    });
    row.querySelector('.color-del').addEventListener('click', function () { row.remove(); sync(); });
    list.appendChild(row);
    return row;
  }

  // ---- коллекция: название, размеры, список вариаций ----
  function makeGroup(group) {
    group = group || {};
    var box = document.createElement('div');
    box.className = 'band-group-box';
    box.innerHTML =
      '<div class="band-group-head">' +
        '<input type="text" class="bg-name" placeholder="Название коллекции, например Trail Loop">' +
        '<input type="text" class="bg-sizes" placeholder="Размеры через запятую: S/M, M/L">' +
        '<button type="button" class="color-del" title="Удалить коллекцию" aria-label="Удалить коллекцию">&times;</button>' +
      '</div>' +
      '<div class="band-opts"></div>' +
      '<button type="button" class="btn btn-sm bg-add-opt">+ Цвет ремешка</button>';
    box.querySelector('.bg-name').value = group.name || '';
    box.querySelector('.bg-sizes').value = (group.sizes || []).join(', ');
    var list = box.querySelector('.band-opts');
    (group.options || []).forEach(function (o) { makeOption(list, o); });
    box.querySelector('.bg-name').addEventListener('input', sync);
    box.querySelector('.bg-sizes').addEventListener('input', sync);
    box.querySelector('.bg-add-opt').addEventListener('click', function () {
      var row = makeOption(list, { inStock: true });
      sync();
      row.querySelector('.bo-name').focus();
    });
    box.querySelector('.band-group-head .color-del').addEventListener('click', function () { box.remove(); sync(); });
    editor.appendChild(box);
    return box;
  }

  function read() {
    var out = [];
    editor.querySelectorAll('.band-group-box').forEach(function (box) {
      var name = box.querySelector('.bg-name').value.trim();
      if (!name) return;
      var sizes = box.querySelector('.bg-sizes').value.split(',').map(function (s) { return s.trim(); }).filter(Boolean);
      var options = [];
      box.querySelectorAll('.band-opt-row').forEach(function (row) {
        var oName = row.querySelector('.bo-name').value.trim();
        if (!oName) return;
        var priceStr = row.querySelector('.bo-price').value.replace(/\s+/g, '');
        var price = Number(priceStr);
        var add = (priceStr === '' || isNaN(price)) ? 0 : Math.max(0, Math.round(price - base()));
        options.push({ name: oName, hex: norm(row.querySelector('.bo-hex').value), add: add, inStock: row.querySelector('.bo-stock').checked });
      });
      if (options.length) out.push({ name: name, sizes: sizes, options: options });
    });
    return out;
  }

  // Списки фото в форме должны знать про вариации ремешков — чтобы снимок можно
  // было привязать к конкретному ремешку, а не только к цвету корпуса.
  function updatePhotoSelects(groups) {
    document.querySelectorAll('select.img-color').forEach(function (sel) {
      var band = sel.querySelector('optgroup[data-bands]');
      if (!band) {
        band = document.createElement('optgroup');
        band.label = 'Ремешки';
        band.setAttribute('data-bands', '1');
        sel.appendChild(band);
      }
      var cur = sel.value;
      band.innerHTML = '';
      groups.forEach(function (g) {
        g.options.forEach(function (o) {
          var value = 'band:' + g.name + '|' + o.name;
          band.insertAdjacentHTML('beforeend',
            '<option value="' + escAttr(value) + '"' + (value === cur ? ' selected' : '') + '>' + escHtml(g.name + ' · ' + o.name) + '</option>');
        });
      });
      if (cur) sel.value = cur;
    });
  }

  function sync() {
    var groups = read();
    raw.value = groups.map(function (g) {
      return '# ' + g.name + ' | ' + g.sizes.join(', ') + '\n'
        + g.options.map(function (o) { return '- ' + o.name + ' | ' + o.hex + ' | ' + o.add + (o.inStock ? '' : ' | нет'); }).join('\n');
    }).join('\n');
    updatePhotoSelects(groups);
  }

  // разбор текущего значения textarea
  (function init() {
    var current = null;
    (raw.value || '').split('\n').forEach(function (line) {
      var l = line.trim();
      if (!l) return;
      if (l.charAt(0) === '#') {
        var parts = l.slice(1).split('|');
        current = { name: (parts[0] || '').trim(), sizes: (parts[1] || '').split(',').map(function (s) { return s.trim(); }).filter(Boolean), options: [] };
        makeGroup(current);
      } else if (l.charAt(0) === '-' && current) {
        var p = l.slice(1).split('|');
        var box = editor.lastElementChild;
        makeOption(box.querySelector('.band-opts'), {
          name: (p[0] || '').trim(), hex: (p[1] || '').trim(),
          add: parseInt(p[2], 10) || 0,
          inStock: !/^(нет|no|0|out)$/i.test((p[3] || '').trim())
        });
      }
    });
  })();

  addBtn.addEventListener('click', function () {
    var box = makeGroup({ sizes: [], options: [{ inStock: true }] });
    sync();
    box.querySelector('.bg-name').focus();
  });
  // смена базовой цены — пересчитать доплаты (введённые полные цены сохраняются)
  if (baseInput) baseInput.addEventListener('input', sync);
  sync();
})();
