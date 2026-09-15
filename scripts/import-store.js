#!/usr/bin/env node
'use strict';
/* ============ Перенос магазина на другой сервер: ЗАЛИВКА ============
 *
 * Принимает архив от `scripts/export-store.js` и кладёт его содержимое в
 * каталог данных ЭТОГО сервера: каталог с фотографиями, отзывы со вложениями
 * и настройки. Запускается на новом сервере — обычно её приносит туда
 * `deploy/clone-data.sh` с ноутбука.
 *
 *   STORE_DATA_DIR=/var/lib/apple-store node scripts/import-store.js store.tgz            # что изменится
 *   STORE_DATA_DIR=/var/lib/apple-store node scripts/import-store.js store.tgz --apply    # записать
 *     --keep-settings   настройки как есть, включая название, реквизиты и ключи касс
 *     --force           заливать поверх магазина, который уже торговал
 *
 * ГЛАВНОЕ ПРАВИЛО: ВТОРОЙ САЙТ — ДРУГОЙ МАГАЗИН, и всё, что делает магазин
 * этим магазином, по умолчанию НЕ переносится (`SITE_FIELDS`): название,
 * слоган, логотип, контакты, адрес точки, реквизиты продавца, Telegram и КЛЮЧИ
 * КАСС. Скопировать ключи кассы значило бы, что первый же покупатель нового
 * сайта платит на счёт старого, а банк возвращает его на чужой домен. Поэтому
 * новый сайт стартует в режиме заявок с названием по умолчанию — это видно
 * сразу, и это безопасно. Что общего у сайтов одного владельца (ключ ИИ,
 * инструкция консультанта, ключ подсказок адресов, промокоды, доставка,
 * пределы касс), едет как есть. `--keep-settings` переносит настройки
 * буквально — для переезда ТОГО ЖЕ магазина на другую машину.
 *
 * Секрет подписи сессий и список дополнительных доменов не переносятся
 * никогда: общий секрет означал бы, что cookie панели одного сайта подходит
 * ко второму, а домены — свойство сервера, у нового они свои.
 *
 * ПОВЕРХ ЖИВОГО МАГАЗИНА ЗАЛИВКА НЕ ИДЁТ. Свежий сервер после первого запуска
 * держит демо-каталог из `catalog.js` и демо-отзывы — их заменить можно. А вот
 * заказы, отзывы покупателей или снимки в хранилище означают, что здесь уже
 * торговали, и стереть это молча нельзя — только осознанно, с `--force`.
 *
 * Пишется всё атомарно (`db.writeJson`) и ПОСЛЕ проверки архива целиком:
 * распаковка — во временный каталог рядом с данными, а не поверх них.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const db = require('../lib/db');
const { transferFiles, FORMAT } = require('./export-store');

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const KEEP = args.includes('--keep-settings');
const FORCE = args.includes('--force');
const archiveArg = args.find(a => !a.startsWith('--'));

/* Что делает магазин ИМЕННО ЭТИМ магазином. Список закрытый и лежит здесь
 * одним куском, чтобы его читали целиком: каждое поле — обещание покупателю
 * или деньги, и переехать на чужой сайт оно не должно. */
const SITE_FIELDS = {
  'название и вид': ['storeName', 'tagline', 'metaDescription', 'footerNote', 'logoImage', 'logoText', 'logoFont'],
  'контакты и офлайн-точка': ['contactTelegram', 'contactWhatsApp', 'contactWhatsAppMessage', 'contactPhone', 'contactEmail',
    'contactHours', 'storeAddress', 'storeGeo', 'storePhotos', 'storeSinceYear'],
  'реквизиты продавца': ['legalOperator', 'legalInn', 'legalOgrn', 'legalDetails', 'legalAddress', 'privacyEmail',
    'bankAccount', 'bankName', 'bankBik', 'bankCorr', 'bankInn', 'bankKpp'],
  'Telegram': ['telegramBotToken', 'telegramChatId', 'chatChatId'],
  // Номер счётчика стоит в HTML открытым текстом, и сервисы обратного поиска
  // связывают сайты с одним номером ПУБЛИЧНО — у второго сайта он свой.
  'Яндекс Метрика': ['ymCounterId'],
  'кассы и свои реквизиты': ['crocopayEnabled', 'crocopayClientId', 'crocopayClientSecret',
    'meridianpayEnabled', 'meridianpayApiKey', 'meridianpayMerchantId', 'meridianpaySecret',
    'plategaEnabled', 'plategaMerchantId', 'plategaSecret', 'plategaFeePercent', 'plategaMaxTotal',
    'alfabankEnabled', 'alfabankToken', 'alfabankLogin', 'alfabankPassword', 'alfabankTest',
    'ownPayEnabled', 'ownPayCard', 'ownPayPhone', 'ownPayOwner', 'ownPayBank']
};
// Не переносятся НИКОГДА — это свойства сервера, а не магазина.
const SERVER_FIELDS = ['sessionSecret', 'siteDomains'];

