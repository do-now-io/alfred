# spec/26 — Application mobile (capture uniquement)

> **Statut :** 📝 spec écrite, rien de codé. Post-v1, priorité la plus faible
> du ROADMAP Phase G. **Périmètre volontairement minimal** : le mobile n'est
> **qu'un bouton d'enregistrement qui envoie l'audio** — aucun accès au
> vault, aucune consultation, aucune transcription sur le téléphone. Tout le
> reste (transcription, ingestion, notes, tâches) continue de se faire
> **exclusivement dans Alfred desktop**, qui récupère l'enregistrement au
> prochain lancement.

## Vue d'ensemble

```
Téléphone (Tauri mobile)          Backend AlfredIA (existant)         Desktop
┌─────────────────┐               ┌──────────────────────┐            ┌──────────────┐
│ [ Enregistrer ]  │──upload WAV──▶│ stockage temporaire   │◀──pull────│ au lancement │
│ (rien d'autre)   │               │ (par device pairé)    │  (download │ → pipeline   │
└─────────────────┘               └──────────────────────┘   + delete)│   normal     │
```

- **Le téléphone** : une seule fonction, capturer + envoyer. Pas de vault,
  pas de notes, pas de liste, pas de compte visible — juste enregistrer.
- **Le backend** stocke l'audio **temporairement**, en attendant que le
  desktop associé vienne le récupérer.
- **Le desktop**, au démarrage (même pattern que la vérification des mails
  spec/24, des mises à jour spec/27, des partages spec/25) : va chercher les
  enregistrements en attente, les traite **exactement comme un
  enregistrement local** (même pipeline transcription/ingestion, spec/03-05)
  puis les supprime du serveur.

**Pas de transcription sur le téléphone** — décision actée : on ne télécharge
pas de modèle Whisper sur mobile. La transcription reste **100% côté
desktop**, comme aujourd'hui, une fois l'audio rapatrié.

## 1. Appairage — lier un téléphone à une install desktop

Il n'existe **aucun système de compte** dans Alfred (spec/00 — ni pour la clé
perso, ni vraiment pour AlfredIA côté utilisateur final). Le mobile doit
pourtant savoir **où envoyer** l'audio, et le desktop **quoi récupérer**.

- **Réglages (desktop)** → "Appairer un téléphone" → `POST
  /mobile/pair` (backend) → génère un **code d'appairage** court (ex. 6
  chiffres, expire après quelques minutes) + un `mobile_token` (aléatoire,
  ≥128 bits) lié à l'`install_id` du desktop — **indépendant du mode d'accès
  IA** (marche pareil en clé perso et en AlfredIA, comme `/feedback`/
  `/metrics`, spec/15).
- **Mobile** : écran unique de saisie du code (ou QR si plus simple à
  scanner) → échange contre le `mobile_token`, stocké **localement sur le
  téléphone** (seule donnée persistée côté mobile).
- **Un téléphone = un seul desktop cible** (décision par défaut proposée —
  pas de routage multi-desktop ; cohérent avec le modèle "un vault par
  install" déjà en place partout ailleurs dans l'app). Ré-appairer vers un
  autre desktop remplace la cible précédente.

## 2. Capture & envoi (mobile)

- **Un seul écran** : bouton Enregistrer/Arrêter (+ éventuellement pause,
  comme le desktop spec/03). Capture micro via l'API audio native (Tauri
  mobile).
- **Codec compressé, pas du WAV brut** — décision par défaut proposée : le
  WAV du desktop n'est pas adapté à un envoi mobile (taille, réseau
  cellulaire). Encoder en **Opus** ou **AAC/m4a** (formats compacts,
  qualité voix suffisante) avant l'upload. Le backend/desktop décode vers
  WAV avant d'entrer dans le pipeline `run_whisper` existant (spec/04) —
  **aucun changement** du pipeline de transcription lui-même, juste une
  étape de décodage en amont.
- **Upload** : `POST /mobile/recordings` (`mobile_token` en Bearer,
  multipart audio + métadonnées `recorded_at`, `duration_seconds`) —
  peut se faire en tâche de fond après l'arrêt (retry si réseau
  indisponible au moment de l'arrêt).
- **Rien ne persiste sur le téléphone** après upload réussi — pas de
  liste des enregistrements passés, pas d'historique, conforme au
  périmètre "juste un bouton".
