const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const express = require('express');
const { GitHub } = require('../lib/github');
const { Operations } = require('../lib/operations');
const security = require('../lib/security');
const { githubRouter, callbackRoute, CALLBACK } = require('../routes/github');
process.env.CONFIG_KEY = 'ca'.repeat(32);
for (const key of ['GITHUB_CLIENT_ID', 'GITHUB_CLIENT_SECRET', 'GITHUB_CALLBACK_URL']) delete process.env[key];
const TOKEN = 'gho_fixture_access_token_1234567890';
const SECRET = 'fixture_client_secret_1234567890';
const owner = { id: 'owner', username: 'owner', role: 'admin' };
const callbackUrl = 'http://localhost:3000/api/github/callback';

function fixture(t, customFetch) {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'serverops-github-'));
  t.after(() => {
    assert.equal(path.dirname(path.resolve(folder)), path.resolve(os.tmpdir()));
    fs.rmSync(folder, { recursive: true, force: true });
  });
  const calls = [];
  const fetcher = async (url, options) => {
    calls.push({ url, options });
    if (customFetch) return customFetch(url, options);
    if (url === 'https://github.com/login/oauth/access_token') return Response.json({ access_token: TOKEN });
    if (url === 'https://api.github.com/user') return Response.json({ id: 7, login: 'octocat' });
    if (url.includes('/user/repos?')) return Response.json([{ name: 'private-app', full_name: 'octocat/private-app', default_branch: 'production', private: true }]);
    if (url.includes('/repos/')) return Response.json({ name: 'private-app', full_name: 'octocat/private-app', default_branch: 'production', private: true });
    if (options.method === 'DELETE') return new Response(null, { status: 204 });
    throw new Error(`Unexpected fixture URL: ${url}`);
  };
  const filename = path.join(folder, 'github.json');
  const github = new GitHub({ filename, fetcher, resolveIdentity: token => token === 'panel-session' ? owner : null });
  github.configure({ clientId: 'fixtureClientId', clientSecret: SECRET, callbackUrl });
  const begin = () => new URL(github.authorize('panel-session', 'http://localhost:3000'));
  const connect = async () => github.callback({ state: begin().searchParams.get('state'), code: 'fixture-code' });
  return { github, calls, filename, folder, begin, connect };
}

test('GitHub OAuth binds state to the panel admin, uses PKCE, and never returns or persists plaintext tokens', async t => {
  const f = fixture(t);
  const url = f.begin();
  assert.equal(url.origin, 'https://github.com');
  assert.equal(url.searchParams.get('scope'), 'repo');
  assert.equal(url.searchParams.get('redirect_uri'), callbackUrl);
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  const status = await f.github.callback({ state: url.searchParams.get('state'), code: 'fixture-code' });
  assert.equal(status.account.login, 'octocat');
  assert.equal(status.connected, true);
  const parameters = JSON.parse(f.calls[0].options.body);
  assert.equal(crypto.createHash('sha256').update(parameters.code_verifier).digest('base64url'), url.searchParams.get('code_challenge'));
  assert.equal(parameters.redirect_uri, callbackUrl);
  const persisted = fs.readFileSync(f.filename, 'utf8');
  assert.equal(persisted.includes(TOKEN), false);
  assert.equal(persisted.includes(SECRET), false);
  assert.equal(JSON.stringify(status).includes(TOKEN), false);
  await assert.rejects(f.github.callback({ state: url.searchParams.get('state'), code: 'replayed' }), /already been used/);
});

test('OAuth rejects forged, expired, cancelled, wrong-origin and revoked-session authorizations', async t => {
  const f = fixture(t);
  assert.throws(() => f.github.authorize('viewer-session', 'http://localhost:3000'), /Administrator/);
  assert.throws(() => f.github.authorize('panel-session', 'https://evil.invalid'), /origin/);
  await assert.rejects(f.github.callback({ state: 'forged-state', code: 'x' }), /expired/);
  let state = f.begin().searchParams.get('state');
  f.github.pending.get(state).expiresAt = 0;
  await assert.rejects(f.github.callback({ state, code: 'x' }), /expired/);
  state = f.begin().searchParams.get('state');
  await assert.rejects(f.github.callback({ state, error: 'access_denied' }), /cancelled/);
  state = f.begin().searchParams.get('state');
  f.github.resolveIdentity = () => null;
  await assert.rejects(f.github.callback({ state, code: 'x' }), /no longer valid/);
  assert.equal(f.calls.length, 0);
});

