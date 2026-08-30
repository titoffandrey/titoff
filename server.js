'use strict';
// Точка входа: один процесс — один магазин, без внешних зависимостей.
//
// Домен приложение не выбирает и не проверяет: под каждый домен разворачивается
// своя копия на своём VPS, а имя сайта знает обратный прокси. Всё, что раньше
// было «своим у каждого домена», лежит в общих настройках (lib/db.js).
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const db = require('./lib/db');
const auth = require('./lib/auth');
const { sendTelegram } = require('./lib/telegram');
const { suggestAddress } = require('./lib/dadata');
const CROCO = require('./lib/crocopay');
// Router над кассами: он один знает, что платёжек несколько, и он же держит
// пределы одной покупки. Провайдер напрямую нужен теперь только там, где речь
// именно о нём — например, в его собственном callback.
const PAYMENTS = require('./lib/payments');
const MERIDIAN = require('./lib/meridianpay');
const DELIVERY = require('./lib/delivery');
// Маршрут посылки: собирает и проверяет его этот модуль, хранит сам заказ, а
// показывает `/track/:number` и раздел отправления в панели.
const TRACK = require('./lib/tracking');
const SHIP = require('./lib/delivery-price');
const SHIPDAYS = require('./lib/delivery-days');
const ADDRESS = require('./lib/address');
// Телефон покупателя разбирает тот же файл, что и витрина: одна таблица кодов,
// один формат и один текст отказа. Лежит он в `public/`, потому что его грузит
// браузер (см. шапку самого файла).
const PHONE = require('./public/phone.js');
const PICKUP = require('./lib/pickup');
// Город по IP — своей базой: у внешнего сервиса тысяча запросов в сутки, и при
// нынешнем трафике город переставал определяться с середины дня.
const GEOIP = require('./lib/geoip');
const OSM = require('./lib/pickup-osm');
const PAY = require('./lib/pay-methods');
const { findBand, variantMissing, findOptions, optionsAdd, optionFits, choiceMap } = require('./lib/variants');
const R = require('./lib/render');
const D = require('./lib/discount');
// Промокоды: скидка товара — она же скидка кода по умолчанию. Единственное
// место, где код превращается в деньги, — `PROMO.priceFor()`; её спрашивают и
// корзина, и заказ.
const PROMO = require('./lib/promo');
const PF = require('./lib/price-float');
const A = require('./lib/admin-views');
const IMG = require('./lib/images');
const { Analytics, clientDetails, VISITORS_PER_PAGE } = require('./lib/analytics');
// Адрес посетителя и доверие forwarded-заголовкам: отдельный модуль, потому что
// от него зависят блокировка перебора пароля и все антиспам-лимиты.
const CLIENT_IP = require('./lib/client-ip');
// Живые обновления панели: один SSE-канал на вкладку. Каталог данных модуль
// получает снаружи — своего расчёта пути у него нет, чтобы не разойтись с
// хранилищем.
const LIVE = require('./lib/live');
/* Онлайн-чат витрины: кнопка в углу, ответы ИИ и переписка в Telegram.
 * Четыре модуля: хранилище диалогов с живым каналом, клиент OpenAI, сборка
 * system-промпта из настроек и живого каталога, мост в Telegram. */
const CHAT = require('./lib/chat');
const AI = require('./lib/ai');
const PROMPT = require('./lib/chat-prompt');
const TGCHAT = require('./lib/chat-tg');
// Ссылки в реплике консультанта — общий с витриной файл: покупатель видит
// название товара, а не адрес (см. шапку public/chat-links.js).
const LINKS = require('./public/chat-links');
// Ответ консультанта печатается, а не падает целиком: пауза на прочтение
// вопроса и ровный темп по длине ответа (см. шапку модуля).
const TYPING = require('./lib/chat-typing');
const { App } = require('./lib/server-lib');
LIVE.watch(db.DATA_DIR);

// Возвращает отчёт, если рядом лежала установка прежней мультидоменной версии.
const migration = db.ensureSeeded();
/* Город посетителя определяется СВОЕЙ базой (`lib/geoip.js`, собирается
 * `scripts/sync-geoip.js`). Внешний сервис остаётся запасным и по умолчанию
 * выключен: у него тысяча запросов в сутки — при нынешнем трафике город
 * переставал определяться с середины дня, — и каждый адрес посетителя уезжал
 * третьей стороне. `GEOIP_REMOTE=1` возвращает его, `GEOIP_ENABLED=0` выключает
 * геолокацию целиком. */
const metrics = new Analytics({
  dataDir: db.DATA_DIR,
  geoEnabled: process.env.GEOIP_ENABLED !== '0',
  remoteGeo: process.env.GEOIP_REMOTE === '1'
});

const PORT = process.env.PORT || 3000;
// Публичный origin задаётся развёртыванием и не зависит от Host конкретного
// запроса. Для callback платёжки это финансовый адрес: собрать его из заголовка
// покупателя означало бы отправить уведомление на чужой домен. В локальной
// разработке переменная необязательна, поэтому обычные http://localhost остаются
// рабочими.
function parsePublicOrigin(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  try {
    const u = new URL(raw);
    const local = u.hostname === 'localhost' || u.hostname === '127.0.0.1' || u.hostname === '::1';
    if ((u.protocol !== 'https:' && !(local && u.protocol === 'http:'))
      || u.username || u.password || (u.pathname && u.pathname !== '/') || u.search || u.hash) return '';
    return u.origin;
  } catch (e) { return ''; }
}
const PUBLIC_ORIGIN_INPUT = String(process.env.PUBLIC_ORIGIN || '').trim();
const PUBLIC_ORIGIN = parsePublicOrigin(PUBLIC_ORIGIN_INPUT);
if (PUBLIC_ORIGIN_INPUT && !PUBLIC_ORIGIN) {
  throw new Error('PUBLIC_ORIGIN должен быть origin вида https://shop.example без пути и параметров');
}
// Слушаем только петлю. Процесс всегда стоит за обратным прокси (Caddy/nginx),
// и открытый наружу порт сводил на нет всю защиту входов: при TRUST_PROXY=1
// приложение верит X-Forwarded-For, поэтому любой, кто достучался до порта
// напрямую, подставлял новый «IP» на каждую попытку пароля и обходил счётчик
// попыток, а через X-Forwarded-Host выбирал себе любой магазин.
// HOST=0.0.0.0 оставляет прежнее поведение, если прокси стоит на другой машине.
const HOST = process.env.HOST || '127.0.0.1';
/* Секрет подписи сессий. Он лежит в настройках и создаётся `ensureSeeded()`
 * выше, поэтому пустым здесь быть не может — но если когда-нибудь окажется,
 * останавливаемся, а НЕ подставляем запасную строку.
 *
 * Раньше тут стояло `|| 'fallback-secret'`. Дорога к нему закрыта (файл
 * настроек к этому моменту уже создан и пропатчен), и всё же это была
 * заряженная мина: исходники лежат в открытом репозитории, значит и запасной
 * секрет открыт, а подписанная им cookie `{"admin":…}` — это полный доступ к
 * панели. Молчаливая подстановка известного всем ключа хуже отказа запуска:
 * магазин выглядел бы работающим.
 */
const sessionSecret = db.getSettings().sessionSecret;
if (!sessionSecret || String(sessionSecret).length < 32) {
  console.error('Не найден секрет подписи сессий (settings.sessionSecret).');
  console.error('Он создаётся при первом запуске. Проверьте каталог данных: ' + db.DATA_DIR);
  process.exit(1);
}
const app = new App({
  secret: sessionSecret,
  trustProxy: process.env.TRUST_PROXY === '1',
  forceHttps: process.env.FORCE_HTTPS === '1'
});

