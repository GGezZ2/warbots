import { AsyncLocalStorage } from "node:async_hooks"
import { randomUUID } from "node:crypto"
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
  TextInputStyle,
} from "discord.js"
import dotenv from "dotenv"
import fs from "fs"
import path from "path"
import sqlite3 from "sqlite3"
import { open } from "sqlite"
import { DateTime } from "luxon"
import { fileURLToPath } from "url"
dotenv.config()
const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const TOKEN = process.env.GIACOMO_TOKEN?.trim() || process.env.TOKEN?.trim()
const CLIENT_ID =
  process.env.GIACOMO_CLIENT_ID?.trim() || process.env.CLIENT_ID?.trim()
const GUILD_ID = process.env.GUILD_ID?.trim()
const DB_PATH =
  process.env.WESTMARCH_DB_PATH || process.env.DB_PATH || "/data/westmarch.db"
const MINIERE_FILE =
  process.env.MINIERE_FILE_PATH?.trim() ||
  process.env.MINIERE_FILE?.trim() ||
  (fs.existsSync(path.join(__dirname, "data", "miniere.json")) ?
    path.join(__dirname, "data", "miniere.json")
  : path.join(__dirname, "miniere.json"))
const CRAFT_CHANNEL_ID = process.env.CRAFT_CHANNEL_ID?.trim() || ""
const BETA_ROLE_NAME = process.env.BETA_ROLE_NAME?.trim() || "Beta"
const CRAFT_CONTROL_ROLE_NAME =
  process.env.CRAFT_CONTROL_ROLE_NAME?.trim() || "Craft Control"
const BETA_ROLE_ID = process.env.BETA_ROLE_ID?.trim() || ""
const CRAFT_CONTROL_ROLE_ID = process.env.CRAFT_CONTROL_ROLE_ID?.trim() || ""
const TIMEZONE = process.env.TIMEZONE?.trim() || "Europe/Rome"
const CHECK_INTERVAL_MS = Number(process.env.CRAFT_CHECK_INTERVAL_MS || 60000)
const MAX_ROLL_DAYS = Number(process.env.MAX_CRAFT_ROLL_DAYS || 365)
if (!TOKEN || !CLIENT_ID || !GUILD_ID) {
  console.error(
    "Mancano variabili Railway. Servono GIACOMO_TOKEN/TOKEN, GIACOMO_CLIENT_ID/CLIENT_ID e GUILD_ID.",
  )
  process.exit(1)
}
let db
// Calendario condiviso Giacomo/Grummi, versione 1. Richiede lo STESSO file SQLite.
// Copia identica nei due index: nessuna dipendenza aggiuntiva da installare.
const activityContext = new AsyncLocalStorage()
function activityDatabase(connection) {
  return new Proxy(connection, {
    get(target, property) {
      const selected = activityContext.getStore() || target
      const value = Reflect.get(selected, property, selected)
      return typeof value === "function" ? value.bind(selected) : value
    },
  })
}
// Evita che numerosi BEGIN in attesa saturino i worker SQLite nello stesso
// processo. Tra processi distinti l'esclusione resta garantita da SQLite.
const activityQueues = globalThis[Symbol.for("westmarch.activity.queues")] ||= new Map()
async function activityTransaction(action) {
  const existing = activityContext.getStore()
  if (existing) return action(existing)
  const key = path.resolve(DB_PATH)
  const previous = activityQueues.get(key) || Promise.resolve()
  let release
  const turn = new Promise((resolve) => { release = resolve })
  activityQueues.set(key, turn)
  await previous
  try {
    const tx = await open({ filename: DB_PATH, driver: sqlite3.Database })
    try {
      await tx.exec("PRAGMA busy_timeout = 15000")
      await tx.exec("BEGIN IMMEDIATE")
      try {
        const result = await activityContext.run(tx, () => action(tx))
        await tx.exec("COMMIT")
        return result
      } catch (error) {
        await tx.exec("ROLLBACK")
        throw error
      }
    } finally { await tx.close() }
  } finally {
    release()
    if (activityQueues.get(key) === turn) activityQueues.delete(key)
  }
}
function activityDay(value = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Rome", year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(new Date(value))
  return ["year", "month", "day"].map((key) => parts.find((p) => p.type === key).value).join("-")
}
function activityAddDays(day, count) {
  const date = new Date(`${day}T12:00:00Z`)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== day) {
    throw new Error("Data calendario non valida: usa YYYY-MM-DD.")
  }
  date.setUTCDate(date.getUTCDate() + count)
  return date.toISOString().slice(0, 10)
}
function activityDueISO(day) {
  // Alle 16:30 italiane anche nei giorni del cambio di ora legale.
  const noon = new Date(`${activityAddDays(day, 0)}T12:00:00Z`)
  const hourInRome = Number(new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/Rome", hour: "2-digit", hourCycle: "h23",
  }).format(noon))
  noon.setUTCHours(16 - (hourInRome - 12), 30, 0, 0)
  return noon.toISOString()
}
async function markActivityImported(tx, source) {
  await tx.run("INSERT OR IGNORE INTO activity_imports(source, importedAt) VALUES (?, ?)", source, new Date().toISOString())
}
async function reserveActivityDays(tx, participants, startDay, kind, operationId, label) {
  if (!activityContext.getStore()) throw new Error("Prenotazione fuori transazione.")
  activityAddDays(startDay, 0)
  const results = []
  for (const person of participants) {
    if (!Number.isInteger(person.days) || person.days < 1 || person.days > 3650) throw new Error("Numero di giornate non valido.")
    const dates = []
    for (let offset = 0; offset < 36500 && dates.length < person.days; offset++) {
      const day = activityAddDays(startDay, offset)
      const taken = await tx.get("SELECT 1 FROM activity_days WHERE characterId = ? AND day = ?", person.id, day)
      if (taken) continue
      await tx.run(`INSERT INTO activity_days(characterId, day, kind, operationId, label, createdAt)
        VALUES (?, ?, ?, ?, ?, ?)`, person.id, day, kind, operationId, String(label).slice(0, 300), new Date().toISOString())
      dates.push(day)
    }
    if (dates.length !== person.days) throw new Error("Non ci sono abbastanza giorni liberi nel calendario.")
    results.push({ id: person.id, dates })
  }
  return { participants: results, lastDay: results.map((p) => p.dates.at(-1)).sort().at(-1) }
}
async function initActivityCalendar() {
  await activityTransaction(async (tx) => {
    await tx.exec(`
      CREATE TABLE IF NOT EXISTS activity_days (
        characterId INTEGER NOT NULL, day TEXT NOT NULL,
        kind TEXT NOT NULL, operationId TEXT NOT NULL,
        label TEXT NOT NULL DEFAULT '', createdAt TEXT NOT NULL,
        PRIMARY KEY(characterId, day)
      );
      CREATE INDEX IF NOT EXISTS activity_days_operation ON activity_days(operationId);
      CREATE TABLE IF NOT EXISTS activity_imports (source TEXT PRIMARY KEY, importedAt TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS activity_migration_notes (
        source TEXT NOT NULL, note TEXT NOT NULL, createdAt TEXT NOT NULL,
        UNIQUE(source, note)
      );
      CREATE TABLE IF NOT EXISTS farm_days (
        id INTEGER PRIMARY KEY AUTOINCREMENT, characterId INTEGER NOT NULL,
        farmDate TEXT NOT NULL, createdAt TEXT NOT NULL,
        UNIQUE(characterId, farmDate)
      );
      INSERT OR IGNORE INTO activity_days(characterId, day, kind, operationId, label, createdAt)
        SELECT characterId, farmDate, 'farm', 'farm:' || id, 'Farming', createdAt FROM farm_days;
      CREATE TRIGGER IF NOT EXISTS activity_farm_insert AFTER INSERT ON farm_days BEGIN
        INSERT INTO activity_days(characterId, day, kind, operationId, label, createdAt)
          VALUES (NEW.characterId, NEW.farmDate, 'farm', 'farm:' || NEW.id, 'Farming', NEW.createdAt);
      END;
      CREATE TRIGGER IF NOT EXISTS activity_farm_delete AFTER DELETE ON farm_days BEGIN
        DELETE FROM activity_days WHERE operationId = 'farm:' || OLD.id AND kind = 'farm';
      END;
      CREATE TRIGGER IF NOT EXISTS activity_farm_update AFTER UPDATE OF characterId, farmDate ON farm_days BEGIN
        DELETE FROM activity_days WHERE operationId = 'farm:' || OLD.id AND kind = 'farm';
        INSERT INTO activity_days(characterId, day, kind, operationId, label, createdAt)
          VALUES (NEW.characterId, NEW.farmDate, 'farm', 'farm:' || NEW.id, 'Farming', NEW.createdAt);
      END;
    `)
    await syncLegacyActivities(tx)
  })
}
async function activityMigrationNote(tx, source, note) {
  await tx.run("INSERT OR IGNORE INTO activity_migration_notes(source, note, createdAt) VALUES (?, ?, ?)", source, note, new Date().toISOString())
  console.warn(`[Calendario ${source}] ${note}`)
}
async function importLegacySchedule(tx, source, participants, start, kind, label, completed) {
  if (!completed) return reserveActivityDays(tx, participants, start, kind, source, label)
  // Lo storico già eseguito non può essere riscritto. Conserva le occupazioni
  // e segnala eventuali sovrapposizioni precedenti a questo aggiornamento.
  for (const p of participants) {
    for (let n = 0; n < p.days; n++) {
      const day = activityAddDays(start, n)
      const existing = await tx.get("SELECT * FROM activity_days WHERE characterId = ? AND day = ?", p.id, day)
      if (existing) await activityMigrationNote(tx, source, `Sovrapposizione storica PG #${p.id}, ${day}, con ${existing.operationId}. Nessuna ricompensa modificata.`)
      else await tx.run("INSERT INTO activity_days VALUES (?, ?, ?, ?, ?, ?)", p.id, day, kind, source, label, new Date().toISOString())
    }
  }
  return null
}
async function syncLegacyActivities(tx) {
  const tables = new Set((await tx.all("SELECT name FROM sqlite_master WHERE type = 'table'")).map((r) => r.name))
  if (tables.has("craft_pending")) {
    const rows = await tx.all(`SELECT c.* FROM craft_pending c WHERE NOT EXISTS
      (SELECT 1 FROM activity_imports a WHERE a.source = 'craft:' || c.id)
      ORDER BY (c.completedAt IS NULL), c.id`)
    for (const row of rows) {
      const source = `craft:${row.id}`
      const embed = JSON.parse(row.summary)
      const fields = embed.fields || []
      const primaryField = fields.find((f) => f.name === "Tiri" || f.name.startsWith("Tiri primario"))
      const count = Number(primaryField?.value.match(/(?:Completato in|Giorni:)\s*\*\*(\d+)/)?.[1])
      if (!Number.isInteger(count) || count < 1 || count > 3650) throw new Error(`Calendario: impossibile ricostruire i giorni del craft #${row.id}. Verificare il riepilogo prima di riavviare.`)
      const participants = [{ id: row.crafterCharacterId, days: count }]
      const secondaryField = fields.find((f) => f.name.startsWith("Tiri secondario — "))
      if (secondaryField) {
        const name = secondaryField.name.slice("Tiri secondario — ".length)
        const secondary = await tx.all("SELECT id FROM characters WHERE name = ?", name)
        const days = Number(secondaryField.value.match(/Giorni:\s*\*\*(\d+)/)?.[1])
        if (secondary.length !== 1 || !Number.isInteger(days) || days < 1 || days > 3650) {
          throw new Error(`Calendario: collaboratore ambiguo o mancante nel craft #${row.id} (${name}). Serve correggere lo storico prima di prenotare altre attività.`)
        }
        participants.push({ id: secondary[0].id, days })
      }
      const start = activityAddDays(activityDay(row.dueAt), 1 - Math.max(...participants.map((p) => p.days)))
      const schedule = await importLegacySchedule(tx, source, participants, start, "craft", row.itemName, !!row.completedAt)
      if (schedule) {
        const dueAt = activityDueISO(schedule.lastDay)
        const finish = fields.find((f) => f.name === "Fine craft")
        if (finish) finish.value = `${schedule.lastDay.split("-").reverse().join("/")} 16:30`
        fields.push({ name: "Calendario condiviso", value: schedule.participants.map((p) => `PG #${p.id}: ${p.dates[0]} → ${p.dates.at(-1)} (${p.dates.length} giorni di lavoro)`).join("\n") })
        await tx.run("UPDATE craft_pending SET dueAt = ?, summary = ? WHERE id = ?", dueAt, JSON.stringify(embed), row.id)
        if (activityDay(row.dueAt) !== schedule.lastDay) {
          await activityMigrationNote(tx, source, `Scadenza ripianificata: ${activityDay(row.dueAt)} → ${schedule.lastDay}; tiri e costi conservati.`)
        }
      }
      await markActivityImported(tx, source)
    }
  }
  if (tables.has("craft_reforges")) {
    const rows = await tx.all(`SELECT r.* FROM craft_reforges r WHERE r.status IN ('pending','completed')
      AND NOT EXISTS (SELECT 1 FROM activity_imports a WHERE a.source = 'reforge:' || r.id)
      ORDER BY (r.status = 'pending'), r.id`)
    for (const row of rows) {
      const source = `reforge:${row.id}`
      const rollData = JSON.parse(row.rollData)
      const days = rollData.rolls.length
      const schedule = await importLegacySchedule(tx, source, [{ id: row.crafterCharacterId, days }], row.startDate, "reforge", row.itemName, row.status === "completed")
      if (schedule) {
        rollData.rolls.forEach((r, i) => { r.date = schedule.participants[0].dates[i] })
        await tx.run("UPDATE craft_reforges SET dueAt = ?, rollData = ? WHERE id = ?", activityDueISO(schedule.lastDay), JSON.stringify(rollData), row.id)
        if (activityDay(row.dueAt) !== schedule.lastDay) await activityMigrationNote(tx, source, `Riforgiatura ripianificata al ${schedule.lastDay}; tiri e costi conservati.`)
      }
      await markActivityImported(tx, source)
    }
  }
}
async function activityTimeline(characterId, fromDay) {
  const rows = await db.all(`SELECT day, kind, label FROM activity_days
    WHERE characterId = ? AND day >= ? ORDER BY day LIMIT 13`, characterId, fromDay)
  const labels = { farm: "Farm", craft: "Craft", reforge: "Riforgiatura", manual: "Craft registrato dal CC" }
  return rows.length ? rows.slice(0, 12).map((r) => `${r.day.split("-").reverse().join("/")} — ${labels[r.kind] || r.kind}: ${r.label.slice(0, 35)}`).join("\n") + (rows.length > 12 ? "\n… altre giornate già prenotate." : "") : "Nessuna giornata prenotata da questa data."
}

let miniereCache = null
const pendingRecipeCreates = new Map()
const pendingRecipeEdits = new Map()
const client = new Client({ intents: [GatewayIntentBits.Guilds] })
const rest = new REST({ version: "10" }).setToken(TOKEN)
const TIPI_OGGETTO = ["Equipaggiamento", "Consumabile", "Munizione"]
const RARITA = ["Comune", "Non comune", "Raro"]
const CATALIZZATORI = [
  "Offensivo",
  "Difensivo",
  "Supporto",
  "Controllo",
  "Magia",
  "Utilità",
]
const CATALIZZATORI_CON_NO = [...CATALIZZATORI, "No"]
const SI_NO = ["Sì", "No"]
const CATALYST_COSTS = {
  comune: { equipaggiamento: 50, munizione: 7, consumabile: 15 },
  "non comune": { equipaggiamento: 100, munizione: 15, consumabile: 30 },
  raro: { equipaggiamento: 250, munizione: 50, consumabile: 70 },
}
const CRAFT_RULES = {
  comune: { cd: 4, successes: 1, materialRarity: null },
  "non comune": { cd: 9, successes: 2, materialRarity: "comuni" },
  raro: { cd: 13, successes: 4, materialRarity: "non_comuni" },
}
const CRAFT_SPECIALI_CATEGORIE = [
  "Bocchette da Vetraio",
  "Strumento migliorato",
  "Pergamena magica",
  "Spartito magico",
]

const CRAFT_SPECIALI_GRADI = [
  "Non comune",
  "Raro",
  "+1",
  "+2",
]

const COSTI_BOCCETTE_VETRAIO = {
  "non comune": 100,
  raro: 300,
}

const COSTI_STRUMENTI_MIGLIORATI = {
  "+1": 1000,
  "+2": 4000,
}

