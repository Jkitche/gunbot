// deps: "discord.js": "^14", "node-fetch": "^3"
import { Client, GatewayIntentBits, SlashCommandBuilder, EmbedBuilder } from 'discord.js';
import fetch from 'node-fetch';

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

// --- Command definitions ---
const ammoCmd = new SlashCommandBuilder()
    .setName('ammo')
    .setDescription('Lookup a cartridge or firearm by name')
    .addStringOption(o => o.setName('name').setDescription('e.g., 9mm, 5.56x45mm, Glock 19').setRequired(true));

const gunCmd = new SlashCommandBuilder()
    .setName('gun')
    .setDescription('Lookup a firearm model by name')
    .addStringOption(o => o.setName('name').setDescription('e.g., Glock 19, AK-47, M16A2').setRequired(true));

const caliberCmd = new SlashCommandBuilder()
    .setName('caliber')
    .setDescription('Lookup a cartridge/caliber by name')
    .addStringOption(o => o.setName('name').setDescription('e.g., 9×19mm Parabellum, 5.56×45mm NATO, .308 Winchester').setRequired(true));

// --- Boot ---
client.once('ready', async () => {
    await client.application.commands.create(ammoCmd);
    await client.application.commands.create(gunCmd);
    await client.application.commands.create(caliberCmd);
    console.log(`Logged in as ${client.user.tag}`);
});

// --- Helpers: Wikipedia + Wikidata ---
async function wikiSummary(title) {
    const url = `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title)}`;
    const r = await fetch(url);
    if (!r.ok) return null;
    const j = await r.json();
    return {
        title: j.title || title,
        extract: j.extract || '',
        image: j.thumbnail?.source || null,
        canonicalTitle: j.titles?.canonical || j.title || title,
        contentUrls: j.content_urls || null,
    };
}

async function getQidFromEnwiki(title) {
    const url = `https://en.wikipedia.org/w/api.php?action=query&prop=pageprops&format=json&titles=${encodeURIComponent(title)}`;
    const r = await fetch(url);
    if (!r.ok) return null;
    const j = await r.json();
    const page = Object.values(j.query.pages)[0];
    return page?.pageprops?.wikibase_item || null;
}

async function wdOneRow(sparql) {
    const url = `https://query.wikidata.org/sparql?format=json&query=${encodeURIComponent(sparql)}`;
    const r = await fetch(url, { headers: { 'Accept': 'application/sparql-results+json', 'User-Agent': 'discord-bot-example/1.0' } });
    if (!r.ok) return null;
    const rows = (await r.json())?.results?.bindings || [];
    return rows[0] || null;
}

function bval(row, key) { return row?.[key]?.value; } // safe getter

// --- Wikidata lookups ---
async function wdAmmoFacts(qid) {
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
        muzzleVelocity: bval(row, 'mv'),
        wikidataImage: bval(row, 'img'),
        country: bval(row, 'countryLabel'),
        inception: bval(row, 'inception')
    };
}

async function wdGunFacts(qid) {
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
        wikidataImage: bval(row, 'img'),
        manufacturer: bval(row, 'makerLabel'),
        country: bval(row, 'countryLabel'),
        length: bval(row, 'length'),
        mass: bval(row, 'mass'),
        cartridges: bval(row, 'cartridges')
    };
}

// --- Fuzzy title candidates for ammo/guns ---
function titleCandidates(input) {
    // Try as-typed, × substitution, and underscore variant
    return [
        input,
        input.replace(/x/g, '×').replace(/X/g, '×'), // 5.56×45mm
        input.replace(/\s+/g, '_')
    ];
}

// --- Render helpers ---
function addIf(embed, cond, field) { if (cond) embed.addFields(field); }

function wikiFooter(urls) {
    const base = 'Text & images: Wikipedia/Wikidata';
    try {
        const page = urls?.desktop?.page;
        return page ? `${base} • ${page}` : base;
    } catch { return base; }
}

// --- Command handlers ---
async function handleAmmo(i, name) {
    const candidates = titleCandidates(name);
    let info = null;
    for (const t of candidates) { info = await wikiSummary(t); if (info?.extract) break; }
    if (!info) return i.editReply(`Couldn't find "${name}". Try a more specific title, e.g., "9×19mm Parabellum".`);

    const qid = await getQidFromEnwiki(info.canonicalTitle || info.title);
    const wd = await wdAmmoFacts(qid);

    const image = wd.wikidataImage || info.image;
    const embed = new EmbedBuilder()
        .setTitle(info.title)
        .setDescription(info.extract?.slice(0, 3500) || 'No description.')
        .setFooter({ text: wikiFooter(info.contentUrls) });
    if (image) embed.setImage(image);

    addIf(embed, wd.country, { name: 'Country of origin', value: wd.country, inline: true });
    addIf(embed, wd.inception, { name: 'Inception', value: new Date(wd.inception).toISOString().slice(0, 10), inline: true });
    addIf(embed, wd.muzzleVelocity, { name: 'Muzzle velocity (Wikidata)', value: `${wd.muzzleVelocity}`, inline: true });

    return i.editReply({ embeds: [embed] });
}

async function handleGun(i, name) {
    const candidates = titleCandidates(name);
    let info = null;
    for (const t of candidates) { info = await wikiSummary(t); if (info?.extract) break; }
    if (!info) return i.editReply(`Couldn't find "${name}". Try the exact model designation (e.g., "Glock 19", "AK-47").`);

    const qid = await getQidFromEnwiki(info.canonicalTitle || info.title);
    const wd = await wdGunFacts(qid);

    const image = wd.wikidataImage || info.image;
    const embed = new EmbedBuilder()
        .setTitle(info.title)
        .setDescription(info.extract?.slice(0, 3500) || 'No description.')
        .setFooter({ text: wikiFooter(info.contentUrls) });
    if (image) embed.setImage(image);

    addIf(embed, wd.manufacturer, { name: 'Manufacturer', value: wd.manufacturer, inline: true });
    addIf(embed, wd.country, { name: 'Country of origin', value: wd.country, inline: true });
    addIf(embed, wd.length, { name: 'Length', value: `${wd.length}`, inline: true });
    addIf(embed, wd.mass, { name: 'Mass', value: `${wd.mass}`, inline: true });
    addIf(embed, wd.cartridges, { name: 'Cartridge(s)', value: wd.cartridges, inline: false });

    return i.editReply({ embeds: [embed] });
}

async function handleCaliber(i, name) {
    // Alias to ammo with a different help text; many “caliber” inputs map to cartridges.
    return handleAmmo(i, name);
}

// --- Router ---
client.on('interactionCreate', async (i) => {
    if (!i.isChatInputCommand()) return;
    const name = i.options.getString('name', true);
    await i.deferReply();

    try {
        if (i.commandName === 'ammo') return handleAmmo(i, name);
        if (i.commandName === 'gun') return handleGun(i, name);
        if (i.commandName === 'caliber') return handleCaliber(i, name);
    } catch (err) {
        console.error(err);
        return i.editReply('Sorry, something went wrong fetching data.');
    }
});

client.login(process.env.DISCORD_TOKEN);