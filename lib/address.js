'use strict';
/* ========================== Полнота адреса доставки ==========================
 * Заказ уезжает перевозчиком и оплачен вперёд, поэтому «Екатеринбург» в поле
 * адреса — это не адрес: по нему нельзя ни оформить накладную, ни посчитать
 * доставку. Требуем три части: населённый пункт, улицу и дом.
 *
 * Проверка живёт на СЕРВЕРЕ и одна на всех: `/api/order` не примет неполный
 * адрес, а витрина спрашивает тот же ответ у `/api/delivery/quote` и по нему
 * отпирает выбор способа доставки. Своей проверки в скрипте нет — разъехавшись,
 * она пропускала бы адрес, который сервер потом отвергает.
 *
 * Это проверка ПОЛНОТЫ, а не существования: что дом номер 5 на этой улице есть,
 * знает только реестр (подсказки dadata.ru), а он необязателен — ключа может не
 * быть вовсе. Поэтому лишнего не запрещаем: ложный отказ здесь дороже пропуска.
 */

const Z = require('./delivery-zones');

// Маркеры населённого пункта. `д` (деревня) отличается от `д` (дом) по тому,
// что за ним стоит: у деревни — название, у дома — номер.
const SETTLEMENT_MARKERS = new Set([
  'г', 'гор', 'город', 'с', 'село', 'п', 'пос', 'поселок', 'пгт', 'рп', 'дп', 'нп',
  'д', 'дер', 'деревня', 'х', 'хутор', 'ст', 'ст-ца', 'станица', 'слобода', 'аул', 'улус'
]);
const STREET = new Set(Z.STREET_MARKERS);

// Номер дома: 5, 5а, 12/3, 7к2. Шесть цифр подряд — это индекс, а не дом,
// поэтому больше четырёх не берём.
const HOUSE = /^\d{1,4}(?:[а-я]|[-/]\d{1,3}[а-я]?|к\d{1,2})?$/;

function hasSettlement(list, raw) {
  // Город из таблицы зон засчитываем сам по себе: «Екатеринбург, ул Малышева, 5»
  // покупатель пишет без «г», и требовать его — придирка.
  if (Z.zoneFor(raw) !== Z.FALLBACK) return true;
  for (let i = 0; i < list.length; i++) {
    if (SETTLEMENT_MARKERS.has(list[i]) && list[i + 1] && !/^\d/.test(list[i + 1])) return true;
  }
  return false;
}

function hasHouse(list) {
  return list.some(w => HOUSE.test(w));
}

/* Улица: либо маркер («ул», «пр-кт», «ш»), либо адрес, разложенный запятыми на
 * три части и больше, где последняя — номер дома («Екатеринбург, Малышева, 5»).
 * Второе — уступка живому вводу: без маркера пишут часто, а три части через
 * запятую и есть «город, улица, дом».
 */
function hasStreet(list, raw) {
  if (list.some(w => STREET.has(w))) return true;
  const parts = String(raw).split(',').map(x => x.trim()).filter(Boolean);
  if (parts.length < 3) return false;
  const last = Z.words(parts[parts.length - 1]);
  const middle = parts[parts.length - 2];
  return last.some(w => HOUSE.test(w)) && /[а-яa-z]/i.test(middle);
}

function listMissing(missing) {
  if (missing.length === 1) return missing[0];
  return missing.slice(0, -1).join(', ') + ' и ' + missing[missing.length - 1];
}

const EXAMPLE = 'Например: г Екатеринбург, ул Малышева, д 5';

// Проверка адреса. Возвращает `{ ok, error }`: текст отказа показывает и
// витрина под полем, и сервер в ответе на заказ — он один и тот же.
function checkAddress(value) {
  const raw = String(value == null ? '' : value).trim();
  if (!raw) return { ok: false, error: 'Укажите адрес или пункт выдачи' };
  const list = Z.words(raw);
  const missing = [];
  if (!hasSettlement(list, raw)) missing.push('населённого пункта');
  if (!hasStreet(list, raw)) missing.push('улицы');
  if (!hasHouse(list)) missing.push('номера дома');
  if (!missing.length) return { ok: true, error: '' };
  return { ok: false, error: `В адресе не хватает ${listMissing(missing)}. ${EXAMPLE}` };
}

module.exports = { checkAddress, EXAMPLE, SETTLEMENT_MARKERS, HOUSE };
