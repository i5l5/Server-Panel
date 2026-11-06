
const crypto = require('crypto');
const path = require('path');




function httpError(statusCode, message) {
  const err = new Error(message);
  err.statusCode = statusCode;
  return err;
}


function sendError(res, err, context, fallbackStatus = 500) {
  const status = Number(err && err.statusCode) || fallbackStatus;
  const message = redactOutput((err && err.message) || 'Unexpected error');
  if (status >= 500) console.error(`[${context}]`, message);
  if (res.headersSent) return undefined;
  return res.status(status).json({ success: false, error: message });
}




const CDN_HOSTS = 'https://cdn.jsdelivr.net https://cdnjs.cloudflare.com';

const CSP = [
  "default-src 'self'",
  
  `script-src 'self' 'unsafe-inline' 'unsafe-eval' ${CDN_HOSTS}`,
  `style-src 'self' 'unsafe-inline' https://fonts.googleapis.com ${CDN_HOSTS}`,
  `font-src 'self' data: https://fonts.gstatic.com ${CDN_HOSTS}`,
  "img-src 'self' data: blob:",
  `connect-src 'self' ws: wss: ${CDN_HOSTS}`,
  "worker-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'"
].join('; ');

function securityHeaders(req, res, next) {
  res.setHeader('Content-Security-Policy', CSP);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  if (req.secure) {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
  if (req.path.startsWith('/api/')) res.setHeader('Cache-Control', 'no-store');
  next();
}

function allowedOrigins() {
  return String(process.env.PANEL_ORIGINS || '')
    .split(',')
    .map(o => o.trim().replace(/\/+$/, ''))
    .filter(Boolean);
}


function corsOptions() {
  const origins = allowedOrigins();
  return {
    origin: origins.length ? origins : false,
    credentials: false,
    allowedHeaders: ['Content-Type', 'X-Panel-Token', 'X-Server-Id'],
    methods: ['GET', 'POST', 'DELETE']
  };
}


function createRateLimiter({ windowMs = 60_000, max = 100, name = 'default' } = {}) {
  const hits = new Map();
  const sweeper = setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of hits) {
      if (entry.resetAt <= now) hits.delete(key);
    }
  }, windowMs);
  if (sweeper.unref) sweeper.unref();

  return function rateLimit(req, res, next) {
    const key = req.ip || (req.socket && req.socket.remoteAddress) || 'unknown';
    const now = Date.now();
    let entry = hits.get(key);
    if (!entry || entry.resetAt <= now) {
      entry = { count: 0, resetAt: now + windowMs };
      hits.set(key, entry);
    }
    entry.count += 1;
    res.setHeader('X-RateLimit-Limit', String(max));
    res.setHeader('X-RateLimit-Remaining', String(Math.max(0, max - entry.count)));
    if (entry.count > max) {
      res.setHeader('Retry-After', String(Math.ceil((entry.resetAt - now) / 1000)));
      return res.status(429).json({ success: false, error: `Too many requests (${name}). Try again shortly.` });
    }
    return next();
  };
}




const MIN_TOKEN_LENGTH = 16;
let identityResolver = () => null;
function setIdentityResolver(resolver) { identityResolver = resolver; }
function identityForToken(token) {
  const role = roleForToken(token);
  return role ? { id: `token-${role}`, username: role === 'admin' ? 'owner' : 'legacy-viewer', role, serverIds: [], permissions: [], legacy: true } : identityResolver(token);
}

function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

function configuredToken(name) {
  const value = String(process.env[name] || '').trim();
  return value.length >= MIN_TOKEN_LENGTH ? value : '';
}


function roleForToken(token) {
  if (!token) return null;
  const admin = configuredToken('PANEL_TOKEN');
  const viewer = configuredToken('PANEL_VIEWER_TOKEN');
  if (admin && safeEqual(token, admin)) return 'admin';
  if (viewer && safeEqual(token, viewer)) return 'viewer';
  return null;
}

function tokenFromQuery(rawUrl) {
  try {
    return new URL(rawUrl || '/', 'http://localhost').searchParams.get('token') || '';
  } catch (_) {
    return '';
  }
}


const VIEWER_DENIED_GET = ['/api/files/download', '/api/audit'];

