'use strict';
// Панель администратора (/admin) — единственная и с полными правами: каталог,
// модерация отзывов, заказы, метрика и все настройки магазина.
//
// Раньше панелей было две: владелец правил общий каталог, а администратор
// домена — цены и видимость на своём сайте. Домен остался один, разделять права
// стало не с кем, и обе панели слились в эту.
const R = require('./render');
const AV = require('./analytics-view');
const PAY = require('./pay-methods');
const PF = require('./price-float');
// Касса: одна и та же `enabled()` решает, что показывает витрина и что пишет
// про свой режим панель — разъехавшись, они рассказывали бы разное об одном.
const PAYMENTS = require('./payments');
// Словарь отказов касс: панель называет причину своими короткими словами, а
// покупатель видит из него же совет, что делать дальше.
const ERR = require('./pay-errors');
const CROCO = require('./crocopay');
const MERIDIAN = require('./meridianpay');
const DELIVERY = require('./delivery');
// Маршрут посылки: панель его собирает и правит, а состояние спрашивает у того
// же модуля, что и витрина, — «в пути» у менеджера и у покупателя обязано
// значить одно и то же.
const TRACK = require('./tracking');
// Срок сборки заказа: панель его правит, а сетку сроков считает тот же модуль,
// что показывает покупателю число дней на оформлении.
const SHIPDAYS = require('./delivery-days');
// Онлайн-чат: состояние моста в Telegram и настроенность ИИ. Панель обязана
// показывать не «включено», а то, что происходит на самом деле, — то же
// правило, что у строк состояния касс.
const CHAT = require('./chat');
// Ссылки консультанта разбирает тот же файл, что и витрина (`public/chat-links.js`):
// менеджер обязан видеть в панели ровно то, что видит покупатель, — название
// товара ссылкой, а не скобки с адресом.
const LINKS = require('../public/chat-links');
const AI = require('./ai');
const TGCHAT = require('./chat-tg');
const PROMPT = require('./chat-prompt');
// Скидка процентом: панель показывает её в списке и правит в форме товара.
const D = require('./discount');
// Промокоды: раздел показывает то же состояние, которое видит покупатель, и
// спрашивает его у того же модуля, что считает цены.
const PROMO = require('./promo');
const esc = R.esc;

// Начало адреса карточки посетителя. Одно место на панель: этот же адрес стоит
// у IP в строке заказа и у строки в таблице метрики.
const VISITOR_BASE = '/admin/analytics/visitor/';
// Начало адреса «написать покупателю». Адресат — метка посетителя, та же, что в
// карточке метрики: по ней витрина и находит разговор, которого покупатель не
// начинал.
const CHAT_TO_BASE = '/admin/chat/new?to=';

/* Значение для поля даты — по МОСКВЕ, как и всё остальное время в панели.
 * Разбирает его обратно `parseMskInput` (см. server.js): показывать одно
 * время, а сохранять другое — верный способ сдвигать дату отзыва на три часа
 * при каждом сохранении формы. */
const dtLocal = ms => R.mskInputValue(ms);

// Панель красится акцентным цветом магазина: он и так уже настраивается, а
// раньше владелец сидел на жёстко зашитом графите просто потому, что панель
// была общей на все домены.
function shellStyle(settings) {
  return `<style>:root{--accent:${R.cssColor(settings && settings.accentColor, '#1d1d1f')}}</style>`;
}

/* Сколько где ждёт внимания — счётчики у разделов в меню и общий на кнопке.
 *
 * Три вопроса, на которые панель обязана отвечать, не открывая разделы: сколько
 * отзывов ждёт модерации, сколько заказов пришло, пока меня не было, и в
 * скольких диалогах покупатель написал и ответа не получил. Считается всё из уже
 * существующих признаков: очередь отзывов, метка просмотра заказов и та же
 * отметка прочтения, по которой покупателю рисуются галочки в окне чата.
 *
 * Чат выключен — счётчика нет вовсе: звать в раздел, которого покупатель не
 * видит, незачем.
 */
function navCounts(settings, db) {
  // Счётчик — подпись в шапке, а не содержание раздела: хранилище без такого
  // метода (урезанный db под рукой у теста) рисует панель без цифры, а не роняет
  // страницу целиком.
  const ask = name => (db && typeof db[name] === 'function') ? Math.max(0, Number(db[name]()) || 0) : 0;
  return {
    reviews: ask('pendingReviewCount'),
    orders: ask('newOrderCount'),
    chat: CHAT.visible(settings) ? CHAT.unreadCount() : 0
  };
}

function layout(settings, opts) {
  opts = opts || {};
  const accessibleBody = R.accessibleFields(opts.body || '', 'admin-field');
  // `counts` — три счётчика разом; `pendingCount` остаётся ради вызовов, где
  // считать нечего, кроме очереди отзывов.
  const counts = opts.counts || { reviews: opts.pendingCount || 0 };
  const badges = {
    reviews: Math.max(0, Number(counts.reviews) || 0),
    orders: Math.max(0, Number(counts.orders) || 0),
    chat: Math.max(0, Number(counts.chat) || 0)
  };
  const pending = badges.reviews + badges.orders + badges.chat;
  const nav = [
    ['/admin', 'Обзор', 'dash'],
    ['/admin/products', 'Каталог', 'products'],
    ['/admin/promo', 'Промокоды', 'promo'],
    ['/admin/reviews', 'Отзывы', 'reviews'],
    ['/admin/orders', 'Заказы', 'orders'],
    ['/admin/shipments', 'Отправления', 'shipments'],
    ['/admin/chat', 'Чат', 'chat'],
    ['/admin/analytics', 'Метрика', 'analytics'],
    ['/admin/settings', 'Настройки', 'settings']
  ].map(([href, label, key]) => {
    const badge = badges[key] ? `<span class="a-badge">${badges[key]}</span>` : '';
    return `<a href="${href}" class="a-nav-item${opts.active === key ? ' active' : ''}"${opts.active === key ? ' aria-current="page"' : ''}>${R.adminIcon(key)}<span>${label}</span>${badge}</a>`;
  }).join('');
  /* Меню — кнопка в шапке и панель разделов, выезжающая слева поверх страницы.
   *
   * Раскладка снята с бокового меню Google Trends, вплоть до чисел: панель 320
   * px с закруглённым правым краем, пункт высотой 56 px пилюлей во всю ширину,
   * выбранный залит голубым, служебное — за волосяной линией, остальная
   * страница затемнена. Формат знаком по самому Trends, откуда взят и график
   * посещаемости, — покупать второй язык навигации ради панели незачем.
   *
   * Состояние держит СКРЫТЫЙ ЧЕКБОКС, а не <details>, и это единственное, чем
   * устройство отличается от прежнего выпадающего списка. Причина жёсткая: у
   * `.a-topbar` есть `backdrop-filter`, а он делает элемент опорным для
   * `position:fixed` — панель, лежащая внутри шапки, считала бы координаты от
   * неё, а не от окна. Чекбокс же связан с кнопкой по `for`, поэтому сам он
   * лежит рядом с шапкой, панель — снаружи, а кнопка остаётся внутри
   * `data-live-part="topbar"`, и счётчик на ней обновляется живьём.
   *
   * Скрипта по-прежнему не требуется ни на что: открывает кнопка-подпись,
   * закрывает нажатие по затемнению (это тоже подпись к тому же чекбоксу).
   * `public/admin-ui.js` добавляет только Esc.
   *
   * Счётчики продублированы одним числом на самой кнопке: с закрытым меню их не
   * видно вовсе, а «сколько всего ждёт меня» — то, что нужно знать, не открывая
   * ни одного раздела. Разбивка по разделам — в самом меню.
   */
  const menuBtn = `<label class="a-menu-btn" for="a-menu" title="Разделы">`
    + `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" aria-hidden="true"><path d="M4 6.5h16M4 12h16M4 17.5h16"/></svg>`
    + `${pending ? `<span class="a-menu-dot">${pending}</span>` : ''}</label>`;
  const menu = `<input type="checkbox" id="a-menu" class="a-menu-check" aria-label="Разделы">
    <div class="a-menu-wrap">
      <label class="a-menu-scrim" for="a-menu" aria-hidden="true"></label>
      <nav class="a-menu-panel" data-live-part="menu"><div class="a-menu-list">${nav}
        <span class="a-menu-sep" aria-hidden="true"></span>
        <a class="a-nav-item" href="/" target="_blank" rel="noopener noreferrer">${R.adminIcon('sites')}<span>Открыть витрину</span></a>
      </div></nav>
    </div>`;
  /* Живое обновление. `opts.live` — темы, за которыми следит эта страница
   * (`lib/live.js`): «orders», «reviews», «products», «analytics». Страница без
   * тем скрипта не грузит вовсе — форме товара и настройкам обновляться из-под
   * руки нечего и незачем.
   *
   * Блоков ровно два и они общие на все страницы панели: шапка (в ней счётчик
   * очереди модерации) и содержимое. Перечислять их по разделам значило бы
   * забыть один и молча остаться без обновлений именно там. */
  const live = String(opts.live || '').trim();
  // Отметка в шапке. Без неё подмена бесшумна, и непонятно, живая страница или
  // просто давно открытая; на «Метрике» она заодно заменила кнопку «Обновить».
  const liveMark = live
    /* Плашка в шапке. Подпись «online», а не «живое»: рядом с зелёной
     * пульсирующей точкой это привычная всем отметка «на связи».
     *
     * Число перед словом — СКОЛЬКО ЧЕЛОВЕК НА ВИТРИНЕ ПРЯМО СЕЙЧАС. Место в
     * шапке одно, и висело там до сих пор то, что и так понятно по живущей
     * странице: «связь есть». Ответ на вопрос «идёт ли сейчас торговля» нужнее
     * — а сказать про разрыв связи плашка по-прежнему обязана, потому что при
     * разрыве это число врёт первым.
     *
     * ОБА слова лежат здесь, в разметке, а показывает нужное CSS по классу
     * `is-off`, который ставит `public/admin-live.js`. Писать текст из скрипта
     * нельзя по тому же правилу, по которому отсчёт срока счёта берёт «истёк»
     * из `data-over`: все подписи про состояние живут в одном месте, иначе они
     * разъезжаются, а увидеть это можно только глазами. Скрипт пишет ровно одно
     * — цифру, и берёт её из канала (`event: online` в `lib/live.js`).
     *
     * Слот числа пуст: разметка страницы про онлайн ничего не знает, а сервер
     * рисует плашку всегда подключённой — про связь КОНКРЕТНОГО браузера он
     * знать не может. Отсюда же и правило в admin-live.js: подмена блоков эту
     * плашку не трогает вовсе. */
    ? `<span class="a-live" title="Сколько человек на витрине прямо сейчас. Страница обновляется сама, перезагружать не нужно"`
      + ` data-title-off="Связь с сервером потеряна — цифры на экране могли устареть">`
      + `<i></i><b class="a-live-on"><span class="a-live-num"></span>online</b>`
      + `<b class="a-live-off">нет связи</b></span>` : '';
  return `<!DOCTYPE html><html lang="ru"><head><meta charset="utf-8">
${/* Тот же viewport, что у витрины: панель на телефоне тоже открывают с руки, и
   съехавший вбок экран мешает там ровно так же. См. `public/mobile-shell.js`. */''}
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover">
<title>${esc(settings.storeName || 'Магазин')} · ${esc(opts.title || '')}</title>
<meta name="robots" content="noindex, nofollow">
<link rel="stylesheet" href="/static/styles.css?v=${R.assetV('styles.css')}">${shellStyle(settings)}</head>
<body class="admin${opts.app ? ' a-app' : ''}"${live ? ` data-live="${esc(live)}"` : ''}>
<div class="a-shell">
  <main class="a-main">
    ${menu}
    <div class="a-topbar" data-live-part="topbar">${menuBtn}<h1>${esc(opts.title || '')}</h1>${liveMark}${
      // Кнопки раздела — своей обёрткой, а не вперемешку с заголовком. На
      // телефоне они уходят на вторую строку целиком; пока они лежали прямо в
      // шапке, отправить их вниз было нечем, и две кнопки («← Все отзывы» и
      // «+ Добавить отзыв») сжимали заголовок до одной буквы, а отметку
      // «живое» — до её зелёной точки.
      opts.actions ? `<div class="a-topbar-acts">${opts.actions}</div>` : ''}</div>
    ${opts.flash ? `<div class="a-flash ${esc(opts.flashType || 'ok')}">${esc(opts.flash)}</div>` : ''}
    <div class="a-content${opts.wide ? ' a-content-wide' : ''}" data-live-part="content">${accessibleBody}</div>
  </main>
</div>
${live ? /* Куда падают уведомления о событиях. Стоит ВНЕ живых блоков намеренно:
   подмена разметки при обновлении страницы иначе сносила бы карточку прямо
   из-под курсора — она приходит по своему каналу и живёт своей жизнью.
   `aria-live="polite"` — чтобы о заказе узнал и тот, кто читает с экрана. */
  '<div class="a-notes" id="a-notes" aria-live="polite"></div>' : ''}
${/* Подтверждение спрашивает и НАЖАТАЯ КНОПКА, а не только форма целиком: у
   формы правки реплики две кнопки отправки, и «точно удалить?» на «Сохранить»
   было бы вопросом не по делу. Форма остаётся запасным носителем — там, где
   опасное действие у неё одно. */''}
<script>document.addEventListener('submit',function(e){var f=e.target,b=e.submitter,ask=(b&&b.getAttribute('data-confirm'))||f.getAttribute('data-confirm');if(ask&&!confirm(ask))e.preventDefault();});</script>
<script src="/static/mobile-shell.js?v=${R.assetV('mobile-shell.js')}" defer></script>
<script src="/static/admin-ui.js?v=${R.assetV('admin-ui.js')}" defer></script>
<script src="/static/media-lightbox.js?v=${R.assetV('media-lightbox.js')}" defer></script>
${/* Сигналы чата — тот же файл, что у покупателя: правило «как звучит чат»
     общее, и две копии разошлись бы на первой правке. */''}
<script src="/static/chat-sound.js?v=${R.assetV('chat-sound.js')}" defer></script>
${live ? `<script src="/static/admin-live.js?v=${R.assetV('admin-live.js')}" defer></script>` : ''}
</body></html>`;
}

/* ===================== Уведомления о событиях =====================
 *
 * Заказ, отзыв и реплика в чате приходят сами, и до сих пор панель показывала их
 * молча: цифра в таблице менялась, а понять, что именно случилось, можно было,
 * только стоя на нужном разделе. Теперь событие приезжает карточкой поверх
 * страницы — с миниатюрой, чтобы с одного взгляда было видно, о каком товаре
 * (или о ком) речь.
 *
 * Разметку, как и всё остальное в панели, рисует СЕРВЕР: `lib/live.js` уносит её
 * готовой строкой, а `public/admin-live.js` только вставляет в контейнер. Второй
 * рендер в браузере разъехался бы с этим на первой же правке.
 *
 * Ссылка ведёт туда, где событие можно разобрать: заявка — к своему якорю в
 * списке, отзыв — в очередь модерации, реплика — в сам диалог.
 */
const NOTE_TEXT_MAX = 90;
function noteText(s) {
  const t = String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  return t.length > NOTE_TEXT_MAX ? t.slice(0, NOTE_TEXT_MAX - 1).trimEnd() + '…' : t;
}

function noteCard(kind, data) {
  // Миниатюры нет (у товара нет фото, у диалога нет имени) — на её месте значок
  // раздела: пустой квадрат читался бы как незагрузившаяся картинка.
  const pic = data.pic || `<span class="a-note-ico">${R.adminIcon(kind === 'chat' ? 'chat' : (kind === 'review' ? 'reviews' : 'orders'))}</span>`;
  return `<div class="a-note a-note-${esc(kind)}" data-note>`
    + `<a class="a-note-link" href="${esc(data.href)}">`
    + `<span class="a-note-pic">${pic}</span>`
    + `<span class="a-note-text"><b>${esc(data.title)}</b>`
    + (data.text ? `<i>${esc(data.text)}</i>` : '')
    + `</span></a>`
    + `<button type="button" class="a-note-x" data-note-close aria-label="Скрыть">`
    + `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true">`
    + `<path d="M7 7l10 10M17 7 7 17"/></svg></button></div>`;
}

// Миниатюра товара — та же уменьшенная копия, что в списке каталога: в карточку
// уведомления она приходит квадратиком в полсотни пикселей, и качать ради неё
// снимок 1200×1200 незачем.
function notePic(db, product) {
  /* Фото нет — отдаём пустоту, и карточка возьмёт значок раздела.
   * Плейсхолдер витрины сюда не годится: он рисуется ссылкой `<use>` на спрайт,
   * который вставляет страница каталога, а в панели его нет — вместо силуэта
   * товара вышел бы пустой светлый квадрат, читаемый как незагрузившееся фото. */
  if (!product || !((product.images || []).length)) return '';
  return `<span class="a-note-thumb">${R.imageMarkup(product, 0, { small: true, dir: db.UPLOAD_DIR })}</span>`;
}

function noteOrder(settings, db, order) {
  const items = (order && order.items) || [];
  const first = items[0] || null;
  const rest = items.length - 1;
  const what = first ? first.name + (rest > 0 ? ` и ещё ${rest}` : '') : '';
  return noteCard('order', {
    href: '/admin/orders#order-' + esc(order.id),
    title: 'Новый заказ ' + R.orderNo(order.number),
    text: noteText([what, R.money(order.total, settings)].filter(Boolean).join(' · ')),
    pic: notePic(db, first ? db.getProduct(first.id) : null)
  });
}

function noteReview(settings, db, review) {
  const product = review && review.productId ? db.getProduct(review.productId) : null;
  const rating = Math.max(0, Math.min(5, Math.round(Number(review && review.rating) || 0)));
  return noteCard('review', {
    // В очередь модерации, а не в ленту товара: отзыв ждёт решения, и это
    // единственное дело, у которого есть срок.
    href: '/admin/reviews',
    title: 'Новый отзыв' + (rating ? ' · ' + '★'.repeat(rating) : ''),
    text: noteText([product ? product.name : '', review && review.text].filter(Boolean).join(' · ')),
    pic: notePic(db, product)
  });
}

function noteChat(chat, text) {
  return noteCard('chat', {
    href: '/admin/chat/' + esc(chat.id),
    title: 'Сообщение в чат · ' + chatTitle(chat),
    text: noteText(text),
    // Аватар тот же, что в списке диалогов: кружок с первой буквой имени или
    // города. Своей картинки у собеседника нет и быть не может.
    pic: `<span class="a-note-ava">${chatAvatar(chat)}</span>`
  });
}

function loginPage(settings, error) {
  return `<!DOCTYPE html><html lang="ru"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover"><title>Вход · ${esc(settings.storeName || 'Магазин')}</title>
<meta name="robots" content="noindex, nofollow">
<link rel="stylesheet" href="/static/styles.css?v=${R.assetV('styles.css')}">${shellStyle(settings)}</head>
<body class="admin login-body">
<form class="login-card" method="post" action="/admin/login">
  <div class="login-brand">${esc(settings.storeName || 'Магазин')}</div>
  <p class="muted">Панель управления</p>
  ${error ? `<div class="a-flash err">${esc(error)}</div>` : ''}
  <div class="field"><label for="admin-login">Логин</label><input id="admin-login" name="username" autocomplete="username" required autofocus></div>
  <div class="field"><label for="admin-password">Пароль</label><input id="admin-password" name="password" type="password" autocomplete="current-password" required></div>
  <button class="btn btn-primary btn-block" type="submit">Войти</button>
</form></body></html>`;
}

// Сколько заявок показывать на «Обзоре». Восемь строк таблицы занимали экран
// целиком; строка списка вдвое ниже, но и шести хватает: за остальными идут в
// раздел заказов.
const RECENT_ORDERS = 6;

function dashboard(settings, db, pulse) {
  const live = pulse || {};
  const orders = db.visibleOrders();
  const pending = db.pendingReviewCount();
  // Сводка по оплате — та же, что над списком заказов: «Обзор» отвечает на тот
  // же вопрос, и два разных вида одних и тех же счётчиков разъехались бы.
  const financialOrders = typeof db.getOrders === 'function' ? db.getOrders() : orders;
  const stats = R.orderStats(orders, undefined, financialOrders);
  /* Последние заказы — списком, а не таблицей в четыре столбца: на телефоне
   * таблицу приходилось листать вбок, теряя из виду и номер, и сумму, а строк
   * здесь всего шесть.
   *
   * Строка ведёт в раздел заказов к якорю этой заявки: там она подсвечивается
   * (`tr:target`) и рядом лежит всё остальное — состав, адрес, техника.
   */
  // data-live-key — чтобы при живом обновлении свежая заявка вставлялась сверху,
  // а остальные строки оставались теми же узлами, а не переписывались заново.
  const recent = orders.slice(0, RECENT_ORDERS).map(o => `<a class="o-recent-row ${R.orderRowClass(o)}" data-live-key="recent-${esc(o.id)}" href="/admin/orders#order-${esc(o.id)}">
      <div class="o-recent-num"><b>${esc(R.orderNo(o.number))}</b><span class="muted small">${R.formatDate(o.createdAt)}</span></div>
      <div class="o-recent-state">${R.orderStatus(o)}</div>
      <div class="o-recent-who">${esc([o.customerName, R.phoneText(o.phone) || o.contact].filter(Boolean).join(' · ') || 'Без контакта')}</div>
      <div class="o-recent-sum">${R.money(o.total, settings)}</div>
    </a>`).join('');
  // Порядок блоков: деньги, последние заявки, потом всё остальное. «Обзор»
  // открывают, чтобы узнать, что с заказами, — карточки каталога и отзывов
  // между сводкой и списком разрывали бы этот рассказ надвое.
  const body = `
    ${R.orderStatsBar(stats, settings)}
    <div class="a-panel"><div class="a-panel-head"><h2>Последние заказы</h2><a class="link" href="/admin/orders">Все заказы →</a></div>
      ${recent ? `<div class="o-recent">${recent}</div>` : '<p class="muted o-recent-empty">Заказов пока нет</p>'}</div>
    <div class="a-cards">
      <a class="a-stat a-stat-live${Number(live.online) ? '' : ' is-idle'}" href="/admin/analytics"><div class="a-stat-num"><i></i>${Number(live.online) || 0}</div><div class="a-stat-label">Сейчас на сайте</div><div class="a-stat-sub">${live.visitors ? 'сегодня ' + Number(live.visitors || 0).toLocaleString('ru-RU') + ' ' + R.pluralRu(live.visitors, 'посетитель', 'посетителя', 'посетителей') + ' · ' + Number(live.visits || 0).toLocaleString('ru-RU') + ' ' + R.pluralRu(live.visits, 'заход', 'захода', 'заходов') : 'сегодня заходов ещё не было'}</div></a>
      <a class="a-stat" href="/admin/reviews"><div class="a-stat-num">${pending}</div><div class="a-stat-label">Отзывов на модерации</div><div class="a-stat-sub">${pending ? 'ждут ответа' : 'очередь разобрана'}</div></a>
      <a class="a-stat a-stat-link" href="/admin/analytics/visitors"><div class="a-stat-num">Кто заходил</div><div class="a-stat-label">История посещений за год</div></a>
    </div>`;
  /* «Обзор» смотрит сразу за всем, что на нём показано: заявки, очередь
   * модерации и число человек на витрине — поэтому в темах живого обновления
   * есть и `analytics`: счётчик «сейчас на сайте» обязан меняться сам, иначе
   * это просто число, снятое в момент открытия страницы. Счётчика товаров
   * здесь больше нет: он менялся раз в месяц (и виден в самом каталоге), а
   * место на «Обзоре» дороже отдать тому, что меняется каждую минуту. */
  return layout(settings, { active: 'dash', title: 'Обзор', counts: navCounts(settings, db), live: 'orders reviews products analytics chat', body });
}

/* ---------- Каталог ---------- */
function productsList(settings, db, flash) {
  // Порядок строк здесь и есть порядок карточек на главной: витрина показывает
  // товары в порядке файла. Строку можно перетащить за ручку или подвинуть
  // стрелками — сохраняется сразу, без кнопки «Сохранить».
  const list = db.getProducts();
  const grip = `<svg viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path d="M6 3.2h.01M10 3.2h.01M6 8h.01M10 8h.01M6 12.8h.01M10 12.8h.01" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"/></svg>`;
  const rows = list.map((p, i) => {
    const r = db.ratingFor(p.id);
    const hidden = !db.isVisible(p);
    const pct = D.discountPct(p);
    return `<tr data-id="${esc(p.id)}" draggable="true"${hidden ? ' class="row-off"' : ''}>
      <td class="a-order">
        <span class="a-grip" title="Перетащите, чтобы изменить порядок" aria-hidden="true">${grip}</span>
        <span class="a-order-num">${i + 1}</span>
        <span class="a-order-btns">
          <button type="button" class="a-move a-move-up" aria-label="Переместить «${esc(p.name)}» выше"${i === 0 ? ' disabled' : ''}>↑</button>
          <button type="button" class="a-move a-move-down" aria-label="Переместить «${esc(p.name)}» ниже"${i === list.length - 1 ? ' disabled' : ''}>↓</button>
        </span>
      </td>
      <td class="a-thumb">${R.imageMarkup(p, 0, { small: true, dir: db.UPLOAD_DIR })}</td>
      <td class="a-pname"><b>${esc(p.name)}</b><br><span class="muted">${esc(p.category)}</span></td>
      <td class="a-price">${R.money(p.price, settings)}</td>
      <td class="a-marks">${hidden ? '<span class="pill off">скрыт</span> ' : ''}${pct ? `<span class="pill ok">−${pct}%</span>` : ''} ${r.count
        ? `<a href="/admin/reviews/product/${encodeURIComponent(p.id)}" title="Отзывы товара">★ ${r.avg} (${r.count})</a>`
        : ''}</td>
      <td class="a-actions">
        <a class="btn btn-sm" href="/admin/products/${esc(p.id)}/edit">Изменить</a>
        <a class="btn btn-sm" href="/admin/reviews/new?productId=${encodeURIComponent(p.id)}">+ Отзыв</a>
        <form method="post" action="/admin/products/${esc(p.id)}/delete" data-confirm="Удалить товар «${esc(p.name)}» из каталога?"><button class="btn btn-sm btn-danger">Удалить</button></form>
      </td></tr>`;
  }).join('') || `<tr><td colspan="6" class="muted">Каталог пуст.</td></tr>`;
  return layout(settings, { active: 'products', title: 'Каталог', counts: navCounts(settings, db),
    actions: `<a class="btn btn-primary" href="/admin/products/new">+ Добавить товар</a>`,
    /* Абзаца-подсказки про порядок строк здесь больше нет. Он объяснял то, что
       видно самими элементами — ручка, номер и стрелки стоят в каждой строке, —
       а читают его один раз, тогда как видят при каждом заходе в каталог. То же
       правило, по которому подсказки убраны из настроек оплаты и из формы
       отзыва. Подпись «базовая цена» под каждой ценой ушла по той же причине:
       ровно это написано в заголовке столбца над ней, и повторялось оно у
       каждого из полусотни товаров. */
    flash, body: `<div class="a-panel a-panel-list"><table class="a-table a-table-sortable"><thead><tr><th><span class="sr-only">Порядок</span></th><th></th><th>Товар</th><th>Базовая цена</th><th></th><th></th></tr></thead>
    <tbody id="product-order" data-order="${esc(JSON.stringify(list.map(p => p.id)))}">${rows}</tbody></table></div>
    <p class="form-msg" id="order-msg" hidden></p>
    <script src="/static/product-order.js?v=${R.assetV('product-order.js')}"></script>` });
}