const COSTI_PERGAMENE_SPARTITI = {
  0: 15,
  1: 25,
  2: 150,
  3: 250,
  4: 500,
  5: 1000,
  6: 5000,
}
const GIACOMO_LINES = [
  "Ho fatto il lavoro. So che sembra magia, ma si chiama leggere le istruzioni.",
  "Archiviato. Un altro trionfo della burocrazia contro l'analfabetismo operativo.",
  "Procedura completata. Prego, cercate di non romperla subito.",
  "Fatto. Sorprendente cosa si ottiene quando qualcuno competente deve sistemare le vostre idee.",
  "Ecco. La prossima volta magari portate anche un modulo compilato decentemente. Sognare è gratis.",
]
const ERROR_LINES = [
  "No. Non per cattiveria: per igiene amministrativa.",
  "Richiesta respinta. Anche il caos ha degli standard.",
  "Impossibile. E non fare quella faccia, i numeri sono numeri.",
  "Non funziona così. Lo so, leggere le regole è faticoso.",
  "Operazione fallita. La realtà si è opposta, e stavolta ha ragione.",
]
function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)]
}
function norm(s) {
  return String(s || "")
    .trim()
    .toLowerCase()
}
function splitEmojiTags(value) {
  const raw = String(value || "")
    .replace(/\s+/g, "")
    .trim()
  if (!raw) return []
  const customEmojiRegex = /<a?:[^:>\s]+:\d+>/g
  const customEmojis = raw.match(customEmojiRegex) || []
  const rest = raw.replace(customEmojiRegex, "")
  const parts = [...customEmojis]
  try {
    if (typeof Intl !== "undefined" && Intl.Segmenter) {
      const segmenter = new Intl.Segmenter("it", { granularity: "grapheme" })
      for (const { segment } of segmenter.segment(rest)) {
        if (segment && /\p{Extended_Pictographic}/u.test(segment)) {
          parts.push(segment)
        }
      }
    } else {
      for (const char of Array.from(rest)) {
        if (char && /\p{Extended_Pictographic}/u.test(char)) {
          parts.push(char)
        }
      }
    }
  } catch {
    for (const char of Array.from(rest)) {
      if (char) parts.push(char)
    }
  }
  if (!parts.length && raw) parts.push(raw)
  return [...new Set(parts.map((x) => String(x || "").trim()).filter(Boolean))]
}
function cleanEmojiTags(s) {
  return splitEmojiTags(s)[0] || ""
}
function tagMatches(availableTags, requiredTag) {
  const required = cleanEmojiTags(requiredTag)
  if (!required) return true
  const available = splitEmojiTags(availableTags)
    .map(cleanEmojiTags)
    .filter(Boolean)
  return (
    available.includes(required) || cleanEmojiTags(availableTags) === required
  )
}
function yesNoBool(v) {
  return ["si", "sì", "yes", "true"].includes(norm(v))
}
function same(a, b) {
  return norm(a) === norm(b)
}
function hasRole(member, roleName, roleId = "") {
  try {
    if (roleId && member?.roles?.cache?.has(roleId)) return true
    return member?.roles?.cache?.some((r) => norm(r.name) === norm(roleName))
  } catch {
    return false
  }
}
function isCraftControl(member) {
  return hasRole(member, CRAFT_CONTROL_ROLE_NAME, CRAFT_CONTROL_ROLE_ID)
}
function isBeta(member) {
  return hasRole(member, BETA_ROLE_NAME, BETA_ROLE_ID) || isCraftControl(member)
}
function inCraftChannel(interaction) {
  return !CRAFT_CHANNEL_ID || interaction.channelId === CRAFT_CHANNEL_ID
}
function replyError(interaction, message, ephemeral = true) {
  const content = `🗂️ **Giacomo:** ${pick(ERROR_LINES)}\n${message}`
  return interaction.reply({ content, ephemeral })
}
function loadJSON(filepath, defaultVal = {}) {
  try {
    if (fs.existsSync(filepath)) {
      return JSON.parse(fs.readFileSync(filepath, "utf-8"))
    }
  } catch (err) {
    console.error(`Errore lettura ${filepath}:`, err.message)
  }
  return defaultVal
}
function loadMiniere() {
  if (!miniereCache) {
    miniereCache = loadJSON(MINIERE_FILE, {})
  }
  return miniereCache
}
function materialName(mat) {
  return typeof mat === "object" ? String(mat.nome || "") : String(mat || "")
}
function materialTags(mat) {
  return typeof mat === "object" ? String(mat.tags || "") : ""
}
function materialMestieri(mat) {
  return typeof mat === "object" && Array.isArray(mat.mestieri) ?
      mat.mestieri
    : []
}
function flattenMaterials() {
  const data = loadMiniere()
  const out = []
  for (const [miniera, blocco] of Object.entries(data)) {
    for (const rarityKey of ["comuni", "non_comuni"]) {
      const list = Array.isArray(blocco?.[rarityKey]) ? blocco[rarityKey] : []
      for (const mat of list) {
        const name = materialName(mat)
        if (!name) continue
        out.push({
          nome: name.toLowerCase(),
          display: name,
          miniera,
          rarityKey,
          tags: materialTags(mat),
          mestieri: materialMestieri(mat).map((x) => norm(x)),
        })
      }
    }
  }
  return out
}
function findMaterialMetadata(material) {
  const target = norm(material)
  return flattenMaterials().find((m) => norm(m.nome) === target) || null
}
function getAllMestieri() {
  return [
    ...new Set(
      flattenMaterials()
        .flatMap((m) => m.mestieri)
        .filter(Boolean),
    ),
  ].sort((a, b) => a.localeCompare(b, "it"))
}
function getAllTags() {
  return [
    ...new Set(
      flattenMaterials()
        .flatMap((m) => splitEmojiTags(m.tags))
        .filter(Boolean),
    ),
  ].sort()
}
function materialMatches({ meta, requiredRarity, mestiere, requiredTag }) {
  if (!meta) return false
  if (requiredRarity && meta.rarityKey !== requiredRarity) return false
  if (mestiere && !meta.mestieri.includes(norm(mestiere))) return false
  if (requiredTag && !tagMatches(meta.tags, requiredTag)) return false
  return true
}
async function initDB() {
  db = activityDatabase(await open({ filename: DB_PATH, driver: sqlite3.Database }))
  await db.exec("PRAGMA busy_timeout = 15000")
  await db.exec(
    ` CREATE TABLE IF NOT EXISTS players ( id TEXT PRIMARY KEY, name TEXT ); CREATE TABLE IF NOT EXISTS characters ( id INTEGER PRIMARY KEY AUTOINCREMENT, playerId TEXT NOT NULL, name TEXT NOT NULL, xp INTEGER NOT NULL DEFAULT 0, gold INTEGER NOT NULL DEFAULT 0, bank INTEGER NOT NULL DEFAULT 0, level INTEGER NOT NULL DEFAULT 1, FOREIGN KEY (playerId) REFERENCES players(id) ); CREATE TABLE IF NOT EXISTS inventory ( id INTEGER PRIMARY KEY AUTOINCREMENT, characterId INTEGER NOT NULL, item TEXT NOT NULL, FOREIGN KEY (characterId) REFERENCES characters(id) ); CREATE TABLE IF NOT EXISTS attunements ( id INTEGER PRIMARY KEY AUTOINCREMENT, characterId INTEGER NOT NULL, item TEXT NOT NULL, FOREIGN KEY (characterId) REFERENCES characters(id) ); CREATE TABLE IF NOT EXISTS materials_inventory ( id INTEGER PRIMARY KEY AUTOINCREMENT, characterId INTEGER NOT NULL, material TEXT NOT NULL, quantity INTEGER NOT NULL DEFAULT 0, UNIQUE(characterId, material), FOREIGN KEY (characterId) REFERENCES characters(id) ); CREATE TABLE IF NOT EXISTS fortresses ( characterId INTEGER PRIMARY KEY, name TEXT NOT NULL, level INTEGER NOT NULL DEFAULT 0, FOREIGN KEY (characterId) REFERENCES characters(id) ); CREATE TABLE IF NOT EXISTS recipes ( id INTEGER PRIMARY KEY AUTOINCREMENT, nomeOggetto TEXT NOT NULL UNIQUE, tipologiaOggetto TEXT NOT NULL, specificaTipologia TEXT NOT NULL DEFAULT '', sintonia INTEGER NOT NULL DEFAULT 0, rarita TEXT NOT NULL, mestiere TEXT NOT NULL, catalizzatore1 TEXT NOT NULL, catalizzatore2 TEXT NOT NULL DEFAULT 'No', materialeTag1 TEXT NOT NULL DEFAULT '', materialeTag2 TEXT NOT NULL DEFAULT '', effettoOggetto TEXT NOT NULL DEFAULT '', createdBy TEXT NOT NULL, createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL ); CREATE TABLE IF NOT EXISTS craft_pending ( id INTEGER PRIMARY KEY AUTOINCREMENT, userId TEXT NOT NULL, channelId TEXT NOT NULL, crafterCharacterId INTEGER NOT NULL, recipientCharacterId INTEGER NOT NULL, itemName TEXT NOT NULL, quantity INTEGER NOT NULL DEFAULT 1, attunement INTEGER NOT NULL DEFAULT 0, dueAt TEXT NOT NULL, summary TEXT NOT NULL, createdAt TEXT NOT NULL, completedAt TEXT ); `,
  )
  await initReforgingDB()
  if (TIMEZONE !== "Europe/Rome") throw new Error("Il calendario condiviso usa Europe/Rome: correggere TIMEZONE in entrambi i bot.")
  await initActivityCalendar()
  console.log(`SQLite Giacomo collegato a: ${DB_PATH}`)
  console.log(`File miniere/tag usato: ${MINIERE_FILE}`)
}
function getProficiencyBonus(level) {
  const l = Number(level || 1)
  if (l >= 17) return 6
  if (l >= 13) return 5
  if (l >= 9) return 4
  if (l >= 5) return 3
  return 2
}
async function getCharactersByOwner(userId) {
  return db.all(
    "SELECT * FROM characters WHERE playerId = ? ORDER BY name ASC",
    userId,
  )
}
async function getAllCharacters() {
  return db.all("SELECT * FROM characters ORDER BY name ASC")
}
async function getCharacter(id) {
  return db.get("SELECT * FROM characters WHERE id = ?", id)
}
async function getFortress(characterId) {
  return db.get(
    "SELECT name, level FROM fortresses WHERE characterId = ?",
    characterId,
  )
}
async function getMaterialsInventory(characterId) {
  return db.all(
    "SELECT material, quantity FROM materials_inventory WHERE characterId = ? AND quantity > 0 ORDER BY material ASC",
    characterId,
  )
}
async function removeMaterial(characterId, material, qty) {
  const row = await db.get(
    "SELECT quantity FROM materials_inventory WHERE characterId = ? AND lower(material) = lower(?)",
    characterId,
    material,
  )
  if (!row || row.quantity < qty) return false
  const left = row.quantity - qty
  if (left <= 0) {
    await db.run(
      "DELETE FROM materials_inventory WHERE characterId = ? AND lower(material) = lower(?)",
      characterId,
      material,
    )
  } else {
    await db.run(
      "UPDATE materials_inventory SET quantity = ? WHERE characterId = ? AND lower(material) = lower(?)",
      left,
      characterId,
      material,
    )
  }
  return true
}
async function chargeGold(characterId, amount) {
  const pg = await getCharacter(characterId)
  if (!pg) return { ok: false, reason: "PG non trovato." }
  const gold = Number(pg.gold || 0)
  const bank = Number(pg.bank || 0)
  if (gold + bank < amount) {
    return {
      ok: false,
      reason: `Fondi insufficienti: servono ${amount} MO, ma ${pg.name} ha ${gold} in tasca e ${bank} in banca.`,
    }
  }
  const fromGold = Math.min(gold, amount)
  const fromBank = amount - fromGold
  await db.run(
    "UPDATE characters SET gold = ?, bank = ? WHERE id = ?",
    gold - fromGold,
    bank - fromBank,
    characterId,
  )
  return { ok: true, fromGold, fromBank }
}
async function addGoldToBank(characterId, amount) {
  const value = Number(amount || 0)
  if (value <= 0) return
  await db.run(
    "UPDATE characters SET bank = bank + ? WHERE id = ?",
    value,
    characterId,
  )
}
async function addFinishedItem(characterId, itemName, quantity, attunement) {
  const display = quantity > 1 ? `${quantity}x ${itemName}` : itemName
  await db.run(
    "INSERT INTO inventory (characterId, item) VALUES (?, ?)",
    characterId,
    display,
  )
  if (attunement) {
    await db.run(
      "INSERT INTO attunements (characterId, item) VALUES (?, ?)",
      characterId,
      display,
    )
  }
  return display
}
function catalystCost(rarita, tipologia, hasSecond) {
  const r = norm(rarita)
  const t = norm(tipologia)
  const base = CATALYST_COSTS[r]?.[t]
  if (base == null) {
    throw new Error(
      `Costo catalizzatore non configurato per ${rarita}/${tipologia}`,
    )
  }
  return base * (hasSecond ? 2 : 1)
}
function parseStartDate(value) {
  const dt = DateTime.fromFormat(String(value || ""), "yyyy-MM-dd", {
    zone: TIMEZONE,
  })
  if (!dt.isValid) return null
  return dt.startOf("day")
}
function dueAtFor(startDt, days) {
  return startDt
    .plus({ days: Math.max(0, days - 1) })
    .set({ hour: 16, minute: 30, second: 0, millisecond: 0 })
}
function safeInteger(value, min = 0, max = 1000000) {
  const n = Number(value || 0)
  if (!Number.isFinite(n)) return min
  return Math.max(min, Math.min(max, Math.trunc(n)))
}
function rollCraft(
  crafter,
  fortressLevel,
  rarita,
  extraBonus = 0,
  requiredSuccessesOverride = null,
) {
  const rules = CRAFT_RULES[norm(rarita)]
  if (!rules) throw new Error(`Rarità non valida: ${rarita}`)
  const prof = getProficiencyBonus(crafter.level)
  const fort = Number(fortressLevel || 0)
  const bonus = safeInteger(extraBonus, 0, 1000)
  const required = Number(requiredSuccessesOverride || rules.successes)
  let successes = 0
  let failuresForAuto = 0
  const rolls = []
  for (let day = 1; day <= MAX_ROLL_DAYS && successes < required; day++) {
    const d10 = Math.floor(Math.random() * 10) + 1
    const total = d10 + prof + fort + bonus
    const success = total >= rules.cd
    let autoSuccess = false
    if (success) {
      successes++
    } else {
      failuresForAuto++
      if (failuresForAuto >= 5) {
        successes++
        autoSuccess = true
        failuresForAuto = 0
      }
    }
    rolls.push({
      day,
      d10,
      prof,
      fort,
      bonus,
      total,
      success,
      autoSuccess,
      failuresForAuto,
      successes,
    })
  }
  if (successes < required) {
    throw new Error(
      "Limite massimo di giorni raggiunto. Il dado è evidentemente in sciopero.",
    )
  }
  return { rolls, successes, required, cd: rules.cd, prof, fort, bonus }
}
function rollFormula(r) {
  const parts = [`${r.d10}`, `${r.prof}`, `${r.fort}`]
  if (r.bonus) parts.push(`${r.bonus}`)
  return `${parts.join(" + ")} = ${r.total}`
}
function rollResultText(r) {
  if (r.success) return "✅ successo"
  if (r.autoSuccess)
    return "❌ fallimento → ✅ successo automatico da 5 fallimenti"
  return `❌ fallimento${r.failuresForAuto ? ` (${r.failuresForAuto}/5)` : ""}`
}
function rollsSummary(rollData) {
  return rollData.rolls
    .map((r) => `Giorno ${r.day}${r.date ? ` (${r.date.split("-").reverse().join("/")})` : ""}: ${rollFormula(r)} ${rollResultText(r)}`)
    .join("\n")
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
  recipeName = "",
}) {
  const fields = [
    { name: "Crafter", value: crafter.name, inline: true },
    { name: "Destinatario", value: recipient.name, inline: true },
    {
      name: "Oggetto",
      value: `${quantity}x ${recipeName || itemDisplay.replace(/^\d+x /, "")}`,
      inline: true,
    },
    {
      name: "Rarità / Tipologia",
      value: `${rarita} / ${tipologia}`,
      inline: true,
    },
    {
      name: "Costo catalizzatori",
      value: `${cost} MO (${charge.fromGold} tasca, ${charge.fromBank} banca)`,
      inline: true,
    },
    { name: "Materiali", value: materialsText || "Nessuno", inline: false },
  ]
  if (rollData.bonus) {
    fields.push({
      name: "Bonus extra",
      value: `+${rollData.bonus}`,
      inline: true,
    })
  }
  fields.push(
    {
      name: "Tiri",
      value: `CD ${rollData.cd}, successi ${rollData.required}. Completato in **${rollData.rolls.length} giorni di lavoro**.\n\n${rollsSummary(rollData).slice(0, 900)}`,
      inline: false,
    },
    {
      name: "Fine craft",
      value: dueAt.setZone(TIMEZONE).toFormat("dd/LL/yyyy HH:mm"),
      inline: true,
    },
  )
  return new EmbedBuilder()
    .setTitle("🧾 Craft completato")
    .setDescription(
      `${pick(GIACOMO_LINES)}\n\n<@${userId}>, **${itemDisplay}** è pronto. Cercate di non rovinarlo entro sera.`,
    )
    .addFields(...fields)
    .setColor(0x8b5cf6)
    .setFooter({
      text: "Giacomo, il segretario del CC — la burocrazia col ghigno.",
    })
}
function combinedCompletionEmbed({
  userId,
  primaryCrafter,
  secondaryCrafter,
  recipient,
  itemDisplay,
  quantity,
  rarita,
  tipologia,
  cost,
  totalCharge,
  charge,
  payment,
  primaryRollData,
  secondaryRollData,
  dueAt,
  materialsText,
  recipeName = "",
}) {
  const fields = [
    {
      name: "Crafters",
      value: `Primario: **${primaryCrafter.name}**\nSecondario: **${secondaryCrafter.name}**`,
      inline: true,
    },
    { name: "Destinatario", value: recipient.name, inline: true },
    {
      name: "Oggetto",
      value: `${quantity}x ${recipeName || itemDisplay.replace(/^\d+x /, "")}`,
      inline: true,
    },
    {
      name: "Rarità / Tipologia",
      value: `${rarita} / ${tipologia}`,
      inline: true,
    },
    {
      name: "Costo e pagamento",
      value: `Costo craft: ${cost} MO\nPagamento secondario: ${payment} MO\nTotale addebitato al primario: ${totalCharge} MO (${charge.fromGold} tasca, ${charge.fromBank} banca)`,
      inline: false,
    },
    { name: "Materiali", value: materialsText || "Nessuno", inline: false },
    {
      name: `Tiri primario — ${primaryCrafter.name}`,
      value: `CD ${primaryRollData.cd}, successi richiesti ${primaryRollData.required}. Giorni: **${primaryRollData.rolls.length}**.\n\n${rollsSummary(primaryRollData).slice(0, 900)}`,
      inline: false,
    },
    {
      name: `Tiri secondario — ${secondaryCrafter.name}`,
      value: `CD ${secondaryRollData.cd}, successi richiesti ${secondaryRollData.required}. Giorni: **${secondaryRollData.rolls.length}**.\n\n${rollsSummary(secondaryRollData).slice(0, 900)}`,
      inline: false,
    },
    {
      name: "Fine craft",
      value: dueAt.setZone(TIMEZONE).toFormat("dd/LL/yyyy HH:mm"),
      inline: true,
    },
  ]
  return new EmbedBuilder()
    .setTitle("🧾 Craft combinato completato")
    .setDescription(
      `${pick(GIACOMO_LINES)}\n\n<@${userId}>, **${itemDisplay}** è pronto. Due firme sul modulo, il doppio della responsabilità.`,
    )
    .addFields(...fields)
    .setColor(0x8b5cf6)
    .setFooter({
      text: "Giacomo, il segretario del CC — cooperazione registrata, miracolo annotato.",
    })
}
function recipeEmbed(recipe) {
  return new EmbedBuilder()
    .setTitle(`📜 ${recipe.nomeOggetto}`)
    .setDescription(
      recipe.effettoOggetto || "Nessun effetto indicato. Sobrio. O pigro.",
    )
    .addFields(
      {
        name: "Tipologia",
        value: `${recipe.tipologiaOggetto}${recipe.specificaTipologia ? ` — ${recipe.specificaTipologia}` : ""}`,
        inline: true,
      },
      { name: "Rarità", value: recipe.rarita, inline: true },
      { name: "Sintonia", value: recipe.sintonia ? "Sì" : "No", inline: true },
      { name: "Mestiere", value: recipe.mestiere, inline: true },
      {
        name: "Catalizzatori",
        value: `${recipe.catalizzatore1}${recipe.catalizzatore2 && recipe.catalizzatore2 !== "No" ? ` + ${recipe.catalizzatore2}` : ""}`,
        inline: true,
      },
      {
        name: "Tag materiali",
        value: `${recipe.materialeTag1 || "—"} / ${recipe.materialeTag2 || "—"}`,
        inline: true,
      },
    )
    .setColor(0xf59e0b)
    .setFooter({
      text: "Archivio ricette CC — niente occhi indiscreti, grazie.",
    })
}
async function completePendingCraft(row) {
  const completed = await activityTransaction(async () => {
    const current = await db.get("SELECT * FROM craft_pending WHERE id = ?", row.id)
    if (!current || current.completedAt || current.dueAt > DateTime.utc().toISO()) return null
    const recipient = await getCharacter(current.recipientCharacterId)
    const crafter = await getCharacter(current.crafterCharacterId)
    if (!recipient || !crafter) {
      await db.run("UPDATE craft_pending SET completedAt = ? WHERE id = ?", DateTime.utc().toISO(), current.id)
      return null
    }
    const itemDisplay = await addFinishedItem(recipient.id, current.itemName, current.quantity, !!current.attunement)
    await db.run("UPDATE craft_pending SET completedAt = ? WHERE id = ?", DateTime.utc().toISO(), current.id)
    return { current, recipient, itemDisplay }
  })
  if (!completed) return
  const { current, recipient, itemDisplay } = completed
  const channel = await client.channels.fetch(current.channelId).catch(() => null)
  if (channel?.isTextBased()) {
    const embed = EmbedBuilder.from(JSON.parse(current.summary))
    embed.setDescription(`${pick(GIACOMO_LINES)}\n\n<@${current.userId}>, **${itemDisplay}** è pronto e aggiunto all'inventario di **${recipient.name}**.`)
    await channel.send({ content: `<@${current.userId}>`, embeds: [embed] })
  }
}
async function checkPendingCrafts() {
  const now = DateTime.utc().toISO()
  const rows = await db.all(
    "SELECT * FROM craft_pending WHERE completedAt IS NULL AND dueAt <= ? ORDER BY dueAt ASC LIMIT 10",
    now,
  )
  for (const row of rows) {
    try {
      await completePendingCraft(row)
    } catch (err) {
      console.error("Errore completamento craft pending", row.id, err)
    }
  }
}
function buildNeededMaterials({
  rules,
  materiale1,
  materiale2,
  recipe = null,
}) {
  const neededMaterials = []
  if (rules.materialRarity) {
    neededMaterials.push({ name: materiale1, tag: recipe?.materialeTag1 || "" })
    neededMaterials.push({ name: materiale2, tag: recipe?.materialeTag2 || "" })
  }
  return neededMaterials
}
async function validateNeededMaterials(
  interaction,
  crafter,
  neededMaterials,
  rules,
  mestiere,
) {
  for (const needed of neededMaterials) {
    if (!needed.name) {
      await replyError(
        interaction,
        "Mancano i materiali. Dettaglio minuscolo, per craftare dal nulla.",
      )
      return false
    }
    const meta = findMaterialMetadata(needed.name)
if (
  !materialMatches({
    meta,
    requiredRarity: rules.materialRarity,
    mestiere: "",
    requiredTag: needed.tag,
  })
) {
      await replyError(
        interaction,
        `**${needed.name}** non è compatibile con rarità/mestiere${needed.tag ? `/tag ${needed.tag}` : ""}. Giacomo non falsifica ricevute.`,
      )
      return false
    }
  }
  if (
    neededMaterials.length === 2 &&
    same(neededMaterials[0].name, neededMaterials[1].name)
  ) {
    const row = await db.get(
      "SELECT quantity FROM materials_inventory WHERE characterId = ? AND lower(material) = lower(?)",
      crafter.id,
      neededMaterials[0].name,
    )
    if (!row || row.quantity < 2) {
      await replyError(
        interaction,
        `Servono 2x **${neededMaterials[0].name}**, ma non ci sono. Aritmetica crudele.`,
      )
      return false
    }
  } else {
    for (const needed of neededMaterials) {
      const row = await db.get(
        "SELECT quantity FROM materials_inventory WHERE characterId = ? AND lower(material) = lower(?)",
        crafter.id,
        needed.name,
      )
      if (!row || row.quantity < 1) {
        await replyError(
          interaction,
          `Manca **${needed.name}** nell'inventario materiali di **${crafter.name}**.`,
        )
        return false
      }
    }
  }
  return true
}
async function removeNeededMaterials(crafterId, neededMaterials) {
  for (const needed of neededMaterials) {
    await removeMaterial(crafterId, needed.name, 1)
  }
}
function materialSummary(neededMaterials) {
  return neededMaterials.length ?
      neededMaterials
        .map((m) => `1x ${m.name}${m.tag ? ` (${m.tag})` : ""}`)
        .join("\n")
    : "Nessuno"
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
  bonusExtra = 0,
  recipe = null,
}) {
  const crafter = await getCharacter(crafterId)
  const recipient = await getCharacter(recipientId)
  if (!crafter)
    return replyError(interaction, "Crafter non trovato. Già partiamo male.")
  if (!recipient)
    return replyError(
      interaction,
      "Destinatario non trovato. Devo consegnarlo all'aria?",
    )
  if (crafter.playerId !== interaction.user.id) {
    return replyError(
      interaction,
      "Puoi craftare solo con un tuo PG. Furto d'identità rimandato.",
    )
  }
  const rules = CRAFT_RULES[norm(rarita)]
  if (!rules) return replyError(interaction, "Rarità non valida.")
  const startDt = parseStartDate(startDate)
  if (!startDt) {
    return replyError(
      interaction,
      "Data non valida. Usa formato `YYYY-MM-DD`, non un presagio scritto male.",
    )
  }
  const hasSecond =
    norm(rarita) !== "comune" && catalizzatore2 && !same(catalizzatore2, "No")
  const extraCost = safeInteger(
    interaction.options.getInteger?.("costo_extra") || 0,
    0,
    1000000,
  )
  const cost = catalystCost(rarita, tipologia, hasSecond) + extraCost
  const bonus = safeInteger(bonusExtra, 0, 1000)
  const neededMaterials = buildNeededMaterials({
    rules,
    materiale1,
    materiale2,
    recipe,
  })
  const validMaterials = await validateNeededMaterials(
    interaction,
    crafter,
    neededMaterials,
    rules,
    mestiere,
  )
  if (!validMaterials) return
  const fortress = await getFortress(crafter.id)
  const rollData = rollCraft(crafter, fortress?.level || 0, rarita, bonus)
  const dueAt = await scheduleCraftWork(startDt, [{ crafter, rollData }], itemName)
  const charge = await chargeGold(crafter.id, cost)
  if (!charge.ok) return replyError(interaction, charge.reason)
  await removeNeededMaterials(crafter.id, neededMaterials)
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
    materialsText: materialSummary(neededMaterials),
    recipeName: recipe?.nomeOggetto || "",
  })
  const now = DateTime.now().setZone(TIMEZONE)
  if (dueAt <= now) {
    const display = await addFinishedItem(
      recipient.id,
      itemName,
      quantity,
      sintonia,
    )
    baseEmbed.setDescription(
      `${pick(GIACOMO_LINES)}\n\n<@${interaction.user.id}>, **${display}** era già pronto. Ho sistemato io, come al solito.`,
    )
    if (sintonia) {
      baseEmbed.addFields({
        name: "Sintonia",
        value: "Aggiunta al destinatario.",
        inline: true,
      })
    }
    return interaction.reply({
      content: `<@${interaction.user.id}>`,
      embeds: [baseEmbed],
    })
  }
  const savedCraft = await db.run(
    `INSERT INTO craft_pending ( userId, channelId, crafterCharacterId, recipientCharacterId, itemName, quantity, attunement, dueAt, summary, createdAt ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    interaction.user.id,
    interaction.channelId,
    crafter.id,
    recipient.id,
    itemName,
    quantity,
    sintonia ? 1 : 0,
    dueAt.toUTC().toISO(),
    JSON.stringify(baseEmbed.toJSON()),
    DateTime.utc().toISO(),
  )
  await markActivityImported(db, `craft:${savedCraft.lastID}`)
  const scheduledEmbed = EmbedBuilder.from(baseEmbed)
    .setTitle("🧾 Craft avviato")
    .setDescription(
      `${pick(GIACOMO_LINES)}\n\nCraft registrato. Ti menzionerò il **${dueAt.toFormat("dd/LL/yyyy alle HH:mm")}**. Cerca di sopravvivere fino ad allora.`,
    )
  return interaction.reply({ embeds: [scheduledEmbed] })
}
async function executeCombinedCraft({
  interaction,
  primaryCrafterId,
  secondaryCrafterId,
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
  bonusPrimary = 0,
  bonusSecondary = 0,
  secondaryPayment = 0,
  recipe = null,
}) {
  const primaryCrafter = await getCharacter(primaryCrafterId)
  const secondaryCrafter = await getCharacter(secondaryCrafterId)
  const recipient = await getCharacter(recipientId)
  if (!primaryCrafter)
    return replyError(
      interaction,
      "Crafter primario non trovato. Ottimo inizio, pessima esecuzione.",
    )
  if (!secondaryCrafter)
    return replyError(
      interaction,
      "Crafter secondario non trovato. Collaborazione immaginaria, capisco.",
    )
  if (!recipient)
    return replyError(
      interaction,
      "Destinatario non trovato. Devo consegnarlo all'aria?",
    )
  if (primaryCrafter.playerId !== interaction.user.id) {
    return replyError(
      interaction,
      "Il craft combinato deve essere avviato dal proprietario del crafter primario.",
    )
  }
  if (primaryCrafter.playerId === secondaryCrafter.playerId) {
    return replyError(
      interaction,
      "Il crafter secondario deve appartenere a un altro utente. Il multitasking non conta come collaborazione.",
    )
  }
  const rules = CRAFT_RULES[norm(rarita)]
  if (!rules) return replyError(interaction, "Rarità non valida.")
  if (rules.successes < 2) {
    return replyError(
      interaction,
      "Il craft combinato ha senso solo da Non comune in su: almeno 1 successo a testa, non mezzo modulo per uno.",
    )
  }
  const startDt = parseStartDate(startDate)
  if (!startDt) {
    return replyError(
      interaction,
      "Data non valida. Usa formato `YYYY-MM-DD`, non un presagio scritto male.",
    )
  }
  const hasSecond =
    norm(rarita) !== "comune" && catalizzatore2 && !same(catalizzatore2, "No")
  const extraCost = safeInteger(
    interaction.options.getInteger?.("costo_extra") || 0,
    0,
    1000000,
  )
  const cost = catalystCost(rarita, tipologia, hasSecond) + extraCost
  const payment = safeInteger(secondaryPayment, 0, 1000000)
  const totalCharge = cost + payment
  const neededMaterials = buildNeededMaterials({
    rules,
    materiale1,
    materiale2,
    recipe,
  })
  const validMaterials = await validateNeededMaterials(
    interaction,
    primaryCrafter,
    neededMaterials,
    rules,
    mestiere,
  )
  if (!validMaterials) return
  const primaryRequired = Math.ceil(rules.successes / 2)
  const secondaryRequired = rules.successes - primaryRequired
  const primaryFortress = await getFortress(primaryCrafter.id)
  const secondaryFortress = await getFortress(secondaryCrafter.id)
  const primaryRollData = rollCraft(
    primaryCrafter,
    primaryFortress?.level || 0,
    rarita,
    safeInteger(bonusPrimary, 0, 1000),
    primaryRequired,
  )
  const secondaryRollData = rollCraft(
    secondaryCrafter,
    secondaryFortress?.level || 0,
    rarita,
    safeInteger(bonusSecondary, 0, 1000),
    secondaryRequired,
  )
  const completionDays = Math.max(
    primaryRollData.rolls.length,
    secondaryRollData.rolls.length,
  )
  const dueAt = await scheduleCraftWork(startDt, [{ crafter: primaryCrafter, rollData: primaryRollData }, { crafter: secondaryCrafter, rollData: secondaryRollData }], itemName)
  const charge = await chargeGold(primaryCrafter.id, totalCharge)
  if (!charge.ok) return replyError(interaction, charge.reason)
  if (payment > 0) {
    await addGoldToBank(secondaryCrafter.id, payment)
  }
  await removeNeededMaterials(primaryCrafter.id, neededMaterials)
  const baseEmbed = combinedCompletionEmbed({
    userId: interaction.user.id,
    primaryCrafter,
    secondaryCrafter,
    recipient,
    itemDisplay: itemName,
    quantity,
    rarita,
    tipologia,
    cost,
    totalCharge,
    charge,
    payment,
    primaryRollData,
    secondaryRollData,
    dueAt,
    materialsText: materialSummary(neededMaterials),
    recipeName: recipe?.nomeOggetto || "",
  })
  const now = DateTime.now().setZone(TIMEZONE)
  if (dueAt <= now) {
    const display = await addFinishedItem(
      recipient.id,
      itemName,
      quantity,
      sintonia,
    )
    baseEmbed.setDescription(
      `${pick(GIACOMO_LINES)}\n\n<@${interaction.user.id}>, **${display}** era già pronto e aggiunto all'inventario di **${recipient.name}**.`,
    )
    if (sintonia) {
      baseEmbed.addFields({
        name: "Sintonia",
        value: "Aggiunta al destinatario.",
        inline: true,
      })
    }
    return interaction.reply({
      content: `<@${interaction.user.id}>`,
      embeds: [baseEmbed],
    })
  }
  const savedCraft = await db.run(
    `INSERT INTO craft_pending ( userId, channelId, crafterCharacterId, recipientCharacterId, itemName, quantity, attunement, dueAt, summary, createdAt ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    interaction.user.id,
    interaction.channelId,
    primaryCrafter.id,
    recipient.id,
    itemName,
    quantity,
    sintonia ? 1 : 0,
    dueAt.toUTC().toISO(),
    JSON.stringify(baseEmbed.toJSON()),
    DateTime.utc().toISO(),
  )
  await markActivityImported(db, `craft:${savedCraft.lastID}`)
  const scheduledEmbed = EmbedBuilder.from(baseEmbed)
    .setTitle("🧾 Craft combinato avviato")
    .setDescription(
      `${pick(GIACOMO_LINES)}\n\nCraft combinato registrato. Ti menzionerò il **${dueAt.toFormat("dd/LL/yyyy alle HH:mm")}**. Ho protocollato anche la responsabilità condivisa.`,
    )
  return interaction.reply({ embeds: [scheduledEmbed] })
}
function spellSpecialRarity(level) {
  const l = safeInteger(level, 0, 9)

  if (l <= 2) return "Comune"
  if (l <= 4) return "Non comune"
  if (l <= 6) return "Raro"

  return null
}

function buildSpecialCraftData({
  categoria,
  grado,
  livello,
  nomePersonalizzato,
}) {
  const cat = norm(categoria)
  const grade = norm(grado)
  const nome = String(nomePersonalizzato || "").trim()

  if (cat === norm("Bocchette da Vetraio")) {
    const cost = COSTI_BOCCETTE_VETRAIO[grade]

    if (cost == null) {
      return {
        ok: false,
        reason:
          "Per le bocchette da Vetraio puoi scegliere solo Non comune o Raro.",
      }
    }

    return {
      ok: true,
      itemName: nome || `Bocchette da Vetraio ${grado}`,
      quantity: 3,
      cost,
      rollRarity: grado,
      note:
        "Produce sempre 3 bocchette. Non consuma materiali né catalizzatori, ma richiede i normali tiri di craft.",
    }
  }

  if (cat === norm("Strumento migliorato")) {
    const cost = COSTI_STRUMENTI_MIGLIORATI[grado]

    if (cost == null) {
      return {
        ok: false,
        reason:
          "Per gli strumenti migliorati puoi scegliere solo +1 o +2. Gli strumenti +3 non sono ancora implementati.",
      }
    }

    const rollRarity =
      grado === "+1" ? "Non comune"
      : grado === "+2" ? "Raro"
      : null

    if (!rollRarity) {
      return {
        ok: false,
        reason:
          "Grado strumento non valido. Usa +1 o +2.",
      }
    }

    return {
      ok: true,
      itemName: nome || `Strumenti migliorati ${grado}`,
      quantity: 1,
      cost,
      rollRarity,
      note: `Craft richiesto: ${rollRarity}. Il bot non verifica la competenza nello specifico strumento.`,
    }
  }

  if (cat === norm("Pergamena magica") || cat === norm("Spartito magico")) {
    if (livello == null) {
      return {
        ok: false,
        reason:
          "Per pergamene e spartiti devi indicare il livello dell'incantesimo. Usa 0 per Cantrip.",
      }
    }

    const spellLevel = safeInteger(livello, 0, 9)
    const cost = COSTI_PERGAMENE_SPARTITI[spellLevel]

    if (cost == null) {
      return {
        ok: false,
        reason:
          "Pergamene e spartiti di livello 7, 8 e 9 non sono ancora implementati. Usa un livello da 0 a 6.",
      }
    }

    const rollRarity = spellSpecialRarity(spellLevel)

    if (!rollRarity) {
      return {
        ok: false,
        reason:
          "Rarità non configurata per questo livello. Usa un livello da 0 a 6.",
      }
    }

    const tipo =
      cat === norm("Pergamena magica") ? "Pergamena magica" : "Spartito magico"

    const livelloLabel = spellLevel === 0 ? "Cantrip" : `Livello ${spellLevel}`

    return {
      ok: true,
      itemName: nome || `${tipo} — ${livelloLabel}`,
      quantity: 1,
      cost,
      rollRarity,
      note:
        tipo === "Spartito magico"
          ? `Spartito magico di ${livelloLabel}. Rarità di craft: ${rollRarity}. Il livello massimo dipende dal Bonus di Competenza del Musicista.`
          : `Pergamena magica di ${livelloLabel}. Rarità di craft: ${rollRarity}.`,
    }
  }

  return {
    ok: false,
    reason: "Categoria di craft speciale non valida.",
  }
}

async function executeSpecialCraft(interaction) {
  const crafterId = extractId(interaction.options.getString("crafter"))
  const recipientId = extractId(interaction.options.getString("destinatario"))

  const crafter = await getCharacter(crafterId)
  const recipient = await getCharacter(recipientId)

  if (!crafter) {
    return replyError(
      interaction,
      "Crafter non trovato. Cominciamo benissimo.",
    )
  }

  if (!recipient) {
    return replyError(
      interaction,
      "Destinatario non trovato. Dove lo metto, nel vuoto?",
    )
  }

  if (crafter.playerId !== interaction.user.id) {
    return replyError(
      interaction,
      "Puoi usare come crafter solo un tuo PG. La falsificazione la lasciamo allo Scrivano.",
    )
  }

  const categoria = interaction.options.getString("categoria")
  const grado = interaction.options.getString("grado") || ""
  const livello = interaction.options.getInteger("livello")
  const nomePersonalizzato =
    interaction.options.getString("nome_personalizzato") || ""
  const startDate = interaction.options.getString("data_inizio")
  const bonusExtra = interaction.options.getInteger("bonus_extra") || 0

  const startDt = parseStartDate(startDate)

  if (!startDt) {
    return replyError(
      interaction,
      "Data non valida. Usa formato `YYYY-MM-DD`, non un appunto lasciato in taverna.",
    )
  }

  const data = buildSpecialCraftData({
    categoria,
    grado,
    livello,
    nomePersonalizzato,
  })

  if (!data.ok) {
    return replyError(interaction, data.reason)
  }

  const rules = CRAFT_RULES[norm(data.rollRarity)]

  if (!rules) {
    return replyError(
      interaction,
      `Rarità di tiro non configurata: **${data.rollRarity}**.`,
    )
  }

  const fortress = await getFortress(crafter.id)

  const rollData = rollCraft(
    crafter,
    fortress?.level || 0,
    data.rollRarity,
    bonusExtra,
  )

  const dueAt = await scheduleCraftWork(startDt, [{ crafter, rollData }], data.itemName)

  const charge = await chargeGold(crafter.id, data.cost)

  if (!charge.ok) return replyError(interaction, charge.reason)

  const baseEmbed = new EmbedBuilder()
    .setTitle("🧾 Craft speciale completato")
    .setDescription(
      `${pick(GIACOMO_LINES)}\n\n<@${interaction.user.id}>, **${data.itemName}** è pronto. Burocrazia speciale, dolore ordinario.`,
    )
    .addFields(
      { name: "Crafter", value: crafter.name, inline: true },
      { name: "Destinatario", value: recipient.name, inline: true },
      { name: "Categoria", value: categoria, inline: true },
      {
        name: "Oggetto",
        value: `${data.quantity}x ${data.itemName}`,
        inline: true,
      },
      {
        name: "Rarità di craft",
        value: data.rollRarity,
        inline: true,
      },
      {
        name: "Costo",
        value: `${data.cost} MO (${charge.fromGold} tasca, ${charge.fromBank} banca)`,
        inline: true,
      },
      {
        name: "Tiri",
        value: `CD ${rollData.cd}, successi ${rollData.required}. Completato in **${rollData.rolls.length} giorni di lavoro**.\n\n${rollsSummary(rollData).slice(0, 900)}`,
        inline: false,
      },
      {
        name: "Fine craft",
        value: dueAt.setZone(TIMEZONE).toFormat("dd/LL/yyyy HH:mm"),
        inline: true,
      },
      {
        name: "Nota speciale",
        value: data.note,
        inline: false,
      },
    )
    .setColor(0x38bdf8)
    .setFooter({
      text: "Giacomo, il segretario del CC — servizi speciali, contabilità ordinaria.",
    })

  const now = DateTime.now().setZone(TIMEZONE)

  if (dueAt <= now) {
    const display = await addFinishedItem(
      recipient.id,
      data.itemName,
      data.quantity,
      false,
    )

    baseEmbed.setDescription(
      `${pick(GIACOMO_LINES)}\n\n<@${interaction.user.id}>, **${display}** era già pronto ed è stato aggiunto all'inventario di **${recipient.name}**.`,
    )

    return interaction.reply({
      content: `<@${interaction.user.id}>`,
      embeds: [baseEmbed],
    })
  }

  const savedCraft = await db.run(
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
    data.itemName,
    data.quantity,
    0,
    dueAt.toUTC().toISO(),
    JSON.stringify(baseEmbed.toJSON()),
    DateTime.utc().toISO(),
  )

  await markActivityImported(db, `craft:${savedCraft.lastID}`)
  const scheduledEmbed = EmbedBuilder.from(baseEmbed)
    .setTitle("🧾 Craft speciale avviato")
    .setDescription(
      `${pick(GIACOMO_LINES)}\n\nCraft speciale registrato. Ti menzionerò il **${dueAt.toFormat("dd/LL/yyyy alle HH:mm")}**. Anche le pratiche speciali, purtroppo, richiedono lavoro.`,
    )

  return interaction.reply({ embeds: [scheduledEmbed] })
}
async function executeSpecialCombinedCraft(interaction) {
  const primaryCrafterId = extractId(
    interaction.options.getString("crafter_primario"),
  )
  const secondaryCrafterId = extractId(
    interaction.options.getString("crafter_secondario"),
  )
  const recipientId = extractId(interaction.options.getString("destinatario"))

  const primaryCrafter = await getCharacter(primaryCrafterId)
  const secondaryCrafter = await getCharacter(secondaryCrafterId)
  const recipient = await getCharacter(recipientId)

  if (!primaryCrafter) {
    return replyError(
      interaction,
      "Crafter primario non trovato. Ottimo inizio, pessima esecuzione.",
    )
  }

  if (!secondaryCrafter) {
    return replyError(
      interaction,
      "Crafter secondario non trovato. Collaborazione immaginaria, capisco.",
    )
  }

  if (!recipient) {
    return replyError(
      interaction,
      "Destinatario non trovato. Devo consegnarlo all'aria?",
    )
  }

  if (primaryCrafter.playerId !== interaction.user.id) {
    return replyError(
      interaction,
      "Il craft speciale combinato deve essere avviato dal proprietario del crafter primario.",
    )
  }

  if (primaryCrafter.playerId === secondaryCrafter.playerId) {
    return replyError(
      interaction,
      "Il crafter secondario deve appartenere a un altro utente. Il multitasking non conta come collaborazione.",
    )
  }

  const categoria = interaction.options.getString("categoria")
  const grado = interaction.options.getString("grado") || ""
  const livello = interaction.options.getInteger("livello")
  const nomePersonalizzato =
    interaction.options.getString("nome_personalizzato") || ""
  const startDate = interaction.options.getString("data_inizio")
  const bonusPrimary = interaction.options.getInteger("bonus_primario") || 0
  const bonusSecondary = interaction.options.getInteger("bonus_secondario") || 0
  const secondaryPayment =
    interaction.options.getInteger("pagamento_secondario") || 0

  const startDt = parseStartDate(startDate)

  if (!startDt) {
    return replyError(
      interaction,
      "Data non valida. Usa formato `YYYY-MM-DD`, non un appunto lasciato in taverna.",
    )
  }

  const data = buildSpecialCraftData({
    categoria,
    grado,
    livello,
    nomePersonalizzato,
  })

  if (!data.ok) {
    return replyError(interaction, data.reason)
  }

  const rules = CRAFT_RULES[norm(data.rollRarity)]

  if (!rules) {
    return replyError(
      interaction,
      `Rarità di tiro non configurata: **${data.rollRarity}**.`,
    )
  }

  if (rules.successes < 2) {
    return replyError(
      interaction,
      "Questo craft speciale è di rarità Comune e richiede 1 solo successo: non ha senso dividerlo in combinato.",
    )
  }

  const payment = safeInteger(secondaryPayment, 0, 1000000)
  const totalCharge = data.cost + payment

  const primaryRequired = Math.ceil(rules.successes / 2)
  const secondaryRequired = rules.successes - primaryRequired

  const primaryFortress = await getFortress(primaryCrafter.id)
  const secondaryFortress = await getFortress(secondaryCrafter.id)

  const primaryRollData = rollCraft(
    primaryCrafter,
    primaryFortress?.level || 0,
    data.rollRarity,
    safeInteger(bonusPrimary, 0, 1000),
    primaryRequired,
  )

  const secondaryRollData = rollCraft(
    secondaryCrafter,
    secondaryFortress?.level || 0,
    data.rollRarity,
    safeInteger(bonusSecondary, 0, 1000),
    secondaryRequired,
  )

  const completionDays = Math.max(
    primaryRollData.rolls.length,
    secondaryRollData.rolls.length,
  )

  const dueAt = await scheduleCraftWork(startDt, [{ crafter: primaryCrafter, rollData: primaryRollData }, { crafter: secondaryCrafter, rollData: secondaryRollData }], data.itemName)

  const charge = await chargeGold(primaryCrafter.id, totalCharge)

  if (!charge.ok) return replyError(interaction, charge.reason)

  if (payment > 0) {
    await addGoldToBank(secondaryCrafter.id, payment)
  }

  const baseEmbed = combinedCompletionEmbed({
    userId: interaction.user.id,
    primaryCrafter,
    secondaryCrafter,
    recipient,
    itemDisplay: data.itemName,
    quantity: data.quantity,
    rarita: data.rollRarity,
    tipologia: categoria,
    cost: data.cost,
    totalCharge,
    charge,
    payment,
    primaryRollData,
    secondaryRollData,
    dueAt,
    materialsText: "Nessun materiale o catalizzatore richiesto.",
    recipeName: data.itemName,
  })
    .setTitle("🧾 Craft speciale combinato completato")
    .addFields({
      name: "Nota speciale",
      value: data.note,
      inline: false,
    })

  const now = DateTime.now().setZone(TIMEZONE)

  if (dueAt <= now) {
    const display = await addFinishedItem(
      recipient.id,
      data.itemName,
      data.quantity,
      false,
    )

    baseEmbed.setDescription(
      `${pick(GIACOMO_LINES)}\n\n<@${interaction.user.id}>, **${display}** era già pronto ed è stato aggiunto all'inventario di **${recipient.name}**.`,
    )

    return interaction.reply({
      content: `<@${interaction.user.id}>`,
      embeds: [baseEmbed],
    })
  }

  const savedCraft = await db.run(
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
    primaryCrafter.id,
    recipient.id,
    data.itemName,
    data.quantity,
    0,
    dueAt.toUTC().toISO(),
    JSON.stringify(baseEmbed.toJSON()),
    DateTime.utc().toISO(),
  )

  await markActivityImported(db, `craft:${savedCraft.lastID}`)
  const scheduledEmbed = EmbedBuilder.from(baseEmbed)
    .setTitle("🧾 Craft speciale combinato avviato")
    .setDescription(
      `${pick(GIACOMO_LINES)}\n\nCraft speciale combinato registrato. Ti menzionerò il **${dueAt.toFormat("dd/LL/yyyy alle HH:mm")}**. Due firme, una pratica, zero pietà.`,
    )

  return interaction.reply({ embeds: [scheduledEmbed] })
}
// RIFORGIATURA: approvazione CC persistente, riferita a una singola copia.
// Rarità, mestieri originali, potenza e catalizzatori sono verificati dal CC
// nel ticket: il vecchio inventario contiene soltanto il nome dell'oggetto.
// Non si modifica la ricetta condivisa e non si crea una seconda copia.
const REFORGE_SUCCESSES = { "non comune": 1, raro: 2 }
const REFORGE_COMMAND_NAMES = [
  "autorizza_riforgiatura", "riforgia", "stato_riforgiatura", "revoca_riforgiatura",
]
let checkingReforges = false

