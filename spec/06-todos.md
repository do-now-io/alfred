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

- **Onglet Tâches** : ~~liste éditable~~ → **refonte en tableau Kanban** (ci-dessous).
- **Accueil « Alfred »** : bloc dépliable Prioritaire / En cours / À faire (spec 10).

## Refonte Kanban de la page Tâches — ✅ fait (feedback tests + demande utilisateurs)

La liste Markdown en lignes est peu lisible ; les tâches vivent mieux dans un
**tableau Kanban** (demande explicite d'utilisateurs). La source de vérité **reste
`Todo.md`** — le Kanban est une **vue** par-dessus, pas un nouveau stockage.

- **Colonnes = sections du fichier** : **Prioritaire · En cours · À faire ·
  Archivé** (Archivé repliable/masquable par défaut). Aucune nouvelle sémantique :
  une colonne = une section `##`.
- **Glisser-déposer** une carte d'une colonne à l'autre = **déplacer la tâche entre
  sections** (réécrit `Todo.md` en conservant `@responsable` / `📅 échéance` / l'état
  coché). Réordonner dans une colonne = ordre des lignes dans la section.
  → **Nouvelle commande `move_todo(id, section, position?)`** (les commandes
  actuelles ne savent que cocher / archiver / éditer, pas déplacer vers une section
  arbitraire).
- **Carte de tâche lisible** : titre + **puce responsable** (`@Prénom`, avec
  couleur/initiales) + **badge d'échéance** (`📅`, **coloré selon la proximité** :
  en retard / aujourd'hui / à venir) + case à cocher (fait). Case cochée = carte
  estompée / barrée, reste dans sa colonne.
- **Ajout rapide par colonne** (« + » en tête de colonne → `create_todo` dans la
  section correspondante) + **compteur** par colonne.
- **Filtres** (à confirmer) : par **responsable**, par **échéance** (en retard /
  cette semaine), éventuellement par **projet** (voir ci-dessous).

**Décisions ouvertes (à trancher)** :
- **Projet sur une tâche** : les tâches de `Todo.md` ne portent pas de projet
  aujourd'hui. Pour filtrer/colorer par projet, il faudrait un marqueur par tâche
  (ex. `+Projet` façon `@responsable`). À décider (utile mais élargit le format).
- **Priorité** : gérée uniquement par la colonne « Prioritaire », ou champ dédié ?
- **Réordonnancement fin** : conserver l'ordre dans le fichier suffit-il, ou faut-il
  un index explicite ?

Contrainte : tout doit rester **compatible Obsidian** (édition directe du fichier),
donc les enrichissements passent par des marqueurs inline simples, pas de
frontmatter par tâche.

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
