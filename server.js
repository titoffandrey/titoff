'use strict';
// Точка входа. Мультитенант: один процесс — много доменов. Без внешних зависимостей.
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const db = require('./lib/db');
const auth = require('./lib/auth');
const { sendTelegram } = require('./lib/telegram');
const { suggestAddress } = require('./lib/dadata');
const { findBand, variantMissing, findOptions, optionsAdd, optionFits, choiceMap } = require('./lib/variants');
const R = require('./lib/render');
const D = require('./lib/deals');
const T = require('./lib/tenancy');
const O = require('./lib/owner-views');
const S = require('./lib/site-views');
const IMG = require('./lib/images');
const { Analytics, clientDetails, normalizeIp } = require('./lib/analytics');
const { App } = require('./lib/server-lib');

db.ensureSeeded();
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
app.static('/uploads', db.UPLOAD_DIR, { extensions: ['.jpg', '.jpeg', '.png', '.gif', '.webp'] });

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
// Тот же возврат для очереди отзывов, где к странице добавляется ещё и вкладка.
// Владелец разбирает модерацию сотнями страниц, и после каждого действия его
// нельзя выбрасывать ни в начало списка, ни с вкладки «На модерации» на «Все».
const REVIEW_TABS = ['all', 'pending', 'approved'];
const reviewsBackUrl = (body, flash) => {
  const params = [];
  const status = String((body && body.status) || '');
  if (REVIEW_TABS.includes(status) && status !== 'all') params.push('status=' + status);
  const n = Math.floor(Number(body && body.page));
  if (Number.isFinite(n) && n > 1) params.push('page=' + Math.min(n, 1e6));
  if (flash) params.push('flash=' + encodeURIComponent(flash));
  return '/owner/reviews' + (params.length ? '?' + params.join('&') : '');
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
function siteOf(req) {
  const localHost = ['localhost', '127.0.0.1', '::1'].includes(db.normHost(requestHost(req)));
  const localPreview = localHost && isLoopback(req.socket && req.socket.remoteAddress);
  let siteQuery = (localPreview || process.env.ALLOW_SITE_QUERY === '1') ? req.query.site : null;
  // Локальный ?site= запоминаем в подписанной сессии: ссылки и API-запросы без
  // query-параметра продолжают работать с тем же демо-магазином.
  if (localPreview) {
    if (siteQuery && db.getSite(siteQuery)) req.session.previewSite = siteQuery;
    else if (!siteQuery && req.session && db.getSite(req.session.previewSite)) siteQuery = req.session.previewSite;
  }
  return T.resolveSite(requestHost(req), siteQuery);
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
// Логотип сайта: удалить старый (если попросили), загрузить/оптимизировать новый, иначе оставить как было.
async function resolveLogo(req, site) {
  const current = site ? site.logoImage : null;
  const remove = req.body.removeLogo !== undefined;
  const up = await optimizeUploads(req.filesFor('logo'), 480);
  const value = up.length ? up[0] : (remove ? null : current);
  return { value, obsolete: current && current !== value ? current : null };
}

const SITE_FONTS = new Set(['system', 'rounded', 'grotesk', 'serif', 'slab', 'mono']);
function siteFields(body, current) {
  return {
    storeName: short(body.storeName, 100), tagline: short(body.tagline, 240),
    accentColor: safeHex(body.accentColor, '#0071e3'), currency: short(body.currency, 12).replace(/[<>&]/g, '') || '₽',
    currencyPosition: body.currencyPosition === 'before' ? 'before' : 'after', priceMultiplier: body.priceMultiplier,
    contactTelegram: short(body.contactTelegram, 100), contactPhone: short(body.contactPhone, 100), footerNote: short(body.footerNote, 500),
    legalOperator: short(body.legalOperator, 240).trim(), legalDetails: short(body.legalDetails, 240).trim(),
    legalAddress: short(body.legalAddress, 400).trim(), privacyEmail: short(body.privacyEmail, 160).trim(),
    telegramBotToken: short(body.telegramBotToken, 240), telegramChatId: short(body.telegramChatId, 100),
    notifyReviews: body.notifyReviews !== undefined,
    adminUsername: short(body.adminUsername, 100).trim() || (current && current.adminUsername) || 'admin',
    adminPassword: short(body.adminPassword, 500),
    logoText: short(body.logoText, 120), logoFont: SITE_FONTS.has(body.logoFont) ? body.logoFont : 'system',
    secondaryColor: safeHex(body.secondaryColor, safeHex(body.accentColor, '#0071e3'))
  };
}

function siteError(body, current) {
  if (!String(body.storeName || '').trim()) return 'Укажите название магазина';
  const multiplier = Number(body.priceMultiplier);
  if (!Number.isFinite(multiplier) || multiplier <= 0 || multiplier > 1000) {
    return 'Множитель цен должен быть числом больше нуля и не больше 1000';
  }
  const conflicts = db.findHostConflicts(body.hosts, current && current.id);
  if (conflicts.length) return 'Домен уже используется другим магазином: ' + conflicts.join(', ');
  return '';
}

function consentAccepted(value) {
  return value === true || ['1', 'true', 'on', 'yes'].includes(String(value || '').toLowerCase());
}

// Маркер зависит от текущего логина и хеша пароля, но не раскрывает их в cookie.
// После смены реквизитов все старые сессии перестают проходить guard автоматически.
function authStamp(kind, username, passwordHash) {
  return crypto.createHmac('sha256', settings().sessionSecret)
    .update([kind, username || '', passwordHash || ''].join('\0')).digest('base64url').slice(0, 24);
}
function ownerAuthorized(req) {
  const s = settings();
  return !!(req.session && req.session.owner === authStamp('owner', s.ownerUsername, s.ownerPasswordHash));
}
function siteAuthorized(req, site) {
  return !!(req.session && req.session.siteAdmin === site.id
    && req.session.siteAdminAuth === authStamp('site', site.adminUsername, site.adminPasswordHash));
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
function metricPublicPath(site, rawPath) {
  let pathname;
  try { pathname = decodeURIComponent(String(rawPath || '').split('?')[0]); } catch (e) { return ''; }
  // Список должен совпадать со страницами, которые считает trackPage. Без
  // /checkout сервер записывал его посещение как «предварительное», клиент такой
  // адрес не подтверждал, и живой посетитель, зашедший сразу на оформление,
  // через две минуты уезжал в «неподтверждённые автоматические запросы».
  if (['/', '/checkout', '/privacy', '/personal-data-consent', '/personal-data-publication-consent'].includes(pathname)) return pathname;
  const match = pathname.match(/^\/product\/([^/]+)$/);
  return match && T.siteProductView(site, match[1]) ? '/product/' + match[1] : '';
}
function trackPage(req, res, site, pathname, options) {
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
    id, siteId: site.id, path: pathname, host: req.headers.host,
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

/* =========================== ВИТРИНА (по домену) =========================== */

app.get('/', (req, res) => {
  const site = siteOf(req);
  trackPage(req, res, site, '/');
  res.send(R.homePage(T.siteSettings(site), db, { category: req.query.category, q: req.query.q, origin: originOf(req) }, site));
});

app.get('/product/:id', (req, res) => {
  const site = siteOf(req);
  const view = T.siteProductView(site, req.params.id);
  if (!view) {
    trackPage(req, res, site, '/404', { is404: true, requestedPath: req.url });
    return res.send(R.notFoundPage(T.siteSettings(site), {
      origin: originOf(req), categories: T.siteCategories(site)
    }), 404);
  }
  trackPage(req, res, site, '/product/' + view.id);
  // Отзывы этого посетителя, ещё не прошедшие модерацию: их видит только он сам
  const mine = Array.isArray(req.session && req.session.myReviews) ? req.session.myReviews : [];
  // Ищем по индексу товара, а не по всему файлу: на боевых данных это 300 записей
  // вместо 7000 на каждое открытие страницы любым, кто когда-то оставил отзыв.
  const ownReviews = mine.length
    ? db.reviewsForProduct(view.id, false).filter(rv => rv.status !== 'approved' && mine.includes(rv.id))
    : [];
  res.send(R.productPage(T.siteSettings(site), db, view, site, {
    origin: originOf(req), ownReviews,
    // Без JS «Показать ещё» — обычная ссылка на следующую страницу отзывов.
    reviewSort: req.query.rsort, reviewPage: req.query.rpage
  }));
});

app.get('/checkout', (req, res) => {
  const site = siteOf(req);
  trackPage(req, res, site, '/checkout');
  res.send(R.checkoutPage(T.siteSettings(site), { origin: originOf(req), categories: T.siteCategories(site) }));
});

app.get('/privacy', (req, res) => {
  const site = siteOf(req);
  trackPage(req, res, site, '/privacy');
  res.send(R.privacyPage(T.siteSettings(site), { origin: originOf(req), categories: T.siteCategories(site) }));
});

app.get('/personal-data-consent', (req, res) => {
  const site = siteOf(req);
  trackPage(req, res, site, '/personal-data-consent');
  res.send(R.personalDataConsentPage(T.siteSettings(site), { origin: originOf(req), categories: T.siteCategories(site) }));
});

app.get('/personal-data-publication-consent', (req, res) => {
  const site = siteOf(req);
  trackPage(req, res, site, '/personal-data-publication-consent');
  res.send(R.publicationConsentPage(T.siteSettings(site), { origin: originOf(req), categories: T.siteCategories(site) }));
});

// Собственная метрика запускается автоматически при первом открытии страницы.
app.post('/api/analytics/start', (req, res) => {
  if (rateLimited(req, 'analytics-start', 120, 10 * 60 * 1000)) return res.json({ ok: false }, 429);
  const site = siteOf(req);
  const publicPath = metricPublicPath(site, req.body.path);
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
  const input = {
    id, siteId: site.id, path: publicPath, host: req.headers.host, referrer: req.body.referrer,
    context
  };
  metrics.recordPageView(input);
  res.json({ ok: true });
});

app.post('/api/analytics/ping', (req, res) => {
  if (rateLimited(req, 'analytics-ping', 180, 10 * 60 * 1000)) {
    res.writeHead(429, { 'Cache-Control': 'private, no-store' });
    return res.end();
  }
  const site = siteOf(req);
  const id = metrics.visitorId(req);
  if (id) metrics.heartbeat({ id, siteId: site.id, path: req.body.path, context: metrics.context(req, clientIp(req), trustedProxy(req)) });
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

// robots.txt и sitemap.xml — по домену
app.get('/robots.txt', (req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
  // Панели и оформление заказа в индексе не нужны: это личные страницы и формы,
  // а их адреса иначе попадали в выдачу через страницы входа.
  res.end(`User-agent: *\nAllow: /\nDisallow: /admin\nDisallow: /owner\nDisallow: /checkout\nDisallow: /api/\nSitemap: ${originOf(req)}/sitemap.xml\n`);
});
// Браузеры запрашивают favicon автоматически. Это не посещение и не ошибка
// сканера, поэтому отвечаем без содержимого и не добавляем запрос в метрику.
app.get('/favicon.ico', (req, res) => {
  res.writeHead(204, { 'Cache-Control': 'public, max-age=86400' });
  res.end();
});
app.get('/sitemap.xml', (req, res) => {
  const site = siteOf(req);
  const origin = originOf(req);
  const urls = [
    '<url><loc>' + R.esc(origin) + '/</loc><changefreq>daily</changefreq></url>',
    '<url><loc>' + R.esc(origin) + '/privacy</loc></url>',
    '<url><loc>' + R.esc(origin) + '/personal-data-consent</loc></url>',
    '<url><loc>' + R.esc(origin) + '/personal-data-publication-consent</loc></url>'
  ];
  for (const category of T.siteCategories(site)) {
    urls.push('<url><loc>' + R.esc(origin) + '/?category=' + encodeURIComponent(category) + '</loc><changefreq>weekly</changefreq></url>');
  }
  for (const v of T.siteProductViews(site)) urls.push('<url><loc>' + R.esc(origin) + '/product/' + R.esc(v.id) + '</loc></url>');
  res.writeHead(200, { 'Content-Type': 'application/xml; charset=utf-8' });
  res.end('<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">' + urls.join('') + '</urlset>');
});

// Догрузка отзывов на странице товара: разметка карточки живёт в render.js,
// поэтому сервер отдаёт готовый HTML порции — витрине остаётся его вставить.
app.get('/api/reviews', (req, res) => {
  if (rateLimited(req, 'reviews-page', 120, 60 * 1000)) return res.json({ ok: false, error: 'Слишком часто. Попробуйте позже.' }, 429);
  const site = siteOf(req);
  const view = T.siteProductView(site, req.query.productId);
  if (!view) return res.json({ ok: false, error: 'Товар не найден' }, 404);
  const published = site ? T.siteReviews(site, view.id) : db.reviewsForProduct(view.id, true);
  const slice = R.reviewsSlice(published, req.query.sort, req.query.page);
  res.json({
    ok: true, html: slice.html, pager: R.reviewsPager(slice, '/product/' + encodeURIComponent(view.id)),
    sort: slice.sort, page: slice.page, pages: slice.pages, total: slice.total
  });
});

// Отзыв посетителя -> общий каталог, на модерацию к владельцу
app.post('/api/reviews', async (req, res) => {
  if (rateLimited(req, 'review', 5, 10 * 60 * 1000)) return res.json({ ok: false, error: 'Слишком часто. Попробуйте позже.' }, 429);
  const site = siteOf(req);
  const p = db.getProduct(req.body.productId);
  if (!p || !T.isEnabled(p, site)) return res.json({ ok: false, error: 'Товар не найден' }, 400);
  if (!consentAccepted(req.body.privacyAccepted)) return res.json({ ok: false, error: 'Подтвердите согласие на обработку персональных данных' }, 400);
  if (!consentAccepted(req.body.publicationAccepted)) return res.json({ ok: false, error: 'Подтвердите согласие на публикацию отзыва' }, 400);
  if (!String(req.body.author || '').trim()) return res.json({ ok: false, error: 'Укажите имя' }, 400);
  // Именно Number.isInteger: без него пропущенная оценка давала NaN, а сравнения
  // NaN < 1 и NaN > 5 оба ложны — отзыв проходил проверку и молча получал 5 звёзд.
  const rating = Number(req.body.rating);
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) return res.json({ ok: false, error: 'Укажите оценку от 1 до 5' }, 400);
  const clamp5 = v => { const n = Number(v); return Number.isInteger(n) && n >= 1 && n <= 5 ? n : null; };
  const aspects = (req.body.aspect_delivery || req.body.aspect_service || req.body.aspect_price)
    ? { delivery: clamp5(req.body.aspect_delivery), service: clamp5(req.body.aspect_service), price: clamp5(req.body.aspect_price) }
    : null;
  const review = db.createReview({
    productId: p.id, author: req.body.author, rating, text: req.body.text,
    photos: await optimizeUploads(req.filesFor('photos'), 1400), aspects, status: 'pending',
    siteId: site.id, siteName: site.storeName,
    privacyConsentAt: Date.now(), privacyConsentVersion: R.PRIVACY_VERSION,
    publicationConsentAt: Date.now(), publicationConsentVersion: R.PRIVACY_VERSION
  });
  // Автор видит свой отзыв на странице товара сразу — id складываем в его же
  // подписанную cookie-сессию. Для всех остальных отзыв появится только после
  // одобрения в панели: db.reviewsForProduct(id, true) отдаёт лишь approved.
  const mine = Array.isArray(req.session && req.session.myReviews) ? req.session.myReviews : [];
  req.session = Object.assign({}, req.session || {}, { myReviews: mine.concat(review.id).slice(-30) });

  const ss = T.siteSettings(site);
  if (ss.notifyReviews) {
    sendTelegram(ss, `📝 <b>Новый отзыв на модерации</b>\nМагазин: ${tgEsc(site.storeName)}\nТовар: ${tgEsc(p.name)}\nАвтор: ${tgEsc(review.author)}\nОценка: ${'★'.repeat(review.rating)}\n${review.text ? tgEsc(review.text) : ''}`).catch(() => {});
  }
  res.json({ ok: true, message: 'Спасибо за отзыв!' });
});

// Актуальные данные корзины. Корзина хранит только то, что было в момент
// добавления: у позиций, добавленных давно, нет фото, а цена могла измениться.
// Здесь сервер отдаёт по каждой позиции нынешние название, цену, фото и наличие.
app.post('/api/cart', (req, res) => {
  if (rateLimited(req, 'cart', 180, 10 * 60 * 1000)) return res.json({ ok: false }, 429);
  const site = siteOf(req);
  const raw = Array.isArray(req.body.items) ? req.body.items.slice(0, 100) : [];
  const items = raw.map(it => {
    if (!it || typeof it !== 'object') return null;
    const view = T.siteProductView(site, it.id);
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

// Заказ -> цена считается по ценам сайта, заявка в Telegram этого сайта
app.post('/api/order', async (req, res) => {
  if (rateLimited(req, 'order', 10, 10 * 60 * 1000)) return res.json({ ok: false, error: 'Слишком часто. Попробуйте позже.' }, 429);
  const site = siteOf(req);
  const rawItems = Array.isArray(req.body.items) ? req.body.items.slice(0, 100) : [];
  const items = []; let total = 0;
  for (const it of rawItems) {
    if (!it || typeof it !== 'object') continue;
    const view = T.siteProductView(site, it.id);
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

  const visitorId = metrics.visitorId(req) || null;
  const metricVisitor = visitorId ? metrics.findVisitor(visitorId) : null;
  const requestIp = clientIp(req);
  const proxyTrusted = trustedProxy(req);
  // Базовые данные устройства доступны без сети. Уже известный город берём из
  // карточки посетителя, а новый IP обогащаем после ответа покупателю.
  const client = metrics.context(req, requestIp, proxyTrusted);
  if (metricVisitor && metricVisitor.siteId === site.id) {
    for (const key of ['city', 'region', 'country', 'isp']) if (metricVisitor[key]) client[key] = metricVisitor[key];
  }

  const order = db.createOrder({
    siteId: site.id, siteName: site.storeName, host: db.normHost(req.headers.host),
    items, total, customerName: req.body.customerName, contact,
    address: String(req.body.address || '').trim(), comment: req.body.comment,
    visitorId, clientIp: client.ip, clientCity: client.city, clientRegion: client.region,
    clientCountry: client.country, clientIsp: client.isp, clientDevice: client.device,
    clientModel: client.model, clientOs: client.os, clientBrowser: client.browser,
    clientSource: (metricVisitor && metricVisitor.source) || client.source
  });
  metrics.markOrder(visitorId, order);
  const ss = T.siteSettings(site);
  const notify = saved => {
    const lines = items.map(i => `• ${tgEsc(i.name)} — ${i.qty} × ${R.money(i.price, ss)}`).join('\n');
    const msg = `🛒 <b>Новый заказ ${saved.number}</b>\n🏬 ${tgEsc(site.storeName)}\n`
      + `👤 Имя: ${tgEsc(saved.customerName) || '—'}\n📞 Контакт: ${tgEsc(saved.contact)}\n`
      + (saved.address ? `📍 Адрес: ${tgEsc(saved.address)}\n` : '')
      + `🌍 Город: ${tgEsc([saved.clientCity, saved.clientRegion, saved.clientCountry].filter(Boolean).join(', ')) || 'не определён'}\n`
      + `💻 Устройство: ${tgEsc([saved.clientModel || saved.clientDevice, saved.clientOs, saved.clientBrowser].filter(Boolean).join(' · ')) || 'не определено'}\n`
      + `🌐 IP: ${tgEsc(saved.clientIp) || 'не определён'}\n`
      + (saved.comment ? `💬 ${tgEsc(saved.comment)}\n` : '')
      + `\n${lines}\n\n<b>Итого: ${R.money(total, ss)}</b>`;
    sendTelegram(ss, msg).catch(() => {});
  };
  // Медленные геобаза и Telegram больше не держат покупателя на «Отправляем».
  // Заказ уже записан; технические поля безопасно обогащаются в фоне.
  metrics.describeRequest(req, requestIp, proxyTrusted).then(enriched => {
    const saved = db.updateOrderClient(order.id, {
      clientIp: enriched.ip, clientCity: enriched.city, clientRegion: enriched.region,
      clientCountry: enriched.country, clientIsp: enriched.isp, clientDevice: enriched.device,
      clientModel: enriched.model, clientOs: enriched.os, clientBrowser: enriched.browser,
      clientSource: (metricVisitor && metricVisitor.source) || enriched.source
    });
    notify(saved || order);
  }).catch(() => notify(order));
  res.json({ ok: true, number: order.number, total, telegram: 'queued' });
});

/* =========================== ПАНЕЛЬ ВЛАДЕЛЬЦА (/owner) =========================== */

function guardOwner(req, res) { if (ownerAuthorized(req)) return true; res.redirect('/owner/login'); return false; }

app.get('/owner/login', (req, res) => { if (ownerAuthorized(req)) return res.redirect('/owner'); res.send(O.loginPage(null)); });
app.post('/owner/login', async (req, res) => {
  if (loginBlocked(req)) return res.send(O.loginPage(TOO_MANY), 429);
  const s = settings();
  // Scrypt выполняется и при неверном логине: время ответа не выдаёт имя учётной записи.
  const passwordOk = await auth.verifyPasswordAsync(req.body.password, s.ownerPasswordHash);
  const ok = req.body.username === s.ownerUsername && passwordOk;
  if (!ok) { loginFail(req); return res.send(O.loginPage('Неверный логин или пароль'), 401); }
  loginOk(req); req.session.owner = authStamp('owner', s.ownerUsername, s.ownerPasswordHash); res.redirect('/owner');
});
app.post('/owner/logout', (req, res) => { req.session = null; res.redirect('/owner/login'); });

app.get('/owner', (req, res) => { if (!guardOwner(req, res)) return; res.send(O.dashboard(db)); });
app.get('/owner/analytics', (req, res) => {
  if (!guardOwner(req, res)) return;
  const siteId = db.getSite(req.query.site) ? req.query.site : '';
  res.send(O.analyticsPage(db, metrics.snapshot({ siteId, days: req.query.days }), siteId));
});

// Каталог (мастер)
app.get('/owner/products', (req, res) => { if (!guardOwner(req, res)) return; res.send(O.productsList(db, req.query.flash)); });
app.get('/owner/products/new', (req, res) => { if (!guardOwner(req, res)) return; res.send(O.productForm(db, null)); });
app.post('/owner/products', async (req, res) => {
  if (!guardOwner(req, res)) return;
  const errors = validateProduct(req.body);
  if (errors.length) return res.send(O.productForm(db, null, { errors, draft: req.body }), 400);
  db.createProduct({
    name: req.body.name, category: req.body.category, price: req.body.price, oldPrice: req.body.oldPrice, badge: req.body.badge,
    inStock: req.body.inStock !== undefined, stockLevel: req.body.stockLevel,
    shortDesc: req.body.shortDesc, description: req.body.description, specs: req.body.specs,
    hotDeal: req.body.hotDeal !== undefined, hotDealPrice: req.body.hotDealPrice, hotDealUntil: parseDt(req.body.hotDealUntil),
    colors: parseColors(req.body.colors), storages: parseStorages(req.body.storages),
    bands: parseBands(req.body.bands), options: parseOptions(req.body.options),
    images: await optimizeUploads(req.filesFor('images').slice(0, PRODUCT_IMAGE_MAX), 1200, { square: true })
  });
  res.redirect('/owner/products?flash=' + encodeURIComponent('Товар создан'));
});
// Порядок товаров в каталоге = порядок карточек на главной. Регистрируется
// РАНЬШЕ «/owner/products/:id»: побеждает первый совпавший маршрут, и товар с
// id «order» иначе перехватил бы этот адрес (а точнее наоборот — сохранение
// товара приняло бы наш запрос за форму и обнулило бы карточку).
app.post('/owner/products/order', (req, res) => {
  if (!guardApi(req, res)) return;
  const next = db.reorderProducts(Array.isArray(req.body.ids) ? req.body.ids.slice(0, 5000) : []);
  if (!next) return res.json({ ok: false, error: 'invalid_order' }, 400);
  res.json({ ok: true, ids: next.map(p => p.id) });
});
app.get('/owner/products/:id/edit', (req, res) => { if (!guardOwner(req, res)) return; const p = db.getProduct(req.params.id); if (!p) return res.redirect('/owner/products'); res.send(O.productForm(db, p)); });
app.post('/owner/products/:id', async (req, res) => {
  if (!guardOwner(req, res)) return;
  const p = db.getProduct(req.params.id); if (!p) return res.redirect('/owner/products');
  const errors = validateProduct(req.body);
  if (errors.length) return res.send(O.productForm(db, p, { errors, draft: req.body }), 400);
  const remove = asArray(req.body.removeImages);
  let images = (p.images || []).filter(src => !remove.includes(src));
  const colors = parseColors(req.body.colors);
  const colorNames = colors.map(c => c.name);
  const bands = parseBands(req.body.bands);
  // ключи вариаций ремешков вида «Коллекция|Цвет»
  const bandKeys = new Set();
  for (const g of bands) for (const o of g.options) bandKeys.add(g.name + '|' + o.name);
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
  db.updateProduct(p.id, {
    name: req.body.name, category: req.body.category, price: req.body.price, oldPrice: req.body.oldPrice, badge: req.body.badge,
    inStock: req.body.inStock !== undefined, stockLevel: req.body.stockLevel,
    shortDesc: req.body.shortDesc, description: req.body.description, specs: req.body.specs,
    hotDeal: req.body.hotDeal !== undefined, hotDealPrice: req.body.hotDealPrice, hotDealUntil: parseDt(req.body.hotDealUntil),
    colors, storages: parseStorages(req.body.storages), bands, options: parseOptions(req.body.options),
    images, imageColors, imageBands
  });
  remove.forEach(db.deleteUploadIfUnused);
  res.redirect('/owner/products?flash=' + encodeURIComponent('Сохранено'));
});
app.post('/owner/products/:id/delete', (req, res) => { if (!guardOwner(req, res)) return; db.deleteProduct(req.params.id); res.redirect('/owner/products?flash=' + encodeURIComponent('Товар удалён')); });

/* --- Фото товара без перезагрузки страницы (мгновенная загрузка и удаление) --- */
function guardApi(req, res) { if (ownerAuthorized(req)) return true; res.json({ ok: false, error: 'auth' }, 401); return false; }

// Загрузить фото сразу: сохраняет в товар и возвращает готовые файлы
app.post('/owner/products/:id/images/add', async (req, res) => {
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
app.post('/owner/products/:id/images/order', (req, res) => {
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
app.post('/owner/products/:id/images/main', (req, res) => {
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
app.post('/owner/products/:id/images/color', (req, res) => {
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
app.post('/owner/products/:id/images/remove', (req, res) => {
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

// Отзывы (мастер, модерация)
app.get('/owner/reviews', (req, res) => { if (!guardOwner(req, res)) return; res.send(O.reviewsList(db, req.query.status, req.query.flash, req.query.page)); });
app.get('/owner/reviews/new', (req, res) => { if (!guardOwner(req, res)) return; res.send(O.addReviewForm(db, req.query.productId, null)); });
app.post('/owner/reviews/new', async (req, res) => {
  if (!guardOwner(req, res)) return;
  const p = db.getProduct(req.body.productId); if (!p) return res.redirect('/owner/reviews');
  let createdAt = Date.now(); if (req.body.date) { const t = Date.parse(req.body.date); if (!isNaN(t)) createdAt = t; }
  const c5 = v => { const n = Number(v); return Number.isInteger(n) && n >= 1 && n <= 5 ? n : null; };
  const aspects = (req.body.aspect_delivery || req.body.aspect_service || req.body.aspect_price)
    ? { delivery: c5(req.body.aspect_delivery), service: c5(req.body.aspect_service), price: c5(req.body.aspect_price) } : null;
  db.createReview({ productId: p.id, author: req.body.author, rating: req.body.rating, text: req.body.text, photos: await optimizeUploads(req.filesFor('photos'), 1400), aspects, status: 'approved', createdAt });
  res.redirect('/owner/reviews?flash=' + encodeURIComponent('Отзыв опубликован'));
});
app.post('/owner/reviews/:id/approve', (req, res) => { if (!guardOwner(req, res)) return; db.setReviewStatus(req.params.id, 'approved'); res.redirect(reviewsBackUrl(req.body, 'Отзыв опубликован')); });
app.post('/owner/reviews/:id/delete', (req, res) => { if (!guardOwner(req, res)) return; db.deleteReview(req.params.id); res.redirect(reviewsBackUrl(req.body, 'Отзыв удалён')); });

// Домены
app.get('/owner/sites', (req, res) => { if (!guardOwner(req, res)) return; res.send(O.sitesList(db, req.query.flash)); });
app.get('/owner/sites/new', (req, res) => { if (!guardOwner(req, res)) return; res.send(O.siteForm(db, null)); });
app.post('/owner/sites', async (req, res) => {
  if (!guardOwner(req, res)) return;
  const error = siteError(req.body, null) || passwordError(req.body.adminPassword, true);
  if (error) return res.send(O.siteForm(db, null, { error, draft: req.body }), 400);
  const logo = await optimizeUploads(req.filesFor('logo'), 480);
  db.createSite(Object.assign(siteFields(req.body), {
    hosts: req.body.hosts,
    logoImage: logo.length ? logo[0] : null
  }));
  res.redirect('/owner/sites?flash=' + encodeURIComponent('Домен создан'));
});
app.get('/owner/sites/:id/edit', (req, res) => { if (!guardOwner(req, res)) return; const s = db.getSite(req.params.id); if (!s) return res.redirect('/owner/sites'); res.send(O.siteForm(db, s)); });
app.post('/owner/sites/:id', async (req, res) => {
  if (!guardOwner(req, res)) return;
  const current = db.getSite(req.params.id);
  if (!current) return res.redirect('/owner/sites');
  const error = siteError(req.body, current) || passwordError(req.body.adminPassword, false);
  if (error) return res.send(O.siteForm(db, current, { error, draft: req.body }), 400);
  const logo = await resolveLogo(req, current);
  db.updateSite(req.params.id, Object.assign(siteFields(req.body, current), { hosts: req.body.hosts, logoImage: logo.value }));
  if (logo.obsolete) db.deleteUploadIfUnused(logo.obsolete);
  res.redirect('/owner/sites?flash=' + encodeURIComponent('Сохранено'));
});
app.post('/owner/sites/:id/delete', (req, res) => {
  if (!guardOwner(req, res)) return;
  if (db.getSites().length <= 1) {
    return res.redirect('/owner/sites?flash=' + encodeURIComponent('Нельзя удалить последний домен — сначала создайте новый'));
  }
  db.deleteSite(req.params.id);
  res.redirect('/owner/sites?flash=' + encodeURIComponent('Домен удалён'));
});

// Заказы (все) + настройки владельца
app.get('/owner/orders', (req, res) => { if (!guardOwner(req, res)) return; res.send(O.ordersList(db, req.query.flash, req.query.page)); });
app.post('/owner/orders/:id/status', (req, res) => { if (!guardOwner(req, res)) return; db.setOrderStatus(req.params.id, req.body.status); res.redirect('/owner/orders' + pageQuery(req.body.page)); });
app.post('/owner/orders/:id/delete', (req, res) => { if (!guardOwner(req, res)) return; db.deleteOrder(req.params.id); res.redirect('/owner/orders' + pageQuery(req.body.page)); });

app.get('/owner/settings', (req, res) => { if (!guardOwner(req, res)) return; res.send(O.settingsPage(settings(), db, req.query.flash)); });
app.post('/owner/settings', (req, res) => {
  if (!guardOwner(req, res)) return;
  const error = passwordError(req.body.ownerPassword, false);
  if (error) return res.send(O.settingsPage(settings(), db, error, 'err'), 400);
  const patch = { ownerUsername: String(req.body.ownerUsername || '').trim().slice(0, 100) || settings().ownerUsername || 'owner' };
  if (req.body.ownerPassword && req.body.ownerPassword.trim()) patch.ownerPasswordHash = auth.hashPassword(req.body.ownerPassword.trim());
  // Ключ «Подсказок» dadata.ru — один на все домены. Пустое поле стирает ключ.
  if (req.body.dadataToken !== undefined) patch.dadataToken = String(req.body.dadataToken).trim().slice(0, 200);
  db.saveSettings(patch);
  res.redirect('/owner/settings?flash=' + encodeURIComponent('Сохранено'));
});

/* =========================== АДМИНКА САЙТА (/admin по домену) =========================== */

function guardSite(req, res) {
  const site = siteOf(req);
  if (siteAuthorized(req, site)) return site;
  res.redirect('/admin/login'); return null;
}

app.get('/admin/login', (req, res) => {
  const site = siteOf(req);
  if (siteAuthorized(req, site)) return res.redirect('/admin');
  res.send(S.loginPage(site, null));
});
app.post('/admin/login', async (req, res) => {
  const site = siteOf(req);
  if (loginBlocked(req)) return res.send(S.loginPage(site, TOO_MANY), 429);
  const passwordOk = await auth.verifyPasswordAsync(req.body.password, site.adminPasswordHash);
  const ok = req.body.username === site.adminUsername && passwordOk;
  if (!ok) { loginFail(req); return res.send(S.loginPage(site, 'Неверный логин или пароль'), 401); }
  loginOk(req);
  req.session.siteAdmin = site.id;
  req.session.siteAdminAuth = authStamp('site', site.adminUsername, site.adminPasswordHash);
  res.redirect('/admin');
});
app.post('/admin/logout', (req, res) => { req.session = null; res.redirect('/admin/login'); });

app.get('/admin', (req, res) => { const site = guardSite(req, res); if (!site) return; res.send(S.dashboard(db, site)); });

// Товары и цены сайта
app.get('/admin/catalog', (req, res) => { const site = guardSite(req, res); if (!site) return; res.send(S.catalogPage(db, site, req.query.flash)); });
app.post('/admin/catalog', (req, res) => {
  const site = guardSite(req, res); if (!site) return;
  const overrides = {};
  // Нечисловую цену раньше отбрасывало молча уже хранилище: администратор писал
  // «99 990» с пробелом, получал «Цены и видимость сохранены» — и товар уходил
  // на базовую цену, а прежняя ручная цена пропадала. Считаем это ошибкой формы.
  const badPrices = [];
  for (const p of db.getProducts()) {
    const enabled = req.body['enabled_' + p.id] !== undefined;
    const priceRaw = req.body['price_' + p.id];
    const entry = {};
    if (!enabled) entry.enabled = false;
    if (priceRaw !== undefined && String(priceRaw).trim() !== '') {
      const price = Number(String(priceRaw).trim());
      if (!Number.isFinite(price) || price <= 0 || price > PRICE_MAX) badPrices.push(p.id);
      else entry.price = price;
    }
    if (Object.keys(entry).length) overrides[p.id] = entry;
  }
  if (badPrices.length) {
    const names = db.getProducts().filter(p => badPrices.includes(p.id)).map(p => p.name).slice(0, 5).join(', ');
    return res.send(S.catalogPage(db, site,
      `Не сохранено: цена должна быть числом больше нуля (${names}${badPrices.length > 5 ? ' и ещё ' + (badPrices.length - 5) : ''})`,
      { flashType: 'err', draft: req.body, badPrices }), 400);
  }
  db.setSiteOverrides(site.id, overrides);
  res.redirect('/admin/catalog?flash=' + encodeURIComponent('Цены и видимость сохранены'));
});

// Видимость отзывов на сайте
app.get('/admin/reviews', (req, res) => { const site = guardSite(req, res); if (!site) return; res.send(S.reviewsPage(db, site, req.query.flash, req.query.page)); });
app.post('/admin/reviews', (req, res) => {
  const site = guardSite(req, res); if (!site) return;
  // Форма показывает одну страницу отзывов, поэтому и применяется к ней одной:
  // видимость меняется только у пришедших id. Раньше сохранение считало скрытым
  // всё, у чего нет галочки, — со страницами это спрятало бы весь остальной список.
  const pageIds = String(req.body.pageIds || '').split(',').map(s => s.trim()).filter(Boolean);
  const hidden = new Set(site.hiddenReviews || []);
  for (const id of pageIds) {
    if (req.body['show_' + id] === undefined) hidden.add(id); else hidden.delete(id);
  }
  db.setSiteHiddenReviews(site.id, [...hidden]);
  const page = Math.max(1, Math.floor(Number(req.body.page)) || 1);
  res.redirect('/admin/reviews?page=' + page + '&flash=' + encodeURIComponent('Видимость отзывов сохранена'));
});

// Заказы сайта
app.get('/admin/orders', (req, res) => { const site = guardSite(req, res); if (!site) return; res.send(S.ordersList(db, site, req.query.flash, req.query.page)); });
app.get('/admin/analytics', (req, res) => { const site = guardSite(req, res); if (!site) return; res.send(S.analyticsPage(db, site, metrics.snapshot({ siteId: site.id, days: req.query.days }))); });
app.post('/admin/orders/:id/status', (req, res) => {
  const site = guardSite(req, res); if (!site) return;
  const o = db.getOrders().find(x => x.id === req.params.id);
  if (o && o.siteId === site.id) db.setOrderStatus(req.params.id, req.body.status);
  res.redirect('/admin/orders' + pageQuery(req.body.page));
});
app.post('/admin/orders/:id/delete', (req, res) => {
  const site = guardSite(req, res); if (!site) return;
  const o = db.getOrders().find(x => x.id === req.params.id);
  if (o && o.siteId === site.id) db.deleteOrder(req.params.id);
  res.redirect('/admin/orders' + pageQuery(req.body.page));
});

// Настройки сайта
app.get('/admin/settings', (req, res) => { const site = guardSite(req, res); if (!site) return; res.send(S.settingsPage(db, site, req.query.flash)); });
app.post('/admin/settings', async (req, res) => {
  const site = guardSite(req, res); if (!site) return;
  const error = siteError(req.body, site) || passwordError(req.body.adminPassword, false);
  if (error) return res.send(S.settingsPage(db, site, error, 'err'), 400);
  const logo = await resolveLogo(req, site);
  db.updateSite(site.id, Object.assign(siteFields(req.body, site), { logoImage: logo.value }));
  if (logo.obsolete) db.deleteUploadIfUnused(logo.obsolete);
  res.redirect('/admin/settings?flash=' + encodeURIComponent('Настройки сохранены'));
});

/* =========================== 404 =========================== */
app.notFound = (req, res) => {
  const site = siteOf(req);
  trackPage(req, res, site, '/404', { is404: true, requestedPath: req.url });
  res.send(R.notFoundPage(T.siteSettings(site), {
    origin: originOf(req), categories: T.siteCategories(site)
  }), 404);
};

const httpServer = app.listen(PORT, HOST, () => {
  const weak = [];
  const globalSettings = settings();
  if (auth.verifyPassword('owner', globalSettings.ownerPasswordHash)) weak.push('/owner (owner / owner)');
  if (auth.verifyPassword('admin', globalSettings.adminPasswordHash)) weak.push('/admin базового магазина (admin / admin)');
  for (const site of db.getSites()) {
    if (auth.verifyPassword('admin', site.adminPasswordHash)) weak.push(`/admin магазина «${site.storeName}» (admin / admin)`);
  }
  console.log(`\n  Мультимагазин запущен на порту ${PORT}: http://localhost:${PORT}`);
  console.log(`  Витрина:        http://localhost:${PORT}   (демо-домены см. ?site=…)`);
  console.log(`  Админка сайта:  http://localhost:${PORT}/admin    (по домену)`);
  console.log(`  Панель владельца: http://localhost:${PORT}/owner`);
  if (weak.length) {
    console.warn(`\n  ВНИМАНИЕ: обнаружены демонстрационные пароли:\n  - ${weak.join('\n  - ')}`);
    console.warn('  Смените их до публикации сайта или задайте OWNER_PASSWORD/ADMIN_PASSWORD при первом запуске.');
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
