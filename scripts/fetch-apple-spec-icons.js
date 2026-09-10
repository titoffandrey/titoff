#!/usr/bin/env node
'use strict';

// Выгрузка ГЛИФОВ ХАРАКТЕРИСТИК с buy-страниц apple.com — тех самых, что стоят
// рядом со строками highlights и в таблице сравнения. Офлайн-инструмент: витрина
// о нём не знает, набор иконок лежит в `public/spec-icons/`, подбор — в
// `lib/spec-icons.js`.
//
//   node scripts/fetch-apple-spec-icons.js https://www.apple.com/shop/buy-iphone/iphone-duo
//   node scripts/fetch-apple-spec-icons.js <url> --dry            # разобрать, ничего не писать
//   node scripts/fetch-apple-spec-icons.js <url> --pick 116fc1c6=display-76 --apply
//
// Ключи:
//   --out DIR    куда складывать выгрузку (по умолчанию apple_svg/<слаг адреса>)
//   --pick S=N   положить глиф с подписью S (первые 8 знаков sha1) в
//                public/spec-icons/N.svg; можно повторять
//   --apply      без него --pick только показывает, что получится
//   --dry        не писать даже выгрузку
//   --force      перезаписать уже существующий файл в public/spec-icons/
//
// **Берутся только ИНЛАЙНОВЫЕ svg.** Часть иконок таблицы сравнения Apple отдаёт
// растром (`<img src=…fmt=png-alpha>`): такой файл не покрасить `currentColor`, а
// у нас глиф красится цветом текста строки — поэтому растровые считаются и
// называются в отчёте, но не скачиваются.
//
// **Конверсия в наш формат обязательна, и она не косметическая.** Apple отдаёт
// Sketch-экспорт: прозрачная подложка-прямоугольник по размеру холста, жёсткий
// `fill="#000000"` у рисунка и `fill="none"` у групп-обёрток. Подложка закрасила бы
// весь квадрат, а чёрный fill перебил бы `currentColor` — presentation attribute
// сильнее наследуемого значения, и глиф остался бы чёрным на тёмной теме.
// `transform` у групп при этом СОХРАНЯЕТСЯ: у половины глифов рисунок сдвинут им,
// и без него фигура уезжает из кадра.
//
// **Холст у compare-страниц 56, у прежних buy-страниц 35 — и это не мешает.**
// `.spec-ico svg` в стилях жёстко квадратный, а `preserveAspectRatio` по умолчанию
// вписывает viewBox по длинной стороне: фигура занимает ту же долю холста, значит
// и на экране выходит того же размера. Приводить координаты к 35 нельзя — деление
// всех чисел в пути задело бы флаги дуг (`a … 0 1 …`), где 1 не координата.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15';
const ROOT = path.join(__dirname, '..');
const ICON_DIR = path.join(ROOT, 'public', 'spec-icons');

function fail(msg) {
  console.error('Ошибка: ' + msg);
  process.exit(1);
}

// ────────────────────────────── аргументы ──────────────────────────────

function parseArgs(argv) {
  const o = { urls: [], out: '', picks: [], apply: false, dry: false, force: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--out') o.out = argv[++i] || '';
    else if (a === '--pick') {
      const v = String(argv[++i] || '');
      const [sha, name] = v.split('=');
      if (!sha || !name) fail('--pick пишется как sha=имя, например --pick 116fc1c6=display-76');
      if (!/^[a-z0-9-]+$/.test(name)) fail('имя файла иконки — латиница, цифры и дефис: ' + name);
      o.picks.push({ sha: sha.toLowerCase(), name });
    } else if (a === '--apply') o.apply = true;
    else if (a === '--dry') o.dry = true;
    else if (a === '--force') o.force = true;
    else if (a.startsWith('--')) fail('неизвестный ключ ' + a);
    else o.urls.push(a);
  }
  if (!o.urls.length) fail('нужен адрес buy-страницы apple.com');
  return o;
}

// ────────────────────────────── страница ──────────────────────────────

async function fetchPage(url) {
  const res = await fetch(url, {
    headers: { 'User-Agent': UA, 'Accept-Language': 'en-US,en;q=0.9' },
    redirect: 'follow'
  });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  return res.text();
}

