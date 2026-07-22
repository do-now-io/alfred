//! Alfred agentique — outils d'action (spec/22). Au-delà de `search_notes`/
//! `read_note` (lecture), Claude peut désormais MUTER notes et tâches, en
//! réutilisant les mêmes commandes que l'UI (le vault Markdown reste la seule
//! source de vérité).
//!
//! **Règle d'or (décidée) : Alfred ne supprime jamais pour de vrai.** Toute
//! intention de « suppression » se traduit par un archivage réversible
//! (`status: archived` / section `## Archivé`) — `delete_note_file` et
//! `delete_starter_content` ne sont PAS exposés à Claude.
//!
//! Deux régimes :
//! - **Unitaires non risqués** (créer, éditer un champ, archiver UNE note/
//!   tâche…) : exécutés directement dans la boucle d'outils (`execute_unitary`)
//!   — Alfred rend compte du résultat dans sa réponse finale.
//! - **Lot ou écrasement** : jamais exécutés par la boucle elle-même —
//!   `build_proposal` résout les références et renvoie une `ProposedAction`
//!   que le front affiche en carte Appliquer/Annuler (esprit de `/resolve`,
//!   spec/17). L'exécution réelle passe par `apply_action`, appelée
//!   directement par le front sur confirmation — **sans repasser par Claude**
//!   (carte locale, pas de round-trip conversationnel).

use anyhow::{anyhow, Result};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sqlx::SqlitePool;
use std::path::{Path, PathBuf};
use ts_rs::TS;

use crate::notes::{self, vault};
use crate::todos;

/// Outils qui doivent être PROPOSÉS (carte de confirmation) plutôt qu'exécutés
/// directement — lots et écrasements (spec/22).
const CONFIRM_REQUIRED: &[&str] = &[
    "archive_notes_bulk",
    "unarchive_notes_bulk",
    "dismiss_tasks_bulk",
    "rewrite_note_body",
];

/// Outils unitaires, exécutés directement (non destructifs par construction :
/// pas de suppression dure, pas d'écrasement massif).
const UNITARY: &[&str] = &[
    "create_note",
    "append_to_note",
    "update_note_metadata",
    "archive_note",
    "unarchive_note",
    "rename_note",
    "create_task",
    "complete_task",
    "move_task",
    "update_task",
    "dismiss_task",
];

pub fn is_confirm_required(name: &str) -> bool {
    CONFIRM_REQUIRED.contains(&name)
}

pub fn is_unitary_agent_tool(name: &str) -> bool {
    UNITARY.contains(&name)
}

/// Proposition d'action en attente de confirmation utilisateur — jamais
/// exécutée par la boucle elle-même. `kind` distingue le type de mutation ;
/// seuls les champs pertinents pour ce `kind` sont renseignés.
#[derive(Debug, Serialize, Deserialize, Clone, TS)]
#[ts(export, export_to = "../../src/bindings/")]
pub struct ProposedAction {
    pub kind: String,
    pub summary: String,
    #[serde(default)]
    pub paths: Vec<String>,
    #[serde(default)]
    pub ids: Vec<String>,
    pub path: Option<String>,
    pub new_body: Option<String>,
}

// ─── Garde-fous chemins (spec/22) ───────────────────────────────────────────

/// Vérifie que `path` est bien À L'INTÉRIEUR de `root`, une fois les deux
/// canonicalisés — aucun outil d'action n'écrit hors du coffre, quelle que
/// soit la référence fournie par Claude.
fn ensure_inside_vault(root: &Path, path: &Path) -> Result<PathBuf> {
    let canon_root = root.canonicalize().map_err(|_| anyhow!("Coffre introuvable"))?;
    let canon_path = path.canonicalize().map_err(|_| anyhow!("Chemin introuvable"))?;
    if !canon_path.starts_with(&canon_root) {
        return Err(anyhow!("Chemin hors du coffre de notes"));
    }
    Ok(canon_path)
}

