"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
require("dotenv/config");
const discord_js_1 = require("discord.js");
const TOKEN = process.env.DISCORD_TOKEN;
const GUILD_ID = process.env.GUILD_ID;
const ROLE_ID = process.env.ROLE_ID;
const ROLE_NAME = process.env.ROLE_NAME || 'Social Member';
const DEFAULT_DAYS = Number(process.env.DEFAULT_DAYS || 30);
const MAX_FETCH = Number(process.env.MAX_FETCH || 2000);
if (!TOKEN || !GUILD_ID) {
    throw new Error('Missing DISCORD_TOKEN or GUILD_ID in .env');
}
const client = new discord_js_1.Client({
    intents: [
        discord_js_1.GatewayIntentBits.Guilds,
        discord_js_1.GatewayIntentBits.GuildMembers, // to enumerate members and their roles
        discord_js_1.GatewayIntentBits.GuildMessages, // to fetch message history
    ],
    partials: [discord_js_1.Partials.Channel, discord_js_1.Partials.Message],
});
const sleep = (ms) => new Promise(res => setTimeout(res, ms));
async function getSocialMemberIds(guildId) {
    const guild = await client.guilds.fetch(guildId);
    await guild.members.fetch(); // populate cache
    let roleId = ROLE_ID;
    if (!roleId) {
        const role = guild.roles.cache.find(r => r.name === ROLE_NAME);
        if (!role) {
            throw new Error(`Role not found: "${ROLE_NAME}". Set ROLE_ID in .env for reliability.`);
        }
        roleId = role.id;
    }
    const ids = new Set();
    guild.members.cache.forEach((m) => {
        if (m.roles.cache.has(roleId))
            ids.add(m.id);
    });
    return ids;
}
async function countMessagesInChannel(ch, targetIds, since, maxToScan) {
    const counts = new Map();
    let fetched = 0;
    let before = undefined;
    while (fetched < maxToScan) {
        const batch = await ch.messages.fetch({ limit: 100, before }).catch(() => null);
        if (!batch || batch.size === 0)
            break;
        let reachedPastWindow = false;
        for (const msg of batch.values()) {
            if (msg.createdAt < since) {
                reachedPastWindow = true;
                continue;
            }
            if (targetIds.has(msg.author.id)) {
                counts.set(msg.author.id, (counts.get(msg.author.id) || 0) + 1);
            }
        }
        fetched += batch.size;
        before = batch.last().id;
        if (reachedPastWindow)
            break;
        await sleep(300); // be gentle with rate limits
    }
    return counts;
}
function pad(str, len) {
    return (str.length >= len) ? str : (str + ' '.repeat(len - str.length));
}
function toTable(rows) {
    const nameCol = Math.max(12, ...rows.map(r => r.tag.length));
    const cntCol = Math.max(5, ...rows.map(r => String(r.count).length));
    const header = `${pad('User', nameCol)}  ${pad('Msgs', cntCol)}\n${'-'.repeat(nameCol)}  ${'-'.repeat(cntCol)}`;
    const body = rows.map(r => `${pad(r.tag, nameCol)}  ${pad(String(r.count), cntCol)}`).join('\n');
    return '```\n' + header + '\n' + body + '\n```';
}
async function handleSocialActivity(interaction) {
    // options
    const days = interaction.options.getInteger('days') ?? DEFAULT_DAYS;
    const top = interaction.options.getInteger('top') ?? 20;
    const ephemeral = interaction.options.getBoolean('ephemeral') ?? false;
    // ensure correct channel type
    const ch = interaction.channel;
    if (!ch || ![discord_js_1.ChannelType.GuildText, discord_js_1.ChannelType.PublicThread, discord_js_1.ChannelType.PrivateThread].includes(ch.type)) {
        await interaction.reply({ content: 'This command must be used in a text channel or thread within a server.', ephemeral: true });
        return;
    }
    await interaction.deferReply({ ephemeral });
    // compute
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    const targetIds = await getSocialMemberIds(GUILD_ID);
    if (targetIds.size === 0) {
        await interaction.editReply('No members found with the Social Member role.');
        return;
    }
    // count in the current channel only
    const channel = ch;
    const counts = await countMessagesInChannel(channel, targetIds, since, MAX_FETCH);
    // resolve usernames (best-effort)
    const guild = await client.guilds.fetch(GUILD_ID);
    const rows = [];
    for (const id of targetIds) {
        const member = guild.members.cache.get(id) ?? (await guild.members.fetch(id).catch(() => null));
        const tag = member ? `${member.user.username}#${member.user.discriminator}` : id;
        rows.push({ id, tag, count: counts.get(id) || 0 });
    }
    rows.sort((a, b) => b.count - a.count);
    // visible summary (top N)
    const summary = rows.slice(0, Math.max(1, Math.min(50, top))).map(r => ({ tag: r.tag, count: r.count }));
    const table = toTable(summary);
    // csv (full)
    const csv = ['user_id,user_tag,message_count,days_lookback,channel_id']
        .concat(rows.map(r => {
        const safeTag = `"${r.tag.replace(/"/g, '""')}"`;
        return `${r.id},${safeTag},${r.count},${days},${channel.id}`;
    }))
        .join('\n');
    const buf = Buffer.from(csv, 'utf8');
    const attachment = new discord_js_1.AttachmentBuilder(buf, { name: `social_activity_${channel.id}_${days}d.csv` });
    const channelName = (channel.type === discord_js_1.ChannelType.GuildText) ? `#${channel.name}` : 'this thread';
    const header = `**Social Member activity in ${channelName} (last ${days}d)**\nShowing top ${summary.length} • Scanned up to ${MAX_FETCH} messages`;
    await interaction.editReply({ content: `${header}\n${table}`, files: [attachment] });
}
client.on('interactionCreate', async (interaction) => {
    if (!interaction.isChatInputCommand())
        return;
    if (interaction.commandName === 'social_activity') {
        try {
            await handleSocialActivity(interaction);
        }
        catch (e) {
            const msg = e?.message ?? String(e);
            console.error('social_activity error:', msg);
            if (interaction.deferred || interaction.replied) {
                await interaction.editReply('Something went wrong while counting. Make sure I can read this channel’s history.');
            }
            else {
                await interaction.reply({ content: 'Something went wrong while counting. Make sure I can read this channel’s history.', ephemeral: true });
            }
        }
    }
});
client.once('ready', () => {
    console.log(`✅ Logged in as ${client.user?.tag}`);
});
client.login(TOKEN);