test('repository discovery is paginated and deployment tokens are bound to the authorized account', async t => {
  const f = fixture(t); await f.connect();
  const data = await f.github.repositories(2);
  assert.equal(data.repositories[0].fullName, 'octocat/private-app');
  assert.equal(data.repositories[0].private, true);
  assert.equal(data.page, 2);
  assert.match(f.calls.at(-1).url, /page=2/);
  assert.equal((await f.github.repository('octocat/private-app')).cloneUrl, 'https://github.com/octocat/private-app.git');
  await assert.rejects(f.github.repository('../anything'), /valid GitHub/);
  assert.equal(await f.github.token(7), TOKEN);
  await assert.rejects(f.github.token(8), /account used/);
  assert.equal((await f.github.disconnect('owner')).revoked, true);
  assert.equal(f.github.status().connected, false);
  await assert.rejects(f.github.token(7), /Authorize/);
});

test('expired access tokens refresh once for concurrent requests', async t => {
  let refreshes = 0;
  const f = fixture(t, async (url, options) => {
    if (url.endsWith('/access_token')) {
      const parameters = JSON.parse(options.body);
      if (parameters.grant_type === 'refresh_token') { refreshes++; return Response.json({ access_token: 'gho_refreshed_token_123456', refresh_token: 'ghr_rotated_token_123456', expires_in: 28800 }); }
      return Response.json({ access_token: TOKEN, refresh_token: 'ghr_refresh_token_123456', expires_in: 28800 });
    }
    return Response.json({ id: 7, login: 'octocat' });
  });
  await f.connect();
  f.github.state.data.connection.expiresAt = 1;
  const tokens = await Promise.all([f.github.token(7), f.github.token(7)]);
  assert.deepEqual(tokens, ['gho_refreshed_token_123456', 'gho_refreshed_token_123456']);
  assert.equal(refreshes, 1);
  assert.equal(fs.readFileSync(f.filename, 'utf8').includes('gho_refreshed_token'), false);
});

test('changing OAuth settings during callback prevents a stale connection from being saved', async t => {
  const f = fixture(t);
  const originalFetch = f.github.fetcher;
  f.github.fetcher = async (url, options) => {
    if (url.endsWith('/user')) f.github.configure({ clientId: 'differentClientId', clientSecret: SECRET, callbackUrl });
    return originalFetch(url, options);
  };
  await assert.rejects(f.connect(), /connection changed/);
  assert.equal(f.github.status().connected, false);
});

test('OAuth deployment sends credentials through SSH stdin, redacts output, and stores only the account binding', async t => {
  const f = fixture(t); await f.connect();
  const commands = [];
  const operations = new Operations({ github: f.github, filename: path.join(f.folder, 'operations.json'), root: '/var/backups/serverops', store: { config: { servers: [{ id: 'a', name: 'A', isReal: true }] } }, audit: { record() {} }, ssh: { execCommand: async (node, command, options) => { commands.push({ command, options }); return { code: 0, stdout: TOKEN, stderr: '' }; } } });
  const project = operations.addProject('a', { name: 'Private app', repository: 'https://github.com/octocat/private-app.git', branch: 'main', directory: '/srv/app', processName: 'app', githubAccountId: 7 });
  const run = operations.deploy('a', project.id, 'owner');
  await operations.pending.get(run.id);
  assert.equal(run.status, 'success');
  assert.equal(commands[0].options.input, TOKEN + '\n');
  assert.equal(commands[0].command.includes(TOKEN), false);
  assert.match(commands[0].command, /GIT_ASKPASS/);
  assert.equal(run.log.includes(TOKEN), false);
  assert.equal(fs.readFileSync(path.join(f.folder, 'operations.json'), 'utf8').includes(TOKEN), false);
});

test('GitHub HTTP routes require admin access while the callback accepts only a valid one-time state', async t => {
  const f = fixture(t);
  const app = express(); app.use(express.json());
  app.get(CALLBACK, callbackRoute({ github: f.github, security }));
  app.use((req, res, next) => { req.panelRole = req.get('role') || 'viewer'; req.panelUser = owner; next(); });
  app.use('/api', githubRouter({ github: f.github, security }));
  const server = await new Promise(resolve => { const running = app.listen(0, '127.0.0.1', () => resolve(running)); });
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  assert.equal((await fetch(base + '/api/github/status')).status, 403);
  const status = await (await fetch(base + '/api/github/status', { headers: { role: 'admin' } })).json();
  assert.equal(status.configured, true);
  assert.equal(status.clientSecret, undefined);
  assert.equal((await fetch(base + CALLBACK + '?state=forged&code=x')).status, 400);
  const url = f.begin();
  const result = await fetch(base + CALLBACK + '?state=' + url.searchParams.get('state') + '&code=code', { redirect: 'manual' });
  assert.equal(result.status, 303);
  assert.equal(result.headers.get('location'), '/?github=connected');
});