/// Résout une référence de note (chemin vault-relatif, nom de fichier ou
/// titre de frontmatter — même tolérance que `read_note`) vers un chemin
/// absolu GARANTI à l'intérieur du coffre.
pub fn resolve_note_path(root: &Path, note_ref: &str) -> Option<PathBuf> {
    let candidate = root.join(note_ref);
    if candidate.is_file()
        && candidate.extension().map(|x| x == "md").unwrap_or(false)
        && ensure_inside_vault(root, &candidate).is_ok()
    {
        return Some(candidate);
    }

    let is_md = |e: &walkdir::DirEntry| {
        e.file_type().is_file() && e.path().extension().map(|x| x == "md").unwrap_or(false)
    };

    let target = note_ref.trim().to_lowercase();
    for entry in walkdir::WalkDir::new(root).into_iter().filter_map(|e| e.ok()).filter(is_md).take(5000) {
        let stem = entry.path().file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
        if stem.to_lowercase() == target {
            return Some(entry.path().to_path_buf());
        }
    }
    for entry in walkdir::WalkDir::new(root).into_iter().filter_map(|e| e.ok()).filter(is_md).take(5000) {
        let stem = entry.path().file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
        if let Ok(content) = std::fs::read_to_string(entry.path()) {
            let (meta, _) = notes::frontmatter::parse(&content, &stem);
            if meta.title.to_lowercase() == target {
                return Some(entry.path().to_path_buf());
            }
        }
    }
    None
}

/// Résout une référence de tâche (titre, tolérant à la casse/aux accents —
/// même normalisation que le reste de l'app) vers son enregistrement complet.
async fn find_task(root: &Path, db: &SqlitePool, task_ref: &str) -> Option<todos::Todo> {
    let target = notes::todo_md::normalize_title(task_ref);
    let all = todos::get_all_todos(db, Some(root)).await.ok()?;
    all.into_iter().find(|t| t.id == target)
}

// ─── Outils exposés à Claude (spec/22) ──────────────────────────────────────

