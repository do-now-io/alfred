//! Contenu de démarrage (spec/13) — semé à l'onboarding pour que la visite
//! guidée (et l'arrivée hors visite) ait de la matière : une checklist de prise
//! en main dans `Todo.md`, deux notes de démo (frontmatter `project` +
//! `participants` → vue Projets + graphe), et une fausse conversation dans
//! l'historique du chat.
//!
//! Semis **unique et idempotent** : gardé par le flag config
//! `starter_content_seeded`. Si l'utilisateur supprime le contenu, il ne
//! revient jamais.

use anyhow::Result;
use sqlx::SqlitePool;
use std::path::Path;

const SEED_FLAG: &str = "starter_content_seeded";
/// Config key holding the id of the demo chat conversation (spec/13), so
/// `delete_starter_content` can drop exactly that one via
/// `chat_history::delete_conversation` without any language-dependent matching.
const SEED_CHAT_CONV_KEY: &str = "starter_content_chat_conversation_id";
/// Raw frontmatter marker on demo notes (spec/13) — written directly into the
/// file (not through `NoteMetadata`, to avoid widening that struct for a
/// throwaway flag); the parser's unknown-key catch-all just ignores it, and
/// `delete_starter_content` scans for it as plain text.
const SEED_NOTE_MARKER: &str = "alfred_seed: true";

/// Contenu de démarrage par langue (spec/13/21) — le squelette de Todo.md
/// (`merge_tasks`) reste écrit avec les en-têtes FR internes quel que soit
/// `app_language` (voir `todo_md.rs`), donc `section` ici reste le libellé FR
/// stable ; seul le TEXTE (titres de tâches, notes de démo, chat) est localisé.
struct SeedContent {
    /// (section FR stable, titre, responsable, cochée) — spec/06.
    tasks: &'static [(&'static str, &'static str, Option<&'static str>, bool)],
    demo_note_1_title: &'static str,
    demo_note_1_body: &'static str,
    demo_note_2_title: &'static str,
    demo_note_2_body: &'static str,
    demo_chat_question: &'static str,
    demo_chat_answer: &'static str,
}

const SEED_FR: SeedContent = SeedContent {
    tasks: &[
        ("À faire", "Faire le tour d'Alfred", Some("Vous"), false),
        ("En cours", "Faire un premier enregistrement", None, false),
        ("À faire", "Vérifier / compléter mon contexte", None, false),
        ("À faire", "Inviter un collègue à écouter un compte-rendu", Some("Marie"), false),
        ("Fait", "Découvrir l'application", None, true),
    ],
    demo_note_1_title: "Exemple — Point projet Horloge",
    demo_note_1_body: "> *Note d'exemple créée par Alfred — supprimez-la quand vous voulez.*\n\nCompte-rendu type d'un point d'équipe sur le projet **Horloge**.\n\n## Points clés\n- Le prototype est validé, on passe à la phase de test utilisateur.\n- Marie présente les maquettes finales jeudi.\n- Tom corrige le bug d'affichage avant la démo.\n\n## Décisions\n- Lancement du pilote la semaine prochaine.\n",
    demo_note_2_title: "Exemple — Appel client Dupont",
    demo_note_2_body: "> *Note d'exemple créée par Alfred — supprimez-la quand vous voulez.*\n\nCompte-rendu type d'un appel avec le client **Dupont** sur le projet **Horloge**.\n\n## Points clés\n- Le client veut une livraison en deux lots.\n- Marie envoie le planning révisé.\n\n## Décisions\n- Prochain point dans deux semaines.\n",
    demo_chat_question: "Résume ma dernière réunion",
    demo_chat_answer: "Voici un exemple de ce que je sais faire : après chaque enregistrement, je rédige un compte-rendu et j'en extrais les tâches. Posez-moi une question sur vos notes — par exemple « Que sais-tu de mon équipe et de mes projets ? » — et je réponds en citant mes sources. *(Conversation d'exemple — supprimez-la quand vous voulez.)*",
};

