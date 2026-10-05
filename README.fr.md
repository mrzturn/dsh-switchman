# dsh-switchman

[English](./README.md) | [简体中文](./README.zh.md) | [繁體中文](./README.zh-TW.md) | [日本語](./README.ja.md) | [한국어](./README.ko.md) | [Español](./README.es.md) | **Français** | [Deutsch](./README.de.md) | [Italiano](./README.it.md) | [Português](./README.pt.md) | [Русский](./README.ru.md)

> **La famille switchman**, même auteur, même orchestration : [opencode-switchman](https://github.com/mrzturn/opencode-switchman) (l'original OpenCode) · [zcode-switchman](https://github.com/mrzturn/zcode-switchman) (le portage ZCode) · **dsh-switchman** (ce dépôt, l'édition DeepSeek Harness).

![dsh-switchman — le niveau d'eau du contexte manie l'aiguillage et envoie chaque tâche sur la bonne voie](docs/assets/hero.svg)

> Le contexte sur un compteur. Les tâches se dispatchent seules.

## Pourquoi en avoir besoin

À force de travailler avec DSH, on finit par se heurter à deux problèmes : la session s'alourdit à mesure que la conversation s'étire — l'historique gonfle le contexte à des centaines de milliers de tokens, le modèle commence à oublier, à ralentir, à coûter cher, et le /compact manuel avale des détails à chaque compression ; et le modèle principal fait tout lui-même — retrouver un fichier, lancer un test, recouper des données, il mâche tout cela seul, lentement et à grands frais, alors que l'essentiel de ce travail gagnerait à être confié à un modèle bien moins cher.

dsh-switchman est un plugin pour [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH). Une fois installé, le modèle principal passe de « tout faire lui-même » au rôle de répartiteur : mesurer le niveau d'eau, choisir le couloir, distribuer les tâches, contrôler le résultat. Ce n'est pas un nouveau modèle — c'est une doctrine d'orchestration accrochée à DSH, accompagnée d'une page de réglages. Concrètement, il fait sept choses :

**1. Niveau d'eau du contexte : les longues sessions ne débordent jamais.** Chaque tour compte en direct les tokens de la session et les confronte à trois lignes d'eau qui durcissent par paliers : 50k (soft, réglable) rappelle qu'« il est temps de déléguer » ; 90k (hard) resserre le budget de lecture par appel et pousse à conclure ; 130k (force) déclenche la remise automatique — un fork de la session est archivé, le contexte compacté, la continuation réveillée, et la tâche ne s'interrompt jamais. Les subagents d'arrière-plan encore en course à cet instant ne sont pas perdus pour autant : leurs id, descriptions de tâche et chemins de rapport sont consignés dans le document de remise, et la session relancée sait où récupérer les rapports au lieu de redéspatcher en double. Chaque subagent dispatché embarque son propre plafond strict ; une fois atteint, il écrit son résumé HANDOFF et se retire. Quand l'intervention automatique ne vous convient pas, reprenez la main à tout moment : `/ctx-pause` arrête toutes les actions de niveau (la mesure continue, la bannière passe en paused — il n'agit plus, c'est tout), `/ctx-resume` rétablit à tout moment — après un redémarrage de DSH, l'intervention revient aussi d'elle-même, un lâcher-prise temporaire, pas une extinction définitive ; `/ctx-handover` n'attend pas que le niveau touche le plafond et déclenche à la demande la même remise : forker une sauvegarde, compacter le contexte, réveiller la continuation (la session est d'abord conduite jusqu'à la limite d'inactivité, le résultat peut donc prendre quelques minutes).

