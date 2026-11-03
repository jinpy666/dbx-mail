//! SMTP 投递与 MIME 组包。
//!
//! 邮件正文用 `mail-builder` 生成（UTF-8 编码的头部、正确的 base64 附件），
//! 连接与认证交给 `lettre`；TLS 使用 rustls（内置 Mozilla 根证书），
//! 与 IMAP 的证书策略分开：SMTP 用 lettre 的 Wrapper / Required 两种模式。

use std::time::Duration;

use lettre::address::Envelope;
use lettre::transport::smtp::authentication::Credentials;
use lettre::transport::smtp::client::{Tls, TlsParameters};
use lettre::{AsyncSmtpTransport, AsyncTransport, Tokio1Executor};
use mail_builder::headers::address::Address;
use mail_builder::MessageBuilder;

use crate::model::DraftAttachment;

/// 单个附件上限
const ATTACHMENT_LIMIT: i64 = 25 * 1024 * 1024;
/// 全部附件上限
const ATTACHMENT_TOTAL_LIMIT: i64 = 40 * 1024 * 1024;

/// 待发送邮件
#[derive(Debug, Clone)]
pub struct Outgoing {
    pub from_name: String,
    pub from_email: String,
    pub to: Vec<String>,
    pub cc: Vec<String>,
    pub bcc: Vec<String>,
    pub subject: String,
    pub html: String,
    pub attachments: Vec<DraftAttachment>,
    pub in_reply_to: String,
    pub references: Vec<String>,
    /// 由调用方生成，便于本地记录与线程归并
    pub message_id: String,
}

/// SMTP 登录参数
#[derive(Debug, Clone)]
pub struct SmtpLogin {
    pub host: String,
    pub port: u16,
    /// tls / starttls / none
    pub security: String,
    pub username: String,
    pub password: String,
}

/// 生成原始 MIME 邮件
pub fn build(outgoing: &Outgoing) -> Result<Vec<u8>, String> {
    let to = split_addresses(&outgoing.to);
    if to.is_empty() {
        return Err("收件人不能为空".into());
    }
    let cc = split_addresses(&outgoing.cc);
    let bcc = split_addresses(&outgoing.bcc);

    let mut builder = MessageBuilder::new()
        .message_id(outgoing.message_id.clone())
        .from(Address::new_address(
            non_empty(&outgoing.from_name),
            outgoing.from_email.clone(),
        ))
        .to(Address::new_list(
            to.iter()
                .map(|(name, email)| Address::new_address(name.clone(), email.clone()))
                .collect(),
        ))
        .subject(outgoing.subject.clone());

    if !cc.is_empty() {
        builder = builder.cc(Address::new_list(
            cc.iter()
                .map(|(name, email)| Address::new_address(name.clone(), email.clone()))
                .collect(),
        ));
    }
    if !bcc.is_empty() {
        builder = builder.bcc(Address::new_list(
            bcc.iter()
                .map(|(name, email)| Address::new_address(name.clone(), email.clone()))
                .collect(),
        ));
    }
    if !outgoing.in_reply_to.is_empty() {
        builder = builder.in_reply_to(outgoing.in_reply_to.clone());
    }
    if !outgoing.references.is_empty() {
        builder = builder.references(outgoing.references.clone());
    }

    let html = if outgoing.html.trim().is_empty() {
        "<p></p>".to_string()
    } else {
        outgoing.html.clone()
    };
    let text = crate::mime::html_to_text(&html);
    builder = builder.text_body(text).html_body(html);

    let mut total = 0i64;
    for attachment in &outgoing.attachments {
        let size = std::fs::metadata(&attachment.path)
            .map(|meta| meta.len() as i64)
            .map_err(|error| format!("附件「{}」不可读：{error}", attachment.name))?;
        if size > ATTACHMENT_LIMIT {
            return Err(format!("附件「{}」超过 25 MB 上限", attachment.name));
        }
        total += size;
        if total > ATTACHMENT_TOTAL_LIMIT {
            return Err("附件总大小超过 40 MB 上限".into());
        }
        let bytes = std::fs::read(&attachment.path)
            .map_err(|error| format!("读取附件「{}」失败：{error}", attachment.name))?;
        let mime = if attachment.mime.trim().is_empty() {
            "application/octet-stream".to_string()
        } else {
            attachment.mime.clone()
        };
        builder = builder.attachment(mime, sanitize_filename(&attachment.name), bytes);
    }

    builder
        .write_to_vec()
        .map_err(|error| format!("组装邮件失败：{error}"))
}

