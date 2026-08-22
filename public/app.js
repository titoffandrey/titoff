/* Витрина: корзина (localStorage), оформление заказа, отзывы. Без зависимостей. */
(function () {
  'use strict';
  var KEY = 'cart_v1';
  var ANALYTICS_DISABLED_KEY = 'analytics_disabled_v1';
  var analyticsTimer = null;
  var CUR = window.__CURRENCY__ || '₽';
  var POS = window.__CURPOS__ || 'after';
  // Пределы одной покупки — от сервера (см. «Пределы одной покупки» в CLAUDE.md).
  // Своих чисел витрина не держит: они разъехались бы с серверными, а отказ
  // всё равно за сервером. Из них берутся и потолок количества на странице
  // товара, и «нет в наличии» у слишком дорогих сборок, и проверка на оформлении.
  var ORDER_MIN = Number(window.__ORDER_MIN__) || 0;
  var ORDER_MAX = Number(window.__ORDER_MAX__) || 0;
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

  /* Мелкие глифы в подписях полей контактов: WhatsApp и сотовый у телефона,
   * Telegram и почта у второго канала. Подпись словом «WhatsApp» без значка
   * читается как условие, значок — как способ связи, который узнают с одного
   * взгляда.
   *
   * Глифы ЗАЛИТЫЕ, а не волосяные (в отличие от значков характеристик и блока
   * доверия): в строке подписи это 13–16 px, и на таком размере контур не
   * читается — то же правило, что у знаков оплаты. Цвет не задаётся вовсе:
   * `fill:currentColor` берёт его у текста подписи, поэтому значок и шрифт
   * всегда одного цвета, включая серую подпись под полем.
   *
   * Глиф Telegram — тот же, что у `tgIcon()` в lib/render.js: витрина рисуется
   * и сервером, и скриптом, а значок бренда в проекте должен быть один.
   */
  var NOTE_ICONS = {
    whatsapp: '<path d="M12.05 2A9.86 9.86 0 0 0 3.6 16.9L2.6 21.4l4.62-1.2A9.86 9.86 0 1 0 12.05 2Zm5.72 13.9c-.24.68-1.4 1.3-1.96 1.38-.5.08-1.13.11-1.83-.11-.42-.14-.96-.31-1.65-.61-2.9-1.26-4.8-4.2-4.95-4.4-.14-.19-1.18-1.57-1.18-3s.75-2.13 1.02-2.42c.26-.29.58-.36.77-.36h.55c.18 0 .42-.07.65.5.24.58.81 2 .88 2.15.07.14.12.31.02.5-.1.2-.14.32-.29.49-.14.17-.3.38-.43.51-.14.14-.29.3-.13.59.17.29.75 1.24 1.61 2.01 1.11.99 2.04 1.29 2.33 1.44.29.14.46.12.63-.07.17-.2.72-.84.92-1.13.19-.29.38-.24.64-.14.26.1 1.67.79 1.96.93.29.15.48.22.55.34.07.12.07.7-.17 1.38Z"/>',
    mobile: '<path fill-rule="evenodd" d="M8.6 1.6h6.8A2.6 2.6 0 0 1 18 4.2v15.6a2.6 2.6 0 0 1-2.6 2.6H8.6A2.6 2.6 0 0 1 6 19.8V4.2a2.6 2.6 0 0 1 2.6-2.6Zm1.15 2.6a.55.55 0 0 0 0 1.1h4.5a.55.55 0 0 0 0-1.1h-4.5Z"/>',
    telegram: '<path d="M9.78 18.65l.28-4.23 7.68-6.92c.34-.31-.07-.46-.52-.19L7.74 13.3 3.64 12c-.88-.25-.89-.86.2-1.3l15.97-6.16c.73-.33 1.43.18 1.15 1.3l-2.72 12.81c-.19.91-.74 1.13-1.5.71l-4.15-3.06-1.99 1.94c-.23.23-.42.42-.83.42z"/>',
    mail: '<path d="M2.4 6.2A2 2 0 0 1 4.4 4.5h15.2a2 2 0 0 1 2 1.7L12 12.6 2.4 6.2Z"/><path d="M2.25 8.2 11.6 14.4a.7.7 0 0 0 .8 0l9.35-6.2V17a2 2 0 0 1-2 2H4.25a2 2 0 0 1-2-2V8.2Z"/>'
  };
  // Значок и слово, к которому он относится, — одним куском: иначе перенос
  // строки оставляет значок в конце одной строки, а слово уводит на другую.
  function iconWord(name, word) {
    var glyph = NOTE_ICONS[name]
      ? '<svg class="note-ico" viewBox="0 0 24 24" aria-hidden="true">' + NOTE_ICONS[name] + '</svg>'
      : '';
    return '<span class="ico-word">' + glyph + escapeHtml(word) + '</span>';
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
          // Цена для сравнения приходит от сервера тем же расчётом, что и
          // зачёркнутая на карточке. Ноль — сравнивать не с чем, и ноль тоже
          // является обновлением: акция могла закончиться, пока товар лежал.
          item.compare = Number(fresh.compare) > 0 ? Number(fresh.compare) : 0;
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

  /* Скидка позиции: цена для сравнения, процент и выгода в рублях — или null,
   * когда сравнивать не с чем. Цену сравнения считает СЕРВЕР и присылает её в
   * ответе /api/cart (`compareFor` в lib/discount.js): своей формулы у витрины
   * нет, она разошлась бы с каталогом на первом же товаре с доплатой. Процент
   * выводится обратно из пары чисел и совпадает со скидкой товара — старая цена
   * округляется до десятки ровно ради этого.
   */
  function itemSale(i) {
    var cmp = Number(i.compare) || 0, price = Number(i.price) || 0;
    if (!(cmp > price) || price <= 0) return null;
    return { compare: cmp, saved: cmp - price, pct: Math.round((1 - price / cmp) * 100) };
  }
  // ===== Страница оформления (/checkout) =====
  // Три блока, а не «список слева, форма справа»: товары и форма идут одной
  // колонкой сверху вниз (шаг за шагом), а справа липнет только сводка. Прежняя
  // раскладка отдавала форме узкую полосу, пока широкая колонка с одним товаром
  // стояла почти пустой.
  function renderCheckoutPage() {
    var items = document.getElementById('checkout-items');
    var form = document.getElementById('checkout-form');
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
      // Удаление последнего товара снимает DOM формы без navigation/pagehide.
      // Сохраняем активное поле прямо перед этим, иначе последняя правка могла
      // исчезнуть вместе с элементом, не успев дать `change`.
      rememberCheckout();
      if (form) { form.innerHTML = ''; delete form.dataset.ready; }
      side.innerHTML = '';
      return;
    }

    var count = Cart.count();
    items.innerHTML = '<div class="co-block">'
      + '<div class="co-block-head">'
      + '<h2 class="co-block-title"><span class="co-step" aria-hidden="true">1</span>Ваш заказ'
      + '<span class="co-block-count">' + count + ' ' + plural(count, 'товар', 'товара', 'товаров') + '</span></h2>'
      + '<a class="co-back" href="/">← <span class="co-back-full">Продолжить покупки</span><span class="co-back-short">В каталог</span></a>'
      + '</div>'
      + '<div class="co-list">'
      + Cart.items.map(function (i) {
        var k = escapeHtml(itemKey(i));
        var variant = [i.storage, i.color, i.band, i.bandSize].concat(optionValues(i)).filter(Boolean).join(' · ');
        var out = i.available === false;
        var sale = itemSale(i);
        return '<article class="co-item' + (out ? ' co-item-out' : '') + '">'
          /* Плашки «Распродажа» здесь нет намеренно, хотя на карточке каталога
           * она есть: миниатюра тут 80 px, и слово в неё не влезает — обрезанное
           * «Распродаж» выглядит как поломка. Язык скидки несут цена, черта и
           * процент — те же классы, что и на главной, — а плашка была бы
           * четвёртым повтором одного и того же в одной строке. */
          + '<div class="co-item-media">' + itemThumb(i) + '</div>'
          + '<div class="co-item-body">'
          + '<h3 class="co-item-name">' + escapeHtml(i.name) + '</h3>'
          + (variant ? '<div class="co-item-variant">' + escapeHtml(variant) + '</div>' : '')
          + (out ? '<div class="co-item-warn">Нет в наличии — позиция не попадёт в заказ</div>' : '')
          // Цена за штуку — тем же набором классов, что и в карточке каталога:
          // розовая цена, зачёркнутая старая с наклонной чертой, розовый процент.
          + '<div class="co-item-unit">'
          + '<span class="card-price' + (sale ? ' price-sale' : '') + '">'
          + '<span class="price-now">' + money(i.price) + '</span>'
          + (sale ? '<span class="price-was"><span class="old-price">' + money(sale.compare) + '</span>'
            + (out ? '' : '<span class="save">−' + sale.pct + '%</span>') + '</span>' : '')
          // «за штуку» лежит ВНУТРИ ценового блока, а не рядом: снаружи оно
          // равнялось по первой строке и на узком экране повисало в стороне,
          // пока цена со скидкой переносилась на вторую.
          + '<span class="co-item-per">за штуку</span>'
          + '</span></div>'
          + '</div>'
          + '<div class="co-item-side">'
          + '<div class="co-item-sum">' + money(i.price * i.qty) + '</div>'
          // Выгода по позиции — рублями, а не процентом: процент уже стоит у
          // цены за штуку, а здесь важно, сколько именно покупатель не платит.
          + (sale && !out ? '<div class="co-item-save">выгода ' + money(sale.saved * i.qty) + '</div>' : '')
          + '<div class="co-item-controls">'
          + '<div class="cart-qty"><button type="button" data-act="dec" data-key="' + k + '" aria-label="Уменьшить количество">−</button>'
          + '<span>' + i.qty + '</span>'
          + '<button type="button" data-act="inc" data-key="' + k + '" aria-label="Увеличить количество"'
          + (i.qty >= Cart.fits(i) ? ' disabled title="Больше нельзя: один заказ — не более ' + escapeHtml(money(ORDER_MAX)) + '"' : '') + '>+</button></div>'
          + '<button type="button" class="co-remove" data-act="rm" data-key="' + k + '" aria-label="Удалить из корзины" title="Удалить">'
          + '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M7 3h6M4 6h12M6.5 6l.6 10a1.4 1.4 0 0 0 1.4 1.3h3a1.4 1.4 0 0 0 1.4-1.3l.6-10" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>'
          + '</button>'
          + '</div></div>'
          + '</article>';
      }).join('')
      + '</div></div>';

    // Форму собираем один раз, чтобы смена количества не стирала введённое.
    if (form && !form.dataset.ready) {
      form.dataset.ready = '1';
      form.innerHTML = '<div class="co-block">'
        + '<h2 class="co-block-title"><span class="co-step" aria-hidden="true">2</span>Получатель</h2>'
        + '<div class="co-names">'
        + '<div class="field"><label for="co-first-name">Имя <span class="req">*</span></label>'
        + '<input type="text" id="co-first-name" maxlength="60" placeholder="Иван" autocomplete="given-name" required></div>'
        + '<div class="field"><label for="co-last-name">Фамилия <span class="req">*</span></label>'
        + '<input type="text" id="co-last-name" maxlength="60" placeholder="Петров" autocomplete="family-name" required></div>'
        + '</div>'
        /* Телефон и второй контакт — ОДНИМ РЯДОМ, как имя с фамилией: это два
         * поля об одном и том же (как с вами связаться), и в столбик они
         * растягивали шаг «Получатель» на пустом месте. На узком экране ряд
         * складывается сам — там две колонки не встают.
         *
         * Телефон — отдельное обязательное поле, а не прежняя строка «контакт
         * для связи», куда писали что угодно. По нему менеджер подтверждает
         * заказ, его же перевозчик ставит в накладную, и годится для этого
         * только номер. Флаг и формат подставляются сами по набранному коду
         * страны — см. `public/phone.js`; своей разметки скрипт телефона не
         * создаёт, поэтому без него поле остаётся обычным вводом. */
        + '<div class="co-contacts">'
        + '<div class="field"><label for="co-phone">Телефон <span class="req">*</span></label>'
        + '<div class="phone-box">'
        + '<span class="phone-flag" aria-hidden="true"></span>'
        + '<input type="tel" id="co-phone" inputmode="tel" autocomplete="tel" maxlength="24"'
        + ' placeholder="+7 900 000-00-00" required>'
        + '</div>'
        // Подпись говорит, КАКОЙ номер нужен, а не что с ним будет: WhatsApp
        // подходит менеджеру так же, как звонок, и знать это надо до ввода.
        + '<p class="field-note">Введите номер ' + iconWord('whatsapp', 'WhatsApp')
        + ' или ' + iconWord('mobile', 'сотовый') + '</p></div>'
        // Второй канал связи — по желанию: телефон уже обязателен, и требовать
        // ещё и Telegram значило бы спрашивать одно и то же дважды. Звёздочки
        // у подписи нет, и этого достаточно — отдельная строка «по желанию»
        // повторяла бы то же самое словами.
        + '<div class="field"><label for="co-contact">' + iconWord('telegram', 'Telegram')
        + ' или ' + iconWord('mail', 'e-mail') + '</label>'
        + '<input type="text" id="co-contact" maxlength="120" placeholder="@nickname или mail@example.com">'
        + '</div>'
        + '</div>'
        /* Адрес покупателя — ЕГО ДАННЫЕ, наравне с именем и контактом, поэтому
         * стоит здесь, а не в доставке. Выбор пункта выдачи его не трогает: по
         * нему считается зона, ищутся ближайшие пункты и везёт курьер. Пока поле
         * было одно на двоих, адрес пункта затирал адрес покупателя, и при уходе
         * на курьера его приходилось восстанавливать из памяти скрипта.
         */
        + '<div class="field"><label for="co-address">Адрес <span class="req">*</span></label>'
        + '<div class="suggest-box">'
        + '<input type="text" id="co-address" maxlength="400" placeholder="Город, улица, дом" autocomplete="street-address"'
        + ' role="combobox" aria-expanded="false" aria-autocomplete="list" aria-controls="co-address-list" required>'
        + '<div class="suggest-list" id="co-address-list" role="listbox" hidden></div>'
        + '</div>'
        + '<p class="field-note" id="co-address-note">' + escapeHtml(addressNote()) + '</p></div>'
        + '</div>'
        // Способ доставки идёт ПОСЛЕ адреса: цена зависит от региона, и до
        // адреса у карточек нечего показать, кроме прочерка.
        + '<div class="co-block">'
        + '<h2 class="co-block-title"><span class="co-step" aria-hidden="true">3</span>Доставка</h2>'
        + '<div class="co-ways is-locked" id="co-ways">'
        + '<span class="co-modes-label">Способ доставки</span>'
        + deliveryChoiceHtml()
        + '<div class="co-modes" id="co-modes"></div>'
        + '<div class="co-points" id="co-points" hidden></div>'
        + '<p class="co-ways-note" id="co-ways-note">Укажите адрес — от него зависят сроки и стоимость доставки.</p>'
        + '</div>'
        + '</div>'
        + '<div class="co-submit">'
        + '<button type="button" class="btn btn-primary btn-block btn-lg btn-checkout" id="checkout-submit">'
        + '<span class="btn-checkout-label">Оформить заказ</span>'
        + '<span class="btn-checkout-sum" id="co-btn-sum">' + money(Cart.total()) + '</span></button>'
        + '<p class="form-msg" id="order-msg" hidden></p>'
        + '<p class="form-legal-note">' + payNote()
        + '<a href="/privacy" target="_blank" rel="noopener">Политика конфиденциальности</a></p>'
        + '</div>';
      initPhoneInput();
      initAddressSuggest();
      initDeliveryChoice();
      initAddressQuote();
      // Последней: она подставляет сохранённое и будит обработчики выше.
      initCheckoutMemory();
    }
    renderRail();
    syncSubmit();
    // Состав корзины меняет и подгонку итога под круглое число, поэтому цену
    // доставки пересчитываем — но только когда адрес уже введён.
    if (addressValue()) quoteDelivery(0);
  }

  // Кнопка оформления: сумма на ней, доступность и причина отказа под ней.
  // Считается по ИТОГУ с доставкой — платить покупатель будет именно его.
  function syncSubmit() {
    setText('co-btn-sum', money(orderTotal()));
    // Сумма вне пределов одной покупки — кнопка гаснет, а причина стоит прямо
    // под ней: серая кнопка без объяснения выглядит как поломка сайта.
    var overLimit = totalLimitError(orderTotal());
    var submit = document.getElementById('checkout-submit');
    if (submit) {
      var canOrder = Cart.availableCount() > 0;
      submit.disabled = !canOrder || !!overLimit;
      var label = submit.querySelector('.btn-checkout-label');
      if (label) label.textContent = canOrder ? submitLabel() : 'Нет доступных товаров';
    }
    var limitMsg = document.getElementById('order-msg');
    if (limitMsg && (overLimit || limitMsg.dataset.limit)) {
      limitMsg.hidden = !overLimit;
      limitMsg.className = 'form-msg err';
      limitMsg.textContent = overLimit;
      if (overLimit) limitMsg.dataset.limit = '1'; else delete limitMsg.dataset.limit;
    }
  }

  // Адрес меняет зону, а зона — цену. Слушаем и ввод (с задержкой внутри
  // quoteDelivery), и потерю фокуса: вставленный из буфера адрес события ввода
  // тоже даёт, а вот выбор подсказки — нет, его дёргает сам список.
  /* ===== Память формы оформления =====
   *
   * Покупатель, у которого не вышло оплатить (касса не ответила, свободных
   * реквизитов не нашлось), возвращается на оформление — и не должен набирать
   * заново имя, телефон, адрес, доставку и пункт выдачи. После отказа платёжки
   * это ровно та повторная работа, на которой покупку бросают.
   *
   * Лежит всё в браузере самого покупателя, рядом с корзиной, и никуда не
   * уходит: на сервер эти поля попадают только вместе с заказом, который он сам
   * отправил. Через неделю запись протухает и при следующем открытии оформления
   * удаляется из браузера.
   *
   * Значения возвращаются событием `change`, а не присваиванием: по нему
   * телефон переформатирует себя и поднимает флаг страны, а адрес пересчитывает
   * доставку и отпирает выбор способа. Событие `input` для этого не годится —
   * оно ещё и раскрыло бы список подсказок адреса поверх формы.
   */
  var FORM_KEY = 'checkout_v1';
  var FORM_TTL = 7 * 24 * 60 * 60 * 1000;
  var FORM_FIELDS = ['co-first-name', 'co-last-name', 'co-phone', 'co-contact', 'co-address'];
  var FORM_RADIOS = ['co-delivery', 'co-delivery-mode'];
  var FORM_LIMITS = { 'co-first-name': 60, 'co-last-name': 60, 'co-phone': 24, 'co-contact': 120, 'co-address': 400 };
  function checkedValue(name) {
    var radios = document.querySelectorAll ? document.querySelectorAll('input[name="' + name + '"]') : [];
    for (var i = 0; i < radios.length; i++) if (radios[i].checked) return String(radios[i].value || '');
    return '';
  }
  function restoreChecked(name, value) {
    if (!value || !document.querySelectorAll) return;
    var radios = document.querySelectorAll('input[name="' + name + '"]');
    for (var i = 0; i < radios.length; i++) {
      if (String(radios[i].value || '') !== value) continue;
      radios[i].checked = true;
      radios[i].dispatchEvent(new Event('change', { bubbles: true }));
      return;
    }
  }
  function rememberCheckout() {
    var data = { at: Date.now() };
    var found = false;
    FORM_FIELDS.forEach(function (id) {
      var el = document.getElementById(id);
      if (!el) return;
      found = true;
      data[id] = cleanText(el.value, FORM_LIMITS[id] || 400);
    });
    FORM_RADIOS.forEach(function (name) { data[name] = checkedValue(name); });
    data['co-pickup-code'] = typeof pickup !== 'undefined' && pickup
      ? cleanText(pickup.code || pickup.restoredCode, 32) : '';
    // После успешного оформления разметка формы уже снята. Не затираем в этот
    // момент сохранённые поля одной пустой отметкой времени.
    if (!found) return;
    try { localStorage.setItem(FORM_KEY, JSON.stringify(data)); } catch (e) {}
  }
  function initCheckoutMemory() {
    var raw = null;
    var saved = null;
    try { raw = localStorage.getItem(FORM_KEY); } catch (e) {}
    if (raw !== null) {
      try { saved = JSON.parse(raw); } catch (e) {}
    }
    var now = Date.now();
    var at = saved && typeof saved.at === 'number' ? saved.at : NaN;
    var age = now - at;
    var fieldsValid = !!saved && FORM_FIELDS.every(function (id) {
      return saved[id] === undefined || typeof saved[id] === 'string';
    });
    var choicesValid = !!saved && FORM_RADIOS.concat(['co-pickup-code']).every(function (name) {
      return saved[name] === undefined || typeof saved[name] === 'string';
    });
    var fresh = !!saved && typeof saved === 'object' && !Array.isArray(saved)
      && fieldsValid && choicesValid && isFinite(at) && at > 0 && age >= 0 && age < FORM_TTL;
    // Битая, просроченная или датированная будущим запись не должна оставлять
    // имя, телефон и адрес в браузере навсегда.
    if (raw !== null && !fresh) {
      try { localStorage.removeItem(FORM_KEY); } catch (e) {}
    }
    if (fresh) {
      FORM_FIELDS.forEach(function (id) {
        var el = document.getElementById(id);
        // JSON с объектом/массивом вместо строки — битая запись, а не имя
        // «[object Object]». Не восстанавливаем и минимизируем каждое поле до
        // того же maxlength, который видит покупатель.
        var value = typeof saved[id] === 'string'
          ? cleanText(saved[id], FORM_LIMITS[id] || 400) : '';
        // Уже набранное не трогаем: своё всегда важнее запомненного.
        if (!el || !value || el.value) return;
        el.value = value;
        el.dispatchEvent(new Event('change', { bubbles: true }));
      });
      // Перевозчик и вариант доставки восстанавливаются после адреса: его
      // `change` запускает серверный расчёт цены, а выбранные радио уже будут на
      // месте к моменту ответа. Значения ищем перебором, не вставляя строку из
      // localStorage в CSS-селектор.
      FORM_RADIOS.forEach(function (name) {
        restoreChecked(name, cleanText(saved[name], 40));
      });
      // Код пункта считается лишь предпочтением: список придёт с сервера и
      // renderPoints оставит выбор только если такой пункт всё ещё существует.
      var pickupCode = cleanText(saved['co-pickup-code'], 32);
      if (typeof pickup !== 'undefined' && pickup && /^[A-Za-z0-9_-]{1,32}$/.test(pickupCode)) {
        // Это лишь кандидат. Настоящим выбором он станет после совпадения с
        // актуальным ответом /api/delivery/points.
        pickup.restoredCode = pickupCode;
      }
    }
    // На `change`, то есть при уходе из поля, а не на каждую букву: запись в
    // localStorage синхронная, и делать её на каждый набранный символ адреса
    // незачем. Перед отправкой и уходом со страницы сохраняем ещё раз: активное
    // поле и автозаполнение браузера могли не успеть дать `change`.
    FORM_FIELDS.forEach(function (id) {
      var el = document.getElementById(id);
      if (el) el.addEventListener('change', rememberCheckout);
    });
    window.addEventListener('pagehide', rememberCheckout);
    // События восстановления выше могли разбудить обработчики доставки до
    // подстановки пункта. Финальный снимок собирает уже целое состояние.
    if (fresh) rememberCheckout();
  }

  function initAddressQuote() {
    var input = document.getElementById('co-address');
    if (!input) return;
    // Правка руками отменяет и выбранный пункт, и координаты подсказки: адрес
    // стал другим, и относиться к прежнему дому они больше не могут.
    input.addEventListener('input', function () { dropPickup(); setGeo(null, null); quoteDelivery(); });
    input.addEventListener('change', function () { quoteDelivery(0); });
    input.addEventListener('blur', function () { quoteDelivery(0); });
  }

  /* Телефон: код страны, флаг и форматирование по ходу набора. Всё это живёт в
   * `public/phone.js` — ОДНОМ файле на витрину и сервер: своя таблица кодов в
   * скрипте разъехалась бы с серверной, и форма приняла бы номер, который
   * `/api/order` потом отверг (то же правило, что у способов доставки).
   *
   * Файл не загрузился — поле остаётся обычным вводом: разметку скрипт не
   * создаёт, а номер всё равно проверит и приведёт к общему виду сервер.
   */
  function initPhoneInput() {
    if (window.Phone) window.Phone.attach(document.getElementById('co-phone'));
  }
  function phoneValue() {
    var input = document.getElementById('co-phone');
    return input ? input.value.trim() : '';
  }
  // Проверка та же, что на сервере, и текст отказа тот же — просто без ожидания
  // ответа. Без загруженного модуля остаётся одно требование: поле не пустое.
  function phoneCheck() {
    var value = phoneValue();
    if (window.Phone) return window.Phone.check(value);
    return value ? { ok: true } : { ok: false, error: 'Укажите номер телефона' };
  }

  // Правая панель: только деньги. Перерисовывается целиком — она короткая, а
  // возиться с отдельными id ради трёх строк смысла нет.
  function renderRail() {
    var side = document.getElementById('checkout-side');
    if (!side || !Cart.items.length) return;
    // Именно availableCount: сумма считается без распроданных позиций, и рядом с
    // ней должно стоять то же число. С общим count строка читалась как «три товара
    // за 67 990», хотя в цену вошёл один.
    var count = Cart.availableCount();
    var sum = money(Cart.total());
    // Цена доставки известна только по адресу: до него в строке стоит сам
    // способ, а не «0 ₽» — обещать бесплатную доставку мы не можем.
    var price = shipCurrent();
    var way = [deliveryName(), deliveryModeName().toLowerCase()].filter(Boolean).join(', ');
    /* Выгода — отдельной строкой между товарами и доставкой, и розовой, как
     * процент и цена со скидкой на карточке. Это единственная строка сводки,
     * которая говорит не «сколько платить», а «сколько не платить», поэтому она
     * и выделена цветом; строки без скидки в заказе просто нет.
     *
     * Когда скидка есть, «Товары» показывают сумму ДО неё — иначе столбик не
     * сходится: покупатель вычитает скидку из суммы товаров и не получает итог.
     * Без скидки строка одна и показывает то же, что и раньше.
     */
    var saved = Cart.saved();
    var goods = saved > 0 ? money(Cart.total() + saved) : sum;
    side.innerHTML = '<div class="co-line"><span>Товары (' + count + ')</span><span>' + goods + '</span></div>'
      + (saved > 0 ? '<div class="co-line co-line-save"><span>Скидка</span><span>−' + money(saved) + '</span></div>' : '')
      + '<div class="co-line"><span>Доставка</span><span>'
      + (price == null ? '<i class="co-line-wait">по адресу</i>' : money(price)) + '</span></div>'
      + (way ? '<div class="co-line co-line-muted"><span>' + escapeHtml(way)
        + (price != null && ship.zoneName ? ' · ' + escapeHtml(ship.zoneName) : '') + '</span><span></span></div>' : '')
      + '<div class="co-total"><span>Итого</span><b>' + money(orderTotal()) + '</b></div>';
  }

  // ===== Оплата и доставка =====
  // Включена ли онлайн-оплата, витрина узнаёт единственным атрибутом от сервера:
  // ключи кассы остаются на сервере, как и ключ подсказок адреса.
  // Выбора «оплатить позже» нет: заказ оформляется с оплатой сразу. Прежний путь
  // «заявка, менеджер свяжется» остаётся только когда оплата вообще не настроена —
  // иначе кнопка вела бы в платёжку, которой нет.
  function payOnline() {
    var page = document.getElementById('checkout-page');
    return !!(page && page.dataset && page.dataset.pay);
  }
  function submitLabel() { return payOnline() ? 'Перейти к оплате' : 'Оформить заказ'; }
  // Под кнопкой — одна короткая строка и ссылка на политику второй строкой.
  // Прежнее объяснение про номер карты занимало три строки и читалось как
  // оправдание: покупателю на этом шаге важно только, чем он платит.
  function payNote() {
    return payOnline() ? 'Оплата переводом по реквизитам' : 'Оплата не онлайн: менеджер свяжется с вами';
  }

  // Текст отказа по сумме заказа или пустая строка. Заказ вне пределов не
  // оформляется вовсе: кнопка гаснет, а сервер такую сумму всё равно не примет.
  function totalLimitError(sum) {
    if (ORDER_MAX && sum > ORDER_MAX) return 'Один заказ — не более ' + money(ORDER_MAX) + '. Разделите покупку на несколько заказов.';
    if (ORDER_MIN && sum > 0 && sum < ORDER_MIN) return 'Минимальная сумма заказа — ' + money(ORDER_MIN) + '.';
    return '';
  }

  // Способы доставки приходят от сервера тем же списком, по которому он потом
  // проверяет заказ, — свой в скрипте разъехался бы с серверным.
  function deliveryMethods() {
    var page = document.getElementById('checkout-page');
    if (!page || !page.dataset || !page.dataset.delivery) return [];
    try { var list = JSON.parse(page.dataset.delivery); return Array.isArray(list) ? list : []; }
    catch (e) { return []; }
  }
  function deliveryChoice() {
    var on = document.querySelector('input[name="co-delivery"]:checked');
    return on ? on.value : '';
  }
  function deliveryMethod(id) {
    var list = deliveryMethods();
    for (var i = 0; i < list.length; i++) if (list[i].id === (id || deliveryChoice())) return list[i];
    return null;
  }
  function deliveryName() {
    var m = deliveryMethod();
    return m ? m.name : 'выберите способ';
  }
  // Куда именно: в пункт выдачи или курьером. Варианты приходят от сервера
  // вместе со способом — свои в скрипте разъехались бы с серверными так же,
  // как разъехался бы свой список перевозчиков.
  function deliveryModes(id) {
    var m = deliveryMethod(id);
    return (m && m.modes) || [];
  }
  function deliveryModeChoice() {
    var on = document.querySelector('input[name="co-delivery-mode"]:checked');
    return on ? on.value : '';
  }
  function deliveryModeName() {
    var list = deliveryModes(), id = deliveryModeChoice();
    for (var i = 0; i < list.length; i++) if (list[i].id === id) return list[i].name;
    return '';
  }
  /* Подсказка под адресом. Чего не хватает, говорит СЕРВЕР (см. quoteDelivery):
   * своя проверка в скрипте пропускала бы адрес, который сервер потом отвергает.
   *
   * Про перевозчиков здесь больше ничего нет: поле стало адресом самого
   * покупателя, и пункт выдачи в него не вписывают. Зато сказано, зачем адрес
   * нужен тому, кто собирается забрать заказ сам.
   */
  function addressNote() {
    if (addressValue() && ship.address === addressValue() && !ship.valid && ship.error) return ship.error;
    return 'По нему считаем доставку и подбираем ближайшие пункты выдачи.'
      + ' Например: г Екатеринбург, ул Малышева, д 5.';
  }
  // Ошибку показываем не красным полем, а подписью: адрес дописывают на ходу, и
  // алый текст под каждой второй буквой читался бы как поломка формы.
  function syncAddressNote() {
    var note = document.getElementById('co-address-note');
    if (!note) return;
    var bad = !!(addressValue() && ship.address === addressValue() && !ship.valid);
    note.textContent = addressNote();
    note.className = bad ? 'field-note field-note-warn' : 'field-note';
  }
  function deliveryChoiceHtml() {
    var list = deliveryMethods();
    if (!list.length) return '';
    // Первый способ выбран заранее: пустой выбор заставлял бы покупателя ткнуть
    // лишний раз, а строка «Доставка» в итогах висела бы без значения.
    return '<div class="co-choice" role="radiogroup" aria-label="Способ доставки">'
      + list.map(function (m, i) {
        // Логотип берётся из спрайта, вставленного сервером в страницу: ссылка
        // <use> вместо копии разметки, чётко на любом экране и без запросов.
        // Логотипа нет — остаётся название текстом, и раскладка не меняется.
        // Логотип помечен aria-hidden, а название лежит рядом скрытым текстом:
        // aria-label на инлайновом SVG читалки поддерживают через раз, а имя
        // перевозчика — единственное, что отличает варианты друг от друга.
        var mark = m.logoBox
          ? '<svg class="co-choice-logo" viewBox="' + escapeHtml(m.logoBox) + '" aria-hidden="true">'
            + '<use href="#dl-' + escapeHtml(m.id) + '"></use></svg>'
            + '<span class="sr-only">' + escapeHtml(m.name) + '</span>'
          : '<b>' + escapeHtml(m.name) + '</b>';
        return '<label class="co-choice-opt"><input type="radio" name="co-delivery" value="'
          + escapeHtml(m.id) + '"' + (i === 0 ? ' checked' : '') + '>'
          + '<span class="co-choice-text"><span class="co-choice-mark">' + mark + '</span>'
          + (m.hint ? '<i>' + escapeHtml(m.hint) + '</i>' : '') + '</span></label>';
      }).join('')
      + '</div>';
  }
  // Варианты выбранного перевозчика с ценами. Цена стоит у каждого варианта, а
  // не только у выбранного: «курьером» покупатель выбирает, зная, во что это
  // обойдётся, а не узнав об этом в итоге.
  function deliveryModesHtml() {
    var list = deliveryModes();
    if (!list.length) return '';
    var picked = deliveryModeChoice();
    // Прежний выбор переносится на нового перевозчика: варианты у них одни и те
    // же, и сбрасывать курьера на ПВЗ при смене СДЭК на OZON незачем.
    var has = false;
    for (var j = 0; j < list.length; j++) if (list[j].id === picked) has = true;
    if (!has) picked = list[0].id;
    // Подпись обязательна: без неё на телефоне перевозчики и варианты встают в
    // один столбик из четырёх одинаковых карточек и читаются как один список.
    return '<span class="co-modes-label">Куда доставить</span>'
      + '<div class="co-modes-row" role="radiogroup" aria-label="Куда доставить">'
      + list.map(function (m) {
        // Цена вариантa приходит с сервера; пока адреса нет — считать нечего, и
        // вместо цифры стоит прочерк, а не «0 ₽».
        var price = shipPrice(deliveryChoice(), m.id);
        return '<label class="co-mode"><input type="radio" name="co-delivery-mode" value="' + escapeHtml(m.id) + '"'
          + (m.id === picked ? ' checked' : '') + '>'
          + '<span class="co-mode-text"><b>' + escapeHtml(m.name) + '</b>'
          + (m.hint ? '<i>' + escapeHtml(m.hint) + '</i>' : '') + '</span>'
          + '<span class="co-mode-price">' + (price == null ? '—' : money(price)) + '</span></label>';
      }).join('')
      + '</div>';
  }
  function renderModes() {
    var box = document.getElementById('co-modes');
    if (!box) return;
    box.innerHTML = deliveryModesHtml();
  }
  /* Выбор способа заперт, пока адрес не полон. Способы никуда не деваются —
   * покупатель видит, чем повезут, — но выбирать их до адреса не из чего: цена
   * зависит от региона, и у карточек стоял бы прочерк вместо суммы.
   * Радио именно `disabled`, а не спрятаны: выбранными они остаются, поэтому
   * после разблокировки не надо ничего доставать заново.
   */
  function setWaysLocked(locked) {
    var box = document.getElementById('co-ways');
    if (!box) return;
    box.classList.toggle('is-locked', !!locked);
    var inputs = box.querySelectorAll('input[type="radio"]');
    for (var i = 0; i < inputs.length; i++) inputs[i].disabled = !!locked;
    var note = document.getElementById('co-ways-note');
    if (note) note.hidden = !locked;
  }
  // Название перевозчика живёт в правой сводке, подсказка — под адресом, а
  // варианты доставки зависят от выбранного перевозчика, поэтому обновляем всё.
  function syncDelivery() {
    renderModes();
    setWaysLocked(!ship.valid);
    renderRail();
    syncSubmit();
    syncAddressNote();
    loadPoints();
  }
  function initDeliveryChoice() {
    var box = document.querySelector('.co-choice');
    if (!box) return;
    // Сразу, а не только на change: при сборке разметки радио в DOM ещё нет, и
    // строка «Доставка» в итогах показывала «выберите способ» при уже выбранном
    // первом способе.
    syncDelivery();
    // Пункты выдачи у перевозчиков свои, поэтому смена перевозчика — это и новый
    // список: syncDelivery перезапросит его сам.
    box.addEventListener('change', function () { dropPickup(); syncDelivery(); rememberCheckout(); });
    var modes = document.getElementById('co-modes');
    // Смена варианта перевозчика не меняет список вариантов — перерисовывать их
    // не нужно, достаточно обновить сумму и подсказку под адресом. А вот выбор
    // пункта нужен только у «в пункт выдачи»: у курьера посылка едет по адресу
    // покупателя, и трогать этот адрес больше некому.
    if (modes) modes.addEventListener('change', function () {
      renderRail(); syncSubmit(); syncAddressNote(); loadPoints(); rememberCheckout();
    });
    initPointsChoice();
  }

  /* ===== Пункт выдачи =====
   * Адрес покупателя введён, выбран вариант «в пункт выдачи» — здесь выбирается
   * сам пункт. Адрес покупателя при этом НЕ МЕНЯЕТСЯ: это его данные, а пункт —
   * то, куда поедет посылка. В заказ уходят оба, и код пункта отдельно: по коду
   * менеджер оформляет накладную.
   *
   * Список считает СЕРВЕР по своей базе (lib/pickup.js) — наружу при этом не
   * уходит ни одного запроса, как и при расчёте цены доставки. Витрина ничего
   * про пункты не решает: ни расстояний, ни сортировки здесь нет.
   *
   * У любого исхода есть выход. Рядом пусто, базы этого перевозчика у нас нет
   * или сеть подвела — покупатель выбирает курьера либо повторяет загрузку после
   * смены адреса/перевозчика. Непроверенный код пункта в заказ не пропускаем.
   */
  var pickup = {
    key: '', wanted: '', retriedKey: '', items: [], ready: false, done: false, pending: false,
    requestSeq: 0, code: '', restoredCode: '', open: true, geo: null
  };

  // Координаты дома приходят от подсказки dadata.ru — своего геокодера у витрины
  // нет и не нужно. Правка поля руками их обесценивает: адрес уже другой.
  function setGeo(lat, lon) {
    pickup.geo = (typeof lat === 'number' && typeof lon === 'number') ? { lat: lat, lon: lon } : null;
  }
  // Выбранный пункт снимается вместе со сменой адреса или перевозчика: пункт в
  // прежнем городе или чужой сети — это не выбор покупателя, а мусор.
  function dropPickup() {
    pickup.code = '';
    pickup.restoredCode = '';
    // Выбирать снова — значит снова показать из чего: свёрнутый пустой список
    // выглядел бы как уже сделанный выбор.
    pickup.open = true;
  }

  function pointsBox() { return document.getElementById('co-points'); }
  // Пункт нужен только выбравшему «в пункт выдачи» и только по разобранному
  // адресу: до него сервер всё равно ничего не найдёт.
  function pointsWanted() { return !!deliveryChoice() && deliveryModeChoice() === 'pvz' && ship.valid; }

  function loadPoints() {
    var box = pointsBox();
    if (!box) return;
    if (!pointsWanted()) { box.hidden = true; return; }
    var key = deliveryChoice() + '|' + addressValue()
      + '|' + (pickup.geo ? pickup.geo.lat + ',' + pickup.geo.lon : '');
    if (key === pickup.key) { renderPoints(); return; }
    if (pickup.pending && pickup.wanted === key) return;
    pickup.wanted = key; pickup.pending = true;
    var requestSeq = ++pickup.requestSeq;
    var body = { method: deliveryChoice(), address: addressValue() };
    if (pickup.geo) { body.lat = pickup.geo.lat; body.lon = pickup.geo.lon; }
    fetch('/api/delivery/points', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
    })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        // Ни успех, ни ошибка старого A не вправе менять состояние более нового
        // запроса B. Проверяем адресность ДО pending/items и отрисовки.
        if (pickup.requestSeq !== requestSeq || pickup.wanted !== key) return;
        pickup.pending = false;
        if (!d || !d.ok) {
          pickup.done = true; pickup.items = [];
          renderPoints();
          return;
        }
        pickup.key = key; pickup.items = d.items || []; pickup.ready = !!d.ready; pickup.done = true;
        // Восстановленный код считается выбранным только после подтверждения
        // актуальным списком. Удалённый ПВЗ очищаем и из памяти формы.
        if (pickup.restoredCode) {
          var restored = pickup.items.some(function (item) { return item.code === pickup.restoredCode; });
          pickup.code = restored ? pickup.restoredCode : '';
          pickup.open = !restored;
          pickup.restoredCode = '';
          rememberCheckout();
        } else if (pickup.code && !pickup.items.some(function (item) { return item.code === pickup.code; })) {
          pickup.code = '';
          pickup.open = true;
          rememberCheckout();
        }
        renderPoints();
        /* У OZON точки подтягиваются из OpenStreetMap в фоне, и сервер сказал,
         * что список сейчас обновляется. Переспрашиваем один раз: ждать ответа
         * чужого сервиса покупатель не должен, а через несколько секунд список
         * обычно уже на месте. Один раз — потому что пустой список бывает и
         * честным, и опрашивать по кругу незачем.
         */
        if (d.refreshing && pickup.retriedKey !== key) {
          pickup.retriedKey = key;
          setTimeout(function () { pickup.key = ''; loadPoints(); }, 6000);
        }
      })
      .catch(function () {
        // Сеть подвела — непроверенный ПВЗ выбранным не считаем. Покупатель
        // сможет выбрать курьера либо повторить загрузку сменой адреса/способа.
        if (pickup.requestSeq !== requestSeq || pickup.wanted !== key) return;
        pickup.pending = false; pickup.done = true; pickup.items = [];
        renderPoints();
      });
  }

  // Расстояние словами. Метры до километра — «420 м» понятнее, чем «0,42 км».
  function pointDistance(km) {
    if (km == null) return '';
    if (km < 1) return Math.round(km * 1000) + ' м';
    return (Math.round(km * 10) / 10).toLocaleString('ru-RU') + ' км';
  }

  /* Значки блока. Холст 24×24 и волосяная обводка — тот же вес штриха, что у
   * глифов характеристик и блока доверия, поэтому в одной странице они не спорят.
   * Витрина и постамат различаются рисунком: у первого навес и дверь, у второго
   * шкаф с ячейками. Это главное, что покупателю надо увидеть с одного взгляда —
   * в постамате никто не поможет и не даст примерить.
   */
  var PVZ_ICONS = {
    pvz: '<path d="M3.6 9.2 5.2 4.4h13.6l1.6 4.8M4.9 9.2v10.4h14.2V9.2M9.7 19.6v-5.4h4.6v5.4"/>',
    postamat: '<path d="M5.6 3.8h12.8v16.4H5.6zM5.6 9.6h12.8M5.6 15.2h12.8M15.4 6.4v.6M15.4 12.2v.6M15.4 17.8v.6"/>',
    pin: '<path d="M12 21.2s6.6-6.1 6.6-10.6a6.6 6.6 0 0 0-13.2 0C5.4 15.1 12 21.2 12 21.2zM12 13a2.6 2.6 0 1 0 0-5.2 2.6 2.6 0 0 0 0 5.2z"/>',
    chevron: '<path d="M7.2 10.2 12 15l4.8-4.8"/>',
    check: '<path d="m5.4 12.6 4.4 4.4 8.8-9.6"/>'
  };
  function pvzIcon(name, cls) {
    var d = PVZ_ICONS[name];
    if (!d) return '';
    return '<svg class="' + cls + '" viewBox="0 0 24 24" fill="none" stroke="currentColor"'
      + ' stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + d + '</svg>';
  }

  /* Блок — это ТОЛЬКО выбор пункта, и устроен он как выпадающий список: пока
   * пункт не выбран, список раскрыт (выбирать всё равно придётся), после выбора
   * схлопывается в одну строку с выбранным пунктом, а нажатие на неё открывает
   * список снова.
   *
   * Так шаг «Доставка» не растягивается на пять адресов после того, как выбор уже
   * сделан: на последнем шаге перед оплатой важно видеть кнопку, а не перечень,
   * из которого уже выбрали. И при этом видно, ЧТО именно выбрано, — свёрнутая
   * строка показывает адрес, часы и расстояние.
   *
   * Разметка — `listbox`, как у подсказок адреса в этой же форме: у выпадающего
   * списка это правильная роль, и с клавиатуры он ведёт себя ожидаемо.
   */
  function renderPoints() {
    var box = pointsBox();
    if (!box) return;
    if (!pointsWanted()) { box.hidden = true; return; }
    box.hidden = false;
    if (!pickup.done) { box.innerHTML = ''; return; }
    if (!pickup.items.length) {
      box.innerHTML = '<span class="co-modes-label">Пункт выдачи</span>'
        + '<p class="co-points-note">Рядом с вашим адресом пунктов не нашлось —'
        + ' выберите доставку курьером.</p>';
      syncSubmit();
      return;
    }
    var picked = null;
    for (var i = 0; i < pickup.items.length; i++) if (pickup.items[i].code === pickup.code) picked = pickup.items[i];
    // Сохранённый пункт мог закрыться или выпасть из списка перевозчика. Не
    // оставляем невидимый старый код, который потом ушёл бы в заказ.
    if (pickup.code && !picked) { pickup.code = ''; pickup.open = true; rememberCheckout(); }
    // Пока не выбрано — список открыт: закрытый требовал бы лишнего нажатия там,
    // где выбор обязателен.
    var open = picked ? pickup.open : true;
    var count = pickup.items.length;

    box.innerHTML = '<span class="co-modes-label">Пункт выдачи</span>'
      + '<div class="co-pvz' + (open ? ' is-open' : '') + (picked ? ' is-picked' : '') + '">'
      + '<button type="button" class="co-pvz-head" id="co-pvz-head" aria-expanded="' + (open ? 'true' : 'false')
      + '" aria-controls="co-pvz-list">'
      + '<span class="co-pvz-ico">' + pvzIcon(picked ? (picked.postamat ? 'postamat' : 'pvz') : 'pin', 'co-ico') + '</span>'
      + '<span class="co-pvz-text">'
      + (picked
        ? '<b>' + escapeHtml(picked.title)
          + (picked.postamat ? '<span class="co-point-kind">постамат</span>' : '') + '</b>'
          + '<i>' + [picked.hours, pointDistance(picked.km)].filter(Boolean).map(escapeHtml).join(' · ') + '</i>'
        : '<b>Выберите пункт выдачи</b><i>' + count + ' ' + plural(count, 'пункт', 'пункта', 'пунктов')
          + ' рядом с вашим адресом</i>')
      + '</span>'
      + (picked ? '<span class="co-pvz-change">Изменить</span>' : '')
      + pvzIcon('chevron', 'co-pvz-chev')
      + '</button>'
      + '<div class="co-pvz-drop" id="co-pvz-list" role="listbox" aria-label="Пункты выдачи">'
      + '<div class="co-pvz-inner">'
      + pickup.items.map(function (p) {
        var km = pointDistance(p.km);
        var on = p.code === pickup.code;
        return '<button type="button" class="co-point' + (on ? ' is-picked' : '') + '" role="option"'
          + ' aria-selected="' + (on ? 'true' : 'false') + '" data-code="' + escapeHtml(p.code) + '">'
          + '<span class="co-point-ico">' + pvzIcon(p.postamat ? 'postamat' : 'pvz', 'co-ico') + '</span>'
          + '<span class="co-point-text"><b>' + escapeHtml(p.title)
          + (p.postamat ? '<span class="co-point-kind">постамат</span>' : '') + '</b>'
          + (p.hours ? '<i>' + escapeHtml(p.hours) + '</i>' : '') + '</span>'
          + (km ? '<span class="co-point-km">' + escapeHtml(km) + '</span>' : '')
          + '<span class="co-point-check">' + pvzIcon('check', 'co-ico') + '</span>'
          + '</button>';
      }).join('')
      + '</div></div></div>';
    syncDropHeight();
    syncSubmit();
  }

  /* Высота раскрытого списка МЕРЯЕТСЯ, а не задаётся числом в CSS. Числом её
   * задать нельзя: на узком экране адрес переносится на две строки, и пятый
   * пункт уезжал за границу — список выглядел обрезанным. Заодно так плавность
   * не зависит от длины списка: он всегда едет ровно на свою высоту.
   */
  function syncDropHeight() {
    var drop = document.getElementById('co-pvz-list');
    if (!drop) return;
    var open = drop.parentNode && drop.parentNode.classList.contains('is-open');
    drop.style.maxHeight = open ? drop.scrollHeight + 'px' : '';
  }

  // Раскрыть список — так делает и кнопка оформления, когда пункт не выбран:
  // сказать «выберите пункт» и оставить список закрытым было бы издевательством.
  function openPoints() {
    pickup.open = true;
    renderPoints();
    var box = pointsBox();
    if (box && box.scrollIntoView) box.scrollIntoView({ block: 'center' });
  }

  /* Выбор пункта не трогает адрес покупателя и не двигает цену: зона считается
   * по его адресу, а пункт дальше 60 км мы и не предлагаем.
   *
   * Слушаем сам блок, а не строки: список перерисовывается на каждый выбор и на
   * каждый ответ сервера, и обработчики на строках пришлось бы вешать заново.
   */
  function initPointsChoice() {
    var box = pointsBox();
    if (!box) return;
    box.addEventListener('click', function (e) {
      var head = e.target.closest && e.target.closest('#co-pvz-head');
      if (head) { pickup.open = !pickup.open; renderPoints(); return; }
      var row = e.target.closest && e.target.closest('.co-point[data-code]');
      if (!row) return;
      pickup.code = row.getAttribute('data-code');
      pickup.restoredCode = '';
      // Выбор сделан — список сворачивается: дальше на экране нужна кнопка, а
      // не перечень, из которого уже выбрали.
      pickup.open = false;
      renderPoints();
      rememberCheckout();
    });
    // Поворот телефона меняет перенос адреса, а с ним и высоту списка. Меряем
    // заново — иначе после поворота он остался бы обрезанным.
    window.addEventListener('resize', syncDropHeight);
    // Esc закрывает открытый список — привычка, оставшаяся от любого выпадающего
    // списка. Работает только когда есть что показать в свёрнутом виде.
    box.addEventListener('keydown', function (e) {
      if (e.key !== 'Escape' || !pickup.open || !pickup.code) return;
      pickup.open = false;
      renderPoints();
      var head = document.getElementById('co-pvz-head');
      if (head) head.focus();
    });
  }

  /* ===== Адрес и стоимость доставки =====
   * И то и другое считает сервер (`/api/delivery/quote`) — тем же модулем,
   * которым потом считает заказ. Ни сетки тарифов, ни правил разбора адреса у
   * витрины нет и быть не может: цифра в сводке обязана совпадать с той, что
   * уйдёт в заказ, а адрес, прошедший проверку здесь, — приниматься там.
   *
   * Ответ несёт цены сразу всех способов и вариантов по этому адресу, поэтому
   * переключение перевозчика или «курьером/в пункт выдачи» не ходит на сервер —
   * запрос нужен только когда изменился адрес или состав корзины.
   *
   * `address` — строка, к которой относится ответ. По ней видно, что разбор не
   * устарел: показывать «не хватает дома» про адрес, который покупатель уже
   * дописал, нельзя.
   */
  var ship = { key: '', address: '', valid: false, error: '', prices: null, zoneName: '', pending: false, timer: null };

  function shipPrice(method, mode) {
    if (!ship.prices || !method || !mode) return null;
    var byMode = ship.prices[method];
    var price = byMode && byMode[mode];
    return typeof price === 'number' ? price : null;
  }
  // Цена выбранной доставки или null, пока адрес не введён и считать нечего.
  function shipCurrent() { return shipPrice(deliveryChoice(), deliveryModeChoice()); }
  // Итог заказа: товары плюс доставка. Именно по нему проверяется потолок одной
  // покупки и он же стоит на кнопке — платить покупатель будет эту сумму.
  function orderTotal() {
    var price = shipCurrent();
    return Cart.total() + (price == null ? 0 : price);
  }

  function addressValue() {
    var input = document.getElementById('co-address');
    return input ? input.value.trim() : '';
  }
  // Запрос идёт с задержкой: адрес набирают по букве, а цена меняется только с
  // регионом. Повтор того же запроса не отправляется — ключом служит сам адрес
  // вместе с суммой товаров (от неё зависит подгонка итога под круглое число).
  function quoteDelivery(delay) {
    var address = addressValue();
    var key = Cart.total() + '|' + address;
    if (!address) {
      ship.key = ''; ship.address = ''; ship.valid = false; ship.error = '';
      ship.prices = null; ship.zoneName = '';
      syncDelivery();
      return;
    }
    if (key === ship.key || ship.pending && ship.wanted === key) return;
    clearTimeout(ship.timer);
    ship.wanted = key;
    ship.timer = setTimeout(function () {
      ship.pending = true;
      fetch('/api/delivery/quote', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ address: address, total: Cart.total() })
      })
        .then(function (r) { return r.json(); })
        .then(function (d) {
          ship.pending = false;
          if (!d || !d.ok || ship.wanted !== key) return;   // ответ устарел
          ship.key = key; ship.address = address;
          ship.valid = !!d.valid; ship.error = d.error || '';
          ship.prices = d.prices || null; ship.zoneName = d.zoneName || '';
          syncDelivery();
        })
        .catch(function () {
          // Сеть подвела — ни цену, ни разбор адреса не выдумываем: выбор
          // способа останется запертым, а решать всё равно серверу при заказе.
          ship.pending = false;
        });
    }, delay == null ? 350 : delay);
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
      // Координаты дома приходят вместе с подсказкой — по ним ищутся ближайшие
      // пункты выдачи. У неточной подсказки (город целиком) их нет вовсе, и
      // поиск уйдёт по названию города.
      dropPickup();
      setGeo(s.lat, s.lon);
      // Выбор из списка не даёт события ввода, а адрес изменился — цену
      // доставки пересчитываем сразу, без задержки.
      quoteDelivery(0);
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

  /* ===== Напоминание о неоплаченном счёте =====
   * Полосу под шапкой рисует сервер (`payRemindBar` в lib/render.js) — только он
   * знает, что счёт ещё живой, и только он отличает свой заказ от чужого.
   * Скрипт делает две вещи: дописывает обратный отсчёт и повторяет напоминание
   * в корзине — туда покупатель заглядывает первым делом, а товаров там уже нет,
   * они уехали в заказ.
   */
  function payRemindBox() { return document.getElementById('pay-remind'); }
  function payRemindLeft() {
    var box = payRemindBox();
    var until = box ? Number(box.dataset.until) : 0;
    return until ? until - Date.now() : 0;
  }
  /* Сгорело ли напоминание. Ноль в `data-until` — это НЕ «время вышло», а «срока
   * нет»: так приходит заказ, счёт по которому не выставился или уже сгорел, —
   * платить по нему по-прежнему надо, просто отсчитывать нечего. Пока это
   * различали одним `payRemindLeft() <= 0`, полоса без срока исчезала сразу
   * после загрузки страницы. */
  function payRemindDead() {
    var box = payRemindBox();
    var until = box ? Number(box.dataset.until) : 0;
    return !!until && until - Date.now() <= 0;
  }
  // Сколько осталось словами. Секунды не показываем: тикающие «14:59» на каждой
  // странице отвлекают сильнее, чем помогают, а точность тут ни на что не влияет.
  function payRemindMin() {
    var ms = payRemindLeft();
    if (ms <= 0) return '';
    var min = Math.floor(ms / 60000);
    return min < 1 ? 'меньше минуты' : min + ' ' + plural(min, 'минуту', 'минуты', 'минут');
  }
  // Карточка в корзине. Пусто, когда напоминать не о чем, — вызывающий просто
  // подставляет её первой строкой.
  function payRemindCard() {
    var box = payRemindBox();
    if (!box || payRemindDead()) return '';
    var left = payRemindMin();
    return '<a class="cart-remind" href="' + escapeHtml(box.dataset.href || '#') + '">'
      + '<span class="cart-remind-top">Заказ ' + escapeHtml(box.dataset.no || '') + ' ждёт оплаты</span>'
      + '<span class="cart-remind-sum">' + escapeHtml(box.dataset.sum || '') + '</span>'
      + (left ? '<span class="cart-remind-left">реквизиты действительны ещё ' + escapeHtml(left) + '</span>' : '')
      + '<span class="cart-remind-go">Продолжить оплату →</span></a>';
  }
  function syncPayRemind() {
    var box = payRemindBox();
    if (!box) return;
    // Счёт сгорел прямо на открытой странице — напоминание обязано исчезнуть:
    // реквизиты по нему уже чужие. Страницу при этом не трогаем, покупатель
    // мог быть занят чем-то другим.
    if (payRemindDead()) {
      box.remove();
      if (window.Cart && Cart.render) Cart.render();
      return;
    }
    // Меняем только само число: разметку строки держит сервер, а срок тикает.
    // Строка со сроком остаётся скрытой, когда срока нет вовсе.
    var text = payRemindMin();
    if (!text) return;
    setText('pay-remind-min', text);
    var left = document.getElementById('pay-remind-left');
    if (left) left.hidden = false;
  }
  if (payRemindBox()) {
    syncPayRemind();
    setInterval(syncPayRemind, 20000);
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
      if (!next) return false;
      var ex = this.find(itemKey(next));
      var want = next.qty;
      if (ex) {
        ex.price = next.price; ex.name = next.name; ex.img = next.img || ex.img;
        want = Math.min(99, ex.qty + next.qty);
        ex.qty = Math.min(want, this.fits(ex));
        if (ex.qty < want) toast('Больше в один заказ не помещается: не более ' + money(ORDER_MAX));
      } else if (this.items.length < MAX_CART_LINES) {
        next.qty = Math.min(next.qty, this.fits(next));
        if (next.qty < want) toast('Больше в один заказ не помещается: не более ' + money(ORDER_MAX));
        this.items.push(next);
      } else { toast('В корзине слишком много разных товаров'); return false; }
      this.save(); this.render();
      // Признак успеха нужен вызывающему: после добавления он уводит на
      // страницу корзины, а на отказе («слишком много товаров», битая позиция)
      // покупатель обязан остаться на месте и увидеть подсказку.
      return true;
    },
    setQty: function (key, qty) {
      var it = this.find(key);
      if (!it) return;
      var want = Math.max(1, Math.min(99, Math.floor(Number(qty)) || 1));
      // Тот же потолок, что и на странице товара: больше того, что помещается в
      // один заказ, набрать нельзя. Считается по остатку — от суммы уже набранных
      // позиций, а не от одной этой.
      it.qty = Math.min(want, this.fits(it));
      this.save(); this.render();
    },
    // Сколько штук этой позиции помещается в один заказ вместе с остальными.
    // Считается по ключу позиции, поэтому работает и до того, как её положили в
    // корзину, и после: сумма «всех, кроме этой» в обоих случаях одна.
    fits: function (item) {
      var price = Number(item.price) || 0;
      if (!ORDER_MAX || price <= 0 || item.available === false) return 99;
      var key = itemKey(item);
      var others = this.items.reduce(function (a, i) {
        return a + (i.available === false || itemKey(i) === key ? 0 : Number(i.price) * Number(i.qty));
      }, 0);
      return Math.max(1, Math.min(99, Math.floor((ORDER_MAX - others) / price)));
    },
    remove: function (key) { this.items = this.items.filter(function (i) { return itemKey(i) !== key; }); this.save(); this.render(); },
    clear: function () { this.items = []; this.save(); this.render(); },
    count: function () { return this.items.reduce(function (a, i) { return a + Number(i.qty); }, 0); },
    // Сервер исключает распроданные позиции из заявки. Сумма в интерфейсе должна
    // совпадать с ним, а не обещать покупателю более высокий итог.
    total: function () { return this.items.reduce(function (a, i) { return a + (i.available === false ? 0 : Number(i.price) * Number(i.qty)); }, 0); },
    availableCount: function () { return this.items.reduce(function (a, i) { return a + (i.available === false ? 0 : Number(i.qty)); }, 0); },
    /* Сколько покупатель экономит на всём заказе. Считается по тем же позициям,
     * что и сумма: у распроданной позиции цены в итоге нет, и выгоды по ней тоже
     * нет. Цена для сравнения приходит от сервера — своей витрина не держит,
     * как не держит и самой цены.
     */
    saved: function () {
      return this.items.reduce(function (a, i) {
        if (i.available === false) return a;
        var cmp = Number(i.compare) || 0, price = Number(i.price) || 0;
        return a + (cmp > price ? (cmp - price) * Number(i.qty) : 0);
      }, 0);
    },
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
        // Пустая корзина у того, кто не оплатил счёт, — это не «ничего нет», а
        // «товары уже в заказе». Про заказ и напоминаем: иначе корзина выглядит
        // так, будто выбор пропал.
        wrap.innerHTML = payRemindCard() || '<div class="cart-empty">Корзина пуста</div>';
        foot.innerHTML = '';
        return;
      }
      wrap.innerHTML = payRemindCard() + this.items.map(function (i) {
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
          + '<div class="cart-qty"><button type="button" data-act="dec" data-key="' + k + '" aria-label="Меньше">−</button><span>' + i.qty + '</span>'
          + '<button type="button" data-act="inc" data-key="' + k + '" aria-label="Больше"'
          + (i.qty >= Cart.fits(i) ? ' disabled title="Больше нельзя: один заказ — не более ' + escapeHtml(money(ORDER_MAX)) + '"' : '') + '>+</button></div>'
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

  // Номер заказа для показа: «№482913». Такой же, как orderNo() в lib/render.js —
  // покупатель видит один и тот же вид и на витрине, и на странице оплаты.
  function orderNo(number) {
    var digits = String(number == null ? '' : number).replace(/^ORD-?/i, '').trim();
    return digits ? '№' + digits : '—';
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

  // Бегущая строка преимуществ крутится анимацией CSS. Пока она за экраном,
  // считать её незачем: ставим на паузу, чтобы не будить композитор на телефоне.
  function initHeroTicker() {
    var ticker = document.querySelector('.hero-ticker');
    if (!ticker || typeof IntersectionObserver !== 'function') return;
    new IntersectionObserver(function (entries) {
      for (var i = 0; i < entries.length; i++) ticker.classList.toggle('is-idle', !entries[i].isIntersecting);
    }, { rootMargin: '100px' }).observe(ticker);
  }

  /* Медиа не отдаём «в один клик»: ни перетаскиванием, ни правой кнопкой, ни
     кнопкой скачивания в плеере. Полностью закрыть картинку от сохранения
     нельзя — она всё равно приходит в браузер, — но случайное «сохранить как»
     этим отсекается. */
  function initMediaGuard() {
    document.addEventListener('contextmenu', function (e) {
      var t = e.target;
      if (t && (t.tagName === 'IMG' || t.tagName === 'VIDEO' || (t.closest && t.closest('.rv-item, .gallery, .lb')))) {
        e.preventDefault();
      }
    });
    document.addEventListener('dragstart', function (e) {
      var t = e.target;
      if (t && (t.tagName === 'IMG' || t.tagName === 'VIDEO')) e.preventDefault();
    });
  }

  // Safari и Firefox могут вернуть /checkout из back-forward cache целиком,
  // вместе со старым JS-объектом корзины. Сначала сохраняем видимую форму,
  // затем перечитываем cart_v1 и перерисовываем страницу по актуальному
  // состоянию: после выданного invoice корзина уже могла быть очищена в другой
  // записи истории.
  window.addEventListener('pageshow', function (event) {
    if (!event.persisted) return;
    rememberCheckout();
    Cart.load();
    Cart.updateBadge();
    Cart.render();
    refreshCartFromServer();
  });

  /* Просмотрщик вложений живёт в public/media-lightbox.js: тот же просмотрщик
     нужен в панели отзывов, а витринный скрипт панель не грузит. Он сам
     подхватывает ссылки с data-kind внутри блока с data-media и слушает
     документ, поэтому вызывать его отсюда не нужно вовсе. */

  document.addEventListener('DOMContentLoaded', function () {
    Cart.load();
    Cart.updateBadge();
    if (document.getElementById('checkout-page')) Cart.render();   // страница оформления рисуется сразу
    refreshCartFromServer();                                       // подтянуть свежие фото, цены и наличие
    try {                                                          // благодарность после перезагрузки со свежим отзывом
      if (sessionStorage.getItem('review_thanks')) { sessionStorage.removeItem('review_thanks'); toast('Спасибо за отзыв!'); }
    } catch (e) {}
    startAnalytics(true);
    initAnalyticsControls();
    initCompactHeader();
    initHeroTicker();
    initMediaGuard();

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
          // Добавили — и сразу ведём в корзину, тем же путём, что и повторный
          // клик по товару, который в ней уже лежит. Раньше добавление меняло
          // только подпись кнопки и счётчик в шапке: чтобы попасть в корзину,
          // надо было нажать второй раз, а всплывающая подсказка успевала
          // погаснуть. Отказ (корзина переполнена) оставляет на месте — там
          // подсказка и есть весь ответ.
          var added = Cart.add(id, btn.dataset.name, Number(btn.dataset.price), qty, { storage: btn.dataset.storage, color: btn.dataset.color,
            band: btn.dataset.band, bandSize: btn.dataset.bandSize, options: picked, img: btn.dataset.img });
          if (added) goToCheckout();
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

    // Количество на странице товара.
    //
    // Потолок считается от АКТУАЛЬНОЙ цены выбранной сборки, а не от базовой:
    // у Mac разница между базой и старшей конфигурацией — миллион с лишним, и
    // «3 штуки» для одной сборки означает «ни одной» для другой. Поэтому
    // `refreshQtyCap()` зовётся и на каждое нажатие, и из `applyVariant()`.
    //
    // Кнопка «+» просто гаснет, как распроданный вариант: покупателю не нужно
    // объяснение про кассу, ему нужно понять, что больше нельзя. Подсказка —
    // в `title`, для тех, кто наведёт.
    var qtyBox = document.querySelector('[data-qty]');
    function qtyCap() {
      var add = document.querySelector('.add-to-cart[data-qty-source]');
      var unit = Number(add && add.dataset.price) || 0;
      if (!ORDER_MAX || unit <= 0) return 99;
      return Math.max(1, Math.min(99, Math.floor(ORDER_MAX / unit)));
    }
    function refreshQtyCap() {
      if (!qtyBox) return;
      var input = qtyBox.querySelector('.qty-input');
      var plus = qtyBox.querySelector('.qty-btn[data-delta="1"]');
      if (!input) return;
      var cap = qtyCap();
      // Сборку могли переключить на более дорогую — тогда уже набранное
      // количество опускаем до того, что помещается в один заказ.
      var v = Math.max(1, Math.min(cap, parseInt(input.value, 10) || 1));
      input.value = v;
      if (plus) {
        plus.disabled = v >= cap;
        plus.title = plus.disabled ? 'Больше нельзя: один заказ — не более ' + money(ORDER_MAX) : '';
      }
    }
    if (qtyBox) {
      qtyBox.addEventListener('click', function (e) {
        var b = e.target.closest('.qty-btn'); if (!b || b.disabled) return;
        var input = qtyBox.querySelector('.qty-input');
        var v = Math.max(1, Math.min(qtyCap(), (parseInt(input.value, 10) || 1) + parseInt(b.dataset.delta, 10)));
        input.value = v;
        refreshQtyCap();
      });
      refreshQtyCap();
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
      var discountPct = Number(addBtn.dataset.discountPct) || 0; // 0 — скидки нет, зачёркивать нечего
      var baseName = addBtn.dataset.baseName || '';
      var vstate = { color: '', storageLabel: '', storageAdd: 0, band: '', bandAdd: 0, bandSize: '', bandSizeAdd: 0,
        options: [], optionsAdd: 0 };
      // Значение, которое выводит сборку за потолок одной покупки, гасим ровно
      // как распроданное: покупателю это одно и то же, а объяснять ему устройство
      // кассы незачем. Свою пометку помним в `data-limit-out`, чтобы не «оживить»
      // вариант, которого действительно нет в наличии.
      var setLimitOut = function (btn, over) {
        if (over === !!btn.dataset.limitOut) return;
        if (over && btn.disabled) return;              // и так недоступна — не наша забота
        if (over) {
          btn.dataset.limitOut = '1';
          btn.disabled = true;
          btn.classList.add('out');
          if (!btn.classList.contains('swatch') && !btn.querySelector('.opt-note')) {
            var note = document.createElement('span');
            note.className = 'opt-note';
            note.textContent = 'нет в наличии';
            btn.appendChild(note);
          }
        } else {
          delete btn.dataset.limitOut;
          btn.disabled = false;
          btn.classList.remove('out');
          var old = btn.querySelector('.opt-note');
          if (old && old.parentNode) old.parentNode.removeChild(old);
        }
      };
      // Та же подстановка, что делает сервер при первом рендере: «убрать доплату
      // текущего значения группы, прибавить доплату кандидата». Считается от
      // актуальной цены сборки, поэтому дорогой чип гасит старшую память сам.
      var markLimits = function (total) {
        if (!ORDER_MAX) return;
        var over = function (candidate) { return candidate > ORDER_MAX; };
        document.querySelectorAll('#storages .storage-opt').forEach(function (b) {
          setLimitOut(b, over(total - vstate.storageAdd + (Number(b.dataset.add) || 0)));
        });
        document.querySelectorAll('#options .option-group').forEach(function (g) {
          var on = g.querySelector('.option-opt.active');
          var cur = Number(on && on.dataset.add) || 0;
          g.querySelectorAll('.option-opt').forEach(function (b) {
            setLimitOut(b, over(total - cur + (Number(b.dataset.add) || 0)));
          });
        });
        document.querySelectorAll('#bands .band-colors .swatch').forEach(function (b) {
          setLimitOut(b, over(total - vstate.bandAdd + (Number(b.dataset.add) || 0)));
        });
        document.querySelectorAll('#bands .band-sizes .storage-opt').forEach(function (b) {
          setLimitOut(b, over(total - vstate.bandSizeAdd + (Number(b.dataset.add) || 0)));
        });
      };
      var onCaseColorChange = null;   // задаётся блоком ремешков, если он есть
      var onStorageChange = null;     // задаётся блоком доп. характеристик, если он есть
      var pickStorage = null;         // задаётся блоком конфигураций ниже
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
        /* Зачёркнутая цена выводится из процента для ВЫБРАННОЙ сборки — тем
         * же способом, что и на сервере (`compareFor` в lib/discount.js).
         * Скидка у товара одна и в процентах, поэтому сам процент при смене
         * памяти или ремешка не меняется: меняется зачёркнутая сумма и выгода
         * в рублях. Раньше зачёркнутая цена была «база сравнения + те же
         * доплаты», и процент таял с каждой доплатой — дорогая сборка выглядела
         * менее выгодной, чем базовая.
         */
        if (discountPct > 0) {
          var cmpTotal = Math.round(total / (1 - discountPct / 100) / 10) * 10;
          var oe = document.getElementById('product-old-price');
          if (oe) oe.textContent = money(cmpTotal);
          var se = document.getElementById('product-save');
          if (se) se.textContent = '−' + discountPct + '%';
        }
        // Название храним базовым, а вариант — в отдельных полях ниже. Иначе до
        // первого ответа /api/cart оформление показывало память/цвет дважды.
        addBtn.dataset.name = baseName;
        addBtn.dataset.storage = vstate.storageLabel;
        addBtn.dataset.color = vstate.color;
        addBtn.dataset.band = vstate.band;
        addBtn.dataset.bandSize = vstate.bandSize;
        addBtn.dataset.options = JSON.stringify(vstate.options);
        // Что теперь не влезает в один заказ: сначала гасим варианты, потом
        // пересчитываем потолок количества — он считается от новой цены сборки.
        markLimits(total);
        refreshQtyCap();
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
        // quiet — выбор сделан не покупателем, а пересборкой рядов: тогда не
        // трогаем цену и не запускаем пересборку заново, иначе она зациклится.
        var pickOption = function (btn, quiet) {
          if (!btn || btn.disabled) return;
          var group = btn.closest('.option-group');
          if (!group) return;
          group.querySelectorAll('.option-opt').forEach(function (x) { x.classList.remove('active'); x.setAttribute('aria-pressed', 'false'); });
          btn.classList.add('active'); btn.setAttribute('aria-pressed', 'true');
          if (quiet) return;
          syncRows(); applyVariant();
        };
        // Что сейчас выбрано в группах, в виде {'Чип':'M5 Pro'} — по этому
        // и по выбранной конфигурации решается, какие значения показывать.
        var choiceMap = function () {
          var map = {};
          optionsEl.querySelectorAll('.option-group').forEach(function (g) {
            var on = g.querySelector('.option-opt.active');
            if (on) map[g.dataset.group] = on.dataset.label;
          });
          return map;
        };
        var fits = function (el, storage, picked) {
          var only = (el.dataset.forStorage || '').split('|').filter(Boolean);
          if (only.length && only.indexOf(storage) === -1) return false;
          var need = null;
          try { need = JSON.parse(el.dataset.forChoice || 'null'); } catch (e) { need = null; }
          if (!need) return true;
          for (var k in need) {
            if (!Object.prototype.hasOwnProperty.call(need, k)) continue;
            var allowed = need[k] || [];
            // Группа ещё не выбрана — не прячем, иначе пропало бы всё сразу.
            if (allowed.length && picked[k] && allowed.indexOf(picked[k]) === -1) return false;
          }
          return true;
        };
        // Часть значений идёт не со всеми конфигурациями (нанотекстурное стекло —
        // только от 1 ТБ) или не со всеми чипами (128 ГБ памяти — только с M5 Max).
        // Зависимость двусторонняя, поэтому пересобираем и ряды групп, и ряд
        // конфигураций, а выбор, ставший недоступным, сбрасываем на соседний.
        var syncRows = function () {
          var picked = choiceMap();
          optionsEl.querySelectorAll('.option-group').forEach(function (g) {
            var fallback = null;
            g.querySelectorAll('.option-opt').forEach(function (b) {
              b.hidden = !fits(b, vstate.storageLabel, picked);
              if (!b.hidden && !b.disabled && !fallback) fallback = b;
            });
            var active = g.querySelector('.option-opt.active');
            if (!active || active.hidden || active.disabled) {
              pickOption(fallback || g.querySelector('.option-opt:not([hidden])'), true);
              picked = choiceMap();
            }
          });
          var stRow = document.getElementById('storages');
          if (stRow) {
            var stFallback = null;
            stRow.querySelectorAll('.storage-opt').forEach(function (b) {
              b.hidden = !fits(b, vstate.storageLabel, picked);
              if (!b.hidden && !b.disabled && !stFallback) stFallback = b;
            });
            var st = stRow.querySelector('.storage-opt.active');
            if ((!st || st.hidden || st.disabled) && stFallback && pickStorage) pickStorage(stFallback, true);
          }
          readOptions();
        };
        var applyStorageToOptions = syncRows;
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
        // btn === null означает «у этой коллекции размеров нет» — тогда выбор надо
        // именно СБРОСИТЬ, а не оставить как есть. Иначе размер прошлой коллекции
        // («M/L» от Trail Loop) уезжал в корзину вместе с ремешком, у которого
        // такого размера не бывает, и сервер помечал позицию недоступной.
        var pickSize = function (btn) {
          bandsEl.querySelectorAll('.band-sizes .storage-opt').forEach(function (x) { x.classList.remove('active'); x.setAttribute('aria-pressed', 'false'); });
          vstate.bandSize = '';
          vstate.bandSizeAdd = 0;
          if (btn) {
            btn.classList.add('active'); btn.setAttribute('aria-pressed', 'true');
            vstate.bandSize = btn.dataset.size;
            vstate.bandSizeAdd = Number(btn.dataset.add) || 0;
          }
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
      // quiet — конфигурацию сменила пересборка рядов (8 ТБ пропали вместе с
      // чипом): цену и повторную пересборку в этом случае запускает вызывающий.
      pickStorage = function (so, quiet) {
        if (!so || !storagesEl) return;
        storagesEl.querySelectorAll('.storage-opt').forEach(function (x) { x.classList.remove('active'); x.setAttribute('aria-pressed', 'false'); });
        so.classList.add('active'); so.setAttribute('aria-pressed', 'true');
        vstate.storageLabel = so.dataset.label; vstate.storageAdd = Number(so.dataset.add) || 0;
        if (quiet) return;
        if (onStorageChange) onStorageChange();   // значения «только от 1 ТБ»
        applyVariant();
      };
      if (storagesEl) storagesEl.addEventListener('click', function (e) {
        var so = e.target.closest('.storage-opt'); if (!so) return;
        pickStorage(so);
      });
      // Первая сборка рядов на загрузке: сервер уже спрятал несовместимое, но
      // после неё vstate точно совпадает с тем, что видно на экране.
      if (onStorageChange) onStorageChange();
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

  // Заказ уже создан — открываем оплату. Способ покупатель выбирает уже НА
  // странице оплаты, а не здесь: набор способов зависит от кассы, спрашивать её
  // на каждом открытии оформления незачем, а так покупатель ещё и может
  // переключиться на другой способ, не оформляя заказ заново.
  function startPayment(orderId) {
    location.href = '/pay/' + encodeURIComponent(orderId);
  }

  // Экран «заказ оформлен» — путь без онлайн-оплаты. При включённой оплате сюда
  // не приходим: заказ записан, и покупатель уходит на свою страницу оплаты.
  function showOrderDone(number) {
    var page = document.getElementById('checkout-page');
    if (!page) return;
    var grid = page.querySelector('.checkout-grid') || page.querySelector('.checkout-done');
    var head = page.querySelector('.checkout-title');
    if (head) head.textContent = 'Заказ оформлен';
    if (!grid) return;
    grid.className = 'checkout-done';
    grid.innerHTML = '<section class="order-success" id="order-success" role="status" aria-live="polite" tabindex="-1">'
      + '<div class="order-success-check" aria-hidden="true">✓</div>'
      + '<p class="order-success-eyebrow">Заявка получена</p>'
      + '<h3>Спасибо за заказ!</h3>'
      + '<p class="order-success-copy">Мы сохранили заявку и передали её менеджеру.</p>'
      + '<div class="order-success-number"><span>Заказ</span><strong>' + escapeHtml(orderNo(number)) + '</strong></div>'
      + '<div class="order-success-next"><span class="order-success-step" aria-hidden="true">1</span><div><strong>Что дальше?</strong><p>Менеджер позвонит по указанному номеру, чтобы подтвердить наличие и детали заказа.</p></div></div>'
      + '<a class="btn btn-primary btn-lg" href="/">Продолжить покупки</a>'
      + '</section>';
    var ok = document.getElementById('order-success');
    if (ok) { try { ok.focus(); } catch (e) {} }
  }

  function submitOrder(btn) {
    // В активном поле `change` мог ещё не случиться (Enter, автозаполнение), а
    // после ответа страница уйдёт на оплату. Снимаем полный снимок прямо сейчас.
    rememberCheckout();
    var msg = document.getElementById('order-msg');
    var val = function (id) { return ((document.getElementById(id) || {}).value || '').trim(); };
    // Те же требования, что и на сервере, — просто без ожидания ответа. Сервер
    // всё равно проверяет заново: клиентским данным не верим.
    var checks = [
      ['co-first-name', 'Укажите имя получателя'],
      ['co-last-name', 'Укажите фамилию получателя'],
      ['co-address', 'Укажите адрес или пункт выдачи']
    ];
    for (var c = 0; c < checks.length; c++) {
      if (!val(checks[c][0])) {
        if (msg) { msg.hidden = false; msg.className = 'form-msg err'; msg.textContent = checks[c][1]; }
        var field = document.getElementById(checks[c][0]);
        if (field) { try { field.focus(); } catch (e) {} }
        return;
      }
    }
    // Телефон проверяем не на «непусто», а тем же разбором, что и сервер:
    // недобранный номер («+7 999») пустым не выглядит, а заказом не станет.
    var phone = phoneCheck();
    if (!phone.ok) {
      if (msg) { msg.hidden = false; msg.className = 'form-msg err'; msg.textContent = phone.error; }
      var phoneField = document.getElementById('co-phone');
      if (phoneField) { try { phoneField.focus(); } catch (e) {} }
      return;
    }
    // Адрес разбирает сервер, и его ответ мы уже знаем — если он про ЭТУ строку.
    // Про другую (покупатель дописал адрес и нажал кнопку, не дождавшись ответа)
    // ничего не решаем: пусть отвечает сервер, он всё равно проверяет заново.
    if (ship.address === val('co-address') && !ship.valid && ship.error) {
      if (msg) { msg.hidden = false; msg.className = 'form-msg err'; msg.textContent = ship.error; }
      var addr = document.getElementById('co-address');
      if (addr) { try { addr.focus(); } catch (e) {} }
      return;
    }
    if (!deliveryChoice()) {
      if (msg) { msg.hidden = false; msg.className = 'form-msg err'; msg.textContent = 'Выберите способ доставки'; }
      return;
    }
    if (!deliveryModeChoice()) {
      if (msg) { msg.hidden = false; msg.className = 'form-msg err'; msg.textContent = 'Выберите, куда доставить: в пункт выдачи или курьером'; }
      return;
    }
    // Доставка в пункт выдачи без самого пункта — заказ без адреса назначения.
    // Полноту вписанного руками адреса проверит сервер, как и адрес покупателя.
    if (deliveryModeChoice() === 'pvz' && !pickup.code) {
      if (msg) { msg.hidden = false; msg.className = 'form-msg err'; msg.textContent = 'Выберите пункт выдачи'; }
      openPoints();
      return;
    }
    // Кнопка при такой сумме уже погашена, но проверяем ещё раз: сумму мог
    // изменить второй открытый таб.
    var limitError = totalLimitError(orderTotal());
    if (limitError) {
      if (msg) { msg.hidden = false; msg.className = 'form-msg err'; msg.textContent = limitError; }
      return;
    }
    var online = payOnline();
    btn.disabled = true;
    var btnHtml = btn.innerHTML;
    btn.textContent = online ? 'Открываем оплату...' : 'Отправляем...';
    var payload = {
      items: Cart.items.map(function (i) { return { id: i.id, qty: i.qty, storage: i.storage || '', color: i.color || '', band: i.band || '', bandSize: i.bandSize || '', options: i.options || [] }; }),
      firstName: val('co-first-name'),
      lastName: val('co-last-name'),
      // Номер уходит как есть: приводит его к единому виду сервер — тем же
      // модулем, что отформатировал поле. Двух разборов одной строки быть не
      // должно, даже если оба дают один результат.
      phone: phoneValue(),
      contact: val('co-contact'),
      address: val('co-address'),
      delivery: deliveryChoice(),
      deliveryMode: deliveryModeChoice(),
      // Код выбранного пункта выдачи. Адрес к нему сервер подставит сам из своей
      // базы — присланной строке он не верит так же, как не верит цене.
      pickupCode: pickup.code
    };
    fetch('/api/order', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (d.ok) {
          // Идём ли на оплату, говорит СЕРВЕР (`d.pay`): только он знает
          // пересчитанную сумму и пределы кассы. Витринная догадка выше нужна
          // была лишь для подписи кнопки.
          online = !!d.pay;
          // При онлайн-оплате корзину тут НЕ чистим: заказ пока черновик, и
          // покупатель, ушедший со страницы оплаты не выбрав способ, должен
          // найти товары на месте. Очистит её pay.js, когда способ выбран.
          if (!online) Cart.clear();
          var number = d.number || '';
          var page = document.getElementById('checkout-page');
          if (page) {                       // страница оформления: показываем результат на всю ширину
            // Оплата — отдельный шаг поверх записанной заявки, поэтому уводим на
            // форму только после подтверждения, что заказ создан.
            if (online && d.id) { startPayment(d.id); return; }
            showOrderDone(d.number || '—');
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
              + '<div class="order-success-number"><span>Заказ</span><strong>' + escapeHtml(orderNo(number)) + '</strong></div>'
              + '<div class="order-success-next"><span class="order-success-step" aria-hidden="true">1</span><div><strong>Что дальше?</strong><p>Менеджер позвонит по указанному номеру, чтобы подтвердить наличие и детали заказа.</p></div></div>'
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
