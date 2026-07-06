# spec/10 — Accueil « Alfred » & UI

> **Statut v1 :** refonte. La home devient la page **« Alfred »**. Réf. visuelle :
> `spec/Images/page-accueil.png` (thème conservé, structure revue).

## Layout général

`[Sidebar 240px] | [Contenu]` — **plus de panneau droit** (calendrier retiré).
Topbar **sans barre de recherche**.

## Sidebar

- **Logo Alfred** en haut = **déclencheur d'enregistrement** (anim micro au hover).
  Clic → `start_recording` + redirection vers la **page de guidage** (spec/03).
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

### Indicateur d'état Alfred

Ton « majordome », piloté par les événements (`recording-status-changed`,
`transcription-*`, `ingestion_completed`) ; labels éditables dans l'app :

| État | Label |
|---|---|
| repos | À votre service |
| enregistrement | Tout ouïe… |
| transcription | Je prends note… |
| analyse (ingestion) | Je cogite… |
| création des tâches | Je mets de l'ordre… |

## Page Alfred (`/`) — trois blocs

1. **« Aujourd'hui »** — brief quotidien (spec/05) : titre + texte court Markdown +
   « Généré le {date} » + bouton **régénérer**. État vide (aucune donnée) : message
   d'accueil incitant à enregistrer ou écrire.
2. **Tâches** — bloc **dépliable** : sections Prioritaire / En cours / À faire
   (depuis `Todo.md`, spec/06), cases à cocher, lien « voir toutes les tâches » → `/tasks`.
3. **Input Alfred** (chat, spec/07b) — champ de saisie + **exemples cliquables**.
   La conversation se déroule **sur la page** (fil qui se déploie sous l'input).

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
