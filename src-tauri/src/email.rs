//! Connexion e-mails (spec/24) — IMAP générique uniquement, fenêtre glissante,
//! extraction de tâches + contexte par batch Claude. Les mails ne deviennent
//! JAMAIS des notes du vault (décision explicite spec/24) : la provenance des
//! tâches extraites est un texte non cliquable (`✉️ <objet> (<date>)`,
//! `notes::todo_md`), pas le wikilink habituel des comptes-rendus.
//!
//! Tout est automatique (spec/24) : pas de `/resolve`, pas de pré-filtre par
//! mots-clés/expéditeur avant l'appel IA — le tri se fait dans l'appel Claude.

use anyhow::{anyhow, Result};
use futures::StreamExt;
use serde::{Deserialize, Serialize};
use sqlx::SqlitePool;
use std::collections::HashSet;
use std::fmt;
use std::path::Path;
use std::pin::Pin;
use std::task::{Context, Poll};
use tokio::io::{AsyncRead, AsyncWrite, ReadBuf};
use tokio::net::TcpStream;
use ts_rs::TS;

use crate::ai::{self, ContextAddition, EmailInput};
use crate::keychain;
use crate::notes::todo_md::{self, IngestTask};

/// Défaut proposé (spec/24 §2) — pas de scan rétroactif de tout l'historique.
const DEFAULT_WINDOW_DAYS: i64 = 14;
/// Fenêtre de recherche du chat (spec/24 §6) — distincte de la fenêtre
/// d'extraction (`DEFAULT_WINDOW_DAYS`, 14j) : une question posée en chat peut
/// légitimement viser un mail plus ancien que l'extraction automatique.
const DEFAULT_SEARCH_WINDOW_DAYS: i64 = 90;
/// Nombre de résultats renvoyés par `search_emails` (spec/24 §6) — même ordre
/// de grandeur que `search_notes` (`chat.rs::SEARCH_RESULTS`).
const SEARCH_RESULTS: usize = 8;
const SEARCH_SNIPPET_CHARS: usize = 240;
/// Taille de batch par défaut (spec/24 §4) — même ordre de grandeur que les
/// autres budgets IA du code (glossaire/contexte par projet, `ai/mod.rs`,
/// ~8000 caractères d'historique). Choix pragmatique pour cette v1, à ajuster
/// en test si un batch se révèle trop coûteux ou trop gros pour le modèle.
const BATCH_SIZE: usize = 15;
/// Un mail-tartine ne doit pas à lui seul épuiser le budget du batch — au-delà,
/// le corps est tronqué (le début d'un mail porte presque toujours l'essentiel).
const MAX_BODY_CHARS: usize = 4_000;

#[derive(Debug, Serialize, Deserialize, Clone, TS)]
#[ts(export, export_to = "../../src/bindings/")]
pub struct ImapStatus {
    pub connected: bool,
    pub last_synced_at: Option<String>,
}

struct ImapCreds {
    host: String,
    port: u16,
    username: String,
    password: String,
    use_ssl: bool,
}

fn load_creds() -> Result<Option<ImapCreds>> {
    let host = keychain::get_secret("imap_host")?.filter(|s| !s.trim().is_empty());
    let username = keychain::get_secret("imap_username")?.filter(|s| !s.trim().is_empty());
    let password = keychain::get_secret("imap_password")?.filter(|s| !s.trim().is_empty());
    let (Some(host), Some(username), Some(password)) = (host, username, password) else {
        return Ok(None);
    };
    let port: u16 = keychain::get_secret("imap_port")?
        .and_then(|s| s.trim().parse().ok())
        .unwrap_or(993);
    let use_ssl = keychain::get_secret("imap_use_ssl")?
        .map(|s| s != "false")
        .unwrap_or(true);
    Ok(Some(ImapCreds { host, port, username, password, use_ssl }))
}

