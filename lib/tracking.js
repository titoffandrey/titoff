'use strict';
/* ===================== Отслеживание посылки: маршрут =====================
 *
 * Трек-номера у нас нет и не будет: посылку везёт не наш договор с перевозчиком,
 * а менеджер, поэтому единственный идентификатор у покупателя — номер заказа.
 * По нему и открывается страница отслеживания.
 *
 * Маршрут не приходит снаружи и не может: у СДЭК и OZON отслеживание доступно
 * только по своей накладной. Поэтому он СОБИРАЕТСЯ ЗДЕСЬ — по тем же данным,
 * которые уже лежат в заказе (перевозчик, вариант доставки, адрес, зона), — и
 * дальше живёт в самом заказе обычным полем `shipment`, где его правит админ.
 *
 * Три правила, из которых следует всё остальное.
 *
 * 1. МАРШРУТ ХРАНИТСЯ ЦЕЛИКОМ, а не пересчитывается на каждое открытие
 *    страницы. Иначе правка любой настройки (город отправки, сетка сроков)
 *    молча переписала бы историю уже уехавшей посылки — покупатель открыл бы
 *    страницу и увидел другие даты у событий, которые уже случились. Генератор
 *    нужен ровно один раз: чтобы админу не пришлось набивать полтора десятка
 *    строк руками.
 *
 * 2. ВРЕМЯ СОБЫТИЯ — АБСОЛЮТНОЕ (ms). Пройденным считается шаг, чьё время уже
 *    наступило: движение идёт само, без cron и без единой записи в файл. День
 *    прошёл — посылка проехала ещё пару пунктов, и это видно всем одинаково.
 *
 * 3. ОДИН ШАГ МОЖЕТ БЫТЬ «ЗАСТРЯВШИМ» (`hold`). Дальше него посылка не едет,
 *    сколько бы времени ни прошло, а через заданное число часов стояния
 *    покупателю показывается вежливая просьба подождать. Это ровно то, ради
 *    чего механизм и заводился, поэтому застревание — свойство шага, а не
 *    отдельная сущность: админ ставит галочку в той строке, где посылка должна
 *    встать, и переносит её куда угодно.
 *
 * Даты у шагов детерминированные: дрожание часов считается ГПСЧ с сидом от id
 * заказа, поэтому пересборка того же маршрута даёт те же времена, а не тасует
 * их при каждом сохранении формы.
 */

const Z = require('./delivery-zones');
const DELIVERY = require('./delivery');
const SHIPDAYS = require('./delivery-days');

// Откуда едет вся техника. Склад один, поэтому это значение по умолчанию, а не
// поле заказа; поменять его можно и в настройках магазина, и у самой отправки —
// перевозчик может забрать посылку из другого города.
const DEFAULT_FROM = 'Москва';

// Сколько часов посылка должна простоять на месте, прежде чем покупателю
// покажут просьбу подождать. Сутки — не «пока не надоест»: у обоих
// перевозчиков нормальная пересортировка занимает ночь, и плашка «задержка»
// над штатным ночным простоем была бы ложной тревогой.
const HOLD_NOTICE_HOURS = 24;
const HOLD_NOTICE_MAX = 240;

// Потолки на всякий случай: маршрут правится формой, а форма приходит снаружи.
const MAX_STEPS = 40;
const MAX_DAYS = 90;

/* Транзитные хабы по тарифным зонам (`lib/delivery-zones.js`).
 *
 * Это настоящие сортировочные центры обоих перевозчиков на московском
 * направлении — по ним посылка и едет: в Сибирь через Екатеринбург и
 * Новосибирск, на Дальний Восток дальше через Хабаровск. Зона «регион не
 * опознан» получает один средний хаб: маршрут без единого транзита через всю
 * страну выглядел бы выдумкой сильнее, чем лишний пункт.
 *
 * Хаб, совпавший с городом отправления или назначения, из маршрута выпадает
 * (`hubsFor`): «Отправлен в г. Екатеринбург» у посылки, которая в Екатеринбург
 * и едет, читается как сбой.
 */
