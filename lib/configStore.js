
const fs = require('fs');
const path = require('path');
const secretBox = require('./secretBox');
const security = require('./security');

const CONFIG_PATH = path.join(__dirname, '..', 'config.json');

const PERSISTED_SERVER_FIELDS = ['id', 'name', 'host', 'port', 'username', 'password', 'privateKey', 'hostKeyFingerprint', 'createdAt'];
const SERVER_SECRETS = ['password', 'privateKey'];
const ALERT_SECRETS = ['discordWebhookUrl', 'telegramBotToken'];

const DEFAULT_ALERTS = {
  enabled: false,
  discordWebhookUrl: '',
  telegramBotToken: '',
  telegramChatId: '',
  cpuThreshold: 85,
  ramThreshold: 90,
  diskThreshold: 90,
  pm2Alerts: true
};

const config = {
  activeServerId: '',
  servers: [],
  alerts: { ...DEFAULT_ALERTS },
  geminiApiKey: ''
};

function maskHost(host) {
  const h = String(host || '');
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(h)) return `${h.split('.').slice(0, 2).join('.')}.*.*`;
  if (h.includes(':')) return `${h.split(':').slice(0, 2).join(':')}:…`;
  const labels = h.split('.');
  return labels.length > 2 ? `*.${labels.slice(-2).join('.')}` : h;
}


function hydrateServer(stored, activeId) {
  const host = String(stored.host || '');
  return {
    status: 'unknown',
    uptime: '--',
    cpuModel: 'Linux Server',
    cpuPercent: 0,
    memoryPercent: 0,
    storagePercent: 0,
    ...stored,
    port: parseInt(stored.port, 10) || 22,
    username: stored.username || 'root',
    ipMasked: maskHost(host),
    isCurrent: stored.id === activeId,
    isReal: Boolean(host) && host !== 'YOUR_SERVER_IP' && !host.includes('*')
  };
}

function refreshKnownSecrets() {
  security.registerSecrets([
    ...config.servers.flatMap(s => SERVER_SECRETS.map(k => s[k])),
    ...ALERT_SECRETS.map(k => config.alerts[k]),
    config.geminiApiKey,
    process.env.PANEL_TOKEN,
    process.env.PANEL_VIEWER_TOKEN,
    process.env.SSH_PASS
  ]);
}

function safeDecrypt(value, label) {
  try {
    return secretBox.decrypt(value);
  } catch (err) {
    console.warn(`Could not decrypt ${label} (wrong CONFIG_KEY?). It was cleared.`);
    return '';
  }
}


function serverFromEnv() {
  const host = String(process.env.SSH_HOST || '').trim();
  if (!host) return null;
  let privateKey = '';
  if (process.env.SSH_KEY_PATH) {
    try { privateKey = fs.readFileSync(process.env.SSH_KEY_PATH, 'utf8'); } catch (err) {
      console.warn('Could not read SSH_KEY_PATH:', err.message);
    }
  }
  return {
    id: 'srv-env',
    name: host,
    host,
    port: parseInt(process.env.SSH_PORT, 10) || 22,
    username: process.env.SSH_USER || 'root',
    password: process.env.SSH_PASS || '',
    privateKey,
    createdAt: new Date().toISOString()
  };
}

function load() {
  let loaded = {};
  let needsMigration = false;

  if (fs.existsSync(CONFIG_PATH)) {
    try {
      loaded = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    } catch (err) {
      console.warn('Error reading config.json, using default configuration:', err.message);
    }
  }

  const storedServers = Array.isArray(loaded.servers) ? loaded.servers : [];
  if (storedServers.length === 0) {
    const envServer = serverFromEnv();
    if (envServer) storedServers.push(envServer);
  }

  const activeId = loaded.activeServerId || (storedServers[0] && storedServers[0].id) || '';
  config.activeServerId = activeId;
  config.servers = storedServers.map(raw => {
    const stored = {};
    for (const key of PERSISTED_SERVER_FIELDS) if (raw[key] !== undefined) stored[key] = raw[key];
    for (const key of SERVER_SECRETS) {
      if (stored[key] && !secretBox.isEncrypted(stored[key])) needsMigration = true;
      stored[key] = safeDecrypt(stored[key], `${key} of ${stored.name}`);
    }
    if (Object.keys(raw).some(k => !PERSISTED_SERVER_FIELDS.includes(k))) needsMigration = true;
    return hydrateServer(stored, activeId);
  });

  config.alerts = { ...DEFAULT_ALERTS, ...(loaded.alerts || {}) };
  for (const key of ALERT_SECRETS) {
    if (config.alerts[key] && !secretBox.isEncrypted(config.alerts[key])) needsMigration = true;
    config.alerts[key] = safeDecrypt(config.alerts[key], key);
  }

  if (loaded.geminiApiKey && !secretBox.isEncrypted(loaded.geminiApiKey)) needsMigration = true;
  config.geminiApiKey = safeDecrypt(loaded.geminiApiKey, 'geminiApiKey') || process.env.GEMINI_API_KEY || '';

  refreshKnownSecrets();
  
  if (needsMigration) {
    save();
    console.log('config.json migrated: secrets are now encrypted at rest.');
  }
  return config;
}

function save() {
  const data = {
    activeServerId: config.activeServerId,
    servers: config.servers.map(s => {
      const out = {};
      for (const key of PERSISTED_SERVER_FIELDS) if (s[key] !== undefined) out[key] = s[key];
      for (const key of SERVER_SECRETS) out[key] = secretBox.encrypt(out[key]);
      return out;
    }),
    alerts: { ...config.alerts },
    geminiApiKey: config.geminiApiKey && config.geminiApiKey !== process.env.GEMINI_API_KEY
      ? secretBox.encrypt(config.geminiApiKey)
      : ''
  };
  for (const key of ALERT_SECRETS) data.alerts[key] = secretBox.encrypt(data.alerts[key]);

  try {
    
    const tmp = `${CONFIG_PATH}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, CONFIG_PATH);
  } catch (err) {
    console.warn('Failed to save config.json:', err.message);
  }
  refreshKnownSecrets();
}

const DEMO_SERVER = Object.freeze({
  id: 'srv-local-node',
  name: 'Demo Node (no server configured)',
  host: '127.0.0.1',
  port: 22,
  username: 'root',
  isReal: false,
  isCurrent: true,
  status: 'demo',
  cpuModel: 'Virtual Demo CPU',
  uptime: 'demo mode',
  cpuPercent: 12,
  memoryTotal: 16.0,
  memoryUsed: 2.4,
  memoryPercent: 15,
  storageTotal: 100,
  storageFree: 82,
  storagePercent: 18,
  ipMasked: '127.0.*.*'
});

let demoServer = { ...DEMO_SERVER };

function getActiveServer() {
  const scopedServer = require('./access').activeServer();
  if (scopedServer) return scopedServer;
  return config.servers.find(s => s.id === config.activeServerId)
    || config.servers.find(s => s.isCurrent)
    || config.servers[0]
    || demoServer;
}

function setActiveServer(id) {
  config.servers.forEach(s => { s.isCurrent = s.id === id; });
  config.activeServerId = id;
}

module.exports = {
  CONFIG_PATH,
  config,
  load,
  save,
  hydrateServer,
  maskHost,
  getActiveServer,
  setActiveServer,
  getVisibleServers: () => require('./access').visibleServers(config.servers)
};
