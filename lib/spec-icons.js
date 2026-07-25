'use strict';
// ===== Иконки характеристик =====
// Оригинальные глифы Apple (public/spec-icons/*.svg), подбираются по строке
// характеристики: сначала по значению (чипы, диагонали), затем по ключу.
const fs = require('fs');
const path = require('path');

const ICON_DIR = path.join(__dirname, '..', 'public', 'spec-icons');

// Инлайним файлы один раз при старте — так иконка красится currentColor.
const ICONS = {};
try {
  for (const f of fs.readdirSync(ICON_DIR)) {
    if (f.endsWith('.svg')) ICONS[f.slice(0, -4)] = fs.readFileSync(path.join(ICON_DIR, f), 'utf8').trim();
  }
} catch (e) { /* каталог иконок недоступен — отдадим пустую строку */ }

// Правила: [регулярка, имя иконки]. Проверяются сверху вниз по «ключ + значение».
const RULES = [
  // --- конкретные чипы (по значению) ---
  [/\bm5\s*max\b/i, 'chip-m5-max'],
  [/\bm5\s*pro\b/i, 'chip-m5-pro'],
  [/\bm5\b/i, 'chip-m5'],
  [/\bm4\s*max\b|\bm4\s*pro\b/i, 'chip-m4-max'],
  [/\bm4\b/i, 'chip-m4'],
  [/\bm3\s*ultra\b/i, 'chip-m3-ultra'],
  [/\bm3\b|\bm2\b|\bm1\b/i, 'chip-m4'],
  [/\ba19\s*pro\b/i, 'chip-a19-pro'],
  [/\ba19\b/i, 'chip-a19'],
  [/\ba18\b/i, 'chip-a18'],
  [/\ba17\b/i, 'chip-a17-pro'],
  [/\ba16\b|\ba15\b|\ba14\b|\ba13\b|\ba12\b/i, 'chip-a16'],
  [/чип|процесс|нейро|neural|\bgpu\b|\bcpu\b|s\d+\s*sip|\bh\d\b/i, 'ai'],

  // --- экран ---
  [/(экран|дисплей|диагонал)/i, 'display'],
  // ВАЖНО: \b не работает с кириллицей (в JS это граница ASCII-слова), поэтому русские слова — без \b
  [/яркост|нит|nits/i, 'brightness'],
  [/частот|гц|\bhz\b|promotion|обновлен/i, 'refresh'],
  [/цвет|гамма|\bp3\b|srgb/i, 'color'],
  [/покрыти|нанотекстур|антиблик|глянц|матов/i, 'display'],

  // --- камеры ---
  [/фронтал|селфи|front|center stage/i, 'camera-front'],
  [/lidar|лидар|тройн|pro.?камер|система камер|теле/i, 'camera-pro'],
  [/камер|мегапиксел|зум|телефото/i, 'camera'],

  // --- питание (раньше «видео», иначе «до 26 ч видео» уедет не туда) ---
  [/автоном|аккум|батаре|время работы/i, 'battery'],
  [/зарядк|magsafe|беспроводн.*заряд|питани|адаптер/i, 'charge'],

  [/видео|запись|кино|\b4k\b|\b8k\b/i, 'video'],
  [/фото|снимк|галере/i, 'photo'],

  // --- звук (раньше «датчиков»: «шумоподавление» содержит «давлен») ---
  [/аудио|звук|шумоподавл|динамик|микрофон|акустик|наушник|полноразмерн|вкладыш|колонк|speaker/i, 'audio'],
  [/мет(к|ок)|локатор|поиск вещей|find my/i, 'network'],

  // --- аксессуары и управление (раньше портов: «Apple Pencil (USB-C)») ---
  [/pencil|стилус|каранд/i, 'pencil'],
  [/клавиатур|мышь|трекпад|magic keyboard/i, 'keyboard'],
  [/кнопк|button|колёс|колес|коронк|digital crown/i, 'button'],

  // --- порты, память, связь ---
  [/разъ|порт|usb|thunderbolt|hdmi|подключен|jack/i, 'port'],
  [/озу|память|накопит|\bssd\b|хранил|гб|тб|\bram\b|storage/i, 'storage'],
  [/спутник|satellite/i, 'satellite'],
  [/\b5g\b|\blte\b|cellular|сотов|мобильн.*связ/i, 'network-5g'],
  [/связ|wi-?fi|вай-?фай|bluetooth|nfc|модем/i, 'network'],

  // --- здоровье и датчики ---
  [/пульс|сердц|экг|\becg\b|кислород|гипертен|артериальн/i, 'heart'],
  [/апно|качество сна|оценка сна|отслеживание сна|сон\b|сна |сне /i, 'sleep'],
  [/датчик|сенсор|температур|vitals|здоров/i, 'sensors'],
  [/тренировк|фитнес|спорт|бег|шагом|активност/i, 'fitness'],
  [/безопасн|\bsos\b|авари|падени|экстрен/i, 'sos'],
  [/семь|детск|для детей|родител/i, 'family'],

  [/поддержк|совместим|аксессуар/i, 'pencil'],

  // --- корпус, размеры, защита ---
  [/защит|водонепрониц|пыл|\bip\d\d\b|\bwr\d+|mil-std|прочн|стойкос/i, 'watch'],
  [/корпус|материал|титан|алюмин|стекл|керамик|сапфир|дизайн/i, 'watch'],
  [/вес|толщин|габарит|размер|компакт/i, 'size'],

  // --- софт ---
  [/apple intelligence|\bai\b|интеллект|siri/i, 'ai'],
  [/\bios\b|ipados|watchos|macos|visionos|систем|прошивк/i, 'os'],

  // --- покупка ---
  [/рассрочк|кредит|оплат|платёж|платеж|цена|стоимост/i, 'payment'],
  [/доставк|отправк/i, 'shipping'],
  [/самовывоз|магазин|пункт выдач/i, 'pickup'],
  [/trade-?in|обмен|сдать/i, 'trade-in'],
  [/гаранти|срок|часа|часов/i, 'timer'],

  // --- типы устройств ---
  [/ноутбук|macbook|лэптоп/i, 'laptop'],
  [/монитор|studio display/i, 'monitor'],
  [/mac mini|mac studio|десктоп|системн/i, 'desktop'],
  [/watch|часы/i, 'watch']
];

const FALLBACK = 'sparkles';

// Диагональ экрана: подставляем «размерный» глиф с нужным числом.
const DISPLAY_SIZES = { '6.1': 'display-61', '6.3': 'display-63', '6.5': 'display-65', '6.7': 'display-67', '6.9': 'display-69' };

function pickIcon(key, value) {
  const line = `${key || ''} ${value || ''}`;
  if (/(экран|дисплей|диагонал|design|корпус)/i.test(key || '')) {
    const m = line.match(/(\d+[.,]\d+)\s*(?:"|”|''|inch|дюйм)/i);
    if (m) {
      const named = DISPLAY_SIZES[m[1].replace(',', '.')];
      if (named && ICONS[named]) return named;
    }
  }
  for (const [re, name] of RULES) {
    if (re.test(line) && ICONS[name]) return name;
  }
  return FALLBACK;
}

// Возвращает готовую разметку <svg> для строки характеристики.
function specIcon(key, value) {
  return ICONS[pickIcon(key, value)] || '';
}

module.exports = { specIcon, pickIcon, ICONS };
