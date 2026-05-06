import { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder } from "discord.js";
import sqlite3 from "sqlite3";
import { open } from "sqlite";

const token = process.env.WESTMARCH_TOKEN || process.env.TOKEN;
const guildId = process.env.GUILD_ID;
const clientId = process.env.CLIENT_ID;
const DB_PATH = process.env.DB_PATH || "/data/westmarch.db";

if (!token || !clientId || !guildId) {
  console.error("Missing environment variables. Ensure WESTMARCH_TOKEN/TOKEN, CLIENT_ID and GUILD_ID are set.");
  process.exit(1);
}

const rest = new REST({ version: "10" }).setToken(token);

let db;

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

  CREATE TABLE IF NOT EXISTS daily_farms (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      characterId INTEGER NOT NULL,
      date TEXT NOT NULL,
      count INTEGER NOT NULL DEFAULT 0,
      UNIQUE(characterId, date),
      FOREIGN KEY (characterId) REFERENCES characters(id)
  );
  `);

  console.log(`SQLite inizializzato: ${DB_PATH}`);
}

await initDB();

const REWARDS = {
  "C": { xp: 400, gold: 100 },
  "C+": { xp: 600, gold: 200 },
  "B": { xp: 1200, gold: 300 },
  "B+": { xp: 1800, gold: 400 },
  "A": { xp: 2400, gold: 800 },
  "A+": { xp: 3600, gold: 1200 },
  "S": { xp: 4800, gold: 1600 },
  "S+": { xp: 9600, gold: 2000 },
  "Z": { xp: 19200, gold: 2400 }
};

const XP_LEVELS = [
  0, 300, 900, 2700, 6500, 14000, 23000, 34000, 48000, 64000,
  85000, 100000, 120000, 140000, 165000, 195000, 225000, 265000,
  305000, 355000
];

function getLevelFromXP(xp) {
  for (let lvl = XP_LEVELS.length - 1; lvl >= 0; lvl--) {
    if (xp >= XP_LEVELS[lvl]) return lvl + 1;
  }
  return 1;
}

function getProficiencyBonus(level) {
  if (level >= 17) return 6;
  if (level >= 13) return 5;
  if (level >= 9) return 4;
  if (level >= 5) return 3;
  return 2;
}

const LEVEL_UP_LINES = [
  "È salito di livello. Miracolo: apparentemente sopravvivere facendo scelte discutibili funziona.",
  "Nuovo livello raggiunto. Qualcuno avvisi i nemici: ora è leggermente meno imbarazzante.",
  "Ha ottenuto un livello. Non sappiamo come, ma le autorità stanno indagando.",
  "Level up! Le probabilità di morire per arroganza restano alte, ma almeno ora con bonus migliori.",
  "È salito di livello. Il talento c'entra poco, ma la perseveranza nel creare problemi va premiata.",
  "Congratulazioni: ora può sbagliare con più competenza.",
  "Nuovo livello. Il multiverso ha controllato i registri e, contro ogni logica, ha approvato.",
  "È diventato più forte. Non necessariamente più saggio, non esageriamo.",
  "Level up! Il personaggio migliora, il processo decisionale del giocatore resta in beta.",
  "È salito di livello. Gli dei hanno sospirato, ma hanno firmato comunque."
];

function randomLevelUpLine() {
  return LEVEL_UP_LINES[Math.floor(Math.random() * LEVEL_UP_LINES.length)];
}

async function ensurePlayer(user) {
  const existing = await db.get("SELECT id FROM players WHERE id = ?", user.id);

  if (!existing) {
    await db.run("INSERT INTO players (id, name) VALUES (?, ?)", user.id, user.username);
  } else {
    await db.run("UPDATE players SET name = ? WHERE id = ?", user.username, user.id);
  }
}

async function getCharacter(playerId, name) {
  return db.get("SELECT * FROM characters WHERE playerId = ? AND lower(name) = lower(?)", playerId, name);
}

async function getCharacterById(id) {
  return db.get("SELECT * FROM characters WHERE id = ?", id);
}

async function getCharactersByName(name) {
  return db.all("SELECT * FROM characters WHERE lower(name) = lower(?)", name);
}

async function listCharacters(playerId) {
  return db.all("SELECT * FROM characters WHERE playerId = ?", playerId);
}

async function listAllCharacterNames() {
  const rows = await db.all("SELECT DISTINCT name FROM characters ORDER BY name ASC");
  return rows.map(r => r.name);
}

async function createCharacter(playerId, name) {
  const info = await db.run(
    `INSERT INTO characters (playerId, name, xp, gold, bank, level)
     VALUES (?, ?, 0, 0, 0, 1)`,
    playerId,
    name
  );

  return info.lastID;
}

async function updateCharacterGold(characterId, newGold) {
  await db.run("UPDATE characters SET gold = ? WHERE id = ?", newGold, characterId);
}

async function updateCharacterBank(characterId, newBank) {
  await db.run("UPDATE characters SET bank = ? WHERE id = ?", newBank, characterId);
}

async function renameCharacter(characterId, newName) {
  await db.run("UPDATE characters SET name = ? WHERE id = ?", newName, characterId);
}

async function deleteCharacterAndData(characterId) {
  await db.run("DELETE FROM inventory WHERE characterId = ?", characterId);
  await db.run("DELETE FROM attunements WHERE characterId = ?", characterId);
  await db.run("DELETE FROM daily_farms WHERE characterId = ?", characterId);
  await db.run("DELETE FROM characters WHERE id = ?", characterId);
}

async function resetAllCharacters() {
  await db.run("DELETE FROM inventory");
  await db.run("DELETE FROM attunements");
  await db.run("DELETE FROM daily_farms");
  await db.run("DELETE FROM characters");
  await db.run("DELETE FROM players");
}

async function getInventory(characterId) {
  const rows = await db.all("SELECT item FROM inventory WHERE characterId = ?", characterId);
  return rows.map(r => r.item);
}

async function addInventoryItem(characterId, item) {
  await db.run("INSERT INTO inventory (characterId, item) VALUES (?, ?)", characterId, item);
}

async function removeInventoryItemsByCleanName(characterId, cleanName) {
  const rows = await db.all("SELECT id, item FROM inventory WHERE characterId = ?", characterId);
  const toDelete = rows.filter(r => stripSintonizedTag(r.item) === cleanName);

  for (const r of toDelete) {
    await db.run("DELETE FROM inventory WHERE id = ?", r.id);
  }

  return toDelete.length;
}

async function getAttunements(characterId) {
  const rows = await db.all("SELECT item FROM attunements WHERE characterId = ?", characterId);
  return rows.map(r => r.item);
}

async function addAttunement(characterId, item) {
  await db.run("INSERT INTO attunements (characterId, item) VALUES (?, ?)", characterId, item);
}

async function clearAttunementByName(characterId, item) {
  await db.run("DELETE FROM attunements WHERE characterId = ? AND item = ?", characterId, item);
}

async function transferBankMoney(fromCharacterId, toCharacterId, amount) {
  await db.run("BEGIN TRANSACTION");

  try {
    const fromPg = await getCharacterById(fromCharacterId);
    const toPg = await getCharacterById(toCharacterId);

    if (!fromPg || !toPg) throw new Error("PG non trovato.");
    if (amount <= 0) throw new Error("Quantità non valida.");
    if (fromPg.bank < amount) throw new Error("Fondi insufficienti nel deposito del PG mittente.");

    await db.run("UPDATE characters SET bank = bank - ? WHERE id = ?", amount, fromCharacterId);
    await db.run("UPDATE characters SET bank = bank + ? WHERE id = ?", amount, toCharacterId);

    await db.run("COMMIT");
  } catch (error) {
    await db.run("ROLLBACK");
    throw error;
  }
}

const commands = [
  new SlashCommandBuilder()
    .setName("crea_pg")
    .setDescription("Crea un personaggio per un giocatore (max 3).")
    .addUserOption(o => o.setName("giocatore").setDescription("Il giocatore").setRequired(true))
    .addStringOption(o => o.setName("nome").setDescription("Nome del PG").setRequired(true)),

  new SlashCommandBuilder()
    .setName("scheda")
    .setDescription("Mostra la scheda di un PG.")
    .addUserOption(o => o.setName("giocatore").setDescription("Il giocatore").setRequired(true))
    .addStringOption(o => o.setName("nome").setDescription("Nome del PG").setRequired(true).setAutocomplete(true)),

  new SlashCommandBuilder()
    .setName("ricompensa")
    .setDescription("Assegna automaticamente ricompense di una sessione.")
    .addStringOption(o =>
      o.setName("grado")
        .setDescription("C, C+, B, B+, A, A+, S, S+, Z")
        .setRequired(true)
        .addChoices(
          { name: "C — 400 XP / 100 gold", value: "C" },
          { name: "C+ — 600 XP / 200 gold", value: "C+" },
          { name: "B — 1200 XP / 300 gold", value: "B" },
          { name: "B+ — 1800 XP / 400 gold", value: "B+" },
          { name: "A — 2400 XP / 800 gold", value: "A" },
          { name: "A+ — 3600 XP / 1200 gold", value: "A+" },
          { name: "S — 4800 XP / 1600 gold", value: "S" },
          { name: "S+ — 9600 XP / 2000 gold", value: "S+" },
          { name: "Z — 19200 XP / 2400 gold", value: "Z" }
        )
    )
    .addUserOption(o => o.setName("giocatore").setDescription("Il giocatore").setRequired(true))
    .addStringOption(o => o.setName("nome").setDescription("Nome del PG").setRequired(true).setAutocomplete(true)),

  new SlashCommandBuilder()
    .setName("aggiungi")
    .setDescription("Aggiunge XP, oro o oggetto al PG. Richiede nota.")
    .addStringOption(o => o.setName("tipo").setDescription("xp | gold | item").setRequired(true))
    .addStringOption(o => o.setName("valore").setDescription("Numero o nome oggetto. Per più item separa con ,").setRequired(true))
    .addStringOption(o => o.setName("note").setDescription("Motivo della modifica").setRequired(true))
    .addUserOption(o => o.setName("giocatore").setDescription("Il giocatore").setRequired(true))
    .addStringOption(o => o.setName("nome").setDescription("Nome del PG").setRequired(true).setAutocomplete(true)),

  new SlashCommandBuilder()
    .setName("rimuovi")
    .setDescription("Rimuove XP, oro o oggetto dal PG. Richiede nota.")
    .addStringOption(o => o.setName("tipo").setDescription("xp | gold | item").setRequired(true))
    .addStringOption(o => o.setName("valore").setDescription("Numero o nome oggetto. Per più item separa con ,").setRequired(true))
    .addStringOption(o => o.setName("note").setDescription("Motivo della modifica").setRequired(true))
    .addUserOption(o => o.setName("giocatore").setDescription("Il giocatore").setRequired(true))
    .addStringOption(o => o.setName("nome").setDescription("Nome del PG").setRequired(true).setAutocomplete(true)),

  new SlashCommandBuilder()
    .setName("elimina_pg")
    .setDescription("Elimina completamente una scheda PG usando solo il nome.")
    .addStringOption(o => o.setName("nome").setDescription("Nome del PG").setRequired(true).setAutocomplete(true)),

  new SlashCommandBuilder()
    .setName("reset")
    .setDescription("Elimina TUTTE le schede PG, inventari, sintonie e farm giornalieri.")
    .addStringOption(o => o.setName("conferma").setDescription("Scrivi RESET per confermare").setRequired(true)),

  new SlashCommandBuilder()
    .setName("rinomina_pg")
    .setDescription("Rinomina un PG.")
    .addUserOption(o => o.setName("giocatore").setDescription("Il giocatore").setRequired(true))
    .addStringOption(o => o.setName("vecchio_nome").setDescription("Nome attuale del PG").setRequired(true).setAutocomplete(true))
    .addStringOption(o => o.setName("nuovo_nome").setDescription("Nuovo nome del PG").setRequired(true)),

  new SlashCommandBuilder()
    .setName("deposito")
    .setDescription("Sposta oro -> conto bancario")
    .addIntegerOption(o => o.setName("quantita").setDescription("Quantità di oro da depositare").setRequired(true))
    .addUserOption(o => o.setName("giocatore").setDescription("Il giocatore").setRequired(true))
    .addStringOption(o => o.setName("nome").setDescription("Nome del PG").setRequired(true).setAutocomplete(true)),

  new SlashCommandBuilder()
    .setName("prelievo")
    .setDescription("Sposta conto bancario -> oro")
    .addIntegerOption(o => o.setName("quantita").setDescription("Quantità da prelevare").setRequired(true))
    .addUserOption(o => o.setName("giocatore").setDescription("Il giocatore").setRequired(true))
    .addStringOption(o => o.setName("nome").setDescription("Nome del PG").setRequired(true).setAutocomplete(true)),

  new SlashCommandBuilder()
    .setName("versa")
    .setDescription("Aggiunge denaro direttamente al deposito bancario di un PG.")
    .addIntegerOption(o => o.setName("quantita").setDescription("Quantità da versare").setRequired(true))
    .addStringOption(o => o.setName("note").setDescription("Motivo del versamento").setRequired(true))
    .addUserOption(o => o.setName("giocatore").setDescription("Il giocatore").setRequired(true))
    .addStringOption(o => o.setName("nome").setDescription("Nome del PG").setRequired(true).setAutocomplete(true)),

  new SlashCommandBuilder()
    .setName("paga")
    .setDescription("Rimuove denaro direttamente dal deposito bancario di un PG.")
    .addIntegerOption(o => o.setName("quantita").setDescription("Quantità da pagare").setRequired(true))
    .addStringOption(o => o.setName("note").setDescription("Motivo del pagamento").setRequired(true))
    .addUserOption(o => o.setName("giocatore").setDescription("Il giocatore").setRequired(true))
    .addStringOption(o => o.setName("nome").setDescription("Nome del PG").setRequired(true).setAutocomplete(true)),

  new SlashCommandBuilder()
    .setName("scambio")
    .setDescription("Trasferisce denaro tra i depositi bancari di due PG.")
    .addIntegerOption(o => o.setName("quantita").setDescription("Quantità da trasferire").setRequired(true))
    .addStringOption(o => o.setName("note").setDescription("Motivo dello scambio").setRequired(true))
    .addUserOption(o => o.setName("da_giocatore").setDescription("Giocatore mittente").setRequired(true))
    .addStringOption(o => o.setName("da_pg").setDescription("PG mittente").setRequired(true).setAutocomplete(true))
    .addUserOption(o => o.setName("a_giocatore").setDescription("Giocatore destinatario").setRequired(true))
    .addStringOption(o => o.setName("a_pg").setDescription("PG destinatario").setRequired(true).setAutocomplete(true)),

  new SlashCommandBuilder()
    .setName("aggiungi_item")
    .setDescription("Aggiungi uno o più item al PG.")
    .addStringOption(o => o.setName("items").setDescription("Lista item separati da ,").setRequired(true))
    .addUserOption(o => o.setName("giocatore").setDescription("Il giocatore").setRequired(true))
    .addStringOption(o => o.setName("nome").setDescription("Nome del PG").setRequired(true).setAutocomplete(true)),

  new SlashCommandBuilder()
    .setName("rimuovi_item")
    .setDescription("Rimuovi uno o più item dal PG.")
    .addStringOption(o => o.setName("items").setDescription("Lista item separati da ,").setRequired(true))
    .addUserOption(o => o.setName("giocatore").setDescription("Il giocatore").setRequired(true))
    .addStringOption(o => o.setName("nome").setDescription("Nome del PG").setRequired(true).setAutocomplete(true)),

  new SlashCommandBuilder()
    .setName("aggiungi_sintonia")
    .setDescription("Aggiunge una sintonia (max 3).")
    .addStringOption(o => o.setName("nome_sintonia").setDescription("Nome dell'oggetto magico").setRequired(true))
    .addUserOption(o => o.setName("giocatore").setDescription("Il giocatore").setRequired(true))
    .addStringOption(o => o.setName("nome").setDescription("Nome del PG").setRequired(true).setAutocomplete(true)),

  new SlashCommandBuilder()
    .setName("rimuovi_sintonia")
    .setDescription("Rimuove una sintonia dal PG.")
    .addStringOption(o => o.setName("nome_sintonia").setDescription("Nome dell'oggetto magico").setRequired(true))
    .addUserOption(o => o.setName("giocatore").setDescription("Il giocatore").setRequired(true))
    .addStringOption(o => o.setName("nome").setDescription("Nome del PG").setRequired(true).setAutocomplete(true)),

  new SlashCommandBuilder()
    .setName("lista_pg")
    .setDescription("Lista tutti i PG di un giocatore.")
    .addUserOption(o => o.setName("giocatore").setDescription("Il giocatore").setRequired(true))
].map(c => c.toJSON());

(async () => {
  try {
    console.log("Started refreshing application (/) commands.");
    await rest.put(Routes.applicationGuildCommands(clientId, guildId), { body: commands });
    console.log("Successfully reloaded application (/) commands.");
  } catch (error) {
    console.error(error);
  }
})();

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

client.on("ready", () => {
  console.log(`Westmarch Bot attivo come: ${client.user.tag}`);
});

function hasRoleGM(member, roleName = "Gm-bot") {
  try {
    return member.roles.cache.some(r => r.name === roleName);
  } catch {
    return false;
  }
}

const sanitizeItemsList = raw =>
  raw.split(",").map(s => s.trim()).filter(s => s.length);

const isSintonizedTag = str => /\[s\]/i.test(str);
const stripSintonizedTag = str => str.replace(/\[s\]/ig, "").trim();

async function handleLevelUpIfAny(characterId, oldXP, interaction) {
  const character = await getCharacterById(characterId);
  if (!character) return null;

  const oldLevel = getLevelFromXP(oldXP);
  const newLevel = getLevelFromXP(character.xp);

  if (newLevel <= oldLevel) return null;

  await db.run("UPDATE characters SET level = ? WHERE id = ?", newLevel, characterId);

  const msg =
    `<@${character.playerId}> 🎉 **${character.name} è salito al livello ${newLevel}!**\n` +
    `_${randomLevelUpLine()}_`;

  let channel = null;

  if (process.env.LEVEL_UP_CHANNEL) {
    channel = client.channels.cache.get(process.env.LEVEL_UP_CHANNEL);
  }

  if (!channel && interaction?.guild) {
    channel = interaction.guild.channels.cache.find(
      c => c.name?.toLowerCase().includes("level")
    );
  }

  try {
    if (channel) await channel.send({ content: msg });
  } catch (e) {
    console.error("Errore notifica level up:", e.message);
  }

  return msg;
}

client.on("interactionCreate", async interaction => {
  try {
    if (interaction.isAutocomplete()) {
      const focusedOption = interaction.options.getFocused(true);

      if (["nome", "vecchio_nome", "da_pg", "a_pg"].includes(focusedOption.name)) {
        let user = null;

        if (focusedOption.name === "da_pg") {
          user = interaction.options.getUser("da_giocatore");
        } else if (focusedOption.name === "a_pg") {
          user = interaction.options.getUser("a_giocatore");
        } else if (focusedOption.name !== "nome" || interaction.commandName !== "elimina_pg") {
          user = interaction.options.getUser("giocatore");
        }

        let choices = [];

        if (user) {
          const chars = await listCharacters(user.id);
          choices = chars.map(c => c.name);
        } else {
          choices = await listAllCharacterNames();
        }

        const filtered = choices
          .filter(c => c.toLowerCase().startsWith(focusedOption.value.toLowerCase()))
          .slice(0, 25);

        return interaction.respond(filtered.map(c => ({ name: c, value: c })));
      }

      return interaction.respond([]);
    }

    if (!interaction.isChatInputCommand()) return;

    const command = interaction.commandName;
    const isGM = hasRoleGM(interaction.member);

    if (command === "crea_pg") {
      if (!isGM) return interaction.reply({ content: "Solo il ruolo Gm-bot può usare questo comando.", ephemeral: true });

      const user = interaction.options.getUser("giocatore");
      const name = interaction.options.getString("nome");

      await ensurePlayer(user);

      const existing = await listCharacters(user.id);
      if (existing.length >= 3) return interaction.reply({ content: "Questo giocatore ha già 3 PG attivi!", ephemeral: true });

      await createCharacter(user.id, name);
      return interaction.reply(`PG **${name}** creato per ${user.username}.`);
    }

    if (command === "scheda") {
      const user = interaction.options.getUser("giocatore");
      const name = interaction.options.getString("nome");

      const pg = await getCharacter(user.id, name);
      if (!pg) return interaction.reply({ content: "PG non trovato!", ephemeral: true });

      const inventory = await getInventory(pg.id);
      const sintonie = await getAttunements(pg.id);
      const proficiencyBonus = getProficiencyBonus(pg.level);

      const invDisplay = inventory.length
        ? inventory.map(i => {
            if (isSintonizedTag(i)) return i;
            const clean = stripSintonizedTag(i);
            return sintonie.includes(clean) ? `${i} [s]` : i;
          }).join(", ")
        : "Vuoto";

      return interaction.reply({
        content:
          `📜 **Scheda di ${pg.name}**\n` +
          `ID PG: ${pg.id}\n` +
          `Livello: ${pg.level}\n` +
          `Bonus competenza: +${proficiencyBonus}\n` +
          `Farm giornalieri massimi: ${proficiencyBonus}\n` +
          `XP: ${pg.xp}\n` +
          `Gold in tasca: ${pg.gold}\n` +
          `Deposito bancario: ${pg.bank}\n` +
          `Sintonie: ${sintonie.length ? sintonie.join(", ") : "Nessuna"}\n` +
          `Inventario: ${invDisplay}`,
        ephemeral: false
      });
    }

    if (command === "ricompensa") {
      if (!isGM) return interaction.reply({ content: "Solo il ruolo Gm-bot può usare questo comando.", ephemeral: true });

      const grade = interaction.options.getString("grado").toUpperCase();
      const user = interaction.options.getUser("giocatore");
      const name = interaction.options.getString("nome");

      const reward = REWARDS[grade];
      if (!reward) {
        return interaction.reply({
          content: "Grado non valido. Usa C, C+, B, B+, A, A+, S, S+ o Z.",
          ephemeral: true
        });
      }

      const pg = await getCharacter(user.id, name);
      if (!pg) return interaction.reply({ content: "PG non trovato!", ephemeral: true });

      const beforeXP = pg.xp;
      const newXP = pg.xp + reward.xp;
      const newGold = pg.gold + reward.gold;
      const newLevel = getLevelFromXP(newXP);

      await db.run(
        "UPDATE characters SET xp = ?, level = ?, gold = ? WHERE id = ?",
        newXP, newLevel, newGold, pg.id
      );

      const levelMsg = await handleLevelUpIfAny(pg.id, beforeXP, interaction);

      let response =
        `Sessione grado **${grade}** completata!\n` +
        `${pg.name} guadagna: **${reward.xp} XP** e **${reward.gold} oro**.`;

      if (levelMsg && !process.env.LEVEL_UP_CHANNEL) response += `\n\n${levelMsg}`;

      return interaction.reply(response);
    }

    if (command === "aggiungi") {
      if (!isGM) return interaction.reply({ content: "Solo il ruolo Gm-bot può usare questo comando.", ephemeral: true });

      const type = interaction.options.getString("tipo");
      const rawValue = interaction.options.getString("valore");
      const note = interaction.options.getString("note");
      const user = interaction.options.getUser("giocatore");
      const name = interaction.options.getString("nome");

      const pg = await getCharacter(user.id, name);
      if (!pg) return interaction.reply({ content: "PG non trovato!", ephemeral: true });

      if (type === "xp") {
        const amount = parseInt(rawValue);
        if (Number.isNaN(amount)) return interaction.reply({ content: "Valore XP non valido.", ephemeral: true });

        const before = pg.xp;
        const newXP = before + amount;
        const newLevel = getLevelFromXP(newXP);

        await db.run("UPDATE characters SET xp = ?, level = ? WHERE id = ?", newXP, newLevel, pg.id);

        const levelMsg = await handleLevelUpIfAny(pg.id, before, interaction);
        let response = `${user.username} - PG **${pg.name}**: XP ${before} → ${newXP}. Nota: ${note}`;
        if (levelMsg && !process.env.LEVEL_UP_CHANNEL) response += `\n\n${levelMsg}`;

        return interaction.reply(response);
      }

      if (type === "gold") {
        const amount = parseInt(rawValue);
        if (Number.isNaN(amount)) return interaction.reply({ content: "Valore gold non valido.", ephemeral: true });

        const before = pg.gold;
        const newGold = before + amount;

        await updateCharacterGold(pg.id, newGold);
        return interaction.reply(`${user.username} - PG **${pg.name}**: Gold ${before} → ${newGold}. Nota: ${note}`);
      }

      if (type === "item") {
        const items = sanitizeItemsList(rawValue);
        if (!items.length) return interaction.reply({ content: "Nessun item valido fornito.", ephemeral: true });

        let sintonie = await getAttunements(pg.id);
        const addedItems = [];
        const addedSints = [];
        const skippedSints = [];

        for (const rawItem of items) {
          const hadTag = isSintonizedTag(rawItem);
          const clean = stripSintonizedTag(rawItem);
          const itemToStore = hadTag ? `${clean} [s]` : clean;

          await addInventoryItem(pg.id, itemToStore);
          addedItems.push(itemToStore);

          if (hadTag && !sintonie.includes(clean)) {
            if (sintonie.length >= 3) {
              skippedSints.push(clean);
            } else {
              await addAttunement(pg.id, clean);
              sintonie.push(clean);
              addedSints.push(clean);
            }
          }
        }

        let resp = `${user.username} - PG **${pg.name}**: Aggiunti item: ${addedItems.join(", ")}. Nota: ${note}`;
        if (addedSints.length) resp += ` Sintonie aggiunte: ${addedSints.join(", ")}.`;
        if (skippedSints.length) resp += ` Sintonie non aggiunte (limite 3): ${skippedSints.join(", ")}.`;

        return interaction.reply(resp);
      }

      return interaction.reply({ content: "Tipo non valido.", ephemeral: true });
    }

    if (command === "rimuovi") {
      if (!isGM) return interaction.reply({ content: "Solo il ruolo Gm-bot può usare questo comando.", ephemeral: true });

      const type = interaction.options.getString("tipo");
      const rawValue = interaction.options.getString("valore");
      const note = interaction.options.getString("note");
      const user = interaction.options.getUser("giocatore");
      const name = interaction.options.getString("nome");

      const pg = await getCharacter(user.id, name);
      if (!pg) return interaction.reply({ content: "PG non trovato!", ephemeral: true });

      if (type === "xp") {
        const amount = parseInt(rawValue);
        if (Number.isNaN(amount)) return interaction.reply({ content: "Valore XP non valido.", ephemeral: true });

        const before = pg.xp;
        const newXP = Math.max(0, before - amount);
        const newLevel = getLevelFromXP(newXP);

        await db.run("UPDATE characters SET xp = ?, level = ? WHERE id = ?", newXP, newLevel, pg.id);
        return interaction.reply(`${user.username} - PG **${pg.name}**: XP ${before} → ${newXP}. Nota: ${note}`);
      }

      if (type === "gold") {
        const amount = parseInt(rawValue);
        if (Number.isNaN(amount)) return interaction.reply({ content: "Valore gold non valido.", ephemeral: true });

        const before = pg.gold;
        const newGold = Math.max(0, before - amount);

        await updateCharacterGold(pg.id, newGold);
        return interaction.reply(`${user.username} - PG **${pg.name}**: Gold ${before} → ${newGold}. Nota: ${note}`);
      }

      if (type === "item") {
        const items = sanitizeItemsList(rawValue);
        if (!items.length) return interaction.reply({ content: "Nessun item valido fornito.", ephemeral: true });

        let sintonie = await getAttunements(pg.id);
        const removed = [];
        const notFound = [];
        const removedSints = [];

        for (const rawIt of items) {
          const clean = stripSintonizedTag(rawIt);
          const deletedCount = await removeInventoryItemsByCleanName(pg.id, clean);

          if (deletedCount > 0) {
            removed.push(rawIt);
            if (sintonie.includes(clean)) {
              await clearAttunementByName(pg.id, clean);
              sintonie = sintonie.filter(s => s !== clean);
              removedSints.push(clean);
            }
          } else {
            notFound.push(rawIt);
          }
        }

        let msg = `${user.username} - PG **${pg.name}**: Rimosso: ${removed.length ? removed.join(", ") : "Nessuno"}.`;
        if (notFound.length) msg += ` Non trovati: ${notFound.join(", ")}.`;
        if (removedSints.length) msg += ` Sintonie rimosse: ${removedSints.join(", ")}.`;
        msg += ` Nota: ${note}`;

        return interaction.reply(msg);
      }

      return interaction.reply({ content: "Tipo non valido.", ephemeral: true });
    }

    if (command === "deposito") {
      if (!isGM) return interaction.reply({ content: "Solo il ruolo Gm-bot può usare questo comando.", ephemeral: true });

      const amount = interaction.options.getInteger("quantita");
      const user = interaction.options.getUser("giocatore");
      const name = interaction.options.getString("nome");

      const pg = await getCharacter(user.id, name);
      if (!pg) return interaction.reply({ content: "PG non trovato!", ephemeral: true });
      if (amount <= 0) return interaction.reply({ content: "Quantità non valida.", ephemeral: true });
      if (pg.gold < amount) return interaction.reply({ content: "Gold insufficienti.", ephemeral: true });

      const newGold = pg.gold - amount;
      const newBank = pg.bank + amount;

      await updateCharacterGold(pg.id, newGold);
      await updateCharacterBank(pg.id, newBank);

      return interaction.reply(`${user.username} - PG **${pg.name}**: Deposito di ${amount} effettuato. Gold: ${newGold}. Conto: ${newBank}`);
    }

    if (command === "prelievo") {
      if (!isGM) return interaction.reply({ content: "Solo il ruolo Gm-bot può usare questo comando.", ephemeral: true });

      const amount = interaction.options.getInteger("quantita");
      const user = interaction.options.getUser("giocatore");
      const name = interaction.options.getString("nome");

      const pg = await getCharacter(user.id, name);
      if (!pg) return interaction.reply({ content: "PG non trovato!", ephemeral: true });
      if (amount <= 0) return interaction.reply({ content: "Quantità non valida.", ephemeral: true });
      if (pg.bank < amount) return interaction.reply({ content: "Saldo conto insufficiente.", ephemeral: true });

      const newBank = pg.bank - amount;
      const newGold = pg.gold + amount;

      await updateCharacterBank(pg.id, newBank);
      await updateCharacterGold(pg.id, newGold);

      return interaction.reply(`${user.username} - PG **${pg.name}**: Prelievo di ${amount} effettuato. Gold: ${newGold}. Conto: ${newBank}`);
    }

    if (command === "versa") {
      if (!isGM) return interaction.reply({ content: "Solo il ruolo Gm-bot può usare questo comando.", ephemeral: true });

      const amount = interaction.options.getInteger("quantita");
      const note = interaction.options.getString("note");
      const user = interaction.options.getUser("giocatore");
      const name = interaction.options.getString("nome");

      const pg = await getCharacter(user.id, name);
      if (!pg) return interaction.reply({ content: "PG non trovato!", ephemeral: true });
      if (amount <= 0) return interaction.reply({ content: "Quantità non valida.", ephemeral: true });

      const before = pg.bank;
      const after = before + amount;

      await updateCharacterBank(pg.id, after);

      return interaction.reply(`${user.username} - PG **${pg.name}**: deposito bancario ${before} → ${after}. Versati **${amount}** oro. Nota: ${note}`);
    }

    if (command === "paga") {
      if (!isGM) return interaction.reply({ content: "Solo il ruolo Gm-bot può usare questo comando.", ephemeral: true });

      const amount = interaction.options.getInteger("quantita");
      const note = interaction.options.getString("note");
      const user = interaction.options.getUser("giocatore");
      const name = interaction.options.getString("nome");

      const pg = await getCharacter(user.id, name);
      if (!pg) return interaction.reply({ content: "PG non trovato!", ephemeral: true });
      if (amount <= 0) return interaction.reply({ content: "Quantità non valida.", ephemeral: true });
      if (pg.bank < amount) return interaction.reply({ content: "Fondi insufficienti nel deposito.", ephemeral: true });

      const before = pg.bank;
      const after = before - amount;

      await updateCharacterBank(pg.id, after);

      return interaction.reply(`${user.username} - PG **${pg.name}**: deposito bancario ${before} → ${after}. Pagati **${amount}** oro. Nota: ${note}`);
    }

    if (command === "scambio") {
      if (!isGM) return interaction.reply({ content: "Solo il ruolo Gm-bot può usare questo comando.", ephemeral: true });

      const amount = interaction.options.getInteger("quantita");
      const note = interaction.options.getString("note");

      const fromUser = interaction.options.getUser("da_giocatore");
      const fromName = interaction.options.getString("da_pg");

      const toUser = interaction.options.getUser("a_giocatore");
      const toName = interaction.options.getString("a_pg");

      const fromPg = await getCharacter(fromUser.id, fromName);
      const toPg = await getCharacter(toUser.id, toName);

      if (!fromPg) return interaction.reply({ content: "PG mittente non trovato.", ephemeral: true });
      if (!toPg) return interaction.reply({ content: "PG destinatario non trovato.", ephemeral: true });
      if (amount <= 0) return interaction.reply({ content: "Quantità non valida.", ephemeral: true });
      if (fromPg.id === toPg.id) return interaction.reply({ content: "Non puoi fare uno scambio verso lo stesso PG.", ephemeral: true });
      if (fromPg.bank < amount) return interaction.reply({ content: "Fondi insufficienti nel deposito del PG mittente.", ephemeral: true });

      await transferBankMoney(fromPg.id, toPg.id, amount);

      const updatedFrom = await getCharacterById(fromPg.id);
      const updatedTo = await getCharacterById(toPg.id);

      return interaction.reply(
        `💸 **Scambio completato**\n` +
        `Da: **${fromPg.name}** (${fromUser.username})\n` +
        `A: **${toPg.name}** (${toUser.username})\n` +
        `Quantità: **${amount}** oro\n` +
        `Deposito ${fromPg.name}: ${fromPg.bank} → ${updatedFrom.bank}\n` +
        `Deposito ${toPg.name}: ${toPg.bank} → ${updatedTo.bank}\n` +
        `Nota: ${note}`
      );
    }

    if (command === "aggiungi_item") {
      if (!isGM) return interaction.reply({ content: "Solo il ruolo Gm-bot può usare questo comando.", ephemeral: true });

      const raw = interaction.options.getString("items");
      const items = sanitizeItemsList(raw);
      const user = interaction.options.getUser("giocatore");
      const name = interaction.options.getString("nome");

      const pg = await getCharacter(user.id, name);
      if (!pg) return interaction.reply({ content: "PG non trovato!", ephemeral: true });
      if (!items.length) return interaction.reply({ content: "Nessun item valido fornito.", ephemeral: true });

      let sintonie = await getAttunements(pg.id);
      const addedItems = [];
      const addedSints = [];
      const skippedSints = [];

      for (const rawItem of items) {
        const hadTag = isSintonizedTag(rawItem);
        const clean = stripSintonizedTag(rawItem);
        const itemToStore = hadTag ? `${clean} [s]` : clean;

        await addInventoryItem(pg.id, itemToStore);
        addedItems.push(itemToStore);

        if (hadTag && !sintonie.includes(clean)) {
          if (sintonie.length >= 3) skippedSints.push(clean);
          else {
            await addAttunement(pg.id, clean);
            sintonie.push(clean);
            addedSints.push(clean);
          }
        }
      }

      let resp = `${user.username} - PG **${pg.name}**: Aggiunti item: ${addedItems.join(", ")}.`;
      if (addedSints.length) resp += ` Sintonie aggiunte: ${addedSints.join(", ")}.`;
      if (skippedSints.length) resp += ` Sintonie non aggiunte (limite 3): ${skippedSints.join(", ")}.`;

      return interaction.reply(resp);
    }

    if (command === "rimuovi_item") {
      if (!isGM) return interaction.reply({ content: "Solo il ruolo Gm-bot può usare questo comando.", ephemeral: true });

      const raw = interaction.options.getString("items");
      const items = sanitizeItemsList(raw);
      const user = interaction.options.getUser("giocatore");
      const name = interaction.options.getString("nome");

      const pg = await getCharacter(user.id, name);
      if (!pg) return interaction.reply({ content: "PG non trovato!", ephemeral: true });
      if (!items.length) return interaction.reply({ content: "Nessun item valido fornito.", ephemeral: true });

      let sintonie = await getAttunements(pg.id);
      const removed = [];
      const notFound = [];
      const removedSints = [];

      for (const rawIt of items) {
        const clean = stripSintonizedTag(rawIt);
        const deletedCount = await removeInventoryItemsByCleanName(pg.id, clean);

        if (deletedCount > 0) {
          removed.push(rawIt);
          if (sintonie.includes(clean)) {
            await clearAttunementByName(pg.id, clean);
            sintonie = sintonie.filter(s => s !== clean);
            removedSints.push(clean);
          }
        } else {
          notFound.push(rawIt);
        }
      }

      let msg = `${user.username} - PG **${pg.name}**: Rimosso: ${removed.length ? removed.join(", ") : "Nessuno"}.`;
      if (notFound.length) msg += ` Non trovati: ${notFound.join(", ")}.`;
      if (removedSints.length) msg += ` Sintonie rimosse: ${removedSints.join(", ")}.`;

      return interaction.reply(msg);
    }

    if (command === "aggiungi_sintonia") {
      if (!isGM) return interaction.reply({ content: "Solo il ruolo Gm-bot può usare questo comando.", ephemeral: true });

      const sintRaw = interaction.options.getString("nome_sintonia");
      const sint = stripSintonizedTag(sintRaw);
      const user = interaction.options.getUser("giocatore");
      const name = interaction.options.getString("nome");

      const pg = await getCharacter(user.id, name);
      if (!pg) return interaction.reply({ content: "PG non trovato!", ephemeral: true });

      let sintonie = await getAttunements(pg.id);

      if (sintonie.length >= 3) return interaction.reply({ content: "Impossibile: massimo 3 sintonie raggiunto.", ephemeral: true });
      if (sintonie.includes(sint)) return interaction.reply({ content: "Questa sintonia è già presente.", ephemeral: true });

      await addAttunement(pg.id, sint);

      const inv = await getInventory(pg.id);
      const inventoryHas = inv.some(i => stripSintonizedTag(i) === sint);

      if (!inventoryHas) await addInventoryItem(pg.id, `${sint} [s]`);

      return interaction.reply(`${user.username} - PG **${pg.name}**: Aggiunta sintonia: ${sint}.`);
    }

    if (command === "rimuovi_sintonia") {
      if (!isGM) return interaction.reply({ content: "Solo il ruolo Gm-bot può usare questo comando.", ephemeral: true });

      const sintRaw = interaction.options.getString("nome_sintonia");
      const sint = stripSintonizedTag(sintRaw);
      const user = interaction.options.getUser("giocatore");
      const name = interaction.options.getString("nome");

      const pg = await getCharacter(user.id, name);
      if (!pg) return interaction.reply({ content: "PG non trovato!", ephemeral: true });

      let sintonie = await getAttunements(pg.id);

      if (!sintonie.length) return interaction.reply({ content: "Nessuna sintonia da rimuovere.", ephemeral: true });
      if (!sintonie.includes(sint)) return interaction.reply({ content: "Questa sintonia non è presente sul PG.", ephemeral: true });

      await clearAttunementByName(pg.id, sint);
      await removeInventoryItemsByCleanName(pg.id, sint);

      return interaction.reply(`${user.username} - PG **${pg.name}**: Rimossa sintonia: ${sint}.`);
    }

    if (command === "elimina_pg") {
      if (!isGM) return interaction.reply({ content: "Solo il ruolo Gm-bot può usare questo comando.", ephemeral: true });

      const name = interaction.options.getString("nome");
      const matches = await getCharactersByName(name);

      if (!matches.length) {
        return interaction.reply({ content: `Nessun PG trovato con nome **${name}**.`, ephemeral: true });
      }

      if (matches.length > 1) {
        const elenco = matches
          .map(pg => `ID ${pg.id} — **${pg.name}** — Player ID: ${pg.playerId}`)
          .join("\n");

        return interaction.reply({
          content:
            `Ho trovato più PG chiamati **${name}**.\n` +
            `Per sicurezza non elimino nulla.\n\n${elenco}`,
          ephemeral: true
        });
      }

      const pg = matches[0];
      await deleteCharacterAndData(pg.id);

      const remaining = await listCharacters(pg.playerId);
      if (remaining.length === 0) {
        await db.run("DELETE FROM players WHERE id = ?", pg.playerId);
      }

      return interaction.reply({
        content: `PG **${pg.name}** eliminato. Player ID precedente: ${pg.playerId}`,
        ephemeral: false
      });
    }

    if (command === "reset") {
      if (!isGM) return interaction.reply({ content: "Solo il ruolo Gm-bot può usare questo comando.", ephemeral: true });

      const conferma = interaction.options.getString("conferma");

      if (conferma !== "RESET") {
        return interaction.reply({
          content: "Per confermare devi scrivere esattamente `RESET` nel campo conferma.",
          ephemeral: true
        });
      }

      await resetAllCharacters();

      return interaction.reply({
        content: "💥 Reset completato. Tutte le schede, inventari, sintonie e farm giornalieri sono stati eliminati.",
        ephemeral: false
      });
    }

    if (command === "rinomina_pg") {
      if (!isGM) return interaction.reply({ content: "Solo il ruolo Gm-bot può usare questo comando.", ephemeral: true });

      const user = interaction.options.getUser("giocatore");
      const oldName = interaction.options.getString("vecchio_nome");
      const newName = interaction.options.getString("nuovo_nome");

      const pg = await getCharacter(user.id, oldName);
      if (!pg) return interaction.reply({ content: "PG non trovato!", ephemeral: true });

      await renameCharacter(pg.id, newName);

      return interaction.reply({ content: `PG **${oldName}** rinominato in **${newName}**.`, ephemeral: false });
    }

    if (command === "lista_pg") {
      const user = interaction.options.getUser("giocatore");
      const chars = await listCharacters(user.id);

      const list = chars.map(p =>
        `${p.name} — Lv. ${p.level}, Comp. +${getProficiencyBonus(p.level)}, Deposito: ${p.bank}`
      );

      return interaction.reply({
        content: `PG di ${user.username}:\n${list.length ? list.join("\n") : "Nessuno"}`,
        ephemeral: false
      });
    }
  } catch (error) {
    console.error(`Errore comando /${interaction.commandName}:`, error);

    const risposta = {
      content: "❌ Errore interno del bot. Controlla i log Railway.",
      ephemeral: true
    };

    if (interaction.replied || interaction.deferred) {
      await interaction.followUp(risposta);
    } else {
      await interaction.reply(risposta);
    }
  }
});

process.on("unhandledRejection", error => {
  console.error("Unhandled promise rejection:", error);
});

process.on("uncaughtException", error => {
  console.error("Uncaught exception:", error);
});

client.login(token);
