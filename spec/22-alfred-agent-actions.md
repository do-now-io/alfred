# spec/22 — Alfred agentique (outils d'action)

> **Statut v1 : ✅ fait.** Étend la boucle de chat (spec/07b) : Alfred passe de
> **lecture seule** (`search_notes` + `read_note`) à un **agent capable d'agir**
> sur l'app. But (feedback tests) : *« pouvoir tout gérer par Alfred si
> besoin »*. Implémentation : `src-tauri/src/ai/agent_actions.rs` (nouveaux
> outils + `ProposedAction` + garde-fous chemins) + `ai/chat.rs` (boucle,
> system prompt, dispatch) + `confirm_agent_action` (commande) +
> `ChatPanel.tsx`/`chatStore.ts` (carte Appliquer/Annuler).

## Idée directrice

Le chat (`answer_question`, spec/07b) fait déjà du **tool-use** en boucle
(`MAX_TOOL_ITERATIONS`). On lui **ajoute des outils d'action** (mutations) à côté des
outils de lecture. Alfred peut alors créer/éditer/supprimer des notes, gérer les
tâches, éditer le contexte, supprimer les données de démo — en langage naturel.

Exemple qui échoue aujourd'hui : *« Delete all the test data »* → Alfred répond qu'il
ne peut que chercher/lire. Cible : il **archive** les notes/tâches de démo (voir
règle « suppression = archivage » ci-dessous) ; la **purge dure** reste le bouton
one-shot manuel (spec/13).

## Règle d'or : **Alfred ne supprime jamais pour de vrai — il ARCHIVE** (décidé)

Toute intention de « suppression » formulée à Alfred est **traduite en archivage**
(réversible), **jamais** en suppression de fichier :

- **Note** « supprime… » → `status: archived` (spec/07), récupérable.
- **Tâche** « supprime… » → déplacée en **`## Archivé`** (`dismiss_todo`, spec/06).
- **La suppression dure reste réservée à l'UI manuelle** (corbeille de Notes,
  bouton one-shot des données de démo) — **pas** exposée comme outil d'Alfred.
  Donc `delete_note_file` et `delete_starter_content` **ne sont PAS** dans la
  whitelist d'Alfred.

