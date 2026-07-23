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

**Défaut = `mixed` (✅ fait, corrigé 2e passe — feedback tests).** La source par
défaut est **`mixed`** (micro + système) — on capte l'interlocuteur (visio,
appel) sans réglage. Config `recording_source` (défaut `mixed` si absente en
base), modifiable dans les Réglages (spec/11). Les points de départ sans
source explicite (logo, carte d'accueil, page de guidage) appellent
`startRecording()` sans argument, qui lit cette config côté frontend **au lieu
de** `"mic_only"` codé en dur.

> **Bug corrigé** : le défaut n'avait en réalité JAMAIS pris effet. La
> migration `001_initial.sql` insère littéralement `('recording_source',
> 'mic_only')` au tout premier lancement — `get_config` ne renvoyait donc
> jamais `NULL` pour cette clé, et le repli `?? "mixed"` côté front
> (`recordingStore.ts`) n'était atteint sur AUCUNE install, neuve ou ancienne.
> On ne peut pas modifier une migration déjà appliquée (checksum sqlx) :
> `014_recording_source_mixed_default.sql` corrige la valeur en base pour les
> lignes encore à `mic_only`.

**Repli gracieux (✅ fait)** : sur une plateforme où `mixed`/`system_only` n'est
pas dispo (macOS tant que le helper Swift n'est pas fait), `start_recording`
retombe **automatiquement sur `mic_only`** côté backend — jamais d'échec au
démarrage. Le **contexte à la voix** (visite guidée, spec/13) reste en
`mic_only` explicite (une seule voix, pas besoin du système).

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
- **UX** : petite icône **⬆ import** incrustée sur la **carte d'enregistrement**
  de l'accueil (coin haut-droit, visible seulement à l'état repos) — pas de
  second bouton pleine largeur côte à côte. Ouvre le sélecteur de fichier natif
  (filtré `.wav`). Un WAV illisible renvoie une erreur claire avant toute mise
  en file.
- **Metrics** : émet `recording_completed` avec `{ source: "import" }`.

### Intégration UI du bouton — ✅ fait

Le bouton pleine largeur « Importer un audio » (page de guidage + accueil) a
été retiré ; l'import est désormais une petite icône incrustée sur la **carte
d'enregistrement** de l'accueil (coin haut-droit). **Retour (feedback tests)** :
retiré du **logo** de la sidebar — celui-ci ne doit porter que le déclencheur
d'enregistrement, rien d'autre. Le comportement (picker `.wav` → même file de
transcription) ne change pas. La page de guidage (`/recording`) ne propose pas
l'import directement (état repos rarement atteint là — après un « Annuler » —
l'utilisateur revient au logo/à la carte).

## Segmentation

Le WAV continu reste **LE** fichier audio : un seul fichier jusqu'au `stop`,
pas de VAD sur le fichier. (L'ancienne spec décrivait une segmentation VAD sur
silences — non implémentée, hors v1.)

## Machine à états

```
Idle → Recording → (Terminer) → Processing auto (transcription → analyse)
                                   → /resolve (vérifier/corriger) → (Valider) → compte-rendu + tâches → Idle
Recording → (Annuler) → Idle (WAV jeté, rien en aval)
```

(Plus de panneau de sélection post-arrêt — feedback tests ; voir §Arrêt. La prise
de **contexte** garde sa revue « Recommencer / Continuer », spec/13.)

### Enregistrer pendant qu'Alfred transcrit/analyse — ✅ corrigé (feedback tests)

Constat : impossible de **lancer une nouvelle prise** tant qu'Alfred transcrit ou
« cogite ». On veut pouvoir **enchaîner** (réunion 2 pendant que la réunion 1 se
traite).

**Le backend le permettait déjà**, aucun changement nécessaire côté Rust :
`audio::start_recording`/`lib.rs::start_recording` ne bloquent que pendant une
**dictée** (pas la transcription) ; `transcription::enqueue_job` empile dans un
**worker en file** (mpsc) → une 2ᵉ prise **s'enfile** derrière (séquentiel, adapté au
Whisper CPU) ; la capture de la prise 1 est terminée au `stop` (micro libre) et son
`recording_id` est enfilé **avant** de rendre la main (pas de collision sur le slot
`active_recording_id`).

