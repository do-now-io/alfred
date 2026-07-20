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
| 02  | Calendar                    | 🕓 | **Hors v1** — code retiré (Phase D : modules `auth`/`calendar` supprimés, tables droppées) |
| 03  | Audio Recording             | 🚧 | Micro ✅ + **audio système Windows** (WASAPI loopback + mixed) ✅ + **import fichier audio (WAV)** ✅ ; trigger logo/bandeau + page de guidage + feedback live (volume, timer) ✅ ; **arrêt interruptible** (Annuler / pause / revue « prise terminée » + traitements aval optionnels) ✅ ; **reste : audio système macOS** (helper Swift) |
| 04  | Transcription               | ✅ | Whisper **par défaut** (Windows + macOS), `small` **embarqué** ; **qualité décodage** (beam + seuils) + **glossaire** + **transcription parallèle par tranches** sur les longs fichiers (spec 17) ; langue détectée stockée. Reste (mineur) : progression par segment (0/100 seulement) |
| 05  | AI Brain + Ingestion        | ✅ | **Ingestion fusionnée** (compte-rendu + tâches) ✅ à **sortie découplée** (`{summary, tasks}`, 1 appel conditionnel, rien de coché → pas d'appel) ✅ ; **ingestion augmentée** (analyse → écran `/resolve`) ✅ ; **chat (RAG)** + historique ✅ ; **brief quotidien** ✅ ; 2 modes d'accès ; **contexte interne** (spec 16) ✅ |
| 06  | Todos                       | ✅ | `Todo.md` = source unique ; table SQLite supprimée (migration 007) ; commandes refondues sur le fichier |
| 07  | Notes (vault)               | ✅ | Structure `alfred-*` ✅ ; skills/`.claude` retirés ✅ ; **frontmatter `project`/`participants` peuplés par l'ingestion** ✅ ; **regroupement par projet** (vue « Projets », dossiers virtuels) ✅. *Rangement physique par projet = hors v1* |
| 07b | Notes — Chat (RAG)          | ✅ | Construit (`ask_notes`) + spec faite |
| 07c | Notes — Graphe              | ✅ | Construit (`get_vault_graph`) + spec faite |
| 08  | Suggestions                 | 🕓 | **Hors v1** — code retiré (Phase D) |
| 09  | Phone Calls (Vapi)          | 🕓 | **Hors v1** — code retiré (Phase D) |
| 10  | Accueil « Alfred » & UI     | 🚧 | Brief + tâches (sections) + bandeau d'enregistrement + indicateur d'état + nav réduite (recherche retirée) ✅ ; **indicateur = où Alfred travaille** (cible active, point ambre = note traitée, majordome cliquable) ✅ ; **reste : historique/liste de conversations sur la page** |
| 11  | Settings                    | ✅ | **Construit.** Accès IA (clé perso / AlfredIA) ; Whisper ; enregistrement ; vault ; Todo ; Vapi/Google/Places/calendrier/ingest CLI retirés ; défauts `alfred-*` |
| 12  | Permissions                 | 🚧 | **Spec faite.** Cross-platform ; micro + capture système ; retirer apple-events/calendrier ; signature macOS/Windows |
| 13  | Onboarding                  | 🚧 | Intro (2 slides) + détection/création vault + choix clé perso / AlfredIA + test micro ✅ ; **visite guidée = contexte à la voix** (téléprompteur avec pause/revue → visite de l'app pendant la transcription → pop-up « vérifiez » → `/resolve` mode contexte → clôture) ✅ ; **contenu de démarrage (seed)** ✅ ; **reste : finitions du wizard** |
| 14  | Feedback                    | ✅ | **Construit.** Onglet texte + images (collage) + email de contact ; catégories bug/feature/praise ; stockage Postgres via backend. 🟡 **widget discret topbar** en cours (Tanguy) |
| 15  | Backend AlfredIA + Metrics  | ✅ | **Construit + validé en prod.** Rust/axum, **Coolify** (self-hosted), `api.alfred.do-now.io`, **Postgres**, Stripe 20€/mois (+ annuel) ; proxy, loopback, metrics, feedback. **Reste : recette du paiement** (sandbox rejouée de bout en bout, puis validation prod — jamais rejoué depuis le code) |
| 16  | Contexte interne            | ✅ | **Construit.** Note `Contexte Alfred.md` (contexte maison) injectée dans l'ingestion + Settings ; source du glossaire (spec 17). **Transcription live abandonnée** (code retiré) |
| 17  | Glossaire & qualité de transcription | ✅ | **Construit.** Glossaire (initial_prompt) dérivé de `Contexte Alfred.md` (régén auto) ; beam + seuils anti-hallucination ; **transcription parallèle par tranches** (longs fichiers) ; ingestion augmentée + écran `/resolve` ; contexte à la voix (onboarding) |
| 18  | Partage de notes            | ✅ | **Construit** (à déployer/tester en réel). `POST /share` + `GET /s/{slug}` (rendu comrak **mode sûr**, `noindex`, CSP) + `PUT`/`DELETE` ; bouton **Partager** (Notes + Tâches) → URL publique par lien, révocable, re-partage = même URL. Tout en Postgres |
| 19  | Site web (`alfred.do-now.io`) | 📝 | **Rien n'existe** — le footer des pages partagées (spec 18) pointe déjà vers ce domaine, mais aucun site (landing/marketing) n'est construit ni spécifié. Spec à écrire (contenu, hébergement) avant de coder |
| 20  | Rendre le projet open source | 📝 | **Pas encore spécifié** — licence, ce qui reste privé (secrets Coolify/Stripe/clés déjà hors repo) vs code publié, dépôt cible. Décisions produit/légales à prendre avant d'écrire la spec |
| 21  | Internationalisation (FR / EN) | 📝 | **Spec écrite, rien de codé.** Traduction **entière** de l'app en anglais + **choix de la langue à l'installation** (`app_language`, modifiable en Réglages) ; langue des sorties IA ≠ langue UI ; templates/`Todo.md` à découpler du libellé (feedback tests) |
| —   | Ingest « run Claude » (CLI) | ❌ | **Supprimé** — remplacé par l'ingestion API (spec 05) |

## Deux modes d'accès à l'IA

- **Clé perso** : l'utilisateur saisit sa clé API Anthropic (stockée dans `secrets.json`). Aucun compte.
- **AlfredIA** : abonnement Stripe → token AlfredIA (loopback auto, zéro copier-coller) → l'app appelle **notre proxy**, qui détient la vraie clé et compte l'usage.

## Metrics

ID d'installation **anonyme** (UUID local), **toujours actif**, **aucune PII**,
décorrélé de l'identité Stripe. Événements : `install_created`, `app_launched`,
`recording_completed` (mic/système), `ingestion_completed` (mode byo/alfredia),
`ai_request`. Envoi vers le backend (`/metrics`).

## Risques v1 — statut

Les 3 risques qui gataient le lancement sont **levés** :

1. ✅ **Backend AlfredIA** (proxy + Stripe + metrics) — construit, validé en prod (Coolify).
2. ✅ **Audio système Windows** (WASAPI loopback + mixed) — fait, testé. Reste **macOS** (helper Swift ScreenCaptureKit), non commencé.
3. ✅ **Whisper par défaut, cross-platform** — feature par défaut + modèle `small` embarqué, installeurs Windows testés (transcription offline dès le 1er lancement).

Le **moteur** (capture, transcription, IA, notes, backend) et la **Phase C (UX/écrans)** sont désormais **largement construits**. **Ce qui reste pour une v1 livrable** :

1. ⚠️ **Packaging & signature** — **macOS** (entitlements + Developer ID + notarisation) et **Windows** (signature Authenticode) : **le plus gros bloc restant** (Phase E), gate la distribution aux ~10 users.
2. ⚠️ **Audio système macOS** (helper Swift ScreenCaptureKit) — non commencé.
3. 🟡 **Finitions UX** : onboarding (wizard), accueil (historique chat sur la page), widget feedback.
4. 🟡 **Déployer + tester** le partage de notes (spec 18).
5. ❌ Optionnel : regroupement des notes **par projet** (spec 07).

## Suivi des tâches

Backlog v1 dans **[`ROADMAP.md`](../ROADMAP.md)** (racine du repo) — checklist par
chantier, mise à jour au fil de l'eau. Nouveau besoin → écrire la spec d'abord,
puis ajouter la tâche.
