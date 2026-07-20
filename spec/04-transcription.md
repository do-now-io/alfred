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

## Modèle — ✅ `small` embarqué

- Config `whisper_model` (défaut `small` ; valeurs `tiny` / `base` / `small` /
  `medium` / `large-v3`).
- Résolution, dans l'ordre : `Resources/models/ggml-{size}.bin` (**embarqué au
  build**) → `$APP_DATA_DIR/models/ggml-{size}.bin` (**téléchargé**).
- **Bundling** : `tauri.conf.json` → `bundle.resources: ["models/ggml-small.bin"]`.
  Le fichier doit exister sous `src-tauri/models/` **avant** `tauri build` — il
  est gitignoré (466 Mo) et récupéré par `scripts/fetch-whisper-model.{sh,ps1}`
  (appelé par `build-macos.sh` / `scripts/build-windows.ps1`, idempotent). `tauri
  dev` ne bundle rien : les devs sans le fichier local ne sont pas bloqués.
- Téléchargement (modèles optionnels depuis les Réglages) : `download_model(size)`
  depuis `huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-{size}.bin`,
  émet `download-progress`. Écrit dans un `.part` puis renomme à la fin —
  un téléchargement interrompu ne laisse plus de `.bin` corrompu pris pour complet.

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

Fin : `transcription-complete` ou `transcription-failed`.

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

- `download_model(size)`
- `get_transcription(recording_id) -> JSON | null`

(`retranscribe` de l'ancienne spec **non implémentée**.)

## Hors v1 / plus tard

Diarisation (locuteurs), VAD, backend GPU (la progression fine passe **en v1** —
voir §Progression)
(CUDA / Vulkan / Metal) réglable.
