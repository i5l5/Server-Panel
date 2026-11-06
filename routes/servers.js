
const express = require('express');

const HOST_RE = /^(?:\d{1,3}(?:\.\d{1,3}){3}|[A-Fa-f0-9:]{2,45}|(?=.{1,253}$)[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*)$/;
const USER_RE = /^[A-Za-z0-9._-]{1,32}$/;

module.exports = function serversRouter({ store, ssh, security, history, operations }) {
  const router = express.Router();
  const { config } = store;

  router.get('/servers', (req, res) => {
    res.json({
      success: true,
      servers: security.sanitizeServers(store.getVisibleServers()),
      activeId: store.getActiveServer().id
    });
  });

  router.post('/servers', async (req, res) => {
    const { name, host, port, username, password, privateKey } = req.body || {};
    if (!name || !host) {
      return res.status(400).json({ success: false, error: 'Server name and host are required' });
    }
    if (typeof name !== 'string' || name.trim().length > 64 || /[<>\0\r\n]/.test(name)) {
      return res.status(400).json({ success: false, error: 'Invalid server name' });
    }
    if (typeof host !== 'string' || !HOST_RE.test(host.trim())) {
      return res.status(400).json({ success: false, error: 'Invalid host (IPv4, IPv6 or hostname expected)' });
    }
    const parsedPort = port === undefined || port === '' ? 22 : parseInt(port, 10);
    if (!Number.isInteger(parsedPort) || parsedPort < 1 || parsedPort > 65535) {
      return res.status(400).json({ success: false, error: 'Invalid SSH port' });
    }
    const user = username ? String(username).trim() : 'root';
    if (!USER_RE.test(user)) {
      return res.status(400).json({ success: false, error: 'Invalid SSH username' });
    }
    if ((password && typeof password !== 'string') || (privateKey && typeof privateKey !== 'string')) {
      return res.status(400).json({ success: false, error: 'Invalid credentials' });
    }
    if (privateKey && !/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(privateKey)) {
      return res.status(400).json({ success: false, error: 'Private key must be in PEM / OpenSSH format' });
    }

    const newServer = store.hydrateServer({
      id: `srv-${Date.now()}`,
      name: name.trim(),
      host: host.trim(),
      port: parsedPort,
      username: user,
      password: password || '',
      privateKey: privateKey || '',
      createdAt: new Date().toISOString()
    }, '');

    if (newServer.isReal) {
      try {
        Object.assign(newServer, await ssh.getLiveMetrics(newServer));
        newServer.status = 'connected';
        newServer.lastSeen = new Date().toISOString();
        history.record(newServer.id, newServer);
      } catch (err) {
        console.warn('Real SSH check failed, will connect on demand:', err.message);
        newServer.status = 'pending_auth';
        newServer.connectError = security.redactOutput(err.message);
      }
    }

    config.servers.push(newServer);
    store.setActiveServer(newServer.id);
    store.save();

    res.json({
      success: true,
      server: security.sanitizeServer(newServer),
      servers: security.sanitizeServers(config.servers)
    });
  });

  router.post('/servers/select', async (req, res) => {
    const { id } = req.body || {};
    const srv = store.getVisibleServers().find(s => s.id === id);
    if (!srv) return res.status(404).json({ success: false, error: 'Server not found' });

    // Selection belongs to this browser tab (X-Server-Id), never to other users.

    if (srv.isReal) {
      try {
        Object.assign(srv, await ssh.getLiveMetrics(srv));
        srv.status = 'connected';
        srv.connectError = undefined;
      } catch (err) {
        srv.status = 'offline';
        srv.connectError = security.redactOutput(err.message);
      }
    }

    res.json({ success: true, server: security.sanitizeServer(srv) });
  });

  router.delete('/servers/:id', (req, res) => {
    if (operations?.locks.has(req.params.id)) return res.status(409).json({ success: false, error: 'Wait for the server operation to finish before removing this server' });
    const idx = config.servers.findIndex(s => s.id === req.params.id);
    if (idx === -1) return res.status(404).json({ success: false, error: 'Server not found' });

    const [removed] = config.servers.splice(idx, 1);
    ssh.disconnect(removed.id);
    if (config.activeServerId === removed.id) {
      store.setActiveServer(config.servers[0] ? config.servers[0].id : '');
    }
    store.save();
    res.json({ success: true, servers: security.sanitizeServers(config.servers), activeId: config.activeServerId });
  });

  return router;
};
