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
  // Вариация может продаваться только со своим корпусом — как титановый миланский у Apple
  function caseColors() {
    var out = [];
    document.querySelectorAll('#color-editor .color-name').forEach(function (i) {
      var v = i.value.trim(); if (v) out.push(v);
    });
    return out;
  }
  function fillForSelect(sel, current) {
    if (!sel) return;
    sel.innerHTML = '<option value="">для любого корпуса</option>' + caseColors().map(function (n) {
      return '<option value="' + escAttr(n) + '"' + (n === current ? ' selected' : '') + '>только ' + escHtml(n) + '</option>';
    }).join('');
    sel.value = current || '';
  }
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
      '<select class="bo-for" title="Для какого корпуса доступна вариация"></select>' +
      '<label class="stock-toggle" title="Снимите галочку, если вариант распродан"><input type="checkbox" class="bo-stock"><span>в наличии</span></label>' +
      '<button type="button" class="color-del" title="Удалить вариацию" aria-label="Удалить вариацию">&times;</button>';
    row.querySelector('.bo-name').value = opt.name || '';
    fillForSelect(row.querySelector('.bo-for'), opt.forColor || '');
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
    // Список цветов свёрнут: у Series 11 коллекций десять, развёрнутый вид
    // растягивал форму на тысячи пикселей.
    box.innerHTML =
      '<div class="band-group-head">' +
        '<input type="text" class="bg-name" placeholder="Название коллекции, например Trail Loop">' +
        '<input type="text" class="bg-sizes" placeholder="Размеры через запятую: S/M, M/L">' +
        '<button type="button" class="color-del" title="Удалить коллекцию" aria-label="Удалить коллекцию">&times;</button>' +
      '</div>' +
      '<details class="band-fold">' +
        '<summary><span class="band-fold-count"></span></summary>' +
        '<div class="band-opts"></div>' +
        '<button type="button" class="btn btn-sm bg-add-opt">+ Цвет ремешка</button>' +
      '</details>';
    box.querySelector('.bg-name').value = group.name || '';
    box.querySelector('.bg-sizes').value = (group.sizes || []).join(', ');
    var list = box.querySelector('.band-opts');
    (group.options || []).forEach(function (o) { makeOption(list, o); });
    box.querySelector('.bg-name').addEventListener('input', sync);
    box.querySelector('.bg-sizes').addEventListener('input', sync);
    box.querySelector('.bg-add-opt').addEventListener('click', function () {
      box.querySelector('.band-fold').open = true;
      var row = makeOption(list, { inStock: true });
      sync();
      row.querySelector('.bo-name').focus();
    });
    box.querySelector('.band-group-head .color-del').addEventListener('click', function () { box.remove(); sync(); });
    editor.appendChild(box);
    return box;
  }

  function refreshCounts() {
    editor.querySelectorAll('.band-group-box').forEach(function (box) {
      var n = box.querySelectorAll('.band-opt-row').length;
      var el = box.querySelector('.band-fold-count');
      if (el) el.textContent = n + ' ' + (n % 10 === 1 && n % 100 !== 11 ? 'цвет' : (n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 10 || n % 100 >= 20) ? 'цвета' : 'цветов'));
    });
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
        options.push({ name: oName, hex: norm(row.querySelector('.bo-hex').value), add: add,
          inStock: row.querySelector('.bo-stock').checked, forColor: row.querySelector('.bo-for').value });
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

  // Поля загрузки: тайл на вариацию, сгруппированы по коллекциям — иначе список
  // из 46 вариаций (Series 11 титан) растягивал форму на десяток экранов.
  var uploadsBox = document.getElementById('band-uploads');
  var fileFields = {};
  function photoCount(key) {
    var g = document.querySelector('#img-chips .img-group[data-band="' + key.replace(/"/g, '\\"') + '"]');
    return g ? g.querySelectorAll('.img-chip').length : 0;
  }
  function updateUploads(groups) {
    if (!uploadsBox) return;
    var grid = uploadsBox.querySelector('.cu-grid');
    var total = groups.reduce(function (a, g) { return a + g.options.length; }, 0);
    uploadsBox.style.display = total ? '' : 'none';
    var seen = {};
    grid.innerHTML = '';
    groups.forEach(function (g) {
      if (!g.options.length) return;
      var head = document.createElement('div');
      head.className = 'cu-section';
      head.textContent = g.name;
      grid.appendChild(head);
      var row = document.createElement('div');
      row.className = 'cu-row';
      grid.appendChild(row);
      g.options.forEach(function (o) {
        var key = g.name + '|' + o.name;
        seen[key] = true;
        var f = fileFields[key];
        if (!f) {
          var field = document.createElement('div');
          field.className = 'cu-field photo-upload-field';
          var lab = document.createElement('div');
          lab.className = 'cu-label';
          var uploadBox = document.createElement('label');
          uploadBox.className = 'photo-upload-box photo-upload-box-compact';
          var input = document.createElement('input');
          input.type = 'file'; input.accept = 'image/*'; input.multiple = true;
          input.setAttribute('data-auto', '');
          uploadBox.appendChild(input);
          uploadBox.insertAdjacentHTML('beforeend',
            '<span class="photo-upload-icon" aria-hidden="true">＋</span>' +
            '<span class="photo-upload-text"><b>Фото</b><span class="photo-upload-selection"></span></span>');
          var progress = document.createElement('div');
          progress.className = 'photo-upload-progress'; progress.hidden = true;
          progress.innerHTML = '<div class="photo-progress-track"><span></span></div><span class="photo-upload-status" aria-live="polite"></span>';
          // выбор корпуса: один ремешок на разных корпусах выглядит по-разному,
          // поэтому снимок можно сразу отнести к «Натуральному» или «Чёрному»
          var caseSel = document.createElement('select');
          caseSel.className = 'cu-case';
          caseSel.addEventListener('change', function () { input.dataset.color = caseSel.value; });
          field.appendChild(lab); field.appendChild(caseSel); field.appendChild(uploadBox); field.appendChild(progress);
          f = fileFields[key] = { field: field, label: lab, input: input, caseSel: caseSel };
        }
        var n = photoCount(key);
        f.label.innerHTML = '<span class="swatch" style="background:' + escAttr(o.hex) + '"></span>'
          + '<span class="cu-name">' + escHtml(o.name) + '</span>'
          + (n ? '<span class="cu-count">' + n + '</span>' : '');
        f.input.dataset.band = key;      // к какой вариации привязать загруженные фото
        var cases = caseColors();
        if (cases.length > 1) {
          var cur = f.caseSel.value;
          f.caseSel.hidden = false;
          f.caseSel.innerHTML = '<option value="">корпус: любой</option>' + cases.map(function (n) {
            return '<option value="' + escAttr(n) + '"' + (n === cur ? ' selected' : '') + '>' + escHtml(n) + '</option>';
          }).join('');
          f.caseSel.value = cases.indexOf(cur) >= 0 ? cur : '';
          f.input.dataset.color = f.caseSel.value;
        } else {
          f.caseSel.hidden = true;
          f.input.dataset.color = '';
        }
        row.appendChild(f.field);
      });
    });
    Object.keys(fileFields).forEach(function (k) { if (!seen[k]) delete fileFields[k]; });
  }

  function sync() {
    var groups = read();
    raw.value = groups.map(function (g) {
      return '# ' + g.name + ' | ' + g.sizes.join(', ') + '\n'
        + g.options.map(function (o) { return '- ' + o.name + ' | ' + o.hex + ' | ' + o.add + (o.inStock ? '' : ' | нет'); }).join('\n');
    }).join('\n');
    updatePhotoSelects(groups);
    updateUploads(groups);
    refreshCounts();
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
        var tail = p.slice(3).map(function (x) { return String(x || '').trim(); }).filter(Boolean);
        makeOption(box.querySelector('.band-opts'), {
          name: (p[0] || '').trim(), hex: (p[1] || '').trim(),
          add: parseInt(p[2], 10) || 0,
          inStock: !tail.some(function (x) { return /^(нет|no|0|out)$/i.test(x); }),
          forColor: (tail.filter(function (x) { return x.charAt(0) === '@'; })[0] || '').slice(1)
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
