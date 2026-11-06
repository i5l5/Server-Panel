const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const express = require('express');
const { Accounts, allowedRequest, canAccessServer } = require('../lib/accounts');
const { Operations, backupScript, restoreScript, deployScript } = require('../lib/operations');
const access = require('../lib/access');
const security = require('../lib/security');

function fixture(t, handler) {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'serverops-test-'));
  t.after(() => {
    assert.equal(path.dirname(path.resolve(folder)), path.resolve(os.tmpdir()));
    fs.rmSync(folder, { recursive: true, force: true });
  });
  const nodes = [{ id: 'a', name: 'Alpha', isReal: true }, { id: 'b', name: 'Beta', isReal: true }];
  const store = { config: { servers: nodes, activeServerId: 'a', alerts: {} }, getActiveServer: () => access.activeServer() || nodes[0], getVisibleServers: () => access.visibleServers(nodes) };
  const commands = [];
  const ssh = { execCommand: async (node, cmd) => { commands.push({ node: node.id, cmd }); return handler ? handler(node, cmd) : { code: 0, stdout: 'CL_FROM=' + 'a'.repeat(40) + '\nCL_TO=' + 'b'.repeat(40), stderr: '' }; } };
  const entries = [];
  const audit = { record: entry => entries.push(entry) };
  const filename = path.join(folder, 'operations.json');
  const operations = new Operations({ store, ssh, audit, filename, root: '/var/backups/serverops' });
  const accounts = new Accounts(path.join(folder, 'accounts.json'));
  return { accounts, operations, store, ssh, audit, commands, entries, filename, folder };
}
const account = (overrides = {}) => ({ username: 'alice', password: 'correct-horse-42', role: 'operator', serverIds: ['a'], permissions: ['deploy', 'backup'], ...overrides });
const project = (overrides = {}) => ({ name: 'API', repository: 'git@github.com:team/api.git', branch: 'main', directory: '/srv/api', processName: 'api', install: true, build: true, ...overrides });
const plan = (overrides = {}) => ({ name: 'App files', kind: 'files', source: '/srv/data', schedule: 'daily', retention: 2, ...overrides });
async function complete(ops, run) { await ops.pending.get(run.id); return run; }

test('accounts hash passwords, reject bad logins and revoke sessions after access/password changes', async t => {
  const { accounts, folder } = fixture(t);
  const user = await accounts.create(account(), ['a', 'b']);
  assert.equal(user.passwordHash, undefined);
  assert.equal(fs.readFileSync(path.join(folder, 'accounts.json'), 'utf8').includes('correct-horse-42'), false);
  await assert.rejects(accounts.login('alice', 'wrong-password'), /Invalid username/);
  await assert.rejects(accounts.login('missing-user', 'wrong-password'), /Invalid username/);
  const session = await accounts.login('ALICE', 'correct-horse-42');
  assert.equal(accounts.resolve(session.token).username, 'alice');
  await accounts.update(user.id, account({ serverIds: ['b'], permissions: ['restore'], password: 'new-long-password-42' }), ['a', 'b']);
  assert.equal(accounts.resolve(session.token), null);
  await assert.rejects(accounts.login('alice', 'correct-horse-42'));
  const updated = await accounts.login('alice', 'new-long-password-42');
  assert.deepEqual(updated.user.serverIds, ['b']);
  accounts.remove(user.id);
  assert.equal(accounts.resolve(updated.token), null);
});

