'use strict';
// Подсказки адресов dadata.ru. Ключ хранится в настройках и наружу не выходит:
// браузер спрашивает наш сервер, а он уже ходит в DaData. Так ключ не лежит
// в HTML и его нельзя увести со страницы.
//
// Документация: https://dadata.ru/api/suggest/address/
// Внешних зависимостей нет — fetch встроен в Node 18+, как и в lib/telegram.js.

const URL_SUGGEST = 'https://suggestions.dadata.ru/suggestions/api/4_1/rs/suggest/address';
const TIMEOUT = 4000;   // подсказки нужны «сейчас»: ждать дольше нет смысла

// Что показываем в списке: сам адрес и, отдельной строкой, индекс с регионом —
// в самом значении региона может не быть, а он помогает отличить одноимённые улицы.
function shape(s) {
  const d = s.data || {};
  const parts = [d.postal_code, d.region_with_type].filter(Boolean);
  const hint = parts.filter(x => !String(s.value || '').includes(x)).join(', ');
  return { value: String(s.value || '').slice(0, 400), hint: hint.slice(0, 120) };
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
