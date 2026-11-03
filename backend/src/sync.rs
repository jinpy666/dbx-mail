//! 同步与邮件事务：账户同步、按需取正文、旗标、移动、投递。
//!
//! 这里的函数都在 tokio 运行时里执行，数据库操作单独加锁、用完即放，
//! 不跨 `.await` 持有锁。

use std::path::Path;
use std::sync::Arc;

use rusqlite::params;

use crate::db;
use crate::imap::{ImapClient, Login, RemoteHeader};
use crate::mime::{self, ParseContext};
use crate::model::{Account, MessageDetail, OutboxItem, SyncReport};
use crate::smtp::{self, Outgoing, SmtpLogin};
use crate::App;

/// 同步选项
#[derive(Debug, Clone, Default)]
pub struct SyncOptions {
    /// 只同步这些本地文件夹；空表示按设置的范围
    pub mailbox_ids: Vec<i64>,
    /// 首次同步拉取的邮件数
    pub limit: usize,
}

/* ---------------- 账户同步 ---------------- */

pub async fn sync_account(app: Arc<App>, account_id: i64, options: SyncOptions) -> Result<SyncReport, String> {
    let account = {
        let conn = app.db();
        db::account_get(&conn, account_id)
            .map_err(|error| format!("读取账户失败：{error}"))?
            .ok_or_else(|| "账户不存在".to_string())?
    };
    let password = app.load_password(account.id)?;
    let login = Login {
        host: account.imap_host.clone(),
        port: account.imap_port,
        security: account.imap_security.clone(),
        username: account.username.clone(),
        password,
    };

    let mut report = SyncReport {
        account_id,
        ..Default::default()
    };
    let mut client = match ImapClient::open(&login).await {
        Ok(client) => client,
        Err(error) => {
            record_failure(&app, account_id, &error);
            return Err(error);
        }
    };

    let remote = client.list().await?;
    {
        let conn = app.db();
        for (index, mailbox) in remote.iter().enumerate() {
            if let Err(error) = db::mailbox_upsert(
                &conn,
                account_id,
                &mailbox.name,
                &mailbox.delimiter,
                &mailbox.role,
                mailbox.selectable,
                index as i64,
            ) {
                report.errors.push(format!("保存文件夹「{}」失败：{error}", mailbox.name));
            }
        }
    }
    report.mailboxes = remote.iter().filter(|item| item.selectable).count() as i64;

    // 刷新各文件夹计数
    for mailbox in remote.iter().filter(|item| item.selectable) {
        match client.status(&mailbox.name).await {
            Ok((total, unread)) => {
                let conn = app.db();
                let id: Option<i64> = conn
                    .query_row(
                        "SELECT id FROM mailboxes WHERE account_id = ?1 AND name = ?2",
                        params![account_id, mailbox.name],
                        |row| row.get(0),
                    )
                    .ok();
                if let Some(id) = id {
                    let _ = db::mailbox_set_counts(&conn, id, total, unread);
                }
            }
            Err(error) => report.errors.push(format!("{}：{error}", mailbox.name)),
        }
    }

    // 选出要同步邮件头的文件夹
    let settings = {
        let conn = app.db();
        db::load_settings(&conn).unwrap_or_default()
    };
    let limit = if options.limit > 0 {
        options.limit
    } else {
        settings.initial_limit.clamp(20, 2000) as usize
    };
    let targets: Vec<db::Mailbox> = {
        let conn = app.db();
        let all = db::mailbox_list(&conn, account_id).unwrap_or_default();
        if !options.mailbox_ids.is_empty() {
            all.into_iter()
                .filter(|mailbox| options.mailbox_ids.contains(&mailbox.id))
                .collect()
        } else {
            all.into_iter()
                .filter(|mailbox| {
                    if !mailbox.selectable {
                        return false;
                    }
                    match settings.sync_scope.as_str() {
                        "all" => !matches!(mailbox.role.as_str(), "trash" | "junk" | "all"),
                        _ => matches!(mailbox.role.as_str(), "inbox" | "sent" | "drafts" | "archive"),
                    }
                })
                .collect()
        }
    };

    for mailbox in targets {
        match sync_mailbox(&app, &mut client, &account, &mailbox, limit).await {
            Ok(new_messages) => report.new_messages += new_messages,
            Err(error) => report.errors.push(format!("{}：{error}", mailbox.name)),
        }
    }

    // 本地待同步的旗标
    apply_pending_flags(&app, &mut client, account_id).await;

    client.logout().await;

    let now = crate::now_ms();
    {
        let conn = app.db();
        let errors = report.errors.join("；");
        let _ = db::account_set_sync(&conn, account_id, now, &errors.chars().take(300).collect::<String>());
        let _ = db::sync_log_append(&conn, account_id, report.errors.is_empty(), if report.errors.is_empty() {
            "同步完成"
        } else {
            &errors
        });
    }
    report.synced_at = now;
    Ok(report)
}

