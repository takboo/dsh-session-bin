# DSH 0.2.1-rc.1 兼容性验证

日期：2026-10-17。插件版本 `0.2.1`；拉取远程后的基线为 `83ad67fefe3bd02d889ccbac4e54719479b877f6`（插件 `0.2.0`）。目标精确固定为 `0.2.1-rc.1`，不包含同日发布的 rc.2；一手源码和 npm 摘要见[接口调研](../research/dsh-0.2.1-rc1.md)。

## 问题与修复

旧版插件不能直接加载新版 JSONL 包：隔离回归复现 `does not provide an export named 'default'`，类型检查同样拒绝默认导入。适配命名插件入口后，使用 `SessionPersistence` 基类、具体原始构造器源码 SHA-256、配置与完整包源码检查确认提供方。

API Session 已移除 `createOrAdopt`。针对新版 `resumeObserved/claim/createAgent` 的三个回归先全部因 adapter 未准入失败，修复后全部通过；原空闲 phase、活动、排队工作、其他 owner 与独立 reader/follower 保护继续保留。新版 Workspace 的 `missingSessionPaths` 参与准备与收敛：新增回归先因误判其他缺失目录的候选而失败，修复后只清目标索引并保留同工作区其他成员。

隔离 Remote fixture 使用新版正式 `RemoteAccessService`、显式 owner Peer 与浏览器一致的 interactions 配置。Node 逻辑测试直接导入公开条件入口；真实 Client ModuleSystem 验证读取宿主实际使用的 browser/default 发布产物。原 lazy factory、共享 React/控件身份及严格 Remote 协议保持。没有以重新编译 SDK 浏览器入口代替真实发布物。

## 本地平台与打包

环境：macOS `15.7.9` ARM64、APFS（type `0x1a`）、Node `24.18.1` / libuv `1.52.1`、pnpm `11.23.0`；工具来自 mise 固定配置，依赖以 frozen lockfile 安装且禁用安装脚本。新增 pnpm 配置仅对本次已核对的精确上游发布包列出 release-age 例外，其他版本仍沿用原策略。

- 旧基线 `mise run verify`：386 项，380 通过、6 项 Windows 专用检查跳过；类型、构建与真实 Loader tarball 均通过。
- 新版 `mise run verify:platform`：389 项，383 通过、6 项 Windows 专用检查跳过；类型、构建、市场元数据、真实进程终止和重开、raw/zstd、owner/cache/SQLite、严格 Remote/Client 及 tarball 加载通过。运行前后源码稳定，SHA-256 为 `5a73cfca654ce65481ff0515ea884f2b109aadde66d14fd94156c43ea6508631`。[本地平台报告](../../.local/platform/darwin-arm64-YY7Z62/verification.json)
- 同轮真实 Loader tarball 验证实际执行单项永久删除、关闭与重新激活；包 SHA-256 为 `689961c3843d0235c2c2518b1124d6f4ce32aeece2b34e0989a9ec298d1e9118`。[打包报告](../../.local/lifecycle/package-c5bbaH/verification.json)

该平台报告只证明本机组合；其他平台须以对应 runner 的独立实际验收为准，candidate 通过不自动晋级生产资格。

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
