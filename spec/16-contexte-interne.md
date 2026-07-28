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

### Titres localisés selon `app_language` — ✅ fait (feedback tests EN, spec/21)

Constat test : en anglais, le corps du contexte est bien en anglais **mais les titres
restaient en français** (`## Mon entreprise`…). Les titres du template **et** ceux écrits
par `build_context_from_transcription` (spec/13, tool `submit_context`) étaient **codés
en français**. Corrigé — **localisés selon `app_language`** (`notes/context.rs`,
`ContextTitles`/`titles(lang)`) :

| Clé interne (stable) | FR | EN |
|---|---|---|
| `company` | Mon entreprise | My company |
| `team` | Équipe (prénoms & rôles) | Team (names & roles) |
| `vocab` | Vocabulaire maison & noms propres | House vocabulary & proper nouns |
| `projects` | Projets en cours | Current projects |

- La note (`Contexte Alfred.md`) garde un **nom de fichier stable** (pas de renommage
  par langue) ; seuls les **titres de sections** sont localisés.
- **Piège (spec/21) — traité.** Ces titres sont **relus/écrits** par l'IA et par
  `write_spoken_context` (append sous « Appris à l'oral »/« Learned by voice »).
  `context_has_content` compare contre l'union des deux gabarits (FR **et** EN) ;
  `has_learned_heading` reconnaît `## Appris automatiquement` **ou**
  `## Automatically learned` — une section existante est retrouvée quelle que
  soit la langue dans laquelle elle a été écrite, jamais par le libellé exact
  seul. Un changement de langue en cours de route laisse la note dans un mélange
  FR/EN assumé (rien n'est réécrit silencieusement).
- Titre `# Contexte Alfred` / `# Alfred context` : localisé aussi.

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

> 🚧 **Bug — empilement de contextes en double (📝 à refaire, feedback tests).**
> Constat : après l'onboarding, `Contexte Alfred.md` contient **deux structures
> complètes** (un 1ᵉʳ bloc, puis un `## Appris à l'oral` qui **re-duplique**
> entreprise/équipe/vocabulaire/projets — avec des infos différentes issues d'une
> **2ᵉ prise**). Cause : **re-lancer** la construction du contexte (Recommencer,
> refaire la visite, 2ᵉ enregistrement) passe par le chemin *append* dès que la note
> a du contenu → une **structure entière** est ré-empilée.
>
> **Correctif : le build vocal du contexte REMPLACE, il n'empile jamais une structure
> complète.** `build_context_from_transcription` (onboarding / « re-créer mon contexte
> à la voix ») **réécrit les 4 sections canoniques** (entreprise / équipe /
> vocabulaire / projets) avec la sortie fraîche — **idempotent**, une reprise écrase
> proprement la précédente. Le chemin « append sous une section datée » est **retiré**
> pour ce build. La seule chose qui **s'ajoute** (et se **dédup**) est
> `## Appris automatiquement` (faits durables post-ingestion, spec/17 §4) — un flux
> **distinct**, jamais une re-structuration complète. Trade-off : si l'utilisateur a
> **édité à la main** les 4 sections, un re-build les écrase — acceptable pour le
> geste explicite « re-créer mon contexte » ; à confirmer si on veut préserver les
> éditions manuelles.

### Contenu du contexte : des faits, pas l'avis de Claude — 📝 à faire (feedback tests)

Constat : sur une transcription **pauvre/ratée**, `build_context_from_transcription`
écrit l'**analyse de Claude** dans la note (ex. dans « Mon entreprise » : *« L'utilisateur
n'a pas donné d'informations claires… la transcription est trop courte et peu
exploitable ("Je parle du fait machin, t'as la paix.") »*). Et sur une bonne prise, il
écrit **plusieurs paraphrases** du même fait (3 versions de « Mon entreprise », 3
listes de vocabulaire).

Correctifs sur `CONTEXT_BUILD_SYSTEM` / `submit_context` :
- **Jamais de méta-commentaire** : ne pas commenter la qualité de la transcription ni
  la prestation de l'utilisateur ; **aucune** phrase du type « je pense / l'utilisateur
  n'a pas dit… ». Que des **faits structurés**.
- **Section vide si rien de fiable** (y compris `entreprise`, qui n'a pas de garde
  « Vide si rien » aujourd'hui) — laisser vide plutôt que narrer l'absence.
- **Concision + dédup** : **une** formulation consolidée par section, pas de
  variations répétées ; le vocabulaire est **une** liste dédupliquée.

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
