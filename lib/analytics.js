'use strict';

// Лёгкая first-party метрика. События считаются в памяти и записываются на диск
// одной пачкой, поэтому каждый heartbeat не создаёт отдельную операцию записи.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const net = require('net');
// Живые обновления панели. Данные метрики лежат в памяти и на диск уходят раз в
// полминуты, поэтому по файлу их изменение не отследить — модуль сообщает о нём
// сам (см. сеттер `dirty` ниже).
const LIVE = require('./live');
// Город по IP — своей базой, без чужого API и без лимитов (см. шапку модуля).
const GEOIP = require('./geoip');
// Названия стран — из той же таблицы кодов, что и флаги в панелях: вторая такая
// же разошлась бы с первой, и одна страна называлась бы в отчёте двумя именами.
const CI = require('./client-icons');

const COOKIE_NAME = 'am_analytics';
const OPT_OUT_COOKIE = 'am_analytics_off';
const POLICY_VERSION = '2026-07-27';
const ONLINE_MS = 2 * 60 * 1000;
const SESSION_MS = 30 * 60 * 1000;
const RETENTION_DAYS = 365;
// Сколько ПОЛНЫХ недель показывает годовой отчёт. Пятьдесят две, а не 53: год
// на недели нацело не делится, и лишний огрызок стал бы обрывом на графике.
const WEEKS_IN_YEAR = 52;
const GEO_TTL = 30 * 24 * 60 * 60 * 1000;
const MAX_VISITORS = 10000;
const CLEANUP_MS = 10 * 60 * 1000;   // как часто чистить данные по сроку хранения
// Насколько «состариться» вправе отчёт за неделю, месяц и год (см. cachedSnapshot).
const SNAPSHOT_TTL = 10 * 1000;
// Последние просмотры страниц каждого посетителя — из них собирается его
// хронология в карточке. Больше держать незачем: файл пишется целиком, и каждая
// запись здесь умножается на 10 000 карточек.
const MAX_HITS = 50;
/* Сколько посетителей показывает страница «Кто заходил» за один раз. Хранится
 * год и до MAX_VISITORS карточек — это про ДАННЫЕ; здесь речь только о том,
 * сколько строк уезжает в разметку: тысяча строк с техникой и значками весит
 * мегабайты и держит поток, а дальше первой полусотни всё равно не смотрят.
 * Кнопка «Показать ещё» поднимает потолок на столько же. Число одно на модель,
 * маршрут и подпись кнопки — тремя копиями они разъехались бы молча. */
const VISITORS_PER_PAGE = 50;

function clean(value, max) {
  return String(value == null ? '' : value).replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, max || 200);
}

function cookieValue(header, name) {
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i < 0 || part.slice(0, i).trim() !== name) continue;
    try { return decodeURIComponent(part.slice(i + 1).trim()); } catch (e) { return ''; }
  }
  return '';
}

function normalizeIp(value) {
  let ip = clean(value, 80);
  if (ip.startsWith('::ffff:')) ip = ip.slice(7);
  const zone = ip.indexOf('%');
  if (zone >= 0) ip = ip.slice(0, zone);
  return net.isIP(ip) ? ip : '';
}

function isPrivateIp(value) {
  const ip = normalizeIp(value);
  if (!ip) return true;
  if (net.isIPv4(ip)) {
    const p = ip.split('.').map(Number);
    return p[0] === 10 || p[0] === 127 || p[0] === 0 ||
      (p[0] === 169 && p[1] === 254) || (p[0] === 192 && p[1] === 168) ||
      (p[0] === 172 && p[1] >= 16 && p[1] <= 31) || p[0] >= 224;
  }
  const low = ip.toLowerCase();
  return low === '::1' || low === '::' || low.startsWith('fc') || low.startsWith('fd') || low.startsWith('fe8') || low.startsWith('fe9') || low.startsWith('fea') || low.startsWith('feb');
}

function deviceFromUa(raw) {
  const ua = clean(raw, 500);
  const botMatch = ua.match(/(googlebot|yandex(?:bot|images)|bingbot|bingpreview|baiduspider|duckduckbot|petalbot|semrushbot|ahrefsbot|mj12bot|dotbot|facebookexternalhit|facebot|twitterbot|linkedinbot|telegrambot|crawler|spider|slurp|bot\b|headlesschrome|lighthouse|uptimerobot|statuscake|pingdom|curl\/|wget\/|python-(?:requests|urllib)|go-http-client|libwww-perl|zgrab|masscan|nmap|nikto|sqlmap)/i);
  const isBot = !!botMatch;
  let device = 'Компьютер';
  if (isBot) device = 'Робот';
  else if (/ipad|tablet|kindle|silk/i.test(ua) || (/android/i.test(ua) && !/mobile/i.test(ua))) device = 'Планшет';
  else if (/iphone|ipod|android.*mobile|windows phone|mobile/i.test(ua)) device = 'Телефон';

  let model = '';
  if (/iphone/i.test(ua)) model = 'iPhone';
  else if (/ipad/i.test(ua)) model = 'iPad';
  else {
    const android = ua.match(/Android[^;)]*;\s*([^;)]+?)(?:\s+Build\/|[;)])/i);
    if (android) model = clean(android[1].replace(/^wv$/i, ''), 70);
  }

  let os = 'Другая ОС';
  let m;
  if ((m = ua.match(/(?:CPU (?:iPhone )?OS|iPhone OS)\s([\d_]+)/i))) os = 'iOS ' + m[1].replace(/_/g, '.');
  else if ((m = ua.match(/Android\s([\d.]+)/i))) os = 'Android ' + m[1];
  else if ((m = ua.match(/Windows NT\s([\d.]+)/i))) {
    const names = { '10.0': 'Windows 10/11', '6.3': 'Windows 8.1', '6.1': 'Windows 7' };
    os = names[m[1]] || 'Windows ' + m[1];
  } else if ((m = ua.match(/Mac OS X\s([\d_]+)/i))) os = 'macOS ' + m[1].replace(/_/g, '.');
  else if (/Linux/i.test(ua)) os = 'Linux';

  let browser = 'Другой браузер';
  if (/TelegramBot/i.test(ua)) browser = 'Telegram';
  else if ((m = ua.match(/YaBrowser\/([\d.]+)/i))) browser = 'Яндекс Браузер ' + m[1].split('.')[0];
  else if ((m = ua.match(/Edg(?:A|iOS)?\/([\d.]+)/i))) browser = 'Edge ' + m[1].split('.')[0];
  else if ((m = ua.match(/OPR\/([\d.]+)/i))) browser = 'Opera ' + m[1].split('.')[0];
  else if ((m = ua.match(/Firefox\/([\d.]+)/i))) browser = 'Firefox ' + m[1].split('.')[0];
  else if ((m = ua.match(/(?:Chrome|CriOS)\/([\d.]+)/i))) browser = 'Chrome ' + m[1].split('.')[0];
  else if (/Safari\//i.test(ua) && (m = ua.match(/Version\/([\d.]+)/i))) browser = 'Safari ' + m[1].split('.')[0];
  return { device, model, os, browser, isBot, botName: isBot ? clean(botMatch[1], 60) : '', userAgent: ua };
}

function safePath(value) {
  const p = clean(value, 300);
  if (!p.startsWith('/') || p.startsWith('//')) return '/';
  try { return decodeURIComponent(p.split('?')[0]).slice(0, 220) || '/'; } catch (e) { return '/'; }
}

function sourceFromReferrer(value, ownHost) {
  const raw = clean(value, 600);
  if (!raw) return 'Прямой заход';
  try {
    const host = new URL(raw).hostname.replace(/^www\./, '').toLowerCase();
    let own = String(ownHost || '').replace(/^www\./, '').toLowerCase();
    try { own = new URL('http://' + own).hostname.replace(/^www\./, '').toLowerCase(); } catch (e) {}
    if (!host || host === own) return 'Внутренний переход';
    return host.slice(0, 120);
  } catch (e) { return 'Прямой заход'; }
}