/// Teste la connexion IMAP (login) puis, seulement si elle réussit, stocke les
/// identifiants dans `secrets.json` (même mécanisme que la clé Claude perso,
/// `keychain.rs`) — spec/24 §1.
pub async fn connect_imap_account(host: String, port: u16, username: String, password: String, use_ssl: bool) -> Result<()> {
    let creds = ImapCreds { host: host.clone(), port, username: username.clone(), password: password.clone(), use_ssl };
    let mut session = connect_and_login(&creds).await?;
    let _ = session.logout().await;

    keychain::save_secret("imap_host", &host)?;
    keychain::save_secret("imap_port", &port.to_string())?;
    keychain::save_secret("imap_username", &username)?;
    keychain::save_secret("imap_password", &password)?;
    keychain::save_secret("imap_use_ssl", if use_ssl { "true" } else { "false" })?;
    Ok(())
}

/// Retire les identifiants IMAP (spec/24 §1) — la boîte n'est plus scannée au
/// prochain lancement ni via le bouton manuel.
pub async fn disconnect_imap_account(db: &SqlitePool) -> Result<()> {
    keychain::delete_secret("imap_host")?;
    keychain::delete_secret("imap_port")?;
    keychain::delete_secret("imap_username")?;
    keychain::delete_secret("imap_password")?;
    keychain::delete_secret("imap_use_ssl")?;
    let _ = sqlx::query("DELETE FROM config WHERE key = 'imap_last_synced_at'").execute(db).await;
    Ok(())
}

/// Statut pour Réglages (spec/24 §1) — `connected` reflète juste la présence
/// d'identifiants stockés (pas un test réseau à chaque affichage de l'écran) ;
/// une panne de connexion réelle remonte au prochain `sync_emails`.
pub async fn get_imap_status(db: &SqlitePool) -> Result<ImapStatus> {
    let connected = load_creds()?.is_some();
    let last_synced_at: Option<String> = sqlx::query_scalar("SELECT value FROM config WHERE key = 'imap_last_synced_at'")
        .fetch_optional(db)
        .await
        .ok()
        .flatten();
    Ok(ImapStatus { connected, last_synced_at })
}

// ─── Flux TLS/clair (async_imap veut un type concret Read+Write+Unpin+Debug) ──

enum MaybeTlsStream {
    Tls(tokio_native_tls::TlsStream<TcpStream>),
    Plain(TcpStream),
}

impl fmt::Debug for MaybeTlsStream {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            MaybeTlsStream::Tls(_) => write!(f, "MaybeTlsStream::Tls"),
            MaybeTlsStream::Plain(_) => write!(f, "MaybeTlsStream::Plain"),
        }
    }
}

impl AsyncRead for MaybeTlsStream {
    fn poll_read(self: Pin<&mut Self>, cx: &mut Context<'_>, buf: &mut ReadBuf<'_>) -> Poll<std::io::Result<()>> {
        match self.get_mut() {
            MaybeTlsStream::Tls(s) => Pin::new(s).poll_read(cx, buf),
            MaybeTlsStream::Plain(s) => Pin::new(s).poll_read(cx, buf),
        }
    }
}

