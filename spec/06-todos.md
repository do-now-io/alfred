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
correspondent aux colonnes du Kanban, **sans frontmatter**. Depuis que la vue
Markdown de l'onglet Tâches a été retirée (redondante avec l'écran Notes, qui
affiche ce même fichier tel quel — le bouton « Markdown » n'est plus qu'un
raccourci pour l'ouvrir là), la structure du fichier lui-même porte le
regroupement **statut → projet → priorité** :

```markdown
## À faire
### Atlas
- [ ] Préparer la démo — !haute
- [ ] Relire le contrat — !basse

### Sans projet
- [ ] Tâche libre

## En cours

## Fait
- [x] Rappeler le client Acme — @Jean — 📅 2026-07-10

## Archivé
- [ ] Ancienne tâche mise de côté
```

> **Sections ✅ fait : `À faire` → `En cours` → `Fait` → `Archivé`.** La section
> **`Prioritaire` est retirée** ; la section **`Fait`** matérialise le statut
> « done ». Ordre = ordre des colonnes Kanban.

- **`[x]` ⇔ section `Fait`** : une tâche cochée **vit dans `## Fait`**. Cocher une
  tâche la **déplace** vers `Fait` ; la décocher la renvoie vers `## À faire`.
  (Fini le « `[x]` reste en place » — cocher et « colonne Fait » sont **une seule et
  même notion**.) Glisser-déposer une carte dans la colonne `Fait` coche
  pareillement ; l'en sortir (vers une colonne de travail, pas `Archivé`) décoche.
- **Regroupement par projet — ✅ fait** : au sein de chaque section, les tâches
  sont regroupées par `+Projet` sous un en-tête **`### Projet`** (ordre
  alphabétique, **« Sans projet » toujours en dernier**), puis **triées par
  priorité** à l'intérieur d'un groupe (`!haute` en haut). **Ces en-têtes `###`
  sont entièrement dérivés** du marqueur `+Projet` de chaque ligne — jamais la
  source de vérité — et donc **régénérés à chaque écriture** : un en-tête
  fantaisiste ou déplacé à la main dans Obsidian sans changer le marqueur de
  la ligne est corrigé au prochain passage. **Pas d'en-tête** quand une section
  ne contient qu'un seul groupe (y compris si tout est « Sans projet ») — la
  structure ne s'affiche que quand elle apporte de l'info.
- **Priorité** : uniquement le champ inline **`!haute` / `!moyenne` / `!basse`**
  (plus de colonne dédiée). Sert au tri (fichier **et** Kanban) et au filtre.
- Responsable (`@Prénom`), échéance (`📅 YYYY-MM-DD`), projet (`+Projet`),
  estimation (`⏱`) optionnels.
- Les tâches **extraites par l'IA** arrivent dans `## À faire` ; l'utilisateur les
  fait avancer vers `En cours` puis `Fait`.

> **Migration des fichiers existants — ✅ fait**, auto-appliquée + persistée à
> la première lecture (`get_todos`/`get_all_todos`) : `## Prioritaire` →
> fusionner dans `## À faire` (les tâches y gardent leur `!priorité` si
> posée) ; les tâches `[x]` qui traînaient **cochées dans d'autres sections**
> → déplacer vers `## Fait` (celles déjà dans `## Archivé` **restent**
> archivées) ; regroupement par projet/priorité appliqué dans la même passe.
> Idempotent.

## Provenance

- **Extraction IA** (depuis une transcription, spec 05) : ajoute les tâches
  détectées au fichier, en rappelant le prénom du responsable quand c'est
  possible, **et le projet de la réunion en marqueur `+Projet`** (le premier
  projet identifié par l'ingestion — celui du frontmatter du compte-rendu —
  quand la réunion en touche plusieurs, la ligne ne portant qu'un marqueur).
  Les tâches extraites sont ainsi filtrables par projet dans le Kanban sans
  tagage manuel.
- **Création manuelle** depuis l'UI (onglet Tâches / accueil).
- **Édition directe** du fichier dans Obsidian — Alfred relit le fichier.

## Déduplication

Par **titre normalisé** (minuscules, espaces réduits), sur **tout le fichier** :
on ne ré-ajoute pas une tâche déjà présente. *(L'ancienne dédup SQLite par
`title_hash` était du code mort.)*

## Cycle de vie

- **Avancement** : `À faire` → `En cours` → `Fait` (glisser-déposer Kanban ou
  `move_todo`). **Cocher `[x]` = passer en `Fait`** (déplacement, pas juste un
  marqueur en place) ; **décocher** = renvoyer en `À faire`.
- **Archiver** (ex-« ignorer ») : la tâche est **déplacée** vers `## Archivé` en
  bas du fichier — **rien n'est supprimé**. `Archivé` reste distinct de `Fait`
  (une tâche abandonnée ou rangée, cochée ou non).

## Affichage

- **Onglet Tâches** : **tableau Kanban** (ci-dessous) uniquement. Le bouton
  « Markdown » n'est **plus une 2e vue** (retiré — redondante avec l'écran
  Notes, qui affiche déjà ce même fichier tel quel) : c'est un **raccourci**
  qui ouvre `Todo.md` dans Notes (`selectFile` + navigation).