pub fn tool_defs(lang: &str) -> Vec<Value> {
    let en = lang == "en";
    vec![
        serde_json::json!({
            "name": "create_note",
            "description": if en { "Creates a new note (empty, or with an initial body) in the notes folder. Reversible: can be archived later, this tool never deletes." } else { "Crée une nouvelle note (vide, ou avec un corps initial) dans le dossier de notes. Réversible : elle pourra être archivée ensuite, cet outil ne supprime jamais." },
            "input_schema": {
                "type": "object",
                "properties": {
                    "title": { "type": "string", "description": if en { "Note title" } else { "Titre de la note" } },
                    "body": { "type": "string", "description": if en { "Optional initial body (Markdown)" } else { "Corps initial optionnel (Markdown)" } }
                },
                "required": ["title"]
            }
        }),
        serde_json::json!({
            "name": "append_to_note",
            "description": if en { "Appends text to the end of an existing note's body — a non-destructive addition, never a rewrite." } else { "Ajoute du texte à la fin du corps d'une note existante — un ajout non destructeur, jamais une réécriture." },
            "input_schema": {
                "type": "object",
                "properties": {
                    "note": { "type": "string", "description": if en { "Exact note title or path (as returned by search_notes)" } else { "Titre exact de la note ou son chemin (tel que renvoyé par search_notes)" } },
                    "text": { "type": "string", "description": if en { "Text to append" } else { "Texte à ajouter" } }
                },
                "required": ["note", "text"]
            }
        }),
        serde_json::json!({
            "name": "update_note_metadata",
            "description": if en { "Replaces a note's project/tags/participants — the body is left untouched. Omit a field to leave it unchanged." } else { "Remplace le projet/les tags/les participants d'une note — le corps n'est pas touché. Omettre un champ le laisse inchangé." },
            "input_schema": {
                "type": "object",
                "properties": {
                    "note": { "type": "string", "description": if en { "Exact note title or path" } else { "Titre exact de la note ou son chemin" } },
                    "project": { "type": "array", "items": { "type": "string" }, "description": if en { "Full replacement list of projects" } else { "Liste complète de remplacement des projets" } },
                    "tags": { "type": "array", "items": { "type": "string" }, "description": if en { "Full replacement list of tags" } else { "Liste complète de remplacement des tags" } },
                    "participants": { "type": "array", "items": { "type": "string" }, "description": if en { "Full replacement list of participants" } else { "Liste complète de remplacement des participants" } }
                },
                "required": ["note"]
            }
        }),
        serde_json::json!({
            "name": "archive_note",
            "description": if en { "Archives ONE note (reversible: status becomes \"archived\", nothing is deleted). Use archive_notes_bulk for several notes at once." } else { "Archive UNE note (réversible : le statut passe à « archived », rien n'est supprimé). Utilise archive_notes_bulk pour plusieurs notes à la fois." },
            "input_schema": {
                "type": "object",
                "properties": { "note": { "type": "string", "description": if en { "Exact note title or path" } else { "Titre exact de la note ou son chemin" } } },
                "required": ["note"]
            }
        }),
        serde_json::json!({
            "name": "unarchive_note",
            "description": if en { "Restores ONE archived note to active. Use unarchive_notes_bulk for several notes at once." } else { "Restaure UNE note archivée en note active. Utilise unarchive_notes_bulk pour plusieurs notes à la fois." },
            "input_schema": {
                "type": "object",
                "properties": { "note": { "type": "string", "description": if en { "Exact note title or path" } else { "Titre exact de la note ou son chemin" } } },
                "required": ["note"]
            }
        }),
        serde_json::json!({
            "name": "rename_note",
            "description": if en { "Renames a note (its title and filename)." } else { "Renomme une note (son titre et son nom de fichier)." },
            "input_schema": {
                "type": "object",
                "properties": {
                    "note": { "type": "string", "description": if en { "Exact note title or path" } else { "Titre exact de la note ou son chemin" } },
                    "new_name": { "type": "string", "description": if en { "New title" } else { "Nouveau titre" } }
                },
                "required": ["note", "new_name"]
            }
        }),
        serde_json::json!({
            "name": "create_task",
            "description": if en { "Creates a new task in the task list." } else { "Crée une nouvelle tâche dans la liste des tâches." },
            "input_schema": {
                "type": "object",
                "properties": {
                    "title": { "type": "string", "description": if en { "Task title" } else { "Titre de la tâche" } },
                    "responsable": { "type": "string", "description": if en { "First name of the person responsible, if any" } else { "Prénom du responsable, si connu" } },
                    "echeance": { "type": "string", "description": if en { "Due date, YYYY-MM-DD" } else { "Échéance, AAAA-MM-JJ" } },
                    "section": { "type": "string", "description": if en { "Target column: À faire / En cours / Fait (default: À faire)" } else { "Colonne cible : À faire / En cours / Fait (défaut : À faire)" } }
                },
                "required": ["title"]
            }
        }),
        serde_json::json!({
            "name": "complete_task",
            "description": if en { "Marks ONE task done (or not done). Moves it to the Fait column." } else { "Marque UNE tâche comme faite (ou non faite). La déplace vers la colonne Fait." },
            "input_schema": {
                "type": "object",
                "properties": {
                    "task": { "type": "string", "description": if en { "Exact task title" } else { "Titre exact de la tâche" } },
                    "checked": { "type": "boolean", "description": if en { "true = done (default), false = not done" } else { "true = faite (défaut), false = non faite" } }
                },
                "required": ["task"]
            }
        }),
        serde_json::json!({
            "name": "move_task",
            "description": if en { "Moves ONE task to another column (À faire / En cours / Fait / Archivé)." } else { "Déplace UNE tâche vers une autre colonne (À faire / En cours / Fait / Archivé)." },
            "input_schema": {
                "type": "object",
                "properties": {
                    "task": { "type": "string", "description": if en { "Exact task title" } else { "Titre exact de la tâche" } },
                    "section": { "type": "string", "description": if en { "Target column" } else { "Colonne cible" } }
                },
                "required": ["task", "section"]
            }
        }),
        serde_json::json!({
            "name": "update_task",
            "description": if en { "Edits ONE task's fields (title, responsable, due date, project, priority, estimate). Omit a field to leave it unchanged." } else { "Édite les champs d'UNE tâche (titre, responsable, échéance, projet, priorité, estimation). Omettre un champ le laisse inchangé." },
            "input_schema": {
                "type": "object",
                "properties": {
                    "task": { "type": "string", "description": if en { "Exact CURRENT task title" } else { "Titre EXACT actuel de la tâche" } },
                    "title": { "type": "string", "description": if en { "New title" } else { "Nouveau titre" } },
                    "responsable": { "type": "string" },
                    "echeance": { "type": "string", "description": if en { "YYYY-MM-DD" } else { "AAAA-MM-JJ" } },
                    "project": { "type": "string" },
                    "priority": { "type": "string", "description": if en { "haute / moyenne / basse" } else { "haute / moyenne / basse" } },
                    "estimate": { "type": "string", "description": if en { "Free text, e.g. 2h" } else { "Texte libre, ex. 2h" } }
                },
                "required": ["task"]
            }
        }),
        serde_json::json!({
            "name": "dismiss_task",
            "description": if en { "Archives ONE task (reversible: moved to the Archivé column, never deleted). Use dismiss_tasks_bulk for several tasks at once." } else { "Archive UNE tâche (réversible : déplacée vers la colonne Archivé, jamais supprimée). Utilise dismiss_tasks_bulk pour plusieurs tâches à la fois." },
            "input_schema": {
                "type": "object",
                "properties": { "task": { "type": "string", "description": if en { "Exact task title" } else { "Titre exact de la tâche" } } },
                "required": ["task"]
            }
        }),
        // ─── Lot / écrasement — jamais exécutés directement, toujours proposés ───
        serde_json::json!({
            "name": "archive_notes_bulk",
            "description": if en { "PROPOSES archiving SEVERAL notes at once (a confirmation card is shown to the user — this call never executes immediately). Use archive_note for a single note." } else { "PROPOSE d'archiver PLUSIEURS notes à la fois (une carte de confirmation est affichée à l'utilisateur — cet appel ne s'exécute jamais immédiatement). Utilise archive_note pour une seule note." },
            "input_schema": {
                "type": "object",
                "properties": { "notes": { "type": "array", "items": { "type": "string" }, "description": if en { "Exact titles or paths of the notes to archive" } else { "Titres exacts ou chemins des notes à archiver" } } },
                "required": ["notes"]
            }
        }),
        serde_json::json!({
            "name": "unarchive_notes_bulk",
            "description": if en { "PROPOSES restoring SEVERAL archived notes at once (confirmation card, never executes immediately)." } else { "PROPOSE de restaurer PLUSIEURS notes archivées à la fois (carte de confirmation, ne s'exécute jamais immédiatement)." },
            "input_schema": {
                "type": "object",
                "properties": { "notes": { "type": "array", "items": { "type": "string" }, "description": if en { "Exact titles or paths of the notes to restore" } else { "Titres exacts ou chemins des notes à restaurer" } } },
                "required": ["notes"]
            }
        }),
        serde_json::json!({
            "name": "dismiss_tasks_bulk",
            "description": if en { "PROPOSES archiving SEVERAL tasks at once (confirmation card, never executes immediately). Use dismiss_task for a single task." } else { "PROPOSE d'archiver PLUSIEURS tâches à la fois (carte de confirmation, ne s'exécute jamais immédiatement). Utilise dismiss_task pour une seule tâche." },
            "input_schema": {
                "type": "object",
                "properties": { "tasks": { "type": "array", "items": { "type": "string" }, "description": if en { "Exact titles of the tasks to archive" } else { "Titres exacts des tâches à archiver" } } },
                "required": ["tasks"]
            }
        }),
        serde_json::json!({
            "name": "rewrite_note_body",
            "description": if en { "PROPOSES completely rewriting a note's body (confirmation card, never executes immediately — this OVERWRITES existing content). For simple additions, use append_to_note instead (applied directly, no confirmation)." } else { "PROPOSE de réécrire ENTIÈREMENT le corps d'une note (carte de confirmation, ne s'exécute jamais immédiatement — ceci ÉCRASE le contenu existant). Pour un simple ajout, utilise plutôt append_to_note (appliqué directement, sans confirmation)." },
            "input_schema": {
                "type": "object",
                "properties": {
                    "note": { "type": "string", "description": if en { "Exact note title or path" } else { "Titre exact de la note ou son chemin" } },
                    "new_body": { "type": "string", "description": if en { "Full replacement body (Markdown)" } else { "Corps complet de remplacement (Markdown)" } }
                },
                "required": ["note", "new_body"]
            }
        }),
    ]
}

