# 客户端与 Remote 接口

本文说明客户端交互、严格 Remote 合约和插件生命周期。实际验证结果见[客户端验证](verification/client-interface.md)，实现状态见 [README](../README.md)。

## 原生归档管理

Harness 原生 Archive 是唯一归档入口。插件不注册会话菜单中的“移入回收站”，也不提供第二个归档 Undo；归档活动保护、停止确认及撤销由宿主原生交互负责。

侧栏入口与根 `main` 槽位共用 `dsh-session-bin.panel` 身份。面板直接展示原生已归档集合，包括插件安装前或由其他原生界面归档的会话。名称来自原生 Session 摘要，工作区按当前 `WorkspaceView.sessionIds` 匹配；不为列表激活或 retain 冷会话，也不读取日志。支持名称及工作区元数据搜索、工作区筛选、单项取消归档和固定选择的批量取消归档。

选中对象使用 Host 的观察 `entryId`。请求再次核对准备结果中的身份，批量在开始时固定对象集合；后来归档的会话不加入。成功项取消选择，失败项保留并显示逐项原因，已经退出集合的对象退出选择。取消归档始终移除原生归档标记，不沿用旧 Bin 的 `wasArchived`。原生集合没有归档时间；列表不显示旧移入时间、首次观察时间或“原先已归档”标签。观察身份也不是宿主生命周期或原生归档代际，不能保证识别未观察的取消归档再归档。

界面使用宿主 Button、Checkbox、Input、Toast 和图标；布局使用 CSS Modules 与宿主语义 token。字典在独立 `dshSessionBin` namespace 注册完整中英文。原生插件管理元数据由 [English metadata](../locale/en.json) 与[中文 metadata](../locale/zh.json)提供。语言切换更新面板、侧栏及辅助标签，保留选择和搜索草稿；用户会话及工作区名称保持原值。搜索在 composition 期间保留草稿，结束后应用筛选；Escape 不截断组合输入。浅深色由宿主主题解析。

## 单项永久删除

每个归档行提供单项永久删除。客户端先准备并固定同一观察 entryId，准备结果不能静默换成后来对象。原生 Modal 展示不可逆语义、实际 blockers，以及共享附件/独立 fork/外部副本保留范围；初始焦点为取消，须勾选确认才能执行同一私有快照计划。取消、关闭和 preparation 不执行删除。仅支持 Host 经过独立版本/资源检查的冷会话组合，加载、活动或未排空引用会明确阻止；固定批量与清空复用相同的单项资格，规则见下一节。

严格执行只接受 v2 purge；旧 v1 仅历史查询。删除与取消归档分别保存 journal/pending，永久删除成功只认 owner done 的完整固定请求/资源/nonce 回执。pending-recovery/partial-failure 持续保护对象，客户端可检查或明确继续同一个已保存操作；未曾观察 admission 的 missing 必须重新准备与确认，若旧观察已更换可明确放弃缺失的本地请求再选择新行，不能把旧请求改绑新对象。已观察的授权或无法恢复的观察见证继续保持未知保护，规则见下文连接恢复。

## 固定批量永久删除与清空

固定选择使用当前选中的观察 entryId；“清空全部归档（N）”始终从 Model 的完整 `entries` 冻结点击时全部对象，搜索或工作区筛选只改变列表显示，不改变范围和计数。期间新增归档、同 SID 的新观察不加入；旧对象变化由准备/执行复核并逐项阻止。选定编排见 [ADR 0009](decisions/0009-fixed-purge-batches.md)。

页面级批次先串行准备每项独立 lifecycle 与冻结清单，全部准备结束后展示固定总数、可执行数、阻止数、逐项原因及清除/引用释放/共享与协调记录保留范围。准备 blocker 不伪造 Host 回执，零可执行项不得开始。原生 Modal 默认聚焦取消，勾选不可逆确认后才发送私有冻结计划；公开快照或调用方对象的改动不扩展范围。

执行串行复用既有单项 Remote/journal，最多一条未终结发送项。success/rejected/conflict 可继续下一项；pending/partial、断线未知或 missing 都立即暂停后续对象。当前项由既有查询、同操作续办或未观察 admission 时的 fresh prepare + 再确认处理；确认当前结果后仍需明确继续剩余项。停止只取消尚未发送项，不 abort 或改绑已发送项；已接受准备也须排空后才可开始新批次。批次内 missing 不提供放弃保护旁路。

