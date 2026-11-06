const express = require('express');
const { PERMISSIONS } = require('../lib/accounts');

module.exports = function accountsRouter({ accounts, store, security, audit }) {
  const router = express.Router();
  router.get('/auth/me', (req, res) => res.json({ success: true, user: req.panelUser, permissions: PERMISSIONS }));
  router.post('/auth/logout', (req, res) => {
    accounts.logout(req.get('X-Panel-Token'));
    res.json({ success: true });
  });
  router.use('/users', (req, res, next) => req.panelRole === 'admin' ? next() : res.status(403).json({ success: false, error: 'Administrator access required' }));
  router.get('/users', (req, res) => res.json({ success: true, users: accounts.list(), permissions: PERMISSIONS }));
  router.post('/users', async (req, res) => {
    try {
      const user = await accounts.create(req.body || {}, store.config.servers.map(s => s.id));
      audit.record({ type: 'account', action: 'create', actor: req.panelUser.username, target: user.username });
      res.status(201).json({ success: true, user });
    } catch (err) { security.sendError(res, err, 'create account'); }
  });
  router.delete('/users/:id', (req, res) => {
    try {
      if (req.params.id === req.panelUser.id) throw security.httpError(400, 'You cannot delete your own account');
      const user = accounts.list().find(u => u.id === req.params.id);
      accounts.remove(req.params.id);
      audit.record({ type: 'account', action: 'delete', actor: req.panelUser.username, target: user?.username });
      res.json({ success: true });
    } catch (err) { security.sendError(res, err, 'delete account'); }
  });
  router.post('/users/:id', async (req, res) => {
    try {
      if (req.params.id === req.panelUser.id) throw security.httpError(400, 'Use another administrator to change your own account');
      const user = await accounts.update(req.params.id, req.body || {}, store.config.servers.map(s => s.id));
      audit.record({ type: 'account', action: 'update', actor: req.panelUser.username, target: user.username });
      res.json({ success: true, user });
    } catch (err) { security.sendError(res, err, 'update account'); }
  });
  return router;
};