const HUBS = {
  msk: [],
  cfo: [],
  szfo: ['Санкт-Петербург'],
  pfo: ['Нижний Новгород'],
  yug: ['Ростов-на-Дону'],
  ural: ['Екатеринбург'],
  sfo: ['Екатеринбург', 'Новосибирск'],
  dfo: ['Новосибирск', 'Хабаровск'],
  ru: ['Нижний Новгород']
};

/* Слова, за которыми в адресе стоит название населённого пункта. Отдельный
 * список, а не `Z.STREET_MARKERS`: там маркеры улиц, и «ул» с «пр-кт» нам здесь
 * как раз мешают. «д» сознательно НЕ берём — в адресе это почти всегда дом.
 */
const PLACE_MARKERS = ['г', 'гор', 'город', 'пгт', 'рп', 'п', 'пос', 'посёлок', 'поселок', 'с', 'село', 'ст-ца', 'станица', 'х', 'хутор', 'аул', 'мкр'];
const PLACE_RE = new RegExp('(?:^|[,;])\\s*(?:' + PLACE_MARKERS.join('|') + ')\\.?\\s+([А-ЯЁA-Z][^,;]{1,40})', 'i');

/* Город назначения по адресу.
 *
 * Точность здесь не критична и не может быть полной: адрес покупатель пишет
 * руками, а подсказки dadata.ru необязательны. Промах не ломает ничего —
 * название города видно в форме отправки, и админ правит его одним полем.
 * Поэтому берём первое, что похоже на населённый пункт, и не выдумываем
 * ничего, когда не нашли.
 *
 * Порядок разбора:
 *   1. явный маркер («г Екатеринбург», «ст-ца Новоджерелиевская»);
 *   2. известное название из таблицы зон — там лежат все крупные города,
 *      которые вообще встречаются в тарифной сетке;
 *   3. вторая часть адреса через запятую: и DaData, и обычный ввод дают
 *      «регион, город, улица, дом».
 */
function cityOf(address) {
  const raw = String(address == null ? '' : address).trim();
  if (!raw) return '';
  const marked = PLACE_RE.exec(raw);
  if (marked) return cleanCity(marked[1]);

  // Известные названия ищем по нормализованной строке, но возвращаем кусок
  // ИСХОДНОГО текста: в таблице зон города записаны строчными, а покупателю
  // показывать «екатеринбург» нельзя.
  const parts = raw.split(/[,;]/).map(s => s.trim()).filter(Boolean);
  for (const part of parts) {
    const norm = Z.words(part).join(' ');
    if (!norm) continue;
    if (KNOWN_CITIES.has(norm)) return cleanCity(part);
  }
  // Улицу за город не принимаем: у части адресов регион не назван вовсе, и
  // тогда вторая часть — это уже улица.
  const second = parts[1] || '';
  if (second && !Z.words(second).some(w => Z.STREET_MARKERS.includes(w)) && !/\d/.test(second)) {
    return cleanCity(second);
  }
  return '';
}

/* Города, которые узнаём в адресе без всякого маркера.
 *
 * Список свой, а не из `lib/delivery-zones.js`: там названия лежат вперемешку с
 * основами регионов («свердловск», «ханты-мансийск»), и городом такое подставлять
 * в ленту отслеживания нельзя — «Отправлен в г. свердловск» читается как сбой.
 * Здесь только те названия, которые правда пишут в адресе, и уже в том виде, в
 * каком их отдаёт `Z.words`: строчными и с «е» вместо «ё».
 */
