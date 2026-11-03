//! TLS 拨号：rustls + 系统根证书（失败时退回内置 Mozilla 根证书）。
//!
//! 使用系统证书库，企业网络的 TLS 检查代理也能正常工作；
//! 不校验证书开关一律不提供，避免把密码交给中间人。

use std::sync::{Arc, OnceLock};
use std::time::Duration;

use rustls::{ClientConfig, RootCertStore};
use rustls_pki_types::ServerName;
use tokio::net::TcpStream;
use tokio_rustls::client::TlsStream;
use tokio_rustls::TlsConnector;

/// 连接超时
const CONNECT_TIMEOUT: Duration = Duration::from_secs(20);

/// 进程级 ClientConfig
fn config() -> Arc<ClientConfig> {
    static CONFIG: OnceLock<Arc<ClientConfig>> = OnceLock::new();
    CONFIG
        .get_or_init(|| {
            let _ = rustls::crypto::ring::default_provider().install_default();
            let mut roots = RootCertStore::empty();
            match rustls_native_certs::load_native_certs() {
                result => {
                    for cert in result.certs {
                        let _ = roots.add(cert);
                    }
                }
            }
            if roots.is_empty() {
                roots.extend(webpki_roots::TLS_SERVER_ROOTS.iter().cloned());
            }
            Arc::new(
                ClientConfig::builder()
                    .with_root_certificates(roots)
                    .with_no_client_auth(),
            )
        })
        .clone()
}

/// 解析服务器名（主机名或 IP）
fn server_name(host: &str) -> Result<ServerName<'static>, String> {
    ServerName::try_from(host.to_string()).map_err(|_| format!("服务器名称非法：{host}"))
}

/// 建立 TCP 连接并完成 TLS 握手（隐式 TLS，如 993 / 465）
pub async fn connect(host: &str, port: u16) -> Result<TlsStream<TcpStream>, String> {
    let address = format!("{host}:{port}");
    let tcp = tokio::time::timeout(CONNECT_TIMEOUT, TcpStream::connect(&address))
        .await
        .map_err(|_| format!("连接 {address} 超时"))?
        .map_err(|error| format!("连接 {address} 失败：{error}"))?;
    let _ = tcp.set_nodelay(true);
    wrap(host, tcp).await
}

/// 在已有 TCP 连接上升级为 TLS（STARTTLS 用）
pub async fn wrap(host: &str, tcp: TcpStream) -> Result<TlsStream<TcpStream>, String> {
    let connector = TlsConnector::from(config());
    connector
        .connect(server_name(host)?, tcp)
        .await
        .map_err(|error| format!("TLS 握手失败：{error}"))
}

/// 建立到服务器的明文 TCP 连接（STARTTLS 的起点）
pub async fn connect_plain(host: &str, port: u16) -> Result<TcpStream, String> {
    let address = format!("{host}:{port}");
    let stream = tokio::time::timeout(CONNECT_TIMEOUT, TcpStream::connect(&address))
        .await
        .map_err(|_| format!("连接 {address} 超时"))?
        .map_err(|error| format!("连接 {address} 失败：{error}"))?;
    let _ = stream.set_nodelay(true);
    Ok(stream)
}
