'use strict';
/* ===================== Город по IP — своей базой, без чужого API =====================
 *
 * Раньше город определялся внешним сервисом (`ipwho.is`) на каждый новый адрес.
 * Работало это ровно до тех пор, пока трафика было мало, и сломалось молча,
 * когда его стало много: у бесплатного тарифа 1000 запросов в сутки, наш
 * предохранитель стоит на 900, а посетителей стало больше тысячи в день. С
 * середины дня все новые визиты получали «Город не определён» — и никакой
 * ошибки при этом нигде не появлялось.
 *
 * Вторая причина важнее первой: КАЖДЫЙ адрес посетителя уходил третьей стороне.
 * Магазин, который прячет свой домен за Tor и не пускает наружу ни одного
 * лишнего запроса с витрины, отдавал чужому сервису список всех, кто на неё
 * заходил.
 *
 * Поэтому база лежит у нас. Устройство простое настолько, насколько возможно:
 *
 *   1. `scripts/sync-geoip.js` раз в месяц скачивает DB-IP City Lite (свободная
 *      лицензия CC BY 4.0) и пережимает её в компактный двоичный файл рядом с
 *      данными — `geoip.bin`.
 *   2. Здесь он читается БИНАРНЫМ ПОИСКОМ ПРЯМО С ДИСКА: 12 байт на диапазон,
 *      около двадцати чтений по 12 байт на запрос. Держать в памяти 30 с лишним
 *      мегабайт ради поля «город» незачем, а страницы файла всё равно осядут в
 *      кэше системы.
 *   3. Названия приводятся к русским: в базе они английские («Nizhny Novgorod
 *      Oblast»), а панель русская, и «Yekaterinburg» рядом с «Москва» читался бы
 *      как сбой. Незнакомое название остаётся латиницей — это честнее, чем
 *      выдумывать перевод.
 *
 * Файла нет — модуль молча отвечает `null`, и метрика работает как раньше, без
 * города. Это осознанно: база необязательна, а витрина от неё не зависит вовсе.
 */

const fs = require('fs');
const path = require('path');
// Страны по-русски берём из общей таблицы кодов: вторая такая же разошлась бы с
// флагами в панелях (см. `lib/client-icons.js`).
const CI = require('./client-icons');

const FILE = 'geoip.bin';
/* Формат файла. Свой, а не готовый (MMDB): готовый потребовал бы разбора чужой
 * структуры, а нам нужно ровно одно — «диапазон → место».
 *
 *   0..7    магия «IPGEO1» и версия формата
 *   8..11   число диапазонов
 *   12..15  число мест
 *   16..19  смещение таблицы мест
 *   20..23  дата сборки (ГГГГММ) — по ней видно, насколько база устарела
 *   24..    диапазоны: по 12 байт (начало, конец, номер места), по возрастанию
 *   далее   таблица мест: у каждого длина (2 байта) и строка «CC\tрегион\tгород»
 */
const MAGIC = 'IPGEO1\0\0';
const HEADER = 24;
const REC = 12;

let state = null;   // { fd, path, mtime, count, places: {buf, offsets}, stamp }

function fileFor(dir) { return path.join(String(dir || ''), FILE); }

// Открыть базу. Держим её открытой между запросами: заново открывать файл на
// каждый визит незачем, а mtime сверяем — после ночного обновления база
// подхватывается сама, тем же приёмом, что и кэш `readJson` в хранилище.
function open(dir) {
  const full = fileFor(dir);
  let stat;
  try { stat = fs.statSync(full); } catch (e) { close(); return null; }
  if (state && state.path === full && state.mtime === stat.mtimeMs) return state;
  close();
  let fd;
  try {
    fd = fs.openSync(full, 'r');
    const head = Buffer.alloc(HEADER);
    fs.readSync(fd, head, 0, HEADER, 0);
    if (head.toString('latin1', 0, 8) !== MAGIC) throw new Error('чужой формат');
    const count = head.readUInt32BE(8);
    const placeCount = head.readUInt32BE(12);
    const placesAt = head.readUInt32BE(16);
    const stamp = head.readUInt32BE(20);
    if (!count || !placeCount || placesAt < HEADER) throw new Error('пустая база');
    // Таблица мест держится в памяти: она небольшая (единицы мегабайт), а
    // читать её с диска пришлось бы на каждый запрос. Строки разбираются по
    // требованию — готовый массив из сотен тысяч строк стоил бы вчетверо дороже.
    const size = stat.size - placesAt;
    const buf = Buffer.alloc(size);
    fs.readSync(fd, buf, 0, size, placesAt);
    const offsets = new Uint32Array(placeCount);
    let at = 0;
    for (let i = 0; i < placeCount; i++) {
      offsets[i] = at;
      at += 2 + buf.readUInt16BE(at);
    }
    state = { fd, path: full, mtime: stat.mtimeMs, count, stamp, places: { buf, offsets } };
    return state;
  } catch (e) {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch (err) {} }
    state = null;
    return null;
  }
}