impl AsyncWrite for MaybeTlsStream {
    fn poll_write(self: Pin<&mut Self>, cx: &mut Context<'_>, buf: &[u8]) -> Poll<std::io::Result<usize>> {
        match self.get_mut() {
            MaybeTlsStream::Tls(s) => Pin::new(s).poll_write(cx, buf),
            MaybeTlsStream::Plain(s) => Pin::new(s).poll_write(cx, buf),
        }
    }
    fn poll_flush(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<std::io::Result<()>> {
        match self.get_mut() {
            MaybeTlsStream::Tls(s) => Pin::new(s).poll_flush(cx),
            MaybeTlsStream::Plain(s) => Pin::new(s).poll_flush(cx),
        }
    }
    fn poll_shutdown(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<std::io::Result<()>> {
        match self.get_mut() {
            MaybeTlsStream::Tls(s) => Pin::new(s).poll_shutdown(cx),
            MaybeTlsStream::Plain(s) => Pin::new(s).poll_shutdown(cx),
        }
    }
}

async fn connect_and_login(creds: &ImapCreds) -> Result<async_imap::Session<MaybeTlsStream>> {
    let tcp = TcpStream::connect((creds.host.as_str(), creds.port))
        .await
        .map_err(|e| anyhow!("Connexion à {}:{} impossible : {}", creds.host, creds.port, e))?;

    let stream = if creds.use_ssl {
        let connector = native_tls::TlsConnector::new().map_err(|e| anyhow!("TLS : {}", e))?;
        let tls = tokio_native_tls::TlsConnector::from(connector);
        let tls_stream = tls
            .connect(&creds.host, tcp)
            .await
            .map_err(|e| anyhow!("Poignée de main TLS échouée : {}", e))?;
        MaybeTlsStream::Tls(tls_stream)
    } else {
        MaybeTlsStream::Plain(tcp)
    };

    let client = async_imap::Client::new(stream);
    let session = client
        .login(&creds.username, &creds.password)
        .await
        .map_err(|(e, _)| anyhow!("Échec de connexion IMAP (identifiants ?) : {}", e))?;
    Ok(session)
}

// ─── Fenêtre glissante + dédoublonnage + fetch (spec/24 §2) ──────────────────

struct RawEmail {
    message_id: String,
    subject: String,
    from: String,
    /// Date affichable (YYYY-MM-DD si parsable, sinon la valeur brute du
    /// header) — utilisée pour la provenance `✉️ <objet> (<date>)`.
    date: String,
    body: String,
}

fn header_value(header_bytes: &[u8], name: &str) -> Option<String> {
    use mailparse::MailHeaderMap;
    let (headers, _) = mailparse::parse_headers(header_bytes).ok()?;
    headers.get_first_value(name)
}

fn format_email_date(raw: &str) -> String {
    chrono::DateTime::parse_from_rfc2822(raw.trim())
        .map(|d| d.format("%Y-%m-%d").to_string())
        .unwrap_or_else(|_| raw.trim().to_string())
}

fn extract_text_body(parsed: &mailparse::ParsedMail) -> String {
    if !parsed.subparts.is_empty() {
        for part in &parsed.subparts {
            if part.ctype.mimetype.eq_ignore_ascii_case("text/plain") {
                if let Ok(b) = part.get_body() {
                    return b;
                }
            }
        }
        return extract_text_body(&parsed.subparts[0]);
    }
    parsed.get_body().unwrap_or_default()
}

/// Récupère les mails de `INBOX` dans la fenêtre glissante, filtre ceux déjà
/// dans `processed` (spec/24 §2 — dédoublonnage par Message-ID, jamais
/// retraité même s'il réapparaît dans la fenêtre). Deux passes FETCH :
/// d'abord les en-têtes seuls (pour connaître le Message-ID sans retélécharger
/// le corps d'un mail déjà traité), puis le corps complet UNIQUEMENT pour les
/// mails vraiment nouveaux.
async fn fetch_new_emails(
    session: &mut async_imap::Session<MaybeTlsStream>,
    window_days: i64,
    processed: &HashSet<String>,
) -> Result<Vec<RawEmail>> {
    session.select("INBOX").await.map_err(|e| anyhow!("Sélection d'INBOX impossible : {}", e))?;

    let since = (chrono::Utc::now() - chrono::Duration::days(window_days)).format("%d-%b-%Y").to_string();
    let seqs = session
        .search(format!("SINCE {}", since))
        .await
        .map_err(|e| anyhow!("Recherche IMAP échouée : {}", e))?;
    if seqs.is_empty() {
        return Ok(vec![]);
    }
    let seq_str = seqs.iter().map(|s| s.to_string()).collect::<Vec<_>>().join(",");

    let mut new_seqs: Vec<u32> = Vec::new();
    {
        let mut stream = session
            .fetch(&seq_str, "RFC822.HEADER")
            .await
            .map_err(|e| anyhow!("FETCH (en-têtes) échoué : {}", e))?;
        while let Some(item) = stream.next().await {
            let Ok(fetch) = item else { continue };
            let Some(header_bytes) = fetch.header() else { continue };
            let Some(mid) = header_value(header_bytes, "Message-ID") else { continue };
            if !processed.contains(mid.trim()) {
                new_seqs.push(fetch.message);
            }
        }
    }
    if new_seqs.is_empty() {
        return Ok(vec![]);
    }
    let new_seq_str = new_seqs.iter().map(|s| s.to_string()).collect::<Vec<_>>().join(",");

    let mut emails = Vec::new();
    {
        // `BODY.PEEK[]` = message complet, sans marquer `\Seen` (lecture
        // discrète — spec/24 : Alfred ne fait que lire, jamais d'action sortante).
        let mut stream = session
            .fetch(&new_seq_str, "BODY.PEEK[]")
            .await
            .map_err(|e| anyhow!("FETCH (corps) échoué : {}", e))?;
        while let Some(item) = stream.next().await {
            let Ok(fetch) = item else { continue };
            let Some(raw) = fetch.body() else { continue };
            let Ok(parsed) = mailparse::parse_mail(raw) else { continue };
            use mailparse::MailHeaderMap;
            let Some(message_id) = parsed.headers.get_first_value("Message-ID") else { continue };
            let subject = parsed.headers.get_first_value("Subject").unwrap_or_default();
            let from = parsed.headers.get_first_value("From").unwrap_or_default();
            let date = parsed
                .headers
                .get_first_value("Date")
                .map(|d| format_email_date(&d))
                .unwrap_or_default();
            let body: String = extract_text_body(&parsed).chars().take(MAX_BODY_CHARS).collect();
            emails.push(RawEmail { message_id, subject, from, date, body });
        }
    }
    Ok(emails)
}

// ─── Sync complète (spec/24 §4) ──────────────────────────────────────────────

async fn window_days(db: &SqlitePool) -> i64 {
    sqlx::query_scalar::<_, String>("SELECT value FROM config WHERE key = 'email_sync_window_days'")
        .fetch_optional(db)
        .await
        .ok()
        .flatten()
        .and_then(|s| s.trim().parse().ok())
        .unwrap_or(DEFAULT_WINDOW_DAYS)
}

async fn already_processed(db: &SqlitePool) -> HashSet<String> {
    sqlx::query_scalar::<_, String>("SELECT message_id FROM processed_emails")
        .fetch_all(db)
        .await
        .unwrap_or_default()
        .into_iter()
        .collect()
}

async fn mark_processed(db: &SqlitePool, message_ids: &[String]) {
    let now = chrono::Utc::now().to_rfc3339();
    for mid in message_ids {
        let _ = sqlx::query("INSERT OR IGNORE INTO processed_emails (message_id, processed_at) VALUES (?, ?)")
            .bind(mid)
            .bind(&now)
            .execute(db)
            .await;
    }
}

/// Une tâche proposée, en attente de validation (spec/24 §5) — payload JSON
/// stocké dans `pending_email_reviews`. Le `project` vient du 1er projet
/// détecté par Claude pour ce mail ; la provenance (`✉️ <objet> (<date>)`)
/// n'est pas dupliquée ici, elle se reconstruit depuis les colonnes
/// `subject`/`email_date` de la ligne au moment de la résolution.
#[derive(Debug, Serialize, Deserialize, Clone)]
struct TaskReviewPayload {
    title: String,
    responsable: Option<String>,
    echeance: Option<String>,
    project: Option<String>,
}

/// Item d'un batch de mails en attente de validation (spec/24 §5) — remplace
/// l'écriture directe de l'ancien §4. Exposé au front pour l'écran
/// `/resolve-emails`.
#[derive(Debug, Serialize, Deserialize, Clone, TS, sqlx::FromRow)]
#[ts(export, export_to = "../../src/bindings/")]
pub struct PendingEmailReview {
    pub id: i64,
    pub message_id: String,
    pub subject: String,
    pub email_date: String,
    /// `"task"` | `"context"`.
    pub kind: String,
    /// JSON de `TaskReviewPayload` (kind "task") ou `ContextAddition` (kind
    /// "context") — le front désérialise selon `kind` pour l'affichage.
    pub payload: String,
    pub status: String,
    pub created_at: String,
}

async fn insert_pending_review(db: &SqlitePool, message_id: &str, subject: &str, email_date: &str, kind: &str, payload: &str) {
    let now = chrono::Utc::now().to_rfc3339();
    let _ = sqlx::query(
        "INSERT INTO pending_email_reviews (message_id, subject, email_date, kind, payload, status, created_at) VALUES (?, ?, ?, ?, ?, 'pending', ?)",
    )
    .bind(message_id)
    .bind(subject)
    .bind(email_date)
    .bind(kind)
    .bind(payload)
    .bind(&now)
    .execute(db)
    .await;
}

/// Fenêtre glissante + dédoublonnage + batchs Claude + mise en attente
/// (spec/24 §4/§5) — appelée au démarrage (si un compte est configuré) et par
/// le bouton manuel « Vérifier les mails ». No-op silencieux si aucun compte
/// IMAP n'est configuré (permet l'appel inconditionnel au démarrage).
///
/// N'écrit plus JAMAIS directement dans `Todo.md`/le contexte — chaque tâche
/// et chaque fait proposés atterrissent dans `pending_email_reviews`
/// (`status: "pending"`), validés item par item sur `/resolve-emails` (spec/24
/// §5). Un mail est marqué `processed_emails` dès que l'appel Claude a réussi
/// (« analysé » ≠ « écrit » : l'écriture réelle est différée à la validation).
pub async fn sync_emails(db: &SqlitePool, vault_root: Option<&Path>, app_handle: &tauri::AppHandle) -> Result<()> {
    use tauri::Emitter;

    let Some(creds) = load_creds()? else {
        return Ok(());
    };
    if vault_root.is_none() {
        return Ok(());
    }

    let mut session = connect_and_login(&creds).await?;
    let processed = already_processed(db).await;
    let days = window_days(db).await;
    let raw_emails = fetch_new_emails(&mut session, days, &processed).await;
    let _ = session.logout().await;
    let raw_emails = raw_emails?;

    let now = chrono::Utc::now().to_rfc3339();
    let _ = sqlx::query("INSERT OR REPLACE INTO config (key, value) VALUES ('imap_last_synced_at', ?)")
        .bind(&now)
        .execute(db)
        .await;

    if raw_emails.is_empty() {
        return Ok(());
    }

    let mut new_items = 0usize;

    for batch in raw_emails.chunks(BATCH_SIZE) {
        let inputs: Vec<EmailInput> = batch
            .iter()
            .map(|e| EmailInput {
                message_id: e.message_id.clone(),
                subject: e.subject.clone(),
                from: e.from.clone(),
                date: e.date.clone(),
                body: e.body.clone(),
            })
            .collect();

        let output = match ai::extract_email_batch(&inputs, db).await {
            Ok(o) => o,
            Err(e) => {
                // Pas d'IA disponible / échec de l'appel : ce batch n'est PAS
                // marqué traité (spec/24 §4) — retenté au prochain sync tant
                // qu'il reste dans la fenêtre glissante.
                eprintln!("[email] extract_email_batch failed, batch retried next sync: {}", e);
                continue;
            }
        };

        let by_id: std::collections::HashMap<&str, &RawEmail> =
            batch.iter().map(|e| (e.message_id.as_str(), e)).collect();

        for extraction in &output.emails {
            let Some(source) = by_id.get(extraction.message_id.as_str()) else { continue };
            let main_project = extraction.projects.first().cloned();
            for t in &extraction.tasks {
                let payload = TaskReviewPayload {
                    title: t.title.clone(),
                    responsable: t.responsable.clone(),
                    echeance: t.echeance.clone(),
                    project: main_project.clone(),
                };
                let Ok(json) = serde_json::to_string(&payload) else { continue };
                insert_pending_review(db, &source.message_id, &source.subject, &source.date, "task", &json).await;
                new_items += 1;
            }
        }

        // `context_additions` (spec/24 §4) sont déduits au niveau du BATCH, pas
        // d'un mail précis (schéma d'extraction inchangé) — rattachés, faute de
        // mieux, au 1er mail du batch pour l'affichage « objet + date » de
        // l'écran de validation (décision d'implémentation, non tranchée par
        // spec/24 §5 : les faits n'ont pas de provenance mail unique).
        if let (Some(first), false) = (batch.first(), output.context_additions.is_empty()) {
            for addition in &output.context_additions {
                let Ok(json) = serde_json::to_string(addition) else { continue };
                insert_pending_review(db, &first.message_id, &first.subject, &first.date, "context", &json).await;
                new_items += 1;
            }
        }

        // Marqué traité SEULEMENT après l'analyse Claude réussie (spec/24 §2) —
        // l'écriture réelle est désormais différée à la validation (spec/24 §5),
        // « analysé » ≠ « écrit ».
        let ids: Vec<String> = batch.iter().map(|e| e.message_id.clone()).collect();
        mark_processed(db, &ids).await;
    }

    if new_items > 0 {
        let _ = app_handle.emit("pending-email-reviews-changed", serde_json::json!({ "count": new_items }));
    }
    Ok(())
}

/// Toutes les propositions `pending` (spec/24 §5), les plus récentes en
/// premier — alimente l'écran `/resolve-emails`.
pub async fn list_pending_email_reviews(db: &SqlitePool) -> Result<Vec<PendingEmailReview>> {
    let rows = sqlx::query_as::<_, PendingEmailReview>(
        "SELECT id, message_id, subject, email_date, kind, payload, status, created_at
         FROM pending_email_reviews WHERE status = 'pending' ORDER BY created_at DESC",
    )
    .fetch_all(db)
    .await?;
    Ok(rows)
}

/// Compte de badge (spec/24 §5) — nombre d'items `pending`, vérifié au
/// démarrage de l'app et après chaque `sync_emails()` réussi.
pub async fn get_pending_email_review_count(db: &SqlitePool) -> Result<i64> {
    let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM pending_email_reviews WHERE status = 'pending'")
        .fetch_one(db)
        .await?;
    Ok(count)
}

/// Valide/rejette les items cochés/décochés de `/resolve-emails` (spec/24 §5).
/// Pour chaque accepté : désérialise le payload et appelle EXACTEMENT la même
/// fonction d'écriture que l'ancien §4 (`todo_md::append_tasks` pour une
/// tâche, `ai::route_email_context_additions` pour un fait — même routage
/// global/projet). Pour chaque rejeté : passe `status` à `"rejected"` sans
/// rien écrire. Les deux passent en statut définitif, plus jamais réévalués.
pub async fn resolve_email_reviews(
    db: &SqlitePool,
    vault_root: Option<&Path>,
    accepted_ids: &[i64],
    rejected_ids: &[i64],
    app_handle: &tauri::AppHandle,
) -> Result<()> {
    use tauri::Emitter;

    if !accepted_ids.is_empty() {
        let root = vault_root.ok_or_else(|| anyhow!("Aucun coffre de notes configuré."))?;
        let todo_rel_path = crate::todos::todo_file_path(db).await;
        let lang = crate::ai::app_language(db).await;

        for id in accepted_ids {
            let Some(row) = sqlx::query_as::<_, PendingEmailReview>(
                "SELECT id, message_id, subject, email_date, kind, payload, status, created_at FROM pending_email_reviews WHERE id = ? AND status = 'pending'",
            )
            .bind(id)
            .fetch_optional(db)
            .await?
            else {
                continue;
            };

            let write_result: Result<()> = match row.kind.as_str() {
                "task" => {
                    let Ok(p) = serde_json::from_str::<TaskReviewPayload>(&row.payload) else {
                        continue;
                    };
                    let provenance = format!("✉️ {} ({})", row.subject.trim(), row.email_date);
                    let task = IngestTask {
                        titre: p.title,
                        responsable: p.responsable,
                        echeance: p.echeance,
                        project: p.project,
                        email_provenance: Some(provenance),
                    };
                    todo_md::append_tasks(root, &todo_rel_path, &[task], None, &lang).await.map(|_| ())
                }
                "context" => {
                    let Ok(addition) = serde_json::from_str::<ContextAddition>(&row.payload) else {
                        continue;
                    };
                    ai::route_email_context_additions(db, root, &[addition]).await
                }
                _ => continue,
            };

            match write_result {
                Ok(()) => {
                    let _ = sqlx::query("UPDATE pending_email_reviews SET status = 'accepted' WHERE id = ?")
                        .bind(id)
                        .execute(db)
                        .await;
                }
                Err(e) => eprintln!("[email] resolve_email_reviews: échec d'écriture pour l'item {}: {}", id, e),
            }
        }
    }

    for id in rejected_ids {
        let _ = sqlx::query("UPDATE pending_email_reviews SET status = 'rejected' WHERE id = ? AND status = 'pending'")
            .bind(id)
            .execute(db)
            .await;
    }

    let _ = app_handle.emit("pending-email-reviews-changed", serde_json::json!({}));
    let _ = app_handle.emit("notes-updated", serde_json::json!({}));
    let _ = app_handle.emit("todos-updated", serde_json::json!({}));
    Ok(())
}

// ─── Q&A sur les mails en chat (spec/24 §6) ──────────────────────────────────
//
// Read-only, en direct sur l'IMAP (pas `processed_emails`, pas de cache) —
// rien n'est persisté. Fenêtre dédiée, plus large que l'extraction
// automatique (`email_search_window_days`, défaut 90j, indépendante de
// `email_sync_window_days`).

async fn search_window_days(db: &SqlitePool) -> i64 {
    sqlx::query_scalar::<_, String>("SELECT value FROM config WHERE key = 'email_search_window_days'")
        .fetch_optional(db)
        .await
        .ok()
        .flatten()
        .and_then(|s| s.trim().parse().ok())
        .unwrap_or(DEFAULT_SEARCH_WINDOW_DAYS)
}

/// Un résultat de `search_emails` (spec/24 §6) — assez d'info pour que Claude
/// décide s'il vaut la peine d'appeler `read_email` sur ce mail.
pub struct EmailSearchHit {
    pub message_id: String,
    pub subject: String,
    pub from: String,
    pub date: String,
    pub snippet: String,
}

/// Un mail lu en entier (spec/24 §6) — assez d'info (objet, expéditeur, date)
/// pour que Claude cite le mail comme source, sans lien cliquable (§3 :
/// aucune note derrière un mail).
pub struct EmailFull {
    pub message_id: String,
    pub subject: String,
    pub from: String,
    pub date: String,
    pub body: String,
}

fn score_email(e: &RawEmail, keywords: &[String]) -> usize {
    let subject_lower = e.subject.to_lowercase();
    let from_lower = e.from.to_lowercase();
    let body_lower = e.body.to_lowercase();
    keywords
        .iter()
        .map(|kw| {
            let in_subject = if subject_lower.contains(kw.as_str()) { 5 } else { 0 };
            let in_from = if from_lower.contains(kw.as_str()) { 3 } else { 0 };
            let in_body = body_lower.matches(kw.as_str()).count().min(10);
            in_subject + in_from + in_body
        })
        .sum()
}

/// Recherche en direct sur l'IMAP (spec/24 §6), fenêtre `email_search_window_days`
/// — AUCUN effet de bord (pas de marquage `processed_emails`, pas d'analyse
/// Claude déclenchée), à la différence de `sync_emails`.
pub async fn search_emails(db: &SqlitePool, query: &str) -> Result<Vec<EmailSearchHit>> {
    let Some(creds) = load_creds()? else {
        return Err(anyhow!("Aucun compte e-mail connecté."));
    };
    let keywords: Vec<String> = query
        .to_lowercase()
        .split(|c: char| !c.is_alphanumeric())
        .filter(|w| w.chars().count() >= 2)
        .map(|w| w.to_string())
        .collect();
    if keywords.is_empty() {
        return Ok(vec![]);
    }

    let mut session = connect_and_login(&creds).await?;
    let days = search_window_days(db).await;
    // Fenêtre de recherche indépendante du dédoublonnage d'extraction — aucun
    // filtre `processed` ici (un mail déjà extrait reste cherchable).
    let raw_emails = fetch_new_emails(&mut session, days, &HashSet::new()).await;
    let _ = session.logout().await;
    let raw_emails = raw_emails?;

    let mut scored: Vec<(usize, &RawEmail)> = raw_emails
        .iter()
        .map(|e| (score_email(e, &keywords), e))
        .filter(|(score, _)| *score > 0)
        .collect();
    scored.sort_by(|a, b| b.0.cmp(&a.0));
    scored.truncate(SEARCH_RESULTS);

    Ok(scored
        .into_iter()
        .map(|(_, e)| EmailSearchHit {
            message_id: e.message_id.clone(),
            subject: e.subject.clone(),
            from: e.from.clone(),
            date: e.date.clone(),
            snippet: e.body.chars().take(SEARCH_SNIPPET_CHARS).collect(),
        })
        .collect())
}

/// Lit le contenu complet d'un mail précis, identifié par son `Message-ID`
/// (tel que renvoyé par `search_emails`) — spec/24 §6. Aucun effet de bord.
/// Pas de dépendance à `db` (une recherche IMAP directe par en-tête suffit) —
/// gardé en paramètre pour rester symétrique de `search_emails` côté appelant.
pub async fn read_email(_db: &SqlitePool, message_id: &str) -> Result<Option<EmailFull>> {
    let Some(creds) = load_creds()? else {
        return Err(anyhow!("Aucun compte e-mail connecté."));
    };
    let mut session = connect_and_login(&creds).await?;
    session.select("INBOX").await.map_err(|e| anyhow!("Sélection d'INBOX impossible : {}", e))?;

    let query = format!("HEADER Message-ID \"{}\"", message_id.trim());
    let seqs = session.search(query).await.map_err(|e| anyhow!("Recherche IMAP échouée : {}", e))?;

    let result: Result<Option<EmailFull>> = async {
        let Some(&seq) = seqs.iter().next() else { return Ok(None) };
        let mut stream = session
            .fetch(seq.to_string(), "BODY.PEEK[]")
            .await
            .map_err(|e| anyhow!("FETCH (corps) échoué : {}", e))?;
        let Some(item) = stream.next().await else { return Ok(None) };
        let fetch = item.map_err(|e| anyhow!("FETCH échoué : {}", e))?;
        let Some(raw) = fetch.body() else { return Ok(None) };
        let Ok(parsed) = mailparse::parse_mail(raw) else { return Ok(None) };
        use mailparse::MailHeaderMap;
        let Some(mid) = parsed.headers.get_first_value("Message-ID") else { return Ok(None) };
        let subject = parsed.headers.get_first_value("Subject").unwrap_or_default();
        let from = parsed.headers.get_first_value("From").unwrap_or_default();
        let date = parsed
            .headers
            .get_first_value("Date")
            .map(|d| format_email_date(&d))
            .unwrap_or_default();
        let body = extract_text_body(&parsed);
        Ok(Some(EmailFull { message_id: mid, subject, from, date, body }))
    }
    .await;
    let _ = session.logout().await;
    result
}
