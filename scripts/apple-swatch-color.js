#!/usr/bin/env node
'use strict';

// Цвет кружка варианта — по кадру самого товара с apple.com, а не на глаз.
//
//   node scripts/apple-swatch-color.js MGFL4ZM/A MHVQ4ZM/A     # по артикулу
//   node scripts/apple-swatch-color.js <адрес кадра>           # по любому кадру
//   node scripts/apple-swatch-color.js --list swatches.json     # пачкой
//
// Зачем. У чехлов и ремешков в каталоге есть кружок цвета (`colors[].hex`), и
// подобранный по названию («Terra Cotta» — это какой?) он всегда мимо: у Apple
// это конкретный оттенок конкретного изделия. Тот же приём уже применялся к
// ремешкам Hermès — «цвета сняты с самих апловских образцов».
//
// **По артикулу берётся ОФИЦИАЛЬНЫЙ ОБРАЗЕЦ ЦВЕТА, а не кадр товара.** У Scene7
// рядом с кадрами лежит `<АРТИКУЛ>_SW_COLOR` — тот самый кружок, который Apple
// показывает в выборе цвета. Замер по кадру товара работает, но врёт там, где
// первым в галерее идёт не сам товар: у бампера iPhone Air так намерялись три
// почти одинаковых голубоватых оттенка вместо голубого, серого и песочного, а
// «Soft Pink» вышел тёмно-серым.
//
// Как считается. Берётся маленький PNG (64×64), из него выбрасываются края и
// белый фон, а по оставшимся пикселям берётся МЕДИАНА по каждому каналу.
// Медиана, а не среднее: на кадре есть блик и тень, и среднее уводит цвет в
// сторону того, чего на изделии нет. PNG выбран потому, что распаковывается
// силами самого Node (zlib + снятие фильтров), без единой зависимости, — JPEG
// так не прочитать.

const zlib = require('zlib');

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36';
const SIZE = 64;          // кадр для замера: больше не нужно, мельче — шумит
const WHITE = 238;        // ярче этого по всем каналам — фон студии, не товар
const EDGE = 0.18;        // доля кадра с краю, которую не смотрим вовсе

function fail(msg) {
  console.error('Ошибка: ' + msg);
  process.exit(1);
}

// ───────────────────────────── чтение PNG ──────────────────────────────

// Ровно столько, сколько нужно нам: 8-битный truecolor с альфой и без неё,
// без интерлейса. Чужие PNG сюда не попадают — адрес собираем мы сами.
function decodePng(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('это не PNG');
  let pos = 8, width = 0, height = 0, depth = 0, type = 0;
  const idat = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const tag = buf.toString('latin1', pos + 4, pos + 8);
    const body = buf.slice(pos + 8, pos + 8 + len);
    if (tag === 'IHDR') {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      depth = body[8];
      type = body[9];
      if (body[12] !== 0) throw new Error('интерлейс не поддерживается');
    } else if (tag === 'IDAT') idat.push(body);
    else if (tag === 'IEND') break;
    pos += 12 + len;
  }
  // 2 — RGB, 6 — RGBA, 0 — серый (у белых образцов Scene7 отдаёт именно его).
  if (depth !== 8 || (type !== 0 && type !== 2 && type !== 6)) {
    throw new Error('нужен 8-битный RGB(A) или серый, а пришёл тип ' + type + '/' + depth);
  }
  const ch = type === 6 ? 4 : (type === 0 ? 1 : 3);
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const out = Buffer.alloc(width * height * ch);
  const stride = width * ch;
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const line = raw.slice(y * (stride + 1) + 1, y * (stride + 1) + 1 + stride);
    for (let x = 0; x < stride; x++) {
      const a = x >= ch ? out[y * stride + x - ch] : 0;          // слева
      const b = y > 0 ? out[(y - 1) * stride + x] : 0;           // сверху
      const c = x >= ch && y > 0 ? out[(y - 1) * stride + x - ch] : 0;
      let v = line[x];
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) {                                    // Paeth
        const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        v += (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c);
      }
      out[y * stride + x] = v & 255;
    }
  }
  return { width, height, ch, data: out };
}

// ─────────────────────────────── замер ─────────────────────────────────

