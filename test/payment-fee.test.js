'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const FEE = require('../public/payment-fee');

test('включённая комиссия сохраняет цену и вычисляет обратную базу для Platega', () => {
  for (const [total, baseAmount, amount] of [[1000, 921.659, 78.34], [1100, 1013.8249, 86.18],
    [1034, 952.9954, 81], [1000.25, 921.8894, 78.36], [1001.2, 922.7649, 78.44]]) {
    assert.deepEqual(FEE.included(total, 8.5), { mode: 'included', total, baseAmount, amount, percent: 8.5 });
  }
  assert.notEqual(FEE.quote(1013.82, 8.5).total, 1100);
  assert.notEqual(FEE.quote(1013.83, 8.5).total, 1100);
  assert.deepEqual(FEE.included(1100, 0), { mode: 'included', total: 1100, baseAmount: 1100, amount: 0, percent: 0 });
  assert.equal(FEE.included(1100, 12).total, 1100);
  assert.notEqual(FEE.included(1100, 12).baseAmount, FEE.included(1100, 8.5).baseAmount);
  assert.deepEqual(FEE.quote(1000.25, 8.5), { total: 1085.27, baseAmount: 1000.25, amount: 85.02, percent: 8.5 });
});

test('обратный расчёт даёт точный округлённый итог для копеек, разных ставок и пределов заказа', () => {
  // Независимая целочисленная проверка результата, включая пропуски обратной
  // функции при двух знаках базы и границы допустимого процента.
  const rates = [0, 1, 100, 425, 850, 1200, 5000];
  for (const rate of rates) {
    for (const start of [0, 100000, 24999000]) {
      for (let minor = start; minor <= start + 1000; minor++) {
        const q = FEE.included(minor / 100, rate / 100);
        if (!q) {
          assert.notEqual(rate, 850, 'проверенный тариф 8,5% позволяет любой итог');
          const center = (BigInt(minor) * 1000000n + BigInt(10000 + rate) / 2n) / BigInt(10000 + rate);
          for (let b = center > 100n ? center - 100n : 0n; b <= center + 100n; b++) {
            const possible = (b + 50n) / 100n + (b * BigInt(rate) + 500000n) / 1000000n;
            assert.notEqual(possible, BigInt(minor), 'отказ только при недостижимом итоге');
          }
          continue;
        }
        const base = BigInt(Math.round(q.baseAmount * 10000));
        const gross = (base + 50n) / 100n + (base * BigInt(rate) + 500000n) / 1000000n;
        assert.equal(gross, BigInt(minor));
        assert.equal(q.total, minor / 100);
        assert.ok(q.baseAmount <= q.total);
      }
    }
  }
  assert.equal(FEE.included(1000.01, 100), null, 'при 100% нечётный итог в копейках недостижим');
  assert.equal(FEE.included(1000, 100).total, 1000);
});

test('обратный расчёт отклоняет неточные, некорректные и слишком большие исходные значения', () => {
  for (const value of [-1, NaN, Infinity, null, true, '1000', 1000.001, Number.MAX_SAFE_INTEGER]) {
    assert.equal(FEE.included(value, 8.5), null);
  }
  for (const rate of [-1, 100.01, NaN, Infinity, null, true, '8.5', 8.501]) {
    assert.equal(FEE.included(1000, rate), null);
  }
});

test('общая форма получает точную базу в копейках без дробного остатка сверх суммы заказа', () => {
  for (const [total, baseAmount, amount] of [[35500, 32718.89, 2781.11],
    [78100, 71981.57, 6118.43], [28000, 25806.45, 2193.55], [2500, 2304.15, 195.85],
    [1000, 921.66, 78.34]]) {
    const expected = { mode: 'included', rounding: 'cents', total, baseAmount, amount, percent: 8.5 };
    assert.deepEqual(FEE.includedCents(total, 8.5), expected);
    assert.deepEqual(FEE.hosted(total, 8.5), expected);
  }
  assert.equal(FEE.included(35500, 8.5).baseAmount, 32718.894, 'база старого снимка не меняется');
  assert.deepEqual(FEE.includedCents(1000.25, 0), {
    mode: 'included', rounding: 'cents', total: 1000.25, baseAmount: 1000.25, amount: 0, percent: 0
  });
});

test('недостижимая база в копейках не меняет цену и оставляет прежний обратный расчёт', () => {
  for (const total of [1100, 1034]) {
    assert.equal(FEE.includedCents(total, 8.5), null);
    assert.deepEqual(FEE.hosted(total, 8.5), FEE.included(total, 8.5));
    assert.equal(FEE.hosted(total, 8.5).total, total);
    assert.equal(FEE.hosted(total, 8.5).rounding, undefined);
  }
  assert.equal(FEE.includedCents(1000.01, 100), null);
  assert.equal(FEE.hosted(1000.01, 100), null);
});

test('база общей формы плюс комиссия дают точную сумму без дополнительного округления', () => {
  for (const rate of [0, 1, 100, 425, 850, 1200, 5000, 9999, 10000]) {
    for (const start of [0, 100000, 24999000]) {
      for (let minor = start; minor <= start + 1000; minor++) {
        const result = FEE.includedCents(minor / 100, rate / 100);
        if (!result) {
          // Независимый поиск по двум соседям обратного значения проверяет,
          // что функция не пропустила подходящую базу в целых копейках.
          const center = BigInt(minor) * 10000n / BigInt(10000 + rate);
          for (let b = center > 1n ? center - 1n : 0n; b <= center + 1n; b++) {
            assert.notEqual(b + (b * BigInt(rate) + 5000n) / 10000n, BigInt(minor));
          }
          continue;
        }
        assert.match(String(result.baseAmount), /^\d+(?:\.\d{1,2})?$/);
        const base = BigInt(Math.round(result.baseAmount * 100));
        const fee = (base * BigInt(rate) + 5000n) / 10000n;
        assert.equal(base + fee, BigInt(minor));
        assert.equal(BigInt(Math.round(result.amount * 100)), fee);
        assert.equal(result.total, minor / 100);
        assert.equal(result.rounding, 'cents');
      }
    }
  }
});

test('расчёт общей формы отклоняет неверные суммы и ставки', () => {
  for (const calculate of [FEE.includedCents, FEE.hosted]) {
    for (const value of [-1, NaN, Infinity, null, true, '1000', 1000.001, Number.MAX_SAFE_INTEGER]) {
      assert.equal(calculate(value, 8.5), null);
    }
    for (const rate of [-1, 100.01, NaN, Infinity, null, true, '8.5', 8.501]) {
      assert.equal(calculate(1000, rate), null);
    }
  }
});