/// 同步单个文件夹的邮件头与旗标
async fn sync_mailbox(
    app: &Arc<App>,
    client: &mut ImapClient,
    account: &Account,
    mailbox: &db::Mailbox,
    limit: usize,
) -> Result<i64, String> {
    let (_, remote_uid_validity_raw) = client.select(&mailbox.name, true).await?;
    let remote_uid_validity = remote_uid_validity_raw as i64;
    if mailbox.uid_validity != 0
        && remote_uid_validity != 0
        && mailbox.uid_validity != remote_uid_validity
    {
        // 服务器重新编号，本地缓存失效
        let conn = app.db();
        let _ = db::mailbox_reset(&conn, mailbox.id);
    }
    let last_uid = if mailbox.uid_validity != 0 && mailbox.uid_validity == remote_uid_validity {
        mailbox.last_uid.max(0) as u32
    } else {
        0
    };

    let headers = client.fetch_headers(&mailbox.name, last_uid, limit).await?;
    let mut max_uid = last_uid;
    let mut new_count = 0i64;
    {
        let conn = app.db();
        for header in &headers {
            let uid = header.uid;
            if uid > max_uid {
                max_uid = uid;
            }
            let existing: Option<i64> = conn
                .query_row(
                    "SELECT id FROM messages WHERE account_id = ?1 AND mailbox_id = ?2 AND uid = ?3",
                    params![account.id, mailbox.id, uid],
                    |row| row.get(0),
                )
                .ok();
            let ctx = ParseContext {
                account_id: account.id,
                mailbox_id: mailbox.id,
                uid: Some(uid as i64),
                internal_date: header.internal_date,
                seen: header.seen,
                flagged: header.flagged,
                answered: header.answered,
                draft: header.draft,
                size: header.size,
            };
            let row = match mime::parse_header(&header.raw, &ctx) {
                Some(row) => row,
                None => fallback_header(header, &ctx),
            };
            if let Ok(id) = db::message_upsert_header(&conn, &row) {
                if existing.is_none() {
                    new_count += 1;
                }
                if !row.from_addr.is_empty() {
                    let _ = db::contacts_touch(&conn, &row.from_addr, &row.from_name, row.date);
                }
                let _ = id;
            }
        }
        let _ = db::mailbox_sync_state(&conn, mailbox.id, remote_uid_validity, max_uid as i64);
    }

    // 最近 300 封的旗标双向同步
    if let Ok(flags) = client.fetch_recent_flags(&mailbox.name, 300).await {
        let conn = app.db();
        for (uid, seen, flagged, answered) in flags {
            let id: Option<i64> = conn
                .query_row(
                    "SELECT id FROM messages WHERE account_id = ?1 AND mailbox_id = ?2 AND uid = ?3",
                    params![account.id, mailbox.id, uid],
                    |row| row.get(0),
                )
                .ok();
            if let Some(id) = id {
                let _ = db::message_apply_server_flags(&conn, id, seen, flagged, answered);
            }
        }
    }

    let _ = new_count;
    Ok(new_count)
}

/// 服务器没有返回头部时的兜底行
fn fallback_header(header: &RemoteHeader, ctx: &ParseContext) -> db::HeaderRow {
    let fallback = header.fallback.clone().unwrap_or_default();
    let message_id = fallback.message_id.clone();
    let thread_id = if !message_id.is_empty() {
        message_id.clone()
    } else {
        format!("u:{}:{}:{}", ctx.account_id, ctx.mailbox_id, header.uid)
    };
    let subject = if fallback.subject.trim().is_empty() {
        "(无主题)".to_string()
    } else {
        fallback.subject
    };
    db::HeaderRow {
        account_id: ctx.account_id,
        mailbox_id: ctx.mailbox_id,
        uid: Some(header.uid as i64),
        message_id,
        thread_id,
        subject,
        from_name: fallback.from_name,
        from_addr: fallback.from_addr,
        to_addrs: fallback.to,
        cc_addrs: fallback.cc,
        reply_to: String::new(),
        in_reply_to: String::new(),
        references: Vec::new(),
        date: if fallback.date > 0 { fallback.date } else { header.internal_date },
        internal_date: header.internal_date,
        size: header.size,
        snippet: String::new(),
        seen: header.seen,
        flagged: header.flagged,
        answered: header.answered,
        draft: header.draft,
        has_attachments: false,
    }
}

