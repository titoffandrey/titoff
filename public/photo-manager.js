'use strict';
// Мгновенная загрузка, удаление и сортировка фотографий товара.
(function () {
  var box = document.getElementById('photo-manager');
  if (!box) return;
  var pid = box.dataset.product;
  var chips = document.getElementById('img-chips');
  var chipsWrap = document.getElementById('img-chips-wrap');
  var MAX_FILE = 6 * 1024 * 1024;
  var uploadQueue = Promise.resolve();
  var orderBusy = false;
  var dragged = null;
  var allOrder = [];
  try { allOrder = JSON.parse(box.dataset.order || '[]'); } catch (e) { allOrder = []; }
  if (!Array.isArray(allOrder)) allOrder = [];

  function esc(s) { return String(s).replace(/[&<>\"]/g, function (m) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '\"': '&quot;' }[m]; }); }
  function colorNames() {
    var out = [];
    document.querySelectorAll('#color-editor .color-name').forEach(function (i) {
      var v = i.value.trim(); if (v) out.push(v);
    });
    return out;
  }
  // варианты привязки снимка: общий, цвет корпуса или конкретная вариация ремешка
  function bandOptions() {
    var out = [];
    document.querySelectorAll('#band-editor .band-group-box').forEach(function (box) {
      var group = box.querySelector('.bg-name').value.trim();
      if (!group) return;
      box.querySelectorAll('.band-opt-row').forEach(function (row) {
        var name = row.querySelector('.bo-name').value.trim();
        if (name) out.push({ key: group + '|' + name, label: group + ' \u00b7 ' + name, hex: row.querySelector('.bo-hex').value });
      });
    });
    return out;
  }
  function optionsHtml(cur, curBand) {
    var html = '<option value="">— общее —</option>' + colorNames().map(function (n) {
      return '<option value="' + esc(n) + '"' + (n === cur ? ' selected' : '') + '>' + esc(n) + '</option>';
    }).join('');
    var bands = bandOptions();
    if (bands.length) {
      html += '<optgroup label="Ремешки" data-bands="1">' + bands.map(function (b) {
        return '<option value="band:' + esc(b.key) + '"' + (b.key === curBand ? ' selected' : '') + '>' + esc(b.label) + '</option>';
      }).join('') + '</optgroup>';
    }
    return html;
  }
  function bandHex(key) {
    var found = '#cccccc';
    bandOptions().forEach(function (b) { if (b.key === key) found = b.hex; });
    return found;
  }
  function bandLabel(key) {
    var found = key;
    bandOptions().forEach(function (b) { if (b.key === key) found = b.label; });
    return found;
  }

  function colorHex(name) {
    var hex = '#cccccc';
    document.querySelectorAll('#color-editor .color-row').forEach(function (r) {
      if (r.querySelector('.color-name').value.trim() === name) hex = r.querySelector('.color-hex').value;
    });
    return hex;
  }
  function groupFor(color, band) {
    color = color || ''; band = band || '';
    var g = null;
    chips.querySelectorAll('.img-group').forEach(function (candidate) {
      if (g) return;
      if (band) { if (candidate.dataset.band === band) g = candidate; }
      else if (!candidate.dataset.band && candidate.dataset.color === color) g = candidate;
    });
    if (!g) {
      g = document.createElement('div');
      g.className = 'img-group';
      if (band) g.dataset.band = band; else g.dataset.color = color;
      var swatch = band
        ? '<span class="swatch" style="background:' + esc(bandHex(band)) + '"></span>'
        : '<span class="swatch' + (color ? '' : ' swatch-any') + '"' + (color ? ' style="background:' + esc(colorHex(color)) + '"' : '') + '></span>';
      var title = band ? esc(bandLabel(band)) : (color ? esc(color) : 'Общие фото');
      g.innerHTML = '<div class="img-group-head">' + swatch + title + '<span class="img-group-count"></span></div><div class="img-chips"></div>';
      chips.appendChild(g);
    }
    g.hidden = false;
    return g;
  }
  function refreshGroups() {
    chips.querySelectorAll('.img-group').forEach(function (g) {
      var items = Array.prototype.slice.call(g.querySelectorAll('.img-chip'));
      var count = g.querySelector('.img-group-count');
      if (count) count.textContent = items.length ? items.length + ' фото' : '';
      items.forEach(function (chip, index) {
        var prev = chip.querySelector('.img-move-prev');
        var next = chip.querySelector('.img-move-next');
        if (prev) prev.disabled = index === 0;
        if (next) next.disabled = index === items.length - 1;
      });
      g.hidden = !items.length;
    });
    if (chipsWrap) chipsWrap.hidden = !chips.querySelector('.img-chip');
  }
  function markMain(src) {
    chips.querySelectorAll('.img-chip').forEach(function (chip) {
      chip.classList.toggle('is-main', !!src && chip.dataset.src === src);
    });
  }
  function addChip(src, color, band) {
    if (chipsWrap) chipsWrap.hidden = false;
    var isFirst = allOrder.length === 0;
    var d = document.createElement('div');
    d.className = 'img-chip' + (isFirst ? ' is-main' : '');
    d.dataset.src = src;
    d.draggable = true;
    d.innerHTML =
      '<div class="img-chip-media"><img src="/uploads/' + esc(src) + '" alt="">' +
      '<span class="img-main-badge">Главное</span>' +
      '<button type="button" class="img-main" title="Сделать главным фото" aria-label="Сделать главным фото">★</button>' +
      '<button type="button" class="img-del" title="Удалить фото" aria-label="Удалить фото">&times;</button></div>' +
      '<div class="img-chip-controls">' +
      '<button type="button" class="img-move img-move-prev" title="Переместить раньше" aria-label="Переместить фото раньше">←</button>' +
      '<select class="img-color" name="imgcolor:' + esc(src) + '" aria-label="Привязка фотографии">' + optionsHtml(color || '', band || '') + '</select>' +
      '<button type="button" class="img-move img-move-next" title="Переместить позже" aria-label="Переместить фото позже">→</button>' +
      '</div>';
    groupFor(color || '', band || '').querySelector('.img-chips').appendChild(d);
    allOrder.push(src);
    refreshGroups();
  }
  function post(url, data) {
    return fetch('/owner/products/' + encodeURIComponent(pid) + url, {
      method: 'POST', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data)
    }).then(function (r) { return r.json(); });
  }

  function setBusy(el, on) {
    if (el) el.classList.toggle('is-busy', !!on);
  }
  function setUploadProgress(input, percent, message, state) {
    var field = input.closest('.photo-upload-field') || input.parentNode;
    var progress = field && field.querySelector('.photo-upload-progress');
    if (!progress) return;
    progress.hidden = false;
    progress.classList.toggle('is-processing', state === 'processing');
    progress.classList.toggle('is-done', state === 'done');
    progress.classList.toggle('is-error', state === 'error');
    var bar = progress.querySelector('.photo-progress-track span');
    if (bar) {
      if (state === 'processing') bar.style.width = '';
      else bar.style.width = (state === 'error' ? 100 : Math.max(0, Math.min(100, percent || 0))) + '%';
    }
    var status = progress.querySelector('.photo-upload-status');
    if (status) status.textContent = message || '';
  }
  function selectionText(input, text) {
    var field = input.closest('.photo-upload-field');
    var selection = field && field.querySelector('.photo-upload-selection');
    if (selection) selection.textContent = text || '';
  }

  function upload(input, files, position, isLast) {
    return new Promise(function (resolve) {
      var tail = position ? ' · ' + position : '';
      var field = input.closest('.photo-upload-field') || input.parentNode;
      var data = new FormData();
      files.forEach(function (file) { data.append('images', file, file.name); });
      if (input.dataset.color) data.append('color', input.dataset.color);
      if (input.dataset.band) data.append('band', input.dataset.band);
      setBusy(field, true);
      input.disabled = true;
      setUploadProgress(input, 0, 'Загрузка' + tail + ' · 0%', 'uploading');

      var xhr = new XMLHttpRequest();
      xhr.open('POST', '/owner/products/' + encodeURIComponent(pid) + '/images/add');
      xhr.upload.addEventListener('progress', function (e) {
        if (!e.lengthComputable) return;
        var value = Math.round(e.loaded / e.total * 100);
        setUploadProgress(input, value, 'Загрузка' + tail + ' · ' + value + '%', 'uploading');
      });
      xhr.upload.addEventListener('load', function () { setUploadProgress(input, 100, 'Обработка фото' + tail + '…', 'processing'); });
      xhr.addEventListener('load', function () {
        var json = null;
        try { json = JSON.parse(xhr.responseText); } catch (e) { json = null; }
        if (xhr.status >= 200 && xhr.status < 300 && json && json.ok) {
          json.images.forEach(function (image) { addChip(image.src, image.color, image.band); });
          setUploadProgress(input, 100, position ? 'Готово · ' + position : 'Готово', 'done');
        } else setUploadProgress(input, 0, 'Ошибка загрузки', 'error');
        finish();
      });
      xhr.addEventListener('error', function () { setUploadProgress(input, 0, 'Нет связи с сервером', 'error'); finish(); });
      function finish() {
        input.disabled = false;
        if (isLast) input.value = '';        // очищаем поле только после всей пачки
        selectionText(input, '');
        setBusy(field, false);
        resolve();
      }
      xhr.send(data);
    });
  }

  box.addEventListener('change', function (e) {
    var input = e.target;
    if (!input.matches || !input.matches('input[type=file][data-auto]')) return;
    var selected = Array.prototype.slice.call(input.files || []);
    if (!selected.length) return;
    var files = selected.filter(function (file) { return file.size <= MAX_FILE; });
    var skipped = selected.length - files.length;
    if (!files.length) {
      setUploadProgress(input, 0, 'Файл больше 6 МБ', 'error');
      input.value = '';
      return;
    }
    selectionText(input, files.length + ' фото выбрано');
    setUploadProgress(input, 0, skipped ? 'В очереди · пропущено: ' + skipped : 'В очереди', 'queued');
    // Отправляем по одному файлу за запрос: сервер обрабатывает фото ImageMagick,
    // и на пачке из десятка снимков один общий запрос висел бы минуты без признаков жизни.
    files.forEach(function (file, i) {
      uploadQueue = uploadQueue.then(function () {
        return upload(input, [file], files.length > 1 ? (i + 1) + ' из ' + files.length : '', i === files.length - 1);
      });
    });
  });

  document.addEventListener('click', function (e) {
    var button = e.target.closest ? e.target.closest('.img-del') : null;
    if (!button) return;
    e.preventDefault();
    var chip = button.closest('.img-chip');
    if (!chip || chip.classList.contains('is-busy')) return;
    var wasMain = chip.classList.contains('is-main');
    chip.classList.add('is-busy');
    post('/images/remove', { src: chip.dataset.src })
      .then(function (json) {
        if (json && json.ok) {
          allOrder = allOrder.filter(function (src) { return src !== chip.dataset.src; });
          chip.remove();
          if (wasMain) markMain(allOrder[0]);
          refreshGroups();
        } else { chip.classList.remove('is-busy'); alert('Не удалось удалить фото'); }
      })
      .catch(function () { chip.classList.remove('is-busy'); alert('Не удалось удалить фото: нет связи с сервером'); });
  });

  document.addEventListener('click', function (e) {
    var button = e.target.closest ? e.target.closest('.img-main') : null;
    if (!button) return;
    e.preventDefault();
    var chip = button.closest('.img-chip');
    if (!chip || chip.classList.contains('is-main')) return;
    var previous = chips.querySelector('.img-chip.is-main');
    chips.querySelectorAll('.img-chip.is-main').forEach(function (item) { item.classList.remove('is-main'); });
    chip.classList.add('is-main');
    post('/images/main', { src: chip.dataset.src }).then(function (json) {
      if (json && json.ok) {
        allOrder = [chip.dataset.src].concat(allOrder.filter(function (src) { return src !== chip.dataset.src; }));
        chip.parentNode.insertBefore(chip, chip.parentNode.firstElementChild);
        refreshGroups();
      } else {
        chip.classList.remove('is-main'); if (previous) previous.classList.add('is-main');
        alert('Не удалось назначить главное фото');
      }
    }).catch(function () { chip.classList.remove('is-main'); if (previous) previous.classList.add('is-main'); });
  });

  chips.addEventListener('change', function (e) {
    var select = e.target;
    if (!select.matches || !select.matches('.img-color')) return;
    var chip = select.closest('.img-chip');
    var color = select.value;
    chip.classList.add('is-busy');
    post('/images/color', { src: chip.dataset.src, color: color })
      .then(function (json) {
        chip.classList.remove('is-busy');
        if (json && json.ok) {
          var targetGroup = groupFor(json.color).querySelector('.img-chips');
          if (chip.classList.contains('is-main')) targetGroup.insertBefore(chip, targetGroup.firstElementChild);
          else targetGroup.appendChild(chip);
          refreshGroups();
        } else alert('Не удалось изменить цвет фото');
      })
      .catch(function () { chip.classList.remove('is-busy'); });
  });

  function moveChip(chip, target, after) {
    if (orderBusy || !chip || !target || chip === target || chip.parentNode !== target.parentNode) return;
    var parent = chip.parentNode;
    var oldChildren = Array.prototype.slice.call(parent.children);
    var src = chip.dataset.src;
    var targetSrc = target.dataset.src;
    var nextOrder = allOrder.filter(function (item) { return item !== src; });
    var targetIndex = nextOrder.indexOf(targetSrc);
    if (targetIndex < 0) return;
    orderBusy = true;
    nextOrder.splice(targetIndex + (after ? 1 : 0), 0, src);
    parent.insertBefore(chip, after ? target.nextSibling : target);
    setBusy(chip, true); setBusy(target, true);
    post('/images/order', { images: nextOrder }).then(function (json) {
      setBusy(chip, false); setBusy(target, false);
      orderBusy = false;
      if (json && json.ok) { allOrder = nextOrder; markMain(allOrder[0]); }
      else { oldChildren.forEach(function (item) { parent.appendChild(item); }); alert('Не удалось изменить порядок фото'); }
      refreshGroups();
    }).catch(function () {
      setBusy(chip, false); setBusy(target, false);
      orderBusy = false;
      oldChildren.forEach(function (item) { parent.appendChild(item); });
      refreshGroups();
    });
  }

  chips.addEventListener('click', function (e) {
    var button = e.target.closest ? e.target.closest('.img-move') : null;
    if (!button || button.disabled) return;
    var chip = button.closest('.img-chip');
    var target = button.classList.contains('img-move-prev') ? chip.previousElementSibling : chip.nextElementSibling;
    moveChip(chip, target, button.classList.contains('img-move-next'));
  });
  chips.addEventListener('dragstart', function (e) {
    dragged = e.target.closest ? e.target.closest('.img-chip') : null;
    if (!dragged) return;
    dragged.classList.add('is-dragging');
    if (e.dataTransfer) { e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', dragged.dataset.src); }
  });
  chips.addEventListener('dragend', function () { if (dragged) dragged.classList.remove('is-dragging'); dragged = null; });
  chips.addEventListener('dragover', function (e) {
    var target = e.target.closest ? e.target.closest('.img-chip') : null;
    if (dragged && target && dragged.parentNode === target.parentNode) e.preventDefault();
  });
  chips.addEventListener('drop', function (e) {
    var target = e.target.closest ? e.target.closest('.img-chip') : null;
    if (!dragged || !target || dragged.parentNode !== target.parentNode) return;
    e.preventDefault();
    var rect = target.getBoundingClientRect();
    moveChip(dragged, target, e.clientX > rect.left + rect.width / 2);
  });

  refreshGroups();
})();
