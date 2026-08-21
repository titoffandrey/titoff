'use strict';

// Разовая уборка: убирает из привезённых отзывов аватарки профилей.
//
// Площадка держит портреты покупателей на тех же хостах, что и медиа отзывов
// (`cdn1.ozonusercontent.com/s3/fs-my-account-avatar/…`), и фильтр по хосту их
// не отличал — в хранилище они попали наравне со снимками товара. На витрине
// это выглядело так, будто покупатель приложил к отзыву своё фото.
//
// Заливка больше так не делает (`AVATAR_RE` в scripts/import-ozon-reviews.js),
// но уже залитое надо вычистить. Какие именно файлы были аватарками, знают
// пакеты: имя файла в хранилище считается от адреса (sha1), поэтому по адресу
// имя восстанавливается однозначно.
//
//   node scripts/drop-review-avatars.js <папка с пакетами>            # показать
//   node scripts/drop-review-avatars.js <папка с пакетами> --apply    # убрать
//
// Идемпотентно: повторный прогон не находит ничего.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const db = require('../lib/db');

const args = process.argv.slice(2);
const root = args.find(a => !a.startsWith('--'));
const apply = args.includes('--apply');

if (!root) {
  console.error('Укажите папку с пакетами: node scripts/drop-review-avatars.js /home/titoff/ozon --apply');
  process.exit(1);
}

const AVATAR_RE = /fs-my-account-avatar|\/avatar\/|user-avatar/i;

// Имя файла в хранилище — без расширения: заливка кладёт .jpg, а обработка
// переименовывает в .webp, и совпасть должно в обоих случаях.
function baseName(url) {
  return 'rv-' + crypto.createHash('sha1').update(String(url)).digest('hex').slice(0, 16);
}

function bundleFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...bundleFiles(full));
    else if (/^bundle.*\.json$/i.test(entry.name)) out.push(full);
  }
  return out;
}

const files = bundleFiles(path.resolve(root));
if (!files.length) {
  console.error(`В «${root}» не нашлось ни одного bundle*.json`);
  process.exit(1);
}

const avatars = new Set();
for (const file of files) {
  let bundle;
  try { bundle = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (e) { console.log(`  ! не читается, пропускаю: ${file}`); continue; }
  let n = 0;
  for (const rv of bundle.reviews || []) {
    for (const url of rv.photos || []) if (AVATAR_RE.test(url)) { avatars.add(baseName(url)); n++; }
  }
  console.log(`${path.basename(file).padEnd(34)} аватарок в пакете: ${n}`);
}
console.log(`\nРазных файлов-аватарок: ${avatars.size}`);

const isAvatarFile = name => avatars.has(String(name).replace(/\.[^.]+$/, ''));

const list = db.getReviews();
const orphans = new Set();
let touched = 0, dropped = 0, lostAll = 0;

for (const rv of list) {
  const photos = rv.photos || [];
  const keep = photos.filter(f => !isAvatarFile(f));
  if (keep.length === photos.length) continue;

  for (const f of photos) {
    if (!isAvatarFile(f)) continue;
    orphans.add(f);
    // Превью снятого вложения уходит вместе с ним: карта `previews` переживает
    // удаление файла, и забытая запись держала бы его в хранилище вечно.
    if (rv.previews && rv.previews[f]) { orphans.add(rv.previews[f]); delete rv.previews[f]; }
  }
  dropped += photos.length - keep.length;
  rv.photos = keep;
  if (!keep.length && !(rv.videos || []).length) lostAll++;
  touched++;
}

console.log(`Отзывов затронуто: ${touched}, снимков убрано: ${dropped}`);
console.log(`Из них остались вовсе без вложений: ${lostAll}`);

if (!dropped) {
  console.log('\nЧистить нечего.');
  process.exit(0);
}

if (!apply) {
  console.log('\nЭто предпросмотр. Добавьте --apply, чтобы убрать.');
  process.exit(0);
}

db.saveReviews(list);
// Файлы чистим ПОСЛЕ записи: uploadIsUsed читает сохранённый список, а один
// снимок у привезённых отзывов встречается сразу у нескольких записей.
let removed = 0;
for (const f of orphans) if (db.deleteUploadIfUnused(f)) removed++;
console.log(`Файлов удалено из хранилища: ${removed} из ${orphans.size}`);

// Раскладка ленты зависит от того, у кого есть вложения: отзыв, потерявший
// единственный снимок, должен встать среди текстовых, а не держать место с
// фото. Даты раздаются заново тем же способом, что и при заливке.
const shifted = require('./shift-review-dates').shift();
console.log(`Готово. Даты пересчитаны у ${shifted} отзывов.`);
