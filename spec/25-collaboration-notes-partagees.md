# spec/25 — Collaboration sur notes partagées (édition + commentaires)

> **Statut :** 📝 spec écrite, rien de codé. Post-v1, étend spec/18 (partage de
> notes). **Le plus gros chantier du backlog post-v1** — bascule le partage
> d'un instantané en lecture (rendu statique) vers un **document collaboratif
> en direct** (façon Google Docs, édition anonyme par lien).

## Vue d'ensemble

Aujourd'hui (spec/18), partager une note produit une **page statique** rendue
côté serveur, mise à jour uniquement par un `PUT` manuel depuis l'app
(re-partage). Cette spec change le modèle : quand le lien le permet, un
visiteur **anonyme** peut **éditer en direct** le document (comme "Toute
personne disposant du lien peut modifier" sur Google Docs), et **commenter**
dans un panneau séparé. Les modifications restent côté backend jusqu'à ce que
le propriétaire choisisse explicitement de les **rapatrier** dans son vault
local — jamais automatique.

## 1. Deux niveaux de lien (vue vs édition)

- `shares` gagne deux slugs distincts par partage : **`view_slug`** (lecture
  seule, comportement inchangé de spec/18) et **`edit_slug`** (lecture +
  écriture + commentaires). Le propriétaire choisit lequel il envoie —
  **deux boutons** dans l'app : "Copier le lien (lecture)" / "Copier le lien
  (édition)".
- Les deux slugs pointent vers le **même contenu** (`shares.markdown`) — ce
  n'est pas un fork, juste deux portes d'entrée avec des droits différents.
- `manage_token` (propriétaire) reste distinct des deux — lui seul peut
  révoquer/supprimer des commentaires.

## 2. Édition en direct — décision d'architecture

**Pas de moteur collaboratif temps réel complet (OT/CRDT type Yjs)** pour
cette v1 — décision explicite pour rester dans l'esprit "volontairement
minimal" de spec/18 et ne pas ajouter une brique d'infra (serveur
WebSocket + moteur de fusion) au backend axum/Postgres actuel. À la place,
un modèle **beaucoup plus simple**, qui couvre déjà l'usage réel (edits
rarement simultanés à la seconde près) :