const SEED_EN: SeedContent = SeedContent {
    // La section reste le libellé FR interne stable (voir commentaire ci-dessus).
    tasks: &[
        ("À faire", "Take the Alfred tour", Some("You"), false),
        ("En cours", "Make your first recording", None, false),
        ("À faire", "Check / complete my context", None, false),
        ("À faire", "Invite a colleague to listen to a summary", Some("Marie"), false),
        ("Fait", "Discover the app", None, true),
    ],
    demo_note_1_title: "Example — Clock project update",
    demo_note_1_body: "> *Example note created by Alfred — delete it whenever you like.*\n\nTypical summary of a team check-in on the **Clock** project.\n\n## Key points\n- The prototype is validated, moving on to user testing.\n- Marie presents the final mockups on Thursday.\n- Tom fixes the display bug before the demo.\n\n## Decisions\n- Pilot launch next week.\n",
    demo_note_2_title: "Example — Dupont client call",
    demo_note_2_body: "> *Example note created by Alfred — delete it whenever you like.*\n\nTypical summary of a call with client **Dupont** on the **Clock** project.\n\n## Key points\n- The client wants delivery split into two batches.\n- Marie sends the revised schedule.\n\n## Decisions\n- Next check-in in two weeks.\n",
    demo_chat_question: "Summarize my last meeting",
    demo_chat_answer: "Here's an example of what I can do: after every recording, I write a summary and pull out the tasks. Ask me a question about your notes — for example \"What do you know about my team and my projects?\" — and I'll answer citing my sources. *(Example conversation — delete it whenever you like.)*",
};

fn seed_content(lang: &str) -> &'static SeedContent {
    if lang == "en" { &SEED_EN } else { &SEED_FR }
}

/// Titles of every seeded demo task, in **both** languages — a Todo.md file
/// keeps whichever language it was written in regardless of the current
/// `app_language`, so matching against just one language would miss the
/// other after a language switch.
fn seed_task_titles() -> Vec<&'static str> {
    SEED_FR.tasks.iter().chain(SEED_EN.tasks.iter()).map(|(_, title, _, _)| *title).collect()
}

/// Demo notes still carrying the `alfred_seed` marker, under `folder`.
async fn find_seed_marked_notes(folder: std::path::PathBuf) -> Vec<std::path::PathBuf> {
    tokio::task::spawn_blocking(move || {
        walkdir::WalkDir::new(&folder)
            .into_iter()
            .filter_map(|e| e.ok())
            .filter(|e| {
                e.file_type().is_file()
                    && e.path().extension().map(|x| x == "md").unwrap_or(false)
            })
            .filter(|e| {
                std::fs::read_to_string(e.path())
                    .map(|c| c.contains(SEED_NOTE_MARKER))
                    .unwrap_or(false)
            })
            .map(|e| e.path().to_path_buf())
            .collect()
    })
    .await
    .unwrap_or_default()
}

/// Rend une ligne de tâche au format de `Todo.md` (spec/06).
fn task_line(titre: &str, responsable: Option<&str>, checked: bool) -> String {
    let mut line = format!("- [{}] {}", if checked { "x" } else { " " }, titre);
    if let Some(r) = responsable {
        line.push_str(&format!(" — @{}", r));
    }
    line
}

/// Insère `line` juste après l'en-tête `## section` (créé par le squelette).
fn insert_in_section(content: &str, section: &str, line: &str) -> String {
    let heading = format!("## {}", section);
    let mut out = String::new();
    let mut inserted = false;
    for l in content.lines() {
        out.push_str(l);
        out.push('\n');
        if !inserted && l.trim() == heading {
            out.push_str(line);
            out.push('\n');
            inserted = true;
        }
    }
    if !inserted {
        out.push_str(&format!("\n{}\n{}\n", heading, line));
    }
    out
}

