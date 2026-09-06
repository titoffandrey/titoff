'use strict';
/* ============ Правила по посетителям: тотальный блок и исключение из метрики ===
 *
 * Две разные задачи, но опознаётся человек в обеих одинаково, поэтому и модуль
 * один:
 *
 *   `block` — витрина закрыта целиком. Ни страницы, ни картинки, ни запроса
 *             API: заблокированному не отдаётся НИЧЕГО (см. `app.before` в
 *             server.js). Это про доступ, а не про учёт.
 *   `skip`  — человек есть, но метрика его не считает: ни онлайна, ни визитов,
 *             ни карточки. Заводилось ради владельца и менеджеров — они ходят по
 *             витрине каждый день, и в отчёте их не отличить от покупателей.
 *
 * ОПОЗНАЁМ ПО ТРЁМ ПРИЗНАКАМ, и достаточно совпадения любого:
 *
 *   1. МЕТКА посетителя — cookie метрики. Точна до браузера, но стирается
 *      вместе с прочими cookie.
 *   2. АДРЕС. Переживает чистку cookie, но за одним адресом сидит целая
 *      квартира или офис, а у мобильного оператора — половина города.
 *   3. ОТПЕЧАТОК УСТРОЙСТВА — хеш от того, что меняется редко: платформа,
 *      разрешение экрана, часовой пояс, язык, ядра и память, семейство системы
 *      и браузера. Он и есть ответ на «заблокируй именно это устройство»:
 *      чистка cookie и смена адреса его не трогают.
 *
 * ОТПЕЧАТОК СЧИТАЕТСЯ ТОЛЬКО ТАМ, ГДЕ ЕСТЬ ДАННЫЕ СО СТРАНИЦЫ (экран и часовой
 * пояс присылает скрипт витрины, `/api/analytics/start`). Из одного User-Agent
 * его собирать нельзя: «Телефон · iPhone · iOS · Safari» — это каждый второй
 * посетитель магазина, и такой «блок устройства» закрыл бы витрину половине
 * покупателей. Поэтому обычный запрос страницы сверяется только по метке и
 * адресу, а устройство узнаётся первым же обращением скрипта.
 *
 * ОТСЮДА САМООБУЧЕНИЕ ПРАВИЛА: узнали устройство — привязали к правилу ТЕКУЩУЮ
 * метку (`learn`). Стёр cookie — первую страницу увидел, скрипт отчитался,
 * правило запомнило новую метку, и следующий запрос уже закрыт. Адрес при этом
 * НЕ ЗАПОМИНАЕТСЯ никогда: метка точна до браузера, а подхваченный адрес
 * оператора со временем накрыл бы посторонних, и блок расползался бы сам.
 *
 * ЧЕГО ЭТО НЕ УМЕЕТ, и врать об этом не надо: другой браузер на том же
 * устройстве — другой отпечаток (язык, платформа и версии там свои), выключенные
 * скрипты — отпечатка нет вовсе, режим инкогнито стирает метку. Полного «блока
 * человека» в вебе не бывает; здесь закрыт обычный путь возвращения, а не все.
 *
 * ХРАНЯТСЯ ПРАВИЛА СВОИМ ФАЙЛОМ, а не полем карточки метрики. Карточку вытесняет
 * срок хранения (365 дней) и потолок в 10 000 записей — блок исчез бы вместе с
 * ней молча, и заблокированный вернулся бы сам собой.
 */

const crypto = require('crypto');
const db = require('./db');
const LIVE = require('./live');
const { familyOf } = require('./analytics');

// Правил столько, сколько решений принял владелец руками. Двести — это уже не
// список, а чёрный список целого сегмента, и заводить его такой ручкой незачем.
const MAX_RULES = 200;
/* Сколько признаков помнит одно правило. Метки копятся сами (см. `learn`),
 * поэтому у них потолок больше: браузер стирают, устройство остаётся тем же.
 * Переполнение выбрасывает самые старые — свежая метка ближе к человеку. */
const MAX_IDS = 20;
const MAX_IPS = 10;
const MAX_PRINTS = 5;

const KINDS = ['block', 'skip'];

function clean(value, max) {
  return String(value == null ? '' : value).replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, max || 120);
}

function validId(value) { return /^[a-f0-9]{32}$/.test(String(value || '')); }
function validPrint(value) { return /^[a-f0-9]{16}$/.test(String(value || '')); }
/* Адрес в правило кладётся только настоящий. «?» ставит `clientIp()`, когда
 * адреса нет вовсе, и правило с таким «адресом» закрыло бы витрину всем, у кого
 * его не удалось определить. */
function validIp(value) {
  const ip = clean(value, 60);
  return ip && ip !== '?' ? ip : '';
}

