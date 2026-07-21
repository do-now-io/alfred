# spec/04 — Transcription (Whisper local)

> **Statut v1 :** Whisper **activé par défaut**, cross-platform. Écrit dans le
> vault (`alfred-raw/`) puis déclenche l'IA.

## Vue d'ensemble

Au `stop_recording`, le WAV est mis en file. Un **worker unique** (pas de
parallélisme — Whisper est intensif) le transcrit via `whisper-rs` dans
`spawn_blocking`, stocke les métadonnées en SQLite, **déplace l'audio + crée la
note dans le vault**, puis déclenche l'IA (ingestion, spec 05).

## Whisper = feature Cargo — ✅ activée par défaut

- `whisper-rs` est derrière la feature Cargo **`whisper`**. Sans elle → stub qui
  renvoie une erreur (« Whisper not compiled »).
- **`default = ["whisper"]`** dans `src-tauri/Cargo.toml` : `cargo build`/`tauri
  build`/`tauri dev` compilent Whisper **sans flag** (Windows + macOS). Échappatoire
  dev : `./scripts/dev-windows.ps1 -NoWhisper` (`--no-default-features`) pour
  bosser sur autre chose sans installer cmake/libclang.
- Deps de build : **cmake**, **libclang** (Windows), Xcode CLT (macOS) — désormais
  requises pour **tout** build, plus seulement un mode « whisper » à part.
- Backend **CPU** par défaut (marche partout) ; Metal (macOS) optionnel.

## Modèle — téléchargé à l'onboarding (plus rien d'embarqué)

- Config `whisper_model` (défaut `small`).
- **Catalogue** (source de vérité Rust : `WHISPER_MODELS`,
  `transcription/mod.rs`) : `tiny` (75 Mo) / `base` (142 Mo) / `small` (466 Mo,
  **recommandé**) / `medium` (1,5 Go) / `large-v3-turbo` (1,5 Go — qualité
  large, vitesse medium). `large-v3` (2,9 Go) et les variantes quantisées q5 :
  hors v1.
- Résolution, dans l'ordre : `Resources/models/ggml-{size}.bin` (gardé pour le
  confort dev — un modèle local `src-tauri/models/` est vu comme installé) →
  `$APP_DATA_DIR/models/ggml-{size}.bin` (**téléchargé**).
- **Aucun modèle embarqué au build** : `bundle.resources: []` (décision CI,
  `.github/workflows/desktop-build.yml`). Le modèle est **téléchargé pendant
  l'onboarding** (étape dédiée, spec/13) ou depuis Réglages → Transcription
  (gestionnaire de modèles, spec/11). *(Anciens scripts
  `fetch-whisper-model.{sh,ps1}` : confort dev uniquement, plus utilisés au
  packaging.)*
- **Téléchargement** : `download_model(size)` depuis
  `huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-{size}.bin`. Écrit
  dans un `.part` puis renomme à la fin — un téléchargement interrompu ne
  laisse pas de `.bin` corrompu pris pour complet ; les `.part` orphelins sont
  ignorés (statut `missing`) et écrasés au retry.
  - Événements : `download-progress { model, percent, bytes_downloaded,
    total_bytes }` · `download-complete { model }` · `download-error { model,
    message, cancelled }`.
  - **Garde anti-doublon** (registre en mémoire, un téléchargement par modèle) +
    **annulation** via `cancel_model_download(size)` (supprime le `.part`).
  - Metrics (spec/15) : `model_download_started` / `model_download_completed` /
    `model_download_failed` `{ model }`.
- **État des modèles** : `list_whisper_models() -> WhisperModelInfo[]`
  (`{ name, size_mb, recommended, status: "downloaded" | "downloading" |
  "missing", active }`) — consommé par le composant partagé
  `WhisperModelPicker` (onboarding + Réglages). **Suppression** :
  `delete_whisper_model(size)` — refusée si le modèle est actif ou en cours de
  téléchargement ; ne touche jamais le dossier Resources.
- Pas de checksum ni de reprise de téléchargement en v1 ; pas de préflight
  d'espace disque (l'erreur d'écriture remonte en `download-error`).

## Pipeline

- File `mpsc<TranscriptionJob>` → `run_transcription_worker`.
- Lecture WAV (`hound`) : gère **Float et Int** (i16 → f32). Resample à **16 kHz**
  via `rubato` si nécessaire.
- Langue : `auto` par défaut, forçable via config `language_hint`.
- Threads : `min(cœurs, 4)`.
- ✅ La langue est écrite dans `transcriptions.language` : le hint forcé s'il est
  défini, sinon la langue **détectée** par Whisper (`full_lang_id_from_state` +
  `get_lang_str`). *(Ancien bug « colonne toujours NULL » corrigé.)*

