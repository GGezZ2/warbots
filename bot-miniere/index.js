import {
  Client,
  GatewayIntentBits,
  EmbedBuilder,
  ActivityType,
  REST,
  Routes,
  SlashCommandBuilder
} from "discord.js";

import fs from "fs";
import path from "path";
import dotenv from "dotenv";
import sqlite3 from "sqlite3";
import { open } from "sqlite";
import { fileURLToPath } from "url";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const TOKEN = process.env.MINIERE_TOKEN?.trim();
const CLIENT_ID = process.env.MINIERE_CLIENT_ID?.trim() || process.env.CLIENT_ID?.trim();
const GUILD_ID = process.env.GUILD_ID?.trim();

const DB_PATH = process.env.WESTMARCH_DB_PATH || process.env.DB_PATH || "/data/westmarch.db";
const NOME_BOT = "Grumni Picconaccia";
const BETA_ROLE_NAME = "Beta";
const GM_ROLE_NAME = "gm-bot";

if (!TOKEN || !CLIENT_ID || !GUILD_ID) {
  console.error("Mancano variabili Railway. Servono MINIERE_TOKEN, MINIERE_CLIENT_ID e GUILD_ID.");
  process.exit(1);
}

const dataDir = path.join(__dirname, "data");
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

const MINIERE_FILE =
  process.env.MINIERE_FILE_PATH?.trim() ||
  (fs.existsSync(path.join(__dirname, "data", "miniere.json"))
    ? path.join(__dirname, "data", "miniere.json")
    : path.join(__dirname, "miniere.json"));

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

    CREATE TABLE IF NOT EXISTS weekly_farms (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      characterId INTEGER NOT NULL,
      weekStart TEXT NOT NULL,
      count INTEGER NOT NULL DEFAULT 0,
      UNIQUE(characterId, weekStart),
      FOREIGN KEY (characterId) REFERENCES characters(id)
    );

    CREATE TABLE IF NOT EXISTS farm_days (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      characterId INTEGER NOT NULL,
      farmDate TEXT NOT NULL,
      createdAt TEXT NOT NULL,
      UNIQUE(characterId, farmDate),
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
  `);

  console.log(`SQLite Miniere collegato a: ${DB_PATH}`);
}

await initDB();

const client = new Client({
  intents: [GatewayIntentBits.Guilds]
});

const rest = new REST({ version: "10" }).setToken(TOKEN);

// === FRASI SASSY ===

const FRASI_ZERO = [
  "💨 **{pg}** ha scavato nella **{miniera}** col carisma di un cucchiaio di legno. Risultato? NIENTE. Come la tua vita sentimentale, sociale e professionale.",
  "🦗 Ah **{pg}**, sei tornato dalla **{miniera}** a mani vuote. Di nuovo. A questo punto è una tradizione di famiglia, no?",
  "😂 La **{miniera}** ha visto arrivare **{pg}** e ha nascosto tutto. TUTTO. Neanche i sassi ti vogliono. Pensa un po'.",
  "🪨 **{pg}** ha picconato per ore nella **{miniera}**. Ha trovato? La consapevolezza che anche come minatore fai cagare. Gratis, nemmeno quella meritavi.",
  "💀 **{pg}**, sei andato nella **{miniera}** e sei tornato con niente. Mia nonna morta scaverebbe meglio. Con un cucchiaino. Bendata. Sott'acqua.",
  "🤡 Complimenti **{pg}**! Hai trasformato la **{miniera}** in una passeggiata della vergogna. Zero materiali, zero dignità, zero speranza. Il trittico perfetto.",
  "🫠 Il dado ha guardato **{pg}** negli occhi, ha riso forte, e gli ha dato un calcio nel culo. ZERO dalla **{miniera}**. Meritatissimo.",
  "🐛 **{pg}** dalla **{miniera}** porta a casa: delusione, imbarazzo e l'odore di chi ha fallito. Di nuovo. Come sempre.",
  "💩 Ma che piccone usa **{pg}**? Uno fatto di formaggio? La **{miniera}** gli ha dato ZERO e onestamente ha fatto bene.",
  "🪦 R.I.P. la dignità di **{pg}**, morta nella **{miniera}** alle ore {ora}. Non mancherà a nessuno.",
  "🗑️ **{pg}** è l'unico essere vivente che riesce a entrare in una miniera piena di roba e uscire con NIENTE. Darwin aveva ragione.",
  "🤮 **{pg}** nella **{miniera}**: zero materiali. Se la mediocrità fosse un minerale, saresti ricchissimo.",
  "☠️ Sai cosa hanno in comune **{pg}** e la **{miniera}**? Niente. **{pg}** non ha niente. La miniera ce l'ha ma non glielo dà. Bellissimo."
];

const FRASI_TROVATO_1 = [
  "⛏️ Oh. Oh. **{pg}** ha trovato **{q}x {mat}** nella **{miniera}**. Non eccitarti troppo, è UNO. Uno solo. Come i tuoi neuroni funzionanti.",
  "🎉 **{pg}** trova **{q}x {mat}** nella **{miniera}**! Wow, un intero materiale. Applauso? Col cazzo. Torna quando ne trovi due, sfigato.",
  "💎 **{q}x {mat}** dalla **{miniera}** per **{pg}**. Sì ok, bravo. Mio cugino ne trova 10 al giorno e ha un braccio solo, ma non tutti possono.",
  "🔨 *toc toc*... **{q}x {mat}**! **{pg}**, la **{miniera}** ti ha fatto la carità. Come la mensa dei poveri. Ringrazia e sparisci.",
  "✨ **{pg}** estrae **{q}x {mat}** dalla **{miniera}**. Uno. Singolo. Solitario. Come te il sabato sera.",
  "🪙 **{q}x {mat}** dalla **{miniera}**. **{pg}**, tecnicamente è un successo. Come tecnicamente anche un orologio rotto segna l'ora giusta due volte al giorno.",
  "⛏️ **{pg}**, **{q}x {mat}** dalla **{miniera}**. Oh wow. La mia ascia è più impressionata di me, e la mia ascia non ha sentimenti.",
  "🥉 **{q}x {mat}**! **{pg}**, hai il talento minerario di una patata. Ma almeno la patata è utile in cucina.",
  "🐌 **{pg}** ha trovato **{q}x {mat}** nella **{miniera}**! Con la velocità e l'efficienza di una lumaca morta. Ma ehi, conta il risultato... forse.",
  "🧻 **{q}x {mat}** dalla **{miniera}** per **{pg}**. Mettilo in tasca, è probabilmente la cosa più preziosa che possiedi."
];

const FRASI_TROVATO_2 = [
  "🔥🔥 ...Ma che cazzo?! **{pg}** tira fuori **{q}x {mat}** dalla **{miniera}**?! Ok ammetto che sono quasi — QUASI — impressionato. Non ti montare la testa.",
  "💎💎 **{q}x {mat}**?! Dalla **{miniera}**?! **{pg}**, o hai barato, il dado è truccato, o l'universo ha avuto un ictus.",
  "⛏️⛏️ DUE?! **{q}x {mat}** dalla **{miniera}**?! **{pg}**, mi stai facendo riconsiderare tutto quello che ho detto su di te. Scherzo, fai ancora schifo. Ma meno.",
  "🌟🌟 Per la barba di mio nonno! **{pg}** trova **{q}x {mat}** dalla **{miniera}**! Il dado ti ama più di quanto chiunque ti abbia mai amato nella vita reale.",
  "🎰🎰 **{q}x {mat}**! **{pg}**, hai venduto l'anima a qualche demone? Perché con quel faccino non è possibile avere 'sta fortuna naturalmente.",
  "💥💥 DOPPIETTA **{q}x {mat}** dalla **{miniera}**! **{pg}**, goditi questo momento. Fotografalo. Stampalo. Perché non ricapiterà MAI PIÙ.",
  "👑👑 **{q}x {mat}**! **{pg}** dalla **{miniera}** come un re! ...Un re di un regno di merda, governato da incompetenti, ma pur sempre un re.",
  "🍀🍀 MA VAFFAN— ok ok. **{q}x {mat}** dalla **{miniera}** per **{pg}**. Mi rode il culo ammetterlo ma... bravo. Ora VATTENE.",
  "😤😤 **{q}x {mat}** dalla **{miniera}**. **{pg}**, sai quanto mi fa incazzare quando uno come te trova roba? TANTO. Goditela, stronzo fortunato.",
  "🏆🏆 Non ci credo. **{q}x {mat}** dalla **{miniera}** per **{pg}**. Devo bere. Dove cazzo è la mia birra."
];

const FRASI_NON_COMUNE_ZERO = [
  "😬 **{pg}** ha cercato **{mat}** nella **{miniera}**... materiale NON COMUNE, genio. Serviva almeno 9 e tu hai tirato come mia zia cieca al bingo. Patetico.",
  "🫥 **{mat}**? Nella **{miniera}**? **{pg}**, per i non comuni devi tirare ALTO. Non con queste manine da impiegato delle poste in pausa caffè.",
  "🪨 **{pg}** cerca **{mat}** nella **{miniera}** e fallisce. Come al solito. Per i non comuni serve fortuna, e tu sei nato sotto una stella morta.",
  "💤 La **{miniera}** tiene stretti i suoi **{mat}**. Non li dà ai dilettanti come **{pg}**. Torna quando il dado smette di odiarti.",
  "🚫 **{pg}** voleva **{mat}** dalla **{miniera}**. La **{miniera}** voleva che **{pg}** andasse a fare in culo. Indovina chi ha vinto?",
  "🤏 Soooo vicino a trovare **{mat}**... AHAHAHAHA no sto scherzando. **{pg}** non era neanche nella stessa galassia.",
  "🐀 **{pg}**, cercare **{mat}** col tuo tiro è come cercare di leccarti il gomito. Puoi provarci, ma fai solo ridere gli altri.",
  "🎪 **{pg}** cercava **{mat}** nella **{miniera}**? Che spettacolo comico. Prossima volta vendo i biglietti."
];

const FRASI_NO_PG = [
  "🚫 {name}, chi cazzo sei? Non hai personaggi nel registro. Vai dall'altro bot e creane uno prima di rompere il cazzo a me.",
  "🤷 {name}, zero personaggi. Sei un fantasma. Un nessuno. Vai a creare un PG e poi torna.",
  "😤 {name}, vuoi farmare senza neanche un personaggio?! È come presentarti a una guerra senza armi e senza vestiti.",
  "🪦 {name}, non esisti nel mio registro. Per me sei aria. Crea un PG col bot principale e poi ne riparliamo.",
  "🤡 {name} prova a farmare senza personaggio. SENZA PERSONAGGIO. Fatti una vita prima, poi una scheda."
];

// === UTILS ===

function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function randInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function capitalize(s) {
  if (!s) return "";
  return String(s).charAt(0).toUpperCase() + String(s).slice(1);
}

function fmt(template, vars) {
  return template.replace(/\{(\w+)\}/g, (_, k) => vars[k] ?? `{${k}}`);
}

function nowRome() {
  return new Intl.DateTimeFormat("it-IT", {
    timeZone: "Europe/Rome",
    dateStyle: "short",
    timeStyle: "short"
  }).format(new Date());
}

function hasRole(member, roleName) {
  try {
    return member?.roles?.cache?.some(r => normalizeText(r.name) === normalizeText(roleName));
  } catch {
    return false;
  }
}

function loadJSON(filepath, defaultVal = {}) {
  try {
    if (fs.existsSync(filepath)) {
      return JSON.parse(fs.readFileSync(filepath, "utf-8"));
    }
  } catch (e) {
    console.error(`Errore lettura ${filepath}:`, e.message);
  }

  saveJSON(filepath, defaultVal);
  return defaultVal;
}

function saveJSON(filepath, data) {
  fs.writeFileSync(filepath, JSON.stringify(data, null, 2), "utf-8");
}

function normalizeText(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ");
}

function getProficiencyBonus(level) {
  if (level >= 17) return 6;
  if (level >= 13) return 5;
  if (level >= 9) return 4;
  if (level >= 5) return 3;
  return 2;
}

function getRomeDateParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Rome",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(date);

  const get = type => Number(parts.find(p => p.type === type).value);

  return {
    year: get("year"),
    month: get("month"),
    day: get("day")
  };
}

function getCurrentRomeDateKey() {
  const { year, month, day } = getRomeDateParts();

  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function addDaysToDateKey(dateKey, daysToAdd) {
  const [year, month, day] = dateKey.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));

  date.setUTCDate(date.getUTCDate() + daysToAdd);

  return date.toISOString().slice(0, 10);
}

function formatDateKeyItalian(dateKey) {
  const [year, month, day] = dateKey.split("-").map(Number);

  return `${String(day).padStart(2, "0")}/${String(month).padStart(2, "0")}/${year}`;
}

function getWeekStartKeyFromDateKey(dateKey) {
  const [year, month, day] = dateKey.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  const dayOfWeek = date.getUTCDay();
  const daysSinceMonday = dayOfWeek === 0 ? 6 : dayOfWeek - 1;

  date.setUTCDate(date.getUTCDate() - daysSinceMonday);

  return date.toISOString().slice(0, 10);
}

function getCurrentWeekStartKey() {
  return getWeekStartKeyFromDateKey(getCurrentRomeDateKey());
}

function getWeekEndKeyFromWeekStart(weekStartKey) {
  return addDaysToDateKey(weekStartKey, 6);
}

function caricaMiniere() {
  const data = loadJSON(MINIERE_FILE);
  const numMiniere = Object.keys(data).length;

  if (numMiniere === 0) {
    console.warn(`⚠️ miniere.json vuoto o non trovato in ${MINIERE_FILE}`);
  }

  return data;
}

function getNome(mat) {
  if (typeof mat === "object" && mat !== null) {
    return normalizeText(mat.nome || mat.name || mat.materiale || mat.material || "");
  }

  return normalizeText(mat);
}

function getNomeDisplay(mat) {
  if (typeof mat === "object" && mat !== null) {
    return String(mat.nome || mat.name || mat.materiale || mat.material || "").trim();
  }

  return String(mat || "").trim();
}

function getMestieri(mat) {
  if (typeof mat !== "object" || mat === null) return [];

  const raw =
    mat.mestieri ??
    mat.mestiere ??
    mat.professioni ??
    mat.professione ??
    mat.craft ??
    [];

  if (Array.isArray(raw)) {
    return raw.map(x => String(x).trim()).filter(Boolean);
  }

  if (typeof raw === "string") {
    return raw
      .split(",")
      .map(x => x.trim())
      .filter(Boolean);
  }

  return [];
}

function getTags(mat) {
  if (typeof mat !== "object" || mat === null) return "";

  const raw =
    mat.tags ??
    mat.tag ??
    mat.tipo ??
    mat.categoria ??
    "";

  if (Array.isArray(raw)) {
    return raw.filter(Boolean).join(", ");
  }

  return String(raw || "").trim();
}

function formatMaterialRarity(rarity) {
  switch (normalizeText(rarity)) {
    case "comuni":
    case "comune":
      return "Comune";

    case "non_comuni":
    case "non_comune":
    case "non comune":
      return "Non Comune";

    case "raro":
      return "Raro";

    case "molto_raro":
    case "molto raro":
      return "Molto Raro";

    case "leggendario":
      return "Leggendario";

    default:
      return "Rarità non specificata";
  }
}

function findMaterialMetadata(materialName) {
  const miniere = caricaMiniere();
  const target = normalizeText(materialName);

  for (const dati of Object.values(miniere)) {
    const groups = [
      {
        materials: Array.isArray(dati.comuni)
          ? dati.comuni
          : [],
        rarity: "comune"
      },
      {
        materials: Array.isArray(dati.non_comuni)
          ? dati.non_comuni
          : [],
        rarity: "non_comune"
      },
      {
        materials: Array.isArray(dati.nonComuni)
          ? dati.nonComuni
          : [],
        rarity: "non_comune"
      }
    ];

    for (const group of groups) {
      for (const mat of group.materials) {
        if (getNome(mat) === target) {
          return {
            nome: getNomeDisplay(mat) || String(materialName),
            tags: getTags(mat),
            mestieri: getMestieri(mat),
            rarity: group.rarity
          };
        }
      }
    }
  }

  return {
    nome: String(materialName || "").trim(),
    tags: "",
    mestieri: [],
    rarity: ""
  };
}

function formatMaterialWithMetadata(row) {
  if (row.shotName !== null && row.shotName !== undefined) {
    const tags = row.shotTags
      ? `${row.shotTags} `
      : "";

    const mestieri = row.shotMestieri
      ? ` [${row.shotMestieri}]`
      : "";

    const description = row.shotDescription
      ? ` — ${row.shotDescription}`
      : "";

    const rarity = formatMaterialRarity(row.shotRarity);

    return (
      `${row.quantity}x ${tags}${row.shotName}` +
      ` — ${rarity}${mestieri}${description}`
    );
  }

  const meta = findMaterialMetadata(row.material);

  const tags = meta.tags
    ? `${meta.tags} `
    : "";

  const mestieri = meta.mestieri.length
    ? ` [${meta.mestieri.map(capitalize).join(", ")}]`
    : "";

  const rarity = formatMaterialRarity(meta.rarity);

  return (
    `${row.quantity}x ${tags}${capitalize(meta.nome || row.material)}` +
    ` — ${rarity}${mestieri}`
  );
}
function formatMaterials(rows) {
  if (!rows.length) return "Vuoto";
  return rows.map(formatMaterialWithMetadata).join(", ");
}

function splitEmbedFieldValue(text, maxLength = 1024) {
  if (text.length <= maxLength) return [text];

  const chunks = [];
  let chunk = "";

  for (const entry of text.split(", ")) {
    const next = chunk ? `${chunk}, ${entry}` : entry;

    if (next.length <= maxLength) {
      chunk = next;
      continue;
    }

    if (chunk) chunks.push(chunk);

    // Caso eccezionale: un singolo materiale supera il limite di Discord.
    if (entry.length > maxLength) {
      for (let i = 0; i < entry.length; i += maxLength) {
        chunks.push(entry.slice(i, i + maxLength));
      }
      chunk = "";
    } else {
      chunk = entry;
    }
  }

  if (chunk) chunks.push(chunk);
  return chunks;
}

function formatMaterialNameForEmbed(materiale, tags = "", mestieri = []) {
  const tagText = tags ? `${tags} ` : "";
  const mestieriText = mestieri.length
    ? ` [${mestieri.map(capitalize).join(", ")}]`
    : "";

  return `${tagText}${capitalize(materiale)}${mestieriText}`;
}

function trovaMateriale(miniere, nomeMat) {
  const nl = normalizeText(nomeMat);

  for (const [miniera, dati] of Object.entries(miniere)) {
    for (const mat of (dati.comuni || [])) {
      if (getNome(mat) === nl) {
        const display = getNomeDisplay(mat);

        return {
          miniera,
          materiale: display || nomeMat,
          rarita: "comuni",
          mestieri: getMestieri(mat),
          tags: getTags(mat)
        };
      }
    }

    for (const mat of (dati.non_comuni || [])) {
      if (getNome(mat) === nl) {
        const display = getNomeDisplay(mat);

        return {
          miniera,
          materiale: display || nomeMat,
          rarita: "non_comuni",
          mestieri: getMestieri(mat),
          tags: getTags(mat)
        };
      }
    }
  }

  return null;
}

function tuttiNomiMateriali(miniere) {
  const nomi = new Set();

  for (const dati of Object.values(miniere)) {
    for (const mat of [...(dati.comuni || []), ...(dati.non_comuni || [])]) {
      const nome = getNomeDisplay(mat) || getNome(mat);
      if (nome) nomi.add(nome.toLowerCase());
    }
  }

  return [...nomi].sort((a, b) => a.localeCompare(b));
}

function tuttiNomiMiniere(miniere) {
  return Object.keys(miniere).sort((a, b) => a.localeCompare(b));
}

function suggerisciMateriale(miniere, input, max = 3) {
  const il = normalizeText(input);
  const nomi = tuttiNomiMateriali(miniere);
  const sugg = [];

  for (const nome of nomi) {
    const normalizedNome = normalizeText(nome);

    if (il.includes(normalizedNome) || normalizedNome.includes(il)) {
      sugg.push([0, nome]);
      continue;
    }

    let cs = 0;

    for (let i = 0; i < Math.min(il.length, normalizedNome.length); i++) {
      if (il[i] === normalizedNome[i]) cs++;
      else break;
    }

    if (cs >= 3) {
      sugg.push([1, nome]);
      continue;
    }

    const pi = new Set(il.split(" "));
    const pn = new Set(normalizedNome.split(" "));

    if ([...pi].some(w => pn.has(w))) {
      sugg.push([2, nome]);
    }
  }

  sugg.sort((a, b) => a[0] - b[0]);
  return sugg.slice(0, max).map(s => s[1]);
}

function calcolaRisultato(dado, fortezza, rarita) {
  const totale = dado + fortezza;

  if (rarita === "comuni") {
    if (totale <= 3) return 0;
    if (totale <= 8) return 1;
    return 2;
  }

  if (totale <= 8) return 0;
  if (totale <= 11) return 1;
  return 2;
}

function getEffectiveFortress(fortress) {
  if (fortress) return fortress;

  return {
    name: "Nessuna fortezza",
    level: 0
  };
}

// === DB HELPERS ===

async function getPersonaggiUtente(userId) {
  return db.all(
    "SELECT id, playerId, name, xp, gold, bank, level FROM characters WHERE playerId = ? ORDER BY id ASC",
    String(userId)
  );
}

async function getPersonaggioByName(userId, nomePg) {
  return db.get(
    "SELECT id, playerId, name, xp, gold, bank, level FROM characters WHERE playerId = ? AND lower(name) = lower(?)",
    String(userId),
    nomePg
  );
}

async function getMaterialsInventory(characterId) {
  return db.all(
    `SELECT
       i.material,
       i.quantity,
       s.name AS shotName,
       s.tags AS shotTags,
       s.mestieri AS shotMestieri,
       s.description AS shotDescription,
       s.rarity AS shotRarity
     FROM materials_inventory i
     LEFT JOIN shot_materials s ON s.material = i.material
     WHERE i.characterId = ? AND i.quantity > 0
     ORDER BY i.material ASC`,
    characterId
  );
}

async function addMaterialToInventory(characterId, materiale, quantita) {
  if (quantita <= 0) return;

  await db.run(
    `INSERT INTO materials_inventory (characterId, material, quantity)
     VALUES (?, ?, ?)
     ON CONFLICT(characterId, material)
     DO UPDATE SET quantity = quantity + excluded.quantity`,
    characterId,
    normalizeText(materiale),
    quantita
  );
}

async function getFortress(characterId) {
  return db.get(
    "SELECT name, level FROM fortresses WHERE characterId = ?",
    characterId
  );
}

async function getFarmCountForWeek(characterId, weekStartKey) {
  const weekEndKey = getWeekEndKeyFromWeekStart(weekStartKey);

  const row = await db.get(
    `SELECT COUNT(*) AS count
     FROM farm_days
     WHERE characterId = ?
       AND farmDate >= ?
       AND farmDate <= ?`,
    characterId,
    weekStartKey,
    weekEndKey
  );

  return row?.count || 0;
}

async function getWeeklyFarmCount(characterId) {
  return getFarmCountForWeek(characterId, getCurrentWeekStartKey());
}

async function isFarmDateTaken(characterId, farmDate) {
  const row = await db.get(
    "SELECT id FROM farm_days WHERE characterId = ? AND farmDate = ?",
    characterId,
    farmDate
  );

  return Boolean(row);
}

async function getNextAvailableFarmDate(pg) {
  const today = getCurrentRomeDateKey();
  const limit = getProficiencyBonus(pg.level || 1);

  for (let offset = 0; offset < 365; offset++) {
    const candidate = addDaysToDateKey(today, offset);
    const weekStart = getWeekStartKeyFromDateKey(candidate);

    const taken = await isFarmDateTaken(pg.id, candidate);
    if (taken) continue;

    const countInCandidateWeek = await getFarmCountForWeek(pg.id, weekStart);
    if (countInCandidateWeek >= limit) continue;

    return candidate;
  }

  throw new Error("Nessuno slot farming disponibile nei prossimi 365 giorni.");
}

async function registerFarmDay(pg) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const farmDate = await getNextAvailableFarmDate(pg);
    const createdAt = new Date().toISOString();

    try {
      await db.run(
        `INSERT INTO farm_days (characterId, farmDate, createdAt)
         VALUES (?, ?, ?)`,
        pg.id,
        farmDate,
        createdAt
      );

      return farmDate;
    } catch (error) {
      if (String(error?.message || "").includes("UNIQUE")) {
        continue;
      }

      throw error;
    }
  }

  throw new Error("Impossibile registrare lo slot farming dopo vari tentativi.");
}
// === MATERIALI SPECIALI E GESTIONE INVENTARIO GM ===

// Catalogo separato: questi materiali NON vengono aggiunti alle miniere.
// Le quantità restano in materials_inventory, come gli altri materiali.
await db.exec(`
  CREATE TABLE IF NOT EXISTS shot_materials (
    material TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    tags TEXT NOT NULL DEFAULT '',
    mestieri TEXT NOT NULL DEFAULT '',
    description TEXT NOT NULL DEFAULT '',
    rarity TEXT NOT NULL DEFAULT ''
  );
`);

// Aggiorna anche i database dove shot_materials esiste già.
const shotMaterialColumns = await db.all(
  "PRAGMA table_info(shot_materials)"
);

if (!shotMaterialColumns.some(column => column.name === "rarity")) {
  await db.exec(`
    ALTER TABLE shot_materials
    ADD COLUMN rarity TEXT NOT NULL DEFAULT '';
  `);
}

const EXTRA_GM_COMMANDS = [
  "materiale_shot",
  "assegna_materiale_shot",
  "rimuovi_materiale_pg"
];

const extraCommands = [
  new SlashCommandBuilder()
    .setName("materiale_shot")
    .setDescription("Crea o aggiorna un materiale non farmabile. Solo gm-bot.")
    .addStringOption(o =>
      o.setName("nome")
        .setDescription("Nome del materiale; riusa lo stesso nome per modificarlo")
        .setRequired(true)
        .setMaxLength(100)
    )
    .addStringOption(o =>
      o.setName("tags")
        .setDescription("Emoji o tag; usa - per svuotare")
        .setMaxLength(100)
    )
    .addStringOption(o =>
      o.setName("mestieri")
        .setDescription("Mestieri separati da virgola; usa - per svuotare")
        .setMaxLength(250)
    )
    .addStringOption(o =>
      o.setName("descrizione")
        .setDescription("Descrizione o provenienza; usa - per svuotare")
        .setMaxLength(400)
    )
    .addStringOption(o =>
      o.setName("rarita")
        .setDescription("Rarità del materiale; ometti per mantenere quella attuale")
        .addChoices(
          { name: "Comune", value: "comune" },
          { name: "Non Comune", value: "non_comune" },
          { name: "Raro", value: "raro" },
          { name: "Molto Raro", value: "molto_raro" },
          { name: "Leggendario", value: "leggendario" },
          { name: "Non specificata", value: "non_specificata" }
        )
    ),

  new SlashCommandBuilder()
    .setName("assegna_materiale_shot")
    .setDescription("Assegna a un PG un materiale del catalogo shot. Solo gm-bot.")
    .addUserOption(o =>
      o.setName("giocatore")
        .setDescription("Proprietario del personaggio")
        .setRequired(true)
    )
    .addStringOption(o =>
      o.setName("nome_pg")
        .setDescription("Seleziona il personaggio del giocatore")
        .setRequired(true)
        .setAutocomplete(true)
    )
    .addStringOption(o =>
      o.setName("materiale")
        .setDescription("Seleziona un materiale da shot")
        .setRequired(true)
        .setAutocomplete(true)
    )
    .addIntegerOption(o =>
      o.setName("quantita")
        .setDescription("Quantità da aggiungere")
        .setRequired(true)
        .setMinValue(1)
        .setMaxValue(1000000)
    ),

  new SlashCommandBuilder()
    .setName("rimuovi_materiale_pg")
    .setDescription("Rimuove materiali anche errati dall'inventario. Solo gm-bot.")
    .addUserOption(o =>
      o.setName("giocatore")
        .setDescription("Proprietario del personaggio")
        .setRequired(true)
    )
    .addStringOption(o =>
      o.setName("nome_pg")
        .setDescription("Seleziona il personaggio del giocatore")
        .setRequired(true)
        .setAutocomplete(true)
    )
    .addStringOption(o =>
      o.setName("voce")
        .setDescription("Seleziona la voce reale dell'inventario")
        .setRequired(true)
        .setAutocomplete(true)
    )
    .addIntegerOption(o =>
      o.setName("quantita")
        .setDescription("Quantità da togliere; ometti per eliminare tutta la voce")
        .setMinValue(1)
        .setMaxValue(1000000)
    )
];

async function getShotMaterial(name) {
  return db.get(
    "SELECT * FROM shot_materials WHERE material = ?",
    normalizeText(name)
  );
}

// Gestisce SOLO i tre nuovi comandi.
// true = interazione gestita, il vecchio handler deve fermarsi.
async function handleExtraMaterials(interaction) {
  if (!EXTRA_GM_COMMANDS.includes(interaction.commandName)) return false;

  const autocomplete = interaction.isAutocomplete();
  if (!autocomplete && !interaction.isChatInputCommand()) return false;

  // Controllo anche sull'autocompletamento degli inventari.
  if (!hasRole(interaction.member, GM_ROLE_NAME)) {
    if (autocomplete) {
      await interaction.respond([]);
    } else {
      await interaction.reply({
        content: `🚫 Serve il ruolo ${GM_ROLE_NAME}.`,
        ephemeral: true
      });
    }
    return true;
  }

  const command = interaction.commandName;

  if (autocomplete) {
    const focused = interaction.options.getFocused(true);
    const search = normalizeText(focused.value);
    const playerId = interaction.options.get("giocatore")?.value;

    if (focused.name === "nome_pg") {
      if (!playerId) {
        await interaction.respond([]);
        return true;
      }

      const pgs = await getPersonaggiUtente(playerId);

      await interaction.respond(
        pgs
          .filter(pg => normalizeText(pg.name).includes(search))
          .slice(0, 25)
          .map(pg => ({
            name: pg.name.slice(0, 100),
            // L'ID evita ambiguità tra nomi simili o uguali.
            value: String(pg.id)
          }))
      );
      return true;
    }

    if (focused.name === "materiale") {
      const rows = await db.all(
        "SELECT material, name FROM shot_materials ORDER BY name"
      );

      await interaction.respond(
        rows
          .filter(row => normalizeText(row.name).includes(search))
          .slice(0, 25)
          .map(row => ({
            name: row.name.slice(0, 100),
            value: row.material
          }))
      );
      return true;
    }

    if (focused.name === "voce") {
      const pgId = interaction.options.getString("nome_pg");
      const pg = await db.get(
        "SELECT id FROM characters WHERE id = ? AND playerId = ?",
        pgId,
        String(playerId || "")
      );

      if (!pg) {
        await interaction.respond([]);
        return true;
      }

      // Nessuna ricerca nelle miniere: include anche errori,
      // materiali fuori catalogo e voci a quantità zero.
      const rows = await db.all(
        `SELECT id, material, quantity
         FROM materials_inventory
         WHERE characterId = ?
         ORDER BY material`,
        pg.id
      );

      await interaction.respond(
        rows
          .filter(row => normalizeText(row.material).includes(search))
          .slice(0, 25)
          .map(row => ({
            name: `#${row.id} · ${row.quantity}x ${row.material}`.slice(0, 100),
            value: String(row.id)
          }))
      );
      return true;
    }

    await interaction.respond([]);
    return true;
  }

  await interaction.deferReply({ ephemeral: true });

  const reply = async content => {
    await interaction.editReply({
      content,
      allowedMentions: { parse: [] }
    });
    return true;
  };

  if (command === "materiale_shot") {
    const name = interaction.options.getString("nome").trim();
    const key = normalizeText(name);

    if (!key) return reply("❌ Il nome non può essere vuoto.");

    if (trovaMateriale(caricaMiniere(), name)) {
      return reply(
        "❌ Esiste già un materiale farmabile con questo nome. " +
        "Usa un nome distinto per quello da shot."
      );
    }

    const existing = await getShotMaterial(key);

    // Evita di riclassificare accidentalmente vecchie voci errate.
    if (!existing) {
      const inventoryNames = await db.all(
        "SELECT DISTINCT material FROM materials_inventory"
      );

      if (inventoryNames.some(row => normalizeText(row.material) === key)) {
        return reply(
          "❌ Questo nome è già presente negli inventari ma non nel catalogo shot. " +
          "Scegli un nome diverso, oppure correggi prima le vecchie voci."
        );
      }
    }

    const field = (option, previous = "") => {
      const value = interaction.options.getString(option);
      if (value === null) return previous;
      return value.trim() === "-" ? "" : value.trim();
    };

    const tags = field("tags", existing?.tags);
    const mestieri = field("mestieri", existing?.mestieri);
    const description = field("descrizione", existing?.description);

    const selectedRarity = interaction.options.getString("rarita");

    const rarity = selectedRarity === null
      ? (existing?.rarity || "")
      : selectedRarity === "non_specificata"
        ? ""
        : selectedRarity;

    await db.run(
      `INSERT INTO shot_materials
         (material, name, tags, mestieri, description, rarity)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(material) DO UPDATE SET
         name = excluded.name,
         tags = excluded.tags,
         mestieri = excluded.mestieri,
         description = excluded.description,
         rarity = excluded.rarity`,
      key,
      name,
      tags,
      mestieri,
      description,
      rarity
    );

    return reply(
      `✅ Materiale da shot ${existing ? "aggiornato" : "creato"}: ${name}\n` +
      `Rarità: ${formatMaterialRarity(rarity)}\n` +
      `Tag: ${tags || "Nessuno"}\n` +
      `Mestieri: ${mestieri || "Nessuno"}\n` +
      `Descrizione: ${description || "Nessuna"}\n` +
      "Non è farmabile."
    );

  const player = interaction.options.getUser("giocatore");
  const pgId = interaction.options.getString("nome_pg");
  const pg = await db.get(
    "SELECT id, name FROM characters WHERE id = ? AND playerId = ?",
    pgId,
    player.id
  );

  if (!pg) {
    return reply(
      "❌ Seleziona un personaggio dai suggerimenti dopo aver scelto il giocatore."
    );
  }

  if (command === "assegna_materiale_shot") {
    const material = await getShotMaterial(
      interaction.options.getString("materiale")
    );
    const quantity = interaction.options.getInteger("quantita");

    if (!material) {
      return reply("❌ Crea prima questo materiale con /materiale_shot.");
    }

    if (!Number.isSafeInteger(quantity) || quantity <= 0) {
      return reply("❌ Quantità non valida.");
    }

    await addMaterialToInventory(pg.id, material.material, quantity);

    return reply(`✅ Aggiunti ${quantity}x ${material.name} a ${pg.name}.`);
  }

  if (command === "rimuovi_materiale_pg") {
    const rowId = interaction.options.getString("voce");
    const quantity = interaction.options.getInteger("quantita");

    const row = await db.get(
      `SELECT id, material, quantity
       FROM materials_inventory
       WHERE id = ? AND characterId = ?`,
      rowId,
      pg.id
    );

    if (!row) {
      return reply(
        "❌ Voce non trovata: selezionala dai suggerimenti dell'inventario."
      );
    }

    if (quantity === null) {
      const result = await db.run(
        "DELETE FROM materials_inventory WHERE id = ? AND characterId = ?",
        row.id,
        pg.id
      );

      return reply(result.changes
        ? `🗑️ Eliminata tutta la voce "${row.material}" da ${pg.name}.`
        : "⚠️ La voce era già stata rimossa."
      );
    }

    if (!Number.isSafeInteger(quantity) || quantity <= 0) {
      return reply("❌ Quantità non valida.");
    }

    // Controllo atomico: impedisce quantità negative anche se
    // due comandi vengono eseguiti contemporaneamente.
    const result = await db.run(
      `UPDATE materials_inventory
       SET quantity = quantity - ?
       WHERE id = ? AND characterId = ? AND quantity >= ?`,
      quantity,
      row.id,
      pg.id,
      quantity
    );

    if (!result.changes) {
      return reply("❌ Quantità insufficiente oppure voce già rimossa.");
    }

    await db.run(
      `DELETE FROM materials_inventory
       WHERE id = ? AND characterId = ? AND quantity = 0`,
      row.id,
      pg.id
    );

    return reply(`✅ Rimossi ${quantity}x ${row.material} da ${pg.name}.`);
  }

  return false;
}

