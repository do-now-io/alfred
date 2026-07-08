# spec/14 — Feedback

> **Statut v1 :** ✅ fait. Onglet pour recueillir les retours (texte + images),
> **stockés en Postgres** côté backend (consultation par SQL — pas d'email en v1,
> voir spec/15 §E).

## Onglet Feedback (`/feedback`) — ✅ fait

Formulaire (`screens/Feedback.tsx`) :
- **Catégorie** : Bug · Suggestion (feature request) · Compliment (praise).
- **Texte** (obligatoire).
- **Images** (facultatif) : coller une capture d'écran (Ctrl/Cmd+V) directement
  dans le champ texte, jusqu'à 5. *(Glisser-déposer et pièce-jointe via
  sélecteur de fichier : pas encore faits — le collage couvre le cas d'usage
  principal des captures d'écran.)*
- **Email de contact** (facultatif) — pour pouvoir recontacter l'utilisateur.
- Bouton **Envoyer**.

## Envoi

Destination : **Postgres** (backend, spec/15 §E) — pas d'email en v1. Transport
via le backend, `POST /feedback` :
- Corps : `{ category, text, contact_email?, install_id (anonyme), app_version, os, images[] }`
  (images en base64).
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

- `install_id` **anonyme** (corrélation avec les metrics, spec/15) — lu depuis la
  config locale (le même que celui utilisé par `metrics.rs`).
- `contact_email` **optionnel** — seule PII, saisie volontairement par l'utilisateur.

## Commande Tauri

`submit_feedback(category, text, contact_email?, images[]) -> Result<(), String>`
→ `POST /feedback` (backend).

## Hors v1 / plus tard

Email de notification à l'équipe + upload S3 (contrat déjà prêt côté backend),
tableau de bord des retours, glisser-déposer / pièce-jointe fichier, réponses
in-app.
