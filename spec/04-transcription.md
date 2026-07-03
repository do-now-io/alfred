# spec/04 — Transcription (Whisper local)

> **Décision : D6**
> Vendoring whisper.cpp → **git submodule** dans `src-tauri/whisper.cpp/` pour builds reproductibles

---

## Choix du modèle

| Modèle | Taille | Vitesse Apple Silicon | Qualité FR+EN |
|---|---|---|---|
| tiny | 75 MB | ~5x temps réel | Passable |
| base | 142 MB | ~8x temps réel | Correcte |
| **small** | **466 MB** | **~15x temps réel** | **Bonne — défaut** |
| medium | 1.5 GB | ~5x temps réel | Très bonne |
| large | 3 GB | ~2x temps réel | Excellente |

**Défaut : `small`**. Bon compromis vitesse/qualité pour FR+EN sur Apple Silicon. L'utilisateur peut passer à `medium` dans les Settings.

---

## Crate whisper-rs

```toml
# Cargo.toml
[dependencies]
whisper-rs = { version = "0.11", features = ["metal", "accelerate"] }
```

### Feature `metal`

Active l'inférence GPU via le framework Metal d'Apple (Apple Silicon et Intel Mac avec GPU discret). Réduit le temps de transcription d'un facteur 3-5x.

**Flags de build requis dans `build.rs` :**
```rust
println!("cargo:rustc-link-lib=framework=Metal");
println!("cargo:rustc-link-lib=framework=Foundation");
println!("cargo:rustc-link-lib=framework=Accelerate");
```

### Feature `accelerate`

Active Apple Accelerate (BLAS) pour l'inférence CPU. Utile sur Intel Mac ou comme fallback si Metal n'est pas disponible.

### Vendoring whisper.cpp — D6

**Problème :** `whisper-rs` télécharge et compile whisper.cpp depuis les sources C++. Cela dépend de la version du macOS SDK, de Xcode, et du compilateur C++ installé. Différentes machines peuvent produire des binaires différents ou échouer à compiler.

**Solution : git submodule**

```bash
git submodule add https://github.com/ggerganov/whisper.cpp src-tauri/whisper.cpp
git submodule update --init
```

`whisper-rs` détecte automatiquement un sous-répertoire `whisper.cpp/` adjacent et l'utilise plutôt que de télécharger.

**Version minimale de Xcode testée :** Xcode 15.0 (macOS SDK 14.0). Documenter dans le README.

**Conflit potentiel avec Tauri :** Tauri v2 émet ses propres flags de linker. Si conflit sur `-framework Metal`, ajouter dans `tauri.conf.json` :
```json
"bundle": {
  "macOS": {
    "frameworks": ["Metal", "Accelerate"]
  }
}
```

---

## Téléchargement du modèle — UX

### Premier lancement

Le modèle n'est pas embarqué dans le binaire (466 MB trop lourd). Il est téléchargé au premier lancement.

**URL de téléchargement :**
```
https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.bin
```

**Destination :** `$APP_DATA_DIR/models/ggml-small.bin`

### Comportement offline au premier lancement

L'app démarre **toujours**, même si le modèle n'est pas disponible.

Si le modèle est absent :
- Le bouton Enregistrer est désactivé avec le message : *"Modèle Whisper non disponible — vérifiez votre connexion Internet"*
- Un bouton "Télécharger le modèle" lance le téléchargement
- L'utilisateur peut utiliser le calendrier, les notes texte, et les todos en attendant

### Implémentation du téléchargement

```rust
async fn download_whisper_model(app: &AppHandle, model_size: &str) -> Result<()> {
    let url = format!(
        "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-{}.bin",
        model_size
    );
    let dest = app.path().app_data_dir()?.join("models").join(format!("ggml-{}.bin", model_size));

    let response = reqwest::get(&url).await?;
    let total = response.content_length().unwrap_or(0);
    let mut downloaded: u64 = 0;
    let mut stream = response.bytes_stream();
    let mut file = tokio::fs::File::create(&dest).await?;

    while let Some(chunk) = stream.next().await {
        let bytes = chunk?;
        file.write_all(&bytes).await?;
        downloaded += bytes.len() as u64;

        app.emit("download-progress", serde_json::json!({
            "percent": if total > 0 { (downloaded * 100 / total) as u8 } else { 0 },
            "bytes_downloaded": downloaded,
            "total_bytes": total
        }))?;
    }

    Ok(())
}
```

