import "dotenv/config";
import sqlite3 from "sqlite3";
import { open } from "sqlite";
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  Client,
  EmbedBuilder,
  GatewayIntentBits,
  ModalBuilder,
  PermissionsBitField,
  TextInputBuilder,
  TextInputStyle
} from "discord.js";

const TOKEN = process.env.SHOT_TOKEN?.trim();
const DB_PATH =
  process.env.WESTMARCH_DB_PATH?.trim() ||
  process.env.DB_PATH?.trim() ||
  "/data/westmarch.db";

const MASTER_LOG_CHANNEL_ID = process.env.MASTER_LOG_CHANNEL_ID?.trim();
const MASTER_QUEUE_CHANNEL_ID = process.env.MASTER_QUEUE_CHANNEL_ID?.trim();

const BOT_NAME = "Gilda";
const GM_ROLE_NAME = "gm-bot";

const GRADES = ["C", "C+", "B", "B+", "A", "A+", "S", "S+", "Z"];

const MASTER_REWARDS = {
  C: { xp: 400, gold: 100 },
  "C+": { xp: 600, gold: 200 },
  B: { xp: 1200, gold: 300 },
  "B+": { xp: 1800, gold: 400 },
  A: { xp: 2400, gold: 800 },
  "A+": { xp: 3600, gold: 1200 },
  S: { xp: 4800, gold: 1600 },
  "S+": { xp: 9600, gold: 2000 },
  Z: { xp: 19200, gold: 2400 }
};

const LINES = {
  opened: [
    "Ho preparato una pagina nuovissima per questa impresa! Cercate di renderla gloriosa, va bene?",
    "La missiva è pronta! Oh, che emozione… magari questa volta qualcuno tornerà con un mantello svolazzante e una storia meravigliosa.",
    "Iscrizioni aperte! Ricordate: l'epicità è importante, ma anche tornare a casa interi è una vittoria."
  ],
  signed: [
    "Candidatura registrata! Ho lasciato uno spazietto negli archivi per il vostro momento eroico.",
    "Segnato tutto! Che bello, un altro nome da scrivere nelle cronache… con calligrafia molto elegante, promesso.",
    "Perfetto! Il tuo nome è sulla missiva. Adesso manca solo una piccola cosa: fare qualcosa di memorabile."
  ],
  closed: [
    "Le iscrizioni sono chiuse! Ora il Master sceglierà chi accompagnerà questa piccola, adorabile e probabilmente pericolosissima impresa.",
    "Niente altri nomi per questa volta. Ma non preoccupatevi: le cronache hanno sempre bisogno di nuovi protagonisti!",
    "Missiva chiusa! Ho contato tutti gli iscritti due volte. Tre, se contiamo l'emozione."
  ],
  finished: [
    "Impresa registrata! Bravissimi, davvero. Ho persino usato l'inchiostro dorato per la prima riga.",
    "Le cronache sono aggiornate! Che storia meravigliosa… anche le parti in cui siete quasi morti.",
    "Pagina conclusa e ricompense distribuite! Siete stati eroici, o quantomeno molto determinati."
  ]
};

if (!TOKEN) {
  console.error("Manca SHOT_TOKEN.");
  process.exit(1);
}

const client = new Client({ intents: [GatewayIntentBits.Guilds] });
let db;

const now = () => new Date().toISOString();
const pick = lines => lines[Math.floor(Math.random() * lines.length)];

function daysSince(date) {
  if (!date) return null;
  return Math.max(0, Math.floor((Date.now() - new Date(date).getTime()) / 86400000));
}

function gradeFromLevel(level) {
  const l = Number(level || 1);
  if (l <= 2) return "C";
  if (l <= 4) return "C+";
  if (l <= 6) return "B";
  if (l <= 8) return "B+";
  if (l <= 10) return "A";
  if (l <= 12) return "A+";
  if (l <= 14) return "S";
  if (l <= 16) return "S+";
  return "Z";
}

function gradeDistance(a, b) {
  return Math.abs(GRADES.indexOf(a) - GRADES.indexOf(b));
}

function isMaster(interaction) {
  return (
    interaction.memberPermissions?.has(PermissionsBitField.Flags.Administrator) ||
    interaction.member?.roles?.cache?.some(role => role.name === GM_ROLE_NAME)
  );
}

function masterInterval(count) {
  if (count >= 3) return 2;
  if (count === 2) return 3;
  return 5;
}

async function fail(interaction, text) {
  const payload = {
    content: `📜 **${BOT_NAME}:** ${text}`,
    ephemeral: true
  };

  if (interaction.replied || interaction.deferred) {
    return interaction.followUp(payload);
  }

  return interaction.reply(payload);
}

