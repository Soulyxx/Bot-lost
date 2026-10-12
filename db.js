'use strict';
const fs = require('fs');
const path = require('path');

const USE_PG = !!process.env.DATABASE_URL;

/* --- ubicación durable: Postgres, o un directorio persistente (VOLUMEN) --- */
function pickDir() {
  const cands = [process.env.DB_DIR, '/data', '/var/data'].filter(Boolean);
  for (const d of cands) {
    try { fs.mkdirSync(d, { recursive: true }); fs.accessSync(d, fs.constants.W_OK); return d; } catch {}
  }
  return process.cwd();
}
const DB_DIR = pickDir();
const DB_FILE = process.env.DB_FILE || path.join(DB_DIR, 'auth.db');
const SNAP_FILE = process.env.SNAP_FILE || path.join(DB_DIR, 'keys.backup.json');

let pool = null, sqlite = null;
let onChange = null;
const setOnChange = fn => { onChange = fn; };
const fire = () => { if (onChange) try { onChange(); } catch {} };

const KEYS_PG = `CREATE TABLE IF NOT EXISTS keys (
  key TEXT PRIMARY KEY, plan TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active',
  created_at BIGINT NOT NULL, expires_at BIGINT, hwid TEXT, owner TEXT, note TEXT, created_by TEXT,
  last_seen BIGINT, last_ip TEXT, last_user TEXT, last_host TEXT)`;
const KEYS_SQ = KEYS_PG.replace(/BIGINT/g, 'INTEGER');
const LOGS_PG = `CREATE TABLE IF NOT EXISTS logs (id BIGSERIAL PRIMARY KEY, key TEXT, action TEXT, detail TEXT, at BIGINT)`;
const LOGS_SQ = `CREATE TABLE IF NOT EXISTS logs (id INTEGER PRIMARY KEY AUTOINCREMENT, key TEXT, action TEXT, detail TEXT, at INTEGER)`;
const VOICE_PG = `CREATE TABLE IF NOT EXISTS voice_sessions (room TEXT NOT NULL DEFAULT 'default', token TEXT NOT NULL, channel TEXT NOT NULL, label TEXT, auto INTEGER, deaf INTEGER, at BIGINT, PRIMARY KEY (room, token))`;
const VOICE_SQ = VOICE_PG.replace(/BIGINT/g, 'INTEGER');

async function init() {
  if (USE_PG) {
    const { Pool } = require('pg');
    pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: process.env.PGSSL === 'false' ? false : { rejectUnauthorized: false } });
    await pool.query(KEYS_PG);
    await pool.query(LOGS_PG);
    await pool.query(VOICE_PG);
    console.log('[db] postgres listo (DURABLE)');
  } else {
    const Database = require('better-sqlite3');
    sqlite = new Database(DB_FILE);
    sqlite.pragma('journal_mode = WAL');
    sqlite.exec(KEYS_SQ);
    sqlite.exec(LOGS_SQ);
    sqlite.exec(VOICE_SQ);
    console.log('[db] sqlite en ' + DB_FILE + (DB_DIR === process.cwd() ? '  << SIN volumen: efímero en Railway!' : '  (volumen durable)'));
  }
}

const toPg = sql => { let i = 0; return sql.replace(/\?/g, () => '$' + (++i)); };
async function run(sql, p = []) { return USE_PG ? pool.query(toPg(sql), p) : sqlite.prepare(sql).run(...p); }
async function all(sql, p = []) { return USE_PG ? (await pool.query(toPg(sql), p)).rows : sqlite.prepare(sql).all(...p); }
async function get(sql, p = []) { return USE_PG ? (await pool.query(toPg(sql), p)).rows[0] : sqlite.prepare(sql).get(...p); }

async function getKey(key) { return get('SELECT * FROM keys WHERE key = ?', [key]); }
async function insertKey(r) {
  await run(
    `INSERT INTO keys (key,plan,status,created_at,expires_at,hwid,owner,note,created_by,last_seen,last_ip,last_user,last_host)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [r.key, r.plan, r.status || 'active', r.created_at, r.expires_at ?? null, r.hwid ?? null, r.owner ?? null,
     r.note ?? null, r.created_by ?? null, r.last_seen ?? null, r.last_ip ?? null, r.last_user ?? null, r.last_host ?? null]
  );
}
async function updateKey(key, patch) {
  const cols = Object.keys(patch);
  if (!cols.length) return;
  await run(`UPDATE keys SET ${cols.map(c => c + ' = ?').join(', ')} WHERE key = ?`, [...cols.map(c => patch[c]), key]);
}
async function deleteKey(key) { await run('DELETE FROM keys WHERE key = ?', [key]); }

async function listKeys({ status, plan, owner, page = 1, perPage = 10 } = {}) {
  const where = [], p = [];
  if (status) { where.push('status = ?'); p.push(status); }
  if (plan) { where.push('plan = ?'); p.push(plan); }
  if (owner) { where.push('owner = ?'); p.push(owner); }
  const w = where.length ? 'WHERE ' + where.join(' AND ') : '';
  const total = Number((await get(`SELECT COUNT(*) AS c FROM keys ${w}`, p)).c);
  const rows = await all(`SELECT * FROM keys ${w} ORDER BY created_at DESC LIMIT ? OFFSET ?`, [...p, perPage, (page - 1) * perPage]);
  return { total, rows };
}

async function stats() { return all(`SELECT status, plan, COUNT(*) AS c FROM keys GROUP BY status, plan`, []); }
async function log(key, action, detail = '') {
  await run('INSERT INTO logs (key,action,detail,at) VALUES (?,?,?,?)', [key, action, String(detail), Date.now()]);
  fire();
}

/* --- sesiones de voz persistentes (por room) --- */
async function saveVoice(list) {
  await run('DELETE FROM voice_sessions');
  for (const s of list) await run('INSERT INTO voice_sessions (room,token,channel,label,auto,deaf,at) VALUES (?,?,?,?,?,?,?)',
    [s.room || 'default', s.token, s.channel, s.label || '', s.auto ? 1 : 0, s.deaf ? 1 : 0, Date.now()]);
}
async function loadVoice() { return all('SELECT * FROM voice_sessions', []); }

module.exports = { init, getKey, insertKey, updateKey, deleteKey, listKeys, stats, log, saveVoice, loadVoice, run, all, get, setOnChange, SNAP_FILE, DB_FILE, DB_DIR };