const KNOWN_CITIES = (() => {
  const set = new Set();
  for (const list of Object.values(HUBS)) for (const city of list) set.add(Z.words(city).join(' '));
  for (const city of ['москва', 'санкт-петербург', 'екатеринбург', 'новосибирск', 'казань', 'нижний новгород',
    'челябинск', 'самара', 'омск', 'ростов-на-дону', 'уфа', 'красноярск', 'воронеж', 'пермь', 'волгоград',
    'краснодар', 'саратов', 'тюмень', 'тольятти', 'ижевск', 'барнаул', 'ульяновск', 'иркутск', 'хабаровск',
    'ярославль', 'владивосток', 'махачкала', 'томск', 'оренбург', 'кемерово', 'новокузнецк', 'рязань',
    'астрахань', 'пенза', 'липецк', 'киров', 'чебоксары', 'тула', 'калининград', 'курск', 'ставрополь',
    'улан-удэ', 'сочи', 'тверь', 'магнитогорск', 'иваново', 'брянск', 'белгород', 'сургут', 'владимир',
    'архангельск', 'чита', 'калуга', 'смоленск', 'волжский', 'якутск', 'саранск', 'череповец', 'вологда',
    'курган', 'орёл', 'орел', 'владикавказ', 'мурманск', 'тамбов', 'грозный', 'петрозаводск', 'кострома',
    'нижневартовск', 'новороссийск', 'йошкар-ола', 'таганрог', 'комсомольск-на-амуре', 'сыктывкар',
    'нижний тагил', 'братск', 'дзержинск', 'шахты', 'нальчик', 'псков', 'бийск', 'армавир', 'рыбинск',
    'балаково', 'северодвинск', 'абакан', 'великий новгород', 'находка', 'уссурийск', 'южно-сахалинск',
    'благовещенск', 'петропавловск-камчатский', 'магадан', 'симферополь', 'севастополь', 'ялта']) {
    set.add(city);
  }
  return set;
})();

// Название города к виду, в котором его показывают: без сокращений вида «г.» в
// начале, без хвостовых точек и без лишних пробелов.
function cleanCity(value) {
  return String(value == null ? '' : value)
    .replace(/^\s*(?:г|гор|город|пгт|рп|п|пос|посёлок|поселок|с|село|ст-ца|станица|х|хутор|аул)\.?\s+/i, '')
    .replace(/[.\s]+$/, '')
    .trim()
    .slice(0, 60);
}

