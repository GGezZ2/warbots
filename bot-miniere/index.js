import { Client, GatewayIntentBits, EmbedBuilder, ActivityType } from 'discord.js';
import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';
import sqlite3 from 'sqlite3';
import { open } from 'sqlite';
import { fileURLToPath } from 'url';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const TOKEN = process.env.MINIERE_TOKEN?.trim();

if (!TOKEN) {
  console.error("Manca MINIERE_TOKEN nelle variabili Railway.");
  process.exit(1);
}

const PREFIX = '!';
const DB_PATH = process.env.WESTMARCH_DB_PATH || process.env.DB_PATH || '/data/westmarch.db';
const NOME_BOT = 'Grumni Picconaccia';

const dataDir = path.join(__dirname, 'data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

const MINIERE_FILE = fs.existsSync(path.join(__dirname, 'data', 'miniere.json'))
  ? path.join(__dirname, 'data', 'miniere.json')
  : path.join(__dirname, 'miniere.json');

const FORTEZZE_FILE = path.join(__dirname, 'data', 'fortezze.json');

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

  console.log(`SQLite Miniere collegato a: ${DB_PATH}`);
}

await initDB();

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

const DOMANDE_PERSONAGGIO = [
  'Oi, {name}! Hai {n} personaggi. Quale di questi disgraziati mandi a morire nelle mie miniere? Scrivi il numero.',
  '{name}, scegli il tuo burattino. Chi sacrifichiamo oggi? Scrivi il numero, idiota.',
  'Senti {name}, quale dei tuoi alter ego pezzenti vuoi usare? Scegli il numero e sbrigati.',
  'Oh {name}, hai {n} personaggi e nessuno di loro vale un cazzo. Ma vabbè, scegline uno. Numero.',
  '{name}! {n} personaggi disponibili. Scegli quale mandare al macello. Numero. Ora.',
  'Eccoci, {name}. {n} disgraziati tra cui scegliere. Quale onora le mie miniere della sua inutile presenza? Numero.',
];

const FRASI_ZERO = [
  '💨 **{pg}** ha scavato nella **{miniera}** col carisma di un cucchiaio di legno. Risultato? NIENTE. Come la tua vita sentimentale, sociale e professionale.',
  '🦗 Ah **{pg}**, sei tornato dalla **{miniera}** a mani vuote. Di nuovo. A questo punto è una tradizione di famiglia, no?',
  '😂 La **{miniera}** ha visto arrivare **{pg}** e ha nascosto tutto. TUTTO. Neanche i sassi ti vogliono. Pensa un po\'.',
  '🪨 **{pg}** ha picconato per ore nella **{miniera}**. Ha trovato? La consapevolezza che anche come minatore fai cagare. Gratis, nemmeno quella meritavi.',
  '💀 **{pg}**, sei andato nella **{miniera}** e sei tornato con niente. Mia nonna morta scaverebbe meglio. Con un cucchiaino. Bendata. Sottacqua.',
  '🤡 Complimenti **{pg}**! Hai trasformato la **{miniera}** in una passeggiata della vergogna. Zero materiali, zero dignità, zero speranza. Il trittico perfetto.',
  '🫠 Il dado ha guardato **{pg}** negli occhi, ha riso forte, e gli ha dato un calcio nel culo. ZERO dalla **{miniera}**. Meritatissimo.',
  '🐛 **{pg}** dalla **{miniera}** porta a casa: delusione, imbarazzo e l\'odore di chi ha fallito. Di nuovo. Come sempre.',
  '💩 Ma che piccone usa **{pg}**? Uno fatto di formaggio? La **{miniera}** gli ha dato ZERO e onestamente ha fatto bene.',
  '🪦 R.I.P. la dignità di **{pg}**, morta nella **{miniera}** alle ore {ora}. Non mancherà a nessuno.',
  '🗑️ **{pg}** è l\'unico essere vivente che riesce a entrare in una miniera piena di roba e uscire con NIENTE. Darwin aveva ragione.',
  '🤮 **{pg}** nella **{miniera}**: zero materiali. Se la mediocrità fosse un minerale, saresti ricchissimo.',
  '☠️ Sai cosa hanno in comune **{pg}** e la **{miniera}**? Niente. **{pg}** non ha niente. La miniera ce l\'ha ma non glielo dà. Bellissimo.',
];

const FRASI_TROVATO_1 = [
  '⛏️ Oh. Oh. **{pg}** ha trovato **{q}x {mat}** nella **{miniera}**. Non eccitarti troppo, è UNO. Uno solo. Come i tuoi neuroni funzionanti.',
  '🎉 **{pg}** trova **{q}x {mat}** nella **{miniera}**! Wow, un intero materiale. Applauso? Col cazzo. Torna quando ne trovi due, sfigato.',
  '💎 **{q}x {mat}** dalla **{miniera}** per **{pg}**. Sì ok, bravo. Mio cugino ne trova 10 al giorno e ha un braccio solo, ma non tutti possono.',
  '🔨 *toc toc*... **{q}x {mat}**! **{pg}**, la **{miniera}** ti ha fatto la carità. Come la mensa dei poveri. Ringrazia e sparisci.',
  '✨ **{pg}** estrae **{q}x {mat}** dalla **{miniera}**. Uno. Singolo. Solitario. Come te il sabato sera.',
  '🪙 **{q}x {mat}** dalla **{miniera}**. **{pg}**, tecnicamente è un successo. Come tecnicamente anche un orologio rotto segna l\'ora giusta due volte al giorno.',
  '⛏️ **{pg}**, **{q}x {mat}** dalla **{miniera}**. Oh wow. La mia ascia è più impressionata di me, e la mia ascia non ha sentimenti.',
  '🥉 **{q}x {mat}**! **{pg}**, hai il talento minerario di una patata. Ma almeno la patata è utile in cucina.',
  '🐌 **{pg}** ha trovato **{q}x {mat}** nella **{miniera}**! Con la velocità e l\'efficienza di una lumaca morta. Ma ehi, conta il risultato... forse.',
  '🧻 **{q}x {mat}** dalla **{miniera}** per **{pg}**. Mettilo in tasca, è probabilmente la cosa più preziosa che possiedi.',
];

