'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const ROOT = path.join(__dirname, '..');
const ID = '1234567890abcdef1234567890abcdef';
const COMMIT = '1'.repeat(40);

function fixture(t) {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'store-deploy-isolation-'));
  t.after(() => fs.rmSync(work, { recursive: true, force: true }));
  for (const dir of ['deploy', 'bin', 'remote']) fs.mkdirSync(path.join(work, dir));
  for (const name of ['install.sh', 'deploy-all.sh', 'project-target.sh', 'bind-project.sh']) {
    fs.copyFileSync(path.join(ROOT, 'deploy', name), path.join(work, 'deploy', name));
  }
  const sites = path.join(work, 'deploy', 'sites.txt');
  fs.writeFileSync(sites, 'own-onion own.example\n');
  fs.writeFileSync(path.join(work, 'deploy', 'project-id'), ID + '\n');
  const log = path.join(work, 'ssh.log');
  // Сетевых запросов нет: проверяем настоящие shell-ветки на изолированном VPS.
  fs.writeFileSync(path.join(work, 'bin', 'ssh'), '#!' + process.execPath + '\n' + `
const fs = require('node:fs');
const cp = require('node:child_process');
const a = process.argv.slice(2);
fs.appendFileSync(process.env.MOCK_LOG, JSON.stringify(a) + '\\n');
if (a[0] === '-G') { console.log('proxycommand nc -x 127.0.0.1:9150 %h %p'); process.exit(0); }
const cmd = a[a.length - 1];
if (cmd.startsWith('PROJECT_ID=')) {
  const script = fs.readFileSync(0, 'utf8')
    .replaceAll('/var/lib/apple-store', process.env.MOCK_REMOTE)
    .replaceAll('/home/titoff/istore', process.env.MOCK_REMOTE + '/app');
  const r = cp.spawnSync('bash', ['-c', cmd], { input: script, encoding: 'utf8', env: process.env });
  process.stdout.write(r.stdout || ''); process.stderr.write(r.stderr || ''); process.exit(r.status || 0);
}
if (cmd.startsWith('cat /var/lib/apple-store/deploy-project-id')) {
  if (!process.env.MOCK_OWNER) process.exit(1);
  console.log(process.env.MOCK_OWNER); process.exit(0);
}
console.error('Unexpected remote mutation'); process.exit(90);
`, { mode: 0o755 });
  // Привязка всё равно проверяет реальную серверную отметку; локальная история
  // здесь подставная, чтобы тест не зависел от checkout и установленных хуков.
  fs.writeFileSync(path.join(work, 'bin', 'git'), '#!/bin/bash\nexit 0\n', { mode: 0o755 });
  function run(script, args = [], extra = {}) {
    return spawnSync('bash', [path.join(work, 'deploy', script), ...args], {
      cwd: work, encoding: 'utf8', env: { ...process.env,
        PATH: path.join(work, 'bin') + path.delimiter + process.env.PATH,
        MOCK_LOG: log, MOCK_REMOTE: path.join(work, 'remote'), MOCK_OWNER: '', ...extra }
    });
  }
  return { work, sites, log, run, remote: path.join(work, 'remote') };
}

test('оба входа выкатки отказывают при нескольких сайтах даже с FORCE_DEPLOY', t => {
  const f = fixture(t);
  fs.appendFileSync(f.sites, 'other-onion other.example\n');
  for (const [script, args] of [['deploy-all.sh', []], ['install.sh', ['own-onion', 'own.example']]]) {
    const r = f.run(script, args, { FORCE_DEPLOY: '1' });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /ровно один сайт/);
  }
  assert.equal(fs.existsSync(f.log), false, 'отказ до SSH');
});

