# spec/17 — Glossaire & qualité de transcription (extension spec/16)

> **Statut :** ✅ construit (v1). S'appuie sur le **contexte interne**
> (`Contexte Alfred.md`, spec/16). Le contexte par projet (post-v1) est traité
> dans spec/16b.

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
  >
  > ✅ **TRANCHÉ (capture d'écran `/resolve`, réunion EN)** : la citation d'origine
  > est **en anglais** (« UAE T1 and UAE T2 were not accessible… ») → **Whisper
  > transcrit bien en anglais**. Ce sont les **sorties de Claude** qui sont
  > françaises (reformulation proposée, faits « à retenir »). Donc **le bug de langue
  > est côté Claude**, pas Whisper — les correctifs glossaire ci-dessus n'étaient
  > donc pas la cause de CE cas (ils restent valables pour un vrai biais Whisper,
  > si observé séparément). Voir §3 + spec/05.
  >
  > ✅ **Corrigé (spec/05).** `call_analyze`/`call_ingestion`/`build_context_inner`
  > utilisent désormais `recording_language(db, recording_id)` — la langue
  > **réellement détectée par Whisper** pour cet enregistrement précis
  > (`transcriptions.language`), pas une inférence — avec une consigne
  > **impérative** (« Write ALL fields / your entire answer in {lang} ») et des
  > **schémas de tool alignés** (`submit_ingestion`/`submit_clarifications`/
  > `submit_context` en anglais quand la cible est EN). `call_analyze` n'avait
  > jusqu'ici **aucune** consigne de langue — c'était la fuite la plus nette.

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
     **`proposed` est UNIQUEMENT le texte de remplacement** (même registre/
     longueur que la citation), **jamais** un avis ni une reformulation façon
     « je pense que l'interlocuteur parle de… » (✅ corrigé, feedback tests —
     ce texte remplace directement la citation dans la transcription, un
     commentaire de Claude n'y a pas sa place). Exactement `?` si Claude n'a
     aucune proposition fiable — l'écran `/resolve` part alors d'un champ
     **vide** avec un indice, plutôt que de pré-remplir le `?` littéral.
     **`comment` (optionnel, feedback tests)** : le raisonnement de Claude en
     une phrase (ex. « Contexte technique + prononciation proche : probablement
     "Kube" plutôt que "cube" ») — affiché à part, en petite info-bulle
     au-dessus du champ éditable (aide à la décision), **jamais** inséré dans
     `proposed` ni dans la transcription.
   - `context_addition` : fait appris **durable** sur l'univers de l'utilisateur.
     **✅ Critère resserré (feedback tests) :** Claude proposait aussi des faits
     **ponctuels/propres à la réunion**, qui n'ont **rien à faire dans le
     contexte général** → seul le **durable, réutilisable dans les futurs
     enregistrements** doit être proposé. Les faits ponctuels **ne sont pas proposés**
     du tout ici (décidé) — ils vivent dans le **compte-rendu** (et deviennent des
     **tâches** le cas échéant). Correctif purement prompt (`ANALYZE_SYSTEM` +
     description du champ `context_additions` dans `analyze_tool`, FR/EN,
     `src-tauri/src/ai/mod.rs`) : distinction durable/ponctuel + les exemples et
     le test mental ci-dessous portés mot pour mot dans les deux.
     - ✅ **Durable → contexte** : qui sont les personnes / entreprises et leur
       **rôle/relation** (« Toto est un **nouveau prospect** de DoNow »), ce que fait
       l'entreprise (« DoNow fait de l'**infogérance** »), **vocabulaire/jargon**,
       **projets en cours** et leur nature.
     - ❌ **Ponctuel → PAS le contexte** (reste dans le compte-rendu / tâches) :
       planning et rendez-vous (« la **prochaine réunion** avec Toto se fera avec
       Hugo »), décisions/actions **de cette réunion**, chiffres/états **du jour**,
       tout ce qui est vrai « aujourd'hui » mais pas **durablement**.
     - **Test mental** : *« Est-ce encore utile dans 3 mois pour bien traiter un
       futur enregistrement ? »* Oui → durable ; Non → ponctuel (compte-rendu).
