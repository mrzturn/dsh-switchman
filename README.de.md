# dsh-switchman

[English](./README.md) | [简体中文](./README.zh.md) | [繁體中文](./README.zh-TW.md) | [日本語](./README.ja.md) | [한국어](./README.ko.md) | [Español](./README.es.md) | [Français](./README.fr.md) | **Deutsch** | [Italiano](./README.it.md) | [Português](./README.pt.md) | [Русский](./README.ru.md)

> **Die Switchman-Familie**, gleicher Autor, gleiche Orchestrierung: [opencode-switchman](https://github.com/mrzturn/opencode-switchman) (das OpenCode-Original) · [zcode-switchman](https://github.com/mrzturn/zcode-switchman) (die ZCode-Portierung) · **dsh-switchman** (dieses Repo, die DeepSeek-Harness-Edition).

![dsh-switchman — der Kontext-Wasserstand stellt die Weiche und lenkt jede Aufgabe auf die richtige Spur](docs/assets/hero.svg)

> Dem Kontext einen Wasserzähler geben — jede Aufgabe findet von selbst ihre Spur.

## Warum Sie es brauchen

Wer lange mit DSH arbeitet, stößt früher oder später auf zwei Probleme:

1. **Die Sitzung wird mit der Zeit immer schwerer.** Der Verlauf bläht den Kontext auf Hunderttausende Tokens auf; das Modell beginnt zu vergessen, wird langsamer, wird teurer — bis nur noch ein manuelles /compact hilft, und jede Komprimierung schluckt zwangsläufig Details.
2. **Ihr Hauptmodell macht alles selbst.** Eine Datei nachschlagen, einen Test laufen lassen, Daten abgleichen — es wühlt sich allein durch alles, langsam und teuer, obwohl der Großteil dieser Arbeit eigentlich zu einem deutlich billigeren Modell gehören würde.

dsh-switchman ist ein Plugin für [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH). Nach der Installation hört das Hauptmodell auf, alles selbst zu erledigen, und arbeitet als Dispatcher: Wasserstand messen, Spur wählen, Aufgaben verteilen, Ergebnis prüfen. Es ist kein neues Modell — es ist eine auf DSH aufgesetzte Orchestrierungs-Doktrin plus eine Einstellungsseite. Konkret tut es sieben Dinge:

**1. Kontext-Wasserstand: Lange Sitzungen laufen nie über.** Jeder Turn zählt die Live-Tokens der Sitzung und hält sie gegen drei Wassermarken, die sich Stufe um Stufe verschärfen: 50k (soft, einstellbar) mahnt „Zeit zu delegieren“; 90k (hard) verengt das Lesebudget für Dateien pro Turn und drängt zum Abschluss; 130k (force) übernimmt automatisch — ein Fork der Sitzung wird archiviert, der Kontext komprimiert, die Fortsetzung geweckt, und die Aufgabe reißt nicht ab. Auch Hintergrund-Subagents, die in diesem Moment noch laufen, gehen nicht verloren: id, Aufgabenbeschreibung und Berichtspfad werden ins Übergabedokument geschrieben, und die fortgesetzte Sitzung weiß, wo sie die Berichte einsammelt, statt Arbeit doppelt zu verteilen. Jeder losgeschickte Subagent trägt sein eigenes hartes Limit; ist es erreicht, schreibt er seine HANDOFF-Zusammenfassung und verabschiedet sich.

**2. Sechs Dispatch-Pools: das passende Modell für jede Arbeit.** Ein Pool für Leichtes (economy, Kleinkram in Serie), ein mechanischer Pool (mechanical, Umschreibungen nach Vorlage), ein Hauptpool (main, der Coding-Alltag), ein Pool für Schweres (hard, anspruchsvolles Reasoning und große Refaktorierungen), ein Multimodal-Pool (vision, Bilder lesen) und ein Review-Pool (review, unabhängige Verifikation). Auf der Einstellungsseite haken Sie Kandidaten ab, sortieren sie nach Priorität (optional mit S/A/B/C-Tiers) und pinnen pro Route einen eigenen Reasoning-Effort — das Stufen-Dropdown listet, was dieses Modell tatsächlich unterstützt, nicht drei generische Stufen. Jeder Prompt des Hauptmodells trägt eine `[SWITCHMAN:POOLS]`-Empfehlungstabelle mit sich, und nach ihr wird dispatcht. Der Ausführungsmodus kennt drei Zustände: off / advice / enforce (enforce = Modelle außerhalb des Pools werden rundweg abgelehnt).

**3. Agent-Teams-Modus: vom Alleingang zum eigenen Team.** Standardmäßig aus — direkt nach der Installation bleibt es beim leichten subagent-Dispatch. Zwei unabhängige Schalter finden sich auf der Einstellungsseite:

- **Agent-Teams-Modus** — eingeschaltet injiziert er die Team-Doktrin (standardmäßig delegieren + gestufte Verifikation + Disziplin des gemeinsamen Task-Boards) und aktiviert automatisch DSHs Agent Teams: Das Hauptmodell darf feste Teammitglieder anwerben (`spawn_teammate`), Arbeit auf das gemeinsame Task-Board legen (`team_task_*`) und mit ihnen Nachrichten austauschen (`send_message`). Wann ein Team gebildet wird, folgt einer klaren Disziplin: parallelisierbare unabhängige Teilaufgaben, umfangreiche in sich geschlossene Pakete, ein bereits hoch stehender Hauptkontext, der Bedarf an Rollentrennung; einmalige Punktuntersuchungen laufen weiter über einen subagent. DSHs Werksstrategie lautet „kein Team, solange der Nutzer keins nennt“ — hier kippt sie zu „einsetzen, wenn es passt“. Den Schalter wieder auszuschalten hinterlässt keinerlei Rest der Team-Klauseln und nimmt laufenden Sitzungen die Team-Tools niemals weg.
- **Synchronisation der Subagent-Modell-Whitelist** — DSH führt eine Autorisierungs-Whitelist „Modelle, die Agents für Subagents wählen dürfen“: Eine im Pool ausgewählte, aber nie freigegebene Route bekommt beim namentlichen Dispatch eine Absage (im Team-Modus markieren die Pools-Tabelle und die Einstellungsseite solche Routen mit ⚠). Diesen Schalter einschalten, und die Vereinigung aller sechs Pools wird in einem Rutsch in die Whitelist geschrieben — keine doppelte Konfiguration mehr, switchman bleibt die alleinige Wahrheitsquelle, und auch der Fork-Dispatch-Pfad ist abgedeckt. Die Whitelist greift als Schnappschuss je neuer Sitzung; die Synchronisierung wirkt also nur auf Sitzungen, die danach geöffnet werden.

Die Sitzungskopfzeile hält Sie auf dem Laufenden: ein ⚡-Badge „autonomes Team“ und ein ◇-Chip mit dem Modell, das die Sitzung tatsächlich nutzt; läuft gerade eine automatische Übergabe, erscheint live der Hinweis „Übergabe läuft · Sitzung wird gesichert / Kontext wird komprimiert / Fortsetzung wird geweckt“.

**4. Spracheinstellungen: einmal gefragt, für immer gemerkt.** Je ein Dropdown für Antworten, Codekommentare und Dokumentation, mit globaler oder projektspezifischer Geltung (`.switchman/lang.json`). Ungesetzt lassen ist erlaubt — beim ersten echten Bedarf wird einmal gefragt, in der Sprache Ihrer DSH-Oberfläche, die Antwort bleibt gemerkt, und jede spätere Sitzung hält sich automatisch daran.

**5. Oberflächensprache: Das Plugin spricht Ihre Sprache mit.** Ganz oben auf der Einstellungsseite gibt es einen neuen Abschnitt „Oberfläche“ mit einem Dropdown „Oberflächensprache“ (Einstellungsschlüssel `uiLocale`): Auto (Standard — folgt der Sprache der DeepSeek-Harness-App) oder eine der Sprachen der Plugin-Oberfläche, immer als Endonym geschrieben und nie übersetzt. Es schaltet nur die Oberfläche dieses Plugins selbst um — Kopfzeilen-Badge, Startseiten-Panel und Einstellungsseite —, niemals die DSH-App-Sprache: Die Vorschau ist sofort, ganz ohne Neustart; Speichern merkt sich die Wahl pro Profil, der nächste Start stellt sie wieder her, jeder Fehlerfall fällt auf die App-Sprache zurück, und alle Wörterbücher liegen im Bundle — nichts wird nachgeladen.

**6. Gestufte Verifikation: Jede Änderung wird geprüft.** Änderungen über 20 Zeilen gehen an einen Tester; über 300 Zeilen oder sobald Kern- / Sicherheits- / Datenkonsistenz-Logik berührt wird, zusätzlich an einen unabhängigen Reviewer. Das Reviewer-Modell wird so gewählt, dass es das Modell „des Agents, der den Diff geschrieben hat“ meidet — so weit die Pools es zulassen; wenn wirklich nicht, erklärt die Schlussfolgerung DOWNGRADED. Einmal „nutze keine Teams“ gesagt, und er fällt sofort ins Solo zurück.

**7. `/vision`: Auch reine Textmodelle kommen mit Bildern zurecht.** Kann das Hauptmodell keine Bilder lesen, weist DSH Bildnachrichten schon am Eingang zurück. Bild anhängen, `/vision wo liegt der Fehler in diesem Bild` eingeben — das Bild wird zu einem Dateipfad aufgelöst und einem Modell des Multimodal-Pools zum Lesen übergeben; die Erkenntnisse kehren in die aktuelle Sitzung zurück. Über dem Eingabefeld erscheint früh ein Hinweis: „Das aktuelle Modell kann keine Bilder lesen“; wird ein gewöhnlicher Bildversand abgewiesen, wird der Entwurf einmalig als `/vision` umgeschrieben und von selbst erneut gesendet — ohne neues Eintippen; ohne konfigurierten Multimodal-Pool lehnt der Befehl ab und nennt die Einrichtungsschritte.

Nur ein Modell? Die Installation lohnt sich trotzdem — Wasserstandskontrolle und gestufte Verifikation interessieren sich nicht dafür, wie viele Modelle Sie haben; lange Ein-Modell-Sitzungen profitieren genauso.

## Mitgelieferte Skills

- **db-query** — Read-only-Verifikation für MySQL / Redis: SQL ausführen, um Datensätze abzugleichen, Cache-Keys / TTLs zu prüfen und die Konsistenz über Stores hinweg zu kontrollieren; lehnt jede Schreiboperation ab. Einmalige Einrichtung unten.
- **git-commit-message** — erzeugt konventionskonformen Commit-Text. Nur Text; es führt niemals git für Sie aus.
- **requirement-docs** — eine einheitliche Spezifikation für Anforderungsanalyse / PRD / Design-Dokumente, archiviert unter `docs/requirements-and-design/`.

## Schnellstart

1. **Installieren** — aus einer beliebigen Agent-Sitzung oder über die Web-Plugin-Verwaltung:

   ```
   plugin_manager: install_bundle  target=dsh-switchman
   ```

   oder aus einem lokalen Checkout (verlinkt; nach Updates `remove_bundle` + `install_bundle` erneut ausführen):

   ```
   plugin_manager: install_bundle  target=/path/to/dsh-switchman
   ```

   oder im Terminal über den `dsh`-Befehl — wählen Sie das Profil, das dazu passt, wie Sie DSH ausführen:

   ```bash
   dsh plugin --profile web add dsh-switchman      # Web GUI
   dsh plugin --profile desktop add dsh-switchman   # Desktop-App
   ```

2. **DSH neu starten** — die App vollständig beenden und neu öffnen (Seite neu laden genügt nicht), damit die Client-Modul-Tabelle das Bundle erkennt.

3. **Spracheinstellungen** — Settings → dsh-switchman, oder das „Switchman-Control-Center“ in der Startseiten-Seitenleiste. Der erste Bildschirm wählt zuerst den Geltungsbereich: global (dieses Profil) oder pro Projekt (die `.switchman/lang.json` des jeweiligen Projekts); dann legen drei Dropdowns die Sprachen für Antworten / Kommentare / Dokumente fest, jedes mit einer „aktuell: …“-Statuszeile darunter. Überspringen ist erlaubt — beim ersten Gebrauch wird einmal gefragt und die Antwort gemerkt (gefragt wird in der Sprache Ihrer DSH-Oberfläche).

   ![Spracheinstellungen: Geltungsbereich und drei Sprachen](docs/assets/conf-language-en.png)

4. **Die Dispatch-Pools füllen** — jede Pool-Karte listet Kandidatenmodelle gruppiert nach Anbieter; haken Sie die gewünschten ab. „Manuelle Reihenfolge“ anhaken, und die Karte wird zu einer nummerierten Prioritätsliste, die sich mit ↑ ↓ × umsortieren lässt; neben jeder Route lässt sich zusätzlich ein Reasoning-Effort anpinnen (standardmäßig „der Spur folgen“; beim Anpinnen listet er die Stufen, die dieses Modell tatsächlich unterstützt). Eine Zusammenfassungszeile oben verfolgt den Fortschritt live, zum Beispiel „6/6 Pools konfiguriert · 2 gerankt · Modus advice“.

   ![Dispatch-Pools: die vier Pools economy / mechanical / main / hard](docs/assets/conf-pool-1-en.png)

   Multimodal-Pool und Review-Pool stehen darunter; weiter unten folgen das **Fähigkeits-Ranking** (die Vereinigung der in den sechs Pools gewählten Modelle — der Rang ist die Fähigkeitsreihenfolge, das stärkste zuerst, optional mit S/A/B/C-Tiers) und der **Ausführungsmodus** (advice / enforce).

   ![Multimodal-Pool, Review-Pool, Fähigkeits-Ranking und Ausführungsmodus](docs/assets/conf-pool-2-en.png)

5. **Agent-Teams** — beide Schalter sind standardmäßig aus; starten Sie mit reinem subagent-Dispatch. Soll das Modell selbst Teams anwerben, schalten Sie den „Agent-Teams-Modus“ ein; um dieselben Routen nicht doppelt freigeben zu müssen, schalten Sie die „Synchronisation der Subagent-Modell-Whitelist“ ein — eine Statuszeile „synchronisiert: N Routen + Zeitstempel“ unter dem Schalter bestätigt, was geschrieben wurde.

   ![Agent-Teams: die beiden Schalter und der Whitelist-Synchronisierungsstatus](docs/assets/conf-team-en.png)

6. **Kontext-Wasserstand** — die drei Schwellenwerte (Standard 50000 / 90000 / 130000), das Lesebudget pro Aufruf, das Hard-Mode-Verhalten (gedrosselter Durchlass / Blockade), der Schalter für automatische Übergabe und das eigene Subagent-Limit liegen alle in diesem Bereich. Die unterste Zeile trägt die Befehle: `/ctx-pause` pausiert die Eingriffe · `/ctx-resume` setzt fort · `/ctx-handover` sichert und übergibt sofort (es lenkt die Sitzung an eine Leerlaufgrenze und wartet das Komprimierungs-Wiederholungsfenster ab — das Ergebnis kann einige Minuten dauern).

   ![Kontext-Wasserstand: Schwellenwerte, Budgets und Befehle](docs/assets/conf-ctx-en.png)

7. **Verifizieren** — in der Sitzungskopfzeile erscheint ein ⚡-Badge „autonomes Team“ (neben einem ◇, das das Modell der aktuellen Sitzung zeigt); oder fragen Sie das Modell einfach: „Wie lautet die Überschrift des letzten Abschnitts deines Systemprompts?“ — die Antwort sollte die dsh-switchman-Doktrin erwähnen.

**db-query – einmalige Einrichtung** (die Skript-Abhängigkeiten landen im Skill-Verzeichnis — Ihr Projekt bleibt sauber):

```bash
bash <install-dir>/skills/db-query/scripts/setup.sh
```

## Wie es funktioniert

- Die Host-Hälfte (`index.js` + `host/`) injiziert die dynamischen Systemprompt-Abschnitte (Sprache / Spuren / Wasserstand / Teams), die doppelten Schranken aus Lesebudget und enforce sowie die vier Slash-Befehle (das ctx-Trio + `/vision`). Jede gespeicherte Einstellung greift bei der nächsten Prompt-Zusammenstellung — ohne Neustart.
- Die Client-Hälfte (`client.js`) rendert die Einstellungsseite, das ⚡-Badge und den ◇-Modell-Chip in der Sitzungskopfzeile sowie die dynamische Anzeige „Übergabe läuft“ — über die offiziellen settings-form-Dienste.
- Der Eintrag „Switchman-Control-Center“ in der Startseiten-Seitenleiste öffnet per Klick dieselbe Konfigurationsseite (Oberflächensprache, Spracheinstellungen, Dispatch-Pools & Ranking, Wasserstand) als zentrales Panel; der ursprüngliche Einstieg in die Einstellungen bleibt erhalten.
- `cordis.patch.yml` übernimmt die Plugin-Liste der Werks-Presets vollständig und erweitert ausschließlich das persona suffix; die Agent-Teams-Tools selbst stammen aus dem Werks-Bundle und werden beim Einschalten des Team-Modus automatisch aktiviert.

## Wartung

- Ändert ein DSH-Upgrade die Plugin-Listen der Werks-Presets, `cordis.patch.yml` aus den neuen `presets/*.patch.yml` neu synchronisieren (das doctrine suffix behalten) und anschließend neu installieren.
- Die Protokollzeilen (`[SWITCHMAN:LANG|POOLS|WATERMARK|TEAMS]`) bleiben bewusst englisch und byte-stabil — nicht lokalisieren.
- `npm pack --dry-run` muss in der auditierten Form von 50 Dateien / ~205 kB bleiben (die `docs/`-Screenshots wandern nicht ins Paket).

## Lizenz

MIT
