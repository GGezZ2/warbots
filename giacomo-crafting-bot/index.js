import {
  ActionRowBuilder,
  Client,
  EmbedBuilder,
  GatewayIntentBits,
  ModalBuilder,
  REST,
  Routes,
  SlashCommandBuilder,
  TextInputBuilder,
  TextInputStyle
} from "discord.js";
import dotenv from "dotenv";
import fs from "fs";
import path from "path";
import sqlite3 from "sqlite3";
import { open } from "sqlite";
import { DateTime } from "luxon";
import { fileURLToPath } from "url";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const TOKEN = process.env.GIACOMO_TOKEN?.trim() || process.env.TOKEN?.trim();
const CLIENT_ID = process.env.GIACOMO_CLIENT_ID?.trim() || process.env.CLIENT_ID?.trim();
const GUILD_ID = process.env.GUILD_ID?.trim();

const DB_PATH = process.env.WESTMARCH_DB_PATH || process.env.DB_PATH || "/data/westmarch.db";

const MINIERE_FILE =
  process.env.MINIERE_FILE_PATH?.trim() ||
  process.env.MINIERE_FILE?.trim() ||
  (fs.existsSync(path.join(__dirname, "data", "miniere.json"))
    ? path.join(__dirname, "data", "miniere.json")
    : path.join(__dirname, "miniere.json"));

const CRAFT_CHANNEL_ID = process.env.CRAFT_CHANNEL_ID?.trim() || "";

const BETA_ROLE_NAME = process.env.BETA_ROLE_NAME?.trim() || "Beta";
const CRAFT_CONTROL_ROLE_NAME = process.env.CRAFT_CONTROL_ROLE_NAME?.trim() || "Craft Control";

const BETA_ROLE_ID = process.env.BETA_ROLE_ID?.trim() || "";
const CRAFT_CONTROL_ROLE_ID = process.env.CRAFT_CONTROL_ROLE_ID?.trim() || "";

const TIMEZONE = process.env.TIMEZONE?.trim() || "Europe/Rome";
const CHECK_INTERVAL_MS = Number(process.env.CRAFT_CHECK_INTERVAL_MS || 60000);
const MAX_ROLL_DAYS = Number(process.env.MAX_CRAFT_ROLL_DAYS || 365);

if (!TOKEN || !CLIENT_ID || !GUILD_ID) {
  console.error("Mancano variabili Railway. Servono GIACOMO_TOKEN/TOKEN, GIACOMO_CLIENT_ID/CLIENT_ID e GUILD_ID.");
  process.exit(1);
}

let db;
let miniereCache = null;

const pendingRecipeCreates = new Map();
const pendingRecipeEdits = new Map();

const client = new Client({ intents: [GatewayIntentBits.Guilds] });
const rest = new REST({ version: "10" }).setToken(TOKEN);

const TIPI_OGGETTO = ["Equipaggiamento", "Consumabile", "Munizione"];
const RARITA = ["Comune", "Non comune", "Raro"];
const CATALIZZATORI = ["Offensivo", "Difensivo", "Supporto", "Controllo", "Magia", "Utilità"];
const CATALIZZATORI_CON_NO = [...CATALIZZATORI, "No"];
const SI_NO = ["Sì", "No"];

const CATALYST_COSTS = {
  comune: {
    equipaggiamento: 50,
    munizione: 7,
    consumabile: 15
  },
  "non comune": {
    equipaggiamento: 100,
    munizione: 15,
    consumabile: 30
  },
  raro: {
    equipaggiamento: 250,
    munizione: 50,
    consumabile: 70
  }
};

const CRAFT_RULES = {
  comune: {
    cd: 4,
    successes: 1,
    materialRarity: null
  },
  "non comune": {
    cd: 9,
    successes: 2,
    materialRarity: "comuni"
  },
  raro: {
    cd: 13,
    successes: 4,
    materialRarity: "non_comuni"
  }
};

const GIACOMO_LINES = [
  "Ho fatto il lavoro. So che sembra magia, ma si chiama leggere le istruzioni.",
  "Archiviato. Un altro trionfo della burocrazia contro l'analfabetismo operativo.",
  "Procedura completata. Prego, cercate di non romperla subito.",
  "Fatto. Sorprendente cosa si ottiene quando qualcuno competente deve sistemare le vostre idee.",
  "Ecco. La prossima volta magari portate anche un modulo compilato decentemente. Sognare è gratis."
];

const ERROR_LINES = [
  "No. Non per cattiveria: per igiene amministrativa.",
  "Richiesta respinta. Anche il caos ha degli standard.",
  "Impossibile. E non fare quella faccia, i numeri sono numeri.",
  "Non funziona così. Lo so, leggere le regole è faticoso.",
  "Operazione fallita. La realtà si è opposta, e stavolta ha ragione."
];

function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function norm(s) {
  return String(s || "").trim().toLowerCase();
}

function cleanEmojiTags(s) {
  return String(s || "").replace(/\s+/g, "").trim();
}

function yesNoBool(v) {
  return ["si", "sì", "yes", "true"].includes(norm(v));
}

function same(a, b) {
  return norm(a) === norm(b);
}

function hasRole(member, roleName, roleId = "") {
  try {
    if (roleId && member?.roles?.cache?.has(roleId)) return true;
    return member?.roles?.cache?.some(r => norm(r.name) === norm(roleName));
  } catch {
    return false;
  }
}

function isCraftControl(member) {
  return hasRole(member, CRAFT_CONTROL_ROLE_NAME, CRAFT_CONTROL_ROLE_ID);
}

function isBeta(member) {
  return hasRole(member, BETA_ROLE_NAME, BETA_ROLE_ID) || isCraftControl(member);
}

function inCraftChannel(interaction) {
  return !CRAFT_CHANNEL_ID || interaction.channelId === CRAFT_CHANNEL_ID;
}

function replyError(interaction, message, ephemeral = true) {
  const content = `🗂️ **Giacomo:** ${pick(ERROR_LINES)}\n${message}`;
  return interaction.reply({ content, ephemeral });
}

function loadJSON(filepath, defaultVal = {}) {
  try {
    if (fs.existsSync(filepath)) {
      return JSON.parse(fs.readFileSync(filepath, "utf-8"));
    }
  } catch (err) {
    console.error(`Errore lettura ${filepath}:`, err.message);
  }
  return defaultVal;
}

function loadMiniere() {
  if (!miniereCache) {
    miniereCache = loadJSON(MINIERE_FILE, {});
  }
  return miniereCache;
}

function materialName(mat) {
  return typeof mat === "object" ? String(mat.nome || "") : String(mat || "");
}

function materialTags(mat) {
  return typeof mat === "object" ? String(mat.tags || "") : "";
}

function materialMestieri(mat) {
  return typeof mat === "object" && Array.isArray(mat.mestieri) ? mat.mestieri : [];
}

