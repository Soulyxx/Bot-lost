'use strict';
/* Lost Tool — 24/7 voice server. MULTI-TENANT: cada usuario tiene su propia "room". */

const http = require('http');
const { Client } = require('discord.js-selfbot-v13');

const PORT = process.env.PORT || 3000;
const SECRET = process.env.LOST_SECRET || 'asdasfafgmawf-mawfmawf192313199nmsdad9';

const sleep = ms => new Promise(r => setTimeout(r, ms));
const cleanTok = t => String(t == null ? '' : t).trim().replace(/^["'`]+|["'`]+$/g, '').replace(/^Bearer\s+/i, '').trim();

/* rooms: Map<room, Map<token, entry>> */
const rooms = new Map();
function roomOf(req, body) {
  const h = req.headers['x-lost-room'];
  const r = (body && body.room) || (h ? decodeURIComponent(String(h)) : '');
  return String(r || 'default').trim() || 'default';
}
function roomMap(room) { let m = rooms.get(room); if (!m) { m = new Map(); rooms.set(room, m); } return m; }

/* ---- helpers de voz ---- */
function vGuildId(e) { try { const c = e.client.channels.cache.get(e.channel); return c && c.guildId; } catch { return null; } }
function vConn(e) { try { const arr = [...e.client.voice.connections.values()]; return arr.find(c => (c.channelId || (c.channel && c.channel.id)) === e.channel) || arr[0] || null; } catch { return null; } }
function vVs(e) { try { const g = vGuildId(e); return g && e.client.guilds.cache.get(g) ? e.client.guilds.cache.get(g).voiceStates.cache.get(e.client.user.id) : null; } catch { return null; } }
function vConnected(e) { return !!vConn(e); }
function vWs(e, opts) {
  const gid = vGuildId(e); if (!gid) return;
  const vs = vVs(e);
  const d = { guild_id: gid, channel_id: e.channel, self_mute: opts.mute != null ? opts.mute : !!(vs && vs.mute), self_deaf: opts.deaf != null ? opts.deaf : !!(vs && vs.deaf), self_video: false };
  try { e.client.ws.send({ op: 4, d }); } catch {}
}
async function vSelfDeaf(e, v) { const c = vConn(e); if (c && c.setSelfDeaf) { await c.setSelfDeaf(v); return; } const vs = vVs(e); if (vs && vs.setSelfDeaf) { await vs.setSelfDeaf(v); return; } vWs(e, { deaf: v }); }
async function vSelfMute(e, v) { const c = vConn(e); if (c && c.setSelfMute) { await c.setSelfMute(v); return; } const vs = vVs(e); if (vs && vs.setSelfMute) { await vs.setSelfMute(v); return; } vWs(e, { mute: v }); }
async function vJoin(e) {
  if (!e.client || !e.client.user || !e.channel) return false;
  try {
    if (vConnected(e)) return true;
    const chn = e.client.channels.cache.get(e.channel) || await e.client.channels.fetch(e.channel).catch(() => null);
    if (!chn) return false;
    await e.client.voice.joinChannel(chn);
    await sleep(400);
    try { await vSelfDeaf(e, true); } catch {}
    return true;
  } catch { return false; }
}
function vInfo(token, e) {
  const u = e.client.user; const vs = vVs(e);
  return { token, id: u.id, username: u.username, avatar: u.avatar, channel: e.channel, auto: e.auto, connected: vConnected(e), deaf: !!(vs && vs.deaf), mute: !!(vs && vs.mute) };
}

async function dRest(method, ep, body, token, ms = 15000) {
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), ms);
  try {
    const r = await fetch('https://discord.com/api/v10' + ep, { method, headers: { Authorization: token, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body), signal: ctl.signal });
    if (!r.ok && r.status !== 204) throw new Error('Discord ' + r.status);
    return r.status === 204 ? null : r.json().catch(() => null);
  } finally { clearTimeout(t); }
}