function productForm(settings, db, product, opts) {
  opts = opts || {};
  const isEdit = !!product;
  const errors = opts.errors || [];
  const draft = opts.draft || null;           // то, что админ только что отправил с ошибкой
  const errFor = field => (errors.find(e => e.field === field) || {}).text || '';
  const p = product || { name: '', category: '', price: '', inStock: true, visible: true, stockLevel: 'in', shortDesc: '', description: '', specs: '', images: [], colors: [], storages: [], bands: [], options: [] };
  // Процент скидки: у старых товаров его ещё нет, и он выводится из сохранённой
  // пары цен — иначе форма показала бы «скидки нет» у товара, который на витрине
  // её показывает, а первое же сохранение эту скидку и стёрло бы.
  const pct = product ? D.discountPct(product) : 0;
  // При ошибке подставляем введённые значения, чтобы не потерять набранное
  const val = (field, fallback) => draft && draft[field] !== undefined ? draft[field] : fallback;
  const checked = (field, fallback) => draft ? draft[field] !== undefined : fallback;
  // Третье поле — наличие варианта; для распроданных пишем «нет», иначе строка прежняя.
  const colorsText = draft ? String(draft.colors || '') : (p.colors || []).map(c => `${c.name}|${c.hex || '#cccccc'}${c.inStock === false ? '|нет' : ''}`).join('\n');
  // «?Группа=значение» — привязка к выбору в другой группе (8 ТБ только с M5 Max).
  // Своего поля в редакторе у неё нет, но в текст она обязана попасть: иначе форма
  // стёрла бы её при первом же сохранении товара.
  //
  // На каждое значение пишется своя пара, а не список через запятую: у Apple
  // запятая стоит внутри самой метки чипа («M5 Max, 32 ядра GPU»), и список из
  // таких меток при обратном разборе распадался на несуществующие значения.
  const choiceTail = (x) => {
    if (!x || !x.forChoice) return '';
    const pairs = [];
    for (const group of Object.keys(x.forChoice)) {
      for (const value of (x.forChoice[group] || [])) pairs.push(group + '=' + value);
    }
    return pairs.length ? ' | ?' + pairs.join(';') : '';
  };
  // «@метка» — значение продаётся только с этими конфигурациями. По хвосту на
  // метку, по той же причине: запятая может оказаться внутри самой метки.
  const storageTail = (v) => (v.forStorage || []).map(label => ' | @' + label).join('');
  const storagesText = draft ? String(draft.storages || '') : (p.storages || []).map(s => `${s.label}|${s.add || 0}${s.inStock === false ? '|нет' : ''}${choiceTail(s)}`).join('\n');
  // Ремешки: «# Коллекция | размеры» и строки «- Цвет | #hex | доплата | нет»
  const bandsText = draft ? String(draft.bands || '') : (p.bands || []).map(g =>
    `# ${g.name} | ${(g.sizes || []).map(x => x.label).join(', ')}\n`
    + (g.options || []).map(o => `- ${o.name} | ${o.hex || '#cccccc'} | ${o.add || 0}${o.inStock === false ? ' | нет' : ''}${o.forColor ? ' | @' + o.forColor : ''}`).join('\n')
  ).join('\n');
  // Доп. характеристики: «# Группа | подсказка» и строки «- Значение | доплата | нет | @конфигурации»
  const optionsText = draft ? String(draft.options || '') : (p.options || []).map(g =>
    `# ${g.name}${g.hint ? ' | ' + g.hint : ' | '}\n`
    + (g.values || []).map(v => `- ${v.label} | ${v.add || 0}${v.inStock === false ? ' | нет' : ''}${storageTail(v)}${choiceTail(v)}`).join('\n')
  ).join('\n');
  const cats = db.categories();
  const ic = p.imageColors || {};
  // Фото привязывается к цвету корпуса И к вариации ремешка независимо: один и тот
  // же ремешок на натуральном и на чёрном титане выглядит по-разному, поэтому у
  // снимка две привязки, а не одна на выбор. Списка два — по одному на каждую.
  const ib = p.imageBands || {};
  // Привязка считается живой, только если такой цвет/вариация ещё существуют:
  // иначе после удаления цвета его фото пропадали из панели совсем.
  const knownColors = new Set((p.colors || []).map(c => c.name));
  const knownBands = new Set((p.bands || []).flatMap(g => (g.options || []).map(o => `${g.name}|${o.name}`)));
  const bandOf = src => (knownBands.has(ib[src]) ? ib[src] : '');
  const caseOf = src => (knownColors.has(ic[src]) ? ic[src] : '');
  const colorOpts = cur => `<option value="">— общее —</option>`
    + (p.colors || []).map(c => `<option value="${esc(c.name)}" ${cur === c.name ? 'selected' : ''}>${esc(c.name)}</option>`).join('');
  const bandOpts = cur => `<option value="">— без ремешка —</option>`
    + (p.bands || []).map(g => (g.options || []).map(o => {
        const key = `${g.name}|${o.name}`;
        return `<option value="${esc(key)}" ${cur === key ? 'selected' : ''}>${esc(g.name + ' · ' + o.name)}</option>`;
      }).join('')).join('');
  const mainSrc = (p.images || [])[0] || '';
  const chip = src => `<div class="img-chip${src === mainSrc ? ' is-main' : ''}" data-src="${esc(src)}" draggable="true"${caseOf(src) ? ` data-case="${esc(caseOf(src))}"` : ''}>
    <div class="img-chip-media"${caseOf(src) ? ` data-case="${esc(caseOf(src))}"` : ''}><img src="/uploads/${esc(src)}" alt="">
      <span class="img-main-badge">Главное</span>
      <button type="button" class="img-main" title="Сделать главным фото" aria-label="Сделать главным фото">★</button>
      <button type="button" class="img-del" title="Удалить фото" aria-label="Удалить фото">&times;</button></div>
    <div class="img-chip-controls">
      <button type="button" class="img-move img-move-prev" title="Переместить раньше" aria-label="Переместить фото раньше">←</button>
      <select class="img-color" name="imgcolor:${esc(src)}" aria-label="Цвет корпуса на фото">${colorOpts(caseOf(src))}</select>
      ${(p.bands || []).length ? `<select class="img-band" name="imgband:${esc(src)}" aria-label="Ремешок на фото">${bandOpts(bandOf(src))}</select>` : ''}
      <button type="button" class="img-move img-move-next" title="Переместить позже" aria-label="Переместить фото позже">→</button>
    </div>
  </div>`;
  // Фото сгруппированы: сначала «общие», затем по каждому цвету товара
  const groupHead = (name, hex) => name
    ? `<div class="img-group-head"><span class="swatch" style="background:${R.cssColor(hex, '#cccccc')}"></span>${esc(name)}<span class="img-group-count"></span></div>`
    : `<div class="img-group-head"><span class="swatch swatch-any"></span>Общие фото<span class="img-group-count"></span></div>`;
  const groupFor = (name, hex) => {
    // Фото, привязанное к ремешку, живёт в своей группе и не должно попадать
    // ни в «Общие», ни в группу цвета — иначе один снимок виден дважды.
    const list = (p.images || []).filter(src => !bandOf(src) && caseOf(src) === name);
    return `<div class="img-group" data-color="${esc(name)}"${list.length ? '' : ' hidden'}>
      ${groupHead(name, hex)}
      <div class="img-chips">${list.map(chip).join('')}</div>
    </div>`;
  };
  // Группы снимков: общие → по цвету корпуса → «ремешок на этом корпусе».
  // Последние раздельные, потому что один ремешок на разных корпусах выглядит
  // по-разному и фото у них свои.
  const groupForBand = (g, o, caseName, caseHex) => {
    const key = `${g.name}|${o.name}`;
    const list = (p.images || []).filter(src => bandOf(src) === key && caseOf(src) === caseName);
    const title = esc(g.name + ' · ' + o.name) + (caseName ? ` <span class="img-group-case">${esc(caseName)}</span>` : '');
    return `<div class="img-group" data-band="${esc(key)}" data-case="${esc(caseName)}"${list.length ? '' : ' hidden'}>
      <div class="img-group-head"><span class="swatch" style="background:${R.cssColor(o.hex, '#cccccc')}"></span>${title}<span class="img-group-count"></span></div>
      <div class="img-chips">${list.map(chip).join('')}</div>
    </div>`;
  };
  const caseList = (p.colors || []).length ? p.colors : [{ name: '', hex: '' }];
  const bandGroups = (p.bands || []).map(g => (g.options || []).map(o =>
    [''].concat(caseList.map(c => c.name)).filter((v, i, a) => a.indexOf(v) === i)
      .map(caseName => groupForBand(g, o, caseName)).join('')
  ).join('')).join('');
  const existing = [groupFor('', '')]
    .concat((p.colors || []).map(c => groupFor(c.name, c.hex)))
    .concat(bandGroups)
    .join('');

  const uploadField = (label, attrs) => `<div class="field photo-upload-field">
    <label>${label}</label>
    <label class="photo-upload-box">
      <input type="file" accept="image/*" multiple ${attrs || ''}>
      <span class="photo-upload-icon" aria-hidden="true">＋</span>
      <span class="photo-upload-text"><b>Выбрать фотографии</b><span class="photo-upload-selection"></span></span>
    </label>
    <div class="photo-upload-progress" hidden><div class="photo-progress-track"><span></span></div><span class="photo-upload-status" aria-live="polite"></span><button type="button" class="photo-upload-cancel" data-upload-cancel hidden>Остановить</button></div>
    <div class="photo-queue"></div>
  </div>`;
  const colorUploads = isEdit
    ? `<div class="field" id="color-uploads" style="display:none">
    <label>Фото для конкретного цвета</label>
    <div class="cu-grid"></div>
  </div>
  <details class="field upload-fold" id="band-uploads" style="display:none">
    <summary><span>Фото для конкретного ремешка</span><span class="muted upload-fold-note">нажмите, чтобы раскрыть</span></summary>
    <p class="field-hint">Снимок попадёт только в эту вариацию: покупатель увидит его, когда выберет этот ремешок.</p>
    <div class="cu-grid"></div>
  </details>`
    : '';
  // Поле с подсказкой и текстом ошибки под ним
  const field = (name, label, control, hint) => `<div class="field${errFor(name) ? ' has-error' : ''}">
    <label>${label}</label>${control}
    ${errFor(name) ? `<p class="field-err">${esc(errFor(name))}</p>` : (hint ? `<p class="field-hint">${hint}</p>` : '')}
  </div>`;
  const section = (title, hint, inner) => `<section class="form-section">
    <div class="form-section-head"><h2>${title}</h2>${hint ? `<p class="muted small">${hint}</p>` : ''}</div>
    ${inner}
  </section>`;

  const body = `
  <form class="a-form product-form" data-product-form method="post" action="${isEdit ? '/admin/products/' + encodeURIComponent(product.id) : '/admin/products'}" enctype="multipart/form-data">
    ${errors.length ? `<div class="form-alert" role="alert"><b>Не сохранено.</b> ${errors.length === 1 ? 'Поправьте одно поле:' : 'Поправьте поля:'}
      <ul>${errors.map(e => `<li>${esc(e.text)}</li>`).join('')}</ul></div>` : ''}

    ${section('Основное', 'Название и категория видны покупателю в каталоге.', `
      <div class="a-form-grid">
        ${field('name', 'Название', `<input name="name" value="${esc(val('name', p.name))}" placeholder="iPhone 17 Pro" required autofocus>`)}
        ${field('category', 'Категория', `<input name="category" value="${esc(val('category', p.category))}" list="cats" placeholder="iPhone" required><datalist id="cats">${cats.map(c => `<option value="${esc(c)}">`).join('')}</datalist>`, 'Начните вводить — подскажет существующие')}
        ${(() => {
          const lvl = val('stockLevel', p.stockLevel || 'in') === 'few' ? 'few' : 'in';
          return field('stockLevel', 'Подпись наличия', `<select name="stockLevel">
            <option value="in"${lvl === 'in' ? ' selected' : ''}>В наличии</option>
            <option value="few"${lvl === 'few' ? ' selected' : ''}>Осталось несколько штук</option>
          </select>`, 'Строка с мигающей точкой на странице товара. У распроданного не показывается');
        })()}
      </div>
      <label class="switch-row"><input type="checkbox" name="inStock" ${checked('inStock', !!p.inStock) ? 'checked' : ''}><span>Товар в наличии</span></label>
      <label class="switch-row"><input type="checkbox" name="visible" ${checked('visible', p.visible !== false) ? 'checked' : ''}><span>Показывать на витрине</span></label>
      <p class="field-hint">Снятая галочка убирает карточку с витрины целиком — вместе с поиском, картой сайта и возможностью заказать. Это не «нет в наличии»: там карточка остаётся на месте с соответствующей подписью.</p>
    `)}

    ${section('Цена', 'Скидка задаётся процентом — одним на все конфигурации. Старая цена из него выводится и правке не подлежит.', `
      <div class="a-form-grid">
        ${field('price', 'Цена продажи', `<div class="price-field"><input name="price" type="number" min="1" step="1" value="${esc(val('price', p.price))}" placeholder="89990" required><span>₽</span></div>`, 'Столько платит покупатель за базовую сборку')}
        ${field('discountPercent', 'Скидка', `<div class="price-field"><input name="discountPercent" id="discount-pct" type="number" min="0" max="${D.MAX_PCT}" step="1" value="${esc(val('discountPercent', pct || ''))}" placeholder="0"><span>%</span></div>`, `0 — скидки нет. Больше ${D.MAX_PCT}% не бывает`)}
      </div>
      <p class="price-preview" id="price-preview" hidden></p>
      <label class="switch-row"><input type="checkbox" name="noPriceFloat" ${checked('noPriceFloat', p.noPriceFloat === true) ? 'checked' : ''}><span>Не менять цену автоматически</span></label>
      <p class="field-hint">Галочка выключает для этого товара плавающие цены — те, что настраиваются в «Настройках» и раз в период поднимают ценник на несколько процентов. Ставьте её там, где цена выторгована до рубля и играть с ней нельзя. Пока плавающие цены выключены целиком, галочка ни на что не влияет.</p>
      <p class="field-hint">Процент один на весь товар, поэтому у дорогой сборки выгода в рублях больше, а «−${esc(String(pct || 10))}%» на витрине везде одинаковые. Зачёркнутая цена считается как «цена ÷ (1 − процент)» и хранится не отдельным числом, а выводится каждый раз заново — иначе она разошлась бы с ценой при первой же её правке.</p>
    `)}

    ${section('Тексты', 'Характеристики — по строке на пункт, в формате «Параметр: значение». Иконка подбирается сама.', `
      ${field('shortDesc', 'Краткое описание', `<input name="shortDesc" value="${esc(val('shortDesc', p.shortDesc || ''))}" maxlength="200" placeholder="A19 Pro, три камеры 48 Мп, до 39 ч видео">`, 'Одна строка под названием на странице товара')}
      ${field('description', 'Полное описание', `<textarea name="description" rows="5">${esc(val('description', p.description || ''))}</textarea>`)}
      ${field('specs', 'Характеристики', `<textarea class="specs-input" name="specs" rows="12" placeholder="Экран: 6.9&quot; Super Retina XDR&#10;Чип: A19 Pro&#10;Память: 256 ГБ">${esc(val('specs', p.specs || ''))}</textarea>`)}
    `)}

    ${section('Варианты', 'Цвета и конфигурации, между которыми покупатель выбирает на странице товара. Снятая галочка «в наличии» оставляет вариант видимым, но недоступным.', `
      <div class="a-form-grid product-options-grid">
        <div class="field"><label>Цвета</label>
          <div class="color-editor" id="color-editor" data-edit="${isEdit ? '1' : '0'}"></div>
          <button type="button" class="btn btn-sm" id="color-add">+ Добавить цвет</button>
          <textarea name="colors" id="colors-raw" hidden>${esc(colorsText)}</textarea>
        </div>
        <div class="field"><label>Память / конфигурации</label>
          <div class="storage-editor" id="storage-editor"></div>
          <button type="button" class="btn btn-sm" id="storage-add">+ Добавить вариант</button>
          <textarea name="storages" id="storages-raw" hidden>${esc(storagesText)}</textarea>
          <p class="field-hint">Указывайте полную цену варианта — доплата посчитается сама.</p>
        </div>
      </div>
      <div class="field option-field">
        <label>Дополнительные характеристики <span class="muted">— покрытие дисплея, связь, комплект</span></label>
        <div class="option-editor" id="option-editor"></div>
        <button type="button" class="btn btn-sm" id="option-add">+ Добавить характеристику</button>
        <p class="field-hint">Цена — полная: сколько стоит товар с этим значением. «Только для конфигураций» ограничивает значение частью вариантов памяти — как нанотекстурное стекло у iPad Pro.</p>
        <textarea name="options" id="options-raw" hidden>${esc(optionsText)}</textarea>
      </div>
      <div class="field band-field">
        <label>Ремешки <span class="muted">— для часов: коллекция, её размеры и цвета</span></label>
        <div class="band-editor" id="band-editor"></div>
        <button type="button" class="btn btn-sm" id="band-add">+ Добавить коллекцию ремешков</button>
        <p class="field-hint">Цена — полная: сколько стоят часы с этим ремешком. Фото вариации выбирается в списке фотографий ниже.</p>
        <textarea name="bands" id="bands-raw" hidden>${esc(bandsText)}</textarea>
      </div>
    `)}

    ${section('Фотографии', isEdit ? 'Первое фото — главное. Перетаскиванием меняется порядок.' : 'Фото можно добавить и после создания товара.', isEdit ? `
      <div id="photo-manager" data-product="${esc(product.id)}" data-order="${esc(JSON.stringify(p.images || []))}">
        <div class="field" id="img-chips-wrap"${(p.images || []).length ? '' : ' hidden'}><label>Текущие фото</label>
          <div class="img-groups" id="img-chips">${existing}</div>
        </div>
        ${uploadField('Добавить общие фото', 'data-auto')}
        ${colorUploads}
      </div>` : `${uploadField('Фотографии товара', 'name="images"')}${colorUploads}`)}

    <div class="form-actions-bar">
      <a class="btn" href="/admin/products">Отмена</a>
      <button class="btn btn-primary" type="submit">${isEdit ? 'Сохранить' : 'Создать товар'}</button>
    </div>
  </form>
  <script src="/static/product-form.js?v=${R.assetV('product-form.js')}"></script>
  <!-- Перевод «полная цена ↔ доплата» общий на три редактора ниже, поэтому
       подключается раньше их: без него они не соберутся вовсе. -->
  <script src="/static/variant-price.js?v=${R.assetV('variant-price.js')}"></script>
  <script src="/static/color-editor.js?v=${R.assetV('color-editor.js')}"></script>
  <script src="/static/band-editor.js?v=${R.assetV('band-editor.js')}"></script>
  <script src="/static/option-editor.js?v=${R.assetV('option-editor.js')}"></script>
  <script src="/static/photo-manager.js?v=${R.assetV('photo-manager.js')}"></script>`;
  return layout(settings, { active: 'products', title: isEdit ? 'Товар' : 'Новый товар', counts: navCounts(settings, db), body, wide: true });
}

/* ---------- Отзывы ----------
   Раздел устроен в два уровня. На входе — только очередь модерации: то, что
   ждёт решения, и ничего больше, потому что это единственное здесь дело со
   сроком. Под ней — товары, у каждого свой список: разбирать семь тысяч отзывов
   одной лентой невозможно, а «что пишут про 17 Pro Max» — обычный вопрос.
   Вкладки и сортировка живут там, в ленте товара: на входе выбирать нечего. */

// Вкладки ленты товара. Порядок и подписи в одном месте: страница у них теперь
// одна, но расходиться со списком состояний отзыва они не должны.
const REVIEW_TABS = [['pending', 'На модерации'], ['approved', 'Опубликованные'], ['all', 'Все']];
const REVIEW_TAB_KEYS = REVIEW_TABS.map(([k]) => k);
function reviewTab(status, fallback) {
  return REVIEW_TAB_KEYS.includes(String(status)) ? String(status) : fallback;
}
function filterByStatus(list, status) {
  if (status === 'pending') return list.filter(r => r.status !== 'approved');
  if (status === 'approved') return list.filter(r => r.status === 'approved');
  return list;
}
function reviewTabs(current, href) {
  return `<div class="a-tabs">${REVIEW_TABS.map(([key, label]) =>
    `<a class="a-tab${current === key ? ' active' : ''}" href="${href(key)}">${label}</a>`).join('')}</div>`;
}
// Сортировка та же, что на витрине, и подписи берутся оттуда же (`REVIEW_SORTS`
// в lib/render.js): «Новые» в панели и «Новые» на витрине обязаны означать одно
// и то же, а разъехавшиеся подписи — первый признак двух разных реализаций.
function reviewSorts(current, href) {
  return `<div class="a-sorts"><span class="muted small">Сортировка:</span>${R.REVIEW_SORTS.map(([key, label]) =>
    `<a class="a-sort${current === key ? ' active' : ''}" href="${href(key)}">${label}</a>`).join('')}</div>`;
}
/* Отбор по вложениям: с видео, только с фото, без медиа.
 *
 * Это не сортировка, а именно отбор, и вопрос он решает свой: вкладка отвечает
 * «что показываем» (состояние), сортировка — «в каком порядке», а этот ряд —
 * «что внутри». Разбирать ленту иначе нельзя: ролики стоят по своим местам в
 * раскладке (lib/review-dates.js), и найти их среди тысячи отзывов, листая
 * страницы по восемь, невозможно.
 *
 * Наборы НЕ пересекаются — это разбиение, а не три галочки: отзыв с видео и
 * фотографиями лежит в «С видео», иначе он попадался бы дважды и счётчики не
 * сходились бы с длиной списка. Отсюда и подпись «Только фото».
 */
const REVIEW_MEDIA = [['all', 'Все'], ['video', 'С видео'], ['photo', 'Только фото'], ['none', 'Без медиа']];
const REVIEW_MEDIA_KEYS = REVIEW_MEDIA.map(([k]) => k);
function reviewMedia(value, fallback) {
  return REVIEW_MEDIA_KEYS.includes(String(value)) ? String(value) : (fallback || 'all');
}
function hasVideo(rv) { return !!(rv && rv.videos && rv.videos.length); }
function hasPhoto(rv) { return !!(rv && rv.photos && rv.photos.length); }
function filterByMedia(list, media) {
  if (media === 'video') return list.filter(hasVideo);
  if (media === 'photo') return list.filter(rv => !hasVideo(rv) && hasPhoto(rv));
  if (media === 'none') return list.filter(rv => !hasVideo(rv) && !hasPhoto(rv));
  return list;
}
// Счётчик у каждого набора: без него «С видео» приходится открывать, чтобы
// узнать, есть ли там хоть что-то, — а роликов у товара полтора десятка на
// тысячу отзывов.
function reviewMediaTabs(current, list, href) {
  const count = key => filterByMedia(list, key).length;
  return `<div class="a-sorts a-media"><span class="muted small">Вложения:</span>${REVIEW_MEDIA.map(([key, label]) =>
    `<a class="a-sort${current === key ? ' active' : ''}" href="${href(key)}">${esc(label)}<i>${count(key)}</i></a>`).join('')}</div>`;
}

/* Панель списка: вкладки слева, сортировка и отбор по вложениям справа.
 *
 * На телефоне три ряда кнопок занимали 150 px до первого отзыва, и последний из
 * них («Вложения») всё равно уезжал за край экрана. Поэтому ниже 800 px
 * сортировка с вложениями прячутся под кнопку со значком сортировки, а
 * свёрнутая кнопка называет выбранное («Новые · Все») — иначе, чтобы узнать, в
 * каком порядке идёт лента, её пришлось бы раскрывать.
 *
 * Вкладки состояния при этом остаются на виду всегда: «что показываем» —
 * первый вопрос к списку, и прятать его за нажатием нельзя.
 *
 * Скрытый чекбокс и подпись-кнопка, а не <details>: раскрытие нужно ТОЛЬКО на
 * телефоне, а на десктопе оба ряда обязаны стоять открыто. У <details>
 * содержимое прячет браузер, и «показать при закрытом» надёжно из CSS не
 * задаётся; с чекбоксом видимостью распоряжается только таблица стилей —
 * `.a-filters{display:contents}` на десктопе возвращает ряды в шапку ровно
 * туда, где они и были. Тот же приём уже стоит у режима правки списка заказов
 * и у поиска в шапке витрины.
 */
const SORT_ICO = '<svg class="a-filters-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'
  + '<path d="M4 6.6h10M4 12h7M4 17.4h4"/><path d="M17.7 7.6v11.8M17.7 19.4l-2.7-2.8M17.7 19.4l2.7-2.8"/></svg>';
function reviewToolbar(tabs, sorts, media, now) {
  return `<div class="a-toolbar">${tabs}`
    + `<input type="checkbox" id="a-filters-open" class="a-filters-switch">`
    + `<label class="a-filters-btn" for="a-filters-open">${SORT_ICO}`
    + `<span class="a-filters-cap">Сортировка</span>`
    + (now ? `<span class="a-filters-now">${esc(now)}</span>` : '')
    + `<span class="a-filters-arrow" aria-hidden="true"></span></label>`
    + `<div class="a-filters">${sorts || ''}${media || ''}</div></div>`;
}

// Куда вернуться после действия над строкой. Без этого админ, разбирающий
// очередь на 12-й странице, после каждого «Одобрить» оказывался в начале списка,
// а «Удалить» вдобавок сбрасывало вкладку. Те же три значения уходят и в адрес
// формы правки — возврат из неё обязан вести туда же, откуда пришли.
//
// Вкладка называется `tab`, а НЕ `status`: в форме правки есть свой `status` —
// состояние самого отзыва, — и два поля с одним именем ушли бы на сервер массивом.
// Отзыв тогда сохранялся бы «на модерации» независимо от выбранного.
function backFields(back) {
  return `<input type="hidden" name="page" value="${Math.max(1, Math.floor(Number(back.page)) || 1)}">`
    + `<input type="hidden" name="tab" value="${esc(back.status || '')}">`
    + `<input type="hidden" name="sort" value="${esc(back.sort || '')}">`
    + (back.media ? `<input type="hidden" name="media" value="${esc(back.media)}">` : '')
    + (back.product ? `<input type="hidden" name="product" value="${esc(back.product)}">` : '');
}
function backQuery(back) {
  const params = [
    `tab=${encodeURIComponent(back.status || '')}`,
    `sort=${encodeURIComponent(back.sort || '')}`,
    `page=${Math.max(1, Math.floor(Number(back.page)) || 1)}`
  ];
  // Отбор по вложениям возвращается вместе с остальным: разбирая ленту роликов,
  // после каждого действия оказываться снова во «Всех» — то же, что терять место.
  if (back.media && back.media !== 'all') params.push('media=' + encodeURIComponent(back.media));
  if (back.product) params.push('product=' + encodeURIComponent(back.product));
  return params.join('&amp;');
}

// Вложения отзыва одним списком: сначала ролики, потом снимки — тот же порядок,
// что и на витрине, чтобы номер кадра в просмотрщике совпадал с увиденным.
function reviewFileList(rv) {
  return (rv.videos || []).filter(Boolean).map(f => ({ f, video: true }))
    .concat((rv.photos || []).filter(Boolean).map(f => ({ f, video: false })));
}
// Что показать в квадратике: лёгкое превью, а у ролика — кадр из него. Полный
// файл грузится только в просмотрщике: в списке вложений до полусотни, и
// полноразмерные фото весом по четверти мегабайта сделали бы страницу панели
// тяжелее всей витрины. Превью нет (старая запись, не было ImageMagick) — у
// фото показываем сам снимок, у ролика подпись.
function thumbInner(rv, it, size) {
  const src = (rv.previews || {})[it.f] || (it.video ? (rv.poster || '') : it.f);
  return src
    ? `<img src="/uploads/${esc(src)}" alt="" loading="lazy" decoding="async" width="${size}" height="${size}">`
    : '<span class="rv-thumb-cap">MP4</span>';
}

// Вложения строкой квадратиков. Ссылки настоящие: без скрипта клик открывает
// файл, как раньше. Со скриптом открывается тот же просмотрщик, что и на
// витрине (public/media-lightbox.js) — по `data-media` у группы и `data-kind`
// у вложения.
const THUMB_LIMIT = 6;
function reviewThumbs(rv) {
  const items = reviewFileList(rv);
  if (!items.length) return '';
  const shown = items.slice(0, THUMB_LIMIT);
  const rest = items.length - shown.length;
  const link = (it, opts) => `<a class="rv-thumb${opts.cls || ''}" href="/uploads/${esc(it.f)}"`
    + ` data-kind="${it.video ? 'video' : 'photo'}" target="_blank" rel="noopener"`
    + `${opts.hidden ? ' hidden' : ''} aria-label="${esc(opts.label)}">${opts.inner || ''}</a>`;
  const tiles = shown.map(it => link(it, {
    cls: it.video ? ' is-video' : '', inner: thumbInner(rv, it, 80),
    label: it.video ? 'Видео к отзыву' : 'Фото к отзыву'
  })).join('');
  // «+N» — это уже седьмое вложение, а не отдельная кнопка: клик по нему
  // открывает просмотр ровно с него. Остальные идут следом ссылками БЕЗ
  // картинок и скрытыми: галерея обязана содержать все вложения, иначе с
  // седьмого кадра листать было бы некуда, — но грузить полсотни превью ради
  // строки списка незачем.
  const more = rest > 0
    ? link(items[THUMB_LIMIT], { cls: ' rv-thumb-more', inner: `+${rest}`, label: `Ещё вложений: ${rest}` })
      + items.slice(THUMB_LIMIT + 1).map(it => link(it, { hidden: true, label: 'Вложение к отзыву' })).join('')
    : '';
  return `<div class="rv-thumbs" data-media>${tiles}${more}</div>`;
}

/* Ответ магазина прямо в строке списка.
 *
 * Отвечают там же, где разбирают очередь: уводить ради двух строк текста в
 * форму правки, а оттуда возвращаться обратно — это три перехода на один ответ.
 * Форма целиком на <details>, ни строчки скрипта: свёрнутая строка держит
 * список компактным, а работает она и там, где скрипты панели не загрузились.
 *
 * Свёрнутый вид сам показывает состояние: у отвеченного отзыва в подписи стоит
 * начало ответа, у остальных — «Ответить». Открывать строку, чтобы узнать, есть
 * ли ответ, не нужно.
 *
 * Удаление ответа — вторая кнопка отправки в той же форме (`drop`): браузер
 * шлёт имя только нажатой кнопки, поэтому второй формы (а её пришлось бы класть
 * вне этой — вложенных форм не бывает) не потребовалось.
 */
const REPLY_GLYPH = '<path d="M20.3 4.6H3.7v11.9h4.1v3.9l4.6-3.9h7.9z"/>';
function replyIcon(cls) {
  return `<svg class="${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"`
    + ` stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${REPLY_GLYPH}</svg>`;
}
function reviewReplyBox(rv, back) {
  const text = String(((rv.reply || {}).text) || '').trim();
  const answered = !!text;
  return `<details class="rv-reply${answered ? ' is-answered' : ''}">
      <summary class="rv-reply-sum">
        ${replyIcon('rv-reply-ico')}
        ${answered
          ? `<span class="rv-reply-peek"><b>Ответ магазина</b><i class="rv-reply-cut">: ${esc(text)}</i></span>`
          : '<span class="rv-reply-peek rv-reply-none">Ответа магазина пока нет</span>'}
        <span class="rv-reply-more">${answered ? 'Изменить ответ' : 'Ответить'}</span>
      </summary>
      <form class="rv-reply-form" method="post" action="/admin/reviews/${esc(rv.id)}/reply">
        ${backFields(back)}
        <div class="field"><label class="sr-only" for="reply-${esc(rv.id)}">Ответ магазина</label>
          <textarea id="reply-${esc(rv.id)}" name="reply" rows="3" maxlength="2000" placeholder="Спасибо за отзыв! Рады, что всё подошло.">${esc(text)}</textarea></div>
        <div class="rv-reply-acts">
          <button class="btn btn-sm btn-primary" type="submit">${answered ? 'Сохранить ответ' : 'Опубликовать ответ'}</button>
          ${answered ? `<button class="btn btn-sm btn-danger" type="submit" name="drop" value="1">Удалить ответ</button>` : ''}
          <span class="rv-reply-note muted small">Ответ виден всем на странице товара.</span>
        </div>
      </form>
    </details>`;
}

