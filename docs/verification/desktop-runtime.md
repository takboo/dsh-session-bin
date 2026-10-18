# DSH rc.2 桌面运行时兼容性验证

日期：2026-10-18。基线为 `v0.2.2` / `20b42ea8a623ba9835ab2b60ab0a57a13359f116`，桌面准入修复从 `0.2.3` 开始，正式发布版本为 `0.2.4`。`v0.2.3` 的正式标签验收发现 GUI 历史就绪时序问题，未生成 GitHub Release 或 npm 版本；修正及最终发布复核见[历史就绪验证](gui-history-readiness.md)。本页保留初始准入证据。目标为本机已安装的 DSH `0.2.1-rc.2`、macOS `15.7.9` ARM64/APFS、Electron `44.7.0` / Node `24.21.0` / libuv `1.52.1`；一手依据与原生模块审计见[桌面研究](../research/dsh-0.2.1-rc2-desktop.md)。原有独立 Node 五平台证据见[rc.2 验证](dsh-0.2.1-rc2.md)。

## 复现与修复

真实桌面应用二进制在 `ELECTRON_RUN_AS_NODE=1` 下报告 Node `24.21.0`；`0.2.2` 的 owner 在读取 SDK 指纹前只允许 `24.18.1`，因此没有组合删除 owner，准备返回 `permanent-deletion-unsupported`。同一隔离样本在固定 Node `24.18.1` 下 blockers 为空，在桌面实际运行时下稳定复现用户提示。

复现命令是应用二进制运行 `.local/debug/deletion-qualification.mjs`；该脚本通过正式 `SessionBin.preparePurge` 检查 blocker，比较前后 transcript，不执行删除。修复后，增加实际 ASAR bootstrap 重跑同一脚本，`nativeOwner: true`、`blockers: []`；没有测试资格回调或 Host 配置绕过。

新增 `nativeRuntimeCandidate` 区分已审计运行时载体与生产平台资格；只有独立验收的 `darwin/arm64 + Electron 44.7.0 + Node 24.21.0 + libuv 1.52.1` 加入生产表，原独立 Node 五平台资格保持。SDK 版本、源码摘要、具体 JSONL 实例、活动、资源身份、锁与未知状态保护继续执行。普通 Node 24.21、未来 Electron/Node 版本和其他桌面架构仍拒绝；准入回归先因 `false !== true` 失败，修复后通过。

包的 `engines.node` 枚举两个精确 Node 版本，构建工具继续由 mise 固定为 `24.18.1`。平台检查与容器镜像读取 mise 构建版本；Release 要求所有 payload 证据使用同一实际平台 Node。新增范围回归先因旧的 engine 字符串比较失败，修复后通过，并拒绝混用范围内不同 Node 的报告。Electron 子进程携带上游正式使用的 `--expose-internals`。

## 独立桌面运行时资格

候选阶段先在临时 DSH_HOME 上运行原 389 项回归：383 通过、6 项 Windows 专用检查跳过。随后增加生产准入回归，撤去候选回调，由新正式任务 `mise run verify:desktop` 验证实际 ASAR SDK 和生产组合：391 项，385 通过、0 失败、6 跳过；运行前后源码稳定，清单 SHA-256 为 `68caef32bd345e67ed7f14f42d6e03c15c98b7619b3ddee9cf618b19d864bdf3`。[最终正式报告](../../.local/desktop/darwin-arm64-sv0vXp/verification.json)

正式 probe 逐项核对桌面 ASAR 的 18 个 SDK 文件、版本及 SHA-256，并通过生产 Service 的真实准备路径。完整 Host/lifecycle 测试使用该 ASAR 中的 SDK 和原生模块，覆盖 raw/zstd、已启用 SQLite/cache、API idle release、活动与 reader/writer 拒绝、跨进程锁、实际 SIGKILL 与重开、固定批量、清空及未知结果保护。四组独立浏览器客户端 fixture 使用 npm 的公开预编译客户端，因为桌面 Host 树不包含这些独立浏览器包；它们同样运行于实际 Electron Node。

该运行时 SQLite 为 `3.53.4`、Zstd 为 `1.6.0`、模块 ABI 为 `149`，与固定独立 Node 有差异；上述资格来自实际行为结果，而非仅依赖相同 SDK hash 或 libuv。

