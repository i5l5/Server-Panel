const express = require('express');
const { can } = require('../lib/accounts');

module.exports = function operationsRouter({ operations, store, security, github }) {
  const router = express.Router();
  const wrap = fn => async (req, res) => {
    try { await fn(req, res, store.getActiveServer().id, req.panelUser.username); }
    catch (err) { security.sendError(res, err, 'operations'); }
  };
  const admin = (req, res, next) => req.panelRole === 'admin' ? next() : res.status(403).json({ success: false, error: 'Administrator access required to configure operations' });
  const permit = permission => (req, res, next) => can(req.panelUser, permission) ? next() : res.status(403).json({ success: false, error: `Missing ${permission} permission` });
  router.get('/operations', wrap((req, res, id) => {
    const data = operations.list(id);
    // Logs and database connection details are visible only to operational accounts.
    if (req.panelRole === 'viewer') {
      data.runs = data.runs.map(({ log, plan, archive, ...run }) => run);
      data.plans = data.plans.map(({ credentialsFile, ...plan }) => plan);
    }
    res.json({ success: true, ...data });
  }));
  router.post('/operations/deployments', admin, wrap(async (req, res, id) => {
    const input = { ...(req.body || {}), githubAccountId: undefined };
    if (input.githubRepository) {
      if (!github) throw security.httpError(409, 'GitHub authorization is not configured');
      const repo = await github.repository(input.githubRepository);
      input.repository = repo.cloneUrl;
      input.branch = input.branch || repo.defaultBranch;
      input.githubAccountId = repo.accountId;
    }
    res.status(201).json({ success: true, project: operations.addProject(id, input) });
  }));
  router.delete('/operations/deployments/:id', admin, wrap((req, res, id) => { operations.remove('projects', req.params.id, id); res.json({ success: true }); }));
  router.post('/operations/deployments/:id/run', permit('deploy'), wrap((req, res, id, actor) => res.status(202).json({ success: true, run: operations.deploy(id, req.params.id, actor) })));
  router.post('/operations/deployments/:id/rollback', permit('deploy'), wrap((req, res, id, actor) => res.status(202).json({ success: true, run: operations.deploy(id, req.params.id, actor, security.assertSafeName(req.body?.runId, 'deployment run')) })));
  router.post('/operations/backups', admin, wrap((req, res, id) => res.status(201).json({ success: true, plan: operations.addPlan(id, req.body || {}) })));
  router.post('/operations/backups/:id/toggle', admin, wrap((req, res, id) => res.json({ success: true, plan: operations.togglePlan(req.params.id, id) })));
  router.delete('/operations/backups/:id', admin, wrap((req, res, id) => { operations.remove('plans', req.params.id, id); res.json({ success: true }); }));
  router.post('/operations/backups/:id/run', permit('backup'), wrap((req, res, id, actor) => res.status(202).json({ success: true, run: operations.backup(id, req.params.id, actor) })));
  router.post('/operations/runs/:id/restore', permit('restore'), wrap((req, res, id, actor) => res.status(202).json({ success: true, run: operations.restore(id, req.params.id, actor, req.body?.confirmation) })));
  return router;
};