---

## Pipeline de transcription

### File d'attente

```rust
// Dans AppState
pub transcription_tx: mpsc::Sender<TranscriptionJob>,

pub struct TranscriptionJob {
    pub recording_id: String,
    pub wav_path: PathBuf,
}
```

Un seul worker Tokio consomme la file (pas de parallélisme — Whisper est CPU/GPU intensif) :

```rust
async fn transcription_worker(
    mut rx: mpsc::Receiver<TranscriptionJob>,
    state: Arc<AppState>,
) {
    while let Some(job) = rx.recv().await {
        process_transcription(job, &state).await;
    }
}
```

### Resampling

Si le fichier WAV n'est pas à 16kHz (cas possible avec audio système en 44.1kHz/48kHz) :

Crate : `rubato` v0.14+

```rust
use rubato::{Resampler, SincFixedIn, InterpolationType, InterpolationParameters, WindowFunction};

let params = InterpolationParameters {
    sinc_len: 256,
    f_cutoff: 0.95,
    interpolation: InterpolationType::Linear,
    oversampling_factor: 256,
    window: WindowFunction::BlackmanHarris2,
};
let mut resampler = SincFixedIn::<f32>::new(
    target_sample_rate as f64 / source_sample_rate as f64,
    2.0,
    params,
    chunk_size,
    1, // mono
)?;
```

### Inférence Whisper

L'appel à Whisper est bloquant (C++) — il doit s'exécuter dans `spawn_blocking` :

```rust
let raw_text = tokio::task::spawn_blocking(move || {
    let ctx = WhisperContext::new_with_params(&model_path, WhisperContextParameters::default())?;
    let mut state = ctx.create_state()?;
    let mut params = FullParams::new(SamplingStrategy::Greedy { best_of: 1 });
    params.set_language(Some("auto")); // ou "fr", "en" selon settings
    params.set_print_progress(false);
    params.set_print_realtime(false);

    state.full(params, &samples)?;

    let num_segments = state.full_n_segments()?;
    let mut segments = vec![];
    for i in 0..num_segments {
        segments.push(serde_json::json!({
            "start": state.full_get_segment_t0(i)?,  // en centisecondes
            "end": state.full_get_segment_t1(i)?,
            "text": state.full_get_segment_text(i)?
        }));
    }

    Ok::<(String, String), anyhow::Error>((
        segments.iter().map(|s| s["text"].as_str().unwrap_or("")).collect::<Vec<_>>().join(" "),
        serde_json::to_string(&segments)?
    ))
}).await??;
```

### Progression

Pendant la transcription, émettre des événements de progression basés sur les segments traités :
```
"transcription-progress" → { recording_id: string, percent: number }
```

Whisper ne donne pas de progression native — estimer en comptant les segments émis vs la durée totale.

### Stockage du résultat

```sql
INSERT INTO transcriptions (id, recording_id, raw_text, segments_json, language, whisper_model, processed_at)
VALUES (?, ?, ?, ?, ?, ?, ?);

UPDATE recordings SET status = 'done' WHERE id = ?;
```

Après insertion confirmée, supprimer le fichier WAV (voir spec/03).

---

## Détection de langue

`params.set_language(Some("auto"))` — Whisper détecte automatiquement la langue des premières secondes d'audio.

La langue détectée est lue via `state.full_lang_id()` après transcription et stockée dans `transcriptions.language`.

L'utilisateur peut forcer une langue dans les Settings (voir spec/11) en passant `"fr"` ou `"en"` à `set_language`.

---

## Commandes Tauri

```rust
#[tauri::command]
async fn get_transcription(
    recording_id: String,
    state: State<AppState>,
) -> Result<Option<Transcription>, String>

#[tauri::command]
async fn retranscribe(
    recording_id: String,
    state: State<AppState>,
) -> Result<(), String>
// Remet en file d'attente si le fichier WAV existe encore
```

### Événements

```
"transcription-progress" → { recording_id: string, percent: number }
"transcription-complete" → { recording_id: string, transcription_id: string }
"transcription-failed"   → { recording_id: string, error: string }
```
