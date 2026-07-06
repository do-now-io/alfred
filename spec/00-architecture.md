# spec/00 — Architecture

> **Cible v1 : application desktop cross-platform (Windows + macOS)** construite
> avec **Tauri v2**, + un **backend Alfred** (proxy IA + metrics). Voir
> `spec/README.md` pour le périmètre et le statut.

## Vue d'ensemble

Le backend desktop est en **Rust**, le frontend est une WebView affichant du
**React 18 + TypeScript**. Partage des responsabilités, strict :

| Couche | Responsabilité |
|---|---|
| Rust (backend desktop) | OS + réseau : audio, fichiers/vault, SQLite, secrets, HTTP sortant (Claude ou proxy AlfredIA) |
| Frontend (WebView) | Affichage + état d'UI uniquement — aucune logique métier, aucun secret, aucun appel API externe |
| Backend Alfred (serveur) | Proxy Claude (AlfredIA) + collecte des metrics (voir spec/15) |

Le frontend dérive ses **données** du backend (via `invoke` + événements) et
garde un **état d'UI** local (navigation, sélection) via Zustand + react-router.

## Plateformes supportées (v1)

| OS | Version min | WebView | Notes |
|---|---|---|---|
| Windows | 10 (1809+) et 11 | **WebView2** | Préinstallé sur Win 11 |
| macOS | 13 (Ventura) et + | **WebKit** | ≥ 13 couvre ScreenCaptureKit (audio système) |

Identifiant : **`com.alfred.app`**.

## Stack technique

- **Rust** (edition 2021) + **Tokio** ; **Tauri v2** (plugins `shell`, `opener`, `dialog`)
- **React 18** + **TypeScript 5**, **Zustand**, **react-router-dom**, **Tailwind v4**
- **CodeMirror 6** + **react-markdown/remark-gfm** (notes), **react-force-graph-2d** (graphe)
- **SQLite** via `sqlx` — **config / état local uniquement**
- **whisper-rs** (transcription locale, spec/04) · **reqwest** (HTTP sortant)

## Accès IA — deux modes

- **Clé perso** : l'app appelle `https://api.anthropic.com/v1/messages` avec la clé de l'utilisateur (`secrets.json`).
- **AlfredIA** : l'app appelle **notre proxy** avec un token AlfredIA ; le proxy détient la vraie clé Anthropic. Corps de requête identique → seuls **l'URL de base + l'en-tête d'auth** changent (voir spec/05 et spec/15).

## Modèle de processus

```
┌──────────────────── Poste utilisateur (Win / macOS) ────────────────────┐
│  ┌──────────────────┐   IPC    ┌───────────────┐                         │
│  │   Rust Backend   │◄────────►│  WebView (UI) │                         │
│  │  audio · Whisper │ invoke   │  React + TS   │                         │
│  │  vault · SQLite  │ emit     │  Zustand      │                         │
│  │  secrets.json    │          └───────────────┘                         │
│  └────────┬─────────┘                                                    │
└───────────┼──────────────────────────────────────────────────────────────┘
            │ HTTPS (clé perso → Anthropic  |  AlfredIA → proxy)
            ▼
   Anthropic API      ◄──────  Backend Alfred (proxy + metrics, spec/15)
```

## Convention IPC

### Commandes (frontend → backend) — snake_case, `async`

```typescript
import { invoke } from '@tauri-apps/api/core';
await invoke('start_recording', { source: 'mic_only' });
await invoke('ask_notes', { question: '…', history: [] });
```

Domaines v1 dans `src-tauri/src/lib.rs` : enregistrement, transcription, IA
(+ ingestion), todos, notes (vault), notes-chat, config & secrets, système.
*(Le code contient encore calendrier, suggestions et appels — **hors v1**.)*

### Événements (backend → frontend) — kebab-case

