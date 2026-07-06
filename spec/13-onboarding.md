# spec/13 — Onboarding

> **Statut v1 :** refonte de l'assistant existant (`Onboarding.tsx`).

## Déclenchement

Affiché si `onboarding_completed` ≠ `"true"` **et** aucun vault configuré
(logique dans `App.tsx`, existante — un install avec vault est considéré comme
onboardé). Rejouable via « Revoir l'introduction » (Paramètres). À la fin :
`set_config('onboarding_completed', 'true')`.

## Flux (assistant à étapes — points de progression, Précédent / Suivant / Passer)

1. **Bienvenue**.
2. **Intro 1** — Capturer à la voix → transcription locale (Whisper embarqué, marche direct).
3. **Intro 2** — Notes + tâches automatiques (ingestion) + chat avec Alfred.
4. **Vault** — « Avez-vous déjà un vault (Obsidian) ? »
   - **Oui** → choisir le dossier → Alfred crée `alfred-raw/` + `alfred-intelligence/`
     **dedans**, sans toucher au reste.
   - **Non** → choisir / créer un dossier → Alfred y crée `alfred-raw/`
     (transcriptions), `alfred-intelligence/` (comptes-rendus) et `Todo.md`.
   - Création à la validation, **idempotente** (ne pas écraser l'existant).
     **Aucun** fichier `.claude` / skill écrit (spec/07).
5. **Accès IA** — les **deux** options présentées (modifiables ensuite dans Paramètres) :
   - **Ma clé Claude** → coller la clé (`save_secret('claude_api_key')` + `test_api_key`).
   - **Abonnement AlfredIA** — 15 €/mois, **1er mois offert** → bouton « S'abonner »
     → Stripe + loopback (spec/15) → `alfredia_token` récupéré automatiquement.
     Mensuel, se termine à la fin du mois si payé (facturation : spec/15).
6. **Micro** — test de permission (`test_microphone` ; déclenche le prompt macOS ;
   sur Windows, ouverture WASAPI).
7. **Terminé**.

## Création des dossiers du vault

À la sélection du vault, scaffolder (commande à ajouter, ou extension de
`set_vault_path`) : `alfred-raw/`, `alfred-intelligence/`,
`alfred-intelligence/Todo.md` (avec les sections Prioritaire / En cours / À faire /
Archivé). Idempotent.

## Retiré / déplacé

- **Étape « Connecter Google »** + slide agenda → **retirées** (calendrier hors v1).
- **Étape Whisper** (modèle / langue / téléchargement) → **déplacée en Paramètres**
  (`small` embarqué, transcription active par défaut — spec/04).
- **Slides d'intro** : 6 → **2**.

## Commandes Tauri utilisées

`get_vault_path` / `set_vault_path` / `pick_vault_folder` (+ scaffolding dossiers) ·
`save_secret` / `get_secret` (`claude_api_key`) · `test_api_key` · souscription
AlfredIA (spec/15) · `test_microphone` · `get_config` / `set_config`
(`onboarding_completed`).

## Hors v1 / plus tard

Connexion Google / Microsoft, choix du modèle Whisper dans l'onboarding,
indexation d'un gros vault existant à l'import.
