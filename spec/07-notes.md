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

> **Dossier `raw/` parasite — ✅ corrigé (nettoyage vestige, feedback tests).**
> Un vault pouvait contenir un **`raw/`** (souvent `raw/audios/`) **en plus** de
> `alfred-raw/`. Origine : **ancien défaut** du dossier d'enregistrement =
> `raw/audios` (spec/11, avant `alfred-raw`) — le code actuel n'y écrit plus rien,
> il subsistait dans les **vaults réutilisés** d'une version antérieure (supprimer
> l'app ne vide pas le vault). `migrate_legacy_raw_folder`/`migrate_legacy_todo_file`
> (`notes/vault.rs`) : déplace le contenu de `raw/` (aplati, y compris
> `raw/audios/`) dans `alfred-raw/`, supprime les dossiers vidés, **sans jamais
> écraser en cas de collision de nom** (suffixe `_2`/`_3`…) ; idem pour l'ancien
> `wiki/Todo.md` → l'emplacement configuré, seulement si absent. Branché dans
> `scaffold_vault` (idempotent) et **rejoué à chaque lancement de l'app** pour un
> vault déjà connu (pas seulement à la sélection explicite du dossier) — sinon un
> utilisateur déjà configuré avant cette migration ne la déclencherait jamais.

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

**Vue Projets — repliée par défaut (feedback tests).** La transcription
appariée n'est plus affichée en permanence en retrait sous le compte-rendu :
un **chevron** (▶/▼, `FileTree.tsx::ProjectNoteRow`) la déplie/replie à la
demande — une seule ligne par entrée par défaut, comme dans la vue Dossiers.
Sans transcription appariée, pas de chevron (ligne simple, comportement
inchangé).

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
- **`Contexte Alfred.md` exclue des Récents — ✅ corrigé (feedback tests, spec/16)** :
  `finalize_ingestion` auto-écrit les `context_additions` acceptés dans cette
  note quasiment à chaque ingestion (avec ou sans clarifications), avançant sa
  mtime presque systématiquement — elle passait donc TOUJOURS devant le
  compte-rendu qu'on venait réellement de produire, alors que c'est une note
  qu'on « ne devrait quasiment jamais rouvrir ». `list_recent_notes` gagne un
  paramètre `exclude_path` (résolu via `context_note_path`), appliqué par
  `get_recent_notes` (Récents) **et** `generate_daily_brief` (spec/05).
- **Nommage : sujet après ingestion, plus la date** — une fois l'intelligence faite,
  le **compte-rendu est nommé par un sujet court** (nom de réunion / description),
  **pas** par la date. L'IA fournit ce titre : ajouter un champ **`titre`** (sujet
  court) à `submit_ingestion` (spec/05) → nom de fichier du compte-rendu. La
  **transcription brute** garde son nom daté (`AAAA-MM-JJ HHhMM`) — c'est l'artefact
  brut, daté volontairement tant qu'il n'est pas qualifié ; elle reste identifiable
  par son **icône** et par sa **paire** avec le compte-rendu nommé. Effet de bord
  bienvenu : un compte-rendu nommé par sujet **ne collisionne plus** avec la
  transcription datée (cf. graphe, spec/07c).

## Indicateur « à vérifier » sur la note — ✅ fait (feedback tests, spec/17)

Quand une transcription a des **clarifications en attente** (analyse `/resolve` non
encore validée, spec/17), la note le **montre directement** — pas seulement via
la pop-up basse (transitoire, perdue si on enchaîne un enregistrement) :

- **Petite icône « à vérifier »** (`MdFactCheck`) à côté de la transcription
  concernée dans l'arbre (vue Dossiers, `FileTreeNode.tsx`) **et** dans Récents
  (`App.tsx`). Alimentée par l'état **persistant** des clarifications par
  `recording_id` (spec/17, table `pending_clarifications`).
- **Cliquer l'icône ouvre `/resolve`** directement avec l'analyse **déjà faite**
  (persistée, `resolveStore.loadPersisted`) — **pas** de nouvelle ingestion. (Le
  bouton « Vérifier / corriger » reste pour relancer volontairement une analyse.)
- L'icône **persiste jusqu'à validation** ; elle disparaît quand l'utilisateur a
  validé (→ finalisation + archivage de la transcription).
- **Non couvert** : la vue **Projects** de l'arbre n'affiche pas l'icône (seules
  la vue Dossiers et Récents la portent).

## UI Notes (3 panneaux)

`[Sidebar] | [Arbre fichiers] | [Contenu]`
- **Arbre** : dossiers + `.md`, fichiers cachés ignorés, tri dossiers puis alpha.
- **Contenu** : Preview (`react-markdown`) / Edit (CodeMirror 6), panneau
  Properties (frontmatter), auto-save.