- **Accueil « Alfred »** : bloc dépliable — sections **À faire / En cours** (spec 10 ;
  plus de « Prioritaire »).

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

- **Colonnes = sections du fichier** — 📝 **nouvel ordre (feedback tests)** :
  **À faire · En cours · Fait · Archivé** (Archivé repliable/masquable par défaut).
  **`Prioritaire` retirée** ; **`Fait` ajoutée** (statut « done »). Une colonne =
  une section `##`.
- **Glisser-déposer** une carte d'une colonne à l'autre = **déplacer la tâche entre
  sections** (réécrit `Todo.md` en conservant `@responsable` / `📅 échéance` /
  `+Projet` / `!priorité`). Réordonner dans une colonne = ordre des lignes.
  **Déposer dans `Fait` coche la tâche (`[x]`)** ; l'en sortir la décoche —
  cohérent avec « `[x]` ⇔ `Fait` » (§Format). → commande `move_todo(id, section,
  position?)` (existe).
- **Tri par priorité dans chaque colonne** (📝 feedback tests) : à l'affichage,
  ordonner les cartes d'une colonne par `!priorité` (**haute** en haut, puis
  moyenne, basse, sans priorité). Le tri est **visuel** ; l'ordre dans le fichier
  reste la source (pas de réécriture forcée juste pour trier).
- **Carte de tâche lisible** : titre + **puce responsable** (`@Prénom`, avec
  couleur/initiales) + **badge d'échéance** (`📅`, **coloré selon la proximité** :
  en retard / aujourd'hui / à venir) + case à cocher (**cochée ⇒ la carte est en
  colonne `Fait`**, estompée / barrée). Le **markdown inline** du titre est
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
- **Priorité** : champ inline `!haute`/`!moyenne`/`!basse` — **seul** vecteur de
  priorité depuis le retrait de la colonne « Prioritaire » (feedback tests) ; sert au
  **filtre** et au **tri intra-colonne** (haute en haut).
- **Réordonnancement fin** : l'ordre des lignes dans le fichier suffit (pas d'index
  explicite) — `move_todo(id, section, position?)`.

Contrainte : tout doit rester **compatible Obsidian** (édition directe du fichier),
donc les enrichissements passent par des marqueurs inline simples, pas de
frontmatter par tâche.

## Évolutions Tâches — ✅ fait (feedback tests, 2e passe)

### Une seule vue Kanban — la lecture « document » se fait dans Notes — ✅ fait

Il y avait initialement une 2e vue Markdown propre à l'onglet Tâches (lecture en
lignes, sections repliables). **Retirée** : elle dupliquait ce que l'écran Notes
affiche déjà pour n'importe quel fichier, avec son propre éditeur (recherche,
wikilinks, aperçu markdown live). Le bouton « Markdown » de la page Tâches est
maintenant un simple **raccourci** — `selectFile(vaultPath + todoRel)` puis
navigation vers `/notes` — pas une vue de plus à maintenir en double. Le Kanban
reste la seule vue de la page Tâches ; l'accès en lecture/édition Markdown brute
se fait dans Notes, qui affiche le fichier tel qu'il est réellement structuré
(voir §Format du fichier — statut → projet → priorité).

### Fiche tâche (ouvrable depuis le Kanban) — ✅ fait

Cliquer une tâche (carte Kanban) ouvre une **fiche** (`TaskSheet.tsx`,
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
`## À faire`), `complete_todo(id, checked?)` — 📝 **à ajuster (feedback tests)** :
cocher **déplace vers `## Fait`**, décocher renvoie vers `## À faire` (n'est plus un
coche « en place ») ; `dismiss_todo` (déplace vers `## Archivé`), `move_todo(id,
section, position?)` (déplacement Kanban ; déposer dans `Fait` coche, en sortir
décoche), `update_todo` (réécrit titre/@responsable/📅échéance en gardant place et
état) — toutes sur `Todo.md`.
`get_todo_file()` retourne le chemin du fichier. `id` = titre normalisé.
Note : l'écran Tâches et le bloc Accueil éditent déjà le fichier directement
(NoteEditor / update_note_file) — ces commandes servent l'IA (brief, briefing
d'événement) et tout futur usage programmatique.

## Hors v1 / plus tard

Sous-tâches, récurrence, rappels / notifications.
