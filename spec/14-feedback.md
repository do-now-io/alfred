# spec/14 — Feedback

> **Statut v1 :** nouveau. Onglet pour recueillir les retours (texte + images),
> **envoyés par email** à l'équipe.

## Onglet Feedback (`/feedback`)

Formulaire :
- **Catégorie** : Bug · Suggestion (feature request) · Compliment (praise).
- **Texte** (obligatoire).
- **Images** (facultatif) : capture(s) d'écran — coller ou glisser-déposer.
- **Email de contact** (facultatif) — pour pouvoir recontacter l'utilisateur.
- Bouton **Envoyer**.

## Envoi

Destination : **email de l'équipe**. Transport via le backend (spec/15),
`POST /feedback` :
- Corps : `{ category, text, contact_email?, install_id (anonyme), app_version, os, images[] }`.
- Le backend **uploade les images en S3** puis envoie un **email** (AWS SES) à
  l'équipe, avec le contenu + liens / pièces jointes.
- **Pourquoi via le backend et pas un simple `mailto:`** : `mailto:` ne gère pas
  les pièces jointes images ; le backend permet texte + images sans secret côté client.

## Confirmation & erreurs

- Toast de confirmation à l'envoi.
- Échec réseau → message + **réessayer**, sans perdre le texte saisi.

## Données

- `install_id` **anonyme** (corrélation avec les metrics, spec/15).
- `contact_email` **optionnel** — seule PII, saisie volontairement par l'utilisateur.

## Commande Tauri

`submit_feedback(category, text, contact_email?, images[])` → `POST /feedback`.

## Hors v1 / plus tard

Tableau de bord des retours (v1 = email), captures d'écran automatiques, réponses
in-app.
