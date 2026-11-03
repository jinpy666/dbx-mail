//! 账户管理：预设服务商、新增/修改/删除、连接检测、文件夹发现。

use std::sync::Arc;

use rusqlite::params;
use serde_json::{json, Value};

use crate::db;
use crate::imap::{ImapClient, Login};
use crate::model::{Account, ProviderPreset};
use crate::sync;
use crate::App;

/// 账户颜色（按加入顺序循环，和企鹅邮件一样用彩色圆点区分账户）
const COLORS: [&str; 8] = [
    "#e8660c", "#3584e4", "#2ec27e", "#9141ac", "#e01b24", "#e5a50a", "#2190a4", "#c061cb",
];

/// 常见服务商预设
pub fn presets() -> Vec<ProviderPreset> {
    vec![
        ProviderPreset {
            key: "gmail".into(),
            label: "Gmail".into(),
            domains: vec!["gmail.com".into(), "googlemail.com".into()],
            imap_host: "imap.gmail.com".into(),
            imap_port: 993,
            imap_security: "tls".into(),
            smtp_host: "smtp.gmail.com".into(),
            smtp_port: 587,
            smtp_security: "starttls".into(),
            hint: "需要在 Google 账号中开启两步验证并生成「应用专用密码」".into(),
        },
        ProviderPreset {
            key: "outlook".into(),
            label: "Outlook / Microsoft 365".into(),
            domains: vec!["outlook.com".into(), "hotmail.com".into(), "live.com".into(), "office365.com".into()],
            imap_host: "outlook.office365.com".into(),
            imap_port: 993,
            imap_security: "tls".into(),
            smtp_host: "smtp.office365.com".into(),
            smtp_port: 587,
            smtp_security: "starttls".into(),
            hint: "企业租户可能关闭了 IMAP，或要求使用 OAuth2 / 应用密码".into(),
        },
        ProviderPreset {
            key: "qq".into(),
            label: "QQ 邮箱".into(),
            domains: vec!["qq.com".into(), "foxmail.com".into()],
            imap_host: "imap.qq.com".into(),
            imap_port: 993,
            imap_security: "tls".into(),
            smtp_host: "smtp.qq.com".into(),
            smtp_port: 465,
            smtp_security: "tls".into(),
            hint: "需要在 QQ 邮箱设置中开启 IMAP/SMTP 并使用「授权码」作为密码".into(),
        },
        ProviderPreset {
            key: "exmail".into(),
            label: "腾讯企业邮".into(),
            domains: vec!["exmail.qq.com".into()],
            imap_host: "imap.exmail.qq.com".into(),
            imap_port: 993,
            imap_security: "tls".into(),
            smtp_host: "smtp.exmail.qq.com".into(),
            smtp_port: 465,
            smtp_security: "tls".into(),
            hint: "企业邮通常要求使用客户端专用密码".into(),
        },
        ProviderPreset {
            key: "163".into(),
            label: "网易 163 / 126".into(),
            domains: vec!["163.com".into(), "126.com".into(), "yeah.net".into()],
            imap_host: "imap.163.com".into(),
            imap_port: 993,
            imap_security: "tls".into(),
            smtp_host: "smtp.163.com".into(),
            smtp_port: 465,
            smtp_security: "tls".into(),
            hint: "需要在网页版开启 IMAP/SMTP，并使用客户端授权码".into(),
        },
        ProviderPreset {
            key: "aliyun".into(),
            label: "阿里云邮箱".into(),
            domains: vec!["aliyun.com".into(), "aliyun.cn".into()],
            imap_host: "imap.aliyun.com".into(),
            imap_port: 993,
            imap_security: "tls".into(),
            smtp_host: "smtp.aliyun.com".into(),
            smtp_port: 465,
            smtp_security: "tls".into(),
            hint: "使用邮箱登录密码或客户端专用密码".into(),
        },
        ProviderPreset {
            key: "icloud".into(),
            label: "iCloud 邮箱".into(),
            domains: vec!["icloud.com".into(), "me.com".into(), "mac.com".into()],
            imap_host: "imap.mail.me.com".into(),
            imap_port: 993,
            imap_security: "tls".into(),
            smtp_host: "smtp.mail.me.com".into(),
            smtp_port: 587,
            smtp_security: "starttls".into(),
            hint: "需要 Apple ID 的 App 专用密码".into(),
        },
        ProviderPreset {
            key: "yahoo".into(),
            label: "Yahoo Mail".into(),
            domains: vec!["yahoo.com".into()],
            imap_host: "imap.mail.yahoo.com".into(),
            imap_port: 993,
            imap_security: "tls".into(),
            smtp_host: "smtp.mail.yahoo.com".into(),
            smtp_port: 465,
            smtp_security: "tls".into(),
            hint: "需要生成 App Password".into(),
        },
    ]
}