/// 把本地待同步的旗标写回服务器
async fn apply_pending_flags(app: &Arc<App>, client: &mut ImapClient, account_id: i64) {
    let pending = {
        let conn = app.db();
        db::pending_flags_list(&conn).unwrap_or_default()
    };
    for (message_id, seen, flagged, answered) in pending {
        let located: Option<(String, i64, Option<i64>)> = {
            let conn = app.db();
            conn.query_row(
                "SELECT mb.name, m.account_id, m.uid FROM messages m
                 JOIN mailboxes mb ON mb.id = m.mailbox_id WHERE m.id = ?1",
                params![message_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .ok()
        };
        let Some((mailbox_name, owner, Some(uid))) = located else { continue };
        if owner != account_id {
            continue;
        }
        let mut add: Vec<&str> = Vec::new();
        let mut remove: Vec<&str> = Vec::new();
        if let Some(value) = seen {
            if value {
                add.push("\\Seen");
            } else {
                remove.push("\\Seen");
            }
        }
        if let Some(value) = flagged {
            if value {
                add.push("\\Flagged");
            } else {
                remove.push("\\Flagged");
            }
        }
        if let Some(value) = answered {
            if value {
                add.push("\\Answered");
            } else {
                remove.push("\\Answered");
            }
        }
        if client
            .store_flags(&mailbox_name, uid as u32, &add, &remove)
            .await
            .is_ok()
        {
            let conn = app.db();
            let _ = db::pending_flags_clear(&conn, message_id);
        }
    }
}

fn record_failure(app: &Arc<App>, account_id: i64, error: &str) {
    let conn = app.db();
    let message: String = error.chars().take(300).collect();
    let _ = db::account_set_sync(&conn, account_id, crate::now_ms(), &message);
    let _ = db::sync_log_append(&conn, account_id, false, &message);
}

/* ---------------- 正文 ---------------- */

/// 确保正文已缓存；必要时联网下载原始邮件
pub async fn ensure_body(app: Arc<App>, message_id: i64, allow_network: bool) -> Result<MessageDetail, String> {
    let (summary, raw_path) = {
        let conn = app.db();
        let Some(summary) = db::message_get(&conn, message_id)
            .map_err(|error| format!("读取邮件失败：{error}"))?
        else {
            return Err("邮件不存在".to_string());
        };
        let raw_path = db::message_raw_path(&conn, message_id)
            .unwrap_or_default()
            .unwrap_or_default();
        (summary, raw_path)
    };

    let mut cached = if !raw_path.is_empty() && Path::new(&raw_path).is_file() {
        std::fs::read(&raw_path).ok()
    } else {
        None
    };

    if cached.is_none() && summary.body_loaded {
        // 正文已入库，只是原始文件被清理：直接用数据库内容
        return detail_with_attachments(&app, message_id);
    }

    if cached.is_none() {
        if !allow_network {
            return Err("本机没有这封邮件的副本，请联网后重试".into());
        }
        let (account, mailbox_name) = {
            let conn = app.db();
            let account = db::account_get(&conn, summary.account_id)
                .ok()
                .flatten()
                .ok_or_else(|| "账户不存在".to_string())?;
            let mailbox = db::mailbox_get(&conn, summary.mailbox_id)
                .ok()
                .flatten()
                .ok_or_else(|| "文件夹不存在".to_string())?;
            (account, mailbox.name)
        };
        let Some(uid) = summary.uid else {
            return Err("这是一封本地邮件，没有可下载的服务器副本".into());
        };
        let password = app.load_password(account.id)?;
        let login = Login {
            host: account.imap_host.clone(),
            port: account.imap_port,
            security: account.imap_security.clone(),
            username: account.username.clone(),
            password,
        };
        let mut client = ImapClient::open(&login).await?;
        let raw = client.fetch_raw(&mailbox_name, uid as u32).await?;
        client.logout().await;

        let key = uid.to_string();
        let path = crate::files::raw_path(&app.data_dir, account.id, summary.mailbox_id, &key);
        crate::files::write_raw(&path, &raw)?;
        {
            let conn = app.db();
            let _ = db::message_set_raw(&conn, message_id, &path.to_string_lossy());
        }
        cached = Some(raw);
    }

    let raw = cached.ok_or_else(|| "无法读取邮件内容".to_string())?;
    let ctx = ParseContext {
        account_id: summary.account_id,
        mailbox_id: summary.mailbox_id,
        uid: summary.uid,
        internal_date: summary.date,
        seen: summary.seen,
        flagged: summary.flagged,
        answered: summary.answered,
        draft: summary.draft,
        size: summary.size,
    };
    let parsed = mime::parse(&raw, &ctx).ok_or_else(|| "邮件格式无法解析".to_string())?;
    {
        let conn = app.db();
        let _ = db::body_save(&conn, message_id, &parsed.text, &parsed.html, &parsed.calendar);
        let _ = db::attachments_replace(&conn, message_id, &parsed.attachments);
        let _ = db::message_mark_body_loaded(&conn, message_id);
        if parsed.header.has_attachments {
            let _ = conn.execute(
                "UPDATE messages SET has_attachments = 1, snippet = CASE WHEN snippet = '' THEN ?2 ELSE snippet END WHERE id = ?1",
                params![message_id, parsed.header.snippet],
            );
        }
    }
    detail_with_attachments(&app, message_id)
}

fn detail_with_attachments(app: &Arc<App>, message_id: i64) -> Result<MessageDetail, String> {
    let conn = app.db();
    let mut detail = db::message_detail(&conn, message_id)
        .map_err(|error| format!("读取邮件失败：{error}"))?
        .ok_or_else(|| "邮件不存在".to_string())?;
    detail.attachments = db::attachments_list(&conn, message_id).unwrap_or_default();
    Ok(detail)
}

/* ---------------- 旗标 ---------------- */

pub async fn set_flags(
    app: Arc<App>,
    ids: &[i64],
    seen: Option<bool>,
    flagged: Option<bool>,
    answered: Option<bool>,
) -> Result<(), String> {
    if ids.is_empty() {
        return Ok(());
    }
    // 先写本地并记待同步，界面立即生效
    let mut jobs: Vec<(i64, String, Option<i64>)> = Vec::new();
    {
        let conn = app.db();
        for id in ids {
            let _ = db::message_update_flags(&conn, *id, seen, flagged, answered, true);
            let located: Option<(i64, String, Option<i64>)> = conn
                .query_row(
                    "SELECT m.account_id, mb.name, m.uid FROM messages m
                     JOIN mailboxes mb ON mb.id = m.mailbox_id WHERE m.id = ?1",
                    params![id],
                    |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
                )
                .ok();
            if let Some(job) = located {
                jobs.push(job);
            }
        }
    }

    // 同一账户同一文件夹只登录一次
    let mut grouped: std::collections::HashMap<(i64, String), Vec<(i64, i64)>> =
        std::collections::HashMap::new();
    for (account_id, mailbox_name, uid) in jobs {
        if let Some(uid) = uid {
            grouped
                .entry((account_id, mailbox_name))
                .or_default()
                .push((uid, 0));
        }
    }

    let mut add: Vec<&str> = Vec::new();
    let mut remove: Vec<&str> = Vec::new();
    match seen {
        Some(true) => add.push("\\Seen"),
        Some(false) => remove.push("\\Seen"),
        None => {}
    }
    match flagged {
        Some(true) => add.push("\\Flagged"),
        Some(false) => remove.push("\\Flagged"),
        None => {}
    }
    match answered {
        Some(true) => add.push("\\Answered"),
        Some(false) => remove.push("\\Answered"),
        None => {}
    }

    for ((account_id, mailbox_name), items) in grouped {
        let account = {
            let conn = app.db();
            db::account_get(&conn, account_id).ok().flatten()
        };
        let Some(account) = account else { continue };
        let password = app.load_password(account.id)?;
        let login = Login {
            host: account.imap_host.clone(),
            port: account.imap_port,
            security: account.imap_security.clone(),
            username: account.username.clone(),
            password,
        };
        if let Ok(mut client) = ImapClient::open(&login).await {
            for (uid, _) in items {
                if client
                    .store_flags(&mailbox_name, uid as u32, &add, &remove)
                    .await
                    .is_ok()
                {
                    let conn = app.db();
                    let target: Option<i64> = conn
                        .query_row(
                            "SELECT m.id FROM messages m JOIN mailboxes mb ON mb.id = m.mailbox_id
                             WHERE m.account_id = ?1 AND mb.name = ?2 AND m.uid = ?3",
                            params![account_id, mailbox_name, uid],
                            |row| row.get(0),
                        )
                        .ok();
                    if let Some(target) = target {
                        let _ = db::pending_flags_clear(&conn, target);
                    }
                }
            }
            client.logout().await;
        }
    }
    Ok(())
}

/* ---------------- 移动 / 删除 ---------------- */

/// 邮件去向
pub enum Destination {
    Archive,
    Trash,
    Junk,
    Mailbox(i64),
}

pub async fn move_messages(app: Arc<App>, ids: &[i64], destination: Destination) -> Result<(), String> {
    if ids.is_empty() {
        return Ok(());
    }

    // (account_id, source mailbox name, source mailbox id, uid, target mailbox (id,name), permanent)
    struct Job {
        id: i64,
        account_id: i64,
        source_name: String,
        uid: Option<i64>,
        target_id: i64,
        target_name: String,
        permanent: bool,
    }

    let mut jobs: Vec<Job> = Vec::new();
    {
        let conn = app.db();
        for id in ids {
            let located: Option<(i64, String, i64, Option<i64>, String)> = conn
                .query_row(
                    "SELECT m.account_id, mb.name, mb.id, m.uid, mb.role FROM messages m
                     JOIN mailboxes mb ON mb.id = m.mailbox_id WHERE m.id = ?1",
                    params![id],
                    |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?)),
                )
                .ok();
            let Some((account_id, source_name, source_id, uid, source_role)) = located else { continue };

            let target = match &destination {
                Destination::Mailbox(target_id) => {
                    let found: Option<(i64, String)> = conn
                        .query_row(
                            "SELECT id, name FROM mailboxes WHERE id = ?1",
                            params![target_id],
                            |row| Ok((row.get(0)?, row.get(1)?)),
                        )
                        .ok();
                    found.map(|(id, name)| (id, name, false))
                }
                Destination::Trash => {
                    if source_role == "trash" {
                        Some((source_id, source_name.clone(), true))
                    } else {
                        role_mailbox(&conn, account_id, "trash").map(|(id, name)| (id, name, false))
                    }
                }
                Destination::Archive => role_mailbox(&conn, account_id, "archive")
                    .map(|(id, name)| (id, name, false)),
                Destination::Junk => {
                    role_mailbox(&conn, account_id, "junk").map(|(id, name)| (id, name, false))
                }
            };
            let Some((target_id, target_name, permanent)) = target else {
                return Err(match &destination {
                    Destination::Archive => "该账户没有「存档」文件夹".into(),
                    Destination::Junk => "该账户没有「垃圾邮件」文件夹".into(),
                    _ => "该账户没有可用的目标文件夹".into(),
                });
            };
            jobs.push(Job {
                id: *id,
                account_id,
                source_name,
                uid,
                target_id,
                target_name,
                permanent,
            });
        }
    }

    // 按账户 + 源文件夹分组，复用一条 IMAP 连接
    let mut grouped: std::collections::HashMap<(i64, String), Vec<Job>> = std::collections::HashMap::new();
    for job in jobs {
        grouped
            .entry((job.account_id, job.source_name.clone()))
            .or_default()
            .push(job);
    }

    for ((account_id, source_name), group) in grouped {
        let account = {
            let conn = app.db();
            db::account_get(&conn, account_id).ok().flatten()
        };
        let Some(account) = account else { continue };
        let password = app.load_password(account.id)?;
        let login = Login {
            host: account.imap_host.clone(),
            port: account.imap_port,
            security: account.imap_security.clone(),
            username: account.username.clone(),
            password,
        };
        let mut client = ImapClient::open(&login).await.ok();

        for job in group {
            let mut done = false;
            if let Some(client) = client.as_mut() {
                if let Some(uid) = job.uid {
                    done = if job.permanent {
                        client.delete_message(&source_name, uid as u32).await.is_ok()
                    } else {
                        client.move_message(&source_name, uid as u32, &job.target_name).await.is_ok()
                    };
                }
            }
            let conn = app.db();
            if job.uid.is_none() {
                // 本地邮件直接改归属
                if job.permanent {
                    let _ = db::message_delete(&conn, job.id);
                } else {
                    let _ = conn.execute(
                        "UPDATE messages SET mailbox_id = ?2 WHERE id = ?1",
                        params![job.id, job.target_id],
                    );
                }
                continue;
            }
            if done {
                if job.permanent {
                    let _ = db::message_delete(&conn, job.id);
                } else {
                    let _ = db::message_set_mailbox(&conn, job.id, job.target_id);
                }
            }
        }

        if let Some(client) = client {
            client.logout().await;
        }
    }
    Ok(())
}

