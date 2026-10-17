# DSH 0.2.1-rc.1 兼容性验证

日期：2026-10-17。插件版本 `0.2.1`；拉取远程后的基线为 `83ad67fefe3bd02d889ccbac4e54719479b877f6`（插件 `0.2.0`）。目标精确固定为 `0.2.1-rc.1`，不包含同日发布的 rc.2；一手源码和 npm 摘要见[接口调研](../research/dsh-0.2.1-rc1.md)。

## 问题与修复

旧版插件不能直接加载新版 JSONL 包：隔离回归复现 `does not provide an export named 'default'`，类型检查同样拒绝默认导入。适配命名插件入口后，使用 `SessionPersistence` 基类、具体原始构造器源码 SHA-256、配置与完整包源码检查确认提供方。

API Session 已移除 `createOrAdopt`。针对新版 `resumeObserved/claim/createAgent` 的三个回归先全部因 adapter 未准入失败，修复后全部通过；原空闲 phase、活动、排队工作、其他 owner 与独立 reader/follower 保护继续保留。新版 Workspace 的 `missingSessionPaths` 参与准备与收敛：新增回归先因误判其他缺失目录的候选而失败，修复后只清目标索引并保留同工作区其他成员。

真实 GUI 进一步复现打开历史后归档再准备删除时的 `gateway/internal` 与面板连接失败：新版 `summarizeCold` 接收 SessionRecord，旧调用直接传 Header，在释放 Agent 后抛错。修正记录参数，并将隔离 fixture 的旧摘要替身改为真实 SDK `ApiSessionList`；对应三个释放回归先红后绿，metadata 全部 36 项通过。最终真实 GUI 完整重跑通过，未以替身成功代替该场景。

隔离 Remote fixture 使用新版正式 `RemoteAccessService`、显式 owner Peer 与浏览器一致的 interactions 配置。Node 逻辑测试直接导入公开条件入口；真实 Client ModuleSystem 验证读取宿主实际使用的 browser/default 发布产物。原 lazy factory、共享 React/控件身份及严格 Remote 协议保持。没有以重新编译 SDK 浏览器入口代替真实发布物。

## 本地平台与打包

环境：macOS `15.7.9` ARM64、APFS（type `0x1a`）、Node `24.18.1` / libuv `1.52.1`、pnpm `11.23.0`；工具来自 mise 固定配置，依赖以 frozen lockfile 安装且禁用安装脚本。新增 pnpm 配置仅对本次已核对的精确上游发布包列出 release-age 例外，其他版本仍沿用原策略。

- 旧基线 `mise run verify`：386 项，380 通过、6 项 Windows 专用检查跳过；类型、构建与真实 Loader tarball 均通过。
- 新版 `mise run verify:platform`：389 项，383 通过、6 项 Windows 专用检查跳过；类型、构建、市场元数据、真实进程终止和重开、raw/zstd、owner/cache/SQLite、严格 Remote/Client 及 tarball 加载通过。运行前后源码稳定，SHA-256 为 `1582e57c63491328e7714cb23530826fc219e4092db09c4a8dd84fecc7a601b0`。[本地平台报告](../../.local/platform/darwin-arm64-QM1Al4/verification.json)
- 同轮真实 Loader tarball 验证实际执行单项永久删除、关闭与重新激活；包 SHA-256 为 `82868b6090849c9950cf57cce7151f3d1b3a62ae6dd5f2a6449588a7ba1ad329`。[打包报告](../../.local/lifecycle/package-2kkNWW/verification.json)

该平台报告只证明本机组合；其他平台须以对应 runner 的独立实际验收为准，candidate 通过不自动晋级生产资格。

## 五平台生产资格