// === SLASH COMMANDS ===

const commands = [
  ...extraCommands,
  new SlashCommandBuilder()
    .setName("aiuto_miniere")
    .setDescription("Mostra i comandi di Grumni. Sì, purtroppo devi leggere."),

  new SlashCommandBuilder()
    .setName("registro_farming")
    .setDescription("Mostra denaro, farming e materiali di un tuo PG.")
    .addStringOption(o =>
      o.setName("nome_pg")
        .setDescription("Nome del tuo PG")
        .setRequired(true)
        .setAutocomplete(true)
    ),

  new SlashCommandBuilder()
    .setName("farm")
    .setDescription("Farma un materiale con un tuo PG.")
    .addStringOption(o =>
      o.setName("nome_pg")
        .setDescription("Nome del tuo PG")
        .setRequired(true)
        .setAutocomplete(true)
    )
    .addStringOption(o =>
      o.setName("materiale")
        .setDescription("Materiale da cercare")
        .setRequired(true)
        .setAutocomplete(true)
    ),

  new SlashCommandBuilder()
    .setName("materiali")
    .setDescription("Mostra la mappa delle miniere e dei materiali."),

  new SlashCommandBuilder()
    .setName("addminiera")
    .setDescription("Crea una nuova miniera. Solo gm-bot.")
    .addStringOption(o =>
      o.setName("nome")
        .setDescription("Nome della miniera")
        .setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName("delminiera")
    .setDescription("Elimina una miniera. Solo gm-bot.")
    .addStringOption(o =>
      o.setName("nome")
        .setDescription("Nome della miniera")
        .setRequired(true)
        .setAutocomplete(true)
    ),

  new SlashCommandBuilder()
    .setName("addmat")
    .setDescription("Aggiunge un materiale a una miniera. Solo gm-bot.")
    .addStringOption(o =>
      o.setName("miniera")
        .setDescription("Nome della miniera")
        .setRequired(true)
        .setAutocomplete(true)
    )
    .addStringOption(o =>
      o.setName("materiale")
        .setDescription("Nome del materiale")
        .setRequired(true)
    )
    .addStringOption(o =>
      o.setName("rarita")
        .setDescription("Rarità del materiale")
        .setRequired(true)
        .addChoices(
          { name: "Comune", value: "comuni" },
          { name: "Non Comune", value: "non_comuni" }
        )
    )
    .addStringOption(o =>
      o.setName("tags")
        .setDescription("Tag opzionali del materiale")
        .setRequired(false)
    )
    .addStringOption(o =>
      o.setName("mestieri")
        .setDescription("Mestieri opzionali separati da virgola")
        .setRequired(false)
    ),

  new SlashCommandBuilder()
    .setName("delmat")
    .setDescription("Rimuove un materiale da una miniera. Solo gm-bot.")
    .addStringOption(o =>
      o.setName("miniera")
        .setDescription("Nome della miniera")
        .setRequired(true)
        .setAutocomplete(true)
    )
    .addStringOption(o =>
      o.setName("materiale")
        .setDescription("Nome del materiale")
        .setRequired(true)
        .setAutocomplete(true)
    )
].map(c => c.toJSON());

(async () => {
  try {
    console.log("Started refreshing Miniere slash commands.");
    await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), { body: commands });
    console.log("Successfully reloaded Miniere slash commands.");
  } catch (error) {
    console.error("Errore registrazione slash commands Miniere:", error);
  }
})();

