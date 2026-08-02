'use strict';

// Синтетические отзывы для демонстрационной витрины. Они всегда помечены словом
// «(демо)» в имени автора и техническим полем source, чтобы их нельзя было
// спутать с отзывами покупателей и можно было удалить одной командой.

const DAY = 86400000;
const DEMO_SOURCE = 'demo-generated-v1';

// Количество зависит от массовости линейки и не превышает диапазон 50..300.
const REVIEW_COUNTS = {
  'iphone-17-pro-max': 300,
  'iphone-17-pro': 275,
  'iphone-air': 210,
  'iphone-17': 300,
  'iphone-17e': 190,
  'iphone-16': 300,
  'macbook-neo': 130,
  'macbook-air-13-m5': 260,
  'macbook-air-15-m5': 190,
  'macbook-pro-14-m5': 220,
  'macbook-pro-16-m5-pro': 155,
  'imac-m5': 140,
  'mac-mini-m5': 180,
  'mac-studio-m5-max': 85,
  'studio-display': 100,
  'studio-display-xdr': 55,
  'ipad-pro-13-m5': 210,
  'ipad-pro-11-m5': 190,
  'ipad-air-13-m4': 150,
  'ipad-air-11-m4': 230,
  'ipad-a16': 260,
  'ipad-mini-a17-pro': 200,
  'watch-series-11-alu': 280,
  'watch-series-11-titan': 120,
  'watch-ultra-3': 210,
  'watch-se-3': 170,
  'watch-hermes-series-11': 50,
  'airpods-pro-3': 300,
  'airpods-4-anc': 270,
  'airpods-4': 250,
  'airpods-max-2': 140,
  'apple-tv-4k': 130,
  'homepod-2': 110,
  'homepod-mini': 180,
  'vision-pro-m5': 50,
  airtag: 300,
  'airtag-4pack': 220
};

// Дата фактического начала продаж модели. Для позиций каталога, которых нет в
// публичной истории релизов Apple, используется дата появления этой позиции в
// демонстрационной линейке, чтобы отзывы не датировались раньше самого товара.
const RELEASE_DATES = {
  'iphone-17-pro-max': '2025-09-19',
  'iphone-17-pro': '2025-09-19',
  'iphone-air': '2025-09-19',
  'iphone-17': '2025-09-19',
  'iphone-17e': '2026-03-11',
  'iphone-16': '2024-09-20',
  'macbook-neo': '2026-03-11',
  'macbook-air-13-m5': '2026-03-11',
  'macbook-air-15-m5': '2026-03-11',
  'macbook-pro-14-m5': '2025-10-22',
  'macbook-pro-16-m5-pro': '2026-03-11',
  'imac-m5': '2026-07-01',
  'mac-mini-m5': '2026-07-01',
  'mac-studio-m5-max': '2026-07-01',
  'studio-display': '2026-03-11',
  'studio-display-xdr': '2026-03-11',
  'ipad-pro-13-m5': '2025-10-22',
  'ipad-pro-11-m5': '2025-10-22',
  'ipad-air-13-m4': '2026-03-11',
  'ipad-air-11-m4': '2026-03-11',
  'ipad-a16': '2025-03-12',
  'ipad-mini-a17-pro': '2024-10-23',
  'watch-series-11-alu': '2025-09-19',
  'watch-series-11-titan': '2025-09-19',
  'watch-ultra-3': '2025-09-19',
  'watch-se-3': '2025-09-19',
  'watch-hermes-series-11': '2025-09-19',
  'airpods-pro-3': '2025-09-19',
  'airpods-4-anc': '2024-09-20',
  'airpods-4': '2024-09-20',
  'airpods-max-2': '2026-07-01',
  'apple-tv-4k': '2026-07-01',
  'homepod-2': '2023-02-03',
  'homepod-mini': '2020-11-16',
  'vision-pro-m5': '2025-10-22',
  airtag: '2021-04-30',
  'airtag-4pack': '2021-04-30'
};