// Хабы маршрута: из таблицы зоны, без совпадений с концами маршрута и без
// повторов. Сравниваем нормализованно — «Санкт-Петербург» и «санкт петербург»
// это один город.
function hubsFor(zoneId, from, to) {
  const key = value => Z.words(value).join(' ');
  const ends = new Set([key(from), key(to)].filter(Boolean));
  const seen = new Set();
  const list = HUBS[String(zoneId || '')] || HUBS.ru;
  return list.filter(city => {
    const k = key(city);
    if (!k || ends.has(k) || seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/* Ровный ГПСЧ от строки — тот же, что раздаёт даты отзывам (`lib/review-dates.js`).
 * Нужен ради одного: пересборка маршрута того же заказа обязана давать те же
 * времена. Иначе админ, нажавший «Собрать заново» дважды, каждый раз получал бы
 * другие часы у уже случившихся событий.
 */
function seeded(str) {
  let h = 2166136261;
  const s = String(str);
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return () => {
    h += 0x6d2b79f5;
    let t = h;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* Шаблон маршрута: что и где происходит с посылкой.
 *
 * `span` — сколько «весит» переход к этому шагу. Веса потом нормализуются на
 * весь срок доставки, поэтому маршрут в соседний город и маршрут во Владивосток
 * получают одинаково правдоподобную раскладку: разъезды между хабами занимают
 * большую часть пути, складские операции — часы.
 *
 * Формулировки у перевозчиков РАЗНЫЕ и взяты у них же. СДЭК пишет сухо и
 * по-складски («Принят на склад», «Сдан перевозчику», «Выдан на доставку»,
 * «Вручен»), OZON — короткими человеческими фразами («Заказ собран»,
 * «В пути», «Можно забирать»). Смешивать их нельзя: покупатель, видевший
 * настоящее отслеживание, узнаёт язык быстрее, чем цвет.
 */
function cdekSteps(from, hubs, to, mode) {
  const steps = [
    { kind: 'created', title: 'Заказ создан', place: from, span: 0 },
    { kind: 'warehouse', title: 'Принят на склад', place: from, span: 0.5 },
    { kind: 'warehouse', title: 'Выдан на отправку', place: from, span: 0.35 },
    { kind: 'transit', title: 'Сдан перевозчику', place: from, span: 0.3 }
  ];
  for (const hub of hubs) {
    steps.push({ kind: 'transit', title: 'Отправлен в г. ' + hub, place: hub, span: 1.6 });
    steps.push({ kind: 'arrive', title: 'Встречен в г. ' + hub, place: hub, span: 0.9 });
    steps.push({ kind: 'warehouse', title: 'Выдан на отправку', place: hub, span: 0.5 });
  }
  steps.push({ kind: 'transit', title: 'Отправлен в г. ' + to, place: to, span: 1.6 });
  steps.push({ kind: 'arrive', title: 'Встречен в г. ' + to, place: to, span: 0.9 });
  steps.push({ kind: 'warehouse', title: 'Принят на склад доставки', place: to, span: 0.5 });
  if (mode === 'courier') {
    steps.push({ kind: 'ready', title: 'Выдан на доставку', place: to, span: 0.5 });
    steps.push({ kind: 'done', title: 'Вручен', place: to, span: 0.6 });
  } else {
    steps.push({ kind: 'ready', title: 'Готов к выдаче в пункте', place: to, span: 0.5 });
    steps.push({ kind: 'done', title: 'Вручен', place: to, span: 0.7 });
  }
  return steps;
}

function ozonSteps(from, hubs, to, mode) {
  const steps = [
    { kind: 'created', title: 'Заказ оформлен', place: from, span: 0 },
    { kind: 'warehouse', title: 'Заказ собран на складе', place: from, span: 0.5 },
    { kind: 'transit', title: 'Передан в доставку', place: from, span: 0.35 }
  ];
  for (const hub of hubs) {
    steps.push({ kind: 'transit', title: 'В пути в г. ' + hub, place: hub, span: 1.6 });
    steps.push({ kind: 'arrive', title: 'Прибыл в сортировочный центр', place: hub, span: 0.9 });
    steps.push({ kind: 'warehouse', title: 'Отправлен дальше', place: hub, span: 0.5 });
  }
  steps.push({ kind: 'transit', title: 'В пути в г. ' + to, place: to, span: 1.7 });
  steps.push({ kind: 'arrive', title: 'Прибыл в город получателя', place: to, span: 0.9 });
  if (mode === 'courier') {
    steps.push({ kind: 'ready', title: 'Передан курьеру', place: to, span: 0.6 });
    steps.push({ kind: 'done', title: 'Доставлен', place: to, span: 0.6 });
  } else {
    steps.push({ kind: 'ready', title: 'Прибыл в пункт выдачи', place: to, span: 0.6 });
    steps.push({ kind: 'ready', title: 'Можно забирать', place: to, span: 0.25 });
    steps.push({ kind: 'done', title: 'Получен', place: to, span: 0.7 });
  }
  return steps;
}

/* Час события.
 *
 * Посылки не приезжают ровно в 03:41 ночи — точнее, приезжают, но в
 * отслеживании такие строки выглядят машинными. Поэтому ночное время
 * переносится в утро, а внутри разрешённого окна час дрожит на случайные
 * минуты: два соседних события с одинаковыми «12:00» выдали бы генератор
 * сильнее всего.
 */
const DAY_START = 7;   // раньше этого часа события не показываем
const DAY_END = 22;    // и позже этого тоже
/* Час считаем ПО МОСКВЕ, а не по часам процесса: сервер живёт в UTC, и «утро»
 * по его часам — это 03:00 у покупателя (см. «Время магазина — московское» в
 * CLAUDE.md). Смещение здесь своё, постоянное: тянуть сюда `lib/render.js` ради
 * одной функции нельзя — рендер сам подключает этот модуль ради страницы
 * отслеживания, и require замкнулся бы в кольцо. У Москвы смещение неизменно с
 * 2014 года, а показывает даты всё равно `R.mskDateTime`.
 */
const MSK_OFFSET_MS = 3 * 60 * 60 * 1000;
function mskHour(ms) { return Math.floor(((ms + MSK_OFFSET_MS) / 3600000) % 24); }
function atMskTime(ms, hour, minute) {
  const day = Math.floor((ms + MSK_OFFSET_MS) / 86400000);
  return day * 86400000 + hour * 3600000 + minute * 60000 - MSK_OFFSET_MS;
}
function workHour(ms, rnd) {
  const hour = mskHour(ms);
  const minute = Math.floor(rnd() * 60);
  if (hour < DAY_START) return atMskTime(ms, DAY_START + Math.floor(rnd() * 3), minute);
  if (hour >= DAY_END) return atMskTime(ms, DAY_END - 1 - Math.floor(rnd() * 3), minute);
  return atMskTime(ms, hour, minute);
}

/* Сборка маршрута.
 *
 * `days` — сколько всего идёт посылка. Число задаёт админ; по умолчанию берётся
 * ВЕРХНЯЯ граница нашей же сетки сроков (`lib/delivery-days.js`) — та самая,
 * что покупатель видел на оформлении. Обещать в отслеживании быстрее, чем
 * обещали при покупке, нельзя.
 */
function build(opts) {
  opts = opts || {};
  const carrier = DELIVERY.isValid(opts.carrier) ? String(opts.carrier) : 'cdek';
  const mode = DELIVERY.isValidMode(carrier, opts.mode) ? String(opts.mode) : 'pvz';
  const from = cleanCity(opts.from) || DEFAULT_FROM;
  const to = cleanCity(opts.to) || '';
  const zone = Z.isValidZone(opts.zone) ? String(opts.zone) : Z.FALLBACK;
  const startedAt = Number(opts.startedAt) > 0 ? Number(opts.startedAt) : Date.now();
  const days = clampDays(opts.days || defaultDays(carrier, mode, zone));
  const hubs = hubsFor(zone, from, to);
  const template = carrier === 'ozon' ? ozonSteps(from, hubs, to, mode) : cdekSteps(from, hubs, to, mode);

  const total = days * 24 * 60 * 60 * 1000;
  const weight = template.reduce((sum, s) => sum + s.span, 0) || 1;
  const rnd = seeded(String(opts.seed || '') + ':' + carrier + ':' + days);
  let acc = 0;
  let prev = 0;
  const steps = template.map((step, i) => {
    acc += step.span;
    // Дрожание — ±12% шага пути, чтобы события не ложились на ровную сетку.
    const jitter = i === 0 || i === template.length - 1 ? 0 : (rnd() - 0.5) * 0.24 * (step.span / weight);
    const at = i === 0 ? startedAt : workHour(startedAt + total * Math.min(1, Math.max(0, acc / weight + jitter)), rnd);
    // Порядок обязан быть строгим: сдвиг часа мог поставить событие раньше
    // предыдущего, а лента отслеживания читается сверху вниз по времени.
    const fixed = at <= prev ? prev + 40 * 60 * 1000 : at;
    prev = fixed;
    return { title: step.title, place: step.place, kind: step.kind, at: fixed, hold: false, note: '' };
  });
  return { carrier, mode, from, to, zone, days, startedAt, steps };
}

function defaultDays(carrier, mode, zone) {
  const range = SHIPDAYS.daysFor(carrier, mode, zone);
  return range ? range.max : 5;
}
function clampDays(value) {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n) || n < 1) return 1;
  return Math.min(MAX_DAYS, n);
}

/* Нормализация того, что пришло из формы. Правило то же, что у всех форм
 * панели: проверка идёт ДО записи, а мусор сводится к безопасному значению, а
 * не роняет страницу.
 *
 * Застрять может только ОДИН шаг: «где встала посылка» — это одно место, а два
 * таких флага означали бы, что второй никогда не сработает.
 */
function normalize(data) {
  data = data || {};
  const carrier = DELIVERY.isValid(data.carrier) ? String(data.carrier) : 'cdek';
  const mode = DELIVERY.isValidMode(carrier, data.mode) ? String(data.mode) : 'pvz';
  const rawSteps = Array.isArray(data.steps) ? data.steps.slice(0, MAX_STEPS) : [];
  let holdSeen = false;
  const steps = rawSteps
    .map(s => ({
      title: String(s && s.title || '').trim().slice(0, 120),
      place: cleanCity(s && s.place),
      kind: STEP_KINDS.includes(String(s && s.kind || '')) ? String(s.kind) : 'transit',
      at: Number(s && s.at) > 0 ? Math.round(Number(s.at)) : 0,
      note: String(s && s.note || '').trim().slice(0, 200),
      hold: !!(s && s.hold)
    }))
    .filter(s => s.title && s.at > 0)
    .sort((a, b) => a.at - b.at)
    .map(s => {
      if (s.hold && holdSeen) return Object.assign({}, s, { hold: false });
      if (s.hold) holdSeen = true;
      return s;
    });
  const startedAt = steps.length ? steps[0].at : (Number(data.startedAt) > 0 ? Math.round(Number(data.startedAt)) : Date.now());
  return {
    carrier, mode,
    from: cleanCity(data.from) || DEFAULT_FROM,
    to: cleanCity(data.to),
    zone: Z.isValidZone(data.zone) ? String(data.zone) : Z.FALLBACK,
    days: clampDays(data.days),
    holdHours: holdHoursValue(data.holdHours),
    startedAt,
    steps,
    createdAt: Number(data.createdAt) > 0 ? Math.round(Number(data.createdAt)) : Date.now(),
    updatedAt: Date.now()
  };
}
const STEP_KINDS = ['created', 'warehouse', 'transit', 'arrive', 'ready', 'done'];

// Через сколько часов стояния сообщаем о задержке. Пустое поле — значение по
// умолчанию, а не ноль: ноль означал бы «жалуйся сразу», и плашка висела бы у
// каждой нормально идущей посылки.
function holdHoursValue(value) {
  if (value === undefined || value === null || String(value).trim() === '') return HOLD_NOTICE_HOURS;
  const n = Number(String(value).replace(',', '.'));
  if (!Number.isFinite(n) || n < 0) return HOLD_NOTICE_HOURS;
  return Math.min(HOLD_NOTICE_MAX, Math.round(n));
}

/* Что показывать прямо сейчас.
 *
 * Одна функция на витрину и на панель: разъехавшись, они говорили бы разное об
 * одной посылке — покупатель видел бы «в пути», а менеджер «вручено».
 *
 * `stopAt` — граница движения. Обычно это последний шаг, чьё время наступило; у
 * маршрута с застреванием — шаг с `hold`, и дальше него посылка не едет, сколько
 * бы времени ни прошло.
 */
function view(shipment, now) {
  const at = Number(now) > 0 ? Number(now) : Date.now();
  const steps = shipment && Array.isArray(shipment.steps) ? shipment.steps : [];
  if (!steps.length) return null;

  const holdIndex = steps.findIndex(s => s && s.hold);
  // Сколько шагов прошло по времени. Застревание учитываем отдельно: у шага с
  // `hold` время наступило, а у следующего — уже нет, что бы ни показывали часы.
  let lastByTime = -1;
  for (let i = 0; i < steps.length; i++) if (Number(steps[i].at) <= at) lastByTime = i;
  const stopAt = holdIndex >= 0 ? Math.min(lastByTime, holdIndex) : lastByTime;
  const stuck = holdIndex >= 0 && stopAt === holdIndex && holdIndex < steps.length - 1;
  const heldSince = stuck ? Number(steps[holdIndex].at) : 0;
  const holdHours = holdHoursValue(shipment && shipment.holdHours);
  // Плашка «задерживается» появляется не в момент остановки, а когда стоянка
  // затянулась: ночная пересортировка — это ещё не задержка.
  const delayed = stuck && at - heldSince >= holdHours * 60 * 60 * 1000;

  const last = steps[steps.length - 1];
  const delivered = stopAt === steps.length - 1;
  const list = steps.map((s, i) => ({
    title: s.title, place: s.place, kind: s.kind, note: s.note,
    at: Number(s.at) || 0,
    done: i <= stopAt,
    current: i === stopAt,
    /* Плановое время будущего шага показываем, пока плану ещё можно верить:
     * оно в будущем И посылка не признана задержавшейся. У застрявшей сдвинулся
     * весь остаток пути, и печатать прежние даты значило бы обещать доставку,
     * которой уже не будет. Ряд «ожидается · 28 августа · 29 августа» вдобавок
     * читался бы как сбой: часть дат исчезла, часть осталась.
     */
    planned: i > stopAt && !delayed && Number(s.at) > at ? Number(s.at) : 0
  }));

  return {
    steps: list,
    delivered,
    stuck,
    delayed,
    heldSince,
    holdHours,
    /* Ожидаемая дата — время последнего шага, но только пока обещание в силе:
     * у признанной задержки её нет вовсе («уточняется»). Обещать 29 августа
     * рядом с плашкой «посылка задерживается» — это два разных ответа на один
     * вопрос в пределах одного экрана. */
    eta: delivered || delayed ? 0 : (Number(last.at) > at ? Number(last.at) : 0),
    deliveredAt: delivered ? Number(last.at) || 0 : 0,
    current: stopAt >= 0 ? list[stopAt] : null,
    // Доля пути — для полосы прогресса в стиле OZON. Считается по шагам, а не
    // по времени: покупатель смотрит на список событий, и полоса обязана
    // сходиться с ним.
    progress: steps.length > 1 ? Math.max(0, Math.min(1, (stopAt + 1) / steps.length)) : 0
  };
}

// Состояние словами: название текущего события — то же, что стоит первой
// строкой на странице покупателя.
function stateText(shipment, now) {
  const v = view(shipment, now);
  if (!v) return '';
  if (v.delivered) return shipment.carrier === 'ozon' ? 'Получен' : 'Вручен';
  if (v.delayed) return 'Задерживается';
  return v.current ? v.current.title : 'В пути';
}

/* То же самое, но в два слова — для строки списка заказов.
 *
 * Полное название события («Отправлен в г. Петропавловск-Камчатский») в узкий
 * столбец не встаёт и переносится на три строки, а список читают взглядом:
 * там нужен ответ «что с посылкой», а не «какое событие было последним». Само
 * событие менеджер увидит, открыв маршрут.
 */
function shortState(shipment, now) {
  const v = view(shipment, now);
  if (!v) return '';
  if (v.delivered) return shipment.carrier === 'ozon' ? 'получено' : 'вручено';
  if (v.delayed) return 'задерживается';
  if (v.current && v.current.kind === 'ready') return 'готово к выдаче';
  if (v.current && v.current.kind === 'created') return 'ожидает отправки';
  return 'в пути';
}

module.exports = {
  DEFAULT_FROM, HOLD_NOTICE_HOURS, HOLD_NOTICE_MAX, MAX_STEPS, MAX_DAYS, HUBS, STEP_KINDS,
  cityOf, cleanCity, hubsFor, build, normalize, view, stateText, shortState, defaultDays, clampDays, holdHoursValue
};