// Одна строка отзыва. Общая для очереди модерации и для списка товара: подписи
// и набор кнопок в двух местах разъехались бы на первой же правке.
function reviewRow(rv, product, back, opts) {
  opts = opts || {};
  const pending = rv.status !== 'approved';
  const fields = backFields(back);
  // У опубликованного — «Снять с витрины»: он возвращается в очередь модерации.
  // Убрать неудачный отзыв со страницы товара нужно по-прежнему, а удаление для
  // этого слишком грубо — отзыв покупателя восстановить неоткуда.
  const act = pending
    ? `<form method="post" action="/admin/reviews/${esc(rv.id)}/approve">${fields}<button class="btn btn-sm btn-primary">Одобрить</button></form>`
    : `<form method="post" action="/admin/reviews/${esc(rv.id)}/hide">${fields}<button class="btn btn-sm">Снять с витрины</button></form>`;
  const where = opts.showProduct
    ? (product
      ? `<a class="rv-where" href="/admin/reviews/product/${encodeURIComponent(product.id)}">${esc(product.name)}</a>`
      : '<span class="rv-where rv-where-gone">товар удалён</span>')
    : '';
  // Мелочи под текстом: что купил и чем везли. Пусто — строки нет вовсе, а не
  // пустая полоска отступа.
  const bits = [];
  if (rv.config) bits.push(esc(rv.config));
  const carrier = DELIVERY.nameOf(rv.delivery);
  if (carrier) bits.push('доставка ' + esc(carrier));
  // Откуда отзыв — только про привезённые. У демо-набора это поле стоит у
  // каждой записи, и строка «demo-generated-v1» повторялась бы во всей ленте.
  if (rv.source && !/^demo/i.test(rv.source)) bits.push(esc(rv.source));
  return `<article class="rv-row${pending ? ' is-pending' : ''}" id="rv-${esc(rv.id)}">
    <div class="rv-main">
      <div class="rv-head">
        ${R.stars(rv.rating)}
        <b class="rv-who">${esc(rv.author)}</b>
        <span class="rv-when muted">${R.formatDate(rv.createdAt)}</span>
        ${pending ? '<span class="rv-tag">На модерации</span>' : ''}
        ${where}
      </div>
      ${rv.text ? `<p class="rv-text">${esc(rv.text)}</p>` : '<p class="rv-text rv-text-none">без текста</p>'}
      ${bits.length ? `<div class="rv-bits muted small">${bits.join(' · ')}</div>` : ''}
      ${reviewThumbs(rv)}
    </div>
    <div class="rv-acts">
      <a class="btn btn-sm" href="/admin/reviews/${esc(rv.id)}/edit?${backQuery(back)}">Изменить</a>
      ${act}
      <form method="post" action="/admin/reviews/${esc(rv.id)}/delete" data-confirm="Удалить отзыв «${esc(rv.author)}»? Вместе с ним удалятся его фото и видео.">${fields}<button class="btn btn-sm btn-danger">Удалить</button></form>
    </div>
    ${reviewReplyBox(rv, back)}
  </article>`;
}

function reviewRows(slice, products, back, opts) {
  if (!slice.items.length) return `<p class="rv-empty muted">${esc((opts && opts.empty) || 'Отзывов нет.')}</p>`;
  return `<div class="rv-list">${slice.items.map(rv => reviewRow(rv, products[rv.productId], back, opts)).join('')}</div>`;
}

// Плитки товаров: имя, число отзывов, оценка и счётчик очереди. Открывается
// список отзывов именно этого товара.
function reviewProducts(db) {
  const stats = db.reviewStats();
  const cards = db.getProducts().map(p => {
    const s = stats.get(p.id) || { total: 0, pending: 0, avg: 0 };
    const line = s.total
      ? `${R.reviewCountText(s.total)}${s.avg ? ` · ★ ${s.avg}` : ''}`
      : 'отзывов нет';
    return `<a class="rv-prod${s.pending ? ' has-wait' : ''}" href="/admin/reviews/product/${encodeURIComponent(p.id)}">
      <span class="rv-prod-pic">${R.imageMarkup(p, 0)}</span>
      <span class="rv-prod-body"><b>${esc(p.name)}</b><span class="muted small">${line}</span></span>
      ${s.pending ? `<span class="rv-prod-wait" title="Ждут модерации: ${s.pending}">${s.pending}</span>` : ''}
    </a>`;
  }).join('');
  return `<div class="a-panel"><div class="a-panel-head"><h2>Отзывы по товарам</h2><span class="rv-hint muted small">откройте товар, чтобы разобрать его ленту</span></div>
    <div class="rv-products">${cards || '<p class="muted">Каталог пуст.</p>'}</div></div>`;
}

/* Вход в раздел — ТОЛЬКО очередь модерации, без вкладок, сортировки и подсказок.
 *
 * Одобрить или отклонить — единственное дело здесь, у которого есть срок, и
 * выбирать в нём нечего: очередь идёт свежими сверху. Вкладки «Опубликованные»
 * и «Все» на входе отвечали на вопрос, который на этой странице не задают:
 * лента конкретного товара открывается плиткой ниже, и вкладки с сортировкой
 * есть там. Абзац-подсказка объяснял ровно то, что и так видно по подсветке
 * строк.
 *
 * Разобранная очередь блока не оставляет вовсе: пустая карточка со словами
 * «всё разобрано» занимала первый экран ради сообщения «делать нечего».
 * Разобрал — сразу отзывы по товарам.
 */
function reviewsList(settings, db, flash, page) {
  const products = {}; db.getProducts().forEach(p => products[p.id] = p);
  // Страницами: весь список разом — это мегабайты разметки и секунды блокировки
  // единственного потока, то есть замершая витрина для всех посетителей.
  const waiting = R.sortReviews(filterByStatus(db.getReviews(), 'pending'), 'new');
  const slice = R.adminSlice(waiting, page);
  // Вкладку и сортировку формы действий несут прежние: возврат после «Одобрить»
  // обязан вести в очередь, а не в общую ленту.
  const back = { status: 'pending', page: slice.page, sort: 'new' };
  const pager = R.adminPager(slice, n => `/admin/reviews?page=${n}`);
  const queue = slice.total
    ? `<div class="a-panel a-panel-list">${reviewRows(slice, products, back, { showProduct: true })}${pager}</div>`
    : '';
  return layout(settings, { active: 'reviews', title: 'Отзывы', counts: navCounts(settings, db), live: 'reviews',
    actions: `<a class="btn btn-primary" href="/admin/reviews/new">+ Добавить отзыв</a>`,
    flash, body: queue + reviewProducts(db) });
}

// Отзывы одного товара. Открывается с плитки товара и из строки общей ленты.
function productReviews(settings, db, product, statusFilter, flash, page, sort, media) {
  const products = { [product.id]: product };
  // Здесь по умолчанию видно всё: товар открывают, чтобы посмотреть его ленту
  // целиком, а не только непрочитанное.
  const status = reviewTab(statusFilter, 'all');
  const mode = R.reviewSortMode(sort);
  const kind = reviewMedia(media, 'all');
  const all = db.reviewsForProduct(product.id, false);
  // Состояние отбирается первым, вложения — вторым: счётчики у вложений должны
  // считаться в пределах открытой вкладки, иначе «С видео 16» на вкладке
  // «На модерации» обещает то, чего там нет.
  const byStatus = filterByStatus(all, status);
  const slice = R.adminSlice(R.sortReviews(filterByMedia(byStatus, kind), mode), page);
  const back = { status, page: slice.page, product: product.id, sort: mode, media: kind };
  const root = `/admin/reviews/product/${encodeURIComponent(product.id)}`;
  const base = (k, m, v) => `${root}?status=${encodeURIComponent(k)}&amp;sort=${encodeURIComponent(m)}&amp;media=${encodeURIComponent(v)}`;
  const pager = R.adminPager(slice, n => `${base(status, mode, kind)}&amp;page=${n}`);
  const rating = db.ratingFor(product.id);
  const waiting = all.filter(r => r.status !== 'approved').length;
  const body = `<div class="a-panel rv-prod-head">
      <span class="rv-prod-pic">${R.imageMarkup(product, 0)}</span>
      <div class="rv-prod-info">
        <b>${esc(product.name)}</b>
        <span class="muted small">${all.length ? R.reviewCountText(all.length) : 'отзывов нет'}${rating.count ? ` · ★ ${rating.avg}` : ''}${waiting ? ` · ${waiting} ждёт модерации` : ''}</span>
      </div>
      <div class="rv-prod-links">
        <a class="btn btn-sm" href="/product/${encodeURIComponent(product.id)}" target="_blank" rel="noopener noreferrer">На витрине ↗</a>
        <a class="btn btn-sm" href="/admin/products/${encodeURIComponent(product.id)}/edit">Карточка товара</a>
      </div>
    </div>
    ${reviewToolbar(
      reviewTabs(status, k => base(k, mode, kind)),
      reviewSorts(mode, m => base(status, m, kind)),
      reviewMediaTabs(kind, byStatus, v => base(status, mode, v)),
      // Подписи берутся из тех же таблиц, что и сами кнопки: своя копия слов на
      // свёрнутой кнопке разошлась бы с рядом под ней на первой же правке.
      [(R.REVIEW_SORTS.find(([k]) => k === mode) || [])[1], (REVIEW_MEDIA.find(([k]) => k === kind) || [])[1]]
        .filter(Boolean).join(' · '))}
    <div class="a-panel a-panel-list">${reviewRows(slice, products, back, { empty: 'У этого товара таких отзывов нет.' })}${pager}</div>`;
  return layout(settings, { active: 'reviews', title: 'Отзывы товара', counts: navCounts(settings, db), live: 'reviews',
    actions: `<a class="btn" href="/admin/reviews">← Все отзывы</a><a class="btn btn-primary" href="/admin/reviews/new?productId=${encodeURIComponent(product.id)}">+ Добавить отзыв</a>`,
    flash, body });
}

/* Форма отзыва — одна на создание и на правку.
   Править можно всё, что видно покупателю: товар, автора, оценку, дату, текст,
   сборку, перевозчика, состояние и вложения. Двумя формами это разъехалось бы
   на первой же добавленной строке. */
function reviewForm(settings, db, review, opts) {
  opts = opts || {};
  /* Правка узнаётся по `id`, а не по самому наличию объекта.
   *
   * Разница нужна форме СОЗДАНИЯ: когда проверка отвергла введённое (негодная
   * дата), сюда возвращается тот же черновик — объект с полями, но без id, —
   * и форма обязана остаться формой создания: свой адрес отправки, своя
   * подпись кнопки, без «Удалить отзыв» у записи, которой ещё нет. Правило
   * «введённое возвращается вместе с ошибкой» тут работает так же, как в форме
   * товара и настроек. */
  const rv = review || {};
  const isEdit = !!rv.id;
  const back = opts.back || {};
  const productId = rv.productId || opts.productId || '';
  const options = db.getProducts().map(p =>
    `<option value="${esc(p.id)}"${p.id === productId ? ' selected' : ''}>${esc(p.name)}</option>`).join('');
  const rating = Math.min(5, Math.max(1, Number(rv.rating) || 5));
  const stars = [5, 4, 3, 2, 1].map(v => `<option value="${v}"${v === rating ? ' selected' : ''}>${'★'.repeat(v)} (${v})</option>`).join('');
  // Новый отзыв по умолчанию публикуется сразу; возвращённый черновик помнит
  // то, что выбрал админ, — иначе ошибка в дате сбрасывала бы ещё и состояние.
  const status = rv.status === 'pending' ? 'pending' : 'approved';
  const carriers = DELIVERY.METHODS.map(m =>
    `<option value="${esc(m.id)}"${rv.delivery === m.id ? ' selected' : ''}>${esc(m.name)}</option>`).join('');
  const action = isEdit ? `/admin/reviews/${esc(rv.id)}/edit` : '/admin/reviews/new';
  const cancel = isEdit ? `/admin/reviews${back.product ? '/product/' + encodeURIComponent(back.product) : ''}?${backQuery(back)}` : '/admin/reviews';

  // Вложения: снимок открывается тем же просмотрщиком, что и на витрине (клик
  // по плитке), а крестик в углу помечает вложение к удалению. Пометка — обычный
  // чекбокс с подписью-меткой, ни строчки скрипта: форма работает и там, где
  // скрипты панели не загрузились, и удаляется всё одним сохранением.
  //
  // Поэтому плитка НЕ обёрнута в <label> целиком, как была: тогда клик по
  // снимку и помечал бы его к удалению, и открывал просмотр разом.
  //
  // Новые ролики через панель не заливаются: multipart принимает только
  // картинки (проверка по сигнатуре файла в lib/server-lib.js).
  const files = reviewFileList(rv);
  const tiles = files.map((it, i) => {
    const id = `drop-${i}`;
    return `<div class="rv-file">
      <input type="checkbox" id="${id}" name="drop" value="${esc(it.f)}">
      <a class="rv-file-body" href="/uploads/${esc(it.f)}" data-kind="${it.video ? 'video' : 'photo'}" target="_blank" rel="noopener"
        aria-label="Открыть ${it.video ? 'видео' : 'фото'}">${thumbInner(rv, it, 120)}</a>
      <label class="rv-file-x" for="${id}" title="Отметить к удалению"><span aria-hidden="true">✕</span><span class="sr-only">Удалить ${it.video ? 'видео' : 'фото'}</span></label>
      <label class="rv-file-cap" for="${id}"><i class="rv-keep">${it.video ? 'видео' : 'фото'}</i><i class="rv-gone">удалить</i></label>
    </div>`;
  }).join('');

  const body = `<form class="a-form rv-form" method="post" action="${action}" enctype="multipart/form-data">
    ${isEdit ? backFields(back) : ''}
    <div class="rv-form-grid">
      <div class="rv-form-col">
        <div class="a-form-grid">
          <div class="field"><label>Товар *</label><select name="productId" required>${options}</select></div>
          <div class="field"><label>Состояние</label><select name="status">
            <option value="approved"${status === 'approved' ? ' selected' : ''}>Опубликован</option>
            <option value="pending"${status === 'pending' ? ' selected' : ''}>На модерации</option>
          </select></div>
          <div class="field"><label>Имя автора *</label><input name="author" value="${esc(rv.author || '')}" maxlength="60" required></div>
          <div class="field"><label>Оценка</label><select name="rating">${stars}</select></div>
          <div class="field"><label>Дата и время</label><input name="date" type="datetime-local" value="${dtLocal(rv.createdAt)}"></div>
          <div class="field"><label>Доставка</label><select name="delivery">
            <option value="">— не указана —</option>${carriers}
          </select></div>
        </div>
        <div class="field"><label>Сборка покупателя</label><input name="config" value="${esc(rv.config || '')}" maxlength="200" placeholder="Космический оранжевый · 256 ГБ · Только eSIM">
          <span class="field-note">Серая строка под оценкой: о какой именно сборке отзыв.</span></div>
        <div class="field"><label>Текст</label><textarea name="text" rows="8" maxlength="2000">${esc(rv.text || '')}</textarea></div>
        <div class="field"><label>Ответ магазина</label><textarea name="reply" rows="3" maxlength="2000" placeholder="Спасибо за отзыв! Рады, что всё подошло.">${esc(((rv.reply || {}).text) || '')}</textarea>
          <span class="field-note">Виден всем под отзывом на странице товара. Пустое поле — ответа нет; так он и удаляется.</span></div>
      </div>
      <div class="rv-form-col rv-form-media">
        <label class="rv-form-sub">Вложения${files.length ? ` <span class="muted small">${files.length}</span>` : ''}</label>
        ${files.length ? `<div class="rv-files" data-media>${tiles}</div><span class="field-note">Нажмите на вложение, чтобы посмотреть. Отмеченные крестиком удалятся при сохранении — вместе с самими файлами.</span>` : '<p class="muted small">Пока ничего не приложено.</p>'}
        <div class="field"><label>${files.length ? 'Добавить фото' : 'Фото'}</label><input type="file" name="photos" accept="image/*" multiple>
          <span class="field-note">Фото ужимаются автоматически. Видео через панель не загружается.</span></div>
        ${isEdit && rv.sourceDate ? `<p class="field-note">Отзыв привезён с площадки: показанная дата каждую ночь сдвигается вместе со всем набором, поэтому правка двигает и исходную дату.</p>` : ''}
      </div>
    </div>
    <div class="a-form-actions">
      <button class="btn btn-primary" type="submit">${isEdit ? 'Сохранить' : 'Опубликовать'}</button>
      <a class="btn" href="${cancel}">Отмена</a>
      ${isEdit ? `<span class="rv-form-del"><button class="btn btn-danger" type="submit" form="rv-del">Удалить отзыв</button></span>` : ''}
    </div>
  </form>
  ${isEdit ? `<form id="rv-del" method="post" action="/admin/reviews/${esc(rv.id)}/delete" data-confirm="Удалить отзыв «${esc(rv.author || '')}»? Вместе с ним удалятся его фото и видео.">${backFields(back)}</form>` : ''}`;
  return layout(settings, { active: 'reviews', title: isEdit ? 'Отзыв' : 'Добавить отзыв',
    counts: navCounts(settings, db), flash: opts.flash, flashType: opts.flashType, body, wide: true });
}

/* ---------- Промокоды ----------
 *
 * Отдельный раздел, а не карточка в настройках: коды заводят и выключают чаще,
 * чем правят реквизиты оператора, а главное — их СПИСОК, и списку нужна своя
 * страница. Всё, что раздел решает, живёт в `lib/promo.js`; здесь только показ.
 */

// Что этот код даёт покупателю — одной строкой. «Скидка товара» и «−20%» — два
// разных вида кода, и различить их надо с одного взгляда (см. lib/promo.js).
function promoCut(entry) {
  return entry.percent ? `−${entry.percent}%` : 'скидка товара';
}

/* Строка состояния всего раздела: не «какие галочки стоят», а ЧТО ВИДИТ
 * ПОКУПАТЕЛЬ. То же правило, что у плашки режима оплаты, и спрашивает она те же
 * функции, что и витрина, — своя копия правил разошлась бы с ценами. */
function promoSummary(settings) {
  if (!settings.promoOn) return ['', 'выключены — скидки товаров остаются, но поля промокода на оформлении нет'];
  const list = PROMO.codes(settings);
  if (!list.some(c => c.on)) return ['err', 'включены, но ни один код не работает — на оформлении показывать нечего'];
  const def = PROMO.defaultCode(settings);
  if (!def) {
    // Не ошибка, а осознанный режим: цены на витрине прежние, а код покупатель
    // вводит сам. Но выглядит это как забытая настройка, поэтому говорим прямо.
    return ['warn', 'ни один код не применяется сам — цены на витрине прежние, код покупатель вводит руками'];
  }
  return ['ok', `скидка витрины идёт по коду ${def.code} — он применён у каждого покупателя`];
}

function promoRow(entry, settings, used) {
  const isDefault = (PROMO.defaultCode(settings) || {}).code === entry.code;
  const orders = used || 0;
  return `<div class="promo-row${entry.on ? '' : ' is-off'}">
    <div class="promo-main">
      <div class="promo-head">
        <b class="promo-code">${esc(entry.code)}</b>
        <span class="promo-cut${entry.percent ? ' is-own' : ''}">${esc(promoCut(entry))}</span>
        ${isDefault ? '<span class="promo-tag">по умолчанию</span>' : ''}
        ${entry.on ? '' : '<span class="promo-tag is-off">выключен</span>'}
      </div>
      <div class="promo-sub">${entry.note ? esc(entry.note) + ' · ' : ''}${orders
    ? `${orders} ${R.pluralRu(orders, 'заказ', 'заказа', 'заказов')}` : 'заказов пока нет'}</div>
    </div>
    ${/* Правка под раскрытием, как ответ на отзыв: ни строчки скрипта, а
         свёрнутый список остаётся списком.

         КОД ПЕРЕИМЕНОВЫВАЕТСЯ ЗДЕСЬ ЖЕ, и это единственное поле раздела с
         последствиями за его пределами: скидка витрины идёт по коду «по
         умолчанию», и владелец вправе назвать её так, как ему нужно, не заводя
         второй записи и не перевыбирая её в селекте (настройка переезжает на
         новое имя сама). Какая запись правится, говорит скрытое поле со СТАРЫМ
         кодом: новое имя приходит рядом, отдельным полем.

         Уже оформленные заказы при этом не трогаются — они помнят свой код
         сами (`promoCode` в lib/db.js), и переписывать историю ради нового
         имени незачем. Поэтому счётчик заказов у переименованного кода
         начинается заново, и маршрут говорит об этом прямым текстом. */''}
    <details class="promo-edit">
      <summary class="btn btn-sm">Изменить</summary>
      <form method="post" action="/admin/promo/edit" class="promo-form">
        <input type="hidden" name="code" value="${esc(entry.code)}">
        <div class="promo-fields">
          <div class="field"><label for="pf-code-${esc(entry.code)}">Код</label>
            <input id="pf-code-${esc(entry.code)}" name="newCode" value="${esc(entry.code)}"
              maxlength="${PROMO.CODE_MAX}" autocapitalize="characters" autocomplete="off"></div>
          <div class="field"><label for="pf-pct-${esc(entry.code)}">Скидка, %</label>
            <input id="pf-pct-${esc(entry.code)}" name="percent" inputmode="numeric" value="${entry.percent || ''}"
              placeholder="скидка товара" maxlength="2"></div>
          <div class="field"><label for="pf-note-${esc(entry.code)}">Заметка</label>
            <input id="pf-note-${esc(entry.code)}" name="note" value="${esc(entry.note)}" maxlength="120"
              placeholder="для кого этот код"></div>
        </div>
        <label class="switch-row"><input type="checkbox" name="on"${entry.on ? ' checked' : ''}><span>Код работает</span></label>
        <div class="promo-form-acts">
          <button class="btn btn-primary btn-sm" type="submit">Сохранить</button>
          <button class="btn btn-danger btn-sm" type="submit" form="promo-del-${esc(entry.code)}">Удалить</button>
        </div>
      </form>
    </details>
  </div>
  ${/* Форма удаления — снаружи: вложенных форм в HTML не бывает. */''}
  <form id="promo-del-${esc(entry.code)}" method="post" action="/admin/promo/delete" class="sr-only"
    data-confirm="Удалить промокод ${esc(entry.code)}? Заказы, оформленные по нему, останутся как есть.">
    <input type="hidden" name="code" value="${esc(entry.code)}">
  </form>`;
}

function promoPage(settings, db, opts) {
  const o = opts || {};
  const list = PROMO.codes(settings);
  const [tone, note] = promoSummary(settings);
  /* Сколько заказов оформлено по каждому коду. Один проход по уже загруженному
   * списку заказов: своего счётчика у кода нет и заводить его незачем — заказ и
   * так помнит, каким кодом оформлен. */
  const used = new Map();
  for (const order of (typeof db.visibleOrders === 'function' ? db.visibleOrders() : [])) {
    if (!order || !order.promoCode || order.draft) continue;
    used.set(order.promoCode, (used.get(order.promoCode) || 0) + 1);
  }
  /* Кодом по умолчанию может быть только «скидка товара» — см. шапку
   * lib/promo.js. Поэтому в селекте их и нет: выбрать код, который потом молча
   * не применится, хуже, чем не показать его вовсе. */
  const canDefault = list.filter(c => c.on && !c.percent);
  const current = (PROMO.defaultCode(settings) || {}).code || '';
  const options = ['<option value="">Не применять — цены как в каталоге</option>']
    .concat(canDefault.map(c => `<option value="${esc(c.code)}"${c.code === current ? ' selected' : ''}>${esc(c.code)}</option>`))
    .join('');

  const body = `<div class="a-panel promo-top">
    <form method="post" action="/admin/promo">
      <div class="promo-state is-${esc(tone || 'idle')}"><i></i><b>Сейчас:</b> ${esc(note)}</div>
      <label class="switch-row"><input type="checkbox" name="promoOn"${settings.promoOn ? ' checked' : ''}><span>Промокоды работают</span></label>
      <div class="promo-fields">
        <div class="field"><label for="promo-default">Применён по умолчанию</label>
          <select id="promo-default" name="promoDefault">${options}</select></div>
      </div>
      <div class="a-form-actions"><button class="btn btn-primary" type="submit">Сохранить</button></div>
    </form>
  </div>

  <div class="a-panel a-panel-list">
    <div class="a-panel-head"><h2>Коды</h2><span class="muted small">${list.length} ${R.pluralRu(list.length, 'код', 'кода', 'кодов')}</span></div>
    ${list.length
    ? `<div class="promo-list">${list.map(c => promoRow(c, settings, used.get(c.code))).join('')}</div>`
    : '<p class="muted">Кодов пока нет. Заведите первый — он и станет скидкой витрины.</p>'}
  </div>

  <div class="a-panel">
    <div class="a-panel-head"><h2>Новый промокод</h2></div>
    <form method="post" action="/admin/promo/add" class="promo-form">
      <div class="promo-fields">
        <div class="field"><label for="promo-new-code">Код</label>
          <input id="promo-new-code" name="code" value="${esc(o.draftCode || '')}" maxlength="${PROMO.CODE_MAX}"
            placeholder="LETO20" autocapitalize="characters" autocomplete="off" required></div>
        <div class="field"><label for="promo-new-pct">Скидка, %</label>
          <input id="promo-new-pct" name="percent" inputmode="numeric" value="${esc(o.draftPercent || '')}"
            placeholder="скидка товара" maxlength="2"></div>
        <div class="field"><label for="promo-new-note">Заметка</label>
          <input id="promo-new-note" name="note" value="${esc(o.draftNote || '')}" maxlength="120"
            placeholder="для кого этот код"></div>
      </div>
      ${/* Единственная подсказка раздела, и она про правило, которого из полей
           не видно: пустой процент — это «скидка товара», та самая, что уже
           стоит в ценнике. Без неё поле «Скидка, %» читается как обязательное. */''}
      <p class="field-note">Пустая скидка — «скидка товара»: у каждого товара своя, та, что уже в ценнике.
        Такой код и применяется по умолчанию. Свой процент считается от цены без скидки.</p>
      <div class="a-form-actions"><button class="btn btn-primary" type="submit">Добавить</button></div>
    </form>
  </div>`;

  return layout(settings, {
    active: 'promo', title: 'Промокоды', counts: navCounts(settings, db),
    flash: o.flash, flashType: o.flashType, body
  });
}

