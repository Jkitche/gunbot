"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
require("dotenv/config");
const discord_js_1 = require("discord.js");
const TOKEN = process.env.DISCORD_TOKEN;
const GUILD_ID = process.env.GUILD_ID;
const ROLE_ID = process.env.ROLE_ID;
const ROLE_NAME = process.env.ROLE_NAME || 'Social Member';
const DAYS_LOOKBACK = Number(process.env.DAYS_LOOKBACK || 30);
const MAX_PER_CH = Number(process.env.MAX_MESSAGES_PER_CHANNEL || 2000);
const INCLUDE_THREADS = String(process.env.INCLUDE_THREADS || 'true').toLowerCase() === 'true';
if (!TOKEN || !GUILD_ID) {
    console.error('Missing DISCORD_TOKEN or GUILD_ID in .env');
    process.exit(1);
}
const client = new discord_js_1.Client({
    intents: [
        discord_js_1.GatewayIntentBits.Guilds,
        discord_js_1.GatewayIntentBits.GuildMembers, // needed to list members/roles
        discord_js_1.GatewayIntentBits.GuildMessages, // needed to fetch messages
        discord_js_1.GatewayIntentBits.MessageContent, // not strictly required to count, but harmless if enabled
    ],
    partials: [discord_js_1.Partials.Channel, discord_js_1.Partials.Message],
});
const sleep = (ms) => new Promise(res => setTimeout(res, ms));
async function getRoleMemberIds() {
    const guild = await client.guilds.fetch(GUILD_ID);
    await guild.members.fetch(); // populate cache (requires GUILD_MEMBERS intent)
    let roleId = ROLE_ID;
    if (!roleId) {
        const role = guild.roles.cache.find(r => r.name === ROLE_NAME);
        if (!role) {
            throw new Error(`Role not found: "${ROLE_NAME}". You can set ROLE_ID in .env for reliability.`);
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
async function countMessagesInTextChannel(channel, targetIds, since, maxToScan) {
    const counts = new Map();
    let fetched = 0;
    let before = undefined;
    while (fetched < maxToScan) {
        const batch = await channel.messages.fetch({ limit: 100, before }).catch(() => null);
        if (!batch || batch.size === 0)
            break;
        // Stop if we’ve gone past the window (messages are returned newest → oldest)
        let reachedPastWindow = false;
        for (const msg of batch.values()) {
            if (msg.createdAt < since) {
                reachedPastWindow = true;
                continue; // skip counting, but finish this batch
            }
            if (targetIds.has(msg.author.id)) {
                counts.set(msg.author.id, (counts.get(msg.author.id) || 0) + 1);
            }
        }
        fetched += batch.size;
        before = batch.last().id; // paginate older
        if (reachedPastWindow)
            break;
        // gentle pacing to respect rate limits (tune as needed)
        await sleep(350);
    }
    return counts;
}
async function countMessagesInThread(thread, targetIds, since, maxToScan) {
    const counts = new Map();
    let fetched = 0;
    let before = undefined;
    while (fetched < maxToScan) {
        const batch = await thread.messages.fetch({ limit: 100, before }).catch(() => null);
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
        await sleep(350);
    }
    return counts;
}
function mergeCounts(into, from) {
    for (const [k, v] of from) {
        into.set(k, (into.get(k) || 0) + v);
    }
}
async function run() {
    const guild = await client.guilds.fetch(GUILD_ID);
    const targetMemberIds = await getRoleMemberIds();
    if (targetMemberIds.size === 0) {
        console.warn('No members found with the specified role.');
        return;
    }
    const since = new Date(Date.now() - DAYS_LOOKBACK * 24 * 60 * 60 * 1000);
    const grandTotals = new Map();
    // Fetch and iterate text channels
    const fullGuild = await guild.fetch();
    const channels = await fullGuild.channels.fetch();
    for (const ch of channels.values()) {
        if (!ch)
            continue;
        // Text channels
        if (ch.type === discord_js_1.ChannelType.GuildText) {
            const text = ch;
            try {
                const counts = await countMessagesInTextChannel(text, targetMemberIds, since, MAX_PER_CH);
                mergeCounts(grandTotals, counts);
                // Optionally include active/archived public threads
                if (INCLUDE_THREADS) {
                    // active threads
                    const active = await text.threads.fetchActive().catch(() => null);
                    if (active?.threads) {
                        for (const th of active.threads.values()) {
                            const tCounts = await countMessagesInThread(th, targetMemberIds, since, Math.floor(MAX_PER_CH / 2));
                            mergeCounts(grandTotals, tCounts);
                        }
                    }
                    // archived public threads (chunked)
                    let done = false;
                    while (!done) {
                        const archived = await text.threads.fetchArchived({ type: 'public' }).catch(() => null);
                        // discord.js returns a collection; pagination for archived threads is limited;
                        // this will fetch a page; to keep it simple we just process this page.
                        if (!archived?.threads || archived.threads.size === 0) {
                            done = true;
                            break;
                        }
                        for (const th of archived.threads.values()) {
                            const tCounts = await countMessagesInThread(th, targetMemberIds, since, Math.floor(MAX_PER_CH / 2));
                            mergeCounts(grandTotals, tCounts);
                        }
                        // No easy cursor in high-level helper—break to avoid heavy crawling.
                        done = true;
                    }
                }
            }
            catch (e) {
                console.warn(`Skipping channel ${text.name}:`, e.message);
            }
        }
    }
    // Resolve usernames for nicer output (best-effort; falls back to IDs)
    const results = [];
    for (const id of targetMemberIds) {
        const member = guild.members.cache.get(id) ?? (await guild.members.fetch(id).catch(() => null));
        const tag = member ? `${member.user.username}#${member.user.discriminator}` : id;
        const count = grandTotals.get(id) || 0;
        results.push({ id, tag, count });
    }
    results.sort((a, b) => b.count - a.count);
    // CSV to stdout
    console.log('user_id,user_tag,message_count,days_lookback');
    for (const r of results) {
        // escape commas just in case
        const safeTag = `"${r.tag.replace(/"/g, '""')}"`;
        console.log(`${r.id},${safeTag},${r.count},${DAYS_LOOKBACK}`);
    }
}
client.once('ready', async () => {
    try {
        await run();
    }
    catch (err) {
        console.error(err);
    }
    finally {
        client.destroy();
        // ensure process exits (discord.js can keep handles alive)
        setTimeout(() => process.exit(0), 250);
    }
});
client.login(TOKEN).catch(err => {
    console.error('Failed to login. Check your DISCORD_TOKEN.', err);
    process.exit(1);
});
