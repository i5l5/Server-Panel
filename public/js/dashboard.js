
(function () {
  const SVG_NS = 'http://www.w3.org/2000/svg';
  const OVERVIEW_EVERY_MS = 10_000;
  const HISTORY_EVERY_MS = 30_000;
  const SERIES = [
    { key: 'cpu', label: 'CPU', color: 'var(--series-cpu)' },
    { key: 'ram', label: 'Memory', color: 'var(--series-ram)' },
    { key: 'disk', label: 'Disk', color: 'var(--series-disk)' }
  ];

  const $ = id => document.getElementById(id);
  const dash = {
    range: '1h',
    points: [],
    lastOverviewAt: 0,
    timers: [],
    started: false
  };

  
  
  
  function setText(id, value) {
    const el = $(id);
    if (el) el.textContent = value;
  }

  function svgEl(tag, attrs) {
    const el = document.createElementNS(SVG_NS, tag);
    for (const [k, v] of Object.entries(attrs || {})) el.setAttribute(k, v);
    return el;
  }

  function levelFor(value, warn, bad) {
    if (value >= bad) return 'bad';
    if (value >= warn) return 'warn';
    return 'ok';
  }

  function relativeTime(iso) {
    const t = typeof iso === 'number' ? iso : Date.parse(iso);
    if (!Number.isFinite(t)) return '';
    const s = Math.max(0, Math.round((Date.now() - t) / 1000));
    if (s < 10) return 'just now';
    if (s < 60) return `${s}s ago`;
    if (s < 3600) return `${Math.floor(s / 60)}m ago`;
    if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
    return new Date(t).toLocaleDateString();
  }

  function clockLabel(t) {
    return new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }

  
  
  
  function setKpi(kind, value, warn = 70, bad = 90) {
    const tile = document.querySelector(`.dash-kpi[data-kpi="${kind}"]`);
    const bar = $(`kpi${kind[0].toUpperCase()}${kind.slice(1)}Bar`);
    const n = Math.max(0, Math.min(100, Number(value) || 0));
    if (bar) bar.style.width = `${n}%`;
    if (tile) tile.dataset.level = levelFor(n, warn, bad);
  }

  
  function onPulse(m) {
    if (!m) return;
    setKpi('cpu', m.cpu, 70, 90);
    setKpi('ram', m.ram, 75, 90);
    setKpi('disk', m.disk, 80, 92);
    if (m.cpuLoad !== undefined) setText('txtCpuSub', `Load ${m.cpuLoad}`);
    setText('valRxRate', `${m.rxMbps ?? 0} MB/s`);
    setText('valTxRate', `${m.txKbps ?? 0} KB/s`);
    if (m.cacheMb !== undefined) setText('valCacheMb', `${m.cacheMb} MB`);
    setText('pulseOptimalBadge', m.health >= 75 ? `Healthy ${m.health}%` : m.health >= 45 ? `Busy ${m.health}%` : `Critical ${m.health}%`);
  }

  function renderSpark(id, values) {
    const svg = $(id);
    if (!svg) return;
    svg.replaceChildren();
    if (values.length < 2) return;
    const max = Math.max(...values, 1);
    const min = Math.min(...values, 0);
    const span = max - min || 1;
    const pts = values.map((v, i) => [(i / (values.length - 1)) * 100, 26 - ((v - min) / span) * 24]);
    const line = pts.map((p, i) => `${i ? 'L' : 'M'}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join('');
    svg.append(
      svgEl('path', { class: 'area', d: `${line}L100,28L0,28Z` }),
      svgEl('path', { class: 'line', d: line })
    );
  }

  
  
  
  function renderHero(data) {
    const srv = data.server || {};
    const pill = $('dashModePill');
    let mode = 'demo';
    let label = 'Demo mode';
    if (data.isReal) { mode = 'live'; label = 'Live SSH'; }
    else if (srv.isReal) { mode = 'offline'; label = 'Offline'; }
    if (pill) pill.dataset.mode = mode;
    setText('dashModeText', label);

    setText('dashGreeting', srv.name || 'Server overview');
    setText('dashServerName', srv.uptime && srv.uptime !== '--' ? `Up ${srv.uptime}` : 'Uptime unknown');
    setText('dashServerHost', `${srv.username || 'root'}@${srv.ipMasked || srv.host || '—'}`);
    setText('dashCpuModel', srv.cpuModel || 'Linux Server');
    setText('dashLastSeen', srv.lastSeen ? `Last contact ${relativeTime(srv.lastSeen)}` : (mode === 'demo' ? 'Add a server in Settings to go live' : ''));

    const err = $('dashConnectError');
    if (err) {
      const show = mode === 'offline' && srv.connectError;
      err.hidden = !show;
      err.textContent = show ? `SSH: ${srv.connectError}` : '';
    }

    if (srv.memoryTotal) setText('txtRamSub', `${srv.memoryUsed ?? '--'} / ${srv.memoryTotal} GB`);
    if (srv.storageTotal) setText('txtDiskSub', `${srv.storageFree ?? '--'} GB free of ${srv.storageTotal}`);
  }

  function renderFleet(data) {
    const set = (id, text, on) => {
      const el = $(id);
      if (!el) return;
      el.textContent = text;
      el.className = on === undefined ? '' : (on ? 'on' : 'off');
    };
    const f = data.fleet || {};
    set('fleetServers', f.total ? `${f.online} / ${f.total}` : 'None', f.online > 0);
    set('fleetPm2', `${data.pm2.online} / ${data.pm2.total}`, data.pm2.online > 0);
    set('fleetAlerts', data.alertsEnabled ? 'Enabled' : 'Off', data.alertsEnabled);
  }

  
  
  
  const ACTIVITY_LABELS = [
    [/^\/api\/servers\/select$/, 'Switched active server', 'repeat'],
    [/^\/api\/servers\/[^/]+$/, 'Removed a server', 'trash-2'],
    [/^\/api\/servers$/, 'Added a server', 'plus-circle'],
    [/^\/api\/pm2\/action$/, 'PM2 action', 'zap'],
    [/^\/api\/files\/upload$/, 'Uploaded a file', 'upload'],
    [/^\/api\/files\/write$/, 'Edited a file', 'edit-3'],
    [/^\/api\/files\/delete$/, 'Deleted a file', 'trash-2'],
    [/^\/api\/files\/rename$/, 'Renamed a file', 'type'],
    [/^\/api\/files\/create-folder$/, 'Created a folder', 'folder-plus'],
    [/^\/api\/files\/read$/, 'Opened a file', 'file-text'],
    [/^\/api\/infra\/docker/, 'Docker action', 'box'],
    [/^\/api\/infra\/nginx/, 'Nginx action', 'globe'],
    [/^\/api\/infra\/ssl/, 'Issued SSL certificate', 'lock'],
    [/^\/api\/alerts/, 'Alert settings', 'bell'],
    [/^\/api\/copilot\/chat$/, 'Asked Agent', 'message-circle'],
    [/^\/api\/copilot/, 'Agent', 'message-circle']
  ];

  function describeEntry(e) {
    if (e.type === 'operation' || e.type === 'account' || e.type === 'auth' || e.type === 'github') {
      return { title: `${e.action || e.type}${e.target ? ` · ${e.target}` : ''}`, icon: e.type === 'operation' ? 'git-branch' : 'user' };
    }
    if (e.type === 'terminal') {
      return { title: e.action === 'open' ? 'Opened SSH terminal' : 'Closed SSH terminal', icon: 'terminal' };
    }
    const match = ACTIVITY_LABELS.find(([re]) => re.test(e.path || ''));
    let title = match ? match[1] : `${e.method} ${e.path}`;
    const d = e.detail || {};
    const extra = [d.action, d.name || d.containerId || d.domain || d.newName].filter(Boolean).join(' ');
    if (extra) title += ` · ${extra}`;
    return { title, icon: match ? match[2] : 'activity' };
  }

  function renderActivity(entries) {
    const list = $('dashActivityList');
    if (!list) return;
    list.replaceChildren();
    if (!entries || entries.length === 0) {
      const empty = document.createElement('li');
      empty.className = 'dash-activity-empty';
      empty.textContent = 'No activity recorded yet.';
      list.appendChild(empty);
      return;
    }

    for (const e of entries) {
      const { title, icon } = describeEntry(e);
      const li = document.createElement('li');
      li.dataset.ok = String(!(e.status >= 400));

      const iconWrap = document.createElement('span');
      iconWrap.className = 'dash-activity-icon';
      const i = document.createElement('i');
      i.setAttribute('data-feather', e.status >= 400 ? 'alert-triangle' : icon);
      iconWrap.appendChild(i);

      const text = document.createElement('div');
      text.className = 'dash-activity-text';
      text.textContent = title;
      const meta = document.createElement('small');
      meta.textContent = [e.server, e.actor || e.role, e.status ? (typeof e.status === 'number' ? `HTTP ${e.status}` : e.status) : ''].filter(Boolean).join(' • ');
      text.appendChild(meta);

      const time = document.createElement('time');
      time.dateTime = e.time;
      time.title = new Date(e.time).toLocaleString();
      time.textContent = relativeTime(e.time);

      li.append(iconWrap, text, time);
      list.appendChild(li);
    }
    if (window.feather) feather.replace();
  }

  
  
  
  const PAD = { top: 10, right: 12, bottom: 24, left: 34 };

  function renderChart() {
    const svg = $('historyChart');
    const wrap = $('historyChartWrap');
    const empty = $('historyEmpty');
    if (!svg || !wrap) return;

    const points = dash.points;
    const width = Math.max(240, wrap.clientWidth);
    const height = Math.max(160, wrap.clientHeight);
    svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
    svg.replaceChildren();
    empty.hidden = points.length >= 2;

    const plotW = width - PAD.left - PAD.right;
    const plotH = height - PAD.top - PAD.bottom;
    const y = v => PAD.top + plotH - (Math.max(0, Math.min(100, v)) / 100) * plotH;

    const grid = svgEl('g', { class: 'grid' });
    const axis = svgEl('g', { class: 'axis' });
    for (const v of [0, 25, 50, 75, 100]) {
      grid.appendChild(svgEl('line', { x1: PAD.left, x2: width - PAD.right, y1: y(v), y2: y(v) }));
      const label = svgEl('text', { x: PAD.left - 8, y: y(v) + 4, 'text-anchor': 'end' });
      label.textContent = `${v}%`;
      axis.appendChild(label);
    }
    svg.append(grid, axis);
    if (points.length < 2) return;

    const t0 = points[0].t;
    const t1 = points[points.length - 1].t;
    const span = Math.max(1, t1 - t0);
    const x = t => PAD.left + ((t - t0) / span) * plotW;

    const ticks = Math.min(5, points.length);
    let previousLabel = '';
    for (let i = 0; i < ticks; i++) {
      const t = t0 + (span * i) / (ticks - 1);
      const text = clockLabel(t);
      if (text === previousLabel) continue; 
      previousLabel = text;
      const label = svgEl('text', { x: x(t), y: height - 6, 'text-anchor': i === 0 ? 'start' : i === ticks - 1 ? 'end' : 'middle' });
      label.textContent = text;
      axis.appendChild(label);
    }

    const pathFor = key => points.map((p, i) => `${i ? 'L' : 'M'}${x(p.t).toFixed(1)},${y(p[key]).toFixed(1)}`).join('');
    const cpuLine = pathFor('cpu');
    svg.appendChild(svgEl('path', { class: 'area-cpu', d: `${cpuLine}L${x(t1).toFixed(1)},${y(0)}L${x(t0).toFixed(1)},${y(0)}Z` }));
    for (const s of SERIES) svg.appendChild(svgEl('path', { class: `series ${s.key}`, d: pathFor(s.key) }));

    
    const cursor = svgEl('line', { class: 'cursor', y1: PAD.top, y2: PAD.top + plotH, visibility: 'hidden' });
    const dots = SERIES.map(s => svgEl('circle', { class: `dot ${s.key}`, r: 4, visibility: 'hidden' }));
    svg.append(cursor, ...dots);
    const overlay = svgEl('rect', { x: PAD.left, y: PAD.top, width: plotW, height: plotH, fill: 'transparent' });
    svg.appendChild(overlay);

    const tip = $('historyTip');
    const hide = () => {
      cursor.setAttribute('visibility', 'hidden');
      dots.forEach(d => d.setAttribute('visibility', 'hidden'));
      if (tip) tip.hidden = true;
    };

    overlay.addEventListener('pointermove', ev => {
      const rect = svg.getBoundingClientRect();
      const px = ((ev.clientX - rect.left) / rect.width) * width;
      const t = t0 + ((px - PAD.left) / plotW) * span;
      let nearest = points[0];
      for (const p of points) if (Math.abs(p.t - t) < Math.abs(nearest.t - t)) nearest = p;

      const cx = x(nearest.t);
      cursor.setAttribute('x1', cx);
      cursor.setAttribute('x2', cx);
      cursor.setAttribute('visibility', 'visible');
      SERIES.forEach((s, i) => {
        dots[i].setAttribute('cx', cx);
        dots[i].setAttribute('cy', y(nearest[s.key]));
        dots[i].setAttribute('visibility', 'visible');
      });

      if (tip) {
        tip.replaceChildren();
        const head = document.createElement('b');
        head.textContent = new Date(nearest.t).toLocaleString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
        tip.appendChild(head);
        for (const s of SERIES) {
          const row = document.createElement('span');
          row.style.setProperty('--c', s.color);
          row.textContent = `${s.label} ${Math.round(nearest[s.key])}%`;
          tip.appendChild(row);
        }
        tip.hidden = false;
        const left = (cx / width) * rect.width;
        tip.style.left = `${Math.min(rect.width - tip.offsetWidth - 4, Math.max(4, left + 12))}px`;
      }
    });
    overlay.addEventListener('pointerleave', hide);
  }

  function summarize(points) {
    if (points.length === 0) return 'Collecting samples…';
    const avg = key => Math.round(points.reduce((s, p) => s + p[key], 0) / points.length);
    const peak = Math.round(Math.max(...points.map(p => p.cpu)));
    return `Avg CPU ${avg('cpu')}% · peak ${peak}% · avg memory ${avg('ram')}% · ${points.length} samples`;
  }

  
  
  
  async function loadOverview() {
    try {
      const res = await fetch('/api/overview');
      if (!res.ok) return;
      const data = await res.json();
      if (!data.success) return;
      dash.lastOverviewAt = Date.now();
      renderHero(data);
      renderFleet(data);
      onPulse(data.metrics);
      renderActivity(data.recentActivity);
    } catch (_) {  }
  }

  async function loadHistory() {
    try {
      const res = await fetch(`/api/metrics/history?range=${encodeURIComponent(dash.range)}`);
      if (!res.ok) return;
      const data = await res.json();
      dash.points = Array.isArray(data.points) ? data.points : [];
      setText('historySummary', summarize(dash.points));
      renderChart();
      const recent = dash.points.slice(-30);
      renderSpark('sparkCpu', recent.map(p => p.cpu));
      renderSpark('sparkRam', recent.map(p => p.ram));
      renderSpark('sparkDisk', recent.map(p => p.disk));
      renderSpark('sparkNet', recent.map(p => p.rx));
    } catch (_) {  }
  }

  function setupControls() {
    document.querySelectorAll('.dash-range button').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.dash-range button').forEach(b => {
          const on = b === btn;
          b.classList.toggle('active', on);
          b.setAttribute('aria-selected', String(on));
        });
        dash.range = btn.dataset.range;
        loadHistory();
      });
    });

    document.querySelectorAll('.dash-qa[data-goto]').forEach(btn => {
      btn.addEventListener('click', () => {
        if (typeof switchView === 'function') switchView(btn.dataset.goto);
      });
    });

    const refresh = $('btnRefreshMetrics');
    if (refresh) refresh.addEventListener('click', () => { loadOverview(); loadHistory(); });

    let resizeTimer = null;
    window.addEventListener('resize', () => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(renderChart, 120);
    });
  }

  function isVisible() {
    const view = $('view-dashboard');
    return !document.hidden && view && view.classList.contains('active');
  }

  
  function start() {
    if (dash.started) return;
    dash.started = true;
    setupControls();
    loadOverview();
    loadHistory();
    dash.timers.push(setInterval(() => { if (isVisible()) loadOverview(); }, OVERVIEW_EVERY_MS));
    dash.timers.push(setInterval(() => { if (isVisible()) loadHistory(); }, HISTORY_EVERY_MS));
    document.addEventListener('visibilitychange', () => {
      if (isVisible() && Date.now() - dash.lastOverviewAt > OVERVIEW_EVERY_MS) { loadOverview(); loadHistory(); }
    });
  }

  
  function onShow() {
    if (!dash.started) return;
    loadOverview();
    loadHistory();
  }

  window.Dashboard = { start, onShow, onPulse };
})();
