#!/usr/bin/env node
'use strict';
/* Критические стили витрины: `public/critical.css` из `public/styles.css`.
 *
 * Зачем. `styles.css` — единственный запрос, который блокирует отрисовку
 * витрины: пока он не приехал, браузер не рисует ничего, и на телефоне это
 * лишние 200–300 мс до первого экрана (PageSpeed 19 сентября 2026 показал
 * ровно его — «Запросы, блокирующие отрисовку»). Лечится инлайном ТОЙ части
 * стилей, что нужна первому экрану: она уезжает в `<style>` прямо в HTML, а
 * полный файл грузится следом, не блокируя (см. `layout()` в lib/render.js).
 *
 * Какие правила «критические», решает не список селекторов, выписанный
 * руками (он отстал бы от styles.css на первой правке), а живой браузер:
 * скрипт поднимает магазин на временном каталоге данных, открывает страницы
 * витрины в headless Chrome на нескольких вьюпортах и для каждого правила
 * спрашивает, есть ли у его селектора элемент В ПЕРВОМ ЭКРАНЕ. Есть хоть где-то
 * — правило нужно до прихода полного файла. Спрятанные элементы (display:none,
 * пустые) считаются попавшими: правило `[hidden]{display:none}` обязано
 * приехать вместе с правилом, которое ставит элементу `display:flex`, иначе
 * первый кадр показал бы счётчик корзины с нулём.
 *
 * Правила уезжают ТЕКСТОМ ИЗ ИСХОДНИКА, а не из CSSOM: браузер нормализует
 * `cssText` (цвета, шорткаты), и тест, сверяющий подмножество с полным файлом
 * (test/critical-css.test.js), не нашёл бы их. Разбор — lib/css-rules.js.
 *
 * Зависимостей нет: Chrome берётся с машины (macOS-путь или $CHROME), CDP идёт
 * по встроенному WebSocket Node 22+. На сервере Chrome нет, поэтому файл
 * генерируется на ноутбуке и КОММИТИТСЯ, как lib/world-map-data.js.
 *
 *   node scripts/build-critical-css.js            # собрать и записать
 *   node scripts/build-critical-css.js --check    # сравнить с записанным (код 1 — устарел)
 *   node scripts/build-critical-css.js --verify   # доказать: первый экран с одним
 *                                                 # critical.css совпадает с полным CSS
 *                                                 # пиксель в пиксель (rect + computed style)
 *
 * ПРАВИШЬ styles.css — ПРОГОНИ `npm run css:critical`. Тест сторожит только
 * то, что правила критического файла ещё есть в полном (устаревшее правило
 * упадёт), но не то, что НОВОЕ правило первого экрана в него попало: без
 * прогона новый блок над сгибом мигнёт голой разметкой на первом заходе.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const http = require('http');
const RULES = require('../lib/css-rules');
const MIN = require('../lib/minify');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'public', 'styles.css');
const OUT_DIR = path.join(ROOT, 'public', 'critical');

/* Вьюпорты: телефон Lighthouse (412×823, DPR 1.75 — на нём и меряет PageSpeed),
 * обычный ноутбук и широкий монитор (сгиб ниже — первый экран длиннее). */
const VIEWPORTS = [
  { name: 'mobile', width: 412, height: 823, dpr: 1.75, mobile: true },
  { name: 'laptop', width: 1440, height: 900, dpr: 2, mobile: false },
  { name: 'wide', width: 1920, height: 1080, dpr: 1, mobile: false }
];

/* Страницы, которым нужен быстрый путь: главная, каталог (категория, поиск)
 * и товар — на них ПРИХОДЯТ с холодным кэшем из поиска и рекламы. Только у них
 * `layout()` инлайнит критические стили и грузит полный файл без блокировки;
 * остальные (оформление, документы, кабинет) остаются с блокирующей ссылкой:
 * до них доходят уже с полным CSS в кэше, а мигнуть голой разметкой на
 * холодном заходе им нельзя. У каждого вида страниц СВОЙ файл: первый экран
 * товара (галерея, ряды выбора, кнопка) вдвое больше первого экрана главной,
 * и одним общим набором главная возила бы чужие правила. Ключи обязаны
 * совпадать с CRITICAL_KINDS в lib/render.js — закреплено тестом. Товаров два:
 * с ремешками (часы) и с группами доп. характеристик (iPhone) — у них разные
 * ряды выбора. */