/* Отпечаток устройства — sha256 по стабильным полям, первые 16 знаков.
 *
 * Считается и от карточки метрики, и от контекста запроса: поля у них одни и те
 * же. Версии системы и браузера срезаются до семейства (`familyOf`): Chrome
 * обновляется каждые пару недель, и отпечаток по версии перестал бы совпадать
 * раньше, чем владелец успел бы им воспользоваться. Размер ОКНА (`viewport`) не
 * входит вовсе — он меняется от поворота телефона.
 *
 * Пустая строка означает «отпечатка нет»: сверять нечего, и правило по нему не
 * сработает. Это и есть защита от совпадения по одному User-Agent.
 */
function printOf(source) {
  const v = source && typeof source === 'object' ? source : {};
  const screen = clean(v.screen, 40);
  const timezone = clean(v.timezone, 80);
  if (!screen || !timezone) return '';
  const parts = [
    clean(v.device, 40), clean(v.model, 70), familyOf(clean(v.os, 60)), familyOf(clean(v.browser, 60)),
    clean(v.platform, 80), screen, clean(v.language, 30), timezone,
    Number(v.cpuCores) || 0, Number(v.deviceMemory) || 0
  ];
  return crypto.createHash('sha256').update(parts.join('|')).digest('hex').slice(0, 16);
}

// Признаки одного посетителя: из карточки метрики или из контекста запроса.
function signalsOf(source) {
  const v = source && typeof source === 'object' ? source : {};
  return { id: validId(v.id) ? v.id : '', ip: validIp(v.ip), print: printOf(v) };
}

function normalize(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const kind = KINDS.includes(String(r.kind)) ? String(r.kind) : '';
  if (!kind) return null;
  const ids = [...new Set((Array.isArray(r.ids) ? r.ids : []).filter(validId))].slice(-MAX_IDS);
  const ips = [...new Set((Array.isArray(r.ips) ? r.ips : []).map(validIp).filter(Boolean))].slice(-MAX_IPS);
  const prints = [...new Set((Array.isArray(r.prints) ? r.prints : []).filter(validPrint))].slice(-MAX_PRINTS);
  // Правило без единого признака не опознаёт никого и висело бы в списке
  // обманкой: владелец видел бы «заблокирован», а витрина отдавалась бы всем.
  if (!ids.length && !ips.length && !prints.length) return null;
  return {
    id: /^[a-f0-9]{8,32}$/.test(String(r.id || '')) ? String(r.id) : crypto.randomBytes(6).toString('hex'),
    kind, note: clean(r.note, 160), ids, ips, prints,
    createdAt: Number(r.createdAt) || Date.now()
  };
}

/* Индекс «признак → правило», кэшированный ПО ССЫЛКЕ на массив из хранилища.
 *
 * Тот же приём, что у индекса отзывов и строки поиска: `db.readJson` отдаёт один
 * и тот же объект, пока не изменился mtime файла, поэтому кэш протухает вместе с
 * перечитанным файлом сам. Спрашивают его на КАЖДЫЙ запрос витрины, включая
 * картинки, — перебирать список и приводить его к порядку каждый раз значило бы
 * платить за блокировку, которой чаще всего нет вовсе.
 */
let cache = { src: null, index: null };
let complained = false;
function empty() { return { ids: new Map(), ips: new Map(), prints: new Map() }; }

/* Порченый файл правил НЕ РОНЯЕТ ВИТРИНУ. `readJson` на битом JSON бросает
 * исключение (и правильно делает: следующая запись иначе уничтожила бы данные),
 * но спрашивают его здесь на каждый запрос — и магазин отвечал бы пятисоткой
 * всем и на всё. Считаем, что правил нет, и говорим об этом в лог один раз.
 *
 * Панель при этом промолчать не имеет права: `add`/`remove` идут мимо этой
 * защиты, поэтому попытка изменить правила упрётся в ту же ошибку громко — и
 * ничего не перезапишет.
 */
function stored() {
  try { return db.getVisitorRules(); }
  catch (e) {
    if (!complained) { complained = true; console.error('Файл правил посетителей не читается, блокировки не действуют:', e.message); }
    return [];
  }
}

function index() {
  const src = stored();
  if (cache.src === src) return cache.index;
  const built = { all: [], block: empty(), skip: empty() };
  for (const raw of Array.isArray(src) ? src : []) {
    const rule = normalize(raw);
    if (!rule || built.all.length >= MAX_RULES) continue;
    built.all.push(rule);
    const bucket = built[rule.kind];
    // Первое правило с этим признаком и выигрывает: два блока на одну метку —
    // это опечатка владельца, а не повод выбирать между ними по-хитрому.
    for (const id of rule.ids) if (!bucket.ids.has(id)) bucket.ids.set(id, rule);
    for (const ip of rule.ips) if (!bucket.ips.has(ip)) bucket.ips.set(ip, rule);
    for (const p of rule.prints) if (!bucket.prints.has(p)) bucket.prints.set(p, rule);
  }
  built.all.sort((a, b) => b.createdAt - a.createdAt);
  cache = { src, index: built };
  return built;
}

