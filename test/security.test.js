const test = require('node:test');
const assert = require('node:assert/strict');
const security = require('../lib/security');

test('shellQuote wraps values so the shell sees one literal argument', () => {
  assert.equal(security.shellQuote('abc'), "'abc'");
  assert.equal(security.shellQuote("it's"), "'it'\\''s'");
  assert.equal(security.shellQuote('$(rm -rf /); `id`'), "'$(rm -rf /); `id`'");
  assert.throws(() => security.shellQuote('a\0b'), /NUL/);
});

test('assertSafeName accepts process/container names and rejects shell syntax', () => {
  assert.equal(security.assertSafeName('my-bot_1.2'), 'my-bot_1.2');
  for (const bad of ['', ' ', '-rf', 'a b', 'a;b', 'a$(id)', 'a/b', '../x', 'x'.repeat(200)]) {
    assert.throws(() => security.assertSafeName(bad), { statusCode: 400 }, `should reject ${JSON.stringify(bad)}`);
  }
});

test('assertFileName blocks traversal and separators', () => {
  assert.equal(security.assertFileName('server.properties'), 'server.properties');
  for (const bad of ['', '.', '..', 'a/b', 'a\\b', 'a\0', 'line\nbreak']) {
    assert.throws(() => security.assertFileName(bad), { statusCode: 400 });
  }
});

test('safeRemoteDir normalises paths and safeRemotePath cannot escape the directory', () => {
  assert.equal(security.safeRemoteDir(undefined, '/root'), '/root');
  assert.equal(security.safeRemoteDir('/root/app/../logs/'), '/root/logs');
  assert.throws(() => security.safeRemoteDir('relative/path'), { statusCode: 400 });
  assert.equal(security.safeRemotePath('/srv', 'a.txt'), '/srv/a.txt');
  assert.throws(() => security.safeRemotePath('/srv', '../etc/passwd'), { statusCode: 400 });
});

test('PANEL_FS_ROOT jails every path', () => {
  process.env.PANEL_FS_ROOT = '/root';
  try {
    assert.equal(security.safeRemoteDir('/root/app'), '/root/app');
    assert.equal(security.safeRemoteDir(''), '/root');
    assert.throws(() => security.safeRemoteDir('/etc'), { statusCode: 403 });
    assert.throws(() => security.safeRemoteDir('/rootkit'), { statusCode: 403 });
    assert.throws(() => security.safeRemoteDir('/root/../etc'), { statusCode: 403 });
  } finally {
    delete process.env.PANEL_FS_ROOT;
  }
});

test('pm2Command only builds whitelisted commands', () => {
  assert.equal(security.pm2Command('restart', 3), 'pm2 restart 3');
  assert.equal(security.pm2Command('stop', 'api'), "pm2 stop 'api'");
  assert.equal(security.pm2Command('restart_all'), 'pm2 restart all');
  assert.throws(() => security.pm2Command('exec', 'x'), { statusCode: 400 });
  assert.throws(() => security.pm2Command('restart', 'x; reboot'), { statusCode: 400 });
  assert.throws(() => security.pm2Command('restart'), { statusCode: 400 });
  assert.match(security.pm2LogsCommand('api', 99999), /--lines 1000 /);
});

test('dockerCommand only allows known actions and safe ids', () => {
  assert.equal(security.dockerCommand('restart', 'redis-cache'), "docker restart 'redis-cache'");
  assert.throws(() => security.dockerCommand('rm', 'x'), { statusCode: 400 });
  assert.throws(() => security.dockerCommand('stop', 'x && reboot'), { statusCode: 400 });
});

test('domain and email validators', () => {
  assert.equal(security.assertDomain('Panel.Example.com'), 'panel.example.com');
  assert.throws(() => security.assertDomain('localhost'), { statusCode: 400 });
  assert.throws(() => security.assertDomain('a.com --dry-run'), { statusCode: 400 });
  assert.equal(security.assertEmail('ops@example.com'), 'ops@example.com');
  assert.throws(() => security.assertEmail('x@y'), { statusCode: 400 });
});

