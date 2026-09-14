'use strict';
/* Перенос магазина на другой сервер: `scripts/export-store.js` →
 * `scripts/import-store.js`. Проверяется поведением — оба скрипта запускаются
 * как процессы на временных каталогах данных, — потому что правила здесь про
 * ФАЙЛЫ и про то, чего в архиве быть не должно. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const EXPORT = path.join(ROOT, 'scripts', 'export-store.js');
const IMPORT = path.join(ROOT, 'scripts', 'import-store.js');

function run(script, args, dir) {
  return execFileSync(process.execPath, [script].concat(args), {
    encoding: 'utf8', env: Object.assign({}, process.env, { STORE_DATA_DIR: dir })
  });
}
function runFails(script, args, dir) {
  try { run(script, args, dir); }
  catch (e) { return String(e.stderr || '') + String(e.stdout || ''); }
  assert.fail('ожидался отказ скрипта');
}
function tmpdir(t, name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), name));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
function touch(dir, name) { fs.writeFileSync(path.join(dir, 'uploads', name), name); }
const readJson = (dir, name) => JSON.parse(fs.readFileSync(path.join(dir, name + '.json'), 'utf8'));

/* Магазин, который уже торговал: товары с фото и уменьшенными копиями, отзывы
 * покупателей со снимком и превью, логотип и фотографии точки, заказы,
 * переписка со снимком, метрика и сирота в хранилище. */
function seedSource(dir) {
  fs.mkdirSync(path.join(dir, 'uploads'), { recursive: true });
  const write = (name, data) => fs.writeFileSync(path.join(dir, name + '.json'), JSON.stringify(data));
  write('settings', {
    storeName: 'Первый', tagline: 'Слоган', accentColor: '#ff2d55', currency: '₽',
    logoImage: 'logo.webp', storePhotos: ['shop1.webp'], storeAddress: 'г. Ноябрьск, пр. Мира, 88А',
    storeSinceYear: '2025', contactPhone: '+79991234567',
    legalInn: '123456789012', bankAccount: '40817810000000000001',
    telegramBotToken: 'бот', telegramChatId: '-100', chatChatId: '-200',
    alfabankEnabled: true, alfabankLogin: 'shop-api', alfabankPassword: 'секрет',
    ownPayEnabled: false, ownPayCard: '2200000000000000',
    aiApiKey: 'sk-общий', chatPrompt: 'инструкция', dadataToken: 'dadata', promoDefault: 'SALE',
    shipFromCity: 'Ноябрьск', siteDomains: ['spare.example'],
    adminUsername: 'admin', adminPasswordHash: 'хеш', sessionSecret: 's'.repeat(48)
  });
  write('products', [
    { id: 'a', name: 'A', category: 'C', price: 1000, images: ['a.webp', 'a2.webp'], colors: [], storages: [] },
    { id: 'b', name: 'B', category: 'C', price: 500, images: ['gone.webp'], colors: [], storages: [] }
  ]);
  write('reviews', [
    { id: 'r1', productId: 'a', rating: 5, status: 'approved', createdAt: 1, photos: ['rv.webp'], previews: { 'rv.webp': 'rv-t.webp' } },
    { id: 'demo-1', productId: 'a', rating: 4, status: 'approved', createdAt: 2, demo: true }
  ]);
  write('orders', [{ id: 'o1', number: '100001', createdAt: 1, items: [], total: 1 }]);
  write('chats', { chats: [{ id: 'c1', messages: [{ role: 'user', text: 'фото', at: 1, photos: ['chat.webp'] }] }] });
  write('analytics', { version: 3 });
  write('visitor-rules', []);
  for (const name of ['a.webp', 'a-c320.webp', 'a-c480.webp', 'a-c640.webp', 'a2.webp', 'rv.webp', 'rv-t.webp',
    'logo.webp', 'shop1.webp', 'chat.webp', 'orphan.webp']) touch(dir, name);
}

