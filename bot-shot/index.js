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
  console.error("Manca SHOT_TOKEN nelle variabili Railway.");
  process.exit(1);
}

const client = new Client({
  intents: [GatewayIntentBits.Guilds]
});

let db;

function pick(lines) {
  return lines[Math.floor(Math.random() * lines.length)];
}

function now() {
  return new Date().toISOString();
}

function daysSince(date) {
  if (!date) return null;
  return Math.max(0, Math.floor((Date.now() - new Date(date).getTime()) / 86400000));
}

function gradeFromLevel(level) {
  const value = Number(level || 1);

  if (value <= 2) return "C";
  if (value <= 4) return "C+";
  if (value <= 6) return "B";
  if (value <= 8) return "B+";
  if (value <= 10) return "A";
  if (value <= 12) return "A+";
  if (value <= 14) return "S";
  if (value <= 16) return "S+";

  return "Z";
}

function gradeDistance(first, second) {
  return Math.abs(GRADES.indexOf(first) - GRADES.indexOf(second));
}

function isCompatible(characterGrade, shotGrade) {
  return gradeDistance(characterGrade, shotGrade) <= 2;
}

function masterInterval(characterCount) {
  if (characterCount >= 3) return 2;
  if (characterCount === 2) return 3;
  return 5;
}

function isMaster(interaction) {
  if (
    interaction.memberPermissions?.has(
      PermissionsBitField.Flags.Administrator
    )
  ) {
    return true;
  }

  return interaction.member?.roles?.cache?.some(
    role => role.name === GM_ROLE_NAME
  );
}

async function fail(interaction, message) {
  const payload = {
    content: `📜 **${BOT_NAME}:** ${message}`,
    ephemeral: true
  };

  if (interaction.replied || interaction.deferred) {
    return interaction.followUp(payload);
  }

  return interaction.reply(payload);
}

