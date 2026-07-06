# spec/07b — Notes : Chat / Q&A (RAG)

> **Statut v1 :** construit (`ask_notes` + `ChatPanel`). Modèle & routage : spec/05.

## Vue d'ensemble

Q&A conversationnel sur le vault. Boucle **agentique tool-use** : Claude cherche
et lit les notes pertinentes, puis répond en citant ses sources. Point d'entrée
principal : l'**input Alfred** de l'accueil (spec/10).

## Boucle agentique (`answer_question`)

- Modèle `claude-sonnet-5`, non-streaming, thinking off en v1 (spec/05).
- L'historique est passé dans `messages`. **Max 6 itérations** (`MAX_TOOL_ITERATIONS`).
- Deux outils exposés à Claude :
  - **`search_notes(query)`** : scoring mots-clés sur le vault (titre ×5 +
    occurrences dans le corps, plafonnées) → jusqu'à **6** résultats `(titre, extrait ~240 car.)`.
  - **`read_note(note)`** : lit une note (par chemin, sinon nom de fichier
    insensible à la casse, sinon titre frontmatter), corps tronqué à **4000 car.** ;
    ajoute la note aux **sources**.
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

## Recherche

Simple **keyword-match** (pas d'embeddings) — suffisant pour la v1.

## Historique & conversations

L'historique est **conservé** et plusieurs conversations sont listées sur la page
Alfred (spec/10). Persistance locale (SQLite) — voir spec/10.

## Hors v1 / plus tard

Recherche **vectorielle** (embeddings), **streaming** des réponses, citations avec
extrait exact surligné.
