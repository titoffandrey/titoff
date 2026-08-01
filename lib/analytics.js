'use strict';

// Лёгкая first-party метрика. События считаются в памяти и записываются на диск
// одной пачкой, поэтому каждый heartbeat не создаёт отдельную операцию записи.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const net = require('net');

const COOKIE_NAME = 'am_analytics';
const OPT_OUT_COOKIE = 'am_analytics_off';
const POLICY_VERSION = '2026-07-27';
const ONLINE_MS = 2 * 60 * 1000;
const SESSION_MS = 30 * 60 * 1000;
const RETENTION_DAYS = 365;
const GEO_TTL = 30 * 24 * 60 * 60 * 1000;
const MAX_VISITORS = 10000;

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

function emptyData() { return { version: 2, visitors: [], daily: {}, botDaily: {}, geoCache: {}, geoUsage: { date: '', count: 0 } }; }

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
    this.fetcher = options.fetcher || globalThis.fetch;
    this.geoEnabled = options.geoEnabled !== false;
    this.data = this.load();
    this.dirty = false;
    this.geoInflight = new Map();
    const timer = setInterval(() => this.flush(), Number(options.flushMs) || 30000);
    if (timer.unref) timer.unref();
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
      ctx.geo = {
        city: clean(headers['cf-ipcity'], 100), region: clean(headers['cf-region'], 120),
        country: clean(headers['cf-ipcountry'], 80), isp: ''
      };
      if (!ctx.geo.city && !ctx.geo.region && !ctx.geo.country) delete ctx.geo;
    }
    return ctx;
  }

  findVisitor(id) { return this.data.visitors.find(v => v.id === id) || null; }

  ensureVisitor(id, siteId, ctx, now) {
    let v = this.findVisitor(id);
    if (!v) {
      v = {
        id, siteId: siteId || 'default', firstSeen: now, lastSeen: now, lastSessionAt: 0,
        visits: 0, pageViews: 0, pathCounts: {}, ip: ctx.ip || '', city: '', region: '', country: '', isp: '',
        device: ctx.device, model: ctx.model, os: ctx.os, browser: ctx.browser,
        source: ctx.source === 'Внутренний переход' ? 'Прямой заход' : ctx.source,
        orderCount: 0, lastOrderAt: null, policyVersion: POLICY_VERSION, startedAt: now, activeSeconds: 0, clientConfirmed: false
      };
      this.data.visitors.push(v);
    }
    v.siteId = siteId || v.siteId || 'default';
    v.lastSeen = now;
    if (ctx.ip) v.ip = ctx.ip;
    for (const key of ['device', 'model', 'os', 'browser', 'userAgent', 'screen', 'viewport', 'language', 'timezone', 'platform', 'connection', 'utmSource', 'utmMedium', 'utmCampaign']) if (ctx[key]) v[key] = ctx[key];
    for (const key of ['cpuCores', 'deviceMemory']) if (ctx[key] != null) v[key] = ctx[key];
    if (ctx.geo) Object.assign(v, ctx.geo);
    return v;
  }

  daily(siteId, now) {
    const date = dayKey(now);
    const key = (siteId || 'default') + '|' + date;
    if (!this.data.daily[key]) this.data.daily[key] = {
      siteId: siteId || 'default', date, visitors: [], orderVisitors: [], visits: 0, pageViews: 0, orders: 0,
      activeSeconds: 0, pages: {}, sources: {}, devices: {}, browsers: {}, systems: {}, campaigns: {}
    };
    const d = this.data.daily[key];
    d.visitors = Array.isArray(d.visitors) ? d.visitors : [];
    d.orderVisitors = Array.isArray(d.orderVisitors) ? d.orderVisitors : [];
    for (const name of ['pages', 'sources', 'devices', 'browsers', 'systems', 'campaigns']) if (!d[name] || typeof d[name] !== 'object') d[name] = {};
    d.activeSeconds = Number(d.activeSeconds) || 0;
    return d;
  }

  botDaily(siteId, now) {
    const date = dayKey(now);
    const key = (siteId || 'default') + '|' + date;
    if (!this.data.botDaily[key]) this.data.botDaily[key] = { siteId: siteId || 'default', date, hits: 0, notFound: 0, agents: {}, paths: {} };
    return this.data.botDaily[key];
  }

  recordTechnical(input) {
    const now = Date.now();
    const d = this.botDaily(input.siteId, now);
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
          siteId: v.siteId, path: v.pendingPage && v.pendingPage.path,
          requestedPath: v.pendingPage && v.pendingPage.path,
          context: { botName: 'Неподтверждённый автоматический запрос' }
        });
      } else keep.push(v);
    }
    this.data.visitors = keep;
  }

  recordPageView(input) {
    const now = Date.now();
    if (!/^[a-f0-9]{32}$/.test(String(input.id || ''))) return null;
    const ctx = input.context || {};
    if (ctx.isBot || input.is404) return this.recordTechnical(input);
    if (input.referrer) ctx.source = sourceFromReferrer(input.referrer, input.host);
    const v = this.ensureVisitor(input.id, input.siteId, ctx, now);
    if (input.provisional) {
      v.pendingPage = { path: safePath(input.path), at: now };
      this.dirty = true;
      return v;
    }
    v.clientConfirmed = true;
    const d = this.daily(v.siteId, now);
    const newSession = !v.lastSessionAt || now - v.lastSessionAt > SESSION_MS;
    if (newSession) { v.visits++; v.lastSessionAt = now; d.visits++; }
    const pending = v.pendingPage && now - Number(v.pendingPage.at || 0) < 60000 ? v.pendingPage : null;
    const p = pending ? pending.path : safePath(input.path);
    delete v.pendingPage;
    v.pageViews++; v.lastPage = p; if (!v.entryPage) v.entryPage = p;
    bumpLimited(v.pathCounts, p, 50);
    d.pageViews++; bumpLimited(d.pages, p, 500);
    if (!d.visitors.includes(v.id) && d.visitors.length < MAX_VISITORS) d.visitors.push(v.id);
    const src = v.source || 'Прямой заход'; bumpLimited(d.sources, src, 200);
    bumpLimited(d.devices, v.device || 'Не определено', 20);
    bumpLimited(d.browsers, v.browser || 'Не определено', 100);
    bumpLimited(d.systems, v.os || 'Не определено', 100);
    if (v.utmCampaign) bumpLimited(d.campaigns, [v.utmSource, v.utmMedium, v.utmCampaign].filter(Boolean).join(' · '), 200);
    this.dirty = true;
    if (ctx.geo || ctx.ip) this.populateGeo(v, ctx).catch(() => {});
    return v;
  }

  heartbeat(input) {
    const v = this.findVisitor(input.id);
    if (!v || !v.clientConfirmed || v.siteId !== input.siteId) return false;
    const now = Date.now();
    const elapsed = now - Number(v.lastSeen || now);
    if (elapsed >= 5000 && elapsed <= 90000) {
      const seconds = Math.round(elapsed / 1000);
      v.activeSeconds = (Number(v.activeSeconds) || 0) + seconds;
      this.daily(v.siteId, now).activeSeconds += seconds;
    }
    v.lastSeen = now;
    v.lastPage = safePath(input.path || v.lastPage);
    const ctx = input.context || {};
    const previousCampaign = v.utmCampaign || '';
    for (const key of ['device', 'model', 'os', 'browser', 'userAgent', 'screen', 'viewport', 'language', 'timezone', 'platform', 'connection', 'utmSource', 'utmMedium', 'utmCampaign']) if (ctx[key]) v[key] = ctx[key];
    for (const key of ['cpuCores', 'deviceMemory']) if (ctx[key] != null) v[key] = ctx[key];
    if (ctx.utmCampaign && ctx.utmCampaign !== previousCampaign) bumpLimited(this.daily(v.siteId, now).campaigns, [ctx.utmSource, ctx.utmMedium, ctx.utmCampaign].filter(Boolean).join(' · '), 200);
    if (ctx.ip) v.ip = ctx.ip;
    this.dirty = true;
    return true;
  }

  markOrder(visitorId, order) {
    const now = Number(order.createdAt) || Date.now();
    const d = this.daily(order.siteId, now);
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
    if (!ip || isPrivateIp(ip) || !this.geoEnabled || typeof this.fetcher !== 'function') return null;
    const cached = this.data.geoCache[ip];
    if (cached && Date.now() - cached.cachedAt < GEO_TTL) return cached;
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

  snapshot(options) {
    options = options || {};
    const now = Date.now();
    this.expirePending(now);
    const days = [1, 7, 30].includes(Number(options.days)) ? Number(options.days) : 7;
    const siteId = options.siteId || '';
    const wantedDates = [];
    for (let i = days - 1; i >= 0; i--) wantedDates.push(dayKey(now - i * 24 * 60 * 60 * 1000));
    const wanted = new Set(wantedDates);
    const rows = Object.values(this.data.daily).filter(d => (!siteId || d.siteId === siteId) && wanted.has(d.date));
    const botRows = Object.values(this.data.botDaily || {}).filter(d => (!siteId || d.siteId === siteId) && wanted.has(d.date));
    const byDate = {};
    for (const date of wantedDates) byDate[date] = { date, visits: 0, pageViews: 0, orders: 0, activeSeconds: 0, visitors: new Set() };
    const total = { visits: 0, pageViews: 0, orders: 0, activeSeconds: 0 };
    const unique = new Set(); const orderVisitors = new Set();
    const pages = {}; const sources = {}; const devices = {}; const browsers = {}; const systems = {}; const campaigns = {};
    for (const d of rows) {
      const x = byDate[d.date];
      for (const id of d.visitors || []) { unique.add(id); x.visitors.add(id); }
      for (const id of d.orderVisitors || []) orderVisitors.add(id);
      for (const key of ['visits', 'pageViews', 'orders', 'activeSeconds']) { const n = Number(d[key]) || 0; x[key] += n; total[key] += n; }
      for (const [k, n] of Object.entries(d.pages || {})) addCount(pages, k, n);
      for (const [k, n] of Object.entries(d.sources || {})) addCount(sources, k, n);
      for (const [k, n] of Object.entries(d.devices || {})) addCount(devices, k, n);
      for (const [k, n] of Object.entries(d.browsers || {})) addCount(browsers, k, n);
      for (const [k, n] of Object.entries(d.systems || {})) addCount(systems, k, n);
      for (const [k, n] of Object.entries(d.campaigns || {})) addCount(campaigns, k, n);
    }
    const matching = this.data.visitors.filter(v => v.clientConfirmed && (!siteId || v.siteId === siteId) && (unique.has(v.id) || now - v.lastSeen <= ONLINE_MS));
    const online = matching.filter(v => now - v.lastSeen <= ONLINE_MS).length;
    const locations = {};
    for (const v of matching) if (unique.has(v.id)) bumpLimited(locations, [v.city, v.region, v.country].filter(Boolean).filter((x, i, a) => a.indexOf(x) === i).join(', ') || 'Не определено', 200);
    const top = obj => Object.entries(obj).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([label, value]) => ({ label, value }));
    const botTotals = { hits: 0, notFound: 0, agents: {}, paths: {} };
    for (const d of botRows) {
      botTotals.hits += Number(d.hits) || 0; botTotals.notFound += Number(d.notFound) || 0;
      for (const [k, n] of Object.entries(d.agents || {})) addCount(botTotals.agents, k, n);
      for (const [k, n] of Object.entries(d.paths || {})) addCount(botTotals.paths, k, n);
    }
    const daily = Object.values(byDate).sort((a, b) => a.date.localeCompare(b.date)).map(d => Object.assign(d, { visitors: d.visitors.size }));
    return {
      generatedAt: now, days, siteId, online, unique: unique.size,
      visits: total.visits, pageViews: total.pageViews, orders: total.orders, activeSeconds: total.activeSeconds,
      conversion: unique.size ? Math.round((orderVisitors.size / unique.size) * 1000) / 10 : 0,
      returnRate: unique.size ? Math.round((matching.filter(v => unique.has(v.id) && Number(v.visits) > 1).length / unique.size) * 1000) / 10 : 0,
      pagesPerVisit: total.visits ? Math.round((total.pageViews / total.visits) * 10) / 10 : 0,
      averageSeconds: total.visits ? Math.round(total.activeSeconds / total.visits) : 0,
      bots: { hits: botTotals.hits, notFound: botTotals.notFound, agents: top(botTotals.agents), paths: top(botTotals.paths) },
      daily, pages: top(pages), sources: top(sources), devices: top(devices), browsers: top(browsers), systems: top(systems), campaigns: top(campaigns), locations: top(locations),
      visitors: matching.sort((a, b) => b.lastSeen - a.lastSeen).slice(0, 250)
    };
  }

  cleanup() {
    this.expirePending(Date.now());
    const cutoff = Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000;
    this.data.visitors = this.data.visitors.filter(v => Number(v.lastSeen) >= cutoff).sort((a, b) => b.lastSeen - a.lastSeen).slice(0, MAX_VISITORS);
    for (const [key, d] of Object.entries(this.data.daily)) if (new Date(d.date + 'T00:00:00Z').getTime() < cutoff) delete this.data.daily[key];
    for (const [key, d] of Object.entries(this.data.botDaily || {})) if (new Date(d.date + 'T00:00:00Z').getTime() < cutoff) delete this.data.botDaily[key];
    for (const [ip, geo] of Object.entries(this.data.geoCache)) if (Date.now() - Number(geo.cachedAt || 0) > GEO_TTL) delete this.data.geoCache[ip];
  }

  flush() {
    if (!this.dirty) return;
    try {
      this.cleanup();
      const tmp = this.file + '.' + process.pid + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(this.data), { mode: 0o600 });
      fs.renameSync(tmp, this.file);
      this.dirty = false;
    } catch (e) { console.error('Не удалось записать analytics.json:', e.message); }
  }
}

module.exports = {
  Analytics, COOKIE_NAME, OPT_OUT_COOKIE, POLICY_VERSION, ONLINE_MS,
  cookieValue, normalizeIp, isPrivateIp, deviceFromUa, clientDetails, safePath, sourceFromReferrer, dayKey
};
