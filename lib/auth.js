'use strict';
// Хеширование пароля админа через встроенный crypto (scrypt). Без внешних зависимостей.
const crypto = require('crypto');

function hashPassword(password, salt) {
  salt = salt || crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(password), salt, 64).toString('hex');
  return salt + ':' + hash;
}

function verifyPassword(password, stored) {
  if (!stored || !stored.includes(':')) return false;
  const [salt, hash] = stored.split(':');
  const test = crypto.scryptSync(String(password), salt, 64).toString('hex');
  const a = Buffer.from(hash, 'hex');
  const b = Buffer.from(test, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function verifyPasswordAsync(password, stored) {
  if (!stored || !stored.includes(':')) return Promise.resolve(false);
  const [salt, hash] = stored.split(':');
  const expected = Buffer.from(hash, 'hex');
  if (expected.length !== 64) return Promise.resolve(false);
  return new Promise((resolve, reject) => {
    crypto.scrypt(String(password), salt, 64, (error, derived) => {
      if (error) return reject(error);
      resolve(derived.length === expected.length && crypto.timingSafeEqual(derived, expected));
    });
  });
}

module.exports = { hashPassword, verifyPassword, verifyPasswordAsync };