/// 按邮箱域名匹配预设
pub fn preset_for(email: &str) -> Option<ProviderPreset> {
    let domain = email.rsplit('@').next().unwrap_or("").to_lowercase();
    presets().into_iter().find(|preset| {
        preset
            .domains
            .iter()
            .any(|value| domain == *value || domain.ends_with(&format!(".{value}")))
    })
}

/// 从请求参数构造账户（不含密码）
pub fn account_from_params(params: &Value, id: i64) -> Result<Account, String> {
    let email = crate::param_str(params, "email").trim().to_string();
    if email.is_empty() || !email.contains('@') {
        return Err("请填写完整的邮箱地址".into());
    }
    let mut imap_host = crate::param_str(params, "imapHost").trim().to_string();
    let mut smtp_host = crate::param_str(params, "smtpHost").trim().to_string();
    let preset = preset_for(&email);
    if (imap_host.is_empty() || smtp_host.is_empty()) && preset.is_none() {
        return Err("请填写 IMAP 与 SMTP 服务器地址".into());
    }
    if let Some(preset) = &preset {
        if imap_host.is_empty() {
            imap_host = preset.imap_host.clone();
        }
        if smtp_host.is_empty() {
            smtp_host = preset.smtp_host.clone();
        }
    }
    let username = {
        let value = crate::param_str(params, "username").trim().to_string();
        if value.is_empty() {
            email.clone()
        } else {
            value
        }
    };
    let imap_port = crate::param_int(
        params,
        "imapPort",
        preset.as_ref().map(|item| item.imap_port as i64).unwrap_or(993),
    )
    .clamp(1, 65535) as u16;
    let smtp_port = crate::param_int(
        params,
        "smtpPort",
        preset.as_ref().map(|item| item.smtp_port as i64).unwrap_or(465),
    )
    .clamp(1, 65535) as u16;
    let imap_security = normalize_security(&{
        let value = crate::param_str(params, "imapSecurity");
        if value.is_empty() {
            preset.as_ref().map(|item| item.imap_security.clone()).unwrap_or_else(|| "tls".into())
        } else {
            value
        }
    });
    let smtp_security = normalize_security(&{
        let value = crate::param_str(params, "smtpSecurity");
        if value.is_empty() {
            preset.as_ref().map(|item| item.smtp_security.clone()).unwrap_or_else(|| "tls".into())
        } else {
            value
        }
    });
    let display_name = {
        let value = crate::param_str(params, "displayName").trim().to_string();
        if value.is_empty() {
            email.split('@').next().unwrap_or("").to_string()
        } else {
            value
        }
    };
    Ok(Account {
        id,
        email,
        display_name,
        username,
        imap_host,
        imap_port,
        imap_security,
        smtp_host,
        smtp_port,
        smtp_security,
        signature: crate::param_str(params, "signature"),
        color: {
            let value = crate::param_str(params, "color");
            if value.is_empty() {
                COLORS[0].to_string()
            } else {
                value
            }
        },
        sync_enabled: params
            .get("syncEnabled")
            .and_then(Value::as_bool)
            .unwrap_or(true),
        sync_interval: crate::param_int(params, "syncInterval", 5).clamp(0, 240),
        last_sync_at: 0,
        last_error: String::new(),
    })
}

fn normalize_security(value: &str) -> String {
    match value.to_lowercase().as_str() {
        "starttls" => "starttls".into(),
        "none" | "plain" => "none".into(),
        _ => "tls".into(),
    }
}

/// 新增账户：校验 → 保存密码 → 写库 → 尝试发现文件夹
pub fn add(app: Arc<App>, params: &Value) -> Result<Value, String> {
    let account = account_from_params(params, 0)?;
    let password = crate::param_str(params, "password");
    if password.trim().is_empty() {
        return Err("请填写邮箱密码或授权码".into());
    }

    {
        let conn = app.db();
        if db::account_by_email(&conn, &account.email)
            .map_err(|error| format!("读取账户失败：{error}"))?
            .is_some()
        {
            return Err("这个邮箱已经添加过了".into());
        }
    }

    if params.get("verify").and_then(Value::as_bool).unwrap_or(true) {
        app.rt
            .block_on(sync::test_account(&account, &password))
            .map_err(|error| format!("连接检测失败：{error}"))?;
    }

    let reference = format!("mail:{}", account.email);
    let vault = app
        .secrets
        .save(&reference, &password)
        .map_err(|error| format!("保存密码失败：{error}"))?;

    let mut account = account;
    let color = {
        let conn = app.db();
        let count: i64 = conn
            .query_row("SELECT COUNT(*) FROM accounts", [], |row| row.get(0))
            .unwrap_or(0);
        COLORS[(count as usize) % COLORS.len()].to_string()
    };
    account.color = color;

    let id = {
        let conn = app.db();
        db::account_insert(&conn, &account, &reference)
            .map_err(|error| format!("保存账户失败：{error}"))?
    };
    account.id = id;

    // 文件夹发现失败不阻塞新增：可能只是暂时离线
    let mut warnings = Vec::new();
    if let Err(error) = discover(app.clone(), id) {
        warnings.push(format!("文件夹尚未同步：{error}"));
    }

    Ok(json!({
        "account": account,
        "vault": vault,
        "warnings": warnings,
    }))
}