- **Page d'édition** (`GET /s/{edit_slug}/edit`) : éditeur Markdown en
  page (CodeMirror, comme l'éditeur desktop) chargé dans le navigateur —
  toujours **auto-porté** (pas de dépendance externe, cohérent avec spec/18).
- **Autosave débouncée** : `PUT /share/{slug}/content` envoyé ~2-3 s après
  la dernière frappe (pas à chaque caractère).
- **Détection de collision simple (pas de fusion)** : `shares` gagne un
  compteur **`version`** (int, incrémenté à chaque écriture). Le client
  garde la version chargée ; s'il tente d'écrire avec une version périmée
  (un autre éditeur a sauvegardé entre-temps), le serveur **refuse**
  (409) → le client recharge le contenu à jour (perd sa frappe en cours,
  rare en pratique) plutôt que d'écraser silencieusement le travail de
  quelqu'un d'autre.
- **Rafraîchissement en tâche de fond** : polling léger (ex. toutes les 5 s)
  pendant que la page d'édition est ouverte, pour limiter la fenêtre de
  collision — **pas de WebSocket**, pas de curseurs live d'autres personnes
  affichés (contrairement à Google Docs) — décision de scope explicite,
  vraie "présence" collaborative serait un chantier bien plus gros, à
  reconsidérer seulement si ce modèle simple se révèle insuffisant en usage
  réel.

## 3. Identité des contributeurs

- **Anonyme par défaut**, avec un **champ optionnel "Votre nom"** (texte
  libre, non vérifié) — proposé à la 1ʳᵉ frappe dans l'éditeur ou au 1ᵉʳ
  commentaire, mémorisé en `localStorage` du navigateur du visiteur pour ne
  pas le redemander à chaque fois sur le même appareil.
- **Aucune authentification réelle** — cohérent avec le modèle "public par
  lien" existant. Le nom sert à l'attribution affichée, pas à la sécurité.

## 4. Commentaires — panneau séparé

- **UI** : la page de partage (vue et édition) gagne un **onglet séparé à
  droite** ("Document" / "Commentaires") — pas un fil mêlé au contenu, deux
  panneaux distincts.
- **Fil plat** (pas d'ancrage par paragraphe) : liste chronologique,
  `{author_name?, body, created_at}`.
- **Disponible sur les deux types de lien** (vue et édition) — un visiteur
  en lecture seule peut quand même commenter, seule l'édition du **contenu**
  est réservée au lien édition.
- **Nouvelle table Postgres** `share_comments (id, slug, author_name,
  body, created_at)`.
- **Modération** : le propriétaire (via `manage_token`) peut **supprimer un
  commentaire précis** — `DELETE /share/{slug}/comments/{comment_id}`.

## 5. Notification du propriétaire

- **Décision actée : oui, une notification.** Cohérent avec le pattern déjà
  retenu pour les mises à jour (spec/27) et les mails (spec/24) : vérifié **au
  démarrage de l'app** (pas de push temps réel). Nouveau champ sur le suivi
  local des partages (`note_shares`, spec/18) : `last_seen_version` /
  `last_seen_comment_count`. Un **badge** (compteur) apparaît sur le bouton
  Partager de la note concernée + une entrée récapitulative si plusieurs
  partages ont du nouveau (Réglages → Partages, ou notification dans le
  bandeau existant, à trancher au design UI).
- Comparaison simple : `version` du document et/ou nombre de commentaires
  côté serveur vs. la dernière valeur vue localement.

## 6. Rapatriement dans le vault local — jamais automatique

- **Bouton explicite** "Récupérer les modifications" (écran Notes, à côté de
  "Partager"/"Copier le lien") — **uniquement quand une nouvelle version
  existe côté serveur** (§5).
- Au clic : récupère `shares.markdown` à jour et **remplace** le contenu de
  la note locale (`update_note_file`).
- **Garde-fou simple (pas de fusion à 3 voies)** : si le fichier local a été
  modifié **après** le dernier partage/récupération (mtime), avertir
  explicitement (`window.confirm`, même pattern que le reste de l'app) :
  « Vous avez aussi modifié cette note localement depuis le dernier partage —
  récupérer la version en ligne écrasera vos changements locaux. Continuer ? »
  Pas de fusion automatique des deux versions (hors scope, complexité de
  diff Markdown non triviale) — l'utilisateur choisit consciemment.

## 7. Sécurité / abus

- **`edit_slug`** doit être **au moins aussi imprévisible** que `view_slug`
  existant (≥128 bits) — donner le lien d'édition, c'est donner un vrai
  droit d'écriture, pas juste de lecture.
- **Rate-limit** sur `PUT /share/{slug}/content` et `POST
  .../comments` (réutilise le rate-limit existant par IP/clé app, spec/18).
- **Cap de taille** inchangé (`SHARE_MAX_BYTES`).
- Toujours **HTML sanitisé** au rendu (contenu = entrée non fiable, y
  compris ce qu'un éditeur anonyme vient d'écrire).

## Endpoints backend (ajouts à spec/18, repo privé `alfred-backend`)

| Endpoint | Rôle |
|---|---|
| `PUT /share/{slug}/content` | body `{ markdown, version }` (via `edit_slug`) → 200 + nouvelle `version`, ou 409 si périmé |
| `GET /share/{slug}/content` | poll léger : `{ markdown, version }` |
| `GET /share/{slug}/comments` | liste des commentaires |
| `POST /share/{slug}/comments` | `{ author_name?, body }` → ajoute (vue ou édition) |
| `DELETE /share/{slug}/comments/{id}` | `manage_token` → supprime |

## Données (PostgreSQL, ajouts)

- `shares` gagne : `view_slug`, `edit_slug` (remplace l'unique `slug`
  actuel — migration), `version INT DEFAULT 1`.
- Nouvelle table `share_comments (id SERIAL PRIMARY KEY, slug TEXT
  REFERENCES shares, author_name TEXT, body TEXT, created_at TIMESTAMPTZ
  DEFAULT now())`.

## Commandes Tauri / app (ajouts à spec/18)

| Commande | Rôle |
|---|---|
| `get_share_edit_link(note_path) -> ShareLink` | récupère/génère le lien d'édition |
| `check_share_updates() -> Vec<ShareUpdate>` | au démarrage — versions/comptes de commentaires vs. `last_seen_*` local |
| `pull_share_changes(note_path)` | rapatrie le markdown à jour dans la note locale (§6) |
| `delete_share_comment(slug, comment_id)` | modération (`manage_token`) |

## Hors scope (explicite)

- **Vrai temps réel multi-curseurs** (OT/CRDT, WebSocket) — décision actée
  §2, à reconsidérer seulement si le modèle simple s'avère insuffisant.
- **Fusion automatique** des changements locaux vs. distants — avertissement
  + écrasement conscient uniquement (§6).
- **Commentaires ancrés par paragraphe/sélection** — fil plat uniquement (§4).
- **Historique des versions** (revenir à une version antérieure) — seule la
  dernière version compte, pas de journal.
