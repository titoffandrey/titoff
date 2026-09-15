/* Комиссия платёжного сервиса: один расчёт для оформления и сервера.
 * Расчёт целочисленный: итоги в копейках, база API в десятитысячных рубля,
 * процент — в сотых долях процента. */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.PaymentFee = api;
})(typeof window !== 'undefined' ? window : null, function () {
  'use strict';

  function hundredths(value) {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return null;
    var parts = String(value).match(/^(\d+)(?:\.(\d{1,2}))?$/);
    if (!parts) return null;
    var minor = Number(parts[1]) * 100 + Number((parts[2] || '').padEnd(2, '0'));
    return Number.isSafeInteger(minor) ? minor : null;
  }

  function quote(baseAmount, percent) {
    var base = hundredths(baseAmount);
    var rate = hundredths(percent);
    if (base === null || rate === null || rate > 10000) return null;
    var product = base * rate;
    if (!Number.isSafeInteger(product)) return null;
    // Половина копейки округляется вверх; двоичная дробь здесь не участвует.
    var fee = Math.floor(product / 10000) + (product % 10000 >= 5000 ? 1 : 0);
    if (!Number.isSafeInteger(base + fee)) return null;
    return { baseAmount: base / 100, amount: fee / 100, percent: rate / 100, total: (base + fee) / 100 };
  }

  function roundRatio(numerator, denominator) {
    return Math.floor(numerator / denominator) + (numerator % denominator * 2 >= denominator ? 1 : 0);
  }

  // Покупатель платит прежний итог. Platega начисляет свой процент на базу,
  // поэтому обратный расчёт — total / (1 + percent / 100), а не вычитание %.
  // База API допускает четыре знака: с двумя некоторые итоги недостижимы
  // (например, 1100 ₽ при 8,5%). Итог покупателя всегда остаётся в копейках.
  function included(totalAmount, percent) {
    var total = hundredths(totalAmount);
    var rate = hundredths(percent);
    if (total === null || rate === null || rate > 10000) return null;
    var numerator = total * 1000000;
    if (!Number.isSafeInteger(numerator)) return null;
    var base = roundRatio(numerator, 10000 + rate);
    var gross = base * (10000 + rate);
    if (!Number.isSafeInteger(gross)) return null;
    function charged(value) { return roundRatio(value, 100) + roundRatio(value * rate, 1000000); }
    // Platega округляет комиссию отдельно. У самой границы полкопейки
    // прямое деление может дать лишнюю копейку (1001,20 → 922,7650).
    // Берём ближайшую четырёхзначную базу с ТОЧНЫМ фактическим итогом.
    // Функция монотонна; перескок через итог означает, что он недостижим.
    var direction = charged(base) > total ? -1 : 1;
    var steps = 0;
    while (charged(base) !== total && steps < 100) {
      base += direction;
      steps++;
      if (base < 0 || (direction > 0 ? charged(base) > total : charged(base) < total)) return null;
    }
    if (charged(base) !== total) return null;
    var fee = base * rate;
    if (!Number.isSafeInteger(fee)) return null;
    return { mode: 'included', baseAmount: base / 10000,
      amount: roundRatio(fee, 1000000) / 100, percent: rate / 100, total: total / 100 };
  }

  // Общая форма показывает исходную базу плюс округлённую комиссию. Поэтому
  // там по возможности используем базу в копейках: у 35 500 ₽ это 32 718,89 ₽,
  // а четырёхзначная база дала бы на странице лишние 0,004 ₽.
  function includedCents(totalAmount, percent) {
    var total = hundredths(totalAmount);
    var rate = hundredths(percent);
    if (total === null || rate === null || rate > 10000) return null;
    var numerator = total * 10000;
    if (!Number.isSafeInteger(numerator)) return null;
    // Если точная база в копейках существует, это ближайшее целое к обратному
    // расчёту: округление комиссии изменяет результат не более чем на полкопейки.
    var base = roundRatio(numerator, 10000 + rate);
    var result = quote(base / 100, percent);
    if (!result || result.total !== totalAmount) return null;
    return { mode: 'included', rounding: 'cents', baseAmount: result.baseAmount,
      amount: result.amount, percent: result.percent, total: result.total };
  }

  // Для новых платежей Platega выбираем ближайший достижимый итог в целых
  // рублях. Скидка ограничена одним рублём от исходной суммы; если этого
  // недостаточно, вызывающий код должен явно обработать отказ расчёта.
  function roundedIncluded(totalAmount, percent) {
    var original = hundredths(totalAmount);
    var rate = hundredths(percent);
    if (original === null || rate === null || rate > 10000) return null;
    var target = Math.floor(original / 100) * 100;
    while (target >= 0 && original - target <= 100) {
      var result = includedCents(target / 100, rate / 100);
      if (result) {
        return { mode: result.mode, rounding: 'rubles', baseAmount: result.baseAmount,
          amount: result.amount, percent: result.percent, total: result.total,
          originalTotal: original / 100, discount: (original - target) / 100 };
      }
      target -= 100;
    }
    return null;
  }

  // Пока итог не представим точной базой в копейках, сохраняем прежний расчёт:
  // эта функция не повышает цену и не создаёт скрытую скидку. Старые снимки
  // продолжают проверяться непосредственно через included().
  function hosted(totalAmount, percent) {
    return includedCents(totalAmount, percent) || included(totalAmount, percent);
  }

  // До выбора кассы итог оформления остаётся прежним. Отдельный paymentTotal
  // применяется только к Platega; null скрывает этот способ, если скидки 1 ₽
  // недостаточно. Другие кассы при этом могут принять исходную сумму.
  function checkout(totalAmount, percent) {
    var total = hundredths(totalAmount), rate = hundredths(percent);
    if (total === null || rate === null || rate > 10000) return null;
    var rounded = roundedIncluded(totalAmount, percent);
    return rounded ? Object.assign({}, rounded, { total: totalAmount, paymentTotal: rounded.total })
      : { mode: 'included', rounding: 'rubles', originalTotal: totalAmount,
        total: totalAmount, paymentTotal: null, discount: 0,
        baseAmount: null, amount: 0, percent: percent };
  }

  // quote остаётся прежним для проверки заказов, оформленных с доплатой.
  return { quote: quote, included: included, includedCents: includedCents,
    roundedIncluded: roundedIncluded, hosted: hosted, checkout: checkout };
});
