//! IMAP 客户端：连接、列出文件夹、增量拉取邮件头、按需取正文、旗标与移动。
//!
//! 每个操作都是一条独立连接（同步、读正文、改旗标各自用完即关），
//! 实现简单，也避免长时间占用服务器连接数；代价是每次多一次登录，
//! 对个人邮箱的使用频率足够。

use std::collections::HashSet;
use std::time::Duration;

use async_imap::imap_proto::NameAttribute;
use async_imap::types::{Flag, Name, Uid};
use async_imap::{Client, Session};
use futures_util::TryStreamExt;

use crate::stream::Stream;
use crate::tls;

/// 单条命令超时
const COMMAND_TIMEOUT: Duration = Duration::from_secs(90);
/// 取正文超时（大附件可能较慢）
const BODY_TIMEOUT: Duration = Duration::from_secs(180);

/// 登录参数
#[derive(Debug, Clone)]
pub struct Login {
    pub host: String,
    pub port: u16,
    /// tls / starttls / none
    pub security: String,
    pub username: String,
    pub password: String,
}

/// 服务器文件夹
#[derive(Debug, Clone)]
pub struct RemoteMailbox {
    pub name: String,
    pub delimiter: String,
    /// inbox / sent / drafts / trash / junk / archive / flagged / all / custom
    pub role: String,
    pub selectable: bool,
}

/// 服务器邮件的头部信息
#[derive(Debug, Clone)]
pub struct RemoteHeader {
    pub uid: u32,
    pub seen: bool,
    pub flagged: bool,
    pub answered: bool,
    pub draft: bool,
    pub internal_date: i64,
    pub size: i64,
    pub raw: Vec<u8>,
    /// 服务器没返回头部时的兜底信息
    pub fallback: Option<EnvelopeFallback>,
}

/// 信封兜底（部分服务器对 HEADER.FIELDS 返回空）
#[derive(Debug, Clone, Default)]
pub struct EnvelopeFallback {
    pub subject: String,
    pub from_name: String,
    pub from_addr: String,
    pub to: Vec<String>,
    pub cc: Vec<String>,
    pub date: i64,
    pub message_id: String,
}

/// 已登录的 IMAP 会话
pub struct ImapClient {
    session: Session<Stream>,
    /// 是否支持 MOVE 扩展
    pub supports_move: bool,
}

impl ImapClient {
    /// 连接并登录
    pub async fn open(login: &Login) -> Result<Self, String> {
        let stream = match login.security.as_str() {
            "none" => {
                let tcp = tls::connect_plain(&login.host, login.port).await?;
                Stream::Plain(tcp)
            }
            "starttls" => {
                let tcp = tls::connect_plain(&login.host, login.port).await?;
                let mut client = Client::new(Stream::Plain(tcp));
                run_starttls(&mut client).await?;
                let raw = client.into_inner();
                let Stream::Plain(tcp) = raw else {
                    return Err("STARTTLS 升级失败：连接类型异常".into());
                };
                let tls_stream = tls::wrap(&login.host, tcp).await?;
                Stream::Tls(Box::new(tls_stream))
            }
            _ => {
                let tls_stream = tls::connect(&login.host, login.port).await?;
                Stream::Tls(Box::new(tls_stream))
            }
        };

        let client = Client::new(stream);
        let mut session = tokio::time::timeout(
            COMMAND_TIMEOUT,
            client.login(login.username.as_str(), login.password.as_str()),
        )
        .await
        .map_err(|_| "登录超时".to_string())?
        .map_err(|(error, _)| format!("登录失败：{error}"))?;

        let capabilities = tokio::time::timeout(COMMAND_TIMEOUT, session.capabilities())
            .await
            .map_err(|_| "读取服务器能力超时".to_string())?
            .map_err(|error| format!("读取服务器能力失败：{error}"))?;
        let supports_move = capabilities.has_str("MOVE");
        // 163 / 126 等国内邮箱要求客户端先「报到」（RFC 2971 ID），
        // 否则 SELECT 会被拒（返回 Unsafe Login），只留 STATUS 可用。
        if capabilities.has_str("ID") {
            let identification = [
                ("name", Some("DBX Mail")),
                ("version", Some(env!("CARGO_PKG_VERSION"))),
                ("vendor", Some("mjj3610")),
            ];
            let _ = tokio::time::timeout(COMMAND_TIMEOUT, session.id(identification)).await;
        }

        Ok(Self {
            session,
            supports_move,
        })
    }

