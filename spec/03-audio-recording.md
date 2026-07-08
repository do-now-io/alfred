# spec/03 — Audio Recording

> **Statut v1 :** micro fonctionnel ; **audio système à coder** (Windows + macOS).

## Vue d'ensemble

Alfred enregistre l'audio dans un fichier WAV, transcrit ensuite en local
(spec 04). L'enregistrement écrit dans
`$APP_DATA_DIR/recordings/{recording_id}.wav`, puis le WAV est mis en file de
transcription au `stop`.

## Sources

| Source | Windows | macOS |
|---|---|---|
| `mic_only` | ✅ fait | ✅ fait |
| `system_only` (audio système) | ✅ fait (WASAPI loopback) | 🚧 helper Swift à coder |
| `mixed` (micro + système) | ✅ fait (mix au stop) | 🚧 helper Swift à coder |

(La table `recordings.source` accepte les trois valeurs. Sur macOS,
`start_recording` refuse `system_only`/`mixed` avec un message clair.)

## Capture micro — état réel (cpal)

- `cpal`, `default_input_device`, **config native** du device (sample rate et
  nombre de canaux non forcés — évite les panics « sample rate out of range »).
- Downmix **mono**, écriture WAV **PCM 16-bit** au sample rate natif via `hound`.
- Le resampling à **16 kHz** (requis par Whisper) est fait **côté transcription**
  (spec 04), pas ici.
- Fichier : `$APP_DATA_DIR/recordings/{recording_id}.wav`.
- ✅ Le callback gère les formats **`f32` / `i16` / `u16`** selon le device
  (l'ancien bug « f32 supposé » sur certains devices WASAPI est corrigé).

## Audio système

### Windows — ✅ fait (crate `wasapi`)

- **Loopback** sur le **device de rendu par défaut** (`Direction::Render` ouvert
  en capture), mode partagé événementiel, **autoconvert → 16 kHz mono f32**
  (AUTOCONVERTPCM + SRC) → WAV **PCM16 16 kHz mono**.
- Le loopback ne produit des paquets que si quelque chose joue : les timeouts
  d'attente (100 ms) sont **comblés par du silence** pour rester aligné sur
  l'horloge murale.
- **`mixed`** : micro (`{id}.mic.wav`, format natif) + système (`{id}.sys.wav`)
  capturés en parallèle, puis **mixés au stop** (resample linéaire → 16 kHz,
  somme clampée) → `{id}.wav`. Si une des deux captures échoue, l'autre est
  conservée telle quelle. Pas de mixage temps réel (pas de course d'horloges).
- Module : `src-tauri/src/audio/wasapi_loopback.rs` (+ test d'intégration réel
  `captures_system_audio_wav`, 2 s de capture).

### macOS — 🚧 à construire

- ScreenCaptureKit (≥ 12.3) via un **helper Swift** séparé (approche retenue —
  la plus robuste). En attendant, `system_only`/`mixed` renvoient une erreur.
- Permissions : voir spec 12 (capture d'écran sur macOS ; rien de spécial Windows).

## Segmentation

Pas de VAD en v1 : **un seul WAV continu** jusqu'au `stop`. (L'ancienne spec
décrivait une segmentation VAD sur silences — non implémentée, hors v1.)

## Machine à états

`Idle → Recording → (stop) → Processing (transcription, spec 04) → Idle`

Événement émis : `recording-status-changed { status, duration_seconds, volume? }`.
✅ Pour la capture micro (`mic_only` et le volet micro de `mixed`), `duration_seconds`
et `volume` (RMS 0..1) sont émis en direct toutes les ~250 ms — plus de `0` figé.
`system_only` (WASAPI loopback) n'émet pas encore de volume live (scope v1 : micro).

## UX v1 (détail avec spec 10) — ✅ fait

- **Déclenchement** : ✅ le **logo Alfred** (sidebar, `App.tsx` → `AlfredLogo`)
  est un déclencheur (hover → icône micro en surimpression ; clic → démarre si
  idle, puis navigue vers `/recording`). La carte d'enregistrement de l'accueil
  (`HeroCard`) reste un **second point d'entrée équivalent** (même
  démarrage + même redirection) plutôt qu'être retirée — la tournée guidée
  (spec/13) s'appuie dessus, et c'est une affordance d'accueil naturelle ; « un
  seul contrôle » est respecté au sens où les deux mènent à la même expérience.
  Le **bandeau** topbar (`RecordingBar.tsx`) reste affiché pendant tout
  l'enregistrement, quelle que soit la page.
- **Page de guidage** (`/recording`, `RecordingGuide.tsx`) : ✅ affichée après
  déclenchement (ou accessible directement, idle → bouton démarrer). Montre
  timer + volume en grand, bouton Arrêter, et les **conseils de captation**
  (liste éditable en place, persistée via `get_config`/`set_config('capture_tips')`
  en JSON) :
  - Présente les participants : prénom + rôle.
  - Annonce le sujet / objectif en une phrase au début.
  - Quand tu donnes une tâche, nomme le responsable (prénom).
  - Récapitule les décisions à la fin.
  - Épelle les noms propres / termes techniques peu courants.
- **Retour d'état live** : ✅ **visualisation du volume micro** + **timer** —
  niveau (RMS) + durée dans `recording-status-changed` toutes les ~250 ms,
  affichés à la fois dans le bandeau topbar et en grand sur la page de guidage.

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