app.static('/static', path.join(__dirname, 'public'));
app.static('/uploads', db.UPLOAD_DIR, { extensions: ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.mp4', '.m4v', '.mov'] });

const settings = () => db.getSettings();
const PRICE_MAX = 1e12;
const PASSWORD_MIN = 10;
const PRODUCT_IMAGE_MAX = db.PRODUCT_IMAGE_MAX; // потолок один на маршрут и скрипты заливки
// Multipart держит проверенные изображения в памяти. На диск они попадают только
// здесь — после проверки маршрута и прав доступа.
function persistUploads(files) {
  const names = [];
  for (const file of (files || [])) {
    if (!file || path.basename(file.filename || '') !== file.filename) continue;
    if (file.content) {
      fs.writeFileSync(path.join(db.UPLOAD_DIR, file.filename), file.content, { flag: 'wx' });
      delete file.content;
    }
    names.push(file.filename);
  }
  return names;
}
const asArray = (v) => v == null ? [] : (Array.isArray(v) ? v : [v]);
// Вернуться на ту же страницу и тот же раздел списка после удаления/restore.
// Значения приходят скрытыми полями, поэтому view закрыт двумя вариантами, а
// номер страницы приводится к ограниченному целому.
const ordersBackUrl = (body, flash) => {
  // Вкладки «Удалённые» больше нет — удаление окончательное, возвращаться
  // некуда, и `view` из адреса ушёл вместе с ней.
  const params = [];
  const n = Math.floor(Number(body && body.page));
  if (Number.isFinite(n) && n > 1) params.push('page=' + Math.min(n, 1e6));
  // Режим правки возвращается вместе со страницей и вкладкой: все кнопки списка
  // показываются только в нём, и без этого он выключался бы после каждого
  // удаления — чистка десятка заявок означала десять лишних нажатий «Изменить».
  if (body && body.edit) params.push('edit=1');
  const q = String(body && body.q || '').trim().slice(0, 100);
  if (q) params.push('q=' + encodeURIComponent(q));
  const pay = String(body && body.filterPay || '');
  if (['ok', 'wait', 'warn', 'off', 'none', 'draft'].includes(pay)) {
    params.push('pay=' + encodeURIComponent(pay));
  }
  if (flash) params.push('flash=' + encodeURIComponent(flash));
  return '/admin/orders' + (params.length ? '?' + params.join('&') : '');
};
// Тот же возврат для отзывов, где к странице добавляется вкладка, а иногда и
// товар: ленту разбирают и общей очередью, и по одному товару. Модерация идёт
// сотнями страниц, и после каждого действия админа нельзя выбрасывать ни в
// начало списка, ни с вкладки «На модерации» на «Все», ни из товара наружу.
//
// Собирается из отдельных полей формы, а НЕ из готового адреса в теле запроса:
// присланная строка уехала бы в Location как есть.
//
// Вкладка приезжает в поле `tab`, а не `status`: у формы правки есть свой
// `status` — состояние самого отзыва, — и два поля с одним именем ушли бы
// массивом, из-за чего отзыв сохранялся бы «на модерации» что ни выбери.
const REVIEW_TABS = ['pending', 'approved', 'all'];
// Отбор по вложениям в ленте товара: с видео, только с фото, без медиа.
const REVIEW_MEDIA = ['all', 'video', 'photo', 'none'];
const backFrom = (src) => ({
  status: String((src && src.tab) || ''), page: src && src.page,
  sort: String((src && src.sort) || ''), media: String((src && src.media) || ''),
  product: String((src && src.product) || '')
});
const reviewsBackUrl = (body, flash, anchor) => {
  const product = String((body && body.product) || '');
  const known = !!(product && db.getProduct(product));
  const base = known ? '/admin/reviews/product/' + encodeURIComponent(product) : '/admin/reviews';
  const params = [];
  const status = String((body && body.tab) || '');
  // Вкладка по умолчанию у страниц разная: очередь открывается на «На модерации»,
  // лента товара — на «Все». В адрес пишем только отличие от неё, чтобы ссылки
  // не обрастали мусором.
  if (REVIEW_TABS.includes(status) && status !== (known ? 'all' : 'pending')) params.push('status=' + status);
  // Сортировка возвращается вместе со страницей и вкладкой: разобрав низкие
  // оценки, админ после каждого действия оказывался бы снова в «Новых».
  const sort = String((body && body.sort) || '');
  if (R.REVIEW_SORTS.some(([key]) => key === sort) && sort !== R.REVIEW_SORTS[0][0]) params.push('sort=' + sort);
  // Отбор по вложениям — там же и по той же причине. «Все» в адрес не пишем.
  const media = String((body && body.media) || '');
  if (REVIEW_MEDIA.includes(media) && media !== 'all') params.push('media=' + media);
  const n = Math.floor(Number(body && body.page));
  if (Number.isFinite(n) && n > 1) params.push('page=' + Math.min(n, 1e6));
  if (flash) params.push('flash=' + encodeURIComponent(flash));
  return base + (params.length ? '?' + params.join('&') : '') + (anchor ? '#' + anchor : '');
};
/* Дата из формы правки отзыва. Поле показывает МОСКОВСКОЕ время (панель вся
 * московская), а `Date.parse` читает строку без зоны как локальное время
 * ПРОЦЕССА — на сервере это UTC, и сохранённая дата уезжала бы на три часа при
 * каждом сохранении. Разбирает её тот же модуль, что и показывает. */
const parseDt = (v) => R.parseMskInput(v);
// Варианты из формы: цвета «Название|#hex|наличие» и память «Метка|доплата|наличие».
// Третье поле необязательное: «нет» — вариант распродан. Пустое = в наличии,
// поэтому старые данные без третьего поля читаются как раньше.
const safeHex = (v, fallback) => { const h = String(v || '').trim(); return /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(h) ? h : (fallback || '#cccccc'); };
const short = (v, max) => String(v == null ? '' : v).slice(0, max);
function passwordError(value, required) {
  const password = String(value == null ? '' : value).trim();
  if (!password) return required ? `Задайте пароль длиной не менее ${PASSWORD_MIN} символов` : '';
  if (password.length < PASSWORD_MIN) return `Пароль должен содержать не менее ${PASSWORD_MIN} символов`;
  if (password.length > 500) return 'Пароль слишком длинный';
  return '';
}
const parseStock = (v) => !/^(нет|no|0|out)$/i.test(String(v == null ? '' : v).trim());
// Повторы схлопываем: два одинаковых цвета дают два одинаковых кружка на витрине,
// а в корзине это вообще один и тот же вариант.
const uniqBy = (list, key) => { const seen = new Set(); return list.filter(x => { const k = key(x).toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true; }); };
const parseColors = (txt) => uniqBy(String(txt || '').split('\n').slice(0, 100).map(l => l.trim()).filter(Boolean).map(l => { const [name, hex, stock] = l.split('|'); return { name: (name || '').trim().slice(0, 40), hex: safeHex(hex), inStock: parseStock(stock) }; }).filter(c => c.name), c => c.name);
// «Доступно только при таком выборе в другой группе»: хвост `?Чип=M5 Max, 32 ядра GPU`.
// У Apple от чипа зависит и объём памяти, и потолок накопителя, поэтому привязку
// понимают и конфигурации, и значения групп. Пустой разбор — ограничения нет.
//
// **Одна пара — ровно одно значение, а несколько задаются повтором группы**
// (`?Чип=M5 Pro, 15 ядер CPU;Чип=M5 Pro, 18 ядер CPU`). Раньше значения внутри
// пары делились запятой — и на этом всё ломалось: у Apple запятая стоит в самой
// метке чипа. «M5 Max, 32 ядра GPU» превращалось в два несуществующих значения,
// поэтому обычное «открыл карточку и нажал Сохранить» скрывало на витрине всю
// оперативную память и старший накопитель, а Mac становился непокупаемым.
function parseForChoice(raw) {
  const out = {};
  for (const part of String(raw || '').split(';')) {
    const i = part.indexOf('=');
    if (i < 1) continue;
    const group = part.slice(0, i).trim().slice(0, 60);
    const value = part.slice(i + 1).trim().slice(0, 80);
    if (!group || !value) continue;
    const list = out[group] || (out[group] = []);
    if (list.length < 20 && !list.includes(value)) list.push(value);
  }
  return Object.keys(out).length ? out : null;
}
const parseStorages = (txt) => uniqBy(String(txt || '').split('\n').slice(0, 100).map(l => l.trim()).filter(Boolean).map(l => {
  const parts = l.split('|');
  const [label, add] = parts;
  const n = Number(add);
  let inStock = true;
  const choiceRaw = [];   // хвостов «?» может быть несколько — они складываются
  for (const raw of parts.slice(2)) {
    const v = String(raw || '').trim();
    if (!v) continue;
    if (v.startsWith('?')) choiceRaw.push(v.slice(1));
    else if (!parseStock(v)) inStock = false;
  }
  const forChoice = parseForChoice(choiceRaw.join(';'));
  const s = { label: (label || '').trim().slice(0, 80), add: Number.isFinite(n) && n >= 0 && n <= PRICE_MAX ? Math.round(n) : 0, inStock };
  if (forChoice) s.forChoice = forChoice;
  return s;
}).filter(s => s.label), s => s.label);

// Ремешки часов: коллекция задаёт размеры, внутри — цветовые вариации со своей
// доплатой и наличием. Формат текстового поля формы:
//   # Trail Loop | S/M, M/L
//   - Синий/чёрный | #2b4a7d | 3000
//   - Чёрный/серый | #3a3a3c | 3000 | нет
// «#» начинает коллекцию, «-» — вариацию. Третье поле вариации — доплата к цене
// часов, четвёртое — «нет» для распроданных.
function parseBands(txt) {
  const groups = [];
  for (const line of String(txt || '').split('\n')) {
    const l = line.trim();
    if (!l) continue;
    if (l.startsWith('#')) {
      if (groups.length >= 40) continue;
      const [name, sizes] = l.slice(1).split('|');
      groups.push({
        name: (name || '').trim().slice(0, 60),
        sizes: uniqBy(String(sizes || '').split(',').slice(0, 50).map(s => ({ label: s.trim().slice(0, 30) })).filter(s => s.label), s => s.label),
        options: []
      });
    } else if (l.startsWith('-') && groups.length) {
      if (groups[groups.length - 1].options.length >= 100) continue;
      const parts = l.slice(1).split('|');
      const [name, hex, add] = parts;
      const n = Number(add);
      // Хвостовые поля: «нет» — распродано, «@Цвет корпуса» — вариация доступна
      // только с этим корпусом (у Apple титановый миланский идёт в цвет часов).
      let inStock = true, forColor = '';
      for (const raw of parts.slice(3)) {
        const v = String(raw || '').trim();
        if (!v) continue;
        if (v.startsWith('@')) forColor = v.slice(1).trim().slice(0, 40);
        else if (!parseStock(v)) inStock = false;
      }
      groups[groups.length - 1].options.push({
        name: (name || '').trim().slice(0, 60),
        hex: safeHex(hex),
        add: Number.isFinite(n) && n >= 0 && n <= PRICE_MAX ? Math.round(n) : 0,
        inStock, forColor
      });
    }
  }
  return uniqBy(groups.filter(g => g.name), g => g.name)
    .map(g => Object.assign(g, { options: uniqBy(g.options.filter(o => o.name), o => o.name) }))
    .filter(g => g.options.length);
}

// Дополнительные характеристики: группа задаёт вопрос, значения — ответы со своей
// доплатой. Формат текстового поля формы такой же, как у ремешков:
//   # Покрытие дисплея | Выберите, какое стекло вам подходит
//   - Стандартное стекло | 0
//   - Нанотекстурное стекло | 15000 | нет | @1 ТБ, 2 ТБ
// «#» начинает группу (второе поле — подпись-подсказка), «-» — значение.
// Второе поле значения — доплата, дальше «нет» для распроданных и «@метки» —
// конфигурации, с которыми значение продаётся (пусто — со всеми).
function parseOptions(txt) {
  const groups = [];
  for (const line of String(txt || '').split('\n')) {
    const l = line.trim();
    if (!l) continue;
    if (l.startsWith('#')) {
      if (groups.length >= 20) continue;
      const [name, hint] = l.slice(1).split('|');
      groups.push({ name: (name || '').trim().slice(0, 60), hint: (hint || '').trim().slice(0, 160), values: [] });
    } else if (l.startsWith('-') && groups.length) {
      if (groups[groups.length - 1].values.length >= 40) continue;
      const parts = l.slice(1).split('|');
      const [label, add] = parts;
      const n = Number(add);
      let inStock = true;
      const forStorage = [];
      const choiceRaw = [];   // хвостов «?» может быть несколько — они складываются
      for (const raw of parts.slice(2)) {
        const v = String(raw || '').trim();
        if (!v) continue;
        if (v.startsWith('@')) {
          // Хвостов «@» тоже может быть несколько, и они складываются: метка
          // конфигурации сама бывает с запятой, а тогда одним списком её не
          // записать. Деление по запятой внутри хвоста осталось — так формат
          // описан в документации, и старые строки читаются по-прежнему.
          for (const only of v.slice(1).split(',').map(s => s.trim().slice(0, 80)).filter(Boolean)) {
            if (forStorage.length < 20 && !forStorage.includes(only)) forStorage.push(only);
          }
        } else if (v.startsWith('?')) {
          choiceRaw.push(v.slice(1));
        } else if (!parseStock(v)) inStock = false;
      }
      const forChoice = parseForChoice(choiceRaw.join(';'));
      const value = {
        label: (label || '').trim().slice(0, 80),
        add: Number.isFinite(n) && n >= 0 && n <= PRICE_MAX ? Math.round(n) : 0,
        inStock, forStorage
      };
      if (forChoice) value.forChoice = forChoice;
      groups[groups.length - 1].values.push(value);
    }
  }
  return uniqBy(groups.filter(g => g.name), g => g.name)
    .map(g => Object.assign(g, { values: uniqBy(g.values.filter(v => v.label), v => v.label) }))
    .filter(g => g.values.length);
}

// Проверка формы товара. Возвращает список ошибок: пустой — можно сохранять.
// Без неё пустая форма молча создавала товар «Без названия» с ценой 0.
function validateProduct(body) {
  const errors = [];
  const price = Number(body.price);
  if (!String(body.name || '').trim()) errors.push({ field: 'name', text: 'Укажите название товара' });
  if (!String(body.category || '').trim()) errors.push({ field: 'category', text: 'Укажите категорию' });
  if (!Number.isFinite(price) || price <= 0 || price > PRICE_MAX) errors.push({ field: 'price', text: 'Базовая цена должна быть числом больше нуля' });
  // Скидка — процент, и зачёркнутая цена выводится из него. Сравнение с NaN
  // всегда ложно, поэтому «abc» проверяем явно: иначе мусор молча становился бы
  // нулём, и скидка исчезала бы без объяснения.
  const pct = String(body.discountPercent == null ? '' : body.discountPercent).trim().replace(',', '.');
  if (pct) {
    const n = Number(pct);
    if (!Number.isFinite(n) || n < 0 || n > D.MAX_PCT) {
      errors.push({ field: 'discountPercent', text: `Скидка — число от 0 до ${D.MAX_PCT}` });
    }
  }
  return errors;
}
function tgEsc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
function trustedProxy(req) { return process.env.TRUST_PROXY === '1' || CLIENT_IP.isLoopback(req.socket && req.socket.remoteAddress); }

/* Сколько ДОВЕРЕННЫХ прокси стоит перед приложением. У нас это один Caddy на
 * петле, поэтому по умолчанию 1. Число нужно потому, что `X-Forwarded-For`
 * прокси ДОПИСЫВАЕТ, а не заменяет: то, что левее нашего хопа, прислал сам
 * клиент. Ставится только вручную и только под реальную цепочку прокси.
 */
const PROXY_HOPS = Math.min(10, Math.max(1, Math.floor(Number(process.env.TRUST_PROXY_HOPS)) || 1));
// Заголовки Cloudflare (`CF-Connecting-IP`, `CF-IPCountry`, `CF-IPCity`) имеют
// смысл ТОЛЬКО когда сайт реально стоит за Cloudflare: он их перезаписывает.
// В нашей установке перед приложением Caddy, и любой такой заголовок приходит
// прямо от посетителя — доверять ему нельзя. Включается флагом.
const TRUST_CF = process.env.TRUST_CLOUDFLARE === '1';
function cloudflareTrusted(req) { return TRUST_CF && trustedProxy(req); }
/* Host и proto прокси ЗАМЕНЯЕТ, а не дописывает (в отличие от X-Forwarded-For),
 * поэтому длина цепочки здесь всегда единица и считать хопы для них нельзя:
 * при `TRUST_PROXY_HOPS=2` они перестали бы читаться вовсе, и витрина
 * собирала бы canonical и callback_url по адресу из заголовка Host. Берём
 * правое значение при одном хопе — для заменяемого заголовка это он и есть.
 */
function forwardedValue(req, name) { return CLIENT_IP.forwardedValue(req.headers, name, 1); }
function requestHost(req) {
  const forwardedHost = trustedProxy(req) ? forwardedValue(req, 'x-forwarded-host') : '';
  const raw = String(forwardedHost || req.headers.host || '').split(',')[0].trim();
  return /^(?:[a-z0-9.-]+(?::\d{1,5})?|\[[0-9a-f:.]+\](?::\d{1,5})?)$/i.test(raw) ? raw : 'localhost';
}
// Абсолютный адрес сайта (для canonical, Open Graph, sitemap).
function originOf(req) {
  const forwardedProto = trustedProxy(req) ? forwardedValue(req, 'x-forwarded-proto') : '';
  const proto = process.env.FORCE_HTTPS === '1' || forwardedProto === 'https' || !!(req.socket && req.socket.encrypted) ? 'https' : 'http';
  const host = requestHost(req);
  return proto + '://' + host;
}
// Финансовые callback используют только заданный развёртыванием адрес. Host
// запроса разрешён исключительно на localhost для разработки: на боевом сайте
// подставной Host не должен стать callback-адресом кассы.
function paymentOrigin(req) {
  if (PUBLIC_ORIGIN) return PUBLIC_ORIGIN;
  try {
    const local = new URL(originOf(req));
    if (local.hostname === 'localhost' || local.hostname === '127.0.0.1' || local.hostname === '::1') return local.origin;
  } catch (e) {}
  return '';
}
// Оптимизировать загруженные фото: WebP + очистка метаданных.
// У фото ТОВАРА (`square`) рядом сразу делаются уменьшённые копии для карточки
// каталога: без них витрина отдаёт в квадратик 169–276 px кадр 1200×1200.
// Копия необязательна — нет ImageMagick, и карточка показывает исходник.
async function optimizeUploads(files, maxSize, opts) {
  const up = await IMG.optimizeMany(db.UPLOAD_DIR, persistUploads(files), maxSize, opts);
  if (opts && opts.square) for (const f of up) await IMG.makeCards(db.UPLOAD_DIR, f);
  return up;
}
// Логотип магазина: удалить старый (если попросили), загрузить/оптимизировать
// новый, иначе оставить как было.
async function resolveLogo(req, current) {
  const remove = req.body.removeLogo !== undefined;
  const up = await optimizeUploads(req.filesFor('logo'), 480);
  const value = up.length ? up[0] : (remove ? null : (current || null));
  return { value, obsolete: current && current !== value ? current : null };
}

const BRAND_FONTS = new Set(['system', 'rounded', 'grotesk', 'serif', 'slab', 'mono']);
// Поля бренда магазина из формы настроек. Раньше ровно то же самое приходило из
// двух разных форм — владельца и админки домена, — и они успели разойтись.
function brandFields(body) {
  return {
    storeName: short(body.storeName, 100).trim(), tagline: short(body.tagline, 240),
    accentColor: safeHex(body.accentColor, '#0071e3'), currency: short(body.currency, 12).replace(/[<>&]/g, '') || '₽',
    currencyPosition: body.currencyPosition === 'before' ? 'before' : 'after',
    contactTelegram: short(body.contactTelegram, 100), contactPhone: short(body.contactPhone, 100), footerNote: short(body.footerNote, 500),
    legalOperator: short(body.legalOperator, 240).trim(), legalDetails: short(body.legalDetails, 240).trim(),
    legalAddress: short(body.legalAddress, 400).trim(), privacyEmail: short(body.privacyEmail, 160).trim(),
    telegramBotToken: short(body.telegramBotToken, 240).trim(), telegramChatId: short(body.telegramChatId, 100).trim(),
    notifyReviews: body.notifyReviews !== undefined,
    logoText: short(body.logoText, 120), logoFont: BRAND_FONTS.has(body.logoFont) ? body.logoFont : 'system',
    /* Пустой вторичный цвет означает «как акцентный», и вернуться к нему надо
     * уметь: `<input type="color">` пустым не бывает, поэтому режим включает
     * отдельная галочка (снятая приходит отсутствием поля, как все прочие).
     *
     * Без неё настройка жила ровно до первого сохранения: форма отправляла
     * текущий акцент числом, `secondaryColor` навсегда становился хексом, и
     * дальше смена акцента вторичный цвет за собой уже не тянула — хотя
     * `defaultSettings()` обещает ровно обратное. */
    secondaryColor: body.secondaryAuto !== undefined ? '' : safeHex(body.secondaryColor, safeHex(body.accentColor, '#0071e3'))
  };
}

function consentAccepted(value) {
  return value === true || ['1', 'true', 'on', 'yes'].includes(String(value || '').toLowerCase());
}

// Маркер зависит от текущего логина и хеша пароля, но не раскрывает их в cookie.
// После смены реквизитов все старые сессии перестают проходить guard автоматически.
function authStamp(username, passwordHash) {
  return crypto.createHmac('sha256', settings().sessionSecret)
    .update(['admin', username || '', passwordHash || ''].join('\0')).digest('base64url').slice(0, 24);
}
// Учётная запись одна и с полными правами: делить их стало не с кем, когда
// пропали домены со своими администраторами.
function adminAuthorized(req) {
  const s = settings();
  return !!(req.session && req.session.admin === authStamp(s.adminUsername, s.adminPasswordHash));
}

// Защита входов от перебора паролей: временные счётчики попыток хранятся в памяти.
const loginAttempts = new Map();
/* Адрес посетителя. К нему привязаны счётчик попыток входа, все антиспам-лимиты
 * и карточка метрики, поэтому подставить его клиент не должен НИКАК. Разбор и
 * причина, по которой `X-Forwarded-For` читается СПРАВА, — в lib/client-ip.js.
 */
function clientIp(req) {
  return CLIENT_IP.clientIpFrom(req, {
    trusted: trustedProxy(req),
    hops: PROXY_HOPS,
    cloudflare: TRUST_CF,
    realIp: process.env.TRUST_REAL_IP === '1'
  });
}
// Страницы витрины, которые считаются посещениями. Один список на весь проект:
// он же лежит в карте сайта и в проверке подтверждения метрики.
const PUBLIC_PAGES = ['/', '/checkout', '/privacy', '/personal-data-consent', '/personal-data-publication-consent', '/warranty', '/returns'];
function metricPublicPath(rawPath) {
  let pathname;
  try { pathname = decodeURIComponent(String(rawPath || '').split('?')[0]); } catch (e) { return ''; }
  // Список должен совпадать со страницами, которые считает trackPage. Без
  // /checkout сервер записывал его посещение как «предварительное», клиент такой
  // адрес не подтверждал, и живой посетитель, зашедший сразу на оформление,
  // через две минуты уезжал в «неподтверждённые автоматические запросы».
  if (PUBLIC_PAGES.includes(pathname)) return pathname;
  const match = pathname.match(/^\/product\/([^/]+)$/);
  return match && db.visibleProduct(match[1]) ? '/product/' + match[1] : '';
}
function trackPage(req, res, pathname, options) {
  if (metrics.trackingDisabled(req)) return;
  options = options || {};
  const context = metrics.context(req, clientIp(req), cloudflareTrusted(req));
  // HEAD используют мониторинги и краулеры, но у такого запроса не будет JS-
  // подтверждения. Сразу относим его к техническим и не оставляем бессмысленную cookie.
  if (req.method === 'HEAD') {
    context.isBot = true;
    context.botName = context.botName || 'HEAD-запрос';
  }
  const technical = !!(options.is404 || context.isBot);
  let id = metrics.visitorId(req);
  if (!id) {
    id = metrics.newVisitorId();
    if (!technical) res.setHeader('Set-Cookie', metrics.cookieHeader(id, originOf(req).startsWith('https://')));
  }
  metrics.recordPageView({
    id, path: pathname, host: req.headers.host,
    requestedPath: options.requestedPath, is404: !!options.is404, provisional: !options.is404,
    context
  });
}
function loginBlocked(req) { const r = loginAttempts.get(clientIp(req)); return !!(r && r.until > Date.now()); }
function loginFail(req) {
  const ip = clientIp(req);
  const r = loginAttempts.get(ip) || { count: 0, until: 0 };
  r.count++;
  if (r.count >= 6) { r.until = Date.now() + 15 * 60 * 1000; r.count = 0; }
  r.seen = Date.now();
  // Потолок ставим ДО вставки и только для нового адреса: уже заблокированный
  // перебор не должен вытеснять сам себя из карты.
  if (!loginAttempts.has(ip)) trimMap(loginAttempts, LOGIN_KEYS_MAX);
  loginAttempts.set(ip, r);
}
function loginOk(req) { loginAttempts.delete(clientIp(req)); }
const TOO_MANY = 'Слишком много попыток входа. Подождите 15 минут.';

// Антиспам публичных форм (отзывы, заказы): не больше N запросов с одного IP за окно.
const rateHits = new Map();
/* Потолок числа записей. Ключ содержит адрес посетителя, то есть растёт вместе
 * с числом разных адресов, а выметаются они лишь раз в полчаса. Распределённый
 * перебор успел бы за это время сложить в память сотни тысяч записей, и защита
 * от спама сама стала бы способом исчерпать память процесса.
 *
 * Переполнение вычищаем по возрасту: Map хранит ключи в порядке вставки, поэтому
 * первые в обходе — самые старые. Выбрасываем четверть, а не одну запись, чтобы
 * уборка не повторялась на каждом следующем запросе.
 */
const RATE_KEYS_MAX = 50000;
const LOGIN_KEYS_MAX = 20000;
function trimMap(map, max) {
  if (map.size <= max) return;
  const drop = Math.ceil(max / 4);
  let i = 0;
  for (const key of map.keys()) { map.delete(key); if (++i >= drop) break; }
}
function rateLimited(req, bucket, limit, windowMs, identity) {
  // Публичные формы ограничиваем по IP. Действия со своим заказом можно
  // привязать к его случайному id после проверки подписанной сессии: иначе три
  // покупателя за одним Tor-exit делили один лимит polling и ловили чужой 429.
  const key = bucket + ':' + (identity ? String(identity) : clientIp(req));
  const now = Date.now();
  const r = rateHits.get(key);
  if (!r || now - r.start > windowMs) {
    trimMap(rateHits, RATE_KEYS_MAX);
    rateHits.set(key, { start: now, count: 1 });
    return false;
  }
  r.count++;
  return r.count > limit;
}
function anonymousSessionId(req) {
  const current = String(req.session && req.session.buyerId || '');
  if (/^[a-f0-9]{32}$/.test(current)) return current;
  const id = crypto.randomBytes(16).toString('hex');
  req.session.buyerId = id;
  return id;
}

/* Лимит публичной формы: по подписанной сессии И по адресу — всегда обоими.
 *
 * ЧТО ЗДЕСЬ БЫЛО СЛОМАНО. Счётчик по сессии заведён не от хорошей жизни: за
 * одним адресом сидит целый офис или Tor-выход, и общий предел отдавал бы чужой
 * отказ живому покупателю. Но сессию клиент заводит себе САМ: не прислал
 * cookie — `anonymousSessionId()` выдаёт новую, и сессионный счётчик для него не
 * существует вовсе. Проверено на живом сервере: 80 запросов `/api/chat/open`
 * без cookie прошли все 80 при пределе в 60, и создали 81 диалог; те же 80 с
 * одной cookie дали 60 ответов и 20 отказов.
 *
 * Цена этого промаха у чата самая высокая во всём проекте: каждая реплика — это
 * вызов модели ЗА СЧЁТ ВЛАДЕЛЬЦА и сообщение в Telegram-группу, а созданные
 * впустую диалоги вытесняют живые переписки по потолку в `MAX_CHATS`.
 *
 * Поэтому сессионный предел остаётся (он и защищает живого покупателя от
 * соседа по NAT), а рядом с ним всегда стоит широкий предел по адресу: живого
 * человека он не заденет никогда, но кладёт потолок тому, кто ходит без cookie.
 * Ровно так уже был устроен `/api/order` — `order` по сессии плюс `order-ip`.
 */
function floodLimited(req, bucket, perSession, perIp, windowMs) {
  return rateLimited(req, bucket, perSession, windowMs, anonymousSessionId(req))
    || rateLimited(req, bucket + '-ip', perIp, windowMs);
}
// Раз в 30 минут выметаем протухшие записи, чтобы карты не росли бесконечно.
const sweep = setInterval(() => {
  const now = Date.now();
  for (const [k, v] of rateHits) if (now - v.start > 60 * 60 * 1000) rateHits.delete(k);
  for (const [k, v] of loginAttempts) if (v.until < now && now - (v.seen || 0) > 60 * 60 * 1000) loginAttempts.delete(k);
}, 30 * 60 * 1000);
if (sweep.unref) sweep.unref();

/* =========================== ВИТРИНА =========================== */

/* Неоплаченный заказ, о котором стоит напомнить на любой странице витрины.
 *
 * Покупатель со страницы оплаты уходит легко — за реквизитами в банковское
 * приложение, за телефоном, просто закрыв вкладку. Ссылки на свою страницу
 * оплаты у него нигде больше нет, поэтому без этой полосы заказ теряется молча.
 *
 * Ключ — та же подписанная cookie-сессия, что у /pay/:id: чужой заказ так не
 * покажешь. Список `myOrders` идёт от свежего к старым, поэтому первый
 * подходящий и есть нужный.
 *
 * Напоминаем в двух случаях, и они разные:
 *
 *   - счёт ДЕЙСТВУЮЩИЙ — со сроком самих реквизитов: они сгорают, и это надо
 *     видеть. Условие общее с панелью и страницей оплаты (`R.payLive`);
 *   - счёт не выставился (касса не ответила), сгорел или отменён, а заказ так и
 *     не оплачен — со сроком САМОГО ЗАКАЗА: вернуться на страницу оплаты и
 *     выставить новый счёт покупатель должен уметь, но не бесконечно. Раньше
 *     такой заказ не напоминал о себе ничем: полоса требовала живого счёта.
 *
 * Оплаченный и ушедший на разбор (`mismatch`) не напоминают ничего — там платить
 * уже нечего. Черновик тоже: способ не выбран, товары остались в корзине, и
 * оформляют его оттуда.
 */
/* Прежнего суточного предела у напоминания больше нет, и не потому что забыли:
 * заказ теперь живёт полчаса (`R.payExpired` ниже), а сутки были нужны ровно
 * затем, чтобы бесконечная полоса хоть когда-нибудь погасла. Проверка на
 * тридцать минут стоит первой и закрывает этот случай целиком.
 */
function payRemind(req) {
  const ids = Array.isArray(req.session && req.session.myOrders) ? req.session.myOrders : [];
  if (!ids.length) return null;
  const now = Date.now();
  /* `expiresAt` — момент, когда полоса обязана исчезнуть сама, а `requisites`
   * говорит, ЧТО именно кончается: срок выданных реквизитов или срок самого
   * заказа. Слова у этих двух случаев разные, и живут они в одном месте —
   * в `payRemindBar` (lib/render.js), рядом с остальными подписями об оплате.
   */
  const card = (order, expiresAt, requisites) => ({
    id: order.id, number: order.number, total: order.total, expiresAt, requisites: !!requisites
  });
  for (const id of ids) {
    const order = db.getOrder(String(id || ''));
    if (!order || order.draft) continue;                       // черновик заказом ещё не стал
    /* Срок оплаты вышел — напоминать не о чем: платить по такому заказу
     * покупатель уже не может (`R.payExpired`, полчаса от оформления). Раньше
     * полоса висела ещё сутки и звала на страницу, где ему предлагали выставить
     * новый счёт, — то есть заказ не заканчивался никогда. */
    if (R.payExpired(order, now)) continue;
    const pay = order.payment;
    /* Заказ по своим реквизитам: кассы нет, а напомнить надо тем же способом —
     * покупатель точно так же уходит из вкладки за банковским приложением, а
     * ссылки на свою страницу оплаты у него больше нигде нет. Свои реквизиты не
     * сгорают, поэтому отсчитывается срок самого заказа. */
    if (!pay && order.payMode === 'own') {
      if (order.manualPaid || order.manualVoid || db.isOrderArchived(order)) continue;
      return card(order, R.orderPayUntil(order), false);
    }
    if (!pay) continue;
    const shown = R.payDisplay(pay, now);
    // Уже выданный счёт нельзя отменить удалением в панели: до конца срока он
    // остаётся у покупателя и сверяется как прежде. После срока архивный заказ
    // больше не напоминаем и новый invoice ему не выпускаем.
    if (R.payLive(shown, now)) return card(order, R.payUntil(shown), true);
    if (db.isOrderArchived(order) || order.manualVoid) continue;
    if (pay.status === 'paid' || pay.status === 'mismatch') continue;
    // Счёт сгорел, а полчаса заказа ещё идут: новый счёт покупатель выставить
    // может, и отсчитывается то, сколько у него на это осталось.
    return card(order, R.orderPayUntil(order), false);
  }
  return null;
}

// Общая обвязка любой страницы витрины: адрес сайта, меню категорий и
// напоминание о неоплаченном счёте.
//
// Именно одной функцией, а не полем в каждом вызове: раньше `payRemind`
// протаскивался в девять вызовов layout() поимённо, и забытая страница молча
// оставалась без напоминания. Забыть вызвать это уже нельзя — без него страница
// не соберётся вовсе.
function pageOpts(req, extra) {
  return Object.assign({
    origin: originOf(req),
    categories: db.visibleCategories(),
    payRemind: payRemind(req),
    chatWaiting: chatWaiting(req)
  }, extra || {});
}

/* Сколько сообщений ждёт покупателя в чате.
 *
 * Витрина сама к серверу не стучится: канал открывается, только когда человек
 * открыл окно, а страниц открывают в сотни раз больше, чем разговоров ведут.
 * Поэтому «вам написали» приезжает разметкой — так же, как полоса напоминания
 * о неоплаченном счёте.
 *
 * Без этого менеджер, написавший первым, оставался бы неуслышанным: у
 * покупателя нет ни отметки в localStorage, ни причины открывать окно.
 */
function chatWaiting(req) {
  if (!CHAT.visible(settings())) return 0;
  const chat = currentChat(req);
  return chat ? Math.max(0, Number(chat.unread) || 0) : 0;
}

// Страница «не найдено» — одна на 404-маршрут, битую ссылку товара и чужой заказ.
function sendNotFound(req, res) {
  trackPage(req, res, '/404', { is404: true, requestedPath: req.url });
  res.send(R.notFoundPage(settings(), pageOpts(req)), 404);
}

app.get('/', (req, res) => {
  trackPage(req, res, '/');
  res.send(R.homePage(settings(), db, pageOpts(req, { category: req.query.category, q: req.query.q })));
});

app.get('/product/:id', (req, res) => {
  const product = db.visibleProduct(req.params.id);
  if (!product) return sendNotFound(req, res);
  trackPage(req, res, '/product/' + product.id);
  // Отзывы этого посетителя, ещё не прошедшие модерацию: их видит только он сам
  const mine = Array.isArray(req.session && req.session.myReviews) ? req.session.myReviews : [];
  // Ищем по индексу товара, а не по всему файлу: на боевых данных это 300 записей
  // вместо 7000 на каждое открытие страницы любым, кто когда-то оставил отзыв.
  const ownReviews = mine.length
    ? db.reviewsForProduct(product.id, false).filter(rv => rv.status !== 'approved' && mine.includes(rv.id))
    : [];
  res.send(R.productPage(settings(), db, product, pageOpts(req, {
    ownReviews,
    // Без JS «Показать ещё» — обычная ссылка на следующую страницу отзывов.
    reviewSort: req.query.rsort, reviewPage: req.query.rpage
  })));
});

app.get('/checkout', (req, res) => {
  trackPage(req, res, '/checkout');
  const returned = String(req.query && req.query.returned || '');
  const notice = returned === 'edit'
    ? 'Заказ снят с оплаты. Измените товары или данные и оформите его заново.'
    : returned === 'cancel'
      ? 'Заказ отменён. Товары и заполненные данные сохранены — при желании можно оформить новый.'
      : '';
  /* Какой заказ покупатель только что отменил на странице оплаты. Признак
   * ОДНОРАЗОВЫЙ и живёт в подписанной сессии, а не в адресе: по нему витрина
   * возвращает в корзину свой же снимок из localStorage (см. `Cart.hold` в
   * public/app.js), а второй раз возвращать нечего. */
  const restoreOrder = String(req.session.restoreOrder || '');
  if (restoreOrder) delete req.session.restoreOrder;
  // `payOnline` решает подпись кнопки: «Перейти к оплате» либо «Оформить заказ».
  res.send(R.checkoutPage(settings(), pageOpts(req, {
    restoreOrder,
    // `payOnline` решает подпись кнопки, и своими реквизитами покупатель платит
    // на нашей же странице — значит «Перейти к оплате» тоже.
    payOnline: (PAYMENTS.enabled(settings()) && !!paymentOrigin(req)) || PAYMENTS.ownEnabled(settings()),
    // Работают ли промокоды — единственное, что витрина знает о них заранее.
    // Какой именно применён, она спрашивает у `/api/cart` вместе с ценами:
    // держать это в разметке значило бы завести второй источник правды о
    // скидке, а он разошёлся бы с ценами на первой же правке в панели.
    promoOn: PROMO.enabled(settings()),
    notice
  })));
});

/* Отслеживание посылки.
 *
 * Трек-номера нет: посылку ведёт менеджер, и ссылку на её путь он отправляет
 * покупателю сам. Поэтому страница ОТКРЫТА — её открывают с телефона, с чужого
 * компьютера, из переписки, где никакой cookie магазина нет и быть не может, —
 * но открывается она по СЕКРЕТНОМУ КЛЮЧУ, а не по номеру заказа.
 *
 * Раньше ключом был номер, и это была дыра: он шестизначный, то есть
 * перебирается целиком, а подобравший узнал бы не только чужую посылку, но и
 * сколько у магазина отправок и куда они едут. Ограничение частоты от такого не
 * спасает — перебор раскладывается по адресам. Поиска по номеру здесь больше
 * нет вовсе, и формы для него на витрине тоже.
 *
 * Что остаётся защитой сверх ключа:
 *   - на странице нет ни имени, ни телефона, ни состава заказа, ни адреса
 *     покупателя — только перевозчик, города и путь (см. `trackingBoard`).
 *     Адрес пункта выдачи добавляется, только когда заказ узнан по подписанной
 *     cookie-сессии, то есть своему покупателю;
 *   - «ссылка не та» и «отправление ещё не собрано» отвечают ОДИНАКОВО: чужому
 *     не рассказываем, существует ли заказ вообще.
 *
 * В метрике страница не считается — как и страница оплаты: это служебная
 * страница заказа, а не витрина.
 */
app.get('/track', (req, res) => {
  /* Без ключа — «мои посылки»: отправления заказов из подписанной cookie-сессии.
   * Своему покупателю ссылка не нужна вовсе, а чужому эта страница не покажет
   * ничего. */
  const ids = Array.isArray(req.session && req.session.myOrders) ? req.session.myOrders : [];
  const orders = ids
    .map(id => db.getOrder(String(id || '')))
    .filter(o => o && !db.isOrderArchived(o) && o.shipment);
  res.send(R.trackingPage(settings(), pageOpts(req, { orders })));
});

app.get('/track/:token', (req, res) => {
  const token = String(req.params.token || '');
  /* Ключ 128-битный, перебирать его бессмысленно, но частоту всё равно
   * ограничиваем — от переборщика, который ещё не понял этого. Ответ тот же,
   * что у ненайденной посылки, а не 429: обычный покупатель, обновивший
   * страницу десяток раз, не должен упереться в стену. */
  const flood = rateLimited(req, 'track', 60, 5 * 60 * 1000);
  const order = flood ? null : db.getOrderByTrackToken(token);
  const mine = Array.isArray(req.session && req.session.myOrders) ? req.session.myOrders : [];
  res.send(R.trackingPage(settings(), pageOpts(req, {
    token,
    // Удалённый заказ отслеживать нечего: для покупателя он закрыт так же, как
    // на странице оплаты.
    order: order && !db.isOrderArchived(order) ? order : null,
    own: !!order && mine.includes(order.id)
  })));
});

// Правовые страницы: у всех одна обвязка и один вид, отличается только текст.
for (const [route, page] of [
  ['/privacy', R.privacyPage],
  ['/personal-data-consent', R.personalDataConsentPage],
  ['/personal-data-publication-consent', R.publicationConsentPage],
  ['/warranty', R.warrantyPage],
  ['/returns', R.returnsPage]
]) {
  app.get(route, (req, res) => {
    trackPage(req, res, route);
    res.send(page(settings(), pageOpts(req)));
  });
}

// Собственная метрика запускается автоматически при первом открытии страницы.
app.post('/api/analytics/start', (req, res) => {
  if (rateLimited(req, 'analytics-start', 120, 10 * 60 * 1000)) return res.json({ ok: false }, 429);
  const publicPath = metricPublicPath(req.body.path);
  const optedOut = metrics.trackingDisabled(req);
  const explicitEnable = consentAccepted(req.body.enableTracking);
  // Cookie отказа — серверная гарантия, а не только подсказка клиентскому JS.
  // Повторное включение допускается лишь после явного нажатия на странице политики.
  if (optedOut && !explicitEnable) return res.json({ ok: true, tracking: false });
  if (!publicPath) return res.json({ ok: true });
  const context = Object.assign(metrics.context(req, clientIp(req), cloudflareTrusted(req)), clientDetails(req.body.client));
  // Первичный HTML-запрос такого робота уже записан сервером. Его вызов
  // клиентского endpoint не должен ни удваивать статистику, ни ставить cookie.
  if (context.isBot) return res.json({ ok: true });
  let id = metrics.visitorId(req);
  if (!id) id = metrics.newVisitorId();
  const secure = originOf(req).startsWith('https://');
  const setCookies = [metrics.cookieHeader(id, secure)];
  if (optedOut && explicitEnable) setCookies.push(metrics.clearOptOutCookieHeader(secure));
  res.setHeader('Set-Cookie', setCookies);
  metrics.recordPageView({ id, path: publicPath, host: req.headers.host, referrer: req.body.referrer, context });
  res.json({ ok: true });
});

app.post('/api/analytics/ping', (req, res) => {
  if (rateLimited(req, 'analytics-ping', 180, 10 * 60 * 1000)) {
    res.writeHead(429, { 'Cache-Control': 'private, no-store' });
    return res.end();
  }
  const id = metrics.visitorId(req);
  if (id) metrics.heartbeat({ id, path: req.body.path, context: metrics.context(req, clientIp(req), cloudflareTrusted(req)) });
  res.writeHead(204, { 'Cache-Control': 'private, no-store' });
  res.end();
});

app.post('/api/analytics/withdraw', (req, res) => {
  const id = metrics.visitorId(req);
  if (id) metrics.removeVisitor(id);
  const secure = originOf(req).startsWith('https://');
  res.setHeader('Set-Cookie', [metrics.clearCookieHeader(secure), metrics.optOutCookieHeader(secure)]);
  res.json({ ok: true });
});

app.get('/robots.txt', (req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
  // Панель, оплата и оформление заказа в индексе не нужны: это личные страницы
  // и формы, а их адреса иначе попадали в выдачу через страницу входа.
  res.end(`User-agent: *\nAllow: /\nDisallow: /admin\nDisallow: /checkout\nDisallow: /pay/\nDisallow: /api/\nSitemap: ${originOf(req)}/sitemap.xml\n`);
});
// Браузеры запрашивают favicon автоматически. Это не посещение и не ошибка
// сканера, поэтому отвечаем без содержимого и не добавляем запрос в метрику.
app.get('/favicon.ico', (req, res) => {
  res.writeHead(204, { 'Cache-Control': 'public, max-age=86400' });
  res.end();
});
app.get('/sitemap.xml', (req, res) => {
  const origin = originOf(req);
  // Главная и правовые страницы; /checkout и /pay в карту не идут — они закрыты
  // и в robots.txt. Список публичных страниц общий с метрикой.
  const urls = ['<url><loc>' + R.esc(origin) + '/</loc><changefreq>daily</changefreq></url>'];
  for (const page of PUBLIC_PAGES) {
    if (page !== '/' && page !== '/checkout') urls.push('<url><loc>' + R.esc(origin) + R.esc(page) + '</loc></url>');
  }
  for (const category of db.visibleCategories()) {
    urls.push('<url><loc>' + R.esc(origin) + '/?category=' + encodeURIComponent(category) + '</loc><changefreq>weekly</changefreq></url>');
  }
  for (const p of db.visibleProducts()) urls.push('<url><loc>' + R.esc(origin) + '/product/' + R.esc(p.id) + '</loc></url>');
  res.writeHead(200, { 'Content-Type': 'application/xml; charset=utf-8' });
  res.end('<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">' + urls.join('') + '</urlset>');
});

// Догрузка отзывов на странице товара: разметка карточки живёт в render.js,
// поэтому сервер отдаёт готовый HTML порции — витрине остаётся его вставить.
app.get('/api/reviews', (req, res) => {
  if (rateLimited(req, 'reviews-page', 120, 60 * 1000)) return res.json({ ok: false, error: 'Слишком часто. Попробуйте позже.' }, 429);
  const product = db.visibleProduct(req.query.productId);
  if (!product) return res.json({ ok: false, error: 'Товар не найден' }, 404);
  const slice = R.reviewsSlice(db.reviewsForProduct(product.id, true), req.query.sort, req.query.page);
  res.json({
    ok: true, html: slice.html, pager: R.reviewsPager(slice, '/product/' + encodeURIComponent(product.id)),
    sort: slice.sort, page: slice.page, pages: slice.pages, total: slice.total
  });
});

// Отзыв посетителя уходит в каталог на модерацию.
app.post('/api/reviews', async (req, res) => {
  if (rateLimited(req, 'review', 5, 10 * 60 * 1000)) return res.json({ ok: false, error: 'Слишком часто. Попробуйте позже.' }, 429);
  const p = db.visibleProduct(req.body.productId);
  if (!p) return res.json({ ok: false, error: 'Товар не найден' }, 400);
  if (!consentAccepted(req.body.privacyAccepted)) return res.json({ ok: false, error: 'Подтвердите согласие на обработку персональных данных' }, 400);
  if (!consentAccepted(req.body.publicationAccepted)) return res.json({ ok: false, error: 'Подтвердите согласие на публикацию отзыва' }, 400);
  if (!String(req.body.author || '').trim()) return res.json({ ok: false, error: 'Укажите имя' }, 400);
  // Именно Number.isInteger: без него пропущенная оценка давала NaN, а сравнения
  // NaN < 1 и NaN > 5 оба ложны — отзыв проходил проверку и молча получал 5 звёзд.
  const rating = Number(req.body.rating);
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) return res.json({ ok: false, error: 'Укажите оценку от 1 до 5' }, 400);
  // Снимки покупателя: предел свой, меньше панельного — здесь грузит кто угодно,
  // а один файл может весить до 6 МБ. Превью делаем сразу, как и в панели: в
  // ленте показывается именно оно, полный файл — только в просмотрщике.
  const photos = await optimizeUploads(req.filesFor('photos').slice(0, R.REVIEW_PHOTOS_MAX), 1400);
  const review = db.createReview({
    productId: p.id, author: req.body.author, rating, text: req.body.text,
    photos, previews: await reviewPreviews(photos), status: 'pending',
    privacyConsentAt: Date.now(), privacyConsentVersion: R.PRIVACY_VERSION,
    publicationConsentAt: Date.now(), publicationConsentVersion: R.PRIVACY_VERSION
  });
  // Автор видит свой отзыв на странице товара сразу — id складываем в его же
  // подписанную cookie-сессию. Для всех остальных отзыв появится только после
  // одобрения в панели: db.reviewsForProduct(id, true) отдаёт лишь approved.
  const mine = Array.isArray(req.session && req.session.myReviews) ? req.session.myReviews : [];
  req.session = Object.assign({}, req.session || {}, { myReviews: mine.concat(review.id).slice(-30) });

  const s = settings();
  if (s.notifyReviews) {
    sendTelegram(s, `📝 <b>Новый отзыв на модерации</b>\nТовар: ${tgEsc(p.name)}\nАвтор: ${tgEsc(review.author)}\nОценка: ${'★'.repeat(review.rating)}\n${review.text ? tgEsc(review.text) : ''}`).catch(() => {});
  }
  /* В панель карточка уходит ВСЕГДА, а не только при `notifyReviews`: та
   * галочка — про Telegram, то есть про то, будить ли владельца ночью. Открытая
   * панель никого не будит, а отзыв ждёт модерации в любом случае. */
  LIVE.note(A.noteReview(s, db, review));
  res.json({ ok: true, message: 'Спасибо за отзыв!' });
});

// Актуальные данные корзины. Корзина хранит только то, что было в момент
// добавления: у позиций, добавленных давно, нет фото, а цена могла измениться.
// Здесь сервер отдаёт по каждой позиции нынешние название, цену, фото и наличие.
app.post('/api/cart', (req, res) => {
  if (rateLimited(req, 'cart', 180, 10 * 60 * 1000)) return res.json({ ok: false }, 429);
  // Настройки нужны ради плавающих цен: период и разброс задаёт владелец.
  const s = settings();
  /* Промокод покупателя. Он приходит с каждым запросом корзины, а не лежит в
   * сессии: цены считает сервер, и решать, с каким кодом их считать, обязан тот
   * же запрос, который их спрашивает. Полей нет вовсе (старая вкладка) — код по
   * умолчанию, то есть ровно те цены, что стоят на карточках.
   */
  const promoChoice = PROMO.choiceFrom(req.body);
  const promo = PROMO.stateOf(s, promoChoice);
  const raw = Array.isArray(req.body.items) ? req.body.items.slice(0, 100) : [];
  const items = raw.map(it => {
    if (!it || typeof it !== 'object') return null;
    const view = db.visibleProduct(it.id);
    if (!view) return { id: String(it.id || ''), gone: true };
    const storage = String(it.storage || '').trim();
    const color = String(it.color || '').trim();
    const st = storage && Array.isArray(view.storages) ? view.storages.find(x => x.label === storage) : null;
    const cl = color && Array.isArray(view.colors) ? view.colors.find(x => x.name === color) : null;
    const bandStr = String(it.band || '').trim();
    const bandSize = String(it.bandSize || '').trim();
    const band = findBand(view, bandStr);
    const sz = band && bandSize ? (band.group.sizes || []).find(x => x.label === bandSize) : null;
    // фото: снимок этого ремешка на этом корпусе → просто этого ремешка →
    // цвета корпуса → первое общее. Тот же порядок, что в галерее товара.
    const ibs = view.imageBands || {}, ics = view.imageColors || {};
    const bandKey = band ? band.group.name + '|' + band.option.name : '';
    const byBand = bandKey
      ? ((view.images || []).find(src => ibs[src] === bandKey && ics[src] === color)
        || (view.images || []).find(src => ibs[src] === bandKey && !ics[src])) : null;
    const byColor = color
      ? (view.images || []).find(src => ics[src] === color && !ibs[src]) : null;
    // Доп. характеристики: доплата за каждое выбранное значение
    const chosen = findOptions(view, it);
    const adds = (st ? Number(st.add) || 0 : 0)
      + (band ? Number(band.option.add) || 0 : 0) + (sz ? Number(sz.add) || 0 : 0)
      + optionsAdd(chosen);
    // Цена текущего периода (lib/price-float.js), а не число из каталога: в
    // корзине покупатель обязан видеть ровно то, что стояло на карточке.
    const sum = PF.priceOf(view, s) + adds;
    /* Цена для сравнения — та же, что зачёркнута на карточке и на странице
      * товара, и считается ТЕМ ЖЕ способом: процент скидки товара от ПОЛНОЙ
      * цены сборки. Поэтому выгода в процентах у любой сборки одна и та же, а
      * в рублях у дорогой она больше — так скидка и работает.
      *
      * Ноль означает «зачёркивать нечего»: у товара без скидки сравнивать не с чем.
      *
      * Промокод меняет обе цифры разом (lib/promo.js): снятый код поднимает цену
      * до полной и зачёркивать становится нечего, а код со своим процентом
      * считает скидку от той же полной цены.
      */
    const priced = PROMO.priceFor(sum, D.discountPct(view), promo);
    const price = priced.price, compare = priced.compare;
    const outOfStock = !view.inStock || (st && st.inStock === false) || (cl && cl.inStock === false)
      || (band && band.option.inStock === false)
      || (band && band.option.forColor && band.option.forColor !== color)
      || chosen.some(c => c.value && (c.value.inStock === false || !optionFits(c.value, storage, choiceMap(chosen))))
      // Конфигурация тоже бывает привязана к выбору: 8 ТБ у MacBook Pro есть
      // только с M5 Max. Проверяем на сервере — корзина могла собраться раньше.
      || (st && !optionFits(st, storage, choiceMap(chosen)))
      || variantMissing(view, it);
    return {
      id: view.id, name: view.name, storage, color, price, compare,
      band: band ? bandStr : '', bandSize: band ? bandSize : '',
      img: byBand || byColor || (view.images || [])[0] || '',
      available: !outOfStock
    };
  }).filter(Boolean);
  /* Состояние промокода едет рядом с ценами, а не отдельным запросом: витрина
   * рисует строку на оформлении по ответу сервера, и цены с этой строкой
   * обязаны приехать вместе. Иначе покупатель увидел бы «промокод SALE
   * применён» рядом с ценами, посчитанными без него.
   */
  res.json({ ok: true, items, promo: PROMO.view(s, promoChoice) });
});

/* Применить промокод или снять его.
 *
 * Отдельный маршрут нужен ровно затем, чтобы сказать «такого кода нет»: цены
 * витрина всё равно перезапросит у `/api/cart`, а вот отличить опечатку от
 * сработавшего кода по одним ценам нельзя.
 *
 * Ответ — та же строка состояния, что и у корзины (`PROMO.view`): двух разных
 * ответов об одном коде быть не должно.
 */
app.post('/api/promo', (req, res) => {
  // Перебор кодов — единственный способ узнать чужой, поэтому лимит строже
  // корзинного: сорок попыток за десять минут хватает человеку с опечатками и
  // не хватает перебору по словарю.
  if (rateLimited(req, 'promo', 40, 10 * 60 * 1000)) {
    return res.json({ ok: false, error: 'Слишком много попыток. Попробуйте через несколько минут.' }, 429);
  }
  const s = settings();
  if (!PROMO.enabled(s)) return res.json({ ok: false, error: 'Промокоды сейчас не работают' });
  const choice = PROMO.choiceFrom(req.body);
  // Снятие кода не проверяем вовсе: убрать скидку покупатель вправе всегда.
  if (choice && choice.off) return res.json({ ok: true, promo: PROMO.view(s, choice) });
  const typed = PROMO.normCode(req.body && req.body.promoCode);
  if (!typed) return res.json({ ok: false, error: 'Введите промокод' });
  // Про выключенный код и про несуществующий отвечаем одинаково: чужой код
  // подбирают по разнице в ответах.
  //
  // Состояния при отказе не отдаём вовсе — витрина остаётся с тем, что у неё
  // уже есть: иначе опечатка снявшего скидку покупателя молча возвращала бы ему
  // код по умолчанию.
  if (!PROMO.byCode(s, typed)) return res.json({ ok: false, error: 'Такого промокода нет' });
  res.json({ ok: true, promo: PROMO.view(s, { code: typed }) });
});

// Подсказки адреса для поля на оформлении заказа. Ключ dadata.ru лежит в
// настройках владельца и на витрину не попадает — браузер спрашивает нас,
// а в DaData ходит сервер. Не настроен ключ — поле просто без подсказок.
app.post('/api/address-suggest', async (req, res) => {
  if (rateLimited(req, 'suggest', 90, 60 * 1000)) return res.json({ ok: false, items: [] }, 429);
  const q = String(req.body && req.body.q || '').trim().slice(0, 300);
  if (q.length < 3) return res.json({ ok: true, items: [] });
  const r = await suggestAddress(db.getSettings().dadataToken, q, 7);
  // configured отделяет «ключа нет» от временной ошибки: в первом случае витрине
  // незачем спрашивать снова, во втором следующий запрос может пройти.
  res.json({ ok: r.ok, configured: r.reason !== 'not_configured', items: r.items });
});

/* Проверка адреса и стоимость доставки для оформления. Считает ТОТ ЖЕ модуль,
 * что и /api/order, поэтому цифра в сводке и цифра в заказе совпадают по
 * построению — своя сетка в скрипте разъехалась бы с серверной, как разъехался
 * бы свой список способов.
 *
 * Полноту адреса тоже проверяет сервер, а не витрина: витрина по этому ответу
 * лишь отпирает выбор способа доставки. Своя проверка в скрипте пропускала бы
 * адрес, который сервер потом отвергает, — и покупатель узнавал бы об этом уже
 * нажав «Оформить заказ».
 *
 * Внешних запросов здесь нет вовсе: зона определяется по строке адреса, тариф
 * берётся из таблицы. Поэтому запрос дешёвый, и витрина шлёт его на каждую
 * правку адреса.
 *
 * `total` приходит от витрины и на цену товаров не влияет — он нужен только для
 * подгонки итога под круглое число. Настоящую сумму /api/order считает сам.
 */
app.post('/api/delivery/quote', (req, res) => {
  if (rateLimited(req, 'ship', 120, 60 * 1000)) return res.json({ ok: false }, 429);
  const goods = Number(req.body && req.body.total);
  const address = String(req.body && req.body.address || '').slice(0, 400);
  const check = ADDRESS.checkAddress(address);
  // Неполный адрес — не ошибка запроса: витрина спрашивает цену на каждой
  // правке поля, и половина этих строк заведомо недописана. Отвечаем разбором.
  if (!check.ok) return res.json({ ok: true, valid: false, error: check.error, prices: null, days: null });
  // Цены отдаём сразу все: покупатель должен видеть, во что обойдётся курьер,
  // ДО того как выберет его, а переключение способа не должно ходить на сервер.
  // Потолок заказа приходит из настроек: подгонка итога под круглое число не
  // вправе вывести сумму за границу, которую касса уже не проведёт.
  const q = SHIP.quoteAll(address, Number.isFinite(goods) && goods > 0 ? goods : 0,
    PAYMENTS.limits(settings()).max);
  // Срок едет рядом с ценой и той же зоной: «сколько ждать» — второй вопрос
  // после «сколько стоит», и на выбор между пунктом выдачи и курьером он влияет
  // не меньше. Текст собирает сервер (lib/delivery-days.js) — своя вилка со
  // своим склонением в скрипте разошлась бы с серверной молча.
  res.json({
    ok: true, valid: true, error: '', zone: q.zone, zoneName: q.zoneName,
    prices: q.prices, days: SHIPDAYS.textAll(q.zone)
  });
});

/* Ближайшие пункты выдачи по адресу покупателя. Отдельным запросом, а не вместе
 * с ценой: цена нужна на каждую правку адреса, а список пунктов — только когда
 * выбран вариант «в пункт выдачи», и меняется он ещё и при смене перевозчика.
 *
 * Наружу этот запрос не ходит НИКУДА: база пунктов лежит на диске и обновляется
 * ночью (lib/pickup.js). Поэтому адрес покупателя не уезжает ни в какой чужой
 * сервис ради подсказки, а ответ считается за сотые доли миллисекунды.
 *
 * Координаты приходят от подсказки dadata.ru, которую покупатель выбрал сам;
 * без них ищем по названию города — тогда расстояние не показываем вовсе.
 */
app.post('/api/delivery/points', (req, res) => {
  if (rateLimited(req, 'points', 120, 60 * 1000)) return res.json({ ok: false, items: [] }, 429);
  const method = String(req.body && req.body.method || '');
  // Чужой перевозчик — пустой список, а не ошибка: список способов на витрине
  // мог устареть, и оформление из-за этого падать не должно.
  if (!DELIVERY.isValid(method)) return res.json({ ok: true, items: [] });
  const items = PICKUP.nearest(method, {
    address: String(req.body && req.body.address || '').slice(0, 400),
    lat: Number(req.body && req.body.lat),
    lon: Number(req.body && req.body.lon)
  });
  /* У OZON своего списка пунктов нет, и точки берутся из OpenStreetMap плитками
   * по 0,1° вокруг покупателя (lib/pickup-osm.js). Обновление плитки НЕ ЖДЁМ:
   * отдаём то, что уже в базе, и помечаем ответ `refreshing` — по нему витрина
   * переспросит через несколько секунд. Заказ от чужого сервиса не зависит.
   */
  const refreshing = method === 'ozon'
    && OSM.ensureTile(Number(req.body && req.body.lat), Number(req.body && req.body.lon));
  // `ready` отделяет «у нас нет списка этого перевозчика» от «рядом ничего не
  // нашлось». Без него покупателю, чьей базы у нас нет вовсе, витрина сообщала
  // бы, что пунктов рядом нет, — а это неправда.
  res.json({ ok: true, ready: PICKUP.has(method), refreshing, items });
});

// Заказ -> цена считается по ценам сайта, заявка в Telegram этого сайта
// Уведомление менеджеру о новом заказе. Общее для двух путей: заявки без
// онлайн-оплаты (уходит сразу) и черновика, который стал заказом после выбора
// способа оплаты. Собирается из самого заказа, чтобы не тащить за собой
// замыкание маршрута.
function notifyNewOrder(order) {
  const ss = settings();
  const lines = (order.items || []).map(i => `• ${tgEsc(i.name)} — ${i.qty} × ${R.money(i.price, ss)}`).join('\n');
  const msg = `🛒 <b>Новый заказ ${tgEsc(R.orderNo(order.number))}</b>\n`
    // Телефон — первым: по нему менеджер и звонит. Прежние заявки телефона не
    // имеют вовсе, у них остаётся только строка контакта.
    + `👤 Получатель: ${tgEsc(order.customerName) || '—'}\n`
    + (order.phone ? `📞 Телефон: ${tgEsc(R.phoneText(order.phone))}\n` : '')
    + (order.contact ? `✉️ Ещё контакт: ${tgEsc(order.contact)}\n` : '')
    + (order.delivery ? `🚚 Доставка: ${tgEsc([DELIVERY.nameOf(order.delivery), DELIVERY.shortModeOf(order.delivery, order.deliveryMode)].filter(Boolean).join(', '))}`
      + `${order.deliveryPrice ? ` — ${R.money(order.deliveryPrice, ss)}` : ''}\n` : '')
    // Куда везти и с кем связываться — две разные строки: у заказа в пункт
    // выдачи адрес покупателя тоже есть, но посылка едет не туда.
    + (order.pickupAddress
      ? `📦 Пункт выдачи: ${order.pickupCode ? tgEsc(order.pickupCode) + ' — ' : ''}${tgEsc(order.pickupAddress)}\n` : '')
    + (order.address ? `📍 Адрес покупателя: ${tgEsc(order.address)}\n` : '')
    + `🌍 Город: ${tgEsc([order.clientCity, order.clientRegion, order.clientCountry].filter(Boolean).join(', ')) || 'не определён'}\n`
    + `💻 Устройство: ${tgEsc([order.clientModel || order.clientDevice, order.clientOs, order.clientBrowser].filter(Boolean).join(' · ')) || 'не определено'}\n`
    + `🌐 IP: ${tgEsc(order.clientIp) || 'не определён'}\n`
    + (order.comment ? `💬 ${tgEsc(order.comment)}\n` : '')
    // Промокод — рядом с деньгами, а не в шапке: он объясняет итог, а не
    // покупателя. Без выгоды строка бессмысленна, поэтому её тогда и нет.
    + (order.promoCode ? `🏷 Промокод: ${tgEsc(order.promoCode)}`
      + `${order.promoDiscount ? ` — выгода ${R.money(order.promoDiscount, ss)}` : ''}\n` : '')
    + `\n${lines}\n\n<b>Итого: ${R.money(order.total, ss)}</b>`;
  sendTelegram(ss, msg).catch(() => {});
  // И карточкой в открытую панель. Та же дверь, что у Telegram: два разных места
  // с уведомлением о заказе рано или поздно разошлись бы в том, какая заявка
  // считается новой (черновик заказом ещё не является).
  LIVE.note(A.noteOrder(ss, db, order));
}

// После отказа кассы покупатель часто возвращается на оформление и нажимает
// кнопку ещё раз. Его подписанная сессия уже знает прежний заказ; если весь
// нормализованный заказ совпадает, переиспользуем его вместо дубля и возвращаем
// на ту же страницу оплаты. Изменился хоть один товар, контакт, адрес или тариф
// — это уже новый заказ.
const ORDER_REUSE_TTL = 24 * 60 * 60 * 1000;

// Отпечаток запроса оформления не содержит серверных цен: его задача — узнать
// повтор ТОГО ЖЕ нажатия после потерянного ответа. Позиции и дополнительные
// параметры сортируются, поэтому перестановка строк в localStorage не превращает
// тот же заказ в другой.
function checkoutRequestHash(body) {
  const b = body && typeof body === 'object' ? body : {};
  const items = (Array.isArray(b.items) ? b.items : []).slice(0, 101).map(it => {
    const x = it && typeof it === 'object' ? it : {};
    const options = (Array.isArray(x.options) ? x.options : []).slice(0, 41)
      .map(o => ({ name: String(o && o.name || '').trim(), value: String(o && o.value || '').trim() }))
      .sort((a, c) => JSON.stringify(a).localeCompare(JSON.stringify(c)));
    return {
      id: String(x.id || ''), qty: String(x.qty == null ? '' : x.qty),
      price: String(x.price == null ? '' : x.price),
      storage: String(x.storage || ''), color: String(x.color || ''),
      band: String(x.band || ''), bandSize: String(x.bandSize || ''), options
    };
  }).sort((a, c) => JSON.stringify(a).localeCompare(JSON.stringify(c)));
  const shape = {
    items,
    firstName: String(b.firstName || '').trim(), lastName: String(b.lastName || '').trim(),
    phone: String(b.phone || '').trim(), contact: String(b.contact || '').trim(),
    address: String(b.address || '').trim(), delivery: String(b.delivery || '').trim(),
    deliveryMode: String(b.deliveryMode || '').trim(), pickupCode: String(b.pickupCode || '').trim(),
    // Промокод меняет цены, а значит и заказ: два запроса с одним ключом, но
    // разными кодами — это разные заказы, а не потерянный ответ на один и тот
    // же. У товара без скидки цены совпали бы, и без этих двух полей повтор
    // вернул бы заказ с чужим кодом в карточке.
    promoCode: PROMO.normCode(b.promoCode), promoOff: b.promoOff === true ? '1' : ''
  };
  return crypto.createHash('sha256').update(JSON.stringify(shape)).digest('hex');
}

function rememberOwnOrder(req, order) {
  const mine = Array.isArray(req.session.myOrders) ? req.session.myOrders : [];
  req.session.myOrders = [order.id].concat(mine.filter(id => id !== order.id)).slice(0, 20);
}

function orderApiBody(order, reused) {
  // `pay` — вести ли покупателя на страницу оплаты. Своими реквизитами платят
  // там же, поэтому режим `own` ведёт туда наравне с кассой.
  const pay = !!(order && (order.draft || order.payment || order.payMode === 'own'));
  return {
    ok: true, reused: !!reused, id: order.id, number: order.number,
    total: order.total, itemsTotal: order.itemsTotal,
    delivery: { price: order.deliveryPrice, zone: order.deliveryZone },
    // Корзину витрина чистит по этому полю: у ЧЕРНОВИКА товары обязаны
    // остаться (способ ещё не выбран), а у настоящего заказа — уехать.
    pay, draft: !!(order && order.draft), telegram: reused ? 'already_queued' : 'queued'
  };
}

function reusableOrder(req, data) {
  const mine = Array.isArray(req.session.myOrders) ? req.session.myOrders : [];
  const scalars = [
    'total', 'itemsTotal', 'firstName', 'lastName', 'phone', 'contact', 'address',
    'delivery', 'deliveryMode', 'deliveryPrice', 'deliveryZone', 'pickupCode', 'pickupAddress', 'comment',
    // Промокод — часть заказа: сменил его покупатель, и это уже другой заказ,
    // даже если сумма случайно совпала.
    'promoCode'
  ];
  const itemKey = items => JSON.stringify((items || []).map(item => ({
    id: item.id, name: item.name, price: item.price, qty: item.qty
  })).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))));
  const now = Date.now();
  for (const id of mine) {
    const order = db.getOrder(id);
    const pay = order && order.payment;
    const age = order ? now - Number(order.createdAt || 0) : NaN;
    if (!order || !Number.isFinite(age) || age < 0 || age >= ORDER_REUSE_TTL) continue;
    if (db.isOrderArchived(order)) continue;
    if (pay && (pay.status === 'paid' || pay.status === 'mismatch')) continue;
    if (!order.draft && !pay) continue;       // обычная уже принятая заявка, не платёжный повтор
    if (scalars.some(key => String(order[key] == null ? '' : order[key]) !== String(data[key] == null ? '' : data[key]))) continue;
    if (itemKey(order.items) !== itemKey(data.items)) continue;
    return order;
  }
  return null;
}