    /// 列出可选择的文件夹
    pub async fn list(&mut self) -> Result<Vec<RemoteMailbox>, String> {
        let names: Vec<Name> = tokio::time::timeout(COMMAND_TIMEOUT, async {
            self.session
                .list(None, Some("*"))
                .await
                .map_err(|error| format!("读取文件夹失败：{error}"))?
                .try_collect::<Vec<_>>()
                .await
                .map_err(|error| format!("读取文件夹失败：{error}"))
        })
        .await
        .map_err(|_| "读取文件夹超时".to_string())??;

        let mut mailboxes = Vec::new();
        for name in names {
            let raw_name = name.name().to_string();
            let decoded = decode_utf7(&raw_name);
            let delimiter = name.delimiter().unwrap_or("/").to_string();
            let selectable = !name
                .attributes()
                .iter()
                .any(|attr| matches!(attr, NameAttribute::NoSelect));
            let role = role_of(name.attributes(), &decoded);
            mailboxes.push(RemoteMailbox {
                name: decoded,
                delimiter,
                role,
                selectable,
            });
        }
        // INBOX 永远排第一
        mailboxes.sort_by_key(|mailbox| (mailbox.role != "inbox", role_rank(&mailbox.role), mailbox.name.clone()));
        Ok(mailboxes)
    }

    /// 选择文件夹（`readonly` 为真时用 EXAMINE，不会因取正文而置已读）
    ///
    /// 先按 mUTF-7 发；个别服务器返回的是原始 UTF-8 名字、不认编码版，
    /// 这时退回原名再试一次，两类服务器都能用。
    pub async fn select(&mut self, mailbox: &str, readonly: bool) -> Result<(u32, u32), String> {
        let wire = encode_utf7(mailbox);
        match self.select_wire(&wire, mailbox, readonly).await {
            Ok(value) => Ok(value),
            Err(first) if wire != mailbox => match self.select_wire(mailbox, mailbox, readonly).await {
                Ok(value) => Ok(value),
                Err(_) => Err(first),
            },
            Err(error) => Err(error),
        }
    }

    async fn select_wire(
        &mut self,
        wire: &str,
        label: &str,
        readonly: bool,
    ) -> Result<(u32, u32), String> {
        let result = tokio::time::timeout(COMMAND_TIMEOUT, async {
            if readonly {
                self.session.examine(wire).await
            } else {
                self.session.select(wire).await
            }
        })
        .await
        .map_err(|_| "选择文件夹超时".to_string())?
        .map_err(|error| format!("选择文件夹「{label}」失败：{error}"))?;
        Ok((result.exists, result.uid_validity.unwrap_or(0)))
    }

    /// 读取文件夹计数
    pub async fn status(&mut self, mailbox: &str) -> Result<(i64, i64), String> {
        let wire = encode_utf7(mailbox);
        // 错误里不带文件夹名：调用方（同步流程）会统一加前缀，避免重复
        let attempt = self.status_wire(&wire).await;
        match attempt {
            Ok(value) => Ok(value),
            Err(first) if wire != mailbox => self.status_wire(mailbox).await.or(Err(first)),
            Err(error) => Err(error),
        }
    }

    async fn status_wire(&mut self, wire: &str) -> Result<(i64, i64), String> {
        let result = tokio::time::timeout(COMMAND_TIMEOUT, self.session.status(wire, "(MESSAGES UNSEEN)"))
            .await
            .map_err(|_| "读取文件夹状态超时".to_string())?
            .map_err(|error| format!("读取文件夹状态失败：{error}"))?;
        Ok((result.exists as i64, result.unseen.unwrap_or(0) as i64))
    }

