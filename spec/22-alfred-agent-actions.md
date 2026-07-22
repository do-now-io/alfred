# spec/22 — Alfred agentique (outils d'action)

> **Statut v1 :** 📝 spec à créer, **rien de codé**. Étend la boucle de chat
> (spec/07b) : Alfred passe de **lecture seule** (`search_notes` + `read_note`) à un
> **agent capable d'agir** sur l'app. But (feedback tests) : *« pouvoir tout gérer
> par Alfred si besoin »*.

## Idée directrice

Le chat (`answer_question`, spec/07b) fait déjà du **tool-use** en boucle
(`MAX_TOOL_ITERATIONS`). On lui **ajoute des outils d'action** (mutations) à côté des
outils de lecture. Alfred peut alors créer/éditer/supprimer des notes, gérer les
tâches, éditer le contexte, supprimer les données de démo — en langage naturel.

Exemple qui échoue aujourd'hui : *« Delete all the test data »* → Alfred répond qu'il
ne peut que chercher/lire. Cible : il appelle `delete_starter_content` (après
confirmation, car destructif).

**Réutilisation, pas de nouveau stockage** : les outils appellent les **commandes
Tauri existantes** (mêmes chemins que l'UI) — le vault Markdown reste la source de
vérité, tout reste **compatible Obsidian**.

## Périmètre v1 (décidé, feedback tests)

Alfred peut agir sur **trois domaines** :

- **Notes** (spec/07) : `create_note_file`, `update_note_file` (corps + frontmatter :
  projet, tags, participants), `rename_note_file`, `delete_note_file`, **archiver**
  (passer `status: archived` / désarchiver).
- **Tâches** (spec/06) : `create_todo`, `complete_todo` (→ Fait), `move_todo`
  (colonne), `dismiss_todo` (→ Archivé), `update_todo` (champs).
- **Contexte & données de démo** (spec/13/16) : éditer `Contexte Alfred.md`
  (`update_note_file`), **`delete_starter_content`** (données de démo).

**Hors périmètre v1 (décidé)** : **Réglages & app** — changer la config (langue,
dossiers), déclencher un enregistrement/une ingestion, partager une note. Trop
sensible pour un premier jet ; à rouvrir plus tard (pilotage vocal complet).

## Garde-fou : confirmer **uniquement** le destructif (décidé)

- **Actions non destructives** (créer, éditer un champ, cocher une tâche, déplacer une
  tâche, ajouter un tag, archiver **une** note) → **appliquées directement** par
  Alfred, qui rend compte dans sa réponse.
- **Actions destructives** → **carte de confirmation** dans le fil de chat
  (**Appliquer / Annuler**) **avant** exécution. Sont destructives :
  - **suppression** (`delete_note_file`, `delete_starter_content`),
  - **écrasement** massif d'un contenu existant (réécriture complète du corps, pas un
    ajout),
  - **opérations en lot** (supprimer/archiver **plusieurs** éléments d'un coup).
- **Lot = une seule confirmation** récapitulant les N éléments (ex. *« Supprimer les
  données de démo : 2 notes, 4 tâches, 1 conversation ? »*), pas N pop-ups.
- Annuler → l'action n'est pas exécutée et Alfred en est informé (il enchaîne / propose
  autre chose). Le protocole reprend l'esprit des cartes de `/resolve` (spec/17).

## Mécanique (tool-use)

- Les outils d'action sont exposés à Claude **en plus** de `search_notes`/`read_note`,
  dans la même boucle. Le **system prompt** décrit les outils **et le protocole de
  confirmation** (une action destructive doit être **proposée**, pas exécutée d'office).
- **Deux temps pour le destructif** : Claude émet une **intention** d'action
  destructive (nom d'outil + arguments + résumé lisible) → le front affiche la carte
  de confirmation → sur **Appliquer**, la commande Tauri est appelée et le résultat
  renvoyé à Claude (qui confirme à l'utilisateur) ; sur **Annuler**, on renvoie « refusé ».
- **Non destructif** : exécution directe dans la boucle, résultat renvoyé à Claude.
- **Multi-étapes** : Alfred peut chaîner (ex. *« archive toutes les notes du projet
  X »* → `search_notes` puis archivage en lot **avec une confirmation groupée**).

## Garde-fous techniques

- **Whitelist d'outils** stricte (seuls les domaines du périmètre v1). Rien hors vault ;
  jamais de chemin absolu arbitraire — les outils opèrent sur des chemins **vault-relatifs** validés.
- **Idempotence** quand c'est possible ; les commandes réutilisées portent déjà leurs
  garde-fous (dédup todos, archivage réversible via `status`).
- **Réversibilité** : archivage et édition de frontmatter sont réversibles (Obsidian) ;
  la **suppression** de fichier ne l'est pas → c'est précisément pourquoi elle est
  **confirmée** (option « corbeille » plutôt que suppression dure = à considérer, hors
  périmètre strict).
- **Traçabilité** : chaque action appliquée est **résumée dans la réponse** d'Alfred
  (« ✓ 2 notes archivées, 1 supprimée »).

## Commandes / événements

Aucune nouvelle commande de stockage : réutilise `create_note_file` /
`update_note_file` / `rename_note_file` / `delete_note_file` (spec/07),
`create_todo` / `complete_todo` / `move_todo` / `dismiss_todo` / `update_todo`
(spec/06), `delete_starter_content` (spec/13). À ajouter : le **contrat d'action
proposée** (intention destructive → carte de confirmation → exécution/annulation)
dans la boucle de chat (spec/07b) + le rafraîchissement UI (`notes-updated` /
`todos-updated`) après chaque mutation.

## Hors v1 / plus tard

Pilotage des **Réglages & app** (config, enregistrement, partage) ; corbeille /
undo explicite ; historique d'actions ; permissions par domaine paramétrables.