async function initDatabase() {
  db = await open({
    filename: DB_PATH,
    driver: sqlite3.Database
  });

  await db.exec(`
    CREATE TABLE IF NOT EXISTS wm_shots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      threadId TEXT NOT NULL UNIQUE,
      title TEXT NOT NULL,
      grade TEXT NOT NULL,
      slotsPerTable INTEGER NOT NULL,
      tableCount INTEGER NOT NULL DEFAULT 1,
      xpReward INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'aperta',
      masterId TEXT NOT NULL,
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
      consequences TEXT NOT NULL DEFAULT '',
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

  console.log(`${BOT_NAME} collegata a: ${DB_PATH}`);
}

async function getShot(threadId) {
  return db.get("SELECT * FROM wm_shots WHERE threadId = ?", threadId);
}

async function getPerson(shotId, name) {
  return db.get(
    `SELECT * FROM wm_shot_people
     WHERE shotId = ? AND lower(characterName) = lower(?)`,
    shotId,
    name
  );
}

async function getParticipants(shotId) {
  return db.all(
    `SELECT * FROM wm_shot_people
     WHERE shotId = ? AND status IN ('titolare', 'subentrato')
     ORDER BY tableNumber, characterName`,
    shotId
  );
}

async function updateQueue() {
  if (!MASTER_QUEUE_CHANNEL_ID) return;

  const channel = await client.channels
    .fetch(MASTER_QUEUE_CHANNEL_ID)
    .catch(() => null);

  if (!channel?.isTextBased()) return;

  const players = await db.all(`
    SELECT p.id, p.name, MAX(w.playedAt) AS lastPlayed
    FROM players p
    LEFT JOIN wm_participation w ON w.playerId = p.id
    GROUP BY p.id, p.name
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

  const messages = await channel.messages.fetch({ limit: 30 });
  const oldMessage = messages.find(
    message =>
      message.author.id === client.user.id &&
      message.embeds[0]?.title === "📜 Coda delle Imprese"
  );

  if (oldMessage) {
    await oldMessage.edit({ embeds: [embed] });
  } else {
    await channel.send({ embeds: [embed] });
  }
}

async function grantMasterCredit(masterId) {
  let progress = await db.get(
    "SELECT * FROM wm_master_progress WHERE masterId = ?",
    masterId
  );

  if (!progress) return;

  const queue = JSON.parse(progress.characterQueue || "[]");

  if (queue.length === 0) return;

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

  await master
    ?.send(
      [
        "🎖️ **Gilda — Ricompensa Master disponibile**",
        "Hai raggiunto una nuova soglia di shot masterate.",
        "Usa `/shot premio_master` per riscattarla o rinunciare al turno.",
        "Ho preparato persino un nastrino. Metaforico, ma molto carino."
      ].join("\n")
    )
    .catch(() => null);
}

async function queueMaterial(shot, rawMaterial, quantity, rawRecipients) {
  const material = await db.get(
    `SELECT material, name
     FROM shot_materials
     WHERE lower(material) = lower(?) OR lower(name) = lower(?)`,
    rawMaterial,
    rawMaterial
  );

  if (!material) {
    throw new Error(
      "materiale non trovato in shot_materials. Crealo prima con /materiale_shot di Grumni."
    );
  }

  const participants = await getParticipants(shot.id);

  if (participants.length === 0) {
    throw new Error(
      "prima imposta titolari o subentrati: i materiali vanno solo ai partecipanti effettivi."
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
      throw new Error(
        "uno o più destinatari non sono titolari o subentrati di questa shot."
      );
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

  return {
    material: material.name || material.material,
    recipients
  };
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

async function closeShot(shot, gold, outcome, summary, consequences) {
  const participants = await getParticipants(shot.id);

  if (participants.length === 0) {
    throw new Error(
      "non risultano titolari o subentrati. Impostali prima di chiudere."
    );
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
       (shotId, masterId, outcome, summary, consequences, createdAt)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(shotId)
       DO UPDATE SET
         outcome = excluded.outcome,
         summary = excluded.summary,
         consequences = excluded.consequences,
         createdAt = excluded.createdAt`,
      shot.id,
      shot.masterId,
      outcome,
      summary,
      consequences,
      now()
    );

    await db.exec("COMMIT");
  } catch (error) {
    await db.exec("ROLLBACK");
    throw error;
  }

  await grantMasterCredit(shot.masterId);
  await updateQueue();

  if (MASTER_LOG_CHANNEL_ID) {
    const channel = await client.channels
      .fetch(MASTER_LOG_CHANNEL_ID)
      .catch(() => null);

    if (channel?.isTextBased()) {
      const link = `https://discord.com/channels/${channel.guild.id}/${shot.threadId}`;

      await channel.send({
        embeds: [
          new EmbedBuilder()
            .setColor(0x9f7ac4)
            .setTitle(`⚔️ ${shot.title}`)
            .setURL(link)
            .addFields(
              {
                name: "Master",
                value: `<@${shot.masterId}>`,
                inline: true
              },
              {
                name: "Esito",
                value: outcome,
                inline: true
              },
              {
                name: "Partecipanti",
                value: participants.map(p => p.characterName).join(", "),
                inline: false
              },
              {
                name: "Resoconto",
                value: summary,
                inline: false
              },
              {
                name: "Conseguenze",
                value: consequences || "Nessuna conseguenza registrata.",
                inline: false
              }
            )
            .setTimestamp()
        ]
      });
    }
  }

  return participants;
}

async function recommend(shot) {
  const applicants = await db.all(
    `SELECT person.*, character.level, MAX(play.playedAt) AS lastPlayed
     FROM wm_shot_people person
     JOIN characters character ON character.id = person.characterId
     LEFT JOIN wm_participation play ON play.playerId = person.playerId
     WHERE person.shotId = ? AND person.status = 'iscritto'
     GROUP BY person.id`,
    shot.id
  );

  return applicants
    .map(person => {
      const grade = gradeFromLevel(person.level);
      const distance = gradeDistance(grade, shot.grade);
      const wait = daysSince(person.lastPlayed);
      const hook = person.narrativeHook.trim().length > 0;
      const waitedLong = wait === null || wait >= 21;

      let priority = 99;
      let reason = "grado non compatibile";

      if (hook) {
        priority = 1;
        reason = "spunto narrativo dichiarato";
      } else if (waitedLong && distance === 0) {
        priority = 2;
        reason = "oltre tre settimane e grado previsto";
      } else if (waitedLong && distance === 1) {
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
      if (!interaction.customId.startsWith("gilda_close:")) return;

      if (!isMaster(interaction)) {
        return fail(
          interaction,
          "solo un Master può chiudere una cronaca. Io sono gentile, ma le regole sono regole."
        );
      }

      const shotId = Number(interaction.customId.split(":")[1]);

      const modal = new ModalBuilder()
        .setCustomId(`gilda_finish:${shotId}`)
        .setTitle("Gilda — Chiusura shot");

      const gold = new TextInputBuilder()
        .setCustomId("gold")
        .setLabel("Monete per partecipante")
        .setStyle(TextInputStyle.Short)
        .setRequired(true)
        .setValue("0");

      const outcome = new TextInputBuilder()
        .setCustomId("outcome")
        .setLabel("Esito")
        .setStyle(TextInputStyle.Short)
        .setRequired(true)
        .setValue("Successo");

      const summary = new TextInputBuilder()
        .setCustomId("summary")
        .setLabel("Riassunto staff")
        .setStyle(TextInputStyle.Paragraph)
        .setRequired(true)
        .setMaxLength(1000);

      const consequences = new TextInputBuilder()
        .setCustomId("consequences")
        .setLabel("Conseguenze o seguito")
        .setStyle(TextInputStyle.Paragraph)
        .setRequired(false)
        .setMaxLength(1000);

      modal.addComponents(
        new ActionRowBuilder().addComponents(gold),
        new ActionRowBuilder().addComponents(outcome),
        new ActionRowBuilder().addComponents(summary),
        new ActionRowBuilder().addComponents(consequences)
      );

      return interaction.showModal(modal);
    }

    if (interaction.isModalSubmit()) {
      if (!interaction.customId.startsWith("gilda_finish:")) return;

      const shotId = Number(interaction.customId.split(":")[1]);
      const shot = await db.get("SELECT * FROM wm_shots WHERE id = ?", shotId);

      if (!shot || shot.status === "conclusa") {
        return fail(interaction, "questa shot risulta già chiusa.");
      }

      const participants = await closeShot(
        shot,
        Math.max(0, Number(interaction.fields.getTextInputValue("gold")) || 0),
        interaction.fields.getTextInputValue("outcome").trim(),
        interaction.fields.getTextInputValue("summary").trim(),
        interaction.fields.getTextInputValue("consequences").trim()
      );

      return interaction.reply({
        content: [
          `✅ **${BOT_NAME}:** ${pick(LINES.finished)}`,
          `Premi assegnati a: ${participants
            .map(person => person.characterName)
            .join(", ")}.`,
          "Coda, registro e progressione master sono stati aggiornati."
        ].join("\n"),
        ephemeral: true
      });
    }

    if (!interaction.isChatInputCommand()) return;
    if (interaction.commandName !== "shot") return;

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
      return fail(
        interaction,
        "questa pagina è riservata ai Master. Posso farti vedere i margini, però."
      );
    }

    if (sub === "apri") {
      if (!interaction.channel?.isThread()) {
        return fail(
          interaction,
          "apri la shot direttamente nel thread della missiva, così le cronache restano ordinate."
        );
      }

      if (shot) return fail(interaction, "questo thread ospita già una shot.");

      const result = await db.run(
        `INSERT INTO wm_shots
         (threadId, title, grade, slotsPerTable, tableCount, xpReward, masterId, openedAt)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        interaction.channelId,
        interaction.channel.name,
        interaction.options.getString("grado"),
        interaction.options.getInteger("posti"),
        interaction.options.getInteger("tavoli") || 1,
        interaction.options.getInteger("xp"),
        interaction.user.id,
        now()
      );

      const created = await db.get(
        "SELECT * FROM wm_shots WHERE id = ?",
        result.lastID
      );

      return interaction.reply({
        embeds: [
          new EmbedBuilder()
            .setColor(0x9f7ac4)
            .setTitle(`📜 ${created.title}`)
            .setDescription(pick(LINES.opened))
            .addFields(
              { name: "Grado", value: created.grade, inline: true },
              {
                name: "Posti",
                value: `${created.slotsPerTable} per tavolo`,
                inline: true
              },
              {
                name: "Tavoli",
                value: String(created.tableCount),
                inline: true
              },
              {
                name: "Ricompensa XP",
                value: `${created.xpReward} XP per partecipante effettivo`
              }
            )
        ],
        components: [
          new ActionRowBuilder().addComponents(
            new ButtonBuilder()
              .setCustomId(`gilda_close:${created.id}`)
              .setLabel("Chiudi shot")
              .setStyle(ButtonStyle.Danger)
          )
        ]
      });
    }

    if (!shot) {
      return fail(
        interaction,
        "non trovo una shot registrata in questo thread."
      );
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

      if (!character) {
        return fail(interaction, "non trovo questo PG tra le tue schede.");
      }

      const grade = gradeFromLevel(character.level);

      if (!isCompatible(grade, shot.grade)) {
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

      return interaction.reply({
        content: "📜 Nome ritirato dalla missiva. Le avventure future ti aspettano!",
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

      return interaction.reply(
        sub === "chiudi_iscrizioni"
          ? `📜 **${BOT_NAME}:** ${pick(LINES.closed)}`
          : "📜 Iscrizioni riaperte! Nuovi protagonisti possono ancora entrare nella cronaca."
      );
    }

    if (sub === "partecipante") {
      const person = await getPerson(
        shot.id,
        interaction.options.getString("pg")
      );

      if (!person) return fail(interaction, "questo PG non è iscritto.");

      const table = interaction.options.getInteger("tavolo");

      if (table && table > shot.tableCount) {
        return fail(
          interaction,
          `questa shot ha soltanto ${shot.tableCount} tavolo/i.`
        );
      }

      await db.run(
        `UPDATE wm_shot_people
         SET status = ?, tableNumber = COALESCE(?, tableNumber)
         WHERE id = ?`,
        interaction.options.getString("stato"),
        table,
        person.id
      );

      return interaction.reply(
        `📜 ${person.characterName} aggiornato correttamente.`
      );
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

      return interaction.reply("📜 Iscrizione rimossa e nota staff salvata.");
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
          .join(", ")}. Lo consegnerò alla chiusura, con un fiocchetto metaforico.`,
        ephemeral: true
      });
    }

    if (sub === "consiglia") {
      const people = await recommend(shot);
      const seats = shot.slotsPerTable * shot.tableCount;

      const description =
        people
          .map((person, index) => {
            const status =
              index < seats ? "Titolare suggerito" : "Riserva suggerita";

            return `**${index + 1}. ${person.characterName}** — ${status}\nGrado ${person.grade}; attesa ${
              person.wait === null ? "mai registrato" : `${person.wait} giorni`
            }; ${person.reason}.`;
          })
          .join("\n\n") || "Nessun candidato disponibile.";

      return interaction.reply({
        embeds: [
          new EmbedBuilder()
            .setColor(0x9f7ac4)
            .setTitle("📜 Proposta di Gilda")
            .setDescription(description.slice(0, 4000))
            .setFooter({
              text: "La proposta non sostituisce il giudizio del Master su party, trama ed eccezioni."
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
        if (!/^\d{4}-\d{2}-\d{2}$/.test(from)) {
          return fail(interaction, "la data iniziale deve usare il formato YYYY-MM-DD.");
        }

        filters.push("log.createdAt >= ?");
        values.push(`${from}T00:00:00.000Z`);
      }

      if (to) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(to)) {
          return fail(interaction, "la data finale deve usare il formato YYYY-MM-DD.");
        }

        filters.push("log.createdAt <= ?");
        values.push(`${to}T23:59:59.999Z`);
      }

      const where = filters.length
        ? `WHERE ${filters.join(" AND ")}`
        : "";

      const logs = await db.all(
        `SELECT log.*, shot.title, shot.threadId
         FROM wm_shot_logs log
         JOIN wm_shots shot ON shot.id = log.shotId
         ${where}
         ORDER BY log.createdAt DESC
         LIMIT 20`,
        ...values
      );

      const entries = logs.map(log => {
        const link = `https://discord.com/channels/${interaction.guildId}/${log.threadId}`;

        return [
          `• **${log.createdAt.slice(0, 10)} — ${log.title}**`,
          `Master: <@${log.masterId}>`,
          `[Apri thread della shot](${link})`
        ].join("\n");
      });

      return interaction.reply({
        content:
          entries.join("\n\n") ||
          "📜 Non ho trovato imprese che corrispondano a questa ricerca.",
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

      return interaction.reply("📜 Attesa importata e coda aggiornata.");
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

      return interaction.reply("📜 Progressione Master importata.");
    }

    if (sub === "progressione_master") {
      const master = interaction.options.getUser("master") || interaction.user;
      const progress = await db.get(
        "SELECT * FROM wm_master_progress WHERE masterId = ?",
        master.id
      );

      if (!progress) {
        return fail(interaction, "nessuna progressione registrata.");
      }

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

      if (!progress || progress.pendingRewards < 1) {
        return fail(interaction, "non hai premi master pendenti.");
      }

      const queue = JSON.parse(progress.characterQueue || "[]");
      const due = queue[0];

      if (interaction.options.getString("azione") === "rinuncia") {
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
        return fail(
          interaction,
          `in questo turno può ricevere la ricompensa soltanto ${due}.`
        );
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