function fail(msg) { console.error('СТОП. ' + msg); process.exit(1); }

function readArchive(archive) {
  const tmp = fs.mkdtempSync(path.join(db.DATA_DIR, 'import-'));
  try {
    execFileSync('tar', ['-xzf', archive, '-C', tmp], { stdio: 'inherit' });
  } catch (e) { fs.rmSync(tmp, { recursive: true, force: true }); fail('архив не распаковался: ' + archive); }
  const root = path.join(tmp, 'store-export');
  const readJson = (name) => {
    try { return JSON.parse(fs.readFileSync(path.join(root, name), 'utf8')); }
    catch (e) { fs.rmSync(tmp, { recursive: true, force: true }); fail(`в архиве нет читаемого ${name} — это не выгрузка export-store.js`); }
  };
  const manifest = readJson('manifest.json');
  if (manifest.format !== FORMAT) { fs.rmSync(tmp, { recursive: true, force: true }); fail(`формат архива ${manifest.format}, а этот скрипт понимает ${FORMAT}`); }
  const products = readJson('products.json');
  const reviews = readJson('reviews.json');
  const settings = readJson('settings.json');
  if (!Array.isArray(products) || !Array.isArray(reviews) || !settings || typeof settings !== 'object') {
    fs.rmSync(tmp, { recursive: true, force: true }); fail('в архиве не то: товары и отзывы обязаны быть списками, настройки — объектом');
  }
  return { tmp, root, manifest, products, reviews, settings };
}

/* Настройки нового сайта: значения по умолчанию, поверх — привезённые без
 * серверных и (если не `--keep-settings`) без идентифицирующих полей, и всегда
 * свежий секрет сессии. Учётная запись панели едет как есть: владелец тот же,
 * а пароль он сменит в настройках. */
function mergeSettings(imported, opts) {
  const keep = !!(opts && opts.keep);
  const s = Object.assign({}, imported);
  for (const key of SERVER_FIELDS) delete s[key];
  const dropped = [];
  if (!keep) {
    for (const group of Object.keys(SITE_FIELDS)) {
      for (const key of SITE_FIELDS[group]) if (s[key] !== undefined) { delete s[key]; dropped.push(key); }
    }
  }
  const merged = Object.assign(db.defaultSettings(), s);
  merged.sessionSecret = crypto.randomBytes(24).toString('hex');
  return { merged, dropped };
}

/* Торговал ли уже этот сервер. Демо-каталог и демо-отзывы (`demo: true`,
 * id с приставкой `demo-`) заменить можно; заказы, отзывы покупателей и файлы в
 * хранилище — след живого магазина. */
function tradedHere() {
  const reasons = [];
  const orders = db.getOrders();
  if (orders.length) reasons.push(`заказов: ${orders.length}`);
  const real = db.getReviews().filter(r => !(r && (r.demo || String(r.id || '').startsWith('demo-'))));
  if (real.length) reasons.push(`отзывов не из демо-набора: ${real.length}`);
  let uploads = 0;
  try { uploads = fs.readdirSync(db.UPLOAD_DIR).filter(n => !n.startsWith('.')).length; } catch (e) { /* каталога ещё нет */ }
  if (uploads) reasons.push(`файлов в хранилище: ${uploads}`);
  return reasons;
}

