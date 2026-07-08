# spec/06 — Todos

> **Statut v1 :** ✅ fait — `Todo.md` est la **seule** source de vérité. La table
> SQLite `todos` est **supprimée** (migration `007_drop_todos`), la double
> écriture de l'ingestion retirée. Toutes les commandes opèrent sur le fichier
> ([`../src-tauri/src/notes/todo_md.rs`](../src-tauri/src/notes/todo_md.rs) pour
> le parsing/mutations, [`../src-tauri/src/todos/mod.rs`](../src-tauri/src/todos/mod.rs)
> pour l'orchestration). Identité d'une tâche = **titre normalisé** (unique dans
> le fichier par la règle de dédup — pas d'id stocké).

## Principe

La **source de vérité des todos = un fichier Markdown du vault** :
`alfred-intelligence/Todo.md` (chemin en config `todo_file_path` ; défaut
historique `wiki/Todo.md` → à migrer vers `alfred-intelligence/Todo.md`).

La **table SQLite `todos` est abandonnée**. Les commandes actuelles écrivent en
SQLite → à refondre pour lire/écrire le fichier. Pas de migration de données
(aucun utilisateur en prod).

## Format du fichier

Compatible Obsidian (cases à cocher standard), regroupé par sections qui
correspondent à l'accueil, **sans frontmatter** :

```markdown
## Prioritaire
- [ ] Rappeler le client Acme — @Jean — 📅 2026-07-10

## En cours
- [ ] Préparer la démo

## À faire
- [ ] Relire le contrat

## Archivé
- [ ] Ancienne tâche mise de côté
```

- `[x]` = tâche **faite** (reste en place, cochée).
- Responsable (`@Prénom`) et échéance (`📅 YYYY-MM-DD`) optionnels.
- Les tâches **extraites par l'IA** arrivent dans `## À faire` ; c'est
  l'utilisateur qui les remonte en « En cours » / « Prioritaire ».

## Provenance

- **Extraction IA** (depuis une transcription, spec 05) : ajoute les tâches
  détectées au fichier, en rappelant le prénom du responsable quand c'est possible.
- **Création manuelle** depuis l'UI (onglet Tâches / accueil).
- **Édition directe** du fichier dans Obsidian — Alfred relit le fichier.

## Déduplication

Par **titre normalisé** (minuscules, espaces réduits), sur **tout le fichier** :
on ne ré-ajoute pas une tâche déjà présente. *(L'ancienne dédup SQLite par
`title_hash` était du code mort.)*

## Cycle de vie

- Cocher `[x]` = **fait** (la ligne reste en place, cochée).
- **Archiver** (ex-« ignorer ») : la tâche est **déplacée** vers la section
  `## Archivé` en bas du fichier — **rien n'est supprimé**.

## Affichage

- **Onglet Tâches** : liste éditable.
- **Accueil « Alfred »** : bloc dépliable Prioritaire / En cours / À faire (spec 10).

## Commandes Tauri — ✅ refondues vers le fichier

`get_todos` (non cochées hors Archivé), `create_todo` (ajout dédupliqué dans
`## À faire`), `complete_todo(id, checked?)` (coche/décoche **en place**),
`dismiss_todo` (déplace vers `## Archivé`), `update_todo` (réécrit
titre/@responsable/📅échéance en gardant place et état) — toutes sur `Todo.md`.
`get_todo_file()` retourne le chemin du fichier. `id` = titre normalisé.
Note : l'écran Tâches et le bloc Accueil éditent déjà le fichier directement
(NoteEditor / update_note_file) — ces commandes servent l'IA (brief, briefing
d'événement) et tout futur usage programmatique.

## Hors v1 / plus tard

Sous-tâches, récurrence, rappels / notifications.