async function initDatabase() {
  db = await open({ filename: DB_PATH, driver: sqlite3.Database });

  await db.exec(`
    CREATE TABLE IF NOT EXISTS wm_shots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      threadId TEXT NOT NULL UNIQUE,
      title TEXT NOT NULL,
      grade TEXT NOT NULL,
      slotsPerTable INTEGER NOT NULL,
      tableCount INTEGER NOT NULL DEFAULT 1,
      xpReward INTEGER NOT NULL,
      scheduledDate TEXT NOT NULL DEFAULT '',
      timeSlot TEXT NOT NULL DEFAULT '',
      synopsis TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'aperta',
      masterId TEXT NOT NULL,
      signupMessageId TEXT,
      openedAt TEXT NOT NULL,
      closedAt TEXT
    );

    CREATE TABLE IF NOT EXISTS wm_shot_people (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      shotId INTEGER NOT NULL,
      characterId INTEGER NOT NULL,
      playerId TEXT NOT NULL,
      characterName TEXT NOT NULL,
      narrativeHook TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'iscritto',
      tableNumber INTEGER,
      note TEXT NOT NULL DEFAULT '',
      createdAt TEXT NOT NULL,
      UNIQUE(shotId, characterId)
    );

    CREATE TABLE IF NOT EXISTS wm_participation (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      playerId TEXT NOT NULL,
      characterId INTEGER,
      shotId INTEGER,
      playedAt TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS wm_shot_rewards (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      shotId INTEGER NOT NULL,
      characterId INTEGER NOT NULL,
      rewardType TEXT NOT NULL,
      rewardName TEXT NOT NULL,
      quantity INTEGER NOT NULL,
      applied INTEGER NOT NULL DEFAULT 0,
      createdAt TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS wm_shot_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      shotId INTEGER NOT NULL UNIQUE,
      masterId TEXT NOT NULL,
      outcome TEXT NOT NULL,
      summary TEXT NOT NULL,
      staffNote TEXT NOT NULL DEFAULT '',
      createdAt TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS wm_master_progress (
      masterId TEXT PRIMARY KEY,
      masteredShots INTEGER NOT NULL DEFAULT 0,
      characterQueue TEXT NOT NULL DEFAULT '[]',
      pendingRewards INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS wm_master_reward_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      masterId TEXT NOT NULL,
      shotNumber INTEGER NOT NULL,
      characterId INTEGER,
      characterName TEXT NOT NULL,
      status TEXT NOT NULL,
      createdAt TEXT NOT NULL
    );
  `);

  const columns = await db.all("PRAGMA table_info(wm_shots)");
  const addColumn = async (name, definition) => {
    if (!columns.some(column => column.name === name)) {
      await db.exec(`ALTER TABLE wm_shots ADD COLUMN ${name} ${definition}`);
    }
  };

  await addColumn("scheduledDate", "TEXT NOT NULL DEFAULT ''");
  await addColumn("timeSlot", "TEXT NOT NULL DEFAULT ''");
  await addColumn("synopsis", "TEXT NOT NULL DEFAULT ''");
  await addColumn("signupMessageId", "TEXT");

  console.log(`${BOT_NAME} collegata a: ${DB_PATH}`);
}

async function getShot(threadId) {
  return db.get("SELECT * FROM wm_shots WHERE threadId = ?", threadId);
}

async function getParticipants(shotId) {
  return db.all(
    `SELECT * FROM wm_shot_people
     WHERE shotId = ? AND status IN ('titolare', 'subentrato')
     ORDER BY tableNumber, characterName`,
    shotId
  );
}

async function updateSignupBoard(shot) {
  if (!shot.signupMessageId) return;

  const thread = await client.channels.fetch(shot.threadId).catch(() => null);
  if (!thread?.isTextBased()) return;

  const message = await thread.messages
    .fetch(shot.signupMessageId)
    .catch(() => null);

  if (!message) return;

  const applicants = await db.all(
    `SELECT characterName, status, tableNumber
     FROM wm_shot_people
     WHERE shotId = ?
     AND status NOT IN ('ritirato', 'rimosso')
     ORDER BY createdAt, characterName`,
    shot.id
  );

  const names =
    applicants
      .map((person, index) => {
        const table =
          person.tableNumber ? ` — Tavolo ${person.tableNumber}` : "";

        return `${index + 1}. **${person.characterName}**${table}`;
      })
      .join("\n") || "*Nessuna candidatura al momento.*";

  const statusText =
    shot.status === "aperta"
      ? "✅ Iscrizioni aperte"
      : shot.status === "selezione"
        ? "🔒 Iscrizioni chiuse"
        : "📚 Shot conclusa";

  const embed = new EmbedBuilder()
    .setColor(0x9f7ac4)
    .setTitle(`📜 ${shot.title}`)
    .setDescription(
      [
        `**Stato:** ${statusText}`,
        `**Data:** ${shot.scheduledDate} — ${shot.timeSlot === "sera" ? "Sera" : "Pomeriggio"}`,
        `**Grado:** ${shot.grade}`,
        `**Posti:** ${shot.slotsPerTable} per tavolo · ${shot.tableCount} tavolo/i`,
        `**Obiettivo:** ${shot.synopsis}`,
        "",
        "**Iscritti**",
        names
      ].join("\n")
    )
    .setFooter({
      text:
        shot.status === "aperta"
          ? "Usa /shot iscriviti per candidare un personaggio."
          : "Gilda custodisce questa pagina con molto affetto."
    });

  await message.edit({ embeds: [embed] });
}