test('некорректные доменные метки отклоняются всеми входами до SSH', t => {
  const f = fixture(t);
  for (const domain of ['bad..example', 'bad-.example', '-bad.example', 'bad.-example', 'bad.example-', '.example', 'example.']) {
    fs.writeFileSync(f.sites, 'own-onion ' + domain + '\n');
    for (const [script, args] of [
      ['deploy-all.sh', []], ['install.sh', ['own-onion', domain]], ['bind-project.sh', ['new']]
    ]) {
      const r = f.run(script, args, { FORCE_DEPLOY: '1' });
      assert.notEqual(r.status, 0, script + ': ' + domain);
      assert.match(r.stderr, /Некорректная строка/, script + ': ' + domain);
    }
  }
  assert.equal(fs.existsSync(f.log), false, 'отказ до проверки SSH и заливки');
});

test('прямой install запрещает чужой алиас, домен и произвольный git-url до SSH', t => {
  const f = fixture(t);
  for (const args of [['other-onion', 'own.example'], ['own-onion', 'other.example'], ['own-onion', 'own.example', 'repo.example']]) {
    const r = f.run('install.sh', args, { FORCE_DEPLOY: '1' });
    assert.notEqual(r.status, 0);
  }
  assert.equal(fs.existsSync(f.log), false);
  assert.notEqual(f.run('deploy-all.sh', ['other.example']).status, 0);
  assert.equal(fs.existsSync(f.log), false);
});

test('без своей серверной привязки выкатка останавливается до заливки', t => {
  const f = fixture(t);
  for (const owner of ['', 'f'.repeat(32)]) {
    const r = f.run('install.sh', ['own-onion', 'own.example'], { MOCK_OWNER: owner, FORCE_DEPLOY: '1' });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /Привязка проекта|другим проектом/);
  }
  const calls = fs.readFileSync(f.log, 'utf8').trim().split('\n').map(JSON.parse);
  assert.ok(calls.every(a => a[0] === '-G' || a.at(-1).startsWith('cat /var/lib/apple-store/deploy-project-id')));
});

test('первичная привязка требует актуальный commit и не заменяет чужого владельца', t => {
  const f = fixture(t);
  const mark = path.join(f.remote, 'deployed-from.txt');
  const owner = path.join(f.remote, 'deploy-project-id');
  const settings = path.join(f.remote, 'settings.json');
  fs.writeFileSync(mark, COMMIT + ' main clean\n');
  fs.writeFileSync(settings, '{"keep":"unchanged"}\n');
  assert.notEqual(f.run('bind-project.sh', ['2'.repeat(40)]).status, 0);
  assert.equal(fs.existsSync(owner), false);
  assert.equal(f.run('bind-project.sh', [COMMIT]).status, 0);
  assert.equal(fs.readFileSync(owner, 'utf8').trim(), ID);
  assert.equal(f.run('bind-project.sh', [COMMIT]).status, 0, 'своя повторная привязка безопасна');
  fs.writeFileSync(owner, 'f'.repeat(32) + '\n');
  assert.notEqual(f.run('bind-project.sh', [COMMIT], { FORCE_DEPLOY: '1' }).status, 0);
  assert.equal(fs.readFileSync(owner, 'utf8').trim(), 'f'.repeat(32));
  assert.equal(fs.readFileSync(mark, 'utf8'), COMMIT + ' main clean\n');
  assert.equal(fs.readFileSync(settings, 'utf8'), '{"keep":"unchanged"}\n');
});

test('привязка new допустима только для пустого сервера', t => {
  const f = fixture(t);
  const settings = path.join(f.remote, 'settings.json');
  fs.writeFileSync(settings, '{}');
  assert.notEqual(f.run('bind-project.sh', ['new']).status, 0);
  assert.equal(fs.existsSync(path.join(f.remote, 'deploy-project-id')), false);
  fs.unlinkSync(settings);
  assert.equal(f.run('bind-project.sh', ['new']).status, 0);
  assert.equal(fs.readFileSync(path.join(f.remote, 'deploy-project-id'), 'utf8').trim(), ID);
});
