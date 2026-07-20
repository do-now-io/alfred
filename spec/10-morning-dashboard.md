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
- **Navigation v1** — ✅ fait (`App.tsx`) :

  | Icône | Label | Route |
  |---|---|---|
  | 🏠 | Aujourd'hui | `/` |
  | ☑️ | Tâches | `/tasks` |
  | 📝 | Notes | `/notes` |
  | 🕸 | Graphe | `/graph` |
  | ✦ | Alfred | `/ai-actions` |
  | 💬 | Feedback | `/feedback` |
  | ⚙️ | Paramètres | `/settings` (épinglé en bas) |

  **Écart assumé** : la cible ci-dessus fusionnait « Alfred » sur `/` (chat
  intégré à l'accueil). Tant que l'historique/liste de conversations (item
  séparé de la ROADMAP) n'est pas fait, **`/ai-actions` reste une route à part**
  pour porter la conversation complète — le teaser de chat de l'accueil y renvoie
  (spec/10 §Page Alfred). Fusion à faire quand l'historique atterrira.
- Section **« Récents »** (5 notes récemment modifiées — inchangé).
- ✅ **Retirés** : `/meetings`, `/calendar` (routes mortes, aucun lien nav ne les
  atteignait déjà — supprimées avec `Placeholder.tsx`). Pas de « Actions IA »
  distinct trouvé dans le code actuel (le nav « Alfred » d'aujourd'hui est déjà le
  chat, pas les suggestions hors v1 — rien à retirer de plus ici).

## Topbar

- ✅ **Plus de recherche** (barre + `⌘K` retirés). Ne concerne que la recherche
  **globale** (multi-fichiers) : la recherche **locale au fichier courant**
  (Ctrl/Cmd+F dans l'éditeur de note, filtre texte du Kanban Tâches) est en v1
  — voir spec/07 et spec/06.
- **Bandeau d'enregistrement** (pendant l'enregistrement, persistant sur toute
  l'app) : **timer** + **visualisation du volume micro** + bouton **stop**.
- **Indicateur d'état Alfred** (remplace la cloche) — voir ci-dessous.
- ~~Avatar + nom **Alfred** (menu profil)~~ → **retiré** (✅ fait, feedback tests).
  Le menu haut-droite était un **placeholder vide et ambigu** (ni compte utilisateur,
  ni compte Alfred) et faisait doublon avec les **Réglages** (bas-gauche). On le
  **supprime**. Le **profil local** (prénom/avatar) et le **compte / abonnement IA**
  vivent dans les **Réglages** (spec/11).

### Indicateur d'état Alfred — ✅ fait (ajusté après test)

Ton « majordome », piloté par les événements réels (`recording-status-changed`,
`transcription-complete`, `ingestion-status-changed`) — `store/alfredStatusStore.ts`.
**Affiché sous le logo Alfred** (haut de la sidebar), qui est LA lecture d'état
unique de l'app — la pastille Topbar initiale a été retirée après test (doublon
avec le bandeau : « Transcription en cours… » + « Je prends note… » côte à côte).
Le bandeau Topbar ne s'affiche plus que **pendant** l'enregistrement (timer +
volume + stop) et sur erreur :

| État | Label |
|---|---|
| repos | À votre service |
| enregistrement | Tout ouïe… |
| transcription | Je prends note… |
| analyse (ingestion) | Je cogite… |
| **création des tâches** (✅ fait) | **Je note les tâches…** |

**5ᵉ état = phase de l'ingestion (✅ fait, feedback tests).** L'ingestion étant
désormais **découplée** (spec/05, `{summary, tasks}`), elle émet des **phases**
(`analyzing` → `summary` → `tasks`). La phase `tasks` pilote un label distinct
**« Je note les tâches… »** — l'utilisateur voit enfin qu'Alfred crée les tâches
(constat test). L'appel IA restant unique, la phase `tasks` est **brève** (écriture
seule), donc le label est court mais honnête. Vaut aussi en **ré-ingestion**
(single + lot). Labels codés en dur pour l'instant (pas encore éditables).

### Indicateur d'état = où Alfred travaille — ✅ fait (feedback tests)

Deux évolutions demandées pour que l'état ne dise pas seulement *quoi*, mais aussi
*sur quoi* :

