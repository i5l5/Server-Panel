
const express = require('express');


function demoMetrics(srv) {
  const jitter = spread => (Math.random() - 0.5) * spread;
  const cpu = Math.max(2, Math.min(95, Math.round((srv.cpuPercent || 12) + jitter(6))));
  const ram = Math.max(5, Math.min(90, Math.round((srv.memoryPercent || 15) + jitter(2))));
  return {
    cpuPercent: cpu,
    memoryPercent: ram,
    storagePercent: srv.storagePercent || 18,
    systemHealth: Math.round(100 - (cpu * 0.4 + ram * 0.4)),
    healthStatus: 'Demo Mode',
    cacheMb: 1024,
    txKbps: +(Math.random() * 80 + 30).toFixed(1),
    rxMbps: +(Math.random() * 1.5 + 0.2).toFixed(2),
    cpuLoad: +(cpu / 100).toFixed(2)
  };
}

function toPulse(m) {
  return {
    cpu: m.cpuPercent,
    ram: m.memoryPercent,
    disk: m.storagePercent,
    health: m.systemHealth,
    healthStatus: m.healthStatus,
    cacheMb: m.cacheMb,
    txKbps: m.txKbps,
    rxMbps: m.rxMbps,
    cpuLoad: m.cpuLoad
  };
}

module.exports = function metricsRouter({ store, ssh, security, history, audit }) {
  const router = express.Router();

  
  async function currentMetrics(srv) {
    if (srv.isReal) {
      try {
        const live = await ssh.getLiveMetrics(srv);
        Object.assign(srv, live, { status: 'connected', lastSeen: new Date().toISOString(), connectError: undefined });
        history.record(srv.id, live);
        return { isReal: true, metrics: live };
      } catch (err) {
        srv.status = 'offline';
        srv.connectError = security.redactOutput(err.message);
      }
    }
    const demo = demoMetrics(srv);
    history.record(srv.id, demo);
    return { isReal: false, metrics: demo };
  }

  router.get('/metrics', async (req, res) => {
    const srv = store.getActiveServer();
    const { isReal, metrics } = await currentMetrics(srv);
    res.json({ success: true, server: security.sanitizeServer(srv), isReal, metrics: toPulse(metrics) });
  });

  router.get('/metrics/history', (req, res) => {
    const srv = store.getActiveServer();
    const range = Object.keys(history.RANGES).includes(req.query.range) ? req.query.range : '1h';
    res.json({ success: true, serverId: srv.id, range, points: history.get(srv.id, range) });
  });

  router.get('/pm2', async (req, res) => {
    const srv = store.getActiveServer();
    if (srv.isReal) {
      try {
        return res.json({ success: true, isReal: true, services: await ssh.getPm2List(srv) });
      } catch (err) {
        console.warn('Real PM2 query error:', err.message);
      }
    }
    res.json({ success: true, isReal: false, services: [] });
  });

  router.post('/pm2/action', async (req, res) => {
    const { action, id, name } = req.body || {};
    const srv = store.getActiveServer();

    
    let command;
    try {
      command = security.pm2Command(action, id !== undefined && id !== null ? id : name);
    } catch (err) {
      return security.sendError(res, err, 'pm2 action', 400);
    }

    if (!srv.isReal) return res.json({ success: true, message: `Action ${action} executed (demo)`, services: [] });

    try {
      const out = await ssh.execCommand(srv, command);
      res.json({
        success: true,
        message: `Executed: ${command}`,
        output: security.redactOutput(out.stdout),
        services: await ssh.getPm2List(srv)
      });
    } catch (err) {
      security.sendError(res, err, 'pm2 action');
    }
  });

  
  router.get('/overview', async (req, res) => {
    const srv = store.getActiveServer();
    const [{ isReal, metrics }, pm2] = await Promise.all([
      currentMetrics(srv),
      srv.isReal ? ssh.getPm2List(srv).catch(() => []) : Promise.resolve([])
    ]);
    const servers = store.getVisibleServers();

    res.json({
      success: true,
      isReal,
      server: security.sanitizeServer(srv),
      metrics: toPulse(metrics),
      fleet: {
        total: servers.length,
        online: servers.filter(s => s.status === 'connected').length,
        offline: servers.filter(s => s.status === 'offline' || s.status === 'pending_auth').length
      },
      pm2: {
        total: pm2.length,
        online: pm2.filter(p => p.status === 'online').length,
        top: [...pm2].sort((a, b) => (b.memoryRawMb || 0) - (a.memoryRawMb || 0)).slice(0, 5)
      },
      alertsEnabled: Boolean(store.config.alerts.enabled),
      recentActivity: req.panelRole === 'admin' ? audit.list(6) : audit.list(500).filter(entry => entry.serverId === srv.id).slice(0, 6)
    });
  });

  router.get('/audit', (req, res) => {
    res.json({ success: true, entries: audit.list(req.query.limit) });
  });

  return router;
};

module.exports.demoMetrics = demoMetrics;
module.exports.toPulse = toPulse;
