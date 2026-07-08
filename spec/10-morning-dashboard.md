# spec/10 — Accueil « Alfred » & UI

> **Statut v1 :** refonte. La home devient la page **« Alfred »**. Réf. visuelle :
> `spec/Images/page-accueil.png` (thème conservé, structure revue).

## Layout général

`[Sidebar 240px] | [Contenu]` — **plus de panneau droit** (calendrier retiré).
Topbar **sans barre de recherche**.

## Sidebar

- ✅ **Logo Alfred** en haut = **déclencheur d'enregistrement** (anim micro au hover).
  Clic → `start_recording` + redirection vers la **page de guidage** (`/recording`,
  spec/03). La carte d'enregistrement de l'accueil fait de même (second point
  d'entrée équivalent, cf spec/03).
- **Navigation v1** :

  | Icône | Label | Route |
  |---|---|---|
  | ✦ | **Alfred** | `/` |
  | ☑️ | Tâches | `/tasks` |
  | 📝 | Notes | `/notes` |
  | 🕸 | Graphe | `/graph` |
  | 💬 | Feedback | `/feedback` |
  | ⚙️ | Paramètres | `/settings` (épinglé en bas) |

- Section **« Récents »** (5 notes récemment modifiées — inchangé).
- **Retirés** : « Aujourd'hui » (fusionné dans Alfred), **Réunions**, **Calendrier**,
  **Actions IA** (suggestions hors v1).

## Topbar

- **Plus de recherche** (barre + `⌘K` retirés).
- **Bandeau d'enregistrement** (pendant l'enregistrement, persistant sur toute
  l'app) : **timer** + **visualisation du volume micro** + bouton **stop**.
- **Indicateur d'état Alfred** (remplace la cloche) — voir ci-dessous.
- Avatar + nom **Alfred** (menu profil).

### Indicateur d'état Alfred — ✅ fait

Ton « majordome », piloté par les événements réels (`recording-status-changed`,
`transcription-complete`, `ingestion-status-changed`) — `store/alfredStatusStore.ts` +
`<AlfredStatusIndicator/>` dans la Topbar (remplace la cloche) :

| État | Label |
|---|---|
| repos | À votre service |
| enregistrement | Tout ouïe… |
| transcription | Je prends note… |
| analyse (ingestion) | Je cogite… |

**Simplifié à 4 états** (v1) : « création des tâches » n'a pas de signal distinct
de « analyse » (une seule ingestion fusionnée, spec/05) — pas de 5ᵉ état fabriqué
sans événement réel derrière. Labels codés en dur pour l'instant (pas encore
éditables dans l'app).

## Page Alfred (`/`) — trois blocs

1. **« Aujourd'hui »** — ✅ brief quotidien (spec/05, `generate_daily_brief`/
   `get_daily_brief`) : titre + texte court Markdown (rendu via `BriefingContent`,
   wikilinks cliquables) + « Généré le {date} » + bouton **régénérer**. Auto-génération
   au premier chargement du jour si rien en cache. État vide : message d'accueil.
2. **Tâches** — ✅ bloc **dépliable** (`TasksSection`, `Dashboard.tsx`) : sections
   Prioritaire / En cours / À faire (regroupées depuis `Todo.md` par les en-têtes
   `## `, spec/06), cases à cocher, lien « voir toutes les tâches » → `/tasks`.
3. **Input Alfred** (chat, spec/07b) — 🚧 **teaser** fait (champ + exemples
   cliquables, `ChatTeaser`) mais envoie vers `/ai-actions` plutôt que de dérouler
   la conversation **sur la page** — l'historique/liste de conversations (section
   suivante) n'est pas fait, donc la conversation inline reste à construire avec.

### Chat — historique & liste des conversations

- **Historique conservé.** Un **2ᵉ niveau de navigation** sur la page Alfred liste
  les **conversations passées** (titre auto = 1ʳᵉ question + date) ; sélection →
  rouvre le fil ; bouton **nouvelle conversation**.
- Persistance : **local (SQLite)** — les chats sont de l'**état applicatif**, pas
  du contenu de vault. `À CONFIRMER` : SQLite vs fichiers vault (reco : SQLite).
- Chaque message via `ask_notes` (spec/07b) ; retour d'état via `chat-progress`
  (« recherche… » / « lecture… »).

### Exemples d'amorces (input Alfred)

Nombreux, cliquables (remplissent l'input), groupés par intention :
- *Résumer* : « Résume mes notes récentes » · « Résume ma dernière réunion »
- *Retrouver* : « Sur quoi ai-je travaillé cette semaine ? » · « Qu'a-t-on décidé sur [projet] ? »
- *Tâches* : « Quelles sont mes tâches en retard ? » · « Qui est responsable de quoi sur [projet] ? »
- *Préparer* : « Prépare-moi un point sur [personne/projet] »
- *Explorer* : « Quels sujets reviennent souvent dans mes notes ? »

## Déclenchement de l'enregistrement (rappel spec/03)

Logo Alfred (hover → micro animé) → `start_recording` → **page de guidage** liée à
l'enregistrement (conseils de captation + viz volume + timer). Bandeau d'état
pendant toute la durée.

## Design / palette

Thème doré existant conservé :
```css
--accent:#C8914A; --accent-hover:#B07D3A; --active-bg:#F5EDD8;
--bg:#F7F7F5; --card-bg:#FFFFFF; --sidebar-bg:#FFFFFF; --dark-card:#1C1C1C;
--text-primary:#1A1A1A; --text-secondary:#6B6B6B; --text-muted:#9B9B9B; --border:#E8E8E6;
```

## Routes v1

`/` Alfred · `/tasks` · `/notes` · `/graph` · `/feedback` · `/settings`.
**Supprimer** `/meetings`, `/calendar`, `/ai-actions`.

## Abonnements aux événements (App.tsx)

- `recording-status-changed` → bandeau + indicateur d'état
- `transcription-*` → indicateur + rafraîchir
- `ingestion_completed` → indicateur + rafraîchir todos/notes
- `notes-updated` → Récents
- `chat-progress` → état du chat

## Hors v1 / plus tard

Panneau calendrier, recherche globale `⌘K`, recherche vectorielle, chats stockés
dans le vault.
