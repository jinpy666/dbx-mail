//! 出网白名单
//!
//! 远程图片代理是插件里唯一由「邮件内容」决定的出网请求：一封恶意邮件可以
//! 让 sidecar 去访问任意地址。这里把判定收在一处，覆盖三类绕过：
//!
//! 1. 直接用环回/内网/链路本地地址；
//! 2. 用 CGNAT（100.64/10）、保留段（240/4）、基准测试段（198.18/15）等
//!    「看着像公网」的地址；
//! 3. 用 IPv6 形态包装 IPv4 内网地址（`::ffff:127.0.0.1`、已废弃的
//!    IPv4-compatible `::a.b.c.d`）；
//! 4. 302 跳转：只校验首个 URL 时，一跳就能进内网，因此重定向逐跳复核。
//!
//! 未覆盖：DNS rebinding（首次解析通过、真正连接时换成内网 IP）。要彻底解决
//! 需要解析后 pin IP 连接，属于后续加固项。

use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, ToSocketAddrs};

use reqwest::redirect::Policy;

/// 图片下载允许的最大重定向次数
const MAX_REDIRECTS: usize = 3;

/// 拒绝对外请求的原因（直接作为错误文案返回给前端）
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HostReject {
    /// 本机/局域网后缀
    LocalName,
    /// DNS 解析失败
    Unresolved,
    /// 解析到不允许的地址
    BlockedAddress,
}

impl HostReject {
    /// 面向用户的说明
    pub fn message(self) -> &'static str {
        match self {
            Self::LocalName => "不允许请求本机地址",
            Self::Unresolved => "无法解析图片主机",
            Self::BlockedAddress => "不允许请求内网地址",
        }
    }
}

/// 校验主机名可以安全访问
///
/// 解析出的**每一个**地址都必须是公网地址：同一域名同时返回公网与内网 IP 时，
/// 只要有一个不合格就整体拒绝，避免连接时选中内网那一条。
pub fn check_host(host: &str) -> Result<(), HostReject> {
    let lower = host.to_lowercase();
    if lower == "localhost"
        || lower.ends_with(".localhost")
        || lower.ends_with(".local")
        || lower.ends_with(".internal")
        || lower.ends_with(".home.arpa")
    {
        return Err(HostReject::LocalName);
    }
    // 主机名本身就是 IP 字面量时不必走 DNS
    if let Ok(ip) = lower.trim_matches(['[', ']']).parse::<IpAddr>() {
        return if ip_is_blocked(ip) {
            Err(HostReject::BlockedAddress)
        } else {
            Ok(())
        };
    }
    let addresses = (host, 0u16)
        .to_socket_addrs()
        .map_err(|_| HostReject::Unresolved)?;
    let mut resolved = 0usize;
    for address in addresses {
        resolved += 1;
        if ip_is_blocked(address.ip()) {
            return Err(HostReject::BlockedAddress);
        }
    }
    if resolved == 0 {
        return Err(HostReject::Unresolved);
    }
    Ok(())
}

/// 该地址是否不允许访问
pub fn ip_is_blocked(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(value) => ipv4_is_blocked(value),
        IpAddr::V6(value) => ipv6_is_blocked(value),
    }
}

/// IPv4：环回、RFC1918、链路本地、CGNAT、保留段、组播、文档段
fn ipv4_is_blocked(ip: Ipv4Addr) -> bool {
    let [a, b, c, _d] = ip.octets();
    ip.is_loopback()
        || ip.is_private()
        || ip.is_link_local()
        || ip.is_broadcast()
        || ip.is_unspecified()
        || ip.is_multicast()
        || a == 0 // 0.0.0.0/8
        || (a == 100 && (64..=127).contains(&b)) // 100.64/10 CGNAT
        || (a == 192 && b == 0 && c == 0) // 192.0.0/24 IETF 协议分配
        || (a == 192 && b == 0 && c == 2) // 192.0.2/24 TEST-NET-1
        || (a == 198 && (b == 18 || b == 19)) // 198.18/15 基准测试
        || (a == 198 && b == 51 && c == 100) // 198.51.100/24 TEST-NET-2
        || (a == 203 && b == 0 && c == 113) // 203.0.113/24 TEST-NET-3
        || a >= 240 // 240.0.0.0/4 保留
}

