'use strict';

// Аварийный сброс пароля панели: пароль забыт, а войти в /admin надо.
// Читается из stdin, чтобы не попадать ни в историю shell, ни в список
// процессов. STORE_DATA_DIR указывает на то же хранилище, что использует сайт:
//
//   echo -n 'новый-пароль' | STORE_DATA_DIR=/var/lib/apple-store node scripts/reset-admin-password.js
//
// Логин панели — e-mail или телефон (lib/admin-login.js). Задать или сменить
// его той же командой: ADMIN_LOGIN='owner@example.com' либо ADMIN_LOGIN='+7 999
// 123-45-67' — адрес ляжет в `adminEmail`, номер в `adminPhone`, второе поле
// не трогается. Без ADMIN_LOGIN логины остаются прежними.
const fs = require('fs');
const db = require('../lib/db');
const auth = require('../lib/auth');
const LOGIN = require('../lib/admin-login');

function resetAdmin(login, password) {
  const current = db.getSettings();
  const nextPassword = String(password || '').replace(/[\r\n]+$/, '');
  if (nextPassword.length < 10) throw new Error('Пароль должен содержать не менее 10 символов');
  if (nextPassword.length > 500) throw new Error('Пароль слишком длинный');
  const patch = { adminPasswordHash: auth.hashPassword(nextPassword) };
  const raw = String(login == null ? '' : login).trim();
  if (raw) {
    const field = db.adminLoginPatch(raw);
    if (!Object.keys(field).length) throw new Error('Логин панели — e-mail или номер телефона, например owner@example.com или +7 999 123-45-67');
    Object.assign(patch, field);
  }
  const next = Object.assign({}, current, patch);
  if (!LOGIN.identity(next)) throw new Error('Логин не задан: укажите e-mail или телефон в ADMIN_LOGIN');
  db.saveSettings(patch);
  return LOGIN.describe(next) || LOGIN.legacy(next);
}

if (require.main === module) {
  try {
    const password = fs.readFileSync(0, 'utf8');
    // ADMIN_USERNAME — прежнее имя той же переменной, оставлено ради старых заметок.
    const login = resetAdmin(process.env.ADMIN_LOGIN || process.env.ADMIN_USERNAME, password);
    process.stdout.write(`Вход «${login}»: пароль панели обновлён.\n`);
  } catch (error) {
    process.stderr.write(`Ошибка: ${error.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = { resetAdmin };
