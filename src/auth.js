'use strict';
const db = require('./db');
const { normalize } = require('./keys');

async function validate({ key, hwid, user, host, version, ip }) {
  const k = normalize(key || '');
  if (!k) return { ok: false, error: 'Missing key' };

  const rec = await db.getKey(k);
  if (!rec) return { ok: false, error: 'Invalid key' };
  if (rec.status === 'revoked') return { ok: false, error: 'Key revoked' };
  if (rec.expires_at && Date.now() > rec.expires_at) return { ok: false, error: 'Key expired' };

  const h = String(hwid || '').toUpperCase().slice(0, 64);
  if (!rec.hwid) {
    await db.updateKey(k, { hwid: h });
    await db.log(k, 'bind', h + ' | ' + (host || ''));
  } else if (h && rec.hwid !== h) {
    await db.log(k, 'mismatch', 'got ' + h + ' want ' + rec.hwid);
    return { ok: false, error: 'Key bound to another PC (ask for a reset)' };
  }

  await db.updateKey(k, { last_seen: Date.now(), last_ip: ip || '', last_user: user || '', last_host: host || '' });

  const daysLeft = rec.expires_at ? Math.max(0, Math.ceil((rec.expires_at - Date.now()) / 86400000)) : null;
  return { ok: true, plan: rec.plan, expiresAt: rec.expires_at || null, daysLeft };
}

module.exports = { validate };