/// Sème le contenu de démarrage (idempotent, gardé — spec/13). Sans effet si le
/// flag est déjà posé ou si le vault n'est pas configuré.
pub async fn seed_starter_content(db: &SqlitePool, vault_root: Option<&Path>) -> Result<()> {
    let already: Option<String> = sqlx::query_scalar("SELECT value FROM config WHERE key = ?")
        .bind(SEED_FLAG)
        .fetch_optional(db)
        .await
        .ok()
        .flatten();
    if already.as_deref() == Some("true") {
        return Ok(());
    }
    let Some(vault_root) = vault_root else {
        // Pas de vault → rien à semer ; on ne pose PAS le flag pour retenter
        // quand le vault sera configuré.
        return Ok(());
    };

    // Contenu localisé (spec/21) — `app_language` (défaut `fr`).
    let lang: String = sqlx::query_scalar("SELECT value FROM config WHERE key = 'app_language'")
        .fetch_optional(db)
        .await
        .ok()
        .flatten()
        .unwrap_or_else(|| "fr".to_string());
    let seed = seed_content(&lang);

    // 1. Tâches — checklist de prise en main dans les bonnes sections.
    {
        let todo_rel = crate::todos::todo_file_path(db).await;
        let path = vault_root.join(&todo_rel);
        if let Some(parent) = path.parent() {
            tokio::fs::create_dir_all(parent).await?;
        }
        let existing = tokio::fs::read_to_string(&path).await.ok();
        // Squelette de sections garanti par merge_tasks (aucune tâche ajoutée ici).
        let (mut content, _) = crate::notes::todo_md::merge_tasks(existing.as_deref(), &[], None);
        for (section, titre, responsable, checked) in seed.tasks {
            let norm = crate::notes::todo_md::normalize_title(titre);
            if content
                .lines()
                .any(|l| l.contains(&*norm) || l.contains(titre))
            {
                continue;
            }
            content = insert_in_section(&content, section, &task_line(titre, *responsable, *checked));
        }
        tokio::fs::write(&path, content).await?;
    }

    // 2. Notes de démo — frontmatter project + participants pour peupler la vue
    //    Projets et le graphe (participants/projet partagés → liens).
    {
        let folder = vault_root.join(crate::ai::intelligence_folder(db).await);
        let notes = [
            (seed.demo_note_1_title, seed.demo_note_1_body, vec!["Marie".to_string(), "Tom".to_string()]),
            (seed.demo_note_2_title, seed.demo_note_2_body, vec!["Marie".to_string(), "M. Dupont".to_string()]),
        ];
        for (title, body, participants) in notes {
            let file = folder.join(format!("{}.md", title));
            if file.exists() {
                continue;
            }
            let metadata = crate::notes::NoteMetadata::for_meeting_report(
                title,
                None,
                participants,
                vec!["Projet Horloge (exemple)".to_string()],
            );
            match crate::notes::vault::create_intelligence_note(&folder, title, metadata, body).await {
                Ok(note) => {
                    // Marque le fichier `alfred_seed: true` (frontmatter brut,
                    // ignoré par le parser) pour un ciblage sûr par
                    // `delete_starter_content`, même si la note est déplacée
                    // ou renommée.
                    if let Ok(raw) = tokio::fs::read_to_string(&note.path).await {
                        let marked = raw.replacen("---\n\n", &format!("{}\n---\n\n", SEED_NOTE_MARKER), 1);
                        let _ = tokio::fs::write(&note.path, marked).await;
                    }
                }
                Err(e) => eprintln!("[seed] demo note '{}' failed: {}", title, e),
            }
        }
    }

    // 3. Chat — une fausse conversation passée dans l'historique (spec/07b/13).
    //    L'id est retenu en config : cible exacte pour `delete_starter_content`,
    //    indépendante de la langue dans laquelle la conversation a été semée.
    match crate::ai::chat_history::record_exchange(
        db,
        None,
        seed.demo_chat_question,
        seed.demo_chat_answer,
        &[],
    )
    .await
    {
        Ok(conv_id) => {
            let _ = sqlx::query("INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)")
                .bind(SEED_CHAT_CONV_KEY)
                .bind(conv_id)
                .execute(db)
                .await;
        }
        Err(e) => eprintln!("[seed] demo chat conversation failed: {}", e),
    }

    sqlx::query("INSERT OR REPLACE INTO config (key, value) VALUES (?, 'true')")
        .bind(SEED_FLAG)
        .execute(db)
        .await?;
    eprintln!("[seed] starter content seeded");
    Ok(())
}