function kinds(ids) {
  return {
    home: ['/'],
    catalog: ['/catalog', '/catalog?category=' + encodeURIComponent('iPhone'), '/catalog?q=iphone'],
    product: ['/product/' + ids.phone, '/product/' + ids.watch]
  };
}

/* Псевдоклассы состояния и псевдоэлементы для проверки снимаются: у `.x:hover`
 * и `.x::before` нужен сам `.x`. `:checked`/`:disabled` остаются — это состояние
 * на момент загрузки, и querySelectorAll ответит по нему честно. */
function probeSelector(sel) {
  let s = String(sel)
    .replace(/::?-(?:webkit|moz|ms)-[\w-]+(?:\([^)]*\))?/g, '')
    .replace(/::[\w-]+(?:\([^)]*\))?/g, '')
    .replace(/:(?:before|after|placeholder|selection|marker|first-line|first-letter)\b/g, '')
    .replace(/:(?:hover|active|focus-visible|focus-within|focus|visited|link|target|placeholder-shown|autofill|user-invalid|user-valid)\b/g, '')
    .replace(/:not\(\s*\)/g, '');
  return s.trim();
}

// Запрос @media решает вьюпорт только у ширины/высоты; hover, pointer и
// prefers-* — свойства устройства и настроек покупателя, их не угадать, и
// правила внутри берутся по селектору. `print` не нужен первому экрану никогда.
function mediaKind(prelude) {
  const q = prelude.replace(/^@media\s*/i, '').toLowerCase();
  if (/\bprint\b/.test(q)) return 'never';
  if (/(?:min|max)-(?:width|height)|\bwidth\b|\bheight\b/.test(q)) return 'viewport';
  return 'always';
}

/* ------------------------------ Chrome по CDP ------------------------------ */
function findChrome() {
  const cands = [
    process.env.CHROME,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'
  ].filter(Boolean);
  for (const c of cands) if (fs.existsSync(c)) return c;
  throw new Error('Chrome не найден: задайте путь в переменной CHROME');
}

class Chrome {
  constructor(bin, profile) {
    this.proc = spawn(bin, [
      '--headless=new', '--remote-debugging-port=0', '--user-data-dir=' + profile, '--no-first-run',
      '--no-default-browser-check', '--disable-gpu', '--hide-scrollbars', '--disable-extensions',
      '--disable-background-networking', '--disable-sync', 'about:blank'
    ], { stdio: ['ignore', 'ignore', 'pipe'] });
    this.id = 0;
    this.pending = new Map();
    this.listeners = [];
  }
  async connect() {
    const url = await new Promise((resolve, reject) => {
      let buf = '';
      const timer = setTimeout(() => reject(new Error('Chrome не поднял DevTools за 20 с')), 20000);
      this.proc.stderr.on('data', d => {
        buf += d;
        const m = buf.match(/DevTools listening on (ws:\/\/\S+)/);
        if (m) { clearTimeout(timer); resolve(m[1]); }
      });
      this.proc.on('exit', code => reject(new Error('Chrome вышел с кодом ' + code)));
    });
    this.ws = new WebSocket(url);
    await new Promise((resolve, reject) => { this.ws.onopen = resolve; this.ws.onerror = reject; });
    this.ws.onmessage = ev => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const p = this.pending.get(msg.id); this.pending.delete(msg.id);
        if (msg.error) p.reject(new Error(msg.method + ': ' + JSON.stringify(msg.error)));
        else p.resolve(msg.result);
      } else if (msg.method) {
        for (const fn of this.listeners) fn(msg);
      }
    };
  }
  send(method, params, sessionId) {
    const id = ++this.id;
    this.ws.send(JSON.stringify(Object.assign({ id, method, params: params || {} }, sessionId ? { sessionId } : {})));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject, method }));
  }
  on(fn) { this.listeners.push(fn); return () => { this.listeners = this.listeners.filter(f => f !== fn); }; }
  async page() {
    const { targetId } = await this.send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await this.send('Target.attachToTarget', { targetId, flatten: true });
    return new Page(this, targetId, sessionId);
  }
  close() {
    try { this.ws.close(); } catch (e) { /* уже закрыт */ }
    // Ждём выхода: профиль Chrome дописывается при остановке, и уборка каталога
    // под ним споткнулась бы о свежий файл.
    return new Promise(resolve => { this.proc.once('exit', () => resolve()); this.proc.kill(); setTimeout(resolve, 5000); });
  }
}

