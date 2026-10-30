# DSH 0.2.1-rc.5 正式构建兼容性验证

日期：2026-10-30。基线为 `main` 的 `34ef1136c1e6df197677fc793120249e71fc2153`（已发布插件 `0.2.6` / DSH `0.2.1-rc.3`），工作分支为 [PR #21](https://github.com/takboo/dsh-session-bin/pull/21)。插件发布版本保留 `0.2.6`，本分支尚未发布；npm/GitHub Release 的既有 `0.2.6` 仍对应 rc.3。一手源码、发布物与依赖图审阅见[rc.5 调研](../research/dsh-0.2.1-rc5.md)。

## 自动化证据与批准状态

rc.5 的[五平台候选检查](https://github.com/takboo/dsh-session-bin/actions/runs/40916669401)和[官方 macOS ARM64 Desktop 候选检查](https://github.com/takboo/dsh-session-bin/actions/runs/40989055392)均通过；[Issue #20](https://github.com/takboo/dsh-session-bin/issues/20)的 `partial` 保留其候选含义，不能代替正式构建的生产准入验收。

原 PR CI [40918828680](https://github.com/takboo/dsh-session-bin/actions/runs/40918828680) 为 `action_required`，没有 job 或 check-run。事件 actor、PR 作者及创建提交均为 `github-actions[bot]`。GitHub 当前对 `GITHUB_TOKEN` 创建/更新 PR 产生的工作流要求批准，见[官方触发规则](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/trigger-a-workflow)。该状态发生于执行前，不能解释为测试失败或兼容性通过。审阅后的实现需由维护者提交触发或批准最终工作流，不取消安全设置、不改写旧运行证据。

## 正式源码与启动竞态回归

SDK 宿主、参与包与 JSONL adapter 的精确版本检查升级至 rc.5；18 个实现文件 SHA-256、私有类检查、运行时/平台/文件系统/存储范围和 schema-1 durable 身份保持。所有检查使用独立 fixture 和临时 DSH_HOME。

首轮本机正式 Node 与官方 ASAR 全量检查各 429 项，423 通过、6 项 Windows 检查跳过；该实现的 source inventory SHA-256 为 `c94c32216175d8dd25bb9694e10f6e09f1c4a9b352ffaf10fc1ce40c74aa427a`。随后一次 Node 中文 GUI 复验在首次加载面板时失败：预期两个已有归档，实际为 0；Host 日志显示 `NativeMetadataRefusal: Native metadata service composition changed`，未进入删除准备或执行。原始[失败报告](../../.local/gui/client-zh-xk8kcs/verification.json)与 Host 日志保留，不计作完成证据。

以真实 SQLite Query provider 在 owner journal 的异步 open 期间就绪为触发条件，新增确定性回归；旧实现约 0.34 秒复现同一 `native/composition-changed` 启动失败。修复把最终服务快照放在异步 domain/journal/owner 初始化之后，复核可见 pending provider，再同步捕获并安装保护。没有延长 GUI 断言超时、忽略归档数、删除实例检查或自动重发删除。

修复后的同一回归约 0.70 秒通过，并核对新 Query index 进入冻结资源清单、实际删除目标而保留 sibling，以及运行中 Query path 漂移仍返回 `native/composition-changed`、保留日志。相关 Host/元数据 53 项全部通过。最终实现清单 SHA-256 为 `0f50475b565728ba0134e1f05e5e8c00786ae4c0c122bffbaf09b6ad3b13a587`；后续正式平台/桌面验收必须对应该清单，不能沿用修复前的 429 项报告。

## 资格与证据边界

正式五平台结果由 [PR #21 的生命周期 CI](https://github.com/takboo/dsh-session-bin/pull/21/checks)保存，每个实际 runner 分别产生平台、Loader、中文和 English 四份报告。必须逐份核对 rc.5、实际 Node/libuv/架构/文件系统、源码前后稳定、Loader 的 `productionDeletionQualified: true`、GUI 的 `supported` 及实际删除/重开结果。候选报告或仅有工作流绿色结论不足以授予资格。

官方桌面另用重新下载并验签的独立 rc.5 应用，执行 `verify:desktop`、真实 ASAR Loader、`verify:desktop:gui` 及八组 raw/zstd 冷升级。正式报告必须没有 candidate marker，并与上述最终实现清单匹配。Electron 限 `44.7.0` / Node `24.21.0` / libuv `1.52.1`、macOS ARM64/APFS；独立 Node 限 `24.18.1` / libuv `1.52.1` 及各自实际验收的五平台组合。

GUI 使用公开 npm Web Host/client，在 Node 或官方 Electron 载体上运行；真实 ASAR Host/native modules 另由完整回归和 production probe 覆盖。不声称覆盖原生 Desktop shell、物理输入法、真实账号/推理、多 Host、其他平台/运行时/文件系统/存储、共享附件 GC、安全擦除或掉电保证。本轮不打 tag、创建 Release 或发布 npm 包。
