import {
  ChatInputCommandInteraction,
  Client,
  EmbedBuilder,
  EmbedField,
  GatewayIntentBits,
  InteractionEditReplyOptions,
  InteractionReplyOptions,
  MessagePayload,
  SlashCommandBuilder,
  ChannelType,
  GuildMember,
  Partials,
  Snowflake,
  TextChannel,
  ThreadChannel
} from "discord.js";
import "dotenv/config";
import fetch, { RequestInit } from "node-fetch";

// const client = new Client({ intents: [GatewayIntentBits.Guilds] });

process.on("unhandledRejection", (err) =>
  console.error("UNHANDLED REJECTION", err)
);
process.on("uncaughtException", (err) =>
  console.error("UNCAUGHT EXCEPTION", err)
);

// Type definitions
interface FetchOptions extends RequestInit {
  headers?: Record<string, string>;
  signal?: AbortSignal;
}

interface FetchJsonOptions {
  timeoutMs?: number;
  retries?: number;
}

interface WikiSummary {
  title: string;
  extract: string;
  thumbnail?: {
    source: string;
  };
  titles?: {
    canonical: string;
  };
  content_urls?: {
    desktop?: {
      page: string;
    };
  };
}

interface WikidataAmmoFacts {
  muzzleVelocity?: string;
  wikidataImage?: string;
  country?: string;
  inception?: string;
}

interface WikidataGunFacts {
  wikidataImage?: string;
  manufacturer?: string;
  country?: string;
  length?: string;
  mass?: string;
  cartridges?: string;
}

interface WikidataRow {
  [key: string]: {
    value: string;
  };
}

// --- timeout wrapper for fetch (works with node-fetch v3)
async function fetchJson<T>(
  url: string,
  opts: FetchOptions = {},
  { timeoutMs = 7000, retries = 1 }: FetchJsonOptions = {}
): Promise<T> {
  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, {
      ...opts,
      signal: ctrl.signal,
      headers: { "User-Agent": "discord-bot/1.0", ...(opts.headers || {}) },
    });
    if (!r.ok) throw new Error(`HTTP ${r.status} on ${url}`);
    return (await r.json()) as T;
  } catch (e) {
    if (retries > 0) {
      await new Promise((res) => setTimeout(res, 400)); // simple backoff
      return fetchJson<T>(url, opts, { timeoutMs, retries: retries - 1 });
    }
    throw e;
  } finally {
    clearTimeout(to);
  }
}

async function safeEdit(
  i: ChatInputCommandInteraction,
  payload: string | MessagePayload | InteractionEditReplyOptions
): Promise<any> {
  try {
    return await i.editReply(payload);
  } catch {
    // Create a new object with compatible properties for followUp
    if (typeof payload === 'string' || payload instanceof MessagePayload) {
      return i.followUp({ content: typeof payload === 'string' ? payload : undefined, ephemeral: true });
    } else {
      // Create a new object without spreading to avoid type issues
      const followUpPayload: InteractionReplyOptions = {};
      // Copy over compatible properties
      if (payload.content) followUpPayload.content = payload.content;
      if (payload.embeds) followUpPayload.embeds = payload.embeds;
      if (payload.components) followUpPayload.components = payload.components;
      followUpPayload.ephemeral = true;
      return i.followUp(followUpPayload);
    }
  }
}

// --- Command definitions ---
const ammoCmd = new SlashCommandBuilder()
  .setName("ammo")
  .setDescription("Lookup a cartridge or firearm by name")
  .addStringOption((o) =>
    o
      .setName("name")
      .setDescription("e.g., 9mm, 5.56x45mm, Glock 19")
      .setRequired(true)
  );

const gunCmd = new SlashCommandBuilder()
  .setName("gun")
  .setDescription("Lookup a firearm model by name")
  .addStringOption((o) =>
    o
      .setName("name")
      .setDescription("e.g., Glock 19, AK-47, M16A2")
      .setRequired(true)
  );

const caliberCmd = new SlashCommandBuilder()
  .setName("caliber")
  .setDescription("Lookup a cartridge/caliber by name")
  .addStringOption((o) =>
    o
      .setName("name")
      .setDescription(
        "e.g., 9×19mm Parabellum, 5.56×45mm NATO, .308 Winchester"
      )
      .setRequired(true)
  );