// === FARM CORE ===

async function eseguiFarm(interaction, pg, fortezzaRaw, materiale, miniera, rarita, mestieri = [], tags = "") {
  const fortezza = getEffectiveFortress(fortezzaRaw);

  const livFort = fortezza.level;
  const nomeFort = fortezza.name;
  const dado = randInt(1, 10);
  const totale = dado + livFort;
  const quantita = calcolaRisultato(dado, livFort, rarita);

  const farmDateKey = await registerFarmDay(pg);
  const farmDateDisplay = formatDateKeyItalian(farmDateKey);
  const farmWeekStart = getWeekStartKeyFromDateKey(farmDateKey);

  const materialToStore = normalizeText(materiale);

  if (quantita > 0) {
    await addMaterialToInventory(pg.id, materialToStore, quantita);
  }

  const farmCount = await getFarmCountForWeek(pg.id, farmWeekStart);
  const farmLimit = getProficiencyBonus(pg.level || 1);

  const matDisplay = capitalize(materiale);
  const matFullDisplay = formatMaterialNameForEmbed(materiale, tags, mestieri);
  const nomePg = pg.name;
  const commandExecutedAt = nowRome();
  const v = { pg: nomePg, mat: matDisplay, miniera, q: quantita, ora: commandExecutedAt };

  let frase;

  if (quantita === 0) {
    frase = rarita === "non_comuni" && totale >= 4
      ? fmt(pick(FRASI_NON_COMUNE_ZERO), v)
      : fmt(pick(FRASI_ZERO), v);
  } else if (quantita === 1) {
    frase = fmt(pick(FRASI_TROVATO_1), v);
  } else {
    frase = fmt(pick(FRASI_TROVATO_2), v);
  }

  const tipoRar = rarita === "comuni" ? "⚪ Comune" : "🟣 Non Comune";

  const embed = new EmbedBuilder()
    .setTitle(`📜 ${NOME_BOT} — Rapporto di Ricerca`)
    .setDescription(frase)
    .setColor(quantita > 0 ? 0x2ecc71 : 0xe74c3c)
    .addFields(
      { name: "👤 Personaggio", value: nomePg, inline: true },
      { name: "🏰 Fortezza", value: `${nomeFort} (Lv. ${livFort})`, inline: true },
      { name: "⛏️ Luogo di Ricerca", value: miniera, inline: true },
      { name: "🔍 Materiale Cercato", value: `${matFullDisplay} (${tipoRar})`, inline: true },
      {
        name: "🛠️ Mestieri",
        value: mestieri.length ? mestieri.map(capitalize).join(", ") : "Nessuno indicato",
        inline: true
      },
      { name: "📦 Quantità Raccolta", value: `**${quantita}**`, inline: true },
      {
        name: "🧺 Inventario Materiali",
        value: quantita > 0
          ? `Aggiunto automaticamente: **${quantita}x ${matFullDisplay}**`
          : "Nessun materiale aggiunto, perché evidentemente oggi il piccone era decorativo.",
        inline: false
      },
      { name: "📅 Giorno Farming Registrato", value: farmDateDisplay, inline: true },
      { name: "📆 Farm Settimana Registrata", value: `${farmCount} / ${farmLimit}`, inline: true },
      { name: "🔄 Reset", value: "Lunedì a mezzanotte", inline: true },
      { name: "🎲 Dado", value: `${dado} + ${livFort} (fortezza) = **${totale}**`, inline: true },
      { name: "🕒 Comando Eseguito", value: commandExecutedAt, inline: true }
    )
    .setFooter({ text: `— ${NOME_BOT}, Maestro delle Miniere (e della tua miseria)` });

  return interaction.reply({ content: `<@${interaction.user.id}>`, embeds: [embed] });
}

