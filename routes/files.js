
const express = require('express');
const path = require('path');
const multer = require('multer');

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 100 * 1024 * 1024, files: 1, parts: 10 }
});

const nowStamp = () => new Date().toISOString().substring(0, 16).replace('T', ' ');

module.exports = function filesRouter({ store, ssh, security }) {
  const router = express.Router();

  
  const demoFs = {
    '/root': [
      { name: '.config', type: 'dir', size: '--', modified: '2026-09-03 10:26' },
      { name: 'server_setup.sh', type: 'file', size: '1.2 KB', modified: '2026-08-25 14:02', content: '#!/bin/bash\necho "demo"\n' }
    ]
  };

  
  function handle(context, real, demo) {
    return async (req, res) => {
      const srv = store.getActiveServer();
      try {
        if (srv.isReal) return await real(req, res, srv);
        return await demo(req, res);
      } catch (err) {
        return security.sendError(res, err, context);
      }
    };
  }

  router.get('/files', handle('files list',
    async (req, res, srv) => {
      const currentPath = security.safeRemoteDir(req.query.path, '/root');
      const items = await ssh.listFiles(srv, currentPath);
      res.json({ success: true, currentPath, items, totalItems: items.length, isReal: true });
    },
    async (req, res) => {
      const currentPath = security.safeRemoteDir(req.query.path, '/root');
      const items = (demoFs[currentPath] || []).map(({ content, ...rest }) => rest);
      res.json({ success: true, currentPath, items, totalItems: items.length, isReal: false });
    }
  ));

  router.post('/files/read', handle('file read',
    async (req, res, srv) => {
      const { path: dir, name } = req.body || {};
      const fullPath = security.safeRemotePath(dir, name, '/root');
      const content = await ssh.readFile(srv, fullPath);
      res.json({ success: true, file: { name, content, path: fullPath } });
    },
    async (req, res) => {
      const { path: dir, name } = req.body || {};
      const fullPath = security.safeRemotePath(dir, name, '/root');
      const file = (demoFs[path.posix.dirname(fullPath)] || []).find(f => f.name === name && f.type === 'file');
      if (!file) return res.status(404).json({ success: false, error: 'File not found' });
      res.json({ success: true, file: { name, content: file.content || '', path: fullPath } });
    }
  ));

  router.post('/files/write', handle('file write',
    async (req, res, srv) => {
      const { path: dir, name, content } = req.body || {};
      if (typeof content !== 'string') throw security.httpError(400, 'File content must be a string');
      const fullPath = security.safeRemotePath(dir, name, '/root');
      await ssh.writeFile(srv, fullPath, content);
      res.json({ success: true, message: 'File saved on remote server', path: fullPath });
    },
    async (req, res) => {
      const { path: dir, name, content } = req.body || {};
      if (typeof content !== 'string') throw security.httpError(400, 'File content must be a string');
      const fullPath = security.safeRemotePath(dir, name, '/root');
      const parent = path.posix.dirname(fullPath);
      const list = demoFs[parent] || (demoFs[parent] = []);
      const existing = list.find(f => f.name === name);
      if (existing) Object.assign(existing, { content, modified: nowStamp() });
      else list.push({ name, type: 'file', size: `${(content.length / 1024).toFixed(1)} KB`, modified: nowStamp(), content });
      res.json({ success: true, message: 'Saved (demo)' });
    }
  ));

  router.post('/files/upload', upload.single('file'), handle('file upload',
    async (req, res, srv) => {
      if (!req.file) throw security.httpError(400, 'No file uploaded');
      const targetDir = security.safeRemoteDir(req.body.path, '/root');
      const fileName = security.assertFileName(path.posix.basename(String(req.file.originalname || '').replace(/\\/g, '/')));
      const remotePath = security.safeRemotePath(targetDir, fileName, '/root');
      await ssh.uploadFile(srv, remotePath, req.file.buffer);
      res.json({ success: true, message: `Uploaded ${fileName} successfully to ${targetDir}`, fileName, size: req.file.size });
    },
    async (req, res) => {
      if (!req.file) throw security.httpError(400, 'No file uploaded');
      const targetDir = security.safeRemoteDir(req.body.path, '/root');
      const fileName = security.assertFileName(path.posix.basename(String(req.file.originalname || '').replace(/\\/g, '/')));
      (demoFs[targetDir] || (demoFs[targetDir] = [])).push({
        name: fileName, type: 'file', size: `${(req.file.size / 1024).toFixed(1)} KB`, modified: nowStamp()
      });
      res.json({ success: true, message: `Uploaded ${fileName} (demo)` });
    }
  ));

  router.get('/files/download', async (req, res) => {
    try {
      if (!req.query.name) return res.status(400).send('File name required');
      const fullPath = security.safeRemotePath(req.query.path, req.query.name, '/root');
      const safeName = path.posix.basename(fullPath);
      const srv = store.getActiveServer();
      if (!srv.isReal) return res.status(404).send('File not found or server offline');

      const readStream = await ssh.getReadStream(srv, fullPath);
      // ASCII fallback + RFC 5987 form; both escaped so no header injection is possible.
      res.setHeader('Content-Disposition',
        `attachment; filename="${safeName.replace(/[^\w.\- ]/g, '_')}"; filename*=UTF-8''${encodeURIComponent(safeName)}`);
      res.setHeader('Content-Type', 'application/octet-stream');
      readStream.on('error', streamErr => {
        console.error('Download stream error:', streamErr.message);
        if (!res.headersSent) res.status(500).end();
        else res.destroy();
      });
      readStream.pipe(res);
    } catch (err) {
      const status = Number(err.statusCode) || 500;
      if (status === 500) console.error('Download error:', err.message);
      res.status(status).send(status === 500 ? 'Error downloading file' : err.message);
    }
  });

  router.post('/files/delete', handle('file delete',
    async (req, res, srv) => {
      const fullPath = security.safeRemotePath(req.body.path, req.body.name, '/root');
      await ssh.deleteItem(srv, fullPath);
      res.json({ success: true, message: 'Item deleted on remote server' });
    },
    async (req, res) => {
      const fullPath = security.safeRemotePath(req.body.path, req.body.name, '/root');
      const parent = path.posix.dirname(fullPath);
      if (demoFs[parent]) demoFs[parent] = demoFs[parent].filter(f => f.name !== req.body.name);
      res.json({ success: true, message: 'Item deleted (demo)' });
    }
  ));

  router.post('/files/create-folder', handle('create folder',
    async (req, res, srv) => {
      const fullPath = security.safeRemotePath(req.body.path, req.body.name, '/root');
      await ssh.createFolder(srv, fullPath);
      res.json({ success: true, message: 'Folder created' });
    },
    async (req, res) => {
      const fullPath = security.safeRemotePath(req.body.path, req.body.name, '/root');
      const parent = path.posix.dirname(fullPath);
      (demoFs[parent] || (demoFs[parent] = [])).push({ name: req.body.name, type: 'dir', size: '--', modified: nowStamp() });
      res.json({ success: true, message: 'Folder created (demo)' });
    }
  ));

  router.post('/files/rename', handle('rename',
    async (req, res, srv) => {
      const { path: dir, oldName, newName } = req.body || {};
      await ssh.renameItem(srv, security.safeRemotePath(dir, oldName, '/root'), security.safeRemotePath(dir, newName, '/root'));
      res.json({ success: true, message: 'Renamed successfully' });
    },
    async (req, res) => {
      const { path: dir, oldName, newName } = req.body || {};
      const oldPath = security.safeRemotePath(dir, oldName, '/root');
      security.assertFileName(newName);
      const item = (demoFs[path.posix.dirname(oldPath)] || []).find(f => f.name === oldName);
      if (item) item.name = newName;
      res.json({ success: true, message: 'Renamed (demo)' });
    }
  ));

  return router;
};
