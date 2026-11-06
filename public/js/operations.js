
window.OperationsUI = (() => {
  const $ = id => document.getElementById(id);
  const esc = value => escapeHtml(value);
  const can = permission => state.user?.role === 'admin' || (state.user?.role === 'operator' && state.user.permissions.includes(permission));
  const admin = () => state.user?.role === 'admin';
  let snapshot = { projects: [], plans: [], runs: [] };
  let users = [];
  let refreshing = false;
  let activeTab = 'deployments';
  let requestVersion = 0;
  let githubStatus = null;
  let githubRepos = [];
  let githubPage = 0;
  let githubHasMore = false;
  const time = value => value ? new Date(value).toLocaleString() : '—';
  const empty = message => `<p class="ops-empty">${esc(message)}</p>`;
  const button = (action, id, text, extra = '') => `<button type="button" class="ops-button" data-ops-action="${action}" data-id="${esc(id)}" ${extra}>${esc(text)}</button>`;
  const field = (name, title, placeholder = '', extra = '') => `<label>${title}<input name="${name}" placeholder="${placeholder}" ${extra}></label>`;
  const status = run => `<span class="ops-status" data-status="${esc(run.status)}">${esc(run.status)}</span>`;

  async function api(url, method = 'GET', body) {
    const response = await fetch(`/api${url}`, { method, ...(body !== undefined ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}) });
    const data = await response.json();
    if (!response.ok || !data.success) throw new Error(data.error || `Request failed (${response.status})`);
    return data;
  }
  function buildWorkspace() {
    $('view-operations').innerHTML = `
      <div class="ops-heading"><div><span class="ops-eyebrow">SERVEROPS / OPERATIONS</span><h2>Ship. Protect. Collaborate.</h2><p>Deploy your apps, protect your data and control who has access.</p></div>
        <div class="ops-account"><span id="opsIdentity"></span><button type="button" class="ops-button" data-ops-action="logout">Sign out</button></div></div>
      <div class="ops-toolbar"><label>Active server<select id="opsServer" aria-label="Active server"></select></label><button type="button" class="ops-button" data-ops-action="refresh">Refresh</button><span id="opsUpdated" role="status"></span></div>
      <p id="opsError" class="ops-error" role="alert" hidden></p>
      <div class="ops-summary" id="opsSummary"></div>
      <div class="ops-tabs" role="tablist" aria-label="Operations">
        <button type="button" role="tab" id="opsTab-deployments" aria-controls="opsPanel-deployments" data-ops-tab="deployments">Deployments</button>
        <button type="button" role="tab" id="opsTab-backups" aria-controls="opsPanel-backups" data-ops-tab="backups">Backups & restore</button>
        <button type="button" role="tab" id="opsTab-users" aria-controls="opsPanel-users" data-ops-tab="users" data-admin-only>Team</button>
        <button type="button" role="tab" id="opsTab-audit" aria-controls="opsPanel-audit" data-ops-tab="audit" data-admin-only>Activity</button>
      </div>
      <div role="tabpanel" id="opsPanel-deployments" aria-labelledby="opsTab-deployments">
        <div class="ops-github" data-admin-only>
          <div class="ops-github-heading"><span class="ops-github-mark" aria-hidden="true">⌘</span><div><h3>Connect your GitHub</h3><p id="opsGitHubStatus" role="status">Checking GitHub authorization…</p></div><div class="ops-actions"><button type="button" class="ops-button ops-github-authorize" data-ops-action="github-authorize" id="opsGitHubAuthorize">Authorize GitHub</button><button type="button" class="ops-button" data-ops-action="github-disconnect" id="opsGitHubDisconnect" hidden>Disconnect</button></div></div>
          <details id="opsGitHubSetup"><summary>OAuth app settings</summary><p class="ops-note">Register a GitHub OAuth app once, then authorize your account. The connection is shared by deployment administrators. GitHub will request repository access, including private repositories.</p><p class="ops-note"><a id="opsGitHubRegister" target="_blank" rel="noopener noreferrer">Create OAuth app on GitHub</a></p>
            <form id="opsGitHubForm" class="ops-form">
              ${field('clientId', 'Client ID', 'GitHub OAuth client ID', 'required autocomplete="off"')}
              ${field('clientSecret', 'Client secret', 'Leave empty to keep the saved secret', 'type="password" autocomplete="new-password"')}
              ${field('callbackUrl', 'Authorization callback URL', '', 'required type="url"')}
              <p class="ops-note">Use this exact callback URL in the OAuth app settings. The client secret stays encrypted on the panel.</p>
              <button class="btn-teal-pill" type="submit">Save OAuth settings</button>
            </form>
          </details>
        </div>
        <details class="ops-config" data-admin-only><summary>Connect a GitHub application</summary>
          <p>Authorize GitHub above, then choose a repository. The server needs Git, PM2 and any application build tools. The PM2 process must already exist.</p>
          <form id="opsDeployForm" class="ops-form">
            <label class="ops-repository-field">GitHub repository<select name="githubRepository" id="opsGitHubRepository" required disabled><option value="">Authorize GitHub to choose a repository</option></select><span id="opsGitHubRepoHelp" class="ops-note"></span></label>
            <div class="ops-actions"><button type="button" class="ops-button" data-ops-action="github-repositories" id="opsGitHubReloadRepos" disabled>Refresh repositories</button><button type="button" class="ops-button" data-ops-action="github-more" id="opsGitHubMore" hidden>Load more</button></div>
            ${field('name', 'Application name', 'Choose a repository to fill this automatically', 'required maxlength="80"')}
            ${field('branch', 'Branch', 'main', 'value="main" required')}
            ${field('directory', 'Application directory', '/srv/my-app', 'required')}
            ${field('processName', 'PM2 process name', 'my-app', 'required')}
            <div class="ops-checks"><label><input name="install" type="checkbox" checked> Install with npm ci</label><label><input name="build" type="checkbox"> Run npm run build</label></div>
            <button class="btn-teal-pill" type="submit" id="opsConnectGitHubApp" disabled>Connect application</button>
          </form>
        </details>
        <div id="opsProjects" class="ops-cards"></div>
        <h3 class="ops-section-title">Deployment history</h3><div id="opsDeployHistory" class="ops-history"></div>
      </div>
      <div role="tabpanel" id="opsPanel-backups" aria-labelledby="opsTab-backups" hidden>
        <details class="ops-config" data-admin-only><summary>Create a backup plan</summary>
          <p>Copies stay on the selected SSH server in a private backup directory. Schedules run while this panel is running; missed intervals produce one copy when it resumes. Databases use credentials already configured on the node.</p>
          <form id="opsBackupForm" class="ops-form">
            ${field('name', 'Backup name', 'Production data', 'required maxlength="80"')}
            <label>Type<select name="kind" id="opsBackupKind"><option value="files">Files / directory</option><option value="postgres">PostgreSQL</option><option value="mysql">MySQL / MariaDB</option></select></label>
            <label>Schedule<select name="schedule"><option value="manual">Manual only</option><option value="hourly">Every hour</option><option value="daily">Every 24 hours</option><option value="weekly">Every 7 days</option></select></label>
            ${field('retention', 'Copies to retain', '7', 'type="number" value="7" min="1" max="100" required')}
            <div id="opsFileFields">${field('source', 'Source directory', '/srv/my-app/data', 'required')}</div>
            <fieldset id="opsDatabaseFields" class="ops-db-fields" hidden disabled><legend>Database connection</legend>
              ${field('database', 'Database name', 'app', 'required')}${field('username', 'Database username', 'postgres', 'required')}
              ${field('host', 'Host', 'localhost', 'value="localhost" required')}${field('port', 'Port', '5432', 'type="number" min="1" max="65535"')}
              ${field('credentialsFile', 'Remote credentials file', '/root/.pgpass')}
              <p id="opsCredentialsHelp">PostgreSQL: optional .pgpass path. MySQL: required defaults file with a [client] section. The database client must be installed on the node.</p>
            </fieldset>
            <button class="btn-teal-pill" type="submit">Create backup plan</button>
          </form>
        </details>
        <div id="opsPlans" class="ops-cards"></div>
        <h3 class="ops-section-title">Backup & restore history</h3><p class="ops-note">Restoring files replaces matching files and keeps extra files. Database restores replace objects from the backup. A checksum is verified before restoring.</p><div id="opsBackupHistory" class="ops-history"></div>
      </div>
      <div role="tabpanel" id="opsPanel-users" aria-labelledby="opsTab-users" hidden>
        <details id="opsUserDetails" class="ops-config"><summary>Add or edit a teammate</summary>
          <form id="opsUserForm" class="ops-form"><input type="hidden" name="id">
            ${field('username', 'Username', 'teammate', 'required minlength="3" maxlength="48" autocomplete="off"')}
            ${field('password', 'Password (leave empty when editing to keep current password)', 'At least 12 characters', 'type="password" minlength="12" maxlength="256" autocomplete="new-password" required')}
            <label>Role<select name="role" id="opsUserRole"><option value="viewer">Viewer</option><option value="operator">Operator</option><option value="admin">Administrator — all servers and settings</option></select></label>
            <fieldset class="ops-checks" id="opsUserServers"><legend>Allowed servers</legend></fieldset>
            <fieldset class="ops-checks" id="opsUserPermissions"><legend>Operator permissions</legend></fieldset>
            <p class="ops-note">Viewers can monitor assigned servers. Operators can run approved tasks using the permissions below. Terminal, file access and infrastructure control can provide full control of the assigned node.</p>
            <div class="ops-actions"><button class="btn-teal-pill" type="submit" id="opsSaveUser">Create account</button>${button('cancel-user', '', 'Clear form')}</div>
          </form>
        </details><div id="opsUsers" class="ops-cards"></div>
      </div>
      <div role="tabpanel" id="opsPanel-audit" aria-labelledby="opsTab-audit" hidden><h3 class="ops-section-title">Who changed what</h3><div id="opsAudit" class="ops-history"></div></div>
      <dialog id="opsLogDialog" class="ops-log-dialog"><div class="ops-heading"><h3 id="opsLogTitle">Operation log</h3>${button('close-log', '', 'Close')}</div><pre id="opsLogText"></pre></dialog>`;
    $('opsIdentity').textContent = `${state.user?.username || 'owner'} · ${state.user?.role || 'admin'}`;
    const selector = $('opsServer');
    selector.innerHTML = state.servers.length ? state.servers.map(s => `<option value="${esc(s.id)}">${esc(s.name)}</option>`).join('') : '<option value="">No servers assigned</option>';
    selector.value = state.serverId;
    selector.addEventListener('change', async () => { await selectServer(selector.value); await refresh(); });
    $('view-operations').querySelectorAll('[data-admin-only]').forEach(el => { el.hidden = !admin(); });
    $('opsUserServers').insertAdjacentHTML('beforeend', state.servers.map(s => `<label><input type="checkbox" name="serverIds" value="${esc(s.id)}"> ${esc(s.name)}</label>`).join('') || '<p>Add an SSH server in Settings first.</p>');
    $('opsUserPermissions').insertAdjacentHTML('beforeend', ['deploy', 'backup', 'restore', 'files', 'processes', 'infra', 'terminal'].map(p => `<label><input type="checkbox" name="permissions" value="${p}"> ${p}</label>`).join(''));
    $('opsUserRole').addEventListener('change', userRoleChanged);
    userRoleChanged();
    $('opsBackupKind').addEventListener('change', backupKindChanged);
    $('opsGitHubRepository').addEventListener('change', () => {
      const repo = githubRepos.find(repo => repo.fullName === $('opsGitHubRepository').value);
      if (!repo) return;
      const form = $('opsDeployForm');
      form.elements.name.value = repo.name;
      form.elements.branch.value = repo.defaultBranch;
      form.elements.directory.value = `/srv/${repo.name}`;
      form.elements.processName.value = repo.name;
    });
    $('opsGitHubForm').addEventListener('submit', event => submit(event, async form => {
      githubStatus = await api('/github/settings', 'POST', Object.fromEntries(new FormData(form)));
      form.elements.clientSecret.value = '';
      renderGitHub();
      showToast('OAuth app configured. Click Authorize GitHub to connect.', 'success');
    }));
    $('opsDeployForm').addEventListener('submit', event => submit(event, async form => {
      const body = Object.fromEntries(new FormData(form));
      body.install = form.elements.install.checked;
      body.build = form.elements.build.checked;
      await api('/operations/deployments', 'POST', body);
      form.reset();
      renderRepositories();
      showToast('Application connected. Ready to deploy.', 'success');
    }));
    $('opsBackupForm').addEventListener('submit', event => submit(event, async form => {
      await api('/operations/backups', 'POST', Object.fromEntries(new FormData(form)));
      form.reset(); backupKindChanged();
      showToast('Backup plan created', 'success');
    }));
    $('opsUserForm').addEventListener('submit', event => submit(event, async form => {
      const data = new FormData(form);
      const body = Object.fromEntries(data);
      body.serverIds = data.getAll('serverIds');
      body.permissions = data.getAll('permissions');
      const id = body.id; delete body.id;
      await api(id ? `/users/${encodeURIComponent(id)}` : '/users', 'POST', body);
      resetUser();
      showToast(id ? 'Account updated. Existing sessions revoked.' : 'Account created', 'success');
    }));
    $('view-operations').addEventListener('click', click);
    const tabs = [...$('view-operations').querySelectorAll('[data-ops-tab]')];
    tabs.forEach(tab => tab.addEventListener('keydown', event => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      const visible = tabs.filter(t => !t.hidden);
      const current = visible.indexOf(tab);
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? visible.length - 1 : (current + (event.key === 'ArrowRight' ? 1 : -1) + visible.length) % visible.length;
      setTab(visible[next].dataset.opsTab); visible[next].focus();
    }));
    setTab('deployments');
  }
  function renderGitHub() {
    if (!githubStatus) return;
    const connected = githubStatus.connected;
    $('opsGitHubStatus').textContent = connected ? `Authorized as @${githubStatus.account.login}. Choose a repository below.` : githubStatus.configured ? 'Ready to authorize. Connect your GitHub account to see your repositories.' : 'Set up your GitHub OAuth app once to enable authorization.';
    $('opsGitHubAuthorize').textContent = connected ? 'Authorize again' : 'Authorize GitHub';
    $('opsGitHubDisconnect').hidden = !connected;
    $('opsGitHubReloadRepos').disabled = !connected;
    const form = $('opsGitHubForm');
    form.elements.clientId.value = githubStatus.clientId || '';
    form.elements.callbackUrl.value = githubStatus.callbackUrl || `${location.origin}/api/github/callback`;
    form.elements.clientSecret.required = !githubStatus.configured;
    for (const element of form.elements) element.disabled = githubStatus.managedByEnvironment;
    $('opsGitHubRegister').href = 'https://github.com/settings/applications/new';
    if (!githubStatus.configured) $('opsGitHubSetup').open = true;
    if (!connected) { githubRepos = []; githubPage = 0; githubHasMore = false; }
    renderRepositories();
  }
  function renderRepositories() {
    const select = $('opsGitHubRepository');
    const previous = select.value;
    select.innerHTML = `<option value="">${githubStatus?.connected ? 'Select a repository…' : 'Authorize GitHub to choose a repository'}</option>` + githubRepos.map(repo => `<option value="${esc(repo.fullName)}">${esc(repo.fullName)}${repo.private ? ' · Private' : ''}</option>`).join('');
    if (githubRepos.some(repo => repo.fullName === previous)) select.value = previous;
    select.disabled = !githubStatus?.connected || !githubRepos.length;
    $('opsConnectGitHubApp').disabled = !githubStatus?.connected || !githubRepos.length;
    $('opsGitHubMore').hidden = !githubHasMore;
    $('opsGitHubRepoHelp').textContent = githubStatus?.connected ? `${githubRepos.length} repositories loaded${githubHasMore ? ' · more available' : ''}. Organization access depends on your GitHub permissions.` : '';
  }
  async function loadRepositories(more = false) {
    const data = await api(`/github/repositories?page=${more ? githubPage + 1 : 1}`);
    githubRepos = more ? [...githubRepos, ...data.repositories] : data.repositories;
    githubPage = data.page;
    githubHasMore = data.hasMore;
    renderRepositories();
  }
  async function loadGitHub() {
    githubStatus = await api('/github/status');
    renderGitHub();
    if (githubStatus.connected) await loadRepositories();
  }
  function userRoleChanged() {
    $('opsUserPermissions').disabled = $('opsUserRole').value !== 'operator';
    $('opsUserServers').disabled = $('opsUserRole').value === 'admin';
  }
  function backupKindChanged() {
    const kind = $('opsBackupKind').value;
    $('opsFileFields').hidden = kind !== 'files';
    $('opsFileFields').querySelector('input').disabled = kind !== 'files';
    $('opsDatabaseFields').hidden = kind === 'files';
    $('opsDatabaseFields').disabled = kind === 'files';
    const form = $('opsBackupForm');
    form.elements.username.value = kind === 'postgres' ? 'postgres' : 'root';
    form.elements.port.value = kind === 'postgres' ? '5432' : '3306';
    form.elements.credentialsFile.required = kind === 'mysql';
    form.elements.credentialsFile.placeholder = kind === 'mysql' ? '/root/.my.cnf' : '/root/.pgpass';
  }
  function resetUser() {
    $('opsUserForm').reset();
    $('opsUserForm').elements.id.value = '';
    $('opsUserForm').elements.username.disabled = false;
    $('opsUserForm').elements.password.required = true;
    $('opsSaveUser').textContent = 'Create account';
    userRoleChanged();
  }
  function setTab(tab) {
    activeTab = tab;
    document.querySelectorAll('[data-ops-tab]').forEach(el => { el.setAttribute('aria-selected', String(el.dataset.opsTab === tab)); el.tabIndex = el.dataset.opsTab === tab ? 0 : -1; });
    ['deployments', 'backups', 'users', 'audit'].forEach(name => { $(`opsPanel-${name}`).hidden = name !== tab; });
    if (tab === 'users' || tab === 'audit') refresh();
  }
  async function submit(event, action) {
    event.preventDefault();
    const form = event.currentTarget;
    const submitButton = form.querySelector('[type="submit"]');
    submitButton.disabled = true;
    try { await action(form); await refresh(); }
    catch (err) { showError(err.message); }
    finally { submitButton.disabled = false; }
  }
  function showError(message) { $('opsError').hidden = false; $('opsError').textContent = message; }
  function render() {
    const { projects, plans, runs } = snapshot;
    const busy = runs.some(r => r.status === 'running');
    const disabled = busy ? 'disabled title="Wait for the running operation"' : '';
    $('opsSummary').innerHTML = [['Applications', projects.length], ['Backup plans', plans.length], ['Retained copies', runs.filter(r => r.type === 'backup' && r.status === 'success' && r.available).length], ['Running', runs.filter(r => r.status === 'running').length]].map(([title, count]) => `<div><span>${title}</span><strong>${count}</strong></div>`).join('');
    $('opsProjects').innerHTML = projects.map(p => `<article class="ops-card"><div class="ops-card-heading"><span class="ops-card-icon">↗</span><h3>${esc(p.name)}</h3><span class="ops-tag">${esc(p.branch)}</span></div><p>${esc(p.repository)}</p><dl><dt>Directory</dt><dd>${esc(p.directory)}</dd><dt>PM2 process</dt><dd>${esc(p.processName)}</dd></dl><div class="ops-actions">${can('deploy') ? button('deploy', p.id, 'Deploy latest', disabled) : ''}${admin() ? button('remove-project', p.id, 'Disconnect', disabled) : ''}</div></article>`).join('') || empty('No applications connected on this server.');
    $('opsPlans').innerHTML = plans.map(p => `<article class="ops-card"><div class="ops-card-heading"><span class="ops-card-icon">◈</span><h3>${esc(p.name)}</h3><span class="ops-tag">${esc(p.kind)}</span></div><p>${esc(p.source || p.database)} · ${esc(p.schedule)} · retain ${p.retention}</p><dl><dt>Next run</dt><dd>${p.enabled ? time(p.nextRunAt) : 'Paused'}</dd></dl><div class="ops-actions">${can('backup') ? button('backup', p.id, 'Back up now', disabled) : ''}${admin() ? button('toggle-plan', p.id, p.enabled ? 'Pause schedule' : 'Resume schedule') + button('remove-plan', p.id, 'Remove plan', disabled) : ''}</div></article>`).join('') || empty('No backup plans on this server.');
    $('opsDeployHistory').innerHTML = history(runs.filter(r => ['deploy', 'rollback'].includes(r.type)), disabled);
    $('opsBackupHistory').innerHTML = history(runs.filter(r => ['backup', 'restore'].includes(r.type)), disabled);
    const selector = $('opsServer');
    if (document.activeElement !== selector) selector.value = state.serverId;
  }
  function history(runs, disabled) {
    return runs.map(r => {
      let actions = can('deploy') || can('backup') || can('restore') || admin() ? button('log', r.id, 'View log') : '';
      if (['deploy', 'rollback'].includes(r.type) && r.status !== 'running' && r.fromCommit && can('deploy') && snapshot.projects.some(p => p.id === r.itemId)) actions += button('rollback', r.id, `Roll back to ${r.fromCommit.slice(0, 7)}`, disabled);
      if (r.type === 'backup' && r.status === 'success' && r.available && can('restore')) actions += button('restore', r.id, 'Restore', disabled);
      return `<article class="ops-history-row"><div><h4>${esc(r.name)} <span>${esc(r.type)}</span></h4><p>${esc(r.actor)} · ${time(r.startedAt)}${r.toCommit ? ` · ${esc(r.toCommit.slice(0, 7))}` : ''}${r.type === 'backup' && r.status === 'success' ? ` · ${r.available ? 'Retained' : 'Expired'}` : ''}</p>${r.error ? `<p class="ops-error">${esc(r.error)}</p>` : ''}</div>${status(r)}<div class="ops-actions">${actions}</div></article>`;
    }).join('') || empty('No operations yet.');
  }
  async function refresh() {
    if (refreshing) { requestVersion++; return; }
    refreshing = true;
    const serverId = state.serverId;
    const version = requestVersion;
    try {
      if (serverId) {
        const data = await api('/operations');
        if (serverId !== state.serverId) return;
        snapshot = data;
      } else snapshot = { projects: [], plans: [], runs: [] };
      const selector = $('opsServer');
      const choices = state.servers.map(server => '<option value="' + esc(server.id) + '">' + esc(server.name) + '</option>').join('') || '<option value="">No servers assigned</option>';
      if (selector.innerHTML !== choices && document.activeElement !== selector) selector.innerHTML = choices;
      if (!$('opsUserForm').elements.id.value && document.activeElement?.closest('#opsUserForm') === null) {
        const selected = [...$('opsUserServers').querySelectorAll('input:checked')].map(el => el.value);
        $('opsUserServers').innerHTML = '<legend>Allowed servers</legend>' + state.servers.map(server => '<label><input type="checkbox" name="serverIds" value="' + esc(server.id) + '"' + (selected.includes(server.id) ? ' checked' : '') + '> ' + esc(server.name) + '</label>').join('');
      }
      render();
      if (admin() && activeTab === 'users') {
        const data = await api('/users'); users = data.users;
        $('opsUsers').innerHTML = users.map(u => `<article class="ops-card"><div class="ops-card-heading"><h3>${esc(u.username)}</h3><span class="ops-tag">${esc(u.role)}</span></div><p>${u.role === 'admin' ? 'All servers' : u.serverIds.map(id => esc(state.servers.find(s => s.id === id)?.name || 'Removed server')).join(', ') || 'No assigned servers'}</p><p>${u.role === 'operator' ? esc(u.permissions.join(', ')) : ''}</p><div class="ops-actions">${u.id !== state.user.id ? button('edit-user', u.id, 'Edit access') + button('remove-user', u.id, 'Delete account') : '<span class="ops-note">Current account</span>'}</div></article>`).join('') || empty('No teammate accounts yet. The owner panel token remains available.');
      }
      if (admin() && activeTab === 'audit') {
        const data = await api('/audit?limit=200');
        $('opsAudit').innerHTML = data.entries.map(e => `<article class="ops-history-row"><div><h4>${esc(e.actor || e.role || 'system')} <span>${esc(e.action || e.method || '')}</span></h4><p>${esc(e.path || e.target || e.type)} · ${esc(e.server || 'Panel')} · ${time(e.time)}</p></div><span class="ops-tag">${esc(e.status || e.role || '')}</span></article>`).join('') || empty('No activity recorded yet.');
      }
      $('opsUpdated').textContent = `Updated ${new Date().toLocaleTimeString()}`;
    } catch (err) { showError(err.message); }
    finally { refreshing = false; if (serverId !== state.serverId || version !== requestVersion) refresh(); }
  }
  async function click(event) {
    const tab = event.target.closest('[data-ops-tab]');
    if (tab) { setTab(tab.dataset.opsTab); return; }
    const control = event.target.closest('[data-ops-action]');
    if (!control) return;
    const { opsAction: action, id } = control.dataset;
    const run = snapshot.runs.find(r => r.id === id);
    try {
      if (action === 'refresh') { $('opsError').hidden = true; await refresh(); return; }
      if (action === 'github-authorize') {
        if (!githubStatus?.configured) { $('opsGitHubSetup').open = true; $('opsGitHubForm').elements.clientId.focus(); return; }
        control.disabled = true;
        const data = await api('/github/authorize', 'POST', {});
        try { sessionStorage.setItem('controlLinx.githubServer', state.serverId); } catch (_) { /* selection can fall back after authorization */ }
        location.assign(data.url);
        return;
      }
      if (action === 'github-disconnect') {
        if (!confirm('Disconnect GitHub? Applications using this authorization will need it reconnected before deploying.')) return;
        control.disabled = true;
        const result = await api('/github/disconnect', 'POST', {});
        await loadGitHub();
        showToast(result.revoked ? 'GitHub disconnected' : 'Disconnected from the panel. You can also revoke this app in GitHub settings.', 'success');
        return;
      }
      if (action === 'github-repositories' || action === 'github-more') { control.disabled = true; await loadRepositories(action === 'github-more'); return; }
      if (action === 'logout') { await api('/auth/logout', 'POST', {}); setPanelToken(''); location.reload(); return; }
      if (action === 'close-log') { $('opsLogDialog').close(); return; }
      if (action === 'log') { $('opsLogTitle').textContent = `${run.name} · ${run.status}`; $('opsLogText').textContent = [run.log, run.error].filter(Boolean).join('\n') || 'No output yet. Close and reopen after the operation finishes.'; $('opsLogDialog').showModal(); return; }
      if (action === 'cancel-user') { resetUser(); return; }
      if (action === 'edit-user') {
        const user = users.find(u => u.id === id); const form = $('opsUserForm');
        resetUser(); form.elements.id.value = user.id; form.elements.username.value = user.username; form.elements.username.disabled = true; form.elements.password.required = false; form.elements.role.value = user.role;
        form.querySelectorAll('[name="serverIds"]').forEach(el => { el.checked = user.serverIds.includes(el.value); });
        form.querySelectorAll('[name="permissions"]').forEach(el => { el.checked = user.permissions.includes(el.value); });
        userRoleChanged(); $('opsSaveUser').textContent = 'Save account changes'; $('opsUserDetails').open = true; form.elements.role.focus(); return;
      }
      control.disabled = true;
      $('opsError').hidden = true;
      if (action === 'deploy') {
        const project = snapshot.projects.find(p => p.id === id);
        if (!confirm(`Deploy the latest ${project.branch} commit and restart ${project.processName}?`)) return;
        await api(`/operations/deployments/${id}/run`, 'POST', {});
      } else if (action === 'rollback') {
        if (!confirm(`Check out ${run.fromCommit.slice(0, 7)}, rebuild using this application's settings, and restart PM2?`)) return;
        await api(`/operations/deployments/${run.itemId}/rollback`, 'POST', { runId: id });
      } else if (action === 'backup') await api(`/operations/backups/${id}/run`, 'POST', {});
      else if (action === 'restore') {
        const confirmation = prompt(`Restore "${run.name}" from ${time(run.startedAt)}? This replaces matching current files or database objects. Type the backup name to confirm:`);
        if (confirmation === null) return;
        await api(`/operations/runs/${id}/restore`, 'POST', { confirmation });
      } else if (action === 'toggle-plan') await api(`/operations/backups/${id}/toggle`, 'POST', {});
      else if (action === 'remove-project' || action === 'remove-plan') {
        if (!confirm('Remove this configuration? Existing files and history are kept.')) return;
        await api(`/operations/${action === 'remove-project' ? 'deployments' : 'backups'}/${id}`, 'DELETE');
      } else if (action === 'remove-user') {
        const user = users.find(u => u.id === id);
        if (!confirm(`Delete ${user.username} and revoke all their sessions?`)) return;
        await api(`/users/${id}`, 'DELETE');
      }
      await refresh();
      showToast(['deploy', 'rollback', 'backup', 'restore'].includes(action) ? 'Operation started. Follow its progress in the history.' : 'Changes saved', 'success');
    } catch (err) { showError(err.message); }
    finally { control.disabled = false; }
  }
  async function init() {
    buildWorkspace();
    document.querySelectorAll('.nav-pill-item[data-view]').forEach(el => {
      const permission = { terminal: 'terminal', files: 'files', infra: 'infra', copilot: 'admin', settings: 'admin' }[el.dataset.view];
      if (permission) el.hidden = permission === 'admin' ? !admin() : !can(permission);
    });
    for (const id of ['btnRestartAllPm2', 'btnRestartAllPm2Full']) if ($(id)) $(id).hidden = !can('processes');
    if (admin()) {
      try { await loadGitHub(); }
      catch (err) { $('opsGitHubStatus').textContent = err.message; showError(err.message); }
      const callbackResult = new URL(location.href).searchParams.get('github');
      if (callbackResult) {
        let previous = '';
        try { previous = sessionStorage.getItem('controlLinx.githubServer'); sessionStorage.removeItem('controlLinx.githubServer'); } catch (_) { /* storage may be disabled */ }
        if (state.servers.some(server => server.id === previous)) state.serverId = previous;
        const url = new URL(location.href); url.searchParams.delete('github');
        window.history.replaceState(null, '', url.pathname + url.search + url.hash);
        setTimeout(() => switchView('operations'), 0);
        if (callbackResult === 'connected') showToast('GitHub authorized. Choose your repository.', 'success');
      }
    }
    await refresh();
    setInterval(() => { if (state.currentView === 'operations' && !document.hidden) refresh(); }, 5000);
  }
  return { init, refresh };
})();