class Page {
  constructor(chrome, targetId, sessionId) { this.c = chrome; this.targetId = targetId; this.sid = sessionId; }
  send(method, params) { return this.c.send(method, params, this.sid); }
  async setup(vp, opts) {
    await this.send('Page.enable');
    await this.send('Runtime.enable');
    await this.send('Emulation.setDeviceMetricsOverride', { width: vp.width, height: vp.height, deviceScaleFactor: vp.dpr, mobile: !!vp.mobile });
    if (vp.mobile) {
      await this.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
      await this.send('Emulation.setEmulatedMedia', { features: [{ name: 'hover', value: 'none' }, { name: 'pointer', value: 'coarse' }] });
    }
    if (opts && opts.noScript) await this.send('Emulation.setScriptExecutionDisabled', { value: true });
    if (opts && opts.onNew) await this.send('Page.addScriptToEvaluateOnNewDocument', { source: opts.onNew });
    if (opts && opts.block) {
      await this.send('Fetch.enable', { patterns: [{ urlPattern: opts.block, requestStage: 'Request' }] });
      this.c.on(msg => {
        if (msg.method === 'Fetch.requestPaused' && msg.sessionId === this.sid) {
          this.send('Fetch.failRequest', { requestId: msg.params.requestId, errorReason: 'BlockedByClient' }).catch(() => {});
        }
      });
    }
  }
  async open(url, settleMs) {
    const loaded = new Promise(resolve => {
      const off = this.c.on(msg => { if (msg.method === 'Page.loadEventFired' && msg.sessionId === this.sid) { off(); resolve(); } });
    });
    await this.send('Page.navigate', { url });
    await Promise.race([loaded, new Promise(r => setTimeout(r, 15000))]);
    await new Promise(r => setTimeout(r, settleMs || 400));
  }
  async eval(expression) {
    const r = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error('в странице: ' + (r.exceptionDetails.exception && r.exceptionDetails.exception.description || r.exceptionDetails.text));
    return r.result.value;
  }
  close() { return this.c.send('Target.closeTarget', { targetId: this.targetId }); }
}

/* ------------------------------ Магазин ------------------------------ */
// Прозрачный WebP 1×1 — под этим именем и его копиями лежат «фото» товаров.
const WEBP_1PX = Buffer.from('UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEADsD+JaQAA3AAAAAA', 'base64');

function freePort() {
  return new Promise((resolve, reject) => {
    const s = http.createServer();
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
    s.on('error', reject);
  });
}

function fetchText(url) {
  return new Promise((resolve, reject) => {
    http.get(url, res => { let b = ''; res.on('data', d => b += d); res.on('end', () => resolve({ status: res.statusCode, body: b })); }).on('error', reject);
  });
}

