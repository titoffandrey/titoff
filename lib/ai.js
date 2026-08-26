'use strict';
/* ==================== Ответы ИИ: клиент OpenAI со стримингом ====================
 *
 * Единственное место в проекте, которое ходит в OpenAI. Наружу отдаёт ровно две
 * вещи: `stream()` — ответ по кускам, и `configured()` — задан ли ключ.
 *
 * ПОЧЕМУ СТРИМИНГ, А НЕ ОБЫЧНЫЙ ЗАПРОС. Целиком ответ модель отдаёт за 2–6
 * секунд, и всё это время покупатель смотрит на пустое окно — а он пришёл с
 * витрины, где страница открывается за 300 мс, и уходит быстрее, чем успевает
 * дочитать «печатает…». Со `stream: true` первые слова появляются через
 * 300–600 мс, то есть примерно тогда же, когда открылось бы любое окно, и
 * дальше текст идёт живой лентой. Разница не в общем времени ответа — оно то же
 * самое, — а в том, ждёт человек молча или уже читает.
 *
 * Формат потока у OpenAI — те же Server-Sent Events, что мы отдаём панели и
 * витрине: строки `data: {…}` и `data: [DONE]` в конце. Разбирается это в
 * тридцать строк, поэтому SDK здесь не нужен — как и везде в проекте.
 *
 * КЛЮЧ ЖИВЁТ ТОЛЬКО НА СЕРВЕРЕ. В браузер он не уезжает ни в каком виде: витрина
 * шлёт вопрос нам, в OpenAI ходит сервер. Иначе ключ снимался бы со страницы
 * первым же «посмотреть код» — и платил бы за это владелец магазина.
 */

const API_URL = 'https://api.openai.com/v1/chat/completions';
// Модель по умолчанию. Меняется в панели: список у OpenAI живёт своей жизнью, и
// зашивать его в код значило бы выкатку ради строки в настройках.
const DEFAULT_MODEL = 'gpt-4o-mini';
/* Сколько ждём ПЕРВОГО куска. Он и есть та задержка, которую видит покупатель;
 * не пришёл за 12 секунд — модель уже не спасёт разговор, отвечаем сами. */
const FIRST_CHUNK_TIMEOUT = 12000;
// Общий предел на ответ. Длиннее покупателю и не нужно: это чат, а не статья.
const TOTAL_TIMEOUT = 60000;
const MAX_TOKENS = 700;
// Отвечать надо предсказуемо: цены и условия магазина — не то место, где нужна
// фантазия. Ноль не ставим, иначе ответы становятся канцелярски одинаковыми.
const TEMPERATURE = 0.3;
// Сама попытка плюс две поправки — по одной на каждый параметр, который модель
// может не принять (см. ниже). Больше повторов не бывает: каждая поправка
// снимает ровно тот параметр, на который пожаловалось API.
const MAX_ATTEMPTS = 3;

function apiKey(settings) { return String(settings && settings.aiApiKey || '').trim(); }
function configured(settings) { return !!apiKey(settings); }
function modelOf(settings) { return String(settings && settings.aiModel || '').trim() || DEFAULT_MODEL; }
/* Свой адрес API. Нужен для совместимых шлюзов (их API повторяет OpenAI
 * дословно) и для прокси. Пустое поле — обычный OpenAI.
 *
 * Значение уходит в `fetch`, поэтому схема проверяется здесь: строка вида
 * `file://…` или `http://169.254.169.254/…` в этом поле — это запрос сервера
 * туда, куда его послал текст из формы. Разрешаем только https и только явный
 * хост. */
function endpointOf(settings) {
  const raw = String(settings && settings.aiBaseUrl || '').trim();
  if (!raw) return API_URL;
  let url;
  try { url = new URL(raw); } catch (e) { return API_URL; }
  if (url.protocol !== 'https:' || !url.hostname) return API_URL;
  const base = url.origin + url.pathname.replace(/\/+$/, '');
  // Адрес дают и «до /v1», и полностью — принимаем оба, чтобы настройка не
  // требовала знания, как именно у шлюза называется метод.
  return /\/chat\/completions$/.test(base) ? base : base + '/chat/completions';
}

/* Разбор строки потока. Возвращает текст очередного куска либо '' — служебные
 * строки (роль, пустые delta, keep-alive) в ответ не попадают. */