function flattenMaterials() {
  const data = loadMiniere();
  const out = [];

  for (const [miniera, blocco] of Object.entries(data)) {
    for (const rarityKey of ["comuni", "non_comuni"]) {
      const list = Array.isArray(blocco?.[rarityKey]) ? blocco[rarityKey] : [];

      for (const mat of list) {
        const name = materialName(mat);
        if (!name) continue;

        out.push({
          nome: name.toLowerCase(),
          display: name,
          miniera,
          rarityKey,
          tags: materialTags(mat),
          mestieri: materialMestieri(mat).map(x => norm(x))
        });
      }
    }
  }

  return out;
}

function findMaterialMetadata(material) {
  const target = norm(material);
  return flattenMaterials().find(m => norm(m.nome) === target) || null;
}

function getAllMestieri() {
  return [...new Set(flattenMaterials().flatMap(m => m.mestieri).filter(Boolean))]
    .sort((a, b) => a.localeCompare(b, "it"));
}

function getAllTags() {
  return [...new Set(flattenMaterials().map(m => cleanEmojiTags(m.tags)).filter(Boolean))]
    .sort();
}

function materialMatches({ meta, requiredRarity, mestiere, requiredTag }) {
  if (!meta) return false;
  if (requiredRarity && meta.rarityKey !== requiredRarity) return false;
  if (mestiere && !meta.mestieri.includes(norm(mestiere))) return false;
  if (requiredTag && cleanEmojiTags(meta.tags) !== cleanEmojiTags(requiredTag)) return false;
  return true;
}

async function initDB() {
  db = await open({
    filename: DB_PATH,
    driver: sqlite3.Database
  });

  await db.exec(`
    CREATE TABLE IF NOT EXISTS players (
      id TEXT PRIMARY KEY,
      name TEXT
    );

    CREATE TABLE IF NOT EXISTS characters (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      playerId TEXT NOT NULL,
      name TEXT NOT NULL,
      xp INTEGER NOT NULL DEFAULT 0,
      gold INTEGER NOT NULL DEFAULT 0,
      bank INTEGER NOT NULL DEFAULT 0,
      level INTEGER NOT NULL DEFAULT 1,
      FOREIGN KEY (playerId) REFERENCES players(id)
    );

    CREATE TABLE IF NOT EXISTS inventory (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      characterId INTEGER NOT NULL,
      item TEXT NOT NULL,
      FOREIGN KEY (characterId) REFERENCES characters(id)
    );

    CREATE TABLE IF NOT EXISTS attunements (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      characterId INTEGER NOT NULL,
      item TEXT NOT NULL,
      FOREIGN KEY (characterId) REFERENCES characters(id)
    );

    CREATE TABLE IF NOT EXISTS materials_inventory (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      characterId INTEGER NOT NULL,
      material TEXT NOT NULL,
      quantity INTEGER NOT NULL DEFAULT 0,
      UNIQUE(characterId, material),
      FOREIGN KEY (characterId) REFERENCES characters(id)
    );

    CREATE TABLE IF NOT EXISTS fortresses (
      characterId INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      level INTEGER NOT NULL DEFAULT 0,
      FOREIGN KEY (characterId) REFERENCES characters(id)
    );

    CREATE TABLE IF NOT EXISTS recipes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      nomeOggetto TEXT NOT NULL UNIQUE,
      tipologiaOggetto TEXT NOT NULL,
      specificaTipologia TEXT NOT NULL DEFAULT '',
      sintonia INTEGER NOT NULL DEFAULT 0,
      rarita TEXT NOT NULL,
      mestiere TEXT NOT NULL,
      catalizzatore1 TEXT NOT NULL,
      catalizzatore2 TEXT NOT NULL DEFAULT 'No',
      materialeTag1 TEXT NOT NULL DEFAULT '',
      materialeTag2 TEXT NOT NULL DEFAULT '',
      effettoOggetto TEXT NOT NULL DEFAULT '',
      createdBy TEXT NOT NULL,
      createdAt TEXT NOT NULL,
      updatedAt TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS craft_pending (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      userId TEXT NOT NULL,
      channelId TEXT NOT NULL,
      crafterCharacterId INTEGER NOT NULL,
      recipientCharacterId INTEGER NOT NULL,
      itemName TEXT NOT NULL,
      quantity INTEGER NOT NULL DEFAULT 1,
      attunement INTEGER NOT NULL DEFAULT 0,
      dueAt TEXT NOT NULL,
      summary TEXT NOT NULL,
      createdAt TEXT NOT NULL,
      completedAt TEXT
    );
  `);

  console.log(`SQLite Giacomo collegato a: ${DB_PATH}`);
  console.log(`File miniere/tag usato: ${MINIERE_FILE}`);
}

function getProficiencyBonus(level) {
  const l = Number(level || 1);
  if (l >= 17) return 6;
  if (l >= 13) return 5;
  if (l >= 9) return 4;
  if (l >= 5) return 3;
  return 2;
}

async function getCharactersByOwner(userId) {
  return db.all("SELECT * FROM characters WHERE playerId = ? ORDER BY name ASC", userId);
}

async function getAllCharacters() {
  return db.all("SELECT * FROM characters ORDER BY name ASC");
}

async function getCharacter(id) {
  return db.get("SELECT * FROM characters WHERE id = ?", id);
}

async function getFortress(characterId) {
  return db.get("SELECT name, level FROM fortresses WHERE characterId = ?", characterId);
}

async function getMaterialsInventory(characterId) {
  return db.all(
    "SELECT material, quantity FROM materials_inventory WHERE characterId = ? AND quantity > 0 ORDER BY material ASC",
    characterId
  );
}

async function removeMaterial(characterId, material, qty) {
  const row = await db.get(
    "SELECT quantity FROM materials_inventory WHERE characterId = ? AND lower(material) = lower(?)",
    characterId,
    material
  );

  if (!row || row.quantity < qty) return false;

  const left = row.quantity - qty;

  if (left <= 0) {
    await db.run(
      "DELETE FROM materials_inventory WHERE characterId = ? AND lower(material) = lower(?)",
      characterId,
      material
    );
  } else {
    await db.run(
      "UPDATE materials_inventory SET quantity = ? WHERE characterId = ? AND lower(material) = lower(?)",
      left,
      characterId,
      material
    );
  }

  return true;
}

async function chargeGold(characterId, amount) {
  const pg = await getCharacter(characterId);
  if (!pg) return { ok: false, reason: "PG non trovato." };

  const gold = Number(pg.gold || 0);
  const bank = Number(pg.bank || 0);

  if (gold + bank < amount) {
    return {
      ok: false,
      reason: `Fondi insufficienti: servono ${amount} MO, ma ${pg.name} ha ${gold} in tasca e ${bank} in banca.`
    };
  }

  const fromGold = Math.min(gold, amount);
  const fromBank = amount - fromGold;

  await db.run(
    "UPDATE characters SET gold = ?, bank = ? WHERE id = ?",
    gold - fromGold,
    bank - fromBank,
    characterId
  );

  return { ok: true, fromGold, fromBank };
}

