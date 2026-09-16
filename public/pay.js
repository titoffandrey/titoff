'use strict';
/*
 * Страница оплаты (схема H2H). Скрипт делает ровно три вещи: считает время до
 * истечения счёта, копирует реквизиты и опрашивает статус.
 *
 * Разметку состояния целиком рисует сервер (payPage в lib/render.js), а любая
 * смена состояния — перезагрузка страницы. Так вид «ждём перевод» / «оплачено» /
 * «счёт истёк» описан в одном месте, а не продублирован здесь.
 */
(function () {
  var page = document.getElementById('pay-page');
  if (!page) return;

  var orderId = page.dataset.order || '';
  var state = page.dataset.state || '';
  var hosted = page.dataset.hosted === '1';
  var attemptId = /^[a-f0-9]{24,64}$/.test(page.dataset.attempt || '') ? page.dataset.attempt : '';
  var expires = Number(page.dataset.expires || 0) || 0;

  /* ССЫЛКА КАССЫ ОТКРЫВАЕТСЯ САМА — ОДИН РАЗ, сразу после выставления счёта.
   *
   * Оформление и кнопка «Перейти к оплате» приводят сюда с `?go=1`. Пока
   * покупатель уходил на ссылку прямо с оформления, в истории у него
   * оставалась страница оформления с уже пустой корзиной, а нашей страницы
   * оплаты не было нигде: вернувшись из банка, он видел не «платёж получен», а
   * пустое оформление. Теперь путь такой: оформление → эта страница → ссылка.
   * Метка снимается из адреса ДО перехода (`replaceState`), поэтому «назад» из
   * банка или из страницы СБП возвращает сюда без второго прыжка, а если
   * приложение банка перехватило переход (Android), вкладка так и остаётся на
   * этой странице — она сама опросит статус и покажет оплату. Ссылку берём из
   * разметки: сервер кладёт её только у живого hosted-счёта. */
  (function autoOpen() {
    var params;
    try { params = new URLSearchParams(location.search); } catch (e) { return; }
    if (params.get('go') !== '1') return;
    params.delete('go');
    var rest = params.toString();
    try { history.replaceState(history.state, '', location.pathname + (rest ? '?' + rest : '') + location.hash); } catch (e) {}
    var link = safeHostedUrl(page.dataset.hostedUrl);
    if (!link || !hosted || state !== 'pending') return;
    /* Уходим ПОСЛЕ `load`, а не сразу: переход, сделанный скриптом до конца
     * загрузки, Chrome считает клиентским редиректом и ЗАМЕНЯЕТ им запись в
     * истории — «назад» из банка перепрыгивал бы нашу страницу (проверено в
     * предпросмотре). После `load` это обычный переход, и страница остаётся. */
    var go = function () { setTimeout(function () { location.assign(link); }, 0); };
    if (document.readyState === 'complete') go();
    else window.addEventListener('load', go, { once: true });
  })();
  // Валюта счёта. Её выбирают ссылками (разметку рисует сервер), сюда она
  // приезжает готовой — скрипт только передаёт её вместе со способом, чтобы
  // счёт вышел в той же валюте, сумму которой покупатель видел на странице.
  var currency = page.dataset.currency || '';
  // Рублёвая сумма заказа — ценность целей для Метрики (`order_price`).
  var total = Number(page.dataset.total || 0) || 0;

  /* Цель Яндекс Метрики — тот же договор, что в app.js: `window.ymGoal` есть
   * только там, где сервер подключил счётчик; без него идём дальше сразу. */
  function reachGoal(name, params, once, done) {
    if (typeof window.ymGoal === 'function') window.ymGoal(name, params, once, done);
    else if (typeof done === 'function') done();
  }

  /* Страница пришла оплаченной — это цель «оплачено» и покупка для
   * электронной коммерции, по разу на заказ (ключ одноразовости живёт в
   * localStorage, см. public/ym.js): страницу оплаты открывают повторно, а
   * платят один раз. Состав заказа сервер кладёт в разметку только у
   * оплаченного. */
  if (page.dataset.paid === '1') {
    var items = [];
    try { items = JSON.parse(page.dataset.items || '[]'); } catch (e) { items = []; }
    reachGoal('paid', { order_price: total, currency: 'RUB' }, 'paid:' + orderId, null);
    if (typeof window.ymPurchase === 'function') {
      window.ymPurchase({ id: page.dataset.number || orderId, revenue: total, products: Array.isArray(items) ? items : [] }, 'purchase:' + orderId);
    }
  }

  /* ------------------------------ Копирование ------------------------------ */
  // Номер карты покупатель переносит в банковское приложение — это главное
  // действие на странице, поэтому запасной путь обязателен: clipboard-API нет в
  // старых браузерах и он не работает без https.
  function legacyCopy(text) {
    return new Promise(function (resolve, reject) {
      var ta = null;
      try {
        ta = document.createElement('textarea');
        ta.value = text;
        ta.setAttribute('readonly', '');
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        var ok = document.execCommand('copy');
        ok ? resolve() : reject(new Error('copy_failed'));
      } catch (e) { reject(e); }
      finally {
        // execCommand иногда бросает исключение (в частности, внутри iframe).
        // Временное поле и в этом случае не должно остаться в документе.
        if (ta && ta.parentNode) ta.parentNode.removeChild(ta);
      }
    });
  }
  function copyText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      // Отказ в разрешении ещё не означает, что старый безопасный путь не
      // сработает. Для .onion без привычного secure-context это особенно важно.
      return Promise.resolve().then(function () {
        return navigator.clipboard.writeText(text);
      }).catch(function () { return legacyCopy(text); });
    }
    return legacyCopy(text);
  }

  page.addEventListener('click', function (e) {
    var btn = e.target.closest ? e.target.closest('.pay-copy') : null;
    if (!btn) return;
    var text = btn.dataset.copy || '';
    if (!text) return;
    copyText(text).then(function () {
      var was = btn.textContent;
      btn.textContent = 'Скопировано';
      btn.classList.add('is-done');
      setTimeout(function () { btn.textContent = was; btn.classList.remove('is-done'); }, 1600);
    }).catch(function () {
      // Разовый отказ (нет разрешения, старый браузер) не должен оставлять
      // кнопку с этой подписью навсегда: реквизит рядом, его можно выделить
      // руками, а со следующей попытки копирование обычно срабатывает.
      var was = btn.textContent;
      btn.textContent = 'Выделите вручную';
      setTimeout(function () { btn.textContent = was; }, 2600);
    });
  });

  /* Отмена оплаты необратима — спрашиваем, как в панели, по `data-confirm`.
   * Форма при этом остаётся обычной: без скрипта она просто отправится сразу,
   * и отменить заказ по-прежнему можно. */
  page.addEventListener('submit', function (e) {
    var form = e.target && e.target.closest ? e.target.closest('form[data-confirm]') : null;
    if (form && !window.confirm(form.getAttribute('data-confirm'))) e.preventDefault();
  });

  /* -------------------------------- Обратный отсчёт ------------------------- */
  var left = document.getElementById('pay-left');
  var timerBox = document.getElementById('pay-timer');
  // Перезагрузку по нулю заводим ровно один раз: первый `tick()` идёт до
  // `setInterval`, и без флага дошедший до нуля отсчёт успел бы поставить её
  // дважды.
  var reloading = false;
  function tick() {
    if (!left || !expires || reloading) return;
    var ms = expires - Date.now();
    if (ms <= 0) {
      /* Истёкший счёт перерисовывает сервер: реквизиты у него уже чужие, а у
       * заказа к этому моменту вышел и его собственный срок оплаты.
       *
       * Отсчёт при этом ОСТАНАВЛИВАЕМ и ждём секунду с небольшим. Часы браузера
       * и сервера расходятся на секунды, и спешащий браузер перезагружал бы
       * страницу, на которой срок ещё не вышел, — та приходила бы со счётчиком,
       * тот сразу же снова доходил до нуля, и так по кругу. Пауза покрывает
       * расхождение и превращает круг в одну перезагрузку.
       */
      left.textContent = '0:00';
      reloading = true;
      if (countdownTimer) { clearInterval(countdownTimer); countdownTimer = null; }
      setTimeout(function () { location.reload(); }, 1500);
      return;
    }
    // Часы приписываются, только когда они правда есть, — как в панели
    // (`payLeftText` в lib/render.js). Счета живут минуты, но касса вправе
    // выдать и длинный срок, а «291:24» читается не как время, а как ошибка.
    var total = Math.floor(ms / 1000);
    var hh = Math.floor(total / 3600), mm = Math.floor((total % 3600) / 60), ss = total % 60;
    var pad = function (n) { return (n < 10 ? '0' : '') + n; };
    left.textContent = hh ? hh + ':' + pad(mm) + ':' + pad(ss) : mm + ':' + pad(ss);
    // Последние две минуты меняют только цвет карточки, без мигания: срок
    // становится заметен, но интерфейс не давит на покупателя каждую секунду.
    if (timerBox) timerBox.classList.toggle('is-urgent', ms <= 2 * 60 * 1000);
  }
  var countdownTimer = null;
  if (expires && timerBox) { timerBox.hidden = false; tick(); countdownTimer = setInterval(tick, 1000); }

  /* ------------------------------ Выставить счёт ---------------------------- */
  var create = document.getElementById('pay-create');
  var msg = document.getElementById('pay-msg');
  function showMsg(text) {
    if (!msg) return;
    msg.hidden = false;
    msg.className = 'form-msg err';
    msg.textContent = text;
  }
  function chosenMethod() {
    var on = document.querySelector('input[name="pay-method"]:checked');
    return on ? on.value : '';
  }
  function chosenHosted() {
    var on = document.querySelector('input[name="pay-method"]:checked');
    return !!(on && on.dataset.hosted === '1');
  }
  function createLabel() { return chosenHosted() ? 'Перейти к оплате' : 'Получить реквизиты'; }
  var REQUEST_TTL = 5 * 60 * 1000;
  var REQUEST_ROOT = 'pay_request_v1:' + orderId;
  function requestKey(method) { return REQUEST_ROOT + ':' + currency + ':' + method; }
  function newRequestId() {
    var bytes = new Uint8Array(16);
    if (window.crypto && window.crypto.getRandomValues) window.crypto.getRandomValues(bytes);
    else for (var i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
    return Array.prototype.map.call(bytes, function (n) { return n.toString(16).padStart(2, '0'); }).join('');
  }
  function paymentRequestId(method) {
    var key = requestKey(method);
    var saved = null;
    try { saved = JSON.parse(localStorage.getItem(key) || 'null'); } catch (e) {}
    if (saved && /^[a-f0-9]{32}$/.test(String(saved.id || ''))
      && saved.method === method && saved.currency === currency
      && Date.now() - Number(saved.at || 0) >= 0
      && Date.now() - Number(saved.at || 0) < REQUEST_TTL) return saved.id;
    var id = newRequestId();
    var at = Date.now();
    try { localStorage.setItem(key, JSON.stringify({ id: id, method: method, currency: currency, at: at })); } catch (e) {}
    schedulePaymentRequestExpiry(key, id, at);
    return id;
  }
  function clearPaymentRequest(key, expectedId) {
    if (expectedId) {
      var current = null;
      try { current = JSON.parse(localStorage.getItem(key) || 'null'); } catch (e) {}
      // Другая вкладка уже начала новую попытку — старый ответ не вправе стереть
      // её защитный ключ.
      if (current && String(current.id || '') !== String(expectedId)) return;
    }
    try { localStorage.removeItem(key); } catch (e) {}
  }
  function schedulePaymentRequestExpiry(key, id, at) {
    var age = Date.now() - Number(at || 0);
    setTimeout(function () { clearPaymentRequest(key, id); }, Math.max(0, REQUEST_TTL - age) + 50);
  }
  // Просроченный/битый ключ не содержит платёжных данных, но и бессрочно лежать
  // в браузере не должен. Свежий удалим точно по TTL, пока страница открыта;
  // после закрытия — при следующем открытии своей страницы заказа.
  (function cleanPaymentRequest() {
    var keys = [];
    try {
      for (var i = 0; i < localStorage.length; i++) {
        var key = localStorage.key(i);
        if (key === REQUEST_ROOT || (key && key.indexOf(REQUEST_ROOT + ':') === 0)) keys.push(key);
      }
    } catch (e) {}
    keys.forEach(function (key) {
      var saved = null;
      try { saved = JSON.parse(localStorage.getItem(key) || 'null'); } catch (e) {}
      var age = saved && typeof saved.at === 'number' ? Date.now() - saved.at : NaN;
      if (!saved || !/^[a-f0-9]{32}$/.test(String(saved.id || ''))
        || !isFinite(age) || age < 0 || age >= REQUEST_TTL) {
        clearPaymentRequest(key, saved && saved.id);
        return;
      }
      schedulePaymentRequestExpiry(key, saved.id, saved.at);
    });
  })();
  function startPayment(btn, label) {
    if (btn.disabled) return;
    var method = chosenMethod();
    if (!method) { showMsg('Выберите способ оплаты'); return; }
    var requestStorageKey = requestKey(method);
    var requestId = paymentRequestId(method);
    btn.disabled = true;
    btn.textContent = chosenHosted() ? 'Открываем оплату…' : 'Ищем доступные реквизиты…';
    // Адрес без имени кассы: их несколько, и какая выдаст реквизиты — решает
    // сервер. Покупателю это не показывается нигде, даже в адресе запроса.
    fetch('/api/pay/start', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        orderId: orderId, method: method, currency: currency,
        requestId: requestId
      })
    })
      .then(function (r) {
        return r.json().then(function (d) { return { status: r.status, data: d }; });
      })
      .then(function (reply) {
        var d = reply.data;
        // 409 означает, что прежний запрос ещё работает; timeout и неизвестная
        // ошибка тоже двусмысленны — касса могла выпустить invoice до обрыва.
        // Ключ сохраняем, чтобы повтор не создал второй счёт. Явный отказ
        // (например, no_requisite) — однозначный и освобождает следующий клик.
        var uncertain = d && ['payment_processing', 'timeout', 'provider_error'].indexOf(d.errorCode) !== -1;
        // Совместимость на время обновления процесса: старая версия сервера не
        // присылала code у 409, и такой ответ безопаснее считать незавершённым.
        if (reply.status === 409 && d && !d.errorCode) uncertain = true;
        if (!uncertain) clearPaymentRequest(requestStorageKey, requestId);
        /* Корзину чистим ТОЛЬКО когда счёт реально выставлен.
         *
         * Раньше она чистилась и на отказе кассы (по флагу `placed`): заказ ведь
         * записан. Но покупателю от этого оставалась пустая корзина и пустая
         * форма — заплатить не вышло, а вернуться назад и попробовать снова не с
         * чем. Отказ кассы (таймаут, кончились свободные реквизиты) — её обычное
         * дело, и терять на нём покупку нельзя.
         *
         * Заказ при этом сохранён и виден менеджеру, а на витрине про него
         * напоминает полоса под шапкой (`payRemind` в server.js) — так что
         * второй такой же заказ покупатель оформит разве что нарочно. */
        if (d && d.terminal === 'order_cancelled') { location.href = safePayUrl(d.url); return; }
        if (d && d.ok && window.Cart && Cart.clear) { Cart.hold(orderId); Cart.clear(); }
        // Способ выбран — черновик стал заказом, и это цель «заказ» для Директа.
        // `placed` стоит и у отказа кассы (заказ записан, менеджер его видит),
        // поэтому цель уходит и тогда; повтор по тому же заказу отсекает ключ
        // одноразовости. Переход на выданный адрес ждёт отправки цели.
        var placed = !!(d && (d.ok || d.placed));
        // Hosted-способ продолжает оплату на защищённой странице сервиса.
        // Обычные реквизиты и любой непригодный адрес возвращают к нашему заказу.
        if (d && d.ok) {
          // На ссылку кассы уходим не отсюда, а через перезагруженную страницу
          // оплаты с `?go=1` (см. autoOpen выше): так она остаётся в истории.
          var target = safePayUrl(d.url);
          if (chosenHosted() && safeHostedUrl(d.hostedUrl)) target += (target.indexOf('?') === -1 ? '?' : '&') + 'go=1';
          reachGoal('order', { order_price: total, currency: 'RUB' }, 'order:' + orderId, function () {
            location.href = target;
          });
          return;
        }
        if (placed) reachGoal('order', { order_price: total, currency: 'RUB' }, 'order:' + orderId, null);
        var error = (d && d.error) || 'Не удалось выставить счёт';
        var next = null;
        if (d && d.suggestedMethod) {
          var suggested = String(d.suggestedMethod);
          Array.prototype.some.call(document.querySelectorAll('input[name="pay-method"]'), function (radio) {
            if (radio.value !== suggested) return false;
            next = radio;
            return true;
          });
        }
        if (next) {
          next.checked = true;
          error += ' Мы уже выбрали запасной вариант «' + (d.suggestedName || d.suggestedMethod) + '» — ' + (chosenHosted() ? 'можно перейти к оплате.' : 'осталось получить реквизиты.');
        }
        showMsg(error);
        btn.disabled = false;
        btn.textContent = next ? 'Попробовать ' + (d.suggestedName || d.suggestedMethod) : label;
      })
      .catch(function () {
        showMsg('Ошибка сети. Попробуйте ещё раз');
        btn.disabled = false; btn.textContent = label;
      });
  }
  function safePayUrl(value) {
    var fallback = '/pay/' + encodeURIComponent(orderId);
    try {
      var url = new URL(String(value || fallback), location.origin);
      // Ответ API не является разрешением увести покупателя на произвольный
      // домен или javascript:-URL. Оплата в этой схеме всегда продолжает ровно
      // страницу текущего заказа; query может содержать выбранную попытку.
      if (url.origin !== location.origin || url.pathname !== fallback) return fallback;
      return url.pathname + url.search + url.hash;
    } catch (e) { return fallback; }
  }
  // Хост сервиса проверил адаптер на сервере; браузер повторяет общие проверки
  // ссылки перед навигацией, не получая списка касс и их доменов.
  function safeHostedUrl(value) {
    try {
      var url = new URL(String(value || ''));
      return url.protocol === 'https:' && url.hostname && !url.username && !url.password ? url.href : '';
    } catch (e) { return ''; }
  }
  if (create) {
    create.addEventListener('click', function () { startPayment(create, createLabel()); });
    page.addEventListener('change', function (e) {
      if (e.target && e.target.name === 'pay-method' && !create.disabled) create.textContent = createLabel();
    });
  }

  /* ------------------------------ Опрос статуса ----------------------------- */
  // Опрашиваем, только пока ждём перевод и пока вкладка видима: фоновая
  // страница деньги всё равно не увидит, а запросы к кассе тратит.
  var stateBox = document.getElementById('pay-state');
  var recheck = document.getElementById('pay-recheck');
  var busy = false;
  var pollTimer = null;

  function poll(manual) {
    if (busy || state !== 'pending') return;
    busy = true;
    fetch('/api/pay/status?order=' + encodeURIComponent(orderId)
      + (attemptId ? '&attempt=' + encodeURIComponent(attemptId) : ''), { headers: { Accept: 'application/json' } })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        busy = false;
        if (!d || !d.ok) {
          if (manual && stateBox) stateBox.textContent = 'Не удалось проверить оплату. Проверьте соединение и попробуйте ещё раз.';
          return;
        }
        // Любое состояние, кроме ожидания, меняет всю страницу целиком.
        if (d.state && d.state !== 'pending') { location.reload(); return; }
        if (manual && stateBox) stateBox.textContent = hosted
          ? 'Оплата пока не подтверждена. Это занимает до нескольких минут — страница обновится сама.'
          : 'Перевод пока не виден. Это занимает до нескольких минут — страница обновится сама.';
      })
      .catch(function () {
        busy = false;
        if (manual && stateBox) stateBox.textContent = 'Не удалось проверить оплату. Проверьте соединение и попробуйте ещё раз.';
      });
  }

  if (state === 'pending') {
    pollTimer = setInterval(function () {
      if (document.visibilityState === 'visible') poll(false);
    }, 7000);
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'visible') poll(false);
    });
  }
  if (recheck) recheck.addEventListener('click', function () {
    if (stateBox) stateBox.textContent = 'Проверяем…';
    poll(true);
  });

  window.addEventListener('pagehide', function () {
    if (countdownTimer) clearInterval(countdownTimer);
    if (pollTimer) clearInterval(pollTimer);
  });

})();
