'use strict';
/* Разбор CSS на ПРАВИЛА — ровно настолько, насколько это нужно критическим
 * стилям (`scripts/build-critical-css.js`) и тесту, который сторожит их
 * свежесть. Ни значений, ни селекторов разбор не понимает и понимать не
 * должен: правило для него — это `прелюдия{тело}`, вложенный блок (`@media`,
 * `@supports`) — прелюдия и список правил внутри, всё остальное (`@keyframes`,
 * `@font-face`) — непрозрачный кусок текста, который либо берётся целиком,
 * либо нет.
 *
 * Вход обязан быть без комментариев — их снимает `MIN.css()` (lib/minify.js),
 * через который идёт и отдача статики; здесь та же чистка зовётся первой
 * строкой, поэтому один и тот же файл, прочитанный с диска дважды, даёт один
 * и тот же список правил. Строки и скобки учитываются: `}` внутри `content:"}"`
 * и запятая внутри `:is(a,b)` — не границы.
 *
 * Дерево:
 *   {type:'rule', selector, body, text}     text = selector+'{'+body+'}'
 *   {type:'at',   name, prelude, rules[]}   @media, @supports, @container, @layer{}
 *   {type:'raw',  name, prelude, text}      @keyframes, @font-face, @page …
 *   {type:'stmt', text}                     @import …; @layer a,b;
 */
const MIN = require('./minify');

// @-правила, внутри которых лежат обычные правила, а не объявления.
const NESTED = new Set(['media', 'supports', 'container', 'layer', 'document', 'scope']);

function parse(source) {
  // Чистка дважды: первая снимает комментарии, вторая — двойной пробел на их
  // месте (пробел до комментария и пробел после него схлопываются порознь).
  // Иначе один и тот же файл давал бы разный текст правила до и после записи.
  const css = MIN.css(MIN.css(String(source || '')));
  let i = 0;
  const n = css.length;

  // Текст до `{` или `;` на нулевой глубине скобок и вне строк.
  function prelude() {
    const start = i;
    let depth = 0, q = null;
    while (i < n) {
      const c = css[i];
      if (q) { if (c === '\\') i++; else if (c === q) q = null; }
      else if (c === '"' || c === '\'') q = c;
      else if (c === '(' || c === '[') depth++;
      else if (c === ')' || c === ']') depth--;
      else if ((c === '{' || c === ';') && depth <= 0) break;
      i++;
    }
    return css.slice(start, i).trim();
  }

  // Содержимое блока до парной `}` — она съедается, наружу уходит только тело.
  function rawBlock() {
    const start = i;
    let depth = 1, q = null;
    while (i < n) {
      const c = css[i];
      if (q) { if (c === '\\') i++; else if (c === q) q = null; }
      else if (c === '"' || c === '\'') q = c;
      else if (c === '{') depth++;
      else if (c === '}') { depth--; if (!depth) break; }
      i++;
    }
    const body = css.slice(start, i).trim();
    i++;
    return body;
  }

  function block() {
    const out = [];
    while (i < n) {
      while (i < n && /\s/.test(css[i])) i++;
      if (i >= n) break;
      if (css[i] === '}') { i++; return out; }
      if (css[i] === ';') { i++; continue; }
      const head = prelude();
      if (i >= n || css[i] === ';') {
        i++;
        if (head) out.push({ type: 'stmt', text: head + ';' });
        continue;
      }
      i++; // `{`
      if (head[0] === '@') {
        const name = head.slice(1).split(/[\s({]/)[0].toLowerCase();
        if (NESTED.has(name)) out.push({ type: 'at', name, prelude: head, rules: block() });
        else {
          const body = rawBlock();
          out.push({ type: 'raw', name, prelude: head, text: head + '{' + body + '}' });
        }
      } else {
        const body = rawBlock();
        out.push({ type: 'rule', selector: head, body, text: head + '{' + body + '}' });
      }
    }
    return out;
  }
  return block();
}

// Дерево обратно в текст: по правилу на строку, вложенные блоки — своими
// строками. Пробелы разбор всё равно схлопывает, так что вид только для diff.
function stringify(nodes, indent) {
  const pad = indent || '';
  return nodes.map(node => {
    if (node.type === 'at') return pad + node.prelude + '{\n' + stringify(node.rules, pad + '  ') + '\n' + pad + '}';
    return pad + node.text;
  }).join('\n');
}

// Плоский список листьев с цепочкой обёрток: [{node, chain:[atNode, …]}].
function flatten(nodes, chain) {
  const out = [];
  for (const node of nodes) {
    if (node.type === 'at') out.push(...flatten(node.rules, (chain || []).concat(node)));
    else out.push({ node, chain: chain || [] });
  }
  return out;
}

// Список селекторов правила: запятые верхнего уровня, скобки и строки не в счёт.
function splitSelectors(selector) {
  const out = [];
  let depth = 0, q = null, start = 0;
  const s = String(selector || '');
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) { if (c === '\\') i++; else if (c === q) q = null; }
    else if (c === '"' || c === '\'') q = c;
    else if (c === '(' || c === '[') depth++;
    else if (c === ')' || c === ']') depth--;
    else if (c === ',' && depth === 0) { out.push(s.slice(start, i).trim()); start = i + 1; }
  }
  out.push(s.slice(start).trim());
  return out.filter(Boolean);
}

// Ключ листа с учётом обёрток: по нему правило критического файла ищется в
// полном. Прелюдии обёрток входят целиком — `@media(max-width:800px)` и
// `@media(min-width:801px)` с одинаковым правилом внутри различаются.
function leafKey(leaf) {
  return leaf.chain.map(a => a.prelude).concat(leaf.node.text).join('\n');
}

module.exports = { parse, stringify, flatten, splitSelectors, leafKey, NESTED };