/* ---------- Заказы ---------- */
// Страницами, как и отзывы: заказы не удаляются сами, поэтому список растёт без
// предела. Тысячи заявок разом — это мегабайты разметки и заметная пауза
// единственного потока, то есть замершая витрина для всех посетителей.
function ordersList(settings, db, flash, page, edit, filters) {
  /* Вкладок «Текущие / Удалённые» здесь НЕТ, и параметра `view` тоже.
   *
   * Архив снят вместе с ними: удаление заказа теперь окончательное. Он был
   * нужен, пока по уже выданному счёту кассы деньги могли прийти позже, — но
   * кассы выключены, платят по своим реквизитам, и ждать поздний callback не от
   * кого. Заявки, заархивированные ПРЕЖНЕЙ версией, так и лежат в файле
   * невидимыми: стирать их молча мы не вправе, а показывать уже удалённое было
   * бы неправдой. Чистятся они разово руками — `db.purgeArchivedOrders()`.
   *
   * Прежде вместо этого стояло `const archiveView = false;`, и полтора десятка
   * веток `archiveView ? … : …` ниже висели недостижимыми — вместе с
   * принимаемым, но никуда не ведущим `?view=archive`. */
  // Режим правки приезжает адресом и переживает действие: без этого он гас
  // после каждого удаления, и чистка десятка заявок означала десять лишних
  // нажатий «Изменить».
  const editing = !!edit;
  const viewOrders = db.visibleOrders();
  const f = filters || {};
  const q = String(f.q || '').trim().slice(0, 100);
  const payFilter = ['ok', 'wait', 'warn', 'off', 'none', 'draft'].includes(String(f.pay || ''))
    ? String(f.pay) : '';
  const query = q.toLocaleLowerCase('ru-RU');
  const digits = value => {
    let out = String(value || '').replace(/\D+/g, '');
    if (out.length === 11 && out[0] === '8') out = '7' + out.slice(1);
    return out;
  };
  const queryDigits = digits(q);
  const searchText = order => {
    const attempts = order && order.payment && Array.isArray(order.payment.attempts) && order.payment.attempts.length
      ? order.payment.attempts : (order && order.payment ? [order.payment] : []);
    const itemText = (Array.isArray(order.items) ? order.items : []).flatMap(item => [
      item && item.name, item && item.title, item && item.model,
      ...Object.values(item && item.options || {})
    ]);
    const paymentText = attempts.flatMap(a => [
      a && a.invoiceId, a && a.requisite, a && a.owner, a && a.bank,
      a && a.actualMethod, a && a.actualGateway
    ]);
    return [order.number, order.customerName, order.firstName, order.lastName,
      order.phone, order.contact, order.address, order.pickupAddress,
      ...itemText, ...paymentText].filter(Boolean).join(' ').toLocaleLowerCase('ru-RU');
  };
  const orders = viewOrders.filter(o => {
    if (payFilter === 'draft' && !o.draft) return false;
    if (payFilter && payFilter !== 'draft' && R.orderTone(o) !== payFilter) return false;
    if (query) {
      const haystack = searchText(o);
      if (!haystack.includes(query) && !(queryDigits.length >= 5 && digits(haystack).includes(queryDigits))) return false;
    }
    return true;
  });
  const slice = R.adminSlice(orders, page);
  /* Адрес списка: вкладка, страница и режим правки — всё в одном месте.
   *
   * Режим живёт в адресе, поэтому он переживает и переход на другую страницу, и
   * смену вкладки. Выключает его только «Готово»: чистят список подряд, и
   * возвращать человека в режим чтения на каждом шаге значит заставлять его
   * нажимать «Изменить» снова и снова.
   */
  const listHref = (n) => {
    const params = [];
    if (n > 1) params.push('page=' + n);
    if (editing) params.push('edit=1');
    if (q) params.push('q=' + encodeURIComponent(q));
    if (payFilter) params.push('pay=' + encodeURIComponent(payFilter));
    return '/admin/orders' + (params.length ? '?' + params.join('&') : '');
  };
  const pager = R.adminPager(slice, listHref);
  const rows = slice.items.map(o => {
    // Возврат на ту же страницу: после удаления на 7-й странице админ не должен
    // оказываться в начале списка.
    // Вместе со страницей и вкладкой уезжает и режим правки: все эти кнопки
    // показываются только в нём, значит и возвращаться надо в него же.
    const back = `<input type="hidden" name="page" value="${slice.page}">`
      + (editing ? '<input type="hidden" name="edit" value="1">' : '')
      + (q ? `<input type="hidden" name="q" value="${esc(q)}">` : '')
      + (payFilter ? `<input type="hidden" name="filterPay" value="${esc(payFilter)}">` : '');
    // Класс тона красит строку по состоянию оплаты: оплаченную от отменённой
    // надо отличать с одного взгляда, не вчитываясь в плашку статуса.
    /* Удаление окончательное, поэтому подтверждение говорит об этом прямо. У
     * заказа с выданным счётом добавляется вторая фраза: деньги по нему ещё
     * могут прийти, и привязать их будет уже не к чему. */
    const warning = 'Удалить заказ ' + R.orderNo(o.number) + ' навсегда? Вернуть его будет неоткуда.'
      + (o.payment ? ' По этому заказу выставлялся счёт — если деньги придут, связать их с ним будет нечем.' : '');
    const remove = `<form method="post" action="/admin/orders/${esc(o.id)}/delete" data-confirm="${esc(warning)}">${back}<button class="btn btn-sm btn-danger" aria-label="Удалить заказ" title="Удалить заказ навсегда">✕</button></form>`;
    const attempts = o.payment && Array.isArray(o.payment.attempts) && o.payment.attempts.length
      ? o.payment.attempts : (o.payment ? [o.payment] : []);
    const checkable = attempts.slice().reverse().find(a => a && a.invoiceId && a.status !== 'paid');
    const reconcile = checkable
      ? `<form class="o-reconcile" method="post" action="/admin/orders/${esc(o.id)}/reconcile">${back}`
        + `<input type="hidden" name="attemptId" value="${esc(checkable.id)}">`
        + '<button class="btn btn-sm" type="submit">Проверить оплату</button></form>' : '';
    const method = o.payment
      ? `<div class="o-payment-method">${R.orderPayMethod(o)}</div>` : '';
    /* Ручная отметка «оплачено». Перевод по своим реквизитам идёт мимо касс, и
     * подтвердить его может только человек, увидевший деньги в своём банке.
     *
     * Кнопки нет у заказов, которые ведёт касса: там состояние приходит от неё,
     * и рука здесь означала бы два источника правды об одних деньгах. Снять
     * отметку можно тем же нажатием — ошиблись строкой, вернули как было. */
    const settled = o.payment && (o.payment.status === 'paid' || o.payment.status === 'mismatch');
    const manual = !settled && (o.payMode === 'own' || !o.payment)
      ? `<form class="o-reconcile" method="post" action="/admin/orders/${esc(o.id)}/paid">${back}`
        + `<input type="hidden" name="paid" value="${o.manualPaid ? '0' : '1'}">`
        + `<button class="btn btn-sm" type="submit">${o.manualPaid ? 'Снять отметку оплаты' : 'Отметить оплаченным'}</button></form>` : '';
    /* Кнопки «Отменить оплату» здесь БОЛЬШЕ НЕТ, и это не потеря.
     *
     * Отменяет теперь сам покупатель — строкой внизу своей страницы оплаты
     * (`POST /pay/:id/cancel`): передумал он, и узнавать об этом по телефону,
     * чтобы нажать кнопку за него, незачем. Менеджеру для лишней заявки хватает
     * удаления: заказа не остаётся вовсе, и для покупателя он тоже закрыт.
     * Плашка «оплата отменена» при этом никуда не делась — и говорит, КТО
     * отменил (см. `payView` в lib/render.js). */
    return `<tr id="order-${esc(o.id)}" class="${R.orderRowClass(o)}">
      ${/* Ссылка на отправление стоит в столбце заказа, а не среди действий
           режима правки: маршрут смотрят и правят чаще, чем удаляют заявку, а
           состояние посылки — такая же часть «что с этим заказом», как оплата.
           Подпись у неё говорящая: «в пути», «задерживается» или «Создать
           отправление» — открывать страницу ради ответа не нужно. */''}
      <td class="o-num"><b>${esc(R.orderNo(o.number))}</b><span class="muted small">${R.formatDate(o.createdAt)}</span>${shipMark(o)}</td>
      <td class="o-client">${R.orderClient(o, { metricsBase: VISITOR_BASE, money: settings, chatBase: CHAT_TO_BASE })}</td>
      <td class="o-items">${R.orderItems(o)}</td>
      <td class="o-payment"><div class="o-payment-main"><div class="o-payment-state">${R.orderStatus(o)}</div>${method}</div>${reconcile}${manual}</td>
      <td class="o-sum"><b>${R.money(o.total, settings)}</b>${R.orderPromo(o, settings)}</td>
      <td class="o-act"><div class="o-acts">${remove}</div></td></tr>`;
  }).join('') || `<tr><td colspan="6" class="muted o-empty">${q || payFilter ? 'По вашему запросу заказов нет.' : 'Заказов пока нет.'}</td></tr>`;
  const payOptions = [
    ['', 'Любая оплата'], ['ok', 'Оплачено'], ['wait', 'Ждём оплату'],
    ['warn', 'Требует проверки'], ['off', 'Не оплачено'], ['none', 'Без оплаты'],
    ['draft', 'Способ не выбран']
  ];
  const filterBar = `<form class="o-filters" method="get" action="/admin/orders">
    ${editing ? '<input type="hidden" name="edit" value="1">' : ''}
    <label><span class="sr-only">Поиск заказа</span><input type="search" name="q" value="${esc(q)}" placeholder="Номер, имя, телефон или товар"></label>
    <label><span class="sr-only">Статус оплаты</span><select name="pay">${payOptions.map(([value, label]) => `<option value="${value}"${payFilter === value ? ' selected' : ''}>${label}</option>`).join('')}</select></label>
    <button class="btn btn-sm" type="submit">Найти</button>
    ${q || payFilter ? '<a class="link small" href="/admin/orders">Сбросить</a>' : ''}
  </form>`;
  /* Кнопки «Очистить архив» здесь тоже нет — вместе с самим архивом и вкладкой
   * «Удалённые». Она показывалась только на них, а описание её жило тут ещё
   * долго после того, как показывать её стало негде. Наследство прежней версии
   * чистится разово руками (`db.purgeArchivedOrders()`, см. lib/db.js).
   */
  const stats = R.orderStats(viewOrders, undefined,
    typeof db.getOrders === 'function' ? db.getOrders() : viewOrders);
  const providers = R.providerStatsBar(R.providerStats(viewOrders));
  const summaryDetails = `<details class="o-provider-details o-summary-details"><summary>Сводка по оплатам</summary>${R.orderStatsBar(stats, settings)}</details>`;
  const providerDetails = providers
    ? `<details class="o-provider-details"><summary>Статистика и диагностика касс</summary>${providers}</details>` : '';
  const resultNote = orders.length === viewOrders.length
    ? `${orders.length} ${R.pluralRu(orders.length, 'заказ', 'заказа', 'заказов')}`
    : `Найдено ${orders.length} из ${viewOrders.length}`;
  return layout(settings, { active: 'orders', title: 'Заказы', counts: navCounts(settings, db), flash, live: 'orders',
    // Рабочий сценарий идёт первым: поиск и список. Сводка не исчезла, но
    // свёрнута под таблицей — на этой странице разбирают конкретные заказы, а
    // общие показатели уже постоянно видны на «Обзоре». Счётчики здесь всё
    // равно считаются по всему списку, а не по показанной странице.
    body: filterBar
      + `<div class="a-panel o-list-panel">${R.editSwitch('orders-edit', {
        on: editing, title: 'Список заказов', note: resultNote
      })}<table class="a-table a-orders"><thead><tr><th>Заказ</th><th>Покупатель</th><th>Товары</th><th>Оплата</th><th class="o-sum">Итого</th><th class="o-act"><span class="sr-only">Удалить</span></th></tr></thead><tbody>${rows}</tbody></table>${pager}</div>`
      + summaryDetails
      // Диагностика касс нужна ещё реже, поэтому остаётся отдельной свёрткой.
      + providerDetails });
}

/* ===================== Отправление и его маршрут =====================
 *
 * Трек-номера у нас нет: посылку ведёт менеджер, поэтому и путь по стране
 * рисует он же. Задача этой страницы — чтобы «нарисовать» не означало «набить
 * полтора десятка строк руками»: маршрут собирается по трём полям (перевозчик,
 * города, срок), а дальше правится как обычная таблица.
 *
 * Правится ВСЁ и в любой момент: время каждого события, его название, город,
 * приписка и то место, где посылка встанет. Это и есть смысл раздела — заказ
 * живёт неделю, и за неделю меняется всё.
 */
const SHIP_BASE = '/admin/orders/';
function shipHref(order) { return SHIP_BASE + encodeURIComponent(order.id) + '/shipment'; }

/* Короткая подпись отправления для строки заказа.
 *
 * Состояние спрашиваем у `lib/tracking.js` — той же функции, что рисует ленту
 * покупателю: своя вторая формулировка разъехалась бы с тем, что он видит.
 */
function shipMark(order) {
  const ship = order && order.shipment;
  if (!ship || !Array.isArray(ship.steps) || !ship.steps.length) {
    /* Отправления ещё нет — и это ДЕЙСТВИЕ, а не подпись состояния, поэтому и
     * выглядит оно кнопкой: компактная пилюля со значком коробки. Прежде здесь
     * стояла та же пунктирная строка, что у состояний, и «Создать отправление»
     * в узком столбце переносилось на две строки — заявка росла на строку из-за
     * подписи, которую читают в последнюю очередь.
     *
     * На кнопке остаётся одно слово, полное действие уезжает в подсказку — тот
     * же приём, что у состояний ниже: «Отправлен в г. Петропавловск-Камчатский»
     * в этот столбец тоже не влезает. */
    return `<a class="o-ship-new" href="${shipHref(order)}" title="Создать отправление">`
      + `${SHIP_ICONS.parcelAdd}<span>Отправление</span></a>`;
  }
  const state = TRACK.view(ship);
  /* Скрытое отправление подписано отдельно и приглушённо: маршрут есть, но
   * покупатель его не видит, и это важнее того, где сейчас посылка. Иначе
   * менеджер читал бы «в пути» и был уверен, что человек это тоже видит. */
  if (!TRACK.shownToBuyer(ship)) {
    return `<a class="o-ship is-off" href="${shipHref(order)}" title="Маршрут собран, но скрыт от покупателя">скрыто</a>`;
  }
  const tone = state && state.delayed ? ' is-late' : (state && state.delivered ? ' is-done' : '');
  // В строке — два слова, полное событие уезжает в подсказку: столбец узкий, а
  // «Отправлен в г. Петропавловск-Камчатский» занимал в нём три строки.
  return `<a class="o-ship${tone}" href="${shipHref(order)}" title="${esc(TRACK.stateText(ship))}">${esc(TRACK.shortState(ship))}</a>`;
}

/* Значки страницы отправления. Холст 24×24 и волосяная обводка — тот же вес
 * штриха, что у значков разделов и глифов витрины. Кроме одного: у кнопки
 * копирования глиф ЗАЛИТЫЙ фоном кнопки — на синей плашке контур в 1.6 теряется.
 */
const SHIP_ICONS = {
  // Звено цепи — им обозначают ссылку везде, объяснять его не нужно.
  link: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10.4 13.6a3.6 3.6 0 0 0 5.1 0l2.9-2.9a3.6 3.6 0 1 0-5.1-5.1l-1.3 1.3"/><path d="M13.6 10.4a3.6 3.6 0 0 0-5.1 0l-2.9 2.9a3.6 3.6 0 1 0 5.1 5.1l1.3-1.3"/></svg>',
  // Два листа — привычный знак «скопировать».
  copy: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="11" height="11" rx="2.4"/><path d="M15 5.6A2.6 2.6 0 0 0 12.4 3H6.6A3.6 3.6 0 0 0 3 6.6v5.8A2.6 2.6 0 0 0 5.6 15"/></svg>',
  /* Посылка с плюсом — «создать отправление» в строке заказа. Коробка занимает
   * левый верх холста, плюс стоит в освободившемся углу: на 15 px они иначе
   * наложились бы друг на друга в кашу. */
  parcelAdd: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9.7 3.2 3.4 6.5v6.7l6.3 3.3 6.3-3.3V6.5z"/><path d="m3.4 6.5 6.3 3.3 6.3-3.3"/><path d="M9.7 9.8v7"/><path d="M18.2 15.2v5.4"/><path d="M15.5 17.9h5.4"/></svg>'
};

// Одна строка таблицы шагов. Пустая (без названия) при сохранении отбрасывается
// — так и удаляют лишний шаг, отдельной кнопки для этого не нужно.
//
// Ячейкам даны имена: на телефоне строка становится карточкой, а в сетке
// безымянные `<td>` не адресовать (то же правило, что у списка заказов).
function shipStepRow(step, i, held) {
  const s = step || {};
  return `<tr>
      <td class="s-when" data-l="Когда"><input type="datetime-local" name="stepAt" value="${esc(s.at ? dtLocal(s.at) : '')}"></td>
      <td class="s-title" data-l="Событие"><input name="stepTitle" value="${esc(s.title || '')}" maxlength="120" placeholder="например, Принят на склад"></td>
      <td class="s-place" data-l="Город"><input name="stepPlace" value="${esc(s.place || '')}" maxlength="60"></td>
      <td class="s-note" data-l="Приписка"><input name="stepNote" value="${esc(s.note || '')}" maxlength="200" placeholder="видна покупателю"></td>
      <td data-l="Стоит здесь" class="ship-hold"><label><input type="radio" name="holdStep" value="${i}"${held ? ' checked' : ''}><span class="sr-only">Посылка стоит на этом шаге</span></label></td>
    </tr>`;
}

/* ============================== Раздел «Отправления» =========================
 *
 * Отдельный раздел, а не подпись в строке заказа. Заказ и посылка живут разными
 * сроками: заявку разбирают в день оформления, а посылка едет неделю, и вопрос
 * «что сейчас в пути и не застряло ли что-нибудь» на списке заказов не задать —
 * там они вперемешку с черновиками, отказами и оплаченными без отправки.
 *
 * Ничего своего раздел не решает: и состояние, и подписи спрашивает у
 * `lib/tracking.js` — той же функции, что рисует ленту покупателю. Вторая
 * формулировка разъехалась бы с тем, что он видит.
 */
const SHIP_TABS = [
  ['active', 'В пути'],
  ['late', 'Задерживаются'],
  ['done', 'Доставлены'],
  ['hidden', 'Скрытые'],
  ['all', 'Все']
];
function shipTab(value) {
  const id = String(value || '');
  return SHIP_TABS.some(([key]) => key === id) ? id : 'active';
}
function shipFilter(list, tab) {
  return list.filter(o => {
    const ship = o.shipment;
    const shown = TRACK.shownToBuyer(ship);
    const state = TRACK.view(ship);
    if (tab === 'all') return true;
    // Скрытое от покупателя стоит СВОЕЙ вкладкой и в остальные не попадает:
    // маршрут есть, но человек его не видит, и «в пути» рядом с ним означало бы,
    // что покупатель это тоже читает.
    if (tab === 'hidden') return !shown;
    if (!shown) return false;
    if (tab === 'late') return !!(state && state.delayed);
    if (tab === 'done') return !!(state && state.delivered);
    return !(state && (state.delivered || state.delayed));
  });
}

/* Строка отправления. Раскладка та же, что у списка заказов: на телефоне таблица
 * становится карточками, поэтому ячейки названы — безымянные `<td>` сетке не
 * адресовать.
 */
function shipRow(order, settings) {
  const ship = order.shipment;
  const state = TRACK.view(ship) || {};
  const shown = TRACK.shownToBuyer(ship);
  const tone = !shown ? ' is-off' : (state.delayed ? ' is-late' : (state.delivered ? ' is-done' : ''));
  const current = state.current ? state.current.title : '';
  const carrier = DELIVERY.nameOf(ship && ship.carrier) || (ship && ship.carrier) || '';
  const way = [ship && ship.from, ship && ship.to].filter(Boolean).join(' → ');
  // Ожидаемая дата есть, только пока обещание в силе: у задержавшейся её нет
  // вовсе, у доставленной — это дата вручения (см. `view()` в lib/tracking.js).
  const when = state.delivered
    ? `доставлено ${R.formatDate(state.deliveredAt)}`
    : (state.eta ? `ожидается ${R.formatDate(state.eta)}` : (state.delayed ? 'дата уточняется' : ''));
  return `<tr class="s-row${tone}">
      <td class="s-order" data-l="Заказ"><a href="${shipHref(order)}"><b>${esc(R.orderNo(order.number))}</b></a>
        <span class="muted small">${R.formatDate(order.createdAt)}</span></td>
      <td class="s-who" data-l="Покупатель"><b>${esc(order.customerName || '—')}</b>
        <span class="muted small">${esc(way || '—')}</span></td>
      <td class="s-carrier" data-l="Перевозчик">${esc(carrier)}
        <span class="muted small">${esc(DELIVERY.shortModeOf(ship && ship.carrier, ship && ship.mode) || '')}</span></td>
      <td class="s-state" data-l="Состояние"><span class="o-ship${tone}">${esc(shown ? TRACK.shortState(ship) : 'скрыто')}</span>
        ${current ? `<span class="muted small">${esc(current)}</span>` : ''}</td>
      <td class="s-eta" data-l="Срок">${when ? `<span class="muted small">${esc(when)}</span>` : '<span class="muted">—</span>'}</td>
      <td class="s-sum" data-l="Итог"><b>${R.money(order.total, settings)}</b></td>
    </tr>`;
}

function shipmentsPage(settings, db, opts) {
  const o = opts || {};
  const all = (typeof db.visibleOrders === 'function' ? db.visibleOrders() : [])
    .filter(x => x && x.shipment && Array.isArray(x.shipment.steps) && x.shipment.steps.length);
  const tab = shipTab(o.tab);
  const list = shipFilter(all, tab);
  const slice = R.adminSlice(list, o.page);
  const href = n => '/admin/shipments?tab=' + tab + (n > 1 ? '&page=' + n : '');
  const pager = R.adminPager(slice, href);

  // Счётчик у каждой вкладки: «Задерживаются 2» — это и есть то, ради чего
  // раздел открывают, и число должно быть видно до всякого нажатия.
  const tabs = SHIP_TABS.map(([id, label]) => {
    const n = shipFilter(all, id).length;
    return `<a class="a-tab${tab === id ? ' active' : ''}" href="/admin/shipments?tab=${id}">${esc(label)}${n ? ` <b>${n}</b>` : ''}</a>`;
  }).join('');

  /* Пустых состояний два, и они отвечают на разные вопросы: «отправлений нет
   * вовсе» посылает в заказы, где их и создают, а «на этой вкладке пусто» —
   * это нормальный ответ, и звать никуда не нужно. */
  const empty = all.length
    ? '<p class="muted">На этой вкладке пусто.</p>'
    : '<p class="muted">Отправлений пока нет. Маршрут создаётся из строки заказа — там же, где он и нужен.</p>';

  const body = `<div class="a-panel a-panel-list">
    <div class="a-panel-head"><div class="a-tabs">${tabs}</div></div>
    ${slice.items.length ? `<div class="a-table-wrap"><table class="a-table ship-list">
      <thead><tr><th>Заказ</th><th>Покупатель</th><th>Перевозчик</th><th>Состояние</th><th>Срок</th><th>Итог</th></tr></thead>
      <tbody>${slice.items.map(x => shipRow(x, settings)).join('')}</tbody>
    </table></div>${pager}` : empty}
  </div>`;

  return layout(settings, {
    active: 'shipments', title: 'Отправления', counts: navCounts(settings, db),
    flash: o.flash, live: 'orders', wide: true, body
  });
}

function shipmentPage(settings, db, order, opts) {
  opts = opts || {};
  const draft = opts.draft || null;
  const ship = order.shipment || null;
  // Что показывать в полях: введённое (если форма вернулась с ошибкой), затем
  // сохранённое, затем разумное значение по умолчанию. Порядок тот же, что у
  // формы товара и настроек.
  const pick = (field, saved, fallback) => {
    if (draft && draft[field] !== undefined) return String(draft[field]);
    if (saved !== undefined && saved !== null && saved !== '') return String(saved);
    return fallback === undefined ? '' : String(fallback);
  };
  const carrier = pick('carrier', ship && ship.carrier, DELIVERY.isValid(order.delivery) ? order.delivery : 'cdek');
  const mode = pick('mode', ship && ship.mode, order.deliveryMode || 'pvz');
  const from = pick('from', ship && ship.from, String(settings.shipFromCity || '').trim() || TRACK.DEFAULT_FROM);
  // Город получателя берём из адреса доставки: у заказа в пункт выдачи это
  // адрес пункта, у курьерского — адрес покупателя.
  const guessTo = TRACK.cityOf(order.pickupAddress || order.address);
  const to = pick('to', ship && ship.to, guessTo);
  const zone = order.deliveryZone || 'ru';
  const days = pick('days', ship && ship.days, TRACK.defaultDays(carrier, mode, zone));
  const startedAt = ship && ship.startedAt ? ship.startedAt : Date.now();
  // У новой отправки — значение из настроек магазина, у сохранённой — своё:
  // «застряло на складе» и «застряло в пути» ждут по-разному.
  const holdDays = pick('holdDays', ship ? TRACK.holdDaysValue(ship) : '', TRACK.holdDaysValue({ holdDays: settings.shipHoldDays }));
  /* Видно ли отслеживание покупателю. Новая отправка показывается сразу
   * (галочка стоит), а снятая галочка приходит отсутствием поля — поэтому при
   * возврате формы с ошибкой её ищем в `draft`, а не в сохранённом: иначе админ
   * увидел бы её снова отмеченной и молча вернул то, что только что снял. */
  const visible = draft ? draft.visible !== undefined : (!ship || ship.visible !== false);
  const steps = ship && Array.isArray(ship.steps) ? ship.steps : [];
  const holdIndex = steps.findIndex(s => s && s.hold);
  const state = ship ? TRACK.view(ship) : null;

  const carrierOptions = DELIVERY.METHODS.map(m =>
    `<option value="${esc(m.id)}"${m.id === carrier ? ' selected' : ''}>${esc(m.name)}</option>`).join('');
  const modeOptions = DELIVERY.modesOf(carrier).map(m =>
    `<option value="${esc(m.id)}"${m.id === mode ? ' selected' : ''}>${esc(m.name)}</option>`).join('');

  const params = `<div class="a-panel">
      <div class="a-panel-head"><h2>Отправление</h2></div>
      <div class="a-form-grid">
        <div class="field"><label>Перевозчик</label><select name="carrier">${carrierOptions}</select></div>
        <div class="field"><label>Как получают</label><select name="mode">${modeOptions}</select></div>
        <div class="field"><label>Город отправки</label><input name="from" value="${esc(from)}" maxlength="60"></div>
        <div class="field"><label>Город получения</label><input name="to" value="${esc(to)}" maxlength="60" placeholder="${esc(guessTo || 'по адресу заказа')}"></div>
        <div class="field"><label>Дней в пути</label><input name="days" inputmode="numeric" value="${esc(days)}" placeholder="${TRACK.defaultDays(carrier, mode, zone)}"></div>
        <div class="field"><label>Отправлено</label><input type="datetime-local" name="startedAt" value="${esc(dtLocal(startedAt))}"></div>
        ${/* Сколько ДНЕЙ посылка должна простоять, прежде чем покупатель увидит
             просьбу подождать. Ноль — сказать сразу; пусто — сутки. В днях, а не
             в часах: посылка идёт неделю, и «задержалась» — это «второй день не
             двигается», а не «стоит с обеда». */''}
        <div class="field"><label>Сообщать о задержке через, дней</label>
          <input name="holdDays" inputmode="numeric" value="${esc(holdDays)}" placeholder="${TRACK.holdDaysValue({ holdDays: settings.shipHoldDays })}"></div>
      </div>
      ${/* Галочка видимости стоит ЗДЕСЬ, под параметрами, а не рядом с кнопкой
           сохранения: это свойство самой отправки, и решают его тогда же, когда
           выбирают перевозчика. */''}
      <div class="field field-check ship-visible"><label>
        <input type="checkbox" name="visible"${visible ? ' checked' : ''}>
        Показывать отслеживание покупателю</label>
        <span class="muted small">Снимите, пока посылка не передана перевозчику: страница отслеживания будет отвечать, что отправление не найдено.</span>
      </div>
    </div>`;

  /* Кнопок две, и они делают разное.
   *
   * «Сохранить» пишет то, что в таблице, — этим правят одно событие. «Собрать
   * заново» ВЫБРАСЫВАЕТ таблицу и строит маршрут по полям выше: перевозчик,
   * города, срок. Поэтому у второй стоит подтверждение — ручные правки после
   * неё не вернуть.
   */
  const actions = `<div class="a-form-actions ship-actions">
      <button class="btn btn-primary" type="submit" name="intent" value="save">${steps.length ? 'Сохранить' : 'Создать отправление'}</button>
      ${steps.length ? `<button class="btn" type="submit" name="intent" value="rebuild"
        data-confirm="Собрать маршрут заново по полям выше? Ручные правки шагов пропадут.">Собрать маршрут заново</button>` : ''}
    </div>`;

  const table = steps.length || draft ? `<div class="a-panel">
      <div class="a-panel-head"><h2>Путь посылки</h2></div>
      <p class="muted small ship-hint">Событие без названия при сохранении удаляется. Отметка «стоит здесь» — место, дальше которого посылка не поедет.</p>
      <div class="a-table-wrap"><table class="a-table ship-steps">
        <thead><tr><th>Когда</th><th>Событие</th><th>Город</th><th>Приписка</th><th class="ship-hold">Стоит здесь</th></tr></thead>
        <tbody>
          ${steps.map((s, i) => shipStepRow(s, i, i === holdIndex)).join('')}
          ${/* Три пустые строки — чтобы дописать событие руками, не заводя ради
               этого скрипт: форма и без JS остаётся рабочей. */''}
          ${[0, 1, 2].map((_, k) => shipStepRow(null, steps.length + k, false)).join('')}
        </tbody>
      </table></div>
      <label class="ship-nohold"><input type="radio" name="holdStep" value="-1"${holdIndex === -1 ? ' checked' : ''}> Нигде не задерживать — посылка идёт до конца</label>
    </div>` : '';

  // Предпросмотр — та же карточка, которую видит покупатель (`R.trackingBoard`).
  // Второй, «панельной» её версии быть не должно: расходиться им негде, а
  // менеджер обязан видеть ровно то, на что смотрит человек.
  const preview = ship && steps.length ? `<div class="a-panel ship-preview">
      <div class="a-panel-head"><h2>${visible ? 'Что видит покупатель' : 'Что увидит покупатель, когда включите показ'}</h2></div>
      ${R.trackingBoard(order, { own: true })}
    </div>` : '';

  const number = String(order.number || '').replace(/\D+/g, '');
  const drop = ship ? `<form class="ship-drop" method="post" action="${shipHref(order)}/delete"
      data-confirm="Удалить отправление? Страница отслеживания у покупателя перестанет открываться.">
      <button class="btn btn-danger btn-sm" type="submit">Удалить отправление</button>
    </form>` : '';

  /* Ссылка на отслеживание — самая нужная вещь этой страницы после самого
   * маршрута: её отправляют покупателю руками, в тот же чат или в Telegram.
   * Поэтому она стоит крупно, полным адресом и с кнопкой копирования рядом:
   * выделять её мышью по буквам — ровно то, чего не должно быть.
   *
   * Адрес абсолютный (`opts.origin` от сервера, он один знает, каким именем
   * открыт магазин): из «/track/482913» покупатель ссылку не сделает.
   */
  /* Адрес собирает `lib/tracking.js`: ключ у ссылки секретный и сменяемый, а
   * собранный руками адрес разошёлся бы с ним молча. */
  const trackPath = ship ? TRACK.trackPath(ship) : '';
  const trackUrl = trackPath ? String(opts.origin || '').replace(/\/+$/, '') + trackPath : '';
  const share = trackUrl ? `<div class="a-panel ship-share${visible ? '' : ' is-hidden'}">
      <div class="ship-share-head">
        <span class="ship-share-ico" aria-hidden="true">${SHIP_ICONS.link}</span>
        <div class="ship-share-cap"><b>Ссылка для покупателя</b>
          <span>${visible ? 'Отправьте её в чат или Telegram — страница откроется без входа. Подобрать такую ссылку нельзя, поэтому она и есть пропуск к посылке.'
    : 'Отслеживание скрыто: по этой ссылке покупатель увидит «отправление не найдено».'}</span></div>
      </div>
      <div class="ship-share-row">
        <input class="ship-share-url" type="text" value="${esc(trackUrl)}" readonly aria-label="Ссылка на отслеживание"
          onfocus="this.select()">
        ${/* Копирование — единственное, что нельзя сделать разметкой: буфер
             обмена открывается только скриптом. Обработчик общий на панель
             (`public/admin-ui.js`), запасной путь через execCommand обязателен —
             clipboard-API не работает без https. */''}
        <button type="button" class="btn btn-primary ship-copy" data-copy="${esc(trackUrl)}">
          ${SHIP_ICONS.copy}<span>Копировать</span></button>
      </div>
      ${/* Сменить ключ. Нужно ровно в одном случае: ссылку отправили не туда
           или она ушла дальше, чем следовало. Прежняя после этого не
           открывается ничем — об этом и предупреждает подтверждение. */''}
      <form class="ship-share-reset" method="post" action="${shipHref(order)}/relink"
        data-confirm="Сменить ссылку? Прежняя перестанет открываться — если вы уже отправили её покупателю, придётся отправить новую.">
        <button class="btn btn-sm" type="submit">Сменить ссылку</button>
      </form>
    </div>` : '';

  /* Ссылка стоит ПЕРЕД формой, а не после неё, по двум причинам: за ней сюда
   * и заходят, когда маршрут уже собран, а кнопка «Сохранить» внизу формы
   * прилипает к экрану и накрывала бы блок, стоящий под ней. */
  const body = `${share}
    <form method="post" action="${shipHref(order)}" class="ship-form">
      ${params}
      ${table}
      ${actions}
    </form>
    ${preview}
    ${drop}`;

  return layout(settings, {
    active: 'orders', title: 'Отправление ' + R.orderNo(order.number),
    counts: navCounts(settings, db), flash: opts.flash, flashType: opts.flashType,
    actions: `<a class="btn btn-sm" href="/admin/orders#order-${esc(order.id)}">← К заказам</a>`
      + (trackPath ? `<a class="btn btn-sm" href="${esc(trackPath)}" target="_blank" rel="noopener">Страница покупателя ↗</a>` : ''),
    body: (state && state.delayed
      ? '<div class="a-flash err">Покупателю сейчас показывается сообщение о задержке.</div>' : '') + body
  });
}