async function addFinishedItem(characterId, itemName, quantity, attunement) {
  const display = quantity > 1 ? `${quantity}x ${itemName}` : itemName;

  await db.run(
    "INSERT INTO inventory (characterId, item) VALUES (?, ?)",
    characterId,
    display
  );

  if (attunement) {
    await db.run(
      "INSERT INTO attunements (characterId, item) VALUES (?, ?)",
      characterId,
      display
    );
  }

  return display;
}

function catalystCost(rarita, tipologia, hasSecond) {
  const r = norm(rarita);
  const t = norm(tipologia);
  const base = CATALYST_COSTS[r]?.[t];

  if (base == null) {
    throw new Error(`Costo catalizzatore non configurato per ${rarita}/${tipologia}`);
  }

  return base * (hasSecond ? 2 : 1);
}

function parseStartDate(value) {
  const dt = DateTime.fromFormat(String(value || ""), "yyyy-MM-dd", { zone: TIMEZONE });
  if (!dt.isValid) return null;
  return dt.startOf("day");
}

function dueAtFor(startDt, days) {
  return startDt
    .plus({ days: Math.max(0, days - 1) })
    .set({ hour: 16, minute: 30, second: 0, millisecond: 0 });
}

function rollCraft(crafter, fortressLevel, rarita) {
  const rules = CRAFT_RULES[norm(rarita)];
  const prof = getProficiencyBonus(crafter.level);
  const fort = Number(fortressLevel || 0);

  let successes = 0;
  const rolls = [];

  for (let day = 1; day <= MAX_ROLL_DAYS && successes < rules.successes; day++) {
    const d10 = Math.floor(Math.random() * 10) + 1;
    const total = d10 + prof + fort;
    const success = total >= rules.cd;

    if (success) successes++;

    rolls.push({
      day,
      d10,
      prof,
      fort,
      total,
      success,
      successes
    });
  }

  if (successes < rules.successes) {
    throw new Error("Limite massimo di giorni raggiunto. Il dado è evidentemente in sciopero.");
  }

  return {
    rolls,
    successes,
    required: rules.successes,
    cd: rules.cd,
    prof,
    fort
  };
}

function rollsSummary(rollData) {
  return rollData.rolls
    .map(r => `Giorno ${r.day}: ${r.d10} + ${r.prof} + ${r.fort} = ${r.total} ${r.success ? "✅ successo" : "❌ fallimento"}`)
    .join("\n");
}

function completionEmbed({
  userId,
  crafter,
  recipient,
  itemDisplay,
  quantity,
  rarita,
  tipologia,
  cost,
  charge,
  rollData,
  dueAt,
  materialsText,
  recipeName = ""
}) {
  return new EmbedBuilder()
    .setTitle("🧾 Craft completato")
    .setDescription(`${pick(GIACOMO_LINES)}\n\n<@${userId}>, **${itemDisplay}** è pronto. Cercate di non rovinarlo entro sera.`)
    .addFields(
      { name: "Crafter", value: crafter.name, inline: true },
      { name: "Destinatario", value: recipient.name, inline: true },
      { name: "Oggetto", value: `${quantity}x ${recipeName || itemDisplay.replace(/^\d+x /, "")}`, inline: true },
      { name: "Rarità / Tipologia", value: `${rarita} / ${tipologia}`, inline: true },
      { name: "Costo catalizzatori", value: `${cost} MO (${charge.fromGold} tasca, ${charge.fromBank} banca)`, inline: true },
      { name: "Materiali", value: materialsText || "Nessuno", inline: false },
      {
        name: "Tiri",
        value: `CD ${rollData.cd}, successi ${rollData.required}. Completato in **${rollData.rolls.length} giorni**.\n\n${rollsSummary(rollData).slice(0, 900)}`,
        inline: false
      },
      { name: "Fine craft", value: dueAt.setZone(TIMEZONE).toFormat("dd/LL/yyyy HH:mm"), inline: true }
    )
    .setColor(0x8b5cf6)
    .setFooter({ text: "Giacomo, il segretario del CC — la burocrazia col ghigno." });
}

function recipeEmbed(recipe) {
  return new EmbedBuilder()
    .setTitle(`📜 ${recipe.nomeOggetto}`)
    .setDescription(recipe.effettoOggetto || "Nessun effetto indicato. Sobrio. O pigro.")
    .addFields(
      {
        name: "Tipologia",
        value: `${recipe.tipologiaOggetto}${recipe.specificaTipologia ? ` — ${recipe.specificaTipologia}` : ""}`,
        inline: true
      },
      { name: "Rarità", value: recipe.rarita, inline: true },
      { name: "Sintonia", value: recipe.sintonia ? "Sì" : "No", inline: true },
      { name: "Mestiere", value: recipe.mestiere, inline: true },
      {
        name: "Catalizzatori",
        value: `${recipe.catalizzatore1}${recipe.catalizzatore2 && recipe.catalizzatore2 !== "No" ? ` + ${recipe.catalizzatore2}` : ""}`,
        inline: true
      },
      {
        name: "Tag materiali",
        value: `${recipe.materialeTag1 || "—"} / ${recipe.materialeTag2 || "—"}`,
        inline: true
      }
    )
    .setColor(0xf59e0b)
    .setFooter({ text: "Archivio ricette CC — niente occhi indiscreti, grazie." });
}

async function completePendingCraft(row) {
  if (row.completedAt) return;

  const recipient = await getCharacter(row.recipientCharacterId);
  const crafter = await getCharacter(row.crafterCharacterId);

  if (!recipient || !crafter) {
    await db.run(
      "UPDATE craft_pending SET completedAt = ? WHERE id = ?",
      DateTime.utc().toISO(),
      row.id
    );
    return;
  }

  const itemDisplay = await addFinishedItem(
    recipient.id,
    row.itemName,
    row.quantity,
    !!row.attunement
  );

  await db.run(
    "UPDATE craft_pending SET completedAt = ? WHERE id = ?",
    DateTime.utc().toISO(),
    row.id
  );

  const channel = await client.channels.fetch(row.channelId).catch(() => null);

  if (channel?.isTextBased()) {
    const embed = EmbedBuilder.from(JSON.parse(row.summary));

    embed.setDescription(
      `${pick(GIACOMO_LINES)}\n\n<@${row.userId}>, **${itemDisplay}** è pronto e aggiunto all'inventario di **${recipient.name}**.${row.attunement ? "\nSintonia inclusa, perché evidentemente serviva complicare anche questa." : ""}`
    );

    await channel.send({
      content: `<@${row.userId}>`,
      embeds: [embed]
    });
  }
}

async function checkPendingCrafts() {
  const now = DateTime.utc().toISO();

  const rows = await db.all(
    "SELECT * FROM craft_pending WHERE completedAt IS NULL AND dueAt <= ? ORDER BY dueAt ASC LIMIT 10",
    now
  );

  for (const row of rows) {
    try {
      await completePendingCraft(row);
    } catch (err) {
      console.error("Errore completamento craft pending", row.id, err);
    }
  }
}