async function join(room, token, channel, auto) {
  token = cleanTok(token); channel = String(channel || '').trim();
  if (!token || !channel) throw new Error('Token and voice channel ID required');
  const map = roomMap(room);
  if (map.has(token)) await leave(room, token);
  const e = { client: null, channel, auto: auto !== false, watch: null };
  e.client = new Client({ checkUpdate: false, readyStatus: false });
  e.client.on('error', () => {});
  e.client.on('shardResume', () => setTimeout(() => vJoin(e), 1000));
  e.client.on('ready', () => setTimeout(() => vJoin(e), 800));
  e.client.on('voiceStateUpdate', (o, n) => { if (!e.client.user || n.id !== e.client.user.id) return; if (!n.channelId && e.auto) setTimeout(() => vJoin(e), 1200); });
  map.set(token, e);
  await e.client.login(token).catch(err => { map.delete(token); throw err; });
  await sleep(700);
  await vJoin(e);
  if (e.auto) e.watch = setInterval(() => { if (!e.client || !e.client.user) return; if (!vConnected(e)) vJoin(e).catch(() => {}); }, 3500);
  return vInfo(token, e);
}
async function leave(room, token) {
  const map = rooms.get(room); if (!map) return;
  if (token) {
    const e = map.get(token); if (!e) return;
    if (e.watch) clearInterval(e.watch);
    try { e.client.voice.connections.forEach(c => c.disconnect()); } catch {}
    try { e.client.destroy(); } catch {}
    map.delete(token);
  } else {
    for (const t of [...map.keys()]) await leave(room, t);
  }
}
function list(room) {
  const map = rooms.get(room); if (!map) return [];
  return [...map.entries()].map(([t, e]) => { try { return e.client.user ? vInfo(t, e) : null; } catch { return null; } }).filter(Boolean);
}
async function action(room, token, act, arg) {
  const map = rooms.get(room); const e = map && map.get(token); if (!e) throw new Error('Account not running');
  const u = e.client.user; if (!u) throw new Error('Not ready');
  switch (act) {
    case 'move': { if (!arg) throw new Error('Missing channel ID'); const chn = e.client.channels.cache.get(arg) || await e.client.channels.fetch(arg).catch(() => null); if (!chn) throw new Error('Channel not found'); await e.client.voice.joinChannel(chn); e.channel = arg; return 'Moved to ' + arg; }
    case 'disconnect': { try { e.client.voice.connections.forEach(c => c.disconnect()); } catch {} e.auto = false; return 'Disconnected'; }
    case 'connect': { e.auto = true; await vJoin(e); return 'Connected'; }
    case 'mute': { await vSelfMute(e, true); return 'Muted'; }
    case 'unmute': { await vSelfMute(e, false); return 'Unmuted'; }
    case 'deafen': { await vSelfDeaf(e, true); return 'Deafened'; }
    case 'undeafen': { await vSelfDeaf(e, false); return 'Undeafened'; }
    case 'nick': { if (!arg) throw new Error('Empty name'); try { await dRest('PATCH', '/users/@me', { username: arg }, token); return 'Username -> ' + arg; } catch { await dRest('PATCH', '/users/@me', { global_name: arg }, token); return 'Display name -> ' + arg; } }
    default: throw new Error('Unknown action');
  }
}

function send(res, code, obj) { const s = JSON.stringify(obj); res.writeHead(code, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }); res.end(s); }
function readBody(req) { return new Promise(resolve => { let d = ''; req.on('data', c => { d += c; if (d.length > 2e6) req.destroy(); }); req.on('end', () => { try { resolve(d ? JSON.parse(d) : {}); } catch { resolve({}); } }); req.on('error', () => resolve({})); }); }

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://x');
    const p = url.pathname.replace(/\/+$/, '');
    if (req.method === 'OPTIONS') { res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': '*' }); return res.end(); }
    if (p === '/health' || p === '/voice/health') return send(res, 200, { ok: true, rooms: rooms.size, uptime: process.uptime() });
    if (SECRET && req.headers['x-lost-secret'] !== SECRET) return send(res, 401, { error: 'bad secret' });
    const body = (req.method === 'POST' || req.method === 'PUT') ? await readBody(req) : {};
    const room = roomOf(req, body);
    if (p === '/voice/list' && req.method === 'GET') return send(res, 200, { sessions: list(room), room, roomed: true });
    if (p === '/voice/join' && req.method === 'POST') { const s = await join(room, body.token, body.channel, body.auto); return send(res, 200, { ok: true, session: s }); }
    if (p === '/voice/leave' && req.method === 'POST') { if (body.all) await leave(room); else await leave(room, cleanTok(body.token)); return send(res, 200, { ok: true }); }
    if (p === '/voice/action' && req.method === 'POST') { const r = await action(room, cleanTok(body.token), body.action, body.arg); return send(res, 200, { ok: true, result: r }); }
    return send(res, 404, { error: 'not found' });
  } catch (e) { return send(res, 500, { error: e.message }); }
});
server.listen(PORT, () => console.log('lost 24/7 server (multi-room) on ' + PORT));