function lookup(bucket, signals) {
  const s = signals || {};
  if (s.id && bucket.ids.has(s.id)) return bucket.ids.get(s.id);
  const ip = validIp(s.ip);
  if (ip && bucket.ips.has(ip)) return bucket.ips.get(ip);
  if (validPrint(s.print) && bucket.prints.has(s.print)) return bucket.prints.get(s.print);
  return null;
}

/* Правило для этих признаков. `kind` не задан — годится любое, и блок
 * проверяется первым: он сильнее, и человек, попавший под оба, витрину не
 * открывает вовсе. */
function match(kind, signals) {
  const idx = index();
  if (kind) return KINDS.includes(kind) ? lookup(idx[kind], signals) : null;
  return lookup(idx.block, signals) || lookup(idx.skip, signals);
}

function list() { return index().all; }
function get(ruleId) { return list().find(r => r.id === String(ruleId || '')) || null; }
// Какое правило уже стоит на этой карточке — этим панель и подписывает кнопки.
function forVisitor(visitor, kind) { return match(kind || null, signalsOf(visitor)); }

function save(rules) {
  db.saveVisitorRules(rules.slice(0, MAX_RULES));
  cache = { src: null, index: null };
  /* Открытые вкладки панели обязаны увидеть это сами: список правил и подписи
   * кнопок в карточке — часть раздела «Метрика», а он живой. Тема та же, что у
   * самой метрики: заводить ради двух списков третью незачем. */
  LIVE.bump('analytics');
}

function add(input) {
  const rule = normalize(Object.assign({ createdAt: Date.now() }, input));
  if (!rule) return null;
  // Правило на того же человека второй раз не заводим — иначе «Заблокировать»,
  // нажатое дважды, оставляло бы в списке двойника, который не снять одной
  // кнопкой. Признаки при этом дополняем: карточка могла узнать новый адрес.
  const known = match(rule.kind, { id: rule.ids[0], ip: rule.ips[0], print: rule.prints[0] });
  const rules = db.getVisitorRules().map(r => (r && typeof r === 'object' ? Object.assign({}, r) : r));
  if (known) {
    const target = rules.find(r => r && r.id === known.id);
    if (target) {
      target.ids = [...new Set([...(target.ids || []), ...rule.ids])].slice(-MAX_IDS);
      target.ips = [...new Set([...(target.ips || []), ...rule.ips])].slice(-MAX_IPS);
      target.prints = [...new Set([...(target.prints || []), ...rule.prints])].slice(-MAX_PRINTS);
      if (rule.note) target.note = rule.note;
      save(rules);
      return normalize(target);
    }
  }
  rules.unshift(rule);
  save(rules);
  return rule;
}

function remove(ruleId) {
  const id = String(ruleId || '');
  const rules = db.getVisitorRules();
  const kept = (Array.isArray(rules) ? rules : []).filter(r => !(r && r.id === id));
  if (kept.length === rules.length) return false;
  save(kept);
  hits.delete(id);
  return true;
}

/* Привязать к правилу новую метку посетителя: устройство узнали, а cookie у него
 * уже другая. Пишем только когда метка правда новая — файл иначе переписывался
 * бы на каждый заход заблокированного. */
function learn(rule, visitorId) {
  if (!rule || !validId(visitorId)) return false;
  if (rule.ids.includes(visitorId)) return false;
  const rules = db.getVisitorRules();
  const target = (Array.isArray(rules) ? rules : []).find(r => r && r.id === rule.id);
  if (!target) return false;
  const next = rules.map(r => (r === target ? Object.assign({}, r, { ids: [...new Set([...(r.ids || []), visitorId])].slice(-MAX_IDS) }) : r));
  save(next);
  return true;
}

/* Сколько раз правило сработало — В ПАМЯТИ и до перезапуска.
 *
 * Писать это в файл нельзя: заблокированный дёргает витрину сколько хочет, и
 * счётчик на диске стал бы для него ручкой «тысяча записей в секунду». А
 * ответить «блок правда работает» панель обязана — иначе владелец видит правило
 * и не знает, поймало оно кого-нибудь или нет.
 */
const hits = new Map();
function hit(rule) {
  if (!rule || !rule.id) return;
  const r = hits.get(rule.id) || { count: 0, at: 0 };
  r.count++; r.at = Date.now();
  hits.set(rule.id, r);
}
function hitsOf(ruleId) { return hits.get(String(ruleId || '')) || null; }

module.exports = {
  KINDS, MAX_RULES, MAX_IDS, printOf, signalsOf, match, list, get, forVisitor, add, remove, learn, hit, hitsOf
};
