# spec/03 — Audio Recording

> **Décisions à trancher dans ce document :**
> - **D1** : ScreenCaptureKit FFI (`objc2`) ou helper Swift binaire pour l'audio système → **Décidé : helper Swift binaire** (voir section Audio système)
> - **D2** : VAD vs overlap pour la segmentation → **Décidé : VAD** (voir section Segmentation)

---

## Sources audio

Alfred peut enregistrer depuis trois sources :

| Source | Description |
|---|---|
| `mic_only` | Microphone uniquement (défaut v1) |
| `system_only` | Audio système uniquement (Meet, musique, etc.) |
| `mixed` | Micro + audio système mixés |

---

## Enregistrement microphone — `cpal`

Crate : `cpal` v0.15+

### Paramètres de capture

```
Sample rate : 16 000 Hz (format natif Whisper — évite le resampling)
Channels    : 1 (mono)
Sample format: f32
Buffer size : 4096 frames
```

Si le device ne supporte pas 16kHz nativement, capturer en 44.1kHz/48kHz et resampler (voir spec/04 — Resampling).

### Écriture des fichiers WAV

Crate : `hound` v3.5+

Les échantillons sont écrits en continu dans un fichier WAV à `$APP_DATA_DIR/recordings/{recording_id}.wav`.

```rust
let spec = hound::WavSpec {
    channels: 1,
    sample_rate: 16000,
    bits_per_sample: 32,
    sample_format: hound::SampleFormat::Float,
};
let writer = hound::WavWriter::create(&path, spec)?;
```

### Segmentation — décision D2 : VAD

Les enregistrements ne sont pas découpés sur un timer fixe de 30s. On utilise la **Voice Activity Detection (VAD)** pour couper sur les silences naturels.

**Pourquoi VAD plutôt qu'overlap :**
- Les coupures mi-phrase avec overlap produisent des doublons de texte difficiles à dédupliquer
- VAD garantit que chaque segment se termine sur un silence → Whisper transcrit des phrases complètes
- `whisper-rs` expose `is_speech()` utilisable pour détecter les silences

**Implémentation VAD :**
```
- Accumuler les échantillons dans un buffer glissant
- Tous les 30ms, calculer l'énergie RMS du buffer (ou utiliser webrtc-vad via crate)
- Si énergie < seuil ET durée silence > 1.5s ET segment courant > 10s → couper le segment
- Maximum absolu : 60s par segment (couper même si pas de silence)
- Minimum : 5s (ne pas créer des segments trop courts)
```

Chaque segment produit un fichier WAV séparé : `{recording_id}_{segment_index}.wav`.

---

## Audio système — décision D1 : helper Swift binaire

### Pourquoi pas `objc2` FFI direct

ScreenCaptureKit requiert des appels async en Objective-C/Swift avec des delegates et des completion handlers. Implémenter cela via FFI `objc2` depuis Rust est possible mais très fragile à maintenir. Tout changement d'API Apple casse le FFI.

### Solution : helper Swift binaire

Un binaire Swift séparé `alfred-audio-helper` capture l'audio système via ScreenCaptureKit et envoie les samples PCM vers Alfred via stdin/stdout pipe.

```
Alfred (Rust) ──spawn──► alfred-audio-helper (Swift)
                              │ ScreenCaptureKit
                              │ (audio système)
                              │ 
             ◄──PCM f32─────── stdout pipe (raw bytes)
```

**Interface du helper :**
- Arguments : `--sample-rate 16000 --channels 1`
- Stdin : commandes JSON (`{"cmd": "start"}`, `{"cmd": "stop"}`)
- Stdout : raw f32 PCM samples (little-endian, 16kHz mono)
- Stderr : logs / erreurs

**Rust côté Alfred :**
```rust
let mut child = Command::new("alfred-audio-helper")
    .args(["--sample-rate", "16000", "--channels", "1"])
    .stdin(Stdio::piped())
    .stdout(Stdio::piped())
    .spawn()?;

// Lire les samples depuis stdout
let stdout = child.stdout.take().unwrap();
let reader = BufReader::new(stdout);
// Lire les bytes f32 LE et les écrire dans le WAV
```

