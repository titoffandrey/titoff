'use strict';
/*
 * Демо-наполнение: используется при первом запуске (если данных ещё нет) и командой `node seed.js`.
 *
 * Каталог товаров живёт в отдельном файле catalog.js — там вся линейка устройств Apple
 * (состав, цвета, объёмы памяти и характеристики по apple.com, июль 2026).
 * Здесь — только настройки магазина, демо-отзывы и демо-домены.
 *
 * ВНИМАНИЕ: цены ориентировочные (уровень РФ-рынка, июль 2026) и легко правятся в админке.
 */

const { products, now } = require('./catalog');
const { generateDemoReviews } = require('./lib/demo-reviews');

/* ------------------------------- отзывы ------------------------------- */
const reviews = generateDemoReviews(products, { now });

/* --------------------- демо-домены (мультитенант) --------------------- */
// На VPS в hosts указывают реальные домены магазинов.
const sites = [
  {
    id: 'site-a', hosts: ['localhost', '127.0.0.1'],
    storeName: 'iStore', tagline: 'Оригинальная техника Apple с гарантией',
    accentColor: '#0071e3', currency: '₽', currencyPosition: 'after',
    priceMultiplier: 1, adminUsername: 'admin', adminPassword: 'admin',
    footerNote: 'iStore — официальная гарантия и быстрая доставка'
  },
  {
    id: 'site-b', hosts: ['shop-b.local'],
    storeName: 'ТехноМаркет', tagline: 'Apple по выгодным ценам, доставка по всей стране',
    accentColor: '#ff2d55', currency: '₽', currencyPosition: 'after',
    priceMultiplier: 1.15, adminUsername: 'admin', adminPassword: 'admin',
    logoText: '{Техно}Маркет', logoFont: 'grotesk', secondaryColor: '#ff2d55',
    footerNote: 'ТехноМаркет — ваш магазин техники'
  },
  {
    id: 'site-c', hosts: ['shop-c.local'],
    storeName: 'AppleZone', tagline: 'Всё для твоей экосистемы Apple',
    accentColor: '#34c759', currency: '₽', currencyPosition: 'after',
    priceMultiplier: 0.95, adminUsername: 'admin', adminPassword: 'admin',
    logoText: 'Apple{Zone}', logoFont: 'rounded', secondaryColor: '#34c759',
    footerNote: 'AppleZone'
  }
];

module.exports = {
  settings: {
    storeName: 'iStore',
    tagline: 'Оригинальная техника Apple с гарантией и быстрой доставкой',
    footerNote: 'Демонстрационный магазин. Замените текст и товары под свой бренд.'
  },
  products,
  reviews,
  sites
};
