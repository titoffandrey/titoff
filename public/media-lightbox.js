/* Просмотрщик вложений — один на витрину и на панель.
 *
 * Одна галерея на отзыв: фото и видео листаются подряд, чтобы, открыв снимок,
 * не пришлось закрывать просмотр ради ролика. Разметка ссылок настоящая — без
 * скрипта клик просто открывает файл, как и раньше.
 *
 * Отдельным файлом, а не куском app.js: тот же просмотрщик нужен в панели
 * отзывов, а панель витринный скрипт не грузит и грузить не должна (там корзина,
 * оформление и метрика). Копия разъехалась бы с оригиналом на первой же правке.
 *
 * Опознаётся разметка по атрибутам, а не по классам: группа — любой элемент с
 * `data-media`, вложение внутри неё — ссылка с `data-kind` ("photo" | "video").
 * Классы у витрины и панели свои и меняются вместе с вёрсткой, а эти два
 * атрибута — договор между разметкой и просмотрщиком.
 */
(function () {
  'use strict';

  var GROUP = '[data-media]';
  var ITEM = 'a[data-kind]';

  /* Медиа не отдаём «в один клик»: ни перетаскиванием, ни правой кнопкой, ни
     кнопкой скачивания в плеере. Полностью закрыть картинку от сохранения
     нельзя — она всё равно приходит в браузер, — но случайное «сохранить как»
     этим отсекается. */
  function guardMedia(node) {
    if (!node) return;
    node.setAttribute('draggable', 'false');
    node.addEventListener('dragstart', function (e) { e.preventDefault(); });
    node.addEventListener('contextmenu', function (e) { e.preventDefault(); });
  }

  var lightbox = null;

  function lbBuild() {
    if (lightbox) return lightbox;
    var el = document.createElement('div');
    el.className = 'lb';
    el.id = 'review-lightbox';
    el.setAttribute('role', 'dialog');
    el.setAttribute('aria-modal', 'true');
    el.setAttribute('aria-label', 'Просмотр вложений отзыва');
    el.hidden = true;
    var svg = function (d) {
      return '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">'
        + '<path d="' + d + '" fill="none" stroke="currentColor" stroke-width="2"'
        + ' stroke-linecap="round" stroke-linejoin="round"/></svg>';
    };
    el.innerHTML =
      '<div class="lb-bar">'
      + '<span class="lb-count" id="lb-count" aria-live="polite"></span>'
      + '<button type="button" class="lb-btn lb-close" aria-label="Закрыть">' + svg('M6 6l12 12M18 6L6 18') + '</button>'
      + '</div>'
      + '<button type="button" class="lb-btn lb-nav lb-prev" aria-label="Предыдущее вложение">' + svg('M15 5l-7 7 7 7') + '</button>'
      + '<div class="lb-stage" id="lb-stage"></div>'
      + '<button type="button" class="lb-btn lb-nav lb-next" aria-label="Следующее вложение">' + svg('M9 5l7 7-7 7') + '</button>';
    document.body.appendChild(el);
    el.addEventListener('click', function (e) {
      // Закрываем кликом мимо кадра: и по фону, и по пустому месту вокруг него.
      // Сам кадр и кнопки клик не закрывает — иначе пауза видео закрывала бы просмотр.
      if (e.target === el || e.target.id === 'lb-stage') lbClose();
    });
    el.querySelector('.lb-close').addEventListener('click', lbClose);
    el.querySelector('.lb-prev').addEventListener('click', function () { lbGo(-1); });
    el.querySelector('.lb-next').addEventListener('click', function () { lbGo(1); });
    lightbox = el;
    return el;
  }

  var lbItems = [], lbIndex = 0, lbReturn = null;

  function lbShow() {
    var el = lbBuild();
    var stage = el.querySelector('#lb-stage');
    var item = lbItems[lbIndex];
    if (!item) return;
    // Прежний ролик обязательно останавливаем: иначе звук идёт из закрытого кадра.
    var old = stage.querySelector('video');
    if (old) { try { old.pause(); } catch (e) {} }
    stage.innerHTML = '';
    var node;
    if (item.kind === 'video') {
      node = document.createElement('video');
      node.src = item.src;
      node.controls = true;
      node.autoplay = true;
      node.playsInline = true;
      node.setAttribute('playsinline', '');
      node.setAttribute('controlsList', 'nodownload noplaybackrate');
      node.disablePictureInPicture = true;
    } else {
      node = document.createElement('img');
      node.src = item.src;
      node.alt = 'Вложение к отзыву';
    }
    node.className = 'lb-media';
    guardMedia(node);
    stage.appendChild(node);
    var many = lbItems.length > 1;
    el.querySelector('.lb-prev').hidden = !many;
    el.querySelector('.lb-next').hidden = !many;
    var count = el.querySelector('#lb-count');
    count.textContent = many ? (lbIndex + 1) + ' / ' + lbItems.length : '';
  }

  function lbGo(step) {
    if (!lbItems.length) return;
    lbIndex = (lbIndex + step + lbItems.length) % lbItems.length;  // по кругу
    lbShow();
  }

  function lbOpen(items, index, opener) {
    lbItems = Array.isArray(items) ? items.filter(function (item) {
      return item && (item.kind === 'photo' || item.kind === 'video') && item.src;
    }) : [];
    if (!lbItems.length) return;
    lbIndex = Math.max(0, Math.min(Number(index) || 0, lbItems.length - 1));
    lbReturn = opener || null;
    var el = lbBuild();
    el.hidden = false;
    document.body.classList.add('lb-open');
    lbShow();
    el.querySelector('.lb-close').focus();
  }

  function lbClose() {
    if (!lightbox || lightbox.hidden) return;
    var v = lightbox.querySelector('video');
    if (v) { try { v.pause(); } catch (e) {} }
    lightbox.querySelector('#lb-stage').innerHTML = '';
    lightbox.hidden = true;
    document.body.classList.remove('lb-open');
    lbItems = [];
    x0 = y0 = null;
    if (lbReturn && document.contains(lbReturn)) lbReturn.focus();
    lbReturn = null;
  }

  // Список отзывов перерисовывается при листании и смене сортировки, а в панели
  // строки приходят целыми страницами, поэтому слушаем документ, а не карточки.
  document.addEventListener('click', function (e) {
    var link = e.target.closest && e.target.closest(ITEM);
    if (!link) return;
    // Открыть в новой вкладке средней кнопкой или с Cmd/Ctrl — обычное дело.
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
    var box = link.closest(GROUP);
    if (!box) return;
    e.preventDefault();
    var nodes = box.querySelectorAll(ITEM);
    var items = [], index = 0;
    for (var i = 0; i < nodes.length; i++) {
      items.push({ src: nodes[i].getAttribute('href'), kind: nodes[i].dataset.kind });
      if (nodes[i] === link) index = i;
    }
    lbOpen(items, index, link);
  });

  document.addEventListener('keydown', function (e) {
    if (!lightbox || lightbox.hidden) return;
    if (e.key === 'Escape') { e.preventDefault(); lbClose(); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); lbGo(-1); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); lbGo(1); }
    else if (e.key === 'Tab') {
      // aria-modal обещает, что клавиатура остаётся внутри диалога. Без этого
      // после кнопки «дальше» Tab уходил на ссылки невидимой страницы под фото.
      var controls = Array.prototype.filter.call(
        lightbox.querySelectorAll('button:not([hidden]):not([disabled]),video[controls]'),
        function (node) { return !node.hidden; }
      );
      if (!controls.length) { e.preventDefault(); return; }
      var first = controls[0], last = controls[controls.length - 1];
      var outside = !lightbox.contains(document.activeElement);
      if (outside || (e.shiftKey && document.activeElement === first)
        || (!e.shiftKey && document.activeElement === last)) {
        e.preventDefault();
        (e.shiftKey ? last : first).focus();
      }
    }
  });

  // Листание пальцем. Порог заметно больше вертикального сдвига, иначе обычная
  // прокрутка страницы перелистывала бы кадры.
  var x0 = null, y0 = null;
  document.addEventListener('touchstart', function (e) {
    if (!lightbox || lightbox.hidden || !e.touches[0]) return;
    x0 = e.touches[0].clientX; y0 = e.touches[0].clientY;
  }, { passive: true });
  document.addEventListener('touchend', function (e) {
    if (x0 == null || !lightbox || lightbox.hidden || !e.changedTouches[0]) return;
    var dx = e.changedTouches[0].clientX - x0, dy = e.changedTouches[0].clientY - y0;
    if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.5) lbGo(dx < 0 ? 1 : -1);
    x0 = y0 = null;
  }, { passive: true });

  window.MediaLightbox = { open: lbOpen, close: lbClose, guard: guardMedia };
})();
