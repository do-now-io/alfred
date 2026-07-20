# spec/07 — Notes (vault Markdown)

> **Statut v1 :** le vault est la source de vérité ; structure `alfred-*` ;
> aucun fichier technique Alfred (skills / `.claude`) dans le vault.

## Architecture

Toutes les notes sont des fichiers `.md` dans un **vault** choisi par
l'utilisateur (config `notes_vault_path`). Compatible Obsidian. SQLite ne stocke
plus de notes — la table `notes` est **legacy** (migration uniquement).

## Structure cible du vault

```
<vault>/
├── Contexte Alfred.md     # contexte interne (entreprise, équipe, vocabulaire — spec 16/17)
├── alfred-raw/            # transcriptions brutes + audio (1 note + 1 .wav par enregistrement)
└── alfred-intelligence/   # comptes-rendus générés par l'IA (frontmatter riche)
    └── Todo.md            # source de vérité des todos (spec 06)
```

- **`Contexte Alfred.md`** (racine, chemin configurable `context_note_path`) :
  rédigé par l'utilisateur, créé lazy avec template (spec/16). Injecté dans
  l'ingestion (spec/05) et source du glossaire Whisper (spec/17).
- **Note brute d'enregistrement** créée après transcription (spec/04),
  frontmatter `for_recording` + corps `# Transcription`.

