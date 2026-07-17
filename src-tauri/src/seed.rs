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

/// La checklist de démarrage : (section, titre, responsable, cochée).
/// Démontre les interactions de l'écran Tâches (spec/06) : favori = section
/// Prioritaire, statut = section, `- [x]` = fait, `@Prénom` = assignation.
const SEED_TASKS: &[(&str, &str, Option<&str>, bool)] = &[
    ("Prioritaire", "Faire le tour d'Alfred", Some("Vous"), false),
    ("En cours", "Faire un premier enregistrement", None, false),
    ("À faire", "Vérifier / compléter mon contexte", None, false),
    ("À faire", "Inviter un collègue à écouter un compte-rendu", Some("Marie"), false),
    ("À faire", "Découvrir l'application", None, true),
];

const DEMO_NOTE_1_TITLE: &str = "Exemple — Point projet Horloge";
const DEMO_NOTE_1_BODY: &str = "> *Note d'exemple créée par Alfred — supprimez-la quand vous voulez.*\n\nCompte-rendu type d'un point d'équipe sur le projet **Horloge**.\n\n## Points clés\n- Le prototype est validé, on passe à la phase de test utilisateur.\n- Marie présente les maquettes finales jeudi.\n- Tom corrige le bug d'affichage avant la démo.\n\n## Décisions\n- Lancement du pilote la semaine prochaine.\n";

const DEMO_NOTE_2_TITLE: &str = "Exemple — Appel client Dupont";
const DEMO_NOTE_2_BODY: &str = "> *Note d'exemple créée par Alfred — supprimez-la quand vous voulez.*\n\nCompte-rendu type d'un appel avec le client **Dupont** sur le projet **Horloge**.\n\n## Points clés\n- Le client veut une livraison en deux lots.\n- Marie envoie le planning révisé.\n\n## Décisions\n- Prochain point dans deux semaines.\n";

const DEMO_CHAT_QUESTION: &str = "Résume ma dernière réunion";
const DEMO_CHAT_ANSWER: &str = "Voici un exemple de ce que je sais faire : après chaque enregistrement, je rédige un compte-rendu et j'en extrais les tâches. Posez-moi une question sur vos notes — par exemple « Que sais-tu de mon équipe et de mes projets ? » — et je réponds en citant mes sources. *(Conversation d'exemple — supprimez-la quand vous voulez.)*";

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

    // 1. Tâches — checklist de prise en main dans les bonnes sections.
    {
        let todo_rel = crate::todos::todo_file_path(db).await;
        let path = vault_root.join(&todo_rel);
        if let Some(parent) = path.parent() {
            tokio::fs::create_dir_all(parent).await?;
        }
        let existing = tokio::fs::read_to_string(&path).await.ok();
        // Squelette de sections garanti par merge_tasks (aucune tâche ajoutée ici).
        let (mut content, _) = crate::notes::todo_md::merge_tasks(existing.as_deref(), &[]);
        for (section, titre, responsable, checked) in SEED_TASKS {
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
            (DEMO_NOTE_1_TITLE, DEMO_NOTE_1_BODY, vec!["Marie".to_string(), "Tom".to_string()]),
            (DEMO_NOTE_2_TITLE, DEMO_NOTE_2_BODY, vec!["Marie".to_string(), "M. Dupont".to_string()]),
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
            if let Err(e) = crate::notes::vault::create_intelligence_note(&folder, title, metadata, body).await {
                eprintln!("[seed] demo note '{}' failed: {}", title, e);
            }
        }
    }

    // 3. Chat — une fausse conversation passée dans l'historique (spec/07b/13).
    if let Err(e) = crate::ai::chat_history::record_exchange(
        db,
        None,
        DEMO_CHAT_QUESTION,
        DEMO_CHAT_ANSWER,
        &[],
    )
    .await
    {
        eprintln!("[seed] demo chat conversation failed: {}", e);
    }

    sqlx::query("INSERT OR REPLACE INTO config (key, value) VALUES (?, 'true')")
        .bind(SEED_FLAG)
        .execute(db)
        .await?;
    eprintln!("[seed] starter content seeded");
    Ok(())
}
