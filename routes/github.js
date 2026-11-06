const express = require('express');
const { CALLBACK } = require('../lib/github');

function callbackRoute({ github, security }) {
  return async (req, res) => {
    try { await github.callback(req.query); res.redirect(303, '/?github=connected'); }
    catch (err) {
      const text = security.redactOutput(err.message).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
      res.status(err.statusCode || 500).type('html').send(`<!doctype html><html lang="en"><meta charset="utf-8"><title>GitHub authorization</title><body><h1>GitHub authorization</h1><p>${text}</p><a href="/?github=retry">Return to ServerOps</a></body></html>`);
    }
  };
}
function githubRouter({ github, security }) {
  const router = express.Router();
  router.use('/github', (req, res, next) => req.panelRole === 'admin' ? next() : res.status(403).json({ success: false, error: 'Administrator access required' }));
  const wrap = handler => async (req, res) => {
    try { res.json({ success: true, ...await handler(req) }); }
    catch (err) { security.sendError(res, err, 'github'); }
  };
  router.get('/github/status', wrap(() => github.status()));
  router.post('/github/settings', wrap(req => github.configure(req.body || {})));
  router.post('/github/authorize', wrap(req => {
    // The configured callback origin is authoritative; a browser must use that origin.
    const origin = req.get('Origin');
    if (!origin) throw security.httpError(400, 'Authorize GitHub from the panel in your browser');
    return { url: github.authorize(req.get('X-Panel-Token'), origin) };
  }));
  router.get('/github/repositories', wrap(req => github.repositories(req.query.page || 1)));
  router.post('/github/disconnect', wrap(req => github.disconnect(req.panelUser.username)));
  return router;
}
module.exports = { githubRouter, callbackRoute, CALLBACK };
