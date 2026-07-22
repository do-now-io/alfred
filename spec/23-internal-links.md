# spec/23 — Liens internes & navigation (audit)

> **Statut v1 : ✅ fait.** Gestionnaire de lien unique (`useInternalLink`,
> `src/utils/useInternalLink.ts`) + schéma `task:` + section « Tâches »
> cliquable dans le compte-rendu + toast d'échec de résolution. Détail dans
> chaque section ci-dessous. **Non couvert** (voir fin de fichier) : repli sur
> le titre frontmatter pour la résolution `wikilink:`, alignement du graphe.

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

## Périmètre de l'audit (surfaces à couvrir) — ✅ fait

Le clic navigue correctement depuis : **preview de note** (compte-rendu) et **brief**
(`BriefingContent`/`onNavigate`), **carte Kanban** + **fiche tâche** + **lignes de
brief** (`renderInlineMd`/`onNavigate`, `Dashboard.tsx`/`Tasks.tsx`). **Sources citées
du chat** et **Récents** : déjà corrects avant cette spec (navigation par **chemin
réel**, pas par résolution de wikilink) — vérifiés, non réécrits. **Le graphe** : déjà
correct de la même façon (`selectFile(node.path)`) — **non aligné** sur
`useInternalLink` (pas nécessaire, déjà fonctionnel, cf. `Graph.tsx?focus=<label>`
dont le pattern a d'ailleurs servi de modèle à `/tasks?focus=<id>` ci-dessous).

## Robustesse de résolution

- **note/transcription** : nom de fichier **insensible casse/accents** — ✅ fait
  (`findNodeByRef`, `notesStore.ts`). **Repli sur le titre frontmatter — non fait** :
  `VaultNode` ne porte pas le titre frontmatter (seulement `status`/`recording_id`,
  spec/07/17) ; l'ajouter demanderait un nouveau champ + une nouvelle lecture par
  fichier. Gap connu, pas bloquant (la résolution par nom de fichier couvre le cas
  courant : compte-rendu nommé par sujet et note brute datée sont chacun retrouvés
  par leur propre nom).
- **tâche** : titre **normalisé** — ✅ fait, mais **sans réimplémentation JS** de la
  règle de normalisation (spec/06) : les liens `task:` sont **toujours générés
  côté Rust** (section « Tâches » du compte-rendu) avec l'identité exacte
  (`todo_md::normalize_title`) déjà utilisée comme `Todo.id` — une égalité stricte
  côté front suffit donc, tâche cochée/déplacée/archivée comprise (elle garde son
  id). Un `task:` tapé à la main avec une casse/normalisation différente de celle du
  titre réel ne résoudra pas — cas marginal, non couvert.

## Implémentation

- **Gestionnaire unique** : `src/utils/useInternalLink.ts` (hook `useInternalLink`)
  — `wikilink:<ref>` → `openNoteByRef` → `/notes` ; `task:<ref>` →
  `/tasks?focus=<ref>` ; `http(s)://` → `plugin-shell` ; sinon → toast.
- **`task:` scheme** : généré côté Rust (`run_ingestion_core`, section « Tâches »/
  « Tasks », localisée comme « Points clés ») via `urlencoding::encode(&normalize_title(titre))`
  — seulement quand les tâches sont réellement écrites (`tasks: true`), pour ne
  jamais poser un lien mort. Consommé côté front dans `Tasks.tsx` (`?focus=`) :
  réinitialise les filtres actifs qui cacheraient la carte, dévoile la colonne
  Archivé si besoin, scroll + halo bref (2,5 s, même pattern que `Graph.tsx?focus=`).
  Tâche introuvable (supprimée) → toast.
- **`renderInlineMd`** (`src/utils/inlineMd.tsx`) accepte un 2ᵉ paramètre optionnel
  `onNavigate` — les `[[wikilinks]]` et `[texte](url)` deviennent des `<button>`
  cliquables (au lieu des spans morts historiques) ; sans `onNavigate`, rendu
  inchangé (pas de régression pour un appelant non mis à jour, si un futur ajoute
  un 3e call site en oubliant de le brancher).
- **`BriefingContent`** : prop renommée `onWikilink` → `onNavigate` (reçoit le href
  complet, schéma compris) — le câblage DOM impératif délègue tout, y compris
  `http(s)`, au handler plutôt que de dupliquer sa propre logique. `urlTransform`
  whitelist désormais `task:` en plus de `wikilink:` (sinon react-markdown le
  strippe comme protocole inconnu).
- **Toast** : `src/store/toastStore.ts` + `src/components/Toast.tsx`, monté une
  fois dans `App.tsx`. Message unique (pas de file), auto-masqué après 3,5 s.
- **Consolidation** : les 3 câblages dupliqués (`Dashboard.tsx`/`ChatPanel.tsx`/
  `TaskSheet.tsx`, chacun avec son propre `openNoteByRef` + `navigate` inline)
  remplacés par `useInternalLink()`.

## Hors v1 / plus tard

Backlinks (« notes qui pointent ici »), aperçu au survol d'un lien, liens vers un
**bloc/ancre** précis d'une note.
