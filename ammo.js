"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const discord_js_1 = require("discord.js");
require("dotenv/config");
const node_fetch_1 = __importDefault(require("node-fetch"));
const client = new discord_js_1.Client({ intents: [discord_js_1.GatewayIntentBits.Guilds] });
process.on("unhandledRejection", (err) => console.error("UNHANDLED REJECTION", err));
process.on("uncaughtException", (err) => console.error("UNCAUGHT EXCEPTION", err));
// --- timeout wrapper for fetch (works with node-fetch v3)
async function fetchJson(url, opts = {}, { timeoutMs = 7000, retries = 1 } = {}) {
    const ctrl = new AbortController();
    const to = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
        const r = await (0, node_fetch_1.default)(url, {
            ...opts,
            signal: ctrl.signal,
            headers: { "User-Agent": "discord-bot/1.0", ...(opts.headers || {}) },
        });
        if (!r.ok)
            throw new Error(`HTTP ${r.status} on ${url}`);
        return (await r.json());
    }
    catch (e) {
        if (retries > 0) {
            await new Promise((res) => setTimeout(res, 400)); // simple backoff
            return fetchJson(url, opts, { timeoutMs, retries: retries - 1 });
        }
        throw e;
    }
    finally {
        clearTimeout(to);
    }
}
async function safeEdit(i, payload) {
    try {
        return await i.editReply(payload);
    }
    catch {
        // Create a new object with compatible properties for followUp
        if (typeof payload === 'string' || payload instanceof discord_js_1.MessagePayload) {
            return i.followUp({ content: typeof payload === 'string' ? payload : undefined, ephemeral: true });
        }
        else {
            // Create a new object without spreading to avoid type issues
            const followUpPayload = {};
            // Copy over compatible properties
            if (payload.content)
                followUpPayload.content = payload.content;
            if (payload.embeds)
                followUpPayload.embeds = payload.embeds;
            if (payload.components)
                followUpPayload.components = payload.components;
            followUpPayload.ephemeral = true;
            return i.followUp(followUpPayload);
        }
    }
}
// --- Command definitions ---
const ammoCmd = new discord_js_1.SlashCommandBuilder()
    .setName("ammo")
    .setDescription("Lookup a cartridge or firearm by name")
    .addStringOption((o) => o
    .setName("name")
    .setDescription("e.g., 9mm, 5.56x45mm, Glock 19")
    .setRequired(true));
const gunCmd = new discord_js_1.SlashCommandBuilder()
    .setName("gun")
    .setDescription("Lookup a firearm model by name")
    .addStringOption((o) => o
    .setName("name")
    .setDescription("e.g., Glock 19, AK-47, M16A2")
    .setRequired(true));
const caliberCmd = new discord_js_1.SlashCommandBuilder()
    .setName("caliber")
    .setDescription("Lookup a cartridge/caliber by name")
    .addStringOption((o) => o
    .setName("name")
    .setDescription("e.g., 9×19mm Parabellum, 5.56×45mm NATO, .308 Winchester")
    .setRequired(true));
