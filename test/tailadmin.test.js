'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const views = require('../lib/admin-views');
const TA = require('../lib/tailadmin');
const root = path.join(__dirname, '..');

test('TailAdmin: сохранённые файлы совпадают с оригинальными исходниками', () => {
  const manifest = require('../vendor/tailadmin/upstream.json');
  assert.equal(manifest.repository, 'https://github.com/TailAdmin/tailadmin-free-tailwind-dashboard-template');
  for (const [file, expected] of Object.entries(manifest.files)) {
    const contents = fs.readFileSync(path.join(root, 'vendor/tailadmin/upstream', file));
    assert.equal(createHash('sha256').update(contents).digest('hex'), expected, file);
  }
  const license = fs.readFileSync(path.join(root, 'public/tailadmin.LICENSE.txt'), 'utf8');
  assert.match(license, /MIT License/);
  assert.match(license, /TailAdmin/);
});

test('TailAdmin: компоненты не содержат действий из демо и не требуют Alpine', () => {
  const templates = require('../public/tailadmin-components.json');
  for (const name of ['sidebar', 'header', 'metric', 'recentOrders', 'signin']) {
    assert.ok(templates[name].length > 100, name);
    assert.match(templates[name], /data-tailadmin-component=/);
  }
  for (const html of Object.values(templates)) {
    assert.doesNotMatch(html, /(?:x-data|x-text|x-show|@click|:class)=/);
    assert.doesNotMatch(html, /Purchase Plan|info@gmail.com|href="https?:|src="https?:|signup\.html|reset-password\.html/);
  }
  assert.doesNotMatch(fs.readFileSync(path.join(root, 'public/tailadmin.css'), 'utf8'), /fonts\.googleapis|@import/);
});

test('TailAdmin: имя магазина экранируется, подстановка слотов не рекурсивна', () => {
  const login = views.loginPage({ storeName: '<img src=x onerror=alert(1)>@@ERROR@@' }, null);
  assert.doesNotMatch(login, /<img src=x/);
  assert.match(login, /&lt;img src=x onerror=alert\(1\)&gt;@@ERROR@@/);
  assert.equal((login.match(/name="username"/g) || []).length, 1);
  assert.equal((login.match(/name="password"/g) || []).length, 1);
  assert.match(login, /method="post" action="\/admin\/login"/);
  assert.throws(() => TA.render('metric', {}), /missing ICON/);
});

test('TailAdmin: ряды продаж сохраняют оплаченные суммы и московскую границу дня', () => {
  const { salesSeries } = require('../lib/admin-charts');
  const now = Date.parse('2026-09-22T10:00:00Z');
  const rows = [
    { createdAt: Date.parse('2026-09-21T20:59:59Z'), total: 100, payment: { status: 'paid' } },
    { createdAt: Date.parse('2026-09-21T21:00:00Z'), total: 200, manualPaid: true },
    { createdAt: Date.parse('2026-09-22T08:00:00Z'), total: 300, payment: { status: 'refunded' } },
    { createdAt: now + 10000, total: 999, payment: { status: 'paid' } },
    { createdAt: 'wrong', total: 999 }
  ];
  const data = salesSeries(rows, 2, now);
  assert.deepEqual(data.total, [100, 500]);
  assert.deepEqual(data.revenue, [100, 200]);
  assert.deepEqual(data.count, [1, 2]);
  const year = salesSeries([{ createdAt: now - 364 * 86400000, total: 500, manualPaid: true }], 365, now);
  assert.equal(year.revenue.reduce((a, b) => a + b), 500, 'не теряется неполный месяц на начале годового периода');
  assert.deepEqual(salesSeries([], 1, now).count, [0]);
});

