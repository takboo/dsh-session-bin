# DSH 0.2.1-rc.2 兼容性验证

日期：2026-10-17。插件版本 `0.2.2`；远程 `main` 已拉取，基线为 `4936672ae84ff21877ad7c609e71b091dd384727`（插件 `0.2.1` / DSH `0.2.1-rc.1`）。目标精确固定为 `0.2.1-rc.2`；一手源码、npm 摘要及差异见[接口调研](../research/dsh-0.2.1-rc2.md)。

## 接口与准入

未发现本插件使用的接口或存储协议新增不兼容：删除涉及的 Session、JSONL、Workspace、cache、SQLite、API Session、Agent/AgentLoop 已审计编译文件与 rc.1 逐字节相同；JSONL 原始构造器 SHA-256 也相同。既有版本检查会拒绝 rc.2，因此本版同步精确 SDK 声明、lockfile、运行时版本准入及 GUI 基线，保留已核对的源码摘要和 [ADR 0011](../decisions/0011-runtime-and-durable-retirement-identity.md) 的持久化协议身份，没有扩大为 semver 范围或跳过源码检查。

pnpm frozen lockfile 安装禁用生命周期脚本；release-age 例外仅包含本次核对的精确官方包版本。与 rc.1 对照，依赖图除 SDK 版本替换外仅新增官方 `dsh-client-ui-deepseek-model-label-1017` 与 `dsh-web-deepseek-api`，其他包版本未漂移。界面与 Remote 交互保持原断言；实际运行结果如下，不以源码相同替代资格验证。

## 本地平台与真实 Loader

环境：macOS `15.7.9` ARM64、APFS（type `0x1a`）、Node `24.18.1` / libuv `1.52.1`、pnpm `11.23.0`，均使用 mise 固定工具。

- `mise run verify:platform`：389 项，383 通过、6 项 Windows 专用检查跳过；类型、构建、市场元数据、raw/zstd、真实进程中断与重开、owner/cache/SQLite、Remote/Client 及 tarball 检查通过。源码前后稳定，清单 SHA-256 为 `00550264bc37c5690589c1a7ce4ea2b032d6b4aa56b549253da98f5ac728c25d`。[平台报告](../../.local/platform/darwin-arm64-X0CeKG/verification.json)
- 真实 Loader 加载正式 tarball，实际完成单项永久删除、关闭与重新激活；`productionDeletionQualified: true`，包 SHA-256 为 `a2f61b561878c649b3bef9c194baad5940d29511abeea98e29c5535576ddb848`。[打包报告](../../.local/lifecycle/package-UowKWb/verification.json)

本地平台只证明本机组合，其他平台以独立 runner 的实际验收为准，candidate 通过不自动授予生产资格。

## 五平台生产资格

实现提交 `48bc4256e6c8199fdd6d81f0bb5382364e785778` 的 [PR CI run 39029189891](https://github.com/takboo/dsh-session-bin/actions/runs/39029189891) 全部通过；workflow 实际 checkout 的 PR merge commit 为 `d59a6376d887dbae0e175aa3610b57eb9dd012aa`。下载并逐份核对 20 份平台/Loader/双语 GUI 报告，全部为精确 DSH `0.2.1-rc.2`、Node `24.18.1` / libuv `1.52.1`；平台源码前后稳定，Loader 均为 `productionDeletionQualified: true`，GUI 均为 `supported` 并实际执行删除。

| 实际 runner | 架构 | 文件系统 | 平台/Loader/中文/English |
| --- | --- | --- | --- |
| Windows Server 2025 | x64 | NTFS，type `0x0` | 全部通过 |
| macOS 15 | ARM64 | APFS，type `0x1a` | 全部通过 |
| macOS 15 Intel | x64 | APFS，type `0x1a` | 全部通过 |
| Ubuntu 24.04 | ARM64 | ext2/ext3/ext4，type `0xef53` | 全部通过 |
| Ubuntu 24.04 | x64 | ext2/ext3/ext4，type `0xef53` | 全部通过 |

POSIX 源码清单 SHA-256 为 `00550264bc37c5690589c1a7ce4ea2b032d6b4aa56b549253da98f5ac728c25d`；Windows checkout 行尾对应清单为 `aff06f1cb6d8c3fc83cf7b63586ddc119a89889d7237dde4a8bdd6c7c8a56626`。各平台内部的 Loader 与双语 GUI tarball 摘要一致：POSIX 为 `a2f61b561878c649b3bef9c194baad5940d29511abeea98e29c5535576ddb848`，Windows 为 `8771cc7831a67d974d6301d3fc1a8d9b01821719ac9c4ebe99a1bee1a55b2ade`。每种语言各 17 项，console/pageErrors 为空；20 次 Host 关闭全部正常，未强制终止。Windows 使用隔离 IPC 投递 SDK SIGTERM handler，POSIX 使用 OS 信号。

上述独立运行授予 rc.2 对应生产组合资格，未扩展到 Windows ARM64、其他运行时或文件系统。正式发布仍由最终 tag workflow 重跑同一矩阵，仅发布该轮 Linux x64 同字节 Loader/双语 GUI 验证产物；实际分发摘要以 Release 的 `SHA256SUMS` 和 `release.json` 为准。

## 本地双语 CLI/GUI

`mise run verify:gui` 的[中文](../../.local/gui/client-zh-oMNhgk/verification.json)与[English](../../.local/gui/client-en-f8dRKZ/verification.json)各 17 项全部通过，均为 `deletionQualification: supported`。与上节 Loader 使用同字节 tarball；console/pageErrors 均为空，安装后及卸载后的四次 Host 关闭均 code 0、signal null、forced false。

实际覆盖原生归档/Undo、已有归档、搜索/分组/筛选、取消归档、打开历史后的空闲 Agent 释放与取消准备、重新归档后的永久删除、固定批量及完整清空范围、确认偏好及重载不重发、中文/English、浅深色/窄屏/键盘/composition。真实关闭并重开 SDK 后确认目标日志及派生记录清除、其他会话保留；CLI 完整 bundle 安装和卸载自然退出。测试使用沙箱外 Chrome 与临时 profile，需要 registry 网络，不推导全新 profile 离线安装能力。

## rc.1 到 rc.2 的持久化兼容

更新依赖前，以基线实现及已安装 rc.1 SDK 在临时 DSH_HOME 创建样本，完全关闭旧 Context/进程后，由 rc.2 公共服务打开同一数据。

| rc.1 状态 | rc.2 复核 | 结果 |
| --- | --- | --- |
| prepared，未执行 | 重新准备比较 binding 与完整 manifest；明确执行旧冻结计划，保留 sibling | 通过 |
| done | 读取旧回执、重复 execute 返回同一结果 | 通过 |
| owner-fenced，raw/zstd | 真实 SIGKILL 后沿用已有授权恢复同一操作 | 两种编码通过 |
| resource-effect，raw/zstd | 文件擦除后、回执确认前 SIGKILL；重开对账日志/cache/SQLite | 两种编码通过 |

四个中断样本逐项比较旧 request、manifest、authorizationId；目标日志与派生记录缺失，sibling transcript 完整，重复 execute 仅返回既有回执。恢复没有生成新目标或删除授权。证据为[升级报告](../../.local/rc2-upgrade-verification.json)与[故障恢复报告](../../.local/rc2-upgrade-crash-verification.json)。

所有检查仅使用隔离数据，未操作真实用户会话。范围不含跨 SDK 热接管、多 Host、其他文件系统、共享附件 GC、安全擦除、掉电保证、原生桌面 shell 或物理 OS 输入法验收；Windows ARM64 继续不在支持范围内。
