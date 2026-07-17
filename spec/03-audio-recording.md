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

## Import de fichier audio — ✅ fait

Alfred sait transcrire un **fichier audio existant** (pas seulement une capture
live) : par ex. un enregistrement fait ailleurs, ou l'audio extrait d'une vidéo.

- **Entrée : WAV uniquement** (PCM 16-bit ou float, mono ou multi-canaux — le
  module de transcription rééchantillonne à 16 kHz et downmixe au besoin, cf.
  spec 04). Les autres formats (mp3, m4a, mp4…) sont **hors périmètre du picker** :
  l'utilisateur convertit d'abord (`ffmpeg -i in.mp4 -vn -ac 1 -ar 16000 out.wav`).
- **Flux** : le fichier choisi est **copié** dans
  `$APP_DATA_DIR/recordings/{recording_id}.wav` (nouvel `id`), une ligne
  `recordings` est créée avec **`source = 'import'`** et `status = 'processing'`,
  puis le WAV est mis dans **la même file de transcription** que le live
  (aucun chemin de code séparé). La suite est identique : note dans `alfred-raw/`,
  déplacement du WAV dans le vault, ingestion (spec 04/05).
- **UX** : bouton **« Importer un audio »** sur la page de guidage (`/recording`,
  état idle), à côté de « Démarrer l'enregistrement ». Ouvre le sélecteur de
  fichier natif (filtré `.wav`). Un WAV illisible renvoie une erreur claire
  avant toute mise en file.
- **Metrics** : émet `recording_completed` avec `{ source: "import" }`.

## Segmentation

Le WAV continu reste **LE** fichier audio : un seul fichier jusqu'au `stop`,
pas de VAD sur le fichier. (L'ancienne spec décrivait une segmentation VAD sur
silences — non implémentée, hors v1.)

## Machine à états

```
Idle → Recording → (Terminer) → Revue « prise terminée »
                                   ├─ Supprimer  → Idle (WAV jeté, rien en aval)
                                   └─ Continuer  → Processing (traitements cochés) → Idle
Recording → (Annuler) → Idle (WAV jeté, rien en aval)
```

Événement émis : `recording-status-changed { status, duration_seconds, volume? }`.
✅ Pour la capture micro (`mic_only` et le volet micro de `mixed`), `duration_seconds`
et `volume` (RMS 0..1) sont émis en direct toutes les ~250 ms — plus de `0` figé.
`system_only` (WASAPI loopback) n'émet pas encore de volume live (scope v1 : micro).

## UX v1 (détail avec spec 10) — ✅ fait

- **Déclenchement** : ✅ le **logo Alfred** (sidebar, `App.tsx` → `AlfredLogo`)
  est un déclencheur (hover → icône micro en surimpression ; clic → démarre si
  idle, puis navigue vers `/recording` ; **pendant l'enregistrement, clic =
  stop** — hover → icône stop, liseré rouge). L'état majordome s'affiche en
  permanence **sous le logo** — lecture d'état unique de l'app (spec/10). La carte d'enregistrement de l'accueil
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
  en JSON). Conseils par défaut actuels :
  - Présente les participants : prénom + rôle.
  - Annonce le sujet / objectif en une phrase au début.
  - Quand tu donnes une tâche, nomme le responsable (prénom).
  - Récapitule les décisions à la fin.
  - Épelle les noms propres / termes techniques peu courants.
- **Retour d'état live** : ✅ **visualisation du volume micro** + **timer** —
  niveau (RMS) + durée dans `recording-status-changed` toutes les ~250 ms,
  affichés à la fois dans le bandeau topbar et en grand sur la page de guidage.

### Conseils de captation par type de captation — ✅ fait (feedback tests)

La liste unique et générique est **trop pauvre**. On propose **plusieurs modèles de
captation selon le type**, chacun avec sa **phrase d'ouverture** (ce qu'il faut dire
en premier) + ses conseils ciblés. L'utilisateur **choisit un type** sur la page de
guidage (sélecteur en tête des conseils) et voit le guidage adapté. Types par défaut
(éditables) :

- **Note personnelle** — ouvrir par *« Ceci est une note personnelle sur … »* ;
  contexte/sujet ; pas de participants.
- **Réunion client** — annoncer *« Réunion avec le client {nom}, participants : … »* ;
  nommer **tous les participants** (côté client + interne) et leur rôle ; le
  nom du client / projet ; décisions + tâches avec responsable.
- **One-to-one** — *« One-to-one avec {prénom} »* ; sujet ; points d'action.
- **Réunion d'équipe** — participants internes ; ordre du jour ; décisions/tâches.
- (**Autre / libre** — la liste générique actuelle.)