// === EVENTS ===

client.once("clientReady", () => {
  console.log(`⛏️ ${NOME_BOT} online come ${client.user.tag}!`);
  console.log(`Server connessi: ${client.guilds.cache.size}`);
  console.log(`DB Westmarch SQLite: ${DB_PATH}`);
  console.log(`File miniere: ${MINIERE_FILE}`);

  client.user.setActivity("a rompere picconi | /farm", {
    type: ActivityType.Playing
  });
});

client.on("interactionCreate", async interaction => {
  try {
    if (await handleExtraMaterials(interaction)) return;

    if (interaction.isAutocomplete()) {
      const focused = interaction.options.getFocused(true);
      const miniere = caricaMiniere();

      if (focused.name === "nome_pg") {
        const pgs = await getPersonaggiUtente(interaction.user.id);

        const filtered = pgs
          .map(pg => pg.name)
          .filter(name => normalizeText(name).startsWith(normalizeText(focused.value)))
          .slice(0, 25);

        return interaction.respond(filtered.map(name => ({ name, value: name })));
      }

      if (focused.name === "materiale") {
        const materiali = tuttiNomiMateriali(miniere);

        const filtered = materiali
          .filter(m => normalizeText(m).includes(normalizeText(focused.value)))
          .slice(0, 25);

        return interaction.respond(filtered.map(m => ({ name: capitalize(m), value: m })));
      }

      if (focused.name === "miniera" || focused.name === "nome") {
        const nomi = tuttiNomiMiniere(miniere);

        const filtered = nomi
          .filter(m => normalizeText(m).includes(normalizeText(focused.value)))
          .slice(0, 25);

        return interaction.respond(filtered.map(m => ({ name: m, value: m })));
      }

      return interaction.respond([]);
    }

    if (!interaction.isChatInputCommand()) return;

    const command = interaction.commandName;
    const isBeta = hasRole(interaction.member, BETA_ROLE_NAME);
    const isGM = hasRole(interaction.member, GM_ROLE_NAME);

    const betaCommands = [
      "aiuto_miniere",
      "registro_farming",
      "farm",
      "materiali"
    ];

    const gmCommands = [
      "addminiera",
      "delminiera",
      "addmat",
      "delmat"
    ];

    if (betaCommands.includes(command) && !isBeta && !isGM) {
      return interaction.reply({
        content: `🚫 Serve il ruolo **${BETA_ROLE_NAME}**, verme. — **${NOME_BOT}**`,
        ephemeral: true
      });
    }

    if (gmCommands.includes(command) && !isGM) {
      return interaction.reply({
        content: `🚫 Questo comando è roba da **${GM_ROLE_NAME}**, non da apprendisti col piccone. — **${NOME_BOT}**`,
        ephemeral: true
      });
    }

       if (command === "aiuto_miniere") {
      const embed = new EmbedBuilder()
        .setTitle(`⛏️ ${NOME_BOT} — Comandi`)
        .setDescription(
          `Ascolta bene perché **${NOME_BOT}** non ripete. Mai. ` +
          "Tranne ora, perché Discord mi obbliga a essere leggibile."
        )
        .setColor(0xb8860b)
        .addFields(
          {
            name: "⛏️ Farming",
            value:
              "`/farm nome_pg materiale` — Cerca un materiale\n" +
              "`/registro_farming nome_pg` — Vedi denaro, farm, fortezza e materiali\n" +
              "`/materiali` — Mappa miniere",
            inline: false
          },
          {
            name: "🔧 Gestione Miniere",
            value:
              "`/addminiera nome`\n" +
              "`/delminiera nome`\n" +
              "`/addmat miniera materiale rarita tags mestieri`\n" +
              "`/delmat miniera materiale`\n" +
              `Richiede ruolo **${GM_ROLE_NAME}**.`,
            inline: false
          },
          {
            name: "🎁 Materiali da shot",
            value:
              "`/materiale_shot` — Crea o aggiorna rarità, tag, mestieri e descrizione di un materiale speciale\n" +
              "`/assegna_materiale_shot` — Assegna un materiale speciale a un PG\n" +
              "I materiali da shot non sono farmabili.\n" +
              "Per aggiornare un materiale, riusa lo stesso nome.\n" +
              "I campi facoltativi omessi mantengono il valore precedente.\n" +
              "Usa `-` per svuotare tag, mestieri o descrizione.\n" +
              `Richiede ruolo **${GM_ROLE_NAME}**.`,
            inline: false
          },
          {
            name: "🧹 Correzione inventari",
            value:
              "`/rimuovi_materiale_pg` — Rimuove una voce dall'inventario di un PG\n" +
              "Seleziona prima il giocatore, poi il personaggio e la voce.\n" +
              "Funziona anche con materiali errati o assenti dalle miniere.\n" +
              "Indica una quantità per rimuoverne solo una parte.\n" +
              "Ometti la quantità per eliminare tutta la voce.\n" +
              `Richiede ruolo **${GM_ROLE_NAME}**.`,
            inline: false
          },
          {
            name: "📆 Limite Farming",
            value:
              "Ogni PG può avere al massimo **1 farm registrato per giorno**.\n" +
              "Ogni PG può avere a settimana un numero di farm registrati pari al suo **bonus competenza**.\n" +
              "I materiali vengono aggiunti subito.\n" +
              "Il farm viene registrato sul primo giorno libero che non sfora il limite della sua settimana.\n" +
              "Quindi se farmi domenica e il prossimo slot utile è lunedì, quel farm conta nella settimana nuova. Bello, vero? Quasi intelligente.\n" +
              "La fortezza non è obbligatoria: se manca, vale **Nessuna fortezza (Lv. 0)**.",
            inline: false
          },
          {
            name: "📊 Tabella Risultati",
            value:
              "**Comune:** 1-3=0 | 4-8=1 | 9+=2\n" +
              "**Non Comune:** 1-8=0 | 9-11=1 | 12+=2",
            inline: false
          }
        )
        .setFooter({
          text: `— ${NOME_BOT}, già stanco di spiegare cose ovvie`
        });

      return interaction.reply({
        embeds: [embed],
        ephemeral: true
      });
    }
       if (command === "registro_farming") {
      const nomePg = interaction.options.getString("nome_pg");

      // Conferma subito la ricezione del comando.
      await interaction.deferReply({ ephemeral: false });

      const pg = await getPersonaggioByName(
        interaction.user.id,
        nomePg
      );

      if (!pg) {
        await interaction.editReply({
          content: fmt(pick(FRASI_NO_PG), {
            name: `<@${interaction.user.id}>`
          }),
          allowedMentions: { parse: [] }
        });

        return;
      }

      const fort = getEffectiveFortress(
        await getFortress(pg.id)
      );

      const materials = await getMaterialsInventory(pg.id);
      const limit = getProficiencyBonus(pg.level || 1);
      const count = await getWeeklyFarmCount(pg.id);

      const normalMaterials = materials.filter(
        row => row.shotName == null
      );

      const shotMaterials = materials.filter(
        row => row.shotName != null
      );

      const materialFields = [];

      const inventorySections = [
        [
          "🧺 Materiali ordinari / fuori catalogo",
          normalMaterials
        ],
        [
          "🎁 Materiali da shot — non farmabili",
          shotMaterials
        ]
      ];

      for (const [title, rows] of inventorySections) {
        let chunk = "";

        const lines = rows.length
          ? rows.map(formatMaterialWithMetadata)
          : ["Vuoto"];

        for (const line of lines) {
          if (
            chunk &&
            chunk.length + line.length + 1 > 1024
          ) {
            materialFields.push({
              name: title,
              value: chunk,
              inline: false
            });

            chunk = "";
          }

          const textToAppend = (chunk ? "\n" : "") + line;

          // Divide anche eventuali singole voci troppo lunghe,
          // senza spezzare le coppie UTF-16 delle emoji.
          for (const character of textToAppend) {
            if (chunk.length + character.length > 1024) {
              materialFields.push({
                name: title,
                value: chunk,
                inline: false
              });

              chunk = "";
            }

            chunk += character;
          }
        }

        if (chunk) {
          materialFields.push({
            name: title,
            value: chunk,
            inline: false
          });
        }
      }

      const gold = Number(pg.gold ?? 0);
      const bank = Number(pg.bank ?? 0);

      const embed = new EmbedBuilder()
        .setTitle(`📋 Registro Farming — ${pg.name}`)
        .setDescription(
          "Ecco il tuo curriculum da minatore. Fa già ridere così."
        )
        .setColor(0x3498db)
        .addFields(
          {
            name: "👤 Personaggio",
            value: pg.name,
            inline: true
          },
          {
            name: "⚔️ Livello",
            value: `${pg.level}`,
            inline: true
          },
          {
            name: "🧠 Competenza",
            value: `+${limit}`,
            inline: true
          },
          {
            name: "👛 Tasca",
            value: `${gold} mo`,
            inline: true
          },
          {
            name: "🏦 Banca",
            value: `${bank} mo`,
            inline: true
          },
          {
            name: "🪙 Totale",
            value: `${gold + bank} mo`,
            inline: true
          },
          {
            name: "📆 Farm Settimana Corrente",
            value: `${count} / ${limit}`,
            inline: true
          },
          {
            name: "🔄 Reset",
            value: "Lunedì a mezzanotte",
            inline: true
          },
          {
            name: "🏰 Fortezza",
            value: `🏰 **${fort.name}** (Lv. ${fort.level})`,
            inline: false
          }
        )
        .setFooter({
          text: `— ${NOME_BOT}, contabile della tua fatica inutile`
        });

      // Calcola la lunghezza complessiva del testo dell'embed.
      const textLength = builder => {
        const data = builder.data;

        return (
          (data.title?.length || 0) +
          (data.description?.length || 0) +
          (data.footer?.text?.length || 0) +
          (data.author?.name?.length || 0) +
          (data.fields || []).reduce(
            (sum, field) =>
              sum + field.name.length + field.value.length,
            0
          )
        );
      };

      const pages = [];
      let page = embed;

      for (const field of materialFields) {
        const fieldCount = page.data.fields?.length || 0;

        const nextLength =
          textLength(page) +
          field.name.length +
          field.value.length;

        if (fieldCount >= 25 || nextLength > 5500) {
          pages.push(page);

          page = new EmbedBuilder()
            .setTitle(
              "📋 Registro Farming — Inventario (continua)"
            )
            .setColor(0x3498db);
        }

        page.addFields(field);
      }

      pages.push(page);

      await interaction.editReply({
        embeds: [pages[0]],
        allowedMentions: { parse: [] }
      });

      for (const nextPage of pages.slice(1)) {
        await interaction.followUp({
          embeds: [nextPage],
          ephemeral: false,
          allowedMentions: { parse: [] }
        });
      }

      return;
    }
    if (command === "farm") {
      const nomePg = interaction.options.getString("nome_pg");
      const materiale = interaction.options.getString("materiale").trim();

      const pg = await getPersonaggioByName(interaction.user.id, nomePg);

      if (!pg) {
        return interaction.reply({
          content: fmt(pick(FRASI_NO_PG), { name: `<@${interaction.user.id}>` }),
          ephemeral: true
        });
      }

      const miniere = caricaMiniere();
      const trovato = trovaMateriale(miniere, materiale);

      if (!trovato) {
        const sugg = suggerisciMateriale(miniere, materiale);

        let msg = `🤷 **${capitalize(materiale)}**?! <@${interaction.user.id}>, ma che cazzo è? Non esiste in nessuna delle MIE miniere.`;

        if (sugg.length) {
          msg += `\n\n🧠 Forse volevi dire... ${sugg.map(s => `\`${s}\``).join(", ")}? Scrivi bene, analfabeta.`;
        } else {
          msg += "\nUsa `/materiali` per vedere cosa c'è davvero, ignorante.";
        }

        return interaction.reply({ content: msg, ephemeral: true });
      }

      const fortezza = getEffectiveFortress(await getFortress(pg.id));

      return eseguiFarm(
        interaction,
        pg,
        fortezza,
        trovato.materiale,
        trovato.miniera,
        trovato.rarita,
        trovato.mestieri,
        trovato.tags
      );
    }

    if (command === "materiali") {
      const miniere = caricaMiniere();
      const embeds = [];

      let currentEmbed = new EmbedBuilder()
        .setTitle(`⛏️ ${NOME_BOT} — Lista Materiali`)
        .setDescription("Usa `/farm nome_pg materiale` o levati dai piedi.")
        .setColor(0xf1c40f);

      let fieldCount = 0;

      for (const [minieraNome, dati] of Object.entries(miniere)) {
        let valore = "";

        for (const m of (dati.comuni || [])) {
          const mestStr = getMestieri(m).map(capitalize).join(", ");
          const tags = getTags(m);
          const nome = getNomeDisplay(m);
          valore += `⚪ ${tags ? `${tags} ` : ""}${capitalize(nome)}${mestStr ? ` *(${mestStr})*` : ""}\n`;
        }

        for (const m of (dati.non_comuni || [])) {
          const mestStr = getMestieri(m).map(capitalize).join(", ");
          const tags = getTags(m);
          const nome = getNomeDisplay(m);
          valore += `🟣 ${tags ? `${tags} ` : ""}${capitalize(nome)}${mestStr ? ` *(${mestStr})*` : ""}\n`;
        }

        if (!valore) valore = "Vuota. Come certe promesse dei giocatori.";

        if (valore.length > 1024) {
          const righe = valore.split("\n").filter(r => r);
          let chunk = "";
          let partNum = 1;

          for (const riga of righe) {
            if (chunk.length + riga.length + 1 > 1020) {
              currentEmbed.addFields({
                name: `⛏️ ${minieraNome}${partNum > 1 ? ` (${partNum})` : ""}`,
                value: chunk.trim(),
                inline: false
              });

              fieldCount++;
              chunk = riga + "\n";
              partNum++;
            } else {
              chunk += riga + "\n";
            }
          }

          if (chunk.trim()) {
            currentEmbed.addFields({
              name: `⛏️ ${minieraNome}${partNum > 1 ? ` (${partNum})` : ""}`,
              value: chunk.trim(),
              inline: false
            });

            fieldCount++;
          }
        } else {
          currentEmbed.addFields({
            name: `⛏️ ${minieraNome}`,
            value: valore.trim(),
            inline: false
          });

          fieldCount++;
        }

        if (fieldCount >= 24) {
          embeds.push(currentEmbed);

          currentEmbed = new EmbedBuilder()
            .setTitle(`⛏️ ${NOME_BOT} — Lista Materiali (continua)`)
            .setColor(0xf1c40f);

          fieldCount = 0;
        }
      }

      embeds.push(currentEmbed);

      await interaction.reply({ embeds: [embeds[0]], ephemeral: false });

      for (const emb of embeds.slice(1)) {
        await interaction.followUp({ embeds: [emb], ephemeral: false });
      }

      return;
    }

    if (command === "addminiera") {
      const nome = interaction.options.getString("nome").trim();
      const miniere = caricaMiniere();

      if (miniere[nome]) {
        return interaction.reply({
          content: `⚠️ **${nome}** esiste già. Non serve duplicare i buchi nel terreno.`,
          ephemeral: true
        });
      }

      miniere[nome] = {
        comuni: [],
        non_comuni: []
      };

      saveJSON(MINIERE_FILE, miniere);

      return interaction.reply(`🆕 Miniera **${nome}** creata! Un altro posto dove la gente andrà a deludermi.`);
    }

    if (command === "delminiera") {
      const nome = interaction.options.getString("nome").trim();
      const miniere = caricaMiniere();

      if (!miniere[nome]) {
        return interaction.reply({
          content: `⚠️ **${nome}** non esiste. Stai cercando di demolire un'allucinazione.`,
          ephemeral: true
        });
      }

      delete miniere[nome];
      saveJSON(MINIERE_FILE, miniere);

      return interaction.reply(`💥 Miniera **${nome}** eliminata! Seppellita meglio della dignità dei minatori.`);
    }

        if (command === "addmat") {
      const nomeMin = interaction.options
        .getString("miniera")
        .trim();

      const mat = interaction.options
        .getString("materiale")
        .trim()
        .toLowerCase();

      const rar = interaction.options.getString("rarita");

      const tags =
        interaction.options.getString("tags")?.trim() || "";

      const mestieriRaw =
        interaction.options.getString("mestieri")?.trim() || "";

      if (await getShotMaterial(mat)) {
        return interaction.reply({
          content:
            "❌ Questo nome appartiene a un materiale da shot " +
            "non farmabile. Usa un nome diverso.",
          ephemeral: true
        });
      }

      const miniere = caricaMiniere();

      if (!miniere[nomeMin]) {
        return interaction.reply({
          content:
            `⚠️ Miniera **${nomeMin}** non esiste. ` +
            "Prima crea il buco, poi ci butti la roba.",
          ephemeral: true
        });
      }

      const alreadyExists = [
        ...(miniere[nomeMin].comuni || []),
        ...(miniere[nomeMin].non_comuni || [])
      ].some(m => getNome(m) === normalizeText(mat));

      if (alreadyExists) {
        return interaction.reply({
          content:
            `⚠️ **${capitalize(mat)}** esiste già in **${nomeMin}**. ` +
            "Riciclare va bene, duplicare no.",
          ephemeral: true
        });
      }

      const mestieri = mestieriRaw
        ? mestieriRaw
            .split(",")
            .map(s => s.trim().toLowerCase())
            .filter(Boolean)
        : [];

      const materialToStore = tags || mestieri.length
        ? {
            nome: mat,
            tags,
            mestieri
          }
        : mat;

      miniere[nomeMin][rar].push(materialToStore);

      saveJSON(MINIERE_FILE, miniere);

      const tipo = rar === "comuni"
        ? "⚪ Comune"
        : "🟣 Non Comune";

      const extra = tags || mestieri.length
        ? (
            `\nTag: ${tags || "Nessuno"}` +
            `\nMestieri: ${
              mestieri.length
                ? mestieri.map(capitalize).join(", ")
                : "Nessuno"
            }`
          )
        : "";

      return interaction.reply(
        `✅ **${capitalize(mat)}** (${tipo}) aggiunto a **${nomeMin}**! ` +
        `Grumni approva. Malvolentieri.${extra}`
      );
    }

    if (command === "delmat") {
      const nomeMin = interaction.options.getString("miniera").trim();
      const mat = interaction.options.getString("materiale").trim().toLowerCase();
      const miniere = caricaMiniere();

      if (!miniere[nomeMin]) {
        return interaction.reply({
          content: `⚠️ Miniera **${nomeMin}** non esiste.`,
          ephemeral: true
        });
      }

      let rimosso = false;

      for (const r of ["comuni", "non_comuni"]) {
        const idx = miniere[nomeMin][r].findIndex(m => getNome(m) === normalizeText(mat));

        if (idx !== -1) {
          miniere[nomeMin][r].splice(idx, 1);
          rimosso = true;
          break;
        }
      }

      if (!rimosso) {
        return interaction.reply({
          content: `⚠️ **${capitalize(mat)}** non trovato in **${nomeMin}**. Neanche il materiale vuole farsi trovare da te.`,
          ephemeral: true
        });
      }

      saveJSON(MINIERE_FILE, miniere);

      return interaction.reply(`🗑️ **${capitalize(mat)}** rimosso da **${nomeMin}**! Pulizia fatta. Incredibile, ogni tanto qualcuno sistema.`);
    }
  } catch (error) {
    console.error(`Errore comando /${interaction.commandName}:`, error);

    const risposta = {
      content: "❌ Errore interno del bot miniere. Controlla i log Railway.",
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

client.login(TOKEN);