async function executeCraft({
  interaction,
  crafterId,
  itemName,
  rarita,
  sintonia,
  tipologia,
  quantity,
  mestiere,
  catalizzatore2,
  materiale1,
  materiale2,
  startDate,
  recipientId,
  recipe = null
}) {
  const crafter = await getCharacter(crafterId);
  const recipient = await getCharacter(recipientId);

  if (!crafter) return replyError(interaction, "Crafter non trovato. Già partiamo male.");
  if (!recipient) return replyError(interaction, "Destinatario non trovato. Devo consegnarlo all'aria?");

  if (crafter.playerId !== interaction.user.id) {
    return replyError(interaction, "Puoi craftare solo con un tuo PG. Furto d'identità rimandato.");
  }

  const rules = CRAFT_RULES[norm(rarita)];
  if (!rules) return replyError(interaction, "Rarità non valida.");

  const startDt = parseStartDate(startDate);
  if (!startDt) {
    return replyError(interaction, "Data non valida. Usa formato `YYYY-MM-DD`, non un presagio scritto male.");
  }

  const hasSecond = norm(rarita) !== "comune" && catalizzatore2 && !same(catalizzatore2, "No");
  const extraCost = Number(interaction.options.getInteger?.("costo_extra") || 0);
  const cost = catalystCost(rarita, tipologia, hasSecond) + extraCost;

  const neededMaterials = [];

  if (rules.materialRarity) {
    neededMaterials.push({
      name: materiale1,
      tag: recipe?.materialeTag1 || ""
    });

    neededMaterials.push({
      name: materiale2,
      tag: recipe?.materialeTag2 || ""
    });
  }

  for (const needed of neededMaterials) {
    if (!needed.name) {
      return replyError(interaction, "Mancano i materiali. Dettaglio minuscolo, per craftare dal nulla.");
    }

    const meta = findMaterialMetadata(needed.name);

    if (!materialMatches({
      meta,
      requiredRarity: rules.materialRarity,
      mestiere,
      requiredTag: needed.tag
    })) {
      return replyError(
        interaction,
        `**${needed.name}** non è compatibile con rarità/mestiere${needed.tag ? `/tag ${needed.tag}` : ""}. Giacomo non falsifica ricevute.`
      );
    }
  }

  if (neededMaterials.length === 2 && same(neededMaterials[0].name, neededMaterials[1].name)) {
    const row = await db.get(
      "SELECT quantity FROM materials_inventory WHERE characterId = ? AND lower(material) = lower(?)",
      crafter.id,
      neededMaterials[0].name
    );

    if (!row || row.quantity < 2) {
      return replyError(interaction, `Servono 2x **${neededMaterials[0].name}**, ma non ci sono. Aritmetica crudele.`);
    }
  } else {
    for (const needed of neededMaterials) {
      const row = await db.get(
        "SELECT quantity FROM materials_inventory WHERE characterId = ? AND lower(material) = lower(?)",
        crafter.id,
        needed.name
      );

      if (!row || row.quantity < 1) {
        return replyError(interaction, `Manca **${needed.name}** nell'inventario materiali di **${crafter.name}**.`);
      }
    }
  }

  const fortress = await getFortress(crafter.id);
  const rollData = rollCraft(crafter, fortress?.level || 0, rarita);
  const dueAt = dueAtFor(startDt, rollData.rolls.length);

  const charge = await chargeGold(crafter.id, cost);
  if (!charge.ok) return replyError(interaction, charge.reason);

  for (const needed of neededMaterials) {
    await removeMaterial(crafter.id, needed.name, 1);
  }

  const materialText = neededMaterials.length
    ? neededMaterials.map(m => `1x ${m.name}${m.tag ? ` (${m.tag})` : ""}`).join("\n")
    : "Nessuno";

  const baseEmbed = completionEmbed({
    userId: interaction.user.id,
    crafter,
    recipient,
    itemDisplay: itemName,
    quantity,
    rarita,
    tipologia,
    cost,
    charge,
    rollData,
    dueAt,
    materialsText: materialText,
    recipeName: recipe?.nomeOggetto || ""
  });

  const now = DateTime.now().setZone(TIMEZONE);

  if (dueAt <= now) {
    const display = await addFinishedItem(recipient.id, itemName, quantity, sintonia);

    baseEmbed.setDescription(
      `${pick(GIACOMO_LINES)}\n\n<@${interaction.user.id}>, **${display}** era già pronto. Ho sistemato io, come al solito.`
    );

    if (sintonia) {
      baseEmbed.addFields({
        name: "Sintonia",
        value: "Aggiunta al destinatario.",
        inline: true
      });
    }

    return interaction.reply({
      content: `<@${interaction.user.id}>`,
      embeds: [baseEmbed]
    });
  }

  await db.run(
    `INSERT INTO craft_pending (
      userId,
      channelId,
      crafterCharacterId,
      recipientCharacterId,
      itemName,
      quantity,
      attunement,
      dueAt,
      summary,
      createdAt
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    interaction.user.id,
    interaction.channelId,
    crafter.id,
    recipient.id,
    itemName,
    quantity,
    sintonia ? 1 : 0,
    dueAt.toUTC().toISO(),
    JSON.stringify(baseEmbed.toJSON()),
    DateTime.utc().toISO()
  );

  const scheduledEmbed = EmbedBuilder.from(baseEmbed)
    .setTitle("🧾 Craft avviato")
    .setDescription(
      `${pick(GIACOMO_LINES)}\n\nCraft registrato. Ti menzionerò il **${dueAt.toFormat("dd/LL/yyyy alle HH:mm")}**. Cerca di sopravvivere fino ad allora.`
    );

  return interaction.reply({ embeds: [scheduledEmbed] });
}

function commandChoices(list) {
  return list.map(x => ({ name: x, value: x }));
}

const commands = [
  new SlashCommandBuilder()
    .setName("craft")
    .setDescription("Avvia un craft manuale. Giacomo farà i conti, voi provate a non intralciare.")
    .addStringOption(o =>
      o.setName("crafter")
        .setDescription("PG che crafta")
        .setRequired(true)
        .setAutocomplete(true)
    )
    .addStringOption(o =>
      o.setName("nome_oggetto")
        .setDescription("Nome oggetto")
        .setRequired(true)
    )
    .addStringOption(o =>
      o.setName("rarita")
        .setDescription("Rarità")
        .setRequired(true)
        .addChoices(...commandChoices(RARITA))
    )
    .addStringOption(o =>
      o.setName("sintonia")
        .setDescription("Richiede sintonia?")
        .setRequired(true)
        .addChoices(...commandChoices(SI_NO))
    )
    .addStringOption(o =>
      o.setName("tipologia")
        .setDescription("Tipologia oggetto")
        .setRequired(true)
        .addChoices(...commandChoices(TIPI_OGGETTO))
    )
    .addIntegerOption(o =>
      o.setName("quantita")
        .setDescription("Quantità prodotta")
        .setRequired(true)
        .setMinValue(1)
        .setMaxValue(999)
    )
    .addStringOption(o =>
      o.setName("mestiere")
        .setDescription("Mestiere usato")
        .setRequired(true)
        .setAutocomplete(true)
    )
    .addStringOption(o =>
      o.setName("catalizzatore_1")
        .setDescription("Tipo catalizzatore principale")
        .setRequired(true)
        .addChoices(...commandChoices(CATALIZZATORI))
    )
    .addStringOption(o =>
      o.setName("catalizzatore_2")
        .setDescription("Secondo catalizzatore?")
        .setRequired(true)
        .addChoices(...commandChoices(CATALIZZATORI_CON_NO))
    )
    .addStringOption(o =>
      o.setName("data_inizio")
        .setDescription("Data inizio craft: YYYY-MM-DD")
        .setRequired(true)
    )
    .addStringOption(o =>
      o.setName("destinatario")
        .setDescription("PG che riceve l'oggetto")
        .setRequired(true)
        .setAutocomplete(true)
    )
    .addStringOption(o =>
      o.setName("materiale_1")
        .setDescription("Materiale 1, se richiesto")
        .setRequired(false)
        .setAutocomplete(true)
    )
    .addStringOption(o =>
      o.setName("materiale_2")
        .setDescription("Materiale 2, se richiesto")
        .setRequired(false)
        .setAutocomplete(true)
    )
    .addIntegerOption(o =>
      o.setName("costo_extra")
        .setDescription("Costo aggiuntivo opzionale in MO")
        .setRequired(false)
        .setMinValue(0)
        .setMaxValue(1000000)
    ),

  new SlashCommandBuilder()
    .setName("craft_da_ricetta")
    .setDescription("Avvia un craft usando una ricetta del CC.")
    .addStringOption(o =>
      o.setName("crafter")
        .setDescription("PG che crafta")
        .setRequired(true)
        .setAutocomplete(true)
    )
    .addStringOption(o =>
      o.setName("ricetta")
        .setDescription("Ricetta da usare")
        .setRequired(true)
        .setAutocomplete(true)
    )
    .addIntegerOption(o =>
      o.setName("quantita")
        .setDescription("Quantità prodotta")
        .setRequired(true)
        .setMinValue(1)
        .setMaxValue(999)
    )
    .addStringOption(o =>
      o.setName("data_inizio")
        .setDescription("Data inizio craft: YYYY-MM-DD")
        .setRequired(true)
    )
    .addStringOption(o =>
      o.setName("destinatario")
        .setDescription("PG che riceve l'oggetto")
        .setRequired(true)
        .setAutocomplete(true)
    )
    .addStringOption(o =>
      o.setName("materiale_1")
        .setDescription("Materiale reale compatibile col tag 1")
        .setRequired(false)
        .setAutocomplete(true)
    )
    .addStringOption(o =>
      o.setName("materiale_2")
        .setDescription("Materiale reale compatibile col tag 2")
        .setRequired(false)
        .setAutocomplete(true)
    )
    .addIntegerOption(o =>
      o.setName("costo_extra")
        .setDescription("Costo aggiuntivo opzionale in MO")
        .setRequired(false)
        .setMinValue(0)
        .setMaxValue(1000000)
    ),

  new SlashCommandBuilder()
    .setName("aggiungi_ricetta")
    .setDescription("Aggiunge una ricetta all'archivio CC.")
    .addStringOption(o =>
      o.setName("nome_oggetto")
        .setDescription("Nome oggetto")
        .setRequired(true)
    )
    .addStringOption(o =>
      o.setName("tipologia")
        .setDescription("Tipologia oggetto")
        .setRequired(true)
        .addChoices(...commandChoices(TIPI_OGGETTO))
    )
    .addStringOption(o =>
      o.setName("specifica_tipologia")
        .setDescription("Specifica libera, es. spada, pozione, proiettile")
        .setRequired(true)
    )
    .addStringOption(o =>
      o.setName("sintonia")
        .setDescription("Sintonia?")
        .setRequired(true)
        .addChoices(...commandChoices(SI_NO))
    )
    .addStringOption(o =>
      o.setName("rarita")
        .setDescription("Rarità")
        .setRequired(true)
        .addChoices(...commandChoices(RARITA))
    )
    .addStringOption(o =>
      o.setName("mestiere")
        .setDescription("Mestiere")
        .setRequired(true)
        .setAutocomplete(true)
    )
    .addStringOption(o =>
      o.setName("catalizzatore")
        .setDescription("Catalizzatore principale")
        .setRequired(true)
        .addChoices(...commandChoices(CATALIZZATORI))
    )
    .addStringOption(o =>
      o.setName("secondo_catalizzatore")
        .setDescription("Secondo catalizzatore")
        .setRequired(true)
        .addChoices(...commandChoices(CATALIZZATORI_CON_NO))
    )
    .addStringOption(o =>
      o.setName("materiale_tag_1")
        .setDescription("Tag materiale 1")
        .setRequired(false)
        .setAutocomplete(true)
    )
    .addStringOption(o =>
      o.setName("materiale_tag_2")
        .setDescription("Tag materiale 2")
        .setRequired(false)
        .setAutocomplete(true)
    ),

  new SlashCommandBuilder()
    .setName("visualizza_ricetta")
    .setDescription("Visualizza una ricetta. Solo Craft Control, niente turismo.")
    .addStringOption(o =>
      o.setName("ricetta")
        .setDescription("Ricetta")
        .setRequired(true)
        .setAutocomplete(true)
    ),

  new SlashCommandBuilder()
    .setName("lista_ricette")
    .setDescription("Lista le ricette filtrando per mestiere, rarità e tipologia.")
    .addStringOption(o =>
      o.setName("mestiere")
        .setDescription("Mestiere")
        .setRequired(true)
        .setAutocomplete(true)
    )
    .addStringOption(o =>
      o.setName("rarita")
        .setDescription("Rarità")
        .setRequired(true)
        .addChoices(...commandChoices(RARITA))
    )
    .addStringOption(o =>
      o.setName("tipologia")
        .setDescription("Tipologia oggetto")
        .setRequired(true)
        .addChoices(...commandChoices(TIPI_OGGETTO))
    ),

  new SlashCommandBuilder()
    .setName("modifica_ricetta")
    .setDescription("Modifica i campi tecnici di una ricetta. Per l'effetto usa modifica_effetto_ricetta.")
    .addStringOption(o =>
      o.setName("ricetta")
        .setDescription("Ricetta da modificare")
        .setRequired(true)
        .setAutocomplete(true)
    )
    .addStringOption(o =>
      o.setName("nome_oggetto")
        .setDescription("Nuovo nome oggetto")
        .setRequired(false)
    )
    .addStringOption(o =>
      o.setName("tipologia")
        .setDescription("Nuova tipologia oggetto")
        .setRequired(false)
        .addChoices(...commandChoices(TIPI_OGGETTO))
    )
    .addStringOption(o =>
      o.setName("specifica_tipologia")
        .setDescription("Nuova specifica tipologia")
        .setRequired(false)
    )
    .addStringOption(o =>
      o.setName("sintonia")
        .setDescription("Sintonia?")
        .setRequired(false)
        .addChoices(...commandChoices(SI_NO))
    )
    .addStringOption(o =>
      o.setName("rarita")
        .setDescription("Nuova rarità")
        .setRequired(false)
        .addChoices(...commandChoices(RARITA))
    )
    .addStringOption(o =>
      o.setName("mestiere")
        .setDescription("Nuovo mestiere")
        .setRequired(false)
        .setAutocomplete(true)
    )
    .addStringOption(o =>
      o.setName("catalizzatore")
        .setDescription("Nuovo catalizzatore principale")
        .setRequired(false)
        .addChoices(...commandChoices(CATALIZZATORI))
    )
    .addStringOption(o =>
      o.setName("secondo_catalizzatore")
        .setDescription("Nuovo secondo catalizzatore")
        .setRequired(false)
        .addChoices(...commandChoices(CATALIZZATORI_CON_NO))
    )
    .addStringOption(o =>
      o.setName("materiale_tag_1")
        .setDescription("Nuovo tag materiale 1")
        .setRequired(false)
        .setAutocomplete(true)
    )
    .addStringOption(o =>
      o.setName("materiale_tag_2")
        .setDescription("Nuovo tag materiale 2")
        .setRequired(false)
        .setAutocomplete(true)
    ),

  new SlashCommandBuilder()
    .setName("elimina_ricetta")
    .setDescription("Elimina una ricetta dall'archivio CC.")
    .addStringOption(o =>
      o.setName("ricetta")
        .setDescription("Ricetta da eliminare")
        .setRequired(true)
        .setAutocomplete(true)
    )
    .addStringOption(o =>
      o.setName("conferma")
        .setDescription("Scrivi ELIMINA per confermare")
        .setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName("modifica_effetto_ricetta")
    .setDescription("Modifica l'effetto testuale di una ricetta tramite finestra lunga.")
    .addStringOption(o =>
      o.setName("ricetta")
        .setDescription("Ricetta")
        .setRequired(true)
        .setAutocomplete(true)
    )
].map(c => c.toJSON());

async function registerCommands() {
  await rest.put(
    Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID),
    { body: commands }
  );

  console.log("Comandi slash di Giacomo registrati.");
}

function selectMenuOptions(values, focused = "") {
  return values
    .filter(v => !focused || norm(v).includes(norm(focused)))
    .slice(0, 25)
    .map(v => ({
      name: String(v).slice(0, 100),
      value: String(v).slice(0, 100)
    }));
}

function extractId(value) {
  const m = String(value || "").match(/\[(\d+)\]\s*$/);
  return m ? Number(m[1]) : Number(value) || null;
}

function stripQty(value) {
  return String(value || "").replace(/\s+x\d+$/i, "").trim();
}

async function getRecipeFromOption(value) {
  const id = extractId(value);

  if (id) {
    return db.get("SELECT * FROM recipes WHERE id = ?", id);
  }

  return db.get(
    "SELECT * FROM recipes WHERE lower(nomeOggetto) = lower(?)",
    value
  );
}

async function handleAutocomplete(interaction) {
  const focused = interaction.options.getFocused(true);
  const name = focused.name;
  const command = interaction.commandName;

  let options = [];

  if (name === "crafter") {
    const rows = await getCharactersByOwner(interaction.user.id);
    options = selectMenuOptions(rows.map(r => `${r.name} [${r.id}]`), focused.value);
  } else if (name === "destinatario") {
    const rows = await getAllCharacters();
    options = selectMenuOptions(rows.map(r => `${r.name} [${r.id}]`), focused.value);
  } else if (name === "mestiere") {
    options = selectMenuOptions(getAllMestieri(), focused.value);
  } else if (name === "ricetta") {
    const rows = await db.all(
      "SELECT id, nomeOggetto FROM recipes WHERE lower(nomeOggetto) LIKE lower(?) ORDER BY nomeOggetto ASC LIMIT 25",
      `%${focused.value}%`
    );

    options = rows.map(r => ({
      name: `${r.nomeOggetto} [${r.id}]`.slice(0, 100),
      value: `${r.nomeOggetto} [${r.id}]`.slice(0, 100)
    }));
  } else if (name.startsWith("materiale_tag")) {
    options = selectMenuOptions(getAllTags(), focused.value);
  } else if (name === "materiale_1" || name === "materiale_2") {
    const crafterId = extractId(interaction.options.getString("crafter"));

    if (crafterId) {
      const rows = await getMaterialsInventory(crafterId);

      let requiredTag = "";
      let requiredRarity = "";
      let mestiere = interaction.options.getString("mestiere") || "";

      if (command === "craft_da_ricetta") {
        const recipe = await getRecipeFromOption(interaction.options.getString("ricetta"));

        if (recipe) {
          requiredTag = name === "materiale_1" ? recipe.materialeTag1 : recipe.materialeTag2;
          requiredRarity = CRAFT_RULES[norm(recipe.rarita)]?.materialRarity || "";
          mestiere = recipe.mestiere;
        }
      } else {
        requiredRarity = CRAFT_RULES[norm(interaction.options.getString("rarita"))]?.materialRarity || "";
      }

      const filtered = rows.filter(r =>
        materialMatches({
          meta: findMaterialMetadata(r.material),
          requiredRarity,
          mestiere,
          requiredTag
        })
      );

      options = selectMenuOptions(
        filtered.map(r => `${r.material} x${r.quantity}`),
        focused.value
      );
    }
  }

  await interaction.respond(options.slice(0, 25)).catch(() => {});
}

async function requireCC(interaction) {
  if (!isCraftControl(interaction.member)) {
    await replyError(interaction, "Questo archivio è riservato al Craft Control. I curiosi fuori dalla porta.");
    return false;
  }

  return true;
}

async function handleAddRecipe(interaction) {
  if (!(await requireCC(interaction))) return;

  const payload = {
    nomeOggetto: interaction.options.getString("nome_oggetto"),
    tipologiaOggetto: interaction.options.getString("tipologia"),
    specificaTipologia: interaction.options.getString("specifica_tipologia"),
    sintonia: yesNoBool(interaction.options.getString("sintonia")) ? 1 : 0,
    rarita: interaction.options.getString("rarita"),
    mestiere: interaction.options.getString("mestiere"),
    catalizzatore1: interaction.options.getString("catalizzatore"),
    catalizzatore2: interaction.options.getString("secondo_catalizzatore"),
    materialeTag1: cleanEmojiTags(interaction.options.getString("materiale_tag_1") || ""),
    materialeTag2: cleanEmojiTags(interaction.options.getString("materiale_tag_2") || ""),
    createdBy: interaction.user.id
  };

  const key = `${interaction.user.id}:${Date.now()}`;
  pendingRecipeCreates.set(key, payload);

  const modal = new ModalBuilder()
    .setCustomId(`recipe_create:${key}`)
    .setTitle("Effetto Oggetto");

  const input = new TextInputBuilder()
    .setCustomId("effetto")
    .setLabel("Incolla effetto oggetto")
    .setStyle(TextInputStyle.Paragraph)
    .setRequired(false)
    .setMaxLength(3900);

  modal.addComponents(new ActionRowBuilder().addComponents(input));

  await interaction.showModal(modal);
}

async function handleRecipeCreateModal(interaction, key) {
  const payload = pendingRecipeCreates.get(key);

  if (!payload) {
    return replyError(interaction, "Sessione scaduta. Giacomo non conserva foglietti unti all'infinito.");
  }

  pendingRecipeCreates.delete(key);

  const now = DateTime.utc().toISO();
  const effetto = interaction.fields.getTextInputValue("effetto") || "";

  try {
    await db.run(
      `INSERT INTO recipes (
        nomeOggetto,
        tipologiaOggetto,
        specificaTipologia,
        sintonia,
        rarita,
        mestiere,
        catalizzatore1,
        catalizzatore2,
        materialeTag1,
        materialeTag2,
        effettoOggetto,
        createdBy,
        createdAt,
        updatedAt
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      payload.nomeOggetto,
      payload.tipologiaOggetto,
      payload.specificaTipologia,
      payload.sintonia,
      payload.rarita,
      payload.mestiere,
      payload.catalizzatore1,
      payload.catalizzatore2,
      payload.materialeTag1,
      payload.materialeTag2,
      effetto,
      payload.createdBy,
      now,
      now
    );

    const recipe = await db.get(
      "SELECT * FROM recipes WHERE lower(nomeOggetto) = lower(?)",
      payload.nomeOggetto
    );

    await interaction.reply({
      content: `🗂️ **Giacomo:** ${pick(GIACOMO_LINES)} Ricetta salvata.`,
      embeds: [recipeEmbed(recipe)],
      ephemeral: true
    });
  } catch (err) {
    await replyError(
      interaction,
      `Non ho salvato la ricetta. Forse esiste già una ricetta con questo nome.\n\`${err.message}\``
    );
  }
}