const FRASI_TROVATO_2 = [
  '🔥🔥 ...Ma che cazzo?! **{pg}** tira fuori **{q}x {mat}** dalla **{miniera}**?! Ok ammetto che sono quasi — QUASI — impressionato. Non ti montare la testa.',
  '💎💎 **{q}x {mat}**?! Dalla **{miniera}**?! **{pg}**, o hai barato, il dado è truccato, o l\'universo ha avuto un ictus.',
  '⛏️⛏️ DUE?! **{q}x {mat}** dalla **{miniera}**?! **{pg}**, mi stai facendo riconsiderare tutto quello che ho detto su di te. Scherzo, fai ancora schifo. Ma meno.',
  '🌟🌟 Per la barba di mio nonno! **{pg}** trova **{q}x {mat}** dalla **{miniera}**! Il dado ti ama più di quanto chiunque ti abbia mai amato nella vita reale.',
  '🎰🎰 **{q}x {mat}**! **{pg}**, hai venduto l\'anima a qualche demone? Perché con quel faccino non è possibile avere \'sta fortuna naturalmente.',
  '💥💥 DOPPIETTA **{q}x {mat}** dalla **{miniera}**! **{pg}**, goditi questo momento. Fotografalo. Stampalo. Perché non ricapiterà MAI PIÙ.',
  '👑👑 **{q}x {mat}**! **{pg}** dalla **{miniera}** come un re! ...Un re di un regno di merda, governato da incompetenti, ma pur sempre un re.',
  '🍀🍀 MA VAFFAN— ok ok. **{q}x {mat}** dalla **{miniera}** per **{pg}**. Mi rode il culo ammetterlo ma... bravo. Ora VATTENE.',
  '😤😤 **{q}x {mat}** dalla **{miniera}**. **{pg}**, sai quanto mi fa incazzare quando uno come te trova roba? TANTO. Goditela, stronzo fortunato.',
  '🏆🏆 Non ci credo. **{q}x {mat}** dalla **{miniera}** per **{pg}**. Devo bere. Dove cazzo è la mia birra.',
];

const FRASI_NON_COMUNE_ZERO = [
  '😬 **{pg}** ha cercato **{mat}** nella **{miniera}**... materiale NON COMUNE, genio. Serviva almeno 9 e tu hai tirato come mia zia cieca al bingo. Patetico.',
  '🫥 **{mat}**? Nella **{miniera}**? **{pg}**, per i non comuni devi tirare ALTO. Non con queste manine da impiegato delle poste in pausa caffè.',
  '🪨 **{pg}** cerca **{mat}** nella **{miniera}** e fallisce. Come al solito. Per i non comuni serve fortuna, e tu sei nato sotto una stella morta.',
  '💤 La **{miniera}** tiene stretti i suoi **{mat}**. Non li dà ai dilettanti come **{pg}**. Torna con una fortezza vera.',
  '🚫 **{pg}** voleva **{mat}** dalla **{miniera}**. La **{miniera}** voleva che **{pg}** andasse a fare in culo. Indovina chi ha vinto?',
  '🤏 Soooo vicino a trovare **{mat}**... AHAHAHAHA no sto scherzando. **{pg}** non era neanche nella stessa galassia.',
  '🐀 **{pg}**, cercare **{mat}** col tuo tiro è come cercare di leccarti il gomito. Puoi provarci, ma fai solo ridere gli altri.',
  '🎪 **{pg}** cercava **{mat}** nella **{miniera}**? Che spettacolo comico. Prossima volta vendo i biglietti.',
];

const FRASI_NO_PG = [
  '🚫 {name}, chi cazzo sei? Non hai personaggi nel registro. Vai dall\'altro bot e creane uno prima di rompere il cazzo a me.',
  '🤷 {name}, zero personaggi. Sei un fantasma. Un nessuno. Vai a creare un PG e poi torna.',
  '😤 {name}, vuoi farmare senza neanche un personaggio?! È come presentarti a una guerra senza armi e senza vestiti.',
  '🪦 {name}, non esisti nel mio registro. Per me sei aria. Crea un PG col bot principale e poi ne riparliamo.',
  '🤡 {name} prova a farmare senza personaggio. SENZA PERSONAGGIO. Fatti una vita prima, poi una scheda.',
];

const FRASI_NO_FORTEZZA = [
  '🏚️ {name}, il tuo **{pg}** non ha ancora una fortezza registrata! Usa `!fortezza {pg} <livello>` per impostarla. Anche 0 va bene, almeno so quanto fai schifo.',
  '🧱 Ehi {name}, **{pg}** non ha la fortezza. Senza fortezza non si farma. `!fortezza {pg} <0-5>`. Muoviti.',
  '🏗️ {name}, **{pg}** è senza fortezza. Come un cavaliere senza cavallo. Patetico. `!fortezza {pg} <0-5>` e poi torna.',
];