// --- Boot ---
// client.once("ready", async () => {
//   await client.application?.commands.create(ammoCmd);
//   await client.application?.commands.create(gunCmd);
//   await client.application?.commands.create(caliberCmd);
//   console.log(`Logged in as ${client.user?.tag}`);
// });

// --- Helpers: Wikipedia + Wikidata ---
async function wikiSummary(title: string): Promise<WikiSummary | null> {
  const url = `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(
    title
  )}`;
  const r = await fetch(url);
  if (!r.ok) return null;
  const j = (await r.json()) as WikiSummary;
  return {
    title: j.title || title,
    extract: j.extract || "",
    thumbnail: j.thumbnail || undefined,
    titles: j.titles || undefined,
    content_urls: j.content_urls || undefined,
  };
}

async function getQidFromEnwiki(title: string): Promise<string | null> {
  const url = `https://en.wikipedia.org/w/api.php?action=query&prop=pageprops&format=json&titles=${encodeURIComponent(
    title
  )}`;
  const r = await fetch(url);
  if (!r.ok) return null;
  const j = await r.json() as { query?: { pages?: Record<string, unknown> } };
  if (!j.query?.pages) return null;
  const page = Object.values(j.query.pages)[0] as { pageprops?: { wikibase_item?: string } };
  return page?.pageprops?.wikibase_item || null;
}

async function wdOneRow(sparql: string): Promise<WikidataRow | null> {
  const url = `https://query.wikidata.org/sparql?format=json&query=${encodeURIComponent(
    sparql
  )}`;
  const r = await fetch(url, {
    headers: {
      Accept: "application/sparql-results+json",
      "User-Agent": "discord-bot-example/1.0",
    },
  });
  if (!r.ok) return null;
  const data = await r.json() as { results?: { bindings?: WikidataRow[] } };
  const rows = data?.results?.bindings || [];
  return rows[0] || null;
}

function bval(row: WikidataRow | null, key: string): string | undefined {
  return row?.[key]?.value;
} // safe getter

// --- Wikidata lookups ---
async function wdAmmoFacts(qid: string | null): Promise<WikidataAmmoFacts> {
  if (!qid) return {};
  const sparql = `
    SELECT ?mv ?img ?countryLabel ?inception WHERE {
      OPTIONAL { wd:${qid} wdt:P4137 ?mv. }      # muzzle velocity (if stored on cartridge)
      OPTIONAL { wd:${qid} wdt:P18 ?img. }       # image (Commons)
      OPTIONAL { wd:${qid} wdt:P495 ?country. }  # country of origin
      OPTIONAL { wd:${qid} wdt:P571 ?inception. }# inception
      SERVICE wikibase:label { bd:serviceParam wikibase:language "en". }
    } LIMIT 1
  `;
  const row = await wdOneRow(sparql);
  return {
    muzzleVelocity: bval(row, "mv"),
    wikidataImage: bval(row, "img"),
    country: bval(row, "countryLabel"),
    inception: bval(row, "inception"),
  };
}

async function wdGunFacts(qid: string | null): Promise<WikidataGunFacts> {
  if (!qid) return {};
  const sparql = `
    SELECT
      ?img
      ?makerLabel
      ?countryLabel
      ?length
      ?mass
      (GROUP_CONCAT(DISTINCT ?cartridgeLabel; separator=", ") AS ?cartridges)
    WHERE {
      OPTIONAL { wd:${qid} wdt:P18 ?img. }           # image
      OPTIONAL { wd:${qid} wdt:P176 ?maker. }        # manufacturer
      OPTIONAL { wd:${qid} wdt:P495 ?country. }      # country of origin
      OPTIONAL { wd:${qid} wdt:P2043 ?length. }      # length
      OPTIONAL { wd:${qid} wdt:P2067 ?mass. }        # mass
      OPTIONAL { wd:${qid} wdt:P2283 ?cart. }        # uses (cartridge)
      BIND(COALESCE(?cart, ?__dummy) AS ?cartridge)  # alias for label service
      SERVICE wikibase:label { bd:serviceParam wikibase:language "en". }
    } GROUP BY ?img ?makerLabel ?countryLabel ?length ?mass
    LIMIT 1
  `;
  const row = await wdOneRow(sparql);
  return {
    wikidataImage: bval(row, "img"),
    manufacturer: bval(row, "makerLabel"),
    country: bval(row, "countryLabel"),
    length: bval(row, "length"),
    mass: bval(row, "mass"),
    cartridges: bval(row, "cartridges"),
  };
}

