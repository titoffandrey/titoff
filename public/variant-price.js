'use strict';
/* ============ Полная цена варианта ↔ доплата: одна арифметика на три редактора
 *
 * В форме товара цена варианта вводится ПОЛНОЙ — «сколько стоит товар с этой
 * памятью / с этим ремешком / с этим значением», — а в хранилище лежит ДОПЛАТА к
 * базовой цене. Перевод одного в другое повторялся слово в слово в трёх файлах
 * (`color-editor.js`, `option-editor.js`, `band-editor.js`) и различался там
 * только именами классов; теперь он здесь.
 *
 * ГЛАВНОЕ ПРАВИЛО, ради которого всё и заводилось: ДОПЛАТА — СВОЙСТВО ВАРИАНТА.
 * При смене базовой цены пересчитываются ПОЛЯ полных цен, а сами доплаты
 * остаются. Обратный порядок (считать доплату как «полная цена из поля минус
 * текущая база») стоил ночи потерянных правок: владелец снижал цену iPhone с
 * 76 990 до 66 990, поля полных цен оставались прежними — и базовое значение
 * группы получало доплату +10 000, то есть витрина показывала ровно прежнюю
 * цену. У товара с несколькими группами разница складывалась по разу на группу и
 * цена не оставалась прежней, а росла. Отсюда `dataset.add` у строки как
 * единственный источник доплаты и `reprice()` при правке базовой цены.
 *
 * ОТРИЦАТЕЛЬНУЮ ДОПЛАТУ НЕ ГЛОТАЕМ МОЛЧА. Раньше здесь стоял `Math.max(0, …)`:
 * владелец вписывал цену ниже базовой, видел «Сохранено» и после перезагрузки —
 * базовую цену вместо своей, без единого слова. Теперь введённое остаётся в
 * поле, строка подсвечивается, а отказ с объяснением даёт сервер
 * (`validateProduct` в server.js) — по тому же правилу, что и вся форма:
 * проверка до записи, и сказать, что именно не так.
 */
(function () {
  function baseField() { return document.querySelector('input[name="price"]'); }

  /* editor        — контейнер редактора (в нём ищутся строки);
   * rowSelector   — строка одного варианта;
   * priceSelector — поле полной цены внутри строки;
   * format        — как показать число в поле (у памяти оно с разделителями).
   */
  function VariantPrice(editor, rowSelector, priceSelector, format) {
    const show = format || function (n) { return String(n); };
    function base() { const el = baseField(); return Number(el && el.value) || 0; }
    function priceInput(row) { return row.querySelector(priceSelector); }

    // Доплата строки. Пустая строка — «цена ещё не введена»: такую при смене
    // базовой цены не трогаем, иначе у новой строки появлялся бы ноль.
    function addOf(row) {
      const v = row.dataset.add;
      return v == null || v === '' ? 0 : Number(v) || 0;
    }
    // Прочитать введённую полную цену и запомнить доплату у строки.
    function readAdd(row) {
      const field = priceInput(row);
      const text = String(field ? field.value : '').replace(/\s+/g, '').replace(',', '.');
      const price = Number(text);
      row.dataset.add = (text === '' || isNaN(price)) ? '' : String(Math.round(price - base()));
      row.classList.toggle('row-cheap', row.dataset.add !== '' && addOf(row) < 0);
    }
    // Базовая цена изменилась — перерисовать поля полных цен из доплат.
    function reprice() {
      editor.querySelectorAll(rowSelector).forEach(function (row) {
        if (row.dataset.add == null || row.dataset.add === '') return;
        const field = priceInput(row);
        if (field) field.value = show(base() + addOf(row));
      });
    }
    // Поставить строке уже известную доплату (при сборке редактора из данных).
    function setAdd(row, add) {
      const known = add != null && add !== '' && isFinite(Number(add));
      row.dataset.add = known ? String(Math.round(Number(add))) : '';
      const field = priceInput(row);
      if (field) field.value = known ? show(base() + Math.round(Number(add))) : '';
      row.classList.toggle('row-cheap', known && Number(add) < 0);
    }
    // Пересчёт полей вешается на правку базовой цены — один раз на редактор.
    function watchBase(sync) {
      const el = baseField();
      if (el) el.addEventListener('input', function () { reprice(); sync(); });
    }
    return { base, addOf, readAdd, reprice, setAdd, watchBase };
  }

  window.VariantPrice = VariantPrice;
})();
