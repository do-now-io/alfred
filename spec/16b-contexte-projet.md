# spec/16b — Contexte par projet (extension spec/16 & spec/17)

> **Statut :** ✅ construit. Post-v1. Étend le **contexte interne**
> (spec/16) et l'**ingestion augmentée** (spec/17 §3/§4) : introduit un **second
> niveau de contexte**, par projet, en plus du contexte global existant.

## Vue d'ensemble

Aujourd'hui, tous les faits appris automatiquement pendant une ingestion
(`context_addition`, spec/17 §3/§4) atterrissent dans **une seule note globale**
(`Contexte Alfred.md`). Ça mélange des infos long terme sur l'entreprise/l'utilisateur
avec des infos propres à un projet ou un client, qui n'ont rien à faire dans un
contexte censé rester stable.

**Nouveau modèle à deux niveaux :**

| Niveau | Note | Contenu | Fréquence de mise à jour |
|---|---|---|---|
| **Global** | `Contexte Alfred.md` (inchangée, spec/16) | Infos long terme (entreprise, poste, structure) + **vocabulaire/noms propres** (source du glossaire Whisper, spec/17 §1) | Rare — quasi figé après l'onboarding |
| **Projet** | `alfred-intelligence/<Projet>.md` (nouveau, une note par projet) | Tout ce qui concerne spécifiquement ce projet (tarifs, décisions, état, jargon, personnes impliquées…) | Fréquent — à chaque ingestion qui concerne ce projet |

Le vocabulaire (glossaire Whisper) **reste alimenté uniquement par le contexte
global** — pas de dérivation par projet (contrainte de taille de
`initial_prompt`, spec/17 §1). Un nom propre repéré dans une réunion mono-projet
continue de remonter au global, indépendamment du routage du fait qui
l'accompagne.

## 1. Détection du projet — dès l'analyse

Le champ `project` (frontmatter du compte-rendu, spec/07) n'est aujourd'hui
inféré par Claude qu'à la **finalisation** (`submit_ingestion`). Il doit
désormais être connu (proposé) dès l'**analyse** (`analyze_transcription`,
spec/17 §3), pour pouvoir router les `context_addition` au bon moment.