function close() {
  if (state && state.fd !== undefined) { try { fs.closeSync(state.fd); } catch (e) {} }
  state = null;
}

// «77.88.55.88» → число. IPv6 не поддерживаем вовсе: в базе он есть, но у наших
// посетителей его нет ни одного (проверено на боевых данных), а поддержка стоила
// бы второго индекса и вдвое большего файла.
function ipToInt(value) {
  const parts = String(value == null ? '' : value).trim().split('.');
  if (parts.length !== 4) return -1;
  let out = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return -1;
    const n = Number(part);
    if (n > 255) return -1;
    out = out * 256 + n;
  }
  return out;
}

// Место по номеру: «CC\tрегион\tгород».
function placeAt(places, index) {
  const at = places.offsets[index];
  if (at === undefined) return null;
  const len = places.buf.readUInt16BE(at);
  const raw = places.buf.toString('utf8', at + 2, at + 2 + len);
  const [code, region, city] = raw.split('\t');
  return { code: code || '', region: region || '', city: city || '' };
}

/* Город и страна по адресу.
 *
 * Бинарный поиск по диапазонам прямо в файле: около двадцати чтений по 12 байт.
 * Найденный диапазон обязан НАКРЫВАТЬ адрес — в базе есть дыры, и без этой
 * проверки посетитель из незаполненного куска получил бы город соседнего
 * диапазона.
 */
function lookup(dir, ip) {
  const db = open(dir);
  if (!db) return null;
  const target = ipToInt(ip);
  if (target < 0) return null;
  const rec = Buffer.alloc(REC);
  let low = 0, high = db.count - 1, found = -1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    fs.readSync(db.fd, rec, 0, REC, HEADER + mid * REC);
    const start = rec.readUInt32BE(0);
    if (start > target) { high = mid - 1; continue; }
    found = mid;
    if (rec.readUInt32BE(4) >= target) break;   // диапазон накрывает адрес
    low = mid + 1;
  }
  if (found < 0) return null;
  fs.readSync(db.fd, rec, 0, REC, HEADER + found * REC);
  if (rec.readUInt32BE(0) > target || rec.readUInt32BE(4) < target) return null;
  const place = placeAt(db.places, rec.readUInt32BE(8));
  if (!place || !place.code) return null;
  return {
    city: cityRu(place.city, place.code),
    region: regionRu(place.region, place.code),
    country: CI.countryName(place.code) || place.code,
    countryCode: place.code,
    // Провайдера в City Lite нет вовсе — это платные данные. Пустая строка
    // честнее выдуманной: панель просто не покажет строку провайдера.
    isp: ''
  };
}

// Есть ли база и насколько она свежая — для предупреждения при старте (та же
// беда, что с базой пунктов выдачи: её отсутствие ничем себя не проявляет).
function info(dir) {
  const db = open(dir);
  if (!db) return null;
  return { ranges: db.count, stamp: db.stamp };
}

/* ---------------------------------------------------------------------------
 * Русские названия.
 *
 * В базе они английские, а панель русская: «Yekaterinburg» рядом с «Москва»
 * читается как сбой. Таблица покрывает Россию и соседей — то есть тех, кто
 * реально заходит в магазин; всё остальное остаётся латиницей, и это честнее
 * выдуманного перевода. Ключ приводится к нижнему регистру без точек и дефисов:
 * в базе встречаются и «St Petersburg», и «St.-Petersburg».
 */