test('TailAdmin: данные графика безопасны, а все исходные блоки обзора присутствуют', () => {
  const dangerous = '</div><script>alert(1)</script>';
  const chart = TA.chart('barChart', 'test', { labels: [dangerous], series: [{ name: 'Заказы', data: [0] }] }, { TITLE: 'Проверка', CONTROLS: '' });
  assert.doesNotMatch(chart, /<script>alert/);
  assert.match(chart, /&lt;script&gt;/);
  const templates = require('../public/tailadmin-components.json');
  for (const slot of ['METRICS','BAR','RADIAL','AREA','ACTIVITY','RECENT']) assert.ok(templates.dashboard.includes('@@' + slot + '@@'), slot);
  assert.match(templates.recentOrders, /<thead/);
  assert.match(templates.recentOrders, /@@ROWS@@/);
  assert.match(templates.themeToggle, /data-ta-theme/);
  assert.match(templates.profileMenu, /<details/);
});

test('TailAdmin: тема восстанавливается до отрисовки и не требует доступного localStorage', () => {
  const vm = require('node:vm');
  for (const value of ['true', 'false', null]) {
    const states = {};
    const context = { document: { documentElement: { classList: { toggle: (key, value) => { states[key] = value; } } } }, localStorage: { getItem: key => key === 'darkMode' ? value : 'false' } };
    vm.runInNewContext(TA.themeBoot.replace(/<\/?script>/g, ''), context);
    assert.equal(states.dark, value === 'true');
  }
  assert.doesNotThrow(() => vm.runInNewContext(TA.themeBoot.replace(/<\/?script>/g, ''), { localStorage: { getItem() { throw new Error('blocked'); } } }));
});

/* ---------------- Аудит 22 сентября 2026: то, что ломалось на бою ---------------- */

const SETTINGS = { storeName: 'Магазин', currency: '₽', currencyPosition: 'after' };
function fakeDb(orders, products) {
  return {
    getOrders: () => orders, visibleOrders: () => orders,
    getProducts: () => products || [], visibleProducts: () => products || [],
    getProduct: id => (products || []).find(p => p.id === id) || null,
    pendingReviewCount: () => 0, UPLOAD_DIR: path.join(root, 'data/uploads')
  };
}
const ORDER = { id: 'a1b2c3d4e5f60718', number: '700101', customerName: 'Анна', createdAt: Date.now(),
  total: 1000, items: [{ id: 'iphone-17-pro', name: 'iPhone 17 Pro', price: 1000, qty: 1 }], payment: null, payMode: 'own' };

test('TailAdmin: в живом блоке списка заказов нет noscript, а морфинг его не трогает', () => {
  // На бою любое живое обновление списка заказов раскрывало все закрытые
  // <dialog> прямо в таблице: DOMParser разбирает <noscript> как элементы, и
  // морфинг вставлял в страницу настоящий <style> «без JS».
  const html = views.ordersList(SETTINGS, fakeDb([ORDER]), null, 1, false, {});
  const content = html.slice(html.indexOf('data-live-part="content"'), html.indexOf('</main>'));
  assert.doesNotMatch(content, /<noscript/);
  assert.match(html.slice(0, html.indexOf('<body')), /<noscript><style>[^<]*\.ta-order-dialog\{display:block;position:static/);
  const live = fs.readFileSync(path.join(root, 'public/admin-live.js'), 'utf8');
  assert.match(live, /from\.tagName === 'NOSCRIPT'\) return;/);
});