- ✅ Défauts alignés : `recording_folder` → `alfred-raw` (spec/11), compte-rendus
  IA → `alfred-intelligence/{titre}.md`, todos → `alfred-intelligence/Todo.md`
  (spec/05, spec/06). Reste : frontmatter riche sur la note brute elle-même
  (`alfred-raw/`, aujourd'hui sans frontmatter) et le regroupement par `project`.
- **Aucun fichier technique Alfred dans le vault** (pas de `.claude/`, pas de
  skill, pas de `CLAUDE.md`) — les prompts vivent dans l'app.
- Notes legacy SQLite exportées vers `{vault}/Legacy/` au 1er démarrage
  (`migrate_sqlite_to_vault`).

## Format de fichier — frontmatter

```markdown
---
title: Réunion client - Acme
date: 2026-06-11
tags: [travail, client]
type: meeting        # note | meeting | task
status: active       # active | archived
project: [Acme, Interne]   # LISTE — une note peut relever de plusieurs projets
participants: [Jean, Marie]
recording_id: uuid   # notes vocales
---
# corps Markdown…
```

Champs `NoteMetadata` : `title, date, tags[], type, status, recording_id` **+
`project` et `participants` (ajoutés en v1)**. Le parser est un **sous-ensemble
YAML maison** (ligne à ligne) ; l'ajout de `project` / `participants` étend
struct + parser + serializer.

> **`project` est une LISTE** (feedback tests, point multi-projet) : une réunion
> peut couvrir plusieurs projets → la note apparaît **sous chacun** dans la vue
> Projets, sans être découpée (une seule note = une seule réunion). Accepter aussi
> la forme scalaire à la lecture (rétro-compat), sérialiser en liste.

⚠️ Les notes créées par la transcription n'ont **pas** de frontmatter aujourd'hui
— à aligner (utiliser `NoteMetadata::for_recording`).

## Regroupement par projet (v1)

L'UI regroupe les notes par `project` (**dossiers virtuels**, sans déplacer les
fichiers). Le rangement physique par projet est **hors v1** (voir README #5).

### Comment le `project` est renseigné, et comment le corriger — ✅ fait (feedback tests)

Aujourd'hui `project` n'est écrit que **par l'IA** sur le **compte-rendu**
(champ de `submit_ingestion`, « seulement si clairement identifiable »). La
transcription brute n'en a pas → elle tombe dans « Sans projet », et **aucune UI**
ne permet de le corriger. On ajoute :

- **Champ « Projet » (et « Participants ») dans le panneau Properties** — combobox
  **multi-sélection** (une note peut relever de plusieurs projets) qui **liste les
  projets existants** du vault + **autocomplétion** + création d'un nouveau.
  Modifier la valeur ré-écrit le frontmatter (`update_note_file`) et regroupe la note
  immédiatement (sous **chacun** des projets).
- **Glisser-déposer** une note sur un groupe de projet dans l'arbre (vue Projets)
  → met à jour `project`. Déposer sur « Sans projet » vide le champ.
- **Backend** : `list_projects()` (valeurs `project` distinctes du vault, pour la
  combobox et l'autocomplétion) ; la mise à jour du projet passe par le frontmatter.

### Paire transcription ↔ compte-rendu — ✅ fait (feedback tests)

Un enregistrement produit **deux notes** liées par le même `recording_id` : la
**transcription brute** (`alfred-raw/`) et le **compte-rendu** (`alfred-intelligence/`).
Elles doivent être **regroupées comme une paire** dans les vues Notes (Projets **et**
Dossiers) : le compte-rendu porte le `project`, la transcription est affichée
**avec lui** (rattachée via `recording_id`), au lieu d'être isolée dans « Sans
projet ». Le lien `recording_id` sert aussi au graphe (spec/07c) et au nommage
(ci-dessous).

## Différenciation des types & nommage — ✅ fait (feedback tests)

Problème constaté : impossible de savoir **sans ouvrir** une note si c'est une
**transcription**, un **compte-rendu**, une **tâche** ou une note libre — surtout
dans le volet **Récents** (gauche), où seul le nom (souvent une date) s'affiche.

- **Icône de type à l'œil** — ✅ fait, glyphes **Material Design** (`react-icons/md`,
  `utils/noteType.tsx`) : SVG inline embarqué au build, donc identique sur
  Windows/macOS/Linux (aucune police d'icônes système). Une variante « feuille de
  document + glyphe interne » (SVG maison) a été essayée puis **abandonnée**
  (retour utilisateur : icônes trop petites/discrètes, trop semblables entre elles)
  — revenu aux glyphes Material, plus reconnaissables en petit format. Type dérivé
  du frontmatter `type` **et** du dossier, affiché dans l'**arbre** et les
  **Récents** :
  - **audio** (`alfred-raw/`, nom daté `AAAA-MM-JJ HHhMM` ou `recording_id`) →
    `MdGraphicEq` (forme d'onde) — transcription d'un enregistrement,
  - **note brute** (`alfred-raw/` sans enregistrement) → `MdSubject` (lignes),
  - **synthèse Alfred** (`alfred-intelligence/`, `type: meeting`) → `MdDescription`
    (document) — fichier généré par Alfred,
  - tâche (`type: task`, `Todo.md`) → `MdCheckBox`,
  - contexte (`Contexte Alfred.md`) → `MdContactPage`,
  - note libre → `MdStickyNote2`.
- **Récents plus lisibles** : icône de type + **nom** + **date/heure** en secondaire
  (pour distinguer deux enregistrements) plutôt que le seul nom.
- **Nommage : sujet après ingestion, plus la date** — une fois l'intelligence faite,
  le **compte-rendu est nommé par un sujet court** (nom de réunion / description),
  **pas** par la date. L'IA fournit ce titre : ajouter un champ **`titre`** (sujet
  court) à `submit_ingestion` (spec/05) → nom de fichier du compte-rendu. La
  **transcription brute** garde son nom daté (`AAAA-MM-JJ HHhMM`) — c'est l'artefact
  brut, daté volontairement tant qu'il n'est pas qualifié ; elle reste identifiable
  par son **icône** et par sa **paire** avec le compte-rendu nommé. Effet de bord
  bienvenu : un compte-rendu nommé par sujet **ne collisionne plus** avec la
  transcription datée (cf. graphe, spec/07c).

## UI Notes (3 panneaux)

`[Sidebar] | [Arbre fichiers] | [Contenu]`
- **Arbre** : dossiers + `.md`, fichiers cachés ignorés, tri dossiers puis alpha.
- **Contenu** : Preview (`react-markdown`) / Edit (CodeMirror 6), panneau
  Properties (frontmatter), auto-save.

(Design conservé de l'ancienne spec ; restylage avec spec 10.)

### Tags — liste des existants + autocomplétion — ✅ fait (feedback tests)

Le panneau Properties permet d'ajouter/supprimer des tags, mais **sans voir les
tags existants ni autocomplétion**. On ajoute :

- **Liste des tags existants** du vault (suggestions cliquables sous le champ) +
  **autocomplétion** au fil de la frappe (taper `te` propose `test`). Clic = ajout.
- Ajout / suppression restent libres ; taper un tag inédit le crée.
- **Backend** : `list_tags()` (tags distincts du vault ; `build_graph` collecte déjà
  les tags frontmatter + `#inline`, spec/07c — réutiliser la même extraction).

### Recherche dans la note ouverte — ✅ fait

Recherche **locale au fichier courant** (à ne pas confondre avec la recherche
plein-texte globale, hors v1 — spec/10) :

- **Ctrl/Cmd+F** ouvre le panneau de recherche CodeMirror (`@codemirror/search`)
  en haut de l'éditeur : occurrences surlignées, suivant/précédent (F3),
  remplacer, libellés en français. Échap ferme. Le raccourci marche même si le
  focus est ailleurs (arbre, propriétés) — listener global sur l'écran Notes.
- **Bouton loupe** dans la barre d'actions de la note (découvrabilité).
- Effet de bord assumé : l'écran `/resolve` réutilise le même éditeur →
  Ctrl/Cmd+F y est disponible quand l'éditeur a le focus.

## Commandes Tauri (réel)

`get_vault_tree`, `get_note_file`, `create_note_file`, `update_note_file`,
`delete_note_file`, `rename_note_file`, `get_recent_notes(limit)`,
`get_vault_path`, `set_vault_path`, `pick_vault_folder`.
(+ `get_vault_graph` → spec 07c.)
Ajoutées (feedback tests) : `list_projects()` (combobox/glisser-déposer projet),
`list_tags()` (autocomplétion tags).

## Notes récentes

`get_recent_notes` : tri par **mtime** (l'édition remonte une note ; la simple
lecture non).

## Hors v1 / plus tard

Rangement physique par projet, backlinks, recherche plein-texte (la barre de
recherche globale est retirée — voir spec 10).
