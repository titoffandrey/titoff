/* Витрина: корзина (localStorage), оформление заказа, отзывы. Без зависимостей. */
(function () {
  'use strict';
  var KEY = 'cart_v1';
  var CUR = window.__CURRENCY__ || '₽';
  var POS = window.__CURPOS__ || 'after';

  function money(n) {
    var v = Number(n || 0).toLocaleString('ru-RU');
    return POS === 'before' ? CUR + v : v + ' ' + CUR;
  }
  function miniPlaceholder() {
    return '<svg viewBox="0 0 40 40" xmlns="http://www.w3.org/2000/svg"><rect width="40" height="40" fill="#eef1f6"/><rect x="13" y="9" width="14" height="22" rx="3" fill="none" stroke="#b8c0cc" stroke-width="2"/></svg>';
  }

  var Cart = {
    items: [],
    load: function () { try { this.items = JSON.parse(localStorage.getItem(KEY)) || []; } catch (e) { this.items = []; } },
    save: function () { localStorage.setItem(KEY, JSON.stringify(this.items)); this.updateBadge(); },
    add: function (id, name, price, qty, opts) {
      opts = opts || {};
      var ex = this.items.find(function (i) { return i.id === id; });
      if (ex) { ex.qty += qty; ex.name = name; ex.price = price; ex.storage = opts.storage || ''; ex.color = opts.color || ''; }
      else this.items.push({ id: id, name: name, price: price, qty: qty, storage: opts.storage || '', color: opts.color || '' });
      this.save(); this.render();
      toast(name + ' — в корзине');
    },
    setQty: function (id, qty) {
      var it = this.items.find(function (i) { return i.id === id; });
      if (!it) return;
      it.qty = Math.max(1, Math.min(99, qty));
      this.save(); this.render();
    },
    remove: function (id) { this.items = this.items.filter(function (i) { return i.id !== id; }); this.save(); this.render(); },
    clear: function () { this.items = []; this.save(); this.render(); },
    count: function () { return this.items.reduce(function (a, i) { return a + i.qty; }, 0); },
    total: function () { return this.items.reduce(function (a, i) { return a + i.price * i.qty; }, 0); },
    has: function (id) { return this.items.some(function (i) { return i.id === id; }); },
    updateBadge: function () {
      var b = document.getElementById('cart-badge');
      if (b) { var c = this.count(); b.textContent = c; b.hidden = c === 0; }
      syncCartButtons();
    },
    open: function () { this.render(); document.body.classList.add('cart-open'); },
    close: function () { document.body.classList.remove('cart-open'); },
    render: function () {
      var wrap = document.getElementById('cart-items');
      var foot = document.getElementById('cart-foot');
      if (!wrap || !foot) return;
      if (!this.items.length) {
        wrap.innerHTML = '<div class="cart-empty">Корзина пуста</div>';
        foot.innerHTML = '';
        return;
      }
      wrap.innerHTML = this.items.map(function (i) {
        return '<div class="cart-item">'
          + '<div class="cart-item-media">' + miniPlaceholder() + '</div>'
          + '<div class="cart-item-info">'
          + '<div class="cart-item-name">' + escapeHtml(i.name) + '</div>'
          + '<div class="cart-item-price">' + money(i.price) + '</div>'
          + '<div class="cart-item-controls">'
          + '<div class="cart-qty"><button data-act="dec" data-id="' + i.id + '">−</button><span>' + i.qty + '</span><button data-act="inc" data-id="' + i.id + '">+</button></div>'
          + '<button class="cart-remove" data-act="rm" data-id="' + i.id + '">Удалить</button>'
          + '</div></div></div>';
      }).join('');
      foot.innerHTML =
        '<div class="cart-total"><span>Итого</span><span>' + money(this.total()) + '</span></div>'
        + '<div class="checkout-fields" id="checkout-fields">'
        + '<div class="field"><label>Ваше имя</label><input type="text" id="co-name" placeholder="Имя"></div>'
        + '<div class="field"><label>Контакт для связи *</label><input type="text" id="co-contact" placeholder="Telegram / телефон / e-mail"></div>'
        + '<div class="field"><label>Комментарий</label><textarea id="co-comment" rows="2" placeholder="Город, удобное время связи и т.д."></textarea></div>'
        + '</div>'
        + '<button class="btn btn-primary btn-block btn-lg" id="checkout-btn">Оформить заказ</button>'
        + '<p class="form-msg" id="order-msg" hidden></p>';
    }
  };
  window.Cart = Cart;

  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  // Кнопка «в корзину» как переключатель: показывает статус в зависимости от корзины.
  function setBtnState(btn, inCart) {
    if (!btn.dataset.label) btn.dataset.label = btn.textContent.trim();
    if (inCart) { btn.classList.add('in-cart'); btn.textContent = '✓ В корзине'; }
    else { btn.classList.remove('in-cart'); btn.textContent = btn.dataset.label; }
  }
  function syncCartButtons() {
    var btns = document.querySelectorAll('.add-to-cart');
    for (var i = 0; i < btns.length; i++) {
      if (btns[i].disabled) continue;
      setBtnState(btns[i], Cart.has(btns[i].dataset.id));
    }
  }

  var toastTimer;
  function toast(msg) {
    var t = document.getElementById('toast'); if (!t) return;
    t.textContent = msg; t.hidden = false;
    requestAnimationFrame(function () { t.classList.add('show'); });
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.classList.remove('show'); setTimeout(function () { t.hidden = true; }, 250); }, 2200);
  }

  // Таймеры обратного отсчёта для горящих скидок
  function initCountdowns() {
    var els = document.querySelectorAll('[data-deal-until]');
    if (!els.length) return;
    function fmt(ms) {
      if (ms <= 0) return null;
      var s = Math.floor(ms / 1000);
      var d = Math.floor(s / 86400); s -= d * 86400;
      var h = Math.floor(s / 3600); s -= h * 3600;
      var m = Math.floor(s / 60); s -= m * 60;
      var pad = function (n) { return String(n).padStart(2, '0'); };
      return (d > 0 ? d + 'д ' : '') + pad(h) + ':' + pad(m) + ':' + pad(s);
    }
    function tick() {
      var now = Date.now();
      els.forEach(function (el) {
        var until = Number(el.getAttribute('data-deal-until'));
        var left = fmt(until - now);
        var target = el.querySelector('.dt-val') || el;
        if (left === null) { el.classList.add('deal-ended'); target.textContent = 'Завершено'; }
        else target.textContent = left;
      });
    }
    tick();
    setInterval(tick, 1000);
  }

  document.addEventListener('DOMContentLoaded', function () {
    Cart.load();
    Cart.updateBadge();
    initCountdowns();

    // Кнопки "в корзину"
    document.addEventListener('click', function (e) {
      var btn = e.target.closest('.add-to-cart');
      if (btn) {
        e.preventDefault(); e.stopPropagation();
        if (btn.disabled) return;
        var id = btn.dataset.id;
        if (Cart.has(id)) {
          // повторное нажатие — убрать из корзины, кнопка вернётся в исходный вид
          Cart.remove(id);
          toast('Убрано из корзины');
        } else {
          var qty = 1;
          if (btn.hasAttribute('data-qty-source')) {
            var box = document.querySelector('[data-qty] .qty-input');
            if (box) qty = Math.max(1, parseInt(box.value, 10) || 1);
          }
          Cart.add(id, btn.dataset.name, Number(btn.dataset.price), qty, { storage: btn.dataset.storage, color: btn.dataset.color });
        }
        return;
      }
      // управление количеством в корзине
      var act = e.target.closest('[data-act]');
      if (act) {
        var id = act.dataset.id;
        var item = Cart.items.find(function (i) { return i.id === id; });
        if (act.dataset.act === 'inc' && item) Cart.setQty(id, item.qty + 1);
        else if (act.dataset.act === 'dec' && item) Cart.setQty(id, item.qty - 1);
        else if (act.dataset.act === 'rm') Cart.remove(id);
        return;
      }
      // оформление заказа
      if (e.target.id === 'checkout-btn') {
        var fields = document.getElementById('checkout-fields');
        if (fields && !fields.classList.contains('show')) { fields.classList.add('show'); return; }
        submitOrder(e.target);
      }
    });

    // Галерея товара в стиле apple.com: стрелки по бокам + точки-индикатор, без миниатюр.
    // При выборе цвета показываются фото этого цвета + общие (сначала цветовые).
    var gallerySetColor = null;
    (function () {
      var gal = document.getElementById('gallery');
      if (!gal || !gal.dataset.imgs) return;
      var all;
      try { all = JSON.parse(gal.dataset.imgs); } catch (e) { return; }
      if (!all.length) return;
      var main = document.getElementById('gallery-main');
      var dotsBox = document.getElementById('g-dots');
      var prev = document.getElementById('g-prev');
      var next = document.getElementById('g-next');
      var visible = all.slice();
      var idx = 0;

      function renderSlide() {
        if (main) main.innerHTML = '<img src="' + visible[idx].src + '" alt="">';
        if (dotsBox) {
          var dots = dotsBox.querySelectorAll('.g-dot');
          for (var i = 0; i < dots.length; i++) dots[i].classList.toggle('active', i === idx);
        }
      }
      function renderDots() {
        if (!dotsBox) return;
        if (visible.length < 2) { dotsBox.innerHTML = ''; return; }
        var html = '';
        for (var i = 0; i < visible.length; i++) html += '<button type="button" class="g-dot" aria-label="Фото ' + (i + 1) + '"></button>';
        dotsBox.innerHTML = html;
      }
      function updateArrows() {
        var show = visible.length > 1;
        if (prev) prev.style.display = show ? '' : 'none';
        if (next) next.style.display = show ? '' : 'none';
      }
      function go(dir) { idx = (idx + dir + visible.length) % visible.length; renderSlide(); }

      if (prev) prev.addEventListener('click', function () { go(-1); });
      if (next) next.addEventListener('click', function () { go(1); });
      if (dotsBox) dotsBox.addEventListener('click', function (e) {
        var d = e.target.closest('.g-dot'); if (!d) return;
        idx = Array.prototype.indexOf.call(dotsBox.querySelectorAll('.g-dot'), d);
        renderSlide();
      });
      // свайп на мобильных
      var tx = null;
      if (main) {
        main.addEventListener('touchstart', function (e) { tx = e.touches[0].clientX; }, { passive: true });
        main.addEventListener('touchend', function (e) {
          if (tx === null) return;
          var dx = e.changedTouches[0].clientX - tx; tx = null;
          if (Math.abs(dx) > 40 && visible.length > 1) go(dx < 0 ? 1 : -1);
        }, { passive: true });
      }

      gallerySetColor = function (color) {
        var hasColorPhotos = all.some(function (s) { return s.color; });
        if (!hasColorPhotos) return;
        var matched = all.filter(function (s) { return s.color === color; });
        if (matched.length) {
          visible = matched.concat(all.filter(function (s) { return !s.color; }));
        } else {
          visible = all.slice(); // для цвета фото нет — показываем всё
        }
        idx = 0;
        renderDots(); updateArrows(); renderSlide();
      };

      renderDots(); updateArrows(); renderSlide();
    })();

    // Количество на странице товара
    var qtyBox = document.querySelector('[data-qty]');
    if (qtyBox) {
      qtyBox.addEventListener('click', function (e) {
        var b = e.target.closest('.qty-btn'); if (!b) return;
        var input = qtyBox.querySelector('.qty-input');
        var v = Math.max(1, (parseInt(input.value, 10) || 1) + parseInt(b.dataset.delta, 10));
        input.value = v;
      });
    }

    // Ввод рейтинга (звёзды): общая оценка + аспекты (доставка/сервис/цена)
    document.querySelectorAll('.rate-input').forEach(function (rate) {
      var hidden = rate.parentNode.querySelector('input[type="hidden"]');
      function paint(v) { rate.querySelectorAll('.rate-star').forEach(function (s) { s.classList.toggle('on', Number(s.dataset.v) <= v); }); }
      paint(Number(hidden ? hidden.value : 5) || 5);
      rate.addEventListener('click', function (e) {
        var s = e.target.closest('.rate-star'); if (!s) return;
        var v = Number(s.dataset.v); if (hidden) hidden.value = v; rate.dataset.value = v; paint(v);
      });
      rate.addEventListener('mouseover', function (e) { var s = e.target.closest('.rate-star'); if (s) paint(Number(s.dataset.v)); });
      rate.addEventListener('mouseleave', function () { paint(Number(hidden ? hidden.value : rate.dataset.value) || 5); });
    });

    // Выбор варианта (цвет + память) на странице товара
    var addBtn = document.querySelector('.add-to-cart[data-qty-source]');
    if (addBtn && (document.getElementById('colors') || document.getElementById('storages'))) {
      var basePrice = Number(addBtn.dataset.basePrice) || 0;
      var baseName = addBtn.dataset.baseName || '';
      var vstate = { color: '', storageLabel: '', storageAdd: 0 };
      var fc = document.querySelector('#colors .swatch'); if (fc) vstate.color = fc.dataset.color;
      var fs = document.querySelector('#storages .storage-opt'); if (fs) { vstate.storageLabel = fs.dataset.label; vstate.storageAdd = Number(fs.dataset.add) || 0; }
      function applyVariant() {
        var total = basePrice + vstate.storageAdd;
        var pe = document.getElementById('product-price'); if (pe) pe.textContent = money(total);
        addBtn.dataset.price = total;
        addBtn.dataset.name = baseName + (vstate.storageLabel ? ' ' + vstate.storageLabel : '') + (vstate.color ? ', ' + vstate.color : '');
        addBtn.dataset.storage = vstate.storageLabel;
        addBtn.dataset.color = vstate.color;
      }
      var colorsEl = document.getElementById('colors');
      if (colorsEl) colorsEl.addEventListener('click', function (e) {
        var sw = e.target.closest('.swatch'); if (!sw) return;
        colorsEl.querySelectorAll('.swatch').forEach(function (x) { x.classList.remove('active'); });
        sw.classList.add('active'); vstate.color = sw.dataset.color;
        var sc = document.getElementById('sel-color'); if (sc) sc.textContent = sw.dataset.color;
        if (gallerySetColor) gallerySetColor(sw.dataset.color);
        applyVariant();
      });
      if (vstate.color && gallerySetColor) gallerySetColor(vstate.color);
      var storagesEl = document.getElementById('storages');
      if (storagesEl) storagesEl.addEventListener('click', function (e) {
        var so = e.target.closest('.storage-opt'); if (!so) return;
        storagesEl.querySelectorAll('.storage-opt').forEach(function (x) { x.classList.remove('active'); });
        so.classList.add('active'); vstate.storageLabel = so.dataset.label; vstate.storageAdd = Number(so.dataset.add) || 0;
        applyVariant();
      });
      applyVariant();
    }

    // Сортировка отзывов
    var revList = document.getElementById('reviews-list');
    var toolbar = document.querySelector('.reviews-toolbar');
    if (revList && toolbar) {
      toolbar.addEventListener('click', function (e) {
        var b = e.target.closest('.sort-btn'); if (!b) return;
        toolbar.querySelectorAll('.sort-btn').forEach(function (x) { x.classList.remove('active'); });
        b.classList.add('active');
        var mode = b.dataset.sort;
        var arts = Array.prototype.slice.call(revList.querySelectorAll('.review'));
        arts.sort(function (a, z) {
          if (mode === 'new') return Number(z.dataset.ts) - Number(a.dataset.ts);
          var d = Number(z.dataset.rating) - Number(a.dataset.rating); if (d) return d;
          return Number(z.dataset.len) - Number(a.dataset.len);
        });
        arts.forEach(function (a) { revList.appendChild(a); });
      });
    }

    // Отправка отзыва
    var rf = document.getElementById('review-form');
    if (rf) {
      rf.addEventListener('submit', function (e) {
        e.preventDefault();
        var msg = document.getElementById('review-msg');
        var fd = new FormData(rf);
        fetch('/api/reviews', { method: 'POST', body: fd })
          .then(function (r) { return r.json(); })
          .then(function (d) {
            msg.hidden = false;
            if (d.ok) {
              msg.className = 'form-msg ok';
              msg.textContent = d.message || 'Спасибо! Ваш отзыв отправлен.';
              rf.reset();
              var h = document.getElementById('rating-value'); if (h) h.value = 5;
              document.querySelectorAll('.rate-star').forEach(function (s) { s.classList.add('on'); });
            } else {
              msg.className = 'form-msg err';
              msg.textContent = d.error || 'Не удалось отправить отзыв';
            }
          })
          .catch(function () { msg.hidden = false; msg.className = 'form-msg err'; msg.textContent = 'Ошибка сети'; });
      });
    }
  });

  function submitOrder(btn) {
    var msg = document.getElementById('order-msg');
    var contact = (document.getElementById('co-contact') || {}).value || '';
    if (!contact.trim()) { if (msg) { msg.hidden = false; msg.className = 'form-msg err'; msg.textContent = 'Укажите контакт для связи'; } return; }
    btn.disabled = true; btn.textContent = 'Отправляем...';
    var payload = {
      items: Cart.items.map(function (i) { return { id: i.id, qty: i.qty, storage: i.storage || '', color: i.color || '' }; }),
      customerName: (document.getElementById('co-name') || {}).value || '',
      contact: contact,
      comment: (document.getElementById('co-comment') || {}).value || ''
    };
    fetch('/api/order', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (d.ok) {
          Cart.clear();
          var items = document.getElementById('cart-items');
          var foot = document.getElementById('cart-foot');
          if (items) items.innerHTML = '<div class="cart-empty"><h3 style="color:var(--text)">Заказ принят!</h3><p>Номер ' + escapeHtml(d.number) + '.<br>Менеджер свяжется с вами в ближайшее время.</p></div>';
          if (foot) foot.innerHTML = '<button class="btn btn-block" onclick="Cart.close()">Готово</button>';
        } else {
          btn.disabled = false; btn.textContent = 'Оформить заказ';
          if (msg) { msg.hidden = false; msg.className = 'form-msg err'; msg.textContent = d.error || 'Не удалось оформить заказ'; }
        }
      })
      .catch(function () {
        btn.disabled = false; btn.textContent = 'Оформить заказ';
        if (msg) { msg.hidden = false; msg.className = 'form-msg err'; msg.textContent = 'Ошибка сети'; }
      });
  }
})();