async function startStore(work) {
  const dataDir = path.join(work, 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  const env = Object.assign({}, process.env, { STORE_DATA_DIR: dataDir, GEOIP_ENABLED: '0' });
  const seeded = spawnSync(process.execPath, ['-e', 'require("./lib/db").ensureSeeded()'], { cwd: ROOT, env, encoding: 'utf8' });
  if (seeded.status !== 0) throw new Error('посев не удался: ' + seeded.stderr);
  // Чат включён (без него нет ни кнопки, ни окна — их правила не попали бы в
  // файл), ключ ненастоящий: в сеть чат ходит только на реплику покупателя.
  const sp = path.join(dataDir, 'settings.json');
  const settings = JSON.parse(fs.readFileSync(sp, 'utf8'));
  Object.assign(settings, { chatEnabled: true, aiApiKey: 'sk-critical-css-probe', contactTelegram: 'store', contactPhone: '+79990000000', contactEmail: 'shop@example.com', contactHours: '09:00–22:00 МСК' });
  fs.writeFileSync(sp, JSON.stringify(settings));
  // У каждого товара — ДВА фото и уменьшенные копии, иначе плитки и карточки
  // рисовались бы плейсхолдером и правила `img` в них не проверялись бы. Два, а
  // не одно: стрелки и точки галереи появляются только от второго снимка, и с
  // одним `.g-arrow` в набор не попадал — на посадочном заходе кнопки первый
  // кадр стояли голыми серыми плитками под кадром, пока не приедет полный файл.
  const pp = path.join(dataDir, 'products.json');
  const products = JSON.parse(fs.readFileSync(pp, 'utf8'));
  const up = path.join(dataDir, 'uploads');
  fs.mkdirSync(up, { recursive: true });
  const IMG = require('../lib/images');
  for (const p of products) {
    p.images = [p.id + '.webp', p.id + '-2.webp'];
    for (const name of p.images) {
      fs.writeFileSync(path.join(up, name), WEBP_1PX);
      for (const size of IMG.CARD_SIZES) fs.writeFileSync(path.join(up, IMG.cardName(name, size)), WEBP_1PX);
    }
  }
  fs.writeFileSync(pp, JSON.stringify(products));
  const ids = {
    phone: (products.find(p => /^iphone-17-pro/.test(p.id)) || products[0]).id,
    watch: (products.find(p => p.bands && p.bands.length) || products[0]).id,
    any: products[0]
  };
  const port = await freePort();
  const proc = spawn(process.execPath, ['server.js'], { cwd: ROOT, env: Object.assign({}, env, { PORT: String(port) }), stdio: ['ignore', 'ignore', 'pipe'] });
  let err = '';
  proc.stderr.on('data', d => { err += d; });
  const origin = 'http://127.0.0.1:' + port;
  for (let i = 0; i < 100; i++) {
    await new Promise(r => setTimeout(r, 150));
    try { const r = await fetchText(origin + '/'); if (r.status === 200) break; } catch (e) { /* ещё не слушает */ }
    if (i === 99) throw new Error('магазин не поднялся: ' + err);
  }
  // Остановка ждёт выхода процесса: он дописывает метрику на диск, и уборка
  // каталога под ним споткнулась бы о свежий файл.
  const stop = () => new Promise(resolve => { proc.once('exit', () => resolve()); proc.kill(); setTimeout(resolve, 3000); });
  return { origin, ids, stop };
}

/* ------------------------------ Отбор правил ------------------------------ */
/* Нужен ли элемент первому экрану. Правило нужно тому, что видно, и тому, что
 * ПРЯЧЕТ САМО СЕБЯ: закрытая шторка корзины (уехала за край экрана), панель
 * разделов (visibility:hidden, ширина 0), счётчик с `hidden` — без своего
 * правила каждое из них стояло бы посреди первого кадра. А вот их СОДЕРЖИМОЕ
 * до открытия не видит никто, и открывают его нажатием — к тому моменту
 * полный файл давно приехал. Поэтому потомки спрятанного не берутся: узел
 * без размера, унаследованная невидимость, узел за краем экрана при родителе
 * за тем же краем. */
const PROBE = `(function(sels){
  function offscreen(r){ return r.right<=0||r.left>=innerWidth||r.bottom<=0||r.top>=innerHeight; }
  function inView(el){
    var cs=getComputedStyle(el); if(cs.display==='none') return true;
    var r=el.getBoundingClientRect();
    if(r.width===0&&r.height===0) return false;
    var p=el.parentElement;
    if(cs.visibility==='hidden') return !p||getComputedStyle(p).visibility!=='hidden';
    if(offscreen(r)) return !!p&&!offscreen(p.getBoundingClientRect());
    return true;
  }
  var cache={}; var out=[];
  for (var i=0;i<sels.length;i++){
    var s=sels[i]; if(!s){out.push(1);continue}
    if(s in cache){out.push(cache[s]);continue}
    var v;
    try{ var els=document.querySelectorAll(s); v=0; for(var j=0;j<els.length;j++){ if(inView(els[j])){v=1;break} } }
    catch(e){ v=2 }
    cache[s]=v; out.push(v);
  }
  return out;
})`;

async function collect(chrome, store) {
  const tree = RULES.parse(fs.readFileSync(SRC, 'utf8'));
  const leaves = RULES.flatten(tree);
  const probes = leaves.map(l => l.node.type === 'rule' ? RULES.splitSelectors(l.node.selector).map(probeSelector) : []);
  const flatSel = [...new Set(probes.flat())];
  const medias = [...new Set(leaves.flatMap(l => l.chain.filter(a => a.name === 'media').map(a => a.prelude)))];
  const supports = [...new Set(leaves.flatMap(l => l.chain.filter(a => a.name === 'supports').map(a => a.prelude)))];
  const byKind = kinds(store.ids);
  const keep = {};
  for (const k of Object.keys(byKind)) keep[k] = new Set();
  const unknown = new Set();
  /* Каждая страница смотрится ДВАЖДЫ: без скриптов — это разметка сервера,
   * ровно то, что рисует первый кадр, — и со скриптами, потому что app.js
   * успевает изменить её до прихода полного файла (счётчик корзины, ряды
   * выбора). Одного прохода со скриптами мало: они снимают `hidden` со
   * счётчика, и правило `.cart-badge[hidden]{display:none}` не находило
   * элемента — а без него первый кадр показывал бы счётчик с нулём. */
  for (const vp of VIEWPORTS) for (const noScript of [true, false]) {
    const page = await chrome.page();
    await page.setup(vp, { noScript });
    // Ширина решается здесь, поэтому сразу спрашиваем, какие запросы совпали.
    await page.open(store.origin + '/');
    const mediaOk = await page.eval(`(${JSON.stringify(medias)}).map(function(p){return matchMedia(p.replace(/^@media\\s*/i,'')).matches})`);
    const supportsOk = await page.eval(`(${JSON.stringify(supports)}).map(function(p){try{return CSS.supports(p.replace(/^@supports\\s*/i,''))}catch(e){return false}})`);
    const mediaMatch = new Map(medias.map((m, i) => [m, mediaOk[i]]));
    const supportsMatch = new Map(supports.map((m, i) => [m, supportsOk[i]]));
    for (const kind of Object.keys(byKind)) for (const url of byKind[kind]) {
      const kept = keep[kind];
      await page.open(store.origin + url);
      const res = await page.eval(`${PROBE}(${JSON.stringify(flatSel)})`);
      const hit = new Map(flatSel.map((s, i) => [s, res[i]]));
      leaves.forEach((leaf, i) => {
        if (leaf.node.type !== 'rule' || kept.has(i)) return;
        // Обёртки: ширина — по вьюпорту, устройство/настройки — всегда, print — никогда.
        for (const a of leaf.chain) {
          if (a.name === 'media') {
            const kind = mediaKind(a.prelude);
            if (kind === 'never' || (kind === 'viewport' && !mediaMatch.get(a.prelude))) return;
          } else if (a.name === 'supports' && !supportsMatch.get(a.prelude)) return;
        }
        for (const s of probes[i]) {
          const v = hit.get(s);
          if (v === 2) unknown.add(s);
          if (v) { kept.add(i); return; }
        }
      });
      process.stderr.write(`  ${vp.name.padEnd(6)} ${noScript ? 'без js' : 'с js  '} ${kind.padEnd(8)} ${url.padEnd(34)} правил: ${kept.size}\n`);
    }
    await page.close();
  }
  // @keyframes — по именам анимаций в оставленных правилах.
  for (const kind of Object.keys(keep)) {
    const kept = keep[kind];
    const names = new Set();
    for (const i of kept) for (const m of leaves[i].node.body.matchAll(/animation(?:-name)?\s*:([^;]+)/g)) {
      for (const w of m[1].split(/[\s,]+/)) if (/^[a-zA-Z_-][\w-]*$/.test(w)) names.add(w);
    }
    leaves.forEach((leaf, i) => {
      if (leaf.node.type !== 'raw' || !/keyframes$/.test(leaf.node.name)) return;
      const name = leaf.node.prelude.split(/\s+/).pop();
      if (names.has(name)) kept.add(i);
    });
  }
  return { tree, leaves, keep, unknown };
}

// Дерево из оставленных листьев: порядок исходника, пустые обёртки уходят.
function prune(nodes, keptSet, leaves, counter) {
  const out = [];
  for (const node of nodes) {
    if (node.type === 'at') {
      const rules = prune(node.rules, keptSet, leaves, counter);
      if (rules.length) out.push({ type: 'at', name: node.name, prelude: node.prelude, rules });
    } else {
      const i = counter.i++;
      if (keptSet.has(i)) out.push(node);
    }
  }
  return out;
}

function header(kind, size) {
  return `/* СГЕНЕРИРОВАНО scripts/build-critical-css.js из public/styles.css — РУКАМИ НЕ ПРАВИТЬ.
 * Правила первого экрана витрины (${kind}), уезжают инлайном в <head> на
 * посадочном заходе (см. layout() в lib/render.js), полный styles.css грузится
 * следом без блокировки. Правил: ${size}. Правишь styles.css — прогони
 * \`npm run css:critical\`; свежесть сторожит test/critical-css.test.js. */
`;
}

// Готовые тексты файлов по видам страниц.
async function build() {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'critical-css-'));
  const store = await startStore(work);
  const chrome = new Chrome(findChrome(), path.join(work, 'chrome'));
  try {
    await chrome.connect();
    process.stderr.write('Отбор правил первого экрана…\n');
    const { tree, leaves, keep, unknown } = await collect(chrome, store);
    if (unknown.size) process.stderr.write('Селекторы, которых Chrome не понял (включены на всякий случай): ' + [...unknown].join(' | ') + '\n');
    const full = MIN.css(fs.readFileSync(SRC, 'utf8')).length;
    const out = {};
    for (const kind of Object.keys(keep)) {
      const kept = prune(tree, keep[kind], leaves, { i: 0 });
      out[kind] = header(kind, keep[kind].size) + RULES.stringify(kept) + '\n';
      process.stderr.write(`${kind.padEnd(8)} правил: ${keep[kind].size} из ${leaves.length}, ${MIN.css(out[kind]).length} байт без комментариев (полный styles.css — ${full}).\n`);
    }
    return out;
  } finally {
    await chrome.close();
    await store.stop();
    cleanup(work);
  }
}

