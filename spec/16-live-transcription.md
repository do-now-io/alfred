# spec/16 — Transcription live & contexte interne

> **Statut v1 :** 🚧 à construire — live pour `mic_only` (Windows + macOS) ;
> `system_only`/`mixed` gardent le pipeline « full-file au stop » (spec/04).

## Vue d'ensemble

Aujourd'hui la note d'enregistrement n'existe qu'après la transcription complète
du WAV au `stop` (spec/04). Ce module inverse l'expérience : **la note est créée
dès le clic sur enregistrer**, la transcription y apparaît **en live par chunks**
(~8–30 s, coupés sur les silences), l'utilisateur peut **éditer la note pendant
la réunion**, et chaque chunk finalisé est **légèrement amélioré par Claude**
(ponctuation, cohérence, noms propres) grâce à une note de **contexte interne**
(entreprise, équipes, vocabulaire maison).

```
clic logo → start_recording (mic_only + vault + live_transcription ≠ "false")
  ├─ crée alfred-raw/{YYYY-MM-DD HHhMM}.md (NoteMetadata::for_recording, "# Transcription")
  ├─ spawn LiveSession : thread chunker + thread Whisper (contexte chargé UNE fois) + acteur tokio
  ├─ capture cpal avec « tap » : write_frames duplique les samples mono vers le chunker
  └─ émet live-session-started → le frontend ouvre la note (/notes)

boucle : le chunker coupe sur silence (≥ 8 s, RMS < 0,010 pendant ≥ 700 ms) ou force à 30 s
  → resample 16 kHz → Whisper (state.full + initial_prompt = fin du chunk précédent)
  → acteur : append au corps + écrit le fichier + émet live-transcription-chunk
  → file d'amélioration Haiku (séquentielle, 1 appel en vol) :
     original_text encore présent dans le corps → remplace + émet live-chunk-improved
     sinon (l'utilisateur a édité) → skip ; erreur → chunk reste brut

stop → flush du reliquat audio (dernier chunk) → attente améliorations (max 20 s)
  → INSERT transcriptions (raw_text = chunks Whisper originaux, segments rebasés, language)
  → WAV déplacé vers alfred-raw/ (comme aujourd'hui) → transcription-complete
  → ingestion sur le CONTENU FINAL de la note (run_ingestion_for_note) — pas de re-transcription
```

## Périmètre v1

| Source | Live | Fallback |
|---|---|---|
| `mic_only` (Windows + macOS) | ✅ transcription live | — |
| `system_only` / `mixed` (Windows) | 🕓 hors v1 | pipeline full-file au stop (spec/04), inchangé |