test('TailAdmin: сводка показывает одну плашку состояния, строки заказа несут фото товара', () => {
  const R = require('../lib/render');
  const paid = { ...ORDER, manualPaid: { at: Date.now(), by: 'test' } };
  assert.match(R.orderStatus(paid, undefined, { short: true }), /^<span class="pay-tag pay-ok"><i><\/i>[^<]+<\/span>$/);
  assert.match(R.orderStatus(paid), /o-when/);
  const products = [{ id: 'iphone-17-pro', name: 'iPhone 17 Pro', price: 1000, images: ['photo.webp'] }];
  const dash = views.dashboard(SETTINGS, fakeDb([paid], products), { online: 0 });
  const recent = dash.slice(dash.indexOf('ta-recent'));
  assert.match(recent, /<img[^>]+\/uploads\/photo\.webp/);
  assert.doesNotMatch(recent.slice(0, recent.indexOf('</table>')), /o-when/);
  assert.match(recent, /class="[^"]*ta-status-cell/);
  const list = views.ordersList(SETTINGS, fakeDb([paid], products), null, 1, false, {});
  assert.match(list, /ta-product-cell"><img[^>]+\/uploads\/photo\.webp/);
  assert.match(list, /ta-actions-cell/);
  // Без фото — прежний значок, а не пустой квадрат.
  assert.match(views.ordersList(SETTINGS, fakeDb([paid]), null, 1, false, {}), /ta-product-cell"><span class="ta-product-symbol">/);
});

test('TailAdmin: ночная тема покрывает форму товара, отзывы и остальные светлые поверхности admin.css', () => {
  const CR = require('../lib/css-rules');
  const admin = fs.readFileSync(path.join(root, 'public/admin.css'), 'utf8');
  const dark = fs.readFileSync(path.join(root, 'public/tailadmin.css'), 'utf8');
  const light = /background(?:-color)?\s*:\s*(#fff\b|#ffffff|white|#f[0-9a-f]{2,5}\b|rgba?\(255)/i;
  const missing = new Set();
  for (const { node } of CR.flatten(CR.parse(admin))) {
    if (node.type !== 'rule' || !node.body || !light.test(node.body)) continue;
    for (const selector of CR.splitSelectors(node.selector)) {
      // Ключ — последний класс селектора либо его id: `#color-add` побеждает
      // любой класс, и ночная пара обязана называть его по имени.
      const classes = selector.match(/[.#][a-zA-Z0-9_-]+/g) || [];
      const key = classes[classes.length - 1];
      // `.a-topbar` и `.login-card` панель TailAdmin не рисует, `.chat-item::after`
      // и оранжевая `.img-main` — акценты, одинаковые в обеих темах.
      if (!key || ['.a-topbar', '.login-card', '.chat-item', '.img-main'].includes(key)) continue;
      // Ночная пара — либо своё правило `html.dark …`, либо dark-вариант
      // Tailwind из bridge.css (компилируется в `…:is(.dark *)`).
      const escaped = key.replace(/^[.#]/, m => '\\' + m);
      if (!new RegExp('html\\.dark[^{]*' + escaped + '(?![\\w-])').test(dark)
        && !new RegExp(escaped + '(?![\\w-])[^{]*:is\\(\\.dark \\*\\)').test(dark)) missing.add(key);
    }
  }
  assert.deepEqual([...missing], [], 'светлые поверхности без ночной пары');
  for (const key of ['.form-section', '.form-actions-bar', '.rv-row', '.a-sort.active']) {
    assert.match(dark, new RegExp('html\\.dark body\\.admin[^{]*' + key.replace(/\./g, '\\.') + '(?![\\w-])'), key);
  }
});

test('TailAdmin: мобильная шапка как в оригинале — бренд и «⋯», ряд действий скрыт до нажатия', () => {
  const templates = require('../public/tailadmin-components.json');
  assert.match(templates.headerBrand, /^<a href="\/admin" class="ta-header-brand xl:hidden">@@BRAND@@<\/a>$/);
  assert.match(templates.actionsToggle, /data-ta-actions=""[^>]*aria-expanded="false"[^>]*aria-controls="ta-header-actions"/);
  assert.match(templates.header, /id="ta-header-actions"/);
  const css = fs.readFileSync(path.join(root, 'public/tailadmin.css'), 'utf8');
  assert.match(css, /@media\(max-width:1279px\)\{[^}]*\n?[\s\S]*?body\.admin \.ta-header-actions\{display:none/);
  assert.match(css, /html\.ta-actions-open body\.admin \.ta-header-actions\{display:flex\}/);
  assert.doesNotMatch(css, /\.ta-profile>span:last-child/);
  const ui = fs.readFileSync(path.join(root, 'public/tailadmin-ui.js'), 'utf8');
  assert.match(ui, /closest\('\[data-ta-actions\]'\)/);
  assert.match(ui, /classList\.toggle\('ta-actions-open'\)/);
  const html = views.dashboard(SETTINGS, fakeDb([]), { online: 0 });
  assert.match(html, /ta-header-brand xl:hidden">Магазин<\/a>/);
});

test('TailAdmin: выход из панели есть в меню профиля, одна гарнитура Roboto, ось штук целая', () => {
  const templates = require('../public/tailadmin-components.json');
  assert.match(templates.profileMenu, /<form method="post" action="\/admin\/logout" class="ta-profile-logout"><button class="[^"]*" type="submit">[\s\S]*Выйти<\/span>\s*<\/button><\/form>/);
  assert.match(templates.profileMenu, /href="\/admin\/settings"[\s\S]*Настройки<\/span>/);
  const css = fs.readFileSync(path.join(root, 'public/tailadmin.css'), 'utf8');
  assert.doesNotMatch(css, /Outfit/);
  assert.match(css, /body\.admin\{[^}]*font-family:Roboto,sans-serif/);
  assert.ok(!fs.existsSync(path.join(root, 'public/fonts/outfit-latin-wght-normal.woff2')));
  const charts = fs.readFileSync(path.join(root, 'vendor/tailadmin/charts.js'), 'utf8');
  assert.match(charts, /fontFamily = 'Roboto, sans-serif'/);
  assert.match(charts, /options\.yaxis\.tickAmount = 5/);
  assert.match(charts, /number\(Math\.round\(value\)\)/);
});

test('в настройках нет подсказок, а раздел отвечает на один вопрос', () => {
  /* Просьба владельца 22 сентября 2026: «слишком много всего в кучу». Абзацы
   * под полями объясняли то, что поле и так говорит подписью и плейсхолдером:
   * их читают один раз, а видят каждый день. Факт, которого иначе не узнать,
   * переехал в саму подпись, а Callback URL кассы — в поле с кнопкой. */
  const html = views.settingsPage({ storeName: 'iStore', adminUsername: 'admin', plategaEnabled: true },
    fakeDb([]), null, 'ok', { origin: 'https://shop.example' });
  const start = html.indexOf('<form class="a-form a-settings"');
  const form = html.slice(start, html.indexOf('</form>', start));
  assert.doesNotMatch(form, /class="field-hint"/);
  assert.doesNotMatch(form, /class="muted small"/);
  // Подписи взяли на себя то, что раньше объясняли абзацы.
  assert.match(form, /Фотографии, до \d+</);
  assert.match(form, /Дополнительные домены, по одному в строке \(до \d+\)</);
  assert.match(form, /Новый пароль, от 10 знаков</);
  assert.match(form, /буквы в \{фигурных скобках\} красятся акцентом/);
  // Callback копируют, а не читают.
  assert.match(form, /<button class="btn btn-sm" type="button" data-copy="https:\/\/shop\.example\/api\/pay\/platega\/callback">Скопировать<\/button>/);
  // Состояние — не подсказка и остаётся.
  assert.match(form, /class="set-note"/);
  assert.match(form, /class="pay-mode/);
});

test('TailAdmin: на телефоне строки заказов складываются в карточки, статус переносится', () => {
  const css = fs.readFileSync(path.join(root, 'public/tailadmin.css'), 'utf8');
  const mobile = css.slice(css.indexOf('body.admin .ta-orders-table,body.admin .ta-orders-table tbody{display:block'));
  assert.match(mobile, /\.ta-orders-table thead\{display:none\}/);
  assert.match(mobile, /\.ta-orders-table tbody tr\{display:grid/);
  assert.match(mobile, /td\.ta-actions-cell \.ta-order-open\{width:100%\}/);
  assert.match(css, /td\.ta-status-cell\{white-space:normal/);
});
