---
name: query-metrics
description: Traduit une question en langage naturel sur l'usage d'Alfred (installs, partages, feedback, événements) en requête SQL et l'exécute directement sur la base Postgres AlfredIA (Coolify). Utiliser quand l'utilisateur pose une question du type "combien de personnes ont installé/partagé/utilisé X", demande un résumé des metrics, ou veut interroger la base de metrics.
---

# Query Metrics — AlfredIA

Ce skill permet de répondre à des questions en langage naturel sur l'usage réel
d'Alfred en traduisant la question en SQL et en l'exécutant sur la base
Postgres de production (backend AlfredIA, hébergé sur Coolify).

## Connexion

- Le DSN Postgres est stocké dans `METRICS_DATABASE_URL` du fichier
  `.env.metrics.local` à la racine du repo (gitignored, jamais commité).
- Si ce fichier n'existe pas : demander à l'utilisateur de le créer en
  récupérant le DSN depuis Coolify (projet AlfredIA → service PostgreSQL →
  onglet Connection), format `postgres://user:pass@host:port/dbname`.
- Dépendance Python requise : `psycopg2-binary` (`pip install psycopg2-binary`
  si absente).

## Comment exécuter une requête

Utiliser le script existant, qui lit le DSN automatiquement et **refuse tout
ce qui n'est pas un `SELECT`/`WITH`** :

```
python scripts/query_metrics.py "SELECT ..."
```

Ne jamais contourner ce garde-fou pour des requêtes de lecture. Pour toute
opération d'écriture (voir section "Écritures / opérations destructives"
ci-dessous), ne pas utiliser ce script.

## Schéma pertinent

### `metrics` (append-only, un événement par ligne)
- `install_id UUID` — identifiant d'installation (proxy pour "un utilisateur")
- `event TEXT` — type d'événement (voir liste ci-dessous)
- `props JSONB` — détails additionnels selon l'event
- `app_version`, `os`
- `ts TIMESTAMP` — horodatage de l'événement

Événements observés : `install_created`, `app_launched`,
`onboarding_step_shown`, `onboarding_finished`, `guided_tour_started`,
`guided_tour_finished`, `guided_tour_skipped`, `recording_completed`,
`recording_failed`, `transcription_completed`, `ingestion_completed`,
`ai_request`, `resolve_finalized`, `resolve_ignored`, `resolve_deferred`,
`resolve_banner_dismissed`, `model_download_started`,
`model_download_completed`. Vérifier la liste réelle avec
`SELECT DISTINCT event FROM metrics` si un event nouveau ou inconnu apparaît
dans la question.

### `shares` (une ligne par document partagé publiquement)
- `slug` (PK), `title`, `markdown`, `manage_token_hash`, `install_id`,
  `created_at`, `updated_at`

### `feedback` / `feedback_images`
- Retours utilisateurs envoyés depuis l'app, `created_at`.

### Hors périmètre de ce skill (ne jamais toucher sans demande explicite)
- `tokens`, `pending_tokens`, `subscribe_flows` — auth / abonnement Stripe.
  Les vider ou les modifier casse l'authentification des utilisateurs réels.

## Patterns de traduction NL → SQL

- "Combien de personnes ont installé Alfred aujourd'hui" →
  `SELECT COUNT(DISTINCT install_id) FROM metrics WHERE event = 'install_created' AND ts::date = CURRENT_DATE`
- "Combien d'installations actives aujourd'hui" (tous events confondus) →
  `SELECT COUNT(DISTINCT install_id) FROM metrics WHERE ts::date = CURRENT_DATE`
- "Combien de personnes ont partagé un document" →
  `SELECT COUNT(DISTINCT install_id) FROM shares` (ajouter un filtre
  `created_at` pour une période donnée)
- "Résumé des metrics d'aujourd'hui" → grouper par event avec count total +
  installs distinctes :
  `SELECT event, COUNT(*) AS total, COUNT(DISTINCT install_id) AS installs_distincts FROM metrics WHERE ts::date = CURRENT_DATE GROUP BY event ORDER BY total DESC`
  et compléter avec les compteurs `shares` et `feedback` du jour.
- Pour "cette semaine" / "hier" / une plage de dates, adapter le filtre
  `ts`/`created_at` en conséquence (`CURRENT_DATE - INTERVAL '7 days'`, etc.).

## Règles de sécurité — toujours respecter

1. **Lecture seule par défaut.** Toute question de type "combien", "qui a
   fait X", "résumé" se traduit en `SELECT`. Ne jamais écrire dans la base
   sans demande explicite et non ambiguë de l'utilisateur.
2. **Toute opération destructive ou d'écriture** (`TRUNCATE`, `DELETE`,
   `UPDATE`, `DROP`) nécessite :
   - une confirmation explicite du périmètre exact (quelles tables) via
     `AskUserQuestion` si le périmètre n'est pas déjà 100% clair,
   - un rappel que `shares` contient des données fonctionnelles réelles
     (liens publics) et pas seulement des metrics — la vider casse des liens
     déjà partagés,
   - de ne jamais toucher `tokens`/`pending_tokens`/`subscribe_flows` sauf
     demande explicite portant spécifiquement sur ces tables,
   - un compte des lignes avant/après pour rapporter ce qui a été fait.
3. Ne jamais coller le DSN ou son contenu en clair dans une réponse à
   l'utilisateur.
