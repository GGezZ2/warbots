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

const GM_ROLE_NAME = "gm-bot";
const BOT_NAME = "Gasterion";

if (!TOKEN) {
  console.error("Manca SHOT_TOKEN nelle variabili Railway.");
  process.exit(1);
}

const client = new Client({
  intents: [GatewayIntentBits.Guilds]
});

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
    "La missiva è stata affissa. Chi desidera affrontare l'ignoto può ora iscriversi.",
    "Gasterion apre le iscrizioni. Il fato prende nota; raramente per gentilezza.",
    "Le cronache attendono nuovi nomi. Cercate di non farvi ricordare soltanto per la causa della morte."
  ],
  signed: [
    "Candidatura registrata. La gloria è stata avvisata, ma non ha ancora risposto.",
    "Il tuo nome entra negli archivi. È un inizio migliore della maggior parte delle leggende.",
    "Registrato. Che gli dei vi osservino con interesse, o almeno da lontano."
  ],
  closed: [
    "Le iscrizioni sono chiuse. Le pagine della cronaca passano ora nelle mani del Master.",
    "La missiva non accetta più nomi. Il destino, per il momento, ha abbastanza volontari.",
    "Gasterion chiude l'elenco. L'eroismo, come le locande migliori, spesso richiede pazienza."
  ],
  party: [
    "La compagnia è formata. Che la vostra storia meriti di essere trascritta.",
    "I nomi sono stati scelti. Ora resta soltanto la piccola formalità di sopravvivere.",
    "Il party è pronto. Le cronache preferiscono finali gloriosi, ma si adattano."
  ],
  finished: [
    "L'impresa è stata consegnata agli archivi. I sopravvissuti ricevono quanto dovuto.",
    "La pagina è chiusa, non necessariamente la storia.",
    "Gasterion certifica l'impresa. Il mondo ricorderà ciò che è accaduto; gli archivi, almeno, sì."
  ]
};

function pick(lines) {
  return lines[Math.floor(Math.random() * lines.length)];
}

function now() {
  return new Date().toISOString();
}

function daysSince(date) {
  if (!date) return null;

  const milliseconds = Date.now() - new Date(date).getTime();
  return Math.max(0, Math.floor(milliseconds / 86_400_000));
}

function gradeFromLevel(level) {
  const numericLevel = Number(level || 1);

  if (numericLevel <= 2) return "C";
  if (numericLevel <= 4) return "C+";
  if (numericLevel <= 6) return "B";
  if (numericLevel <= 8) return "B+";
  if (numericLevel <= 10) return "A";
  if (numericLevel <= 12) return "A+";
  if (numericLevel <= 14) return "S";
  if (numericLevel <= 16) return "S+";

  return "Z";
}

function gradeDistance(first, second) {
  return Math.abs(GRADES.indexOf(first) - GRADES.indexOf(second));
}

function isGradeCompatible(characterGrade, shotGrade) {
  return gradeDistance(characterGrade, shotGrade) <= 2;
}

function masterRewardInterval(characterCount) {
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

async function replyError(interaction, message) {
  const payload = {
    content: `📜 **Gasterion:** ${message}`,
    ephemeral: true
  };

  if (interaction.deferred || interaction.replied) {
    return interaction.followUp(payload);
  }

  return interaction.reply(payload);
}

let db;

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

  console.log(`${BOT_NAME} collegato al database: ${DB_PATH}`);
}

async function getShot(channelId) {
  return db.get(
    `
      SELECT *
      FROM wm_shots
      WHERE threadId = ?
    `,
    channelId
  );
}

async function getCharacterByName(playerId, name) {
  return db.get(
    `
      SELECT *
      FROM characters
      WHERE playerId = ?
      AND lower(name) = lower(?)
    `,
    playerId,
    name
  );
}

async function getShotPerson(shotId, characterName) {
  return db.get(
    `
      SELECT *
      FROM wm_shot_people
      WHERE shotId = ?
      AND lower(characterName) = lower(?)
    `,
    shotId,
    characterName
  );
}

async function getEffectiveParticipants(shotId) {
  return db.all(
    `
      SELECT *
      FROM wm_shot_people
      WHERE shotId = ?
      AND status IN ('titolare', 'subentrato')
      ORDER BY tableNumber ASC, characterName ASC
    `,
    shotId
  );
}

