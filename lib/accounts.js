const crypto = require('crypto');
const { promisify } = require('util');
const path = require('path');
const stateFile = require('./stateFile');
const security = require('./security');
const scrypt = promisify(crypto.scrypt);
const PERMISSIONS = ['deploy', 'backup', 'restore', 'files', 'processes', 'infra', 'terminal'];
const SESSION_MS = 12 * 60 * 60 * 1000;
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const publicUser = ({ passwordHash, salt, ...user }) => user;

class Accounts {
  constructor(filename = path.join(__dirname, '..', 'data', 'accounts.json')) {
    this.state = stateFile(filename, { users: [] });
    this.sessions = new Map();
  }
  list() { return this.state.data.users.map(publicUser); }
  async create(input, serverIds) {
    const username = String(input.username || '').trim().toLowerCase();
    if (!/^[a-z0-9][a-z0-9._-]{2,47}$/.test(username)) throw security.httpError(400, 'Username must be 3–48 letters, digits, dots, underscores or hyphens');
    if (this.state.data.users.some(u => u.username === username)) throw security.httpError(409, 'Username already exists');
    if (!['admin', 'operator', 'viewer'].includes(input.role)) throw security.httpError(400, 'Invalid role');
    if (typeof input.password !== 'string') throw security.httpError(400, 'Password must be a string');
    const password = input.password;
    if (password.length < 12 || password.length > 256) throw security.httpError(400, 'Password must contain 12–256 characters');
    if (!Array.isArray(input.serverIds) || input.serverIds.some(id => !serverIds.includes(id))) throw security.httpError(400, 'Choose valid servers');
    if (!Array.isArray(input.permissions) || input.permissions.some(p => !PERMISSIONS.includes(p))) throw security.httpError(400, 'Invalid permissions');
    const salt = crypto.randomBytes(16).toString('hex');
    const passwordHash = (await scrypt(password, salt, 64)).toString('hex');
    
    if (this.state.data.users.some(u => u.username === username)) throw security.httpError(409, 'Username already exists');
    const user = { id: crypto.randomUUID(), username, role: input.role, serverIds: [...new Set(input.serverIds)], permissions: input.role === 'operator' ? [...new Set(input.permissions)] : [], salt, passwordHash, createdAt: new Date().toISOString() };
    this.state.data.users.push(user);
    try { this.state.save(); } catch (err) { this.state.data.users.pop(); throw err; }
    return publicUser(user);
  }
  remove(id) {
    const index = this.state.data.users.findIndex(u => u.id === id);
    if (index < 0) throw security.httpError(404, 'User not found');
    const [user] = this.state.data.users.splice(index, 1);
    try { this.state.save(); } catch (err) { this.state.data.users.splice(index, 0, user); throw err; }
    for (const [key, session] of this.sessions) if (session.userId === id) this.sessions.delete(key);
  }
  async update(id, input, serverIds) {
    const user = this.state.data.users.find(u => u.id === id);
    if (!user) throw security.httpError(404, 'User not found');
    if (!['admin', 'operator', 'viewer'].includes(input.role)) throw security.httpError(400, 'Invalid role');
    if (!Array.isArray(input.serverIds) || input.serverIds.some(serverId => !serverIds.includes(serverId))) throw security.httpError(400, 'Choose valid servers');
    if (!Array.isArray(input.permissions) || input.permissions.some(p => !PERMISSIONS.includes(p))) throw security.httpError(400, 'Invalid permissions');
    const changes = { role: input.role, serverIds: [...new Set(input.serverIds)], permissions: input.role === 'operator' ? [...new Set(input.permissions)] : [] };
    if (input.password) {
      if (typeof input.password !== 'string' || input.password.length < 12 || input.password.length > 256) throw security.httpError(400, 'Password must contain 12–256 characters');
      changes.salt = crypto.randomBytes(16).toString('hex');
      changes.passwordHash = (await scrypt(input.password, changes.salt, 64)).toString('hex');
    }
    if (!this.state.data.users.includes(user)) throw security.httpError(404, 'User not found');
    const before = { ...user };
    Object.assign(user, changes);
    try { this.state.save(); } catch (err) { Object.assign(user, before); throw err; }
    for (const [key, session] of this.sessions) if (session.userId === id) this.sessions.delete(key);
    return publicUser(user);
  }
  async login(username, password) {
    if (typeof username !== 'string' || typeof password !== 'string' || password.length > 256) throw security.httpError(400, 'Invalid login');
    const user = this.state.data.users.find(u => u.username === username.trim().toLowerCase());
    const derived = await scrypt(password, user ? user.salt : 'invalid-user-salt', 64);
    if (!user || !this.state.data.users.includes(user) || !crypto.timingSafeEqual(derived, Buffer.from(user.passwordHash, 'hex'))) throw security.httpError(401, 'Invalid username or password');
    
    const now = Date.now();
    for (const [key, session] of this.sessions) if (session.expiresAt <= now) this.sessions.delete(key);
    if (this.sessions.size >= 10000) throw security.httpError(429, 'Too many active sessions');
    const token = crypto.randomBytes(32).toString('base64url');
    this.sessions.set(hash(token), { userId: user.id, expiresAt: now + SESSION_MS });
    return { token, user: publicUser(user), expiresAt: new Date(now + SESSION_MS).toISOString() };
  }
  resolve(token) {
    const key = hash(String(token));
    const session = this.sessions.get(key);
    if (!session) return null;
    if (session.expiresAt <= Date.now()) { this.sessions.delete(key); return null; }
    const user = this.state.data.users.find(u => u.id === session.userId);
    return user ? publicUser(user) : null;
  }
  logout(token) { this.sessions.delete(hash(String(token))); }
}

function canAccessServer(user, id) { return user.role === 'admin' || user.serverIds.includes(id); }
function can(user, permission) { return user.role === 'admin' || (user.role === 'operator' && user.permissions.includes(permission)); }


function allowedRequest(user, method, pathname) {
  if (user.role === 'admin') return true;
  if (['/api/auth/verify', '/api/auth/logout', '/api/auth/me'].includes(pathname)) return true;
  if (pathname === '/api/servers/select' && method === 'POST') return true;
  if (method === 'GET' && ['/api/servers', '/api/metrics', '/api/metrics/history', '/api/overview', '/api/pm2', '/api/operations'].includes(pathname)) return true;
  if (/^\/api\/operations\/deployments\/[^/]+\/run$/.test(pathname)) return method === 'POST' && can(user, 'deploy');
  if (/^\/api\/operations\/deployments\/[^/]+\/rollback$/.test(pathname)) return method === 'POST' && can(user, 'deploy');
  if (/^\/api\/operations\/backups\/[^/]+\/run$/.test(pathname)) return method === 'POST' && can(user, 'backup');
  if (/^\/api\/operations\/runs\/[^/]+\/restore$/.test(pathname)) return method === 'POST' && can(user, 'restore');
  if (pathname.startsWith('/api/files')) return can(user, 'files');
  if (pathname.startsWith('/api/pm2/')) return can(user, 'processes');
  if (pathname.startsWith('/api/infra')) return method === 'GET' || can(user, 'infra');
  return false;
}

module.exports = { Accounts, PERMISSIONS, can, canAccessServer, allowedRequest };