Conséquence : le risque d'une mauvaise interprétation de l'IA est **borné** (rien
d'irréversible), ce qui allège les confirmations (voir ci-dessous).

**Réutilisation, pas de nouveau stockage** : les outils appellent les **commandes
Tauri existantes** (mêmes chemins que l'UI) — le vault Markdown reste la source de
vérité, tout reste **compatible Obsidian**.

## Périmètre v1 (décidé, feedback tests)

Alfred peut agir sur **trois domaines** :

- **Notes** (spec/07) : `create_note_file`, `update_note_file` (corps + frontmatter :
  projet, tags, participants), `rename_note_file`, **archiver / désarchiver**
  (`status`). **Pas** de `delete_note_file` (règle d'or : archivage, pas suppression).
- **Tâches** (spec/06) : `create_todo`, `complete_todo` (→ Fait), `move_todo`
  (colonne), `dismiss_todo` (→ Archivé), `update_todo` (champs).
- **Contexte** (spec/13/16) : éditer `Contexte Alfred.md` (`update_note_file`).
  Les **données de démo** : Alfred peut les **archiver** (notes → `archived`,
  tâches → `Archivé`) ; la **purge dure** (`delete_starter_content`) reste le
  **bouton one-shot manuel** (spec/13), hors outils d'Alfred.

**Hors périmètre v1 (décidé)** : **Réglages & app** — changer la config (langue,
dossiers), déclencher un enregistrement/une ingestion, partager une note. Trop
sensible pour un premier jet ; à rouvrir plus tard (pilotage vocal complet).

## Garde-fou : confirmer les actions **en lot** et l'**écrasement** (décidé)

Puisqu'Alfred **ne supprime jamais pour de vrai** (tout est réversible : archivage,
édition de frontmatter), le besoin de confirmation est réduit — il reste utile pour
la **transparence** sur les gros gestes :

- **Actions non destructives et unitaires** (créer, éditer un champ, cocher une tâche,
  déplacer une tâche, ajouter un tag, **archiver UNE** note/tâche) → **appliquées
  directement** ; Alfred rend compte dans sa réponse.
- **Confirmation** (carte **Appliquer / Annuler** dans le chat) pour :
  - **opérations en LOT** (archiver / éditer **plusieurs** éléments d'un coup) — pour
    que l'utilisateur ne soit pas surpris (*« Archiver 12 notes du projet X ? »*),
  - **écrasement** massif d'un contenu existant (réécriture complète d'un corps de
    note, pas un ajout).
- **Lot = une seule confirmation** récapitulant les N éléments, pas N pop-ups.
- Annuler → l'action n'est pas exécutée et Alfred en est informé (il enchaîne / propose
  autre chose). Le protocole reprend l'esprit des cartes de `/resolve` (spec/17).

## Mécanique (tool-use)

- Les outils d'action sont exposés à Claude **en plus** de `search_notes`/`read_note`,
  dans la même boucle. Le **system prompt** décrit les outils, la **règle d'or**
  (« supprimer = archiver ») **et le protocole de confirmation** (un lot / un
  écrasement doit être **proposé**, pas exécuté d'office).
- **Deux temps pour lot / écrasement** : Claude émet une **intention** (nom d'outil +
  arguments + résumé lisible) → le front affiche la carte → sur **Appliquer**, la (les)
  commande(s) Tauri est appelée et le résultat renvoyé à Claude ; sur **Annuler**, on
  renvoie « refusé ».
- **Action unitaire non risquée** : exécution directe dans la boucle, résultat renvoyé.
- **Multi-étapes** : Alfred peut chaîner (ex. *« archive toutes les notes du projet
  X »* → `search_notes` puis archivage en lot **avec une confirmation groupée**).

## Garde-fous techniques

- **Whitelist d'outils** stricte (seuls les domaines du périmètre v1). Rien hors vault ;
  jamais de chemin absolu arbitraire — les outils opèrent sur des chemins **vault-relatifs** validés.
- **Idempotence** quand c'est possible ; les commandes réutilisées portent déjà leurs
  garde-fous (dédup todos, archivage réversible via `status`).
- **Tout est réversible** : Alfred n'expose **que** des actions réversibles
  (archivage, édition de frontmatter, déplacement de tâche). **Aucun outil de
  suppression dure** → pas de perte de données possible par l'IA.
- **Traçabilité** : chaque action appliquée est **résumée dans la réponse** d'Alfred
  (« ✓ 2 notes archivées, 1 déplacée en Archivé »).

## Commandes / événements

Aucune nouvelle commande de stockage : réutilise `create_note_file` /
`update_note_file` / `rename_note_file` **+ archivage via `status`** (spec/07),
`create_todo` / `complete_todo` / `move_todo` / `dismiss_todo` / `update_todo`
(spec/06). **N'expose PAS** `delete_note_file` ni `delete_starter_content`
(suppression dure = UI manuelle uniquement). À ajouter : le **contrat d'action
proposée** (intention lot/écrasement → carte de confirmation → exécution/annulation)
dans la boucle de chat (spec/07b) + le rafraîchissement UI (`notes-updated` /
`todos-updated`) après chaque mutation.

## Hors v1 / plus tard

Pilotage des **Réglages & app** (config, enregistrement, partage) ; corbeille /
undo explicite ; historique d'actions ; permissions par domaine paramétrables.

## Décisions d'implémentation (non tranchées par la 1ʳᵉ version de cette spec)

- **Pas de round-trip conversationnel pour la confirmation lot/écrasement**
  (décidé) : le back n'a qu'un cycle requête/réponse (pas de canal pour faire
  patienter Claude pendant que l'utilisateur clique). Sur détection d'un outil
  lot/écrasement, la boucle **s'arrête immédiatement** et renvoie une
  `ProposedAction` ; le front affiche une carte (esprit `/resolve`) et, sur
  « Appliquer », appelle **directement** `confirm_agent_action` — Claude n'est
  **jamais** informé du résultat (pas de nouvelle bulle « ✓ fait »). Plus
  simple, cohérent avec `/resolve` qui suit déjà ce schéma.
- **Chat aligné sur `app_language`** (décidé) : le system prompt et **tous**
  les schémas d'outils (existants `search_notes`/`read_note` compris, jamais
  traités par le correctif spec/05/17) suivent désormais `app_language` — même
  constat qu'ailleurs : un schéma tout-français tire Claude vers le FR même
  avec une bonne consigne. La langue de LA RÉPONSE reste inférée depuis la
  question (`language_instruction`, inchangé) : un chat vit dans les deux sens,
  contrairement au brief quotidien (spec/05, directive inconditionnelle).
- **Une seule proposition à la fois** : si Claude appelle un outil lot/
  écrasement, tout autre appel d'outil dans le même tour est ignoré (pas de
  fusion de plusieurs propositions dans une même carte).
- **Correctif de sécurité en passant** : `read_note` acceptait un chemin
  littéral absolu sans vérifier qu'il restait dans le coffre. Corrigé en
  réutilisant `agent_actions::resolve_note_path` (confinement vault) pour la
  lecture aussi, pas seulement pour les nouveaux outils d'écriture.