2. **Résolution — un écran, pas un chat** : accepter / rejeter / éditer. Chaque
   `transcription_fix` a un bouton **« 🔊 réécouter »** (WAV `alfred-raw/` +
   timestamps `segments_json`) → tranche à l'oreille.
   - **✅ Corrigé (feedback tests) — lecture/pause/reprise.** Le clic lançait le
     WAV en entier sans aucun moyen de l'arrêter. `useSegmentPlayer`
     (`Resolve.tsx`) suit maintenant l'état de lecture réel de l'`<audio>` : un
     bouton actif (celui dont la fenêtre joue) devient **Pause**, accompagné
     d'un second bouton **reprendre depuis le début** (flèche circulaire) —
     les autres boutons de réécoute restent inchangés (un seul `<audio>`
     partagé, mais une seule fenêtre « active » à la fois).
   - **✅ Corrigé (feedback tests) — réécoute cassée une fois la note
     archivée.** `read_recording_wav` résolvait le nom du fichier `.wav` à
     partir du TITRE de la note actuellement ouverte — qui n'est le bon titre
     que lorsque c'est la transcription brute elle-même qui est ouverte.
     Une fois le compte-rendu écrit, la brute est archivée (jamais renommée)
     mais l'utilisateur rouvre naturellement le **compte-rendu**, dont le
     titre diffère → chemin `.wav` inexistant, réécoute cassée. Corrigé en
     résolvant désormais par **`recording_id`** (`find_note_by_recording_id`,
     déjà utilisé pour l'archivage) plutôt que par titre — fonctionne quelle
     que soit la note ouverte et quel que soit le statut `archived`.
3. **Finalisation** — `submit_ingestion` sur le texte corrigé + réponses.
   - **✅ Corrigé (feedback tests) — doublon de compte-rendu.** Une
     ré-vérification (« Vérifier / corriger », ou la validation d'une
     vérification persistée) sur un enregistrement qui a déjà un compte-rendu
     en créait un **second** (`create_intelligence_note` suffixe le nom sur
     collision : « Réunion 2.md »). `run_ingestion_core` cherche désormais un
     compte-rendu existant par `recording_id`
     (`find_intelligence_note_by_recording_id`) avant d'écrire : trouvé →
     **mise à jour en place** (`update_note_file`, même chemin/nom) ; sinon →
     création comme avant.
   - **✅ Corrigé (feedback tests) — corrections perdues sur la note brute.**
     Finaliser mettait bien à jour le compte-rendu à partir du texte
     relu/corrigé, mais ni la note de transcription brute ni
     `transcriptions.raw_text` n'étaient jamais réécrits avec ce texte —
     rouvrir la note brute (ou relancer une analyse) montrait encore la
     sortie Whisper d'origine, corrections perdues. `run_ingestion_core`
     reporte désormais le texte corrigé sur les deux, dès l'entrée dans la
     finalisation (avant même l'appel IA) : `transcriptions.raw_text` (UPDATE
     par `recording_id`) et le corps de la note brute
     (`update_raw_note_body_by_recording_id`, retrouvée par `recording_id` —
     fonctionne aussi une fois archivée).

**Jamais d'auto-application** d'une correction.

> ✅ **Langue des propositions — corrigé (spec/05).** Sur une réunion **anglaise**
> (transcription EN vérifiée à l'écran), l'écran `/resolve` affichait des
> **propositions et faits en français** : `unclear_sentence` proposée, `context_addition`,
> etc. Cause : le prompt d'`analyze_transcription` et les **descriptions de champs**
> du tool d'analyse étaient **en français** → Claude générait ses propositions **en
> français** quel que soit la langue de la transcription. **Corrigé** : `call_analyze`
> lit désormais `recording_language(db, recording_id)` — la langue **réellement
> détectée par Whisper** pour cet enregistrement (`transcriptions.language`), pas une
> inférence — et lui adjoint une consigne **impérative** (`language_directive`) ; le
> schéma `submit_clarifications` (`analyze_tool(lang)`) est lui aussi aligné sur cette
> langue. Couvre `unclear_sentence.proposed`, `transcription_fix.correction` **et**
> `context_addition.fact` — donc plus de pollution FR dans une note de contexte EN (§4).

### `/resolve` seulement s'il y a quelque chose à vérifier — ✅ fait (feedback tests, **revient sur** l'exigence précédente)

**Décision révisée.** On avait imposé « `/resolve` **toujours** présenté, même sans
rien à corriger ». Retour d'usage : c'est **une friction inutile** quand Claude n'a
**rien** à signaler. Nouveau comportement :

- **Analyse d'abord.** Après la transcription, on lance l'analyse
  (`analyze_transcription`, implémenté dans `run_ingestion_for_recording`).
  - **Rien à vérifier** (aucun `transcription_fix` / `unclear_sentence` /
    `unassigned_task`) → **finalisation directe** (`finalize_ingestion` sur le
    texte brut : compte-rendu + tâches), **sans** afficher `/resolve`, puis
    étapes suivantes (archivage, etc.).
    *(Les `context_additions` restent auto-écrits en « Appris automatiquement », §4 —
    ils ne comptent pas comme « à vérifier », avec ou sans clarifications.)*
  - **Il y a des points à vérifier** → on **n'écrit pas** le compte-rendu tout de
    suite ; la vérification est **persistée** (voir ci-dessous), et la
    finalisation n'a lieu qu'**au « Valider »** de `/resolve`.
- **Ne s'applique qu'à la réunion** (`run_ingestion_for_recording`) — le mode
  **contexte** (spec/13) n'a jamais de `clarifications` à seuiller : sa revue
  sur `/resolve` (« Revoir/corriger ») reste **systématique et volontaire**,
  ce n'est pas une conséquence de ce seuillage.

### La vérification en attente **persiste** et vit **sur la note** — ✅ fait (feedback tests)

Constat test : la vérification n'est proposée que par une **pop-up basse
transitoire** (« N points à vérifier »), **non persistée** (`resolveStore` en mémoire,
spec/17 historique). Si on **enchaîne un 2ᵉ enregistrement** sans avoir vérifié le
1ᵉʳ, la pop-up **disparaît / est écrasée** → la vérification est perdue. Or l'analyse
a un coût (appel Claude) : on ne veut pas la refaire.

- **Persistées par `recording_id`** — table SQLite `pending_clarifications`
  (migration 013, clé `recording_id`, JSON des `Clarifications`) : survivent à
  la navigation, à un **nouvel enregistrement**, et à un redémarrage.
  **Plusieurs vérifications en attente coexistent** (une ligne par
  `recording_id`), chacune rattachée à sa note.
- **Indicateur « à vérifier » SUR la note** (spec/07) : une **petite icône**
  (`MdFactCheck`) à côté de la transcription concernée, dans l'**arbre Notes**
  (vue Dossiers) **et** dans **Récents**. Alimenté par
  `list_pending_clarifications` (les `recording_id` en attente) + l'event
  `pending-clarifications-changed`. **Cliquer l'icône ouvre directement
  `/resolve`** (`resolveStore.loadPersisted` → `get_pending_clarification`) avec
  l'analyse **persistée** — **sans** repasser par le bouton « Vérifier / corriger »
  qui **relance une analyse** (`analyze_transcription`). Ce bouton reste pour
  **re-vérifier volontairement** (nouvelle analyse) ; le chemin normal réutilise
  l'analyse déjà faite.
- **La vue reste tant que non vérifiée** : l'indicateur **persiste jusqu'à ce que
  l'utilisateur ait validé** cette transcription — jamais effacé par un
  enregistrement suivant (une ligne par `recording_id`, pas un slot unique).
- Après **Valider** → `finalize_ingestion` écrit le compte-rendu + tâches,
  **supprime** la ligne `pending_clarifications` (l'icône « à vérifier »
  disparaît) et archive la transcription (spec/07).
- **Croix de la pop-up/bannière = masquer, jamais finaliser — ✅ corrigé
  (feedback tests).** La bannière (`App.tsx`, `ResolveBanner`) appelait
  `finalize_ingestion` sur sa croix « ✕ » (lent, et ça écrivait le compte-rendu
  sans revue) puis vidait la session — perdant l'accès à `/resolve` pour de bon
  puisque `finalize_ingestion` supprime aussi la ligne `pending_clarifications`.
  La croix **masque désormais seulement la bannière** (`clear()` sur le store
  local) : la ligne persistée n'est jamais touchée, l'icône « à vérifier » sur
  la note reste le chemin pour rouvrir `/resolve` plus tard.

> **Implémentation faite** : `src-tauri/src/ai/pending_clarifications.rs`
> (`save`/`get`/`list_recording_ids`/`delete`) + commandes
> `list_pending_clarifications`/`get_pending_clarification` + `VaultNode` gagne
> `recording_id` (parsé comme `status`, pour le croisement côté arbre).
> **Non couvert** : la vue **Projects** de l'arbre (icône ajoutée seulement à la
> vue Dossiers et à Récents — les deux surfaces citées explicitement ci-dessus).

## §4 — Enrichissement du contexte & onboarding

Sur `Contexte Alfred.md` (spec/16) — **pas de nouvelle note** :
- **Enrichissement auto** post-ingestion : les `context_addition` sont écrits
  **automatiquement** par Rust dans une section **`## Appris automatiquement`**
  (relisible / corrigeable), sans validation bloquante. Les **corrections de
  transcription**, elles, restent **validées** (§3), jamais auto-appliquées.
  ⚠️ **Ne doivent arriver ici que des faits DURABLES** (critère resserré, §3) — un
  fait ponctuel écrit ici **pollue le contexte général** (et donc le glossaire +
  toutes les futures ingestions). Le filtrage se fait à la **source** (le critère de
  `context_addition` dans l'analyse), pas au moment de l'écriture.
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