    /// 增量拉取邮件头。
    ///
    /// `last_uid` 为 0 时取最近 `limit` 封；否则只取 UID 更大的邮件。
    pub async fn fetch_headers(
        &mut self,
        mailbox: &str,
        last_uid: u32,
        limit: usize,
    ) -> Result<Vec<RemoteHeader>, String> {
        self.select(mailbox, true).await?;

        let all: HashSet<Uid> = tokio::time::timeout(COMMAND_TIMEOUT, self.session.uid_search("ALL"))
            .await
            .map_err(|_| "列出邮件超时".to_string())?
            .map_err(|error| format!("列出邮件失败：{error}"))?;
        let mut uids: Vec<u32> = all.into_iter().collect();
        uids.sort_unstable();
        if last_uid > 0 {
            uids.retain(|uid| *uid > last_uid);
        } else if uids.len() > limit {
            uids = uids.split_off(uids.len() - limit);
        }

        let mut headers = Vec::new();
        for chunk in uids.chunks(40) {
            let set = chunk
                .iter()
                .map(|uid| uid.to_string())
                .collect::<Vec<_>>()
                .join(",");
            let query = "(UID FLAGS INTERNALDATE RFC822.SIZE ENVELOPE \
                BODY.PEEK[HEADER.FIELDS (FROM TO CC SUBJECT DATE MESSAGE-ID REFERENCES IN-REPLY-TO)])";
            let fetched: Vec<async_imap::types::Fetch> = tokio::time::timeout(
                COMMAND_TIMEOUT,
                async {
                    self.session
                        .uid_fetch(&set, query)
                        .await
                        .map_err(|error| format!("拉取邮件失败：{error}"))?
                        .try_collect::<Vec<_>>()
                        .await
                        .map_err(|error| format!("拉取邮件失败：{error}"))
                },
            )
            .await
            .map_err(|_| "拉取邮件超时".to_string())??;

            for fetch in fetched {
                let Some(uid) = fetch.uid else { continue };
                let mut seen = false;
                let mut flagged = false;
                let mut answered = false;
                let mut draft = false;
                for flag in fetch.flags() {
                    match flag {
                        Flag::Seen => seen = true,
                        Flag::Flagged => flagged = true,
                        Flag::Answered => answered = true,
                        Flag::Draft => draft = true,
                        _ => {}
                    }
                }
                let internal_date = fetch
                    .internal_date()
                    .map(|value| value.timestamp_millis())
                    .unwrap_or_else(crate::now_ms);
                let raw = fetch.header().map(|bytes| bytes.to_vec()).unwrap_or_default();
                let fallback = fetch.envelope().map(envelope_fallback);
                headers.push(RemoteHeader {
                    uid,
                    seen,
                    flagged,
                    answered,
                    draft,
                    internal_date,
                    size: fetch.size.map(|value| value as i64).unwrap_or(0),
                    raw,
                    fallback,
                });
            }
        }
        Ok(headers)
    }

    /// 拉取最近邮件的旗标（用于双向同步）
    pub async fn fetch_recent_flags(
        &mut self,
        mailbox: &str,
        limit: usize,
    ) -> Result<Vec<(u32, bool, bool, bool)>, String> {
        self.select(mailbox, true).await?;
        let all: HashSet<Uid> = tokio::time::timeout(COMMAND_TIMEOUT, self.session.uid_search("ALL"))
            .await
            .map_err(|_| "列出邮件超时".to_string())?
            .map_err(|error| format!("列出邮件失败：{error}"))?;
        let mut uids: Vec<u32> = all.into_iter().collect();
        uids.sort_unstable();
        if uids.len() > limit {
            uids = uids.split_off(uids.len() - limit);
        }
        if uids.is_empty() {
            return Ok(Vec::new());
        }
        let set = uids.iter().map(|uid| uid.to_string()).collect::<Vec<_>>().join(",");
        let fetched: Vec<async_imap::types::Fetch> = tokio::time::timeout(COMMAND_TIMEOUT, async {
            self.session
                .uid_fetch(&set, "(UID FLAGS)")
                .await
                .map_err(|error| format!("读取旗标失败：{error}"))?
                .try_collect::<Vec<_>>()
                .await
                .map_err(|error| format!("读取旗标失败：{error}"))
        })
        .await
        .map_err(|_| "读取旗标超时".to_string())??;

        let mut result = Vec::new();
        for fetch in fetched {
            let Some(uid) = fetch.uid else { continue };
            let (mut seen, mut flagged, mut answered) = (false, false, false);
            for flag in fetch.flags() {
                match flag {
                    Flag::Seen => seen = true,
                    Flag::Flagged => flagged = true,
                    Flag::Answered => answered = true,
                    _ => {}
                }
            }
            result.push((uid, seen, flagged, answered));
        }
        Ok(result)
    }