- `analyze_tool` (schéma du tool d'analyse) gagne un champ **`projects_detected:
  string[]`** — les projets que Claude identifie dans la transcription, à
  partir du vocabulaire/noms déjà connus (glossaire, contexte projet
  existant) ou de nouveaux noms de projet explicitement mentionnés.
- Peut être **vide** (aucun projet identifié) ou contenir **plusieurs**
  entrées (réunion qui touche plusieurs projets — ex. un changement de tarif
  d'infogérance impactant deux clients).

### Nouveau champ sur `/resolve` : « Projets concernés »

- **Premier champ** de l'écran `/resolve` (au-dessus des clarifications
  existantes) : **multi-select** parmi les projets existants (`list_projects`)
  **+** option « Nouveau projet » (texte libre → créé au moment de la
  validation).
- Pré-rempli avec `projects_detected`, éditable par l'utilisateur (ajouter,
  retirer, créer).
- **Devient la source de vérité** du `project` écrit sur le compte-rendu à la
  finalisation — remplace l'inférence actuelle de `submit_ingestion` pour ce
  champ (Claude peut toujours le proposer en pré-remplissage, mais le
  validé humain prime).

> **Point d'attention — conflit avec le seuillage de `/resolve` (spec/17,
> "`/resolve` seulement s'il y a quelque chose à vérifier").** Aujourd'hui,
> sans `transcription_fix`/`unclear_sentence`/`unassigned_task`, `/resolve`
> est **sauté** et la finalisation se fait directement. Si on force l'écran à
> chaque fois pour confirmer les projets, on réintroduit la friction qu'on
> vient de retirer.
>
> **Décision par défaut proposée (à valider avant implémentation) :** ne pas
> forcer l'affichage de `/resolve` seulement pour la confirmation de projet.
> S'il n'y a **aucune autre clarification**, les `projects_detected` de
> Claude sont **auto-appliqués** tels quels (routage du contexte + frontmatter
> `project` compris) ; l'utilisateur peut corriger après coup via le champ
> Projet existant (Properties, spec/07 — combobox multi-projet déjà en place).
> `/resolve` ne s'affiche pour ce champ que quand il s'affiche **déjà** pour
> une autre raison (clarifications présentes).

## 2. Deux critères dans l'analyse

`context_addition` (spec/17 §3) gagne un champ **`scope: "global" | "project"`**
et, si `scope: "project"`, un champ **`projects: string[]`** (sous-ensemble de
`projects_detected` — un même fait peut cibler plusieurs projets, ex. une
hausse de tarif d'infogérance commune à deux clients).

- **`scope: "global"`** — case explicite « ceci concerne le contexte général,
  pas un projet » côté modèle (pas une inférence implicite). Réservé aux
  faits **durables et non liés à un projet précis** : rôle/poste de
  l'utilisateur, structure de l'entreprise, ce qu'elle fait — le critère
  **resserré** existant (spec/17 §3) ne change pas pour ce niveau.
- **`scope: "project"`** — critère **plus permissif** : tarifs, décisions,
  état du projet, personnes impliquées côté client, jargon spécifique au
  projet. Tout ce qui serait aujourd'hui classé « ponctuel » (donc exclu) au
  niveau global peut être **durable pour ce projet** (ex. « le tarif
  d'infogérance d'Acme est passé à 500€/mois » n'est pas utile dans 3 mois
  pour un *autre* projet, mais reste vrai et utile pour *celui-là* tant qu'il
  n'est pas re-changé).

Le champ `vocab_terms: string[]` (nouveau, indépendant de `context_addition`)
liste les **noms propres/termes techniques** repérés dans la transcription —
toujours candidats au **vocabulaire global**, quel que soit le(s) projet(s)
concerné(s) par la réunion.

## 3. Écriture (au moment de la finalisation / validation `/resolve`)

Pour chaque `context_addition` :

- **`scope: "global"`** → écrit dans `Contexte Alfred.md` § `## Appris
  automatiquement` (comportement inchangé, spec/17 §4).
- **`scope: "project"`** → pour chaque projet de `projects` qui est aussi dans
  les **« Projets concernés » confirmés** (intersection — un fait ne s'écrit
  jamais dans un projet que l'utilisateur a retiré de la liste) : écrit dans
  `alfred-intelligence/<Projet>.md`, dans la **section** identifiée par
  `section` (voir §4) — pas un unique bloc générique.
- **Si « Projets concernés » est vide** (aucun projet, ni détecté ni ajouté
  manuellement) → **aucun** `context_addition` à `scope: "project"` n'est
  enregistré (perdu, pas de repli sur le global). Les `scope: "global"` de
  cette même réunion s'écrivent normalement, indépendamment de ce vide.

Pour `vocab_terms` : toujours ajoutés (dédupliqués) à la section `##
Vocabulaire maison & noms propres` de `Contexte Alfred.md`, **quel que soit**
l'état de « Projets concernés » → déclenche la régénération debouncée du
glossaire (spec/17 §1, comportement inchangé).

## 4. La note de projet

- **Chemin** : `alfred-intelligence/<Projet>.md` — nom de projet passé au même
  sanitizer que les autres noms de fichiers (`sanitize_filename`, gère
  accents/`/`/`:`). Collision → suffixe, comme les autres notes.
- **Création automatique**, lazy, au premier fait qui la concerne (comme
  `ensure_context_note` pour le contexte global, spec/16) — ou en cliquant sur
  le nom du projet dans la vue Projets (§4bis).
- **Frontmatter** : marqueur `type: context` (+ `project: <Nom>`) pour être
  reconnue par le code — même mécanisme d'icône dédiée que `Contexte
  Alfred.md` (type/07), et **exclue des Récents** (`list_recent_notes` filtre
  sur `type: context`, plus large que l'ancien filtre par chemin unique).
- **Contenu — ✅ révisé (feedback tests, remplace la version « bloc unique »
  initiale) : 6 sections**, titres localisés FR/EN comme le contexte global
  (`notes::context::titles`) — pas les 4 sections « mon entreprise »/« équipe »
  du global (qui n'ont pas de sens à ce niveau), mais des sections pensées
  pour un projet :

  | Clé interne (stable) | FR | EN |
  |---|---|---|
  | `overview` | Aperçu | Overview |
  | `people` | Personnes | People |
  | `decisions` | Décisions | Decisions |
  | `events` | Événements | Events |
  | `tasks` | Tâches | Tasks |
  | `vocabulary` | Vocabulaire | Vocabulary |

  Chaque `context_addition` à `scope: "project"` porte un champ **`section`**
  (une de ces 6 clés, défaut `overview` si absent/invalide) que Claude
  remplit dès l'analyse (réunion, spec/17 §3) ou l'extraction e-mail
  (spec/24) — le fait est rangé dans la bonne section à l'écriture, jamais
  déversé dans un bloc unique. Append/dédup par section (même logique que
  `## Appris automatiquement` du contexte global). L'utilisateur peut éditer
  la note à la main comme n'importe quelle note du vault (y compris
  renommer/retirer une section — une section supprimée est recréée en fin de
  note si un nouveau fait doit y aller).

### Création rétroactive

À la **première** fois qu'un projet apparaît côté contexte (premier fait
`scope: "project"` validé pour un projet qui n'a pas encore de note, ou
premier clic sur son nom, §4bis), on ne part pas seulement de la réunion
courante : on **rescanne tous les comptes-rendus déjà tagués `project:
<Nom>`** (`list_notes_with_project`) pour construire la note en une fois — un
appel Claude dédié qui lit l'historique du projet et en extrait les faits
durables **déjà classés par section**, avant d'ajouter le fait qui vient de
déclencher la création.

