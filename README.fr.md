# dsh-switchman

[English](./README.md) | [简体中文](./README.zh.md) | [繁體中文](./README.zh-TW.md) | [日本語](./README.ja.md) | [한국어](./README.ko.md) | [Español](./README.es.md) | **Français** | [Deutsch](./README.de.md) | [Italiano](./README.it.md) | [Português](./README.pt.md) | [Русский](./README.ru.md)

> **La famille switchman**, même auteur, même orchestration : [opencode-switchman](https://github.com/mrzturn/opencode-switchman) (l'original OpenCode) · [zcode-switchman](https://github.com/mrzturn/zcode-switchman) (le portage ZCode) · **dsh-switchman** (ce dépôt, pour DeepSeek Harness).

![dsh-switchman — le niveau d'eau du contexte commande l'aiguilleur et lance l'itinéraire](docs/assets/hero.svg)

> Le contexte sur un compteur. Les tâches se dispatchent seules.

Un plugin pour [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH). Une fois installé, votre modèle principal cesse de tout faire lui-même et devient répartiteur : mesurer le niveau d'eau, choisir le couloir, distribuer la tâche, vérifier le travail. Cinq choses :

**1. Contrôle du niveau d'eau du contexte.** Chaque tour mesure les tokens vivants de la session. Soft (50k par défaut) conseille de déléguer, hard (90k) resserre le budget de lecture par tour et pousse à conclure, force (130k) sauvegarde la session et passe le relais à la compaction — automatiquement. Faites tourner une session toute la journée ; votre contexte ne se noie jamais dans son propre historique. Chaque sous-agent dispatché porte son propre hard cap et se termine par un résumé HANDOFF une fois celui-ci atteint. Lors d'une remise, les sous-agents en arrière-plan encore en cours sont capturés en instantané — id, description, chemin de collecte du rapport — dans le document de remise et l'instruction de continuation, afin que la session compactée récupère leurs rapports au lieu de redispenser en double.

**2. Dispatch à six couloirs.** economy / mechanical / main / hard / vision / review — six couloirs cognitifs. Choisissez les modèles candidats par couloir dans la page de réglages, classez-les du plus fort au plus faible (ancrage de tiers S/A/B/C optionnel) et épinglez un effort de raisonnement par route — le menu déroulant liste les niveaux que chaque modèle *supporte réellement*, pas trois niveaux génériques. Une table `[SWITCHMAN:POOLS]` accompagne chaque prompt pour que le modèle sache qui appeler ; le mode `enforce` rejette sans appel les modèles hors pool. Les routes que les réglages DSH de la session n'ont pas autorisées pour la sélection explicite de sous-agents sont marquées ⚠ à la fois dans la table de pools et sur la page de réglages, vous orientant vers les réglages DSH (Subagents → model selection) pour les autoriser — sinon les agents retombent sur le dispatch implicite. L'indépendance de la révision s'ancre sur le modèle de l'**auteur** du code (l'agent qui a produit le diff), pas sur celui de la session principale.

**3. Préférences de langue.** Un menu déroulant pour chacun : réponses, commentaires de code et documents rédigés. Non défini ? On vous le demande une fois, c'est retenu pour toujours, et chaque session suivante s'y tient.

**4. Doctrine de délégation par défaut.** Remplace la politique d'équipe conservatrice livrée avec DSH (« ne créer des teammates que sur demande ») : le trivial reste traité en direct (<200 lignes lues, <50 modifiées), le vrai travail est délégué par défaut ; toute modification est vérifiée — >20 lignes vont à un testeur, >300 lignes ou la logique centrale vont à un réviseur dont le modèle diffère de celui de l'auteur du code (déclaré DOWNGRADED quand le pool ne peut en offrir un). Dites « pas d'équipes » et il s'efface aussitôt.

**5. Déblocage des images (`/vision`).** Un modèle de session purement textuel ne peut pas lire les images — DSH refuse l'envoi côté hôte. Switchman enregistre une commande globale `/vision` qui laisse passer les images du composer au-delà de ce contrôle, résout chacune en chemin de fichier hôte et les réémet en texte, pour que le modèle délègue la lecture à un modèle du pool vision ou à un outil MCP d'images : joignez l'image, puis tapez `/vision <question>`. Tant que le modèle est purement textuel, un chip d'indice apparaît au-dessus du composer (utilisez `/vision`, ou configurez d'abord le pool vision), et un envoi d'image ordinaire refusé est réécrit une fois en `/vision <texte original>` puis renvoyé tout seul — les images atteignent le pool vision sans retaper. Pool vision vide : la commande refuse avec des indications de configuration.


Un seul modèle ? Ça vaut toujours le coup — le contrôle du niveau d'eau et la doctrine ne dépendent pas de votre nombre de modèles.

## Skills incluses

- **db-query** — vérification MySQL/Redis en lecture seule : exécute du SQL pour vérifier les enregistrements, les clés de cache / TTL et la cohérence inter-stores. Refuse toute écriture. Configuration unique ci-dessous.
- **git-commit-message** — texte de commit conforme aux conventions. Texte uniquement ; ne touche jamais à git.
- **requirement-docs** — une seule spécification pour exigences / PRD / documents de conception, archivée dans `docs/requirements-and-design/`.

## Démarrage rapide

1. **Installer** — depuis n'importe quelle session d'agent, ou depuis le gestionnaire de plugins web :

   ```
   plugin_manager: install_bundle  target=dsh-switchman
   ```

   ou depuis un checkout local (lié ; relancez `remove_bundle` + `install_bundle` après avoir récupéré des modifications) :

   ```
   plugin_manager: install_bundle  target=/path/to/dsh-switchman
   ```

   ou depuis un terminal via la CLI `dsh` — choisissez le profil correspondant à votre façon d'exécuter DSH :

   ```bash
   dsh plugin --profile web add dsh-switchman      # Web GUI
   dsh plugin --profile desktop add dsh-switchman   # appli desktop
   ```

2. **Redémarrer DSH** — quittez entièrement l'application puis rouvrez-la (recharger la page ne suffit pas) pour que la table des modules client prenne en compte le bundle.

3. **Ouvrir la page de réglages** — Settings → dsh-switchman. Le premier écran est celui des préférences de langue : un menu déroulant de portée — tout le profil ou par projet (`.switchman/lang.json` de chaque projet) — plus un menu déroulant pour réponses / commentaires / documents, chacun avec une ligne `current: …` en direct. Passez-les si vous voulez — on vous demandera une fois et ce sera retenu (la question est posée dans la langue de l'interface DSH).

   ![Page de réglages et préférences de langue](docs/assets/conf-demo1.png)

4. **Remplir les six pools** — chaque carte de pool liste les candidats groupés par fournisseur ; cochez ceux que vous voulez. Cochez **manual order** et la carte devient une liste de priorités numérotée avec des contrôles ↑ ↓ ×. Le menu d'effort à côté de chaque route sélectionnée vaut *follow lane* par défaut ; l'épingler liste les niveaux que ce modèle supporte réellement (Low / High / Max…). Une ligne de résumé suit la progression en direct : “6/6 pools set · 3 ranked · mode advice”. Les routes sélectionnées que vos réglages DSH n'ont pas autorisées pour la sélection explicite de sous-agents portent un badge ⚠ avec un indice — autorisez-les aussi dans les réglages DSH (Subagents → model selection), sinon les agents qui les nomment explicitement seront refusés et retomberont sur le dispatch implicite.

   ![Pools de dispatch](docs/assets/conf-demo2.png)

5. **Classement et watermark** — l'ordre de la table de classement est l'ordre de capacité (le plus fort d'abord), avec des tiers S/A/B/C optionnels ; le mode d'exécution est `off` / advice / enforce (enforce = les modèles hors pool sont rejetés). En dessous, la section watermark resserre le comportement selon la consommation de tokens : trois seuils, un budget de lecture par appel, le comportement du mode hard (cap / deny), un interrupteur de remise automatique et un plafond séparé pour les sous-agents. La ligne du bas porte les commandes : `/ctx-pause` pour cesser d'intervenir · `/ctx-resume` pour reprendre · `/ctx-handover` pour sauvegarder et passer le relais maintenant (il conduit la session jusqu'à la limite d'inactivité et attend la fenêtre de relance de la compaction, donc le résultat peut prendre quelques minutes).

   ![Classement et watermark du contexte](docs/assets/conf-demo3.png)

6. **Vérifier** — le badge ⚡ apparaît à côté de la puce de preset dans l'en-tête de n'importe quelle session ; demandez au modèle “que dit la dernière section de ton system prompt ?” — il devrait mentionner la doctrine dsh-switchman.

**Configuration unique de db-query** (les dépendances du script vivent dans le répertoire du skill) :

```bash
bash <install-dir>/skills/db-query/scripts/setup.sh
```

## Fonctionnement

- La partie Host (`index.js` + `host/`) injecte trois sections dynamiques dans le system prompt, les gardes de budget de lecture et d'enforce, la capture automatique des réponses et quatre commandes slash — outre le trio ctx, `/vision`, qui résout les images collées en chemins de fichiers hôtes pour lecture par le pool vision. Tous les réglages sont des champs volatils — les changements enregistrés s'appliquent au prochain assemblage de prompt, sans redémarrage.
- La partie Client (`client.js`) rend le badge ⚡ à côté de la puce de preset ainsi que la page de réglages, via les services officiels de formulaires de réglages.
- La barre latérale de la page d'accueil gagne sa propre entrée **Switchman** à côté de la ligne Skills Center ; un clic ouvre cette même page de réglages (langues, pools et classement, watermark) en panneau central. La section de réglages et le badge ⚡ restent en place.
- `cordis.patch.yml` reprend textuellement la liste de plugins de chaque preset livré et n'étend que le suffixe de persona ; les outils Agent Teams eux-mêmes viennent toujours du `@deepseek-ai/dsh-experimental-agent-team-profile` livré.

## Maintenance

- Après une mise à niveau de DSH qui modifie les listes de plugins des presets livrés, resynchronisez `cordis.patch.yml` depuis les nouveaux `presets/*.patch.yml` (gardez le suffixe de doctrine), puis réinstallez.
- Les lignes de protocole destinées au modèle (`[SWITCHMAN:LANG|POOLS|WATERMARK]`) sont volontairement en anglais et stables à l'octet — ne les localisez pas.
- `npm pack --dry-run` doit rester à la forme auditée de 34 fichiers / ~111 kB (les captures d'écran de `docs/` ne partent jamais).

## Licence

MIT