/// Reste-t-il du contenu de démarrage (spec/13) ? Vérifié **en direct** sur les
/// 3 sources (tâches / notes / chat) plutôt que via un drapeau figé au semis :
/// couvre aussi bien le clic sur « Supprimer » que la suppression manuelle
/// (note effacée à la main, tâche supprimée dans `Todo.md`…).
pub async fn has_starter_content(db: &SqlitePool, vault_root: Option<&Path>) -> bool {
    let Some(vault_root) = vault_root else { return false };

    let todo_rel = crate::todos::todo_file_path(db).await;
    if let Ok(content) = tokio::fs::read_to_string(vault_root.join(&todo_rel)).await {
        let titles = seed_task_titles();
        if content
            .lines()
            .any(|l| l.trim_start().starts_with("- [") && titles.iter().any(|t| l.contains(*t)))
        {
            return true;
        }
    }

    let folder = vault_root.join(crate::ai::intelligence_folder(db).await);
    if !find_seed_marked_notes(folder).await.is_empty() {
        return true;
    }

    let chat_id: Option<String> = sqlx::query_scalar("SELECT value FROM config WHERE key = ?")
        .bind(SEED_CHAT_CONV_KEY)
        .fetch_optional(db)
        .await
        .ok()
        .flatten();
    if let Some(id) = chat_id {
        let exists: Option<i64> = sqlx::query_scalar("SELECT 1 FROM chat_conversations WHERE id = ?")
            .bind(&id)
            .fetch_optional(db)
            .await
            .ok()
            .flatten();
        if exists.is_some() {
            return true;
        }
    }

    false
}

/// Supprime **uniquement** le contenu de démarrage marqué (spec/13) : les
/// lignes de tâches semées dans `Todo.md`, les notes de démo (frontmatter
/// `alfred_seed: true`), la conversation de démo. Ne touche à rien d'autre.
/// Bouton one-shot côté UI — la commande elle-même reste sans effet si rien
/// n'est (plus) marqué, donc rejouable sans risque.
pub async fn delete_starter_content(db: &SqlitePool, vault_root: Option<&Path>) -> Result<()> {
    let Some(vault_root) = vault_root else { return Ok(()) };

    // 1. Tâches — retire toute ligne de case à cocher dont le texte contient
    //    un des titres semés (les deux langues : le fichier garde la langue
    //    dans laquelle il a été écrit, indépendamment de `app_language`
    //    aujourd'hui).
    {
        let todo_rel = crate::todos::todo_file_path(db).await;
        let path = vault_root.join(&todo_rel);
        if let Ok(content) = tokio::fs::read_to_string(&path).await {
            let titles = seed_task_titles();
            let filtered: String = content
                .lines()
                .filter(|l| {
                    let is_task = l.trim_start().starts_with("- [");
                    !(is_task && titles.iter().any(|t| l.contains(*t)))
                })
                .collect::<Vec<_>>()
                .join("\n");
            if filtered != content {
                tokio::fs::write(&path, filtered).await?;
            }
        }
    }

    // 2. Notes — supprime tout fichier marqué `alfred_seed: true`.
    {
        let folder = vault_root.join(crate::ai::intelligence_folder(db).await);
        for path in find_seed_marked_notes(folder).await {
            let _ = tokio::fs::remove_file(&path).await;
        }
    }

    // 3. Chat — supprime la conversation de démo, si elle existe encore.
    {
        let chat_id: Option<String> = sqlx::query_scalar("SELECT value FROM config WHERE key = ?")
            .bind(SEED_CHAT_CONV_KEY)
            .fetch_optional(db)
            .await
            .ok()
            .flatten();
        if let Some(id) = chat_id {
            let _ = crate::ai::chat_history::delete_conversation(db, &id).await;
        }
    }

    Ok(())
}
