const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { backupScript, restoreScript, deployScript } = require('../lib/operations');
const { shellQuote: q } = require('../lib/security');

const bash = process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : '/bin/bash';
const available = fs.existsSync(bash);
const posix = value => process.platform === 'win32' ? value.replace(/\\/g, '/').replace(/^([A-Za-z]):/, (_, drive) => `/${drive.toLowerCase()}`) : value;
function directory(t) {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'serverops-shell-'));
  t.after(() => {
    assert.equal(path.dirname(path.resolve(folder)), path.resolve(os.tmpdir()));
    fs.rmSync(folder, { recursive: true, force: true });
  });
  return folder;
}
function shell(script) { return spawnSync(bash, ['-s'], { input: `set -eu\n${script}\n`, encoding: 'utf8', timeout: 30000 }); }
function success(script) {
  const result = shell(script);
  assert.equal(result.status, 0, result.stderr || result.error?.message || result.stdout);
  return result.stdout;
}

test('real tar backup and restore handle quoted paths and refuse a tampered archive', { skip: !available }, t => {
  const folder = directory(t);
  const source = path.join(folder, "data with 'quotes'");
  const storage = path.join(folder, 'backups');
  fs.mkdirSync(source);
  fs.writeFileSync(path.join(source, 'hello.txt'), 'original contents');
  const plan = { kind: 'files', source: posix(source) };
  const archive = `${posix(storage)}/test.tar.gz`;
  success(backupScript(plan, archive, posix(storage)));
  fs.writeFileSync(path.join(source, 'hello.txt'), 'changed contents');
  success(restoreScript(plan, archive));
  assert.equal(fs.readFileSync(path.join(source, 'hello.txt'), 'utf8'), 'original contents');
  fs.appendFileSync(path.join(storage, 'test.tar.gz'), 'tampered');
  fs.writeFileSync(path.join(source, 'hello.txt'), 'must stay unchanged');
  const failed = shell(restoreScript(plan, archive));
  assert.notEqual(failed.status, 0);
  assert.equal(fs.readFileSync(path.join(source, 'hello.txt'), 'utf8'), 'must stay unchanged');
});

test('real Git deployment changes checkout, restarts PM2 and rolls back without deleting untracked configuration', { skip: !available }, t => {
  const folder = directory(t);
  const origin = `${posix(folder)}/origin`;
  const app = `${posix(folder)}/app`;
  const bin = `${posix(folder)}/bin`;
  success(`mkdir -p ${q(origin)} ${q(bin)}\ngit -C ${q(origin)} init -b main\ngit -C ${q(origin)} config user.name Tester\ngit -C ${q(origin)} config user.email tester@example.invalid\nprintf v1 > ${q(`${origin}/version.txt`)}\ngit -C ${q(origin)} add .\ngit -C ${q(origin)} commit -m first`);
  
  const pm2 = path.join(folder, 'bin', 'pm2');
  fs.writeFileSync(pm2, `#!/bin/sh\nprintf '%s\\n' "$*" >> ${q(`${posix(folder)}/pm2.log`)}\n`, { mode: 0o755 });
  success(`chmod +x ${q(posix(pm2))}`);
  const config = { repository: require('url').pathToFileURL(path.join(folder, 'origin')).href, branch: 'main', directory: app, processName: 'api', install: false, build: false };
  const environment = `export PATH=${q(bin)}:"$PATH"\n`;
  const initial = success(environment + deployScript(config));
  assert.doesNotMatch(initial, /CL_FROM=/, 'initial deployment has no previous application revision');
  const first = initial.match(/CL_TO=([a-f0-9]{40,64})/)[1];
  fs.writeFileSync(path.join(folder, 'app', '.env'), 'SAMPLE=keep-me');
  success(`printf v2 > ${q(`${origin}/version.txt`)}\ngit -C ${q(origin)} add .\ngit -C ${q(origin)} commit -m second`);
  const deployed = success(environment + deployScript(config));
  assert.match(deployed, new RegExp(`CL_FROM=${first}`));
  assert.equal(fs.readFileSync(path.join(folder, 'app', 'version.txt'), 'utf8'), 'v2');
  success(environment + deployScript(config, first));
  assert.equal(fs.readFileSync(path.join(folder, 'app', 'version.txt'), 'utf8'), 'v1');
  assert.equal(fs.readFileSync(path.join(folder, 'app', '.env'), 'utf8'), 'SAMPLE=keep-me');
  assert.equal(fs.readFileSync(path.join(folder, 'pm2.log'), 'utf8').trim().split('\n').length, 3);
  fs.writeFileSync(path.join(folder, 'app', 'version.txt'), 'local modifications');
  const rejected = shell(environment + deployScript(config));
  assert.notEqual(rejected.status, 0);
  assert.match(rejected.stderr, /local changes/);
  assert.equal(fs.readFileSync(path.join(folder, 'app', 'version.txt'), 'utf8'), 'local modifications');
});

test('OAuth Git credentials arrive on stdin and are removed before the application restarts', { skip: !available }, t => {
  const folder = directory(t);
  const base = posix(folder);
  const origin = `${base}/origin`;
  const bin = `${base}/bin`;
  success(`mkdir -p ${q(origin)} ${q(bin)}\ngit -C ${q(origin)} init -b main\ngit -C ${q(origin)} config user.name Tester\ngit -C ${q(origin)} config user.email tester@example.invalid\nprintf v1 > ${q(`${origin}/version.txt`)}\ngit -C ${q(origin)} add .\ngit -C ${q(origin)} commit -m first`);
  const realGit = success('command -v git').trim();
  fs.writeFileSync(path.join(folder, 'bin', 'git'), `#!/bin/sh\ncase "$*" in\n *clone*|*fetch*)\n test -f "$CL_GIT_CREDENTIAL_FILE" || exit 7\n test "$("$GIT_ASKPASS" 'Username for github')" = x-access-token || exit 8\n test "$("$GIT_ASKPASS" 'Password for github')" = fixture-stdin-token-42 || exit 9\n printf '%s' "$CL_GIT_CREDENTIAL_FILE" > ${q(`${base}/credential-path`)}\n ;;\nesac\nexec ${q(realGit)} "$@"\n`, { mode: 0o755 });
  fs.writeFileSync(path.join(folder, 'bin', 'pm2'), '#!/bin/sh\ntest -z "${GIT_ASKPASS-}"\ntest -z "${CL_GIT_CREDENTIAL_FILE-}"\n', { mode: 0o755 });
  success(`chmod +x ${q(`${bin}/git`)} ${q(`${bin}/pm2`)}`);
  const config = { repository: require('url').pathToFileURL(path.join(folder, 'origin')).href, branch: 'main', directory: `${base}/app`, processName: 'api', install: false, build: false };
  const script = `set -eu\nexport PATH=${q(bin)}:"$PATH"\n${deployScript(config, null, true)}`;
  const result = spawnSync(bash, ['-c', script], { input: 'fixture-stdin-token-42\n', encoding: 'utf8', timeout: 30000 });
  assert.equal(result.status, 0, result.stderr);
  const credentialPath = fs.readFileSync(path.join(folder, 'credential-path'), 'utf8');
  success(`test ! -e ${q(credentialPath)}\ntest ! -d ${q(path.posix.dirname(credentialPath))}`);
  assert.equal((result.stdout + result.stderr).includes('fixture-stdin-token-42'), false);
});
