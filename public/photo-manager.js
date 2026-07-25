'use strict';
// Мгновенная работа с фото товара: загрузка сразу после выбора файлов
// и удаление по клику (файл удаляется и с сервера). Без перезагрузки страницы.
(function () {
  var box = document.getElementById('photo-manager');
  if (!box) return;
  var pid = box.dataset.product;
  var chips = document.getElementById('img-chips');
  var chipsWrap = document.getElementById('img-chips-wrap');

  function esc(s) { return String(s).replace(/[&<>"]/g, function (m) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[m]; }); }
  function colorNames() {
    var out = [];
    document.querySelectorAll('#color-editor .color-name').forEach(function (i) {
      var v = i.value.trim(); if (v) out.push(v);
    });
    return out;
  }
  function optionsHtml(cur) {
    return '<option value="">— общее —</option>' + colorNames().map(function (n) {
      return '<option value="' + esc(n) + '"' + (n === cur ? ' selected' : '') + '>' + esc(n) + '</option>';
    }).join('');
  }
  // --- группы по цветам ---
  function colorHex(name) {
    var hex = '#cccccc';
    document.querySelectorAll('#color-editor .color-row').forEach(function (r) {
      if (r.querySelector('.color-name').value.trim() === name) hex = r.querySelector('.color-hex').value;
    });
    return hex;
  }
  function groupFor(color) {
    color = color || '';
    var g = chips.querySelector('.img-group[data-color="' + (window.CSS && CSS.escape ? CSS.escape(color) : color) + '"]');
    if (!g) {
      g = document.createElement('div');
      g.className = 'img-group';
      g.dataset.color = color;
      g.innerHTML = '<div class="img-group-head"><span class="swatch' + (color ? '' : ' swatch-any') + '"' +
        (color ? ' style="background:' + esc(colorHex(color)) + '"' : '') + '></span>' +
        (color ? esc(color) : 'Общие фото') + '<span class="img-group-count"></span></div><div class="img-chips"></div>';
      chips.appendChild(g);
    }
    g.hidden = false;
    return g;
  }
  function refreshGroups() {
    chips.querySelectorAll('.img-group').forEach(function (g) {
      var n = g.querySelectorAll('.img-chip').length;
      var c = g.querySelector('.img-group-count');
      if (c) c.textContent = n ? n + ' фото' : '';
      g.hidden = !n;
    });
    if (chipsWrap) chipsWrap.hidden = !chips.querySelector('.img-chip');
  }
  function addChip(src, color) {
    if (chipsWrap) chipsWrap.hidden = false;
    var d = document.createElement('div');
    d.className = 'img-chip';
    d.dataset.src = src;
    d.innerHTML =
      '<div class="img-chip-media"><img src="/uploads/' + esc(src) + '" alt="">' +
      '<span class="img-main-badge">Главное</span>' +
      '<button type="button" class="img-main" title="Сделать главным фото" aria-label="Сделать главным фото">★</button>' +
      '<button type="button" class="img-del" title="Удалить фото" aria-label="Удалить фото">&times;</button></div>' +
      '<select class="img-color" name="imgcolor:' + esc(src) + '">' + optionsHtml(color || '') + '</select>';
    groupFor(color || '').querySelector('.img-chips').appendChild(d);
    refreshGroups();
  }
  function post(url, data) {
    return fetch('/owner/products/' + encodeURIComponent(pid) + url, {
      method: 'POST', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data)
    }).then(function (r) { return r.json(); });
  }

  function setBusy(el, on) {
    if (!el) return;
    el.classList.toggle('is-busy', !!on);
  }

  // --- загрузка сразу после выбора файлов ---
  box.addEventListener('change', function (e) {
    var inp = e.target;
    if (!inp.matches || !inp.matches('input[type=file][data-auto]')) return;
    if (!inp.files || !inp.files.length) return;
    var field = inp.closest('.field') || inp.parentNode;
    var fd = new FormData();
    for (var i = 0; i < inp.files.length; i++) fd.append('images', inp.files[i]);
    if (inp.dataset.color) fd.append('color', inp.dataset.color);
    setBusy(field, true);
    inp.disabled = true;
    fetch('/owner/products/' + encodeURIComponent(pid) + '/images/add', { method: 'POST', body: fd, credentials: 'same-origin' })
      .then(function (r) { return r.json(); })
      .then(function (j) {
        if (j && j.ok) j.images.forEach(function (im) { addChip(im.src, im.color); });
        else alert('Не удалось загрузить фото' + (j && j.error ? ' (' + j.error + ')' : ''));
      })
      .catch(function () { alert('Не удалось загрузить фото: нет связи с сервером'); })
      .finally(function () { inp.disabled = false; inp.value = ''; setBusy(field, false); });
  });

  // --- удаление по клику (сразу и на сервере) ---
  document.addEventListener('click', function (e) {
    var btn = e.target.closest ? e.target.closest('.img-del') : null;
    if (!btn) return;
    e.preventDefault();
    var chip = btn.closest('.img-chip');
    if (!chip || chip.classList.contains('is-busy')) return;
    var wasMain = chip.classList.contains('is-main');
    chip.classList.add('is-busy');
    post('/images/remove', { src: chip.dataset.src })
      .then(function (j) {
        if (j && j.ok) {
          chip.remove();
          // если удалили главное — главным становится первое оставшееся
          if (wasMain) {
            var first = chips.querySelector('.img-chip');
            if (first) {
              first.classList.add('is-main');
              post('/images/main', { src: first.dataset.src });
            }
          }
          refreshGroups();
        } else { chip.classList.remove('is-busy'); alert('Не удалось удалить фото'); }
      })
      .catch(function () { chip.classList.remove('is-busy'); alert('Не удалось удалить фото: нет связи с сервером'); });
  });

  // --- выбор главного фото ---
  document.addEventListener('click', function (e) {
    var btn = e.target.closest ? e.target.closest('.img-main') : null;
    if (!btn) return;
    e.preventDefault();
    var chip = btn.closest('.img-chip');
    if (!chip || chip.classList.contains('is-main')) return;
    var prev = chips.querySelector('.img-chip.is-main');
    chips.querySelectorAll('.img-chip.is-main').forEach(function (c) { c.classList.remove('is-main'); });
    chip.classList.add('is-main');
    post('/images/main', { src: chip.dataset.src }).then(function (j) {
      if (!j || !j.ok) {
        chip.classList.remove('is-main');
        if (prev) prev.classList.add('is-main');
        alert('Не удалось назначить главное фото');
      }
    }).catch(function () {
      chip.classList.remove('is-main');
      if (prev) prev.classList.add('is-main');
    });
  });

  // --- смена цвета: сохраняем сразу и переносим в нужную группу ---
  chips.addEventListener('change', function (e) {
    var sel = e.target;
    if (!sel.matches || !sel.matches('.img-color')) return;
    var chip = sel.closest('.img-chip');
    var color = sel.value;
    chip.classList.add('is-busy');
    post('/images/color', { src: chip.dataset.src, color: color })
      .then(function (j) {
        chip.classList.remove('is-busy');
        if (j && j.ok) {
          groupFor(j.color).querySelector('.img-chips').appendChild(chip);
          refreshGroups();
        } else alert('Не удалось изменить цвет фото');
      })
      .catch(function () { chip.classList.remove('is-busy'); });
  });

  refreshGroups();
})();