function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function randInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function capitalize(s) {
  if (!s) return '';
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function fmt(template, vars) {
  return template.replace(/\{(\w+)\}/g, (_, k) => vars[k] ?? `{${k}}`);
}

function now() {
  const d = new Date();
  return `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()} — ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function todayKey() {
  return new Date().toISOString().slice(0, 10);
}

function hasBetaRole(member) {
  try {
    return member?.roles?.cache?.some(r => r.name.toLowerCase() === 'beta');
  } catch {
    return false;
  }
}

function loadJSON(filepath, defaultVal = {}) {
  try {
    if (fs.existsSync(filepath)) {
      return JSON.parse(fs.readFileSync(filepath, 'utf-8'));
    }
  } catch (e) {
    console.error(`Errore lettura ${filepath}:`, e.message);
  }

  saveJSON(filepath, defaultVal);
  return defaultVal;
}

function saveJSON(filepath, data) {
  fs.writeFileSync(filepath, JSON.stringify(data, null, 2), 'utf-8');
}

function getProficiencyBonus(level) {
  if (level >= 17) return 6;
  if (level >= 13) return 5;
  if (level >= 9) return 4;
  if (level >= 5) return 3;
  return 2;
}

async function ensurePlayer(user) {
  const existing = await db.get("SELECT id FROM players WHERE id = ?", user.id);

  if (!existing) {
    await db.run("INSERT INTO players (id, name) VALUES (?, ?)", user.id, user.username);
  } else {
    await db.run("UPDATE players SET name = ? WHERE id = ?", user.username, user.id);
  }
}

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

async function getPersonaggioById(characterId) {
  return db.get(
    "SELECT id, playerId, name, xp, gold, bank, level FROM characters WHERE id = ?",
    characterId
  );
}

async function aggiungiPgDB(user, nome) {
  await ensurePlayer(user);

  const info = await db.run(
    "INSERT INTO characters (playerId, name, xp, gold, bank, level) VALUES (?, ?, 0, 0, 0, 1)",
    user.id,
    nome
  );

  return getPersonaggioById(info.lastID);
}

async function rimuoviPgDB(userId, nome) {
  const pg = await getPersonaggioByName(userId, nome);
  if (!pg) return false;

  await db.run("DELETE FROM inventory WHERE characterId = ?", pg.id);
  await db.run("DELETE FROM attunements WHERE characterId = ?", pg.id);
  await db.run("DELETE FROM daily_farms WHERE characterId = ?", pg.id);
  await db.run("DELETE FROM characters WHERE id = ?", pg.id);

  return true;
}

async function getInventory(characterId) {
  const rows = await db.all("SELECT item FROM inventory WHERE characterId = ?", characterId);
  return rows.map(r => r.item);
}

async function addInventoryItem(characterId, item) {
  await db.run("INSERT INTO inventory (characterId, item) VALUES (?, ?)", characterId, item);
}

async function addMaterialToInventory(characterId, materiale, quantita) {
  for (let i = 0; i < quantita; i++) {
    await addInventoryItem(characterId, capitalize(materiale));
  }
}

async function getFarmCount(characterId) {
  const row = await db.get(
    "SELECT count FROM daily_farms WHERE characterId = ? AND date = ?",
    characterId,
    todayKey()
  );

  return row?.count || 0;
}

async function incrementFarmCount(characterId) {
  await db.run(
    `INSERT INTO daily_farms (characterId, date, count)
     VALUES (?, ?, 1)
     ON CONFLICT(characterId, date)
     DO UPDATE SET count = count + 1`,
    characterId,
    todayKey()
  );
}

async function canFarmToday(pg) {
  const count = await getFarmCount(pg.id);
  const limit = getProficiencyBonus(pg.level || 1);
  return count < limit;
}

function getFortezza(charId) {
  const data = loadJSON(FORTEZZE_FILE);
  return data[String(charId)] || null;
}

function setFortezza(charId, nomeFort, livello) {
  const data = loadJSON(FORTEZZE_FILE);
  data[String(charId)] = { nome_fortezza: nomeFort, livello };
  saveJSON(FORTEZZE_FILE, data);
}

function setLivelloFortezza(charId, livello) {
  const data = loadJSON(FORTEZZE_FILE);
  const cid = String(charId);

  if (data[cid]) {
    data[cid].livello = livello;
  } else {
    data[cid] = { nome_fortezza: 'Senza Nome', livello };
  }

  saveJSON(FORTEZZE_FILE, data);
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
  return typeof mat === 'object' ? mat.nome.toLowerCase() : mat.toLowerCase();
}

function getMestieri(mat) {
  return typeof mat === 'object' ? (mat.mestieri || []) : [];
}

function getTags(mat) {
  return typeof mat === 'object' ? (mat.tags || '') : '';
}

function trovaMateriale(miniere, nomeMat) {
  const nl = nomeMat.toLowerCase();

  for (const [miniera, dati] of Object.entries(miniere)) {
    for (const mat of (dati.comuni || [])) {
      if (getNome(mat) === nl) {
        return {
          miniera,
          rarita: 'comuni',
          mestieri: getMestieri(mat),
          tags: getTags(mat)
        };
      }
    }

    for (const mat of (dati.non_comuni || [])) {
      if (getNome(mat) === nl) {
        return {
          miniera,
          rarita: 'non_comuni',
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
      nomi.add(getNome(mat));
    }
  }

  return [...nomi];
}

function suggerisciMateriale(miniere, input, max = 3) {
  const il = input.toLowerCase();
  const nomi = tuttiNomiMateriali(miniere);
  const sugg = [];

  for (const nome of nomi) {
    if (il.includes(nome) || nome.includes(il)) {
      sugg.push([0, nome]);
      continue;
    }

    let cs = 0;

    for (let i = 0; i < Math.min(il.length, nome.length); i++) {
      if (il[i] === nome[i]) cs++;
      else break;
    }

    if (cs >= 3) {
      sugg.push([1, nome]);
      continue;
    }

    const pi = new Set(il.split(' '));
    const pn = new Set(nome.split(' '));

    if ([...pi].some(w => pn.has(w))) {
      sugg.push([2, nome]);
    }
  }

  sugg.sort((a, b) => a[0] - b[0]);
  return sugg.slice(0, max).map(s => s[1]);
}

function calcolaRisultato(dado, fortezza, rarita) {
  const totale = dado + fortezza;

  if (rarita === 'comuni') {
    if (totale <= 3) return 0;
    if (totale <= 8) return 1;
    return 2;
  }

  if (totale <= 8) return 0;
  if (totale <= 11) return 1;
  return 2;
}

const farmingInCorso = new Map();
const fortezzaSetup = new Map();

async function eseguiFarm(channel, author, pg, fortezza, materiale, miniera, rarita, mestieri = [], tags = '') {
  const livFort = fortezza.livello;
  const nomeFort = fortezza.nome_fortezza;
  const dado = randInt(1, 10);
  const totale = dado + livFort;
  const quantita = calcolaRisultato(dado, livFort, rarita);

  await incrementFarmCount(pg.id);

  if (quantita > 0) {
    await addMaterialToInventory(pg.id, materiale, quantita);
  }

  const farmCount = await getFarmCount(pg.id);
  const farmLimit = getProficiencyBonus(pg.level || 1);

  const matDisplay = capitalize(materiale);
  const nomePg = pg.name;
  const dataRicerca = now();
  const v = { pg: nomePg, mat: matDisplay, miniera, q: quantita, ora: dataRicerca };

  let frase;

  if (quantita === 0) {
    frase = rarita === 'non_comuni' && totale >= 4
      ? fmt(pick(FRASI_NON_COMUNE_ZERO), v)
      : fmt(pick(FRASI_ZERO), v);
  } else if (quantita === 1) {
    frase = fmt(pick(FRASI_TROVATO_1), v);
  } else {
    frase = fmt(pick(FRASI_TROVATO_2), v);
  }

  const tipoRar = rarita === 'comuni' ? '⚪ Comune' : '🟣 Non Comune';
  const matConTag = tags ? `${tags} ${matDisplay}` : matDisplay;

  const embed = new EmbedBuilder()
    .setTitle(`📜 ${NOME_BOT} — Rapporto di Ricerca`)
    .setDescription(frase)
    .setColor(quantita > 0 ? 0x2ecc71 : 0xe74c3c)
    .addFields(
      { name: '👤 Personaggio', value: nomePg, inline: true },
      { name: '🏰 Fortezza', value: `${nomeFort} (Lv. ${livFort})`, inline: true },
      { name: '⛏️ Luogo di Ricerca', value: miniera, inline: true },
      { name: '🔍 Materiale Cercato', value: `${matConTag} (${tipoRar})`, inline: true },
      { name: '📦 Quantità Raccolta', value: `**${quantita}**`, inline: true },
      {
        name: '🧺 Inventario',
        value: quantita > 0
          ? `Aggiunto automaticamente: **${quantita}x ${matDisplay}**`
          : 'Nessun materiale aggiunto',
        inline: true
      },
      { name: '📆 Farm Giornalieri', value: `${farmCount} / ${farmLimit}`, inline: true },
      { name: '🎲 Dado', value: `${dado} + ${livFort} (fortezza) = **${totale}**`, inline: true },
      { name: '📅 Data Ricerca', value: dataRicerca, inline: true },
    )
    .setFooter({ text: `— ${NOME_BOT}, Maestro delle Miniere (e della tua miseria)` });

  await channel.send({ content: `<@${author.id}>`, embeds: [embed] });
}

client.once('ready', () => {
  console.log(`⛏️ ${NOME_BOT} online come ${client.user.tag}!`);
  console.log(`Prefisso: ${PREFIX}`);
  console.log(`Server connessi: ${client.guilds.cache.size}`);
  console.log(`DB Westmarch SQLite: ${DB_PATH}`);
  console.log(`File miniere: ${MINIERE_FILE}`);
  console.log(`File fortezze: ${FORTEZZE_FILE}`);

  client.user.setActivity('a rompere picconi | !farm', {
    type: ActivityType.Playing
  });
});

client.on('messageCreate', async (message) => {
  if (message.author.bot) return;

  if (!message.content.startsWith(PREFIX)) {
    const userId = message.author.id;

    if (fortezzaSetup.has(userId)) {
      const stato = fortezzaSetup.get(userId);
      if (message.channel.id !== stato.canale) return;

      const testo = message.content.trim();

      if (stato.fase === 'nome_fortezza') {
        if (testo.length > 50) {
          return message.channel.send(`🙄 ${message.author}, 50 caratteri max. Non è un romanzo.`);
        }

        stato.nomeFortezza = testo;
        stato.fase = 'livello_fortezza';

        return message.channel.send(
          `🏰 **${testo}**? Suona come un posto dove piove dentro. Vabbè.\n` +
          `**Livello fortezza?** (0-5)`
        );
      }

      if (stato.fase === 'livello_fortezza') {
        const livello = parseInt(testo);

        if (isNaN(livello)) {
          return message.channel.send(`🤨 ${message.author}, un NUMERO. Da 0 a 5. N-U-M-E-R-O.`);
        }

        if (livello < 0 || livello > 5) {
          return message.channel.send(`🙄 ${message.author}, da 0 a 5. Hai scritto ${livello}. Sai contare?`);
        }

        setFortezza(stato.characterId, stato.nomeFortezza, livello);
        fortezzaSetup.delete(userId);

        const embed = new EmbedBuilder()
          .setTitle('🏰 Fortezza Registrata!')
          .setDescription(`**${stato.nomePg}** ora ha una fortezza. Quasi impressionante. Quasi.`)
          .setColor(0x2ecc71)
          .addFields(
            { name: '👤 Personaggio', value: stato.nomePg, inline: true },
            { name: '🏰 Fortezza', value: `${stato.nomeFortezza} (Lv. ${livello})`, inline: true },
          )
          .setFooter({ text: `— ${NOME_BOT}` });

        return message.channel.send({
          content: `${message.author}`,
          embeds: [embed]
        });
      }

      return;
    }

    if (farmingInCorso.has(userId)) {
      const stato = farmingInCorso.get(userId);
      if (message.channel.id !== stato.canale) return;

      if (stato.fase === 'scelta_pg') {
        const scelta = parseInt(message.content.trim());

        if (isNaN(scelta)) {
          return message.channel.send(`🤨 ${message.author}, un NUMERO. Il numero del personaggio. Quanto è difficile?`);
        }

        if (scelta < 1 || scelta > stato.personaggi.length) {
          return message.channel.send(`🙄 ${message.author}, da 1 a ${stato.personaggi.length}. Hai scritto ${scelta}. Sei daltonico anche coi numeri?`);
        }

        const pg = stato.personaggi[scelta - 1];
        const fortezza = pg.fortezza;
        farmingInCorso.delete(userId);

        if (!fortezza) {
          return message.channel.send(fmt(pick(FRASI_NO_FORTEZZA), {
            name: `${message.author}`,
            pg: pg.name
          }));
        }

        if (!(await canFarmToday(pg))) {
          const count = await getFarmCount(pg.id);
          const limit = getProficiencyBonus(pg.level || 1);

          return message.channel.send(
            `⛏️ **${pg.name}** ha già farmato **${count} / ${limit}** volte oggi.\n` +
            `Il limite giornaliero è pari al bonus competenza: **+${limit}**.`
          );
        }

        return eseguiFarm(
          message.channel,
          message.author,
          pg,
          fortezza,
          stato.materiale,
          stato.miniera,
          stato.rarita,
          stato.mestieri,
          stato.tags
        );
      }
    }

    return;
  }

  const args = message.content.slice(PREFIX.length).trim().split(/ +/);
  const command = args.shift().toLowerCase();
  const isBeta = hasBetaRole(message.member);

  if (command === 'aiuto') {
    const embed = new EmbedBuilder()
      .setTitle(`⛏️ ${NOME_BOT} — Comandi`)
      .setDescription(`Ascolta bene perché **${NOME_BOT}** non ripete. Mai.`)
      .setColor(0xb8860b)
      .addFields(
        {
          name: '📋 Personaggi & Fortezze',
          value:
            '`!scheda` — Vedi i tuoi personaggi + fortezze\n' +
            '`!fortezza <nome_pg> setup` — Imposta nome e livello\n' +
            '`!fortezza <nome_pg> <livello>` — Aggiorna solo il livello',
          inline: false
        },
        {
          name: '⛏️ Farming',
          value:
            '`!farm <materiale>` — Cerca un materiale\n' +
            '`!farm` — Lista materiali\n' +
            '`!materiali` — Mappa miniere',
          inline: false
        },
        {
          name: '🔧 Gestione Miniere',
          value:
            '`!addminiera <nome>`\n' +
            '`!delminiera <nome>`\n' +
            '`!addmat <miniera> | <materiale> | <comune/non_comune>`\n' +
            '`!delmat <miniera> | <materiale>`\n' +
            'Richiede ruolo **Beta**.',
          inline: false
        },
        {
          name: '👥 Gestione PG',
          value:
            '`!addpg @utente <nome>`\n' +
            '`!delpg @utente <nome>`\n' +
            '`!listapg [@utente]`\n' +
            'Richiede ruolo **Beta**.',
          inline: false
        },
        {
          name: '🎲 Come funziona',
          value:
            '1. Crea un PG\n' +
            '2. `!fortezza <pg> setup`\n' +
            '3. `!farm <materiale>`\n' +
            '4. Dado + fortezza = risultato\n' +
            '5. Trovi 0, 1 o 2 materiali. Probabilmente 0.',
          inline: false
        },
        {
          name: '📊 Tabella Risultati',
          value:
            '**Comune:** 1-3=0 | 4-8=1 | 9-15=2\n' +
            '**Non Comune:** 1-8=0 | 9-11=1 | 12-15=2',
          inline: false
        },
      );

    return message.channel.send({ embeds: [embed] });
  }

  if (command === 'scheda') {
    const pgs = await getPersonaggiUtente(message.author.id);

    if (!pgs.length) {
      return message.channel.send(fmt(pick(FRASI_NO_PG), {
        name: `${message.author}`
      }));
    }

    const embed = new EmbedBuilder()
      .setTitle(`📋 Personaggi di ${message.author.displayName}`)
      .setDescription('Ecco i tuoi schiav— ehm, personaggi.')
      .setColor(0x3498db)
      .setFooter({ text: `— ${NOME_BOT}, che tiene il registro dei disgraziati` });

    for (const pg of pgs) {
      const fort = getFortezza(pg.id);
      const inventory = await getInventory(pg.id);
      const limit = getProficiencyBonus(pg.level || 1);
      const count = await getFarmCount(pg.id);

      const fortInfo = fort
        ? `🏰 **${fort.nome_fortezza}** (Lv. ${fort.livello})`
        : '🏚️ *Nessuna fortezza*';

      embed.addFields({
        name: `${pg.name} — Lv. ${pg.level} | Comp. +${limit}`,
        value:
          `XP: ${pg.xp} | 💰 Gold: ${pg.gold} | 🏦 Deposito: ${pg.bank}\n` +
          `Farm oggi: **${count} / ${limit}**\n` +
          `${fortInfo}\n` +
          `Inventario: ${inventory.length ? inventory.join(', ') : 'Vuoto'}`,
        inline: false
      });
    }

    return message.channel.send({ embeds: [embed] });
  }

  if (command === 'fortezza') {
    const raw = args.join(' ').trim();

    if (!raw) {
      return message.channel.send('⚠️ Uso: `!fortezza <nome_pg> <livello>` oppure `!fortezza <nome_pg> setup`');
    }

    const parti = raw.replace(/\s+/g, ' ').split(' ');
    const azione = parti.pop().toLowerCase();
    const nomePg = parti.join(' ');

    if (!nomePg) {
      return message.channel.send('⚠️ Uso: `!fortezza <nome_pg> <livello>`');
    }

    const pg = await getPersonaggioByName(message.author.id, nomePg);

    if (!pg) {
      return message.channel.send(`🤷 ${message.author}, **${nomePg}**? Non esiste nel registro.`);
    }

    if (azione === 'setup') {
      fortezzaSetup.set(message.author.id, {
        fase: 'nome_fortezza',
        canale: message.channel.id,
        characterId: pg.id,
        nomePg: pg.name
      });

      return message.channel.send(
        `🏰 ${message.author}, ok, impostiamo la fortezza di **${pg.name}**.\n` +
        `**Come si chiama 'sta catapecchia?** Scrivi il nome.`
      );
    }

    const livello = parseInt(azione);

    if (isNaN(livello)) {
      return message.channel.send('⚠️ Uso: `!fortezza <nome_pg> <livello>` — numero da 0 a 5.');
    }

    if (livello < 0 || livello > 5) {
      return message.channel.send(`🙄 ${message.author}, da 0 a 5. Hai scritto ${livello}. Sai contare?`);
    }

    setLivelloFortezza(pg.id, livello);
    const fort = getFortezza(pg.id);

    return message.channel.send(
      `🏰 ${message.author}, fortezza di **${pg.name}** aggiornata!\n` +
      `**${fort.nome_fortezza}** — Livello **${livello}**`
    );
  }

  if (command === 'farm') {
    const materiale = args.join(' ').trim().toLowerCase();

    if (!materiale) {
      const miniere = caricaMiniere();
      const embeds = [];

      let currentEmbed = new EmbedBuilder()
        .setTitle(`⛏️ ${NOME_BOT} — Lista Materiali`)
        .setDescription('Usa `!farm <nome materiale>` o levati dai piedi.')
        .setColor(0xf1c40f);

      let fieldCount = 0;

      for (const [minieraNome, dati] of Object.entries(miniere)) {
        let valore = '';

        for (const m of (dati.comuni || [])) {
          const mestStr = getMestieri(m).map(capitalize).join(', ');
          valore += `⚪ ${getTags(m)} ${capitalize(getNome(m))} *(${mestStr})*\n`;
        }

        for (const m of (dati.non_comuni || [])) {
          const mestStr = getMestieri(m).map(capitalize).join(', ');
          valore += `🟣 ${getTags(m)} ${capitalize(getNome(m))} *(${mestStr})*\n`;
        }

        if (!valore) continue;

        if (valore.length > 1024) {
          const righe = valore.split('\n').filter(r => r);
          let chunk = '';
          let partNum = 1;

          for (const riga of righe) {
            if (chunk.length + riga.length + 1 > 1020) {
              currentEmbed.addFields({
                name: `⛏️ ${minieraNome}${partNum > 1 ? ` (${partNum})` : ''}`,
                value: chunk.trim(),
                inline: false
              });

              fieldCount++;
              chunk = riga + '\n';
              partNum++;
            } else {
              chunk += riga + '\n';
            }
          }

          if (chunk.trim()) {
            currentEmbed.addFields({
              name: `⛏️ ${minieraNome}${partNum > 1 ? ` (${partNum})` : ''}`,
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

      for (const emb of embeds) {
        await message.channel.send({ embeds: [emb] });
      }

      return;
    }

    const pgs = await getPersonaggiUtente(message.author.id);

    if (!pgs.length) {
      return message.channel.send(fmt(pick(FRASI_NO_PG), {
        name: `${message.author}`
      }));
    }

    const miniere = caricaMiniere();
    const trovato = trovaMateriale(miniere, materiale);

    if (!trovato) {
      const sugg = suggerisciMateriale(miniere, materiale);

      let msg = `🤷 **${capitalize(materiale)}**?! ${message.author}, ma che cazzo è? Non esiste in nessuna delle MIE miniere.`;

      if (sugg.length) {
        msg += `\n\n🧠 Forse volevi dire... ${sugg.map(s => `\`${s}\``).join(', ')}? Scrivi bene, analfabeta.`;
      } else {
        msg += '\nUsa `!farm` per vedere cosa c\'è davvero, ignorante.';
      }

      return message.channel.send(msg);
    }

    if (pgs.length === 1) {
      const pg = pgs[0];
      const fortezza = getFortezza(pg.id);

      if (!fortezza) {
        return message.channel.send(fmt(pick(FRASI_NO_FORTEZZA), {
          name: `${message.author}`,
          pg: pg.name
        }));
      }

      if (!(await canFarmToday(pg))) {
        const count = await getFarmCount(pg.id);
        const limit = getProficiencyBonus(pg.level || 1);

        return message.channel.send(
          `⛏️ **${pg.name}** ha già farmato **${count} / ${limit}** volte oggi.\n` +
          `Il limite giornaliero è pari al bonus competenza: **+${limit}**.`
        );
      }

      return eseguiFarm(
        message.channel,
        message.author,
        pg,
        fortezza,
        materiale,
        trovato.miniera,
        trovato.rarita,
        trovato.mestieri,
        trovato.tags
      );
    }

    const pgConFort = [];

    for (const pg of pgs) {
      pgConFort.push({
        ...pg,
        fortezza: getFortezza(pg.id)
      });
    }

    farmingInCorso.set(message.author.id, {
      fase: 'scelta_pg',
      materiale,
      miniera: trovato.miniera,
      rarita: trovato.rarita,
      mestieri: trovato.mestieri,
      tags: trovato.tags,
      canale: message.channel.id,
      personaggi: pgConFort,
    });

    const lista = [];

    for (let i = 0; i < pgConFort.length; i++) {
      const pg = pgConFort[i];
      const count = await getFarmCount(pg.id);
      const limit = getProficiencyBonus(pg.level || 1);

      lista.push(
        `**${i + 1}.** ${pg.name} (Lv. ${pg.level}, Comp. +${limit}) — ` +
        `Farm oggi: ${count}/${limit} — ` +
        `${pg.fortezza ? `🏰 ${pg.fortezza.nome_fortezza} (Fort. ${pg.fortezza.livello})` : '🏚️ Nessuna fortezza'}`
      );
    }

    const domanda = fmt(pick(DOMANDE_PERSONAGGIO), {
      name: message.author.displayName,
      n: pgConFort.length
    });

    return message.channel.send(`${message.author}\n${domanda}\n\n${lista.join('\n')}`);
  }

  if (command === 'materiali') {
    const miniere = caricaMiniere();

    const embed = new EmbedBuilder()
      .setTitle(`🗺️ ${NOME_BOT} — Mappa delle MIE Miniere`)
      .setDescription('Queste sono le MIE miniere. Voi ci entrate perché io ve lo PERMETTO. Chiaro?')
      .setColor(0xb8860b);

    for (const [min, dati] of Object.entries(miniere)) {
      const c = (dati.comuni || []).map(m => capitalize(getNome(m))).join(', ');
      const nc = (dati.non_comuni || []).map(m => capitalize(getNome(m))).join(', ');

      let val = '';

      if (c) val += `⚪ Comuni: ${c}\n`;
      if (nc) val += `🟣 Non comuni: ${nc}`;

      embed.addFields({
        name: `⛏️ ${min}`,
        value: val || 'Vuota',
        inline: false
      });
    }

    return message.channel.send({ embeds: [embed] });
  }

  if (command === 'addpg') {
    if (!isBeta) {
      return message.channel.send(`🚫 Serve il ruolo **Beta**, verme. — **${NOME_BOT}**`);
    }

    const utente = message.mentions.members?.first();
    const nome = args.slice(1).join(' ').trim();

    if (!utente || !nome) {
      return message.channel.send('⚠️ Uso: `!addpg @utente <nome personaggio>`');
    }

    const existing = await getPersonaggioByName(utente.id, nome);

    if (existing) {
      return message.channel.send(`⚠️ **${nome}** esiste già per ${utente.displayName}!`);
    }

    const pgs = await getPersonaggiUtente(utente.id);

    if (pgs.length >= 3) {
      return message.channel.send(`⚠️ ${utente.displayName} ha già 3 PG attivi.`);
    }

    const pg = await aggiungiPgDB(utente.user, nome);

    return message.channel.send(
      `✅ Personaggio **${nome}** creato per ${utente}! (ID: ${pg.id})\n` +
      `Ora: \`!fortezza ${nome} setup\``
    );
  }

  if (command === 'delpg') {
    if (!isBeta) {
      return message.channel.send(`🚫 Serve il ruolo **Beta**, verme. — **${NOME_BOT}**`);
    }

    const utente = message.mentions.members?.first();
    const nome = args.slice(1).join(' ').trim();

    if (!utente || !nome) {
      return message.channel.send('⚠️ Uso: `!delpg @utente <nome personaggio>`');
    }

    if (await rimuoviPgDB(utente.id, nome)) {
      return message.channel.send(`💥 **${nome}** di ${utente.displayName} eliminato!`);
    }

    return message.channel.send(`⚠️ **${nome}** non trovato per ${utente.displayName}.`);
  }

  if (command === 'listapg') {
    if (!isBeta) {
      return message.channel.send(`🚫 Serve il ruolo **Beta**, verme. — **${NOME_BOT}**`);
    }

    const utente = message.mentions.members?.first();

    if (utente) {
      const pgs = await getPersonaggiUtente(utente.id);

      if (!pgs.length) {
        return message.channel.send(`📋 ${utente.displayName} non ha PG.`);
      }

      const embed = new EmbedBuilder()
        .setTitle(`📋 PG di ${utente.displayName}`)
        .setColor(0x3498db);

      for (const pg of pgs) {
        const f = getFortezza(pg.id);
        const limit = getProficiencyBonus(pg.level || 1);
        const count = await getFarmCount(pg.id);

        embed.addFields({
          name: `ID ${pg.id} — ${pg.name}`,
          value:
            `Lv. ${pg.level} | Comp. +${limit} | Farm oggi ${count}/${limit} | ` +
            `${f ? `🏰 ${f.nome_fortezza} (Lv. ${f.livello})` : '🏚️ Nessuna'}`,
          inline: false
        });
      }

      return message.channel.send({ embeds: [embed] });
    }

    const rows = await db.all("SELECT * FROM characters ORDER BY playerId ASC, id ASC");

    if (!rows.length) {
      return message.channel.send('📋 Nessun PG registrato.');
    }

    const embed = new EmbedBuilder()
      .setTitle('📋 Tutti i PG')
      .setColor(0x3498db);

    const byUser = {};

    for (const pg of rows) {
      byUser[pg.playerId] ??= [];
      byUser[pg.playerId].push(pg);
    }

    for (const [uid, pgs] of Object.entries(byUser)) {
      embed.addFields({
        name: `👤 User ID: ${uid}`,
        value: pgs
          .map(pg => `**${pg.name}** (ID ${pg.id}, Lv. ${pg.level}, Comp. +${getProficiencyBonus(pg.level || 1)})`)
          .join(', '),
        inline: false
      });
    }

    return message.channel.send({ embeds: [embed] });
  }

  if (command === 'addminiera') {
    if (!isBeta) {
      return message.channel.send(`🚫 Serve il ruolo **Beta**, verme. — **${NOME_BOT}**`);
    }

    const nome = args.join(' ').trim();

    if (!nome) {
      return message.channel.send('⚠️ Uso: `!addminiera <nome>`');
    }

    const miniere = caricaMiniere();

    if (miniere[nome]) {
      return message.channel.send(`⚠️ **${nome}** esiste già!`);
    }

    miniere[nome] = {
      comuni: [],
      non_comuni: []
    };

    saveJSON(MINIERE_FILE, miniere);

    return message.channel.send(`🆕 Miniera **${nome}** creata!`);
  }

  if (command === 'delminiera') {
    if (!isBeta) {
      return message.channel.send(`🚫 Serve il ruolo **Beta**, verme. — **${NOME_BOT}**`);
    }

    const nome = args.join(' ').trim();

    if (!nome) {
      return message.channel.send('⚠️ Uso: `!delminiera <nome>`');
    }

    const miniere = caricaMiniere();

    if (!miniere[nome]) {
      return message.channel.send(`⚠️ **${nome}** non esiste.`);
    }

    delete miniere[nome];
    saveJSON(MINIERE_FILE, miniere);

    return message.channel.send(`💥 Miniera **${nome}** eliminata!`);
  }

  if (command === 'addmat') {
    if (!isBeta) {
      return message.channel.send(`🚫 Serve il ruolo **Beta**, verme. — **${NOME_BOT}**`);
    }

    const raw = args.join(' ');
    const parti = raw.split('|').map(s => s.trim());

    if (parti.length !== 3) {
      return message.channel.send('⚠️ Uso: `!addmat <miniera> | <materiale> | <comune/non_comune>`');
    }

    let [nomeMin, mat, rar] = parti;

    mat = mat.toLowerCase();
    rar = rar.toLowerCase().replace(' ', '_');

    if (rar === 'comune') rar = 'comuni';
    if (rar === 'non_comune') rar = 'non_comuni';

    if (!['comuni', 'non_comuni'].includes(rar)) {
      return message.channel.send('⚠️ Rarità: `comune` o `non_comune`');
    }

    const miniere = caricaMiniere();

    if (!miniere[nomeMin]) {
      return message.channel.send(`⚠️ Miniera **${nomeMin}** non esiste.`);
    }

    miniere[nomeMin][rar].push(mat);
    saveJSON(MINIERE_FILE, miniere);

    const tipo = rar === 'comuni' ? '⚪ Comune' : '🟣 Non Comune';

    return message.channel.send(`✅ **${capitalize(mat)}** (${tipo}) aggiunto a **${nomeMin}**!`);
  }

  if (command === 'delmat') {
    if (!isBeta) {
      return message.channel.send(`🚫 Serve il ruolo **Beta**, verme. — **${NOME_BOT}**`);
    }

    const raw = args.join(' ');
    const parti = raw.split('|').map(s => s.trim());

    if (parti.length !== 2) {
      return message.channel.send('⚠️ Uso: `!delmat <miniera> | <materiale>`');
    }

    const [nomeMin, mat] = parti;
    const matL = mat.toLowerCase();
    const miniere = caricaMiniere();

    if (!miniere[nomeMin]) {
      return message.channel.send(`⚠️ Miniera **${nomeMin}** non esiste.`);
    }

    let rimosso = false;

    for (const r of ['comuni', 'non_comuni']) {
      const idx = miniere[nomeMin][r].findIndex(m => getNome(m) === matL);

      if (idx !== -1) {
        miniere[nomeMin][r].splice(idx, 1);
        rimosso = true;
        break;
      }
    }

    if (!rimosso) {
      return message.channel.send(`⚠️ **${capitalize(mat)}** non trovato in **${nomeMin}**.`);
    }

    saveJSON(MINIERE_FILE, miniere);

    return message.channel.send(`🗑️ **${capitalize(mat)}** rimosso da **${nomeMin}**!`);
  }
});

client.login(TOKEN);
