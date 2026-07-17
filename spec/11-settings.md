# spec/11 — Paramètres

> **Statut v1 :** refonte — retirer Vapi / Google Places / calendrier ; remplacer
> l'étape « clé Claude » par le **choix d'accès IA** ; accueillir Whisper (déplacé
> de l'onboarding).

## Modèle technique

Pas de `get_settings` / `update_setting` : chaque réglage passe par
`get_config` / `set_config`, `get_secret` / `save_secret`,
`get_launch_at_login` / `set_launch_at_login`, `test_api_key`,
`get_vault_path` / `set_vault_path` / `pick_vault_folder`, `download_model`.

## Sections v1

**Profil local** (📝 à faire, feedback tests) — le menu profil ambigu du haut-droite
est **retiré** (spec/10) ; l'identité vit ici. **Prénom + avatar** stockés **en local**
(config, pas de compte serveur, cohérent v1 : pas de PII, metrics anonymes). Réutilisé
dans l'app : assignation de tâche à soi (**`@moi`**, spec/06), reconnaissance de
l'utilisateur dans les participants, signature de partage (spec/18). Édité ici.

**Accès IA** (remplace « APIs ») — mode **clé perso** ou **AlfredIA** :
- *Clé perso* : saisir `claude_api_key` + **Tester** (`test_api_key`).
- *AlfredIA* : **statut** de l'abonnement (actif / essai / inactif) + bouton
  **S'abonner** (loopback, spec/15) ; token `alfredia_token`. Gérer l'abonnement
  (portail Stripe) = plus tard.
- Basculer de mode **à tout moment**.

**Transcription** (déplacé de l'onboarding) : modèle Whisper (`small` embarqué ;
modèles plus gros **téléchargeables** → `download_model`, `download-progress`) +
langue (`language_hint`).

**Enregistrement** : source audio (`mic_only` / `system_only` / `mixed`) ; dossier
d'enregistrement (défaut **`alfred-raw`**).

**Notes** : dossier vault (`get/set_vault_path`, `pick_vault_folder`).

**Tâches** : fichier `Todo.md` (défaut **`alfred-intelligence/Todo.md`**).

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

## Note bug

Le launch-at-login macOS utilise le label `io.alfred.app` alors que l'identifiant
de l'app est `com.alfred.app` → à aligner (spec/12).

## Hors v1 / plus tard

Gestion Vapi / Places / Google, intervalle de sync calendrier, portail de gestion
d'abonnement Stripe, éditeur de prompt d'ingestion API.