function cleanup(dir) {
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
}

/* ------------------------------ Проверка ------------------------------ */
/* Снимок первого экрана: у каждого элемента — виден ли он в первом экране,
 * его рамка и все вычисленные свойства. Сравниваются две отрисовки БЕЗ
 * скриптов: с полным CSS (его подключает <noscript>) и с одним критическим
 * (запрос styles.css обрывается). Элементы, видимые хоть в одной, обязаны
 * совпасть пиксель в пиксель — иначе приход полного файла двигал бы раскладку. */
const SNAPSHOT = `(function(){
  // Анимации — в нулевую фазу: бегущая строка и мигающая точка иначе стоят в
  // разных положениях просто потому, что снимки сделаны в разное время.
  document.getAnimations().forEach(function(a){ try{ a.pause(); a.currentTime=0; }catch(e){} });
  var out=[]; var els=document.querySelectorAll('body, body *');
  for (var i=0;i<els.length;i++){
    var el=els[i]; if(el.tagName==='SCRIPT'||el.tagName==='NOSCRIPT'||el.tagName==='STYLE'||el.tagName==='LINK') { out.push(null); continue; }
    var cs=getComputedStyle(el); var r=el.getBoundingClientRect();
    var vis=cs.display!=='none'&&cs.visibility!=='hidden'&&r.width>0&&r.height>0&&r.top<innerHeight&&r.bottom>0&&r.left<innerWidth&&r.right>0;
    // Свойства сортируются: порядок пользовательских (--*) у Chrome зависит от
    // того, какой из двух таблиц стилей они встретились первыми. Размеры
    // (width/height и их логические имена) — производные раскладки, а у body
    // и длинных контейнеров низ за сгибом; геометрию видимого сверяет рамка.
    var SKIP={width:1,height:1,'block-size':1,'inline-size':1,'perspective-origin':1,'transform-origin':1,'grid-template-rows':1,'grid-template-columns':1};
    var st=[]; for(var j=0;j<cs.length;j++){var p=cs[j]; if(SKIP[p]) continue; st.push(p+':'+cs.getPropertyValue(p));}
    st.sort();
    // Рамка обрезается по окну: у body и длинных контейнеров низ лежит за
    // сгибом, где стили и правда разные, — сравнивается только видимая часть.
    var box=[Math.max(r.left,0),Math.max(r.top,0),Math.min(r.right,innerWidth),Math.min(r.bottom,innerHeight)];
    out.push({tag:el.tagName, cls:el.className&&el.className.baseVal!==undefined?el.className.baseVal:el.className, vis:vis, rect:box.map(function(v){return Math.round(v*2)/2}).join(','), style:st.join(';')});
  }
  return out;
})()`;

