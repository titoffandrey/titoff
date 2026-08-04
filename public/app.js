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

  // Корзина хранит снимок данных на момент добавления: у позиций, положенных
  // давно, нет фото, а цена могла измениться. Спрашиваем у сервера актуальное —
  // заодно исчезают товары, которых больше нет в каталоге.
  function refreshCartFromServer() {
    if (!Cart.items.length) return;
    fetch('/api/cart', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ items: Cart.items.map(function (i) { return { id: i.id, storage: i.storage, color: i.color, band: i.band, bandSize: i.bandSize, options: i.options }; }) })
    })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (!d || !d.ok || !Array.isArray(d.items) || d.items.length !== Cart.items.length) return;
        var next = [];
        d.items.forEach(function (fresh, idx) {
          var item = Cart.items[idx];
          if (!item || fresh.gone) return;              // товар убрали из каталога
          if (fresh.name) item.name = fresh.name;
          if (Number(fresh.price) > 0) item.price = Number(fresh.price);
          // Пустая строка тоже является обновлением: если фото удалили в панели,
          // старая миниатюра не должна оставаться в localStorage и давать 404.
          item.img = fresh.img || '';
          item.available = fresh.available !== false;
          next.push(item);
        });
        var changed = next.length !== Cart.items.length;
        Cart.items = next;
        Cart.save(); Cart.render();
        if (changed) toast('Корзина обновлена: часть товаров больше недоступна');
      })
      .catch(function () { /* офлайн — работаем с тем, что сохранено */ });
  }

  // ===== Страница оформления (/checkout) =====
  // Позиции и форма — на отдельной странице: список остаётся видимым и прокручивается
  // сам по себе, а не выталкивается формой, как было в выдвижной корзине.
  function renderCheckoutPage() {
    var items = document.getElementById('checkout-items');
    var side = document.getElementById('checkout-side');
    if (!items || !side) return;

    var page = document.getElementById('checkout-page');
    if (page) page.classList.toggle('is-empty', !Cart.items.length);   // пустая корзина — одна колонка по центру
    if (!Cart.items.length) {
      items.innerHTML = '<div class="checkout-empty">'
        + '<div class="checkout-empty-ico" aria-hidden="true">🛒</div>'
        + '<h2>В корзине пока пусто</h2>'
        + '<p>Выберите товары в каталоге — они появятся здесь.</p>'
        + '<a class="btn btn-primary btn-lg" href="/">Перейти в каталог</a></div>';
      side.innerHTML = '';
      return;
    }

    var count = Cart.count();
    items.innerHTML = '<div class="co-items-head"><span>' + count + ' ' + plural(count, 'товар', 'товара', 'товаров') + '</span>'
      + '<a class="co-back" href="/">← <span class="co-back-full">Продолжить покупки</span><span class="co-back-short">В каталог</span></a></div>'
      + Cart.items.map(function (i) {
        var k = escapeHtml(itemKey(i));
        var variant = [i.storage, i.color, i.band, i.bandSize].concat(optionValues(i)).filter(Boolean).join(' · ');
        var out = i.available === false;
        return '<article class="co-item' + (out ? ' co-item-out' : '') + '">'
          + '<div class="co-item-media">' + itemThumb(i) + '</div>'
          + '<div class="co-item-body">'
          + '<h3 class="co-item-name">' + escapeHtml(i.name) + '</h3>'
          + (variant ? '<div class="co-item-variant">' + escapeHtml(variant) + '</div>' : '')
          + (out ? '<div class="co-item-warn">Нет в наличии — позиция не попадёт в заказ</div>' : '')
          + '<div class="co-item-unit">' + money(i.price) + ' за штуку</div>'
          + '</div>'
          + '<div class="co-item-side">'
          + '<div class="co-item-sum">' + money(i.price * i.qty) + '</div>'
          + '<div class="co-item-controls">'
          + '<div class="cart-qty"><button type="button" data-act="dec" data-key="' + k + '" aria-label="Уменьшить количество">−</button>'
          + '<span>' + i.qty + '</span>'
          + '<button type="button" data-act="inc" data-key="' + k + '" aria-label="Увеличить количество">+</button></div>'
          + '<button type="button" class="co-remove" data-act="rm" data-key="' + k + '" aria-label="Удалить из корзины" title="Удалить">'
          + '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M7 3h6M4 6h12M6.5 6l.6 10a1.4 1.4 0 0 0 1.4 1.3h3a1.4 1.4 0 0 0 1.4-1.3l.6-10" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>'
          + '</button>'
          + '</div></div>'
          + '</article>';
      }).join('');

    // форму перерисовываем только один раз, чтобы не стирать введённое при смене количества
    if (!side.dataset.ready) {
      side.dataset.ready = '1';
      side.innerHTML = '<div class="co-summary">'
        + '<h2 class="co-summary-title">Ваш заказ</h2>'
        + '<div class="co-line"><span id="co-count-label">Товары</span><span id="co-goods-sum">' + money(Cart.total()) + '</span></div>'
        + '<div class="co-line co-line-muted"><span>Доставка</span><span>обсудим при подтверждении</span></div>'
        + '<div class="co-total"><span>Итого</span><b id="co-total-sum">' + money(Cart.total()) + '</b></div>'
        + '<div class="field"><label for="co-name">Ваше имя</label><input type="text" id="co-name" maxlength="100" placeholder="Как к вам обращаться"></div>'
        + '<div class="field"><label for="co-contact">Контакт для связи <span class="req">*</span></label><input type="text" id="co-contact" maxlength="120" placeholder="Telegram, телефон или e-mail" required></div>'
        + '<div class="field"><label for="co-address">Адрес доставки</label>'
        + '<div class="suggest-box">'
        + '<input type="text" id="co-address" maxlength="400" placeholder="Начните вводить — подскажем" autocomplete="off"'
        + ' role="combobox" aria-expanded="false" aria-autocomplete="list" aria-controls="co-address-list">'
        + '<div class="suggest-list" id="co-address-list" role="listbox" hidden></div>'
        + '</div>'
        + '<p class="field-note">Необязательно — можно уточнить при подтверждении заказа.</p></div>'
        + '<button type="button" class="btn btn-primary btn-block btn-lg btn-checkout" id="checkout-submit">'
        + '<span class="btn-checkout-label">Оформить заказ</span>'
        + '<span class="btn-checkout-sum" id="co-btn-sum">' + money(Cart.total()) + '</span></button>'
        + '<p class="form-msg" id="order-msg" hidden></p>'
        + '<p class="form-legal-note">Оплата не онлайн: менеджер свяжется с вами и подтвердит заказ. '
        + '<a href="/privacy" target="_blank" rel="noopener">Политика конфиденциальности</a></p>'
        + '</div>';
      initAddressSuggest();
    }
    var sum = money(Cart.total());
    setText('co-total-sum', sum); setText('co-btn-sum', sum); setText('co-goods-sum', sum);
    setText('co-count-label', 'Товары (' + count + ')');
    var submit = document.getElementById('checkout-submit');
    if (submit) {
      var canOrder = Cart.availableCount() > 0;
      submit.disabled = !canOrder;
      var label = submit.querySelector('.btn-checkout-label');
      if (label) label.textContent = canOrder ? 'Оформить заказ' : 'Нет доступных товаров';
    }
  }
  // ===== Подсказки адреса (dadata.ru через наш /api/address-suggest) =====
  // Подсказки — помощь, а не условие: если ключ не настроен, запрос не удался или
  // покупатель печатает быстрее ответа, поле остаётся обычным текстовым вводом.
  function initAddressSuggest() {
    var input = document.getElementById('co-address');
    var list = document.getElementById('co-address-list');
    if (!input || !list) return;
    var items = [], active = -1, timer = null, seq = 0, lastQuery = null, off = false;

    function close() {
      list.hidden = true; list.innerHTML = ''; items = []; active = -1;
      input.setAttribute('aria-expanded', 'false');
      input.removeAttribute('aria-activedescendant');
    }
    function paint() {
      list.innerHTML = items.map(function (s, i) {
        return '<button type="button" class="suggest-item' + (i === active ? ' active' : '') + '" role="option"'
          + ' id="co-address-opt-' + i + '" aria-selected="' + (i === active ? 'true' : 'false') + '" data-i="' + i + '">'
          + '<span class="suggest-value">' + escapeHtml(s.value) + '</span>'
          + (s.hint ? '<span class="suggest-hint">' + escapeHtml(s.hint) + '</span>' : '')
          + '</button>';
      }).join('');
      list.hidden = !items.length;
      input.setAttribute('aria-expanded', items.length ? 'true' : 'false');
      if (active > -1) input.setAttribute('aria-activedescendant', 'co-address-opt-' + active);
      else input.removeAttribute('aria-activedescendant');
    }
    function move(step) {
      if (!items.length) return;
      active = (active + step + items.length) % items.length;
      paint();
      var el = list.querySelector('.suggest-item.active');
      if (el && el.scrollIntoView) el.scrollIntoView({ block: 'nearest' });
    }
    function choose(i) {
      var s = items[i];
      if (!s) return;
      input.value = s.value;
      lastQuery = s.value;      // выбранное значение заново не переспрашиваем
      close();
      input.focus();
    }
    function ask(q) {
      var my = ++seq;
      fetch('/api/address-suggest', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ q: q })
      })
        .then(function (r) { return r.json(); })
        .then(function (d) {
          if (my !== seq || document.activeElement !== input) return;   // ответ устарел
          if (!d || d.configured === false) { off = true; close(); return; }  // ключ не настроен — больше не дёргаем
          if (!d.ok) { close(); return; }                                     // временная ошибка: попробуем в следующий раз
          items = (d.items || []).slice(0, 7); active = -1; paint();
        })
        .catch(function () { if (my === seq) close(); });
    }

    input.addEventListener('input', function () {
      var q = input.value.trim();
      lastQuery = null;
      clearTimeout(timer);
      if (off || q.length < 3) { close(); return; }
      // 220 мс тишины: у DaData запросы платные по счётчику, дёргать на каждую букву незачем
      timer = setTimeout(function () { if (q !== lastQuery) { lastQuery = q; ask(q); } }, 220);
    });
    input.addEventListener('keydown', function (e) {
      if (list.hidden) return;
      if (e.key === 'ArrowDown') { e.preventDefault(); move(1); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); move(-1); }
      else if (e.key === 'Enter') { if (active > -1) { e.preventDefault(); choose(active); } }
      else if (e.key === 'Escape') { close(); }
    });
    // mousedown, а не click: click приходит уже после blur, и список успевает закрыться
    list.addEventListener('mousedown', function (e) {
      var b = e.target.closest('.suggest-item');
      if (!b) return;
      e.preventDefault();
      choose(Number(b.dataset.i));
    });
    input.addEventListener('blur', function () { setTimeout(close, 120); });
  }

  function setText(id, text) { var el = document.getElementById(id); if (el) el.textContent = text; }
  function plural(n, one, few, many) {
    var a = Math.abs(n) % 100, b = a % 10;
    if (a > 10 && a < 20) return many;
    if (b > 1 && b < 5) return few;
    return b === 1 ? one : many;
  }

  // Ключ позиции: один товар в разных вариантах (память/цвет) — это разные строки корзины.
  // Доп. характеристики входят в ключ так же: iPad с нанотекстурой и без — разные позиции.
  function optionsKey(list) {
    return (list || []).map(function (o) { return [o.name, o.value]; });
  }
  function itemKey(i) { return JSON.stringify([i.id, i.storage || '', i.color || '', i.band || '', i.bandSize || '', optionsKey(i.options)]); }
  // Значения доп. характеристик строкой — для подписи позиции в корзине.
  function optionValues(i) { return (i.options || []).map(function (o) { return o.value; }); }
  // Список из data-атрибута кнопки: пришёл он из нашей же разметки, но данные
  // всё равно чистим — кнопку мог подменить кто угодно.
  function parseOptions(raw) {
    if (!raw) return [];
    try { return cleanOptions(JSON.parse(raw)); } catch (e) { return []; }
  }
  function cleanOptions(list) {
    if (!Array.isArray(list)) return [];
    return list.slice(0, 20).map(function (o) {
      if (!o || typeof o !== 'object') return null;
      var name = cleanText(o.name, 60).trim(), value = cleanText(o.value, 80).trim();
      return name && value ? { name: name, value: value } : null;
    }).filter(Boolean);
  }
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
      band: cleanText(item.band, 120),          // «Коллекция · Цвет»
      bandSize: cleanText(item.bandSize, 30),
      options: cleanOptions(item.options),      // [{name, value}] — покрытие, связь и т. п.
      available: item.available !== false,
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
      var next = cleanItem({ id: id, name: name, price: price, qty: qty, storage: opts.storage || '', color: opts.color || '',
        band: opts.band || '', bandSize: opts.bandSize || '', options: opts.options || [], img: opts.img || '' });
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
    // Сервер исключает распроданные позиции из заявки. Сумма в интерфейсе должна
    // совпадать с ним, а не обещать покупателю более высокий итог.
    total: function () { return this.items.reduce(function (a, i) { return a + (i.available === false ? 0 : Number(i.price) * Number(i.qty)); }, 0); },
    availableCount: function () { return this.items.reduce(function (a, i) { return a + (i.available === false ? 0 : Number(i.qty)); }, 0); },
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
      var trigger = document.querySelector('.cart-btn');
      if (trigger) trigger.setAttribute('aria-expanded', 'true');
      var close = drawer && drawer.querySelector('.cart-head .icon-btn');
      if (close) close.focus();
    },
    close: function () {
      document.body.classList.remove('cart-open');
      var drawer = document.getElementById('cart-drawer');
      if (drawer) drawer.setAttribute('aria-hidden', 'true');
      var trigger = document.querySelector('.cart-btn');
      if (trigger) trigger.setAttribute('aria-expanded', 'false');
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
        // Подпись варианта обязательна: /api/cart возвращает базовое название
        // товара, и без неё двое часов с разными ремешками выглядели в корзине
        // как две одинаковые строки «Apple Watch Ultra 3».
        var variant = [i.storage, i.color, i.band, i.bandSize].concat(optionValues(i)).filter(Boolean).join(' · ');
        var out = i.available === false;
        return '<div class="cart-item' + (out ? ' cart-item-out' : '') + '">'
          + '<div class="cart-item-media">' + itemThumb(i) + '</div>'
          + '<div class="cart-item-info">'
          + '<div class="cart-item-name">' + escapeHtml(i.name) + '</div>'
          + (variant ? '<div class="cart-item-variant">' + escapeHtml(variant) + '</div>' : '')
          + (out ? '<div class="cart-item-warn">Нет в наличии — позиция не попадёт в заказ</div>' : '')
          + '<div class="cart-item-price">' + money(i.price) + '</div>'
          + '<div class="cart-item-controls">'
          + '<div class="cart-qty"><button type="button" data-act="dec" data-key="' + k + '" aria-label="Меньше">−</button><span>' + i.qty + '</span><button type="button" data-act="inc" data-key="' + k + '" aria-label="Больше">+</button></div>'
          + '<button type="button" class="cart-remove" data-act="rm" data-key="' + k + '">Удалить</button>'
          + '</div></div></div>';
      }).join('');
      foot.innerHTML =
        '<div class="cart-total"><span>Итого</span><span>' + money(this.total()) + '</span></div>'
        + (this.availableCount() ? '<a class="btn btn-primary btn-block btn-lg btn-checkout" href="/checkout" id="checkout-btn">'
        + '<span class="btn-checkout-label">Оформить заказ</span>'
        + '<span class="btn-checkout-sum">' + money(this.total()) + '</span></a>'
        : '<button class="btn btn-primary btn-block btn-lg" type="button" disabled>Нет доступных товаров</button>');
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
      setBtnState(b, !!Cart.find(itemKey({ id: b.dataset.id, storage: b.dataset.storage || '', color: b.dataset.color || '',
        band: b.dataset.band || '', bandSize: b.dataset.bandSize || '', options: parseOptions(b.dataset.options) })));
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

  function analyticsPayload(includeDetails, enableTracking) {
    var payload = { path: location.pathname };
    if (enableTracking) payload.enableTracking = '1';
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

  function startAnalytics(includeReferrer, enableTracking) {
    if (analyticsDisabled()) return;
    fetch('/api/analytics/start', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: analyticsPayload(includeReferrer, enableTracking), keepalive: true
    }).then(function (r) { return r.json(); })
      .then(function (d) { if (d && d.ok && d.tracking !== false) startAnalyticsHeartbeat(); })
      .catch(function () {});
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
        startAnalytics(true, true);
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
    // Сжатие шапки анимирует высоту и ширину поиска — это перекладка страницы на
    // 280 мс. Если состояние дёргается туда-сюда при каждом движении колеса,
    // прокрутка ощущается как рывки. Поэтому после переключения берём паузу и
    // требуем заметного движения, а не 4–6 пикселей.
    var lockedUntil = 0;
    function setCompactOnce(compact) {
      if (header.classList.contains('header-compact') === compact) return;
      if (Date.now() < lockedUntil) return;
      lockedUntil = Date.now() + 320;
      setCompact(compact);
    }

    function update() {
      var y = Math.max(0, window.scrollY || 0);
      var delta = y - lastY;
      var active = document.activeElement;
      // После закрытия корзины фокус возвращается на её кнопку. Это не должно
      // блокировать сворачивание шапки; развёрнутой оставляем только активную строку поиска.
      var headerFieldFocused = !!(active && header.contains(active) && /^(INPUT|TEXTAREA|SELECT)$/.test(active.tagName));
      var headerInUse = headerFieldFocused || document.body.classList.contains('nav-open');
      if (y < 48 || headerInUse) { setCompact(false); lockedUntil = 0; }   // у самого верха — всегда развёрнутая
      else if (delta > 10 && y > 140) setCompactOnce(true);
      else if (delta < -24) setCompactOnce(false);
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
    refreshCartFromServer();                                       // подтянуть свежие фото, цены и наличие
    try {                                                          // благодарность после перезагрузки со свежим отзывом
      if (sessionStorage.getItem('review_thanks')) { sessionStorage.removeItem('review_thanks'); toast('Спасибо за отзыв!'); }
    } catch (e) {}
    initCountdowns();
    startAnalytics(true);
    initAnalyticsControls();
    initCompactHeader();

    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && document.body.classList.contains('cart-open')) Cart.close();
      if (e.key === 'Escape' && document.body.classList.contains('nav-open')) {
        document.body.classList.remove('nav-open');
        var menu = document.querySelector('.menu-toggle');
        if (menu) { menu.setAttribute('aria-expanded', 'false'); menu.focus(); }
      }
      // Фокус не выходит за пределы модальной корзины по Tab/Shift+Tab.
      if (e.key === 'Tab' && document.body.classList.contains('cart-open')) {
        var drawer = document.getElementById('cart-drawer');
        var focusable = drawer && drawer.querySelectorAll('a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled])');
        if (!focusable || !focusable.length) return;
        var first = focusable[0], last = focusable[focusable.length - 1];
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
      }
    });
    var menuToggle = document.querySelector('.menu-toggle');
    if (menuToggle) menuToggle.addEventListener('click', function () {
      var open = !document.body.classList.contains('nav-open');
      document.body.classList.toggle('nav-open', open);
      menuToggle.setAttribute('aria-expanded', open ? 'true' : 'false');
    });
    document.querySelectorAll('.nav-cat').forEach(function (link) {
      link.addEventListener('click', function () {
        document.body.classList.remove('nav-open');
        if (menuToggle) menuToggle.setAttribute('aria-expanded', 'false');
      });
    });

    // Кнопки "в корзину"
    document.addEventListener('click', function (e) {
      var btn = e.target.closest('.add-to-cart');
      if (btn) {
        e.preventDefault(); e.stopPropagation();
        if (btn.disabled) return;
        var id = btn.dataset.id;
        var picked = parseOptions(btn.dataset.options);
        var variantKey = itemKey({ id: id, storage: btn.dataset.storage || '', color: btn.dataset.color || '',
          band: btn.dataset.band || '', bandSize: btn.dataset.bandSize || '', options: picked });
        if (Cart.find(variantKey)) {
          // товар уже в корзине — ведём к оформлению (удалить можно внутри корзины)
          goToCheckout();
        } else {
          var qty = 1;
          if (btn.hasAttribute('data-qty-source')) {
            var box = document.querySelector('[data-qty] .qty-input');
            if (box) qty = Math.max(1, parseInt(box.value, 10) || 1);
          }
          Cart.add(id, btn.dataset.name, Number(btn.dataset.price), qty, { storage: btn.dataset.storage, color: btn.dataset.color,
            band: btn.dataset.band, bandSize: btn.dataset.bandSize, options: picked, img: btn.dataset.img });
        }
        return;
      }
      // управление количеством в корзине
      var act = e.target.closest('[data-act]');
      if (act) {
        var key = act.dataset.key;
        var item = Cart.find(key);
        if (act.dataset.act === 'inc' && item) Cart.setQty(key, item.qty + 1);
        // минус на единице убирает позицию — иначе счётчик упирается в 1 и товар не выкинуть
        else if (act.dataset.act === 'dec' && item) { if (item.qty <= 1) Cart.remove(key); else Cart.setQty(key, item.qty - 1); }
        else if (act.dataset.act === 'rm') Cart.remove(key);
        return;
      }
      // оформление заказа — только на странице /checkout
      var pay = e.target.closest ? e.target.closest('#checkout-submit') : null;
      if (pay) { e.preventDefault(); submitOrder(pay); }
    });

    // Галерея товара в стиле apple.com: стрелки по бокам + точки-индикатор, без миниатюр.
    // При выборе цвета показываются фото этого цвета + общие (сначала цветовые).
    var gallerySetColor = null, gallerySetBand = null;
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

      // Показываем ОДИН набор — самый точный из непустых, а не всё сразу:
      //   1) этот ремешок на этом корпусе,
      //   2) этот ремешок без указания корпуса,
      //   3) этот корпус без ремешка,
      //   4) общие фото.
      // Складывать наборы нельзя: у Ultra 3 на натуральном и на чёрном титане свои
      // снимки тех же ремешков, и при склейке покупатель видел вперемешку оба корпуса.
      var pickedColor = '', pickedBand = '';
      function applyFilter() {
        var exact = (pickedBand && pickedColor)
          ? all.filter(function (s) { return s.band === pickedBand && s.color === pickedColor; }) : [];
        var byBand = pickedBand ? all.filter(function (s) { return s.band === pickedBand && !s.color; }) : [];
        var byColor = pickedColor ? all.filter(function (s) { return s.color === pickedColor && !s.band; }) : [];
        var common = all.filter(function (s) { return !s.color && !s.band; });
        var list = exact.length ? exact
          : byBand.length ? byBand
          : byColor.length ? byColor
          : common;
        visible = list.length ? list : all.slice();
        idx = 0;
        renderDots(); updateArrows(); renderSlide();
        // в корзину кладём снимок выбранного варианта, а не первое фото товара
        var add = document.querySelector('.add-to-cart[data-qty-source]');
        if (add && visible[0]) add.dataset.img = visible[0].src.replace(/^\/uploads\//, '');
      }
      gallerySetColor = function (color) { pickedColor = color; applyFilter(); };
      gallerySetBand = function (key) { pickedBand = key; applyFilter(); };

      // Главное фото уже отрендерено сервером для выбранного варианта. Не заменяем
      // его сначала общим первым кадром: это запускало лишнюю загрузку и могло дать
      // короткую вспышку чужого корпуса до инициализации вариантов ниже.
      renderDots(); updateArrows();
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
      function paint(v) {
        rate.querySelectorAll('.rate-star').forEach(function (s) {
          s.classList.toggle('on', Number(s.dataset.v) <= v);
          s.setAttribute('aria-checked', Number(s.dataset.v) === v ? 'true' : 'false');
        });
      }
      paint(Number(hidden ? hidden.value : 5) || 5);
      rate.addEventListener('click', function (e) {
        var s = e.target.closest('.rate-star'); if (!s) return;
        var v = Number(s.dataset.v); if (hidden) hidden.value = v; rate.dataset.value = v; paint(v);
      });
      rate.addEventListener('mouseover', function (e) { var s = e.target.closest('.rate-star'); if (s) paint(Number(s.dataset.v)); });
      rate.addEventListener('mouseleave', function () { paint(Number(hidden ? hidden.value : rate.dataset.value) || 5); });
    });

    // Выбор варианта (цвет + память) на странице товара
    // #bands в условии обязателен: у часов, у которых заданы только ремешки (без
    // цветов корпуса и конфигураций), блок иначе не запускался — переключатель
    // рисовался, но цену не менял и в корзину ремешок не попадал.
    var addBtn = document.querySelector('.add-to-cart[data-qty-source]');
    if (addBtn && (document.getElementById('colors') || document.getElementById('storages')
      || document.getElementById('bands') || document.getElementById('options'))) {
      var basePrice = Number(addBtn.dataset.basePrice) || 0;
      var baseName = addBtn.dataset.baseName || '';
      var vstate = { color: '', storageLabel: '', storageAdd: 0, band: '', bandAdd: 0, bandSize: '', bandSizeAdd: 0,
        options: [], optionsAdd: 0 };
      var onCaseColorChange = null;   // задаётся блоком ремешков, если он есть
      var onStorageChange = null;     // задаётся блоком доп. характеристик, если он есть
      // Стартуем с варианта, отмеченного активным на сервере: первый доступный,
      // а не просто первый в списке (первый цвет может быть распродан).
      var fc = document.querySelector('#colors .swatch.active') || document.querySelector('#colors .swatch');
      if (fc) vstate.color = fc.dataset.color;
      var fs = document.querySelector('#storages .storage-opt.active') || document.querySelector('#storages .storage-opt');
      if (fs) { vstate.storageLabel = fs.dataset.label; vstate.storageAdd = Number(fs.dataset.add) || 0; }
      function applyVariant() {
        var total = basePrice + vstate.storageAdd + vstate.bandAdd + vstate.bandSizeAdd + vstate.optionsAdd;
        var pe = document.getElementById('product-price'); if (pe) pe.textContent = money(total);
        addBtn.dataset.price = total;
        // Название храним базовым, а вариант — в отдельных полях ниже. Иначе до
        // первого ответа /api/cart оформление показывало память/цвет дважды.
        addBtn.dataset.name = baseName;
        addBtn.dataset.storage = vstate.storageLabel;
        addBtn.dataset.color = vstate.color;
        addBtn.dataset.band = vstate.band;
        addBtn.dataset.bandSize = vstate.bandSize;
        addBtn.dataset.options = JSON.stringify(vstate.options);
        syncCartButtons(); // подпись кнопки зависит от выбранного варианта
      }

      // ===== Доп. характеристики: покрытие дисплея, связь, комплект =====
      // Каждая группа — свой ряд кнопок со своей доплатой; в цену идёт сумма.
      var optionsEl = document.getElementById('options');
      if (optionsEl) {
        var readOptions = function () {
          var list = [], add = 0;
          optionsEl.querySelectorAll('.option-group').forEach(function (g) {
            var on = g.querySelector('.option-opt.active');
            if (!on) return;
            list.push({ name: g.dataset.group, value: on.dataset.label });
            add += Number(on.dataset.add) || 0;
          });
          vstate.options = list; vstate.optionsAdd = add;
        };
        var pickOption = function (btn) {
          if (!btn || btn.disabled) return;
          var group = btn.closest('.option-group');
          if (!group) return;
          group.querySelectorAll('.option-opt').forEach(function (x) { x.classList.remove('active'); x.setAttribute('aria-pressed', 'false'); });
          btn.classList.add('active'); btn.setAttribute('aria-pressed', 'true');
          readOptions(); applyVariant();
        };
        // Часть значений идёт не со всеми конфигурациями (нанотекстурное стекло —
        // только от 1 ТБ), поэтому при смене памяти ряд перебирается заново.
        var applyStorageToOptions = function () {
          optionsEl.querySelectorAll('.option-group').forEach(function (g) {
            var fallback = null;
            g.querySelectorAll('.option-opt').forEach(function (b) {
              var only = (b.dataset.forStorage || '').split('|').filter(Boolean);
              b.hidden = only.length > 0 && only.indexOf(vstate.storageLabel) === -1;
              if (!b.hidden && !b.disabled && !fallback) fallback = b;
            });
            var active = g.querySelector('.option-opt.active');
            if (!active || active.hidden || active.disabled) {
              pickOption(fallback || g.querySelector('.option-opt:not([hidden])'));
            }
          });
          readOptions();
        };
        optionsEl.addEventListener('click', function (e) {
          var b = e.target.closest('.option-opt');
          if (b) pickOption(b);
        });
        readOptions();
        onStorageChange = applyStorageToOptions;
      }

      // ===== Ремешки часов: коллекция → цвет → размер =====
      // Разметка всех коллекций уже на странице, переключение только показывает нужную.
      var bandsEl = document.getElementById('bands');
      if (bandsEl) {
        var bandLabel = document.getElementById('sel-band');
        var groupName = function (idx) {
          var tab = bandsEl.querySelector('.band-tab[data-group="' + idx + '"]');
          var row = bandsEl.querySelector('.band-colors[data-group="' + idx + '"] .swatch');
          return tab ? tab.textContent : (row ? row.dataset.band : '');
        };
        var pickColor = function (sw) {
          if (!sw || sw.disabled) return;
          bandsEl.querySelectorAll('.band-colors .swatch').forEach(function (x) { x.classList.remove('active'); x.setAttribute('aria-pressed', 'false'); });
          sw.classList.add('active'); sw.setAttribute('aria-pressed', 'true');
          vstate.band = sw.dataset.band + ' · ' + sw.dataset.option;
          vstate.bandAdd = Number(sw.dataset.add) || 0;
          if (bandLabel) bandLabel.textContent = vstate.band;
          if (gallerySetBand) gallerySetBand(sw.dataset.band + '|' + sw.dataset.option);
          applyVariant();
        };
        var pickSize = function (btn) {
          if (!btn) return;
          bandsEl.querySelectorAll('.band-sizes .storage-opt').forEach(function (x) { x.classList.remove('active'); x.setAttribute('aria-pressed', 'false'); });
          btn.classList.add('active'); btn.setAttribute('aria-pressed', 'true');
          vstate.bandSize = btn.dataset.size;
          vstate.bandSizeAdd = Number(btn.dataset.add) || 0;
          applyVariant();
        };
        // Часть вариаций идёт только со своим корпусом (титановый миланский у Apple
        // подбирается в цвет часов) — прячем неподходящие при смене цвета корпуса.
        var applyCaseColor = function () {
          bandsEl.querySelectorAll('.band-colors .swatch').forEach(function (sw) {
            var only = sw.dataset.forColor || '';
            sw.hidden = !!only && only !== vstate.color;
          });
          bandsEl.querySelectorAll('.band-tab').forEach(function (tab) {
            var row = bandsEl.querySelector('.band-colors[data-group="' + tab.dataset.group + '"]');
            var any = row && row.querySelector('.swatch:not([hidden]):not([disabled])');
            tab.hidden = !any;                       // вся коллекция недоступна для этого корпуса
          });
          var active = bandsEl.querySelector('.band-colors .swatch.active');
          if (active && active.hidden) {             // выбранный вариант больше не подходит
            var row = active.closest('.band-colors');
            var next = row.querySelector('.swatch:not([hidden]):not([disabled])') || row.querySelector('.swatch:not([hidden])');
            if (next) pickColor(next);
            else {
              var tab = bandsEl.querySelector('.band-tab:not([hidden])');
              if (tab) showGroup(tab.dataset.group);
            }
          }
        };
        var showGroup = function (idx) {
          bandsEl.querySelectorAll('.band-tab').forEach(function (t) {
            var on = t.dataset.group === String(idx);
            t.classList.toggle('active', on); t.setAttribute('aria-selected', on ? 'true' : 'false');
          });
          bandsEl.querySelectorAll('.band-colors,.band-sizes').forEach(function (row) {
            row.hidden = row.dataset.group !== String(idx);
          });
          // В новой коллекции выбираем первый доступный цвет, подходящий корпусу:
          // скрытые «в цвет корпуса» вариации пропускаем, иначе на чёрных часах
          // выбирался миланский Natural — заказ с таким набором сервер не примет.
          var row = bandsEl.querySelector('.band-colors[data-group="' + idx + '"]');
          pickColor(row && (row.querySelector('.swatch:not([hidden]):not([disabled])')
            || row.querySelector('.swatch:not([hidden])') || row.querySelector('.swatch')));
          var sizes = bandsEl.querySelector('.band-sizes[data-group="' + idx + '"]');
          pickSize(sizes && sizes.querySelector('.storage-opt'));
        };
        bandsEl.addEventListener('click', function (e) {
          var tab = e.target.closest('.band-tab');
          if (tab) { showGroup(tab.dataset.group); return; }
          var sw = e.target.closest('.band-colors .swatch');
          if (sw) { pickColor(sw); return; }
          var size = e.target.closest('.band-sizes .storage-opt');
          if (size) pickSize(size);
        });
        // стартовое состояние — то, что сервер отметил активным
        pickColor(bandsEl.querySelector('.band-colors .swatch.active'));
        pickSize(bandsEl.querySelector('.band-sizes .storage-opt.active'));
        applyCaseColor();
        onCaseColorChange = applyCaseColor;
      }
      var colorsEl = document.getElementById('colors');
      if (colorsEl) colorsEl.addEventListener('click', function (e) {
        var sw = e.target.closest('.swatch'); if (!sw) return;
        colorsEl.querySelectorAll('.swatch').forEach(function (x) { x.classList.remove('active'); x.setAttribute('aria-pressed', 'false'); });
        sw.classList.add('active'); sw.setAttribute('aria-pressed', 'true'); vstate.color = sw.dataset.color;
        var sc = document.getElementById('sel-color'); if (sc) sc.textContent = sw.dataset.color;
        if (gallerySetColor) gallerySetColor(sw.dataset.color);
        if (onCaseColorChange) onCaseColorChange();   // ремешки «в цвет корпуса»
        applyVariant();
      });
      if (vstate.color && gallerySetColor) gallerySetColor(vstate.color);
      var storagesEl = document.getElementById('storages');
      if (storagesEl) storagesEl.addEventListener('click', function (e) {
        var so = e.target.closest('.storage-opt'); if (!so) return;
        storagesEl.querySelectorAll('.storage-opt').forEach(function (x) { x.classList.remove('active'); x.setAttribute('aria-pressed', 'false'); });
        so.classList.add('active'); so.setAttribute('aria-pressed', 'true'); vstate.storageLabel = so.dataset.label; vstate.storageAdd = Number(so.dataset.add) || 0;
        if (onStorageChange) onStorageChange();   // значения «только от 1 ТБ»
        applyVariant();
      });
      applyVariant();
    }

    // Отзывы листаются страницами: сервер и сортирует, и режет, а витрина только
    // подменяет список с листалкой. Номера страниц и «Отзывы 9–16 из 300» приходят
    // готовой разметкой, чтобы одна и та же логика не считалась ещё раз в браузере.
    // Ссылки настоящие (?rsort/?rpage): если запрос не удался, переходим по ним.
    var revList = document.getElementById('reviews-list');
    var revToolbar = document.querySelector('.reviews-toolbar');
    var revPager = document.getElementById('reviews-pager');
    if (revList && revList.dataset.product && (revToolbar || revPager)) {
      var revBusy = false;

      function revState() {
        return {
          sort: (revPager && revPager.dataset.sort)
            || ((document.querySelector('.sort-btn.active') || {}).dataset || {}).sort || 'new',
          page: Number(revPager && revPager.dataset.page) || 1
        };
      }

      function revUrl(sort, page) {
        return revList.dataset.href + '?rsort=' + sort + (page > 1 ? '&rpage=' + page : '');
      }

      // После смены страницы показываем её с начала списка, иначе посетитель
      // остаётся на середине предыдущей и не понимает, что именно обновилось.
      function revScrollToTop() {
        var head = document.getElementById('reviews');
        if (!head) return;
        var top = head.getBoundingClientRect().top + window.pageYOffset - 12;
        if (window.pageYOffset > top) window.scrollTo({ top: top, behavior: 'smooth' });
      }

      function revLoad(sort, page, opts) {
        opts = opts || {};
        if (revBusy) return;
        revBusy = true;
        revList.setAttribute('aria-busy', 'true');
        if (revPager) revPager.setAttribute('aria-busy', 'true');
        fetch('/api/reviews?productId=' + encodeURIComponent(revList.dataset.product)
          + '&sort=' + encodeURIComponent(sort) + '&page=' + encodeURIComponent(page))
          .then(function (r) { return r.json(); })
          .then(function (d) {
            if (!d || !d.ok) throw new Error('reviews');
            revBusy = false;
            revList.innerHTML = d.html;
            revList.removeAttribute('aria-busy');
            if (revPager) {
              revPager.innerHTML = d.pager;
              revPager.dataset.sort = d.sort;
              revPager.dataset.page = d.page;
              revPager.removeAttribute('aria-busy');
            }
            revToolbar && revToolbar.querySelectorAll('.sort-btn').forEach(function (x) {
              var on = x.dataset.sort === d.sort;
              x.classList.toggle('active', on);
              if (on) x.setAttribute('aria-current', 'true'); else x.removeAttribute('aria-current');
            });
            // Адрес отражает страницу, поэтому «назад» возвращает к прошлой,
            // а ссылку на конкретную страницу отзывов можно отправить другому.
            try {
              if (opts.push) history.pushState({ rsort: d.sort, rpage: d.page }, '', revUrl(d.sort, d.page));
              else history.replaceState({ rsort: d.sort, rpage: d.page }, '', revUrl(d.sort, d.page));
            } catch (err) {}
            if (opts.scroll) revScrollToTop();
          })
          .catch(function () {
            revBusy = false;
            revList.removeAttribute('aria-busy');
            if (revPager) revPager.removeAttribute('aria-busy');
            if (opts.fallback) location.href = opts.fallback;
          });
      }

      if (revToolbar) revToolbar.addEventListener('click', function (e) {
        var b = e.target.closest('.sort-btn'); if (!b || !b.dataset.sort) return;
        e.preventDefault();
        if (b.classList.contains('active') || revBusy) return;
        revLoad(b.dataset.sort, 1, { push: true, scroll: true, fallback: b.href });
      });

      if (revPager) revPager.addEventListener('click', function (e) {
        var a = e.target.closest('a.rev-page'); if (!a || !a.dataset.page) return;
        e.preventDefault();
        revLoad(revState().sort, Number(a.dataset.page), { push: true, scroll: true, fallback: a.href });
      });

      window.addEventListener('popstate', function (e) {
        var s = e.state;
        if (!s || !s.rpage) {
          // Состояние без наших полей — это первый вход на страницу товара.
          var params = new URLSearchParams(location.search);
          s = { rsort: params.get('rsort') || 'new', rpage: Number(params.get('rpage')) || 1 };
        }
        var now = revState();
        if (s.rsort === now.sort && s.rpage === now.page) return;
        revLoad(s.rsort, s.rpage, { scroll: true });
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
              msg.textContent = d.message || 'Спасибо за отзыв!';
              rf.reset();
              var h = document.getElementById('rating-value'); if (h) h.value = 5;
              document.querySelectorAll('.rate-star').forEach(function (s) { s.classList.add('on'); });
              // перезагружаем страницу: сервер отдаст список отзывов уже с этим отзывом
              try { sessionStorage.setItem('review_thanks', '1'); } catch (e) {}
              setTimeout(function () { location.reload(); }, 400);
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
      items: Cart.items.map(function (i) { return { id: i.id, qty: i.qty, storage: i.storage || '', color: i.color || '', band: i.band || '', bandSize: i.bandSize || '', options: i.options || [] }; }),
      customerName: (document.getElementById('co-name') || {}).value || '',
      contact: contact,
      address: (document.getElementById('co-address') || {}).value || ''
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