function dayKey(ms) {
  // Отчёты магазина группируются по московскому времени.
  return new Date(Number(ms || Date.now()) + 3 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

// version 3 — один магазин вместо мультидоменности: у карточек посетителей нет
// siteId, а суточные сводки лежат под датой, а не под «домен|дата».
function emptyData() { return { version: 3, visitors: [], daily: {}, botDaily: {}, geoCache: {}, geoUsage: { date: '', count: 0 } }; }

// Сводки прежних версий были разложены по доменам. Домен теперь один, поэтому
// строки за одну дату складываются в одну: иначе метрика за прошлые дни просто
// исчезла бы из отчёта, хотя данные на диске целы.
function mergeDaily(rows, empty, sum, unite) {
  const out = {};
  for (const row of Object.values(rows || {})) {
    if (!row || !row.date) continue;
    const target = out[row.date] || (out[row.date] = Object.assign(empty(), { date: row.date }));
    for (const key of sum) target[key] = (Number(target[key]) || 0) + (Number(row[key]) || 0);
    for (const key of unite) {
      if (Array.isArray(row[key])) {
        const seen = new Set(target[key]);
        for (const id of row[key]) if (!seen.has(id)) { seen.add(id); target[key].push(id); }
      } else {
        for (const [k, n] of Object.entries(row[key] || {})) addCount(target[key], k, n);
      }
    }
  }
  return out;
}
function emptyDay() {
  return {
    date: '', visitors: [], orderVisitors: [], visits: 0, pageViews: 0, orders: 0,
    activeSeconds: 0, pages: {}, sources: {}, devices: {}, browsers: {}, systems: {}, campaigns: {},
    // Просмотры по часам московских суток — 24 числа на день. Поле осталось от
    // прежнего графика просмотров: в отчёте оно больше не показывается, но и
    // стирать историю ради снятого блока незачем.
    hours: {},
    /* Посетители по часам — то, что рисует график «Сегодня» теперь.
     *
     * Считается по ПЕРВОМУ за сутки просмотру каждого посетителя, поэтому сумма
     * за день в точности равна числу уникальных посетителей: один человек стоит
     * в одном часе и ни в каком больше. Своего набора id на каждый час завести
     * нельзя — их было бы 24 копии дневного списка на каждый день года. */
    hourVisitors: {}
  };
}
// Час московских суток, 0–23. Тот же сдвиг, что у dayKey: отчёты магазина
// считаются по Москве, и час обязан лежать внутри своих суток.
function hourKey(ms) { return new Date(Number(ms || Date.now()) + 3 * 60 * 60 * 1000).getUTCHours(); }
// Семейство браузера или системы: «Chrome 140» → «Chrome», «Windows 10/11» →
// «Windows». Отбор в списке посетителей идёт по семейству — выбирать «Safari 26»
// и «Safari 25» по отдельности бессмысленно, а версий за год набегают десятки.
function familyOf(value) {
  const s = String(value || '').trim();
  const m = s.match(/^(.*?)\s+[\d/.]+$/);
  return (m ? m[1] : s).trim();
}
function emptyBotDay() { return { date: '', hits: 0, notFound: 0, agents: {}, paths: {} }; }

/* Страна называется ОДНИМ именем на всю панель — по коду из общей таблицы
 * (`CI.countryName`, там же, где флаги). Кэш геолокации собирался двумя
 * источниками, и они называют её по-разному: своя база даёт «Россия», прежний
 * внешний сервис писал «Российская Федерация». В списке городов это давало два
 * ряда «Москва» подряд с разными числами — на боевых данных 200 и 156.
 */
function countryOf(v) { return CI.countryName(v && v.countryCode) || (v && v.country) || ''; }

/* Подпись места для списка «Города»: город и страна, БЕЗ региона.
 *
 * Регион дробит один и тот же город на несколько строк — у карточек, записанных
 * разными источниками, он то есть, то нет («Екатеринбург, Свердловская область,
 * Россия» против «Екатеринбург, Россия»), — а список называется «Города», и
 * область в нём не спрашивают. В строке самого посетителя регион остаётся: там
 * он про одного человека и ничего не дробит.
 */
function placeKey(v) {
  const parts = [v && v.city, countryOf(v)].filter(Boolean).filter((x, i, a) => a.indexOf(x) === i);
  return clean(parts.join(', '), 120) || 'Не определено';
}

/* Код страны посетителя — ключ и карты мира, и меню местоположения.
 *
 * Берётся той же функцией, что и флаг рядом с городом (`CI.countryCode`): она
 * знает и явное поле, и русское название у карточек, записанных до появления
 * кода. Кода нет вовсе — пустая строка: на карте такого посетителя не
 * поставить, но в рейтинге он честно стоит строкой «Страна не определена».
 */
function countryCodeOf(v) { return CI.countryCode(v && v.country, v && v.countryCode); }

/* Регион посетителя ВНУТРИ выбранной страны — для хороплет-карты.
 *
 * Раньше здесь была только Россия: карта была российской, и вопрос «а кто в
 * других странах» не задавался вовсе. Теперь страну выбирают, поэтому регион
 * берётся у любой, а российская особенность осталась одна — Москва и Петербург
 * это самостоятельные субъекты, и если источник отдал город, но забыл область,
 * карта всё равно ставит посетителя на место.
 */
function regionIn(v, code) {
  if (!code || countryCodeOf(v) !== code) return '';
  const region = clean(v && v.region, 120);
  if (region) return region;
  if (code !== 'RU') return '';
  const city = clean(v && v.city, 100);
  return city === 'Москва' || city === 'Санкт-Петербург' ? city : '';
}

function clientDetails(raw) {
  raw = raw && typeof raw === 'object' ? raw : {};
  const cpu = Number(raw.cpuCores);
  const memory = Number(raw.deviceMemory);
  return {
    screen: clean(raw.screen, 30), viewport: clean(raw.viewport, 30),
    language: clean(raw.language, 30), timezone: clean(raw.timezone, 80), platform: clean(raw.platform, 80),
    cpuCores: Number.isFinite(cpu) && cpu > 0 && cpu <= 256 ? Math.round(cpu) : null,
    deviceMemory: Number.isFinite(memory) && memory > 0 && memory <= 1024 ? memory : null,
    connection: clean(raw.connection, 30), utmSource: clean(raw.utmSource, 100),
    utmMedium: clean(raw.utmMedium, 100), utmCampaign: clean(raw.utmCampaign, 160)
  };
}

function addCount(object, key, value) {
  const current = Object.prototype.hasOwnProperty.call(object, key) ? object[key] : 0;
  Object.defineProperty(object, key, {
    value: (Number(current) || 0) + (Number(value) || 0), enumerable: true, configurable: true, writable: true
  });
}

function bumpLimited(object, key, maxKeys) {
  let safeKey = clean(key, 220) || 'Не определено';
  // `in` видит у обычного объекта constructor/__proto__ из прототипа. Такие UTM
  // или пути не должны терять счётчик и тем более обращаться к прототипу.
  if (!Object.prototype.hasOwnProperty.call(object, safeKey) && Object.keys(object).length >= maxKeys) safeKey = 'Другие';
  addCount(object, safeKey, 1);
}

class Analytics {
  constructor(options) {
    options = options || {};
    this.file = path.join(options.dataDir, 'analytics.json');
    this.dataDir = options.dataDir;
    this.fetcher = options.fetcher || globalThis.fetch;
    this.geoEnabled = options.geoEnabled !== false;
    /* Внешний геосервис — ЗАПАСНОЙ путь, и по умолчанию он выключен.
     *
     * Он и был причиной поломки: у бесплатного тарифа тысяча запросов в сутки,
     * а посетителей стало больше — с середины дня все новые визиты получали
     * «Город не определён», молча. И каждый адрес посетителя при этом уходил
     * третьей стороне. Основной источник теперь свой — `lib/geoip.js`; включить
     * запасной можно `GEOIP_REMOTE=1`, но тогда IP снова уезжают наружу.
     */
    this.remoteGeo = options.remoteGeo === true;
    this.data = this.load();
    this.dirty = false;
    this.geoInflight = new Map();
    // Индекс «id → карточка». Без него каждый просмотр страницы, каждый heartbeat
    // и каждая заявка искали посетителя перебором всего массива: при потолке в
    // 10 000 карточек это ~0,04 мс на пустом месте в каждом запросе.
    this.byId = new Map();
    // Готовые отчёты за неделю, месяц и год — по одному на диапазон (см. `cachedSnapshot`).
    this.snapshotCache = new Map();
    this.reindex();
    this.lastCleanup = 0;
    this.backfillGeo();
    // `maintain()`, а не `flush()`: уборка по сроку хранения обязана идти и
    // тогда, когда писать нечего (см. её комментарий).
    const timer = setInterval(() => this.maintain(), Number(options.flushMs) || 30000);
    if (timer.unref) timer.unref();
  }

  /* Города у карточек, записанных без них, — при каждом старте процесса.
   *
   * Пока город определялся внешним сервисом, его дневной лимит выбирался к обеду,
   * и все, кто заходил после, оставались с «Город не определён» НАВСЕГДА: геолокация
   * спрашивается на просмотре страницы, а не вернувшийся посетитель второго
   * просмотра не делает. На боевых данных так осталось 43% карточек — и это
   * ровно то, что видно в панели. Своя база отвечает без лимитов, значит и
   * чинить старые карточки можно разом.
   *
   * Идёт это ЗДЕСЬ, а не отдельным скриптом, по одной причине: `analytics.json`
   * пишется работающим процессом из памяти целиком, и запись со стороны он
   * затёр бы своей при следующем `flush()`. Правка при старте от этой гонки
   * свободна по построению.
   *
   * Прогон идемпотентен и с каждым разом дешевеет: у кого город нашёлся, тот
   * больше не проверяется. Остаются дыры базы и IPv6 (его в базе нет вовсе) —
   * их и правда не определить, и выдумывать город мы не будем.
   */
  backfillGeo() {
    if (!this.geoEnabled || !GEOIP.info(this.dataDir)) return 0;
    let fixed = 0;
    for (const v of this.data.visitors) {
      if (v.city || v.country || !v.ip) continue;
      const geo = GEOIP.lookup(this.dataDir, v.ip);
      if (!geo || (!geo.city && !geo.country)) continue;
      Object.assign(v, geo);
      // Тот же кэш, что у живых запросов: повторный визит не полезет в файл базы.
      this.data.geoCache[normalizeIp(v.ip)] = Object.assign({ cachedAt: Date.now() }, geo);
      fixed++;
    }
    if (fixed) this.dirty = true;
    return fixed;
  }

  /* `dirty` — единственная в модуле отметка «в метрике что-то изменилось»: её
   * ставят все записывающие методы, от просмотра страницы до отказа от метрики.
   * Живые обновления панели вешаются на неё же, а не на четыре вызова подряд:
   * забыть один из них можно молча, и «Метрика» перестала бы обновляться сама
   * ровно в том месте, про которое забыли.
   *
   * Пока панель никто не смотрит, `bump()` выходит первой строкой, поэтому на
   * каждом heartbeat это стоит ровно ничего. */
  set dirty(on) { this._dirty = !!on; if (on) LIVE.bump('analytics'); }
  get dirty() { return this._dirty; }

  // Пересобрать индекс после любой замены массива visitors целиком.
  reindex() {
    this.byId.clear();
    for (const v of this.data.visitors) this.byId.set(v.id, v);
  }

  load() {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (!parsed || !Array.isArray(parsed.visitors)) return emptyData();
      // Первая версия смешивала посетителей со сканерами. Начинаем чистые
      // счётчики v2, сохраняя только безопасный кэш геолокации.
      if (Number(parsed.version) < 2) {
        const fresh = emptyData();
        fresh.geoCache = parsed.geoCache && typeof parsed.geoCache === 'object' ? parsed.geoCache : {};
        fresh.geoUsage = parsed.geoUsage && typeof parsed.geoUsage === 'object' ? parsed.geoUsage : { date: '', count: 0 };
        fresh.migratedAt = Date.now();
        return fresh;
      }
      parsed.daily = parsed.daily && typeof parsed.daily === 'object' ? parsed.daily : {};
      parsed.botDaily = parsed.botDaily && typeof parsed.botDaily === 'object' ? parsed.botDaily : {};
      parsed.geoCache = parsed.geoCache && typeof parsed.geoCache === 'object' ? parsed.geoCache : {};
      parsed.geoUsage = parsed.geoUsage && typeof parsed.geoUsage === 'object' ? parsed.geoUsage : { date: '', count: 0 };
      if (Number(parsed.version) < 3) {
        parsed.daily = mergeDaily(parsed.daily, emptyDay, ['visits', 'pageViews', 'orders', 'activeSeconds'],
          ['visitors', 'orderVisitors', 'pages', 'sources', 'devices', 'browsers', 'systems', 'campaigns']);
        parsed.botDaily = mergeDaily(parsed.botDaily, emptyBotDay, ['hits', 'notFound'], ['agents', 'paths']);
        for (const v of parsed.visitors) delete v.siteId;
        parsed.version = 3;
      }
      return parsed;
    } catch (e) {
      if (e && e.code !== 'ENOENT') console.error('Не удалось прочитать analytics.json:', e.message);
      return emptyData();
    }
  }

  visitorId(req) {
    const id = cookieValue(req && req.headers && req.headers.cookie, COOKIE_NAME);
    return /^[a-f0-9]{32}$/.test(id) ? id : '';
  }

  trackingDisabled(req) { return cookieValue(req && req.headers && req.headers.cookie, OPT_OUT_COOKIE) === '1'; }

  newVisitorId() { return crypto.randomBytes(16).toString('hex'); }

  cookieHeader(id, secure) {
    return `${COOKIE_NAME}=${id}; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000${secure ? '; Secure' : ''}`;
  }

  clearCookieHeader(secure) {
    return `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure ? '; Secure' : ''}`;
  }

  optOutCookieHeader(secure) {
    return `${OPT_OUT_COOKIE}=1; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000${secure ? '; Secure' : ''}`;
  }

  clearOptOutCookieHeader(secure) {
    return `${OPT_OUT_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure ? '; Secure' : ''}`;
  }

  context(req, ip, trustedGeoHeaders) {
    const ua = deviceFromUa(req && req.headers && req.headers['user-agent']);
    const headers = (req && req.headers) || {};
    const ctx = {
      ip: normalizeIp(ip), device: ua.device, model: ua.model, os: ua.os, browser: ua.browser,
      isBot: ua.isBot, botName: ua.botName, userAgent: ua.userAgent,
      source: sourceFromReferrer(headers.referer, headers.host)
    };
    if (trustedGeoHeaders) {
      const cc = clean(headers['cf-ipcountry'], 80);
      ctx.geo = {
        city: clean(headers['cf-ipcity'], 100), region: clean(headers['cf-region'], 120),
        // CF-IPCountry — это как раз двухбуквенный код, флаг рисуется по нему.
        country: cc, countryCode: /^[A-Za-z]{2}$/.test(cc) ? cc.toUpperCase() : '', isp: ''
      };
      if (!ctx.geo.city && !ctx.geo.region && !ctx.geo.country) delete ctx.geo;
    }
    return ctx;
  }

  findVisitor(id) { return this.byId.get(id) || null; }

  // Все карточки с этим адресом, свежие первыми. За одним IP сидит целая
  // квартира или офис, поэтому это список, а не одна карточка: в заказах до
  // появления `visitorId` только адрес и есть, по нему и ищем.
  findByIp(rawIp) {
    const ip = normalizeIp(rawIp);
    if (!ip) return [];
    return this.data.visitors
      .filter(v => v.ip === ip)
      .sort((a, b) => Number(b.lastSeen || 0) - Number(a.lastSeen || 0));
  }

  ensureVisitor(id, ctx, now) {
    let v = this.findVisitor(id);
    if (!v) {
      v = {
        id, firstSeen: now, lastSeen: now, lastSessionAt: 0,
        visits: 0, pageViews: 0, pathCounts: {}, hits: [], ip: ctx.ip || '', city: '', region: '', country: '', countryCode: '', isp: '',
        device: ctx.device, model: ctx.model, os: ctx.os, browser: ctx.browser,
        source: ctx.source === 'Внутренний переход' ? 'Прямой заход' : ctx.source,
        orderCount: 0, lastOrderAt: null, policyVersion: POLICY_VERSION, startedAt: now, activeSeconds: 0, clientConfirmed: false
      };
      this.data.visitors.push(v);
      this.byId.set(id, v);
    }
    v.lastSeen = now;
    if (ctx.ip) v.ip = ctx.ip;
    for (const key of ['device', 'model', 'os', 'browser', 'userAgent', 'screen', 'viewport', 'language', 'timezone', 'platform', 'connection', 'utmSource', 'utmMedium', 'utmCampaign']) if (ctx[key]) v[key] = ctx[key];
    for (const key of ['cpuCores', 'deviceMemory']) if (ctx[key] != null) v[key] = ctx[key];
    if (ctx.geo) Object.assign(v, ctx.geo);
    return v;
  }

  daily(now) {
    const date = dayKey(now);
    if (!this.data.daily[date]) this.data.daily[date] = Object.assign(emptyDay(), { date });
    const d = this.data.daily[date];
    d.visitors = Array.isArray(d.visitors) ? d.visitors : [];
    d.orderVisitors = Array.isArray(d.orderVisitors) ? d.orderVisitors : [];
    for (const name of ['pages', 'sources', 'devices', 'browsers', 'systems', 'campaigns', 'hours', 'hourVisitors']) if (!d[name] || typeof d[name] !== 'object') d[name] = {};
    d.activeSeconds = Number(d.activeSeconds) || 0;
    return d;
  }

  botDaily(now) {
    const date = dayKey(now);
    if (!this.data.botDaily[date]) this.data.botDaily[date] = Object.assign(emptyBotDay(), { date });
    return this.data.botDaily[date];
  }

  recordTechnical(input) {
    const now = Date.now();
    const d = this.botDaily(now);
    const ctx = input.context || {};
    const requested = safePath(input.requestedPath || input.path);
    d.hits++;
    if (input.is404) d.notFound++;
    bumpLimited(d.agents, ctx.botName || (input.is404 ? 'Неизвестный сканер / 404' : 'Автоматический запрос'), 80);
    bumpLimited(d.paths, requested, 300);
    this.dirty = true;
    return null;
  }

  expirePending(now) {
    const keep = [];
    for (const v of this.data.visitors) {
      if (!v.clientConfirmed && now - Number(v.lastSeen || 0) > ONLINE_MS) {
        this.recordTechnical({
          path: v.pendingPage && v.pendingPage.path,
          requestedPath: v.pendingPage && v.pendingPage.path,
          context: { botName: 'Неподтверждённый автоматический запрос' }
        });
      } else keep.push(v);
    }
    if (keep.length !== this.data.visitors.length) {
      this.data.visitors = keep;
      this.reindex();
    }
  }

  recordPageView(input) {
    const now = Date.now();
    if (!/^[a-f0-9]{32}$/.test(String(input.id || ''))) return null;
    const ctx = input.context || {};
    if (ctx.isBot || input.is404) return this.recordTechnical(input);
    if (input.referrer) ctx.source = sourceFromReferrer(input.referrer, input.host);
    const v = this.ensureVisitor(input.id, ctx, now);
    if (input.provisional) {
      v.pendingPage = { path: safePath(input.path), at: now };
      this.dirty = true;
      return v;
    }
    v.clientConfirmed = true;
    const d = this.daily(now);
    const newSession = !v.lastSessionAt || now - v.lastSessionAt > SESSION_MS;
    if (newSession) { v.visits++; v.lastSessionAt = now; d.visits++; }
    const pending = v.pendingPage && now - Number(v.pendingPage.at || 0) < 60000 ? v.pendingPage : null;
    const p = pending ? pending.path : safePath(input.path);
    delete v.pendingPage;
    v.pageViews++; v.lastPage = p; if (!v.entryPage) v.entryPage = p;
    bumpLimited(v.pathCounts, p, 50);
    this.addHit(v, p, now, newSession);
    d.pageViews++; bumpLimited(d.pages, p, 500);
    addCount(d.hours, String(hourKey(now)), 1);
    /* Час записывается ПЕРВОМУ за сутки просмотру посетителя — вместе с самим
     * попаданием в дневной список. Так сумма по часам сходится с числом
     * уникальных посетителей за день, а второй раз тот же человек в график уже
     * не попадает, сколько бы страниц он ни открыл. */
    if (!d.visitors.includes(v.id) && d.visitors.length < MAX_VISITORS) {
      d.visitors.push(v.id);
      addCount(d.hourVisitors, String(hourKey(now)), 1);
    }
    const src = v.source || 'Прямой заход'; bumpLimited(d.sources, src, 200);
    bumpLimited(d.devices, v.device || 'Не определено', 20);
    bumpLimited(d.browsers, v.browser || 'Не определено', 100);
    bumpLimited(d.systems, v.os || 'Не определено', 100);
    if (v.utmCampaign) bumpLimited(d.campaigns, [v.utmSource, v.utmMedium, v.utmCampaign].filter(Boolean).join(' · '), 200);
    this.dirty = true;
    if (ctx.geo || ctx.ip) this.populateGeo(v, ctx).catch(() => {});
    return v;
  }

  // Один просмотр в хронологию посетителя: `p` — страница, `t` — когда, `s` —
  // сколько секунд на ней провели (накапливает heartbeat), `v` — этим просмотром
  // начался новый визит. Ключи короткие намеренно: строка повторяется до 50 раз
  // на каждую из 10 000 карточек в одном файле.
  addHit(visitor, path, now, newSession) {
    if (!Array.isArray(visitor.hits)) visitor.hits = [];
    const hit = { p: path, t: now, s: 0 };
    if (newSession) hit.v = 1;
    visitor.hits.push(hit);
    if (visitor.hits.length > MAX_HITS) visitor.hits = visitor.hits.slice(-MAX_HITS);
  }

  /* «Человек здесь» — без начисления времени на странице.
   *
   * Обычный heartbeat идёт только у ВИДИМОЙ вкладки: свёрнутая страница время не
   * копит, и это правильно. Но присутствие бывает видно и с другой стороны —
   * открытый живой канал чата держится, пока страница витрины открыта, пусть и в
   * фоне. Без этой отметки панель говорила про одного и того же человека «в
   * сети» в чате и «был 5 минут назад» в его карточке метрики.
   *
   * Двигаем только `lastSeen`: секунды на странице считает heartbeat, и
   * начислять их за фоновую вкладку значило бы завышать время визита у всех, кто
   * просто не закрыл сайт.
   */
  seen(id) {
    const v = this.findVisitor(id);
    if (!v || !v.clientConfirmed) return false;
    v.lastSeen = Date.now();
    this.dirty = true;
    return true;
  }

  heartbeat(input) {
    const v = this.findVisitor(input.id);
    if (!v || !v.clientConfirmed) return false;
    const now = Date.now();
    const elapsed = now - Number(v.lastSeen || now);
    if (elapsed >= 5000 && elapsed <= 90000) {
      const seconds = Math.round(elapsed / 1000);
      v.activeSeconds = (Number(v.activeSeconds) || 0) + seconds;
      this.daily(now).activeSeconds += seconds;
      // Те же секунды — последней странице хронологии. Heartbeat приходит с той
      // страницы, что открыта сейчас, а она и есть последняя записанная.
      const last = Array.isArray(v.hits) && v.hits.length ? v.hits[v.hits.length - 1] : null;
      if (last) last.s = (Number(last.s) || 0) + seconds;
    }
    v.lastSeen = now;
    v.lastPage = safePath(input.path || v.lastPage);
    const ctx = input.context || {};
    const previousCampaign = v.utmCampaign || '';
    for (const key of ['device', 'model', 'os', 'browser', 'userAgent', 'screen', 'viewport', 'language', 'timezone', 'platform', 'connection', 'utmSource', 'utmMedium', 'utmCampaign']) if (ctx[key]) v[key] = ctx[key];
    for (const key of ['cpuCores', 'deviceMemory']) if (ctx[key] != null) v[key] = ctx[key];
    if (ctx.utmCampaign && ctx.utmCampaign !== previousCampaign) bumpLimited(this.daily(now).campaigns, [ctx.utmSource, ctx.utmMedium, ctx.utmCampaign].filter(Boolean).join(' · '), 200);
    if (ctx.ip) v.ip = ctx.ip;
    this.dirty = true;
    return true;
  }

  markOrder(visitorId, order) {
    const now = Number(order.createdAt) || Date.now();
    const d = this.daily(now);
    d.orders++;
    if (visitorId && !d.orderVisitors.includes(visitorId) && d.orderVisitors.length < MAX_VISITORS) d.orderVisitors.push(visitorId);
    const v = visitorId ? this.findVisitor(visitorId) : null;
    if (v) {
      v.orderCount = (v.orderCount || 0) + 1;
      v.lastOrderAt = now; v.lastOrderId = clean(order.id, 40); v.lastOrderNumber = clean(order.number, 40); v.lastSeen = now;
    }
    this.dirty = true;
    this.flush();
  }

  removeVisitor(id) {
    if (!id) return;
    this.data.visitors = this.data.visitors.filter(v => v.id !== id);
    this.byId.delete(id);
    for (const d of Object.values(this.data.daily)) {
      d.visitors = (d.visitors || []).filter(x => x !== id);
      d.orderVisitors = (d.orderVisitors || []).filter(x => x !== id);
    }
    this.dirty = true;
    this.flush();
  }

  async populateGeo(visitor, ctx) {
    if (ctx.geo && (ctx.geo.city || ctx.geo.country)) {
      Object.assign(visitor, ctx.geo); this.dirty = true; return ctx.geo;
    }
    const geo = await this.geoForIp(ctx.ip || visitor.ip);
    if (geo) { Object.assign(visitor, geo); this.dirty = true; }
    return geo;
  }

  async describeRequest(req, ip, trustedGeoHeaders) {
    const ctx = this.context(req, ip, trustedGeoHeaders);
    let geo = ctx.geo || null;
    if (!geo) geo = await this.geoForIp(ctx.ip);
    return Object.assign(ctx, geo || {});
  }

  async geoForIp(rawIp) {
    const ip = normalizeIp(rawIp);
    if (!ip || isPrivateIp(ip) || !this.geoEnabled) return null;
    const cached = this.data.geoCache[ip];
    if (cached && Date.now() - cached.cachedAt < GEO_TTL) return cached;

    /* Сперва СВОЯ база (`lib/geoip.js`): без лимитов, без сети и без того, чтобы
     * показывать адрес посетителя чужому сервису. Ответ кладём в тот же кэш —
     * он же и защищает файл от лишних чтений на повторных визитах.
     *
     * Базы нет (её не собрали) — идём дальше, к запасному пути: метрика обязана
     * работать и без неё, просто без города. */
    const local = GEOIP.lookup(this.dataDir, ip);
    if (local && (local.city || local.country)) {
      const geo = Object.assign({ cachedAt: Date.now() }, local);
      this.data.geoCache[ip] = geo;
      this.dirty = true;
      return geo;
    }

    if (!this.remoteGeo || typeof this.fetcher !== 'function') return null;
    if (this.geoInflight.has(ip)) return this.geoInflight.get(ip);
    const today = dayKey(Date.now());
    if (this.data.geoUsage.date !== today) this.data.geoUsage = { date: today, count: 0 };
    // У бесплатного API лимит 1000 запросов/сутки; оставляем небольшой запас.
    if (Number(this.data.geoUsage.count) >= 900) return null;
    this.data.geoUsage.count = Number(this.data.geoUsage.count) + 1;
    this.dirty = true;
    const promise = (async () => {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 2200);
      try {
        const url = `https://ipwho.is/${encodeURIComponent(ip)}?fields=success,country,country_code,region,city,connection&lang=ru`;
        const response = await this.fetcher(url, { signal: controller.signal, headers: { Accept: 'application/json' } });
        if (!response || !response.ok) return null;
        const body = await response.json();
        if (!body || body.success === false) return null;
        const geo = {
          city: clean(body.city, 100), region: clean(body.region, 120),
          country: clean(body.country || body.country_code, 100),
          // Название страны приходит по-русски, а флагу нужен код ISO — держим оба.
          countryCode: clean(body.country_code, 4).toUpperCase(),
          isp: clean(body.connection && body.connection.isp, 140), cachedAt: Date.now()
        };
        this.data.geoCache[ip] = geo; this.dirty = true;
        return geo;
      } catch (e) { return null; }
      finally { clearTimeout(timeout); this.geoInflight.delete(ip); }
    })();
    this.geoInflight.set(ip, promise);
    return promise;
  }

  /* Итоги за набор дат: сколько визитов, просмотров и заявок. Считается дважды —
   * за выбранный период и за предыдущий такой же, чтобы карточки сводки могли
   * сказать «на 18% больше, чем в прошлые 7 дней». Одно число без сравнения не
   * отвечает на главный вопрос владельца: стало лучше или хуже. */
  totalsFor(dates) {
    const wanted = new Set(dates);
    const out = { visits: 0, pageViews: 0, orders: 0, activeSeconds: 0, visitors: 0 };
    const unique = new Set();
    for (const d of Object.values(this.data.daily)) {
      if (!wanted.has(d.date)) continue;
      for (const key of ['visits', 'pageViews', 'orders', 'activeSeconds']) out[key] += Number(d[key]) || 0;
      for (const id of d.visitors || []) unique.add(id);
    }
    out.visitors = unique.size;
    return out;
  }

  // Сегодняшняя дата по московским суткам — той же меркой, какой метрика
  // раскладывает дни. Нужна отбору «Кто заходил»: пресеты «сегодня» и «7 дней»
  // обязаны считать границы так же, как их считает `queryVisitors`.
  today() { return dayKey(Date.now()); }

  /* Сколько человек на витрине прямо сейчас. Спрашивают это двое — плитка
   * «Сейчас на сайте» на «Обзоре» и плашка в шапке панели (`lib/live.js` через
   * `server.js`), — и мерка у них обязана быть одна: два разных числа об одном и
   * том же на соседних экранах читались бы как сбой.
   *
   * Считается циклом, а не `filter().length`: плашку спрашивает канал живого
   * обновления раз в секунду, а карточек здесь до `MAX_VISITORS`, и промежуточный
   * массив на каждый такт — мусор на ровном месте.
   */
  onlineCount() {
    const now = Date.now();
    let n = 0;
    for (const v of this.data.visitors) {
      if (v.clientConfirmed && now - Number(v.lastSeen || 0) <= ONLINE_MS) n++;
    }
    return n;
  }

  // Что происходит на витрине прямо сейчас — для «Обзора»: сколько человек на
  // сайте и как идут сегодняшние сутки. Полную сводку там считать незачем.
  pulse() {
    const now = Date.now();
    const today = this.data.daily[dayKey(now)] || null;
    return {
      online: this.onlineCount(),
      visitors: today ? (today.visitors || []).length : 0,
      visits: today ? Number(today.visits) || 0 : 0,
      pageViews: today ? Number(today.pageViews) || 0 : 0,
      orders: today ? Number(today.orders) || 0 : 0
    };
  }

  /* Отбор посетителей для страницы «Кто заходил».
   *
   * Карточки хранятся год (RETENTION_DAYS) и до MAX_VISITORS штук — вся эта
   * история и доступна здесь. Прежний потолок в 250 записей жил только в
   * `snapshot()`: он резал ВЫДАЧУ, а не данные, поэтому «посмотреть, кто заходил
   * в прошлый вторник» было нельзя, хотя на диске всё лежало.
   *
   * `from`/`to` — даты (YYYY-MM-DD) по московским суткам. Кто заходил в эти дни,
   * знает суточная сводка: `daily[date].visitors` — это ровно те, у кого в тот
   * день был подтверждённый просмотр. Считать по `lastSeen` карточки нельзя —
   * он говорит только про последний заход.
   *
   * Фасеты (сколько телефонов, сколько из Safari) считаются по набору ДО отбора
   * по технике: иначе, выбрав «Телефон», рядом стояло бы «Телефон 812» и нули у
   * всех остальных, и вернуться к компьютерам было бы не по чему.
   */
  queryVisitors(options) {
    const o = options || {};
    const now = Date.now();
    const date = value => (/^\d{4}-\d{2}-\d{2}$/.test(String(value || '')) ? String(value) : '');
    const from = date(o.from); const to = date(o.to);
    let base = this.data.visitors.filter(v => v.clientConfirmed);
    if (from || to) {
      const ids = new Set();
      for (const d of Object.values(this.data.daily)) {
        if (from && d.date < from) continue;
        if (to && d.date > to) continue;
        for (const id of d.visitors || []) ids.add(id);
      }
      base = base.filter(v => ids.has(v.id));
    }
    const facets = { devices: {}, browsers: {}, systems: {}, sources: {}, orders: 0 };
    for (const v of base) {
      addCount(facets.devices, v.device || 'Не определено', 1);
      addCount(facets.browsers, familyOf(v.browser) || 'Не определено', 1);
      addCount(facets.systems, familyOf(v.os) || 'Не определено', 1);
      addCount(facets.sources, v.source || 'Прямой заход', 1);
      if (Number(v.orderCount) > 0) facets.orders++;
    }
    const want = (value, actual) => !value || String(value) === String(actual || '');
    const found = base.filter(v => want(o.device, v.device)
      && want(o.browser, familyOf(v.browser))
      && want(o.system, familyOf(v.os))
      && want(o.source, v.source || 'Прямой заход')
      && (!o.ordered || Number(v.orderCount) > 0));
    const SORTS = {
      last: (a, b) => Number(b.lastSeen || 0) - Number(a.lastSeen || 0),
      first: (a, b) => Number(b.firstSeen || 0) - Number(a.firstSeen || 0),
      visits: (a, b) => (Number(b.visits) || 0) - (Number(a.visits) || 0),
      views: (a, b) => (Number(b.pageViews) || 0) - (Number(a.pageViews) || 0),
      time: (a, b) => (Number(b.activeSeconds) || 0) - (Number(a.activeSeconds) || 0),
      orders: (a, b) => (Number(b.orderCount) || 0) - (Number(a.orderCount) || 0) || Number(b.lastSeen || 0) - Number(a.lastSeen || 0)
    };
    const sort = Object.prototype.hasOwnProperty.call(SORTS, String(o.sort || '')) ? String(o.sort) : 'last';
    // Сортировка идёт по копии: сам массив отдаётся ещё и индексу карточек.
    const rows = found.slice().sort(SORTS[sort]);
    const show = Math.max(1, Math.min(Number(o.show) || 50, 2000));
    return {
      generatedAt: now, from, to, sort,
      total: base.length, found: rows.length, shown: Math.min(show, rows.length),
      hasMore: rows.length > show, facets,
      rows: rows.slice(0, show)
    };
  }

  /* Посетители по часам одного дня — то, из чего строится график «Сегодня».
   *
   * Обычно это готовый счётчик `hourVisitors`. Но в день, когда счётчик только
   * появился (или процесс простоял часть суток), он знает лишь свой кусок дня, а
   * график обязан описывать все сутки: сумма по часам — это и есть число
   * посетителей за день, и расхождение с плиткой над графиком читается как
   * поломка. Поэтому неполный счётчик подменяется пересчётом по хронологии
   * карточек, и берётся то, что накрывает БОЛЬШЕ людей.
   *
   * Пересчёт стоит прохода по карточкам, поэтому запоминается: панель
   * перерисовывается живым обновлением на каждое изменение, и считать его
   * заново на каждую перерисовку незачем. Ключ — дата и число посетителей за
   * день: пришёл новый — пересчитаем.
   */
  hourlyOf(row, date) {
    const stored = (row && row.hourVisitors) || {};
    const sum = obj => Object.values(obj).reduce((n, x) => n + (Number(x) || 0), 0);
    const people = row && Array.isArray(row.visitors) ? row.visitors.length : 0;
    const have = sum(stored);
    if (have >= people) return stored;
    const key = date + ':' + people;
    if (!this._hourlyMemo || this._hourlyMemo.key !== key) {
      this._hourlyMemo = { key, map: this.hourVisitorsFrom(row, date) };
    }
    return sum(this._hourlyMemo.map) > have ? this._hourlyMemo.map : stored;
  }

  /* Час первого за сутки просмотра каждого посетителя — по его хронологии.
   *
   * У карточки последние 50 просмотров, поэтому за прошлые дни это уже неправда,
   * и зовётся оно только для текущих суток, где хронология ещё цела. Правило то
   * же, что у самого счётчика: посетитель попадает в час своего ПЕРВОГО
   * просмотра за день, и потому сумма по часам равна числу уникальных за день.
   */
  hourVisitorsFrom(row, date) {
    const out = {};
    if (!row || !Array.isArray(row.visitors) || !row.visitors.length) return out;
    const wanted = new Set(row.visitors);
    for (const v of this.data.visitors) {
      if (!wanted.has(v.id) || !Array.isArray(v.hits)) continue;
      let first = 0;
      for (const h of v.hits) {
        const t = Number(h && h.t) || 0;
        if (!t || dayKey(t) !== date) continue;
        if (!first || t < first) first = t;
      }
      if (first) addCount(out, String(hourKey(first)), 1);
    }
    return out;
  }

  /* Долгий отчёт пересчитывается не чаще раза в SNAPSHOT_TTL.
   *
   * Уникальные посетители за период — это множество их id, и посчитать его
   * иначе как перебором нельзя: за год при тысяче заходов в сутки это больше
   * трёхсот тысяч строк, около 130 мс занятого потока. Само по себе терпимо,
   * но страница метрики обновляется ЖИВЬЁМ и перезапрашивает себя каждые 1,2 с,
   * пока на витрине хоть что-то происходит, — то есть открытая вкладка «12
   * мес.» съедала бы десятую часть единственного потока постоянно, и платили бы
   * за это покупатели на витрине.
   *
   * «Сегодня» кэшировать нельзя и не нужно: этот отчёт стоит полторы
   * миллисекунды, и открывают его как раз затем, чтобы увидеть текущий момент.
   */
  cachedSnapshot(days, options, now, geo) {
    // Свой размер списка посетителей просят только тесты — такой отчёт мимо кэша.
    if (days === 1 || Number(options.visitors) > 0) return null;
    // Ключ несёт и выбранную страну: у неё свои регионы и города, и отдать
    // мировой отчёт вместо страны значило бы показать чужую карту.
    const hit = this.snapshotCache.get(days + '|' + (geo || ''));
    return hit && now - hit.at < SNAPSHOT_TTL ? hit.value : null;
  }

  snapshot(options) {
    options = options || {};
    const now = Date.now();
    this.expirePending(now);
    // По умолчанию — сегодняшние сутки: панель открывают, чтобы узнать, что на
    // витрине происходит сейчас, а не каким был позавчерашний день.
    const days = [1, 7, 30, 365].includes(Number(options.days)) ? Number(options.days) : 1;
    /* Выбранная страна. Пустая строка — «весь мир», и это состояние по
     * умолчанию: карта тогда красит страны, а не области одной из них. Мусор в
     * адресе приводится к тому же миру — код проверяется здесь, в модели, чтобы
     * второй такой проверки в маршруте не появилось. */
    const geo = /^[A-Za-z]{2}$/.test(String(options.geo || '')) ? String(options.geo).toUpperCase() : '';
    const cached = this.cachedSnapshot(days, options, now, geo);
    if (cached) return cached;
    const wantedDates = [];
    for (let i = days - 1; i >= 0; i--) wantedDates.push(dayKey(now - i * 24 * 60 * 60 * 1000));
    const wanted = new Set(wantedDates);
    const rows = Object.values(this.data.daily).filter(d => wanted.has(d.date));
    const botRows = Object.values(this.data.botDaily || {}).filter(d => wanted.has(d.date));
    const byDate = {};
    for (const date of wantedDates) byDate[date] = { date, visits: 0, pageViews: 0, orders: 0, activeSeconds: 0, visitors: new Set() };
    const total = { visits: 0, pageViews: 0, orders: 0, activeSeconds: 0 };
    const unique = new Set(); const orderVisitors = new Set();
    const pages = {}; const campaigns = {};
    for (const d of rows) {
      const x = byDate[d.date];
      for (const id of d.visitors || []) { unique.add(id); x.visitors.add(id); }
      for (const id of d.orderVisitors || []) orderVisitors.add(id);
      for (const key of ['visits', 'pageViews', 'orders', 'activeSeconds']) { const n = Number(d[key]) || 0; x[key] += n; total[key] += n; }
      for (const [k, n] of Object.entries(d.pages || {})) addCount(pages, k, n);
      for (const [k, n] of Object.entries(d.campaigns || {})) addCount(campaigns, k, n);
    }
    const matching = this.data.visitors.filter(v => v.clientConfirmed && (unique.has(v.id) || now - v.lastSeen <= ONLINE_MS));
    const online = matching.filter(v => now - v.lastSeen <= ONLINE_MS).length;
    /* Техника, источник и город считаются ПО ПОСЕТИТЕЛЯМ, а не по просмотрам.
     *
     * Суточные счётчики (`d.devices` и соседи) растут на каждый просмотр, и в
     * отчёте, где главное число — уникальные посетители, «Телефон 1 240» рядом с
     * «Посетители 320» читается как сбой: у одного человека десяток просмотров.
     * Сами счётчики продолжают писаться — историю ради снятого блока не стираем.
     * Страницы остаются в просмотрах: «популярная страница» — это про то,
     * сколько раз её открыли, и у списка своя подпись про это. */
    const locations = {}; const regions = {}; const sources = {}; const devices = {}; const browsers = {}; const systems = {};
    /* Страны считаются ВСЕГДА, даже когда открыта карта одной из них: по ним
     * рисуется мир и собирается меню местоположения, а меню обязано показывать
     * все страны с посетителями — иначе из выбранной страны некуда вернуться,
     * кроме как в мир. Города и регионы, наоборот, считаются только у выбранной:
     * рядом с её картой стоит её же рейтинг. */
    const countries = {}; const cities = {};
    for (const v of matching) {
      if (!unique.has(v.id)) continue;
      addCount(locations, placeKey(v), 1);
      addCount(countries, countryCodeOf(v), 1);
      const region = regionIn(v, geo);
      if (region) addCount(regions, region, 1);
      if (geo && countryCodeOf(v) === geo) {
        const city = clean(v.city, 100);
        if (city) addCount(cities, city, 1);
      }
      bumpLimited(sources, v.source || 'Прямой заход', 200);
      bumpLimited(devices, v.device || 'Не определено', 20);
      bumpLimited(browsers, v.browser || 'Не определено', 100);
      bumpLimited(systems, v.os || 'Не определено', 100);
    }
    const ranked = obj => Object.entries(obj).sort((a, b) => b[1] - a[1]).map(([label, value]) => ({ label, value }));
    const top = obj => ranked(obj).slice(0, 8);
    const botTotals = { hits: 0, notFound: 0, agents: {}, paths: {} };
    for (const d of botRows) {
      botTotals.hits += Number(d.hits) || 0; botTotals.notFound += Number(d.notFound) || 0;
      for (const [k, n] of Object.entries(d.agents || {})) addCount(botTotals.agents, k, n);
      for (const [k, n] of Object.entries(d.paths || {})) addCount(botTotals.paths, k, n);
    }
    /* За год Google Trends показывает недели, а не 365 точек. Здесь агрегация
     * честная: посетители недели — объединение id семи дней, поэтому человек,
     * вернувшийся во вторник, не считается второй раз.
     *
     * НЕДЕЛИ ОТСЧИТЫВАЮТСЯ ОТ СЕГОДНЯ НАЗАД, и берутся ровно 52 полные — то есть
     * 364 дня из 365, а самый старый день отбрасывается. Иначе последний
     * столбец года собирался бы из одного дня (365 = 52×7 + 1), и график всегда
     * заканчивался бы обрывом вниз до седьмой части настоящего уровня — ровно в
     * той точке, на которую смотрят в первую очередь. */
    const weekly = [];
    if (days === 365) {
      const start = wantedDates.length - WEEKS_IN_YEAR * 7;
      for (let i = start; i < wantedDates.length; i += 7) {
        const dates = wantedDates.slice(i, i + 7);
        const visitors = new Set();
        for (const date of dates) for (const id of byDate[date].visitors) visitors.add(id);
        weekly.push({ date: dates[0], endDate: dates[dates.length - 1], visitors: visitors.size });
      }
    }
    const daily = Object.values(byDate).sort((a, b) => a.date.localeCompare(b.date)).map(d => Object.assign(d, { visitors: d.visitors.size }));
    /* Ряд для графика «Сегодня»: 24 часа московских суток. По дням такой отчёт
     * состоял бы из одной точки — линии не из чего строить. Часы берём у самого
     * дня, а не считаем по карточкам: у карточки последние 50 просмотров, и
     * вчерашние часы из них уже не восстановить.
     *
     * Счётчик `hourVisitors` начал писаться в день выкатки, то есть за прошедшие
     * до неё часы в нём НЕТ НИЧЕГО. Первый заход в этот раздел так и выглядел:
     * «Посетители 1 115», а на графике одинокая семёрка в 22:00 и ровный ноль до
     * неё — то есть график прямо противоречил числу над собой. Поэтому счётчику
     * верим не на слово: если он не набирает всех посетителей дня, час считается
     * по хронологии карточек, и берётся то, что накрывает больше людей. Условие
     * само себя снимает — со следующих суток счётчик полон и пересчёт не идёт. */
    const todayDate = wantedDates[wantedDates.length - 1];
    const todayRow = this.data.daily[todayDate];
    const byHour = this.hourlyOf(todayRow, todayDate);
    const hourly = [];
    for (let h = 0; h < 24; h++) hourly.push({ hour: h, visitors: Number(byHour[String(h)]) || 0 });
    // Предыдущий такой же период — для стрелок «больше/меньше» на карточках.
    const prevDates = [];
    for (let i = days * 2 - 1; i >= days; i--) prevDates.push(dayKey(now - i * 24 * 60 * 60 * 1000));
    const prev = this.totalsFor(prevDates);
    const list = matching.sort((a, b) => b.lastSeen - a.lastSeen);
    const report = {
      generatedAt: now, days, online, unique: unique.size, hourly, weekly, prev,
      hasHours: hourly.some(x => x.visitors > 0),
      visits: total.visits, pageViews: total.pageViews, orders: total.orders, activeSeconds: total.activeSeconds,
      conversion: unique.size ? Math.round((orderVisitors.size / unique.size) * 1000) / 10 : 0,
      returnRate: unique.size ? Math.round((matching.filter(v => unique.has(v.id) && Number(v.visits) > 1).length / unique.size) * 1000) / 10 : 0,
      pagesPerVisit: total.visits ? Math.round((total.pageViews / total.visits) * 10) / 10 : 0,
      averageSeconds: total.visits ? Math.round(total.activeSeconds / total.visits) : 0,
      bots: { hits: botTotals.hits, notFound: botTotals.notFound, agents: top(botTotals.agents), paths: top(botTotals.paths) },
      geo,
      daily, pages: top(pages), sources: top(sources), devices: top(devices), browsers: top(browsers), systems: top(systems), campaigns: top(campaigns), locations: top(locations), regions: ranked(regions),
      /* Страны отдаются КОДОМ, а не подписью: по коду карта находит контур, а
       * называет страну панель — одним именем на весь отчёт (`lib/geo-maps.js`).
       * Пустой код — посетители, у которых страна не определилась вовсе; на
       * карте их не поставить, но в рейтинге они честная строка. */
      countries: ranked(countries).map(row => ({ code: row.label, value: row.value })),
      cities: ranked(cities),
      /* Полный список посетителей живёт на своей странице («Кто заходил»), где
       * есть отбор по дням и технике: здесь показываются последние несколько
       * строк, а за остальными идут туда. Прежние «до 250 последних» были
       * потолком выдачи, а не хранения, и объясняли, почему в метрике нельзя
       * посмотреть позапрошлую неделю. */
      visitorsTotal: list.length,
      visitors: list.slice(0, Number(options.visitors) > 0 ? Number(options.visitors) : 6)
    };
    if (days !== 1 && !(Number(options.visitors) > 0)) this.snapshotCache.set(days + '|' + geo, { at: now, value: report });
    return report;
  }

  // Возвращает, убрала ли она хоть что-то: по этому ответу `maintain()` решает,
  // надо ли переписывать файл на магазине, где сегодня ничего не менялось.
  cleanup() {
    this.expirePending(Date.now());
    const cutoff = Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000;
    const before = this.data.visitors.length;
    let removed = 0;
    this.data.visitors = this.data.visitors.filter(v => Number(v.lastSeen) >= cutoff).sort((a, b) => b.lastSeen - a.lastSeen).slice(0, MAX_VISITORS);
    if (this.data.visitors.length !== before) this.reindex();
    removed += before - this.data.visitors.length;
    /* Дата суточной сводки читается из самой записи, поэтому испорченная строка
     * даёт NaN, а `NaN < cutoff` всегда ложно — такая сводка осталась бы лежать
     * вечно. Считаем её устаревшей: у живой записи дата есть всегда. */
    const expired = (d) => {
      const at = new Date(String((d && d.date) || '') + 'T00:00:00Z').getTime();
      return !Number.isFinite(at) || at < cutoff;
    };
    for (const [key, d] of Object.entries(this.data.daily)) if (expired(d)) { delete this.data.daily[key]; removed++; }
    for (const [key, d] of Object.entries(this.data.botDaily || {})) if (expired(d)) { delete this.data.botDaily[key]; removed++; }
    for (const [ip, geo] of Object.entries(this.data.geoCache)) {
      if (Date.now() - Number(geo.cachedAt || 0) > GEO_TTL) { delete this.data.geoCache[ip]; removed++; }
    }
    this.lastCleanup = Date.now();
    return removed > 0;
  }

  /* Тик сторожевого таймера: сперва уборка, потом запись.
   *
   * `flush()` выходит первой строкой при `!dirty` — а значит на магазине, где
   * сегодня не было ни одного посетителя, карточки старше срока хранения
   * (365 дней) не удалялись вовсе. Срок хранения — обещание из политики
   * конфиденциальности, и держаться оно не должно на том, пришёл ли кто-то
   * сегодня. Стоит это ничего: `cleanup()` выходит по `lastCleanup` мгновенно.
   */
  maintain() {
    if (Date.now() - this.lastCleanup >= CLEANUP_MS && this.cleanup()) this.dirty = true;
    this.flush();
  }

  flush() {
    if (!this.dirty) return;
    try {
      // Уборка режет данные по сроку хранения (365 дней) и сортирует до 10 000
      // карточек. На каждую запись это незачем: заказ и отказ от метрики зовут
      // flush сразу, а таймер — дважды в минуту. Раз в 10 минут более чем хватает.
      if (Date.now() - this.lastCleanup >= CLEANUP_MS) this.cleanup();
      else this.expirePending(Date.now());
      const tmp = this.file + '.' + process.pid + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(this.data), { mode: 0o600 });
      fs.renameSync(tmp, this.file);
      this.dirty = false;
    } catch (e) { console.error('Не удалось записать analytics.json:', e.message); }
  }
}