async function handleModifyEffect(interaction) {
  if (!(await requireCC(interaction))) return;

  const recipe = await getRecipeFromOption(interaction.options.getString("ricetta"));

  if (!recipe) {
    return replyError(interaction, "Ricetta non trovata.");
  }

  const key = `${interaction.user.id}:${recipe.id}:${Date.now()}`;
  pendingRecipeEdits.set(key, recipe.id);

  const modal = new ModalBuilder()
    .setCustomId(`recipe_effect:${key}`)
    .setTitle(`Effetto: ${recipe.nomeOggetto}`.slice(0, 45));

  const input = new TextInputBuilder()
    .setCustomId("effetto")
    .setLabel("Nuovo effetto oggetto")
    .setStyle(TextInputStyle.Paragraph)
    .setRequired(false)
    .setMaxLength(3900)
    .setValue(String(recipe.effettoOggetto || "").slice(0, 3900));

  modal.addComponents(new ActionRowBuilder().addComponents(input));

  await interaction.showModal(modal);
}

async function handleRecipeEffectModal(interaction, key) {
  const recipeId = pendingRecipeEdits.get(key);

  if (!recipeId) {
    return replyError(interaction, "Sessione scaduta. Colpa del tempo, non mia.");
  }

  pendingRecipeEdits.delete(key);

  const effetto = interaction.fields.getTextInputValue("effetto") || "";

  await db.run(
    "UPDATE recipes SET effettoOggetto = ?, updatedAt = ? WHERE id = ?",
    effetto,
    DateTime.utc().toISO(),
    recipeId
  );

  const recipe = await db.get("SELECT * FROM recipes WHERE id = ?", recipeId);

  await interaction.reply({
    content: "🗂️ **Giacomo:** Effetto aggiornato. La letteratura è salva, più o meno.",
    embeds: [recipeEmbed(recipe)],
    ephemeral: true
  });
}

