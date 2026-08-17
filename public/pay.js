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
  var expires = Number(page.dataset.expires || 0) || 0;

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
  function startPayment(btn, label) {
    var method = chosenMethod();
    if (!method) { showMsg('Выберите способ оплаты'); return; }
    btn.disabled = true;
    btn.textContent = 'Выставляем счёт…';
    fetch('/api/pay/crocopay/start', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ orderId: orderId, method: method })
    })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        // Способ выбран — заказ перестал быть черновиком, значит корзину пора
        // очистить: иначе покупатель оформит второй такой же заказ. Флаг
        // приходит и с ошибкой кассы: заказ настоящий и там.
        if (d && d.placed && window.Cart && Cart.clear) Cart.clear();
        // Реквизиты рисует сервер, поэтому на успех просто открываем страницу
        // заново — но ИМЕННО по адресу из ответа, а не reload: в текущем адресе
        // может остаться ?choose=1, и тогда покупатель после выставления счёта
        // снова увидел бы выбор способа вместо реквизитов.
        if (d && d.ok) { location.href = d.url || ('/pay/' + encodeURIComponent(orderId)); return; }
        showMsg((d && d.error) || 'Не удалось выставить счёт');
        btn.disabled = false; btn.textContent = label;
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
    fetch('/api/pay/crocopay/status?order=' + encodeURIComponent(orderId), { headers: { Accept: 'application/json' } })
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

  // «Выбрать другой способ» — обычный переход с ?choose=1: по нему сервер рисует
  // выбор даже при действующем счёте. Прежний счёт у кассы при этом не
  // отменяется и остаётся оплачиваемым — если покупатель всё же переведёт по
  // нему, платёж дойдёт вебхуком: token один на заказ, а не на счёт.
  var swap = document.getElementById('pay-switch');
  if (swap) swap.addEventListener('click', function () {
    location.href = '/pay/' + encodeURIComponent(orderId) + '?choose=1';
  });
})();