test('accounts validate server grants, roles and unique usernames', async t => {
  const { accounts } = fixture(t);
  await assert.rejects(accounts.create(account({ serverIds: ['other'] }), ['a']), /valid servers/);
  await assert.rejects(accounts.create(account({ permissions: ['owner'] }), ['a']), /permissions/);
  await assert.rejects(accounts.create(account({ role: 'root' }), ['a']), /role/);
  const results = await Promise.allSettled([accounts.create(account(), ['a']), accounts.create(account(), ['a'])]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  const session = await accounts.login('alice', 'correct-horse-42');
  accounts.sessions.values().next().value.expiresAt = Date.now() - 1;
  assert.equal(accounts.resolve(session.token), null);
});

test('permissions deny global settings and ungranted actions, including unrecognized routes', () => {
  const user = account();
  assert.equal(canAccessServer(user, 'b'), false);
  assert.equal(allowedRequest(user, 'POST', '/api/operations/deployments/id/run'), true);
  assert.equal(allowedRequest(user, 'POST', '/api/operations/runs/id/restore'), false);
  for (const route of ['/api/users', '/api/alerts/config', '/api/copilot/execute', '/api/new-feature']) assert.equal(allowedRequest(user, 'POST', route), false);
  assert.equal(allowedRequest(account({ role: 'viewer' }), 'POST', '/api/operations/backups/id/run'), false);
});

test('request server contexts stay isolated across concurrent asynchronous requests', async t => {
  const f = fixture(t);
  const app = express();
  app.use((req, res, next) => { req.panelUser = { role: 'admin', username: 'owner', legacy: true }; next(); });
  app.use(access.middleware(f.store));
  app.get('/api/metrics', async (req, res) => {
    await new Promise(resolve => setTimeout(resolve, req.get('X-Server-Id') === 'a' ? 30 : 2));
    res.json({ serverId: f.store.getActiveServer().id });
  });
  const server = await new Promise(resolve => { const listening = app.listen(0, '127.0.0.1', () => resolve(listening)); });
  t.after(() => new Promise(resolve => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}/api/metrics`;
  const responses = await Promise.all(['a', 'b', 'a', 'b'].map(id => fetch(url, { headers: { 'X-Server-Id': id } }).then(r => r.json())));
  assert.deepEqual(responses.map(r => r.serverId), ['a', 'b', 'a', 'b']);
  assert.equal(f.store.config.activeServerId, 'a');
});

test('HTTP endpoints enforce scoped servers and ownership of job IDs', async t => {
  const f = fixture(t);
  await f.accounts.create(account(), ['a', 'b']);
  const session = await f.accounts.login('alice', 'correct-horse-42');
  const aProject = f.operations.addProject('a', project());
  const bProject = f.operations.addProject('b', project());
  process.env.PANEL_TOKEN = 'test-owner-token-'.repeat(2);
  security.setIdentityResolver(token => f.accounts.resolve(token));
  t.after(() => { delete process.env.PANEL_TOKEN; security.setIdentityResolver(() => null); });
  const app = express(); app.use(express.json());
  app.use(security.requireAuth, access.middleware(f.store));
  const ctx = { ...f, security };
  app.use('/api', require('../routes/servers')(ctx));
  app.use('/api', require('../routes/accounts')(ctx));
  app.use('/api', require('../routes/operations')(ctx));
  const server = await new Promise(resolve => { const listening = app.listen(0, '127.0.0.1', () => resolve(listening)); });
  t.after(() => new Promise(resolve => server.close(resolve)));
  const request = (url, method = 'GET', body, node = 'a') => fetch(`http://127.0.0.1:${server.address().port}/api${url}`, { method, headers: { 'X-Panel-Token': session.token, 'X-Server-Id': node, 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const servers = await (await request('/servers')).json();
  assert.deepEqual(servers.servers.map(s => s.id), ['a']);
  assert.equal((await request('/operations', 'GET', null, 'b')).status, 403);
  assert.equal((await request('/users')).status, 403);
  assert.equal((await request(`/operations/deployments/${bProject.id}/run`, 'POST', {})).status, 404);
  assert.equal((await request('/operations/backups', 'POST', plan())).status, 403);
  const response = await request(`/operations/deployments/${aProject.id}/run`, 'POST', {});
  assert.equal(response.status, 202);
  await Promise.all(f.operations.pending.values());
  assert.equal(f.operations.list('a').runs[0].actor, 'alice');
  assert.equal(f.commands[0].node, 'a');
});

test('deployment records old and new commits, rollback uses the recorded commit, and failures stay visible', async t => {
  const f = fixture(t);
  const app = f.operations.addProject('a', project());
  const run = await complete(f.operations, f.operations.deploy('a', app.id, 'alice'));
  assert.equal(run.status, 'success');
  assert.equal(run.fromCommit, 'a'.repeat(40));
  assert.equal(run.toCommit, 'b'.repeat(40));
  await complete(f.operations, f.operations.deploy('a', app.id, 'alice', run.id));
  assert.ok(f.commands[1].cmd.includes('a'.repeat(40)));
  assert.equal(f.operations.list('a').runs[0].type, 'rollback');
  f.ssh.execCommand = async () => ({ code: 1, stdout: 'CL_FROM=' + 'b'.repeat(40), stderr: 'Build failed' });
  const failed = await complete(f.operations, f.operations.deploy('a', app.id, 'alice'));
  assert.equal(failed.status, 'failed');
  assert.match(failed.log, /Build failed/);
  assert.equal(failed.fromCommit, 'b'.repeat(40));
  assert.equal(f.operations.locks.size, 0);
  assert.equal(f.entries.at(-1).status, 'failed');
});

test('server operations lock across backup/deploy/restore and release after failures', async t => {
  let release;
  const f = fixture(t, () => new Promise(resolve => { release = resolve; }));
  const app = f.operations.addProject('a', project());
  const backupPlan = f.operations.addPlan('a', plan());
  const run = f.operations.deploy('a', app.id, 'owner');
  await Promise.resolve();
  assert.throws(() => f.operations.backup('a', backupPlan.id, 'owner'), /Another/);
  assert.throws(() => f.operations.remove('projects', app.id, 'a'), /Wait/);
  release({ code: 1, stdout: '', stderr: 'unavailable' });
  await complete(f.operations, run);
  assert.equal(f.operations.locks.size, 0);
});

test('backup retention preserves the latest copies and restore validates confirmation and server', async t => {
  const f = fixture(t, () => ({ code: 0, stdout: '2048', stderr: '' }));
  const backupPlan = f.operations.addPlan('a', plan());
  const first = await complete(f.operations, f.operations.backup('a', backupPlan.id, 'owner'));
  const second = await complete(f.operations, f.operations.backup('a', backupPlan.id, 'owner'));
  const third = await complete(f.operations, f.operations.backup('a', backupPlan.id, 'owner'));
  assert.equal(first.available, false);
  assert.equal(second.available, true);
  assert.equal(third.available, true);
  assert.equal(third.bytes, 2048);
  assert.throws(() => f.operations.restore('a', first.id, 'owner', first.name), /retained backup/);
  assert.throws(() => f.operations.restore('a', third.id, 'owner', 'wrong'), /confirm/);
  assert.throws(() => f.operations.restore('b', third.id, 'owner', third.name), /not found/);
  const restored = await complete(f.operations, f.operations.restore('a', third.id, 'owner', third.name));
  assert.equal(restored.status, 'success');
  assert.match(f.commands.at(-1).cmd, /sha256sum --check/);
  assert.match(f.commands.at(-1).cmd, /--no-same-owner/);
});

test('scheduler persists its next run, skips paused schedules, and restart marks incomplete jobs', async t => {
  const f = fixture(t);
  const backupPlan = f.operations.addPlan('a', plan());
  const due = Date.now() + 1000;
  backupPlan.nextRunAt = new Date(due - 1).toISOString();
  await f.operations.tick(due);
  await Promise.all(f.operations.pending.values());
  assert.equal(f.operations.list('a').runs.length, 1);
  assert.equal(f.operations.list('a').runs[0].actor, 'scheduler');
  assert.ok(new Date(backupPlan.nextRunAt).getTime() > due);
  f.operations.togglePlan(backupPlan.id, 'a');
  await f.operations.tick(due + 86400001);
  assert.equal(f.operations.list('a').runs.length, 1);
  f.operations.state.data.runs.push({ id: 'interrupted', serverId: 'a', status: 'running' });
  f.operations.state.save();
  const reloaded = new Operations({ ...f, filename: f.filename, root: '/var/backups/serverops' });
  assert.equal(reloaded.state.data.runs.at(-1).status, 'interrupted');
});

test('configuration rejects shell options, embedded GitHub credentials and overlapping storage paths', t => {
  const f = fixture(t);
  for (const value of ['https://user:password@github.com/team/api', 'https://other.example/team/api', '$(reboot)']) assert.throws(() => f.operations.addProject('a', project({ repository: value })));
  for (const branch of ['--upload-pack=evil', '../main', 'foo..bar']) assert.throws(() => f.operations.addProject('a', project({ branch })));
  assert.throws(() => f.operations.addPlan('a', plan({ source: '/var' })), /separate/);
  assert.throws(() => f.operations.addPlan('a', plan({ source: '/' })), /root/);
  assert.throws(() => f.operations.addPlan('a', plan({ kind: 'mysql', database: 'app' })), /defaults file/);
});

test('database backup commands never take inline passwords and restore verifies checksums first', () => {
  const mysql = { kind: 'mysql', database: 'app', username: 'root', host: 'localhost', port: 3306, credentialsFile: '/root/.my.cnf' };
  const pg = { ...mysql, kind: 'postgres', username: 'postgres', port: 5432, credentialsFile: '/root/.pgpass' };
  assert.match(backupScript(mysql, '/backups/a.sql', '/backups'), /mysqldump --defaults-extra-file=/);
  assert.match(backupScript(pg, '/backups/a.dump', '/backups'), /pg_dump --no-password/);
  assert.match(restoreScript(pg, '/backups/a.dump'), /^sha256sum.*\nPGPASSFILE=.*pg_restore/);
  assert.match(deployScript(project(), 'a'.repeat(40)), /checkout --detach/);
});

test('persistence failures do not start commands or advance a schedule', async t => {
  const f = fixture(t);
  const app = f.operations.addProject('a', project());
  const backupPlan = f.operations.addPlan('a', plan());
  backupPlan.nextRunAt = new Date(Date.now() - 1000).toISOString();
  const due = backupPlan.nextRunAt;
  f.operations.state.save = () => { throw new Error('disk full'); };
  assert.throws(() => f.operations.deploy('a', app.id, 'owner'), /disk full/);
  assert.equal(f.commands.length, 0);
  assert.equal(f.operations.locks.size, 0);
  assert.equal(f.operations.state.data.runs.length, 0);
  const log = console.error; console.error = () => {};
  try { await f.operations.tick(); } finally { console.error = log; }
  assert.equal(backupPlan.nextRunAt, due);
  assert.equal(f.commands.length, 0);
});

test('SSH terminal denies another server and revocation closes a granted session', async t => {
  const http = require('http');
  const { WebSocket } = require('ws');
  const f = fixture(t);
  const user = await f.accounts.create(account({ permissions: ['terminal'] }), ['a', 'b']);
  const session = await f.accounts.login(user.username, 'correct-horse-42');
  process.env.PANEL_TOKEN = 'terminal-test-owner-token-42';
  security.setIdentityResolver(token => f.accounts.resolve(token));
  t.after(() => { delete process.env.PANEL_TOKEN; security.setIdentityResolver(() => null); });
  let shellEnded = false;
  const opened = [];
  f.ssh.openShell = async node => { opened.push(node.id); return { write() {}, end() { shellEnded = true; } }; };
  f.ssh.getLiveMetrics = async () => ({});
  const server = http.createServer();
  const wss = require('../lib/terminal')(server, { ...f, history: { record() {} } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    for (const client of wss.clients) client.terminate();
    await new Promise(resolve => wss.close(resolve));
    await new Promise(resolve => server.close(resolve));
  });
  const url = id => `ws://127.0.0.1:${server.address().port}/?token=${session.token}&serverId=${id}`;
  const denied = new WebSocket(url('b'));
  assert.equal(await new Promise(resolve => denied.on('close', code => resolve(code))), 4403);
  assert.deepEqual(opened, []);
  const allowed = new WebSocket(url('a'));
  await new Promise(resolve => allowed.on('open', resolve));
  assert.deepEqual(opened, ['a']);
  f.accounts.logout(session.token);
  const closed = new Promise(resolve => allowed.on('close', code => resolve(code)));
  allowed.send(JSON.stringify({ type: 'pty_input', data: 'echo secret\n' }));
  assert.equal(await closed, 4401);
  assert.equal(shellEnded, true);
});
