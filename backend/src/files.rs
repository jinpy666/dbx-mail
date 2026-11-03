//! 文件系统交互：目录浏览、附件落盘、.eml 导入导出、拖入附件暂存。
//!
//! 插件页面运行在沙箱里，拿不到任何本地路径；所有文件操作都经这里完成。
//! 只做「读用户选中的文件 / 写到用户选中的目录」，不提供任意删除能力。

use std::fs;
use std::path::{Path, PathBuf};

use base64::Engine;
use serde::Serialize;

/// 拖入附件的暂存目录名
const TMP_DIR: &str = "tmp";
/// 单个本地文件读取上限
const LOCAL_FILE_LIMIT: u64 = 25 * 1024 * 1024;

/// 目录清单
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DirListing {
    pub path: String,
    pub parent: String,
    pub entries: Vec<DirEntry>,
    pub roots: Vec<DirEntry>,
    pub shortcuts: Vec<DirEntry>,
    pub writable: bool,
}

/// 目录/文件条目
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DirEntry {
    pub name: String,
    pub path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub size: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mtime: Option<i64>,
}

/// 用户主目录
pub fn home_dir() -> PathBuf {
    std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .map(PathBuf::from)
        .unwrap_or_else(|_| std::env::temp_dir())
}

fn shortcut(name: &str, path: PathBuf) -> Option<DirEntry> {
    if path.is_dir() {
        Some(DirEntry {
            name: name.to_string(),
            path: path.to_string_lossy().to_string(),
            size: None,
            mtime: None,
        })
    } else {
        None
    }
}

/// 常用位置
pub fn shortcuts() -> Vec<DirEntry> {
    let home = home_dir();
    [
        ("主目录", home.clone()),
        ("桌面", home.join("Desktop")),
        ("文档", home.join("Documents")),
        ("下载", home.join("Downloads")),
        ("图片", home.join("Pictures")),
    ]
    .into_iter()
    .filter_map(|(name, path)| shortcut(name, path))
    .collect()
}

/// Windows 盘符根目录
fn roots() -> Vec<DirEntry> {
    #[cfg(windows)]
    {
        let mut items = Vec::new();
        for letter in b'A'..=b'Z' {
            let path = format!("{}:\\", letter as char);
            let candidate = PathBuf::from(&path);
            if candidate.is_dir() {
                items.push(DirEntry {
                    name: path.clone(),
                    path,
                    size: None,
                    mtime: None,
                });
            }
        }
        items
    }
    #[cfg(not(windows))]
    {
        vec![DirEntry {
            name: "/".into(),
            path: "/".into(),
            size: None,
            mtime: None,
        }]
    }
}

/// 列出目录（只返回子目录，用于选择保存位置）
pub fn list_dirs(path: &str) -> Result<DirListing, String> {
    let start = if path.trim().is_empty() {
        home_dir()
    } else {
        PathBuf::from(path)
    };
    let target = if start.is_dir() {
        start
    } else {
        start.parent().map(Path::to_path_buf).unwrap_or_else(home_dir)
    };

    let mut entries = Vec::new();
    let read = fs::read_dir(&target).map_err(|error| format!("读取目录失败：{error}"))?;
    for item in read.flatten() {
        let file_type = match item.file_type() {
            Ok(value) => value,
            Err(_) => continue,
        };
        if !file_type.is_dir() {
            continue;
        }
        let name = item.file_name().to_string_lossy().to_string();
        if name.starts_with('.') {
            continue;
        }
        entries.push(DirEntry {
            name,
            path: item.path().to_string_lossy().to_string(),
            size: None,
            mtime: None,
        });
    }
    entries.sort_by(|left, right| left.name.to_lowercase().cmp(&right.name.to_lowercase()));

    let writable = fs::metadata(&target)
        .map(|meta| !meta.permissions().readonly())
        .unwrap_or(false);
    let parent = target
        .parent()
        .map(|value| value.to_string_lossy().to_string())
        .unwrap_or_default();

    Ok(DirListing {
        path: target.to_string_lossy().to_string(),
        parent,
        entries,
        roots: roots(),
        shortcuts: shortcuts(),
        writable,
    })
}

