'use strict';
require('dotenv').config();
const { init } = require('./db');
const { startApi } = require('./api');
const { startBot } = require('./bot');
const { initVoice, stopAll } = require('./voice');

(async () => {
  await init();
  startApi();
  startBot();
  await initVoice();
  console.log('[auth] sistema arriba');
})().catch(e => { console.error('[fatal]', e); process.exit(1); });

process.on('SIGTERM', () => { stopAll(); setTimeout(() => process.exit(0), 800); });
process.on('SIGINT', () => { stopAll(); setTimeout(() => process.exit(0), 400); });