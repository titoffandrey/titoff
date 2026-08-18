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
const DELIVERY = require('./lib/delivery');
const SHIP = require('./lib/delivery-price');
const ADDRESS = require('./lib/address');
const PICKUP = require('./lib/pickup');
const PAY = require('./lib/pay-methods');
const { findBand, variantMissing, findOptions, optionsAdd, optionFits, choiceMap } = require('./lib/variants');
const R = require('./lib/render');
const D = require('./lib/deals');
const A = require('./lib/admin-views');
const IMG = require('./lib/images');
const { Analytics, clientDetails, normalizeIp } = require('./lib/analytics');
const { App } = require('./lib/server-lib');

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
const app = new App({
  secret: db.getSettings().sessionSecret || 'fallback-secret',
  uploadDir: db.UPLOAD_DIR,
  trustProxy: process.env.TRUST_PROXY === '1',
  forceHttps: process.env.FORCE_HTTPS === '1'
});

app.static('/static', path.join(__dirname, 'public'));
app.static('/uploads', db.UPLOAD_DIR, { extensions: ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.mp4', '.m4v', '.mov'] });

const settings = () => db.getSettings();
const PRICE_MAX = 1e12;
const PASSWORD_MIN = 10;
const PRODUCT_IMAGE_MAX = 100;
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
// Вернуться на ту же страницу списка после действия над строкой. Номер приходит
// скрытым полем формы, поэтому приводится к целому здесь; первая страница —
// адрес без параметра, чтобы ссылки не обрастали мусором.
const pageQuery = (value) => {
  const n = Math.floor(Number(value));
  return Number.isFinite(n) && n > 1 ? '?page=' + Math.min(n, 1e6) : '';
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
const backFrom = (src) => ({
  status: String((src && src.tab) || ''), page: src && src.page,
  sort: String((src && src.sort) || ''), product: String((src && src.product) || '')
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
  // Сравнение с NaN всегда ложно, поэтому «abc» в старой цене проходило проверку
  // и потом молча превращалось в пустое поле. Число проверяем явно.
  const oldPrice = String(body.oldPrice || '').trim();
  if (oldPrice && (!Number.isFinite(Number(oldPrice)) || Number(oldPrice) > PRICE_MAX)) errors.push({ field: 'oldPrice', text: 'Старая цена должна быть корректным числом' });
  else if (oldPrice && Number(oldPrice) <= price) errors.push({ field: 'oldPrice', text: 'Старая цена должна быть выше базовой — иначе зачёркивать нечего' });
  if (body.hotDeal !== undefined) {
    const deal = String(body.hotDealPrice || '').trim();
    if (!deal) errors.push({ field: 'hotDealPrice', text: 'Для горящей скидки нужна цена по акции' });
    else if (!Number.isFinite(Number(deal)) || !(Number(deal) > 0) || Number(deal) >= price || Number(deal) > PRICE_MAX) errors.push({ field: 'hotDealPrice', text: 'Цена по акции должна быть меньше базовой' });
  }
  return errors;
}
function tgEsc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
function isLoopback(address) { return /^(?:127(?:\.\d+){3}|::1|::ffff:127(?:\.\d+){3})$/.test(String(address || '')); }
function trustedProxy(req) { return process.env.TRUST_PROXY === '1' || isLoopback(req.socket && req.socket.remoteAddress); }
function requestHost(req) {
  const forwardedHost = trustedProxy(req) ? String(req.headers['x-forwarded-host'] || '').split(',')[0].trim() : '';
  const raw = String(forwardedHost || req.headers.host || '').split(',')[0].trim();
  return /^(?:[a-z0-9.-]+(?::\d{1,5})?|\[[0-9a-f:.]+\](?::\d{1,5})?)$/i.test(raw) ? raw : 'localhost';
}
// Абсолютный адрес сайта (для canonical, Open Graph, sitemap).
function originOf(req) {
  const forwardedProto = trustedProxy(req) ? String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() : '';
  const proto = process.env.FORCE_HTTPS === '1' || forwardedProto === 'https' || !!(req.socket && req.socket.encrypted) ? 'https' : 'http';
  const host = requestHost(req);
  return proto + '://' + host;
}
// Оптимизировать загруженные фото: WebP + очистка метаданных.
const optimizeUploads = (files, maxSize, opts) => IMG.optimizeMany(db.UPLOAD_DIR, persistUploads(files), maxSize, opts);
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
function clientIp(req) {
  const canTrust = trustedProxy(req);
  const cloudflare = canTrust ? String(req.headers['cf-connecting-ip'] || '').trim() : '';
  const forwarded = canTrust ? String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() : '';
  const real = canTrust ? String(req.headers['x-real-ip'] || '').trim() : '';
  for (const candidate of [cloudflare, forwarded, real, req.socket && req.socket.remoteAddress]) {
    const ip = normalizeIp(candidate);
    if (ip) return ip;
  }
  return '?';
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
  const context = metrics.context(req, clientIp(req), trustedProxy(req));
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
function loginFail(req) { const ip = clientIp(req); const r = loginAttempts.get(ip) || { count: 0, until: 0 }; r.count++; if (r.count >= 6) { r.until = Date.now() + 15 * 60 * 1000; r.count = 0; } r.seen = Date.now(); loginAttempts.set(ip, r); }
function loginOk(req) { loginAttempts.delete(clientIp(req)); }
const TOO_MANY = 'Слишком много попыток входа. Подождите 15 минут.';

// Антиспам публичных форм (отзывы, заказы): не больше N запросов с одного IP за окно.
const rateHits = new Map();
function rateLimited(req, bucket, limit, windowMs) {
  const key = bucket + ':' + clientIp(req);
  const now = Date.now();
  const r = rateHits.get(key);
  if (!r || now - r.start > windowMs) { rateHits.set(key, { start: now, count: 1 }); return false; }
  r.count++;
  return r.count > limit;
}
// Раз в 30 минут выметаем протухшие записи, чтобы карты не росли бесконечно.
const sweep = setInterval(() => {
  const now = Date.now();
  for (const [k, v] of rateHits) if (now - v.start > 60 * 60 * 1000) rateHits.delete(k);
  for (const [k, v] of loginAttempts) if (v.until < now && now - (v.seen || 0) > 60 * 60 * 1000) loginAttempts.delete(k);
}, 30 * 60 * 1000);
if (sweep.unref) sweep.unref();

/* =========================== ВИТРИНА =========================== */

/* Неоплаченный счёт, о котором стоит напомнить на любой странице витрины.
 *
 * Покупатель со страницы оплаты уходит легко, а товары к этому моменту уже
 * уехали в заказ и из корзины пропали — сама корзина о нём не напомнит.
 *
 * Ключ — та же подписанная cookie-сессия, что у /pay/:id: чужой заказ так не
 * покажешь. Список `myOrders` идёт от свежего к старым, поэтому первый
 * подходящий и есть нужный.
 *
 * Напоминаем только про ДЕЙСТВУЮЩИЙ счёт: у сгоревшего реквизиты уже чужие, а
 * «заказ ждёт оплаты» на оплаченном или отменённом — прямая ошибка. Поэтому
 * условие ровно то же, что у `live` на самой странице оплаты.
 */
function payRemind(req) {
  const ids = Array.isArray(req.session && req.session.myOrders) ? req.session.myOrders : [];
  if (!ids.length) return null;
  const now = Date.now();
  for (const id of ids) {
    const order = db.getOrder(String(id || ''));
    if (!order || order.draft) continue;                       // черновик заказом ещё не стал
    const pay = order.payment;
    if (!pay || pay.status !== 'pending' || !pay.invoiceId || !pay.requisite) continue;
    if (!pay.expiresAt || pay.expiresAt <= now) continue;
    return { id: order.id, number: order.number, total: order.total, expiresAt: pay.expiresAt };
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
  // `payOnline` решает подпись кнопки: «Перейти к оплате» либо «Оформить заказ».
  res.send(R.checkoutPage(settings(), pageOpts(req, { payOnline: CROCO.enabled(settings()) })));
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
  const context = Object.assign(metrics.context(req, clientIp(req), trustedProxy(req)), clientDetails(req.body.client));
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
  if (id) metrics.heartbeat({ id, path: req.body.path, context: metrics.context(req, clientIp(req), trustedProxy(req)) });
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
    const price = D.effectivePrice(view) + (st ? Number(st.add) || 0 : 0)
      + (band ? Number(band.option.add) || 0 : 0) + (sz ? Number(sz.add) || 0 : 0)
      + optionsAdd(chosen);
    const outOfStock = !view.inStock || (st && st.inStock === false) || (cl && cl.inStock === false)
      || (band && band.option.inStock === false)
      || (band && band.option.forColor && band.option.forColor !== color)
      || chosen.some(c => c.value && (c.value.inStock === false || !optionFits(c.value, storage, choiceMap(chosen))))
      // Конфигурация тоже бывает привязана к выбору: 8 ТБ у MacBook Pro есть
      // только с M5 Max. Проверяем на сервере — корзина могла собраться раньше.
      || (st && !optionFits(st, storage, choiceMap(chosen)))
      || variantMissing(view, it);
    return {
      id: view.id, name: view.name, storage, color, price,
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
  const q = SHIP.quoteAll(address, Number.isFinite(goods) && goods > 0 ? goods : 0);
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
  // `ready` отделяет «у нас нет списка этого перевозчика» от «рядом ничего не
  // нашлось». Без него покупателю OZON, чьей базы у нас пока нет вовсе, витрина
  // сообщала бы, что пунктов рядом нет, — а это неправда.
  res.json({ ok: true, ready: PICKUP.has(method), items });
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
    + `👤 Получатель: ${tgEsc(order.customerName) || '—'}\n📞 Контакт: ${tgEsc(order.contact)}\n`
    + (order.delivery ? `🚚 Доставка: ${tgEsc([DELIVERY.nameOf(order.delivery), DELIVERY.shortModeOf(order.delivery, order.deliveryMode)].filter(Boolean).join(', '))}`
      + `${order.deliveryPrice ? ` — ${R.money(order.deliveryPrice, ss)}` : ''}\n` : '')
    + (order.address ? `📍 Адрес: ${order.pickupCode ? tgEsc(order.pickupCode) + ' — ' : ''}${tgEsc(order.address)}\n` : '')
    + `🌍 Город: ${tgEsc([order.clientCity, order.clientRegion, order.clientCountry].filter(Boolean).join(', ')) || 'не определён'}\n`
    + `💻 Устройство: ${tgEsc([order.clientModel || order.clientDevice, order.clientOs, order.clientBrowser].filter(Boolean).join(' · ')) || 'не определено'}\n`
    + `🌐 IP: ${tgEsc(order.clientIp) || 'не определён'}\n`
    + (order.comment ? `💬 ${tgEsc(order.comment)}\n` : '')
    + `\n${lines}\n\n<b>Итого: ${R.money(order.total, ss)}</b>`;
  sendTelegram(ss, msg).catch(() => {});
}

app.post('/api/order', async (req, res) => {
  if (rateLimited(req, 'order', 10, 10 * 60 * 1000)) return res.json({ ok: false, error: 'Слишком часто. Попробуйте позже.' }, 429);
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
  const contact = String(req.body.contact || '').trim();
  if (!contact) return res.json({ ok: false, error: 'Укажите контакт для связи' }, 400);
  // Получатель и доставка обязательны: заказ идёт с предоплатой и уезжает
  // перевозчиком, а не «уточним при подтверждении», как было у заявки.
  const firstName = String(req.body.firstName || '').trim();
  const lastName = String(req.body.lastName || '').trim();
  if (!firstName) return res.json({ ok: false, error: 'Укажите имя получателя' }, 400);
  if (!lastName) return res.json({ ok: false, error: 'Укажите фамилию получателя' }, 400);
  const delivery = String(req.body.delivery || '').trim();
  if (!DELIVERY.isValid(delivery)) return res.json({ ok: false, error: 'Выберите способ доставки' }, 400);
  const deliveryMode = String(req.body.deliveryMode || '').trim();
  if (!DELIVERY.isValidMode(delivery, deliveryMode)) return res.json({ ok: false, error: 'Выберите, куда доставить: в пункт выдачи или курьером' }, 400);
  /* Выбранный пункт выдачи. Код приходит от витрины, а АДРЕС БЕРЁТСЯ ИЗ БАЗЫ —
   * клиентской строке верим не больше, чем клиентской цене: иначе в заказ уехал
   * бы код одного пункта с адресом другого. Не нашёлся код (база обновилась, и
   * пункт закрыли) — это не отказ: адрес покупателя всё равно с ним, а пункт
   * менеджер уточнит. Курьеру пункт ни к чему, поэтому берём его только у «pvz».
   */
  const point = deliveryMode === 'pvz' ? PICKUP.findPoint(delivery, req.body.pickupCode) : null;
  const address = point ? PICKUP.addressOf(point) : String(req.body.address || '').trim();
  if (!address) return res.json({ ok: false, error: 'Укажите адрес или пункт выдачи' }, 400);
  // Адрес обязан быть полным: населённый пункт, улица и дом. По «Екатеринбургу»
  // нельзя ни оформить накладную, ни посчитать доставку, а заказ уже оплачен.
  const addressCheck = ADDRESS.checkAddress(address);
  if (!addressCheck.ok) return res.json({ ok: false, error: addressCheck.error }, 400);

  // Доставку считаем заново по своей сетке тарифов — ровно так же, как цену
  // товаров. Витрина показывала свою цифру, но она приходит от того же расчёта
  // (`/api/delivery/quote`), а не из скрипта, поэтому расходиться им не с чего.
  const ship = SHIP.quote(delivery, deliveryMode, address, total);
  if (!ship.ok) return res.json({ ok: false, error: 'Не удалось рассчитать доставку — выберите другой способ' }, 400);
  const grandTotal = total + ship.price;
  // Пределы одной покупки (1 000 – 250 000 ₽) — по сумме, которую платит
  // покупатель, то есть вместе с доставкой. Витрина гасит кнопку заранее, но
  // проверяем и здесь: клиентским данным не верим, как и в цене заказа.
  const limit = CROCO.limitError(grandTotal);
  if (limit) return res.json({ ok: false, error: limit }, 400);

  const visitorId = metrics.visitorId(req) || null;
  const metricVisitor = visitorId ? metrics.findVisitor(visitorId) : null;
  const requestIp = clientIp(req);
  const proxyTrusted = trustedProxy(req);
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
  const draft = CROCO.enabled(settings());
  const order = db.createOrder({
    draft,
    host: db.normHost(req.headers.host),
    items, total: grandTotal, itemsTotal: total,
    firstName, lastName, contact, address, delivery, comment: req.body.comment,
    deliveryMode, deliveryPrice: ship.price, deliveryZone: ship.zone,
    // Код пункта выдачи — то, по чему менеджер оформляет накладную: адрес у
    // перевозчика может быть записан иначе, а код у пункта один.
    pickupCode: point ? point.code : '',
    visitorId, clientIp: client.ip, clientCity: client.city, clientRegion: client.region,
    clientCountry: client.country, clientCountryCode: client.countryCode, clientIsp: client.isp, clientDevice: client.device,
    clientModel: client.model, clientOs: client.os, clientBrowser: client.browser,
    clientSource: (metricVisitor && metricVisitor.source) || client.source
  });
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
  const head = { paid: '💳 <b>Оплачен заказ', mismatch: '⚠️ <b>Оплата с расхождением' }[state];
  if (!head) return;                       // истёкший или отменённый счёт менеджера не будит
  const msg = `${head} ${tgEsc(R.orderNo(order.number))}</b>\n`
    + `👤 ${tgEsc(order.customerName) || '—'}\n📞 ${tgEsc(order.contact)}\n`
    + `<b>Сумма заказа: ${R.money(order.total, ss)}</b>\n`
    + (note ? `❗ ${tgEsc(note)}\n` : '');
  sendTelegram(ss, msg).catch(() => {});
}

// Выставить счёт по уже созданному заказу и отдать реквизиты.
app.post('/api/pay/crocopay/start', async (req, res) => {
  if (rateLimited(req, 'pay', 20, 10 * 60 * 1000)) return res.json({ ok: false, error: 'Слишком часто. Попробуйте позже.' }, 429);
  const s = settings();
  if (!CROCO.enabled(s)) return res.json({ ok: false, error: 'Онлайн-оплата отключена' }, 400);
  const id = String((req.body && req.body.orderId) || '');
  const order = ownOrder(req, id);
  if (!order) return res.json({ ok: false, error: 'Заказ не найден' }, 404);
  if (order.status === 'cancelled') return res.json({ ok: false, error: 'Заказ отменён' }, 400);
  if (order.payment && order.payment.status === 'paid') return res.json({ ok: false, error: 'Заказ уже оплачен' }, 400);
  // Пределы кассы проверяем и здесь: заказ мог быть оформлен до их появления, а
  // счёт на такую сумму она всё равно не выставит.
  if (!CROCO.payable(order.total)) return res.json({ ok: false, error: 'Эту сумму онлайн-оплата не принимает — менеджер свяжется с вами' }, 400);
  // Способ оплаты проверяем по своему закрытому списку до запроса: чужое
  // значение касса всё равно отвергнет, а поймать это лучше у себя.
  // Способ проверяем не только по своему закрытому списку, но и по тому, что
  // владелец оставил на витрине: скрытый в настройках способ не должен
  // проходить запросом мимо интерфейса.
  const method = String((req.body && req.body.method) || '');
  if (!PAY.allowed(null, s.payMethods).some(m => m.id === method)) {
    return res.json({ ok: false, error: 'Выберите способ оплаты' }, 400);
  }

  // Способ выбран — черновик становится заказом. Именно здесь, ДО обращения к
  // кассе: покупатель уже сказал, чем платит, и если касса откажет (у неё
  // кончились свободные реквизиты — штатный ответ), менеджер всё равно увидит
  // готового покупателя с заполненным адресом. А вот тот, кто просто открыл
  // страницу оплаты и ушёл, заказом не станет — и товары останутся у него в
  // корзине.
  const grown = db.promoteOrder(id);
  if (grown.promoted) {
    metrics.markOrder(grown.order.visitorId, grown.order);
    notifyNewOrder(grown.order);
  }

  // Token записываем ДО создания счёта: он уходит в callback_url, а id счёта
  // появляется только в ответе платёжки. У заказа с прежним платежом
  // startOrderPayment сохранит старый token — см. комментарий в lib/db.js.
  // Сумму храним в ОСНОВНЫХ единицах — в тех же, в которых её понимает касса
  // (документация обещает копейки и врёт, см. lib/crocopay.js).
  const started = db.startOrderPayment(id, {
    provider: 'crocopay', token: crypto.randomBytes(16).toString('hex'),
    method, amount: order.total, currency: CROCO.CURRENCY
  });
  if (!started || !started.payment || !started.payment.token) return res.json({ ok: false, error: 'Не удалось начать оплату' }, 500);

  const r = await CROCO.createInvoice(s, {
    amount: order.total,
    method,
    // Своего идентификатора заказа в теле вебхука нет вовсе — есть только
    // GET-параметры этого адреса, платёжка их сохраняет. Подпись подтверждает,
    // что вебхук от CrocoPAY, а token — что он про ЭТОТ заказ: без него хватило
    // бы одного перехваченного вебхука на любую заявку с той же суммой.
    callbackUrl: originOf(req) + '/api/pay/crocopay/callback?order=' + encodeURIComponent(id) + '&token=' + started.payment.token
  });
  if (!r.ok) {
    // В логе — способ и сумма: без них по одной строке «Requisites not found»
    // не понять, на чём именно споткнулась касса.
    console.error('crocopay invoice:', r.error, '| способ', method, '| сумма', order.total, '| заказ', R.orderNo(order.number));
    // Текст для покупателя собирает lib/crocopay.js: разбор чужих английских
    // ответов — знание об их API, и живёт оно рядом с остальным.
    // `placed` — заказ уже настоящий, даже если счёт не вышел. Витрине это нужно,
    // чтобы очистить корзину: иначе покупатель оформит второй такой же.
    return res.json({ ok: false, placed: true, error: CROCO.startError(r.error) }, 502);
  }
  // Способ пишем тот, что ВЕРНУЛА касса: на запрос TO_CARD она вправе выдать
  // TO_CARD_TRANSGRAN, и подпись реквизита должна соответствовать выданному.
  db.attachOrderInvoice(id, {
    invoiceId: r.invoice.id, requisite: r.invoice.requisite, bank: r.invoice.bank,
    owner: r.invoice.owner, method: r.invoice.method || method, expiresAt: r.invoice.expiresAt
  });
  res.json({ ok: true, placed: true, url: '/pay/' + encodeURIComponent(id) });
});

// Статус счёта — то, ради чего затевался переход на H2H. Спрашиваем кассу и
// записываем изменение у себя; страница оплаты дёргает этот адрес по таймеру.
app.get('/api/pay/crocopay/status', async (req, res) => {
  if (rateLimited(req, 'pay-status', 240, 10 * 60 * 1000)) return res.json({ ok: false, error: 'Слишком часто' }, 429);
  const s = settings();
  const order = ownOrder(req, req.query.order);
  const pay = order && order.payment;
  if (!pay) return res.json({ ok: false, error: 'Оплата не запускалась' }, 404);
  // Уже оплаченный заказ кассу не тревожим: 'paid' у нас липкий.
  if (pay.status === 'paid' || pay.status === 'mismatch') return res.json({ ok: true, state: pay.status });
  if (!CROCO.enabled(s) || !pay.invoiceId) return res.json({ ok: true, state: pay.status || 'pending' });

  const r = await CROCO.invoice(s, pay.invoiceId);
  if (!r.ok) return res.json({ ok: true, state: pay.status || 'pending', stale: true });
  const state = r.invoice.state;
  if (!state || state === 'pending') return res.json({ ok: true, state: 'pending', expires: pay.expiresAt || 0 });

  const result = db.settleOrderPayment(order.id, { status: state, total: r.invoice.amount });
  if (result && result.changed) notifyPayment(result.order, state, '');
  res.json({ ok: true, state });
});

// Страница оплаты: реквизиты выставленного счёта либо выбор способа. Своя, а не
// форма платёжки, — это и есть разница между H2H и Express.
// В trackPage она намеренно не попадает: пришлось бы вносить её и в
// metricPublicPath, а живой посетитель уехал бы в «неподтверждённые».
app.get('/pay/:id', async (req, res) => {
  const order = ownOrder(req, req.params.id);
  if (!order) return sendNotFound(req, res);
  const s = settings();
  // Список способов — тот, что реально включён у кассы. Ответ платёжки
  // кэшируется на пять минут, поэтому запрос уходит не на каждое открытие.
  let methods = [];
  if (CROCO.enabled(s)) {
    const r = await CROCO.availableOptions(s);
    methods = PAY.allowed(r.ok ? r.options : null, s.payMethods);
  }
  res.send(R.payPage(s, order, pageOpts(req, {
    methods,
    // «Выбрать другой способ»: показать выбор поверх ещё действующего счёта.
    choose: String(req.query.choose || '') === '1',
    // На самой странице оплаты напоминать о неоплаченном счёте незачем: она и
    // есть напоминание.
    payRemind: null
  })));
});

// Вебхук об успешной оплате. Приходит только на успех (так в документации),
// поэтому «не оплатил» здесь не обрабатывается — такой заказ просто остаётся
// в 'pending', и его разбирает менеджер.
app.post('/api/pay/crocopay/callback', (req, res) => {
  const s = settings();
  const secret = String(s.crocopayClientSecret || '').trim();
  const id = String(req.query.order || '');
  const token = String(req.query.token || '');
  const order = secret ? db.getOrder(id) : null;
  const pay = order && order.payment;
  const expectedToken = String((pay && pay.token) || '');
  const tokenOk = !!expectedToken && expectedToken.length === token.length
    && crypto.timingSafeEqual(Buffer.from(expectedToken), Buffer.from(token));
  if (!tokenOk || !CROCO.verify(secret, req.body, req.rawBody)) {
    // Как в документации: неподтверждённый вебхук — 403 и ничего не меняем.
    return res.json({ ok: false }, 403);
  }

  // Ожидаемую сумму мы записали в рублях, а в каких единицах её пришлёт вебхук —
  // проверить, не проведя настоящий платёж, невозможно: документация обещает
  // минимальные, но на счёте она уже соврала. `paidEnough()` принимает оба
  // прочтения и на недоплате не срабатывает ни по одному из них.
  const expected = Number(pay.amount) || 0;
  const raw = req.body && req.body.total;
  const check = CROCO.paidEnough(expected, raw);
  const note = check.major === null ? 'Платёжка не передала сумму'
    : (Math.abs(check.major - expected) < 0.01 ? '' : `Пришло ${raw}, ожидали ${expected} ${pay.currency || ''}`.trim());
  const state = check.ok ? 'paid' : 'mismatch';
  const result = db.settleOrderPayment(id, { status: state, total: check.major, timestamp: req.body && req.body.timestamp, note });
  if (!result) return res.json({ ok: false }, 404);

  // Платёжка вправе повторить вызов, да и опрос статуса приходит к тому же
  // изменению — второй раз менеджера не дёргаем.
  if (result.changed) notifyPayment(order, state, note);
  res.json({ ok: true });
});
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

app.get('/admin', (req, res) => { if (!guardAdmin(req, res)) return; res.send(A.dashboard(settings(), db)); });
app.get('/admin/analytics', (req, res) => {
  if (!guardAdmin(req, res)) return;
  res.send(A.analyticsPage(settings(), db, metrics.snapshot({ days: req.query.days })));
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
  const orders = db.visibleOrders()
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
    name: req.body.name, category: req.body.category, price: req.body.price, oldPrice: req.body.oldPrice,
    inStock: req.body.inStock !== undefined, visible: req.body.visible !== undefined, stockLevel: req.body.stockLevel,
    shortDesc: req.body.shortDesc, description: req.body.description, specs: req.body.specs,
    hotDeal: req.body.hotDeal !== undefined, hotDealPrice: req.body.hotDealPrice, hotDealUntil: parseDt(req.body.hotDealUntil),
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
app.get('/admin/reviews', (req, res) => { if (!guardAdmin(req, res)) return; res.send(A.reviewsList(settings(), db, req.query.status, req.query.flash, req.query.page, req.query.sort)); });
app.get('/admin/reviews/new', (req, res) => { if (!guardAdmin(req, res)) return; res.send(A.reviewForm(settings(), db, null, { productId: req.query.productId })); });
app.post('/admin/reviews/new', async (req, res) => {
  if (!guardAdmin(req, res)) return;
  const p = db.getProduct(req.body.productId); if (!p) return res.redirect('/admin/reviews');
  const photos = await optimizeUploads(req.filesFor('photos').slice(0, REVIEW_PHOTO_MAX), 1400);
  db.createReview({
    productId: p.id, author: req.body.author, rating: req.body.rating, text: req.body.text,
    config: req.body.config, delivery: req.body.delivery,
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
  res.send(A.productReviews(settings(), db, p, req.query.status, req.query.flash, req.query.page, req.query.sort));
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
    createdAt: createdAt || rv.createdAt,
    photos: (rv.photos || []).filter(f => !dropped.has(f)).concat(added),
    videos: (rv.videos || []).filter(f => !dropped.has(f)),
    previews: await reviewPreviews(added)
  });
  res.redirect(reviewsBackUrl(req.body, 'Отзыв сохранён', 'rv-' + rv.id));
});
app.post('/admin/reviews/:id/approve', (req, res) => { if (!guardAdmin(req, res)) return; db.setReviewStatus(req.params.id, 'approved'); res.redirect(reviewsBackUrl(req.body, 'Отзыв опубликован')); });
// «Снять с витрины» — возврат в очередь модерации. Прежде отзыв прятали в
// админке домена; прятать его теперь негде и не от кого, а вот вернуть на
// доработку иногда нужно, и удаление для этого слишком грубо.
app.post('/admin/reviews/:id/hide', (req, res) => { if (!guardAdmin(req, res)) return; db.setReviewStatus(req.params.id, 'pending'); res.redirect(reviewsBackUrl(req.body, 'Отзыв снят с витрины')); });
app.post('/admin/reviews/:id/delete', (req, res) => { if (!guardAdmin(req, res)) return; db.deleteReview(req.params.id); res.redirect(reviewsBackUrl(req.body, 'Отзыв удалён')); });

/* ---------- Заказы ---------- */
app.get('/admin/orders', (req, res) => { if (!guardAdmin(req, res)) return; res.send(A.ordersList(settings(), db, req.query.flash, req.query.page)); });
app.post('/admin/orders/:id/delete', (req, res) => { if (!guardAdmin(req, res)) return; db.deleteOrder(req.params.id); res.redirect('/admin/orders' + pageQuery(req.body.page)); });

/* ---------- Настройки магазина ---------- */
app.get('/admin/settings', (req, res) => { if (!guardAdmin(req, res)) return; res.send(A.settingsPage(settings(), db, req.query.flash)); });
app.post('/admin/settings', async (req, res) => {
  if (!guardAdmin(req, res)) return;
  const current = settings();
  const fail = (error) => res.send(A.settingsPage(current, db, error, 'err', { draft: req.body }), 400);
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
  // Способы оплаты — галочки, поэтому снятые в теле формы просто отсутствуют.
  // Скрытое поле payMethodsForm говорит, что секция вообще пришла: без него
  // снятие ВСЕХ галочек было бы неотличимо от запроса без этой секции.
  if (req.body.payMethodsForm !== undefined) {
    const picked = [].concat(req.body.payMethods === undefined ? [] : req.body.payMethods);
    patch.payMethods = PAY.METHODS.map(m => m.id).filter(id => picked.includes(id));
  }
  db.saveSettings(patch);
  if (logo.obsolete) db.deleteUploadIfUnused(logo.obsolete);
  // Список способов оплаты кэширован под ключи прежней кассы — после смены
  // ключей он бы ещё пять минут отвечал за чужую кассу.
  CROCO.forgetMethods();
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
  console.log('');
});

let shuttingDown = false;
function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  metrics.flush();
  httpServer.close(() => process.exit(0));
  const force = setTimeout(() => process.exit(0), 5000);
  if (force.unref) force.unref();
}
process.once('SIGTERM', shutdown);
process.once('SIGINT', shutdown);
