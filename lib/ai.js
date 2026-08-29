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
/* В правилах ответ ограничен четырьмя короткими фразами, а на бою самый
 * большой ответ вместе с рассуждением далеко не дошёл до 200 токенов. 400 —
 * двойной запас на подбор нескольких товаров и одновременно предохранитель от
 * дорогого зацикливания. Это потолок, а не предоплата: обычный ответ от его
 * уменьшения не становится дешевле или короче насильно. */
const MAX_TOKENS = 400;
// Отвечать надо предсказуемо: цены и условия магазина — не то место, где нужна
// фантазия. Ноль не ставим, иначе ответы становятся канцелярски одинаковыми.
const TEMPERATURE = 0.3;

/* ---- Необязательные параметры: то, без чего модель ответит, но с чем это
 * дешевле. Каждый из них модель может не знать — тогда он снимается сам
 * (см. `fixShape`), поэтому список безопасен и для старых моделей, и для
 * совместимых шлюзов.
 *
 * `reasoning_effort` — сколько модель «думает» перед ответом. Рассуждения
 * оплачиваются как ВЫХОДНЫЕ токены, то есть по самой дорогой ставке, а у нас
 * работа простая: найти товар в списке и ответить двумя фразами. Замер на
 * боевом ключе, три живых вопроса: и при `low`, и при `none` рассуждений вышло
 * ровно 0 токенов, ответы одинаковой длины и качества, — но `none` запрещает
 * модели думать вовсе, поэтому берём `low`: на простом вопросе он не стоит
 * ничего, а на сложном («что посоветуете до 70 тысяч») оставляет запас. Без
 * этого параметра модель думает по своему усмотрению: на пустячном «скажи
 * слово» она потратила 20 токенов рассуждений.
 *
 * `verbosity` — просьба отвечать коротко. То же самое сказано и словами в
 * правилах, но это дешевле повторить параметром, чем платить за длинный ответ.
 *
 * `prompt_cache_key` и `prompt_cache_options` — про кэш начала запроса
 * (см. `systemPrompt` в lib/chat-prompt.js): ключ помогает OpenAI отправить
 * запрос туда, где уже лежит наш каталог, а ttl продлевает жизнь кэша до
 * получаса — ровно на паузы в разговоре, когда покупатель отвлёкся. В implicit
 * режиме модель кэширует и растущий разговор; для неизменного system-префикса
 * ниже дополнительно ставится явная граница.
 *
 * `stream_options` — попросить прислать расход в конце потока. Стоит он ноль,
 * а без него мы не знаем ни во что обходится чат, ни работает ли кэш вообще. */
const REASONING = 'low';
const VERBOSITY = 'low';
const CACHE_KEY = 'istore-chat';
const CACHE_TTL = '30m';
const EXTRAS = {
  temperature: TEMPERATURE,
  reasoning_effort: REASONING,
  verbosity: VERBOSITY,
  prompt_cache_key: CACHE_KEY,
  prompt_cache_options: { mode: 'implicit', ttl: CACHE_TTL },
  stream_options: { include_usage: true }
};
/* safety_identifier приходит на каждый запрос отдельно, но ведёт себя как
 * остальные необязательные поля: совместимый шлюз может его не знать, тогда
 * `fixShape` снимет только его. */
const EXTRA_NAMES = Object.keys(EXTRAS).concat('safety_identifier');
// Сама попытка, поправка на имя предела и по одной на каждый необязательный
// параметр: больше поправок взяться неоткуда — каждая снимает ровно то, на что
// пожаловалось API, и дважды одно и то же не снимается.
const MAX_ATTEMPTS = 2 + EXTRA_NAMES.length;

function apiKey(settings) { return String(settings && settings.aiApiKey || '').trim(); }
function configured(settings) { return !!apiKey(settings); }
/* ОТВЕЧАЕТ ли консультант — это НЕ то же самое, что «ключ задан».
 *
 * Галочка в настройках выключает бота, не трогая ключ: владелец вправе увести
 * все вопросы на живого менеджера — на время, на выходные, на разбор жалоб, —
 * и возвращать его потом одной галочкой, а не искать ключ заново. Поэтому
 * `configured()` продолжает отвечать «ключ на месте» (по нему панель отличает
 * ненастроенную кассу от выключенной), а спрашивать «ответит ли он сейчас»
 * надо у `enabled()`.
 *
 * Поля нет вовсе — считаем включённым: так работали все установки до появления
 * галочки, и молча замолчавший чат после обновления был бы худшим сюрпризом.
 */
function enabled(settings) {
  return configured(settings) && (!settings || settings.aiEnabled !== false);
}
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
 * Для нынешней официальной семьи GPT-5.6 форма опубликована и подтверждена
 * боевыми логами, поэтому начинаем сразу с `max_completion_tokens` и без
 * температуры: иначе ПЕРВЫЙ покупатель после каждого перезапуска платил
 * временем за два гарантированных HTTP 400. Для любой следующей модели и для
 * совместимых шлюзов угадывать по имени всё равно нельзя: в теле 400 API
 * называет параметр (`param`), из-за которого не взялось. Правим ровно его,
 * повторяем запрос и запоминаем поправку на пару «адрес + модель».
 */
const shapes = new Map();

function officialGpt56(url, model) {
  let host = '';
  try { host = new URL(url).hostname; } catch (e) { host = ''; }
  return host === 'api.openai.com' && /^gpt-5\.6(?:-|$)/.test(model);
}

