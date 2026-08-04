'use strict';
// ===== Иконки характеристик =====
// Оригинальные глифы Apple (public/spec-icons/*.svg). Задача подбора — поставить
// рядом со строкой тот же глиф, который Apple ставит рядом с таким же текстом
// в блоке highlights на apple.com/shop. Порядок разбора:
//   1) ключ строки («Экран», «Камера», «Порты», …) — он надёжнее значения;
//   2) значение — чипы, диагонали, конкретные камеры;
//   3) общий список RULES по «ключ + значение».
const fs = require('fs');
const path = require('path');

const ICON_DIR = path.join(__dirname, '..', 'public', 'spec-icons');

// Инлайним файлы один раз при старте — так иконка красится currentColor.
// Заодно чистим: прозрачная подложка-квадрат не рисует ничего (её роль играет viewBox),
// xmlns инлайновому SVG в HTML не нужен, focusable — наследие IE.
const ICONS = {};      // имя → готовая разметка <svg>…</svg>
const ATTRS = {};      // имя → атрибуты корневого <svg> (для ссылок через <use>)
const INNER = {};      // имя → содержимое без корневого тега
function minify(src) {
  return src
    .replace(/<path\s+d="m0 0h[\d.]+v[\d.]+h-[\d.]+z"\s+fill="none"\s*\/>/ig, '')
    .replace(/<path\s+fill="none"\s+d="M0 0H[\d.]+V[\d.]+H0z"\s*\/>/ig, '')
    .replace(/\s+xmlns="[^"]*"/g, '')
    .replace(/\s+focusable="[^"]*"/g, '')
    .replace(/>\s+</g, '><')
    .replace(/\s{2,}/g, ' ')
    .trim();
}
try {
  for (const f of fs.readdirSync(ICON_DIR)) {
    if (!f.endsWith('.svg')) continue;
    const name = f.slice(0, -4);
    const src = minify(fs.readFileSync(path.join(ICON_DIR, f), 'utf8'));
    const open = src.match(/^<svg([^>]*)>/);
    ICONS[name] = src;
    ATTRS[name] = open ? open[1].trim() : 'viewBox="0 0 35 35"';
    INNER[name] = open ? src.slice(open[0].length).replace(/<\/svg>$/, '') : '';
  }
} catch (e) { /* каталог иконок недоступен — отдадим пустую строку */ }

// Диагональ экрана: подставляем «размерный» глиф с нужным числом.
const DISPLAY_SIZES = { '6.1': 'display-61', '6.3': 'display-63', '6.5': 'display-65', '6.7': 'display-67', '6.9': 'display-69' };

// Бейджи чипов — Apple рисует их с названием прямо в глифе.
const CHIPS = [
  [/m5\s*max/i, 'chip-m5-max'],
  [/m5\s*pro/i, 'chip-m5-pro'],
  [/m5/i, 'chip-m5'],
  [/m4\s*max|m4\s*pro/i, 'chip-m4-max'],
  [/m4/i, 'chip-m4'],
  [/m3\s*ultra/i, 'chip-m3-ultra'],
  [/m3|m2|m1/i, 'chip-m4'],
  [/a19\s*pro/i, 'chip-a19-pro'],
  [/a19/i, 'chip-a19'],
  [/a18\s*pro/i, 'chip-a18-pro'],
  [/a18/i, 'chip-a18'],
  [/a17/i, 'chip-a17-pro'],
  [/a16|a15|a14|a13|a12/i, 'chip-a16']
];

