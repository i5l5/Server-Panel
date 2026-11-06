const crypto = require('crypto');
const path = require('path');
const stateFile = require('./stateFile');
const secretBox = require('./secretBox');
const security = require('./security');
const NAME = /^[A-Za-z0-9][A-Za-z0-9-]{0,99}\/(?!(?:\.|\.\.)$)[A-Za-z0-9_.-]{1,100}$/;
const CALLBACK = '/api/github/callback';

class GitHub {
  constructor({ filename = path.join(__dirname, '..', 'data', 'github.json'), fetcher = global.fetch, audit, resolveIdentity = security.identityForToken } = {}) {
    this.state = stateFile(filename, { settings: {}, connection: null });
    this.fetcher = fetcher;
    this.audit = audit;
    this.resolveIdentity = resolveIdentity;
    this.pending = new Map();
    this.refreshing = null;
    this.generation = 0;
  }
  settings() {
    const saved = this.state.data.settings;
    return { clientId: process.env.GITHUB_CLIENT_ID || saved.clientId || '', clientSecret: process.env.GITHUB_CLIENT_SECRET || secretBox.decrypt(saved.clientSecret), callbackUrl: process.env.GITHUB_CALLBACK_URL || saved.callbackUrl || '' };
  }
  status() {
    const config = this.settings();
    const connection = this.state.data.connection;
    return { configured: Boolean(config.clientId && config.clientSecret && config.callbackUrl), clientId: config.clientId, callbackUrl: config.callbackUrl, connected: Boolean(connection), account: connection ? { id: connection.id, login: connection.login, authorizedBy: connection.authorizedBy } : null, managedByEnvironment: Boolean(process.env.GITHUB_CLIENT_ID || process.env.GITHUB_CLIENT_SECRET || process.env.GITHUB_CALLBACK_URL) };
  }
  configure(input) {
    if (this.status().managedByEnvironment) throw security.httpError(409, 'GitHub OAuth settings are managed by environment variables');
    const clientId = String(input.clientId || '').trim();
    if (!/^[A-Za-z0-9_.-]{5,100}$/.test(clientId)) throw security.httpError(400, 'Enter a valid GitHub OAuth client ID');
    const previous = this.settings();
    const clientSecret = input.clientSecret || (previous.clientId === clientId ? previous.clientSecret : '');
    if (typeof clientSecret !== 'string' || !/^[A-Za-z0-9_\-]{16,256}$/.test(clientSecret)) throw security.httpError(400, 'Enter the GitHub OAuth client secret');
    let callback;
    try { callback = new URL(input.callbackUrl); } catch (_) { throw security.httpError(400, 'Enter a valid callback URL'); }
    if (callback.pathname !== CALLBACK || callback.username || callback.password || callback.search || callback.hash || (callback.protocol !== 'https:' && !(callback.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(callback.hostname)))) throw security.httpError(400, `Callback must use HTTPS (or localhost HTTP) and end with ${CALLBACK}`);
    const before = { ...this.state.data };
    this.state.data.settings = { clientId, clientSecret: secretBox.encrypt(clientSecret), callbackUrl: callback.href };
    if (previous.clientId !== clientId || previous.clientSecret !== clientSecret || previous.callbackUrl !== callback.href) this.state.data.connection = null;
    try { this.state.save(); } catch (err) { Object.assign(this.state.data, before); throw err; }
    this.pending.clear();
    this.generation++;
    return this.status();
  }
  authorize(token, origin) {
    const user = this.resolveIdentity(token);
    if (user?.role !== 'admin') throw security.httpError(403, 'Administrator access required');
    const config = this.settings();
    if (!this.status().configured) throw security.httpError(409, 'Set up your GitHub OAuth app first');
    if (new URL(config.callbackUrl).origin !== origin) throw security.httpError(400, 'Open the panel at the origin configured in the GitHub callback URL');
    const now = Date.now();
    for (const [key, value] of this.pending) if (value.expiresAt <= now) this.pending.delete(key);
    if (this.pending.size >= 100) throw security.httpError(429, 'Too many pending authorizations');
    const state = crypto.randomBytes(32).toString('base64url');
    const verifier = crypto.randomBytes(32).toString('base64url');
    this.pending.set(state, { verifier, token, actor: user.username, actorId: user.id, expiresAt: now + 600000, clientId: config.clientId, callbackUrl: config.callbackUrl, generation: this.generation });
    const expiry = setTimeout(() => this.pending.delete(state), 600000);
    expiry.unref();
    const params = new URLSearchParams({ client_id: config.clientId, redirect_uri: config.callbackUrl, scope: 'repo', state, code_challenge: crypto.createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256', prompt: 'select_account' });
    return `https://github.com/login/oauth/authorize?${params}`;
  }
  async oauth(parameters) {
    const config = this.settings();
    const response = await this.fetcher('https://github.com/login/oauth/access_token', { method: 'POST', headers: { Accept: 'application/json', 'Content-Type': 'application/json' }, body: JSON.stringify({ client_id: config.clientId, client_secret: config.clientSecret, ...parameters }), signal: AbortSignal.timeout(20000), redirect: 'error' });
    let result;
    try { result = await response.json(); } catch (_) { throw security.httpError(502, 'GitHub returned an invalid authorization response'); }
    if (!response.ok || result.error || typeof result.access_token !== 'string' || !/^[A-Za-z0-9_\-]{10,512}$/.test(result.access_token)) throw security.httpError(409, 'GitHub authorization failed. Authorize again and check the OAuth app settings.');
    return result;
  }
  encryptedTokens(result) {
    return { accessToken: secretBox.encrypt(result.access_token), refreshToken: result.refresh_token ? secretBox.encrypt(result.refresh_token) : '', expiresAt: result.expires_in ? Date.now() + Number(result.expires_in) * 1000 : null };
  }
  async callback(query) {
    const pending = typeof query.state === 'string' ? this.pending.get(query.state) : null;
    if (typeof query.state === 'string') this.pending.delete(query.state);
    if (!pending || pending.expiresAt <= Date.now()) throw security.httpError(400, 'GitHub authorization expired or has already been used. Return to the panel and try again.');
    const identity = this.resolveIdentity(pending.token);
    if (identity?.role !== 'admin' || identity.id !== pending.actorId) throw security.httpError(403, 'The panel session that requested authorization is no longer valid');
    if (query.error) throw security.httpError(400, 'GitHub authorization was cancelled. Return to the panel to retry.');
    if (typeof query.code !== 'string' || query.code.length > 512) throw security.httpError(400, 'Invalid GitHub authorization code');
    const config = this.settings();
    if (config.clientId !== pending.clientId || config.callbackUrl !== pending.callbackUrl || pending.generation !== this.generation) throw security.httpError(400, 'OAuth settings changed. Start authorization again.');
    const result = await this.oauth({ code: query.code, code_verifier: pending.verifier, redirect_uri: pending.callbackUrl });
    const user = await this.request('/user', result.access_token);
    if (pending.generation !== this.generation) throw security.httpError(409, 'GitHub connection changed. Start authorization again.');
    if (!Number.isSafeInteger(user.id) || !/^[A-Za-z0-9-]{1,100}$/.test(user.login)) throw security.httpError(502, 'GitHub returned an invalid account');
    if (this.resolveIdentity(pending.token)?.role !== 'admin') throw security.httpError(403, 'Panel session expired during authorization');
    const before = this.state.data.connection;
    this.state.data.connection = { id: user.id, login: user.login, authorizedBy: pending.actor, ...this.encryptedTokens(result) };
    try { this.state.save(); } catch (err) { this.state.data.connection = before; throw err; }
    this.generation++;
    this.pending.clear();
    this.audit?.record({ type: 'github', action: 'authorize', actor: pending.actor, account: user.login, status: 'success' });
    return this.status();
  }
  async request(endpoint, token) {
    const response = await this.fetcher(`https://api.github.com${endpoint}`, { headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${token}`, 'User-Agent': 'ServerOps', 'X-GitHub-Api-Version': '2022-11-28' }, signal: AbortSignal.timeout(20000), redirect: 'error' });
    if (!response.ok) throw security.httpError(response.status === 401 ? 409 : 502, response.status === 401 ? 'GitHub authorization expired or was revoked. Authorize GitHub again.' : `GitHub request failed (${response.status}). Check repository access or try again later.`);
    try { return await response.json(); } catch (_) { throw security.httpError(502, 'GitHub returned an invalid response'); }
  }
  async token(accountId) {
    const connection = this.state.data.connection;
    if (!connection || (accountId && connection.id !== accountId)) throw security.httpError(409, 'Authorize the GitHub account used by this application before deploying');
    if (connection.expiresAt && connection.expiresAt <= Date.now() + 60000) {
      if (!connection.refreshToken) throw security.httpError(409, 'GitHub authorization expired. Authorize again.');
      if (!this.refreshing) {
        this.refreshing = this.oauth({ grant_type: 'refresh_token', refresh_token: secretBox.decrypt(connection.refreshToken) }).then(result => {
          if (this.state.data.connection !== connection) throw security.httpError(409, 'GitHub connection changed during refresh');
          const before = { ...connection };
          Object.assign(connection, this.encryptedTokens(result));
          try { this.state.save(); } catch (err) { Object.assign(connection, before); throw err; }
        }).finally(() => { this.refreshing = null; });
      }
      await this.refreshing;
    }
    if (this.state.data.connection !== connection) throw security.httpError(409, 'GitHub connection changed');
    return secretBox.decrypt(connection.accessToken);
  }
  repoSummary(repo) {
    if (!NAME.test(repo.full_name || '') || !repo.default_branch) throw security.httpError(502, 'GitHub returned an invalid repository');
    return { fullName: repo.full_name, name: repo.name, defaultBranch: repo.default_branch, private: Boolean(repo.private), cloneUrl: `https://github.com/${repo.full_name}.git` };
  }
  async repositories(page = 1) {
    const number = Number(page);
    if (!Number.isInteger(number) || number < 1 || number > 10000) throw security.httpError(400, 'Invalid repository page');
    const repos = await this.request(`/user/repos?per_page=100&page=${number}&sort=updated&affiliation=owner,collaborator,organization_member`, await this.token());
    if (!Array.isArray(repos)) throw security.httpError(502, 'Invalid GitHub response');
    return { repositories: repos.filter(repo => !repo.archived && !repo.disabled).map(repo => this.repoSummary(repo)), page: number, hasMore: repos.length === 100 };
  }
  async repository(name) {
    if (typeof name !== 'string' || !NAME.test(name)) throw security.httpError(400, 'Select a valid GitHub repository');
    const connection = this.state.data.connection;
    const token = await this.token();
    const result = await this.request(`/repos/${name.split('/').map(encodeURIComponent).join('/')}`, token);
    if (this.state.data.connection !== connection) throw security.httpError(409, 'GitHub connection changed. Choose the repository again.');
    if (result.archived || result.disabled) throw security.httpError(400, 'Choose an active repository');
    return { ...this.repoSummary(result), accountId: connection.id };
  }
  async disconnect(actor) {
    const connection = this.state.data.connection;
    this.state.data.connection = null;
    try { this.state.save(); } catch (err) { this.state.data.connection = connection; throw err; }
    this.pending.clear();
    this.generation++;
    let revoked = !connection;
    if (connection) {
      try {
        const config = this.settings();
        const result = await this.fetcher(`https://api.github.com/applications/${encodeURIComponent(config.clientId)}/token`, { method: 'DELETE', headers: { Accept: 'application/vnd.github+json', Authorization: `Basic ${Buffer.from(`${config.clientId}:${config.clientSecret}`).toString('base64')}`, 'Content-Type': 'application/json', 'User-Agent': 'ServerOps' }, body: JSON.stringify({ access_token: secretBox.decrypt(connection.accessToken) }), signal: AbortSignal.timeout(10000), redirect: 'error' });
        revoked = result.ok || result.status === 404;
      } catch (_) {  }
    }
    this.audit?.record({ type: 'github', action: 'disconnect', actor, status: 'success', revoked });
    return { revoked };
  }
}

module.exports = { GitHub, CALLBACK };