function shapeOf(memo, url, model) {
  const known = shapes.get(memo);
  if (!known && officialGpt56(url, model)) return { maxKey: 'max_completion_tokens', off: ['temperature'] };
  // По умолчанию — как было: `max_tokens` и все необязательные параметры.
  // Совместимые шлюзы новых имён могут и не знать, а начинать с них значило бы
  // ломать то, что работает.
  return known ? { maxKey: known.maxKey, off: known.off.slice() } : { maxKey: 'max_tokens', off: [] };
}

/* GPT-5.6 понимает developer-роль и явные границы кэша. Неизменное первое
 * сообщение — правила, условия и каталог — оборачиваем в text-блок и ставим
 * границу в его конце. Тогда первый запрос нового диалога переиспользует этот
 * общий префикс, даже если реплика покупателя отличается; implicit-граница при
 * этом продолжает кэшировать растущую историю внутри одного разговора. Старые
 * модели и сторонние шлюзы получают прежний массив строк без изменений. */
function messagesOf(messages, modern) {
  if (!modern || !Array.isArray(messages)) return messages;
  let marked = false;
  return messages.map(message => {
    if (!message || message.role !== 'system') return message;
    const out = Object.assign({}, message, { role: 'developer' });
    if (!marked && typeof message.content === 'string') {
      marked = true;
      out.content = [{
        type: 'text',
        text: message.content,
        prompt_cache_breakpoint: { mode: 'explicit' }
      }];
    }
    return out;
  });
}

function bodyOf(model, messages, shape, options) {
  const modern = officialGpt56(options.url, model);
  const body = { model, messages: messagesOf(messages, modern), stream: true };
  body[shape.maxKey] = MAX_TOKENS;
  for (const name of Object.keys(EXTRAS)) if (shape.off.indexOf(name) < 0) body[name] = EXTRAS[name];
  const safety = String(options.safetyIdentifier || '').trim().slice(0, 64);
  if (safety && shape.off.indexOf('safety_identifier') < 0) body.safety_identifier = safety;
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
  catch (e) { param = ''; }
  if (param === 'max_tokens' && shape.maxKey === 'max_tokens') {
    return { shape: { maxKey: 'max_completion_tokens', off: shape.off }, note: 'предел ответа задаётся как max_completion_tokens' };
  }
  if (param === 'max_completion_tokens' && shape.maxKey === 'max_completion_tokens') {
    return { shape: { maxKey: 'max_tokens', off: shape.off }, note: 'предел ответа задаётся как max_tokens' };
  }
  if (EXTRA_NAMES.indexOf(param) >= 0 && shape.off.indexOf(param) < 0) {
    return { shape: { maxKey: shape.maxKey, off: shape.off.concat(param) }, note: 'не принимает ' + param + ' — обходимся без него' };
  }
  /* Отказ, в котором параметр не назван вовсе. У OpenAI такого не бывает, но
   * совместимый шлюз вправе ответить одной фразой «unknown field» — и без этой
   * ветки покупатель у такого шлюза не получал бы ответа НИКОГДА, потому что
   * каждый наш запрос нёс бы незнакомую ему строку. Снимаем всё необязательное
   * разом: пусть дороже, зато отвечает. */
  if (!param && shape.off.length < EXTRA_NAMES.length) {
    return { shape: { maxKey: shape.maxKey, off: EXTRA_NAMES.slice() }, note: 'параметр в отказе не назван — убираю все необязательные' };
  }
  return null;
}

/* Во что обошёлся ответ — одной строкой. Без неё не увидеть ни расхода, ни
 * того, работает ли кэш: он молчалив по устройству — «из кэша 0» вместо
 * привычных трёх с половиной тысяч выглядит одинаково и при поломке порядка
 * сообщений, и при остывшем кэше, а иначе об этом не узнать вовсе. */
function logUsage(usage) {
  const inputDetails = usage.input_tokens_details || usage.prompt_tokens_details || {};
  const outputDetails = usage.output_tokens_details || usage.completion_tokens_details || {};
  const input = usage.input_tokens || usage.prompt_tokens || 0;
  const output = usage.output_tokens || usage.completion_tokens || 0;
  const cached = inputDetails.cached_tokens || 0;
  const written = inputDetails.cache_write_tokens || 0;
  const reasoning = outputDetails.reasoning_tokens || 0;
  const answer = Math.max(0, output - reasoning);
  console.log('ИИ: вход ' + input + ' (из кэша ' + cached + (written ? ', запись в кэш ' + written : '') + '), ответ ' + answer
    + (reasoning ? ', рассуждения ' + reasoning : ''));
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
async function stream(settings, messages, onDelta, options) {
  const key = apiKey(settings);
  if (!key) return { ok: false, text: '', error: 'not_configured' };

  const url = endpointOf(settings);
  const model = modelOf(settings);
  const memo = url + '|' + model;
  let shape = shapeOf(memo, url, model);
  options = options || {};

  for (let attempt = 1; ; attempt++) {
    const out = await once(key, url, bodyOf(model, messages, shape, {
      url,
      safetyIdentifier: options.safetyIdentifier
    }), onDelta);
    /* Поправляем форму только на 400: это и означает «запрос собран не так».
     * Плохой ключ, лимит и упавший сервис повторять нечем, а лишний заход там
     * стоил бы покупателю ещё одной секунды тишины. */
    const fix = out.status === 400 ? fixShape(shape, out.detail) : null;
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
    let usage = null;

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
        // Расход приезжает отдельным куском в самом конце, без текста.
        if (parsed && parsed.usage) usage = parsed.usage;
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
    if (usage) logUsage(usage);
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
  configured, enabled, modelOf, endpointOf, stream
};
