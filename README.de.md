# dsh-switchman

[English](./README.md) | [简体中文](./README.zh.md) | [繁體中文](./README.zh-TW.md) | [日本語](./README.ja.md) | [한국어](./README.ko.md) | [Español](./README.es.md) | [Français](./README.fr.md) | **Deutsch** | [Italiano](./README.it.md) | [Português](./README.pt.md) | [Русский](./README.ru.md)

> **Die Switchman-Familie**, gleicher Autor, gleiche Orchestrierung: [opencode-switchman](https://github.com/mrzturn/opencode-switchman) (das OpenCode-Original) · [zcode-switchman](https://github.com/mrzturn/zcode-switchman) (die ZCode-Portierung) · **dsh-switchman** (dieses Repo, für DeepSeek Harness).

![dsh-switchman — der Kontext-Wasserstand steuert den Weichenwärter und stellt die Route](docs/assets/hero.svg)

> Kontext auf einer Anzeige. Aufgaben verteilen sich selbst.

Ein Plugin für [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH). Einmal installiert, hört Ihr Hauptmodell auf, alles selbst zu erledigen, und wird zum Dispatcher: Wasserstand messen, Spur wählen, Aufgabe verteilen, Arbeit prüfen. Vier Dinge:

**1. Kontext-Wasserstandskontrolle.** Jeder Turn misst die Live-Tokens der Sitzung. Soft (Standard 50k) empfiehlt zu delegieren, hard (90k) verengt das Lesebudget pro Turn und drängt zum Abschluss, force (130k) sichert die Sitzung und übergibt sie an die Kompaktierung — automatisch. Fahren Sie eine Sitzung den ganzen Tag; Ihr Kontext ertrinkt nie im eigenen Verlauf. Jeder dispatchte Subagent trägt sein eigenes Hard Cap und endet mit einer HANDOFF-Zusammenfassung, sobald es erreicht ist.

**2. Dispatch auf sechs Spuren.** economy / mechanical / main / hard / vision / review — sechs kognitive Spuren. Wählen Sie auf der Einstellungsseite Kandidatenmodelle pro Spur, sortieren Sie sie stärkste zuerst (optionale S/A/B/C-Tier-Verankerung) und pinnen Sie pro Route einen Reasoning-Effort — das Dropdown listet die Stufen, die jedes Modell *tatsächlich* unterstützt, nicht drei generische Stufen. Jedem Prompt liegt eine `[SWITCHMAN:POOLS]`-Tabelle bei, damit das Modell weiß, wen es aufrufen soll; der `enforce`-Modus lehnt Modelle außerhalb des Pools rundweg ab. Routen, die die DSH-Einstellungen der Sitzung nicht für die explizite Subagent-Auswahl freigegeben haben, werden sowohl in der Pools-Tabelle als auch auf der Einstellungsseite mit ⚠ markiert und verweisen auf die DSH-Einstellungen (Subagents → model selection) zur Freigabe — andernfalls weichen die Agents auf implizites Dispatching aus. Die Review-Unabhängigkeit verankert am Modell des Code-**Autors** (der Agent, der den Diff erzeugt hat), nicht am Modell der Haupt-Sitzung.

**3. Spracheinstellungen.** Je ein Dropdown für Antworten, Codekommentare und verfasste Dokumente. Nicht gesetzt? Sie werden einmal gefragt, es wird für immer gemerkt, und jede spätere Sitzung hält sich daran.

**4. Doktrin: standardmäßig delegieren.** Ersetzt die mit DSH ausgelieferte konservative Team-Policy („Teammates nur auf Anfrage erstellen“): Kleinkram bleibt in eigener Hand (<200 gelesene Zeilen, <50 geänderte), echte Arbeit wird standardmäßig delegiert; jede Änderung wird verifiziert — >20 Zeilen gehen an einen Tester, >300 Zeilen oder Kernlogik an einen Reviewer, dessen Modell sich vom Code-Autor unterscheidet (als DOWNGRADED deklariert, wenn der Pool keinen anbieten kann). Sag „keine Teams nutzen“, und er tritt sofort zurück.

Nur ein Modell? Lohnt sich trotzdem — die Wasserstandskontrolle und die Doktrin interessieren sich nicht dafür, wie viele Modelle Sie haben.

## Mitgelieferte Skills

- **db-query** — Read-only-Verifikation für MySQL/Redis: führt SQL aus, um Datensätze, Cache-Keys / TTLs und store-übergreifende Konsistenz zu prüfen. Verweigert jede Schreiboperation. Einmalige Einrichtung unten.
- **git-commit-message** — konventionskonformer Commit-Text. Nur Text; fasst git nie an.
- **requirement-docs** — eine einzige Spezifikation für Anforderungen / PRD / Design-Dokumente, archiviert unter `docs/requirements-and-design/`.

## Schnellstart

1. **Installieren** — aus einer beliebigen Agent-Sitzung oder über den Web-Plugin-Manager:

   ```
   plugin_manager: install_bundle  target=dsh-switchman
   ```

   oder aus einem lokalen Checkout (verlinkt; nach dem Pullen von Änderungen `remove_bundle` + `install_bundle` erneut ausführen):

   ```
   plugin_manager: install_bundle  target=/path/to/dsh-switchman
   ```

   oder über das `dsh`-CLI im Terminal — wählen Sie das Profil, das dazu passt, wie Sie DSH ausführen:

   ```bash
   dsh plugin --profile web add dsh-switchman      # Web GUI
   dsh plugin --profile desktop add dsh-switchman   # Desktop-App
   ```

2. **DSH neu starten** — beenden Sie die App vollständig und öffnen Sie sie neu (ein Seiten-Reload genügt nicht), damit die Client-Modul-Tabelle das Bundle aufnimmt.

3. **Einstellungsseite öffnen** — Settings → dsh-switchman. Der erste Bildschirm sind die Spracheinstellungen: ein Dropdown für den Geltungsbereich — profilweit oder pro Projekt (`.switchman/lang.json` des jeweiligen Projekts) — plus je ein Dropdown für Antworten / Kommentare / Dokumente, jedes mit einer Live-Zeile `current: …`. Sie dürfen sie überspringen — Sie werden einmal gefragt, und es bleibt gemerkt (gefragt wird in der Sprache Ihrer DSH-Oberfläche).

   ![Einstellungsseite und Spracheinstellungen](docs/assets/conf-demo1.png)

4. **Die sechs Pools füllen** — jede Pool-Karte listet Kandidaten gruppiert nach Provider; haken Sie die gewünschten an. Haken Sie **manual order** an, und die Karte wird zu einer nummerierten Prioritätsliste mit ↑ ↓ ×-Steuerungen. Das Effort-Dropdown neben jeder ausgewählten Route steht standardmäßig auf *follow lane*; beim Fixieren listet es die Stufen, die dieses Modell tatsächlich unterstützt (Low / High / Max…). Eine Zusammenfassungszeile verfolgt den Fortschritt live: “6/6 pools set · 3 ranked · mode advice”. Ausgewählte Routen, die die DSH-Einstellungen nicht für die explizite Subagent-Auswahl freigegeben haben, tragen ein ⚠-Badge mit Hinweis — geben Sie sie ebenfalls in den DSH-Einstellungen (Subagents → model selection) frei, sonst werden Agents, die sie explizit nennen, abgelehnt und weichen auf implizites Dispatching aus.

   ![Dispatch-Pools](docs/assets/conf-demo2.png)

5. **Ranking und Watermark** — die Reihenfolge der Ranking-Tabelle ist die Fähigkeitsreihenfolge (stärkste zuerst), mit optionalen S/A/B/C-Tiers; der Ausführungsmodus ist `off` / advice / enforce (enforce = Modelle außerhalb des Pools werden abgelehnt). Darunter verengt der Watermark-Abschnitt das Verhalten entlang des Token-Verbrauchs: drei Schwellenwerte, ein Lesebudget pro Aufruf, das Hard-Mode-Verhalten (cap / deny), ein Schalter für automatische Übergabe und ein separates Limit für Subagents. Die unterste Zeile trägt die Befehle: `/ctx-pause` zum Stoppen der Eingriffe · `/ctx-resume` zum Fortsetzen · `/ctx-handover` zum Sichern und sofortigen Übergeben (es lenkt die Sitzung an die Leerlauf-Grenze und wartet die Kompaktierungs-Wiederholungsphase ab, daher kann das Ergebnis einige Minuten dauern).

   ![Ranking und Kontext-Watermark](docs/assets/conf-demo3.png)

6. **Verifizieren** — das ⚡-Badge erscheint neben dem Preset-Chip in der Kopfzeile jeder Sitzung; fragen Sie das Modell „was sagt der letzte Abschnitt deines Systemprompts?“ — es sollte die dsh-switchman-Doktrin erwähnen.

**db-query – einmalige Einrichtung** (die Skript-Abhängigkeiten liegen im Skill-Verzeichnis):

```bash
bash <install-dir>/skills/db-query/scripts/setup.sh
```

## Wie es funktioniert

- Die Host-Hälfte (`index.js` + `host/`) injiziert drei dynamische Systemprompt-Abschnitte, die Lesebudget- und Enforce-Schranken, die automatische Antworterfassung und drei Slash-Befehle. Alle Einstellungen sind flüchtige Felder — gespeicherte Änderungen greifen bei der nächsten Prompt-Zusammenstellung, ohne Neustart.
- Die Client-Hälfte (`client.js`) rendert das ⚡-Badge neben dem Preset-Chip sowie die Einstellungsseite über die offiziellen Settings-Form-Dienste.
- Die Startseiten-Seitenleiste erhält einen eigenen **Switchman**-Eintrag neben der Skills-Center-Zeile; ein Klick öffnet dieselbe Einstellungsseite (Sprachen, Pools & Ranking, Watermark) als zentrales Panel. Der Einstellungsabschnitt und das ⚡-Badge bleiben erhalten.
- `cordis.patch.yml` gibt die Plugin-Liste jedes mitgelieferten Presets wortgleich wieder und erweitert nur das Persona-Suffix; die Agent-Teams-Tools selbst kommen weiterhin aus dem mitgelieferten `@deepseek-ai/dsh-experimental-agent-team-profile`.

## Wartung

- Nach einem DSH-Upgrade, das die Plugin-Listen der mitgelieferten Presets ändert: `cordis.patch.yml` aus den neuen `presets/*.patch.yml` neu synchronisieren (das Doktrin-Suffix behalten) und anschließend neu installieren.
- Die modellseitigen Protokollzeilen (`[SWITCHMAN:LANG|POOLS|WATERMARK]`) sind bewusst Englisch und byte-stabil — nicht lokalisieren.
- `npm pack --dry-run` muss in der geprüften Form von 34 Dateien / ~111 kB bleiben (die `docs/`-Screenshots werden nie mitgeliefert).

## Lizenz

MIT
