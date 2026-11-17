const test = require('node:test');
const assert = require('node:assert/strict');

process.env.CONFIG_KEY = 'ab'.repeat(32); 

const secretBox = require('../lib/secretBox');
const history = require('../lib/metricsHistory');
const { evaluateAlerts } = require('../lib/monitor');
const { parseOverview } = require('../routes/infra');
const { extractCommands } = require('../routes/copilot');
const { SSHService, computeHealth } = require('../sshService');

test('secretBox round-trips and never stores plaintext', () => {
  const enc = secretBox.encrypt('R00t-Pa$$word');
  assert.ok(enc.startsWith('enc:v1:'));
  assert.ok(!enc.includes('R00t'));
  assert.equal(secretBox.decrypt(enc), 'R00t-Pa$$word');
  assert.notEqual(secretBox.encrypt('same'), secretBox.encrypt('same'), 'random IV per value');
  assert.equal(secretBox.decrypt('legacy-plain'), 'legacy-plain');
  assert.equal(secretBox.encrypt(''), '');
});

test('secretBox detects tampering', () => {
  const enc = secretBox.encrypt('value');
  const raw = Buffer.from(enc.slice(7), 'base64');
  raw[raw.length - 1] ^= 0xff;
  assert.throws(() => secretBox.decrypt(`enc:v1:${raw.toString('base64')}`));
});

test('metrics history throttles samples and downsamples long ranges', () => {
  history.reset();
  const t0 = Date.now() - 60 * 60e3;
  assert.equal(history.record('s1', { cpuPercent: 10, memoryPercent: 20, storagePercent: 30 }, t0), true);
  assert.equal(history.record('s1', { cpuPercent: 99 }, t0 + 1000), false, 'second sample within 15s is dropped');
  for (let i = 1; i <= 600; i++) history.record('s1', { cpuPercent: i % 100 }, t0 + i * 15_000);
  const points = history.get('s1', '24h', t0 + 601 * 15_000);
  assert.ok(points.length <= 240);
  assert.ok(points.length > 100);
  assert.deepEqual(history.get('missing', '1h'), []);
  history.reset();
});

test('evaluateAlerts fires for CPU, RAM, disk and stopped PM2 processes', () => {
  const server = { id: 's', name: 'web', host: '10.0.0.1' };
  const alerts = { cpuThreshold: 80, ramThreshold: 90, diskThreshold: 85, pm2Alerts: true };
  const quiet = evaluateAlerts(server, { cpuPercent: 10, memoryPercent: 10, storagePercent: 10 }, [{ name: 'a', status: 'online' }], alerts);
  assert.equal(quiet.length, 0);

  const loud = evaluateAlerts(server, { cpuPercent: 95, memoryPercent: 95, storagePercent: 90 }, [{ name: 'bot', status: 'errored' }], alerts);
  assert.deepEqual(loud.map(a => a.key).sort(), ['cpu_s', 'disk_s', 'pm2_bot_s', 'ram_s']);
});

test('parseOverview reads docker, nginx and certbot sections', () => {
  const out = [
    '@@DOCKER', 'Docker version 26.1.3, build b72afb3',
    '@@PS', '{"ID":"abc","Names":"redis","Image":"redis:alpine","Status":"Up 2 days","State":"running","Ports":"6379/tcp"}',
    '@@NGINX', 'nginx version: nginx/1.24.0',
    '@@NGINX_ACTIVE', 'active',
    '@@SITES', 'default', 'api.example.com',
    '@@CERTBOT', 'NOT_INSTALLED',
    '@@END'
  ].join('\n');
  const o = parseOverview(out);
  assert.equal(o.docker.installed, true);
  assert.equal(o.docker.containers[0].name, 'redis');
  assert.equal(o.nginx.status, 'active');
  assert.deepEqual(o.nginx.sites, ['default', 'api.example.com']);
  assert.equal(o.ssl.installed, false);
});

test('extractCommands pulls runnable lines from fenced bash blocks', () => {
  const text = 'Do this:\n```bash\n# comment\napt update\nsystemctl restart nginx\n```\nthen\n```\nuptime\n```';
  assert.deepEqual(extractCommands(text), ['apt update', 'systemctl restart nginx', 'uptime']);
  assert.deepEqual(extractCommands('no code here'), []);
});

test('network rates are derived from counter deltas, not random numbers', () => {
  const ssh = new SSHService();
  assert.deepEqual(ssh.networkRates('s', 1000, 1000, 0), { txKbps: 0, rxMbps: 0 });
  const r = ssh.networkRates('s', 1000 + 2 * 1024 * 1024, 1000 + 10 * 1024, 2000);
  assert.equal(r.rxMbps, 1);
  assert.equal(r.txKbps, 5);
  assert.deepEqual(ssh.networkRates('s', 0, 0, 3000), { txKbps: 0, rxMbps: 0 }, 'counter reset');
});

test('computeHealth stays within 0-100 and penalises a full disk', () => {
  assert.equal(computeHealth(0, 0, 10), 100);
  assert.ok(computeHealth(50, 50, 95) < computeHealth(50, 50, 50));
  assert.equal(computeHealth(100, 100, 100), 0);
});
