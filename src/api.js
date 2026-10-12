'use strict';
const express = require('express');
const { validate } = require('./auth');
const { safeEqual } = require('./util');
const { mountVoice } = require('./voice');

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
  app.use(express.json({ limit: '64kb' }));

  app.get('/', (_q, res) => res.json({ ok: true, service: 'losttool-auth' }));
  app.get('/api/ping', (_q, res) => res.json({ ok: true, t: Date.now() }));

  app.post('/api/auth', async (req, res) => {
    try {
      const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
      if (SECRET && !safeEqual(req.headers['x-lost-secret'] || '', SECRET)) return res.json({ ok: false, error: 'Bad secret' });
      if (!rate(ip)) return res.json({ ok: false, error: 'Too many requests, wait a minute' });
      const { key, hwid, user, host, version } = req.body || {};
      res.json(await validate({ key, hwid, user, host, version, ip }));
    } catch { res.json({ ok: false, error: 'Server error' }); }
  });

  mountVoice(app);

  const port = process.env.PORT || 3000;
  app.listen(port, () => console.log('[api] escuchando en ' + port));
}

module.exports = { startApi };