app.post('/api/order', async (req, res) => {
  // Настройки читаем один раз на весь маршрут: от них зависят и цены товаров
  // (плавающие, см. lib/price-float.js), и пределы касс, и режим витрины.
  const s = settings();
  const checkoutRequestId = String(req.body && req.body.requestId || '');
  if (!/^[a-f0-9]{32}$/.test(checkoutRequestId)) {
    return res.json({ ok: false, errorCode: 'bad_request_id', error: 'Обновите страницу оформления и попробуйте ещё раз' }, 400);
  }
  const requestHash = checkoutRequestHash(req.body);
  const replay = db.getOrderByCheckoutRequest(checkoutRequestId);
  if (replay) {
    if (replay.checkoutRequestHash !== requestHash) {
      return res.json({ ok: false, errorCode: 'idempotency_conflict', error: 'Данные заказа изменились. Обновите страницу и повторите оформление.' }, 409);
    }
    rememberOwnOrder(req, replay);
    return res.json(orderApiBody(replay, true));
  }

  // Идемпотентный повтор уже записанного заказа проходит ДО лимита: потерянный
  // ответ обязан восстановиться даже после нескольких сетевых ретраев. Новые
  // ключи по-прежнему ограничены сессией и широким IP-лимитом.
  const buyerRateId = anonymousSessionId(req);
  if (rateLimited(req, 'order', 10, 10 * 60 * 1000, buyerRateId)
    || rateLimited(req, 'order-ip', 120, 10 * 60 * 1000)) {
    return res.json({ ok: false, error: 'Слишком часто. Попробуйте позже.' }, 429);
  }

  const sourceItems = Array.isArray(req.body.items) ? req.body.items : [];
  if (sourceItems.length > 100) {
    return res.json({ ok: false, errorCode: 'cart_changed', error: 'В корзине слишком много разных позиций. Обновите корзину.', changes: [{ reason: 'too_many' }] }, 409);
  }
  const rawItems = sourceItems.slice(0, 100);
  /* Промокод покупателя — тот же разбор, что и в корзине. Считать по нему цены
   * обязан сервер: витрина присылает цену, которую видела, но проверяет её тот
   * же расчёт, что её и выдал (`PROMO.priceFor`).
   */
  const promo = PROMO.stateOf(s, PROMO.choiceFrom(req.body));
  const items = []; const changes = []; let total = 0;
  // Сколько промокод дал выгоды в рублях — сумма по позициям. Уезжает в заказ:
  // менеджеру видно, чем покупатель платил меньше, а витрине — что показать в
  // строке «Промокод».
  let promoSaved = 0;
  const changed = (it, reason, name, price) => {
    const row = { id: String(it && it.id || ''), reason, name: String(name || it && it.id || 'Товар').slice(0, 160) };
    if (Number.isFinite(Number(price)) && Number(price) >= 0) row.price = Number(price);
    changes.push(row);
  };
  for (const it of rawItems) {
    if (!it || typeof it !== 'object') { changed(it, 'invalid'); continue; }
    const view = db.visibleProduct(it.id);
    if (!view) { changed(it, 'gone'); continue; }
    if (!view.inStock) { changed(it, 'out_of_stock', view.name); continue; }
    // Выбранного варианта больше нет в каталоге — заявку по базовой цене
    // вместо него не оформляем.
    if (variantMissing(view, it)) { changed(it, 'variant_changed', view.name); continue; }
    const rawQty = Number(it.qty);
    if (!Number.isInteger(rawQty) || rawQty < 1 || rawQty > 99) {
      changed(it, 'quantity_changed', view.name); continue;
    }
    const qty = rawQty;
    // База текущего периода — и она же запоминается отдельно: ниже по ней
    // пересчитывается цена прошлого периода, если покупатель видел её.
    const base = PF.priceOf(view, s);
    // Собираем ЦЕНУ СБОРКИ — базу с доплатами. Промокод применяется один раз в
    // самом конце (`PROMO.priceFor`): он считает скидку от всей сборки, а не от
    // каждой доплаты по отдельности.
    let sum = base;
    let name = view.name;
    // Наличие варианта проверяем на сервере: корзина живёт в localStorage и могла
    // сохраниться до того, как цвет или конфигурацию распродали.
    const storageLabel = String(it.storage || '').trim();
    if (storageLabel && Array.isArray(view.storages)) {
      /* Имя переменной не `s`: снаружи так называются НАСТРОЙКИ магазина, от
       * которых здесь же считается цена (`PF.priceOf(view, s)`). Затенение было
       * безвредным ровно до первой новой строки внутри этого блока — а цена,
       * посчитанная по конфигурации памяти вместо настроек, поехала бы молча. */
      const storage = view.storages.find(x => x.label === storageLabel);
      if (storage && storage.inStock === false) { changed(it, 'out_of_stock', view.name + ' ' + storage.label); continue; }
      if (storage) { sum += Number(storage.add) || 0; name += ' ' + storage.label; }
    }
    const color = String(it.color || '').trim();
    if (color && Array.isArray(view.colors)) {
      const c = view.colors.find(x => x.name === color);
      if (c && c.inStock === false) { changed(it, 'out_of_stock', view.name + ', ' + c.name); continue; }
      if (c) name += ', ' + color;
    }
    // Ремешок часов: доплата за вариацию и за размер, наличие тоже перепроверяем
    const band = findBand(view, it.band);
    if (band) {
      if (band.option.inStock === false) { changed(it, 'out_of_stock', view.name + ', ' + band.option.name); continue; }
      // вариация «в цвет корпуса» продаётся только со своим корпусом
      if (band.option.forColor && band.option.forColor !== color) { changed(it, 'variant_changed', view.name); continue; }
      sum += Number(band.option.add) || 0;
      name += ', ' + band.group.name + ' \u00b7 ' + band.option.name;
      const sz = (band.group.sizes || []).find(x => x.label === String(it.bandSize || '').trim());
      if (sz) { sum += Number(sz.add) || 0; name += ' ' + sz.label; }
    }
    // Доп. характеристики: наличие и совместимость с конфигурацией перепроверяем
    // так же, как у ремешка, — корзина могла сохраниться до правки каталога.
    const chosen = findOptions(view, it);
    const picked = choiceMap(chosen);
    if (chosen.some(c => !c.value || c.value.inStock === false || !optionFits(c.value, storageLabel, picked))) {
      changed(it, 'variant_changed', view.name); continue;
    }
    // Конфигурация, привязанная к чипу (8 ТБ только с M5 Max), проверяется здесь же.
    const stPick = (view.storages || []).find(x => x.label === storageLabel);
    if (stPick && !optionFits(stPick, storageLabel, picked)) { changed(it, 'variant_changed', view.name); continue; }
    sum += optionsAdd(chosen);
    for (const c of chosen) name += ', ' + c.value.label;
    if (!Number.isFinite(sum) || sum < 0) { changed(it, 'price_changed', view.name); continue; }
    /* Промокод — последним действием над собранной ценой, ровно как в
     * `/api/cart`: тот же модуль, те же два числа. Своего расчёта здесь нет,
     * иначе корзина и заказ разошлись бы на первом же коде со своим процентом.
     */
    const priced = PROMO.priceFor(sum, D.discountPct(view), promo);
    let price = priced.price;
    let saved = Math.max(0, (priced.compare || 0) - price);
    // Цена из браузера — не источник истины, а снимок того, что покупатель видел.
    // Разошлась с сервером — не оформляем заказ молча, а просим подтвердить новый
    // итог. Старые открытые вкладки без поля price остаются совместимыми.
    if (it.price !== undefined && it.price !== null && it.price !== '') {
      const seenPrice = Number(it.price);
      const same = value => Number.isFinite(seenPrice) && Math.round(seenPrice * 100) === Math.round(value * 100);
      /* Цена ПРОШЛОГО периода тоже принимается, и это не послабление проверки.
       * Плавающие цены (lib/price-float.js) меняются по часам, а оформление
       * занимает минуты: покупатель, собравший корзину в 14:59 и нажавший
       * «Оформить» в 15:00, иначе получал бы «корзина изменилась» на ровном
       * месте — то есть подмену цены под руками там, где он ничего не менял.
       * Цену, которую он видел, за ним и держим — но ровно один период назад,
       * иначе старая вкладка покупала бы по вчерашней цене.
       */
      const prevBase = PF.previousOf(view, s);
      // Прошлый период считается ЧЕРЕЗ ТУ ЖЕ функцию: промокод со своим
      // процентом — не линейная надбавка, и «цена минус база плюс прошлая база»
      // дала бы не ту цифру, которую покупатель видел.
      const prev = PROMO.priceFor(sum - base + prevBase, D.discountPct(view), promo);
      if (!same(price) && prevBase !== base && same(prev.price)) {
        price = prev.price;
        saved = Math.max(0, (prev.compare || 0) - price);
      } else if (!same(price)) { changed(it, 'price_changed', name, price); continue; }
    }
    items.push({ id: view.id, name, price, qty });
    total += price * qty;
    promoSaved += saved * qty;
  }
  if (changes.length) {
    return res.json({
      ok: false, errorCode: 'cart_changed',
      error: 'Корзина изменилась. Мы обновили цены и наличие — проверьте итог и подтвердите заказ ещё раз.',
      changes: changes.slice(0, 100)
    }, 409);
  }
  if (!items.length) return res.json({ ok: false, error: 'В корзине нет доступных товаров' }, 400);
  if (!Number.isFinite(total) || total > 1e12) return res.json({ ok: false, error: 'Сумма заказа некорректна' }, 400);
  /* Телефон — обязателен и отдельным полем. По нему менеджер подтверждает
   * заказ, его же перевозчик ставит в накладную, и он единственный контакт,
   * который годится и для того, и для другого. Проверяет и приводит к
   * международному виду тот же модуль, что и витрина, — своей копии правил у
   * сервера нет, иначе форма приняла бы номер, который маршрут потом отверг.
   *
   * `contact` (Telegram или почта) остался, но стал НЕОБЯЗАТЕЛЬНЫМ: это
   * дополнительный канал, а не замена телефону. У всех прежних заявок он
   * единственный, и переписывать их незачем.
   */
  const phoneCheck = PHONE.check(req.body.phone);
  if (!phoneCheck.ok) return res.json({ ok: false, error: phoneCheck.error }, 400);
  const phone = phoneCheck.e164;
  const contact = String(req.body.contact || '').trim().slice(0, 120);
  // Получатель и доставка обязательны: заказ идёт с предоплатой и уезжает
  // перевозчиком, а не «уточним при подтверждении», как было у заявки.
  const firstName = String(req.body.firstName || '').trim().slice(0, 60);
  const lastName = String(req.body.lastName || '').trim().slice(0, 60);
  if (!firstName) return res.json({ ok: false, error: 'Укажите имя получателя' }, 400);
  if (!lastName) return res.json({ ok: false, error: 'Укажите фамилию получателя' }, 400);
  const delivery = String(req.body.delivery || '').trim();
  if (!DELIVERY.isValid(delivery)) return res.json({ ok: false, error: 'Выберите способ доставки' }, 400);
  const deliveryMode = String(req.body.deliveryMode || '').trim();
  if (!DELIVERY.isValidMode(delivery, deliveryMode)) return res.json({ ok: false, error: 'Выберите, куда доставить: в пункт выдачи или курьером' }, 400);
  /* Адрес ПОКУПАТЕЛЯ — его данные наравне с именем и контактом. Выбор пункта
   * выдачи его не меняет: по нему считается зона доставки, по нему же ищутся
   * ближайшие пункты, и по нему везёт курьер.
   *
   * Адрес обязан быть полным: населённый пункт, улица и дом. По «Екатеринбургу»
   * нельзя ни оформить накладную, ни посчитать доставку, а заказ уже оплачен.
   */
  const address = String(req.body.address || '').trim().slice(0, 400);
  if (!address) return res.json({ ok: false, error: 'Укажите адрес' }, 400);
  const addressCheck = ADDRESS.checkAddress(address);
  if (!addressCheck.ok) return res.json({ ok: false, error: addressCheck.error }, 400);

  /* Пункт выдачи — КУДА ЕДЕТ ПОСЫЛКА, отдельно от адреса покупателя. От витрины
   * приходит только код, а АДРЕС БЕРЁТСЯ ИЗ БАЗЫ: клиентской строке верим не
   * больше, чем клиентской цене, иначе в заказ уехал бы код одного пункта с
   * адресом другого. Своего адреса пункта витрина не присылает вовсе — выбрать
   * можно лишь то, что мы сами показали.
   *
   * Кода нет или пункт исчез из базы (закрылся между выбором и оформлением) —
   * отказ: заказ без адреса назначения оформить нельзя.
   */
  let pickupAddress = '';
  let point = null;
  if (deliveryMode === 'pvz') {
    point = PICKUP.findPoint(delivery, req.body.pickupCode);
    if (!point) return res.json({ ok: false, error: 'Выберите пункт выдачи' }, 400);
    pickupAddress = PICKUP.addressOf(point);
    const pickupCheck = ADDRESS.checkAddress(pickupAddress);
    if (!pickupCheck.ok) return res.json({ ok: false, error: pickupCheck.error }, 400);
  }

  /* Доставку считаем заново по своей сетке тарифов — ровно так же, как цену
   * товаров. Витрина показывала свою цифру, но она приходит от того же расчёта
   * (`/api/delivery/quote`), а не из скрипта, поэтому расходиться им не с чего.
   *
   * Зона берётся по адресу ПОКУПАТЕЛЯ, а не по адресу пункта выдачи, даже когда
   * посылка едет в пункт. Так цена не меняется от выбора пункта: покупатель
   * видит сумму до того, как выберет, и она обязана совпасть с той, что уйдёт в
   * заказ. Разойтись зоны почти не могут — дальше 60 км пункты не предлагаются,
   * а зоны здесь размером с федеральный округ.
   */
  // Настройки берём те же, что читались в начале маршрута: второй `settings()`
  // здесь означал бы второй источник правды о пределах кассы в одном заказе.
  const ship = SHIP.quote(delivery, deliveryMode, address, total, PAYMENTS.limits(s).max);
  if (!ship.ok) return res.json({ ok: false, error: 'Не удалось рассчитать доставку — выберите другой способ' }, 400);
  const grandTotal = total + ship.price;
  // Пределы одной покупки (1 000 – 250 000 ₽) — по сумме, которую платит
  // покупатель, то есть вместе с доставкой. Витрина гасит кнопку заранее, но
  // проверяем и здесь: клиентским данным не верим, как и в цене заказа.
  //
  // Пределы принадлежат КАССАМ: пока оплата на витрине выключена (обе кассы),
  // заказ уходит заявкой, и ограничивать её суммой платёжки незачем.
  const limit = PAYMENTS.limitFor(s, grandTotal);
  if (limit) return res.json({ ok: false, error: limit }, 400);

  // Без фиксированного публичного origin касса не может получить безопасный
  // callback. В таком развёртывании оформляем обычную заявку, а не оставляем
  // покупателя с невидимым черновиком на неработающей странице оплаты.
  const draft = PAYMENTS.enabled(s) && !!paymentOrigin(req);
  /* Свои реквизиты: черновика нет вовсе. Черновиком заказ становится ради
   * ВЫБОРА способа оплаты, а выбирать тут нечего — реквизиты одни и те же, и
   * менеджеру заявка нужна сразу, вместе с уведомлением. */
  const payMode = !draft && PAYMENTS.ownEnabled(s) ? 'own' : '';
  const orderData = {
    checkoutRequestId, checkoutRequestHash: requestHash,
    draft, payMode,
    host: db.normHost(req.headers.host),
    items, total: grandTotal, itemsTotal: total,
    /* Промокод заказа. Пусто, когда кода нет вовсе: система выключена или
     * покупатель снял скидку — тогда и выгоды никакой, и приписывать её
     * несуществующему коду нельзя. Считается по тем же позициям, что и сумма,
     * то есть без распроданных. */
    promoCode: promo.promo ? promo.promo.code : '',
    promoDiscount: promo.promo ? promoSaved : 0,
    firstName, lastName, phone, contact, address, delivery,
    comment: String(req.body.comment || '').slice(0, 1000),
    deliveryMode, deliveryPrice: ship.price, deliveryZone: ship.zone,
    pickupCode: point && point.official ? point.code : '', pickupAddress
  };

  // Повтор после невыданных реквизитов ведёт к прежнему заказу. Это делаем
  // после ВСЕХ серверных пересчётов: совпадают реальные товары, цена и доставка,
  // а не присланная браузером догадка.
  const reused = draft ? reusableOrder(req, orderData) : null;
  if (reused) {
    rememberOwnOrder(req, reused);
    return res.json(orderApiBody(reused, true));
  }

  const visitorId = metrics.visitorId(req) || null;
  const metricVisitor = visitorId ? metrics.findVisitor(visitorId) : null;
  const requestIp = clientIp(req);
  // Геозаголовки читаются только за настоящим Cloudflare: иначе город и страну
  // заказа посетитель задавал бы себе сам обычным заголовком запроса.
  const proxyTrusted = cloudflareTrusted(req);
  // Базовые данные устройства доступны без сети. Уже известный город берём из
  // карточки посетителя, а новый IP обогащаем после ответа покупателю.
  const client = metrics.context(req, requestIp, proxyTrusted);
  if (metricVisitor) {
    for (const key of ['city', 'region', 'country', 'countryCode', 'isp']) if (metricVisitor[key]) client[key] = metricVisitor[key];
  }

  // С онлайн-оплатой заказ сначала черновик: покупатель ещё не выбрал способ и
  // мог просто заглянуть на страницу оплаты. Настоящим он станет, когда способ
  // будет выбран (`promoteOrder` в /api/pay/crocopay/start) — тогда же уйдут
  // уведомление менеджеру и отметка в метрике, а корзина очистится.
  // Без онлайн-оплаты выбирать нечего: заявка сразу настоящая, как и раньше.
  // Сумма здесь заведомо в пределах кассы — заказ вне их не доходит до этой
  // строки, его отвергает проверка выше.
  const order = db.createOrder(Object.assign(orderData, {
    // Код пункта выдачи — то, по чему менеджер оформляет накладную: адрес у
    // перевозчика может быть записан иначе, а код у пункта один. Пишем только
    // код от самого перевозчика: у точки из OpenStreetMap это идентификатор
    // объекта карты, накладной он не поможет, а в заказе будет шумом. Вписанный
    // руками пункт кода не имеет тем более — только адрес.
    visitorId, clientIp: client.ip, clientCity: client.city, clientRegion: client.region,
    clientCountry: client.country, clientCountryCode: client.countryCode, clientIsp: client.isp, clientDevice: client.device,
    clientModel: client.model, clientOs: client.os, clientBrowser: client.browser,
    clientSource: (metricVisitor && metricVisitor.source) || client.source
  }));
  if (!draft) metrics.markOrder(visitorId, order);
  /* Диалог этого покупателя теперь знает, КАК ЕГО ЗОВУТ.
   *
   * Имени в чате покупатель не называет никогда — окно его не спрашивает, — и
   * до сих пор в панели он значился городом: «Даллас». Оформив заказ, он имя
   * назвал, и звать его в переписке городом больше незачем: менеджер отвечает
   * человеку, а не точке на карте.
   *
   * Пишем прямо в диалог, а не подставляем при показе: имя нужно и в списке
   * диалогов, и в шапке темы Telegram, и в карточке уведомления — искать по
   * заказам в каждом из этих мест значило бы делать одну работу трижды. */
  const named = String(order.customerName || '').trim();
  const ownChat = named && visitorId ? CHAT.byVisitorId(visitorId) : null;
  if (ownChat && ownChat.name !== named) CHAT.touch(ownChat, { name: named });
  // Медленные геобаза и Telegram больше не держат покупателя на «Отправляем».
  // Заказ уже записан; технические поля безопасно обогащаются в фоне.
  metrics.describeRequest(req, requestIp, proxyTrusted).then(enriched => {
    const saved = db.updateOrderClient(order.id, {
      clientIp: enriched.ip, clientCity: enriched.city, clientRegion: enriched.region,
      clientCountry: enriched.country, clientCountryCode: enriched.countryCode, clientIsp: enriched.isp, clientDevice: enriched.device,
      clientModel: enriched.model, clientOs: enriched.os, clientBrowser: enriched.browser,
      clientSource: (metricVisitor && metricVisitor.source) || enriched.source
    });
    if (!draft) notifyNewOrder(saved || order);
  }).catch(() => { if (!draft) notifyNewOrder(order); });
  // id заказа нужен следующему шагу — онлайн-оплате. Он же кладётся в подписанную
  // cookie-сессию покупателя (как id своего отзыва), поэтому запустить оплату
  // можно только по своей заявке, а не по чужой, угадав идентификатор.
  rememberOwnOrder(req, order);
  // `pay` решает сервер, а не витрина: только он знает пересчитанную сумму и
  // пределы кассы. По нему же витрина решает, чистить ли корзину (у черновика
  // её чистит pay.js, когда способ выбран).
  res.json(orderApiBody(order, false));
});

/* ============================ ОНЛАЙН-ЧАТ ВИТРИНЫ ============================
 * Кнопка в углу витрины: покупатель спрашивает, ИИ отвечает, менеджер видит ту
 * же переписку в Telegram и в любой момент подключается вместо бота.
 *
 * Блок снимается целиком вместе с lib/chat.js, lib/ai.js, lib/chat-prompt.js,
 * lib/chat-tg.js и public/chat.js — витрина при этом остаётся прежней, а
 * переписка лежит отдельным файлом и заказов не касается вовсе.
 *
 * ЧТО ЗДЕСЬ ГЛАВНОЕ. Ответ на сообщение НЕ ЖДЁТ модель: маршрут сохраняет
 * вопрос, отправляет его в Telegram и отвечает витрине «принято» за единицы
 * миллисекунд. Ответ ИИ идёт следом по живому каналу, кусками, по мере того как
 * модель его печатает. Ждать здесь ответа целиком означало бы держать запрос
 * покупателя открытым все пять секунд генерации — и на плохой сети потерять и
 * ответ, и вопрос.
 */
/* Снимки удалённых реплик убирает хранилище загрузок — модуль чата про него не
 * знает вовсе и знать не должен. Все пути удаления (срок хранения, потолок
 * диалогов, обрезка переписки, удаление реплики и всего разговора) сходятся в
 * одной его функции, поэтому подставить уборку достаточно один раз здесь. */
CHAT.init(db.DATA_DIR, { dropFiles: files => files.forEach(db.deleteUploadIfUnused) });

/* Открытый чат — это тоже «человек на сайте», и метрика обязана знать об этом.
 *
 * Живой канал держится, пока открыта страница витрины, а heartbeat метрики идёт
 * только у ВИДИМОЙ вкладки: покупатель, свернувший браузер в ожидании ответа,
 * оставался «в сети» в чате и «был 5 минут назад» в своей карточке метрики —
 * два разных ответа про одного человека на соседних экранах панели.
 *
 * Отметка двигает только `lastSeen` (`metrics.seen`), не начисляя времени на
 * странице: секунды считает heartbeat, и приписывать их фоновой вкладке
 * значило бы завышать длительность визита у всех, кто просто не закрыл сайт.
 *
 * Тик реже порога онлайна (2 минуты) быть не может — иначе отметка успевала бы
 * протухнуть между вызовами. Открытых каналов нет — выходим первой строкой,
 * поэтому на пустой витрине это стоит ничего.
 */
