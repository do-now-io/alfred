# spec/13 — Onboarding

> **Statut v1 :** refonte de l'assistant existant (`Onboarding.tsx`).

## Déclenchement

Affiché si `onboarding_completed` ≠ `"true"` **et** aucun vault configuré
(logique dans `App.tsx`, existante — un install avec vault est considéré comme
onboardé). Rejouable via « Revoir l'introduction » (Paramètres). À la fin :
`set_config('onboarding_completed', 'true')`.

**Bug — écran blanc en fin de replay — ✅ fait.** « Revoir l'introduction »
(`sessionStorage.alfred_force_onboarding` + `window.location.reload()`) →
wizard rejoué → « Terminer » restait bloqué sur la garde de chargement
(`onboarded === null`, fond uni sans sidebar). Cause : `forceOnboarding` était
une simple lecture de `sessionStorage` à **chaque rendu**, pas un état React —
sur une install déjà onboardée, `onboarded` vaut déjà `true` quand le replay
se termine, donc `setOnboarded(true)` est un no-op (React n'y voit aucun
changement, ne re-rend pas) et rien ne force `App` à ressortir de la branche
`forceOnboarding`. Fix : `forceOnboarding` est maintenant un `useState`,
explicitement remis à `false` dans `finishOnboarding`/`finishOnboardingReplay`
— garantit un rendu quel que soit l'état précédent d'`onboarded`.

## Flux (assistant à étapes — points de progression, Précédent / Suivant / Passer)

0. **Langue / Language** (✅ fait, spec/21) — sélecteur **Français / English**
   avant tout le reste ; écrit `app_language` (pré-sélection sur la langue système si
   `fr`/`en`, sinon `en`). Toute la suite de l'onboarding s'affiche dans la langue
   choisie. Modifiable ensuite dans les Réglages.
1. **Bienvenue**.
2. **Intro 1** — Capturer à la voix → transcription locale (Whisper, hors
   ligne — le modèle s'installe à l'étape suivante).
3. **Modèle de transcription** (✅ étape Whisper de retour — le modèle n'est
   plus embarqué, spec/04) — choix + téléchargement d'un modèle via le
   composant partagé `WhisperModelPicker` (catalogue spec/04). Disclaimer :
   **Small recommandé** (largement suffisant au quotidien) ; Medium /
   Large-v3 Turbo pour les machines puissantes (plus fidèles, plus lourds).
   **Passable** ; « Suivant » désactivé pendant un téléchargement ; si on passe
   en plein téléchargement, il **continue en arrière-plan** (les événements
   portent le nom du modèle → Réglages ré-affiche la progression en cours). Le
   premier modèle téléchargé devient automatiquement le modèle actif. Le choix
   de **langue** reste en Paramètres.