function slugOf(s, max = 48) {
  return String(s)
    .toLowerCase()
    .replace(/[’‘'"]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, max)
    .replace(/-+$/, '');
}

function plainText(html) {
  return String(html)
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;|&#160;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#8217;|&rsquo;/g, '’')
    .replace(/\s+/g, ' ')
    .trim();
}

// Подпись глифа. Сперва <title> внутри самого svg — Apple подписывает им иконку
// («Battery», «Chip»), и это надёжнее любого соседнего текста. Нет заголовка —
// берём строку, которую глиф подписывает: она идёт сразу за ним.
function labelOf(svg, after) {
  const title = svg.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const own = title ? plainText(title[1]) : '';
  const near = plainText(after).replace(/^Footnote\s*\S*\s*/i, '').slice(0, 90);
  return { title: own, label: own || near, near };
}

// ────────────────────────────── конверсия ──────────────────────────────

// Прозрачная подложка по размеру холста: у Sketch это <polygon>, <rect> или путь
// по четырём углам. Рисует она ничего (её роль играет viewBox), но без своего
// fill="none" закрасила бы весь квадрат — а fill мы как раз снимаем.
function isBackdrop(tag, w, h) {
  const poly = tag.match(/points="([^"]+)"/i);
  if (poly) {
    const nums = poly[1].trim().split(/[\s,]+/).map(Number);
    if (nums.length === 8) {
      const xs = nums.filter((_, i) => i % 2 === 0), ys = nums.filter((_, i) => i % 2 === 1);
      return Math.min(...xs) === 0 && Math.min(...ys) === 0
        && Math.abs(Math.max(...xs) - w) <= 1 && Math.abs(Math.max(...ys) - h) <= 1;
    }
    return false;
  }
  const d = tag.match(/\sd="([^"]+)"/i);
  if (d) {
    // Прямоугольник по размеру холста, четырьмя прямыми командами. Шаблонами, а не
    // разбором пути: считать bbox по числам нельзя — в «m0 0h22v56h-22z» есть −22,
    // и любая проверка «минимум равен нулю» на нём врёт.
    const n = '\\s*,?\\s*';
    const num = v => String(v).replace('.', '\\.');
    const pats = [
      new RegExp(`^m${n}0${n}0${n}h${n}${num(w)}${n}v${n}${num(h)}${n}h${n}-${num(w)}${n}z$`, 'i'),
      new RegExp(`^m${n}0${n}0${n}v${n}${num(h)}${n}h${n}${num(w)}${n}v${n}-${num(h)}${n}z$`, 'i'),
      new RegExp(`^m${n}0${n}0${n}h${n}${num(w)}${n}v${n}${num(h)}${n}h${n}0${n}z$`, 'i'),
      new RegExp(`^m${n}0${n}0${n}l${n}${num(w)}${n}0${n}l${n}${num(w)}${n}${num(h)}${n}l${n}0${n}${num(h)}(${n}l${n}0${n}0)?${n}z$`, 'i')
    ];
    const path = d[1].trim();
    return pats.some(re => re.test(path));
  }
  if (/^<rect/i.test(tag)) {
    const rw = Number((tag.match(/\swidth="([\d.]+)/) || [])[1]);
    const rh = Number((tag.match(/\sheight="([\d.]+)/) || [])[1]);
    return Math.abs(rw - w) <= 1 && Math.abs(rh - h) <= 1;
  }
  return false;
}

function toProjectSvg(src) {
  const open = src.match(/^<svg([^>]*)>/i);
  if (!open) return null;
  const attrs = open[1];
  let vb = (attrs.match(/viewBox="([^"]+)"/i) || [])[1] || '';
  const w = Number((attrs.match(/\swidth="([\d.]+)/i) || [])[1]) || 0;
  const h = Number((attrs.match(/\sheight="([\d.]+)/i) || [])[1]) || 0;
  if (!vb && w && h) vb = `0 0 ${w} ${h}`;
  const [, , vw, vh] = vb.split(/\s+/).map(Number);

  let body = src.slice(open[0].length).replace(/<\/svg>\s*$/i, '');
  body = body
    .replace(/<defs>[\s\S]*?<\/defs>/gi, '')            // там лежит только подложка
    .replace(/<title[^>]*>[\s\S]*?<\/title>/gi, '')     // глиф скрыт от чтения с экрана
    .replace(/<desc[^>]*>[\s\S]*?<\/desc>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '');
  // подложки-прямоугольники
  body = body.replace(/<(polygon|rect|path)\b[^>]*\/?>(?:<\/\1>)?/gi, (tag, name) => (isBackdrop(tag, vw || w, vh || h) ? '' : tag));
  // Жёсткий цвет глифа снимаем, чтобы работал currentColor: у Apple это то чёрный,
  // то фирменный #1D1D1F, и в обоих случаях глиф остался бы тёмным на тёмной теме.
  // Снимаем, только когда цвет в файле ОДИН: двухцветный глиф так превратился бы в
  // сплошную заливку, а такие в наборе характеристик не встречаются — о нём лучше
  // сказать вслух, чем молча испортить.
  const colors = [...new Set((body.match(/\sfill="#[0-9a-f]{3,8}"/gi) || []).map(s => s.toLowerCase().replace(/\s+/, ' ')))];
  if (colors.length > 1) console.warn(`  ! в глифе несколько цветов (${colors.length}) — оставлены как есть, проверьте глазами`);
  body = body
    .replace(colors.length > 1 ? /\sfill="none"/gi : /\sfill="(#[0-9a-f]{3,8}|none)"/gi, '')
    .replace(/\sstroke="none"/gi, '')
    .replace(/\sstroke-width="1"/gi, '')
    .replace(/\s(?:id|class|version|xlink:href|xmlns:xlink|data-[\w-]+)="[^"]*"/gi, '')
    .replace(/<g\s*>\s*<\/g>/gi, '')                    // пустые группы-сетки Sketch
    .replace(/>\s+</g, '><')
    .replace(/\s{2,}/g, ' ')
    .trim();
  // группы, у которых после чистки не осталось ни одного атрибута, но есть дети,
  // оставляем как есть: сворачивать их — значит рисковать парностью тегов.
  const head = `<svg viewBox="${vb}" fill="currentColor" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" focusable="false">`;
  return { svg: head + body + '</svg>', vb, w: vw || w, h: vh || h };
}

// Подпись глифа для дедупликации: только геометрия, без атрибутов оформления.
function signature(svg) {
  const geo = [...svg.matchAll(/\s(?:d|points)="([^"]+)"/g)].map(m => m[1].replace(/[\s,]+/g, ' ').trim()).join('|');
  const tr = [...svg.matchAll(/transform="([^"]+)"/g)].map(m => m[1].replace(/\s+/g, '')).join('|');
  return crypto.createHash('sha1').update(geo + '#' + tr).digest('hex');
}

// ────────────────────────────── что уже есть у нас ──────────────────────────────

function ourIcons() {
  const map = new Map();
  let files = [];
  try { files = fs.readdirSync(ICON_DIR); } catch (e) { return map; }
  for (const f of files) {
    if (!f.endsWith('.svg')) continue;
    const src = fs.readFileSync(path.join(ICON_DIR, f), 'utf8');
    map.set(signature(src), f.slice(0, -4));
  }
  return map;
}

// ────────────────────────────── разбор страницы ──────────────────────────────

function glyphsOf(html, url) {
  const out = [];
  let raster = 0;
  const re = /<svg[\s\S]*?<\/svg>/gi;
  let m;
  while ((m = re.exec(html))) {
    const src = m[0];
    // Шапка apple.com, её же копия внутри JSON настроек и значки подвала — не
    // характеристики. Опознаются они не по себе (внутри такого svg нет ни одного
    // отличительного признака), а по тому, во что обёрнуты.
    const before = html.slice(Math.max(0, m.index - 300), m.index);
    if (/globalnav|localnav|ac-gn|assetInline|svgIcon|"images":/i.test(before)) continue;
    const conv = toProjectSvg(src);
    if (!conv) continue;
    const after = html.slice(m.index + src.length, m.index + src.length + 240);
    const { title, label, near } = labelOf(src, after);
    out.push({ ...conv, title, label, near, sha: signature(conv.svg), page: url });
  }
  for (const tag of html.match(/<img[^>]*>/gi) || []) {
    if (/dd-icon|glyph|compare-icon/i.test(tag) && /png|jpe?g/i.test(tag)) raster++;
  }
  return { glyphs: out, raster };
}

// ────────────────────────────── выгрузка на диск ──────────────────────────────

function writeDump(dir, uniq, url, dry) {
  if (dry) return [];
  fs.mkdirSync(dir, { recursive: true });
  const written = [];
  for (const g of uniq) {
    const file = path.join(dir, `${slugOf(g.label) || 'glyph'}-${g.sha.slice(0, 8)}.svg`);
    fs.writeFileSync(file, g.svg + '\n');
    written.push({
      file: path.relative(path.join(ROOT, 'apple_svg'), file),
      page: url,
      kind: 'inline',
      name: g.title,
      label: g.label,
      group: '',
      w: g.w,
      h: g.h,
      source_url: '',
      sha1: g.sha,
      seen_on_pages: g.seen
    });
  }
  return written;
}

function mergeManifest(rows, dry) {
  if (dry || !rows.length) return;
  const file = path.join(ROOT, 'apple_svg', 'manifest.json');
  let old = [];
  try { old = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { /* первой выгрузки ещё не было */ }
  const by = new Map(old.map(r => [r.file, r]));
  for (const r of rows) by.set(r.file, r);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify([...by.values()].sort((a, b) => a.file.localeCompare(b.file)), null, 2) + '\n');
}

// ────────────────────────────── печать ──────────────────────────────

function report(uniq, ours) {
  console.log('');
  console.log('  подпись   холст    раз  глиф');
  for (const g of uniq) {
    const known = ours.get(g.sha);
    const mark = known ? `= есть: ${known}` : 'НОВЫЙ';
    console.log(`  ${g.sha.slice(0, 8)}  ${String(g.w) + '×' + g.h}`.padEnd(22) + `×${String(g.seen).padEnd(3)} ${mark.padEnd(18)} ${g.label}`);
  }
}

// ────────────────────────────── main ──────────────────────────────

(async () => {
  const o = parseArgs(process.argv.slice(2));
  const ours = ourIcons();
  const all = [];

  for (const url of o.urls) {
    let html;
    try { html = await fetchPage(url); } catch (e) { fail(`не скачалась ${url}: ${e.message}`); }
    const { glyphs, raster } = glyphsOf(html, url);
    const by = new Map();
    for (const g of glyphs) {
      if (!by.has(g.sha)) by.set(g.sha, { ...g, seen: 0 });
      by.get(g.sha).seen++;
    }
    const uniq = [...by.values()];
    const dir = o.out ? path.resolve(o.out) : path.join(ROOT, 'apple_svg', slugOf(new URL(url).pathname.replace(/^\/shop\//, ''), 64));
    console.log(`${url}\n  инлайновых глифов ${glyphs.length}, уникальных ${uniq.length}, растровых пропущено ${raster}`);
    if (!o.dry) console.log('  выгрузка → ' + path.relative(process.cwd(), dir));
    report(uniq, ours);
    mergeManifest(writeDump(dir, uniq, url, o.dry), o.dry);
    all.push(...uniq);
  }

  if (!o.picks.length) {
    const fresh = all.filter(g => !ours.get(g.sha)).length;
    if (fresh) console.log(`\nНовых глифов: ${fresh}. Положить в набор: --pick <подпись>=<имя> --apply`);
    return;
  }

  for (const p of o.picks) {
    const g = all.find(x => x.sha.startsWith(p.sha));
    if (!g) fail(`глифа с подписью ${p.sha} на этих страницах нет`);
    const dest = path.join(ICON_DIR, p.name + '.svg');
    if (fs.existsSync(dest) && !o.force) fail(`${p.name}.svg уже есть — перезапись только с --force`);
    console.log(`${p.sha} → public/spec-icons/${p.name}.svg  (${g.w}×${g.h}, ${g.label})`);
    if (o.apply) fs.writeFileSync(dest, g.svg + '\n');
  }
  if (!o.apply) console.log('\nЭто предпросмотр. Записать: добавьте --apply');
  else console.log('\nЗаписано. Дальше — правило в RULES (lib/spec-icons.js), иначе глиф не подберётся ни одной строке.');
})();