// ─── Exécution directe (unitaire, non confirmable) ──────────────────────────

/// Exécute un outil unitaire et renvoie le texte de résultat (destiné au
/// `tool_result` de la boucle Claude) — jamais d'erreur fatale : un échec
/// devient un message d'erreur que Claude peut lire et expliquer à
/// l'utilisateur. Émet `notes-updated`/`todos-updated` sur succès, pour que
/// les autres écrans (Notes/Tâches) se rafraîchissent (spec/22).
pub async fn execute_unitary(
    name: &str,
    input: &Value,
    root: &Path,
    db: &SqlitePool,
    app: &tauri::AppHandle,
    lang: &str,
) -> String {
    use tauri::Emitter;

    let result = execute_unitary_inner(name, input, root, db, lang).await;

    if result.is_ok() {
        let notes_touched = matches!(
            name,
            "create_note" | "append_to_note" | "update_note_metadata" | "archive_note" | "unarchive_note" | "rename_note"
        );
        let tasks_touched = matches!(name, "create_task" | "complete_task" | "move_task" | "update_task" | "dismiss_task");
        if notes_touched {
            let _ = app.emit("notes-updated", serde_json::json!({}));
        }
        if tasks_touched {
            let _ = app.emit("todos-updated", serde_json::json!({}));
        }
    }

    match result {
        Ok(text) => text,
        Err(e) => {
            if lang == "en" {
                format!("Action failed: {}", e)
            } else {
                format!("Échec de l'action : {}", e)
            }
        }
    }
}

