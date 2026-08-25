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
const SHIP = require('./lib/delivery-price');
const ADDRESS = require('./lib/address');
// Телефон покупателя разбирает тот же файл, что и витрина: одна таблица кодов,
// один формат и один текст отказа. Лежит он в `public/`, потому что его грузит
// браузер (см. шапку самого файла).
const PHONE = require('./public/phone.js');
const PICKUP = require('./lib/pickup');
const OSM = require('./lib/pickup-osm');
const PAY = require('./lib/pay-methods');
const { findBand, variantMissing, findOptions, optionsAdd, optionFits, choiceMap } = require('./lib/variants');
const R = require('./lib/render');
const D = require('./lib/discount');
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
const { App } = require('./lib/server-lib');
LIVE.watch(db.DATA_DIR);

// Возвращает отчёт, если рядом лежала установка прежней мультидоменной версии.
const migration = db.ensureSeeded();
const metrics = new Analytics({ dataDir: db.DATA_DIR, geoEnabled: process.env.GEOIP_ENABLED !== '0' });

const PORT = process.env.PORT || 3000;
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
  uploadDir: db.UPLOAD_DIR,
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
const ordersBackUrl = (body, flash, forcedView) => {
  const params = [];
  const view = forcedView === 'archive' || (!forcedView && String(body && body.view) === 'archive')
    ? 'archive' : 'active';
  if (view === 'archive') params.push('view=archive');
  const n = Math.floor(Number(body && body.page));
  if (Number.isFinite(n) && n > 1) params.push('page=' + Math.min(n, 1e6));
  // Режим правки возвращается вместе со страницей и вкладкой: все кнопки списка
  // показываются только в нём, и без этого он выключался бы после каждого
  // удаления — чистка десятка заявок означала десять лишних нажатий «Изменить».
  if (body && body.edit) params.push('edit=1');
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
const parseDt = (v) => { if (!v) return null; const t = Date.parse(v); return isNaN(t) ? null : t; };
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
    secondaryColor: safeHex(body.secondaryColor, safeHex(body.accentColor, '#0071e3'))
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
 *   - счёт ДЕЙСТВУЮЩИЙ — со сроком: реквизиты сгорают, и это надо видеть.
 *     Условие общее с панелью и страницей оплаты (`R.payLive`);
 *   - счёт не выставился (касса не ответила), сгорел или отменён, а заказ так и
 *     не оплачен — без срока: отсчитывать нечего, но вернуться на страницу
 *     оплаты и выставить новый счёт покупатель должен уметь. Раньше такой заказ
 *     не напоминал о себе ничем: полоса требовала живого счёта.
 *
 * Оплаченный и ушедший на разбор (`mismatch`) не напоминают ничего — там платить
 * уже нечего. Черновик тоже: способ не выбран, товары остались в корзине, и
 * оформляют его оттуда.
 */
const REMIND_TTL = 24 * 60 * 60 * 1000;   // сутки — дальше напоминание превращается в навязчивость
function payRemind(req) {
  const ids = Array.isArray(req.session && req.session.myOrders) ? req.session.myOrders : [];
  if (!ids.length) return null;
  const now = Date.now();
  const card = (order, expiresAt) => ({ id: order.id, number: order.number, total: order.total, expiresAt });
  for (const id of ids) {
    const order = db.getOrder(String(id || ''));
    if (!order || order.draft) continue;                       // черновик заказом ещё не стал
    const pay = order.payment;
    if (!pay) continue;
    const shown = R.payDisplay(pay, now);
    // Уже выданный счёт нельзя отменить удалением в панели: до конца срока он
    // остаётся у покупателя и сверяется как прежде. После срока архивный заказ
    // больше не напоминаем и новый invoice ему не выпускаем.
    if (R.payLive(shown, now)) return card(order, R.payUntil(shown));
    if (db.isOrderArchived(order)) continue;
    if (pay.status === 'paid' || pay.status === 'mismatch') continue;
    if (now - Number(order.createdAt || 0) > REMIND_TTL) continue;
    return card(order, 0);
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
    payRemind: payRemind(req)
  }, extra || {});
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
  // `payOnline` решает подпись кнопки: «Перейти к оплате» либо «Оформить заказ».
  res.send(R.checkoutPage(settings(), pageOpts(req, {
    payOnline: PAYMENTS.enabled(settings()), notice
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
  res.json({ ok: true, message: 'Спасибо за отзыв!' });
});

// Актуальные данные корзины. Корзина хранит только то, что было в момент
// добавления: у позиций, добавленных давно, нет фото, а цена могла измениться.
// Здесь сервер отдаёт по каждой позиции нынешние название, цену, фото и наличие.
app.post('/api/cart', (req, res) => {
  if (rateLimited(req, 'cart', 180, 10 * 60 * 1000)) return res.json({ ok: false }, 429);
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
    const price = D.effectivePrice(view) + adds;
    /* Цена для сравнения — та же, что зачёркнута на карточке и на странице
      * товара, и считается ТЕМ ЖЕ способом: процент скидки товара от ПОЛНОЙ
      * цены сборки. Поэтому выгода в процентах у любой сборки одна и та же, а
      * в рублях у дорогой она больше — так скидка и работает.
      *
      * Ноль означает «зачёркивать нечего»: у товара без скидки сравнивать не с чем.
      */
    const compare = D.compareFor(price, D.discountPct(view));
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
  res.json({ ok: true, items });
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
  if (!check.ok) return res.json({ ok: true, valid: false, error: check.error, prices: null });
  // Цены отдаём сразу все: покупатель должен видеть, во что обойдётся курьер,
  // ДО того как выберет его, а переключение способа не должно ходить на сервер.
  // Потолок заказа приходит из настроек: подгонка итога под круглое число не
  // вправе вывести сумму за границу, которую касса уже не проведёт.
  const q = SHIP.quoteAll(address, Number.isFinite(goods) && goods > 0 ? goods : 0,
    PAYMENTS.limits(settings()).max);
  res.json({ ok: true, valid: true, error: '', zone: q.zone, zoneName: q.zoneName, prices: q.prices });
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
    + `\n${lines}\n\n<b>Итого: ${R.money(order.total, ss)}</b>`;
  sendTelegram(ss, msg).catch(() => {});
}

// После отказа кассы покупатель часто возвращается на оформление и нажимает
// кнопку ещё раз. Его подписанная сессия уже знает прежний заказ; если весь
// нормализованный заказ совпадает, переиспользуем его вместо дубля и возвращаем
// на ту же страницу оплаты. Изменился хоть один товар, контакт, адрес или тариф
// — это уже новый заказ.
const ORDER_REUSE_TTL = 24 * 60 * 60 * 1000;
function reusableOrder(req, data) {
  const mine = Array.isArray(req.session.myOrders) ? req.session.myOrders : [];
  const scalars = [
    'total', 'itemsTotal', 'firstName', 'lastName', 'phone', 'contact', 'address',
    'delivery', 'deliveryMode', 'deliveryPrice', 'deliveryZone', 'pickupCode', 'pickupAddress', 'comment'
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
    if (!['new', 'processing'].includes(order.status)
      || (pay && (pay.status === 'paid' || pay.status === 'mismatch'))) continue;
    if (!order.draft && !pay) continue;       // обычная уже принятая заявка, не платёжный повтор
    if (scalars.some(key => String(order[key] == null ? '' : order[key]) !== String(data[key] == null ? '' : data[key]))) continue;
    if (itemKey(order.items) !== itemKey(data.items)) continue;
    return order;
  }
  return null;
}

app.post('/api/order', async (req, res) => {
  // Tor/proxy не должен превращать лимит одного общего IP в лимит всего
  // магазина. Основной счётчик — случайная подписанная сессия; широкий IP-лимит
  // остаётся только против бота, который удаляет cookie после каждого запроса.
  const buyerRateId = anonymousSessionId(req);
  if (rateLimited(req, 'order', 10, 10 * 60 * 1000, buyerRateId)
    || rateLimited(req, 'order-ip', 120, 10 * 60 * 1000)) {
    return res.json({ ok: false, error: 'Слишком часто. Попробуйте позже.' }, 429);
  }
  const rawItems = Array.isArray(req.body.items) ? req.body.items.slice(0, 100) : [];
  const items = []; let total = 0;
  for (const it of rawItems) {
    if (!it || typeof it !== 'object') continue;
    const view = db.visibleProduct(it.id);
    if (!view || !view.inStock) continue;
    // Выбранного варианта больше нет в каталоге — заявку по базовой цене
    // вместо него не оформляем.
    if (variantMissing(view, it)) continue;
    const rawQty = Number(it.qty);
    const qty = Number.isInteger(rawQty) ? Math.max(1, Math.min(99, rawQty)) : 1;
    let price = D.effectivePrice(view);
    let name = view.name;
    // Наличие варианта проверяем на сервере: корзина живёт в localStorage и могла
    // сохраниться до того, как цвет или конфигурацию распродали.
    const storageLabel = String(it.storage || '').trim();
    if (storageLabel && Array.isArray(view.storages)) {
      const s = view.storages.find(x => x.label === storageLabel);
      if (s && s.inStock === false) continue;
      if (s) { price += Number(s.add) || 0; name += ' ' + s.label; }
    }
    const color = String(it.color || '').trim();
    if (color && Array.isArray(view.colors)) {
      const c = view.colors.find(x => x.name === color);
      if (c && c.inStock === false) continue;
      if (c) name += ', ' + color;
    }
    // Ремешок часов: доплата за вариацию и за размер, наличие тоже перепроверяем
    const band = findBand(view, it.band);
    if (band) {
      if (band.option.inStock === false) continue;
      // вариация «в цвет корпуса» продаётся только со своим корпусом
      if (band.option.forColor && band.option.forColor !== color) continue;
      price += Number(band.option.add) || 0;
      name += ', ' + band.group.name + ' \u00b7 ' + band.option.name;
      const sz = (band.group.sizes || []).find(x => x.label === String(it.bandSize || '').trim());
      if (sz) { price += Number(sz.add) || 0; name += ' ' + sz.label; }
    }
    // Доп. характеристики: наличие и совместимость с конфигурацией перепроверяем
    // так же, как у ремешка, — корзина могла сохраниться до правки каталога.
    const chosen = findOptions(view, it);
    const picked = choiceMap(chosen);
    if (chosen.some(c => !c.value || c.value.inStock === false || !optionFits(c.value, storageLabel, picked))) continue;
    // Конфигурация, привязанная к чипу (8 ТБ только с M5 Max), проверяется здесь же.
    const stPick = (view.storages || []).find(x => x.label === storageLabel);
    if (stPick && !optionFits(stPick, storageLabel, picked)) continue;
    price += optionsAdd(chosen);
    for (const c of chosen) name += ', ' + c.value.label;
    if (!Number.isFinite(price) || price < 0) continue;
    items.push({ id: view.id, name, price, qty });
    total += price * qty;
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
  const ship = SHIP.quote(delivery, deliveryMode, address, total, PAYMENTS.limits(settings()).max);
  if (!ship.ok) return res.json({ ok: false, error: 'Не удалось рассчитать доставку — выберите другой способ' }, 400);
  const grandTotal = total + ship.price;
  // Пределы одной покупки (1 000 – 250 000 ₽) — по сумме, которую платит
  // покупатель, то есть вместе с доставкой. Витрина гасит кнопку заранее, но
  // проверяем и здесь: клиентским данным не верим, как и в цене заказа.
  //
  // Пределы принадлежат КАССАМ: пока оплата на витрине выключена (обе кассы),
  // заказ уходит заявкой, и ограничивать её суммой платёжки незачем.
  const limit = PAYMENTS.limitFor(settings(), grandTotal);
  if (limit) return res.json({ ok: false, error: limit }, 400);

  const s = settings();
  const draft = PAYMENTS.enabled(s);
  const orderData = {
    draft,
    host: db.normHost(req.headers.host),
    items, total: grandTotal, itemsTotal: total,
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
    const mine = Array.isArray(req.session.myOrders) ? req.session.myOrders : [];
    req.session.myOrders = [reused.id].concat(mine.filter(x => x !== reused.id)).slice(0, 20);
    return res.json({
      ok: true, reused: true, id: reused.id, number: reused.number,
      total: reused.total, itemsTotal: reused.itemsTotal,
      delivery: { price: reused.deliveryPrice, zone: reused.deliveryZone, zoneName: ship.zoneName },
      pay: true, telegram: 'already_queued'
    });
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
  const mine = Array.isArray(req.session.myOrders) ? req.session.myOrders : [];
  req.session.myOrders = [order.id].concat(mine.filter(x => x !== order.id)).slice(0, 20);
  // `pay` решает сервер, а не витрина: только он знает пересчитанную сумму и
  // пределы кассы. По нему же витрина решает, чистить ли корзину (у черновика
  // её чистит pay.js, когда способ выбран).
  res.json({
    ok: true, id: order.id, number: order.number, total: grandTotal, itemsTotal: total,
    delivery: { price: ship.price, zone: ship.zone, zoneName: ship.zoneName },
    pay: draft, telegram: 'queued'
  });
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
CHAT.init(db.DATA_DIR);

// Диалог этого покупателя. Ключ — подписанная cookie-сессия, тот же приём, что
// у своих отзывов и своих заказов: чужую переписку так не открыть, а угадать
// 32-значный id нельзя.
function currentChat(req) {
  const id = req.session && req.session.chatId;
  return CHAT.validId(id) ? CHAT.get(id) : null;
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
    // Адрес страницы — из закрытого списка публичных путей: он приходит от
    // браузера, а уезжает в тему Telegram ссылкой.
    page: metricPublicPath(req.body && req.body.path) || '',
    origin: originOf(req)
  };
}

// Что уезжает в браузер. Служебных полей диалога (ip, тема Telegram, id
// посетителя) покупателю знать незачем — он получает ровно свою переписку.
function chatView(chat) {
  return {
    ok: true,
    id: chat.id,
    mode: chat.mode,
    unread: chat.unread,
    messages: chat.messages.map(m => ({ role: m.role, text: m.text, at: m.at, by: m.by }))
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

async function aiReply(chat, info) {
  const s = settings();
  if (!AI.configured(s)) return;
  if (aiBusy.has(chat.id)) return;
  aiBusy.add(chat.id);
  try {
    await aiAnswer(chat, info, s);
  } finally {
    aiBusy.delete(chat.id);
  }
}

async function aiAnswer(chat, info, s) {
  CHAT.push(chat.id, 'typing', {});
  const messages = PROMPT.build(db, s, chat, info);
  const result = await AI.stream(s, messages, piece => {
    CHAT.push(chat.id, 'delta', { text: piece });
  });
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
    if (result.text) {
      const partial = CHAT.addMessage(fresh, 'ai', result.text);
      CHAT.push(fresh.id, 'done', partial);
    } else {
      CHAT.push(fresh.id, 'done', null);
    }
    return;
  }
  if (result.ok && result.text) {
    const message = CHAT.addMessage(fresh, 'ai', result.text);
    CHAT.push(fresh.id, 'done', message);
    TGCHAT.relayAi(fresh, result.text);
    return;
  }
  /* Обе строки говорят одно: вопрос не потерян, им занялся человек. Это правда —
   * в тему Telegram он уже ушёл, вместе с отдельной отметкой ниже. Звать
   * менеджера покупателю не нужно и нечем: кнопки нет, а диалог у менеджера
   * перед глазами с первой реплики. */
  const excuse = result.error === 'rate_limit'
    ? 'Отвечаю медленнее обычного — передал ваш вопрос менеджеру, он ответит здесь же.'
    : 'Не получилось ответить автоматически. Я передал вопрос менеджеру — он ответит здесь же.';
  const message = CHAT.addMessage(fresh, 'system', excuse);
  CHAT.push(fresh.id, 'done', message);
  TGCHAT.relaySystem(fresh, 'ИИ не ответил (' + (result.error || 'ошибка') + ') — вопрос ждёт менеджера');
}

// Открыть диалог: витрина зовёт это при первом сообщении и при возвращении на
// сайт. Диалог уже есть — отдаём его целиком, чтобы окно открылось там же, где
// покупатель его оставил.
app.post('/api/chat/open', (req, res) => {
  const s = settings();
  if (!CHAT.visible(s)) return res.json({ ok: false, error: 'off' }, 404);
  if (rateLimited(req, 'chat-open', 60, 10 * 60 * 1000, anonymousSessionId(req))) {
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
app.post('/api/chat/send', (req, res) => {
  const s = settings();
  if (!CHAT.visible(s)) return res.json({ ok: false, error: 'off' }, 404);
  // Лимит по подписанной сессии, а не по IP: за одним адресом сидит целый офис
  // или Tor-выход, и общий счётчик отдавал бы чужой отказ живому покупателю.
  if (rateLimited(req, 'chat-send', 40, 5 * 60 * 1000, anonymousSessionId(req))) {
    return res.json({ ok: false, error: 'Слишком много сообщений подряд. Подождите минуту.' }, 429);
  }
  const text = CHAT.clean(req.body && req.body.text, CHAT.MAX_TEXT).trim();
  if (!text) return res.json({ ok: false, error: 'Введите сообщение' }, 400);

  const info = chatContext(req);
  let chat = currentChat(req);
  if (!chat) {
    chat = CHAT.create(info);
    req.session.chatId = chat.id;
  } else {
    CHAT.touch(chat, info);
  }
  if (chat.mode === 'closed') CHAT.setMode(chat, 'ai');   // написал снова — разговор продолжается

  CHAT.say(chat, 'user', text, { exceptSid: String(req.body && req.body.sid || '') });

  // Тема в Telegram заводится на первом сообщении, а не при открытии окна:
  // иначе каждый, кто просто нажал кнопку и передумал, оставлял бы менеджеру
  // пустую тему.
  if (!chat.topicId && TGCHAT.configured(s)) {
    TGCHAT.openTopic(chat, s, text).catch(e => console.error('Чат: тема не создана — ' + e));
  } else {
    TGCHAT.relayUser(chat, text);
  }

  // Ответ ИИ идёт своим ходом. Оператор в диалоге — бот молчит: он замолкает
  // до конца переписки, и вернуть его можно только кнопкой в Telegram.
  const cart = Array.isArray(req.body && req.body.cart) ? req.body.cart : [];
  if (chat.mode === 'ai' && AI.configured(s)) {
    aiReply(chat, Object.assign({}, info, { cart })).catch(e => console.error('Чат: ошибка ответа ИИ — ' + e));
  }
  res.json({ ok: true, mode: chat.mode });
});

/* Живой канал. Через него приходят куски ответа ИИ, реплики оператора и смена
 * режима. Тот же Server-Sent Events, что у панели: `EventSource` умеют все
 * браузеры, доходящие до витрины, и он переподключается сам. */
app.get('/api/chat/stream', (req, res) => {
  if (!CHAT.visible(settings())) { res.writeHead(404); return res.end(); }
  const chat = currentChat(req);
  if (!chat) { res.writeHead(404); return res.end(); }
  CHAT.attach(chat.id, req, res);
});

/* Запасной опрос — на случай прокси, который не пропускает поток. Без него у
 * такого покупателя окно молчало бы вовсе: ни ответа ИИ, ни ответа менеджера.
 * Ответ ИИ он получает готовым целиком, без побуквенной ленты. */
app.get('/api/chat/poll', (req, res) => {
  if (!CHAT.visible(settings())) return res.json({ ok: false }, 404);
  const chat = currentChat(req);
  if (!chat) return res.json({ ok: false }, 404);
  if (rateLimited(req, 'chat-poll', 120, 5 * 60 * 1000, anonymousSessionId(req))) {
    return res.json({ ok: false }, 429);
  }
  const since = Math.max(0, Math.floor(Number(req.query.since)) || 0);
  res.json({
    ok: true,
    mode: chat.mode,
    messages: chat.messages.filter(m => m.at > since).map(m => ({ role: m.role, text: m.text, at: m.at, by: m.by }))
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

// Покупатель открыл окно — значок непрочитанного гаснет.
app.post('/api/chat/read', (req, res) => {
  const chat = currentChat(req);
  if (chat) CHAT.markRead(chat);
  res.json({ ok: true });
});

/* Ответ оператора из Telegram. Мост зовёт это, разобрав сообщение в теме, —
 * маршрута здесь нет вовсе: Telegram сам приходит к нам длинным опросом. */
TGCHAT.start({
  settings,
  chat: CHAT,
  onOperator: (chat, text, by) => {
    // Первая же реплика человека выключает бота до конца переписки.
    if (chat.mode !== 'operator') CHAT.setMode(chat, 'operator');
    CHAT.say(chat, 'operator', text, { by });
  },
  onCommand: (chat, command, by) => {
    // Строку в ленту покупателя пишет сама `setMode` — одну и ту же, откуда бы
    // собеседника ни сменили. Здесь остаётся только отметка в тему Telegram:
    // менеджеру важно ещё и КТО это сделал.
    if (command === 'ai') {
      CHAT.setMode(chat, 'ai');
      TGCHAT.relaySystem(chat, 'ИИ снова отвечает (' + by + ')');
      return;
    }
    if (command === 'close') {
      CHAT.setMode(chat, 'closed');
      TGCHAT.relaySystem(chat, 'Диалог завершён (' + by + ')');
      return;
    }
    if (command === 'info') {
      TGCHAT.relaySystem(chat, [
        chat.city && ('Город: ' + chat.city),
        chat.device && ('Техника: ' + chat.device),
        chat.page && ('Страница: ' + chat.page),
        chat.ip && ('IP: ' + chat.ip),
        'Сообщений: ' + chat.messages.length,
        'Режим: ' + chat.mode
      ].filter(Boolean).join('\n'));
    }
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
  const callbackUrl = originOf(req) + '/api/pay/' + p.id + '/callback?order=' + encodeURIComponent(id)
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
        expiresAt: r.invoice.expiresAt, providerTries: tries
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
    method, actualMethod: r.invoice.method, expiresAt: r.invoice.expiresAt,
    providerTries: tries
  });
  if (!attached) {
    return { done: true, status: 409, body: { ok: false, placed: true, errorCode: 'stale_attempt', error: 'Попытка оплаты устарела — обновите страницу' } };
  }
  const terminalAfterCreate = terminalPaymentBody(db.getOrder(id));
  if (terminalAfterCreate) return { done: true, status: 200, body: terminalAfterCreate };
  return { done: true, status: 200, body: { ok: true, placed: true, url: '/pay/' + encodeURIComponent(id) } };
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
  if (!['new', 'processing'].includes(order.status)) return res.json({ ok: false, error: 'Заказ уже закрыт' }, 400);
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
  if (db.isOrderArchived(currentOrder)) {
    return res.json({
      ok: false, placed: true, errorCode: 'order_archived',
      error: 'Заказ закрыт. Оформите новый заказ.'
    }, 410);
  }
  if (!['new', 'processing'].includes(currentOrder.status)) return res.json({ ok: false, error: 'Заказ уже закрыт' }, 400);
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
      tried.push({ provider: p.id, code: outcome.code });
    }

    if (conflict) {
      return { status: 409, body: { ok: false, placed: true, errorCode: 'idempotency_conflict', error: 'Этот идентификатор уже использован для другого запроса.' } };
    }
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
  const photos = await optimizeUploads(req.filesFor('photos').slice(0, REVIEW_PHOTO_MAX), 1400);
  db.createReview({
    productId: p.id, author: req.body.author, rating: req.body.rating, text: req.body.text,
    config: req.body.config, delivery: req.body.delivery, reply: { text: req.body.reply },
    photos, previews: await reviewPreviews(photos),
    status: req.body.status === 'pending' ? 'pending' : 'approved',
    createdAt: parseDt(req.body.date) || Date.now()
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
  res.send(A.ordersList(settings(), db, req.query.flash, req.query.page, req.query.view, req.query.edit));
});
app.post('/admin/orders/:id/delete', (req, res) => {
  if (!guardAdmin(req, res)) return;
  const result = db.archiveOrder(req.params.id, 'admin');
  res.redirect(ordersBackUrl(req.body, result.ok ? 'Заказ удалён из списка' : 'Заказ не найден', 'active'), 303);
});
app.post('/admin/orders/:id/restore', (req, res) => {
  if (!guardAdmin(req, res)) return;
  const result = db.restoreOrder(req.params.id, 'admin');
  res.redirect(ordersBackUrl(req.body, result.ok ? 'Заказ восстановлен' : 'Заказ не найден', 'archive'), 303);
});
// Безвозвратное удаление — только из «Удалённых». Заказ, лежащий в рабочем
// списке, сюда не попадает вовсе: `db.purgeOrder()` отвечает отказом, если он
// не заархивирован. Два шага здесь и есть защита от нажатия не туда — стереть
// заявку из orders.json значит потерять привязку к уже выданному счёту.
/* Очистить корзину целиком — то же безвозвратное удаление, только разом.
 *
 * Регистрируется РАНЬШЕ `/admin/orders/:id/purge` для порядка чтения, хотя
 * перехватить он его и не мог бы: у адресов разное число сегментов.
 *
 * Рабочий список не трогается ни при каких условиях — `db.purgeArchivedOrders()`
 * берёт только заархивированное, и это единственная защита от «одним нажатием
 * снёс все заказы».
 */
app.post('/admin/orders/purge-all', (req, res) => {
  if (!guardAdmin(req, res)) return;
  const result = db.purgeArchivedOrders();
  const flash = result.removed
    ? `Удалено навсегда: ${result.removed}`
    : 'Удалённых заказов нет';
  res.redirect(ordersBackUrl(req.body, flash, 'archive'), 303);
});
app.post('/admin/orders/:id/purge', (req, res) => {
  if (!guardAdmin(req, res)) return;
  const result = db.purgeOrder(req.params.id);
  const flash = result.ok
    ? 'Заказ удалён навсегда'
    : (result.reason === 'not_archived' ? 'Сначала удалите заказ из списка' : 'Заказ не найден');
  res.redirect(ordersBackUrl(req.body, flash, 'archive'), 303);
});

/* ---------- Чат ---------- */

app.get('/admin/chat', (req, res) => {
  if (!guardAdmin(req, res)) return;
  res.send(A.chatList(settings(), db, req.query.flash, req.query.page));
});
app.get('/admin/chat/:id', (req, res) => {
  if (!guardAdmin(req, res)) return;
  const chat = CHAT.get(req.params.id);
  if (!chat) return sendNotFound(req, res);
  res.send(A.chatPage(settings(), db, chat, req.query.flash));
});

/* Ответ оператора из панели. Делает ровно то же, что сообщение в теме
 * Telegram, — и тем же способом: реплика ложится в переписку, уходит в живой
 * канал покупателя, а ИИ замолкает до конца разговора. Второго поведения у
 * «ответа оператора» быть не должно: разъехавшись, они означали бы, что бот
 * перебивает человека в зависимости от того, откуда тот написал.
 */
app.post('/admin/chat/:id/reply', (req, res) => {
  if (!guardAdmin(req, res)) return;
  const chat = CHAT.get(req.params.id);
  if (!chat) return sendNotFound(req, res);
  const back = (flash) => res.redirect('/admin/chat/' + encodeURIComponent(chat.id) + (flash ? '?flash=' + encodeURIComponent(flash) : ''), 303);

  // Кнопки «Вернуть ИИ» и «Завершить» — это отправка той же формы с другим
  // значением: вложенных форм в HTML не бывает, а браузер шлёт имя только
  // нажатой кнопки (тот же приём, что у удаления ответа на отзыв).
  const mode = String(req.body.mode || '');
  // Строку в ленту покупателя пишет `setMode`: одна и та же, откуда бы
  // собеседника ни сменили — из темы, командой или отсюда.
  if (mode === 'ai') {
    CHAT.setMode(chat, 'ai');
    TGCHAT.relaySystem(chat, 'ИИ снова отвечает (из панели)');
    return back('ИИ снова отвечает');
  }
  if (mode === 'closed') {
    CHAT.setMode(chat, 'closed');
    TGCHAT.relaySystem(chat, 'Диалог завершён (из панели)');
    return back('Диалог завершён');
  }

  const text = CHAT.clean(req.body.text, CHAT.MAX_TEXT).trim();
  if (!text) return back('Пустой ответ не отправлен');
  if (chat.mode !== 'operator') CHAT.setMode(chat, 'operator');
  CHAT.say(chat, 'operator', text, { by: 'Менеджер' });
  // В тему уходит и ответ из панели: иначе дежурный в Telegram видел бы вопрос
  // без ответа и написал бы второй раз то же самое.
  TGCHAT.relaySystem(chat, 'Ответ из панели: ' + text);
  return back('Отправлено');
});

/* ---------- Настройки магазина ---------- */

app.get('/admin/settings', async (req, res) => {
  if (!guardAdmin(req, res)) return;
  const s = settings();
  res.send(A.settingsPage(s, db, req.query.flash, 'ok', { live: await livePayMethods(s) }));
});
app.post('/admin/settings', async (req, res) => {
  if (!guardAdmin(req, res)) return;
  const current = settings();
  const live = await livePayMethods(current);
  const fail = (error) => res.send(A.settingsPage(current, db, error, 'err', { draft: req.body, live }), 400);
  if (!String(req.body.storeName || '').trim()) return fail('Укажите название магазина');
  const passwordProblem = passwordError(req.body.adminPassword, false);
  if (passwordProblem) return fail(passwordProblem);

  const logo = await resolveLogo(req, current.logoImage);
  const patch = Object.assign(brandFields(req.body), { logoImage: logo.value });
  patch.adminUsername = short(req.body.adminUsername, 100).trim() || current.adminUsername || 'admin';
  if (req.body.adminPassword && String(req.body.adminPassword).trim()) {
    patch.adminPasswordHash = auth.hashPassword(String(req.body.adminPassword).trim());
  }
  // Ключ «Подсказок» dadata.ru. Пустое поле стирает ключ.
  if (req.body.dadataToken !== undefined) patch.dadataToken = String(req.body.dadataToken).trim().slice(0, 200);
  // Галочка кассы снимается отсутствием поля в теле формы, как notifyReviews.
  patch.crocopayEnabled = req.body.crocopayEnabled !== undefined;
  if (req.body.crocopayClientId !== undefined) patch.crocopayClientId = String(req.body.crocopayClientId).trim().slice(0, 200);
  if (req.body.crocopayClientSecret !== undefined) patch.crocopayClientSecret = String(req.body.crocopayClientSecret).trim().slice(0, 300);
  // Вторая касса. Настраивается независимо от первой: включить можно любую, обе
  // или ни одной — покупатель разницы не увидит.
  patch.meridianpayEnabled = req.body.meridianpayEnabled !== undefined;
  if (req.body.meridianpayApiKey !== undefined) patch.meridianpayApiKey = String(req.body.meridianpayApiKey).trim().slice(0, 200);
  if (req.body.meridianpaySecret !== undefined) patch.meridianpaySecret = String(req.body.meridianpaySecret).trim().slice(0, 300);
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
  const willAi = (patch.aiApiKey !== undefined ? patch.aiApiKey : current.aiApiKey);
  const willTg = (patch.telegramBotToken !== undefined ? patch.telegramBotToken : current.telegramBotToken)
    && ((patch.chatChatId !== undefined ? patch.chatChatId : current.chatChatId)
      || (patch.telegramChatId !== undefined ? patch.telegramChatId : current.telegramChatId));
  if (willChat && !willAi && !willTg) {
    return fail('Чат включён, но отвечать некому: задайте ключ OpenAI или Telegram-бота с группой');
  }

  db.saveSettings(patch);
  if (logo.obsolete) db.deleteUploadIfUnused(logo.obsolete);
  // Списки способов кэшированы под ключи прежних касс — после смены ключей они
  // бы ещё пять минут отвечали за чужие.
  PAYMENTS.forgetMethods();
  // Мост в Telegram держит длинный опрос со СТАРЫМ токеном: без этого вызова
  // он продолжил бы работать с ним до перезапуска процесса, а новый чат молчал.
  TGCHAT.sync(settings());
  res.redirect('/admin/settings?flash=' + encodeURIComponent('Сохранено'));
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
