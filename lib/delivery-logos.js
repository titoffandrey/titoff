'use strict';
/*
 * Логотипы перевозчиков для выбора доставки.
 *
 * Формат — SVG, инлайном спрайтом в страницу. Почему именно так:
 *   - чётко на любом экране, включая retina и зум; PNG пришлось бы отдавать в
 *     2× и 3×, и всё равно он мылится на промежуточных масштабах;
 *   - ни одного лишнего запроса: спрайт уходит внутри HTML, который и так
 *     сжимается Brotli. Пара килобайт на оба логотипа;
 *   - внешние адреса исключены в принципе — CSP запрещает чужие хосты
 *     (`img-src 'self' data:`), да и показывать посетителя чужому серверу
 *     незачем.
 *
 * Файл кладётся в `public/delivery/<id>.svg`, где `<id>` — id способа доставки
 * из `lib/delivery.js` (`cdek`, `ozon`). Файла нет — на витрине остаётся
 * название текстом, как было: раскладка от отсутствия логотипа не ломается.
 *
 * Отдельный модуль, а не часть lib/delivery.js: тот подключается из lib/db.js,
 * и тащить туда чтение файлов ради нормализации заказа незачем.
 */
const fs = require('fs');
const path = require('path');

const LOGO_DIR = path.join(__dirname, '..', 'public', 'delivery');
const MAX_BYTES = 24 * 1024;   // логотип-вордмарк весит 1–3 КБ; больше — это не логотип

const LOGOS = {};   // id → { viewBox, inner }

// Файлы приходят СНАРУЖИ — их скачивают с брендбука перевозчика и кладут в
// каталог. Инлайн чужого SVG в HTML исполняет всё, что внутри, поэтому чистим
// до вставки: скрипты, обработчики событий, foreignObject и ссылки на внешние
// адреса. Оставляем только внутренние ссылки (`#id`) — на них держатся градиенты
// и обтравки самого логотипа.
function sanitize(src) {
  return String(src)
    .replace(/<\?xml[\s\S]*?\?>/gi, '')
    .replace(/<!DOCTYPE[\s\S]*?>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<foreignObject[\s\S]*?<\/foreignObject>/gi, '')
    .replace(/<(script|foreignObject|iframe|use)\b[^>]*\/>/gi, (m, tag) => tag.toLowerCase() === 'use' ? m : '')
    .replace(/\son[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    // href/xlink:href оставляем только внутренние: «#gradient» — да, «https://…» — нет
    .replace(/\s(?:xlink:)?href\s*=\s*(?:"(?!#)[^"]*"|'(?!#)[^']*'|(?!#)[^\s>]+)/gi, '')
    .replace(/javascript:/gi, '')
    .replace(/\s+focusable="[^"]*"/gi, '')
    .replace(/>\s+</g, '><')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

// Служебные id внутри логотипа (градиенты, clipPath) у двух файлов легко
// совпадают — в брендбуках это сплошь `id="a"`. На одной странице два таких
// логотипа, и второй начинает краситься градиентом первого. Поэтому все id
// внутри файла получают свою приставку — ровно та же беда, что была у
// плейсхолдеров товаров с их «десятками одинаковых id».
function namespaceIds(src, prefix) {
  const ids = [];
  src.replace(/\sid="([^"]+)"/g, (m, id) => { ids.push(id); return m; });
  let out = src;
  for (const id of ids) {
    const safe = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    out = out
      .replace(new RegExp(`\\sid="${safe}"`, 'g'), ` id="${prefix}-${id}"`)
      .replace(new RegExp(`url\\(#${safe}\\)`, 'g'), `url(#${prefix}-${id})`)
      .replace(new RegExp(`(\\s(?:xlink:)?href=")#${safe}"`, 'g'), `$1#${prefix}-${id}"`);
  }
  return out;
}

// viewBox обязателен: по нему <use> масштабируется, а высота задаётся из CSS.
// Если в файле только width/height — собираем viewBox из них.
function viewBoxOf(attrs) {
  const box = /viewBox="([^"]+)"/i.exec(attrs);
  if (box) return box[1].trim();
  const w = /\swidth="([\d.]+)/i.exec(attrs);
  const h = /\sheight="([\d.]+)/i.exec(attrs);
  return (w && h) ? `0 0 ${w[1]} ${h[1]}` : '';
}

try {
  for (const file of fs.readdirSync(LOGO_DIR)) {
    if (!file.endsWith('.svg')) continue;
    const full = path.join(LOGO_DIR, file);
    if (fs.statSync(full).size > MAX_BYTES) continue;
    const id = file.slice(0, -4);
    const src = sanitize(fs.readFileSync(full, 'utf8'));
    const open = /^<svg([^>]*)>/i.exec(src);
    if (!open) continue;
    const viewBox = viewBoxOf(open[1]);
    if (!viewBox) continue;      // без viewBox логотип не масштабируется — лучше текст
    const inner = namespaceIds(src.slice(open[0].length).replace(/<\/svg>\s*$/i, ''), 'dl-' + id);
    if (inner) LOGOS[id] = { viewBox, inner };
  }
} catch (e) { /* каталога нет — на витрине останутся названия текстом */ }

function has(id) { return !!LOGOS[String(id || '')]; }
function viewBox(id) { const l = LOGOS[String(id || '')]; return l ? l.viewBox : ''; }
function names() { return Object.keys(LOGOS); }

// Спрайт на страницу: каждый логотип один раз, дальше ссылки <use href="#dl-id">.
// Пустая строка, когда логотипов нет вовсе — лишнего узла в разметке не будет.
function sprite() {
  const ids = names();
  if (!ids.length) return '';
  return '<svg class="dl-sprite" aria-hidden="true" width="0" height="0" style="position:absolute">'
    + ids.map(id => `<symbol id="dl-${id}" viewBox="${LOGOS[id].viewBox}">${LOGOS[id].inner}</symbol>`).join('')
    + '</svg>';
}

module.exports = { has, viewBox, names, sprite, sanitize, namespaceIds };