async fn execute_unitary_inner(name: &str, input: &Value, root: &Path, db: &SqlitePool, lang: &str) -> Result<String> {
    let en = lang == "en";
    match name {
        "create_note" => {
            let title = input["title"].as_str().unwrap_or("").trim().to_string();
            if title.is_empty() {
                return Err(anyhow!(if en { "Missing title" } else { "Titre manquant" }));
            }
            let folder = root.join(super::intelligence_folder(db).await);
            let note = vault::create_note_file(&folder, &title).await?;
            if let Some(body) = input.get("body").and_then(|v| v.as_str()).filter(|s| !s.trim().is_empty()) {
                vault::update_note_file(Path::new(&note.path), note.metadata.clone(), body).await?;
            }
            Ok(if en { format!("Note created: \"{}\".", title) } else { format!("Note créée : « {} ».", title) })
        }
        "append_to_note" => {
            let note_ref = input["note"].as_str().unwrap_or("");
            let text = input["text"].as_str().unwrap_or("").trim();
            if text.is_empty() {
                return Err(anyhow!(if en { "Nothing to append" } else { "Rien à ajouter" }));
            }
            let path = resolve_note_path(root, note_ref)
                .ok_or_else(|| anyhow!(if en { "Note not found" } else { "Note introuvable" }))?;
            let note = vault::get_note_file(&path).await?;
            let title = note.metadata.title.clone();
            let new_body = if note.body.trim().is_empty() {
                text.to_string()
            } else {
                format!("{}\n\n{}", note.body.trim_end(), text)
            };
            vault::update_note_file(&path, note.metadata, &new_body).await?;
            Ok(if en { format!("Added to \"{}\".", title) } else { format!("Ajouté à « {} ».", title) })
        }
        "update_note_metadata" => {
            let note_ref = input["note"].as_str().unwrap_or("");
            let path = resolve_note_path(root, note_ref)
                .ok_or_else(|| anyhow!(if en { "Note not found" } else { "Note introuvable" }))?;
            let note = vault::get_note_file(&path).await?;
            let mut metadata = note.metadata;
            let title = metadata.title.clone();
            if let Some(arr) = input.get("project").and_then(|v| v.as_array()) {
                metadata.project = arr.iter().filter_map(|v| v.as_str().map(String::from)).collect();
            }
            if let Some(arr) = input.get("tags").and_then(|v| v.as_array()) {
                metadata.tags = arr.iter().filter_map(|v| v.as_str().map(String::from)).collect();
            }
            if let Some(arr) = input.get("participants").and_then(|v| v.as_array()) {
                metadata.participants = arr.iter().filter_map(|v| v.as_str().map(String::from)).collect();
            }
            vault::update_note_file(&path, metadata, &note.body).await?;
            Ok(if en { format!("Metadata updated for \"{}\".", title) } else { format!("Métadonnées mises à jour pour « {} ».", title) })
        }
        "archive_note" | "unarchive_note" => {
            let note_ref = input["note"].as_str().unwrap_or("");
            let path = resolve_note_path(root, note_ref)
                .ok_or_else(|| anyhow!(if en { "Note not found" } else { "Note introuvable" }))?;
            let note = vault::get_note_file(&path).await?;
            let title = note.metadata.title.clone();
            let target = if name == "archive_note" { vault::STATUS_ARCHIVED } else { "active" };
            if note.metadata.status == target {
                return Ok(if name == "archive_note" {
                    if en { format!("\"{}\" was already archived.", title) } else { format!("« {} » était déjà archivée.", title) }
                } else if en { format!("\"{}\" was already active.", title) } else { format!("« {} » était déjà active.", title) });
            }
            let mut metadata = note.metadata;
            metadata.status = target.to_string();
            vault::update_note_file(&path, metadata, &note.body).await?;
            Ok(if name == "archive_note" {
                if en { format!("\"{}\" archived.", title) } else { format!("« {} » archivée.", title) }
            } else if en { format!("\"{}\" restored.", title) } else { format!("« {} » restaurée.", title) })
        }
        "rename_note" => {
            let note_ref = input["note"].as_str().unwrap_or("");
            let new_name = input["new_name"].as_str().unwrap_or("").trim();
            if new_name.is_empty() {
                return Err(anyhow!(if en { "Missing new name" } else { "Nouveau nom manquant" }));
            }
            let path = resolve_note_path(root, note_ref)
                .ok_or_else(|| anyhow!(if en { "Note not found" } else { "Note introuvable" }))?;
            vault::rename_note_file(&path, new_name).await?;
            Ok(if en { format!("Note renamed to \"{}\".", new_name) } else { format!("Note renommée en « {} ».", new_name) })
        }
        "create_task" => {
            let title = input["title"].as_str().unwrap_or("").trim().to_string();
            if title.is_empty() {
                return Err(anyhow!(if en { "Missing title" } else { "Titre manquant" }));
            }
            let responsable = input.get("responsable").and_then(|v| v.as_str()).map(String::from);
            let echeance = input.get("echeance").and_then(|v| v.as_str()).map(String::from);
            let section = input.get("section").and_then(|v| v.as_str()).map(String::from);
            let created = todos::create_todo(
                &todos::CreateTodoInput { title: title.clone(), responsable, echeance, section },
                db,
                Some(root),
            )
            .await?;
            Ok(if en { format!("Task created: \"{}\".", created.title) } else { format!("Tâche créée : « {} ».", created.title) })
        }
        "complete_task" => {
            let task_ref = input["task"].as_str().unwrap_or("");
            let checked = input.get("checked").and_then(|v| v.as_bool()).unwrap_or(true);
            let task = find_task(root, db, task_ref)
                .await
                .ok_or_else(|| anyhow!(if en { "Task not found" } else { "Tâche introuvable" }))?;
            todos::set_todo_checked(&task.id, checked, db, Some(root)).await?;
            Ok(if en {
                format!("\"{}\" marked {}.", task.title, if checked { "done" } else { "not done" })
            } else {
                format!("« {} » marquée {}.", task.title, if checked { "faite" } else { "non faite" })
            })
        }
        "move_task" => {
            let task_ref = input["task"].as_str().unwrap_or("");
            let section = input["section"].as_str().unwrap_or("").trim();
            if section.is_empty() {
                return Err(anyhow!(if en { "Missing target section" } else { "Section cible manquante" }));
            }
            let task = find_task(root, db, task_ref)
                .await
                .ok_or_else(|| anyhow!(if en { "Task not found" } else { "Tâche introuvable" }))?;
            todos::move_todo(&task.id, section, None, db, Some(root)).await?;
            Ok(if en { format!("\"{}\" moved to {}.", task.title, section) } else { format!("« {} » déplacée vers {}.", task.title, section) })
        }
        "update_task" => {
            let task_ref = input["task"].as_str().unwrap_or("");
            let current = find_task(root, db, task_ref)
                .await
                .ok_or_else(|| anyhow!(if en { "Task not found" } else { "Tâche introuvable" }))?;
            let field = |key: &str, fallback: &Option<String>| -> Option<String> {
                input.get(key).and_then(|v| v.as_str()).map(String::from).or_else(|| fallback.clone())
            };
            let title = input.get("title").and_then(|v| v.as_str()).map(String::from).unwrap_or_else(|| current.title.clone());
            let patch = todos::TaskFieldsInput {
                title: title.clone(),
                responsable: field("responsable", &current.responsable),
                echeance: field("echeance", &current.echeance),
                project: field("project", &current.project),
                priority: field("priority", &current.priority),
                estimate: field("estimate", &current.estimate),
            };
            todos::update_todo_fields(&current.id, &patch, db, Some(root)).await?;
            Ok(if en { format!("\"{}\" updated.", title) } else { format!("« {} » mise à jour.", title) })
        }
        "dismiss_task" => {
            let task_ref = input["task"].as_str().unwrap_or("");
            let task = find_task(root, db, task_ref)
                .await
                .ok_or_else(|| anyhow!(if en { "Task not found" } else { "Tâche introuvable" }))?;
            todos::archive_todo(&task.id, db, Some(root)).await?;
            Ok(if en { format!("\"{}\" archived.", task.title) } else { format!("« {} » archivée.", task.title) })
        }
        other => Err(anyhow!(if en { format!("Unknown tool: {}", other) } else { format!("Outil inconnu : {}", other) })),
    }
}