// Правила: [регулярка, имя иконки]. Проверяются сверху вниз по «ключ + значение».
// ВАЖНО: \b не работает с кириллицей (в JS это граница ASCII-слова), поэтому
// русские слова пишем без \b.
const RULES = [
  // --- аксессуары и управление (раньше портов: «Apple Pencil (USB-C)») ---
  [/pencil|стилус|каранд/i, 'pencil'],
  [/в цвет корпуса|color-matched|подобран.*цвет/i, 'color'],
  [/magic keyboard|клавиатур|мышь|трекпад/i, 'keyboard'],
  [/подставк|vesa|регулировка высоты/i, 'stand'],
  [/ремеш|циферблат|herm/i, 'band'],
  [/camera control/i, 'camera-control'],
  [/кнопк|button|коронк|digital crown|двойное нажатие/i, 'button'],

  // --- звук (раньше здоровья: «шумоподавление» содержит «давлен») ---
  [/аудио|звук|шумоподавл|динамик|микрофон|акустик|наушник|полноразмерн|вкладыш|амбушюр|колонк|стереопар|airplay|intercom|слух|voice isolation|speaker/i, 'audio'],

  // --- здоровье и датчики ---
  [/гиперто|гипертен|артериальн|давлени/i, 'hypertension'],
  [/пульс|сердц|экг|\becg\b|кислород/i, 'heart'],
  [/оценка сна|качество сна|sleep score|апно|отслеживание сна|сон |сна |сне /i, 'bed'],
  [/optic id|взглядом|жест|датчик|сенсор|vitals|здоров|температур/i, 'sensors'],
  [/погружен|глубин|водонепрониц|водозащит/i, 'water'],
  // спутник раньше SOS: у Apple «satellite communications for Emergency SOS» — со спутником
  [/спутник|satellite/i, 'satellite'],
  [/безопасн|\bsos\b|авари|падени|экстрен/i, 'sos'],

  // --- связь ---
  [/\b5g\b|\blte\b|cellular|сотов|esim/i, 'network-5g'],
  [/wi-?fi|вай-?фай|bluetooth|nfc|thread|matter|ultra wideband|модем|локатор|мет(к|ок)|поиск вещей|find my/i, 'network'],

  // --- экран ---
  [/mini-?led/i, 'display-mini-led'],
  [/яркост|нит|nits/i, 'brightness'],
  [/частот|гц|\bhz\b|promotion|обновлен/i, 'refresh'],
  [/гамма|adobe rgb|\bp3\b|srgb|цвет/i, 'gamut'],
  [/экран|дисплей|диагонал|покрыти|нанотекстур|антиблик|глянц|матов/i, 'display'],

  // --- питание (раньше «видео», иначе «до 26 ч видео» уедет не туда) ---
  [/автоном|аккум|батаре|время работы/i, 'battery'],
  [/зарядк|magsafe|беспроводн.*заряд|питани|адаптер|\bqi\b/i, 'charge'],

  // --- порты и память ---
  [/разъ|порт|usb|thunderbolt|hdmi|ethernet|sdxc|подключен|jack/i, 'port'],
  [/озу|память|накопит|\bssd\b|хранил|гб|тб|\bram\b|storage/i, 'storage'],

  [/видео|запись|кино|\b4k\b|\b8k\b|dolby vision|\bhdr/i, 'video'],

  // --- корпус, размеры, защита ---
  [/защит|\bip\d\d\b|\bip\dx\b|\bwr\d+|mil-std|влаг/i, 'water'],
  [/титан|алюмин|стекл|керамик|ceramic shield|сапфир|материал|прочн|стойкос/i, 'shield'],
  [/вес|толщин|габарит|размер|компакт/i, 'size'],

  // --- софт и чипы без бейджа ---
  // у Apple три разных глифа: «iOS 26 and Apple Intelligence» — os, «Apple Intelligence
  // helps you…» (iPad) — ai, «Built for AI» (Mac) — sparkles. Повторяем это разделение.
  [/готов к ии|built for ai/i, 'sparkles'],
  [/apple intelligence|интеллект|siri|нейро|neural/i, 'ai'],
  [/\bios\b|ipados|watchos|macos|visionos|систем|прошивк/i, 'os'],
  [/чип|процесс|\bgpu\b|\bcpu\b|s\d+\s*sip|\bh\d\b/i, 'chip']
];

const FALLBACK = 'sparkles';

// Камеры: у Apple свой глиф на каждую систему, разбираем по значению.
function pickCamera(v) {
  if (/lidar|лидар/i.test(v)) return 'camera-pro';                                  // Pro camera with LiDAR (iPad Pro)
  if (/truedepth/i.test(v)) return 'camera-front';                                  // 12MP TrueDepth
  if (/center stage/i.test(v)) return /18\s*мп/i.test(v) ? 'camera-front-18' : 'camera-front';
  if (/теле|зум\s*8|8×|8x/i.test(v)) return 'camera-system';                        // тройная Pro, зум 8×
  if (/\+/.test(v)) return 'camera-dual';                                           // двойная Fusion
  if (/48\s*мп/i.test(v)) return 'camera-main';                                     // одиночная 48 Мп Fusion
  return 'camera';
}