const VISITORS_BASE = '/admin/analytics/visitors';

/* ---------------------------- Раздел «Чат» ----------------------------
 *
 * Зачем он есть, если диалоги и так падают в Telegram: Telegram — рабочее место
 * дежурного менеджера, а панель отвечает на другие вопросы. Что вообще
 * спрашивают, доходит ли чат до людей, что бот наговорил ночью — это читают
 * списком, а не листая полсотни тем. Ответить можно оттуда же — действие то же
 * самое, что сообщение в теме, и режим оно меняет так же.
 *
 * ВЫГЛЯДИТ ЭТО КАК МЕССЕНДЖЕР, И ЭТО НЕ УКРАШАТЕЛЬСТВО. Переписку читают той же
 * частью головы, что и Telegram: взгляд ищет аватар слева, время справа, свои
 * реплики у правого края и дату между днями. Список из безликих строк с
 * подписью «Компьютер · macOS 10 · Firefox 140» приходится РАЗБИРАТЬ, а
 * привычную раскладку — просто читать.
 */

// Аватар: кружок с первой буквой. Ни картинок, ни цвета по автору — пёстрая
// колонка кружков отвлекала бы от самих диалогов, как это уже решено у карточек
// отзывов на витрине.
/* Кружок с буквой имени.
 *
 * ТОЧКА ПРИСУТСТВИЯ НА НЁМ — ДЛЯ МЕСТ, ГДЕ ПРО ЭТО НЕ СКАЗАНО СЛОВАМИ: в списке
 * диалогов и в карточке уведомления она единственный признак того, что человек
 * сейчас в окне. В шапке разговора рядом стоит «в сети» (`chatPresence`), и там
 * точка повторяла бы то же самое вторым способом — поэтому оттуда её просят не
 * рисовать (`dot: false`).
 */
function chatAvatar(chat, opts) {
  const o = opts || {};
  const title = chatTitle(chat, o.named);
  const letter = (title.trim()[0] || '?').toUpperCase();
  const live = o.dot !== false && CHAT.presence(chat).online;
  return `<span class="chat-ava${o.big ? ' is-big' : ''}${live ? ' is-online' : ''}" aria-hidden="true">${esc(letter)}</span>`;
}

// Как зовут собеседника в списке. Имя покупатель называет сам и почти никогда
// этого не делает, поэтому дальше идёт город: «Стокгольм» — это всё-таки кто-то
// конкретный, в отличие от «Посетителя».
/* Как зовут собеседника. Имя покупатель называет сам и почти никогда — окно
 * чата его не спрашивает, — поэтому запасной вариант город.
 *
 * Но если он ОФОРМИЛ ЗАКАЗ, имя у нас есть: он вписал его в форму. Тогда город
 * в шапке диалога был бы шагом назад — менеджер отвечает человеку, а не точке
 * на карте. Заказы старых диалогов подставляются здесь; у новых имя приезжает
 * в сам диалог в момент заказа (см. server.js), поэтому искать его по списку
 * заказов приходится не всегда.
 */
function chatTitle(chat, named) {
  return String((chat && chat.name) || String(named || '').trim()
    || chatPlaceParts(chat)[0] || 'Посетитель').trim() || 'Посетитель';
}

/* Место собеседника разобранным: `[город, страна]`.
 *
 * Разбор один на всех, потому что и заголовок, и строка под ним делят одну
 * строку: заголовок берёт город (когда имени нет), подпись — то, что осталось.
 * У диалогов, записанных до появления `client.*`, есть только склейка
 * «Город, Страна» — её делим по запятой, и правило от этого не меняется.
 */
function chatPlaceParts(chat) {
  const c = (chat && chat.client) || {};
  const parts = c.city || c.country
    ? [c.city, c.country]
    : String((chat && chat.city) || '').split(',');
  return parts.map(p => String(p || '').trim()).filter(Boolean);
}
// Имя из самого свежего заказа этого покупателя. Заказы приходят свежими
// сверху, поэтому берём первый непустой.
function orderName(orders) {
  if (!Array.isArray(orders)) return '';
  const found = orders.find(o => o && String(o.customerName || '').trim());
  return found ? String(found.customerName).trim() : '';
}

/* Здесь ли покупатель. Отвечает на вопрос, который менеджер задаёт перед тем,
 * как ответить: ждёт ли человек ответа прямо сейчас или ушёл час назад и
 * прочитает утром. «В сети» — это открытый живой канал, а не свежая реплика:
 * человек может молча читать. */
function chatPresence(chat) {
  const p = CHAT.presence(chat);
  if (p.online) return '<span class="chat-live is-on"><i></i>в сети</span>';
  if (!p.seenAt) return '';
  return `<span class="chat-live"><i></i>был ${esc(chatSeenAgo(p.seenAt))}</span>`;
}

/* Откуда пишет собеседник — рядом со статусом, вместо адреса.
 *
 * IP там стоял с самого начала и отвечал не на тот вопрос: менеджеру он не
 * говорит ничего, а сам адрес никуда не делся — он лежит в карточке посетителя,
 * куда ведёт кнопка в той же шапке. «Санкт-Петербург» же — это половина ответа
 * и про доставку, и про то, который час у человека на том конце.
 *
 * ГОРОД УЖЕ МОЖЕТ СТОЯТЬ ЗАГОЛОВКОМ: имя покупатель называет сам и почти
 * никогда этого не делает, и тогда `chatTitle()` берёт город. Повторять его
 * строкой ниже незачем — остаётся страна.
 *
 * Города нет вовсе (база «IP → город» не собрана, IPv6) — строка остаётся с
 * одним статусом: выдумывать место мы не будем.
 */
function chatPlace(chat, title) {
  const name = String(title || '').trim();
  const text = chatPlaceParts(chat).filter(p => p !== name).join(', ');
  return text ? `<span class="chat-place">${esc(text)}</span>` : '';
}

// «был 5 минут назад» / «был в 20:36» / «был 24 августа». Ровно как в
// мессенджерах: сегодняшнее время читается само, вчерашнее нужно назвать днём.
function chatSeenAgo(ms) {
  const at = Number(ms) || 0;
  if (!at) return '';
  const mins = Math.round((Date.now() - at) / 60000);
  if (mins < 1) return 'только что';
  if (mins < 60) return mins + ' мин назад';
  const d = R.mskDate(at);
  if (sameDay(d, R.mskNow())) return 'в ' + R.mskTime(at);
  if (sameDay(d, mskYesterday())) return 'вчера в ' + R.mskTime(at);
  return d.getDate() + ' ' + MONTHS[d.getMonth()];
}

const MONTHS = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня',
  'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];

/* Вчера по московскому календарю. Считается сдвигом уже МОСКОВСКОЙ даты:
 * у сервера в UTC «вчера» начинается на три часа раньше, и у реплики,
 * отправленной в час ночи по Москве, разделитель говорил бы «Вчера». */
function mskYesterday() {
  const d = R.mskNow();
  d.setDate(d.getDate() - 1);
  return d;
}

// Один ли это день по МОСКОВСКОМУ календарю: сервер живёт по UTC, и «сегодня»
// у него меняется на три часа раньше, чем у владельца.
function sameDay(a, b) {
  return a.getDate() === b.getDate() && a.getMonth() === b.getMonth() && a.getFullYear() === b.getFullYear();
}

// Время реплики — часы и минуты, как в любом мессенджере. День называет
// разделитель над группой сообщений, и повторять его у каждой строки незачем.
function chatTime(ms) {
  return Number(ms) ? R.mskTime(ms) : '';
}

/* Текст реплики: ссылки консультанта — названием, как их видит покупатель.
 *
 * Разбирает строку общий с витриной `public/chat-links.js`, а разметку строим
 * здесь: экранирование живёт в одном месте проекта, и уносить его в общий файл
 * значило бы завести его копию. Всё, что не ссылка, уходит через `esc()` — и
 * текст покупателя, и текст, который сочинила модель.
 *
 * Ссылка открывается в новой вкладке: панель на её месте закрыла бы переписку,
 * которую менеджер как раз читает. */
function chatLine(text) {
  return LINKS.parts(text).map(p => (p.text != null
    ? esc(p.text)
    : `<a href="${esc(p.href)}" target="_blank" rel="noopener noreferrer">`
      + (p.label !== p.href ? '<span aria-hidden="true">👉 </span>' : '') + esc(p.label) + '</a>')).join('');
}

// Та же реплика одной строкой — для превью в списке диалогов: от ссылки
// остаётся название, адрес в две строки списка всё равно не поместился бы.
function chatPreview(text) {
  return LINKS.parts(text).map(p => (p.text != null ? p.text : p.label)).join('').trim();
}

// Разделитель дат: «Сегодня», «Вчера», «25 августа», с годом у прошлогодних.
function chatDay(ms) {
  const d = R.mskDate(Number(ms) || 0);
  const now = R.mskNow();
  if (sameDay(d, now)) return 'Сегодня';
  if (sameDay(d, mskYesterday())) return 'Вчера';
  const day = d.getDate() + ' ' + MONTHS[d.getMonth()];
  return d.getFullYear() === now.getFullYear() ? day : day + ' ' + d.getFullYear();
}

// Когда в списке. Свежий диалог меряется минутами, вчерашний — днём: «14:20» у
// позавчерашнего разговора не отвечает ни на один вопрос.
function chatWhen(ms) {
  const at = Number(ms) || 0;
  if (!at) return '';
  const d = R.mskDate(at);
  const now = R.mskNow();
  if (sameDay(d, now)) return chatTime(at);
  if (sameDay(d, mskYesterday())) return 'вчера';
  return d.getDate() + ' ' + MONTHS[d.getMonth()].slice(0, 3);
}

// Плашка режима. Три состояния и три разных дела: у «ждёт ответа ИИ» дел нет, у
// «отвечает менеджер» разговор ведёт человек, «завершён» — закрытая переписка.
function chatModeBadge(mode) {
  const map = {
    ai: ['ai', 'ИИ'],
    operator: ['op', 'Менеджер'],
    closed: ['done', 'Завершён']
  };
  const [kind, label] = map[mode] || map.ai;
  return `<span class="chat-badge-mode is-${kind}">${esc(label)}</span>`;
}

// Значки техники и страны. Собираются из РАЗОБРАННЫХ полей той же функцией, что
// подписывает заказ и строку метрики: «Телефон» в чате и «Телефон» в заявке
// обязаны выглядеть одинаково, иначе панель читается как два разных раздела.
function chatMarks(chat, href) {
  const c = (chat && chat.client) || {};
  const marks = R.clientMarks({
    place: c.city || chat.city, country: c.country, countryCode: c.countryCode,
    device: c.device, model: c.model, os: c.os, browser: c.browser
  }, href ? { href, title: 'Открыть карточку посетителя в метрике' } : null);
  // У диалогов, записанных до появления разобранных полей, остаётся склейка —
  // без значков, но и без дыры в строке.
  if (marks) return marks;
  const plain = [chat.city, chat.device].filter(Boolean).join(' · ');
  return plain ? `<div class="cmarks"><span class="cmark">${esc(plain)}</span></div>` : '';
}

// Как называется реплика из одних снимков — в списке диалогов и в уведомлении.
// Число здесь по делу: «фото» и «три фото» — разный повод открыть переписку.
function chatShotsLabel(message) {
  const n = CHAT.photosOf(message).length;
  // «Фото» не склоняется ни по числу, ни по падежу — плюрализатор тут не нужен.
  return n ? `📷 ${n} фото` : '';
}

function chatList(settings, db, flash, page) {
  /* Имя покупателя из его заказов — для диалогов, начатых ДО того, как имя
   * стало попадать в сам диалог (см. server.js). Один проход по заказам на
   * страницу списка, а не поиск на каждую строку. */
  const nameByVisitor = new Map();
  if (typeof db.visibleOrders === 'function') {
    for (const o of db.visibleOrders()) {
      const named = String((o && o.customerName) || '').trim();
      if (named && o.visitorId && !nameByVisitor.has(o.visitorId)) nameByVisitor.set(o.visitorId, named);
    }
  }
  const all = CHAT.list();
  const slice = R.adminSlice(all, page);
  const pager = R.adminPager(slice, n => '/admin/chat' + (n > 1 ? '?page=' + n : ''));
  const rows = slice.items.map(c => {
    // В строке — последняя реплика: по ней видно, на чём разговор встал, и
    // нужно ли вообще его открывать. Свою помечаем «Вы:», как в мессенджерах.
    const last = c.messages.length ? c.messages[c.messages.length - 1] : null;
    const mine = last && last.role !== 'user';
    /* Непрочитанное — тем же признаком, каким считает счётчик в шапке
       (`CHAT.storeUnread`). Пока признака в строке не было, шапка писала «6», а
       по списку было не понять, какие именно шесть: старые диалоги, которые ни
       разу не открывали, лежат внизу по времени последней реплики.
       Порядок при этом не трогаем — он по времени, как в любом мессенджере;
       непрочитанное помечается, а не поднимается наверх. */
    const unread = CHAT.storeUnread(c);
    return `<a class="chat-row${unread ? ' is-unread' : ''}" href="/admin/chat/${esc(c.id)}" data-live-key="chat-${esc(c.id)}">
      ${chatAvatar(c, { named: nameByVisitor.get(c.visitorId) })}
      <span class="chat-row-main">
        <span class="chat-row-top">
          <b class="chat-row-name">${esc(chatTitle(c, nameByVisitor.get(c.visitorId)))}</b>
          ${chatModeBadge(c.mode)}
          <span class="chat-row-when">${esc(chatWhen(c.lastAt))}</span>
        </span>
        ${/* Реплика бывает без слов — из одних снимков. Пустая строка в списке
             читалась бы как «диалог ни о чём», поэтому вместо неё стоит то, чем
             реплика и является. */''}
        ${/* Ссылка в превью — одним названием (`LINKS.plain` развернула бы её в
             «Название (/адрес)», а строка тут и так обрезана двумя строками). */''}
        <span class="chat-row-last">${mine ? '<i>Вы:</i> ' : ''}${esc(last ? (chatPreview(last.text) || chatShotsLabel(last)) : 'Пустой диалог')}</span>
        ${chatMarks(c)}
      </span>
      ${unread ? `<span class="chat-row-unread" title="Непрочитанных реплик: ${unread}">${unread}</span>` : ''}
    </a>`;
  }).join('');

  const body = all.length
    ? `<div class="a-panel a-panel-list chat-list">${rows}${pager}</div>`
    // Пустой список — не повод рисовать панель ради слов «ничего нет»: то же
    // правило, что у разобранной очереди модерации.
    : `<div class="a-panel chat-empty">
        <div class="chat-empty-ico">${R.adminIcon('chat')}</div>
        <p class="muted">Диалогов пока нет. Кнопка чата ${CHAT.visible(settings) ? 'на витрине стоит и ждёт вопросов.' : '<b>на витрине не показывается</b> — включите чат в настройках.'}</p>
      </div>`;

  return layout(settings, {
    active: 'chat', title: 'Чат', counts: navCounts(settings, db), flash,
    live: 'chat', body
  });
}

/* Одна переписка. Здесь же — ответ оператора: это то же самое действие, что
 * сообщение в теме Telegram, и режим оно меняет так же. Двух разных «ответов»
 * с разным поведением быть не должно.
 */
/* Заказы собеседника — с состоянием оплаты.
 *
 * Половина разговоров в чате про них и есть: «оплатил, а статус прежний»,
 * «счёт не открывается», «когда отправите». Отвечать на такое, не видя заявки,
 * означает переспрашивать номер заказа у человека, который сидит на сайте с
 * открытой страницей оплаты.
 *
 * Плашка и подпись — те же, что в списке заказов (`R.orderStatus`): «счёт
 * истёк» в чате и «счёт истёк» в заявке обязаны означать одно и то же, а своя
 * копия слов разъехалась бы на первой правке.
 */
/* Строка заявки — ДВА ряда, а не три: «номер, дата, сумма» и «состав со
 * состоянием». Третьим рядом плашка занимала у каждого заказа целую строку, а
 * говорит она то же самое, что и две соседние ячейки, — на боевых данных пара
 * заявок съедала так пол-экрана до первой реплики. */
function chatOrdersBox(orders, settings) {
  const list = Array.isArray(orders) ? orders : [];
  if (!list.length) return '';
  const rows = list.map(o => `<a class="chat-order" href="/admin/orders#order-${esc(o.id)}">
    <span class="chat-order-top">
      <b>${esc(R.orderNo(o.number))}</b>
      <span class="muted small">${esc(R.formatDate(o.createdAt))}</span>
      <span class="chat-order-sum">${R.money(o.total, settings)}</span>
    </span>
    <span class="chat-order-low">
      <span class="chat-order-items">${esc(orderItemsText(o))}</span>
      <span class="chat-order-state">${R.orderStatus(o)}</span>
    </span>
  </a>`).join('');
  return `<div class="chat-orders" data-live-part="orders">
    <div class="chat-orders-head">Заказы покупателя</div>${rows}</div>`;
}

// Состав заявки одной строкой: в переписке нужен не полный список, а «о чём
// вообще речь». Первая позиция и сколько ещё — этого хватает.
function orderItemsText(order) {
  const items = Array.isArray(order && order.items) ? order.items : [];
  if (!items.length) return 'Состав не указан';
  const first = String(items[0] && items[0].name || 'Товар');
  return items.length > 1 ? first + ' и ещё ' + (items.length - 1) : first;
}

/* Правка одной реплики — и своей, и покупателя.
 *
 * Вся форма на `<details>`, как ответ на отзыв: ни строчки скрипта, свёрнутая
 * лента остаётся лентой, а работает правка и там, где скрипты панели не
 * загрузились. Раскрывает её карандаш под пузырём — он проявляется на наведении
 * и на фокусе, а на телефоне стоит открыто (см. `.chat-edit` в styles.css):
 * шестнадцать серых кнопок «Изменить» в переписке из шестнадцати реплик читались
 * бы как содержание, а не как служебная мелочь.
 *
 * Покупатель правки не видит — ни события в канал, ни пометки «изменено»
 * (см. `editMessage` в lib/chat.js). Поэтому и предупреждение стоит на самой
 * кнопке удаления: восстановить реплику будет неоткуда.
 */
/* Значки меню реплики и кнопки консультанта. Холст 24×24 и волосяная обводка
 * 1.6 — тот же вес штриха, что у значков разделов и глифов витрины. */
const CHAT_ICONS = {
  copy: '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><rect x="9" y="9" width="11" height="11" rx="2.6" stroke="currentColor" stroke-width="1.6"/><path d="M15 6.2A2.2 2.2 0 0 0 12.8 4H6.2A2.2 2.2 0 0 0 4 6.2v6.6A2.2 2.2 0 0 0 6.2 15" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>',
  edit: '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M4.5 19.5h3.6L19 8.6a1.9 1.9 0 0 0 0-2.7l-.9-.9a1.9 1.9 0 0 0-2.7 0L4.5 15.9v3.6Z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/><path d="M14.2 6.8 17.2 9.8" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>',
  drop: '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M5.5 7h13M10 7V5.6A1.6 1.6 0 0 1 11.6 4h.8A1.6 1.6 0 0 1 14 5.6V7m3 0-.7 11.5a1.8 1.8 0 0 1-1.8 1.7H9.5a1.8 1.8 0 0 1-1.8-1.7L7 7" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  /* Значок консультанта — искра, тот же образ, каким ИИ подписан у Apple в
   * highlights («Built for AI»), и он же лежит у нас в spec-icons. Робота
   * рисовать не стали: покупателю бот не представляется, и менеджеру про него
   * важно не «машина», а «отвечает сам». */
  ai: '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M12 3.6l1.9 4.9 4.9 1.9-4.9 1.9L12 17.2l-1.9-4.9-4.9-1.9 4.9-1.9L12 3.6Z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/><path d="M18.4 15.6l.7 1.8 1.8.7-1.8.7-.7 1.8-.7-1.8-1.8-.7 1.8-.7.7-1.8Z" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/></svg>',
  /* Стрелка «назад» в шапке разговора. Разговор занимает экран целиком, шапки
     панели на нём нет вовсе — и это единственный путь к списку. */
  back: '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M14.5 5.5 8 12l6.5 6.5" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  /* Загнутая стрелка «ответить» — тот же знак, каким это действие подписано в
     любом мессенджере. Он же нарисован в подсказке при смахивании реплики
     (`.chat-item::after` в styles.css): фигура одна, поэтому и смахивание, и
     пункт меню читаются как одно и то же действие. */
  reply: '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M9 7 4.5 11.5 9 16" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/><path d="M4.5 11.5h8.6a5.4 5.4 0 0 1 5.4 5.4V18" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  clip: '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M18.4 11.3 12 17.7a4.1 4.1 0 0 1-5.8-5.8l7-7a2.7 2.7 0 0 1 3.9 3.9l-7 7a1.4 1.4 0 0 1-1.9-1.9l6.2-6.2" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  send: '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M5.5 12h13M13 6.5l5.5 5.5L13 17.5" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  // Шеврон у имени: подсказка, что за ним раскрываются подробности.
  chev: '<svg class="chat-head-chev" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="m9.5 5.5 7 6.5-7 6.5" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/></svg>'
};

const CHAT_PENCIL = '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true" focusable="false">'
  + '<path d="M4.5 19.5h3.6L19 8.6a1.9 1.9 0 0 0 0-2.7l-.9-.9a1.9 1.9 0 0 0-2.7 0L4.5 15.9v3.6Z" '
  + 'stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/>'
  + '<path d="M14.2 6.8 17.2 9.8" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>';

/* Что можно сделать с репликой — меню по удержанию на ней.
 *
 * Раньше рядом с каждой репликой висел карандаш: полтора десятка одинаковых
 * кнопок читались как содержание, а на телефоне в него ещё надо было попасть.
 * Теперь удерживается сам пузырь — ровно так, как это делают в мессенджерах, —
 * и под ним раскрывается ряд действий.
 *
 * `<details>` хранит состояние; `admin-ui.js` различает удержание, указательный
 * тап и Enter/Space. Без скрипта остаётся обычное раскрытие по нажатию.
 * «Изменить» — вложенный `<details>`: форма правки нужна редко, держать её
 * открытой незачем.
 */
/* Текст цитаты для подписи и для скрипта. Ссылка сворачивается в название тем
 * же разборщиком, что и сама реплика, а длина режется по общему `REPLY_CUT`:
 * цитата отвечает на «о чём это», а не пересказывает реплику целиком. */
function chatQuoteText(m) {
  const shots = CHAT.photosOf(m).length;
  const text = chatPreview(m.text || '') || (shots ? '📷 ' + shots + ' фото' : '');
  return text.length > CHAT.REPLY_CUT ? text.slice(0, CHAT.REPLY_CUT - 1).trimEnd() + '…' : text;
}

// Кто автор реплики — подпись над цитатой. У покупателя это его имя (или город),
// у магазина — тот же голос, которым он подписан в переписке.
function chatQuoteWho(chat, role, by, named) {
  return role === 'user' ? chatTitle(chat, named) : (CHAT.speakerOf(role, by) || 'Магазин');
}

function chatTools(chat, m, who) {
  const drop = `<form class="chat-tool-form" method="post" action="/admin/chat/${esc(chat.id)}/message">`
    + `<input type="hidden" name="at" value="${m.at}">`
    + `<button class="chat-tool is-drop" type="submit" name="drop" value="1"`
    + ` data-confirm="Удалить эту реплику? Покупатель этого не увидит, но и вернуть её будет неоткуда.">`
    + `${CHAT_ICONS.drop}<span>Удалить</span></button></form>`;
  /* «Ответить» — ОБЫЧНАЯ ССЫЛКА, а не кнопка со скриптом: без JS она возвращает
   * ту же страницу с уже подставленной цитатой над полем ответа, со скриптом
   * переход перехватывается и цитата встаёт на место без перезагрузки. Отсюда же
   * `data-*`: смахивание реплики берёт цитату из этой самой ссылки — второго
   * места, где решается, что попадёт в цитату, быть не должно.
   *
   * Системным строкам отвечать не на что: их писал не человек. */
  const quote = m.role === 'system' ? '' : chatQuoteText(m);
  const reply = quote
    ? `<a class="chat-tool" href="/admin/chat/${esc(chat.id)}?reply=${m.at}#chat-answer"`
      + ` data-chat-reply="${m.at}" data-reply-who="${esc(who || '')}" data-reply-text="${esc(quote)}">`
      + `${CHAT_ICONS.reply}<span>Ответить</span></a>`
    : '';
  return `<div class="chat-tools">`
    + reply
    + `<button type="button" class="chat-tool" data-chat-copy="${esc(m.text)}">${CHAT_ICONS.copy}<span>Скопировать</span></button>`
    + `<details class="chat-edit"><summary class="chat-tool">${CHAT_ICONS.edit}<span>Изменить</span></summary>`
    + `<form class="chat-edit-form" method="post" action="/admin/chat/${esc(chat.id)}/message">`
    + `<input type="hidden" name="at" value="${m.at}">`
    + `<textarea name="text" rows="3" required maxlength="${CHAT.MAX_TEXT}" aria-label="Текст реплики">${esc(m.text)}</textarea>`
    + `<div class="chat-edit-acts"><button class="btn btn-sm btn-primary" type="submit">Сохранить</button></div>`
    + `</form></details>`
    + drop
    + `</div>`;
}