停止或重载后，已发送项保留批次来源标记，仍禁止放弃保护；未观察 admission、Host journal 确认缺失且观察身份仍匹配时，可独立重新准备并再次确认。取消新确认保留旧 pending；明确执行新确认后才替换旧计划。已停止批次的剩余项保持取消，重载作废的未发送队列不重建。连接失败或执行期间更换 baseline 时，排空当前已发送项并暂停下一项；即使新 baseline 先于当前回复到达，也须明确继续。

重载只查询已发送单项，不恢复未发送内存队列，不自动删除。没有额外 Host batch journal 或跨会话事务；每项结果仍由完整 owner done 回执决定。单个批次可含超过 64 个终态目标，但 pending/grant/observation 原始缓存超过容量时不截断、不迁移、不重写，只核对现有结果并禁止新删除。成功项退出选择，失败、阻止和未知项保留并逐项显示。

## 严格 Remote 边界

[Remote 合约](../src/remote/contracts.ts)使用公开手工 `TypertContribution` 和 `InvocationDescriptor`，与 Host DTO schema 共用声明。Host Service 是 `sessionBinRemote`，wire namespace 是 `sessionBin`；[适配器](../src/host/remote.ts)通过公开 `TypertRemoteService` 绑定 Host Interface，不增加自定义 HTTP 路由。

| 客户端调用 | 结果 |
| --- | --- |
| `prepare({ action: 'unarchive', sessionId, operationId? }, signal?)` | `RemoteResult<ArchivePlan>`，只准备并复核状态。 |
| `execute(plan, signal?)` | `RemoteResult<ArchiveResult>`，复核固定观察对象与当前原生归档状态，保存回执。 |
| `list(signal?)` | `RemoteResult<ArchiveEntry[]>`，完整原生归档管理集合。 |
| `getOperation(operationId, signal?)` | `RemoteResult<ArchiveOperation \| BinOperation \| null>`，保留旧 v1 回执查询。 |
| `preparePurge({ sessionId, operationId? }, signal?)` | `RemoteResult<PurgePlan>`，固定 v2 对象与资源清单，只准备。 |
| `executePurge(plan, signal?)` | `RemoteResult<PurgeResult>`，只接受 v2，同计划授权/执行；包括 pending/partial。 |
| `getPurgeOperation(operationId, signal?)` | `RemoteResult<PurgeOperation \| null>`，查询 v1/v2 历史及中断状态。 |
| `purgeOperations(signal?)` | 只读查询 Host 删除 journal，新页面也能发现未完成的 v2 guard。 |
| `follow(signal?)` | 每代完整 `{schemaVersion:2, entries}`，后续合并通知并替换快照。 |

新条目和计划使用 v2 合约；旧 Bin domain 的 v1 合约留作兼容，不作为成员来源。新 Remote 不接受旧 `bin/restore` 变更。输入由 Gateway 检查 exact args 和严格 schema；输出提供显式 encode/decode 校验，流端由 Host 和 Client 各校验完整快照。业务 `rejected/conflict` 与 Transport/Host 的 `RemoteResult.ok:false` 分开处理。已经进入 Host 队列的请求完成持久化，客户端取消回复不会撤销已开始的操作。

浏览器先调用 `ctx.remote.$mount`，再建立声明 `remote.sessionBin` 的动态消费 fiber，按“挂载 → 动态依赖 → UI”的顺序执行。React、React JSX runtime、Cordis 和原生 primitives 复用平台身份。

## 连接恢复与卸载

[客户端模型](../src/client/model.ts)消费 Gateway 重连 stream。新代校验完整集合后接受 baseline，取消旧代不发布状态。连接失败显示重试入口并限制新变更。

