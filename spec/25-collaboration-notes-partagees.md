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

## 2. Édition en direct — moteur CRDT (Yjs/yrs)

**Décision actée : vrai temps réel, avec curseurs live**, comme Google Docs
— pas un simple autosave avec détection de collision. Choix technique après
étude de l'écosystème existant (pas besoin de réinventer un moteur de
fusion) :

- **[`yrs`](https://docs.rs/yrs)** — port Rust du CRDT Yjs (la référence du
  domaine pour l'édition collaborative sans serveur d'autorité centrale).
- **[`yrs-axum`](https://crates.io/crates/yrs-axum)** — intégration
  WebSocket du protocole Yjs directement sur **axum** (le backend
  `alfred-backend` existant, pas un nouveau service à côté) — avec un
  binding déjà fait pour **CodeMirror 6**, l'éditeur déjà utilisé partout
  côté desktop (spec/07). La page d'édition web réutilise donc la même
  brique d'édition que l'app, pas un nouvel éditeur à écrire.
- **Persistance** : ni `yrs` ni `yrs-axum` n'ont de connecteur Postgres
  natif (ils ciblent SQLite/S3 dans l'écosystème `yrs-persistence`) — pas
  un problème : le document Yjs se **sérialise en binaire** et se
  snapshot **périodiquement** (débounce, ex. quelques secondes après la
  dernière modification) dans `shares.markdown` (colonne `BYTEA` en plus
  du texte rendu, ou remplace le `TEXT` actuel — à trancher à
  l'implémentation), cohérent avec "tout en Postgres" (spec/18).
- **Alternative de repli** si `yrs-axum` s'avère trop jeune/instable en
  pratique : **[`hocuspocus-rs`](https://github.com/jagtesh/hocuspocus-rs)**
  (protocole Hocuspocus, plus balisé côté écosystème JS historique, mais
  adopte plus de protocole en plus).
- **Page d'édition** (`GET /s/{edit_slug}/edit`) : ouvre une connexion
  WebSocket vers le backend, CodeMirror 6 + binding Yjs synchronise les
  frappes en direct entre tous les éditeurs connectés à ce moment — **avec
  curseurs des autres participants visibles** (couleur + nom si renseigné,
  §3), comme Google Docs.
- **Résolution de conflit gérée par le CRDT** — plus de notion de
  "version périmée"/409 à gérer côté app : c'est tout l'intérêt du CRDT,
  deux personnes qui tapent en même temps voient leurs modifications
  fusionnées automatiquement, sans perte, sans confirmation.

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
  démarrage de l'app** (pas de push temps réel) — indépendant du WebSocket
  temps réel de §2, qui ne tourne que pendant qu'une page d'édition est
  ouverte dans un navigateur, pas depuis l'app desktop. Nouveau champ sur le
  suivi local des partages (`note_shares`, spec/18) : `last_seen_snapshot_at` /
  `last_seen_comment_count`.
- **`snapshot_revision`** (compteur simple, incrémenté à chaque snapshot
  périodique du document Yjs vers `shares.markdown`, §2) — sert **seulement**
  à détecter "il y a du nouveau depuis la dernière fois", plus à gérer des
  conflits (le CRDT s'en occupe déjà côté édition). Un **badge** (compteur)
  apparaît sur le bouton Partager de la note concernée + une entrée
  récapitulative si plusieurs partages ont du nouveau (Réglages → Partages,
  ou notification dans le bandeau existant, à trancher au design UI).

## 6. Rapatriement dans le vault local — jamais automatique

- **Bouton explicite** "Récupérer les modifications" (écran Notes, à côté de
  "Partager"/"Copier le lien") — **uniquement quand une nouvelle version
  existe côté serveur** (§5).
- Au clic : récupère `shares.markdown` à jour — le **dernier snapshot texte**
  du document Yjs (§2, pas le format binaire interne) — et **remplace** le
  contenu de la note locale (`update_note_file`).
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
| `WS /share/{edit_slug}/sync` | connexion **WebSocket** Yjs (`yrs-axum`) — édition temps réel, curseurs live |
| `GET /share/{slug}/content` | poll léger (démarrage app, pas pendant l'édition) : `{ markdown, snapshot_revision }` — dernier snapshot texte |
| `GET /share/{slug}/comments` | liste des commentaires |
| `POST /share/{slug}/comments` | `{ author_name?, body }` → ajoute (vue ou édition) |
| `DELETE /share/{slug}/comments/{id}` | `manage_token` → supprime |

## Données (PostgreSQL, ajouts)

- `shares` gagne : `view_slug`, `edit_slug` (remplace l'unique `slug`
  actuel — migration), `snapshot_revision INT DEFAULT 1`, `yjs_state BYTEA`
  (état binaire du document CRDT, pour reprendre une session d'édition
  après un redémarrage du backend — `shares.markdown` reste le **snapshot
  texte** dérivé, utilisé par le rendu spec/18 et le rapatriement §6).
- Nouvelle table `share_comments (id SERIAL PRIMARY KEY, slug TEXT
  REFERENCES shares, author_name TEXT, body TEXT, created_at TIMESTAMPTZ
  DEFAULT now())`.

## Commandes Tauri / app (ajouts à spec/18)

| Commande | Rôle |
|---|---|
| `get_share_edit_link(note_path) -> ShareLink` | récupère/génère le lien d'édition |
| `check_share_updates() -> Vec<ShareUpdate>` | au démarrage — `snapshot_revision`/comptes de commentaires vs. `last_seen_*` local |
| `pull_share_changes(note_path)` | rapatrie le markdown à jour dans la note locale (§6) |
| `delete_share_comment(slug, comment_id)` | modération (`manage_token`) |

## Hors scope (explicite)

- **Fusion automatique** entre le vault local et la version en ligne —
  avertissement + écrasement conscient uniquement (§6). Le CRDT fusionne
  les éditeurs **en ligne** entre eux (§2), pas "l'édition locale déconnectée
  vs. le document collaboratif" — ce sont deux choses différentes.
- **Commentaires ancrés par paragraphe/sélection** — fil plat uniquement (§4).
- **Historique des versions** (revenir à une version antérieure) — seule la
  dernière version compte, pas de journal, même si Yjs le permettrait
  techniquement (snapshots successifs) — pas construit pour cette v1.