function deltaOf(payload) {
  const choice = payload && Array.isArray(payload.choices) ? payload.choices[0] : null;
  const delta = choice && choice.delta;
  const text = delta && typeof delta.content === 'string' ? delta.content : '';
  return text;
}

/* ЧТО ИМЕННО ПРИНИМАЕТ МОДЕЛЬ, СПРАШИВАЕМ У САМОГО API.
 *
 * У новых моделей OpenAI параметры другие: `max_tokens` они не принимают вовсе
 * («Use 'max_completion_tokens' instead»), а температуру — только свою, по
 * умолчанию. У прежних моделей и у совместимых шлюзов всё наоборот: они знают
 * `max_tokens`. Ответ на 400 при этом одинаковый для покупателя — консультант
 * говорит «секунду, уточню» и молчит, — и по витрине не догадаться, что дело в
 * одном слове в теле запроса. Ровно так и вышло: в панели выставили `gpt-5.6-luna`,
 * и чат отвечал запасной фразой на КАЖДЫЙ вопрос, пока в логе лежало
 * «Unsupported parameter: 'max_tokens'».
 *
 * Список моделей живёт у OpenAI своей жизнью и меняется в панели без выкатки —
 * поэтому зашивать «этим моделям так, а этим эдак» нельзя: первая же следующая
 * модель в поле настроек снова оставила бы покупателя без ответа. Вместо
 * угадывания читаем сам отказ: в теле 400 API называет параметр (`param`), из-за
 * которого не взялось. Правим ровно его, повторяем запрос — и ЗАПОМИНАЕМ
 * поправку на пару «адрес + модель», так что лишний заход стоит по разу на
 * модель за жизнь процесса, а не на каждое сообщение покупателя.
 */
const shapes = new Map();

function shapeOf(memo) {
  const known = shapes.get(memo);
  // По умолчанию — как было: `max_tokens` и своя температура. Совместимые
  // шлюзы другого языка могут и не знать, а начинать с новых имён значило бы
  // ломать то, что работает.
  return known ? { maxKey: known.maxKey, temperature: known.temperature }
    : { maxKey: 'max_tokens', temperature: true };
}

function bodyOf(model, messages, shape) {
  const body = { model, messages, stream: true };
  if (shape.temperature) body.temperature = TEMPERATURE;
  body[shape.maxKey] = MAX_TOKENS;
  return body;
}

/* Поправка по отказу API: {shape, note} либо null — «повтором это не лечится».
 *
 * Смотрим на `param`, а не на `code`: у предела ответа это
 * `unsupported_parameter`, у температуры `unsupported_value`, и список кодов
 * так же не наш, как и список моделей. */
function fixShape(shape, detail) {
  let param = '';
  try { param = String((JSON.parse(detail).error || {}).param || ''); }
  catch (e) { return null; }
  if (param === 'max_tokens' && shape.maxKey === 'max_tokens') {
    return { shape: { maxKey: 'max_completion_tokens', temperature: shape.temperature }, note: 'предел ответа задаётся как max_completion_tokens' };
  }
  if (param === 'max_completion_tokens' && shape.maxKey === 'max_completion_tokens') {
    return { shape: { maxKey: 'max_tokens', temperature: shape.temperature }, note: 'предел ответа задаётся как max_tokens' };
  }
  if (param === 'temperature' && shape.temperature) {
    return { shape: { maxKey: shape.maxKey, temperature: false }, note: 'температура только своя, не задаём' };
  }
  return null;
}

/* Ответ модели по кускам.
 *
 *   messages — [{role:'system'|'user'|'assistant', content}]
 *   onDelta  — вызывается на каждый кусок текста; вернёт false — поток
 *              останавливается (покупатель закрыл чат, ждать больше некому)
 *
 * Отдаёт {ok, text, error}. Ошибку наружу пишем словами и без подробностей
 * чужого API: их читает покупатель, а не разработчик — в лог уходит полная.
 */