test('выгрузка берёт каталог, отзывы и файлы по ссылкам — без заказов, чата и сирот', t => {
  const src = tmpdir(t, 'store-src-');
  seedSource(src);
  const out = path.join(tmpdir(t, 'store-out-'), 'store.tgz');

  const preview = run(EXPORT, [], src);
  assert.match(preview, /товаров: 2/);
  assert.match(preview, /отзывов: 2/);
  assert.match(preview, /отсутствующие файлы: 1/, 'битая ссылка названа вслух');
  assert.match(preview, /gone\.webp/);
  assert.equal(fs.existsSync(out), false, 'без --out архив не пишется');

  const written = run(EXPORT, ['--out', out], src);
  assert.match(written, /Архив записан/);
  const list = execFileSync('tar', ['-tzf', out], { encoding: 'utf8' }).split('\n').map(l => l.replace(/^\.\//, '')).filter(Boolean);
  for (const must of ['store-export/manifest.json', 'store-export/products.json', 'store-export/reviews.json', 'store-export/settings.json',
    'store-export/uploads/a.webp', 'store-export/uploads/a-c320.webp', 'store-export/uploads/a-c640.webp', 'store-export/uploads/a2.webp',
    'store-export/uploads/rv.webp', 'store-export/uploads/rv-t.webp', 'store-export/uploads/logo.webp', 'store-export/uploads/shop1.webp']) {
    assert.ok(list.includes(must), 'в архиве нет ' + must);
  }
  for (const never of ['store-export/orders.json', 'store-export/chats.json', 'store-export/analytics.json', 'store-export/visitor-rules.json',
    'store-export/uploads/chat.webp', 'store-export/uploads/orphan.webp', 'store-export/uploads/gone.webp']) {
    assert.ok(!list.includes(never), 'в архив попало лишнее: ' + never);
  }
  // Промежуточный каталог убран за собой, файлы источника целы.
  assert.deepEqual(fs.readdirSync(src).filter(n => n.startsWith('export-')), []);
  assert.equal(fs.readFileSync(path.join(src, 'uploads', 'a.webp'), 'utf8'), 'a.webp');
});

test('заливка на новый сервер сбрасывает то, что делает магазин этим магазином, и не пишет без --apply', t => {
  const src = tmpdir(t, 'store-src-');
  seedSource(src);
  const out = path.join(tmpdir(t, 'store-out-'), 'store.tgz');
  run(EXPORT, ['--out', out], src);

  // Свежий сервер: каталога данных ещё нет вовсе.
  const dst = tmpdir(t, 'store-dst-');
  const preview = run(IMPORT, [out], dst);
  assert.match(preview, /Ничего не записано/);
  assert.match(preview, /кассы и свои реквизиты: .*alfabankLogin/);
  assert.equal(fs.existsSync(path.join(dst, 'products.json')), false);

  const done = run(IMPORT, [out, '--apply'], dst);
  assert.match(done, /Готово: товаров 2, отзывов 2/);
  assert.deepEqual(readJson(dst, 'products').map(p => p.id), ['a', 'b']);
  assert.deepEqual(readJson(dst, 'reviews').map(r => r.id), ['r1', 'demo-1']);

  const s = readJson(dst, 'settings');
  // Идентифицирующее — сброшено до значений по умолчанию.
  assert.equal(s.storeName, 'iStore');
  assert.equal(s.logoImage, null);
  assert.deepEqual(s.storePhotos === undefined ? [] : s.storePhotos, []);
  assert.equal(s.storeAddress, '');
  assert.equal(s.storeSinceYear, '');
  assert.equal(s.contactPhone, '');
  assert.equal(s.legalInn, '');
  assert.equal(s.bankAccount, '');
  assert.equal(s.telegramBotToken, '');
  assert.equal(s.chatChatId, '');
  assert.equal(s.alfabankEnabled, false);
  assert.equal(s.alfabankLogin, '');
  assert.equal(s.ownPayCard, '');
  // Общее у сайтов одного владельца — едет.
  assert.equal(s.aiApiKey, 'sk-общий');
  assert.equal(s.chatPrompt, 'инструкция');
  assert.equal(s.dadataToken, 'dadata');
  assert.equal(s.shipFromCity, 'Ноябрьск');
  assert.equal(s.accentColor, '#ff2d55');
  assert.equal(s.adminPasswordHash, 'хеш', 'учётка панели едет: владелец тот же');
  // Серверное — никогда.
  assert.deepEqual(s.siteDomains, []);
  assert.notEqual(s.sessionSecret, 's'.repeat(48));
  assert.equal(s.sessionSecret.length, 48);

  // Файлы — по ссылкам ИТОГОВЫХ данных: логотип и фото точки сброшены, их нет.
  const files = fs.readdirSync(path.join(dst, 'uploads')).sort();
  assert.deepEqual(files, ['a-c320.webp', 'a-c480.webp', 'a-c640.webp', 'a.webp', 'a2.webp', 'rv-t.webp', 'rv.webp']);
  assert.deepEqual(fs.readdirSync(dst).filter(n => n.startsWith('import-')), [], 'временный каталог убран');
  // Ни заказов, ни чата, ни метрики с собой не привезли.
  for (const name of ['orders', 'chats', 'analytics', 'visitor-rules']) assert.equal(fs.existsSync(path.join(dst, name + '.json')), false);
});

test('поверх торговавшего магазина заливка идёт только с --force, а --keep-settings везёт настройки как есть', t => {
  const src = tmpdir(t, 'store-src-');
  seedSource(src);
  const out = path.join(tmpdir(t, 'store-out-'), 'store.tgz');
  run(EXPORT, ['--out', out], src);

  // Сервер после первого запуска: демо-каталог и демо-отзывы заменить можно.
  const fresh = tmpdir(t, 'store-fresh-');
  fs.mkdirSync(path.join(fresh, 'uploads'));
  fs.writeFileSync(path.join(fresh, 'products.json'), JSON.stringify([{ id: 'demo', name: 'Демо', category: 'C', price: 1 }]));
  fs.writeFileSync(path.join(fresh, 'reviews.json'), JSON.stringify([{ id: 'demo-x', productId: 'demo', rating: 5, demo: true }]));
  fs.writeFileSync(path.join(fresh, 'orders.json'), '[]');
  fs.writeFileSync(path.join(fresh, 'settings.json'), JSON.stringify({ storeName: 'iStore', sessionSecret: 'f'.repeat(48), adminPasswordHash: 'свой' }));
  run(IMPORT, [out, '--apply'], fresh);
  assert.deepEqual(readJson(fresh, 'products').map(p => p.id), ['a', 'b']);

  // А вот заказы — след живого магазина.
  const busy = tmpdir(t, 'store-busy-');
  fs.mkdirSync(path.join(busy, 'uploads'));
  fs.writeFileSync(path.join(busy, 'orders.json'), JSON.stringify([{ id: 'o', number: '1', createdAt: 1, items: [], total: 1 }]));
  fs.writeFileSync(path.join(busy, 'products.json'), '[]');
  fs.writeFileSync(path.join(busy, 'reviews.json'), '[]');
  const refusal = runFails(IMPORT, [out, '--apply'], busy);
  assert.match(refusal, /уже торговали/);
  assert.match(refusal, /заказов: 1/);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(busy, 'products.json'), 'utf8')), [], 'без --force не тронуто');

  const forced = run(IMPORT, [out, '--apply', '--force', '--keep-settings'], busy);
  assert.match(forced, /Готово/);
  const s = readJson(busy, 'settings');
  assert.equal(s.storeName, 'Первый', '--keep-settings: название как было');
  assert.equal(s.alfabankLogin, 'shop-api', '--keep-settings: ключи кассы как были');
  assert.equal(s.logoImage, 'logo.webp');
  assert.deepEqual(s.siteDomains, [], 'домены — свойство сервера, не едут даже так');
  assert.notEqual(s.sessionSecret, 's'.repeat(48), 'секрет сессии всегда свой');
  assert.ok(fs.existsSync(path.join(busy, 'uploads', 'logo.webp')), 'логотип остался в ссылках — приехал');
  assert.ok(fs.existsSync(path.join(busy, 'uploads', 'shop1.webp')));
  // Заказы этого сервера заливка не трогает — они его, а не чужие.
  assert.equal(readJson(busy, 'orders').length, 1);
});

