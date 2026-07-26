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
        field.className = 'cu-field photo-upload-field';
        var lab = document.createElement('div');
        lab.className = 'cu-label';
        var uploadBox = document.createElement('label');
        uploadBox.className = 'photo-upload-box photo-upload-box-compact';
        var input = document.createElement('input');
        input.type = 'file'; input.accept = 'image/*'; input.multiple = true;
        input.setAttribute('data-auto', ''); // загрузка сразу после выбора файлов
        uploadBox.appendChild(input);
        uploadBox.insertAdjacentHTML('beforeend',
          '<span class="photo-upload-icon" aria-hidden="true">＋</span>' +
          '<span class="photo-upload-text"><b>Выбрать фото</b><span class="photo-upload-selection"></span></span>');
        var progress = document.createElement('div');
        progress.className = 'photo-upload-progress'; progress.hidden = true;
        progress.innerHTML = '<div class="photo-progress-track"><span></span></div><span class="photo-upload-status" aria-live="polite"></span>';
        field.appendChild(lab); field.appendChild(uploadBox); field.appendChild(progress);
        f = fileFields[c.key] = { field: field, label: lab, input: input };
      }
      f.label.innerHTML = '<span class="swatch" style="background:' + escAttr(c.hex) + '"></span> ' + escHtml(c.name);
      f.input.dataset.color = c.name; // к какому цвету привязать загруженные фото
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

// ===== Редактор вариантов памяти: метка + СВОЯ цена на каждый вариант =====
// Хранение прежнее: <textarea name="storages"> в формате «Метка|доплата»,
// но в интерфейсе вводится полная цена варианта, доплата считается сама.
(function () {
  var editor = document.getElementById('storage-editor');
  if (!editor) return;
  var raw = document.getElementById('storages-raw');
  var addBtn = document.getElementById('storage-add');
  var baseInput = document.querySelector('input[name="price"]');

  function base() { return Number(baseInput && baseInput.value) || 0; }
  function fmt(n) { return String(Math.round(n)); }

  function makeRow(label, price) {
    var row = document.createElement('div');
    row.className = 'storage-row';
    row.innerHTML =
      '<input type="text" class="st-label" placeholder="Например: 256 ГБ">' +
      '<div class="st-price-wrap"><input type="text" class="st-price" inputmode="numeric" placeholder="Цена">' +
      '<span class="st-cur">₽</span></div>' +
      '<button type="button" class="color-del" title="Удалить вариант" aria-label="Удалить">&times;</button>';
    row.querySelector('.st-label').value = label || '';
    row.querySelector('.st-price').value = price != null ? fmt(price) : '';
    row.querySelector('.st-label').addEventListener('input', sync);
    row.querySelector('.st-price').addEventListener('input', sync);
    row.querySelector('.color-del').addEventListener('click', function () { row.remove(); sync(); });
    editor.appendChild(row);
    return row;
  }

  function sync() {
    var b = base();
    var lines = [];
    editor.querySelectorAll('.storage-row').forEach(function (r) {
      var label = r.querySelector('.st-label').value.trim();
      if (!label) return;
      var priceStr = r.querySelector('.st-price').value.replace(/\s+/g, '');
      var price = Number(priceStr);
      var add = (priceStr === '' || isNaN(price)) ? 0 : Math.max(0, Math.round(price - b));
      lines.push(label + '|' + add);
    });
    raw.value = lines.join('\n');
  }

  // инициализация из «Метка|доплата» -> полная цена (база + доплата)
  (raw.value || '').split('\n').map(function (l) { return l.trim(); }).filter(Boolean).forEach(function (l) {
    var i = l.indexOf('|');
    var label = i >= 0 ? l.slice(0, i).trim() : l.trim();
    var add = i >= 0 ? (parseInt(l.slice(i + 1), 10) || 0) : 0;
    makeRow(label, base() + add);
  });
  // при смене базовой цены пересчитываем доплаты (введённые полные цены сохраняются)
  if (baseInput) baseInput.addEventListener('input', sync);
  addBtn.addEventListener('click', function () {
    var row = makeRow('', null);
    sync();
    row.querySelector('.st-label').focus();
  });
  sync();
})();
