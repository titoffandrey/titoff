'use strict';

// Аварийный сброс пароля панели: пароль забыт, а войти в /admin надо.
// Читается из stdin, чтобы не попадать ни в историю shell, ни в список
// процессов. STORE_DATA_DIR указывает на то же хранилище, что использует сайт:
//
//   echo -n 'новый-пароль' | STORE_DATA_DIR=/var/lib/apple-store node scripts/reset-admin-password.js
const fs = require('fs');
const db = require('../lib/db');
const auth = require('../lib/auth');

function resetAdmin(username, password) {
  const current = db.getSettings();
  const nextUsername = String(username || current.adminUsername || 'admin').trim().slice(0, 100);
  const nextPassword = String(password || '').replace(/[\r\n]+$/, '');
  if (!nextUsername) throw new Error('Логин не может быть пустым');
  if (nextPassword.length < 10) throw new Error('Пароль должен содержать не менее 10 символов');
  if (nextPassword.length > 500) throw new Error('Пароль слишком длинный');
  db.saveSettings({ adminUsername: nextUsername, adminPasswordHash: auth.hashPassword(nextPassword) });
  return nextUsername;
}

if (require.main === module) {
  try {
    const password = fs.readFileSync(0, 'utf8');
    const username = resetAdmin(process.env.ADMIN_USERNAME, password);
    process.stdout.write(`Логин «${username}»: пароль панели обновлён.\n`);
  } catch (error) {
    process.stderr.write(`Ошибка: ${error.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = { resetAdmin };
