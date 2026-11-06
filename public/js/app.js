











const state = {



  currentView: 'dashboard',



  servers: [],



  currentServer: null,



  pm2Services: [],



  currentPath: '/root',



  files: [],



  socket: null,



  isExecutingPlan: false,



  activeEditingFile: null,



  activeLogsService: null,



  xterm: null,



  fitAddon: null,



  monacoEditor: null,



  hasGeminiKey: false,



  panelToken: ''



};



state.user = null;



state.serverId = '';























const AUTH_STORAGE_KEY = 'controlLinx.panelToken';











function escapeHtml(value) {



  return String(value ?? '').replace(/[&<>"'`]/g, ch => ({



    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;', '`': '&#96;'



  })[ch]);



}







/** معرّف آمن للاستخدام داخل onclick="fn('...')": أي محرف خارج النمط يُحذف. */



function safeId(value) {



  return String(value ?? '').replace(/[^A-Za-z0-9._@:-]/g, '');



}







/** أيقونات feather مسموحة فقط بأسماء بسيطة. */



function safeIcon(value, fallback = 'box') {



  return /^[a-z0-9-]{1,32}$/.test(String(value || '')) ? value : fallback;



}



const nativeFetch = window.fetch.bind(window);



let authPromptPromise = null;







function getPanelToken() {



  if (state.panelToken) return state.panelToken;



  try {



    state.panelToken = sessionStorage.getItem(AUTH_STORAGE_KEY) || '';



  } catch (_) {



    state.panelToken = '';



  }



  return state.panelToken;



}







function setPanelToken(token) {



  state.panelToken = String(token || '').trim();



  try {



    if (state.panelToken) sessionStorage.setItem(AUTH_STORAGE_KEY, state.panelToken);



    else sessionStorage.removeItem(AUTH_STORAGE_KEY);



  } catch (_) {



    /* التخزين معطّل (وضع خاص): نكتفي بالذاكرة */



  }



}







function isApiRequest(url) {



  try {



    const resolved = new URL(String(url || ''), window.location.origin);



    return resolved.origin === window.location.origin && resolved.pathname.startsWith('/api/');



  } catch (_) {



    return false;



  }



}







// معترض واحد: يضيف التوكن لكل طلب /api من نفس الأصل، ويتعامل مع 401.



window.fetch = async function panelFetch(input, init) {



  const options = init || {};



  const url = typeof input === 'string' ? input : (input && input.url) || '';







  if (!isApiRequest(url)) return nativeFetch(input, init);







  const baseHeaders = options.headers



    || (typeof Request !== 'undefined' && input instanceof Request ? input.headers : undefined);



  const headers = new Headers(baseHeaders || {});



  const token = getPanelToken();



  if (token) headers.set('X-Panel-Token', token);



  if (state.serverId) headers.set('X-Server-Id', state.serverId);







  const res = await nativeFetch(input, { ...options, headers, credentials: 'same-origin' });







  if (res.status === 401) {



    setPanelToken('');



    promptForToken('Your session has expired. Sign in again.').then(() => window.location.reload());



  }



  return res;



};







function verifyPanelToken(token) {



  if (!token) return Promise.resolve(false);



  return nativeFetch('/api/auth/verify', {



    headers: { 'X-Panel-Token': token },



    credentials: 'same-origin'



  })



    .then(async res => {



      if (!res.ok) return false;



      const data = await res.json();



      state.user = data.user;



      return true;



    })



    .catch(() => false);



}







function injectAuthStyles() {



  if (document.getElementById('authOverlayStyles')) return;



  const style = document.createElement('style');



  style.id = 'authOverlayStyles';



  style.textContent = `



    .auth-overlay {



      position: fixed; inset: 0; z-index: 9999;



      display: flex; align-items: center; justify-content: center;



      padding: 20px;



      background-color: var(--bg-primary);



      background-image:



        radial-gradient(circle at 10% 20%, rgba(13, 148, 136, 0.05) 0%, transparent 40%),



        radial-gradient(circle at 90% 80%, rgba(124, 13, 62, 0.04) 0%, transparent 40%);



      backdrop-filter: blur(6px);



      font-family: var(--font-sans);



    }



    .auth-card {



      width: 100%; max-width: 420px;



      display: flex; flex-direction: column; gap: 16px;



      padding: 32px; border-radius: var(--radius-lg);



      background: var(--bg-secondary); border: 1px solid var(--border-color);



      box-shadow: var(--shadow-lg);



      color: var(--text-primary);



    }



    .auth-brand {



      display: flex; align-items: center; gap: 10px;



      font-weight: 800; color: var(--mint-600); font-size: 18px;



    }



    .auth-brand .brand-logo-icon {



      width: 34px; height: 34px; border-radius: var(--radius-full);



      display: inline-flex; align-items: center; justify-content: center;



      background: var(--teal-gradient); color: #fff;



      box-shadow: var(--shadow-glow);



    }



    .auth-card h2 { margin: 0; font-size: 20px; font-weight: 800; color: var(--text-primary); }



    .auth-card p { margin: 0; font-size: 13px; line-height: 1.6; color: var(--text-secondary); }



    .auth-card label { font-size: 12px; font-weight: 600; color: var(--text-primary); }



    .auth-card input {



      width: 100%; padding: 12px 14px; border-radius: var(--radius-md);



      font-size: 14px; font-family: var(--font-sans);



      color: var(--text-primary); background: var(--bg-secondary);



      border: 1px solid var(--border-color);



      transition: border-color 0.2s ease, box-shadow 0.2s ease;



    }



    .auth-card input:focus {



      outline: none; border-color: var(--border-focus);



      box-shadow: 0 0 0 3px rgba(13, 148, 136, 0.12);



    }



    .auth-card button {



      padding: 12px 16px; border: 0; border-radius: var(--radius-full);



      font-size: 14px; font-weight: 700; cursor: pointer;



      color: #fff; background: var(--teal-gradient);



      box-shadow: var(--shadow-glow);



      transition: transform 0.15s ease;



    }



    .auth-card button:hover { transform: translateY(-1px); }



    .auth-card button[disabled] { opacity: 0.6; cursor: progress; transform: none; }



    .auth-error { font-size: 12px; font-weight: 600; color: var(--danger-color); min-height: 16px; }



    @media (max-width: 640px) { .auth-card { padding: 24px; border-radius: var(--radius-md); } }



  `;



  document.head.appendChild(style);



}







/** نافذة إدخال التوكن: تُرجع Promise ينتهي عند التحقق بنجاح. */



function promptForToken(message) {



  if (authPromptPromise) return authPromptPromise;



  injectAuthStyles();







  authPromptPromise = new Promise(resolve => {



    const overlay = document.createElement('div');



    overlay.className = 'auth-overlay';



    overlay.setAttribute('role', 'dialog');



    overlay.setAttribute('aria-modal', 'true');



    overlay.setAttribute('aria-labelledby', 'authOverlayTitle');







    const card = document.createElement('form');



    card.className = 'auth-card';



    card.noValidate = true;







    const brand = document.createElement('div');



    brand.className = 'auth-brand';



    brand.innerHTML = '<span class="brand-logo-icon"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"></path><polyline points="3.27 6.96 12 12.01 20.73 6.96"></polyline><line x1="12" y1="22.08" x2="12" y2="12"></line></svg></span>';







    const title = document.createElement('h2');



    title.id = 'authOverlayTitle';



    title.textContent = 'لوحة  محمية';







    const desc = document.createElement('p');



    desc.textContent = message || 'أدخل PANEL_TOKEN المحدَّد في ملف .env للوصول إلى اللوحة.';







    const label = document.createElement('label');



    label.htmlFor = 'authTokenInput';



    label.textContent = 'Panel Token';







    const input = document.createElement('input');



    input.id = 'authTokenInput';



    input.type = 'password';



    input.autocomplete = 'current-password';



    input.spellcheck = false;



    input.required = true;



    input.setAttribute('aria-describedby', 'authTokenError');







    const error = document.createElement('div');



    error.id = 'authTokenError';



    error.className = 'auth-error';



    error.setAttribute('role', 'alert');







    const submit = document.createElement('button');



    submit.type = 'submit';



    submit.textContent = 'دخول';







    title.textContent = 'Sign in';



    desc.textContent = 'Sign in with your username and password.';



    const usernameLabel = document.createElement('label');



    usernameLabel.htmlFor = 'authUsername';



    usernameLabel.textContent = 'Username';



    const username = document.createElement('input');



    username.id = 'authUsername';



    username.autocomplete = 'username';



    username.maxLength = 48;



    username.required = true;



    label.textContent = 'Password';



    input.type = 'password';



    submit.textContent = 'Sign in';



    card.append(brand, title, desc, usernameLabel, username, label, input, error, submit);



    overlay.appendChild(card);







    card.addEventListener('submit', async event => {



      event.preventDefault();



      const uname = username.value.trim();



      const password = input.value;



      if (!uname) {



        error.textContent = 'Username is required.';



        username.focus();



        return;



      }



      if (!password) {



        error.textContent = 'Password is required.';



        input.focus();



        return;



      }







      submit.disabled = true;



      error.textContent = '';



      let sessionToken = '';



      let loginError = '';



      try {



        const response = await nativeFetch('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: uname, password }) });



        const data = await response.json();



        if (!response.ok) throw new Error(data.error || 'Sign-in failed');



        sessionToken = data.token;



      } catch (err) { loginError = err.message; }



      const ok = !loginError && await verifyPanelToken(sessionToken);



      submit.disabled = false;







      if (!ok) {



        error.textContent = loginError || 'Invalid username or password.';



        input.select();



        return;



      }











      setPanelToken(sessionToken);



      state.serverId = '';



      overlay.remove();



      authPromptPromise = null;



      resolve(true);



    });







    document.body.appendChild(overlay);



    input.focus();



  });







  return authPromptPromise;



}







async function ensurePanelToken() {



  const existing = getPanelToken();



  if (existing && await verifyPanelToken(existing)) return true;



  setPanelToken('');



  return promptForToken();



}







// DOM Elements Registry



const elements = {



  // Views



  views: {



    dashboard: document.getElementById('view-dashboard'),



    terminal: document.getElementById('view-terminal'),



    files: document.getElementById('view-files'),



    processes: document.getElementById('view-processes'),



    infra: document.getElementById('view-infra'),



    copilot: document.getElementById('view-copilot'),



    settings: document.getElementById('view-settings'),



    operations: document.getElementById('view-operations')



  },



  navItems: document.querySelectorAll('.nav-pill-item'),







  // Header Stats



  headerUptime: document.getElementById('headerUptime'),



  headerIpMasked: document.getElementById('headerIpMasked'),



  btnServerDropdown: document.getElementById('btnServerDropdown'),



  btnPowerReset: document.getElementById('btnPowerReset'),



  btnQuickHome: document.getElementById('btnQuickHome'),







  // Pulse & Metrics



  pulseRingProgress: document.getElementById('pulseRingProgress'),



  pulseHealthPercent: document.getElementById('pulseHealthPercent'),



  pulseHealthTag: document.getElementById('pulseHealthTag'),



  pulseOptimalBadge: document.getElementById('pulseOptimalBadge'),



  featuredAppName: document.getElementById('featuredAppName'),



  featuredAppMem: document.getElementById('featuredAppMem'),



  valCacheMb: document.getElementById('valCacheMb'),



  valTxRate: document.getElementById('valTxRate'),



  valRxRate: document.getElementById('valRxRate'),







  // Segmented Bars



  segBarCpu: document.getElementById('segBarCpu'),



  segBarRam: document.getElementById('segBarRam'),



  segBarDisk: document.getElementById('segBarDisk'),



  txtCpuVal: document.getElementById('txtCpuVal'),



  txtCpuSub: document.getElementById('txtCpuSub'),



  txtRamVal: document.getElementById('txtRamVal'),



  txtRamSub: document.getElementById('txtRamSub'),



  txtDiskVal: document.getElementById('txtDiskVal'),



  txtDiskSub: document.getElementById('txtDiskSub'),



  btnRefreshMetrics: document.getElementById('btnRefreshMetrics'),







  // PM2 Services



  activeServicesCount: document.getElementById('activeServicesCount'),



  btnRestartAllPm2: document.getElementById('btnRestartAllPm2'),



  btnRestartAllPm2Full: document.getElementById('btnRestartAllPm2Full'),



  pm2DashboardContainer: document.getElementById('pm2DashboardContainer'),



  pm2FullListContainer: document.getElementById('pm2FullListContainer'),







  // Terminal



  xtermMount: document.getElementById('xtermTerminalMount'),



  btnTermClear: document.getElementById('btnTermClear'),



  btnTermFit: document.getElementById('btnTermFit'),



  btnTermReconnect: document.getElementById('btnTermReconnect'),



  termLiveBadge: document.getElementById('termLiveBadge'),







  // Files & Monaco Editor



  breadcrumbPath: document.getElementById('breadcrumbPath'),



  filesSubtitleNode: document.getElementById('filesSubtitleNode'),



  filesTableBody: document.getElementById('filesTableBody'),



  filesFooterCount: document.getElementById('filesFooterCount'),



  fileSearchInput: document.getElementById('fileSearchInput'),



  btnDirUp: document.getElementById('btnDirUp'),



  btnNewFile: document.getElementById('btnNewFile'),



  btnNewFolder: document.getElementById('btnNewFolder'),



  btnUploadTrigger: document.getElementById('btnUploadTrigger'),



  fileUploadInput: document.getElementById('fileUploadInput'),



  filesDropZone: document.getElementById('filesDropZone'),



  editorModal: document.getElementById('editorModal'),



  editorModalTitle: document.getElementById('editorModalTitle'),



  editorLanguageBadge: document.getElementById('editorLanguageBadge'),



  monacoEditorHost: document.getElementById('monacoEditorHost'),



  btnSaveFileContent: document.getElementById('btnSaveFileContent'),







  // Copilot AI



  copilotChatScroll: document.getElementById('copilotChatScroll'),



  copilotForm: document.getElementById('copilotForm'),



  copilotInput: document.getElementById('copilotInput'),



  copilotAiStatus: document.getElementById('copilotAiStatus'),



  btnCopilotKeyModal: document.getElementById('btnCopilotKeyModal'),



  btnCopilotClear: document.getElementById('btnCopilotClear'),







  // Infrastructure



  btnRefreshInfra: document.getElementById('btnRefreshInfra'),



  dockerStatusBadge: document.getElementById('dockerStatusBadge'),



  dockerContainersContainer: document.getElementById('dockerContainersContainer'),



  nginxSitesContainer: document.getElementById('nginxSitesContainer'),



  btnNginxTest: document.getElementById('btnNginxTest'),



  btnNginxReload: document.getElementById('btnNginxReload'),



  sslIssueForm: document.getElementById('sslIssueForm'),



  sslDomainInput: document.getElementById('sslDomainInput'),



  sslEmailInput: document.getElementById('sslEmailInput'),



  sslOutputLog: document.getElementById('sslOutputLog'),







  // Settings & Alerts



  serversListContainer: document.getElementById('serversListContainer'),



  btnAddNewServer: document.getElementById('btnAddNewServer'),



  serverModal: document.getElementById('serverModal'),



  addServerForm: document.getElementById('addServerForm'),



  alertsConfigForm: document.getElementById('alertsConfigForm'),



  chkAlertsEnabled: document.getElementById('chkAlertsEnabled'),



  txtDiscordWebhook: document.getElementById('txtDiscordWebhook'),



  txtTelegramToken: document.getElementById('txtTelegramToken'),



  txtTelegramChatId: document.getElementById('txtTelegramChatId'),



  numCpuThreshold: document.getElementById('numCpuThreshold'),



  numRamThreshold: document.getElementById('numRamThreshold'),



  btnTestAlerts: document.getElementById('btnTestAlerts'),



  geminiKeyForm: document.getElementById('geminiKeyForm'),



  txtGeminiKey: document.getElementById('txtGeminiKey'),







  // Logs Modal



  logsModal: document.getElementById('logsModal'),



  logsModalTitle: document.getElementById('logsModalTitle'),



  logsContentBox: document.getElementById('logsContentBox'),



  btnAnalyzeLogsAi: document.getElementById('btnAnalyzeLogsAi'),



  aiAnalysisBox: document.getElementById('aiAnalysisBox'),







  toastContainer: document.getElementById('toastContainer')



};







// ==========================================



// 1. INITIALIZATION & VIEW NAVIGATION



// ==========================================



document.addEventListener('DOMContentLoaded', async () => {



  createSegmentedBar(elements.segBarCpu, 16);



  createSegmentedBar(elements.segBarRam, 16);



  createSegmentedBar(elements.segBarDisk, 16);







  // لا شيء يتصل بالـ API قبل التحقق من توكن اللوحة.



  await ensurePanelToken();



  await fetchServers();



  if (window.OperationsUI) await OperationsUI.init();







  if (window.Dashboard) Dashboard.start();



  setupNavigation();



  setupWebSocket();



  initXtermTerminal();



  if (state.user?.role === 'admin' || state.user?.permissions?.includes('files')) setupFilesManager();



  if (state.user?.role === 'admin') setupCopilot();



  if (state.user?.role === 'admin' || state.user?.permissions?.includes('infra')) setupInfra();



  if (state.user?.role === 'admin') setupSettingsAndAlerts();







  // Initial Data Fetches



  await fetchServers();



  await fetchMetrics();



  await fetchPm2();



  if (state.user?.role === 'admin') await checkGeminiConfig();







  // Periodic metrics refresh



  setInterval(fetchMetrics, 3500);



  setInterval(fetchPm2, 7000);







  if (window.feather) feather.replace();



});







function switchView(viewName) {



  const permission = { terminal: 'terminal', files: 'files', infra: 'infra', copilot: 'admin', settings: 'admin' }[viewName];



  if (permission && state.user?.role !== 'admin' && (permission === 'admin' || !state.user?.permissions?.includes(permission))) {



    showToast('Your account does not have access to this section', 'error');



    return;



  }



  if (!elements.views[viewName]) return;



  state.currentView = viewName;







  Object.entries(elements.views).forEach(([k, viewEl]) => {



    if (viewEl) {



      if (k === viewName) {



        viewEl.classList.add('active');



      } else {



        viewEl.classList.remove('active');



      }



    }



  });







  elements.navItems.forEach(btn => {



    if (btn.getAttribute('data-view') === viewName) {



      btn.classList.add('active');



    } else {



      btn.classList.remove('active');



    }



  });







  // Specific view actions



  if (viewName === 'terminal') {



    setTimeout(() => {



      if (state.fitAddon) {



        try {



          state.fitAddon.fit();



          state.xterm.focus();



        } catch (e) { }



      }



    }, 150);



  } else if (viewName === 'files') {



    fetchFiles(state.currentPath);



  } else if (viewName === 'processes') {



    renderPm2Services(state.pm2Services, elements.pm2FullListContainer, true);



  } else if (viewName === 'infra') {



    fetchInfraOverview();



  } else if (viewName === 'dashboard' && window.Dashboard) {



    Dashboard.onShow();



  } else if (viewName === 'operations' && window.OperationsUI) {



    OperationsUI.refresh();



  }







  if (window.feather) feather.replace();



}







function setupNavigation() {



  elements.navItems.forEach(btn => {



    btn.addEventListener('click', () => {



      const view = btn.getAttribute('data-view');



      switchView(view);



    });



  });







  if (elements.btnQuickHome) {



    elements.btnQuickHome.addEventListener('click', () => switchView('dashboard'));



  }







  if (elements.btnServerDropdown) {



    elements.btnServerDropdown.addEventListener('click', () => switchView('settings'));



  }



}







// ==========================================



// 2. TRUE INTERACTIVE XTERM.JS TERMINAL



// ==========================================



function initXtermTerminal() {



  if (!elements.xtermMount || typeof Terminal === 'undefined') return;







  state.xterm = new Terminal({



    cursorBlink: true,



    fontSize: 13,



    fontFamily: 'JetBrains Mono, Menlo, Monaco, Consolas, monospace',



    lineHeight: 1.25,



    theme: {



      background: '#0a090b',



      foreground: '#e2e8f0',



      cursor: '#14b8a6',



      cursorAccent: '#ffffff',



      selectionBackground: 'rgba(13, 148, 136, 0.45)',



      black: '#1e293b',



      red: '#f43f5e',



      green: '#10b981',



      yellow: '#f59e0b',



      blue: '#38bdf8',



      magenta: '#14b8a6',



      cyan: '#06b6d4',



      white: '#f8fafc',



      brightBlack: '#475569',



      brightRed: '#fb7185',



      brightGreen: '#34d399',



      brightYellow: '#fbbf24',



      brightBlue: '#60a5fa',



      brightMagenta: '#f472b6',



      brightCyan: '#22d3ee',



      brightWhite: '#ffffff'



    }



  });







  if (typeof FitAddon !== 'undefined') {



    state.fitAddon = new FitAddon.FitAddon();



    state.xterm.loadAddon(state.fitAddon);



  }







  if (typeof WebLinksAddon !== 'undefined') {



    state.xterm.loadAddon(new WebLinksAddon.WebLinksAddon());



  }







  state.xterm.open(elements.xtermMount);



  setTimeout(() => {



    try { if (state.fitAddon) state.fitAddon.fit(); } catch (e) { }



  }, 100);







  // Send raw input to server PTY



  state.xterm.onData(data => {



    if (state.socket && state.socket.readyState === WebSocket.OPEN) {



      state.socket.send(JSON.stringify({ type: 'pty_input', data }));



    }



  });







  // Resize handler



  state.xterm.onResize(size => {



    if (state.socket && state.socket.readyState === WebSocket.OPEN) {



      state.socket.send(JSON.stringify({ type: 'pty_resize', rows: size.rows, cols: size.cols }));



    }



  });







  window.addEventListener('resize', () => {



    try {



      if (state.currentView === 'terminal' && state.fitAddon) state.fitAddon.fit();



    } catch (e) { }



  });







  // Clear button



  if (elements.btnTermClear) {



    elements.btnTermClear.addEventListener('click', () => {



      if (state.xterm) state.xterm.clear();



    });



  }







  // Fit button



  if (elements.btnTermFit) {



    elements.btnTermFit.addEventListener('click', () => {



      try {



        if (state.fitAddon) {



          state.fitAddon.fit();



          showToast('Terminal resized to window fit', 'success');



        }



      } catch (e) { }



    });



  }







  // Reconnect button



  if (elements.btnTermReconnect) {



    elements.btnTermReconnect.addEventListener('click', () => {



      if (state.socket) state.socket.close();



      setupWebSocket();



      showToast('Reconnecting SSH Shell session...', 'success');



    });



  }







  // Preset Chips



  document.querySelectorAll('.preset-chip').forEach(chip => {



    chip.addEventListener('click', () => {



      const cmd = chip.getAttribute('data-cmd');



      if (cmd && state.socket && state.socket.readyState === WebSocket.OPEN) {



        state.socket.send(JSON.stringify({ type: 'pty_input', data: cmd + '\n' }));



        if (state.xterm) state.xterm.focus();



      }



    });



  });



}







// ==========================================



// 3. WEBSOCKET CONTROLLER



// ==========================================



function setupWebSocket() {



  if (state.user && state.user.role !== 'admin' && !state.user.permissions?.includes('terminal')) return;



  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';



  // ترقية WebSocket لا تحمل ترويسات مخصصة، فالتوكن يُمرَّر في الـ query string.



  const token = getPanelToken();



  const query = token ? `?token=${encodeURIComponent(token)}&serverId=${encodeURIComponent(state.serverId)}` : '';



  const wsUrl = `${protocol}//${window.location.host}/${query}`;







  state.socket = new WebSocket(wsUrl);







  state.socket.onopen = () => {



    if (elements.termLiveBadge) {



      elements.termLiveBadge.textContent = 'CONNECTED';



      elements.termLiveBadge.style.color = '#34d399';



    }



    // Inform backend of initial dimensions



    setTimeout(() => {



      if (state.fitAddon && state.xterm) {



        try {



          state.fitAddon.fit();



          state.socket.send(JSON.stringify({



            type: 'pty_resize',



            rows: state.xterm.rows,



            cols: state.xterm.cols



          }));



        } catch (e) { }



      }



    }, 300);



  };







  state.socket.onclose = () => {



    if (elements.termLiveBadge) {



      elements.termLiveBadge.textContent = 'OFFLINE';



      elements.termLiveBadge.style.color = '#f43f5e';



    }



  };







  state.socket.onmessage = (event) => {



    try {



      const msg = JSON.parse(event.data);







      // Raw PTY Stream -> Write into xterm.js



      if (msg.type === 'pty_data') {



        if (state.xterm) {



          state.xterm.write(msg.data || msg.text || '');



        }



        return;



      }







      if (msg.type === 'pty_exit') {



        if (state.xterm) state.xterm.write(msg.text || '\r\n[Session ended]\r\n');



        return;



      }







      if (msg.type === 'banner') {



        if (state.xterm) {



          state.xterm.writeln(`\r\n\x1b[1;35m${msg.message}\x1b[0m\r\n`);



        }



        return;



      }







      // Live metrics pulse



      if (msg.type === 'metrics_pulse') {



        applyLivePulse(msg.data);



      }



    } catch (e) {



      // Fallback plain string



      if (state.xterm) state.xterm.write(event.data);



    }



  };



}







// ==========================================



// 4. METRICS & TELEMETRY



// ==========================================



async function fetchMetrics() {



  try {



    const res = await fetch('/api/metrics');



    const data = await res.json();



    if (data.success && data.metrics) {



      applyLivePulse(data.metrics);



      if (data.server) {



        state.currentServer = data.server;



        updateHeaderInfo(data.server);



      }



    }



  } catch (err) { }



}







function updateHeaderInfo(srv) {



  if (!srv) return;



  if (elements.headerUptime) elements.headerUptime.textContent = srv.uptime || '--';



  if (elements.headerIpMasked) elements.headerIpMasked.textContent = srv.ipMasked || srv.host;



  if (elements.filesSubtitleNode) elements.filesSubtitleNode.textContent = `${srv.username || 'root'}@${srv.host}`;



}







function applyLivePulse(m) {



  if (elements.txtCpuVal) elements.txtCpuVal.textContent = m.cpu;



  if (elements.txtRamVal) elements.txtRamVal.textContent = m.ram;



  if (elements.txtDiskVal) elements.txtDiskVal.textContent = m.disk;







  updateSegmentedBar(elements.segBarCpu, m.cpu);



  updateSegmentedBar(elements.segBarRam, m.ram);



  updateSegmentedBar(elements.segBarDisk, m.disk);







  if (elements.pulseHealthPercent) {



    elements.pulseHealthPercent.textContent = String(m.health ?? '--');



    const healthUnit = document.createElement('span');



    healthUnit.textContent = '%';



    elements.pulseHealthPercent.appendChild(healthUnit);



  }



  if (elements.pulseHealthTag) elements.pulseHealthTag.textContent = m.healthStatus || 'Optimal Stable';



  if (elements.pulseOptimalBadge) elements.pulseOptimalBadge.textContent = `Optimal ${m.health}%`;







  if (elements.pulseRingProgress) {



    const circumference = 314;



    const offset = circumference - (circumference * m.health) / 100;



    elements.pulseRingProgress.style.strokeDashoffset = offset;



  }







  if (elements.valCacheMb && m.cacheMb) elements.valCacheMb.textContent = `${m.cacheMb} MB`;



  if (elements.valTxRate && m.txKbps) elements.valTxRate.textContent = `${m.txKbps} KB/s`;



  if (elements.valRxRate && m.rxMbps) elements.valRxRate.textContent = `${m.rxMbps} MB/s`;







  if (window.Dashboard) Dashboard.onPulse(m);



}







function createSegmentedBar(container, totalSegments = 16) {



  if (!container) return;



  container.innerHTML = '';



  for (let i = 0; i < totalSegments; i++) {



    const seg = document.createElement('div');



    seg.className = 'segment-block';



    container.appendChild(seg);



  }



}







function updateSegmentedBar(container, percentage) {



  if (!container) return;



  const segments = container.querySelectorAll('.segment-block');



  const count = segments.length;



  const activeCount = Math.round((percentage / 100) * count);







  segments.forEach((seg, index) => {



    if (index < activeCount) {



      seg.classList.add('active');



      if (percentage > 85) seg.classList.add('danger');



      else seg.classList.remove('danger');



    } else {



      seg.classList.remove('active', 'danger');



    }



  });



}







if (elements.btnRefreshMetrics) {



  elements.btnRefreshMetrics.addEventListener('click', async () => {



    elements.btnRefreshMetrics.classList.add('spinning');



    await fetchMetrics();



    await fetchPm2();



    setTimeout(() => elements.btnRefreshMetrics.classList.remove('spinning'), 600);



    showToast('Live metrics refreshed', 'success');



  });



}







// ==========================================



// 5. PM2 SERVICES HUB



// ==========================================



async function fetchPm2() {



  try {



    const res = await fetch('/api/pm2');



    const data = await res.json();



    if (data.success && data.services) {



      state.pm2Services = data.services;



      const onlineCount = data.services.filter(s => s.status === 'online').length;



      if (elements.activeServicesCount) {



        elements.activeServicesCount.textContent = `${onlineCount} ACTIVE`;



      }



      renderPm2Services(data.services, elements.pm2DashboardContainer);



      if (state.currentView === 'processes') {



        renderPm2Services(data.services, elements.pm2FullListContainer, true);



      }



      if (data.services.length > 0) {



        const feat = data.services[0];



        if (elements.featuredAppName) elements.featuredAppName.textContent = feat.name;



        if (elements.featuredAppMem) elements.featuredAppMem.textContent = feat.memory;



      }



    }



  } catch (e) { }



}







/** زر إجراء في بطاقة PM2 مع أيقونة ونص وتسمية وصولية. */



function createPm2Button(className, icon, label, onClick) {



  const btn = document.createElement('button');



  btn.type = 'button';



  btn.className = className;



  btn.setAttribute('aria-label', label);







  const glyph = document.createElement('i');



  glyph.setAttribute('data-feather', icon);







  btn.append(glyph, document.createTextNode(` ${label}`));



  btn.addEventListener('click', onClick);



  return btn;



}







function renderPm2Services(list, container, isFull = false) {



  if (!container) return;



  container.innerHTML = '';







  if (!list || list.length === 0) {



    const empty = document.createElement('div');



    empty.style.color = 'var(--text-muted)';



    empty.style.fontSize = '13px';



    empty.style.padding = '12px';



    empty.textContent = 'No active PM2 services detected on remote host.';



    container.appendChild(empty);



    return;



  }







  list.forEach(svc => {



    // اسم العملية وبياناتها تأتي من مخرجات pm2 على الخادم البعيد:



    // تُعامل كبيانات نصية فقط، ولا تُدمج أبداً في HTML أو في onclick.



    const name = String(svc.name ?? '');



    const status = String(svc.status || 'unknown');



    const isOnline = status === 'online';



    const cpu = Number(svc.cpu) || 0;







    const card = document.createElement('div');



    card.className = 'pm2-service-card';







    // ----- الصف العلوي: الهوية + حالة التشغيل -----



    const top = document.createElement('div');



    top.className = 'pm2-card-top';







    const brand = document.createElement('div');



    brand.className = 'pm2-brand-area';







    const iconBox = document.createElement('div');



    iconBox.className = 'pm2-icon-box';



    const boxIcon = document.createElement('i');



    boxIcon.setAttribute('data-feather', 'box');



    iconBox.appendChild(boxIcon);







    const identity = document.createElement('div');



    const title = document.createElement('div');



    title.className = 'pm2-service-title';



    title.textContent = name;



    title.title = name;







    const meta = document.createElement('div');



    meta.className = 'pm2-service-meta';



    meta.textContent = `pid: ${svc.pid ?? '--'} • uptime: ${svc.uptime ?? '--'}`;







    identity.append(title, meta);



    brand.append(iconBox, identity);







    const pill = document.createElement('span');



    pill.className = `pm2-status-pill ${isOnline ? 'online' : 'stopped'}`;



    const dot = document.createElement('span');



    dot.className = 'dot';



    pill.append(dot, document.createTextNode(` ${status.toUpperCase()}`));







    top.append(brand, pill);







    // ----- صف المقاييس -----



    const metricsRow = document.createElement('div');



    metricsRow.className = 'pm2-metrics-row';







    const labels = document.createElement('div');



    labels.className = 'pm2-metric-labels';







    const memLabel = document.createElement('span');



    memLabel.appendChild(document.createTextNode('MEM: '));



    const memValue = document.createElement('span');



    memValue.className = 'val';



    memValue.textContent = String(svc.memory ?? '--');



    memLabel.appendChild(memValue);







    const cpuLabel = document.createElement('span');



    cpuLabel.appendChild(document.createTextNode('CPU: '));



    const cpuValue = document.createElement('span');



    cpuValue.className = 'val';



    cpuValue.textContent = `${cpu}%`;



    cpuLabel.appendChild(cpuValue);







    labels.append(memLabel, cpuLabel);







    const progress = document.createElement('div');



    progress.className = 'pm2-mini-progress';



    const bar = document.createElement('div');



    bar.className = 'pm2-mini-bar';



    bar.style.width = `${Math.min(100, cpu * 2 + 10)}%`;



    progress.appendChild(bar);







    metricsRow.append(labels, progress);







    // ----- صف الإجراءات -----



    const actions = document.createElement('div');



    actions.className = 'pm2-actions-row';



    actions.append(



      createPm2Button('btn-action-teal', 'repeat', 'Restart',



        () => triggerPm2Action('restart', svc.id, name)),



      createPm2Button('btn-action-white', 'terminal', 'Logs',



        () => openLogsModal(name)),



      createPm2Button('btn-action-stop', isOnline ? 'stop-circle' : 'play', isOnline ? 'Stop' : 'Start',



        () => triggerPm2Action(isOnline ? 'stop' : 'start', svc.id, name))



    );







    card.append(top, metricsRow, actions);



    if (state.user?.role !== 'admin' && !state.user?.permissions?.includes('processes')) actions.hidden = true;



    container.appendChild(card);



  });







  if (window.feather) feather.replace();



}







async function triggerPm2Action(action, id, name) {



  try {



    showToast(`Executing PM2 ${action} on ${name}...`, 'success');



    const res = await fetch('/api/pm2/action', {



      method: 'POST',



      headers: { 'Content-Type': 'application/json' },



      body: JSON.stringify({ action, id, name })



    });



    const data = await res.json();



    if (data.success) {



      showToast(`PM2 ${action} completed successfully`, 'success');



      fetchPm2();



    } else {



      showToast(data.error || 'Failed to execute PM2 action', 'error');



    }



  } catch (err) {



    showToast(err.message, 'error');



  }



}







if (elements.btnRestartAllPm2) {



  elements.btnRestartAllPm2.addEventListener('click', () => triggerPm2Action('restart_all'));



}



if (elements.btnRestartAllPm2Full) {



  elements.btnRestartAllPm2Full.addEventListener('click', () => triggerPm2Action('restart_all'));



}







// PM2 Logs & AI Error Analysis



async function openLogsModal(name) {



  state.activeLogsService = name;



  if (elements.logsModalTitle) elements.logsModalTitle.textContent = `Logs: ${name}`;



  if (elements.logsContentBox) elements.logsContentBox.textContent = `Fetching live logs for ${name} via SSH...`;



  if (elements.aiAnalysisBox) {



    elements.aiAnalysisBox.style.display = 'none';



    elements.aiAnalysisBox.innerHTML = '';



  }



  elements.logsModal.classList.add('active');







  try {



    const currentServer = state.currentServer;



    let logsText = '';



    if (currentServer && currentServer.isReal) {



      const res = await fetch('/api/copilot/analyze-error', {



        method: 'POST',



        headers: { 'Content-Type': 'application/json' },



        body: JSON.stringify({ serviceName: name })



      });



      const data = await res.json();



      logsText = data.errorLogs || 'No errors logged.';



    } else {



      logsText = `[PM2] Application ${name} status: online\nRestarts count: 12\nScript PID: 36516 active`;



    }



    if (elements.logsContentBox) elements.logsContentBox.textContent = logsText;



  } catch (err) {



    if (elements.logsContentBox) elements.logsContentBox.textContent = 'Error fetching logs: ' + err.message;



  }



}







function closeLogsModal() {



  if (elements.logsModal) elements.logsModal.classList.remove('active');



}







/**



 * يبني صندوق نتيجة تحليل Gemini عبر DOM.



 * نص التحليل والأوامر مخرجات نموذج لغوي (غير موثوقة): النص يُعرض كـ textContent،



 * والأوامر تُمرَّر كمصفوفة حقيقية إلى executePlanCommands بدل دمجها في onclick.



 */



function renderAiAnalysis(box, data) {



  box.innerHTML = '';



  box.style.display = 'block';







  const header = document.createElement('div');



  header.style.fontWeight = '700';



  header.style.color = '#0f766e';



  header.style.display = 'flex';



  header.style.alignItems = 'center';



  header.style.gap = '6px';



  header.style.marginBottom = '8px';



  const headerIcon = document.createElement('i');



  headerIcon.setAttribute('data-feather', 'cpu');



  header.append(headerIcon, document.createTextNode(' نتيجة تحليل الذكاء الاصطناعي (Gemini):'));







  const paragraph = document.createElement('p');



  paragraph.style.fontSize = '13px';



  paragraph.style.color = '#1e293b';



  paragraph.style.lineHeight = '1.5';



  paragraph.style.marginBottom = '10px';



  paragraph.style.whiteSpace = 'pre-wrap';



  paragraph.style.overflowWrap = 'anywhere';



  paragraph.textContent = String(data.analysis ?? 'لا يوجد تحليل متاح.');







  box.append(header, paragraph);







  const commands = Array.isArray(data.commands)



    ? data.commands.filter(cmd => typeof cmd === 'string' && cmd.trim())



    : [];



  if (commands.length === 0) return;







  const actions = document.createElement('div');



  actions.style.display = 'flex';



  actions.style.gap = '8px';



  actions.style.flexWrap = 'wrap';







  const applyBtn = document.createElement('button');



  applyBtn.type = 'button';



  applyBtn.className = 'btn-teal-pill';



  applyBtn.style.fontSize = '12px';



  applyBtn.style.padding = '4px 12px';



  const playIcon = document.createElement('i');



  playIcon.setAttribute('data-feather', 'play');



  applyBtn.append(playIcon, document.createTextNode(' تطبيق أوامر الإصلاح فوراً'));



  applyBtn.addEventListener('click', () => executePlanCommands(commands));







  actions.appendChild(applyBtn);



  box.appendChild(actions);



}







if (elements.btnAnalyzeLogsAi) {



  elements.btnAnalyzeLogsAi.addEventListener('click', async () => {



    if (!state.activeLogsService) return;



    elements.btnAnalyzeLogsAi.innerHTML = `<i data-feather="loader"></i> Analyzing...`;



    if (window.feather) feather.replace();







    try {



      const res = await fetch('/api/copilot/analyze-error', {



        method: 'POST',



        headers: { 'Content-Type': 'application/json' },



        body: JSON.stringify({ serviceName: state.activeLogsService })



      });



      const data = await res.json();



      if (data.success && elements.aiAnalysisBox) {



        renderAiAnalysis(elements.aiAnalysisBox, data);



        if (window.feather) feather.replace();



      }



    } catch (e) {



      showToast('AI analysis failed: ' + e.message, 'error');



    } finally {



      elements.btnAnalyzeLogsAi.innerHTML = `<i data-feather="zap"></i> AI Analyze & Fix`;



      if (window.feather) feather.replace();



    }



  });



}







// ==========================================



// 6. CLOUD FILES & MONACO EDITOR (IDE)



// ==========================================



function setupFilesManager() {



  // Quick Path Jump



  document.querySelectorAll('.path-jump-pill').forEach(pill => {



    pill.addEventListener('click', () => {



      document.querySelectorAll('.path-jump-pill').forEach(p => p.classList.remove('active'));



      pill.classList.add('active');



      const p = pill.getAttribute('data-path');



      fetchFiles(p);



    });



  });







  // Directory Up



  if (elements.btnDirUp) {



    elements.btnDirUp.addEventListener('click', () => {



      if (state.currentPath === '/' || state.currentPath === '') return;



      const parts = state.currentPath.split('/').filter(Boolean);



      parts.pop();



      const parent = '/' + parts.join('/');



      fetchFiles(parent || '/');



    });



  }







  // Search Filter



  if (elements.fileSearchInput) {



    elements.fileSearchInput.addEventListener('input', (e) => {



      const q = e.target.value.toLowerCase();



      const filtered = state.files.filter(f => f.name.toLowerCase().includes(q));



      renderFilesTable(filtered);



    });



  }







  // Upload trigger



  if (elements.btnUploadTrigger && elements.fileUploadInput) {



    elements.btnUploadTrigger.addEventListener('click', () => elements.fileUploadInput.click());



    elements.fileUploadInput.addEventListener('change', (e) => handleFileUpload(e.target.files));



  }







  // Drag & Drop Upload



  if (elements.filesDropZone) {



    ['dragenter', 'dragover'].forEach(eventName => {



      elements.filesDropZone.addEventListener(eventName, (e) => {



        e.preventDefault();



        elements.filesDropZone.style.borderColor = 'var(--mint-600)';



        elements.filesDropZone.style.background = 'rgba(13, 148, 136, 0.03)';



      });



    });



    ['dragleave', 'drop'].forEach(eventName => {



      elements.filesDropZone.addEventListener(eventName, (e) => {



        e.preventDefault();



        elements.filesDropZone.style.borderColor = '';



        elements.filesDropZone.style.background = '';



      });



    });



    elements.filesDropZone.addEventListener('drop', (e) => {



      if (e.dataTransfer && e.dataTransfer.files) {



        handleFileUpload(e.dataTransfer.files);



      }



    });



  }







  // New File & Folder



  if (elements.btnNewFile) {



    elements.btnNewFile.addEventListener('click', () => {



      const name = prompt('Enter new file name:');



      if (name) createNewFileOrFolder(name, 'file');



    });



  }



  if (elements.btnNewFolder) {



    elements.btnNewFolder.addEventListener('click', () => {



      const name = prompt('Enter new folder name:');



      if (name) createNewFileOrFolder(name, 'dir');



    });



  }







  // Save File Button



  if (elements.btnSaveFileContent) {



    elements.btnSaveFileContent.addEventListener('click', saveActiveFileContent);



  }



}







async function fetchFiles(targetPath) {



  state.currentPath = targetPath;



  if (elements.breadcrumbPath) elements.breadcrumbPath.textContent = targetPath;



  if (elements.filesFooterCount) elements.filesFooterCount.textContent = 'Loading items...';







  try {



    const res = await fetch(`/api/files?path=${encodeURIComponent(targetPath)}`);



    const data = await res.json();



    if (data.success && data.items) {



      state.files = data.items;



      renderFilesTable(data.items);



      if (elements.filesFooterCount) {



        elements.filesFooterCount.textContent = `${targetPath} • ${data.items.length} Items`;



      }



    }



  } catch (err) {



    showToast('Failed to fetch remote directory: ' + err.message, 'error');



  }



}







/** زر أيقونة لعمليات الملفات، مع عنوان وتسمية للقارئات الشاشية. */



function createFileActionButton({ title, icon, extraClass, onClick }) {



  const btn = document.createElement('button');



  btn.type = 'button';



  btn.className = extraClass ? `btn-file-icon-action ${extraClass}` : 'btn-file-icon-action';



  btn.title = title;



  btn.setAttribute('aria-label', title);







  const glyph = document.createElement('i');



  glyph.setAttribute('data-feather', icon);



  glyph.style.width = '14px';



  glyph.style.height = '14px';



  btn.appendChild(glyph);







  btn.addEventListener('click', onClick);



  return btn;



}







function renderFilesTable(items) {



  if (!elements.filesTableBody) return;



  elements.filesTableBody.innerHTML = '';







  if (!items || items.length === 0) {



    const emptyRow = document.createElement('tr');



    const emptyCell = document.createElement('td');



    emptyCell.colSpan = 4;



    emptyCell.style.textAlign = 'center';



    emptyCell.style.color = 'var(--text-muted)';



    emptyCell.style.padding = '24px';



    emptyCell.textContent = 'This folder is empty.';



    emptyRow.appendChild(emptyCell);



    elements.filesTableBody.appendChild(emptyRow);



    return;



  }







  items.forEach(f => {



    const isDir = f.type === 'dir';



    const fileName = String(f.name ?? '');



    const tr = document.createElement('tr');







    // أسماء الملفات بيانات لا HTML: بناء العقد يدويًا يمنع XSS مخزَّن من اسم ملف مُلفَّق.



    const nameCell = document.createElement('td');



    const nameWrap = document.createElement('div');



    nameWrap.className = 'file-name-cell';



    nameWrap.setAttribute('role', 'button');



    nameWrap.tabIndex = 0;



    nameWrap.title = fileName;







    const icon = document.createElement('i');



    icon.setAttribute('data-feather', isDir ? 'folder' : 'file-text');



    icon.style.color = isDir ? '#f59e0b' : 'var(--mint-600)';







    const label = document.createElement('span');



    label.textContent = fileName;







    nameWrap.append(icon, label);







    const openItem = () => (isDir ? navigateToDir(fileName) : openMonacoEditor(fileName));



    nameWrap.addEventListener('click', openItem);



    nameWrap.addEventListener('keydown', event => {



      if (event.key === 'Enter' || event.key === ' ') {



        event.preventDefault();



        openItem();



      }



    });



    nameCell.appendChild(nameWrap);







    const sizeCell = document.createElement('td');



    sizeCell.textContent = f.size || '--';







    const modifiedCell = document.createElement('td');



    modifiedCell.textContent = f.modified || '--';







    const actionsCell = document.createElement('td');



    actionsCell.style.textAlign = 'right';



    const actionsWrap = document.createElement('div');



    actionsWrap.style.display = 'flex';



    actionsWrap.style.gap = '4px';



    actionsWrap.style.justifyContent = 'flex-end';







    if (!isDir) {



      actionsWrap.appendChild(createFileActionButton({



        title: 'Download via SFTP',



        icon: 'download',



        onClick: () => downloadFile(fileName)



      }));



      actionsWrap.appendChild(createFileActionButton({



        title: 'Edit in Monaco IDE',



        icon: 'edit-2',



        onClick: () => openMonacoEditor(fileName)



      }));



    }







    actionsWrap.appendChild(createFileActionButton({



      title: 'Delete Item',



      icon: 'trash-2',



      extraClass: 'del',



      onClick: () => deleteFileOrFolder(fileName)



    }));







    actionsCell.appendChild(actionsWrap);



    tr.append(nameCell, sizeCell, modifiedCell, actionsCell);



    elements.filesTableBody.appendChild(tr);



  });







  if (window.feather) feather.replace();



}







function navigateToDir(subDir) {



  const newPath = state.currentPath === '/' ? `/${subDir}` : `${state.currentPath}/${subDir}`;



  fetchFiles(newPath);



}







// SFTP File Upload



async function handleFileUpload(fileList) {



  if (!fileList || fileList.length === 0) return;







  for (let i = 0; i < fileList.length; i++) {



    const file = fileList[i];



    const formData = new FormData();



    formData.append('file', file);



    formData.append('path', state.currentPath);







    showToast(`Uploading ${file.name} to ${state.currentPath}...`, 'success');







    try {



      const res = await fetch('/api/files/upload', {



        method: 'POST',



        body: formData



      });



      const data = await res.json();



      if (data.success) {



        showToast(`Uploaded ${file.name} successfully`, 'success');



      } else {



        showToast(data.error || 'Upload error', 'error');



      }



    } catch (e) {



      showToast(`Upload failed: ${e.message}`, 'error');



    }



  }







  fetchFiles(state.currentPath);



}







// SFTP File Download



function downloadFile(name) {



  // التنزيل يتم بتنقّل المتصفح، لذا يُمرَّر التوكن في الـ query (يقبله الخادم).



  const params = new URLSearchParams({ path: state.currentPath, name: String(name) });



  const token = getPanelToken();



  if (token) params.set('token', token);



  if (state.serverId) params.set('serverId', state.serverId);



  window.location.href = `/api/files/download?${params.toString()}`;



}







// SFTP Delete



async function deleteFileOrFolder(name) {



  if (!confirm(`Are you sure you want to delete ${name}?`)) return;



  try {



    const res = await fetch('/api/files/delete', {



      method: 'POST',



      headers: { 'Content-Type': 'application/json' },



      body: JSON.stringify({ path: state.currentPath, name })



    });



    const data = await res.json();



    if (data.success) {



      showToast(`Deleted ${name}`, 'success');



      fetchFiles(state.currentPath);



    } else {



      showToast(data.error || 'Delete failed', 'error');



    }



  } catch (e) {



    showToast(e.message, 'error');



  }



}







// SFTP Create File or Folder



async function createNewFileOrFolder(name, type) {



  try {



    const endpoint = type === 'dir' ? '/api/files/create-folder' : '/api/files/write';



    const body = type === 'dir'



      ? { path: state.currentPath, name }



      : { path: state.currentPath, name, content: '' };







    const res = await fetch(endpoint, {



      method: 'POST',



      headers: { 'Content-Type': 'application/json' },



      body: JSON.stringify(body)



    });



    const data = await res.json();



    if (data.success) {



      showToast(`Created ${name}`, 'success');



      fetchFiles(state.currentPath);



      if (type === 'file') openMonacoEditor(name);



    } else {



      showToast(data.error || 'Creation failed', 'error');



    }



  } catch (e) {



    showToast(e.message, 'error');



  }



}







// Monaco Editor Loader & Manager



function openMonacoEditor(fileName) {



  state.activeEditingFile = fileName;



  if (elements.editorModalTitle) elements.editorModalTitle.textContent = `Editing: ${fileName}`;



  elements.editorModal.classList.add('active');







  const ext = fileName.split('.').pop().toLowerCase();



  let lang = 'plaintext';



  if (['js', 'mjs', 'cjs'].includes(ext)) lang = 'javascript';



  else if (['json'].includes(ext)) lang = 'json';



  else if (['html', 'htm'].includes(ext)) lang = 'html';



  else if (['css', 'scss'].includes(ext)) lang = 'css';



  else if (['sh', 'bash'].includes(ext)) lang = 'shell';



  else if (['yml', 'yaml'].includes(ext)) lang = 'yaml';



  else if (['env', 'ini', 'conf'].includes(ext)) lang = 'ini';



  else if (['py'].includes(ext)) lang = 'python';



  else if (['sql'].includes(ext)) lang = 'sql';







  if (elements.editorLanguageBadge) elements.editorLanguageBadge.textContent = lang.toUpperCase();







  // Fetch file content via SFTP



  fetch('/api/files/read', {



    method: 'POST',



    headers: { 'Content-Type': 'application/json' },



    body: JSON.stringify({ path: state.currentPath, name: fileName })



  })



    .then(r => r.json())



    .then(data => {



      const content = data.file ? (data.file.content || '') : '';



      mountMonacoEditor(content, lang);



    })



    .catch(err => {



      mountMonacoEditor(`// Error reading file: ${err.message}`, 'plaintext');



    });



}







function mountMonacoEditor(content, language) {



  if (state.monacoEditor) {



    state.monacoEditor.setValue(content);



    if (window.monaco) {



      window.monaco.editor.setModelLanguage(state.monacoEditor.getModel(), language);



    }



    return;



  }







  if (typeof require !== 'undefined') {



    require.config({ paths: { vs: 'https://cdnjs.cloudflare.com/ajax/libs/monaco-editor/0.45.0/min/vs' } });



    require(['vs/editor/editor.main'], function () {



      state.monacoEditor = monaco.editor.create(elements.monacoEditorHost, {



        value: content,



        language: language,



        theme: 'vs-dark',



        fontSize: 13,



        fontFamily: 'JetBrains Mono, Menlo, monospace',



        automaticLayout: true,



        minimap: { enabled: true },



        scrollBeyondLastLine: false



      });







      // Ctrl+S keybinding



      state.monacoEditor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {



        saveActiveFileContent();



      });



    });



  }



}







async function saveActiveFileContent() {



  if (!state.activeEditingFile || !state.monacoEditor) return;



  const content = state.monacoEditor.getValue();







  try {



    showToast(`Saving ${state.activeEditingFile}...`, 'success');



    const res = await fetch('/api/files/write', {



      method: 'POST',



      headers: { 'Content-Type': 'application/json' },



      body: JSON.stringify({



        path: state.currentPath,



        name: state.activeEditingFile,



        content



      })



    });



    const data = await res.json();



    if (data.success) {



      showToast(`File ${state.activeEditingFile} saved via SFTP!`, 'success');



    } else {



      showToast(data.error || 'Error saving file', 'error');



    }



  } catch (e) {



    showToast(e.message, 'error');



  }



}







function closeEditorModal() {



  if (elements.editorModal) elements.editorModal.classList.remove('active');



  state.activeEditingFile = null;



}







// ==========================================



// 7. REAL GEMINI AI COPILOT



// ==========================================



function setupCopilot() {



  if (elements.copilotForm) {



    elements.copilotForm.addEventListener('submit', async (e) => {



      e.preventDefault();



      const txt = elements.copilotInput.value.trim();



      if (!txt) return;







      appendChatBubble('user', txt);



      elements.copilotInput.value = '';







      // Typing placeholder



      const aiBubble = appendChatBubble('ai', `<div style="display:flex;align-items:center;gap:6px;"><i data-feather="loader" class="spinning"></i> جاري التحليل وصياغة الحل الذكي...</div>`);



      if (window.feather) feather.replace();







      try {



        const res = await fetch('/api/copilot/chat', {



          method: 'POST',



          headers: { 'Content-Type': 'application/json' },



          body: JSON.stringify({ message: txt })



        });



        const data = await res.json();



        aiBubble.remove();







        if (!data.success) {



          appendChatBubble('ai', `<span style="color:#ef4444;">${escapeHtml(data.error || 'تعذّر تنفيذ الطلب.')}</span>`);



        } else if (data.replyType === 'verified_plan') {



          renderVerifiedPlanBubble(data);



        } else {



          // ردّ النموذج نص غير موثوق: يُهرَّب ثم تُحفظ فواصل الأسطر فقط.



          appendChatBubble('ai', `<div style="white-space: pre-wrap;">${escapeHtml(data.message || 'تمت معالجة الطلب.')}</div>`);



        }



      } catch (err) {



        aiBubble.innerHTML = `<span style="color:#ef4444;">حدث خطأ أثناء الاتصال بالذكاء الاصطناعي: ${escapeHtml(err.message)}</span>`;



      }



    });



  }







  if (elements.btnCopilotClear) {



    elements.btnCopilotClear.addEventListener('click', () => {



      elements.copilotChatScroll.innerHTML = '';



      showToast('Chat history cleared', 'success');



    });



  }







  if (elements.btnCopilotKeyModal) {



    elements.btnCopilotKeyModal.addEventListener('click', () => switchView('settings'));



  }



}







async function checkGeminiConfig() {



  try {



    const res = await fetch('/api/copilot/config');



    const data = await res.json();



    state.hasGeminiKey = data.hasKey;



    if (elements.copilotAiStatus) {



      if (data.hasKey) {



        elements.copilotAiStatus.textContent = 'Gemini 1.5 Live 🟢';



        elements.copilotAiStatus.style.background = 'var(--mint-100)';



      } else {



        elements.copilotAiStatus.textContent = 'Local Mode 🟡';



      }



    }



  } catch (e) { }



}







function appendChatBubble(role, htmlContent) {



  const bubble = document.createElement('div');



  bubble.className = `chat-bubble ${role}`;



  bubble.innerHTML = htmlContent;



  elements.copilotChatScroll.appendChild(bubble);



  elements.copilotChatScroll.scrollTop = elements.copilotChatScroll.scrollHeight;



  if (window.feather) feather.replace();



  return bubble;



}







function renderVerifiedPlanBubble(plan) {



  const bubble = document.createElement('div');



  bubble.className = 'chat-bubble ai';







  const commands = (Array.isArray(plan.commands) ? plan.commands : [])



    .filter(cmd => typeof cmd === 'string' && cmd.trim());



  const commandsHtml = commands.map(cmd =>



    `<div class="cmd-line-item"><span class="prompt-symbol">&gt;_</span> ${escapeHtml(cmd)}</div>`



  ).join('');







  bubble.innerHTML = `



    <div class="verified-plan-card">



      <div class="plan-card-header">



        <div class="plan-title-box">



          <div class="plan-title-icon"><i data-feather="check-square"></i></div>



          <span class="plan-title-text">${escapeHtml(plan.title)}</span>



        </div>



        <span class="badge-verified-plan">Verified Plan</span>



      </div>







      <p class="plan-explanation-p" style="white-space: pre-wrap;">${escapeHtml(plan.description)}</p>



      <div class="plan-commands-block">${commandsHtml}</div>







      <div class="plan-actions-footer">



        <button type="button" class="btn-execute-plan" data-role="run-plan">



          <i data-feather="play" style="width: 14px; height: 14px; fill: white;"></i> تنفيذ الإجراء فوراً



        </button>



        <button type="button" class="btn-dismiss-plan" data-role="dismiss-plan">إلغاء</button>



      </div>



    </div>



  `;



  // الأوامر تُمرَّر كمصفوفة حقيقية، لا تُدمج في onclick.



  bubble.querySelector('[data-role="run-plan"]').addEventListener('click', () => executePlanCommands(commands));



  bubble.querySelector('[data-role="dismiss-plan"]').addEventListener('click', () => bubble.remove());







  elements.copilotChatScroll.appendChild(bubble);



  elements.copilotChatScroll.scrollTop = elements.copilotChatScroll.scrollHeight;



  if (window.feather) feather.replace();



}







function executePlanCommands(commands) {



  if (!commands || commands.length === 0) return;



  switchView('terminal');



  showToast(`جاري تشغيل ${commands.length} أمر في الـ SSH Terminal...`, 'success');







  const combined = commands.join(' && ') + '\n';



  if (state.socket && state.socket.readyState === WebSocket.OPEN) {



    state.socket.send(JSON.stringify({ type: 'pty_input', data: combined }));



  }



}







// ==========================================



// 8. INFRASTRUCTURE (DOCKER, NGINX & SSL)



// ==========================================



function setupInfra() {



  if (elements.btnRefreshInfra) {



    elements.btnRefreshInfra.addEventListener('click', fetchInfraOverview);



  }







  // Nginx test & reload



  if (elements.btnNginxTest) {



    elements.btnNginxTest.addEventListener('click', async () => {



      showToast('Testing Nginx configuration...', 'success');



      const res = await fetch('/api/infra/nginx/action', {



        method: 'POST',



        headers: { 'Content-Type': 'application/json' },



        body: JSON.stringify({ action: 'test' })



      });



      const data = await res.json();



      alert(`Nginx Test Output:\n${data.output}`);



    });



  }







  if (elements.btnNginxReload) {



    elements.btnNginxReload.addEventListener('click', async () => {



      showToast('Reloading Nginx...', 'success');



      const res = await fetch('/api/infra/nginx/action', {



        method: 'POST',



        headers: { 'Content-Type': 'application/json' },



        body: JSON.stringify({ action: 'reload' })



      });



      const data = await res.json();



      showToast(data.message || 'Nginx reloaded', 'success');



    });



  }







  // SSL form



  if (elements.sslIssueForm) {



    elements.sslIssueForm.addEventListener('submit', async (e) => {



      e.preventDefault();



      const domain = elements.sslDomainInput.value.trim();



      const email = elements.sslEmailInput.value.trim();



      if (!domain) return;







      if (elements.sslOutputLog) elements.sslOutputLog.textContent = `Issuing Let's Encrypt SSL certificate for ${domain}...`;



      try {



        const res = await fetch('/api/infra/ssl/issue', {



          method: 'POST',



          headers: { 'Content-Type': 'application/json' },



          body: JSON.stringify({ domain, email })



        });



        const data = await res.json();



        if (elements.sslOutputLog) elements.sslOutputLog.textContent = data.output || data.message;



        showToast('Certbot process finished!', 'success');



      } catch (err) {



        if (elements.sslOutputLog) elements.sslOutputLog.textContent = 'Error: ' + err.message;



      }



    });



  }



}







async function fetchInfraOverview() {



  try {



    const res = await fetch('/api/infra/overview');



    const data = await res.json();







    // 1. Docker



    if (elements.dockerStatusBadge) {



      elements.dockerStatusBadge.textContent = data.docker && data.docker.installed ? 'Installed & Ready' : 'Not Installed';



    }



    if (elements.dockerContainersContainer) {



      const containers = data.docker?.containers || [];



      if (containers.length === 0) {



        elements.dockerContainersContainer.innerHTML = `<p style="color: var(--text-muted); font-size: 13px;">No running Docker containers found on remote host.</p>`;



      } else {



        elements.dockerContainersContainer.innerHTML = containers.map(c => `



          <div style="display: flex; align-items: center; justify-content: space-between; padding: 10px 14px; background: #fff; border: 1px solid var(--border-color); border-radius: 10px; margin-bottom: 8px;">



            <div>



              <div style="font-weight: 700; font-size: 14px;">${escapeHtml(c.name)} <span style="font-size: 11px; color: var(--text-muted); font-family: var(--font-mono);">${escapeHtml(c.id)}</span></div>



              <div style="font-size: 12px; color: var(--text-muted);">${escapeHtml(c.image)} • ${escapeHtml(c.status)} • ports: ${escapeHtml(c.ports)}</div>



            </div>



            <div style="display: flex; gap: 6px;">



              ${c.state === 'running' || /^Up/.test(String(c.status)) ? `



                <button class="btn-action-teal" title="Restart" aria-label="Restart ${escapeHtml(c.name)}" onclick="triggerDockerAction('${safeId(c.id)}', 'restart')"><i data-feather="repeat"></i></button>



                <button class="btn-action-stop" title="Stop" aria-label="Stop ${escapeHtml(c.name)}" onclick="triggerDockerAction('${safeId(c.id)}', 'stop')"><i data-feather="stop-circle"></i></button>



              ` : `



                <button class="btn-action-teal" title="Start" aria-label="Start ${escapeHtml(c.name)}" onclick="triggerDockerAction('${safeId(c.id)}', 'start')"><i data-feather="play"></i></button>



              `}



            </div>



          </div>



        `).join('');



      }



    }







    // 2. Nginx



    if (elements.nginxSitesContainer) {



      const sites = data.nginx?.sites || [];



      elements.nginxSitesContainer.innerHTML = `



        <div style="display: flex; gap: 8px; flex-wrap: wrap;">



          ${sites.length === 0 ? '<span style="font-size: 13px; color: var(--text-muted);">No enabled sites.</span>' : ''}



          ${sites.map(s => `<span class="badge-pill-mint" style="font-size: 12px; padding: 4px 10px;"><i data-feather="globe" style="width: 12px; height: 12px; margin-right: 4px;"></i> ${escapeHtml(s)}</span>`).join('')}



        </div>



      `;



    }







    if (window.feather) feather.replace();



  } catch (err) { }



}







async function triggerDockerAction(containerId, action) {



  try {



    showToast(`Docker ${action} ${containerId}...`, 'success');



    const res = await fetch('/api/infra/docker/action', {



      method: 'POST',



      headers: { 'Content-Type': 'application/json' },



      body: JSON.stringify({ containerId, action })



    });



    const data = await res.json();



    if (data.success) {



      showToast(`Docker ${action} executed`, 'success');



      fetchInfraOverview();



    } else {



      showToast(data.error || 'Failed', 'error');



    }



  } catch (e) {



    showToast(e.message, 'error');



  }



}







// ==========================================



// 9. SETTINGS, WEBHOOKS & NOTIFICATIONS



// ==========================================



function setupSettingsAndAlerts() {



  // Fetch Alerts Config



  fetch('/api/alerts/config')



    .then(r => r.json())



    .then(data => {



      if (data.success && data.alerts) {



        const a = data.alerts;



        if (elements.chkAlertsEnabled) elements.chkAlertsEnabled.checked = !!a.enabled;



        if (elements.txtDiscordWebhook) elements.txtDiscordWebhook.value = a.discordWebhookUrl || '';



        if (elements.txtTelegramToken) elements.txtTelegramToken.value = a.telegramBotToken || '';



        if (elements.txtTelegramChatId) elements.txtTelegramChatId.value = a.telegramChatId || '';



        if (elements.numCpuThreshold) elements.numCpuThreshold.value = a.cpuThreshold || 85;



        if (elements.numRamThreshold) elements.numRamThreshold.value = a.ramThreshold || 90;



      }



    });







  // Save Alerts Form



  if (elements.alertsConfigForm) {



    elements.alertsConfigForm.addEventListener('submit', async (e) => {



      e.preventDefault();



      const payload = {



        enabled: elements.chkAlertsEnabled.checked,



        discordWebhookUrl: elements.txtDiscordWebhook.value.trim(),



        telegramBotToken: elements.txtTelegramToken.value.trim(),



        telegramChatId: elements.txtTelegramChatId.value.trim(),



        cpuThreshold: parseInt(elements.numCpuThreshold.value) || 85,



        ramThreshold: parseInt(elements.numRamThreshold.value) || 90



      };







      try {



        const res = await fetch('/api/alerts/config', {



          method: 'POST',



          headers: { 'Content-Type': 'application/json' },



          body: JSON.stringify(payload)



        });



        const data = await res.json();



        if (data.success) {



          showToast('Alerts and Webhook settings saved!', 'success');



        }



      } catch (err) {



        showToast('Error saving alerts: ' + err.message, 'error');



      }



    });



  }







  // Test Alert Trigger



  if (elements.btnTestAlerts) {



    elements.btnTestAlerts.addEventListener('click', async () => {



      showToast('Dispatching test alert to Webhooks...', 'success');



      try {



        const res = await fetch('/api/alerts/test', { method: 'POST' });



        const data = await res.json();



        if (data.success) {



          showToast('Test notifications sent! Check Discord / Telegram.', 'success');



        }



      } catch (err) {



        showToast('Error sending test alert: ' + err.message, 'error');



      }



    });



  }







  // Save Gemini Key Form



  if (elements.geminiKeyForm) {



    elements.geminiKeyForm.addEventListener('submit', async (e) => {



      e.preventDefault();



      const apiKey = elements.txtGeminiKey.value.trim();



      try {



        const res = await fetch('/api/copilot/config', {



          method: 'POST',



          headers: { 'Content-Type': 'application/json' },



          body: JSON.stringify({ apiKey })



        });



        const data = await res.json();



        if (data.success) {



          showToast('Gemini API Key saved and activated! 🤖', 'success');



          checkGeminiConfig();



        }



      } catch (err) {



        showToast(err.message, 'error');



      }



    });



  }







  // Add Server Form



  if (elements.btnAddNewServer) {



    elements.btnAddNewServer.addEventListener('click', () => {



      elements.serverModal.classList.add('active');



    });



  }







  if (elements.addServerForm) {



    elements.addServerForm.addEventListener('submit', async (e) => {



      e.preventDefault();



      const payload = {



        name: document.getElementById('newSrvName').value.trim(),



        host: document.getElementById('newSrvHost').value.trim(),



        port: document.getElementById('newSrvPort').value.trim(),



        username: document.getElementById('newSrvUser').value.trim(),



        // كلمات المرور قد تبدأ أو تنتهي بمسافة: لا تُقصّ.



        password: document.getElementById('newSrvPass').value



      };







      showToast(`Connecting to ${payload.name}...`, 'success');



      try {



        const res = await fetch('/api/servers', {



          method: 'POST',



          headers: { 'Content-Type': 'application/json' },



          body: JSON.stringify(payload)



        });



        const data = await res.json();



        if (data.success) {



          showToast('Server added and connected successfully!', 'success');



          state.serverId = data.server.id;



          closeServerModal();



          await fetchServers();



          if (state.socket) state.socket.close();



          setupWebSocket();



          if (window.OperationsUI) OperationsUI.refresh();



          fetchMetrics();



        } else {



          showToast(data.error || 'Could not connect', 'error');



        }



      } catch (err) {



        showToast(err.message, 'error');



      }



    });



  }



}







async function fetchServers() {



  try {



    const res = await fetch('/api/servers');



    const data = await res.json();



    if (data.success && data.servers) {



      state.servers = data.servers;



      state.serverId = data.servers.some(server => server.id === data.activeId) ? data.activeId : '';



      state.currentServer = data.servers.find(server => server.id === data.activeId) || null;



      renderServersList(data.servers, data.activeId);



    }



  } catch (e) { }



}







function renderServersList(servers, activeId) {



  if (!elements.serversListContainer) return;



  elements.serversListContainer.innerHTML = '';







  servers.forEach(srv => {



    const isCurrent = srv.id === activeId;



    const card = document.createElement('div');



    card.style.cssText = `



      padding: 14px 18px;



      background: #fff;



      border: 1px solid ${isCurrent ? 'var(--mint-500)' : 'var(--border-color)'};



      border-radius: 12px;



      display: flex;



      align-items: center;



      justify-content: space-between;



    `;



    card.innerHTML = `



      <div style="display: flex; align-items: center; gap: 12px;">



        <div style="width: 40px; height: 40px; border-radius: 10px; background: ${isCurrent ? 'var(--mint-100)' : '#f1f5f9'}; color: ${isCurrent ? 'var(--mint-700)' : '#64748b'}; display: flex; align-items: center; justify-content: center;">



          <i data-feather="server"></i>



        </div>



        <div>



          <div style="font-size: 15px; font-weight: 700; color: var(--text-primary);">



            ${escapeHtml(srv.name)} ${isCurrent ? '<span class="badge-pill-mint" style="font-size: 10px; padding: 2px 8px; margin-left: 6px;">Active</span>' : ''}



          </div>



          <div style="font-size: 12px; color: var(--text-muted);">${escapeHtml(srv.username)}@${escapeHtml(srv.host)}:${escapeHtml(srv.port)} • ${escapeHtml(srv.status)}${srv.hasPrivateKey ? ' • key auth' : ''}</div>



        </div>



      </div>



      <div style="display: flex; align-items: center; gap: 8px;">



        ${!isCurrent ? `<button class="btn-teal-pill" style="font-size: 12px; padding: 6px 14px;" onclick="selectServer('${safeId(srv.id)}')">Select</button>` : '<span style="font-size: 12px; font-weight: 700; color: var(--mint-600);">Connected</span>'}



        <button class="btn-action-white" title="Remove server" aria-label="Remove ${escapeHtml(srv.name)}" style="color: #ef4444;" onclick="removeServer('${safeId(srv.id)}')"><i data-feather="trash-2"></i></button>



      </div>



    `;



    elements.serversListContainer.appendChild(card);



  });







  if (window.feather) feather.replace();



}







async function selectServer(id) {



  try {



    const res = await fetch('/api/servers/select', {



      method: 'POST',



      headers: { 'Content-Type': 'application/json' },



      body: JSON.stringify({ id })



    });



    const data = await res.json();



    if (data.success) {



      state.serverId = id;



      state.currentServer = data.server;



      if (state.socket) state.socket.close();



      setupWebSocket();



      showToast('Switched active server', 'success');



      if (window.OperationsUI) OperationsUI.refresh();



      fetchServers();



      fetchMetrics();



      fetchPm2();



    }



  } catch (e) { }



}







async function removeServer(id) {



  const srv = (state.servers || []).find(s => s.id === id);



  if (!confirm(`Remove "${srv ? srv.name : id}" from the panel? Its stored credentials are deleted.`)) return;



  try {



    const res = await fetch(`/api/servers/${encodeURIComponent(id)}`, { method: 'DELETE' });



    const data = await res.json();



    if (data.success) {



      showToast('Server removed', 'success');



      if (state.serverId === id) {



        state.serverId = data.activeId || '';



        if (state.socket) state.socket.close();



        setupWebSocket();



      }



      await fetchServers();



      if (window.OperationsUI) OperationsUI.refresh();



      fetchMetrics();



      fetchPm2();



    } else {



      showToast(data.error || 'Could not remove server', 'error');



    }



  } catch (e) {



    showToast(e.message, 'error');



  }



}







function closeServerModal() {



  if (elements.serverModal) elements.serverModal.classList.remove('active');



}







// Toast Notifications



function showToast(message, type = 'success') {



  if (!elements.toastContainer) return;



  const t = document.createElement('div');



  t.className = `toast-msg ${type}`;



  t.innerHTML = `



    <i data-feather="${type === 'success' ? 'check-circle' : 'alert-circle'}" style="width: 16px; height: 16px;"></i>



    <span>${escapeHtml(message)}</span>



  `;



  t.setAttribute('role', type === 'error' ? 'alert' : 'status');



  elements.toastContainer.appendChild(t);



  while (elements.toastContainer.children.length > 3) elements.toastContainer.firstElementChild.remove();



  if (window.feather) feather.replace();







  setTimeout(() => {



    t.style.opacity = '0';



    t.style.transform = 'translateY(10px)';



    setTimeout(() => t.remove(), 300);



  }, 3500);



}



