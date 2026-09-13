#!/usr/bin/env node
'use strict';
/* ============ Перенос магазина на другой сервер: ВЫГРУЗКА ============
 *
 * Собирает в один архив всё, что составляет МАГАЗИН, а не его историю: каталог
 * с фотографиями, отзывы со всеми вложениями и настройки. Второй сайт — это
 * второй сервер с тем же кодом (см. «Два сайта из одного репозитория» в
 * CLAUDE.md), и заводить ему каталог заново по одной карточке незачем.
 *
 *   STORE_DATA_DIR=/var/lib/apple-store node scripts/export-store.js                     # что уедет
 *   STORE_DATA_DIR=/var/lib/apple-store node scripts/export-store.js --out /tmp/store.tgz # записать архив
 *
 * Обратная сторона — `scripts/import-store.js`; с ноутбука обе команды
 * запускает разом `deploy/clone-data.sh <откуда> <куда>`.
 *
 * ЧТО НЕ УЕЗЖАЕТ, И ЭТО ГЛАВНОЕ. Заказы, переписка чата, метрика, правила
 * блокировки посетителей и отметки панели — это ПОКУПАТЕЛИ этого магазина и
 * его история, а не товар. Копировать их на другой сайт значило бы завести там
 * чужие заявки с телефонами и адресами людей, которые этому сайту ничего не
 * заказывали. Поэтому в архиве нет ни `orders.json`, ни `chats.json`, ни
 * `analytics.json`, ни снимков из переписок. Базы «IP → город» и пунктов
 * выдачи тоже не едут: они не про магазин, а про мир, и новый сервер соберёт
 * их сам (`setup-server.sh` ставит cron).
 *
 * ФАЙЛЫ БЕРУТСЯ ПО ССЫЛКАМ, а не каталогом целиком: что считается ссылкой на
 * загрузку, знает одно место — `db.usedUploads()`, то же, которым живёт уборка.
 * Уменьшенные копии карточек (`-c320` и соседи) едут вместе со своим
 * исходником (`IMG.derivedNames`), превью отзывов — как обычные ссылки. Файл,
 * на который ссылка есть, а на диске его нет, называется вслух и не роняет
 * выгрузку: перенос — не повод чинить чужие сироты.
 *
 * АРХИВ СОБИРАЕТСЯ ЖЁСТКИМИ ССЫЛКАМИ, а не копией: у боевого магазина в
 * загрузках сотни мегабайт видео, и удваивать их на диске ради tar незачем.
 * Промежуточный каталог поэтому создаётся ВНУТРИ каталога данных — на том же
 * разделе, иначе `link()` откажет. Не удалось связать — файл копируется.
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const db = require('../lib/db');
const IMG = require('../lib/images');

const FORMAT = 1;
const args = process.argv.slice(2);
const outArg = (() => { const i = args.indexOf('--out'); return i >= 0 ? args[i + 1] : ''; })();

function human(bytes) {
  if (bytes < 1024) return bytes + ' Б';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' КБ';
  return (bytes / 1024 / 1024).toFixed(1) + ' МБ';
}

/* Список файлов переноса — ОДИН на выгрузку и заливку (`import-store.js`
 * подключает эту же функцию): что уехало, то и ляжет, и наоборот. */
function transferFiles(products, reviews, settings, uploadDir) {
  const wanted = new Set(db.usedUploads(products, reviews, settings, null));
  /* Уменьшенные копии — необязательные: их нет у снимков, загруженных до
   * появления копий или без ImageMagick, и карточка тогда показывает
   * исходник. Отсутствующая копия — не битая ссылка, о ней не говорим. */
  const optional = new Set();
  for (const p of (products || [])) for (const name of (p.images || [])) for (const d of IMG.derivedNames(name)) if (!wanted.has(d)) optional.add(d);
  const files = [];
  const missing = [];
  let bytes = 0;
  for (const name of [...wanted, ...optional].sort()) {
    if (!name || path.basename(name) !== name) continue;
    let st;
    try { st = fs.statSync(path.join(uploadDir, name)); } catch (e) { if (wanted.has(name)) missing.push(name); continue; }
    if (!st.isFile()) { if (wanted.has(name)) missing.push(name); continue; }
    files.push(name);
    bytes += st.size;
  }
  return { files, missing, bytes };
}

function main() {
  const products = db.getProducts();
  const reviews = db.getReviews();
  // Сырые настройки, а не `getSettings()`: значения по умолчанию заливка
  // подставит сама, и в архиве останется только то, что владелец правда задал.
  const settings = db.readJson('settings', {});
  const plan = transferFiles(products, reviews, settings, db.UPLOAD_DIR);

  console.log(`Магазин: «${settings.storeName || '—'}», данные в ${db.DATA_DIR}`);
  console.log(`  товаров: ${products.length}`);
  console.log(`  отзывов: ${reviews.length}`);
  console.log(`  файлов загрузок по ссылкам: ${plan.files.length} (${human(plan.bytes)})`);
  if (plan.missing.length) {
    console.log(`  ссылок на отсутствующие файлы: ${plan.missing.length} — они не поедут:`);
    for (const name of plan.missing.slice(0, 20)) console.log('    ' + name);
    if (plan.missing.length > 20) console.log(`    … и ещё ${plan.missing.length - 20}`);
  }
  console.log('  НЕ едут: заказы, переписка чата, метрика, правила посетителей, базы городов и пунктов выдачи.');

  if (!outArg) {
    console.log('\nАрхив не записан. Записать: --out /путь/к/архиву.tgz');
    return;
  }
  const out = path.resolve(outArg);
  const staging = fs.mkdtempSync(path.join(db.DATA_DIR, 'export-'));
  const root = path.join(staging, 'store-export');
  try {
    fs.mkdirSync(path.join(root, 'uploads'), { recursive: true });
    const manifest = {
      format: FORMAT, exportedAt: new Date().toISOString(), storeName: settings.storeName || '',
      products: products.length, reviews: reviews.length, files: plan.files.length, bytes: plan.bytes
    };
    fs.writeFileSync(path.join(root, 'manifest.json'), JSON.stringify(manifest, null, 2));
    fs.writeFileSync(path.join(root, 'products.json'), JSON.stringify(products, null, 2));
    fs.writeFileSync(path.join(root, 'reviews.json'), JSON.stringify(reviews, null, 2));
    fs.writeFileSync(path.join(root, 'settings.json'), JSON.stringify(settings, null, 2));
    let linked = 0, copied = 0;
    for (const name of plan.files) {
      const src = path.join(db.UPLOAD_DIR, name);
      const dst = path.join(root, 'uploads', name);
      try { fs.linkSync(src, dst); linked++; }
      catch (e) { fs.copyFileSync(src, dst); copied++; }
    }
    fs.mkdirSync(path.dirname(out), { recursive: true });
    // Во временный файл и переименованием на место — как `writeJson`: оборванная
    // упаковка не оставит половину архива под готовым именем.
    const tmp = out + '.' + process.pid + '.tmp';
    execFileSync('tar', ['-czf', tmp, '-C', staging, 'store-export'], { stdio: 'inherit' });
    fs.renameSync(tmp, out);
    const size = fs.statSync(out).size;
    console.log(`\nАрхив записан: ${out} (${human(size)}; файлов связано ${linked}, скопировано ${copied})`);
    console.log('Дальше на новом сервере: node scripts/import-store.js ' + path.basename(out) + ' --apply');
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
}

module.exports = { transferFiles, FORMAT };
if (require.main === module) main();