test('redactOutput hides registered secrets and common credential patterns', () => {
  security.registerSecrets(['SuperSecretPassword123']);
  const out = security.redactOutput('login SuperSecretPassword123 ok\nPASSWORD=hunter22\nBearer abc.def');
  assert.ok(!out.includes('SuperSecretPassword123'));
  assert.ok(!out.includes('hunter22'));
  assert.ok(out.includes('Bearer [REDACTED]'));
  security.registerSecrets([]);
});

test('sanitizeServer never leaks credentials', () => {
  const out = security.sanitizeServer({ id: 'a', name: 'n', host: 'h', password: 'pw', privateKey: 'key', hostKeyFingerprint: 'fp' });
  assert.equal(out.password, undefined);
  assert.equal(out.privateKey, undefined);
  assert.equal(out.hasPassword, true);
  assert.equal(out.hasPrivateKey, true);
});

test('roleForToken distinguishes admin and viewer tokens', () => {
  process.env.PANEL_TOKEN = 'a'.repeat(32);
  process.env.PANEL_VIEWER_TOKEN = 'v'.repeat(32);
  try {
    assert.equal(security.roleForToken('a'.repeat(32)), 'admin');
    assert.equal(security.roleForToken('v'.repeat(32)), 'viewer');
    assert.equal(security.roleForToken('nope'), null);
    assert.equal(security.roleForToken(''), null);
  } finally {
    delete process.env.PANEL_TOKEN;
    delete process.env.PANEL_VIEWER_TOKEN;
  }
});

function mockRes() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
    setHeader() {}
  };
}

test('requireAuth enforces tokens and read-only viewers', () => {
  process.env.PANEL_TOKEN = 'a'.repeat(32);
  process.env.PANEL_VIEWER_TOKEN = 'v'.repeat(32);
  const req = (method, url, token) => ({ method, originalUrl: url, get: h => (h === 'X-Panel-Token' ? token : undefined) });
  try {
    let res = mockRes();
    security.requireAuth(req('GET', '/api/metrics', 'wrong'), res, () => assert.fail('should not pass'));
    assert.equal(res.statusCode, 401);

    let passed = false;
    security.requireAuth(req('POST', '/api/pm2/action', 'a'.repeat(32)), mockRes(), () => { passed = true; });
    assert.ok(passed);

    passed = false;
    security.requireAuth(req('GET', '/api/metrics', 'v'.repeat(32)), mockRes(), () => { passed = true; });
    assert.ok(passed);

    res = mockRes();
    security.requireAuth(req('POST', '/api/pm2/action', 'v'.repeat(32)), res, () => assert.fail('viewer must not write'));
    assert.equal(res.statusCode, 403);

    res = mockRes();
    security.requireAuth(req('GET', `/api/files/download?token=${'v'.repeat(32)}`, ''), res, () => assert.fail('viewer must not download'));
    assert.equal(res.statusCode, 403);
  } finally {
    delete process.env.PANEL_TOKEN;
    delete process.env.PANEL_VIEWER_TOKEN;
  }
});

test('requireAuth refuses everything when PANEL_TOKEN is not configured', () => {
  delete process.env.PANEL_TOKEN;
  const res = mockRes();
  security.requireAuth({ method: 'GET', originalUrl: '/api/metrics', get: () => 'x'.repeat(40) }, res, () => assert.fail());
  assert.equal(res.statusCode, 503);
});

test('isAuthorized rejects cross-origin WebSocket upgrades', () => {
  process.env.PANEL_TOKEN = 'a'.repeat(32);
  try {
    const token = 'a'.repeat(32);
    assert.equal(security.isAuthorized({ url: `/?token=${token}`, headers: { host: 'panel:3000', origin: 'http://panel:3000' } }), true);
    assert.equal(security.isAuthorized({ url: `/?token=${token}`, headers: { host: 'panel:3000', origin: 'https://evil.example' } }), false);
    assert.equal(security.isAuthorized({ url: '/?token=bad', headers: { host: 'panel:3000' } }), false);
  } finally {
    delete process.env.PANEL_TOKEN;
  }
});
