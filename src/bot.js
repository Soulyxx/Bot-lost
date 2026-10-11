'use strict';
const { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const db = require('./db');
const { gen, normalize, parseDuration, PLAN_DAYS } = require('./keys');
const { fmtDuration } = require('./util');

const TOKEN = process.env.DISCORD_TOKEN;
const ADMINS = (process.env.ADMIN_IDS || '').split(',').map(s => s.trim()).filter(Boolean);
const ADMIN_ROLE = process.env.ADMIN_ROLE_ID || '';
const GUILD = process.env.GUILD_ID || '';
const PLANS = ['trial', 'week', 'month', 'lifetime'];

const planOpt = o => o.setName('plan').setDescription('Plan').setRequired(true).addChoices(...PLANS.map(p => ({ name: p, value: p })));

const commands = [
  new SlashCommandBuilder().setName('genkey').setDescription('Generar key(s) de licencia')
    .addStringOption(planOpt)
    .addIntegerOption(o => o.setName('cantidad').setDescription('Cuántas (1-25)').setMinValue(1).setMaxValue(25))
    .addStringOption(o => o.setName('duracion').setDescription('Override: 3d, 12h, 1y (se ignora en lifetime)'))
    .addUserOption(o => o.setName('usuario').setDescription('Mandar la key por DM a este usuario'))
    .addStringOption(o => o.setName('nota').setDescription('Nota interna')),
  new SlashCommandBuilder().setName('delkey').setDescription('Borrar una key').addStringOption(o => o.setName('key').setDescription('La key').setRequired(true)),
  new SlashCommandBuilder().setName('revoke').setDescription('Quitar acceso (mantiene la key)').addStringOption(o => o.setName('key').setDescription('La key').setRequired(true)),
  new SlashCommandBuilder().setName('unrevoke').setDescription('Devolver acceso').addStringOption(o => o.setName('key').setDescription('La key').setRequired(true)),
  new SlashCommandBuilder().setName('reset').setDescription('Resetear HWID (permite otra PC)').addStringOption(o => o.setName('key').setDescription('La key').setRequired(true)),
  new SlashCommandBuilder().setName('setplan').setDescription('Cambiar el plan')
    .addStringOption(o => o.setName('key').setDescription('La key').setRequired(true)).addStringOption(planOpt),
  new SlashCommandBuilder().setName('settime').setDescription('Setear/extender el tiempo')
    .addStringOption(o => o.setName('key').setDescription('La key').setRequired(true))
    .addStringOption(o => o.setName('duracion').setDescription('30d, 12h, 1y o lifetime').setRequired(true)),
  new SlashCommandBuilder().setName('info').setDescription('Ver detalle de una key').addStringOption(o => o.setName('key').setDescription('La key').setRequired(true)),
  new SlashCommandBuilder().setName('listkeys').setDescription('Listar keys')
    .addStringOption(o => o.setName('estado').setDescription('Filtro').addChoices({ name: 'activas', value: 'active' }, { name: 'revocadas', value: 'revoked' }))
    .addStringOption(o => o.setName('plan').setDescription('Filtro plan').addChoices(...PLANS.map(p => ({ name: p, value: p }))))
    .addIntegerOption(o => o.setName('pagina').setDescription('Página').setMinValue(1)),
  new SlashCommandBuilder().setName('stats').setDescription('Resumen general')
].map(c => c.toJSON());

const client = new Client({ intents: [GatewayIntentBits.Guilds] });
const ep = { ephemeral: true };

function isAdmin(i) {
  if (!ADMINS.length && !ADMIN_ROLE) return true;
  if (ADMINS.includes(i.user.id)) return true;
  if (ADMIN_ROLE && i.member && i.member.roles.cache.has(ADMIN_ROLE)) return true;
  return false;
}
function expiryFor(plan, durStr) {
  if (plan === 'lifetime') return null;
  const custom = parseDuration(durStr);
  if (custom != null && custom !== undefined) return Date.now() + custom;
  const days = PLAN_DAYS[plan];
  return days == null ? null : Date.now() + days * 86400000;
}
const line = r => `\`${r.key}\` · **${r.plan}** · ` +
  (r.expires_at ? 'exp ' + fmtDuration(r.expires_at - Date.now()) : 'lifetime') +
  (r.hwid ? ' · 🔒' : '') + (r.status !== 'active' ? ' · ' + r.status : '');

client.on('interactionCreate', async i => {
  if (!i.isChatInputCommand()) return;
  if (!isAdmin(i)) return i.reply({ content: 'No autorizado', ...ep });
  const n = i.commandName;
  const getK = () => normalize(i.options.getString('key'));

  try {
    if (n === 'genkey') {
      const plan = i.options.getString('plan');
      const count = i.options.getInteger('cantidad') || 1;
      const dur = i.options.getString('duracion');
      const target = i.options.getUser('usuario');
      const note = i.options.getString('nota') || '';
      if (dur && parseDuration(dur) === undefined) return i.reply({ content: 'Duración inválida (usá 3d, 12h, 1y, lifetime)', ...ep });
      const expires = expiryFor(plan, dur);
      const created = [];
      for (let x = 0; x < count; x++) {
        let key;
        do { key = gen(); } while (await db.getKey(key));
        const rec = { key, plan, created_at: Date.now(), expires_at: expires, owner: target ? target.id : null, note, created_by: i.user.id };
        await db.insertKey(rec); await db.log(key, 'gen', plan + (dur ? ' ' + dur : '')); created.push(rec);
      }
      const embed = new EmbedBuilder().setTitle(`✅ Generé ${created.length} key(s)`).setColor(0x8b5cff).setDescription(created.map(line).join('\n').slice(0, 4000));
      await i.reply({ embeds: [embed], ...ep });
      if (target) { try { await target.send(`🔑 Tu key de Lost Tool: \`${created[0].key}\` (${plan})`); } catch {} }
    }
    else if (n === 'delkey') {
      const k = getK(); const rec = await db.getKey(k);
      if (!rec) return i.reply({ content: 'No existe esa key', ...ep });
      await db.deleteKey(k); await db.log(k, 'delete', i.user.id);
      i.reply({ content: `🗑️ Borrada \`${k}\``, ...ep });
    }
    else if (n === 'revoke' || n === 'unrevoke') {
      const k = getK(); const rec = await db.getKey(k);
      if (!rec) return i.reply({ content: 'No existe esa key', ...ep });
      const status = n === 'revoke' ? 'revoked' : 'active';
      await db.updateKey(k, { status }); await db.log(k, n, i.user.id);
      i.reply({ content: `\`${k}\` → **${status}**`, ...ep });
    }
    else if (n === 'reset') {
      const k = getK(); const rec = await db.getKey(k);
      if (!rec) return i.reply({ content: 'No existe esa key', ...ep });
      await db.updateKey(k, { hwid: null }); await db.log(k, 'reset', i.user.id);
      i.reply({ content: `♻️ HWID reseteado en \`${k}\` — ya se puede usar en otra PC`, ...ep });
    }
    else if (n === 'setplan') {
      const k = getK(); const plan = i.options.getString('plan'); const rec = await db.getKey(k);
      if (!rec) return i.reply({ content: 'No existe esa key', ...ep });
      await db.updateKey(k, { plan, expires_at: expiryFor(plan, null) }); await db.log(k, 'setplan', plan);
      i.reply({ content: `\`${k}\` → plan **${plan}**`, ...ep });
    }
    else if (n === 'settime') {
      const k = getK(); const dur = i.options.getString('duracion'); const rec = await db.getKey(k);
      if (!rec) return i.reply({ content: 'No existe esa key', ...ep });
      const ms = parseDuration(dur);
      if (ms === undefined) return i.reply({ content: 'Duración inválida (3d, 12h, 1y, lifetime)', ...ep });
      const expires = ms == null ? null : Date.now() + ms;
      await db.updateKey(k, { expires_at: expires }); await db.log(k, 'settime', dur);
      i.reply({ content: `\`${k}\` → expira: **${expires ? fmtDuration(expires - Date.now()) : 'lifetime'}**`, ...ep });
    }
    else if (n === 'info') {
      const k = getK(); const r = await db.getKey(k);
      if (!r) return i.reply({ content: 'No existe esa key', ...ep });
      const embed = new EmbedBuilder().setTitle('🔎 ' + r.key).setColor(0x8b5cff).addFields(
        { name: 'Plan', value: r.plan, inline: true },
        { name: 'Estado', value: r.status, inline: true },
        { name: 'Expira', value: r.expires_at ? fmtDuration(r.expires_at - Date.now()) : 'lifetime', inline: true },
        { name: 'HWID', value: r.hwid || 'sin bindear', inline: false },
        { name: 'Último uso', value: r.last_seen ? new Date(r.last_seen).toISOString() : 'nunca', inline: true },
        { name: 'Último host', value: r.last_host || '-', inline: true },
        { name: 'IP', value: r.last_ip || '-', inline: true },
        { name: 'Nota', value: r.note || '-', inline: false }
      );
      i.reply({ embeds: [embed], ...ep });
    }
    else if (n === 'listkeys') {
      const page = i.options.getInteger('pagina') || 1;
      const { total, rows } = await db.listKeys({ status: i.options.getString('estado') || undefined, plan: i.options.getString('plan') || undefined, page, perPage: 10 });
      if (!total) return i.reply({ content: 'Sin resultados', ...ep });
      const embed = new EmbedBuilder().setTitle(`🔑 Keys (${total})`).setColor(0x8b5cff)
        .setFooter({ text: `Página ${page} / ${Math.ceil(total / 10)}` }).setDescription(rows.map(line).join('\n'));
      i.reply({ embeds: [embed], ...ep });
    }
    else if (n === 'stats') {
      const s = await db.stats();
      const tot = s.reduce((a, x) => a + Number(x.c), 0);
      const embed = new EmbedBuilder().setTitle('📊 Stats').setColor(0x8b5cff)
        .setDescription(s.length ? s.map(x => `**${x.plan}** · ${x.status}: ${x.c}`).join('\n') : 'Sin keys').setFooter({ text: 'Total: ' + tot });
      i.reply({ embeds: [embed], ...ep });
    }
  } catch (e) { i.reply({ content: 'Error: ' + e.message, ...ep }).catch(() => {}); }
});

async function register() {
  const rest = new REST({ version: '10' }).setToken(TOKEN);
  if (GUILD) await rest.put(Routes.applicationGuildCommands(client.application.id, GUILD), { body: commands });
  else await rest.put(Routes.applicationCommands(client.application.id), { body: commands });
  console.log('[bot] comandos registrados' + (GUILD ? ' (guild)' : ' (global)'));
}
function startBot() {
  client.once('ready', async () => {
    console.log('[bot] logueado como ' + client.user.tag);
    try { await register(); } catch (e) { console.error('[bot] register', e.message); }
  });
  client.login(TOKEN).catch(e => console.error('[bot] login', e.message));
}

module.exports = { startBot };