/// 列出目录内的文件（用于挑选附件）
pub fn list_files(path: &str) -> Result<Vec<DirEntry>, String> {
    let target = if path.trim().is_empty() {
        home_dir()
    } else {
        PathBuf::from(path)
    };
    let read = fs::read_dir(&target).map_err(|error| format!("读取目录失败：{error}"))?;
    let mut items = Vec::new();
    for item in read.flatten() {
        let file_type = match item.file_type() {
            Ok(value) => value,
            Err(_) => continue,
        };
        if file_type.is_dir() {
            continue;
        }
        let name = item.file_name().to_string_lossy().to_string();
        if name.starts_with('.') {
            continue;
        }
        let meta = item.metadata().ok();
        items.push(DirEntry {
            name,
            path: item.path().to_string_lossy().to_string(),
            size: meta.as_ref().map(|value| value.len()),
            mtime: meta
                .as_ref()
                .and_then(|value| value.modified().ok())
                .and_then(|value| value.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|value| value.as_millis() as i64),
        });
    }
    items.sort_by(|left, right| left.name.to_lowercase().cmp(&right.name.to_lowercase()));
    Ok(items)
}

/// 读取本地文件（附件预览 / 拖入前检查），返回 base64
pub struct LocalFile {
    pub name: String,
    pub path: String,
    pub mime: String,
    pub size: i64,
    pub data_base64: String,
}

pub fn read_local_file(path: &str) -> Result<LocalFile, String> {
    let target = PathBuf::from(path);
    let meta = fs::metadata(&target).map_err(|error| format!("读取文件失败：{error}"))?;
    if !meta.is_file() {
        return Err("所选路径不是文件".into());
    }
    if meta.len() > LOCAL_FILE_LIMIT {
        return Err("文件超过 25 MB，无法作为附件添加".into());
    }
    let bytes = fs::read(&target).map_err(|error| format!("读取文件失败：{error}"))?;
    let name = target
        .file_name()
        .map(|value| value.to_string_lossy().to_string())
        .unwrap_or_else(|| "file".into());
    Ok(LocalFile {
        mime: guess_mime(&name),
        name,
        path: target.to_string_lossy().to_string(),
        size: bytes.len() as i64,
        data_base64: base64::engine::general_purpose::STANDARD.encode(bytes),
    })
}

/// 把拖入的附件写入插件数据目录，返回可长期引用的路径
pub fn save_upload(data_dir: &Path, name: &str, data_base64: &str) -> Result<LocalFile, String> {
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data_base64)
        .map_err(|_| "附件内容不是合法的 base64".to_string())?;
    if bytes.len() as u64 > LOCAL_FILE_LIMIT {
        return Err("附件超过 25 MB 上限".into());
    }
    let dir = data_dir.join(TMP_DIR).join("attachments");
    fs::create_dir_all(&dir).map_err(|error| format!("创建暂存目录失败：{error}"))?;
    let safe = sanitize_filename(name);
    let path = dir.join(format!("{}-{}", uuid::Uuid::new_v4(), safe));
    fs::write(&path, &bytes).map_err(|error| format!("保存附件失败：{error}"))?;
    Ok(LocalFile {
        name: safe.clone(),
        mime: guess_mime(&safe),
        path: path.to_string_lossy().to_string(),
        size: bytes.len() as i64,
        data_base64: String::new(),
    })
}

/// 保存附件到用户选择的目录；返回落盘路径
pub fn save_attachment(
    raw: &[u8],
    index: i64,
    target_dir: &str,
    fallback_name: &str,
) -> Result<String, String> {
    let (name, bytes, _mime) =
        crate::mime::part_bytes(raw, index).ok_or_else(|| "找不到该附件".to_string())?;
    let dir = normalize_dir(target_dir)?;
    let safe = sanitize_filename(if name.trim().is_empty() { fallback_name } else { &name });
    let path = unique_path(&dir, &safe);
    fs::write(&path, &bytes).map_err(|error| format!("写入附件失败：{error}"))?;
    Ok(path.to_string_lossy().to_string())
}

/// 把原始邮件导出为 .eml
pub fn export_eml(raw: &[u8], target_dir: &str, suggested: &str) -> Result<String, String> {
    let dir = normalize_dir(target_dir)?;
    let safe = sanitize_filename(suggested);
    let name = if safe.to_lowercase().ends_with(".eml") {
        safe
    } else {
        format!("{safe}.eml")
    };
    let path = unique_path(&dir, &name);
    fs::write(&path, raw).map_err(|error| format!("写入 .eml 失败：{error}"))?;
    Ok(path.to_string_lossy().to_string())
}