async function initReforgingDB() {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS craft_reforges (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      guildId TEXT NOT NULL,
      inventoryId INTEGER NOT NULL,
      ownerCharacterId INTEGER NOT NULL,
      crafterCharacterId INTEGER NOT NULL,
      crafterUserId TEXT NOT NULL,
      itemName TEXT NOT NULL,
      rarity TEXT NOT NULL,
      originalJobs TEXT NOT NULL,
      job TEXT NOT NULL,
      modification TEXT NOT NULL,
      ticket TEXT NOT NULL,
      material TEXT NOT NULL DEFAULT '',
      cost INTEGER NOT NULL CHECK(cost >= 0),
      bonus INTEGER NOT NULL DEFAULT 0,
      approvedBy TEXT NOT NULL,
      approvedAt TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'approved'
        CHECK(status IN ('approved', 'pending', 'completed', 'revoked')),
      startDate TEXT,
      dueAt TEXT,
      rollData TEXT,
      chargeData TEXT,
      channelId TEXT,
      completedAt TEXT,
      notifiedAt TEXT,
      lastError TEXT
    );
    CREATE UNIQUE INDEX IF NOT EXISTS craft_reforges_active_item
      ON craft_reforges(inventoryId) WHERE status IN ('approved', 'pending');
    CREATE INDEX IF NOT EXISTS craft_reforges_due
      ON craft_reforges(status, dueAt);
  `)
}

// Una connessione dedicata impedisce che altri handler entrino nella transazione.
async function reforgeTransaction(action) {
  return activityTransaction(action)
}

function reforgeText(value, max = 100) {
  return String(value || "").trim().slice(0, max)
}

function reforgeEmbed(row) {
  const labels = {
    approved: "Autorizzata — da avviare", pending: "In lavorazione",
    completed: "Completata", revoked: "Autorizzazione revocata",
  }
  const embed = new EmbedBuilder()
    .setTitle(`🔨 Riforgiatura #${row.id} — ${labels[row.status]}`)
    .setColor(row.status === "completed" ? 0x22c55e : 0xf59e0b)
    .addFields(
      { name: "Oggetto originale", value: reforgeText(row.itemName, 1000) },
      { name: "Modifica approvata", value: row.modification },
      { name: "Rarità / Mestiere", value: `${row.rarity} / ${row.job}`, inline: true },
      { name: "Regole", value: `CD ${CRAFT_RULES[norm(row.rarity)].cd} — ${REFORGE_SUCCESSES[norm(row.rarity)]} successi`, inline: true },
      { name: "Crafter / Proprietario", value: `PG #${row.crafterCharacterId} / PG #${row.ownerCharacterId}`, inline: true },
      { name: "Materiale", value: row.material ? `1x ${row.material}` : "Nessuno", inline: true },
      { name: "Costo approvato dal CC", value: `${row.cost} MO`, inline: true },
      { name: "Bonus extra approvato", value: `+${row.bonus}`, inline: true },
      { name: "Ticket", value: row.ticket },
    )
    .setFooter({ text: "Catalizzatori invariati. Modifica della singola copia; ricetta e sintonia conservate." })
  if (row.rollData) {
    const rolls = JSON.parse(row.rollData)
    embed.addFields({ name: "Tiri giornalieri", value: rollsSummary(rolls).slice(0, 1000) })
  }
  if (row.dueAt) {
    embed.addFields({ name: "Fine riforgiatura", value: DateTime.fromISO(row.dueAt).setZone(TIMEZONE).toFormat("dd/LL/yyyy HH:mm") })
  }
  if (row.lastError) embed.addFields({ name: "Da verificare con il CC", value: row.lastError.slice(0, 1000) })
  return embed
}