async function updateQueue() {
  if (!MASTER_QUEUE_CHANNEL_ID) return;

  try {
    const channel = await client.channels
      .fetch(MASTER_QUEUE_CHANNEL_ID)
      .catch(() => null);

    if (!channel?.isTextBased()) return;

    const players = await db.all(`
      SELECT p.id, MAX(w.playedAt) AS lastPlayed
      FROM players p
      LEFT JOIN wm_participation w ON w.playerId = p.id
      GROUP BY p.id
      ORDER BY
        CASE WHEN MAX(w.playedAt) IS NULL THEN 0 ELSE 1 END,
        MAX(w.playedAt)
    `);

    const text =
      players
        .map((player, index) => {
          const wait = player.lastPlayed
            ? `${daysSince(player.lastPlayed)} giorni dall'ultima shot`
            : "nessuna partecipazione registrata";

          return `${index + 1}. <@${player.id}> — ${wait}`;
        })
        .join("\n")
        .slice(0, 3900) || "Nessun player registrato.";

    const embed = new EmbedBuilder()
      .setColor(0x9f7ac4)
      .setTitle("📜 Coda delle Imprese")
      .setDescription(
        `${text}\n\n*“Nessuno è stato dimenticato; alcuni sono stati semplicemente rimandati dal destino.”*`
      )
      .setTimestamp();

    const messages = await channel.messages.fetch({ limit: 30 }).catch(() => null);
    if (!messages) return;

    const old = messages.find(
      message =>
        message.author.id === client.user.id &&
        message.embeds[0]?.title === "📜 Coda delle Imprese"
    );

    if (old) await old.edit({ embeds: [embed] });
    else await channel.send({ embeds: [embed] });
  } catch (error) {
    console.error("Impossibile aggiornare la coda:", error.message);
  }
}

async function queueMaterial(shot, rawMaterial, quantity, rawRecipients) {
  const material = await db.get(
    `SELECT material, name FROM shot_materials
     WHERE lower(material) = lower(?) OR lower(name) = lower(?)`,
    rawMaterial,
    rawMaterial
  );

  if (!material) {
    throw new Error(
      "materiale non trovato. Crealo prima con /materiale_shot di Grumni."
    );
  }

  const participants = await getParticipants(shot.id);

  if (!participants.length) {
    throw new Error(
      "prima imposta titolari o subentrati: i materiali vanno ai partecipanti effettivi."
    );
  }

  let recipients = participants;

  if (rawRecipients.trim().toLowerCase() !== "tutti") {
    const names = rawRecipients
      .split(",")
      .map(name => name.trim().toLowerCase())
      .filter(Boolean);

    recipients = participants.filter(person =>
      names.includes(person.characterName.toLowerCase())
    );

    if (recipients.length !== names.length) {
      throw new Error("uno o più destinatari non sono partecipanti effettivi.");
    }
  }

  for (const recipient of recipients) {
    await db.run(
      `INSERT INTO wm_shot_rewards
       (shotId, characterId, rewardType, rewardName, quantity, applied, createdAt)
       VALUES (?, ?, 'materiale_shot', ?, ?, 0, ?)`,
      shot.id,
      recipient.characterId,
      material.material,
      quantity,
      now()
    );
  }

  return { material: material.name || material.material, recipients };
}

async function applyMaterials(shotId) {
  const rewards = await db.all(
    `SELECT * FROM wm_shot_rewards
     WHERE shotId = ? AND applied = 0`,
    shotId
  );

  for (const reward of rewards) {
    await db.run(
      `INSERT INTO materials_inventory (characterId, material, quantity)
       VALUES (?, ?, ?)
       ON CONFLICT(characterId, material)
       DO UPDATE SET quantity = quantity + excluded.quantity`,
      reward.characterId,
      reward.rewardName,
      reward.quantity
    );

    await db.run(
      "UPDATE wm_shot_rewards SET applied = 1 WHERE id = ?",
      reward.id
    );
  }
}

async function grantMasterCredit(masterId) {
  let progress = await db.get(
    "SELECT * FROM wm_master_progress WHERE masterId = ?",
    masterId
  );

  if (!progress) return;

  const queue = JSON.parse(progress.characterQueue || "[]");
  if (!queue.length) return;

  await db.run(
    `UPDATE wm_master_progress
     SET masteredShots = masteredShots + 1
     WHERE masterId = ?`,
    masterId
  );

  progress = await db.get(
    "SELECT * FROM wm_master_progress WHERE masterId = ?",
    masterId
  );

  const shotNumber = Number(progress.masteredShots);
  const interval = masterInterval(queue.length);

  if (shotNumber !== 1 && (shotNumber - 1) % interval !== 0) return;

  await db.run(
    `UPDATE wm_master_progress
     SET pendingRewards = pendingRewards + 1
     WHERE masterId = ?`,
    masterId
  );

  const master = await client.users.fetch(masterId).catch(() => null);

  await master?.send(
    [
      "🎖️ **Gilda — Ricompensa Master disponibile**",
      "Hai raggiunto una nuova soglia di shot masterate.",
      "Usa `/shot premio_master` per riscattarla o rinunciare al turno.",
      "Ho preparato persino un nastrino. Metaforico, ma molto carino."
    ].join("\n")
  ).catch(() => null);
}