test('что считать ссылкой на файл, решает одно место — db.usedUploads', () => {
  const db = fs.readFileSync(path.join(ROOT, 'lib', 'db.js'), 'utf8');
  assert.match(db, /function usedUploads\(products, reviews, settings, savedChats\)/);
  assert.match(db, /const used = usedUploads\(products, reviews, settings, savedChats\);/, 'уборка спрашивает ту же функцию');
  const exp = fs.readFileSync(EXPORT, 'utf8');
  assert.match(exp, /db\.usedUploads\(products, reviews, settings, null\)/, 'выгрузка — тоже, без чата');
  assert.match(exp, /IMG\.derivedNames\(name\)/, 'уменьшенные копии едут за исходником');
  const imp = fs.readFileSync(IMPORT, 'utf8');
  assert.match(imp, /require\('\.\/export-store'\)/, 'заливка берёт список файлов у выгрузки, а не считает свой');
  const { SITE_FIELDS, SERVER_FIELDS } = require('../scripts/import-store');
  const all = Object.values(SITE_FIELDS).flat();
  // Каждое поле из списка сброса существует в настройках по умолчанию —
  // опечатка в имени означала бы, что секрет молча уехал на чужой сайт.
  const defaults = require('../lib/db').defaultSettings();
  for (const key of all.concat(SERVER_FIELDS)) assert.ok(key in defaults, 'в настройках нет поля ' + key);
  for (const key of ['crocopayClientSecret', 'meridianpayApiKey', 'alfabankPassword', 'alfabankToken', 'ownPayCard', 'telegramBotToken', 'bankAccount']) {
    assert.ok(all.includes(key), 'деньги и ключи обязаны сбрасываться: ' + key);
  }
});