function chatPage(settings, db, chat, flash, orders, sent, replyTo) {
  // Оформил заказ — значит имя назвал: город в шапке был бы шагом назад. Нужно
  // оно и в ленте — подписью над цитатой его же реплики.
  const buyerName = orderName(orders);
  /* Лента с разделителями дат — как в Telegram. Без них переписка, растянутая
   * на несколько дней, читается одним куском: вчерашнее «отправим завтра»
   * выглядит сегодняшним обещанием. */
  const lines = [];
  let day = '';
  for (const m of chat.messages) {
    const stamp = chatDay(m.at);
    if (stamp !== day) {
      day = stamp;
      lines.push(`<div class="chat-date"><span>${esc(stamp)}</span></div>`);
    }
    const who = m.role === 'user' ? '' : CHAT.speakerOf(m.role, m.by);
    /* Галочка у своей реплики — дошла ли она до покупателя и открывал ли он
     * окно. Вопрос ровно тот же, что у него: «увидели или нет», — и отвечать на
     * него менеджеру надо чаще, чем покупателю: молчание после ответа означает
     * либо «читает», либо «ушёл и не видел». */
    const seen = chat.receipt || {};
    const tick = m.role === 'ai' || m.role === 'operator'
      ? R.chatTick(m.at <= seen.userRead ? 'read' : m.at <= seen.userGot ? 'got' : 'sent')
      : '';
    /* Всё в ОДНУ строку шаблона, без переносов между span'ами.
     *
     * У пузыря стоит `white-space:pre-line` — он нужен, чтобы абзацы в реплике
     * покупателя остались абзацами. Но он же сохраняет и переводы строк из
     * самой разметки: красиво отформатированный шаблон давал разрыв ПЕРЕД
     * временем, и оно уезжало на свою строку к левому краю, а текст вдобавок
     * ломался пополам. Ровно та же грабля ждёт любого, кто решит «выровнять»
     * это место обратно. */
    /* Снимки покупателя. Разметка — тот же договор с просмотрщиком, что у
     * вложений отзыва (`data-media` у группы, `data-kind` у ссылки): панель
     * `public/media-lightbox.js` и так грузит, и снимок открывается ровно так
     * же, как в отзывах. Клик по нему при этом НЕ раскрывает меню реплики:
     * просмотрщик гасит действие по умолчанию, а именно им `summary` и
     * переключает `details`. */
    const shots = CHAT.photosOf(m);
    const photos = shots.length
      ? `<span class="chat-line-shots is-${shots.length}" data-media>`
        + shots.map((f, i) => `<a class="chat-line-shot" href="/uploads/${encodeURIComponent(f)}" data-kind="photo" aria-label="Открыть фото ${i + 1}"><img src="/uploads/${encodeURIComponent(f)}" alt="" loading="lazy" width="180" height="180"></a>`).join('')
        + `</span>`
      : '';
    /* Цитата — на какую реплику это ответ. Стоит первой в пузыре, как в любом
     * мессенджере: сначала «на что отвечают», потом сам ответ. Это СНИМОК,
     * сделанный в момент отправки (см. `replyTo` в lib/chat.js), поэтому правка
     * или удаление оригинала её не трогают — и покупатель ничего об этом не
     * узнаёт. Живой ссылки на оригинал в ней нет: полная реплика лежит выше в
     * той же ленте. */
    const quoted = m.reply
      ? `<span class="chat-line-reply"><b>${esc(chatQuoteWho(chat, m.reply.role, m.reply.by, buyerName))}</b>`
        + `<span>${esc(m.reply.text)}</span></span>`
      : '';
    const bubble = `<summary class="chat-line is-${esc(m.role)}" title="Удерживайте, чтобы выбрать реплику">`
      + (who ? `<span class="chat-line-who">${esc(who)}</span>` : '')
      + quoted
      + photos
      + (m.text ? `<span class="chat-line-text">${chatLine(m.text)}</span>` : '')
      + `<span class="chat-line-at">${esc(chatTime(m.at))}${tick}</span></summary>`;
    /* Обёртка нужна, чтобы рядом с пузырём встала форма правки: у самого пузыря
       `white-space:pre-line`, и всё внутри него собирается ОДНОЙ строкой
       шаблона (см. комментарий выше). Сторону разговора теперь задаёт обёртка —
       `align-self` переехал на неё вместе с ограничением ширины.
       Ключ строки — время реплики: живое обновление подменяет ленту, и без
       ключа открытая форма правки переписывалась бы вместе с соседями. */
    lines.push(`<div class="chat-item is-${esc(m.role)}" data-live-key="msg-${m.at}">
      <details class="chat-bubble">${bubble}${chatTools(chat, m, chatQuoteWho(chat, m.role, m.by, buyerName))}</details>
    </div>`);
  }

  // Карточка посетителя открывается тем же адресом, что из строки заказа: у
  // диалога и визита один и тот же человек.
  const visitor = chat.visitorId || chat.ip;
  const href = visitor ? VISITOR_BASE + encodeURIComponent(visitor) : '';
  /* Страница, на которой стоит покупатель, — ССЫЛКА, а не текст: менеджер
   * открывает её, чтобы увидеть то же, что видит человек. Адрес витрины
   * сохранён в самом диалоге (`origin`), иначе собрать его тут не из чего. */
  const page = chat.page
    ? `<a class="chat-page" href="${esc((chat.origin || '') + chat.page)}" target="_blank" rel="noopener noreferrer">
        ${R.adminIcon('page')}<span>${esc(chat.page)}</span></a>`
    : '';

  /* Спрайт галочек — один на страницу и вне ленты: символы обязаны лежать в
   * документе, пока на них ссылается хоть одна реплика, а лента и прокручивается,
   * и перерисовывается живым обновлением. */
  /* Цитата над полем ответа. Приезжает она параметром адреса (`?reply=`), а
   * снимок собирает хранилище по самой переписке — то же, что делает маршрут
   * отправки. Со скриптом эти же узлы заполняет `public/admin-ui.js`: разметку
   * рисует сервер, скрипт только подставляет в неё имя и текст. */
  const quoteFor = replyTo ? CHAT.replyTo(chat, Math.floor(Number(replyTo) || 0)) : null;
  /* `data-chat-sent` ставит редирект после удачного ответа: по нему
   * `public/admin-ui.js` даёт звук отправки и сразу убирает признак из адреса,
   * чтобы обновление страницы не повторяло сигнал. */
  /* Разговор устроен как экран мессенджера: сверху шапка с собеседником, ниже
   * лента, внизу поле ответа. Экран он занимает ЦЕЛИКОМ — и на телефоне, и на
   * компьютере (см. `.a-app` в `styles.css`), поэтому стрелка «назад» живёт
   * ЗДЕСЬ, а не в шапке панели: самой шапки панели на этой странице нет вовсе.
   *
   * Подробности о человеке (техника, страница, заказы) — под нажатием на его
   * имя, как профиль в WhatsApp и Telegram: кто это и откуда, узнаю́т один раз,
   * а переписку читают всё время. На 390 px эти три блока подряд съедали
   * полэкрана до первой реплики, но и на мониторе пара заявок с их плашками
   * оплаты отжимала ленту вниз так, что разговора было не видно.
   *
   * Раскрытие — СКРЫТЫЙ ЧЕКБОКС И ПОДПИСЬ-КНОПКА, а не `<details>`: на
   * десктопе подробности обязаны стоять открыто, а у `<details>` содержимое
   * прячет браузер, и «показать при закрытом» из CSS надёжно не задать. Тот же
   * приём, что у отбора в ленте отзывов и у поиска в шапке витрины. */
  const body = `${R.CHAT_TICK_SPRITE}<div class="chat-view"${sent ? ' data-chat-sent' : ''}>
    <input type="checkbox" id="chat-profile" class="chat-profile-switch sr-only">
    ${/* Обёртка нужна ровно затем, чтобы раскрытые подробности встали ПОД
         шапкой, а не под всей панелью: на телефоне они лежат поверх ленты
         (`position:absolute; top:100%`), и точка отсчёта у них — шапка. На
         десктопе обёртка убирается из раскладки (`display:contents`), и оба
         блока остаются прямыми участниками колонки, как были. */''}
    <div class="chat-head-box">
    <div class="chat-head-card">
      <a class="chat-back" href="/admin/chat" aria-label="Все диалоги">${CHAT_ICONS.back}</a>
      <label class="chat-head-who" for="chat-profile" title="Подробности о собеседнике">
        ${chatAvatar(chat, { big: true, named: buyerName, dot: false })}
        <span class="chat-head-who-txt">
          <span class="chat-head-name">${esc(chatTitle(chat, buyerName))}${chatModeBadge(chat.mode)}</span>
          <span class="chat-head-sub">${chatPresence(chat)}${chatPlace(chat, chatTitle(chat, buyerName))}</span>
        </span>
        ${CHAT_ICONS.chev}
      </label>
      <form class="chat-ai-back" method="post" action="/admin/chat/${esc(chat.id)}/delete">
        <button class="chat-drop-btn" type="submit" title="Удалить переписку"
          data-confirm="Удалить эту переписку целиком? Она сотрётся насовсем — вернуть будет неоткуда.">${CHAT_ICONS.drop}<span class="sr-only">Удалить переписку</span></button>
      </form>
      ${chat.mode === 'ai' ? '' : `<form class="chat-ai-back" method="post" action="/admin/chat/${esc(chat.id)}/reply">
        <button class="chat-ai-btn" type="submit" name="mode" value="ai" formnovalidate
          title="Дальше отвечает консультант">${CHAT_ICONS.ai}<span class="sr-only">Вернуть консультанта</span></button>
      </form>`}
      ${href ? `<a class="btn btn-sm chat-head-go" href="${esc(href)}">Карточка посетителя →</a>` : ''}
    </div>
    <div class="chat-head-drop">
      <div class="chat-head-meta">${chatMarks(chat, href)}${page}</div>
      ${chatOrdersBox(orders, settings)}
    </div>
    </div>

    ${/* Плашка «Реплика изменена» живёт ВНУТРИ экрана разговора, а не в шапке
         панели: шапки на этой странице нет вовсе, и обычное место плашки
         (`layout`) осталось бы за краем. Класс тот же, поэтому и гаснет она сама
         через пять секунд, и ошибка не гаснет — правило одно на всю панель. */''}
    ${flash ? `<div class="a-flash ok chat-flash">${esc(flash)}</div>` : ''}

    <div class="chat-thread" data-live-part="thread">${lines.join('') || '<p class="muted chat-thread-empty">Пока ни одной реплики.</p>'}</div>

    <form class="chat-answer chat-answer-dock" id="chat-answer" method="post" enctype="multipart/form-data"
      action="/admin/chat/${esc(chat.id)}/reply" data-max-photos="${CHAT.MAX_PHOTOS}">
      ${/* Цитата стоит НАД полем и всегда лежит в разметке, просто скрытая:
           скрипту остаётся подставить в готовые узлы имя и текст. Крестик —
           обычная ссылка на ту же страницу без `?reply=`, поэтому отменить ответ
           можно и там, где скрипты панели не загрузились. */''}
      <div class="chat-answer-reply"${quoteFor ? '' : ' hidden'}>
        <span class="chat-answer-reply-txt">
          <b class="chat-answer-reply-who">${esc(quoteFor ? chatQuoteWho(chat, quoteFor.role, quoteFor.by, buyerName) : '')}</b>
          <span class="chat-answer-reply-text">${esc(quoteFor ? quoteFor.text : '')}</span>
        </span>
        <a class="chat-answer-reply-x" href="/admin/chat/${esc(chat.id)}" title="Не отвечать на реплику" aria-label="Отменить ответ на реплику">
          <svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M7 7l10 10M17 7 7 17" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>
        </a>
        <input type="hidden" name="replyTo" value="${quoteFor ? quoteFor.at : ''}">
      </div>
      ${/* Снимки выбираются до отправки и остаются видны плитками, как в окне
           покупателя. Контейнер рисует сервер, а адреса локальных файлов и
           удаление выбранного держит admin-ui.js — на сервер они попадут
           только вместе с самой репликой. */''}
      <div class="chat-answer-picks" hidden aria-label="Выбранные фотографии"></div>
      <p class="chat-answer-photo-note" role="status" hidden></p>
      <div class="chat-answer-row">
        <input class="chat-answer-file sr-only" id="chat-answer-file" type="file" name="photos"
          accept="image/jpeg,image/png,image/gif,image/webp" multiple>
        <label class="chat-answer-clip" for="chat-answer-file" title="Приложить фото (до ${CHAT.MAX_PHOTOS})">
          ${CHAT_ICONS.clip}<span class="sr-only">Приложить фото</span>
        </label>
        <textarea name="text" rows="1" placeholder="Написать покупателю…" aria-label="Сообщение"
          maxlength="${CHAT.MAX_TEXT}"></textarea>
        <button class="chat-answer-send chat-answer-send-round" type="submit" aria-label="Отправить">
          ${CHAT_ICONS.send}<span class="sr-only">Отправить</span>
        </button>
      </div>
    </form>
  </div>`;

  /* Ни `flash`, ни `actions` в шапку панели не передаём: её на этом экране нет.
   * Плашка уехала внутрь разговора (выше), а к списку ведёт стрелка в его
   * собственной шапке — как в любом мессенджере. */
  return layout(settings, {
    active: 'chat', title: 'Диалог', counts: navCounts(settings, db),
    live: 'chat', app: true,
    body
  });
}

/* Написать покупателю первым.
 *
 * Кнопка ведёт сюда из карточки посетителя и из строки заказа — оттуда, где
 * менеджер и решает написать: «оплата не завершена, спрошу, что случилось».
 * Отдельная страница, а не поле в списке: перед первым сообщением надо видеть,
 * КОМУ пишешь — что человек смотрел, что заказывал и что у него с оплатой.
 *
 * Форма без скриптов: обычный POST, как ответ в диалоге.
 */
function chatNewPage(settings, db, found, flash) {
  const visitor = found.visitor;
  const orders = Array.isArray(found.orders) ? found.orders : [];
  const marks = R.clientMarks({
    place: visitor.city, country: visitor.country, countryCode: visitor.countryCode,
    device: visitor.device, model: visitor.model, os: visitor.os, browser: visitor.browser
  });
  const name = (orders[0] && orders[0].customerName) || '';
  /* Выключенный чат называем прямо здесь, а не после отправки: окна у
   * покупателя нет вовсе, и написанное он не увидит никогда. */
  const off = CHAT.visible(settings) ? '' :
    '<p class="a-flash err">Чат на витрине выключен — покупатель не увидит сообщение. Включите его в «Настройках».</p>';

  const body = `<div class="chat-view">
    ${off}
    ${/* Шапка собрана так же, как у разговора: аватар внутри `.chat-head-who`,
         тексты — в своей обёртке. Раскрытия профиля здесь нет (подробности и
         так стоят ниже, страницу открывают ради них), поэтому это `div`, а не
         подпись-кнопка. */''}
    <div class="chat-head-card">
      <div class="chat-head-who">
        ${chatAvatar({ name: name || 'Посетитель' }, { big: true })}
        <div class="chat-head-who-txt">
          <div class="chat-head-name">${esc(name || 'Посетитель сайта')}</div>
          ${/* Место, а не адрес — то же правило, что в шапке разговора: адрес
               лежит в карточке посетителя, куда ведёт кнопка рядом. */''}
          <div class="chat-head-sub">${chatPlace({ client: visitor }, name)}</div>
        </div>
      </div>
      ${visitor.noCard ? '' : `<a class="btn btn-sm chat-head-go" href="${esc(VISITOR_BASE + encodeURIComponent(visitor.id || visitor.ip))}">Карточка посетителя →</a>`}
    </div>
    <div class="chat-head-meta">${marks}</div>
    ${chatOrdersBox(orders, settings)}

    <form class="chat-answer" method="post" action="/admin/chat/new">
      <input type="hidden" name="to" value="${esc(visitor.id || visitor.ip)}">
      <textarea name="text" rows="3" required autofocus
        placeholder="Написать покупателю…" maxlength="${CHAT.MAX_TEXT}"></textarea>
      <div class="chat-answer-acts">
        <button class="btn btn-primary chat-answer-send" type="submit">Отправить</button>
      </div>
    </form>
  </div>`;

  return layout(settings, {
    active: 'chat', title: 'Написать покупателю', counts: navCounts(settings, db), flash,
    actions: '<a class="btn btn-sm" href="/admin/chat">← Все диалоги</a>',
    body
  });
}

/* ---------- Подробный отчёт по кассам ----------
 *
 * Таблица «Кассы» под списком заказов отвечает на вопрос «как идут дела»:
 * сколько запросов, сколько отказов, каких. Но когда касса четыре раза подряд
 * отдаёт негодные реквизиты, нужен второй вопрос — «покажи, ЧТО именно она
 * прислала», — и на него сводка ответить не может по построению.
 *
 * Поэтому здесь лента ПОПЫТОК, а не заказов: на одном заказе их бывает
 * несколько, и интересны как раз они по отдельности. Каждая строка — один
 * разговор с кассой: что просили, что она ответила и чем это кончилось.
 */

// Сколько попыток показываем за раз. История платежей не удаляется вовсе,
// поэтому предел нужен: страница с тысячей строк и грузится, и читается плохо.
const PAY_LOG_PER_PAGE = 60;

/* Плоский список попыток из всех заказов, свежие сверху.
 *
 * Считается по уже загруженному массиву заказов — второго чтения хранилища тут
 * нет, как и у сводки заказов.
 */
function paymentAttempts(orders) {
  const out = [];
  for (const o of orders || []) {
    const pay = o && o.payment;
    if (!pay) continue;
    const attempts = Array.isArray(pay.attempts) ? pay.attempts : [pay];
    for (const a of attempts) {
      if (!a) continue;
      out.push({
        order: o,
        id: a.id || '',
        provider: a.provider || PAYMENTS.DEFAULT_ID,
        method: a.method || '',
        actualMethod: a.actualMethod || '',
        amount: a.amount, currency: a.currency,
        status: a.status || '',
        invoiceId: a.invoiceId || '',
        requisite: a.requisite || '',
        bank: a.bank || '', owner: a.owner || '',
        rejected: a.rejected || null,
        errorCode: a.lastErrorCode || '',
        tries: a.providerTries || 0,
        at: Number(a.startedAt || a.createdAt || 0) || 0,
        errorAt: Number(a.lastErrorAt || 0) || 0,
        paidAt: Number(a.paidAt || 0) || 0,
        lastCheckedAt: Number(a.lastCheckedAt || 0) || 0,
        lastCheckError: a.lastCheckError || '',
        lastProviderState: a.lastProviderState || '',
        note: a.note || ''
      });
    }
  }
  return out.sort((a, b) => b.at - a.at);
}

/* Наборы отбора. Отвечают на разные вопросы, и «Забракованные» здесь не ради
 * полноты: это единственный набор, где видно САМО значение, присланное кассой,
 * — то, ради чего отчёт и заводился. */
const PAY_LOG_TABS = [
  ['all', 'Все'],
  ['bad', 'Забракованные'],
  ['failed', 'Отказы'],
  ['issued', 'Выданные'],
  ['paid', 'Оплаченные']
];
function payLogTab(value) {
  const key = String(value || '');
  return PAY_LOG_TABS.some(([id]) => id === key) ? key : 'all';
}
function payLogFilter(list, tab) {
  if (tab === 'bad') return list.filter(a => a.rejected && a.rejected.requisite);
  if (tab === 'failed') return list.filter(a => a.errorCode);
  if (tab === 'issued') return list.filter(a => a.invoiceId && a.requisite);
  if (tab === 'paid') return list.filter(a => a.status === 'paid');
  return list;
}

// Чем кончилась попытка — одной плашкой. Тона те же, что у состояний заказа:
// зелёный «получилось», оранжевый «смотрит человек», серый «не вышло».
function payLogResult(a) {
  if (a.status === 'paid') return '<span class="pay-log-tag is-paid">оплачено</span>';
  if (a.status === 'mismatch') {
    return `<span class="pay-log-tag is-bad">нужна проверка</span>${a.note ? `<span class="pay-log-why">${esc(a.note)}</span>` : ''}`;
  }
  if (a.rejected && a.rejected.requisite) {
    return `<span class="pay-log-tag is-bad">забраковано</span><span class="pay-log-why">${esc(PAY.rejectReason(a.rejected.reason))}</span>`;
  }
  if (a.errorCode) {
    return `<span class="pay-log-tag is-fail">отказ</span><span class="pay-log-why">${esc(ERR.shortOf(a.errorCode))}</span>`;
  }
  if (['expired', 'cancelled', 'failed'].includes(a.status)) {
    return `<span class="pay-log-tag is-fail">${a.status === 'expired' ? 'истёк' : (a.status === 'cancelled' ? 'отменён' : 'не оплачен')}</span>`;
  }
  if (a.invoiceId && a.requisite) return '<span class="pay-log-tag is-ok">реквизиты выданы</span>';
  return '<span class="pay-log-tag is-idle">не завершено</span>';
}

function payLogWhen(ms) {
  if (!ms) return '';
  const d = R.mskDate(Number(ms));
  const p = n => String(n).padStart(2, '0');
  return p(d.getDate()) + '.' + p(d.getMonth() + 1) + ' ' + R.mskTime(ms);
}

/* Строка отчёта. Реквизит показываем ЦЕЛИКОМ и у выданных, и у забракованных:
 * прятать его тут незачем — это рабочий инструмент владельца, и ровно за ним
 * сюда и приходят. Покупателю забракованное по-прежнему не показывается нигде.
 */
function payLogRow(a, settings) {
  const req = a.rejected && a.rejected.requisite ? a.rejected : (a.requisite ? a : null);
  const owner = req ? (req.owner || '') : '';
  const bank = req ? (req.bank || '') : '';
  /* Выданный номер набран так же, как на странице оплаты (`requisiteView`):
   * разделители ставит тот же `public/phone.js`. Это не только читаемее — по
   * ним и переносится строка, а голая цепочка цифр рвалась на телефоне посреди
   * номера.
   *
   * ЗАБРАКОВАННЫЙ показываем ровно так, как прислала касса, и ни знаком иначе.
   * Он и забракован за то, что номером не является («987777777777», двенадцать
   * цифр), — расставить в нём разделители значило бы выдать мусор за настоящий
   * реквизит в единственном месте панели, где владелец предъявляет кассе её же
   * ответ. */
  const bad = !!(a.rejected && a.rejected.requisite);
  const shown = req ? (bad ? req.requisite : R.requisiteView(a.method, req.requisite).text) : '';
  // Что касса выдала вместо запрошенного — только если это правда другое.
  const gave = PAY.actualHint(a.method, a.actualMethod);
  const checked = a.lastCheckedAt
    ? `<div class="muted small">сверено ${esc(payLogWhen(a.lastCheckedAt))}${a.lastCheckError ? ` · ошибка ${esc(a.lastCheckError)}` : ''}</div>` : '';
  return `<tr class="pay-log-row${bad ? ' is-bad' : ''}">
    <td data-l="Когда"><span class="pay-log-at">${esc(payLogWhen(a.at))}</span></td>
    <td data-l="Заказ"><a href="/admin/orders?q=${encodeURIComponent(a.order.number || '')}#order-${esc(a.order.id)}">${esc(R.orderNo(a.order.number))}</a></td>
    <td data-l="Касса">${esc(PAYMENTS.nameOf(a.provider))}</td>
    <td data-l="Способ">${esc(PAY.describe(a.method).name)}${gave
      ? `<div class="muted small">касса дала ${esc(gave)}</div>` : ''}</td>
    <td data-l="Сумма">${esc(PAY.formatAmount(a.amount, a.currency))}</td>
    <td data-l="Реквизит">${req
      ? `<b class="pay-log-req">${esc(shown)}</b>`
        + (owner || bank ? `<div class="muted small">${esc([owner, bank].filter(Boolean).join(' · '))}</div>` : '')
      : '<span class="muted">—</span>'}</td>
    <td data-l="Итог">${payLogResult(a)}${checked}</td>
  </tr>`;
}

function paymentsPage(settings, db, opts) {
  const o = opts || {};
  const orders = typeof db.getOrders === 'function' ? db.getOrders() : [];
  const all = paymentAttempts(orders);
  const tab = payLogTab(o.tab);
  const list = payLogFilter(all, tab);
  const slice = R.adminSlice(list, o.page, PAY_LOG_PER_PAGE);
  const href = n => '/admin/payments?tab=' + tab + (n > 1 ? '&page=' + n : '');
  const pager = R.adminPager(slice, href);

  // Счётчик у каждого набора: «Забракованные 4» — это и есть ответ на вопрос,
  // с которым сюда пришли, и он должен быть виден до всякого нажатия.
  const tabs = PAY_LOG_TABS.map(([id, label]) => {
    const n = payLogFilter(all, id).length;
    return `<a class="a-tab${tab === id ? ' active' : ''}" href="/admin/payments?tab=${id}">${esc(label)}${n ? ` <b>${n}</b>` : ''}</a>`;
  }).join('');

  const stats = R.providerStats(orders);
  // `report: false` убирает ссылку «Подробный отчёт» — мы уже на нём.
  const body = `${R.providerStatsBar(stats, { report: false })}
  <div class="a-panel a-panel-list">
    <div class="a-panel-head"><div class="a-tabs">${tabs}</div></div>
    ${slice.items.length ? `<div class="a-table-wrap"><table class="a-table pay-log">
      <thead><tr><th>Когда</th><th>Заказ</th><th>Касса</th><th>Способ</th><th>Сумма</th><th>Реквизит</th><th>Итог</th></tr></thead>
      <tbody>${slice.items.map(a => payLogRow(a, settings)).join('')}</tbody>
    </table></div>${pager}`
      : '<p class="muted">Здесь пока пусто.</p>'}
  </div>`;

  return layout(settings, {
    active: 'orders', title: 'Отчёт по кассам', counts: navCounts(settings, db),
    flash: o.flash, live: 'orders', wide: true,
    actions: '<a class="btn btn-sm" href="/admin/orders">← Заказы</a>',
    body
  });
}

function analyticsPage(settings, db, snapshot) {
  const products = {}; db.getProducts().forEach(p => { products[p.id] = p.name; });
  const body = AV.dashboard(snapshot, { products, rangeBase: '/admin/analytics?days=', ordersHref: '/admin/orders', visitorBase: VISITOR_BASE, visitorsHref: VISITORS_BASE });
  // Метрика меняется чаще всего: посетитель ходит по витрине прямо сейчас.
  // Заявки здесь тоже показаны (столбец «Заявка» у посетителя), поэтому тема
  // заказов идёт вместе с ней.
  return layout(settings, { active: 'analytics', title: 'Метрика', counts: navCounts(settings, db), wide: true, live: 'analytics orders', body });
}

/* «Кто заходил» — своя страница, а не блок отчёта: у неё свой период (любой
 * отрезок за год хранения, а не 1/7/30 дней метрики), свой отбор по технике и
 * источнику и своя листалка. В отчёте всё это стояло бы ниже графиков.
 * Отбор и сортировку считает `metrics.queryVisitors()`; сюда приходит готовый
 * результат вместе с тем, чем отобрано, — представление ничего не решает само.
 */
function visitorsPage(settings, db, result, opts) {
  opts = opts || {};
  const products = {}; db.getProducts().forEach(p => { products[p.id] = p.name; });
  const body = AV.visitorsPage(result, Object.assign({
    products, base: VISITORS_BASE, backHref: '/admin/analytics',
    ordersHref: '/admin/orders', visitorBase: VISITOR_BASE
  }, opts));
  return layout(settings, { active: 'analytics', title: 'Кто заходил', counts: navCounts(settings, db), wide: true, live: 'analytics orders', body });
}

// Карточка одного посетителя: вся его история посещений. Открывается по клику
// на IP или значки в строке заказа и по строке в таблице метрики.
function visitorPage(settings, db, visitor, opts) {
  opts = opts || {};
  const products = {}; db.getProducts().forEach(p => { products[p.id] = p.name; });
  /* Кнопка «Написать» ведёт в чат с этим человеком — разговор с ним начинают
   * именно отсюда, глядя на то, что он смотрел и что заказал. Разговор уже
   * идёт — ведём в него, а не заводим второй: окно чата у покупателя одно.
   *
   * Чат выключен — кнопки нет вовсе: она вела бы к сообщению, которого никто не
   * увидит (то же правило, по которому у распроданного товара нет «в корзину»). */
  const started = visitor && CHAT.visible(settings) ? CHAT.byVisitorId(visitor.id) : null;
  const body = visitor
    ? AV.visitorPage(visitor, {
      products, backHref: '/admin/analytics', ordersHref: '/admin/orders', visitorBase: VISITOR_BASE,
      orders: opts.orders || [], alsoOnIp: opts.alsoOnIp || [], moneySettings: settings,
      chatHref: CHAT.visible(settings)
        ? (started ? '/admin/chat/' + encodeURIComponent(started.id) : '/admin/chat/new?to=' + encodeURIComponent(visitor.id))
        : '',
      chatLabel: started ? 'Открыть диалог' : 'Написать в чат'
    })
    : AV.visitorMissing(opts.key || '', { backHref: '/admin/analytics' });
  return layout(settings, { active: 'analytics', title: 'Посетитель', counts: navCounts(settings, db), wide: true, live: 'analytics orders', body });
}

/* ---------------------- Кассы: валюта счёта и способы ----------------------
 *
 * И то и другое приходит ЖИВЫМ ответом касс, а не берётся из зашитого списка: у
 * кассы способ могли включить или выключить, а встроенный список правится только
 * выкаткой. Отвечают обе, и их возможности ОБЪЕДИНЯЮТСЯ — способ доступен, если
 * его умеет хотя бы одна.
 *
 * Не ответил никто (ключей нет, оплата выключена, сеть) — показываем встроенный
 * список и прямо об этом говорим.
 */

// Что показать в списке способов: объединение трёх наборов — включённого у
// кассы, нашего закрытого и уже отмеченного владельцем. Последнее обязательно:
// иначе способ, который касса временно выключила, исчез бы из формы и первым же
// «Сохранить» пропал бы из настроек молча.
function payMethodRows(shown, live) {
  const cassa = live ? Object.keys(live.byCurrency).reduce((all, cur) => all.concat(live.byCurrency[cur]), []) : [];
  const ids = [];
  for (const id of PAY.METHODS.map(m => m.id).concat(cassa, shown)) {
    if (id && !ids.includes(id)) ids.push(id);
  }
  return ids.map(id => {
    const m = PAY.describe(id);
    // В каких валютах этот способ включён — показываем, только когда валют
    // больше одной: иначе это «RUB» у каждой строки и чистый шум.
    const where = live && live.currencies.length > 1
      ? live.currencies.filter(c => live.byCurrency[c].includes(id)) : [];
    // Какие кассы умеют этот способ. Строка «СБП · CrocoPAY, MeridianPay»
    // отвечает на единственный вопрос, который здесь и задают: есть ли у него
    // подстраховка. Способ, который умеет одна касса, при её отказе просто не
    // сработает — и знать это лучше заранее, чем по жалобе покупателя.
    const via = live && live.byProvider
      ? Object.keys(live.byProvider).filter(pid => {
        const own = live.byProvider[pid];
        return own && Object.keys(own.byCurrency).some(c => own.byCurrency[c].includes(id));
      }).map(pid => PAYMENTS.nameOf(pid))
      : [];
    return {
      id, name: m.name, hint: m.hint,
      // Кассы ответили, и этого способа нет ни у одной: строку оставляем (выбор
      // владельца не теряем), но говорим, что на витрину он не попадёт.
      off: !!live && !cassa.includes(id),
      fresh: !!m.unknown,
      where, via
    };
  });
}

/* Пояснительных подсказок в этом разделе нет намеренно — их убрали все.
 *
 * Состояние по-прежнему читается, но не абзацами, а самой строкой способа:
 * пометки «новый у кассы» / «нет у касс» и перечисленные рядом кассы говорят то
 * же, что говорил абзац под списком. Ошибка «не отмечен ни один способ» —
 * не подсказка, а отказ, и остаётся на месте.
 */
function payMethodsSection(shown, live) {
  const rows = payMethodRows(shown, live);
  return `<h3 class="a-subhead">Способы оплаты на витрине</h3>
      <input type="hidden" name="payMethodsForm" value="1">
      <div class="pay-methods-grid">${rows.map(r => `<label class="pay-method-check${r.off ? ' is-off' : ''}">
        <input type="checkbox" name="payMethods" value="${esc(r.id)}"${shown.includes(r.id) ? ' checked' : ''}>
        <span><b>${esc(r.name)}${r.fresh ? '<em class="pay-method-tag">новый у кассы</em>' : ''}${r.off ? '<em class="pay-method-tag pay-method-tag-off">нет у касс</em>' : ''}</b>
        <i>${esc(r.hint)}${r.where.length ? ' · ' + esc(r.where.join(', ')) : ''}${r.via.length ? ' · ' + esc(r.via.join(', ')) : ''}</i></span></label>`).join('')}</div>
      ${shown.length ? '' : '<p class="form-msg err">Не отмечен ни один способ — оплатить на витрине будет нечем.</p>'}`;
}

// Валюта счёта и курс к рублю. Цены каталога рублёвые всегда: пересчитывается
// только сумма счёта, и курс задаёт владелец — внешних источников курса у
// проекта нет и заводить их ради этого незачем.
function payCurrencySection(s, saved, draft, live, checked) {
  const base = PAY.BASE;
  const picked = PAY.currencyCode(s.crocopayCurrency) || base;
  const list = [];
  for (const c of [base, picked].concat(live ? live.currencies : [])) {
    const code = PAY.currencyCode(c);
    if (code && !list.includes(code)) list.push(code);
  }
  const rates = Object.assign({}, saved.crocopayRates || {});
  // Курс введён только что и форма вернулась с ошибкой — показываем введённое.
  if (draft) for (const code of list) {
    if (draft['payrate:' + code] !== undefined) rates[code] = draft['payrate:' + code];
  }
  const rateRows = list.filter(c => c !== base).map(c => `<div class="field">
          <label for="payrate-${esc(c)}">Курс: 1 ${esc(PAY.currencySymbol(c))} = ? ₽</label>
          <input id="payrate-${esc(c)}" name="payrate:${esc(c)}" inputmode="decimal" autocomplete="off"
            value="${esc(rates[c] === undefined || rates[c] === null ? '' : String(rates[c]))}" placeholder="пусто — валюта недоступна"></div>`).join('');
  return `<h3 class="a-subhead">Валюта счёта</h3>
      <div class="a-form-grid">
        <div class="field"><label for="pay-currency">Валюта по умолчанию</label>
          <select id="pay-currency" name="crocopayCurrency">${list.map(c =>
            `<option value="${esc(c)}"${c === picked ? ' selected' : ''}>${esc(c)} — ${esc(PAY.currencyName(c))}</option>`).join('')}</select></div>
        <div class="field field-check"><label><input type="checkbox" name="crocopayCurrencyChoice"${checked('crocopayCurrencyChoice', !!saved.crocopayCurrencyChoice) ? ' checked' : ''}> Показывать покупателю выбор валюты</label></div>
      </div>
      ${rateRows ? `<div class="a-form-grid">${rateRows}</div>` : ''}`;
}

