# spec/17 — Glossaire & qualité de transcription (extension spec/16)

> **Statut v1 :** 📝 spec à créer, **rien de codé**. S'appuie sur le **contexte
> interne** (`Contexte Alfred.md`, spec/16) : n'introduit **aucune nouvelle note de
> contexte**.

## Idée directrice

`Contexte Alfred.md` (spec/16) est déjà lue et injectée dans l'ingestion. Cette spec
en ajoute un **second usage** : en dériver un **glossaire plat** injecté dans
l'`initial_prompt` de Whisper → corrige les noms propres **à la source** (ex.
« Ulysse » au lieu de « Le vice »).

```
Contexte Alfred.md (spec/16, source éditable)
   ├──→ contexte ingestion            (spec/16, déjà fait)
   └──→ GLOSSAIRE Whisper (NOUVEAU)   liste plate ≤224 tokens, dérivée par Claude
                                      → initial_prompt de run_whisper (spec/04)
```

S'ajoutent deux gains **indépendants du contexte** : la **qualité de décodage**
(beam + seuils) et l'**ingestion augmentée** (propositions groupées).

## Priorité (ordre d'implémentation)

1. **Qualité de décodage** (§2) — beam + seuils : gros gain, 1 fonction, aucun
   couplage. À faire d'abord.
2. **Glossaire dérivé** (§1) — corrige les noms propres à la source.
3. **Ingestion augmentée** (§3) — plus structurant.

---

## §1 — Glossaire dérivé du contexte

- **Dérivation** : **Claude** génère une **liste plate** de noms propres / termes à
  partir de `Contexte Alfred.md` (il sait repérer les noms propres utiles et
  respecter le budget de tokens). Stockée en `config.transcription_glossary`.
  Régénérée : à l'onboarding, quand la note de contexte change (débouncé), via un
  bouton manuel.
- **Forme** : **liste de mots / noms uniquement**, PAS de définitions (Whisper est
  acoustique, pas sémantique). Enrobée dans une courte phrase pour le style. Ex. :
  `Transcription en français. Termes et noms propres : Ulysse Carpentier, Alfred,
  Tauri, Coolify, AlfredIA, Do Now.`
- **Budget** : ~**224 tokens** (moitié de `n_text_ctx` = 448 ; tronqué au-delà).
  Noms propres = 3–4 tokens chacun → ~**60–90 termes**. Les plus fréquents / mal
  transcrits **en premier** (la fin saute si troncature).
- **Injection** : `initial_prompt` = glossaire dans `run_whisper` (spec/04), sur une
  **passe unique** de tout le WAV (pas de chunking en v1 — voir Hors v1).
