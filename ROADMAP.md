# Alfred — ROADMAP v1

Backlog extrait des specs (`spec/`). Suivi simple : cocher au fil de l'eau,
mettre ses initiales dans **Qui**. Les specs restent la source de vérité du *quoi*
et du *comment* ; ce fichier suit le *où on en est*.

Légende : `[ ]` à faire · `[~]` en cours · `[x]` fait · ⚠️ = risque / chemin critique.

---

## 🎯 Risques & chemin critique (à attaquer en premier)

- ⚠️ **Backend AlfredIA** — gate le lancement (proxy + Stripe + metrics). Spec 15.
- ⚠️ **Audio système sur Windows** — WASAPI loopback, rien de codé. Spec 03.
- ⚠️ **Whisper par défaut, cross-platform** — build + packaging + modèle embarqué. Spec 04.

---

## Phase A — Backend (spec 15) · gate le lancement

| | Tâche | Qui |
|---|---|---|
| [x] | Service Rust/axum + déploiement **Coolify** (Docker depuis Git) + domaine `api.alfred.do-now.io` (Traefik/Let's Encrypt) | UC |
| [x] | **Proxy** `POST /v1/messages` : lookup token, abo actif, allowlist modèles, forward + retry (+ tables `tokens`/`metrics`) | UC |
| [x] | **Stripe** : produit AlfredIA 20 €/mois (+ annuel), sans essai ; Checkout ; webhook (émission/révocation token) | UC |
| [x] | **Souscription loopback** : `/subscribe` + `/subscribe/complete` (nonce/port → token) | UC |
| [x] | **PostgreSQL** (Coolify) : tables `tokens` + `metrics` ; endpoint `POST /metrics` | UC |
| [x] | **`POST /feedback`** → tout en **Postgres** (texte + images BYTEA, consultation SQL ; email/S3 hors v1) | UC |
| [x] | **Secrets** : variables d'env Coolify (clé Anthropic + clés Stripe, chiffrées) | UC |
| [~] | **Essai gratuit 14 jours AlfredIA (spec/15/13/11, feedback tests)** : Checkout Stripe avec `subscription_data.trial_period_days = 14` (✅ fait) ; token émis dès le départ en `trialing` (proxy accepte déjà, ✅) ; wording onboarding + Réglages « Commencer l'essai gratuit » (✅ fait). **Reste** : endpoint de statut détaillé (`trialing` vs `active` + jours restants, desktop ne voit aujourd'hui que « token valide/invalide ») ; tester fin d'essai → `active` et échec paiement → `suspended` (recette sandbox, cf. tâche dédiée) | CF |
| [ ] | **Recette du paiement — 20 €/mois (spec/15)** : rejouer `/subscribe` en **sandbox** Stripe (Checkout carte de test → webhook → token → proxy accepte) + simuler `subscription.deleted`/`payment_failed` (`stripe trigger`) → vérifie `suspended`/`revoked` ; puis **un** paiement réel de validation en **prod** une fois la sandbox verte | |

## Phase B — Desktop, moteur

