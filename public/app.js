/* Витрина: корзина (localStorage), оформление заказа, отзывы. Без зависимостей. */
(function () {
  'use strict';
  var KEY = 'cart_v1';
  var ANALYTICS_DISABLED_KEY = 'analytics_disabled_v1';
  var analyticsTimer = null;
  var CUR = window.__CURRENCY__ || '₽';
  var POS = window.__CURPOS__ || 'after';
  var MAX_CART_LINES = 100;
  var lastCartFocus = null;

  function money(n) {
    var amount = Number(n);
    var v = (Number.isFinite(amount) ? amount : 0).toLocaleString('ru-RU');
    var currency = escapeHtml(CUR);
    return POS === 'before' ? currency + v : v + ' ' + currency;
  }
  function miniPlaceholder() {
    return '<svg viewBox="0 0 40 40" xmlns="http://www.w3.org/2000/svg"><rect width="40" height="40" fill="#eef1f6"/><rect x="13" y="9" width="14" height="22" rx="3" fill="none" stroke="#b8c0cc" stroke-width="2"/></svg>';
  }
  // Миниатюра позиции: фото товара, если оно есть, иначе прежняя заглушка
  function itemThumb(i) {
    return i.img
      ? '<img src="/uploads/' + escapeHtml(i.img) + '" alt="" loading="lazy" decoding="async">'
      : miniPlaceholder();
  }

  // ===== Страница оформления (/checkout) =====
  // Позиции и форма — на отдельной странице: список остаётся видимым и прокручивается
  // сам по себе, а не выталкивается формой, как было в выдвижной корзине.
  function renderCheckoutPage() {
    var items = document.getElementById('checkout-items');
    var side = document.getElementById('checkout-side');
    if (!items || !side) return;

    if (!Cart.items.length) {
      items.innerHTML = '<div class="checkout-empty"><p>Корзина пуста</p>'
        + '<a class="btn btn-primary" href="/">Перейти в каталог</a></div>';
      side.innerHTML = '';
      return;
    }

    items.innerHTML = Cart.items.map(function (i) {
      var k = escapeHtml(itemKey(i));
      return '<article class="co-item">'
        + '<div class="co-item-media">' + itemThumb(i) + '</div>'
        + '<div class="co-item-body">'
        + '<h3 class="co-item-name">' + escapeHtml(i.name) + '</h3>'
        + '<div class="co-item-price">' + money(i.price) + '</div>'
        + '<div class="co-item-controls">'
        + '<div class="cart-qty"><button type="button" data-act="dec" data-key="' + k + '" aria-label="Меньше">−</button>'
        + '<span>' + i.qty + '</span>'
        + '<button type="button" data-act="inc" data-key="' + k + '" aria-label="Больше">+</button></div>'
        + '<button type="button" class="cart-remove" data-act="rm" data-key="' + k + '">Удалить</button>'
        + '</div></div>'
        + '<div class="co-item-sum">' + money(i.price * i.qty) + '</div>'
        + '</article>';
    }).join('');

    // форму перерисовываем только один раз, чтобы не стирать введённое при смене количества
    if (!side.dataset.ready) {
      side.dataset.ready = '1';
      side.innerHTML = '<div class="co-summary">'
        + '<div class="co-total"><span>Итого</span><b id="co-total-sum">' + money(Cart.total()) + '</b></div>'
        + '<div class="field"><label for="co-name">Ваше имя</label><input type="text" id="co-name" maxlength="100" placeholder="Имя"></div>'
        + '<div class="field"><label for="co-contact">Контакт для связи *</label><input type="text" id="co-contact" maxlength="120" placeholder="Telegram / телефон / e-mail" required></div>'
        + '<div class="field"><label for="co-comment">Комментарий</label><textarea id="co-comment" rows="3" maxlength="1000" placeholder="Город, удобное время связи и т.д."></textarea></div>'
        + '<button type="button" class="btn btn-primary btn-block btn-lg btn-checkout" id="checkout-submit">'
        + '<span class="btn-checkout-label">Оформить заказ</span>'
        + '<span class="btn-checkout-sum" id="co-btn-sum">' + money(Cart.total()) + '</span></button>'
        + '<p class="form-msg" id="order-msg" hidden></p>'
        + '<p class="form-legal-note">Данные используются только для обработки заявки. <a href="/privacy" target="_blank" rel="noopener">Политика конфиденциальности</a></p>'
        + '</div>';
    } else {
      var t = document.getElementById('co-total-sum'); if (t) t.textContent = money(Cart.total());
      var b = document.getElementById('co-btn-sum'); if (b) b.textContent = money(Cart.total());
    }
  }

  // Ключ позиции: один товар в разных вариантах (память/цвет) — это разные строки корзины.
  function itemKey(i) { return JSON.stringify([i.id, i.storage || '', i.color || '']); }
  function cleanText(value, max) { return String(value == null ? '' : value).slice(0, max); }
  function cleanItem(item) {
    if (!item || typeof item !== 'object') return null;
    var id = cleanText(item.id, 100);
    var price = Number(item.price);
    var qty = Math.floor(Number(item.qty));
    if (!id || !Number.isFinite(price) || price < 0 || price > 1e12) return null;
    return {
      id: id,
      name: cleanText(item.name, 240) || 'Товар',
      price: price,
      qty: Number.isFinite(qty) ? Math.max(1, Math.min(99, qty)) : 1,
      storage: cleanText(item.storage, 80),
      color: cleanText(item.color, 40),
      // имя файла фото — чтобы в корзине была миниатюра товара, а не заглушка
      img: /^[\w.\-]{1,120}$/.test(String(item.img || '')) ? String(item.img) : ''
    };
  }

  var Cart = {
    items: [],
    load: function () {
      try { this.items = JSON.parse(localStorage.getItem(KEY)) || []; } catch (e) { this.items = []; }
      if (!Array.isArray(this.items)) this.items = [];
      this.items = this.items.slice(0, MAX_CART_LINES).map(cleanItem).filter(Boolean);
    },
    save: function () { try { localStorage.setItem(KEY, JSON.stringify(this.items)); } catch (e) {} this.updateBadge(); },
    find: function (key) { return this.items.find(function (i) { return itemKey(i) === key; }); },
    add: function (id, name, price, qty, opts) {
      opts = opts || {};
      var next = cleanItem({ id: id, name: name, price: price, qty: qty, storage: opts.storage || '', color: opts.color || '', img: opts.img || '' });
      if (!next) return;
      var ex = this.find(itemKey(next));
      if (ex) { ex.qty = Math.min(99, ex.qty + next.qty); ex.price = next.price; ex.name = next.name; ex.img = next.img || ex.img; }
      else if (this.items.length < MAX_CART_LINES) this.items.push(next);
      else { toast('В корзине слишком много разных товаров'); return; }
      this.save(); this.render();
      toast(name + ' — в корзине');
    },
    setQty: function (key, qty) {
      var it = this.find(key);
      if (!it) return;
      it.qty = Math.max(1, Math.min(99, Math.floor(Number(qty)) || 1));
      this.save(); this.render();
    },
    remove: function (key) { this.items = this.items.filter(function (i) { return itemKey(i) !== key; }); this.save(); this.render(); },
    clear: function () { this.items = []; this.save(); this.render(); },
    count: function () { return this.items.reduce(function (a, i) { return a + Number(i.qty); }, 0); },
    total: function () { return this.items.reduce(function (a, i) { return a + Number(i.price) * Number(i.qty); }, 0); },
    has: function (id) { return this.items.some(function (i) { return i.id === id; }); },
    updateBadge: function () {
      var b = document.getElementById('cart-badge');
      if (b) { var c = this.count(); b.textContent = c; b.hidden = c === 0; }
      syncCartButtons();
    },
    open: function () {
      this.render();
      lastCartFocus = document.activeElement;
      document.body.classList.add('cart-open');
      var drawer = document.getElementById('cart-drawer');
      if (drawer) drawer.setAttribute('aria-hidden', 'false');
      var close = drawer && drawer.querySelector('.cart-head .icon-btn');
      if (close) close.focus();
    },
    close: function () {
      document.body.classList.remove('cart-open');
      var drawer = document.getElementById('cart-drawer');
      if (drawer) drawer.setAttribute('aria-hidden', 'true');
      if (lastCartFocus && typeof lastCartFocus.focus === 'function') lastCartFocus.focus();
    },
    render: function () {
      renderCheckoutPage();                       // страница /checkout, если мы на ней
      var wrap = document.getElementById('cart-items');
      var foot = document.getElementById('cart-foot');
      if (!wrap || !foot) return;
      wrap.classList.remove('cart-items-success');
      var cartTitle = document.querySelector('#cart-drawer .cart-head h2');
      if (cartTitle) cartTitle.textContent = 'Корзина';
      if (!this.items.length) {
        wrap.innerHTML = '<div class="cart-empty">Корзина пуста</div>';
        foot.innerHTML = '';
        return;
      }
      wrap.innerHTML = this.items.map(function (i) {
        var k = escapeHtml(itemKey(i));
        return '<div class="cart-item">'
          + '<div class="cart-item-media">' + itemThumb(i) + '</div>'
          + '<div class="cart-item-info">'
          + '<div class="cart-item-name">' + escapeHtml(i.name) + '</div>'
          + '<div class="cart-item-price">' + money(i.price) + '</div>'
          + '<div class="cart-item-controls">'
          + '<div class="cart-qty"><button type="button" data-act="dec" data-key="' + k + '" aria-label="Меньше">−</button><span>' + i.qty + '</span><button type="button" data-act="inc" data-key="' + k + '" aria-label="Больше">+</button></div>'
          + '<button type="button" class="cart-remove" data-act="rm" data-key="' + k + '">Удалить</button>'
          + '</div></div></div>';
      }).join('');
      foot.innerHTML =
        '<div class="cart-total"><span>Итого</span><span>' + money(this.total()) + '</span></div>'
        + '<a class="btn btn-primary btn-block btn-lg btn-checkout" href="/checkout" id="checkout-btn">'
        + '<span class="btn-checkout-label">Оформить заказ</span>'
        + '<span class="btn-checkout-sum">' + money(this.total()) + '</span></a>';
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
    var was = btn.classList.contains('in-cart');
    if (inCart) {
      btn.classList.add('in-cart');
      // подпись = то, что произойдёт по клику (открыть корзину и оформить),
      // а галочка и цвет показывают, что товар уже добавлен
      btn.innerHTML = '<span class="btn-check" aria-hidden="true">✓</span>Оформить заказ';
      if (!was) {                       // короткий отклик на добавление
        btn.classList.add('just-added');
        setTimeout(function () { btn.classList.remove('just-added'); }, 420);
      }
    } else {
      btn.classList.remove('in-cart', 'just-added');
      btn.textContent = btn.dataset.label;
    }
  }
  function syncCartButtons() {
    var btns = document.querySelectorAll('.add-to-cart');
    for (var i = 0; i < btns.length; i++) {
      var b = btns[i];
      if (b.disabled) continue;
      setBtnState(b, !!Cart.find(itemKey({ id: b.dataset.id, storage: b.dataset.storage || '', color: b.dataset.color || '' })));
    }
  }
  // Товар уже в корзине → отдельная страница оформления
  function goToCheckout() {
    if (document.getElementById('checkout-page')) return;   // уже на ней
    location.href = '/checkout';
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

  function analyticsPayload(includeDetails) {
    var payload = { path: location.pathname };
    if (includeDetails) {
      var connection = navigator.connection || navigator.mozConnection || navigator.webkitConnection || {};
      var params = new URLSearchParams(location.search);
      payload.referrer = document.referrer;
      payload.client = {
        screen: window.screen ? window.screen.width + '×' + window.screen.height : '',
        viewport: window.innerWidth + '×' + window.innerHeight,
        language: navigator.language || '',
        timezone: (Intl.DateTimeFormat().resolvedOptions() || {}).timeZone || '',
        platform: (navigator.userAgentData && navigator.userAgentData.platform) || navigator.platform || '',
        cpuCores: navigator.hardwareConcurrency || null,
        deviceMemory: navigator.deviceMemory || null,
        connection: connection.effectiveType || connection.type || '',
        utmSource: params.get('utm_source') || '',
        utmMedium: params.get('utm_medium') || '',
        utmCampaign: params.get('utm_campaign') || ''
      };
    }
    return JSON.stringify(payload);
  }

  function startAnalyticsHeartbeat() {
    if (analyticsTimer) return;
    analyticsTimer = setInterval(function () {
      if (document.visibilityState !== 'visible') return;
      fetch('/api/analytics/ping', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: analyticsPayload(false), keepalive: true
      }).catch(function () {});
    }, 60000);
  }

  function analyticsDisabled() {
    try { return localStorage.getItem(ANALYTICS_DISABLED_KEY) === '1'; } catch (e) { return false; }
  }

  function startAnalytics(includeReferrer) {
    if (analyticsDisabled()) return;
    fetch('/api/analytics/start', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: analyticsPayload(includeReferrer), keepalive: true
    }).then(function (r) { if (r.ok) startAnalyticsHeartbeat(); }).catch(function () {});
  }

  function initAnalyticsControls() {
    var disable = document.getElementById('analytics-disable');
    if (!disable) return;
    if (analyticsDisabled()) {
      disable.textContent = 'Включить метрику на этом устройстве';
      disable.addEventListener('click', function () {
        try { localStorage.removeItem(ANALYTICS_DISABLED_KEY); } catch (e) {}
        disable.disabled = true;
        disable.textContent = 'Метрика включена';
        startAnalytics(true);
      });
      return;
    }
    disable.addEventListener('click', function () {
      disable.disabled = true;
      fetch('/api/analytics/withdraw', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}', keepalive: true })
        .then(function () {
          try { localStorage.setItem(ANALYTICS_DISABLED_KEY, '1'); } catch (e) {}
          if (analyticsTimer) clearInterval(analyticsTimer);
          analyticsTimer = null;
          disable.textContent = 'Метрика отключена';
        }).catch(function () { disable.disabled = false; });
    });
  }

  function initCompactHeader() {
    var header = document.querySelector('.site-header');
    if (!header) return;
    var lastY = Math.max(0, window.scrollY || 0);
    var ticking = false;

    function setCompact(compact) {
      header.classList.toggle('header-compact', compact);
    }
    function update() {
      var y = Math.max(0, window.scrollY || 0);
      var delta = y - lastY;
      var active = document.activeElement;
      // После закрытия корзины фокус возвращается на её кнопку. Это не должно
      // блокировать сворачивание шапки; развёрнутой оставляем только активную строку поиска.
      var headerFieldFocused = !!(active && header.contains(active) && /^(INPUT|TEXTAREA|SELECT)$/.test(active.tagName));
      var headerInUse = headerFieldFocused || document.body.classList.contains('nav-open');
      if (y < 48 || headerInUse) setCompact(false);
      else if (delta > 4 && y > 96) setCompact(true);
      else if (delta < -6) setCompact(false);
      lastY = y;
      ticking = false;
    }

    setCompact(lastY > 120);
    window.addEventListener('scroll', function () {
      if (ticking) return;
      ticking = true;
      requestAnimationFrame(update);
    }, { passive: true });
    header.addEventListener('focusin', function () { setCompact(false); });
  }

  document.addEventListener('DOMContentLoaded', function () {
    Cart.load();
    Cart.updateBadge();
    if (document.getElementById('checkout-page')) Cart.render();   // страница оформления рисуется сразу
    initCountdowns();
    startAnalytics(true);
    initAnalyticsControls();
    initCompactHeader();

    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && document.body.classList.contains('cart-open')) Cart.close();
    });
    document.querySelectorAll('.nav-cat').forEach(function (link) {
      link.addEventListener('click', function () { document.body.classList.remove('nav-open'); });
    });

    // Кнопки "в корзину"
    document.addEventListener('click', function (e) {
      var btn = e.target.closest('.add-to-cart');
      if (btn) {
        e.preventDefault(); e.stopPropagation();
        if (btn.disabled) return;
        var id = btn.dataset.id;
        var variantKey = itemKey({ id: id, storage: btn.dataset.storage || '', color: btn.dataset.color || '' });
        if (Cart.find(variantKey)) {
          // товар уже в корзине — ведём к оформлению (удалить можно внутри корзины)
          goToCheckout();
        } else {
          var qty = 1;
          if (btn.hasAttribute('data-qty-source')) {
            var box = document.querySelector('[data-qty] .qty-input');
            if (box) qty = Math.max(1, parseInt(box.value, 10) || 1);
          }
          Cart.add(id, btn.dataset.name, Number(btn.dataset.price), qty, { storage: btn.dataset.storage, color: btn.dataset.color, img: btn.dataset.img });
        }
        return;
      }
      // управление количеством в корзине
      var act = e.target.closest('[data-act]');
      if (act) {
        var key = act.dataset.key;
        var item = Cart.find(key);
        if (act.dataset.act === 'inc' && item) Cart.setQty(key, item.qty + 1);
        else if (act.dataset.act === 'dec' && item) Cart.setQty(key, item.qty - 1);
        else if (act.dataset.act === 'rm') Cart.remove(key);
        return;
      }
      // оформление заказа — только на странице /checkout
      var pay = e.target.closest ? e.target.closest('#checkout-submit') : null;
      if (pay) { e.preventDefault(); submitOrder(pay); }
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
      var mainAlt = (main && main.querySelector('img') && main.querySelector('img').alt) || 'Фото товара';
      var dotsBox = document.getElementById('g-dots');
      var prev = document.getElementById('g-prev');
      var next = document.getElementById('g-next');
      var visible = all.slice();
      var idx = 0;

      function renderSlide() {
        if (main) main.innerHTML = '<img src="' + escapeHtml(visible[idx].src) + '" alt="' + escapeHtml(mainAlt) + '" width="800" height="800" decoding="async">';
        if (dotsBox) {
          var dots = dotsBox.querySelectorAll('.g-dot');
          for (var i = 0; i < dots.length; i++) {
            dots[i].classList.toggle('active', i === idx);
            dots[i].setAttribute('aria-current', i === idx ? 'true' : 'false');
          }
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
        var v = Math.max(1, Math.min(99, (parseInt(input.value, 10) || 1) + parseInt(b.dataset.delta, 10)));
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
      // Стартуем с варианта, отмеченного активным на сервере: первый доступный,
      // а не просто первый в списке (первый цвет может быть распродан).
      var fc = document.querySelector('#colors .swatch.active') || document.querySelector('#colors .swatch');
      if (fc) vstate.color = fc.dataset.color;
      var fs = document.querySelector('#storages .storage-opt.active') || document.querySelector('#storages .storage-opt');
      if (fs) { vstate.storageLabel = fs.dataset.label; vstate.storageAdd = Number(fs.dataset.add) || 0; }
      function applyVariant() {
        var total = basePrice + vstate.storageAdd;
        var pe = document.getElementById('product-price'); if (pe) pe.textContent = money(total);
        addBtn.dataset.price = total;
        addBtn.dataset.name = baseName + (vstate.storageLabel ? ' ' + vstate.storageLabel : '') + (vstate.color ? ', ' + vstate.color : '');
        addBtn.dataset.storage = vstate.storageLabel;
        addBtn.dataset.color = vstate.color;
        syncCartButtons(); // подпись кнопки зависит от выбранного варианта
      }
      var colorsEl = document.getElementById('colors');
      if (colorsEl) colorsEl.addEventListener('click', function (e) {
        var sw = e.target.closest('.swatch'); if (!sw) return;
        colorsEl.querySelectorAll('.swatch').forEach(function (x) { x.classList.remove('active'); x.setAttribute('aria-pressed', 'false'); });
        sw.classList.add('active'); sw.setAttribute('aria-pressed', 'true'); vstate.color = sw.dataset.color;
        var sc = document.getElementById('sel-color'); if (sc) sc.textContent = sw.dataset.color;
        if (gallerySetColor) gallerySetColor(sw.dataset.color);
        applyVariant();
      });
      if (vstate.color && gallerySetColor) gallerySetColor(vstate.color);
      var storagesEl = document.getElementById('storages');
      if (storagesEl) storagesEl.addEventListener('click', function (e) {
        var so = e.target.closest('.storage-opt'); if (!so) return;
        storagesEl.querySelectorAll('.storage-opt').forEach(function (x) { x.classList.remove('active'); x.setAttribute('aria-pressed', 'false'); });
        so.classList.add('active'); so.setAttribute('aria-pressed', 'true'); vstate.storageLabel = so.dataset.label; vstate.storageAdd = Number(so.dataset.add) || 0;
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

    // Согласия на обработку и публикацию показываются последовательно,
    // отдельными действиями и без перегруженных чекбоксов в форме.
    var rf = document.getElementById('review-form');
    if (rf) {
      function requestReviewConsents(onConfirmed) {
        var overlay = document.getElementById('review-consent-overlay');
        var closeBtn = document.getElementById('review-consent-close');
        var cancelBtn = document.getElementById('review-consent-cancel');
        var nextBtn = document.getElementById('review-consent-next');
        var progress = document.getElementById('review-consent-progress');
        var title = document.getElementById('review-consent-title');
        var copy = document.getElementById('review-consent-text');
        var link = document.getElementById('review-consent-link');
        if (!overlay || !closeBtn || !cancelBtn || !nextBtn || !progress || !title || !copy || !link) return false;
        if (!overlay.hidden) return true;

        var previousFocus = document.activeElement;
        var step = 0;
        var steps = [
          {
            progress: 'Шаг 1 из 2', title: 'Обработка данных',
            copy: 'Подтвердите согласие на обработку имени, оценок, текста и фотографий, указанных в отзыве.',
            href: '/personal-data-consent', button: 'Согласен'
          },
          {
            progress: 'Шаг 2 из 2', title: 'Публикация отзыва',
            copy: 'Подтвердите отдельное согласие на публикацию имени или псевдонима, оценки, текста и фотографий после модерации.',
            href: '/personal-data-publication-consent', button: 'Согласен и отправить'
          }
        ];

        function renderStep() {
          var current = steps[step];
          progress.textContent = current.progress;
          title.textContent = current.title;
          copy.textContent = current.copy;
          link.href = current.href;
          nextBtn.textContent = current.button;
        }
        function finish(confirmed) {
          overlay.hidden = true;
          document.body.classList.remove('review-consent-open');
          closeBtn.removeEventListener('click', cancel);
          cancelBtn.removeEventListener('click', cancel);
          nextBtn.removeEventListener('click', next);
          overlay.removeEventListener('click', backdrop);
          document.removeEventListener('keydown', keyboard);
          if (confirmed) onConfirmed();
          else if (previousFocus && typeof previousFocus.focus === 'function') previousFocus.focus();
        }
        function cancel() { finish(false); }
        function next() {
          if (step === 0) { step = 1; renderStep(); nextBtn.focus(); return; }
          finish(true);
        }
        function backdrop(e) { if (e.target === overlay) cancel(); }
        function keyboard(e) {
          if (e.key === 'Escape') { cancel(); return; }
          if (e.key !== 'Tab') return;
          var focusable = [closeBtn, link, cancelBtn, nextBtn];
          var index = focusable.indexOf(document.activeElement);
          if (e.shiftKey && index <= 0) { e.preventDefault(); nextBtn.focus(); }
          else if (!e.shiftKey && index === focusable.length - 1) { e.preventDefault(); closeBtn.focus(); }
        }

        renderStep();
        closeBtn.addEventListener('click', cancel);
        cancelBtn.addEventListener('click', cancel);
        nextBtn.addEventListener('click', next);
        overlay.addEventListener('click', backdrop);
        document.addEventListener('keydown', keyboard);
        overlay.hidden = false;
        document.body.classList.add('review-consent-open');
        nextBtn.focus();
        return true;
      }

      function sendReview() {
        var msg = document.getElementById('review-msg');
        var submit = rf.querySelector('button[type="submit"]');
        if (submit && submit.disabled) return;
        if (submit) { submit.disabled = true; submit.textContent = 'Отправляем...'; }
        var fd = new FormData(rf);
        fd.append('privacyAccepted', '1');
        fd.append('publicationAccepted', '1');
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
          .catch(function () { msg.hidden = false; msg.className = 'form-msg err'; msg.textContent = 'Ошибка сети'; })
          .finally(function () { if (submit) { submit.disabled = false; submit.textContent = 'Отправить отзыв'; } });
      }

      rf.addEventListener('submit', function (e) {
        e.preventDefault();
        var submit = rf.querySelector('button[type="submit"]');
        if (submit && submit.disabled) return;
        if (!requestReviewConsents(sendReview)) {
          var msg = document.getElementById('review-msg');
          if (msg) { msg.hidden = false; msg.className = 'form-msg err'; msg.textContent = 'Не удалось открыть подтверждение. Обновите страницу.'; }
        }
      });
    }
  });

  function submitOrder(btn) {
    var msg = document.getElementById('order-msg');
    var contact = (document.getElementById('co-contact') || {}).value || '';
    if (!contact.trim()) { if (msg) { msg.hidden = false; msg.className = 'form-msg err'; msg.textContent = 'Укажите контакт для связи'; } return; }
    btn.disabled = true;
    var btnHtml = btn.innerHTML;
    btn.textContent = 'Отправляем...';
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
          var number = escapeHtml(d.number || '—');
          var page = document.getElementById('checkout-page');
          if (page) {                       // страница оформления: показываем результат на всю ширину
            var grid = page.querySelector('.checkout-grid');
            var head = page.querySelector('.checkout-title');
            if (head) head.textContent = 'Заказ оформлен';
            if (grid) {
              grid.className = 'checkout-done';
              grid.innerHTML = '<section class="order-success" id="order-success" role="status" aria-live="polite" tabindex="-1">'
                + '<div class="order-success-check" aria-hidden="true">✓</div>'
                + '<p class="order-success-eyebrow">Заявка получена</p>'
                + '<h3>Спасибо за заказ!</h3>'
                + '<p class="order-success-copy">Мы сохранили заявку и передали её менеджеру.</p>'
                + '<div class="order-success-number"><span>Номер заказа</span><strong>' + number + '</strong></div>'
                + '<div class="order-success-next"><span class="order-success-step" aria-hidden="true">1</span><div><strong>Что дальше?</strong><p>Менеджер свяжется с вами по указанному контакту, чтобы подтвердить наличие и детали заказа.</p></div></div>'
                + '<a class="btn btn-primary btn-lg" href="/">Продолжить покупки</a>'
                + '</section>';
              var ok = document.getElementById('order-success');
              if (ok) { try { ok.focus(); } catch (e) {} }
            }
            return;
          }
          var items = document.getElementById('cart-items');
          var foot = document.getElementById('cart-foot');
          var title = document.querySelector('#cart-drawer .cart-head h2');
          if (title) title.textContent = 'Заказ оформлен';
          if (items) {
            items.classList.add('cart-items-success');
            items.innerHTML = '<section class="order-success" id="order-success" role="status" aria-live="polite" tabindex="-1">'
              + '<div class="order-success-check" aria-hidden="true">✓</div>'
              + '<p class="order-success-eyebrow">Заявка получена</p>'
              + '<h3>Спасибо за заказ!</h3>'
              + '<p class="order-success-copy">Мы сохранили заявку и передали её менеджеру.</p>'
              + '<div class="order-success-number"><span>Номер заказа</span><strong>' + number + '</strong></div>'
              + '<div class="order-success-next"><span class="order-success-step" aria-hidden="true">1</span><div><strong>Что дальше?</strong><p>Менеджер свяжется с вами по указанному контакту, чтобы подтвердить наличие и детали заказа.</p></div></div>'
              + '</section>';
            var success = document.getElementById('order-success');
            if (success) success.focus();
          }
          if (foot) foot.innerHTML = '<button class="btn btn-primary btn-block btn-lg" onclick="Cart.close()">Продолжить покупки</button>';
        } else {
          btn.disabled = false; btn.innerHTML = btnHtml;
          if (msg) { msg.hidden = false; msg.className = 'form-msg err'; msg.textContent = d.error || 'Не удалось оформить заказ'; }
        }
      })
      .catch(function () {
        btn.disabled = false; btn.innerHTML = btnHtml;
        if (msg) { msg.hidden = false; msg.className = 'form-msg err'; msg.textContent = 'Ошибка сети'; }
      });
  }
})();