const MALE_NAMES = [
  'Александр', 'Алексей', 'Анатолий', 'Андрей', 'Антон', 'Артём', 'Борис',
  'Вадим', 'Валерий', 'Виктор', 'Владимир', 'Георгий', 'Даниил', 'Денис',
  'Дмитрий', 'Евгений', 'Егор', 'Иван', 'Игорь', 'Илья', 'Кирилл', 'Константин',
  'Лев', 'Максим', 'Михаил', 'Никита', 'Николай', 'Олег', 'Павел', 'Пётр',
  'Роман', 'Руслан', 'Семён', 'Сергей', 'Станислав', 'Степан', 'Тимофей',
  'Тимур', 'Фёдор', 'Юрий'
];

const FEMALE_NAMES = [
  'Алина', 'Алла', 'Анастасия', 'Анна', 'Валентина', 'Валерия', 'Вера',
  'Виктория', 'Галина', 'Дарья', 'Евгения', 'Екатерина', 'Елена', 'Жанна',
  'Ирина', 'Кристина', 'Ксения', 'Лариса', 'Лидия', 'Любовь', 'Людмила',
  'Маргарита', 'Марина', 'Мария', 'Надежда', 'Наталья', 'Нина', 'Оксана',
  'Ольга', 'Полина', 'Светлана', 'Софья', 'Таисия', 'Тамара', 'Татьяна',
  'Ульяна', 'Юлия', 'Яна'
];

const INITIALS = 'АБВГДЕКЛМНОПРСТФШ'.split('');
const CITIES = [
  'Москве', 'Питере', 'Казани', 'Твери', 'Самаре', 'Туле', 'Уфе',
  'Краснодаре', 'Екатеринбурге', 'Омске', 'Перми', 'Рязани', 'Воронеже'
];

const SERVICE_POSITIVE = [
  'Заказ подтвердили минут через десять, общались спокойно и по делу',
  'Менеджер быстро ответил и помог выбрать нужную память',
  'Перед отправкой прислали фото коробки и серийного номера',
  'На все вопросы ответили нормально, ничего лишнего не навязывали',
  'Попросил проверить упаковку, сделали без проблем и сразу отписались',
  'Попросила проверить упаковку, сделали без проблем и сразу отписались',
  'Сотрудник подсказал по цвету и наличию, оформление заняло минут пять',
  'После заказа сами позвонили, уточнили адрес и удобное время',
  'В чате отвечали быстро, даже вечером помогли разобраться с комплектацией',
  'Менеджер был на связи до получения, за это отдельное спасибо',
  'Оформили без лишних звонков, все условия сразу написали в сообщении',
  'На выдаче дали спокойно осмотреть коробку и проверить комплект',
  'Сервис понравился, вежливо и без попыток продать ненужные аксессуары',
  'Подобрали вариант в мой бюджет и честно сказали где можно не переплачивать'
];

const DELIVERY_POSITIVE = [
  'Курьер приехал в тот же вечер',
  'Доставили на следующий день как и обещали',
  'До пункта выдачи доехало за два дня',
  'Привезли утром в согласованный интервал',
  'Доставка по городу заняла всего несколько часов',
  'За город привезли на следующий день, коробка целая',
  'Получил заказ точно к выходным',
  'Получила заказ точно к выходным',
  'В другой город отправили в день оплаты',
  'Курьер заранее позвонил и приехал вовремя',
  'Упаковано плотно, коробка приехала без вмятин',
  'Забрал сам в день заказа, ждать не пришлось'
];

const MILD_PROBLEMS = [
  'Доставка задержалась на день, но меня заранее предупредили',
  'Курьер опоздал примерно на час, в остальном все хорошо',
  'Менеджер ответил не сразу, пришлось подождать около сорока минут',
  'Нужный цвет появился только через три дня, зато его отложили за мной',
  'Обещали привезти до обеда, в итоге приехали ближе к вечеру',
  'В пункт выдачи заказ приехал на день позже обещанного',
  'Коробка снаружи была чуть примята, внутри все целое',
  'Сначала перепутали время доставки, после звонка быстро исправили',
  'На сайте статус обновлялся с задержкой, пришлось уточнять в чате',
  'Дозвонился только со второго раза, дальше оформили быстро',
  'Дозвонилась только со второго раза, дальше оформили быстро'
];