async function stream(settings, messages, onDelta) {
  const key = apiKey(settings);
  if (!key) return { ok: false, text: '', error: 'not_configured' };

  const url = endpointOf(settings);
  const model = modelOf(settings);
  const memo = url + '|' + model;
  let shape = shapeOf(memo);

  for (let attempt = 1; ; attempt++) {
    const out = await once(key, url, bodyOf(model, messages, shape), onDelta);
    const fix = out.detail ? fixShape(shape, out.detail) : null;
    if (!fix || attempt >= MAX_ATTEMPTS) {
      // Отказ, который повтором не вылечить, — в лог целиком: по строке
      // «модель не ответила» владельцу не понять ни ключа, ни лимита.
      if (out.detail) console.error('ИИ ответил отказом: HTTP ' + out.status + ' ' + out.detail.slice(0, 400));
      return out.result;
    }
    shape = fix.shape;
    /* Запоминаем ДО повтора: пока мы ходим ещё раз, соседний диалог не должен
     * наступать на те же грабли. */
    shapes.set(memo, shape);
    console.log('ИИ: модель ' + model + ' — ' + fix.note);
  }
}

/* Один заход в модель. Отдаёт {result, status, detail}: `detail` не пустой
 * только у отказа с телом, по нему выше и решается, повторять ли запрос с
 * поправленной формой. Повтор возможен ровно до первого куска потока, поэтому
 * покупатель ни при каком исходе не видит ответ дважды. */
async function once(key, url, body, onDelta) {
  const controller = new AbortController();
  // Два срока, а не один: общий предел не спасает от модели, которая молчит
  // первые полминуты, а потом печатает быстро. Покупателя губит именно тишина
  // в начале, поэтому у первого куска свой, короткий срок.
  let firstChunk = true;
  const guard = setTimeout(() => controller.abort(), FIRST_CHUNK_TIMEOUT);
  const total = setTimeout(() => controller.abort(), TOTAL_TIMEOUT);
  if (guard.unref) guard.unref();
  if (total.unref) total.unref();

  let text = '';
  try {
    const res = await fetch(url, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Authorization': 'Bearer ' + key,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body)
    });

    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      clearTimeout(guard); clearTimeout(total);
      // 401 у ключа и 429 у лимита — разные беды владельца магазина, и в панели
      // они должны читаться по-разному.
      const code = res.status === 401 || res.status === 403 ? 'bad_key'
        : res.status === 429 ? 'rate_limit'
          : res.status >= 500 ? 'upstream' : 'request';
      return { result: { ok: false, text: '', error: code }, status: res.status, detail };
    }
    if (!res.body) {
      clearTimeout(guard); clearTimeout(total);
      return { result: { ok: false, text: '', error: 'upstream' }, status: res.status, detail: '' };
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let stopped = false;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (firstChunk) { firstChunk = false; clearTimeout(guard); }
      buffer += decoder.decode(value, { stream: true });

      // Событие SSE заканчивается пустой строкой; последний кусок буфера может
      // оказаться незавершённым — он остаётся ждать следующего чтения.
      let edge;
      while ((edge = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, edge).trim();
        buffer = buffer.slice(edge + 1);
        if (!line || line.startsWith(':')) continue;      // keep-alive
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (payload === '[DONE]') { stopped = true; break; }
        let parsed = null;
        try { parsed = JSON.parse(payload); }
        catch (e) { continue; }                            // битую строку пропускаем
        const piece = deltaOf(parsed);
        if (!piece) continue;
        text += piece;
        // Слушатель вправе остановить поток: если покупатель закрыл вкладку,
        // дописывать ответ некому, а токены платные.
        if (onDelta && onDelta(piece) === false) { stopped = true; break; }
      }
      if (stopped) break;
    }
    try { await reader.cancel(); } catch (e) {}
    clearTimeout(guard); clearTimeout(total);
    if (!text.trim()) console.error('ИИ вернул пустой ответ');
    return { result: { ok: !!text.trim(), text: text.trim(), error: text.trim() ? '' : 'empty' }, status: res.status, detail: '' };
  } catch (e) {
    clearTimeout(guard); clearTimeout(total);
    const aborted = e && (e.name === 'AbortError' || /aborted/i.test(String(e.message || '')));
    // Успели напечатать хоть что-то до обрыва — это ответ, а не отказ: половина
    // фразы полезнее, чем «сервис недоступен».
    if (text.trim()) return { result: { ok: true, text: text.trim(), error: aborted ? 'timeout' : 'network' }, status: 0, detail: '' };
    console.error('ИИ не ответил: ' + String(e && e.message || e));
    return { result: { ok: false, text: '', error: aborted ? 'timeout' : 'network' }, status: 0, detail: '' };
  }
}

module.exports = {
  DEFAULT_MODEL, FIRST_CHUNK_TIMEOUT, TOTAL_TIMEOUT, MAX_TOKENS,
  configured, modelOf, endpointOf, stream
};
