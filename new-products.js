'use strict';
/*
 * Новинки Apple для команды `node add-novinki.js` — добавляет их в ЖИВОЙ каталог,
 * не затрагивая уже существующие товары (проверка по названию, дублей не будет).
 * Источник данных один — catalog.js, поэтому список никогда не расходится с витриной.
 */
const { products, NOVELTY_IDS } = require('./catalog');

module.exports = products.filter(p => NOVELTY_IDS.includes(p.id));