**Modèle** : `capture_tips` (config JSON) passe d'une **liste plate** à un
**dictionnaire par type** `{ [type]: { opener, tips[] } }`, éditable en place (le
« Modifier » existant s'applique au type sélectionné). Défauts côté front, comme
aujourd'hui.

**Extension possible** (à trancher, cf. `purpose` spec/13) : le type choisi pourrait
être **transmis à l'ingestion** comme indice (meilleur compte-rendu, pré-remplir
`type`/participants) et/ou vers le nommage. Hors périmètre strict de cette tâche —
signalé pour décision.

## Arrêt : annuler / continuer + choix des traitements aval — ✅ fait (feedback tests)

« Terminer » ne déclenche plus rien : le pipeline aval est **optionnel et
interruptible** :

- **Annuler pendant l'enregistrement** — un bouton **Annuler** (à côté d'Arrêter,
  visuellement distinct) stoppe la prise et **jette le WAV** sans rien lancer en
  aval. Confirmation (« Supprimer cet enregistrement ? ») car l'audio est perdu.
- **« Terminer » → état « prise terminée » (revue)** — au lieu de lancer direct,
  on affiche un panneau proposant :
  - **Supprimer** — jette la prise (équivaut à Annuler après coup).
  - **Continuer** — lance **seulement** les traitements cochés.
  - **Choix des traitements aval** (cases **cochées par défaut**) :
    1. **Transcrire l'audio** (spec/04),
    2. **Créer le compte-rendu** (spec/05),
    3. **Créer les tâches** (spec/06).

    **Dépendances** : compte-rendu et tâches nécessitent la transcription →
    décocher (1) grise (2) et (3). Décocher tout revient à ne garder que le WAV /
    la note brute.

> **Impact spec/05 (à acter).** Compte-rendu et tâches sortent aujourd'hui d'un
> **seul appel d'ingestion fusionnée** (`run_ingestion_for_recording`). Le choix
> **3 cases** (compte-rendu ≠ tâches, décidé au test) impose de **découpler** cette
> sortie : soit deux appels, soit un appel à **sortie conditionnelle** (n'émettre
> que la ou les sections demandées). Voir spec/05.

Ce panneau de revue est **le même** que celui du téléprompteur de la visite guidée
(spec/13 étape 2), au « purpose » près : en mode `context`, pas de cases
compte-rendu/tâches (le traitement aval est la structuration du contexte).

## Nettoyage WAV

Après transcription confirmée en DB (spec 04) : supprimer le WAV et passer
`recordings.status = 'done'` (le record DB reste).

## Commandes Tauri (réel)

- `start_recording(source)` — `"mic_only" | "system_only" | "mixed"`
- `stop_recording() -> recording_id` — **s'arrête sans lancer l'aval** : passe en
  revue « prise terminée » (`recordings.status = 'stopped'`, migration 012) et
  émet `recording-status-changed { status: "stopped", recording_id, purpose }`.
- **`cancel_recording()`** — arrête + **jette le WAV** (+ ligne DB), aucun aval
  (bouton Annuler pendant la prise).
- **`discard_recording(recording_id)`** — supprime une prise en revue (bouton
  Supprimer) ; partagé avec le « Recommencer » du téléprompteur (spec/13).
- **`process_recording(recording_id, { transcribe, summary, tasks })`** — lance
  les traitements aval **cochés** (bouton Continuer). `transcribe=false` → le WAV
  est simplement déplacé dans le vault (rien d'aval).
- **`pause_recording()` / `resume_recording()`** (spec/13) — pause/reprise de la
  capture : les frames sont **jetées** (mic + loopback WASAPI, pas d'insertion de
  silence) et le chrono se fige (le backend exclut le temps de pause de
  `duration_seconds` ; état émis : `"paused"`).
- **`start_dictation()` / `stop_dictation() -> String`** (à ajouter, spec/07b) —
  **dictée éphémère** : capture micro courte → `run_whisper` (glossaire spec/17) →
  **rend le texte** (saisie chat), WAV temporaire supprimé. **Pas** de note, pas de
  ligne `recordings`, pas d'ingestion ; état via `dictation-status-changed` (pas le
  bandeau global). Désactivée pendant un enregistrement de réunion (capture = singleton).
- `import_audio_file() -> Option<recording_id>` — ouvre le sélecteur de fichier
  (filtre `.wav`), copie le WAV choisi et le met en file de transcription ;
  `None` si l'utilisateur annule.
- `test_microphone()` — ouvre brièvement le micro (déclenche la permission macOS) ; utilisé par l'onboarding.

(Les commandes `list_recordings` / `delete_recording` / `get_recording_status`
de l'ancienne spec ne sont **pas** implémentées — à ajouter seulement si l'UI en
a besoin.)

## Hors v1 / plus tard

Segmentation VAD, sélection du device d'entrée, enregistrement multi-piste.
