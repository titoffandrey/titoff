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
 *   node scripts/sweep-uploads.js --quarantine # убрать в резервный каталог
 */

const fs = require('fs');
const path = require('path');
const db = require('../lib/db');
const IMG = require('../lib/images');

const QUARANTINE = process.argv.includes('--quarantine');
const APPLY = QUARANTINE || process.argv.includes('--apply');
const DIR = path.join(db.DATA_DIR, 'uploads');
// Между загрузкой снимка и записью формы/отложенным flush чата ссылки ещё нет.
// Уборка живого магазина не должна обгонять сохранение покупателя/владельца.
const GRACE_MS = 60 * 60 * 1000;

function main() {
  let names;
  try { names = fs.readdirSync(DIR); }
  catch (e) { console.error('Каталог загрузок не открылся: ' + DIR); process.exit(1); }

  const have = new Set(names);
  const used = new Set();
  const originals = new Map();
  const orphans = [];
  let bytes = 0;
  let recent = 0;
  const cutoff = Date.now() - GRACE_MS;
  const candidate = name => {
    try {
      const stat = fs.lstatSync(path.join(DIR, name));
      if (!stat.isFile()) return false;
      if (stat.mtimeMs > cutoff) { recent++; return false; }
      return true;
    } catch (e) { return false; }
  };

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
    if (candidate(name)) orphans.push(name);
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
    if (src) originals.set(name, src);
    if (src && used.has(src)) continue;
    if (candidate(name)) orphans.push(name);
  }

  for (const name of orphans) {
    try { bytes += fs.statSync(path.join(DIR, name)).size; } catch (e) { /* уже нет */ }
  }

  const mb = (bytes / 1048576).toFixed(1);
  console.log(`Файлов в хранилище: ${names.length}`);
  console.log(`Ссылок ни у кого нет: ${orphans.length} (${mb} МБ)`);
  if (recent) console.log(`Недавние файлы оставлены до следующей уборки: ${recent}`);
  for (const name of orphans.slice(0, 20)) console.log('  ' + name);
  if (orphans.length > 20) console.log(`  … и ещё ${orphans.length - 20}`);

  if (!APPLY) {
    console.log(orphans.length ? '\nЭто предпросмотр. Убрать с возможностью восстановления: --quarantine; удалить: --apply' : '\nЧисто.');
    return;
  }
  let quarantine = '';
  if (QUARANTINE && orphans.length) {
    const parent = path.join(db.DATA_DIR, 'backups');
    fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
    quarantine = fs.mkdtempSync(path.join(parent, 'orphan-uploads-'));
  }
  let gone = 0;
  for (const name of orphans) {
    // За время обхода могла завершиться форма: проверяем ссылку ещё раз.
    if (db.uploadIsUsed(name) || (originals.has(name) && db.uploadIsUsed(originals.get(name))) || !candidate(name)) continue;
    try {
      if (quarantine) fs.renameSync(path.join(DIR, name), path.join(quarantine, name));
      else fs.unlinkSync(path.join(DIR, name));
      gone++;
    } catch (e) {
      if (e.code !== 'ENOENT') { console.error('Не удалось убрать ' + name + ': ' + e.message); process.exitCode = 1; }
    }
  }
  console.log(`\n${QUARANTINE ? 'Перемещено' : 'Удалено'}: ${gone} (${mb} МБ)`);
  if (quarantine) console.log('Восстановление: файлы из ' + quarantine + ' вернуть в ' + DIR);
}

main();