const presenceSweep = setInterval(() => {
  for (const id of CHAT.onlineVisitorIds()) metrics.seen(id);
}, 45 * 1000);
if (presenceSweep.unref) presenceSweep.unref();

/* Диалог этого покупателя. Ключ — подписанная cookie-сессия, тот же приём, что
 * у своих отзывов и своих заказов: чужую переписку так не открыть, а угадать
 * 32-значный id нельзя.
 *
 * Второй ключ — метка посетителя метрики, и нужен он ровно для одного случая:
 * менеджер написал ПЕРВЫМ человеку, который в окно чата ещё не заглядывал.
 * Такому диалогу неоткуда взяться в сессии покупателя — её он получает только
 * здесь, при первой же встрече. Дальше разговор живёт на подписанной сессии,
 * как любой другой.
 *
 * Подхватываем по метке ТОЛЬКО начатое менеджером: разговоры, заведённые самим
 * покупателем, уже лежат в его сессии, и второй путь к ним был бы послаблением
 * на ровном месте. Сама метка — httpOnly-cookie из 16 случайных байт, и знать
 * её посторонний может лишь оттуда же, откуда и cookie сессии.
 */
function currentChat(req) {
  const id = req.session && req.session.chatId;
  const own = CHAT.validId(id) ? CHAT.get(id) : null;
  if (own) return own;
  const visitorId = metrics.visitorId(req);
  if (!visitorId) return null;
  const started = CHAT.byVisitorId(visitorId);
  if (!started || started.startedBy !== 'operator') return null;
  if (req.session) req.session.chatId = started.id;
  return started;
}

/* Заказы этого собеседника — с состоянием оплаты.
 *
 * Половина вопросов в чате про них и есть: «оплатил, а статус прежний», «когда
 * отправите», «почему счёт не открывается». Отвечать на такое, не видя заявки,
 * означает переспрашивать номер заказа у человека, который сидит на сайте с
 * открытой страницей оплаты.
 *
 * Черновики берём тоже — в отличие от блока «Покупки» в карточке посетителя.
 * Там они читались бы как состоявшиеся покупки, а здесь это самый частый повод
 * написать: покупатель дошёл до выбора способа и не смог заплатить.
 */
/* Заказ одной строкой — для Telegram, где нет ни плашек, ни ссылок.
 *
 * Подпись состояния берётся у `R.payView()`, то есть ровно та же, что стоит в
 * панели: «счёт истёк» в теме и «счёт истёк» в списке заказов обязаны означать
 * одно и то же, а разъехавшиеся слова об одном заказе — первый признак двух
 * разных реализаций.
 */
function chatOrderLine(order) {
  const view = R.payView(order) || { label: 'без оплаты' };
  return R.orderNo(order.number) + ' · ' + R.money(order.total, settings()) + ' · ' + view.label;
}

function chatOrders(chat, limit) {
  if (!chat) return [];
  const visitorId = String(chat.visitorId || '');
  const ip = String(chat.ip || '');
  return db.visibleOrders()
    // У заявок до появления `visitorId` есть только адрес, и по нему же их
    // находит карточка посетителя. Совпадение адреса засчитываем лишь тогда,
    // когда метки у заказа нет вовсе: иначе за одним офисным NAT в переписку
    // попали бы чужие покупки.
    .filter(o => (visitorId && o.visitorId === visitorId) || (!o.visitorId && ip && o.clientIp === ip))
    .slice(0, limit || 10);
}

// Обстановка вокруг покупателя. Собирается из запроса, а не с его слов: город,
// техника и адрес — те же, что попадают в заказ, и приходят они из метрики.
function chatContext(req) {
  const context = metrics.context(req, clientIp(req), cloudflareTrusted(req)) || {};
  const visitorId = metrics.visitorId(req) || '';
  /* Город берём из КАРТОЧКИ посетителя, а не только из заголовков: geo-заголовки
   * читаются лишь за Cloudflare (по умолчанию им не доверяем вовсе), а карточку
   * метрика уже наполнила геосервисом при первом просмотре страницы. Второго
   * обращения наружу здесь не делается ни одного. */
  const card = visitorId ? metrics.findVisitor(visitorId) : null;
  const geo = context.geo || {};
  const city = [geo.city || (card && card.city), geo.country || (card && card.country)].filter(Boolean).join(', ');
  return {
    visitorId,
    ip: clientIp(req),
    city,
    device: [context.model || context.device, context.os, context.browser].filter(Boolean).join(' · '),
    /* Те же сведения РАЗОБРАННЫМИ полями. Склейка выше уходит в Telegram, где
     * значков нет; панель же подбирает значок по каждому полю отдельно, и
     * разбирать строку обратно значило бы гадать о том, что мы сами только что
     * сложили. */
    client: {
      device: context.device || '',
      model: context.model || '',
      os: context.os || '',
      browser: context.browser || '',
      city: geo.city || (card && card.city) || '',
      country: geo.country || (card && card.country) || '',
      countryCode: geo.countryCode || (card && card.countryCode) || ''
    },
    // Адрес страницы — из закрытого списка публичных путей: он приходит от
    // браузера, а уезжает в тему Telegram ссылкой.
    page: metricPublicPath(req.body && req.body.path) || '',
    origin: originOf(req)
  };
}

// Что уезжает в браузер. Служебных полей диалога (ip, тема Telegram, id
// посетителя) покупателю знать незачем — он получает ровно свою переписку.
/* Реплика в том виде, в каком её показывают покупателю.
 *
 * Подпись подставляется ЗДЕСЬ, на сервере, а не в браузере: имена собеседников
 * лежат в `lib/chat.js` одним списком, и своя копия в `public/chat.js`
 * разъехалась бы с ним на первой же правке — покупатель увидел бы под одной
 * репликой одно имя, а в панели у той же реплики другое. Заодно так
 * подписываются и старые записи, сделанные до появления имён.
 */
