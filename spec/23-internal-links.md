# spec/23 — Liens internes & navigation (audit)

> **Statut v1 :** 📝 spec à créer, **rien de codé** (audit + refonte). Constat test :
> les liens **s'affichent bien** (titres stylés, sans crochets) mais **ne naviguent
> pas** — clic sans effet entre notes ↔ tâches ↔ transcription.

## Constat (2 chemins, dont un mort)

- **Preview de note & brief** (`react-markdown` + `BriefingContent`) : les
  `[[wikilinks]]` sont **cliquables** — `wikilink:` scheme → `openNoteByRef` →
  `findNodeByRef` (résolution par nom de fichier). Marche **note → note**, mais
  **échoue** si la cible n'est pas un fichier (une **tâche**) ou si le nom ne
  correspond pas.
- **Tâches** (`renderInlineMd` — cartes Kanban, fiche tâche, lignes de brief) : les
  wikilinks sont rendus en **span coloré NON cliquable** (commentaire du code :
  *« navigation has no target here »*) → **tous** les liens depuis/vers une tâche
  sont **morts**. **C'est la 2ᵉ passe annoncée** dans `inlineMd.tsx`.

Point structurel : **une tâche n'est pas un fichier** (ligne de `Todo.md`) → un
`[[lien]]` vers une tâche **ne peut pas** se résoudre comme une note. Il faut un
**schéma de lien propre aux tâches**.

## Types de liens & résolution (cible)

| Lien | Source(s) | Résolution | Ouvre |
|---|---|---|---|
| **note → note / transcription** | preview note, brief, chat | `wikilink:<ref>` → `openNoteByRef` (nom de fichier, insensible casse/accents ; repli titre frontmatter) | la note dans **Notes** |
| **tâche → note / transcription** (provenance) | carte Kanban, fiche tâche, ligne Markdown | idem `wikilink:` (rendre **cliquable** dans `renderInlineMd`) | la note dans **Notes** |
| **→ tâche** (depuis compte-rendu, ou n'importe où) | compte-rendu, chat | **nouveau schéma `task:<titre normalisé>`** | **page Tâches (Kanban)**, carte **surlignée / scrollée** (décidé — pas la fiche, pas `Todo.md`) |

- **Résolution tâche** : par **titre normalisé** (l'identité d'une tâche, spec/06) dans
  `Todo.md`. Le clic navigue vers `/tasks`, sélectionne la colonne de la tâche et
  **met en évidence** la carte (scroll + halo bref).
- **Échec de résolution = feedback visible** : si un `wikilink:`/`task:` ne trouve
  pas sa cible, **ne pas rester silencieux** (le bug actuel « clic → rien ») →
  petit toast « Cible introuvable » (souvent un renommage : la cible existe sous un
  autre nom). Aide au diagnostic plutôt qu'un clic mort.

## Compte-rendu → tâches (décidé : oui, les lister)

L'ingestion (spec/05) ajoute dans le **corps du compte-rendu** une section
**« Tâches » / « Tasks »** (localisée, spec/21) listant les tâches générées, chacune
avec un **lien profond `task:`** cliquable → ouvre la tâche dans le Kanban. Complète
le lien **inverse** déjà posé (provenance tâche → `[[compte-rendu]]`, spec/05/06) :
la paire devient **navigable dans les deux sens**, et le graphe (spec/07c) reste
cohérent.

## Un seul gestionnaire de lien partagé

Aujourd'hui la navigation est **dupliquée** (câblage DOM ad hoc dans `BriefingContent`,
rien dans `renderInlineMd`). Centraliser :

- Un **handler unique** `handleInternalLink(href)` :
  - `wikilink:<ref>` → `openNoteByRef(ref)` → **Notes** ;
  - `task:<titre>` → **Tâches** + surbrillance ;
  - `http(s)://` → ouverture externe (`plugin-shell`) ;
  - sinon → toast « lien non reconnu ».
- **`renderInlineMd` prend un `onNavigate`** (aujourd'hui rendu pur, spans morts) →
  ses `[[wikilinks]]` et `task:` deviennent des éléments **cliquables** appelant le
  handler. Utilisé par : cartes Kanban, fiche tâche, lignes de brief.
- Même handler branché sur la **preview de note** (`react-markdown`), le **brief**,
  et les **sources du chat** (spec/07b) → comportement identique partout.

## Périmètre de l'audit (surfaces à couvrir)

Vérifier que le clic navigue correctement depuis : **preview de note** (compte-rendu),
**brief** (accueil), **carte Kanban** + **fiche tâche** + **vue Markdown des tâches**,
**sources citées du chat**, **Récents**. (Le **graphe** ouvre déjà un nœud → aligner
sur le même handler si besoin.)

## Robustesse de résolution

- **note/transcription** : nom de fichier **insensible casse/accents**, repli sur le
  **titre frontmatter** ; gérer le compte-rendu **nommé par sujet** (spec/07) et la
  **note brute datée** — les deux doivent être atteignables par leur wikilink respectif.
- **tâche** : titre **normalisé** (minuscule, espaces réduits — même règle que la
  dédup/identité `Todo.md`, spec/06) ; si la tâche a été cochée/déplacée/archivée,
  le lien la retrouve quand même (elle existe toujours dans le fichier).

## Hors v1 / plus tard

Backlinks (« notes qui pointent ici »), aperçu au survol d'un lien, liens vers un
**bloc/ancre** précis d'une note.
