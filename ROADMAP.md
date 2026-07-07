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
| [ ] | **Souscription loopback** : `/subscribe` + `/subscribe/complete` (nonce/port → token) | |
| [ ] | **PostgreSQL** (Coolify) : tables `tokens` + `metrics` ; endpoint `POST /metrics` | |
| [ ] | **`POST /feedback`** → stockage objet S3-compat (images) + **SMTP** (email équipe) | |
| [ ] | **Secrets** : variables d'env Coolify (clé Anthropic + clés Stripe, chiffrées) | |

## Phase B — Desktop, moteur

| | Tâche | Qui |
|---|---|---|
| [ ] | ⚠️ **Audio système** : Windows WASAPI loopback + macOS helper Swift (ScreenCaptureKit) | |
| [ ] | Durcir la **capture micro** (gérer `i16`/`f32` selon le device) | |
| [ ] | **Feedback live** d'enregistrement : volume (RMS) + timer dans `recording-status-changed` | |
| [ ] | ⚠️ **Whisper** : activer la feature par défaut + **embarquer le modèle `small`** + packaging Windows | |
| [ ] | Transcription : **stocker la langue** détectée (bug) ; écrire dans `alfred-raw/` avec frontmatter (`for_recording`) | |
| [ ] | IA : passer aux modèles **Sonnet 5 / Haiku 4.5** ; **sorties structurées** ; **routage 2 modes** ; thinking off | |
| [ ] | **Ingestion** (fusionnée) : 1 appel → compte-rendu (`alfred-intelligence/`) + tâches (`Todo.md`) | |
| [ ] | **Todos → vault** : lire/écrire `Todo.md` (sections + Archivé) ; supprimer la table SQLite | |
| [ ] | Notes : frontmatter **`project` + `participants`** ; structure `alfred-raw`/`alfred-intelligence` ; regroupement par projet ; **plus de `.claude`/skills** dans le vault | |
| [ ] | **Brief quotidien** (`generate/get_daily_brief`) | |
| [ ] | **Chat** : historique multi-conversations + liste (persistance SQLite) | |
| [ ] | **Metrics** : `install_id` anonyme + envoi des événements | |

## Phase C — Desktop, UX & écrans

| | Tâche | Qui |
|---|---|---|
| [ ] | **Accueil « Alfred »** : brief + bloc tâches dépliable + input chat + exemples | |
| [ ] | **Indicateur d'état** (topbar, labels majordome) + **bandeau d'enregistrement** | |
| [ ] | Déclenchement via **logo** (hover micro) + **page de guidage** d'enregistrement | |
| [ ] | **Nav** : retirer Réunions / Calendrier / Actions IA + barre de recherche ; ajouter **Feedback** | |
| [ ] | **Onboarding** refonte (2 slides, détection vault + scaffolding dossiers, choix accès IA, test micro) | |
| [ ] | **Settings** refonte (accès IA, Whisper ici, retirer Vapi/Google/Places/calendrier/ingest CLI ; défauts `alfred-*`) | |
| [ ] | **Onglet Feedback** (formulaire + `submit_feedback`) | |

## Phase D — Nettoyage (retrait hors-v1)

| | Tâche | Qui |
|---|---|---|
| [ ] | Désactiver / retirer les modules `auth`, `calendar`, `suggestions`, `phone_calls`, `ingest` (CLI) | |
| [ ] | Retirer les routes `/meetings`, `/calendar`, `/ai-actions` | |
| [ ] | Mettre à jour les défauts de dossiers (`alfred-raw`, `alfred-intelligence/Todo.md`) | |

## Phase E — Packaging & distribution

| | Tâche | Qui |
|---|---|---|
| [ ] | **macOS** : entitlements v1 (retirer apple-events, + `NSScreenCaptureUsageDescription`) ; signature Developer ID + notarisation | |
| [ ] | **Windows** : build Whisper + WebView2 ; signature **Authenticode** | |
| [ ] | Aligner le label launch-at-login `io.alfred.app` → `com.alfred.app` | |

---

*Mis à jour au fil de l'eau. Nouveau besoin non couvert par une spec → ajouter la
spec d'abord, puis la tâche ici.*