function requireAuth(req, res, next) {
  if (!configuredToken('PANEL_TOKEN')) {
    return res.status(503).json({
      success: false,
      error: `PANEL_TOKEN is not configured (min ${MIN_TOKEN_LENGTH} chars). Run "npm run setup".`
    });
  }

  let token = String(req.get('X-Panel-Token') || '').trim();
  
  if (!token && req.method === 'GET' && req.originalUrl.startsWith('/api/files/download')) {
    token = tokenFromQuery(req.originalUrl);
  }

  const user = identityForToken(token);
  if (!user) return res.status(401).json({ success: false, error: 'Unauthorized: invalid or missing panel token.' });
  const role = user.role;

  if (role === 'viewer' && user.legacy) {
    const p = req.originalUrl.split('?')[0];
    if (req.method !== 'GET' || VIEWER_DENIED_GET.some(d => p.startsWith(d))) {
      return res.status(403).json({ success: false, error: 'Read-only token: this action requires the admin token.' });
    }
  }

  req.panelRole = role;
  req.panelUser = user;
  return next();
}


function isAuthorized(req) {
  if (!configuredToken('PANEL_TOKEN')) return false;

  const origin = req.headers && req.headers.origin;
  if (origin) {
    const host = req.headers.host;
    const sameOrigin = origin === `http://${host}` || origin === `https://${host}`;
    if (!sameOrigin && !allowedOrigins().includes(origin.replace(/\/+$/, ''))) return false;
  }

  const token = tokenFromQuery(req.url) || String((req.headers && req.headers['x-panel-token']) || '');
  const user = identityForToken(token);
  const allowed = user && (user.role === 'admin' || (user.role === 'operator' && user.permissions.includes('terminal')));
  if (allowed) req.panelUser = user;
  return Boolean(allowed);
}




const knownSecrets = new Set();


function registerSecrets(values) {
  knownSecrets.clear();
  for (const v of values || []) {
    if (typeof v === 'string' && v.length >= 6) knownSecrets.add(v);
  }
}

const REDACT_PATTERNS = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '[REDACTED PRIVATE KEY]'],
  [/\b(password|passwd|pass|pwd|secret|token|api[_-]?key|authorization)(\s*[=:]\s*)("[^"]*"|'[^']*'|\S+)/gi, '$1$2[REDACTED]'],
  [/\bBearer\s+[A-Za-z0-9._~+/-]+=*/g, 'Bearer [REDACTED]'],
  [/\bbot\d{6,15}:[A-Za-z0-9_-]{30,60}/g, 'bot[REDACTED]'],
  [/https:\/\/(?:discord|discordapp)\.com\/api\/webhooks\/\S+/g, 'https://discord.com/api/webhooks/[REDACTED]']
];

const MAX_OUTPUT_CHARS = 200_000;

function redactOutput(text) {
  let out = String(text == null ? '' : text);
  if (out.length > MAX_OUTPUT_CHARS) out = out.slice(-MAX_OUTPUT_CHARS);
  for (const secret of knownSecrets) {
    if (out.includes(secret)) out = out.split(secret).join('[REDACTED]');
  }
  for (const [re, replacement] of REDACT_PATTERNS) out = out.replace(re, replacement);
  return out;
}

function maskSecret(value) {
  const s = String(value || '');
  if (!s) return '';
  if (s.length <= 12) return '••••••••';
  return `${s.slice(0, 4)}••••••••${s.slice(-4)}`;
}

const PUBLIC_SERVER_FIELDS = [
  'id', 'name', 'host', 'ipMasked', 'port', 'username', 'isReal', 'isCurrent', 'status',
  'uptime', 'cpuModel', 'cpuLoad', 'cpuPercent', 'memoryTotal', 'memoryUsed', 'memoryPercent',
  'storageTotal', 'storageFree', 'storagePercent', 'cacheMb', 'txKbps', 'rxMbps',
  'systemHealth', 'healthStatus', 'connectError', 'lastSeen'
];


function sanitizeServer(server) {
  if (!server) return null;
  const out = {};
  for (const key of PUBLIC_SERVER_FIELDS) {
    if (server[key] !== undefined) out[key] = server[key];
  }
  if (out.connectError) out.connectError = redactOutput(out.connectError);
  out.hasPassword = Boolean(server.password);
  out.hasPrivateKey = Boolean(server.privateKey);
  return out;
}

function sanitizeServers(servers) {
  return (servers || []).map(sanitizeServer);
}

// ==========================================
// Shell & input validation
// ==========================================

function shellQuote(value) {
  const s = String(value);
  if (s.includes('\0')) throw httpError(400, 'NUL bytes are not allowed');
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

const SAFE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._@:-]{0,127}$/;

function assertSafeName(value, label = 'name') {
  const s = String(value == null ? '' : value).trim();
  if (!SAFE_NAME_RE.test(s)) throw httpError(400, `Invalid ${label}`);
  return s;
}

function assertFileName(value) {
  const s = String(value == null ? '' : value);
  if (!s || s.length > 255 || s === '.' || s === '..' || /[/\\\0]/.test(s) || /[\r\n]/.test(s)) {
    throw httpError(400, 'Invalid file name');
  }
  return s;
}

