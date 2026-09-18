'use strict';
/*
 * Яндекс Метрика: кому и где подключать счётчик.
 *
 * Счётчик нужен ровно затем, чтобы Директ видел целевые действия и учил на
 * них свои стратегии. Всё остальное, что умеет Метрика, — вебвизор, карта
 * кликов, отчёты по всей аудитории, — магазину не нужно, а анонимности стоит.
 * Поэтому модуль отвечает на один вопрос: ОТДАВАТЬ ЛИ этому посетителю на этой
 * странице скрипт Яндекса. Сервер к Яндексу не ходит никогда, вся работа
 * счётчика идёт в браузере покупателя (`public/ym.js`).
 *
 * Три вещи, которые Яндекс узнавать не должен, и правило на каждую.
 *
 * 1. ВЛАДЕЛЕЦ ↔ МАГАЗИН. Живая сессия панели и правила «не считать» из
 *    метрики исключают человека из счётчика так же, как из своей метрики:
 *    решает та же `metricsSkipped()` в server.js, второго списка нет. Страницы
 *    панели, отслеживания (в адресе секретный ключ) и чека счётчика не получают
 *    вовсе (`pageAllowed`).
 * 2. САЙТ ↔ САЙТ. Номер счётчика стоит в HTML открытым текстом, и сервисы
 *    обратного поиска связывают сайты с одним номером публично. Поэтому номер —
 *    настройка каждого сайта (`ymCounterId`), а при переносе магазина на другой
 *    сервер он сбрасывается (`SITE_FIELDS` в scripts/import-store.js). В коде
 *    номера нет и быть не может: репозиторий открытый.
 * 3. ЧУЖИЕ ПОСЕТИТЕЛИ. По умолчанию (`ymOnlyYandex`) счётчик получают ТОЛЬКО
 *    те, кого Яндекс сам и привёл: визит с `yclid`, с `utm_source=yandex` или с
 *    переходом с yandex.*. Такой посетитель помечается first-party cookie
 *    (`am_ym`) на срок окна атрибуции, чтобы его возвраты и оплата позже тоже
 *    попали в счётчик. Пришедшие из Telegram, по прямой ссылке и постоянные
 *    покупатели для Яндекса не существуют. Директ от этого ничего не теряет —
 *    он считает только свои клики; неполными остаются лишь общие отчёты
 *    Метрики, и это цена решения.
 */

// Первая cookie нашего магазина, а не яндексовская: её ставит сервер, и по ней
// же он решает, отдавать ли скрипт. HttpOnly — читать её браузеру незачем.
const COOKIE = 'am_ym';

/* Срок метки «пришёл из Яндекса». Метрика связывает конверсию с переходом,
 * случившимся до 90 дней назад, — столько же должна жить и наша метка, иначе
 * покупатель, вернувшийся за оплатой через месяц, для Яндекса потерялся бы, а
 * Директ не увидел бы конверсию, за которую заплатил. */
const SOURCE_DAYS = 90;

// Номер счётчика — только цифры и не длиннее 12: он уезжает в атрибут разметки
// и в адрес скрипта, и чужая строка там — уже не номер.
const ID_RE = /^\d{1,12}$/;

// Хосты Яндекса в реферере: поиск, главная, региональные зоны и `yandex.com.tr`.
const REF_HOST_RE = /(^|\.)(yandex\.[a-z.]{2,10}|ya\.ru)$/i;

// Номер счётчика из настроек: '' — счётчика нет. Мусор в настройках (правка
// руками) читается как «нет счётчика», а не роняет витрину.
function counterId(settings) {
  const raw = String((settings && settings.ymCounterId) || '').trim();
  return ID_RE.test(raw) ? raw : '';
}

// Разбор поля формы: '' у пустого, null у негодного — форма должна назвать
// ошибку, а не молча стереть номер.
function parseCounter(value) {
  const raw = String(value == null ? '' : value).replace(/\s+/g, '');
  if (!raw) return '';
  return ID_RE.test(raw) ? raw : null;
}

// Поля нет — считаем «только из Яндекса»: это режим по умолчанию, и магазин,
// который об этом не просил, не должен отдавать Яндексу всех посетителей.
function onlyYandex(settings) {
  return !(settings && settings.ymOnlyYandex === false);
}

// Куда счётчик не отдаётся никогда: панель, отслеживание (секретный ключ в
// адресе), чек и всё служебное. Список — запрет, а не разрешение, чтобы не
// заводить вторую копию `PUBLIC_PAGES` из server.js.
function pageAllowed(pathname) {
  const p = String(pathname || '');
  // Кабинет покупателя — в том же ряду, что чек и отслеживание: там почта и
  // заказы, и в чужую статистику им не место.
  return !/^\/(admin|track|receipt|account|internal|api|static|uploads|map)(\/|$)/i.test(p);
}

// Пришёл ли этот запрос из Яндекса: метка Директа в адресе, UTM-источник или
// переход с самого Яндекса.
function fromYandex(req) {
  if (!req) return false;
  const q = req.query || {};
  if (String(q.yclid || '').trim()) return true;
  if (/^yandex/i.test(String(q.utm_source || '').trim())) return true;
  const ref = req.headers && req.headers.referer;
  if (!ref) return false;
  let host = '';
  try { host = new URL(String(ref)).hostname; } catch (e) { return false; }
  return REF_HOST_RE.test(host);
}

// Стоит ли уже наша метка.
function marked(req) {
  const cookie = req && req.headers && req.headers.cookie;
  if (!cookie) return false;
  return String(cookie).split(';').some(part => part.trim() === COOKIE + '=1');
}

function cookieHeader(secure) {
  return `${COOKIE}=1; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SOURCE_DAYS * 86400}${secure ? '; Secure' : ''}`;
}

/* Ставить ли метку этому запросу. Только в режиме «только из Яндекса» и только
 * тому, кто правда пришёл оттуда и ещё не помечен: в режиме «все посетители»
 * метка не нужна вовсе, а обновлять её на каждом заходе значило бы плодить
 * заголовок Set-Cookie на каждой странице. */
function markNeeded(settings, req) {
  return !!counterId(settings) && onlyYandex(settings) && !marked(req) && fromYandex(req);
}

/* Отдавать ли счётчик. `skipped` — то, что решил сервер про самого человека
 * (владелец в панели, правило «не считать», отказ от метрики): у модуля нет
 * доступа к сессии, и решать это за сервер он не должен. */
function decide(settings, req, skipped) {
  const id = counterId(settings);
  if (!id || skipped) return null;
  if (!pageAllowed(req && req.pathname)) return null;
  if (onlyYandex(settings) && !marked(req) && !fromYandex(req)) return null;
  return { id };
}

module.exports = { COOKIE, SOURCE_DAYS, counterId, parseCounter, onlyYandex, pageAllowed, fromYandex, marked, cookieHeader, markNeeded, decide };
