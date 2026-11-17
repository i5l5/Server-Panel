const { AsyncLocalStorage } = require('async_hooks');
const { allowedRequest, canAccessServer } = require('./accounts');
const security = require('./security');
const context = new AsyncLocalStorage();

function visibleServers(servers, user = context.getStore()?.user) {
  return !user || user.legacy || user.role === 'admin' ? servers : servers.filter(s => canAccessServer(user, s.id));
}
function middleware(store) {
  return (req, res, next) => {
    const user = req.panelUser;
    const pathname = req.originalUrl.split('?')[0];
    if (!user.legacy && !allowedRequest(user, req.method, pathname)) return res.status(403).json({ success: false, error: 'Your account does not have permission for this action' });
    const servers = visibleServers(store.config.servers, user);
    const selected = (pathname === '/api/servers/select' ? req.body?.id : '') || req.get('X-Server-Id') || (pathname === '/api/files/download' ? req.query.serverId : '');
    const server = selected ? servers.find(s => s.id === selected) : servers.find(s => s.id === store.config.activeServerId) || servers[0];
    if (selected && !server) return res.status(403).json({ success: false, error: 'Server access denied' });
    if (!server && !user.legacy && user.role !== 'admin' && !['/api/servers', '/api/auth/verify', '/api/auth/me', '/api/auth/logout'].includes(pathname)) return res.status(403).json({ success: false, error: 'No servers assigned to your account' });
    req.auditServerName = server?.name || 'Panel';
    req.auditServerId = server?.id;
    return context.run({ user, server }, next);
  };
}
function activeServer() { return context.getStore()?.server; }
function scoped() { return Boolean(context.getStore()); }
module.exports = { middleware, activeServer, visibleServers, scoped };
