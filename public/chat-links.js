/* Ссылки в реплике консультанта: покупатель видит НАЗВАНИЕ ТОВАРА, а не адрес.
 *
 * Раньше бот писал адрес голым — «айфон 17 есть от 52 990 ₽: /product/iphone-17»,
 * — и витрина превращала в ссылку сам адрес. В переписке это выглядит как
 * технический мусор, вылезший наружу: строка со слэшами посреди человеческой
 * фразы, по которой ещё надо догадаться, что на неё жмут. Теперь формат один:
 *
 *     [Айфон 17 Pro](/product/iphone-17-pro)
 *
 * и покупатель видит «👉 Айфон 17 Pro» ссылкой. Скобки пишет модель (так ей
 * велят правила в lib/chat-prompt.js), а забыла — за неё это делает сервер:
 * `withNames()` подставляет название из живого каталога по id.
 *
 * ОДИН ФАЙЛ НА СЕРВЕР И ВИТРИНУ — по тому же правилу, что `public/phone.js` и
 * список способов доставки: своя копия разбора в браузере разъехалась бы с
 * серверной, и покупатель видел бы в окне одно, а менеджер в панели другое.
 * Лежит в `public/`, потому что его грузит браузер (обычной статикой, только
 * когда чат включён); сервер и панель подключают его через `require`.
 *
 * Разметкой ничего из этого не становится: наружу отдаются ТОКЕНЫ, а узлы и
 * экранирование остаются за тем, кто рисует, — в браузере это `createElement`,
 * в панели `esc()`.
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;   // сервер и панель
  if (root) root.ChatLinks = api;                                          // витрина
})(typeof window !== 'undefined' ? window : null, function () {
  'use strict';

  /* Куда консультанту вообще есть смысл ссылаться. Список закрытый: адрес
   * уезжает в `href`, и чужая схема ведёт неизвестно куда. Внешние ссылки — по
   * старому правилу, только http(s) и с явным хостом. */
  var PATHS = 'product|checkout|warranty|returns|privacy';
  var MD = '\\[([^\\]\\n]{1,80})\\]\\((\\/(?:' + PATHS + ')[^\\s)]*|https?:\\/\\/[^\\s)]+)\\)';
  var BARE = '(?:https?:\\/\\/[^\\s<>"]+|\\/(?:' + PATHS + ')[^\\s<>",;]*)';
  var TOKEN = new RegExp(MD + '|(' + BARE + ')', 'g');
  var PRODUCT = /^\/product\/([a-z0-9-]+)\/?$/;

  /* Незакрытая ссылка в конце РАСТУЩЕГО ответа.
   *
   * Ответ печатается по буквам, поэтому на середине строки в ленте стоит
   * «смотрите [Айфон 17](/produ» — то есть ровно та разметка, которую мы от
   * покупателя и прячем. Показываем в этот момент только название: оно и есть
   * то, что он увидит, когда ссылка закроется, — текст не дёргается. */
  var OPEN = /\[([^\][\n]{0,80})(?:\]\([^\s)]*)?$/;

  function open(text) { return text.replace(OPEN, '$1'); }

  /* Разбор строки на куски: `{text}` — обычный текст, `{label, href}` — ссылка.
   * `growing` — про растущий ответ (см. `OPEN` выше). */
  function parts(text, growing) {
    var rest = String(text == null ? '' : text);
    if (growing) rest = open(rest);
    var out = [];
    var at = 0;
    var m;
    TOKEN.lastIndex = 0;
    while ((m = TOKEN.exec(rest))) {
      if (m.index > at) out.push({ text: rest.slice(at, m.index) });
      if (m[1]) {
        out.push({ label: m[1].trim() || m[2], href: m[2] });
        at = m.index + m[0].length;
        continue;
      }
      /* Знаки препинания в конец ссылки не забираем. Модель пишет адрес внутри
       * предложения («смотрите здесь: /product/iphone-17-pro-max.»), и точка,
       * попавшая в href, превращает живую ссылку в 404 — то есть ровно в тот
       * тупик, ради обхода которого ссылку и дают. */
      var href = m[3].replace(/[.,;:!?)»"']+$/, '');
      if (!href) { at = m.index; break; }
      out.push({ label: href, href: href });
      at = m.index + href.length;
    }
    if (at < rest.length) out.push({ text: rest.slice(at) });
    return out;
  }

  /* Голый адрес товара → ссылка с названием.
   *
   * Страховка на случай, когда модель забыла скобки: название приходит из
   * живого каталога, поэтому переврать его она уже не может. Каталог сюда не
   * подключается — id отдаётся наружу, название возвращает вызывающий.
   *
   * `growing` — про реплику, оборванную на полуслове (в разговор вошёл оператор
   * прямо посреди печати): недописанная ссылка сохраняется одним названием,
   * иначе в переписке навсегда остались бы скобки с обрезанным адресом. */
  function withNames(text, nameOf, growing) {
    return parts(text, growing).map(function (p) {
      if (p.text != null) return p.text;
      if (p.label !== p.href) return '[' + p.label + '](' + p.href + ')';
      var id = PRODUCT.exec(p.href);
      var name = id && nameOf ? String(nameOf(id[1]) || '') : '';
      return name ? '[' + name + '](' + p.href + ')' : p.href;
    }).join('');
  }

  /* Та же реплика для Telegram: там скобки читать некому, поэтому ссылка
   * разворачивается в «Название (/адрес)». */
  function plain(text) {
    return parts(text).map(function (p) {
      if (p.text != null) return p.text;
      return p.label === p.href ? p.href : p.label + ' (' + p.href + ')';
    }).join('');
  }

  return { parts: parts, withNames: withNames, plain: plain, PRODUCT: PRODUCT };
});