async function handleCommand(interaction) {
  if (interaction.commandName === "craft" || interaction.commandName === "craft_da_ricetta") {
    if (!isBeta(interaction.member)) {
      return replyError(interaction, "Serve il ruolo Beta. Evidentemente la burocrazia ha ancora una funzione.");
    }

    if (!inCraftChannel(interaction)) {
      return replyError(interaction, "Questo comando va usato nella zona crafting. Non ovunque come coriandoli.");
    }
  }

  if (interaction.commandName === "craft") {
    return executeCraft({
      interaction,
      crafterId: extractId(interaction.options.getString("crafter")),
      itemName: interaction.options.getString("nome_oggetto"),
      rarita: interaction.options.getString("rarita"),
      sintonia: yesNoBool(interaction.options.getString("sintonia")),
      tipologia: interaction.options.getString("tipologia"),
      quantity: interaction.options.getInteger("quantita"),
      mestiere: interaction.options.getString("mestiere"),
      catalizzatore2: interaction.options.getString("catalizzatore_2"),
      materiale1: stripQty(interaction.options.getString("materiale_1") || ""),
      materiale2: stripQty(interaction.options.getString("materiale_2") || ""),
      startDate: interaction.options.getString("data_inizio"),
      recipientId: extractId(interaction.options.getString("destinatario"))
    });
  }

  if (interaction.commandName === "craft_da_ricetta") {
    const recipe = await getRecipeFromOption(interaction.options.getString("ricetta"));

    if (!recipe) {
      return replyError(interaction, "Ricetta non trovata. Archivio consultato, dignità persa.");
    }

    return executeCraft({
      interaction,
      crafterId: extractId(interaction.options.getString("crafter")),
      itemName: recipe.nomeOggetto,
      rarita: recipe.rarita,
      sintonia: !!recipe.sintonia,
      tipologia: recipe.tipologiaOggetto,
      quantity: interaction.options.getInteger("quantita"),
      mestiere: recipe.mestiere,
      catalizzatore2: recipe.catalizzatore2,
      materiale1: stripQty(interaction.options.getString("materiale_1") || ""),
      materiale2: stripQty(interaction.options.getString("materiale_2") || ""),
      startDate: interaction.options.getString("data_inizio"),
      recipientId: extractId(interaction.options.getString("destinatario")),
      recipe
    });
  }

  if (interaction.commandName === "aggiungi_ricetta") {
    return handleAddRecipe(interaction);
  }

  if (interaction.commandName === "modifica_effetto_ricetta") {
    return handleModifyEffect(interaction);
  }

  if (interaction.commandName === "visualizza_ricetta") {
    if (!(await requireCC(interaction))) return;

    const recipe = await getRecipeFromOption(interaction.options.getString("ricetta"));

    if (!recipe) {
      return replyError(interaction, "Ricetta non trovata.");
    }

    return interaction.reply({
      embeds: [recipeEmbed(recipe)],
      ephemeral: true
    });
  }

  if (interaction.commandName === "lista_ricette") {
    if (!(await requireCC(interaction))) return;

    const mestiere = interaction.options.getString("mestiere");
    const rarita = interaction.options.getString("rarita");
    const tipologia = interaction.options.getString("tipologia");

    const rows = await db.all(
      "SELECT nomeOggetto FROM recipes WHERE lower(mestiere)=lower(?) AND lower(rarita)=lower(?) AND lower(tipologiaOggetto)=lower(?) ORDER BY nomeOggetto ASC",
      mestiere,
      rarita,
      tipologia
    );

    const list = rows.length
      ? rows.map(r => `• ${r.nomeOggetto}`).join("\n")
      : "Nessuna ricetta. Il deserto creativo, ma con filtro.";

    const embed = new EmbedBuilder()
      .setTitle("📚 Lista ricette")
      .setDescription(list.slice(0, 3900))
      .addFields(
        { name: "Mestiere", value: mestiere, inline: true },
        { name: "Rarità", value: rarita, inline: true },
        { name: "Tipologia", value: tipologia, inline: true }
      )
      .setColor(0xf59e0b)
      .setFooter({ text: "Prima mestiere, poi rarità, poi tipologia. Ordine: questa cosa sconosciuta." });

    return interaction.reply({
      embeds: [embed],
      ephemeral: true
    });
  }

  if (interaction.commandName === "modifica_ricetta") {
    if (!(await requireCC(interaction))) return;

    const recipe = await getRecipeFromOption(interaction.options.getString("ricetta"));

    if (!recipe) {
      return replyError(interaction, "Ricetta non trovata.");
    }

    const updates = {
      nomeOggetto: interaction.options.getString("nome_oggetto") ?? recipe.nomeOggetto,
      tipologiaOggetto: interaction.options.getString("tipologia") ?? recipe.tipologiaOggetto,
      specificaTipologia: interaction.options.getString("specifica_tipologia") ?? recipe.specificaTipologia,
      sintonia: interaction.options.getString("sintonia")
        ? yesNoBool(interaction.options.getString("sintonia")) ? 1 : 0
        : recipe.sintonia,
      rarita: interaction.options.getString("rarita") ?? recipe.rarita,
      mestiere: interaction.options.getString("mestiere") ?? recipe.mestiere,
      catalizzatore1: interaction.options.getString("catalizzatore") ?? recipe.catalizzatore1,
      catalizzatore2: interaction.options.getString("secondo_catalizzatore") ?? recipe.catalizzatore2,
      materialeTag1: interaction.options.getString("materiale_tag_1") != null
        ? cleanEmojiTags(interaction.options.getString("materiale_tag_1"))
        : recipe.materialeTag1,
      materialeTag2: interaction.options.getString("materiale_tag_2") != null
        ? cleanEmojiTags(interaction.options.getString("materiale_tag_2"))
        : recipe.materialeTag2
    };

    try {
      await db.run(
        `UPDATE recipes SET
          nomeOggetto = ?,
          tipologiaOggetto = ?,
          specificaTipologia = ?,
          sintonia = ?,
          rarita = ?,
          mestiere = ?,
          catalizzatore1 = ?,
          catalizzatore2 = ?,
          materialeTag1 = ?,
          materialeTag2 = ?,
          updatedAt = ?
        WHERE id = ?`,
        updates.nomeOggetto,
        updates.tipologiaOggetto,
        updates.specificaTipologia,
        updates.sintonia,
        updates.rarita,
        updates.mestiere,
        updates.catalizzatore1,
        updates.catalizzatore2,
        updates.materialeTag1,
        updates.materialeTag2,
        DateTime.utc().toISO(),
        recipe.id
      );

      const fresh = await db.get(
        "SELECT * FROM recipes WHERE id = ?",
        recipe.id
      );

      return interaction.reply({
        content: `🗂️ **Giacomo:** ${pick(GIACOMO_LINES)} Ricetta modificata. Per l'effetto testuale usa \`/modifica_effetto_ricetta\`.`,
        embeds: [recipeEmbed(fresh)],
        ephemeral: true
      });
    } catch (err) {
      return replyError(
        interaction,
        `Modifica fallita. Probabilmente un nome duplicato, perché ovviamente.\n\`${err.message}\``
      );
    }
  }

  if (interaction.commandName === "elimina_ricetta") {
    if (!(await requireCC(interaction))) return;

    const confirm = interaction.options.getString("conferma");

    if (confirm !== "ELIMINA") {
      return replyError(
        interaction,
        "Per eliminare devi scrivere esattamente `ELIMINA`. Sì, urlando. Aiuta a capire la gravità."
      );
    }

    const recipe = await getRecipeFromOption(interaction.options.getString("ricetta"));

    if (!recipe) {
      return replyError(interaction, "Ricetta non trovata.");
    }

    await db.run(
      "DELETE FROM recipes WHERE id = ?",
      recipe.id
    );

    return interaction.reply({
      content: `🗑️ **Giacomo:** Ricetta **${recipe.nomeOggetto}** eliminata. Una lapide sarà protocollata entro 3-5 giorni lavorativi.`,
      ephemeral: true
    });
  }
}

