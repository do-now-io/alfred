//! Persistance des clarifications en attente, par `recording_id` (spec/17 §3,
//! spec/07, feedback tests) — jusqu'ici l'analyse (coût Claude payé) ne vivait
//! que dans un event + le `resolveStore` front, une seule place en mémoire :
//! écrasée par un 2e enregistrement enchaîné, perdue au redémarrage. Une ligne
//! ici = une analyse déjà faite, en attente du « Valider » ; supprimée dès la
//! finalisation.

use anyhow::Result;
use serde::Serialize;
use sqlx::SqlitePool;
use ts_rs::TS;

use super::Clarifications;

/// Ce que le front reçoit pour rouvrir `/resolve` SANS relancer `analyze_transcription`
/// (le bouton « Vérifier / corriger » reste le seul chemin qui relance une analyse).
#[derive(Debug, Serialize, Clone, TS)]
#[ts(export, export_to = "../../src/bindings/")]
pub struct PendingClarification {
    pub recording_id: String,
    pub note_title: String,
    pub text: String,
    pub clarifications: Clarifications,
    pub summary: bool,
    pub tasks: bool,
}

/// Persiste (ou remplace, si un « Vérifier / corriger » a relancé l'analyse) la
/// vérification en attente pour ce `recording_id`.
pub async fn save(
    db: &SqlitePool,
    recording_id: &str,
    note_title: &str,
    text: &str,
    clarifications: &Clarifications,
    summary: bool,
    tasks: bool,
) -> Result<()> {
    let clarifications_json = serde_json::to_string(clarifications)?;
    let now = chrono::Utc::now().to_rfc3339();
    sqlx::query(
        "INSERT INTO pending_clarifications (recording_id, note_title, text, clarifications_json, summary, tasks, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(recording_id) DO UPDATE SET
            note_title = excluded.note_title,
            text = excluded.text,
            clarifications_json = excluded.clarifications_json,
            summary = excluded.summary,
            tasks = excluded.tasks,
            created_at = excluded.created_at",
    )
    .bind(recording_id)
    .bind(note_title)
    .bind(text)
    .bind(&clarifications_json)
    .bind(summary)
    .bind(tasks)
    .bind(&now)
    .execute(db)
    .await?;
    Ok(())
}

/// La vérification persistée pour cette note, si elle est encore en attente.
pub async fn get(db: &SqlitePool, recording_id: &str) -> Result<Option<PendingClarification>> {
    let row: Option<(String, String, String, bool, bool)> = sqlx::query_as(
        "SELECT note_title, text, clarifications_json, summary, tasks FROM pending_clarifications WHERE recording_id = ?",
    )
    .bind(recording_id)
    .fetch_optional(db)
    .await?;

    Ok(match row {
        Some((note_title, text, clarifications_json, summary, tasks)) => Some(PendingClarification {
            recording_id: recording_id.to_string(),
            note_title,
            text,
            clarifications: serde_json::from_str(&clarifications_json).unwrap_or_default(),
            summary,
            tasks,
        }),
        None => None,
    })
}

/// Tous les `recording_id` en attente — pour l'indicateur « à vérifier » sur la
/// note (arbre + Récents, spec/07) : le front croise cette liste avec le
/// `recording_id` de chaque note.
pub async fn list_recording_ids(db: &SqlitePool) -> Result<Vec<String>> {
    let rows: Vec<(String,)> = sqlx::query_as("SELECT recording_id FROM pending_clarifications")
        .fetch_all(db)
        .await?;
    Ok(rows.into_iter().map(|(id,)| id).collect())
}

/// Supprime la vérification en attente — appelé après une finalisation réussie
/// (`finalize_ingestion`), best-effort : ne doit jamais faire échouer la
/// finalisation elle-même.
pub async fn delete(db: &SqlitePool, recording_id: &str) -> Result<()> {
    sqlx::query("DELETE FROM pending_clarifications WHERE recording_id = ?")
        .bind(recording_id)
        .execute(db)
        .await?;
    Ok(())
}
