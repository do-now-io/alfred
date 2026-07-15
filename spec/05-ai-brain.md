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
  "resume": "compte-rendu structuré en Markdown (points clés abordés)",
  "points_cles": ["..."],
  "taches": [
    { "titre": "...", "responsable": "Prénom (optionnel)", "echeance": "YYYY-MM-DD (optionnel)" }
  ]
}
```
Le system prompt reprend l'esprit des conseils de captation (spec/03) : rappeler le
responsable de chaque tâche quand il est identifiable.

**Contexte interne (spec/16)** : si la note `Contexte Alfred.md` existe et n'est
pas vide, son corps (cap ~4 000 caractères) est injecté comme **second bloc
system** (le `cache_control: ephemeral` est posé sur le **dernier** bloc → tout
le préfixe system est caché). Claude s'en sert pour orthographier correctement
les prénoms, équipes et termes maison dans le compte-rendu et les tâches. Cette
même note sert de source au **glossaire Whisper** (spec/17).

**Écriture (par Rust, jamais par l'IA)** :
1. Compte-rendu → `alfred-intelligence/{titre}.md` avec frontmatter
   (`type: meeting`, `date`, `recording_id`, `participants`, `project`).
   `participants`/`project` existent dans le frontmatter mais ne sont pas encore
   peuplés par l'IA (regroupement par projet = spec/07, hors de ce chantier).
2. Tâches → **écriture double** tant que spec/06 (Todos → vault) n'est pas faite :
   fusionnées dans `alfred-intelligence/Todo.md` (section `## À faire`, dédup par
   titre normalisé) **et** insérées dans la table SQLite `todos` (pour que l'écran
   Tâches actuel continue de les afficher). Le fichier deviendra seul juste après
   le cutover spec/06.

**Événement** : `ingestion_completed { ai_mode }` (metrics, spec/15) + `notes-updated`
(+ `todos-updated` pour la partie SQLite, transitoire).

### Sortie découplée compte-rendu / tâches — 📝 à faire (feedback tests, spec/03)

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
