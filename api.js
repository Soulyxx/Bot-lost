'use strict';
const express = require('express');
const { validate } = require('./auth');
const { safeEqual } = require('./util');
const { mountVoice } = require('./voice');
const persist = require('./persist');

const SECRET = process.env.AUTH_SECRET || '';
const hits = new Map();
function rate(ip, max = 40, win = 60000) {
  const now = Date.now();
  const arr = (hits.get(ip) || []).filter(t => now - t < win);
  arr.push(now);
  hits.set(ip, arr);
  return arr.length <= max;
}

function startApi() {
  const app = express();
  app.set('trust proxy', true);
  app.use(express.json({ limit: '8mb' }));

  app.get('/', (_q, res) => res.json({ ok: true, service: 'losttool-auth' }));
  app.get('/api/ping', (_q, res) => res.json({ ok: true, t: Date.now() }));

  const admin = (req, res, next) => { if (SECRET && !safeEqual(req.headers['x-lost-secret'] || '', SECRET)) return res.json({ ok: false, error: 'Bad secret' }); next(); };

  app.post('/api/auth', async (req, res) => {
    try {
      const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
      if (SECRET && !safeEqual(req.headers['x-lost-secret'] || '', SECRET)) return res.json({ ok: false, error: 'Bad secret' });
      if (!rate(ip)) return res.json({ ok: false, error: 'Too many requests, wait a minute' });
      const { key, hwid, user, host, version } = req.body || {};
      res.json(await validate({ key, hwid, user, host, version, ip }));
    } catch { res.json({ ok: false, error: 'Server error' }); }
  });

  /* --- backup de keys (sobrevive a cualquier redeploy) --- */
  app.get('/api/backup', admin, async (_q, res) => { try { res.json({ ok: true, data: await persist.dump() }); } catch (e) { res.json({ ok: false, error: e.message }); } });
  app.post('/api/backup', admin, async (req, res) => { try { res.json(await persist.importData(req.body)); } catch (e) { res.json({ ok: false, error: e.message }); } });
  app.post('/api/snapshot', admin, async (_q, res) => { try { res.json(await persist.snapshot('manual')); } catch (e) { res.json({ ok: false, error: e.message }); } });

  mountVoice(app);

  const port = process.env.PORT || 3000;
  app.listen(port, () => console.log('[api] escuchando en ' + port));
}

module.exports = { startApi };