删除 pending 使用独立 `dsh-session-bin.purge.pending.v2` 缓存；其中版本化 envelope 原子保存固定计划、授权见证与 observation-attempt marker，旧数组和独立 grant 缓存只读迁移。首次接受 owner nonce 前先可靠记录观察尝试，再保存完整 nonce；marker 有记录而 nonce 缺失、读取失败或旧缓存无法提供可靠见证时进入未知保护，不把另一个 nonce 当作首次基线、不宣告完成，也不能通过 missing 后重新准备或放弃本地请求解除可能已 admission 的保护。真正丢失回复、尚未观察 nonce 的请求仍可在重载后只查询匹配 journal 并确认结果。连接/重载自动流程不 execute 或 recover；Host journal 查询可发现没有浏览器副本的未完成 v2 操作，v1 不续办。显式继续须先查到匹配已保存的同一请求；未观察 admission 的 missing 删除需 fresh prepare + confirmation。已观察的 grant 变更、撤回或 journal 缺失，以及 entry/lifecycle/manifest/digest 变化，都不释放 guard。浏览器完全不提供缓存时只保证本页内存保护，不能把它写作持久化见证。

执行前保存完整计划及操作身份。浏览器 sessionStorage 可用时在同一页面会话中保留，重载先查询回执。连接基线只查询未知结果，不自动重发变更。显式“检查并重试”仅能在缺少回执时重新提交同一个新版计划；Host 仍复核状态并保证幂等。旧 v1 缓存迁移为只查询回执的记录，缺少旧回执也不能重放 `bin/restore`。旧成功结果不能被误报成新版取消归档成功。浏览器禁止存储时保留内存记录，跨页面能力受限。

Host follow 订阅原生 Workspace 与插件元数据变化，先订阅后取 baseline，合并重复通知；流不是持久化 journal。取消、return、卸载唤醒等待并移除监听。所有槽位、locale、样式和模型订阅绑定动态消费者；父插件卸载撤销 Remote namespace 并释放子插件。样式具有 Module Loader 的 `data-plugin` 所有权标记。

鉴权沿用宿主 Connection 的浏览器 session、Host/Origin 检查与 operator scope。逻辑 carrier 测试处于已准入边界；真实 CLI/profile 浏览器检查单独记录。

## 构建和检查

`./client` 导出预编译 DSH lazy CommonJS factory。特有 CSS Modules 嵌入工厂并由 fiber 管理；`./remote` 是浏览器安全合约，Host 入口不进入客户端依赖图。两个 TypeScript face 分开检查，配置与命令分别在 [mise.toml](../mise.toml) 和 [package.json](../package.json)。

- `mise run verify`：两端类型检查、构建、Host/Remote/模型及文案测试、tarball 检查。
- `mise run verify:gui`：顺序验收中文与 English，独立临时 DSH_HOME 中用公开 CLI 安装 tarball、启动真正 `dsh web`，检查原生 Archive/Undo、已有归档、取消归档、固定选择批量操作、语言切换、浅深色、窄屏和卸载。
- `DSH_GUI_LOCALE=zh-CN` 或 `en-US` 与 `mise run verify:gui:locale`：单语诊断。

GUI 检查先运行 `mise run install` 安装项目锁定依赖；新 Web profile 的安装使用 `--prefer-offline` 复用缓存并补齐独立解析的依赖，需要 npm registry 网络访问。需要可用 Chrome，可由 `DSH_GUI_BROWSER_EXECUTABLE` 指定 Chromium。脚本的 Host 使用系统空闲端口；只连接自己的独立测试宿主，不使用当前 GUI/profile。Linux 浏览器使用独立的 `/tmp/dsh-gui-*` 短临时目录，避免较长 CI 工作区路径超过 Chromium Unix socket 长度限制，关闭后清理并在报告中记录。卸载后的新 Web 启动使用新的浏览器数据目录，避免恢复连接旧测试端口的标签页。失败报告保留经脱敏的 stdout、stderr 和插件管理器日志；数据与截图保留在忽略的 `.local/gui/`。

## 当前边界

单 Host 部署、精确 SDK 版本、POSIX lease 及原生归档观察限制见[Host 生命周期](host-lifecycle.md)。本切片支持声明组合的冷会话单项、固定选择批量永久删除及点击时完整归档集合的手动清空，没有日志预览、自动定期清空、跨设备同步或多 Host 原生存储协调。原生删除、可逆集合管理和资源保留范围分别验证；SDK 未提供公共删除 API，实际由版本绑定插件 Adapter 执行。
