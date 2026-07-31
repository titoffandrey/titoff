'use strict';

// Пароль читается из stdin, чтобы он не попадал в историю shell и список
// процессов. STORE_DATA_DIR указывает на то же хранилище, что использует сайт.
const fs = require('fs');
const db = require('../lib/db');
const auth = require('../lib/auth');

function resetOwner(username, password) {
  const current = db.getSettings();
  const nextUsername = String(username || current.ownerUsername || 'owner').trim().slice(0, 100);
  const nextPassword = String(password || '').replace(/[\r\n]+$/, '');
  if (!nextUsername) throw new Error('Логин владельца не может быть пустым');
  if (nextPassword.length < 10) throw new Error('Пароль должен содержать не менее 10 символов');
  if (nextPassword.length > 500) throw new Error('Пароль слишком длинный');
  db.saveSettings({ ownerUsername: nextUsername, ownerPasswordHash: auth.hashPassword(nextPassword) });
  return nextUsername;
}

if (require.main === module) {
  try {
    const password = fs.readFileSync(0, 'utf8');
    const username = resetOwner(process.env.OWNER_USERNAME, password);
    process.stdout.write(`Логин «${username}»: пароль владельца обновлён.\n`);
  } catch (error) {
    process.stderr.write(`Ошибка: ${error.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = { resetOwner };
