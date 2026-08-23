'use strict';
// Рендер витрины (сервер-сайд, обычные шаблонные строки — без движков и лишних зависимостей).
const fs = require('fs');
const path = require('path');
const D = require('./discount');
const V = require('./variants');
const DELIVERY = require('./delivery');
const DLOGO = require('./delivery-logos');
const PAY = require('./pay-methods');
const CROCO = require('./crocopay');
const CI = require('./client-icons');
// Телефон покупателя: тот же файл, что грузит витрина, — формат номера в панели
// и в поле ввода обязан быть один (см. шапку `public/phone.js`).
const PHONE = require('../public/phone.js');

// Версия публичных юридических документов записывается вместе с согласием
// автора отзыва, чтобы можно было подтвердить, какой текст он принял.
const PRIVACY_VERSION = '2026-08-22';

// Версия статического файла по времени изменения — добавляется к ссылке (?v=...),
// чтобы браузер всегда подхватывал свежие стили/скрипты и не показывал старый кэш.
const _assetV = new Map();
function assetV(file) {
  const hit = _assetV.get(file);
  if (hit && Date.now() - hit.at < 5000) return hit.v; // проверяем диск не чаще раза в 5 секунд
  let v = '1';
  try { v = Math.round(fs.statSync(path.join(__dirname, '..', 'public', file)).mtimeMs).toString(36); } catch (e) {}
  _assetV.set(file, { v, at: Date.now() });
  return v;
}

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// Предлог не должен висеть в конце строки: «Оригинальная техника Apple с» и
// перенос «гарантией» на следующую строку читается как ошибка вёрстки. Слова из
// одной-двух букв привязываем к следующему слову неразрывным пробелом. Заголовок
// магазина владелец пишет сам, поэтому чинится это здесь, а не в тексте.
function bindShortWords(s) {
  return String(s == null ? '' : s).replace(/(^|[\s(«"])([A-Za-zА-Яа-яЁё]{1,2})\s+/g, '$1$2 ');
}

// На телефоне слоган обязан помещаться в одну строку — и в заголовке первого
// экрана (вместе с яблоком), и в подвале. Кегль под ширину экрана подбирает сам
// CSS: `min(23px, calc((100vw - поля)/var(--fit)))`. Ему нужно знать длину
// строки в em — её и считает сервер. Мерить ширину скриптом в браузере значит
// показать сначала крупный заголовок и дёрнуть вёрстку на загрузке, а слоган
// пишет владелец, поэтому подобрать кегль числом заранее нельзя.
//
// Ширины символов — замер системного шрифта, десять групп. Точность нужна
// односторонняя: заниженная оценка выносит строку за экран, завышенная лишь
// делает кегль на пару процентов меньше нужного. Поэтому спорные символы
// округлены вверх, незнакомый считается широким, а сверху ещё запас на кегль.
const FIT_WIDTHS = [
  [0.21, '  .,:;ijlI'],
  [0.32, '!/()ftr'],
  [0.47, '-1гтьзsxz'],
  [0.50, 'вкхуяvkyJ?'],
  [0.56, 'абеёийлнопрсчъэacdeghnopqubFLE7Г'],
  [0.62, 'дцЕЁЗКРТУЬБВBKPRSTYZ02345689+«»'],
  [0.68, 'фыЯАХЧADVX'],
  [0.75, 'жмшюДЛНОПСЦЪИЙЭCGHNOQUw'],
  [0.85, 'щФЫМmM—'],
  [0.97, 'ЖШЩЮW']
];
const FIT_CHARS = new Map();
for (const [width, chars] of FIT_WIDTHS) for (const ch of chars) FIT_CHARS.set(ch, width);
// Яблоко в заголовке — те же .6em ширины и .26em отступа, что у `.apple-mark`.
const FIT_MARK = 0.86;
// Полужирное начертание заголовка шире обычного примерно на 7 %.
const FIT_BOLD = 1.07;
// Засечковые наборы шире системного, моноширинный — тем более.
const FIT_FONTS = { system: 1, rounded: 1, serif: 1.25, slab: 1.22, mono: 1.2, grotesk: 1.05 };
// Одна и та же строка на мелком кегле занимает больше em, чем на крупном: у
// системного шрифта свой трекинг на каждый размер и отдельное начертание для
// мелкого. От 23px к 10px набегает 11 %, и этого хватало, чтобы длинный слоган
// вылез за экран. Поэтому запас зависит от кегля, а кегль прикидывается по
// длине строки на типичном телефоне (FIT_REF — сколько ему остаётся под текст).
const FIT_REF = 343;
const FIT_DENSE = size => Math.min(1.16, 1.025 + 0.0105 * Math.max(0, 23 - size));

function textUnits(s, scale, tracking) {
  let sum = 0, count = 0;
  for (const ch of String(s == null ? '' : s)) { sum += FIT_CHARS.get(ch) || 0.62; count++; }
  return sum * scale + tracking * count;
}
function fitValue(units) {
  const safe = Math.max(1, units);
  return (safe * FIT_DENSE(FIT_REF / safe)).toFixed(2);
}
// Слоган в заголовке первого экрана: яблоко + текст брендовым шрифтом
// (полужирный, трекинг -.038em — см. `.store-hero h1` в styles.css).
function heroFit(settings, text) {
  const scale = FIT_BOLD * (FIT_FONTS[settings && settings.logoFont] || 1);
  return fitValue(FIT_MARK + textUnits(text, scale, -0.038));
}
// Слоган в подвале набран обычным системным шрифтом и без трекинга.
function footFit(text) { return fitValue(textUnits(text, 1, 0)); }

/* Старые админские шаблоны ставят <label> перед полем без for/id. Дорабатываем
 * готовую разметку централизованно: подпись становится кликабельной, а
 * скринридер получает корректное имя input/select/textarea. Уже связанные поля
 * не меняем.
 *
 * Содержимое подписи не должно содержать ни поля, ни другой подписи — иначе
 * ленивый разбор дотягивается до СЛЕДУЮЩЕГО поля через полразметки, и галочка,
 * которая обнимает свой input сама, получает `for` от чужой строки. Ровно так
 * «Показывать выбор валюты» указывала на поле курса: клик по подписи ставил
 * курсор в чужое поле вместо переключения галочки.
 */
function accessibleFields(html, prefix) {
  let index = 0;
  return String(html || '').replace(/<label(?![^>]*\bfor=)([^>]*)>((?:(?!<\/label>|<label\b|<input\b|<select\b|<textarea\b)[\s\S])*)<\/label>(\s*)<(input|select|textarea)([^>]*)>/gi,
    (all, labelAttrs, labelHtml, gap, tag, controlAttrs) => {
      const existing = controlAttrs.match(/\bid\s*=\s*"([^"]+)"/i);
      const id = existing ? existing[1] : `${prefix || 'field'}-${++index}`;
      const attrs = existing ? controlAttrs : `${controlAttrs} id="${id}"`;
      return `<label${labelAttrs} for="${esc(id)}">${labelHtml}</label>${gap}<${tag}${attrs}>`;
    });
}

function money(n, settings) {
  const amount = Number(n);
  const val = (Number.isFinite(amount) ? amount : 0).toLocaleString('ru-RU');
  const cur = esc((settings && settings.currency) || '₽');
  return (settings && settings.currencyPosition === 'before') ? `${cur}${val}` : `${val} ${cur}`;
}

function formatDate(ms) {
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric' });
}

// Номер заказа для показа: «№482913». Одна функция на витрину, обе панели и
// Telegram — иначе где-то останется голое число без знака номера.
//
// Префикс «ORD-» отрезается: так были пронумерованы заказы до перехода на
// случайные номера, и «Заказ №ORD-0001» читалось бы как опечатка. Сами прежние
// заявки не трогаем — переписывать выданные покупателям номера нельзя.
function orderNo(number) {
  const digits = String(number == null ? '' : number).replace(/^ORD-?/i, '').trim();
  return digits ? '№' + digits : '—';
}

// Способ доставки и адрес в строке заказа, а у старых заявок — их комментарий:
// поле с витрины убрано, но прежние заказы должны читаться как раньше.
// Одной строкой через разделитель, а не тремя блоками: в списке из полусотни
// заявок каждая лишняя строка — это лишний экран прокрутки.
// `opts.money` — настройки валюты для цены доставки: у панели владельца свои
// («₽» на все домены), у админки сайта — настройки самого сайта.
function orderDelivery(order, opts) {
  const o = order || {};
  const name = DELIVERY.nameOf(o.delivery);
  // Куда именно и почём. Цена доставки входит в `total` заказа, поэтому её надо
  // видеть в строке: без неё итог не сходится с суммой позиций.
  const way = [name, DELIVERY.shortModeOf(o.delivery, o.deliveryMode)].filter(Boolean).join(', ');
  // money() валюту экранирует сам, поэтому цена подставляется как есть, а
  // второй раз через esc() не проходит.
  const cost = Number(o.deliveryPrice) > 0 ? money(o.deliveryPrice, (opts && opts.money) || null) : '';
  /* Куда едет посылка: адрес пункта выдачи, а при доставке курьером — адрес
   * покупателя. Это разные поля, и путать их нельзя: у заказа в пункт выдачи
   * адрес покупателя тоже есть, но посылка едет не туда.
   *
   * Код пункта стоит рядом с адресом, а не вместо него: накладную менеджер
   * оформляет по коду, а найти пункт глазами проще по улице.
   */
  const code = o.pickupCode ? `<b class="o-pvz">${esc(o.pickupCode)}</b>` : '';
  const to = o.pickupAddress || o.address;
  const line = [esc(way), cost, [code, esc(to)].filter(Boolean).join(' ')].filter(Boolean).join(' · ');
  // Адрес покупателя показываем отдельной строкой — но только когда посылка
  // едет не к нему: у курьерского заказа это была бы та же строка дважды.
  const own = o.pickupAddress && o.address && o.address !== o.pickupAddress
    ? `<div class="o-line o-line-own">Покупатель: ${esc(o.address)}</div>` : '';
  return (line ? `<div class="o-line">${line}</div>` : '') + own
    + (o.comment ? `<div class="o-line">«${esc(o.comment)}»</div>` : '');
}

// Значки клиента одной строкой: флаг страны с городом, устройство, система,
// браузер. Читаются с одного взгляда, поэтому стоят открыто, а не в свёртке:
// строка занимает ту же высоту, что раньше занимала одна подпись текстом.
//
// info — плоский объект `{place, country, countryCode, device, model, os,
// browser}`: у заказа поля называются `clientOs`, у карточки метрики — `os`,
// и собирает их вызывающий. Значки приходят из lib/client-icons.js, туда же
// уехал разбор строк в имя глифа; подписи экранируются здесь.
//
// opts.href — куда ведёт строка. С ним это ссылка на карточку посетителя в
// метрике, без него — обычный текст (например, на самой карточке).
function clientMarks(info, opts) {
  const i = info || {};
  const o = opts || {};
  const marks = [];
  const flag = CI.flag(i.country, i.countryCode);
  const place = String(i.place || '').trim();
  if (flag || place) {
    marks.push(`<span class="cmark">${flag ? `<b class="cflag">${flag}</b>` : CI.icon('globe')}${place ? esc(place) : 'Страна не определена'}</span>`);
  }
  const device = String(i.model || i.device || '').trim();
  if (device) marks.push(`<span class="cmark">${CI.icon(CI.deviceKey(i.device, i.model))}${esc(device)}</span>`);
  const os = String(i.os || '').trim();
  if (os) marks.push(`<span class="cmark">${CI.icon(CI.osKey(os))}${esc(os)}</span>`);
  const browser = String(i.browser || '').trim();
  if (browser) marks.push(`<span class="cmark">${CI.icon(CI.browserKey(browser))}${esc(browser)}</span>`);
  if (!marks.length) return '';
  const inner = marks.join('');
  return o.href
    ? `<a class="cmarks cmarks-link" href="${esc(o.href)}" title="${esc(o.title || 'Открыть карточку посетителя в метрике')}">${inner}<span class="cmarks-go" aria-hidden="true">→</span></a>`
    : `<div class="cmarks">${inner}</div>`;
}

// Адрес карточки посетителя в метрике. Ключ — id из cookie метрики, а у заявок
// до его появления (и у тех, кто отказался от метрики) — сам IP: маршрут
// принимает и то, и другое. Нечего открывать — ссылки не будет.
function visitorHref(order, base) {
  const o = order || {};
  const key = o.visitorId || o.clientIp || '';
  return base && key ? String(base) + encodeURIComponent(key) : '';
}

/* Колонка «Клиент» целиком — общая на обе панели, чтобы подписи в них не
 * разъезжались.
 *
 * Открытым остаётся только «имя · контакт»: адрес пункта выдачи бывает длиннее
 * всей остальной строки («Краснодарский край, Брюховецкий р-н, ст-ца
 * Новоджерелиевская, тер Автодорога…»), и заказ разрастался на треть экрана.
 * Доставка, адрес и значки посетителя уехали под раскрытие — свёртка браузерная,
 * без единой строчки скрипта.
 *
 * `opts.metricsBase` — начало адреса карточки посетителя
 * («/owner/analytics/visitor/» или «/admin/…»); без него строка значков остаётся
 * текстом, как в Telegram-уведомлении. Отдельной свёртки «Откуда зашёл» больше
 * нет: сама строка значков и есть ссылка в метрику, где IP, провайдер и источник
 * лежат целиком.
 */
/* Телефон заказа в человеческом виде: хранится он в E.164 («+79991234567»),
 * а показывается ровно так, как покупатель его набирал, — «+7 999 123-45-67».
 * Форматирует его тот же модуль, что и поле ввода: два формата одного номера
 * читались бы как два разных номера. Флаг страны — там же, по коду.
 */
function phoneText(value) { return PHONE.format(value); }
function phoneFlag(value) {
  const parsed = PHONE.parse(value);
  return parsed.country ? PHONE.flag(parsed.country.iso) : '';
}

function orderClient(order, opts) {
  const o = order || {};
  /* Телефон — главный контакт заказа, поэтому стоит в свёрнутой строке рядом с
   * именем: по нему звонят и его же ставят в накладную. Telegram или почта
   * («contact») необязательны и идут следом, если покупатель их оставил; у
   * прежних заявок телефона нет вовсе, и строка остаётся прежней. */
  const flag = phoneFlag(o.phone);
  const phone = phoneText(o.phone);
  const head = [o.customerName, phone ? (flag ? flag + ' ' : '') + phone : '', o.contact]
    .filter(Boolean).map(esc).join(' · ') || '—';
  const marks = clientMarks({
    place: [o.clientCity, o.clientRegion, o.clientCountry].filter(Boolean).filter((x, i, a) => a.indexOf(x) === i).join(', '),
    country: o.clientCountry, countryCode: o.clientCountryCode,
    device: o.clientDevice, model: o.clientModel, os: o.clientOs, browser: o.clientBrowser
  }, { href: visitorHref(o, opts && opts.metricsBase) });
  const body = orderDelivery(o, opts) + marks;
  // Раскрывать нечего — не делаем и вида, что есть: у заявки без адреса и без
  // техники стрелка открывала бы пустоту.
  if (!body) return `<div class="o-who o-who-flat">${head}</div>`;
  return `<details class="o-who"><summary>${head}</summary><div class="o-who-body">${body}</div></details>`;
}

/* Состав заказа. Количество показываем только когда оно больше одного: «× 1» у
 * каждой строки — это шум, который ничего не сообщает.
 *
 * Длинные заказы сворачиваются: три позиции видно всегда, остальные — по клику.
 * Заказ на десяток позиций иначе растягивал строку так, что соседние заявки
 * уходили за экран.
 */
const ITEMS_SHOWN = 3;
function orderItems(order) {
  const list = (order && order.items) || [];
  if (!list.length) return '<span class="muted">—</span>';
  const line = i => `<div>${esc(i.name)}${Number(i.qty) > 1 ? ` <b>× ${esc(String(i.qty))}</b>` : ''}</div>`;
  const shown = list.slice(0, ITEMS_SHOWN).map(line).join('');
  const rest = list.slice(ITEMS_SHOWN);
  if (!rest.length) return `<div class="o-items-list">${shown}</div>`;
  return `<div class="o-items-list">${shown}<details class="o-rest">`
    + `<summary>ещё ${rest.length} ${pluralRu(rest.length, 'позиция', 'позиции', 'позиций')}</summary>`
    + `${rest.map(line).join('')}</details></div>`;
}

/* Состояние онлайн-оплаты — отдельный столбец, а не приписка к сумме. Это разные
 * вещи: сумма отвечает «сколько», состояние — «дошло ли», и рядом в одной ячейке
 * они читались как одно целое.
 *
 * Это НЕ статус заказа: заказ бывает и оплачен, и в работе одновременно (см.
 * «Почему оплата не подменяет статус заказа» в CLAUDE.md). Заказ без оплаты — в
 * том числе любой прежний — даёт прочерк.
 */
/* Первое поле — ТОН состояния, и он же ключ всей раскраски: по нему красятся
 * плашка в столбце «Статус», полоска и подложка строки заказа и точка в сводке
 * над списком. Цвет задан в одном месте (`--tone*` в styles.css), поэтому
 * разъехаться этим трём местам нечем.
 *
 * Тонов четыре, а состояний шесть: «истёк» и «отменён» для менеджера — одно и
 * то же («денег нет и не будет»), «сумма не сошлась» и «платёж не прошёл» —
 * тоже одно («смотрит человек»). Подписи при этом остаются разными: почему
 * именно не оплачено, видно из плашки.
 */
const PAY_STATES = {
  pending: ['wait', 'ждём оплату'],
  paid: ['ok', 'оплачено'],
  mismatch: ['warn', 'проверить оплату'],
  // Три состояния ниже приходят от самой кассы — в схеме Express их не было
  // вовсе, и неоплаченный заказ висел в «ждём оплату» вечно.
  expired: ['off', 'счёт истёк'],
  cancelled: ['off', 'оплата отменена'],
  failed: ['warn', 'оплата не прошла']
};

/* Действующий счёт: реквизиты выданы и срок ещё не вышел.
 *
 * Условие одно на всю оплату — по нему страница `/pay/:id` показывает реквизиты,
 * витрина рисует полосу «заказ ждёт оплаты», а панель ставит плашку «ждём
 * оплату» с обратным отсчётом. Порознь эти три места разъехались бы молча: у
 * покупателя счёт сгорел, а менеджер всё ещё ждёт перевод.
 */
function payUntil(pay) {
  if (!pay) return 0;
  const explicit = Number(pay.expiresAt) || 0;
  return Number.isFinite(explicit) && explicit > 0 ? explicit : 0;
}
function payLive(pay, now) {
  if (!pay || pay.status !== 'pending') return false;
  if (!pay.invoiceId || !pay.requisite) return false;      // счёт так и не выставили
  // Без подтверждённого срока не угадываем TTL и не показываем потенциально уже
  // переиспользованные реквизиты.
  const until = payUntil(pay);
  return !!until && until > (now || Date.now());
}
// Прежняя версия разрешала выпустить новый invoice поверх действующего. Поэтому
// в сохранённой истории верхняя попытка может быть failed, а одна из старых всё
// ещё иметь оплачиваемые реквизиты. Показываем самый новый живой invoice из
// ВСЕЙ истории; paid/mismatch наверху остаются безусловно липкими.
function payDisplay(pay, now) {
  if (!pay || pay.status === 'paid' || pay.status === 'mismatch') return pay || null;
  const attempts = Array.isArray(pay.attempts) ? pay.attempts : [];
  const live = attempts.filter(attempt => payLive(attempt, now));
  live.sort((a, b) => Number(b.startedAt || 0) - Number(a.startedAt || 0));
  return live[0] || pay;
}

// Время до конца счёта словами: «12:34». Счета живут минуты, поэтому секунды
// здесь уместны (в отличие от полосы на витрине, где они мельтешат у покупателя
// на каждой странице), а часы приписываются только когда они правда есть.
function payLeftText(ms) {
  const total = Math.max(0, Math.floor((Number(ms) || 0) / 1000));
  const p = n => String(n).padStart(2, '0');
  const h = Math.floor(total / 3600), m = Math.floor((total % 3600) / 60), s = total % 60;
  return h ? `${h}:${p(m)}:${p(s)}` : `${m}:${p(s)}`;
}

// «21.08 в 14:05» — когда счёт сгорел или когда пришли деньги. Для панели этого
// достаточно: год стоит рядом, в дате самого заказа.
function payMoment(ms) {
  const d = new Date(Number(ms) || 0);
  if (!ms || Number.isNaN(d.getTime())) return '';
  const p = n => String(n).padStart(2, '0');
  return `${p(d.getDate())}.${p(d.getMonth() + 1)} в ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/* Что с оплатой НА САМОМ ДЕЛЕ — и это не то же самое, что записанный статус.
 *
 * `pending` в данных означает «оплату начали», а не «покупатель платит»: статус
 * записывается ДО обращения к кассе (token должен существовать раньше счёта), и
 * дальше двигает его только ответ кассы через браузер, webhook или фоновую
 * сверку. Отсюда три разных случая под одним статусом:
 *
 *   - реквизитов нет вовсе (касса отказала — у неё кончились свободные карты,
 *     это её штатный ответ) — оплата НЕ ЗАВЕРШЕНА, покупатель ничего не платил;
 *   - реквизиты выданы, срок идёт — вот это и есть «ждём оплату», и только у
 *     такого заказа есть обратный отсчёт;
 *   - срок вышел, а вебхука об успехе не пришло — счёт истёк.
 *
 * Считается это по времени показа, а сам статус в данных не трогаем: 'paid'
 * вполне приходит вебхуком уже после того, как счёт сгорел, и переписывать
 * историю ради плашки нельзя.
 *
 * Четвёртый случай — черновик: покупатель оформил заявку, дошёл до страницы
 * оплаты и ушёл, не выбрав способ. Оплаты у него нет вовсе, и до кассы дело не
 * доходило (см. «Черновик» в CLAUDE.md), но данные покупателя с телефоном уже
 * есть — такому звонят.
 */
function payView(order, now) {
  if (order && order.draft) return { tone: 'draft', label: 'способ не выбран' };
  const pay = payDisplay(order && order.payment, now);
  const state = (pay && pay.status) || '';
  const known = PAY_STATES[state];
  if (!known) return null;
  const at = now || Date.now();
  if (state === 'pending') {
    if (payLive(pay, at)) {
      const until = payUntil(pay);
      // `over` — подпись, которую скрипт панели поставит, когда отсчёт дойдёт до
      // нуля: текст остаётся здесь, в одном месте с остальными подписями.
      return { tone: 'wait', label: 'ждём оплату', until, over: PAY_STATES.expired[1] };
    }
    if (pay.invoiceId && pay.requisite) {
      return { tone: 'off', label: PAY_STATES.expired[1], when: payMoment(payUntil(pay)), whenLabel: 'срок вышел' };
    }
    return { tone: 'idle', label: 'оплата не завершена', when: payMoment(pay.startedAt), whenLabel: 'реквизиты не выданы' };
  }
  if (state === 'paid') return { tone: known[0], label: known[1], when: payMoment(pay.paidAt), whenLabel: 'деньги пришли' };
  return { tone: known[0], label: known[1] };
}

// Тон заказа: «none» — оплата не запускалась вовсе (в том числе у всех прежних
// заявок). Отдельная функция, потому что тон нужен и там, где сама плашка не
// рисуется: в классе строки и в счётчиках сводки.
function orderTone(order, now) {
  const view = payView(order, now);
  return view ? view.tone : 'none';
}
// Класс строки заказа. Оплаченную и отменённую заявку в списке надо отличать с
// одного взгляда, не вчитываясь в плашку: строка красится подложкой и полоской
// у левого края. У заявки без оплаты класса тона нет — она остаётся белой.
function orderRowClass(order, now) {
  const tone = orderTone(order, now);
  return tone === 'none' ? 'o-row' : `o-row o-row-${tone}`;
}
/* Плашка состояния и время под ней.
 *
 * Время — не украшение: «ждём оплату» без него не отличить от «ждём оплату,
 * которое кончилось десять минут назад», а именно это менеджеру и надо знать,
 * чтобы решить, звонить сейчас или подождать. У живого счёта идёт обратный
 * отсчёт (тикает `public/admin-ui.js` по `data-pay-until`), у остальных —
 * момент, когда всё случилось.
 */
function orderStatus(order, now) {
  const view = payView(order, now);
  if (!view) return '<span class="muted">—</span>';
  // У черновика оплаты нет вовсе — приписки кассы брать неоткуда.
  const pay = order.payment || {};
  const at = now || Date.now();
  // Точка вместо прежнего глифа (⏳ ✓ ⚠ ⌛ ✕): эмодзи приезжали цветными из
  // системного шрифта, спорили с цветом самой плашки и в каждой системе
  // выглядели по-своему.
  const tag = `<span class="pay-tag pay-${view.tone}"><i></i>${esc(view.label)}</span>`;
  const left = view.until
    ? `<div class="muted small o-left" data-pay-until="${view.until}" data-over="${esc(view.over || '')}">`
      + `осталось <b>${esc(payLeftText(view.until - at))}</b></div>`
    : '';
  const when = view.when ? `<div class="muted small o-when">${esc(view.whenLabel)} · ${esc(view.when)}</div>` : '';
  return tag + left + when + (pay.note ? `<div class="muted small o-note">${esc(pay.note)}</div>` : '');
}

// Чем платят — своим столбцом. У заказа без онлайн-оплаты прочерк: менеджер
// договаривается сам, и «—» здесь честнее пустой ячейки.
function orderPayMethod(order) {
  const pay = payDisplay(order && order.payment);
  // Незнакомый код (касса включила новый способ) показываем как есть: «—»
  // вместо него означало бы «платили неизвестно чем», а это неправда.
  const method = pay && pay.method ? PAY.describe(pay.method).name : '';
  // Валюта — только если счёт был не в рублях: у рублёвого это шум в каждой
  // строке списка.
  const cur = PAY.currencyCode(pay && pay.currency);
  const extra = cur && cur !== PAY.BASE ? ` · ${PAY.formatAmount(pay.amount, cur)}` : '';
  return method ? esc(method + extra) : '<span class="muted">—</span>';
}

/* ===== Сводка по заказам: сколько оплачено, сколько отменили, и выручка =====
 *
 * Считается по состоянию ОПЛАТЫ, а не по полю `status`: ручной статус с панелей
 * снят (см. «Почему оплата не подменяет статус заказа» в CLAUDE.md), и
 * единственное настоящее состояние заявки — то, что ответила касса.
 *
 * Выручка — это `total` оплаченных заказов, то есть вместе с доставкой: столько
 * магазин и получил. Берётся именно рублёвый `total`, а не `payment.amount`:
 * второй лежит в валюте счёта, и складывать его с рублёвыми заказами нельзя.
 *
 * Считается по ВСЕМУ списку, а не по показанной странице: «оплачено 12» на
 * седьмой странице означало бы двенадцать из пятидесяти, а не из всех.
 */
const ORDER_TONES = [
  { key: 'ok', label: 'Оплачено', note: 'деньги получены' },
  // «на 300 000 ₽» — это деньги, которые ещё в игре, и с выручкой они не
  // складываются. У остальных состояний суммы нет вовсе: там подписью полезнее
  // объяснить, что состояние значит.
  { key: 'wait', label: 'Ждут оплату', money: 'на' },
  // «Не завершены» — покупатель дошёл до оплаты, но реквизитов так и не получил
  // (касса отказала). Раньше такие заявки считались вместе с теми, кто прямо
  // сейчас переводит деньги, и «Ждут оплату 12» означало неизвестно что.
  { key: 'idle', label: 'Не завершены', note: 'реквизиты не выданы', hideEmpty: true },
  // Черновик: до кассы дело не дошло вовсе. Своя плитка, а не общая с
  // «Не завершены»: там покупателя подвела касса, а здесь он ушёл сам — и это
  // разные разговоры при звонке.
  { key: 'draft', label: 'Способ не выбран', note: 'ушли со страницы оплаты', hideEmpty: true },
  // Эти две плитки при нуле не показываются: «Проверить 0» — сообщение о том,
  // что делать нечего, а сводка отвечает на вопрос «что сейчас с заказами».
  { key: 'warn', label: 'Проверить', note: 'сумма не сошлась или платёж не прошёл', hideEmpty: true },
  { key: 'off', label: 'Не оплачены', note: 'счёт истёк или отменён' },
  { key: 'none', label: 'Без оплаты', note: 'оплата не запускалась', hideEmpty: true }
];
function orderStats(list, now) {
  const tones = {};
  for (const t of ORDER_TONES) tones[t.key] = { n: 0, sum: 0 };
  let count = 0, sum = 0;
  // Момент считаем один раз на весь список: у «ждём оплату» тон зависит от
  // времени, и заказ, у которого счёт сгорает прямо сейчас, не должен попасть в
  // одну плитку по счёту и в другую по сумме.
  const at = now || Date.now();
  for (const o of list || []) {
    const value = Number(o && o.total) || 0;
    const tone = tones[orderTone(o, at)];
    tone.n++; tone.sum += value; count++; sum += value;
  }
  return { count, sum, revenue: tones.ok.sum, paid: tones.ok.n, tones };
}

function statNumber(n) { return (Number(n) || 0).toLocaleString('ru-RU'); }

/* Разметка сводки — одна на «Обзор» и на «Заказы»: расходиться этим двум местам
 * нечем, а разъехавшиеся счётчики читаются как разные числа об одном и том же.
 *
 * Первая плитка — выручка, и общее число заказов стоит её подписью. Отдельной
 * плитки «Всего» нет намеренно: рядом с «Оплачено 12 из 37» она печатала бы те
 * же числа второй раз, а сводка из повторов читается медленнее, чем из разных
 * чисел.
 */
function orderStatsBar(stats, settings) {
  const s = stats || orderStats([]);
  const tile = (tone, label, value, note) => `<div class="o-stat${tone ? ` o-stat-${tone}` : ''}">`
    + `<span class="o-stat-k">${tone ? '<i></i>' : ''}${label}</span>`
    + `<strong>${value}</strong><small>${note}</small></div>`;
  const total = s.count ? `всего ${statNumber(s.count)} ${pluralRu(s.count, 'заказ', 'заказа', 'заказов')}` : 'заказов пока нет';
  const tiles = [`<div class="o-stat o-stat-money"><span class="o-stat-k">Выручка</span>`
    + `<strong>${money(s.revenue, settings)}</strong><small>${total}</small></div>`];
  for (const t of ORDER_TONES) {
    const group = s.tones[t.key];
    if (!group.n && t.hideEmpty) continue;
    // У пустой плитки подписи нет вовсе: «Ждут оплату 0 · на 0 ₽» и «Оплачено
    // 0 · деньги получены» — это объяснение того, чего не случилось.
    const note = group.n ? (t.money ? `${t.money} ${money(group.sum, settings)}` : t.note) : '';
    tiles.push(tile(t.key, t.label, statNumber(group.n), note));
  }
  return `<div class="o-stats">${tiles.join('')}</div>`;
}

/* ===== Оболочка панели: глифы разделов =====
 *
 * Глифы — тот же холст 24×24 и та же волосяная обводка 1.6, что у значков
 * посетителя (`lib/client-icons.js`) и у характеристик витрины: вес штриха во
 * всём проекте один. Раздел опознаётся по значку быстрее, чем по слову, и
 * выпадающий список из-за них перестал быть сплошной стеной текста.
 *
 * Незнакомый ключ даёт пустую строку, а не поломанную разметку: подпись раздела
 * остаётся на месте и без значка.
 */
const A_ICONS = {
  dash: '<rect x="3.6" y="3.6" width="7.2" height="7.2" rx="2"/><rect x="13.2" y="3.6" width="7.2" height="7.2" rx="2"/><rect x="3.6" y="13.2" width="7.2" height="7.2" rx="2"/><rect x="13.2" y="13.2" width="7.2" height="7.2" rx="2"/>',
  // Каталог у владельца называется `products`, у админки сайта — `catalog`:
  // ключи разделов у панелей свои, а значок один и тот же.
  catalog: '<path d="M12 3.4 20.4 7.7v8.6L12 20.6 3.6 16.3V7.7z"/><path d="M3.6 7.7 12 12l8.4-4.3M12 12v8.6"/>',
  reviews: '<path d="M12 3.9l2.6 5.3 5.8.85-4.2 4.1 1 5.8-5.2-2.73-5.2 2.73 1-5.8-4.2-4.1 5.8-.85z"/>',
  sites: '<circle cx="12" cy="12" r="8.4"/><path d="M3.6 12h16.8"/><path d="M12 3.6c2.2 2.3 3.4 5.3 3.4 8.4S14.2 18.1 12 20.4c-2.2-2.3-3.4-5.3-3.4-8.4S9.8 5.9 12 3.6z"/>',
  orders: '<path d="M4.6 6.4h14.8l-1.3 9.2H5.9z"/><path d="M4.6 6.4 4 3.7H1.9"/><circle cx="8.6" cy="19.3" r="1.5"/><circle cx="16.2" cy="19.3" r="1.5"/>',
  analytics: '<path d="M4.2 19.4h15.6"/><path d="M7.3 19.4v-5.6M12 19.4V7.2M16.7 19.4v-8.6"/>',
  settings: '<circle cx="12" cy="12" r="3.1"/><path d="M12 3.5v2.2M12 18.3v2.2M20.5 12h-2.2M5.7 12H3.5M18 6l-1.6 1.6M7.6 16.4 6 18M18 18l-1.6-1.6M7.6 7.6 6 6"/>'
};
A_ICONS.products = A_ICONS.catalog;
function adminIcon(key) {
  const path = A_ICONS[String(key || '')];
  return path
    ? `<svg class="a-nav-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${path}</svg>`
    : '';
}

/* Переключатель режима правки. Пока он выключен, кнопок удаления в таблице нет
 * вовсе: «✕» у каждой строки — это удаление заказа в один промах мыши, а список
 * заказов открывают, чтобы читать, а не чистить.
 *
 * Чистый CSS: скрытый чекбокс и подпись-кнопка рядом с ним, столбец действий
 * показывается правилом `:checked ~ table`. Ни строчки скрипта, поэтому режим
 * работает и там, где скрипты панели не загрузились.
 */
function editSwitch(id, label) {
  return `<input type="checkbox" id="${esc(id)}" class="edit-switch sr-only">
    <div class="a-panel-head a-panel-edit">
      <label class="edit-btn" for="${esc(id)}" title="${esc(label || 'Показать удаление')}">
        <span class="edit-off">✎ Изменить</span><span class="edit-on">✓ Готово</span>
      </label>
    </div>`;
}

function pluralRu(n, one, few, many) {
  const a = Math.abs(Number(n) || 0) % 100;
  const b = a % 10;
  if (a > 10 && a < 20) return many;
  if (b > 1 && b < 5) return few;
  return b === 1 ? one : many;
}
function reviewCountText(count) { return `${count} ${pluralRu(count, 'отзыв', 'отзыва', 'отзывов')}`; }
// То же самое, но с разделителем разрядов — для строки рядом с оценкой. Голое
// «1225» вплотную к «4.9» сливается со второй цифрой, а «1 225 отзывов» нет.
function reviewsCountLong(count) {
  return `${Number(count).toLocaleString('ru-RU')} ${pluralRu(count, 'отзыв', 'отзыва', 'отзывов')}`;
}

// Поле «Фото» в форме отзыва на витрине. Выключатель оставлен: снимки от
// посетителей — единственное, что приходит в хранилище без модерации файла (сам
// отзыв ждёт одобрения, а файл уже лежит), и при злоупотреблении поле нужно
// уметь убрать одной правкой. Показ уже загруженных фото от него не зависит.
const REVIEW_PHOTOS = true;
// Сколько снимков принимаем с витрины за раз. У панели свой предел (он больше):
// там фото добавляет владелец, а здесь — кто угодно, и каждый файл может весить
// до 6 МБ (MAX_FILE в lib/server-lib.js).
const REVIEW_PHOTOS_MAX = 6;
// Слово рядом со звёздами: пять звёзд подряд одинаково выглядят и при наведении,
// и при выборе, а словом видно, что именно выбрано. Подписи живут ЗДЕСЬ и уезжают
// в разметку атрибутом `data-note` у каждой звезды — свой список в public/app.js
// разошёлся бы с этим на первой же правке.
const RATE_NOTES = ['Ужасно', 'Плохо', 'Нормально', 'Хорошо', 'Отлично'];
// Значок у кнопки выбора снимков. Волосяной контур и холст 24×24 — тот же вес
// штриха, что у остальных глифов витрины.
const RF_PHOTO_ICO = '<svg class="rf-file-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'
  + '<rect x="2.6" y="7.4" width="18.8" height="12.6" rx="2.6"/><path d="M8.4 7.4l1.5-2.6h4.2l1.5 2.6"/>'
  + '<circle cx="12" cy="13.8" r="3.5"/></svg>';

// Отзывов у популярных товаров сотни, поэтому страница товара отдаёт только
// одну страницу, а остальные приходят через GET /api/reviews той же разметкой.
const REVIEWS_PER_PAGE = 8;
// Первым идёт режим по умолчанию: свежие отзывы полезнее любых «полезных».
const REVIEW_SORTS = [
  ['new', 'Новые'],
  ['low', 'Низкая оценка'],
  ['high', 'Высокая оценка']
];
const REVIEW_SORT_KEYS = REVIEW_SORTS.map(([key]) => key);

function reviewSortMode(sort) {
  return REVIEW_SORT_KEYS.includes(String(sort)) ? String(sort) : REVIEW_SORT_KEYS[0];
}


function sortReviews(list, sort) {
  const arr = list.slice();
  const fresh = (a, b) => Number(b.createdAt || 0) - Number(a.createdAt || 0);
  const mode = reviewSortMode(sort);
  // Внутри одной оценки всегда сначала свежие: иначе «низкая оценка» открывает
  // ленту трёхлетними жалобами, которые к нынешнему сервису отношения не имеют.
  if (mode === 'low') return arr.sort((a, b) => (Number(a.rating) || 0) - (Number(b.rating) || 0) || fresh(a, b));
  if (mode === 'high') return arr.sort((a, b) => (Number(b.rating) || 0) - (Number(a.rating) || 0) || fresh(a, b));
  // По умолчанию — строго по дате, и ничего поверх неё. Отзывы с фото и видео
  // и так оказываются наверху: самые свежие даты раздаются именно им
  // (см. lib/review-dates.js). Любая перестановка здесь эту ленту ломала:
  // отзыв за 8 августа над отзывом за 18-е читается как сбой витрины.
  return arr.sort(fresh);
}

// Оценок по признакам (доставка, сервис, цена) на витрине больше нет: у отзыва
// одна общая оценка. Три отдельные шкалы занимали место в каждой карточке и в
// сводке над списком, а покупателю про товар не говорили ничего.

// Подпись доставки с логотипом перевозчика. Логотип — тот же файл и тот же
// приём, что на оформлении: символ из спрайта, высота фиксирована, ширина по
// viewBox. Нет файла — остаётся название текстом, раскладка не меняется.
function reviewDelivery(id) {
  const key = String(id || '');
  // Только перевозчик из закрытого списка. Хранилище это и так проверяет, но
  // разметка не должна верить полю на слово: чужая строка не попадёт на витрину
  // даже из старых данных или правки файла руками.
  if (!key || !DELIVERY.isValid(key)) return '';
  const label = DELIVERY.nameOf(key);
  const box = DLOGO.viewBox(key);
  const mark = box
    ? `<svg class="rv-ship-logo" viewBox="${esc(box)}" role="img" aria-label="${esc(label)}"><use href="#dl-${esc(key)}"></use></svg>`
    : `<span class="rv-ship-name">${esc(label)}</span>`;
  // Слово «Доставка» осталось только для чтения с экрана: в строке-подписи оно
  // стояло вплотную к вордмарке перевозчика и повторяло то, что она и так
  // говорит, — а место в этой строке дорогое.
  return `<span class="rv-ship" title="Доставка: ${esc(label)}"><span class="sr-only">Доставка: </span>${mark}</span>`;
}

const MEDIA_THUMB = 320;   // сторона миниатюры, как в lib/images.js

// Фото и видео отзыва — одной лентой, а не двумя блоками: открыв снимок,
// посетитель должен долистать до ролика и обратно, не закрывая просмотр.
// Ссылки настоящие: без скрипта клик просто открывает файл, как раньше.
// Обложки у роликов нет, поэтому кадром служит сам <video> с preload="metadata" —
// браузер показывает первый кадр, и лишних файлов заводить не приходится.
function reviewMedia(videos, photos, poster, previews) {
  const items = []
    .concat(videos.map(src => ({ src, kind: 'video' })))
    .concat(photos.map(src => ({ src, kind: 'photo' })));
  if (!items.length) return '';
  const prev = previews || {};
  // data-media + data-kind — договор с public/media-lightbox.js: по ним он
  // собирает галерею. Классы у витрины и панели свои, атрибуты общие.
  return `<div class="review-media" data-media>${items.map((it, i) => {
    const href = `/uploads/${esc(it.src)}`;
    // В ленте — лёгкая миниатюра (у видео это кадр из него), полный файл
    // грузится только когда вложение открыли. Снимок 900×1200 весом 260 КБ в
    // квадратике 92×92 — это мегабайты на страницу отзывов на ровном месте.
    const small = prev[it.src] || (it.kind === 'photo' ? it.src : (it.kind === 'video' ? poster : ''));
    const label = it.kind === 'video' ? 'Видео к отзыву' : 'Фото к отзыву';
    const badge = it.kind === 'video' ? '<span class="rv-play" aria-hidden="true"></span>' : '';
    // Кадра у ролика может и не быть (старая запись, ffmpeg не отработал) —
    // тогда кадром служит сам <video>, как раньше. Ломаться тут нельзя.
    const inner = small
      ? `<img src="/uploads/${esc(small)}" alt="${label}" loading="lazy" decoding="async" width="${MEDIA_THUMB}" height="${MEDIA_THUMB}" draggable="false">`
      : `<video src="${href}#t=0.1" preload="metadata" muted playsinline disablepictureinpicture></video>`;
    return `<a class="rv-item rv-${it.kind}" href="${href}" data-kind="${it.kind}" data-i="${i}" target="_blank" rel="noopener" aria-label="${label}">${inner}${badge}</a>`;
  }).join('')}</div>`;
}

/* Ответ магазина под отзывом.
 *
 * Названия магазина в шапке нет намеренно: продавец на витрине ровно один, его
 * имя стоит в шапке страницы и в подвале, и третий повтор ничего не добавляет —
 * та же причина, по которой из карточки каталога убрана строка категории.
 * Отвечает на вопрос «кто это написал» подпись «Ответ магазина», а её и глиф
 * витрины (тот же навес с дверью, что у пункта выдачи на оформлении) хватает,
 * чтобы отличить ответ от отзыва с одного взгляда.
 *
 * Блок компактный по построению: серая подложка, одна строка шапки и текст.
 * Переносы строк сохраняются стилем (`white-space:pre-line`), а не вставкой
 * <br> в разметку — ответ пишут в обычной textarea, и абзацы в нём бывают.
 */
const REPLY_GLYPH = '<path d="M3.6 9.2 5.2 4.4h13.6l1.6 4.8M4.9 9.2v10.4h14.2V9.2M9.7 19.6v-5.4h4.6v5.4"/>';
function reviewReply(rv) {
  const reply = rv && rv.reply;
  const text = String((reply && reply.text) || '').trim();
  if (!text) return '';
  const at = Number(reply.at);
  const when = Number.isFinite(at) && at > 0
    ? `<time class="rr-when" datetime="${new Date(at).toISOString()}">${formatDate(at)}</time>` : '';
  return `<div class="review-reply">
        <div class="rr-head">
          <svg class="rr-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${REPLY_GLYPH}</svg>
          <b class="rr-title">Ответ магазина</b>${when}
        </div>
        <p class="rr-text">${esc(text)}</p>
      </div>`;
}

// Карточка отзыва. Шапка в две строки — «кто и как оценил» и одна серая строка
// мелочей (когда, что купил, чем везли), — а дальше текст и вложения.
//
// Раньше эти мелочи занимали три отдельных ряда: дата в шапке справа, сборка
// под звёздами и подпись доставки отдельной строкой в самом низу. Вместе они
// съедали половину высоты карточки, хотя по отдельности не значат почти ничего:
// это уточнения к отзыву, а не его содержание.
function reviewCard(rv) {
  const rating = Math.max(1, Math.min(5, Number(rv.rating) || 1));
  const ts = Number.isFinite(Number(rv.createdAt)) ? Number(rv.createdAt) : 0;
  const videos = (rv.videos || []).filter(Boolean);
  const photos = (rv.photos || []).filter(Boolean);
  const author = String(rv.author == null ? '' : rv.author).trim();
  // Кружок с первой буквой имени: по нему лента читается сверху вниз, не
  // вглядываясь в текст. Ни картинок, ни цветов по автору — это подпись, а не
  // аватар, и пёстрая колонка отвлекала бы от самих отзывов.
  const initial = author ? author.slice(0, 1).toUpperCase() : '·';
  const meta = [`<time${ts ? ` datetime="${new Date(ts).toISOString()}"` : ''}>${formatDate(rv.createdAt)}</time>`];
  if (rv.config) meta.push(`<span class="review-config">${esc(rv.config)}</span>`);
  const ship = reviewDelivery(rv.delivery);
  if (ship) meta.push(ship);
  return `
    <article class="review" data-rating="${rating}" data-ts="${ts}" data-len="${String(rv.text || '').length}"${videos.length ? ' data-video="1"' : ''}>
      <div class="review-head">
        <span class="review-ava" aria-hidden="true">${esc(initial)}</span>
        <div class="review-who">
          <div class="review-name"><span class="review-author">${esc(rv.author)}</span>${stars(rv.rating)}</div>
          <div class="review-meta">${meta.join('<span class="review-sep" aria-hidden="true">·</span>')}</div>
        </div>
      </div>
      ${rv.text ? `<p class="review-text">${esc(rv.text)}</p>` : ''}
      ${reviewMedia(videos, photos, rv.poster, rv.previews)}
      ${reviewReply(rv)}
    </article>`;
}

// Срез отзывов под запрошенные сортировку и страницу. Номер страницы приходит
// из адреса и от витрины, поэтому приводится к допустимому диапазону здесь же.
function reviewsSlice(list, sort, page) {
  const total = list.length;
  const pages = Math.max(1, Math.ceil(total / REVIEWS_PER_PAGE));
  const current = Math.min(pages, Math.max(1, Math.floor(Number(page)) || 1));
  const offset = (current - 1) * REVIEWS_PER_PAGE;
  const items = sortReviews(list, sort).slice(offset, offset + REVIEWS_PER_PAGE);
  return {
    items, html: items.map(reviewCard).join(''), sort: reviewSortMode(sort),
    page: current, pages, total, from: items.length ? offset + 1 : 0, to: offset + items.length
  };
}

function reviewsRangeText(slice) {
  if (!slice.total) return '';
  if (slice.pages === 1) return reviewCountText(slice.total);
  return `Отзывы ${slice.from}–${slice.to} из ${slice.total}`;
}

// Номера для листалки: первая, последняя, текущая и соседние. Между разрывами
// ставится многоточие, поэтому у 38 страниц ряд остаётся коротким.
function reviewsPageNumbers(page, pages) {
  const wanted = [];
  const add = n => { if (n >= 1 && n <= pages && !wanted.includes(n)) wanted.push(n); };
  add(1);
  for (let n = page - 2; n <= page + 2; n++) add(n);
  add(pages);
  wanted.sort((a, b) => a - b);
  const row = [];
  let prev = 0;
  for (const n of wanted) {
    if (prev && n - prev > 1) row.push('gap');
    row.push(n);
    prev = n;
  }
  return row;
}

// Постраничная навигация для панелей. На боевых данных 7000 отзывов, и список
// «все сразу» весил 4,5 МБ и держал единственный поток 16 секунд — всё это время
// витрина не отвечала никому. Разметка своя, простая: у админки нет ни JS-догрузки,
// ни якоря #reviews, зато нужен произвольный набор query-параметров.
const ADMIN_PER_PAGE = 50;
// Срез списка под номер страницы. Номер приходит из адреса, поэтому зажимается здесь же.
function adminSlice(list, page, perPage) {
  const size = perPage || ADMIN_PER_PAGE;
  const total = list.length;
  const pages = Math.max(1, Math.ceil(total / size));
  const current = Math.min(pages, Math.max(1, Math.floor(Number(page)) || 1));
  const offset = (current - 1) * size;
  return {
    items: list.slice(offset, offset + size), page: current, pages, total,
    from: total ? offset + 1 : 0, to: Math.min(total, offset + size)
  };
}
// href(n) строит адрес страницы n — у каждой панели свои параметры (status, site).
function adminPager(slice, href) {
  if (slice.pages < 2) return `<div class="a-pager-info muted small">Всего: ${slice.total}</div>`;
  const link = (n, label, cls) => (n >= 1 && n <= slice.pages)
    ? `<a class="a-page${cls || ''}" href="${href(n)}">${label}</a>`
    : `<span class="a-page a-page-off" aria-hidden="true">${label}</span>`;
  const numbers = reviewsPageNumbers(slice.page, slice.pages).map(item => {
    if (item === 'gap') return `<span class="a-page-gap" aria-hidden="true">…</span>`;
    if (item === slice.page) return `<span class="a-page a-page-cur" aria-current="page">${item}</span>`;
    return link(item, item);
  }).join('');
  return `<nav class="a-pager" aria-label="Страницы">${link(slice.page - 1, '‹', ' a-page-arrow')}${numbers}${link(slice.page + 1, '›', ' a-page-arrow')}`
    + `<span class="a-pager-info muted small">${slice.from}–${slice.to} из ${slice.total}</span></nav>`;
}

const PAGER_CHEVRON = {
  prev: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 5l-7 7 7 7"/></svg>`,
  next: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 5l7 7-7 7"/></svg>`
};

// Внутренности листалки. Отдаются и страницей товара, и /api/reviews: после
// перехода витрина заменяет разметку целиком, чтобы номера не считались дважды.
function reviewsPager(slice, base) {
  if (slice.pages < 2) return '';
  const href = n => `${base}?rsort=${slice.sort}&amp;rpage=${n}#reviews`;
  const arrow = (dir, n, label) => (n >= 1 && n <= slice.pages)
    ? `<a class="rev-page rev-arrow" href="${href(n)}" rel="${dir}" data-page="${n}" aria-label="${label}">${PAGER_CHEVRON[dir]}</a>`
    : `<span class="rev-page rev-arrow rev-off" aria-hidden="true">${PAGER_CHEVRON[dir]}</span>`;
  const numbers = reviewsPageNumbers(slice.page, slice.pages).map(item => {
    if (item === 'gap') return `<span class="rev-gap" aria-hidden="true">…</span>`;
    // Дальние номера на узком экране прячет CSS: там остаются стрелки, соседи и края.
    const far = Math.abs(item - slice.page) === 2 ? ' rev-far' : '';
    if (item === slice.page) return `<span class="rev-page rev-cur${far}" aria-current="page">${item}</span>`;
    return `<a class="rev-page${far}" href="${href(item)}" data-page="${item}" aria-label="Страница ${item}">${item}</a>`;
  }).join('');
  return `<nav class="rev-pages" aria-label="Страницы отзывов">${arrow('prev', slice.page - 1, 'Предыдущая страница')}${numbers}${arrow('next', slice.page + 1, 'Следующая страница')}</nav>`
    + `<span class="reviews-shown muted small" id="reviews-shown" aria-live="polite">${reviewsRangeText(slice)}</span>`;
}

// Звёзды рейтинга: серый фон + золотой слой, обрезанный по проценту.
function stars(rating) {
  const value = Number(rating);
  const safe = Number.isFinite(value) ? Math.max(0, Math.min(5, value)) : 0;
  const pct = (safe / 5) * 100;
  return `<span class="stars" role="img" aria-label="${safe} из 5">`
    + `<span class="stars-bg">★★★★★</span>`
    + `<span class="stars-fg" style="width:${pct}%">★★★★★</span>`
    + `</span>`;
}

// Иконки-плейсхолдеры по категории (когда у товара нет загруженных фото).
const GLYPHS = {
    phone: '<rect x="150" y="70" width="100" height="180" rx="18" fill="none" stroke="#fff" stroke-width="7"/><line x1="180" y1="222" x2="220" y2="222" stroke="#fff" stroke-width="7" stroke-linecap="round"/>',
    laptop: '<rect x="128" y="95" width="144" height="92" rx="8" fill="none" stroke="#fff" stroke-width="7"/><path d="M108 205 h184 l14 22 H94 Z" fill="none" stroke="#fff" stroke-width="7" stroke-linejoin="round"/>',
    tablet: '<rect x="132" y="80" width="136" height="160" rx="14" fill="none" stroke="#fff" stroke-width="7"/><circle cx="200" cy="222" r="5" fill="#fff"/>',
    watch: '<rect x="158" y="120" width="84" height="90" rx="22" fill="none" stroke="#fff" stroke-width="7"/><path d="M172 120 l8 -38 h40 l8 38 M172 210 l8 38 h40 l8 -38" fill="none" stroke="#fff" stroke-width="7" stroke-linejoin="round"/>',
    earbuds: '<path d="M170 110 c-26 0 -34 30 -30 60 c4 26 26 30 30 6 c3 -20 -2 -40 0 -66 Z" fill="none" stroke="#fff" stroke-width="7"/><path d="M230 110 c26 0 34 30 30 60 c-4 26 -26 30 -30 6 c-3 -20 2 -40 0 -66 Z" fill="none" stroke="#fff" stroke-width="7"/>',
  generic: '<path d="M200 96 c30 0 52 22 52 58 c0 44 -34 92 -52 92 c-18 0 -52 -48 -52 -92 c0 -36 22 -58 52 -58 Z" fill="none" stroke="#fff" stroke-width="7"/><path d="M200 96 c0 -18 14 -30 30 -30" fill="none" stroke="#fff" stroke-width="7" stroke-linecap="round"/>'
};

function glyphKey(category) {
  const c = String(category || '').toLowerCase();
  if (/(iphone|phone|телефон)/.test(c)) return 'phone';
  if (/(mac|book|ноут|laptop)/.test(c)) return 'laptop';
  if (/(ipad|tablet|планшет)/.test(c)) return 'tablet';
  if (/(watch|часы)/.test(c)) return 'watch';
  if (/(airpod|pod|наушник|buds)/.test(c)) return 'earbuds';
  return 'generic';
}

// Спрайт плейсхолдеров: шесть заготовок один раз на страницу. Раньше каждая карточка
// несла свою копию SVG (38% веса каталога) и свой <linearGradient id="g"> — то есть
// на странице было четыре десятка элементов с одинаковым id.
const PH_SPRITE = `<svg class="ph-sprite" aria-hidden="true" width="0" height="0" style="position:absolute">`
  + `<linearGradient id="ph-g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#eef1f6"/><stop offset="1" stop-color="#dfe4ec"/></linearGradient>`
  + Object.keys(GLYPHS).map(k => `<symbol id="ph-${k}" viewBox="0 0 400 320" preserveAspectRatio="xMidYMid meet">`
    + `<rect width="400" height="320" fill="url(#ph-g)"/>`
    + `<g opacity="0.55" stroke-linecap="round">${GLYPHS[k]}</g></symbol>`).join('')
  + `</svg>`;

function placeholderSvg(product) {
  return `<svg class="ph" viewBox="0 0 400 320" preserveAspectRatio="xMidYMid meet" aria-hidden="true"><use href="#ph-${glyphKey(product.category)}"/></svg>`;
}

// Разметка изображения товара: загруженное фото или SVG-плейсхолдер.
function imageMarkup(product, index, opts) {
  const imgs = product.images || [];
  if (imgs.length) {
    const src = imgs[index || 0];
    // width/height заданы, чтобы не «прыгала» вёрстка; главное фото товара грузим сразу (eager).
    const eager = !!(opts && opts.eager);
    return `<img src="/uploads/${esc(src)}" alt="${esc(product.name)}" width="800" height="800"`
      + ` loading="${eager ? 'eager' : 'lazy'}" decoding="async"${eager ? ' fetchpriority="high"' : ''}>`;
  }
  return placeholderSvg(product);
}

// ===== Иконки-хайлайты характеристик (авто из поля specs) =====
// Оригинальные глифы Apple из public/spec-icons — см. lib/spec-icons.js.
const { specIcon } = require('./spec-icons');
function specHighlights(p) {
  if (!p.specs) return '';
  const seen = new Set();   // повторный глиф на этой же странице вставится ссылкой <use>
  const items = String(p.specs).split('\n').map(l => l.trim()).filter(Boolean).map(line => {
    const i = line.indexOf(':');
    const key = i > -1 ? line.slice(0, i).trim() : '';
    const val = i > -1 ? line.slice(i + 1).trim() : line;
    // Разметка как в highlights на apple.com: глиф слева, одна строка текста справа.
    return `<li class="spec-item"><span class="spec-ico">${specIcon(key, val, seen)}</span>`
      + `<span class="spec-txt">${key ? `<b class="spec-key">${esc(key)}</b> ` : ''}${esc(val)}</span></li>`;
  }).join('');
  return `<section class="section spec-section">`
    + `<h2 class="spec-h">Характеристики. <span class="muted">Всё, что важно знать.</span></h2>`
    + `<ul class="spec-grid">${items}</ul></section>`;
}

// Наборы шрифтов для брендинга (выбираются в настройках сайта).
const FONTS = {
  system: '-apple-system,BlinkMacSystemFont,"SF Pro Text","Segoe UI",Roboto,Helvetica,Arial,sans-serif',
  rounded: 'ui-rounded,"SF Pro Rounded",Quicksand,Nunito,system-ui,sans-serif',
  serif: 'Georgia,"Iowan Old Style","Times New Roman",serif',
  slab: 'Rockwell,"Roboto Slab",Georgia,serif',
  mono: '"SF Mono",ui-monospace,Menlo,Consolas,monospace',
  grotesk: '"Space Grotesk","Trebuchet MS","Helvetica Neue",Arial,sans-serif'
};
function brandFont(settings) { return FONTS[settings && settings.logoFont] || FONTS.system; }
function cssColor(value, fallback) {
  const color = String(value || '').trim();
  return /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i.test(color) ? color : (fallback || '#0071e3');
}

// Текстовый логотип: буквы в {фигурных скобках} красятся вторичным/акцентным цветом.
function logoTextMarkup(text) {
  return esc(text).replace(/\{([^}]*)\}/g, '<span class="logo-accent">$1</span>');
}
function logoMarkup(settings) {
  if (settings.logoImage) return `<img class="logo-img" src="/uploads/${esc(settings.logoImage)}" alt="${esc(settings.storeName)}">`;
  if (settings.logoText && settings.logoText.trim()) return `<span class="logo-txt">${logoTextMarkup(settings.logoText)}</span>`;
  return `<span class="logo-txt">${esc(settings.storeName)}</span>`;
}
// Telegram: юзернейм без @ и фирменная иконка (цвет задаётся через CSS color/fill:currentColor)
function tgUser(settings) { return String(settings.contactTelegram || '').replace(/^@/, '').replace(/[^a-z0-9_]/gi, ''); }
function tgIcon() { return '<svg class="tg-ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M9.78 18.65l.28-4.23 7.68-6.92c.34-.31-.07-.46-.52-.19L7.74 13.3 3.64 12c-.88-.25-.89-.86.2-1.3l15.97-6.16c.73-.33 1.43.18 1.15 1.3l-2.72 12.81c-.19.91-.74 1.13-1.5.71l-4.15-3.06-1.99 1.94c-.23.23-.42.42-.83.42z"/></svg>'; }
function tgHeaderBtn(settings) {
  if (!settings.contactTelegram) return '';
  return `<a class="tg-header" href="https://t.me/${esc(tgUser(settings))}" target="_blank" rel="noopener" aria-label="Написать в Telegram">${tgIcon()}<span class="tg-header-txt">Telegram</span></a>`;
}

function currencyCode(sym) {
  return ({ '₽': 'RUB', '$': 'USD', '€': 'EUR', '£': 'GBP', '₴': 'UAH', '₸': 'KZT' })[sym] || 'RUB';
}
function jsonLd(obj) { return JSON.stringify(obj).replace(/</g, '\\u003c'); } // безопасно для <script>
function scriptJson(value) {
  return JSON.stringify(value).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
}

// SEO-блок в <head>: описание, canonical, Open Graph, Twitter, JSON-LD.
function seoHead(settings, opts) {
  const origin = opts.origin || '';
  const canonical = origin + (opts.canonicalPath || '/');
  const desc = (opts.description || settings.tagline || settings.storeName || '').slice(0, 300);
  const ogTitle = opts.title ? opts.title + ' — ' + settings.storeName : settings.storeName;
  /* Картинка превью. У страницы товара это его первый снимок; у всех остальных
   * (главная, правовые, «не найдено») своей картинки нет, и раньше превью не
   * было вовсе — ссылка на магазин уходила в Telegram и мессенджеры голой
   * строкой. Запасной вариант — логотип магазина: он всегда загружен владельцем
   * и всегда про этот магазин.
   *
   * Тип карточки при этом разный: снимок товара — крупная карточка, логотип —
   * обычная. Логотип обычно широкий и с прозрачным фоном, в крупной карточке он
   * растягивается на пустое поле.
   */
  const ownImage = opts.ogImage ? String(opts.ogImage) : '';
  const fallbackImage = !ownImage && settings.logoImage ? '/uploads/' + settings.logoImage : '';
  const rawImage = ownImage || fallbackImage;
  const ogImage = rawImage ? (/^https?:/.test(rawImage) ? rawImage : origin + rawImage) : '';
  const bigCard = !!ownImage;
  // Оформление заказа и страница «не найдено» в индекс не идут: там нечего
  // показывать в выдаче, а дубли только размывают релевантность каталога.
  return `<meta name="description" content="${esc(desc)}">`
    + `<meta name="robots" content="${opts.noindex ? 'noindex,follow' : 'index,follow'}">`
    + (origin && !opts.noCanonical ? `<link rel="canonical" href="${esc(canonical)}">` : '')
    + `<meta property="og:site_name" content="${esc(settings.storeName)}"><meta property="og:locale" content="ru_RU">`
    + `<meta property="og:type" content="${esc(opts.ogType || 'website')}"><meta property="og:title" content="${esc(ogTitle)}">`
    + `<meta property="og:description" content="${esc(desc)}">`
    + (origin && !opts.noCanonical ? `<meta property="og:url" content="${esc(canonical)}">` : '')
    + (ogImage ? `<meta property="og:image" content="${esc(ogImage)}">` : '')
    + `<meta name="twitter:card" content="${ogImage && bigCard ? 'summary_large_image' : 'summary'}">`
    + `<meta name="twitter:title" content="${esc(ogTitle)}"><meta name="twitter:description" content="${esc(desc)}">`
    + (ogImage ? `<meta name="twitter:image" content="${esc(ogImage)}">` : '')
    + (opts.jsonLd ? `<script type="application/ld+json">${opts.jsonLd}</script>` : '');
}

// Панель «Оформление» настроек: логотип, шрифт, цвета.
function brandFields(s) {
  s = s || {};
  const fonts = [['system', 'Системный'], ['rounded', 'Округлый'], ['grotesk', 'Гротеск'], ['serif', 'С засечками'], ['slab', 'Брусковый'], ['mono', 'Моноширинный']];
  const cur = s.logoImage
    ? `<div class="field"><label>Текущий логотип</label><div class="logo-chip"><img src="/uploads/${esc(s.logoImage)}" alt=""><label class="img-remove"><input type="checkbox" name="removeLogo"> убрать</label></div></div>` : '';
  return `<div class="a-panel"><h2>Оформление</h2>
    <div class="a-form-grid">
      <div class="field"><label>Шрифт названия и заголовков</label><select name="logoFont">${fonts.map(([v, l]) => `<option value="${v}" ${s.logoFont === v ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
      <div class="field"><label>Вторичный цвет (для выделенных букв)</label><input name="secondaryColor" type="color" value="${cssColor(s.secondaryColor || s.accentColor)}"></div>
    </div>
    <div class="field"><label>Цветной текст логотипа</label><input name="logoText" value="${esc(s.logoText || '')}" placeholder="например: {i}Store"><p class="muted small">Пусто — берётся название магазина. Буквы в фигурных скобках <b>{ }</b> красятся вторичным цветом. Пример: <b>{i}Store</b> → «i» цветное.</p></div>
    ${cur}
    <div class="field"><label>Логотип-картинка (необязательно, заменяет текст)</label><input type="file" name="logo" accept="image/*"><p class="muted small">Фото автоматически чистится от метаданных и сжимается в WebP.</p></div>
  </div>`;
}

// Наличие по вариантам: цвет или память можно отключить по отдельности.
// Флага нет (старые данные) — считаем, что вариант есть.
function variantInStock(v) { return !v || v.inStock !== false; }
// Доступен ли для корпуса хотя бы один реальный ремешок. Совместимость важна
// вместе с наличием: независимые проверки «есть цвет» и «есть ремешок» давали
// ложное наличие, когда единственный ремешок подходил только распроданному корпусу.
function bandAvailableForColor(bands, caseColor) {
  return !(bands || []).length || (bands || []).some(g => (g.options || []).some(o => variantInStock(o) && bandFits(o, caseColor)));
}
function colorAvailable(p, color) {
  return variantInStock(color) && bandAvailableForColor(p.bands || [], color && color.name || '');
}
// Товар вообще можно купить? Нужен хотя бы один доступный цвет, вариант памяти,
// по одному доступному значению в каждой доп. характеристике и — у часов —
// хотя бы один доступный ремешок.
//
// `settings` нужны ради потолка одной покупки: он приходит от кассы, а её на
// витрине может не быть вовсе (см. `orderMax()` ниже). Без настроек потолка нет.
function sellable(p, settings) {
  if (!p || !p.inStock) return false;
  const colors = p.colors || [], storages = p.storages || [], bands = p.bands || [];
  const choicesOk = colors.length ? colors.some(c => colorAvailable(p, c)) : bandAvailableForColor(bands, '');
  const optionsOk = (p.options || []).every(g => (g.values || []).some(variantInStock));
  if (!choicesOk || !optionsOk || (storages.length && !storages.some(variantInStock))) return false;
  // Товар, у которого даже самая дешёвая сборка дороже потолка одной покупки,
  // купить нельзя — значит и на витрине он «Нет в наличии», а не кнопка, ведущая
  // в отказ на оформлении.
  return fitsOrderLimit(startPrice(p), orderMax(settings));
}

// Подпись наличия ПОД кнопкой покупки и выбором количества: зелёная точка «В
// наличии» или красное «Осталось несколько штук». Над кнопкой она стояла между
// рядами выбора и самой кнопкой и отодвигала покупку; под ней она читается как
// то, чем и является, — примечанием к тому, что кладут в корзину.
// Распроданному товару её не показываем — про это уже говорит кнопка «Нет в
// наличии», и два разных ответа рядом сбивали бы с толку.
// Точка мигает средствами CSS (см. .stock-dot в styles.css): ни скрипта, ни
// запроса это не добавляет, поэтому на скорость загрузки страницы не влияет.
function stockNote(p, settings) {
  if (!sellable(p, settings)) return '';
  const few = p.stockLevel === 'few';
  return `<p class="stock${few ? ' stock-few' : ''}">
          <span class="stock-dot" aria-hidden="true"></span>${few ? 'Осталось несколько штук' : 'В наличии'}
        </p>`;
}

// Значение доп. характеристики, выбранное по умолчанию: первое доступное,
// подходящее выбранной конфигурации. Нанотекстурное стекло бывает только от
// 1 ТБ, и открывать страницу с варианта, который JS тут же спрячет, нельзя.
function defaultOption(group, storage, picked) {
  const values = (group && group.values) || [];
  const pick = strict => values.findIndex(v => V.optionFits(v, storage, picked) && (!strict || variantInStock(v)));
  let i = pick(true);
  if (i === -1) i = pick(false);
  return i === -1 ? 0 : i;
}

// Что выбрано по умолчанию, когда группы зависят друг от друга: у MacBook Pro
// объём памяти и потолок накопителя определяет чип. Считаем в два прохода —
// сначала группы без учёта конфигурации, потом конфигурацию под них и группы
// заново. Открывать страницу с варианта, который скрипт тут же спрячет, нельзя.
function defaultChoices(p) {
  const storages = (p && p.storages) || [];
  const groups = (p && p.options) || [];
  const map = (byStorage) => {
    const out = {};
    for (const g of groups) {
      const v = (g.values || [])[defaultOption(g, byStorage, out)];
      if (v) out[g.name] = v.label;
    }
    return out;
  };
  const rough = map('');
  const fits = (s) => variantInStock(s) && V.optionFits(s, '', rough);
  let idx = storages.findIndex(fits);
  if (idx === -1) idx = storages.findIndex(s => V.optionFits(s, '', rough));
  if (idx === -1) idx = firstAvailable(storages);
  const label = (storages[idx] || {}).label || '';
  return { storageIdx: idx, storage: label, picked: map(label) };
}

/*
 * Потолок одной покупки на витрине (`CROCO.limits()`, см. «Пределы одной
 * покупки» в CLAUDE.md). Заказ дороже него не оформляется, поэтому и на витрине
 * недоступно всё, что за него выводит:
 *   - товар, у которого даже стартовая сборка дороже потолка, — «Нет в наличии»;
 *   - значение конфигурации или доп. характеристики, которое выводит текущую
 *     сборку за потолок, — распродано (та же кнопка `.out`, что у настоящего
 *     «нет в наличии»): у покупателя нет способа отличить одно от другого, и
 *     объяснять ему устройство кассы незачем;
 *   - количество ограничено так, чтобы `цена сборки × количество` влезала.
 * Считается всё по АКТУАЛЬНОЙ цене выбранной сборки: у Mac разница между базой
 * и старшей конфигурацией — миллион с лишним.
 *
 * Потолок берётся из настроек, а не из константы: он принадлежит КАССЕ. Оплата
 * на витрине выключена — заказ уходит заявкой, кассы в этом пути нет, и потолка
 * тоже нет (ноль). Тогда Vision Pro и другие дорогие карточки снова продаются.
 */
function orderMax(settings) { return CROCO.limits(settings).max; }

// Цена стартовой сборки: база плюс доплаты значений, выбранных по умолчанию.
// Она же — самая дешёвая: и `defaultOption()`, и `firstAvailable()` берут первое
// доступное значение, а в каталоге дешёвое значение всегда идёт первым.
function startPrice(p) {
  if (!p) return 0;
  let sum = D.effectivePrice(p);
  const choice = defaultChoices(p);
  const storage = ((p.storages || [])[choice.storageIdx] || {});
  sum += Number(storage.add) || 0;
  for (const g of p.options || []) {
    const v = (g.values || [])[defaultOption(g, choice.storage, choice.picked)];
    sum += Number((v || {}).add) || 0;
  }
  const bands = p.bands || [];
  if (bands.length) {
    const colors = (p.colors || []);
    const first = firstAvailable(colors);
    const band = defaultBand(bands, ((colors[first] || {}).name) || '');
    if (band) {
      const group = bands[band.gi] || {};
      sum += Number(((group.options || [])[band.oi] || {}).add) || 0;
      sum += Number(((group.sizes || [])[0] || {}).add) || 0;
    }
  }
  return sum;
}

// Влезает ли сборка в потолок одной покупки. Ноль (или отсутствие) значит
// «предела нет» — ровно так же это число читает `public/app.js`.
function fitsOrderLimit(price, max) { return !max || Number(price) <= max; }

// Вариация «в цвет корпуса» продаётся только со своим корпусом (титановый
// миланский у Apple подбирается в цвет часов) — для чужого корпуса её не показываем.
function bandFits(o, caseColor) { return !o || !o.forColor || o.forColor === caseColor; }
// Ремешок, выбранный по умолчанию: первый доступный, который подходит выбранному
// корпусу. Раньше сервер брал просто первый — и на чёрном титане страница
// открывалась с ремешка «только для натурального», который JS тут же прятал.
function defaultBand(bands, caseColor) {
  bands = bands || [];
  if (!bands.length) return null;
  const pick = (list, strict) => (list || []).findIndex(o => bandFits(o, caseColor) && (!strict || variantInStock(o)));
  let gi = bands.findIndex(g => pick(g.options, true) > -1);
  if (gi === -1) gi = bands.findIndex(g => pick(g.options, false) > -1);
  if (gi === -1) gi = 0;
  const opts = bands[gi].options || [];
  let oi = pick(opts, true);
  if (oi === -1) oi = pick(opts, false);
  if (oi === -1) oi = 0;
  return { gi, oi };
}
// Индекс первого доступного варианта — он и выбирается на странице по умолчанию.
function firstAvailable(list) {
  const i = (list || []).findIndex(variantInStock);
  return i === -1 ? 0 : i;
}

function firstAvailableColor(p) {
  const colors = (p && p.colors) || [];
  const compatible = colors.findIndex(c => colorAvailable(p, c));
  return compatible > -1 ? compatible : firstAvailable(colors);
}

// Подпись группы вариантов: у часов это размер корпуса, у остальных — память.
function variantLabel(p) {
  // \b в JS работает только с ASCII, поэтому русские единицы проверяем без границ слова
  const all = ((p && p.storages) || []).map(s => s.label).join(' ');
  if (/мм|\bmm\b/i.test(all)) return 'Размер корпуса';
  if (/гб|тб|\bgb\b|\btb\b/i.test(all)) {
    // У Mac рядом стоит выбор ОЗУ, и две соседние строки «Память» и «Оперативная
    // память» читаются как одно и то же. Там накопитель называем прямо.
    return ((p && p.options) || []).some(g => g.name === 'Оперативная память') ? 'Накопитель' : 'Память';
  }
  return 'Вариант';
}

// Значки строки отзывов и плашки распродажи — по образцу карточки Ozon: одна
// золотая звезда с оценкой, следом пузырёк и число отзывов словом. Пять звёзд
// в карточке каталога занимали ширину, но ничего не добавляли — оценку всё
// равно читают числом рядом с ними; сами звёзды остаются там, где их читают
// как оценку (страница товара, карточка отзыва).
//
// Глифы свои, а не снятые с площадки: звезда, пузырёк и пламя — общеупотребимые
// фигуры, и рисовать их проще, чем тащить чужие файлы. Залитые, а не волосяные
// (в отличие от глифов характеристик): на 16 px контур не читается.
const RT_STAR = '<svg class="rt-star" viewBox="0 0 16 16" fill="currentColor" stroke="currentColor" stroke-width=".9" stroke-linejoin="round" aria-hidden="true"><path d="M8 2.4 9.56 6.16 13.61 6.48 10.52 9.12 11.47 13.07 8 10.95 4.53 13.07 5.48 9.12 2.39 6.48 6.44 6.16Z"/></svg>';
const RT_BUBBLE = '<svg class="rt-bubble" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M8.5 3C11.9 3 14 5 14 8s-2.1 5-5.5 5c-.9 0-1.72-.14-2.42-.4-.72.26-1.5.4-2.3.4-.99 0-.99-.54-.5-1.08.3-.33.58-.74.8-1.19C3.4 9.9 3 9 3 8c0-3 2.1-5 5.5-5Z"/></svg>';
const SALE_FLAME = '<svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M8 1.5s.9 2.05 2.2 3.35C11.7 6.3 13 7.7 13 9.7c0 2.9-2.24 4.8-5 4.8S3 12.6 3 9.7c0-1.3.5-2.45 1.4-3.4 0 1.1.5 1.8 1.2 2.05C5.8 5.6 6.6 3.3 8 1.5Z"/></svg>';
// Тележка у подписи «В корзину» — как в карточке Ozon: значок слева, текст
// справа. Контур волосяной, а не залитый: кнопка сплошного цвета, и залитый
// глиф на ней читался бы пятном. Углы скругляет stroke-linejoin, поэтому фигура
// набрана прямыми — ни одной дуги, кроме колёс. Цвет и место берутся у кнопки:
// fill нет вовсе, размер задаёт `.btn-ico` в styles.css, зазор — gap у `.btn`.
const CART_ICO = '<svg class="btn-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'
  + '<path d="M2.9 4.3h2.05l.65 2.75h14.6l-2.05 7.3H7.9L5.6 7.05"/>'
  + '<circle cx="9.7" cy="18.4" r="1.55"/><circle cx="16.5" cy="18.4" r="1.55"/></svg>';

function productCard(p, settings, db, opts) {
  opts = opts || {};
  const r = db.ratingFor(p.id);
  const inStock = sellable(p, settings);   // распроданы все цвета или все конфигурации — товар не купить
  /* Цена карточки — САМАЯ ДЕШЁВАЯ ДОСТУПНАЯ сборка, а не базовая цена товара.
   *
   * Базовая конфигурация бывает распродана (128 ГБ кончились, остались 256 ГБ), и
   * тогда карточка обещала цену, которой на странице товара уже нет: страница
   * открывается с первого ДОСТУПНОГО варианта, то есть дороже. Покупатель видел
   * одну сумму в каталоге и другую в карточке — и это читается как обман.
   *
   * `startPrice()` считает ровно ту сборку, с которой откроется страница: первый
   * доступный цвет, конфигурация, ремешок и значение каждой доп. характеристики,
   * а дешёвое значение в каталоге всегда стоит первым. Пока всё в наличии, сумма
   * совпадает с базовой ценой — на полном каталоге не расходится ни у одного из
   * 48 товаров, — и меняется только там, где дешёвый вариант кончился.
   */
  const eff = startPrice(p);
  const pct = D.discountPct(p);
  // Зачёркнутая цена считается от той же суммы: процент у товара один на все
  // сборки, а вот рубли выгоды у более дорогой сборки свои (см. lib/discount.js).
  const cmp = D.compareFor(eff, pct);
  // Зачёркнутая цена и процент — одной группой: на узкой карточке они переносятся
  // на вторую строку вместе, а не порознь. У распроданного процент не показываем:
  // «−13%» на товаре, который нельзя купить, — обещание впустую.
  //
  const compareHtml = cmp
    ? `<span class="price-was"><span class="old-price">${money(cmp, settings)}</span>${inStock && pct > 0 ? `<span class="save">−${pct}%</span>` : ''}</span>`
    : '';
  // Число отзывов идёт с разделителем разрядов и словом: «1 225 отзывов»
  // читается, а «1225» рядом с оценкой сливается со второй цифрой.
  const ratingLine = r.count
    ? `<div class="card-rating">${RT_STAR}<span class="rt-avg">${r.avg}</span>${RT_BUBBLE}`
      + `<span class="rating-count">${reviewsCountLong(r.count)}</span></div>`
    : `<div class="card-rating card-rating-empty">Пока нет отзывов</div>`;
  // Плашка «Распродажа» лежит на снимке слева внизу — там, где её ставит Ozon.
  // Только у того, что можно купить: обещать скидку на распроданном незачем,
  // ровно как и процент выгоды рядом с ценой.
  const saleBadge = (inStock && cmp && pct > 0)
    ? `<span class="card-sale">${SALE_FLAME}Распродажа</span>` : '';
  // Ссылок на товар две — снимок и название, как в карточке Ozon. Одна обёртка
  // на всё тело карточки делала ссылкой и цену с отзывами: выделить сумму
  // мышью было нельзя, а перетаскивание начинало таскать ссылку.
  //
  // Снимок — ссылка без имени и без фокуса (`aria-hidden`, `tabindex="-1"`):
  // цель у него та же, что у названия, и без этого и клавиатура, и скринридер
  // получали бы на каждый товар по два одинаковых перехода подряд.
  const href = `/product/${esc(p.id)}`;
  return `
  <article class="card${inStock ? '' : ' card-out'}">
    <a class="card-media-link" href="${href}" tabindex="-1" aria-hidden="true">
      <div class="card-media">${imageMarkup(p, 0, { eager: !!opts.eager })}${saleBadge}</div>
    </a>
    <div class="card-body">
      <a class="card-name" href="${href}">${esc(p.name)}</a>
      ${ratingLine}
      <div class="card-price${cmp ? ' price-sale' : ''}"><span class="price-now">${money(eff, settings)}</span>${compareHtml}</div>
    </div>
    <div class="card-add">${!inStock
      ? `<button type="button" class="btn btn-primary btn-block" disabled>Нет в наличии</button>`
      : ((p.colors || []).length || (p.storages || []).length || (p.bands || []).length || (p.options || []).length)
        ? `<a class="btn btn-primary btn-block" href="/product/${esc(p.id)}">${CART_ICO}В корзину</a>`
        : `<button type="button" class="btn btn-primary btn-block add-to-cart"
          data-id="${esc(p.id)}" data-name="${esc(p.name)}" data-price="${eff}" data-img="${esc((p.images || [])[0] || '')}">${CART_ICO}В корзину</button>`}
    </div>
  </article>`;
}

// Способы оплаты в подвале. Знаки собраны разметкой, а не картинками: ни одного
// лишнего запроса и никакой растровой мазни при масштабировании. Все они одного
// цвета с текстом подвала (fill: currentColor), поэтому ряд не рябит.
// viewBox у каждого обрезан по фигуре, так что высота в CSS — это высота знака.
const PAY_MARKS = {
  // «Мир», Visa, Mastercard и СБП — официальные знаки с Викисклада (public
  // domain), приведённые к currentColor. viewBox у каждого обрезан по фигуре,
  // поэтому высота в CSS — это высота самого знака.
  mir: '<svg viewBox="31 13 351.75 96.02" fill="currentColor" aria-hidden="true"><path d="m31 13h33c3 0 12-1 16 13 3 9 7 23 13 44h2c6-22 11-37 13-44 4-14 14-13 18-13h31v96h-32v-57h-2l-17 57h-24l-17-57h-3v57h-31m139-96h32v57h3l21-47c4-9 13-10 13-10h30v96h-32v-57h-2l-21 47c-4 9-14 10-14 10h-30m142-29v29h-30v-50h98c-4 12-18 21-34 21"/><path d="m382 53c4-18-8-40-34-40h-68c2 21 20 40 39 40"/></svg>',
  // Visa — контур логотипа; transform поднимает фигуру в начало обрезанного viewBox
  visa: '<svg viewBox="0 0 24 7.76" fill="currentColor" aria-hidden="true"><path transform="translate(0,-8.12)" d="M9.112 8.262L5.97 15.758H3.92L2.374 9.775c-.094-.368-.175-.503-.461-.658C1.447 8.864.677 8.627 0 8.479l.046-.217h3.3a.904.904 0 01.894.764l.817 4.338 2.018-5.102zm8.033 5.049c.008-1.979-2.736-2.088-2.717-2.972.006-.269.262-.555.822-.628a3.66 3.66 0 011.913.336l.34-1.59a5.207 5.207 0 00-1.814-.333c-1.917 0-3.266 1.02-3.278 2.48-.012 1.079.963 1.68 1.698 2.04.756.367 1.01.603 1.006.931-.005.504-.602.725-1.16.734-.975.015-1.54-.263-1.99-.473l-.351 1.642c.453.208 1.289.39 2.156.398 2.037 0 3.37-1.006 3.376-2.565m5.061 2.447H24l-1.565-7.496h-1.656a.883.883 0 00-.826.55l-2.909 6.946h2.036l.405-1.12h2.488zm-2.163-2.656l1.02-2.815.588 2.815zm-8.16-4.84l-1.603 7.496H8.34l1.605-7.496z"/></svg>',
  // Mastercard: круги радиуса 309 с центрами на расстоянии 381.1 — геометрия
  // из официального файла. Одноцветная версия: оба круга плотные, а границу
  // пересечения показывает обводка цветом подвала (stroke в CSS) — снаружи она
  // сливается с фоном, а внутри рисует ту самую линзу. Прозрачностью этого не
  // сделать: знак получается блёклым рядом с остальными.
  mastercard: '<svg viewBox="0 0 999.2 618" fill="currentColor" aria-hidden="true"><circle cx="309" cy="309" r="309" stroke="none"/><circle cx="690.1" cy="309" r="309" stroke="none"/><circle cx="309" cy="309" r="309" fill="none"/><circle cx="690.1" cy="309" r="309" fill="none"/></svg>',
  // Сегменты знака СБП стыкуются вплотную: в один цвет они слились бы в пятно,
  // поэтому в CSS у них обводка цветом подвала — она возвращает зазоры.
  sbp: '<svg viewBox="0 0 97.28 120" fill="currentColor" aria-hidden="true"><path d="M0 26.12l14.53 25.98v15.84L.02 93.86 0 26.12z" /><path d="M55.8 42.64l13.62-8.35 27.87-.03-41.48 25.41V42.64z" /><path d="M55.72 25.97l.08 34.39-14.57-8.95V0l14.49 25.97z" /><path d="M97.28 34.27l-27.87.03-13.69-8.33L41.23 0l56.05 34.27z" /><path d="M55.8 94.01V77.32l-14.57-8.78.01 51.46 14.56-25.99z" /><path d="M69.38 85.74L14.53 52.09 0 26.12l97.22 59.58-27.84.03z" /><path d="M41.24 120l14.56-25.99 13.58-8.27 27.84-.03L41.24 120z" /><path d="M.02 93.86l41.33-25.32-13.9-8.53-12.92 7.92L.02 93.86z" /></svg>',
  sbpWord: '<svg viewBox="105.27 22.73 101.39 41.91" fill="currentColor" aria-hidden="true"><path d="m 206.66,34.25 v 29.34 h -10.48 v -20.58 h -10.09 v 20.58 h -10.48 v -29.34 h 31.04 z" inkscape:connector-curvature="0" /><path d="m 154.11,64.64 c 9.38,0 16.34,-5.75 16.34,-14.47 0,-8.44 -5.14,-13.91 -13.72,-13.91 -3.96,0 -7.23,1.4 -9.7,3.8 .59,-4.97 4.79,-8.61 9.43,-8.61 1.07,0 9.12,-.02 9.12,-.02 l 4.55,-8.71 c 0,0 -10.1,.23 -14.8,.23 -10.73,.19 -17.98,9.94 -17.98,21.79 0,13.8 7.07,19.89 16.77,19.89 z m .06,-20.67 c 3.48,0 5.9,2.29 5.9,6.2 0,3.52 -2.15,6.42 -5.9,6.43 -3.59,0 -6,-2.69 -6,-6.37 0,-3.91 2.41,-6.26 6,-6.26 z" inkscape:connector-curvature="0" /><path d="m 128.82,53.77 c 0,0 -2.47,1.43 -6.17,1.7 -4.25,.13 -8.03,-2.56 -8.03,-7.32 0,-4.65 3.34,-7.32 7.93,-7.32 2.81,0 6.53,1.95 6.53,1.95 0,0 2.72,-5 4.13,-7.49 -2.58,-1.96 -6.02,-3.03 -10.02,-3.03 -10.1,0 -17.91,6.58 -17.91,15.83 0,9.37 7.35,15.79 17.91,15.6 2.95,-.11 7.03,-1.15 9.51,-2.74 z" inkscape:connector-curvature="0" /></svg>'
};
// Ряд знаков в подвале показывается ТОЛЬКО при включённой оплате на витрине:
// в режиме заявок он обещал бы приём карт, которого нет — покупатель оставляет
// заявку, а платит уже по договорённости с менеджером.
const PAY_METHODS = `<div class="footer-pay" role="list" aria-label="Способы оплаты">
        <span class="pay pay-mir" role="listitem">${PAY_MARKS.mir}<span class="sr-only">Мир</span></span>
        <span class="pay pay-visa" role="listitem">${PAY_MARKS.visa}<span class="sr-only">Visa</span></span>
        <span class="pay pay-mc" role="listitem">${PAY_MARKS.mastercard}<span class="sr-only">Mastercard</span></span>
        <span class="pay pay-sbp" role="listitem">${PAY_MARKS.sbp}${PAY_MARKS.sbpWord}<span class="sr-only">СБП</span></span>
      </div>`;

/* Полоса под шапкой: «заказ ждёт оплаты».
 *
 * Покупатель со страницы оплаты уходит легко — за реквизитами в банковское
 * приложение, за телефоном, просто закрыв вкладку. Товары к этому моменту уже
 * уехали в заказ и из корзины пропали, поэтому сама корзина о нём не напомнит:
 * без этой полосы заказ теряется молча.
 *
 * Данные приходят с сервера (`opts.payRemind`), а не из localStorage: только
 * сервер знает, что счёт ещё живой, и только он отличает свой заказ от чужого —
 * ключ тот же, что у /pay/:id, подписанная cookie-сессия.
 *
 * Обратный отсчёт дописывает `public/app.js` по `data-until`: сервер отдаёт
 * страницу один раз, а срок счёта тикает.
 */
function payRemindBar(settings, remind) {
  if (!remind || !remind.id) return '';
  return `<div class="pay-remind" id="pay-remind" data-until="${esc(String(remind.expiresAt || 0))}"
    data-href="/pay/${esc(remind.id)}" data-sum="${esc(money(remind.total, settings))}" data-no="${esc(orderNo(remind.number))}" role="status">
    <div class="container pay-remind-row">
      <span class="pay-remind-text">Заказ <b class="pay-remind-no">${esc(orderNo(remind.number))}</b> ждёт оплаты — <b>${money(remind.total, settings)}</b><span class="pay-remind-left" id="pay-remind-left" hidden> · <span class="pay-remind-left-long">реквизиты действительны </span>ещё <span id="pay-remind-min"></span></span></span>
      <a class="btn btn-primary btn-sm pay-remind-go" href="/pay/${esc(remind.id)}"><span class="pay-remind-go-full">Продолжить оплату</span><span class="pay-remind-go-short">Оплатить</span></a>
    </div>
  </div>`;
}

function layout(settings, opts) {
  opts = opts || {};
  const accent = cssColor(settings.accentColor);
  // Пределы одной покупки уходят на витрину числами от сервера: свои в app.js
  // разъехались бы с серверными. Оплата на витрине выключена — оба нуля, то
  // есть предела нет вовсе: это ограничение кассы, а не магазина.
  const orderLimits = CROCO.limits(settings);
  const cats = opts.categories || [];
  const navCats = cats.map(c =>
    `<a href="/?category=${encodeURIComponent(c)}" class="nav-cat${opts.activeCategory === c ? ' active' : ''}"${opts.activeCategory === c ? ' aria-current="page"' : ''}>${esc(c)}</a>`
  ).join('');
  return `<!DOCTYPE html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${esc(opts.title ? opts.title + ' — ' + settings.storeName : settings.storeName)}</title>
${seoHead(settings, opts)}
<link rel="icon" href="data:image/svg+xml,%3Csvg%20xmlns='http://www.w3.org/2000/svg'%20viewBox='0%200%2024%2024'%3E%3Cpath%20fill='%231d1d1f'%20d='M17.05%2020.28c-.98.95-2.05.8-3.08.35-1.09-.46-2.09-.48-3.24%200-1.44.62-2.2.44-3.06-.35C2.79%2015.25%203.51%207.59%209.05%207.31c1.35.07%202.29.74%203.08.8%201.18-.24%202.31-.93%203.57-.84%201.51.12%202.65.72%203.4%201.8-3.12%201.87-2.38%205.98.48%207.13-.57%201.5-1.31%202.99-2.53%204.09ZM12.03%207.25c-.15-2.23%201.66-4.07%203.74-4.25.29%202.58-2.34%204.5-3.74%204.25Z'/%3E%3C/svg%3E">
<meta name="theme-color" content="#ffffff">
<meta name="color-scheme" content="light">
<link rel="stylesheet" href="/static/styles.css?v=${assetV('styles.css')}">
<style>:root{--accent:${accent};--secondary:${cssColor(settings.secondaryColor, accent)};--brand-font:${brandFont(settings)}}</style>
</head>
<body class="storefront">
${PH_SPRITE}
<header class="site-header">
  <div class="container header-row">
    <button class="icon-btn menu-toggle" type="button" aria-label="Меню" aria-expanded="false">
      <svg viewBox="0 0 24 24" width="24" height="24"><path d="M3 6h18M3 12h18M3 18h18" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round"/></svg>
    </button>
    <a class="logo" href="/">${logoMarkup(settings)}</a>
    <form class="search" action="/" method="get" role="search">
      <input type="search" name="q" placeholder="Поиск товаров" value="${esc(opts.q || '')}" aria-label="Поиск">
    </form>
    ${tgHeaderBtn(settings)}
    <button class="icon-btn cart-btn" type="button" aria-label="Корзина" aria-expanded="false" onclick="Cart.open()">
      <svg viewBox="0 0 24 24" width="24" height="24"><path d="M6 6h15l-1.5 9h-12z M6 6l-1-3H2 M9 20a1 1 0 100 2 1 1 0 000-2 M18 20a1 1 0 100 2 1 1 0 000-2" stroke="currentColor" stroke-width="1.8" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>
      <span class="cart-badge" id="cart-badge" hidden>0</span>
    </button>
  </div>
  ${cats.length ? `<nav class="site-nav" aria-label="Категории"><div class="container nav-inner"><a href="/" class="nav-cat${!opts.activeCategory ? ' active' : ''}"${!opts.activeCategory ? ' aria-current="page"' : ''}>Все</a>${navCats}</div></nav>` : ''}
</header>
${payRemindBar(settings, opts.payRemind)}

<main>${opts.body || ''}</main>

<footer class="site-footer">
  <div class="container footer-grid">
    <div class="footer-about">
      <div class="foot-brand"><a class="logo" href="/">${logoMarkup(settings)}</a></div>
      <div class="foot-note" style="--fit:${footFit(settings.tagline || '')}">${esc(settings.tagline || '')}</div>
    </div>
    ${(settings.contactTelegram || settings.contactPhone) ? `<div class="footer-contacts">
      ${settings.contactTelegram ? `<div class="foot-tg"><a class="tg-link" href="https://t.me/${esc(tgUser(settings))}" target="_blank" rel="noopener">${tgIcon()}<span>${esc(settings.contactTelegram)}</span></a></div>` : ''}
      ${settings.contactPhone ? `<div class="foot-contact">${esc(settings.contactPhone)}</div>` : ''}
    </div>` : ''}
    <div class="footer-bottom">
      ${CROCO.enabled(settings) ? PAY_METHODS : ''}
      <div class="footer-meta">
        <div class="foot-legal">© 2017–2026 ${esc(settings.storeName)}. Все права защищены.</div>
        ${settings.footerNote ? `<div class="foot-legal">${esc(settings.footerNote)}</div>` : ''}
      </div>
      <nav class="footer-links" aria-label="Правовая информация">
        <a href="/warranty">Гарантия</a>
        <a href="/returns">Возврат и обмен</a>
        <a href="/privacy">Политика конфиденциальности</a>
        <a href="/personal-data-consent">Согласие на обработку данных</a>
      </nav>
    </div>
  </div>
</footer>

<!-- Корзина -->
<div class="cart-overlay" id="cart-overlay" onclick="Cart.close()"></div>
<aside class="cart-drawer" id="cart-drawer" role="dialog" aria-modal="true" aria-label="Корзина" aria-hidden="true">
  <div class="cart-head">
    <h2>Корзина</h2>
    <button class="icon-btn" aria-label="Закрыть" onclick="Cart.close()">
      <svg viewBox="0 0 24 24" width="24" height="24"><path d="M6 6l12 12M18 6L6 18" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>
    </button>
  </div>
  <div class="cart-items" id="cart-items"></div>
  <div class="cart-foot" id="cart-foot"></div>
</aside>

<div class="toast" id="toast" hidden></div>

<script>window.__CURRENCY__=${scriptJson(settings.currency || '₽')};window.__CURPOS__=${scriptJson(settings.currencyPosition || 'after')};window.__ORDER_MIN__=${orderLimits.min};window.__ORDER_MAX__=${orderLimits.max};</script>
<script src="/static/media-lightbox.js?v=${assetV('media-lightbox.js')}" defer></script>
<script src="/static/app.js?v=${assetV('app.js')}" defer></script>
${(opts.scripts || []).map(f => `<script src="/static/${esc(f)}?v=${assetV(f)}" defer></script>`).join('')}
</body>
</html>`;
}

/* --------------------------- Страницы витрины --------------------------- */

// Яблоко в начале заголовка. Контур — фирменный глиф из глобальной навигации
// apple.com, в строке текста стоит на базовой линии, как буква: заливка
// currentColor, цвет и размер берутся у самого заголовка.
// viewBox обрезан по фигуре (bbox 0.514/12.251 … 13.486/28.186) плюс четверть
// единицы полей со всех сторон. Ровно по краю нельзя: внешний svg обрезает
// содержимое по своему viewport, и при дробном размере строки браузер срезал
// у яблока нижний ряд пикселей.
// Тот же глиф, что рисует значок macOS/iOS в панелях, — он лежит в
// lib/client-icons.js, чтобы яблоко в проекте было ровно одно.
const APPLE_MARK = '<svg class="apple-mark" viewBox="0.26 12 13.48 16.44" aria-hidden="true">' + CI.APPLE_PATH + '</svg>';

// Преимущества первого экрана. Холст 35×35 и волосяная обводка — те же, что у
// глифов характеристик в public/spec-icons, поэтому вес штриха на витрине один.
const BENEFIT_GLYPHS = {
  // Ценник с отверстием
  price: '<path d="M5.99 3.94h11.51l11.65 11.64a2.72 2.72 0 0 1 0 3.84L19.42 29.15a2.72 2.72 0 0 1-3.84 0L3.94 17.5V5.99a2.05 2.05 0 0 1 2.05-2.05z"/><circle cx="9.87" cy="9.87" r="1.67"/>',
  // Щит с галочкой — контур повторяет spec-icons/shield.svg
  warranty: '<path d="M17.5 5.85c3.1 2.06 6.57 3.14 9.57 3.33v8.22c0 6.45-4.12 10.92-9.57 12.9-5.45-1.98-9.57-6.45-9.57-12.9v-8.22c3-.19 6.47-1.27 9.57-3.33z"/><path d="M13.34 17.92l3.02 3.02 5.51-5.82" stroke-linecap="round"/>',
  // Фургон доставки
  delivery: '<rect x="3.9" y="8.9" width="15.3" height="13" rx="1.8"/><path d="M19.2 13.4h4.9c.42 0 .82.19 1.09.51l3.1 3.72c.21.25.32.56.32.88v3.39h-9.4z"/><circle cx="9.3" cy="24" r="2.4"/><circle cx="24.5" cy="24" r="2.4"/>',
  // Процент: два кружка и косая черта
  sale: '<circle cx="11.6" cy="11.6" r="3.15"/><circle cx="23.4" cy="23.4" r="3.15"/><path d="M25.1 9.9L9.9 25.1" stroke-linecap="round"/>',
  // Стрелка возврата
  refund: '<path d="M12.1 8.9l-4 4 4 4" stroke-linecap="round"/><path d="M8.1 12.9H20a6.9 6.9 0 0 1 0 13.8h-6.5" stroke-linecap="round"/>',
  // Кружок с галочкой — «проверено, оригинал». Щит рядом занят гарантией, а два
  // щита подряд в одном блоке читались бы как одно и то же обещание дважды.
  verified: '<circle cx="17.5" cy="17.5" r="12.6"/><path d="M11.9 17.8l4 4 7.7-8.1" stroke-linecap="round"/>'
};
// Спрайт на страницу: обе половины бегущей строки ссылаются на один набор глифов
// через <use>, поэтому дубль строки почти ничего не добавляет к разметке.
const BENEFIT_SPRITE = '<svg class="tick-sprite" aria-hidden="true" width="0" height="0" style="position:absolute">'
  + Object.keys(BENEFIT_GLYPHS).map(k => `<symbol id="bi-${k}" viewBox="0 0 35 35" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round">${BENEFIT_GLYPHS[k]}</symbol>`).join('')
  + '</svg>';
// Блок доверия под кнопкой покупки. Глифы те же, что в бегущей строке главной:
// холст 35×35 и волосяная обводка, поэтому вес штриха на всей витрине один.
// Спрайт сюда не тянем — на странице товара каждый глиф встречается ровно раз, а
// <use> окупается только повтором. Жирным идёт то, что отличает предложение
// (100%, 1 год, Оптовая), обычным — что это такое.
const TRUST_ITEMS = [
  ['verified', '100%', 'оригинал'],
  ['warranty', '1 год', 'гарантия'],
  ['price', 'Оптовая', 'цена']
];
const TRUST_BLOCK = `<ul class="trust">${TRUST_ITEMS.map(([g, strong, tail]) => `<li class="trust-item">`
  + `<svg class="trust-ico" viewBox="0 0 35 35" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round" aria-hidden="true">${BENEFIT_GLYPHS[g]}</svg>`
  + `<span class="trust-text"><b>${strong}</b> ${tail}</span></li>`).join('')}</ul>`;
// Тот же блок доводов, но в колонку — для узкой правой панели оформления. Три
// колонки там не встают: панели 360 px на них не хватает, а медиазапрос по ширине
// ОКНА про ширину этой панели ничего не знает. Собирается из TRUST_BLOCK, чтобы
// список доводов остался в одном месте.
const TRUST_BLOCK_COL = TRUST_BLOCK.replace('class="trust"', 'class="trust trust-col"');

const HERO_BENEFITS = [
  ['price', 'Оптовые цены'],
  ['sale', 'Скидки и акции каждый день'],
  ['warranty', '1 год гарантии'],
  ['delivery', 'Быстрая доставка'],
  ['refund', 'Простой возврат']
];
// Одна копия бегущей строки. В ленте их TICKER_COPIES, а едет она ровно на
// ширину одной копии (см. ticker-run в styles.css) и возвращается в начало —
// склейка незаметна. Копий четыре, а не две: лента сдвигается на свою ширину,
// поэтому оставшихся копий должно хватать, чтобы закрыть экран целиком, иначе
// в конце цикла у правого края появлялась бы пустота.
const TICKER_COPIES = 4;
function tickerRow(dup) {
  return `<ul class="ticker-row"${dup ? ' aria-hidden="true"' : ' aria-label="Преимущества магазина"'}>`
    + HERO_BENEFITS.map(([k, text]) =>
      `<li><svg class="tick-ico" viewBox="0 0 35 35" aria-hidden="true"><use href="#bi-${k}"/></svg>${text}</li>`).join('')
    + '</ul>';
}

function homePage(settings, db, opts) {
  opts = opts || {};
  const all = db.visibleProducts();
  const categoryValid = !opts.category || all.some(p => p.category === opts.category);
  let list = all;
  if (opts.category) list = list.filter(p => p.category === opts.category);
  if (opts.q) {
    const q = opts.q.trim().toLowerCase();
    list = list.filter(p => [p.name, p.category, p.shortDesc, p.specs].filter(Boolean).join(' ').toLowerCase().includes(q));
  }
  // Отдельной полосы «Специальные цены» на главной больше нет: она показывала
  // товары с горящей акцией, а такой акции — со своей ценой и таймером — в
  // магазине не осталось. Скидка теперь у товара одна, процентом, и видна прямо
  // в его карточке; дублировать те же карточки полосой выше значило бы дважды
  // показывать один и тот же товар на одном экране.
  const cards = list.map((p, i) => productCard(p, settings, db, { eager: i < 4 })).join('');
  // На главной заголовка у каталога нет: слово «Каталог» ничего не сообщало —
  // товары и так начинаются сразу под первым экраном. У категории и поиска
  // заголовок остаётся: он единственный говорит, что именно отфильтровано.
  const heading = opts.q ? `Результаты: «${esc(opts.q)}»` : esc(opts.category || '');

  const heroText = bindShortWords(settings.tagline || 'Выбирайте нужную модель — мы поможем с остальным.');
  const intro = (!opts.q && !opts.category) ? `
    <section class="store-hero">
      <div class="container store-hero-inner">
        <div class="store-hero-copy">
          <h1 style="--fit:${heroFit(settings, heroText)}">${APPLE_MARK}${esc(heroText)}</h1>
        </div>
      </div>
      ${BENEFIT_SPRITE}
      <div class="hero-ticker">
        <div class="ticker-track">${tickerRow()}${Array.from({ length: TICKER_COPIES - 1 }, () => tickerRow(true)).join('')}</div>
      </div>
    </section>` : '';

  const body = `
    ${intro}
    <section class="container section">
      ${heading ? `<div class="section-head section-head-center"><h2>${heading}</h2></div>` : ''}
      ${list.length ? `<div class="grid">${cards}</div>` : `<p class="empty">Ничего не найдено.</p>`}
    </section>`;
  const origin = opts.origin || '';
  const ld = origin ? jsonLd({
    '@context': 'https://schema.org', '@graph': [
      { '@type': 'WebSite', url: origin, name: settings.storeName, inLanguage: 'ru', potentialAction: { '@type': 'SearchAction', target: origin + '/?q={search_term_string}', 'query-input': 'required name=search_term_string' } },
      { '@type': 'Store', name: settings.storeName, url: origin, description: settings.tagline || undefined }
    ]
  }) : '';
  return layout(settings, {
    body,
    categories: db.visibleCategories(),
    payRemind: opts.payRemind,
    activeCategory: opts.category,
    q: opts.q,
    title: opts.category || (opts.q ? 'Поиск' : ''),
    // Страницы поиска и «не найдено» в индекс не отдаём: своей ценности в выдаче
    // у них нет, а дублей каталога от них много. Категории индексируются как были.
    noindex: !!(opts.noindex || opts.q || (opts.category && !categoryValid)),
    origin,
    canonicalPath: opts.category && categoryValid ? '/?category=' + encodeURIComponent(opts.category) : '/',
    description: settings.tagline, ogType: 'website', jsonLd: ld
  });
}

function notFoundPage(settings, opts) {
  opts = opts || {};
  const body = `<section class="container section not-found">
    <div class="empty"><span class="section-kicker">Ошибка 404</span><h1>Страница не найдена</h1>
    <p>Возможно, адрес изменился или в ссылке есть опечатка.</p>
    <a class="btn btn-primary" href="/">Вернуться в каталог</a></div>
  </section>`;
  return layout(settings, {
    body, categories: opts.categories || [], payRemind: opts.payRemind, title: 'Страница не найдена',
    origin: opts.origin || '', noindex: true, noCanonical: true,
    description: 'Запрошенная страница не найдена'
  });
}

function productPage(settings, db, p, opts) {
  opts = opts || {};
  const published = db.reviewsForProduct(p.id, true);
  // opts.ownReviews — отзывы самого посетителя, ещё не одобренные. Для него они
  // стоят в общем списке и считаются в оценке; другим они не отдаются вовсе.
  const own = (opts.ownReviews || []).filter(Boolean);
  const reviews = own.length
    ? own.concat(published).sort((a, b) => Number(b.createdAt || 0) - Number(a.createdAt || 0))
    : published;
  const r = own.length
    ? { count: reviews.length, avg: Math.round(reviews.reduce((a, rv) => a + Number(rv.rating || 0), 0) / reviews.length * 10) / 10 }
    : db.ratingFor(p.id);
  // Что выбрано по умолчанию: первый доступный корпус и подходящий ему ремешок.
  const defColorIdx = (p.colors && p.colors.length) ? firstAvailableColor(p) : -1;
  const defColor = defColorIdx > -1 ? p.colors[defColorIdx].name : '';
  const defBand = defaultBand(p.bands, defColor);
  // Стартовая сборка: конфигурация и значения групп считаются вместе, потому что
  // у Mac они зависят друг от друга (объём памяти определяет чип).
  const defChoice = defaultChoices(p);
  const defBandKey = defBand ? `${p.bands[defBand.gi].name}|${((p.bands[defBand.gi].options || [])[defBand.oi] || {}).name || ''}` : '';
  const imgColorOf = s => (p.imageColors && s && p.imageColors[s]) || '';
  const imgBandOf = s => (p.imageBands && s && p.imageBands[s]) || '';
  // Первый кадр — тот же, что покажет галерея после фильтра: снимок выбранной пары
  // «ремешок + корпус». Иначе страница на миг открывалась с чужого варианта.
  const startIdx = (() => {
    const imgs = p.images || [];
    const tiers = [
      s => defBandKey && imgBandOf(s) === defBandKey && imgColorOf(s) === defColor,
      s => defBandKey && imgBandOf(s) === defBandKey && !imgColorOf(s),
      s => defColor && imgColorOf(s) === defColor && !imgBandOf(s),
      s => !imgColorOf(s) && !imgBandOf(s)
    ];
    for (const t of tiers) { const i = imgs.findIndex(t); if (i > -1) return i; }
    return 0;
  })();
  const mainImg = imageMarkup(p, startIdx, { eager: true });
  // Данные слайдов для JS-галереи (стрелки + точки, как на apple.com)
  const slidesData = (p.images && p.images.length)
    ? esc(JSON.stringify(p.images.map(s => ({ src: '/uploads/' + s, color: imgColorOf(s), band: imgBandOf(s) }))))
    : '';
  const chevL = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 5l-7 7 7 7"/></svg>`;
  const chevR = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 5l7 7-7 7"/></svg>`;
  const galleryNav = (p.images && p.images.length > 1) ? `
        <button type="button" class="g-arrow g-prev" id="g-prev" aria-label="Предыдущее фото">${chevL}</button>
        <button type="button" class="g-arrow g-next" id="g-next" aria-label="Следующее фото">${chevR}</button>` : '';
  // Базовая цена нужна скрипту: он считает сумму как «база + доплаты выбранного»
  // (`applyVariant()` в public/app.js), поэтому в `data-base-price` уезжает
  // именно она, а не цена стартовой сборки.
  const eff = D.effectivePrice(p);
  // А ПОКАЗЫВАЕМ мы цену стартовой сборки — той, что уже отмечена на странице.
  // Дешёвая конфигурация бывает распродана, и страница открывается с более
  // дорогой: с базовой ценой в разметке первый кадр показывал сумму, которую
  // скрипт тут же исправлял, — цена дёргалась на глазах. То же число стоит и в
  // карточке каталога (см. `productCard`).
  const startSum = startPrice(p);
  const pct = D.discountPct(p);
  const cmp = D.compareFor(startSum, pct);
  // id нужны скрипту: при выборе памяти и доп. характеристик зачёркнутая цена
  // пересчитывается вместе с основной (`applyVariant()` в public/app.js).
  // Процент при этом НЕ меняется — он и есть скидка товара, — а меняется
  // зачёркнутая сумма: она выводится из цены сборки.
  const discount = cmp
    ? `<span class="old-price" id="product-old-price">${money(cmp, settings)}</span><span class="save" id="product-save">−${pct}%</span>` : '';
  // От цены стартовой сборки (`startSum` выше) считается, какие значения выводят
  // покупку за потолок одной покупки. Ровно ту же подстановку («убрать доплату
  // текущего значения, прибавить доплату кандидата») делает потом `markLimits()`
  // в public/app.js при каждой смене выбора; сервер рисует первый кадр, чтобы
  // кнопки не гасли на глазах после загрузки скрипта.
  const startGroup = defBand ? ((p.bands || [])[defBand.gi] || {}) : {};
  const startAdd = {
    storage: Number(((p.storages || [])[defChoice.storageIdx] || {}).add) || 0,
    option: g => Number((((g.values || [])[defaultOption(g, defChoice.storage, defChoice.picked)]) || {}).add) || 0,
    band: Number((((startGroup.options || [])[defBand ? defBand.oi : 0]) || {}).add) || 0,
    size: Number(((startGroup.sizes || [])[0] || {}).add) || 0
  };
  // Потолок кассы берётся один раз на страницу: он зависит от настроек, а не
  // от товара (см. `orderMax()`).
  const orderCap = orderMax(settings);
  const canBuy = sellable(p, settings);
  const overLimit = candidate => !fitsOrderLimit(candidate, orderCap);

  // Разбивка по звёздам. Средних по признакам (доставка, сервис, цена) здесь
  // больше нет: у отзыва одна общая оценка, и сводка описывает только её.
  const dist = [0, 0, 0, 0, 0];
  reviews.forEach(rv => {
    const st = Math.round(rv.rating); if (st >= 1 && st <= 5) dist[st - 1]++;
  });

  // Свои неодобренные отзывы закреплены сверху и в постраничную выдачу не входят:
  // иначе при сортировке «сначала полезные» автор искал бы свой отзыв на пятой странице.
  const slice = reviewsSlice(published, opts.reviewSort, opts.reviewPage);
  const ownItems = own.map(reviewCard).join('');
  const reviewItems = slice.total ? slice.html : `<p class="muted">Отзывов пока нет. Оставьте первый!</p>`;
  const reviewsBase = '/product/' + encodeURIComponent(p.id);
  // Ссылки настоящие: без JS это обычная постраничная навигация, с JS витрина
  // подменяет список и листалку, не перезагружая страницу товара целиком.
  const pager = slice.pages > 1 ? `
      <div class="reviews-pager" id="reviews-pager" data-product="${esc(p.id)}" data-href="${reviewsBase}" data-sort="${slice.sort}" data-page="${slice.page}" data-pages="${slice.pages}" data-total="${slice.total}">${reviewsPager(slice, reviewsBase)}</div>` : '';

  const breakdown = r.count ? `
    <div class="rating-overview">
      <div class="rating-big"><div class="rating-num">${r.avg}</div>${stars(r.avg)}<div class="muted small">${reviewCountText(r.count)}</div></div>
      <div class="rating-bars">
        ${[5, 4, 3, 2, 1].map(s => { const c = dist[s - 1]; const pct = r.count ? Math.round(c / r.count * 100) : 0; return `<div class="rbar"><span class="rbar-star">${s}★</span><div class="rbar-track"><div class="rbar-fill" style="width:${pct}%"></div></div><span class="muted small rbar-num">${c}</span></div>`; }).join('')}
      </div>
    </div>` : '';

  const ratingSummary = r.count
    ? `<a href="#reviews" class="rating-summary">${RT_STAR}<b>${r.avg}</b>${RT_BUBBLE}<span class="rating-count">${reviewsCountLong(r.count)}</span></a>`
    : `<a href="#reviews" class="rating-summary muted">Нет отзывов</a>`;

  const body = `
  <div class="container">
    <nav class="breadcrumb"><a href="/">Главная</a> / <a href="/?category=${encodeURIComponent(p.category)}">${esc(p.category)}</a> / <span>${esc(p.name)}</span></nav>
    <div class="product">
      <div class="product-gallery">
        <div class="gallery" id="gallery"${slidesData ? ` data-imgs="${slidesData}"` : ''}>
          <div class="gallery-main" id="gallery-main">${mainImg}</div>
          ${galleryNav}
        </div>
        <div class="g-dots" id="g-dots"></div>
      </div>
      <div class="product-info">
        <h1 class="product-name">${esc(p.name)}</h1>
        ${ratingSummary}
        <div class="product-price${cmp ? ' price-sale' : ''}"><span class="price-now" id="product-price">${money(startSum, settings)}</span> ${discount}</div>
        ${p.shortDesc ? `<p class="product-short">${esc(p.shortDesc)}</p>` : ''}
        ${(p.colors && p.colors.length) ? (() => {
          const sel = defColorIdx;
          return `
        <div class="variant-group">
          <div class="variant-label">Цвет: <b id="sel-color">${esc(p.colors[sel].name)}</b></div>
          <div class="swatches" id="colors">
            ${p.colors.map((c, i) => { const ok = colorAvailable(p, c); return `<button type="button" class="swatch${i === sel ? ' active' : ''}${ok ? '' : ' out'}" data-color="${esc(c.name)}" aria-label="Цвет: ${esc(c.name)}${ok ? '' : ' — нет в наличии'}" aria-pressed="${i === sel ? 'true' : 'false'}" title="${esc(c.name)}${ok ? '' : ' — нет в наличии'}" style="--sw:${cssColor(c.hex, '#cccccc')}"${ok ? '' : ' disabled'}></button>`; }).join('')}
          </div>
        </div>`; })() : ''}
        ${(p.storages && p.storages.length) ? (() => {
          const sel = defChoice.storageIdx;
          return `
        <div class="variant-group">
          <div class="variant-label">${variantLabel(p)}</div>
          <div class="storage-opts" id="storages">
            ${p.storages.map((s, i) => {
              // Конфигурация недоступна, если её распродали ИЛИ она выводит
              // сборку за потолок одной покупки: покупателю это одно и то же.
              const ok = variantInStock(s) && !overLimit(startSum - startAdd.storage + (Number(s.add) || 0));
              const fit = V.optionFits(s, '', defChoice.picked);
              return `<button type="button" class="storage-opt${i === sel ? ' active' : ''}${ok ? '' : ' out'}" data-add="${Number(s.add) || 0}" data-label="${esc(s.label)}" data-for-choice="${esc(JSON.stringify(s.forChoice || null))}" aria-pressed="${i === sel ? 'true' : 'false'}"${ok ? '' : ' disabled title="Нет в наличии"'}${fit ? '' : ' hidden'}>${esc(s.label)}${ok ? '' : '<span class="opt-note">нет в наличии</span>'}</button>`;
            }).join('')}
          </div>
        </div>`; })() : ''}
        ${(p.options && p.options.length) ? (() => {
          // Значения, доступные не со всеми конфигурациями, прячем уже на сервере
          // тем же правилом, что применит JS при смене памяти: иначе на 256 ГБ
          // мелькало бы нанотекстурное стекло, которого с ней не бывает.
          const storage = defChoice.storage;
          return `
        <div class="variant-group option-groups" id="options">
          ${p.options.map(g => {
            const sel = defaultOption(g, storage, defChoice.picked);
            return `<div class="option-group" data-group="${esc(g.name)}">
            <div class="variant-label">${esc(g.name)}</div>
            ${g.hint ? `<p class="variant-hint">${esc(g.hint)}</p>` : ''}
            <div class="option-opts">
              ${(g.values || []).map((v, i) => {
                const add = Number(v.add) || 0;
                const ok = variantInStock(v) && !overLimit(startSum - startAdd.option(g) + add);
                return `<button type="button" class="option-opt${i === sel ? ' active' : ''}${ok ? '' : ' out'}" data-label="${esc(v.label)}" data-add="${add}" data-for-storage="${esc((v.forStorage || []).join('|'))}" data-for-choice="${esc(JSON.stringify(v.forChoice || null))}" aria-pressed="${i === sel ? 'true' : 'false'}"${ok ? '' : ' disabled title="Нет в наличии"'}${V.optionFits(v, storage, defChoice.picked) ? '' : ' hidden'}><span class="opt-name">${esc(v.label)}</span><span class="opt-add">${add > 0 ? '+ ' + money(add, settings) : 'без доплаты'}</span>${ok ? '' : '<span class="opt-note">нет в наличии</span>'}</button>`;
              }).join('')}
            </div>
          </div>`;
          }).join('')}
        </div>`; })() : ''}
        ${(p.bands && p.bands.length) ? (() => {
          const gi = defBand.gi;
          const group = p.bands[gi];
          const oi = defBand.oi;
          // Вариации не для выбранного корпуса прячем уже на сервере — тем же
          // правилом, что применяет JS при смене цвета. Иначе при загрузке
          // мелькали ремешки, которых с этим корпусом не бывает.
          const fits = o => bandFits(o, defColor);
          const groupFits = g => (g.options || []).some(o => fits(o) && variantInStock(o));
          const tabs = p.bands.length > 1 ? `<div class="band-tabs" id="band-tabs" role="tablist">
            ${p.bands.map((g, i) => `<button type="button" class="band-tab${i === gi ? ' active' : ''}" data-group="${i}" role="tab" aria-selected="${i === gi ? 'true' : 'false'}"${groupFits(g) ? '' : ' hidden'}>${esc(g.name)}</button>`).join('')}
          </div>` : '';
          // Цвета и размеры готовим для всех коллекций сразу, показываем выбранную —
          // так переключение мгновенное и работает без ожидания запроса.
          const colorRows = p.bands.map((g, i) => `<div class="band-colors" data-group="${i}"${i === gi ? '' : ' hidden'}>
            ${(g.options || []).map((o, j) => { const ok = variantInStock(o) && !overLimit(startSum - startAdd.band + (Number(o.add) || 0)); const selected = i === gi && j === oi; return `<button type="button" class="swatch${selected ? ' active' : ''}${ok ? '' : ' out'}" data-band="${esc(g.name)}" data-option="${esc(o.name)}" data-add="${Number(o.add) || 0}" data-for-color="${esc(o.forColor || '')}" title="${esc(o.name)}${ok ? '' : ' — нет в наличии'}" aria-label="Ремешок ${esc(g.name)}: ${esc(o.name)}" aria-pressed="${selected ? 'true' : 'false'}" style="--sw:${cssColor(o.hex, '#cccccc')}"${ok ? '' : ' disabled'}${fits(o) ? '' : ' hidden'}></button>`; }).join('')}
          </div>`).join('');
          const sizeRows = p.bands.map((g, i) => (g.sizes || []).length ? `<div class="band-sizes" data-group="${i}"${i === gi ? '' : ' hidden'}>
            ${g.sizes.map((s, j) => { const ok = !overLimit(startSum - startAdd.size + (Number(s.add) || 0)); return `<button type="button" class="storage-opt${i === gi && j === 0 ? ' active' : ''}${ok ? '' : ' out'}" data-size="${esc(s.label)}" data-add="${Number(s.add) || 0}" aria-pressed="${i === gi && j === 0 ? 'true' : 'false'}"${ok ? '' : ' disabled title="Нет в наличии"'}>${esc(s.label)}${ok ? '' : '<span class="opt-note">нет в наличии</span>'}</button>`; }).join('')}
          </div>` : '').join('');
          return `
        <div class="variant-group band-group" id="bands">
          <div class="variant-label">Ремешок: <b id="sel-band">${esc(group.name)} · ${esc((group.options[oi] || {}).name || '')}</b></div>
          ${tabs}
          <div class="band-color-rows" id="band-color-rows">${colorRows}</div>
          ${sizeRows ? `<div class="variant-sub">Размер ремешка</div><div class="band-size-rows" id="band-size-rows">${sizeRows}</div>` : ''}
        </div>`; })() : ''}
        <div class="buy-row">
          <div class="qty" data-qty>
            <button type="button" class="qty-btn" data-delta="-1" aria-label="Меньше">−</button>
            <input type="text" value="1" inputmode="numeric" class="qty-input" aria-label="Количество" readonly>
            <button type="button" class="qty-btn" data-delta="1" aria-label="Больше">+</button>
          </div>
          <button class="btn btn-primary btn-lg add-to-cart" data-id="${esc(p.id)}"
            data-base-name="${esc(p.name)}" data-name="${esc(p.name)}"
            data-img="${esc((p.images || [])[0] || '')}"
            data-base-price="${eff}" data-price="${eff}" data-discount-pct="${pct}"
            data-start-price="${startSum}"
            data-qty-source ${canBuy ? '' : 'disabled'}>
            ${canBuy ? 'Добавить в корзину' : 'Нет в наличии'}
          </button>
        </div>
        ${stockNote(p, settings)}
        ${TRUST_BLOCK}
      </div>
    </div>

    ${p.description ? `<section class="section"><h2>Описание</h2><div class="prose">${esc(p.description).replace(/\n/g, '<br>')}</div></section>` : ''}
    ${specHighlights(p)}

    <section class="section" id="reviews">
      ${DLOGO.sprite()}
      <div class="section-head"><h2>Отзывы ${r.count ? `(${r.count})` : ''}</h2></div>
      ${breakdown}
      ${r.count ? `<div class="reviews-toolbar"><span class="sort-label muted small">Сортировка:</span>${
        REVIEW_SORTS.map(([mode, label]) =>
          `<a class="sort-btn${slice.sort === mode ? ' active' : ''}" href="${reviewsBase}?rsort=${mode}#reviews" data-sort="${mode}"${slice.sort === mode ? ' aria-current="true"' : ''}>${label}</a>`
        ).join('')}</div>` : ''}
      ${ownItems ? `<div class="reviews-list reviews-own">${ownItems}</div>` : ''}
      <div class="reviews-list" id="reviews-list" data-product="${esc(p.id)}" data-href="${reviewsBase}">${reviewItems}</div>
      ${pager}

      <div class="review-form-wrap">
        <h3>Оставить отзыв</h3>
        <form id="review-form" class="rf-grid" enctype="multipart/form-data">
          <input type="hidden" name="productId" value="${esc(p.id)}">
          <div class="field rf-rate">
            <label>Оценка</label>
            <div class="rate-input" id="rate-input" data-value="5" role="radiogroup" aria-label="Общая оценка">
              ${[1,2,3,4,5].map(i => `<button type="button" class="rate-star" data-v="${i}" data-note="${esc(RATE_NOTES[i - 1])}" role="radio" aria-label="${i} из 5" aria-checked="${i === 5 ? 'true' : 'false'}">★</button>`).join('')}
            </div>
            <span class="rate-note" id="rate-note">${esc(RATE_NOTES[4])}</span>
            <input type="hidden" name="rating" id="rating-value" value="5">
          </div>
          <div class="field rf-name">
            <label for="rv-author">Имя</label>
            <input type="text" id="rv-author" name="author" maxlength="60" placeholder="Как вас представить" required>
          </div>
          <div class="field rf-text">
            <label for="rv-text">Отзыв</label>
            <textarea id="rv-text" name="text" rows="4" maxlength="2000" placeholder="Поделитесь впечатлением о товаре"></textarea>
          </div>
          ${REVIEW_PHOTOS ? `<div class="field rf-photos">
            <label for="rv-photos">Фото</label>
            <input class="rf-file-input" type="file" id="rv-photos" name="photos" accept="image/*" multiple data-max="${REVIEW_PHOTOS_MAX}">
            <div class="rf-file-row">
              <label class="rf-file" for="rv-photos">${RF_PHOTO_ICO}Выбрать снимки</label>
              <span class="rf-file-note" id="rv-photos-note" aria-live="polite"></span>
            </div>
          </div>` : ''}
          <div class="rf-foot">
            <label class="rf-agree">
              <input type="checkbox" id="rv-consent" name="privacyAccepted" value="1" required>
              <span>Даю согласие на <a href="/personal-data-consent" target="_blank" rel="noopener">обработку данных</a> и <a href="/personal-data-publication-consent" target="_blank" rel="noopener">публикацию отзыва</a></span>
            </label>
            <button type="submit" class="btn btn-primary">Отправить отзыв</button>
          </div>
          <p class="form-msg" id="review-msg" hidden></p>
        </form>
      </div>
    </section>
  </div>`;

  const origin = opts.origin || '';
  const imgAbs = (p.images || []).map(f => origin + '/uploads/' + f);
  const shortD = (p.shortDesc || String(p.description || '').replace(/\s+/g, ' ').trim().slice(0, 200) || p.name);
  const ld = origin ? jsonLd({
    '@context': 'https://schema.org', '@type': 'Product',
    name: p.name, sku: p.id, category: p.category, description: shortD,
    image: imgAbs.length ? imgAbs : undefined,
    offers: {
      // Цена стартовой сборки, а не базовая: поисковику обещаем ровно ту сумму,
      // которую покупатель увидит, открыв страницу.
      '@type': 'Offer', price: startSum, priceCurrency: currencyCode(settings.currency),
      // sellable(), а не p.inStock: если распроданы все цвета или все конфигурации,
      // кнопка на витрине уже неактивна — поисковику незачем обещать наличие.
      availability: 'https://schema.org/' + (canBuy ? 'InStock' : 'OutOfStock'), url: origin + '/product/' + p.id
    },
    aggregateRating: r.count ? { '@type': 'AggregateRating', ratingValue: r.avg, reviewCount: r.count } : undefined
  }) : '';
  return layout(settings, {
    body,
    categories: db.visibleCategories(),
    payRemind: opts.payRemind,
    title: p.name,
    origin, canonicalPath: '/product/' + p.id, description: shortD, ogType: 'product',
    ogImage: (p.images && p.images[0]) ? '/uploads/' + p.images[0] : '', jsonLd: ld
  });
}

function operatorDetails(settings) {
  const operator = String(settings.legalOperator || settings.storeName || 'Владелец сайта').trim();
  const registration = String(settings.legalDetails || '').trim();
  const address = String(settings.legalAddress || '').trim();
  const email = String(settings.privacyEmail || '').trim();
  const telegram = String(settings.contactTelegram || '').trim();
  const phone = String(settings.contactPhone || '').trim();
  const contact = email
    ? `<a href="mailto:${esc(email)}">${esc(email)}</a>`
    : (phone ? esc(phone) : (telegram ? esc(telegram) : 'через контакты, указанные на сайте'));
  return { operator, registration, address, email, contact };
}

// `role` и `contactLabel` — подписи первой и последней строк. На страницах
// гарантии и возврата тот же блок описывает продавца, а не оператора
// персональных данных: «Обращения по персональным данным» рядом с порядком
// возврата денег читалось бы как чужая строка из другого документа.
function operatorCard(settings, role, contactLabel) {
  const info = operatorDetails(settings);
  return `<dl class="legal-details">
    <div><dt>${esc(role || 'Оператор')}</dt><dd>${esc(info.operator)}</dd></div>
    ${info.registration ? `<div><dt>Реквизиты</dt><dd>${esc(info.registration)}</dd></div>` : ''}
    ${info.address ? `<div><dt>Адрес</dt><dd>${esc(info.address)}</dd></div>` : ''}
    <div><dt>${esc(contactLabel || 'Обращения по персональным данным')}</dt><dd>${info.contact}</dd></div>
  </dl>`;
}

// Отдельный шаг оформления: список позиций и форма живут на своей странице,
// а не поверх корзины — иначе на телефоне список приходится проматывать сквозь форму.
function checkoutPage(settings, opts) {
  opts = opts || {};
  // Включена ли онлайн-оплата — единственное, что витрина знает о платёжке.
  // Ключи кассы остаются на сервере, как и ключ подсказок адреса.
  const pay = opts.payOnline ? ' data-pay="1"' : '';
  // Способы доставки отдаём списком, а не дублируем в app.js: разъехавшийся
  // список означал бы выбор, который сервер потом не принимает. `logoBox` —
  // viewBox логотипа перевозчика; пустой значит «логотипа нет», и витрина
  // рисует название текстом, как раньше. Вместе со способом едут и его варианты
  // (пункт выдачи / курьер) — по тому же правилу: витрина не придумывает выбор,
  // которого сервер не знает. Цен здесь нет вовсе: их считает `/api/delivery/quote`
  // тем же модулем, что и заказ, — сетка тарифов наружу не выходит.
  const methods = DELIVERY.METHODS.map(m => Object.assign({}, m, { logoBox: DLOGO.viewBox(m.id) }));
  const delivery = ` data-delivery="${esc(JSON.stringify(methods))}"`;
  const body = `<div class="container checkout-page" id="checkout-page"${pay}${delivery}>
    ${DLOGO.sprite()}
    <header class="checkout-head">
      <h1 class="checkout-title">Оформление заказа</h1>
      <p class="checkout-sub">${opts.payOnline
        ? 'Укажите получателя и доставку — на следующем шаге откроется оплата'
        : 'Оформите заказ — менеджер свяжется с вами и подтвердит наличие'}</p>
    </header>
    ${opts.notice ? `<p class="form-msg ok checkout-return-note" role="status">${esc(opts.notice)}</p>` : ''}
    <div class="checkout-grid">
      <section id="checkout-items" aria-label="Товары в заказе"></section>
      <section id="checkout-form" aria-label="Получатель и доставка"></section>
      <aside class="checkout-rail" aria-label="Сумма заказа">
        <div class="co-summary">
          <div id="checkout-side"></div>
          ${TRUST_BLOCK_COL}
        </div>
      </aside>
    </div>
  </div>`;
  return layout(settings, {
    body, categories: opts.categories || [], payRemind: opts.payRemind, title: 'Оформление заказа',
    origin: opts.origin || '', canonicalPath: '/checkout', noindex: true,
    // Форматирование телефона нужно ровно здесь, поэтому файл и подключается
    // только на этой странице: на остальных он был бы лишним запросом.
    scripts: ['phone.js'],
    description: `Оформление заказа в ${settings.storeName}`
  });
}

// Куда возвращается плательщик с формы CrocoPAY. Страница нарочно не утверждает,
// что деньги получены: подтверждает оплату только вебхук, а сюда покупатель
// попадает и просто закрыв форму. Обещать «оплачено» раньше вебхука — значит
// однажды пообещать это тому, кто не заплатил.
/* ============================ Страница оплаты (H2H) ============================
 * Своя страница, а не редирект на форму платёжки: в схеме H2H счёт создаём мы и
 * реквизиты получателя показываем сами. Ради этого всё и затевалось — здесь
 * видно НАСТОЯЩЕЕ состояние счёта, а не «ждём вебхук, которого может не быть».
 *
 * Страница целиком рендерится сервером под текущее состояние платежа, а
 * public/pay.js только считает время до истечения счёта, копирует реквизиты и
 * опрашивает статус. Любая смена состояния — перезагрузка страницы: так
 * разметку состояния не приходится держать в двух местах.
 */

// Строка реквизита с кнопкой «скопировать». Копирование — главное действие на
// этой странице: номер карты покупатель переносит в банковское приложение.
function payRow(label, value, copyable) {
  if (!value) return '';
  return `<div class="pay-row">
    <span class="pay-row-label">${esc(label)}</span>
    <span class="pay-row-value">${esc(value)}</span>
    ${copyable ? `<button type="button" class="pay-copy" data-copy="${esc(value)}" aria-label="Скопировать: ${esc(label)}">Копировать</button>` : ''}
  </div>`;
}

// Знак способа оплаты. У СБП — настоящий логотип, тот же, что в подвале: это
// узнаваемый бренд, и покупатель находит свой способ по нему быстрее, чем по
// названию.
//
// Остальные знаки нарисованы ЗАЛИВКОЙ, а не волосяным контуром, как глифы
// характеристик и блока доверия. Рядом с плотным логотипом СБП тонкий контур
// выглядел бледной мелочью — знаки в одном ряду обязаны быть одного веса.
// Вырезы (магнитная полоса, чип, экран) сделаны через `fill-rule="evenodd"`:
// сквозные дырки не зависят от фона карточки, а белая заливка поверх зависела
// бы — у выбранной карточки фон другой.
const PAY_GLYPHS = {
  // Банковская карта: полоса и чип — сквозные вырезы
  card: { box: '0 0 48 32', d: 'M4.6 3h38.8A4.6 4.6 0 0 1 48 7.6v16.8a4.6 4.6 0 0 1-4.6 4.6H4.6A4.6 4.6 0 0 1 0 24.4V7.6A4.6 4.6 0 0 1 4.6 3zM0 9.6h48v5H0zM5.8 18.8h8.6v4.4H5.8z' },
  // QR: три «глаза» с вырезами и точки данных
  qr: { box: '0 0 32 32', d: 'M2 2h11.4v11.4H2zM5.2 5.2h5v5h-5zM18.6 2H30v11.4H18.6zM21.8 5.2h5v5h-5zM2 18.6h11.4V30H2zM5.2 21.8h5v5h-5zM18.6 18.6h5v5h-5zM26 18.6h4v4h-4zM18.6 26h4v4h-4zM26 26h4v4h-4z' },
  // Телефон: перевод по номеру у способов не из семейства СБП
  phone: { box: '0 0 24 34', d: 'M4 0h16a4 4 0 0 1 4 4v26a4 4 0 0 1-4 4H4a4 4 0 0 1-4-4V4a4 4 0 0 1 4-4zM2.6 6.4h18.8v21.2H2.6zM9.2 2.4h5.6V4H9.2z' }
};
function payMark(mark) {
  if (mark === 'sbp') return `<span class="pay-opt-sbp">${PAY_MARKS.sbp}${PAY_MARKS.sbpWord}</span>`;
  const glyph = PAY_GLYPHS[mark] || PAY_GLYPHS.card;
  return `<svg class="pay-opt-glyph" viewBox="${glyph.box}" fill="currentColor" fill-rule="evenodd" aria-hidden="true"><path d="${glyph.d}"/></svg>`;
}

function payMethodChoice(methods, current) {
  if (!methods.length) return '';
  // Прежний способ отмечаем, только если он в списке есть: после смены валюты
  // список другой, и «выбран» оказывался бы никто — покупатель жал кнопку и
  // получал «выберите способ оплаты» на пустом месте.
  const keep = methods.some(m => m.id === current) ? current : '';
  return `<div class="co-choice pay-choices" role="radiogroup" aria-label="Способ оплаты">${methods.map((m, i) => {
    const on = keep ? m.id === keep : i === 0;
    return `<label class="co-choice-opt pay-opt"><input type="radio" name="pay-method" value="${esc(m.id)}"${on ? ' checked' : ''}>
      <span class="pay-opt-mark" aria-hidden="true">${payMark(m.mark)}</span>
      <span class="co-choice-text"><b>${esc(m.name)}</b>${m.hint ? `<i>${esc(m.hint)}</i>` : ''}</span>
      <span class="pay-opt-tick" aria-hidden="true"></span></label>`;
  }).join('')}</div>`;
}

/* Выбор валюты счёта. Показывается, только когда валют правда несколько: у
 * кассы включена не одна, у каждой задан курс, а в настройках разрешён выбор.
 *
 * Это ссылки, а не радио со скриптом: от валюты зависит и список способов, и
 * сумма перевода, а всю разметку состояния на этой странице рисует сервер —
 * любая смена состояния здесь перезагрузка страницы (см. public/pay.js).
 */
function payCurrencyChoice(order, codes, current, amounts, settings) {
  if (!Array.isArray(codes) || codes.length < 2) return '';
  const href = code => `/pay/${encodeURIComponent(order.id)}?currency=${encodeURIComponent(code)}`;
  return `<div class="pay-cur" role="group" aria-label="Валюта оплаты">
    <span class="pay-cur-label">Валюта перевода</span>
    <div class="pay-cur-row">${codes.map(code => {
    const sum = amounts && amounts[code];
    const text = code === PAY.BASE ? money(sum, settings) : PAY.formatAmount(sum, code);
    return `<a class="pay-cur-opt${code === current ? ' active' : ''}" href="${href(code)}"${code === current ? ' aria-current="true"' : ''}>
        <b>${esc(code)}</b><i>${esc(text)}</i></a>`;
  }).join('')}</div></div>`;
}

function payPage(settings, order, opts) {
  opts = opts || {};
  const pay = payDisplay((order && order.payment) || null);
  const state = (pay && pay.status) || '';
  const methods = Array.isArray(opts.methods) ? opts.methods : [];
  // Способ мог оказаться незнакомым: у кассы включили новый код, и владелец
  // отметил его в настройках. Подпись тогда — сам код, а вид реквизита не
  // угадывается (см. PAY.describe).
  const method = pay && pay.method ? PAY.describe(pay.method) : null;
  // Счёт показываем, только пока его ещё можно оплатить: у истёкшего реквизиты
  // уже чужие, и подставлять их покупателю нельзя. Пока таймер идёт, способ не
  // меняется: у кассы нет отмены invoice, а второй оставил бы два одновременно
  // оплачиваемых набора реквизитов.
  // Условие общее с панелью и с полосой напоминания (`payLive` выше): «ждём
  // перевод» обязано значить одно и то же во всех трёх местах.
  const live = payLive(pay);
  const liveUntil = live ? payUntil(pay) : 0;
  // Сумма заказа — всегда рублёвая: цены в каталоге в рублях, и в шапке стоит
  // именно она. Сумма ПЕРЕВОДА может быть в другой валюте (см. payContext в
  // server.js), и у выставленного счёта берётся из него самого: он выпущен в
  // той валюте, которую выбрали тогда, а не в той, что выбрана сейчас.
  const total = money(order.total, settings);
  const currencies = Array.isArray(opts.currencies) ? opts.currencies : [PAY.BASE];
  const currency = PAY.currencyCode(opts.currency) || PAY.BASE;
  // После Success/mismatch счёт уже не `live`, но его сумма и валюта остаются
  // историческим фактом. Не подменяем их текущим курсом/выбором страницы: иначе
  // оплаченные 756,91 USD могли превратиться в тексте в 68 500 RUB.
  const storedInvoice = !!(pay && pay.invoiceId && Number(pay.amount) > 0
    && PAY.currencyCode(pay.currency));
  const useStoredInvoice = live || (storedInvoice && (state === 'paid' || state === 'mismatch'));
  const payAmount = useStoredInvoice ? Number(pay.amount) : Number(opts.amount || order.total);
  const payCur = useStoredInvoice ? PAY.currencyCode(pay.currency) : currency;
  // Сервер уже вычисляет право атомарным DB-предикатом, но разметка тоже
  // fail-closed: ошибочно переданный флаг не рисует отмену поверх payment.
  const canDiscardDraft = !!opts.canDiscardDraft && order.status === 'new'
    && order.draft === true && order.payment === null;
  const orderArchived = !!opts.orderArchived;
  // В рублях сумма набирается так же, как везде на витрине (значок и его
  // положение — настройка магазина); в чужой валюте — своим форматом.
  const payTotal = payCur === PAY.BASE ? money(payAmount, settings) : PAY.formatAmount(payAmount, payCur);

  let card;
  if (state === 'paid') {
    card = `<section class="order-success" role="status" aria-live="polite">
      <div class="order-success-check" aria-hidden="true">✓</div>
      <p class="order-success-eyebrow">Оплачено</p>
      <h3>Платёж получен</h3>
      <p class="order-success-copy">Касса подтвердила перевод на ${esc(payTotal)}. Менеджер свяжется с вами и подтвердит отправку.</p>
      <div class="order-success-number"><span>Заказ</span><strong>${esc(orderNo(order.number))}</strong></div>
      <a class="btn btn-primary btn-lg" href="/">Продолжить покупки</a>
    </section>`;
  } else if (state === 'mismatch') {
    card = `<section class="order-success order-success-neutral" role="status">
      <div class="order-success-check" aria-hidden="true">⚠</div>
      <p class="order-success-eyebrow">Платёж пришёл</p>
      <h3>Проверяем сумму</h3>
      <p class="order-success-copy">Сумма перевода разошлась с суммой заказа, поэтому платёж смотрит менеджер. Он свяжется с вами по указанному контакту — повторно платить не нужно.</p>
      <div class="order-success-number"><span>Заказ</span><strong>${esc(orderNo(order.number))}</strong></div>
      <a class="btn btn-lg" href="/">Продолжить покупки</a>
    </section>`;
  } else if (live) {
    const label = PAY.requisiteLabel(pay.method);
    const qr = method && method.kind === 'qr';
    card = `<div class="co-block pay-invoice">
      <h2 class="co-block-title"><span class="co-step" aria-hidden="true">1</span>Переведите сумму</h2>
      <div class="pay-amount"><span>Сумма перевода</span><b>${esc(payTotal)}</b>
        <button type="button" class="pay-copy" data-copy="${esc(String(payAmount))}" aria-label="Скопировать сумму">Копировать</button></div>
      ${payCur === PAY.BASE ? '' : `<p class="pay-cur-note muted small">Заказ на ${esc(total)} — счёт выставлен в валюте ${esc(PAY.currencyName(payCur))} по курсу магазина.</p>`}
      <div class="pay-req">
        ${qr
          ? `<div class="pay-row pay-row-qr"><span class="pay-row-label">${esc(label)}</span>
              <a class="btn btn-primary pay-qr-link" href="${esc(pay.requisite)}" rel="noopener">Открыть в приложении банка</a></div>`
          : payRow(label, pay.requisite, true)}
        ${payRow('Банк получателя', pay.bank, false)}
        ${payRow('Получатель', pay.owner, false)}
        ${payRow('Способ', method ? method.name : pay.method, false)}
      </div>
      <div class="pay-timer" id="pay-timer" role="timer" aria-live="off"${liveUntil ? '' : ' hidden'}>
        <span class="pay-timer-icon" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="8.5"/><path d="M12 7.5v5l3.2 2"/></svg></span>
        <span class="pay-timer-copy"><span class="pay-timer-label">Реквизиты действительны ещё</span><b id="pay-left">—</b></span>
      </div>
      <p class="pay-hint"><b class="pay-exact">Переведите точную сумму</b>Касса сводит перевод с заказом по сумме, поэтому лишний или недостающий рубль придётся разбирать вручную. Переводите из приложения своего банка по реквизитам выше: как только касса увидит перевод, страница обновится сама, закрывать её не нужно.</p>
      <p class="pay-state" id="pay-state" role="status" aria-live="polite">Ждём перевод…</p>
      <div class="pay-actions">
        <button type="button" class="btn" id="pay-recheck">Проверить перевод</button>
      </div>
    </div>`;
  } else if (orderArchived) {
    card = `<section class="order-success order-success-neutral" role="status">
      <div class="order-success-check" aria-hidden="true">×</div>
      <p class="order-success-eyebrow">Заказ закрыт</p>
      <h3>Оформите новый заказ</h3>
      <p class="order-success-copy">Этот заказ закрыт магазином. Если вы уже перевели деньги по выданным ранее реквизитам, повторно платить не нужно — поступление проверится автоматически.</p>
      <div class="order-success-number"><span>Заказ</span><strong>${esc(orderNo(order.number))}</strong></div>
      <a class="btn btn-primary btn-lg" href="/">Вернуться в каталог</a>
    </section>`;
  } else {
    // Ни одного действующего счёта: оплата ещё не начиналась, счёт истёк,
    // отменён или не прошёл. Во всех случаях выход один — выставить новый.
    const again = state === 'expired' || state === 'cancelled' || state === 'failed';
    const why = {
      expired: 'Срок действия прошлого счёта истёк — реквизиты сгорели.',
      cancelled: 'Прошлый счёт отменён.',
      failed: 'Прошлый платёж не прошёл.'
    }[state] || '';
    card = `<div class="co-block pay-choice">
      <h2 class="co-block-title"><span class="co-step" aria-hidden="true">1</span>${again ? 'Выставим новый счёт' : 'Как будете платить'}</h2>
      ${why ? `<p class="pay-why">${esc(why)} Выберите способ — реквизиты выпустим заново.</p>` : ''}
      ${payCurrencyChoice(order, currencies, currency, opts.amounts, settings)}
      ${methods.length
        ? payMethodChoice(methods, pay && pay.method)
        + `<button type="button" class="btn btn-primary btn-lg" id="pay-create">Получить реквизиты</button>`
        : `<p class="pay-hint">Способы оплаты сейчас недоступны. Заказ сохранён — менеджер свяжется с вами и подтвердит оплату.</p>`}
      ${canDiscardDraft ? `<form class="pay-draft-actions" method="post" action="/pay/${encodeURIComponent(order.id)}/draft">
        <button type="submit" class="btn btn-plain" name="intent" value="edit">Вернуться и изменить заказ</button>
        <button type="submit" class="btn btn-danger" name="intent" value="cancel">Отменить заказ</button>
      </form>` : ''}
      <p class="form-msg" id="pay-msg" hidden></p>
    </div>`;
  }

  const body = `<div class="container checkout-page pay-page" id="pay-page"
    data-order="${esc(order.id)}" data-state="${esc(state || 'none')}"
    data-attempt="${esc(String((pay && (pay.id || pay.attemptId)) || ''))}"
    data-currency="${esc(currency)}"
    data-expires="${esc(String(liveUntil || 0))}">
    <header class="checkout-head">
      <h1 class="checkout-title">${state === 'paid' ? 'Заказ оплачен' : 'Оплата заказа'}</h1>
      <p class="checkout-sub">Заказ ${esc(orderNo(order.number))} на ${esc(total)}</p>
    </header>
    <div class="pay-wrap">${card}</div>
  </div>`;
  return layout(settings, {
    body, categories: opts.categories || [], title: 'Оплата заказа',
    origin: opts.origin || '', canonicalPath: '/pay/' + order.id, noindex: true,
    scripts: ['pay.js'],
    description: `Оплата заказа в ${settings.storeName}`
  });
}

function privacyPage(settings, opts) {
  opts = opts || {};
  const info = operatorDetails(settings);
  const body = `<div class="container legal-page">
    <nav class="breadcrumb"><a href="/">Главная</a> / <span>Политика конфиденциальности</span></nav>
    <header class="legal-hero">
      <span class="section-kicker">Правовая информация</span>
      <h1>Политика конфиденциальности и обработки персональных данных</h1>
    </header>

    <div class="legal-card">
      <section class="legal-section" id="general">
        <h2>1. Общие положения</h2>
        <p>Настоящая Политика описывает, как ${esc(settings.storeName)} обрабатывает и защищает персональные данные посетителей сайта. Она составлена с учётом Федерального закона от 27.07.2006 № 152-ФЗ «О персональных данных» и иных применимых норм законодательства Российской Федерации.</p>
        <p>Оператор обрабатывает данные, необходимые для ответа на обращение, оформления заказа, публикации и модерации отзывов, работы корзины, защиты сайта и собственной аналитики посещаемости.</p>
      </section>

      <section class="legal-section" id="operator">
        <h2>2. Оператор и контакты</h2>
        ${operatorCard(settings)}
      </section>

      <section class="legal-section" id="data">
        <h2>3. Какие данные обрабатываются</h2>
        <ul>
          <li><b>Заказы и обращения:</b> имя и фамилия получателя, телефон, Telegram или e-mail, адрес доставки, состав и параметры заказа.</li>
          <li><b>Отзывы:</b> имя или псевдоним, оценки, текст, приложенные фотографии и сведения о товаре.</li>
          <li><b>Технические данные:</b> IP-адрес, дата и время запроса, адрес страницы, сведения о браузере и устройстве — для работы сервера, безопасности и ограничения спама.</li>
          <li><b>Собственная метрика:</b> случайный идентификатор посетителя, посещённые страницы, число, продолжительность и время визитов, источник и UTM-метки, IP-адрес, приблизительные город, регион и страна, факт оформления заявки.</li>
          <li><b>Устройство:</b> тип и модель устройства, браузер, операционная система, язык, часовой пояс, платформа, размер экрана и окна, объём памяти, число логических процессоров и тип соединения — если браузер предоставляет эти сведения.</li>
          <li><b>Данные браузера:</b> содержимое корзины, введённые поля оформления заказа, короткий технический идентификатор попытки оплаты и настройка отключения собственной метрики хранятся локально на устройстве посетителя.</li>
        </ul>
        <p>Сайт не запрашивает паспортные данные, платёжные реквизиты или специальные категории персональных данных. Не указывайте их в свободных полях и не загружайте на фотографиях.</p>
      </section>

      <section class="legal-section" id="purposes">
        <h2>4. Цели и основания обработки</h2>
        <div class="legal-table-wrap"><table class="legal-table purposes-table"><thead><tr><th>Цель</th><th>Данные</th><th>Основание</th></tr></thead><tbody>
          <tr><td>Обработка заявки и связь с покупателем</td><td>Имя, контакт, адрес доставки, заказ</td><td>Действия по инициативе посетителя до заключения договора и исполнение договора (п. 5 ч. 1 ст. 6 Закона № 152-ФЗ)</td></tr>
          <tr><td>Модерация и публикация отзыва</td><td>Имя или псевдоним, оценки, текст, фотографии</td><td>Согласие на обработку и согласие на распространение — отметка в форме отзыва</td></tr>
          <tr><td>Безопасность и предотвращение злоупотреблений</td><td>Технические данные</td><td>Исполнение обязанностей оператора и защита законных интересов</td></tr>
          <tr><td>Корзина и восстановление оформления</td><td>Локальные идентификаторы, выбранные товары, имя, телефон, контакт, адрес, способ доставки и пункт выдачи</td><td>Запрос посетителя на использование функций сайта</td></tr>
          <tr><td>Предотвращение повторного выставления платёжного счёта</td><td>Случайный локальный идентификатор запроса, способ и валюта без платёжных реквизитов</td><td>Запрос посетителя на оплату заказа и защита от ошибочного дубля</td></tr>
          <tr><td>Оценка посещаемости, эффективности и улучшение сайта</td><td>Идентификатор метрики, посещения, устройство, источник, IP и приблизительная геолокация</td><td>Осуществление прав и законных интересов Оператора при условии соблюдения прав и свобод посетителя (п. 7 ч. 1 ст. 6 Закона № 152-ФЗ); итоговая статистика обезличивается</td></tr>
        </tbody></table></div>
      </section>

      <section class="legal-section" id="processing">
        <h2>5. Как обрабатываются данные</h2>
        <p>Обработка может включать сбор, запись, систематизацию, хранение, уточнение, извлечение, использование, предоставление лицам, обеспечивающим работу сайта, блокирование и удаление. Обработка выполняется автоматизированным способом и, при работе менеджера с заявкой, без использования средств автоматизации.</p>
        <p>Если для сайта настроены уведомления в Telegram, сведения из заказа или отзыва, включая IP, приблизительный город и данные устройства, могут быть направлены менеджеру через этот сервис. Переход посетителя по внешней ссылке Telegram регулируется также документами самого Telegram.</p>
        <p>Для определения приблизительного города по IP может использоваться сервис <a class="link" href="https://ipwhois.io/privacy" target="_blank" rel="noopener noreferrer">IPWhois</a>, которому передаётся IP-адрес. Точность такой геолокации не гарантируется. Иные сведения заказа сервису геолокации не передаются.</p>
        <p>Для подсказок при заполнении поля адреса на оформлении заказа может использоваться сервис <a class="link" href="https://dadata.ru/agreement/" target="_blank" rel="noopener noreferrer">DaData</a>: сервер сайта передаёт ему только ту строку, которую посетитель набирает в этом поле, и получает варианты адресов. Имя, контакт, состав заказа и иные сведения этому сервису не передаются. Подсказки необязательны — полный адрес можно ввести вручную, но для доставки его необходимо указать.</p>
        <p>Оператор не продаёт персональные данные, не передаёт их рекламным сетям и не использует сторонние рекламные cookie. Передача государственным органам допускается только в случаях, предусмотренных законом.</p>
      </section>

      <section class="legal-section" id="storage">
        <h2>6. Сроки хранения и защита</h2>
        <p>Данные заказа хранятся до завершения работы с заявкой и далее в течение срока, необходимого для исполнения договора, разрешения споров и выполнения требований закона. Данные отзыва хранятся до удаления отзыва, отзыва согласия либо прекращения работы сайта. Идентифицируемая карточка посетителя в собственной метрике автоматически ограничивается 365 днями.</p>
        <p>Оператор применяет разграничение доступа, защищённые сессии, ограничение частоты запросов, резервное копирование и иные разумные организационные и технические меры. Оператор обязан обеспечить выполнение применимых требований о локализации баз данных граждан Российской Федерации и трансграничной передаче до начала такой обработки.</p>
      </section>

      <section class="legal-section" id="rights">
        <h2>7. Права посетителя</h2>
        <p>Посетитель вправе запросить сведения об обработке своих данных, потребовать их уточнения, блокирования или удаления, а также отозвать согласие. Для этого направьте обращение Оператору: ${info.contact}. В обращении укажите сведения, позволяющие найти заявку или отзыв, и суть требования.</p>
        <p>Отзыв согласия не влияет на законность обработки до его отзыва и не прекращает обработку, для которой у Оператора остаётся иное предусмотренное законом основание. Посетитель также вправе обратиться в Роскомнадзор или суд.</p>
      </section>

      <section class="legal-section" id="cookies">
        <h2>8. Cookie и локальное хранилище</h2>
        <p>При открытии сайта автоматически запускается собственная first-party метрика. Она работает без стороннего аналитического скрипта и не используется для показа рекламы. Короткий технический сигнал отправляется не чаще одного раза в минуту и только пока страница видима.</p>
        <div class="legal-table-wrap"><table class="legal-table cookies-table"><thead><tr><th>Название</th><th>Тип</th><th>Назначение</th><th>Срок</th></tr></thead><tbody>
          <tr><td><code>sess</code></td><td>Cookie, HttpOnly, SameSite=Lax, Secure при HTTPS</td><td>Защищённая сессия: авторизация панели, принадлежность заказа покупателю и доступ к его странице оплаты. Для обычного просмотра без оформления не создаётся.</td><td>До 7 дней или до выхода</td></tr>
          <tr><td><code>cart_v1</code></td><td>localStorage</td><td>Хранит выбранные товары и их количество на устройстве посетителя.</td><td>До очистки данных сайта в браузере</td></tr>
          <tr><td><code>checkout_v1</code></td><td>localStorage</td><td>Восстанавливает имя, фамилию, телефон, дополнительный контакт, адрес, способ доставки и выбранный пункт выдачи после возврата к оформлению.</td><td>До 7 дней после последнего сохранения; просроченная запись удаляется при следующем открытии оформления либо при очистке данных сайта</td></tr>
          <tr><td><code>pay_request_v1:…</code></td><td>localStorage</td><td>Не даёт создать второй счёт, если ответ кассы потерялся: хранит случайный идентификатор запроса, выбранные способ и валюту без реквизитов карты.</td><td>До 5 минут или однозначного ответа; просроченная запись удаляется на открытой странице либо при следующем открытии оплаты</td></tr>
          <tr><td><code>am_analytics</code></td><td>Cookie, HttpOnly, SameSite=Lax, Secure при HTTPS</td><td>Случайный идентификатор для подсчёта уникальных посетителей, визитов, просмотренных страниц и связи посещения с заявкой.</td><td>До 1 года или до отключения</td></tr>
          <tr><td><code>am_analytics_off</code></td><td>Cookie, HttpOnly, SameSite=Lax, Secure при HTTPS</td><td>Не позволяет серверу снова создавать идентификатор после отключения метрики на этом устройстве.</td><td>До 1 года</td></tr>
          <tr><td><code>analytics_disabled_v1</code></td><td>localStorage</td><td>Запоминает отключение собственной метрики на этом устройстве.</td><td>До очистки данных сайта в браузере</td></tr>
        </tbody></table></div>
        <p>Запись собственной метрики выполняется на сервере сайта; рекламные идентификаторы и содержимое полей форм в статистику не попадают. Параметры URL очищаются, кроме явно указанных UTM-меток рекламной кампании.</p>
        <p>Метрику можно отключить для этого устройства: идентификатор и связанная с ним карточка посетителя будут удалены. Обезличенные итоговые счётчики посещений могут сохраниться, а данные уже оформленных заказов хранятся по правилам раздела 6.</p>
        <div class="legal-actions"><button class="btn" type="button" id="analytics-disable">Отключить метрику на этом устройстве</button></div>
      </section>

      <section class="legal-section" id="changes">
        <h2>9. Изменение Политики</h2>
        <p>Оператор может обновлять Политику при изменении функций сайта или законодательства. Новая редакция действует с момента публикации по этому адресу.</p>
        <div class="legal-actions"><a class="btn" href="/personal-data-consent">Согласие на обработку данных</a><a class="btn" href="/personal-data-publication-consent">Согласие на публикацию отзыва</a></div>
      </section>
    </div>
  </div>`;
  return layout(settings, {
    body, categories: opts.categories || [], payRemind: opts.payRemind, title: 'Политика конфиденциальности',
    origin: opts.origin || '', canonicalPath: '/privacy',
    description: `Политика конфиденциальности и обработки персональных данных ${settings.storeName}`
  });
}

function personalDataConsentPage(settings, opts) {
  opts = opts || {};
  const body = `<div class="container legal-page">
    <nav class="breadcrumb"><a href="/">Главная</a> / <span>Согласие на обработку данных</span></nav>
    <header class="legal-hero"><span class="section-kicker">Отдельный документ</span><h1>Согласие на обработку персональных данных</h1></header>
    <div class="legal-card">
      <section class="legal-section"><h2>Оператор</h2>${operatorCard(settings)}</section>
      <section class="legal-section">
        <h2>Условия согласия</h2>
        <p>Отмечая в форме отзыва галочку «Даю согласие на обработку данных и публикацию отзыва» и отправляя отзыв, я свободно, своей волей и в своём интересе даю Оператору конкретное, информированное и однозначное согласие на обработку переданных мной персональных данных. Без этой отметки отзыв не отправляется.</p>
        <h3>Данные отзыва</h3>
        <p>Состав данных: имя или псевдоним, оценки, текст, фотографии и сведения о товаре. Цели: принять, проверить и модерировать отзыв. Публикация данных на сайте регулируется <a class="link" href="/personal-data-publication-consent">отдельным согласием на распространение</a>.</p>
        <p>Разрешённые действия: сбор, запись, систематизация, хранение, уточнение, извлечение, использование, предоставление техническим исполнителям, блокирование и удаление; автоматизированная и неавтоматизированная обработка. Если настроены уведомления, данные могут быть переданы менеджеру через Telegram в объёме, необходимом для работы с обращением.</p>
        <p>Согласие действует до достижения указанных целей либо до его отзыва, если обработка не должна быть продолжена на ином законном основании. Отозвать согласие можно по контактам Оператора, указанным выше. Порядок обработки и права субъекта подробнее описаны в <a class="link" href="/privacy">Политике конфиденциальности</a>.</p>
      </section>
    </div>
  </div>`;
  return layout(settings, { body, categories: opts.categories || [], payRemind: opts.payRemind, title: 'Согласие на обработку персональных данных', origin: opts.origin || '', canonicalPath: '/personal-data-consent', description: `Согласие на обработку персональных данных ${settings.storeName}` });
}

function publicationConsentPage(settings, opts) {
  opts = opts || {};
  const body = `<div class="container legal-page">
    <nav class="breadcrumb"><a href="/">Главная</a> / <span>Согласие на публикацию отзыва</span></nav>
    <header class="legal-hero"><span class="section-kicker">Отдельный документ</span><h1>Согласие на обработку персональных данных, разрешённых для распространения</h1></header>
    <div class="legal-card">
      <section class="legal-section"><h2>Оператор</h2>${operatorCard(settings)}</section>
      <section class="legal-section">
        <h2>Что разрешается публиковать</h2>
        <p>Отмечая в форме отзыва галочку «Даю согласие на обработку данных и публикацию отзыва» и отправляя отзыв, я разрешаю Оператору после модерации разместить на сайте указанные мной имя или псевдоним, оценку, текст отзыва и приложенные фотографии в связи с выбранным товаром. Той же отметкой даётся согласие на обработку этих данных; тексты обоих согласий доступны по ссылкам рядом с галочкой.</p>
        <p>Доступ к опубликованным сведениям получает неограниченный круг посетителей сайта. Оператор вправе не публиковать отзыв, скрыть или удалить его. Передача опубликованных сведений третьим лицам для самостоятельного использования и продвижение отзыва в рекламе этим согласием не разрешаются.</p>
        <p>Я подтверждаю, что не включил(а) в отзыв лишние контактные, паспортные, платёжные и иные конфиденциальные сведения, а также персональные данные третьих лиц без законного основания.</p>
        <p>Согласие действует до удаления отзыва или его отзыва мной. Отозвать согласие и потребовать удаления можно по контактам Оператора, указанным выше, сообщив товар, имя или псевдоним и примерную дату публикации.</p>
        <p><a class="link" href="/privacy">Политика конфиденциальности</a> · <a class="link" href="/personal-data-consent">Согласие на обработку данных</a></p>
      </section>
    </div>
  </div>`;
  return layout(settings, { body, categories: opts.categories || [], payRemind: opts.payRemind, title: 'Согласие на публикацию отзыва', origin: opts.origin || '', canonicalPath: '/personal-data-publication-consent', description: `Согласие на публикацию отзыва ${settings.storeName}` });
}

// Гарантия и возврат — два отдельных документа, а не один раздел «Гарантия и
// возврат», как это обычно делают в рознице. Покупатель приходит ровно с одним
// из двух вопросов: «сломалось, чинят ли» либо «передумал, вернут ли деньги», —
// и в общем тексте каждому приходится пролистывать чужую половину.
//
// Перевозчиков берём из закрытого списка `lib/delivery.js`, а не переписываем
// названия руками: разъехавшись, документ обещал бы отправку способом, которого
// на оформлении нет.
function carrierNames() { return DELIVERY.METHODS.map(m => m.name).join(' или '); }

function warrantyPage(settings, opts) {
  opts = opts || {};
  const info = operatorDetails(settings);
  const body = `<div class="container legal-page">
    <nav class="breadcrumb"><a href="/">Главная</a> / <span>Гарантия</span></nav>
    <header class="legal-hero">
      <span class="section-kicker">Правовая информация</span>
      <h1>Гарантия на технику</h1>
      <p>Мы продаём новую оригинальную технику. В течение гарантийного срока заводские недостатки устраняются бесплатно, а при существенном недостатке товар меняется либо деньги возвращаются.</p>
    </header>

    <div class="legal-card">
      <section class="legal-section" id="terms">
        <h2>1. Срок гарантии</h2>
        <div class="legal-table-wrap"><table class="legal-table warranty-table"><thead><tr><th>Срок</th><th>На что распространяется</th></tr></thead><tbody>
          <tr><td>1 год с момента покупки</td><td>Технически сложные товары: смартфоны, планшеты, компьютеры и ноутбуки, часы, игровые приставки, акустические системы, бытовая техника и электроника — если иное не указано на странице товара.</td></tr>
          <tr><td>1 месяц с момента покупки</td><td>Аксессуары, чехлы и ремешки, кабели и переходники, зарядные устройства, товары для дома — если иное не указано на странице товара.</td></tr>
          <tr><td>Без гарантии</td><td>Расходные элементы и материалы: элементы питания, картриджи, защитные плёнки и подобное.</td></tr>
        </tbody></table></div>
        <p>Гарантийный срок исчисляется со дня передачи товара покупателю, а если день передачи установить невозможно — со дня изготовления товара.</p>
      </section>

      <section class="legal-section" id="proof">
        <h2>2. Чем подтверждается гарантия</h2>
        <p>Основанием для гарантийного обращения служит кассовый или товарный чек, гарантийный талон либо иной документ о покупке. Достаточно и номера заказа на сайте: заявка хранится у нас, и по ней видны дата покупки и состав заказа.</p>
        <p>Отсутствие у покупателя документа о покупке не лишает его права ссылаться на гарантию и приводить другие доказательства приобретения товара (п. 5 ст. 18 Закона РФ от 07.02.1992 № 2300-1 «О защите прав потребителей»).</p>
      </section>

      <section class="legal-section" id="service">
        <h2>3. Гарантийное обслуживание</h2>
        <ul>
          <li>осуществляется на протяжении всего гарантийного срока, установленного на товар;</li>
          <li>срок гарантийного обслуживания не превышает 45 дней;</li>
          <li>проводится авторизованными или партнёрскими сервисными центрами производителя либо продавца;</li>
          <li>при выявлении заводского недостатка гарантийный срок продлевается на период нахождения товара в ремонте.</li>
        </ul>
      </section>

      <section class="legal-section" id="exclusions">
        <h2>4. Когда гарантия не действует</h2>
        <p>Товар не подлежит гарантийному обслуживанию, если он:</p>
        <ul>
          <li>имеет повреждения, вызванные небрежным обращением из-за нарушения правил эксплуатации, транспортировки и хранения, изложенных в руководстве пользователя;</li>
          <li>имеет механические, термические или электрические повреждения, в том числе скрытые, либо содержит элементы со следами перегрева, сгоревшие контакты или дорожки платы;</li>
          <li>имеет повреждения, вызванные стихией, пожаром или иными бытовыми факторами;</li>
          <li>вышел из строя из-за использования нестандартных или несовместимых запчастей, комплектующих, программного обеспечения, расходных и чистящих материалов;</li>
          <li>имеет следы попадания внутрь посторонних веществ, предметов или жидкостей;</li>
          <li>имеет следы постороннего вмешательства, несанкционированного ремонта или модификации;</li>
          <li>лишён гарантийных пломб и наклеек производителя или поставщика либо они повреждены;</li>
          <li>имеет повреждённую, неразборчивую или переклеенную заводскую маркировку либо серийный номер.</li>
        </ul>
        <p>Гарантия не покрывает естественный износ, настройку и восстановление программного обеспечения, утрату данных, а также постепенное снижение ёмкости аккумулятора в пределах, заявленных производителем.</p>
      </section>

      <section class="legal-section" id="how">
        <h2>5. Как обратиться по гарантии</h2>
        <p>Сообщите о неисправности продавцу: ${info.contact}. Укажите номер заказа, модель и опишите, как проявляется недостаток.</p>
        <p>Для обращения понадобятся лист с описанием неисправности, упаковка, полная комплектация, товарный чек или номер заказа и гарантийный талон, если он выдавался.</p>
        <p>Товар отправляется перевозчиком (${esc(carrierNames())}) с полным страхованием отправления и вручением лично в руки. Транспортировка товара весом менее 5 кг для диагностики и гарантийного обслуживания производится покупателем самостоятельно.</p>
      </section>

      <section class="legal-section" id="rights">
        <h2>6. Права покупателя по закону</h2>
        <p>Гарантия продавца не отменяет и не ограничивает прав, предоставленных покупателю Законом РФ «О защите прав потребителей». При обнаружении недостатков покупатель вправе заявить одно из требований статьи 18 этого закона, в том числе отказаться от договора и потребовать возврата уплаченной суммы.</p>
        <p>Сроки предъявления таких требований, порядок обмена и возврата денег описаны отдельно.</p>
        <div class="legal-actions"><a class="btn" href="/returns">Условия возврата и обмена</a></div>
      </section>

      <section class="legal-section" id="seller">
        <h2>7. Продавец</h2>
        ${operatorCard(settings, 'Продавец', 'Обращения по гарантии')}
      </section>
    </div>
  </div>`;
  return layout(settings, {
    body, categories: opts.categories || [], payRemind: opts.payRemind, title: 'Гарантия',
    origin: opts.origin || '', canonicalPath: '/warranty',
    description: `Гарантия на технику в ${settings.storeName}: сроки, гарантийное обслуживание и порядок обращения`
  });
}

function returnsPage(settings, opts) {
  opts = opts || {};
  const info = operatorDetails(settings);
  const body = `<div class="container legal-page">
    <nav class="breadcrumb"><a href="/">Главная</a> / <span>Возврат и обмен</span></nav>
    <header class="legal-hero">
      <span class="section-kicker">Публичная оферта</span>
      <h1>Условия возврата и обмена товара</h1>
      <p>Настоящие условия — часть договора розничной купли-продажи, заключаемого дистанционным способом. Оформляя заказ на сайте, покупатель принимает их (ст. 435 и 437 Гражданского кодекса РФ).</p>
    </header>

    <div class="legal-card">
      <section class="legal-section" id="distance">
        <h2>1. Отказ от товара при покупке через сайт</h2>
        <p>Покупатель вправе отказаться от товара в любое время до его передачи, а после передачи — в течение семи дней (ст. 26.1 Закона РФ «О защите прав потребителей»).</p>
        <p>Если информация о порядке и сроках возврата товара надлежащего качества не была предоставлена в письменной форме в момент доставки, покупатель вправе отказаться от товара в течение трёх месяцев с момента его передачи — согласно Правилам продажи товаров при дистанционном способе продажи товара, утверждённым постановлением Правительства РФ от 31.12.2020 № 2463.</p>
        <p>Отказ возможен, если сохранены товарный вид и потребительские свойства товара, а также документ, подтверждающий покупку. Отсутствие такого документа не лишает покупателя возможности ссылаться на другие доказательства приобретения.</p>
        <p>Товар надлежащего качества, изготовленный по индивидуальному заказу и обладающий индивидуально определёнными свойствами, возврату не подлежит, если он может быть использован исключительно приобретающим его покупателем — например, гравировка по заказу покупателя.</p>
      </section>

      <section class="legal-section" id="quality">
        <h2>2. Товар надлежащего качества</h2>
        <p>Согласно статье 25 Закона РФ «О защите прав потребителей» покупатель вправе обменять или вернуть товар надлежащего качества в течение четырнадцати дней, не считая дня покупки.</p>
        <p>Обмен или возврат производится, если товар не был в употреблении и сохранены его товарный вид и потребительские свойства, целостность упаковки и комплектации, фабричные ярлыки и пломбы. Наличие следов эксплуатации может стать основанием для отказа в удовлетворении требования о возврате или обмене.</p>
      </section>

      <section class="legal-section" id="complex">
        <h2>3. Технически сложные товары</h2>
        <p>Обмен или возврат товара надлежащего качества не предусмотрен для товаров из Перечня технически сложных товаров бытового назначения (постановление Правительства РФ от 10.11.2011 № 924), а также для товаров из Перечня непродовольственных товаров надлежащего качества, не подлежащих обмену (постановление Правительства РФ от 31.12.2020 № 2463). Это смартфоны, планшеты, компьютеры и ноутбуки, часы, игровые приставки, акустические системы, бытовая техника и электроника.</p>
        <p>Ограничение не отменяет права на отказ от товара при дистанционной покупке (раздел 1) и права предъявить требования по недостаткам товара (раздел 4).</p>
      </section>

      <section class="legal-section" id="defect">
        <h2>4. Товар ненадлежащего качества</h2>
        <p>При обнаружении недостатков заводского характера в течение 14 дней, не считая дня покупки, продавец заменяет такой товар в течение семи дней со дня обращения покупателя, а при необходимости дополнительной проверки качества — в течение двадцати дней с момента обращения. Покупатель вправе по своему выбору заявить одно из требований статьи 18 Закона РФ от 07.02.1992 № 2300-1 «О защите прав потребителей»:</p>
        <ul>
          <li>отказаться от исполнения договора купли-продажи и потребовать возврата уплаченной за товар суммы;</li>
          <li>потребовать замены на товар этой же марки (модели, артикула) либо на такой же товар другой марки (модели, артикула) с соответствующим перерасчётом покупной цены.</li>
        </ul>
        <p>По истечении 14 дней предъявить указанные требования в отношении технически сложного товара можно, если:</p>
        <ul>
          <li>обнаружен существенный недостаток товара — неустранимый либо не устранимый без несоразмерных расходов или затрат времени, либо выявляющийся неоднократно, либо проявляющийся вновь после его устранения;</li>
          <li>нарушены установленные законом сроки устранения недостатков товара;</li>
          <li>товар невозможно использовать в совокупности более чем тридцать дней в течение каждого года гарантийного срока вследствие неоднократного устранения его различных недостатков.</li>
        </ul>
        <p>Порядок ремонта и случаи, в которых гарантия не действует, описаны на странице <a class="link" href="/warranty">Гарантия</a>.</p>
      </section>

      <section class="legal-section" id="how">
        <h2>5. Как вернуть или обменять товар</h2>
        <p>Сообщите о возврате продавцу: ${info.contact}. Укажите номер заказа и причину — так мы согласуем адрес отправки и не потеряем посылку.</p>
        <p>К отправлению приложите:</p>
        <ul>
          <li>заявление или лист с описанием неисправности либо причины возврата;</li>
          <li>упаковку и полную комплектацию товара;</li>
          <li>товарный чек или номер заказа и гарантийный талон, если он выдавался.</li>
        </ul>
        <p>Товар отправляется перевозчиком (${esc(carrierNames())}) с полным страхованием отправления и доставкой лично в руки. Транспортировка товара весом менее 5 кг для обмена, возврата или диагностики производится покупателем самостоятельно.</p>
      </section>

      <section class="legal-section" id="money">
        <h2>6. Возврат денежных средств</h2>
        <ul>
          <li>возврат производится в той же форме, в которой производилась оплата;</li>
          <li>срок рассмотрения заявления на возврат денежных средств составляет от 1 до 10 дней;</li>
          <li>деньги возвращаются на ту же банковскую карту или счёт, с которых производилась оплата, если покупатель не укажет в заявлении реквизиты другой карты или счёта по причине их потери или блокировки;</li>
          <li>зачисление денежных средств занимает от 1 до 30 банковских дней в зависимости от банка покупателя;</li>
          <li>при отказе от товара продавец возвращает его стоимость за вычетом расходов на доставку возвращённого товара от покупателя (п. 4 ст. 26.1 Закона РФ «О защите прав потребителей»).</li>
        </ul>
      </section>

      <section class="legal-section" id="seller">
        <h2>7. Продавец</h2>
        ${operatorCard(settings, 'Продавец', 'Обращения по возврату и обмену')}
        <div class="legal-actions"><a class="btn" href="/warranty">Гарантия</a><a class="btn" href="/privacy">Политика конфиденциальности</a></div>
      </section>
    </div>
  </div>`;
  return layout(settings, {
    body, categories: opts.categories || [], payRemind: opts.payRemind, title: 'Возврат и обмен',
    origin: opts.origin || '', canonicalPath: '/returns',
    description: `Условия возврата и обмена товара в ${settings.storeName}: сроки, порядок отправки и возврат денег`
  });
}

module.exports = {
  esc, money, formatDate, orderStatus, orderPayMethod, orderTone, orderRowClass, orderStats, orderStatsBar, ORDER_TONES,
  payLive, payUntil, payDisplay, payView, payLeftText,
  editSwitch, adminIcon, orderNo, orderDelivery, orderClient, orderItems, phoneText, phoneFlag, clientMarks, visitorHref, stars, startPrice, sellable, layout, homePage, notFoundPage, productPage, checkoutPage, payPage, privacyPage,
  personalDataConsentPage, publicationConsentPage, warrantyPage, returnsPage, imageMarkup, placeholderSvg,
  assetV, brandFields, cssColor, sellable, colorAvailable, defaultOption, accessibleFields, PRIVACY_VERSION,
  reviewsSlice, reviewCard, reviewReply, reviewsPager, reviewsRangeText, reviewCountText, REVIEWS_PER_PAGE, REVIEW_PHOTOS_MAX,
  sortReviews, reviewSortMode, REVIEW_SORTS,
  reviewsPageNumbers, adminSlice, adminPager, ADMIN_PER_PAGE,
  heroFit, footFit, bindShortWords
};
