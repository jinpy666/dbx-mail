# 第三方许可与致谢

DBX 邮件插件（`com.mjj3610.mail`）以 **GPL-3.0-or-later** 发布，版权归属见 `NOTICE`。
以下第三方组件随插件分发或参与构建。许可证**全文**放在 `licenses/`，随 `.dbxp` 一起分发。

## 0. 许可证副本索引

| 文件 | 许可证 | 覆盖组件（举例） |
| --- | --- | --- |
| `licenses/GPL-3.0.txt` | GPL-3.0 | 本插件自身（FSF 标准文本，未改动） |
| `licenses/MIT.txt` | MIT | React、tokio、lettre、mail-builder、rusqlite 等 |
| `licenses/Apache-2.0.txt` | Apache-2.0 | rustls、reqwest、serde、TypeScript 等（多数组件为 MIT/Apache 双许可） |
| `licenses/ISC.txt` | ISC | ring、rustls-webpki、untrusted、lucide-react |
| `licenses/CDLA-Permissive-2.0.txt` | CDLA-Permissive-2.0 | webpki-roots（根证书数据） |
| `licenses/Unicode-3.0.txt` | Unicode-3.0 | icu_* / zerovec / yoke 等 ICU4X 系列（由 `idna`、`url` 引入） |
| `licenses/Zlib.txt` | Zlib | zlib-rs（`flate2` 的解压后端） |

> 许可证归属以各 crate 自身 `Cargo.toml` 的 `license` 字段为准；
> 上表通过 `Cargo.lock` 全量比对得出（当前锁定 257 个包）。

## 1. 运行时依赖（前端，随 `ui/` 打包）

| 组件 | 用途 | 许可证 |
| --- | --- | --- |
| React / React DOM | 界面框架 | MIT |
| Zustand | 状态管理 | MIT |
| lucide-react | 图标 | ISC |
| sonner | 轻提示 | MIT |
| DOMPurify | 邮件 HTML 白名单清洗 | Apache-2.0 或 MPL-2.0（本项目按 Apache-2.0 使用） |

## 2. 原生 Sidecar（Rust）

| 组件 | 用途 | 许可证 |
| --- | --- | --- |
| tokio | 异步运行时 | MIT |
| async-imap / imap-proto / imap-types | IMAP 客户端与协议类型 | MIT 或 Apache-2.0 |
| async-channel | 同步与后台任务之间的通道 | Apache-2.0 或 MIT |
| futures-util | 异步流与并发工具（IMAP 读写管道） | MIT 或 Apache-2.0 |
| lettre | SMTP 发送 | MIT |
| mail-parser | MIME 解析（`full_encoding`） | Apache-2.0 或 MIT |
| mail-builder | MIME 组装 | MIT 或 Apache-2.0 |
| rustls / tokio-rustls | TLS 实现 | Apache-2.0 或 MIT |
| rustls-pki-types | TLS 证书与密钥类型 | MIT 或 Apache-2.0 |
| rustls-native-certs | 系统根证书 | Apache-2.0 或 MIT |
| webpki-roots | 内置 Mozilla 根证书 | **CDLA-Permissive-2.0** |
| ring | 密码学原语 | ISC |
| rusqlite（bundled SQLite） | 本地数据库 | MIT；SQLite 为 Public Domain |
| keyring | 系统凭据库 | MIT 或 Apache-2.0 |
| aes-gcm | 本地密码文件加密兜底 | MIT 或 Apache-2.0 |
| reqwest（rustls-tls） | 远程图片代理 | MIT 或 Apache-2.0 |
| serde / serde_json | JSON 序列化 | MIT 或 Apache-2.0 |
| chrono / uuid / base64 / sha2 / rand | 通用工具 | 均为 MIT 或 Apache-2.0 系列 |
| urlencoding | URL 编解码（IMAP 参数、文件名转义） | MIT |

## 3. 传递依赖中非 MIT/Apache 的许可证

以下组件不属于 MIT/Apache 体系，容易被漏登记，单独列出（全文见 `licenses/`）：

| 组件 | 许可证 | 说明 |
| --- | --- | --- |
| webpki-roots 0.26 / 1.0 | CDLA-Permissive-2.0 | Mozilla 根证书数据；仅约束数据本身，不传染到本插件代码 |
| icu_collections、icu_locale_core、icu_normalizer(_data)、icu_properties(_data)、icu_provider、litemap、potential_utf、tinystr、writeable、yoke(-derive)、zerofrom(-derive)、zerotrie、zerovec(-derive) | Unicode-3.0 | ICU4X 系列，经 `idna` → `url` → `reqwest` 引入 |
| rustls-webpki、untrusted | ISC | 证书链校验 |
| zlib-rs | Zlib | `flate2` 的解压后端（bundled SQLite 之外唯一的压缩依赖） |
| 若干 0BSD / BSD-2-Clause / BSD-3-Clause 组件 | 对应 BSD 条款 | 均为宽松许可，已按 `Cargo.lock` 逐一核对 |

## 4. 构建期依赖（不随插件分发）

| 组件 | 用途 | 许可证 |
| --- | --- | --- |
| Vite / @vitejs/plugin-react | 前端构建与单文件打包 | MIT |
| Tailwind CSS / @tailwindcss/vite | 样式工具链（产物只有 CSS，无运行时依赖） | MIT |
| TypeScript | 类型检查 | Apache-2.0 |
| @dbx-app/plugin-cli | DBX 插件打包工具 | 见其仓库声明 |

## 5. 设计与产品参考

界面与信息架构参考开源邮件客户端 **Penguin Mail 1.0.11**（Rust + GTK4/libadwaita，GPL-3.0）的产品形态与
`DESIGN.md` 中的设计令牌（强调色、surface 分层、胶囊工具条、pill 筛选片、圆角与字号层级）。
本插件为按 DBX 插件体系重新实现，未复制其 Rust / GTK 源码，也不包含其二进制产物。

产品定位与交互取舍另参考了 GNOME 人机界面指南中关于「安静的桌面」与「一个区域只保留一个填充控件」的建议。