// Корзина покупателя из тела запроса: массив как есть либо строка JSON — так
// она приходит вместе со снимками, где тело multipart и массивов не бывает.
function chatCart(value) {
  if (Array.isArray(value)) return value;
  if (typeof value !== 'string' || !value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch (e) { return []; }
}

function chatMessageView(m) {
  const view = { role: m.role, text: m.text, at: m.at, by: CHAT.speakerOf(m.role, m.by) };
  // Снимки уезжают готовыми адресами: собирать путь в браузере значило бы
  // завести там второе знание о том, где лежат загрузки.
  const photos = CHAT.photosOf(m);
  if (photos.length) view.photos = photos.map(f => '/uploads/' + encodeURIComponent(f));
  // Цитата уезжает как есть: это снимок, собранный сервером (`CHAT.replyTo`), и
  // покупателю он нужен ровно затем, чтобы видеть, на что ему ответили.
  if (m.reply) view.reply = m.reply;
  return view;
}

function chatView(chat) {
  return {
    ok: true,
    id: chat.id,
    mode: chat.mode,
    unread: chat.unread,
    // Галочки у своих реплик: докуда магазин их получил и прочитал. Считает их
    // сервер — в браузере своего представления о доставке быть не может.
    receipt: CHAT.receipt(chat),
    messages: chat.messages.map(chatMessageView)
  };
}

/* Ответ ИИ. Ничего не возвращает и никого не заставляет себя ждать: всё, что
 * он делает, уходит в живой канал покупателя и в тему Telegram.
 *
 * Ошибка модели здесь — не мелочь: вопрос уже задан, и остаться без ответа
 * покупатель не должен. Поэтому при любом отказе в тему уходит отдельная
 * строка «ИИ не ответил», то есть вопрос попадает к человеку, а не пропадает.
 */
/* Диалоги, по которым модель отвечает прямо сейчас.
 *
 * Ответ идёт до минуты (медленная модель печатает долго, и обрывать полезный
 * текст на середине хуже, чем подождать). Всё это время покупатель вправе
 * написать ещё раз — и без этой отметки получил бы ДВА ответа внахлёст, оба
 * недописанные, вперемешку в одной ленте. Второй вопрос при этом не теряется:
 * он уже лежит в переписке и ушёл менеджеру в Telegram, а модель увидит его в
 * истории следующим ходом.
 */
const aiBusy = new Set();
/* Пока консультант отвечает, покупатель может дописать уточнение. Такой ход
 * нельзя запускать параллельно — ответы перемешаются, — но нельзя и терять:
 * после текущего ответа запускаем ещё один с уже полной историей. Несколько
 * быстрых уточнений схлопываются в один следующий ход: отвечать на каждую
 * строку отдельным абзацем было бы хуже, чем ответить на весь вопрос целиком. */
const aiQueued = new Map();

/* ОПЕРАТОР ЗАМОЛЧАЛ — КОНСУЛЬТАНТ ВОЗВРАЩАЕТСЯ САМ.
 *
 * Первая реплика человека выключает бота до конца переписки, и это правильно:
 * перебивать живого менеджера нельзя. Но дежурный отвечает и уходит, а
 * покупатель пишет снова — и упирается в молчание, потому что бот выключен, а
 * человека рядом нет. Хуже случая в чате магазина не придумаешь: вопрос задан,
 * никто не ответил, вкладка закрыта.
 *
 * Поэтому после реплики покупателя, оставшейся без ответа `AI_TAKEOVER_MS`,
 * консультант включается обратно и отвечает — с полной перепиской в контексте,
 * то есть зная и то, о чём покупатель уже договорился с менеджером.
 *
 * Таймер живёт в памяти процесса и перезапуск не переживает — и это осознанно:
 * ждать возврата бота дольше пяти минут после рестарта незачем, а хранить ради
 * этого ещё одно поле на диске и чинить его при каждой записи — дороже задачи.
 */
const aiTakeover = new Map();

/* ОБЩИЙ БЮДЖЕТ ПРОЦЕССА на ответы модели — последний рубеж, за которым деньги.
 *
 * Пределы по сессии и по адресу выше держат одного клиента. Но ответ
 * консультанта — единственное действие витрины, которое СТОИТ ВЛАДЕЛЬЦУ ДЕНЕГ
 * на каждом вызове, и оставлять его без общего потолка нельзя: распределённый
 * поток обходит любой лимит по адресу, а счёт за токены придёт один.
 *
 * Тот же приём, что у касс (`pay-provider-global`), и число выбрано так же
 * щедро: 300 ответов за десять минут — это 43 000 в сутки, вчетверо больше
 * всего, что бывает у живого магазина. Упёрлись — модель не зовём вовсе, а
 * покупатель получает обычное «уточню и вернусь»: вопрос к этому моменту уже
 * лежит в теме Telegram, и отвечает на него человек. Молчать было бы хуже.
 */
const AI_BUDGET_PER_WINDOW = 300;
const AI_BUDGET_WINDOW_MS = 10 * 60 * 1000;
// Без привязки к запросу: считаем ВСЕ ответы вместе, кто бы их ни попросил.
// `rateLimited` при заданном identity адрес не спрашивает вовсе.
function aiBudgetSpent() {
  return rateLimited(null, 'ai-answer-global', AI_BUDGET_PER_WINDOW, AI_BUDGET_WINDOW_MS, 'all');
}
/* Через сколько консультант возвращается — настройка владельца (минуты живут в
 * lib/chat.js, там же их предел и значение по умолчанию). Пять минут были
 * зашиты числом, а магазину магазин рознь: где-то дежурный сидит в теме
 * постоянно, где-то появляется раз в день. */
function takeoverMs(s) { return CHAT.takeoverMinutes(s) * 60 * 1000; }

function cancelTakeover(id) {
  const timer = aiTakeover.get(id);
  if (timer) { clearTimeout(timer); aiTakeover.delete(id); }
}

function armTakeover(chat) {
  cancelTakeover(chat.id);
  const s = settings();
  const minutes = CHAT.takeoverMinutes(s);
  const wait = takeoverMs(s);
  if (!wait) return;                       // ноль — консультант не возвращается
  const timer = setTimeout(() => {
    aiTakeover.delete(chat.id);
    const s = settings();
    const fresh = CHAT.get(chat.id);
    if (!fresh || fresh.mode !== 'operator' || !AI.enabled(s)) return;
    // За заданный срок менеджер мог ответить — тогда возвращать некого.
    const last = fresh.messages[fresh.messages.length - 1];
    if (!last || last.role !== 'user') return;
    CHAT.setMode(fresh, 'ai');
    TGCHAT.relaySystem(fresh, 'Менеджер не ответил за ' + minutes + ' мин. — отвечает консультант');
    aiReply(fresh, { page: fresh.page, cart: [], orders: chatOrders(fresh, 5) })
      .catch(e => console.error('Чат: ошибка ответа ИИ — ' + e));
  }, wait);
  if (timer.unref) timer.unref();
  aiTakeover.set(chat.id, timer);
}

async function aiReply(chat, info) {
  const s = settings();
  // Выключенный галочкой консультант молчит, даже когда ключ на месте: все
  // вопросы уходят менеджеру, и это осознанный режим владельца.
  if (!AI.enabled(s)) return;
  /* Второе сообщение не запускаем поверх первого, но и не бросаем. Раньше
   * `aiBusy` просто выходил отсюда: покупатель дописывал «и в чёрном?», видел
   * ответ только на первый вопрос и оставался без продолжения до третьей
   * реплики. Последняя обстановка заменяет предыдущую, а сама переписка уже
   * лежит в `chat.messages` целиком. */
  if (aiBusy.has(chat.id)) {
    aiQueued.set(chat.id, info || {});
    return;
  }
  aiBusy.add(chat.id);
  try {
    let current = chat;
    let context = info || {};
    while (current) {
      const currentSettings = settings();
      if (current.mode !== 'ai' || !AI.enabled(currentSettings)) break;
      await aiAnswer(current, context, currentSettings);
      const next = aiQueued.get(chat.id);
      aiQueued.delete(chat.id);
      current = CHAT.get(chat.id);
      if (!next || !current || current.mode !== 'ai') break;
      context = next;
    }
  } finally {
    aiQueued.delete(chat.id);
    aiBusy.delete(chat.id);
  }
}

// Последний вопрос покупателя: текстом считается пауза перед ответом, а временем
// — ровно до какой реплики дошли галочки этого ответа. Второе важно, когда
// покупатель успел дописать уточнение, пока консультант печатал первое.
function lastQuestion(chat) {
  const list = (chat && chat.messages) || [];
  for (let i = list.length - 1; i >= 0; i--) {
    if (list[i].role === 'user') return {
      text: list[i].text || '',
      at: list[i].at || 0,
      photos: Array.isArray(list[i].photos) ? list[i].photos : []
    };
  }
  return { text: '', at: 0, photos: [] };
}

/* OpenAI рекомендует стабильную неперсональную метку конечного пользователя
 * для обнаружения злоупотреблений. Ни visitorId, ни id диалога наружу не
 * отдаём: HMAC по секрету установки нельзя обратить и нельзя сопоставить с
 * идентификаторами другой системы. */
function aiSafetyIdentifier(chat, s) {
  const source = String(chat && (chat.visitorId || chat.id) || '');
  const secret = String(s && s.sessionSecret || '');
  if (!source || !secret) return '';
  return crypto.createHmac('sha256', secret).update(source).digest('hex').slice(0, 32);
}

/* Ссылки в готовом ответе консультанта: голый адрес → название из каталога.
 *
 * Скобки пишет сама модель (так велят правила в lib/chat-prompt.js), а это
 * страховка на случай, когда она их забыла: в окне покупателя должно стоять
 * «👉 Айфон 17 Pro», а не строка со слэшами посреди фразы. Название берётся из
 * живого каталога — переврать его модель уже не может.
 *
 * `growing` — про реплику, оборванную вошедшим оператором: недописанная ссылка
 * сохраняется одним названием.
 */
function chatLinkNames(text, growing) {
  return LINKS.withNames(text, id => {
    const p = db.visibleProduct(id);
    return p ? p.name : '';
  }, growing);
}

async function aiAnswer(chat, info, s) {
  const question = lastQuestion(chat);
  CHAT.push(chat.id, 'typing', {});
  // Консультант взял вопрос — для покупателя это «доставлено»: у его реплики
  // появляется вторая галочка ещё до того, как придёт ответ. Простой вопрос о
  // гарантии ниже может решиться локально и вовсе не уходить во внешний API.
  CHAT.markStore(chat, 'got', question.at);
  // Если к вопросу приложен снимок, нужен менеджер: локальный FAQ его не
  // видит и не должен делать вид, будто оценил неисправность по фотографии.
  const warranty = question.photos.length ? '' : PROMPT.warrantyAnswer(chat, question.text);
  /* Ответ идёт покупателю не как его отдаёт модель, а как его печатал бы
   * человек: с паузой на прочтение вопроса и ровным темпом (lib/chat-typing.js).
   * Модель отвечает быстрее любого человека, и без этого окно выглядело так,
   * будто на том конце подставляют заранее готовый текст.
   *
   * `alive` — про оператора: он мог войти в разговор, пока шла печать, и
   * допечатывать поверх живого человека нельзя. */
  const pace = TYPING.start({
    ask: question.text,
    send: piece => CHAT.push(chat.id, 'delta', { text: piece }),
    alive: () => {
      const at = CHAT.get(chat.id);
      return !!at && at.mode === 'ai';
    }
  });
  let result;
  if (warranty) {
    // Локальный ответ про гарантию бюджет не расходует: он не стоит ни токена.
    pace.feed(warranty);
    result = { ok: true, text: warranty, error: '' };
  } else if (aiBudgetSpent()) {
    // Общий потолок процесса выбран — в модель не идём вовсе. Дальше по коду
    // это обычный отказ: покупатель получает «уточню и вернусь», а в тему
    // Telegram уходит отметка с причиной, и вопрос ждёт менеджера.
    result = { ok: false, text: '', error: 'budget' };
  } else {
    const messages = PROMPT.build(db, s, chat, info);
    result = await AI.stream(s, messages, piece => pace.feed(piece), {
      safetyIdentifier: aiSafetyIdentifier(chat, s)
    });
  }
  // Допечатываем остаток. Даже когда печатать нечего (модель не ответила),
  // пауза выдерживается: мгновенное «уточню и вернусь» выдавало бы автоматику.
  await pace.finish();
  const fresh = CHAT.get(chat.id);
  if (!fresh) return;
  /* Пока модель печатала, в диалог мог войти оператор. Его ответ главнее — ИИ
   * замолкает, — но недописанную реплику надо ЗАКРЫТЬ, а не бросить.
   *
   * Куски ответа уже улетели покупателю и стоят у него в окне: просто выйти
   * отсюда значило бы оставить обрывок висеть до перезагрузки страницы, а в
   * сохранённой переписке его бы не было вовсе — то есть человек и менеджер
   * видели бы разные разговоры. Поэтому напечатанное сохраняем как есть, а в
   * тему Telegram его не шлём: там оператор уже пишет сам.
   */
  if (fresh.mode !== 'ai') {
    /* Сохраняем НАПЕЧАТАННОЕ (`pace.sent()`), а не весь текст модели: печать
     * остановилась там же, где вошёл оператор, и покупатель увидел ровно этот
     * кусок. Сохрани мы полный ответ — человек и панель видели бы разные
     * разговоры, а в окне текст дописался бы сам при следующем открытии. */
    const typed = pace.sent();
    if (typed) {
      const partial = CHAT.addMessage(fresh, 'ai', chatLinkNames(typed, true));
      CHAT.push(fresh.id, 'done', partial);
    } else {
      CHAT.push(fresh.id, 'done', null);
    }
    return;
  }
  if (result.ok && result.text) {
    // Забыла скобки — дописываем название сами (см. `withNames` в
    // public/chat-links.js): в переписке покупателя голому адресу не место, а
    // название приходит из живого каталога, поэтому переврать его нельзя.
    const text = chatLinkNames(result.text);
    /* Ответ готов — вот теперь вопрос прочитан МАГАЗИНОМ: галочки у покупателя
     * синеют вместе с приходом ответа, а не отдельным событием до него.
     * Уведомление менеджера при этом остаётся: оно живёт на `managerRead`,
     * который ИИ не двигает. Модель не ответила — не ставим даже галочку. */
    CHAT.markStore(fresh, 'read', question.at);
    const message = CHAT.addMessage(fresh, 'ai', text);
    CHAT.push(fresh.id, 'done', message);
    TGCHAT.relayAi(fresh, text);
    return;
  }
  /* Модель не ответила. Покупателю говорим об этом ГОЛОСОМ КОНСУЛЬТАНТА и без
   * единого слова про автоматику: «не получилось ответить автоматически» — это
   * рассказ о том, что с ним разговаривал робот, а знать ему это незачем. Ровно
   * та же причина, по которой из ленты убраны отметки о подключении менеджера.
   *
   * Обещание при этом честное: вопрос уже ушёл в тему Telegram, вместе с
   * отдельной отметкой ниже, и лежит у менеджера перед глазами. */
  const excuse = result.error === 'rate_limit'
    ? 'Уточняю по вашему вопросу — отвечу здесь через пару минут.'
    : 'Секунду, уточню детали по вашему вопросу и вернусь с ответом сюда же.';
  const message = CHAT.addMessage(fresh, 'ai', excuse);
  CHAT.push(fresh.id, 'done', message);
  TGCHAT.relaySystem(fresh, 'ИИ не ответил (' + (result.error || 'ошибка') + ') — вопрос ждёт менеджера');
}

// Открыть диалог: витрина зовёт это при первом сообщении и при возвращении на
// сайт. Диалог уже есть — отдаём его целиком, чтобы окно открылось там же, где
// покупатель его оставил.
app.post('/api/chat/open', (req, res) => {
  const s = settings();
  if (!CHAT.visible(s)) return res.json({ ok: false, error: 'off' }, 404);
  // По сессии И по адресу: без второго предела клиент без cookie заводил бы
  // диалоги без счёта и вытеснял живые переписки (см. `floodLimited`).
  if (floodLimited(req, 'chat-open', 60, 300, 10 * 60 * 1000)) {
    return res.json({ ok: false, error: 'Слишком часто. Попробуйте позже.' }, 429);
  }
  const info = chatContext(req);
  let chat = currentChat(req);
  if (!chat) {
    chat = CHAT.create(info);
    req.session.chatId = chat.id;
  } else {
    CHAT.touch(chat, info);
  }
  // Переписка уехала в браузер целиком — реплики магазина доставлены. Прочитаны
  // они не здесь: окно могло и не открываться (канал подключается в фоне, когда
  // менеджер написал первым).
  CHAT.markUser(chat, 'got');
  res.json(chatView(chat));
});

/* Сообщение покупателя.
 *
 * Порядок действий здесь важен и именно такой: сохранить → показать другим
 * вкладкам → отправить менеджеру → и только потом, не дожидаясь, попросить
 * ответ у ИИ. Первые три шага стоят доли миллисекунды, поэтому витрина получает
 * «принято» сразу, а вопрос уже лежит и в переписке, и в Telegram — даже если
 * модель откажет совсем.
 */
app.post('/api/chat/send', async (req, res) => {
  const s = settings();
  if (!CHAT.visible(s)) return res.json({ ok: false, error: 'off' }, 404);
  /* Предел по подписанной сессии — чтобы сосед по NAT или Tor-выходу не отдавал
   * живому покупателю чужой отказ. И предел по адресу рядом с ним — потому что
   * сессию клиент заводит себе сам, и без cookie сессионный счётчик для него не
   * существует (см. `floodLimited`). Здесь это не мелочь: каждая реплика стоит
   * вызова модели за счёт владельца и сообщения в Telegram-группу. */
  if (floodLimited(req, 'chat-send', 40, 200, 5 * 60 * 1000)) {
    return res.json({ ok: false, error: 'Слишком много сообщений подряд. Подождите минуту.' }, 429);
  }
  const text = CHAT.clean(req.body && req.body.text, CHAT.MAX_TEXT).trim();
  /* Снимки покупателя.
   *
   * ЧТО ИМЕННО ЗАЩИЩАЕТ НАС ЗДЕСЬ, по порядку:
   *   - тип файла определяется ПО СИГНАТУРЕ, а не по имени и не по MIME от
   *     браузера (`imageExtension` в lib/server-lib.js): проходят только jpg,
   *     png, gif и webp. SVG — а вместе с ним и любая разметка со скриптом —
   *     не проходит вовсе, и расширение файлу тоже даёт сигнатура;
   *   - имя на диске случайное, из него же собирается адрес: путь из запроса в
   *     файловую систему не попадает никогда;
   *   - файл не остаётся тем, чем пришёл: `optimizeUploads` перекодирует его в
   *     WebP через ImageMagick и снимает ВСЕ метаданные (`-strip` плюс явное
   *     гашение `date:*`) — ни EXIF с координатами съёмки, ни модели телефона,
   *     ни времени в файле не остаётся. Пиксели при этом не режутся: 1400 px по
   *     длинной стороне и качество WebP, на котором разница не видна глазом;
   *   - размер одного файла ограничен 6 МБ ещё разбором multipart, а числом их
   *     ограничивает CHAT.MAX_PHOTOS.
   */
  const raw = req.filesFor ? req.filesFor('photos').slice(0, CHAT.MAX_PHOTOS) : [];
  /* Свой лимит на файлы, помимо общего лимита реплик: сорок сообщений по три
   * снимка в каждом — это уже гигабайты на диске за пять минут. Считается он
   * ТОЛЬКО когда файлы правда пришли, поэтому обычную переписку не задевает. */
  if (raw.length && floodLimited(req, 'chat-photo', 24, 120, 10 * 60 * 1000)) {
    return res.json({ ok: false, error: 'Слишком много снимков подряд. Попробуйте через несколько минут.' }, 429);
  }
  const photos = raw.length ? await optimizeUploads(raw, 1400) : [];
  // Реплика без текста законна, если в ней есть снимок: фото коробки без единого
  // слова — обычное дело. Пустая во всех смыслах — нет.
  if (!text && !photos.length) return res.json({ ok: false, error: 'Введите сообщение' }, 400);

  const info = chatContext(req);
  let chat = currentChat(req);
  if (!chat) {
    chat = CHAT.create(info);
    req.session.chatId = chat.id;
  } else {
    CHAT.touch(chat, info);
  }
  if (chat.mode === 'closed') CHAT.setMode(chat, 'ai');   // написал снова — разговор продолжается

  // Пишет — значит смотрит в окно: всё, что магазин ответил выше, прочитано.
  CHAT.markUser(chat, 'read');
  const own = CHAT.say(chat, 'user', text, { photos, exceptSid: String(req.body && req.body.sid || '') });
  /* Что видит менеджер в Telegram. Сами файлы туда не уходят: `sendPhoto` — это
   * второй канал доставки со своими лимитами и своими отказами, а переписка со
   * снимками и так открыта в панели одним нажатием на уведомление. Молчать о
   * них при этом нельзя — реплика «посмотрите» без единого слова про вложение
   * читалась бы как оборванная. */
  const withPhotos = photos.length
    ? (text ? text + '\n' : '') + '📷 ' + photos.length + ' фото — смотреть в панели'
    : text;

  /* Реплика уходит менеджеру одной дверью (`deliverUser`): она же заводит тему
   * на ПЕРВОМ сообщении, если её ещё нет.
   *
   * Раньше выбор делался здесь — и на первом сообщении звался только
   * `openTopic`: в Telegram уходила шапка «Новый диалог на сайте», а сам вопрос
   * не уходил вовсе. На сайте он был, у менеджера его не было. */
  // Карточкой в открытую панель — рядом с отправкой менеджеру в Telegram.
  // Реплика покупателя и есть событие: ответить на неё можно из панели так же,
  // как из темы, и узнать о ней надо, стоя на любом разделе.
  LIVE.note(A.noteChat(chat, withPhotos));

  TGCHAT.deliverUser(chat, s, withPhotos)
    // Ушла менеджеру — у покупателя это вторая галочка. Прочитанной реплика
    // станет, когда менеджер откроет диалог или ответит: раньше об этом никто
    // не знает, и обещать «прочитано» по факту отправки было бы неправдой.
    .then(ok => { if (ok) CHAT.markStore(chat, 'got', own && own.at); })
    .catch(e => console.error('Чат: реплика не ушла в Telegram — ' + e));

  // Ответ ИИ идёт своим ходом. Оператор в диалоге — бот молчит: он замолкает
  // до конца переписки, и вернуть его можно только кнопкой в Telegram.
  /* Корзина приезжает массивом в обычном JSON-запросе и СТРОКОЙ, когда реплика
   * ушла со снимками (multipart полей-массивов не знает). Без разбора строки
   * консультант терял бы содержимое корзины ровно в тех разговорах, где к
   * вопросу приложили фото. */
  const cart = chatCart(req.body && req.body.cart);
  if (chat.mode === 'ai' && AI.enabled(s)) {
    // Заказы этого покупателя уходят в промпт фактами: «где мой заказ» и
    // «оплатил, а статус прежний» — самые частые вопросы в чате, и без них
    // консультант мог только переспросить номер у того, кто и так на странице
    // оплаты. Подбирает их сервер по метке посетителя — чужие сюда не попадут.
    aiReply(chat, Object.assign({}, info, { cart, orders: chatOrders(chat, 5) }))
      .catch(e => console.error('Чат: ошибка ответа ИИ — ' + e));
  } else if (chat.mode === 'operator' && AI.enabled(s)) {
    // Менеджер в диалоге — ждём его. Не ответил за заданный срок, значит отошёл:
    // консультант вернётся сам и ответит на эту же реплику (см. armTakeover).
    armTakeover(chat);
  }
  /* Время сохранённой реплики уезжает обратно в браузер: своя реплика нарисована
   * там ещё до ответа сервера, и без серверного `at` галочке не за что
   * зацепиться — отметки о доставке и прочтении считаются именно по нему. */
  res.json({ ok: true, id: chat.id, mode: chat.mode, at: own ? own.at : 0, receipt: CHAT.receipt(chat) });
});

/* Живой канал. Через него приходят куски ответа ИИ, реплики оператора и смена
 * режима. Тот же Server-Sent Events, что у панели: `EventSource` умеют все
 * браузеры, доходящие до витрины, и он переподключается сам. */
app.get('/api/chat/stream', (req, res) => {
  if (!CHAT.visible(settings())) { res.writeHead(404); return res.end(); }
  const chat = currentChat(req);
  if (!chat) { res.writeHead(404); return res.end(); }
  // Канал открылся — человек на сайте, и метрика узнаёт об этом сразу, а не
  // через тик `presenceSweep`: карточку посетителя открывают ровно тогда, когда
  // в чате загорелось «в сети».
  if (chat.visitorId) metrics.seen(chat.visitorId);
  /* Сессию дописываем ДО заголовков потока: `currentChat()` мог только что
   * подобрать разговор по метке посетителя и положить его id в сессию, а поток
   * пишет заголовки сам, минуя `res.json`. Без этого id доезжал до браузера
   * лишь со следующим обычным запросом. */
  res.flushSession();
  CHAT.attach(chat.id, req, res);
});

/* Запасной опрос — на случай прокси, который не пропускает поток. Без него у
 * такого покупателя окно молчало бы вовсе: ни ответа ИИ, ни ответа менеджера.
 * Ответ ИИ он получает готовым целиком, без побуквенной ленты. */
app.get('/api/chat/poll', (req, res) => {
  if (!CHAT.visible(settings())) return res.json({ ok: false }, 404);
  const chat = currentChat(req);
  if (!chat) return res.json({ ok: false }, 404);
  if (floodLimited(req, 'chat-poll', 120, 600, 5 * 60 * 1000)) {
    return res.json({ ok: false }, 429);
  }
  const since = Math.max(0, Math.floor(Number(req.query.since)) || 0);
  // Реплики уехали в браузер — доставлены. Тот же смысл, что у отметки в
  // `CHAT.push`: там канал, здесь опрос, а результат для галочки один.
  CHAT.markUser(chat, 'got');
  res.json({
    ok: true,
    mode: chat.mode,
    receipt: CHAT.receipt(chat),
    messages: chat.messages.filter(m => m.at > since).map(chatMessageView)
  });
});

/* Маршрута «позвать менеджера» здесь нет намеренно.
 *
 * Кнопка предлагала покупателю выбрать собеседника, хотя выбирать нечего:
 * диалог целиком уходит в Telegram с первой же реплики, и менеджер вступает в
 * разговор, когда сочтёт нужным. Ему она добавляла только лишнее решение на
 * последнем шаге — а нажав, он ещё и ждал человека там, где ИИ ответил бы
 * сразу. Что собеседник сменился, говорит серая строка в ленте (`MODE_NOTES` в
 * lib/chat.js), и она одна на все входы: тему, команду и панель.
 */

// Покупатель открыл окно — значок непрочитанного гаснет, а у реплик магазина в
// панели появляются синие галочки: он их увидел.
app.post('/api/chat/read', (req, res) => {
  // Единственный маршрут чата, у которого не было ни выключателя, ни предела.
  // Каждый вызов двигает отметки и метит переписку к записи на диск, поэтому
  // считается он наравне с опросом — тем же двойным лимитом.
  if (!CHAT.visible(settings())) return res.json({ ok: false }, 404);
  if (floodLimited(req, 'chat-read', 120, 600, 5 * 60 * 1000)) return res.json({ ok: false }, 429);
  const chat = currentChat(req);
  if (chat) { CHAT.markRead(chat); CHAT.markUser(chat, 'read'); }
  res.json({ ok: true });
});

/* Ответ оператора из Telegram. Мост зовёт это, разобрав сообщение в теме, —
 * маршрута здесь нет вовсе: Telegram сам приходит к нам длинным опросом. */
TGCHAT.start({
  settings,
  chat: CHAT,
  onOperator: (chat, text) => {
    // Первая же реплика человека выключает бота — но не навсегда: он вернётся
    // сам, если следующая реплика покупателя останется без ответа.
    cancelTakeover(chat.id);
    if (chat.mode !== 'operator') CHAT.setMode(chat, 'operator');
    CHAT.markManager(chat);
    // Отвечает — значит прочитал: у покупателя галочки синеют раньше, чем
    // придёт сам ответ (менеджер печатает его не мгновенно).
    CHAT.markStore(chat, 'read');
    /* Имя из учётной записи Telegram сюда НЕ передаём: покупатель видит одного
     * и того же «Александра (Менеджера)», кто бы из смены ни ответил. Кто это
     * был на самом деле, видно в самой теме — там стоит подпись автора. */
    CHAT.say(chat, 'operator', text);
  },
  onCommand: (chat, command, by) => {
    // Команду набирают в самой теме, то есть переписку читают прямо сейчас.
    CHAT.markManager(chat);
    CHAT.markStore(chat, 'read');
    /* В ленту покупателя смена собеседника не пишет ничего — ни здесь, ни в
     * `setMode`. Отметка уходит только в тему Telegram, и там она называет,
     * КТО это сделал: менеджеру в общей группе это важно, покупателю — нет. */
    if (command === 'ai') {
      cancelTakeover(chat.id);
      CHAT.setMode(chat, 'ai');
      TGCHAT.relaySystem(chat, 'ИИ снова отвечает (' + by + ')');
      return;
    }
    if (command === 'info') {
      const orders = chatOrders(chat).map(o => '  ' + chatOrderLine(o));
      TGCHAT.relaySystem(chat, [
        chat.city && ('Город: ' + chat.city),
        chat.device && ('Техника: ' + chat.device),
        chat.page && ('Страница: ' + chat.page),
        chat.ip && ('IP: ' + chat.ip),
        // Заказы с состоянием оплаты — то, ради чего команду и зовут: «что у
        // него с оплатой» дежурный спрашивает чаще, чем «с какого он браузера».
        orders.length ? 'Заказы:\n' + orders.join('\n') : 'Заказов нет',
        'Сообщений: ' + chat.messages.length,
        'Режим: ' + chat.mode
      ].filter(Boolean).join('\n'));
    }
  },
  // Строку про заказы собирает сервер: мост о хранилище не знает вовсе.
  ordersLine: chat => {
    const list = chatOrders(chat, 3);
    return list.length ? list.map(chatOrderLine).join(' · ') : '';
  }
});

/* ======================== ОПЛАТА: CrocoPAY (схема H2H) ========================
 * Блок снимается целиком вместе с lib/crocopay.js и lib/pay-methods.js — витрина
 * возвращается к прежнему «заявка, менеджер свяжется», данные заказов при этом
 * остаются целы (см. «Онлайн-оплата» в CLAUDE.md).
 *
 * Порядок шагов важен: заказ создаётся и записывается ПЕРВЫМ, оплата идёт поверх
 * уже сохранённой заявки. Поэтому упавшая платёжка не теряет заказ — покупатель
 * видит номер, а менеджер получает заявку как обычно.
 *
 * H2H, а не Express: счёт выставляем сами и реквизиты показываем у себя, зато
 * знаем НАСТОЯЩИЙ статус счёта. В Express статуса нет вовсе — вебхук приходит
 * только на успех, и неоплаченный заказ висел в ожидании вечно.
 */

// Свой ли это заказ. Ключ — подписанная cookie-сессия, в которой id появился при
// оформлении: иначе оплату чужой заявки открывал бы любой, кто угадал номер.
function ownOrder(req, id) {
  const mine = Array.isArray(req.session.myOrders) ? req.session.myOrders : [];
  return mine.includes(String(id || '')) ? db.getOrder(String(id)) : null;
}

// Уведомление менеджеру об оплате. Общее для вебхука и опроса статуса: оба пути
// приводят к одному и тому же изменению, и дублировать текст незачем.
function notifyPayment(order, state, note) {
  const ss = settings();
  const paidAttempts = state === 'paid'
    ? db.paymentAttempts(order).filter(attempt => attempt.status === 'paid').length : 0;
  const restoredAfterDelete = order && order.archive
    && order.archive.restoredBy === 'system:payment'
    && order.archive.restoredReason === 'payment_received';
  const head = state === 'paid' && paidAttempts > 1
    ? (restoredAfterDelete ? '⚠️ <b>Повторно оплачен удалённый заказ' : '⚠️ <b>Повторно оплачен заказ')
    : restoredAfterDelete
      ? { paid: '⚠️ <b>Оплачен удалённый заказ', mismatch: '⚠️ <b>Оплата удалённого заказа с расхождением' }[state]
      : { paid: '💳 <b>Оплачен заказ', mismatch: '⚠️ <b>Оплата с расхождением' }[state];
  if (!head) return;                       // истёкший или отменённый счёт менеджера не будит
  const msg = `${head} ${tgEsc(R.orderNo(order.number))}</b>\n`
    + `👤 ${tgEsc(order.customerName) || '—'}\n`
    + `📞 ${tgEsc(R.phoneText(order.phone) || order.contact) || '—'}\n`
    + `<b>Сумма заказа: ${R.money(order.total, ss)}</b>\n`
    + (note ? `❗ ${tgEsc(note)}\n` : '');
  sendTelegram(ss, msg).catch(() => {});
}

/* Реквизитов не дала ни одна касса.
 *
 * В отличие от покупателя, менеджеру имена касс как раз нужны: по ним видно,
 * это у одной кончились карты или обе лежат. Поэтому здесь перечисляются все
 * попытки очереди, а на витрине остаётся одна общая фраза.
 */
function notifyPaymentProblem(order, method, tried) {
  const ss = settings();
  const list = Array.isArray(tried) ? tried : [];
  const head = list.length > 1
    ? `⚠️ <b>Реквизиты не выдала ни одна касса — заказ ${tgEsc(R.orderNo(order.number))}</b>`
    : `⚠️ <b>Касса не выдала реквизиты для заказа ${tgEsc(R.orderNo(order.number))}</b>`;
  const why = list.length
    ? list.map(t => `• ${tgEsc(PAYMENTS.nameOf(t.provider))}: ${tgEsc(t.code)}`).join('\n')
    : '• причина неизвестна';
  const msg = `${head}\n`
    + `Способ: ${tgEsc(PAY.nameOf(method) || method) || '—'}\n`
    + `<b>Сумма заказа: ${R.money(order.total, ss)}</b>\n`
    + `${why}\n`
    + `Заказ сохранён — с покупателем можно связаться.`;
  sendTelegram(ss, msg).catch(() => {});
}

/* Одна попытка у одной кассы: создать счёт и записать исход.
 *
 * Возвращает либо `{done:true,…}` — ответ покупателю готов (реквизиты выданы,
 * заказ уже оплачен, попытка устарела), либо `{code}` — эта касса отказала, и
 * вызывающий вправе спросить следующую в очереди.
 *
 * Всё, что связывает платёж с заказом, живёт здесь, а не в модуле кассы: та
 * знает только про HTTP к своему API.
 */
async function requestInvoiceFrom(p, s, req, order, ctx, method, providerRequestId, lastInChain) {
  const id = order.id;
  const attemptId = crypto.randomBytes(12).toString('hex');
  const started = db.startOrderPayment(id, {
    provider: p.id, attemptId, requestId: providerRequestId,
    token: crypto.randomBytes(16).toString('hex'),
    method, amount: ctx.amount, currency: ctx.currency
  });
  const attempt = db.findPaymentAttempt(started, { attemptId });
  if (!started || !attempt || !attempt.token) {
    // Попытку не создали — и самая частая причина этого не техническая: пока шла
    // очередь касс, заказ мог оплатиться прежним счётом, и `startOrderPayment()`
    // намеренно возвращает заказ, не трогая уже подтверждённую оплату.
    // Финансовый факт важнее отказа нового запроса: ведём на terminal-страницу,
    // а не показываем «не удалось начать оплату» поверх пришедших денег.
    const terminal = terminalPaymentBody(db.getOrder(id));
    if (terminal) return { done: true, status: 200, body: terminal };
    return { done: true, status: 500, body: { ok: false, error: 'Не удалось начать оплату' } };
  }

  // Адрес callback свой у каждой кассы и у каждой попытки: по нему и только по
  // нему потом понятно, о чём вообще пришло уведомление.
  const callbackUrl = paymentOrigin(req) + '/api/pay/' + p.id + '/callback?order=' + encodeURIComponent(id)
    + '&attempt=' + encodeURIComponent(attemptId) + '&token=' + attempt.token;
  let r, tries = 0;
  do {
    tries++;
    r = await p.createInvoice(s, {
      amount: ctx.amount, currency: ctx.currency, method, callbackUrl,
      // MeridianPay требует свой уникальный идентификатор сделки — им служит id
      // попытки. CrocoPAY поле игнорирует.
      externalId: attemptId
    });
    // Явное «реквизитов нет» означает, что счёт не создан. Повторять ту же кассу
    // имеет смысл, только когда за ней в очереди никого нет: у соседней пул
    // трейдеров свой, и переход к ней и быстрее, и вернее. Timeout и частичный
    // счёт сюда намеренно не попадают — первый запрос мог успеть создать сделку.
    if (lastInChain && tries < 2 && p.retryableStart(r)) {
      await shortPause(700 + crypto.randomInt(0, 500));
      // За короткую паузу мог оплатиться прежний счёт. Второй POST уже не нужен.
      if (terminalPaymentBody(db.getOrder(id))) break;
    } else break;
  } while (true);

  if (!r.ok) {
    if (r.invoice && p.validInvoiceId(r.invoice.id)) {
      // Частичный/подменённый счёт адресно сохраняем, но чужой реквизит в
      // верхнее состояние и на страницу покупателя не переносим.
      db.attachOrderInvoice(id, {
        attemptId, invoiceId: r.invoice.id, requisite: '', bank: r.invoice.bank,
        owner: '', method, actualMethod: r.invoice.method || '',
        actualGateway: r.invoice.gateway || '', actualRegion: r.invoice.region || '',
        expiresAt: r.invoice.expiresAt, providerTries: tries,
        /* То, что касса прислала и что мы забраковали, — отдельным полем для
         * разбора. Покупателю оно не показывается нигде (в `requisite` выше
         * пустая строка), а владельцу без него нечего предъявить кассе: отказ
         * выглядел бы как «у вас что-то не работает». */
        rejected: r.error === 'bad_requisite' ? {
          requisite: r.invoice.requisite, owner: r.invoice.owner,
          bank: r.invoice.bank, reason: r.reason || ''
        } : null
      });
      // Забракованную сделку освобождаем, если касса это умеет: реквизит
      // покупателю не показан, платить по нему никто не будет, а карта трейдера
      // иначе простоит зарезервированной весь свой срок. У CrocoPAY отмены нет
      // вовсе — там остаётся только дождаться таймера.
      if (p.cancel) p.cancel(s, r.invoice.id).catch(() => {});
    }
    const code = PAYMENTS.startErrorCode(r.error);
    db.failOrderPaymentAttempt(id, { attemptId, errorCode: code, providerTries: tries });
    // Пока POST ждал кассу, мог успешно закрыться прежний счёт. Финансовый факт
    // важнее отказа нового запроса: покупателя ведём на terminal-страницу, а не
    // оставляем с ложным «не удалось оплатить».
    const terminalAfterFailure = terminalPaymentBody(db.getOrder(id));
    if (terminalAfterFailure) return { done: true, status: 200, body: terminalAfterFailure };
    console.error(p.id + ' invoice:', code, '| способ', method, '| сумма', ctx.amount, ctx.currency, '| заказ', R.orderNo(order.number));
    return { code };
  }

  const attached = db.attachOrderInvoice(id, {
    attemptId, invoiceId: r.invoice.id, requisite: r.invoice.requisite,
    bank: r.invoice.bank, owner: r.invoice.owner,
    method, actualMethod: r.invoice.method,
    actualGateway: r.invoice.gateway || '', actualRegion: r.invoice.region || '',
    expiresAt: r.invoice.expiresAt,
    providerTries: tries
  });
  if (!attached) {
    return { done: true, status: 409, body: { ok: false, placed: true, errorCode: 'stale_attempt', error: 'Попытка оплаты устарела — обновите страницу' } };
  }
  const terminalAfterCreate = terminalPaymentBody(db.getOrder(id));
  if (terminalAfterCreate) return { done: true, status: 200, body: terminalAfterCreate };
  const body = { ok: true, placed: true, url: '/pay/' + encodeURIComponent(id) };
  /* Реквизиты НА НАШЕЙ СТРАНИЦЕ лучше ссылки на страницу кассы, поэтому счёт со
   * ссылкой не заканчивает очередь, а откладывается: спрашиваем следующую кассу
   * и берём ссылку, только если обычных реквизитов не дал никто.
   *
   * Ссылка — вынужденный вариант (CrocoPAY стала отвечать так на «перевод на
   * карту», см. lib/crocopay.js), и она уводит покупателя на чужой домен с
   * последнего шага покупки. Терять из-за этого оплату нельзя, но и
   * предпочитать её обычному переводу по номеру — тоже.
   *
   * Счёт при этом уже привязан к попытке и никуда не девается: если следующая
   * касса выдаст нормальные реквизиты, ссылочный останется в истории заказа
   * неоплаченным и сгорит по своему сроку. Покупателю он не показывается, а
   * значит и заплатить по нему мимо нас нельзя. */
  if (PAY.isPayLink(r.invoice.requisite) && !lastInChain) {
    return { deferred: true, status: 200, body };
  }
  return { done: true, status: 200, body };
}

function paymentAlternative(methods, current) {
  const list = (methods || []).filter(m => m.id !== current && PAY.isDomestic(m.id));
  const preferred = ['SBP', 'TO_CARD'];
  return preferred.map(id => list.find(m => m.id === id)).find(Boolean) || list[0] || null;
}

function terminalPaymentBody(order) {
  const status = order && order.payment && order.payment.status;
  if (status !== 'paid' && status !== 'mismatch') return null;
  return {
    ok: true, placed: true, reused: true, terminal: status,
    url: '/pay/' + encodeURIComponent(order.id)
  };
}

const paymentStartJobs = new Map();
const paymentReconcileJobs = new Map();
const UNRESOLVED_PAYMENT_TTL = 5 * 60 * 1000;
function shortPause(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

/* Вернуться с выбора способа к оформлению. Это НЕ отмена invoice у CrocoPAY:
 * такого API у кассы нет. Удаляем только чистый черновик, для которого ещё не
 * было ни одной платёжной попытки. После первого запроса реквизитов маршрут
 * fail-closed возвращает на оплату — даже если таймер ещё не появился: timeout
 * мог скрыть уже созданный у провайдера счёт.
 *
 * Оба действия оставляют cart_v1 и checkout_v1 в браузере. Разница только в
 * сообщении после возврата: «изменить» подсказывает продолжить оформление, а
 * «отменить» подтверждает, что прежнего черновика больше нет.
 */
app.post('/pay/:id/draft', (req, res) => {
  const order = ownOrder(req, req.params.id);
  if (!order) return sendNotFound(req, res);
  if (rateLimited(req, 'order-draft', 20, 10 * 60 * 1000, order.id)) {
    return res.redirect('/pay/' + encodeURIComponent(order.id), 303);
  }
  const intent = String(req.body && req.body.intent || '');
  if (intent !== 'edit' && intent !== 'cancel') {
    return res.redirect('/pay/' + encodeURIComponent(order.id), 303);
  }
  const discarded = db.discardDraftOrder(order.id);
  if (!discarded.ok) {
    return res.redirect('/pay/' + encodeURIComponent(order.id), 303);
  }
  const mine = Array.isArray(req.session.myOrders) ? req.session.myOrders : [];
  req.session.myOrders = mine.filter(id => id !== order.id);
  res.redirect('/checkout?returned=' + intent, 303);
});

/* Покупатель отменяет оплату сам — строкой внизу страницы своих реквизитов.
 *
 * Это не отмена счёта у кассы, а ровно та же отметка, что раньше ставил
 * менеджер кнопкой в панели (`setOrderVoided`): заказ перестаёт числиться
 * ждущим денег, полоса напоминания на витрине гаснет, а страница оплаты говорит,
 * что заказ закрыт. Кнопки в панели больше нет — лишний заказ менеджер удаляет,
 * и для покупателя он тоже пропадает.
 *
 * ТОЛЬКО У СВОИХ РЕКВИЗИТОВ. Заказ, который ведёт касса, покупателю отменять
 * нечем: счёт живёт у неё, деньги по нему бывают в пути, и связать поздний
 * перевод с «отменённым» заказом было бы уже не с чем.
 *
 * Отменённое рукой обратно не возвращается: у покупателя товары ждут его на
 * оформлении (снимок корзины возвращает витрина по `restoreOrder` ниже), и
 * оформить заказ заново дешевле, чем воскрешать прежний.
 */
app.post('/pay/:id/cancel', (req, res) => {
  const order = ownOrder(req, req.params.id);
  if (!order) return sendNotFound(req, res);
  const back = '/pay/' + encodeURIComponent(order.id);
  if (rateLimited(req, 'order-cancel', 20, 10 * 60 * 1000, order.id)) return res.redirect(back, 303);
  // Оплаченный заказ покупатель не отменяет: деньги уже у магазина, и решается
  // это разговором с менеджером, а не пометкой в списке.
  if (order.payMode !== 'own' || order.manualPaid) return res.redirect(back, 303);
  const result = db.setOrderVoided(order.id, true, 'customer');
  if (!result.ok) return res.redirect(back, 303);
  req.session.restoreOrder = order.id;
  res.redirect('/checkout?returned=cancel', 303);
});

/* Сверить ОДНУ адресную попытку с GET /invoices/{id}. Это единственное место,
 * которое принимает ответ кассы за факт оплаты: и browser polling, и webhook,
 * и фоновая проверка приходят сюда. Подписанный webhook сам по себе суммы больше
 * не трактует — двусмысленность «рубли или копейки» допускала оплату одним
 * процентом суммы. */
async function reconcilePaymentAttempt(s, orderId, attempt) {
  // Сверять счёт обязана ТА ЖЕ касса, которая его выдала: id сделки у них свои,
  // и спросить чужую — значит получить «не найдено» и решить, что счёт сгорел.
  // У попыток, записанных до появления второй кассы, поля нет вовсе, и
  // `provider()` читает их как CrocoPAY: другой тогда и не было.
  const p = PAYMENTS.provider(attempt && attempt.provider);
  if (!attempt || !attempt.invoiceId || !p || !p.configured(s)) {
    return { ok: false, error: 'not_reconcilable' };
  }
  const invoiceId = String(attempt.invoiceId);
  const reconcileKey = String(orderId) + ':' + String(attempt.id || '') + ':' + invoiceId;
  if (paymentReconcileJobs.has(reconcileKey)) return paymentReconcileJobs.get(reconcileKey);
  const job = (async () => {
    const r = await p.invoice(s, invoiceId);
    const state = r.ok && r.invoice ? (r.invoice.state || 'pending') : '';
    // Отмечаем каждый фактический GET, включая timeout: так зависшие первые
    // сорок счетов не голодают всю очередь. Это ещё и CAS-проверка, что попытка
    // существует и по-прежнему связана именно с этим invoice.
    const touched = db.refreshOrderPaymentAttempt(orderId, {
      attemptId: attempt.id, invoiceId,
      lastCheckedAt: Date.now(),
      lastCheckError: r.ok ? '' : PAYMENTS.startErrorCode(r.error),
      lastProviderState: state,
      expiresAt: r.ok && r.invoice && String(r.invoice.id || '') === invoiceId
        ? r.invoice.expiresAt : 0
    });
    if (!touched) return { ok: false, error: 'stale_attempt' };
    if (!r.ok) return { ok: false, error: r.error };
    const match = p.matchesInvoice(attempt, r.invoice);
    if (!match.ok) {
      console.error(p.id + ' reconcile: не совпал', match.reason, '| счёт', invoiceId, '| заказ', orderId);
      // GET по конкретному пути обязан вернуть тот же invoice id. Чужой/пустой
      // id не вправе даже закрыть попытку как Expired: старый счёт может быть
      // ещё платёжным, а закрытие покажет кнопку нового и создаст дубль.
      if (match.reason === 'invoice_id') {
        return { ok: false, error: 'invoice_id_mismatch' };
      }
      // Чужой Success никогда не становится paid. Состояние mismatch будит
      // менеджера, но только если касса утверждает, что деньги уже пришли.
      if (state === 'paid') {
        const note = `Сверка счёта: не совпали ${match.reason}`;
        const result = db.settleOrderPayment(orderId, {
          attemptId: attempt.id, invoiceId, status: 'mismatch', total: r.invoice.amount, note
        });
        if (!result || result.stale) return { ok: false, error: 'stale_attempt' };
        if (result && result.changed) notifyPayment(result.order, 'mismatch', note);
        return { ok: true, state: (result.attempt && result.attempt.status) || 'mismatch' };
      }
      // Закрывающий НЕуспешный статус безопасно записать даже при сломанной
      // метаинформации ответа: он не выдаёт товар и прекращает бессмысленный
      // фоновый polling этой попытки. Только `paid` требует полного совпадения.
      if (['expired', 'cancelled', 'failed'].includes(state)) {
        const result = db.settleOrderPayment(orderId, {
          attemptId: attempt.id, invoiceId, status: state, total: r.invoice.amount, note: ''
        });
        if (!result || result.stale) return { ok: false, error: 'stale_attempt' };
        return { ok: true, state: (result.attempt && result.attempt.status) || state };
      }
      return { ok: true, state: attempt.status || 'pending', mismatch: match.reason };
    }
    if (!state || state === 'pending') {
      return { ok: true, state: 'pending', expires: r.invoice.expiresAt || attempt.expiresAt || 0 };
    }
    const result = db.settleOrderPayment(orderId, {
      attemptId: attempt.id, invoiceId, status: state, total: r.invoice.amount, note: ''
    });
    if (!result || result.stale) return { ok: false, error: 'stale_attempt' };
    if (result && result.changed) notifyPayment(result.order, state, '');
    return { ok: true, state: (result.attempt && result.attempt.status) || state };
  })();
  paymentReconcileJobs.set(reconcileKey, job);
  try { return await job; }
  finally { paymentReconcileJobs.delete(reconcileKey); }
}

/* Что реально включено у кассы — способы и валюты. Спрашивается и на странице
 * оплаты, и в настройках: зашитый список правится только выкаткой, а у кассы
 * способ могли включить или выключить вчера. Ответ кэширован на пять минут,
 * поэтому запрос уходит не на каждое открытие. Касса молчит (нет ключей, оплата
 * выключена, сеть) — `null`, и вызывающий решает, что показать.
 */
async function livePayMethods(s) {
  try {
    // Спрашиваются ВСЕ включённые кассы разом, а витрине отдаётся объединение:
    // способ доступен, если его умеет хотя бы одна. Пересечение отняло бы у
    // покупателя ровно то, ради чего вторая касса и заводилась.
    return await PAYMENTS.availableOptions(s);
  } catch (e) { return null; }
}

/* Валюта счёта, курс и способы под неё — одним местом для страницы оплаты и для
 * выставления счёта. Порознь они разъехались бы на первом же несовпадении:
 * покупатель видел бы сумму в одной валюте, а счёт уходил бы в другой.
 *
 * Правила: валюта предлагается, только если она включена У КАССЫ и у неё задан
 * курс в настройках (без курса сумма счёта была бы выдумана). Выбор валюты
 * выключен — остаётся одна, по умолчанию. Рубль доступен всегда: цены в нём, и
 * курс у него 1.
 */
async function payContext(s, order, wanted) {
  const live = await livePayMethods(s);
  // Ответ приходит всегда, а вот ОТВЕТИЛА ЛИ хоть одна касса — говорит флаг: в
  // объекте лежит ещё и состояние каждой из них, и панель читает именно его.
  // Ограничивать список способов можно только живым ответом; молчание кассы
  // по-прежнему означает «условие не применяем», а не «способов нет».
  const answered = live && live.ok ? live : null;
  const base = PAY.BASE;
  const def = PAY.currencyCode(s.crocopayCurrency) || base;
  const rates = s.crocopayRates || {};
  const liveCodes = answered && answered.currencies.length ? answered.currencies : null;
  let codes = (liveCodes || [def]).filter(c => PAY.rateOf(rates, c) > 0);
  // Живой ответ важнее сохранённого default: раньше недоступная у кассы валюта
  // насильно добавлялась обратно, а при выключенном выборе оставляла страницу
  // без способов, хотя другая валюта была рабочей.
  if (!s.crocopayCurrencyChoice && codes.length) codes = [codes.includes(def) ? def : codes[0]];
  if (!codes.length) codes = [base];
  const asked = PAY.currencyCode(wanted);
  const currency = codes.includes(asked) ? asked : (codes.includes(def) ? def : codes[0]);
  const rate = PAY.rateOf(rates, currency);
  const sum = code => (code === base ? Number(order.total) || 0 : PAY.convert(order.total, PAY.rateOf(rates, code)));
  const amount = sum(currency);
  // Сумма в каждой валюте — чтобы покупатель выбирал, уже видя, сколько
  // переводить, а не узнавал это после нажатия.
  const amounts = {};
  for (const code of codes) amounts[code] = sum(code);
  // Способы — срез по выбранной валюте: у кассы они сгруппированы именно так, и
  // рублёвый способ в долларовом счёте не годится.
  const methods = PAYMENTS.enabled(s)
    ? PAY.allowed(answered ? (answered.byCurrency[currency] || []) : null, s.payMethods) : [];
  return { live, codes, currency, rate, amount, amounts, methods };
}

/* Выставить счёт по уже созданному заказу и отдать реквизиты.
 *
 * Касс за этим маршрутом может быть несколько, и покупатель об этом не узнаёт:
 * он выбрал способ, а очередь касс (`PAYMENTS.chainFor`) перебирается здесь —
 * первая отказала, сразу спрашиваем следующую, и всё это в пределах одного его
 * нажатия. Каждая попытка пишется в историю заказа своей строкой с именем кассы:
 * менеджеру в панели видно, кто выдал реквизиты и кто отказал.
 *
 * Адрес намеренно без имени кассы. Прежний `/api/pay/crocopay/start` остаётся
 * зарегистрированным ниже: страница оплаты, открытая до обновления процесса,
 * шлёт запрос ещё на него.
 */
async function startPaymentRoute(req, res) {
  const s = settings();
  if (!PAYMENTS.enabled(s)) return res.json({ ok: false, error: 'Онлайн-оплата отключена' }, 400);
  if (!paymentOrigin(req)) {
    return res.json({
      ok: false, errorCode: 'payment_origin_missing',
      error: 'Онлайн-оплата временно не настроена. Менеджер поможет оформить заказ.'
    }, 503);
  }
  const id = String((req.body && req.body.orderId) || '');
  const order = ownOrder(req, id);
  if (!order) return res.json({ ok: false, error: 'Заказ не найден' }, 404);
  const terminal = terminalPaymentBody(order);
  if (terminal) return res.json(terminal);
  if (rateLimited(req, 'pay', 20, 10 * 60 * 1000, id)) return res.json({ ok: false, error: 'Слишком часто. Попробуйте позже.' }, 429);
  if (db.isOrderArchived(order)) {
    return res.json({
      ok: false, placed: true, errorCode: 'order_archived',
      error: 'Заказ закрыт. Оформите новый заказ.'
    }, 410);
  }
  /* Срок оплаты заказа вышел — новый счёт ему не выставляем (`R.payExpired`).
   * Уже выданный живой счёт этой проверке не мешает: пока по нему можно
   * заплатить, заказ просроченным не считается, и выше он вернётся как `reused`. */
  if (R.payExpired(order)) {
    return res.json({
      ok: false, placed: true, errorCode: 'order_expired',
      error: 'Время на оплату этого заказа вышло. Оформите заказ заново.'
    }, 410);
  }
  // Пределы касс проверяем и здесь: заказ мог быть оформлен до их появления, а
  // счёт на такую сумму они всё равно не выставят.
  if (!PAYMENTS.payable(order.total, s)) return res.json({ ok: false, error: 'Эту сумму онлайн-оплата не принимает — менеджер свяжется с вами' }, 400);
  // Способ проверяем не только по своему закрытому списку, но и по тому, что
  // владелец оставил на витрине: скрытый в настройках способ не должен
  // проходить запросом мимо интерфейса.
  const method = String((req.body && req.body.method) || '');
  const requestId = String(req.body && req.body.requestId || '');
  if (!/^[a-f0-9]{32}$/.test(requestId)) {
    return res.json({ ok: false, error: 'Обновите страницу оплаты и попробуйте ещё раз' }, 400);
  }
  // Валюта счёта проверяется тем же местом, что и рисует выбор: подставить в
  // запрос валюту, которой у кассы нет или для которой не задан курс, нельзя.
  const ctx = await payContext(s, order, req.body && req.body.currency);
  if (!ctx.methods.some(m => m.id === method)) {
    return res.json({ ok: false, error: 'Выберите способ оплаты' }, 400);
  }
  if (!(ctx.amount > 0)) {
    return res.json({ ok: false, error: 'Оплата в этой валюте сейчас недоступна — выберите другую' }, 400);
  }
  // Очередь касс под этот способ и эту валюту. Пустая означает, что способ
  // прошёл проверку по списку витрины, но обслужить его сейчас некому — так
  // бывает, когда владелец выключил кассу между открытием страницы и нажатием.
  const chain = PAYMENTS.chainFor(s, ctx.live, method, ctx.currency, ctx.amount);
  if (!chain.length) {
    return res.json({ ok: false, error: 'Этот способ оплаты сейчас недоступен — выберите другой' }, 400);
  }
  // payContext ходит в кассу и может ждать сеть. За это время менеджер мог
  // отменить заказ, а webhook — оплатить его; перечитываем перед единственным
  // местом, где создаётся новая попытка.
  const currentOrder = ownOrder(req, id);
  if (!currentOrder) return res.json({ ok: false, error: 'Заказ не найден' }, 404);
  const currentTerminal = terminalPaymentBody(currentOrder);
  if (currentTerminal) return res.json(currentTerminal);
  // Удалённый администратором заказ остаётся в файле только ради уже выданных
  // счетов и позднего webhook. Новый invoice ему не создаём. Проверка стоит
  // после payContext/его await, чтобы закрыть гонку со свежим удалением.
  if (db.isOrderArchived(currentOrder) || currentOrder.manualVoid) {
    return res.json({
      ok: false, placed: true, errorCode: 'order_archived',
      error: 'Заказ закрыт. Оформите новый заказ.'
    }, 410);
  }
  // Тот же срок оплаты, перепроверенный после ожидания кассы: `payContext` ходит
  // в сеть, и полчаса могли выйти ровно за это время.
  if (R.payExpired(currentOrder)) {
    return res.json({
      ok: false, placed: true, errorCode: 'order_expired',
      error: 'Время на оплату этого заказа вышло. Оформите заказ заново.'
    }, 410);
  }
  // Сначала живая работа: после startOrderPayment попытка уже есть в файле, и
  // поиск known иначе возвращал 409 вместо ожидания того же Promise.
  const running = paymentStartJobs.get(id);
  if (running) {
    const same = running.requestId === requestId && PAYMENTS.sameStartRequest(running, {
      method, currency: ctx.currency, amount: ctx.amount
    });
    if (same) {
      const result = await running.promise;
      return res.json(result.body, result.status);
    }
    if (running.requestId === requestId) {
      return res.json({ ok: false, placed: true, errorCode: 'idempotency_conflict', error: 'Этот идентификатор уже используется для другого запроса.' }, 409);
    }
    return res.json({ ok: false, placed: true, errorCode: 'payment_processing', error: 'Уже подбираем реквизиты. Подождите несколько секунд.' }, 409);
  }

  // Потерянный ответ, повторённый с тем же requestId, разбирается ВНУТРИ очереди
  // касс: у каждой свой производный ключ (`PAYMENTS.requestIdFor`), и повтор
  // попадает ровно в те же попытки. Здесь остаётся только то, что общее для всей
  // очереди.

  // Старые версии разрешали заменить ещё живой invoice. Поэтому failed или
  // no-requisite наверху не даёт права выпустить третий счёт: ищем реквизиты
  // во ВСЕЙ истории и переиспользуем самый новый из действующих.
  const activeAttempt = R.payDisplay(currentOrder.payment);
  // Полученные реквизиты не отменяются и не заменяются до конца их таймера.
  // Потерянный ответ после attach поэтому всегда открывает тот же живой счёт,
  // а не создаёт второй поверх него.
  if (activeAttempt && R.payLive(activeAttempt)) {
    return res.json({ ok: true, placed: true, reused: true, url: '/pay/' + encodeURIComponent(id) });
  }
  // Лимит по order id не мешает нескольким покупателям за одним Tor-exit, но
  // сам по себе обходится созданием множества своих заказов. До реального POST
  // ставим ещё широкий IP-предел и общий бюджет процесса. Idempotent/reuse/live
  // ответы дошли сюда раньше и бюджет кассы не расходуют.
  if (rateLimited(req, 'pay-provider-ip', 80, 10 * 60 * 1000)
    || rateLimited(req, 'pay-provider-global', 160, 10 * 60 * 1000, 'all')) {
    return res.json({
      ok: false, placed: true, errorCode: 'rate_limited',
      error: 'Касса временно перегружена. Подождите минуту и попробуйте снова.'
    }, 429);
  }

  const promise = (async () => {
    // Способ выбран — черновик становится заказом ДО обращения к кассам: даже
    // при отказе всех менеджер видит готового покупателя и может довести оплату
    // вручную.
    const grown = db.promoteOrder(id);
    if (grown.promoted) {
      metrics.markOrder(grown.order.visitorId, grown.order);
      notifyNewOrder(grown.order);
    }

    // Перебираем кассы по очереди. Для покупателя это одно нажатие: он не знает
    // ни сколько их, ни какая ответила.
    const tried = [];          // [{provider, code}] — для Telegram и статистики
    let conflict = false;      // тот же requestId прислан с другим способом/суммой
    let processing = false;    // ответ прошлого POST потерян — новый слать нельзя
    let linkFallback = null;   // счёт со ссылкой: годится, но уступает реквизитам

    for (let i = 0; i < chain.length; i++) {
      const p = chain[i];
      const providerRequestId = PAYMENTS.requestIdFor(requestId, p.id);
      const fresh = db.getOrder(id) || currentOrder;

      // Повтор того же нажатия: у этой кассы попытка уже есть.
      const known = db.findPaymentAttempt(fresh, { requestId: providerRequestId });
      if (known) {
        if (!PAYMENTS.sameStartRequest(known, { method, currency: ctx.currency, amount: ctx.amount })) {
          conflict = true;
          break;
        }
        // Реквизиты этой кассы уже на руках — открываем их, а не создаём второй счёт.
        if (known.status === 'pending' && R.payLive(known) && !known.lastErrorCode) {
          return { status: 200, body: { ok: true, placed: true, reused: true, url: '/pay/' + encodeURIComponent(id) } };
        }
        // Эта касса на этом же нажатии уже отказала — идём к следующей.
        if (known.lastErrorCode) { tried.push({ provider: p.id, code: known.lastErrorCode }); continue; }
        // Попытка есть, ошибки нет, реквизитов нет: ответ прошлого POST потерян.
        // Второй POST в ту же кассу мог бы выпустить дубль счёта.
        processing = true;
        continue;
      }

      // После timeout/рестарта invoice id мог не сохраниться. Новый запрос ТЕМ
      // ЖЕ способом в ТУ ЖЕ кассу блокируем на пять минут — но соседняя касса
      // остаётся свободной, и покупка спасается через неё.
      const now = Date.now();
      const unresolved = db.paymentAttempts(fresh).find(attempt => {
        const age = now - Number(attempt.startedAt || 0);
        return attempt.status === 'pending' && !attempt.invoiceId && attempt.method === method
          && (attempt.provider || PAYMENTS.DEFAULT_ID) === p.id
          && attempt.requestId !== providerRequestId && age >= 0 && age < UNRESOLVED_PAYMENT_TTL
          && (!attempt.lastErrorCode || ['timeout', 'provider_error'].includes(attempt.lastErrorCode));
      });
      if (unresolved) { processing = true; continue; }

      // Повторять ту же кассу на «нет свободных реквизитов» имеет смысл только
      // когда за ней никого нет: у соседней пул трейдеров свой, и перейти к ней
      // быстрее и вернее, чем ждать у этой.
      const outcome = await requestInvoiceFrom(p, s, req, order, ctx, method, providerRequestId,
        i === chain.length - 1);
      if (outcome.done) return { status: outcome.status, body: outcome.body };
      // Счёт со ссылкой на страницу кассы: держим про запас и спрашиваем
      // следующую — обычные реквизиты на нашей странице лучше (см.
      // requestInvoiceFrom). Первый такой и остаётся запасным: второй ссылочный
      // счёт ничем не лучше первого, а лишний счёт у кассы — хуже.
      if (outcome.deferred) {
        if (!linkFallback) linkFallback = outcome;
        tried.push({ provider: p.id, code: 'link_only' });
        continue;
      }
      tried.push({ provider: p.id, code: outcome.code });
    }

    if (conflict) {
      return { status: 409, body: { ok: false, placed: true, errorCode: 'idempotency_conflict', error: 'Этот идентификатор уже использован для другого запроса.' } };
    }
    /* Обычных реквизитов не дал никто — открываем отложенный счёт со ссылкой.
     * Стоит это ВЫШЕ «подождите»: ссылка на руках лучше просьбы вернуться
     * позже, и счёт по ней уже выставлен. */
    if (linkFallback) return { status: linkFallback.status, body: linkFallback.body };
    // Хоть одна касса могла молча выпустить счёт, ответ которого до нас не
    // дошёл. Пока это не выяснено, честнее попросить подождать, чем звать
    // покупателя платить ещё раз и рисковать вторыми реквизитами.
    if (processing) {
      const alt = paymentAlternative(ctx.methods, method);
      return {
        status: 409,
        body: {
          ok: false, placed: true, errorCode: 'payment_processing',
          error: 'Предыдущий запрос ещё может обрабатываться. Новый счёт тем же способом пока не создаём.',
          suggestedMethod: alt && alt.id, suggestedName: alt && alt.name
        }
      };
    }
    // Отказали все. Покупателю — одна фраза и один совет: про то, что касс было
    // несколько, он знать не должен.
    const code = PAYMENTS.summaryErrorCode(tried.map(t => t.code));
    notifyPaymentProblem(db.getOrder(id) || currentOrder, method, tried);
    const alt = paymentAlternative(ctx.methods, method);
    return {
      status: 502,
      body: {
        ok: false, placed: true, error: PAYMENTS.startError(code),
        errorCode: code,
        suggestedMethod: alt && alt.id, suggestedName: alt && alt.name
      }
    };
  })();
  paymentStartJobs.set(id, { requestId, method, currency: ctx.currency, amount: ctx.amount, promise });
  try {
    const result = await promise;
    res.json(result.body, result.status);
  } finally {
    const active = paymentStartJobs.get(id);
    if (active && active.promise === promise) paymentStartJobs.delete(id);
  }
}
app.post('/api/pay/start', startPaymentRoute);
// Прежний адрес с именем кассы: страница оплаты, открытая до обновления
// процесса, шлёт запрос ещё на него, и терять такую покупку незачем.
app.post('/api/pay/crocopay/start', startPaymentRoute);

// Статус счёта — то, ради чего затевался переход на H2H. Спрашиваем ту кассу,
// которая выдала счёт, и записываем изменение у себя; страница оплаты дёргает
// этот адрес по таймеру.
async function paymentStatusRoute(req, res) {
  const s = settings();
  const order = ownOrder(req, req.query.order);
  const pay = order && order.payment;
  if (!pay) return res.json({ ok: false, error: 'Оплата не запускалась' }, 404);
  // Уже полученные деньги кассу больше не тревожат. `mismatch` тоже terminal:
  // старая вкладка с другим live invoice не должна продолжать просить платить,
  // пока менеджер разбирает уже пришедшую сумму.
  if (pay.status === 'paid' || pay.status === 'mismatch') {
    return res.json({ ok: true, state: pay.status });
  }
  if (rateLimited(req, 'pay-status', 240, 10 * 60 * 1000, order.id)) return res.json({ ok: false, error: 'Слишком часто' }, 429);
  // Страница может показывать прежний живой invoice из истории, если новая
  // попытка завершилась отказом. Опрос адресуем id именно показанной попытки,
  // иначе реквизиты A на экране сверялись бы по состоянию B.
  const askedAttempt = String(req.query.attempt || '');
  const attempt = askedAttempt
    ? (/^[a-f0-9]{24,64}$/.test(askedAttempt) ? db.findPaymentAttempt(order, { attemptId: askedAttempt }) : null)
    : db.findPaymentAttempt(order, { attemptId: pay.attemptId })
      || db.findPaymentAttempt(order, { invoiceId: pay.invoiceId });
  if (!attempt) return res.json({ ok: false, error: 'Счёт не найден' }, 404);
  // Снятая галочка отключает НОВЫЕ счета, но ключи остаются и прежний счёт
  // обязан сверяться до конца. Поэтому configured(), а не enabled() — и у ТОЙ
  // кассы, которая счёт выдала: выключенная вторая на это не влияет никак.
  const issuer = PAYMENTS.provider(attempt.provider);
  if (!issuer || !issuer.configured(s) || !attempt.invoiceId) {
    return res.json({ ok: true, state: attempt.status || pay.status || 'pending' });
  }
  // Один живой счёт штатно даёт около 86 GET за десять минут. Пределы высокие,
  // чтобы общий Tor-exit не мешал покупателям, но не позволяют сотне созданных
  // ботом заказов умножить запросы к внешней кассе без границы.
  if (rateLimited(req, 'pay-status-provider-ip', 1800, 10 * 60 * 1000)
    || rateLimited(req, 'pay-status-provider-global', 3600, 10 * 60 * 1000, 'all')) {
    return res.json({ ok: false, error: 'Слишком много проверок. Повторим автоматически.' }, 429);
  }
  const result = await reconcilePaymentAttempt(s, order.id, attempt);
  // Пока GET по показанному A ждал кассу, webhook мог подтвердить другую
  // попытку B. Свежий aggregate перечитываем после сети: paid/mismatch всегда
  // важнее запоздалого pending A и немедленно убирает предложение платить ещё.
  const latest = db.getOrder(order.id);
  const latestState = latest && latest.payment && latest.payment.status;
  if (latestState === 'paid' || latestState === 'mismatch') {
    return res.json({ ok: true, state: latestState });
  }
  if (!result.ok) return res.json({ ok: true, state: attempt.status || pay.status || 'pending', stale: true });
  res.json(result);
}
app.get('/api/pay/status', paymentStatusRoute);
// Тот же адрес, что был до второй кассы: открытая страница оплаты опрашивает его.
app.get('/api/pay/crocopay/status', paymentStatusRoute);

// Страница оплаты: реквизиты выставленного счёта либо выбор способа. Своя, а не
// форма платёжки, — это и есть разница между H2H и Express.
// В trackPage она намеренно не попадает: пришлось бы вносить её и в
// metricPublicPath, а живой посетитель уехал бы в «неподтверждённые».
app.get('/pay/:id', async (req, res) => {
  const order = ownOrder(req, req.params.id);
  if (!order) return sendNotFound(req, res);
  const s = settings();
  // Способы и валюты — те, что реально включены у кассы; выбранная валюта
  // приезжает в адресе, потому что её переключатель — обычные ссылки.
  const ctx = await payContext(s, order, req.query.currency);
  // payContext обращается к кассе. За это время другая вкладка могла запустить
  // invoice либо удалить чистый черновик через «Вернуться к оформлению».
  // Старый снимок не должен снова показать кнопки редактирования поверх уже
  // действующего счёта.
  const currentOrder = ownOrder(req, req.params.id);
  if (!currentOrder) return sendNotFound(req, res);
  res.send(R.payPage(s, currentOrder, pageOpts(req, {
    methods: ctx.methods,
    currencies: ctx.codes,
    currency: ctx.currency,
    amount: ctx.amount,
    amounts: ctx.amounts,
    orderArchived: db.isOrderArchived(currentOrder),
    canDiscardDraft: db.canDiscardDraftOrder(currentOrder),
    // Свои реквизиты владельца — третий режим витрины (см. lib/payments.js).
    // Заказ, оформленный в нём, кассы не касается вовсе.
    own: currentOrder.payMode === 'own' ? PAYMENTS.ownRequisites(s) : null,
    // На самой странице оплаты напоминать о неоплаченном счёте незачем: она и
    // есть напоминание.
    payRemind: null
  })));
});

/* Вебхук об оплате — свой адрес у каждой кассы.
 *
 * Адреса именные, и это не противоречие с «покупатель не знает про кассы»: сюда
 * ходит не он, а сама платёжка, по адресу, который мы ей сами и выдали при
 * создании счёта. Имя в пути говорит, ЧЬИМ ключом проверять уведомление.
 *
 * Что бы ни пришло в теле, деньгами это не становится: callback лишь будит
 * строгую сверку конкретного счёта через API кассы (`reconcilePaymentAttempt`).
 * У CrocoPAY подпись есть, но заказ и единицы суммы она не покрывает; у
 * MeridianPay подписи нет вовсе (алгоритм `integrity` не описан). И там и там
 * настоящее доказательство одно — ответ на наш собственный запрос статуса.
 */
function paymentCallbackRoute(providerId) {
  return async (req, res) => {
  const s = settings();
  const p = PAYMENTS.provider(providerId);
  const id = String(req.query.order || '');
  const attemptId = String(req.query.attempt || '');
  const token = String(req.query.token || '');
  const order = p && p.configured(s) ? db.getOrder(id) : null;
  // Новые callback адресуют попытку по attemptId. У уже выданных до обновления
  // счетов параметра нет — их находим по прежнему token, не теряя живые оплаты.
  const hasAttempt = attemptId !== '';
  const attempt = order && (hasAttempt
    ? (/^[a-f0-9]{24,64}$/.test(attemptId) ? db.findPaymentAttempt(order, { attemptId }) : null)
    : db.findPaymentAttempt(order, { token }));
  const expectedToken = String((attempt && attempt.token) || '');
  const expectedTokenBuffer = Buffer.from(expectedToken, 'utf8');
  const tokenBuffer = Buffer.from(token, 'utf8');
  const tokenOk = !!expectedToken && expectedTokenBuffer.length === tokenBuffer.length
    && crypto.timingSafeEqual(expectedTokenBuffer, tokenBuffer);
  // Попытка обязана принадлежать ТОЙ кассе, в чей адрес пришло уведомление:
  // иначе token счёта одной платёжки открывал бы сверку счёта другой.
  const ownAttempt = !!attempt && PAYMENTS.provider(attempt.provider) === p;
  if (!tokenOk || !ownAttempt || !p.verifyCallback(s, req.body, req.rawBody)) {
    // Как в документации: неподтверждённый вебхук — 403 и ничего не меняем.
    return res.json({ ok: false }, 403);
  }

  // Подпись (там, где она есть) подтверждает отправителя, но не единицы суммы и
  // не id счёта. Поэтому webhook — только сигнал немедленно запросить у кассы
  // конкретный счёт по API.
  if (!attempt.invoiceId) return res.json({ ok: false, retry: true }, 503);
  const result = await reconcilePaymentAttempt(s, id, attempt);
  if (!result.ok) return res.json({ ok: false, retry: true }, 503);
  res.json({ ok: true, state: result.state });
  };
}
app.post('/api/pay/crocopay/callback', paymentCallbackRoute('crocopay'));
app.post('/api/pay/meridianpay/callback', paymentCallbackRoute('meridianpay'));

// Оплата не должна зависеть от открытой вкладки покупателя. Раз в минуту
// сверяем недавние незакрытые счета; webhook и браузер используют тот же
// reconcile, поэтому повторное уведомление исключает changed в хранилище.
let paymentSweepBusy = false;
async function reconcileOpenPayments() {
  if (paymentSweepBusy) return;
  const s = settings();
  // Хотя бы одна касса с ключами — иначе сверять нечем. Какая именно выдала
  // конкретный счёт, разберётся `reconcilePaymentAttempt` по полю попытки.
  if (!PAYMENTS.configured(s)) return;
  paymentSweepBusy = true;
  try {
    const now = Date.now();
    const edge = now - 7 * 24 * 60 * 60 * 1000;
    const queue = [];
    for (const order of db.getOrders()) {
      if (!order.payment) continue;
      for (const attempt of db.paymentAttempts(order)) {
        if (!attempt.invoiceId || attempt.status === 'paid') continue;
        /* Сверить счёт может только ТА касса, что его выдала, и только пока у
         * неё есть ключи. Счета кассы, у которой ключи убрали, сверке не
         * поддаются — и без этой строки они забивали бы очередь: `reconcile`
         * выходит по `not_reconcilable`, не трогая `lastCheckedAt`, поэтому в
         * сортировке «сначала давно не проверенные» они вечно оказываются
         * первыми и вытесняют рабочие счета из бюджета в 40 штук. Пока касса
         * была одна, такого не случалось: без ключей проход просто не начинался.
         */
        const issuer = PAYMENTS.provider(attempt.provider);
        if (!issuer || !issuer.configured(s)) continue;
        const startedAt = Number(attempt.startedAt || order.createdAt || 0);
        if (!Number.isFinite(startedAt) || startedAt < edge || startedAt > now) continue;
        // Pending проверяем часто. Терминальные и mismatch ещё несколько дней
        // пересверяем реже: касса/webhook могут опоздать, а исправленный точный
        // Success должен дорасти до paid без ручного вмешательства.
        const interval = attempt.status === 'pending' ? 60 * 1000 : 15 * 60 * 1000;
        const checkedAt = Number(attempt.lastCheckedAt || 0);
        if (checkedAt > 0 && now - checkedAt < interval) continue;
        if (!['pending', 'expired', 'cancelled', 'failed', 'mismatch'].includes(attempt.status)) continue;
        queue.push([order.id, attempt]);
      }
    }
    // Сначала давно не проверенные: после каждого GET lastCheckedAt обновляется,
    // поэтому даже при очереди >40 следующие счета не голодают. Четыре запроса
    // параллельно держат проход короче минуты без шквала в кассу.
    queue.sort((a, b) => Number(a[1].lastCheckedAt || 0) - Number(b[1].lastCheckedAt || 0)
      || Number(a[1].startedAt || 0) - Number(b[1].startedAt || 0));
    const selected = queue.slice(0, 40);
    for (let i = 0; i < selected.length; i += 4) {
      await Promise.all(selected.slice(i, i + 4).map(async ([orderId, attempt]) => {
        try { await reconcilePaymentAttempt(s, orderId, attempt); } catch (e) {}
      }));
    }
  } finally { paymentSweepBusy = false; }
}
const paymentSweep = setInterval(() => { reconcileOpenPayments().catch(() => {}); }, 60 * 1000);
if (paymentSweep.unref) paymentSweep.unref();
/* ====================== /ОПЛАТА: CrocoPAY (схема H2H) ====================== */

/* Ненайденное В ПАНЕЛИ — это не 404 витрины.
 *
 * Прежде админские маршруты звали `sendNotFound()`, а он записывает просмотр
 * страницы `/404` с адресом запроса. То есть работа владельца — открыл заказ по
 * старой ссылке, зашёл в удалённый диалог — оседала в отчёте посетителей его же
 * магазина, в списке «неподтверждённых автоматических запросов», вместе с
 * адресами панели. Метрика считает ПОКУПАТЕЛЕЙ, и владельцу в ней не место.
 *
 * Вместо этого — возврат в свой раздел с объяснением: ровно так уже устроены
 * все прочие «не нашлось» в панели (`res.redirect('/admin/products')`,
 * `reviewsBackUrl(req.query, 'Отзыв не найден')`).
 */
function adminMissing(res, section, message) {
  return res.redirect(section + '?flash=' + encodeURIComponent(message), 303);
}

/* =========================== ПАНЕЛЬ (/admin) =========================== *
 * Панель одна и с полными правами: каталог, модерация отзывов, заказы, метрика
 * и все настройки магазина. Раньше их было две — /owner для общего каталога и
 * /admin для цен и видимости на конкретном домене; домен остался один, и
 * разделять права стало не с кем.
 */

function guardAdmin(req, res) { if (adminAuthorized(req)) return true; res.redirect('/admin/login'); return false; }
// Тот же guard для запросов из скриптов панели: редирект вместо JSON там читался
// бы как успех.
function guardApi(req, res) { if (adminAuthorized(req)) return true; res.json({ ok: false, error: 'auth' }, 401); return false; }

app.get('/admin/login', (req, res) => {
  if (adminAuthorized(req)) return res.redirect('/admin');
  res.send(A.loginPage(settings(), null));
});
app.post('/admin/login', async (req, res) => {
  if (loginBlocked(req)) return res.send(A.loginPage(settings(), TOO_MANY), 429);
  const s = settings();
  // Scrypt выполняется и при неверном логине: время ответа не выдаёт имя учётной записи.
  const passwordOk = await auth.verifyPasswordAsync(req.body.password, s.adminPasswordHash);
  const ok = req.body.username === s.adminUsername && passwordOk;
  if (!ok) { loginFail(req); return res.send(A.loginPage(s, 'Неверный логин или пароль'), 401); }
  loginOk(req);
  req.session.admin = authStamp(s.adminUsername, s.adminPasswordHash);
  res.redirect('/admin');
});
app.post('/admin/logout', (req, res) => { req.session = null; res.redirect('/admin/login'); });

/* Живые обновления: вкладка панели держит этот ответ открытым и получает по нему
 * номера версий тем, за которыми следит (`lib/live.js`). Сама разметка приходит
 * потом обычным запросом той же страницы — здесь ходят только числа.
 *
 * guardApi, а не guardAdmin: редирект на страницу входа EventSource прочитал бы
 * как поток данных и молча зациклился бы на нём.
 */
app.get('/admin/live', (req, res) => {
  if (!guardApi(req, res)) return;
  LIVE.subscribe(req, res, req.query.topics);
});

// Пульс витрины («сейчас на сайте» и сегодняшние сутки) — на «Обзоре»: полную
// сводку там считать незачем, а число людей на сайте прямо сейчас — то, ради
// чего панель и открывают.
app.get('/admin', (req, res) => { if (!guardAdmin(req, res)) return; res.send(A.dashboard(settings(), db, metrics.pulse())); });
app.get('/admin/analytics', (req, res) => {
  if (!guardAdmin(req, res)) return;
  res.send(A.analyticsPage(settings(), db, metrics.snapshot({ days: req.query.days })));
});

/* «Кто заходил»: вся история посещений за год с отбором по датам, технике и
 * источнику. Регистрируется РАНЬШЕ `/admin/analytics/visitor/:key` — пути
 * разные, но правило «первый совпавший выигрывает» в этом файле общее, и
 * держать соседние маршруты в порядке от частного к общему дешевле, чем
 * однажды выяснить, что `visitors` уехал в карточку посетителя.
 *
 * Все значения приходят из адреса и уходят в модель как есть: там они и
 * проверяются (даты — регуляркой, сортировка — списком, потолок выдачи —
 * зажимается). Своей проверки здесь нет, иначе их стало бы две. */
app.get('/admin/analytics/visitors', (req, res) => {
  if (!guardAdmin(req, res)) return;
  const q = req.query || {};
  const ordered = String(q.ordered || '') === '1';
  const result = metrics.queryVisitors({
    from: q.from, to: q.to, device: q.device, browser: q.browser, system: q.system,
    source: q.source, ordered, sort: q.sort, show: Number(q.show) || VISITORS_PER_PAGE
  });
  res.send(A.visitorsPage(settings(), db, result, {
    device: q.device || '', browser: q.browser || '', system: q.system || '',
    source: q.source || '', ordered, today: metrics.today()
  }));
});

// Карточка посетителя: по ней открывается вся его история — визиты, страницы и
// время на них. Ключ в адресе — либо id метрики из cookie, либо IP: в заявках,
// оформленных до появления id (и теми, кто от метрики отказался), есть только
// адрес, а нажать на него менеджер должен уметь так же.
function lookupVisitor(rawKey) {
  let key = String(rawKey || '');
  try { key = decodeURIComponent(key); } catch (e) {}
  key = key.slice(0, 80);
  let visitor = /^[a-f0-9]{32}$/.test(key) ? metrics.findVisitor(key) : null;
  if (!visitor) visitor = metrics.findByIp(key)[0] || null;
  if (!visitor) return { key, visitor: null, orders: [], alsoOnIp: [] };
  // Черновиков здесь нет: блок называется «Покупки», и заявка, брошенная на
  // выборе способа оплаты, читалась бы в нём как состоявшийся заказ. Увидеть её
  // можно в списке заказов — там у неё своё состояние.
  const orders = db.visibleOrders()
    .filter(o => !o.draft)
    .filter(o => o.visitorId === visitor.id || (!o.visitorId && visitor.ip && o.clientIp === visitor.ip))
    .slice(0, 20);
  // За одним адресом сидит целая квартира или офис — соседние карточки полезны
  // ровно тем, что показывают: это тот же человек или всё-таки другой.
  const alsoOnIp = metrics.findByIp(visitor.ip).filter(x => x.id !== visitor.id).slice(0, 10);
  return { key, visitor, orders, alsoOnIp };
}

app.get('/admin/analytics/visitor/:key', (req, res) => {
  if (!guardAdmin(req, res)) return;
  const found = lookupVisitor(req.params.key);
  res.send(A.visitorPage(settings(), db, found.visitor, found), found.visitor ? 200 : 404);
});

/* ---------- Каталог ---------- */
// Поля товара из формы. Одна функция на создание и на правку: раньше два
// одинаковых объекта стояли в двух маршрутах и успевали разойтись.
function productFields(req) {
  return {
    name: req.body.name, category: req.body.category, price: req.body.price,
    // Скидка приходит процентом, старая цена не приходит вовсе: она из него
    // выводится (lib/discount.js), и второго источника у неё быть не должно.
    discountPercent: String(req.body.discountPercent == null ? '' : req.body.discountPercent).trim().replace(',', '.'),
    inStock: req.body.inStock !== undefined, visible: req.body.visible !== undefined, stockLevel: req.body.stockLevel,
    // Снятая галочка приходит отсутствием поля — как у inStock и visible.
    noPriceFloat: req.body.noPriceFloat !== undefined,
    shortDesc: req.body.shortDesc, description: req.body.description, specs: req.body.specs,
    colors: parseColors(req.body.colors), storages: parseStorages(req.body.storages),
    bands: parseBands(req.body.bands), options: parseOptions(req.body.options)
  };
}

app.get('/admin/products', (req, res) => { if (!guardAdmin(req, res)) return; res.send(A.productsList(settings(), db, req.query.flash)); });
app.get('/admin/products/new', (req, res) => { if (!guardAdmin(req, res)) return; res.send(A.productForm(settings(), db, null)); });
app.post('/admin/products', async (req, res) => {
  if (!guardAdmin(req, res)) return;
  const errors = validateProduct(req.body);
  if (errors.length) return res.send(A.productForm(settings(), db, null, { errors, draft: req.body }), 400);
  db.createProduct(Object.assign(productFields(req), {
    images: await optimizeUploads(req.filesFor('images').slice(0, PRODUCT_IMAGE_MAX), 1200, { square: true })
  }));
  res.redirect('/admin/products?flash=' + encodeURIComponent('Товар создан'));
});
// Порядок товаров в каталоге = порядок карточек на главной. Регистрируется
// РАНЬШЕ «/admin/products/:id»: побеждает первый совпавший маршрут, и товар с
// id «order» иначе перехватил бы этот адрес (а точнее наоборот — сохранение
// товара приняло бы наш запрос за форму и обнулило бы карточку).
app.post('/admin/products/order', (req, res) => {
  if (!guardApi(req, res)) return;
  const next = db.reorderProducts(Array.isArray(req.body.ids) ? req.body.ids.slice(0, 5000) : []);
  if (!next) return res.json({ ok: false, error: 'invalid_order' }, 400);
  res.json({ ok: true, ids: next.map(p => p.id) });
});
app.get('/admin/products/:id/edit', (req, res) => {
  if (!guardAdmin(req, res)) return;
  const p = db.getProduct(req.params.id);
  if (!p) return res.redirect('/admin/products');
  res.send(A.productForm(settings(), db, p));
});
app.post('/admin/products/:id', async (req, res) => {
  if (!guardAdmin(req, res)) return;
  const p = db.getProduct(req.params.id); if (!p) return res.redirect('/admin/products');
  const errors = validateProduct(req.body);
  if (errors.length) return res.send(A.productForm(settings(), db, p, { errors, draft: req.body }), 400);
  const remove = asArray(req.body.removeImages);
  let images = (p.images || []).filter(src => !remove.includes(src));
  const fields = productFields(req);
  const colors = fields.colors;
  const colorNames = colors.map(c => c.name);
  // ключи вариаций ремешков вида «Коллекция|Цвет»
  const bandKeys = new Set();
  for (const g of fields.bands) for (const o of g.options) bandKeys.add(g.name + '|' + o.name);
  // Привязка фото: два независимых селекта — «imgcolor:<файл>» (цвет корпуса) и
  // «imgband:<файл>» (вариация ремешка «Коллекция|Цвет»). Они не исключают друг
  // друга: снимок «Alpine Loop на чёрном титане» несёт обе привязки сразу.
  // Раньше селект был один, и сохранение формы стирало корпус у фото ремешка —
  // после этого один и тот же снимок показывался под всеми цветами корпуса.
  const imageColors = {}, imageBands = {};
  for (const src of images) {
    const color = req.body['imgcolor:' + src];
    if (color && colorNames.includes(color)) imageColors[src] = color;
    const band = req.body['imgband:' + src];
    if (band && bandKeys.has(String(band))) imageBands[src] = String(band);
  }
  // Новые общие фото
  let imageSlots = Math.max(0, PRODUCT_IMAGE_MAX - images.length);
  const generalAdded = await optimizeUploads(req.filesFor('images').slice(0, imageSlots), 1200, { square: true });
  images = images.concat(generalAdded);
  imageSlots -= generalAdded.length;
  // Новые фото под конкретный цвет (поля imagesColor_<индекс цвета>)
  for (let ci = 0; ci < colors.length; ci++) {
    if (imageSlots <= 0) break;
    const added = await optimizeUploads(req.filesFor('imagesColor_' + ci).slice(0, imageSlots), 1200, { square: true });
    for (const f of added) { images.push(f); imageColors[f] = colors[ci].name; }
    imageSlots -= added.length;
  }
  db.updateProduct(p.id, Object.assign(fields, { images, imageColors, imageBands }));
  remove.forEach(db.deleteUploadIfUnused);
  res.redirect('/admin/products?flash=' + encodeURIComponent('Сохранено'));
});
app.post('/admin/products/:id/delete', (req, res) => {
  if (!guardAdmin(req, res)) return;
  db.deleteProduct(req.params.id);
  res.redirect('/admin/products?flash=' + encodeURIComponent('Товар удалён'));
});

/* --- Фото товара без перезагрузки страницы (мгновенная загрузка и удаление) --- */

// Загрузить фото сразу: сохраняет в товар и возвращает готовые файлы
app.post('/admin/products/:id/images/add', async (req, res) => {
  if (!guardApi(req, res)) return;
  const p = db.getProduct(req.params.id);
  if (!p) return res.json({ ok: false, error: 'not_found' }, 404);
  const available = Math.max(0, PRODUCT_IMAGE_MAX - (p.images || []).length);
  if (!available) return res.json({ ok: false, error: 'image_limit', limit: PRODUCT_IMAGE_MAX }, 409);
  let added = await optimizeUploads(req.filesFor('images').slice(0, available), 1200, { square: true });
  if (!added.length) return res.json({ ok: false, error: 'no_files' }, 400);
  const current = db.getProduct(req.params.id);
  if (!current) { added.forEach(db.deleteUploadIfUnused); return res.json({ ok: false, error: 'not_found' }, 404); }
  const currentRoom = Math.max(0, PRODUCT_IMAGE_MAX - (current.images || []).length);
  if (added.length > currentRoom) {
    added.slice(currentRoom).forEach(db.deleteUploadIfUnused);
    added = added.slice(0, currentRoom);
  }
  if (!added.length) return res.json({ ok: false, error: 'image_limit', limit: PRODUCT_IMAGE_MAX }, 409);
  const color = String(req.body.color || '').trim();
  const valid = (current.colors || []).some(c => c.name === color);
  // Фото можно грузить сразу в конкретную вариацию ремешка: «Коллекция|Цвет»
  const band = String(req.body.band || '').trim();
  const bandValid = band && (current.bands || []).some(g => (g.options || []).some(o => g.name + '|' + o.name === band));
  const images = (current.images || []).concat(added);
  const imageColors = Object.assign({}, current.imageColors || {});
  const imageBands = Object.assign({}, current.imageBands || {});
  // Снимок может относиться и к ремешку, и к цвету корпуса сразу: один ремешок
  // на натуральных и на чёрных часах выглядит по-разному.
  if (bandValid) added.forEach(f => { imageBands[f] = band; });
  if (color && valid) added.forEach(f => { imageColors[f] = color; });
  db.updateProduct(current.id, { images, imageColors, imageBands });
  res.json({ ok: true, images: added.map(f => ({
    src: f,
    color: (color && valid) ? color : '',
    band: bandValid ? band : ''
  })) });
});

// Изменить порядок фотографий. Принимается только точная перестановка текущего списка:
// добавить чужой файл или случайно потерять существующий через этот маршрут нельзя.
app.post('/admin/products/:id/images/order', (req, res) => {
  if (!guardApi(req, res)) return;
  const p = db.getProduct(req.params.id);
  if (!p) return res.json({ ok: false, error: 'not_found' }, 404);
  const current = (p.images || []).map(String);
  const requested = Array.isArray(req.body.images) ? req.body.images.map(String) : [];
  if (!IMG.validImageOrder(current, requested)) return res.json({ ok: false, error: 'invalid_order' }, 400);
  db.updateProduct(p.id, { images: requested });
  res.json({ ok: true, images: requested });
});

// Сделать фото главным: оно идёт первым в галерее и на карточке товара
app.post('/admin/products/:id/images/main', (req, res) => {
  if (!guardApi(req, res)) return;
  const p = db.getProduct(req.params.id);
  if (!p) return res.json({ ok: false, error: 'not_found' }, 404);
  const src = String(req.body.src || '');
  if (!src || !(p.images || []).includes(src)) return res.json({ ok: false, error: 'no_image' }, 400);
  db.updateProduct(p.id, { images: [src].concat((p.images || []).filter(x => x !== src)) });
  res.json({ ok: true, main: src });
});

// Привязать фото к цвету корпуса и/или к ремешку (или снять привязку) — сразу,
// без сохранения формы. Привязки независимы: приходит только то поле, которое
// меняли, второе остаётся как было — иначе смена ремешка сбрасывала корпус.
app.post('/admin/products/:id/images/color', (req, res) => {
  if (!guardApi(req, res)) return;
  const p = db.getProduct(req.params.id);
  if (!p) return res.json({ ok: false, error: 'not_found' }, 404);
  const src = String(req.body.src || '');
  if (!src || !(p.images || []).includes(src)) return res.json({ ok: false, error: 'no_image' }, 400);
  const imageColors = Object.assign({}, p.imageColors || {});
  const imageBands = Object.assign({}, p.imageBands || {});
  if (req.body.color !== undefined) {
    const color = String(req.body.color || '').trim();
    delete imageColors[src];
    if (color && (p.colors || []).some(c => c.name === color)) imageColors[src] = color;
  }
  if (req.body.band !== undefined) {
    const key = String(req.body.band || '').trim();
    delete imageBands[src];
    if (key && (p.bands || []).some(g => (g.options || []).some(o => g.name + '|' + o.name === key))) imageBands[src] = key;
  }
  db.updateProduct(p.id, { imageColors, imageBands });
  res.json({ ok: true, color: imageColors[src] || '', band: imageBands[src] || '' });
});

// Удалить фото: убирает из товара и стирает файл с диска
app.post('/admin/products/:id/images/remove', (req, res) => {
  if (!guardApi(req, res)) return;
  const p = db.getProduct(req.params.id);
  if (!p) return res.json({ ok: false, error: 'not_found' }, 404);
  const src = String(req.body.src || '');
  if (!src || !(p.images || []).includes(src)) return res.json({ ok: false, error: 'no_image' }, 400);
  const images = (p.images || []).filter(x => x !== src);
  const imageColors = Object.assign({}, p.imageColors || {});
  const imageBands = Object.assign({}, p.imageBands || {});
  delete imageColors[src]; delete imageBands[src];   // не оставляем привязку удалённого файла
  db.updateProduct(p.id, { images, imageColors, imageBands });
  // сам файл удаляем только если он больше нигде не используется
  const used = db.getProducts().some(x => (x.images || []).includes(src));
  if (!used) db.deleteUploadIfUnused(src);
  res.json({ ok: true });
});

/* ---------- Отзывы: модерация и правка ---------- */
const REVIEW_PHOTO_MAX = 12;
// Миниатюры для добавленных из панели снимков: в ленте вложений показывается
// именно превью, а полный файл грузится только в просмотрщике. Нет ImageMagick —
// вернётся пустая строка, и вложение покажется самим снимком, как раньше.
async function reviewPreviews(files) {
  const out = {};
  for (const f of files) { const thumb = await IMG.makeThumb(db.UPLOAD_DIR, f); if (thumb) out[f] = thumb; }
  return out;
}
// Вход в раздел — очередь модерации и ничего кроме неё: ни вкладок, ни
// сортировки. Прежние `status` и `sort` в адресе (ссылки из закладок, возврат
// после действия) просто ничего не значат.
app.get('/admin/reviews', (req, res) => { if (!guardAdmin(req, res)) return; res.send(A.reviewsList(settings(), db, req.query.flash, req.query.page)); });
app.get('/admin/reviews/new', (req, res) => { if (!guardAdmin(req, res)) return; res.send(A.reviewForm(settings(), db, null, { productId: req.query.productId })); });
app.post('/admin/reviews/new', async (req, res) => {
  if (!guardAdmin(req, res)) return;
  const p = db.getProduct(req.body.productId); if (!p) return res.redirect('/admin/reviews');
  /* Дата разбирается ДО загрузки файлов и до записи — то же правило, что у
   * формы правки рядом. Прежде негодная дата молча становилась «сейчас»: форма
   * отвечала «Отзыв добавлен», а отзыв вставал сегодняшним днём посреди набора
   * трёхлетней давности, и заметить это можно было только глазами на витрине.
   * Пустое поле — по-прежнему «сейчас», это законное значение. */
  const createdAt = parseDt(req.body.date);
  if (req.body.date && !createdAt) {
    // Черновик БЕЗ id — форма остаётся формой создания (см. `isEdit` там же).
    return res.send(A.reviewForm(settings(), db, {
      productId: p.id, author: req.body.author, rating: req.body.rating, text: req.body.text,
      config: req.body.config, delivery: req.body.delivery, status: req.body.status,
      reply: { text: req.body.reply }
    }, { flash: 'Не разобрали дату отзыва', flashType: 'err' }), 400);
  }
  const photos = await optimizeUploads(req.filesFor('photos').slice(0, REVIEW_PHOTO_MAX), 1400);
  db.createReview({
    productId: p.id, author: req.body.author, rating: req.body.rating, text: req.body.text,
    config: req.body.config, delivery: req.body.delivery, reply: { text: req.body.reply },
    photos, previews: await reviewPreviews(photos),
    status: req.body.status === 'pending' ? 'pending' : 'approved',
    createdAt: createdAt || Date.now()
  });
  res.redirect('/admin/reviews/product/' + encodeURIComponent(p.id) + '?flash=' + encodeURIComponent('Отзыв добавлен'));
});
// Раньше маршрута с :id — побеждает первый совпавший, и отзыв с id «product»
// иначе перехватил бы ленту товара.
app.get('/admin/reviews/product/:productId', (req, res) => {
  if (!guardAdmin(req, res)) return;
  const p = db.getProduct(req.params.productId);
  if (!p) return res.redirect('/admin/reviews');
  res.send(A.productReviews(settings(), db, p, req.query.status, req.query.flash, req.query.page, req.query.sort, req.query.media));
});
app.get('/admin/reviews/:id/edit', (req, res) => {
  if (!guardAdmin(req, res)) return;
  const rv = db.getReview(req.params.id);
  if (!rv) return res.redirect(reviewsBackUrl(req.query, 'Отзыв не найден'));
  res.send(A.reviewForm(settings(), db, rv, { back: backFrom(req.query) }));
});
app.post('/admin/reviews/:id/edit', async (req, res) => {
  if (!guardAdmin(req, res)) return;
  const rv = db.getReview(req.params.id);
  if (!rv) return res.redirect(reviewsBackUrl(req.body, 'Отзыв не найден'));
  const product = db.getProduct(req.body.productId);
  const author = String(req.body.author || '').trim();
  const createdAt = parseDt(req.body.date);
  // Проверка ДО записи и до сохранения файлов: иначе форма вернулась бы с
  // ошибкой, а половина правки уже лежала бы в хранилище (то же правило, что у
  // формы товара и настроек). Введённое возвращается вместе с ошибкой.
  const fail = (error) => res.send(A.reviewForm(settings(), db, Object.assign({}, rv, {
    productId: product ? product.id : rv.productId, author: req.body.author, rating: req.body.rating,
    text: req.body.text, config: req.body.config, delivery: req.body.delivery,
    reply: { text: req.body.reply, at: (rv.reply || {}).at },
    status: req.body.status, createdAt: createdAt || rv.createdAt
  }), { back: backFrom(req.body), flash: error, flashType: 'err' }), 400);
  if (!author) return fail('Укажите имя автора');
  if (req.body.date && !createdAt) return fail('Не разобрали дату отзыва');

  const dropped = new Set(asArray(req.body.drop).map(String));
  const room = Math.max(0, REVIEW_PHOTO_MAX - (rv.photos || []).filter(f => !dropped.has(f)).length);
  const added = await optimizeUploads(req.filesFor('photos').slice(0, room), 1400);
  db.updateReview(rv.id, {
    productId: product ? product.id : rv.productId,
    author, rating: req.body.rating, text: req.body.text, config: req.body.config,
    delivery: req.body.delivery, status: req.body.status,
    // Пустое поле — это удаление ответа, поэтому оно уходит в хранилище как есть.
    reply: { text: req.body.reply },
    createdAt: createdAt || rv.createdAt,
    photos: (rv.photos || []).filter(f => !dropped.has(f)).concat(added),
    videos: (rv.videos || []).filter(f => !dropped.has(f)),
    previews: await reviewPreviews(added)
  });
  res.redirect(reviewsBackUrl(req.body, 'Отзыв сохранён', 'rv-' + rv.id));
});
// Ответ магазина прямо из строки списка: отвечают там же, где разбирают ленту,
// и уводить ради двух строк текста в форму правки незачем. Пустое поле — это
// удаление ответа, поэтому отдельной ручки для него нет; кнопка «Удалить ответ»
// шлёт ту же форму с `drop` и текст не отправляет.
app.post('/admin/reviews/:id/reply', (req, res) => {
  if (!guardAdmin(req, res)) return;
  const rv = db.getReview(req.params.id);
  if (!rv) return res.redirect(reviewsBackUrl(req.body, 'Отзыв не найден'));
  const text = req.body.drop ? '' : String(req.body.reply || '');
  db.updateReview(rv.id, { reply: { text } });
  const saved = !!String(text).trim();
  res.redirect(reviewsBackUrl(req.body, saved ? 'Ответ сохранён' : 'Ответ удалён', 'rv-' + rv.id));
});
app.post('/admin/reviews/:id/approve', (req, res) => { if (!guardAdmin(req, res)) return; db.setReviewStatus(req.params.id, 'approved'); res.redirect(reviewsBackUrl(req.body, 'Отзыв опубликован')); });
// «Снять с витрины» — возврат в очередь модерации. Прежде отзыв прятали в
// админке домена; прятать его теперь негде и не от кого, а вот вернуть на
// доработку иногда нужно, и удаление для этого слишком грубо.
app.post('/admin/reviews/:id/hide', (req, res) => { if (!guardAdmin(req, res)) return; db.setReviewStatus(req.params.id, 'pending'); res.redirect(reviewsBackUrl(req.body, 'Отзыв снят с витрины')); });
app.post('/admin/reviews/:id/delete', (req, res) => { if (!guardAdmin(req, res)) return; db.deleteReview(req.params.id); res.redirect(reviewsBackUrl(req.body, 'Отзыв удалён')); });

/* ---------- Заказы ---------- */
app.get('/admin/orders', (req, res) => {
  if (!guardAdmin(req, res)) return;
  const html = A.ordersList(settings(), db, req.query.flash, req.query.page, req.query.edit, req.query);
  /* Список открыт — заявки увидены, счётчик в шапке гаснет. Метка ставится ПОСЛЕ
   * сборки страницы: иначе бейдж пропадал бы на той самой странице, ради которой
   * его нажали, и «сколько пришло» разглядеть было бы негде.
   *
   * Двигается она до времени самого свежего заказа, а не до «сейчас», поэтому
   * повторное открытие ничего не пишет — а значит, живое обновление панели не
   * гоняет запись по кругу (см. `markOrdersSeen` в lib/db.js).
   */
  db.markOrdersSeen();
  res.send(html);
});
app.post('/admin/orders/:id/reconcile', async (req, res) => {
  if (!guardAdmin(req, res)) return;
  const order = db.getOrder(req.params.id);
  const attemptId = String(req.body && req.body.attemptId || '');
  const attempt = order ? db.findPaymentAttempt(order, attemptId ? { attemptId } : {}) : null;
  let flash = 'Счёт не найден';
  if (order && attempt) {
    try {
      const result = await reconcilePaymentAttempt(settings(), order.id, attempt);
      const labels = {
        paid: 'Оплата подтверждена кассой', pending: 'Касса ещё ждёт оплату',
        mismatch: 'Деньги найдены, но реквизиты или сумма не совпали — нужна проверка',
        expired: 'Касса подтвердила истечение счёта', cancelled: 'Касса подтвердила отмену счёта',
        failed: 'Касса вернула отказ'
      };
      flash = result.ok
        ? (labels[result.state] || (result.mismatch ? 'Ответ кассы не совпал с заказом — нужна проверка' : 'Счёт перепроверен'))
        : (result.error === 'not_reconcilable'
          ? 'Этот счёт нельзя перепроверить: касса выключена или не настроена'
          : 'Касса не ответила. Состояние заказа не изменено');
    } catch (e) {
      flash = 'Касса не ответила. Состояние заказа не изменено';
    }
  }
  res.redirect(ordersBackUrl(req.body, flash), 303);
});
/* Ручная отметка «оплачено» — для перевода на СВОИ реквизиты владельца.
 *
 * Касса о таком переводе не знает, сверять его не с чем: единственный, кто
 * видит деньги, — человек в своём банковском приложении. Отметка снимается тем
 * же маршрутом: ошиблись строкой — вернули как было.
 *
 * Заказ, который ведёт касса, руками не трогаем вовсе (проверяет хранилище):
 * два источника правды об одних деньгах — худшее, что можно сделать с оплатой.
 */
app.post('/admin/orders/:id/paid', (req, res) => {
  if (!guardAdmin(req, res)) return;
  const paid = String(req.body && req.body.paid || '') === '1';
  const result = db.setOrderPaidManually(req.params.id, paid, 'admin');
  const flash = result.ok
    ? (paid ? 'Заказ отмечен оплаченным' : 'Отметка оплаты снята')
    : (result.reason === 'settled_by_provider'
      ? 'Этот заказ ведёт касса — её подтверждение рукой не меняется'
      : 'Заказ не найден');
  res.redirect(ordersBackUrl(req.body, flash), 303);
});
/* Отмены оплаты рукой в панели БОЛЬШЕ НЕТ — ни кнопки, ни маршрута.
 *
 * Отменяет теперь сам покупатель (`POST /pay/:id/cancel`): передумал он, и
 * узнавать об этом по телефону, чтобы нажать кнопку за него, менеджеру незачем.
 * Лишнюю заявку менеджер удаляет — заказа не остаётся вовсе, и для покупателя
 * он тоже закрыт. Сама отметка (`db.setOrderVoided`) при этом на месте: её
 * ставит маршрут покупателя, а панель показывает плашку «оплата отменена».
 */
/* Удаление заказа — сразу и насовсем. Корзины больше нет: «удалённые» были
 * нужны, пока деньги могли прийти по уже выданному счёту кассы, а платят по
 * своим реквизитам — ждать поздний callback не от кого. Цену решения панель
 * называет в подтверждении: у заказа с выставленным счётом связать поздний
 * платёж будет уже не с чем. */
app.post('/admin/orders/:id/delete', (req, res) => {
  if (!guardAdmin(req, res)) return;
  const result = db.purgeOrder(req.params.id);
  res.redirect(ordersBackUrl(req.body, result.ok ? 'Заказ удалён' : 'Заказ не найден'), 303);
});
/* Восстановления и «корзины» здесь больше нет: удаление окончательное (см.
 * маршрут выше). Заявки, заархивированные прежней версией, остаются в файле
 * невидимыми — стирать их молча мы не вправе, а показывать в списке уже
 * удалённое было бы неправдой.
 */

/* ---------- Отправление: маршрут посылки ---------- *
 *
 * Трек-номера у нас нет — посылку ведёт менеджер, и путь по стране рисует он же
 * здесь. Собирает маршрут `lib/tracking.js`, хранит его сам заказ, показывает
 * покупателю `/track/:number`.
 */
function shipmentSteps(body) {
  // Повторяющиеся поля формы приходят массивом (`addField` в server-lib), и
  // порядок в них — порядок строк таблицы. По нему же считается отметка «стоит
  // здесь»: отдельного идентификатора у шага нет и не нужно.
  const at = asArray(body.stepAt);
  const title = asArray(body.stepTitle);
  const place = asArray(body.stepPlace);
  const note = asArray(body.stepNote);
  const hold = Number(body.holdStep);
  const out = [];
  for (let i = 0; i < Math.max(at.length, title.length); i++) {
    const when = parseDt(at[i]);
    const name = String(title[i] || '').trim();
    // Пустая строка — не ошибка, а способ удалить шаг: заполненные три строки
    // внизу таблицы существуют ровно затем, чтобы дописать событие руками.
    if (!name || !when) continue;
    out.push({ at: when, title: name, place: place[i] || '', note: note[i] || '', hold: i === hold });
  }
  return out;
}

function shipmentForm(req, order) {
  const body = req.body || {};
  const s = settings();
  return {
    carrier: body.carrier,
    mode: body.mode,
    from: String(body.from || '').trim() || String(s.shipFromCity || '').trim() || TRACK.DEFAULT_FROM,
    to: String(body.to || '').trim(),
    zone: order.deliveryZone || '',
    days: body.days,
    holdDays: body.holdDays,
    // Снятая галочка приходит в теле формы отсутствием поля, как и все прочие в
    // панели. Маршрут, который ещё не показывают покупателю, — обычное дело:
    // его собирают до того, как посылку правда отдали перевозчику.
    visible: body.visible !== undefined,
    startedAt: parseDt(body.startedAt) || Date.now()
  };
}

/* Список отправлений — свой раздел меню.
 *
 * Регистрируется РАНЬШЕ `/admin/orders/:id/shipment`: пути разные, но правило в
 * панели одно — маршрут списка стоит выше маршрута со свободным `:id`, иначе
 * однажды заказ с подходящим идентификатором перехватит раздел.
 */
app.get('/admin/shipments', (req, res) => {
  if (!guardAdmin(req, res)) return;
  res.send(A.shipmentsPage(settings(), db, { tab: req.query.tab, page: req.query.page, flash: req.query.flash }));
});

app.get('/admin/orders/:id/shipment', (req, res) => {
  if (!guardAdmin(req, res)) return;
  const order = db.getOrder(req.params.id);
  if (!order) return adminMissing(res, '/admin/shipments', 'Заказ не найден');
  res.send(A.shipmentPage(settings(), db, order, { flash: req.query.flash, origin: originOf(req) }));
});

app.post('/admin/orders/:id/shipment', (req, res) => {
  if (!guardAdmin(req, res)) return;
  const order = db.getOrder(req.params.id);
  if (!order) return adminMissing(res, '/admin/shipments', 'Заказ не найден');
  const form = shipmentForm(req, order);
  // Проверка идёт ДО записи и возвращает введённое — то же правило, что у формы
  // товара и настроек: иначе правка теряется целиком.
  const fail = (error) => res.send(A.shipmentPage(settings(), db, order,
    { flash: error, flashType: 'err', draft: req.body, origin: originOf(req) }), 400);
  if (!form.to) return fail('Укажите город получения — без него маршрут не собрать');

  const rebuild = req.body.intent === 'rebuild' || !order.shipment;
  const steps = rebuild ? null : shipmentSteps(req.body);
  if (!rebuild && (!steps || !steps.length)) return fail('Оставьте хотя бы одно событие в пути');

  const shipment = rebuild
    // `seed` — id заказа: пересборка того же маршрута обязана давать те же
    // времена, иначе нажатие «Собрать заново» дважды тасовало бы часы у уже
    // случившихся событий.
    ? Object.assign(TRACK.build(Object.assign({}, form, { seed: order.id })),
      { holdDays: form.holdDays, visible: form.visible })
    : Object.assign({}, form, { steps });
  const saved = db.setOrderShipment(order.id, shipment);
  if (!saved.ok) return fail('Маршрут не сохранён: в нём нет ни одного события');
  res.redirect('/admin/orders/' + encodeURIComponent(order.id) + '/shipment?flash='
    + encodeURIComponent(rebuild ? 'Маршрут собран' : 'Маршрут сохранён'), 303);
});

/* Сменить ссылку отслеживания. Нужно, когда прежнюю отправили не туда или она
 * ушла дальше, чем следовало: ключ новый — старая ссылка не открывается ничем.
 */
app.post('/admin/orders/:id/shipment/relink', (req, res) => {
  if (!guardAdmin(req, res)) return;
  const done = db.rotateShipmentToken(req.params.id);
  res.redirect('/admin/orders/' + encodeURIComponent(req.params.id) + '/shipment?flash='
    + encodeURIComponent(done.ok ? 'Ссылка сменена — отправьте покупателю новую' : 'Отправление не найдено'), 303);
});

app.post('/admin/orders/:id/shipment/delete', (req, res) => {
  if (!guardAdmin(req, res)) return;
  const done = db.clearOrderShipment(req.params.id);
  res.redirect(ordersBackUrl(req.body, done.ok ? 'Отправление удалено' : 'Отправление не найдено'), 303);
});

/* ---------- Чат ---------- */

app.get('/admin/chat', (req, res) => {
  if (!guardAdmin(req, res)) return;
  res.send(A.chatList(settings(), db, req.query.flash, req.query.page));
});
/* Написать покупателю первым.
 *
 * Регистрируется РАНЬШЕ `/admin/chat/:id`: побеждает первый совпавший маршрут,
 * и «new» иначе прочиталось бы как идентификатор диалога (та же очерёдность,
 * что у ленты отзывов товара и у порядка товаров).
 *
 * Адресат — посетитель метрики: его метка стоит и в карточке визитов, и в
 * заказе, и по ней же витрина находит разговор, которого покупатель не начинал.
 * Поэтому писать можно и тому, кто ничего не заказывал, — просто зашёл на сайт.
 */
/* Кому пишем. Адресует МЕТКА посетителя, а карточка метрики лишь добавляет
 * справку — город, технику, историю визитов.
 *
 * Разделять это важно: карточку вытесняет срок хранения (365 дней) и потолок в
 * 10 000 записей, а метка живёт в cookie покупателя год и стоит в его заказе.
 * Требуй мы карточку, менеджер не смог бы написать ровно тем, кому нужнее
 * всего, — покупателям со старым заказом. Витрине для доставки сообщения хватает
 * одной метки.
 */
function chatTarget(key) {
  const found = lookupVisitor(String(key || ''));
  if (found.visitor) return found;
  // Карточки нет — собираем, что знаем, из его же заказов. Пустой профиль тоже
  // годится: диалог доедет по метке, просто менеджер увидит меньше.
  const id = String(key || '').trim();
  if (!/^[a-f0-9]{32}$/.test(id)) return found;
  const orders = db.visibleOrders().filter(o => o.visitorId === id).slice(0, 20);
  const last = orders[0] || null;
  return {
    key: id,
    visitor: {
      id,
      ip: (last && last.clientIp) || '',
      city: (last && last.clientCity) || '', country: (last && last.clientCountry) || '',
      countryCode: (last && last.clientCountryCode) || '',
      device: (last && last.clientDevice) || '', model: (last && last.clientModel) || '',
      os: (last && last.clientOs) || '', browser: (last && last.clientBrowser) || '',
      // Признак «истории визитов у нас нет»: карточка в метрике не открывается,
      // и вести туда кнопкой незачем.
      noCard: true
    },
    orders, alsoOnIp: []
  };
}

app.get('/admin/chat/new', (req, res) => {
  if (!guardAdmin(req, res)) return;
  const found = chatTarget(req.query.to);
  if (!found.visitor) return adminMissing(res, '/admin/chat', 'Посетитель не найден');
  // Разговор с этим человеком мог уже идти — тогда и писать надо в него, а не
  // заводить второй: у покупателя окно чата одно.
  const existing = CHAT.byVisitorId(found.visitor.id);
  if (existing) return res.redirect('/admin/chat/' + encodeURIComponent(existing.id), 303);
  res.send(A.chatNewPage(settings(), db, found, req.query.flash));
});

app.post('/admin/chat/new', (req, res) => {
  if (!guardAdmin(req, res)) return;
  const s = settings();
  const found = chatTarget(req.body.to);
  if (!found.visitor) return adminMissing(res, '/admin/chat', 'Посетитель не найден');
  const to = '/admin/chat/new?to=' + encodeURIComponent(found.key);
  /* Выключенный чат — отказ, а не молчаливая отправка в никуда: у покупателя
   * нет ни кнопки, ни окна, и написанное он не увидит никогда. Проверка идёт ДО
   * записи, как и во всех формах панели. */
  if (!CHAT.visible(s)) {
    return res.redirect(to + '&flash=' + encodeURIComponent('Чат на витрине выключен — включите его в настройках'), 303);
  }
  const text = CHAT.clean(req.body.text, CHAT.MAX_TEXT).trim();
  if (!text) return res.redirect(to + '&flash=' + encodeURIComponent('Пустое сообщение не отправлено'), 303);

  const visitor = found.visitor;
  let chat = CHAT.byVisitorId(visitor.id);
  if (!chat) {
    /* Обстановку берём из карточки посетителя, а не из запроса: запрос сейчас
     * пришёл от владельца панели, и его город с браузером к покупателю
     * отношения не имеют. */
    chat = CHAT.create({
      startedBy: 'operator',
      visitorId: visitor.id,
      ip: visitor.ip || '',
      city: [visitor.city, visitor.country].filter(Boolean).join(', '),
      device: [visitor.device, visitor.os, visitor.browser].filter(Boolean).join(' · '),
      client: {
        device: visitor.device || '', os: visitor.os || '', browser: visitor.browser || '',
        city: visitor.city || '', country: visitor.country || '', countryCode: visitor.countryCode || ''
      },
      // Имя и контакт — из его же заказа, если он есть: обращаться к человеку
      // по имени лучше, чем «здравствуйте, посетитель».
      name: (found.orders[0] && found.orders[0].customerName) || '',
      contact: (found.orders[0] && found.orders[0].contact) || '',
      origin: originOf(req)
    });
  }
  // Человек сам начал действие в этом разговоре — накопленные вопросы он видел.
  CHAT.markManager(chat);
  if (chat.mode !== 'operator') CHAT.setMode(chat, 'operator');
  CHAT.say(chat, 'operator', text);
  // Дальше разговор ведут из Telegram — там уведомления. Тема заводится той же
  // дверью, что и у реплики покупателя.
  TGCHAT.deliverOperator(chat, s, text).catch(e => console.error('Чат: сообщение из панели не ушло в Telegram — ' + e));
  res.redirect('/admin/chat/' + encodeURIComponent(chat.id) + '?flash=' + encodeURIComponent('Сообщение отправлено'), 303);
});

app.get('/admin/chat/:id', (req, res) => {
  if (!guardAdmin(req, res)) return;
  const chat = CHAT.get(req.params.id);
  if (!chat) return adminMissing(res, '/admin/chat', 'Диалог не найден');
  /* Диалог открыт — реплики покупателя прочитаны, и у него это видно галочками.
   * Для панели это ещё и человеческий просмотр: только он снимает «новое», а
   * ответ ИИ — нет. Фоновый live-fetch скрытой вкладки просмотром не считаем;
   * текущую видимость передаёт `admin-live.js` отдельным заголовком. */
  const livePull = req.headers['x-live'] === '1';
  const liveVisible = req.headers['x-live-visible'] === '1';
  if (!livePull || liveVisible) {
    CHAT.markManager(chat);
    CHAT.markStore(chat, 'read');
  }
  /* `sent=1` в адресе ставит редирект после успешного ответа — по нему панель
   * даёт тот же звук отправки, что и окно покупателя. Отдельным признаком, а не
   * сравнением текста плашки: подпись правят словами, и звук отвалился бы молча.
   * Скрипт убирает параметр из адреса сразу, чтобы обновление страницы не
   * повторяло сигнал. */
  /* `reply=<время реплики>` — запасной путь ответа на конкретное сообщение: без
   * скриптов «Ответить» это обычная ссылка, и страница возвращается с уже
   * подставленной цитатой над полем ответа. Со скриптом переход перехватывается
   * и цитата встаёт на место без перезагрузки. */
  res.send(A.chatPage(settings(), db, chat, req.query.flash, chatOrders(chat),
    req.query.sent === '1', req.query.reply));
});

/* Ответ оператора из панели. Делает ровно то же, что сообщение в теме
 * Telegram, — и тем же способом: реплика ложится в переписку, уходит в живой
 * канал покупателя, а ИИ замолкает до конца разговора. Второго поведения у
 * «ответа оператора» быть не должно: разъехавшись, они означали бы, что бот
 * перебивает человека в зависимости от того, откуда тот написал.
 */
app.post('/admin/chat/:id/reply', async (req, res) => {
  if (!guardAdmin(req, res)) return;
  const chat = CHAT.get(req.params.id);
  if (!chat) return adminMissing(res, '/admin/chat', 'Диалог не найден');
  // Любое действие из формы подтверждает, что диалог видел человек.
  CHAT.markManager(chat);
  // `sent` добавляет к адресу возврата признак «ответ ушёл»: по нему панель
  // даёт звук отправки — тот же, что слышит покупатель у себя в окне.
  const back = (flash, sent) => {
    const params = [];
    if (flash) params.push('flash=' + encodeURIComponent(flash));
    if (sent) params.push('sent=1');
    return res.redirect('/admin/chat/' + encodeURIComponent(chat.id)
      + (params.length ? '?' + params.join('&') : ''), 303);
  };

  /* Значок консультанта в шапке — отправка той же формы с `mode=ai`: вложенных
   * форм в HTML не бывает, а браузер шлёт имя только нажатой кнопки (тот же
   * приём, что у удаления ответа на отзыв).
   *
   * Завершения диалога здесь нет вовсе: переписка с покупателем не кончается
   * никогда — он вправе написать через неделю, и «завершённый» разговор
   * означал бы, что кто-то из нас решил за него, что говорить больше не о чем.
   * Прежнее состояние `closed` осталось только у старых записей и читается как
   * обычный диалог. */
  const mode = String(req.body.mode || '');
  if (mode === 'ai') {
    cancelTakeover(chat.id);
    CHAT.setMode(chat, 'ai');
    TGCHAT.relaySystem(chat, 'ИИ снова отвечает (из панели)');
    return back('Отвечает консультант');
  }

  const text = CHAT.clean(req.body.text, CHAT.MAX_TEXT).trim();
  /* Менеджер прикладывает снимки тем же путём, что и покупатель: multipart
   * уже разобран общим server-lib, а optimizeUploads проверяет сигнатуру,
   * перекодирует изображение в WebP и снимает метаданные. Поле нарочно зовётся
   * `photos` с обеих сторон — второй договор о допустимых вложениях здесь был
   * бы только источником расхождений. */
  /* Выключенный чат — отказ, ровно как у «Написать покупателю» выше: у него нет
   * ни кнопки, ни окна, и написанное он не увидит никогда. Проверка стоит здесь,
   * а не в начале маршрута, намеренно: переключить диалог обратно на
   * консультанта (ветка `mode` выше) можно и при выключенном чате — это
   * состояние переписки, а не сообщение покупателю. */
  if (!CHAT.visible(settings())) return back('Чат на витрине выключен — покупатель ответа не увидит');
  const raw = req.filesFor ? req.filesFor('photos').slice(0, CHAT.MAX_PHOTOS) : [];
  const photos = raw.length ? await optimizeUploads(raw, 1400) : [];
  // Как и у покупателя, снимок без подписи — полноценная реплика.
  if (!text && !photos.length) return back('Пустой ответ не отправлен');
  cancelTakeover(chat.id);
  if (chat.mode !== 'operator') CHAT.setMode(chat, 'operator');
  CHAT.markStore(chat, 'read');
  /* На какую реплику отвечаем. Из запроса приходит ТОЛЬКО её время: сам снимок
   * цитаты собирает хранилище по переписке, поэтому подменить автора или текст
   * цитаты телом формы нельзя. Реплики нет (её успели удалить) — отвечаем без
   * цитаты, а не отказываем: ответ важнее ссылки на вопрос. */
  const reply = CHAT.replyTo(chat, Math.floor(Number(req.body.replyTo) || 0));
  // Имя подставляет само хранилище (`SPEAKERS` в lib/chat.js): покупатель видит
  // одного и того же менеджера, откуда бы тот ни ответил — из темы или отсюда.
  CHAT.say(chat, 'operator', text, { reply, photos });
  // В тему уходит и ответ из панели: иначе дежурный в Telegram видел бы вопрос
  // без ответа и написал бы второй раз то же самое. Цитату называем словами —
  // тема в Telegram про наш ответ на конкретную реплику ничего не знает.
  const relayPhotos = photos.length
    ? (text ? '\n' : '') + '📷 ' + photos.length + ' фото — смотреть в панели'
    : '';
  TGCHAT.relaySystem(chat, (reply ? 'Ответ из панели на «' + reply.text + '»: ' : 'Ответ из панели: ')
    + text + relayPhotos);
  return back('Отправлено', true);
});

/* Удалить переписку целиком. Сразу и насовсем — корзины у диалогов нет: денег,
 * которые могли бы прийти позже, за ними не стоит, а держать мусор «на всякий
 * случай» незачем. Удаляют именно мусор: пустые заходы и разговоры, начатые по
 * ошибке.
 */
app.post('/admin/chat/:id/delete', (req, res) => {
  if (!guardAdmin(req, res)) return;
  const chat = CHAT.get(req.params.id);
  if (!chat) return adminMissing(res, '/admin/chat', 'Диалог не найден');
  CHAT.remove(chat.id);
  res.redirect('/admin/chat?flash=' + encodeURIComponent('Диалог удалён'), 303);
});

/* Правка и удаление одной реплики — и своей, и покупателя.
 *
 * Ключ реплики — её время (`at`): оно строго возрастает внутри диалога
 * (`addMessage` берёт `max(Date.now(), предыдущее + 1)`), уникально и есть у
 * всех записей, включая сделанные до появления этой формы. Своего id заводить
 * ради этого не пришлось.
 *
 * Удаление — вторая кнопка отправки той же формы (`name="drop"`): вложенных
 * форм в HTML не бывает, а браузер шлёт имя только нажатой (тот же приём, что у
 * ответа на отзыв). Покупателю правка не показывается ничем — ни событием в
 * канал, ни пометкой, ни строкой в Telegram: см. `editMessage` в lib/chat.js.
 */
app.post('/admin/chat/:id/message', (req, res) => {
  if (!guardAdmin(req, res)) return;
  const chat = CHAT.get(req.params.id);
  if (!chat) return adminMissing(res, '/admin/chat', 'Диалог не найден');
  const back = (flash) => res.redirect('/admin/chat/' + encodeURIComponent(chat.id) + (flash ? '?flash=' + encodeURIComponent(flash) : ''), 303);
  const at = Math.floor(Number(req.body.at) || 0);
  if (!at) return back('Реплика не найдена');
  if (req.body.drop) {
    return back(CHAT.dropMessage(chat, at) ? 'Реплика удалена' : 'Реплика не найдена');
  }
  const text = CHAT.clean(req.body.text, CHAT.MAX_TEXT).trim();
  // Пустое поле — это не удаление: удаляют отдельной кнопкой и с
  // подтверждением, а молчаливый пузырь в ленте покупателя не нужен никому.
  if (!text) return back('Пустая реплика не сохранена — удалите её кнопкой «Удалить»');
  return back(CHAT.editMessage(chat, at, text) ? 'Реплика изменена' : 'Реплика не изменилась');
});

/* Подробный отчёт по кассам: лента ПОПЫТОК, а не заказов.
 *
 * Сводка под списком заказов отвечает «сколько отказов и каких», а этот отчёт —
 * «покажи, что именно касса прислала». Второй вопрос возникает ровно тогда,
 * когда касса подряд отдаёт негодные реквизиты, и без самого значения
 * предъявить ей нечего.
 */
app.get('/admin/payments', (req, res) => {
  if (!guardAdmin(req, res)) return;
  res.send(A.paymentsPage(settings(), db, { tab: req.query.tab, page: req.query.page, flash: req.query.flash }));
});

/* ---------- Промокоды ----------
 *
 * Свой раздел, а не карточка в настройках: у кодов есть СПИСОК, а списку нужна
 * страница. Проверяем всё ДО записи и возвращаем введённое — то же правило, что
 * у формы товара и настроек: «Сохранено» на неправильном коде значило бы, что
 * владелец узнает о нём от покупателя.
 *
 * Код приходит ПОЛЕМ ФОРМЫ, а не куском адреса: `/admin/promo/add` и код с
 * именем «ADD» иначе спорили бы за один маршрут, а побеждает первый совпавший.
 */
function promoBack(message, isError) {
  return '/admin/promo?flash=' + encodeURIComponent(String(message || '')) + (isError ? '&e=1' : '');
}
app.get('/admin/promo', (req, res) => {
  if (!guardAdmin(req, res)) return;
  res.send(A.promoPage(settings(), db, {
    flash: req.query.flash, flashType: req.query.e ? 'err' : 'ok'
  }));
});
// Общий выключатель и код, применённый по умолчанию.
app.post('/admin/promo', (req, res) => {
  if (!guardAdmin(req, res)) return;
  const s = settings();
  const wanted = PROMO.normCode(req.body.promoDefault);
  /* Кодом по умолчанию может быть только «скидка товара» — см. шапку
   * lib/promo.js. Молча сохранить сюда код со своим процентом нельзя: витрина
   * его не применит, а владелец увидит «Сохранено» и будет ждать скидки,
   * которой нет.
   */
  if (wanted) {
    const entry = PROMO.byCode(Object.assign({}, s, { promoOn: true }), wanted);
    if (!entry) return res.redirect(promoBack('Такого кода нет или он выключен', true));
    if (entry.percent) {
      return res.redirect(promoBack('По умолчанию применяется только код со скидкой товара: свой процент переписал бы каждую цену в каталоге', true));
    }
  }
  db.saveSettings({ promoOn: req.body.promoOn !== undefined, promoDefault: wanted });
  res.redirect(promoBack('Сохранено'));
});
app.post('/admin/promo/add', (req, res) => {
  if (!guardAdmin(req, res)) return;
  const s = settings();
  const list = PROMO.codes(s);
  const code = PROMO.normCode(req.body.code);
  const back = (msg) => res.redirect(promoBack(msg, true));
  if (!code) return back('Введите код');
  if (!PROMO.validCode(code)) return back('Код — латиница, цифры, дефис и подчёркивание, от 2 до ' + PROMO.CODE_MAX + ' знаков');
  if (list.some(c => c.code === code)) return back('Такой код уже есть');
  if (list.length >= PROMO.MAX_CODES) return back('Больше ' + PROMO.MAX_CODES + ' кодов не храним');
  // Пустая скидка — «скидка товара», и это законное значение. Мусор в поле
  // законным не является: 0% и «двадцать» дали бы код, который ничего не даёт.
  const raw = String(req.body.percent == null ? '' : req.body.percent).trim();
  if (raw && !/^\d{1,2}$/.test(raw)) return back(`Скидка — целое число от 1 до ${PROMO.MAX_PCT} или пусто`);
  const percent = PROMO.cleanPercent(raw);
  if (raw && !percent) return back(`Скидка — целое число от 1 до ${PROMO.MAX_PCT} или пусто`);
  db.saveSettings({
    promoCodes: list.concat([{ code, percent, on: true, note: String(req.body.note || '').trim().slice(0, 120) }])
  });
  res.redirect(promoBack('Промокод ' + code + ' добавлен'));
});
app.post('/admin/promo/edit', (req, res) => {
  if (!guardAdmin(req, res)) return;
  const s = settings();
  const list = PROMO.codes(s);
  const code = PROMO.normCode(req.body.code);
  const entry = list.find(c => c.code === code);
  if (!entry) return res.redirect(promoBack('Такого кода нет', true));
  const raw = String(req.body.percent == null ? '' : req.body.percent).trim();
  if (raw && !/^\d{1,2}$/.test(raw)) return res.redirect(promoBack(`Скидка — целое число от 1 до ${PROMO.MAX_PCT} или пусто`, true));
  const percent = PROMO.cleanPercent(raw);
  if (raw && !percent) return res.redirect(promoBack(`Скидка — целое число от 1 до ${PROMO.MAX_PCT} или пусто`, true));
  /* Новое имя кода. Поле не пришло вовсе (старая форма) или пусто — код
   * остаётся прежним: пустая строка тут означает «не меняю», а не «код без
   * имени». Проверки те же, что у нового кода, — вид кода задан в одном месте.
   */
  const named = PROMO.normCode(req.body.newCode) || code;
  if (named !== code) {
    if (!PROMO.validCode(named)) return res.redirect(promoBack('Код — латиница, цифры, дефис и подчёркивание, от 2 до ' + PROMO.CODE_MAX + ' знаков', true));
    if (list.some(c => c.code === named)) return res.redirect(promoBack('Такой код уже есть', true));
  }
  const next = list.map(c => c.code === code
    ? { code: named, percent, on: req.body.on !== undefined, note: String(req.body.note || '').trim().slice(0, 120) }
    : c);
  const patch = { promoCodes: next };
  /* Код по умолчанию обязан остаться применимым И называться так, как он теперь
   * называется. Переименование переносит настройку на новое имя само: иначе
   * `defaultCode()` искал бы запись, которой больше нет, и покупатель увидел бы
   * цены без скидки при живой на вид настройке. По той же причине настройка
   * очищается, когда код выключили или дали ему свой процент — скидкой витрины
   * он быть перестал.
   */
  if (PROMO.normCode(s.promoDefault) === code) {
    const def = next.find(c => c.code === named);
    patch.promoDefault = def && def.on && !def.percent ? named : '';
  }
  db.saveSettings(patch);
  /* Переименование названо вслух вместе с его единственным последствием:
   * заказы, оформленные по прежнему имени, остаются как есть, поэтому счётчик
   * заказов у кода начинается заново. */
  res.redirect(promoBack(named === code
    ? 'Промокод ' + code + ' сохранён'
    : 'Промокод ' + code + ' переименован в ' + named + ' — заказы по прежнему коду остались как есть'));
});
app.post('/admin/promo/delete', (req, res) => {
  if (!guardAdmin(req, res)) return;
  const s = settings();
  const code = PROMO.normCode(req.body.code);
  const next = PROMO.codes(s).filter(c => c.code !== code);
  // Заказы, оформленные по этому коду, остаются как есть: они помнят код сами
  // (см. `promoCode` в lib/db.js), и переписывать историю ради удаления записи
  // из справочника незачем.
  db.saveSettings({
    promoCodes: next,
    promoDefault: PROMO.normCode(s.promoDefault) === code ? '' : s.promoDefault
  });
  res.redirect(promoBack('Промокод ' + code + ' удалён'));
});

/* ---------- Настройки магазина ---------- */

/* `open` — какие разделы настроек показать раскрытыми.
 *
 * Страница после сохранения перезагружается, и без этого раздел, который только
 * что правили, захлопывался бы прямо под руками. Список приезжает скрытым полем
 * формы и уезжает обратно параметром адреса; проверяет его сама страница —
 * незнакомые имена она просто выбрасывает.
 */
function openSections(value) {
  return String(value || '').slice(0, 200);
}
app.get('/admin/settings', async (req, res) => {
  if (!guardAdmin(req, res)) return;
  const s = settings();
  res.send(A.settingsPage(s, db, req.query.flash, 'ok',
    { live: await livePayMethods(s), open: openSections(req.query.open) }));
});
app.post('/admin/settings', async (req, res) => {
  if (!guardAdmin(req, res)) return;
  const current = settings();
  const live = await livePayMethods(current);
  const open = openSections(req.body.openSections);
  const fail = (error) => res.send(A.settingsPage(current, db, error, 'err', { draft: req.body, live, open }), 400);
  if (!String(req.body.storeName || '').trim()) return fail('Укажите название магазина');
  const passwordProblem = passwordError(req.body.adminPassword, false);
  if (passwordProblem) return fail(passwordProblem);

  /* Логотип здесь НЕ загружается — он уезжает на диск в самом конце, после всех
   * проверок (см. ниже, перед `saveSettings`).
   *
   * Пока `resolveLogo()` стоял тут, он нарушал главное правило этой формы:
   * проверка идёт ДО записи. Файл ложился на диск, а следом шёл десяток
   * `fail()` — негодный merchant ID, перевёрнутые пределы сумм, разброс цен,
   * реквизиты, чат. Форма честно возвращалась с ошибкой, `logoImage` оставался
   * прежним, а загруженный файл лежал в хранилище сиротой: ссылок на него нет
   * нигде, и ни одна уборка его не найдёт. Каждая неудачная попытка добавляла
   * ещё один. Проверено: `status=400`, `logoImage: null`, файл на месте.
   */
  const patch = brandFields(req.body);
  patch.adminUsername = short(req.body.adminUsername, 100).trim() || current.adminUsername || 'admin';
  if (req.body.adminPassword && String(req.body.adminPassword).trim()) {
    patch.adminPasswordHash = auth.hashPassword(String(req.body.adminPassword).trim());
  }
  // Ключ «Подсказок» dadata.ru. Пустое поле стирает ключ.
  if (req.body.dadataToken !== undefined) patch.dadataToken = String(req.body.dadataToken).trim().slice(0, 200);
  /* Отслеживание: город отправки и через сколько часов стояния покупатель
   * увидит просьбу подождать. Оба поля — значения ПО УМОЛЧАНИЮ для новой
   * отправки: у каждой посылки они свои и правятся в её маршруте.
   *
   * Пустое поле часов — это «как у нас принято» (сутки), а не ноль: ноль
   * означал бы «жаловаться сразу», и плашка висела бы у нормально идущей
   * посылки. Мусор в поле не сохраняем вовсе — проверка до записи, как и всё в
   * этой форме. */
  if (req.body.shipFromCity !== undefined) patch.shipFromCity = TRACK.cleanCity(req.body.shipFromCity);
  if (req.body.shipHoldDays !== undefined) {
    const raw = String(req.body.shipHoldDays).replace(/\s+/g, '').replace(',', '.');
    if (!raw) patch.shipHoldDays = '';
    else {
      const days = Number(raw);
      if (!Number.isFinite(days) || days < 0 || days > TRACK.HOLD_NOTICE_MAX_DAYS) {
        return fail(`Сообщать о задержке — число от 0 до ${TRACK.HOLD_NOTICE_MAX_DAYS} дней или пусто`);
      }
      patch.shipHoldDays = Math.round(days);
    }
  }
  // Галочка кассы снимается отсутствием поля в теле формы, как notifyReviews.
  patch.crocopayEnabled = req.body.crocopayEnabled !== undefined;
  if (req.body.crocopayClientId !== undefined) patch.crocopayClientId = String(req.body.crocopayClientId).trim().slice(0, 200);
  const keepOrReplaceSecret = (field, clearField, max) => {
    if (req.body[clearField] !== undefined) { patch[field] = ''; return; }
    const value = String(req.body[field] || '').trim();
    if (value) patch[field] = value.slice(0, max);
  };
  keepOrReplaceSecret('crocopayClientSecret', 'clearCrocopayClientSecret', 300);
  // Вторая касса. Настраивается независимо от первой: включить можно любую, обе
  // или ни одной — покупатель разницы не увидит.
  patch.meridianpayEnabled = req.body.meridianpayEnabled !== undefined;
  keepOrReplaceSecret('meridianpayApiKey', 'clearMeridianpayApiKey', 200);
  keepOrReplaceSecret('meridianpaySecret', 'clearMeridianpaySecret', 300);
  // UUID мерчанта проверяем ДО записи, как и всё в этой форме: с мусором в этом
  // поле касса не примет ни одной сделки, а владелец увидел бы «Сохранено» и
  // потом гадал, почему оплата не работает. Пустое поле — это «касса не
  // настроена», и это не ошибка.
  if (req.body.meridianpayMerchantId !== undefined) {
    const merchant = String(req.body.meridianpayMerchantId).trim().slice(0, 64);
    if (merchant && !MERIDIAN.validMerchantId(merchant)) {
      return fail('Merchant ID MeridianPay — это UUID вида 3f2a1c88-5d94-4e07-9b31-6a0c2e7d5b40');
    }
    patch.meridianpayMerchantId = merchant;
  }
  // Какую кассу спрашивать первой. Чужое значение молча сводим к порядку по
  // умолчанию, а не оставляем витрину без оплаты.
  if (req.body.payPrimary !== undefined) {
    const first = String(req.body.payPrimary).trim();
    patch.payPrimary = PAYMENTS.providerIds().includes(first) ? first : PAYMENTS.DEFAULT_ID;
  }
  /* Диапазон суммы одного заказа.
   *
   * Проверяем ДО записи, как и всё в этой форме, и придирчиво: от этих чисел
   * зависит не только оплата, но и то, какие товары вообще продаются (дороже
   * потолка карточка становится «Нет в наличии»). Пустое поле — возврат к
   * значению по умолчанию, а не «предела нет»: снятый молча потолок означал бы
   * заказы, которые касса не проведёт.
   */
  const bound = (field, fallback, label) => {
    if (req.body[field] === undefined) return { ok: true, value: null };
    // «10 000» и «10000,50» приходят из формы одинаково законно: пробелы —
    // разделители разрядов, запятая — десятичная.
    const raw = String(req.body[field]).replace(/\s+/g, '').replace(',', '.');
    if (!raw) return { ok: true, value: fallback };
    const value = Number(raw);
    if (!Number.isFinite(value) || value <= 0) return { ok: false, error: `${label} — положительное число или пусто` };
    if (value > 100000000) return { ok: false, error: `${label} — не больше 100 000 000 ₽` };
    return { ok: true, value: Math.round(value) };
  };
  const low = bound('payMinTotal', PAYMENTS.MIN_TOTAL, 'Минимальная сумма заказа');
  if (!low.ok) return fail(low.error);
  const high = bound('payMaxTotal', PAYMENTS.MAX_TOTAL, 'Максимальная сумма заказа');
  if (!high.ok) return fail(high.error);
  if (low.value !== null) patch.payMinTotal = low.value;
  if (high.value !== null) patch.payMaxTotal = high.value;
  // Перевёрнутый диапазон не сохраняем вовсе: `boundsOf()` его развернёт и
  // магазин продолжит работать, но владелец увидел бы «Сохранено» и не понял,
  // почему границы поменялись местами.
  const lowest = low.value !== null ? low.value : Number(current.payMinTotal);
  const highest = high.value !== null ? high.value : Number(current.payMaxTotal);
  if (Number.isFinite(lowest) && Number.isFinite(highest) && highest < lowest) {
    return fail('Максимальная сумма заказа не может быть меньше минимальной');
  }
  /* Плавающие цены (lib/price-float.js). Проверяем ДО записи, как и всё в этой
   * форме: от этих трёх чисел зависит ценник каждого товара на витрине, и
   * молча принятая опечатка («50» вместо «5») означала бы каталог, подорожавший
   * в полтора раза. Пустое поле — возврат к значению по умолчанию, а не «без
   * границ»: разброс без потолка — это не колебание, а другая цена.
   */
  patch.priceFloat = req.body.priceFloat !== undefined;
  const floatPct = (field, fallback, label) => {
    if (req.body[field] === undefined) return { ok: true, value: null };
    const raw = String(req.body[field]).replace(/\s+/g, '').replace(',', '.');
    if (!raw) return { ok: true, value: fallback };
    const value = Number(raw);
    if (!Number.isFinite(value) || value < 0) return { ok: false, error: `${label} — число от 0 до ${PF.MAX_PCT} или пусто` };
    if (value > PF.MAX_PCT) return { ok: false, error: `${label} — не больше ${PF.MAX_PCT}%: это уже не колебание, а другая цена` };
    return { ok: true, value: Math.round(value * 10) / 10 };
  };
  const pfMin = floatPct('priceFloatMin', PF.DEFAULTS.min, 'Разброс цен «от»');
  if (!pfMin.ok) return fail(pfMin.error);
  const pfMax = floatPct('priceFloatMax', PF.DEFAULTS.max, 'Разброс цен «до»');
  if (!pfMax.ok) return fail(pfMax.error);
  if (pfMin.value !== null) patch.priceFloatMin = pfMin.value;
  if (pfMax.value !== null) patch.priceFloatMax = pfMax.value;
  // Перевёрнутый диапазон не сохраняем: `conf()` его развернёт и витрина
  // продолжит работать, но владелец увидел бы «Сохранено» и не понял, почему
  // границы поменялись местами. То же правило, что у пределов суммы заказа.
  const pfLow = pfMin.value !== null ? pfMin.value : Number(current.priceFloatMin);
  const pfHigh = pfMax.value !== null ? pfMax.value : Number(current.priceFloatMax);
  if (Number.isFinite(pfLow) && Number.isFinite(pfHigh) && pfHigh < pfLow) {
    return fail('Разброс цен «до» не может быть меньше, чем «от»');
  }
  if (req.body.priceFloatMinutes !== undefined) {
    const raw = String(req.body.priceFloatMinutes).replace(/\s+/g, '');
    if (!raw) patch.priceFloatMinutes = PF.DEFAULTS.minutes;
    else {
      const value = Number(raw);
      if (!Number.isInteger(value) || value < PF.MIN_MINUTES || value > PF.MAX_MINUTES) {
        return fail(`Период смены цен — целое число минут от ${PF.MIN_MINUTES} до ${PF.MAX_MINUTES}`);
      }
      patch.priceFloatMinutes = value;
    }
  }
  /* Свои реквизиты — оплата вообще без кассы (см. lib/payments.js).
   *
   * Проверяем ДО записи, как и всё в этой форме: реквизит, которого не бывает,
   * покупатель увидит на странице оплаты, переведёт деньги «в никуда» — и
   * узнает об этом владелец от него же. Карту сверяем Луной, телефон — тем же
   * модулем, что и поле заказа. */
  patch.ownPayEnabled = req.body.ownPayEnabled !== undefined;
  if (req.body.ownPayCard !== undefined) {
    const digits = String(req.body.ownPayCard).replace(/\D+/g, '').slice(0, 24);
    if (digits && !PAY.luhnOk(digits)) return fail('Номер карты для перевода введён с ошибкой');
    patch.ownPayCard = digits;
  }
  if (req.body.ownPayPhone !== undefined) {
    const raw = String(req.body.ownPayPhone).trim();
    const stored = PHONE.store(raw);
    if (raw && !stored) return fail('Телефон для СБП введён с ошибкой');
    patch.ownPayPhone = stored;
  }
  if (req.body.ownPayOwner !== undefined) patch.ownPayOwner = String(req.body.ownPayOwner).trim().slice(0, 120);
  if (req.body.ownPayBank !== undefined) patch.ownPayBank = String(req.body.ownPayBank).trim().slice(0, 80);
  // Включённый режим без реквизитов — кнопка, ведущая на пустую страницу оплаты.
  if (patch.ownPayEnabled) {
    const next = PAYMENTS.ownRequisites(Object.assign({}, current, patch));
    if (!next.owner || !(next.card || next.phone)) {
      return fail('Для оплаты по своим реквизитам нужны получатель и хотя бы один реквизит — карта или телефон');
    }
  }
  // Способы оплаты — галочки, поэтому снятые в теле формы просто отсутствуют.
  // Скрытое поле payMethodsForm говорит, что секция вообще пришла: без него
  // снятие ВСЕХ галочек было бы неотличимо от запроса без этой секции.
  //
  // Отмеченное больше не сверяется с закрытым списком: способ, включённый у
  // кассы, но не вписанный в lib/pay-methods.js, обязан включаться здесь же, а
  // не выкаткой. Проверяем только вид кода — он уходит в тело запроса к кассе.
  if (req.body.payMethodsForm !== undefined) {
    const picked = [].concat(req.body.payMethods === undefined ? [] : req.body.payMethods);
    patch.payMethods = picked.map(id => String(id || '').trim())
      .filter((id, i, all) => /^[A-Z0-9_]{2,40}$/.test(id) && all.indexOf(id) === i);
  }
  // Валюта счёта и курсы. Курс — «сколько рублей за единицу валюты»; пустой
  // означает «этой валютой платить нельзя», и это не ошибка. Ошибка — выбрать
  // валютой по умолчанию ту, у которой курса нет: счёт вышел бы на выдуманную
  // сумму, поэтому проверяем ДО записи, как и всё остальное в этой форме.
  const rates = Object.assign({}, current.crocopayRates || {});
  for (const key of Object.keys(req.body)) {
    if (!key.startsWith('payrate:')) continue;
    const code = PAY.currencyCode(key.slice(8));
    if (!code || code === PAY.BASE) continue;
    const raw = String(req.body[key] || '').trim().replace(',', '.');
    const value = Number(raw);
    if (!raw) { delete rates[code]; continue; }
    if (!Number.isFinite(value) || value <= 0) return fail(`Курс ${code} — положительное число или пусто`);
    rates[code] = Math.round(value * 10000) / 10000;
  }
  patch.crocopayRates = rates;
  if (req.body.crocopayCurrency !== undefined) {
    const code = PAY.currencyCode(req.body.crocopayCurrency) || PAY.BASE;
    if (!PAY.rateOf(rates, code)) return fail(`Для валюты ${code} не задан курс — счёт в ней выставить нельзя`);
    patch.crocopayCurrency = code;
  }
  patch.crocopayCurrencyChoice = req.body.crocopayCurrencyChoice !== undefined;

  /* Онлайн-чат витрины.
   *
   * Галочка снимается отсутствием поля в теле формы, как у касс и уведомлений
   * об отзывах. Всё проверяется ДО записи — по тому же правилу, что и остальная
   * эта форма: включённый чат без единого собеседника означал бы кнопку, в
   * которой покупателю никто не отвечает, и узнал бы об этом владелец от него.
   */
  patch.chatEnabled = req.body.chatEnabled !== undefined;
  if (req.body.aiApiKey !== undefined) patch.aiApiKey = String(req.body.aiApiKey).trim().slice(0, 300);
  if (req.body.aiModel !== undefined) patch.aiModel = String(req.body.aiModel).trim().slice(0, 80);
  if (req.body.aiBaseUrl !== undefined) {
    const base = String(req.body.aiBaseUrl).trim().slice(0, 300);
    // Адрес уходит в fetch на сервере, поэтому чужая схема здесь — это запрос
    // туда, куда его послал текст из формы. Пустое поле означает обычный OpenAI.
    if (base && !/^https:\/\/[a-z0-9.-]+(?::\d{1,5})?(?:\/|$)/i.test(base)) {
      return fail('Адрес API должен начинаться с https://');
    }
    patch.aiBaseUrl = base;
  }
  /* Галочка консультанта — как и все прочие: снятая в теле формы просто
   * отсутствует. Ключ она не трогает, поэтому вернуть бота можно одним
   * нажатием, а не искать ключ заново. */
  patch.aiEnabled = req.body.aiEnabled !== undefined;
  if (req.body.aiTakeoverMinutes !== undefined) {
    const raw = String(req.body.aiTakeoverMinutes).trim();
    if (!raw) patch.aiTakeoverMinutes = '';
    else {
      const n = Math.floor(Number(raw));
      if (!Number.isFinite(n) || n < 0 || n > CHAT.TAKEOVER_MAX_MIN) {
        return fail('Возврат консультанта — от 0 до ' + CHAT.TAKEOVER_MAX_MIN + ' минут (0 — не возвращать)');
      }
      patch.aiTakeoverMinutes = n;
    }
  }
  if (req.body.chatPrompt !== undefined) patch.chatPrompt = String(req.body.chatPrompt).slice(0, PROMPT.MAX_INSTRUCTION);
  if (req.body.chatGreeting !== undefined) patch.chatGreeting = String(req.body.chatGreeting).trim().slice(0, 400);
  if (req.body.chatChatId !== undefined) {
    const room = String(req.body.chatChatId).trim().slice(0, 40);
    // id группы Telegram — это число (у супергрупп со знаком минус) либо @имя.
    // С мусором в поле бот молча не отправит ни одного диалога.
    if (room && !/^(-?\d{1,20}|@[A-Za-z0-9_]{4,32})$/.test(room)) {
      return fail('Группа для чата — это числовой ID (например -1001234567890) или @имя');
    }
    patch.chatChatId = room;
  }
  const willChat = patch.chatEnabled;
  // Выключенный галочкой консультант в «есть кому отвечать» не считается: он
  // молчит с ключом или без него.
  const willAi = patch.aiEnabled && (patch.aiApiKey !== undefined ? patch.aiApiKey : current.aiApiKey);
  const willTg = (patch.telegramBotToken !== undefined ? patch.telegramBotToken : current.telegramBotToken)
    && ((patch.chatChatId !== undefined ? patch.chatChatId : current.chatChatId)
      || (patch.telegramChatId !== undefined ? patch.telegramChatId : current.telegramChatId));
  if (willChat && !willAi && !willTg) {
    return fail('Чат включён, но отвечать некому: задайте ключ OpenAI или Telegram-бота с группой');
  }

  /* Всё проверено — теперь можно писать. Логотип загружается ЗДЕСЬ и только
   * здесь: после этой строки отказов уже нет, значит и сироте взяться неоткуда.
   */
  const logo = await resolveLogo(req, current.logoImage);
  patch.logoImage = logo.value;

  db.saveSettings(patch);
  if (logo.obsolete) db.deleteUploadIfUnused(logo.obsolete);
  // Списки способов кэшированы под ключи прежних касс — после смены ключей они
  // бы ещё пять минут отвечали за чужие.
  PAYMENTS.forgetMethods();
  // Мост в Telegram держит длинный опрос со СТАРЫМ токеном: без этого вызова
  // он продолжил бы работать с ним до перезапуска процесса, а новый чат молчал.
  TGCHAT.sync(settings());
  res.redirect('/admin/settings?flash=' + encodeURIComponent('Сохранено')
    + (open ? '&open=' + encodeURIComponent(open) : ''));
});

/* =========================== 404 =========================== */
app.notFound = (req, res) => {
  // Прежняя панель владельца жила на /owner, и её адреса остались в закладках.
  // Уводим на новую панель, а не показываем «не найдено».
  if (/^\/owner(?:\/|$)/.test(String(req.pathname || req.url || '').split('?')[0])) return res.redirect('/admin');
  sendNotFound(req, res);
};

const httpServer = app.listen(PORT, HOST, () => {
  const s = settings();
  console.log(`\n  «${s.storeName}» запущен на порту ${PORT}`);
  console.log(`  Витрина:  http://localhost:${PORT}`);
  console.log(`  Панель:   http://localhost:${PORT}/admin`);
  if (migration && migration.site) {
    // Переезд с мультидоменной версии случается ровно один раз, и молча его
    // делать нельзя: у магазина поменялся и адрес панели, и пароль от неё.
    console.log(`\n  ПЕРЕЕЗД НА ОДИН МАГАЗИН выполнен по домену «${migration.site}»`
      + (migration.hosts.length ? ` (${migration.hosts.join(', ')})` : ''));
    console.log(`  · настройки домена перенесены в общие, товаров пересчитано: ${migration.products}`
      + (migration.multiplier !== 1 ? `, множитель цен ×${migration.multiplier} вбит в цены` : ''));
    if (migration.hidden) console.log(`  · скрытых на домене отзывов возвращено в модерацию: ${migration.hidden}`);
    if (migration.dropped.length) console.log(`  · настройки прочих доменов не перенесены: ${migration.dropped.join(', ')}`);
    console.log(`  · вход теперь один — /admin, с ЛОГИНОМ И ПАРОЛЕМ ПРЕЖНЕГО ВЛАДЕЛЬЦА (/owner)`);
    console.log(`  · прежний sites.json сохранён рядом как sites.migrated.json`);
  }
  if (auth.verifyPassword('admin', s.adminPasswordHash)) {
    console.warn(`\n  ВНИМАНИЕ: у панели демонстрационный пароль (admin / admin).`);
    console.warn('  Смените его в /admin/settings до публикации сайта или задайте ADMIN_PASSWORD при первом запуске.');
  }
  // База пунктов выдачи — единственное, чьё отсутствие ничем себя не проявляет:
  // оформление работает как раньше, просто ближайшие пункты не предлагаются.
  // Ровно та же грабля, что с ImageMagick, поэтому говорим об этом вслух.
  const pickupNote = PICKUP.staleNote();
  if (pickupNote) console.warn(`\n  ВНИМАНИЕ: ${pickupNote}`);
  else {
    const ps = PICKUP.stats();
    console.log(`  Пункты выдачи: ${Object.entries(ps.byCarrier).map(([k, n]) => `${k} ${n}`).join(', ')}`);
  }
  /* База «IP → город» — из той же породы: её отсутствие ничем себя не проявляет,
   * метрика просто перестаёт называть города. Ровно так эта беда и всплыла — по
   * жалобе на «Город не определён», а не по логам. */
  const geo = GEOIP.info(db.DATA_DIR);
  if (!geo) {
    console.warn('\n  ВНИМАНИЕ: базы городов нет — метрика не определит город посетителя.');
    console.warn('  Соберите её: STORE_DATA_DIR=… node scripts/sync-geoip.js --apply');
  } else {
    // Сколько карточек осталось без города — единственный способ увидеть, что
    // база у нас есть, а отвечать она перестала (устарела, обрезана, чужой формат).
    const cards = metrics.data.visitors;
    const blank = cards.filter(v => !v.city && !v.country).length;
    console.log(`  База городов: ${geo.ranges.toLocaleString('ru-RU')} диапазонов, выпуск ${geo.stamp}`
      + `; карточек без города ${blank.toLocaleString('ru-RU')} из ${cards.length.toLocaleString('ru-RU')}`);
  }
  /* Список способов у касс спрашиваем СРАЗУ, не дожидаясь первого покупателя.
   *
   * У MeridianPay он честно идёт восемь с половиной секунд (317 КБ, 906 банков —
   * замер на боевом сервере), а страница ждёт его четыре: без прогрева первый,
   * кто откроет оплату или настройки после перезапуска, заплатил бы этими
   * четырьмя секундами и всё равно увидел бы список без второй кассы. Ответ
   * складывается в тот же кэш, откуда его берут все.
   *
   * Ошибку глотаем молча: кассы могут быть не настроены вовсе, и падать из-за
   * этого при старте магазину незачем.
   */
  if (PAYMENTS.configured(s)) livePayMethods(s).catch(() => {});
  console.log('');
});

/* Порт занят или недоступен — говорим об этом человеческим языком и выходим.
 * Без обработчика Node бросает необработанное событие 'error' и печатает стек
 * из своих внутренностей: под pm2 это выглядит как бесконечный перезапуск без
 * внятной причины, хотя причина всего одна — процесс магазина уже запущен.
 */
httpServer.on('error', (e) => {
  if (e && e.code === 'EADDRINUSE') {
    console.error(`\n  Порт ${PORT} уже занят — вероятно, магазин уже запущен.`);
    console.error(`  Останови прежний процесс или задай другой порт: PORT=3001 node server.js\n`);
  } else if (e && e.code === 'EACCES') {
    console.error(`\n  Нет прав слушать порт ${PORT}. Порты ниже 1024 требуют root — держи приложение на порту выше и ставь перед ним прокси.\n`);
  } else {
    console.error('\n  Не удалось запустить сервер:', (e && e.message) || e, '\n');
  }
  process.exit(1);
});

let shuttingDown = false;
function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  metrics.flush();
  // Недописанная пачка переписки: она живёт в памяти и уходит на диск с
  // задержкой, поэтому при остановке её надо сохранить явно.
  CHAT.shutdown();
  httpServer.close(() => process.exit(0));
  const force = setTimeout(() => process.exit(0), 5000);
  if (force.unref) force.unref();
}
process.once('SIGTERM', shutdown);
process.once('SIGINT', shutdown);