实现基线 `27def1f02a92dab125225f8d9245b8ad5c43f193` 的 [PR CI run 39022486043](https://github.com/takboo/dsh-session-bin/actions/runs/39022486043) 五个平台全部通过。逐份下载并核对 20 份平台/Loader/双语 GUI 报告：均为精确 DSH `0.2.1-rc.1`、Node `24.18.1` / libuv `1.52.1`，源码前后稳定；Loader 为 productionDeletionQualified，GUI 为 supported，实际执行删除而非只走 unsupported 分支。

| 实际 runner | 架构 | 文件系统 | 平台/Loader/中文/English |
| --- | --- | --- | --- |
| Windows Server 2025 | x64 | NTFS，type `0x0` | 全部通过 |
| macOS 15 | ARM64 | APFS，type `0x1a` | 全部通过 |
| macOS 15 Intel | x64 | APFS，type `0x1a` | 全部通过 |
| Ubuntu 24.04 | ARM64 | ext2/ext3/ext4，type `0xef53` | 全部通过 |
| Ubuntu 24.04 | x64 | ext2/ext3/ext4，type `0xef53` | 全部通过 |

POSIX 源码清单 SHA-256 为 `1582e57c63491328e7714cb23530826fc219e4092db09c4a8dd84fecc7a601b0`，Windows checkout 行尾对应清单为 `93d20b659d988131129538c08548df78cd5635c163c221b81e6ca6a4d85a4ace`。每个平台的 Loader 与两份 GUI tarball 摘要一致；POSIX 验证包为 `a4b7d5cb7da5ff37df66cba97a4f75678067f07c64723a0a5f2e1e6fac68aa2d`，Windows 验证包为 `47151a32989ecea58c01dbdfcb44d5ba09e8c87950c1aaf3beeafce9eac2715a`。GUI 每种语言各 17 项，全部 console/pageErrors 为空，20 次 Host 关闭均正常且未强制终止；Windows 使用隔离 IPC 投递给 SDK SIGTERM handler，POSIX 使用 OS 信号。

这组独立真实运行证据授予新版相应生产组合资格，未包含 Windows ARM64 或其他文件系统。正式发布仍由版本 tag workflow 在最终提交上重跑同一矩阵，公开包仅取该轮 Linux x64 的同字节 Loader/双语 GUI 已测试产物；实际分发摘要以 Release 的 `SHA256SUMS` 和 `release.json` 为准，不把本节历史验证包的摘要冒充最终发布摘要。

## 本地双语 CLI/GUI

`mise run verify:gui` 在独立真实 Web profile 中完成[中文](../../.local/gui/client-zh-V4wh8F/verification.json)与[English](../../.local/gui/client-en-kxiS4s/verification.json)，每种语言各 17 项通过。两者使用同字节 tarball，SHA-256 `a4b7d5cb7da5ff37df66cba97a4f75678067f07c64723a0a5f2e1e6fac68aa2d`；console/pageErrors 均为空，安装后与卸载后共四次 Host 关闭均 code 0、signal null、forced false。

覆盖真实原生归档/Undo、已有归档、单项及批量取消归档、搜索/分组/筛选、双向语言切换及偏好重载、浅深色/窄屏/键盘/composition，以及打开历史后的取消准备、取消归档再打开、重新归档并实际永久删除。固定选择、清空完整隐藏范围、关闭确认后仅新鲜点击执行、停止和恢复保护均沿用原断言；真正关闭并重开 SDK 后确认日志和派生记录清除、其他会话保留。新版账号引导与账号菜单中的设置只调整测试导航步骤。

首次受限沙箱下 Chrome 启动 SIGABRT，未计为验收；后续在沙箱外运行相同隔离 profile 流程。一次 CLI remove 因 npm registry `ECONNRESET` 的 10 秒重试超过原有 8 秒自然退出断言而失败；未放宽时限，独立 CLI 四项及整轮平台重跑通过。CLI/GUI 测试需要 registry 网络访问，不承诺全新 profile 离线安装。

## 旧运行时到新版的持久化兼容

按 [ADR 0011](../decisions/0011-runtime-and-durable-retirement-identity.md) 保留 schema 1 的历史资源协议身份，同时独立核对实际 rc.1 runtime。旧版 fixture 由 `83ad67f` 的实现及旧 SDK 生成；辅助脚本只将测试根目录重定向到同一隔离 `.local/lifecycle/`，不修改旧实现。完全关闭旧 Context/进程，再由新版公共服务打开同一数据。

| 旧状态 | 验证 | 结果 |
| --- | --- | --- |
| prepared，未执行 | 新版重新准备，比较 binding 与完整 manifest；明确执行旧冻结计划，保留 sibling | 通过 |
| done | 新版读取回执、重复提交旧计划；结果保持相同 | 通过 |
| owner-fenced，raw/zstd | 旧进程真实 SIGKILL；新版按已保存授权恢复同一操作 | 两种编码通过 |
| resource-effect，raw/zstd | 旧进程已擦除文件但未确认回执时 SIGKILL；新版对账文件/cache/SQLite | 两种编码通过 |

四个故障场景逐项保持原 request、manifest 与 authorizationId，最终 owner/Host 回执成功；目标日志与派生记录缺失，sibling transcript 完整，重复 execute 只返回既有结果。恢复沿用旧版明确授权的同一操作，不生成新目标或替换生命周期。prepared/done 与故障恢复的本地证据分别为[升级报告](../../.local/upgrade-verification.json)、[升级故障报告](../../.local/upgrade-crash-verification.json)。

所有数据位于临时 DSH_HOME 和独立 fixture；未读取或删除真实用户会话。范围不含跨 SDK 热接管、多 Host、未观察归档 ABA 的修补、共享附件 GC、安全擦除、掉电保证、原生桌面 shell 或物理 OS 输入法验收。
