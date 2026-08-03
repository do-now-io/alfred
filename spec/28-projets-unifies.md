# spec/28 — Projets unifiés (vue d'ensemble par projet)

> **Statut :** 📝 spec écrite, rien de codé. Post-v1, ROADMAP Phase G — referme
> la vision "rassembler autour du projet". Dépend de spec/16b (contexte
> projet), spec/07 (regroupement/renommage projet), spec/24 (e-mails),
> spec/02 (calendrier), spec/07b (chat).

## Principe directeur : agrégation en Rust, pas une boucle agentique

Décision actée : **privilégier l'effort d'ingénierie pour minimiser le coût
en appels Claude.** Répondre à « qu'est-ce qu'il me reste sur le projet
X ? » ne doit **pas** passer par Claude qui itère `search_notes`/`read_note`
plusieurs fois (coûteux, pas fiable — dépend de ce que Claude décide de
chercher). À la place : **toute l'agrégation est faite en Rust pur, sans
appel IA**, via une nouvelle commande unique. Claude n'intervient que pour
la présentation finale quand la question arrive en langage naturel via le
chat (un seul appel, pas une recherche).

## `get_project_overview(project: &str) -> ProjectOverview`

Nouvelle commande Tauri, **pure agrégation** (aucun appel Claude) :

```rust
struct ProjectOverview {
    project: String,
    context_note: Option<{ path: String, excerpt: String }>,  // lien + court extrait, PAS le contenu intégral (liste organisée, pas narrative)
    open_tasks: Vec<TodoTask>,   // +Projet, non archivées, groupées section puis priorité — réutilise todo_md.rs
    notes: Vec<{ title, path, date, note_type }>,  // project: X — réutilise list_notes_with_project (spec/07)
    events: Vec<CalendarEvent>,  // voir heuristique ci-dessous — vide si calendrier non connecté (spec/02)
}
```

- **`open_tasks`** : réutilise le parsing existant de `Todo.md`
  (`todo_md.rs`) — mêmes champs que le Kanban (responsable, échéance,
  priorité, provenance — y compris la provenance texte non cliquable des
  mails, spec/24).
- **`notes`** : réutilise `list_notes_with_project` (déjà utilisé par la vue
  Projets, spec/07) — comptes-rendus + notes taguées, triés par date desc.
- **`context_note`** : simple présence + court extrait (2-3 lignes) de
  `alfred-intelligence/<Projet>.md` (spec/16b) — un **lien**, pas le
  contenu complet (cohérent avec "liste organisée", pas une synthèse).

### Heuristique de correspondance calendrier ↔ projet

Fonction **partagée**, pas dupliquée, entre cette commande et l'indice de
détection de projet à l'analyse (spec/02 §3c) :

```rust
fn find_events_for_project(project: &str, participants: &[String]) -> Vec<CalendarEvent>
```

- **Correspondance** : le titre de l'événement contient le nom du projet
  (comparaison **tolérante** — casse/accents, même logique que le
  renommage de projet, spec/07) **OU** un participant connu de ce projet
  (agrégé depuis le frontmatter `participants` de toutes les notes taguées
  à ce projet) figure dans les `attendees` de l'événement.
- **Fenêtre** : événements des **7 derniers jours** + **14 prochains
  jours** (décision par défaut proposée — plus large que la fenêtre email
  de spec/24, un agenda a besoin de plus de recul dans les deux sens).
- **Vide si le calendrier n'est pas connecté** (spec/02) — pas d'erreur,
  juste une liste vide dans `ProjectOverview.events`.

## Entrée #1 — Chat (spec/07b)

- Nouvel outil **read-only** exposé à `answer_question`, même famille que
  `get_calendar_events` (spec/02) : **`get_project_overview(project)`**.
- **`chat_system`** (prompt système du chat) gagne une instruction
  explicite : *si la question porte sur un projet identifiable (nommé ou
  clairement désigné), appelle `get_project_overview` **une seule fois**
  plutôt que d'itérer `search_notes`/`read_note`* — c'est la clé de la
  réduction de coût : un seul tool call structuré au lieu de plusieurs
  itérations de recherche.
- Claude présente le résultat en **liste organisée** (tâches groupées par
  statut/priorité, notes avec lien `[[titre]]`, événements avec date) —
  même style de réponse que l'existant (gras sur noms/dates, sources
  citées). **Pas de synthèse narrative** (décision actée).
- **Projet inconnu** (aucune correspondance dans `list_projects`) → Claude
  répond qu'aucun projet de ce nom n'existe, sans appeler l'outil pour rien
  (ou l'outil renvoie une structure vide, à trancher à l'implémentation
  selon ce qui est le plus simple à prompter correctement).

## Entrée #2 — Dédiée depuis la vue "Projets" (spec/07)

- Nouvelle entrée dans le **menu contextuel** de l'en-tête de groupe (même
  menu que "Renommer"/"Supprimer le projet", spec/07) : **"Voir l'état du
  projet"**.
- Appelle **directement** `get_project_overview` (commande Tauri) —
  **zéro appel Claude** sur ce chemin. Affiche le résultat déjà structuré
  dans un panneau (sections Tâches ouvertes / Notes / Agenda), rendu
  côté frontend sans génération de texte.
- **Éléments cliquables** : notes → `openNoteByRef` (comme l'existant,
  spec/23) ; tâches → surlignage Kanban (schéma `task:`, spec/23) ;
  événements → **non cliquables**, affichage seulement (pas de deep link
  vers Google Calendar prévu pour cette v1).

## Hors scope (explicite)

- **Pas de synthèse narrative** — liste organisée uniquement (décision
  actée), contrairement à "Rassembler le contexte" d'une tâche (spec/07b)
  qui reste une synthèse écrite pour un usage différent.
- **Pas de mise à jour en direct** — l'aperçu est un instantané au moment
  de l'ouverture (chat ou panneau dédié), pas de `watch`/live-refresh.
- **Pas de croisement inter-projets** ("compare le projet Atlas et le
  projet Zeta") — un seul projet à la fois par appel.

## Commandes Tauri

| Commande | Rôle |
|---|---|
| `get_project_overview(project: String) -> ProjectOverview` | agrégation Rust pure — utilisée à la fois comme tool du chat ET comme commande directe de l'UI dédiée |

## Dépendances

spec/16b (note de contexte projet), spec/07 (`list_notes_with_project`,
renommage/fusion de projet — l'overview doit toujours pointer vers le nom
**canonique** du projet), spec/24 (tâches issues de mails avec leur
provenance texte), spec/02 (`calendar_events`, heuristique de
correspondance partagée), spec/07b (nouvel outil de lecture du chat).
