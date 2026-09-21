'use strict';
/* Логин панели — e-mail или номер телефона владельца, и ничего третьего.
 *
 * Прежде логином была произвольная строка (`adminUsername`, по умолчанию
 * «admin»), и сверялась она посимвольно: «Owner@Mail.ru» и «owner@mail.ru»
 * были бы двумя разными логинами, а «8 999 123-45-67» — не тем же номером,
 * что «+7 999 123-45-67». Теперь у учётной записи два поля — `adminEmail` и
 * `adminPhone`, — войти можно по любому из них, а введённое ПРИВОДИТСЯ к
 * хранимой форме теми же модулями, что почта заказа и телефон покупателя:
 * адрес — нижним регистром (lib/email.js), номер — в E.164 (public/phone.js).
 * Своей проверки у входа нет: разъехавшись с ними, панель принимала бы адрес,
 * под который кабинет потом не заведётся, или номер, который заказ отверг.
 *
 * ПРЕЖНИЙ ЛОГИН НЕ ПРОПАДАЕТ, ПОКА НЕ ЗАДАН НОВЫЙ. Установка, обновившаяся со
 * старой версии, знает только `adminUsername`; отбрось мы его сразу — панель
 * оказалась бы заперта, и вернуть вход можно было бы только по SSH. Поэтому
 * он принимается ровно до тех пор, пока не заполнен ни e-mail, ни телефон
 * (`accepted()` пуст), а раздел настроек всё это время говорит о временном
 * логине. Логин, который и так был адресом или номером, `ensureSeeded()` в
 * lib/db.js переносит в новое поле сам.
 *
 * Модуль нарочно без зависимостей от остального проекта: его требуют и
 * lib/db.js, и server.js, и утилита сброса пароля.
 */
const EMAIL = require('./email');
const PHONE = require('../public/phone.js');

/* Введённое — к хранимой форме. Не адрес и не номер — пустая строка: такое не
 * сохраняется в настройки и не проходит на входе. Признак адреса — «@»: номер
 * телефона его не содержит никогда, а адрес — всегда. */
function normalize(value) {
  const raw = String(value == null ? '' : value).trim();
  if (!raw) return '';
  return raw.includes('@') ? EMAIL.valid(raw) : PHONE.store(raw);
}
function kindOf(value) {
  const key = normalize(value);
  return !key ? '' : (key.includes('@') ? 'email' : 'phone');
}

/* Что принимает вход: e-mail и телефон из настроек, уже в хранимой форме.
 * Сохранённое сверяется заново — файл правят и руками, и мусор в поле обязан
 * быть логином, который не работает, а не логином, который работает как
 * попало. */
function accepted(settings) {
  const s = settings || {};
  return [EMAIL.valid(s.adminEmail), PHONE.store(s.adminPhone)].filter(Boolean);
}
// Прежний логин — только пока не задан ни один новый (см. шапку).
function legacy(settings) {
  const s = settings || {};
  return accepted(s).length ? '' : String(s.adminUsername == null ? '' : s.adminUsername).trim();
}
function configured(settings) { return accepted(settings).length > 0; }

// Подходит ли введённое к учётной записи. Пароль здесь не при чём — его
// сверяет lib/auth.js, и сверяет ВСЕГДА, чтобы время ответа не выдавало логин.
function matches(settings, value) {
  const keys = accepted(settings);
  if (keys.length) {
    const key = normalize(value);
    return !!key && keys.includes(key);
  }
  const old = legacy(settings);
  return !!old && String(value == null ? '' : value).trim() === old;
}

/* Строка для маркера сессии (`authStamp` в server.js): смена любого из логинов
 * обязана разлогинить все открытые сессии. У установки на прежнем логине она
 * равна ему самому — то есть маркер после обновления не меняется, и владельца
 * не выбрасывает из панели просто за то, что код стал новее. */
function identity(settings) {
  return accepted(settings).join('|') || legacy(settings);
}

// Логины словами — для свёрнутой строки раздела и для утилиты сброса: номер
// показывается с разделителями, как всюду в панели.
function describe(settings) {
  return accepted(settings).map(key => key.includes('@') ? key : PHONE.format(key)).join(' · ');
}

module.exports = { normalize, kindOf, accepted, legacy, configured, matches, identity, describe };