async function archiveShot(shot, outcome, summary, staffNote, participants) {
  if (!MASTER_LOG_CHANNEL_ID) return;

  const channel = await client.channels
    .fetch(MASTER_LOG_CHANNEL_ID)
    .catch(() => null);

  if (!channel?.isTextBased()) return;

  await channel.send({
    embeds: [
      new EmbedBuilder()
        .setColor(0x9f7ac4)
        .setTitle(`⚔️ ${shot.title}`)
        .addFields(
          {
            name: "Data",
            value: `${shot.scheduledDate} — ${
              shot.timeSlot === "sera" ? "Sera" : "Pomeriggio"
            }`,
            inline: true
          },
          {
            name: "Master",
            value: `<@${shot.masterId}>`,
            inline: true
          },
          {
            name: "Obiettivo",
            value: shot.synopsis,
            inline: false
          },
          {
            name: "Partecipanti",
            value: participants.map(person => person.characterName).join(", "),
            inline: false
          },
          {
            name: "Esito shot",
            value: outcome,
            inline: false
          },
          {
            name: "Resoconto Master",
            value: summary,
            inline: false
          },
          {
            name: "Nota staff / seguito",
            value: staffNote || "Nessuna nota aggiuntiva.",
            inline: false
          }
        )
        .setTimestamp()
    ]
  });
}

async function closeShot(shot, gold, outcome, summary, staffNote) {
  const participants = await getParticipants(shot.id);

  if (!participants.length) {
    throw new Error("non risultano titolari o subentrati.");
  }

  await db.exec("BEGIN TRANSACTION");

  try {
    for (const participant of participants) {
      await db.run(
        `UPDATE characters
         SET xp = xp + ?, gold = gold + ?
         WHERE id = ?`,
        shot.xpReward,
        gold,
        participant.characterId
      );

      await db.run(
        `INSERT INTO wm_participation
         (playerId, characterId, shotId, playedAt)
         VALUES (?, ?, ?, ?)`,
        participant.playerId,
        participant.characterId,
        shot.id,
        now()
      );
    }

    await applyMaterials(shot.id);

    await db.run(
      `UPDATE wm_shots
       SET status = 'conclusa', closedAt = ?
       WHERE id = ?`,
      now(),
      shot.id
    );

    await db.run(
      `INSERT INTO wm_shot_logs
       (shotId, masterId, outcome, summary, staffNote, createdAt)
       VALUES (?, ?, ?, ?, ?, ?)`,
      shot.id,
      shot.masterId,
      outcome,
      summary,
      staffNote,
      now()
    );

    await db.exec("COMMIT");
  } catch (error) {
    await db.exec("ROLLBACK");
    throw error;
  }

  await grantMasterCredit(shot.masterId);
  await updateQueue();
  await archiveShot(shot, outcome, summary, staffNote, participants);

  return participants;
}

async function hasScheduleConflict(shot, playerId) {
  return db.get(
    `SELECT other.title, other.scheduledDate, other.timeSlot
     FROM wm_shots other
     JOIN wm_shot_people person ON person.shotId = other.id
     WHERE person.playerId = ?
       AND person.status IN ('titolare', 'subentrato')
       AND other.id != ?
       AND other.scheduledDate = ?
       AND other.timeSlot = ?
       AND other.status != 'conclusa'
     LIMIT 1`,
    playerId,
    shot.id,
    shot.scheduledDate,
    shot.timeSlot
  );
}

async function recommend(shot) {
  const people = await db.all(
    `SELECT person.*, character.level, MAX(play.playedAt) AS lastPlayed
     FROM wm_shot_people person
     JOIN characters character ON character.id = person.characterId
     LEFT JOIN wm_participation play ON play.playerId = person.playerId
     WHERE person.shotId = ? AND person.status = 'iscritto'
     GROUP BY person.id`,
    shot.id
  );

  return people
    .map(person => {
      const grade = gradeFromLevel(person.level);
      const distance = gradeDistance(grade, shot.grade);
      const wait = daysSince(person.lastPlayed);
      const hook = person.narrativeHook.trim().length > 0;
      const longWait = wait === null || wait >= 21;

      let priority = 99;
      let reason = "grado non compatibile";

      if (hook) {
        priority = 1;
        reason = "spunto narrativo dichiarato";
      } else if (longWait && distance === 0) {
        priority = 2;
        reason = "oltre tre settimane e grado previsto";
      } else if (longWait && distance === 1) {
        priority = 3;
        reason = "oltre tre settimane e grado quasi adeguato";
      } else if (distance === 0) {
        priority = 4;
        reason = "grado previsto";
      } else if (distance === 1) {
        priority = 5;
        reason = "grado quasi adeguato";
      } else if (distance === 2) {
        priority = 6;
        reason = "grado compatibile per completamento";
      }

      return { ...person, grade, wait, priority, reason };
    })
    .sort((a, b) => {
      if (a.priority !== b.priority) return a.priority - b.priority;
      return (b.wait ?? 99999) - (a.wait ?? 99999);
    });
}

