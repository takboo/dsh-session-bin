# DSH 0.2.1-rc.3 兼容性验证

日期：2026-10-24。插件版本 `0.2.5`；已拉取远端 `main`，基线为 `6283008cd0a80f4cc50e8248a2352bf588fd333b`（插件 `0.2.4` / DSH `0.2.1-rc.2`）。目标精确固定为 `0.2.1-rc.3`；一手源码、发布物摘要和客户端变化见[接口调研](../research/dsh-0.2.1-rc3.md)。

## 适配范围

声明的 SDK、peerDependencies、lockfile、运行时版本检查和 GUI 基线同步升级为精确 rc.3。删除涉及的已审计 Host 编译实现与 rc.2 逐字节相同，保留源码 SHA-256 检查及 [ADR 0011](../decisions/0011-runtime-and-durable-retirement-identity.md) 的持久化协议身份。未放宽 Node/Electron、架构、文件系统或存储提供方资格。原生 Archive 仍为唯一归档入口，活动保护、固定批次范围、未知结果保护和重载不重发规则继续执行。

依赖安装使用 frozen lockfile 并禁用生命周期脚本；release-age 例外只包含精确官方版本。除 SDK 版本替换外，依赖图仅新增官方 `dsh-client-ui-entry-customization`，其他版本未漂移。界面继续使用原生控件和语义 token，Sidebar 新增 More/pin 接口不改变本插件既有入口注册。

## 本地完整验收

环境：macOS `15.7.9` ARM64、APFS（type `0x1a`）。使用 mise 固定 Node `24.18.1` / libuv `1.52.1`、pnpm `11.23.0`。机器全局工具与固定工具不同，本轮通过设置工作区 `MISE_DATA_DIR` / `MISE_STATE_DIR` / `MISE_CACHE_DIR` 后执行同一 `mise.toml` 任务，核对实际版本。

- `mise run verify:platform`：391 项，385 通过、0 失败、6 项 Windows 专用检查跳过；类型、构建、市场元数据、Host/Client/Remote、raw/zstd、cache/SQLite、真实进程中断与重开和 tarball 检查通过。源码前后稳定，SHA-256 为 `82ead27850f2ba17e9750f8dac8eed7d9af71b45f7840104931de781ac8f5dd9`。[平台报告](../../.local/platform/darwin-arm64-jdPG1L/verification.json)
- `mise run verify:desktop`：官方 rc.3 ZIP 解压到独立目录后指定 `DSH_SESSION_BIN_DESKTOP_APP`；391 项，385 通过、0 失败、6 跳过。真实 ASAR Host、18 个 SDK 文件、原生模块及生产准备路径通过；源码摘要与独立 Node 报告一致。[桌面报告](../../.local/desktop/darwin-arm64-fTpN9u/verification.json)

桌面实际载体为 Electron `44.7.0` / Node `24.21.0` / libuv `1.52.1`，SQLite `3.53.4`、Zstd `1.6.0`、ABI `149`；测试不设置 candidate 资格回调。四组浏览器 Client fixture 使用公开 npm 的客户端产物，Host 测试使用 ASAR SDK 与原生模块。该证据只授予 macOS ARM64/APFS 的精确桌面组合，不推导其他桌面架构。

## rc.2 冷重启升级

更新前用基线 `0.2.4` 和 rc.2 SDK 在临时 DSH_HOME 生成样本，完全关闭旧 Context/进程后，使用 rc.3 公共服务打开同一数据。

| rc.2 状态 | rc.3 复核 | 结果 |
| --- | --- | --- |
| prepared，未执行 | 重新准备核对 binding 和完整 manifest，明确执行旧冻结计划 | 通过 |
| done | 读取旧回执，重复 execute 返回同一结果 | 通过 |
| owner-fenced，raw/zstd | 旧进程真实 SIGKILL，沿用原授权恢复同一操作 | 两种编码通过 |
| resource-effect，raw/zstd | 实际擦除后、确认前 SIGKILL，重开对账日志/cache/SQLite | 两种编码通过 |

四个中断样本逐项保持旧 request、manifest、authorizationId；目标日志与派生记录缺失，sibling transcript 完整，重复 execute 只返回原回执。恢复不生成新目标或删除授权。[升级报告](../../.local/rc3-upgrade-verification.json)、[中断恢复报告](../../.local/rc3-upgrade-crash-verification.json)。

## 发布验收边界

本机证据只证明本机组合。独立 Node 的 Windows x64/NTFS、macOS ARM64/Intel/APFS、Linux ARM64/x64/ext4 组合由对应实际 CI runner 验收；candidate 报告本身不扩大生产资格。正式 tag workflow 要求五平台的全量回归、真实 Loader 和双语 CLI/GUI 均通过，只发布该轮 Linux x64 的同字节验收 tarball。实际分发摘要以 Release 的 `SHA256SUMS`、`release.json` 及 npm registry 为准。

所有会话检查使用临时 DSH_HOME 与独立 fixture，没有操作真实用户会话或重启已安装应用。范围不含原生 Desktop shell、物理 OS 输入法、Windows ARM64、普通 Node `24.21.0`、其他 Electron/文件系统/存储组合、多 Host、共享附件 GC、安全擦除或掉电保证。
