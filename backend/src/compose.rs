//! 撰写、草稿与发件箱。
//!
//! 发送永远先进入发件箱（即使选「立即发送」），由后台线程按 `scheduled_at`
//! 投递；撤销发送就是把状态改成 canceled，未到点的邮件不会再发出。

use std::sync::Arc;

use serde_json::{json, Value};

use crate::db;
use crate::model::{Draft, DraftAttachment, OutboxItem};
use crate::sync;
use crate::App;

/// 立即发送时的最小调度延迟（毫秒），给撤销留出一点余量
const MIN_SCHEDULE_DELAY: i64 = 800;

/// 组装发件箱条目
pub fn send(app: Arc<App>, params: &Value) -> Result<Value, String> {
    let account_id = crate::param_int(params, "accountId", 0);
    if account_id <= 0 {
        return Err("请选择发件账户".into());
    }
    {
        let conn = app.db();
        db::account_get(&conn, account_id)
            .map_err(|error| format!("读取账户失败：{error}"))?
            .ok_or_else(|| "账户不存在".to_string())?;
    }

    let to_addrs = crate::param_str_array(params, "to");
    let cc_addrs = crate::param_str_array(params, "cc");
    let bcc_addrs = crate::param_str_array(params, "bcc");
    if to_addrs.is_empty() && cc_addrs.is_empty() && bcc_addrs.is_empty() {
        return Err("请至少填写一个收件人".into());
    }
    let attachments: Vec<DraftAttachment> = params
        .get("attachments")
        .cloned()
        .map(serde_json::from_value)
        .transpose()
        .map_err(|error| format!("附件参数非法：{error}"))?
        .unwrap_or_default();
    for attachment in &attachments {
        if !std::path::Path::new(&attachment.path).is_file() {
            return Err(format!("附件「{}」已不存在，请重新添加", attachment.name));
        }
    }

    let settings = {
        let conn = app.db();
        db::load_settings(&conn).unwrap_or_default()
    };
    let now = crate::now_ms();
    let mode = crate::param_str(params, "mode");
    let scheduled_at = match mode.as_str() {
        "delay" => {
            let seconds = crate::param_int(params, "delaySeconds", 0).clamp(0, 60 * 24 * 30);
            now + seconds * 1000
        }
        "schedule" => crate::param_int(params, "scheduledAt", now).max(now + MIN_SCHEDULE_DELAY),
        _ => now + settings.undo_delay.clamp(0, 120) * 1000 + MIN_SCHEDULE_DELAY,
    };

    let item = OutboxItem {
        id: 0,
        account_id,
        account_email: String::new(),
        to_addrs,
        cc_addrs,
        bcc_addrs,
        subject: {
            let value = crate::param_str(params, "subject");
            if value.trim().is_empty() {
                "(无主题)".to_string()
            } else {
                value
            }
        },
        body_html: crate::param_str(params, "html"),
        attachments,
        scheduled_at,
        status: "queued".into(),
        error: String::new(),
        attempts: 0,
        created_at: now,
        sent_at: 0,
        in_reply_to: crate::param_str(params, "inReplyTo"),
        references: crate::param_str_array(params, "references"),
    };

    let id = {
        let conn = app.db();
        db::outbox_insert(&conn, &item).map_err(|error| format!("写入发件箱失败：{error}"))?
    };

    let draft_id = crate::param_int(params, "draftId", 0);
    if draft_id > 0 {
        let conn = app.db();
        let _ = db::draft_delete(&conn, draft_id);
    }

    Ok(json!({ "outboxId": id, "scheduledAt": scheduled_at, "undoSeconds": settings.undo_delay }))
}

/// 处理到点的发件箱邮件
pub fn process_due(app: Arc<App>) {
    let due = {
        let conn = app.db();
        db::outbox_due(&conn, crate::now_ms()).unwrap_or_default()
    };
    for item in due {
        {
            let conn = app.db();
            let _ = db::outbox_mark(&conn, item.id, "sending", "");
        }
        let result = app.rt.block_on(sync::deliver(app.clone(), item.clone()));
        if let Err(error) = result {
            let attempts = {
                let conn = app.db();
                db::outbox_bump(&conn, item.id).unwrap_or(item.attempts + 1)
            };
            let message: String = error.chars().take(500).collect();
            let conn = app.db();
            let _ = db::outbox_mark(&conn, item.id, "failed", &message);
            let _ = db::sync_log_append(&conn, item.account_id, false, &format!("发送失败（第 {attempts} 次）：{message}"));
        }
    }
}

/// 发件箱列表
pub fn list(app: &Arc<App>) -> Result<Value, String> {
    let conn = app.db();
    let items = db::outbox_list(&conn).map_err(|error| format!("读取发件箱失败：{error}"))?;
    Ok(json!({ "items": items }))
}

/// 撤销发送
pub fn cancel(app: &Arc<App>, params: &Value) -> Result<Value, String> {
    let id = crate::param_int(params, "id", 0);
    let conn = app.db();
    let item = db::outbox_get(&conn, id)
        .map_err(|error| format!("读取发件箱失败：{error}"))?
        .ok_or_else(|| "邮件不存在".to_string())?;
    if item.status == "sent" {
        return Err("邮件已经发出，无法撤销".into());
    }
    db::outbox_mark(&conn, id, "canceled", "").map_err(|error| format!("撤销失败：{error}"))?;
    Ok(json!({ "canceled": true }))
}

/// 重试失败邮件
pub fn retry(app: &Arc<App>, params: &Value) -> Result<Value, String> {
    let id = crate::param_int(params, "id", 0);
    let conn = app.db();
    db::outbox_requeue(&conn, id, crate::now_ms())
        .map_err(|error| format!("重试失败：{error}"))?;
    Ok(json!({ "ok": true }))
}

/// 删除发件箱记录
pub fn delete(app: &Arc<App>, params: &Value) -> Result<Value, String> {
    let id = crate::param_int(params, "id", 0);
    let conn = app.db();
    db::outbox_delete(&conn, id).map_err(|error| format!("删除失败：{error}"))?;
    Ok(json!({ "ok": true }))
}

/* ---------------- 草稿 ---------------- */

pub fn draft_list(app: &Arc<App>) -> Result<Value, String> {
    let conn = app.db();
    let items = db::draft_list(&conn).map_err(|error| format!("读取草稿失败：{error}"))?;
    Ok(json!({ "items": items }))
}

pub fn draft_save(app: &Arc<App>, params: &Value) -> Result<Value, String> {
    let draft: Draft = serde_json::from_value(params.clone()).map_err(|error| format!("草稿参数非法：{error}"))?;
    if draft.account_id <= 0 {
        return Err("草稿缺少账户".into());
    }
    let mut draft = draft;
    let conn = app.db();
    let id = db::draft_save(&conn, &draft).map_err(|error| format!("保存草稿失败：{error}"))?;
    draft.id = id;
    Ok(json!({ "id": id, "updatedAt": draft.updated_at }))
}

pub fn draft_delete(app: &Arc<App>, params: &Value) -> Result<Value, String> {
    let id = crate::param_int(params, "id", 0);
    let conn = app.db();
    db::draft_delete(&conn, id).map_err(|error| format!("删除草稿失败：{error}"))?;
    Ok(json!({ "ok": true }))
}