const median = arr => { const s = arr.slice().sort((a, b) => a - b); return s[s.length >> 1]; };
const hex = (r, g, b) => '#' + [r, g, b].map(v => v.toString(16).padStart(2, '0')).join('');

function colorOf(img) {
  const { width: w, height: h, ch, data } = img;
  const x0 = Math.round(w * EDGE), x1 = w - x0, y0 = Math.round(h * EDGE), y1 = h - y0;
  const R = [], G = [], B = [], allR = [], allG = [], allB = [];
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = (y * w + x) * ch;
      const r = data[i], g = ch === 1 ? data[i] : data[i + 1], b = ch === 1 ? data[i] : data[i + 2];
      if (ch === 4 && data[i + 3] < 200) continue;   // прозрачное — не товар
      allR.push(r); allG.push(g); allB.push(b);
      if (r > WHITE && g > WHITE && b > WHITE) continue;
      R.push(r); G.push(g); B.push(b);
    }
  }
  // Белый бывает и самим цветом («Frost», «White»), поэтому отсев фона — это
  // предпочтение, а не условие: не осталось ничего — меряем что есть.
  const [r, g, b] = R.length ? [R, G, B] : [allR, allG, allB];
  if (!r.length) return { hex: '', pixels: 0 };
  return { hex: hex(median(r), median(g), median(b)), pixels: r.length, plain: !R.length };
}

// «MGFL4ZM/A» → адрес официального образца цвета. Хвост артикула (ZM/A, LL/A)
// у картинок Scene7 отброшен: там живёт только его первая часть.
const SKU = /^[A-Z0-9]{5,6}[A-Z]{2}\/[A-Z]$/;
function swatchUrl(sku) {
  const base = sku.split('/')[0].replace(/(ZM|LL|AM|FE|ZA)$/, '');
  return 'https://store.storeimages.cdn-apple.com/1/as-images.apple.com/is/' +
    base + '_SW_COLOR?wid=' + SIZE + '&hei=' + SIZE + '&fmt=png';
}

function shotUrl(src) {
  if (SKU.test(src)) return swatchUrl(src);
  const u = new URL(src);
  u.searchParams.set('wid', String(SIZE));
  u.searchParams.set('hei', String(SIZE));
  u.searchParams.set('fmt', 'png');
  // `.v` — подпись под точный набор параметров у одних страниц и обычная версия
  // у других; с изменённым размером её надо выбрасывать всегда (см. выгрузку).
  u.searchParams.delete('.v');
  return u.toString();
}

async function measure(src) {
  const r = await fetch(shotUrl(src), { headers: { 'User-Agent': UA, Accept: 'image/png' } });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return colorOf(decodePng(Buffer.from(await r.arrayBuffer())));
}

// У товаров прошлых поколений образца `_SW_COLOR` в Scene7 уже нет (404).
// Тогда меряем по кадру самого товара — он хуже (первым в галерее бывает сцена,
// а не изделие), поэтому такой замер помечается в выводе.
async function measureWithFallback(it) {
  try {
    return await measure(it.src);
  } catch (e) {
    if (!it.fallback) throw e;
    const out = await measure(it.fallback);
    return Object.assign({}, out, { fallback: true });
  }
}

async function main() {
  const argv = process.argv.slice(2);
  let items = [];
  if (argv[0] === '--list') {
    const raw = JSON.parse(require('fs').readFileSync(argv[1], 'utf8'));
    items = raw.map(x => (typeof x === 'string' ? { label: x, src: x } : x));
  } else {
    items = argv.map(a => ({ label: a, src: a }));
  }
  if (!items.length) fail('нечего мерить: дайте адрес кадра или --list файл.json');

  for (const it of items) {
    try {
      const { hex: value, pixels, fallback, plain } = await measureWithFallback(it);
      const note = (fallback ? '  (образца нет — по кадру товара)' : '') + (plain ? '  (сплошной светлый)' : '');
      console.log((value || '—') + '  ' + (it.label || '') + (pixels ? '' : '  (пусто)') + note);
    } catch (e) {
      console.log('—  ' + (it.label || '') + '  ошибка: ' + e.message);
    }
  }
}

main().catch(e => fail(e.stack || e.message));
