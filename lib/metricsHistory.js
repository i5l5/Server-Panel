
const fs = require('fs');
const path = require('path');
const { DATA_DIR } = require('./audit');

const HISTORY_PATH = path.join(DATA_DIR, 'metrics-history.json');
const MIN_INTERVAL_MS = 15_000;
const RETENTION_MS = 24 * 60 * 60 * 1000;
const FLUSH_INTERVAL_MS = 5 * 60 * 1000;
const MAX_POINTS_RETURNED = 240;

let series = {}; 
let dirty = false;

function load() {
  try {
    const parsed = JSON.parse(fs.readFileSync(HISTORY_PATH, 'utf8'));
    if (parsed && typeof parsed === 'object') series = parsed;
    prune();
  } catch (_) {
    series = {};
  }
}

function prune(now = Date.now()) {
  for (const id of Object.keys(series)) {
    series[id] = series[id].filter(p => now - p.t <= RETENTION_MS);
    if (series[id].length === 0) delete series[id];
  }
}

function record(serverId, m, now = Date.now()) {
  if (!serverId || !m) return false;
  const list = series[serverId] || (series[serverId] = []);
  const last = list[list.length - 1];
  if (last && now - last.t < MIN_INTERVAL_MS) return false;

  list.push({
    t: now,
    cpu: Number(m.cpuPercent ?? m.cpu) || 0,
    ram: Number(m.memoryPercent ?? m.ram) || 0,
    disk: Number(m.storagePercent ?? m.disk) || 0,
    rx: Number(m.rxMbps) || 0,
    tx: Number(m.txKbps) || 0
  });
  while (list.length && now - list[0].t > RETENTION_MS) list.shift();
  dirty = true;
  return true;
}


function downsample(points, maxPoints) {
  if (points.length <= maxPoints) return points;
  const size = Math.ceil(points.length / maxPoints);
  const out = [];
  for (let i = 0; i < points.length; i += size) {
    const chunk = points.slice(i, i + size);
    const avg = key => +(chunk.reduce((sum, p) => sum + p[key], 0) / chunk.length).toFixed(2);
    out.push({ t: chunk[chunk.length - 1].t, cpu: avg('cpu'), ram: avg('ram'), disk: avg('disk'), rx: avg('rx'), tx: avg('tx') });
  }
  return out;
}

const RANGES = { '15m': 15 * 60e3, '1h': 60 * 60e3, '6h': 6 * 60 * 60e3, '24h': RETENTION_MS };

function get(serverId, range = '1h', now = Date.now()) {
  const span = RANGES[range] || RANGES['1h'];
  const points = (series[serverId] || []).filter(p => now - p.t <= span);
  return downsample(points, MAX_POINTS_RETURNED);
}

function flush() {
  if (!dirty) return;
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    prune();
    fs.writeFileSync(HISTORY_PATH, JSON.stringify(series));
    dirty = false;
  } catch (err) {
    console.warn('Could not persist metrics history:', err.message);
  }
}

function start() {
  load();
  const timer = setInterval(flush, FLUSH_INTERVAL_MS);
  if (timer.unref) timer.unref();
}

function reset() {
  series = {};
  dirty = false;
}

module.exports = { start, record, get, flush, downsample, reset, RANGES };