// --- Fuzzy title candidates for ammo/guns ---
function titleCandidates(input: string): string[] {
  // Try as-typed, × substitution, and underscore variant
  return [
    input,
    input.replace(/x/g, "×").replace(/X/g, "×"), // 5.56×45mm
    input.replace(/\s+/g, "_"),
  ];
}

// --- Render helpers ---
function addIf(embed: EmbedBuilder, cond: any, field: EmbedField): void {
  if (cond) embed.addFields(field);
}

function wikiFooter(urls: WikiSummary["content_urls"]): string {
  const base = "Text & images: Wikipedia/Wikidata";
  try {
    const page = urls?.desktop?.page;
    return page ? `${base} • ${page}` : base;
  } catch {
    return base;
  }
}

// --- Command handlers ---
async function handleAmmo(
  i: ChatInputCommandInteraction,
  name: string
): Promise<any> {
  await i.deferReply(); // FIRST awaited line
  try {
    console.log(`[ammo] start ${name}`);

    // 1) Wikipedia summary (try a few title variants)
    let summary: WikiSummary | null = null;
    for (const t of titleCandidates(name)) {
      try {
        summary = await fetchJson<WikiSummary>(
          `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(
            t
          )}`,
          {},
          { timeoutMs: 6000 }
        );
        if (summary?.extract) break;
      } catch {
        /* try next candidate */
      }
    }
    if (!summary?.extract) {
      return safeEdit(i, {
        content: `Couldn't find "${name}". Try a canonical title like "9×19mm Parabellum" or "5.56×45mm NATO".`,
      });
    }

    // 2) Resolve QID
    let qid: string | null = null;
    try {
      const qidResp = await fetchJson<any>(
        `https://en.wikipedia.org/w/api.php?action=query&prop=pageprops&format=json&titles=${encodeURIComponent(
          summary.titles?.canonical || summary.title
        )}`,
        {},
        { timeoutMs: 6000 }
      );
      const page = Object.values(qidResp?.query?.pages || {})[0] as any;
      qid = page?.pageprops?.wikibase_item || null;
    } catch {
      /* no qid is fine */
    }

    // 3) Wikidata enrichment (muzzle velocity, country, inception, image)
    let wd: {
      img?: string;
      mv?: string;
      country?: string;
      inception?: string;
    } = {};

    if (qid) {
      const sparql = `
        SELECT ?mv ?img ?countryLabel ?inception WHERE {
          OPTIONAL { wd:${qid} wdt:P4137 ?mv. }      # muzzle velocity
          OPTIONAL { wd:${qid} wdt:P18 ?img. }       # image
          OPTIONAL { wd:${qid} wdt:P495 ?country. }  # country of origin
          OPTIONAL { wd:${qid} wdt:P571 ?inception. }# inception date
          SERVICE wikibase:label { bd:serviceParam wikibase:language "en". }
        } LIMIT 1`;
      try {
        const wdData = await fetchJson<any>(
          `https://query.wikidata.org/sparql?format=json&query=${encodeURIComponent(
            sparql
          )}`,
          { headers: { Accept: "application/sparql-results+json" } },
          { timeoutMs: 7000 }
        );
        const row = wdData?.results?.bindings?.[0] || {};
        wd = {
          img: row?.img?.value,
          mv: row?.mv?.value,
          country: row?.countryLabel?.value,
          inception: row?.inception?.value,
        };
      } catch (e: any) {
        console.warn("[ammo] wd fetch failed", e?.message || e);
      }
    }

    const image = wd.img || summary?.thumbnail?.source;
    const fields: EmbedField[] = [];
    if (wd.country)
      fields.push({
        name: "Country of origin",
        value: wd.country,
        inline: true,
      });
    if (wd.inception)
      fields.push({
        name: "Inception",
        value: new Date(wd.inception).toISOString().slice(0, 10),
        inline: true,
      });
    if (wd.mv)
      fields.push({
        name: "Muzzle velocity (Wikidata)",
        value: `${wd.mv}`,
        inline: true,
      });

    return safeEdit(i, {
      embeds: [
        {
          title: summary.title,
          description: (summary.extract || "").slice(0, 3500),
          image: image ? { url: image } : undefined,
          fields,
          footer: { text: "Wikipedia/Wikidata" },
        },
      ],
    });
  } catch (err) {
    console.error("[ammo] error", err);
    return safeEdit(i, {
      content:
        "Sorry, that lookup timed out or failed. Try again or use a more specific cartridge name.",
    });
  }
}

