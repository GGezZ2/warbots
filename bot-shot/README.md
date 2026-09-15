# Gasterion — Araldo delle Imprese

Gasterion gestisce iscrizioni, partecipanti, multitavolo, ricompense, coda di gioco, registro shot e premi master.

Usa lo stesso database SQLite di Grumni e Giacomo: non crea copie separate di personaggi, denaro o materiali.

## Flusso normale di una shot

1. Il Master crea manualmente il thread della missiva in bacheca.
2. Nel thread usa `/shot apri`.
3. I player usano `/shot iscriviti`.
4. Il Master usa `/shot chiudi_iscrizioni`.
5. Il Master consulta `/shot consiglia` e assegna stati/tavoli.
6. Se necessario, registra i materiali con `/shot materiale`.
7. Alla fine preme il pulsante **Chiudi shot**.
8. Gasterion assegna ricompense, aggiorna coda e registro staff.

## Comandi player

### `/shot iscriviti`

Iscrive un proprio PG alla shot del thread corrente.

- `pg`: nome del personaggio.
- `spunto`: aggancio narrativo alla missiva, facoltativo.

Il bot verifica che il PG appartenga al player e che sia entro un grado compatibile.

### `/shot ritirati`

Ritira un proprio PG finché le iscrizioni sono aperte.

- `pg`: nome del personaggio.

## Comandi Master

Tutti i seguenti richiedono il ruolo Discord `gm-bot`.

### `/shot apri`

Apre una shot nel thread corrente.

- `grado`: grado centrale della shot.
- `posti`: posti disponibili per ciascun tavolo.
- `xp`: XP ricevuti da ogni partecipante effettivo.
- `tavoli`: facoltativo; lascia vuoto per una shot normale a tavolo singolo.

Esempio:

```text
/shot apri grado:B posti:5 xp:1200 tavoli:2
