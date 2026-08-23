'use strict';
/*
 * Кто к нам пришёл: адрес посетителя и можно ли верить forwarded-заголовкам.
 *
 * Вынесено из server.js отдельным модулем ровно по той же причине, по которой
 * отдельно живут доставка, адрес и телефон: к этому адресу привязаны счётчик
 * попыток входа в панель, все антиспам-лимиты и карточка метрики. Внутри
 * server.js эту логику нельзя было проверить тестом — файл поднимает слушателя
 * при загрузке, — а проверять её надо, потому что ошибка здесь не видна ничем.
 *
 * ЧТО ЗДЕСЬ БЫЛО СЛОМАНО. Прокси (у нас Caddy) ДОПИСЫВАЕТ адрес посетителя в
 * конец `X-Forwarded-For`, а не заменяет заголовок. Запрос, отправленный с
 * «X-Forwarded-For: 8.8.8.8», приезжал к приложению как «8.8.8.8, <настоящий
 * адрес>» — и код брал первый элемент. Ещё раньше в списке стоял
 * `CF-Connecting-IP`, которого наш прокси не ставит вовсе и который поэтому
 * целиком приходил от посетителя. В обоих случаях клиент сам выбирал себе «IP»:
 * меняя заголовок на каждом запросе, пароль к панели можно было подбирать
 * бесконечно, ни разу не поймав блокировку.
 *
 * Правило простое: доверять можно ТОЛЬКО тому, что дописали наши собственные
 * прокси, то есть правому хвосту цепочки. Всё, что левее, прислал клиент.
 */
const { normalizeIp } = require('./analytics');

function isLoopback(address) {
  return /^(?:127(?:\.\d+){3}|::1|::ffff:127(?:\.\d+){3})$/.test(String(address || ''));
}

/* Значение forwarded-заголовка, которому можно верить.
 *
 * `hops` — сколько доверенных прокси стоит перед приложением. У нас это один
 * Caddy на петле. Берём элемент, отсчитанный от КОНЦА: при одном прокси это
 * последний элемент, который он сам и дописал.
 *
 * Цепочка короче объявленного числа прокси — значит свои хопы её не дописали, и
 * верить в ней нечему: возвращаем пустую строку, вызывающий возьмёт адрес
 * сокета. Заголовок с одним значением (так прокси ставит host и proto) при
 * одном хопе читается как раньше: правый элемент у него единственный.
 */
function forwardedValue(headers, name, hops) {
  const count = Math.min(10, Math.max(1, Math.floor(Number(hops)) || 1));
  const chain = String((headers && headers[name]) || '').split(',').map(s => s.trim()).filter(Boolean);
  if (chain.length < count) return '';
  return chain[chain.length - count] || '';
}

/* Адрес посетителя.
 *
 * `opts.trusted` — пришёл ли запрос от доверенного прокси; `opts.hops` — длина
 * его цепочки; `opts.cloudflare` — стоим ли мы РЕАЛЬНО за Cloudflare (только
 * тогда `CF-Connecting-IP` ставит он, а не посетитель); `opts.realIp` — читать
 * ли `X-Real-IP` (наш прокси его не ставит, поэтому по умолчанию нет).
 */
function clientIpFrom(req, opts) {
  const o = opts || {};
  const headers = (req && req.headers) || {};
  const socketIp = req && req.socket && req.socket.remoteAddress;
  const cloudflare = o.trusted && o.cloudflare ? String(headers['cf-connecting-ip'] || '').trim() : '';
  const forwarded = o.trusted ? forwardedValue(headers, 'x-forwarded-for', o.hops) : '';
  const real = o.trusted && o.realIp ? String(headers['x-real-ip'] || '').trim() : '';
  for (const candidate of [cloudflare, forwarded, real, socketIp]) {
    const ip = normalizeIp(candidate);
    if (ip) return ip;
  }
  return '?';
}

module.exports = { isLoopback, forwardedValue, clientIpFrom };