/// 通过 SMTP 投递；返回原始邮件字节（用于写入已发送）
pub async fn send(login: &SmtpLogin, outgoing: &Outgoing) -> Result<Vec<u8>, String> {
    let raw = build(outgoing)?;
    let envelope = build_envelope(outgoing)?;

    let tls = match login.security.as_str() {
        "tls" => Tls::Wrapper(
            TlsParameters::new(login.host.clone()).map_err(|error| format!("TLS 配置失败：{error}"))?,
        ),
        "starttls" => Tls::Required(
            TlsParameters::new(login.host.clone()).map_err(|error| format!("TLS 配置失败：{error}"))?,
        ),
        _ => Tls::None,
    };

    let transport: AsyncSmtpTransport<Tokio1Executor> =
        AsyncSmtpTransport::<Tokio1Executor>::builder_dangerous(login.host.clone())
        .port(login.port)
        .tls(tls)
        .credentials(Credentials::new(
            login.username.clone(),
            login.password.clone(),
        ))
            .timeout(Some(Duration::from_secs(90)))
            .build();

    let transport = tokio::time::timeout(
        Duration::from_secs(120),
        transport.send_raw(&envelope, &raw),
    )
    .await
    .map_err(|_| "发送超时".to_string())?
    .map_err(|error| format!("发送失败：{error}"))?;
    let _ = transport;
    Ok(raw)
}

/// 连通性与认证检测
pub async fn test(login: &SmtpLogin) -> Result<(), String> {
    let tls = match login.security.as_str() {
        "tls" => Tls::Wrapper(
            TlsParameters::new(login.host.clone()).map_err(|error| format!("TLS 配置失败：{error}"))?,
        ),
        "starttls" => Tls::Required(
            TlsParameters::new(login.host.clone()).map_err(|error| format!("TLS 配置失败：{error}"))?,
        ),
        _ => Tls::None,
    };
    let transport: AsyncSmtpTransport<Tokio1Executor> =
        AsyncSmtpTransport::<Tokio1Executor>::builder_dangerous(login.host.clone())
        .port(login.port)
        .tls(tls)
            .credentials(Credentials::new(
                login.username.clone(),
                login.password.clone(),
            ))
            .timeout(Some(Duration::from_secs(30)))
            .build();
    tokio::time::timeout(Duration::from_secs(45), transport.test_connection())
        .await
        .map_err(|_| "SMTP 连接超时".to_string())?
        .map_err(|error| format!("SMTP 连接失败：{error}"))?;
    Ok(())
}

/* ---------------- 辅助 ---------------- */

fn build_envelope(outgoing: &Outgoing) -> Result<Envelope, String> {
    let from = outgoing
        .from_email
        .trim()
        .parse::<lettre::Address>()
        .map_err(|error| format!("发件地址非法：{error}"))?;
    let mut recipients = Vec::new();
    for (_, email) in split_addresses(&outgoing.to)
        .into_iter()
        .chain(split_addresses(&outgoing.cc))
        .chain(split_addresses(&outgoing.bcc))
    {
        recipients.push(
            email
                .trim()
                .parse::<lettre::Address>()
                .map_err(|error| format!("收件地址「{email}」非法：{error}"))?,
        );
    }
    if recipients.is_empty() {
        return Err("收件人不能为空".into());
    }
    Envelope::new(Some(from), recipients).map_err(|error| format!("收件人非法：{error}"))
}

