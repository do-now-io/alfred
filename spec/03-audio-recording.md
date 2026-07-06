# spec/03 — Audio Recording

> **Statut v1 :** micro fonctionnel ; **audio système à coder** (Windows + macOS).

## Vue d'ensemble

Alfred enregistre l'audio dans un fichier WAV, transcrit ensuite en local
(spec 04). L'enregistrement écrit dans
`$APP_DATA_DIR/recordings/{recording_id}.wav`, puis le WAV est mis en file de
transcription au `stop`.

## Sources

| Source | Statut |
|---|---|
| `mic_only` | ✅ fait |
| `system_only` (audio système) | 🚧 à coder |
| `mixed` (micro + système) | 🚧 à coder |

(La table `recordings.source` accepte déjà les trois valeurs.)

## Capture micro — état réel (cpal)

- `cpal`, `default_input_device`, **config native** du device (sample rate et
  nombre de canaux non forcés — évite les panics « sample rate out of range »).
- Downmix **mono**, écriture WAV **PCM 16-bit** au sample rate natif via `hound`.
- Le resampling à **16 kHz** (requis par Whisper) est fait **côté transcription**
  (spec 04), pas ici.
- Fichier : `$APP_DATA_DIR/recordings/{recording_id}.wav`.
- ⚠️ **Bug connu :** le callback suppose des échantillons `f32` ; certains
  devices WASAPI (Windows) fournissent du `i16` → échec au runtime. À durcir en
  gérant le `SampleFormat` réel du device.

## Audio système — À CONSTRUIRE

Rien n'est implémenté aujourd'hui (seul le micro est capté).

- **Windows :** WASAPI **loopback** (via `cpal` en mode loopback, ou la crate `wasapi`).
- **macOS :** ScreenCaptureKit (≥ 12.3) via un **helper Swift** séparé (approche
  retenue — la plus robuste).
- `mixed` = micro + système mixés en un flux mono.
- Permissions : voir spec 12 (capture d'écran sur macOS ; rien de spécial Windows).

## Segmentation

Pas de VAD en v1 : **un seul WAV continu** jusqu'au `stop`. (L'ancienne spec
décrivait une segmentation VAD sur silences — non implémentée, hors v1.)

## Machine à états

`Idle → Recording → (stop) → Processing (transcription, spec 04) → Idle`

Événement émis : `recording-status-changed { status, duration_seconds }`.
⚠️ `duration_seconds` vaut `0` aujourd'hui — à compléter (voir feedback live).

## UX v1 (détail avec spec 10)

- **Déclenchement** : le **logo Alfred** (haut-gauche, animation micro au hover)
  **est** le déclencheur — un seul contrôle. Le **bandeau** persistant n'apparaît
  que **pendant** l'enregistrement (timer + volume + bouton stop).
- **Page de guidage** : lancer un enregistrement redirige vers une page liée à
  l'enregistrement, affichant des **conseils de captation** (liste éditable,
  stockée dans l'app) :
  - Présente les participants : prénom + rôle.
  - Annonce le sujet / objectif en une phrase au début.
  - Quand tu donnes une tâche, nomme le responsable (prénom).
  - Récapitule les décisions à la fin.
  - Épelle les noms propres / termes techniques peu courants.
- **Retour d'état live** : **visualisation du volume micro** + **timer**.
  Implémentation : émettre niveau (RMS) + durée dans `recording-status-changed`
  à cadence régulière (~200 ms–1 s).

## Nettoyage WAV

Après transcription confirmée en DB (spec 04) : supprimer le WAV et passer
`recordings.status = 'done'` (le record DB reste).

## Commandes Tauri (réel)

- `start_recording(source)` — `"mic_only" | "system_only" | "mixed"`
- `stop_recording() -> recording_id`
- `test_microphone()` — ouvre brièvement le micro (déclenche la permission macOS) ; utilisé par l'onboarding.

(Les commandes `list_recordings` / `delete_recording` / `get_recording_status`
de l'ancienne spec ne sont **pas** implémentées — à ajouter seulement si l'UI en
a besoin.)

## Hors v1 / plus tard

Segmentation VAD, sélection du device d'entrée, enregistrement multi-piste.
