# spec/04 — Transcription (Whisper local)

> **Statut v1 :** Whisper **activé par défaut**, cross-platform. Écrit dans le
> vault (`alfred-raw/`) puis déclenche l'IA.

## Vue d'ensemble

Au `stop_recording`, le WAV est mis en file. Un **worker unique** (pas de
parallélisme — Whisper est intensif) le transcrit via `whisper-rs` dans
`spawn_blocking`, stocke les métadonnées en SQLite, **déplace l'audio + crée la
note dans le vault**, puis déclenche l'IA (extraction de todos + ingestion,
spec 05).

## Whisper = feature Cargo

- `whisper-rs` est derrière la feature Cargo **`whisper`**. Sans elle → stub qui
  renvoie une erreur (« Whisper not compiled »).
- **« Activé par défaut » ⇒ les builds livrés compilent avec `--features whisper`**
  (Windows + macOS).
- Deps de build : **cmake**, **libclang** (Windows), Xcode CLT (macOS). Packaging
  à couvrir dans le build de release (voir README).
- Backend **CPU** par défaut (marche partout) ; Metal (macOS) optionnel.

## Modèle

- Config `whisper_model` (défaut `small` ; valeurs `tiny` / `base` / `small` /
  `medium` / `large-v3`).
- Résolution, dans l'ordre : `Resources/models/ggml-{size}.bin` (**embarqué au
  build**) → `$APP_DATA_DIR/models/ggml-{size}.bin` (**téléchargé**).
- Téléchargement : `download_model(size)` depuis
  `huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-{size}.bin`, émet
  `download-progress`.
- **Décidé :** `small` est **embarqué** dans l'installeur (marche hors-ligne dès
  le 1er lancement, zéro friction). Les modèles plus gros (`large-v3`…) sont
  **téléchargeables en option** depuis les Réglages.

## Pipeline

- File `mpsc<TranscriptionJob>` → `run_transcription_worker`.
- Lecture WAV (`hound`) : gère **Float et Int** (i16 → f32). Resample à **16 kHz**
  via `rubato` si nécessaire.
- Langue : `auto` par défaut, forçable via config `language_hint`.
- Threads : `min(cœurs, 4)`.
- ⚠️ **Bug** : la langue détectée n'est **pas** écrite dans
  `transcriptions.language` (colonne toujours NULL) — à corriger.

## Progression

Émet `transcription-progress` à **0 % puis 100 %** seulement (pas de granularité).
À améliorer (lié au feedback live, spec 03). Fin : `transcription-complete` ou
`transcription-failed`.

## Sorties dans le vault (au succès, si vault configuré)

1. **Déplacement du WAV** dans le vault — cible **`alfred-raw/`** (même dossier
   que la note d'enregistrement). **Le WAV est toujours conservé dans
   `alfred-raw/`, jamais supprimé** (ré-écoute / ré-ingestion).
2. **Note d'enregistrement** (titre `YYYY-MM-DD HHhMM`). ⚠️ Aujourd'hui contenu
   brut « # Contexte / # Transcription » **sans frontmatter**. Cible (spec 07) :
   frontmatter `type: meeting`, `date`, `recording_id`, `participants`, `project`.
   Le constructeur `NoteMetadata::for_recording` existe déjà mais n'est pas utilisé.
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

Progression par segment, diarisation (locuteurs), VAD, backend GPU
(CUDA / Vulkan / Metal) réglable.
