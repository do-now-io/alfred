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

- **Sorties structurées** (`output_config.format` + schéma JSON) pour l'ingestion
  — fiable, remplace le « demander du JSON puis retirer les \`\`\`json ».
- **Thinking désactivé** (`thinking: {type: "disabled"}`) sur toutes les tâches v1
  (coût/latence maîtrisés ; sinon Sonnet 5 raisonne en adaptatif par défaut). Le
  raisonnement adaptatif reste un levier qualité **plus tard** (notamment pour le chat).
- **Non-streaming** en v1 (cohérent avec le proxy, spec/15).
- **Prompt caching** (GA) : cache sur les system prompts (stables).
- **Retry** : codes retriables `429`, `5xx` ; backoff exponentiel `1→2→4 s`,
  3 tentatives ; `4xx` (hors 429) non retriables. Sur `401` → l'UI propose de
  (re)configurer l'accès IA.

---

## Usage 1 — Ingestion (transcription → compte-rendu + tâches)

**Fusionne** l'ancienne « extraction de todos » et l'ancien « ingest » CLI en **un
seul appel API**.

**Déclencheur** : automatiquement après `transcription-complete` ; + bouton
**« ré-ingérer »** (relance sur une note de `alfred-raw/`).

**Entrée** : le texte de la transcription (note dans `alfred-raw/`).

**Modèle** : `claude-sonnet-5`, sortie structurée :
```json
{
  "resume": "compte-rendu structuré en Markdown (points clés abordés)",
  "points_cles": ["..."],
  "taches": [
    { "titre": "...", "responsable": "Prénom|null", "echeance": "YYYY-MM-DD|null" }
  ]
}
```
Le system prompt reprend l'esprit des conseils de captation (spec/03) : rappeler le
responsable de chaque tâche quand il est identifiable.

**Écriture (par Rust, jamais par l'IA)** :
1. Compte-rendu → `alfred-intelligence/{titre}.md` avec frontmatter
   (`type: meeting`, `date`, `recording_id`, `participants`, `project`).
2. Tâches → fusionnées dans `alfred-intelligence/Todo.md`, section `## À faire`,
   dédup par titre normalisé (spec/06).

**Événement** : `ingestion_completed { ai_mode }` (metrics, spec/15) + `notes-updated`.

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

- `run_ingest(recording_id | note_path)` — ingestion (auto + ré-ingérer)
- `ask_notes(question, history) -> ChatResponse`
- `generate_daily_brief() -> String` · `get_daily_brief() -> { text, generated_at } | null`
- `test_api_key(service)` — valide la clé perso / le token AlfredIA

Supprimées de la v1 : `extract_todos_from_transcription` (fusionnée dans l'ingestion),
`generate_weekly_synthesis`, `generate_event_briefing`.

## Hors v1 / plus tard

- Synthèse **hebdomadaire**, **briefing d'événement** (dépendait du calendrier).
- **Raisonnement adaptatif** (thinking) pour la qualité du chat.
- **Streaming** des réponses (proxy + UI).
- Modèle **Opus 4.8** en palier premium.
