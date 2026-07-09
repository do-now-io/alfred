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
project: Acme        # regroupement par projet
participants: [Jean, Marie]
recording_id: uuid   # notes vocales
---
# corps Markdown…
```

Champs `NoteMetadata` : `title, date, tags[], type, status, recording_id` **+
`project` et `participants` (ajoutés en v1)**. Le parser est un **sous-ensemble
YAML maison** (ligne à ligne) ; l'ajout de `project` / `participants` étend
struct + parser + serializer.

⚠️ Les notes créées par la transcription n'ont **pas** de frontmatter aujourd'hui
— à aligner (utiliser `NoteMetadata::for_recording`).

## Regroupement par projet (v1)

L'UI regroupe les notes par `project` (**dossiers virtuels**, sans déplacer les
fichiers). Le rangement physique par projet est **hors v1** (voir README #5).

## UI Notes (3 panneaux)

`[Sidebar] | [Arbre fichiers] | [Contenu]`
- **Arbre** : dossiers + `.md`, fichiers cachés ignorés, tri dossiers puis alpha.
- **Contenu** : Preview (`react-markdown`) / Edit (CodeMirror 6), panneau
  Properties (frontmatter), auto-save.

(Design conservé de l'ancienne spec ; restylage avec spec 10.)

## Commandes Tauri (réel)

`get_vault_tree`, `get_note_file`, `create_note_file`, `update_note_file`,
`delete_note_file`, `rename_note_file`, `get_recent_notes(limit)`,
`get_vault_path`, `set_vault_path`, `pick_vault_folder`.
(+ `get_vault_graph` → spec 07c.)

## Notes récentes

`get_recent_notes` : tri par **mtime** (l'édition remonte une note ; la simple
lecture non).

## Hors v1 / plus tard

Rangement physique par projet, backlinks, recherche plein-texte (la barre de
recherche globale est retirée — voir spec 10).