| | Tâche | Qui |
|---|---|---|
| [~] | ⚠️ **Audio système** : Windows ✅ (WASAPI loopback, `system_only` + `mixed`, testé) — reste macOS helper Swift (Tanguy) | UC/T |
| [x] | Durcir la **capture micro** (gérer `i16`/`f32`/`u16` selon le device) | UC |
| [x] | **Feedback live** d'enregistrement : volume (RMS) + timer dans `recording-status-changed` (micro ; system_only/mixed pas encore de volume live) | UC |
| [x] | ⚠️ **Whisper** : activer la feature par défaut + **embarquer le modèle `small`** + packaging Windows | UC |
| [x] | Transcription : **stocker la langue** détectée (bug) ; écrire dans `alfred-raw/` avec frontmatter (`for_recording`) | UC |
| [x] | **Progression de transcription (spec/04, feedback tests)** : `transcription-progress { recording_id, percent }` branché sur `whisper-rs::set_progress_callback_safe` (passe unique) + agrégat pondéré par tranche (parallèle, spec/17 §5) ; affiché sur l'indicateur d'état (« Je prends note… {n} % ») + `/recording` (barre) + toast de la visite guidée — pas de doublon dans le bandeau topbar (spec/10) | CF |
| [x] | IA : passer aux modèles **Sonnet 5 / Haiku 4.5** ; **sorties structurées** ; **routage 2 modes** ; thinking off (fait pour l'ingestion ; chat.rs pas encore aligné sur `thinking: disabled`) | UC |
| [x] | **Ingestion** (fusionnée) : 1 appel → compte-rendu (`alfred-intelligence/`) + tâches (`Todo.md` + SQLite en double écriture, cf tâche suivante) | UC |
| [x] | **Todos → vault** : `Todo.md` seule source de vérité — table SQLite supprimée (migration 007), double écriture de l'ingestion retirée, commandes refondues sur le fichier (id = titre normalisé), code mort frontend (todoStore/TodoItem) supprimé | UC |
| [x] | Notes : frontmatter **`project` + `participants`** (peuplés par l'ingestion) ; structure `alfred-raw`/`alfred-intelligence` ✅ ; **regroupement par projet** (vue « Projets » dans l'arbre, dossiers virtuels — `get_notes_by_project`) ✅ ; **plus de `.claude`/skills** ✅. *Rangement physique par projet = hors v1* | UC |
| [x] | **Brief quotidien** (`generate/get_daily_brief`) | UC |
| [x] | **Chat** : historique multi-conversations + liste (persistance SQLite, migration 006 ; liste/reprise/suppression dans le panneau chat) | UC |
| [x] | **Metrics** : `install_id` anonyme + envoi des événements (`install_created`/`app_launched`/`recording_completed`/`ingestion_completed`/`ai_request`) — tous câblés. Manquait la clé anti-spam `x-metrics-key` côté app : embarquée à la compilation (`option_env!`) via le secret CI `ALFRED_METRICS_APP_KEY`, doit correspondre au `METRICS_APP_KEY` Coolify | CF |
| [x] | **Contexte interne** : note vault `Contexte Alfred.md` + template + injection ingestion + Settings (spec 16) | T |
| [x] | **Transcription live** (spec 16) : **abandonnée** — code retiré (revert `transcription/live.rs`, session acteur, événements `live-*`, `save_live_note`/`get_live_session`, miroir CodeMirror) ; le contexte interne subsiste | T/UC |

## Phase B3 — Qualité de transcription (spec 17)

| | Tâche | Qui |
|---|---|---|
| [x] | **Qualité de décodage** (spec 17) : beam search + seuils anti-hallucination + threads relevables dans `run_whisper` ; langue forçable par enregistrement | UC |
| [x] | **Glossaire dérivé** (spec 17) : `generate_glossary_from_context` (Claude) depuis `Contexte Alfred.md` → `config.transcription_glossary` → `initial_prompt` de `run_whisper`. **Régénéré automatiquement** (débouncé 4 s) quand la note de contexte est éditée (`update_note_file` → `schedule_glossary_regen`) + à l'onboarding + bouton manuel | UC |
| [x] | **Ingestion augmentée** (spec 17) : ingestion 2 temps (analyse → résolution groupée + réécoute segment → finalisation) + enrichissement auto « Appris automatiquement » dans `Contexte Alfred.md`. Backend (`analyze_transcription`/`finalize_ingestion`, event `clarifications-ready`) + **écran `/resolve`** (texte éditable CodeMirror, cartes appliquer/ignorer, réécoute WAV via `read_recording_wav`) + bandeau d'invite. **Flag `augmented_ingestion` — ON par défaut** (désactivable via `set_config('augmented_ingestion','false')`). Bouton **« Vérifier / corriger »** sur les notes d'enregistrement (Notes) → relance `analyze_transcription` et rouvre `/resolve` (reprise après quitter, la session live n'étant pas persistée) | UC |
| [x] | **Onboarding — contexte à la voix** : visite guidée où le 1er enregistrement (téléprompteur) crée `Contexte Alfred.md` → `build_context_from_transcription` (structure la note) + 1er glossaire ; event `context-status-changed`. `start_recording(purpose)` + migration 010 `recordings.purpose` + routage `process_job`. Front : `Teleprompter`, étapes tour reshapées, suggestion chat contexte (spec 17/13) | UC |
| [x] | **Transcription parallèle par tranches** (spec 17 §5) : CPU pur trop lent sur les longs fichiers (1H ≈ 30 min en passe unique). Découpe aux silences (>15 min) + workers parallèles (modèle partagé, `state`/worker) + ré-injection du glossaire par tranche + recollage des timestamps. ~1,5–2,5×, cumulable avec modèle/beam. GPU = hors v1 | UC |

## Phase B4 — Partage de notes (spec 18)

| | Tâche | Qui |
|---|---|---|
| [x] | **Backend partage** (spec 18) : `POST /share` + `GET /s/{slug}` (rendu comrak **mode sûr**, `noindex`, CSP stricte, CSS inline clair/sombre) + `PUT`/`DELETE /share/{slug}` (`manage_token` hashé) + migration `0006_shares` (Postgres) ; auth clé app optionnelle (byo + AlfredIA) ; tests XSS/GFM | UC |
| [x] | **Desktop partage** (spec 18) : composant `ShareButton` (Notes + Tâches) + commandes `share_note`/`unshare_note`/`get_share_link` (+ `share_todos`/`get_todos_share_link`/`unshare_todos`) + migration locale `011_note_shares` + confirmation 1re fois (le contenu quitte le vault) + copie presse-papier ; re-partage = **même URL** (PUT) | UC |

## Phase C — Desktop, UX & écrans

| | Tâche | Qui |
|---|---|---|
| [x] | **Accueil « Alfred »** (spec/10) : brief ✅ + bloc tâches dépliable ✅ + input chat + exemples ✅. **Fusion cible faite** — « Alfred » prend la place d'« Aujourd'hui » (`/`), layout **2 colonnes** (gauche : conversation Alfred, `ChatPanel` complet avec son historique ; droite : carte d'enregistrement + brief + tâches). `/ai-actions` retirée (nav + route + écran `AIActions.tsx`) | CF |
| [x] | **Indicateur d'état = où Alfred travaille (spec/10, feedback tests)** : (a) le **point ambre** d'une note = la note qu'Alfred **traite** (transcription/analyse/contexte), plus « note sélectionnée » (highlight suffit) ; (b) **indicateur majordome cliquable** → navigue vers la cible en cours. Cible active dans `alfredStatusStore` (`targetPath`/`targetRoute`/`recordingId`), alimentée par `transcription-complete` (qui porte désormais `note_path`) | CF |
| [x] | **Indicateur d'état** (topbar, labels majordome) + **bandeau d'enregistrement** (timer + volume live + stop) | UC |
| [x] | Déclenchement via **logo** (hover micro) + **page de guidage** d'enregistrement (`/recording`, conseils de captation éditables) | UC |
| [x] | **Logo bouton d'enregistrement décalé (spec/03, feedback tests)** : l'ancien `alfred-logo.png` avait un fond blanc visible dans les coins arrondis + un contenu non centré (portrait en haut, mot « ALFRED » en bas). Remplacé par 2 nouveaux assets fournis, fond transparent, utilisés **tels quels** (aucun recadrage/traitement d'image de notre côté) : `alfred-logo-minimal.png` (portrait seul, sans mot-symbole) pour les petites icônes (visite guidée, page de guidage) et `alfred-logo.png` (avec « ALFRED ») pour les grands formats (onboarding) **et le bouton d'enregistrement de la sidebar** — composant partagé `AlfredAvatar` (prop `variant`) | CF |
| [x] | **Encadré rouge d'enregistrement mal ajusté au logo (spec/03, feedback tests)** : le cadre rouge (`border` + `border-radius` CSS fixe) ne suivait pas le contour réel de l'asset transparent (arrondi type « squircle »), laissant un décalage visible aux coins. Remplacé par un `filter: drop-shadow(...)` (4 directions) sur l'image elle-même, qui épouse le contour alpha réel quel que soit son tracé, au lieu d'un cadre géométrique séparé | CF |
| [x] | **Import de fichier audio** (spec/03) : commande `import_audio_file` (picker WAV → copie `recordings/<uuid>.wav`, `source='import'`, réutilise la file de transcription via `transcription::enqueue_job` partagé avec `stop_recording`) + migration 009 (CHECK `source` élargi) + bouton « Importer un audio » sur `/recording` **et sur l'accueil** (sous la carte d'enregistrement, état repos — `/recording` n'étant atteignable qu'en enregistrant) | UC |
| [x] | **Import audio — mieux intégré à l'interface (spec/03)** : garder la fonction (picker `.wav` → même file de transcription) mais retravailler le placement — aujourd'hui second bouton à côté de « Démarrer l'enregistrement », à incorporer dans les points d'entrée existants plutôt qu'un bouton séparé. **Retour (feedback tests)** : gardé uniquement sur la **carte d'enregistrement** de l'accueil, retiré du **logo** sidebar (qui ne doit porter que le déclencheur d'enregistrement) | CF |
| [x] | **Nav** : retirer routes mortes Réunions / Calendrier + barre de recherche ; ajouter **Feedback**. `/ai-actions` gardée à part (écart documenté spec/10 — historique chat pas encore fait) | UC |
| [~] | **Onboarding** refonte (2 slides, détection vault + scaffolding dossiers, choix accès IA, test micro) + **tournée guidée** post-onboarding (vrai enregistrement → transcription → ingestion → tâches/notes → question à Alfred) | UC |
| [~] | **Bouton one-shot « Supprimer les données de démo » (spec/13/10, feedback tests)** : marquer le contenu semé (`alfred_seed: true` notes / marqueur tâches / drapeau conversation chat) ; cmd `delete_starter_content` qui ne supprime **que** le marqué ; bandeau dans la page Alfred visible tant que du contenu de démo subsiste (drapeau `starter_content_present`), **disparaît définitivement** après clic (ou quand plus rien de marqué) | UC |
| [x] | **Internationalisation FR/EN (spec/21, feedback tests)** — gros chantier transverse : `app_language` (`fr`\|`en`) + **choix à l'installation** (étape 0 onboarding) + réglage Langue ; catalogues de traduction (aucune chaîne UI en dur, hook `t()`) ; **langue des sorties IA** paramétrable (≠ langue UI, ingestion/glossaire/contexte/chat/brief) ; défauts localisés (contenu de démarrage) ; **découpler les sections `Todo.md`** de leur libellé (clés stables) pour ne pas casser le parsing. **Dette restante disclosed** (spec/21) : messages d'erreur backend via codes (catalogue `errors.ts` de départ non branché), titres `Contexte Alfred.md` restés FR-only, nouvelles sections `Todo.md` écrites en FR-only | UC |
| [ ] | **Écran de fin d'onboarding — habillage « pré-réunion » (spec/13)** : la clôture du wizard (« Tout est prêt ! ») et « Vous êtes équipé » (visite guidée) sont des panneaux génériques ; reprendre l'habillage de la page de guidage d'enregistrement (`/recording`, spec/03) pour que la dernière vue de l'onboarding ressemble à ce que l'utilisateur retrouve à son prochain enregistrement | |
| [~] | **Téléchargement du modèle Whisper pendant l'onboarding (spec/13, Tanguy)** : ré-ouvre une décision "hors v1" — le modèle n'étant plus embarqué (packaging CI), ajouter une étape de téléchargement (`download_model` + progression) dans le wizard plutôt que de le laisser uniquement dans Réglages ; + gestionnaire de modèles dans Réglages (pré-téléchargement, annulation, suppression, catalogue tiny→large-v3-turbo) | T |
| [x] | **Visite guidée — retours tests (spec/13)** : (a) étape « Contexte prêt » = **un seul bouton « Revoir/corriger »** (retirer « Continuer ») ; (b) **meubler la transcription** par la visite de l'app (Notes → Tâches → Graphe → Questions à Alfred & enregistrer), pop-up « Alfred vous connaît, vérifiez » **dès `context-status-changed: done`** (interrompt la visite) ; (c) après correction → **clôture** « Vous êtes équipé » | CF |
| [x] | **Visite guidée — écran de correction contexte (spec/13/17)** : « Revoir/corriger » ouvre l'**écran `/resolve` en mode contexte** (4 sections éditables + réécoute WAV via `note_title` porté par `context-status-changed` + Valider — la sauvegarde passe par `update_note_file`, qui régénère aussi le glossaire) | CF |
| [x] | **Visite guidée — ne pas interrompre (spec/13, feedback tests)** : la pop-up « Contexte prêt » ne doit **plus s'afficher dès `context-status-changed: done`** — on **mémorise** l'événement (drapeau + récap) et on laisse l'utilisateur **finir toute la visite** ; la pop-up n'apparaît **qu'à la fin** (immédiatement si le contexte est déjà prêt, sinon on attend l'event sur l'indicateur d'état) | CF |
| [x] | **Correction contexte = MÊME écran que réunion (spec/13/17, feedback tests)** : supprimer la page/variante `/resolve` spécifique à l'onboarding ; le « Revoir/corriger » du contexte passe par **exactement le même écran et le même parcours** de vérification qu'un vrai enregistrement (seul le contenu injecté diffère) | CF |
| [x] | **Bug — écran blanc en fin de replay onboarding (spec/13, feedback tests)** : « Revoir l'introduction » → clic « Terminer » → **fond uni sans sidebar** (= garde `onboarded===null` d'`App.tsx`). Cause confirmée : `forceOnboarding` lisait `sessionStorage` à chaque rendu au lieu d'être un état React — sur une install déjà onboardée, `setOnboarded(true)` est un no-op (même valeur) donc rien ne force le nouveau rendu qui sortirait de la branche `forceOnboarding`. Fix : `forceOnboarding` en `useState`, remis à `false` explicitement dans `finishOnboarding`/`finishOnboardingReplay` | CF |
| [x] | **Finalisation gated par la vérification (spec/17/05, feedback tests)** : le **compte-rendu + tâches ne sont générés qu'APRÈS validation** dans `/resolve` — retirer l'auto-enchaînement « rien à corriger → finalise tout seul » ; l'étape Résolution est **toujours** présentée (plus courte si rien à corriger), et c'est le **Valider** qui déclenche `finalize_ingestion` (idem contexte via `build_context_from_transcription`) | CF |
| [x] | **Visite guidée — contrôles téléprompteur (spec/13, dépend spec/03)** : **Pause/Reprendre** pendant la prise ; « J'ai terminé » → état « prise terminée » avec **Recommencer** (jette la prise) et **Continuer** (lance seulement là la transcription) — cmds `pause_recording`/`resume_recording`/`discard_recording` | CF |
| [x] | **Enregistrement — arrêt interruptible + traitements aval optionnels (spec/03)** : bouton **Annuler** pendant la prise (`cancel_recording`, jette le WAV) ; « Terminer » → panneau de revue **Supprimer** / **Continuer** (modal global, quel que soit l'écran) ; `stop_recording` ne lance **plus** l'aval → `process_recording(id, {transcribe, summary, tasks})` ; cases **Transcription / Compte-rendu / Tâches** cochées par défaut (transcription requise pour les 2 autres). Panneau `RecordingReview` partagé avec le téléprompteur (spec/13). Pause = frames jetées (mic + loopback), chrono figé | CF |
| [x] | **Ingestion — sortie découplée (spec/05, dépend spec/03)** : `run_ingestion_for_recording`/`_for_note` prennent `{summary, tasks}` et n'écrivent que les sections demandées (1 appel à sortie conditionnelle) ; `summary=false && tasks=false` → pas d'appel IA | CF |
| [x] | **Source audio mixte par défaut (spec/03/11, feedback tests)** : `recording_source` défaut `mixed` (micro + système) ; les points de départ lisent la config au lieu de `"mic_only"` codé en dur ; **repli auto sur `mic_only`** si système indispo (macOS sans helper Swift) ; contexte à la voix reste `mic_only` | CF |
| [x] | **Enregistrement — retirer le panneau de sélection, tout auto (spec/03, feedback tests)** : supprimer le `RecordingReview` post-arrêt (cases Transcription/Compte-rendu/Tâches) côté **réunion** → après « Terminer », lancer **auto** transcription + compte-rendu + tâches (`{summary:true, tasks:true}`). **Garder** la vérif `/resolve` (point 23), le bouton **Annuler** pendant la prise, et la suppression après coup. **Découpler** du téléprompteur de contexte, qui garde sa revue **Recommencer/Continuer** (spec/13). Le sélecteur `{summary,tasks}` reste côté backend (non exposé UI) | CF |
| [x] | **Note de contexte — bug blocs vides (spec/16)** : `write_spoken_context` doit **remplacer** le template (intro + titres vides ne comptent pas comme du contenu) au lieu d'empiler sous « Appris à l'oral » — fix `context_has_content` (l'intro sur 2 lignes passait le filtre) + tests | CF |
| [x] | **Contenu de démarrage / seed (spec/13)** : semé à la fin de l'onboarding (`seed_starter_content`, idempotent, gardé, flag `starter_content_seeded`) — tâches checklist (sections/assignation/une cochée), 2 notes de démo (frontmatter project+participants → graphe/Projets), fausse conversation chat ; question suggérée déjà en place (spotlight chat) | CF |
| [x] | **Dictée vocale du chat (spec/07b, feedback tests)** : bouton micro dans la barre de saisie (`ChatPanel` + `ChatTeaser`) → capture micro éphémère → Whisper (glossaire) → texte inséré dans le champ (éditable, pas d'envoi auto). Cmds `start_dictation`/`stop_dictation()->String` (WAV temp supprimé, pas de note/recordings/ingestion), event `dictation-status-changed`. Désactivée pendant un enregistrement de réunion (capture = singleton) | CF |
| [x] | **Capsule « Je note les tâches » (spec/05+10, feedback tests)** : `ingestion-status-changed` porte une **phase** (`analyzing`→`summary`→`tasks`→`done`) ; 5ᵉ label majordome « Je note les tâches… » (1 appel IA → phase tâches brève mais honnête) ; vaut aussi en ré-ingestion (single + lot) | CF |
| [x] | **Graphe — lien transcription ↔ compte-rendu (spec/07c, feedback tests)** : `build_graph` relie **nativement** les notes partageant le même `recording_id` (le graphe n'utilisait que wikilinks/tags ; nom daté commun → wikilink ambigu) | CF |
| [x] | **Notes — nommage par sujet + types à l'œil (spec/05+07, feedback tests)** : champ `titre` (sujet) dans `submit_ingestion` → compte-rendu nommé par sujet (plus la date) ; **icône de type** (transcription/compte-rendu/tâche/contexte/note) dans l'arbre **et** les Récents (dérivée de `type`+dossier) ; Récents = icône + nom + date secondaire | CF |
| [x] | **Notes — mode Projets éditable + paire (spec/07, feedback tests)** : champ **Projet (multi-sélection)** + **Participants** dans Properties (combobox `list_projects` + autocomplétion + créer) ; **glisser-déposer** sur un groupe de projet ; `project` = **LISTE** (multi-projet, note sous chaque projet) ; **paire transcription+compte-rendu** regroupée via `recording_id` | CF |
| [x] | **Notes — tags : liste + autocomplétion (spec/07, feedback tests)** : Properties affiche les tags existants (`list_tags`) + autocomplétion (taper `te` → `test`), clic pour ajouter | CF |
| [x] | **Conseils de captation par type (spec/03, feedback tests)** : plusieurs modèles selon le type (note perso / réunion client / one-to-one / équipe / libre), chacun avec phrase d'ouverture + conseils ciblés ; sélecteur sur `/recording` ; `capture_tips` → dict par type `{opener, tips[]}`, éditable | CF |
| [x] | **Refonte Kanban de la page Tâches (spec/06, feedback tests + demande users)** : vue Kanban sur `Todo.md` (colonnes = sections Prioritaire/En cours/À faire/Archivé) ; glisser-déposer entre colonnes → `move_todo(id, section, position?)` ; cartes lisibles (responsable, badge échéance coloré, coché) ; ajout rapide + compteur par colonne ; filtres. Décisions ouvertes : projet/priorité par tâche | CF |
| [x] | **Kanban — glisser-déposer non fonctionnel (spec/06, feedback tests)** : le vrai bug était `dragDropEnabled` (Tauri, défaut `true`) qui intercepte nativement le drag et bloque le HTML5 DnD du webview — mis à `false` dans `tauri.conf.json` (corrige aussi le drag-drop de la vue Projets) ; ouverture de carte → fiche tâche (`TaskSheet.tsx`) | CF |
| [x] | **Menu profil haut-droite → retirer + profil local (spec/10/11, feedback tests)** : menu ambigu retiré (déjà fait) ; **profil local** ajouté (`ProfileSection`, Réglages) — prénom + avatar (image → data URI) en config, sans compte serveur ; réutilisé via bouton « M'assigner » + badge « moi » (fiche tâche, Kanban, vue Markdown, spec/06) et chip « Moi » parmi les participants (Properties, spec/07). Signature de partage (spec/18) non faite — cross-service, signalé pour plus tard | CF |
| [x] | **Tâches 2e passe — vues + fiche + provenance/contexte (spec/06/05/07b, feedback tests)** : (a) bascule **Kanban / Markdown** (sections repliables, Archivé replié par défaut) sur la même liste `Todo.md` ; (b) **fiche tâche** (`TaskSheet.tsx`) ouvrable depuis Kanban et Markdown — sous-puces libres, champs inline `+Projet`/`!priorité`/`⏱estimation` (filtrables), description longue, tout en blocs indentés compatibles Obsidian (`todo_md.rs` réécrit : `TaskFields`/`TaskBlock`) ; (c) **provenance** = wikilink `[[compte-rendu ou note brute]]`+date posé par l'ingestion, lien graphe automatique (résolution wikilink standard) + `/graph?focus=` pour centrer ; (d) bouton **« Rassembler le contexte »** (`gather_task_context`) = action IA à la demande réutilisant la boucle RAG du chat (spec/07b) | CF |
| [x] | **Page partagée — footer marque (spec/18)** : « Partagé via Alfred » = lien vers `alfred.do-now.io` + logo (servi par le backend `GET /logo.png`, favicon inclus) | T |
| [x] | **Icônes de type (spec/07)** : glyphes Material Design (`react-icons/md`, `utils/noteType`) — SVG inline, identiques Windows/macOS/Linux ; distinction **audio** (transcription datée d'un enregistrement) / **note brute** / **synthèse Alfred** + tâches/contexte/note ; arbre + Récents + vue Projets. *(La variante « feuille + glyphe interne » (SVG maison) essayée puis abandonnée — retour utilisateur : trop petite/discrète — revenu aux glyphes Material, plus visibles.)* | CF |
| [x] | **Clic droit sur un dossier — créer/renommer/supprimer (spec/07)** : le menu contextuel est câblé sur les dossiers mais ne s'affiche jamais (vestige non fonctionnel, seul le menu fichier se rend) ; aucune commande Tauri dossier (`rename_note_file` suffixe `.md`, `delete_note_file` échoue sur un répertoire). À faire : `create_folder`/`rename_folder`/`delete_folder` + menu contextuel dossier réel + entrée « Nouveau dossier ». Inclut aussi le glisser-déposer **interne** d'une note vers un dossier pour la déplacer | CF |
| [x] | **Clic droit incohérent — Récents (spec/07, feedback tests)** : la liste « Récents » de la sidebar (`App.tsx`) n'avait aucun `onContextMenu` → menu natif du navigateur (Retour/Actualiser/Imprimer…) au lieu du Renommer/Supprimer de l'arbre. Menu extrait en composant partagé `NoteContextMenu` (arbre + Récents) ; corrige aussi l'icône empilée au-dessus du texte au lieu d'être sur la même ligne (Tailwind `svg { display: block }` — fix `display: flex` + `alignItems: center`) | CF |
| [x] | **Vue Projets — paire transcription/compte-rendu repliée par défaut (spec/07, feedback tests)** : la transcription appariée s'affichait toujours en retrait sous le compte-rendu (2 lignes par entrée) ; un chevron (▶/▼) la déplie/replie à la demande — une seule ligne par défaut, comme la vue Dossiers | CF |
| [ ] | **Glisser-déposer de fichiers externes dans Notes (spec/07)** — **Hors v1, décision produit** : glisser un fichier depuis le Finder/l'Explorateur (PDF, image…) sur l'arbre ou le contenu ne fait rien aujourd'hui (`dragDropEnabled: false` désactive le DnD natif de fichiers OS ; aucun handler `dataTransfer.files`). Volontairement pas fait pour la v1 (feedback tests, CF) | |
| [ ] | **Nom du dossier des transcriptions brutes — décision ouverte (spec/07)** : `alfred-raw` est le nom par défaut actuel, jamais validé comme définitif produit ; à rouvrir si besoin, en tenant compte de la migration des vaults déjà créés chez les utilisateurs en test | |
| [x] | **Voix du majordome — passe éditoriale (spec/10)** : le ton « majordome » n'existe que sur les labels d'état (« À votre service », « Je cogite… »…) ; relire l'ensemble des textes (boutons, placeholders, erreurs, onboarding) pour un ton cohérent de bout en bout, sans nuire à la lisibilité des messages d'erreur | CF |
| [x] | **Recherche dans le fichier courant (spec/06/07/10)** : Notes — Ctrl/Cmd+F dans l'éditeur (`@codemirror/search`, panneau FR, bouton loupe, raccourci global écran Notes) ; Tâches — champ « Rechercher… » qui filtre les cartes Kanban en direct (titre+responsable, insensible casse/accents). Recherche **locale** uniquement (globale toujours hors v1) | T |
| [x] | **Settings** refonte (accès IA ✓, Whisper ✓, Vapi/Google/Places/calendrier/ingest CLI retirés ✓, défauts `alfred-*` ✓) | UC |
| [x] | **Onglet Feedback** (formulaire + `submit_feedback`) | UC |
| [x] | **Widget feedback discret** (topbar) : popover textarea + envoi rapide (catégorie `quick`) ; champ `view` (vue courante) bout en bout (widget → `submit_feedback` → backend → Postgres) ; onglet retiré de la sidebar (écran gardé, lien « formulaire détaillé »). Déployé et vérifié en prod | T |

## Phase D — Nettoyage (retrait hors-v1)

| | Tâche | Qui |
|---|---|---|
| [x] | Désactiver / retirer les modules `auth`, `calendar`, `suggestions`, `phone_calls` (`ingest` CLI déjà supprimé — spec/05) + tables SQLite associées (migration 008) + UI morte (WeekPanel, BookingDemo, BriefingTask, SuggestionCard, PhoneCallModal, stores) + deps orphelines (base64/sha2/hex) + `.env.example` Google | UC |
| [x] | Retirer les routes `/meetings`, `/calendar` (faites avec la nav Phase C ; `/ai-actions` conservée — écart documenté spec/10) | UC |
| [x] | Mettre à jour les défauts de dossiers (`alfred-raw` ✅, `alfred-intelligence/Todo.md` ✅) | UC |

## Phase E — Packaging & distribution

| | Tâche | Qui |
|---|---|---|
| [x] | **CI GitHub Actions — build desktop 3 OS** (`.github/workflows/desktop-build.yml`) : Windows (msi/nsis) + macOS (dmg arm64 — pas d'Intel, runners macos-13 plus provisionnés) + Linux (deb/rpm/AppImage), **non signé** ; manuel + tags `v*` ; **release GitHub auto sur tag** avec les binaires attachés ; base sqlx recréée en CI ; **aucun modèle embarqué** (téléchargé à l'onboarding) | T |
| [ ] | **macOS** : entitlements v1 (retirer apple-events, + `NSScreenCaptureUsageDescription`) ; signature Developer ID + notarisation | |
| [ ] | **Windows** : build Whisper + WebView2 ; signature **Authenticode** | |
| [x] | Aligner le label launch-at-login `io.alfred.app` → `com.alfred.app` | CF |
| [x] | **Icône d'app à mettre à jour (feedback tests)** : le jeu `src-tauri/icons/*` (32/128/@2x/.ico/.icns + Windows Appx/iOS/Android) régénéré via `npx tauri icon` depuis `alfred-logo-minimal.png` (portrait seul, sans mot-symbole, fond transparent) — pas encore vérifié en rendu réel bureau Windows/macOS (à faire manuellement au prochain build) | CF |

## Phase F — Produit & ouverture (spec à écrire)

| | Tâche | Qui |
|---|---|---|
| [ ] | **Site web (`alfred.do-now.io`) — spec/19** : rien n'existe (ni code, ni spec) — le footer des pages partagées (spec/18) pointe déjà vers ce domaine. Écrire la spec (contenu, hébergement) avant de coder | |
| [ ] | **Rendre le projet open source — spec/20** : décisions produit/légales à prendre d'abord (licence, dépôt cible, ce qui doit rester privé) avant d'écrire la spec | |

---

*Mis à jour au fil de l'eau. Nouveau besoin non couvert par une spec → ajouter la
spec d'abord, puis la tâche ici.*