function main() {
  if (!archiveArg) fail('укажите архив: node scripts/import-store.js store.tgz [--apply]');
  const archive = path.resolve(archiveArg);
  if (!fs.existsSync(archive)) fail('архива нет: ' + archive);

  const traded = tradedHere();
  if (traded.length && !FORCE) {
    fail('здесь уже торговали (' + traded.join(', ') + '). Заливать поверх — только осознанно: --force');
  }

  const a = readArchive(archive);
  try {
    const { merged, dropped } = mergeSettings(a.settings, { keep: KEEP });
    // Файлы — по ссылкам ИТОГОВЫХ данных: снятый логотип старого сайта или его
    // фотографии точки в хранилище нового не нужны.
    const plan = transferFiles(a.products, a.reviews, merged, path.join(a.root, 'uploads'));

    console.log(`Архив от «${a.manifest.storeName || '—'}» (${a.manifest.exportedAt}) → ${db.DATA_DIR}`);
    console.log(`  товаров: ${a.products.length}, отзывов: ${a.reviews.length}, файлов: ${plan.files.length}`);
    if (plan.missing.length) console.log(`  в архиве не хватает файлов по ссылкам: ${plan.missing.length} (первые: ${plan.missing.slice(0, 5).join(', ')})`);
    if (KEEP) console.log('  настройки: переносятся как есть (кроме секрета сессии и доменов)');
    else {
      console.log('  настройки: общие переносятся, а эти сбрасываются — их задают в панели нового сайта:');
      for (const group of Object.keys(SITE_FIELDS)) {
        const here = SITE_FIELDS[group].filter(k => dropped.includes(k));
        if (here.length) console.log(`    · ${group}: ${here.join(', ')}`);
      }
    }
    if (traded.length) console.log('  ВНИМАНИЕ: --force, будет заменён магазин, который уже торговал (' + traded.join(', ') + ')');

    if (!APPLY) { console.log('\nНичего не записано. Записать: --apply'); return; }

    fs.mkdirSync(db.UPLOAD_DIR, { recursive: true, mode: 0o700 });
    let linked = 0, copied = 0;
    for (const name of plan.files) {
      const src = path.join(a.root, 'uploads', name);
      const dst = path.join(db.UPLOAD_DIR, name);
      try { fs.unlinkSync(dst); } catch (e) { /* файла и не было */ }
      try { fs.linkSync(src, dst); linked++; }
      catch (e) { fs.copyFileSync(src, dst); copied++; }
      try { fs.chmodSync(dst, 0o600); } catch (e) { /* не наш файл — не страшно */ }
    }
    // JSON — последним и атомарно: файлы уже лежат, ссылки на них станут
    // видны разом. Порядок «сначала товары и отзывы, потом настройки» — чтобы
    // витрина ни на миг не показывала новое имя со старым каталогом.
    db.writeJson('products', a.products);
    db.writeJson('reviews', a.reviews);
    db.writeJson('settings', merged);
    for (const name of ['settings', 'products', 'reviews']) {
      try { fs.chmodSync(path.join(db.DATA_DIR, name + '.json'), 0o600); } catch (e) {}
    }
    console.log(`\nГотово: товаров ${a.products.length}, отзывов ${a.reviews.length}, файлов ${plan.files.length} (связано ${linked}, скопировано ${copied}).`);
    console.log('Перезапустите процесс: pm2 restart istore');
    if (!KEEP) {
      console.log('\nДальше в панели нового сайта (/admin → Настройки):');
      console.log('  · название, слоган, логотип; контакты и адрес точки; реквизиты продавца;');
      console.log('  · Telegram для заявок и чата; кассы или свои реквизиты — пока витрина в режиме заявок;');
      console.log('  · приветствие и инструкция консультанта — там могло остаться старое название;');
      console.log('  · пароль панели: он приехал со старого сайта.');
    }
  } finally {
    fs.rmSync(a.tmp, { recursive: true, force: true });
  }
}

module.exports = { SITE_FIELDS, SERVER_FIELDS, mergeSettings };
if (require.main === module) main();