client.on("interactionCreate", async interaction => {
  try {
    if (interaction.isButton()) {
      if (interaction.customId.startsWith("gilda_close:")) {
        if (!isMaster(interaction)) {
          return fail(interaction, "solo un Master può chiudere una cronaca.");
        }

        const shotId = interaction.customId.split(":")[1];

        return interaction.reply({
          content: "📜 Come desideri concludere questa shot?",
          ephemeral: true,
          components: [
            new ActionRowBuilder().addComponents(
              new ButtonBuilder()
                .setCustomId(`gilda_mode:${shotId}:delete`)
                .setLabel("Chiudi e archivia")
                .setStyle(ButtonStyle.Danger),
              new ButtonBuilder()
                .setCustomId(`gilda_mode:${shotId}:keep`)
                .setLabel("Chiudi ma conserva per PBC")
                .setStyle(ButtonStyle.Primary)
            )
          ]
        });
      }

      if (interaction.customId.startsWith("gilda_mode:")) {
        if (!isMaster(interaction)) return fail(interaction, "operazione riservata ai Master.");

        const [, , shotId, mode] = interaction.customId.split(":");

        const modal = new ModalBuilder()
          .setCustomId(`gilda_finish:${shotId}:${mode}`)
          .setTitle("Gilda — Chiusura shot");

        const gold = new TextInputBuilder()
          .setCustomId("gold")
          .setLabel("Monete per partecipante")
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setValue("0");

        const outcome = new TextInputBuilder()
          .setCustomId("outcome")
          .setLabel("Esito shot")
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setValue("Successo");

        const summary = new TextInputBuilder()
          .setCustomId("summary")
          .setLabel("Resoconto Master")
          .setStyle(TextInputStyle.Paragraph)
          .setRequired(true)
          .setMaxLength(1000);

        const staffNote = new TextInputBuilder()
          .setCustomId("staffNote")
          .setLabel("Nota staff / seguito")
          .setStyle(TextInputStyle.Paragraph)
          .setRequired(false)
          .setMaxLength(1000);

        modal.addComponents(
          new ActionRowBuilder().addComponents(gold),
          new ActionRowBuilder().addComponents(outcome),
          new ActionRowBuilder().addComponents(summary),
          new ActionRowBuilder().addComponents(staffNote)
        );

        return interaction.showModal(modal);
      }
    }

    if (interaction.isModalSubmit()) {
      if (!interaction.customId.startsWith("gilda_finish:")) return;

      const [, shotId, mode] = interaction.customId.split(":");
      const shot = await db.get("SELECT * FROM wm_shots WHERE id = ?", shotId);

      if (!shot || shot.status === "conclusa") {
        return fail(interaction, "questa shot risulta già chiusa.");
      }

      const participants = await closeShot(
        shot,
        Math.max(0, Number(interaction.fields.getTextInputValue("gold")) || 0),
        interaction.fields.getTextInputValue("outcome").trim(),
        interaction.fields.getTextInputValue("summary").trim(),
        interaction.fields.getTextInputValue("staffNote").trim()
      );

      await updateSignupBoard({ ...shot, status: "conclusa" });

      await interaction.reply({
        content: [
          `✅ **${BOT_NAME}:** ${pick(LINES.finished)}`,
          `Premi assegnati a: ${participants.map(person => person.characterName).join(", ")}.`,
          mode === "keep"
            ? "Il thread resta aperto per la PBC."
            : "Il thread verrà archiviato tra pochi secondi."
        ].join("\n"),
        ephemeral: true
      });

      if (mode === "delete") {
        setTimeout(async () => {
          const thread = await client.channels.fetch(shot.threadId).catch(() => null);
          await thread?.delete("Shot archiviata da Gilda").catch(error => {
            console.error("Impossibile eliminare il thread:", error.message);
          });
        }, 5000);
      }

      return;
    }

    if (!interaction.isChatInputCommand() || interaction.commandName !== "shot") {
      return;
    }

    const sub = interaction.options.getSubcommand();
    const shot = await getShot(interaction.channelId);

    const masterCommands = [
      "apri",
      "chiudi_iscrizioni",
      "riapri_iscrizioni",
      "partecipante",
      "rimuovi",
      "consiglia",
      "stato",
      "materiale",
      "registro",
      "importa_attesa",
      "importa_master"
    ];

    if (masterCommands.includes(sub) && !isMaster(interaction)) {
      return fail(interaction, "questa pagina è riservata ai Master.");
    }

    if (sub === "apri") {
      if (!interaction.channel?.isThread()) {
        return fail(interaction, "apri la shot nel thread della missiva.");
      }

      if (shot) return fail(interaction, "questo thread ospita già una shot.");

      const date = interaction.options.getString("data");

      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        return fail(interaction, "la data deve usare il formato YYYY-MM-DD.");
      }

      const result = await db.run(
        `INSERT INTO wm_shots
         (threadId, title, grade, slotsPerTable, tableCount, xpReward,
          scheduledDate, timeSlot, synopsis, masterId, openedAt)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        interaction.channelId,
        interaction.channel.name,
        interaction.options.getString("grado"),
        interaction.options.getInteger("posti"),
        interaction.options.getInteger("tavoli") || 1,
        interaction.options.getInteger("xp"),
        date,
        interaction.options.getString("fascia"),
        interaction.options.getString("sinossi"),
        interaction.user.id,
        now()
      );

      const created = await db.get("SELECT * FROM wm_shots WHERE id = ?", result.lastID);

      const message = await interaction.reply({
        content: `📜 **${BOT_NAME}:** ${pick(LINES.opened)}`,
        fetchReply: true
      });

      await db.run(
        "UPDATE wm_shots SET signupMessageId = ? WHERE id = ?",
        message.id,
        created.id
      );

      created.signupMessageId = message.id;

      await updateSignupBoard(created);

      await message.edit({
        components: [
          new ActionRowBuilder().addComponents(
            new ButtonBuilder()
              .setCustomId(`gilda_close:${created.id}`)
              .setLabel("Chiudi shot")
              .setStyle(ButtonStyle.Danger)
          )
        ]
      });

      return;
    }

    if (!shot) {
      return fail(interaction, "non trovo una shot registrata in questo thread.");
    }

    if (sub === "iscriviti") {
      if (shot.status !== "aperta") {
        return fail(interaction, "le iscrizioni non sono aperte.");
      }

      const character = await db.get(
        `SELECT * FROM characters
         WHERE playerId = ? AND lower(name) = lower(?)`,
        interaction.user.id,
        interaction.options.getString("pg")
      );

      if (!character) return fail(interaction, "non trovo questo PG tra le tue schede.");

      const grade = gradeFromLevel(character.level);

      if (gradeDistance(grade, shot.grade) > 2) {
        return fail(
          interaction,
          `${character.name} è di grado ${grade}, troppo distante dal grado ${shot.grade} della shot.`
        );
      }

      await db.run(
        `INSERT INTO wm_shot_people
         (shotId, characterId, playerId, characterName, narrativeHook, createdAt)
         VALUES (?, ?, ?, ?, ?, ?)`,
        shot.id,
        character.id,
        interaction.user.id,
        character.name,
        interaction.options.getString("spunto") || "",
        now()
      );

      await updateSignupBoard(shot);

      return interaction.reply({
        content: `📜 **${BOT_NAME}:** ${pick(LINES.signed)}`,
        ephemeral: true
      });
    }

    if (sub === "ritirati") {
      await db.run(
        `UPDATE wm_shot_people
         SET status = 'ritirato', note = 'Ritiro volontario'
         WHERE shotId = ? AND playerId = ? AND lower(characterName) = lower(?)`,
        shot.id,
        interaction.user.id,
        interaction.options.getString("pg")
      );

      await updateSignupBoard(shot);

      return interaction.reply({
        content: "📜 Ho ritirato il tuo nome dalla missiva. Le prossime imprese ti aspettano!",
        ephemeral: true
      });
    }

    if (sub === "chiudi_iscrizioni" || sub === "riapri_iscrizioni") {
      const status = sub === "chiudi_iscrizioni" ? "selezione" : "aperta";

      await db.run(
        "UPDATE wm_shots SET status = ? WHERE id = ?",
        status,
        shot.id
      );

      shot.status = status;
      await updateSignupBoard(shot);

      return interaction.reply({
        content:
          sub === "chiudi_iscrizioni"
            ? `📜 ${pick(LINES.closed)}`
            : "📜 Iscrizioni riaperte! Nuovi protagonisti possono ancora candidarsi.",
        ephemeral: true
      });
    }

    if (sub === "partecipante") {
      const person = await db.get(
        `SELECT * FROM wm_shot_people
         WHERE shotId = ? AND lower(characterName) = lower(?)`,
        shot.id,
        interaction.options.getString("pg")
      );

      if (!person) return fail(interaction, "questo PG non è iscritto.");

      const status = interaction.options.getString("stato");
      const table = interaction.options.getInteger("tavolo");
      const force = interaction.options.getBoolean("forza") || false;
      const overrideReason = interaction.options.getString("motivo_override") || "";

      if (table && table > shot.tableCount) {
        return fail(interaction, `questa shot ha soltanto ${shot.tableCount} tavolo/i.`);
      }

      if (["titolare", "subentrato"].includes(status)) {
        const conflict = await hasScheduleConflict(shot, person.playerId);

        if (conflict && !force) {
          return fail(
            interaction,
            `questo player è già titolare nella shot **${conflict.title}**, programmata il ${conflict.scheduledDate} ${
              conflict.timeSlot === "sera" ? "di sera" : "di pomeriggio"
            }.`
          );
        }

        if (conflict && force && !overrideReason.trim()) {
          return fail(
            interaction,
            "per forzare un conflitto devi inserire motivo_override."
          );
        }
      }

      await db.run(
        `UPDATE wm_shot_people
         SET status = ?,
             tableNumber = COALESCE(?, tableNumber),
             note = CASE WHEN ? != '' THEN ? ELSE note END
         WHERE id = ?`,
        status,
        table,
        overrideReason,
        overrideReason,
        person.id
      );

      return interaction.reply({
        content: `📜 ${person.characterName} aggiornato correttamente.`,
        ephemeral: true
      });
    }

    if (sub === "rimuovi") {
      await db.run(
        `UPDATE wm_shot_people
         SET status = 'rimosso', note = ?
         WHERE shotId = ? AND lower(characterName) = lower(?)`,
        interaction.options.getString("motivo") || "",
        shot.id,
        interaction.options.getString("pg")
      );

      await updateSignupBoard(shot);

      return interaction.reply({
        content: "📜 Iscrizione rimossa e nota staff salvata.",
        ephemeral: true
      });
    }

    if (sub === "materiale") {
      const result = await queueMaterial(
        shot,
        interaction.options.getString("nome"),
        interaction.options.getInteger("quantita"),
        interaction.options.getString("destinatari")
      );

      return interaction.reply({
        content: `📦 **${result.material}** accodato per ${result.recipients
          .map(person => person.characterName)
          .join(", ")}.`,
        ephemeral: true
      });
    }

    if (sub === "consiglia") {
      const people = await recommend(shot);
      const seats = shot.slotsPerTable * shot.tableCount;

      const text =
        people
          .map((person, index) => {
            const role = index < seats ? "Titolare suggerito" : "Riserva suggerita";
            const wait = person.wait === null ? "mai registrato" : `${person.wait} giorni`;

            return `**${index + 1}. ${person.characterName}** — ${role}\nGrado ${person.grade}; attesa ${wait}; ${person.reason}.`;
          })
          .join("\n\n") || "Nessun candidato disponibile.";

      return interaction.reply({
        embeds: [
          new EmbedBuilder()
            .setColor(0x9f7ac4)
            .setTitle("📜 Proposta di Gilda")
            .setDescription(text.slice(0, 4000))
            .setFooter({
              text: "Il Master mantiene sempre l'ultima decisione."
            })
        ],
        ephemeral: true
      });
    }

    if (sub === "stato") {
      const people = await db.all(
        `SELECT * FROM wm_shot_people
         WHERE shotId = ?
         ORDER BY tableNumber, characterName`,
        shot.id
      );

      return interaction.reply({
        content:
          people
            .map(
              person =>
                `• **${person.characterName}** — ${person.status}${
                  person.tableNumber ? ` — Tavolo ${person.tableNumber}` : ""
                }`
            )
            .join("\n") || "Nessuna iscrizione.",
        ephemeral: true
      });
    }

    if (sub === "registro") {
      const master = interaction.options.getUser("master");
      const from = interaction.options.getString("da");
      const to = interaction.options.getString("a");

      const filters = [];
      const values = [];

      if (master) {
        filters.push("log.masterId = ?");
        values.push(master.id);
      }

      if (from) {
        filters.push("shot.scheduledDate >= ?");
        values.push(from);
      }

      if (to) {
        filters.push("shot.scheduledDate <= ?");
        values.push(to);
      }

      const where = filters.length ? `WHERE ${filters.join(" AND ")}` : "";

      const logs = await db.all(
        `SELECT log.*, shot.title, shot.scheduledDate, shot.timeSlot
         FROM wm_shot_logs log
         JOIN wm_shots shot ON shot.id = log.shotId
         ${where}
         ORDER BY shot.scheduledDate DESC
         LIMIT 20`,
        ...values
      );

      return interaction.reply({
        content:
          logs
            .map(
              log =>
                `• **${log.scheduledDate} — ${log.title}** · <@${log.masterId}> · ${log.outcome}`
            )
            .join("\n") || "📜 Nessuna shot trovata.",
        ephemeral: true
      });
    }

    if (sub === "importa_attesa") {
      const date = interaction.options.getString("data");

      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        return fail(interaction, "usa una data nel formato YYYY-MM-DD.");
      }

      await db.run(
        `INSERT INTO wm_participation
         (playerId, characterId, shotId, playedAt)
         VALUES (?, NULL, NULL, ?)`,
        interaction.options.getUser("player").id,
        `${date}T12:00:00.000Z`
      );

      await updateQueue();

      return interaction.reply({
        content: "📜 Attesa importata e coda aggiornata.",
        ephemeral: true
      });
    }

    if (sub === "importa_master") {
      const queue = interaction.options
        .getString("ordine_pg")
        .split(",")
        .map(name => name.trim())
        .filter(Boolean);

      await db.run(
        `INSERT INTO wm_master_progress
         (masterId, masteredShots, characterQueue, pendingRewards)
         VALUES (?, ?, ?, 0)
         ON CONFLICT(masterId)
         DO UPDATE SET
           masteredShots = excluded.masteredShots,
           characterQueue = excluded.characterQueue,
           pendingRewards = 0`,
        interaction.options.getUser("master").id,
        interaction.options.getInteger("shot_masterate"),
        JSON.stringify(queue)
      );

      return interaction.reply({
        content: "📜 Progressione Master importata.",
        ephemeral: true
      });
    }

    if (sub === "progressione_master") {
      const master = interaction.options.getUser("master") || interaction.user;

      const progress = await db.get(
        "SELECT * FROM wm_master_progress WHERE masterId = ?",
        master.id
      );

      if (!progress) return fail(interaction, "nessuna progressione registrata.");

      const queue = JSON.parse(progress.characterQueue || "[]");

      return interaction.reply({
        content: [
          `🎖️ **Progressione di ${master.username}**`,
          `Shot masterate: ${progress.masteredShots}`,
          `Rotazione: ${queue.join(" → ")}`,
          `Premi pendenti: ${progress.pendingRewards}`
        ].join("\n"),
        ephemeral: true
      });
    }

    if (sub === "premio_master") {
      const progress = await db.get(
        "SELECT * FROM wm_master_progress WHERE masterId = ?",
        interaction.user.id
      );

      if (!progress || Number(progress.pendingRewards) < 1) {
        return fail(interaction, "non hai premi master pendenti.");
      }

      const queue = JSON.parse(progress.characterQueue || "[]");
      const due = queue[0];
      const action = interaction.options.getString("azione");

      if (action === "rinuncia") {
        queue.push(queue.shift());

        await db.run(
          `UPDATE wm_master_progress
           SET characterQueue = ?, pendingRewards = pendingRewards - 1
           WHERE masterId = ?`,
          JSON.stringify(queue),
          interaction.user.id
        );

        await db.run(
          `INSERT INTO wm_master_reward_log
           (masterId, shotNumber, characterName, status, createdAt)
           VALUES (?, ?, ?, 'rinunciata', ?)`,
          interaction.user.id,
          progress.masteredShots,
          due,
          now()
        );

        return interaction.reply({
          content: `📜 Turno di ${due} rinunciato. La rotazione avanza con molta dignità.`,
          ephemeral: true
        });
      }

      const selected = interaction.options.getString("pg");

      if (!selected || selected.toLowerCase() !== due.toLowerCase()) {
        return fail(interaction, `in questo turno può ricevere la ricompensa soltanto ${due}.`);
      }

      const character = await db.get(
        `SELECT * FROM characters
         WHERE playerId = ? AND lower(name) = lower(?)`,
        interaction.user.id,
        selected
      );

      if (!character) return fail(interaction, "PG non trovato.");

      const reward = MASTER_REWARDS[gradeFromLevel(character.level)];

      await db.exec("BEGIN TRANSACTION");

      try {
        await db.run(
          "UPDATE characters SET xp = xp + ?, gold = gold + ? WHERE id = ?",
          reward.xp,
          reward.gold,
          character.id
        );

        queue.push(queue.shift());

        await db.run(
          `UPDATE wm_master_progress
           SET characterQueue = ?, pendingRewards = pendingRewards - 1
           WHERE masterId = ?`,
          JSON.stringify(queue),
          interaction.user.id
        );

        await db.run(
          `INSERT INTO wm_master_reward_log
           (masterId, shotNumber, characterId, characterName, status, createdAt)
           VALUES (?, ?, ?, ?, 'riscossa', ?)`,
          interaction.user.id,
          progress.masteredShots,
          character.id,
          character.name,
          now()
        );

        await db.exec("COMMIT");
      } catch (error) {
        await db.exec("ROLLBACK");
        throw error;
      }

      return interaction.reply({
        content: `🎖️ ${character.name} riceve ${reward.xp} XP e ${reward.gold} mo. Ho scritto tutto con un sacco di cuoricini professionali.`,
        ephemeral: true
      });
    }
  } catch (error) {
    console.error(error);
    return fail(interaction, `ho trovato un problema negli archivi: ${error.message}`);
  }
});

await initDatabase();

client.once("ready", async () => {
  console.log(`${BOT_NAME} è online come ${client.user.tag}.`);

  client.user.setActivity("a rendere epiche le imprese | /shot", {
    type: 0
  });

  await updateQueue();
});

client.login(TOKEN);