**Dégradations** (l'enregistrement ne casse jamais) :

- **Pas de vault configuré** → pipeline actuel inchangé (pas de note live possible).
- **Config `live_transcription = "false"`** → pipeline actuel inchangé.
- **Pas d'accès IA / offline** → la transcription live fonctionne, les
  améliorations Claude sont désactivées silencieusement (chunks bruts).
- **Modèle Whisper introuvable** → erreur au start comme aujourd'hui.

## Cycle de vie d'une session live

1. **Start** : création immédiate de la note
   `{vault}/{recording_folder}/{YYYY-MM-DD HHhMM}.md` (titre partagé avec le
   futur WAV, `format_note_title()`), frontmatter `NoteMetadata::for_recording`
   (`type: meeting`, `date`, `status: active`, `recording_id`), corps
   `# Transcription`. Émission de `live-session-started` + `notes-updated`.
2. **Pendant** : chunks transcrits → append au corps (un **paragraphe par chunk**,
   séparé par une ligne vide) ; améliorations appliquées si le chunk n'a pas été
   édité ; l'utilisateur édite librement la note dans l'éditeur.
3. **Stop** : flush du dernier chunk, drainage borné des améliorations (20 s max),
   écriture SQLite, déplacement du WAV, `transcription-complete`, ingestion
   (spec/05) sur le **contenu final de la note** via `run_ingestion_for_note`,
   `live-session-ended`.

Machine à états inchangée côté UI (`Idle → Recording → Processing → Idle`,
spec/03) — le « Processing » live est court (drainage) puisque la transcription
a déjà eu lieu en continu.

## Note live & concurrence — écrivain unique

**La `LiveSession` (acteur tokio côté Rust) est la source de vérité et l'unique
écrivain du fichier `.md` pendant la session.** Elle détient :

- le **corps autoritaire** de la note (String) ;
- la liste ordonnée des chunks `{ seq, original_text, start_sec, end_sec }`
  (`original_text` = sortie Whisper exacte, jamais mutée).

Toute mutation passe par l'acteur, qui sérialise puis écrit le fichier — zéro
écriture concurrente. L'éditeur CodeMirror est un **miroir événementiel** :

- il applique `live-transcription-chunk` / `live-chunk-improved` directement
  dans son document (sans relire le fichier) ;
- son auto-save (2 s, spec/07) passe par **`save_live_note(path, metadata, body,
  last_seq)`** : si des chunks `seq > last_seq` sont arrivés entre le snapshot de
  l'éditeur et le save (course rare), l'acteur les **ré-appende** au body reçu,
  puis ce body devient le corps autoritaire. Aucun chunk n'est jamais perdu.
- à l'ouverture (ou réouverture) de la note live, l'éditeur initialise son
  document via **`get_live_session()`** (snapshot `{ body, last_seq, … }`) au
  lieu du fichier, puis filtre les événements par `seq > last_seq` — pas de
  doublon possible.

**Règle « les éditions utilisateur gagnent toujours »** : une amélioration
Claude n'est appliquée que si `original_text` est **encore présent tel quel**
dans le corps autoritaire (recherche de sous-chaîne à partir de l'offset du
chunk précédent — gère les textes répétés). Absent → l'utilisateur a édité →
l'amélioration est abandonnée sans bruit. Pas de markers dans le document, pas
d'état côté frontend.

**Protections** : `rename_note_file` / `delete_note_file` sur la note live sont
refusés pendant la session (erreur claire). Si l'utilisateur ferme la note ou
navigue ailleurs, le backend continue seul — le fichier reste à jour.

## Découpage des chunks

| Constante | Valeur | Rôle |
|---|---|---|
| `MIN_CHUNK_SECS` | 8 s | durée mini avant de chercher une coupe |
| `SILENCE_RMS` | 0,010 | seuil RMS (fenêtres de 100 ms) |
| `SILENCE_MIN_MS` | 700 ms | durée de silence déclenchant la coupe |
| `MAX_CHUNK_SECS` | 30 s | coupe forcée (garantit la progression) |

- Justification 8–30 s : whisper.cpp padde chaque `full()` sur une **fenêtre mel
  de 30 s** — un chunk de 4 s coûte quasi le prix d'un chunk de 30 s et perd le
  contexte (noms propres). Latence d'affichage bornée à ~35 s.
- Le chunker calcule le RMS sur les samples eux-mêmes (indépendant du volumètre
  UI). Chunk entièrement silencieux → **aucun appel Whisper**.
- **Cohérence inter-chunks** : `params.set_initial_prompt(fin ~200 caractères du
  texte original du chunk précédent)`.
- Le WAV continu reste écrit comme aujourd'hui (spec/03) — le tap **duplique**
  les samples, il ne détourne rien.

## Whisper persistant

Le thread Whisper de la session charge `WhisperContext` + `WhisperState` **une
fois au start** (chargement asynchrone : l'enregistrement démarre sans attendre,
le 1er chunk attend le contexte) et les garde jusqu'au stop. Le **worker mpsc
existant (`run_transcription_worker`, spec/04) n'est pas modifié** : il continue
de servir `system_only`/`mixed` et le fallback sans vault.

## Amélioration Claude par chunk

- **Modèle** : `claude-haiku-4-5` (déjà dans l'allowlist du proxy, spec/15).
  Non-streaming, `thinking: {type: "disabled"}`, `max_tokens: 1024` — conventions
  spec/05.
- **Sortie structurée** via tool-use forcé `submit_chunk_fix` :
  ```json
  { "texte_corrige": "le texte du chunk, corrigé a minima" }
  ```
- **System prompt** (stable sur toute la session, `cache_control: ephemeral` →
  cache hits ; inclut le contexte interne) — règles strictes :
  - corriger **uniquement** : ponctuation, majuscules, mots incohérents ou mal
    transcrits, noms propres et vocabulaire maison d'après le contexte interne ;
  - **interdits** : résumer, reformuler, ajouter, supprimer, traduire, changer
    la langue ;
  - le texte rendu doit rester quasi identique à l'entrée.
- **File séquentielle** : 1 appel en vol (préserve l'ordre, lisse le débit).
  Retry via la convention spec/05 (`call_claude_with_retry`).
- **Erreurs silencieuses** : échec → le chunk reste brut (log). **3 échecs
  consécutifs → circuit ouvert** : plus d'amélioration pour la session (la
  transcription live continue).
- **Coût** : ~2–4 chunks/min × Haiku (system caché) ≈ **< 0,10 $/h** de réunion.

## Contexte interne

- **Note `Contexte Alfred.md` à la racine du vault** (contenu rédigé par
  l'utilisateur — pas un artefact IA, donc pas dans `alfred-intelligence/`).
  Chemin vault-relatif configurable : clé `context_note_path` (défaut en code,
  pas de migration).
- **Création lazy** (`ensure_context_note`) avec template :
  ```markdown
  ## Mon entreprise
  ## Équipe (prénoms & rôles)
  ## Vocabulaire maison & noms propres
  ## Projets en cours
  ```
- **Lecture une fois au début de session** (corps sans frontmatter, tronqué à
  ~4 000 caractères), injectée :
  1. dans le system prompt d'**amélioration de chunk** (ci-dessus) ;
  2. dans l'**ingestion** (spec/05, Usage 1) comme second bloc system
     (`cache_control` sur le dernier bloc → tout le préfixe est caché).
- **UI** : ligne « Contexte interne » dans Settings (section Notes) → commande
  `open_context_note` (crée si absente) puis ouverture dans `/notes`.

## Fin de session

- `transcriptions.raw_text` = concaténation des textes Whisper **originaux**
  (la sémantique « brut » est préservée en base ; le fichier note porte la
  version éditée/améliorée). `segments_json` = segments par chunk **rebasés en
  temps absolu**. `language`, `whisper_model` comme aujourd'hui.
- WAV déplacé vers `alfred-raw/{titre}.wav`, jamais supprimé (spec/04).
- **Ingestion automatique au stop**, après attente bornée (20 s) des
  améliorations en vol — un chunk non amélioré part brut, sans gravité.
- `transcription-complete` et `ingestion-status-changed` sont émis à
  l'identique : l'état majordome et le toast d'erreur existants fonctionnent
  sans modification.

## Événements & commandes Tauri

| Événement | Payload |
|---|---|
| `live-session-started` | `{ recording_id, note_path, note_title }` |
| `live-transcription-chunk` | `{ recording_id, seq, text, start_sec, end_sec }` |
| `live-chunk-improved` | `{ recording_id, seq, original_text, improved_text }` |
| `live-session-ended` | `{ recording_id }` |

| Commande | Rôle |
|---|---|
| `save_live_note(path, metadata, body, last_seq) -> NoteFile` | save réconcilié de l'éditeur ; fallback `update_note_file` si `path` ≠ note live |
| `get_live_session() -> LiveSessionSnapshot \| null` | snapshot `{ recording_id, note_path, note_title, body, metadata, last_seq, improving }` |
| `open_context_note() -> NoteFile` | crée (si besoin) et retourne la note de contexte interne |

Types TS générés par ts-rs (`npm run generate-types`) : `LiveSessionStarted`,
`LiveChunkEvent`, `LiveChunkImprovedEvent`, `LiveSessionSnapshot`.

## Config

| Clé | Défaut | Rôle |
|---|---|---|
| `live_transcription` | `true` (défaut en code) | active/désactive le pipeline live (`mic_only`) |
| `context_note_path` | `Contexte Alfred.md` | chemin vault-relatif de la note de contexte |

## Hors v1 / plus tard

- Live pour `system_only` / `mixed` (nécessite un mixage temps réel, spec/03).
- Diarisation (locuteurs) des chunks.
- Vocabulaire du contexte interne injecté dans l'`initial_prompt` Whisper
  (correction *à la source* plutôt qu'après coup).
- Tuning `audio_ctx` proportionnel à la durée du chunk (perf Windows CPU).
- Streaming API pour l'amélioration (dépend du streaming proxy, spec/15).
- Vrai VAD (webrtc-vad / silero) à la place du seuil RMS.