async function handleGun(
  i: ChatInputCommandInteraction,
  name: string
): Promise<any> {
  await i.deferReply();
  try {
    console.log(`[gun] start ${name}`);

    // Example calls with timeouts
    const summary = await fetchJson<WikiSummary>(
      `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(
        name
      )}`,
      {},
      { timeoutMs: 6000 }
    );
    if (!summary?.extract)
      return safeEdit(i, {
        content: `Couldn't find "${name}". Try a more exact model.`,
      });

    const qidResp = await fetchJson<any>(
      `https://en.wikipedia.org/w/api.php?action=query&prop=pageprops&format=json&titles=${encodeURIComponent(
        summary.titles?.canonical || summary.title
      )}`,
      {},
      { timeoutMs: 6000 }
    );
    const page = Object.values(qidResp?.query?.pages || {})[0] as any;
    const qid = page?.pageprops?.wikibase_item;

    let wd: {
      img?: string;
      maker?: string;
      country?: string;
    } = {};

    if (qid) {
      const sparql = `
        SELECT ?img ?makerLabel ?countryLabel WHERE {
          OPTIONAL { wd:${qid} wdt:P18 ?img. }
          OPTIONAL { wd:${qid} wdt:P176 ?maker. }
          OPTIONAL { wd:${qid} wdt:P495 ?country. }
          SERVICE wikibase:label { bd:serviceParam wikibase:language "en". }
        } LIMIT 1`;
      const wdUrl = `https://query.wikidata.org/sparql?format=json&query=${encodeURIComponent(
        sparql
      )}`;
      const wdData = await fetchJson<any>(
        wdUrl,
        { headers: { Accept: "application/sparql-results+json" } },
        { timeoutMs: 7000 }
      );
      const row = wdData?.results?.bindings?.[0] || {};
      wd = {
        img: row?.img?.value,
        maker: row?.makerLabel?.value,
        country: row?.countryLabel?.value,
      };
    }

    const embed = {
      title: summary.title,
      description: summary.extract.slice(0, 3500),
      image: wd.img
        ? { url: wd.img }
        : summary.thumbnail?.source
        ? { url: summary.thumbnail.source }
        : undefined,
      fields: [
        ...(wd.maker
          ? [{ name: "Manufacturer", value: wd.maker, inline: true }]
          : []),
        ...(wd.country
          ? [{ name: "Country", value: wd.country, inline: true }]
          : []),
      ],
      footer: { text: "Wikipedia/Wikidata" },
    };

    return safeEdit(i, { embeds: [embed] });
  } catch (err) {
    console.error("[gun] error", err);
    return safeEdit(i, {
      content:
        "Sorry, that lookup timed out or failed. Try again or try a more specific name.",
    });
  }
}

// // --- Router ---
// client.on("interactionCreate", async (i) => {
//   if (!i.isChatInputCommand()) return;
//   const name = i.options.getString("name", true);

//   if (i.commandName === "ping") {
//     await i.reply({ content: "pong", ephemeral: true });
//     return;
//   }