/// 修改账户（可选更新密码）
pub fn update(app: Arc<App>, params: &Value) -> Result<Value, String> {
    let id = crate::param_int(params, "id", 0);
    if id <= 0 {
        return Err("缺少账户 ID".into());
    }
    let mut account = account_from_params(params, id)?;
    {
        let conn = app.db();
        let existing = db::account_get(&conn, id)
            .map_err(|error| format!("读取账户失败：{error}"))?
            .ok_or_else(|| "账户不存在".to_string())?;
        if account.color.is_empty() {
            account.color = existing.color;
        }
        if !params.get("signature").is_some() {
            account.signature = existing.signature;
        }
        db::account_update(&conn, &account).map_err(|error| format!("保存账户失败：{error}"))?;
    }
    let password = crate::param_str(params, "password");
    if !password.trim().is_empty() {
        let reference = format!("mail:{}", account.email);
        app.secrets
            .save(&reference, &password)
            .map_err(|error| format!("保存密码失败：{error}"))?;
    }
    Ok(json!({ "account": account }))
}

/// 删除账户：本地缓存、密码一并清理
pub fn remove(app: Arc<App>, params: &Value) -> Result<Value, String> {
    let id = crate::param_int(params, "id", 0);
    let account = {
        let conn = app.db();
        db::account_get(&conn, id)
            .map_err(|error| format!("读取账户失败：{error}"))?
            .ok_or_else(|| "账户不存在".to_string())?
    };
    app.secrets.delete(&format!("mail:{}", account.email));
    {
        let conn = app.db();
        db::account_delete(&conn, id).map_err(|error| format!("删除账户失败：{error}"))?;
    }
    let _ = std::fs::remove_dir_all(app.data_dir.join("raw").join(id.to_string()));
    Ok(json!({ "deleted": true }))
}

/// 连接检测（不写库）
pub fn test(app: Arc<App>, params: &Value) -> Result<Value, String> {
    let account = account_from_params(params, 0)?;
    let password = crate::param_str(params, "password");
    if password.trim().is_empty() {
        return Err("请填写密码或授权码".into());
    }
    let lines = app
        .rt
        .block_on(sync::test_account(&account, &password))
        .map_err(|error| format!("连接失败：{error}"))?;
    Ok(json!({ "ok": true, "lines": lines }))
}

/// 发现并保存文件夹（新增账户后调用，也可手动重试）
pub fn discover(app: Arc<App>, account_id: i64) -> Result<Value, String> {
    let account = {
        let conn = app.db();
        db::account_get(&conn, account_id)
            .map_err(|error| format!("读取账户失败：{error}"))?
            .ok_or_else(|| "账户不存在".to_string())?
    };
    let password = app.load_password(account_id)?;
    let login = Login {
        host: account.imap_host.clone(),
        port: account.imap_port,
        security: account.imap_security.clone(),
        username: account.username.clone(),
        password,
    };
    let remote = app
        .rt
        .block_on(async {
            let mut client = ImapClient::open(&login).await?;
            let mailboxes = client.list().await?;
            let mut counts = Vec::new();
            for mailbox in mailboxes.iter().filter(|item| item.selectable) {
                if let Ok(value) = client.status(&mailbox.name).await {
                    counts.push((mailbox.name.clone(), value));
                }
            }
            client.logout().await;
            Ok::<_, String>((mailboxes, counts))
        })?;

    let conn = app.db();
    for (index, mailbox) in remote.0.iter().enumerate() {
        let _ = db::mailbox_upsert(
            &conn,
            account_id,
            &mailbox.name,
            &mailbox.delimiter,
            &mailbox.role,
            mailbox.selectable,
            index as i64,
        );
    }
    for (name, (total, unread)) in &remote.1 {
        let id: Option<i64> = conn
            .query_row(
                "SELECT id FROM mailboxes WHERE account_id = ?1 AND name = ?2",
                params![account_id, name],
                |row| row.get(0),
            )
            .ok();
        if let Some(id) = id {
            let _ = db::mailbox_set_counts(&conn, id, *total, *unread);
        }
    }
    let list = db::mailbox_list(&conn, account_id).map_err(|error| format!("读取文件夹失败：{error}"))?;
    Ok(json!({ "mailboxes": list }))
}

/// 按角色取文件夹 id（背景同步用）
pub fn mailbox_ids_for(conn: &rusqlite::Connection, account_id: i64, roles: &[&str]) -> Vec<i64> {
    let mut ids = Vec::new();
    for role in roles {
        if let Ok(id) = conn.query_row(
            "SELECT id FROM mailboxes WHERE account_id = ?1 AND role = ?2 AND selectable = 1 LIMIT 1",
            params![account_id, role],
            |row| row.get::<_, i64>(0),
        ) {
            ids.push(id);
        }
    }
    ids
}
