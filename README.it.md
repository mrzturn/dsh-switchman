# dsh-switchman

[English](./README.md) | [简体中文](./README.zh.md) | [繁體中文](./README.zh-TW.md) | [日本語](./README.ja.md) | [한국어](./README.ko.md) | [Español](./README.es.md) | [Français](./README.fr.md) | [Deutsch](./README.de.md) | **Italiano** | [Português](./README.pt.md) | [Русский](./README.ru.md)

> **La famiglia switchman**, stesso autore, stessa orchestrazione: [opencode-switchman](https://github.com/mrzturn/opencode-switchman) (l'originale per OpenCode) · [zcode-switchman](https://github.com/mrzturn/zcode-switchman) (il port per ZCode) · **dsh-switchman** (questo repository, per DeepSeek Harness).

![dsh-switchman — il livello dell'acqua del contesto comanda lo switchman, che devia la rotta](docs/assets/hero.svg)

> Contesto al contatore. I task si assegnano da soli.

Un plugin per [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH). Una volta installato, il tuo modello primario smette di fare tutto da solo e diventa un dispatcher: misura il livello dell'acqua, sceglie la corsia, assegna il task, controlla il lavoro. Quattro cose:

**1. Controllo del livello dell'acqua del contesto.** A ogni turno misura i token live della sessione. Soft (50k di default) consiglia di delegare, hard (90k) stringe il budget di lettura per turno e spinge alla chiusura, force (130k) esegue il backup della sessione e la consegna alla compattazione — automaticamente. Tieni una sessione aperta tutto il giorno; il tuo contesto non affoga mai nella sua stessa cronologia. Ogni subagent dispatchato porta con sé il proprio hard cap ed esce con un riepilogo HANDOFF quando lo raggiunge.

**2. Dispatch a sei corsie.** economy / mechanical / main / hard / vision / review — sei corsie cognitive. Scegli i modelli candidati per corsia nella pagina delle impostazioni, ordinali dal più forte (ancoraggio opzionale a fasce S/A/B/C) e fissa un reasoning effort per route — il menu a tendina elenca i livelli che ogni modello *supporta davvero*, non tre livelli generici. Una tabella `[SWITCHMAN:POOLS]` viaggia con ogni prompt, così il modello sa a chi rivolgersi; la modalità `enforce` rifiuta seccamente i modelli fuori pool.

**3. Preferenze linguistiche.** Un menu a tendina per le risposte, uno per i commenti del codice e uno per i documenti redatti. Non impostato? Ti viene chiesto una volta, resta ricordato per sempre e ogni sessione successiva lo rispetta.

**4. Dottrina delegate-by-default.** Sostituisce la politica di team conservativa di serie di DSH ("crea membri del team solo su richiesta"): le minuzie restano fai-da-te (<200 righe lette, <50 modificate), il lavoro vero viene delegato di default; ogni modifica viene verificata — oltre 20 righe va a un tester, oltre 300 righe o logica centrale va a un reviewer. Di' "non usare i team" e si fa da parte all'istante.

Un solo modello? Vale comunque la pena — il controllo del livello dell'acqua e la dottrina non guardano a quanti modelli hai.

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

3. **Apri la pagina delle impostazioni** — Settings → dsh-switchman. La prima schermata è le preferenze linguistiche: un menu a tendina per risposte / commenti / documenti, ciascuno con una riga live `current: …`. Salta pure — ti verrà chiesto una volta e verrà ricordato.

   ![Pagina impostazioni e preferenze linguistiche](docs/assets/conf-demo1.png)

4. **Compila i sei pool** — ogni scheda pool elenca i candidati raggruppati per provider; spunta quelli che vuoi. Spunta **manual order** e la scheda diventa una lista di priorità numerata con i controlli ↑ ↓ ×. Il menu effort accanto a ogni route selezionata è su *follow lane* di default; fissandolo mostra i livelli che quel modello supporta davvero (Low / High / Max…). Una riga di riepilogo traccia i progressi in tempo reale: “6/6 pool impostati · 3 in classifica · modalità advice”.

   ![Pool di dispatch](docs/assets/conf-demo2.png)

5. **Classifica e watermark** — l'ordine della tabella di classifica è l'ordine di capacità (prima i più forti), con fasce opzionali S/A/B/C; la modalità di esecuzione è `off` / advice / enforce (enforce = i modelli fuori pool vengono rifiutati). Sotto, la sezione watermark irrigidisce il comportamento in base al consumo di token: tre soglie, un budget di lettura per chiamata, il comportamento della modalità hard (cap / deny), un interruttore per l'handover automatico e un cap separato per i subagent. La riga in fondo porta i comandi: `/ctx-pause` per smettere di intervenire · `/ctx-resume` per riprendere · `/ctx-handover` per fare subito backup e passaggio di consegne.

   ![Classifica e watermark del contesto](docs/assets/conf-demo3.png)

6. **Verifica** — il badge ⚡ appare accanto al chip del preset nell'intestazione di ogni sessione; chiedi al modello “cosa dice l'ultima sezione del tuo system prompt?” — dovrebbe menzionare la dottrina dsh-switchman.

**Configurazione una tantum di db-query** (le dipendenze degli script vivono nella directory della skill):

```bash
bash <install-dir>/skills/db-query/scripts/setup.sh
```

## Come funziona

- La parte Host (`index.js` + `host/`) inietta tre sezioni dinamiche del system prompt, i gate di budget di lettura ed enforce, la cattura automatica delle risposte e tre comandi slash. Tutte le impostazioni sono campi volatili — le modifiche salvate valgono dall'assemblaggio del prompt successivo, senza riavvio.
- La parte Client (`client.js`) renderizza il badge ⚡ accanto al chip del preset e la pagina delle impostazioni, attraverso i servizi ufficiali settings-form.
- `cordis.patch.yml` ripete verbatim la lista di plugin di ogni preset di serie ed estende solo il suffisso di persona; gli strumenti Agent Teams in sé continuano a venire dal `@deepseek-ai/dsh-experimental-agent-team-profile` di serie.

## Manutenzione

- Dopo un upgrade di DSH che cambia le liste di plugin dei preset di serie, risincronizza `cordis.patch.yml` dai nuovi `presets/*.patch.yml` (conserva il suffisso della dottrina), poi reinstalla.
- Le righe di protocollo rivolte al modello (`[SWITCHMAN:LANG|POOLS|WATERMARK]`) sono deliberatamente in inglese e stabili al byte — non localizzarle.
- `npm pack --dry-run` deve restare alla forma auditata di 34 file / ~111 kB (gli screenshot in `docs/` non viaggiano mai nel pacchetto).

## License

MIT
