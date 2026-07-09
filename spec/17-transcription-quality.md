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
  acoustique, pas sémantique). Enrobée dans une courte phrase FR pour le style. Ex. :
  `Transcription en français. Termes et noms propres : Ulysse Carpentier, Alfred,
  Tauri, Coolify, AlfredIA, Do Now.`
- **Budget** : ~**224 tokens** (moitié de `n_text_ctx` = 448 ; tronqué au-delà).
  Noms propres = 3–4 tokens chacun → ~**60–90 termes**. Les plus fréquents / mal
  transcrits **en premier** (la fin saute si troncature).
- **Injection** : `initial_prompt` = glossaire dans `run_whisper` (spec/04), sur une
  **passe unique** de tout le WAV (pas de chunking en v1 — voir Hors v1).
- ⚠️ **Multilingue** : un glossaire FR peut pousser Whisper à croire que l'audio est
  français. Pour un enregistrement EN, forcer `language: en` (ou adapter le prompt).

## §2 — Qualité de décodage (beam + seuils)

Dans `run_whisper` (spec/04). Aujourd'hui : `Greedy { best_of: 1 }`, aucun seuil —
le réglage le plus faible.

- **Beam search** : `SamplingStrategy::BeamSearch { beam_size: 5, patience: -1.0 }` —
  meilleur ratio qualité/effort ; ~1.5–2× plus lent (acceptable, la transcription
  est asynchrone au `stop`).
- **Seuils anti-hallucination** (Whisper `small` invente sur les silences) :
  `no_speech_thold ≈ 0.6`, `entropy_thold ≈ 2.4`, `logprob_thold ≈ -1.0`,
  `temperature 0.0` + `temperature_inc 0.2`, `suppress_blank`, tokens non-verbaux.
- **Threads** : `min(cœurs, 4)` aujourd'hui ; relevable (ex. 8) pour absorber le
  coût du beam search (n'améliore pas la qualité, réduit la latence).
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

**Jamais d'auto-application** d'une correction. Si Claude n'a rien à signaler,
l'ingestion enchaîne **automatiquement** (aucune friction).

## §4 — Enrichissement du contexte & onboarding

Sur `Contexte Alfred.md` (spec/16) — **pas de nouvelle note** :
- **Enrichissement auto** post-ingestion : les `context_addition` sont écrits
  **automatiquement** par Rust dans une section **`## Appris automatiquement`**
  (relisible / corrigeable), sans validation bloquante. Les **corrections de
  transcription**, elles, restent **validées** (§3), jamais auto-appliquées.
- Toute modif → **régénération du glossaire** (§1, débouncée).
- **Onboarding** (extension spec/13) : `Contexte Alfred.md` est aujourd'hui un
  template *lazy* rempli à la main. Ajouter une étape **interview conversationnel**
  (Claude pose des questions ouvertes : entreprise, équipe, projets, jargon) qui
  **peuple** la note + génère le **premier glossaire**. Skippable (contexte vide =
  comportement spec/16 actuel).

⚠️ **Empoisonnement** : une correction validée à tort promue au glossaire *global*
biaise **tous** les futurs enregistrements → distinguer « corriger pour cet
enregistrement » (léger) de « promouvoir au glossaire » (délibéré).

## Commandes Tauri (à créer)

- `generate_glossary_from_context() -> String` — Claude dérive la liste plate depuis
  `Contexte Alfred.md`, stocke `config.transcription_glossary`.
- `run_context_interview(history) -> ...` — tour d'interview (onboarding).
- Ingestion §3 en deux temps : `analyze_transcription(...) -> Clarifications` puis
  `finalize_ingestion(...)`.
- Réutilise `open_context_note` (spec/16) — pas de nouvelle note.

## Hors v1 / plus tard

- **Onglet « Contexte » dédié** (éditeur convivial par-dessus la note).
- **Session d'ingestion conversationnelle** multi-tours (au-delà des propositions groupées).
- Contexte **structuré multi-notes** (une note par personne/projet, graphe spec/07c).
- **Chunking (~6 min)** du WAV avec ré-injection du glossaire par chunk. Écarté en v1 :
  whisper.cpp fenêtre déjà en interne à 30 s, une **passe unique** suffit. À
  reconsidérer si des enregistrements *longs* posent problème (RAM, ou noms propres
  apparaissant tard, quand l'`initial_prompt` s'est estompé).