4. **Intro 2** — Notes + tâches automatiques (ingestion) + chat avec Alfred.
5. **Vault** — « Avez-vous déjà un vault (Obsidian) ? »
   - **Oui** → choisir le dossier → Alfred crée `alfred-raw/` + `alfred-intelligence/`
     **dedans**, sans toucher au reste.
   - **Non** → choisir / créer un dossier → Alfred y crée `alfred-raw/`
     (transcriptions), `alfred-intelligence/` (comptes-rendus) et `Todo.md`.
   - Création à la validation, **idempotente** (ne pas écraser l'existant).
     **Aucun** fichier `.claude` / skill écrit (spec/07).
6. **Accès IA** — les **deux** options présentées (modifiables ensuite dans Paramètres) :
   - **Ma clé Claude** → coller la clé (`save_secret('claude_api_key')` + `test_api_key`).
   - **Abonnement AlfredIA** — 20 €/mois (ou annuel), **14 jours d'essai gratuit**
     (✅ fait) → bouton « Commencer l'essai gratuit » → Stripe + loopback
     (backend privé `alfred-backend`) → `alfredia_token` récupéré automatiquement. Accès immédiat pendant
     l'essai ; débit à la fin des 14 jours si non annulé (facturation gérée par le backend privé).
7. **Micro** — test de permission (`test_microphone` ; déclenche le prompt macOS ;
   sur Windows, ouverture WASAPI).
8. **Contexte** (🚧 pas de carte dédiée dans le wizard — l'annonce équivalente
   vit dans la carte d'intro de la visite guidée juste après, § Tournée guidée
   étape 1 ; à trancher si les deux doivent coexister) — carte d'annonce : *« Alfred travaille
   bien mieux s'il connaît votre univers (collègues, clients, projets, jargon). On
   va le lui apprendre à la voix, juste après, en 2 minutes. »* **Aucun formulaire
   ici** : la création du contexte est faite **à la voix dans la visite guidée**
   (§ Tournée guidée, étape 2 — remplace l'ancien interview textuel). Nécessite
   l'accès IA (étape 6). Skippable (contexte vide = comportement spec/16 actuel).
9. **Terminé**.

## Tournée guidée (post-onboarding) — **crée le contexte à la voix**

Juste après l'étape **Terminé**, avant de lâcher l'utilisateur sur l'accueil :
un **essai réel guidé**, pas une simulation. Le **premier (et unique)
enregistrement de la visite EST la création du `Contexte Alfred.md`** (spec/16) :
l'utilisateur se présente à voix haute en suivant un **script (téléprompteur)**,
Alfred transcrit, structure la note de contexte et **génère le premier glossaire
Whisper** (spec/17 §1). Double bénéfice : ça apprend à enregistrer **et** ça
personnalise Alfred dès la première minute. But : que le premier contact soit un
« wahou » utile, pas un écran vide ni une réunion bidon.

> **Pourquoi le contexte plutôt qu'une réunion de démo ?** Le contexte est ce qui
> améliore *tous* les enregistrements suivants (orthographe des noms via le
> glossaire + ingestion, spec/16/17). Le faire en premier maximise la valeur ; la
> démo « compte-rendu + tâches » se vit naturellement au premier vrai
> enregistrement de l'utilisateur.

**Déclenchement** : automatique juste après l'onboarding (une seule fois —
`tour_completed` en config) ; rejouable via **« Revoir la visite guidée »**
(Paramètres), séparé de « Revoir l'introduction ». **Passable à tout moment**
(bouton discret « Passer la visite » sur chaque étape) — ne bloque jamais l'accès
à l'app. Si un skip survient, `tour_completed` passe `true` quand même (ne
revient pas au prochain lancement) ; seul « Revoir la visite guidée » la relance.

### Étapes (pilotées par les vrais événements, pas des délais)

1. **Carte d'intro** — *« Apprenons à Alfred qui vous êtes. Vous allez vous
   présenter à voix haute pendant que je vous transcris — je m'en servirai pour
   bien orthographier vos collègues, clients et votre jargon. Deux minutes. »* →
   « Allons-y » / « Plus tard ».
