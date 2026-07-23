'use strict';
// Динамический редактор цветов товара (панель владельца).
// Работает поверх скрытого <textarea name="colors"> в формате «Название|#hex»,
// поэтому серверная часть остаётся без изменений.
(function () {
  var editor = document.getElementById('color-editor');
  if (!editor) return;
  var raw = document.getElementById('colors-raw');
  var addBtn = document.getElementById('color-add');
  var uploadsBox = document.getElementById('color-uploads'); // только в режиме редактирования

  function norm(hex) {
    hex = (hex || '').trim();
    if (/^#?[0-9a-fA-F]{3}$/.test(hex)) {
      hex = hex.replace('#', '');
      hex = '#' + hex[0] + hex[0] + hex[1] + hex[1] + hex[2] + hex[2];
    }
    if (/^[0-9a-fA-F]{6}$/.test(hex)) hex = '#' + hex;
    if (!/^#[0-9a-fA-F]{6}$/.test(hex)) hex = '#cccccc';
    return hex.toLowerCase();
  }
  function escHtml(s) { return String(s).replace(/[&<>]/g, function (m) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;' }[m]; }); }
  function escAttr(s) { return String(s).replace(/[&<>"]/g, function (m) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[m]; }); }

  function makeRow(name, hex) {
    hex = norm(hex);
    var row = document.createElement('div');
    row.className = 'color-row';
    row.dataset.key = 'c' + (makeRow._n = (makeRow._n || 0) + 1);
    row.innerHTML =
      '<input type="color" class="color-hex" value="' + hex + '" aria-label="Оттенок">' +
      '<input type="text" class="color-name" placeholder="Название цвета">' +
      '<input type="text" class="color-hexed" placeholder="#hex" spellcheck="false" maxlength="7" value="' + hex + '">' +
      '<button type="button" class="color-del" title="Удалить цвет" aria-label="Удалить">&times;</button>';
    var picker = row.querySelector('.color-hex');
    var nameEl = row.querySelector('.color-name');
    var hexed = row.querySelector('.color-hexed');
    nameEl.value = name || '';
    picker.addEventListener('input', function () { hexed.value = picker.value; sync(); });
    hexed.addEventListener('input', function () { picker.value = norm(hexed.value); sync(); });
    hexed.addEventListener('blur', function () { hexed.value = norm(hexed.value); sync(); });
    nameEl.addEventListener('input', sync);
    row.querySelector('.color-del').addEventListener('click', function () { row.remove(); sync(); });
    editor.appendChild(row);
    return row;
  }

  function readColors() {
    var out = [];
    editor.querySelectorAll('.color-row').forEach(function (r) {
      out.push({
        key: r.dataset.key,
        name: r.querySelector('.color-name').value.trim(),
        hex: norm(r.querySelector('.color-hex').value)
      });
    });
    return out;
  }

  function updateSelects(named) {
    var names = named.map(function (c) { return c.name; });
    document.querySelectorAll('select.img-color').forEach(function (sel) {
      var cur = sel.value;
      var html = '<option value="">— общее —</option>';
      names.forEach(function (n) {
        html += '<option value="' + escAttr(n) + '"' + (n === cur ? ' selected' : '') + '>' + escHtml(n) + '</option>';
      });
      sel.innerHTML = html;
      sel.value = names.indexOf(cur) >= 0 ? cur : '';
    });
  }

  var fileFields = {}; // key -> {field, input}
  function updateUploads(named) {
    if (!uploadsBox) return;
    uploadsBox.style.display = named.length ? '' : 'none';
    var grid = uploadsBox.querySelector('.cu-grid');
    // убрать поля удалённых цветов
    Object.keys(fileFields).forEach(function (k) {
      if (!named.some(function (c) { return c.key === k; })) {
        fileFields[k].field.remove();
        delete fileFields[k];
      }
    });
    named.forEach(function (c, i) {
      var f = fileFields[c.key];
      if (!f) {
        var field = document.createElement('div');
        field.className = 'cu-field';
        var lab = document.createElement('label');
        lab.className = 'cu-label';
        var input = document.createElement('input');
        input.type = 'file'; input.accept = 'image/*'; input.multiple = true;
        field.appendChild(lab); field.appendChild(input);
        f = fileFields[c.key] = { field: field, label: lab, input: input };
      }
      f.label.innerHTML = '<span class="swatch" style="background:' + escAttr(c.hex) + '"></span> ' + escHtml(c.name);
      f.input.name = 'imagesColor_' + i; // индекс = порядок цвета (совпадает с parseColors на сервере)
      grid.appendChild(f.field); // держим порядок
    });
  }

  function sync() {
    var all = readColors();
    var named = all.filter(function (c) { return c.name; });
    raw.value = named.map(function (c) { return c.name + '|' + c.hex; }).join('\n');
    updateSelects(named);
    updateUploads(named);
  }

  // инициализация из текущего значения
  (raw.value || '').split('\n').map(function (l) { return l.trim(); }).filter(Boolean).forEach(function (l) {
    var i = l.indexOf('|');
    makeRow(i >= 0 ? l.slice(0, i).trim() : l.trim(), i >= 0 ? l.slice(i + 1).trim() : '');
  });
  addBtn.addEventListener('click', function () {
    var row = makeRow('', '#cccccc');
    sync();
    row.querySelector('.color-name').focus();
  });
  sync();
})();
