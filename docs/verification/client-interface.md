# 客户端切片验证

本文按代码基线记录客户端与真实 CLI/GUI 的运行证据。当前 dev.2 单项删除、固定批量、清空及恢复边界见下一节；较早 dev.0/dev.1 章节保留其原有范围。实现状态见 [README](../../README.md)。

## 跨平台生产删除客户端验证

日期：2026-10-09。实现基线 `978a6d016fdedf185f9105d17331ebc4bcc04886` 的 [PR CI run 37909476064](https://github.com/takboo/dsh-session-bin/actions/runs/37909476064) 和同提交 [push CI run 37909471038](https://github.com/takboo/dsh-session-bin/actions/runs/37909471038) 均在 Windows x64、macOS ARM64、macOS Intel x64、Linux ARM64 与 Linux x64 上通过，共 **10/10 平台任务成功**。固定环境为 Node `24.18.1`、libuv `1.52.1`、SDK `0.2.0-rc.2`；文件系统及源码摘要见[同轮 Host 证据](host-lifecycle.md#跨平台生产删除资格晋级验证)。本节是当前客户端发布矩阵；后续历史章节中 macOS-only 或其他平台 unsupported 的描述不适用于此基线。

每个平台都运行中文与 English 的完整 `verify:gui`。由于该组合已通过生产资格门，浏览器流程实际执行严格不可逆确认后的单项删除、固定选择批量删除及不受搜索筛选影响的清空全部归档，并在真正 Host 关闭、SDK 重开后确认目标日志和派生记录仍缺失；取消、未勾选及陈旧 baseline 路径保持零执行。公共 CLI 的全新 profile 安装、卸载和卸载后 Web 重启也在同一任务内通过。测试不以 unsupported 分支、历史 tarball、模拟删除或强制终止进程代替生产路径。

客户端恢复与一致性回归同时覆盖逐项结果、部分失败、断线、查询恢复、通知重入和 missing 项重新准备/重新确认；批量仍是固定集合的串行单项操作，不宣称跨会话事务。支持边界与 Host 相同：不含 Windows ARM64、其他文件系统、多 Host、共享附件 GC、安全擦除或真实物理 OS 输入法保证。下方各节保留其原代码基线与限制，作为历史证据而非当前支持状态。

## Linux 云环境 CLI 与双语 GUI 复验

日期：2026-10-09。基线及工具修复见[Host 同轮验证](host-lifecycle.md#跨平台-ci-与-pnpm-退出修复验证)。Linux x64、Node `24.18.1`、pnpm `11.23.0`、DSH `0.2.0-rc.2`；`mise run verify:gui` 完整退出 **0**。[中文报告](../../.local/gui/client-zh-F4JozK/verification.json)和[English 报告](../../.local/gui/client-en-EmERFo/verification.json)各 **17 检查通过**，browser console/pageErrors 为空；四次 Host 关闭均 code 0、signal null、未强制终止。

对基线 `321dc2bd87b00d0154193210f6e55a34e74224eb` 的远程复验发现另一项 Linux runner 限制：工作区内 TMPDIR 太长，Chromium singleton socket 启动失败。隔离长路径探针在实际 Chromium 中复现 `Socket path too long`，使用独立 `/tmp` 短目录后启动与导航成功。修复后再次执行完整双语任务，[中文](../../.local/gui/client-zh-Hhjx2k/verification.json)及[English](../../.local/gui/client-en-T8y9j5/verification.json)仍各 17 项通过、错误为空、Host 均正常关闭；两份报告记录的浏览器短临时目录已在结束时删除。profile、SDK 数据及证据仍使用原有隔离工作区。

全新 profile 使用缓存优先的在线安装补齐独立解析的依赖；公开 CLI 安装、卸载及卸载后的新浏览器数据目录/真正 Web 启动均成功。验证覆盖原生 Archive/Undo、已有归档、单项及批量取消归档、筛选、语言与偏好重载、浅深色和窄屏。Linux 生产删除资格仍为 unsupported：单项、批量、清空确认拒绝并执行零次，SDK 重开后原始 transcript 字节保留。此结果解决此前 Linux CLI/GUI 安装与退出失败，不代表 Linux 删除已获生产资格，也不替代物理操作系统输入法验收。较早 macOS 删除验收与失败诊断保留各自基线。

## dev.2 单项、固定批量、清空与恢复验证

日期：2026-10-09。基线为 `e26e0dbeea2caf7cd6db3021cfbcd85b15c968ec` 加真实删除、跨平台候选、严格 Remote、批次编排及客户端边界修复的工作区变更。两端相同 90 文件清单和摘要 `fe69a7490825cd975f56a8002c47d2812eede583a3dc8f643b345d5cba47ba64` 见[Host 当前验收](host-lifecycle.md#dev2-真实冷-jsonl-删除与固定批次验证)。正式交互见[客户端接口](../client-interface.md)，选定编排见 [ADR 0009](../decisions/0009-fixed-purge-batches.md)。

| 层次 | 实际结果 |
| --- | --- |
| 类型、构建与 Host | 两端检查、构建、macOS 全量 342 项通过/6 项 Windows 专属跳过、Linux candidate 341 项通过/7 项跳过及两端真实 Loader/tarball 检查均退出 0；范围和跳过项见 Host 报告。 |
| 模型、DOM 与严格 Remote | [批次模型](../../tests/native-deletion-batch.test.mjs)32 项、[批次 DOM](../../tests/native-deletion-batch-ui.test.mjs)5 项、[单项及 Remote](../../tests/native-deletion-client.test.mjs)30 项，共 **67/67 通过，0 跳过**，并进入同轮全量。 |
| 中文实际 CLI/浏览器 | [zh-CN 报告](../../.local/gui/client-zh-NgXPYK/verification.json)：**17 检查/28 覆盖项通过**。 |
| English 实际 CLI/浏览器 | [en-US 报告](../../.local/gui/client-en-XJItAB/verification.json)：**17 检查/28 覆盖项通过**。 |

两个全新独立 profile 由 `mise run verify:gui` 顺序运行，退出码 **0**。环境：SDK `0.2.0-rc.2`、Node `24.18.1`、pnpm `11.7.0`、macOS ARM64、系统 Chrome **155.0.8059.39**。两份 GUI 与[macOS 打包报告](../../.local/lifecycle/package-qCagP3/verification.json)、[Linux 打包报告](../../.local/platform/linux-container-rcnaCX/lifecycle/package-T1O92G/verification.json)使用同字节 `0.1.0-dev.2` 包，SHA-256 为 `9fa5d571d38a9458ac48dbf92250af477b8f1b49bdcecc9fc7484e4523e2ca67`。browser console/pageErrors 均为空；四次 Host 关闭均 code 0、signal null、未强制终止。

真实 GUI 覆盖原生 Archive 唯一入口/Undo、已有归档、单项/批量取消归档、元数据搜索及筛选、语言切换保留草稿与选择、Host 偏好重载、浅深色、390px 窄屏，以及下列真实删除效果：

- 单项冻结请求、默认取消焦点、不可逆勾选及 owner done 完整回执；取消和未勾选执行数为 0。
- 固定两项批量分别准备独立计划，实际执行并发峰值 **1**，owner 成功响应逐项确认；未选中会话在清空前的 transcript SHA-256 不变。
- 搜索隐藏全部行时，清空仍冻结完整归档集合；取消不执行，再次明确确认后才发送。每种语言共实际删除 4 个测试目标：单项 1、批量 2、清空 1。
- 真正 Host 关闭后 SDK 重开确认四个目标的日志物理缺失，原目录和稳定协调身份保留，无关 Workspace 成员保持；公开 CLI 卸载及新的真正 Web 启动撤销贡献。

新增恢复回归覆盖 missing 批次项在停止、关闭和重载后的独立 fresh preparation/confirmation；取消确认仍保留旧 guard，执行新确认才替换，provenance 始终禁止 discard，observed/uncertain grant 与替换观察仍拒绝。断线中的 success/rejected/conflict 当前项完整排空，后续项暂停；新 baseline 先于当前回复到达也不自动恢复。公开订阅通知重入 refresh、stop/dismiss，以及异步 journal 查询跨连接代次后不能发送或重新打开确认。以上故障窗口由实际 Model/Remote/DOM 回归验收，正常真实 GUI 流程不被写成这些故障的网络注入证据。

实际截图：[中文浅色](../../.local/gui/client-zh-NgXPYK/artifacts/session-bin-light-zh.png)、[中文深色](../../.local/gui/client-zh-NgXPYK/artifacts/session-bin-dark-zh.png)、[中文批量确认](../../.local/gui/client-zh-NgXPYK/artifacts/session-bin-batch-delete-confirmation-zh.png)、[中文清空确认](../../.local/gui/client-zh-NgXPYK/artifacts/session-bin-clear-all-confirmation-zh.png)；[English 浅色](../../.local/gui/client-en-XJItAB/artifacts/session-bin-light-en.png)、[English 深色](../../.local/gui/client-en-XJItAB/artifacts/session-bin-dark-en.png)、[English 窄屏](../../.local/gui/client-en-XJItAB/artifacts/session-bin-narrow-en.png)。

Linux CLI 的额外 add/remove 补验没有通过：profile 缓存预热后安装成功，但 Corepack 与同版本原生 pnpm 对照的卸载均未满足自然退出断言。该失败与本节 macOS 双语 GUI 通过分别记录，详见[Host 补验与限制](host-lifecycle.md#linux-cli-补验与未通过边界)；没有据此扩大 Linux 生产资格。

固定交付物为[dev.2 安装包](../../.local/packages/dsh-session-bin-0.1.0-dev.2.tgz)，大小 **501702 bytes**，与上述验收包逐字节一致，附[SHA-256 校验文件](../../.local/packages/dsh-session-bin-0.1.0-dev.2.tgz.sha256)。本轮整理交付物，没有安装到用户正在运行的 Harness。

测试只连接脚本启动的临时端口 `58929/59071`，未连接当前 `19387` GUI或安装到真实用户 profile。合成 composition 不证明物理 OS 输入法会话。默认生产删除仍只限声明的 macOS ARM64 组合；Linux 容器 candidate、Windows 与其他架构的 GUI/实际删除资格保持独立，尚未满足三平台公开发布条件。

## 原生归档管理重构验证

本节针对原生 Archive 唯一入口的重构工作区，区别于下文旧 Bin 历史基线。新协议及旧缓存兼容行为见[客户端接口](../client-interface.md)和 [ADR 0005](../decisions/0005-native-archive-collection.md)。

固定工具环境下两端 `mise run check` 与新版预编译构建通过。定向 Client 检查 **17/17 通过，退出码 0**：模型 11 项、双语文案 5 项、实际 lazy factory 加载 1 项。运行命令为既有 `mise exec -- node --test --test-concurrency=1 tests/client-model.test.mjs tests/client-i18n.test.mjs tests/client-load.test.mjs`，没有新增工具或依赖来源。

| 检查 | 实际证据 |
| --- | --- |
| 原生成员 | 真实 RPC baseline 和 Workspace 原生归档创建列表；无需旧 Bin 置入。 |
| 操作与断线 | 丢失回复后重开只查询，缺少回执时显式同身份 retry；推送早于回复不会重复结算；批次排除后来归档，旧观察身份不能操作新身份。 |
| 旧浏览器缓存 | v1 bin/restore 迁移为 query-only；自动与显式查询都不重发旧变更；合法历史 done 不伪报取消归档，缺少旧回执不阻止明确的新取消归档。损坏项及存储拒绝保持有效身份。 |
| 文案与交互 | 中英文可见及 aria 文案、单复数、pending deletion/legacy reason、语言切换时选择及草稿保留；不显示旧时间/归档标签，不提供重复 Undo；合成 composition/Escape 验证。 |
| 挂载与清理 | 真实 factory 共享 React 和原生图标；仅 main、panellist、overlay 三个贡献，会话菜单贡献为 0；等待/collapse/重建与卸载释放 style、locale、stream。 |

实时 Client Inspect 的 Slots、Theme、Service 查询超时；实现核对的是锁定 SDK 的公开槽位及 locale 声明和主题 token，不能据此声称已验收当前运行中 GUI。定向测试使用隔离 RPC 与 DOM；真实浏览器结果需由 `mise run verify:gui` 单独记录。合成 composition 不证明实际操作系统输入法会话。

## 本次最终 CLI 与浏览器验收

最终源码基线、31 文件指纹和故障检查见[Host 重构验证](host-lifecycle.md#原生归档管理重构验证)。`mise run verify` 的两端类型检查、构建、**161/161 项测试**和 tarball 检查通过。随后对最终构建执行既有 `mise exec -- pnpm run verify:gui`（完整任务 `mise run verify:gui` 另包含构建），中文和 English 各 **14 检查 / 15 覆盖项通过**，退出码 0。

[中文报告](../../.local/gui/client-zh-LN3ZAO/verification.json)、[English 报告](../../.local/gui/client-en-1wqHFE/verification.json)与[Host tarball 报告](../../.local/lifecycle/package-aUVuyj/verification.json)使用相同 tarball SHA-256：`dc7e1a5970634ba941edb04acd9c25444b1a09c1cbea38cfd3684bdc10bd4cee`。SDK `0.2.0-rc.2`、Node `24.18.1`、macOS ARM64、系统 Chrome `154.0.8037.98`；console/pageErrors 均为空。

实际覆盖：插件安装前的原生归档直接显示、菜单无 Move 贡献、原生 Archive 与其唯一 Undo、确认成功的单项取消归档、固定选择批量取消归档、搜索/工作区筛选、composition/Escape/Tab、原生 Settings 语言切换时保留选择及草稿、语言偏好刷新保留、浅深色、390px 控件、原生插件 metadata、SDK 重开时 native archive 与日志一致，以及 CLI 卸载后的真正 Web 重启。两次最终测试 Host 位于 `49866/49979`，均正常退出；未连接当前 `19387` GUI。

真实截图：[中文浅色](../../.local/gui/client-zh-LN3ZAO/artifacts/session-bin-light-zh.png)、[中文深色](../../.local/gui/client-zh-LN3ZAO/artifacts/session-bin-dark-zh.png)、[中文窄屏](../../.local/gui/client-zh-LN3ZAO/artifacts/session-bin-narrow-zh.png)；[English 浅色](../../.local/gui/client-en-1wqHFE/artifacts/session-bin-light-en.png)、[English 深色](../../.local/gui/client-en-1wqHFE/artifacts/session-bin-dark-en.png)、[English 窄屏](../../.local/gui/client-en-1wqHFE/artifacts/session-bin-narrow-en.png)。

初次浏览器运行在空状态文案断言处失败，原因是脚本仍期待旧 Bin 文案；校正独立中英文期望后完整双语流程通过。随后补齐 Host 同步观察读取故障保护，再对最终同一 tarball 完整复验，以上报告只指最终运行。此证据不扩大永久删除、真实 OS 输入法、多 Host 或其他平台支持。

## 本地安装开发包 0.1.0-dev.1

原生归档重构验收后，为区分用户本地的旧包，开发版本递增为 `0.1.0-dev.1`；功能源码与上述最终验收一致，打包脚本的版本校验改为读取项目 manifest，避免另存固定版本。使用固定工具运行 `mise run check` 和 `mise run verify:package`，两端类型检查、重新构建、文件白名单、公开导出与真实 Loader 加载/取消归档/卸载/重载全部通过，退出码 0。

[安装包](../../.local/packages/dsh-session-bin-0.1.0-dev.1.tgz)为本轮[打包报告](../../.local/lifecycle/package-CXjVh4/verification.json)中 tarball 的同字节副本，SHA-256 为 `72d08c9073dfc9a8a71c61e2799452712e0dac73ae40b6b7176ba6cd53251d95`，大小 340629 bytes，附[校验摘要](../../.local/packages/dsh-session-bin-0.1.0-dev.1.tgz.sha256)。本轮只编译和验证交付物，没有安装到用户正在运行的 Harness；前述真实双语 GUI 证据仍对应 `0.1.0-dev.0` 重构验收包。

## 验证基线

代码基线：Host `a151d56`、客户端 `667ff68`、中英补充 `78cd924`。本报告记录这些基线在上述 SDK 和平台上的检查结果，不作为当前开发计划或分支状态说明。实现状态见 [README](../../README.md)。

## 检查结果

两端严格 TypeScript 检查、声明构建和预编译产物构建通过。`pnpm install --frozen-lockfile --ignore-scripts` 可通过 [mise.toml](../../mise.toml) 的 `install` 任务复现，依赖及离线 GUI 缓存保持锁定。

| 层次 | 实际范围 | 结果 |
| --- | --- | --- |
| Host 行为 | [生命周期测试](../../tests/lifecycle.test.mjs)与[恢复竞态](../../tests/recovery-races.test.mjs)，包括两种 JSONL 编码、所有权、活动拒绝、幂等、I/O 暂停、lease 与初始化/卸载；移入和恢复共 10 个真实进程终止边界 | 17 项通过。 |
| 严格 Remote | [Remote 测试](../../tests/remote.test.mjs)，公开手工描述符、真实 JSON RPC 封套/rpcId、exact args、业务拒绝、错误 code、每代 baseline、取消/return/卸载、完整重开与实际插件 fiber 注入 | 9 项通过。 |
| Client 模型 | [模型测试](../../tests/client-model.test.mjs)，真实 RPC 回执、丢失回复、页面重开、显式同身份重试、批量固定对象、旧 Undo、流释放及推送早于回复 | 7 项通过。 |
| 实际 Client 产物 | [加载测试](../../tests/client-load.test.mjs)，完整 lazy factory、公开 ClientModuleSystem/SlotRegistry/LocaleRuntime、共享 React 与官方图标、实际组件执行、等待/collapse/redeclare、namespace/style/locale/stream 清理 | 1 项通过。 |
| 双语文案与状态 | [i18n 测试](../../tests/client-i18n.test.mjs)，当前源组件、实际 React DOM、官方 primitives 与公开 LocaleRuntime；受控 readable 快照覆盖全部可见文案分支、辅助标签、单复数、13 个错误/null/未知 reason 路径、通知和稳定 t 下的切换 | 4 项通过；这是文案状态层，不替代 Host 业务或实际 factory/Chrome。 |
| tarball | [打包检查](../../scripts/verify-package.mjs)，文件白名单、Host/Client/Remote exports、真实 Cordis Loader 挂载、操作、卸载与再加载 | 通过；固定 SDK 依赖来自测试仓库，不将这一层称为干净 CLI/profile 安装。 |
| 真正 CLI/浏览器 | [GUI 脚本](../../scripts/verify-gui.mjs)，公开 CLI 安装 tarball 到新 Web profile，真正 `dsh web`、认证 URL/cookie、实际 injected boot graph、实际交互、SDK 重开及 CLI 卸载后的新启动 | 完整通过，浏览器 error/warning、pageerror 均为空。 |

完整行为与文案测试为 **38 项全部通过**。逻辑载体测试使用真实 Gateway 与 Connection 的已准入 Fetch/stream 边界，不能作为 cookie、Host/Origin 或 WebSocket 网络鉴权的证明；真实浏览器层独立覆盖浏览器准入和实际网络交互。Client 产物测试丢弃平台 seed 的原生 CSS，明确只验证代码、共享身份与生命周期，视觉由 Chrome 层验证。

## 中文与 English 完整适配验证

双语验收针对中文和 English 两个独立 profile 使用精确语言断言，覆盖单项语法、空名工作区语义与插件管理 metadata。`mise run verify:gui` 顺序执行两种语言，不以“中英任一匹配”代替适配验证。

| 覆盖内容 | 中文 | English | 证据层次 |
| --- | --- | --- | --- |
| 菜单、侧栏、标题、描述、搜索 placeholder/aria、工作区选项、列表和复选框标签、选择/清选/批量按钮 | 通过 | 通过 | 真正 Chrome，各自精确文案断言。 |
| 0/1/多个会话数量、1/多个待确认结果、加载/空站/无匹配、未命名会话、未分组和空名已分组工作区 | 通过 | 通过 | Chrome 验证计数/空站/无匹配；受控 React DOM 验证全部状态与 fallback。 |
| 移入、撤销、恢复、恢复后保留原归档通知；当前错误/null/未知 reason、重试、待确认、混合结果与辅助提示 | 通过 | 通过 | Chrome 实际成功/归档通知；文案状态层验证全部错误与提示分支。 |
| 每个 time 文本按所选语言的实际浏览器 Intl 格式计算，同一 binnedAt 切换日期表达 | 通过 | 通过 | 生产 face 与真正 Chrome；不硬编码机器时区。 |
| 原生 Settings 切换 zh→en→zh，更新菜单/侧栏/日期/文案，选择与搜索草稿保留 | 通过 | 通过 | 真正 Settings 操作；中文用户名称及工作区数据保持原值。 |
| Host 语言偏好设为与 navigator 相反，再刷新仍保持 Host 选择 | 通过 | 通过 | zh-CN browser 保持 en；en-US browser 保持 zh-CN。 |
| 插件管理页标题与描述、中英资源导出及 tarball 解析 | 通过 | 通过 | 真正 Plugins 页面 + 公开 readPluginMeta 读取实际打包资源。 |
| 浅色、深色、390×844 窄屏、搜索组合输入、Escape/Tab、完整交互、重载与 CLI 卸载后新启动 | 通过 | 通过 | 两轮完整 Chrome 验收，console/pageErrors 均为空，进程正常关闭。 |

完整报告：[中文 zh-CN](../../.local/gui/client-zh-KqGJxp/verification.json)、[English en-US](../../.local/gui/client-en-Z67Apn/verification.json)。两轮均包含 18 项实际检查和 27 个覆盖项。

实际截图：[中文浅色](../../.local/gui/client-zh-KqGJxp/artifacts/session-bin-light-zh.png)、[中文深色](../../.local/gui/client-zh-KqGJxp/artifacts/session-bin-dark-zh.png)、[中文窄屏](../../.local/gui/client-zh-KqGJxp/artifacts/session-bin-narrow-zh.png)；[English 浅色](../../.local/gui/client-en-Z67Apn/artifacts/session-bin-light-en.png)、[English 深色](../../.local/gui/client-en-Z67Apn/artifacts/session-bin-dark-en.png)、[English 窄屏](../../.local/gui/client-en-Z67Apn/artifacts/session-bin-narrow-en.png)。报告还保存切换语言时的截图与选择/搜索状态。

同一实际日期值在 English 显示如 `Oct 7, 2026, 10:25 AM`，中文显示如 `2026年10月7日 10:25`；断言逐项比较 `Intl.DateTimeFormat(activeLocale, { dateStyle: 'medium', timeStyle: 'short' })`。English 单项现在是 `1 conversation`、`1 operation result needs confirmation.`；空名已分组工作区显示 `Untitled workspace / 未命名工作区`，不会误称为 Ungrouped。

两轮[中文 GUI tarball](../../.local/gui/client-zh-KqGJxp/dsh-session-bin-0.1.0-dev.0.tgz)与[English GUI tarball](../../.local/gui/client-en-Z67Apn/dsh-session-bin-0.1.0-dev.0.tgz)使用相同 SHA-256：`df2531e165f856b4b6e3682462858680ffff4ad793c99a22ff7453604466b496`。本轮之后仅改文档会改变摘要，其他运行以各自报告为准。

这个矩阵证明当前支持的中文/English 产品界面与元数据完整适配，不把未使用的字典键或未实现的功能虚构为额外能力，也不扩展到第三种语言、RTL、其他平台或实际操作系统输入法会话。

## 集成回归与测试差异

1. 真正插件读取 `ctx.remote.sessionBin` 必须声明独立的 dotted namespace 依赖。根 Context 会绕过这个 guard；产品先挂载贡献再创建动态消费者，新增实际插件回归验证 guard、调用和父卸载。
2. esbuild 浏览器构建必须显式使用自动 JSX runtime，并指定客户端 tsconfig。原先 classic JSX 会生成未绑定 React 标识符。现在复用平台 JSX runtime；产物回归实际执行图标，且不提供全局 React。
3. 测试 RpcStreamOpen 必须立即返回 AsyncIterable，公开 Gateway wireStream.open 返回 Promise<AsyncIterable>。载体改为 async generator 先等待再迭代，产品业务不因测试而改写。
4. 冷 Session 摘要依赖持久化 projection cache。真实 fixture 通过公开 SessionProjectionRegistry、titleProjectionDefinition 与 SessionProjectionCache 建立冷标题并排空；产品仍只读原生摘要，不主动读取日志或激活 Agent。
5. 目录推送可能早于执行回复。已在执行中的请求不会被自动回执查询提前结算，避免重复成功通知或提前开放不可用 Undo；断线后的未知请求仍可查询。
6. pnpm 11 的 `remove` 不接受 `--ignore-scripts`。GUI 自动化通过 `PNPM_CONFIG_IGNORE_SCRIPTS=true` 和非交互 CI 环境控制子进程；两个独立 profile 的安装/卸载真实返回 0，依赖与 bundle 选择清除。该结果限定于所记录的运行条件，不推断其他环境的退出行为。

## 复现与边界

`mise run install` 准备锁定依赖及项目离线缓存；`mise run verify` 执行两端静态/构建/38 项行为与文案回归及 tarball 检查；`mise run verify:gui` 顺序执行中文和 English 的真实 CLI/Chromium 验收。单语诊断用 `DSH_GUI_LOCALE=zh-CN` 或 `en-US` 与 `mise run verify:gui:locale`。工具、依赖和命令的来源分别为 [mise.toml](../../mise.toml)、[pnpm-lock.yaml](../../pnpm-lock.yaml)及 [package.json](../../package.json)。

脚本仅在忽略的 `.local/gui/` 随机目录建立 DSH_HOME、Workspace、profile、缓存、浏览器数据、测试日志、projection、截图和报告。每次真实 Host 退出后才重开 SDK 检查；停止的进程组全部属于脚本。认证 token、cookie 和凭据不进入公开报告，未连接当前 19387 GUI。

验证只证明上述精确平台和版本。单 Host、POSIX lease 与未观察归档变化的归属限制继续遵循[Host 契约](../host-lifecycle.md)；Windows、Linux 和多 Host 原生存储协调未扩大支持。浏览器文本输入和合成 composition 事件不等于真实操作系统中文输入法会话；中文和 English 已按上述分层矩阵实际验证。尚无公开发布、市场提交或 GitHub CI 远程运行记录，也不提供永久删除、日志预览或自动清空。

## Host 删除消费者后的兼容性复验

日期：2026-10-07。本节基线为 `c2f62b6` 加 Host 删除消费者及测试的未提交工作区变更；与上面的 `a151d56/667ff68/78cd924` 历史验收分开。精确实现/测试 SHA-256 清单、独立审阅、40 项新增故障检查及范围见[Host 验证](host-lifecycle.md#host-单项删除协议消费者验证)。当前客户端源码、原严格 Remote v1 DTO 和菜单/面板行为未扩展删除。

`mise run verify` 的两端检查、构建、**90/90 项测试**与真实 Loader/tarball 验证通过。`mise run verify:gui` 随后用默认无 owner 的 Service 组合，在两个全新临时 Web/Chrome profile 顺序验证中文和 English：每轮 18 项检查和 27 个覆盖项均通过，browser console/pageErrors 为空。

实际报告：[中文](../../.local/gui/client-zh-GA2y5b/verification.json)、[English](../../.local/gui/client-en-RRLeCz/verification.json)。实际截图：[中文浅色](../../.local/gui/client-zh-GA2y5b/artifacts/session-bin-light-zh.png)、[中文深色](../../.local/gui/client-zh-GA2y5b/artifacts/session-bin-dark-zh.png)、[中文窄屏](../../.local/gui/client-zh-GA2y5b/artifacts/session-bin-narrow-zh.png)；[English 浅色](../../.local/gui/client-en-RRLeCz/artifacts/session-bin-light-en.png)、[English 深色](../../.local/gui/client-en-RRLeCz/artifacts/session-bin-dark-en.png)、[English 窄屏](../../.local/gui/client-en-RRLeCz/artifacts/session-bin-narrow-en.png)。两轮与 Host tarball 的 SHA-256 相同：`d1680640ad92c36396b271b24c5a5cde0acb7b13221b7c7e05ec86dde8a02beb`。

复验涵盖新 sidecar 下的启动/卸载、原生菜单、移入/Undo、单项与固定选择批量恢复、搜索/工作区筛选、真实 Settings 语言切换、日期/metadata、浅深色和 390px 窄屏、重载、SDK 重开及卸载后的新启动。测试端口为 `62576/62694`，仅连接脚本启动的临时 Host，未连接 `19387`，测试进程均由脚本关闭。

这一结果证明新 Host 生命周期切片保持既有客户端兼容，**不证明原生永久删除、删除确认 Modal、批量删除或清空**。它们尚未向 Remote/UI 开放；provider 准入和真实资源 retirement 的限制见 Host 报告。环境仍为 macOS ARM64、Node `24.18.1`、pnpm `11.7.0`、DSH `0.2.0-rc.2`、Chrome `154.0.8037.98`，未扩大平台、原生存储并发或实际操作系统输入法支持。

## 可复用 owner 包的兼容性复验

日期：2026-10-07。基线为检查点 `8f0dc3d` 加 owner 协调器及端口适配的未提交变更，精确源码和 33 项新增 owner 检查见[Host 验证](host-lifecycle.md#可复用资源-owner-协调验证)。`mise run verify` 的两端检查、构建、**123/123** 测试及 tarball 通过；`mise run verify:gui` 的中文和 English 两个独立 profile 各 18 检查/27 覆盖项通过，console/pageErrors 为空。

实际报告：[中文](../../.local/gui/client-zh-WaxHrq/verification.json)、[English](../../.local/gui/client-en-dbREN7/verification.json)。浅深色、窄屏和切换截图位于各自报告的 artifacts；两轮与 Host tarball 的 SHA-256 同为 `68efcf15e636f126bbd99d87d5c3433633f0aa55ad9428c4f9e0d86675f6fdd7`。测试端口 `64909/65062` 仅属脚本临时 Host，均已关闭，未连接 `19387`。

客户端及严格 Remote DTO 未扩展删除。GUI 仍验证默认无 owner 的安装/卸载、既有移入/Undo、恢复、筛选、固定选择批量恢复、语言偏好、浅深色/390px 布局及重开；没有据此声明 native 删除、删除 Modal/批量/清空或其他平台已支持。环境及操作系统输入法限制与前节一致。
