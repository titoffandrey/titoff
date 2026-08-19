'use strict';
// Способы оплаты кассы CrocoPAY в рублях. Закрытый список, устроенный как
// lib/delivery.js: по нему рисуется выбор на странице оплаты, проверяется
// запрос на создание счёта и подписывается строка в панелях.
//
// Отдельный модуль, а не константа в render.js, потому что список нужен и в
// lib/db.js при нормализации платежа — а db.js рендер подключать не может и не
// должен (render → tenancy → db, вышел бы цикл).
//
// `id` — это `payment_option` платёжки. Он уходит в счёт и остаётся в заказе
// навсегда, поэтому менять их нельзя, только добавлять новые. Название и
// подсказка правятся свободно.
//
// `kind` — что приходит в реквизитах счёта: карта, телефон или ссылка QR. От
// него зависит подпись на странице оплаты, потому что поле `card` у платёжки
// одно на все случаи.
//
// `mark` — знак на карточке выбора: `sbp` — настоящий логотип СБП (тот же, что
// в подвале), `card`, `qr`, `phone` — свои знаки заливкой того же веса.
// Логотип СБП ставится только там, где это действительно СБП: SberPay и прочие
// «переводы по номеру телефона» — не она, у них знак телефона.
//
// Порядок — порядок показа: СБП первым, он привычнее всего.
const METHODS = [
  { id: 'SBP', name: 'СБП', hint: 'Перевод по номеру телефона, любой банк', kind: 'phone', mark: 'sbp' },
  { id: 'TO_CARD', name: 'Перевод на карту', hint: 'Любой банк России', kind: 'card', mark: 'card' },
  { id: 'SBP_TBANK', name: 'СБП · Т-Банк', hint: 'Если платите из Т-Банка', kind: 'phone', mark: 'sbp' },
  { id: 'SBP_ALFA', name: 'СБП · Альфа-Банк', hint: 'Если платите из Альфа-Банка', kind: 'phone', mark: 'sbp' },
  { id: 'QR_NSPK', name: 'QR-код НСПК', hint: 'Ссылка откроется в приложении банка', kind: 'qr', mark: 'qr' },
  { id: 'TO_CARD_TRANSGRAN', name: 'Карта · трансграничный', hint: 'Для карт иностранных банков', kind: 'card', mark: 'card' },
  { id: 'SBP_TRANSGRAN', name: 'СБП · трансграничный', hint: 'Для карт иностранных банков', kind: 'phone', mark: 'sbp' },
  { id: 'TRANSGRAN_SBER', name: 'SberPay · трансграничный', hint: 'Перевод по номеру телефона', kind: 'phone', mark: 'phone' },
  { id: 'TRANSGRAN_ALFA', name: 'Альфа-Банк · трансграничный', hint: 'Карта или номер телефона', kind: 'card', mark: 'card' },
  { id: 'TRANSGRAN_VTB', name: 'ВТБ · трансграничный', hint: 'Карта или номер телефона', kind: 'card', mark: 'card' },
  { id: 'TRANSGRAN_TPAY', name: 'TPay · трансграничный', hint: 'Карта или номер телефона', kind: 'card', mark: 'card' },
  // Этого способа нет в таблице документации, но он реально включён у кассы
  // (проверено 17 августа 2026). Не вписав его сюда, мы бы его просто прятали:
  // показываем пересечение, а незнакомый код в пересечение не попадает.
  { id: 'TRANSGRANCARD_TJS', name: 'Карта Таджикистана', hint: 'Трансграничный перевод на карту', kind: 'card', mark: 'card' }
];

// Что показывается на витрине по умолчанию: два способа для покупателя из
// России. Трансграничные у кассы включены, но нужны редко — и в списке из
// пяти-одиннадцати вариантов обычный покупатель теряется. Владелец включает их
// в `/owner/settings`, когда понадобятся.
const DEFAULT_IDS = ['SBP', 'TO_CARD'];

/* ------------------------------- Валюты -------------------------------
 * Цены каталога — рублёвые, и это база: сумма заказа считается в рублях, в них
 * же стоят пределы одной покупки. Валюта СЧЁТА может быть другой — какие
 * включены у кассы, видно из её же ответа (`payment-method/available` приходит
 * сгруппированным по валюте), а курс к рублю задаёт владелец в настройках:
 * внешних источников курса у проекта нет и заводить их ради этого незачем.
 *
 * Таблица ниже — только подписи. Незнакомый код (касса включила валюту, о
 * которой мы не знали) не отбрасывается: подписью становится он сам, а список
 * всё равно приходит от кассы.
 */
