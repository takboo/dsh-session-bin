# Host 生命周期实现验证

本文分节记录 Host 生命周期的运行证据，各节有独立代码基线与限制；当前 dev.2 真实冷 JSONL 删除、固定批量及清空的证据见下一节，后续章节保留较早的消费者与 owner 验收。目标 SDK：DSH `0.2.0-rc.2`。完整客户端与双语 GUI 验收另见[客户端验证](client-interface.md)。

## dev.2 真实冷 JSONL 删除与固定批次验证

日期：2026-10-09。基线为 `e26e0dbeea2caf7cd6db3021cfbcd85b15c968ec` 加真实 Adapter、跨平台候选、严格 Remote、单项/批量/清空及客户端恢复修复的工作区变更。正式行为见[Host 契约](../host-lifecycle.md)和[客户端契约](../client-interface.md)，采用的决定见 [ADR 0007](../decisions/0007-native-jsonl-deletion-adapter.md)、[ADR 0008](../decisions/0008-cross-platform-retirement.md)和 [ADR 0009](../decisions/0009-fixed-purge-batches.md)。

[macOS ARM64 报告](../../.local/platform/darwin-arm64-ozR31f/verification.json)与[Linux ARM64 容器报告](../../.local/platform/linux-container-rcnaCX/platform/linux-arm64-BzdmL3/verification.json)均为 `passed`、退出码 **0**、`sourcesStable: true`。两端记录同一 90 文件源码/配置清单，清单摘要为 `fe69a7490825cd975f56a8002c47d2812eede583a3dc8f643b345d5cba47ba64`；包含实现、测试、脚本、CI、工具与锁文件，正式验收文档不在该清单内。环境为 Node `24.18.1`、libuv `1.52.1`、pnpm `11.7.0`、SDK `0.2.0-rc.2`。

| 环境与命令 | 实际结果与边界 |
| --- | --- |
| macOS ARM64：`mise run verify:platform` | 两端严格类型检查、构建、**342 项通过 / 6 项 Windows 专属跳过 / 0 失败**，共 348 项；真实 Loader/tarball 检查通过。 |
| Linux ARM64：`mise run verify:linux` | `node:24.18.1-bookworm`、实际 Linux 内核、独立容器文件系统；相同检查 **341 项通过 / 7 项跳过 / 0 失败**。跳过 6 项 Windows 专属检查及依赖既有 GUI tarball 的 CLI 退出检查，未把缺失 fixture 算作 CLI 验收。 |
| 文件系统观察 | [同轮 statfs 证据](../../.local/platform/client-recovery-filesystems-20261009.json)：macOS fixture 的 type 为 `0x1a`；Linux `/work` 与 fixture 为 overlayfs `0x794c7630`，block size 均为 4096。源码只读挂载在 `/source`，实际测试根位于容器 `/work`。不外推网络文件系统或其他文件系统。 |

| 范围 | 实际验证 |
| --- | --- |
| 真实日志与资源 | raw/zstd 的冻结 historical/current/materialization/migration 清单逐文件清除；保留目录及原生协调身份、共享附件、独立 fork 和未选中会话。真实 Workspace、projection cache 与 SQLite 自身对账收敛，重开后目标日志及派生记录保持缺失。 |
| 独立准入 | 源码/实例/版本/平台检查、归档与固定观察、exact lifecycle、完整清单和活动复核；live/retained handles、独立 writer、未知资源、symlink/junction、hard link、不可读 header、零身份及旧整库 cache 复活源在资源效果前被拒绝。 |
| 中断与恢复 | 真实 raw/zstd 删除各 7 个 SIGKILL 边界，共 **14 个**：plugin intent、authorizing、owner fence、resource effect、owner done、观察 entry 删除、plugin done。重开处理原 operation 与清单，保留 guard；旧消费者 7 边界、owner 19 边界及可逆归档/恢复故障检查也随全量通过。 |
| 卸载与接管 | 关闭拒绝新请求、排空已接受 frame 及嵌套 I/O；同 SDK 实例重载匹配 durable store/root/fingerprint 后接管，旧 callable alias 撤销；保留 retired SID 保护。 |
| 真实固定批量与清空 | [真实 SDK 批次检查](../../tests/native-deletion-batch-host.test.mjs) raw/zstd 及 durable fence 共 3 项通过。固定对象、未选中日志摘要不变、筛选不改变清空集合、未知项暂停后续 admission；没有跨会话事务。 |
| 客户端与回执 | 摘要/资源/nonce 连续性、观察见证部分故障、原始缓存容量保护；批次停止/关闭/重载后 missing 项独立重新确认，旧 guard 直到执行新确认才替换，批次来源仍禁止 discard。连接与 baseline 改变、同步通知重入及异步 journal 查询后的旧点击均不能继续发送；未发送队列不重建。客户端三套定向检查 **67/67** 通过，其中批次模型 32 项、批次 DOM 5 项、单项/Remote 30 项；均进入上述全量。 |

本轮[macOS tarball 报告](../../.local/lifecycle/package-qCagP3/verification.json)与[Linux tarball 报告](../../.local/platform/linux-container-rcnaCX/lifecycle/package-T1O92G/verification.json)的 dev.2 包 SHA-256 同为 `9fa5d571d38a9458ac48dbf92250af477b8f1b49bdcecc9fc7484e4523e2ca67`。macOS 的真实 Loader 验证实际单项删除；Linux 的生产 Loader 明确验证 unsupported 拒绝与原字节保留，实际 Linux erasure 来自独立 fixture candidate 资格，二者不可互换。完整公开 CLI/GUI 安装、删除与卸载的当前证据见[客户端验证](client-interface.md)。

