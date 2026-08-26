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

  function makeRow(name, hex, inStock) {
    hex = norm(hex);
    var row = document.createElement('div');
    row.className = 'color-row';
    row.dataset.key = 'c' + (makeRow._n = (makeRow._n || 0) + 1);
    row.innerHTML =
      '<input type="color" class="color-hex" value="' + hex + '" aria-label="Оттенок">' +
      '<input type="text" class="color-name" placeholder="Название цвета">' +
      '<input type="text" class="color-hexed" placeholder="#hex" spellcheck="false" maxlength="7" value="' + hex + '">' +
      '<label class="stock-toggle" title="Снимите галочку, если цвет распродан">' +
        '<input type="checkbox" class="color-stock"><span>в наличии</span></label>' +
      '<button type="button" class="color-del" title="Удалить цвет" aria-label="Удалить">&times;</button>';
    var picker = row.querySelector('.color-hex');
    var nameEl = row.querySelector('.color-name');
    var hexed = row.querySelector('.color-hexed');
    var stock = row.querySelector('.color-stock');
    nameEl.value = name || '';
    stock.checked = inStock !== false;
    picker.addEventListener('input', function () { hexed.value = picker.value; sync(); });
    hexed.addEventListener('input', function () { picker.value = norm(hexed.value); sync(); });
    hexed.addEventListener('blur', function () { hexed.value = norm(hexed.value); sync(); });
    nameEl.addEventListener('input', sync);
    stock.addEventListener('change', function () { row.classList.toggle('row-out', !stock.checked); sync(); });
    row.classList.toggle('row-out', !stock.checked);
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
        hex: norm(r.querySelector('.color-hex').value),
        inStock: r.querySelector('.color-stock').checked
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
    // третье поле пишем только для распроданных — строки в наличии остаются как раньше
    raw.value = named.map(function (c) { return c.name + '|' + c.hex + (c.inStock ? '' : '|нет'); }).join('\n');
    updateSelects(named);
    updateUploads(named);
  }

  // инициализация из текущего значения «Название|#hex[|нет]»
  (raw.value || '').split('\n').map(function (l) { return l.trim(); }).filter(Boolean).forEach(function (l) {
    var parts = l.split('|');
    makeRow((parts[0] || '').trim(), (parts[1] || '').trim(), !/^(нет|no|0|out)$/i.test((parts[2] || '').trim()));
  });
  addBtn.addEventListener('click', function () {
    var row = makeRow('', '#cccccc', true);
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
  // Доплата — свойство самой конфигурации, а не разница с текущим содержимым
  // поля цены: в поле вводится ПОЛНАЯ цена, поэтому доплата запоминается у
  // строки, а поле пересчитывается при смене базовой цены. Пересчитывать наоборот
  // (доплату от базы) нельзя — тогда снижение цены товара на 10 000 делает
  // младшую конфигурацию платной на те же 10 000, и витрина показывает прежнюю
  // цену: правка выглядит как несохранившаяся. См. тот же комментарий в
  // option-editor.js — там на этом уже наступили.
  function addOf(row) { var v = row.dataset.add; return v == null || v === '' ? 0 : Number(v) || 0; }
  function readAdd(row) {
    var priceStr = row.querySelector('.st-price').value.replace(/\s+/g, '');
    var price = Number(priceStr);
    row.dataset.add = (priceStr === '' || isNaN(price)) ? '' : String(Math.max(0, Math.round(price - base())));
  }
  function reprice() {
    editor.querySelectorAll('.storage-row').forEach(function (row) {
      if (row.dataset.add == null || row.dataset.add === '') return;
      row.querySelector('.st-price').value = fmt(base() + addOf(row));
    });
  }

  // `add` — доплата к базовой цене (null, когда цена ещё не введена).
  function makeRow(label, add, inStock, forChoice) {
    var row = document.createElement('div');
    row.className = 'storage-row';
    // Привязка конфигурации к выбору в группе («8 ТБ только с M5 Max») своего
    // поля тут не имеет, но обязана пережить сохранение формы: иначе редактор
    // стирал бы её при каждой правке цены.
    if (forChoice) row.dataset.forChoice = forChoice;
    row.innerHTML =
      '<input type="text" class="st-label" placeholder="Например: 256 ГБ">' +
      '<div class="st-price-wrap"><input type="text" class="st-price" inputmode="numeric" placeholder="Цена">' +
      '<span class="st-cur">₽</span></div>' +
      '<label class="stock-toggle" title="Снимите галочку, если вариант распродан">' +
        '<input type="checkbox" class="st-stock"><span>в наличии</span></label>' +
      '<button type="button" class="color-del" title="Удалить вариант" aria-label="Удалить">&times;</button>';
    var stock = row.querySelector('.st-stock');
    row.querySelector('.st-label').value = label || '';
    row.dataset.add = add != null ? String(Math.round(Number(add) || 0)) : '';
    row.querySelector('.st-price').value = add != null ? fmt(base() + (Number(add) || 0)) : '';
    stock.checked = inStock !== false;
    row.classList.toggle('row-out', !stock.checked);
    row.querySelector('.st-label').addEventListener('input', sync);
    row.querySelector('.st-price').addEventListener('input', function () { readAdd(row); sync(); });
    stock.addEventListener('change', function () { row.classList.toggle('row-out', !stock.checked); sync(); });
    row.querySelector('.color-del').addEventListener('click', function () { row.remove(); sync(); });
    editor.appendChild(row);
    return row;
  }

  function sync() {
    var lines = [];
    editor.querySelectorAll('.storage-row').forEach(function (r) {
      var label = r.querySelector('.st-label').value.trim();
      if (!label) return;
      var add = addOf(r);
      lines.push(label + '|' + add + (r.querySelector('.st-stock').checked ? '' : '|нет')
        + (r.dataset.forChoice ? '|?' + r.dataset.forChoice : ''));
    });
    raw.value = lines.join('\n');
  }

  // инициализация из «Метка|доплата[|нет]» — в поле уйдёт «база + доплата»
  (raw.value || '').split('\n').map(function (l) { return l.trim(); }).filter(Boolean).forEach(function (l) {
    var parts = l.split('|');
    var label = (parts[0] || '').trim();
    var add = parseInt(parts[1], 10) || 0;
    var inStock = true, forChoice = '';
    parts.slice(2).forEach(function (part) {
      var v = (part || '').trim();
      if (!v) return;
      // Хвостов «?» бывает несколько — они складываются: метка чипа сама бывает
      // с запятой, поэтому одной парой со списком через запятую её не записать.
      if (v.charAt(0) === '?') {
        var tail = v.slice(1).trim();
        if (tail) forChoice = forChoice ? forChoice + ';' + tail : tail;
      } else if (/^(нет|no|0|out)$/i.test(v)) inStock = false;
    });
    makeRow(label, add, inStock, forChoice);
  });
  // Базовая цена двигает все полные цены товара, доплаты при этом не меняются.
  if (baseInput) baseInput.addEventListener('input', function () { reprice(); sync(); });
  addBtn.addEventListener('click', function () {
    var row = makeRow('', null, true);
    sync();
    row.querySelector('.st-label').focus();
  });
  sync();
})();
