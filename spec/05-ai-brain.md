# spec/05 — IA + Ingestion (API Claude)

> **Statut v1 :** toute l'IA passe par l'**API Claude** (jamais de CLI). Deux modes
> d'accès (clé perso / proxy AlfredIA). Trois usages : **ingestion**, **chat**,
> **brief quotidien**.

## Accès & routage — deux modes

| Mode | URL de base | Auth |
|---|---|---|
| Clé perso | `https://api.anthropic.com` | `x-api-key: <claude_api_key>` (secrets.json) |
| AlfredIA | `https://api.alfred.do-now.io` | `Authorization: Bearer <alfredia_token>` (secrets.json) |

Le **corps** de requête est identique dans les deux cas (API Messages Anthropic) :
seuls l'URL de base et l'en-tête d'auth changent. En-tête commun :
`anthropic-version: 2023-06-01`. Voir spec/15 pour le proxy.

## Modèles (alias, sans suffixe de date)

| Usage | Modèle | Tarif /MTok (in/out) |
|---|---|---|
| **Ingestion** (compte-rendu + tâches) | `claude-sonnet-5` | $3 / $15 (intro $2/$10 → 31/08/2026) |
| **Chat / RAG** | `claude-sonnet-5` | idem |
| **Brief quotidien** | `claude-sonnet-5` (ou `claude-haiku-4-5` pour économiser) | Haiku : $1 / $5 |

**Allowlist du proxy AlfredIA** : `claude-haiku-4-5` + `claude-sonnet-5`
(`claude-opus-4-8` en option premium, non activé en v1).

## Conventions API (v1)

