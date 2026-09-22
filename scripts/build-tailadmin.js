'use strict';

// Зависимости устанавливаются только во временном каталоге; на сервере сборка не нужна.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const source = path.join(root, 'vendor', 'tailadmin');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'store-tailadmin-build-'));
const verify = process.argv.includes('--verify');
const output = verify ? path.join(temporary, 'output') : path.join(root, 'public');
function run(command, args) {
  const result = spawnSync(command, args, { cwd: temporary, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} завершился с кодом ${result.status}`);
}
try {
  fs.cpSync(source, temporary, { recursive: true, filter: name => path.basename(name) !== 'node_modules' });
  fs.mkdirSync(output, { recursive: true });
  run(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['ci', '--ignore-scripts', '--no-audit', '--no-fund']);
  run(process.execPath, ['build.mjs', output]);
  if (verify) {
    for (const filename of ['tailadmin-ui.js', 'tailadmin-charts.js', 'tailadmin-components.json', 'tailadmin.css', 'tailadmin-grid.svg', 'tailadmin.LICENSE.txt']) {
      if (!fs.readFileSync(path.join(output, filename)).equals(fs.readFileSync(path.join(root, 'public', filename)))) {
        throw new Error(`${filename} отличается от воспроизводимой сборки`);
      }
    }
    console.log('Сохранённые браузерные файлы совпадают со сборкой.');
  }
} finally {
  fs.rmSync(temporary, { recursive: true, force: true });
}
