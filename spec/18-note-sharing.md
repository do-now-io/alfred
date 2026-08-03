# spec/18 — Partage de notes

> **Statut :** ✅ construit et testé en réel (v1). S'appuie sur le **backend
> AlfredIA existant** (repo privé `alfred-backend`) — **aucune nouvelle infra**.
> Volontairement **minimal**.

## Idée directrice

Depuis une note générée — transcription (`alfred-raw/`), compte-rendu
(`alfred-intelligence/`) ou la liste de **tâches** (`Todo.md`) — un bouton
**Partager** met le Markdown en ligne sur notre serveur et renvoie une **URL
publique par lien** qui affiche la note **rendue** dans le navigateur, sans app ni
compte.

```
Note Markdown (vault)
   └──[ Partager ]──→ POST /share (backend AlfredIA)
                        → stocke le .md, renvoie { url, manage_token }
   URL publique  →  GET /s/{slug}  →  page HTML rendue (viewer Markdown)
```

## Principe (le plus simple possible)

1. Clic **Partager** → l'app lit la note, **retire le frontmatter** (métadonnées
   internes : `recording_id`, etc. — **jamais publiées**), envoie `{ title, markdown }`.
2. Le backend stocke et renvoie une **URL** `https://api.alfred.do-now.io/s/{slug}`
   + un **`manage_token`** (pour révoquer/mettre à jour).
3. Ouvrir l'URL → page HTML **rendue côté serveur** (Markdown → HTML), lisible,
   responsive, sans dépendance externe.
4. L'app **copie le lien** dans le presse-papier et **mémorise le partage
   localement** (pour « copier à nouveau », « mettre à jour », « ne plus partager »).

## Modèle de partage & confidentialité

- **Public par lien** : le `slug` est un identifiant **aléatoire non devinable**
  (≥128 bits, base62) — modèle « toute personne disposant du lien peut voir ».
  **Non listé, non indexé** (`X-Robots-Tag: noindex`, `robots.txt`).
- **Le contenu quitte le vault** → à la **première utilisation**, **confirmation
  explicite** : « Ce contenu sera envoyé sur les serveurs Alfred et lisible par
  toute personne disposant du lien. » Option « ne plus demander ».
- **Révocation** : bouton **« Ne plus partager »** → `DELETE` avec le
  `manage_token` → l'URL renvoie **404**.
- Pas d'expiration en v1 (révocation manuelle). **Cap de taille** (~1 Mo).

## Endpoints backend (repo privé `alfred-backend` — même service, mêmes principes)

Auth par **clé applicative embarquée** (en-tête, comme `/feedback` et `/metrics`)
→ marche pour **tous** les utilisateurs (**clé perso ET AlfredIA**) : le partage
**n'est pas** réservé aux abonnés.

| Endpoint | Rôle |
|---|---|
| `POST /share` | `{ title, markdown, install_id, app_version, os }` → `{ slug, url, manage_token }`. Génère le slug, stocke en Postgres. Rejette si `> SHARE_MAX_BYTES`. |
| `GET /s/{slug}` | Rend le Markdown en **HTML sanitisé** (page auto-portante, CSS inline, `noindex`). **404** si absent/révoqué. |
| `DELETE /share/{slug}` | Corps/en-tête `manage_token` (comparé au hash stocké) → supprime. |
| `PUT /share/{slug}` | `manage_token` → met à jour le Markdown sur la **même** URL (re-partage après édition — le lien déjà envoyé reste valide et à jour). |

## Données (PostgreSQL)

- **`shares`** : `slug TEXT PRIMARY KEY`, `title TEXT`, `markdown TEXT`,
  `manage_token_hash TEXT` (SHA-256), `install_id UUID`,
  `created_at TIMESTAMPTZ DEFAULT now()`, `updated_at TIMESTAMPTZ`.

Markdown en `TEXT` — trivial pour nos notes ; **cohérent avec « tout en Postgres »**
du backend privé (pas de stockage objet en v1).

## Rendu (viewer)

- **Rendu côté serveur** : Markdown → HTML via un moteur **GFM** (tables, cases à
  cocher, liens auto) en **mode sûr** (HTML brut **échappé** → pas de XSS depuis le
  contenu de note, qui est **non fiable**).
- **Page auto-portante** : titre, corps rendu, petit pied « Partagé via **Alfred** »
  avec le **logo** — le tout est un **lien vers `https://alfred.do-now.io`**. Logo
  servi par le backend lui-même (`GET /logo.png`, 128 px embarqué dans le binaire,
  aussi favicon) : toujours **aucune ressource externe** (CSP stricte, même origine).
  **CSS inline** (lisible, responsive, thème clair/sombre).

## Côté application (desktop)

- **Bouton « Partager »** sur une note (écran **Notes**, à côté de
  « Vérifier / corriger ») **et** sur l'écran **Tâches** (partage de `Todo.md`).
  États : *non partagé* → « Partager » ; *partagé* → « Copier le lien » +
  « Ne plus partager » (+ « Mettre à jour » si `PUT`).
- **Commandes Tauri** : `share_note(note_path) -> ShareLink`,
  `unshare_note(note_path)`, `get_share_link(note_path) -> ShareLink | null`,
  `share_todos() -> ShareLink`.
- **Stockage local** (SQLite, table `note_shares` : `note_path`, `slug`,
  `manage_token`, `url`, `created_at`) — pour retrouver / mettre à jour / révoquer
  un partage existant.
- Copie **presse-papier** + option **« Ouvrir dans le navigateur »**.

## Sécurité

- Slug **non devinable** (≥128 bits).
- **HTML sanitisé** (contenu de note = entrée non fiable).
- `noindex` + `robots.txt` ; **CSP stricte** sur la page du viewer.
- **Rate-limit** par clé app / IP ; **cap de taille** ; (option) limite du nombre
  de partages par `install_id`.
- `manage_token` livré **une seule fois**, stocké **hashé** côté serveur.

## Configuration (variables d'env Coolify — repo privé `alfred-backend`)

| Var | Rôle |
|---|---|
| `SHARE_BASE_URL` | Base publique des liens de partage (défaut `PUBLIC_BASE_URL`) |
| `SHARE_MAX_BYTES` | Taille max d'un Markdown partagé (ex. `1000000`) |

## Hors v1 / plus tard

- **Expiration** automatique, **mot de passe**, partage **authentifié**.
- **Édition en ligne** / commentaires.
- **Domaine dédié** `share.alfred.do-now.io` + mise en page soignée / logo.
- **Stockage objet** (si volumes importants un jour).
- **Métriques de vues** ; PDF/impression.
