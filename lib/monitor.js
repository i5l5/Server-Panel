
const sshService = require('../sshService');
const store = require('./configStore');
const history = require('./metricsHistory');

const SAMPLE_INTERVAL_MS = 60_000;
const ALERT_COOLDOWN_MS = 15 * 60 * 1000;
const BRAND_COLOR = 0x9a114d;

const cooldowns = new Map();
let running = false;

function escapeHtml(s) {
  return String(s).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);
}

async function sendDiscord(payload) {
  const url = store.config.alerts.discordWebhookUrl;
  if (!url) return null;
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'Panel Watchdog', ...payload })
  });
  return resp.ok ? 'Sent successfully' : `HTTP Error ${resp.status}`;
}

/** Uses HTML parse mode: process names with _ or * would break Telegram Markdown. */
async function sendTelegram(title, message) {
  const { telegramBotToken, telegramChatId } = store.config.alerts;
  if (!telegramBotToken || !telegramChatId) return null;
  const resp = await fetch(`https://api.telegram.org/bot${telegramBotToken}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: telegramChatId,
      text: `<b>${escapeHtml(title)}</b>\n\n${escapeHtml(message)}`,
      parse_mode: 'HTML'
    })
  });
  const data = await resp.json().catch(() => ({}));
  return data.ok ? 'Sent successfully' : (data.description || `HTTP Error ${resp.status}`);
}

async function sendAlert(title, message) {
  const results = { discord: null, telegram: null };
  try {
    results.discord = await sendDiscord({
      embeds: [{ title, description: message, color: BRAND_COLOR, timestamp: new Date().toISOString() }]
    });
  } catch (err) { results.discord = err.message; }
  try {
    results.telegram = await sendTelegram(title, message);
  } catch (err) { results.telegram = err.message; }
  return results;
}

function throttled(key, now) {
  const last = cooldowns.get(key);
  if (last && now - last < ALERT_COOLDOWN_MS) return true;
  cooldowns.set(key, now);
  return false;
}

/** Pure threshold evaluation, separated so it can be unit tested. */
function evaluateAlerts(server, metrics, pm2List, alerts) {
  const out = [];
  const where = `خادم: ${server.name} (${server.host})`;
  if (metrics.cpuPercent >= (alerts.cpuThreshold || 85)) {
    out.push({ key: `cpu_${server.id}`, title: `⚠️ استهلاك معالج مرتفع: ${metrics.cpuPercent}%`, message: `${where}\nاستهلاك المعالج تجاوز ${alerts.cpuThreshold}%.` });
  }
  if (metrics.memoryPercent >= (alerts.ramThreshold || 90)) {
    out.push({ key: `ram_${server.id}`, title: `⚠️ استهلاك ذاكرة RAM حرج: ${metrics.memoryPercent}%`, message: `${where}\nالذاكرة المستخدمة: ${metrics.memoryUsed}GB من ${metrics.memoryTotal}GB.` });
  }
  if (metrics.storagePercent >= (alerts.diskThreshold || 90)) {
    out.push({ key: `disk_${server.id}`, title: `💾 مساحة القرص شبه ممتلئة: ${metrics.storagePercent}%`, message: `${where}\nالمساحة الحرة: ${metrics.storageFree}GB من ${metrics.storageTotal}GB.` });
  }
  if (alerts.pm2Alerts) {
    for (const proc of pm2List || []) {
      if (proc.status === 'stopped' || proc.status === 'errored') {
        out.push({ key: `pm2_${proc.name}_${server.id}`, title: `🚨 توقف خدمة PM2: [${proc.name}]`, message: `توقفت الخدمة ${proc.name} على السيرفر ${server.name} (${server.host}).\nالحالة الحالية: ${proc.status}.` });
      }
    }
  }
  return out;
}

async function tick() {
  if (running) return; // SSH may be slower than the interval
  const server = store.getActiveServer();
  if (!server || !server.isReal) return;

  running = true;
  try {
    const metrics = await sshService.getLiveMetrics(server);
    Object.assign(server, metrics, { status: 'connected', lastSeen: new Date().toISOString() });
    history.record(server.id, metrics);

    const alerts = store.config.alerts;
    if (!alerts || !alerts.enabled) return;
    const pm2List = alerts.pm2Alerts ? await sshService.getPm2List(server) : [];
    const now = Date.now();
    for (const a of evaluateAlerts(server, metrics, pm2List, alerts)) {
      if (!throttled(a.key, now)) await sendAlert(a.title, a.message);
    }
  } catch (err) {
    server.status = 'offline';
    console.warn('Monitor check failed:', err.message);
  } finally {
    running = false;
  }
}

function start() {
  const timer = setInterval(() => { tick().catch(err => console.warn('Monitor error:', err.message)); }, SAMPLE_INTERVAL_MS);
  if (timer.unref) timer.unref();
}

module.exports = { start, tick, sendAlert, sendDiscord, sendTelegram, evaluateAlerts, BRAND_COLOR };