const BASE = 'RUB';
const CURRENCIES = {
  RUB: { name: 'Рубль', symbol: '₽' },
  USD: { name: 'Доллар США', symbol: '$' },
  EUR: { name: 'Евро', symbol: '€' },
  KZT: { name: 'Тенге', symbol: '₸' },
  UZS: { name: 'Сум', symbol: 'сўм' },
  TJS: { name: 'Сомони', symbol: 'смн' },
  KGS: { name: 'Сом', symbol: 'с' },
  AZN: { name: 'Манат', symbol: '₼' },
  AMD: { name: 'Драм', symbol: '֏' },
  GEL: { name: 'Лари', symbol: '₾' },
  BYN: { name: 'Белорусский рубль', symbol: 'Br' },
  UAH: { name: 'Гривна', symbol: '₴' },
  TRY: { name: 'Лира', symbol: '₺' },
  CNY: { name: 'Юань', symbol: '¥' },
  AED: { name: 'Дирхам', symbol: 'AED' },
  GBP: { name: 'Фунт', symbol: '£' },
  INR: { name: 'Рупия', symbol: '₹' }
};
// Код валюты из чужой строки: три латинских буквы и ничего больше. Он уходит и
// в тело запроса к кассе, и в заказ, поэтому мусор до них доходить не должен.
function currencyCode(code) {
  const c = String(code == null ? '' : code).trim().toUpperCase();
  return /^[A-Z]{3}$/.test(c) ? c : '';
}
function currencyName(code) {
  const c = currencyCode(code);
  return (CURRENCIES[c] && CURRENCIES[c].name) || c;
}
function currencySymbol(code) {
  const c = currencyCode(code);
  return (CURRENCIES[c] && CURRENCIES[c].symbol) || c;
}
// Сумма счёта: «755,44 $». Два знака после запятой — у всех валют, с которыми
// работает касса, минорная единица сотая; знаки лишними не будут и там, где
// дробной части нет.
function formatAmount(value, code) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '';
  const num = n.toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const sym = currencySymbol(code);
  return sym ? `${num} ${sym}` : num;
}
// Пересчёт рублёвой суммы заказа в валюту счёта. Курс — «сколько рублей за
// единицу валюты», как его и пишут в обменниках: 90 за доллар. Ноль или мусор
// означают «курс не задан» — счёт в такой валюте выставлять нельзя.
function convert(rubles, rate) {
  const sum = Number(rubles), r = Number(rate);
  if (!Number.isFinite(sum) || sum <= 0 || !Number.isFinite(r) || r <= 0) return 0;
  return Math.round((sum / r) * 100) / 100;
}
// Курс из настроек. У базовой валюты он всегда 1 — её не пересчитывают.
function rateOf(rates, code) {
  const c = currencyCode(code);
  if (!c) return 0;
  if (c === BASE) return 1;
  const r = Number(rates && rates[c]);
  return Number.isFinite(r) && r > 0 ? r : 0;
}

function find(id) {
  const key = String(id == null ? '' : id).trim();
  return METHODS.find(m => m.id === key) || null;
}
function isValid(id) { return !!find(id); }
// Название для панелей и страницы оплаты. Неизвестный id (или платёж без
// способа — такими остались все прежние заявки) даёт пустую строку, а не
// «undefined».
function nameOf(id) { const m = find(id); return m ? m.name : ''; }
// Подпись реквизита зависит от того, что именно прислала платёжка в поле `card`.
function requisiteLabel(id) {
  const m = find(id);
  if (!m) return 'Реквизиты';
  if (m.kind === 'phone') return 'Номер телефона';
  if (m.kind === 'qr') return 'Ссылка для оплаты';
  return 'Номер карты';
}

// Что показать покупателю — пересечение трёх списков: нашего закрытого,
// включённого у кассы и разрешённого владельцем в настройках.
//
// `cassa === null` — касса не ответила: её условие не применяем, потому что без
// списка покупателю нечем платить вовсе, а несовпадение поймает сама касса при
// создании счёта и вернёт понятную ошибку. Пустой массив — касса ответила, и
// способов у неё нет: это НЕ то же самое, показать заведомо нерабочие кнопки
// хуже, чем честно сказать, что оплатить сейчас нечем.
//
// `owner === null` (в настройках поля ещё нет — так у всех прежних установок)
// означает набор по умолчанию, а не «всё»: иначе после обновления на витрине
// разом появились бы все трансграничные способы.
function allowed(cassa, owner) {
  const shown = Array.isArray(owner) ? owner : DEFAULT_IDS;
  let list = METHODS.filter(m => shown.includes(m.id));
  if (Array.isArray(cassa)) {
    list = list.filter(m => cassa.includes(m.id));
    // Способ, которого нет в нашем списке, но который касса включила и владелец
    // отметил в настройках. Раньше такой просто пропадал: пересечение с
    // закрытым списком выбрасывало его молча, и включить новый способ кассы
    // было нельзя вовсе — только правкой METHODS с выкаткой.
    for (const id of cassa) {
      if (!find(id) && shown.includes(id)) list.push(describe(id));
    }
  }
  return list;
}

/* Описание способа для показа. Известный — из закрытого списка выше, незнакомый
 * (касса добавила новый код) — собранное на месте: название кассы как есть,
 * нейтральный знак и НИКАКИХ догадок про вид реквизита. Подписать чужой код
 * «Номер карты», когда там окажется телефон, хуже, чем сказать «Реквизиты» —
 * `requisiteLabel()` неизвестному id ровно это и отвечает.
 */
function describe(id) {
  const known = find(id);
  if (known) return known;
  const code = String(id == null ? '' : id).trim();
  return { id: code, name: code, hint: 'Способ подключён у кассы', kind: '', mark: 'card', unknown: true };
}

module.exports = {
  METHODS, DEFAULT_IDS, BASE, CURRENCIES,
  find, isValid, nameOf, requisiteLabel, allowed, describe,
  currencyCode, currencyName, currencySymbol, formatAmount, convert, rateOf
};