// Одна и та же строка характеристики встречается у многих товаров — считаем один раз.
// Храним именно результат choose(): null означает «правило не нашлось».
const memo = new Map();
function match(key, value) {
  const cacheKey = `${key} ${value}`;
  const hit = memo.get(cacheKey);
  if (hit !== undefined) return hit;
  const name = choose(key, value);
  if (memo.size < 2000) memo.set(cacheKey, name);
  return name;
}
function pickIcon(key, value) { return match(key, value) || FALLBACK; }
// Нашлось ли для строки настоящее правило. Отдельная функция нужна потому, что
// sparkles — не только фолбэк: у Apple это глиф «Built for AI» на buy-mac
// (см. правило «готов к ии»), и по одному лишь имени иконки осознанный выбор от
// промаха уже не отличить — проверка каталога иначе даёт ложные срабатывания.
function hasIcon(key, value) { return match(key, value) !== null; }

function choose(key, value) {
  const k = key || '';
  const v = value || '';
  const line = `${k} ${v}`;

  // 1. Экран — глиф с диагональю, если она указана в значении
  if (/экран|дисплей|диагонал/i.test(k)) {
    const m = v.match(/(\d+[.,]\d+)\s*(?:"|”|''|inch|дюйм)/i);
    const named = m && DISPLAY_SIZES[m[1].replace(',', '.')];
    if (named && ICONS[named]) return named;
    if (/always-?on/i.test(v) && ICONS['display-always-on']) return 'display-always-on';
    if (/mini-?led/i.test(v) && ICONS['display-mini-led']) return 'display-mini-led';
    return 'display';
  }

  // 2. Камеры — по составу системы
  if (/камер|фронтал|селфи/i.test(k)) {
    const name = pickCamera(v);
    if (ICONS[name]) return name;
  }

  // 3. Чип — бейдж с названием; без бейджа (S11 SiP, H2) — простой глиф чипа.
  // Скобки отбрасываем: «Apple M5 Pro (до M5 Max)» — это бейдж M5 Pro, а не M5 Max.
  if (/чип|процессор/i.test(k)) {
    const base = v.replace(/\([^)]*\)/g, '');
    for (const [re, name] of CHIPS) if (re.test(base) && ICONS[name]) return name;
    return ICONS['chip'] ? 'chip' : 'ai';
  }

  // 4. Ключи, которые важнее значения:
  //    «Порты: 2× USB-C, MagSafe 3» — это порты, а не зарядка;
  //    «Память: 256 ГБ» — накопитель, а не размеры.
  if (/порт|разъ/i.test(k) && ICONS['port']) return 'port';
  if (/памят|озу|накопит/i.test(k) && ICONS['storage']) return 'storage';
  if (/защит/i.test(k) && ICONS['water']) return 'water';
  if (/систем/i.test(k) && ICONS['os']) return 'os';                    // «Система: iOS 26 …» — как на apple.com
  if (/навигац|\bgps\b/i.test(k)) return /двухчастот|dual/i.test(v) ? 'gps-dual' : 'gps';
  // «Корпус: … 42 мм» — часы (у Ultra свой глиф на 49 мм), «Материал: титан» — всё остальное
  if (/корпус|материал/i.test(k)) {
    if (!/\d+\s*мм/.test(v)) return 'shield';
    return /49\s*мм/.test(v) && ICONS['case-ultra'] ? 'case-ultra' : 'case';
  }
  if (/датчик/i.test(k) && !/пульс/i.test(k) && ICONS['sensors']) return 'sensors';

  // 5. Общий разбор по «ключ + значение»
  for (const [re, name] of RULES) {
    if (re.test(line) && ICONS[name]) return name;
  }
  return null;   // правило не нашлось — рисовать будем FALLBACK, но это видно снаружи
}

// Возвращает готовую разметку <svg> для строки характеристики.
// Если на странице глиф уже был (например, четыре «Аудио» подряд у HomePod),
// второй раз отдаём ссылку <use> на первый — меньше разметки и узлов в DOM.
// seen — необязательный Set, живёт в пределах одной страницы.
function specIcon(key, value, seen) {
  const name = pickIcon(key, value);
  if (!ICONS[name]) return '';
  if (!seen) return ICONS[name];
  if (seen.has(name)) return `<svg ${ATTRS[name]}><use href="#g-${name}"/></svg>`;
  seen.add(name);
  return `<svg ${ATTRS[name]} id="g-${name}">${INNER[name]}</svg>`;
}

module.exports = { specIcon, pickIcon, hasIcon, ICONS };
