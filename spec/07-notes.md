# spec/07 — Notes (vault Obsidian-style)

## Architecture

Toutes les notes sont des fichiers `.md` stockés dans un dossier **vault** configuré par l'utilisateur (Settings → Dossier Notes). Alfred ne stocke plus les notes en SQLite — seul le chemin du vault est persisté en config (`notes_vault_path`).

Le vault est compatible Obsidian : tout fichier `.md` créé dans Alfred peut être ouvert dans Obsidian et vice-versa.

---

## Format de fichier

Chaque note est un fichier `.md` avec un frontmatter YAML :

```markdown
---
title: Réunion client - Acme
date: 2026-06-11
tags: [travail, client, suivi]
type: note
status: active
recording_id: uuid-optionnel-pour-notes-vocales
---

# Réunion client - Acme

Contenu Markdown...
```

### Champs frontmatter

| Champ | Type | Défaut | Description |
|---|---|---|---|
| `title` | string | nom du fichier (sans `.md`) | Titre affiché |
| `date` | YYYY-MM-DD | aujourd'hui | Date de création |
| `tags` | list | [] | Tags colorés (chips) |
| `type` | string | "note" | `note` / `meeting` / `task` |
| `status` | string | "active" | `active` / `archived` |
| `recording_id` | string? | null | UUID d'enregistrement lié (notes vocales) |

---

## Layout UI (3 panneaux)

```
[Sidebar Alfred 240px] | [Arbre fichiers 240px] | [Contenu note flex-1]
```

### Panneau arbre de fichiers (240px)

- Arborescence des dossiers et fichiers `.md` du vault
- Dossiers collapsibles (▶ fermé / ▼ ouvert)
- Clic sur un fichier → ouvre la note dans le panneau droit
- Clic droit sur un nœud → menu contextuel : Renommer / Supprimer
- Bouton "+" en haut → créer une nouvelle note dans le dossier sélectionné (ou à la racine)
- Tri : dossiers en premier, puis ordre alphabétique dans chaque groupe
- Fichiers masqués (commençant par `.`) et non-`.md` ignorés

### Panneau contenu (flex-1)

**Fil d'Ariane** en haut : `dossier / nom-fichier` (nom sans `.md`)

**Navigation** : boutons ← / → pour noter précédente / suivante dans l'historique

**Section Properties** (frontmatter visuellement structuré) :
```
Properties
  📅 date      20/04/2026  [lien]
  🏷 tags       [travail ×] [client ×] [+ ajouter]
     type       note
     status     active
  + Ajouter une propriété
```

**Corps** :
- Mode **Preview** par défaut : `react-markdown` avec couleurs Alfred
  - Liens et titres H1/H2 : `color: #C8914A` (accent doré)
  - Checkboxes interactives
  - Blockquotes avec bordure gauche `#C8914A`
  - Code inline : fond `#F5EDD8`
- Mode **Edit** (toggle ✏️) : CodeMirror 6 + `@codemirror/lang-markdown`
- Auto-save : 2 secondes après le dernier keystroke en mode Edit

**Pied de page** :
```
N mots · M caractères · P propriétés   [✏️ edit icon]
```

---

## Prompt d'installation (vault non configuré)

Si `notes_vault_path` est vide, afficher à la place de l'arbre :
```
Aucun dossier Notes configuré.
[Choisir un dossier] → ouvre Settings → Notes
```

---

## Commandes Tauri

```rust
get_vault_tree() → Result<VaultNode, String>
get_note_file(path: String) → Result<NoteFile, String>
create_note_file(folder: String, title: String) → Result<NoteFile, String>
update_note_file(path: String, metadata: NoteMetadata, body: String) → Result<NoteFile, String>
delete_note_file(path: String) → Result<(), String>
rename_note_file(old_path: String, new_name: String) → Result<NoteFile, String>
get_vault_path() → Result<Option<String>, String>
set_vault_path(path: String) → Result<(), String>
pick_vault_folder() → Result<Option<String>, String>  // picker natif macOS
```

---

## Structs Rust exposées (ts-rs)

```rust
#[derive(Serialize, Deserialize, TS)]
pub struct VaultNode {
    pub name: String,
    pub path: String,           // chemin absolu
    pub is_dir: bool,
    pub children: Vec<VaultNode>,
}

#[derive(Serialize, Deserialize, TS)]
pub struct NoteMetadata {
    pub title: String,
    pub date: String,           // "YYYY-MM-DD"
    pub tags: Vec<String>,
    pub note_type: String,      // sérialisé "type" via #[serde(rename)]
    pub status: String,
    pub recording_id: Option<String>,
}

#[derive(Serialize, Deserialize, TS)]
pub struct NoteFile {
    pub path: String,
    pub metadata: NoteMetadata,
    pub body: String,
    pub word_count: usize,
    pub char_count: usize,
    pub prop_count: usize,
}
```

---

## Notes vocales

Quand une transcription se termine, Alfred crée automatiquement un fichier `.md` dans `{vault}/Enregistrements/` :

- Nom du fichier : `YYYY-MM-DD HH-MM.md`
- `title` = date/heure formatée en français (ex: "Lundi 10 juin — 14:35")
- `recording_id` = UUID de l'enregistrement
- `type` = "meeting"
- Corps = texte de la transcription

Si le vault n'est pas configuré, la note n'est pas créée (skip silencieux avec log).

---

## Migration

Au démarrage de l'app, si le vault est configuré ET qu'il existe des notes SQLite non migrées (`migrated_at IS NULL`) :
- Exporter chaque note vers `{vault}/Legacy/{title}.md`
- Marquer `migrated_at = now()` dans SQLite
- La table `notes` reste en base (foreign keys `recording_id`) mais n'est plus utilisée pour de nouvelles notes

---

## Settings

Section "Notes" dans Settings → Paramètres :
- Label "Dossier Notes (vault)"
- Affichage du chemin courant (tronqué si trop long)
- Bouton "Choisir…" → `pick_vault_folder()` → ouvre le picker natif macOS