function key(value) {
  return String(value == null ? '' : value)
    /* Диакритика снимается ПЕРВОЙ: в базе встречается «Chistoozërnoye», и без
     * этого такое название не сойдётся ни с чем в таблице. Тот же приём, что у
     * разбора французских названий ремешков Hermès. */
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    // Скобочный хвост в базе — это административный округ внутри города
    // («Moscow (Tsentralnyy administrativnyy okrug)»). Для панели это шум: город
    // называется «Москва», а район посетителя её не интересует.
    .replace(/\s*\([^)]*\)/g, '')
    /* Апострофы выбрасываются ВСЕ, включая типографский. На этом уже наступили:
     * DB-IP пишет «Kazan’» с U+2019, а в таблице стоит «kazan» — и Казань,
     * седьмой город страны, оставалась латиницей. Тем же чинятся «Gus'-Khrustal'nyy»
     * и «Shakhun'ya». */
    .replace(/[.'’ʼ`´]/g, '')
    .replace(/[-–—]/g, ' ').replace(/\s+/g, ' ').trim();
}

const CITY_RU = {
  moscow: 'Москва', 'st petersburg': 'Санкт-Петербург', 'saint petersburg': 'Санкт-Петербург',
  novosibirsk: 'Новосибирск', yekaterinburg: 'Екатеринбург', ekaterinburg: 'Екатеринбург',
  'nizhny novgorod': 'Нижний Новгород', kazan: 'Казань', chelyabinsk: 'Челябинск',
  omsk: 'Омск', samara: 'Самара', 'rostov on don': 'Ростов-на-Дону', 'rostov na donu': 'Ростов-на-Дону',
  ufa: 'Уфа', krasnoyarsk: 'Красноярск', voronezh: 'Воронеж', perm: 'Пермь', volgograd: 'Волгоград',
  krasnodar: 'Краснодар', saratov: 'Саратов', tyumen: 'Тюмень', tolyatti: 'Тольятти', togliatti: 'Тольятти',
  izhevsk: 'Ижевск', barnaul: 'Барнаул', ulyanovsk: 'Ульяновск', irkutsk: 'Иркутск', khabarovsk: 'Хабаровск',
  yaroslavl: 'Ярославль', vladivostok: 'Владивосток', makhachkala: 'Махачкала', tomsk: 'Томск',
  orenburg: 'Оренбург', kemerovo: 'Кемерово', novokuznetsk: 'Новокузнецк', ryazan: 'Рязань',
  astrakhan: 'Астрахань', 'naberezhnye chelny': 'Набережные Челны', penza: 'Пенза', lipetsk: 'Липецк',
  kirov: 'Киров', cheboksary: 'Чебоксары', tula: 'Тула', kaliningrad: 'Калининград', kursk: 'Курск',
  stavropol: 'Ставрополь', 'ulan ude': 'Улан-Удэ', sochi: 'Сочи', tver: 'Тверь', magnitogorsk: 'Магнитогорск',
  ivanovo: 'Иваново', bryansk: 'Брянск', belgorod: 'Белгород', surgut: 'Сургут', vladimir: 'Владимир',
  arkhangelsk: 'Архангельск', chita: 'Чита', kaluga: 'Калуга', smolensk: 'Смоленск', volzhsky: 'Волжский',
  yakutsk: 'Якутск', saransk: 'Саранск', cherepovets: 'Череповец', vologda: 'Вологда', kurgan: 'Курган',
  orel: 'Орёл', oryol: 'Орёл', vladikavkaz: 'Владикавказ', murmansk: 'Мурманск', tambov: 'Тамбов',
  grozny: 'Грозный', petrozavodsk: 'Петрозаводск', kostroma: 'Кострома', nizhnevartovsk: 'Нижневартовск',
  novorossiysk: 'Новороссийск', 'yoshkar ola': 'Йошкар-Ола', taganrog: 'Таганрог', syktyvkar: 'Сыктывкар',
  'komsomolsk on amur': 'Комсомольск-на-Амуре', 'nizhny tagil': 'Нижний Тагил', bratsk: 'Братск',
  dzerzhinsk: 'Дзержинск', shakhty: 'Шахты', nalchik: 'Нальчик', pskov: 'Псков', biysk: 'Бийск',
  armavir: 'Армавир', rybinsk: 'Рыбинск', balakovo: 'Балаково', severodvinsk: 'Северодвинск',
  abakan: 'Абакан', 'velikiy novgorod': 'Великий Новгород', 'veliky novgorod': 'Великий Новгород',
  nakhodka: 'Находка', ussuriysk: 'Уссурийск', 'yuzhno sakhalinsk': 'Южно-Сахалинск',
  blagoveshchensk: 'Благовещенск', 'petropavlovsk kamchatsky': 'Петропавловск-Камчатский',
  magadan: 'Магадан', simferopol: 'Симферополь', sevastopol: 'Севастополь', yalta: 'Ялта',
  khimki: 'Химки', balashikha: 'Балашиха', podolsk: 'Подольск', mytishchi: 'Мытищи', korolev: 'Королёв',
  lyubertsy: 'Люберцы', krasnogorsk: 'Красногорск', odintsovo: 'Одинцово', domodedovo: 'Домодедово',
  shchyolkovo: 'Щёлково', schelkovo: 'Щёлково', serpukhov: 'Серпухов', noginsk: 'Ногинск',
  ramenskoye: 'Раменское', zhukovsky: 'Жуковский', reutov: 'Реутов', 'sergiyev posad': 'Сергиев Посад',
  kolomna: 'Коломна', elektrostal: 'Электросталь', 'orekhovo zuyevo': 'Орехово-Зуево',
  dolgoprudny: 'Долгопрудный', dmitrov: 'Дмитров', vidnoye: 'Видное', lobnya: 'Лобня', dubna: 'Дубна',
  zelenograd: 'Зеленоград', pushkino: 'Пушкино', klin: 'Клин', shatura: 'Шатура',
  gatchina: 'Гатчина', vyborg: 'Выборг', vsevolozhsk: 'Всеволожск', kolpino: 'Колпино', pushkin: 'Пушкин',
  sestroretsk: 'Сестрорецк', kronstadt: 'Кронштадт', 'sosnovyy bor': 'Сосновый Бор',
  engels: 'Энгельс', syzran: 'Сызрань', novocherkassk: 'Новочеркасск', bataysk: 'Батайск',
  volgodonsk: 'Волгодонск', azov: 'Азов', anapa: 'Анапа', gelendzhik: 'Геленджик', maykop: 'Майкоп',
  pyatigorsk: 'Пятигорск', kislovodsk: 'Кисловодск', yessentuki: 'Ессентуки', nevinnomyssk: 'Невинномысск',
  'mineralnye vody': 'Минеральные Воды', derbent: 'Дербент', kaspiysk: 'Каспийск', khasavyurt: 'Хасавюрт',
  nazran: 'Назрань', magas: 'Магас', cherkessk: 'Черкесск', elista: 'Элиста',
  sterlitamak: 'Стерлитамак', salavat: 'Салават', neftekamsk: 'Нефтекамск', oktyabrsky: 'Октябрьский',
  almetyevsk: 'Альметьевск', nizhnekamsk: 'Нижнекамск', bugulma: 'Бугульма', zelenodolsk: 'Зеленодольск',
  novocheboksarsk: 'Новочебоксарск', arzamas: 'Арзамас', sarov: 'Саров', kstovo: 'Кстово',
  berezniki: 'Березники', solikamsk: 'Соликамск', glazov: 'Глазов', sarapul: 'Сарапул', votkinsk: 'Воткинск',
  kamensk: 'Каменск-Уральский', 'kamensk uralsky': 'Каменск-Уральский', pervouralsk: 'Первоуральск',
  serov: 'Серов', asbest: 'Асбест', zlatoust: 'Златоуст', miass: 'Миасс', kopeysk: 'Копейск',
  ozersk: 'Озёрск', tobolsk: 'Тобольск', ishim: 'Ишим', nefteyugansk: 'Нефтеюганск',
  'khanty mansiysk': 'Ханты-Мансийск', salekhard: 'Салехард', 'novy urengoy': 'Новый Уренгой',
  noyabrsk: 'Ноябрьск', nadym: 'Надым', norilsk: 'Норильск', achinsk: 'Ачинск', kansk: 'Канск',
  berdsk: 'Бердск', seversk: 'Северск', angarsk: 'Ангарск', prokopyevsk: 'Прокопьевск',
  rubtsovsk: 'Рубцовск', 'gorno altaysk': 'Горно-Алтайск', kyzyl: 'Кызыл', minusinsk: 'Минусинск',
  birobidzhan: 'Биробиджан', anadyr: 'Анадырь', nakhodkha: 'Находка', artem: 'Артём', artyom: 'Артём',
  tynda: 'Тында', kholmsk: 'Холмск', neryungri: 'Нерюнгри', vorkuta: 'Воркута', ukhta: 'Ухта',
  kotlas: 'Котлас', apatity: 'Апатиты', 'naryan mar': 'Нарьян-Мар', kingisepp: 'Кингисепп',
  'stary oskol': 'Старый Оскол', 'staryy oskol': 'Старый Оскол', gubkin: 'Губкин', yelets: 'Елец',
  michurinsk: 'Мичуринск', novomoskovsk: 'Новомосковск', obninsk: 'Обнинск', kovrov: 'Ковров',
  murom: 'Муром', 'sergiev posad': 'Сергиев Посад', kuznetsk: 'Кузнецк', orsk: 'Орск',
  /* Дописано по реальному трафику магазина: это города, которые правда
   * встречались у посетителей и оставались латиницей. Гнаться за полным списком
   * незачем — посёлков в базе сто шестьдесят тысяч, и мелкие останутся как есть. */
  novokuybyshevsk: 'Новокуйбышевск', kamyshin: 'Камышин', krymsk: 'Крымск',
  'verkhnyaya pyshma': 'Верхняя Пышма', zheleznogorsk: 'Железногорск', zhigulevsk: 'Жигулёвск',
  desnogorsk: 'Десногорск', 'gus khrustalnyy': 'Гусь-Хрустальный', murino: 'Мурино',
  kudrovo: 'Кудрово', shushary: 'Шушары', pargolovo: 'Парголово', krasnoobsk: 'Краснообск',
  krasnoznamensk: 'Краснознаменск', gubkinskiy: 'Губкинский', yemanzhelinsk: 'Еманжелинск',
  shakhunya: 'Шахунья', ezhva: 'Эжва', medvedevo: 'Медведево', 'novopodrezkovo': 'Новоподрезково',
  // Соседи: столицы и крупные города, откуда к нам заходят.
  minsk: 'Минск', gomel: 'Гомель', brest: 'Брест', vitebsk: 'Витебск', grodno: 'Гродно', mogilev: 'Могилёв',
  almaty: 'Алматы', astana: 'Астана', 'nur sultan': 'Астана', shymkent: 'Шымкент', karaganda: 'Караганда',
  aktobe: 'Актобе', atyrau: 'Атырау', taraz: 'Тараз', pavlodar: 'Павлодар', 'ust kamenogorsk': 'Усть-Каменогорск',
  tashkent: 'Ташкент', samarkand: 'Самарканд', bukhara: 'Бухара', namangan: 'Наманган', andijan: 'Андижан',
  bishkek: 'Бишкек', osh: 'Ош', dushanbe: 'Душанбе', khujand: 'Худжанд', ashgabat: 'Ашхабад',
  baku: 'Баку', yerevan: 'Ереван', tbilisi: 'Тбилиси', chisinau: 'Кишинёв', kyiv: 'Киев', kiev: 'Киев',
  riga: 'Рига', vilnius: 'Вильнюс', tallinn: 'Таллин', warsaw: 'Варшава', berlin: 'Берлин',
  istanbul: 'Стамбул', ankara: 'Анкара', antalya: 'Анталья', dubai: 'Дубай', 'tel aviv': 'Тель-Авив',
  // Реальный трафик через зарубежные узлы. Эти названия уже попали в старые
  // диалоги латиницей, поэтому таблица применяется и при показе списка.
  amsterdam: 'Амстердам', 'tsuen wan': 'Чхюньвань', sadovyy: 'Садовый', sadovy: 'Садовый'
};

/* Регионы России.
 *
 * Ищем по ЯДРУ названия, а не по строке целиком, и это не изящество, а
 * необходимость: одна и та же область в базе записана по-разному — «Chelyabinsk
 * Oblast», «Chelyabinsk», «Leningradskaya Oblast'», «Bashkortostan Republic»,
 * «Altay Kray», «Kuzbass». Перечислять все написания — тупик, их десятки.
 *
 * Поэтому у строки отрезается тип («oblast», «republic», «kray», «okrug») и
 * транслитерованное прилагательное окончание, а остаток ищется в таблице. Тип
 * при этом запоминается: «Altai Republic» и «Altay Kray» — разные субъекты с
 * одним ядром, и без типа их не различить.
 */
const REGION_TYPES = /\b(republic|respublika|oblast|oblasti|obl|kray|krai|okrug|autonomous|avtonomnyy|federal|city|region|of|the)\b/g;

const REGION_CORE = {
  // Области — ключ по названию центра или самой области.
  moscow: 'Москва', 'moscow|oblast': 'Московская область', 'moskovskaya': 'Московская область',
  'st petersburg': 'Санкт-Петербург', 'saint petersburg': 'Санкт-Петербург', 'sankt peterburg': 'Санкт-Петербург',
  leningrad: 'Ленинградская область', belgorod: 'Белгородская область', bryansk: 'Брянская область',
  vladimir: 'Владимирская область', voronezh: 'Воронежская область', voronezj: 'Воронежская область',
  ivanovo: 'Ивановская область', ivanovskaya: 'Ивановская область', kaluga: 'Калужская область',
  kostroma: 'Костромская область', kursk: 'Курская область', lipetsk: 'Липецкая область',
  orel: 'Орловская область', oryol: 'Орловская область', ryazan: 'Рязанская область',
  smolensk: 'Смоленская область', tambov: 'Тамбовская область', tver: 'Тверская область',
  tula: 'Тульская область', yaroslavl: 'Ярославская область', arkhangelsk: 'Архангельская область',
  vologda: 'Вологодская область', kaliningrad: 'Калининградская область', murmansk: 'Мурманская область',
  novgorod: 'Новгородская область', pskov: 'Псковская область', astrakhan: 'Астраханская область',
  volgograd: 'Волгоградская область', rostov: 'Ростовская область', kirov: 'Кировская область',
  'nizhny novgorod': 'Нижегородская область', 'nizjnij novgorod': 'Нижегородская область',
  nizhegorodskaya: 'Нижегородская область', orenburg: 'Оренбургская область', penza: 'Пензенская область',
  samara: 'Самарская область', saratov: 'Саратовская область', ulyanovsk: 'Ульяновская область',
  kurgan: 'Курганская область', sverdlovsk: 'Свердловская область', tyumen: 'Тюменская область',
  chelyabinsk: 'Челябинская область', irkutsk: 'Иркутская область', kemerovo: 'Кемеровская область',
  kuzbass: 'Кемеровская область', novosibirsk: 'Новосибирская область', omsk: 'Омская область',
  tomsk: 'Томская область', amur: 'Амурская область', amurskaya: 'Амурская область',
  magadan: 'Магаданская область', sakhalin: 'Сахалинская область',
  // Края.
  'krasnodar|kray': 'Краснодарский край', krasnodar: 'Краснодарский край', krasnodarskiy: 'Краснодарский край',
  'stavropol|kray': 'Ставропольский край', stavropol: 'Ставропольский край',
  'perm|kray': 'Пермский край', perm: 'Пермский край',
  'krasnoyarsk|kray': 'Красноярский край', krasnoyarsk: 'Красноярский край',
  'primorsky|kray': 'Приморский край', primorsky: 'Приморский край', primorye: 'Приморский край',
  'khabarovsk|kray': 'Хабаровский край', khabarovsk: 'Хабаровский край',
  'altay|kray': 'Алтайский край', 'altai|kray': 'Алтайский край',
  'zabaykalskiy|kray': 'Забайкальский край', zabaykalskiy: 'Забайкальский край',
  'zabaykalskiy transbaikal': 'Забайкальский край', transbaikal: 'Забайкальский край',
  'kamchatka|kray': 'Камчатский край', kamchatka: 'Камчатский край',
  // Республики.
  'altai|republic': 'Республика Алтай', 'altay|republic': 'Республика Алтай',
  bashkortostan: 'Башкортостан', tatarstan: 'Татарстан', udmurtiya: 'Удмуртия', udmurt: 'Удмуртия',
  chuvashiya: 'Чувашия', chuvash: 'Чувашия', 'mariy el': 'Марий Эл', 'mari el': 'Марий Эл',
  mordoviya: 'Мордовия', mordovia: 'Мордовия', komi: 'Коми', kareliya: 'Карелия', karelia: 'Карелия',
  kalmykiya: 'Калмыкия', kalmykia: 'Калмыкия', adygeya: 'Адыгея', adygea: 'Адыгея',
  dagestan: 'Дагестан', ingushetiya: 'Ингушетия', ingushetia: 'Ингушетия',
  'kabardino balkariya': 'Кабардино-Балкария', 'kabardino balkarian': 'Кабардино-Балкария',
  'kabardino balkaria': 'Кабардино-Балкария', 'karachayevo cherkesiya': 'Карачаево-Черкесия',
  'karachay cherkess': 'Карачаево-Черкесия', 'karachay cherkessia': 'Карачаево-Черкесия',
  'north ossetia': 'Северная Осетия', 'severnaya osetiya': 'Северная Осетия', alaniya: 'Северная Осетия',
  chechen: 'Чечня', chechnya: 'Чечня', chechenskaya: 'Чечня',
  buryatiya: 'Бурятия', buryatia: 'Бурятия', khakasiya: 'Хакасия', khakassia: 'Хакасия',
  tyva: 'Тыва', tuva: 'Тыва', sakha: 'Якутия', yakutia: 'Якутия', yakutiya: 'Якутия',
  crimea: 'Крым', krym: 'Крым', sevastopol: 'Севастополь',
  // Автономные округа и область.
  'khanty mansi': 'Ханты-Мансийский АО', 'khanty mansiy': 'Ханты-Мансийский АО',
  'khanty mansia': 'Ханты-Мансийский АО', yugra: 'Ханты-Мансийский АО',
  'yamalo nenets': 'Ямало-Ненецкий АО', 'yamal nenets': 'Ямало-Ненецкий АО',
  nenets: 'Ненецкий АО', chukotka: 'Чукотский АО', chukot: 'Чукотский АО',
  jewish: 'Еврейская АО', yevreyskaya: 'Еврейская АО'
};

// Незнакомый город остаётся латиницей: выдумать перевод нельзя, а «Yekaterinburg»
// в панели всё-таки лучше, чем «Город не определён».
function cityRu(name) {
  const raw = String(name || '').trim();
  return raw ? (CITY_RU[key(raw)] || raw) : '';
}

function regionRu(name, code) {
  const raw = String(name || '').trim();
  if (!raw || code !== 'RU') return raw;
  const norm = key(raw);
  // Тип запоминаем ДО того, как отрежем его: «Altai Republic» и «Altay Kray» —
  // разные субъекты с одним ядром.
  const type = /\b(republic|respublika)\b/.test(norm) ? 'republic'
    : /\b(kray|krai)\b/.test(norm) ? 'kray'
    : /\b(okrug|autonomous)\b/.test(norm) ? 'okrug' : 'oblast';
  const core = norm.replace(REGION_TYPES, ' ').replace(/\s+/g, ' ').trim();
  /* Транслитерованное прилагательное («leningradskaya», «smolenskaya») сводим к
   * основе: в таблице ядра записаны в именительном («leningrad», «smolensk»). */
  const stem = core.replace(/sk(aya|iy|oye|oy|ii|ay)$/, 'sk').replace(/skaya$/, 'sk');
  for (const candidate of [norm, core + '|' + type, core, stem + '|' + type, stem, stem.replace(/sk$/, '')]) {
    if (candidate && REGION_CORE[candidate]) return REGION_CORE[candidate];
  }
  return raw;
}

module.exports = { FILE, MAGIC, HEADER, REC, lookup, info, ipToInt, close, cityRu, regionRu };