/// 读取 .eml 字节（导入用）
pub fn read_eml(path: &str) -> Result<Vec<u8>, String> {
    let target = PathBuf::from(path);
    let meta = fs::metadata(&target).map_err(|error| format!("读取文件失败：{error}"))?;
    if meta.len() > 200 * 1024 * 1024 {
        return Err("邮件文件超过 200 MB，无法导入".into());
    }
    fs::read(&target).map_err(|error| format!("读取文件失败：{error}"))
}

/// 默认导出目录：下载/DBX 邮件，不存在则退回插件数据目录
pub fn default_output_dir(data_dir: &Path) -> String {
    let downloads = home_dir().join("Downloads");
    let target = if downloads.is_dir() {
        downloads.join("DBX 邮件")
    } else {
        data_dir.join("exports")
    };
    let _ = fs::create_dir_all(&target);
    target.to_string_lossy().to_string()
}

/// 生成原始邮件保存路径（data_dir/raw/account/mailbox/uid.eml）
pub fn raw_path(data_dir: &Path, account_id: i64, mailbox_id: i64, key: &str) -> PathBuf {
    let dir = data_dir.join("raw").join(account_id.to_string()).join(mailbox_id.to_string());
    let _ = fs::create_dir_all(&dir);
    dir.join(format!("{}.eml", sanitize_filename(key)))
}

/// 写入原始邮件（自动创建父目录）
pub fn write_raw(path: &Path, raw: &[u8]) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| format!("创建邮件缓存目录失败：{error}"))?;
    }
    fs::write(path, raw).map_err(|error| format!("写入邮件缓存失败：{error}"))
}

/* ---------------- 辅助 ---------------- */

fn normalize_dir(target_dir: &str) -> Result<PathBuf, String> {
    let dir = if target_dir.trim().is_empty() {
        PathBuf::from(default_output_dir(&std::env::temp_dir()))
    } else {
        PathBuf::from(target_dir)
    };
    if !dir.is_dir() {
        fs::create_dir_all(&dir).map_err(|error| format!("目标目录不可用：{error}"))?;
    }
    Ok(dir)
}

/// 同名文件自动加序号，不覆盖用户已有文件
fn unique_path(dir: &Path, name: &str) -> PathBuf {
    let candidate = dir.join(name);
    if !candidate.exists() {
        return candidate;
    }
    let path = Path::new(name);
    let stem = path
        .file_stem()
        .map(|value| value.to_string_lossy().to_string())
        .unwrap_or_else(|| "file".into());
    let ext = path
        .extension()
        .map(|value| format!(".{}", value.to_string_lossy()))
        .unwrap_or_default();
    for index in 1..1000 {
        let candidate = dir.join(format!("{stem} ({index}){ext}"));
        if !candidate.exists() {
            return candidate;
        }
    }
    dir.join(format!("{stem}-{}{ext}", chrono::Utc::now().timestamp()))
}

/// 文件名净化：去掉路径分隔符与控制字符
pub fn sanitize_filename(name: &str) -> String {
    let cleaned: String = name
        .chars()
        .map(|ch| {
            if matches!(ch, '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|') || ch.is_control() {
                '_'
            } else {
                ch
            }
        })
        .collect();
    let trimmed = cleaned.trim().trim_matches('.').to_string();
    if trimmed.is_empty() {
        "attachment.bin".into()
    } else {
        trimmed.chars().take(140).collect()
    }
}

/// 按扩展名猜 MIME
pub fn guess_mime(name: &str) -> String {
    let ext = Path::new(name)
        .extension()
        .map(|value| value.to_string_lossy().to_lowercase())
        .unwrap_or_default();
    match ext.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "svg" => "image/svg+xml",
        "pdf" => "application/pdf",
        "txt" | "log" | "md" => "text/plain",
        "html" | "htm" => "text/html",
        "csv" => "text/csv",
        "json" => "application/json",
        "xml" => "application/xml",
        "zip" => "application/zip",
        "7z" => "application/x-7z-compressed",
        "rar" => "application/vnd.rar",
        "doc" => "application/msword",
        "docx" => "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "xls" => "application/vnd.ms-excel",
        "xlsx" => "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "ppt" => "application/vnd.ms-powerpoint",
        "pptx" => "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        "eml" => "message/rfc822",
        "ics" => "text/calendar",
        "mp3" => "audio/mpeg",
        "mp4" => "video/mp4",
        "wav" => "audio/wav",
        _ => "application/octet-stream",
    }
    .to_string()
}