本轮回归先在未修模型上得到 8 项恢复/断线失败，又将独立审阅的 3 个通知重入与查询等待窗口变为确定性失败检查；最终对应回归、67 项定向及上述全量均通过。最终独立静态复核在这些限定窗口未发现剩余问题，静态检查不替代运行验收。较早失败平台报告的源码清单与本轮有差异，不能将其写成本轮失败或用其替代本轮通过。

### Linux CLI 补验与未通过边界

原 Linux 全量因旧 GUI tarball 缺失跳过了 CLI add/remove。随后把本轮同字节 dev.2 包放入隔离 fixture，补跑原[CLI 回归](../../tests/gui-uninstall.test.mjs)：首次安装失败为 `ERR_PNPM_NO_OFFLINE_TARBALL`，诊断中的[直接 pnpm 输出](../../.local/platform/linux-cli-diagnostic-HYV0Z7/direct-pnpm.json)明确缺少 `zod@4.6.5`；项目 frozen lockfile 的 `4.4.3` 缓存不足以覆盖新 profile 独立解析的传递依赖。另建临时 profile、禁用安装脚本预热缓存后，add 正常完成。

但 **remove 尚未通过自然退出检查**：[Corepack 原始 8 秒补验](../../.local/platform/linux-cli-accepted-6tDBNE/verification.json)失败；[30 秒诊断](../../.local/platform/linux-cli-accepted-GXmSmj/verification.json)仍未自然退出，[6 秒进程树](../../.local/platform/linux-cli-accepted-GXmSmj/process-160.json)显示 DSH CLI 与 pnpm 子进程均存活，[最终关闭记录](../../.local/platform/linux-cli-accepted-GXmSmj/cli-160.json)是外部 SIGTERM，不能把 `Done` 或超时终止算成通过。固定 Corepack 缓存及关闭其网络查询没有解除该等待。

[同版本原生 pnpm 对照](../../.local/platform/linux-cli-accepted-BquDVb/verification.json)也在原始 8 秒回归中失败，3 项中 2 通过、1 失败；对照使用 Node `24.18.1` 的 DSH CLI、官方 Linux ARM64 pnpm `11.7.0` 二进制及同版本 JS/主包元数据，原测试及自然退出断言未修改。[运行时来源及摘要](../../.local/platform/linux-cli-accepted-BquDVb/pnpm-runtime.json)保存 npm 分发完整性；早期对照目录缺少 JS 载荷/模块元数据的启动失败不作为正式 CLI 结果。30 秒副本仅作诊断，不替代原始回归。

固定 SDK 的 CLI 入口等待 `runPlugin` 返回后才 `process.exit`；remove 不走 add/install 的 registry lookup，CLI 模式继承 stdio且没有 capture idle timer。现有进程证据定位到 pnpm 子进程未退出，尚未证明其具体活动资源根因；没有修改 SDK、按输出推定完成或绕过退出检查。该补验与资源 candidate 全量分别记录，**Linux CLI/GUI 发布条件仍未满足**。

**生产支持及发布边界：** 默认资格仍仅为已验收 macOS ARM64 组合；Linux ARM64 的 candidate 通过不自动晋级。Windows x64、macOS Intel、Linux x64 尚无对应实际运行证据，6 项 Windows 专属跳过不能证明 Windows 支持。三类主要平台的实际删除及 CLI/GUI 闭环未全部验收，尚不能公开发布。所有数据、故障与 profile 均位于忽略的 `.local/`；未连接当前 `19387` GUI或破坏真实用户会话。单 Host、原生未观察 ABA、共享资源保留及不承诺安全擦除/掉电保证的边界继续适用。

## 原生归档单项删除准备与授权验证

