# Alfred — Spécifications

Source de vérité fonctionnelle et technique d'Alfred. Chaque `NN-*.md` décrit un
module.

**La v1 cross-platform (Windows + macOS)** a été livrée à ~10 utilisateurs test.
On est désormais en **post-v1** : itération sur les retours + nouveaux chantiers
(Phase G+ du ROADMAP, ex. contexte par projet).

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
| 02  | Calendar                    | 🕓 | **Hors v1** — code retiré (Phase D : modules `auth`/`calendar` supprimés, tables droppées) ; reconnexion + affichage envisagés post-v1 (ROADMAP Phase G) |
| 03  | Audio Recording             | ✅ | Micro ✅ + **audio système Windows** (WASAPI loopback + mixed) ✅ + **audio système macOS** (helper Swift) ✅ + **import fichier audio (WAV)** ✅ ; trigger logo/bandeau + page de guidage + feedback live (volume, timer) ✅ ; **arrêt interruptible** (Annuler / pause / revue « prise terminée » + traitements aval optionnels) ✅ |
| 04  | Transcription               | ✅ | Whisper **par défaut** (Windows + macOS), `small` **embarqué** ; **qualité décodage** (beam + seuils) + **glossaire** + **transcription parallèle par tranches** sur les longs fichiers (spec 17) ; langue détectée stockée ; **progression pondérée par tranche** (`transcription-progress`, feedback tests) |
| 05  | AI Brain + Ingestion        | ✅ | **Ingestion fusionnée** (compte-rendu + tâches) ✅ à **sortie découplée** (`{summary, tasks}`, 1 appel conditionnel, rien de coché → pas d'appel) ✅ ; **ingestion augmentée** (analyse → écran `/resolve`) ✅ ; **chat (RAG)** + historique ✅ ; **brief quotidien** ✅ ; 2 modes d'accès ; **contexte interne** (spec 16) ✅ |
| 06  | Todos                       | ✅ | `Todo.md` = source unique ; table SQLite supprimée (migration 007) ; commandes refondues sur le fichier |
| 07  | Notes (vault)               | ✅ | Structure `alfred-*` ✅ ; skills/`.claude` retirés ✅ ; **frontmatter `project`/`participants` peuplés par l'ingestion** ✅ ; **regroupement par projet** (vue « Projets », dossiers virtuels) ✅. *Rangement physique par projet = hors v1*. **Reste (post-v1, spec écrite) : renommage/fusion/suppression de projet** |
| 07b | Notes — Chat (RAG)          | ✅ | Construit (`ask_notes`) + spec faite |
| 07c | Notes — Graphe              | ✅ | Construit (`get_vault_graph`) + spec faite |
| 08  | Suggestions                 | 🕓 | **Hors v1** — code retiré (Phase D) |
| 09  | Phone Calls (Vapi)          | 🕓 | **Hors v1** — code retiré (Phase D) |
| 10  | Accueil « Alfred » & UI     | ✅ | Brief + tâches (sections) + bandeau d'enregistrement + indicateur d'état + nav réduite (recherche retirée) ✅ ; **indicateur = où Alfred travaille** (cible active, point ambre = note traitée, majordome cliquable) ✅ ; **historique/liste de conversations** dans le panneau chat (persistance SQLite, migration 006) ✅ |
| 11  | Settings                    | ✅ | **Construit.** Accès IA (clé perso / AlfredIA) ; Whisper ; enregistrement ; vault ; Todo ; Vapi/Google/Places/calendrier/ingest CLI retirés ; défauts `alfred-*` |
| 12  | Permissions                 | 🚧 | **Spec faite.** Cross-platform ; micro + capture système ; retirer apple-events/calendrier ; signature macOS ✅ / Windows ✅ — **notarisation macOS bloquée** |
| 13  | Onboarding                  | ✅ | Intro (2 slides) + détection/création vault + choix clé perso / AlfredIA + test micro ✅ ; **visite guidée = contexte à la voix** (téléprompteur avec pause/revue → visite de l'app pendant la transcription → pop-up « vérifiez » → `/resolve` mode contexte → clôture) ✅ ; **contenu de démarrage (seed)** ✅ ; **écran de fin habillé** (aperçu de `/recording`) ✅. Détail mineur non tranché dans spec/13 (étape 8 « Contexte », chevauchement avec la carte d'intro de la visite) |
| 14  | Feedback                    | ✅ | **Construit.** Onglet texte + images (collage) + email de contact ; catégories bug/feature/praise ; stockage Postgres via backend. **Widget discret topbar** fait (Tanguy) |
| 15  | Backend AlfredIA + Metrics  | ✅ | **Construit + validé en prod.** Rust/axum, **Coolify** (self-hosted), `api.alfred.do-now.io`, **Postgres**, Stripe 20€/mois (+ annuel) ; proxy, loopback, metrics, feedback. Le code/la spec vivent désormais dans le **repo privé `alfred-backend`** (plus de `spec/15-*.md` ici). **Recette du paiement faite** (sandbox bout-en-bout + validation prod) |
| 16  | Contexte interne            | ✅ | **Construit.** Note `Contexte Alfred.md` (contexte maison) injectée dans l'ingestion + Settings ; source du glossaire (spec 17). **Transcription live abandonnée** (code retiré) |
| 17  | Glossaire & qualité de transcription | ✅ | **Construit.** Glossaire (initial_prompt) dérivé de `Contexte Alfred.md` (régén auto) ; beam + seuils anti-hallucination ; **transcription parallèle par tranches** (longs fichiers) ; ingestion augmentée + écran `/resolve` ; contexte à la voix (onboarding) |
| 16b | Contexte par projet          | ✅ | **Post-v1, construit.** Scinde le contexte appris entre global (`Contexte Alfred.md`) et par projet (`alfred-intelligence/<Projet>.md`, une note par projet, `type: context`) ; nouveau champ "Projets concernés" sur `/resolve` ; renommage de projet reste une tâche séparée (ROADMAP Phase G) |
| 18  | Partage de notes            | ✅ | **Construit et testé en réel.** `POST /share` + `GET /s/{slug}` (rendu comrak **mode sûr**, `noindex`, CSP) + `PUT`/`DELETE` ; bouton **Partager** (Notes + Tâches) → URL publique par lien, révocable, re-partage = même URL. Tout en Postgres |
| 19  | Site web (`alfred.do-now.io`) | ✅ | **Fait.** |
| 20  | Rendre le projet open source | ✅ | **Décisions produit/légales prises.** |
| 21  | Internationalisation (FR / EN) | ✅ | **Construit.** Traduction **entière** de l'app en anglais + **choix de la langue à l'installation** (`app_language`, modifiable en Réglages) ; langue des sorties IA ≠ langue UI ; catalogues `t()` sans chaîne en dur. **Dette restante disclosed** (spec/21) : erreurs backend pas encore sur catalogue de codes, titres `Contexte Alfred.md` et nouvelles sections `Todo.md` restés FR-only |
| 22  | Alfred agentique (actions) | ✅ | **Construit.** Alfred passe de lecture seule à **agent** : 15 outils de mutation notes/tâches (créer/éditer/renommer/**archiver**) via le chat, réutilisant les commandes existantes. **« Supprimer » = archiver** (jamais de suppression dure par l'IA) ; confirmation pour les **lots/écrasements** (carte Appliquer/Annuler) ; Réglages/app + suppression dure hors périmètre v1. Résidu connu : les requêtes `search_notes` choisies par Claude restent parfois en français même en UI anglaise |
| 23  | Liens internes & navigation | ✅ | **Construit.** Gestionnaire de lien **unique** (`useInternalLink`) : note→note via `openNoteByRef`, **tâche via schéma `task:`** → Kanban surligné, `http(s)` externe ; compte-rendu → liste de tâches cliquables ; échec = toast visible. Couvre preview note / brief / Kanban / fiche tâche / sources chat / Récents. Gap connu, non bloquant : pas de repli sur le titre frontmatter pour `wikilink:` (résolution par nom de fichier uniquement) |
| 24  | E-mails — connexion & extraction | 🕓 | **Post-v1, spec à écrire** — connecter la boîte mail : extraction de tâches (→ `Todo.md`, provenance), rattachement des mails aux **projets**, contexte pour ingestion/chat/brief. Pivot de la vision « projets unifiés » (ROADMAP Phase G) |
| 25  | Collaboration sur notes partagées | 🕓 | **Post-v1, spec à écrire** — commentaires (temps 1) puis ajout/modification (temps 2) sur les notes partagées ; comptes utilisateurs / droits / suivi des modifications à trancher. Étend spec/18 (ROADMAP Phase G) |
| 26  | App mobile                  | 🕓 | **Post-v1, spec à écrire** — consultation des notes + enregistrement depuis le téléphone ; transcription on-device vs serveur à trancher, sync du vault, stack (ROADMAP Phase G) |
| 27  | Mise à jour automatique      | 📝 | **Post-v1, spec écrite, rien de codé.** `tauri-plugin-updater`, clé de signature dédiée, `latest.json` hébergé sur la release GitHub, bandeau + Réglages. Dépend de la notarisation macOS (Phase E, en pause) pour une UX propre sur macOS |
| —   | Ingest « run Claude » (CLI) | ❌ | **Supprimé** — remplacé par l'ingestion API (spec 05) |

## Deux modes d'accès à l'IA

- **Clé perso** : l'utilisateur saisit sa clé API Anthropic (stockée dans `secrets.json`). Aucun compte.
- **AlfredIA** : abonnement Stripe → token AlfredIA (loopback auto, zéro copier-coller) → l'app appelle **notre proxy**, qui détient la vraie clé et compte l'usage.

## Metrics

ID d'installation **anonyme** (UUID local), **toujours actif**, **aucune PII**,
décorrélé de l'identité Stripe. Événements : `install_created`, `app_launched`,
`recording_completed` (mic/système), `ingestion_completed` (mode byo/alfredia),
`ai_request`. Envoi vers le backend (`/metrics`).

## Statut v1 — livrée

**La v1 est livrée** aux ~10 utilisateurs test. Les 3 risques qui gataient le
lancement sont **levés** :

1. ✅ **Backend AlfredIA** (proxy + Stripe + metrics) — construit, validé en prod (Coolify).
2. ✅ **Audio système** Windows (WASAPI loopback + mixed) et macOS (helper Swift ScreenCaptureKit) — fait, testé.
3. ✅ **Whisper par défaut, cross-platform** — feature par défaut + modèle `small` embarqué, installeurs Windows testés (transcription offline dès le 1er lancement).

**Reste ouvert (non bloquant pour la distribution actuelle)** :

- ⚠️ **Notarisation macOS** — Developer ID ✅, notarisation **bloquée** (Phase E) — en pause pour le moment.

On est maintenant en **post-v1** — voir Phase G+ du [`ROADMAP.md`](../ROADMAP.md)
pour les chantiers en cours (ex. contexte par projet).

## Suivi des tâches

Backlog v1 dans **[`ROADMAP.md`](../ROADMAP.md)** (racine du repo) — checklist par
chantier, mise à jour au fil de l'eau. Nouveau besoin → écrire la spec d'abord,
puis ajouter la tâche.
