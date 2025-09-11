import 'dotenv/config';
import {
  ChannelType,
  Client,
  GatewayIntentBits,
  Partials,
  TextChannel,
  ThreadChannel,
  ChatInputCommandInteraction,
  AttachmentBuilder,
  Snowflake,
  GuildMember
} from 'discord.js';

const TOKEN = process.env.DISCORD_TOKEN!;
const GUILD_ID = process.env.GUILD_ID!;
const ROLE_ID = process.env.ROLE_ID;
const ROLE_NAME = process.env.ROLE_NAME || 'Social Member';
const DEFAULT_DAYS = Number(process.env.DEFAULT_DAYS || 30);
const MAX_FETCH = Number(process.env.MAX_FETCH || 2000);

if (!TOKEN || !GUILD_ID) {
  throw new Error('Missing DISCORD_TOKEN or GUILD_ID in .env');
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,   // to enumerate members and their roles
    GatewayIntentBits.GuildMessages,  // to fetch message history
  ],
  partials: [Partials.Channel, Partials.Message],
});

const sleep = (ms: number) => new Promise(res => setTimeout(res, ms));

async function getSocialMemberIds(guildId: string): Promise<Set<Snowflake>> {
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

  const ids = new Set<Snowflake>();
  guild.members.cache.forEach((m: GuildMember) => {
    if (m.roles.cache.has(roleId!)) ids.add(m.id);
  });
  return ids;
}

async function countMessagesInChannel(
  ch: TextChannel | ThreadChannel,
  targetIds: Set<Snowflake>,
  since: Date,
  maxToScan: number
): Promise<Map<Snowflake, number>> {
  const counts = new Map<Snowflake, number>();
  let fetched = 0;
  let before: Snowflake | undefined = undefined;

  while (fetched < maxToScan) {
    const batch = await ch.messages.fetch({ limit: 100, before }).catch(() => null);
    if (!batch || batch.size === 0) break;

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
    before = batch.last()!.id;
    if (reachedPastWindow) break;
    await sleep(300); // be gentle with rate limits
  }

  return counts;
}

function pad(str: string, len: number): string {
  return (str.length >= len) ? str : (str + ' '.repeat(len - str.length));
}

function toTable(
  rows: Array<{ tag: string; count: number }>
): string {
  const nameCol = Math.max(12, ...rows.map(r => r.tag.length));
  const cntCol = Math.max(5, ...rows.map(r => String(r.count).length));
  const header = `${pad('User', nameCol)}  ${pad('Msgs', cntCol)}\n${'-'.repeat(nameCol)}  ${'-'.repeat(cntCol)}`;
  const body = rows.map(r => `${pad(r.tag, nameCol)}  ${pad(String(r.count), cntCol)}`).join('\n');
  return '```\n' + header + '\n' + body + '\n```';
}

async function handleSocialActivity(interaction: ChatInputCommandInteraction) {
  // options
  const days = interaction.options.getInteger('days') ?? DEFAULT_DAYS;
  const top = interaction.options.getInteger('top') ?? 20;
  const ephemeral = interaction.options.getBoolean('ephemeral') ?? false;

  // ensure correct channel type
  const ch = interaction.channel;
  if (!ch || ![ChannelType.GuildText, ChannelType.PublicThread, ChannelType.PrivateThread].includes(ch.type)) {
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
  const channel = ch as TextChannel | ThreadChannel;
  const counts = await countMessagesInChannel(channel, targetIds, since, MAX_FETCH);

  // resolve usernames (best-effort)
  const guild = await client.guilds.fetch(GUILD_ID);
  const rows: Array<{ id: string; tag: string; count: number }> = [];
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
  const attachment = new AttachmentBuilder(buf, { name: `social_activity_${channel.id}_${days}d.csv` });

  const channelName = (channel.type === ChannelType.GuildText) ? `#${(channel as TextChannel).name}` : 'this thread';
  const header = `**Social Member activity in ${channelName} (last ${days}d)**\nShowing top ${summary.length} • Scanned up to ${MAX_FETCH} messages`;

  await interaction.editReply({ content: `${header}\n${table}`, files: [attachment] });
}

client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  if (interaction.commandName === 'social_activity') {
    try {
      await handleSocialActivity(interaction);
    } catch (e: any) {
      const msg = e?.message ?? String(e);
      console.error('social_activity error:', msg);
      if (interaction.deferred || interaction.replied) {
        await interaction.editReply('Something went wrong while counting. Make sure I can read this channel’s history.');
      } else {
        await interaction.reply({ content: 'Something went wrong while counting. Make sure I can read this channel’s history.', ephemeral: true });
      }
    }
  }
});

client.once('ready', () => {
  console.log(`✅ Logged in as ${client.user?.tag}`);
});

client.login(TOKEN);