最终源码在固定 Node `24.18.1` 下的类型、构建、391 项回归及实际 tarball Loader 也通过，[平台报告](../../.local/platform/darwin-arm64-n1gvAa/verification.json)的源码摘要与桌面全量报告一致。

`mise run verify:desktop:gui` 使用同一实际 Electron 载体运行隔离 npm Web Host/Client，ASAR production probe 另行复核准入；[最终桌面 GUI 报告](../../.local/desktop/darwin-arm64-vYRHFJ/verification.json)通过且源码稳定。中文、英文各 17 项检查通过，覆盖单项、固定批量、清空、重启核对与安装卸载，`browserConsole`、`pageErrors` 均为空，四次 Host 关闭均为 code 0、signal null、forced false。两份 GUI 报告及 Loader 使用同一 tarball，SHA-256 为 `49008d11d0f33219b91fc317a276c55fc16f2162db0a913d1bd493a11e1fd067`。该结果验证桌面运行时载体上的公开 Web 客户端，不代表驱动了原生 Desktop shell。

## 原独立 Node 五平台回归

[PR #11 的完整 CI](https://github.com/takboo/dsh-session-bin/actions/runs/39095141483)在修复提交 `4946768034cc574ccac8870edb9b9e2ee0e328c0` 上通过，SDK 均为 `0.2.1-rc.2`、Node 均为 `24.18.1`。下载并逐项核对全部 20 份平台、Loader 和双语 GUI 报告，源码前后稳定、生产删除资格成立，每个平台的 Loader 与两种 GUI 使用相同 tarball，console/pageErrors 为空，Host 均正常退出。[汇总](../../.local/ci-desktop-pr/summary.json)

| 平台 | 文件系统 | 全量与 Loader | 中文 / 英文 GUI |
| --- | --- | --- | --- |
| Windows x64 | NTFS | 通过 | 各 17 项通过 |
| macOS ARM64 | APFS | 通过 | 各 17 项通过 |
| macOS Intel | APFS | 通过 | 各 17 项通过 |
| Linux ARM64 | ext4 runner | 通过 | 各 17 项通过 |
| Linux x64 | ext4 runner | 通过 | 各 17 项通过 |

POSIX 源码清单摘要与上述本地最终报告相同；Windows checkout 的字节清单摘要为 `b9052b9f5a924933b73d973c063e9021f258ea4fef6188df9cbbe2e5d2af1d89`。Linux x64 发布候选 tarball 与本地最终桌面 GUI 产物字节摘要相同。该矩阵复核原独立 Node 支持范围，不授予五个平台的 Electron 桌面资格。

## 从已发布 0.2.2 的冷重启升级

旧样本来自 `v0.2.2` 源码中的 fixture 与已发布 tarball 的原始 `dist`，依赖仍为同一 rc.2 SDK，运行于固定 Node `24.18.1`；辅助 fixture 仅调整测试根到主工作区的 `.local/lifecycle`。完全关闭旧进程后，使用实际桌面 Electron 与 ASAR SDK 打开同一数据。

| 旧状态 | 桌面运行时复核 | 结果 |
| --- | --- | --- |
| prepared | 重新准备比较 binding、完整 manifest，再明确执行旧计划 | 通过 |
| done | 读取及重复执行返回既有相同回执 | 通过 |
| owner-fenced，raw/zstd | 旧进程真实 SIGKILL；沿用已有授权恢复同一操作 | 两种编码通过 |
| resource-effect，raw/zstd | 文件擦除后、确认前 SIGKILL；重开对账日志/cache/SQLite | 两种编码通过 |

四个中断样本保持旧 request、manifest 和 authorizationId；目标日志及派生记录缺失、sibling transcript 完整，重复提交返回原回执。旧 Zstd 日志从旧编解码运行时进入新运行时，没有改写资源身份或生成新删除授权。[升级报告](../../.local/desktop-upgrade-verification.json)、[中断恢复报告](../../.local/desktop-upgrade-crash-verification.json)。持久化身份继续遵循 [ADR 0011](../decisions/0011-runtime-and-durable-retirement-identity.md)。

全部会话操作均使用隔离 fixture 和临时 DSH_HOME；没有重启用户正在运行的应用或操作真实会话。范围不含其他桌面架构/版本、普通 Node 24.21、其他文件系统、多 Host、原生 Desktop shell、物理 OS 输入法或掉电保证。
