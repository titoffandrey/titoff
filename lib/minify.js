'use strict';
/* ============ Комментарии остаются в исходниках, но не уезжают в браузер ============
 *
 * Комментарии здесь — не мусор, а документация проекта: почему кнопка стоит под
 * ценой, почему `\b` не работает с кириллицей, на какие грабли уже наступали.
 * Их пишут и читают, и вырезать их ИЗ ФАЙЛОВ нельзя ни в коем случае.
 *
 * Но каждому посетителю они уезжают вместе с кодом, и это не мелочь. Замер на
 * текущей витрине (brotli, то, что реально идёт по проводу):
 *
 *     styles.css   53,4 КБ → 26,2 КБ     (−51 %)
 *     app.js       36,2 КБ → 20,1 КБ     (−45 %)
 *     phone.js      6,3 КБ →  3,1 КБ
 *     pay.js        4,3 КБ →  2,5 КБ
 *
 * Итого около 46 КБ на первое открытие витрины — на мобильном интернете это
 * заметная доля секунды до первой отрисовки, и платит её каждый покупатель.
 *
 * Поэтому комментарии снимаются НА ОТДАЧЕ: файл на диске не меняется, а в
 * браузер уходит текст без них. Тот же приём, что у глифов характеристик
 * (`minify()` в `lib/spec-icons.js`) и у логотипов перевозчиков: читаем один
 * раз, чистим в памяти, дальше раздаём готовое. Сборки у проекта по-прежнему
 * нет — есть один проход при первом запросе файла, результат живёт в том же
 * кэше, что и сжатые представления.
 *
 * ------------------------------ Про безопасность ------------------------------
 *
 * Снять комментарии регуляркой нельзя, и это главная ловушка: `//` встречается
 * внутри каждой ссылки (`https://…`), а `/*` — внутри строк. Наивная замена
 * тихо съедает половину строки кода, и ломается при этом ровно то, что дороже
 * всего, — корзина и оплата.
 *
 * Поэтому здесь настоящий разборщик по состояниям (строка, шаблонный литерал,
 * регулярное выражение, комментарий), а поверх него — ДВЕ проверки результата:
 *
 *   1. очищенный текст обязан разбираться как JavaScript (`vm.Script`);
 *   2. набор литералов (строки, шаблоны, регулярки) обязан совпасть с исходным
 *      — это ловит порчу ВНУТРИ строки, которую разбор пропустит.
 *
 * Не сошлось хоть что-то — отдаём файл как есть. Ошибка в разборщике тогда
 * стоит нам несжатых комментариев, а не сломанной витрины.
 */

const vm = require('vm');

// Слова, после которых `/` начинает регулярное выражение, а не деление:
// `return /^\s+/.test(s)` — самый частый случай в проекте. Без этого списка
// регулярка после `return` принималась бы за деление.
const REGEX_AFTER = new Set([
  'return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void',
  'throw', 'case', 'do', 'else', 'yield', 'await'
]);

function isIdentChar(ch) { return /[A-Za-z0-9_$]/.test(ch); }

/* Разбор JavaScript на куски. `keepComments` решает, попадут ли комментарии в
 * выход; `literals` копит содержимое строк, шаблонов и регулярок — по нему потом
 * сверяется, что чистка ничего не тронула внутри них.
 */
