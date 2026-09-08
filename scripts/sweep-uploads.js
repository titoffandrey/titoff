#!/usr/bin/env node
'use strict';
/* ============ Осиротевшие загрузки: что лежит в хранилище зря ============
 *
 * Каждый файл в `data/uploads` попал туда по ссылке: фото товара, вложение
 * отзыва, логотип магазина. Ссылку можно снять — удалить товар, отзыв, заменить
 * логотип, — и обычный путь удаления файл за собой убирает
 * (`deleteUploadIfUnused` в `lib/db.js`). Но путей, которые файла не убирают,
 * тоже хватает: правка JSON руками, оборванный импорт, скрипт, перезаписавший
 * список фото целиком, прогон, упавший на середине. Такие файлы не показываются
 * нигде и не удаляются никогда — они просто занимают диск, а на боевом сервере
 * загрузки это самый большой каталог из всех.
 *
 * Скрипт находит их и, с `--apply`, удаляет.
 *
 * ЧТО СЧИТАЕТСЯ ССЫЛКОЙ — спрашиваем у самого хранилища (`db.uploadIsUsed`), а
 * не перечисляем поля здесь заново. Второй список мест, где встречается имя
 * файла, разошёлся бы с первым молча — и разошёлся бы в самую дорогую сторону:
 * удалением того, что показывается покупателю.
 *
 * УМЕНЬШЕННЫЕ КОПИИ (`-c320`, `-c480`, `-c640`, превью отзывов) сиротами не
 * считаются: ссылок на них нет нигде, кроме разметки карточки, и живут они
 * ровно столько, сколько исходник. Поэтому копия проверяется по своему
 * ИСХОДНИКУ: жив он — жива и она.
 *
 *   node scripts/sweep-uploads.js            # только показать
 *   node scripts/sweep-uploads.js --apply    # удалить
 */

const fs = require('fs');
const path = require('path');
const db = require('../lib/db');
const IMG = require('../lib/images');

const APPLY = process.argv.includes('--apply');
const DIR = path.join(db.DATA_DIR, 'uploads');

function main() {
  let names;
  try { names = fs.readdirSync(DIR); }
  catch (e) { console.error('Каталог загрузок не открылся: ' + DIR); process.exit(1); }

  const have = new Set(names);
  const used = new Set();
  const orphans = [];
  let bytes = 0;

  /* Сначала ИСХОДНИКИ — всё, что не является уменьшенной копией. Порядок
   * значим: копии решаются по своему исходнику, и без готового набора живых
   * имён их пришлось бы проверять вторым проходом по хранилищу.
   *
   * Превью вложений отзыва сюда не попадают, хотя формально тоже производные:
   * на них ЕСТЬ ссылка — `reviewFiles()` считает карту `previews` нужной, — и
   * `uploadIsUsed` отвечает про них честно. */
  for (const name of names) {
    if (name.startsWith('.')) continue;
    if (IMG.isDerived(name) && !db.uploadIsUsed(name)) continue;   // разберём ниже
    if (db.uploadIsUsed(name)) { used.add(name); continue; }
    orphans.push(name);
  }
  /* Теперь копии для карточек каталога (`-c320` и соседи). Ссылок на них нет
   * нигде, кроме разметки карточки, поэтому судьба у них одна с исходником:
   * жив он — жива и она. Исходник ищем перебором расширений и обязательно
   * СВЕРЯЕМ С ГЕНЕРАТОРОМ (`derivedNames`) — иначе файл, в имени которого
   * случайно оказалось «-c», мы приняли бы за копию чужого снимка. */
  const EXT = ['.webp', '.jpg', '.jpeg', '.png', '.gif'];
  for (const name of names) {
    if (name.startsWith('.') || !IMG.isDerived(name) || db.uploadIsUsed(name)) continue;
    const dot = name.lastIndexOf('.');
    const base = dot > 0 ? name.slice(0, dot) : name;
    const cut = base.lastIndexOf('-c');
    const stem = cut > 0 ? base.slice(0, cut) : '';
    const src = stem && EXT.map(ext => stem + ext)
      .find(candidate => have.has(candidate) && IMG.derivedNames(candidate).includes(name));
    if (src && used.has(src)) continue;
    orphans.push(name);
  }

  for (const name of orphans) {
    try { bytes += fs.statSync(path.join(DIR, name)).size; } catch (e) { /* уже нет */ }
  }

  const mb = (bytes / 1048576).toFixed(1);
  console.log(`Файлов в хранилище: ${names.length}`);
  console.log(`Ссылок ни у кого нет: ${orphans.length} (${mb} МБ)`);
  for (const name of orphans.slice(0, 20)) console.log('  ' + name);
  if (orphans.length > 20) console.log(`  … и ещё ${orphans.length - 20}`);

  if (!APPLY) {
    console.log(orphans.length ? '\nЭто предпросмотр. Удалить: --apply' : '\nЧисто.');
    return;
  }
  let gone = 0;
  for (const name of orphans) {
    try { fs.unlinkSync(path.join(DIR, name)); gone++; } catch (e) { /* уже нет */ }
  }
  console.log(`\nУдалено: ${gone} (${mb} МБ)`);
}

main();