test('перенос каталога идёт через Tor частями, по своей цепочке каждая, с докачкой и сверкой', () => {
  // Один scp на 2,4 ГБ по одной цепочке Tor — 140 КБ/с и обрыв с нуля (14 сентября 2026).
  const clone = fs.readFileSync(path.join(ROOT, 'deploy', 'clone-data.sh'), 'utf8');
  assert.match(clone, /tor-socks\.py/, 'части едут через ProxyCommand с логином SOCKS — свою цепочку Tor на каждую');
  assert.match(clone, /split -n \$JOBS/, 'архив режется на части');
  assert.match(clone, /rsync --partial --append/, 'обрыв докачивается с места, а не с нуля');
  assert.match(clone, /setsid nohup[^\n]*export-store\.js/, 'экспорт отвязан от SSH-сессии');
  assert.match(clone, /setsid nohup[\s\S]{0,200}import-store\.js[^\n]*--apply/, 'заливка отвязана от SSH-сессии: сорвавшаяся сессия не оставит её на половине');
  assert.match(clone, /sha256sum '\$REMOTE'/, 'сумма архива сверяется на обоих концах');
  assert.doesNotMatch(clone, /^\s*scp\b/m, 'одного scp на весь архив быть не должно');
  // Серверы друг друга не касаются: всё едет через ноутбук.
  assert.doesNotMatch(clone, /"\$FROM:[^"]*"\s+"\$TO:/, 'архив не идёт с сервера на сервер напрямую');
  const proxy = fs.readFileSync(path.join(ROOT, 'deploy', 'tor-socks.py'), 'utf8');
  assert.match(proxy, /TOR_SOCKS/, 'адрес SOCKS — переменная, по умолчанию Tor Browser');
  assert.match(proxy, /127\.0\.0\.1:9150/, 'по умолчанию — SOCKS Tor Browser');
  assert.match(proxy, /x01\\x02/, 'метод SOCKS5 с логином — им и изолируются цепочки');
  assert.doesNotMatch(proxy, /create_connection\(\(host/, 'прямого подключения мимо Tor у прокси-команды нет');
});

test('выкатка заливает на сервер только то, что знает git', () => {
  const install = fs.readFileSync(path.join(ROOT, 'deploy', 'install.sh'), 'utf8');
  assert.match(install, /git ls-files -z --cached --others --exclude-standard/);
  assert.match(install, /tar --no-xattrs --null -T - -czf -/);
  assert.doesNotMatch(install, /--exclude='\.\/data'/, 'ручного списка исключений больше нет — он в .gitignore');
  const ignore = fs.readFileSync(path.join(ROOT, '.gitignore'), 'utf8');
  for (const dir of ['data/', '.claude/', 'apple_svg/', 'apple-photos/', 'tmp/', 'output/']) {
    assert.ok(ignore.split('\n').includes(dir), '.gitignore обязан знать ' + dir);
  }
  // Список сайтов и выкатка на все разом. Сам список локальный: домены разных
  // магазинов не должны стоять рядом в открытом репозитории — в git только образец.
  const all = fs.readFileSync(path.join(ROOT, 'deploy', 'deploy-all.sh'), 'utf8');
  assert.match(all, /sites\.txt/);
  assert.match(all, /sites\.example\.txt/, 'без списка скрипт показывает, откуда его взять');
  assert.match(all, /install\.sh/);
  assert.ok(ignore.split('\n').includes('deploy/sites.txt'), 'настоящий список сайтов в git не идёт');
  assert.ok(!fs.existsSync(path.join(ROOT, '.git')) || !require('child_process').execSync('git ls-files deploy/sites.txt', { cwd: ROOT }).toString().trim(),
    'deploy/sites.txt не должен быть на учёте git');
  const example = fs.readFileSync(path.join(ROOT, 'deploy', 'sites.example.txt'), 'utf8');
  assert.match(example, /^#\s+<ssh-алиас>\s+<домен>\s*$/m, 'образец описывает формат строки');
  assert.doesNotMatch(example, /^[^#\s]\S*\s+\S+\.\S+/m, 'в образце нет ни одного настоящего сайта');
});