/*
 * Что витрина делает ПРЯМО СЕЙЧАС — одной плашкой над настройками кассы.
 *
 * Галочка отвечает на вопрос «включать ли оплату», а плашка — на вопрос «что
 * увидит покупатель», и это не одно и то же: включённая галочка без ключей
 * оставляет витрину в режиме заявок. Поэтому спрашиваем ту же `CROCO.enabled()`,
 * по которой решает и сама витрина, а не читаем галочку из настроек.
 *
 * Про пределы суммы плашка говорит намеренно: они принадлежат кассе, и вместе с
 * ней исчезают — на витрине это видно сразу (дорогие товары перестают быть
 * «Нет в наличии»), и объяснить это лучше здесь, чем оставить догадкам.
 */
/* Плашка режима — теперь ровно состояние, без объяснений.
 *
 * Раньше под жирной строкой шли три-четыре предложения про то, что увидит
 * покупатель и откуда берутся пределы суммы. Это подсказка: её читают один раз,
 * а видят каждый день. Осталось только то, чего иначе не узнать: включена
 * оплата или нет и какие кассы работают — с одной включённой подстраховать её
 * некому, и это стоит того, чтобы стоять на виду.
 */
function payModeNote(settings, health) {
  const on = PAYMENTS.enabledProviders(settings);
  if (!on.length) {
    // Своими реквизитами витрина принимает деньги без всякой кассы, и владелец
    // должен видеть это здесь же: «заявки без оплаты» было бы неправдой.
    if (PAYMENTS.ownEnabled(settings)) {
      const own = PAYMENTS.ownRequisites(settings);
      const what = [own.phone ? 'СБП' : '', own.card ? 'карта' : ''].filter(Boolean).join(' и ');
      return `<p class="pay-mode is-on"><b>Сейчас: перевод по своим реквизитам.</b> Покупатель видит их на странице оплаты (${esc(what)}), а оплату вы отмечаете в заказах сами.</p>`;
    }
    return '<p class="pay-mode is-off"><b>Сейчас: заявки без оплаты.</b></p>';
  }
  // «Работают обе кассы» здесь стояло раньше и было неправдой ровно в том
  // случае, ради которого плашку и читают: включённая касса с ключами могла не
  // отвечать вовсе. Считаем по живому ответу, а не по галочкам.
  const asked = (health || []).filter(r => r.on && r.ready && r.state !== 'unknown');
  const live = asked.filter(r => r.live);
  const names = list => esc(list.map(r => r.name).join(' и '));
  // Кассы не спрашивали вовсе (страницу собрали без живого ответа) — тогда
  // говорим только про то, что знаем наверняка: какие кассы ВКЛЮЧЕНЫ. Написать
  // «на связи», не спросив, — ровно та ложь, от которой мы здесь и уходим.
  if (!asked.length) {
    const crew = on.length > 1
      ? `Включены обе кассы: ${esc(on.map(p => p.name).join(' и '))}.`
      : `Включена одна касса — ${esc(on[0].name)}, подстраховки нет.`;
    return `<p class="pay-mode is-on"><b>Сейчас: оплата на витрине.</b> ${crew}</p>`;
  }
  // Медленная касса — не молчащая: её ответ идёт своим ходом и приедет к
  // следующему открытию страницы (список банков у MeridianPay честно занимает
  // восемь секунд). Сказать про неё «не отвечает» значило бы звать чинить то,
  // что чинить не нужно.
  const waiting = asked.filter(r => !r.live);
  const slowOnly = waiting.length > 0 && waiting.every(r => r.state === 'slow');
  if (!live.length) {
    return slowOnly
      ? `<p class="pay-mode is-off"><b>Сейчас: оплата на витрине.</b>
      Кассы ещё не ответили — обновите страницу через несколько секунд.</p>`
      : `<p class="pay-mode is-off"><b>Сейчас: оплата на витрине, но ни одна касса не отвечает.</b>
      ${on.length > 1 ? 'Молчат обе' : 'Молчит ' + esc(on[0].name)} — покупатель реквизитов не получит.</p>`;
  }
  const crew = live.length > 1
    ? `На связи обе кассы: ${names(live)}.`
    : on.length > 1
      ? (slowOnly
        ? `На связи ${names(live)}, вторая ещё не ответила.`
        : `На связи только ${names(live)} — вторая не отвечает.`)
      : `Работает одна касса — ${names(live)}, подстраховки нет.`;
  return `<p class="pay-mode is-on"><b>Сейчас: оплата на витрине.</b> ${crew}</p>`;
}

/* Диапазон суммы одного заказа.
 *
 * Числа принадлежат КАССЕ: за своими границами она платёж не проведёт. Но какие
 * они у конкретной кассы — знает только владелец, поэтому поля правятся здесь, а
 * не в коде. От потолка зависит не только оплата: товар дороже него на витрине
 * становится «Нет в наличии», и поднятие потолка возвращает в продажу дорогую
 * технику.
 *
 * Пустое поле возвращает значение по умолчанию, а не снимает предел: молча
 * снятый потолок означал бы заказы, которые касса не проведёт.
 */
/* Плавающие цены: включатель, разброс и период.
 *
 * Отдельной панелью, а не внутри «Оплаты»: колебание касается КАТАЛОГА, а не
 * денег кассы, и включают его те же руки, что правят цены товаров.
 *
 * Строка состояния показывает не настройки, а их следствие — во что превращается
 * пример цены прямо сейчас. Проценты и минуты по отдельности ни о чём не
 * говорят: владельцу нужно увидеть ценник, который увидит покупатель.
 */
function priceFloatSection(s, settings, checked) {
  const on = checked('priceFloat', !!settings.priceFloat);
  const c = PF.conf(s);
  const num = (name, fallback) => esc(String(s[name] === undefined || s[name] === '' ? fallback : s[name]));
  // Пример считается тем же кодом, что и витрина, и по вымышленному товару:
  // брать настоящий незачем, а число должно быть узнаваемым.
  const sample = { id: 'sample', price: 67990 };
  const now = PF.priceOf(sample, Object.assign({}, s, { priceFloat: true }));
  const note = on
    ? `Сейчас цена <b>${R.money(67990, settings)}</b> показывалась бы как <b>${R.money(now, settings)}</b>, и меняется раз в ${c.minutes} мин.`
    : 'Выключено: покупатель видит ровно те цены, которые заданы в каталоге.';
  return `<p class="pay-mode-note">${note}</p>
    <label class="switch-row"><input type="checkbox" name="priceFloat"${on ? ' checked' : ''}><span>Менять цены товаров автоматически</span></label>
    <div class="a-form-grid">
      <div class="field"><label for="pf-min">Разброс от</label>
        <div class="price-field"><input id="pf-min" name="priceFloatMin" inputmode="decimal" autocomplete="off"
          value="${num('priceFloatMin', PF.DEFAULTS.min)}" placeholder="${PF.DEFAULTS.min}"><span>%</span></div></div>
      <div class="field"><label for="pf-max">Разброс до</label>
        <div class="price-field"><input id="pf-max" name="priceFloatMax" inputmode="decimal" autocomplete="off"
          value="${num('priceFloatMax', PF.DEFAULTS.max)}" placeholder="${PF.DEFAULTS.max}"><span>%</span></div></div>
      <div class="field"><label for="pf-min-utes">Менять раз в</label>
        <div class="price-field"><input id="pf-min-utes" name="priceFloatMinutes" inputmode="numeric" autocomplete="off"
          value="${num('priceFloatMinutes', PF.DEFAULTS.minutes)}" placeholder="${PF.DEFAULTS.minutes}"><span>мин</span></div></div>
    </div>
    <p class="field-hint">Проценты добавляются к цене товара и только вверх: ниже цены из каталога ценник не опускается никогда. Цена остаётся круглой — ${R.money(15990, settings)}, ${R.money(16490, settings)}, — поэтому у дешёвых товаров она может не меняться вовсе: между двумя такими числами разрыв больше разрешённого процента, а выходить за него нельзя. Отдельный товар исключается галочкой «Не менять цену автоматически» в его карточке. Оформленный заказ колебание не трогает: цена в нём зафиксирована.</p>`;
}

// Свёрнутая строка раздела: во что превращается настройка, а не её описание.
function priceFloatNote(s, settings, checked) {
  if (!checked('priceFloat', !!settings.priceFloat)) return 'выключены — цены ровно из каталога';
  const c = PF.conf(s);
  // Дробные проценты пишем по-русски, через запятую: строка читается глазами,
  // а не разбирается кодом.
  const pct = n => String(n).replace('.', ',');
  return `включены · +${pct(c.min)}–${pct(c.max)}% раз в ${c.minutes} мин`;
}

function payLimitsSection(s, draft) {
  const value = (field, fallback) => {
    if (draft && draft[field] !== undefined) return String(draft[field]);
    const saved = Number(s[field]);
    return String(Number.isFinite(saved) && saved > 0 ? saved : fallback);
  };
  return `<h3 class="a-subhead">Сумма одного заказа</h3>
      <div class="a-form-grid">
        <div class="field"><label for="pay-min">Минимальная сумма, ₽</label>
          <input id="pay-min" name="payMinTotal" inputmode="numeric" autocomplete="off"
            value="${esc(value('payMinTotal', PAYMENTS.MIN_TOTAL))}" placeholder="${PAYMENTS.MIN_TOTAL}"></div>
        <div class="field"><label for="pay-max">Максимальная сумма, ₽</label>
          <input id="pay-max" name="payMaxTotal" inputmode="numeric" autocomplete="off"
            value="${esc(value('payMaxTotal', PAYMENTS.MAX_TOTAL))}" placeholder="${PAYMENTS.MAX_TOTAL}"></div>
      </div>`;
}

/* Включение касс — ОДНОЙ строкой и до всяких ключей.
 *
 * Это единственное решение в разделе, которое принимают часто: включить,
 * выключить, посмотреть, что сейчас работает. Оно обязано быть видно, ничего не
 * раскрывая. Раньше галочки лежали внутри свёрток, и чтобы включить кассу, надо
 * было сперва раскрыть строку «выключена» — то есть открыть секцию с ключами
 * ради того, чтобы ключей не трогать.
 *
 * Рядом друг с другом они ещё и сравниваются: «обе включены» видно одним
 * взглядом, а это и есть ответ на вопрос «есть ли у меня подстраховка».
 */
function payProviderSwitches(settings, checked) {
  const row = (id, label, field, on) => `<label class="pay-switch">
          <input type="checkbox" name="${esc(field)}"${checked(field, on) ? ' checked' : ''}> ${esc(label)}</label>`;
  return `<div class="pay-switches">
        ${row('crocopay', 'CrocoPAY', 'crocopayEnabled', !!settings.crocopayEnabled)}
        ${row('meridianpay', 'MeridianPay', 'meridianpayEnabled', !!settings.meridianpayEnabled)}
      </div>`;
}

/* Свои реквизиты — оплата без кассы вовсе.
 *
 * Стоит сразу под галочками касс, потому что отвечает на тот же вопрос «чем
 * витрина принимает деньги», и работает, только когда обе кассы выключены: их
 * сверка надёжнее ручной отметки (см. lib/payments.js).
 *
 * Свёрнуто, пока реквизиты заданы и режим не включён: это чужие платёжные
 * данные, держать их развёрнутыми на экране незачем. Раскрыто — когда режим
 * включён или заполнить ещё нечего.
 */
function ownPayFields(settings, s) {
  const own = PAYMENTS.ownRequisites(settings);
  const active = PAYMENTS.ownEnabled(settings);
  const state = active ? 'принимаем перевод на них'
    : own.on && !own.ready ? 'не хватает реквизитов'
      : own.on ? 'включатся, когда выключите кассы' : 'выключены';
  const open = own.on && (!own.ready || active) ? ' open' : '';
  return `<details class="pay-fold"${open}>
      <summary><b>Свои реквизиты</b><span class="pay-fold-note">${esc(state)}</span></summary>
      <div class="pay-fold-body">
      ${own.on && !own.ready
        ? '<p class="form-msg err">Нужны имя получателя и хотя бы один реквизит — карта или телефон.</p>' : ''}
      <label class="pay-switch"><input type="checkbox" name="ownPayEnabled"${settings.ownPayEnabled ? ' checked' : ''}> Принимать перевод по своим реквизитам</label>
      <div class="a-form-grid">
        <div class="field"><label>Номер карты</label>
          <input name="ownPayCard" value="${esc(s.ownPayCard || '')}" inputmode="numeric" autocomplete="off" spellcheck="false" placeholder="0000 0000 0000 0000"></div>
        <div class="field"><label>Телефон для СБП</label>
          <input name="ownPayPhone" type="tel" value="${esc(s.ownPayPhone || '')}" autocomplete="off" placeholder="+7 900 000-00-00"></div>
        <div class="field"><label>Получатель</label>
          <input name="ownPayOwner" value="${esc(s.ownPayOwner || '')}" autocomplete="off" placeholder="Фамилия Имя Отчество"></div>
        <div class="field"><label>Банк получателя</label>
          <input name="ownPayBank" value="${esc(s.ownPayBank || '')}" autocomplete="off" placeholder="по желанию"></div>
      </div></div>
    </details>`;
}

/* ---------------------------- Состояние касс ----------------------------
 *
 * Раньше на этот вопрос отвечала одна строка «работает», и означала она ровно
 * одно: ключи в настройках заполнены. Касса при этом могла не отвечать вовсе,
 * отвергать ключи или (как MeridianPay всё время модерации) отвечать на всё,
 * кроме создания сделок, — панель писала «работает» одинаково бодро. Владелец
 * узнавал правду от покупателя.
 *
 * Теперь строк две, и каждая отвечает на свой вопрос:
 *   СВЯЗЬ — живой ответ кассы на тот самый список способов, который и так
 *     спрашивается для витрины. Лишнего запроса это не стоит ни одного;
 *   СДЕЛКИ — что касса РЕАЛЬНО сделала в последний раз: выдала реквизиты или
 *     отказала, и когда. Иначе про это узнать нечем: проверить создание сделки
 *     можно только настоящей сделкой (проверено на живом API 24 августа 2026 —
 *     GET и отмена отвечают обычным 404, а POST сперва проверяет поля), а
 *     дёргать кассу проверочными сделками мы намеренно не стали.
 *
 * Отсюда же самая важная строка для кассы, которую ещё ни разу не спрашивали:
 * «сделок ещё не выдавала». Она честно говорит, что связь — это ещё не оплата.
 */
const PAY_STATE_TEXT = {
  off: ['off', 'выключена'],
  nokeys: ['err', 'ключи не заданы'],
  auth: ['err', 'ключи не приняты кассой'],
  down: ['err', 'касса не отвечает'],
  slow: ['warn', 'касса отвечает слишком медленно — список ещё грузится'],
  error: ['warn', 'касса ответила ошибкой'],
  unknown: ['off', 'не спрашивали']
};
function payLinkState(row) {
  if (row.state === 'ok') {
    const n = row.methods.length;
    return ['ok', `на связи · ${n} ${R.pluralRu(n, 'способ', 'способа', 'способов')}`];
  }
  const [tone, text] = PAY_STATE_TEXT[row.state] || PAY_STATE_TEXT.unknown;
  // Текст ошибки от кассы дописываем как есть: он приходит от неё по-русски
  // («Мерчант находится на модерации.») или по-английски, и пересказывать его
  // своими словами тут нечем — словарь отвечает за отказы по сделкам, а не за
  // ответы на список способов.
  return [tone, row.state === 'error' && row.error ? `${text}: ${row.error}` : text];
}

/* Что касса сделала в последний раз — из истории заказов, а не из опроса.
 *
 * `merchant_off` («Мерчант находится на модерации») выделен красным намеренно:
 * это единственный отказ, который НЕ лечится ни другим способом оплаты, ни
 * ожиданием пары минут, и владелец должен отличать его от «нет свободных
 * реквизитов» с одного взгляда.
 */
// Момент для строки состояния: с годом и временем. Год здесь обязателен — в
// строке заказа рядом стоит его дата, и `R.payMoment()` обходится без года, а
// в настройках взять его неоткуда: «23.08 в 19:12» может оказаться прошлогодним.
function payWhen(ms) {
  return Number(ms) ? R.mskDateTime(ms) : '';
}
function payDealsNote(stat) {
  if (!stat) return ['off', 'сделок ещё не выдавала'];
  const failedLast = stat.lastErrorCode && stat.lastErrorAt >= stat.lastIssuedAt;
  if (failedLast) {
    const tone = stat.lastErrorCode === 'merchant_off' ? 'err' : 'warn';
    return [tone, `последний ответ на сделку: ${ERR.shortOf(stat.lastErrorCode)} · ${payWhen(stat.lastErrorAt)}`];
  }
  if (stat.lastIssuedAt) return ['ok', `последний счёт выдан ${payWhen(stat.lastIssuedAt)}`];
  return ['off', 'сделок ещё не выдавала'];
}


/* Ключи одной кассы: свёртка, которую открывают раз в жизни.
 *
 * Свёрнутое содержимое браузер отправляет так же, как открытое, поэтому поля
 * внутри не теряются (та же грабля, что со строкой «нет у касс» в списке
 * способов).
 *
 * Раскрыта она РОВНО ТОГДА, когда с ней что-то не так: касса включена, а ключей
 * нет. В остальных случаях закрыта — ключи это секреты, и держать их развёрнутыми
 * на экране незачем, а две открытые секции подряд растягивают страницу настроек
 * вдвое.
 *
 * СВЁРНУТАЯ СТРОКА И ЕСТЬ СОСТОЯНИЕ КАССЫ — две строки, по вопросу на каждую:
 * связь сверху, сделки снизу. Отдельным блоком над свёртками это стояло ровно
 * один заход и было выброшено: строки повторяли подписи свёрток слово в слово,
 * и на четыре строки экрана приходилось два факта.
 *
 * «Работает» из подписи ушло вместе с причиной, по которой оно там стояло: оно
 * означало «ключи заполнены», а читалось как «касса выдаёт реквизиты».
 */
function payProviderFold(row, stat, body) {
  const [tone, state] = payLinkState(row);
  const [dealTone, deals] = payDealsNote(stat);
  // Про сделки молчим у выключенной и ненастроенной кассы: там нечего было
  // спрашивать, и «сделок ещё не выдавала» читалось бы упрёком.
  const showDeals = row.state !== 'off' && row.state !== 'nokeys';
  // Раскрыта, когда с ключами что-то не так: их нет или касса их не приняла.
  // Работающую держать открытой незачем — ключи это секреты.
  const open = row.on && (!row.ready || row.state === 'auth');
  return `<details class="pay-fold is-${esc(tone)}"${open ? ' open' : ''}>
        <summary><b>${esc(row.name)}</b><span class="pay-fold-note">${esc(state)}</span>${
  showDeals ? `<i class="is-${esc(dealTone)}">${esc(deals)}</i>` : ''}</summary>
        <div class="pay-fold-body">${body}</div>
      </details>`;
}

/* Какую кассу спрашивать первой.
 *
 * Показывается ВСЕГДА, при любом числе включённых касс. Была попытка прятать
 * выбор, пока включена одна, — «с одной кассой очередь состоит из неё же». Со
 * стороны это выглядит не как экономия места, а как пропавшая настройка: пока
 * вторая касса ждёт модерации, порядок задают заранее, и найти его на странице
 * надо тогда же, а не после того, как она заработает.
 *
 * Порядок виден только нам: покупатель в любом случае получает реквизиты от той
 * кассы, которая их дала. Ставят первой обычно ту, где ниже комиссия или полнее
 * пул реквизитов.
 */
function payPrimarySection(s) {
  const picked = PAYMENTS.providerIds().includes(String(s.payPrimary || '')) ? s.payPrimary : PAYMENTS.DEFAULT_ID;
  return `<h3 class="a-subhead">Порядок опроса</h3>
      <div class="a-form-grid">
        <div class="field"><label for="pay-primary">Спрашивать первой</label>
          <select id="pay-primary" name="payPrimary">${PAYMENTS.PROVIDERS.map(p =>
    `<option value="${esc(p.id)}"${p.id === picked ? ' selected' : ''}>${esc(p.name)}</option>`).join('')}</select></div>
      </div>`;
}

// Все настройки магазина на одной странице: бренд, оформление, реквизиты
// оператора, Telegram, доступ, подсказки адресов и касса. Раньше первые пять
// секций жили в админке домена, а последние две — у владельца.
//
// `opts.draft` — то, что админ только что отправил с ошибкой: форма возвращается
// с введённым, а не с сохранённым, иначе правка теряется целиком.
/* Состояние чата словами.
 *
 * Отвечает на два разных вопроса, и оба нужны: ОТВЕЧАЕТ ЛИ кто-нибудь
 * покупателю (ИИ, менеджер или никто) и ДОХОДЯТ ЛИ диалоги до Telegram. Второе
 * само себя не проявляет: бот может быть настроен, но не быть админом группы —
 * и тогда кнопка на витрине висит, покупатель пишет, а менеджер не видит
 * ничего. Ровно та же беда, что с ImageMagick, и лечится она так же — тем, что
 * причина названа вслух.
 */
/* Строки состояния и короткая подпись раздела считаются ЗДЕСЬ ЖЕ, одним
 * проходом. Первая строка отвечает на главный вопрос — кто отвечает покупателю,
 * — и её короткая форма (`short`) уезжает в свёрнутую шапку раздела. Написать
 * подпись вторым местом значило бы завести второй ответ на тот же вопрос: они
 * разъехались бы на первой правке, а увидеть это можно только глазами.
 */
function chatStateRows(settings) {
  const on = CHAT.visible(settings);
  const ai = AI.enabled(settings);
  const tg = TGCHAT.configured(settings);
  const state = TGCHAT.state;
  const rows = [];
  const row = (tone, text, short) => rows.push({ tone, text, short });

  if (!settings.chatEnabled) row('off', 'Чат выключен — кнопки на витрине нет.', 'выключен — кнопки на витрине нет');
  else if (!on) row('err', 'Чат включён, но отвечать некому: нет ни ключа OpenAI, ни Telegram-бота с группой.', 'включён, но отвечать некому');
  // Тон здесь несёт смысл: работают оба собеседника — зелёный; работает один —
  // жёлтый, потому что половина схемы отсутствует и владелец должен это видеть,
  // а не читать зелёную строку с оговоркой в конце.
  else if (ai && tg) row('ok', 'Отвечает ИИ, диалоги идут в Telegram — оператор может подключиться.', 'отвечает консультант, диалоги идут в Telegram');
  else if (ai) row('warn', 'Отвечает ИИ, но Telegram не настроен: подключиться к разговору и ответить самому будет негде.', 'отвечает консультант, Telegram не настроен');
  else if (AI.configured(settings)) row('warn', 'Консультант выключен — на вопросы отвечает только менеджер в Telegram, покупатель ждёт живого ответа.', 'консультант выключен — отвечает только менеджер');
  else row('warn', 'ИИ не настроен — на вопросы отвечает только менеджер в Telegram, покупатель ждёт живого ответа.', 'консультант не настроен — отвечает только менеджер');

  if (settings.chatEnabled && tg) {
    if (state.error) row('err', 'Telegram: ' + state.error);
    else if (state.topics === false) row('err', 'Темы в группе не создаются — диалоги идут одной лентой. Проверьте, что это супергруппа с включёнными темами и бот в ней администратор.');
    else if (state.running) {
      row('ok', 'Бот на связи' + (state.bot ? ' (' + esc(state.bot) + ')' : '')
        + (state.topics ? ', темы создаются' : '') + '.');
    } else row('warn', 'Приём сообщений из Telegram ещё не запустился.');
  }
  return rows;
}
function chatStateNote(settings) {
  return `<div class="chat-state">${chatStateRows(settings).map(r =>
    `<p class="chat-state-row is-${r.tone}">${esc(r.text)}</p>`).join('')}</div>`;
}

function chatSection(s, settings, checked) {
  return `${chatStateNote(settings)}
      <div class="field field-check"><label><input type="checkbox" name="chatEnabled" ${checked('chatEnabled', settings.chatEnabled) ? 'checked' : ''}> Показывать чат на витрине</label></div>
      <div class="field field-check"><label><input type="checkbox" name="aiEnabled" ${checked('aiEnabled', settings.aiEnabled !== false) ? 'checked' : ''}> Консультант отвечает сам</label></div>
      <div class="a-form-grid">
        <div class="field"><label>Возврат консультанта, минут</label>
          <input name="aiTakeoverMinutes" inputmode="numeric" autocomplete="off"
            value="${esc(s.aiTakeoverMinutes === 0 || s.aiTakeoverMinutes ? String(s.aiTakeoverMinutes) : '')}"
            placeholder="${CHAT.TAKEOVER_DEFAULT_MIN} — 0 не возвращать"></div>
        <div class="field"><label>Ключ OpenAI</label>
          <input name="aiApiKey" value="${esc(s.aiApiKey || '')}" placeholder="sk-… — пусто, отвечает только менеджер" autocomplete="off" spellcheck="false"></div>
        <div class="field"><label>Модель</label>
          <input name="aiModel" value="${esc(s.aiModel || '')}" placeholder="${esc(AI.DEFAULT_MODEL)}" autocomplete="off" spellcheck="false"></div>
        <div class="field"><label>Группа Telegram для диалогов</label>
          <input name="chatChatId" value="${esc(s.chatChatId || '')}" placeholder="-1001234567890 — пусто, чат заявок" autocomplete="off"></div>
        <div class="field"><label>Свой адрес API</label>
          <input name="aiBaseUrl" value="${esc(s.aiBaseUrl || '')}" placeholder="не обязателен" autocomplete="off" spellcheck="false"></div>
      </div>
      <div class="field"><label>Первая фраза в окне</label>
        <input name="chatGreeting" value="${esc(s.chatGreeting || '')}" placeholder="${esc(R.CHAT_GREETING)}" maxlength="400"></div>
      <div class="field"><label>Инструкция для ИИ</label>
        <input type="hidden" name="chatPromptComplete" value="1">
        <textarea name="chatPrompt" rows="22" maxlength="${PROMPT.MAX_INSTRUCTION}" spellcheck="false">${esc(PROMPT.editableInstruction(s))}</textarea>
        <p class="field-hint">Это полный набор статических правил Ксении — скрытых правил поведения вне этого поля нет. Каталог, актуальные цены, условия магазина и данные заказа подставляются автоматически.</p></div>`;
}

/* ===================== Настройки: страница разделами =====================
 *
 * Полей в настройках девять групп, и одной лентой они занимали пять экранов:
 * чтобы поправить ключ кассы, приходилось пролистать бренд, оформление,
 * реквизиты оператора, Telegram и чат целиком. Теперь каждая группа — свёрнутая
 * карточка, а страница читается как оглавление и помещается на один экран.
 *
 * Четыре правила, из которых следует всё остальное.
 *
 * 1. СВЁРНУТАЯ СТРОКА ОТВЕЧАЕТ НА ВОПРОС, РАДИ КОТОРОГО РАЗДЕЛ ОТКРЫВАЮТ, а не
 *    описывает, что внутри. Не «здесь ключ dadata.ru», а «ключ задан» либо «нет
 *    ключа — поле адреса обычный ввод». Описание читают один раз, а видят каждый
 *    день; то же правило, по которому свёрнутая строка кассы говорит про связь и
 *    сделки, а не «настройки CrocoPAY».
 *
 * 2. РАСКРЫТ РОВНО ТОТ РАЗДЕЛ, С КОТОРЫМ ЧТО-ТО НЕ ТАК (тон `err`) — как у
 *    свёрток касс. Всё в порядке — страница остаётся коротким списком, и это её
 *    нормальный вид, а не «ничего не загрузилось».
 *
 * 3. ЧТО БЫЛО ОТКРЫТО, ОСТАЁТСЯ ОТКРЫТЫМ ПОСЛЕ СОХРАНЕНИЯ. Иначе правка ключей
 *    кассы выглядит так: открыл раздел, поправил, сохранил — раздел захлопнулся
 *    под руками, ищи заново. Список открытого уезжает скрытым полем
 *    `openSections` и возвращается от сервера параметром `?open=` — ни
 *    localStorage, ни скрипта в <head>, ни моргания на загрузке (тем же путём
 *    когда-то ушло меню разделов). Заполняет поле `public/admin-ui.js`; без
 *    скрипта в нём остаётся то, что сервер открыл сам, — то есть хуже, чем с
 *    ним, но не сломано.
 *
 * 4. НИ ОДНОГО `required` НА ПОЛЕ ВНУТРИ СВЁРНУТОГО РАЗДЕЛА. Браузер не может
 *    поставить фокус в скрытое поле и молча отказывается отправлять форму,
 *    написав об этом только в консоль, — то есть кнопка «Сохранить» переставала
 *    бы работать без единого слова на экране. Пустое название магазина ловит
 *    сервер и возвращает форму с ошибкой, как и всё остальное в ней.
 */