    /// 取整封原始邮件
    pub async fn fetch_raw(&mut self, mailbox: &str, uid: u32) -> Result<Vec<u8>, String> {
        self.select(mailbox, true).await?;
        let mut fetched: Vec<async_imap::types::Fetch> =
            tokio::time::timeout(BODY_TIMEOUT, async {
                self.session
                    .uid_fetch(uid.to_string(), "(BODY.PEEK[])")
                    .await
                    .map_err(|error| format!("下载邮件失败：{error}"))?
                    .try_collect::<Vec<_>>()
                    .await
                    .map_err(|error| format!("下载邮件失败：{error}"))
            })
            .await
            .map_err(|_| "下载邮件超时".to_string())??;
        fetched
            .pop()
            .and_then(|fetch| fetch.body().map(|bytes| bytes.to_vec()))
            .ok_or_else(|| "服务器没有返回邮件内容".to_string())
    }

    /// 设置旗标（`add` / `remove` 为 IMAP 旗标名，如 `\\Seen`）
    pub async fn store_flags(
        &mut self,
        mailbox: &str,
        uid: u32,
        add: &[&str],
        remove: &[&str],
    ) -> Result<(), String> {
        self.select(mailbox, false).await?;
        if !add.is_empty() {
            let query = format!("+FLAGS ({})", add.join(" "));
            tokio::time::timeout(COMMAND_TIMEOUT, async {
                let mut stream = self
                    .session
                    .uid_store(uid.to_string(), &query)
                    .await
                    .map_err(|error| format!("设置旗标失败：{error}"))?;
                while let Some(item) = stream.try_next().await.map_err(|error| format!("设置旗标失败：{error}"))? {
                    let _ = item;
                }
                Ok::<(), String>(())
            })
            .await
            .map_err(|_| "设置旗标超时".to_string())??;
        }
        if !remove.is_empty() {
            let query = format!("-FLAGS ({})", remove.join(" "));
            tokio::time::timeout(COMMAND_TIMEOUT, async {
                let mut stream = self
                    .session
                    .uid_store(uid.to_string(), &query)
                    .await
                    .map_err(|error| format!("设置旗标失败：{error}"))?;
                while let Some(item) = stream.try_next().await.map_err(|error| format!("设置旗标失败：{error}"))? {
                    let _ = item;
                }
                Ok::<(), String>(())
            })
            .await
            .map_err(|_| "设置旗标超时".to_string())??;
        }
        Ok(())
    }

    /// 移动邮件（优先 MOVE，其次 COPY + 删除）
    pub async fn move_message(&mut self, from: &str, uid: u32, to: &str) -> Result<(), String> {
        self.select(from, false).await?;
        // `select` 只处理了源文件夹，目标名要单独编码，同样带原名兜底
        let to_wire = encode_utf7(to);
        match self.copy_to(&to_wire, to, uid).await {
            Ok(()) => {}
            Err(first) if to_wire != to => self.copy_to(to, to, uid).await.or(Err(first))?,
            Err(error) => return Err(error),
        }
        if self.supports_move {
            return Ok(());
        }
        self.store_flags(from, uid, &["\\Deleted"], &[]).await?;
        tokio::time::timeout(COMMAND_TIMEOUT, async {
            let mut stream = Box::pin(
                self.session
                    .uid_expunge(uid.to_string())
                    .await
                    .map_err(|error| format!("删除原邮件失败：{error}"))?,
            );
            while let Some(item) = stream.try_next().await.map_err(|error| format!("删除原邮件失败：{error}"))? {
                let _ = item;
            }
            Ok::<(), String>(())
        })
        .await
        .map_err(|_| "删除原邮件超时".to_string())??;
        Ok(())
    }

    /// 把邮件复制/移动到目标文件夹（服务器支持 MOVE 时用 MOVE）
    async fn copy_to(&mut self, wire: &str, label: &str, uid: u32) -> Result<(), String> {
        if self.supports_move {
            tokio::time::timeout(COMMAND_TIMEOUT, self.session.uid_mv(uid.to_string(), wire))
                .await
                .map_err(|_| "移动邮件超时".to_string())?
                .map_err(|error| format!("移动邮件到「{label}」失败：{error}"))
        } else {
            tokio::time::timeout(COMMAND_TIMEOUT, self.session.uid_copy(uid.to_string(), wire))
                .await
                .map_err(|_| "复制邮件超时".to_string())?
                .map_err(|error| format!("复制邮件到「{label}」失败：{error}"))
        }
    }