const DOMAIN_RE = /^(?=.{4,253}$)(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,63}$/;
const EMAIL_RE = /^[A-Za-z0-9._%+-]{1,64}@(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,63}$/;

function assertDomain(value) {
  const s = String(value || '').trim().toLowerCase();
  if (!DOMAIN_RE.test(s)) throw httpError(400, 'Invalid domain name');
  return s;
}

function assertEmail(value) {
  const s = String(value || '').trim();
  if (s.length > 254 || !EMAIL_RE.test(s)) throw httpError(400, 'Invalid email address');
  return s;
}

// ==========================================
// Remote filesystem jail
// ==========================================
function fsRoot() {
  const root = String(process.env.PANEL_FS_ROOT || '').trim();
  if (!root) return '';
  const normalized = path.posix.normalize(root.replace(/\\/g, '/'));
  return normalized === '/' ? '' : normalized.replace(/\/+$/, '');
}

function assertInsideJail(p) {
  const root = fsRoot();
  if (root && p !== root && !p.startsWith(`${root}/`)) {
    throw httpError(403, `Path is outside the allowed root (${root})`);
  }
  return p;
}


function safeRemoteDir(value, fallback = '/root') {
  let raw = value === undefined || value === null || value === '' ? '' : value;
  if (raw !== '' && typeof raw !== 'string') throw httpError(400, 'Path must be a string');
  if (raw === '') raw = fsRoot() && !String(fallback).startsWith(fsRoot()) ? fsRoot() : fallback;
  if (raw.length > 4096 || raw.includes('\0') || /[\r\n]/.test(raw)) throw httpError(400, 'Invalid path');
  if (!raw.startsWith('/')) throw httpError(400, 'Path must be absolute');

  let normalized = path.posix.normalize(raw);
  if (normalized.length > 1) normalized = normalized.replace(/\/+$/, '');
  return assertInsideJail(normalized);
}


function safeRemotePath(dir, name, fallback = '/root') {
  const base = safeRemoteDir(dir, fallback);
  const file = assertFileName(name);
  const full = base === '/' ? `/${file}` : `${base}/${file}`;
  return assertInsideJail(full);
}

// ==========================================
// Whitelisted command builders
// ==========================================
const PM2_TARGET_ACTIONS = new Set(['start', 'stop', 'restart', 'reload', 'delete', 'flush', 'reset']);
const PM2_ALL_ACTIONS = { restart_all: 'pm2 restart all', reload_all: 'pm2 reload all', stop_all: 'pm2 stop all' };

function pm2Target(target) {
  if (typeof target === 'number' || /^\d{1,6}$/.test(String(target))) {
    const id = Number(target);
    if (!Number.isInteger(id) || id < 0) throw httpError(400, 'Invalid PM2 process id');
    return String(id);
  }
  return shellQuote(assertSafeName(target, 'process name'));
}

function pm2Command(action, target) {
  const a = String(action || '');
  if (PM2_ALL_ACTIONS[a]) return PM2_ALL_ACTIONS[a];
  if (!PM2_TARGET_ACTIONS.has(a)) throw httpError(400, 'Invalid PM2 action');
  if (target === undefined || target === null || target === '') throw httpError(400, 'PM2 target is required');
  return `pm2 ${a} ${pm2Target(target)}`;
}

function pm2LogsCommand(name, lines = 50) {
  const n = Math.min(1000, Math.max(1, parseInt(lines, 10) || 50));
  return `pm2 logs ${pm2Target(name)} --lines ${n} --nostream 2>&1`;
}

const DOCKER_ACTIONS = new Set(['start', 'stop', 'restart', 'pause', 'unpause', 'kill']);

function dockerCommand(action, containerId) {
  const a = String(action || '');
  if (!DOCKER_ACTIONS.has(a)) throw httpError(400, 'Invalid docker action');
  return `docker ${a} ${shellQuote(assertSafeName(containerId, 'container id'))}`;
}

module.exports = {
  httpError,
  sendError,
  securityHeaders,
  corsOptions,
  createRateLimiter,
  requireAuth,
  isAuthorized,
  roleForToken,
  registerSecrets,
  redactOutput,
  maskSecret,
  sanitizeServer,
  sanitizeServers,
  shellQuote,
  assertSafeName,
  assertFileName,
  assertDomain,
  assertEmail,
  safeRemoteDir,
  safeRemotePath,
  pm2Command,
  pm2LogsCommand,
  dockerCommand,
  MIN_TOKEN_LENGTH,
  setIdentityResolver,
  identityForToken
};
