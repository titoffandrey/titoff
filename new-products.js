'use strict';
// Актуальные новинки Apple, отсутствовавшие в исходном каталоге (2025–2026).
// Цены — ориентировочные (₽, уровень РФ), поправьте в админке.
// Подключается в seed-data.js и в add-novinki.js (безопасное добавление на живой сервер).

const MAC_M4 = [
  { name: 'Небесно-голубой', hex: '#a9c1d9' },
  { name: 'Серебристый', hex: '#e3e4e6' },
  { name: 'Сияющая звезда', hex: '#e8e0d0' },
  { name: 'Полуночный', hex: '#2e3641' }
];
const IPADAIR = [
  { name: 'Серый космос', hex: '#7d7e80' },
  { name: 'Синий', hex: '#7f95b8' },
  { name: 'Фиолетовый', hex: '#b7add0' },
  { name: 'Сияющая звезда', hex: '#e8e0d0' }
];
const WATCH_AL = [
  { name: 'Тёмная ночь', hex: '#25292d' },
  { name: 'Розовое золото', hex: '#e6c9c1' },
  { name: 'Серебристый', hex: '#e3e4e6' },
  { name: 'Космос', hex: '#4b4e52' }
];
const TITAN2 = [
  { name: 'Натуральный титан', hex: '#c9c4bd' },
  { name: 'Чёрный титан', hex: '#3b3b3d' }
];
const SSD = [{ label: '256 ГБ SSD', add: 0 }, { label: '512 ГБ SSD', add: 15000 }, { label: '1 ТБ SSD', add: 35000 }];
const IPADMEM = [{ label: '128 ГБ', add: 0 }, { label: '256 ГБ', add: 12000 }, { label: '512 ГБ', add: 30000 }];

module.exports = [
  {
    id: 'macbook-air-13-m4', name: 'MacBook Air 13" M4', category: 'Mac',
    price: 119990, oldPrice: null, badge: 'Новинка', inStock: true,
    shortDesc: 'Чип M4, до 18 часов работы, 16 ГБ ОЗУ.',
    description: 'Обновлённый ультратонкий ноутбук на чипе Apple M4. 16 ГБ памяти уже в базовой версии, дисплей Liquid Retina, поддержка двух внешних мониторов и новый цвет «Небесно-голубой».',
    specs: 'Экран: 13.6" Liquid Retina\nЧип: Apple M4 (10 CPU / 10 GPU)\nОЗУ: 16 ГБ\nАвтономность: до 18 ч\nВес: 1.24 кг',
    colors: MAC_M4, storages: SSD, images: []
  },
  {
    id: 'macbook-air-15-m4', name: 'MacBook Air 15" M4', category: 'Mac',
    price: 144990, oldPrice: null, badge: 'Новинка', inStock: true,
    shortDesc: 'Большой экран 15.3", чип M4, 16 ГБ.',
    description: '15-дюймовый MacBook Air на чипе M4 с 16 ГБ памяти и автономностью до 18 часов. Тонкий корпус и полностью бесшумная работа без вентилятора.',
    specs: 'Экран: 15.3" Liquid Retina\nЧип: Apple M4 (10 CPU / 10 GPU)\nОЗУ: 16 ГБ\nАвтономность: до 18 ч\nВес: 1.51 кг',
    colors: MAC_M4, storages: SSD, images: []
  },
  {
    id: 'ipad-air-11-m3', name: 'iPad Air 11" M3', category: 'iPad',
    price: 74990, oldPrice: null, badge: 'Новинка', inStock: true,
    shortDesc: 'Чип M3, поддержка Apple Pencil Pro.',
    description: 'Лёгкий и мощный планшет на новом чипе M3. Поддержка Apple Pencil Pro и Magic Keyboard, дисплей Liquid Retina 11".',
    specs: 'Экран: 11" Liquid Retina\nЧип: Apple M3\nПоддержка: Apple Pencil Pro',
    colors: IPADAIR, storages: IPADMEM, images: []
  },
  {
    id: 'ipad-air-13-m3', name: 'iPad Air 13" M3', category: 'iPad',
    price: 99990, oldPrice: null, badge: 'Новинка', inStock: true,
    shortDesc: 'Большой экран 13", чип M3.',
    description: '13-дюймовый iPad Air на чипе M3 — больше рабочего пространства для творчества и задач. Совместим с Apple Pencil Pro и Magic Keyboard.',
    specs: 'Экран: 13" Liquid Retina\nЧип: Apple M3\nПоддержка: Apple Pencil Pro',
    colors: IPADAIR, storages: IPADMEM, images: []
  },
  {
    id: 'watch-series-11', name: 'Apple Watch Series 11 46 мм', category: 'Apple Watch',
    price: 49990, oldPrice: null, badge: 'Новинка', inStock: true,
    shortDesc: 'Тоньше, до 24 часов, 5G.',
    description: 'Новое поколение Apple Watch: ещё тоньше и легче, автономность до 24 часов, поддержка 5G в версии Cellular и обновлённые функции здоровья.',
    specs: 'Корпус: 46 мм алюминий\nЧип: S11 SiP\nАвтономность: до 24 ч\nСвязь: 5G (Cellular)\nДатчики: пульс, ЭКГ, кислород\nЗащита: WR50',
    colors: WATCH_AL, storages: [], images: []
  },
  {
    id: 'watch-ultra-3', name: 'Apple Watch Ultra 3', category: 'Apple Watch',
    price: 89990, oldPrice: null, badge: 'Новинка', inStock: true,
    shortDesc: 'Титан, увеличенный дисплей, 5G и спутник.',
    description: 'Самые выносливые часы Apple: титановый корпус 49 мм, увеличенный дисплей, спутниковые сообщения, 5G и рекордная автономность.',
    specs: 'Корпус: 49 мм титан\nАвтономность: до 42 ч\nСвязь: 5G, спутниковые сообщения\nЯркость: 3000 нит\nЗащита: WR100, MIL-STD 810H',
    colors: TITAN2, storages: [], images: []
  },
  {
    id: 'airpods-pro-3', name: 'AirPods Pro 3', category: 'AirPods',
    price: 26990, oldPrice: null, badge: 'Новинка', inStock: true,
    shortDesc: 'Улучшенное шумоподавление, датчик пульса.',
    description: 'Третье поколение AirPods Pro: заметно более эффективное активное шумоподавление, встроенный датчик пульса, отслеживание тренировок и защита от воды и пота.',
    specs: 'Чип: H2\nШумоподавление: активное (нового поколения)\nДатчик пульса: есть\nЗарядка: USB-C, MagSafe\nАвтономность: до 8 ч (30 ч с кейсом)\nЗащита: IP57',
    colors: [], storages: [], images: []
  }
];
