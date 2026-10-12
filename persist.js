'use strict';
/*
 * PERSISTENCIA — para que cada redeploy del auth NO borre las keys.
 *
 * Cómo:
 *   1) La DB es durable: Postgres (DATABASE_URL) o SQLite en un VOLUMEN (/data).
 *   2) Snapshot en disco tras cada cambio + cada 5 min.
 *   3) Al arrancar: si la DB quedó vacía pero hay snapshot -> restaura solo.
 *   4) Endpoints /api/backup para exportar/importar manualmente.
 */
const fs = require('fs');
const db = require('./db');

const SNAP = db.SNAP_FILE;
let interval = null;
let touchTimer = null;

function writeAtomic(file, data) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, file);
}

async function dump() {
  const keys = await db.all('SELECT * FROM keys', []);
  const logs = await db.all('SELECT * FROM logs ORDER BY id DESC LIMIT 5000', []);
  return { v: 1, at: Date.now(), keys, logs };
}

async function snapshot(reason = 'manual') {
  try {
    const data = await dump();
    writeAtomic(SNAP, JSON.stringify(data));
    return { ok: true, keys: data.keys.length, at: data.at, reason };
  } catch (e) {
    console.error('[persist] snapshot', e.message);
    return { ok: false, error: e.message };
  }
}

function schedule() {
  db.setOnChange(() => touch());
  if (interval) clearInterval(interval);
  interval = setInterval(() => snapshot('interval'), 5 * 60 * 1000);
  if (interval.unref) interval.unref();
  console.log('[persist] snapshots activos -> ' + SNAP);
}

function touch() {
  clearTimeout(touchTimer);
  touchTimer = setTimeout(() => snapshot('change'), 1500);
}

async function importData(obj) {
  if (!obj || !Array.isArray(obj.keys)) throw new Error('backup inválido');
  let n = 0;
  for (const k of obj.keys) {
    if (!k || !k.key) continue;
    const full = {
      key: k.key, plan: k.plan, status: k.status || 'active', created_at: k.created_at || Date.now(),
      expires_at: k.expires_at ?? null, hwid: k.hwid ?? null, owner: k.owner ?? null, note: k.note ?? null,
      created_by: k.created_by ?? null, last_seen: k.last_seen ?? null, last_ip: k.last_ip ?? null,
      last_user: k.last_user ?? null, last_host: k.last_host ?? null
    };
    const ex = await db.getKey(k.key);
    if (ex) await db.updateKey(k.key, full); else await db.insertKey(full);
    n++;
  }
  await snapshot('import');
  return { ok: true, restored: n };
}

async function autoRestore() {
  try {
    const c = Number((await db.get('SELECT COUNT(*) AS c FROM keys', [])).c);
    if (c > 0) return { ok: true, skipped: true, keys: c };
    if (!fs.existsSync(SNAP)) return { ok: true, empty: true };
    const obj = JSON.parse(fs.readFileSync(SNAP, 'utf8'));
    const r = await importData(obj);
    console.log('[persist] keys restauradas desde snapshot: ' + r.restored);
    return r;
  } catch (e) {
    console.error('[persist] autoRestore', e.message);
    return { ok: false, error: e.message };
  }
}

module.exports = { snapshot, schedule, touch, importData, autoRestore, dump, SNAP };