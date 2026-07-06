# spec/07c — Notes : Vue Graphe

> **Statut v1 :** construit (`get_vault_graph` + écran `Graph.tsx`). Prêt,
> à restyler avec spec 10.

## Vue d'ensemble

Graphe façon Obsidian des liens entre notes, rendu avec `react-force-graph-2d`
(écran `Graph.tsx`). Backend : `notes::graph::build_graph`.

## Construction (`build_graph`)

Parcourt tous les `.md` du vault (fichiers / dossiers cachés ignorés). Pour
chaque note :

- **Nœud note** : `{ id: chemin, label: nom de fichier, kind: "note", path,
  folder }` — `folder` = dossier de 1er niveau, utilisé pour la **couleur**.
- **Wikilinks** `[[Cible]]` / `[[Cible|alias]]` extraits du corps → lien
  note → note (résolu par nom de fichier, insensible à la casse ; self-links
  ignorés).
- **Tags** : frontmatter `tags` + `#tags` inline (au moins une lettre ; un titre
  Markdown `# Titre` n'est pas capté) → nœud `#tag` + lien note → tag.

## Sortie

`get_vault_graph() -> VaultGraph { nodes: GraphNode[], links: GraphLink[] }`
- `GraphNode { id, label, kind: "note" | "tag", path?, folder? }`
- `GraphLink { source, target }`

## Perf

Parcours complet du vault à chaque appel — suffisant pour les tailles v1.
`À TRANCHER` si gros vault : cache / incrémental (hors v1).

## Hors v1 / plus tard

Panneau backlinks, filtres (tag / dossier / projet), mentions non liées, mise en
évidence des liens du projet courant.
