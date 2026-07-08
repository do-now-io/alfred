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
   - **Abonnement AlfredIA** — 20 €/mois (ou annuel), **sans essai** → bouton « S'abonner »
     → Stripe + loopback (spec/15) → `alfredia_token` récupéré automatiquement.
     Mensuel, se termine à la fin du mois si payé (facturation : spec/15).
6. **Micro** — test de permission (`test_microphone` ; déclenche le prompt macOS ;
   sur Windows, ouverture WASAPI).
7. **Terminé**.

## Tournée guidée (post-onboarding)

Juste après l'étape **Terminé**, avant de lâcher l'utilisateur sur l'accueil :
un **essai réel guidé**, pas une simulation — un vrai enregistrement, une vraie
transcription, une vraie ingestion. But : que le premier contact avec Alfred soit
un « wahou », pas un écran vide.

**Déclenchement** : automatique juste après l'onboarding (une seule fois —
`tour_completed` en config) ; rejouable via **« Revoir la visite guidée »**
(Paramètres), séparé de « Revoir l'introduction ». **Passable à tout moment**
(bouton discret « Passer la visite » sur chaque étape) — ne bloque jamais l'accès
à l'app. Si un skip survient, `tour_completed` passe `true` quand même (ne
revient pas au prochain lancement) ; seul « Revoir la visite guidée » la relance.

### Étapes (pilotées par les vrais événements, pas des délais)

1. **Carte d'intro** — « Faisons un essai ensemble, pour de vrai : un
   enregistrement, un compte-rendu, une question à Alfred. Deux minutes montre
   en main. » → « Allons-y » / « Plus tard ».
2. **Spotlight sur la carte d'enregistrement** (accueil, « Prendre des notes
   maintenant ») — invite à parler comme dans une vraie réunion, en reprenant
   les conseils de captation (spec/03) : nommer les participants, annoncer le
   sujet, et **nommer le responsable** de chaque tâche donnée à l'oral. Attend
   `recording-status-changed → "recording"`.
3. **Pendant l'enregistrement** — bulle flottante non bloquante près de
   l'indicateur REC, avec 1-2 rappels de captation qui tournent. Avance seule
   dès `status → "stopping"/"processing"`.
4. **Transcription** — bandeau (haut-droite, non bloquant) :
   *« Alfred est en train de transcrire ce que vous avez dit… »*
   (piloté par `recording-status-changed` = `processing`).
5. **Rédaction** — dès `transcription-complete`, le bandeau change :
   *« Il rédige maintenant un résumé et en tire des tâches… »*
6. **Terminé** — dès `ingestion-status-changed { status: "done" }` (nouvel
   événement, voir ci-dessous) pour **ce** `recording_id` : *« Alfred a
   terminé ! Retrouvez vos tâches ici »* (spotlight nav **Tâches**) *« et vos
   notes ici »* (spotlight nav **Notes**) — un petit point animé reste sur ces
   deux entrées jusqu'à ce qu'elles soient visitées.
7. **Demander à Alfred** — direction l'onglet **Alfred**, spotlight sur une
   suggestion cliquable *« Retrouve-moi ma dernière réunion enregistrée »*
   (ajoutée aux suggestions du chat, spec/07b). Attend une réponse (ou avance
   manuellement si l'utilisateur tape sa propre question).
8. **Clôture** — carte chaleureuse, ton majordome : *« Vous êtes équipé »* /
   *« Voilà l'essentiel : parlez, Alfred écoute, résume et retient. Le reste,
   vous le découvrirez en l'utilisant. »* → « Terminer ».

**Dégradation gracieuse** : si l'enregistrement/transcription/ingestion échoue
(`status: "error"` sur l'un des événements), message d'excuse avec l'erreur +
« Continuer quand même » → clôture directe. La tournée ne force jamais la
navigation hors des étapes qui en ont explicitement besoin (2 et 7) ; si
l'utilisateur navigue ailleurs de lui-même en cours de route, elle s'efface
silencieusement (traité comme un skip) plutôt que de le rediriger de force.

### Nouvel événement backend

`ingestion-status-changed { status: "done" | "error", recording_id }` — émis en
fin de `ai::run_ingestion_core` (succès ou échec), pour que l'UI n'ait pas à
deviner la fin de l'ingestion via `notes-updated`/`todos-updated` (génériques,
peuvent se déclencher pour d'autres raisons).

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
`save_secret` / `get_secret` (`claude_api_key`) · `test_api_key` · `subscribe_alfredia`
(spec/15) · `test_microphone` · `get_config` / `set_config` (`onboarding_completed`,
`tour_completed`) · `start_recording` / `stop_recording` (tournée guidée, via le
store d'enregistrement existant).

## Hors v1 / plus tard

Connexion Google / Microsoft, choix du modèle Whisper dans l'onboarding,
indexation d'un gros vault existant à l'import.
