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
  var attemptId = /^[a-f0-9]{24,64}$/.test(page.dataset.attempt || '') ? page.dataset.attempt : '';
  var expires = Number(page.dataset.expires || 0) || 0;
  // Валюта счёта. Её выбирают ссылками (разметку рисует сервер), сюда она
  // приезжает готовой — скрипт только передаёт её вместе со способом, чтобы
  // счёт вышел в той же валюте, сумму которой покупатель видел на странице.
  var currency = page.dataset.currency || '';

  /* ------------------------------ Копирование ------------------------------ */
  // Номер карты покупатель переносит в банковское приложение — это главное
  // действие на странице, поэтому запасной путь обязателен: clipboard-API нет в
  // старых браузерах и он не работает без https.
  function copyText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text);
    }
    return new Promise(function (resolve, reject) {
      try {
        var ta = document.createElement('textarea');
        ta.value = text;
        ta.setAttribute('readonly', '');
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        var ok = document.execCommand('copy');
        document.body.removeChild(ta);
        ok ? resolve() : reject();
      } catch (e) { reject(e); }
    });
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

  /* -------------------------------- Обратный отсчёт ------------------------- */
  var left = document.getElementById('pay-left');
  var timerBox = document.getElementById('pay-timer');
  function tick() {
    if (!left || !expires) return;
    var ms = expires - Date.now();
    if (ms <= 0) {
      // Истёкший счёт перерисовывает сервер: реквизиты у него уже чужие.
      location.reload();
      return;
    }
    var total = Math.floor(ms / 1000);
    var mm = Math.floor(total / 60), ss = total % 60;
    left.textContent = mm + ':' + (ss < 10 ? '0' : '') + ss;
  }
  if (expires && timerBox) { timerBox.hidden = false; tick(); setInterval(tick, 1000); }

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
    var method = chosenMethod();
    if (!method) { showMsg('Выберите способ оплаты'); return; }
    var requestStorageKey = requestKey(method);
    var requestId = paymentRequestId(method);
    btn.disabled = true;
    btn.textContent = 'Ищем доступные реквизиты…';
    fetch('/api/pay/crocopay/start', {
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
        if (d && d.ok && window.Cart && Cart.clear) Cart.clear();
        // Реквизиты рисует сервер, поэтому на успех открываем выданный им адрес.
        // Это заодно убирает из URL прежний выбор валюты.
        if (d && d.ok) { location.href = d.url || ('/pay/' + encodeURIComponent(orderId)); return; }
        var error = (d && d.error) || 'Не удалось выставить счёт';
        var next = d && d.suggestedMethod
          ? document.querySelector('input[name="pay-method"][value="' + String(d.suggestedMethod).replace(/"/g, '') + '"]') : null;
        if (next) {
          next.checked = true;
          error += ' Мы уже выбрали запасной вариант «' + (d.suggestedName || d.suggestedMethod) + '» — осталось получить реквизиты.';
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
  if (create) create.addEventListener('click', function () { startPayment(create, 'Получить реквизиты'); });

  /* ------------------------------ Опрос статуса ----------------------------- */
  // Опрашиваем, только пока ждём перевод и пока вкладка видима: фоновая
  // страница деньги всё равно не увидит, а запросы к кассе тратит.
  var stateBox = document.getElementById('pay-state');
  var recheck = document.getElementById('pay-recheck');
  var busy = false;

  function poll(manual) {
    if (busy || state !== 'pending') return;
    busy = true;
    fetch('/api/pay/crocopay/status?order=' + encodeURIComponent(orderId)
      + (attemptId ? '&attempt=' + encodeURIComponent(attemptId) : ''), { headers: { Accept: 'application/json' } })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        busy = false;
        if (!d || !d.ok) return;
        // Любое состояние, кроме ожидания, меняет всю страницу целиком.
        if (d.state && d.state !== 'pending') { location.reload(); return; }
        if (manual && stateBox) stateBox.textContent = 'Перевод пока не виден. Это занимает до нескольких минут — страница обновится сама.';
      })
      .catch(function () { busy = false; });
  }

  if (state === 'pending') {
    setInterval(function () {
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

})();
