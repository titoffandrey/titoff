/* Телефон покупателя: страна по коду, флаг и живое форматирование ввода.
 *
 * ОДИН ФАЙЛ НА СЕРВЕР И ВИТРИНУ — по тому же правилу, что список способов
 * доставки: разъехавшиеся таблицы означали бы номер, который витрина
 * отформатировала и приняла, а `/api/order` потом отверг. Лежит в `public/`,
 * потому что его грузит браузер (кэшируется как обычная статика, отдаётся
 * только на странице оформления); сервер подключает его обычным `require`.
 *
 * Схема взята с форм регистрации Ozon, Яндекса и Telegram и делает ровно то же:
 *
 *   • поле одно, и в нём всегда международный номер с «+»;
 *   • страна НЕ выбирается списком — она определяется по набранному коду, и
 *     слева в поле стоит её флаг;
 *   • по умолчанию Россия, и она же в приоритете: «+7» — это Россия, а
 *     Казахстан, который делит с ней код, узнаётся по «+7 6…» и «+7 7…»;
 *   • ввод форматируется по маске страны прямо во время набора, каретка при
 *     этом остаётся на своём месте, а Backspace съедает цифру, а не разделитель;
 *   • привычная местная запись исправляется сама: «8 (999) 123-45-67» и
 *     «9991234567» становятся «+7 999 123-45-67».
 *
 * Ни одного внешнего запроса и ни одной зависимости: вся работа — разбор строки
 * по таблице префиксов (сотые доли миллисекунды), таблица разбирается один раз
 * при загрузке.
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;   // сервер
  if (root) root.Phone = api;                                              // витрина
})(typeof window !== 'undefined' ? window : null, function () {
  'use strict';

  var DEFAULT = 'RU';          // страна по умолчанию и она же в приоритете
  var MAX_DIGITS = 15;         // потолок E.164; длиннее номеров не бывает
  var MIN_NATIONAL = 4;        // короче — это не номер, а обрывок

  /* Таблица: «префикс|ISO|маска|транк».
   *
   * ПРЕФИКС — цифры, по которым узнаётся страна. Обычно это код страны, но у
   * стран, делящих код, он длиннее: у Казахстана «76» и «77», потому что «7» —
   * это Россия. Побеждает самое длинное совпадение, поэтому порядок строк
   * значения не имеет.
   *
   * МАСКА покрывает ВЕСЬ номер, включая код страны: «# ### ###-##-##» — это
   * «+7 999 123-45-67». Число решёток задаёт и длину номера: она же и
   * проверяется. Маски выписаны там, где длина у страны одна и известна, —
   * это весь СНГ и десяток стран, откуда реально пишут. У остальных маски нет
   * вовсе: номер группируется по три цифры, а длина проверяется по E.164
   * (7–15 цифр). Врать про формат хуже, чем показать номер как есть.
   *
   * ТРАНК — местная цифра перед номером («8» у нас, «0» почти везде). Нужна
   * ровно для одного: убрать её, когда покупатель по привычке набрал «+7 8 999…»
   * (см. `parse`). Не указана — «0».
   */
  var LIST = [
    // СНГ — сюда приходит почти весь трафик магазина
    '7|RU|# ### ###-##-##|8',
    '76|KZ|# ### ###-##-##|8', '77|KZ|# ### ###-##-##|8',
    '375|BY|### ## ###-##-##|8',
    '380|UA|### ## ###-##-##',
    '998|UZ|### ## ###-##-##|8',
    '996|KG|### ### ### ###',
    '992|TJ|### ## ### ####|8',
    '993|TM|### ## ######|8',
    '374|AM|### ## ######',
    '994|AZ|### ## ### ## ##',
    '995|GE|### ### ## ## ##',
    '373|MD|### ## ### ###',
    // Куда чаще всего уезжают и откуда пишут
    '1|US|# (###) ###-####', '44|GB|## #### ######', '49|DE', '90|TR|## ### ### ## ##',
    '972|IL|### ## ### ####', '971|AE|### ## ### ####', '86|CN|## ### #### ####',
    '91|IN|## ##### #####', '48|PL|## ### ### ###', '370|LT|### ### #####',
    '371|LV|### ## ### ###', '372|EE', '357|CY', '381|RS', '382|ME', '385|HR',
    '386|SI', '387|BA', '389|MK', '420|CZ', '421|SK', '423|LI',
    // Дальше — только флаг и код: длина у этих стран плавает, и придумывать ей
    // маску значило бы отказывать в приёме верного номера.
    '20|EG', '27|ZA', '30|GR', '31|NL', '32|BE', '33|FR', '34|ES', '36|HU', '39|IT',
    '40|RO', '41|CH', '43|AT', '45|DK', '46|SE', '47|NO', '51|PE', '52|MX', '53|CU',
    '54|AR', '55|BR', '56|CL', '57|CO', '58|VE', '60|MY', '61|AU', '62|ID', '63|PH',
    '64|NZ', '65|SG', '66|TH', '81|JP', '82|KR', '84|VN', '92|PK', '93|AF', '94|LK',
    '95|MM', '98|IR',
    '211|SS', '212|MA', '213|DZ', '216|TN', '218|LY', '220|GM', '221|SN', '222|MR',
    '223|ML', '224|GN', '225|CI', '226|BF', '227|NE', '228|TG', '229|BJ', '230|MU',
    '231|LR', '232|SL', '233|GH', '234|NG', '235|TD', '236|CF', '237|CM', '238|CV',
    '239|ST', '240|GQ', '241|GA', '242|CG', '243|CD', '244|AO', '245|GW', '248|SC',
    '249|SD', '250|RW', '251|ET', '252|SO', '253|DJ', '254|KE', '255|TZ', '256|UG',
    '257|BI', '258|MZ', '260|ZM', '261|MG', '262|RE', '263|ZW', '264|NA', '265|MW',
    '266|LS', '267|BW', '268|SZ', '269|KM', '290|SH', '291|ER', '297|AW', '298|FO',
    '299|GL',
    '350|GI', '351|PT', '352|LU', '353|IE', '354|IS', '355|AL', '356|MT', '358|FI',
    '359|BG', '376|AD', '377|MC', '378|SM', '379|VA', '383|XK',
    '500|FK', '501|BZ', '502|GT', '503|SV', '504|HN', '505|NI', '506|CR', '507|PA',
    '508|PM', '509|HT', '590|GP', '591|BO', '592|GY', '593|EC', '594|GF', '595|PY',
    '596|MQ', '597|SR', '598|UY', '599|CW',
    '670|TL', '672|NF', '673|BN', '674|NR', '675|PG', '676|TO', '677|SB', '678|VU',
    '679|FJ', '680|PW', '681|WF', '682|CK', '683|NU', '685|WS', '686|KI', '687|NC',
    '688|TV', '689|PF', '690|TK', '691|FM', '692|MH',
    '850|KP', '852|HK', '853|MO', '855|KH', '856|LA', '880|BD', '886|TW',
    '960|MV', '961|LB', '962|JO', '963|SY', '964|IQ', '965|KW', '966|SA', '967|YE',
    '968|OM', '970|PS', '973|BH', '974|QA', '975|BT', '976|MN', '977|NP'
  ];

  var BY_PREFIX = {};
  var LONGEST = 0;
  for (var n = 0; n < LIST.length; n++) {
    var f = LIST[n].split('|');
    var mask = f[2] || '';
    var hashes = 0;
    for (var h = 0; h < mask.length; h++) if (mask.charAt(h) === '#') hashes++;
    BY_PREFIX[f[0]] = {
      prefix: f[0], iso: f[1], mask: mask, trunk: f[3] || '0',
      // Маска есть — длина у страны одна и проверяется точно. Нет — принимаем
      // всё, что похоже на номер по E.164.
      min: hashes || (f[0].length + MIN_NATIONAL),
      max: hashes || MAX_DIGITS
    };
    if (f[0].length > LONGEST) LONGEST = f[0].length;
  }
  var DEF = null;
  for (var key in BY_PREFIX) if (BY_PREFIX[key].iso === DEFAULT) { DEF = BY_PREFIX[key]; break; }

  function onlyDigits(value) { return String(value == null ? '' : value).replace(/\D+/g, ''); }

  /* Страна по цифрам номера: побеждает самое длинное совпадение префикса.
   * Отсюда и приоритет России: «7» — это она, а Казахстан отбирают более
   * длинные «76» и «77». Цифр нет вовсе — страны нет, и витрина покажет флаг
   * страны по умолчанию. */
  function detect(digits) {
    var d = String(digits || '');
    for (var len = Math.min(LONGEST, d.length); len > 0; len--) {
      var hit = BY_PREFIX[d.slice(0, len)];
      if (hit) return hit;
    }
    return null;
  }

  /* Местная запись без «+»: «8 (999) 123-45-67» и «999 123-45-67» — это наш
   * номер, и оба приводятся к «+7 999…». Одиннадцать и больше цифр без «+»
   * трогать нельзя: это уже полный международный номер. */
  function fromLocal(d) {
    if (!DEF) return d;
    var national = DEF.max - DEF.prefix.length;
    if (d.charAt(0) === DEF.trunk && d.length > national) return DEF.prefix + d.slice(1);
    if (d.length <= national) return DEF.prefix + d;
    return d;
  }

  /* Разбор строки в цифры и страну. Ничего не обрезает: лишние цифры обязан
   * увидеть тот, кто проверяет (`check`), иначе сервер молча записал бы
   * укороченный номер. */
  function parse(raw) {
    var s = String(raw == null ? '' : raw);
    /* Вставка поверх уже подставленного «+7 »: номером считаем всё от
     * ПОСЛЕДНЕГО «+». Иначе «+7 » + вставленный «+375 29 …» дали бы «+7375…» —
     * номер, которого не бывает. */
    var plus = s.lastIndexOf('+');
    if (plus > 0) s = s.slice(plus);
    var typedPlus = plus > -1;
    var d = onlyDigits(s);
    if (!d) return { digits: '', country: null, plus: typedPlus };
    if (!typedPlus) d = fromLocal(d);

    var country = detect(d);
    /* «+7 8 999 123-45-67»: местная восьмёрка после кода страны. Убираем её
     * ТОЛЬКО когда без неё номер как раз укладывается в маску — иначе пострадал
     * бы честный «+7 800 555-35-35», у которого восьмёрка своя. */
    if (country && country.mask && d.length === country.max + 1) {
      var at = country.prefix.length;
      if (d.charAt(at) === country.trunk) {
        d = d.slice(0, at) + d.slice(at + 1);
        country = detect(d);                 // «+7 8 705…» после чистки — Казахстан
      }
    }
    return { digits: d, country: country, plus: typedPlus };
  }

  // Цифры сверх маски (или у страны без маски) — группами по три; одинокая
  // цифра в хвосте прилипает к предыдущей группе, чтобы не висеть отдельно.
  function grouped(digits, country) {
    var parts = [];
    var head = country ? Math.min(country.prefix.length, digits.length) : 0;
    if (head) parts.push(digits.slice(0, head));
    var rest = digits.slice(head);
    for (var i = 0; i < rest.length;) {
      var take = rest.length - i === 4 ? 4 : 3;
      parts.push(rest.slice(i, i + take));
      i += take;
    }
    return '+' + parts.join(' ');
  }

  /* Номер по маске страны. Разделитель ставится только перед следующей цифрой,
   * поэтому недобранный номер не заканчивается висящей скобкой или дефисом.
   *
   * Цифры сверх маски ОТБРАСЫВАЮТСЯ — так же, как в формах Ozon и Яндекса.
   * Ради этого всё и затевалось: скопированный «+7 (999) 123-45-67 доб. 12»
   * становится нормальным номером, а не отказом «лишние цифры» на верном
   * номере. Проверка длины при этом остаётся (`check` смотрит на неразобранную
   * строку) — она ловит заведомо чужие данные, присланные мимо формы. */
  function paint(digits, country) {
    if (!digits) return '';
    if (!country || !country.mask) return grouped(digits.slice(0, MAX_DIGITS), country);
    var d = digits.slice(0, country.max);
    var out = '+', at = 0;
    for (var i = 0; i < country.mask.length && at < d.length; i++) {
      var ch = country.mask.charAt(i);
      if (ch === '#') out += d.charAt(at++);
      else out += ch;
    }
    return out;
  }

  // Готовая строка для поля ввода и для показа в панели: «+7 999 123-45-67».
  function format(value) {
    var res = parse(value);
    if (!res.digits) return res.plus ? '+' : '';
    return paint(res.digits, res.country);
  }

  // Флаг страны — эмодзи из пары региональных индикаторов, как у карточек
  // метрики (lib/client-icons.js): двести флагов в SVG в репозиторий не
  // положишь, а внешние адреса запрещены CSP. Где системного набора нет
  // (Windows), останутся две буквы кода — тоже понятная подпись.
  function flag(iso) {
    var code = String(iso || '').toUpperCase();
    if (!/^[A-Z]{2}$/.test(code)) return '';
    return String.fromCodePoint(0x1f1e6 + code.charCodeAt(0) - 65, 0x1f1e6 + code.charCodeAt(1) - 65);
  }

  /* Проверка номера — одна на витрину и сервер, поэтому и текст отказа один:
   * покупатель не должен увидеть от сервера другую формулировку, чем ту, что
   * ему уже показала форма. */
  function check(value) {
    var res = parse(value);
    if (!res.digits) return { ok: false, error: 'Укажите номер телефона' };
    if (!res.country) return { ok: false, error: 'Не узнаём код страны — проверьте номер' };
    if (res.digits.length < res.country.min) return { ok: false, error: 'Номер телефона неполный' };
    if (res.digits.length > res.country.max) return { ok: false, error: 'В номере телефона лишние цифры' };
    return {
      ok: true,
      e164: '+' + res.digits,                 // так номер и хранится в заказе
      text: paint(res.digits, res.country),
      country: res.country.iso
    };
  }

  // Хранимое значение: либо номер в E.164, либо пусто. Заказ пишет именно его,
  // а показывает `format()` — разбирать строку по-разному в двух местах нельзя.
  function store(value) {
    var res = check(value);
    return res.ok ? res.e164 : '';
  }

  /* ===== Поле ввода ===== */

  function isDigit(ch) { return ch >= '0' && ch <= '9'; }
  function digitsBefore(text, pos) {
    var n = 0;
    for (var i = 0; i < pos && i < text.length; i++) if (isDigit(text.charAt(i))) n++;
    return n;
  }
  function caretAfter(text, count) {
    if (count <= 0) return text.charAt(0) === '+' ? 1 : 0;
    var n = 0;
    for (var i = 0; i < text.length; i++) {
      if (isDigit(text.charAt(i)) && ++n === count) return i + 1;
    }
    return text.length;
  }
  function setCaret(input, pos) {
    try { input.setSelectionRange(pos, pos); } catch (e) {}
  }

  /* Перерисовка поля.
   *
   * Каретка держится за ЦИФРАМИ, а не за позицией в строке: после вставки
   * разделителя позиция сдвигается, а «третья цифра слева» остаётся третьей.
   * Значение присваивается только когда оно правда изменилось — присвоение
   * само по себе уводит каретку в конец. */
  function redraw(input, flagEl) {
    var pos = input.selectionStart;
    var atEnd = pos == null || pos >= input.value.length;
    var want = atEnd ? -1 : digitsBefore(input.value, pos);
    var res = parse(input.value);
    var text = res.digits ? paint(res.digits, res.country) : (res.plus ? '+' : '');
    if (text !== input.value) {
      input.value = text;
      if (!atEnd) setCaret(input, caretAfter(text, want));
    }
    if (flagEl) flagEl.textContent = flag((res.country && res.country.iso) || DEFAULT);
    return res;
  }

  /* Привязка к полю. Флаг ищется рядом с полем — своей разметки скрипт не
   * создаёт, чтобы поле работало (просто без форматирования) и там, где файл не
   * загрузился. */
  function attach(input) {
    if (!input || input.getAttribute('data-phone') === 'on') return;
    input.setAttribute('data-phone', 'on');
    var flagEl = input.parentNode ? input.parentNode.querySelector('.phone-flag') : null;

    /* Backspace по разделителю обязан съедать ЦИФРУ, а не пробел с дефисом:
     * иначе разделитель стирается, форматирование возвращает его на место, и
     * покупателю кажется, что клавиша не работает. */
    input.addEventListener('keydown', function (e) {
      if (e.key !== 'Backspace' || e.ctrlKey || e.metaKey || e.altKey) return;
      var i = input.selectionStart;
      if (i == null || i !== input.selectionEnd || i <= 0) return;   // выделение удалит браузер
      if (isDigit(input.value.charAt(i - 1))) return;                // перед кареткой цифра — обычное поведение
      var j = i - 1;
      while (j > 0 && !isDigit(input.value.charAt(j - 1))) j--;
      if (j <= 0) return;                                            // слева остался только «+»
      e.preventDefault();
      input.value = input.value.slice(0, j - 1) + input.value.slice(i);
      setCaret(input, j - 1);
      redraw(input, flagEl);
    });

    input.addEventListener('input', function () { redraw(input, flagEl); });
    // Автозаполнение браузера приходит в любом виде — приводим к своему.
    input.addEventListener('change', function () { redraw(input, flagEl); });

    // Пустое поле открывается кодом страны по умолчанию — как в форме Ozon:
    // покупателю остаётся набрать сам номер.
    input.addEventListener('focus', function () {
      if (input.value) return;
      input.value = '+' + (DEF ? DEF.prefix : '') + ' ';
      setCaret(input, input.value.length);
      if (flagEl) flagEl.textContent = flag(DEFAULT);
    });

    /* Ушли, оставив один код страны, — очищаем поле. «+7» это не номер, а
     * пустое поле честно показывает подсказку и требует заполнения. */
    input.addEventListener('blur', function () {
      var res = parse(input.value);
      var only = res.country ? res.country.prefix.length : 0;
      if (res.digits.length <= only) { input.value = ''; }
      else redraw(input, flagEl);
      if (flagEl && !input.value) flagEl.textContent = flag(DEFAULT);
    });

    redraw(input, flagEl);
  }

  return {
    DEFAULT: DEFAULT,
    parse: parse, detect: detect, format: format, flag: flag,
    check: check, store: store, attach: attach
  };
});