    /// 永久删除（垃圾箱内彻底删除）
    pub async fn delete_message(&mut self, mailbox: &str, uid: u32) -> Result<(), String> {
        self.select(mailbox, false).await?;
        tokio::time::timeout(COMMAND_TIMEOUT, async {
            let mut stream = self
                .session
                .uid_store(uid.to_string(), "+FLAGS (\\Deleted)")
                .await
                .map_err(|error| format!("删除邮件失败：{error}"))?;
            while let Some(item) = stream.try_next().await.map_err(|error| format!("删除邮件失败：{error}"))? {
                let _ = item;
            }
            drop(stream);
            let mut expunge = Box::pin(
                self.session
                    .uid_expunge(uid.to_string())
                    .await
                    .map_err(|error| format!("彻底删除失败：{error}"))?,
            );
            while let Some(item) = expunge.try_next().await.map_err(|error| format!("彻底删除失败：{error}"))? {
                let _ = item;
            }
            Ok::<(), String>(())
        })
        .await
        .map_err(|_| "删除邮件超时".to_string())??;
        Ok(())
    }

    /// 追加到服务器文件夹（发送后写「已发送」）
    pub async fn append(&mut self, mailbox: &str, raw: &[u8]) -> Result<(), String> {
        let wire = encode_utf7(mailbox);
        match self.append_wire(&wire, mailbox, raw).await {
            Ok(()) => Ok(()),
            // 超时不再换名重试，避免同一封邮件被写进去两次
            Err(error) if error.ends_with("超时") => Err(error),
            Err(first) if wire != mailbox => self.append_wire(mailbox, mailbox, raw).await.or(Err(first)),
            Err(error) => Err(error),
        }
    }

    async fn append_wire(&mut self, wire: &str, label: &str, raw: &[u8]) -> Result<(), String> {
        tokio::time::timeout(BODY_TIMEOUT, self.session.append(wire, Some("(\\Seen)"), None, raw))
            .await
            .map_err(|_| format!("写入「{label}」超时"))?
            .map_err(|error| format!("写入「{label}」失败：{error}"))
    }

    /// 退出登录（失败不影响调用方）
    pub async fn logout(mut self) {
        let _ = tokio::time::timeout(Duration::from_secs(10), self.session.logout()).await;
    }
}

/* ---------------- STARTTLS ---------------- */

async fn run_starttls(client: &mut Client<Stream>) -> Result<(), String> {
    tokio::time::timeout(
        COMMAND_TIMEOUT,
        client.run_command_and_check_ok("STARTTLS", None),
    )
    .await
    .map_err(|_| "STARTTLS 超时".to_string())?
    .map_err(|error| format!("服务器不支持 STARTTLS：{error}"))
}

/* ---------------- 文件夹角色 ---------------- */