- **Sorties structurées** pour l'ingestion — via **tool-use forcé** (schéma JSON
  en `input_schema`, `tool_choice` pointant sur l'unique outil) : fiable, remplace
  le « demander du JSON puis retirer les \`\`\`json ».
- **Thinking désactivé** (`thinking: {type: "disabled"}`) sur toutes les tâches v1
  (coût/latence maîtrisés ; sinon Sonnet 5 raisonne en adaptatif par défaut). Le
  raisonnement adaptatif reste un levier qualité **plus tard** (notamment pour le chat).
- **Non-streaming** en v1 (cohérent avec le proxy, spec/15).
- **Prompt caching** (GA) : cache sur les system prompts (stables).
- **Retry** : codes retriables `429`, `5xx` ; backoff exponentiel `1→2→4 s`,
  3 tentatives ; `4xx` (hors 429) non retriables. Sur `401` → l'UI propose de
  (re)configurer l'accès IA.

---

## Usage 1 — Ingestion (transcription → compte-rendu + tâches) — ✅ fait

**Fusionne** l'ancienne « extraction de todos » et l'ancien « ingest » CLI en **un
seul appel API**. Remplace `extract_todos_from_transcription` (SQLite uniquement)
et l'ancien `ingest.rs` (spawn du CLI `claude` local) — les deux sont supprimés.

**Déclencheur** : automatiquement après `transcription-complete`
(`ai::run_ingestion_for_recording`, appelé par `transcription/mod.rs`) ; + bouton
**« ré-ingérer »** dans l'onglet Notes, actif quand une note est sélectionnée
(relance sur cette note via `ai::run_ingestion_for_note`).

**Entrée** : le texte de la transcription (note dans `alfred-raw/`).

**Modèle** : `claude-sonnet-5`. **Sortie structurée** via **tool-use forcé**
(`tool_choice: {"type": "tool", "name": "submit_ingestion"}`, même mécanisme que
le chat agentique spec/07b) plutôt qu'un champ `output_config.format` — plus
robuste que « demander du JSON puis retirer les \`\`\`json », et déjà éprouvé dans
ce code base :
```json
{
  "titre": "sujet court de l'échange (ex. « Réunion Flexiflit — migration GKE »)",
  "resume": "compte-rendu structuré en Markdown (points clés abordés)",
  "points_cles": ["..."],
  "taches": [
    { "titre": "...", "responsable": "Prénom (optionnel)", "echeance": "YYYY-MM-DD (optionnel)" }
  ]
}
```
Le system prompt reprend l'esprit des conseils de captation (spec/03) : rappeler le
responsable de chaque tâche quand il est identifiable.

**Langue de sortie — ✅ fait (feedback tests EN, spec/21).** Constat test : une
réunion **entièrement en anglais** a donné une **transcription ET un compte-rendu en
français**. Deux causes distinctes :

1. **Compte-rendu** — corrigé : `language_instruction(db)` (helper partagé,
   `ai/mod.rs`) est appendu à `INGESTION_SYSTEM` (et au system prompt du chat/brief/
   glossaire/construction du contexte) — Claude rédige compte-rendu et tâches
   **dans la langue du contenu** (la transcription), à défaut dans `app_language`.
2. **Transcription** : voir spec/17 (le glossaire injecté en `initial_prompt` était
   enrobé d'une phrase **française figée** qui biaisait Whisper — corrigé).

> ✅ **Corrigé.** La note de CONTEXTE sortait en français malgré une app EN — deux
> faiblesses de l'ancienne approche : `language_instruction` reposait sur
> l'**inférence** (« écris dans la MÊME langue que le texte fourni ») et était
> **elle-même rédigée en français**, tout comme `CONTEXT_BUILD_SYSTEM`/
> `INGESTION_SYSTEM`/`ANALYZE_SYSTEM` et les **descriptions des champs des tools**
> (`submit_context`, `submit_ingestion`, `submit_clarifications`) — un prompt et un
> schéma massivement FR tirent Claude vers le français même sur une transcription EN,
> surtout un texte court. **Correctif** : `recording_language(db, recording_id)`
> (`ai/mod.rs`) lit la langue **RÉELLEMENT détectée** par Whisper pour cet
> enregistrement (`transcriptions.language`, spec/04) — pas une inférence — avec
> repli sur `app_language` si le `recording_id` n'a pas de transcription connue
> (ré-ingestion d'une note libre). `language_directive(lang)` construit une consigne
> **impérative** (« Write ALL fields / your entire answer in {lang} », pas
> « écris dans la langue du texte ») appliquée à `call_ingestion`, `call_analyze`
> (n'avait **aucune** consigne de langue avant — la fuite la plus nette) et
> `build_context_inner`. Les **descriptions** de `submit_ingestion`/
> `submit_clarifications`/`submit_context` sont **alignées sur cette même langue**
> (les **noms** de champs — `titre`, `resume`, `entreprise`… — restent inchangés,
> ce sont des clés serde internes, pas du texte affiché).

Les **titres générés** du compte-rendu (`## Points clés` → `## Key points`) sont
**localisés selon `app_language`** (ce sont NOS titres, écrits par le code Rust, pas
par Claude — `run_ingestion_core`, `ai::app_language(db)`). La **langue UI, la
langue de la transcription et la langue du compte-rendu** peuvent différer — la
règle : le **contenu** (compte-rendu/tâches) suit la langue de l'audio ; l'**UI** et
nos propres titres générés suivent `app_language`.

**`titre` = nom du compte-rendu (✅ fait, feedback tests).** Nouveau champ : un
**sujet court** qui **nomme le fichier compte-rendu** (`alfred-intelligence/{titre}.md`)
au lieu du nom daté `AAAA-MM-JJ HHhMM` hérité de l'enregistrement. Une fois
l'intelligence faite, l'utilisateur veut un **nom de réunion**, pas une date
(spec/07 §Différenciation & nommage). La transcription brute garde son nom daté ;
les deux restent appariées par `recording_id` (spec/07/07c). Bonus : le compte-rendu
nommé par sujet **ne collisionne plus** avec la transcription datée.

**Contexte interne (spec/16)** : si la note `Contexte Alfred.md` existe et n'est
pas vide, son corps (cap ~4 000 caractères) est injecté comme **second bloc
system** (le `cache_control: ephemeral` est posé sur le **dernier** bloc → tout
le préfixe system est caché). Claude s'en sert pour orthographier correctement
les prénoms, équipes et termes maison dans le compte-rendu et les tâches. Cette
même note sert de source au **glossaire Whisper** (spec/17).