**Diagnostic exact (le blocage était côté front)** : `recordingStore.status`
(`src/store/recordingStore.ts`) confondait **capture** et **traitement**. Au `stop`,
`audio::stop_recording` émet `recording-status-changed{status:"stopped"}`, puis
`lib.rs::stop_recording` (purpose `"meeting"`) enfile `enqueue_processing` qui émet
`{status:"processing"}` — état qui persiste jusqu'à l'event `transcription-complete`
(qui, lui, ramène `recordingStore.status` à `"idle"` dans `App.tsx`). Deux
déclencheurs testaient une égalité stricte sur `"idle"` et bloquaient donc pendant
toute la fenêtre `"processing"` (= la phase de décodage Whisper — l'ingestion/
« cogite » qui suit ne touche jamais `recordingStore`, seulement `alfredStatusStore`,
donc n'était **déjà pas** bloquante) :
- **`App.tsx` → `AlfredLogo.handleClick`** (logo sidebar) : `else if (recStatus === "idle")`.
- **`src/screens/Dashboard.tsx` → `HeroCard`** (carte d'accueil) : `onClick={isIdle ? handleStart : undefined}`.

**Correctif appliqué (front uniquement, aucun changement backend/état persisté)** :
un nouveau dérivé `canStartNewTake` (`recStatus === "idle" || "processing" || "error"`)
remplace le test `=== "idle"` aux deux endroits ci-dessus — une capture n'est
réellement active que sur `"recording"`/`"paused"` (`isRecording`, inchangé) ;
`"stopping"`/`"stopped"` restent bloquants (transition très brève au `stop`, ou revue
contexte spec/13 en attente d'une décision explicite — pas visés par le constat).
**Deux indicateurs coexistent déjà** (spec/10) : la pastille « où Alfred travaille »
(`alfredStatusStore`, alimentée par `transcription-progress`/`ingestion-status-changed`,
totalement indépendante de `recordingStore`) reste visible sur la prise 1 en
traitement pendant que la prise 2 enregistre — aucun changement nécessaire là.
**Séquentiel assumé** : les transcriptions restent traitées **une par une** (file) ;
la parallélisation réelle de Whisper (plusieurs contextes) est **hors v1**, non
nécessaire. `src/components/RecordingBar.tsx` et `src/screens/RecordingGuide.tsx`
n'avaient pas besoin de changement (ils n'affichent la progression que de la prise
active/en file, jamais de déclencheur bloquant).

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

## Arrêt : traitement automatique (plus de panneau de sélection) — ✅ fait

> **Changement (feedback tests) — retour arrière assumé sur le panneau de sélection.**
> Le panneau post-arrêt « prise terminée » avec **cases *Transcription / Compte-rendu
> / Tâches* + Supprimer / Continuer** (RecordingReview) est **retiré** : trop de
> friction. Après l'arrêt, **tout est lancé automatiquement** : transcription →
> compte-rendu → tâches. Plus de choix à faire.

Nouveau flux :

- **Arrêter → traitement automatique** : transcription **puis** analyse, sans écran
  intermédiaire ni cases à cocher. Compte-rendu **et** tâches sont **toujours**
  générés.
- **La vérification `/resolve` est conservée** (spec/17, point 23) : le compte-rendu
  et les tâches ne sont écrits **qu'après le « Valider »** de l'écran de
  vérification/correction — c'est le seul point de contrôle, présenté après la
  transcription (plus court s'il n'y a rien à corriger). Le panneau de **sélection**
  disparaît, **pas** la vérification.
- **Annuler / supprimer** (les deux conservés) :
  - **Annuler pendant l'enregistrement** — bouton **Annuler** (à côté d'Arrêter,
    visuellement distinct) : stoppe la prise et **jette le WAV**, rien en aval
    (confirmation, l'audio est perdu).
  - **Supprimer après coup** — si l'enregistrement était raté, supprimer la note /
    les tâches produites (Notes / Tâches).

**Impact spec/05** : le sélecteur `{summary, tasks}` de l'ingestion **reste** côté
backend (capacité utile, ré-ingestion ciblée) mais **l'UI ne l'expose plus** — un
enregistrement lance **toujours** compte-rendu + tâches (`{summary:true, tasks:true}`).

**Impact spec/13 (téléprompteur de contexte)** : la revue « Recommencer / Continuer »
du téléprompteur (mode `context`) **reste** — l'utilisateur doit pouvoir se reprendre
sur la prise de contexte ; c'est la **sélection de traitements aval** (réunion) qui
disparaît, pas la reprise de prise. (Auparavant ce panneau était partagé ; il faut
donc les **découpler** : garder Recommencer/Continuer côté contexte, retirer les
cases côté réunion.)

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