// ─── Proposition (lot / écrasement) ─────────────────────────────────────────

/// Résout les références d'un outil « lot/écrasement » et construit la
/// `ProposedAction` correspondante — n'exécute AUCUNE mutation. Une erreur ici
/// (ex. aucune des notes référencées n'existe) est renvoyée comme un
/// `tool_result` d'erreur normal, pour que Claude puisse ajuster et réessayer.
pub async fn build_proposal(name: &str, input: &Value, root: &Path, db: &SqlitePool, lang: &str) -> Result<ProposedAction> {
    let en = lang == "en";
    match name {
        "archive_notes_bulk" | "unarchive_notes_bulk" => {
            let refs: Vec<String> = input["notes"]
                .as_array()
                .map(|a| a.iter().filter_map(|v| v.as_str().map(String::from)).collect())
                .unwrap_or_default();
            let mut paths = vec![];
            let mut titles = vec![];
            let mut missing = vec![];
            for r in &refs {
                match resolve_note_path(root, r) {
                    Some(p) => {
                        titles.push(p.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_default());
                        paths.push(p.to_string_lossy().to_string());
                    }
                    None => missing.push(r.clone()),
                }
            }
            if paths.is_empty() {
                return Err(anyhow!(if en { "None of the referenced notes were found." } else { "Aucune des notes référencées n'a été trouvée." }));
            }
            let archiving = name == "archive_notes_bulk";
            let verb = if en {
                if archiving { "Archive" } else { "Restore" }
            } else if archiving { "Archiver" } else { "Restaurer" };
            let noun = if paths.len() > 1 { if en { "notes" } else { "notes" } } else if en { "note" } else { "note" };
            let mut summary = format!("{} {} {} : {}", verb, paths.len(), noun, titles.join(", "));
            if !missing.is_empty() {
                let suffix = if en {
                    format!(" (not found: {})", missing.join(", "))
                } else {
                    format!(" (introuvables : {})", missing.join(", "))
                };
                summary.push_str(&suffix);
            }
            Ok(ProposedAction { kind: name.to_string(), summary, paths, ids: vec![], path: None, new_body: None })
        }
        "dismiss_tasks_bulk" => {
            let refs: Vec<String> = input["tasks"]
                .as_array()
                .map(|a| a.iter().filter_map(|v| v.as_str().map(String::from)).collect())
                .unwrap_or_default();
            let mut ids = vec![];
            let mut titles = vec![];
            let mut missing = vec![];
            for r in &refs {
                match find_task(root, db, r).await {
                    Some(t) => { titles.push(t.title.clone()); ids.push(t.id); }
                    None => missing.push(r.clone()),
                }
            }
            if ids.is_empty() {
                return Err(anyhow!(if en { "None of the referenced tasks were found." } else { "Aucune des tâches référencées n'a été trouvée." }));
            }
            let verb = if en { "Archive" } else { "Archiver" };
            let noun = if ids.len() > 1 { if en { "tasks" } else { "tâches" } } else if en { "task" } else { "tâche" };
            let mut summary = format!("{} {} {} : {}", verb, ids.len(), noun, titles.join(", "));
            if !missing.is_empty() {
                let suffix = if en {
                    format!(" (not found: {})", missing.join(", "))
                } else {
                    format!(" (introuvables : {})", missing.join(", "))
                };
                summary.push_str(&suffix);
            }
            Ok(ProposedAction { kind: name.to_string(), summary, paths: vec![], ids, path: None, new_body: None })
        }
        "rewrite_note_body" => {
            let note_ref = input["note"].as_str().unwrap_or("");
            let new_body = input["new_body"].as_str().unwrap_or("").to_string();
            let path = resolve_note_path(root, note_ref)
                .ok_or_else(|| anyhow!(if en { "Note not found" } else { "Note introuvable" }))?;
            let title = path.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
            let summary = if en {
                format!("Rewrite the entire body of \"{}\"", title)
            } else {
                format!("Réécrire entièrement le corps de « {} »", title)
            };
            Ok(ProposedAction {
                kind: name.to_string(),
                summary,
                paths: vec![],
                ids: vec![],
                path: Some(path.to_string_lossy().to_string()),
                new_body: Some(new_body),
            })
        }
        other => Err(anyhow!("Outil de confirmation inconnu : {}", other)),
    }
}