async function ensureQueueMessage() {
  if (!MASTER_QUEUE_CHANNEL_ID) return;

  const channel = await client.channels
    .fetch(MASTER_QUEUE_CHANNEL_ID)
    .catch(() => null);

  if (!channel?.isTextBased()) return;

  const players = await db.all(`
    SELECT
      p.id AS playerId,
      p.name AS playerName,
      MAX(wp.playedAt) AS lastPlayedAt
    FROM players p
    LEFT JOIN wm_participation wp ON wp.playerId = p.id
    GROUP BY p.id, p.name
    ORDER BY
      CASE WHEN MAX(wp.playedAt) IS NULL THEN 0 ELSE 1 END ASC,
      MAX(wp.playedAt) ASC
  `);

  const lines = players.map((player, index) => {
    const wait =
      player.lastPlayedAt === null
        ? "nessuna partecipazione registrata"
        : `${daysSince(player.lastPlayedAt)} giorni dall'ultima shot`;

    return `${index + 1}. <@${player.playerId}> — ${wait}`;
  });

  const description =
    lines.join("\n").slice(0, 3900) ||
    "Nessun giocatore è ancora registrato nelle cronache.";

  const embed = new EmbedBuilder()
    .setColor(0x4d6b87)
    .setTitle("📜 Coda delle Imprese")
    .setDescription(
      `${description}\n\n*“Nessuno è stato dimenticato; alcuni sono stati semplicemente rimandati dal destino.”*`
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

async function addMasterCredit(masterId) {
  let progress = await db.get(
    `
      SELECT *
      FROM wm_master_progress
      WHERE masterId = ?
    `,
    masterId
  );

  if (!progress) return;

  const queue = JSON.parse(progress.characterQueue || "[]");

  if (queue.length === 0) return;

  await db.run(
    `
      UPDATE wm_master_progress
      SET masteredShots = masteredShots + 1
      WHERE masterId = ?
    `,
    masterId
  );

  progress = await db.get(
    `
      SELECT *
      FROM wm_master_progress
      WHERE masterId = ?
    `,
    masterId
  );

  const count = Number(progress.masteredShots);
  const interval = masterRewardInterval(queue.length);

  const rewardDue = count === 1 || (count - 1) % interval === 0;

  if (!rewardDue) return;

  await db.run(
    `
      UPDATE wm_master_progress
      SET pendingRewards = pendingRewards + 1
      WHERE masterId = ?
    `,
    masterId
  );

  const master = await client.users.fetch(masterId).catch(() => null);

  if (master) {
    await master
      .send(
        [
          "🎖️ **Gasterion — Ricompensa Master disponibile**",
          "Hai raggiunto una nuova soglia di shot masterate.",
          "Usa `/shot premio_master` per riscattare la ricompensa o rinunciare al turno.",
          "La gloria è avara; per questo conviene registrarla."
        ].join("\n")
      )
      .catch(() => null);
  }
}

async function publishShotLog(shot, outcome, summary, consequences, participants) {
  if (!MASTER_LOG_CHANNEL_ID) return;

  const channel = await client.channels
    .fetch(MASTER_LOG_CHANNEL_ID)
    .catch(() => null);

  if (!channel?.isTextBased()) return;

  const threadUrl = `https://discord.com/channels/${channel.guild.id}/${shot.threadId}`;

  const embed = new EmbedBuilder()
    .setColor(0x526d82)
    .setTitle(`⚔️ ${shot.title}`)
    .setURL(threadUrl)
    .addFields(
      {
        name: "Master",
        value: `<@${shot.masterId}>`,
        inline: true
      },
      {
        name: "Esito",
        value: outcome || "Non specificato",
        inline: true
      },
      {
        name: "Partecipanti effettivi",
        value:
          participants.map(person => person.characterName).join(", ") ||
          "Nessuno",
        inline: false
      },
      {
        name: "Resoconto",
        value: summary || "Nessun resoconto inserito.",
        inline: false
      },
      {
        name: "Conseguenze",
        value: consequences || "Nessuna conseguenza registrata.",
        inline: false
      }
    )
    .setTimestamp();

  await channel.send({ embeds: [embed] });
}

async function applyPendingShotMaterials(shotId) {
  const rewards = await db.all(
    `
      SELECT *
      FROM wm_shot_rewards
      WHERE shotId = ?
      AND rewardType = 'materiale_shot'
      AND applied = 0
    `,
    shotId
  );

  for (const reward of rewards) {
    await db.run(
      `
        INSERT INTO materials_inventory (characterId, material, quantity)
        VALUES (?, ?, ?)
        ON CONFLICT(characterId, material)
        DO UPDATE SET quantity = quantity + excluded.quantity
      `,
      reward.characterId,
      reward.rewardName,
      reward.quantity
    );

    await db.run(
      `
        UPDATE wm_shot_rewards
        SET applied = 1
        WHERE id = ?
      `,
      reward.id
    );
  }
}

async function closeShot({
  interaction,
  shot,
  goldReward,
  outcome,
  summary,
  consequences
}) {
  const participants = await getEffectiveParticipants(shot.id);

  if (participants.length === 0) {
    throw new Error(
      "Non risultano titolari o subentrati. Imposta prima i partecipanti effettivi con /shot partecipante."
    );
  }

  await db.exec("BEGIN TRANSACTION");

  try {
    for (const participant of participants) {
      await db.run(
        `
          UPDATE characters
          SET xp = xp + ?, gold = gold + ?
          WHERE id = ?
        `,
        shot.xpReward,
        goldReward,
        participant.characterId
      );

      await db.run(
        `
          INSERT INTO wm_participation
          (playerId, characterId, shotId, playedAt)
          VALUES (?, ?, ?, ?)
        `,
        participant.playerId,
        participant.characterId,
        shot.id,
        now()
      );
    }

    await applyPendingShotMaterials(shot.id);

    await db.run(
      `
        UPDATE wm_shots
        SET status = 'conclusa', closedAt = ?
        WHERE id = ?
      `,
      now(),
      shot.id
    );

    await db.run(
      `
        INSERT INTO wm_shot_logs
        (shotId, masterId, outcome, summary, consequences, createdAt)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(shotId)
        DO UPDATE SET
          outcome = excluded.outcome,
          summary = excluded.summary,
          consequences = excluded.consequences,
          createdAt = excluded.createdAt
      `,
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

  await addMasterCredit(shot.masterId);
  await ensureQueueMessage();
  await publishShotLog(shot, outcome, summary, consequences, participants);

  return participants;
}

async function queueShotMaterial(shot, materialName, quantity, rawRecipients) {
  const material = await db.get(
    `
      SELECT material, name
      FROM shot_materials
      WHERE lower(material) = lower(?)
      OR lower(name) = lower(?)
    `,
    materialName,
    materialName
  );

  if (!material) {
    throw new Error(
      "Questo materiale non esiste nel catalogo shot_materials. Crealo prima con /materiale_shot di Grumni."
    );
  }

  const participants = await getEffectiveParticipants(shot.id);

  if (participants.length === 0) {
    throw new Error(
      "Prima imposta titolari o subentrati: i materiali vengono assegnati solo ai partecipanti effettivi."
    );
  }

  const targetText = rawRecipients.trim().toLowerCase();

  let recipients = participants;

  if (targetText !== "tutti") {
    const requestedNames = rawRecipients
      .split(",")
      .map(name => name.trim().toLowerCase())
      .filter(Boolean);

    recipients = participants.filter(participant =>
      requestedNames.includes(participant.characterName.toLowerCase())
    );

    if (recipients.length !== requestedNames.length) {
      throw new Error(
        "Uno o più destinatari non sono titolari/subentrati di questa shot."
      );
    }
  }

  for (const recipient of recipients) {
    await db.run(
      `
        INSERT INTO wm_shot_rewards
        (shotId, characterId, rewardType, rewardName, quantity, applied, createdAt)
        VALUES (?, ?, 'materiale_shot', ?, ?, 0, ?)
      `,
      shot.id,
      recipient.characterId,
      material.material,
      quantity,
      now()
    );
  }

  return {
    displayName: material.name || material.material,
    recipients
  };
}

async function suggestParty(shot) {
  const applicants = await db.all(
    `
      SELECT
        person.*,
        character.level,
        MAX(participation.playedAt) AS lastPlayedAt
      FROM wm_shot_people person
      JOIN characters character ON character.id = person.characterId
      LEFT JOIN wm_participation participation
        ON participation.playerId = person.playerId
      WHERE person.shotId = ?
      AND person.status = 'iscritto'
      GROUP BY person.id
    `,
    shot.id
  );

  const suggestions = applicants.map(applicant => {
    const grade = gradeFromLevel(applicant.level);
    const distance = gradeDistance(grade, shot.grade);
    const wait = daysSince(applicant.lastPlayedAt);
    const hasHook = applicant.narrativeHook.trim().length > 0;
    const waitedThreeWeeks = wait === null || wait >= 21;

    let priorityGroup = 99;
    let reason = "";

    if (hasHook) {
      priorityGroup = 1;
      reason = "spunto narrativo dichiarato";
    } else if (waitedThreeWeeks && distance === 0) {
      priorityGroup = 2;
      reason = "oltre tre settimane + grado previsto";
    } else if (waitedThreeWeeks && distance === 1) {
      priorityGroup = 3;
      reason = "oltre tre settimane + grado quasi adeguato";
    } else if (distance === 0) {
      priorityGroup = 4;
      reason = "grado previsto";
    } else if (distance === 1) {
      priorityGroup = 5;
      reason = "grado quasi adeguato";
    } else if (distance === 2) {
      priorityGroup = 6;
      reason = "grado compatibile per completamento";
    } else {
      reason = "non compatibile";
    }

    return {
      ...applicant,
      grade,
      wait,
      distance,
      priorityGroup,
      reason
    };
  });

  suggestions.sort((first, second) => {
    if (first.priorityGroup !== second.priorityGroup) {
      return first.priorityGroup - second.priorityGroup;
    }

    const firstWait = first.wait === null ? 99999 : first.wait;
    const secondWait = second.wait === null ? 99999 : second.wait;

    return secondWait - firstWait;
  });

  return suggestions;
}

client.on("interactionCreate", async interaction => {
  try {
    if (interaction.isButton()) {
      if (!interaction.customId.startsWith("gasterion_close:")) return;

      if (!isMaster(interaction)) {
        return replyError(
          interaction,
          "solo chi custodisce le cronache può chiudere un'impresa."
        );
      }

      const shotId = Number(interaction.customId.split(":")[1]);

      const modal = new ModalBuilder()
        .setCustomId(`gasterion_finish:${shotId}`)
        .setTitle("Gasterion — Chiusura shot");

      const gold = new TextInputBuilder()
        .setCustomId("gold")
        .setLabel("Monete per ogni partecipante")
        .setStyle(TextInputStyle.Short)
        .setRequired(true)
        .setValue("0");

      const outcome = new TextInputBuilder()
        .setCustomId("outcome")
        .setLabel("Esito (successo, parziale, fallimento...)")
        .setStyle(TextInputStyle.Short)
        .setRequired(true)
        .setValue("Successo");

      const summary = new TextInputBuilder()
        .setCustomId("summary")
        .setLabel("Riassunto staff della shot")
        .setStyle(TextInputStyle.Paragraph)
        .setRequired(true)
        .setMaxLength(1000);

      const consequences = new TextInputBuilder()
        .setCustomId("consequences")
        .setLabel("Conseguenze o agganci futuri")
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
      if (!interaction.customId.startsWith("gasterion_finish:")) return;

      if (!isMaster(interaction)) {
        return replyError(interaction, "non possiedi l'autorità necessaria.");
      }

      const shotId = Number(interaction.customId.split(":")[1]);

      const shot = await db.get(
        `
          SELECT *
          FROM wm_shots
          WHERE id = ?
        `,
        shotId
      );

      if (!shot || shot.status === "conclusa") {
        return replyError(
          interaction,
          "questa shot non è disponibile per una nuova chiusura."
        );
      }

      const goldReward = Math.max(
        0,
        Number(interaction.fields.getTextInputValue("gold")) || 0
      );

      const outcome = interaction.fields.getTextInputValue("outcome").trim();
      const summary = interaction.fields.getTextInputValue("summary").trim();
      const consequences = interaction.fields
        .getTextInputValue("consequences")
        .trim();

      const participants = await closeShot({
        interaction,
        shot,
        goldReward,
        outcome,
        summary,
        consequences
      });

      return interaction.reply({
        content: [
          `✅ **${BOT_NAME}:** ${pick(LINES.finished)}`,
          `Partecipanti premiati: ${participants
            .map(person => person.characterName)
            .join(", ")}.`,
          `Ogni partecipante ha ricevuto ${shot.xpReward} XP e ${goldReward} mo.`,
          "I materiali custom già accodati con `/shot materiale` sono stati assegnati."
        ].join("\n"),
        ephemeral: true
      });
    }

    if (!interaction.isChatInputCommand()) return;
    if (interaction.commandName !== "shot") return;

    const subcommand = interaction.options.getSubcommand();
    const currentShot = await getShot(interaction.channelId);

    const masterOnly = [
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

    if (masterOnly.includes(subcommand) && !isMaster(interaction)) {
      return replyError(
        interaction,
        "questo capitolo è riservato ai Master e ai custodi degli archivi."
      );
    }

    if (subcommand === "apri") {
      if (!interaction.channel?.isThread()) {
        return replyError(
          interaction,
          "le iscrizioni vanno aperte nel thread della missiva, non nel canale principale."
        );
      }

      if (currentShot) {
        return replyError(
          interaction,
          "questo thread ospita già una shot registrata."
        );
      }

      const grade = interaction.options.getString("grado");
      const slots = interaction.options.getInteger("posti");
      const xp = interaction.options.getInteger("xp");
      const tables = interaction.options.getInteger("tavoli") || 1;

      const result = await db.run(
        `
          INSERT INTO wm_shots
          (threadId, title, grade, slotsPerTable, tableCount, xpReward, status, masterId, openedAt)
          VALUES (?, ?, ?, ?, ?, ?, 'aperta', ?, ?)
        `,
        interaction.channelId,
        interaction.channel.name,
        grade,
        slots,
        tables,
        xp,
        interaction.user.id,
        now()
      );

      const embed = new EmbedBuilder()
        .setColor(0x4d6b87)
        .setTitle(`📜 ${interaction.channel.name}`)
        .setDescription(pick(LINES.opened))
        .addFields(
          {
            name: "Grado previsto",
            value: grade,
            inline: true
          },
          {
            name: "Posti",
            value: `${slots} per tavolo`,
            inline: true
          },
          {
            name: "Tavoli",
            value: String(tables),
            inline: true
          },
          {
            name: "Esperienza",
            value: `${xp} XP per partecipante effettivo`,
            inline: false
          }
        )
        .setFooter({
          text: "Usa /shot iscriviti per candidare un tuo personaggio."
        });

      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`gasterion_close:${result.lastID}`)
          .setLabel("Chiudi shot")
          .setStyle(ButtonStyle.Danger)
      );

      return interaction.reply({
        embeds: [embed],
        components: [row]
      });
    }

    if (!currentShot) {
      return replyError(
        interaction,
        "Gasterion non trova una shot registrata in questo thread."
      );
    }

    if (subcommand === "iscriviti") {
      if (currentShot.status !== "aperta") {
        return replyError(
          interaction,
          "le iscrizioni non sono attualmente aperte."
        );
      }

      const characterName = interaction.options.getString("pg");
      const narrativeHook = interaction.options.getString("spunto") || "";

      const character = await getCharacterByName(
        interaction.user.id,
        characterName
      );

      if (!character) {
        return replyError(
          interaction,
          "non trovo questo PG tra i tuoi personaggi registrati."
        );
      }

      const characterGrade = gradeFromLevel(character.level);

      if (!isGradeCompatible(characterGrade, currentShot.grade)) {
        return replyError(
          interaction,
          `${character.name} è di grado ${characterGrade}, non compatibile con questa shot di grado ${currentShot.grade}.`
        );
      }

      const alreadySigned = await db.get(
        `
          SELECT *
          FROM wm_shot_people
          WHERE shotId = ?
          AND characterId = ?
        `,
        currentShot.id,
        character.id
      );

      if (alreadySigned) {
        return replyError(
          interaction,
          "questo personaggio compare già negli archivi della shot."
        );
      }

      await db.run(
        `
          INSERT INTO wm_shot_people
          (shotId, characterId, playerId, characterName, narrativeHook, createdAt)
          VALUES (?, ?, ?, ?, ?, ?)
        `,
        currentShot.id,
        character.id,
        interaction.user.id,
        character.name,
        narrativeHook,
        now()
      );

      return interaction.reply({
        content: `📜 **${BOT_NAME}:** ${pick(LINES.signed)}\n**${character.name}** è iscritt${character.name.endsWith("a") ? "a" : "o"} alla shot.`,
        ephemeral: true
      });
    }

    if (subcommand === "ritirati") {
      if (currentShot.status !== "aperta") {
        return replyError(
          interaction,
          "le iscrizioni sono chiuse: chiedi a un Master di aggiornare la tua posizione."
        );
      }

      const characterName = interaction.options.getString("pg");

      const candidate = await db.get(
        `
          SELECT *
          FROM wm_shot_people
          WHERE shotId = ?
          AND playerId = ?
          AND lower(characterName) = lower(?)
        `,
        currentShot.id,
        interaction.user.id,
        characterName
      );

      if (!candidate) {
        return replyError(
          interaction,
          "non trovo una tua iscrizione con questo personaggio."
        );
      }

      await db.run(
        `
          UPDATE wm_shot_people
          SET status = 'ritirato',
              note = 'Ritiro volontario del player'
          WHERE id = ?
        `,
        candidate.id
      );

      return interaction.reply({
        content:
          "📜 Gasterion ha ritirato il tuo nome dalla missiva. L'archivio non giudica; prende soltanto nota.",
        ephemeral: true
      });
    }

    if (subcommand === "chiudi_iscrizioni") {
      await db.run(
        `
          UPDATE wm_shots
          SET status = 'selezione'
          WHERE id = ?
        `,
        currentShot.id
      );

      return interaction.reply(`📜 **${BOT_NAME}:** ${pick(LINES.closed)}`);
    }

    if (subcommand === "riapri_iscrizioni") {
      await db.run(
        `
          UPDATE wm_shots
          SET status = 'aperta'
          WHERE id = ?
        `,
        currentShot.id
      );

      return interaction.reply(
        "📜 Gasterion riapre la missiva. Il destino ha nuovamente bisogno di volontari."
      );
    }

    if (subcommand === "partecipante") {
      const characterName = interaction.options.getString("pg");
      const status = interaction.options.getString("stato");
      const tableNumber = interaction.options.getInteger("tavolo");

      const person = await getShotPerson(currentShot.id, characterName);

      if (!person) {
        return replyError(
          interaction,
          "questo personaggio non risulta iscritto alla shot."
        );
      }

      if (
        tableNumber &&
        (tableNumber < 1 || tableNumber > currentShot.tableCount)
      ) {
        return replyError(
          interaction,
          `questa shot possiede soltanto ${currentShot.tableCount} tavolo/i.`
        );
      }

      await db.run(
        `
          UPDATE wm_shot_people
          SET status = ?,
              tableNumber = COALESCE(?, tableNumber)
          WHERE id = ?
        `,
        status,
        tableNumber,
        person.id
      );

      return interaction.reply(
        `📜 **${person.characterName}** è ora segnato come **${status}**${
          tableNumber ? ` nel tavolo ${tableNumber}` : ""
        }.`
      );
    }

    if (subcommand === "rimuovi") {
      const characterName = interaction.options.getString("pg");
      const reason = interaction.options.getString("motivo") || "";

      const person = await getShotPerson(currentShot.id, characterName);

      if (!person) {
        return replyError(
          interaction,
          "questo personaggio non compare negli archivi della shot."
        );
      }

      await db.run(
        `
          UPDATE wm_shot_people
          SET status = 'rimosso',
              note = ?
          WHERE id = ?
        `,
        reason,
        person.id
      );

      return interaction.reply(
        `📜 ${person.characterName} è stato rimosso dalla shot. L'archivio conserva la nota dello staff.`
      );
    }

    if (subcommand === "materiale") {
      if (currentShot.status === "conclusa") {
        return replyError(
          interaction,
          "la shot è già chiusa. Per una correzione usa i comandi staff di Grumni, così resta tutto tracciato."
        );
      }

      const result = await queueShotMaterial(
        currentShot,
        interaction.options.getString("nome"),
        interaction.options.getInteger("quantita"),
        interaction.options.getString("destinatari")
      );

      return interaction.reply({
        content: [
          `📦 **${BOT_NAME}:** materiale registrato per la chiusura della shot.`,
          `**${result.displayName}** ×${interaction.options.getInteger("quantita")}`,
          `Destinatari: ${result.recipients
            .map(recipient => recipient.characterName)
            .join(", ")}.`,
          "Verrà accreditato assieme alle altre ricompense quando chiuderai la shot."
        ].join("\n"),
        ephemeral: true
      });
    }

    if (subcommand === "consiglia") {
      const suggestions = await suggestParty(currentShot);
      const totalSlots =
        currentShot.slotsPerTable * currentShot.tableCount;

      const lines = suggestions.map((suggestion, index) => {
        const wait =
          suggestion.wait === null
            ? "mai registrato"
            : `${suggestion.wait} giorni`;

        const role =
          index < totalSlots ? "Titolare suggerito" : "Riserva suggerita";

        return [
          `**${index + 1}. ${suggestion.characterName}** — ${role}`,
          `Grado ${suggestion.grade}; attesa ${wait}; ${suggestion.reason}.`
        ].join("\n");
      });

      const embed = new EmbedBuilder()
        .setColor(0x4d6b87)
        .setTitle("📜 Proposta di Gasterion")
        .setDescription(
          lines.join("\n\n").slice(0, 4000) ||
            "Nessun candidato disponibile."
        )
        .setFooter({
          text: "È una proposta: il Master mantiene sempre la decisione finale, soprattutto per composizione e trama."
        });

      return interaction.reply({
        embeds: [embed],
        ephemeral: true
      });
    }

    if (subcommand === "stato") {
      const people = await db.all(
        `
          SELECT *
          FROM wm_shot_people
          WHERE shotId = ?
          ORDER BY
            CASE status
              WHEN 'titolare' THEN 1
              WHEN 'subentrato' THEN 2
              WHEN 'riserva' THEN 3
              ELSE 4
            END,
            tableNumber ASC,
            characterName ASC
        `,
        currentShot.id
      );

      const rows = people.map(person => {
        const table = person.tableNumber
          ? ` — Tavolo ${person.tableNumber}`
          : "";

        return `• **${person.characterName}** — ${person.status}${table}`;
      });

      const embed = new EmbedBuilder()
        .setColor(0x4d6b87)
        .setTitle(`📜 Stato shot — ${currentShot.title}`)
        .setDescription(
          rows.join("\n") || "Nessun nome è stato ancora trascritto."
        )
        .addFields(
          {
            name: "Grado",
            value: currentShot.grade,
            inline: true
          },
          {
            name: "Tavoli",
            value: String(currentShot.tableCount),
            inline: true
          },
          {
            name: "Stato",
            value: currentShot.status,
            inline: true
          }
        );

      return interaction.reply({
        embeds: [embed],
        ephemeral: true
      });
    }

    if (subcommand === "registro") {
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
        filters.push("log.createdAt >= ?");
        values.push(`${from}T00:00:00.000Z`);
      }

      if (to) {
        filters.push("log.createdAt <= ?");
        values.push(`${to}T23:59:59.999Z`);
      }

      const where =
        filters.length > 0 ? `WHERE ${filters.join(" AND ")}` : "";

      const logs = await db.all(
        `
          SELECT
            log.*,
            shot.title,
            shot.threadId
          FROM wm_shot_logs log
          JOIN wm_shots shot ON shot.id = log.shotId
          ${where}
          ORDER BY log.createdAt DESC
          LIMIT 20
        `,
        ...values
      );

      const entries = logs.map(log => {
        const date = log.createdAt.slice(0, 10);
        const link = `https://discord.com/channels/${interaction.guildId}/${log.threadId}`;

        return `• **${date} — ${log.title}** — <@${log.masterId}>\n${link}`;
      });

      return interaction.reply({
        content:
          entries.join("\n\n") ||
          "📜 Gasterion non trova cronache che corrispondano a questa ricerca.",
        ephemeral: true
      });
    }

    if (subcommand === "importa_attesa") {
      const player = interaction.options.getUser("player");
      const date = interaction.options.getString("data");

      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        return replyError(interaction, "la data deve usare il formato YYYY-MM-DD.");
      }

      await db.run(
        `
          INSERT INTO wm_participation
          (playerId, characterId, shotId, playedAt)
          VALUES (?, NULL, NULL, ?)
        `,
        player.id,
        `${date}T12:00:00.000Z`
      );

      await ensureQueueMessage();

      return interaction.reply(
        `📜 Ultima partecipazione di <@${player.id}> impostata al ${date}.`
      );
    }

    if (subcommand === "importa_master") {
      const master = interaction.options.getUser("master");
      const masteredShots = interaction.options.getInteger("shot_masterate");

      const queue = interaction.options
        .getString("ordine_pg")
        .split(",")
        .map(name => name.trim())
        .filter(Boolean);

      if (queue.length < 1 || queue.length > 3) {
        return replyError(
          interaction,
          "la rotazione deve contenere da uno a tre personaggi."
        );
      }

      await db.run(
        `
          INSERT INTO wm_master_progress
          (masterId, masteredShots, characterQueue, pendingRewards)
          VALUES (?, ?, ?, 0)
          ON CONFLICT(masterId)
          DO UPDATE SET
            masteredShots = excluded.masteredShots,
            characterQueue = excluded.characterQueue,
            pendingRewards = 0
        `,
        master.id,
        masteredShots,
        JSON.stringify(queue)
      );

      return interaction.reply(
        `📜 Progressione di <@${master.id}> importata: ${masteredShots} shot masterate; rotazione ${queue.join(
          " → "
        )}.`
      );
    }

    if (subcommand === "progressione_master") {
      const master = interaction.options.getUser("master") || interaction.user;

      const progress = await db.get(
        `
          SELECT *
          FROM wm_master_progress
          WHERE masterId = ?
        `,
        master.id
      );

      if (!progress) {
        return replyError(
          interaction,
          "non esiste una progressione importata per questo master."
        );
      }

      const queue = JSON.parse(progress.characterQueue || "[]");
      const interval = masterRewardInterval(queue.length);
      const nextThreshold =
        Number(progress.masteredShots) === 0
          ? 1
          : Math.ceil(
              (Number(progress.masteredShots) + 1) / interval
            ) *
              interval +
            1;

      return interaction.reply({
        content: [
          `🎖️ **Progressione Master — ${master.username}**`,
          `Shot conteggiate: **${progress.masteredShots}**`,
          `Rotazione: **${queue.join(" → ")}**`,
          `Cadenza attuale: una ricompensa ogni **${interval}** shot.`,
          `Premi pendenti: **${progress.pendingRewards}**`,
          `Prossima soglia indicativa: **${nextThreshold}ª shot**.`
        ].join("\n"),
        ephemeral: true
      });
    }

    if (subcommand === "premio_master") {
      const progress = await db.get(
        `
          SELECT *
          FROM wm_master_progress
          WHERE masterId = ?
        `,
        interaction.user.id
      );

      if (!progress || Number(progress.pendingRewards) < 1) {
        return replyError(
          interaction,
          "non hai ricompense master pendenti."
        );
      }

      const action = interaction.options.getString("azione");
      const queue = JSON.parse(progress.characterQueue || "[]");
      const nextCharacterName = queue[0];

      if (!nextCharacterName) {
        return replyError(
          interaction,
          "la tua rotazione non contiene personaggi. Reimportala con /shot importa_master."
        );
      }

      if (action === "rinuncia") {
        queue.push(queue.shift());

        await db.run(
          `
            UPDATE wm_master_progress
            SET characterQueue = ?,
                pendingRewards = pendingRewards - 1
            WHERE masterId = ?
          `,
          JSON.stringify(queue),
          interaction.user.id
        );

        await db.run(
          `
            INSERT INTO wm_master_reward_log
            (masterId, shotNumber, characterName, status, createdAt)
            VALUES (?, ?, ?, 'rinunciata', ?)
          `,
          interaction.user.id,
          progress.masteredShots,
          nextCharacterName,
          now()
        );

        return interaction.reply({
          content: `📜 Turno di **${nextCharacterName}** rinunciato. Gasterion fa avanzare la rotazione senza giudicare. Troppo apertamente, almeno.`,
          ephemeral: true
        });
      }

      const selectedName = interaction.options.getString("pg");

      if (!selectedName) {
        return replyError(
          interaction,
          `per riscattare devi indicare il PG. Il turno attuale appartiene a **${nextCharacterName}**.`
        );
      }

      if (selectedName.toLowerCase() !== nextCharacterName.toLowerCase()) {
        return replyError(
          interaction,
          `questa ricompensa spetta a **${nextCharacterName}** secondo la rotazione.`
        );
      }

      const character = await getCharacterByName(
        interaction.user.id,
        selectedName
      );

      if (!character) {
        return replyError(
          interaction,
          "non trovo questo PG tra i tuoi personaggi registrati."
        );
      }

      const grade = gradeFromLevel(character.level);
      const reward = MASTER_REWARDS[grade];

      await db.exec("BEGIN TRANSACTION");

      try {
        await db.run(
          `
            UPDATE characters
            SET xp = xp + ?, gold = gold + ?
            WHERE id = ?
          `,
          reward.xp,
          reward.gold,
          character.id
        );

        queue.push(queue.shift());

        await db.run(
          `
            UPDATE wm_master_progress
            SET characterQueue = ?,
                pendingRewards = pendingRewards - 1
            WHERE masterId = ?
          `,
          JSON.stringify(queue),
          interaction.user.id
        );

        await db.run(
          `
            INSERT INTO wm_master_reward_log
            (masterId, shotNumber, characterId, characterName, status, createdAt)
            VALUES (?, ?, ?, ?, 'riscossa', ?)
          `,
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
        content: [
          "🎖️ **Ricompensa Master riscossa**",
          `**${character.name}** riceve una ricompensa equivalente a una shot di grado **${grade}**:`,
          `**${reward.xp} XP** e **${reward.gold} mo**.`,
          "Gasterion aggiorna la cronaca. La gloria, stavolta, ha firmato."
        ].join("\n"),
        ephemeral: true
      });
    }
  } catch (error) {
    console.error(error);

    return replyError(
      interaction,
      `un errore ha macchiato le cronache: ${error.message}`
    );
  }
});

await initDatabase();

client.once("ready", async () => {
  console.log(`${BOT_NAME} è online come ${client.user.tag}.`);

  client.user.setActivity("a custodire le imprese | /shot", {
    type: 0
  });

  await ensureQueueMessage();
});

client.login(TOKEN);