- **Nouvelle note** (bouton de l'arbre) : créée dans le dossier de config
  **`new_note_folder`** (relatif au vault, **défaut `alfred-raw`** ; le dossier
  est créé au besoin). Paramétrable dans Réglages → Notes (spec/11).
  *(Corrige l'ancien `raw/` codé en dur, d'avant le renommage `alfred-raw`.)*

(Design conservé de l'ancienne spec ; restylage avec spec 10.)

### Archivage des notes & « Afficher les archives » — ✅ fait

Une **note de transcription brute** (`alfred-raw/`) n'a d'intérêt que le temps d'en
tirer un compte-rendu. On l'**archive automatiquement** une fois l'intelligence
faite, pour ne pas encombrer la navigation :

- **Archivage auto de la transcription** : dès que le **compte-rendu** est écrit
  dans `run_ingestion_core` (spec/05) — donc après la vérification/correction
  éventuelle (`/resolve`, spec/17) puisque c'est elle qui débouche sur l'ingestion
  finale (`finalize_ingestion`) — la note **brute de transcription** (retrouvée
  par `recording_id` sous `alfred-raw/`, `vault::archive_raw_note_by_recording_id`)
  passe **`status: archived`** (frontmatter). Le **compte-rendu**
  (`alfred-intelligence/`), lui, **reste `active`**. Le WAV reste dans
  `alfred-raw/` (ré-écoute / ré-ingestion, spec/04). Rien n'est supprimé — juste
  un changement de statut. Best-effort : une erreur ici ne fait jamais échouer
  l'ingestion (déjà réussie sur son travail principal).
- **Cas du CONTEXTE — ✅ corrigé (feedback tests)** : la transcription brute d'un
  enregistrement **de contexte** (visite guidée / « recréer mon contexte », spec/13,
  `purpose: "context"`) n'était **jamais archivée** — l'archivage n'était branché
  que sur `run_ingestion_core` (compte-rendu), or le contexte passe par
  `build_context_from_transcription` (pas de compte-rendu). `build_context_from_transcription`
  appelle désormais `archive_raw_note_by_recording_id` dès que la construction du
  contexte réussit — même mécanisme que l'ingestion. La note `Contexte Alfred.md`
  elle-même reste évidemment `active`.
- **Masquage par défaut** : les notes `status: archived` sont **masquées** de
  **l'arbre Notes** (`VaultNode.status`, filtré côté front) *et* des **Récents**
  (spec/10 — filtrées côté backend, `list_recent_notes`, avant la troncature au
  nombre affiché) — elles ne polluent plus la navigation.
- **Bouton « Afficher les archives »** (page Notes) : **toggle**
  qui révèle les notes archivées (dans l'arbre) ; re-cliqué, les remasque. État
  visuel « archivé » distinct (estompé + badge). L'utilisateur peut
  **désarchiver** une note (repasser `active`) depuis Properties (champ `status`
  existant, déjà fonctionnel).

> **Cohérence** : l'archivage étant un simple `status` frontmatter (déjà dans
> `NoteMetadata`), il reste **compatible Obsidian** et réversible.

#### Corrections UI — ✅ fait (feedback tests)

1. **Le toggle « archives » n'est plus un 3ᵉ bouton du sélecteur de vue.** Il était
   collé à **Folders / Projects** (une 3ᵉ case dans le même segmented control) — ce
   n'était pas le bon endroit (ça mélangeait « choix de vue » et « filtre »). Le
   sélecteur ne garde que **Folders** et **Projects** ; **« Afficher les archives »**
   vit maintenant en **pied de l'arbre** — présent et identique dans les DEUX vues.
2. **UI identique Folders ↔ Projects** : même toggle, même comportement, même
   estompé + badge sur une note archivée révélée (`FileTreeNode`/`ProjectNoteRow`).
3. **La vue Projects masque désormais aussi les archivées par défaut.** Le bug
   (`showArchived` appliqué à `filterArchived(tree)` mais pas à `projectGroups`) est
   corrigé : `ProjectNote` gagne un champ `status` (`list_notes_with_project`,
   backend) et `projectGroups` filtre sur ce champ avant tout regroupement/
   appariement — une transcription archivée d'une paire ne s'affiche que si le
   toggle est **on**.

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

### Gestion des dossiers — clic droit (créer / renommer / supprimer) — ✅ fait

Commandes Tauri dédiées (`notes/vault.rs`) : `create_folder(parent, name)`
(collision → suffixe numéroté, comme `create_note_file`), `rename_folder`
(refuse si le nom cible existe déjà), `delete_folder` (`remove_dir_all`,
confirmation `window.confirm` côté UI car un dossier peut contenir des notes).

Menu contextuel dossier réellement affiché (`FileTreeNode.tsx` — le bug où le
popup ne se rendait que dans la branche fichier est corrigé) : **Nouveau
dossier / Renommer / Supprimer**. Entrée « Nouveau dossier » aussi dans
l'en-tête de l'arbre (racine du vault), à côté du **+** qui ne crée qu'une note.

**Glisser-déposer interne** (même MIME `text/alfred-note-path` que le drop sur
un groupe de projet) : glisser une **note** sur un **dossier** de l'arbre la
déplace dedans (`move_note_file`, collision → suffixe numéroté) ; déposer sur
le vide de l'arbre la remonte à la racine du vault.

### Glisser-déposer de fichiers externes — Hors v1 (décision produit)

Le seul glisser-déposer existant est **interne** (déplacer une note dans
l'arbre, ou vers un groupe de projet — MIME custom `text/alfred-note-path`).
Glisser un fichier depuis le Finder/l'Explorateur (PDF, image, document) dans
l'arbre ou le contenu de Notes ne fait **rien** : aucun handler
`dataTransfer.files`, et `dragDropEnabled: false` (tauri.conf.json, nécessaire
au DnD HTML5 du Kanban) désactive aussi le drag&drop natif de fichiers OS au
niveau du webview. **Décision (feedback tests) : volontairement pas fait pour
la v1** — à rouvrir plus tard si besoin (restera à concevoir : où le fichier
atterrit — copié dans le vault ? pièce jointe d'une note ? — et comment
réconcilier avec `dragDropEnabled: false`).

### Nom du dossier des transcriptions brutes — 📝 décision ouverte

`alfred-raw` est le nom par défaut actuel (`recording_folder`, spec/11) mais
n'a jamais été validé comme définitif produit — à rouvrir si un nom plus
parlant pour l'utilisateur final est souhaité (ex. reflétant mieux « brut/non
retravaillé » qu'un terme technique). Renommer implique une migration des
vaults existants (dossier physique déjà créé chez les utilisateurs en test) —
en tenir compte dans la décision.

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
