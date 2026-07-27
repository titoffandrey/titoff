'use strict';
// Удобная форма товара: растущее поле характеристик, предпросмотр и прогресс
// первой загрузки фотографий при создании товара.
(function () {
  var form = document.querySelector('form[data-product-form]');
  if (!form) return;

  var specs = form.querySelector('textarea[name="specs"]');
  function growSpecs() {
    if (!specs) return;
    specs.style.height = 'auto';
    specs.style.height = Math.max(280, specs.scrollHeight + 2) + 'px';
  }
  if (specs) {
    specs.addEventListener('input', growSpecs);
    growSpecs();
  }

  // ===== Цена: раскрытие блока акции и живой предпросмотр того, что увидит покупатель =====
  var dealBox = document.getElementById('deal-box');
  var dealToggle = document.getElementById('deal-toggle');
  var priceInput = form.querySelector('input[name="price"]');
  var oldInput = form.querySelector('input[name="oldPrice"]');
  var dealInput = form.querySelector('input[name="hotDealPrice"]');
  var preview = document.getElementById('price-preview');

  function money(n) { return Math.round(n).toLocaleString('ru-RU').replace(/,/g, ' ') + ' ₽'; }
  function num(el) { var n = Number(el && el.value); return isFinite(n) && n > 0 ? n : 0; }

  function renderPreview() {
    if (!preview) return;
    var base = num(priceInput);
    if (!base) { preview.hidden = true; return; }
    var deal = dealToggle && dealToggle.checked ? num(dealInput) : 0;
    var old = num(oldInput);
    var eff = (deal > 0 && deal < base) ? deal : base;          // та же логика, что в lib/deals.js
    var cmp = (deal > 0 && deal < base) ? base : (old > eff ? old : 0);
    var pct = cmp ? Math.round((1 - eff / cmp) * 100) : 0;
    var html = 'Покупатель увидит: <b>' + money(eff) + '</b>';
    if (cmp) html += '<span class="pp-old">' + money(cmp) + '</span><span class="pp-pct">−' + pct + '%</span>';
    if (dealToggle && dealToggle.checked && !(deal > 0 && deal < base)) {
      html += ' — <span class="pp-pct">скидка не сработает: цена по акции должна быть меньше базовой</span>';
    } else if (old && old <= base) {
      html += ' — <span class="pp-pct">старая цена ниже базовой, её не покажем</span>';
    }
    preview.innerHTML = html;
    preview.hidden = false;
  }

  if (dealToggle && dealBox) {
    dealToggle.addEventListener('change', function () {
      dealBox.classList.toggle('is-on', dealToggle.checked);
      if (dealToggle.checked && dealInput && !dealInput.value && num(priceInput)) {
        dealInput.value = Math.round(num(priceInput) * 0.9);   // подставим −10%, чтобы не заполнять вручную
      }
      renderPreview();
    });
  }
  [priceInput, oldInput, dealInput].forEach(function (el) { if (el) el.addEventListener('input', renderPreview); });
  renderPreview();

  var MAX_FILE = 6 * 1024 * 1024;
  var states = [];

  function fieldFor(input) { return input.closest('.photo-upload-field'); }
  function progressFor(field) { return field && field.querySelector('.photo-upload-progress'); }
  function setProgress(field, percent, message, state) {
    var progress = progressFor(field);
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

  function fileSummary(files) {
    var bytes = files.reduce(function (sum, file) { return sum + (file.size || 0); }, 0);
    return files.length + ' фото · ' + (bytes / 1024 / 1024).toFixed(bytes > 10 * 1024 * 1024 ? 0 : 1) + ' МБ';
  }

  function render(state) {
    state.urls.forEach(function (url) { URL.revokeObjectURL(url); });
    state.urls = [];
    state.queue.innerHTML = '';
    if (!state.files.length) state.input.value = '';
    var selection = state.field.querySelector('.photo-upload-selection');
    if (selection) selection.textContent = state.files.length ? fileSummary(state.files) : '';
    state.files.forEach(function (file, index) {
      var url = URL.createObjectURL(file);
      state.urls.push(url);
      var item = document.createElement('div');
      item.className = 'photo-queue-item';
      item.dataset.name = file.name;
      item.innerHTML = '<img alt=""><div class="photo-queue-actions">' +
        '<button type="button" data-action="prev" data-index="' + index + '" aria-label="Переместить раньше">←</button>' +
        '<button type="button" data-action="next" data-index="' + index + '" aria-label="Переместить позже">→</button>' +
        '<button type="button" data-action="remove" data-index="' + index + '" aria-label="Убрать фотографию">×</button>' +
        '</div>';
      item.querySelector('img').src = url;
      item.querySelector('img').alt = file.name;
      state.queue.appendChild(item);
    });
  }

  form.querySelectorAll('input[type="file"]:not([data-auto])').forEach(function (input) {
    if (!input.name) return;
    var field = fieldFor(input);
    var queue = field && field.querySelector('.photo-queue');
    if (!field || !queue) return;
    var state = { input: input, field: field, queue: queue, files: [], urls: [] };
    states.push(state);
    input.addEventListener('change', function () {
      var selected = Array.prototype.slice.call(input.files || []);
      var tooLarge = selected.filter(function (file) { return file.size > MAX_FILE; }).length;
      state.files = selected.filter(function (file) { return file.size <= MAX_FILE; });
      render(state);
      if (tooLarge) setProgress(field, 0, 'Пропущено файлов: ' + tooLarge + ' (больше 6 МБ)', 'error');
      else {
        var progress = progressFor(field);
        if (progress) progress.hidden = true;
      }
    });
    queue.addEventListener('click', function (event) {
      var button = event.target.closest('button[data-action]');
      if (!button) return;
      var index = Number(button.dataset.index);
      if (!Number.isInteger(index) || !state.files[index]) return;
      if (button.dataset.action === 'remove') state.files.splice(index, 1);
      else {
        var other = button.dataset.action === 'prev' ? index - 1 : index + 1;
        if (other < 0 || other >= state.files.length) return;
        var file = state.files[index]; state.files[index] = state.files[other]; state.files[other] = file;
      }
      render(state);
    });
  });

  function formData() {
    var data = new FormData(form);
    states.forEach(function (state) {
      data.delete(state.input.name);
      state.files.forEach(function (file) { data.append(state.input.name, file, file.name); });
    });
    return data;
  }

  form.addEventListener('submit', function (event) {
    var state = states.find(function (entry) { return entry.files.length; });
    if (!state) return;
    event.preventDefault();
    if (form.classList.contains('is-submitting')) return;
    form.classList.add('is-submitting');
    var submit = form.querySelector('button[type="submit"]');
    if (submit) submit.disabled = true;
    setProgress(state.field, 0, 'Загрузка · 0%', 'uploading');

    var xhr = new XMLHttpRequest();
    xhr.open((form.method || 'POST').toUpperCase(), form.action);
    xhr.upload.addEventListener('progress', function (e) {
      if (!e.lengthComputable) return;
      var value = Math.round(e.loaded / e.total * 100);
      setProgress(state.field, value, 'Загрузка · ' + value + '%', 'uploading');
    });
    xhr.upload.addEventListener('load', function () { setProgress(state.field, 100, 'Обработка фото…', 'processing'); });
    xhr.addEventListener('load', function () {
      if (xhr.status >= 200 && xhr.status < 400) {
        setProgress(state.field, 100, 'Готово', 'done');
        window.location.href = xhr.responseURL || '/owner/products';
        return;
      }
      form.classList.remove('is-submitting');
      if (submit) submit.disabled = false;
      setProgress(state.field, 0, 'Ошибка загрузки', 'error');
    });
    xhr.addEventListener('error', function () {
      form.classList.remove('is-submitting');
      if (submit) submit.disabled = false;
      setProgress(state.field, 0, 'Нет связи с сервером', 'error');
    });
    xhr.send(formData());
  });
})();
