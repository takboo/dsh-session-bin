# DSH 0.2.1-rc.5 正式构建兼容性验证

日期：2026-10-30。基线为 `main` 的 `34ef1136c1e6df197677fc793120249e71fc2153`（已发布插件 `0.2.6` / DSH `0.2.1-rc.3`），实现见已合并的 [PR #21](https://github.com/takboo/dsh-session-bin/pull/21)，合并提交为 `e268f2418d8cc8588ba6e47c389cd3971a32b0ae`。插件 `0.2.7` 对应 rc.5；既有 `0.2.6` 仍对应 rc.3。一手源码、发布物与依赖图审阅见[rc.5 调研](../research/dsh-0.2.1-rc5.md)。

## 自动化证据与批准状态

rc.5 的[五平台候选检查](https://github.com/takboo/dsh-session-bin/actions/runs/40916669401)和[官方 macOS ARM64 Desktop 候选检查](https://github.com/takboo/dsh-session-bin/actions/runs/40989055392)均通过；[Issue #20](https://github.com/takboo/dsh-session-bin/issues/20)的 `partial` 保留其候选含义，不能代替正式构建的生产准入验收。

原 PR CI [40918828680](https://github.com/takboo/dsh-session-bin/actions/runs/40918828680) 为 `action_required`，没有 job 或 check-run。事件 actor、PR 作者及创建提交均为 `github-actions[bot]`。GitHub 当前对 `GITHUB_TOKEN` 创建/更新 PR 产生的工作流要求批准，见[官方触发规则](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/trigger-a-workflow)。该状态发生于执行前，不能解释为测试失败或兼容性通过。维护者推送审阅后的实现后，最终工作流正常执行并通过，没有取消安全设置或改写旧运行证据。

## 正式源码与启动竞态回归

SDK 宿主、参与包与 JSONL adapter 的精确版本检查升级至 rc.5；18 个实现文件 SHA-256、私有类检查、运行时/平台/文件系统/存储范围和 schema-1 durable 身份保持。所有检查使用独立 fixture 和临时 DSH_HOME。

首轮本机正式 Node 与官方 ASAR 全量检查各 429 项，423 通过、6 项 Windows 检查跳过；该实现的 source inventory SHA-256 为 `c94c32216175d8dd25bb9694e10f6e09f1c4a9b352ffaf10fc1ce40c74aa427a`。随后一次 Node 中文 GUI 复验在首次加载面板时失败：预期两个已有归档，实际为 0；Host 日志显示 `NativeMetadataRefusal: Native metadata service composition changed`，未进入删除准备或执行。原始[失败报告](../../.local/gui/client-zh-xk8kcs/verification.json)与 Host 日志保留，不计作完成证据。

以真实 SQLite Query provider 在 owner journal 的异步 open 期间就绪为触发条件，新增确定性回归；旧实现约 0.34 秒复现同一 `native/composition-changed` 启动失败。修复把最终服务快照放在异步 domain/journal/owner 初始化之后，复核可见 pending provider，再同步捕获并安装保护。没有延长 GUI 断言超时、忽略归档数、删除实例检查或自动重发删除。

修复后的同一回归约 0.70 秒通过，并核对新 Query index 进入冻结资源清单、实际删除目标而保留 sibling，以及运行中 Query path 漂移仍返回 `native/composition-changed`、保留日志。相关 Host/元数据 53 项全部通过。启动修复实现的本机清单 SHA-256 为 `0f50475b565728ba0134e1f05e5e8c00786ae4c0c122bffbaf09b6ad3b13a587`，对应下表的 430 项 ASAR 与同字节 tarball 证据；不能沿用修复前的 429 项报告。后续只修改平台证据采集及其测试，产品源码和该 tarball 不变，完整清单对应关系见后文。

## 启动修复实现的本机独立验收

macOS `15.8.1` ARM64、APFS。使用 mise 固定 Node `24.18.1` / libuv `1.52.1`、pnpm `11.23.0`、gh `2.102.0`；mise 数据、状态与缓存均置于工作区 `.local/`。官方 rc.5 应用独立解压并验签，真实 ASAR/native modules 的 runtime 与发布元数据一致：Electron `44.7.0`、Node `24.21.0`、libuv `1.52.1`、ABI `149`、SQLite `3.53.4`、Zstd `1.6.0`、Host protocol `4`。

| 正式构建检查 | 结果与证据 |
| --- | --- |
| 类型、启动回归及相关 Host/元数据 | 类型通过，确定性回归通过，53 项相关检查通过；运行时配置漂移仍拒绝删除。 |
| 官方 ASAR 全量 | 430 项，424 通过、0 失败、6 项 Windows 检查跳过；源码前后稳定，对应上述最终清单。[完整报告](../../.local/desktop/darwin-arm64-vWywRn/verification.json) |
| Node 真实 Loader | 归档、取消归档、实际删除、卸载与再次激活通过；`productionDeletionQualified: true`、candidate 为 false。[报告](../../.local/lifecycle/package-QThzIA/verification.json) |
| 官方 ASAR 真实 Loader | 相同正式 tarball、实际 ASAR Host 上通过，production 为 true、candidate 为 false。[报告](../../.local/lifecycle/package-ktuWjo/verification.json) |
| Node 双语 GUI | [中文](../../.local/gui/client-zh-kY3qzT/verification.json)与 [English](../../.local/gui/client-en-EkjibK/verification.json)各 17 项通过，均为 `supported`、production 为 true。 |
| 官方 Electron 双语 GUI | [汇总](../../.local/desktop/darwin-arm64-tnvd97/verification.json)源码稳定；[中文](../../.local/gui/client-zh-aSMD8l/verification.json)与 [English](../../.local/gui/client-en-OqYdth/verification.json)各 17 项通过，均为 `supported`、production 为 true、candidate 为 false。 |

两份 Loader 和四份 GUI 使用同字节 tarball，SHA-256 为 `070d6bb6f48d64f71d1d492376eec6110265117b4e538543b35ad88819c8ed42`。GUI 覆盖原生归档/Undo、既有归档、搜索分组筛选、取消归档、两次延迟真实历史打开、空闲占用释放、固定批量与完整清空、确认设置、重载不重发、双语浅深色、窄屏、键盘和 composition。四份报告 console/pageErrors 为空，八次 Host 关闭均为 code 0、signal null、forced false。关闭并重开后，公共 SDK 复核目标日志及派生索引清除、非目标日志和 Workspace 成员保留。

本地独立报告检查器逐份核对运行时、源码清单、production/candidate 标记、GUI 检查和 Host 关闭结果，并要求六份 tarball 摘要一致；汇总见[本机证据](../../.local/rc5-review/accepted-local.json)。

### rc.3 → rc.5 冷升级

从干净 rc.3 / 已发布 `0.2.6` 的构建重新生成两套独立样本，旧 Context/进程完全关闭后，在同一路径升级为最终正式源码及精确 rc.5 依赖，frozen install、禁用安装脚本。不使用 candidate overlay 或平台资格回调。

Node 和官方 ASAR 各 8 组通过：prepared、done、owner-fenced、resource-effect 分别覆盖 raw/zstd。中断样本为真实 SIGKILL；恢复沿用原 plan、operationId、授权与资源清单，重复执行返回同一回执，目标日志缺失而 sibling 保留。没有生成新删除授权或因重开自动重发。实际结果分别见 [Node 日志](../../.local/rc5-review/postfix-upgrade-node-verify.log)、[ASAR 日志](../../.local/rc5-review/postfix-upgrade-desktop-verify.log)。

### 未计入验收的本机运行

最终 ASAR 首次全量重跑仅干净搬迁文档检查失败：该运行启动时，新 rc.5 验证文档尚未创建并纳入快照。补齐后，同一官方 Electron 的单项搬迁回归通过，随后完整 430 项重新通过；旧失败保留于 `.local/desktop/darwin-arm64-4woSal/`，不改写为成功。

另一次桌面 GUI 收集器混入同目录下并行 Node GUI 的新报告，因 `v24.18.1` 不符预期 `v24.21.0` 而拒绝汇总。Node GUI 结束后串行完整重跑，形成表中独立通过证据；未移除运行时检查、筛掉失败或将混合报告计为桌面资格。

## 五平台正式检查与文件系统证据修正

实现提交 `c4769d341dc7ddec2d90d088cbfe61169ee40018` 的[PR 生命周期 CI](https://github.com/takboo/dsh-session-bin/actions/runs/40994185450)五个平台均通过，两个发布 job 跳过。下载报告时发现 macOS ARM64 的 raw `statfs.type` 为 `0x19`，旧证据采集器仅把 `0x1a` 识别为 APFS，因此记录 `unknown-0x19`。这轮绿色结果保留，但不能据该未知名称声称 runner 的 APFS 资格。

平台证据采集改为通过 `df -P` 解析实际设备，再从该设备的 `mount` 记录读取文件系统名称，仍原样记录 raw type 和 block size。拒绝设备缺失、名称缺失或同设备名称矛盾，不把未知类型静默转成 APFS，也不改变产品的平台准入。Apple 的 [statfs 结构](https://developer.apple.com/library/archive/documentation/System/Conceptual/ManPages_iPhoneOS/man2/statfs.2.html)分别定义数值 `f_type` 和名称 `f_fstypename`，不能用观察到的一台机器的数值替代名称采集。

同一采集入口的回归在旧逻辑下 5 项中 4 项失败；修正后 5 项全部通过，覆盖 `0x19`/`0x1a` 同为实际 APFS、相同数字的不同文件系统不误报 APFS，以及缺失/矛盾设备拒绝。本机实际采集为 `apfs` / `0x1a` / block size `4096`；runner 的实际名称由修正后的完整五平台 CI 重新采集。

清单核对还发现本机完整快照含两份 Git 忽略的 Finder 元数据：`.github/.DS_Store`、`src/.DS_Store`。`c4769d3` 的干净 CI 清单为 `22c126134efa4f173bea96d475510b1163e7fd87ac6eb10651f61e3fd8a4c66e`；除这两项外，本机与 CI 的每个实现文件逐项相同。没有删除这两份本机文件或忽略任何实现差异；Windows 再逐项核对 LF/CRLF。

证据采集修正后的完整本机清单为 `5da4ac38153c7a7057bf19ef4868483307ffe2ad8ecb852e5c9d5e6860a2479a`，对应干净 CI 的 124 文件清单 `3e81ffe70e0daa37062324ce5a38c89e3232e98103bba5fac3adb2109a40872b`。与 `c4769d3` 相比仅新增 `filesystem-evidence` 采集模块及五项测试，并让 `verify-platform` 调用该模块；生产源码、SDK 指纹和正式 tarball 字节保持不变。最终五平台运行与各份原始报告从 [PR #21 checks](https://github.com/takboo/dsh-session-bin/pull/21/checks)检索，核对时须使用此轮新清单及实际文件系统名称。

## 最终正式验收与 0.2.7 发布基线

最终实现提交 `6199c0e7b6090c0c4c67573384c46d6be9120647` 的[完整 PR CI 40995615703](https://github.com/takboo/dsh-session-bin/actions/runs/40995615703)五个平台全部通过，两个发布 job 均跳过。已下载并独立校验全部 20 份平台、Loader、中文和 English 报告；Windows x64 的实际文件系统为 NTFS，macOS ARM64/Intel 均采集到 `apfs`，Linux ARM64/x64 为 ext2/ext3/ext4 family（`0xef53`）。所有报告的精确 SDK、Node/libuv、架构、源码稳定性及 production/candidate 标记均匹配正式资格；十份 GUI 各 17 项通过，console/pageErrors 为空，20 次 Host 关闭均正常且无强制终止。各平台 Loader 与两种语言 GUI 使用同字节 tarball，汇总见[CI 证据](../../.local/rc5-review/accepted-ci.json)。

最终完整清单上的官方 ASAR 回归为 435 项，429 通过、0 失败、6 项 Windows 专用检查跳过，[报告](../../.local/desktop/darwin-arm64-um5wVh/verification.json)源码稳定、production 为 true、candidate 为 false；最终官方 Electron 双语 GUI [报告](../../.local/desktop/darwin-arm64-PZSGrY/verification.json)同样通过。此轮全量取代前述 430 项运行作为最终实现的完成证据，原始历史保留。

`0.2.7` 发布准备只递增包版本并同步文档；SDK、产品实现及资格表与上述已验收提交一致。版本变化会产生新的 tarball 摘要，不能沿用本页 `0.2.6` 基线 tarball 的摘要。tag 工作流须重新完成五平台验收，并将 Linux x64 同轮 Loader 和双语 GUI 测试过的同一份 tarball 发布到 GitHub Release 与 npm；桌面运行时的生产实现证据仍由上述真实 ASAR 验收限定。

## 资格与证据边界

正式五平台结果由 [PR #21 的生命周期 CI](https://github.com/takboo/dsh-session-bin/pull/21/checks)保存，每个实际 runner 分别产生平台、Loader、中文和 English 四份报告。必须逐份核对 rc.5、实际 Node/libuv/架构/文件系统、源码前后稳定、Loader 的 `productionDeletionQualified: true`、GUI 的 `supported` 及实际删除/重开结果；macOS 必须有实际采集的 `apfs` 名称。候选报告或仅有工作流绿色结论不足以授予资格。

官方桌面另用重新下载并验签的独立 rc.5 应用，执行 `verify:desktop`、真实 ASAR Loader、`verify:desktop:gui` 及八组 raw/zstd 冷升级。正式报告必须没有 candidate marker，并与上述最终实现清单匹配。Electron 限 `44.7.0` / Node `24.21.0` / libuv `1.52.1`、macOS ARM64/APFS；独立 Node 限 `24.18.1` / libuv `1.52.1` 及各自实际验收的五平台组合。

GUI 使用公开 npm Web Host/client，在 Node 或官方 Electron 载体上运行；真实 ASAR Host/native modules 另由完整回归和 production probe 覆盖。不声称覆盖原生 Desktop shell、物理输入法、真实账号/推理、多 Host、其他平台/运行时/文件系统/存储、共享附件 GC、安全擦除或掉电保证。插件 `0.2.7` 按[发布流程](../release.md)由 `v0.2.7` tag 重新运行五平台验收后发布；发布身份与各报告来源以该 tag 工作流的 `release.json` 为准。