Le helper est embarqué dans le bundle .app à `Contents/Resources/alfred-audio-helper`.

### Entitlement requis pour ScreenCaptureKit

`NSScreenCaptureUsageDescription` dans Info.plist.

Le helper doit aussi avoir cet entitlement dans son propre `.entitlements` plist.

### Comportement si ScreenCaptureKit non disponible (macOS < 12.3)

Détecter la version macOS au démarrage. Si < 12.3, désactiver les options `system_only` et `mixed` dans l'UI avec un message "Nécessite macOS 12.3+".

---

## Machine à états

```
         start_recording()
Idle ─────────────────────► Recording
 ▲                              │
 │                   stop_recording()
 │                              │
 │   Error.dismiss()            ▼
Error ◄──────────────────── Stopping
 ▲                              │
 │                     (fichier WAV écrit)
 │                              ▼
 │    (transcription failed) ProcessingTranscription
 └───────────────────────────── │
                                │ (transcription done)
                                ▼
                              Idle
```

### État `Error(String)`

Déclenché par :
- Micro non disponible ou permission refusée → `Error("Microphone not available")`
- Device audio déconnecté pendant l'enregistrement → `Error("Audio device disconnected")`
- Erreur d'écriture disque → `Error("Disk write failed: {details}")`
- Crash du helper Swift → `Error("System audio helper crashed")`

L'erreur est affichée à l'utilisateur avec un bouton "OK". Après acquittement, retour à `Idle`.

```rust
pub enum RecordingState {
    Idle,
    Recording { started_at: Instant, recording_id: String },
    Stopping,
    ProcessingTranscription { recording_id: String },
    Error(String),
}
```

### Stockage de l'état

```rust
pub struct AudioState {
    pub state: Arc<Mutex<RecordingState>>,
    pub system_audio_child: Arc<Mutex<Option<Child>>>,
    pub cpal_stream: Arc<Mutex<Option<cpal::Stream>>>,
}
```

---

## Nettoyage des fichiers WAV

Après que la transcription est confirmée écrite en DB (`transcriptions.status = done`) :
1. Vérifier que `transcriptions.recording_id = recording_id` et status = done
2. Supprimer le fichier WAV (`std::fs::remove_file`)
3. Mettre à jour `recordings.status = 'done'` (le record DB est conservé)

Si la suppression échoue (fichier déjà absent), ne pas mettre l'app en erreur — loguer et continuer.

---

## Entitlements requis

Voir spec/12 pour la liste complète. Pour ce module :
- `com.apple.security.device.audio-input`
- `NSMicrophoneUsageDescription` : `"Alfred utilise le microphone pour enregistrer des notes vocales et les transcriptions de réunions."`
- `NSScreenCaptureUsageDescription` : `"Alfred capture l'audio système pour transcrire vos réunions et appels."` (si `mixed` ou `system_only` activé)

---

## Commandes Tauri

```rust
#[tauri::command]
async fn start_recording(
    source: RecordingSource,  // "mic_only" | "system_only" | "mixed"
    state: State<AppState>,
    app: AppHandle,
) -> Result<String, String>  // Retourne recording_id

#[tauri::command]
async fn stop_recording(state: State<AppState>) -> Result<(), String>

#[tauri::command]
async fn get_recording_status(state: State<AppState>) -> Result<RecordingStatus, String>
// RecordingStatus: { state: string, duration_seconds: number, recording_id: string | null, error: string | null }

#[tauri::command]
async fn list_recordings(state: State<AppState>) -> Result<Vec<Recording>, String>

#[tauri::command]
async fn delete_recording(id: String, state: State<AppState>) -> Result<(), String>
```

### Événement en continu pendant l'enregistrement

```
"recording-status-changed" → {
    state: "recording" | "stopping" | "processing" | "error",
    duration_seconds: number,
    recording_id: string | null,
    error: string | null
}
```

Émis toutes les **secondes** via `tokio::time::interval(Duration::from_secs(1))` pendant que `state = Recording`.