async function validateReforgeItem(tx, row) {
  const item = await tx.get("SELECT * FROM inventory WHERE id = ?", row.inventoryId)
  if (!item || item.characterId !== row.ownerCharacterId || item.item !== row.itemName) {
    throw new Error("L'oggetto originale è stato spostato, rinominato o rimosso: il CC deve verificare l'inventario.")
  }
  return item
}

async function authorizeReforge(interaction) {
  const opts = interaction.options
  const crafterId = extractId(opts.getString("crafter"))
  const ownerId = extractId(opts.getString("proprietario"))
  const inventoryId = extractId(opts.getString("oggetto"))
  const rarity = opts.getString("rarita")
  const originalJobs = [opts.getString("mestiere_originale"), opts.getString("secondo_mestiere_originale")]
    .filter(Boolean).map((job) => reforgeText(job))
  const job = reforgeText(opts.getString("mestiere_usato") || originalJobs[0])
  const modification = reforgeText(opts.getString("modifica"), 1000)
  const ticket = reforgeText(opts.getString("ticket"), 200)
  const cost = opts.getInteger("costo_mo")
  const bonus = opts.getInteger("bonus_extra") || 0
  const material = reforgeText(stripQty(opts.getString("materiale") || ""))
  if (!REFORGE_SUCCESSES[norm(rarity)]) throw new Error("La riforgiatura è prevista per Non comune e Raro.")
  if (!job || !originalJobs.some((original) => same(original, job))) {
    throw new Error("Il mestiere deve coincidere con uno dei mestieri originali, anche per un oggetto collaborativo.")
  }
  if (!modification || !Number.isInteger(cost) || cost < 0) throw new Error("Indica modifica e costo approvati, anche 0 MO.")
  const ticketMatch = ticket.match(/^https:\/\/(?:www\.)?discord\.com\/channels\/(\d+)\/\d+(?:\/\d+)?$/)
  if (!ticketMatch || ticketMatch[1] !== interaction.guildId) throw new Error("Inserisci il link Discord del ticket o di un suo messaggio, in questo server.")
  const row = await reforgeTransaction(async (tx) => {
    const crafter = await tx.get("SELECT * FROM characters WHERE id = ?", crafterId)
    const owner = await tx.get("SELECT * FROM characters WHERE id = ?", ownerId)
    const item = await tx.get("SELECT * FROM inventory WHERE id = ? AND characterId = ?", inventoryId, ownerId)
    if (!crafter || !owner || !item) throw new Error("Seleziona crafter, proprietario e un oggetto del suo inventario.")
    // L'inventario legacy rappresenta i lotti come 'Nx Nome': non identificarli
    // con una singola copia, per non applicare la modifica a tutto il lotto.
    const stack = item.item.match(/^\s*(\d+)\s*x\s+/i)
    if (stack && Number(stack[1]) !== 1) throw new Error("Separa prima una singola copia dal lotto nell'inventario, poi autorizza la riforgiatura.")
    const active = await tx.get("SELECT id FROM craft_reforges WHERE inventoryId = ? AND status IN ('approved', 'pending')", inventoryId)
    if (active) throw new Error(`Questo oggetto ha già la riforgiatura #${active.id} autorizzata o in corso.`)
    if (material) {
      const mat = await tx.get("SELECT quantity FROM materials_inventory WHERE characterId = ? AND lower(material) = lower(?)", crafterId, material)
      if (!mat || mat.quantity < 1) throw new Error("Il materiale facoltativo deve essere nell'inventario del crafter.")
    }
    const result = await tx.run(`INSERT INTO craft_reforges
      (guildId, inventoryId, ownerCharacterId, crafterCharacterId, crafterUserId,
       itemName, rarity, originalJobs, job, modification, ticket, material, cost,
       bonus, approvedBy, approvedAt)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      interaction.guildId, inventoryId, ownerId, crafterId, crafter.playerId,
      item.item, rarity, JSON.stringify(originalJobs), job, modification, ticket,
      material, cost, bonus, interaction.user.id, DateTime.utc().toISO())
    return tx.get("SELECT * FROM craft_reforges WHERE id = ?", result.lastID)
  })
  return interaction.editReply({
    content: `🗂️ **Giacomo:** Autorizzazione #${row.id} registrata. Il giocatore può usare \`/riforgia autorizzazione:${row.id} data_inizio:YYYY-MM-DD\`.`,
    embeds: [reforgeEmbed(row)], allowedMentions: { parse: [] },
  })
}

async function startReforge(interaction) {
  const id = extractId(interaction.options.getString("autorizzazione"))
  const startDate = interaction.options.getString("data_inizio")
  const startDt = parseStartDate(startDate)
  if (!startDt) throw new Error("Data non valida. Usa YYYY-MM-DD.")
  const row = await reforgeTransaction(async (tx) => {
    await syncLegacyActivities(tx)
    const row = await tx.get("SELECT * FROM craft_reforges WHERE id = ? AND guildId = ?", id, interaction.guildId)
    if (!row || row.crafterUserId !== interaction.user.id) throw new Error("Autorizzazione non trovata fra quelle assegnate ai tuoi PG.")
    if (row.status !== "approved") throw new Error("Questa autorizzazione è già stata utilizzata o revocata.")
    await validateReforgeItem(tx, row)
    const crafter = await tx.get("SELECT * FROM characters WHERE id = ?", row.crafterCharacterId)
    const owner = await tx.get("SELECT * FROM characters WHERE id = ?", row.ownerCharacterId)
    if (!crafter || crafter.playerId !== interaction.user.id || !owner) throw new Error("Crafter o proprietario non più validi.")
    const gold = Number(crafter.gold || 0)
    const bank = Number(crafter.bank || 0)
    if (gold + bank < row.cost) throw new Error(`Fondi insufficienti: servono ${row.cost} MO, disponibili ${gold + bank}.`)
    if (row.material) {
      const removed = await tx.run("UPDATE materials_inventory SET quantity = quantity - 1 WHERE characterId = ? AND lower(material) = lower(?) AND quantity >= 1", crafter.id, row.material)
      if (removed.changes !== 1) throw new Error("Il materiale approvato non è più disponibile in una voce univoca dell'inventario.")
      await tx.run("DELETE FROM materials_inventory WHERE characterId = ? AND lower(material) = lower(?) AND quantity = 0", crafter.id, row.material)
    }
    const fortress = await tx.get("SELECT level FROM fortresses WHERE characterId = ?", crafter.id)
    const rollData = rollCraft(crafter, fortress?.level || 0, row.rarity, row.bonus, REFORGE_SUCCESSES[norm(row.rarity)])
    const schedule = await reserveActivityDays(tx, [{ id: crafter.id, days: rollData.rolls.length }],
      startDt.toFormat("yyyy-MM-dd"), "reforge", `reforge:${row.id}`, row.itemName)
    rollData.rolls.forEach((roll, n) => { roll.date = schedule.participants[0].dates[n] })
    const dueAt = activityDueISO(schedule.lastDay)
    const charge = { fromGold: Math.min(gold, row.cost), fromBank: Math.max(0, row.cost - gold) }
    await tx.run("UPDATE characters SET gold = gold - ?, bank = bank - ? WHERE id = ?", charge.fromGold, charge.fromBank, crafter.id)
    await tx.run(`UPDATE craft_reforges SET status = 'pending', startDate = ?, dueAt = ?,
      rollData = ?, chargeData = ?, channelId = ?, lastError = NULL WHERE id = ?`,
      startDate, dueAt, JSON.stringify(rollData), JSON.stringify(charge), interaction.channelId, row.id)
    await markActivityImported(tx, `reforge:${row.id}`)
    return tx.get("SELECT * FROM craft_reforges WHERE id = ?", row.id)
  })
  // La risposta conferma prima il salvataggio: un errore di notifica non annulla
  // un'operazione già pagata. Il timer riprende anche dopo un riavvio.
  await interaction.editReply({
    content: `🔨 **Giacomo:** Riforgiatura #${row.id} avviata. La copia originale resta in inventario; la modifica sarà registrata al completamento.`,
    embeds: [reforgeEmbed(row)], allowedMentions: { parse: [] },
  })
  await checkPendingReforges()
}

async function finishReforge(id) {
  return reforgeTransaction(async (tx) => {
    const row = await tx.get("SELECT * FROM craft_reforges WHERE id = ?", id)
    if (!row || row.status !== "pending" || row.dueAt > DateTime.utc().toISO()) return
    await validateReforgeItem(tx, row)
    // L'effetto della singola copia vive nello storico craft_reforges.
    // inventory e attunements contengono solo nomi: non duplicarli né rinominarli.
    await tx.run("UPDATE craft_reforges SET status = 'completed', completedAt = ?, lastError = NULL WHERE id = ? AND status = 'pending'", DateTime.utc().toISO(), id)
  })
}

async function checkPendingReforges() {
  if (checkingReforges) return
  checkingReforges = true
  try {
    const due = await db.all("SELECT id FROM craft_reforges WHERE guildId = ? AND status = 'pending' AND dueAt <= ? ORDER BY dueAt LIMIT 50", GUILD_ID, DateTime.utc().toISO())
    for (const row of due) {
      try { await finishReforge(row.id) }
      catch (err) {
        await db.run("UPDATE craft_reforges SET lastError = ? WHERE id = ? AND status = 'pending'", String(err.message).slice(0, 1000), row.id)
        console.error("Riforgiatura da verificare", row.id, err.message)
      }
    }
    const notices = await db.all("SELECT * FROM craft_reforges WHERE guildId = ? AND status = 'completed' AND notifiedAt IS NULL ORDER BY id LIMIT 50", GUILD_ID)
    for (const row of notices) {
      try {
        const channel = await client.channels.fetch(row.channelId)
        if (!channel?.isTextBased()) continue
        await channel.send({
          content: `<@${row.crafterUserId}>, riforgiatura #${row.id} completata. Consulta la modifica con \`/stato_riforgiatura\`.`,
          embeds: [reforgeEmbed(row)], allowedMentions: { users: [row.crafterUserId] },
        })
        await db.run("UPDATE craft_reforges SET notifiedAt = ? WHERE id = ?", DateTime.utc().toISO(), row.id)
      } catch (err) { console.error("Notifica riforgiatura da ritentare", row.id, err.message) }
    }
  } catch (err) { console.error("Errore controllo riforgiature", err) }
  finally { checkingReforges = false }
}

async function handleReforgeCommand(interaction) {
  const command = interaction.commandName
  if (!interaction.guildId || interaction.guildId !== GUILD_ID) return replyError(interaction, "Usa questo comando nel server configurato.")
  const staffCommand = ["autorizza_riforgiatura", "revoca_riforgiatura"].includes(command)
  if (staffCommand && !(await requireCC(interaction))) return
  if (!staffCommand && !isBeta(interaction.member)) return replyError(interaction, "Serve il ruolo Beta o Craft Control.")
  await interaction.deferReply({ ephemeral: command !== "riforgia" })
  try {
    if (command === "autorizza_riforgiatura") return await authorizeReforge(interaction)
    if (command === "riforgia") return await startReforge(interaction)
    const id = extractId(interaction.options.getString("autorizzazione"))
    const row = await db.get("SELECT * FROM craft_reforges WHERE id = ? AND guildId = ?", id, interaction.guildId)
    const owner = row && await getCharacter(row.ownerCharacterId)
    if (!row || (!isCraftControl(interaction.member) && row.crafterUserId !== interaction.user.id && owner?.playerId !== interaction.user.id)) {
      throw new Error("Riforgiatura non trovata o non accessibile.")
    }
    if (command === "revoca_riforgiatura") {
      const result = await db.run("UPDATE craft_reforges SET status = 'revoked' WHERE id = ? AND status = 'approved'", row.id)
      if (!result.changes) throw new Error("Puoi revocare soltanto un'autorizzazione non ancora avviata.")
      row.status = "revoked"
    }
    return await interaction.editReply({ embeds: [reforgeEmbed(row)], allowedMentions: { parse: [] } })
  } catch (err) {
    return interaction.editReply({ content: `🗂️ **Giacomo:** ${reforgeText(err.message, 1500)}`, embeds: [], allowedMentions: { parse: [] } })
  }
}

function reforgeCommands() {
  const authorize = new SlashCommandBuilder().setName("autorizza_riforgiatura")
    .setDescription("CC: autorizza una modifica dal ticket, attestando mestiere e catalizzatori invariati.")
  const stringOption = (builder, name, description, required = true, autocomplete = false, max = 100) => {
    builder.addStringOption((o) => o.setName(name).setDescription(description)
      .setRequired(required).setAutocomplete(autocomplete).setMaxLength(max))
  }
  stringOption(authorize, "crafter", "PG autorizzato a riforgiare; paga il costo e fornisce il materiale", true, true)
  stringOption(authorize, "proprietario", "PG che possiede l'oggetto originale", true, true)
  stringOption(authorize, "oggetto", "Singola copia nell'inventario del proprietario (oppure ID inventario)", true, true)
  authorize.addStringOption((o) => o.setName("rarita").setDescription("Rarità originale verificata dal CC")
    .setRequired(true).addChoices(...commandChoices(["Non comune", "Raro"])))
  stringOption(authorize, "mestiere_originale", "Mestiere della creazione originale, verificato nel ticket", true, true)
  stringOption(authorize, "modifica", "Modifica approvata: stesso tema, rarità, potenza e catalizzatori", true, false, 1000)
  stringOption(authorize, "ticket", "Link al ticket Discord o al messaggio di approvazione", true, false, 200)
  authorize.addIntegerOption((o) => o.setName("costo_mo").setDescription("Costo approvato dal CC: indicare esplicitamente 0 se gratuito")
    .setRequired(true).setMinValue(0).setMaxValue(1000000))
  stringOption(authorize, "secondo_mestiere_originale", "Secondo mestiere SOLO se l'oggetto fu creato in collaborazione", false, true)
  stringOption(authorize, "mestiere_usato", "Uno dei mestieri originali; se omesso usa il primo", false, true)
  stringOption(authorize, "materiale", "Facoltativo: una unità dal crafter, coerente con la modifica a giudizio del CC", false, true)
  authorize.addIntegerOption((o) => o.setName("bonus_extra").setDescription("Bonus extra al tiro verificato dal CC")
    .setMinValue(0).setMaxValue(1000))
  const start = new SlashCommandBuilder().setName("riforgia").setDescription("Avvia una riforgiatura già autorizzata dal Craft Control.")
  stringOption(start, "autorizzazione", "Autorizzazione del CC assegnata a un tuo PG (oppure ID)", true, true)
  stringOption(start, "data_inizio", "Data inizio YYYY-MM-DD: stesso calendario del crafting", true, false, 10)
  const status = new SlashCommandBuilder().setName("stato_riforgiatura").setDescription("Consulta autorizzazione, tiri e modifica della singola copia, anche completata.")
  stringOption(status, "autorizzazione", "Riforgiatura da consultare (oppure ID)", true, true)
  const revoke = new SlashCommandBuilder().setName("revoca_riforgiatura").setDescription("CC: revoca un'autorizzazione non ancora avviata.")
  stringOption(revoke, "autorizzazione", "Autorizzazione da revocare (oppure ID)", true, true)
  return [authorize, start, status, revoke]
}

async function reforgeAutocomplete(interaction) {
  const command = interaction.commandName
  const focused = interaction.options.getFocused(true)
  const staff = isCraftControl(interaction.member)
  if (!interaction.guildId || interaction.guildId !== GUILD_ID || !isBeta(interaction.member) ||
      (["autorizza_riforgiatura", "revoca_riforgiatura"].includes(command) && !staff)) {
    return interaction.respond([])
  }
  let choices = []
  const query = norm(focused.value)
  const byId = (rows, label) => rows.filter((r) => norm(`${label(r)} ${r.id}`).includes(query)).slice(0, 25)
    .map((r) => ({ name: `[${r.id}] ${label(r)}`.slice(0, 100), value: String(r.id) }))
  if (focused.name === "autorizzazione") {
    const rows = await db.all(`SELECT r.* FROM craft_reforges r
      LEFT JOIN characters owner ON owner.id = r.ownerCharacterId
      WHERE r.guildId = ? AND (? = 1 OR r.crafterUserId = ? OR owner.playerId = ?)
      ORDER BY r.id DESC`, interaction.guildId, staff ? 1 : 0, interaction.user.id, interaction.user.id)
    const filtered = rows.filter((r) => command === "riforgia" ? r.status === "approved" && r.crafterUserId === interaction.user.id :
      command === "revoca_riforgiatura" ? r.status === "approved" : true)
    choices = byId(filtered, (r) => `${r.itemName} (${r.status})`)
  } else if (focused.name === "crafter" || focused.name === "proprietario") {
    choices = byId(await getAllCharacters(), (r) => r.name)
  } else if (focused.name === "oggetto") {
    const ownerId = extractId(interaction.options.getString("proprietario"))
    const rows = await db.all(`SELECT i.* FROM inventory i WHERE i.characterId = ?
      AND NOT EXISTS (SELECT 1 FROM craft_reforges r WHERE r.inventoryId = i.id AND r.status IN ('approved', 'pending'))
      ORDER BY i.item`, ownerId)
    choices = byId(rows, (r) => r.item)
  } else if (focused.name === "materiale") {
    const rows = await getMaterialsInventory(extractId(interaction.options.getString("crafter")))
    choices = rows.filter((r) => norm(r.material).includes(query) && r.material.length <= 100).slice(0, 25)
      .map((r) => ({ name: `${r.material} x${r.quantity}`.slice(0, 100), value: r.material }))
  } else if (focused.name.includes("mestiere")) {
    choices = selectMenuOptions(getAllMestieri(), focused.value)
  }
  return interaction.respond(choices).catch(() => {})
}

class CraftCalendarRejection extends Error {
  constructor(payload) { super(payload.content); this.payload = payload }
}
async function runCraftTransaction(interaction) {
  await interaction.deferReply({ ephemeral: false })
  let reply
  const deferredInteraction = new Proxy(interaction, {
    get(target, key) {
      if (key === "reply") return async (payload) => {
        if (payload.ephemeral) throw new CraftCalendarRejection(payload)
        for (const embed of payload.embeds || []) embed.toJSON()
        reply = payload
      }
      const value = Reflect.get(target, key, target)
      return typeof value === "function" ? value.bind(target) : value
    },
  })
  try {
    await activityTransaction(async (tx) => {
      await syncLegacyActivities(tx)
      await handleCommand(deferredInteraction)
      if (!reply) throw new Error("Nessun esito del crafting: transazione annullata.")
    })
  } catch (error) {
    return interaction.editReply({ content: error.message.slice(0, 1900), embeds: [], allowedMentions: { parse: [] } })
  }
  // Il messaggio Discord parte solo DOPO il commit. Un errore di rete non
  // cancella le giornate e non permette di riusare giorni già occupati.
  return interaction.editReply(reply)
}
async function scheduleCraftWork(startDt, workers, label) {
  const schedule = await reserveActivityDays(db,
    workers.map((w) => ({ id: w.crafter.id, days: w.rollData.rolls.length })),
    startDt.toFormat("yyyy-MM-dd"), "craft", `craft-job:${randomUUID()}`, label)
  workers.forEach((worker, index) => {
    worker.rollData.rolls.forEach((roll, day) => { roll.date = schedule.participants[index].dates[day] })
  })
  return DateTime.fromISO(activityDueISO(schedule.lastDay)).setZone(TIMEZONE)
}
function manualCraftDaysCommand() {
  return new SlashCommandBuilder().setName("registra_giorni_craft")
    .setDescription("CC: registra giorni di vecchi craft conclusi non presenti nello storico.")
    .addStringOption((o) => o.setName("personaggio").setDescription("ID del PG (numero del registro)").setRequired(true))
    .addStringOption((o) => o.setName("dal").setDescription("Primo giorno occupato YYYY-MM-DD").setRequired(true))
    .addStringOption((o) => o.setName("al").setDescription("Ultimo giorno occupato incluso YYYY-MM-DD").setRequired(true))
    .addStringOption((o) => o.setName("oggetto").setDescription("Oggetto o motivo della registrazione").setMaxLength(100).setRequired(true))
}
async function registerManualCraftDays(interaction) {
  if (!(await requireCC(interaction))) return
  await interaction.deferReply({ ephemeral: true })
  try {
    const id = extractId(interaction.options.getString("personaggio"))
    const start = interaction.options.getString("dal")
    const end = interaction.options.getString("al")
    activityAddDays(start, 0); activityAddDays(end, 0)
    const duration = Math.round((Date.parse(`${end}T12:00:00Z`) - Date.parse(`${start}T12:00:00Z`)) / 86400000) + 1
    if (duration < 1 || duration > 3650) throw new Error("Intervallo non valido (massimo 3650 giorni).")
    const result = await activityTransaction(async (tx) => {
      await syncLegacyActivities(tx)
      const pg = await tx.get("SELECT * FROM characters WHERE id = ?", id)
      if (!pg) throw new Error("PG non trovato.")
      const busy = await tx.get("SELECT day, kind FROM activity_days WHERE characterId = ? AND day BETWEEN ? AND ? ORDER BY day LIMIT 1", id, start, end)
      if (busy) throw new Error(`Il ${busy.day} è già occupato (${busy.kind}). Nessuna giornata aggiunta: verificare con lo staff.`)
      await reserveActivityDays(tx, [{ id, days: duration }], start, "manual", `manual:${randomUUID()}`, interaction.options.getString("oggetto"))
      return pg.name
    })
    return interaction.editReply({ content: `Registrati ${duration} giorni per **${result}**, dal ${start} al ${end} inclusi. Nessun costo, tiro o oggetto aggiunto.`, allowedMentions: { parse: [] } })
  } catch (error) {
    return interaction.editReply({ content: error.message.slice(0, 1900), allowedMentions: { parse: [] } })
  }
}

function commandChoices(list) {
  return list.map((x) => ({ name: x, value: x }))
}
const CRAFT_COMMAND_NAMES = [
  "riforgia",
  "craft",
  "craft_da_ricetta",
  "craft_combinato",
  "craft_combinato_da_ricetta",
  "craft_speciale",
  "craft_speciale_combinato",
]
const commands = [
  manualCraftDaysCommand(),
  ...reforgeCommands(),
     new SlashCommandBuilder()
    .setName("craft_speciale")
    .setDescription(
      "Esegue craft speciali: bocchette, strumenti migliorati, pergamene e spartiti.",
    )
    .addStringOption((o) =>
      o
        .setName("crafter")
        .setDescription("PG che esegue e paga il craft")
        .setRequired(true)
        .setAutocomplete(true),
    )
    .addStringOption((o) =>
      o
        .setName("categoria")
        .setDescription("Tipo di craft speciale")
        .setRequired(true)
        .addChoices(...commandChoices(CRAFT_SPECIALI_CATEGORIE)),
    )
    .addStringOption((o) =>
      o
        .setName("destinatario")
        .setDescription("PG che riceve l'oggetto")
        .setRequired(true)
        .setAutocomplete(true),
    )
    .addStringOption((o) =>
      o
        .setName("data_inizio")
        .setDescription("Data inizio craft: YYYY-MM-DD")
        .setRequired(true),
    )
    .addStringOption((o) =>
      o
        .setName("grado")
        .setDescription("Grado richiesto: per bocchette o strumenti migliorati")
        .setRequired(false)
        .addChoices(...commandChoices(CRAFT_SPECIALI_GRADI)),
    )
    .addIntegerOption((o) =>
      o
        .setName("livello")
        .setDescription("Livello incantesimo per pergamena/spartito. Usa 0 per Cantrip")
        .setRequired(false)
        .setMinValue(0)
        .setMaxValue(6),
    )
    .addStringOption((o) =>
      o
        .setName("nome_personalizzato")
        .setDescription("Nome specifico, es. Pergamena di Palla di Fuoco")
        .setRequired(false),
    )
    .addIntegerOption((o) =>
      o
        .setName("bonus_extra")
        .setDescription("Bonus extra al tiro: strumenti, maestria o altri bonus")
        .setRequired(false)
        .setMinValue(0)
        .setMaxValue(1000),
    ),
    new SlashCommandBuilder()
    .setName("craft_speciale_combinato")
    .setDescription(
      "Esegue un craft speciale collaborativo tra due PG di utenti diversi.",
    )
    .addStringOption((o) =>
      o
        .setName("crafter_primario")
        .setDescription("PG che paga il craft speciale")
        .setRequired(true)
        .setAutocomplete(true),
    )
    .addStringOption((o) =>
      o
        .setName("crafter_secondario")
        .setDescription("PG collaboratore di un altro utente")
        .setRequired(true)
        .setAutocomplete(true),
    )
    .addStringOption((o) =>
      o
        .setName("categoria")
        .setDescription("Tipo di craft speciale")
        .setRequired(true)
        .addChoices(...commandChoices(CRAFT_SPECIALI_CATEGORIE)),
    )
    .addStringOption((o) =>
      o
        .setName("destinatario")
        .setDescription("PG che riceve l'oggetto")
        .setRequired(true)
        .setAutocomplete(true),
    )
    .addStringOption((o) =>
      o
        .setName("data_inizio")
        .setDescription("Data inizio craft: YYYY-MM-DD")
        .setRequired(true),
    )
    .addStringOption((o) =>
      o
        .setName("grado")
        .setDescription("Grado richiesto: per bocchette o strumenti migliorati")
        .setRequired(false)
        .addChoices(...commandChoices(CRAFT_SPECIALI_GRADI)),
    )
    .addIntegerOption((o) =>
      o
        .setName("livello")
        .setDescription("Livello incantesimo per pergamena/spartito. Usa 0 per Cantrip")
        .setRequired(false)
        .setMinValue(0)
        .setMaxValue(6),
    )
    .addStringOption((o) =>
      o
        .setName("nome_personalizzato")
        .setDescription("Nome specifico, es. Pergamena di Palla di Fuoco")
        .setRequired(false),
    )
    .addIntegerOption((o) =>
      o
        .setName("bonus_primario")
        .setDescription("Bonus extra al tiro del primario")
        .setRequired(false)
        .setMinValue(0)
        .setMaxValue(1000),
    )
    .addIntegerOption((o) =>
      o
        .setName("bonus_secondario")
        .setDescription("Bonus extra al tiro del secondario")
        .setRequired(false)
        .setMinValue(0)
        .setMaxValue(1000),
    )
    .addIntegerOption((o) =>
      o
        .setName("pagamento_secondario")
        .setDescription("Pagamento opzionale al secondario, accreditato in banca")
        .setRequired(false)
        .setMinValue(0)
        .setMaxValue(1000000),
    ),
  new SlashCommandBuilder()
    .setName("craft")
    .setDescription(
      "Avvia un craft manuale. Giacomo farà i conti, voi provate a non intralciare.",
    )
    .addStringOption((o) =>
      o
        .setName("crafter")
        .setDescription("PG che crafta")
        .setRequired(true)
        .setAutocomplete(true),
    )
    .addStringOption((o) =>
      o
        .setName("nome_oggetto")
        .setDescription("Nome oggetto")
        .setRequired(true),
    )
    .addStringOption((o) =>
      o
        .setName("rarita")
        .setDescription("Rarità")
        .setRequired(true)
        .addChoices(...commandChoices(RARITA)),
    )
    .addStringOption((o) =>
      o
        .setName("sintonia")
        .setDescription("Richiede sintonia?")
        .setRequired(true)
        .addChoices(...commandChoices(SI_NO)),
    )
    .addStringOption((o) =>
      o
        .setName("tipologia")
        .setDescription("Tipologia oggetto")
        .setRequired(true)
        .addChoices(...commandChoices(TIPI_OGGETTO)),
    )
    .addIntegerOption((o) =>
      o
        .setName("quantita")
        .setDescription("Quantità prodotta")
        .setRequired(true)
        .setMinValue(1)
        .setMaxValue(999),
    )
    .addStringOption((o) =>
      o
        .setName("mestiere")
        .setDescription("Mestiere usato")
        .setRequired(true)
        .setAutocomplete(true),
    )
    .addStringOption((o) =>
      o
        .setName("catalizzatore_1")
        .setDescription("Tipo catalizzatore principale")
        .setRequired(true)
        .addChoices(...commandChoices(CATALIZZATORI)),
    )
    .addStringOption((o) =>
      o
        .setName("catalizzatore_2")
        .setDescription("Secondo catalizzatore?")
        .setRequired(true)
        .addChoices(...commandChoices(CATALIZZATORI_CON_NO)),
    )
    .addStringOption((o) =>
      o
        .setName("data_inizio")
        .setDescription("Data inizio craft: YYYY-MM-DD")
        .setRequired(true),
    )
    .addStringOption((o) =>
      o
        .setName("destinatario")
        .setDescription("PG che riceve l'oggetto")
        .setRequired(true)
        .setAutocomplete(true),
    )
    .addStringOption((o) =>
      o
        .setName("materiale_1")
        .setDescription("Materiale 1, se richiesto")
        .setRequired(false)
        .setAutocomplete(true),
    )
    .addStringOption((o) =>
      o
        .setName("materiale_2")
        .setDescription("Materiale 2, se richiesto")
        .setRequired(false)
        .setAutocomplete(true),
    )
    .addIntegerOption((o) =>
      o
        .setName("costo_extra")
        .setDescription("Costo aggiuntivo opzionale in MO")
        .setRequired(false)
        .setMinValue(0)
        .setMaxValue(1000000),
    )
    .addIntegerOption((o) =>
      o
        .setName("bonus_extra")
        .setDescription(
          "Bonus totale al tiro: strumenti +1/+2/+3, maestria o altri bonus",
        )
        .setRequired(false)
        .setMinValue(0)
        .setMaxValue(1000),
    ),
  new SlashCommandBuilder()
    .setName("craft_da_ricetta")
    .setDescription("Avvia un craft usando una ricetta del CC.")
    .addStringOption((o) =>
      o
        .setName("crafter")
        .setDescription("PG che crafta")
        .setRequired(true)
        .setAutocomplete(true),
    )
    .addStringOption((o) =>
      o
        .setName("ricetta")
        .setDescription("Ricetta da usare")
        .setRequired(true)
        .setAutocomplete(true),
    )
    .addIntegerOption((o) =>
      o
        .setName("quantita")
        .setDescription("Quantità prodotta")
        .setRequired(true)
        .setMinValue(1)
        .setMaxValue(999),
    )
    .addStringOption((o) =>
      o
        .setName("data_inizio")
        .setDescription("Data inizio craft: YYYY-MM-DD")
        .setRequired(true),
    )
    .addStringOption((o) =>
      o
        .setName("destinatario")
        .setDescription("PG che riceve l'oggetto")
        .setRequired(true)
        .setAutocomplete(true),
    )
    .addStringOption((o) =>
      o
        .setName("materiale_1")
        .setDescription("Materiale reale compatibile col tag 1")
        .setRequired(false)
        .setAutocomplete(true),
    )
    .addStringOption((o) =>
      o
        .setName("materiale_2")
        .setDescription("Materiale reale compatibile col tag 2")
        .setRequired(false)
        .setAutocomplete(true),
    )
    .addIntegerOption((o) =>
      o
        .setName("costo_extra")
        .setDescription("Costo aggiuntivo opzionale in MO")
        .setRequired(false)
        .setMinValue(0)
        .setMaxValue(1000000),
    )
    .addIntegerOption((o) =>
      o
        .setName("bonus_extra")
        .setDescription(
          "Bonus totale al tiro: strumenti +1/+2/+3, maestria o altri bonus",
        )
        .setRequired(false)
        .setMinValue(0)
        .setMaxValue(1000),
    ),
  new SlashCommandBuilder()
    .setName("craft_combinato")
    .setDescription(
      "Avvia un craft manuale collaborativo tra due PG di utenti diversi.",
    )
    .addStringOption((o) =>
      o
        .setName("crafter_primario")
        .setDescription("PG che paga materiali e costi")
        .setRequired(true)
        .setAutocomplete(true),
    )
    .addStringOption((o) =>
      o
        .setName("crafter_secondario")
        .setDescription("PG collaboratore di un altro utente")
        .setRequired(true)
        .setAutocomplete(true),
    )
    .addStringOption((o) =>
      o
        .setName("nome_oggetto")
        .setDescription("Nome oggetto")
        .setRequired(true),
    )
    .addStringOption((o) =>
      o
        .setName("rarita")
        .setDescription("Rarità")
        .setRequired(true)
        .addChoices(...commandChoices(RARITA)),
    )
    .addStringOption((o) =>
      o
        .setName("sintonia")
        .setDescription("Richiede sintonia?")
        .setRequired(true)
        .addChoices(...commandChoices(SI_NO)),
    )
    .addStringOption((o) =>
      o
        .setName("tipologia")
        .setDescription("Tipologia oggetto")
        .setRequired(true)
        .addChoices(...commandChoices(TIPI_OGGETTO)),
    )
    .addIntegerOption((o) =>
      o
        .setName("quantita")
        .setDescription("Quantità prodotta")
        .setRequired(true)
        .setMinValue(1)
        .setMaxValue(999),
    )
    .addStringOption((o) =>
      o
        .setName("mestiere")
        .setDescription("Mestiere usato")
        .setRequired(true)
        .setAutocomplete(true),
    )
    .addStringOption((o) =>
      o
        .setName("catalizzatore_1")
        .setDescription("Tipo catalizzatore principale")
        .setRequired(true)
        .addChoices(...commandChoices(CATALIZZATORI)),
    )
    .addStringOption((o) =>
      o
        .setName("catalizzatore_2")
        .setDescription("Secondo catalizzatore?")
        .setRequired(true)
        .addChoices(...commandChoices(CATALIZZATORI_CON_NO)),
    )
    .addStringOption((o) =>
      o
        .setName("data_inizio")
        .setDescription("Data inizio craft: YYYY-MM-DD")
        .setRequired(true),
    )
    .addStringOption((o) =>
      o
        .setName("destinatario")
        .setDescription("PG che riceve l'oggetto")
        .setRequired(true)
        .setAutocomplete(true),
    )
    .addStringOption((o) =>
      o
        .setName("materiale_1")
        .setDescription("Materiale 1, pagato dal primario")
        .setRequired(false)
        .setAutocomplete(true),
    )
    .addStringOption((o) =>
      o
        .setName("materiale_2")
        .setDescription("Materiale 2, pagato dal primario")
        .setRequired(false)
        .setAutocomplete(true),
    )
    .addIntegerOption((o) =>
      o
        .setName("costo_extra")
        .setDescription("Costo aggiuntivo opzionale in MO, pagato dal primario")
        .setRequired(false)
        .setMinValue(0)
        .setMaxValue(1000000),
    )
    .addIntegerOption((o) =>
      o
        .setName("bonus_primario")
        .setDescription("Bonus extra al tiro del primario")
        .setRequired(false)
        .setMinValue(0)
        .setMaxValue(1000),
    )
    .addIntegerOption((o) =>
      o
        .setName("bonus_secondario")
        .setDescription("Bonus extra al tiro del secondario")
        .setRequired(false)
        .setMinValue(0)
        .setMaxValue(1000),
    )
    .addIntegerOption((o) =>
      o
        .setName("pagamento_secondario")
        .setDescription(
          "Pagamento opzionale al secondario, accreditato in banca",
        )
        .setRequired(false)
        .setMinValue(0)
        .setMaxValue(1000000),
    ),
  new SlashCommandBuilder()
    .setName("craft_combinato_da_ricetta")
    .setDescription("Avvia un craft collaborativo usando una ricetta del CC.")
    .addStringOption((o) =>
      o
        .setName("crafter_primario")
        .setDescription("PG che paga materiali e costi")
        .setRequired(true)
        .setAutocomplete(true),
    )
    .addStringOption((o) =>
      o
        .setName("crafter_secondario")
        .setDescription("PG collaboratore di un altro utente")
        .setRequired(true)
        .setAutocomplete(true),
    )
    .addStringOption((o) =>
      o
        .setName("ricetta")
        .setDescription("Ricetta da usare")
        .setRequired(true)
        .setAutocomplete(true),
    )
    .addIntegerOption((o) =>
      o
        .setName("quantita")
        .setDescription("Quantità prodotta")
        .setRequired(true)
        .setMinValue(1)
        .setMaxValue(999),
    )
    .addStringOption((o) =>
      o
        .setName("data_inizio")
        .setDescription("Data inizio craft: YYYY-MM-DD")
        .setRequired(true),
    )
    .addStringOption((o) =>
      o
        .setName("destinatario")
        .setDescription("PG che riceve l'oggetto")
        .setRequired(true)
        .setAutocomplete(true),
    )
    .addStringOption((o) =>
      o
        .setName("materiale_1")
        .setDescription("Materiale reale compatibile col tag 1")
        .setRequired(false)
        .setAutocomplete(true),
    )
    .addStringOption((o) =>
      o
        .setName("materiale_2")
        .setDescription("Materiale reale compatibile col tag 2")
        .setRequired(false)
        .setAutocomplete(true),
    )
    .addIntegerOption((o) =>
      o
        .setName("costo_extra")
        .setDescription("Costo aggiuntivo opzionale in MO, pagato dal primario")
        .setRequired(false)
        .setMinValue(0)
        .setMaxValue(1000000),
    )
    .addIntegerOption((o) =>
      o
        .setName("bonus_primario")
        .setDescription("Bonus extra al tiro del primario")
        .setRequired(false)
        .setMinValue(0)
        .setMaxValue(1000),
    )
    .addIntegerOption((o) =>
      o
        .setName("bonus_secondario")
        .setDescription("Bonus extra al tiro del secondario")
        .setRequired(false)
        .setMinValue(0)
        .setMaxValue(1000),
    )
    .addIntegerOption((o) =>
      o
        .setName("pagamento_secondario")
        .setDescription(
          "Pagamento opzionale al secondario, accreditato in banca",
        )
        .setRequired(false)
        .setMinValue(0)
        .setMaxValue(1000000),
    ),
  new SlashCommandBuilder()
    .setName("aggiungi_ricetta")
    .setDescription("Aggiunge una ricetta all'archivio CC.")
    .addStringOption((o) =>
      o
        .setName("nome_oggetto")
        .setDescription("Nome oggetto")
        .setRequired(true),
    )
    .addStringOption((o) =>
      o
        .setName("tipologia")
        .setDescription("Tipologia oggetto")
        .setRequired(true)
        .addChoices(...commandChoices(TIPI_OGGETTO)),
    )
    .addStringOption((o) =>
      o
        .setName("specifica_tipologia")
        .setDescription("Specifica libera, es. spada, pozione, proiettile")
        .setRequired(true),
    )
    .addStringOption((o) =>
      o
        .setName("sintonia")
        .setDescription("Sintonia?")
        .setRequired(true)
        .addChoices(...commandChoices(SI_NO)),
    )
    .addStringOption((o) =>
      o
        .setName("rarita")
        .setDescription("Rarità")
        .setRequired(true)
        .addChoices(...commandChoices(RARITA)),
    )
    .addStringOption((o) =>
      o
        .setName("mestiere")
        .setDescription("Mestiere")
        .setRequired(true)
        .setAutocomplete(true),
    )
    .addStringOption((o) =>
      o
        .setName("catalizzatore")
        .setDescription("Catalizzatore principale")
        .setRequired(true)
        .addChoices(...commandChoices(CATALIZZATORI)),
    )
    .addStringOption((o) =>
      o
        .setName("secondo_catalizzatore")
        .setDescription("Secondo catalizzatore")
        .setRequired(true)
        .addChoices(...commandChoices(CATALIZZATORI_CON_NO)),
    )
    .addStringOption((o) =>
      o
        .setName("materiale_tag_1")
        .setDescription("Tag materiale 1")
        .setRequired(false)
        .setAutocomplete(true),
    )
    .addStringOption((o) =>
      o
        .setName("materiale_tag_2")
        .setDescription("Tag materiale 2")
        .setRequired(false)
        .setAutocomplete(true),
    ),
  new SlashCommandBuilder()
    .setName("visualizza_ricetta")
    .setDescription(
      "Visualizza una ricetta. Solo Craft Control, niente turismo.",
    )
    .addStringOption((o) =>
      o
        .setName("ricetta")
        .setDescription("Ricetta")
        .setRequired(true)
        .setAutocomplete(true),
    ),
  new SlashCommandBuilder()
    .setName("lista_ricette")
    .setDescription(
      "Lista le ricette filtrando per mestiere, rarità e tipologia.",
    )
    .addStringOption((o) =>
      o
        .setName("mestiere")
        .setDescription("Mestiere")
        .setRequired(true)
        .setAutocomplete(true),
    )
    .addStringOption((o) =>
      o
        .setName("rarita")
        .setDescription("Rarità")
        .setRequired(true)
        .addChoices(...commandChoices(RARITA)),
    )
    .addStringOption((o) =>
      o
        .setName("tipologia")
        .setDescription("Tipologia oggetto")
        .setRequired(true)
        .addChoices(...commandChoices(TIPI_OGGETTO)),
    ),
  new SlashCommandBuilder()
    .setName("modifica_ricetta")
    .setDescription(
      "Modifica i campi tecnici di una ricetta. Per l'effetto usa modifica_effetto_ricetta.",
    )
    .addStringOption((o) =>
      o
        .setName("ricetta")
        .setDescription("Ricetta da modificare")
        .setRequired(true)
        .setAutocomplete(true),
    )
    .addStringOption((o) =>
      o
        .setName("nome_oggetto")
        .setDescription("Nuovo nome oggetto")
        .setRequired(false),
    )
    .addStringOption((o) =>
      o
        .setName("tipologia")
        .setDescription("Nuova tipologia oggetto")
        .setRequired(false)
        .addChoices(...commandChoices(TIPI_OGGETTO)),
    )
    .addStringOption((o) =>
      o
        .setName("specifica_tipologia")
        .setDescription("Nuova specifica tipologia")
        .setRequired(false),
    )
    .addStringOption((o) =>
      o
        .setName("sintonia")
        .setDescription("Sintonia?")
        .setRequired(false)
        .addChoices(...commandChoices(SI_NO)),
    )
    .addStringOption((o) =>
      o
        .setName("rarita")
        .setDescription("Nuova rarità")
        .setRequired(false)
        .addChoices(...commandChoices(RARITA)),
    )
    .addStringOption((o) =>
      o
        .setName("mestiere")
        .setDescription("Nuovo mestiere")
        .setRequired(false)
        .setAutocomplete(true),
    )
    .addStringOption((o) =>
      o
        .setName("catalizzatore")
        .setDescription("Nuovo catalizzatore principale")
        .setRequired(false)
        .addChoices(...commandChoices(CATALIZZATORI)),
    )
    .addStringOption((o) =>
      o
        .setName("secondo_catalizzatore")
        .setDescription("Nuovo secondo catalizzatore")
        .setRequired(false)
        .addChoices(...commandChoices(CATALIZZATORI_CON_NO)),
    )
    .addStringOption((o) =>
      o
        .setName("materiale_tag_1")
        .setDescription("Nuovo tag materiale 1")
        .setRequired(false)
        .setAutocomplete(true),
    )
    .addStringOption((o) =>
      o
        .setName("materiale_tag_2")
        .setDescription("Nuovo tag materiale 2")
        .setRequired(false)
        .setAutocomplete(true),
    ),
  new SlashCommandBuilder()
    .setName("elimina_ricetta")
    .setDescription("Elimina una ricetta dall'archivio CC.")
    .addStringOption((o) =>
      o
        .setName("ricetta")
        .setDescription("Ricetta da eliminare")
        .setRequired(true)
        .setAutocomplete(true),
    )
    .addStringOption((o) =>
      o
        .setName("conferma")
        .setDescription("Scrivi ELIMINA per confermare")
        .setRequired(true),
    ),
  new SlashCommandBuilder()
    .setName("modifica_effetto_ricetta")
    .setDescription(
      "Modifica l'effetto testuale di una ricetta tramite finestra lunga.",
    )
    .addStringOption((o) =>
      o
        .setName("ricetta")
        .setDescription("Ricetta")
        .setRequired(true)
        .setAutocomplete(true),
    ),
].map((c) => c.toJSON())
async function registerCommands() {
  await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), {
    body: commands,
  })
  console.log("Comandi slash di Giacomo registrati.")
}
function selectMenuOptions(values, focused = "") {
  return values
    .filter((v) => !focused || norm(v).includes(norm(focused)))
    .slice(0, 25)
    .map((v) => ({
      name: String(v).slice(0, 100),
      value: String(v).slice(0, 100),
    }))
}
function extractId(value) {
  const m = String(value || "").match(/\[(\d+)\]\s*$/)
  return m ? Number(m[1]) : Number(value) || null
}
function stripQty(value) {
  return String(value || "")
    .replace(/\s+x\d+$/i, "")
    .trim()
}
async function getRecipeFromOption(value) {
  const id = extractId(value)
  if (id) {
    return db.get("SELECT * FROM recipes WHERE id = ?", id)
  }
  return db.get(
    "SELECT * FROM recipes WHERE lower(nomeOggetto) = lower(?)",
    value,
  )
}
async function handleAutocomplete(interaction) {
  if (REFORGE_COMMAND_NAMES.includes(interaction.commandName)) return reforgeAutocomplete(interaction)
  const focused = interaction.options.getFocused(true)
  const name = focused.name
  const command = interaction.commandName
  let options = []
  if (name === "crafter" || name === "crafter_primario") {
    const rows = await getCharactersByOwner(interaction.user.id)
    options = selectMenuOptions(
      rows.map((r) => `${r.name} [${r.id}]`),
      focused.value,
    )
  } else if (name === "destinatario" || name === "crafter_secondario") {
    const rows = await getAllCharacters()
    options = selectMenuOptions(
      rows.map((r) => `${r.name} [${r.id}]`),
      focused.value,
    )
  } else if (name === "mestiere") {
    options = selectMenuOptions(getAllMestieri(), focused.value)
  } else if (name === "ricetta") {
    const rows = await db.all(
      "SELECT id, nomeOggetto FROM recipes WHERE lower(nomeOggetto) LIKE lower(?) ORDER BY nomeOggetto ASC LIMIT 25",
      `%${focused.value}%`,
    )
    options = rows.map((r) => ({
      name: `${r.nomeOggetto} [${r.id}]`.slice(0, 100),
      value: `${r.nomeOggetto} [${r.id}]`.slice(0, 100),
    }))
  } else if (name.startsWith("materiale_tag")) {
    options = selectMenuOptions(getAllTags(), focused.value)
  } else if (name === "materiale_1" || name === "materiale_2") {
    const crafterOptionName =
      command.includes("combinato") ? "crafter_primario" : "crafter"
    const crafterId = extractId(
      interaction.options.getString(crafterOptionName),
    )
    if (crafterId) {
      const rows = await getMaterialsInventory(crafterId)
      let requiredTag = ""
      let requiredRarity = ""
      let mestiere = interaction.options.getString("mestiere") || ""
      if (
        command === "craft_da_ricetta" ||
        command === "craft_combinato_da_ricetta"
      ) {
        const recipe = await getRecipeFromOption(
          interaction.options.getString("ricetta"),
        )
        if (recipe) {
          requiredTag =
            name === "materiale_1" ? recipe.materialeTag1 : recipe.materialeTag2
          requiredRarity =
            CRAFT_RULES[norm(recipe.rarita)]?.materialRarity || ""
          mestiere = recipe.mestiere
        }
      } else {
        requiredRarity =
          CRAFT_RULES[norm(interaction.options.getString("rarita"))]
            ?.materialRarity || ""
      }
const filtered = rows.filter((r) =>
  materialMatches({
    meta: findMaterialMetadata(r.material),
    requiredRarity,
    mestiere: "",
    requiredTag,
  }),
)
      options = selectMenuOptions(
        filtered.map((r) => `${r.material} x${r.quantity}`),
        focused.value,
      )
    }
  }
  await interaction.respond(options.slice(0, 25)).catch(() => {})
}
async function requireCC(interaction) {
  if (!isCraftControl(interaction.member)) {
    await replyError(
      interaction,
      "Questo archivio è riservato al Craft Control. I curiosi fuori dalla porta.",
    )
    return false
  }
  return true
}
async function handleAddRecipe(interaction) {
  if (!(await requireCC(interaction))) return
  const payload = {
    nomeOggetto: interaction.options.getString("nome_oggetto"),
    tipologiaOggetto: interaction.options.getString("tipologia"),
    specificaTipologia: interaction.options.getString("specifica_tipologia"),
    sintonia: yesNoBool(interaction.options.getString("sintonia")) ? 1 : 0,
    rarita: interaction.options.getString("rarita"),
    mestiere: interaction.options.getString("mestiere"),
    catalizzatore1: interaction.options.getString("catalizzatore"),
    catalizzatore2: interaction.options.getString("secondo_catalizzatore"),
    materialeTag1: cleanEmojiTags(
      interaction.options.getString("materiale_tag_1") || "",
    ),
    materialeTag2: cleanEmojiTags(
      interaction.options.getString("materiale_tag_2") || "",
    ),
    createdBy: interaction.user.id,
  }
  const key = `${interaction.user.id}:${Date.now()}`
  pendingRecipeCreates.set(key, payload)
  const modal = new ModalBuilder()
    .setCustomId(`recipe_create:${key}`)
    .setTitle("Effetto Oggetto")
  const input = new TextInputBuilder()
    .setCustomId("effetto")
    .setLabel("Incolla effetto oggetto")
    .setStyle(TextInputStyle.Paragraph)
    .setRequired(false)
    .setMaxLength(3900)
  modal.addComponents(new ActionRowBuilder().addComponents(input))
  await interaction.showModal(modal)
}
async function handleRecipeCreateModal(interaction, key) {
  const payload = pendingRecipeCreates.get(key)
  if (!payload) {
    return replyError(
      interaction,
      "Sessione scaduta. Giacomo non conserva foglietti unti all'infinito.",
    )
  }
  pendingRecipeCreates.delete(key)
  const now = DateTime.utc().toISO()
  const effetto = interaction.fields.getTextInputValue("effetto") || ""
  try {
    await db.run(
      `INSERT INTO recipes ( nomeOggetto, tipologiaOggetto, specificaTipologia, sintonia, rarita, mestiere, catalizzatore1, catalizzatore2, materialeTag1, materialeTag2, effettoOggetto, createdBy, createdAt, updatedAt ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
      now,
    )
    const recipe = await db.get(
      "SELECT * FROM recipes WHERE lower(nomeOggetto) = lower(?)",
      payload.nomeOggetto,
    )
    await interaction.reply({
      content: `🗂️ **Giacomo:** ${pick(GIACOMO_LINES)} Ricetta salvata.`,
      embeds: [recipeEmbed(recipe)],
      ephemeral: true,
    })
  } catch (err) {
    await replyError(
      interaction,
      `Non ho salvato la ricetta. Forse esiste già una ricetta con questo nome.\n\`${err.message}\``,
    )
  }
}
async function handleModifyEffect(interaction) {
  if (!(await requireCC(interaction))) return
  const recipe = await getRecipeFromOption(
    interaction.options.getString("ricetta"),
  )
  if (!recipe) {
    return replyError(interaction, "Ricetta non trovata.")
  }
  const key = `${interaction.user.id}:${recipe.id}:${Date.now()}`
  pendingRecipeEdits.set(key, recipe.id)
  const modal = new ModalBuilder()
    .setCustomId(`recipe_effect:${key}`)
    .setTitle(`Effetto: ${recipe.nomeOggetto}`.slice(0, 45))
  const input = new TextInputBuilder()
    .setCustomId("effetto")
    .setLabel("Nuovo effetto oggetto")
    .setStyle(TextInputStyle.Paragraph)
    .setRequired(false)
    .setMaxLength(3900)
    .setValue(String(recipe.effettoOggetto || "").slice(0, 3900))
  modal.addComponents(new ActionRowBuilder().addComponents(input))
  await interaction.showModal(modal)
}
async function handleRecipeEffectModal(interaction, key) {
  const recipeId = pendingRecipeEdits.get(key)
  if (!recipeId) {
    return replyError(
      interaction,
      "Sessione scaduta. Colpa del tempo, non mia.",
    )
  }
  pendingRecipeEdits.delete(key)
  const effetto = interaction.fields.getTextInputValue("effetto") || ""
  await db.run(
    "UPDATE recipes SET effettoOggetto = ?, updatedAt = ? WHERE id = ?",
    effetto,
    DateTime.utc().toISO(),
    recipeId,
  )
  const recipe = await db.get("SELECT * FROM recipes WHERE id = ?", recipeId)
  await interaction.reply({
    content:
      "🗂️ **Giacomo:** Effetto aggiornato. La letteratura è salva, più o meno.",
    embeds: [recipeEmbed(recipe)],
    ephemeral: true,
  })
}
async function handleCommand(interaction) {
  if (interaction.commandName === "registra_giorni_craft") return registerManualCraftDays(interaction)
  if (CRAFT_COMMAND_NAMES.includes(interaction.commandName)) {
    if (!isBeta(interaction.member)) {
      return replyError(
        interaction,
        "Serve il ruolo Beta. Evidentemente la burocrazia ha ancora una funzione.",
      )
    }
    if (!inCraftChannel(interaction)) {
      return replyError(
        interaction,
        "Questo comando va usato nella zona crafting. Non ovunque come coriandoli.",
      )
    }
  }
  if (CRAFT_COMMAND_NAMES.includes(interaction.commandName) && interaction.commandName !== "riforgia" && !activityContext.getStore()) {
    return runCraftTransaction(interaction)
  }
  if (REFORGE_COMMAND_NAMES.includes(interaction.commandName)) return handleReforgeCommand(interaction)
    if (interaction.commandName === "craft_speciale") {
    return executeSpecialCraft(interaction)
  }
    if (interaction.commandName === "craft_speciale_combinato") {
    return executeSpecialCombinedCraft(interaction)
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
      recipientId: extractId(interaction.options.getString("destinatario")),
      bonusExtra: interaction.options.getInteger("bonus_extra") || 0,
    })
  }
  if (interaction.commandName === "craft_da_ricetta") {
    const recipe = await getRecipeFromOption(
      interaction.options.getString("ricetta"),
    )
    if (!recipe) {
      return replyError(
        interaction,
        "Ricetta non trovata. Archivio consultato, dignità persa.",
      )
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
      bonusExtra: interaction.options.getInteger("bonus_extra") || 0,
      recipe,
    })
  }
  if (interaction.commandName === "craft_combinato") {
    return executeCombinedCraft({
      interaction,
      primaryCrafterId: extractId(
        interaction.options.getString("crafter_primario"),
      ),
      secondaryCrafterId: extractId(
        interaction.options.getString("crafter_secondario"),
      ),
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
      recipientId: extractId(interaction.options.getString("destinatario")),
      bonusPrimary: interaction.options.getInteger("bonus_primario") || 0,
      bonusSecondary: interaction.options.getInteger("bonus_secondario") || 0,
      secondaryPayment:
        interaction.options.getInteger("pagamento_secondario") || 0,
    })
  }
  if (interaction.commandName === "craft_combinato_da_ricetta") {
    const recipe = await getRecipeFromOption(
      interaction.options.getString("ricetta"),
    )
    if (!recipe) {
      return replyError(
        interaction,
        "Ricetta non trovata. Archivio consultato, dignità persa.",
      )
    }
    return executeCombinedCraft({
      interaction,
      primaryCrafterId: extractId(
        interaction.options.getString("crafter_primario"),
      ),
      secondaryCrafterId: extractId(
        interaction.options.getString("crafter_secondario"),
      ),
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
      bonusPrimary: interaction.options.getInteger("bonus_primario") || 0,
      bonusSecondary: interaction.options.getInteger("bonus_secondario") || 0,
      secondaryPayment:
        interaction.options.getInteger("pagamento_secondario") || 0,
      recipe,
    })
  }
  if (interaction.commandName === "aggiungi_ricetta") {
    return handleAddRecipe(interaction)
  }
  if (interaction.commandName === "modifica_effetto_ricetta") {
    return handleModifyEffect(interaction)
  }
  if (interaction.commandName === "visualizza_ricetta") {
    if (!(await requireCC(interaction))) return
    const recipe = await getRecipeFromOption(
      interaction.options.getString("ricetta"),
    )
    if (!recipe) {
      return replyError(interaction, "Ricetta non trovata.")
    }
    return interaction.reply({ embeds: [recipeEmbed(recipe)], ephemeral: true })
  }
  if (interaction.commandName === "lista_ricette") {
    if (!(await requireCC(interaction))) return
    const mestiere = interaction.options.getString("mestiere")
    const rarita = interaction.options.getString("rarita")
    const tipologia = interaction.options.getString("tipologia")
    const rows = await db.all(
      "SELECT nomeOggetto FROM recipes WHERE lower(mestiere)=lower(?) AND lower(rarita)=lower(?) AND lower(tipologiaOggetto)=lower(?) ORDER BY nomeOggetto ASC",
      mestiere,
      rarita,
      tipologia,
    )
    const list =
      rows.length ?
        rows.map((r) => `• ${r.nomeOggetto}`).join("\n")
      : "Nessuna ricetta. Il deserto creativo, ma con filtro."
    const embed = new EmbedBuilder()
      .setTitle("📚 Lista ricette")
      .setDescription(list.slice(0, 3900))
      .addFields(
        { name: "Mestiere", value: mestiere, inline: true },
        { name: "Rarità", value: rarita, inline: true },
        { name: "Tipologia", value: tipologia, inline: true },
      )
      .setColor(0xf59e0b)
      .setFooter({
        text: "Prima mestiere, poi rarità, poi tipologia. Ordine: questa cosa sconosciuta.",
      })
    return interaction.reply({ embeds: [embed], ephemeral: true })
  }
  if (interaction.commandName === "modifica_ricetta") {
    if (!(await requireCC(interaction))) return
    const recipe = await getRecipeFromOption(
      interaction.options.getString("ricetta"),
    )
    if (!recipe) {
      return replyError(interaction, "Ricetta non trovata.")
    }
    const updates = {
      nomeOggetto:
        interaction.options.getString("nome_oggetto") ?? recipe.nomeOggetto,
      tipologiaOggetto:
        interaction.options.getString("tipologia") ?? recipe.tipologiaOggetto,
      specificaTipologia:
        interaction.options.getString("specifica_tipologia") ??
        recipe.specificaTipologia,
      sintonia:
        interaction.options.getString("sintonia") ?
          yesNoBool(interaction.options.getString("sintonia")) ? 1
          : 0
        : recipe.sintonia,
      rarita: interaction.options.getString("rarita") ?? recipe.rarita,
      mestiere: interaction.options.getString("mestiere") ?? recipe.mestiere,
      catalizzatore1:
        interaction.options.getString("catalizzatore") ?? recipe.catalizzatore1,
      catalizzatore2:
        interaction.options.getString("secondo_catalizzatore") ??
        recipe.catalizzatore2,
      materialeTag1:
        interaction.options.getString("materiale_tag_1") != null ?
          cleanEmojiTags(interaction.options.getString("materiale_tag_1"))
        : recipe.materialeTag1,
      materialeTag2:
        interaction.options.getString("materiale_tag_2") != null ?
          cleanEmojiTags(interaction.options.getString("materiale_tag_2"))
        : recipe.materialeTag2,
    }
    try {
      await db.run(
        `UPDATE recipes SET nomeOggetto = ?, tipologiaOggetto = ?, specificaTipologia = ?, sintonia = ?, rarita = ?, mestiere = ?, catalizzatore1 = ?, catalizzatore2 = ?, materialeTag1 = ?, materialeTag2 = ?, updatedAt = ? WHERE id = ?`,
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
        recipe.id,
      )
      const fresh = await db.get(
        "SELECT * FROM recipes WHERE id = ?",
        recipe.id,
      )
      return interaction.reply({
        content: `🗂️ **Giacomo:** ${pick(GIACOMO_LINES)} Ricetta modificata. Per l'effetto testuale usa \`/modifica_effetto_ricetta\`.`,
        embeds: [recipeEmbed(fresh)],
        ephemeral: true,
      })
    } catch (err) {
      return replyError(
        interaction,
        `Modifica fallita. Probabilmente un nome duplicato, perché ovviamente.\n\`${err.message}\``,
      )
    }
  }
  if (interaction.commandName === "elimina_ricetta") {
    if (!(await requireCC(interaction))) return
    const confirm = interaction.options.getString("conferma")
    if (confirm !== "ELIMINA") {
      return replyError(
        interaction,
        "Per eliminare devi scrivere esattamente `ELIMINA`. Sì, urlando. Aiuta a capire la gravità.",
      )
    }
    const recipe = await getRecipeFromOption(
      interaction.options.getString("ricetta"),
    )
    if (!recipe) {
      return replyError(interaction, "Ricetta non trovata.")
    }
    await db.run("DELETE FROM recipes WHERE id = ?", recipe.id)
    return interaction.reply({
      content: `🗑️ **Giacomo:** Ricetta **${recipe.nomeOggetto}** eliminata. Una lapide sarà protocollata entro 3-5 giorni lavorativi.`,
      ephemeral: true,
    })
  }
}
client.on("interactionCreate", async (interaction) => {
  try {
    if (interaction.isAutocomplete()) {
      return await handleAutocomplete(interaction)
    }
    if (interaction.isModalSubmit()) {
      if (interaction.customId.startsWith("recipe_create:")) {
        return await handleRecipeCreateModal(
          interaction,
          interaction.customId.replace("recipe_create:", ""),
        )
      }
      if (interaction.customId.startsWith("recipe_effect:")) {
        return await handleRecipeEffectModal(
          interaction,
          interaction.customId.replace("recipe_effect:", ""),
        )
      }
    }
    if (interaction.isChatInputCommand()) {
      return await handleCommand(interaction)
    }
  } catch (err) {
    console.error("Errore interactionCreate:", err)
    const payload = {
      content: `🗂️ **Giacomo:** ${pick(ERROR_LINES)}\n\`${String(err.message || err).slice(0, 1500)}\``,
      ephemeral: true,
    }
    if (interaction.deferred || interaction.replied) {
      await interaction.followUp(payload).catch(() => {})
    } else {
      await interaction.reply(payload).catch(() => {})
    }
  }
})
client.once("ready", async () => {
  console.log(
    `Giacomo operativo come ${client.user.tag}. Purtroppo per gli utenti.`,
  )
  await checkPendingCrafts()
  await checkPendingReforges()
  setInterval(checkPendingCrafts, CHECK_INTERVAL_MS)
  setInterval(checkPendingReforges, CHECK_INTERVAL_MS)
})
await initDB()
await registerCommands()
client.login(TOKEN)