2. **Enregistrement de contexte (téléprompteur)** — un panneau **téléprompteur**
   affiche le **script** (voir « Script de contexte » ci-dessous), section par
   section, et porte **ses propres commandes** : c'est lui qui lance la prise en
   **mode contexte** (`purpose: "context"`, voir backend) — et non la carte
   d'accueil, qui elle démarre une réunion normale. Le script reste visible pendant
   toute la prise ; l'utilisateur lit/paraphrase à son rythme. Traitement dédié,
   **pas** d'ingestion réunion.

   **Contrôles enrichis** (feedback tests — l'utilisateur doit pouvoir se
   reprendre, pas être piégé dès qu'il clique « stop ») :
   - **Commencer l'enregistrement** (lance la prise).
   - **Pause / Reprendre** pendant la prise (le chrono se fige, la capture
     s'interrompt sans clôturer la prise). *Support pause/reprise de la capture
     audio : ✅ fait (spec/03 — `pause_recording`/`resume_recording`).*
   - **J'ai terminé** → **ne lance PAS directement** la transcription. On passe dans
     un état intermédiaire « prise terminée » offrant :
     - **Recommencer** — jette la prise et repart à zéro (nouvel enregistrement de
       contexte, l'audio précédent est écarté).
     - **Continuer** — valide la prise et lance seulement là la
       transcription/traitement (mode contexte).

   Attend `recording-status-changed → "recording"` (et `"paused"` le cas échéant)
   puis, après **Continuer**, `→ "stopping"/"processing"`.
3. **« Je m'occupe de tout » (carte, ✅ fait, demande utilisateur)** — juste après
   **Continuer**, avant d'entamer la visite : une carte pose l'attente
   explicitement plutôt que de basculer silencieusement sur Notes avec pour
   seul indice le petit indicateur d'état. *« J'écoute ce que vous venez de
   dire et j'en tire votre contexte — ça prend quelques instants. Je
   reviendrai vers vous dès que c'est prêt. En attendant, faisons le tour de
   l'application. »* → **« Découvrir l'application »** (avance vers l'étape 4).
4. **Le point d'état de la sidebar (spotlight, ✅ fait, demande utilisateur)** —
   avant de quitter `/recording`, un spotlight pointe le petit point sous le
   logo Alfred (`AlfredLogo`, sidebar — toujours monté, quel que soit l'écran) :
   *« Ce point, c'est moi. Il clignote quand je travaille — j'enregistre, je
   transcris ou je réfléchis — et reste discret quand je suis disponible. Vous
   me retrouverez ici ou sur les documents sur lesquels je travaille. »* →
   **« Suivant »** (navigue vers
   `/notes` à ce moment-là, pas avant, puis avance vers l'étape 5).
5. **Visite de l'app pendant la transcription** — la transcription du contexte est
   **longue** ; au lieu d'un simple bandeau d'attente, la visite **occupe ce temps
   utile** en faisant découvrir l'app, étape par étape (spotlights non bloquants),
   pendant que le traitement tourne en arrière-plan :
   1. **Notes** — où retrouver les comptes-rendus (spec/07).
   2. **Tâches** — `Todo.md` agrégé (sections Prioritaire / En cours / À faire, spec/06).
   3. **Graphe** — les liens entre notes (spec/07c).
   4. **Questions à Alfred** — le chat (poser une question, suggestions, spec/07b).
      **Ne répète plus** comment enregistrer (feedback tests) : un seul rappel
      suffit, celui de l'étape `record-cta` juste après validation du contexte.

   Un **indicateur d'état discret** rappelle en permanence qu'Alfred « écoute et met
   au propre… » puis « range tout ça… » (piloté par `recording-status-changed =
   processing`, puis `transcription-complete` → structuration) — le même point
   d'état expliqué à l'étape 4, désormais reconnaissable.

   > **La visite ne doit PAS être interrompue** (feedback tests) : même si le
   > contexte finit d'être construit pendant qu'on visite, on **laisse
   > l'utilisateur dérouler toutes les étapes présentées jusqu'au bout**. L'événement
   > `context-status-changed { status: "done" }` est **mis de côté** (drapeau
   > « contexte prêt » + son récap : sections remplies, nombre de termes de
   > glossaire) — il **ne déclenche rien** en cours de visite, il est simplement
   > **mémorisé** pour l'étape 6.
6. **Contexte prêt (pop-up)** — s'affiche **à la fin de la visite** (après la
   dernière étape de découverte, étape 5.4), **pas** au moment où le contexte est
   prêt. Deux cas :
   - **Contexte déjà prêt** (l'événement `done` est arrivé pendant la visite, mis de
     côté) → la pop-up s'affiche immédiatement avec le récap mémorisé.
   - **Pas encore prêt** → on reste sur l'indicateur d'état jusqu'à réception de
     `context-status-changed { status: "done" }`, puis la pop-up apparaît.

   Contenu : *« Alfred vous connaît maintenant — mais vérifiez ce qu'il a compris. »*
   + aperçu (sections remplies + *« {n} noms propres ajoutés au glossaire »*).
   **Un seul bouton : « Revoir / corriger »** (l'ancien bouton « Continuer » est
   **retiré** — on veut forcer le passage par la vérification).
7. **Correction du contexte — MÊME écran que pour un vrai enregistrement** (✅
   fait, feedback tests) — « Revoir / corriger » ouvre **exactement le même écran
   `/resolve`** et **le même flux de vérification/correction** que la correction d'une
   note d'enregistrement normale (spec/17). **Pas de page ni de variante spécifiques
   à l'onboarding** : même composant, même route, mêmes interactions (texte éditable
   CodeMirror, cartes appliquer/ignorer, réécoute WAV via `read_recording_wav`,
   **Valider**). Seul le **contenu** injecté diffère (issu du traitement contexte),
   pas l'UI. On n'ouvre **plus** la note brute dans `/notes`.

   > **✅ Corrigé (feedback tests) :** l'onboarding présentait une page `/resolve`
   > **différente** de celle d'une vérification normale. Unifié : toute page/variante
   > « mode contexte » spécifique retirée — l'onboarding passe par le même écran et
   > le même parcours que n'importe quel enregistrement.
8. **Clôture** — après validation, carte chaleureuse, ton majordome : *« Vous êtes
   équipé »* / *« Désormais : parlez, Alfred écoute, résume et retient. Le reste,
   vous le découvrirez en l'utilisant. »* → « Terminer ».

**Dégradation gracieuse** : si l'enregistrement/transcription/structuration échoue
(`status: "error"`), message d'excuse avec l'erreur + « Continuer quand même » →
clôture directe (le contexte reste alors vide = template, comportement spec/16).
La visite ne force jamais la navigation hors des étapes qui en ont explicitement
besoin (2 et 5) ; si l'utilisateur navigue ailleurs de lui-même, elle s'efface
silencieusement (traité comme un skip) plutôt que de le rediriger de force.

### Script de contexte (téléprompteur)

Affiché à côté de la carte d'enregistrement à l'étape 2. **Guide, ne dicte pas** :
l'utilisateur paraphrase, saute ce qui ne le concerne pas, va à son rythme. But =
couvrir le maximum de noms propres / jargon (matière du glossaire). Texte proposé,
en sections défilantes :

> **Présentez-vous à Alfred** — parlez naturellement, comme si vous décriviez votre
> travail à un nouveau collègue. Épelez les noms inhabituels.
>
> 1. **Qui vous êtes** : votre prénom, votre rôle, votre entreprise et ce qu'elle fait.
> 2. **Ce que vous allez enregistrer** : quels types de réunions / d'échanges (points
>    d'équipe, appels clients, notes perso…).
> 3. **Votre équipe** : les prénoms de vos collègues proches et leur rôle
>    (« Marie, cheffe de projet ; Tom, dev back… »).
> 4. **Vos clients / partenaires** : les noms d'entreprises et de personnes qui
>    reviennent souvent.
> 5. **Vos projets en cours** : leurs noms (surtout les noms de code inhabituels).
> 6. **Votre vocabulaire** : les mots, sigles et outils que vous employez souvent et
>    qu'une machine écorcherait. *Ex. pour un DevOps : « je dis Kube pour Kubernetes,
>    et j'utilise Grafana, GitHub, Terraform, ArgoCD… ».*
>
> Besoin d'une pause ? Mettez en pause et reprenez quand vous voulez. Une fois
> terminé, vous pourrez **recommencer** si besoin, ou **continuer** — puis tout
> relire et corriger juste après.

Le script est **éditable** plus tard (config, hors v1 pour l'éditeur ; le texte par
défaut vit côté front). Il reprend l'esprit des conseils de captation (spec/03).

### Contenu de démarrage (seed) — pour que la visite ait de la matière

Pendant la visite (étape 3), on parcourt Notes / Tâches / Graphe / Alfred **alors
que l'utilisateur vient d'arriver** : ces pages seraient **vides**. On sème donc,
à l'onboarding, un **contenu de démarrage réel** (écrit dans le vault / la base),
**gardé** (pas de nettoyage auto) — utile comme checklist de prise en main, que
l'utilisateur **supprime quand il veut**.

- **Semis unique et idempotent** : au scaffolding du vault (ou au 1er lancement de
  la visite), garder un drapeau de config (ex. `starter_content_seeded = "true"`).
  **Ne jamais re-semer** ensuite — si l'utilisateur supprime le contenu, il ne
  revient pas.
- **Tâches** (`Todo.md`, spec/06) — checklist de démarrage qui **démontre les
  interactions** (favori = section **Prioritaire** ; statut = sections Prioritaire /
  En cours / À faire ; `checked` = fait ; `responsable` = assignation). Ex. :
  - *Prioritaire* : « Faire le tour d'Alfred » (assignée à l'utilisateur).
  - *En cours* : « Faire un premier enregistrement ».
  - *À faire* : « Vérifier / compléter mon contexte », « Inviter un collègue »
    (assignée à un prénom d'exemple).
  - une tâche déjà **cochée** pour montrer l'état « fait ».
- **Notes** (`alfred-intelligence/`, spec/07) — **2 notes de démo** (fausses
  données) avec **frontmatter `project` + `participants`** renseigné, pour que la
  **vue « Projets »** et le **graphe** aient de la matière (liens entre notes /
  participants). Ton clairement « exemple » pour ne pas se confondre avec du vrai
  contenu.
- **Graphe** (spec/07c) — **pas de seed dédié** : il se peuple **tout seul** à
  partir des 2 notes de démo (projets / participants partagés).
- **Alfred / chat** (spec/07b) — **les deux** : (a) une **fausse conversation
  passée** dans l'historique (SQLite chat, spec/05/10) montrant un échange type ;
  (b) une **question suggérée** mise en avant (spotlight) que l'utilisateur peut
  cliquer — dont celle sur le contexte fraîchement créé (*« Que sais-tu de mon
  équipe et de mes projets ? »*).

> **Note produit** : ce contenu de démarrage sert aussi **hors visite** (un
> utilisateur qui passe la visite arrive quand même sur des pages non vides). Le
> semis est donc rattaché à l'**onboarding**, pas à la visite elle-même.

#### Suppression en un clic du contenu de démarrage — ✅ fait

Une fois que l'utilisateur a **joué** avec les données de démo, il doit pouvoir
**tout supprimer d'un coup**. Bouton **one-shot** :

- **Emplacement** : dans la **page Alfred** (spec/10) — bandeau discret
  *« Ces données sont des exemples — [Supprimer les données de démo] »*.
- **Action** : commande **`delete_starter_content()`** qui retire **uniquement** le
  contenu semé — les tâches checklist de `Todo.md`, les 2 notes de démo, la fausse
  conversation de chat. **Ne touche à rien d'autre** (contenu réel de l'utilisateur).
- **Ciblage sûr** : frontmatter **`alfred_seed: true`** (texte brut, hors du schéma
  `NoteMetadata`) sur les notes de démo — robuste au déplacement/renommage. Pour les
  tâches, **pas de marqueur visible sur la ligne** (aurait fuité dans l'affichage,
  `parseTasks` n'a pas de mécanisme pour le masquer comme il le fait pour ⭐) :
  on matche plutôt les titres exacts semés, dans les **deux langues** (le fichier
  garde la langue dans laquelle il a été écrit). Pour le chat, l'id de la
  conversation de démo est retenu en config (`starter_content_chat_conversation_id`)
  et supprimé via `chat_history::delete_conversation`.
  > **Bug corrigé (feedback tests)** : le retrait des tâches semées comparait par
  > **sous-chaîne** (`ligne.contains(titre_semé)`) — un titre réel qui contenait
  > par coïncidence un des 10 titres semés (dans l'une des deux langues) se
  > retrouvait supprimé avec eux. `delete_starter_content` retire désormais
  > chaque tâche semée par **identité exacte** (`todo_md::remove_task`, même
  > `normalize_title` que partout ailleurs dans l'app) — plus jamais une
  > correspondance de fragment de texte.
- **One-shot** : `has_starter_content()` fait une **vérification en direct** des 3
  sources plutôt que de dépendre d'un drapeau figé au semis — couvre nativement le
  cas « l'utilisateur a tout supprimé à la main » sans logique séparée. Le bandeau
  réévalue sur les événements `notes-updated` / `todos-updated`.

### Nouvel événement backend

`context-status-changed { status: "done" | "error", recording_id, sections_filled?,
glossary_terms? }` — émis en fin du traitement « mode contexte » (structuration de
`Contexte Alfred.md` + génération du glossaire), pour piloter l'étape 5. Analogue
au `ingestion-status-changed { status, recording_id }` du flux réunion normal
(toujours émis en fin de `ai::run_ingestion_core`, utilisé hors visite guidée).

## Traitement « mode contexte » (backend)

L'enregistrement de contexte suit le **même pipeline audio/Whisper** que tout
enregistrement (spec/04) — WAV dans `alfred-raw/`, transcription, décodage
amélioré + glossaire s'il existe déjà (spec/17 §2). Ce qui change, c'est **l'aval**
de `transcription-complete` :

- **Marquage** : l'enregistrement est lancé avec un **but** `purpose: "context"`
  (paramètre optionnel de `start_recording`, défaut `"meeting"`). Persister le but
  sur la ligne `recordings` (ou en état transitoire) suffit à router l'aval.
- **Route dédiée** — au lieu de l'ingestion réunion (compte-rendu + tâches,
  spec/05), Rust lance `build_context_from_transcription` :
  1. **Claude structure** la transcription brute dans les sections de `Contexte
     Alfred.md` (Mon entreprise / Équipe / Vocabulaire & noms propres / Projets en
     cours — mêmes sections que le template spec/16). Tool-use forcé, `claude-sonnet-5`.
     La note appartient à l'utilisateur : on **écrit** le contenu structuré (pas de
     compte-rendu réunion), corrigeable ensuite dans `/notes`.
  2. **Glossaire** : enchaîne `generate_glossary_from_context` (spec/17 §1) →
     `config.transcription_glossary`.
  3. Émet `context-status-changed { status, recording_id, sections_filled,
     glossary_terms }`.
- **Note de réunion** : en mode contexte, **pas** de compte-rendu dans
  `alfred-intelligence/`, **pas** de tâches. Le WAV reste dans `alfred-raw/`
  (ré-écoute / refaire), cohérent spec/04. **La note brute de transcription du
  contexte est archivée** (`status: archived`) une fois `build_context_from_transcription`
  réussi — comme les transcriptions de réunion après ingestion (✅ fait, feedback
  tests, spec/07) : sinon elle resterait seule visible dans Notes alors que toutes les
  autres transcriptions disparaissent.
- **Hors visite guidée** : le même `build_context_from_transcription` est
  réutilisable par un futur bouton « (Re)créer mon contexte à la voix » (Réglages).

## Création des dossiers du vault

À la sélection du vault, scaffolder (commande à ajouter, ou extension de
`set_vault_path`) : `alfred-raw/`, `alfred-intelligence/`,
`alfred-intelligence/Todo.md` (avec les sections Prioritaire / En cours / À faire /
Archivé). Idempotent.

## Écran de fin — ✅ fait (2e passe, feedback tests)

L'étape de clôture du wizard (`Onboarding.tsx`, « Tout est prêt ! ») et l'étape
« Vous êtes équipé » de la visite guidée (`GuidedTour.tsx`, case `closing`)
étaient des panneaux génériques (icône + titre + texte), sans rapport visuel
avec le reste de l'app.

**1ʳᵉ passe (revenue en arrière) :** aperçu statique de la carte « Démarrer
l'enregistrement » dans chacun des deux écrans. **Retour d'usage :** cet
aperçu ne correspondait même pas au vrai bouton et n'apportait rien — retiré.

**2ᵉ passe (actuelle) :** le wizard redevient un panneau simple (« Tout est
prêt ! » sans encart). À la place, une **nouvelle étape `record-cta`** dans la
visite guidée, juste avant `closing` — un **vrai spotlight** (composant
`Spotlight`, déjà utilisé pour l'étape « point d'état ») sur les DEUX vrais
déclencheurs, simultanément visibles sur `/` : le **logo Alfred** (sidebar,
toujours monté — nouvelle cible `alfred-logo-button`) et la **carte
d'enregistrement de l'accueil** (`hero-card`, déjà enregistrée par
`Dashboard.tsx` mais jusqu'ici jamais consommée par la visite). `Spotlight`
gagne un `children` optionnel pour ce cas (glow seul, sans bulle de texte —
évite un overlay invisible cliquable qui bloquerait la sidebar dessous).
`Resolve.tsx` route désormais vers `record-cta` (au lieu de `closing`
directement) après validation du contexte en mode visite guidée.

> **✅ Bug corrigé (feedback tests) — halo décalé.** Le halo sur `hero-card`
> apparaissait décalé par rapport à la vraie carte quand la bannière « Supprimer
> les données de démo » (`Dashboard.tsx`) s'affichait au-dessus : elle pousse la
> carte vers le bas via un `invoke` **asynchrone** (`has_starter_content`), qui
> résout **après** la première mesure du halo. `Spotlight` (`components/tour/
> Spotlight.tsx`) ne réagissait qu'à un `ResizeObserver` sur la cible — qui ne
> détecte qu'un changement de **taille**, jamais un décalage de **position**
> causé par un élément voisin. Corrigé : mesure en boucle (`requestAnimationFrame`)
> tant que le halo est monté, qui capte tout décalage de mise en page, pas
> seulement un resize de la cible.

## Retiré / déplacé

- **Étape « Connecter Google »** + slide agenda → **retirées** (calendrier hors v1).
- ~~**Étape Whisper** (modèle / langue / téléchargement) → déplacée en Paramètres~~
  **Revu, ✅ fait** : le modèle n'étant plus embarqué (spec/04, CI packaging),
  l'étape de téléchargement est **revenue dans l'onboarding** — voir Flux,
  étape 3 « Modèle de transcription ». Le choix de **langue** reste en
  Paramètres ; le gestionnaire de modèles complet (pré-téléchargement,
  annulation, suppression) vit en Paramètres (spec/11), avec le même composant.
- **Slides d'intro** : 6 → **2**.

## Commandes Tauri utilisées

`get_vault_path` / `set_vault_path` / `pick_vault_folder` (+ scaffolding dossiers) ·
`save_secret` / `get_secret` (`claude_api_key`) · `test_api_key` · `subscribe_alfredia`
(backend privé `alfred-backend`) · `test_microphone` · **`list_whisper_models` / `download_model` /
`cancel_model_download`** (✅ — étape « Modèle de transcription », spec/04) ·
`get_config` / `set_config` (`onboarding_completed`,
`tour_completed`) · `start_recording(purpose = "meeting" | "context")` /
`stop_recording` (tournée guidée, via le store d'enregistrement existant) ·
**`pause_recording` / `resume_recording`** (✅ — contrôles téléprompteur,
spec/03) · **`discard_recording`** (✅ — bouton « Recommencer ») ·
**`process_recording`** (✅ — bouton « Continuer », spec/03) ·
**`seed_starter_content`** (✅ — contenu de démarrage, flag
`starter_content_seeded`) · **`has_starter_content`** / **`delete_starter_content`**
(✅ — bandeau + suppression one-shot du contenu de démo marqué `alfred_seed`,
page Alfred) ·
`build_context_from_transcription` (route
« mode contexte » → structure `Contexte Alfred.md` +
`generate_glossary_from_context`, spec/17) · `read_recording_wav` (réécoute dans
l'écran /resolve mode contexte).

## Hors v1 / plus tard

Connexion Google / Microsoft, indexation d'un gros vault existant à l'import.