| Événement | Payload | v1 |
|---|---|:--:|
| `recording-status-changed` | `{ status, duration_seconds, ... }` | ✅ |
| `transcription-progress` / `-complete` / `-failed` | voir spec/04 | ✅ |
| `download-progress` | `{ percent, bytes_downloaded, total_bytes }` | ✅ |
| `ingestion_completed` / état Alfred | voir spec/05, spec/10 | ✅ |
| `todos-updated` | `{ count }` | ✅ |
| `suggestion-ready` · `call-*` | voir spec/08–09 | 🕓 |

## Stockage

`$APP_DATA_DIR` : `%APPDATA%\com.alfred.app\` (Windows) ·
`~/Library/Application Support/com.alfred.app/` (macOS).

| Contenu | Chemin |
|---|---|
| Base SQLite (config/état) | `$APP_DATA_DIR/alfred.db` |
| Secrets | `$APP_DATA_DIR/secrets.json` (0600 sur Unix) |
| WAV (temporaires) | `$APP_DATA_DIR/recordings/{id}.wav` |
| Modèles Whisper | `$APP_DATA_DIR/models/ggml-{size}.bin` |
| Vault de notes | dossier choisi par l'utilisateur (config `notes_vault_path`) |

Migrations SQLite : `src-tauri/migrations/NNN_*.sql`, appliquées au démarrage,
**additives uniquement**.

## Secrets — `secrets.json`

Fichier JSON local (module `keychain`, nom historique). Inventaire v1 :

| Compte | Contenu |
|---|---|
| `claude_api_key` | Clé Anthropic (mode « clé perso ») |
| `alfredia_token` | Token AlfredIA (mode AlfredIA ; obtenu via Stripe + loopback, spec/15) |

> **Compromis v1 :** secrets en quasi-clair dans un fichier. OK pour un petit
> groupe sur leurs machines. Chiffrement natif OS → « Plus tard ».

## Modèle async & état

Runtime **Tokio** de Tauri. Tâches longues via `spawn` ; Whisper (C++ bloquant)
via `spawn_blocking`. État partagé dans `tauri::State<AppState>` (db, handle
d'enregistrement, `transcription_tx`, `http_client`, `vault_path`, `oauth_port`
— ce dernier réutilisé pour le loopback AlfredIA).

## Types TypeScript (`ts-rs`)

Types Rust exposés annotés `#[derive(TS)]` → régénérés par `npm run generate-types`
(test `export_bindings`). Fichiers générés dans `src/bindings/`, **committés**.

## Graphe de dépendances (v1)

```
00 Architecture → 01 Data Model
   ├─ 03 Audio → 04 Transcription → 05 AI + Ingestion
   │                                   ├─ 06 Todos (vault)
   │                                   └─ 07 Notes ─ 07b Chat (RAG) · 07c Graphe
   ├─ 10 Accueil   ├─ 11 Settings   ├─ 12 Permissions
   ├─ 13 Onboarding └─ 14 Feedback
   └─ 15 Backend AlfredIA + Metrics

(Hors v1 : 02 Calendar · 08 Suggestions · 09 Phone Calls · Ingest CLI)
```

## Structure du projet

```
alfred/
├── spec/                     # specs + README (index/statut)
├── src-tauri/src/
│   ├── lib.rs                # commandes Tauri + builder
│   ├── state.rs · db/ · keychain.rs (secrets.json)
│   ├── audio/ · transcription/ · ai/{mod,chat}.rs
│   ├── todos/ · notes/{mod,vault,frontmatter,graph}.rs
│   ├── auth/ · calendar/ · suggestions/ · phone_calls/ · ingest.rs   # HORS V1 (à retirer/désactiver)
│   └── bindings/
├── src/{screens,components,store,bindings}/
├── migrations/ · capabilities/ · tauri.conf.json
└── (backend Alfred = service séparé, spec/15)
```

## Hors v1 / plus tard

- **Calendrier + connexion Google / OAuth** : entièrement retiré (spec/02).
  Modules `auth` et `calendar` à désactiver/retirer.
- **Suggestions** (08) et **appels Vapi** (09) : code présent, réactivés post-v1.
- **Ingest CLI** : supprimé, remplacé par l'ingestion API (spec/05).
- **Chiffrement natif des secrets** (Keychain macOS / DPAPI Windows).
