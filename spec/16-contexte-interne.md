# spec/16 — Contexte interne

> **Statut v1 :** ✅ construit. Note `Contexte Alfred.md` (contexte maison rédigé
> par l'utilisateur) injectée dans l'ingestion. **La transcription live a été
> abandonnée** (voir « Historique » en bas) ; ce module ne couvre plus que le
> contexte interne.

## Vue d'ensemble

Une note de vault décrit le **contexte maison** de l'utilisateur (entreprise,
équipe, vocabulaire, projets). Claude s'en sert pour mieux orthographier les noms
propres et termes métier. C'est aussi la **source du glossaire Whisper** (spec/17).

## La note `Contexte Alfred.md`

- **Emplacement** : racine du vault. Chemin vault-relatif configurable via la clé
  de config `context_note_path` (défaut `Contexte Alfred.md`, pas de migration).
  Rédigée par l'utilisateur — ce n'est **pas** un artefact IA, donc pas dans
  `alfred-intelligence/`.
- **Création lazy** (`ensure_context_note`) avec template :
  ```markdown
  ## Mon entreprise
  ## Équipe (prénoms & rôles)
  ## Vocabulaire maison & noms propres
  ## Projets en cours
  ```
- **UI** : ligne « Contexte interne » dans Settings (section Notes) → commande
  `open_context_note` (crée si absente) puis ouverture dans `/notes`.

### Écriture par la voix (`write_spoken_context`) — remplacement, pas empilement

Quand le contexte est créé/reconstruit à la voix (visite guidée spec/13,
`build_context_from_transcription`) :

- **Note encore au template** (jamais éditée par l'utilisateur — sections vides,
  seule la phrase d'intro et les titres par défaut sont présents) → **remplacer
  entièrement** le contenu par les sections structurées. **Pas** de conservation des
  blocs vides, **pas** de section « Appris à l'oral ».

  > **Bug corrigé (feedback tests) :** `context_has_content` considérait le template
  > (phrase d'intro + titres) comme « du contenu » et prenait le chemin *append*,
  > d'où des **sections vides dupliquées en tête** + une section « Appris à l'oral »
  > sous laquelle le vrai contenu était empilé. Le template (intro comprise) ne doit
  > **jamais** compter comme du contenu utilisateur.

- **Note déjà remplie par l'utilisateur** (vrai contenu saisi) → ne pas écraser :
  ajouter les nouveautés sous une section datée « Appris à l'oral (AAAA-MM-JJ) »
  (comportement conservé pour une re-création ultérieure).

## Usages

1. **Ingestion** (spec/05, Usage 1) : le corps de la note (sans frontmatter,
   tronqué à ~4 000 caractères) est injecté comme **second bloc system**
   (`cache_control: ephemeral` sur le dernier bloc → tout le préfixe est caché).
   Claude oriente ainsi l'orthographe des prénoms, équipes et termes maison dans
   le compte-rendu et les tâches.
2. **Glossaire Whisper** (spec/17) : Claude en dérive une liste plate de noms
   propres injectée en `initial_prompt` → correction **à la source**.

## Commandes & config

| Élément | Rôle |
|---|---|
| `open_context_note() -> NoteFile` | crée (si besoin) et retourne la note de contexte |
| config `context_note_path` | chemin vault-relatif (défaut `Contexte Alfred.md`) |

## Historique — transcription live (abandonnée)

Ce module portait aussi une **transcription live par chunks** (note créée au
`start`, chunks Whisper pendant l'enregistrement, édition en direct, amélioration
Haiku par chunk). **Abandonnée** (décision Ulysse + Tanguy) : complexité élevée
pour une valeur marginale ; la qualité passe par le décodage + le glossaire
(spec/17) sur le pipeline full-file (spec/04). Le code correspondant
(`transcription/live.rs`, session acteur, événements `live-*`, `save_live_note` /
`get_live_session`, miroir CodeMirror) a été retiré. Seul le contexte interne
ci-dessus subsiste.