## Qualité du décodage — 📝 à faire (spec/17)

Aujourd'hui `run_whisper` utilise le réglage le plus faible : `Greedy
{ best_of: 1 }`, aucun seuil, pas de glossaire. Améliorations spécifiées dans
**spec/17** :
- **Beam search** + **seuils anti-hallucination** (`no_speech_thold`,
  `entropy_thold`, `logprob_thold`, `temperature` + `inc`, `suppress_blank`) ;
  threads relevables pour absorber le beam.
- **`initial_prompt` = glossaire** dérivé de `Contexte Alfred.md` (spec/16/17) —
  corrige les noms propres à la source (« Ulysse » vs « Le vice »).

Une **passe unique** sur tout le WAV en v1 (pas de chunking — spec/17 Hors v1).

## Progression — ✅ fait (feedback tests)

- **Fichier court (passe unique, `decode_buffer`)** : branché sur le callback de
  progression **whisper-rs** (`FullParams::set_progress_callback_safe`, 0–100),
  posé au moment de construire les params de décodage.
- **Fichier long (transcription parallèle par tranches, spec/17 §5)** : chaque
  worker rapporte sa progression **locale** (0–100 de sa tranche) dans un
  compteur atomique partagé ; le % **global** recomposé à chaque callback =
  somme des progressions locales **pondérées par la durée relative** de chaque
  tranche.
- **Contrat** : `transcription-progress { recording_id, percent }` — débounce
  **sur changement d'entier** (pas de minuteur, la cadence whisper.cpp suffit),
  plus les bornes 0 % / 100 % existantes (`process_job`).
- **UI** : `alfredStatusStore` porte un `progress` (repart à `null` à chaque
  transition d'état) affiché sur l'**indicateur d'état** (« Je prends note…
  {n} % ») et la page de guidage `/recording` (barre + %). **Pas** de doublon
  dans le bandeau topbar — décision déjà actée et testée (spec/10 : un seul
  point de lecture d'état). Repris dans le toast de la **visite guidée**
  (spec/13 étape 3).
- Note d'implémentation : `whisper-rs` ne libère pas la closure boxée passée au
  callback (pas de hook côté FFI) — fuite mémoire négligeable à cette échelle
  (v1, ~10 utilisateurs, quelques octets par transcription).

Fin : `transcription-complete` ou `transcription-failed { recording_id,
message }` — ✅ émis par le worker sur toute erreur, y compris **modèle
manquant** (message dédié invitant à passer par Réglages → Transcription).
L'UI (`App.tsx`) affiche une bannière d'échec, avec bouton « Ouvrir les
Réglages » dans le cas modèle manquant.

## Sorties dans le vault (au succès, si vault configuré)

1. **Déplacement du WAV** dans le vault — cible **`alfred-raw/`** (même dossier
   que la note d'enregistrement). **Le WAV est toujours conservé dans
   `alfred-raw/`, jamais supprimé** (ré-écoute / ré-ingestion).
2. **Note d'enregistrement** (titre `YYYY-MM-DD HHhMM`). ✅ Écrite **avec
   frontmatter** (`NoteMetadata::for_recording` : `type: meeting`, `date`,
   `recording_id`) + corps `# Transcription`. `participants`/`project` restent
   vides sur la note brute (peuplés par l'IA plus tard — spec/07). Le
   `recording_id` du frontmatter est ce qui relie « ré-ingérer » (spec/05) à
   l'enregistrement d'origine.
3. Émet `notes-updated`.
4. Déclenche l'**extraction de todos** puis l'**ingestion** (compte-rendu dans
   `alfred-intelligence/`) — spec 05.

Si pas de vault : le WAV est supprimé, aucune note créée.

## Stockage SQLite

Table `transcriptions` (`raw_text`, `segments_json`, `whisper_model`,
`processed_at`). `recordings.status = 'done'`.

## Commandes Tauri (réel)

- `download_model(size)` (événements : voir §Modèle)
- `cancel_model_download(size)`
- `delete_whisper_model(size)`
- `list_whisper_models() -> WhisperModelInfo[]`
- `get_transcription(recording_id) -> JSON | null`

(`retranscribe` de l'ancienne spec **non implémentée**.)

## Hors v1 / plus tard

Diarisation (locuteurs), VAD, backend GPU (la progression fine passe **en v1** —
voir §Progression)
(CUDA / Vulkan / Metal) réglable.
