# spec/11 — Paramètres

> **Statut v1 :** refonte — retirer Vapi / Google Places / calendrier ; remplacer
> l'étape « clé Claude » par le **choix d'accès IA** ; accueillir Whisper (déplacé
> de l'onboarding).

## Modèle technique

Pas de `get_settings` / `update_setting` : chaque réglage passe par
`get_config` / `set_config`, `get_secret` / `save_secret`,
`get_launch_at_login` / `set_launch_at_login`, `test_api_key`,
`get_vault_path` / `set_vault_path` / `pick_vault_folder`,
`list_whisper_models` / `download_model` / `cancel_model_download` /
`delete_whisper_model` (spec/04).

## Sections v1

**Profil local** (✅ fait, feedback tests) — le menu profil ambigu du haut-droite
est **retiré** (spec/10) ; l'identité vit ici (`ProfileSection`, `store/profileStore.ts`).
**Prénom + avatar** stockés **en local** (`config.profile_name` / `config.profile_avatar`
— avatar = image choisie, encodée en data URI ; pas de compte serveur, cohérent v1 :
pas de PII, metrics anonymes). Réutilisé dans l'app : bouton **« M'assigner »** sur
la fiche tâche (**`@moi`**, spec/06) et badge « moi » sur les cartes/lignes portant
son propre nom ; reconnaissance de l'utilisateur (chip « Moi ») parmi les participants
d'une note (Properties, spec/07). Édité ici.

> **Signature de partage (spec/18) — pas fait.** Réutilisation envisagée mais non
> implémentée : nécessiterait de faire voyager le prénom jusqu'au backend AlfredIA
> (`backend/`, service séparé) et d'en changer le rendu HTML de la page partagée —
> hors périmètre de cette tâche (front only), signalé pour une itération dédiée.

**Accès IA** (remplace « APIs ») — mode **clé perso** ou **AlfredIA** :
- *Clé perso* : saisir `claude_api_key` + **Tester** (`test_api_key`).
- *AlfredIA* : bouton **Commencer l'essai gratuit — 14 jours** (loopback,
  spec/15) ; une fois le token reçu, statut affiché **« ✓ Activé »** (✅ fait,
  léger), avec bouton **« Gérer l'abonnement »** à côté — ouvre le **portail
  Stripe** (hébergé, hors app) dans le navigateur par défaut : moyen de
  paiement, changement de formule, **annulation** (✅ fait — spec/15
  `POST /subscription/portal`). **Pas fait** : distinguer essai/actif et
  afficher les **jours restants** — nécessiterait un endpoint de statut
  détaillé côté backend (`GET /subscription/status`, pas construit).
- Basculer de mode **à tout moment**.

**Transcription** : **gestionnaire de modèles Whisper** — composant partagé
`WhisperModelPicker`, le même que l'étape d'onboarding (spec/04/13). Liste du
catalogue avec statut par modèle : téléchargé (badge « ✓ Actif » ou bouton
**« Utiliser »** + suppression), en téléchargement (progression + **Annuler**),
absent (**Télécharger**). Permet le **pré-téléchargement** de plusieurs
modèles ; « Utiliser » n'existe que sur un modèle téléchargé (on ne peut plus
activer un modèle absent) ; suppression refusée sur le modèle actif. Et
langue (`language_hint`), inchangé.

**Enregistrement** : source audio (`mic_only` / `system_only` / `mixed`) —
**défaut `mixed`** (✅ fait ; repli auto sur `mic_only` si le système n'est
pas dispo, cf. spec/03) ; dossier d'enregistrement (défaut **`alfred-raw`**).

**Notes** : dossier vault (`get/set_vault_path`, `pick_vault_folder`).

**Tâches** : fichier `Todo.md` (défaut **`alfred-intelligence/Todo.md`**).

**Langue / Language** (✅ fait, spec/21) : `app_language` (`fr` | `en`) —
traduction entière de l'app ; changeable à tout moment (sans redémarrage).

**Système** : lancer au démarrage (`get/set_launch_at_login` — LaunchAgent macOS /
clé de registre Windows) ; **« Revoir l'introduction »** (rejoue l'onboarding).

## Retiré (hors v1)

- Clés **Vapi** + **ID numéro Vapi** + **Google Places**.
- Section **« Calendrier & compte »** (connexion Google + intervalle de sync).
- Éditeur de **prompt d'ingestion CLI** (l'ingestion est API — spec/05 ; un éditeur
  de prompt d'ingestion API pourra revenir plus tard).

## Défauts (Rust) — ✅ faits

- `DEFAULT_RECORDING_FOLDER` : `raw/audios` → **`alfred-raw`**.
- `DEFAULT_TODO_FILE` : `wiki/Todo.md` → **`alfred-intelligence/Todo.md`**.

> ✅ **Vestige dans les vaults réutilisés — corrigé (feedback tests)** : un vault
> créé par une version antérieure gardait un **`raw/`** (`raw/audios/`) — et
> parfois `wiki/` — orphelins. Migration de nettoyage consolidant `raw/` →
> `alfred-raw/` (et `wiki/Todo.md` → l'emplacement configuré) — détails spec/07.

## Note bug — ✅ fait

Le launch-at-login macOS utilisait le label `io.alfred.app` alors que l'identifiant
de l'app est `com.alfred.app` → aligné (spec/12).

## Hors v1 / plus tard

Gestion Vapi / Places / Google, intervalle de sync calendrier, éditeur de prompt
d'ingestion API. *(Le portail de gestion d'abonnement Stripe est fait — voir
§Accès IA ci-dessus.)*