// Хронология посетителя визитами, свежие сверху. Границу визита задаёт отметка
// `v` у просмотра, а если её нет (карточка записана до появления хронологии или
// начало визита уже вытеснено потолком в MAX_HITS) — получасовой разрыв, тот же
// SESSION_MS, по которому считаются сами визиты.
function sessionsOf(visitor) {
  const hits = (visitor && Array.isArray(visitor.hits) ? visitor.hits : []).filter(h => h && h.t);
  const out = [];
  for (const h of hits) {
    const last = out[out.length - 1];
    const seconds = Math.max(0, Number(h.s) || 0);
    if (!last || h.v || Number(h.t) - Number(last.lastAt) > SESSION_MS) {
      out.push({ startAt: Number(h.t), lastAt: Number(h.t), endAt: Number(h.t) + seconds * 1000, seconds, hits: [h] });
      continue;
    }
    last.hits.push(h);
    last.lastAt = Number(h.t);
    last.endAt = Math.max(last.endAt, Number(h.t) + seconds * 1000);
    last.seconds += seconds;
  }
  return out.reverse();
}

module.exports = {
  Analytics, COOKIE_NAME, OPT_OUT_COOKIE, POLICY_VERSION, ONLINE_MS, SESSION_MS, MAX_HITS, RETENTION_DAYS, VISITORS_PER_PAGE,
  cookieValue, normalizeIp, isPrivateIp, deviceFromUa, clientDetails, safePath, sourceFromReferrer, dayKey, hourKey, familyOf, sessionsOf
};
