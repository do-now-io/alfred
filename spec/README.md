# Alfred — Spécifications

Source de vérité fonctionnelle et technique d'Alfred. Chaque `NN-*.md` décrit un
module.

**Objectif :** livrer une **v1 cross-platform (Windows + macOS)** rapidement à
~10 utilisateurs en attente, pour valider l'intérêt et l'usage.

**En une phrase :** Alfred enregistre (micro + audio système), transcrit en local
avec Whisper, en fait des notes dans un **vault Markdown**, et **Claude** t'assiste
dessus — soit avec ta **clé perso**, soit via l'abonnement **AlfredIA** (proxy géré
par nous).

## Principes d'architecture (verrouillés)

- **Backend Rust** possède tout l'I/O OS et réseau ; le **frontend** ne fait que
  l'affichage + l'état d'UI.
- **IA 100 % via l'API Claude** (HTTP), **jamais** de CLI local. Deux modes
  d'accès : **clé perso** (`api.anthropic.com`) ou **AlfredIA** (notre **proxy**).
  La vraie clé Anthropic ne vit **que** côté serveur.
- **Le vault est la source de vérité du contenu** (`alfred-raw/`,
  `alfred-intelligence/`, `alfred-intelligence/Todo.md`). **SQLite = config / état
  local uniquement.**
- Aucun fichier Alfred technique dans le vault (pas de `.claude/`, pas de skill) —
  les prompts vivent dans l'app.
- **Cross-platform** Windows (10 1809+/11) + macOS (13+).

## Structure du vault

```
<vault>/
├── alfred-raw/            # transcriptions brutes (1 .md par enregistrement)
└── alfred-intelligence/   # comptes-rendus structurés générés par l'IA (frontmatter riche)
    └── Todo.md            # liste de tâches agrégée = SOURCE DE VÉRITÉ des todos
```

## Légende de statut

- ✅ **v1 — fait** · 🚧 **v1 — à finir / refondre** · 🎨 **v1 — à (re)styler**
- 📝 **v1 — spec à créer** · 🕓 **Plus tard (hors v1)** · ❌ **supprimé**

## Modules

| #   | Module                      | Statut | Note |
|-----|-----------------------------|--------|------|
| 00  | Architecture                | 🚧 | Refonte : backend/proxy, vault, IA=API, sans calendrier ni CLI |
| 01  | Data Model                  | 🚧 | SQLite = config/état ; todos → vault ; calendrier hors v1 |
| 02  | Calendar                    | 🕓 | **Hors v1** (retiré avec Google/OAuth) |
| 03  | Audio Recording             | 🚧 | Micro ok ; **audio système Windows à coder** ; trigger logo/bandeau ; page de guidage ; feedback live (volume, timer) |
| 04  | Transcription               | 🚧 | Whisper **par défaut**, cross-platform ; écrit dans `alfred-raw/` |
| 05  | AI Brain + Ingestion        | 🚧 | **Spec faite.** Ingestion (extraction fusionnée) · chat · brief quotidien ; Haiku/Sonnet 5 ; sorties structurées ; 2 modes d'accès |
| 06  | Todos                       | 🚧 | `Todo.md` = source unique ; supprimer la table SQLite |
| 07  | Notes (vault)               | 🚧 | Structure `alfred-*` ; supprimer skills/`.claude` ; regroupement par `project` (dossiers virtuels) |
| 07b | Notes — Chat (RAG)          | ✅ | Construit (`ask_notes`) + spec faite |
| 07c | Notes — Graphe              | ✅ | Construit (`get_vault_graph`) + spec faite |
| 08  | Suggestions                 | 🕓 | **Hors v1** |
| 09  | Phone Calls (Vapi)          | 🕓 | **Hors v1** |
| 10  | Accueil « Alfred » & UI     | 🚧 | **Spec faite.** Page Alfred (brief + tâches + chat avec historique/liste) ; bandeau enregistrement ; indicateur d'état ; nav réduite ; recherche retirée |
| 11  | Settings                    | 🚧 | **Spec faite.** Accès IA (clé perso / AlfredIA) ; Whisper ; enregistrement ; vault ; Todo ; retirer Vapi/Google/Places/calendrier/ingest CLI |
| 12  | Permissions                 | 🚧 | **Spec faite.** Cross-platform ; micro + capture système ; retirer apple-events/calendrier ; signature macOS/Windows |
| 13  | Onboarding                  | 🚧 | **Spec faite.** Intro (2 slides) ; détection/intégration vault + création dossiers ; choix clé perso / AlfredIA ; test micro ; Whisper → Paramètres |
| 14  | Feedback                    | 🚧 | **Spec faite.** Onglet texte + images + email de contact ; catégories bug/feature/praise ; stockage Postgres via backend (consultation SQL) |
| 15  | Backend AlfredIA + Metrics  | ✅ | **Construit + validé en prod.** Rust/axum, **Coolify** (self-hosted), `api.alfred.do-now.io`, **Postgres**, Stripe 20€/mois (+ annuel) ; proxy, loopback, metrics, feedback |
| —   | Ingest « run Claude » (CLI) | ❌ | **Supprimé** — remplacé par l'ingestion API (spec 05) |

## Deux modes d'accès à l'IA

- **Clé perso** : l'utilisateur saisit sa clé API Anthropic (stockée dans `secrets.json`). Aucun compte.
- **AlfredIA** : abonnement Stripe → token AlfredIA (loopback auto, zéro copier-coller) → l'app appelle **notre proxy**, qui détient la vraie clé et compte l'usage.

## Metrics

ID d'installation **anonyme** (UUID local), **toujours actif**, **aucune PII**,
décorrélé de l'identité Stripe. Événements : `install_created`, `app_launched`,
`recording_completed` (mic/système), `ingestion_completed` (mode byo/alfredia),
`ai_request`. Envoi vers le backend (`/metrics`).

## Risques v1 en tête

1. **Backend AlfredIA** (proxy + Stripe + metrics) — **gate le lancement**, plus gros morceau, hors app desktop.
2. **Audio système sur Windows** — à coder (WASAPI loopback).
3. **Whisper par défaut, cross-platform** — build + packaging Windows, téléchargement du modèle au 1er lancement.

## Suivi des tâches

Backlog v1 dans **[`ROADMAP.md`](../ROADMAP.md)** (racine du repo) — checklist par
chantier, mise à jour au fil de l'eau. Nouveau besoin → écrire la spec d'abord,
puis ajouter la tâche.