async function verify() {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'critical-css-'));
  const store = await startStore(work);
  const chrome = new Chrome(findChrome(), path.join(work, 'chrome'));
  let bad = 0;
  try {
    await chrome.connect();
    const byKind = kinds(store.ids);
    for (const vp of VIEWPORTS) {
      const full = await chrome.page(); await full.setup(vp, { noScript: true });
      const crit = await chrome.page(); await crit.setup(vp, { noScript: true, block: '*styles.css*' });
      for (const kind of Object.keys(byKind)) for (const url of byKind[kind]) {
        await full.open(store.origin + url);
        await crit.open(store.origin + url);
        const sheets = await crit.eval('document.styleSheets.length');
        const a = await full.eval(SNAPSHOT);
        const b = await crit.eval(SNAPSHOT);
        let diff = 0;
        const shown = [];
        if (a.length !== b.length) { diff = 1; shown.push(`число элементов ${a.length} против ${b.length}`); }
        else for (let i = 0; i < a.length; i++) {
          if (!a[i] || !b[i]) continue;
          if (!a[i].vis && !b[i].vis) continue;
          if (a[i].rect !== b[i].rect || a[i].style !== b[i].style || a[i].vis !== b[i].vis) {
            diff++;
            if (shown.length < 4) {
              const why = a[i].rect !== b[i].rect ? `rect ${a[i].rect} → ${b[i].rect}` : (a[i].vis !== b[i].vis ? `vis ${a[i].vis} → ${b[i].vis}` : 'style: ' + firstStyleDiff(a[i].style, b[i].style));
              shown.push(`${a[i].tag}.${String(a[i].cls).split(' ')[0]} ${why}`);
            }
          }
        }
        bad += diff;
        process.stderr.write(`  ${vp.name.padEnd(6)} ${kind.padEnd(8)} ${url.padEnd(34)} ${diff ? 'РАСХОЖДЕНИЙ ' + diff : 'совпало'}${sheets === 0 ? ' (нет стилей вовсе!)' : ''}\n`);
        for (const line of shown) process.stderr.write(`      ${line}\n`);
      }
      await full.close(); await crit.close();
    }
  } finally {
    await chrome.close();
    await store.stop();
    cleanup(work);
  }
  return bad;
}

