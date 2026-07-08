# spec/06 — Todos

> **Statut v1 :** refonte — la source de vérité passe de SQLite au **vault**.
> **Écriture dans Todo.md déjà faite côté ingestion** (spec/05, écriture double
> transitoire) ; **la lecture reste SQLite** — les commandes `get_todos` /
> `create_todo` / `complete_todo` / `dismiss_todo` / `update_todo` et l'écran
> Tâches n'ont pas encore basculé sur le fichier (cf. « Commandes Tauri »
> ci-dessous). Voir aussi [`../src-tauri/src/notes/todo_md.rs`](../src-tauri/src/notes/todo_md.rs)
> (parsing/merge du fichier, déjà écrit et testé).

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

## Commandes Tauri (à refondre vers le fichier)

`get_todos`, `create_todo`, `complete_todo`, `dismiss_todo`, `update_todo`
opèrent désormais sur `Todo.md` (parse Markdown ↔ structure) au lieu de la table
SQLite. `get_todo_file()` retourne le chemin du fichier.

## Hors v1 / plus tard

Sous-tâches, récurrence, rappels / notifications.