fn role_of(attributes: &[NameAttribute<'_>], name: &str) -> String {
    for attribute in attributes {
        let role = match attribute {
            NameAttribute::Sent => "sent",
            NameAttribute::Drafts => "drafts",
            NameAttribute::Trash => "trash",
            NameAttribute::Junk => "junk",
            NameAttribute::Archive => "archive",
            NameAttribute::Flagged => "flagged",
            NameAttribute::All => "all",
            _ => "",
        };
        if !role.is_empty() {
            return role.to_string();
        }
    }
    let lower = name.to_lowercase();
    let compact = lower.replace([' ', '_', '-'], "");
    if compact == "inbox" {
        return "inbox".into();
    }
    if compact.contains("sent") || lower.contains("已发送") || lower.contains("已寄") {
        return "sent".into();
    }
    if compact.contains("draft") || lower.contains("草稿") {
        return "drafts".into();
    }
    if compact.contains("trash") || compact.contains("deleted") || lower.contains("已删除") || lower.contains("废纸") {
        return "trash".into();
    }
    if compact.contains("junk") || compact.contains("spam") || lower.contains("垃圾") || lower.contains("广告") {
        return "junk".into();
    }
    if compact.contains("archive") || lower.contains("存档") || lower.contains("归档") {
        return "archive".into();
    }
    "custom".into()
}

fn role_rank(role: &str) -> i64 {
    match role {
        "inbox" => 0,
        "sent" => 1,
        "drafts" => 2,
        "archive" => 3,
        "flagged" => 4,
        "trash" => 5,
        "junk" => 6,
        "all" => 7,
        _ => 8,
    }
}

/* ---------------- 信封兜底 ---------------- */

fn envelope_fallback(envelope: &async_imap::imap_proto::Envelope<'_>) -> EnvelopeFallback {
    let decode = |value: &[u8]| String::from_utf8_lossy(value).to_string();
    let subject = envelope.subject.as_ref().map(|value| decode(value)).unwrap_or_default();
    let (from_name, from_addr) = envelope
        .from
        .as_ref()
        .and_then(|list| list.first())
        .map(|address| {
            let mailbox = address
                .mailbox
                .as_ref()
                .map(|value| decode(value))
                .unwrap_or_default();
            let host = address.host.as_ref().map(|value| decode(value)).unwrap_or_default();
            let name = address.name.as_ref().map(|value| decode(value)).unwrap_or_default();
            (name, if host.is_empty() { mailbox } else { format!("{mailbox}@{host}") })
        })
        .unwrap_or_default();
    let map_addrs = |list: &Option<Vec<async_imap::imap_proto::Address<'_>>>| -> Vec<String> {
        list.as_ref()
            .map(|items| {
                items
                    .iter()
                    .filter_map(|address| {
                        let mailbox = address.mailbox.as_ref().map(|value| decode(value))?;
                        let host = address.host.as_ref().map(|value| decode(value)).unwrap_or_default();
                        let email = if host.is_empty() { mailbox } else { format!("{mailbox}@{host}") };
                        let name = address.name.as_ref().map(|value| decode(value)).unwrap_or_default();
                        Some(if name.is_empty() { email } else { format!("{name} <{email}>") })
                    })
                    .collect()
            })
            .unwrap_or_default()
    };
    let date = envelope
        .date
        .as_ref()
        .and_then(|value| chrono::DateTime::parse_from_rfc2822(&decode(value)).ok())
        .map(|value| value.timestamp_millis())
        .unwrap_or(0);
    EnvelopeFallback {
        subject,
        from_name,
        from_addr,
        to: map_addrs(&envelope.to),
        cc: map_addrs(&envelope.cc),
        date,
        message_id: envelope
            .message_id
            .as_ref()
            .map(|value| decode(value).trim_matches(|c| c == '<' || c == '>').to_string())
            .unwrap_or_default(),
    }
}

/* ---------------- 修改版 UTF-7（RFC 3501 5.1.3） ---------------- */

/// mUTF-7 的 base64 变体字母表（第 62/63 位是 `+` 与 `,`）
const UTF7_ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+,";

/// 编码邮箱名为修改版 UTF-7
///
/// 服务器只认线上编码（如「已发送」→ `&XfJT0ZAB-`），中文文件夹名必须转换后再发命令，
/// 纯 ASCII 名字原样返回。`&` 本身写作 `&-`。
pub fn encode_utf7(input: &str) -> String {
    if input.is_ascii() && !input.contains('&') {
        return input.to_string();
    }
    let mut output = String::with_capacity(input.len() + 8);
    let mut pending: Vec<u16> = Vec::new();
    for ch in input.chars() {
        if ch == '&' {
            flush_utf7(&mut pending, &mut output);
            output.push_str("&-");
            continue;
        }
        let code = ch as u32;
        if (0x20..=0x7e).contains(&code) {
            flush_utf7(&mut pending, &mut output);
            output.push(ch);
        } else {
            let mut units = [0u16; 2];
            for unit in ch.encode_utf16(&mut units) {
                pending.push(*unit);
            }
        }
    }
    flush_utf7(&mut pending, &mut output);
    output
}

