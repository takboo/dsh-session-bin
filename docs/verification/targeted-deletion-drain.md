# 0.2.6 删除目标释放与误阻止验证

日期：2026-10-24。基线为 `76ea6901a9fc1c55387be93a7a4378a24fdfc0bd`（0.2.5 / DSH 0.2.1-rc.3），更新远端后无新提交。所有检查使用独立 fixture、临时 DSH_HOME，没有操作真实会话。

## 已证实的问题与修复

基线重复复现：没有 API Agent 的冷历史订阅无法被显式删除准备释放；全局 migrationPreparations 非空与无法定点的 closeFollowers 数量会误阻止其他目标。此为锁定 SDK 上的隔离复现，不声称已经复现用户的 Windows Desktop 环境。

永久回归先于修复运行，六项中五项失败（约 0.4 秒）。修复后六项全部通过，并补充缺少 query 见证、subagent child SID、旧 prepared revision 迟到 promotion 三项。目标自身的独立读取、活动任务、外国 Agent 和安装前冷 query 引用继续保护；不为删除强制关闭陌生流。

一手 SDK 的 history/query 行为依据见[接口调研](../research/dsh-0.2.1-rc3.md#history-与目标占用026-修复复核)。本轮使用真实 SDK history/query、SessionStore 和 JSONL，加受控 Agent capability 验证迟到 promotion 被围栏阻止，没有放宽 SDK 白名单。全局 header/corpus 读屏障保留，provider 迁移仅按目标 SID 检查。

界面分别映射 reader、writer、pending、migration、query、follow、unknown-follow 和 cache-dirty；保留旧错误码的历史回执兼容。固定授权、资源身份、内核租约、未知状态和重载不重发均保持原契约。

## 运行结果

本机 macOS 15.7.9 ARM64/APFS，mise 固定 Node 24.18.1 / libuv 1.52.1、pnpm 11.23.0；桌面载体为官方 rc.3 Electron 44.7.0 / Node 24.21.0 / libuv 1.52.1。原始隔离反馈四项、永久新增九项、元数据全部 45 项与双语错误映射均通过。

- `mise run verify:platform`：400 项，394 通过、0 失败、6 项 Windows 专用检查跳过；类型、构建、raw/zstd、cache/SQLite、真实崩溃恢复、锁/并发及未知状态保护通过。[平台报告](../../.local/platform/darwin-arm64-agStBL/verification.json)
- `mise run verify:desktop`：同样 400 项、394 通过、0 失败、6 跳过；实际 ASAR SDK、原生模块与 production 准备 probe 通过。[桌面报告](../../.local/desktop/darwin-arm64-BSt1hS/verification.json)
- 正式 tarball Loader 安装、归档、取消归档、删除与卸载通过，`productionDeletionQualified: true`。[Loader 报告](../../.local/lifecycle/package-1xeCw3/verification.json)

两套全量的源码前后稳定，SHA-256 为 `5183f7e3df7940cae9066ddecc574d6b1ea1919e0a30b261cb0c79e5060d2e03`；Loader tarball SHA-256 为 `7b255fbb15666248b869b754da84e67e85f6a29515b53eb9ced033dfe28618f1`。正式 tag 仍须五平台完整 CI 通过后发布。

`mise run verify:gui` 的[中文](../../.local/gui/client-zh-4Cw2IE/verification.json)和[English](../../.local/gui/client-en-orTj1X/verification.json)各 17 项通过；`mise run verify:desktop:gui` 的[中文](../../.local/gui/client-zh-HUxK4S/verification.json)和[English](../../.local/gui/client-en-EOn2Aw/verification.json)也各 17 项通过，[桌面汇总](../../.local/desktop/darwin-arm64-03Fo3q/verification.json)源码稳定。四份报告的 tarball SHA-256 均与 Loader 一致，deletionQualification 为 supported；浏览器 console/pageErrors 为空，八次 Host 关闭均 code 0、signal null、forced false。覆盖单项、固定批量、清空、重载不重发、浅深色、窄屏、键盘和 composition；实际删除后重开复核，保留 sibling 记录。桌面证据为 Electron 上的隔离 Web Host/Client 加实际 ASAR probe，不声称驱动原生 shell 或物理输入法。

没有真实 Windows Desktop 环境；Windows x64/NTFS 的独立 Node 组合由实际 Windows CI runner 验收。该证据不能授予 Windows Electron/Desktop 或 ARM64 资格，也不能确认用户现场独有的占用来源。支持范围与 0.2.5 相同。