function firstStyleDiff(a, b) {
  const x = a.split(';'), y = b.split(';');
  for (let i = 0; i < Math.max(x.length, y.length); i++) if (x[i] !== y[i]) return `${x[i]} → ${y[i]}`;
  return '?';
}

/* ------------------------------ Вход ------------------------------ */
function outPath(kind) { return path.join(OUT_DIR, kind + '.css'); }

(async () => {
  const args = process.argv.slice(2);
  if (args.includes('--verify')) {
    if (!fs.existsSync(OUT_DIR)) { console.error('Нет ' + OUT_DIR + ' — сперва соберите'); process.exit(1); }
    const bad = await verify();
    if (bad) { console.error(`Расхождений: ${bad}. Первый экран с критическими стилями отличается от полного.`); process.exit(1); }
    console.error('Первый экран с одними критическими стилями совпадает с полным CSS на всех страницах и вьюпортах.');
    return;
  }
  const out = await build();
  const stale = Object.keys(out).filter(kind => !fs.existsSync(outPath(kind)) || MIN.css(fs.readFileSync(outPath(kind), 'utf8')) !== MIN.css(out[kind]));
  if (args.includes('--check')) {
    if (!stale.length) { console.error('critical/*.css свежие.'); return; }
    console.error('УСТАРЕЛИ: ' + stale.join(', ') + ' — прогоните `npm run css:critical` и закоммитьте.');
    process.exit(1);
  }
  if (!stale.length) { console.error('critical/*.css не изменились.'); return; }
  fs.mkdirSync(OUT_DIR, { recursive: true });
  for (const kind of stale) fs.writeFileSync(outPath(kind), out[kind]);
  console.error('Записаны: ' + stale.map(k => path.relative(ROOT, outPath(k))).join(', '));
})().catch(e => { console.error(e && e.stack || e); process.exit(1); });
