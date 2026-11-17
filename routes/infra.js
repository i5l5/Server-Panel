
const express = require('express');

const NGINX_COMMANDS = Object.freeze({
  test: 'nginx -t',
  reload: 'systemctl reload nginx',
  restart: 'systemctl restart nginx',
  status: 'systemctl status nginx --no-pager'
});


const OVERVIEW_SCRIPT = [
  'echo "@@DOCKER"; docker -v 2>/dev/null || echo NOT_INSTALLED',
  'echo "@@PS"; docker ps -a --format "{{json .}}" 2>/dev/null',
  'echo "@@NGINX"; nginx -v 2>&1 || echo NOT_INSTALLED',
  'echo "@@NGINX_ACTIVE"; systemctl is-active nginx 2>/dev/null || echo inactive',
  'echo "@@SITES"; ls -1 /etc/nginx/sites-enabled/ 2>/dev/null',
  'echo "@@CERTBOT"; certbot --version 2>/dev/null || echo NOT_INSTALLED',
  'echo "@@END"'
].join('; ');

function parseSections(stdout) {
  const sections = {};
  let current = null;
  for (const line of String(stdout).split('\n')) {
    const marker = line.match(/^@@(\w+)$/);
    if (marker) { current = marker[1]; sections[current] = []; continue; }
    if (current) sections[current].push(line);
  }
  const get = key => (sections[key] || []).join('\n').trim();
  return { get, lines: key => (sections[key] || []).map(l => l.trim()).filter(Boolean) };
}

function parseOverview(stdout) {
  const s = parseSections(stdout);
  const dockerVersion = s.get('DOCKER');
  const hasDocker = Boolean(dockerVersion) && !dockerVersion.includes('NOT_INSTALLED');
  const containers = [];
  for (const line of s.lines('PS')) {
    try {
      const c = JSON.parse(line);
      containers.push({ id: c.ID || c.Names, name: c.Names || 'container', image: c.Image || 'unknown', status: c.Status || 'unknown', state: c.State || '', ports: c.Ports || '--' });
    } catch (_) {  }
  }
  const nginxVersion = s.get('NGINX');
  const hasNginx = nginxVersion.includes('nginx version');
  const certbot = s.get('CERTBOT');
  return {
    docker: { installed: hasDocker, version: hasDocker ? dockerVersion : '', containers },
    nginx: { installed: hasNginx, version: hasNginx ? nginxVersion : '', status: s.get('NGINX_ACTIVE') === 'active' ? 'active' : 'inactive', sites: hasNginx ? s.lines('SITES') : [] },
    ssl: { installed: Boolean(certbot) && !certbot.includes('NOT_INSTALLED'), version: certbot.includes('NOT_INSTALLED') ? '' : certbot }
  };
}

module.exports = function infraRouter({ store, ssh, security }) {
  const router = express.Router();

  router.get('/infra/overview', async (req, res) => {
    const srv = store.getActiveServer();
    if (srv.isReal) {
      try {
        const out = await ssh.execCommand(srv, OVERVIEW_SCRIPT);
        return res.json({ success: true, isReal: true, ...parseOverview(out.stdout) });
      } catch (err) {
        return security.sendError(res, err, 'infra overview');
      }
    }

    res.json({
      success: true,
      isReal: false,
      docker: {
        installed: true,
        version: 'Docker version 26.1.3 (demo)',
        containers: [
          { id: 'c7e94a81b', name: 'redis-cache', image: 'redis:alpine', status: 'Up 4 days', state: 'running', ports: '6379/tcp' },
          { id: 'f8103c20e', name: 'postgres-db', image: 'postgres:15', status: 'Up 5 days', state: 'running', ports: '5432/tcp' }
        ]
      },
      nginx: { installed: true, version: 'nginx/1.24 (demo)', status: 'active', sites: ['default', 'api.example.com'] },
      ssl: { installed: true, version: 'certbot 2.9.0 (demo)' }
    });
  });

  router.post('/infra/docker/action', async (req, res) => {
    const { containerId, action } = req.body || {};
    let cmd;
    try {
      cmd = security.dockerCommand(action, containerId);
    } catch (err) {
      return security.sendError(res, err, 'docker action', 400);
    }

    const srv = store.getActiveServer();
    if (!srv.isReal) return res.json({ success: true, message: `Container ${containerId} ${action} (demo)` });
    try {
      const out = await ssh.execCommand(srv, cmd);
      if (out.code !== 0) throw security.httpError(500, out.stderr || 'docker command failed');
      res.json({ success: true, message: `Docker ${action} executed`, output: security.redactOutput(out.stdout) });
    } catch (err) {
      security.sendError(res, err, 'docker action');
    }
  });

  router.post('/infra/nginx/action', async (req, res) => {
    const action = String((req.body && req.body.action) || 'test');
    const cmd = NGINX_COMMANDS[action];
    if (!cmd) return res.status(400).json({ success: false, error: 'Invalid nginx action' });

    const srv = store.getActiveServer();
    if (!srv.isReal) return res.json({ success: true, message: `Nginx ${action} completed (demo)`, output: 'nginx: configuration file test is successful (demo)' });
    try {
      const out = await ssh.execCommand(srv, `${cmd} 2>&1`);
      res.json({ success: out.code === 0, message: `Nginx ${action} ${out.code === 0 ? 'completed' : 'failed'}`, output: security.redactOutput(out.stdout) });
    } catch (err) {
      security.sendError(res, err, 'nginx action');
    }
  });

  router.post('/infra/ssl/issue', async (req, res) => {
    const { domain, email } = req.body || {};
    let safeDomain;
    let emailFlag;
    try {
      safeDomain = security.assertDomain(domain);
      emailFlag = email ? `-m ${security.shellQuote(security.assertEmail(email))}` : '--register-unsafely-without-email';
    } catch (err) {
      return security.sendError(res, err, 'ssl issue', 400);
    }

    const srv = store.getActiveServer();
    if (!srv.isReal) return res.json({ success: true, message: `SSL issued for ${safeDomain} (demo)` });
    try {
      const out = await ssh.execCommand(srv, `certbot --nginx -d ${security.shellQuote(safeDomain)} --non-interactive --agree-tos ${emailFlag} 2>&1`);
      res.json({ success: out.code === 0, message: out.code === 0 ? 'Certificate issued' : 'Certbot failed', output: security.redactOutput(out.stdout) });
    } catch (err) {
      security.sendError(res, err, 'ssl issue');
    }
  });

  return router;
};

module.exports.parseOverview = parseOverview;
