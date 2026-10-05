# dsh-switchman

[English](./README.md) | [简体中文](./README.zh.md) | [繁體中文](./README.zh-TW.md) | [日本語](./README.ja.md) | [한국어](./README.ko.md) | [Español](./README.es.md) | [Français](./README.fr.md) | [Deutsch](./README.de.md) | **Italiano** | [Português](./README.pt.md) | [Русский](./README.ru.md)

> **La famiglia switchman**, stesso autore, stessa orchestrazione: [opencode-switchman](https://github.com/mrzturn/opencode-switchman) (l'originale per OpenCode) · [zcode-switchman](https://github.com/mrzturn/zcode-switchman) (il port per ZCode) · **dsh-switchman** (questo repository, per DeepSeek Harness).

![dsh-switchman — il livello dell'acqua del contesto comanda lo switchman, che devia la rotta](docs/assets/hero.svg)

> Contesto al contatore: ogni task trova da sé la corsia giusta.

## Perché serve

Se lavori con DSH, col passare del tempo ti imbatti in due cose:

1. **La sessione pesa sempre di più.** La cronologia gonfia il contesto fino a centinaia di migliaia di token: il modello inizia a dimenticare, rallenta e costa di più, e alla fine non resta che un /compact manuale — che comprime e perde dettagli nel farlo.
2. **Il modello principale fa tutto da solo.** Leggere un file, lanciare un test, confrontare dati: è sempre lui a masticarli — lento e costoso, quando gran parte di quel lavoro spetterebbe a un modello economico.

dsh-switchman è un plugin per [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH). Una volta installato, il modello principale smette di «fare tutto da solo» e diventa un dispatcher: misura il livello dell'acqua, sceglie la corsia, assegna i task, verifica il risultato. Non è un nuovo modello: è un regolamento di orchestrazione agganciato a DSH più un'interfaccia di configurazione. In concreto fa sette cose:

**1. Livello dell'acqua del contesto: le sessioni lunghe non esplodono.** A ogni turno conta i token della sessione in tempo reale, e tre soglie inaspriscono a gradini: 50k (soft, regolabile) ricorda che «è ora di delegare»; 90k (hard) stringe il budget di lettura per singola chiamata e spinge verso la chiusura; 130k (force) avvia l'handover automatico — fork della sessione come copia di backup, contesto compattato, continuazione risvegliata: il task non si interrompe. Nemmeno i subagent in background ancora in corsa al momento del passaggio si perdono: id, descrizione del task e percorso del report finiscono nel documento di handover, così la sessione ripresa sa dove raccogliere i report invece di ri-assegnare lo stesso lavoro. Ogni subagent inviato porta con sé un tetto massimo indipendente e, raggiunto il limite, esce dopo aver scritto il riepilogo HANDOFF.

**2. Sei pool di dispatch: a ogni lavoro il suo modello.** Pool leggero (economy, piccoli lavori in serie), pool meccanico (mechanical, riscritture modellate), pool principale (main, coding di tutti i giorni), pool ad alta difficoltà (hard, ragionamento complesso e refactoring su larga scala), pool multimodale (vision, lettura delle immagini), pool di revisione (review, verifica indipendente). Nella pagina delle impostazioni spunti i candidati, ordini le priorità (con fasce opzionali S/A/B/C) e fichi un reasoning effort per ogni route — il menu a tendina elenca i livelli che quel modello supporta davvero, non tre livelli generici. A ogni turno il prompt del modello principale viaggia con una tabella di raccomandazioni `[SWITCHMAN:POOLS]`: si assegna il lavoro seguendo la tabella. La modalità di esecuzione ha tre stati: off / advice / enforce (enforce = i modelli fuori pool vengono rifiutati sul posto).

**3. Modalità Agent Teams: dal lavoro solitario alla squadra.** Disattivata di default: appena installato si lavora con un dispatch leggero via subagent. Nella pagina delle impostazioni, due interruttori indipendenti:

- **Modalità Agent Teams** — una volta attivata, inietta la dottrina di squadra (delega per default + verifica a livelli + disciplina del task board condiviso) e abilita automaticamente gli Agent Teams di DSH: il modello principale può arruolare compagni permanenti (`spawn_teammate`), assegnare lavori al task board condiviso (`team_task_*`) e scambiarsi messaggi con loro (`send_message`). Quando formare la squadra segue una disciplina precisa: sotto-task indipendenti parallelizzabili, lavori voluminosi e autosufficienti, livello dell'acqua del contesto principale già alto, necessità di separare i ruoli; le indagini una-tantum restano al subagent. La politica di fabbrica di DSH è «niente squadra se l'utente non la nomina»: qui si inverte in «usala quando serve». Ri-spegnendo l'interruttore, le clausole di squadra spariscono senza residui, e gli strumenti di squadra nelle sessioni in corso non vengono ritirati.
- **Sincronizzazione della whitelist dei modelli per i subagent** — DSH ha una whitelist di autorizzazione «Consenti agli agenti di scegliere i modelli per i subagent»: le route scelte nei pool ma non autorizzate vengono rifiutate se il modello principale le nomina esplicitamente (in modalità squadra, la tabella di raccomandazioni e la pagina delle impostazioni le marcano con ⚠). Con questo interruttore attivo, l'unione dei sei pool viene scritta in un colpo solo in quella whitelist — niente configurazione doppia: switchman è l'unica fonte di verità, e vi rientra anche il percorso di dispatch via fork. La whitelist scatta come snapshot alla «nuova sessione»: la sincronizzazione vale solo per le sessioni aperte dopo.

L'intestazione della sessione dà un riscontro immediato: badge ⚡ «Squadra autonoma», ◇ modello effettivo della sessione in corso; durante un handover automatico compare un avviso in tempo reale del tipo «Handover in corso · backup della sessione / compattazione del contesto / risveglio della continuazione».

**4. Preferenze linguistiche: chiede una volta, ricorda per sempre.** Un menu a tendina per ciascuna delle tre lingue — risposte, commenti nel codice, documenti — con ambito a scelta globale o per progetto (`.switchman/lang.json`). Puoi anche non impostarlo: al primo utilizzo ti viene chiesto una volta, nella lingua dell'interfaccia DSH, e da lì in poi ogni sessione lo rispetta da sé.

**5. Lingua dell'interfaccia: il plugin parla anche la tua lingua.** In cima alla pagina delle impostazioni arriva una nuova sezione «Interfaccia» con un menu a tendina «Lingua dell'interfaccia» (chiave di impostazione `uiLocale`): Automatico (predefinito — segue la lingua dell'app DeepSeek Harness) o una qualsiasi delle lingue dell'interfaccia del plugin, sempre mostrata con il suo endonimo, mai tradotta. Cambia solo l'interfaccia del plugin stesso — il badge nell'intestazione, il pannello home e la pagina delle impostazioni —, non la lingua dell'app DSH: l'anteprima è immediata, senza riavvio; il salvataggio ricorda la scelta per profilo; il prossimo avvio la ripristina; ogni errore ricade sulla lingua dell'app; e tutti i dizionari viaggiano nel bundle, nessun download.

**6. Verifica a livelli: finita la modifica, si controlla.** Le modifiche oltre 20 righe vanno a un tester per la verifica; oltre 300 righe, o quando si toccano logica centrale / sicurezza / coerenza dei dati, subentra anche un reviewer con revisione indipendente. Il modello del reviewer si sceglie ancorandolo a quello dell'«agente che ha scritto il diff», evitandolo per quanto possibile; se nel pool proprio non si riesce, la conclusione dichiara DOWNGRADED. Basta dire «non usare le squadre» e torna subito a lavorare da solo.

**7. `/vision`: anche i modelli solo testo trattano le immagini.** Quando il modello principale non sa leggere le immagini, DSH rifiuta al varco i messaggi che le contengono. Alleghi l'immagine e digiti `/vision dov'è l'errore in questa immagine`: l'immagine viene risolta in un percorso di file e affidata alla lettura di un modello del pool multimodale, e la conclusione torna nella sessione corrente. Sopra la casella di input compare in anticipo l'avviso «il modello corrente non supporta la lettura delle immagini»; se un invio diretto dell'immagine viene rifiutato, il messaggio viene riscritto una volta in `/vision` e reinviato da solo, senza dover rifare tutto a mano; senza pool multimodale configurato, il comando rifiuta e indica come configurarlo.

Un solo modello? Vale comunque la pena installarlo — il controllo del livello dell'acqua e la verifica a livelli non guardano a quanti modelli hai, e ne giovancono allo stesso modo le sessioni lunghe con un modello unico.

## Skill incluse

- **db-query** — verifica in sola lettura su MySQL/Redis: esegui SQL per controllare record, chiavi di cache / TTL, coerenza tra store. Rifiuta ogni scrittura. Configurazione una tantum qui sotto.
- **git-commit-message** — testo di commit conforme alle convenzioni. Solo testo; non tocca mai git.
- **requirement-docs** — un'unica specifica per requisiti / PRD / documenti di design, archiviata in `docs/requirements-and-design/`.

## Avvio rapido

1. **Installa** — da qualsiasi sessione agent, o dal gestore plugin Web:

   ```
   plugin_manager: install_bundle  target=dsh-switchman
   ```

   oppure da un checkout locale (link; riesegui `remove_bundle` + `install_bundle` dopo aver fatto pull delle modifiche):

   ```
   plugin_manager: install_bundle  target=/path/to/dsh-switchman
   ```

   oppure da un terminale tramite la CLI `dsh` — scegli il profilo che corrisponde a come esegui DSH:

   ```bash
   dsh plugin --profile web add dsh-switchman      # Web GUI
   dsh plugin --profile desktop add dsh-switchman   # app desktop
   ```

2. **Riavvia DSH** — chiudi completamente l'app e riaprila (ricaricare la pagina non basta), così la tabella dei moduli client rileva il bundle.

3. **Preferenze linguistiche** — Settings → dsh-switchman, oppure la voce «Switchman Control Center» nella barra laterale della home. Nella prima schermata si sceglie prima l'ambito: globale (questo profilo) o per progetto (il `.switchman/lang.json` di ciascun progetto); poi tre menu a tendina fissano rispettivamente la lingua di risposte / commenti / documenti, ciascuno con una riga di stato «Attuale: …» sottostante. Puoi anche saltare: al primo uso ti verrà chiesto una volta e ricordato (la domanda segue la lingua dell'interfaccia DSH).

   ![Preferenze linguistiche: ambito e tre lingue](docs/assets/conf-language-en.png)

4. **Configura i pool di dispatch** — in ogni scheda di pool spunti i modelli candidati raggruppati per provider; spuntando «ordine manuale» la scheda diventa una lista di priorità numerata, da riordinare con ↑ ↓ ×, e accanto a ogni route puoi fichare il reasoning effort (predefinito «segui la corsia»; una volta fichato elenca le fasce che quel modello supporta davvero). La riga di riepilogo in alto riflette i progressi in tempo reale, per esempio «6/6 pool configurati · 2 in classifica · modalità advice».

   ![Pool di dispatch: i quattro pool economy / mechanical / main / hard](docs/assets/conf-pool-1-en.png)

   Il pool multimodale e quello di revisione stanno più sotto; ancora più in basso arrivano la **classifica di capacità** (l'unione dei modelli scelti nei sei pool: la numerazione è l'ordine di capacità, i più forti davanti, con fasce opzionali S/A/B/C) e la **modalità di esecuzione** (advice / enforce).

   ![Pool multimodale e pool di revisione, classifica di capacità e modalità di esecuzione](docs/assets/conf-pool-2-en.png)

5. **Agent Teams** — entrambi gli interruttori partono spenti: prima falla girare in puro modello subagent. Per lasciare che arruoli la squadra da sola, attiva «Modalità Agent Teams»; per risparmiare la doppia autorizzazione, attiva «Sincronizzazione della whitelist dei modelli per i subagent» — sotto l'interruttore una riga di stato del tipo «N voci sincronizzate + ora» conferma l'esito della scrittura.

   ![Agent Teams: i due interruttori e lo stato di sincronizzazione della whitelist](docs/assets/conf-team-en.png)

6. **Livello dell'acqua del contesto** — le tre soglie (predefinite 50000 / 90000 / 130000), il budget di lettura per singola chiamata, il comportamento della soglia hard (passa con limitazione / blocca), l'interruttore dell'handover automatico e il tetto indipendente dei subagent stanno tutti in quest'area. Una riga di comandi in fondo: `/ctx-pause` sospende gli interventi · `/ctx-resume` li riprende · `/ctx-handover` fa subito backup e passaggio di consegne (guida la sessione fino al confine di inattività e attende la finestra di retry della compattazione: il risultato può richiedere alcuni minuti).

   ![Livello dell'acqua del contesto: soglie, budget e comandi](docs/assets/conf-ctx-en.png)

7. **Verifica** — nell'intestazione della sessione compare il badge ⚡ «Squadra autonoma» (accanto, il ◇ mostra il modello della sessione in corso); oppure chiedi direttamente al modello «qual è il titolo dell'ultima sezione del tuo system prompt?» — la risposta dovrebbe menzionare la dottrina dsh-switchman.

**Configurazione una tantum di db-query** (le dipendenze degli script vivono nella directory della skill, senza sporcare il progetto):

```bash
bash <install-dir>/skills/db-query/scripts/setup.sh
```

## Come funziona

- La parte Host (`index.js` + `host/`) inietta le sezioni dinamiche del system prompt (lingue / corsie / livello dell'acqua / squadra), il doppio cancello budget di lettura + enforce e i quattro comandi slash (il trio ctx più `/vision`). Ogni impostazione salvata vale già dall'assemblaggio del prompt successivo, senza riavvio.
- La parte Client (`client.js`) renderizza la pagina delle impostazioni, il badge ⚡ e l'identificativo ◇ del modello nell'intestazione della sessione e l'avviso dinamico durante l'handover, appoggiandosi ai servizi ufficiali settings-form.
- La voce «Switchman Control Center» nella barra laterale della home apre con un clic la stessa pagina di configurazione (lingua dell'interfaccia, preferenze linguistiche, pool di dispatch e classifica, livello dell'acqua) come pannello centrale; la voce nelle impostazioni resta al suo posto.
- `cordis.patch.yml` conserva integralmente la lista di plugin dei preset di fabbrica e interviene solo sul persona suffix; gli strumenti Agent Teams in sé vengono dal bundle di fabbrica e vengono abilitati automaticamente all'attivazione della modalità squadra.

## Manutenzione

- Dopo un upgrade di DSH che cambia la lista di plugin dei preset di serie, risincronizza `cordis.patch.yml` dai nuovi `presets/*.patch.yml` (mantieni il doctrine suffix), poi reinstalla.
- Le righe di protocollo (`[SWITCHMAN:LANG|POOLS|WATERMARK|TEAMS]`) restano deliberatamente in inglese e stabili al byte — non localizzarle.
- `npm pack --dry-run` deve restare alla forma auditata di 50 file / ~205 kB (gli screenshot in `docs/` non viaggiano nel pacchetto).

## License

MIT