client.on("interactionCreate", async interaction => {
  try {
    if (interaction.isAutocomplete()) {
      return handleAutocomplete(interaction);
    }

    if (interaction.isModalSubmit()) {
      if (interaction.customId.startsWith("recipe_create:")) {
        return handleRecipeCreateModal(
          interaction,
          interaction.customId.replace("recipe_create:", "")
        );
      }

      if (interaction.customId.startsWith("recipe_effect:")) {
        return handleRecipeEffectModal(
          interaction,
          interaction.customId.replace("recipe_effect:", "")
        );
      }
    }

    if (interaction.isChatInputCommand()) {
      return handleCommand(interaction);
    }
  } catch (err) {
    console.error("Errore interactionCreate:", err);

    const payload = {
      content: `🗂️ **Giacomo:** ${pick(ERROR_LINES)}\n\`${String(err.message || err).slice(0, 1500)}\``,
      ephemeral: true
    };

    if (interaction.deferred || interaction.replied) {
      await interaction.followUp(payload).catch(() => {});
    } else {
      await interaction.reply(payload).catch(() => {});
    }
  }
});

client.once("ready", async () => {
  console.log(`Giacomo operativo come ${client.user.tag}. Purtroppo per gli utenti.`);

  await checkPendingCrafts();
  setInterval(checkPendingCrafts, CHECK_INTERVAL_MS);
});

await initDB();
await registerCommands();
client.login(TOKEN);