const STRONGER_PROBLEMS = [
  'Доставку переносили два раза, получил заказ на третий день позже срока',
  'Менеджер долго не отвечал после оплаты, из-за этого понервничал',
  'Менеджер долго не отвечал после оплаты, из-за этого понервничала',
  'Курьер не попал в выбранный интервал и пришлось менять планы',
  'Цвет на складе оказался другой, замену согласовывали почти весь день',
  'Отправили не в тот пункт выдачи, вопрос решили, но время потерял',
  'Отправили не в тот пункт выдачи, вопрос решили, но время потеряла'
];

const PRODUCT_THOUGHTS = {
  phone: [
    'Экран яркий, на солнце все видно, камера тоже порадовала',
    'Перенос данных со старого телефона прошел без проблем',
    'Батареи мне спокойно хватает с утра до вечера',
    'Камера снимает заметно лучше моего прошлого телефона',
    'В руке лежит удобно, цвет вживую приятнее чем на фото',
    'Работает шустро, приложения и камера открываются моментально',
    'Пользуюсь каждый день, пока только хорошие впечатления'
  ],
  laptop: [
    'Для работы и созвонов подошел отлично, работает тихо',
    'Батареи хватает на мой рабочий день без розетки',
    'Экран приятный, текст четкий, глаза к вечеру устают меньше',
    'Легкий, каждый день ношу с собой и спина сказала спасибо',
    'После старого ноутбука скорость совсем другая',
    'Клавиатура удобная, к системе привык довольно быстро',
    'Для учебы, браузера и обработки фото мощности с запасом'
  ],
  desktop: [
    'Поставил на рабочий стол, места почти не занимает',
    'Поставила на рабочий стол, места почти не занимает',
    'Работает тихо и быстро, именно это было нужно для дома',
    'Настройка заняла минут двадцать, дальше все само подтянулось',
    'Для моих рабочих программ производительности хватает с запасом',
    'Старый компьютер рядом с ним кажется очень медленным',
    'На столе теперь аккуратно, проводов стало заметно меньше'
  ],
  display: [
    'Картинка очень четкая, цвета после старого монитора впечатляют',
    'Подключил одним кабелем, все определилось сразу',
    'Подключила одним кабелем, все определилось сразу',
    'Для фото и монтажа экран подошел отлично',
    'Текст выглядит четко, за монитором провожу весь рабочий день',
    'Камера и динамики оказались лучше чем ожидал',
    'Камера и динамики оказались лучше чем ожидала'
  ],
  tablet: [
    'Для фильмов, заметок и чтения самое то',
    'Рисовать удобно, отклик быстрый и экран отличный',
    'В поездках почти заменил мне ноутбук',
    'Ребенок быстро разобрался, для учебы подходит хорошо',
    'Легкий, в сумке почти не чувствуется',
    'Экран очень приятный, особенно для фото и видео',
    'Все настроилось быстро через мой старый аккаунт'
  ],
  watch: [
    'На руке сидят удобно, уведомления приходят без задержек',
    'Заряда хватает на мой обычный день и тренировку',
    'Стал чаще ходить пешком, кольца реально мотивируют',
    'Стала чаще ходить пешком, кольца реально мотивируют',
    'Сон и тренировки отслеживают нормально, меню понятное',
    'Ремешок удобный, часы не мешают даже ночью',
    'С телефоном соединились с первого раза'
  ],
  headphones: [
    'Звук чистый, в дороге слушать приятно',
    'С телефоном соединились сразу, связь не отваливается',
    'В ушах сидят удобно, даже после пары часов нормально',
    'Микрофоны для звонков хорошие, меня слышно четко',
    'Шумоподавление в метро очень выручает',
    'Кейс компактный, заряд держится как ожидал',
    'Кейс компактный, заряд держится как ожидала'
  ],
  tv: [
    'Подключил к телевизору за несколько минут, интерфейс быстрый',
    'Подключила к телевизору за несколько минут, интерфейс быстрый',
    'Картинка хорошая, приложения открываются без тормозов',
    'Пульт удобный, домашние разобрались сразу',
    'Для фильмов и музыки отличный вариант',
    'Телевизор с этой приставкой буквально ожил'
  ],
  speaker: [
    'Для комнаты громкости хватает, звук приятный',
    'Поставил на кухне, теперь постоянно слушаю музыку и подкасты',
    'Поставила на кухне, теперь постоянно слушаю музыку и подкасты',
    'Настроилась быстро, голосовые команды понимает нормально',
    'В интерьер вписалась хорошо, провод почти не видно',
    'Для своего размера играет очень достойно'
  ],
  vision: [
    'Картинка впечатляет, особенно фильмы и панорамные видео',
    'Настройка заняла немного времени, управление взглядом удобное',
    'Для работы с большими окнами интересная вещь',
    'Посадку пришлось подстроить, после этого стало удобно',
    'Домашние попробовали по очереди, впечатлений было на весь вечер'
  ],
  tracker: [
    'Добавил в Локатор за минуту, сигнал находит точно',
    'Добавила в Локатор за минуту, сигнал находит точно',
    'Повесил на ключи и уже пару раз реально пригодилось',
    'Положила в чемодан перед поездкой, так намного спокойнее',
    'Связался с телефоном сразу, батарейка уже была внутри',
    'Для ключей и рюкзака очень полезная штука'
  ]
};

