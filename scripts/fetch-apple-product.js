#!/usr/bin/env node
'use strict';

// Выгрузка страницы товара apple.com/shop/product/… — фотографии галереи, цена в
// долларах и весь текст карточки (Overview, «What's in the Box», Tech Specs).
// Офлайн-инструмент для наполнения каталога: фото потом заливаются в карточку
// скриптом `scripts/import-product-photos.js`, витрина об этом скрипте не знает.
//
//   node scripts/fetch-apple-product.js <url> [<url> …]
//   node scripts/fetch-apple-product.js --list scripts/apple-accessories.txt --out apple-photos/accessories
//   node scripts/fetch-apple-product.js <url> --dry        # ничего не качать, только показать
//
// Ключи:
//   --out DIR    куда складывать (по умолчанию apple-photos/<слаг адреса>)
//   --list FILE  файл со списком адресов, по одному на строку; после адреса через
//                пробел можно указать id карточки каталога — он уедет в manifest,
//                и `scripts/import-product-photos.js` зальёт папку в эту карточку
//                без второй таблицы соответствий где-то ещё
//   --id ID      то же самое для одиночного адреса
//   --width N    длинная сторона кадра (по умолчанию 2000; наш пайплайн ужмёт до 1200)
//   --dry        не качать файлы, только разобрать страницу
//   --force      перекачать уже скачанное
//
// Чем это отличается от `fetch-apple-watch-photos.js`. Там buy-страница, на которой
// фотографий нет вовсе — кадры отдаёт отдельный API галереи по размерностям корпуса
// и ремешка. Здесь обычная страница товара: список кадров лежит прямо в разметке
// блоком JSON-LD `ImageGallery`, и у аксессуара их две-три штуки, а не сотни.
//
// **`.v` в адресе кадра выбрасывается вместе с правкой размера.** На buy-страницах
// это подпись под точный набор параметров, и с чужим размером Scene7 отвечает 404;
// здесь она ведёт себя как обычная версия файла, но полагаться на это незачем —
// без токена адрес отдаётся в любом размере одинаково.

const fs = require('fs');
const path = require('path');

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36';

function fail(msg) {
  console.error('Ошибка: ' + msg);
  process.exit(1);
}

// ────────────────────────────── аргументы ──────────────────────────────

function parseArgs(argv) {
  const o = { urls: [], out: '', list: '', id: '', width: 2000, dry: false, force: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--out') o.out = argv[++i] || '';
    else if (a === '--list') o.list = argv[++i] || '';
    else if (a === '--id') o.id = argv[++i] || '';
    else if (a === '--width') o.width = Number(argv[++i]) || 2000;
    else if (a === '--dry') o.dry = true;
    else if (a === '--force') o.force = true;
    else if (a.startsWith('--')) fail('неизвестный ключ ' + a);
    else o.urls.push({ url: a, product: '' });
  }
  if (o.id) {
    if (o.urls.length !== 1) fail('--id задаётся одному адресу; для списка пишите id второй колонкой');
    o.urls[0].product = o.id;
  }
  if (o.list) {
    const raw = fs.readFileSync(o.list, 'utf8');
    for (const line of raw.split('\n')) {
      const s = line.trim();
      if (!s || s.startsWith('#')) continue;
      const [url, product] = s.split(/\s+/);
      o.urls.push({ url, product: product || '' });
    }
  }
  if (!o.urls.length) fail('не задан ни один адрес товара');
  return o;
}

// ──────────────────────────────── сеть ─────────────────────────────────

async function getText(url) {
  const r = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'text/html,*/*' } });
  if (!r.ok) throw new Error(url + ' → HTTP ' + r.status);
  return r.text();
}

async function download(url, file) {
  const r = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'image/*' } });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  const buf = Buffer.from(await r.arrayBuffer());
  // Scene7 на негодный адрес отвечает не ошибкой, а пятнадцатью байтами тела —
  // без этой проверки в папку легли бы «картинки», которых нет.
  if (buf.length < 512) throw new Error('подозрительно маленький файл: ' + buf.length + ' байт');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.part';
  fs.writeFileSync(tmp, buf);
  fs.renameSync(tmp, file);
  return buf.length;
}

// ────────────────────────────── разметка ───────────────────────────────

const entities = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'" };
function unescapeHtml(s) {
  return String(s || '')
    .replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (m, code) => {
      if (entities[code]) return entities[code];
      if (code[0] === '#') {
        const n = code[1] === 'x' || code[1] === 'X' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
        return Number.isFinite(n) ? String.fromCodePoint(n) : m;
      }
      return m;
    });
}

