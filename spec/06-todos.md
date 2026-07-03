# spec/06 — Todos

---

## Sources

Tout todo a une source tracée. L'attribut `source_id` lie le todo à son origine :

| `source` | `source_id` pointe vers |
|---|---|
| `transcription` | `transcriptions.id` |
| `suggestion` | `suggestions.id` |
| `manual` | NULL |

---

## Déduplication

Avant chaque insertion d'un todo issu d'une transcription ou suggestion, vérifier l'unicité par `(source, source_id, title_hash)` :

```sql
SELECT id FROM todos
WHERE source = ? AND source_id = ? AND title_hash = ?
LIMIT 1;
```

`title_hash` = SHA-256 du titre en minuscules, sans espaces en tête/fin (32 chars hex).

Si le record existe déjà (peu importe son status), ne pas insérer de doublon. Si l'utilisateur a dismissé un todo et que la même transcription est re-traitée, le doublon n'est pas recréé.

---

## Cycle de vie

```
pending ──── complete() ──► done
   │
   └───────── dismiss() ──► dismissed
```

- `done` : la tâche est accomplie
- `dismissed` : l'utilisateur ne veut plus voir ce todo (suppression douce)
- Aucun des deux états n'est définitif — un todo peut être rouvert :
  - `done` → `pending` via `reopen_todo`
  - `dismissed` → non (un todo dismissé reste dismissé — pas de "unarchive" en v1)

---

## Filtres d'affichage

La liste principale affiche uniquement `status = pending`.

Les todos `done` sont accessibles via un filtre "Complétés" dans l'interface.
Les todos `dismissed` ne sont pas affichés (seulement accessibles via DB pour audit).

---

## Tri

Par défaut : `due_date ASC NULLS LAST, created_at ASC`.

Les todos sans due_date apparaissent après ceux avec une date.

---

## Commandes Tauri

```rust
#[tauri::command]
async fn list_todos(
    filter: TodoFilter,  // { status: "pending" | "done" | "all" }
    state: State<AppState>,
) -> Result<Vec<Todo>, String>

#[tauri::command]
async fn create_todo(
    input: CreateTodoInput,
    // { title, description?, due_date?, source: "manual" }
    state: State<AppState>,
) -> Result<Todo, String>

#[tauri::command]
async fn update_todo(
    id: String,
    patch: TodoPatch,
    // { title?, description?, due_date? }
    state: State<AppState>,
) -> Result<Todo, String>

#[tauri::command]
async fn complete_todo(id: String, state: State<AppState>) -> Result<Todo, String>

#[tauri::command]
async fn reopen_todo(id: String, state: State<AppState>) -> Result<Todo, String>

#[tauri::command]
async fn dismiss_todo(id: String, state: State<AppState>) -> Result<Todo, String>
```

---

## Struct Rust exposée au frontend

```rust
#[derive(Serialize, Deserialize, TS)]
#[ts(export, export_to = "../src/bindings/")]
pub struct Todo {
    pub id: String,
    pub title: String,
    pub description: Option<String>,
    pub source: String,
    pub source_id: Option<String>,
    pub status: String,
    pub due_date: Option<String>,  // YYYY-MM-DD
    pub created_at: String,
    pub updated_at: String,
}
```