**2. Six pools de dispatch : le bon modèle pour chaque tâche.** Un pool léger (economy, les petites tâches en série), un pool mécanique (mechanical, les réécritures sur gabarit), un pool principal (main, le code au quotidien), un pool haute difficulté (hard, raisonnement corsé et refontes à grande échelle), un pool multimodal (vision, lire les images) et un pool de relecture (review, vérification indépendante). Dans la page de réglages, vous cochez les candidats, les classez par priorité (avec tiers S/A/B/C en option) et épinglez un effort de raisonnement pour chaque route — le menu déroulant des niveaux reflète ce que ce modèle supporte réellement, pas trois niveaux génériques. Chaque prompt du modèle principal embarque une table de recommandations `[SWITCHMAN:POOLS]`, et le dispatch suit cette table. Le mode d'exécution a trois états : off / advice / enforce (enforce = tout modèle hors pool est refusé sans appel).

**3. Mode Agent Teams : passer du solo à la direction d'une équipe.** Désactivé par défaut — juste après l'installation, on reste sur le dispatch subagent léger. Deux interrupteurs indépendants dans la page de réglages :

- **Mode équipe d'agents** — l'activer injecte la doctrine d'équipe (délégation par défaut + vérification par paliers + discipline du tableau de tâches partagé) et active automatiquement les Agent Teams de DSH : le modèle principal peut recruter des coéquipiers permanents (`spawn_teammate`), confier du travail au tableau de tâches partagé (`team_task_*`) et échanger des messages avec eux. Le moment de constituer une équipe obéit à une discipline explicite : sous-tâches indépendantes parallélisables, gros lots autoportants, contexte principal déjà bien chargé, besoin de séparer les rôles ; les enquêtes ponctuelles restent du ressort du subagent. Refermer l'interrupteur ne laisse aucun résidu des clauses d'équipe, et ne retire jamais les outils d'équipe aux sessions déjà en cours.
- **Synchronisation de la liste blanche des modèles de subagents** — DSH tient une liste d'autorisation « modèles qu'un agent peut choisir pour ses subagents » : une route cochée dans un pool mais jamais autorisée se voit refuser le dispatch quand le modèle principal la désigne nommément (en mode équipe, elle est marquée d'un ⚠). Activez cet interrupteur et l'union des six pools est d'un coup écrite dans cette liste — switchman reste l'unique source de vérité, fini la double configuration. La liste blanche s'applique par instantané à chaque nouvelle session : la synchronisation ne concerne que les sessions ouvertes ensuite.

L'en-tête de session donne un retour immédiat : un badge ⚡ « équipe autonome » et une puce ◇ indiquant le modèle réellement utilisé par la session ; pendant une remise automatique, une bannière en direct annonce « remise en cours · sauvegarde de la session / compactage du contexte / réveil de la continuation ».

**4. Préférences de langue : une question posée une fois, retenue pour toujours.** Un menu déroulant chacun pour les réponses, les commentaires de code et la documentation, avec un scope global ou par projet (`.switchman/lang.json`). Ne rien régler est permis — au premier besoin, on vous pose la question une fois dans la langue de votre interface DSH, la réponse est retenue, et chaque session suivante s'y conforme automatiquement.

**5. Langue de l'interface : le plugin parle votre langue aussi.** Tout en haut de la page de réglages, une nouvelle section « Interface » accueille un menu déroulant « Langue de l'interface » (clé de réglage `uiLocale`) : Auto (par défaut — suit la langue de l'appli DeepSeek Harness) ou n'importe quelle langue de l'interface du plugin, toujours affichée par son endonyme, jamais traduite. Elle ne bascule que l'interface du plugin lui-même — le badge d'en-tête, le panneau d'accueil et la page de réglages —, pas la langue de l'appli DSH : l'aperçu est immédiat, sans redémarrage ; l'enregistrement retient le choix ; le prochain démarrage le restaure ; tout échec retombe sur la langue de l'appli ; et tous les dictionnaires voyagent dans le bundle, sans téléchargement.

**6. Vérification par paliers : chaque modification est contrôlée.** Au-delà de 20 lignes modifiées, passage au testeur ; au-delà de 300 lignes, ou dès que l'on touche à la logique cœur / sécurité / cohérence des données, en plus un relecteur indépendant. Le modèle du relecteur est choisi pour éviter celui de « l'agent qui a écrit le diff », autant que les pools le permettent ; quand c'est vraiment impossible, la conclusion le déclare DOWNGRADED. Dites « pas d'équipes » et il repasse aussitôt en solo.

**7. `/vision` : même un modèle purement textuel peut travailler avec des images.** Quand le modèle principal ne sait pas lire les images, DSH refuse les messages avec image dès l'entrée. Collez l'image, tapez `/vision où est l'erreur sur cette image`, et l'image est confiée à un modèle du pool multimodal pour lecture ; les conclusions reviennent dans la session courante. Un avertissement apparaît tôt au-dessus du champ de saisie — « le modèle courant ne sait pas lire les images » ; si un envoi d'image ordinaire est refusé, le brouillon est réécrit une fois en `/vision` et renvoyé tout seul, sans rien retaper ; sans pool multimodal configuré, la commande refuse et donne les indications de configuration.

Un seul modèle ? Ça vaut quand même l'installation — le contrôle du niveau d'eau et la vérification par paliers se moquent du nombre de modèles, et une longue session mono-modèle en profite tout autant.

## Skills incluses

- **db-query** — vérification MySQL / Redis en lecture seule : exécuter du SQL pour recouper les enregistrements, contrôler les clés de cache / TTL et la cohérence entre stores ; refuse toute écriture. Initialisation au premier usage (voir ci-dessous).
- **git-commit-message** — produit un texte de commit conforme aux conventions. Du texte seulement ; il ne lance jamais git à votre place.
- **requirement-docs** — une spécification unifiée pour l'analyse des besoins / PRD / documents de conception, avec archivage dans `docs/requirements-and-design/`.

## Démarrage rapide

1. **Installer** — depuis n'importe quelle session d'agent, ou depuis la page de gestion des plugins Web :

   ```
   plugin_manager: install_bundle  target=dsh-switchman
   ```

   ou depuis un checkout local (en lien ; après mise à jour, refaire `remove_bundle` + `install_bundle`) :

   ```
   plugin_manager: install_bundle  target=/path/to/dsh-switchman
   ```

   ou depuis un terminal avec la commande `dsh` — choisissez le profil correspondant à votre façon d'exécuter DSH :

   ```bash
   dsh plugin --profile web add dsh-switchman      # Web GUI
   dsh plugin --profile desktop add dsh-switchman   # appli desktop
   ```

2. **Redémarrer DSH** — quittez complètement l'application puis rouvrez-la (recharger la page ne suffit pas) pour que la table des modules client reconnaisse le bundle.

3. **Configurer** — Réglages → dsh-switchman, ou « Centre de contrôle Switchman » dans la barre latérale de la page d'accueil. Tout tient sur une seule page ; la voici — un passage de haut en bas et c'est réglé :

   ![Vue complète de la page de réglages de dsh-switchman : langue de l'interface, préférences de langue, six pools de dispatch, classement des capacités et mode d'exécution, interrupteurs d'équipe, niveau d'eau du contexte et commandes](docs/assets/conf-interface-fr.png)

   - **Interface** — la langue de l'interface du plugin lui-même. Sur la capture, « Français » est sélectionné : c'est l'aperçu immédiat, toute la page bascule sur-le-champ ; par défaut, « Auto » suit la langue de l'appli DSH. Le choix est retenu à l'enregistrement, et on peut repasser sur « Auto » à tout moment.
   - **Langue** — la langue de ce que produit l'agent. Le scope de la capture est « Global (ce profil) » (possible aussi par projet, chacun lit son `.switchman/lang.json`) ; les trois menus déroulants réponses / commentaires de code / documentation sont tous fixés sur « Français (fr) », chacun suivi d'une ligne d'état « actuel : … ». Tout laisser vide se fait sans douleur : une question posée une fois au premier usage, puis retenue.
   - **Pools de dispatch** — six cartes sur deux rangées de trois : en haut léger / mécanique / principal ; en bas haute difficulté / multimodal / révision. Chaque carte coche les modèles candidats groupés par fournisseur ; cochez « ordre manuel » et elle devient une liste de priorités numérotée, à réordonner avec ↑ ↓ × ; chaque route peut épingler un effort de raisonnement (par défaut « suivre le couloir »). La ligne de résumé en haut se met à jour en direct ; sur la capture : « 4/6 pools configurés · 2 classés · mode advice ».
   - **Classement des capacités + mode d'exécution** — l'union des modèles cochés dans les six pools, classée par capacité, les plus forts devant (sur la capture glm-5.3 ancré S et glm-5.3-flash ancré A) ; on peut réordonner et retirer ; le mode d'exécution va de advice / enforce (enforce = tout modèle hors pool est refusé sans appel).
   - **Équipe d'agents** — les deux interrupteurs, mode équipe et synchronisation de la liste blanche, arrivent désactivés ; sur la capture ils sont activés, avec sous chacun une ligne d'état de synchronisation.
   - **Niveau d'eau du contexte** — les trois seuils (sur la capture 50000 / 90000 / 130000), le budget de lecture par appel (1500), le comportement du palier hard (passage à débit limité / blocage), l'interrupteur de remise automatique et le plafond indépendant des subagents : tout tient dans cette zone. La ligne du bas porte les commandes : `/ctx-pause` suspend les interventions · `/ctx-resume` reprend · `/ctx-handover` sauvegarde et remet immédiatement (il conduit la session jusqu'à une limite d'inactivité avant de compacter — le résultat peut prendre quelques minutes).

4. **Vérifier** — un badge ⚡ « équipe autonome » apparaît dans l'en-tête de session (avec à côté une puce ◇ montrant le modèle de la session en cours) ; ou demandez simplement au modèle « quel est le titre du dernier paragraphe de ton prompt système » — la réponse doit mentionner la doctrine dsh-switchman.

**Initialisation de db-query au premier usage** (les dépendances du script s'installent dans le répertoire du skill — votre projet reste propre) :

```bash
bash <install-dir>/skills/db-query/scripts/setup.sh
```

## Fonctionnement

- La partie Host (`index.js` + `host/`) injecte les sections dynamiques du prompt système (langue / couloirs / niveau d'eau / équipes), les deux verrous budget de lecture et enforce, et les quatre commandes slash (le trio ctx + `/vision`). Tout réglage enregistré prend effet au prochain assemblage de prompt — sans redémarrage.
- La partie Client (`client.js`) rend la page de réglages, le badge ⚡ et la puce ◇ du modèle dans l'en-tête de session, ainsi que la bannière dynamique « remise en cours » ; les instantanés de configuration se lisent et s'écrivent via la famille de routes Host.
- L'entrée « Centre de contrôle Switchman » dans la barre latérale de la page d'accueil ouvre en un clic, sous forme de panneau central, cette même page de configuration ; l'entrée de réglages d'origine reste en place.
- `cordis.patch.yml` reprend intégralement la liste de plugins des presets d'usine et n'étend que le persona suffix ; les outils Agent Teams eux-mêmes viennent du bundle d'usine et s'activent automatiquement quand le mode équipe est allumé.

## Maintenance

- Si une mise à niveau de DSH change la liste de plugins des presets d'usine, resynchronisez `cordis.patch.yml` depuis les nouveaux `presets/*.patch.yml` (conservez le doctrine suffix), puis réinstallez.
- Les lignes de protocole (`[SWITCHMAN:LANG|POOLS|WATERMARK|TEAMS]`) restent volontairement en anglais et stables à l'octet — ne les localisez pas.
- `npm pack --dry-run` doit conserver la forme auditée de 50 fichiers / ~205 kB (les captures d'écran de `docs/` ne partent pas dans le paquet).

## License

MIT