本节基线为 `e26e0dbeea2caf7cd6db3021cfbcd85b15c968ec` 加本轮未提交的 Host 协议、fixture、测试及专题文档变更。九个实现/测试文件的[源码 SHA-256 清单](../../.local/lifecycle/native-retirement-evidence-Fz4VRU/source.sha256)已逐项校验，清单 SHA-256 为 `df199936df5488d695e632c8862a93b516bd277ed89d1d24a05485c61b41d423`。正式合约见[原生单项授权](../host-lifecycle.md#原生归档单项删除准备与授权)，架构决定见 [ADR 0006](../decisions/0006-native-archive-retirement-binding.md)。

最终 `mise run verify` **退出码 0**：两端类型检查、声明/预编译构建、**190/190 项测试**及 tarball/真实 Cordis Loader 检查全部通过。新增[原生目标消费者回归](../../tests/native-retirement.test.mjs) **29 项**，其中实际进程终止一项包含 **7 个 SIGKILL 边界**；此前的 161 项兼容、归档、owner 与资源准入回归也在同次全量通过。运行环境仍为 DSH `0.2.0-rc.2`、Node `24.18.1`、pnpm `11.7.0`、macOS ARM64，命令来源继续使用现有配置，无新增脚本命令或工具版本。

| 范围 | 实际验证 |
| --- | --- |
| 显式绑定与独立准入 | 既有 native archive 无旧 Bin 条目可进入 test-only owner 的显式准备；普通观察、list、reconcile 不补绑定、不清资源；owner 缺席、自报及仅有旧 Bin composition 资格均不启用原生目标。 |
| 固定对象与清单 | v2 native target/entryVersion/request kind 必须一致；准备后取消归档、已观察 ABA、生命周期、活动、清单和 descriptor 变化均拒绝，停止及资源效果为 0。准备 inventory 等待后再次复核固定对象。 |
| Admission 与快照 | intent、authorizing 及 before-authorize 的等待中观察到 ABA，owner 无 grant、无资源效果；执行入队即快照 caller plan，篡改 blockers 不能绕过重查；done 回执与后来观察条目分开。 |
| Pending 和兼容 | pending/partial 跨重开阻止新版 unarchive；普通查询不 recover；owner 缺席仍保留 guard。退出原生成员时列表隐藏对象但 exact metadata 保留，ABA 不替换 pending 观察；旧 pending 首次迁移仍显示所有原生成员。 |
| 共享 journal 与目标恢复 | 真实生产组合对 legacy/native pending 和已存在的 v2 观察均可初始化、列出、卸载；两消费者 drain 后才关闭共享 journal。已有 pending 交给错误消费者拒绝且 recover/effects 为 0；显式两种 journal 对账作为一个请求在 close 中排空。 |
| 未知 I/O | binding、intent 和已保存 owner done 的确认丢失，包括 falsy rejection 和包装的公开业务错误，暂停整个 ArchiveModule；重开只保守收敛原操作。完整 owner done 在 owner 不可用时只补匹配元数据。 |
| 实际进程死亡 | plugin intent、authorizing、owner fenced、resource effect、owner done、观察 entry 删除、plugin done 各 SIGKILL；重开使用同一请求和冻结清单，不新发 retire，不改变 native transcript、Workspace 或 archive。 |

独立只读审阅发现并复审了共享 journal 过早 close、跨协议 guard 的收敛死循环、已接受恢复的两段入队关闭窗口、旧 pending 隐藏首次原生观察，以及错误消费者恢复已有 pending 共五项问题。最终回归覆盖对应窗口。首轮定向运行因 descriptor 故障改到了未被消费的 fixture 副本而为 90/91；修正注入返回值后通过本次全量。中间全量尝试在严格可选属性类型检查处退出 2，修正后才得到上述完整通过结果；前两次尝试不计为验收通过。

同次全量的代表样本：[完整授权](../../.local/lifecycle/native-purge-complete-8RRlCh/)、[intent 死亡](../../.local/lifecycle/native-purge-crash-plugin-intent-wLND7M/)、[首次 owner fence](../../.local/lifecycle/native-purge-crash-owner-fenced-Rr7awF/)、[资源效果死亡](../../.local/lifecycle/native-purge-crash-resource-effect-RnMC5d/)、[观察元数据死亡](../../.local/lifecycle/native-purge-crash-plugin-entry-VKQa47/)。所有会话、owner 资源、协调目录与 DSH_HOME 都位于忽略的 `.local/lifecycle/` 随机目录。

[本轮 tarball 报告](../../.local/lifecycle/package-wAZyDr/verification.json)对应内部验证产物，SHA-256 为 `1fe8ea6ed7d2cf6d180a7bebc4d93f8d483eb69987fe624f83c590671f70e099`。用户待安装的[原 dev.1 包](../../.local/packages/dsh-session-bin-0.1.0-dev.1.tgz)保持不变，SHA-256 仍为 `72d08c9073dfc9a8a71c61e2799452712e0dac73ae40b6b7176ba6cd53251d95`。本轮未重跑 GUI；Client/Remote 回归随全量通过，实际双语 GUI 证据仍限此前原生归档重构的 dev.0 功能源码基线，未把它写作新授权接口的 GUI 验收。

**支持范围未扩大。** 测试 owner 仅清除自己拥有的临时 domain 资源并保留共享引用与协调记录；其 lifecycle scope 不协调真实 `workspaceRegistry` 的 archive/unarchive/pin，不能证明 native 联合 admission。锁定 SDK 仍缺 durable lifecycle token、完整资源围栏/排空/引用释放、索引缓存收敛和原生 owner 回执；旧 Bin `verified` 无法启用新目标，production 默认 native purge 仍 unsupported。Remote/UI、固定批量永久删除和清空未开放。没有连接当前 `19387` GUI、操作真实用户会话，或删除 native 会话目录、锁文件、共享附件、私有索引；单 Host、相同协调目录及未观察 ABA 的限制不变。

## 原生归档管理重构验证

本节针对原生 Archive 唯一入口的重构工作区，基线为 `d7d982e35a3603ad4c7d4f63c8540474f988e67d` 加本轮未提交变更，区别于下文旧 Bin、删除消费者和 owner 的历史基线。31 个实现、脚本、locale 和测试文件的[源码指纹](../../.local/lifecycle/native-archive-evidence-2fm_3rlz/source.sha256)已全部校验；清单 SHA-256 为 `fa70b0b40b563e7cb3e122f697db59768d320b9aa6321ce64bf5c53c8696423a`。新正式协议见[Host 生命周期](../host-lifecycle.md)，选定架构见 [ADR 0005](../decisions/0005-native-archive-collection.md)。固定 SDK 与工具仍为 DSH `0.2.0-rc.2`、Node `24.18.1`、pnpm `11.7.0`、macOS ARM64。

新增[归档回归](../../tests/archive.test.mjs) **32 项**和[新版真实进程中断](../../tests/archive-crash.test.mjs) **1 项（内部 5 个 SIGKILL 边界）**已随最终 `mise run verify` 全部通过：两端类型检查、构建、**161/161 项测试**及 tarball/真实 Loader 检查均成功，退出码 0。此前 31 项定向检查也通过；定向复现使用既有固定工具命令 `mise exec -- node --test --test-concurrency=1 tests/archive.test.mjs tests/archive-crash.test.mjs`。所有会话、日志、故障、协调目录与测试 owner 数据均位于忽略的 `.local/lifecycle/` 随机目录。

| 范围 | 实际检查 |
| --- | --- |
| 原生成员与兼容 | 全部 native archives（含未分组）直接出现；观察 UUID 重开稳定；旧 wasArchived 对象的新取消归档确实移除 native mark；旧 v1 回执可查，未知旧 execute 不能开始 native 变更；跨协议 operationId 拒绝。 |
| 启动与删除边界 | 旧 intent/applied 的 metadata-only 对账不改 native archive，不补生命周期见证；default native purge unsupported；已保存 owner pending guard 重开后阻止新版 unarchive，不推进资源清除。 |
| 动态成员与 admission | 已观察 ABA 更换 UUID，旧计划冲突；慢 put 中新归档、当前取消和 ABA 均收敛到完整当前集合；intent 后身份、存在性、pending purge 变化再次复核，原生调用数为 0。 |
| 原生发布顺序 | 锁定 SDK domain 已提交帧早于 Registry 内存投影，native port 只读公开 global snapshot；missing archive member 可见但不能以幂等 unarchive 当存在证明。missing 样本只在临时 native domain 中故意构造，不操作用户数据。 |
| 未知 I/O | native/applied acknowledgement 丢失暂停请求；新旧 core 对外部同业务错误类及 undefined/null/false/0 的 committed intent rejection 都暂停；真实 backend 已提交旧失效记录后抛错，生产 Archive 也暂停，重开保守修复。 |
| 生命周期与真实死亡 | 第三个 archive domain 打开失败/等待取消释放旧两 domain 与 lease；新版 unarchive 在 intent/native/applied/entry/done 各 SIGKILL，重开只补元数据，旧计划只返回历史回执；日志和工作区位置保持。 |

独立只读审阅发现并复审了未知错误类豁免及 falsy 健康位两个暂停缺口；运行回归覆盖这些窗口。第一次全量尝试发现原生帧/Registry 投影时序差异并在等待中的慢 put 测试处被主动取消，取消运行不算验收通过；修复后上述 31 项定向全部通过。

即时归档帧捕获中的外部 entries/operations 同步读取失败也进入独立 failed 保护，不能绕过队列暂停或中断新版帧的即时捕获；最终两项补充回归已计入上述 161 项。

[最终 tarball 报告](../../.local/lifecycle/package-aUVuyj/verification.json)、[中文 GUI 报告](../../.local/gui/client-zh-LN3ZAO/verification.json)与[English GUI 报告](../../.local/gui/client-en-1wqHFE/verification.json)的 tarball SHA-256 同为 `dc7e1a5970634ba941edb04acd9c25444b1a09c1cbea38cfd3684bdc10bd4cee`。两个独立 profile 各 14 检查/15 覆盖项通过，console/pageErrors 为空。测试端口 `49866/49979` 仅属于脚本临时宿主，均已关闭；未连接当前 `19387` GUI，未改真实用户会话。

本轮不扩大原生永久删除资格。旧 Bin core 保留为兼容与 test-only owner 回归，默认生产不提供新的 bin/restore 或 native purge；归档观察不是 exact lifecycle 或删除授权。原生取消归档排队不提供代际/CAS，插件最后复核与宿主实际提交不原子，未观察 ABA 和单 Host 部署限制继续适用。

## 环境与命令

Node 24.18.1、pnpm 11.7.0、GitHub CLI 2.102.0 由 [mise.toml](../../mise.toml) 固定。构建依赖锁定 TypeScript 5.9.3、esbuild 0.25.10；运行依赖与 [package.json](../../package.json) 和 [pnpm-lock.yaml](../../pnpm-lock.yaml) 一致。

本轮依赖安装及一次 `pnpm install --frozen-lockfile --ignore-scripts` 均通过，未执行安装生命周期脚本。检查使用公共 npm SDK exports，不导入本地研究快照。通过 `mise run verify` 可按顺序复现类型检查、构建、全部行为测试与 tarball 验证。

## 实际检查

| 检查 | 执行内容 | 结果与证据范围 |
| --- | --- | --- |
| 类型与构建 | 严格 TypeScript 检查、声明构建、esbuild ESM 预编译 | 通过；Cordis 和官方 SDK 保持外部依赖，产物无 Client 声明。 |
| JSONL 往返 | 普通与 Zstandard 两种真实 JSONL 编码，移入、恢复、完整重开 | 通过；日志内容保持一致，工作区成员与顺序保留，冷检查不激活 Session；原生归档清除置顶，恢复不重新置顶。 |
| 所有权 | 普通原生归档、本插件条目、移入前已归档、未分组会话 | 通过；普通归档不进入目录，原先已归档对象恢复后仍归档；未分组条目无工作区身份。 |
| 活动与存在性 | turn、subagent、job、schedule 及组合；准备后活动变化、原生最终活动检查；缺失会话 | 通过；真实 Cordis waterfall 上 fixture 提供活动，执行拒绝且不发停止请求；缺失会话不因幂等原生行为获得条目。 |
| 幂等与并发 | 同一计划 12 次并发、两个不同计划竞争同一会话、旧移入回执在恢复和重开后重复、身份绑定不匹配 | 通过；历史结果不重放原生操作，不重复创建条目；不同参数使用同一身份被拒绝。 |
| 真实进程终止 | 移入与恢复各在 intent、原生变更、applied、条目变更和 done 的持久化事件处 SIGKILL | 10 个边界全部通过；未确认 intent 返回中断冲突，applied 后仅补元数据；重开日志与工作区相符，同一计划重复返回保存结果。 |
| 调用方校验与快照 | 无效条目、入队后修改写入对象、修改返回对象、无效计划 | 通过；无效写入和计划被拒绝，对象修改不改变已提交状态。 |
| I/O 失败 | 原生归档完成后注入确认失败 | 通过；Module 暂停后续写入，重开以日志保守对账，不把未知完成状态当作成功。 |
| 已观察外部变化 | 取消归档再归档，两个帧早于队列对账；完整重开 | 通过；所有权退出并持久化失效，后续原生归档不使旧条目重新出现。 |
| 失效清理故障 | putEntry 等待期间外部取消后再归档；冲突回执落盘后 deleteEntry 故障 | 通过；失效条目故意残留，完整重开按日志清理，并保留后来的原生归档。 |
| 活动检查等待竞态 | 已归档对象 intent 后 activity 暂缓，期间取消归档或取消后再归档 | 两个场景通过；插件原生 archive 调用次数为 0，不覆盖已观察的外部变化。 |
| 卸载与 lease | 在途原生调用、在途 putEntry、卸载期间外部变化、另一个持锁进程死亡 | 通过；新请求拒绝，在途操作完成 drain 后才释放，外部变化仍捕获；第二进程无法争用，持有者死亡后可接手。 |
| 初始化取消 | 真实 Cordis 在继承 Service.init 的第一个异步文件操作期间取消；锁文件已创建 | 通过；实际初始化报 INACTIVE_EFFECT，服务移除，lease 立即可重新取得；未添加生产测试钩子。 |
| tarball 与 Loader | 离线 npm pack、解包、exports 解析、insert patch、真实 Cordis Loader 加载、移入、卸载、再加载、恢复 | 通过；仅白名单发布内容，共享锁定 SDK，domain 及 lease 在卸载后释放；不等于完整 profile/CLI 安装。 |

两个测试文件共 **17 项测试全部通过**，其中真实进程终止的两项分别包含 5 个持久化边界。测试源为 [生命周期测试](../../tests/lifecycle.test.mjs)及[竞态回归](../../tests/recovery-races.test.mjs)，隔离宿主使用真实 JSONL、WorkspaceRegistry 与 domain Implementation，故障只注入在存储或原生边界。tarball 验证脚本为[打包检查](../../scripts/verify-package.mjs)。

## 产物与限制

测试数据、两个编码的临时会话、故障样本及 tarball 保留在忽略的 `.local/lifecycle/` 随机目录。打包检查打印 tarball、SHA-256、文件白名单和 SDK 版本，并保存 `verification.json`。测试没有连接当前 Web GUI，没有读写真实用户会话，也没有实现或执行永久删除。

本轮覆盖的是 macOS ARM64 与固定公开 SDK。活动提供方为 fixture，没有启动真实 Agent turns、subagents、jobs 或 schedules；运行保护依赖原生 waterfall 的已验证拒绝行为。Linux 未执行本地验证，Windows 的 lease 能力会拒绝加载。支持部署仍为一个 Host 拥有原生 Workspace 存储；协作插件 lease 不协调其他 Host 的原生写入。未观察或尚未持久化的取消归档再归档无法恢复精确归属，详见[Host 生命周期](../host-lifecycle.md)。

该 Host 验证未覆盖完整 DSH profile/CLI 安装、真实浏览器渲染、浅深色、键盘、中文输入法和窄屏。对应客户端及 Remote 的运行证据见[客户端验证](client-interface.md)，不扩大本报告的 fixture 范围。[CI 配置](../../.github/workflows/host-lifecycle.yml)和[首轮兼容性探针](dsh-0.2-compatibility.md)分别记录相关流程与独立证据。

## 永久删除资源准入探针

日期：2026-10-07。基线：干净本地 `docs/permanent-deletion-scope` / `c2f62b612c6b2a0d39943fff1ad8f70b19a7ca09`，加下列新增探针与本文、研究、设计、README 的工作区变更。生产 Host/Client/Remote 实现未改变。这里用源码 SHA-256 标识尚未提交的实验材料，不把历史 `a151d56`/`667ff68`/`78cd924` 写成新增探针基线。

| 实验材料 | SHA-256 |
| --- | --- |
| [准入测试](../../tests/deletion-admission.test.mjs) | `907307a173514a13c48fd63038b6e1563b3ce6a70b884995b77f91f417058df1` |
| [独立 writer 进程](../../tests/helpers/persistence-worker.mjs) | `43a55527dd2ebc72b73629ffcaac65cb490fe6714ffb3d5468dd6aaa5a81c0f7` |

测试复用[隔离 fixture](../../tests/helpers/fixture.mjs)：真实公开 npm SessionStore、JSONL、WorkspaceRegistry、JSON storage/domain，以及单项移入路径；writer worker 只挂载 SessionStore/JSONL。所有根目录经过规范化及工作区边界核对，显式 DSH_HOME 位于忽略的 `.local/lifecycle/` 随机目录。共享附件检查通过锁定 CLI/base 的公开包解析挂载真实 LocalAttachmentStore。没有运行参考插件，没有连接 `19387` GUI，没有删除会话目录、锁文件、共享附件或私有索引。

| 检查 | 项数 | 实际结果与限制 |
| --- | --- | --- |
| flush、writer 与稳定锁身份 | 2 | none/zstd：flush 后独立 Node 进程仍被 writer lock 拒绝；close 后可取得 writer；关闭及再次获取后 device/inode、log revision 保持。reader 仍能读取。没有 unlink 锁。 |
| detach、关闭与异步观察者 | 2 | none/zstd：通过调用方拥有的公开 `handle.close()` 注入延迟，并注册等待 gate 的 disposal 观察者；detach 返回时两者未完成。writer 释放后观察者仍可能等待、reader 仍可用。不代表实际 AgentLoop composite teardown 一定按此顺序。 |
| 已归档对象写入 | 1 | 经本插件移入的 quiet 会话，活动 fixture 返回空；公开 persistence writer 仍可追加/flush 新 turn，Bin 条目和原生归档保持。未启动真实 Agent 或 worker activity。 |
| 精确 live 身份 | 1 | 相同 ID/createdAt/cwd 的两个 Session 对象具有相同 header；旧 detach 不移除后来的对象。仅检查内存对象生命周期，没有替换持久化日志。 |
| 未 materialize 对象和 provider identity | 1 | create 只在本实例可见，另一个 Context 观察不到；flush 后可见；重开 persistence 使用不同 identity symbol。两实例观察检查不声明多 Host Workspace 并发支持。 |
| 历史代际 | 2 | none/zstd：正确 framing 的 V3 物理 fixture 被读为当前 V4，read 不发布 successor，write 发布 V4 并保留 V3 字节；原 reader 仍可读。覆盖两个 turn 事件，不覆盖所有历史 codec/lineage。 |
| 不可读 header 与“缺失” | 2 | raw 与有效单 header Zstandard frame 内的 invalid JSON，被 stat/list 遗漏但 bytes 存在。不是缺失证书，也没有执行清理。 |
| 共享附件 | 1 | 相同 bytes、不同 name 的两个 saveFile 引用共享 ID/device/inode，至少三个 hard link，包括 canonical object；两个引用可读取。没有实际 session 引用计数、GC 或删除验收。 |

新增 **12 项通过**。完整 `mise run verify` 也通过：两端严格类型检查、声明/预编译构建、既有 38 项回归加新增 12 项，合计 **50/50**，以及 tarball/真实 Cordis Loader 的激活、移入、卸载、重载与恢复。退出码为 0。未改交互，本轮未重跑 `verify:gui`；中文/English 浏览器证据仍限[原客户端验收基线](client-interface.md#验证基线)。

本次全量运行的历史 fixture：[raw V3/V4](../../.local/lifecycle/deletion-generation-pjcMbZ/)、[Zstandard V3/V4](../../.local/lifecycle/deletion-generation-gVouEn/)；不可读样本：[raw](../../.local/lifecycle/deletion-unreadable-JcEspo/)、[Zstandard](../../.local/lifecycle/deletion-unreadable-WKF2Bo/)；[共享附件样本](../../.local/lifecycle/deletion-shared-file-rjhtji/)。[tarball 检查报告](../../.local/lifecycle/package-BbQqg7/verification.json)对应[本次 tarball](../../.local/lifecycle/package-BbQqg7/dsh-session-bin-0.1.0-dev.0.tgz)，SHA-256 为 `6045bd415aa3d9d47f6e7a8a11988be7c62cb76ae29e139479035a04b5695667`。这些都是本地测试产物，不是公开分发。

复现使用现有固定工具与验证任务，无新增命令或版本来源；若锁定依赖缺失先运行 `mise run install`。在本仓库根目录执行：

```bash
export MISE_DATA_DIR="$PWD/.local/mise-data"
export MISE_STATE_DIR="$PWD/.local/mise-state"
export MISE_CACHE_DIR="$PWD/.local/mise-cache"
export MISE_TRUSTED_CONFIG_PATHS="$PWD"
mise run verify
```

实际使用 Node `24.18.1`、pnpm `11.7.0`、DSH `0.2.0-rc.2`，平台为 macOS ARM64。新测试自动进入既有 `tests/*.test.mjs` 任务和 CI 验证范围；scratch 保留供检查。

**准入结论：当前公开接口仍不足，未提供可执行的永久删除。** 本轮独立复现了生命周期前提的缺口，没有验证完整 retirement owner 协议。未覆盖真实 Agent/任务排空、读取引用撤销、shared-reference 回收、index/cache 物理清除或删除过程中 SIGKILL 恢复；既有归档 crash 测试也不能替代它们。候选接口、资源清单与阶段回执在[设计提案](../design-proposal.md#永久删除资源生命周期候选协议)，各 owner 缺口及一手源码在[永久删除研究](../research/permanent-deletion.md#resource-owner-contract-gaps)。支持范围没有扩大，也没有形成宣称该候选已采用的新 ADR。

## Host 单项删除协议消费者验证

日期：2026-10-07。代码基线为 `c2f62b612c6b2a0d39943fff1ad8f70b19a7ca09` 加本节描述的未提交实现与测试；不是历史 Host `a151d56` 的删除验收。十个实现/fixture/测试文件的[源码 SHA-256 清单](../../.local/lifecycle/retirement-evidence-L5eLTA/source.sha256)已经逐项校验，清单本身 SHA-256 为 `e2e1ddc66eb5e1582885e343dcb8defe2416fa61f4c75a0faf69f8077b09fcbc`。核心材料为[严格合约](../../src/operations/retirement.ts)、[owner 协调](../../src/host/retirement.ts)、[sidecar](../../src/host/retirement-store.ts)、[消费者回归](../../tests/retirement.test.mjs)及[双 domain 生命周期](../../tests/retirement-lifecycle.test.mjs)。选定的消费者架构见 [ADR 0003](../decisions/0003-retirement-consumer.md)。

Node `24.18.1`、pnpm `11.7.0`、DSH `0.2.0-rc.2`、Cordis `4.0.4`，平台 macOS ARM64。使用现有固定工具与任务 `mise run verify`、`mise run verify:gui`，环境设置与上一节相同。未复制参考插件代码或运行其测试；所有会话、fault、owner 数据和浏览器 profile 使用 `.local/` 下随机临时目录。

**结果：两端类型检查、构建、90/90 项测试及 tarball 验证通过，退出码 0。** 测试数为既有 38 项、准入 12 项、新增消费者 36 项和双 domain 生命周期 4 项。中文和 English 两个独立真实 CLI/浏览器 profile 也全部通过，console/pageErrors 均为空。没有连接当前 `19387` GUI。

| 验证 | 实际证据 |
| --- | --- |
| 默认及旧数据 | 默认 Service 返回可查询的不支持拒绝；普通 native archive 不是目标，legacy 条目不按当前 ID 补绑定，旧归档 domain/DTO/恢复保持。owner 自报能力没有 Host composition 资格也不能启用。 |
| 单项资源闭环 | 真实 test-only domain 保存两代 transcript、Workspace/index/cache/spill 资源、共享引用和独立 fork lifecycle；对冻结清单执行实际记录清除与目标引用释放，保留共享 bytes/见证及协调身份。native JSONL、Workspace、缓存快照前后相同。 |
| 身份、范围和活动 | 同请求并发、跨动作 operationId、旧回执与新 entry/lifecycle；准备后资源 revision/content drift、活动、已观察 ABA 和授权等待中的外部失效均拒绝，停止请求为 0。 |
| 完整回执 | 错 op/entry/store/manifest/nonce、缺少 nonce/资源、done 含 failed、保留原因不符、绕过 callback，以及 phase/已确认资源倒退都不能提交成功或解除 guard。 |
| 授权能力生命周期 | authorizing 写后失效，再伪造/缺少 handoff nonce，执行和重开都拒绝。重复 callback、owner settle 后保留 callback、未等待的在途 callback，验证一次性/撤销/join 和 lease 排空。 |
| pending/partial 与未知结果 | entry 和 restore guard 跨重开保持；owner 缺席、先观察 admission 再 recover 的未知 acknowledgement、后来 owner null/refusal均不解除保护。owner/sidecar 将未知 I/O 包装为 SessionBinError 也暂停整个 Module。普通 prepare/list/receipt read 不调用 recover 清除资源。 |
| 快照与完成提交 | 调用方及返回对象突变不改变持久化请求；owner done acknowledgement 丢失后先确认回执，只补 exact entry 元数据，不重复清除；旧回执不触碰后来同名条目。 |
| 实际 SIGKILL | 7 个边界：plugin intent、authorizing、owner fenced、resource effect、owner done、plugin entry 删除、plugin done。重开核对三个 journal/domain、原生快照、清单资源、共享引用和相同操作回执。 |
| 双 domain / lease | 第二 journal 打开失败、第二 open 等待时取消、真实 backend unit close acknowledgement 失败、schema-valid ownership 关联错误；分别验证 domain 清理、写入拒绝、初始化/队列排空和 lease 接手。关闭确认失败的旧 Context 不继续复用。 |
| 独立审阅 | 独立只读审阅发现并复审了 5 项修复：stamp/handoff、callback 迟到写入、业务错误类绕过未知 I/O、关闭失败的 lease 清理、fixture 构造异常清理。最终静态复审在这些限定范围内未发现剩余 actual bug；运行结果来自上述真实测试，不将静态审阅当运行验收。 |

本次全量资源样本：[完整闭环](../../.local/lifecycle/purge-complete-dABGC0/)；SIGKILL 样本：[intent](../../.local/lifecycle/purge-crash-plugin-intent-SwtCpu/)、[authorizing](../../.local/lifecycle/purge-crash-plugin-authorizing-JYv0UU/)、[fenced](../../.local/lifecycle/purge-crash-owner-fenced-2vLw6S/)、[resource effect](../../.local/lifecycle/purge-crash-resource-effect-JfhwE6/)、[owner done](../../.local/lifecycle/purge-crash-owner-done-9gl9MH/)、[entry](../../.local/lifecycle/purge-crash-plugin-entry-e3Olig/)、[Host done](../../.local/lifecycle/purge-crash-plugin-done-xbTGGi/)。数据均保留在忽略目录供复核。

[Host tarball 报告](../../.local/lifecycle/package-alE3Rq/verification.json)、[中文 GUI 报告](../../.local/gui/client-zh-GA2y5b/verification.json)与[English GUI 报告](../../.local/gui/client-en-RRLeCz/verification.json)使用同一 tarball SHA-256：`d1680640ad92c36396b271b24c5a5cde0acb7b13221b7c7e05ec86dde8a02beb`。Chrome `154.0.8037.98` 每个 profile 18 项检查、27 个覆盖项；脚本测试端口分别为 `62576` 和 `62694`，测试 Host 已由脚本关闭。安装、移入/Undo、单项及固定选择批量恢复、双语切换、浅深色、390px 窄屏、重载、SDK 重开和卸载后新启动均通过。这是原有交互的兼容性复验，没有删除确认界面或删除 Remote 的验收。

**范围限制：通过的是 Host 协议消费者与闭世界参考 owner，默认 native 永久删除仍不支持。** 参考 owner 的对象只在测试 domain 内；测试 V3/V4 是它拥有的资源记录，不是本轮擦除 SDK JSONL 文件。没有证明真实 Agent/worker、writer/retained reader 的联合 retirement、native 索引/缓存物理清除、shared attachment GC 或其他 provider 的准入。GUI 使用默认无 owner 组合，仅验证既有功能；中文 synthetic composition 仍不等于真实操作系统输入法。单 Host、相同协调目录、未观察归档 ABA 和平台限制不变，公开发布、删除批量/清空与删除 UI 均未完成。

## 可复用资源 owner 协调验证

日期：2026-10-07。上一节消费者及研究材料已由本地检查点 `8f0dc3d8d57564dca9da218fc0d114b7402fe1fc` 捕获。本节基线为该提交加可复用 owner 的未提交工作区实现、端口适配和测试；没有将上一节 90 项结果当成本节验收。九个变更实现/测试文件的[源码指纹](../../.local/lifecycle/owner-evidence-KGPxKz/source.sha256)已逐项校验，清单 SHA-256 为 `86e5d229930ebdfdbfff49082c3838753c98a0099b161219e02f3c24f8870be9`；[协调器](../../src/host/retirement-owner.ts)自身 SHA-256 为 `e5cc8b7c5ce0a388a9d765e649f4951ea671e44ba933ab407d7f309fd7774a58`。选定机制见 [ADR 0004](../decisions/0004-retirement-owner-coordination.md)。

`mise run verify` 的两端检查、构建、**123/123 项测试**和真实 Loader/tarball 检查均通过，退出码 0：原有 90 项加[owner 直接测试](../../tests/retirement-owner.test.mjs)33 项。原消费者 36 项已改接生产协调器，参考 helper 只提供独立测试资源端口，没有手写 phase 推进。数据 domain 与 owner journal 分开，四个 domain 在同一原有 lease 下打开和关闭。环境仍为 macOS ARM64、Node `24.18.1`、pnpm `11.7.0`、SDK `0.2.0-rc.2`。

| owner 验收层次 | 实际检查 |
| --- | --- |
| 原子阶段与参与者 | 三个参与者覆盖日志、派生记录和共享资源；先持久化 owner fence，再逐个 fence/排空，scope 与全部参与者确认前资源效果数为 0。逐资源、各参与者收敛及 lifecycle finalize 都确认后才 done。 |
| 生命周期与 scope | 正常 scope 排他地阻止新代际和新写入，missing/replacement/活动/缺少完整冻结清单在 grant 前拒绝；已保存操作的维护 scope 可从部分清除或已 finalize 状态继续，不 create/resume 旧 Session。 |
| 实际排空与漂移 | 等待真实 fixture retained-use Promise，既有排空写入发布新 revision 后保持 quiesced fence 和明确阻止原因，不扩大旧确认范围或继续擦除。已知 pending barrier 可重开后续办。 |
| 逐资源及旧引用 | 错 owner/resource/disposition 回执不能确认或释放 fence；历史回执不重放，完成后的旧 cache/writer 引用及旧 exact token 拒绝，新 token 可创建。共享引用、独立生命周期和协调记录保留。 |
| medium/memory 不一致 | 在公开 JSON backend `putRecord` 已真实提交、Domain 尚未更新 memory 前注入失败；确认 medium 有 fenced record 而内存没有。scope release 等待期间所有 guard 仍立即拒绝，不依赖旧 memory。owner/resource acknowledgement 丢失须新实例重开。 |
| 并发健康与预算 | 并行 inspect I/O 失败或等待期间参与者 version 漂移，当前动作可 settle，但不能写其 ack 或执行下一动作；scope/participant quiesce、converge 各确认后的预算暂停不越界。falsy store/budget rejection 也暂停。 |
| ownership 与关闭 | 新取得 scope/disposer 后才发现版本变化，仍执行 release/teardown；独立慢 inspect 被 close join；已入队 prepare/retire 和私有授权观察可 drain，外部 closing 请求及普通 routes 继续拒绝；初始化取消禁用 guard routes。 |
| journal 信任边界 | 拒绝不可能的排空确认顺序、参与者集合/版本不匹配、终态回执改写和确认回退；保存 state 与进度为一个原子 record。initialize 只校验/绑定，不自动 erase。 |
| 真实进程终止 | [owner worker](../../tests/helpers/retirement-owner-worker.mjs)在 19 个 owner/参与者/生命周期确认处 SIGKILL，重开核对原请求、清单、资源、共享引用、tombstone 和 native 快照；消费者原有 7 个 SIGKILL 边界也在同次全量通过。 |

19 个边界为：owner fenced；三个 participant fenced；lifecycle quiesced；三个 participant quiesced；owner quiesced/erasing；resource effect/receipt；owner converging；三个 participant converged；lifecycle finalize effect/finalized；owner done。代表样本：[完整 owner](../../.local/lifecycle/owner-complete-fmaex0/)、[首次 fence](../../.local/lifecycle/owner-crash-GlgU2i/)、[资源 effect](../../.local/lifecycle/owner-crash-zLAhkj/)、[finalize effect](../../.local/lifecycle/owner-crash-56bAEW/)、[owner done](../../.local/lifecycle/owner-crash-MIWcoP/)。原生 transcript/accounting 前后及重开后保持一致。

独立静态审阅发现并复审了未知失败的释放窗口、并行 control-plane/版本失败后的继续推进、独立观察关闭排空、预算漏检查、falsy 暂停、schema 顺序、返回 ownership 接管和内部 close-drain 共八类修复。运行故障回归覆盖这些具体窗口；静态复审结论仅限被检查代码，不替代 native 资格。直接套件单次曾因测试 helper 的关闭微任务时序失败，该测试改为直接调用生产 Core.close 后，定向及本次统一 33/33 均通过；没有把拆分通过当作本次完整结果。

[Host tarball 报告](../../.local/lifecycle/package-Ejrbkw/verification.json)、[中文 GUI 报告](../../.local/gui/client-zh-WaxHrq/verification.json)与[English GUI 报告](../../.local/gui/client-en-dbREN7/verification.json)的 tarball SHA-256 同为 `68efcf15e636f126bbd99d87d5c3433633f0aa55ad9428c4f9e0d86675f6fdd7`。`mise run verify:gui` 两个独立 profile 各 18 检查/27 覆盖项通过，console/pageErrors 为空。测试端口为 `64909/65062`，由脚本启动并关闭，不连接 `19387`。

**本节证明的是可复用协调器与 fixture 端口的实际持久化协议，不是 native 资源删除。** normal/read/write/retained-use 与 fake V3/V4 资源都归测试端口所有；真实 JSONL writer lease、Agent/reader 异步屏障、native 缓存/索引防复活、shared attachment GC 和发布资格仍未证明。维护 scope 在新进程必须重建真实 runtime 排他权，过去的 quiesce ack 本身不是当前 lease。默认 native 仍无 owner，Remote/UI、批量 purge、清空未开放，现有部署与未观察归档 ABA 边界保持。