- ⚠️ **Multilingue — BUG confirmé au test, ✅ corrigé.** Une réunion **en
  anglais** était sortie **transcrite en français**. Cause : la phrase d'enrobage du
  glossaire était **codée « Transcription en français… »** (l'exemple donné à
  Claude dans `GLOSSARY_SYSTEM`, pas un texte figé côté Rust) → `initial_prompt`
  FR **biaisait Whisper** vers le français (et faussait l'auto-détection de
  langue). Correctifs appliqués :
  - **La phrase d'enrobage suit la langue cible** : `GLOSSARY_SYSTEM` donne
    désormais les deux exemples de forme (FR **et** EN) et prévient explicitement
    de ne pas copier le FR par défaut ; `language_instruction(db)` (spec/05) reste
    appendue pour le repli. Les noms propres eux-mêmes restent inchangés.
  - **`language` forcée** quand elle est connue (`language_hint` ≠ `auto`) plutôt que
    `auto`, pour éviter une auto-détection faussée par le prompt
    (`resolve_whisper_language`, `transcription/mod.rs`).
  - **Défaut sûr** : si `app_language = en` et `language_hint` non défini (`auto`),
    vise EN (au lieu du FR implicite d'avant) — même fonction.
  Le compte-rendu FR qui suivait était un **second problème**, corrigé en parallèle
  (prompt d'ingestion, spec/05) — les deux se cumulaient.

  > 🚧 **ENCORE OBSERVÉ au test (2e passe) — pas totalement corrigé.** App en EN,
  > `language_hint`/log Whisper = **`_LANG_en` forcé**, et **pourtant** le contenu
  > sort en **français**. Le log montre **~179 tokens d'`initial_prompt` AVANT**
  > `[_LANG_en]` (`prompt[179] = [_LANG_en]`). Enseignement : **forcer le token de
  > langue ne suffit pas** — un `initial_prompt` (glossaire) dont le **texte réel
  > stocké** (`config.transcription_glossary`) est encore **français** (« Transcription
  > en français. Termes… ») fournit ~179 tokens de **prior français** qui **priment
  > sur le token `en`**. Rendre l'**exemple** de `GLOSSARY_SYSTEM` bilingue ne change
  > **pas** la valeur déjà stockée ni ne garantit une régénération EN. Correctifs à
  > faire :
  > - **La valeur stockée `transcription_glossary` doit être régénérée dans la langue
  >   cible** (pas seulement l'exemple du prompt) ; à défaut, **omettre la phrase
  >   d'enrobage** et n'injecter qu'une **liste nue de noms propres** (neutre en
  >   langue) — le plus sûr, puisque le rôle du glossaire est acoustique (noms), pas
  >   de fixer la langue.
  > - **Cas du 1er enregistrement de contexte** : il n'y a en principe pas encore de
  >   glossaire — vérifier d'où viennent ces 179 tokens (glossaire résiduel d'un tour
  >   précédent ? valeur seed ?) et **ne rien injecter** si le glossaire est censé
  >   être vide.
  > - **Vérification décisive Whisper vs Claude** : ouvrir la **note brute**
  >   (`alfred-raw/`). Si **elle** est en français → c'est bien ce biais
  >   `initial_prompt` (ci-dessus). Si elle est en **anglais** mais que la **note de
  >   contexte** est en français → le fautif est **Claude** (`build_context`,
  >   spec/05/13).

## §2 — Qualité de décodage (beam + seuils)

Dans `run_whisper` (spec/04). Aujourd'hui : `Greedy { best_of: 1 }`, aucun seuil —
le réglage le plus faible.

- **Beam search** : `SamplingStrategy::BeamSearch { beam_size: 5, patience: -1.0 }` —
  meilleur ratio qualité/effort ; ~1.5–2× plus lent (acceptable, la transcription
  est asynchrone au `stop`).
- **Seuils anti-hallucination** (Whisper `small` invente sur les silences) :
  `no_speech_thold ≈ 0.6`, `entropy_thold ≈ 2.4`, `logprob_thold ≈ -1.0`,
  `temperature 0.0` + `temperature_inc 0.2`, `suppress_blank`, tokens non-verbaux.
- **Threads** : défaut `min(cœurs, 8)` ; relevable via `config.whisper_threads`
  pour absorber le coût du beam search (n'améliore pas la qualité, réduit la latence).
- **Langue** : forçable par enregistrement quand connue (évite une auto-détection
  ratée qui plombe tout le fichier) — utile pour les enregistrements EN minoritaires.

La qualité se **propage à l'aval** : un nom mal transcrit fausse le `resume`, les
points clés et surtout le `responsable` d'une tâche (spec/05).

## §3 — Ingestion augmentée (propositions groupées)

Évolution de l'ingestion (spec/05, Usage 1) en **deux temps** : Claude ne se contente
plus de résumer, il **signale ce qui mérite validation** avant de finaliser
(corrections de noms propres, tâches sans responsable, phrases importantes floues).

1. **Analyse** — 1 appel Claude (transcription + `Contexte Alfred.md`) → **liste
   triée et seuillée** (uniquement au-dessus d'un seuil de confiance/importance) :
   - `transcription_fix` : passage douteux + correction + **citation** + **timestamps**
     + confiance. Seulement si Claude a un **référent** dans le contexte.
   - `unassigned_task` : tâche sans responsable → « qui ? ».
   - `unclear_sentence` : phrase **importante** floue → compréhension proposée.
   - `context_addition` : fait appris (ex. « Marie = cheffe de projet »).
2. **Résolution — un écran, pas un chat** : accepter / rejeter / éditer. Chaque
   `transcription_fix` a un bouton **« 🔊 réécouter »** (WAV `alfred-raw/` +
   timestamps `segments_json`) → tranche à l'oreille.
3. **Finalisation** — `submit_ingestion` sur le texte corrigé + réponses.

**Jamais d'auto-application** d'une correction.

### La finalisation attend la vérification (✅ fait)

Constat test : après la transcription, **compte-rendu et tâches semblent créés tout
de suite** — comme si la finalisation ne passait pas par la vérification. C'est le
raccourci « si Claude n'a rien à signaler, l'ingestion enchaîne **automatiquement** »
qui fait sauter l'étape de contrôle.

**Nouveau comportement voulu : le compte-rendu et les tâches ne sont générés
qu'APRÈS la vérification/correction**, jamais en même temps que la transcription.

- L'étape **Résolution** (`/resolve`) est **toujours** présentée après la
  transcription — **même quand il n'y a rien à corriger** : l'utilisateur relit le
  texte et **Valide** ; c'est **cette validation** qui déclenche `finalize_ingestion`
  (donc le compte-rendu + les tâches).
- Sans clarification, l'écran est simplement **plus court** (texte + « Valider »),
  mais **l'étape reste** — plus d'auto-enchaînement silencieux.
- Vaut pour un enregistrement de réunion **et** pour le contexte (spec/13, même
  écran unifié — la « finalisation » du contexte étant
  `build_context_from_transcription`).

> **Compromis assumé** : cela ajoute un « Valider » à chaque enregistrement (léger
> quand il n'y a rien à corriger). C'est le prix du contrôle demandé — l'utilisateur
> veut décider avant que le compte-rendu/les tâches partent.

## §4 — Enrichissement du contexte & onboarding

Sur `Contexte Alfred.md` (spec/16) — **pas de nouvelle note** :
- **Enrichissement auto** post-ingestion : les `context_addition` sont écrits
  **automatiquement** par Rust dans une section **`## Appris automatiquement`**
  (relisible / corrigeable), sans validation bloquante. Les **corrections de
  transcription**, elles, restent **validées** (§3), jamais auto-appliquées.
- Toute modif → **régénération du glossaire** (§1, débouncée).
- **Onboarding** (extension spec/13) : `Contexte Alfred.md` est aujourd'hui un
  template *lazy* rempli à la main. La **visite guidée post-onboarding** le peuple
  désormais **à la voix** : le premier enregistrement guidé EST la création du
  contexte — l'utilisateur se présente en suivant un **téléprompteur** (qui il est,
  équipe, clients, projets, jargon), Claude structure la transcription dans la note
  puis dérive le **premier glossaire**. (Remplace l'idée d'interview textuel :
  parler est plus rapide et couvre plus de jargon.) Skippable (contexte vide =
  comportement spec/16 actuel). Détail du flux + script : **spec/13**.

⚠️ **Empoisonnement** : une correction validée à tort promue au glossaire *global*
biaise **tous** les futurs enregistrements → distinguer « corriger pour cet
enregistrement » (léger) de « promouvoir au glossaire » (délibéré).

## §5 — Transcription parallèle par tranches (longs enregistrements)

En **CPU pur**, une passe unique `small` + beam sur 1 H d'audio tourne à ~0,6–1×
temps réel → **30 min et plus**, incompressible en séquentiel. Pour les longs
enregistrements, on **découpe et on transcrit en parallèle** (dans `run_whisper`) :

- **Seuil** : seuls les enregistrements > **15 min** sont découpés ; en dessous,
  **passe unique** (meilleure qualité, aucun risque de couture).
- **Découpe aux silences** : tranches cibles ~**8 min**, la frontière étant décalée
  au **point le plus silencieux** dans une fenêtre ±30 s (RMS par trames de 25 ms)
  pour ne pas couper un mot.
- **Parallélisme** : le **modèle est chargé une seule fois** (`WhisperContext`
  partagé, `Send + Sync`), chaque worker crée son propre `state`. Pool de
  `min(tranches, ~cœurs/2, 6)` workers × `budget / workers` threads
  (budget = `whisper_threads` sinon tous les cœurs logiques).
- **Glossaire par tranche** : l'`initial_prompt` est ré-injecté à chaque tranche →
  le *priming* des noms propres **ne s'estompe plus** sur les longs fichiers
  (répond à la crainte historique ci-dessous).
- **Recollage** : les timestamps de chaque tranche sont **ré-offset** en temps
  absolu, textes concaténés dans l'ordre. Une tranche en échec est **loggée et
  ignorée** (on ne coule pas tout le fichier pour une tranche).
- **Gain** : ~**1,5–2,5×** (borné par la bande passante mémoire), **cumulable** avec
  le choix du modèle (`base`) et du beam. GPU reste le vrai multiplicateur mais
  **hors v1** (spec/04).

## Commandes Tauri (à créer)

- `generate_glossary_from_context() -> String` — Claude dérive la liste plate depuis
  `Contexte Alfred.md`, stocke `config.transcription_glossary`.
- `build_context_from_transcription(recording_id) -> ...` — route « mode contexte »
  de la visite guidée : Claude structure la transcription dans `Contexte Alfred.md`
  puis enchaîne `generate_glossary_from_context` (détail spec/13).
- Ingestion §3 en deux temps : `analyze_transcription(...) -> Clarifications` puis
  `finalize_ingestion(...)`.
- Réutilise `open_context_note` (spec/16) — pas de nouvelle note.

## Hors v1 / plus tard

- **Onglet « Contexte » dédié** (éditeur convivial par-dessus la note).
- **Session d'ingestion conversationnelle** multi-tours (au-delà des propositions groupées).
- Contexte **structuré multi-notes** (une note par personne/projet, graphe spec/07c).
- ~~**Chunking**~~ → **fait en v1** (§5) : les longs enregistrements étaient trop
  lents en CPU pur (1 H ≈ 30 min en passe unique). Découpe aux silences +
  transcription parallèle + ré-injection du glossaire par tranche.
- **Backend GPU** (Vulkan/CUDA Windows, Metal macOS) — le vrai multiplicateur
  (5–20×) pour les longs fichiers. Metal est déjà câblé côté macOS ; Windows reste
  CPU. À reconsidérer si le chunking CPU ne suffit pas.
