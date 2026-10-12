'use strict';
require('dotenv').config();
const { init } = require('./db');
const persist = require('./persist');
const { startApi } = require('./api');
const { startBot } = require('./bot');
const { initVoice, stopAll } = require('./voice');

(async () => {
  await init();
  await persist.autoRestore();   // si el deploy borró la DB pero hay snapshot -> restaura
  persist.schedule();            // snapshots tras cada cambio + cada 5 min
  startApi();
  startBot();
  await initVoice();
  console.log('[auth] sistema arriba');
})().catch(e => { console.error('[fatal]', e); process.exit(1); });

process.on('SIGTERM', async () => { try { await persist.snapshot('sigterm'); } catch {} stopAll(); setTimeout(() => process.exit(0), 800); });
process.on('SIGINT', async () => { try { await persist.snapshot('sigint'); } catch {} stopAll(); setTimeout(() => process.exit(0), 400); });