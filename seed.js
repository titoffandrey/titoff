'use strict';
/*
 * Сброс каталога к демо-набору из seed-data.js.
 * По умолчанию перезаписывает ТОЛЬКО товары, отзывы и заказы. Настройки и логин админа сохраняются.
 * Флаг --all дополнительно сбрасывает настройки (название, Telegram, пароль -> admin/admin).
 *
 *   node seed.js        — сбросить каталог/отзывы/заказы
 *   node seed.js --all  — сбросить всё, включая настройки
 */
const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, 'data');
const all = process.argv.includes('--all');
const targets = ['products', 'reviews', 'orders'].concat(all ? ['settings'] : []);

fs.mkdirSync(DATA_DIR, { recursive: true });
for (const name of targets) {
  try { fs.unlinkSync(path.join(DATA_DIR, name + '.json')); } catch (e) {}
}

require('./lib/db').ensureSeeded();
console.log('Готово. Каталог сброшен к демо-набору' + (all ? ', настройки сброшены (admin/admin).' : ' (настройки сохранены).'));