> **Tranché à l'implémentation** : troncature à ~8 000 caractères
> d'historique (les comptes-rendus les plus récents en premier) — repli
> raisonnable pour les vaults de test (~10 utilisateurs), à resserrer si un
> cas réel dépasse ce budget.

## 4bis. Accès à la note & fusion de doublons (spec/07)

- **Clic sur le nom du projet** (en-tête de groupe, vue Projets, spec/07) →
  ouvre sa note de contexte unique (créée lazily si besoin, avec
  reconstruction rétroactive) — **« un seul fichier de contexte par projet,
  accessible en cliquant sur son nom »**. Le clic droit garde ses entrées
  existantes (« Voir l'état du projet », spec/28) et gagne **« Fusionner
  avec… »**.
- **Fusion manuelle de projets** (`merge_projects(source, target)`) —
  nettoyage des quasi-doublons qu'une extraction peut créer en inventant un
  nom légèrement différent d'un projet déjà connu (ex. « Energy Pool » /
  « EnergyPool - Analyse Projet », casse différente) : retague le frontmatter
  `project` de toutes les notes portant `source` vers `target`, fusionne les
  deux notes de contexte section par section (dédupliqué, la note `source`
  est supprimée), et renomme le marqueur `+Projet` de toutes les tâches
  `Todo.md` concernées. Action **explicite** (menu contextuel), **jamais**
  d'auto-fusion silencieuse — deux noms proches peuvent désigner deux projets
  réellement distincts, c'est à l'utilisateur de trancher.

## 4ter. Prévention à la source (extraction e-mail, spec/24)

Le nommage de projet par l'extraction e-mail (spec/24 §4, `EMAIL_BATCH_SYSTEM`)
reçoit désormais la **liste des projets déjà connus** (`list_projects`,
récupérée une fois par synchronisation) et une consigne explicite :
réutiliser EXACTEMENT un nom connu quand il correspond, ne pas en fabriquer
une variante (sous-titre, casse, synonyme) ; et **distinguer projet et
client** (un client peut porter plusieurs projets — ne pas les confondre dans
un même nom au gré du sujet du mail). Corrige la cause racine des doublons
observés (extraction sans aucun référent) ; la fusion manuelle (§4bis) reste
le filet de rattrapage pour ce qui est déjà créé ou pour les cas ambigus que
la prévention ne peut pas éliminer entièrement.

## 5. Dépendance — renommage de projet

`merge_projects` (§4bis) fait aussi office de renommage : `target` n'a pas
besoin d'exister déjà comme groupe — retagger `source` vers un nom entièrement
nouveau EST un renommage (la note de contexte suit, reconstruite si besoin).
Ce qui reste hors scope ici : une UI dédiée « renommer » (distincte de
« fusionner ») et la détection de collision/confirmation qu'un vrai outil de
renommage grand public voudrait (spec/07, ROADMAP Phase G) — `merge_projects`
est délibérément la même action des deux côtés (renommer = fusionner vers un
nom qui n'a pas encore de contenu).

## 6. Hors scope (différé)

- **Injection du contexte projet dans l'ingestion ou le chat** : pour l'instant,
  la note de projet est une mémoire lisible (vault normal, accessible via
  chat/RAG `ask_notes`, spec/07b) mais **n'est pas** injectée comme second
  bloc system à l'ingestion (contrainte de taille + pas encore nécessaire).
  Prépare le terrain pour « Projets unifiés » (ROADMAP Phase G, post-v1 plus
  lointain).
- **UI dédiée de gestion des contextes de projet** : pas de nouvel écran,
  juste des notes de vault comme les autres (visibles dans l'arbre/vue
  Projets, spec/07).

## Commandes Tauri à créer/modifier

| Commande | Rôle |
|---|---|
| `analyze_transcription` (modifiée) | schéma étendu : `projects_detected`, `context_additions[].scope`/`projects`/`section`, `vocab_terms` |
| `finalize_ingestion` (modifiée) | routage des `context_addition` par `scope`/`projects`/`section` vers la bonne note/section ; écrit `vocab_terms` dans le vocabulaire global ; `confirmed_projects` devient le `project` du compte-rendu |
| `open_project_context_note(project)` | lazy-create (+ reconstruction rétroactive si besoin) et ouvre la note — clic sur le nom du projet, vue Projets |
| `merge_projects(source, target)` | fusionne/renomme un projet (retag notes + `Todo.md` + fusion des notes de contexte section par section) |
| `list_recent_notes` (modifiée) | filtre sur `type: context` (global + projets), plus large que l'ancien filtre par chemin unique |
| `extract_email_batch` (modifiée, spec/24) | reçoit `known_projects` (anti-doublon) ; schéma étendu avec `section` |

## Notes de suivi

- Backlog : ROADMAP.md, Phase G — « Contexte par projet (spec/16b à écrire) »
  → devient « spec/16b écrite » une fois ce fichier committé.
- Dépend de : ROADMAP.md, Phase G — « Renommage de projet ».
