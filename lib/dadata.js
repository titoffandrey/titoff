'use strict';
// Подсказки адресов dadata.ru. Ключ хранится в настройках и наружу не выходит:
// браузер спрашивает наш сервер, а он уже ходит в DaData. Так ключ не лежит
// в HTML и его нельзя увести со страницы.
//
// Документация: https://dadata.ru/api/suggest/address/
// Внешних зависимостей нет — fetch встроен в Node 18+, как и в lib/telegram.js.

const URL_SUGGEST = 'https://suggestions.dadata.ru/suggestions/api/4_1/rs/suggest/address';
const TIMEOUT = 4000;   // подсказки нужны «сейчас»: ждать дольше нет смысла

/* Что показываем в списке: сам адрес и, отдельной строкой, индекс с регионом —
 * в самом значении региона может не быть, а он помогает отличить одноимённые улицы.
 *
 * Вместе с подсказкой приходят и КООРДИНАТЫ дома, и они здесь не лишние: по ним
 * ищутся ближайшие пункты выдачи (lib/pickup.js). Отдельный геокодер заводить не
 * нужно — адрес уже разобран тем, кого мы и так спрашиваем.
 *
 * Берём их только у точных ответов. `qc_geo` — насколько уверенно найдено место:
 * 0 — дом, 1 — ближайший дом, 2 — улица; 3 и 4 — это уже центр района или города,
 * и «пункт в 400 м» от такой точки означал бы не то, что покупатель прочитает.
 * Там витрина сама уйдёт на поиск по названию города, где расстояний нет вовсе.
 */
const GEO_EXACT = new Set(['0', '1', '2']);

function shape(s) {
  const d = s.data || {};
  const parts = [d.postal_code, d.region_with_type].filter(Boolean);
  const hint = parts.filter(x => !String(s.value || '').includes(x)).join(', ');
  const out = { value: String(s.value || '').slice(0, 400), hint: hint.slice(0, 120) };
  const lat = Number(d.geo_lat), lon = Number(d.geo_lon);
  if (GEO_EXACT.has(String(d.qc_geo)) && Number.isFinite(lat) && Number.isFinite(lon)) {
    out.lat = lat; out.lon = lon;
  }
  return out;
}

// Вернуть подсказки по строке. Ошибки не бросаем: подсказки — необязательная
// помощь, при любой проблеме покупатель просто вводит адрес руками.
async function suggestAddress(token, query, count) {
  const q = String(query || '').trim();
  if (!token) return { ok: false, reason: 'not_configured', items: [] };
  if (q.length < 3) return { ok: true, items: [] };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT);
  if (timer.unref) timer.unref();
  try {
    const res = await fetch(URL_SUGGEST, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        Authorization: 'Token ' + token
      },
      body: JSON.stringify({ query: q.slice(0, 300), count: Math.max(1, Math.min(10, Number(count) || 7)) })
    });
    if (!res.ok) return { ok: false, reason: 'http_' + res.status, items: [] };
    const data = await res.json().catch(() => null);
    const list = (data && Array.isArray(data.suggestions)) ? data.suggestions : [];
    return { ok: true, items: list.map(shape).filter(x => x.value) };
  } catch (e) {
    return { ok: false, reason: String((e && e.name) === 'AbortError' ? 'timeout' : (e && e.message) || e), items: [] };
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { suggestAddress };