function scanJs(src, keepComments, literals, tight) {
  let out = '';
  let i = 0;
  const n = src.length;
  // Последний значимый символ и последнее слово перед ним — по ним отличаем
  // регулярное выражение от деления.
  let prev = '';
  let prevWord = '';
  // Глубина `${…}` внутри шаблонных литералов: закрывающая скобка возвращает
  // разбор обратно в шаблон, а не в обычный код.
  const tpl = [];

  while (i < n) {
    const ch = src[i];
    const next = src[i + 1];

    // --- комментарии ---
    if (ch === '/' && next === '/') {
      let j = i + 2;
      while (j < n && src[j] !== '\n') j++;
      if (keepComments) out += src.slice(i, j);
      i = j;
      continue;
    }
    if (ch === '/' && next === '*') {
      let j = src.indexOf('*/', i + 2);
      j = j === -1 ? n : j + 2;
      if (keepComments) out += src.slice(i, j);
      // Блочный комментарий может содержать перевод строки, а перевод строки
      // значим для автоматической расстановки точек с запятой. Оставляем один.
      else if (src.slice(i, j).includes('\n')) out += '\n';
      i = j;
      continue;
    }

    // --- строки ---
    if (ch === '"' || ch === '\'') {
      let j = i + 1;
      while (j < n) {
        if (src[j] === '\\') { j += 2; continue; }
        if (src[j] === ch) { j++; break; }
        if (src[j] === '\n') break;      // незакрытая строка — пусть падает разбор
        j++;
      }
      literals.push(src.slice(i, j));
      out += src.slice(i, j);
      prev = ch; prevWord = '';
      i = j;
      continue;
    }

    // --- шаблонные литералы ---
    if (ch === '`') {
      tpl.push(true);
      let j = i + 1;
      let piece = '`';
      while (j < n) {
        if (src[j] === '\\') { piece += src.slice(j, j + 2); j += 2; continue; }
        if (src[j] === '`') { piece += '`'; j++; tpl.pop(); break; }
        // `${` — дальше идёт обычный код, и разбирать его надо как код.
        if (src[j] === '$' && src[j + 1] === '{') { piece += '${'; j += 2; break; }
        piece += src[j]; j++;
      }
      literals.push(piece);
      out += piece;
      prev = piece.endsWith('{') ? '{' : '`'; prevWord = '';
      i = j;
      continue;
    }
    if (ch === '}' && tpl.length) {
      // Возврат из `${…}` обратно в шаблон.
      let j = i + 1;
      let piece = '}';
      while (j < n) {
        if (src[j] === '\\') { piece += src.slice(j, j + 2); j += 2; continue; }
        if (src[j] === '`') { piece += '`'; j++; tpl.pop(); break; }
        if (src[j] === '$' && src[j + 1] === '{') { piece += '${'; j += 2; break; }
        piece += src[j]; j++;
      }
      literals.push(piece);
      out += piece;
      prev = piece.endsWith('{') ? '{' : '`'; prevWord = '';
      i = j;
      continue;
    }

    // --- регулярное выражение или деление ---
    if (ch === '/') {
      const afterWord = prevWord && REGEX_AFTER.has(prevWord);
      const afterValue = !afterWord && (isIdentChar(prev) || prev === ')' || prev === ']');
      if (!afterValue) {
        let j = i + 1;
        let cls = false;         // внутри […] символ `/` не закрывает регулярку
        let ok = false;
        while (j < n) {
          const c = src[j];
          if (c === '\\') { j += 2; continue; }
          if (c === '\n') break;
          if (c === '[') cls = true;
          else if (c === ']') cls = false;
          else if (c === '/' && !cls) { j++; ok = true; break; }
          j++;
        }
        if (ok) {
          while (j < n && /[a-z]/.test(src[j])) j++;   // флаги
          literals.push(src.slice(i, j));
          out += src.slice(i, j);
          prev = '/'; prevWord = '';
          i = j;
          continue;
        }
      }
    }

    /* --- пробелы между кусками кода ---
     * Отступы и пустые строки — четверть веса скрипта до сжатия (Lighthouse
     * насчитал на app.js 24 %). Схлопываем, но по одному строгому правилу:
     * перевод строки НИКОГДА не пропадает и НИКОГДА не появляется. Иначе
     * достаточно одной строки без точки с запятой, чтобы автоматическая
     * расстановка отработала иначе, — а увидеть это можно только в браузере.
     * Поэтому ряд пробелов с переводом строки становится одним переводом
     * строки, ряд без него — одним пробелом. Токены при этом не срастаются.
     */
    if (tight && !keepComments && /\s/.test(ch)) {
      let j = i;
      let nl = false;
      while (j < n && /\s/.test(src[j])) { if (src[j] === '\n' || src[j] === '\r') nl = true; j++; }
      out += nl ? '\n' : ' ';
      i = j;
      continue;
    }

    // --- обычный код ---
    if (isIdentChar(ch)) {
      let j = i;
      while (j < n && isIdentChar(src[j])) j++;
      const word = src.slice(i, j);
      out += word;
      prev = word[word.length - 1]; prevWord = word;
      i = j;
      continue;
    }
    out += ch;
    if (!/\s/.test(ch)) { prev = ch; prevWord = ''; }
    i++;
  }
  return out;
}

/* Убрать из JavaScript комментарии. Любое сомнение — возвращаем исходник. */
function js(src) {
  const text = String(src);
  try {
    const before = [];
    scanJs(text, true, before);
    const out = scanJs(text, false, [], true);
    const after = [];
    scanJs(out, true, after);
    // Литералы обязаны совпасть один в один: разбор поймает сломанный
    // синтаксис, но не подмену внутри строки.
    if (before.length !== after.length) return text;
    for (let i = 0; i < before.length; i++) if (before[i] !== after[i]) return text;
    new vm.Script(out);          // не разбирается — отдаём как есть
    return out;
  } catch (e) {
    return text;
  }
}

/* Убрать комментарии из CSS. Разбор проще: из «состояний» только строки, а
 * `/*` внутри них в файле не встречается — но проверять всё равно обязаны, файл
 * правится руками.
 */
function css(src) {
  const text = String(src);
  let out = '';
  let i = 0;
  const n = text.length;
  while (i < n) {
    const ch = text[i];
    if (ch === '"' || ch === '\'') {
      let j = i + 1;
      while (j < n) {
        if (text[j] === '\\') { j += 2; continue; }
        if (text[j] === ch) { j++; break; }
        if (text[j] === '\n') break;
        j++;
      }
      out += text.slice(i, j);
      i = j;
      continue;
    }
    if (ch === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      i = end === -1 ? n : end + 2;
      continue;
    }
    /* Пробелы вне строк: ряд схлопывается в один. Полностью убирать их вокруг
     * `{`, `}`, `;` нельзя одним правилом — пробел в селекторе значим
     * (`.a .b` и `.a.b` — разные вещи), а отступы в этом файле трёхуровневые.
     * Один пробел вместо ряда безопасен везде и снимает всю раскладку файла.
     */
    if (/\s/.test(ch)) {
      let j = i;
      while (j < n && /\s/.test(text[j])) j++;
      out += ' ';
      i = j;
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

// Чистка по расширению файла. Всё незнакомое отдаётся нетронутым.
function forFile(file, buffer) {
  const ext = String(file).toLowerCase();
  if (ext.endsWith('.css')) return Buffer.from(css(buffer.toString('utf8')));
  if (ext.endsWith('.js')) return Buffer.from(js(buffer.toString('utf8')));
  return buffer;
}

module.exports = { js, css, forFile };