/// 把 "名字 <a@b>" / "a@b" 拆成 (Option<name>, email)，并过滤控制字符
fn split_addresses(items: &[String]) -> Vec<(Option<String>, String)> {
    items
        .iter()
        .flat_map(|item| split_one(item))
        .collect()
}

fn split_one(input: &str) -> Vec<(Option<String>, String)> {
    let cleaned = input.replace(['\r', '\n'], " ");
    let mut result = Vec::new();
    let mut depth = 0i32;
    let mut current = String::new();
    for ch in cleaned.chars() {
        match ch {
            '<' => {
                depth += 1;
                current.push(ch);
            }
            '>' => {
                depth -= 1;
                current.push(ch);
            }
            ',' | ';' if depth <= 0 => {
                if !current.trim().is_empty() {
                    result.push(current.trim().to_string());
                }
                current.clear();
            }
            _ => current.push(ch),
        }
    }
    if !current.trim().is_empty() {
        result.push(current.trim().to_string());
    }

    result
        .into_iter()
        .filter_map(|item| {
            if let (Some(start), Some(end)) = (item.find('<'), item.rfind('>')) {
                if end > start {
                    let email = item[start + 1..end].trim().to_string();
                    let name = item[..start].trim().trim_matches('"').trim().to_string();
                    if email.is_empty() {
                        return None;
                    }
                    return Some((non_empty(&name), email));
                }
            }
            let email = item.trim().to_string();
            if email.is_empty() {
                None
            } else {
                Some((None, email))
            }
        })
        .collect()
}

fn non_empty(value: &str) -> Option<String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}

fn sanitize_filename(name: &str) -> String {
    let cleaned: String = name
        .chars()
        .map(|ch| if matches!(ch, '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|') || ch.is_control() {
            '_'
        } else {
            ch
        })
        .collect();
    let trimmed = cleaned.trim().trim_matches('.');
    if trimmed.is_empty() {
        "attachment.bin".into()
    } else {
        trimmed.chars().take(120).collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn splits_addresses() {
        let items = split_addresses(&[
            "Alice <alice@example.com>".into(),
            "bob@example.com, carol@example.com".into(),
        ]);
        assert_eq!(items.len(), 3);
        assert_eq!(items[0].0.as_deref(), Some("Alice"));
        assert_eq!(items[0].1, "alice@example.com");
        assert_eq!(items[1].1, "bob@example.com");
    }

    #[test]
    fn builds_multipart_message() {
        let dir = std::env::temp_dir().join("dbx-mail-test");
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("note.txt");
        std::fs::write(&file, b"attachment body").unwrap();

        let outgoing = Outgoing {
            from_name: "Alice".into(),
            from_email: "alice@example.com".into(),
            to: vec!["Bob <bob@example.com>".into()],
            cc: vec![],
            bcc: vec!["secret@example.com".into()],
            subject: "你好".into(),
            html: "<p>正文</p>".into(),
            attachments: vec![DraftAttachment {
                name: "note.txt".into(),
                path: file.to_string_lossy().to_string(),
                mime: "text/plain".into(),
                size: 15,
            }],
            in_reply_to: "prev@example.com".into(),
            references: vec!["root@example.com".into()],
            message_id: "new@dbx-mail".into(),
        };
        let raw = build(&outgoing).expect("应可组装");
        let text = String::from_utf8_lossy(&raw);
        assert!(text.contains("Subject:"));
        assert!(text.contains("text/plain"));
        assert!(text.contains("note.txt"));
        assert!(text.contains("In-Reply-To: <prev@example.com>"));
        assert!(text.contains("Message-ID: <new@dbx-mail>"));
    }

    #[test]
    fn rejects_empty_recipients() {
        let outgoing = Outgoing {
            from_name: String::new(),
            from_email: "alice@example.com".into(),
            to: vec![],
            cc: vec![],
            bcc: vec![],
            subject: "x".into(),
            html: "<p>x</p>".into(),
            attachments: vec![],
            in_reply_to: String::new(),
            references: vec![],
            message_id: "x@dbx-mail".into(),
        };
        assert!(build(&outgoing).is_err());
    }
}
