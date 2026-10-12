'use strict';
const fs = require('fs');
const express = require('express');
const { Client } = require('discord.js-selfbot-v13');
const { safeEqual } = require('./util');
const db = require('./db');

const SECRET = process.env.AUTH_SECRET || '';
const FILE = process.env.VOICE_FILE || 'voice.json';

const sleep = ms => new Promise(r => setTimeout(r, ms));
const log = (...a) => console.log('[voice]', ...a);
const clean = v => String(v == null ? '' : v).trim().replace(/^["'`]+|["'`]+$/g, '').replace(/^Bearer\s+/i, '').trim();

class Stay {
  constructor(cfg) {
    this.cfg = { token: clean(cfg.token), channel: clean(cfg.channel), label: cfg.label || '', auto: cfg.auto !== false, deaf: cfg.deaf !== false };
    this.client = null;
    this.watch = null;
    this.connecting = false;
    this.dead = false;
  }
  get token() { return this.cfg.token; }
  get name() { return this.cfg.label || (this.client && this.client.user ? this.client.user.username : this.cfg.token.slice(0, 6)); }

  async connect() {
    if (this.dead || this.client) return;
    const c = new Client({ checkUpdate: false, readyStatus: false });
    this.client = c;
    c.on('error', () => {});
    c.on('shardError', e => log(this.name, 'shardError', e && e.message));
    c.on('shardResume', () => setTimeout(() => this.join(), 1500));
    c.on('ready', () => { log(this.name, 'listo como', c.user && c.user.tag); setTimeout(() => this.join(), 800); });
    c.on('voiceStateUpdate', (o, n) => {
      if (!c.user || n.id !== c.user.id) return;
      if (!n.channelId && this.cfg.auto) { log(this.name, 'me sacaron, re-uniendo...'); setTimeout(() => this.join(), 1500); }
    });
    try { await c.login(this.cfg.token); }
    catch (e) { log(this.name, '!! login fallo:', e.message); try { c.destroy(); } catch {} this.client = null; setTimeout(() => this.connect(), 8000); return; }
    this.startWatch();
  }

  connection() {
    try {
      const arr = [...this.client.voice.connections.values()];
      return arr.find(x => (x.channelId || (x.channel && x.channel.id)) === this.cfg.channel) || arr[0] || null;
    } catch { return null; }
  }

  async join() {
    if (this.dead || this.connecting) return;
    const c = this.client;
    if (!c || !c.user) return;
    if (this.connection()) return;
    this.connecting = true;
    try {
      const chn = c.channels.cache.get(this.cfg.channel) || await c.channels.fetch(this.cfg.channel).catch(() => null);
      if (!chn) { log(this.name, 'canal no encontrado'); return; }
      await c.voice.joinChannel(chn, { selfDeaf: this.cfg.deaf, selfMute: false });
      log(this.name, 'conectado a', chn.name || this.cfg.channel);
      await sleep(600);
      const conn = this.connection();
      if (conn && this.cfg.deaf && typeof conn.setSelfDeaf === 'function') { try { await conn.setSelfDeaf(true); } catch {} }
    } catch (e) { log(this.name, 'join error:', e.message); }
    finally { this.connecting = false; }
  }

  startWatch() {
    if (this.watch) clearInterval(this.watch);
    this.watch = setInterval(() => {
      if (this.dead || !this.client || !this.client.user) return;
      if (!this.connection() && this.cfg.auto) this.join();
    }, 5000);
  }

  async action(action, arg) {
    const c = this.client;
    if (!c || !c.user) throw new Error('Not ready');
    switch (action) {
      case 'move': {
        if (!arg) throw new Error('Missing channel ID');
        const chn = c.channels.cache.get(arg) || await c.channels.fetch(arg).catch(() => null);
        if (!chn) throw new Error('Channel not found');
        await c.voice.joinChannel(chn);
        this.cfg.channel = arg; persist();
        return 'Moved to ' + arg;
      }
      case 'connect': { this.cfg.auto = true; await this.join(); return 'Connected'; }
      case 'disconnect': { try { c.voice.connections.forEach(x => x.disconnect()); } catch {} this.cfg.auto = false; return 'Disconnected'; }
      case 'deafen': { const k = this.connection(); if (k && k.setSelfDeaf) await k.setSelfDeaf(true); return 'Deafened'; }
      case 'undeafen': { const k = this.connection(); if (k && k.setSelfDeaf) await k.setSelfDeaf(false); return 'Undeafened'; }
      case 'mute': { const k = this.connection(); if (k && k.setSelfMute) await k.setSelfMute(true); return 'Muted'; }
      case 'unmute': { const k = this.connection(); if (k && k.setSelfMute) await k.setSelfMute(false); return 'Unmuted'; }
      default: throw new Error('Unknown action');
    }
  }

  info() {
    const u = this.client && this.client.user;
    const conn = this.connection();
    return { token: this.cfg.token, id: u ? u.id : null, username: u ? u.username : this.name, avatar: u ? u.avatar : null, channel: this.cfg.channel, auto: this.cfg.auto, connected: !!conn, deaf: !!(conn && conn.selfDeaf), mute: !!(conn && conn.selfMute) };
  }

  stop() {
    this.dead = true;
    if (this.watch) clearInterval(this.watch);
    try { this.client.voice.connections.forEach(x => x.disconnect()); } catch {}
    try { this.client.destroy(); } catch {}
  }
}

const sessions = new Map();

/* guarda en archivo + DB (sobrevive redeploys) */
function persist() {
  const list = [...sessions.values()].map(s => s.cfg);
  try { fs.writeFileSync(FILE, JSON.stringify(list, null, 2)); } catch (e) { log('save error', e.message); }
  db.saveVoice(list).catch(e => log('db save error', e.message));
}

function mountVoice(app) {
  const r = express.Router();
  const auth = (req, res, next) => { if (SECRET && !safeEqual(req.headers['x-lost-secret'] || '', SECRET)) return res.status(401).json({ ok: false, error: 'Bad secret' }); next(); };

  r.get('/health', (req, res) => res.json({ ok: true, count: sessions.size, uptime: Math.floor(process.uptime()) }));

  r.get('/list', auth, (req, res) => res.json({ ok: true, sessions: [...sessions.values()].map(s => s.info()) }));

  r.post('/join', auth, async (req, res) => {
    const token = clean(req.body && req.body.token);
    const channel = clean(req.body && req.body.channel);
    if (!token || !channel) return res.status(400).json({ ok: false, error: 'token and channel required' });
    try {
      if (sessions.has(token)) sessions.get(token).stop();
      const s = new Stay({ token, channel, label: req.body.label, auto: req.body.auto, deaf: req.body.deaf });
      sessions.set(token, s); persist(); s.connect();
      res.json({ ok: true, result: 'Session started' });
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
  });

  r.post('/leave', auth, (req, res) => {
    const token = clean(req.body && req.body.token);
    if (token) { const s = sessions.get(token); if (s) { s.stop(); sessions.delete(token); } }
    else { for (const s of sessions.values()) s.stop(); sessions.clear(); }
    persist(); res.json({ ok: true });
  });

  r.post('/action', auth, async (req, res) => {
    const token = clean(req.body && req.body.token);
    const action = (req.body && req.body.action) || '';
    const arg = (req.body && req.body.arg) || '';
    const s = sessions.get(token);
    if (!s) return res.status(404).json({ ok: false, error: 'Session not found' });
    try { res.json({ ok: true, result: await s.action(action, arg) }); }
    catch (e) { res.status(500).json({ ok: false, error: e.message }); }
  });

  app.use('/voice', r);
  log('rutas /voice montadas');
}

async function initVoice() {
  let saved = [];
  try { saved = await db.loadVoice(); } catch {}
  if (!saved || !saved.length) { try { saved = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch {} }
  for (const cfg of (saved || [])) {
    if (!cfg || !cfg.token || !cfg.channel) continue;
    const s = new Stay({ token: cfg.token, channel: cfg.channel, label: cfg.label, auto: !!cfg.auto, deaf: cfg.deaf == null ? true : !!cfg.deaf });
    sessions.set(s.token, s);
    await s.connect();
    await sleep(1000);
  }
  if (sessions.size) log('restauradas', sessions.size, 'sesion(es)');
}

function stopAll() { for (const s of sessions.values()) s.stop(); persist(); }

module.exports = { mountVoice, initVoice, stopAll, sessions };