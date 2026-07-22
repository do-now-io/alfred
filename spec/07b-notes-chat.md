# spec/07b — Notes : Chat / Q&A (RAG)

> **Statut v1 :** construit (`ask_notes` + `ChatPanel`). Modèle & routage : spec/05.

## Vue d'ensemble

Q&A conversationnel sur le vault. Boucle **agentique tool-use** : Claude cherche
et lit les notes pertinentes, puis répond en citant ses sources. Point d'entrée
principal : l'**input Alfred** de l'accueil (spec/10).

## Boucle agentique (`answer_question`)

- Modèle `claude-sonnet-5`, non-streaming, thinking off en v1 (spec/05).
- L'historique est passé dans `messages`. **Max 6 itérations** (`MAX_TOOL_ITERATIONS`).
- Outils de **lecture** exposés à Claude :
  - **`search_notes(query)`** : scoring mots-clés sur le vault (titre ×5 +
    occurrences dans le corps, plafonnées) → jusqu'à **6** résultats `(titre, extrait ~240 car.)`.
  - **`read_note(note)`** : lit une note (par chemin, sinon nom de fichier
    insensible à la casse, sinon titre frontmatter), corps tronqué à **4000 car.** ;
    ajoute la note aux **sources**.
  - 📝 **Outils d'ACTION (à ajouter, spec/22)** : Alfred passe de lecture seule à
    **agent** — créer/éditer/renommer/supprimer/archiver des notes, gérer les tâches,
    éditer le contexte, supprimer les données de démo. **Destructif = confirmation**
    (carte Appliquer/Annuler) ; additif/édition = direct. Détail, périmètre et
    garde-fous : **spec/22**.
- Cache sur le system prompt.
- Réponse : **français**, Markdown, **gras** sur noms/dates, chaque source citée en
  `[[titre exact]]` (= nom de fichier, sert de lien cliquable).
- Itérations épuisées → un dernier appel **sans outils** force une réponse.

## Sortie

`ask_notes(question, history: ChatMessage[]) -> ChatResponse { answer, sources }`
- `ChatMessage { role: "user" | "assistant", content }`
- `ChatSource { title (nom de fichier = clé de citation), path (chemin absolu, pour ouvrir la note) }`
- Événement **`chat-progress { kind: "search" | "read", label }`** émis pendant la
  boucle (retour d'état dans l'UI).

## UI

Composant `ChatPanel`. L'input Alfred de l'accueil alimente `ask_notes` ; les
exemples d'amorces vivent dans la spec/10.

## Dictée vocale de la question — ✅ fait (feedback tests)

Aujourd'hui on ne peut interroger Alfred qu'au **clavier**. On ajoute une **dictée
vocale** : parler sa question, Alfred la transcrit dans le champ, on relit/corrige,
on envoie. Réutilise la **capture micro** (spec/03) + **Whisper embarqué** (spec/04)
déjà présents — mais en **mode éphémère**, distinct de l'enregistrement de réunion.

- **UI** : un **bouton micro** dans la barre de saisie du chat (`ChatPanel`, à côté
  de « Envoyer » ; idem `ChatTeaser` de l'accueil, spec/10). Clic → capture ; état
  « à l'écoute » **inline** (petit indicateur + éventuel niveau/volume, un bouton
  **stop**). Stop → transcription → le texte est **inséré dans le champ** (au
  curseur / ajouté à l'existant), **éditable** avant envoi (on **n'envoie pas**
  automatiquement).
- **Éphémère, pas une note** : l'audio de dictée est un **clip temporaire**
  transcrit puis **supprimé** — **aucune** écriture dans `alfred-raw/`, **aucune**
  ligne `recordings`, **aucune** ingestion (compte-rendu/tâches). C'est de la
  saisie, pas un enregistrement.
- **Autonome vis-à-vis de l'enregistrement de réunion** : n'utilise **pas** le
  bandeau global ni la page `/recording` (spec/03/10). La capture réunion étant un
  singleton, **désactiver** le bouton dictée pendant qu'un enregistrement de réunion
  est en cours (et inversement), pour éviter le conflit de périphérique.
- **Dégradation gracieuse** : micro refusé / transcription en échec → message court,
  on **conserve** le texte déjà tapé ; la saisie clavier reste toujours disponible.
- **Backend** (à ajouter) : chemin de transcription léger qui **rend le texte**
  plutôt que d'écrire une note, p. ex. `start_dictation()` / `stop_dictation() ->
  String` (ou `transcribe_clip`) — réutilise le capteur micro (cpal) + `run_whisper`
  sur le WAV temporaire, avec le **glossaire** existant (spec/17) pour la même
  qualité, puis nettoie le fichier. Retour d'état via un événement dédié
  (`dictation-status-changed`) plutôt que `recording-status-changed`.
- **Réutilisable** ailleurs (hors périmètre de cette tâche mais viser un composant
  partagé) : correction de contexte (spec/13), feedback (spec/14).

## Contexte d'une tâche (bouton « Rassembler le contexte ») — 📝 à faire (feedback tests)

Depuis la **fiche tâche** (spec/06), un bouton lance une **action IA à la demande**
qui **réunit le contexte utile pour réaliser la tâche** : point d'entrée = la même
boucle agentique (`answer_question`), amorcée avec le **titre de la tâche** + sa
**provenance** (`[[compte-rendu source]]`, spec/05/06). Claude lit le compte-rendu
source puis cherche les **notes liées** (tags / projet communs) et renvoie un
**résumé synthétique** + les **sources** (comptes-rendus similaires cliquables).
Jamais automatique. Réutilise `search_notes` / `read_note` ; sortie = `ChatResponse`.

## Recherche

Simple **keyword-match** (pas d'embeddings) — suffisant pour la v1.

## Historique & conversations

L'historique est **conservé** et plusieurs conversations sont listées sur la page
Alfred (spec/10). Persistance locale (SQLite) — voir spec/10.

## Hors v1 / plus tard

Recherche **vectorielle** (embeddings), **streaming** des réponses, citations avec
extrait exact surligné.
