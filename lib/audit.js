
const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const LOG_PATH = path.join(DATA_DIR, 'audit.log');
const MAX_BYTES = 5 * 1024 * 1024;
const RECENT_LIMIT = 500;

const recent = [];

function ensureDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function rotateIfNeeded() {
  try {
    if (fs.existsSync(LOG_PATH) && fs.statSync(LOG_PATH).size > MAX_BYTES) {
      fs.renameSync(LOG_PATH, `${LOG_PATH}.1`);
    }
  } catch (_) { /* rotation is best effort */ }
}

function loadRecent() {
  try {
    const lines = fs.readFileSync(LOG_PATH, 'utf8').trim().split('\n').slice(-RECENT_LIMIT);
    for (const line of lines) {
      try { recent.push(JSON.parse(line)); } catch (_) { /* skip corrupt line */ }
    }
  } catch (_) { /* no log yet */ }
}

function record(entry) {
  const item = { time: new Date().toISOString(), ...entry };
  recent.push(item);
  if (recent.length > RECENT_LIMIT) recent.shift();
  try {
    ensureDir();
    rotateIfNeeded();
    fs.appendFileSync(LOG_PATH, `${JSON.stringify(item)}\n`, { mode: 0o600 });
  } catch (err) {
    console.warn('Audit write failed:', err.message);
  }
  return item;
}

function list(limit = 100) {
  const n = Math.min(RECENT_LIMIT, Math.max(1, parseInt(limit, 10) || 100));
  return recent.slice(-n).reverse();
}

// Only these body fields are copied into the log; never contents, passwords or tokens.
const SAFE_BODY_FIELDS = ['action', 'id', 'name', 'path', 'oldName', 'newName', 'containerId', 'domain', 'eggId', 'serviceName'];

function describeBody(body) {
  if (!body || typeof body !== 'object') return undefined;
  const out = {};
  for (const key of SAFE_BODY_FIELDS) {
    if (body[key] !== undefined && body[key] !== null && body[key] !== '') {
      out[key] = String(body[key]).slice(0, 200);
    }
  }
  return Object.keys(out).length ? out : undefined;
}

/** Express middleware: logs every non-GET /api call once its response is sent. */
function middleware(getServerName) {
  return (req, res, next) => {
    if (req.method === 'GET' || req.method === 'OPTIONS' || req.path === '/auth/verify') return next();
    res.on('finish', () => {
      record({
        type: 'api',
        method: req.method,
        path: req.originalUrl.split('?')[0],
        status: res.statusCode,
        role: req.panelRole || 'anonymous',
        actor: req.panelUser?.username || 'anonymous',
        userId: req.panelUser?.id,
        serverId: req.auditServerId,
        ip: req.ip,
        server: req.auditServerName || getServerName(),
        detail: describeBody(req.body)
      });
    });
    return next();
  };
}

loadRecent();

module.exports = { record, list, middleware, describeBody, DATA_DIR };
