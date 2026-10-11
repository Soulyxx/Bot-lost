'use strict';
require('dotenv').config();
const { init } = require('./db');
const { startApi } = require('./api');
const { startBot } = require('./bot');

(async () => {
  await init();
  startApi();
  startBot();
  console.log('[auth] sistema arriba');
})().catch(e => { console.error('[fatal]', e); process.exit(1); });