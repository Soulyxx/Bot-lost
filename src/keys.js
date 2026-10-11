'use strict';
const crypto = require('crypto');

const ALPHA = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';

function seg(n = 4) {
  const b = crypto.randomBytes(n);
  let s = '';
  for (let i = 0; i < n; i++) s += ALPHA[b[i] % ALPHA.length];
  return s;
}
function gen() { return 'LOST-' + seg() + '-' + seg() + '-' + seg(); }
function normalize(k) { return String(k || '').trim().toUpperCase().replace(/\s+/g, ''); }

function parseDuration(str) {
  if (!str) return null;
  const s = String(str).trim().toLowerCase();
  if (['life', 'lifetime', 'perm', 'permanent', 'forever', 'inf'].includes(s)) return null;
  const m = s.match(/^(\d+)\s*(m|min|h|d|w|mo|y)$/);
  if (!m) return undefined;
  const n = parseInt(m[1], 10);
  const mult = { m: 60000, min: 60000, h: 3600000, d: 86400000, w: 604800000, mo: 2592000000, y: 31536000000 }[m[2]];
  return n * mult;
}

const PLAN_DAYS = { trial: 1, week: 7, month: 30, lifetime: null };

module.exports = { gen, normalize, parseDuration, PLAN_DAYS };