**Écriture (par Rust, jamais par l'IA)** :
1. Compte-rendu → `alfred-intelligence/{titre}.md` avec frontmatter
   (`type: meeting`, `date`, `recording_id`, `participants`, `project`).
   `participants`/`project` peuplés par l'IA (regroupement par projet = spec/07).
   **`project` de `submit_ingestion` est une LISTE** (`array` de chaînes) — une
   réunion peut relever de **plusieurs projets** (feedback tests) ; l'IA renvoie 0..n
   projets « clairement identifiables ».
2. Tâches → `alfred-intelligence/Todo.md` (section `## À faire`, dédup par titre
   normalisé). **Provenance (✅ fait, spec/06)** : chaque tâche générée reçoit un
   **wikilink de provenance** sur sa ligne — `[[compte-rendu source]]` (nommé par
   sujet) si le compte-rendu est produit, sinon `[[note brute de transcription]]` —
   + la date. Cliquable, lien automatique dans le graphe (spec/07c — `Todo.md` est un
   fichier du vault comme un autre, son wikilink est résolu par le mécanisme
   standard), et la **fiche tâche** (spec/06) sait **d'où / quand** vient la tâche.

**Événement** : `ingestion_completed { ai_mode }` (metrics, spec/15) + `notes-updated`
(+ `todos-updated` pour la partie SQLite, transitoire).

**Archivage de la transcription (✅ fait, feedback tests, spec/07)** : une fois
l'ingestion **réussie** (compte-rendu produit), la note **brute de transcription**
(`alfred-raw/`, celle du `recording_id`) passe **`status: archived`** — elle a rempli
son rôle, on la sort de la navigation (masquée par défaut, spec/07). Le compte-rendu
reste `active`. Ne se déclenche que si le **compte-rendu** est demandé (`summary`) ;
tâches seules ne suffisent pas à « clore » la transcription.

### Sortie découplée compte-rendu / tâches — ✅ fait (feedback tests, spec/03)

Le panneau de revue post-enregistrement (spec/03) laisse l'utilisateur **choisir**
les traitements aval : Transcription / **Compte-rendu** / **Tâches** (cases cochées
par défaut, décochables **indépendamment**). L'ingestion doit donc pouvoir
**n'émettre qu'une partie** de sa sortie :

- **Contrat** : `run_ingestion_for_recording` (et `run_ingestion_for_note`) prend un
  sélecteur, p. ex. `{ summary: bool, tasks: bool }`. N'écrit que ce qui est demandé
  (compte-rendu seul, tâches seules, ou les deux).
- **Implémentation** : privilégier **un seul appel** à sortie conditionnelle (le
  tool `submit_ingestion` garde `resume`/`points_cles`/`taches`, mais Rust n'écrit
  que les sections demandées) plutôt que deux appels — moins de coût/latence, et le
  compte-rendu et les tâches restent cohérents entre eux. Ne générer les `taches`
  côté prompt que si `tasks` est demandé.
- **Cas limites** : `summary=false, tasks=false` ⇒ ne pas appeler l'ingestion du
  tout (seule la transcription est produite). Compte-rendu/tâches supposent la
  transcription faite (dépendance gérée par l'UI, spec/03).

### Retour d'état par phase (capsule « Je note les tâches… ») — ✅ fait (feedback tests)

L'utilisateur ne voit pas qu'Alfred **crée les tâches** — seul l'état « Je cogite… »
s'affiche. On expose les **phases** de l'ingestion pour piloter la capsule majordome
(spec/10) :

- `ingestion-status-changed` porte une **phase** : `analyzing` (appel Claude, le gros
  du temps) → `summary` (écriture du compte-rendu, si demandé) → `tasks` (écriture
  des tâches, si demandé) → `done`/`error`.
- **1 seul appel IA** (choix acté) : la phase `tasks` est donc **brève** (écriture
  seule) — capsule courte mais **honnête**, on ne fabrique pas de fausse durée.
  Labels majordome : voir spec/10.
- **Ré-ingestion** : mêmes phases pour `run_ingestion_for_note` **et** pour une
  éventuelle **ré-ingestion en lot** (« toutes les notes ») — la capsule reflète la
  note en cours (et son avancement n/total si lot).

### Ingestion augmentée — 📝 à faire (spec/17)

Évolution en **deux temps** : Claude **analyse** la
transcription + `Contexte Alfred.md` et renvoie des **propositions groupées
seuillées** (corrections avec citation + timestamps, tâches sans responsable,
phrases importantes floues, faits appris) → l'utilisateur tranche en **un écran**
(réécoute du segment via WAV `alfred-raw/` + `segments_json`) → **finalisation**.
**Jamais d'auto-application** ; si rien à signaler, enchaîne automatiquement. Les
faits appris sont écrits dans `Contexte Alfred.md` (section « Appris
automatiquement »). Détail : spec/17.

---

## Usage 2 — Chat / RAG sur les notes

Boucle **agentique tool-use** (déjà construite, `ask_notes`) : Claude décide quoi
`search_notes` (scoring mots-clés sur le vault) et quel `read_note` lire, puis
répond en citant ses sources en `[[wikilink]]`. Max **6 itérations**.

- **Modèle** : `claude-sonnet-5`. **Commande** : `ask_notes(question, history) -> ChatResponse { answer, sources }`.
- Cache sur le system prompt. Non-streaming en v1.

---

## Usage 3 — Brief quotidien « Aujourd'hui »

Le bloc « Aujourd'hui » de l'accueil (spec/10). **Quotidien uniquement** (pas de
synthèse hebdo).

- **Déclencheur** : au 1er lancement du jour (comparer `daily_brief_last_run` à la
  date locale) + bouton **régénérer**.
- **Entrée** : todos courants (`Todo.md`) + notes/réunions récentes.
- **Sortie** : résumé Markdown **très court** (« ce qu'il faut savoir aujourd'hui »).
- **Modèle** : `claude-sonnet-5` (ou `claude-haiku-4-5` pour économiser).
- **Cache** : texte + date stockés en config (`daily_brief`, `daily_brief_last_run`).
  Affichage du texte mis en cache + « Généré le {date} ».

**Bug — brief en français sur une app EN (✅ corrigé, feedback tests).** Constat :
même avec une note récente ajoutée en anglais, le brief restait en français.
Deux causes :
1. Le **contenu** envoyé à Claude (`## Tâches en cours` / `Aucune tâche en
   attente.` / `## Notes récentes` / `Aucune note récente.` / `Vault non
   configuré.`) était **codé en dur en français** — libellés localisés selon
   `app_language` (`generate_daily_brief`, `ai/mod.rs`).
2. **Plus profond** : le brief agrège les **titres** de plusieurs tâches/notes
   qui peuvent chacune être dans une langue différente — contrairement à
   l'ingestion/au chat (une seule source dont la langue se détecte bien), il n'y
   a pas de « langue du contenu » unique à suivre. `language_instruction`
   (repli seulement si ambigu) laissait Claude suivre la langue dominante des
   titres plutôt que `app_language`, même avec une note ajoutée dans l'autre
   langue. **Corrigé : consigne inconditionnelle** — le brief répond toujours
   dans `app_language`, jamais dans la langue supposée du contenu (règle propre
   au brief, différente du reste de l'IA — voir §Usage 1/2 ci-dessus).

---

## Commandes Tauri (v1)

- `run_ingest(note_path)` — ré-ingère une note (le déclenchement auto passe par
  `ai::run_ingestion_for_recording`, appelé en interne depuis la transcription)
- `ask_notes(question, history) -> ChatResponse`
- `generate_daily_brief() -> String` · `get_daily_brief() -> { text, generated_at } | null`
- `test_api_key(service)` — valide la clé perso / le token AlfredIA

Supprimées : `extract_todos_from_transcription` (fusionnée dans l'ingestion),
l'ancien `ingest.rs` (CLI), `generate_weekly_synthesis` (remplacée par le brief
quotidien sur l'accueil — spec/10). **Pas encore supprimée** (gardée tant que
Calendar, hors v1, n'est pas retiré — Phase D) : `generate_event_briefing`,
encore utilisée par le panneau « Cette semaine » du Dashboard.

## Hors v1 / plus tard

- Synthèse **hebdomadaire**, **briefing d'événement** (dépendait du calendrier).
- **Raisonnement adaptatif** (thinking) pour la qualité du chat.
- **Streaming** des réponses (proxy + UI).
- Modèle **Opus 4.8** en palier premium.