const CLOSINGS = [
  'Покупкой доволен', 'Покупкой довольна', 'Магазин могу рекомендовать',
  'В целом все понравилось', 'Спасибо магазину', 'Буду обращаться еще',
  'За такую цену хороший вариант', 'Все пришло новое и запечатанное',
  'Проверил, все работает как надо', 'Проверила, все работает как надо'
];

function hashString(value) {
  let h = 2166136261;
  for (const ch of String(value)) {
    h ^= ch.codePointAt(0);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function randomFor(seed) {
  let n = hashString(seed) || 1;
  return function random() {
    n += 0x6d2b79f5;
    let x = n;
    x = Math.imul(x ^ (x >>> 15), x | 1);
    x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

function pick(list, random) {
  return list[Math.floor(random() * list.length)];
}

function gendered(gender, male, female) {
  return gender === 'female' ? female : male;
}

function productKind(product) {
  const id = product.id;
  if (id.startsWith('iphone')) return 'phone';
  if (id.startsWith('macbook')) return 'laptop';
  if (id.startsWith('studio-display')) return 'display';
  if (id.startsWith('imac') || id.startsWith('mac-')) return 'desktop';
  if (id.startsWith('ipad')) return 'tablet';
  if (id.startsWith('watch')) return 'watch';
  if (id.startsWith('airpods')) return 'headphones';
  if (id.startsWith('apple-tv')) return 'tv';
  if (id.startsWith('homepod')) return 'speaker';
  if (id.startsWith('vision')) return 'vision';
  return 'tracker';
}

function productNoun(kind, productId) {
  if (kind === 'phone') return 'телефон';
  if (kind === 'laptop') return 'ноутбук';
  if (kind === 'desktop') return 'компьютер';
  if (kind === 'display') return 'монитор';
  if (kind === 'tablet') return 'планшет';
  if (kind === 'watch') return 'часы';
  if (kind === 'headphones') return 'наушники';
  if (kind === 'tv') return 'приставку';
  if (kind === 'speaker') return 'колонку';
  if (kind === 'vision') return 'гарнитуру';
  return productId === 'airtag-4pack' ? 'набор' : 'метку';
}

function personaFor(random) {
  const gender = random() < 0.49 ? 'female' : 'male';
  const names = gender === 'female' ? FEMALE_NAMES : MALE_NAMES;
  const ageRoll = random();
  let age;
  if (ageRoll < 0.23) age = 18 + Math.floor(random() * 8);
  else if (ageRoll < 0.64) age = 26 + Math.floor(random() * 19);
  else if (ageRoll < 0.88) age = 45 + Math.floor(random() * 16);
  else age = 61 + Math.floor(random() * 16);
  const initial = random() < 0.72 ? ` ${pick(INITIALS, random)}.` : '';
  return { gender, age, author: `${pick(names, random)}${initial} (демо)` };
}

function giftFor(age, random) {
  let options;
  if (age <= 25) options = [
    ['маме', 'была очень рада'], ['папе', 'был очень рад'],
    ['сестре', 'была очень рада'], ['брату', 'был очень рад'],
    ['девушке', 'была очень рада'], ['парню', 'был очень рад']
  ];
  else if (age <= 44) options = [
    ['мужу', 'был очень рад'], ['жене', 'была очень рада'],
    ['маме', 'была очень рада'], ['папе', 'был очень рад'],
    ['сыну', 'был очень рад'], ['дочери', 'была очень рада']
  ];
  else if (age <= 60) options = [
    ['мужу', 'был очень рад'], ['жене', 'была очень рада'],
    ['сыну', 'был очень рад'], ['дочери', 'была очень рада'],
    ['брату', 'был очень рад'], ['сестре', 'была очень рада']
  ];
  else options = [
    ['внуку', 'был очень рад'], ['внучке', 'была очень рада'],
    ['сыну', 'был очень рад'], ['дочери', 'была очень рада']
  ];
  const [recipient, reaction] = pick(options, random);
  return { recipient, reaction };
}

function lifeContext(persona, kind, random) {
  if (persona.age <= 25) return pick([
    'Брал для учебы и подработки', 'Брала для учебы и подработки',
    'Накопил с подработки, поэтому выбирал долго',
    'Накопила с подработки, поэтому выбирала долго',
    'Нужен был вариант для универа и поездок'
  ], random);
  if (persona.age <= 44) return pick([
    'Нужен был для работы и обычных домашних дел',
    'Заказывал себе на замену старому устройству',
    'Заказывала себе на замену старому устройству',
    'Выбирал для рабочих задач и поездок',
    'Выбирала для рабочих задач и поездок'
  ], random);
  if (persona.age <= 60) return pick([
    'Обновил технику после нескольких лет со старой моделью',
    'Обновила технику после нескольких лет со старой моделью',
    'Нужен был надежный вариант для дома и работы',
    'Долго сравнивал модели и остановился на этой',
    'Долго сравнивала модели и остановилась на этой'
  ], random);
  return pick([
    'Попросил менеджера объяснить разницу между моделями, помогли спокойно',
    'Попросила менеджера объяснить разницу между моделями, помогли спокойно',
    'Брал для дома, хотелось чтобы было просто разобраться',
    'Брала для дома, хотелось чтобы было просто разобраться',
    'Обновил старое устройство, настройку помогли проверить',
    'Обновила старое устройство, настройку помогли проверить'
  ], random);
}

function introFor(product, noun, persona, random) {
  const bought = gendered(persona.gender, 'брал', 'брала');
  const ordered = gendered(persona.gender, 'заказывал', 'заказывала');
  const chose = gendered(persona.gender, 'выбрал', 'выбрала');
  return pick([
    `${gendered(persona.gender, 'Брал', 'Брала')} ${product.name} себе`,
    `${gendered(persona.gender, 'Заказал', 'Заказала')} ${product.name} через сайт`,
    `${product.name} у меня уже несколько недель`,
    `${gendered(persona.gender, 'Выбрал', 'Выбрала')} именно эту модель после долгого сравнения`,
    `Это мой первый заказ в этом магазине, ${bought} ${noun}`,
    `${ordered} ${noun} с доставкой в ${pick(CITIES, random)}`,
    `${gendered(persona.gender, 'Покупал', 'Покупала')} для себя, ${chose} вариант из наличия`
  ], random);
}

function giftIntro(product, persona, random) {
  const gift = giftFor(persona.age, random);
  const bought = gendered(persona.gender, 'Покупал', 'Покупала');
  const ordered = gendered(persona.gender, 'Заказал', 'Заказала');
  return pick([
    `${bought} ${product.name} в подарок ${gift.recipient}, ${gift.reaction}`,
    `${ordered} ${product.name} ${gift.recipient} ко дню рождения, с подарком угадал`,
    `${ordered} ${product.name} ${gift.recipient} ко дню рождения, с подарком угадала`,
    `Брали ${product.name} в подарок ${gift.recipient}, понравилось всей семье`,
    `Главное было успеть с подарком ${gift.recipient}, магазин не подвел`,
    `Главное было успеть с подарком ${gift.recipient}, магазин не подвел`
  ], random);
}

function alignPhrase(phrase, persona) {
  const female = persona.gender === 'female';
  const pairs = [
    ['Заказал', 'Заказала'], ['Покупал', 'Покупала'], ['Выбрал', 'Выбрала'],
    ['Попросил', 'Попросила'], ['Получил', 'Получила'],
    ['получил', 'получила'],
    ['Забрал', 'Забрала'], ['доволен', 'довольна'],
    ['Проверил', 'Проверила'], ['ожидал', 'ожидала'],
    ['Подключил', 'Подключила'], ['Поставил', 'Поставила'],
    ['Добавил', 'Добавила'], ['Повесил', 'Повесила'],
    ['потерял', 'потеряла'], ['понервничал', 'понервничала'],
    ['Накопил', 'Накопила'], ['выбирал', 'выбирала'],
    ['Заказывал', 'Заказывала'], ['Обновил', 'Обновила'],
    ['сравнивал', 'сравнивала'], ['остановился', 'остановилась'],
    ['Брал', 'Брала'], ['угадал', 'угадала'], ['сам', 'сама']
  ];
  let out = phrase;
  for (const [male, woman] of pairs) {
    const wanted = female ? woman : male;
    const unwanted = female ? male : woman;
    const escaped = unwanted.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pattern = new RegExp(`(^|[^А-Яа-яЁё])${escaped}(?=$|[^А-Яа-яЁё])`, 'gu');
    out = out.replace(pattern, (_, prefix) => prefix + wanted);
  }
  return out;
}

function addHumanNoise(text, random) {
  let out = text.replace(/[—–]/g, ',').replace(/\s+/g, ' ').trim();
  if (random() < 0.16) out = out.charAt(0).toLowerCase() + out.slice(1);
  if (random() < 0.13) {
    const typos = [
      ['доставка', 'доствка'], ['быстро', 'бысто'], ['вообще', 'вобще'],
      ['покупкой', 'покупкои'], ['пришел', 'пришол'], ['хорошо', 'хорошо'],
      ['понравилось', 'понравилос'], ['несколько', 'несклько'],
      ['менеджер', 'менеджерр'], ['устройство', 'устроиство']
    ];
    const [from, to] = pick(typos, random);
    out = out.replace(from, to);
  }
  if (random() < 0.38) out = out.replace(/[.!]$/, '');
  return out;
}

function textFor(product, rating, persona, random) {
  const kind = productKind(product);
  const noun = productNoun(kind, product.id);
  const isGift = random() < 0.27;
  const parts = [isGift ? giftIntro(product, persona, random) : introFor(product, noun, persona, random)];

  if (!isGift && random() < 0.22) parts.push(lifeContext(persona, kind, random));

  if (rating === 3) {
    parts.push(pick(STRONGER_PROBLEMS, random));
    parts.push(pick(PRODUCT_THOUGHTS[kind], random));
  } else if (rating === 4 && random() < 0.78) {
    parts.push(pick(MILD_PROBLEMS, random));
    parts.push(pick(PRODUCT_THOUGHTS[kind], random));
  } else {
    if (random() < 0.82) parts.push(pick(SERVICE_POSITIVE, random));
    if (random() < 0.78) parts.push(pick(DELIVERY_POSITIVE, random));
    parts.push(pick(PRODUCT_THOUGHTS[kind], random));
  }

  if (random() < 0.48) parts.push(pick(CLOSINGS, random));
  const aligned = parts.map(part => alignPhrase(part, persona));
  return addHumanNoise(aligned.join('. ') + '.', random);
}

function ratingFor(index, random) {
  // Средний рейтинг получается около 4.7: есть заметное число четверок и
  // небольшая доля троек с жалобами на сервис или доставку.
  const roll = (index * 17 + Math.floor(random() * 100)) % 100;
  if (roll < 78) return 5;
  if (roll < 96) return 4;
  return 3;
}

function aspectsFor(rating, random) {
  if (rating === 3) return {
    delivery: random() < 0.67 ? 2 : 3,
    service: random() < 0.5 ? 2 : 3,
    price: random() < 0.55 ? 4 : 3
  };
  if (rating === 4) return {
    delivery: random() < 0.55 ? 3 : 4,
    service: random() < 0.35 ? 3 : 4,
    price: random() < 0.7 ? 4 : 5
  };
  return {
    delivery: random() < 0.8 ? 5 : 4,
    service: random() < 0.84 ? 5 : 4,
    price: random() < 0.63 ? 5 : 4
  };
}

function reviewDate(productId, index, count, endAt, random) {
  const release = Date.parse(`${RELEASE_DATES[productId]}T09:00:00+03:00`);
  if (!Number.isFinite(release)) throw new Error(`Не указана дата релиза для ${productId}`);
  const safeEnd = Math.max(release + DAY, Number(endAt));
  if (index === 0) return release + Math.floor(random() * 20 + 2) * 3600000;
  if (index === count - 1) return safeEnd - Math.floor(random() * 30 + 1) * 3600000;
  // Отзывы покрывают весь период, но ближе к сегодняшней дате идут плотнее.
  const q = index / (count - 1);
  const weighted = Math.pow(q, 0.72);
  const jitter = (random() - 0.5) * Math.min(DAY * 2, (safeEnd - release) / count);
  return Math.round(release + (safeEnd - release) * weighted + jitter);
}

function generateDemoReviews(products, options) {
  const endAt = options && Number.isFinite(Number(options.now)) ? Number(options.now) : Date.now();
  const reviews = [];
  for (const product of products) {
    const count = REVIEW_COUNTS[product.id];
    if (!Number.isInteger(count)) throw new Error(`Не задано число демо-отзывов для ${product.id}`);
    if (!RELEASE_DATES[product.id]) throw new Error(`Не задана дата релиза для ${product.id}`);
    for (let i = 0; i < count; i++) {
      const random = randomFor(`${product.id}:${i}:reviews-v1`);
      const persona = personaFor(random);
      const rating = ratingFor(i, random);
      reviews.push({
        id: `demo-${product.id}-${String(i + 1).padStart(3, '0')}`,
        productId: product.id,
        author: persona.author,
        rating,
        text: textFor(product, rating, persona, random),
        aspects: aspectsFor(rating, random),
        photos: [],
        status: 'approved',
        createdAt: reviewDate(product.id, i, count, endAt, random),
        source: DEMO_SOURCE,
        demo: true,
        demoPersona: { gender: persona.gender, age: persona.age }
      });
    }
  }
  return reviews;
}

function isDemoReview(review) {
  return !!review && (review.demo === true || review.source === DEMO_SOURCE || /^demo-/.test(String(review.id || '')));
}

module.exports = {
  DAY,
  DEMO_SOURCE,
  REVIEW_COUNTS,
  RELEASE_DATES,
  generateDemoReviews,
  isDemoReview
};
