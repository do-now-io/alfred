# Alfred — ROADMAP v1

Backlog extrait des specs (`spec/`). Suivi simple : cocher au fil de l'eau,
mettre ses initiales dans **Qui**. Les specs restent la source de vérité du *quoi*
et du *comment* ; ce fichier suit le *où on en est*.

Légende : `[ ]` à faire · `[~]` en cours · `[x]` fait · ⚠️ = risque / chemin critique.

---

## 🎯 Risques & chemin critique (à attaquer en premier)

- ⚠️ **Backend AlfredIA** — gate le lancement (proxy + Stripe + metrics). Spec 15.
- ⚠️ **Audio système sur Windows** — WASAPI loopback, rien de codé. Spec 03.
- ⚠️ **Whisper par défaut, cross-platform** — build + packaging + modèle embarqué. Spec 04.

---

## Phase A — Backend (spec 15) · gate le lancement

| | Tâche | Qui |
|---|---|---|
| [x] | Service Rust/axum + déploiement **Coolify** (Docker depuis Git) + domaine `api.alfred.do-now.io` (Traefik/Let's Encrypt) | UC |
| [x] | **Proxy** `POST /v1/messages` : lookup token, abo actif, allowlist modèles, forward + retry (+ tables `tokens`/`metrics`) | UC |
| [x] | **Stripe** : produit AlfredIA 20 €/mois (+ annuel), sans essai ; Checkout ; webhook (émission/révocation token) | UC |
| [x] | **Souscription loopback** : `/subscribe` + `/subscribe/complete` (nonce/port → token) | UC |
| [x] | **PostgreSQL** (Coolify) : tables `tokens` + `metrics` ; endpoint `POST /metrics` | UC |
| [x] | **`POST /feedback`** → tout en **Postgres** (texte + images BYTEA, consultation SQL ; email/S3 hors v1) | UC |
| [x] | **Secrets** : variables d'env Coolify (clé Anthropic + clés Stripe, chiffrées) | UC |

## Phase B — Desktop, moteur

| | Tâche | Qui |
|---|---|---|
| [~] | ⚠️ **Audio système** : Windows ✅ (WASAPI loopback, `system_only` + `mixed`, testé) — reste macOS helper Swift (Tanguy) | UC/T |
| [x] | Durcir la **capture micro** (gérer `i16`/`f32`/`u16` selon le device) | UC |
| [x] | **Feedback live** d'enregistrement : volume (RMS) + timer dans `recording-status-changed` (micro ; system_only/mixed pas encore de volume live) | UC |
| [x] | ⚠️ **Whisper** : activer la feature par défaut + **embarquer le modèle `small`** + packaging Windows | UC |
| [x] | Transcription : **stocker la langue** détectée (bug) ; écrire dans `alfred-raw/` avec frontmatter (`for_recording`) | UC |
| [x] | IA : passer aux modèles **Sonnet 5 / Haiku 4.5** ; **sorties structurées** ; **routage 2 modes** ; thinking off (fait pour l'ingestion ; chat.rs pas encore aligné sur `thinking: disabled`) | UC |
| [x] | **Ingestion** (fusionnée) : 1 appel → compte-rendu (`alfred-intelligence/`) + tâches (`Todo.md` + SQLite en double écriture, cf tâche suivante) | UC |
| [x] | **Todos → vault** : `Todo.md` seule source de vérité — table SQLite supprimée (migration 007), double écriture de l'ingestion retirée, commandes refondues sur le fichier (id = titre normalisé), code mort frontend (todoStore/TodoItem) supprimé | UC |
| [ ] | Notes : frontmatter **`project` + `participants`** ; structure `alfred-raw`/`alfred-intelligence` ; regroupement par projet ; **plus de `.claude`/skills** dans le vault | |
| [x] | **Brief quotidien** (`generate/get_daily_brief`) | UC |
| [x] | **Chat** : historique multi-conversations + liste (persistance SQLite, migration 006 ; liste/reprise/suppression dans le panneau chat) | UC |
| [~] | **Metrics** : `install_id` anonyme + envoi des événements | UC |

## Phase B2 — Transcription live (spec 16)

| | Tâche | Qui |
|---|---|---|
| [x] | **Spec 16** (transcription live + contexte interne) + amendements specs 03/04/05/07 + README | T |
| [x] | **Contexte interne** : note vault `Contexte Alfred.md` + template + injection ingestion + Settings | T |
| [x] | **Backend live** : session (acteur écrivain unique), chunker silence 8-30s, Whisper persistant, **note créée au start**, finalize + ingestion sur le contenu final de la note | T |
| [x] | **Frontend live** : note ouverte au start, chunks dans l'éditeur (CodeMirror), save réconcilié (`save_live_note`/`last_seq`), badge « En direct » | T |
| [~] | **Amélioration par chunk** (haiku, tool `submit_chunk_fix`, les éditions utilisateur gagnent, circuit breaker) | T |
| [ ] | **Activation live par défaut** (mic_only) + guards rename/delete + polish + statuts specs | T |

## Phase C — Desktop, UX & écrans

| | Tâche | Qui |
|---|---|---|
| [~] | **Accueil « Alfred »** : brief ✅ + bloc tâches dépliable (par sections Prioritaire/En cours/À faire) ✅ + input chat + exemples ✅ (teaser qui envoie vers `/ai-actions` ; **historique/liste de conversations sur la page** reste à faire, cf tâche Chat) | UC |
| [x] | **Indicateur d'état** (topbar, labels majordome) + **bandeau d'enregistrement** (timer + volume live + stop) | UC |
| [x] | Déclenchement via **logo** (hover micro) + **page de guidage** d'enregistrement (`/recording`, conseils de captation éditables) | UC |
| [x] | **Nav** : retirer routes mortes Réunions / Calendrier + barre de recherche ; ajouter **Feedback**. `/ai-actions` gardée à part (écart documenté spec/10 — historique chat pas encore fait) | UC |
| [~] | **Onboarding** refonte (2 slides, détection vault + scaffolding dossiers, choix accès IA, test micro) + **tournée guidée** post-onboarding (vrai enregistrement → transcription → ingestion → tâches/notes → question à Alfred) | UC |
| [x] | **Settings** refonte (accès IA ✓, Whisper ✓, Vapi/Google/Places/calendrier/ingest CLI retirés ✓, défauts `alfred-*` ✓) | UC |
| [x] | **Onglet Feedback** (formulaire + `submit_feedback`) | UC |

## Phase D — Nettoyage (retrait hors-v1)

| | Tâche | Qui |
|---|---|---|
| [x] | Désactiver / retirer les modules `auth`, `calendar`, `suggestions`, `phone_calls` (`ingest` CLI déjà supprimé — spec/05) + tables SQLite associées (migration 008) + UI morte (WeekPanel, BookingDemo, BriefingTask, SuggestionCard, PhoneCallModal, stores) + deps orphelines (base64/sha2/hex) + `.env.example` Google | UC |
| [x] | Retirer les routes `/meetings`, `/calendar` (faites avec la nav Phase C ; `/ai-actions` conservée — écart documenté spec/10) | UC |
| [x] | Mettre à jour les défauts de dossiers (`alfred-raw` ✅, `alfred-intelligence/Todo.md` ✅) | UC |

## Phase E — Packaging & distribution

| | Tâche | Qui |
|---|---|---|
| [ ] | **macOS** : entitlements v1 (retirer apple-events, + `NSScreenCaptureUsageDescription`) ; signature Developer ID + notarisation | |
| [ ] | **Windows** : build Whisper + WebView2 ; signature **Authenticode** | |
| [ ] | Aligner le label launch-at-login `io.alfred.app` → `com.alfred.app` | |

---

*Mis à jour au fil de l'eau. Nouveau besoin non couvert par une spec → ajouter la
spec d'abord, puis la tâche ici.*
