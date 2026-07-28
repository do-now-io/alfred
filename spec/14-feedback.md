# spec/14 — Feedback

> **Statut v1 :** ✅ fait. Widget rapide (topbar) + formulaire détaillé
> (`/feedback`) pour recueillir les retours (texte + images), **stockés en
> Postgres** côté backend avec la **vue courante** (consultation par SQL — pas
> d'email en v1 ; backend dans le repo privé `alfred-backend`, §E).

## Widget rapide (topbar) — ✅ fait

Icône discrète dans la topbar (`components/FeedbackWidget.tsx`), visible en
permanence. Un clic ouvre un popover :
- **Texte** (obligatoire) + bouton **Envoyer** (Ctrl/Cmd+Entrée), rien d'autre —
  catégorie implicite **`quick`**.
- La **vue courante** (pathname de la route, ex. `/tasks`) part avec l'envoi
  (champ `view`).
- Succès → « Merci ! » puis fermeture auto ; échec → message + texte conservé.
- Fermeture : ✕ implicite (re-clic sur l'icône), Échap, clic extérieur.
- Lien « Formulaire détaillé » → `/feedback` en transmettant la vue d'origine
  (`location.state.from`), pour les retours avec captures/catégorie/email.

## Formulaire détaillé (`/feedback`) — ✅ fait

Plus d'entrée dans la sidebar (le widget est la porte d'entrée) ; l'écran reste
accessible via le lien du popover. Formulaire (`screens/Feedback.tsx`) :
- **Catégorie** : Bug · Suggestion (feature request) · Compliment (praise).
- **Texte** (obligatoire).
- **Images** (facultatif) : coller une capture d'écran (Ctrl/Cmd+V) directement
  dans le champ texte, jusqu'à 5. *(Glisser-déposer et pièce-jointe via
  sélecteur de fichier : pas encore faits — le collage couvre le cas d'usage
  principal des captures d'écran.)*
- **Email de contact** (facultatif) — pour pouvoir recontacter l'utilisateur.
- Bouton **Envoyer**.

## Envoi

Destination : **Postgres** (backend privé `alfred-backend`, §E) — pas d'email en v1. Transport
via le backend, `POST /feedback` :
- Corps : `{ category, text, contact_email?, install_id (anonyme), app_version, os, view?, images[] }`
  (images en base64). `category` ∈ `bug | feature | praise | quick` (`quick` =
  widget topbar). `view` = vue/menu où était l'utilisateur (colonne
  `feedback.view`, migration backend `0005`).
- Le backend écrit directement en base (table `feedback` + `feedback_images` en
  `BYTEA`) — l'équipe consulte par SQL. Email/S3 : hors v1, pourront être ajoutés
  sans changer le contrat de la commande.
- **Pourquoi via le backend et pas un appel direct depuis le frontend** :
  principe d'architecture verrouillé — le backend Rust possède tout l'I/O réseau
  (`feedback.rs` + commande `submit_feedback`), le frontend ne fait que l'UI.

## Confirmation & erreurs — ✅ fait

- Confirmation inline à l'envoi (« Merci, c'est envoyé ! »).
- Échec réseau → message + le formulaire **garde** le texte/images/catégorie saisis
  (pas de reset), l'utilisateur relance avec le même bouton **Envoyer**.

## Données

- `install_id` **anonyme** (corrélation avec les metrics, backend privé `alfred-backend`) — lu depuis la
  config locale (le même que celui utilisé par `metrics.rs`).
- `contact_email` **optionnel** — seule PII, saisie volontairement par l'utilisateur.

## Commande Tauri

`submit_feedback(category, text, contact_email?, view?, images[]) -> Result<(), String>`
→ `POST /feedback` (backend).

## Hors v1 / plus tard

Email de notification à l'équipe + upload S3 (contrat déjà prêt côté backend),
tableau de bord des retours, glisser-déposer / pièce-jointe fichier, réponses
in-app.