const SET_ICONS = {
  // Витрина: навес, дверь и окно.
  store: '<path d="M4.4 9.6h15.2v10.8H4.4z"/><path d="M4.4 9.6 6.2 3.6h11.6l1.8 6"/><path d="M9.7 20.4v-6.1h4.6v6.1"/>',
  // Контакты: телефонная трубка.
  contacts: '<path d="M8.1 4.2 9.9 8l-1.9 1.9a12.4 12.4 0 0 0 6.1 6.1L16 14.1l3.8 1.8v3.1c0 .9-.75 1.6-1.65 1.5C9.9 19.7 4.3 14.1 3.5 5.85 3.4 4.95 4.1 4.2 5 4.2Z"/>',
  // Отзывы: звезда — тот же образ, что и в оценке товара.
  reviews: '<path d="m12 3.9 2.55 5.17 5.7.83-4.12 4.02.97 5.68L12 16.92l-5.1 2.68.97-5.68L3.75 9.9l5.7-.83z"/>',
  // Оформление: палитра с красками.
  brand: '<path d="M12 3.6a8.4 8.4 0 1 0 0 16.8c1.1 0 1.9-.75 1.9-1.72 0-.45-.17-.86-.46-1.17a1.72 1.72 0 0 1 1.24-2.9h1.5A4.42 4.42 0 0 0 20.4 10.1c0-3.6-3.76-6.5-8.4-6.5Z"/><circle cx="8" cy="11.5" r="1"/><circle cx="11.6" cy="8.1" r="1"/><circle cx="15.7" cy="9.9" r="1"/>',
  // Оплата: карта с полосой.
  pay: '<rect x="3" y="5.8" width="18" height="12.4" rx="2.6"/><path d="M3 10.1h18"/><path d="M6.8 14.6h3.4"/>',
  // Плавающие цены: линия, идущая вверх.
  price: '<path d="M3.8 19.9h16.4"/><path d="M4.6 15.4 9.6 10.3l3.2 3.2 6.6-6.6"/><path d="M14.8 6.9h4.6v4.6"/>',
  // Отправка: фургон — тот же силуэт, что у глифа доставки на витрине.
  ship: '<rect x="2.8" y="6.6" width="11.2" height="9.6" rx="1.7"/><path d="M14 10h3.6c.3 0 .6.14.8.38l2.3 2.74c.15.18.24.42.24.66v2.42H14z"/><circle cx="7.2" cy="18.1" r="1.8"/><circle cx="18.3" cy="18.1" r="1.8"/>',
  chat: R.adminIconPath('chat'),
  // Telegram: бумажный самолётик, тот же силуэт, что у значка витрины.
  telegram: '<path d="M20.6 4.4 3.9 10.7l5.2 2.1 2 5.6 2.8-3.5 4.2 3.1z"/><path d="m9.1 12.8 11.5-8.4-8.5 10.6"/>',
  // Подсказки адресов: булавка на карте.
  dadata: '<path d="M12 20.5s6.1-5.5 6.1-10a6.1 6.1 0 1 0-12.2 0c0 4.5 6.1 10 6.1 10Z"/><circle cx="12" cy="10.4" r="2.3"/>',
  legal: R.adminIconPath('page'),
  // Доступ: замок.
  access: '<rect x="4.6" y="10.3" width="14.8" height="9.9" rx="2.4"/><path d="M8.2 10.3V7.8a3.8 3.8 0 0 1 7.6 0v2.5"/><path d="M12 14.3v2.1"/>'
};
function setIcon(key) {
  const path = SET_ICONS[String(key || '')] || '';
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${path}</svg>`;
}

/* Один раздел. `note` — состояние словами, `mark` — необязательная приписка
 * справа от заголовка (у оформления это кружки выбранных цветов).
 *
 * Заголовок раздела — <h3>, потому что <h2> занят названием группы: заголовки
 * страницы обязаны идти по порядку, иначе читающий с экрана получает список
 * разделов вперемешку с их группами.
 */
/* Длинное значение в свёрнутой строке. Строка раздела — это подпись оглавления,
 * и разрастаться на три ряда ей нельзя: на телефоне из четырёх свёрнутых
 * разделов на экран влезало бы два. Многоточие ставится только когда правда
 * обрезали. */
function setCut(value, max) {
  const text = String(value == null ? '' : value).trim().replace(/\s+/g, ' ');
  return text.length > max ? text.slice(0, max - 1).trimEnd() + '…' : text;
}

function settingsSection(o) {
  return `<details class="set${o.tone ? ' is-' + esc(o.tone) : ''}" id="set-${esc(o.id)}"${o.open ? ' open' : ''}>
      <summary>
        <span class="set-ico">${setIcon(o.id)}</span>
        <span class="set-cap"><h3>${esc(o.title)}</h3><span class="set-note">${esc(o.note || '')}</span></span>
        ${o.mark || ''}
        <svg class="set-chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="m9.5 5.5 7 6.5-7 6.5"/></svg>
      </summary>
      <div class="set-body">${o.body}</div>
    </details>`;
}

/* Состояние оплаты одной строкой.
 *
 * Спрашивает ту же `PAYMENTS.mode()`, что и витрина: строка обязана говорить про
 * то, что видит ПОКУПАТЕЛЬ, а не про то, какие галочки стоят в форме (включённая
 * касса без ключей оставляет витрину в режиме заявок). Красный тон — только там,
 * где витрина осталась без оплаты не по решению владельца, а по недосмотру:
 * такой раздел откроется сам.
 */
function paySummary(settings, health) {
  const rows = health || [];
  const on = PAYMENTS.enabledProviders(settings);
  if (PAYMENTS.mode(settings) === 'cashbox') {
    const nokeys = rows.filter(r => r.on && !r.ready);
    const names = list => list.map(r => r.name).join(' и ');
    if (nokeys.length) return ['err', `оплата на витрине · у ${names(nokeys)} не заданы ключи`];
    const mute = rows.filter(r => r.on && r.ready && (r.state === 'auth' || r.state === 'down'));
    if (mute.length) return ['warn', `оплата на витрине · ${names(mute)} не отвечает`];
    return ['ok', 'оплата на витрине · ' + on.map(p => p.name).join(' и ')];
  }
  const own = PAYMENTS.ownRequisites(settings);
  if (PAYMENTS.ownEnabled(settings)) {
    const what = [own.phone ? 'СБП' : '', own.card ? 'карта' : ''].filter(Boolean).join(' и ');
    return ['ok', 'перевод по своим реквизитам' + (what ? ' · ' + what : '')];
  }
  // Включили свои реквизиты и не дозаполнили — витрина молча осталась в режиме
  // заявок, и узнал бы об этом владелец от покупателя.
  if (own.on) return ['err', 'свои реквизиты включены, но не хватает получателя или номера'];
  if (rows.some(r => r.on && !r.ready)) return ['err', 'касса включена, но ключи не заданы — оплаты на витрине нет'];
  return ['', 'заявки без оплаты — менеджер связывается с покупателем'];
}

function settingsPage(settings, db, flash, flashType, opts) {
  opts = opts || {};
  const draft = opts.draft || null;
  const s = Object.assign({}, settings, draft || {});
  // Снятая галочка приходит в теле формы не значением, а ОТСУТСТВИЕМ поля.
  // Поэтому при возврате с ошибкой её нельзя искать в `s`: там она подхватится
  // из сохранённых настроек, и админ увидит свою галочку снова отмеченной —
  // а нажав «Сохранить» ещё раз, молча вернёт то, что только что снял.
  const checked = (field, saved) => (draft ? draft[field] !== undefined : saved);
  // Поля ещё нет — значит установка обновилась со старой версии: показываем
  // набор по умолчанию, а не «всё отмечено».
  const savedMethods = Array.isArray(settings.payMethods) ? settings.payMethods : PAY.DEFAULT_IDS;
  const shownMethods = draft ? [].concat(draft.payMethods === undefined ? [] : draft.payMethods) : savedMethods;
  // Живой ответ кассы: какие способы и валюты у неё РЕАЛЬНО включены. Не
  // ответила (нет ключей, оплата выключена, сеть) — `null`, и тогда показываем
  // встроенный список, честно сказав об этом.
  const live = opts.live && opts.live.ok ? opts.live : null;
  // Состояние каждой кассы — из того же ответа, что и список способов: ещё один
  // запрос за той же страницей означал бы ещё восемь секунд ожидания у
  // медленной кассы. А что она в последний раз ответила на СДЕЛКУ — из истории
  // заказов: живым опросом это не узнать вовсе.
  const health = PAYMENTS.health(settings, opts.live || null);
  const payStats = R.providerStats(typeof db.getOrders === 'function' ? db.getOrders() : []);
  // Строку ищем по ключу кассы, а не по номеру в списке: порядок в реестре —
  // дело `lib/payments.js`, и завязываться на него разметке нельзя.
  const healthOf = id => health.find(r => r.id === id) || { id, name: id, on: false, ready: false, state: 'off', live: false, methods: [], error: '' };
  const statOf = id => payStats.find(r => r.id === id) || null;
  // Секреты никогда не возвращаются в HTML. Пустое поле сохраняет прежнее
  // значение, отдельная галочка удаляет его осознанно.
  const secretInput = (name, saved, clearName, optional) => {
    const configured = !!String(saved || '').trim();
    const clearChecked = !!(draft && draft[clearName] !== undefined);
    const placeholder = configured
      ? 'задан — оставьте пустым, чтобы не менять'
      : (optional ? 'не обязателен' : 'введите ключ');
    return `<input name="${esc(name)}" type="password" value="" placeholder="${esc(placeholder)}" autocomplete="new-password" spellcheck="false">`
      + (configured ? `<label class="secret-clear"><input type="checkbox" name="${esc(clearName)}"${clearChecked ? ' checked' : ''}> Удалить сохранённый ключ</label>` : '');
  };
  /* Контакты витрины в свёрнутой строке — те же, что увидит покупатель в
   * подвале. Ни одного — это не мелочь: связаться с магазином будет негде,
   * поэтому раздел получает предупреждающий тон. */
  const contactList = [String(s.contactTelegram || '').trim(),
    String(s.contactPhone || '').trim() ? (R.phoneText(s.contactPhone) || String(s.contactPhone).trim()) : '',
    String(s.contactEmail || '').trim()].filter(Boolean);
  const chatRows = chatStateRows(settings);
  const chatWorst = ['err', 'warn', 'ok'].find(t => chatRows.some(r => r.tone === t)) || '';
  const [payTone, payNote] = paySummary(settings, health);
  const tgReady = !!(String(s.telegramBotToken || '').trim() && String(s.telegramChatId || '').trim());
  // Галочка фото к отзывам: снятая приходит отсутствием поля, поэтому её
  // состояние берётся из черновика тем же `checked()`, что и все прочие.
  const reviewPhotosOn = checked('reviewPhotos', R.reviewPhotosOn(settings));
  const legal = String(s.legalOperator || '').trim();

  const sections = [
    ['Витрина', [
      {
        /* Магазин — только то, что говорит, ЧТО ЭТО ЗА МАГАЗИН: имя, слоган,
         * описание для выдачи и деньги. Цвет отсюда уехал в «Оформление» (там
         * ему и место — вопрос про вид), контакты — в свой раздел (их стало
         * четыре, и в общем списке они терялись между валютой и подвалом). */
        id: 'store', title: 'Магазин',
        /* Слоган в свёрнутой строке ОБРЕЗАН: он бывает в полсотни знаков, и на
         * телефоне такая строка занимает три ряда — свёрнутый раздел перестаёт
         * быть строкой оглавления. Узнать слоган по началу можно, прочесть
         * целиком — в самом поле. */
        note: [String(s.storeName || '').trim() || 'без названия',
          setCut(s.tagline, 42) || 'без слогана',
          String(s.currency || '₽').trim() + (s.currencyPosition === 'before' ? ' перед суммой' : '')].join(' · '),
        body: `<div class="a-form-grid">
        ${/* Звёздочка осталась, а атрибута `required` нет: поле лежит внутри
             свёрнутого раздела, а в такое поле браузер не может поставить фокус
             — форма тогда не отправляется вовсе, и он пишет об этом только в
             консоль. Пустое название ловит сервер и возвращает форму с ошибкой,
             как и всё остальное в ней. */''}
        <div class="field"><label for="set-store-name">Название магазина *</label><input id="set-store-name" name="storeName" value="${esc(s.storeName || '')}">
          <p class="field-hint">Стоит в шапке, в заголовке вкладки и в подвале.</p></div>
        <div class="field"><label for="set-tagline">Слоган</label><input id="set-tagline" name="tagline" value="${esc(s.tagline || '')}">
          <p class="field-hint">Одна строка под названием на первом экране.</p></div>
        <div class="field"><label for="set-currency">Валюта</label><input id="set-currency" name="currency" value="${esc(s.currency || '₽')}"></div>
        <div class="field"><label for="set-currency-pos">Позиция валюты</label><select id="set-currency-pos" name="currencyPosition"><option value="after" ${s.currencyPosition === 'before' ? '' : 'selected'}>После суммы (1000 ₽)</option><option value="before" ${s.currencyPosition === 'before' ? 'selected' : ''}>Перед суммой ($1000)</option></select></div>
      </div>
      ${/* Описание для поисковика — отдельное поле, а не слоган: слоган пишется
           под первый экран и в выдаче выглядит обрубком, а здесь нужна фраза с
           городом, доставкой и гарантией. Пусто — остаётся слоган, как было. */''}
      <div class="field"><label for="set-meta">Описание для поисковика</label>
        <textarea id="set-meta" class="a-area-sm" name="metaDescription" rows="2" maxlength="300" placeholder="${esc(String(s.tagline || '').trim() || 'Оригинальная техника Apple: доставка по России, гарантия 1 год')}">${esc(s.metaDescription || '')}</textarea>
        <p class="field-hint">Показывается в выдаче Google и в превью ссылки на магазин. Пусто — берётся слоган.</p></div>
      <div class="field"><label for="set-footer">Текст в подвале</label><input id="set-footer" name="footerNote" value="${esc(s.footerNote || '')}">
        <p class="field-hint">Строка под копирайтом: реквизиты, оговорка о ценах, что угодно своё.</p></div>`
      },
      {
        id: 'brand', title: 'Оформление',
        note: `${R.cssColor(s.accentColor, '#0071e3').toUpperCase()} · шрифт «${R.logoFontName(s.logoFont)}» · ${s.logoImage ? 'логотип-картинка'
          : (String(s.logoText || '').trim() ? 'надпись «' + String(s.logoText).trim() + '»' : 'название магазина текстом')}`,
        /* Кружок выбранного цвета: сказать «синий» словами нельзя — цвет
         * произвольный, — а показать его самим цветом можно. Значение идёт
         * через `cssColor()`, поэтому чужая строка в атрибут не уедет.
         *
         * Кружок теперь ОДИН: вторая цветовая настройка снята, и рисовать рядом
         * её копию значило бы обещать выбор, которого нет. */
        mark: `<span class="set-dots" aria-hidden="true"><i style="background:${R.cssColor(s.accentColor, '#0071e3')}"></i></span>`,
        body: R.brandFields(s)
      },
      {
        /* Контакты — свой раздел, а не хвост «Магазина».
         *
         * Их четыре (Telegram, телефон, почта, часы), они отвечают на один
         * вопрос — как с магазином связаться, — и в общем списке терялись между
         * валютой и текстом подвала. Здесь же видно главное: не осталось ли
         * витрины вовсе без контактов. */
        id: 'contacts', title: 'Контакты на витрине',
        tone: contactList.length ? '' : 'warn',
        /* Часов работы в свёрнутой строке нет намеренно: раздел открывают с
         * вопросом «есть ли связь и какая», и на него отвечают сами контакты. С
         * часами строка на телефоне уезжала на третий ряд. */
        note: contactList.length
          ? contactList.join(' · ')
          : 'контактов нет — связаться с магазином будет негде',
        body: `<div class="a-form-grid">
        <div class="field"><label for="set-tg">Telegram для витрины</label><input id="set-tg" name="contactTelegram" value="${esc(s.contactTelegram || '')}" placeholder="@manager">
          <p class="field-hint">Кнопка в шапке и в подвале.</p></div>
        ${/* Телефон стоит рядом с остальными контактами, а не среди валюты и
             цветов: по нему звонят, и искать его надо там, где лежит почта и
             Telegram. Хранится он в одном виде с телефоном заказа (E.164) и
             проверяется тем же модулем — сервер вернёт форму с ошибкой, если
             номера такого не бывает. */''}
        <div class="field"><label for="set-phone">Телефон</label><input id="set-phone" name="contactPhone" type="tel" value="${esc(s.contactPhone ? R.phoneText(s.contactPhone) || s.contactPhone : '')}" placeholder="+7 999 123-45-67">
          <p class="field-hint">В подвале станет ссылкой «позвонить».</p></div>
        <div class="field"><label for="set-email">Почта</label><input id="set-email" name="contactEmail" type="email" inputmode="email" value="${esc(s.contactEmail || '')}" placeholder="shop@example.ru">
          <p class="field-hint">Для писем покупателей. Обращения по персональным данным — отдельным адресом ниже.</p></div>
        <div class="field"><label for="set-hours">Время работы</label><input id="set-hours" name="contactHours" value="${esc(s.contactHours || '')}" placeholder="Ежедневно 10:00–21:00" maxlength="120">
          <p class="field-hint">Показывается в подвале и в ответах консультанта.</p></div>
      </div>`
      },
      {
        /* Отслеживание. Здесь только два значения по умолчанию: сам маршрут
         * каждой посылки живёт в её заказе и правится там же (раздел
         * «Заказы» → «Отправление»). Держать его в настройках было бы неправдой
         * — у каждой посылки он свой. */
        id: 'ship', title: 'Отправка и отслеживание',
        note: `отправляем из г. ${String(s.shipFromCity || '').trim() || TRACK.DEFAULT_FROM}`
          + ` · сборка ${SHIPDAYS.handlingDays(s) === 0 ? 'в день оплаты'
            : SHIPDAYS.handlingDays(s) + ' ' + R.pluralRu(SHIPDAYS.handlingDays(s), 'рабочий день', 'рабочих дня', 'рабочих дней')}`
          + ` · о задержке через ${TRACK.holdDaysValue({ holdDays: s.shipHoldDays })} ${R.pluralRu(TRACK.holdDaysValue({ holdDays: s.shipHoldDays }), 'день', 'дня', 'дней')}`,
        body: `<div class="a-form-grid">
        <div class="field"><label for="set-ship-city">Город отправки по умолчанию</label>
          <input id="set-ship-city" name="shipFromCity" value="${esc(s.shipFromCity || '')}" placeholder="${esc(TRACK.DEFAULT_FROM)}" maxlength="60">
          <p class="field-hint">С него начинается маршрут новой посылки.</p></div>
        ${/* Сборка входит в срок, который покупатель видит на оформлении и
             запоминает, — а была жёстким числом в коде. У одного магазина заказ
             уезжает в тот же день, у другого товар едет со склада поставщика. */''}
        <div class="field"><label for="set-ship-handling">Сборка заказа, рабочих дней</label>
          <input id="set-ship-handling" name="shipHandlingDays" inputmode="numeric" value="${esc(s.shipHandlingDays === 0 || s.shipHandlingDays ? String(s.shipHandlingDays) : '')}"
            placeholder="${SHIPDAYS.HANDLING}" autocomplete="off">
          <p class="field-hint">Входит в срок доставки на оформлении. 0 — отправляем в день оплаты.</p></div>
        <div class="field"><label for="set-ship-hold">Сообщать о задержке через, дней</label>
          <input id="set-ship-hold" name="shipHoldDays" inputmode="numeric" value="${esc(s.shipHoldDays === 0 || s.shipHoldDays ? String(s.shipHoldDays) : '')}"
            placeholder="${TRACK.HOLD_NOTICE_DAYS}" autocomplete="off">
          <p class="field-hint">Столько дней посылка может стоять на месте молча.</p></div>
      </div>
      <p class="field-hint">Город и срок задержки — значения по умолчанию для новой отправки: сам маршрут у каждой посылки свой и правится в её заказе. Заказ после ${SHIPDAYS.CUTOFF_HOUR}:00 по Москве и в выходные уходит в работу следующим рабочим днём.</p>`
      }
    ]],
    ['Деньги', [
      {
        id: 'pay', title: 'Оплата на витрине', tone: payTone, note: payNote,
        body: `${payModeNote(settings, health)}
      ${payProviderSwitches(settings, checked)}
      ${ownPayFields(settings, s)}
      ${payProviderFold(healthOf(CROCO.id), statOf(CROCO.id), `
      ${settings.crocopayEnabled && !CROCO.configured(settings)
    ? '<p class="form-msg err">Касса включена, но ключи не заданы — реквизиты она не выдаст.</p>' : ''}
      <div class="a-form-grid">
        <div class="field"><label>Client ID кассы</label>
          <input name="crocopayClientId" value="${esc(s.crocopayClientId || '')}" placeholder="пусто — касса не работает" autocomplete="off" spellcheck="false"></div>
        <div class="field"><label>Client Secret кассы</label>
          ${secretInput('crocopayClientSecret', settings.crocopayClientSecret, 'clearCrocopayClientSecret')}</div>
      </div>`)}
      ${payProviderFold(healthOf(MERIDIAN.id), statOf(MERIDIAN.id), `
      ${settings.meridianpayEnabled && !MERIDIAN.configured(settings)
    ? '<p class="form-msg err">Касса включена, но ключ или Merchant ID не заданы — реквизиты она не выдаст.</p>' : ''}
      <div class="a-form-grid">
        <div class="field"><label>Access-Token (API-ключ)</label>
          ${secretInput('meridianpayApiKey', settings.meridianpayApiKey, 'clearMeridianpayApiKey')}</div>
        <div class="field"><label>Merchant ID (UUID мерчанта)</label>
          <input name="meridianpayMerchantId" value="${esc(s.meridianpayMerchantId || '')}" placeholder="00000000-0000-0000-0000-000000000000" autocomplete="off" spellcheck="false"></div>
        <div class="field"><label>Secret Key</label>
          ${secretInput('meridianpaySecret', settings.meridianpaySecret, 'clearMeridianpaySecret', true)}</div>
      </div>`)}
      ${payPrimarySection(s)}
      ${payLimitsSection(s, draft)}
      ${payCurrencySection(s, settings, draft, live, checked)}
      ${payMethodsSection(shownMethods, live)}`
      },
      {
        id: 'price', title: 'Плавающие цены',
        note: priceFloatNote(s, settings, checked),
        body: priceFloatSection(s, settings, checked)
      }
    ]],
    ['Общение с покупателем', [
      {
        id: 'chat', title: 'Онлайн-чат на витрине', tone: chatWorst,
        note: (chatRows[0] && chatRows[0].short) || '',
        body: chatSection(s, settings, checked)
      },
      {
        id: 'telegram', title: 'Telegram для заявок',
        tone: !tgReady && (String(s.telegramBotToken || '').trim() || String(s.telegramChatId || '').trim()) ? 'warn' : '',
        note: tgReady
          ? 'заявки уходят в Telegram'
          : (String(s.telegramBotToken || '').trim() || String(s.telegramChatId || '').trim()
            ? 'заполнено наполовину — уведомления не уходят'
            : 'не настроен — заявки видно только в панели'),
        body: `<div class="a-form-grid">
        <div class="field"><label for="set-tg-token">Токен бота</label><input id="set-tg-token" name="telegramBotToken" value="${esc(s.telegramBotToken || '')}" autocomplete="off" spellcheck="false">
          <p class="field-hint">Выдаёт @BotFather при создании бота.</p></div>
        <div class="field"><label for="set-tg-chat">Chat ID</label><input id="set-tg-chat" name="telegramChatId" value="${esc(s.telegramChatId || '')}" autocomplete="off">
          <p class="field-hint">Куда падают заявки: ваш id или id группы.</p></div>
      </div>`
      },
      {
        /* Отзывы — свой раздел, и в нём два решения, которые правда принимают:
         * пускать ли снимки покупателей и будить ли себя уведомлением.
         *
         * «Уведомлять о новых отзывах» переехало сюда из Telegram намеренно:
         * галочка про ОТЗЫВЫ, а не про бота, и искали её здесь. Telegram при
         * этом остаётся условием — без бота уведомлению уйти некуда, и строка
         * состояния говорит об этом прямо, а не молчит. */
        id: 'reviews', title: 'Отзывы покупателей',
        note: (reviewPhotosOn ? 'фото разрешены' : 'только текст')
          + ' · ' + (checked('notifyReviews', settings.notifyReviews !== false)
            ? (tgReady ? 'о новых сообщаем в Telegram' : 'уведомления включены, но Telegram не настроен')
            : 'уведомлений нет'),
        body: `<input type="hidden" name="reviewsForm" value="1">
      <div class="field field-check"><label><input type="checkbox" name="reviewPhotos" ${reviewPhotosOn ? 'checked' : ''}> Покупатель может приложить фото к отзыву</label></div>
      <div class="field field-check"><label><input type="checkbox" name="notifyReviews" ${checked('notifyReviews', settings.notifyReviews !== false) ? 'checked' : ''}> Уведомлять о новых отзывах в Telegram</label></div>
      <p class="field-hint">Снимков не больше ${R.REVIEW_PHOTOS_MAX} на отзыв, метаданные с них снимаются. Снятая галочка убирает поле с витрины и отклоняет файлы, присланные в обход формы; уже загруженные остаются на месте.</p>`
      }
    ]],
    ['Магазин как продавец', [
      {
        id: 'dadata', title: 'Подсказки адресов',
        note: String(s.dadataToken || '').trim()
          ? 'ключ задан — адрес подсказывается при оформлении'
          : 'нет ключа — поле адреса остаётся обычным вводом',
        /* id поля не совпадает с id раздела (`set-dadata`): два одинаковых id на
         * странице — это подпись, ведущая к свёртке вместо поля, и читающий с
         * экрана попадает не туда. Уникальность закреплена тестом. */
        body: `<div class="field"><label for="set-dadata-key">Ключ dadata.ru (API-ключ «Подсказок»)</label>
          <input id="set-dadata-key" name="dadataToken" value="${esc(s.dadataToken || '')}" placeholder="пусто — подсказок не будет" autocomplete="off">
          <p class="field-hint">Берётся в личном кабинете <a class="link" href="https://dadata.ru/profile/#info" target="_blank" rel="noopener noreferrer">dadata.ru</a> и хранится только на сервере: браузер покупателя спрашивает подсказки у нас, а в DaData ходит уже сервер.</p></div>`
      },
      {
        id: 'legal', title: 'Персональные данные',
        tone: legal ? '' : 'warn',
        note: legal ? legal + (String(s.legalDetails || '').trim() ? ' · ' + String(s.legalDetails).trim() : '')
          : 'не заполнены — документы остаются без реквизитов продавца',
        body: `<div class="a-form-grid">
        <div class="field"><label for="set-legal-op">Оператор (ИП, ООО или ФИО)</label><input id="set-legal-op" name="legalOperator" value="${esc(s.legalOperator || '')}"></div>
        <div class="field"><label for="set-legal-num">ИНН / ОГРН / ОГРНИП</label><input id="set-legal-num" name="legalDetails" value="${esc(s.legalDetails || '')}"></div>
        <div class="field"><label for="set-legal-addr">Адрес оператора</label><input id="set-legal-addr" name="legalAddress" value="${esc(s.legalAddress || '')}"></div>
        <div class="field"><label for="set-legal-mail">E-mail для обращений по персональным данным</label><input id="set-legal-mail" name="privacyEmail" type="email" inputmode="email" value="${esc(s.privacyEmail || '')}"></div>
      </div>
      <p class="field-hint">Подставляются в политику конфиденциальности, оба согласия и страницы гарантии и возврата. Пустые — документы остаются без реквизитов продавца.</p>`
      },
      {
        id: 'access', title: 'Доступ в панель',
        note: 'логин: ' + (String(s.adminUsername || '').trim() || 'admin'),
        body: `<div class="a-form-grid">
        <div class="field"><label for="set-login">Логин</label><input id="set-login" name="adminUsername" value="${esc(s.adminUsername || 'admin')}" autocomplete="username"></div>
        <div class="field"><label for="set-pass">Новый пароль</label><input id="set-pass" name="adminPassword" type="password" autocomplete="new-password" minlength="10" maxlength="500" placeholder="пусто — не менять">
          <p class="field-hint">Не менее 10 символов.</p></div>
      </div>
      <p class="field-hint">Учётная запись одна и с полными правами, панель открывается по адресу <b>/admin</b>. Смена логина или пароля разлогинивает все открытые сессии — включая эту.</p>`
      }
    ]]
  ];

  /* Какие разделы раскрыть. Пришедшее в `?open=` (или из тела формы, когда она
   * вернулась с ошибкой) сверяется со списком настоящих разделов — в адресе
   * бывает что угодно, а строка уезжает в id и в разметку. */
  const known = new Set([].concat(...sections.map(([, list]) => list.map(x => x.id))));
  const asked = new Set(String(opts.open || '').split(',').map(x => x.trim()).filter(x => known.has(x)));
  const openIds = [];
  const groups = sections.map(([title, list]) => {
    const cards = list.map(section => {
      // Раскрыт либо тот, который просили вернуть открытым, либо тот, с которым
      // что-то не так: страница обязана показать поломку, не дожидаясь клика.
      const open = asked.has(section.id) || section.tone === 'err';
      if (open) openIds.push(section.id);
      return settingsSection(Object.assign({ open }, section));
    }).join('');
    return `<section class="set-group"><h2>${esc(title)}</h2>${cards}</section>`;
  }).join('');

  const body = `<form class="a-form a-settings" method="post" enctype="multipart/form-data" action="/admin/settings">
    ${/* Список раскрытого. Заполнено сервером — тогда открытое переживёт
        сохранение и без скрипта; `public/admin-ui.js` перед отправкой дописывает
        сюда то, что раскрыл сам админ. */''}
    <input type="hidden" name="openSections" value="${esc(openIds.join(','))}">
    ${groups}
    <div class="a-form-actions"><button class="btn btn-primary" type="submit">Сохранить</button></div>
  </form>
  <div class="a-panel a-exit">
    <form action="/admin/logout" method="post"><button class="btn" type="submit">Выйти из панели</button></form>
  </div>`;
  return layout(settings, { active: 'settings', title: 'Настройки', counts: navCounts(settings, db), flash, flashType, body });
}

module.exports = { loginPage, dashboard, chatList, chatPage, chatNewPage, paymentsPage, promoPage, productsList, productForm, reviewsList, productReviews, reviewForm, ordersList, shipmentsPage, shipmentPage, analyticsPage, visitorsPage, visitorPage, settingsPage, navCounts, noteOrder, noteReview, noteChat };