1. **Le point ambre d'une note = la note qu'Alfred traite en ce moment** (et **non**
   « note sélectionnée »). Aujourd'hui, dans les **Récents** (`App.tsx`, `Recents()`)
   et les listes de notes, le point ambre double le **highlight** de la note ouverte
   (`item.path === selectedPath`) — redondant. On le **réaffecte** : le point marque
   la note sur laquelle Alfred est en train de travailler —
   - **transcription** → la note brute d'enregistrement (`alfred-raw/`, celle datée
     en cours de transcription),
   - **analyse (ingestion)** → la note / le compte-rendu en cours de rédaction,
   - **contexte** (visite guidée, spec/13) → `Contexte Alfred.md`.

   La sélection reste indiquée par le seul **highlight**. Le point n'apparaît que
   quand une cible existe (la note brute apparaît à `transcription-complete` ; avant,
   pas de point).
2. **Cliquer l'indicateur majordome navigue vers ce qu'Alfred fait.** Le libellé
   sous le logo (« Je cogite… », « Je prends note… », …) devient **cliquable** et
   amène sur la cible courante (la note en cours de traitement, ou l'écran concerné :
   `/notes` sur la note, `/resolve` si une session de correction est ouverte, etc.).
   Au repos (« À votre service »), non cliquable.

**Impact technique** : `alfredStatusStore` ne porte aujourd'hui qu'un `state`. Il
faut lui ajouter une **cible active** — p. ex. `{ state, targetPath?, targetRoute?,
recordingId? }` — alimentée par les mêmes événements (`recording-status-changed`,
`transcription-complete`, `ingestion-status-changed`, `context-status-changed`),
en résolvant le `recording_id` → chemin de note dès qu'elle existe. Le point ambre
et le clic lisent cette cible.

## Page Alfred (`/`) — trois blocs (état actuel, à fusionner — voir cible ci-dessous)

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
   ✅ **Dictée vocale** de la question (bouton micro dans la barre de
   saisie, ici et dans `ChatPanel` — voir spec/07b §Dictée vocale).

### Cible — fusion Alfred/Aujourd'hui, layout 2 colonnes — 📝 à faire

Le nav (§Sidebar) fusionne « Alfred » sur `/` : `/ai-actions` disparaît comme
route à part, et `/` devient la conversation Alfred elle-même — **layout 2
colonnes** plutôt que les trois blocs empilés ci-dessus :
- **Colonne gauche : conversation Alfred** — l'input + historique de chat
  (`ChatPanel`, spec/07b) qui vit aujourd'hui sur `/ai-actions`.
- **Colonne droite : prise de note & résumé** — brief quotidien + bloc tâches
  (les deux premiers blocs actuels), en lecture/consultation pendant qu'on
  discute avec Alfred dans l'autre colonne.

Dépend de l'historique de conversations déjà fait (§ci-dessous) — le blocage
initial (pas d'historique) est levé, cette fusion peut être reprise.

### Chat — historique & liste des conversations — ✅ fait

- **Historique conservé.** Un **2ᵉ niveau de navigation** (colonne gauche de la
  page chat, `ConversationList` dans `ChatPanel.tsx`) liste les **conversations
  passées** (titre auto = 1ʳᵉ question tronquée à 60 caractères, + date) ;
  sélection → rouvre le fil ; bouton **Nouvelle conversation** ; suppression
  par conversation (poubelle + confirmation).
- Persistance : **SQLite confirmé** (migration `006_chat_history` — tables
  `chat_conversations` + `chat_messages`, sources citées conservées en JSON).
  Les chats sont de l'état applicatif, pas du contenu de vault.
- Chaque message via `ask_notes` (spec/07b) — la commande prend désormais un
  `conversation_id` optionnel, **enregistre l'échange** (question + réponse +
  sources) et renvoie l'id de conversation (créée au 1ᵉʳ échange). L'écriture
  d'historique est *best-effort* : un échec de persistance ne perd jamais la
  réponse. Retour d'état via `chat-progress` (« recherche… » / « lecture… »).
- L'input de l'accueil (`ChatTeaser`) démarre toujours une **nouvelle**
  conversation avant d'envoyer.

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

## Voix du majordome — 📝 à faire

Le ton « majordome » n'existe aujourd'hui que sur les **labels d'état**
(« À votre service », « Tout ouïe… », « Je prends note… », « Je cogite… », « Je
note les tâches… » — §Indicateur d'état ci-dessus). Le reste des textes de
l'app (placeholders, boutons, messages d'erreur, confirmations, onboarding,
emails/notifications) reste au ton neutre habituel d'un logiciel. À faire :
**passe de relecture éditoriale** sur l'ensemble des textes visibles pour
qu'Alfred parle **comme un vrai majordome** de bout en bout, pas seulement à
l'indicateur d'état — tout en restant sobre (pas de sur-jeu qui nuit à la
lisibilité d'un message d'erreur, par ex.).

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