/// 把攒下的 UTF-16 码元按 6 位一组输出成 `&....-`
fn flush_utf7(pending: &mut Vec<u16>, output: &mut String) {
    if pending.is_empty() {
        return;
    }
    output.push('&');
    let mut bits: u32 = 0;
    let mut available: u32 = 0;
    for unit in pending.iter() {
        bits = (bits << 16) | u32::from(*unit);
        available += 16;
        while available >= 6 {
            available -= 6;
            output.push(UTF7_ALPHABET[((bits >> available) & 0x3f) as usize] as char);
        }
    }
    if available > 0 {
        output.push(UTF7_ALPHABET[((bits << (6 - available)) & 0x3f) as usize] as char);
    }
    output.push('-');
    pending.clear();
}

/// 解码邮箱名里的修改版 UTF-7
pub fn decode_utf7(input: &str) -> String {
    if !input.contains('&') {
        return input.to_string();
    }
    let mut output = String::with_capacity(input.len());
    let bytes = input.as_bytes();
    let mut cursor = 0usize;
    while cursor < bytes.len() {
        if bytes[cursor] != b'&' {
            let start = cursor;
            while cursor < bytes.len() && bytes[cursor] != b'&' {
                cursor += 1;
            }
            output.push_str(&input[start..cursor]);
            continue;
        }
        let start = cursor + 1;
        let mut end = start;
        while end < bytes.len() && bytes[end] != b'-' {
            end += 1;
        }
        if end == start {
            output.push('&');
            cursor = end + 1;
            continue;
        }
        let encoded = input[start..end].replace(',', "/");
        match base64_decode_utf16(&encoded) {
            Some(decoded) => output.push_str(&decoded),
            None => output.push_str(&input[cursor..(end + 1).min(bytes.len())]),
        }
        cursor = (end + 1).min(bytes.len());
    }
    output
}

fn base64_decode_utf16(value: &str) -> Option<String> {
    use base64::Engine;
    let mut text = value.to_string();
    while text.len() % 4 != 0 {
        text.push('=');
    }
    let bytes = base64::engine::general_purpose::STANDARD.decode(text).ok()?;
    if bytes.len() % 2 != 0 {
        return None;
    }
    let units: Vec<u16> = bytes
        .chunks(2)
        .map(|pair| u16::from_be_bytes([pair[0], pair[1]]))
        .collect();
    String::from_utf16(&units).ok()
}

#[cfg(test)]
mod tests {
    use super::{decode_utf7, encode_utf7};

    #[test]
    fn decodes_modified_utf7() {
        assert_eq!(decode_utf7("INBOX"), "INBOX");
        assert_eq!(decode_utf7("A&-B"), "A&B");
        assert_eq!(decode_utf7("&AOQ-"), "ä");
        assert_eq!(decode_utf7("&AOQ-t&APw-rk"), "ätürk");
    }

    #[test]
    fn encodes_modified_utf7() {
        // 纯 ASCII 原样
        assert_eq!(encode_utf7("INBOX"), "INBOX");
        assert_eq!(encode_utf7("Sent Messages"), "Sent Messages");
        // `&` 必须写成 `&-`，否则会被当成编码段开头
        assert_eq!(encode_utf7("A&B"), "A&-B");
        assert_eq!(encode_utf7("R&D"), "R&-D");
        // 中文文件夹名（163 / QQ 邮箱的线上名）
        assert_eq!(encode_utf7("已发送"), "&XfJT0ZAB-");
        assert_eq!(encode_utf7("已删除"), "&XfJSIJZk-");
        assert_eq!(encode_utf7("草稿"), "&g0l6Pw-");
        // 混排：ASCII 段不参与编码
        assert_eq!(encode_utf7("已发送 Messages"), "&XfJT0ZAB- Messages");
        assert_eq!(encode_utf7("Re: 测试"), "Re: &bUuL1Q-");
    }

    #[test]
    fn utf7_roundtrip() {
        for name in [
            "INBOX",
            "Sent",
            "已发送",
            "已删除",
            "垃圾邮件",
            "存档",
            "草稿",
            "A&B",
            "项目/2024 归档",
            "日本語フォルダ",
            "emoji 📮 box",
        ] {
            let wire = encode_utf7(name);
            assert_eq!(decode_utf7(&wire), name, "往返失败：{name} → {wire}");
            // 线上编码必须是可见 ASCII 之外全是可打印字符
            assert!(wire.is_ascii(), "线上编码必须是 ASCII：{wire}");
        }
    }
}