/// Applique réellement une action déjà proposée + confirmée par l'utilisateur
/// — appelée directement par le front (`confirm_agent_action`), SANS repasser
/// par Claude (carte locale, cf. `/resolve`). Revalide le confinement vault de
/// chaque chemin (défense en profondeur, même si `build_proposal` l'a déjà
/// garanti). Retourne le nombre d'éléments effectivement modifiés.
pub async fn apply_action(action: &ProposedAction, root: &Path, db: &SqlitePool) -> Result<usize> {
    match action.kind.as_str() {
        "archive_notes_bulk" | "unarchive_notes_bulk" => {
            let target = if action.kind == "archive_notes_bulk" { vault::STATUS_ARCHIVED } else { "active" };
            let mut count = 0;
            for p in &action.paths {
                let path = Path::new(p);
                if ensure_inside_vault(root, path).is_err() {
                    continue;
                }
                if let Ok(note) = vault::get_note_file(path).await {
                    if note.metadata.status == target {
                        count += 1;
                        continue;
                    }
                    let mut metadata = note.metadata;
                    metadata.status = target.to_string();
                    if vault::update_note_file(path, metadata, &note.body).await.is_ok() {
                        count += 1;
                    }
                }
            }
            Ok(count)
        }
        "dismiss_tasks_bulk" => {
            let mut count = 0;
            for id in &action.ids {
                if todos::archive_todo(id, db, Some(root)).await.is_ok() {
                    count += 1;
                }
            }
            Ok(count)
        }
        "rewrite_note_body" => {
            let path_str = action.path.as_deref().ok_or_else(|| anyhow!("Chemin manquant"))?;
            let path = Path::new(path_str);
            ensure_inside_vault(root, path)?;
            let note = vault::get_note_file(path).await?;
            let new_body = action.new_body.as_deref().unwrap_or("");
            vault::update_note_file(path, note.metadata, new_body).await?;
            Ok(1)
        }
        other => Err(anyhow!("Action inconnue : {}", other)),
    }
}
