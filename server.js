
const { loadEnv } = require('./lib/env');

loadEnv();

const express = require('express');
const http = require('http');
const path = require('path');
const cors = require('cors');

const security = require('./lib/security');
const store = require('./lib/configStore');
const audit = require('./lib/audit');
const history = require('./lib/metricsHistory');
const monitor = require('./lib/monitor');
const attachTerminal = require('./lib/terminal');
const ssh = require('./sshService');
const access = require('./lib/access');
const { Accounts } = require('./lib/accounts');
const { Operations } = require('./lib/operations');
const { GitHub } = require('./lib/github');
const { githubRouter, callbackRoute, CALLBACK } = require('./routes/github');

store.load();
history.start();

ssh.onHostKeyLearned = () => store.save();

const accounts = new Accounts();
security.setIdentityResolver(token => accounts.resolve(token));
const github = new GitHub({ audit });
const operations = new Operations({ store, ssh, audit, github });
const ctx = { store, ssh, security, audit, history, monitor, accounts, operations, github };

const PORT = parseInt(process.env.PORT, 10) || 3000;
const HOST = process.env.HOST || '0.0.0.0';

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', process.env.TRUST_PROXY === 'true' ? 1 : false);

app.use(security.securityHeaders);
app.use(cors(security.corsOptions()));
app.use(express.json({ limit: '4mb' }));



app.use(express.static(path.join(__dirname, 'public'), { index: 'index.html', maxAge: 0 }));


const apiLimiter = security.createRateLimiter({ windowMs: 60_000, max: 300, name: 'api' });
const execLimiter = security.createRateLimiter({ windowMs: 60_000, max: 40, name: 'exec' });

app.use('/api', apiLimiter);

app.get(CALLBACK, callbackRoute(ctx));
const loginLimiter = security.createRateLimiter({ windowMs: 15 * 60_000, max: 20, name: 'login' });
app.post('/api/auth/login', loginLimiter, async (req, res) => {
  try {
    if (!process.env.PANEL_TOKEN || process.env.PANEL_TOKEN.trim().length < security.MIN_TOKEN_LENGTH) throw security.httpError(503, 'Configure PANEL_TOKEN before signing in');
    const requestedUsername = String(req.body?.username || '').trim().toLowerCase();
    const requestedPassword = String(req.body?.password || '');
    const envUsername = String(process.env.PANEL_USERNAME || '').trim().toLowerCase();
    const envPassword = String(process.env.PANEL_PASSWORD || '');
    
    if (envUsername && envPassword && requestedUsername === envUsername && requestedPassword === envPassword) {
      const serverIds = store.config.servers.map(s => s.id);
      const existing = accounts.list().find(u => u.username === envUsername);
      if (!existing) {
        await accounts.create({ username: envUsername, password: envPassword, role: 'admin', serverIds, permissions: [] }, serverIds);
      } else {
        await accounts.update(existing.id, { role: 'admin', serverIds, permissions: [], password: envPassword }, serverIds);
      }
    }
    const session = await accounts.login(req.body?.username, req.body?.password);
    audit.record({ type: 'auth', action: 'login', actor: session.user.username, ip: req.ip, status: 'success' });
    res.json({ success: true, ...session });
  } catch (err) {
    audit.record({ type: 'auth', action: 'login', ip: req.ip, status: 'failed' });
    security.sendError(res, err, 'login');
  }
});
app.use('/api', security.requireAuth);
app.use('/api', access.middleware(store));
app.use('/api', audit.middleware(() => store.getActiveServer().name));
app.use([
  '/api/pm2/action',
  '/api/files/delete',
  '/api/files/write',
  '/api/infra',
  '/api/operations',
  '/api/github',
  '/api/users',
  '/api/copilot'
], (req, res, next) => (req.method === 'GET' ? next() : execLimiter(req, res, next)));


app.get('/api/auth/verify', (req, res) => {
  res.json({ success: true, authenticated: true, role: req.panelRole, user: req.panelUser });
});

app.use('/api', require('./routes/servers')(ctx));
app.use('/api', require('./routes/metrics')(ctx));
app.use('/api', require('./routes/files')(ctx));
app.use('/api', require('./routes/copilot')(ctx));
app.use('/api', require('./routes/alerts')(ctx));
app.use('/api', require('./routes/infra')(ctx));
app.use('/api', require('./routes/accounts')(ctx));
app.use('/api', require('./routes/operations')(ctx));
app.use('/api', githubRouter(ctx));

app.use('/api', (req, res) => res.status(404).json({ success: false, error: 'Not found' }));


app.use((err, req, res, next) => {
  if (err && err.type === 'entity.parse.failed') return res.status(400).json({ success: false, error: 'Invalid JSON body' });
  if (err && err.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ success: false, error: 'File too large (max 100MB)' });
  return security.sendError(res, err, 'unhandled');
});

const server = http.createServer(app);
attachTerminal(server, ctx);
monitor.start();
operations.startScheduler();

function shutdown() {
  operations.stopScheduler();
  history.flush();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

server.listen(PORT, HOST, () => {
  console.log(`ServerOps running on http://localhost:${PORT}`);
  if (!process.env.PANEL_TOKEN || process.env.PANEL_TOKEN.length < security.MIN_TOKEN_LENGTH) {
    console.warn('⚠️  PANEL_TOKEN is not set: the API will refuse every request. Run "npm run setup".');
  }
});