// Текст узла: теги выбрасываем, пробелы схлопываем. Разделитель между тегами —
// пробел, а не пустота: иначе соседние <p> срастаются в одно слово.
const text = html => unescapeHtml(String(html || '').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();

function jsonLd(html) {
  const out = [];
  const re = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/g;
  let m;
  while ((m = re.exec(html))) {
    try { out.push(JSON.parse(m[1])); } catch (e) { /* чужой блок — не наша забота */ }
  }
  return out;
}

// Разделы «Product Information» и «Compatibility» размечены одинаково:
// <div class="rc-pdsection-panel Overview-panel …"> с заголовком в
// .rc-pdsection-title и содержимым в .rc-pdsection-mainpanel.
function sections(html) {
  const out = [];
  const re = /<div class="rc-pdsection-panel ([^"\s]+)-panel[^"]*"[\s\S]*?<h3 class="rc-pdsection-title"[^>]*>([\s\S]*?)<\/h3>([\s\S]*?)(?=<div class="rc-pdsection-panel |<\/li>)/g;
  let m;
  while ((m = re.exec(html))) {
    const body = m[3];
    const items = [];
    // Внутри главной панели идут подзаголовки h4 и абзацы/списки под ними.
    const partRe = /<h4[^>]*class="h4-para-title"[^>]*>([\s\S]*?)<\/h4>|<p[^>]*>([\s\S]*?)<\/p>|<li[^>]*>([\s\S]*?)<\/li>/g;
    let p;
    while ((p = partRe.exec(body))) {
      if (p[1] !== undefined) items.push({ kind: 'title', text: text(p[1]) });
      else items.push({ kind: 'line', text: text(p[2] !== undefined ? p[2] : p[3]) });
    }
    out.push({ key: m[1], title: text(m[2]), items: items.filter(x => x.text) });
  }
  return out;
}

// Меняем в готовом адресе только размер и качество: bgc, trim и формат заданы
// самой Apple, и собранный руками адрес дал бы кадр не в той подложке.
function scaleUrl(src, longSide) {
  let u;
  try { u = new URL(src); } catch (e) { return null; }
  const w = Number(u.searchParams.get('wid')) || 0;
  const h = Number(u.searchParams.get('hei')) || 0;
  if (w && h) {
    const k = longSide / Math.max(w, h);
    u.searchParams.set('wid', String(Math.max(1, Math.round(w * k))));
    u.searchParams.set('hei', String(Math.max(1, Math.round(h * k))));
  } else {
    u.searchParams.set('wid', String(longSide));
    u.searchParams.set('hei', String(longSide));
  }
  if (!/png/.test(u.searchParams.get('fmt') || '')) u.searchParams.set('qlt', '95');
  u.searchParams.delete('.v');
  return u.toString();
}

const slugOf = url => url.replace(/[?#].*$/, '').replace(/\/+$/, '').split('/').pop();

// ─────────────────────────────── разбор ────────────────────────────────

function parsePage(url, html) {
  const ld = jsonLd(html);
  const product = ld.find(x => x && x['@type'] === 'Product');
  const gallery = ld.find(x => x && x['@type'] === 'ImageGallery');
  if (!product) throw new Error('на странице нет JSON-LD Product — Apple поменяла разметку');

  const offer = [].concat(product.offers || [])[0] || {};
  const shots = [];
  const seen = new Set();
  for (const m of (gallery && gallery.associatedMedia) || []) {
    const src = m && m.contentUrl;
    if (!src || seen.has(src)) continue;
    seen.add(src);
    shots.push(src);
  }
  // Галереи может не оказаться вовсе — тогда остаётся главный кадр самого товара.
  if (!shots.length && product.image) shots.push(product.image);

  return {
    url,
    slug: slugOf(url),
    sku: String(offer.sku || ''),
    name: String(product.name || ''),
    price: Number(offer.price) || 0,
    currency: String(offer.priceCurrency || ''),
    breadcrumbs: (ld.find(x => x && x['@type'] === 'BreadcrumbList') || { itemListElement: [] })
      .itemListElement.map(x => (x.item && x.item.name) || x.name).filter(Boolean),
    sections: sections(html),
    shots,
  };
}

// ─────────────────────────────── главное ───────────────────────────────

async function one(item, opt) {
  const url = item.url;
  const html = await getText(url);
  const info = parsePage(url, html);
  info.product = item.product;
  const dir = path.resolve(opt.out || 'apple-photos', info.slug);

  console.log('\n' + info.name + '  [' + info.sku + ']' + (info.product ? ' → ' + info.product : ''));
  console.log('  ' + url);
  console.log('  цена: $' + info.price.toFixed(2) + ' · кадров: ' + info.shots.length);
  for (const s of info.sections) {
    console.log('  · ' + s.title + ': ' + s.items.map(i => (i.kind === 'title' ? '[' + i.text + ']' : i.text)).join(' | ').slice(0, 160));
  }

  const files = [];
  for (let i = 0; i < info.shots.length; i++) {
    const src = scaleUrl(info.shots[i], opt.width);
    if (!src) { console.log('  ! негодный адрес кадра: ' + info.shots[i]); continue; }
    const name = String(i + 1) + '.jpg';
    const file = path.join(dir, name);
    files.push({ file: name, src });
    if (opt.dry) continue;
    if (!opt.force && fs.existsSync(file)) { console.log('  = ' + name + ' (уже есть)'); continue; }
    const size = await download(src, file);
    console.log('  ✓ ' + name + ' · ' + Math.round(size / 1024) + ' КБ');
  }

  if (!opt.dry) {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'manifest.json'),
      JSON.stringify(Object.assign({}, info, { shots: undefined, images: files }), null, 2));
  }
  return info;
}

async function main() {
  const opt = parseArgs(process.argv.slice(2));
  console.log('Товаров: ' + opt.urls.length + (opt.dry ? ' (пробный прогон, ничего не качаем)' : ''));
  const done = [];
  for (const item of opt.urls) {
    try {
      done.push(await one(item, opt));
    } catch (e) {
      console.error('  ! ' + item.url + ' — ' + e.message);
    }
  }
  console.log('\nГотово: ' + done.length + ' из ' + opt.urls.length + '.');
}

main().catch(e => fail(e.stack || e.message));