/// IPv6：环回、未指定、组播、ULA、链路本地、站点本地、文档段、NAT64
fn ipv6_is_blocked(ip: Ipv6Addr) -> bool {
    // IPv4-mapped（::ffff:a.b.c.d）必须先还原成 v4，否则上面所有 v4 规则都能被绕过
    if let Some(mapped) = ip.to_ipv4_mapped() {
        return ipv4_is_blocked(mapped);
    }
    // 已废弃的 IPv4-compatible（::a.b.c.d），除 :: 与 ::1 之外按 v4 判定
    let segments = ip.segments();
    if segments[..6] == [0, 0, 0, 0, 0, 0] && !ip.is_loopback() && !ip.is_unspecified() {
        return ipv4_is_blocked(Ipv4Addr::new(
            (segments[6] >> 8) as u8,
            segments[6] as u8,
            (segments[7] >> 8) as u8,
            segments[7] as u8,
        ));
    }
    ip.is_loopback()
        || ip.is_unspecified()
        || ip.is_multicast()
        || (segments[0] & 0xfe00) == 0xfc00 // fc00::/7 唯一本地地址
        || (segments[0] & 0xffc0) == 0xfe80 // fe80::/10 链路本地
        || (segments[0] & 0xffc0) == 0xfec0 // fec0::/10 站点本地（已废弃）
        || (segments[0] == 0x2001 && segments[1] == 0x0db8) // 2001:db8::/32 文档段
        || (segments[0] == 0x0064 && segments[1] == 0xff9b) // 64:ff9b::/96 NAT64
        || (segments[0] == 0x0100 && segments[1] == 0 && segments[2] == 0 && segments[3] == 0)
    // 100::/64 丢弃前缀
}

/// 逐跳校验的重定向策略
///
/// reqwest 默认 `Policy::limited(3)` 只数次数不校验目标，公网图片 302 到
/// `http://127.0.0.1:8080/` 就能绕过白名单。
pub fn redirect_policy() -> Policy {
    Policy::custom(|attempt| {
        if attempt.previous().len() >= MAX_REDIRECTS {
            return attempt.error(std::io::Error::new(
                std::io::ErrorKind::PermissionDenied,
                "重定向次数过多",
            ));
        }
        let host = attempt.url().host_str().unwrap_or_default();
        match check_host(host) {
            Ok(()) => attempt.follow(),
            Err(reason) => attempt.error(std::io::Error::new(
                std::io::ErrorKind::PermissionDenied,
                reason.message(),
            )),
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn blocked(text: &str) -> bool {
        ip_is_blocked(text.parse().unwrap())
    }

    #[test]
    fn blocks_ipv4_private_and_reserved() {
        for address in [
            "127.0.0.1",
            "10.1.2.3",
            "172.16.0.1",
            "172.31.255.254",
            "192.168.1.10",
            "169.254.169.254",
            "0.0.0.0",
            "224.0.0.1",
            "255.255.255.255",
            "192.0.2.5",
            "198.51.100.7",
            "203.0.113.9",
            "198.18.0.1",
            "198.19.255.254",
        ] {
            assert!(blocked(address), "{address} 应被拦截");
        }
    }

    #[test]
    fn blocks_cgnat_and_reserved_ranges() {
        // CGNAT 100.64/10：看似公网，实则常被云厂商与内网复用
        for address in ["100.64.0.1", "100.100.100.100", "100.127.255.254"] {
            assert!(blocked(address), "{address} 应被拦截");
        }
        // 240/4 保留段
        for address in ["240.0.0.1", "250.1.1.1", "254.254.254.254"] {
            assert!(blocked(address), "{address} 应被拦截");
        }
        // 边界：100.63 与 100.128 属于公网
        assert!(!blocked("100.63.255.255"));
        assert!(!blocked("100.128.0.1"));
    }

    #[test]
    fn allows_public_ipv4() {
        for address in ["8.8.8.8", "1.1.1.1", "93.184.216.34", "223.5.5.5"] {
            assert!(!blocked(address), "{address} 不应被拦截");
        }
    }

    #[test]
    fn blocks_ipv6_private_and_wrapped_ipv4() {
        for address in [
            "::1",
            "::",
            "fd00::1",
            "fe80::1",
            "ff02::1",
            "2001:db8::1",
            "64:ff9b::7f00:1",
            "::ffff:127.0.0.1",
            "::ffff:192.168.1.1",
            "::ffff:10.0.0.1",
            "::ffff:100.64.0.1",
            "::127.0.0.1",
        ] {
            assert!(blocked(address), "{address} 应被拦截");
        }
    }

    #[test]
    fn allows_public_ipv6() {
        for address in ["2606:4700:4700::1111", "::ffff:8.8.8.8", "2a00:1450:4001::200e"] {
            assert!(!blocked(address), "{address} 不应被拦截");
        }
    }

    #[test]
    fn rejects_local_host_names() {
        for host in ["localhost", "printer.local", "db.internal", "x.localhost"] {
            assert_eq!(check_host(host), Err(HostReject::LocalName), "{host}");
        }
    }

    #[test]
    fn rejects_ip_literals_without_dns() {
        assert_eq!(check_host("127.0.0.1"), Err(HostReject::BlockedAddress));
        assert_eq!(check_host("[::1]"), Err(HostReject::BlockedAddress));
        assert_eq!(check_host("100.64.1.1"), Err(HostReject::BlockedAddress));
    }
}