//   try {
//     if (i.commandName === "ammo") return handleAmmo(i, name);
//     if (i.commandName === "gun") return handleGun(i, name);
//     if (i.commandName === "caliber") return handleAmmo(i, name); // Caliber uses same handler as ammo
//   } catch (err) {
//     console.error("[router] error", err);
//     // Fallback if something throws before we replied/deferred
//     if (!i.replied && !i.deferred) {
//       try {
//         await i.reply({
//           content: "Unexpected error. Please try again.",
//           ephemeral: true,
//         });
//       } catch {}
//     } else {
//       try {
//         await i.editReply({ content: "Unexpected error. Please try again." });
//       } catch {}
//     }
//   }
// });

// client.login(process.env.DISCORD_TOKEN);

const TOKEN = process.env.DISCORD_TOKEN!;
const GUILD_ID = process.env.GUILD_ID!;
const ROLE_ID = process.env.ROLE_ID;
const ROLE_NAME = process.env.ROLE_NAME || 'Social Member';
const DAYS_LOOKBACK = Number(process.env.DAYS_LOOKBACK || 30);
const MAX_PER_CH = Number(process.env.MAX_MESSAGES_PER_CHANNEL || 2000);
const INCLUDE_THREADS = String(process.env.INCLUDE_THREADS || 'true').toLowerCase() === 'true';

if (! TOKEN || ! GUILD_ID) {
  console.error('Missing DISCORD_TOKEN or GUILD_ID in .env');
  process.exit(1);
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,     // needed to list members/roles
    GatewayIntentBits.GuildMessages,    // needed to fetch messages
    GatewayIntentBits.MessageContent,   // not strictly required to count, but harmless if enabled
  ],
  partials: [Partials.Channel, Partials.Message],
});

const sleep = (ms: number) => new Promise(res => setTimeout(res, ms));

async function getRoleMemberIds(): Promise<Set<Snowflake>> {
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

  const ids = new Set<Snowflake>();
  guild.members.cache.forEach((m: GuildMember) => {
    if (m.roles.cache.has(roleId!)) ids.add(m.id);
  });
  return ids;
}

async function countMessagesInTextChannel(
  channel: TextChannel,
  targetIds: Set<Snowflake>,
  since: Date,
  maxToScan: number
): Promise<Map<Snowflake, number>> {
  const counts = new Map<Snowflake, number>();
  let fetched = 0;
  let before: Snowflake | undefined = undefined;

  while (fetched < maxToScan) {
    const batch = await channel.messages.fetch({ limit: 100, before }).catch(() => null);
    if (!batch || batch.size === 0) break;

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
    before = batch.last()!.id; // paginate older
    if (reachedPastWindow) break;

    // gentle pacing to respect rate limits (tune as needed)
    await sleep(350);
  }

  return counts;
}

async function countMessagesInThread(
  thread: ThreadChannel,
  targetIds: Set<Snowflake>,
  since: Date,
  maxToScan: number
): Promise<Map<Snowflake, number>> {
  const counts = new Map<Snowflake, number>();
  let fetched = 0;
  let before: Snowflake | undefined = undefined;

  while (fetched < maxToScan) {
    const batch = await thread.messages.fetch({ limit: 100, before }).catch(() => null);
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

    await sleep(350);
  }

  return counts;
}

function mergeCounts(into: Map<Snowflake, number>, from: Map<Snowflake, number>) {
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
  const grandTotals = new Map<Snowflake, number>();

  // Fetch and iterate text channels
  const fullGuild = await guild.fetch();
  const channels = await fullGuild.channels.fetch();

  for (const ch of channels.values()) {
    if (!ch) continue;

    // Text channels
    if (ch.type === ChannelType.GuildText) {
      const text = ch as TextChannel;
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
      } catch (e) {
        console.warn(`Skipping channel ${text.name}:`, (e as Error).message);
      }
    }
  }

  // Resolve usernames for nicer output (best-effort; falls back to IDs)
  const results: Array<{ id: string; tag: string; count: number }> = [];
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
  } catch (err) {
    console.error(err);
  } finally {
    client.destroy();
    // ensure process exits (discord.js can keep handles alive)
    setTimeout(() => process.exit(0), 250);
  }
});

client.login(TOKEN).catch(err => {
  console.error('Failed to login. Check your DISCORD_TOKEN.', err);
  process.exit(1);
});
