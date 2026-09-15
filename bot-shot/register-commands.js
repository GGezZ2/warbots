import "dotenv/config";
import { REST, Routes, SlashCommandBuilder } from "discord.js";

const TOKEN = process.env.SHOT_TOKEN?.trim();
const CLIENT_ID = process.env.SHOT_CLIENT_ID?.trim();
const GUILD_ID = process.env.GUILD_ID?.trim();

if (!TOKEN || !CLIENT_ID || !GUILD_ID) {
  throw new Error(
    "Servono SHOT_TOKEN, SHOT_CLIENT_ID e GUILD_ID per registrare i comandi di Gasterion."
  );
}

const shotCommand = new SlashCommandBuilder()
  .setName("shot")
  .setDescription("Gasterion — gestione delle shot")

  .addSubcommand(subcommand =>
    subcommand
      .setName("apri")
      .setDescription("Apre le iscrizioni nel thread della missiva")
      .addStringOption(option =>
        option
          .setName("grado")
          .setDescription("Grado centrale della shot")
          .setRequired(true)
          .addChoices(
            { name: "C", value: "C" },
            { name: "C+", value: "C+" },
            { name: "B", value: "B" },
            { name: "B+", value: "B+" },
            { name: "A", value: "A" },
            { name: "A+", value: "A+" },
            { name: "S", value: "S" },
            { name: "S+", value: "S+" },
            { name: "Z", value: "Z" }
          )
      )
      .addIntegerOption(option =>
        option
          .setName("posti")
          .setDescription("Numero di posti disponibili per ciascun tavolo")
          .setRequired(true)
          .setMinValue(1)
          .setMaxValue(10)
      )
      .addIntegerOption(option =>
        option
          .setName("xp")
          .setDescription("XP previsti per ogni partecipante effettivo")
          .setRequired(true)
          .setMinValue(0)
      )
      .addIntegerOption(option =>
        option
          .setName("tavoli")
          .setDescription("Numero di tavoli della shot")
          .setRequired(false)
          .setMinValue(1)
          .setMaxValue(10)
      )
      .addStringOption(option =>
        option
          .setName("data")
          .setDescription("Data della shot nel formato YYYY-MM-DD")
          .setRequired(true)
          .setMinLength(10)
          .setMaxLength(10)
      )
      .addStringOption(option =>
        option
          .setName("fascia")
          .setDescription("Fascia oraria della shot")
          .setRequired(true)
          .addChoices(
            { name: "Pomeriggio", value: "pomeriggio" },
            { name: "Sera", value: "sera" }
          )
      )
      .addStringOption(option =>
        option
          .setName("sinossi")
          .setDescription("Breve obiettivo della shot")
          .setRequired(true)
          .setMaxLength(800)
      )
  )
  .addSubcommand(subcommand =>
    subcommand
      .setName("chiudi_iscrizioni")
      .setDescription("Chiude le iscrizioni del thread corrente")
  )

  .addSubcommand(subcommand =>
    subcommand
      .setName("riapri_iscrizioni")
      .setDescription("Riapre le iscrizioni del thread corrente")
  )

  .addSubcommand(subcommand =>
    subcommand
      .setName("iscriviti")
      .setDescription("Iscrive un tuo personaggio alla shot")
      .addStringOption(option =>
        option
          .setName("pg")
          .setDescription("Nome del tuo personaggio")
          .setRequired(true)
      )
      .addStringOption(option =>
        option
          .setName("spunto")
          .setDescription("Aggancio narrativo alla missiva, se presente")
          .setRequired(false)
          .setMaxLength(500)
      )
  )

  .addSubcommand(subcommand =>
    subcommand
      .setName("ritirati")
      .setDescription("Ritira il tuo personaggio dalla shot")
      .addStringOption(option =>
        option
          .setName("pg")
          .setDescription("Nome del tuo personaggio")
          .setRequired(true)
      )
  )

  .addSubcommand(subcommand =>
    subcommand
      .setName("partecipante")
      .setDescription("Imposta lo stato di un personaggio iscritto")
      .addStringOption(option =>
        option
          .setName("pg")
          .setDescription("Nome del personaggio")
          .setRequired(true)
      )
      .addStringOption(option =>
        option
          .setName("stato")
          .setDescription("Nuovo stato del personaggio")
          .setRequired(true)
          .addChoices(
            { name: "Titolare", value: "titolare" },
            { name: "Riserva", value: "riserva" },
            { name: "Subentrato", value: "subentrato" },
            { name: "Non selezionato", value: "non_selezionato" },
            { name: "Assente", value: "assente" }
          )
      )
      .addIntegerOption(option =>
        option
          .setName("tavolo")
          .setDescription("Numero del tavolo, per shot multitavolo")
          .setRequired(false)
          .setMinValue(1)
          .setMaxValue(10)
      )
            .addBooleanOption(option =>
        option
          .setName("forza")
          .setDescription("Ignora un conflitto con una shot simultanea")
          .setRequired(false)
      )
      .addStringOption(option =>
        option
          .setName("motivo_override")
          .setDescription("Motivo staff obbligatorio se usi forza")
          .setRequired(false)
          .setMaxLength(500)
      )
  )

  .addSubcommand(subcommand =>
    subcommand
      .setName("rimuovi")
      .setDescription("Rimuove un'iscrizione mantenendo lo storico staff")
      .addStringOption(option =>
        option
          .setName("pg")
          .setDescription("Nome del personaggio")
          .setRequired(true)
      )
      .addStringOption(option =>
        option
          .setName("motivo")
          .setDescription("Nota interna per lo staff")
          .setRequired(false)
          .setMaxLength(500)
      )
  )

  .addSubcommand(subcommand =>
    subcommand
      .setName("consiglia")
      .setDescription("Mostra la proposta di party di Gasterion")
  )

  .addSubcommand(subcommand =>
    subcommand
      .setName("stato")
      .setDescription("Mostra iscritti, titolari, riserve e tavoli")
  )

  .addSubcommand(subcommand =>
    subcommand
      .setName("materiale")
      .setDescription("Assegna un materiale custom della shot")
      .addStringOption(option =>
        option
          .setName("nome")
          .setDescription("Nome del materiale creato con /materiale_shot")
          .setRequired(true)
      )
      .addIntegerOption(option =>
        option
          .setName("quantita")
          .setDescription("Quantità assegnata a ogni destinatario")
          .setRequired(true)
          .setMinValue(1)
      )
      .addStringOption(option =>
        option
          .setName("destinatari")
          .setDescription("Tutti, oppure nomi PG separati da virgola")
          .setRequired(true)
          .setMaxLength(500)
      )
  )

  .addSubcommand(subcommand =>
    subcommand
      .setName("registro")
      .setDescription("Cerca nello storico delle shot concluse")
      .addUserOption(option =>
        option
          .setName("master")
          .setDescription("Filtra per master")
          .setRequired(false)
      )
      .addStringOption(option =>
        option
          .setName("da")
          .setDescription("Data iniziale: YYYY-MM-DD")
          .setRequired(false)
      )
      .addStringOption(option =>
        option
          .setName("a")
          .setDescription("Data finale: YYYY-MM-DD")
          .setRequired(false)
      )
  )

  .addSubcommand(subcommand =>
    subcommand
      .setName("importa_attesa")
      .setDescription("Imposta manualmente l'ultima shot giocata da un player")
      .addUserOption(option =>
        option
          .setName("player")
          .setDescription("Player da aggiornare")
          .setRequired(true)
      )
      .addStringOption(option =>
        option
          .setName("data")
          .setDescription("Data dell'ultima shot: YYYY-MM-DD")
          .setRequired(true)
      )
  )

  .addSubcommand(subcommand =>
    subcommand
      .setName("importa_master")
      .setDescription("Importa la progressione premi di un master")
      .addUserOption(option =>
        option
          .setName("master")
          .setDescription("Master da aggiornare")
          .setRequired(true)
      )
      .addIntegerOption(option =>
        option
          .setName("shot_masterate")
          .setDescription("Numero totale di shot già masterate")
          .setRequired(true)
          .setMinValue(0)
      )
      .addStringOption(option =>
        option
          .setName("ordine_pg")
          .setDescription("PG in rotazione, separati da virgola")
          .setRequired(true)
          .setMaxLength(500)
      )
  )

  .addSubcommand(subcommand =>
    subcommand
      .setName("progressione_master")
      .setDescription("Mostra la progressione premi di un master")
      .addUserOption(option =>
        option
          .setName("master")
          .setDescription("Master da controllare; vuoto = te stesso")
          .setRequired(false)
      )
  )

  .addSubcommand(subcommand =>
    subcommand
      .setName("premio_master")
      .setDescription("Riscatta o rinuncia a una ricompensa master")
      .addStringOption(option =>
        option
          .setName("azione")
          .setDescription("Operazione da eseguire")
          .setRequired(true)
          .addChoices(
            { name: "Riscatta", value: "riscatta" },
            { name: "Rinuncia al turno", value: "rinuncia" }
          )
      )
      .addStringOption(option =>
        option
          .setName("pg")
          .setDescription("PG destinatario, obbligatorio per riscatta")
          .setRequired(false)
      )
  );

const rest = new REST({ version: "10" }).setToken(TOKEN);

await rest.put(
  Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID),
  { body: [shotCommand.toJSON()] }
);

console.log("Comandi di Gasterion registrati correttamente.");