fn role_mailbox(conn: &rusqlite::Connection, account_id: i64, role: &str) -> Option<(i64, String)> {
    conn.query_row(
        "SELECT id, name FROM mailboxes WHERE account_id = ?1 AND role = ?2 AND selectable = 1 LIMIT 1",
        params![account_id, role],
        |row| Ok((row.get(0)?, row.get(1)?)),
    )
    .ok()
}

/* ---------------- 投递 ---------------- */

/// 发送一封发件箱邮件
pub async fn deliver(app: Arc<App>, item: OutboxItem) -> Result<(), String> {
    let account = {
        let conn = app.db();
        db::account_get(&conn, item.account_id)
            .map_err(|error| format!("读取账户失败：{error}"))?
            .ok_or_else(|| "账户不存在".to_string())?
    };
    let password = app.load_password(account.id)?;

    let message_id = format!("{}@dbx-mail", uuid::Uuid::new_v4());
    let outgoing = Outgoing {
        from_name: account.display_name.clone(),
        from_email: account.email.clone(),
        to: item.to_addrs.clone(),
        cc: item.cc_addrs.clone(),
        bcc: item.bcc_addrs.clone(),
        subject: item.subject.clone(),
        html: item.body_html.clone(),
        attachments: item.attachments.clone(),
        in_reply_to: item.in_reply_to.clone(),
        references: item.references.clone(),
        message_id: message_id.clone(),
    };

    let login = SmtpLogin {
        host: account.smtp_host.clone(),
        port: account.smtp_port,
        security: account.smtp_security.clone(),
        username: account.username.clone(),
        password: password.clone(),
    };
    let raw = smtp::send(&login, &outgoing).await?;

    // 写入服务器「已发送」，失败不影响投递结果
    if let Some(sent) = {
        let conn = app.db();
        role_mailbox(&conn, account.id, "sent")
    } {
        let imap_login = Login {
            host: account.imap_host.clone(),
            port: account.imap_port,
            security: account.imap_security.clone(),
            username: account.username.clone(),
            password,
        };
        if let Ok(mut client) = ImapClient::open(&imap_login).await {
            if let Err(error) = client.append(&sent.1, &raw).await {
                eprintln!("[dbx-mail] 写入已发送失败：{error}");
            }
            client.logout().await;
        }
    }

    {
        let conn = app.db();
        db::outbox_mark_sent(&conn, item.id).map_err(|error| format!("更新发件箱失败：{error}"))?;
        let _ = db::sync_log_append(
            &conn,
            account.id,
            true,
            &format!("已发送：{}", item.subject),
        );
    }
    Ok(())
}

/* ---------------- 账户检测 ---------------- */

pub async fn test_account(account: &Account, password: &str) -> Result<Vec<String>, String> {
    let mut lines = Vec::new();
    let login = Login {
        host: account.imap_host.clone(),
        port: account.imap_port,
        security: account.imap_security.clone(),
        username: account.username.clone(),
        password: password.to_string(),
    };
    let mut client = ImapClient::open(&login).await?;
    lines.push(format!("IMAP 登录成功：{}:{}", account.imap_host, account.imap_port));
    let mailboxes = client.list().await?;
    lines.push(format!("发现 {} 个文件夹", mailboxes.len()));
    if let Ok((total, unread)) = client.status("INBOX").await {
        lines.push(format!("收件箱 {total} 封，未读 {unread} 封"));
    }
    client.logout().await;

    let smtp_login = SmtpLogin {
        host: account.smtp_host.clone(),
        port: account.smtp_port,
        security: account.smtp_security.clone(),
        username: account.username.clone(),
        password: password.to_string(),
    };
    smtp::test(&smtp_login).await?;
    lines.push(format!("SMTP 连接成功：{}:{}", account.smtp_host, account.smtp_port));
    Ok(lines)
}