- **Contrainte OS connue, non bloquante pour le design** : l'enregistrement
  en arrière-plan (téléphone verrouillé) demande des permissions
  spécifiques par OS (iOS : mode background audio ; Android : foreground
  service) — à gérer à l'implémentation, pas un choix d'architecture.

## 3. Stockage temporaire (backend)

- **Nouvelle table** `mobile_recordings (id, install_id, audio_data BYTEA
  ou chemin disque, recorded_at, duration_seconds, uploaded_at)` — rupture
  avec "tout en Postgres" pur (spec/15/18) : un enregistrement audio peut
  peser largement plus qu'un Markdown de partage. **Décision par défaut
  proposée** : stocker sur un **volume persistant Coolify** (chemin
  disque référencé en base), pas en `BYTEA` — plus adapté à des fichiers
  de plusieurs Mo/dizaines de Mo. Alternative si les volumes s'avèrent
  pénibles à opérer : MinIO (S3-compatible, auto-hébergeable sur Coolify).
- **Cap de taille** par upload (comme `SHARE_MAX_BYTES`, spec/18) — à
  définir selon la durée max d'enregistrement mobile visée.
- **Rétention** — **décision par défaut proposée** : purge automatique des
  enregistrements **non récupérés depuis 30 jours** (le desktop cible n'a
  pas tourné depuis un mois — cas limite, mais éviter une croissance non
  bornée du stockage).

## 4. Récupération (desktop, au démarrage)

- `check_mobile_recordings()` — appelée au lancement de l'app (même
  pattern que spec/24/25/27), si un appairage existe.
- Pour chaque enregistrement en attente : télécharge l'audio, **décode**
  vers WAV si nécessaire (§2), puis traite **exactement comme
  `stop_recording`** — écrit dans `alfred-raw/` (nouveau champ `source:
  "mobile"` sur la ligne `recordings`, cohérent avec le `source` déjà
  utilisé pour `mixed`/`mic_only`/`import`, spec/03) et enfile le job de
  transcription habituel (`transcription::enqueue_job`).
- **Une fois écrit localement avec succès** → `DELETE
  /mobile/recordings/{id}` côté serveur (pas de conservation double).
- Aucune UI de progression spécifique nécessaire au-delà de ce qui existe
  déjà pour une transcription en cours (spec/03/04) — un enregistrement
  mobile rapatrié suit le même chemin visible (indicateur d'état, etc.).

## 5. Hors scope explicite (le périmètre reste volontairement étroit)

- **Consultation des notes depuis le mobile** — pas dans cette v1 (le
  ROADMAP le mentionnait, mais ce n'est pas la priorité pour cette
  itération). Piste pour plus tard : réutiliser l'infra collaborative de
  spec/25 (Yjs/backend) plutôt qu'une synchro de vault classique — le
  mobile parlerait au backend en direct, sans jamais avoir de copie locale
  du vault. À spécifier séparément si/quand ça devient prioritaire.
- **Transcription on-device** — explicitement écarté (§0), pas de modèle
  Whisper embarqué sur le téléphone.
- **Édition de notes, chat, tâches depuis le mobile** — hors scope.
- **Multi-desktop** — un appairage cible un seul desktop (§1).

## Endpoints backend (repo privé `alfred-backend`)

| Endpoint | Rôle |
|---|---|
| `POST /mobile/pair` | génère code d'appairage + `mobile_token` lié à `install_id` |
| `POST /mobile/recordings` | upload audio (`mobile_token`, multipart) |
| `GET /mobile/recordings/pending` | liste des enregistrements en attente pour cet `install_id` |
| `GET /mobile/recordings/{id}` | téléchargement du fichier audio |
| `DELETE /mobile/recordings/{id}` | suppression après récupération réussie |

## Commandes Tauri (desktop)

| Commande | Rôle |
|---|---|
| `pair_mobile_device() -> {pairing_code}` | Réglages — génère le code |
| `check_mobile_recordings()` | au démarrage — télécharge + traite + supprime côté serveur |

## App mobile (Tauri 2, iOS + Android)

- **Un seul écran** — pas de nav, pas de vault, pas de liste. Écran
  d'appairage (1ère ouverture) → écran d'enregistrement (ensuite).
- Même codebase Rust/Tauri que le desktop pour la partie capture audio,
  adaptée aux API mobiles natives (permissions micro iOS/Android).
