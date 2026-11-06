
const { WebSocketServer, WebSocket } = require('ws');
const security = require('./security');
const { canAccessServer } = require('./accounts');
const { demoMetrics, toPulse } = require('../routes/metrics');

const PULSE_INTERVAL_MS = 2500;
const MAX_MESSAGE_BYTES = 64 * 1024;

module.exports = function attachTerminal(server, { store, ssh, history, audit }) {
  const wss = new WebSocketServer({ server, maxPayload: MAX_MESSAGE_BYTES });

  wss.on('connection', async (ws, req) => {
    const ip = req.socket.remoteAddress;
    if (!security.isAuthorized(req)) {
      try {
        ws.send(JSON.stringify({ type: 'error', message: 'Unauthorized: invalid or missing panel token.' }));
      } catch (_) {  }
      ws.close(4401, 'Unauthorized');
      return;
    }

    const user = req.panelUser;
    const selectedId = new URL(req.url, 'http://localhost').searchParams.get('serverId');
    const available = user.role === 'admin' ? store.config.servers : store.config.servers.filter(s => canAccessServer(user, s.id));
    const srv = selectedId ? available.find(s => s.id === selectedId) : available[0] || (user.role === 'admin' ? store.getActiveServer() : null);
    if (!srv) { ws.close(4403, 'Server access denied'); return; }
    let openedAt = 0;
    
    const markUsed = () => {
      if (openedAt) return;
      openedAt = Date.now();
      audit.record({ type: 'terminal', action: 'open', ip, server: srv.name, serverId: srv.id, role: user.role, actor: user.username });
    };

    ws.send(JSON.stringify({
      type: 'banner',
      message: `SSH Shell Session [${srv.isReal ? 'LIVE SSH' : 'DEMO MODE'}: ${srv.username || 'root'}@${srv.isReal ? srv.host : 'demo'}]`
    }));

    const pulse = setInterval(async () => {
      if (ws.readyState !== WebSocket.OPEN) return;
      if (!security.isAuthorized(req) || (req.panelUser.role !== 'admin' && !canAccessServer(req.panelUser, srv.id))) { ws.close(4401, 'Session expired or access revoked'); return; }
      const active = srv;
      let m;
      if (active.isReal) {
        try {
          m = await ssh.getLiveMetrics(active);
        } catch (_) { return; }
      } else {
        m = demoMetrics(active);
      }
      history.record(active.id, m);
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'metrics_pulse', data: toPulse(m) }));
    }, PULSE_INTERVAL_MS);

    let pty = null;
    ws.once('close', () => {
      clearInterval(pulse);
      if (pty) {
        try { pty.end(); } catch (_) { /* already closed */ }
      }
      if (openedAt) {
        audit.record({ type: 'terminal', action: 'close', ip, server: srv.name, serverId: srv.id, role: user.role, actor: user.username, detail: { seconds: String(Math.round((Date.now() - openedAt) / 1000)) } });
      }
    });
    if (srv.isReal) {
      try {
        pty = await ssh.openShell(srv, ws, { rows: 32, cols: 110 });
        if (ws.readyState !== WebSocket.OPEN) { pty.end(); return; }
      } catch (err) {
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'pty_data', data: `\r\n\x1b[31m[SSH] ${security.redactOutput(err.message)}\x1b[0m\r\n` }));
      }
    }

    const writeToShell = text => {
      markUsed();
      if (pty && !pty.destroyed) {
        pty.write(text);
        return;
      }
      // Demo mode: echo locally so the terminal still feels interactive.
      if (ws.readyState === WebSocket.OPEN) {
        const shown = text.replace(/\r/g, '\r\n').replace(/\x7f/g, '\b \b');
        ws.send(JSON.stringify({ type: 'pty_data', data: shown }));
        if (/[\r\n]/.test(text)) ws.send(JSON.stringify({ type: 'pty_data', data: '\x1b[2m(demo mode: add a real server in Settings to run commands)\x1b[0m\r\n$ ' }));
      }
    };

    ws.on('message', raw => {
      if (!security.isAuthorized(req) || (req.panelUser.role !== 'admin' && !canAccessServer(req.panelUser, srv.id))) { ws.close(4401, 'Access revoked'); return; }
      let payload;
      try {
        payload = JSON.parse(raw.toString());
      } catch (_) {
        writeToShell(`${raw.toString().trim()}\n`);
        return;
      }

      if (payload.type === 'pty_input' && typeof payload.data === 'string') {
        writeToShell(payload.data);
      } else if (payload.type === 'pty_resize') {
        const rows = Math.min(500, Math.max(5, parseInt(payload.rows, 10) || 30));
        const cols = Math.min(500, Math.max(10, parseInt(payload.cols, 10) || 100));
        if (pty && !pty.destroyed && pty.setWindow) {
          try { pty.setWindow(rows, cols, 0, 0); } catch (_) { /* resize is best effort */ }
        }
      } else if (payload.type === 'execute' && typeof payload.command === 'string') {
        writeToShell(`${payload.command.trim()}\n`);
      }
    });

  });

  return wss;
};
