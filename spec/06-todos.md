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

> **Bug corrigé (feedback tests) :** le glisser-déposer ne fonctionnait pas — la
> cause n'était pas le câblage React (correct dès la 1ʳᵉ version) mais la config
> Tauri : `dragDropEnabled` (par défaut `true`) fait intercepter nativement tous
> les événements de drag par l'OS pour l'API `file-drop`, ce qui empêche le
> **HTML5 drag-and-drop du webview** de recevoir quoi que ce soit. Mis à
> `false` dans `tauri.conf.json` → corrige aussi le glisser-déposer de la vue
> Projets (spec/07). L'ouverture/dépliage de carte est fait (fiche tâche, cf.
> § Évolutions Tâches).

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
  estompée / barrée, reste dans sa colonne. Le **markdown inline** du titre est
  rendu, pas affiché brut (`**gras**`, `*italique*`, `` `code` ``, `~~barré~~`,
  wikilinks sans crochets) — helper partagé `utils/inlineMd` (aussi utilisé par
  le bloc tâches de l'accueil) ; la recherche texte matche le titre **sans** les
  marqueurs.
- **Ajout rapide par colonne** (« + » en tête de colonne → `create_todo` dans la
  section correspondante) + **compteur** par colonne.
- **Filtres** — ✅ faits : par **responsable**, par **échéance** (en retard /
  cette semaine) et par **projet**. La liste du filtre projet (et de
  l'autocomplétion de la fiche tâche) = **union** des projets du vault
  (`list_projects`, spec/07 — frontmatter des notes) et des marqueurs `+Projet`
  déjà posés sur des tâches : le filtre est visible dès que le vault connaît
  des projets, même si aucune tâche n'est encore taguée (avant, liste dérivée
  des seules tâches → filtre invisible tant que rien n'était tagué).
- **Recherche texte** — ✅ fait : champ « Rechercher… » à côté des filtres ;
  masque en direct les cartes dont ni le titre ni le responsable ne matchent
  (insensible à la casse et aux accents), toutes colonnes confondues. Se cumule
  aux autres filtres ; Échap vide le champ. C'est la recherche **locale à
  `Todo.md`** (la recherche globale reste hors v1, spec/10).

**Décisions tranchées** (2e passe, ci-dessous) :
- **Projet sur une tâche** : oui, marqueur `+Projet` (façon `@responsable`).
- **Priorité** : champ dédié `!haute`/`!moyenne`/`!basse`, en plus de la colonne
  « Prioritaire » (les deux coexistent — la colonne reste le tri principal, le champ
  sert au filtre/affichage).
- **Réordonnancement fin** : l'ordre des lignes dans le fichier suffit (pas d'index
  explicite) — `move_todo(id, section, position?)`.

Contrainte : tout doit rester **compatible Obsidian** (édition directe du fichier),
donc les enrichissements passent par des marqueurs inline simples, pas de
frontmatter par tâche.

## Évolutions Tâches — ✅ fait (feedback tests, 2e passe)

Le Kanban est enrichi sans jeter la lecture Markdown.

### Deux vues, même `Todo.md` — bascule sur la page Tâches — ✅ fait

- **Sélecteur Kanban / Markdown** en tête de la page Tâches. Les deux affichent le
  **même `Todo.md`** (source de vérité unique, la même liste `Todo[]` récupérée par
  `get_all_todos` alimente les deux rendus — pas un second parseur).
- **Vue Markdown** = la lecture en lignes, avec **sections repliables** (Prioritaire /
  En cours / À faire / Archivé, Archivé replié par défaut). C'est la vue « document ».
- **Vue Kanban** = colonnes.

### Fiche tâche (ouvrable depuis le Kanban ET la vue Markdown) — ✅ fait

Cliquer une tâche (carte Kanban ou ligne Markdown) ouvre une **fiche** (`TaskSheet.tsx`,
modale) présentant et éditant tout ce que la tâche porte :

- **Sous-puces libres** (`  - texte`) sous la ligne de tâche dans `Todo.md` (compatible
  Obsidian — indentation Markdown standard, pas de frontmatter).
- **Champs structurés inline** : **projet** (`+Projet`), **priorité** (`!haute` /
  `!moyenne` / `!basse`), **estimation** (`⏱2h`) — marqueurs inline simples,
  **filtrables** dans le Kanban (décision « projet/priorité par tâche » tranchée : oui).
- **Description longue** (`  > texte`, un paragraphe par ligne, bloc multi-lignes
  rattaché à la tâche).

Contrainte respectée : tout reste **compatible Obsidian** (marqueurs inline + sous-
puces indentées, pas de frontmatter par tâche ; l'identité reste le titre normalisé).
Édition en 2 chemins pour ne jamais écraser silencieusement un champ non affiché :
`update_todo` (legacy, 3 champs, préserve projet/priorité/estimation sur disque) et
`update_todo_fields` (fiche tâche, les 6 champs de ligne d'un coup ; la provenance
n'est **jamais** éditable — toujours relue du fichier et réappliquée).

### Provenance & contexte de la tâche — ✅ fait

- **Provenance = wikilink sur la ligne.** À l'ingestion (spec/05), la tâche générée
  reçoit un **`[[Compte-rendu source]]`** (nommé par sujet, spec/05/07) + la **date**
  sur sa ligne `Todo.md` (uniquement quand le compte-rendu est réellement écrit —
  pas de lien mort si l'utilisateur avait décoché « Compte-rendu », spec/03). Le
  **lien dans le graphe** (spec/07c) est automatique : `Todo.md` est un fichier du
  vault comme un autre, son wikilink est résolu par le mécanisme standard — aucun
  code dédié n'a été nécessaire. La fiche affiche **d'où / quand** vient la tâche +
  un lien « Voir dans le graphe » (`/graph?focus=<titre>`, centre et met en évidence
  le nœud une fois la simulation stabilisée).
- **Bouton « Rassembler le contexte pour cette tâche »** (dans la fiche) = **action IA
  à la demande** (`gather_task_context`, réutilise la boucle agentique du chat,
  spec/07b) : retrouve le compte-rendu source + les notes liées et **résume le
  contexte utile** pour réaliser la tâche. Jamais automatique, jamais persisté dans
  l'historique de conversation.

### Commandes — ✅ ajoutées

`move_todo` (Kanban). `get_all_todos` (Kanban + Markdown, tâches cochées/archivées
comprises). `update_todo_fields(id, {title, responsable, echeance, project, priority,
estimate})` (fiche tâche). `update_todo_block(id, notes[], description[])` (sous-puces
+ description). `gather_task_context(title, project?, source_note?) -> ChatResponse`
(action IA à la demande, spec/07b).

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