// --- Boot ---
// client.once("ready", async () => {
//   await client.application?.commands.create(ammoCmd);
//   await client.application?.commands.create(gunCmd);
//   await client.application?.commands.create(caliberCmd);
//   console.log(`Logged in as ${client.user?.tag}`);
// });
// --- Helpers: Wikipedia + Wikidata ---
async function wikiSummary(title) {
    const url = `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title)}`;
    const r = await (0, node_fetch_1.default)(url);
    if (!r.ok)
        return null;
    const j = (await r.json());
    return {
        title: j.title || title,
        extract: j.extract || "",
        thumbnail: j.thumbnail || undefined,
        titles: j.titles || undefined,
        content_urls: j.content_urls || undefined,
    };
}
async function getQidFromEnwiki(title) {
    const url = `https://en.wikipedia.org/w/api.php?action=query&prop=pageprops&format=json&titles=${encodeURIComponent(title)}`;
    const r = await (0, node_fetch_1.default)(url);
    if (!r.ok)
        return null;
    const j = await r.json();
    if (!j.query?.pages)
        return null;
    const page = Object.values(j.query.pages)[0];
    return page?.pageprops?.wikibase_item || null;
}
async function wdOneRow(sparql) {
    const url = `https://query.wikidata.org/sparql?format=json&query=${encodeURIComponent(sparql)}`;
    const r = await (0, node_fetch_1.default)(url, {
        headers: {
            Accept: "application/sparql-results+json",
            "User-Agent": "discord-bot-example/1.0",
        },
    });
    if (!r.ok)
        return null;
    const data = await r.json();
    const rows = data?.results?.bindings || [];
    return rows[0] || null;
}
function bval(row, key) {
    return row?.[key]?.value;
} // safe getter
// --- Wikidata lookups ---
async function wdAmmoFacts(qid) {
    if (!qid)
        return {};
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
async function wdGunFacts(qid) {
    if (!qid)
        return {};
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
function titleCandidates(input) {
    // Try as-typed, × substitution, and underscore variant
    return [
        input,
        input.replace(/x/g, "×").replace(/X/g, "×"), // 5.56×45mm
        input.replace(/\s+/g, "_"),
    ];
}
// --- Render helpers ---
function addIf(embed, cond, field) {
    if (cond)
        embed.addFields(field);
}
function wikiFooter(urls) {
    const base = "Text & images: Wikipedia/Wikidata";
    try {
        const page = urls?.desktop?.page;
        return page ? `${base} • ${page}` : base;
    }
    catch {
        return base;
    }
}
// --- Command handlers ---
async function handleAmmo(i, name) {
    await i.deferReply(); // FIRST awaited line
    try {
        console.log(`[ammo] start ${name}`);
        // 1) Wikipedia summary (try a few title variants)
        let summary = null;
        for (const t of titleCandidates(name)) {
            try {
                summary = await fetchJson(`https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(t)}`, {}, { timeoutMs: 6000 });
                if (summary?.extract)
                    break;
            }
            catch {
                /* try next candidate */
            }
        }
        if (!summary?.extract) {
            return safeEdit(i, {
                content: `Couldn't find "${name}". Try a canonical title like "9×19mm Parabellum" or "5.56×45mm NATO".`,
            });
        }
        // 2) Resolve QID
        let qid = null;
        try {
            const qidResp = await fetchJson(`https://en.wikipedia.org/w/api.php?action=query&prop=pageprops&format=json&titles=${encodeURIComponent(summary.titles?.canonical || summary.title)}`, {}, { timeoutMs: 6000 });
            const page = Object.values(qidResp?.query?.pages || {})[0];
            qid = page?.pageprops?.wikibase_item || null;
        }
        catch {
            /* no qid is fine */
        }
        // 3) Wikidata enrichment (muzzle velocity, country, inception, image)
        let wd = {};
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
                const wdData = await fetchJson(`https://query.wikidata.org/sparql?format=json&query=${encodeURIComponent(sparql)}`, { headers: { Accept: "application/sparql-results+json" } }, { timeoutMs: 7000 });
                const row = wdData?.results?.bindings?.[0] || {};
                wd = {
                    img: row?.img?.value,
                    mv: row?.mv?.value,
                    country: row?.countryLabel?.value,
                    inception: row?.inception?.value,
                };
            }
            catch (e) {
                console.warn("[ammo] wd fetch failed", e?.message || e);
            }
        }
        const image = wd.img || summary?.thumbnail?.source;
        const fields = [];
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
    }
    catch (err) {
        console.error("[ammo] error", err);
        return safeEdit(i, {
            content: "Sorry, that lookup timed out or failed. Try again or use a more specific cartridge name.",
        });
    }
}
async function handleGun(i, name) {
    await i.deferReply();
    try {
        console.log(`[gun] start ${name}`);
        // Example calls with timeouts
        const summary = await fetchJson(`https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(name)}`, {}, { timeoutMs: 6000 });
        if (!summary?.extract)
            return safeEdit(i, {
                content: `Couldn't find "${name}". Try a more exact model.`,
            });
        const qidResp = await fetchJson(`https://en.wikipedia.org/w/api.php?action=query&prop=pageprops&format=json&titles=${encodeURIComponent(summary.titles?.canonical || summary.title)}`, {}, { timeoutMs: 6000 });
        const page = Object.values(qidResp?.query?.pages || {})[0];
        const qid = page?.pageprops?.wikibase_item;
        let wd = {};
        if (qid) {
            const sparql = `
          SELECT ?img ?makerLabel ?countryLabel WHERE {
            OPTIONAL { wd:${qid} wdt:P18 ?img. }
            OPTIONAL { wd:${qid} wdt:P176 ?maker. }
            OPTIONAL { wd:${qid} wdt:P495 ?country. }
            SERVICE wikibase:label { bd:serviceParam wikibase:language "en". }
          } LIMIT 1`;
            const wdUrl = `https://query.wikidata.org/sparql?format=json&query=${encodeURIComponent(sparql)}`;
            const wdData = await fetchJson(wdUrl, { headers: { Accept: "application/sparql-results+json" } }, { timeoutMs: 7000 });
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
    }
    catch (err) {
        console.error("[gun] error", err);
        return safeEdit(i, {
            content: "Sorry, that lookup timed out or failed. Try again or try a more specific name.",
        });
    }
}
// --- Router ---
client.on("interactionCreate", async (i) => {
    if (!i.isChatInputCommand())
        return;
    const name = i.options.getString("name", true);
    if (i.commandName === "ping") {
        await i.reply({ content: "pong", ephemeral: true });
        return;
    }
    try {
        if (i.commandName === "ammo")
            return handleAmmo(i, name);
        if (i.commandName === "gun")
            return handleGun(i, name);
        if (i.commandName === "caliber")
            return handleAmmo(i, name); // Caliber uses same handler as ammo
    }
    catch (err) {
        console.error("[router] error", err);
        // Fallback if something throws before we replied/deferred
        if (!i.replied && !i.deferred) {
            try {
                await i.reply({
                    content: "Unexpected error. Please try again.",
                    ephemeral: true,
                });
            }
            catch { }
        }
        else {
            try {
                await i.editReply({ content: "Unexpected error. Please try again." });
            }
            catch { }
        }
    }
});
client.login(process.env.DISCORD_TOKEN);
