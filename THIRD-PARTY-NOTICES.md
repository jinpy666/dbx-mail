# 第三方许可与致谢

DBX 邮件插件（`com.mjj3610.mail`）以 **GPL-3.0-or-later** 发布。
以下第三方组件随插件分发或参与构建，许可证副本位于 `licenses/`。

## 运行时依赖（前端，随 `ui/` 打包）

| 组件 | 用途 | 许可证 |
| --- | --- | --- |
| React / React DOM | 界面框架 | MIT |
| Zustand | 状态管理 | MIT |
| lucide-react | 图标 | ISC |
| sonner | 轻提示 | MIT |
| DOMPurify | 邮件 HTML 白名单清洗 | Apache-2.0 或 MPL-2.0（本项目按 Apache-2.0 使用） |
| Tailwind CSS（含 @tailwindcss/vite） | 样式工具链 | MIT |

## 原生 Sidecar（Rust）

| 组件 | 用途 | 许可证 |
| --- | --- | --- |
| tokio | 异步运行时 | MIT |
| async-imap / imap-proto / imap-types | IMAP 客户端与协议类型 | MIT 或 Apache-2.0 |
| lettre | SMTP 发送 | MIT |
| mail-parser | MIME 解析（`full_encoding`） | Apache-2.0 或 MIT |
| mail-builder | MIME 组装 | MIT 或 Apache-2.0 |
| rustls / tokio-rustls | TLS 实现 | Apache-2.0 或 MIT |
| ring | 密码学原语 | ISC |
| rustls-native-certs / webpki-roots | 根证书 | Apache-2.0 或 MIT / MPL-2.0 |
| rusqlite（bundled SQLite） | 本地数据库 | MIT；SQLite 为 Public Domain |
| keyring | 系统凭据库 | MIT 或 Apache-2.0 |
| aes-gcm | 本地密码文件加密兜底 | MIT 或 Apache-2.0 |
| reqwest（rustls-tls） | 远程图片代理 | MIT 或 Apache-2.0 |
| serde / serde_json | JSON 序列化 | MIT 或 Apache-2.0 |
| chrono / uuid / base64 / sha2 / rand | 通用工具 | MIT 或 Apache-2.0 / Apache-2.0 或 MIT / MIT 或 Apache-2.0 / MIT 或 Apache-2.0 / MIT 或 Apache-2.0 |

## 构建期依赖（不随插件分发）

| 组件 | 用途 | 许可证 |
| --- | --- | --- |
| Vite / @vitejs/plugin-react | 前端构建与单文件打包 | MIT |
| TypeScript | 类型检查 | Apache-2.0 |
| @dbx-app/plugin-cli | DBX 插件打包工具 | 见其仓库声明 |

## 设计与产品参考

界面与信息架构参考开源邮件客户端 **Penguin Mail 1.0.11**（Rust + GTK4/libadwaita，GPL-3.0）的产品形态与
`DESIGN.md` 中的设计令牌（强调色、surface 分层、胶囊工具条、pill 筛选片、圆角与字号层级）。
本插件为按 DBX 插件体系重新实现，未复制其 Rust / GTK 源码，也不包含其二进制产物。

产品定位与交互取舍另参考了 GNOME 人机界面指南中关于「安静的桌面」与「一个区域只保留一个填充控件」的建议。
